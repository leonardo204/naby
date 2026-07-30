// src/spikes/spike-rank.ts
//
// Phase 3 (P3-M8c) verification: RELEVANCE-RANKED MEMORY INJECTION.
// Contract: specs/phase-3-continuous-learning.md §6.2,
// ref-docs/specs/interface/phase-1_5-memory-contracts.md §5.
//
// THE PROBLEM THIS RANKING FIXES. Injection filled a fixed token budget in
// scope → type → recency order, so on a machine with more confirmed facts than
// the budget holds, the ones that got in were simply the NEWEST — whether or not
// they had anything to do with what the user just asked. The fact that would have
// helped sat out the turn behind a fresher one about something else.
//
// THE RISK IT INTRODUCES, and what this spike is actually here to rule out: a
// ranking that only sometimes helps must never make the other turns WORSE. So the
// load-bearing assertions below are not "relevance works" but "when relevance has
// nothing to say, the order is the one the old code produced" — checked against a
// literal copy of the pre-M8c comparator, not against a remembered description
// of it.
//
// Asserted:
//   (a) A RELEVANT memory beats a newer irrelevant one into a budget that only
//       fits one of them.
//   (b) An exact relevance tie falls back to scope → type → recency.
//   (c) With NO queryText the order is identical to the old comparator's, for a
//       randomized population big enough to catch an accidental reordering.
//   (d) With a queryText that matches NOTHING, likewise.
//   (e) Hangul matches: a Korean turn finds the Korean fact, including when the
//       token sits against Latin text with no space between them.
//   (f) The budget is still a HARD ceiling and droppedForBudget still accounts
//       for every candidate that did not fit.
//   (g) `proposed` memory still never injects, however relevant it is.
//   (h) End to end: `queryText` reaches the turn's SYSTEM field through runTurn,
//       and a turn that supplies none is byte-for-byte the turn it always was.
//
// NO NETWORK, NO KEYS. Temp dir only; the real ~/.naby/app.db is never touched.
// Prints PASS/FAIL per assertion; exits non-zero on any FAIL.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP_DIR = mkdtempSync(join(tmpdir(), 'naby-spike-rank-'));
process.env.NABY_DB_PATH = join(TMP_DIR, 'app.db');
process.env.NABY_HOME = TMP_DIR;

import { MockEngine } from '../engines/mock-engine.js';
import { makeGate, scriptedPolicy } from '../runtime/gate.js';
import {
  estimateTokens,
  renderMemoryLine,
  retrieveForInjection,
  selectMemoryForInjection,
  tokenizeForRelevance,
} from '../runtime/memory-inject.js';
import { runTurn } from '../runtime/session.js';
import { MemoryStore } from '../runtime/store/memory-store.js';
import { SqliteStore } from '../runtime/store/sqlite-store.js';
import type {
  MemoryItem,
  MemoryScope,
  MemoryStatus,
  MemoryType,
  Store,
} from '../runtime/store/store.js';
import { buildToolset, Outbox } from '../runtime/tools.js';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

// ---------------------------------------------------------------------------
// THE OLD ORDER, copied verbatim from memory-inject.ts as it stood before M8c.
//
// A COPY IS THE POINT. Importing the new `rankCandidates` and asserting it
// equals itself would prove nothing; this is the independent statement of what
// the order used to be, so (c) and (d) genuinely compare against the old
// behaviour rather than against the new code's opinion of it.
// ---------------------------------------------------------------------------

const OLD_SCOPE_RANK: Record<MemoryScope, number> = { session: 0, project: 1, user: 2, org: 3 };
const OLD_TYPE_RANK: Record<MemoryType, number> = {
  working: 0,
  episodic: 1,
  semantic: 2,
  procedural: 3,
};

function rankTheOldWay(items: readonly MemoryItem[]): MemoryItem[] {
  return [...items].sort((a, b) => {
    const s = OLD_SCOPE_RANK[a.scope] - OLD_SCOPE_RANK[b.scope];
    if (s !== 0) return s;
    const t = OLD_TYPE_RANK[a.type] - OLD_TYPE_RANK[b.type];
    if (t !== 0) return t;
    return b.updatedAt - a.updatedAt;
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let seq = 0;
function item(over: Partial<MemoryItem> = {}): MemoryItem {
  seq += 1;
  return {
    id: `m${seq}`,
    scope: 'user',
    scopeKey: 'local',
    type: 'semantic',
    key: `fact-${seq}`,
    value: `a fact numbered ${seq}`,
    provenance: { source: 'user' },
    confidence: 1,
    status: 'confirmed' as MemoryStatus,
    createdAt: 1_000 + seq,
    updatedAt: 1_000 + seq,
    ...over,
  };
}

const ids = (rows: readonly MemoryItem[]): string => rows.map((r) => r.id).join(',');

/**
 * A budget that fits WHICHEVER of these rows is ranked first, and only that one.
 *
 * Derived rather than written down as a number, because the selection is GREEDY:
 * a hand-picked budget that happens to be smaller than the relevant row's line
 * would drop it and take the shorter irrelevant one — and the check would then be
 * measuring line lengths while appearing to measure the ranking.
 */
function budgetForOne(rows: readonly MemoryItem[]): number {
  return Math.max(...rows.map((r) => estimateTokens(renderMemoryLine(r))));
}

// ---------------------------------------------------------------------------
// (a) relevance beats recency into a contested budget
// ---------------------------------------------------------------------------

function checkRelevanceWins(): void {
  // Same scope, same type: under the OLD order the newer row wins on recency
  // alone, and with a budget that fits one line the older-but-relevant fact is
  // the one that gets dropped.
  const relevant = item({
    id: 'relevant',
    key: 'postgres-migrations',
    value: 'Runs database migrations with sqitch before deploying postgres changes.',
    updatedAt: 1_000,
  });
  const newerIrrelevant = item({
    id: 'newer',
    key: 'coffee-order',
    value: 'Takes an oat flat white in the afternoon, never after six.',
    updatedAt: 9_000,
  });
  const candidates = [relevant, newerIrrelevant];

  // A budget that fits exactly ONE of the two lines, so the ranking decides
  // which one the model sees.
  const budget = budgetForOne(candidates);
  const withoutQuery = selectMemoryForInjection(candidates, budget);
  const withQuery = selectMemoryForInjection(
    candidates,
    budget,
    'can you run the postgres migrations for this deploy?',
  );

  record(
    '(a) a relevant memory takes the contested budget from a NEWER irrelevant one',
    withoutQuery.items.length === 1 &&
      withoutQuery.items[0]?.id === 'newer' &&
      withQuery.items.length === 1 &&
      withQuery.items[0]?.id === 'relevant' &&
      withQuery.droppedForBudget === 1,
    `no queryText → injected ${ids(withoutQuery.items)} (recency wins); ` +
      `with queryText → injected ${ids(withQuery.items)} dropped=${withQuery.droppedForBudget}`,
  );

  // With room for both, relevance decides the ORDER but loses nothing.
  const roomy = selectMemoryForInjection(candidates, 1_000, 'postgres migrations please');
  record(
    '(a2) with room for both, the relevant one leads and nothing is dropped',
    roomy.items.length === 2 &&
      roomy.items[0]?.id === 'relevant' &&
      roomy.droppedForBudget === 0,
    `order=${ids(roomy.items)} dropped=${roomy.droppedForBudget}`,
  );
}

// ---------------------------------------------------------------------------
// (b) an exact tie falls back to scope → type → recency
// ---------------------------------------------------------------------------

function checkTieFallsBack(): void {
  // Two rows whose key+value token counts AND overlaps are identical, so their
  // scores are exactly equal. They differ only in scope, where the contract's
  // precedence rule (session > project > user > org) must decide.
  const userScoped = item({
    id: 'user-row',
    scope: 'user',
    scopeKey: 'local',
    key: 'deploy-window',
    value: 'deploy window friday morning',
    updatedAt: 5_000,
  });
  const sessionScoped = item({
    id: 'session-row',
    scope: 'session',
    scopeKey: 's1',
    key: 'deploy-window',
    value: 'deploy window friday morning',
    updatedAt: 1_000, // OLDER, so recency alone would put it last
  });
  const query = 'what is the deploy window';
  const out = selectMemoryForInjection([userScoped, sessionScoped], 1_000, query);
  // And the same two rows with NO query at all must come out the same way, which
  // is what shows the tiebreak really is the old comparator.
  const unranked = selectMemoryForInjection([userScoped, sessionScoped], 1_000);

  record(
    '(b) an exact relevance tie is broken by scope precedence, exactly as it was before ranking',
    ids(out.items) === 'session-row,user-row' && ids(out.items) === ids(unranked.items),
    `withQuery=${ids(out.items)} withoutQuery=${ids(unranked.items)}`,
  );
}

// ---------------------------------------------------------------------------
// (c)+(d) the no-signal orders are the OLD order, exactly
// ---------------------------------------------------------------------------

/** A deterministic pseudo-random population spanning every scope and type, with
 *  colliding updatedAt values so stability is exercised too. */
function population(): MemoryItem[] {
  const scopes: MemoryScope[] = ['session', 'project', 'user', 'org'];
  const types: MemoryType[] = ['working', 'episodic', 'semantic', 'procedural'];
  const rows: MemoryItem[] = [];
  for (let i = 0; i < 60; i += 1) {
    rows.push(
      item({
        id: `p${i}`,
        scope: scopes[(i * 7) % scopes.length]!,
        type: types[(i * 5) % types.length]!,
        key: `topic-${i % 9}`,
        value: `a stored sentence about topic ${i % 9} and nothing else at all`,
        // Deliberate collisions: several rows share an updatedAt, so a naive
        // re-sort would betray itself by shuffling them.
        updatedAt: 1_000 + (i % 12) * 10,
      }),
    );
  }
  return rows;
}

function checkNoSignalIsIdentical(): void {
  const rows = population();
  const expected = ids(rankTheOldWay(rows));

  // (c) NO queryText at all.
  const none = selectMemoryForInjection(rows, 1_000_000);
  // (d) A queryText that shares no token with any row. ('quokka' and
  // 'trampoline' appear nowhere above, and one-character tokens are dropped, so
  // every score is exactly 0.)
  const unmatched = selectMemoryForInjection(rows, 1_000_000, 'quokka trampoline?!');
  // A blank/whitespace query is the same case and worth pinning: it is what an
  // empty prompt or an images-only turn produces.
  const blank = selectMemoryForInjection(rows, 1_000_000, '   \n  ');

  record(
    '(c) with NO queryText the ranking is byte-for-byte the pre-M8c order (60 rows, colliding timestamps)',
    ids(none.items) === expected && none.items.length === rows.length,
    `identical=${ids(none.items) === expected} rows=${none.items.length}`,
  );
  record(
    '(d) a queryText matching NOTHING (and a blank one) produce that same order — relevance never makes a turn worse',
    ids(unmatched.items) === expected && ids(blank.items) === expected,
    `unmatchedIdentical=${ids(unmatched.items) === expected} blankIdentical=${ids(blank.items) === expected}`,
  );
}

// ---------------------------------------------------------------------------
// (e) Hangul
// ---------------------------------------------------------------------------

function checkHangul(): void {
  const korean = item({
    id: 'ko',
    key: 'ui-language',
    value: '답변은 한국어로 쓰고 코드 주석은 영어로 쓴다',
    updatedAt: 1_000,
  });
  const english = item({
    id: 'en',
    key: 'sql-style',
    value: 'Prefers explicit joins over subqueries in every query.',
    updatedAt: 9_000, // newer, so recency alone would win
  });
  const out = selectMemoryForInjection([korean, english], 1_000, '이 문서를 한국어로 정리해 줘');

  // The mixed-script case: `config파일` must yield BOTH `config` and `파일`,
  // which is the whole reason the tokenizer takes Hangul runs first.
  const mixed = tokenizeForRelevance('config파일 업데이트');
  const mixedMemory = item({
    id: 'mixed',
    key: 'config-format',
    value: 'config파일은 yaml로 유지한다',
    updatedAt: 1,
  });
  const mixedOut = selectMemoryForInjection([mixedMemory, english], 1_000, 'config 파일 좀 봐줘');

  record(
    '(e) a Korean turn finds the Korean fact, and a Hangul run sitting against Latin text still splits into both tokens',
    out.items[0]?.id === 'ko' &&
      mixed.includes('config') &&
      mixed.includes('파일') &&
      mixedOut.items[0]?.id === 'mixed',
    `koreanFirst=${ids(out.items)}; tokenize("config파일 업데이트")=${JSON.stringify(mixed)}; mixedFirst=${ids(mixedOut.items)}`,
  );

  // One-character tokens are dropped (§6.2), so a stray letter cannot rank.
  const singles = tokenizeForRelevance('a b 가 hi 12 3');
  record(
    '(e2) one-character tokens are dropped, so a stray letter cannot drive the ranking',
    singles.join(',') === 'hi,12',
    `tokenize("a b 가 hi 12 3")=${JSON.stringify(singles)}`,
  );
}

// ---------------------------------------------------------------------------
// (f)+(g) the budget and the confirmed-only rule are untouched
// ---------------------------------------------------------------------------

function checkBudgetAndStatus(store: Store, label: string): void {
  for (let i = 0; i < 8; i += 1) {
    store.putMemory({
      scope: 'user',
      scopeKey: 'local',
      type: 'semantic',
      key: `deploy-note-${i}`,
      value: `deploy note number ${i} about the deploy pipeline and its steps`,
      provenance: { source: 'user' },
      confidence: 1,
      requestedStatus: 'confirmed',
    });
  }
  // The MOST relevant row of all — and `proposed`, so it must never appear.
  store.putMemory({
    scope: 'user',
    scopeKey: 'local',
    type: 'semantic',
    key: 'deploy-secret-plan',
    value: 'PROPOSED-SHOULD-NEVER-INJECT deploy deploy deploy pipeline',
    provenance: { source: 'artifact' },
    confidence: 0.5,
    requestedStatus: 'proposed',
  });

  const budget = 40;
  const query = 'walk me through the deploy pipeline steps';
  const out = retrieveForInjection(
    store,
    { sessionId: 'no-session', tokenBudget: budget, queryText: query },
    { userId: 'local' },
  );
  const confirmedTotal = store.getScopedMemory('user', 'local', { status: 'confirmed' }).length;

  record(
    `(f) [${label}] the budget is still a HARD ceiling and every candidate is accounted for, with ranking on`,
    out.tokensUsed <= budget &&
      out.droppedForBudget > 0 &&
      out.items.length + out.droppedForBudget === confirmedTotal,
    `tokensUsed=${out.tokensUsed} (<=${budget}) injected=${out.items.length} dropped=${out.droppedForBudget} confirmedTotal=${confirmedTotal}`,
  );
  record(
    `(g) [${label}] a proposed row does not inject however relevant it is to the turn`,
    out.items.every((m) => m.status === 'confirmed') &&
      out.items.every((m) => !m.value.includes('PROPOSED-SHOULD-NEVER-INJECT')),
    `injected keys=${out.items.map((m) => m.key).join(',')}`,
  );
}

// ---------------------------------------------------------------------------
// (h) end to end through runTurn
// ---------------------------------------------------------------------------

async function checkThroughRunTurn(): Promise<void> {
  const store = new MemoryStore();
  const outbox = new Outbox();
  const { toolSchemas, executors } = buildToolset(outbox);
  const gate = makeGate(scriptedPolicy({ send_message: { behavior: 'allow' } }));

  const put = (key: string, value: string, updatedAt: number): void => {
    store.putMemory({
      scope: 'user',
      scopeKey: 'local',
      type: 'semantic',
      key,
      value,
      provenance: { source: 'user' },
      confidence: 1,
      requestedStatus: 'confirmed',
    });
    // The store stamps its own updatedAt; the order this check depends on comes
    // from relevance, so the write order is enough to make the OTHER row newer.
    void updatedAt;
  };
  put('coffee-order', 'Takes an oat flat white, never after six in the evening.', 1);
  put('release-checklist', 'Tags the release commit and writes the changelog before publishing.', 2);

  // A budget that fits ONE line, so the injected block names the winner. Read
  // back from the store, for the reason `budgetForOne` gives.
  const budget = budgetForOne(store.getScopedMemory('user', 'local', { status: 'confirmed' }));
  const sid = store.createSession('provider-a', 'ranked').sessionId;
  const ranked = new MockEngine();
  await runTurn({
    engine: ranked,
    store,
    sessionId: sid,
    model: { providerId: 'mock', model: 'm' },
    userText: 'help me publish the release: changelog, tag, the usual checklist',
    system: 'BASE',
    toolSchemas,
    executors,
    gate: gate.gate,
    memoryInjection: {
      tokenBudget: budget,
      userId: 'local',
      queryText: 'help me publish the release: changelog, tag, the usual checklist',
    },
  });

  const sid2 = store.createSession('provider-a', 'unranked').sessionId;
  const unranked = new MockEngine();
  await runTurn({
    engine: unranked,
    store,
    sessionId: sid2,
    model: { providerId: 'mock', model: 'm' },
    userText: 'help me publish the release: changelog, tag, the usual checklist',
    system: 'BASE',
    toolSchemas,
    executors,
    gate: gate.gate,
    memoryInjection: { tokenBudget: budget, userId: 'local' },
  });

  const rankedSystem = String(ranked.diagnostics.system ?? '');
  const unrankedSystem = String(unranked.diagnostics.system ?? '');

  // And the NO-OP control: injection on, nothing confirmed to inject, queryText
  // supplied. The system must be the untouched base — a query text must not, by
  // itself, cause a block to appear.
  const empty = new MemoryStore();
  const sid3 = empty.createSession('provider-a', 'none').sessionId;
  const noop = new MockEngine();
  await runTurn({
    engine: noop,
    store: empty,
    sessionId: sid3,
    model: { providerId: 'mock', model: 'm' },
    userText: 'anything at all',
    system: 'BASE-ONLY',
    toolSchemas,
    executors,
    gate: gate.gate,
    memoryInjection: { tokenBudget: 500, userId: 'nobody', queryText: 'anything at all' },
  });

  record(
    '(h) queryText reaches the SYSTEM field through runTurn: the relevant fact is injected where recency would have injected the other',
    rankedSystem.includes('changelog') &&
      !rankedSystem.includes('flat white') &&
      unrankedSystem.includes('flat white') &&
      !unrankedSystem.includes('changelog'),
    `ranked system=${JSON.stringify(rankedSystem)}; unranked system=${JSON.stringify(unrankedSystem)}`,
  );
  record(
    '(h2) NO-OP holds: injection on with a queryText and nothing confirmed leaves the system byte-for-byte the base',
    noop.diagnostics.system === 'BASE-ONLY',
    `system=${JSON.stringify(noop.diagnostics.system)}`,
  );
}

// ---------------------------------------------------------------------------

async function main(): Promise<boolean> {
  checkRelevanceWins();
  checkTieFallsBack();
  checkNoSignalIsIdentical();
  checkHangul();
  for (const [label, make] of [
    ['MemoryStore', () => new MemoryStore()],
    ['SqliteStore', () => new SqliteStore({ path: ':memory:' })],
  ] as const) {
    const store = make();
    checkBudgetAndStatus(store, label);
    store.close();
  }
  await checkThroughRunTurn();

  console.log('\n=== SPIKE-RANK — relevance-ranked memory injection (P3-M8c §6.2) ===\n');
  let allPass = true;
  for (const c of checks) {
    const tag = c.pass ? 'PASS' : 'FAIL';
    if (!c.pass) allPass = false;
    console.log(`[${tag}] ${c.name}`);
    console.log(`        evidence: ${c.evidence}`);
  }
  console.log(
    `\nSPIKE-RANK: ${allPass ? 'ALL PASS' : 'FAILURES PRESENT'} (${checks.filter((c) => c.pass).length}/${checks.length})\n`,
  );
  return allPass;
}

try {
  const ok = await main();
  if (!ok) process.exitCode = 1;
} catch (e) {
  console.error('SPIKE-RANK crashed:', e);
  process.exitCode = 1;
} finally {
  rmSync(TMP_DIR, { recursive: true, force: true });
}
