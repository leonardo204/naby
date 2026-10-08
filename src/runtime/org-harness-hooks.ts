// src/runtime/org-harness-hooks.ts
//
// THE ORG HARNESS HOOK RUNNER (specs/org-harness-sync.md M3, §3.5).
//
// altimedia-harness ships Claude Code hooks (`hooks/hooks.json`). This file runs
// the ones naby has reviewed, at the naby moments that correspond to Claude Code's
// events, with Claude Code-shaped input — so the package's own scripts (task's
// Python hooks behind `run-skill-hook.js`, the H1–H4 metrics in
// `metrics-emit.js`) work unchanged. Both engines reach it through the same shell
// call sites (and, for compaction, through `EngineRunInput.compaction`), so the
// same events fire whichever engine answers.
//
// THE SAFETY PROPERTIES, in the spec's order.
//
//   ONLY THE ALLOWLIST RUNS. A hook command must be `node <package>/scripts/<x>.js`
//   with `<x>` in `ORG_HOOK_ALLOWLIST`, the script resolved INSIDE the pinned,
//   sha256-checked package folder. `activate.js`, `gate.js` and `deps-check.js`
//   are replaced by naby (§3.6) and never run; anything else is reported as "not
//   supported yet" and never runs (§3.5 table, appendix A5). Hooks from the
//   user's own harness are not read here at all (phase-1_6 contract §4).
//
//   A HOOK NEVER BLOCKS A TURN. A timeout, a spawn failure, a non-zero exit, or
//   unparseable output is logged and ignored. The only things a hook can change
//   are the ones the spec lists: extra system context, and a PreToolUse
//   `ask`/`deny` (a hook can tighten the gate, never loosen it — `allow` is no
//   opinion).
//
//   NO NODE.JS NEEDED. `node` is the app's own executable started with
//   `ELECTRON_RUN_AS_NODE=1` (`process.execPath` — Electron's binary in the app,
//   Node's in a spike).
//
//   SAME FOLDER FOR THE WHOLE TURN. The runner is built from the package folder
//   the turn pinned (§4.7), never from `current`.
//
//   PRECOMPACT/SESSIONEND ARE SERIAL PER PROJECT. Two tabs on one project would
//   otherwise run ctx's re-index twice at once over the same files. Everything
//   else runs concurrently.
//
//   SESSIONEND IS CAPPED. All SessionEnd hooks start together and the caller waits
//   at most `ORG_SESSION_END_CAP_MS` in total (app quit must not hang). A hook
//   still running then is left to finish on its own; ctx writes its marker first.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { logActivity } from './activity-log.js';
import type { RuntimeMessage } from './engine.js';
import { CASE_INSENSITIVE_FS } from './fs-tools.js';
import { leaseOrgPackageDir, ORG_HARNESS_CLIENT } from './org-harness.js';
import { ORG_HOOK_ALLOWLIST, ORG_HOOK_NATIVE, splitHookCommand } from './org-harness-hook-scripts.js';
import { ORG_COMMAND_ENV, ORG_KEY_ENV_NAMES } from './org-harness-turn.js';
import type { SessionRef } from './store/store.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The seven Claude Code events naby maps (§3.5 "시점 대응"). */
export const ORG_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'PreCompact',
  'SessionEnd',
] as const;
export type OrgHookEvent = (typeof ORG_HOOK_EVENTS)[number];

// The allowlist (scripts naby runs as they are, §3.5 — a new script joins only
// in a naby release, after review, appendix A5), the native list (scripts naby
// replaces, §3.6 — never run) and the command splitter live in a leaf module so
// the package sync can use them too (new-hook detection, §3.1) without an import
// cycle. Re-exported here so existing callers keep their import path.
export { ORG_HOOK_ALLOWLIST, ORG_HOOK_NATIVE, splitHookCommand } from './org-harness-hook-scripts.js';

/** §3.5: SessionEnd waits this long in total, then lets the app go. */
export const ORG_SESSION_END_CAP_MS = 5_000;
/** Claude Code's default per-hook timeout (`timeout` in hooks.json is seconds). */
export const ORG_HOOK_DEFAULT_TIMEOUT_MS = 60_000;
/** Output kept from one hook; more is cut (a hook is not a log channel). */
const MAX_HOOK_STDOUT_BYTES = 1024 * 1024;
/** stderr kept per hook run, in the in-memory hook log only (diagnostics: why a
 *  hook failed, or what `HARNESS_METRICS_DRYRUN=1` would have sent). */
const MAX_HOOK_STDERR_BYTES = 4 * 1024;
/** Additional context from one hook, at most (the system prompt has a budget). */
const MAX_CONTEXT_CHARS = 10_000;
/** Grace between SIGTERM and SIGKILL when a hook overruns its timeout. */
const KILL_GRACE_MS = 1_000;

/** The env var a hook sees naby's metrics token under (§3.6). */
export const ORG_METRICS_TOKEN_ENV = 'HARNESS_METRICS_TOKEN';
/** Set when naby has no metrics token: `metrics-emit.js` would otherwise fall
 *  back to Claude Code's own activation cache, which naby never reads (§3.6). */
export const ORG_METRICS_DISABLED_ENV = 'HARNESS_METRICS_DISABLED';
/** pdoc's `template_source.py` reads the cic token under this name (7.3). */
export const ORG_CIC_API_TOKEN_ENV = 'CIC_API_TOKEN';
/** The team code `metrics-emit.js` reports (§3.7). */
export const ORG_HARNESS_TEAM_ENV = 'HARNESS_TEAM';

// ---------------------------------------------------------------------------
// Parsing hooks.json
// ---------------------------------------------------------------------------

export type OrgHookDisposition = 'run' | 'native' | 'unsupported';

export type OrgHookEntry = {
  event: OrgHookEvent | string;
  matcher?: string;
  /** The executable as written (`node`). */
  command: string;
  /** Arguments with `${CLAUDE_PLUGIN_ROOT}` replaced by the package folder. */
  args: string[];
  /** Basename of the script the command runs, or '' when there is none. */
  script: string;
  timeoutMs: number;
  async: boolean;
  disposition: OrgHookDisposition;
  /** Why it is not run, for the Settings list and the log. */
  why?: string;
};

export type OrgHookConfig = {
  pkgDir: string;
  entries: OrgHookEntry[];
  problems: string[];
};

function substituteRoot(arg: string, pkgDir: string): string {
  return arg.replace(/\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT\b/g, () => pkgDir);
}

function samePath(a: string, b: string): boolean {
  const na = normalize(resolve(a));
  const nb = normalize(resolve(b));
  return CASE_INSENSITIVE_FS ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function isNodeCommand(cmd: string): boolean {
  const base = cmd.split(/[\\/]/).pop() ?? cmd;
  return base === 'node' || base === 'node.exe';
}

/** Classify one command against the allowlist (§3.5). Pure. */
export function classifyHookCommand(
  pkgDir: string,
  command: string,
  args: readonly string[],
): { disposition: OrgHookDisposition; script: string; why?: string } {
  const first = args[0] ?? '';
  const script = first ? (first.split(/[\\/]/).pop() ?? '') : '';
  if (!isNodeCommand(command)) {
    return { disposition: 'unsupported', script: script || command, why: `not a node command (${command})` };
  }
  if (!first) return { disposition: 'unsupported', script: '', why: 'no script argument' };
  const expected = join(pkgDir, 'scripts', script);
  const inPackage = isAbsolute(first) && samePath(first, expected);
  if (!inPackage) {
    return { disposition: 'unsupported', script, why: 'script is not under the package scripts/ folder' };
  }
  if (ORG_HOOK_NATIVE.includes(script)) {
    return { disposition: 'native', script, why: 'replaced by naby (§3.6)' };
  }
  if (!ORG_HOOK_ALLOWLIST.includes(script)) {
    return { disposition: 'unsupported', script, why: 'not on the naby allowlist yet' };
  }
  if (!existsSync(expected)) {
    return { disposition: 'unsupported', script, why: 'script file is missing from the package' };
  }
  return { disposition: 'run', script };
}

/** Read and classify `hooks/hooks.json` of a package folder. Never throws. */
export function readOrgHookConfig(pkgDir: string): OrgHookConfig {
  const problems: string[] = [];
  const entries: OrgHookEntry[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(pkgDir, 'hooks', 'hooks.json'), 'utf8'));
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException)?.code === 'ENOENT';
    if (!missing) problems.push(`hooks.json: ${e instanceof Error ? e.message : String(e)}`);
    return { pkgDir, entries, problems };
  }
  const hooks = (raw as { hooks?: unknown })?.hooks;
  if (!hooks || typeof hooks !== 'object') return { pkgDir, entries, problems };
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    const known = (ORG_HOOK_EVENTS as readonly string[]).includes(event);
    for (const group of groups) {
      const g = group as { matcher?: unknown; hooks?: unknown };
      const matcher = typeof g.matcher === 'string' ? g.matcher : undefined;
      if (!Array.isArray(g.hooks)) continue;
      for (const h of g.hooks) {
        const hk = h as { type?: unknown; command?: unknown; args?: unknown; timeout?: unknown; async?: unknown };
        if (hk.type !== undefined && hk.type !== 'command') {
          entries.push({
            event,
            ...(matcher !== undefined ? { matcher } : {}),
            command: String(hk.type),
            args: [],
            script: '',
            timeoutMs: ORG_HOOK_DEFAULT_TIMEOUT_MS,
            async: false,
            disposition: 'unsupported',
            why: `hook type "${String(hk.type)}" is not supported`,
          });
          continue;
        }
        if (typeof hk.command !== 'string' || !hk.command.trim()) continue;
        let command: string;
        let args: string[];
        if (Array.isArray(hk.args)) {
          command = hk.command.trim();
          args = hk.args.filter((a): a is string => typeof a === 'string');
        } else {
          const parts = splitHookCommand(hk.command);
          command = parts[0] ?? '';
          args = parts.slice(1);
        }
        args = args.map((a) => substituteRoot(a, pkgDir));
        const timeoutMs =
          typeof hk.timeout === 'number' && hk.timeout > 0
            ? Math.round(hk.timeout * 1000)
            : ORG_HOOK_DEFAULT_TIMEOUT_MS;
        const cls = classifyHookCommand(pkgDir, command, args);
        entries.push({
          event,
          ...(matcher !== undefined ? { matcher } : {}),
          command,
          args,
          script: cls.script,
          timeoutMs,
          async: hk.async === true,
          disposition: known ? cls.disposition : 'unsupported',
          ...(known ? (cls.why ? { why: cls.why } : {}) : { why: `event "${event}" has no naby moment` }),
        });
      }
    }
  }
  return { pkgDir, entries, problems };
}

/** What Settings lists as "hooks naby does not support yet" (§3.5): one line per
 *  distinct (event, script). */
export function unsupportedOrgHooks(config: OrgHookConfig): { event: string; script: string; why: string }[] {
  const seen = new Set<string>();
  const out: { event: string; script: string; why: string }[] = [];
  for (const e of config.entries) {
    if (e.disposition !== 'unsupported') continue;
    const key = `${e.event}\0${e.script}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ event: String(e.event), script: e.script || e.command, why: e.why ?? 'not supported' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matchers (§3.5 — regex, Claude Code semantics)
// ---------------------------------------------------------------------------

/**
 * Does `matcher` select `target`? Claude Code's rule: absent, empty or `*` matches
 * everything; a plain word list (`Write|Edit`) is an exact match against one of
 * its alternatives; anything else is a regular expression tested against the
 * name. A regex that does not compile throws — the caller skips that one entry.
 */
export function hookMatcherSelects(matcher: string | undefined, target: string): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  if (/^[A-Za-z0-9_|]+$/.test(matcher)) return matcher.split('|').includes(target);
  return new RegExp(matcher).test(target);
}

// ---------------------------------------------------------------------------
// Tool names and input in Claude Code's spelling (§3.5 "입력")
// ---------------------------------------------------------------------------

function absUnder(cwd: string | undefined, p: unknown): unknown {
  if (typeof p !== 'string' || !p) return p;
  if (isAbsolute(p) || !cwd) return p;
  return resolve(cwd, p);
}

type ToolInputMap = (input: Record<string, unknown>, cwd: string | undefined) => Record<string, unknown>;

/**
 * THE TABLE. naby's own tool → the Claude Code tool a hook expects. A hook whose
 * matcher is `Bash` never fires on a call named `run_command`; without this map
 * every task hook would be silently dead on the AI-SDK engine (§3.5), which is
 * why `spike-org-harness-hooks` walks every row.
 *
 * The Agent SDK engine's own built-ins already ARE these names, and pass through
 * unchanged.
 */
export const ORG_HOOK_TOOL_MAP: Readonly<Record<string, { name: string; input: ToolInputMap }>> = {
  run_command: {
    name: 'Bash',
    input: (i) => ({
      command: typeof i.command === 'string' ? i.command : '',
      ...(typeof i.timeoutMs === 'number' ? { timeout: i.timeoutMs } : {}),
      ...(typeof i.timeout === 'number' ? { timeout: i.timeout } : {}),
    }),
  },
  write_file: {
    name: 'Write',
    input: (i, cwd) => ({ file_path: absUnder(cwd, i.path), content: i.content }),
  },
  edit_file: {
    name: 'Edit',
    input: (i, cwd) => ({
      file_path: absUnder(cwd, i.path),
      old_string: i.oldString,
      new_string: i.newString,
      ...(i.replaceAll === true ? { replace_all: true } : {}),
    }),
  },
  read_file: {
    name: 'Read',
    input: (i, cwd) => ({
      file_path: absUnder(cwd, i.path),
      ...(typeof i.offset === 'number' ? { offset: i.offset } : {}),
      ...(typeof i.limit === 'number' ? { limit: i.limit } : {}),
    }),
  },
};

/**
 * One call in Claude Code's spelling. `mcpToolNames` are the namespaced names
 * (`<server>__<tool>`) of this turn's MCP tools — on BOTH engines the gate sees
 * that bare form — and become `mcp__<server>__<tool>`. Everything else (the Agent
 * SDK's own built-ins, naby's runtime tools) passes through as it is.
 */
export function toClaudeToolCall(
  toolName: string,
  input: unknown,
  opts: { cwd?: string; mcpToolNames?: ReadonlySet<string> } = {},
): { tool_name: string; tool_input: unknown } {
  const obj = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const mapped = ORG_HOOK_TOOL_MAP[toolName];
  if (mapped) return { tool_name: mapped.name, tool_input: mapped.input(obj, opts.cwd) };
  if (opts.mcpToolNames?.has(toolName)) return { tool_name: `mcp__${toolName}`, tool_input: input ?? {} };
  return { tool_name: toolName, tool_input: input ?? {} };
}

// ---------------------------------------------------------------------------
// Input and output
// ---------------------------------------------------------------------------

export type OrgHookCall = {
  event: OrgHookEvent;
  sessionId: string;
  /** The open project, if any. */
  cwd?: string;
  transcriptPath: string;
  /** SessionStart. */
  source?: 'startup' | 'resume' | 'clear' | 'compact';
  /** UserPromptSubmit. */
  prompt?: string;
  /** PreToolUse / PostToolUse — naby's own name and input (converted here). */
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  /** Set when the call ran inside a subagent (metrics-emit ignores those). */
  agentId?: string;
  /** PreCompact. */
  trigger?: 'auto' | 'manual';
  /** SessionEnd. */
  reason?: string;
  mcpToolNames?: ReadonlySet<string>;
};

/** The stdin JSON for one call — Claude Code's field names (§3.5). */
export function buildOrgHookInput(call: OrgHookCall): Record<string, unknown> {
  const base: Record<string, unknown> = {
    session_id: call.sessionId,
    transcript_path: call.transcriptPath,
    cwd: call.cwd ?? '',
    hook_event_name: call.event,
    ...(call.agentId ? { agent_id: call.agentId } : {}),
  };
  switch (call.event) {
    case 'SessionStart':
      return { ...base, source: call.source ?? 'startup' };
    case 'UserPromptSubmit':
      return { ...base, prompt: call.prompt ?? '' };
    case 'PreToolUse':
    case 'PostToolUse': {
      const t = toClaudeToolCall(call.toolName ?? '', call.toolInput, {
        ...(call.cwd ? { cwd: call.cwd } : {}),
        ...(call.mcpToolNames ? { mcpToolNames: call.mcpToolNames } : {}),
      });
      return {
        ...base,
        ...t,
        ...(call.event === 'PostToolUse' ? { tool_response: call.toolResponse ?? {} } : {}),
      };
    }
    case 'Stop':
      return { ...base, stop_hook_active: false };
    case 'PreCompact':
      return { ...base, trigger: call.trigger ?? 'auto', custom_instructions: null };
    case 'SessionEnd':
      return { ...base, reason: call.reason ?? 'other' };
    default:
      return base;
  }
}

/** What a matcher is compared with for each event (Claude Code's rule). */
function matcherTarget(call: OrgHookCall, input: Record<string, unknown>): string | undefined {
  switch (call.event) {
    case 'PreToolUse':
    case 'PostToolUse':
      return String(input.tool_name ?? '');
    case 'SessionStart':
      return String(input.source ?? '');
    case 'PreCompact':
      return String(input.trigger ?? '');
    case 'SessionEnd':
      return String(input.reason ?? '');
    default:
      return undefined; // UserPromptSubmit and Stop take no matcher
  }
}

export type OrgHookDecision = { behavior: 'ask' | 'deny' | 'allow'; reason?: string; script: string };

export type OrgHookOutput = {
  additionalContext?: string;
  decision?: { behavior: 'ask' | 'deny' | 'allow'; reason?: string };
};

/** Parse one hook's stdout (§3.5 "출력 처리"). Pure. */
export function parseOrgHookOutput(event: OrgHookEvent, stdout: string): OrgHookOutput {
  const text = stdout.trim();
  if (!text) return {};
  let json: Record<string, unknown> | undefined;
  if (text.startsWith('{')) {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = undefined;
    }
  }
  if (!json) {
    // Claude Code adds plain stdout of these two events to the context.
    if (event === 'SessionStart' || event === 'UserPromptSubmit') {
      return { additionalContext: text.slice(0, MAX_CONTEXT_CHARS) };
    }
    return {};
  }
  const out: OrgHookOutput = {};
  const hso = json.hookSpecificOutput as Record<string, unknown> | undefined;
  const ctx = hso && typeof hso.additionalContext === 'string' ? hso.additionalContext : undefined;
  if (ctx && ctx.trim()) out.additionalContext = ctx.slice(0, MAX_CONTEXT_CHARS);
  if (event === 'PreToolUse') {
    const pd = hso?.permissionDecision;
    const reason =
      typeof hso?.permissionDecisionReason === 'string'
        ? hso.permissionDecisionReason
        : typeof json.reason === 'string'
          ? json.reason
          : undefined;
    if (pd === 'ask' || pd === 'deny' || pd === 'allow') {
      out.decision = { behavior: pd, ...(reason ? { reason } : {}) };
    } else if (json.decision === 'block') {
      // The older top-level spelling.
      out.decision = { behavior: 'deny', ...(reason ? { reason } : {}) };
    } else if (json.decision === 'approve') {
      out.decision = { behavior: 'allow', ...(reason ? { reason } : {}) };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The environment a hook runs with (§3.4, §3.5)
// ---------------------------------------------------------------------------

export type OrgHookEnvArgs = {
  base: Record<string, string | undefined>;
  pkgDir: string;
  projectDir?: string;
  cicToken?: string;
  metricsToken?: string;
  /** The open project's `HARNESS_TEAM` (`orgProjectHarnessTeam`). Wins over the
   *  one in `base`; absent leaves `base`'s value (or none) in place. */
  team?: string;
};

/**
 * `env.HARNESS_TEAM` of the open project's Claude Code settings (§3.7, user
 * decision 2026-10-08): `.claude/settings.local.json` wins over
 * `.claude/settings.json`. In Claude Code the team repository sets the team
 * code there; naby reads THAT ONE KEY and nothing else from those files, never
 * writes them, and treats a missing file, invalid JSON or a non-string value as
 * "not set". Undefined without a project.
 */
export function orgProjectHarnessTeam(projectDir: string | undefined): string | undefined {
  if (!projectDir) return undefined;
  const read = (name: string): string | undefined => {
    try {
      const raw = JSON.parse(readFileSync(join(projectDir, '.claude', name), 'utf8')) as {
        env?: Record<string, unknown>;
      };
      const v = raw && typeof raw === 'object' ? raw.env?.[ORG_HARNESS_TEAM_ENV] : undefined;
      return typeof v === 'string' && v.trim() ? v.trim() : undefined;
    } catch {
      return undefined;
    }
  };
  return read('settings.local.json') ?? read('settings.json');
}

/** The env for every org hook. Never carries the Skill Hub key. Pure. */
export function orgHookEnv(args: OrgHookEnvArgs): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(args.base)) if (typeof v === 'string') env[k] = v;
  for (const k of ORG_KEY_ENV_NAMES) delete env[k];
  env[ORG_COMMAND_ENV.pluginRoot] = args.pkgDir;
  if (args.projectDir) env[ORG_COMMAND_ENV.projectDir] = args.projectDir;
  else delete env[ORG_COMMAND_ENV.projectDir];
  env[ORG_COMMAND_ENV.client] = ORG_HARNESS_CLIENT;
  // Team: the project's value first, then the process env's (already in `base`),
  // else unset — the script then reports "unassigned".
  if (args.team) env[ORG_HARNESS_TEAM_ENV] = args.team;
  delete env[ORG_COMMAND_ENV.cicToken];
  delete env[ORG_CIC_API_TOKEN_ENV];
  if (args.cicToken) {
    // Both names (user decision 2026-10-08): the plugin option name, and the one
    // pdoc's template_source.py actually reads.
    env[ORG_COMMAND_ENV.cicToken] = args.cicToken;
    env[ORG_CIC_API_TOKEN_ENV] = args.cicToken;
  }
  if (args.metricsToken) {
    env[ORG_METRICS_TOKEN_ENV] = args.metricsToken;
    delete env[ORG_METRICS_DISABLED_ENV];
  } else {
    delete env[ORG_METRICS_TOKEN_ENV];
    env[ORG_METRICS_DISABLED_ENV] = '1';
  }
  // `node` is this executable (Electron's binary in the app).
  env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

// ---------------------------------------------------------------------------
// Transcripts (§3.5 "transcript_path")
// ---------------------------------------------------------------------------

function safeName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'session';
}

export function orgTranscriptPath(home: string, sessionId: string): string {
  return join(home, 'transcripts', `${safeName(sessionId)}.jsonl`);
}

/** Claude Code-shaped JSONL lines for a transcript. Pure. */
export function claudeTranscriptLines(
  sessionId: string,
  messages: readonly RuntimeMessage[],
  opts: { cwd?: string; mcpToolNames?: ReadonlySet<string> } = {},
): string[] {
  const lines: string[] = [];
  let parent: string | null = null;
  const toolNames = new Map<string, string>();
  for (const m of messages) {
    const uuid = randomBytes(16).toString('hex');
    let entry: Record<string, unknown>;
    if (m.role === 'tool') {
      entry = {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: m.toolCallId, content: m.output.content, is_error: m.output.isError === true },
          ],
        },
      };
    } else if (m.role === 'assistant') {
      const content: unknown[] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls ?? []) {
        const t = toClaudeToolCall(tc.toolName, tc.input, opts);
        toolNames.set(tc.toolCallId, t.tool_name);
        content.push({ type: 'tool_use', id: tc.toolCallId, name: t.tool_name, input: t.tool_input });
      }
      entry = { type: 'assistant', message: { role: 'assistant', content } };
      if (m.turn) entry.timestamp = new Date(m.turn.endedAt).toISOString();
    } else {
      entry = { type: 'user', message: { role: 'user', content: m.content } };
    }
    lines.push(
      JSON.stringify({
        parentUuid: parent,
        isSidechain: false,
        sessionId,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        uuid,
        ...entry,
      }),
    );
    parent = uuid;
  }
  return lines;
}

/** Write the transcript atomically; returns its path, or undefined on failure. */
export function writeOrgTranscript(args: {
  home: string;
  sessionId: string;
  messages: readonly RuntimeMessage[];
  cwd?: string;
  mcpToolNames?: ReadonlySet<string>;
}): string | undefined {
  const path = orgTranscriptPath(args.home, args.sessionId);
  try {
    mkdirSync(join(args.home, 'transcripts'), { recursive: true });
    const lines = claudeTranscriptLines(args.sessionId, args.messages, {
      ...(args.cwd ? { cwd: args.cwd } : {}),
      ...(args.mcpToolNames ? { mcpToolNames: args.mcpToolNames } : {}),
    });
    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, lines.length ? `${lines.join('\n')}\n` : '');
    renameSync(tmp, path);
    return path;
  } catch (e) {
    orgHookLog(`transcript write failed for ${args.sessionId}: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// The hook log (§3.5: failures go "to the hook log only")
// ---------------------------------------------------------------------------

export type OrgHookLogEntry = {
  at: number;
  event: string;
  script: string;
  outcome: 'ok' | 'failed' | 'timeout' | 'async' | 'skipped' | 'matcher-error';
  ms?: number;
  detail?: string;
  /** The session the hook ran for (absent on runner-level entries). */
  sessionId?: string;
  /** The package folder the hook ran from (`CLAUDE_PLUGIN_ROOT`). */
  pkgDir?: string;
  /** The first few KB of the hook's stderr. IN MEMORY ONLY — never written to
   *  the activity log (a hook's stderr is its own business). */
  stderr?: string;
};

const HOOK_LOG_CAP = 200;
const hookLog: OrgHookLogEntry[] = [];

function orgHookLog(line: string): void {
  console.log(`[org-hooks] ${line}`);
}

function recordHook(entry: OrgHookLogEntry): void {
  hookLog.push(entry);
  if (hookLog.length > HOOK_LOG_CAP) hookLog.splice(0, hookLog.length - HOOK_LOG_CAP);
  if (entry.outcome !== 'ok' && entry.outcome !== 'async') {
    orgHookLog(
      `${entry.event} ${entry.script}: ${entry.outcome}${entry.ms !== undefined ? ` (${entry.ms}ms)` : ''}` +
        (entry.detail ? ` — ${entry.detail}` : ''),
    );
  }
  // The durable trace: the activity log (no-op unless a naby home is configured).
  // Without stderr: that stays in memory.
  const { stderr: _stderr, ...durable } = entry;
  void _stderr;
  logActivity('org_hook', { ...durable });
}

/** The recent hook outcomes, newest last (diagnostics, spikes). */
export function recentOrgHookLog(): readonly OrgHookLogEntry[] {
  return hookLog.slice();
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

type SpawnFn = typeof spawn;

export type OrgHookRunnerOptions = {
  config: OrgHookConfig;
  /** From `orgHookEnv`. */
  env: Record<string, string>;
  /** The executable `node` means. Default `process.execPath` (Electron's binary
   *  in the app, run as Node through `ELECTRON_RUN_AS_NODE=1`). */
  executable?: string;
  /** Injectable for spikes; defaults to `child_process.spawn`. */
  spawnImpl?: SpawnFn;
  now?: () => number;
};

export type OrgHookDispatchResult = {
  event: OrgHookEvent;
  /** Hooks that matched and were started (sync + async). */
  started: number;
  ok: number;
  failed: number;
  timedOut: number;
  asyncStarted: number;
  /** Matching entries naby does not run (native / unsupported). */
  notRun: number;
  matcherErrors: number;
  additionalContext: string[];
  /** The strongest PreToolUse opinion: deny > ask > allow. */
  decision?: OrgHookDecision;
  /** True when the SessionEnd cap cut the wait short. */
  capped?: boolean;
};

type ProcResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: string; ms: number };

function runProcess(
  spawnImpl: SpawnFn,
  executable: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; stdin: string; timeoutMs: number },
  now: () => number,
): { done: Promise<ProcResult>; child?: ChildProcess } {
  const started = now();
  let child: ChildProcess;
  try {
    child = spawnImpl(executable, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (e) {
    return {
      done: Promise.resolve({ code: null, stdout: '', stderr: '', timedOut: false, error: e instanceof Error ? e.message : String(e), ms: 0 }),
    };
  }
  const done = new Promise<ProcResult>((resolveDone) => {
    let stdout = '';
    let bytes = 0;
    let stderr = '';
    let errBytes = 0;
    let timedOut = false;
    let finished = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* gone */
      }
      const k = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* gone */
        }
      }, KILL_GRACE_MS);
      k.unref?.();
    }, opts.timeoutMs);
    timer.unref?.();
    const finish = (r: Omit<ProcResult, 'ms'>): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolveDone({ ...r, stderr: r.stderr.slice(0, MAX_HOOK_STDERR_BYTES), ms: now() - started });
    };
    child.stdout?.on('data', (d: Buffer) => {
      if (bytes >= MAX_HOOK_STDOUT_BYTES) return;
      bytes += d.length;
      stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      // Always drained (a full pipe would stall the hook); only the head is kept.
      if (errBytes >= MAX_HOOK_STDERR_BYTES) return;
      errBytes += d.length;
      stderr += d.toString('utf8');
    });
    child.on('error', (e) => finish({ code: null, stdout, stderr, timedOut, error: e.message }));
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut }));
    child.stdin?.on('error', () => {
      /* a hook that does not read stdin closes it early: not an error */
    });
    try {
      child.stdin?.end(opts.stdin);
    } catch {
      /* same */
    }
  });
  return { done, child };
}

/** Per-project lanes for PreCompact and SessionEnd (§3.5). Module-level: two
 *  tabs build two runners, and the lane must be shared between them. */
const serialLanes = new Map<string, Promise<void>>();

function laneKey(cwd: string | undefined): string {
  const k = cwd ?? '';
  return CASE_INSENSITIVE_FS ? k.toLowerCase() : k;
}

const inflightAsync = new Set<Promise<unknown>>();

/** Resolves when every async (fire-and-forget) hook started so far has exited —
 *  for spikes and for the quit path's best effort. */
export async function orgHooksIdle(timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (inflightAsync.size > 0) {
    if (Date.now() > deadline) return false;
    await Promise.race([Promise.allSettled([...inflightAsync]), new Promise((r) => setTimeout(r, 50))]);
  }
  return true;
}

export type OrgHookRunner = {
  readonly config: OrgHookConfig;
  dispatch(call: OrgHookCall): Promise<OrgHookDispatchResult>;
  /** Entries the runner would start for this call (no side effects). */
  plan(call: OrgHookCall): OrgHookEntry[];
};

/** Build a runner over one pinned package folder. */
export function createOrgHookRunner(opts: OrgHookRunnerOptions): OrgHookRunner {
  const spawnImpl = opts.spawnImpl ?? spawn;
  const executable = opts.executable ?? process.execPath;
  const now = opts.now ?? Date.now;
  const config = opts.config;

  const matching = (call: OrgHookCall, input: Record<string, unknown>, result?: OrgHookDispatchResult): OrgHookEntry[] => {
    const target = matcherTarget(call, input);
    const out: OrgHookEntry[] = [];
    for (const e of config.entries) {
      if (e.event !== call.event) continue;
      if (target !== undefined) {
        try {
          if (!hookMatcherSelects(e.matcher, target)) continue;
        } catch (err) {
          if (result) result.matcherErrors += 1;
          recordHook({
            at: now(),
            event: call.event,
            script: e.script,
            outcome: 'matcher-error',
            detail: `matcher ${JSON.stringify(e.matcher)}: ${err instanceof Error ? err.message : String(err)}`,
          });
          continue;
        }
      }
      if (e.disposition !== 'run') {
        if (result) result.notRun += 1;
        continue;
      }
      // NABY-SIDE FILTER (§4.7): a session resumed after a restart is not a new
      // session for the H1–H4 count, but metrics-emit.js only filters `compact`.
      if (e.script === 'metrics-emit.js' && call.event === 'SessionStart' && call.source === 'resume') {
        if (result) result.notRun += 1;
        continue;
      }
      out.push(e);
    }
    return out;
  };

  const runAll = async (call: OrgHookCall): Promise<OrgHookDispatchResult> => {
    const input = buildOrgHookInput(call);
    const result: OrgHookDispatchResult = {
      event: call.event,
      started: 0,
      ok: 0,
      failed: 0,
      timedOut: 0,
      asyncStarted: 0,
      notRun: 0,
      matcherErrors: 0,
      additionalContext: [],
    };
    const entries = matching(call, input, result);
    if (entries.length === 0) return result;
    const stdin = JSON.stringify(input);
    let cwd = config.pkgDir;
    if (call.cwd) {
      try {
        if (statSync(call.cwd).isDirectory()) cwd = call.cwd;
      } catch {
        /* the package folder, then */
      }
    }
    const waits: Promise<void>[] = [];
    const everything: Promise<void>[] = [];
    let decision: OrgHookDecision | undefined;
    const rank = { allow: 1, ask: 2, deny: 3 } as const;
    // THE FOLDER IS LEASED WHILE ANY OF THESE PROCESSES RUNS (§4.7, M4). An async
    // hook (metrics-emit at Stop) outlives the turn that started it, and it reads
    // `${CLAUDE_PLUGIN_ROOT}` files after it starts — the package GC must not
    // delete its folder in between. Released when the last one exits.
    const releaseLease = leaseOrgPackageDir(config.pkgDir);
    const tag = (r: ProcResult) => ({
      sessionId: call.sessionId,
      pkgDir: config.pkgDir,
      ...(r.stderr.trim() ? { stderr: r.stderr } : {}),
    });
    for (const e of entries) {
      result.started += 1;
      const proc = runProcess(spawnImpl, executable, e.args, { cwd, env: opts.env, stdin, timeoutMs: e.timeoutMs }, now);
      const settle = proc.done.then((r) => {
        if (r.timedOut) {
          result.timedOut += 1;
          recordHook({ at: now(), event: call.event, script: e.script, outcome: 'timeout', ms: r.ms, ...tag(r) });
          return;
        }
        if (r.error || r.code !== 0) {
          result.failed += 1;
          recordHook({
            at: now(),
            event: call.event,
            script: e.script,
            outcome: 'failed',
            ms: r.ms,
            detail: r.error ?? `exit ${String(r.code)}`,
            ...tag(r),
          });
          return;
        }
        if (e.async) {
          recordHook({ at: now(), event: call.event, script: e.script, outcome: 'async', ms: r.ms, ...tag(r) });
          return;
        }
        result.ok += 1;
        recordHook({ at: now(), event: call.event, script: e.script, outcome: 'ok', ms: r.ms, ...tag(r) });
        const out = parseOrgHookOutput(call.event, r.stdout);
        if (out.additionalContext) result.additionalContext.push(out.additionalContext);
        if (out.decision && (!decision || rank[out.decision.behavior] > rank[decision.behavior])) {
          decision = { ...out.decision, script: e.script };
        }
      });
      const quiet = settle.catch(() => {});
      everything.push(quiet);
      if (e.async) {
        // `async: true` — not waited for (§3.5). Tracked so a spike or the quit
        // path can tell when they are gone.
        result.asyncStarted += 1;
        inflightAsync.add(quiet);
        void quiet.finally(() => inflightAsync.delete(quiet));
      } else {
        waits.push(quiet);
      }
    }
    void Promise.all(everything).finally(releaseLease);
    await Promise.all(waits);
    if (decision) result.decision = decision;
    return result;
  };

  const dispatch = async (call: OrgHookCall): Promise<OrgHookDispatchResult> => {
    try {
      if (call.event !== 'PreCompact' && call.event !== 'SessionEnd') return await runAll(call);
      // Serial per project: wait for the previous PreCompact/SessionEnd there.
      const key = laneKey(call.cwd);
      const prev = serialLanes.get(key) ?? Promise.resolve();
      const mine = prev.then(() => runAll(call));
      const tail = mine.then(
        () => undefined,
        () => undefined,
      );
      serialLanes.set(key, tail);
      void tail.then(() => {
        if (serialLanes.get(key) === tail) serialLanes.delete(key);
      });
      if (call.event !== 'SessionEnd') return await mine;
      // SessionEnd: everything started together; the caller gets control back
      // after the cap whatever is still running (§3.5).
      let capTimer: ReturnType<typeof setTimeout> | undefined;
      const capped = new Promise<'capped'>((r) => {
        capTimer = setTimeout(() => r('capped'), ORG_SESSION_END_CAP_MS);
        capTimer.unref?.();
      });
      const winner = await Promise.race([mine, capped]);
      if (capTimer) clearTimeout(capTimer);
      if (winner === 'capped') {
        recordHook({ at: now(), event: 'SessionEnd', script: '*', outcome: 'skipped', detail: `stopped waiting after ${ORG_SESSION_END_CAP_MS}ms` });
        return {
          event: 'SessionEnd',
          started: 0,
          ok: 0,
          failed: 0,
          timedOut: 0,
          asyncStarted: 0,
          notRun: 0,
          matcherErrors: 0,
          additionalContext: [],
          capped: true,
        };
      }
      return winner;
    } catch (e) {
      // Never into the turn.
      orgHookLog(`${call.event} dispatch failed: ${e instanceof Error ? e.message : String(e)}`);
      return {
        event: call.event,
        started: 0,
        ok: 0,
        failed: 1,
        timedOut: 0,
        asyncStarted: 0,
        notRun: 0,
        matcherErrors: 0,
        additionalContext: [],
      };
    }
  };

  return {
    config,
    dispatch,
    plan: (call) => matching(call, buildOrgHookInput(call)),
  };
}

// ---------------------------------------------------------------------------
// Which sessions this process started (SessionStart source, SessionEnd on quit)
// ---------------------------------------------------------------------------

export type OrgHookSessionInfo = {
  sessionId: string;
  cwd?: string;
  /** The package folder its turns used (SessionEnd runs from the same one). */
  pkgDir: string;
  startedAt: number;
};

const liveSessions = new Map<string, OrgHookSessionInfo>();

/**
 * The `source` for this turn's SessionStart, or undefined when the session
 * already had one in this process (§4.7). A session the shell just minted is
 * `startup`; one this process has not seen yet is `resume` (an app restart, or a
 * session reopened from the list).
 */
export function orgSessionStartSource(sessionId: string, isNew: boolean): 'startup' | 'resume' | undefined {
  if (liveSessions.has(sessionId)) return undefined;
  return isNew ? 'startup' : 'resume';
}

export function noteOrgSessionStarted(info: OrgHookSessionInfo): void {
  liveSessions.set(info.sessionId, info);
}

/** A later turn of a live session pinned `pkgDir` (a newer version arrived
 *  between turns, §4.7): its SessionEnd runs from the folder its LAST turn used.
 *  No-op for a session that has not started in this process. */
export function touchOrgSession(sessionId: string, pkgDir: string): void {
  const s = liveSessions.get(sessionId);
  if (s && s.pkgDir !== pkgDir) liveSessions.set(sessionId, { ...s, pkgDir });
}

/** Take a session off the live list (it ends now). Undefined when it never
 *  started in this process — SessionEnd then has nothing to close. */
export function takeOrgSession(sessionId: string): OrgHookSessionInfo | undefined {
  const s = liveSessions.get(sessionId);
  if (s) liveSessions.delete(sessionId);
  return s;
}

/** Every live session, removed from the list (app quit). */
export function takeAllOrgSessions(): OrgHookSessionInfo[] {
  const all = [...liveSessions.values()];
  liveSessions.clear();
  return all;
}

/** Spikes: forget the process-level bookkeeping. */
export function resetOrgHookStateForTests(): void {
  liveSessions.clear();
  hookLog.length = 0;
  serialLanes.clear();
}

// ---------------------------------------------------------------------------
// App quit (§1 "앱 종료를 세션 종료로 본다")
// ---------------------------------------------------------------------------

/**
 * The key the shell registers its "end every live session" function under, and
 * the Electron main process calls on quit. A global, not an import: the Next
 * server bundles its own copy of this runtime, so a module-level variable here
 * would not be the one the main process can see (the same reason the ChatGPT
 * token source rides `globalThis`).
 */
export const ORG_HARNESS_QUIT_HOOK_KEY = 'naby.orgHarness.sessionEndOnQuit';

type QuitHost = { [k: symbol]: (() => Promise<void>) | undefined };

export function installOrgHarnessQuitHandler(fn: (() => Promise<void>) | undefined): void {
  const key = Symbol.for(ORG_HARNESS_QUIT_HOOK_KEY);
  if (fn) (globalThis as unknown as QuitHost)[key] = fn;
  else delete (globalThis as unknown as QuitHost)[key];
}

/** Run the registered quit handler, waiting at most `capMs`. Never throws. */
export async function runOrgHarnessQuitHandler(capMs = ORG_SESSION_END_CAP_MS): Promise<void> {
  const fn = (globalThis as unknown as QuitHost)[Symbol.for(ORG_HARNESS_QUIT_HOOK_KEY)];
  if (!fn) return;
  let t: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fn().catch(() => undefined),
      new Promise<void>((r) => {
        t = setTimeout(r, capMs);
        t.unref?.();
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

/** `SessionRef` → the info a SessionEnd needs (the shell's tab-close path). */
export function orgSessionInfoFromRef(ref: SessionRef, pkgDir: string, now = Date.now()): OrgHookSessionInfo {
  return { sessionId: ref.sessionId, ...(ref.cwd ? { cwd: ref.cwd } : {}), pkgDir, startedAt: now };
}

/** True when `p` is inside `root` (a guard the shell uses before trusting a
 *  remembered package folder). */
export function isInsideFolder(root: string, p: string): boolean {
  const r = normalize(resolve(root)) + sep;
  const x = normalize(resolve(p));
  return CASE_INSENSITIVE_FS ? x.toLowerCase().startsWith(r.toLowerCase()) : x.startsWith(r);
}
