// src/spikes/spike-bg-agent-tools.ts
//
// LIVE: a background subagent can still use tools after the main turn's first
// `result` (field case 2026-10-02).
//
// The SDK closes the CLI's stdin at the first `result`. Every PreToolUse hook is a
// control round trip over that stdin, so a background agent that called a tool
// after the main turn ended was refused within milliseconds — with the CLI's
// "The user doesn't want to take this action right now" text, although nobody was
// asked. The engine now keeps the input open until the session reports `idle`.
//
// This drives the REAL engine against a real sign-in: the main agent launches a
// background agent and ends its turn at once; the background agent then searches.
// Pass = the background WebSearch reached the gate and was not refused, and the run
// still ended on its own.
//
// Run: npm run spike:bg-agent-tools   (costs a few cents of subscription usage)

import { ClaudeAgentSdkEngine } from '../engines/claude-agent-sdk-engine.js';
import type { EngineEvent, ModelSelection } from '../runtime/engine.js';
import { makeGate, scriptedPolicy } from '../runtime/gate.js';
import { MemoryStore } from '../runtime/store/memory-store.js';
import { runTurn } from '../runtime/session.js';

const MODEL: ModelSelection = { providerId: 'anthropic-dev-oauth', model: 'sonnet' };
const PROMPT =
  'Use the Agent tool exactly once with run_in_background set to true and subagent_type ' +
  '"general-purpose". The subagent\'s task: "Call WebSearch once for the query ' +
  '\'Anthropic Claude Agent SDK\' and reply with the title of the first result." ' +
  'Do not wait for the subagent and do not do anything else: as soon as it is launched, ' +
  'reply with the single word "launched" and end your turn. When its result arrives later, ' +
  'reply with that title.';
const RUN_LIMIT_MS = 240_000;
const REFUSAL = "doesn't want to take this action";

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
const record = (name: string, pass: boolean, evidence: string): void => {
  checks.push({ name, pass, evidence });
};

async function main(): Promise<boolean> {
  const gateCalls: { name: string; subagent: boolean; at: number }[] = [];
  const base = makeGate(scriptedPolicy({}));
  const gate: typeof base.gate = async (call) => {
    gateCalls.push({ name: call.toolName, subagent: call.subagent !== undefined, at: Date.now() });
    return { behavior: 'allow' };
  };

  const startedAt = Date.now();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), RUN_LIMIT_MS);
  const resultAt: number[] = [];
  const events: EngineEvent[] = await runTurn({
    engine: new ClaudeAgentSdkEngine(),
    store: new MemoryStore(),
    sessionId: `spike-bg-${Math.random().toString(36).slice(2)}`,
    model: MODEL,
    userText: PROMPT,
    toolSchemas: [],
    executors: {},
    gate,
    signal: timeout.signal,
    onEvent: (ev) => {
      if (ev.kind === 'result') resultAt.push(Date.now() - startedAt);
    },
  });
  clearTimeout(timer);
  const elapsed = Date.now() - startedAt;

  const refused = events.filter(
    (e) =>
      e.kind === 'tool_result' &&
      JSON.stringify(e.output).includes(REFUSAL),
  );
  const subagentSearches = gateCalls.filter((c) => c.name === 'WebSearch' && c.subagent);
  const firstResult = resultAt[0];

  record(
    'the background agent\'s WebSearch reached the gate',
    subagentSearches.length > 0,
    `gate calls = ${JSON.stringify(gateCalls.map((c) => `${c.name}${c.subagent ? '(sub)' : ''}@${c.at - startedAt}ms`))}`,
  );
  record(
    'no tool call was refused with the CLI\'s "user doesn\'t want" text',
    refused.length === 0,
    `refused = ${refused.length}`,
  );
  record(
    'the search ran AFTER the main turn\'s first result (the case that used to fail)',
    firstResult !== undefined &&
      subagentSearches.some((c) => c.at - startedAt > firstResult),
    `results at ${JSON.stringify(resultAt)}ms`,
  );
  record(
    'the run ended on its own, not by the spike\'s time limit',
    !timeout.signal.aborted,
    `elapsed = ${elapsed}ms, limit = ${RUN_LIMIT_MS}ms`,
  );

  console.log('=== SPIKE-BG-AGENT-TOOLS (live) ===');
  for (const c of checks) {
    console.log(`[${c.pass ? 'PASS' : 'FAIL'}] ${c.name}\n        evidence: ${c.evidence}`);
  }
  const ok = checks.every((c) => c.pass);
  console.log(`SPIKE-BG-AGENT-TOOLS: ${ok ? 'ALL PASS' : 'FAILURES PRESENT'} (${checks.filter((c) => c.pass).length}/${checks.length})`);
  return ok;
}

main().then(
  (ok) => process.exit(ok ? 0 : 1),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
