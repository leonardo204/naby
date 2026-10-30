// src/runtime/gate.ts
//
// The runtime gate (contract §3). Defined ONCE here and passed into whichever
// engine runs; each engine attaches it at its only sound pre-execution point.
//
// For the spike we support a SCRIPTED policy so tests can force
// allow / deny / allow-with-rewrite deterministically. Every gate invocation
// is appended to an in-memory log so a test can assert "the gate saw this call"
// and, via timestamps, that it saw it BEFORE the executor ran.

import type { Gate, GateDecision, ToolCall } from './engine.js';
import { MUTATING_TOOLS } from './fs-tools.js';
import { JOB_EXECUTION_TOOLS } from './job-tools.js';

export type GateLogEntry = {
  seq: number;
  at: number; // Date.now() when the gate was consulted
  toolCallId: string;
  toolName: string;
  input: unknown;
  decision: GateDecision;
};

/** A decision policy: given a call, return a decision (sync or async). */
export type DecisionPolicy = (
  call: ToolCall,
) => GateDecision | Promise<GateDecision>;

export type MakeGateResult = {
  gate: Gate;
  log: GateLogEntry[];
  /** convenience: entries for one tool name. */
  callsFor(toolName: string): GateLogEntry[];
};

export function makeGate(decisionPolicy: DecisionPolicy): MakeGateResult {
  const log: GateLogEntry[] = [];
  let seq = 0;

  const gate: Gate = async (call: ToolCall): Promise<GateDecision> => {
    const decision = await decisionPolicy(call);
    log.push({
      seq: seq++,
      at: Date.now(),
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.input,
      decision,
    });
    return decision;
  };

  return {
    gate,
    log,
    callsFor: (toolName: string) => log.filter((e) => e.toolName === toolName),
  };
}

// ---------------------------------------------------------------------------
// Scripted policy helpers (spike-only) — build a policy from per-tool rules.
// ---------------------------------------------------------------------------

export type ScriptRule =
  | { behavior: 'allow' }
  | { behavior: 'allow'; rewriteInput: (input: unknown) => unknown }
  | { behavior: 'deny'; reason: string };

/** Build a policy keyed by bare tool name. Unlisted tools default to deny —
 * the product's stance is "refuse rather than run ungated" (contract §3.4). */
export function scriptedPolicy(
  rules: Record<string, ScriptRule>,
  fallback: GateDecision = { behavior: 'deny', reason: 'no rule for tool' },
): DecisionPolicy {
  return (call: ToolCall): GateDecision => {
    const rule = rules[call.toolName];
    if (!rule) return fallback;
    if (rule.behavior === 'deny') {
      return { behavior: 'deny', reason: rule.reason };
    }
    if ('rewriteInput' in rule) {
      return { behavior: 'allow', input: rule.rewriteInput(call.input) };
    }
    return { behavior: 'allow' };
  };
}

// ---------------------------------------------------------------------------
// Phase-1 harness-observation floor (contract §3.4).
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS
// ---------------
// To SHOW skill / subagent activity (the "harness visibility" feature) the
// Claude Agent SDK engine must let the model call the built-in Task / Skill
// tools — i.e. it can no longer run with `tools: []`, which stripped every
// built-in and left our MCP runtime tools as the only callable surface. Once
// built-ins are live, a spawned subagent carries its OWN built-ins (Bash,
// Write, Edit, …), and those calls pass through THIS gate too — verified: the
// PreToolUse gate reaches inside subagents and a deny holds (spike-subagent-gate,
// spike-harness-visibility).
//
// The full Phase-2 policy — per-project rules, an approval UI, human-in-the-loop
// — does not exist yet; the production policy is otherwise permissive. This
// floor is NOT that policy. It is the minimum that makes observation SAFE: a
// hardcoded allowlist that lets the harness be watched (read-only inspection +
// delegation + skills + our own runtime tools) while refusing anything that
// could MUTATE the filesystem or execute a shell — from the main loop or from
// any subagent. It is deliberately deny-by-default: an unrecognised tool is
// refused, so a built-in we did not anticipate cannot slip through.
//
// This is a SAFETY FLOOR, not a feature gate. Phase 2 replaces it with the real
// policy; until then it is the thing standing between "observe the harness" and
// "auto-approve a subagent's `rm -rf`".

/**
 * Built-in tools that only INSPECT, plus the delegation/skill tools whose
 * activity we want to surface. Bare names, matching what the gate sees after
 * `mcp__…__` stripping. Kept as a denial-safe allowlist: adding a tool here is a
 * deliberate act, and anything absent is denied.
 */
export const OBSERVATION_BUILTINS: readonly string[] = [
  'Read',
  'Glob',
  'Grep',
  'Task',
  'Agent', // the SDK reports the delegation tool under this name
  'Skill',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
];

/**
 * Built-ins that can mutate the filesystem or execute code. Listed EXPLICITLY as
 * well as being caught by deny-by-default, so the intent is legible and a future
 * edit that loosens the default still cannot accidentally permit these.
 */
export const DANGEROUS_BUILTINS: readonly string[] = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
];

/**
 * WHY A TURN IS READ-ONLY — the switch the user flipped. The floor below is the
 * same policy either way; what differs is what the user has to do to lift it,
 * and a refusal that does not say so leaves naby guessing (2026-10-30 VOC: the
 * old reason talked about "Phase 1 observation mode" and "the Phase 2 approval
 * policy", so naby told the user it did not know which setting blocked it).
 *
 *   plan-mode          the chat tab's "Plan mode" checkbox (wins: it is the
 *                      more recent, more specific choice)
 *   allow-changes-off  the app-wide "Allow changes" switch is off
 *   participant-plan   a participant's own "Permission mode" is "Plan
 *                      (read-only)" in its editor — the chat itself is not
 *                      read-only. Never returned by `readOnlyCause` (that
 *                      answers for naby's own turn); the participant gate passes
 *                      it, with the participant's name, to `phase1HarnessFloor`.
 */
export type ReadOnlyCause = 'plan-mode' | 'allow-changes-off' | 'participant-plan';

/** Extra detail a remedy may need. `participant` is the handle (no `@`). */
export interface ReadOnlyDetail {
  participant?: string;
}

export function readOnlyCause(input: { planMode: boolean; allowChanges: boolean }): ReadOnlyCause | undefined {
  if (input.planMode) return 'plan-mode';
  if (!input.allowChanges) return 'allow-changes-off';
  return undefined;
}

/** How to lift the read-only mode, in the UI's own words (en + ko labels). */
function readOnlyRemedy(cause: ReadOnlyCause | undefined, detail: ReadOnlyDetail = {}): string {
  switch (cause) {
    case 'participant-plan': {
      const who = detail.participant ? `@${detail.participant}` : 'This participant';
      return (
        `${who} is set to read-only: its "Permission mode" is "Plan (read-only)" (권한 모드: "계획 (읽기 전용)"). ` +
        `To let it edit files and run commands, the user changes that to "Default" in Settings → Naby → Participants → ${who} (설정 → 나비 → 참가자). ` +
        'Or the user can ask naby itself, without the @ mention, to make the change.'
      );
    }
    case 'plan-mode':
      return 'Plan mode is on for this chat tab (read-only: plan first, no edits). To let naby edit files and run commands, the user unchecks "Plan mode" (플랜 모드) in the chat header and sends the request again.';
    case 'allow-changes-off':
      return 'The "Allow changes" switch (변경 허용) is off, so the app is read-only. To let naby edit files and run commands, the user turns "Allow changes" back on in the chat header and sends the request again.';
    default:
      return 'This turn is read-only.';
  }
}

/** The floor's refusal of a mutating / executing tool. */
export function readOnlyDenyReason(toolName: string, cause?: ReadOnlyCause, detail: ReadOnlyDetail = {}): string {
  return `${toolName} is blocked: this turn cannot edit files or run commands. ${readOnlyRemedy(cause, detail)}`;
}

/**
 * The system-prompt line for a read-only turn, so naby knows BEFORE it tries
 * a write — and, when the user asks for a change, says which switch to flip
 * instead of attempting it and reporting a refusal it cannot explain.
 */
export function readOnlyTurnNotice(cause: ReadOnlyCause): string {
  return [
    '## This turn is read-only',
    readOnlyRemedy(cause),
    'You can still read, search and plan. If the request needs a file change or a command, say so plainly and tell the user exactly which switch to change — do not attempt the change and do not look for a way around the block.',
  ].join('\n');
}

/**
 * The Phase-1 floor. Allows exactly: our own runtime tools (whose bare names the
 * caller supplies, since only the composition root knows them) plus the
 * read-only / delegation / skill built-ins above. Everything else — the
 * dangerous built-ins named for clarity, and any tool nobody listed — is denied.
 *
 * @param runtimeToolNames bare names of the MCP runtime tools this turn exposes
 *   (from the toolset the runtime builds). Always allowed: they are our own
 *   executors, gated for real in Phase 2.
 */
export function phase1HarnessFloor(
  runtimeToolNames: readonly string[] = [],
  opts: { cause?: ReadOnlyCause } & ReadOnlyDetail = {},
): DecisionPolicy {
  // OUR OWN TOOLS ARE NOT AUTOMATICALLY SAFE.
  //
  // The allowance for `runtimeToolNames` reads as "they are our executors, we
  // gate them for real in Phase 2", and that was true while every runtime tool
  // was a note or an HTTP GET. It stopped being true the moment the runtime grew
  // write_file / edit_file / run_command: passing those through would make
  // read-only observation mode permit the exact thing it exists to forbid. They
  // are subtracted here rather than at the call site so no future composition
  // root can hand them in by accident.
  //
  // `naby_start_job` is subtracted for the same reason, and needs saying because
  // it is a NABY-LAYER tool rather than a workspace one: the naby layer is
  // attached to every turn including a read-only one, so this floor is the only
  // thing standing between plan mode and a shell command that merely happens not
  // to be waited on. Its two observers (`naby_check_job` /
  // `naby_read_job_output`) are deliberately NOT subtracted — reporting on work
  // already started is exactly what a read-only turn should still be able to do.
  const executingRuntime = new Set<string>([...MUTATING_TOOLS, ...JOB_EXECUTION_TOOLS]);
  const allow = new Set<string>([
    ...runtimeToolNames.filter((n) => !executingRuntime.has(n)),
    ...OBSERVATION_BUILTINS,
  ]);
  const dangerous = new Set<string>([...DANGEROUS_BUILTINS, ...executingRuntime]);
  return (call: ToolCall): GateDecision => {
    if (dangerous.has(call.toolName)) {
      return {
        behavior: 'deny',
        reason: readOnlyDenyReason(call.toolName, opts.cause, opts),
      };
    }
    if (allow.has(call.toolName)) return { behavior: 'allow' };
    // Deny-by-default: an unrecognised tool is refused rather than run ungated.
    return {
      behavior: 'deny',
      reason: opts.cause
        ? `${call.toolName} is not available while this turn is read-only. ${readOnlyRemedy(opts.cause, opts)}`
        : `${call.toolName} is not available on this turn. Use the tools you were given.`,
    };
  };
}
