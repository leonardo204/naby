// src/spikes/spike-rate-limit.ts
//
// THE SUBSCRIPTION LIMIT PASSES THROUGH THE TURN LOOP AND CHANGES NOTHING
// (specs/claude-multi-account.md §3.3, §4.3).
//
// WHAT THIS IS ABOUT. `rate_limit` is a new first-class `EngineEvent`, and it is
// the first one to arrive carrying NUMBERS that are not about the conversation.
// That is exactly what makes it tempting to treat as data: to store it, to show
// it in the transcript, to stop a long autonomous run when the account is nearly
// out. The contract says it is OBSERVATIONAL — the same rule `harness` has, for
// the same two reasons:
//
//   * PERSISTING IT would put an account's billing state into a transcript that
//     must replay identically on an engine that has no subscription at all.
//     `RuntimeMessage` has a closed three-variant contract with no system role,
//     so there is not even a shape for it to become.
//   * BRANCHING ON IT would make a run's length depend on a signal only one
//     backend emits, which is the provider-independence the seam exists for.
//
// A comment cannot enforce either one. So this drives the REAL `runTurn` twice
// over a scripted engine — once with limit events interleaved through the turn,
// once without a single one — and asserts the two runs leave byte-for-byte
// identical state behind. Anything that ever starts reading this event breaks
// that equality.
//
// NO NETWORK, NO KEYS, NO SDK PROCESS, NO DATABASE. The engine is scripted and
// the store is `MemoryStore`, so the real `~/.naby/app.db` is never opened.
//
// Prints PASS/FAIL per assertion; exits non-zero on any FAIL.

import { describeRateLimit } from '../engines/claude-agent-sdk-engine.js';
import type { Engine, EngineEvent, RuntimeMessage } from '../runtime/engine.js';
import { makeGate, scriptedPolicy } from '../runtime/gate.js';
import { runTurn } from '../runtime/session.js';
import { MemoryStore } from '../runtime/store/memory-store.js';

type Check = { name: string; pass: boolean; evidence: string };

const checks: Check[] = [];
function record(name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

/** The event as actually observed on a live turn — the same fixture the shell's
 *  unit tests use. `resetsAt` is UNIX SECONDS and there is no `utilization`. */
const OBSERVED_SDK_MESSAGE = {
  type: 'rate_limit_event',
  uuid: '00000000-0000-0000-0000-000000000000',
  session_id: 'observed',
  rate_limit_info: {
    status: 'allowed',
    resetsAt: 1_786_426_200,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    overageDisabledReason: 'org_level_disabled',
    isUsingOverage: false,
  },
};

/** An engine that replays a fixed script. The point of the spike is what the
 *  RUNTIME does with the events, so the producer is as dumb as possible. */
function scriptedEngine(script: readonly EngineEvent[]): Engine {
  return {
    async *run(): AsyncIterable<EngineEvent> {
      for (const ev of script) yield ev;
    },
  };
}

/** The turn, minus the limit events. */
const BASE_SCRIPT: readonly EngineEvent[] = [
  { kind: 'init', providerId: 'scripted', model: 'scripted-1' },
  { kind: 'text', role: 'assistant', text: 'The store lives in the runtime.' },
  { kind: 'result', ok: true, usage: { inputTokens: 120, outputTokens: 8 }, costUsd: 0.001 },
];

async function runScript(
  script: readonly EngineEvent[],
): Promise<{ seen: EngineEvent[]; messages: RuntimeMessage[]; returned: EngineEvent[] }> {
  const store = new MemoryStore();
  const { sessionId } = store.createSession('scripted', 'spike-rate-limit');
  const gate = makeGate(scriptedPolicy({}));
  const seen: EngineEvent[] = [];
  const returned = await runTurn({
    engine: scriptedEngine(script),
    store,
    sessionId,
    model: { providerId: 'scripted', model: 'scripted-1' },
    userText: 'Where should the session store live?',
    toolSchemas: [],
    executors: {},
    gate: gate.gate,
    onEvent: (ev) => seen.push(ev),
  });
  return { seen, messages: store.getMessages(sessionId), returned };
}

async function main(): Promise<void> {
  // The runtime event, produced by the SAME pure function the engine's driver
  // calls — so this spike asserts the shape that actually ships, not a
  // hand-written approximation of it.
  const limit = describeRateLimit(OBSERVED_SDK_MESSAGE);

  record(
    'the observed SDK message becomes a rate_limit event',
    limit !== null && limit.kind === 'rate_limit' && limit.status === 'allowed',
    JSON.stringify(limit),
  );

  record(
    'resetsAt crosses unconverted, in UNIX seconds',
    // 1786426200s is 2026-08-11T05:30Z. Read as milliseconds it would be January
    // 1970 and the countdown would render empty; neither error throws.
    limit?.resetsAt === 1_786_426_200 &&
      new Date((limit?.resetsAt ?? 0) * 1000).toISOString() === '2026-08-11T05:30:00.000Z',
    `resetsAt=${limit?.resetsAt}`,
  );

  record(
    'no utilization is invented when the backend sends none',
    limit !== null && !('utilization' in limit),
    `keys=${Object.keys(limit ?? {}).join(',')}`,
  );

  if (!limit) {
    report();
    return;
  }

  // A turn with the limit reported three times — before the answer, between the
  // answer and the result, and after the result — because a real backend emits it
  // whenever its information changes, not on a turn boundary.
  const withLimit: readonly EngineEvent[] = [
    BASE_SCRIPT[0] as EngineEvent,
    limit,
    BASE_SCRIPT[1] as EngineEvent,
    { ...limit, status: 'allowed_warning' as const, utilization: 0.83 },
    BASE_SCRIPT[2] as EngineEvent,
    { ...limit, status: 'rejected' as const },
  ];

  const withRun = await runScript(withLimit);
  const withoutRun = await runScript(BASE_SCRIPT);

  // ---- 1. It reaches the streaming caller ---------------------------------
  const streamed = withRun.seen.filter((e) => e.kind === 'rate_limit');
  record(
    'every limit reading reaches the streaming caller',
    streamed.length === 3,
    `onEvent saw ${streamed.length} of 3`,
  );
  record(
    'the readings arrive in order, none collapsed',
    streamed.map((e) => (e.kind === 'rate_limit' ? e.status : '')).join(',') ===
      'allowed,allowed_warning,rejected',
    streamed.map((e) => (e.kind === 'rate_limit' ? e.status : '')).join(','),
  );
  record(
    'it is also in the events the turn returns',
    withRun.returned.filter((e) => e.kind === 'rate_limit').length === 3,
    `returned ${withRun.returned.filter((e) => e.kind === 'rate_limit').length}`,
  );

  // ---- 2. It changes NOTHING ----------------------------------------------
  // The load-bearing assertion. Not "the message count is the same" — the whole
  // stored transcript, compared literally.
  record(
    'the stored transcript is byte-for-byte what it would be without any limit event',
    JSON.stringify(withRun.messages) === JSON.stringify(withoutRun.messages),
    `with=${JSON.stringify(withRun.messages)} without=${JSON.stringify(withoutRun.messages)}`,
  );
  record(
    'no message was minted for it',
    // RuntimeMessage has no system role to put one in, and the three variants it
    // does have are the conversation itself.
    !JSON.stringify(withRun.messages).includes('rate_limit') &&
      !JSON.stringify(withRun.messages).includes('five_hour'),
    JSON.stringify(withRun.messages).slice(0, 200),
  );
  record(
    'the turn ends the same way — a rejection does not end or alter the run',
    JSON.stringify(withRun.returned.filter((e) => e.kind === 'result')) ===
      JSON.stringify(withoutRun.returned.filter((e) => e.kind === 'result')),
    JSON.stringify(withRun.returned.filter((e) => e.kind === 'result')),
  );
  record(
    'the non-limit event stream is otherwise identical',
    JSON.stringify(withRun.seen.filter((e) => e.kind !== 'rate_limit')) ===
      JSON.stringify(withoutRun.seen),
    `${withRun.seen.length - 3} vs ${withoutRun.seen.length}`,
  );

  report();
}

function report(): void {
  let failed = 0;
  for (const c of checks) {
    if (!c.pass) failed += 1;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}\n      ${c.evidence}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
