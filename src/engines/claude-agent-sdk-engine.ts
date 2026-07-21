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
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type {
  HookCallback,
  HookInput,
  PreToolUseHookInput,
  PreToolUseHookSpecificOutput,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  Engine,
  EngineEvent,
  EngineRunInput,
  JsonSchema,
  RuntimeMessage,
  ToolCall,
  Usage,
} from '../runtime/engine.js';

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
 * Where the Agent SDK lives, or null when it is not installed.
 *
 * Resolution is relative to THIS module's URL, which is what makes it correct
 * in both linkages: under `tsx` that is `src/engines/`, and inside the bundle it
 * is `dist/naby-runtime.mjs` — both walk up to the parent repo's node_modules.
 */
export function resolveClaudeAgentSdkPath(): string | null {
  try {
    return createRequire(import.meta.url).resolve(AGENT_SDK_SPECIFIER);
  } catch {
    return null;
  }
}

/** The SDK's own option/server types, derived from the real package so they
 *  cannot drift from it silently. */
type QueryOptions = NonNullable<Parameters<AgentSdk['query']>[0]['options']>;
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
    // SET EXPLICITLY, and the explicitness is the point.
    //
    // The SDK's own type doc: "When omitted, all sources are loaded
    // (matches CLI defaults)." So this was never off — leaving it unset was
    // already loading user + project + local settings, including the
    // project's CLAUDE.md and hooks. Being IMPLICIT is precisely what kept
    // the wrong-cwd bug invisible: a whole harness was being loaded from a
    // directory nobody had chosen, and no line of code said so.
    //
    // Loading the OPENED PROJECT's harness is intentional and desirable —
    // its CLAUDE.md and hooks are what the user expects to apply. But that
    // is only TRUE now that `cwd` above points at the opened project; with
    // the old inherited cwd this same setting was actively harmful. The two
    // lines are a pair: do not keep this one without that one.
    settingSources: ['user', 'project', 'local'],
    // NOTE: allowedTools is deliberately UNSET — listing our tool there
    // would auto-approve it and silently shadow the gate.
    abortController,
    stderr: onStderr,
    ...(input.model.model ? { model: input.model.model } : {}),
  };
}

/** True when the dev engine can actually run here. Cheap; no module is loaded. */
export function isClaudeAgentSdkAvailable(): boolean {
  return resolveClaudeAgentSdkPath() !== null;
}

/** What a caller is told when the SDK is missing. Written for a NON-DEVELOPER:
 *  the dev engine is a development-only path, so the actionable advice is to
 *  configure a provider key, not to install an npm package. */
export const AGENT_SDK_UNAVAILABLE_MESSAGE =
  'The built-in development model is not part of this installed app, so it cannot answer. ' +
  'Open Settings (gear icon, bottom left) → "AI provider", pick a provider and paste its API key. ' +
  '(Developers: the development model only works when running from a source checkout, ' +
  'where @anthropic-ai/claude-agent-sdk is installed.)';

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
): { subtype: string; detail?: string } | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as {
    type?: unknown;
    subtype?: unknown;
    status?: unknown;
    task_type?: unknown;
    subagent_type?: unknown;
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

  if (subtype === 'task_started' || subtype === 'task_notification') {
    // `description` / `summary` are model-authored free text — omitted by rule 1.
    const status =
      m.status === 'completed' || m.status === 'failed' || m.status === 'stopped'
        ? `status=${m.status}`
        : null;
    const kind =
      typeof m.subagent_type === 'string' && /^[\w-]{1,40}$/.test(m.subagent_type)
        ? `agent=${m.subagent_type}`
        : typeof m.task_type === 'string' && /^[\w-]{1,40}$/.test(m.task_type)
          ? `task=${m.task_type}`
          : null;
    const parts = [status, kind].filter((p): p is string => p !== null);
    return parts.length ? { subtype: label, detail: parts.join(' ') } : { subtype: label };
  }

  return { subtype: label };
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
      const call: ToolCall = {
        toolCallId: h.tool_use_id,
        toolName: name,
        input: h.tool_input,
      };
      channel.push({
        kind: 'tool_request',
        toolCallId: call.toolCallId,
        toolName: name,
        input: h.tool_input,
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
      prompt: renderPrompt(input.messages),
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
            channel.push({
              kind: 'init',
              providerId: input.model.providerId,
              model: msg.model,
            });
          } else if (msg.type === 'assistant') {
            const text = extractText(msg.message.content);
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
            channel.push({
              kind: 'result',
              ok: !msg.is_error,
              usage,
              costUsd: msg.total_cost_usd,
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
              });
            }
          } else {
            // Everything else the SDK emits. Previously dropped silently; now
            // surfaced as an OBSERVATIONAL harness event (a short safe label,
            // never a raw body — see describeHarnessMessage). It does not enter
            // the transcript and cannot influence the loop or the gate.
            const described = describeHarnessMessage(msg);
            if (described) {
              channel.push({
                kind: 'harness',
                subtype: described.subtype,
                ...(described.detail ? { detail: described.detail } : {}),
              });
            }
          }
        }
      } catch (e) {
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
