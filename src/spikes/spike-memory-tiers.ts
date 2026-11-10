// src/spikes/spike-memory-tiers.ts
//
// SPIKE: short, long and anchored memory (specs/memory-tiers.md).
//
// Drives the pure rules in memory-tiers.ts and the store's tier bookkeeping on
// BOTH drivers, plus the v18 migration on a real file:
//
//   (a) R1–R3   a row entering use gets its tier; proposed rows have none
//   (b) R4      short → long on two distinct days / sessions (corroboration or
//               injection); one day is not enough; R3 rows never rise
//   (c) R5/R7   three sessions of the user's verified words anchor automatically;
//               external and blocked rows never do
//   (d) R5      an explicit pin waits for the review, then anchors
//   (e) R16/R17 the anchored budget (20 rows / 500 tokens); a full budget flags a
//               candidate and lowers nothing
//   (f) R6/R20  unanchoring returns to long and blocks auto re-anchoring
//   (g) R8/R9   retention: short 14 d, session 7 d after it ended, transient 14 d
//               unused, long min(90 d × S, 365 d); anchored never; R22 grace
//   (h) R10     strength rises at most once per local day
//   (i) R11     archived rows are hidden from every ordinary read and injection;
//               restore → long; writing the key again un-archives
//   (j) R12–R14 deletion after 30 days with evidence and verdicts; the day line
//   (k) R15/R16 anchored rows injected first, whole values, inside their budget
//   (l) R18/R19 review / tidy / store never change an anchored row
//   (m) R21–R23 the v18 migration on a real file
//   (n) R5      naby_remember `pin` only with the user's verified words
//   (o)         the tier jobs are not held by a rate-limit block; re-seed queues them
//
// NO NETWORK, NO KEYS, NO MODEL. Temp dir only; the real ~/.naby is never touched.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP_DIR = mkdtempSync(join(tmpdir(), 'naby-spike-tiers-'));
process.env.NABY_DB_PATH = join(TMP_DIR, 'app.db');
process.env.NABY_HOME = TMP_DIR;

import { DatabaseSync } from 'node:sqlite';
import {
  ANCHORED_MAX_ROWS,
  ANCHORED_TOKEN_BUDGET,
  anchorMemory,
  decideRetention,
  decideTierPromotion,
  initialMemoryTier,
  LONG_TERM_MAX_RETENTION_MS,
  longTermRetentionMs,
  MEMORY_TIERS_ARCHIVE_LOG_KEY,
  MEMORY_TIERS_MIGRATED_AT_KEY,
  readArchiveLog,
  readTierGraceUntil,
  requestMemoryPin,
  runTierPromotion,
  runTierRetention,
  settlePinRequest,
  shouldShowTierGraceNotice,
  shouldRaiseStrength,
  startOfLocalDay,
  TIER_MIGRATION_GRACE_MS,
  unanchorMemory,
} from '../runtime/memory-tiers.js';
import { decideReviewOutcome, decideTidyOperation } from '../runtime/memory-consolidation.js';
import { renderInjectedMemory, selectMemoryForInjection } from '../runtime/memory-inject.js';
import { enqueueMemoryJob, pickNextMemoryJob, reseedMemoryJobs, type MemoryJob } from '../runtime/memory-work.js';
import { makeRemember, rememberSchema } from '../runtime/tools.js';
import { MemoryStore } from '../runtime/store/memory-store.js';
import { SCHEMA_VERSION, SqliteStore } from '../runtime/store/sqlite-store.js';
import type { MemoryItem, MemoryWriteRequest, Store } from '../runtime/store/store.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, evidence = ''): void {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${evidence ? `\n      ${evidence}` : ''}`);
}

const NOW = Date.now();
const DAY = 86_400_000;

function onBothDrivers(body: (store: Store, label: string) => void): void {
  for (const [label, make] of [
    ['MemoryStore', () => new MemoryStore()],
    ['SqliteStore', () => new SqliteStore({ path: ':memory:' })],
  ] as const) {
    const store = make();
    try {
      body(store, label);
    } finally {
      store.close();
    }
  }
}

let seq = 0;
function write(store: Store, over: Partial<MemoryWriteRequest> = {}): MemoryItem {
  seq += 1;
  return store.putMemory({
    scope: 'user',
    scopeKey: 'local',
    type: 'semantic',
    key: `fact-${seq}`,
    value: `a fact numbered ${seq}`,
    provenance: { source: 'artifact', basisKind: 'inferred' },
    confidence: 1,
    requestedStatus: 'confirmed',
    ...over,
  } as MemoryWriteRequest);
}

const STATED = { source: 'user' as const, basisKind: 'stated' as const, evidenceQuote: 'remember this' };

// ---------------------------------------------------------------------------
// (a) entering use
// ---------------------------------------------------------------------------
onBothDrivers((store, label) => {
  const inferred = write(store);
  const stated = write(store, { provenance: STATED });
  const session = write(store, { scope: 'session', scopeKey: 's-1', provenance: STATED });
  const transient = write(store, { provenance: STATED, volatility: 'transient' });
  const proposed = write(store, { requestedStatus: 'proposed' });
  check(
    `(a/${label}) R1–R3: inferred → short, stated → long, session/transient → short, proposed → none`,
    inferred.tier === 'short' && stated.tier === 'long' && session.tier === 'short' &&
      transient.tier === 'short' && proposed.tier === undefined,
    `${inferred.tier}/${stated.tier}/${session.tier}/${transient.tier}/${String(proposed.tier)}`,
  );
  store.confirmMemory(proposed.id);
  const pending = write(store, { requestedStatus: 'proposed', reviewState: 'pending' });
  store.settleMemoryReview(pending.id, { status: 'confirmed' });
  check(
    `(a/${label}) R1: a person's confirm and a review's confirm both give the row a tier`,
    store.getMemoryById(proposed.id)?.tier !== undefined && store.getMemoryById(pending.id)?.tier === 'short',
  );
});

// ---------------------------------------------------------------------------
// (b) R4 promotion
// ---------------------------------------------------------------------------
onBothDrivers((store, label) => {
  const sameDay = write(store);
  store.corroborateMemory(sameDay.id, 's-a', { at: NOW });
  store.corroborateMemory(sameDay.id, 's-b', { at: NOW + 1000 });
  const twoDays = write(store);
  store.corroborateMemory(twoDays.id, 's-a', { at: NOW - 2 * DAY });
  store.corroborateMemory(twoDays.id, 's-b', { at: NOW });
  const injected = write(store);
  store.markMemoriesInjected([injected.id], NOW - 3 * DAY, { sessionId: 's-x' });
  store.markMemoriesInjected([injected.id], NOW - 3 * DAY + 60_000, { sessionId: 's-x' });
  store.markMemoriesInjected([injected.id], NOW, { sessionId: 's-y' });
  const session = write(store, { scope: 'session', scopeKey: 's-1' });
  store.corroborateMemory(session.id, 's-a', { at: NOW - 2 * DAY });
  store.corroborateMemory(session.id, 's-b', { at: NOW });
  const r = runTierPromotion(store, NOW);
  const tier = (m: MemoryItem) => store.getMemoryById(m.id)?.tier;
  check(
    `(b/${label}) R4: two sessions on ONE day stay short; two days → long (corroboration and injection); R3 never`,
    tier(sameDay) === 'short' && tier(twoDays) === 'long' && tier(injected) === 'long' && tier(session) === 'short',
    `${tier(sameDay)}/${tier(twoDays)}/${tier(injected)}/${tier(session)} long=${r.long}`,
  );
});

// ---------------------------------------------------------------------------
// (c) R5/R7 automatic anchoring
// ---------------------------------------------------------------------------
onBothDrivers((store, label) => {
  const fact = write(store, { provenance: STATED });
  const external = write(store, { scope: 'project', scopeKey: '/p', provenance: { source: 'external' }, requestedStatus: 'proposed' });
  store.confirmMemory(external.id); // a person approved it — still never auto-anchored (R7)
  store.patchMemoryProvenance(external.id, { source: 'external' });
  for (const [i, s] of ['s-1', 's-2'].entries()) {
    store.corroborateMemory(fact.id, s, { at: NOW - i * DAY, stated: true });
    store.corroborateMemory(external.id, s, { at: NOW - i * DAY, stated: true });
  }
  runTierPromotion(store, NOW);
  const twoOnly = store.getMemoryById(fact.id)?.tier;
  store.corroborateMemory(fact.id, 's-3', { at: NOW, stated: true });
  store.corroborateMemory(external.id, 's-3', { at: NOW, stated: true });
  const inferredOnly = write(store, { provenance: STATED });
  for (const s of ['s-1', 's-2', 's-3']) store.corroborateMemory(inferredOnly.id, s, { at: NOW });
  runTierPromotion(store, NOW);
  const after = store.getMemoryById(fact.id);
  check(
    `(c/${label}) R5: two stated sessions are not enough; the third anchors it (origin auto)`,
    twoOnly === 'long' && after?.tier === 'anchored' && after.anchorOrigin === 'auto',
    `${twoOnly} → ${after?.tier}/${after?.anchorOrigin}`,
  );
  check(
    `(c/${label}) R5/R7: restatements that were not the user's verified words, and external rows, never anchor`,
    store.getMemoryById(inferredOnly.id)?.tier === 'long' && store.getMemoryById(external.id)?.tier !== 'anchored',
  );
});

// ---------------------------------------------------------------------------
// (d) R5 explicit pin
// ---------------------------------------------------------------------------
onBothDrivers((store, label) => {
  const pending = write(store, { requestedStatus: 'proposed', reviewState: 'pending', provenance: STATED });
  const r1 = requestMemoryPin(store, pending.id, NOW);
  const waiting = store.getMemoryById(pending.id);
  store.settleMemoryReview(pending.id, { status: 'confirmed' });
  const r2 = settlePinRequest(store, pending.id, NOW);
  const done = store.getMemoryById(pending.id);
  const inUse = write(store, { provenance: STATED });
  const r3 = requestMemoryPin(store, inUse.id, NOW);
  check(
    `(d/${label}) R5: a pin on a pending row waits, then anchors on confirm; a pin on a row in use anchors now`,
    r1 === 'requested' && waiting?.pinRequested === true && waiting.tier === undefined &&
      r2 === 'anchored' && done?.tier === 'anchored' && done.anchorOrigin === 'explicit' && !done.pinRequested &&
      r3 === 'anchored',
    `${r1} → ${r2}; in use: ${r3}`,
  );
});

// ---------------------------------------------------------------------------
// (e) R16/R17 the anchored budget
// ---------------------------------------------------------------------------
onBothDrivers((store, label) => {
  const rows: MemoryItem[] = [];
  for (let i = 0; i < ANCHORED_MAX_ROWS; i += 1) rows.push(write(store, { value: `short ${i}`, provenance: STATED }));
  for (const r of rows) anchorMemory(store, r.id, 'user', NOW);
  const extra = write(store, { value: 'one more', provenance: STATED });
  for (const s of ['s-1', 's-2', 's-3']) store.corroborateMemory(extra.id, s, { at: NOW, stated: true });
  const pr = runTierPromotion(store, NOW);
  const flagged = store.getMemoryById(extra.id);
  const userPin = anchorMemory(store, extra.id, 'user', NOW);
  check(
    `(e/${label}) R17: the 21st stays long, flagged as a candidate; a user pin is refused 'full'; nothing lowered`,
    flagged?.tier === 'long' && flagged.anchorCandidate === true && pr.full === 1 && userPin === 'full' &&
      store.listTieredMemory({ tier: 'anchored' }).length === ANCHORED_MAX_ROWS,
    `tier=${flagged?.tier} candidate=${String(flagged?.anchorCandidate)} full=${pr.full} user=${userPin}`,
  );
});
onBothDrivers((store, label) => {
  const big = 'x'.repeat(ANCHORED_TOKEN_BUDGET * 4 - 200);
  const a = write(store, { value: big, provenance: STATED });
  const b = write(store, { value: 'y'.repeat(400), provenance: STATED });
  const ra = anchorMemory(store, a.id, 'explicit', NOW);
  const rb = anchorMemory(store, b.id, 'explicit', NOW);
  check(
    `(e/${label}) R16: the 500-token share is enforced at anchoring time`,
    ra === 'anchored' && rb === 'full',
    `${ra}/${rb}`,
  );
});

// ---------------------------------------------------------------------------
// (f) R6/R20 unanchoring
// ---------------------------------------------------------------------------
onBothDrivers((store, label) => {
  const fact = write(store, { provenance: STATED });
  for (const s of ['s-1', 's-2', 's-3']) store.corroborateMemory(fact.id, s, { at: NOW, stated: true });
  runTierPromotion(store, NOW);
  const anchored = store.getMemoryById(fact.id)?.tier;
  const undone = unanchorMemory(store, fact.id, NOW + 1000);
  runTierPromotion(store, NOW + 2000);
  const after = store.getMemoryById(fact.id);
  check(
    `(f/${label}) R6: undo → long, clock restarted, never anchored automatically again`,
    anchored === 'anchored' && undone && after?.tier === 'long' && after.anchorBlocked === true &&
      after.tierSince === NOW + 1000,
    `${anchored} → ${after?.tier} blocked=${String(after?.anchorBlocked)}`,
  );
  const repinned = anchorMemory(store, fact.id, 'user', NOW + 3000);
  check(`(f/${label}) R20: a person can still pin it`, repinned === 'anchored' && store.getMemoryById(fact.id)?.anchorBlocked !== true);
});

// ---------------------------------------------------------------------------
// (g) R8/R9/R22 retention (pure)
// ---------------------------------------------------------------------------
{
  const base: MemoryItem = {
    id: 'r',
    scope: 'user',
    scopeKey: 'local',
    type: 'semantic',
    key: 'k',
    value: 'v',
    provenance: { source: 'artifact' },
    confidence: 1,
    status: 'confirmed',
    createdAt: NOW,
    updatedAt: NOW,
    tier: 'short',
    tierSince: NOW,
    strength: 1,
  };
  const short13 = decideRetention(base, { now: NOW + 13 * DAY });
  const short14 = decideRetention(base, { now: NOW + 14 * DAY });
  const session = decideRetention({ ...base, scope: 'session', scopeKey: 's' }, { now: NOW + 8 * DAY, sessionLastActiveAt: NOW + 2 * DAY });
  const sessionGone = decideRetention({ ...base, scope: 'session', scopeKey: 's' }, { now: NOW + 9 * DAY, sessionLastActiveAt: NOW + 2 * DAY });
  const transient = decideRetention({ ...base, tier: 'short', volatility: 'transient', lastInjectedAt: NOW + 5 * DAY }, { now: NOW + 18 * DAY });
  const transientGone = decideRetention({ ...base, volatility: 'transient', lastInjectedAt: NOW + 5 * DAY }, { now: NOW + 19 * DAY });
  check(
    '(g) R8: short archived at 14 days; session 7 days after it ended; transient 14 days unused',
    short13 === undefined && short14 === 'short-expired' && session === undefined && sessionGone === 'session-ended' &&
      transient === undefined && transientGone === 'transient-unused',
    `${String(short13)}/${short14}/${String(session)}/${sessionGone}/${String(transient)}/${transientGone}`,
  );
  const long1 = { ...base, tier: 'long' as const, strength: 1 };
  const long12 = { ...base, tier: 'long' as const, strength: 12 };
  check(
    '(g) R9: long lasts 90 d × S since last use, never past 365 d',
    decideRetention(long1, { now: NOW + 89 * DAY }) === undefined &&
      decideRetention(long1, { now: NOW + 90 * DAY }) === 'long-unused' &&
      longTermRetentionMs(3) === 270 * DAY && longTermRetentionMs(12) === LONG_TERM_MAX_RETENTION_MS &&
      decideRetention(long12, { now: NOW + 364 * DAY }) === undefined &&
      decideRetention(long12, { now: NOW + 365 * DAY }) === 'long-unused',
  );
  check(
    '(g) R18/R22: anchored is never archived; nothing is archived inside the migration grace',
    decideRetention({ ...base, tier: 'anchored' }, { now: NOW + 9999 * DAY }) === undefined &&
      decideRetention(base, { now: NOW + 20 * DAY, graceUntil: NOW + 30 * DAY }) === undefined &&
      decideRetention(base, { now: NOW + 31 * DAY, graceUntil: NOW + 30 * DAY }) === 'short-expired',
  );
}

// ---------------------------------------------------------------------------
// (h) R10 strength once per day
// ---------------------------------------------------------------------------
onBothDrivers((store, label) => {
  const fact = write(store);
  const day0 = startOfLocalDay(NOW) + 10 * 3_600_000;
  store.markMemoriesInjected([fact.id], day0);
  store.markMemoriesInjected([fact.id], day0 + 3_600_000);
  store.markMemoriesInjected([fact.id], day0 + 2 * 3_600_000);
  const sameDay = store.getMemoryById(fact.id)?.strength;
  store.markMemoriesInjected([fact.id], day0 + DAY);
  const nextDay = store.getMemoryById(fact.id)?.strength;
  check(
    `(h/${label}) R10: three uses in one day raise strength once; the next day raises it again`,
    sameDay === 2 && nextDay === 3 && shouldRaiseStrength(undefined, NOW) && !shouldRaiseStrength(day0, day0 + 1),
    `same day ${String(sameDay)}, next day ${String(nextDay)}`,
  );
});

// ---------------------------------------------------------------------------
// (i) R11 archived rows are hidden
// ---------------------------------------------------------------------------
onBothDrivers((store, label) => {
  const live = write(store, { key: 'live', value: 'still used' });
  const gone = write(store, { key: 'gone', value: 'archived fact' });
  const n = store.archiveMemory([gone.id], NOW);
  const listed = store.getScopedMemory('user', 'local', { status: 'confirmed' }).map((m) => m.id);
  const archivedList = store.getScopedMemory('user', 'local', { archived: true }).map((m) => m.id);
  const injected = selectMemoryForInjection(store.getScopedMemory('user', 'local', { archived: true }), 2000).items;
  const unreviewed = store.listUnreviewedMemory(50).map((m) => m.id);
  const stale = store.listStaleConfirmedMemory(NOW + 9999 * DAY).map((m) => m.id);
  check(
    `(i/${label}) R11: an archived row is out of the ordinary read, the injection, the tidy backlog and the stale queue`,
    n === 1 && listed.includes(live.id) && !listed.includes(gone.id) && archivedList.join() === gone.id &&
      injected.length === 0 && !unreviewed.includes(gone.id) && !stale.includes(gone.id) &&
      store.countScopedMemory('user', 'local', {}) === 1,
    `listed=${listed.length} archived=${archivedList.length} injected=${injected.length}`,
  );
  const restored = store.restoreMemory(gone.id, NOW + DAY);
  const back = store.getMemoryById(gone.id);
  check(
    `(i/${label}) R11: restore → long, clock restarted`,
    restored && back?.archivedAt === undefined && back?.tier === 'long' && back?.tierSince === NOW + DAY,
  );
  store.archiveMemory([gone.id], NOW + 2 * DAY);
  const rewritten = write(store, { key: 'gone', value: 'archived fact, said again' });
  check(
    `(i/${label}) R11: writing an archived key again brings the memory back into use`,
    rewritten.id === gone.id && rewritten.archivedAt === undefined && rewritten.tier === 'short',
    `archived=${String(rewritten.archivedAt)} tier=${rewritten.tier}`,
  );
});

// ---------------------------------------------------------------------------
// (j) R12–R14 deletion
// ---------------------------------------------------------------------------
onBothDrivers((store, label) => {
  const old = write(store, { key: 'old-short' });
  store.corroborateMemory(old.id, 's-1', { at: NOW });
  const other = write(store, { key: 'other' });
  store.putMemoryPairVerdict({ aId: old.id, bId: other.id, aUpdatedAt: 1, bUpdatedAt: 1, relation: 'unrelated', judgedAt: NOW });
  const replaced = write(store, { key: 'replaced' });
  const replacer = write(store, { key: 'replacer' });
  store.supersedeMemory(replaced.id, replacer.id, NOW);
  // 15 days on: the short rows are archived (counted in the day line).
  const r1 = runTierRetention(store, NOW + 15 * DAY);
  const log = readArchiveLog(store);
  // 46 days on: archived 31 days ago → deleted; superseded 46 days ago → deleted.
  const r2 = runTierRetention(store, NOW + 46 * DAY);
  check(
    `(j/${label}) R8/R13: due rows archived, one log line for the day`,
    r1.archived >= 2 && log.length === 1 && log[0]!.count === r1.archived && store.getSetting(MEMORY_TIERS_ARCHIVE_LOG_KEY) !== undefined,
    `archived=${r1.archived} log=${JSON.stringify(log)}`,
  );
  check(
    `(j/${label}) R12/R14: archived and superseded rows go after 30 days, with their evidence and verdicts`,
    r2.purged >= 2 && store.getMemoryById(old.id) === undefined && store.getMemoryById(replaced.id) === undefined &&
      store.getMemoryCorroboration([old.id])[old.id] === undefined && store.getMemoryPairVerdict(old.id, other.id) === undefined,
    `purged=${r2.purged}`,
  );
});

// ---------------------------------------------------------------------------
// (k) R15/R16 injection
// ---------------------------------------------------------------------------
onBothDrivers((store, label) => {
  const longValue = 'Always answer in Korean.\nUse formal speech.\nNever use emoji.\nKeep answers short.';
  const anchored = write(store, { key: 'answer-style', value: longValue, provenance: STATED });
  anchorMemory(store, anchored.id, 'user', NOW);
  store.setMemorySummary(anchored.id, 'Korean, formal, short');
  const relevant = write(store, { key: 'deploy-target', value: 'deploys go to the staging cluster first' });
  const all = store.getScopedMemory('user', 'local', { status: 'confirmed' });
  const injected = selectMemoryForInjection(all, 2000, 'how do deploys work for the staging cluster');
  const text = renderInjectedMemory(injected) ?? '';
  check(
    `(k/${label}) R15: the anchored row leads, outside the relevance ranking`,
    injected.items[0]?.id === anchored.id && injected.items[1]?.id === relevant.id && injected.anchored === 1,
    injected.items.map((m) => m.key).join(','),
  );
  check(
    `(k/${label}) R16: whole value injected, never the summary; marked as winning`,
    text.includes('Never use emoji.') && !text.includes('Korean, formal, short') && text.includes('Always apply'),
  );
  const tiny = selectMemoryForInjection(all, 10);
  check(`(k/${label}) R16: the turn's own budget still caps it`, tiny.tokensUsed <= 10);
  const plain = selectMemoryForInjection([store.getMemoryById(relevant.id)!], 2000);
  check(
    `(k/${label}) no anchored rows → the block is exactly the old format`,
    plain.anchored === undefined && (renderInjectedMemory(plain) ?? '').split('\n').length === 2,
  );
});

// ---------------------------------------------------------------------------
// (l) R18/R19 nobody but a person changes an anchored row
// ---------------------------------------------------------------------------
onBothDrivers((store, label) => {
  const anchored = write(store, { key: 'tone', value: 'formal tone', provenance: STATED });
  anchorMemory(store, anchored.id, 'explicit', NOW);
  const a = store.getMemoryById(anchored.id)!;
  const subject = write(store, { key: 'tone-2', value: 'casual tone', requestedStatus: 'proposed', reviewState: 'pending' });
  const contra = decideReviewOutcome(subject, { id: subject.id, relations: [{ existing: a, relation: 'contradicts' }] } as never);
  const refine = decideReviewOutcome(subject, { id: subject.id, relations: [{ existing: a, relation: 'refines' }] } as never);
  const equiv = decideReviewOutcome(subject, { id: subject.id, relations: [{ existing: a, relation: 'equivalent' }] } as never);
  check(
    `(l/${label}) R18/R19: review — contradicts → anchored wins, refines → beside it, equivalent → merged without upgrade`,
    contra.op === 'anchored-wins' && refine.op === 'confirm' && equiv.op === 'merge' && equiv.upgrade === false,
    `${contra.op}/${refine.op}/${equiv.op}`,
  );
  const plain = store.getMemoryById(write(store, { key: 'tone-3', value: 'casual' }).id)!;
  const newer = { ...plain, updatedAt: a.updatedAt + 10_000 };
  const t1 = decideTidyOperation(newer, a, 'contradicts');
  const t2 = decideTidyOperation(newer, a, 'refines');
  const t3 = decideTidyOperation(a, newer, 'equivalent');
  check(
    `(l/${label}) R18: tidy never retires the anchored row`,
    t1.op === 'supersede' && t1.keep.id === a.id && t2.op === 'none' && t3.op === 'supersede' && t3.keep.id === a.id,
  );
  const stamped = store.supersedeMemory(a.id, plain.id, NOW, 'review-contradicts');
  let threw = false;
  try {
    write(store, { key: 'tone', value: 'casual tone', provenance: STATED, scope: 'user', scopeKey: 'local' });
  } catch {
    threw = true;
  }
  const same = write(store, { key: 'tone', value: 'formal tone', provenance: { ...STATED, sessionId: 's-9' } });
  check(
    `(l/${label}) R18: the store refuses a supersession and an upsert over it; the same words only corroborate`,
    !stamped && threw && same.id === a.id && store.getMemoryById(a.id)?.value === 'formal tone' &&
      store.getMemoryById(a.id)?.tier === 'anchored' && (store.getMemoryCorroboration([a.id])[a.id] ?? 0) >= 1,
  );
  const edited = store.updateMemoryValue(a.id, 'formal tone, always');
  check(`(l/${label}) R20: a person's edit lands and keeps it anchored`, edited?.value === 'formal tone, always' && edited.tier === 'anchored');
});

// ---------------------------------------------------------------------------
// (m) R21–R23 the v18 migration, on a real file
// ---------------------------------------------------------------------------
{
  const path = join(TMP_DIR, 'v17.db');
  const store = new SqliteStore({ path });
  const stated = write(store, { key: 'stated', provenance: STATED });
  const corroborated = write(store, { key: 'corroborated' });
  store.corroborateMemory(corroborated.id, 's-1');
  store.corroborateMemory(corroborated.id, 's-2');
  const single = write(store, { key: 'single' });
  const session = write(store, { key: 'sess', scope: 'session', scopeKey: 's-1', provenance: STATED });
  const proposed = write(store, { key: 'prop', requestedStatus: 'proposed' });
  store.markMemoriesInjected([single.id], NOW - 3 * DAY);
  store.markMemoriesInjected([single.id], NOW - 2 * DAY);
  store.close();
  // Turn it back into a v17 file: drop every v18 column.
  const db = new DatabaseSync(path);
  for (const c of ['memory_tier', 'tier_since', 'archived_at', 'anchor_origin', 'anchor_blocked', 'anchor_candidate', 'pin_requested', 'injection_log']) {
    db.exec(`ALTER TABLE memory_items DROP COLUMN ${c}`);
  }
  db.exec('ALTER TABLE memory_observations DROP COLUMN stated');
  db.exec(`DELETE FROM settings WHERE key = '${MEMORY_TIERS_MIGRATED_AT_KEY}'`);
  db.exec('PRAGMA user_version = 17');
  db.close();
  const before = Date.now();
  const upgraded = new SqliteStore({ path });
  const tier = (id: string) => upgraded.getMemoryById(id)?.tier;
  check(
    '(m) R21: stated and corroborated-in-2-sessions → long; others and session scope → short; proposed → none; no anchored',
    tier(stated.id) === 'long' && tier(corroborated.id) === 'long' && tier(single.id) === 'short' &&
      tier(session.id) === 'short' && tier(proposed.id) === undefined &&
      upgraded.listTieredMemory({ tier: 'anchored' }).length === 0,
    `${tier(stated.id)}/${tier(corroborated.id)}/${tier(single.id)}/${tier(session.id)}/${String(tier(proposed.id))}`,
  );
  check(
    '(m) R23: strength is kept; the version is stamped',
    upgraded.getMemoryById(single.id)?.strength === 3 &&
      (new DatabaseSync(path).prepare('PRAGMA user_version').get() as { user_version: number }).user_version === SCHEMA_VERSION,
  );
  const until = readTierGraceUntil(upgraded);
  const graced = runTierRetention(upgraded, Date.now() + 20 * DAY);
  check(
    '(m) R22: the migration instant is recorded, nothing is archived for 30 days, the notice shows once',
    until !== undefined && until >= before + TIER_MIGRATION_GRACE_MS && graced.archived === 0 &&
      shouldShowTierGraceNotice(upgraded, Date.now()),
    `graceUntil=${String(until)} archived=${graced.archived}`,
  );
  upgraded.close();
  const reopened = new SqliteStore({ path });
  check('(m) reopening is a no-op', reopened.getMemoryById(single.id)?.tier === 'short');
  reopened.close();
}

// ---------------------------------------------------------------------------
// (n) naby_remember pin
// ---------------------------------------------------------------------------
await (async () => {
  const store = new MemoryStore();
  const said = 'always answer me in Korean';
  const remember = makeRemember({
    putMemory: (req) => store.putMemory(req),
    sessionId: 's-1',
    userId: 'local',
    activation: {
      autoApply: true,
      externalTurn: () => false,
      userMessages: () => [{ text: `please ${said}` }],
      getExisting: (scope, scopeKey, key) => store.getScopedMemory(scope, scopeKey).find((m) => m.key === key),
      corroborate: (id, o) => store.corroborateMemory(id, 's-1', o?.stated ? { stated: true } : undefined),
      requestPin: (id) => requestMemoryPin(store, id),
    },
  });
  const ok = await remember(
    { key: 'answer-language', value: 'Answer in Korean.', type: 'semantic', scope: 'user', basis: 'stated', evidenceQuote: said, pin: true },
    {} as never,
  );
  const unquoted = await remember(
    { key: 'answer-length', value: 'Keep answers short.', type: 'semantic', scope: 'user', basis: 'inferred', pin: true },
    {} as never,
  );
  const okData = ok.data as { id: string; pin?: string };
  const unquotedData = unquoted.data as { pin?: string } | undefined;
  check(
    '(n) R5: pin with the user\'s verified words waits for the review; without them it is ignored ("unverified")',
    okData.pin === 'requested' && store.getMemoryById(okData.id)?.pinRequested === true && unquotedData?.pin === 'unverified',
    `${okData.pin}/${String(unquotedData?.pin)}`,
  );
  const props = (rememberSchema.parameters as { properties: Record<string, unknown> }).properties;
  check('(n) the tool schema offers `pin` and says when to use it', 'pin' in props && /pin: true/.test(rememberSchema.description));
  store.close();
})();

// ---------------------------------------------------------------------------
// (o) the tier jobs in the queue
// ---------------------------------------------------------------------------
{
  const job = (kind: string): MemoryJob => ({ kind, reason: 'turn', enqueuedAt: 1, attempts: 0, notBefore: 0 });
  const q = enqueueMemoryJob(enqueueMemoryJob([], job('review')), job('archive'));
  const picked = pickNextMemoryJob(q, { now: 10, running: false, blockedUntil: 100, fallbackModel: { engineId: 'x', providerId: 'x' } });
  const seeded = reseedMemoryJobs({ pendingReview: 0, toSummarize: 0, unreviewed: 0, tiers: true }, 1).map((j) => j.kind);
  check(
    '(o) a rate-limit block holds model calls, not the tier passes; a start queues promote + archive',
    picked?.job.kind === 'archive' && seeded.join() === 'promote,archive',
    `${String(picked?.job.kind)} / ${seeded.join()}`,
  );
  check('(o) R1: initialMemoryTier is the store\'s rule', initialMemoryTier({ scope: 'user', provenance: STATED }) === 'long');
  check(
    '(o) promotion is a pure decision',
    decideTierPromotion({ id: 'z', scope: 'user', scopeKey: 'local', type: 'semantic', key: 'k', value: 'v', provenance: { source: 'artifact' }, confidence: 1, status: 'confirmed', createdAt: 0, updatedAt: 0, tier: 'short' }).op === 'none',
  );
}

rmSync(TMP_DIR, { recursive: true, force: true });
console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) process.exit(1);
