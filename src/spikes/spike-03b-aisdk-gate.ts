// src/spikes/spike-03b-aisdk-gate.ts
//
// SPIKE-03b — gate soundness on the PRODUCTION engine (AiSdkEngine, `ai` v7).
//
// NO NETWORK, NO KEYS. The model is `MockLanguageModelV4` from `ai/test`,
// scripted to emit a `send_message` tool call and then a final text. Everything
// below the model is the real production path: the real AiSdkEngine loop, the
// real runtime gate, the real runtime executors, the real session store.
//
// Asserted, by execution (contract §3):
//
//   (a) the tool call is surfaced to OUR gate BEFORE it executes.
//   (b) deny blocks execution — the executor NEVER runs, and a denial result is
//       fed back to the model (verified in the NEXT model call's prompt).
//   (c) allow runs the executor; allow-with-rewrite runs it on the REWRITTEN
//       input.
//   (d) nothing auto-executes — with execute-less tools the SDK returns the
//       call to us: its own `toolResults` are empty across every step, and the
//       tool result the model receives is the one OUR executor produced.
//   (e) the loop terminates normally when the model stops emitting tool calls,
//       and the iteration cap raises a clean error on a pathological model that
//       loops forever.
//
// Prints PASS/FAIL per assertion with evidence; exits non-zero on any FAIL.

import type {
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
} from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import { AiSdkEngine } from '../engines/ai-sdk-engine.js';
import type { EngineEvent, ModelSelection } from '../runtime/engine.js';
import { makeGate, scriptedPolicy, type MakeGateResult } from '../runtime/gate.js';
import { MemoryStore } from '../runtime/memory.js';
import { runTurn } from '../runtime/session.js';
import { buildToolset, Outbox } from '../runtime/tools.js';

const MODEL: ModelSelection = { providerId: 'mock-provider', model: 'mock-model-id' };
const PROMPT = "Send 'hi' to alice using the send_message tool.";
const MAX_STEPS = 4; // small cap so the pathological case finishes fast

type Check = { name: string; pass: boolean; evidence: string };

function record(checks: Check[], name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

// ---------------------------------------------------------------------------
// Scripted mock model results
// ---------------------------------------------------------------------------

const ZERO_USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function toolCallStep(
  toolCallId: string,
  input: Record<string, unknown>,
): LanguageModelV4GenerateResult {
  return {
    content: [
      {
        type: 'tool-call',
        toolCallId,
        toolName: 'send_message',
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: 'tool-calls', raw: 'tool_use' },
    usage: ZERO_USAGE,
    warnings: [],
  };
}

function finalTextStep(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'end_turn' },
    usage: ZERO_USAGE,
    warnings: [],
  };
}

/** One send_message call, then a final text. The normal, terminating script. */
function scriptedModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: [
      toolCallStep('call-1', { to: 'alice', text: 'hi' }),
      finalTextStep('Done — the message step is complete.'),
    ],
  });
}

/** Pathological: ALWAYS asks for another tool call. Must hit the cap. */
function runawayModel(): MockLanguageModelV4 {
  let n = 0;
  return new MockLanguageModelV4({
    doGenerate: async (): Promise<LanguageModelV4GenerateResult> =>
      toolCallStep(`runaway-${n++}`, { to: 'alice', text: `loop ${n}` }),
  });
}

// ---------------------------------------------------------------------------
// Prompt inspection — what the MODEL actually received on a later step.
// ---------------------------------------------------------------------------

/** Every tool-result text the model saw in this prompt. */
function toolResultTexts(prompt: LanguageModelV4Prompt): string[] {
  const out: string[] = [];
  for (const m of prompt) {
    if (m.role !== 'tool') continue;
    for (const part of m.content) {
      if (part.type !== 'tool-result') continue;
      const o = part.output;
      if (o.type === 'text' || o.type === 'error-text') out.push(o.value);
      else if (o.type === 'execution-denied') out.push(`denied: ${o.reason ?? ''}`);
      else out.push(JSON.stringify(o));
    }
  }
  return out;
}

function promptOf(
  calls: LanguageModelV4CallOptions[],
  index: number,
): LanguageModelV4Prompt {
  return calls[index]?.prompt ?? [];
}

// ---------------------------------------------------------------------------
// Harness — one turn on the production engine with a mock model.
// ---------------------------------------------------------------------------

type TurnResult = {
  events: EngineEvent[];
  outbox: Outbox;
  engine: AiSdkEngine;
  model: MockLanguageModelV4;
};

async function runTurnWith(
  gate: MakeGateResult,
  model: MockLanguageModelV4,
): Promise<TurnResult> {
  const store = new MemoryStore();
  const outbox = new Outbox();
  const { toolSchemas, executors } = buildToolset(outbox);
  // The engine gets an ALREADY-CONSTRUCTED model. No key is read anywhere in
  // this spike — the provider registry is the only key-reading seam and it is
  // deliberately not exercised here (SPIKE-05 does that with real credentials).
  const engine = new AiSdkEngine({ resolveModel: () => model, maxSteps: MAX_STEPS });
  const events = await runTurn({
    engine,
    store,
    sessionId: `spike03b-${Math.random().toString(36).slice(2)}`,
    model: MODEL,
    userText: PROMPT,
    toolSchemas,
    executors,
    gate: gate.gate,
  });
  return { events, outbox, engine, model };
}

const ev = {
  toolResults: (events: EngineEvent[]) => events.filter((e) => e.kind === 'tool_result'),
  gateResults: (events: EngineEvent[]) => events.filter((e) => e.kind === 'gate_result'),
  toolRequests: (events: EngineEvent[]) =>
    events.filter((e) => e.kind === 'tool_request'),
  errors: (events: EngineEvent[]) => events.filter((e) => e.kind === 'error'),
  results: (events: EngineEvent[]) => events.filter((e) => e.kind === 'result'),
};

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const checks: Check[] = [];

  // ==== Scenario 1: ALLOW ==================================================
  const allowGate = makeGate(scriptedPolicy({ send_message: { behavior: 'allow' } }));
  const allow = await runTurnWith(allowGate, scriptedModel());

  const allowGateCalls = allowGate.log.filter((e) => e.toolName === 'send_message');
  const allowToolResults = ev
    .toolResults(allow.events)
    .filter((e) => e.kind === 'tool_result' && e.toolName === 'send_message');

  // (a) the gate saw the call, and the executor ran only AFTER approval.
  let executedAfterAllow = false;
  if (allowGateCalls.length >= 1 && allow.outbox.size >= 1) {
    executedAfterAllow = allow.outbox.all()[0]!.at >= allowGateCalls[0]!.at;
  }
  // The request event must precede the gate_result, which must precede the
  // tool_result — the ordering the gate contract depends on.
  const allowOrder = allow.events.map((e) => e.kind);
  const orderOk =
    allowOrder.indexOf('tool_request') >= 0 &&
    allowOrder.indexOf('tool_request') < allowOrder.indexOf('gate_result') &&
    allowOrder.indexOf('gate_result') < allowOrder.indexOf('tool_result');

  record(
    checks,
    '(a) tool call surfaced to OUR gate BEFORE it executes',
    allowGateCalls.length === 1 && allow.outbox.size === 1 && executedAfterAllow && orderOk,
    `gate saw ${allowGateCalls.length} send_message call(s); outbox=${allow.outbox.size}; ` +
      `executor ran at/after approval=${executedAfterAllow}; ` +
      `event order tool_request<gate_result<tool_result=${orderOk} [${allowOrder.join('>')}]`,
  );

  // (c-1) allow runs the executor.
  record(
    checks,
    '(c) allow runs the executor',
    allowToolResults.length === 1 &&
      allow.outbox.size === 1 &&
      allow.engine.diagnostics.executorsRun.join(',') === 'send_message',
    `tool_result events=${allowToolResults.length}; executorsRun=[${allow.engine.diagnostics.executorsRun.join(
      ',',
    )}]; outbox[0]=${JSON.stringify(allow.outbox.all()[0] ?? null)}`,
  );

  // (d) nothing auto-executed. The SDK's OWN toolResults must be empty on every
  // step, and the tool result the model received on step 2 must be the receipt
  // OUR executor produced.
  const d1 = allow.engine.diagnostics;
  const sdkExecutedNothing =
    d1.sdkToolResultCounts.every((n) => n === 0) &&
    d1.sdkToolMessageCounts.every((n) => n === 0);
  const step2Results = toolResultTexts(promptOf(allow.model.doGenerateCalls, 1));
  const modelSawOurReceipt =
    step2Results.length === 1 && step2Results[0]!.startsWith('sent to alice: "hi"');

  record(
    checks,
    "(d) nothing auto-executes — the SDK returns the call to us (its own toolResults empty)",
    sdkExecutedNothing && modelSawOurReceipt && d1.steps === 2,
    `SDK toolResults per step=[${d1.sdkToolResultCounts.join(',')}] (all must be 0); ` +
      `SDK tool messages per step=[${d1.sdkToolMessageCounts.join(',')}]; ` +
      `steps=${d1.steps}; model saw exactly our executor's receipt=${modelSawOurReceipt} ` +
      `(${JSON.stringify(step2Results)})`,
  );

  // (e-1) the loop terminates normally once the model stops calling tools.
  const allowResults = ev.results(allow.events);
  const terminatedCleanly =
    allowResults.length === 1 &&
    allowResults[0]!.kind === 'result' &&
    allowResults[0]!.ok === true &&
    ev.errors(allow.events).length === 0;

  record(
    checks,
    '(e) loop terminates normally when the model stops emitting tool calls',
    terminatedCleanly && d1.steps === 2 && d1.maxStepsExceeded === false,
    `result events=${allowResults.length} ok=${
      allowResults[0]?.kind === 'result' ? allowResults[0].ok : 'n/a'
    }; errors=${ev.errors(allow.events).length}; steps=${d1.steps}; ` +
      `maxStepsExceeded=${d1.maxStepsExceeded}; ` +
      `usage=${JSON.stringify(
        allowResults[0]?.kind === 'result' ? allowResults[0].usage : null,
      )}`,
  );

  // ==== Scenario 2: DENY ===================================================
  const DENY_REASON = 'blocked by spike policy';
  const denyGate = makeGate(
    scriptedPolicy({ send_message: { behavior: 'deny', reason: DENY_REASON } }),
  );
  const deny = await runTurnWith(denyGate, scriptedModel());

  const denyGateCalls = denyGate.log.filter((e) => e.toolName === 'send_message');
  const denyDecisions = ev
    .gateResults(deny.events)
    .filter((e) => e.kind === 'gate_result' && e.decision === 'deny');
  const denyExecuted = deny.engine.diagnostics.executorsRun;

  // The denial must actually reach the model: check step 2's prompt.
  const denyStep2 = toolResultTexts(promptOf(deny.model.doGenerateCalls, 1));
  const denialFedBack =
    denyStep2.length === 1 && denyStep2[0]!.includes(DENY_REASON);

  record(
    checks,
    '(b) deny blocks execution — executor NEVER runs, denial fed back to the model',
    denyGateCalls.length === 1 &&
      deny.outbox.size === 0 &&
      denyExecuted.length === 0 &&
      denyDecisions.length === 1 &&
      denialFedBack &&
      ev.toolResults(deny.events).length === 0,
    `gate saw ${denyGateCalls.length} call(s); outbox=${deny.outbox.size} (must be 0); ` +
      `executorsRun=[${denyExecuted.join(',')}] (must be empty); ` +
      `deny gate_result events=${denyDecisions.length}; ` +
      `tool_result events=${ev.toolResults(deny.events).length} (must be 0); ` +
      `model received denial=${denialFedBack} (${JSON.stringify(denyStep2)})`,
  );

  // (d) holds under deny too: the SDK executed nothing on its own.
  const d2 = deny.engine.diagnostics;
  record(
    checks,
    '(d) nothing auto-executes under deny either',
    d2.sdkToolResultCounts.every((n) => n === 0) &&
      d2.sdkToolMessageCounts.every((n) => n === 0) &&
      deny.outbox.size === 0,
    `SDK toolResults per step=[${d2.sdkToolResultCounts.join(',')}]; ` +
      `SDK tool messages per step=[${d2.sdkToolMessageCounts.join(',')}]; outbox=${deny.outbox.size}`,
  );

  // ==== Scenario 3: ALLOW WITH REWRITE ====================================
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
  const rewrite = await runTurnWith(rewriteGate, scriptedModel());
  const sent = rewrite.outbox.all()[0];
  // The model originally asked to send 'hi'; the gate rewrote it. The executor
  // must have run on the REWRITTEN input, and the model must see the rewritten
  // receipt — no window exists in which the input could change back.
  const gateSawOriginal =
    JSON.stringify(rewriteGate.log[0]?.input) ===
    JSON.stringify({ to: 'alice', text: 'hi' });
  const rewriteStep2 = toolResultTexts(promptOf(rewrite.model.doGenerateCalls, 1));
  const modelSawRewritten =
    rewriteStep2.length === 1 && rewriteStep2[0]!.includes(SENTINEL);

  record(
    checks,
    '(c) allow-with-rewrite runs the executor on the REWRITTEN input',
    !!sent &&
      sent.text === SENTINEL &&
      gateSawOriginal &&
      rewrite.outbox.size === 1 &&
      modelSawRewritten,
    `gate saw the model's ORIGINAL input=${gateSawOriginal} (${JSON.stringify(
      rewriteGate.log[0]?.input,
    )}); outbox[0]=${JSON.stringify(sent ?? null)} (text must equal "${SENTINEL}"); ` +
      `model saw the rewritten receipt=${modelSawRewritten}`,
  );

  // ==== Scenario 4: ITERATION CAP =========================================
  // A pathological model that never stops calling tools must be stopped by OUR
  // bound with a clean, surfaced error — not spin forever.
  const capGate = makeGate(scriptedPolicy({ send_message: { behavior: 'allow' } }));
  const cap = await runTurnWith(capGate, runawayModel());
  const capErrors = ev
    .errors(cap.events)
    .filter((e) => e.kind === 'error' && e.code === 'MAX_STEPS_EXCEEDED');
  const capResults = ev.results(cap.events);
  const capOk =
    capErrors.length === 1 &&
    cap.engine.diagnostics.maxStepsExceeded === true &&
    cap.engine.diagnostics.steps === MAX_STEPS &&
    capResults.length === 1 &&
    capResults[0]!.kind === 'result' &&
    capResults[0]!.ok === false;

  record(
    checks,
    '(e) iteration cap raises a clean error on a model that loops forever',
    capOk,
    `MAX_STEPS_EXCEEDED errors=${capErrors.length}; steps=${cap.engine.diagnostics.steps}/${MAX_STEPS}; ` +
      `maxStepsExceeded=${cap.engine.diagnostics.maxStepsExceeded}; ` +
      `final result ok=${capResults[0]?.kind === 'result' ? capResults[0].ok : 'n/a'} (must be false); ` +
      `gate consulted ${capGate.log.length} time(s) — every step still went through the gate`,
  );

  // ==== Report =============================================================
  console.log('\n=== SPIKE-03b — gate soundness on AiSdkEngine (mock model, no keys) ===\n');
  let allPass = true;
  for (const c of checks) {
    const tag = c.pass ? 'PASS' : 'FAIL';
    if (!c.pass) allPass = false;
    console.log(`[${tag}] ${c.name}`);
    console.log(`        evidence: ${c.evidence}`);
  }
  console.log(
    `\nSPIKE-03b: ${allPass ? 'ALL PASS' : 'FAILURES PRESENT'} (${
      checks.filter((c) => c.pass).length
    }/${checks.length})\n`,
  );

  if (!allPass) process.exit(1);
}

main().catch((e) => {
  console.error('SPIKE-03b crashed:', e);
  process.exit(1);
});
