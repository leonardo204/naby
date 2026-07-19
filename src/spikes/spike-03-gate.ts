// src/spikes/spike-03-gate.ts
//
// SPIKE-03 — gate soundness on the DEV engine (ClaudeAgentSdkEngine, local
// OAuth, real model calls). Asserts the four load-bearing invariants of the
// gate contract (§3), by execution:
//
//   (a) a tool call is surfaced to OUR gate BEFORE it executes — the gate log
//       shows the call and the executor ran only after allow.
//   (b) deny blocks execution — the executor NEVER runs and the model receives
//       a denial.
//   (c) allow runs the executor; allow-with-rewrite runs it on the REWRITTEN
//       input.
//   (d) no CLAUDE_SDK_CAN_USE_TOOL_SHADOWED warning (gate not shadowed).
//
// Prints PASS/FAIL per sub-assertion with evidence; exits non-zero on any FAIL.

import { ClaudeAgentSdkEngine } from '../engines/claude-agent-sdk-engine.js';
import type { EngineEvent, ModelSelection } from '../runtime/engine.js';
import { makeGate, scriptedPolicy, type MakeGateResult } from '../runtime/gate.js';
import { MemoryStore } from '../runtime/memory.js';
import { runTurn } from '../runtime/session.js';
import { buildToolset, Outbox } from '../runtime/tools.js';

const MODEL: ModelSelection = { providerId: 'anthropic-dev-oauth' };
const PROMPT_SEND =
  "Use the send_message tool to send the text 'hi' to alice. " +
  'You must call the send_message tool exactly once. Do not ask for confirmation.';

type Check = { name: string; pass: boolean; evidence: string };

function record(
  checks: Check[],
  name: string,
  pass: boolean,
  evidence: string,
): void {
  checks.push({ name, pass, evidence });
}

/** Run one send_message turn on the dev engine under a given gate. */
async function runSendTurn(gate: MakeGateResult): Promise<{
  events: EngineEvent[];
  outbox: Outbox;
  engine: ClaudeAgentSdkEngine;
}> {
  const store = new MemoryStore();
  const outbox = new Outbox();
  const { toolSchemas, executors } = buildToolset(outbox);
  const engine = new ClaudeAgentSdkEngine();
  const sessionId = `spike03-${Math.random().toString(36).slice(2)}`;
  const events = await runTurn({
    engine,
    store,
    sessionId,
    model: MODEL,
    userText: PROMPT_SEND,
    toolSchemas,
    executors,
    gate: gate.gate,
  });
  return { events, outbox, engine };
}

function toolResultEvents(events: EngineEvent[]) {
  return events.filter((e) => e.kind === 'tool_result');
}
function gateResultEvents(events: EngineEvent[]) {
  return events.filter((e) => e.kind === 'gate_result');
}
function hasAuthError(events: EngineEvent[]): EngineEvent | undefined {
  return events.find(
    (e) =>
      e.kind === 'error' &&
      (e.code === 'authentication_failed' ||
        /auth|oauth|login|credential/i.test(e.message)),
  );
}

async function main(): Promise<void> {
  const checks: Check[] = [];

  // ---- Scenario 1: ALLOW ------------------------------------------------
  // Gate allows send_message. Expect: gate saw the call before the executor;
  // executor ran; a message landed in the outbox.
  const allowGate = makeGate(scriptedPolicy({ send_message: { behavior: 'allow' } }));
  const allow = await runSendTurn(allowGate);

  const authErr = hasAuthError(allow.events);
  if (authErr && allowGate.log.length === 0) {
    // A genuine auth failure with no model activity — print the diagnostic and
    // fail loudly, but do NOT set an API key.
    console.error(
      '\nDIAGNOSTIC: the dev engine could not reach the model on local OAuth.',
    );
    console.error(
      '  Message:',
      authErr.kind === 'error' ? authErr.message : '(unknown)',
    );
    console.error(
      '  Fix: run `claude` once to log in with OAuth. Do NOT set ANTHROPIC_API_KEY.',
    );
    console.error(
      '  stderr tail:',
      allow.engine.diagnostics.stderr.slice(-5).join(' | ') || '(none)',
    );
  }

  const allowGateCalls = allowGate.log.filter((e) => e.toolName === 'send_message');
  const allowExec = toolResultEvents(allow.events).filter(
    (e) => e.kind === 'tool_result' && e.toolName === 'send_message',
  );

  // (a) gate saw the call BEFORE the executor ran.
  const gateSawCall = allowGateCalls.length >= 1;
  let executedAfterAllow = false;
  if (gateSawCall && allow.outbox.size >= 1) {
    const gateAt = allowGateCalls[0]!.at;
    const sentAt = allow.outbox.all()[0]!.at;
    executedAfterAllow = sentAt >= gateAt;
  }
  record(
    checks,
    '(a) tool call surfaced to the gate BEFORE it executes',
    gateSawCall && allow.outbox.size >= 1 && executedAfterAllow,
    `gate saw ${allowGateCalls.length} send_message call(s); outbox=${allow.outbox.size}; ` +
      `executor ran at/after gate approval=${executedAfterAllow}`,
  );

  // (c-part1) allow ran the executor.
  record(
    checks,
    '(c) allow runs the executor',
    allowExec.length >= 1 && allow.outbox.size >= 1,
    `tool_result events=${allowExec.length}; outbox="${
      allow.outbox.size ? JSON.stringify(allow.outbox.all()[0]) : 'empty'
    }"`,
  );

  // (d) no shadow warning under the allow run (gate not shadowed).
  record(
    checks,
    '(d) no CLAUDE_SDK_CAN_USE_TOOL_SHADOWED (gate not shadowed)',
    allow.engine.diagnostics.shadowWarningSeen === false,
    `shadowWarningSeen=${allow.engine.diagnostics.shadowWarningSeen}`,
  );

  // ---- Scenario 2: DENY -------------------------------------------------
  // Gate denies send_message. Expect: gate saw the call; executor NEVER ran;
  // outbox stays empty; a gate_result 'deny' is present.
  const denyGate = makeGate(
    scriptedPolicy({
      send_message: { behavior: 'deny', reason: 'blocked by spike policy' },
    }),
  );
  const deny = await runSendTurn(denyGate);
  const denyGateCalls = denyGate.log.filter((e) => e.toolName === 'send_message');
  const denyGateResults = gateResultEvents(deny.events).filter(
    (e) => e.kind === 'gate_result' && e.decision === 'deny',
  );

  record(
    checks,
    '(b) deny blocks execution — executor NEVER runs',
    denyGateCalls.length >= 1 && deny.outbox.size === 0 && denyGateResults.length >= 1,
    `gate saw ${denyGateCalls.length} call(s); outbox=${deny.outbox.size} (must be 0); ` +
      `deny gate_result events=${denyGateResults.length}`,
  );

  // ---- Scenario 3: ALLOW WITH REWRITE ----------------------------------
  // Gate allows but REWRITES the outgoing text to a fixed sentinel. Expect: the
  // executor ran on the REWRITTEN input, so the outbox holds the sentinel, not
  // whatever the model asked to send.
  const SENTINEL = 'REWRITTEN-BY-GATE';
  const rewriteGate = makeGate(
    scriptedPolicy({
      send_message: {
        behavior: 'allow',
        rewriteInput: (input) => {
          const rec =
            input && typeof input === 'object'
              ? (input as Record<string, unknown>)
              : {};
          return { to: rec.to ?? 'alice', text: SENTINEL };
        },
      },
    }),
  );
  const rewrite = await runSendTurn(rewriteGate);
  const sent = rewrite.outbox.all()[0];
  const ranOnRewritten = !!sent && sent.text === SENTINEL;
  record(
    checks,
    '(c) allow-with-rewrite runs the executor on the REWRITTEN input',
    ranOnRewritten,
    `outbox[0]=${sent ? JSON.stringify(sent) : 'empty'} (text must equal "${SENTINEL}")`,
  );

  // No shadow warning on the deny/rewrite runs either.
  record(
    checks,
    '(d) no shadow warning across deny + rewrite runs',
    deny.engine.diagnostics.shadowWarningSeen === false &&
      rewrite.engine.diagnostics.shadowWarningSeen === false,
    `deny.shadow=${deny.engine.diagnostics.shadowWarningSeen}, rewrite.shadow=${rewrite.engine.diagnostics.shadowWarningSeen}`,
  );

  // ---- Report -----------------------------------------------------------
  console.log('\n=== SPIKE-03 — gate soundness on ClaudeAgentSdkEngine ===\n');
  let allPass = true;
  for (const c of checks) {
    const tag = c.pass ? 'PASS' : 'FAIL';
    if (!c.pass) allPass = false;
    console.log(`[${tag}] ${c.name}`);
    console.log(`        evidence: ${c.evidence}`);
  }
  console.log(
    `\nSPIKE-03: ${allPass ? 'ALL PASS' : 'FAILURES PRESENT'} (${
      checks.filter((c) => c.pass).length
    }/${checks.length})\n`,
  );

  if (!allPass) process.exit(1);
}

main().catch((e) => {
  console.error('SPIKE-03 crashed:', e);
  process.exit(1);
});
