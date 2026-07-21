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
 * The Phase-1 floor. Allows exactly: our own runtime tools (whose bare names the
 * caller supplies, since only the composition root knows them) plus the
 * read-only / delegation / skill built-ins above. Everything else — the
 * dangerous built-ins named for clarity, and any tool nobody listed — is denied.
 *
 * @param runtimeToolNames bare names of the MCP runtime tools this turn exposes
 *   (from the toolset the runtime builds). Always allowed: they are our own
 *   executors, gated for real in Phase 2.
 */
export function phase1HarnessFloor(runtimeToolNames: readonly string[] = []): DecisionPolicy {
  const allow = new Set<string>([...runtimeToolNames, ...OBSERVATION_BUILTINS]);
  const dangerous = new Set<string>(DANGEROUS_BUILTINS);
  return (call: ToolCall): GateDecision => {
    if (dangerous.has(call.toolName)) {
      return {
        behavior: 'deny',
        reason: `${call.toolName} is not permitted in Phase 1 observation mode (mutation/exec blocked until the Phase 2 approval policy exists)`,
      };
    }
    if (allow.has(call.toolName)) return { behavior: 'allow' };
    // Deny-by-default: an unrecognised tool is refused rather than run ungated.
    return {
      behavior: 'deny',
      reason: `${call.toolName} is not on the Phase 1 allowlist`,
    };
  };
}
