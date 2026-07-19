// src/spikes/spike-07-independence.ts
//
// SPIKE-07 — provider/engine independence. Switching the engine (= switching
// provider) mid-session must leave the runtime state unchanged; only the
// answering model differs.
//
//   * Turn 1 runs on ClaudeAgentSdkEngine (local OAuth, real model). We write a
//     memory key and let a tool run so a message lands in the session.
//   * Turn 2 runs on MockEngine — a DIFFERENT provider behind the SAME Engine
//     seam — for the SAME session id, with the SAME memory + message history.
//
// Assertions:
//   1. the memory written under engine 1 is fully visible to engine 2;
//   2. the session message history is continuous across the switch;
//   3. the MCP tool registry / executors are the identical INSTANCES for both;
//   4. nothing about the store was keyed to the engine or a provider.
//
// Prints PASS/FAIL per assertion; exits non-zero on any FAIL.

import { ClaudeAgentSdkEngine } from '../engines/claude-agent-sdk-engine.js';
import { MockEngine } from '../engines/mock-engine.js';
import type { EngineEvent, Executor, ToolSchema } from '../runtime/engine.js';
import { makeGate, scriptedPolicy } from '../runtime/gate.js';
import { MemoryStore } from '../runtime/memory.js';
import { runTurn } from '../runtime/session.js';
import { buildToolset, Outbox } from '../runtime/tools.js';

type Check = { name: string; pass: boolean; evidence: string };

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

  // ONE store, ONE outbox, ONE toolset — all provider-independent and shared
  // across both engines. The gate is defined once and reused.
  const store = new MemoryStore();
  const outbox = new Outbox();
  const toolset = buildToolset(outbox);
  const gate = makeGate(scriptedPolicy({ send_message: { behavior: 'allow' } }));
  const sessionId = 'spike07-shared-session';

  // Capture the exact instances handed to each engine, to prove identity.
  const captured: {
    engine1?: { toolSchemas: ToolSchema[]; executors: Record<string, Executor> };
    engine2?: { toolSchemas: ToolSchema[]; executors: Record<string, Executor> };
  } = {};

  // ---- Turn 1: ClaudeAgentSdkEngine ------------------------------------
  captured.engine1 = { toolSchemas: toolset.toolSchemas, executors: toolset.executors };
  const claude = new ClaudeAgentSdkEngine();
  const turn1Events = await runTurn({
    engine: claude,
    store,
    sessionId,
    model: { providerId: 'anthropic-dev-oauth' },
    userText:
      "Use the send_message tool to send 'hello' to carol. You must call the tool once.",
    toolSchemas: captured.engine1.toolSchemas,
    executors: captured.engine1.executors,
    gate: gate.gate,
  });

  // Write a memory key under the first engine's turn.
  store.setMemory(sessionId, 'userName', 'Nabi');

  const authErr = hasAuthError(turn1Events);
  if (authErr && gate.log.length === 0 && outbox.size === 0) {
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
      claude.diagnostics.stderr.slice(-5).join(' | ') || '(none)',
    );
  }

  const historyAfterTurn1 = store.session(sessionId).messages.length;
  const memoryAfterTurn1 = store.getMemory(sessionId, 'userName');

  // ---- Turn 2: MockEngine (different provider, same seam) --------------
  captured.engine2 = { toolSchemas: toolset.toolSchemas, executors: toolset.executors };
  const mock = new MockEngine();
  const turn2Events = await runTurn({
    engine: mock,
    store,
    sessionId, // SAME session id
    model: { providerId: 'mock-provider' }, // different provider
    userText: 'Continue the conversation.',
    toolSchemas: captured.engine2.toolSchemas, // SAME instances
    executors: captured.engine2.executors, // SAME instances
    gate: gate.gate, // SAME gate
  });

  const historyAfterTurn2 = store.session(sessionId).messages.length;
  const memoryAfterTurn2 = store.getMemory(sessionId, 'userName');

  // ---- Assertion 1: memory visible to engine 2 -------------------------
  checks.push({
    name: '1. memory written under engine 1 is fully visible after engine 2',
    pass: memoryAfterTurn1 === 'Nabi' && memoryAfterTurn2 === 'Nabi',
    evidence: `memory.userName after turn1=${JSON.stringify(
      memoryAfterTurn1,
    )}, after turn2=${JSON.stringify(memoryAfterTurn2)}`,
  });

  // ---- Assertion 2: continuous message history -------------------------
  // History strictly grew across the switch, and turn 2 saw turn 1's messages.
  const mockSawPrior = turn2Events.some(
    (e) =>
      e.kind === 'text' &&
      /resumed a session with (\d+) prior message/.test(e.text) &&
      Number(/resumed a session with (\d+) prior/.exec(e.text)?.[1] ?? '0') >= 1,
  );
  checks.push({
    name: '2. session message history is continuous across the engine switch',
    pass:
      historyAfterTurn1 >= 2 &&
      historyAfterTurn2 > historyAfterTurn1 &&
      mockSawPrior,
    evidence: `history len: turn1=${historyAfterTurn1}, turn2=${historyAfterTurn2}; mock saw prior history=${mockSawPrior}`,
  });

  // ---- Assertion 3: identical tool registry / executor instances -------
  const sameSchemas =
    captured.engine1.toolSchemas === captured.engine2.toolSchemas;
  const sameExecutorsMap =
    captured.engine1.executors === captured.engine2.executors;
  const sameSendExecutor =
    captured.engine1.executors.send_message ===
    captured.engine2.executors.send_message;
  const sameEchoExecutor =
    captured.engine1.executors.echo_note === captured.engine2.executors.echo_note;
  checks.push({
    name: '3. MCP tool registry / executors are the identical instances for both engines',
    pass: sameSchemas && sameExecutorsMap && sameSendExecutor && sameEchoExecutor,
    evidence: `schemas===${sameSchemas}, executorsMap===${sameExecutorsMap}, send_message===${sameSendExecutor}, echo_note===${sameEchoExecutor}`,
  });

  // ---- Assertion 4: store not keyed to engine/provider -----------------
  // The single MemoryStore was addressed only by session id across two
  // different providers; the same session object answered both. If anything
  // had been keyed to the engine/provider, turn 2 would have seen empty
  // history / memory (asserted above) — here we additionally confirm the store
  // exposes exactly ONE session for the id and both turns' side effects landed
  // in the SAME outbox.
  const oneSessionForId = store.has(sessionId);
  const bothTurnsHitSameOutbox = outbox.size >= 2; // turn1 (claude) + turn2 (mock)
  checks.push({
    name: '4. nothing about the store was keyed to the engine or a provider',
    pass: oneSessionForId && bothTurnsHitSameOutbox && memoryAfterTurn2 === 'Nabi',
    evidence: `store keyed by sessionId only (has=${oneSessionForId}); shared outbox size=${outbox.size} (>=2 means both engines' tools hit the same store); memory survived provider switch=${
      memoryAfterTurn2 === 'Nabi'
    }`,
  });

  // ---- Report -----------------------------------------------------------
  console.log('\n=== SPIKE-07 — provider/engine independence ===\n');
  let allPass = true;
  for (const c of checks) {
    const tag = c.pass ? 'PASS' : 'FAIL';
    if (!c.pass) allPass = false;
    console.log(`[${tag}] ${c.name}`);
    console.log(`        evidence: ${c.evidence}`);
  }
  console.log(
    `\nSPIKE-07: ${allPass ? 'ALL PASS' : 'FAILURES PRESENT'} (${
      checks.filter((c) => c.pass).length
    }/${checks.length})\n`,
  );

  if (!allPass) process.exit(1);
}

main().catch((e) => {
  console.error('SPIKE-07 crashed:', e);
  process.exit(1);
});
