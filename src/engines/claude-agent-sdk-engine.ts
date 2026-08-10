// src/engines/claude-agent-sdk-engine.ts
//
// ClaudeAgentSdkEngine — the DEV / TEST backend (contract §2.2). Wraps
// @anthropic-ai/claude-agent-sdk on the developer's LOCAL OAuth (no API key).
//
// THE VERIFIED CONFIG — the load-bearing details, each mapped to a contract
// invariant (§3):
//
//   * built-ins are ENABLED (we do NOT pass `tools`).
//     This is the deliberate reversal of the old `tools: []`. The point of the
//     harness-visibility work (3b) is to SHOW skill / subagent activity, and for
//     that the model must actually be able to call the built-in Task / Skill
//     tools — which `tools: []` stripped along with everything else. So the tool
//     list is no longer the safety mechanism. What keeps built-ins safe is the
//     GATE, run with the Phase-1 floor (runtime/gate.ts `phase1HarnessFloor`):
//     a deny-by-default allowlist that permits read-only inspection + delegation
//     + skills + our own runtime tools, and DENIES Bash/Write/Edit/… — from the
//     main loop AND from inside any spawned subagent. The PreToolUse hook fires
//     for every one of those calls, so a subagent's internal `rm -rf` is denied
//     before it runs (proven in spike-harness-visibility / spike-subagent-gate).
//   * our tools via createSdkMcpServer      -> our runtime tools stay registered
//     and callable ALONGSIDE the built-ins, each dispatched to our runtime
//     Executor, and each still passing through the gate.
//   * gate as a PreToolUse hook             -> deny is authoritative even under
//     bypassPermissions, and it reaches subagents; a tool never runs until the
//     gate returns allow. This is now the ONLY thing standing between "observe
//     the harness" and "auto-approve a subagent's mutation", so it is not
//     optional decoration — it is the control.
//   * NEVER list a tool in allowedTools     -> that auto-approves it and
//     silently shadows the gate. This invariant is UNCHANGED and matters MORE
//     now that built-ins are live: listing anything there would let a built-in
//     bypass the floor. We verify the SDK does not emit
//     CLAUDE_SDK_CAN_USE_TOOL_SHADOWED (captured off stderr).
//   * normalize mcp__<server>__<tool>       -> bare tool names, and the SDK's
//     events -> our EngineEvent. Built-in tool RESULTS arrive on `user`-role
//     messages (the SDK, not our MCP wrapper, runs them); the driver maps those
//     tool_result blocks to `tool_result` EngineEvents so a Task/Skill call
//     surfaces its result, not just its request.
//
// The SDK owns its model loop; that is expected. This engine drives query() to
// completion and surfaces the gate + executor callbacks.
//
// Input-rewrite note: when the gate allows with a rewritten input, the rewrite
// is applied AUTHORITATIVELY in the executor wrapper, from the decision queued
// by the PreToolUse hook — there is no window between approval and execution in
// which the input can change (contract §3 invariant 2). We ALSO return
// `updatedInput` from the hook so the model's transcript reflects the rewrite,
// but the wrapper is the source of truth because propagation of `updatedInput`
// into the in-process MCP handler is not something we want to depend on.

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import type {
  HookCallback,
  HookInput,
  ModelUsage,
  PreToolUseHookInput,
  PreToolUseHookSpecificOutput,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  Engine,
  EngineEvent,
  EngineRunInput,
  HarnessTask,
  JsonSchema,
  RuntimeImage,
  RuntimeMessage,
  SubagentAttribution,
  ToolCall,
  Usage,
} from '../runtime/engine.js';

// What may be echoed out of a harness message. Both are the "rule 1" guard in
// regex form: a LABEL is a short type name we are willing to render, an ID is an
// opaque handle we are willing to key state on. Anything that does not match is
// dropped rather than sanitized — a mangled id is worse than none.
const SAFE_LABEL = /^[\w-]{1,40}$/;
const SAFE_ID = /^[\w-]{1,64}$/;

// ---------------------------------------------------------------------------
// THE LAZY BOUNDARY — why this is not a plain `import` (design §3.3).
// ---------------------------------------------------------------------------
//
// The Agent SDK must NEVER be in a shipped build. `electron-builder.yml`
// already excludes `@anthropic-ai/claude-agent-sdk*` from the package, so in a
// packaged app the module is simply ABSENT. A static import here would defeat
// that twice over:
//
//   1. `scripts/build-runtime.mjs` bundles this file into
//      `dist/naby-runtime.mjs` with `external: []` — every static import is
//      INLINED. A static SDK import would therefore ship the SDK inside our own
//      bundle, straight past the electron-builder exclusion.
//   2. Even if it were excluded, a static import is evaluated at module load,
//      so the shell's engine module would throw on import in the packaged app —
//      taking the PRODUCTION path down with it.
//
// So the specifier is resolved at RUNTIME, through a require created from this
// module's own URL, and imported by file URL. Both are opaque to esbuild's
// static analysis, which is the point: nothing about the SDK ends up in the
// bundle, and a missing module is a `null` we can explain rather than a crash.
//
// `import type` above is erased at compile time and costs nothing at runtime.

const AGENT_SDK_SPECIFIER = '@anthropic-ai/claude-agent-sdk';

/** The three runtime values this engine uses. Typed off the real package so a
 *  bump that changes a signature fails `npm run typecheck`, not production. */
type AgentSdk = {
  createSdkMcpServer: typeof import('@anthropic-ai/claude-agent-sdk').createSdkMcpServer;
  query: typeof import('@anthropic-ai/claude-agent-sdk').query;
  tool: typeof import('@anthropic-ai/claude-agent-sdk').tool;
};

/**
 * Every place the SDK is allowed to be found, in order.
 *
 * TWO SEPARATE BUGS SHAPED THIS LIST, and both were invisible from a source
 * checkout, which is why it is written out rather than left to `import.meta.url`.
 *
 * (1) WHERE THE PACKAGE IS. electron-builder.yml drops the root node_modules
 *     (`'!node_modules/**'`), so a shipped build gets the SDK only through
 *     `shell/node_modules` — the shell has its own dependency on it. Node
 *     resolves by walking ANCESTORS, and `app.asar/shell/node_modules` is a
 *     SIBLING of `app.asar/dist`, never an ancestor. Anchoring on
 *     `<root>/shell/package.json` makes `<root>/shell/node_modules` the
 *     resolver's first candidate.
 *
 * (2) WHY `import.meta.url` CANNOT BE TRUSTED HERE. This module is bundled three
 *     times over: by esbuild into `dist/naby-runtime.mjs` and into the shell's
 *     server chunks (both keep `import.meta.url` intact), and by WEBPACK into
 *     the Next server chunk that actually serves `/api/naby` — which
 *     CONSTANT-FOLDS it to the build machine's absolute path. A CI-built release
 *     therefore carries `file:///Users/runner/work/naby/naby/dist/...`, and
 *     every anchor derived from it points at a directory that exists on no
 *     user's disk. The SDK shipped, complete and unpacked, and the app reported
 *     it missing.
 *
 * So the RUNTIME-DERIVED anchors come FIRST. `NABY_APP_ROOT` is published by
 * electron/boot.ts from `app.getAppPath()`; `COCKPIT_ROOT` is published by
 * electron/next-server.ts and already points at the shell directory. Their order
 * also matters for correctness, not just for hit rate: a packaged app must
 * resolve against ITS OWN copy, never against whatever stale checkout the frozen
 * build path happens to name on this particular machine.
 */
function sdkResolutionAnchors(): string[] {
  const anchors: string[] = [];
  const add = (...parts: string[]): void => {
    const p = join(...parts);
    if (!anchors.includes(p)) anchors.push(p);
  };

  // 1. Runtime truth, immune to whatever a bundler did to this file.
  const appRoot = process.env.NABY_APP_ROOT;
  if (appRoot) {
    add(appRoot, 'shell', 'package.json');
    add(appRoot, 'package.json');
  }
  const shellRoot = process.env.COCKPIT_ROOT;
  if (shellRoot) add(shellRoot, 'package.json');

  // 2. This module, for every context that has no Electron main process to
  //    publish the above: `tsx` on a checkout, spikes, the CLI.
  anchors.push(import.meta.url);
  let dir: string | undefined;
  try {
    dir = dirname(fileURLToPath(import.meta.url));
  } catch {
    dir = undefined; // not a file: URL — nothing further to derive
  }
  if (dir !== undefined) {
    // 6 levels covers `dist/` and `src/engines/` as well as the deeper
    // `.next-prod/server/chunks/` nesting, should import.meta.url survive there.
    for (let i = 0; i < 6; i += 1) {
      add(dir, 'shell', 'package.json');
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  // NOTE: process.cwd() is deliberately NOT an anchor. It looked like a free
  // fallback and it is the same hazard as the frozen build path, one step
  // removed: the engine would resolve into whatever checkout the process happens
  // to be sitting in — a different SDK version, or one on a disk the app has no
  // business reading. The three anchors above cover every context that has the
  // package (packaged app, embedded shell, checkout), and when they all miss,
  // "missing" is the honest answer.

  return anchors;
}

/**
 * Move a path out of `app.asar` and into `app.asar.unpacked`, WHEN that twin
 * really exists.
 *
 * A path inside the archive is fine to READ — Electron patches `fs` so reads
 * fall through to the unpacked copy. It is NOT fine to SPAWN from: `posix_spawn`
 * and `LoadLibraryW` are the OS's, not Electron's, and to the OS `app.asar` is a
 * FILE. The Agent SDK locates its `claude` engine binary relative to its own
 * module, so importing it from the archive path made it spawn through
 * `.../app.asar/.../claude-agent-sdk-darwin-arm64/claude` and die with
 * `spawn ENOTDIR`. The turn ended right there, with the SDK's own stderr going
 * into a buffer nobody read, so the answer bubble simply vanished.
 *
 * The `existsSync` guard is the whole difference between this and the naive
 * `.replace('app.asar', 'app.asar.unpacked')` that electron-builder.yml warns
 * against: a file that was never unpacked has no twin, and rewriting its path
 * would turn a working read into a missing file.
 */
function preferUnpacked(p: string): string {
  if (!p.includes(`${sep}app.asar${sep}`)) return p;
  const twin = p.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
  return existsSync(twin) ? twin : p;
}

/**
 * Where the Agent SDK lives, or null when it is genuinely not installed.
 *
 * Returns the FIRST anchor that resolves, rewritten to the unpacked tree when
 * one exists — see `preferUnpacked` for why reading and spawning disagree about
 * what an asar is.
 */
export function resolveClaudeAgentSdkPath(): string | null {
  for (const anchor of sdkResolutionAnchors()) {
    try {
      return preferUnpacked(createRequire(anchor).resolve(AGENT_SDK_SPECIFIER));
    } catch {
      // Not here. Try the next anchor before concluding it is missing.
    }
  }
  return null;
}

/** The SDK's own option/server types, derived from the real package so they
 *  cannot drift from it silently. */
type QueryOptions = NonNullable<Parameters<AgentSdk['query']>[0]['options']>;

/**
 * The Agent SDK's NATIVE "ask the user" tool, named so it can be TAKEN AWAY.
 *
 * THE BUG THIS EXISTS TO CLOSE. Built-ins are enabled here on purpose (see the
 * header), and the SDK's built-in set includes `AskUserQuestion` — a tool that
 * asks the user a multiple-choice question. Naby already has one of those:
 * `naby_checkin` (`mcp__nabytools__naby_checkin`), which is not a duplicate but
 * a DIFFERENT KIND OF THING. A check-in renders in Naby's own UI, records the
 * agent's recommendation against the user's answer, and writes the eval-event
 * row that the trust meter reads. It is how the persona is scored.
 *
 * With both live, the model reached for the native one — it is a first-class
 * built-in, and its description reads like the obvious way to ask something. The
 * consequences were both silent:
 *
 *   * this shell renders no UI for it, so the call came back as an error
 *     ("Answer questions?") and the user was never actually asked; and
 *   * `AskUserQuestion` is an OBSERVATION tool (runtime/checkin.ts
 *     `OBSERVATION_RUNTIME_TOOLS`), so it leaves NO ledger row — the agent had
 *     asked nothing, and nothing said so.
 *
 * The net effect on a subscription machine was that check-ins simply never
 * happened while everything looked healthy. Denying the native tool leaves
 * `naby_checkin` as the ONLY way to ask, which is the property the meter needs.
 *
 * NOTE: this is about AVAILABILITY GOING FORWARD, not about history. Transcripts
 * recorded before this change still contain `AskUserQuestion` calls, and the
 * shell's viewer still renders them; nothing here rewrites the past.
 */
export const NATIVE_ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

/**
 * The SDK built-in that RUNS AN ON-DISK SKILL — the loader for
 * `~/.claude/skills/<name>/SKILL.md` and friends. Denied outright
 * (harness-standalone §2.3).
 *
 * naby's skills do not arrive through it. They are imported into the store,
 * reviewed, enabled, and then INJECTED AS TEXT into the turn's system field
 * (`runtime/skill-inject.ts`) — the same way on every engine. So the only thing
 * this tool could add is a second, engine-specific path that loads files naby
 * neither owns nor gated: the exact asymmetry §2.3 exists to end.
 */
export const NATIVE_SKILL_TOOL = 'Skill';

/**
 * The SDK built-in that RUNS AN ON-DISK SLASH COMMAND (`~/.claude/commands/*.md`).
 * Denied for the same reason as `Skill`: naby owns commands as store rows and
 * expands them ABOVE the engine seam (`lib/slashCommands`), so a vendor
 * command file has no route into a naby turn.
 */
export const NATIVE_SLASH_COMMAND_TOOL = 'SlashCommand';
type SdkMcpServer = ReturnType<AgentSdk['createSdkMcpServer']>;

/**
 * The options object handed to `query()` — built HERE, as a pure function, and
 * exported.
 *
 * This is not test scaffolding bolted onto the side: it is the production call
 * site, extracted so it can be OBSERVED. The wrong-cwd bug survived as long as
 * it did precisely because this object was an anonymous literal buried in an
 * argument list — there was no way to look at what the engine was actually
 * asking the SDK for without running a live model. Two of the fields here are
 * exactly the kind that fail silently and expensively when wrong (`cwd` points
 * the backend at the wrong repository; `settingSources` decides whose CLAUDE.md
 * and hooks get loaded), so "assertable without a network call" is a property
 * worth the indirection.
 */
export function buildQueryOptions(args: {
  input: EngineRunInput;
  mcpServer: SdkMcpServer;
  preToolUse: HookCallback;
  abortController: AbortController;
  onStderr: (data: string) => void;
}): QueryOptions {
  const { input, mcpServer, preToolUse, abortController, onStderr } = args;
  return {
    // NOTE: `tools` is deliberately NOT set. Setting `tools: []` stripped ALL
    // built-in executors, which also killed Task / Skill / delegation — so the
    // harness could never run and its activity could never be shown. Omitting
    // the option leaves the SDK's built-ins ENABLED (verified in
    // spike-harness-visibility, where built-ins were live precisely because
    // `tools` was not passed). Safety no longer comes from an empty tool list;
    // it comes from the GATE below (with the Phase-1 floor), which sees every
    // built-in call — including calls issued INSIDE a spawned subagent — and can
    // authoritatively deny mutation/exec before it runs. See the header block.
    mcpServers: { [MCP_SERVER_NAME]: mcpServer },
    // THE BUILT-INS WE TAKE BACK are listed further down, on `disallowedTools`,
    // next to the isolation options they belong with. `tools` stays unset (above)
    // so the rest of the harness built-ins stay live.
    hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
    // deny is authoritative even here:
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    // The system prompt travels on its OWN field (contract §2/§6), never as
    // a `role:'system'` message. The Agent SDK's native slot for it is
    // `systemPrompt`; passing a bare string replaces the default preset.
    ...(input.system ? { systemPrompt: input.system } : {}),
    // WHERE THIS TURN RUNS. Omitting `cwd` does not mean "no directory" —
    // the SDK documents it as defaulting to `process.cwd()`, which for us
    // is the Electron main process's cwd (naby's own source checkout), NOT
    // the project the user opened. That silent inheritance is the bug
    // documented in full on `EngineRunInput.cwd`: the model was told one
    // directory by the system prompt while the SDK sat in another, and so
    // loaded NABY's `.claude/` harness instead of the opened project's.
    // Absent stays absent — we never substitute a default here.
    ...(input.cwd ? { cwd: input.cwd } : {}),
    // NO FILESYSTEM SETTINGS. EVER. (harness-standalone §2.3.)
    //
    // The SDK's own type doc: "When omitted, all sources are loaded (matches CLI
    // defaults). Pass `[]` to disable filesystem settings (SDK isolation mode)."
    // So this was never off by accident — until now naby LOADED `~/.claude`'s and
    // the opened project's `.claude/` settings, CLAUDE.md and HOOKS into every
    // dev-engine turn. That was defensible while the dev engine was understood as
    // "Claude Code, driven by us". It is not defensible for a standalone app: it
    // is a second, invisible delivery path for instructions and hooks that naby
    // does not own, cannot show the user, and cannot gate.
    //
    // The concrete asymmetry it created: a skill under `~/.claude/skills` reached
    // the dev engine TWICE (natively here, and again through naby's own store
    // injection) and every other engine ONCE. Behaviour differed by engine for
    // reasons no line of code stated. With `[]`, naby's injection is the SINGLE
    // path by which a skill, a memory or an instruction reaches any model.
    //
    // What this does NOT touch: the SDK's credential read (`~/.claude/
    // .credentials.json`) and its own session transcripts. Those are
    // authentication and engine-internal storage, explicitly out of scope (§1).
    settingSources: [],
    // AND NO NATIVE HARNESS DISCOVERY, as far as the SDK lets us say so.
    //
    // `settingSources: []` governs settings files; skills are discovered on their
    // own path, and the SDK documents omitting `skills` as "no SDK
    // auto-configuration — the CLI's own defaults still apply, so this is **not**
    // skills off". The documented way to say off is the allowlist form with
    // nothing in it: "only skills whose names match an entry are loaded into the
    // main session system prompt". An empty list matches nothing.
    skills: [],
    // Belt and braces, because the option above is documented as "a context
    // filter, not a sandbox". `disallowedTools` is stronger — the SDK removes
    // those tools from the model's context entirely — so the two built-ins that
    // exist to run on-disk vendor artifacts are removed outright. naby delivers
    // its own skills as text and its own commands by expanding them ABOVE the
    // engine seam, so neither tool has a job here.
    //
    // KNOWN LIMIT (§5): there is no documented option that stops on-disk
    // SUBAGENT frontmatter (`~/.claude/agents/*.md`) from being discovered. The
    // `agents` option adds ours; it does not exclude theirs. What holds anyway:
    // a delegated subagent's every tool call still passes through THIS turn's
    // PreToolUse gate, so it cannot exceed the turn's policy.
    disallowedTools: [
      NATIVE_ASK_USER_QUESTION_TOOL,
      NATIVE_SKILL_TOOL,
      NATIVE_SLASH_COMMAND_TOOL,
    ],
    // NABY OWNS MCP. Without this the SDK MERGES the user's global MCP servers
    // (`~/.claude` settings, project `.mcp.json`, plugins) into the session, so a
    // server the user configured for Claude Code elsewhere leaks in as
    // `mcp__<name>__*` tools alongside Naby's own — and "add an MCP" from chat
    // finds it already present. `strictMcpConfig` restricts MCP to ONLY what we
    // pass in `mcpServers` (the in-process `nabytools` server, which already
    // carries Naby's registry — app.db mcp_servers). It is MCP-specific and does
    // NOT affect CLAUDE.md/hooks, which still load via settingSources above.
    // Needed for the REASONING stream: without it the SDK yields only complete
    // assistant messages and the collapsed thinking block stays empty until the
    // very end, which is exactly the silence this was meant to fix. The answer's
    // own text deltas are read from these events but NOT forwarded — see the
    // message loop for why.
    includePartialMessages: true,
    strictMcpConfig: true,
    // NOTE: allowedTools is deliberately UNSET — listing our tool there
    // would auto-approve it and silently shadow the gate.
    abortController,
    stderr: onStderr,
    ...(input.model.model ? { model: input.model.model } : {}),
    // Phase 2.5 (M4): expose Naby's enabled subagents as NATIVE SDK agents, keyed
    // by name, so the model can delegate to them through the built-in Task tool.
    // A delegated subagent's own tool calls still pass through THIS turn's
    // PreToolUse gate (verified in spike-subagent-gate), so orchestration inherits
    // the Phase-2 policy for free. `toolRefs` restricts the subagent's tools; the
    // description drives when the model picks it.
    ...(input.subagents && input.subagents.length > 0
      ? {
          agents: Object.fromEntries(
            input.subagents.map((s) => [
              s.name,
              {
                description: s.description ?? `The ${s.name} subagent.`,
                prompt: s.systemPrompt,
                ...(s.model ? { model: s.model } : {}),
                ...(s.toolRefs && s.toolRefs.length > 0 ? { tools: s.toolRefs } : {}),
              },
            ]),
          ),
        }
      : {}),
  };
}

/** True when the dev engine can actually run here. Cheap; no module is loaded. */
export function isClaudeAgentSdkAvailable(): boolean {
  return resolveClaudeAgentSdkPath() !== null;
}

/**
 * What a caller is told when the SDK does not resolve.
 *
 * IT NO LONGER SAYS "NOT PART OF THIS APP", BECAUSE THAT STOPPED BEING TRUE.
 * Release builds now SHIP the Agent SDK (electron-builder.yml packs it and
 * unpacks it from the asar), so the old wording described a design that has been
 * reversed: what a shipped build gates is the USE of the dev engine, not its
 * presence. A user who hit this was told to stop trying — the app they had could
 * never do it — when the real state was "this copy of the app is damaged".
 *
 * So it states the failure, not a conclusion about the build, and gives the two
 * things a NON-DEVELOPER can do: use a provider they have a key for, or
 * reinstall. The developer's reading of the same event — a checkout with no
 * dependencies installed — is last and parenthesised, because it is the case
 * that comes with someone who can diagnose it.
 */
export const AGENT_SDK_UNAVAILABLE_MESSAGE =
  'The built-in Claude (subscription) model could not be loaded on this computer, so it cannot answer. ' +
  'Open Settings (gear icon, bottom left) → "AI provider" and pick a provider you have an API key for; ' +
  'if you would rather use the built-in model, reinstalling Naby restores it. ' +
  '(Developers: @anthropic-ai/claude-agent-sdk did not resolve — run `npm install` in a source checkout, ' +
  'or check that the packaged copy under app.asar.unpacked is present.)';

let cachedSdk: Promise<AgentSdk> | undefined;

/** Load the SDK once per process. Rejects with a readable error when absent. */
async function loadAgentSdk(): Promise<AgentSdk> {
  if (!cachedSdk) {
    cachedSdk = (async (): Promise<AgentSdk> => {
      const resolved = resolveClaudeAgentSdkPath();
      if (!resolved) throw new Error(AGENT_SDK_UNAVAILABLE_MESSAGE);
      // Imported by FILE URL, from a variable: esbuild cannot fold this into
      // the bundle, and node needs a URL (not a path) on Windows.
      //
      // `webpackIgnore` is not decoration. The shell is a Next/webpack app that
      // imports our esbuild bundle, so this expression gets analyzed a SECOND
      // time by webpack, which reports "Critical dependency: the request of a
      // dependency is an expression" and would try to trace it. esbuild
      // preserves this specific comment through the bundle, so the marker
      // written here is the one webpack reads there — and the import stays a
      // plain runtime import in both toolchains, which is the whole point.
      return (await import(/* webpackIgnore: true */ pathToFileURL(resolved).href)) as AgentSdk;
    })().catch((e) => {
      // Do not cache a failure forever — a dev who runs `npm i` mid-session
      // should not have to restart the app to pick the engine up.
      cachedSdk = undefined;
      throw e;
    });
  }
  return cachedSdk;
}

/**
 * The text of one streaming delta, or '' when the event carries none.
 *
 * Reads defensively: `stream_event` wraps the raw Anthropic stream, whose shape is
 * the provider's rather than ours, and a message-level or content-block-start event
 * carries no text at all. THINKING deltas are deliberately not returned — they are
 * not the answer, and rendering them as assistant text would put reasoning in the
 * transcript as if it were the reply.
 */
export function readThinkingDelta(msg: unknown): string {
  if (!msg || typeof msg !== 'object') return '';
  const event = (msg as { event?: unknown }).event as
    | { type?: string; delta?: { type?: string; thinking?: string } }
    | undefined;
  if (!event || event.type !== 'content_block_delta') return '';
  const d = event.delta;
  if (!d || d.type !== 'thinking_delta') return '';
  return typeof d.thinking === 'string' ? d.thinking : '';
}

export function readTextDelta(msg: unknown): string {
  if (!msg || typeof msg !== 'object') return '';
  const event = (msg as { event?: unknown }).event as
    | { type?: string; delta?: { type?: string; text?: string } }
    | undefined;
  if (!event || event.type !== 'content_block_delta') return '';
  const d = event.delta;
  if (!d || d.type !== 'text_delta') return '';
  return typeof d.text === 'string' ? d.text : '';
}

// ---------------------------------------------------------------------------
// WHICH MODELS THIS SIGN-IN ACTUALLY HAS
//
// The chat bar's model list was a hand-curated constant, which means it goes
// stale the day a new model ships and the app has to be rebuilt to name it. The
// SDK already knows the answer — `Query.supportedModels()` reports what the LOCAL
// sign-in is entitled to, which is strictly better than any list we could
// maintain: it reflects the user's own plan rather than a guess about it.
//
// HOW THIS AVOIDS SPENDING A TURN. `query()` connects and initializes before it
// processes any prompt, so the probe hands it an AsyncIterable prompt that never
// yields. The CLI comes up, answers the initialize request, and is aborted — no
// message is ever sent, so nothing is billed and no session is written.
//
// Best-effort by contract: not signed in, SDK absent, CLI slow to start — all of
// them return undefined and the caller falls back to its curated list. A model
// picker that throws would be worse than one that is a few weeks out of date.
// ---------------------------------------------------------------------------

/** One model the local sign-in may use, as the SDK reports it. */
export type ClaudeModelInfo = {
  value: string;
  displayName: string;
  description?: string;
  /** Canonical id an alias resolves to (`opus` → `claude-opus-5`). */
  resolvedModel?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
};

/**
 * Two timeouts, because the two failure modes want opposite things.
 *
 * Measured on a signed-in machine: a WARM probe answers in 0.6–1.6s; a COLD first
 * spawn took 22s; and roughly every other attempt gets stuck behind the previous
 * CLI's teardown and never answers at all (see `probeClaudeModels`).
 *
 * A single generous limit made the stuck case cost 45s before the retry could
 * rescue it — 48s for a menu, which is indistinguishable from broken. A single
 * tight limit would fail a genuine cold start. So the FIRST attempt is short (it
 * either answers fast or is the stuck one) and the RETRY is generous (it is the
 * one that may be paying for a cold start). Worst realistic case is ~8s + cold
 * start, and the caller never blocks on either: the picker shows its fallback
 * meanwhile and swaps the live list in when it lands.
 */
export const MODEL_PROBE_TIMEOUT_MS = 8_000;
export const MODEL_PROBE_RETRY_TIMEOUT_MS = 45_000;

/**
 * Ask the local sign-in for its model list, retrying ONCE.
 *
 * WHY A RETRY, STATED HONESTLY: measured back-to-back, probes came out
 * success / timeout / success / success. Closing the generator (see below) fixed
 * the later pairs but not the second attempt in a fresh process, and I did not
 * find the cause — something in the SDK's first teardown is not finished when the
 * next `query()` starts. One retry after a short pause turns an observably flaky
 * call into a reliable one, which is the right trade for a model picker; it is a
 * workaround for a cause still unknown, not an explanation of it.
 */
export async function probeClaudeModels(opts?: {
  cwd?: string;
  timeoutMs?: number;
}): Promise<ClaudeModelInfo[] | undefined> {
  const first = await probeOnce(opts);
  if (first) return first;
  await new Promise((r) => setTimeout(r, PROBE_RETRY_DELAY_MS));
  return probeOnce({ ...opts, timeoutMs: opts?.timeoutMs ?? MODEL_PROBE_RETRY_TIMEOUT_MS });
}

/** Pause before the single retry — long enough for the previous CLI to be gone,
 *  short enough to stay inside a menu interaction. */
const PROBE_RETRY_DELAY_MS = 400;

async function probeOnce(opts?: {
  cwd?: string;
  timeoutMs?: number;
}): Promise<ClaudeModelInfo[] | undefined> {
  let sdk: AgentSdk;
  try {
    sdk = await loadAgentSdk();
  } catch {
    return undefined;
  }
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), opts?.timeoutMs ?? MODEL_PROBE_TIMEOUT_MS);
  // `Query` extends AsyncGenerator, and ABORTING IS NOT CLOSING IT. Measured:
  // probe → probe → probe alternated success / timeout / success, because the
  // previous CLI was still holding on and the next `query()` waited for it.
  // Calling `.return()` is what actually finishes the generator and lets the child
  // go, so two probes in a row both answer.
  let query: { return?: (v?: unknown) => Promise<unknown> } | undefined;
  try {
    // A prompt that never yields: the CLI initializes and then waits, which is
    // exactly the window in which `supportedModels()` can be asked.
    const idlePrompt = (async function* () {
      await new Promise<void>((resolve) => {
        if (ac.signal.aborted) return resolve();
        ac.signal.addEventListener('abort', () => resolve(), { once: true });
      });
    })();
    const q = sdk.query({
      prompt: idlePrompt as never,
      options: {
        abortController: ac,
        ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      } as never,
    }) as unknown as {
      supportedModels?: () => Promise<unknown[]>;
      return?: (v?: unknown) => Promise<unknown>;
    };
    query = q;
    if (typeof q.supportedModels !== 'function') return undefined;
    const raw = await q.supportedModels();
    if (!Array.isArray(raw)) return undefined;
    const models: ClaudeModelInfo[] = [];
    for (const item of raw) {
      const r = (item ?? {}) as Record<string, unknown>;
      const value = typeof r.value === 'string' ? r.value : '';
      if (!value) continue;
      models.push({
        value,
        displayName: typeof r.displayName === 'string' && r.displayName ? r.displayName : value,
        ...(typeof r.description === 'string' && r.description ? { description: r.description } : {}),
        ...(typeof r.resolvedModel === 'string' && r.resolvedModel
          ? { resolvedModel: r.resolvedModel }
          : {}),
        ...(typeof r.supportsEffort === 'boolean' ? { supportsEffort: r.supportsEffort } : {}),
        ...(Array.isArray(r.supportedEffortLevels)
          ? { supportedEffortLevels: r.supportedEffortLevels.filter((x): x is string => typeof x === 'string') }
          : {}),
      });
    }
    return models.length > 0 ? models : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
    ac.abort();
    // Close the generator so the SDK tears its CLI down now rather than whenever
    // it notices the abort. Best-effort: a throw here would mask the result.
    try {
      await query?.return?.();
    } catch {
      /* already finished */
    }
  }
}

// ---------------------------------------------------------------------------
// Small async channel: hooks, the tool handler, and the query-message loop all
// push EngineEvents here; run() yields them out in order.
// ---------------------------------------------------------------------------

class Channel<T> {
  private readonly queue: T[] = [];
  private readonly resolvers: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(v: T): void {
    if (this.closed) return;
    const r = this.resolvers.shift();
    if (r) r({ value: v, done: false });
    else this.queue.push(v);
  }

  close(): void {
    this.closed = true;
    let r = this.resolvers.shift();
    while (r) {
      r({ value: undefined as unknown as T, done: true });
      r = this.resolvers.shift();
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const v = this.queue.shift();
        if (v !== undefined) return Promise.resolve({ value: v, done: false });
        if (this.closed)
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}

// ---------------------------------------------------------------------------
// JSON-Schema -> zod. The runtime hands the engine engine-agnostic JSON schema
// (contract §2); the SDK's tool() wants a zod raw shape, so we convert here —
// the conversion is an engine-internal detail, never leaked upward.
// ---------------------------------------------------------------------------

function jsonSchemaToZod(s: JsonSchema): z.ZodTypeAny {
  switch (s.type) {
    case 'string':
      return z.string();
    case 'number':
    case 'integer':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'array':
      return z.array(s.items ? jsonSchemaToZod(s.items) : z.unknown());
    case 'object':
      return z.object(objectShape(s));
    default:
      return z.unknown();
  }
}

function objectShape(s: JsonSchema): Record<string, z.ZodTypeAny> {
  const props = s.properties ?? {};
  const required = new Set(s.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [k, v] of Object.entries(props)) {
    let zt = jsonSchemaToZod(v);
    if (v.description) zt = zt.describe(v.description);
    if (!required.has(k)) zt = zt.optional();
    shape[k] = zt;
  }
  return shape;
}

// ---------------------------------------------------------------------------
// Name + content normalization
// ---------------------------------------------------------------------------

/** mcp__<server>__<tool> -> <tool> (bare). Non-mcp names pass through. */
function bareName(toolName: string): string {
  if (toolName.startsWith('mcp__')) return toolName.split('__').slice(2).join('__');
  return toolName;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (b): b is { type: 'text'; text: string } =>
        !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text',
    )
    .map((b) => String(b.text ?? ''))
    .join('');
}

/**
 * Anthropic's raw token counts -> our normalized `Usage` (see the `Usage` doc
 * in runtime/engine.ts).
 *
 * Exported so the normalization is assertable directly, without a live model
 * call: this is the single most costly thing in the file to get wrong quietly,
 * because a wrong answer here does not fail — it just prices the turn by three
 * orders of magnitude.
 */
export function normalizeAgentSdkUsage(raw: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}): Usage {
  const cacheRead = raw.cache_read_input_tokens ?? 0;
  const cacheWrite = raw.cache_creation_input_tokens ?? 0;
  return {
    // Anthropic reports these three DISJOINTLY; our contract wants a total.
    inputTokens: (raw.input_tokens ?? 0) + cacheRead + cacheWrite,
    outputTokens: raw.output_tokens ?? 0,
    cachedInputTokens: cacheRead,
  };
}

/**
 * THE WINDOW THE RUN STATED ABOUT ITSELF — the Agent SDK's result message
 * carries `modelUsage`, one entry per model it billed, and each entry names that
 * model's `contextWindow`. This picks the entry that belongs to the reading we
 * are reporting and returns its size (the `contextWindow` contract in
 * runtime/engine.ts).
 *
 * IT EXISTS BECAUSE THE TIER STOPPED ANNOUNCING ITSELF. The two signals the
 * registry infers from — the `context-1m-2025-08-07` beta on the init message
 * and a `[1m]` marker on the served id — were both absent on a live 0.3.215 run
 * that `modelUsage` reported at 1,000,000 tokens: the long-context tier had gone
 * GA, so nothing flagged it any more and the gauge divided by 200k. A number the
 * backend states cannot drift out of date that way.
 *
 * `model` is the id the reading belongs to (the last assistant step's, falling
 * back to init's). WHEN THAT EXACT KEY IS MISSING, only a SOLE entry is taken:
 * a result that billed two models cannot say which of them owns the numerator,
 * and picking one at random would be the same guess this whole path removes.
 * Anything else answers `undefined`, and the caller falls back to the registry.
 *
 * Exported so the selection is assertable without a live SDK run.
 */
export function reportedContextWindow(
  modelUsage: Record<string, ModelUsage> | undefined,
  model: string | undefined,
): number | undefined {
  // Typed as required by the SDK, but an older CLI on the user's machine can
  // still send a result without it — the field is checked, not assumed.
  if (!modelUsage || typeof modelUsage !== 'object') return undefined;
  const keys = Object.keys(modelUsage);
  let entry: ModelUsage | undefined = model !== undefined ? modelUsage[model] : undefined;
  if (entry === undefined) {
    if (keys.length !== 1) return undefined;
    entry = modelUsage[keys[0] as string];
  }
  const window = entry?.contextWindow;
  // A zero or a NaN is not a window; reporting one would divide the gauge by
  // nothing at all, which is worse than the inference it replaces.
  return typeof window === 'number' && Number.isFinite(window) && window > 0
    ? window
    : undefined;
}

function lastUserText(messages: EngineRunInput['messages']): string {
  const users = messages.filter((m) => m.role === 'user');
  const last = users[users.length - 1];
  if (last && 'content' in last) return last.content;
  // fall back to any content we have
  const any = messages.find((m) => 'content' in m);
  return any && 'content' in any ? any.content : '';
}

// ---------------------------------------------------------------------------
// MULTI-TURN — divergence point "loop ownership", normalized (design §3.4).
// ---------------------------------------------------------------------------
//
// WE own the transcript (contract §6): `runTurn` reloads the whole history from
// SQLite and re-sends it every turn, which is exactly what makes a session
// provider-independent. The Agent SDK, though, takes a single `prompt` and owns
// its own loop — it has no `messages` array to hand our history to, and its own
// session resumption is keyed to ITS transcript directory, which contract §6
// says we ignore.
//
// So the history is RENDERED into the prompt: prior turns as a clearly-fenced
// context block, then the new user turn as the actual instruction. This keeps
// the store as the single source of truth (a session started on the dev engine
// and continued on a provider — or the reverse — replays identically), at the
// cost of prior turns being framed as text rather than as native turns. That
// tradeoff is deliberate and is the only shape the SDK's single-prompt entry
// point allows.
//
// A first turn renders as the bare user text, so the single-turn spikes see
// exactly the prompt they saw before this existed.

function renderHistoryLine(m: RuntimeMessage): string | null {
  if (m.role === 'tool') {
    const status = m.output.isError ? ' (failed)' : '';
    return `Tool ${m.toolName}${status} returned: ${m.output.content}`;
  }
  if (m.role === 'assistant') {
    if (m.toolCalls?.length) {
      const names = m.toolCalls.map((c) => c.toolName).join(', ');
      return m.content ? `Assistant: ${m.content}` : `Assistant called tool: ${names}`;
    }
    return m.content ? `Assistant: ${m.content}` : null;
  }
  return m.content ? `User: ${m.content}` : null;
}

/** The prompt for this turn: prior history as context, then the new user text. */
export function renderPrompt(messages: EngineRunInput['messages']): string {
  // `runTurn` appends the user turn BEFORE calling the engine, so the last user
  // message is the new one and everything before it is history.
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      lastUserIndex = i;
      break;
    }
  }
  const current = lastUserText(messages);
  const prior = lastUserIndex >= 0 ? messages.slice(0, lastUserIndex) : [];
  const lines = prior
    .map(renderHistoryLine)
    .filter((l): l is string => l !== null && l.length > 0);
  if (lines.length === 0) return current;

  return [
    'Earlier messages in this conversation, for context only — do not answer them again:',
    '<conversation_history>',
    ...lines,
    '</conversation_history>',
    '',
    'The user now says:',
    current,
  ].join('\n');
}

/** The images on the newest user turn, or undefined. `runTurn` attaches this
 *  turn's images to the last user message (session.ts). */
function lastUserImages(messages: EngineRunInput['messages']): RuntimeImage[] | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role === 'user') return m.images;
  }
  return undefined;
}

/** Complete `thinking` blocks out of an assistant message's content. Mirrors
 *  `extractText`; the field is `thinking`, not `text`. */
function extractThinking(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (b): b is { type: 'thinking'; thinking: string } =>
        !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'thinking',
    )
    .map((b) => String(b.thinking ?? ''))
    .join('');
}

/**
 * The prompt for `query()`. Text-only turns stay a plain STRING (byte-identical
 * to before). A turn with images becomes a one-shot `AsyncIterable<SDKUserMessage>`
 * whose content is the rendered text plus an Anthropic base64 image block per
 * attachment — the only prompt shape the SDK accepts images on. The single yield
 * then completes, which ends the streaming input and runs exactly one turn.
 */
export function buildAgentPrompt(
  messages: EngineRunInput['messages'],
): string | AsyncIterable<SDKUserMessage> {
  const text = renderPrompt(messages);
  const images = lastUserImages(messages);
  if (!images || images.length === 0) return text;

  const content = [
    ...(text ? [{ type: 'text' as const, text }] : []),
    ...images.map((img) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: img.media_type as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
        data: img.data,
      },
    })),
  ];
  const userMessage = {
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content },
  } as SDKUserMessage;
  return (async function* () {
    yield userMessage;
  })();
}

// ---------------------------------------------------------------------------
// HARNESS MESSAGES — the ones the driver loop used to drop on the floor.
// ---------------------------------------------------------------------------
//
// `SDKMessage` is a ~35-member union. The driver below acts on exactly three of
// them (system/init, assistant, result) and every other one — background task
// lifecycle, compaction boundaries, and the `user` messages through which the
// SDK surfaces hook output and injected system-reminders — used to vanish
// silently. Silence is what let the wrong-cwd bug run: another project's hooks
// were firing into our loop and NOTHING was in a position to notice.
//
// This maps a dropped message onto an OBSERVATIONAL label (see the `harness`
// doc in runtime/engine.ts). Two rules, both deliberate:
//
//   1. NEVER copy a raw message body into `detail`. Hook output, task
//      summaries and subagent descriptions are arbitrary text from whatever
//      project is open — and `detail` is rendered in the UI. Only CLOSED-SET or
//      NUMERIC fields (a status enum, a trigger, a token count) are echoed.
//      Free text is reported by its presence, never by its content.
//   2. Return null for anything high-frequency or already represented. A
//      dropped message is not automatically worth a line in the transcript.
//
// Exported so the mapping is assertable without a live model call.

export function describeHarnessMessage(
  msg: unknown,
): { subtype: string; detail?: string; task?: HarnessTask } | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as {
    type?: unknown;
    subtype?: unknown;
    status?: unknown;
    task_id?: unknown;
    tool_use_id?: unknown;
    task_type?: unknown;
    subagent_type?: unknown;
    patch?: { status?: unknown };
    compact_metadata?: { trigger?: unknown; pre_tokens?: unknown; post_tokens?: unknown };
    message?: { content?: unknown };
  };
  const type = typeof m.type === 'string' ? m.type : null;
  if (!type) return null;

  // Partial assistant deltas: one per token. Already rendered as assistant
  // text; forwarding them would flood the transcript.
  if (type === 'stream_event') return null;

  // `user` is how the SDK reports BOTH tool results and injected content
  // (hook output, system-reminders). Tool results already have a first-class
  // event, so only report the injected case — and only that it HAPPENED. The
  // injected text itself is exactly the arbitrary project content rule 1 is
  // about, so it is never echoed.
  if (type === 'user') {
    const content = m.message?.content;
    const hasToolResult =
      Array.isArray(content) &&
      content.some(
        (b) =>
          !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_result',
      );
    if (hasToolResult) return null;
    const hasText =
      typeof content === 'string' ? content.length > 0 : extractText(content).length > 0;
    return hasText ? { subtype: 'user/injected' } : null;
  }

  const subtype = typeof m.subtype === 'string' ? m.subtype : null;
  const label = subtype ? `${type}/${subtype}` : type;

  // Curated details — closed-set or numeric fields ONLY (rule 1).
  if (subtype === 'compact_boundary') {
    const meta = m.compact_metadata;
    const trigger = meta?.trigger === 'manual' || meta?.trigger === 'auto' ? meta.trigger : null;
    const pre = typeof meta?.pre_tokens === 'number' ? meta.pre_tokens : null;
    const post = typeof meta?.post_tokens === 'number' ? meta.post_tokens : null;
    const parts = [
      trigger ? `trigger=${trigger}` : null,
      pre !== null ? `pre_tokens=${pre}` : null,
      post !== null ? `post_tokens=${post}` : null,
    ].filter((p): p is string => p !== null);
    return parts.length ? { subtype: label, detail: parts.join(' ') } : { subtype: label };
  }

  // Subagent / background-task LIFECYCLE. Four subtypes, one shape: they are
  // the edges (and the middle) of a task the backend is running for us.
  //
  // The identity fields travel STRUCTURALLY on `task` — see the HarnessTask doc
  // for why an id has to survive the trip. `detail` keeps saying exactly what it
  // said before (a status enum, an agent type), so a consumer that never learned
  // about `task` renders these pills unchanged.
  const taskPhase: HarnessTask['phase'] | null =
    subtype === 'task_started'
      ? 'started'
      : subtype === 'task_progress'
        ? 'progress'
        : subtype === 'task_notification' || subtype === 'task_updated'
          ? 'ended'
          : null;
  if (taskPhase !== null) {
    // `description` / `summary` are model-authored free text — omitted by rule 1.
    // A `task_updated` reports its status inside `patch`; the others carry it flat.
    const rawStatus = subtype === 'task_updated' ? m.patch?.status : m.status;
    // `killed` IS AN ENDING. The task-state enum a `task_updated` patch reports
    // (`pending|running|completed|failed|killed|paused`) is wider than the three
    // outcomes a `task_notification` reports, and `killed` is the one a shell job
    // actually reaches when it is interrupted or reaped under memory pressure —
    // the CLI itself maps it onto `stopped` before notifying. Left unmapped it
    // read as "no terminal status", i.e. a mid-flight patch, and the block for a
    // background job that had already been killed would spin forever.
    const status =
      rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'stopped'
        ? rawStatus
        : rawStatus === 'killed'
          ? 'stopped'
          : null;
    const agentType =
      typeof m.subagent_type === 'string' && SAFE_LABEL.test(m.subagent_type)
        ? m.subagent_type
        : null;
    const taskType =
      typeof m.task_type === 'string' && SAFE_LABEL.test(m.task_type) ? m.task_type : null;
    const detailParts = [
      status ? `status=${status}` : null,
      agentType ? `agent=${agentType}` : taskType ? `task=${taskType}` : null,
    ].filter((p): p is string => p !== null);

    // A `task_updated` that reports no terminal status is a mid-flight patch
    // (description edited, backgrounded) — it is the 'progress' kind of noise,
    // not an end. Say so rather than closing a block that is still running.
    const phase: HarnessTask['phase'] =
      subtype === 'task_updated' && status === null ? 'progress' : taskPhase;

    const taskId = typeof m.task_id === 'string' && SAFE_ID.test(m.task_id) ? m.task_id : null;
    const toolCallId =
      typeof m.tool_use_id === 'string' && SAFE_ID.test(m.tool_use_id) ? m.tool_use_id : null;
    const task: HarnessTask | null = taskId
      ? {
          id: taskId,
          phase,
          ...(agentType ? { agentType } : {}),
          // The KIND travels structurally too, not only inside the pill text. It
          // is what separates a background shell job (`local_bash`) from a
          // delegated subagent (`local_agent`) — see the HarnessTask doc — and a
          // consumer that has to parse it back out of `detail` is a consumer
          // that will get it wrong.
          ...(taskType ? { taskType } : {}),
          ...(toolCallId ? { toolCallId } : {}),
          ...(status ? { status } : {}),
        }
      : null;
    return {
      subtype: label,
      ...(detailParts.length ? { detail: detailParts.join(' ') } : {}),
      ...(task ? { task } : {}),
    };
  }

  return { subtype: label };
}

/**
 * Stamp the moment a lifecycle edge crossed the seam (`HarnessTask.observedAt`).
 *
 * Kept OUT of `describeHarnessMessage` so that function stays pure — it is the
 * one part of this mapping that is asserted message-by-message without a clock
 * (spike-subagent), and a `Date.now()` inside it would make every one of those
 * assertions time-dependent. The driver, which is already impure, does it here.
 */
function stampObserved(task: HarnessTask): HarnessTask {
  return { ...task, observedAt: Date.now() };
}

/**
 * WHO issued the call a pre-execution hook is reporting.
 *
 * The Claude Agent SDK puts the answer on every hook input: `agent_id` is set
 * "only when the hook fires from within a subagent (e.g. a tool called by an
 * AgentTool worker) — absent for the main thread, even in --agent sessions", and
 * `agent_type` names the kind (`general-purpose`, a custom agent). That is real
 * ATTRIBUTION FROM THE BACKEND, which is the whole reason a subagent can be
 * given its own block instead of the UI guessing parentage from timing.
 *
 * Returns null for a main-thread call — the common case — so the caller can omit
 * the field entirely rather than store an "is top level" flag on every call.
 *
 * Exported so the rule is assertable without a live model call.
 */
export function subagentAttribution(
  hookInput: unknown,
  spawningCallByAgentId?: ReadonlyMap<string, string>,
): SubagentAttribution | null {
  if (!hookInput || typeof hookInput !== 'object') return null;
  const h = hookInput as { agent_id?: unknown; agent_type?: unknown };
  // No agent id ⇒ the main thread. `agent_type` alone is NOT enough: a session
  // started with `--agent` sets it on the main thread too, and treating that as
  // a subagent would file the whole turn under a block that never existed.
  if (typeof h.agent_id !== 'string' || !SAFE_ID.test(h.agent_id)) return null;
  const agentType =
    typeof h.agent_type === 'string' && SAFE_LABEL.test(h.agent_type) ? h.agent_type : null;
  const parentToolCallId = spawningCallByAgentId?.get(h.agent_id);
  return {
    agentId: h.agent_id,
    ...(agentType ? { agentType } : {}),
    ...(parentToolCallId && SAFE_ID.test(parentToolCallId) ? { parentToolCallId } : {}),
  };
}

// ---------------------------------------------------------------------------
// BUILT-IN TOOL RESULTS — the other half of harness visibility.
// ---------------------------------------------------------------------------
//
// Once built-ins are enabled, the SDK runs Task / Skill / Read / … ITSELF and
// reports their outcome as `tool_result` blocks on a `user`-role message (our
// own MCP tools, by contrast, run in our wrapper which pushes the result event
// directly). Those blocks are a genuine tool result — the same shape the client
// already renders for our tools — so forwarding them is in-bounds. This extracts
// them into a normalized shape; the driver decides which to emit (skipping ids
// our wrapper already surfaced, so a result is never emitted twice).
//
// Exported so the extraction is assertable without a live model call.

export function extractToolResultBlocks(
  msg: unknown,
): { toolUseId: string; isError: boolean; content: string }[] {
  if (!msg || typeof msg !== 'object') return [];
  const m = msg as { type?: unknown; message?: { content?: unknown } };
  if (m.type !== 'user') return [];
  const content = m.message?.content;
  if (!Array.isArray(content)) return [];
  const out: { toolUseId: string; isError: boolean; content: string }[] = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const block = b as {
      type?: unknown;
      tool_use_id?: unknown;
      is_error?: unknown;
      content?: unknown;
    };
    if (block.type !== 'tool_result') continue;
    if (typeof block.tool_use_id !== 'string') continue;
    const text =
      typeof block.content === 'string' ? block.content : extractText(block.content);
    out.push({
      toolUseId: block.tool_use_id,
      isError: block.is_error === true,
      content: text,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Diagnostics surfaced to the spike (stderr + shadow-warning detection).
// ---------------------------------------------------------------------------

export type ClaudeEngineDiagnostics = {
  stderr: string[];
  /** true iff the SDK warned that our tool was shadowed (gate bypassed). */
  shadowWarningSeen: boolean;
};

const SHADOW_WARNING = 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED';
const MCP_SERVER_NAME = 'nabytools';

export class ClaudeAgentSdkEngine implements Engine {
  /** Diagnostics from the most recent run(); the spike asserts on this. */
  diagnostics: ClaudeEngineDiagnostics = { stderr: [], shadowWarningSeen: false };

  // NO CONSTRUCTOR OPTIONS. There used to be one — `isolated`, which background
  // callers passed to get `settingSources: []` for a call the user never made.
  // Every turn is isolated now (harness-standalone §2.3), so the flag would only
  // be a way to ask for what is already true, and a reader would reasonably infer
  // that NOT passing it means something is loaded. Nothing is.

  async *run(input: EngineRunInput): AsyncIterable<EngineEvent> {
    // The SDK is loaded HERE, inside run(), so that constructing the engine is
    // always safe. A packaged build can hold a reference to this class without
    // the module existing; only an attempt to actually answer fails, and it
    // fails as a surfaced EngineEvent rather than a thrown module-load error.
    let sdk: AgentSdk;
    try {
      sdk = await loadAgentSdk();
    } catch (e) {
      yield {
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
        code: 'DEV_ENGINE_UNAVAILABLE',
      };
      yield { kind: 'result', ok: false };
      return;
    }
    const { createSdkMcpServer, query, tool } = sdk;

    const channel = new Channel<EngineEvent>();
    const diagnostics: ClaudeEngineDiagnostics = {
      stderr: [],
      shadowWarningSeen: false,
    };
    this.diagnostics = diagnostics;

    // Gate decisions the hook approved, awaiting their executor. FIFO per bare
    // tool name. The PreToolUse hook fires immediately before the handler for
    // the same call and the SDK runs calls sequentially, so FIFO correlation
    // holds for the spike; duplicate-input calls in one turn dequeue in order.
    const pending = new Map<string, { input: unknown; toolCallId: string }[]>();
    const enqueue = (name: string, e: { input: unknown; toolCallId: string }) => {
      const q = pending.get(name) ?? [];
      q.push(e);
      pending.set(name, q);
    };
    const dequeue = (name: string) => pending.get(name)?.shift();

    // Built-in tool bookkeeping, now that built-ins are enabled.
    //   toolNameById   — bare name per tool_use_id, captured in the PreToolUse
    //                    hook so a built-in tool_result (which carries only the
    //                    id) can be surfaced with its tool name.
    //   ownToolResultIds — the ids our OWN MCP executor already emitted a
    //                    tool_result for. The SDK ALSO echoes those results back
    //                    on a `user` message; without this set the driver would
    //                    emit a SECOND tool_result for the same call. Built-in
    //                    tools (Task/Skill/Read/…) are run by the SDK itself, not
    //                    our wrapper, so their ids are absent here and the driver
    //                    is the only place their result surfaces.
    const toolNameById = new Map<string, string>();
    const ownToolResultIds = new Set<string>();

    // The prompt size of the most recent MAIN-THREAD assistant step — the window
    // occupancy this turn ends at. Filled in the `assistant` branch of the driver
    // below (which explains why it is that message and not `result`).
    let lastStepInputTokens: number | undefined;

    // THE DENOMINATOR'S TWO INPUTS, taken from the RUN rather than from what we
    // asked for (see the `contextModel` / `contextBetas` contract in
    // runtime/engine.ts).
    //
    //   lastStepModel — the concrete id, from the assistant message that produced
    //                   the reading above. Same message, so numerator and
    //                   denominator always describe the same call.
    //   initModel     — the id the init message resolved, as the fallback for a
    //                   turn that ends before any assistant message lands.
    //   initBetas     — what the CLI negotiated. `context-1m-2025-08-07` here is
    //                   the difference between a 200k and a 1M window, and it is
    //                   the sign-in's plan that decides it, not this app.
    //
    // ALL THREE ARE MAIN-THREAD ONLY, for the same reason the token reading is: a
    // subagent runs in its own window on possibly its own model.
    let lastStepModel: string | undefined;
    let initModel: string | undefined;
    let initBetas: readonly string[] | undefined;

    // WHICH `Task` CALL SPAWNED WHICH SUBAGENT.
    //
    // The hook that reports a subagent's tool calls knows the AGENT id
    // (`agent_id`) and nothing about the call that started it; the
    // `system/task_started` message knows both (`task_id` — the same id the
    // agent runs under — and `tool_use_id`, the `Task` call). Joining them here
    // is the only place both are in scope, and it is what lets a consumer fold a
    // subagent's children under the call that launched it AFTER A RELOAD, when
    // the lifecycle events are long gone (they are observational and never
    // persisted) but the tool calls are still on disk.
    //
    // BEST EFFORT BY CONSTRUCTION. The map is filled from the message stream and
    // read from a hook callback; if a subagent's first tool call is gated before
    // the driver has drained `task_started`, the parent id is simply missing on
    // that call. That is why grouping keys on `agentId` and treats
    // `parentToolCallId` as an enrichment — a missing parent costs a nicety, a
    // WRONG parent would put one agent's work under another's block.
    const spawningCallByAgentId = new Map<string, string>();

    // Build our tools as an in-process MCP server. Each handler runs the
    // runtime executor on the GATE-APPROVED input, and refuses to run if no
    // gate decision is queued (which would mean the gate was bypassed).
    const sdkTools = input.toolSchemas.map((ts) =>
      tool(
        ts.name,
        ts.description,
        objectShape(ts.parameters),
        async () => {
          const approved = dequeue(ts.name);
          if (!approved) {
            // Invariant 3: no auto-execution path may bypass the gate.
            channel.push({
              kind: 'error',
              message: `REFUSED: ${ts.name} reached the executor without a gate decision`,
              code: 'GATE_BYPASSED',
            });
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `REFUSED: ${ts.name} was not gated`,
                },
              ],
              isError: true,
            };
          }
          const executor = input.executors[ts.name];
          if (!executor) {
            return {
              content: [
                { type: 'text' as const, text: `no executor for ${ts.name}` },
              ],
              isError: true,
            };
          }
          const output = await executor(approved.input, {
            toolCall: {
              toolCallId: approved.toolCallId,
              toolName: ts.name,
              input: approved.input,
            },
            signal: input.signal,
          });
          // Record that WE surfaced this result, so the driver's built-in
          // tool_result mapping does not emit a duplicate when the SDK echoes
          // the same result back on a `user` message.
          ownToolResultIds.add(approved.toolCallId);
          channel.push({
            kind: 'tool_result',
            toolCallId: approved.toolCallId,
            toolName: ts.name,
            isError: !!output.isError,
            output,
          });
          return {
            content: [{ type: 'text' as const, text: output.content }],
            isError: !!output.isError,
          };
        },
      ),
    );

    const server = createSdkMcpServer({
      name: MCP_SERVER_NAME,
      version: '0.0.0',
      tools: sdkTools,
    });

    // The gate, attached at the SDK's only sound pre-execution point.
    const preToolUse: HookCallback = async (hookInput: HookInput) => {
      if (hookInput.hook_event_name !== 'PreToolUse') return {};
      const h = hookInput as PreToolUseHookInput;
      const name = bareName(h.tool_name);
      // Remember the bare name for this call id so a built-in tool_result
      // (which arrives on a later `user` message carrying only the id) can be
      // surfaced with its tool name.
      toolNameById.set(h.tool_use_id, name);
      // WHO made this call. `agent_id` is present ONLY when the hook fires from
      // inside a subagent (the SDK is explicit that this — not `agent_type`, which
      // a top-level `--agent` session also sets — is the field that distinguishes
      // the two), so its absence is a sound "this was the main thread" rather than
      // a shrug. Nothing below branches on it; it rides along for display.
      const subagent = subagentAttribution(h, spawningCallByAgentId);
      const call: ToolCall = {
        toolCallId: h.tool_use_id,
        toolName: name,
        input: h.tool_input,
        ...(subagent ? { subagent } : {}),
      };
      channel.push({
        kind: 'tool_request',
        toolCallId: call.toolCallId,
        toolName: name,
        input: h.tool_input,
        ...(subagent ? { subagent } : {}),
      });

      const decision = await input.gate(call);

      channel.push({
        kind: 'gate_result',
        toolCallId: call.toolCallId,
        toolName: name,
        decision: decision.behavior,
        reason: decision.behavior === 'deny' ? decision.reason : undefined,
      });

      if (decision.behavior === 'deny') {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: decision.reason,
          },
        };
      }

      // allow (possibly with a rewritten input). Queue the approved input for
      // the executor wrapper — the authoritative rewrite path.
      const approvedInput = decision.input ?? h.tool_input;
      enqueue(name, { input: approvedInput, toolCallId: call.toolCallId });

      const out: PreToolUseHookSpecificOutput = {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'gate allow',
      };
      if (
        decision.input !== undefined &&
        approvedInput &&
        typeof approvedInput === 'object'
      ) {
        out.updatedInput = approvedInput as Record<string, unknown>;
      }
      return { hookSpecificOutput: out };
    };

    // Forward our abort signal into an AbortController the SDK owns.
    const ac = new AbortController();
    if (input.signal.aborted) ac.abort();
    else input.signal.addEventListener('abort', () => ac.abort(), { once: true });

    const q = query({
      prompt: buildAgentPrompt(input.messages),
      // Built by the exported pure function above, so the EXACT object this
      // production path sends can be asserted without a model call.
      options: buildQueryOptions({
        input,
        mcpServer: server,
        preToolUse,
        abortController: ac,
        onStderr: (data: string) => {
          diagnostics.stderr.push(data);
          if (data.includes(SHADOW_WARNING)) diagnostics.shadowWarningSeen = true;
        },
      }),
    });

    const driver = (async () => {
      try {
        for await (const msg of q) {
          if (msg.type === 'system' && msg.subtype === 'init') {
            // `msg.model` is the RESOLVED id — the CLI has already turned
            // `default` / `opus` / an empty option into the model it will run —
            // and `msg.betas` is what it negotiated. Both are captured for the
            // window gauge; neither can be derived from our own selection.
            // Both read through the SDK's OWN types (`SDKSystemMessage`), not
            // through a cast: if either field is renamed upstream, this must fail
            // to compile rather than start reporting undefined and silently take
            // the gauge back to where the user found it.
            initModel = msg.model || undefined;
            if (msg.betas) initBetas = msg.betas;
            channel.push({
              kind: 'init',
              providerId: input.model.providerId,
              model: msg.model,
            });
          } else if (msg.type === 'stream_event') {
            // A token-level delta. Pushed with `partial: true` so the consumer
            // RENDERS it without accumulating: the complete message follows as its
            // own non-partial event, and counting both would double the text.
            // ANSWER TEXT DELTAS ARE DELIBERATELY NOT PUSHED.
            //
            // Pushing them streamed the reply token by token, and it broke the
            // rendering: the answer came out as dozens of separate bubbles split
            // mid-word, one per flush. I could not find the cause by reading the
            // client, and a broken transcript is worse than a late one — so the
            // answer is back to arriving as complete messages (the behaviour that
            // was known good) while the REASONING still streams below.
            //
            // `readTextDelta` stays exported and tested: it is the piece a proper
            // fix needs, and re-deriving it later would be re-doing work.
            //
            // Reasoning streams on the same channel but as its OWN kind, so the
            // consumer shows it without it becoming the reply. Its target is a
            // collapsed block whose text is appended by a separate reducer path,
            // which is why it does not hit whatever splits the answer.
            const thought = readThinkingDelta(msg);
            if (thought) channel.push({ kind: 'thinking', text: thought, partial: true });
          } else if (msg.type === 'assistant') {
            // HOW FULL THE WINDOW IS (specs/session-context-management.md §2.1).
            //
            // The `result` message SUMS every step of the turn, so its
            // `input_tokens` is a running total and not an occupancy — on a
            // ten-step turn it reads several times the window and was exactly the
            // "748k" the spec's problem statement is about. Each ASSISTANT message
            // instead carries the usage of the ONE model call that produced it, so
            // the last one is what the model last received: the occupancy the next
            // turn starts from.
            //
            // MAIN THREAD ONLY. A subagent runs in its own window (`parent_tool_use_id`
            // names the Task call that spawned it), so its prompt size says nothing
            // about this conversation's window and would make the gauge jump to a
            // stranger's number mid-turn.
            if (msg.parent_tool_use_id == null) {
              const stepUsage = (msg.message as { usage?: Parameters<typeof normalizeAgentSdkUsage>[0] })
                .usage;
              if (stepUsage) {
                const total = normalizeAgentSdkUsage(stepUsage).inputTokens;
                // 0 is not a measurement — a replayed or synthesized assistant
                // message reports nothing, and taking it would blank a real reading.
                if (typeof total === 'number' && total > 0) lastStepInputTokens = total;
              }
              // The id that produced this step. Anthropic's assistant message
              // carries the concrete model (`claude-opus-5[1m]` on a long-context
              // run), which is the only place the tier is visible when the CLI
              // negotiated it without announcing a beta. Typed (`BetaMessage`)
              // for the same reason as the init fields above.
              if (msg.message.model) lastStepModel = msg.message.model;
            }
            const text = extractText(msg.message.content);
            // Complete thinking blocks, for the case where nothing streamed (a
            // replayed message, or a provider that sends the block whole).
            const thought = extractThinking(msg.message.content);
            if (thought) channel.push({ kind: 'thinking', text: thought });
            if (text) channel.push({ kind: 'text', role: 'assistant', text });
            if (msg.error) {
              channel.push({
                kind: 'error',
                message: `assistant error: ${msg.error}`,
                code: msg.error,
              });
            }
          } else if (msg.type === 'result') {
            const u = msg.usage as
              | {
                  input_tokens?: number;
                  output_tokens?: number;
                  cache_read_input_tokens?: number;
                  cache_creation_input_tokens?: number;
                }
              | undefined;
            // Observed in a real dev turn before this was normalized:
            // input_tokens=4 with cache_read_input_tokens=9435 — i.e. a 9.4k
            // prompt reported as 4 tokens.
            const usage: Usage = normalizeAgentSdkUsage(u ?? {});
            // THE DENOMINATOR, MEASURED RATHER THAN INFERRED. `msg.modelUsage` is
            // read through the SDK's own result types (`SDKResultSuccess` /
            // `SDKResultError` both declare it), not through a cast, for the same
            // reason as the init fields above: an upstream rename must fail the
            // build instead of quietly returning undefined and taking the gauge
            // back to the 200k it used to guess.
            const reportedWindow = reportedContextWindow(
              msg.modelUsage,
              lastStepModel ?? initModel,
            );
            channel.push({
              kind: 'result',
              ok: !msg.is_error,
              usage,
              costUsd: msg.total_cost_usd,
              // Absent when no assistant step reported usage (an aborted turn, a
              // pure error). The consumer hides the gauge rather than dividing the
              // summed figure above by a window — see the `contextTokens` contract.
              ...(lastStepInputTokens !== undefined
                ? { contextTokens: lastStepInputTokens }
                : {}),
              // The denominator's inputs. The assistant message's id wins over
              // the init one because it is the model that produced the reading
              // above — the CLI can swap models mid-turn (a refusal fallback
              // does exactly that), and the numerator would then belong to a
              // different window than the name beside it.
              ...((lastStepModel ?? initModel) !== undefined
                ? { contextModel: (lastStepModel ?? initModel) as string }
                : {}),
              ...(initBetas !== undefined ? { contextBetas: initBetas } : {}),
              // Attached only when the run actually named a usable size. Absent
              // leaves the consumer on the registry inference it has always used,
              // so a backend that reports nothing loses nothing.
              ...(reportedWindow !== undefined ? { contextWindow: reportedWindow } : {}),
            });
          } else if (msg.type === 'user') {
            // A `user` message carries the SDK's built-in tool RESULTS (Task /
            // Skill / Read / …) — and separately the injected hook output /
            // system-reminders. Surface the built-in tool results as first-class
            // `tool_result` EngineEvents so a Task or Skill call shows its
            // outcome, not just its request. Skip ids our own MCP wrapper
            // already emitted (the SDK echoes those back here too), so no result
            // is emitted twice.
            for (const r of extractToolResultBlocks(msg)) {
              if (ownToolResultIds.has(r.toolUseId)) continue;
              channel.push({
                kind: 'tool_result',
                toolCallId: r.toolUseId,
                toolName: toolNameById.get(r.toolUseId) ?? 'tool',
                isError: r.isError,
                output: { content: r.content, isError: r.isError },
              });
            }
            // The injected-content case (hook output / system-reminders) still
            // surfaces as an OBSERVATIONAL harness label — never its raw body.
            // describeHarnessMessage returns null for a tool_result-only user
            // message, so this does not double up on the results above.
            const described = describeHarnessMessage(msg);
            if (described) {
              channel.push({
                kind: 'harness',
                subtype: described.subtype,
                ...(described.detail ? { detail: described.detail } : {}),
                ...(described.task ? { task: stampObserved(described.task) } : {}),
              });
            }
          } else {
            // Everything else the SDK emits. Previously dropped silently; now
            // surfaced as an OBSERVATIONAL harness event (a short safe label,
            // never a raw body — see describeHarnessMessage). It does not enter
            // the transcript and cannot influence the loop or the gate.
            const described = describeHarnessMessage(msg);
            if (described) {
              // Remember which `Task` call started this agent, while both ids
              // are in the same message — see `spawningCallByAgentId`.
              if (described.task?.toolCallId && described.task.phase === 'started') {
                spawningCallByAgentId.set(described.task.id, described.task.toolCallId);
              }
              channel.push({
                kind: 'harness',
                subtype: described.subtype,
                ...(described.detail ? { detail: described.detail } : {}),
                ...(described.task ? { task: stampObserved(described.task) } : {}),
              });
            }
          }
        }
      } catch (e) {
        // SAY WHAT THE SUBPROCESS SAID. `onStderr` fills `diagnostics.stderr`
        // and, until this line, nothing ever read it: when the SDK failed to
        // start its engine binary the turn ended with an empty transcript and
        // not one word anywhere — no log, no error in the UI, just a reply
        // bubble that appeared and vanished. Diagnosing it meant driving the
        // packaged app's SDK by hand from outside. The buffer is the best
        // evidence there is about a spawn failure, so it goes to the log.
        const tail = diagnostics.stderr.join('').trim().slice(-2000);
        console.error(
          `[engine:claude-agent-sdk] turn failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        if (tail) console.error(`[engine:claude-agent-sdk] sdk stderr:\n${tail}`);
        channel.push({
          kind: 'error',
          message: e instanceof Error ? e.message : String(e),
          code: 'ENGINE_THREW',
        });
      } finally {
        channel.close();
      }
    })();

    yield* channel;
    await driver;
  }
}
