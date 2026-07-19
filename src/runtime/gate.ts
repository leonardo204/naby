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
