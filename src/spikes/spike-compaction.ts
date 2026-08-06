// src/spikes/spike-compaction.ts
//
// ROLLING COMPACTION — verification (specs/session-context-management.md §2.3).
//
// The failure this feature prevents only appears on a conversation too long to
// reproduce by hand, and the failure it could CAUSE — a transcript quietly
// rewritten to fit a window — would be discovered months later by a user
// scrolling back. So both are asserted here, against the REAL AiSdkEngine driven
// by a mock model through the ordinary `resolveModel` seam, and against a REAL
// SqliteStore on a temp path. No network, no keys, no ~/.naby.
//
// Asserted:
//   (a) UNDER the threshold nothing is folded — the payload the model receives is
//       the whole conversation, and no summary is written.
//   (b) OVER the threshold the payload becomes [summary block + recent tail], it
//       is smaller than the raw history, and it stays under budget.
//   (c) THE STORED TRANSCRIPT IS UNTOUCHED — every message the store held before
//       the turn is still there, in order, byte for byte. This is the invariant
//       that outranks the feature.
//   (d) The summary is REUSED (no second summariser call) when the folded range
//       is unchanged, and EXTENDED when more turns fold.
//   (e) A failing summariser falls back to truncation: the turn still answers, the
//       model is told material is missing, a system pill is emitted, and NO
//       half-summary is persisted.
//   (f) The pure planner's own rules: the tail floor, and never splitting a tool
//       result from the call that produced it.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Before anything can construct a store: this spike must never see the real db.
const TMP_DIR = mkdtempSync(join(tmpdir(), 'naby-spike-compaction-'));
process.env.NABY_DB_PATH = join(TMP_DIR, 'app.db');

import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { AiSdkEngine } from '../engines/ai-sdk-engine.js';
import { FOLDED_BLOCK_HEADER, TRUNCATION_NOTICE, planFold } from '../runtime/compaction.js';
import { runTurn } from '../runtime/session.js';
import { SqliteStore } from '../runtime/store/sqlite-store.js';
import type { EngineEvent, RuntimeMessage } from '../runtime/engine.js';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

const USAGE = {
  inputTokens: { total: 1200, noCache: 1200, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

/** What one call saw, so the spike can read the payload the model was actually
 *  handed rather than trusting the engine's own account of it. */
type SeenCall = { system: string | undefined; texts: string[] };

/**
 * A mock model that records every prompt it is given.
 *
 * `gpt-4o` is named as the model id so the engine looks up a REAL window (128k)
 * from the registry — the point is to exercise the production budget path, not a
 * fallback.
 */
function recordingModel(opts: {
  /** What the summariser call answers. Empty string = a failed generation. */
  summary: string;
  /** Make the summariser call throw instead of answering. */
  summaryThrows?: boolean;
  seen: SeenCall[];
}): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId: 'gpt-4o',
    doGenerate: async (call: LanguageModelV4CallOptions) => {
      const texts: string[] = [];
      for (const m of call.prompt) {
        if (m.role === 'system') continue;
        if (typeof m.content === 'string') texts.push(m.content);
        else {
          for (const part of m.content as { type: string; text?: string }[]) {
            if (part.type === 'text' && part.text) texts.push(part.text);
          }
        }
      }
      const system = call.prompt.find((m) => m.role === 'system');
      const systemText =
        system && typeof system.content === 'string' ? system.content : undefined;
      // The summariser call is the one carrying the compaction system prompt.
      const isSummary = (systemText ?? '').startsWith('You compress a conversation');
      opts.seen.push({ system: systemText, texts });
      if (isSummary) {
        if (opts.summaryThrows) throw new Error('summariser is offline');
        return {
          content: [{ type: 'text', text: opts.summary }],
          finishReason: { unified: 'stop', raw: 'end_turn' },
          usage: USAGE,
          warnings: [],
        } as LanguageModelV4GenerateResult;
      }
      return {
        content: [{ type: 'text', text: 'ok.' }],
        finishReason: { unified: 'stop', raw: 'end_turn' },
        usage: USAGE,
        warnings: [],
      } as LanguageModelV4GenerateResult;
    },
  });
}

/** Fill a session with `pairs` user/assistant exchanges of `chars` characters
 *  each, written straight to the store (no model involved). */
function seed(store: SqliteStore, sessionId: string, pairs: number, chars: number): void {
  for (let i = 0; i < pairs; i += 1) {
    store.appendMessage(sessionId, { role: 'user', content: `Q${i} ${'가'.repeat(chars)}` });
    store.appendMessage(sessionId, { role: 'assistant', content: `A${i} ${'x'.repeat(chars)}` });
  }
}

/** The turn payload the model received on its LAST non-summary call. */
function lastTurnCall(seen: SeenCall[]): SeenCall | undefined {
  for (let i = seen.length - 1; i >= 0; i -= 1) {
    const c = seen[i]!;
    if (!(c.system ?? '').startsWith('You compress a conversation')) return c;
  }
  return undefined;
}

function summaryCalls(seen: SeenCall[]): SeenCall[] {
  return seen.filter((c) => (c.system ?? '').startsWith('You compress a conversation'));
}

const store = new SqliteStore({ path: join(TMP_DIR, 'app.db') });

// ---------------------------------------------------------------------------
// (a) under the threshold: nothing folds
// ---------------------------------------------------------------------------

{
  const seen: SeenCall[] = [];
  const s = store.createSession('mock');
  seed(store, s.sessionId, 3, 200);
  await runTurn({
    engine: new AiSdkEngine({ resolveModel: () => recordingModel({ summary: 'S', seen }) }),
    store,
    sessionId: s.sessionId,
    model: { providerId: 'mock', model: 'gpt-4o' },
    userText: 'and now?',
    toolSchemas: [],
    executors: {},
    gate: async () => ({ behavior: 'allow' }),
    engineId: 'ai-sdk',
  });
  const call = lastTurnCall(seen);
  const sawEveryTurn = [0, 1, 2].every((i) => call?.texts.some((t) => t.startsWith(`Q${i} `)));
  record(
    '(a) a short conversation is sent whole — no fold, no summariser call, nothing stored',
    sawEveryTurn === true &&
      summaryCalls(seen).length === 0 &&
      store.getSessionRollingSummary(s.sessionId) === undefined &&
      !call?.texts.some((t) => t.includes(FOLDED_BLOCK_HEADER)),
    `${call?.texts.length ?? 0} messages sent, ${summaryCalls(seen).length} summariser calls, stored summary=${String(
      store.getSessionRollingSummary(s.sessionId),
    )}`,
  );
}

// ---------------------------------------------------------------------------
// (b)+(c) over the threshold: fold the payload, never the transcript
// ---------------------------------------------------------------------------

const bigSession = store.createSession('mock');
// gpt-4o's window is 128k tokens; at ~3.5 chars/token the fold trips above ~90k
// tokens of history, so 120 exchanges of 3k characters is comfortably over.
seed(store, bigSession.sessionId, 120, 3000);
const before = store.getMessages(bigSession.sessionId);

{
  const seen: SeenCall[] = [];
  const events: EngineEvent[] = [];
  await runTurn({
    engine: new AiSdkEngine({
      resolveModel: () => recordingModel({ summary: 'AGREED: ship on Friday. OPEN: pricing.', seen }),
    }),
    store,
    sessionId: bigSession.sessionId,
    model: { providerId: 'mock', model: 'gpt-4o' },
    userText: 'where were we?',
    toolSchemas: [],
    executors: {},
    gate: async () => ({ behavior: 'allow' }),
    engineId: 'ai-sdk',
    onEvent: (ev) => events.push(ev),
  });

  const call = lastTurnCall(seen);
  const sent = call?.texts ?? [];
  const foldedBlock = sent.filter((t) => t.includes(FOLDED_BLOCK_HEADER));
  const carriesTail = sent.some((t) => t.startsWith('Q119 ')) && sent.some((t) => t === 'where were we?');
  const droppedOldest = !sent.some((t) => t.startsWith('Q0 '));
  const sentChars = sent.reduce((n, t) => n + t.length, 0);
  const rawChars = before.reduce(
    (n, m) => n + (m.role === 'tool' ? m.output.content.length : m.content.length),
    0,
  );
  record(
    '(b) the payload becomes [summary + recent tail], carries the newest turns, and is far smaller than the history',
    foldedBlock.length === 1 &&
      foldedBlock[0]!.includes('AGREED: ship on Friday') &&
      carriesTail &&
      droppedOldest &&
      sentChars < rawChars / 2,
    `${sent.length} messages sent (${sentChars} chars) vs ${before.length} stored (${rawChars} chars); summary blocks=${foldedBlock.length}; tail present=${carriesTail}; oldest dropped=${droppedOldest}`,
  );

  const pill = events.find(
    (e) => e.kind === 'harness' && e.subtype === 'context-compaction',
  ) as Extract<EngineEvent, { kind: 'harness' }> | undefined;
  record(
    '(b2) the user is told it happened — one system pill naming how many messages were folded',
    !!pill && /^folded:\d+$/.test(pill.detail ?? ''),
    `pill=${JSON.stringify(pill ?? null)}`,
  );

  // (c) THE INVARIANT. The turn appended its own user/assistant rows; everything
  // that was there before must still be there, unchanged and in order.
  const after = store.getMessages(bigSession.sessionId);
  const prefixIntact =
    after.length >= before.length &&
    before.every((m, i) => JSON.stringify(m) === JSON.stringify(after[i]));
  record(
    '(c) the STORED transcript is untouched — folding happened to the payload only',
    prefixIntact && after.length === before.length + 2,
    `stored ${before.length} before, ${after.length} after (turn adds its own 2); prefix identical=${prefixIntact}`,
  );

  const stored = store.getSessionRollingSummary(bigSession.sessionId);
  record(
    '(c2) the summary is persisted with the range it covers',
    !!stored && stored.text.includes('AGREED') && (stored.foldedCount ?? 0) > 0,
    JSON.stringify(stored ?? null),
  );
}

// ---------------------------------------------------------------------------
// (d) reuse when the range is unchanged, extend when it grows
// ---------------------------------------------------------------------------

{
  const seen: SeenCall[] = [];
  const storedBefore = store.getSessionRollingSummary(bigSession.sessionId);
  await runTurn({
    engine: new AiSdkEngine({
      resolveModel: () => recordingModel({ summary: 'SHOULD NOT BE CALLED', seen }),
    }),
    store,
    sessionId: bigSession.sessionId,
    model: { providerId: 'mock', model: 'gpt-4o' },
    userText: 'still there?',
    toolSchemas: [],
    executors: {},
    gate: async () => ({ behavior: 'allow' }),
    engineId: 'ai-sdk',
  });
  const call = lastTurnCall(seen);
  const storedAfter = store.getSessionRollingSummary(bigSession.sessionId);
  record(
    '(d) the stored summary is reused verbatim when the folded range has not grown — no second summariser call',
    summaryCalls(seen).length === 0 &&
      !!call?.texts.some((t) => t.includes('AGREED: ship on Friday')) &&
      storedAfter?.text === storedBefore?.text,
    `${summaryCalls(seen).length} summariser calls; stored text unchanged=${storedAfter?.text === storedBefore?.text}`,
  );

  // Grow the conversation so the fold boundary moves, and watch it EXTEND.
  seed(store, bigSession.sessionId, 40, 3000);
  const seen2: SeenCall[] = [];
  await runTurn({
    engine: new AiSdkEngine({
      resolveModel: () => recordingModel({ summary: 'AGREED: ship on Friday. ALSO: pricing settled.', seen: seen2 }),
    }),
    store,
    sessionId: bigSession.sessionId,
    model: { providerId: 'mock', model: 'gpt-4o' },
    userText: 'and now?',
    toolSchemas: [],
    executors: {},
    gate: async () => ({ behavior: 'allow' }),
    engineId: 'ai-sdk',
  });
  const extendCall = summaryCalls(seen2)[0];
  const grown = store.getSessionRollingSummary(bigSession.sessionId);
  record(
    '(d2) a larger fold extends the summary — the previous one is fed back in, and the new range is stored',
    summaryCalls(seen2).length === 1 &&
      !!extendCall?.texts.some((t) => t.includes('AGREED: ship on Friday')) &&
      !!grown &&
      grown.text.includes('pricing settled') &&
      (grown.foldedCount ?? 0) > (storedBefore?.foldedCount ?? 0),
    `summariser calls=${summaryCalls(seen2).length}; foldedCount ${storedBefore?.foldedCount} → ${grown?.foldedCount}`,
  );
}

// ---------------------------------------------------------------------------
// (e) the summariser fails: truncate honestly, never throw, never half-store
// ---------------------------------------------------------------------------

{
  const failSession = store.createSession('mock');
  seed(store, failSession.sessionId, 120, 3000);
  const storedBefore = store.getSessionRollingSummary(failSession.sessionId);
  const seen: SeenCall[] = [];
  const events: EngineEvent[] = [];
  let threw = '';
  try {
    await runTurn({
      engine: new AiSdkEngine({
        resolveModel: () => recordingModel({ summary: '', summaryThrows: true, seen }),
      }),
      store,
      sessionId: failSession.sessionId,
      model: { providerId: 'mock', model: 'gpt-4o' },
      userText: 'anything?',
      toolSchemas: [],
      executors: {},
      gate: async () => ({ behavior: 'allow' }),
      engineId: 'ai-sdk',
      onEvent: (ev) => events.push(ev),
    });
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  const call = lastTurnCall(seen);
  const answered = events.some((e) => e.kind === 'result' && e.ok);
  const pill = events.find(
    (e) => e.kind === 'harness' && e.subtype === 'context-compaction',
  ) as Extract<EngineEvent, { kind: 'harness' }> | undefined;
  record(
    '(e) a failed summariser truncates and SAYS SO — the turn still answers, and no half-summary is stored',
    threw === '' &&
      answered &&
      !!call?.texts.some((t) => t.includes(TRUNCATION_NOTICE)) &&
      /^truncated:\d+$/.test(pill?.detail ?? '') &&
      store.getSessionRollingSummary(failSession.sessionId) === storedBefore,
    `threw=${threw || 'no'}; answered=${answered}; pill=${pill?.detail ?? 'none'}; stored=${String(
      store.getSessionRollingSummary(failSession.sessionId),
    )}`,
  );
}

// ---------------------------------------------------------------------------
// (f) the planner's own rules, asserted without a model
// ---------------------------------------------------------------------------

{
  const tiny: RuntimeMessage[] = [
    { role: 'user', content: 'x'.repeat(400_000) },
    { role: 'assistant', content: 'y' },
  ];
  const p1 = planFold(tiny, 1000);
  record(
    '(f) the tail floor holds — a conversation with too few messages is never folded to nothing',
    p1.fold === false,
    `fold=${p1.fold}, estimate=${p1.estimatedTokens} against a 1000-token budget`,
  );

  // A boundary that would land on a tool RESULT must move past it: every provider
  // rejects a tool result whose call is not in the payload.
  const withTool: RuntimeMessage[] = [
    { role: 'user', content: 'a'.repeat(20_000) },
    { role: 'assistant', content: '', toolCalls: [{ toolCallId: 't1', toolName: 'read', input: {} }] },
    { role: 'tool', toolCallId: 't1', toolName: 'read', output: { content: 'b'.repeat(20_000) } },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'c'.repeat(20_000) },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'd' },
    { role: 'assistant', content: 'e' },
    { role: 'user', content: 'f' },
    { role: 'assistant', content: 'g' },
  ];
  const p2 = planFold(withTool, 4_000, { minTail: 2 });
  const tailStartsOnTool = p2.fold === true && p2.tail[0]?.role === 'tool';
  record(
    '(f2) a fold boundary never separates a tool result from the call that produced it',
    p2.fold === true && !tailStartsOnTool,
    `fold=${p2.fold}${p2.fold ? `, foldedCount=${p2.foldedCount}, tail starts with ${p2.tail[0]?.role}` : ''}`,
  );
}

store.close?.();
rmSync(TMP_DIR, { recursive: true, force: true });

// ---- report --------------------------------------------------------------
let failed = 0;
for (const c of checks) {
  if (!c.pass) failed += 1;
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}\n      ${c.evidence}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
if (failed > 0) process.exitCode = 1;
