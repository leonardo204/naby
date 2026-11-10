// src/runtime/memory-tiers.ts
//
// SHORT, LONG AND ANCHORED MEMORY (specs/memory-tiers.md).
//
// A memory in use (`confirmed`) has a lifetime tier. This file owns every rule
// about tiers that can be stated without a model:
//
//   * which tier a row enters use in (R1–R3);
//   * when it is promoted — short → long (R4), long → anchored (R5, R7) — from
//     OBSERVATIONS (distinct sessions on distinct days, the user's verified
//     restatements), never from a model's opinion;
//   * when it is archived (R8 short / session / transient, R9 long) and when an
//     archived or superseded row is finally deleted (R12, R14);
//   * the once-a-day strength rule (R10);
//   * the anchored injection budget (R15–R17).
//
// The pure functions take rows and evidence and return decisions. The few
// functions at the bottom that take a `Store` (`anchorMemory`, `runTierPromotion`,
// `runTierRetention`…) are thin executors over those decisions — the memory
// worker's tier jobs call them, and so do the API's pin / unpin / restore
// actions, so there is one implementation of each rule.
//
// EVERY NUMBER IS A NAMED TUNABLE. §9 says the durations were chosen, not
// measured; they are exported so a spike can pin them and a later tuning has one
// place to change.

import { estimateTokens, renderMemoryLine } from './memory-inject.js';
import { memoryStrength } from './memory-hygiene.js';
import type {
  MemoryAnchorOrigin,
  MemoryItem,
  MemoryProvenance,
  MemoryTier,
  MemoryTierEvidence,
  Store,
} from './store/store.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Tunables (§9: chosen values, adjusted from real use)
// ---------------------------------------------------------------------------

/** R8: a short-term memory not promoted within this long is archived. */
export const SHORT_TERM_RETENTION_MS = 14 * DAY_MS;
/** R8: a session-scope memory is archived this long after its session ended. */
export const SESSION_MEMORY_RETENTION_MS = 7 * DAY_MS;
/** R8: a transient fact unused for this long is archived. */
export const TRANSIENT_MEMORY_RETENTION_MS = 14 * DAY_MS;
/** R9: a long-term memory survives `min(BASE × S, MAX)` since its last use. */
export const LONG_TERM_BASE_RETENTION_MS = 90 * DAY_MS;
export const LONG_TERM_MAX_RETENTION_MS = 365 * DAY_MS;
/** R11/R12: an archived memory can be restored for this long, then is deleted. */
export const ARCHIVE_RESTORE_WINDOW_MS = 30 * DAY_MS;
/** R14: a superseded memory can be reverted for this long, then is deleted. */
export const SUPERSEDED_RETENTION_MS = 30 * DAY_MS;
/** R4: distinct days (each a distinct session) of corroboration or injection
 *  that promote short → long. */
export const PROMOTE_LONG_MIN_DISTINCT_DAYS = 2;
/** R5: distinct sessions in which the user restated it in their own words. */
export const ANCHOR_MIN_STATED_SESSIONS = 3;
/** R16: the anchored share of the 2,000-token memory budget… */
export const ANCHORED_TOKEN_BUDGET = 500;
/** …and at most this many anchored rows. */
export const ANCHORED_MAX_ROWS = 20;
/** R22: nothing is archived for this long after the v18 migration. */
export const TIER_MIGRATION_GRACE_MS = 30 * DAY_MS;

/** R22: when the v18 migration assigned tiers to an existing install (epoch ms).
 *  Written by the store's migration; absent on a fresh install (no grace). */
export const MEMORY_TIERS_MIGRATED_AT_KEY = 'memory.tiers.migratedAt';
/** R22: the "archiving starts in 30 days" notice has been shown once. */
export const MEMORY_TIERS_NOTICE_SHOWN_KEY = 'memory.tiers.graceNoticeShownAt';
/** R13: per-day archive counts for the "recently learned" line, as JSON
 *  `[{ day: 'YYYY-MM-DD', at, count }]`, newest last, capped. */
export const MEMORY_TIERS_ARCHIVE_LOG_KEY = 'memory.tiers.archiveLog';
const ARCHIVE_LOG_CAP = 30;

// ---------------------------------------------------------------------------
// Calendar days (R4, R10)
// ---------------------------------------------------------------------------

/** Local midnight of the day `at` falls in. The unit both R10 ("once a day")
 *  and R4 ("on different days") count in. */
export function startOfLocalDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** `YYYY-MM-DD` of the local day `at` falls in. */
export function localDayKey(at: number): string {
  const d = new Date(at);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * R10: does an injection at `at` raise strength? Only the first one of a local
 * calendar day does — ten uses in one conversation are one rehearsal, not ten
 * months of life (the spacing effect). A row never injected always does.
 */
export function shouldRaiseStrength(lastInjectedAt: number | undefined, at: number): boolean {
  return lastInjectedAt === undefined || lastInjectedAt < startOfLocalDay(at);
}

/** How many distinct local days a set of per-session entries spans. One entry
 *  per session by construction (the evidence tables key on the session), so
 *  "≥ N distinct days" also means "≥ N distinct sessions on distinct days". */
export function distinctDays(entries: readonly { at: number }[]): number {
  return new Set(entries.map((e) => localDayKey(e.at))).size;
}

// ---------------------------------------------------------------------------
// Entering use (R1–R3)
// ---------------------------------------------------------------------------

/** R3: session-scope memories and transient facts are always short-term. */
export function isAlwaysShortTerm(item: Pick<MemoryItem, 'scope' | 'volatility'>): boolean {
  return item.scope === 'session' || item.volatility === 'transient';
}

/** R4 first bullet: the user said it themselves — `user` tier and `stated`.
 *  The same test R21 applies to existing rows (which carry no quote). */
export function isUserStated(item: Pick<MemoryItem, 'provenance'>): boolean {
  return item.provenance.source === 'user' && item.provenance.basisKind === 'stated';
}

/** memory-tiers R5: a write that carries the user's verified quote, marked
 *  stated, is a restatement in the user's own words. Only a quote that passed
 *  the check is ever stored (memory-auto-apply R30), so its presence is the
 *  verification. */
export function isStatedProvenance(p: Pick<MemoryProvenance, 'basisKind' | 'evidenceQuote'>): boolean {
  return p.basisKind === 'stated' && typeof p.evidenceQuote === 'string' && p.evidenceQuote.length > 0;
}

/**
 * R1: the tier a row enters use in. `long` when the user said it themselves
 * (R4's first bullet is already met), `short` otherwise — and always `short`
 * for R3's two kinds. Anchoring is never entered here: it needs the budget
 * (R16/R17) and announces itself (R6), so it is `anchorMemory`'s job.
 */
export function initialMemoryTier(
  item: Pick<MemoryItem, 'scope' | 'volatility' | 'provenance'>,
): Exclude<MemoryTier, 'anchored'> {
  if (isAlwaysShortTerm(item)) return 'short';
  return isUserStated(item) ? 'long' : 'short';
}

/**
 * R21: the tier the v18 migration gives an existing row in use — `long` for a
 * user-tier stated row or one corroborated in ≥ 2 distinct sessions, `short`
 * otherwise. Never `anchored`: past records carry no emphasis count.
 */
export function migratedMemoryTier(
  item: Pick<MemoryItem, 'scope' | 'volatility' | 'provenance'>,
  distinctSessions: number,
): Exclude<MemoryTier, 'anchored'> {
  if (isAlwaysShortTerm(item)) return 'short';
  if (isUserStated(item) || distinctSessions >= 2) return 'long';
  return 'short';
}

// ---------------------------------------------------------------------------
// Promotion (R4, R5, R7)
// ---------------------------------------------------------------------------

const EMPTY_EVIDENCE: MemoryTierEvidence = { observations: [], injections: [] };

/** R4: does the evidence promote short → long? */
export function meetsLongTermRule(
  item: Pick<MemoryItem, 'scope' | 'volatility' | 'provenance'>,
  evidence: MemoryTierEvidence = EMPTY_EVIDENCE,
): boolean {
  if (isAlwaysShortTerm(item)) return false;
  if (isUserStated(item)) return true;
  if (distinctDays(evidence.observations) >= PROMOTE_LONG_MIN_DISTINCT_DAYS) return true;
  return distinctDays(evidence.injections) >= PROMOTE_LONG_MIN_DISTINCT_DAYS;
}

/** How many distinct sessions restated it in the user's own verified words. */
export function statedSessionCount(evidence: MemoryTierEvidence = EMPTY_EVIDENCE): number {
  return new Set(evidence.observations.filter((o) => o.stated).map((o) => o.sessionId)).size;
}

/**
 * R5 first bullet + R7: may this row be anchored AUTOMATICALLY? Three sessions
 * of the user's own verified restatement; never an external row (R7), never one
 * of R3's kinds, never one whose anchoring the user undid (R6).
 */
export function meetsAutoAnchorRule(
  item: Pick<MemoryItem, 'scope' | 'volatility' | 'provenance' | 'anchorBlocked'>,
  evidence: MemoryTierEvidence = EMPTY_EVIDENCE,
): boolean {
  if (item.anchorBlocked) return false;
  if (item.provenance.source === 'external') return false;
  if (isAlwaysShortTerm(item)) return false;
  return statedSessionCount(evidence) >= ANCHOR_MIN_STATED_SESSIONS;
}

/** May a row be anchored at all by this origin? R7: an external row only by the
 *  user's own pin; R3's kinds only by the user (they end on their own anyway). */
export function mayAnchor(
  item: Pick<MemoryItem, 'scope' | 'volatility' | 'provenance' | 'status' | 'supersededAt' | 'archivedAt'>,
  origin: MemoryAnchorOrigin,
): boolean {
  if (item.status !== 'confirmed' || item.supersededAt !== undefined || item.archivedAt !== undefined) return false;
  if (origin === 'user') return true;
  if (item.provenance.source === 'external') return false;
  return !isAlwaysShortTerm(item);
}

/** What one promotion pass does with one row. */
export type TierPromotion =
  | { op: 'none' }
  | { op: 'long' }
  | { op: 'anchor'; origin: 'auto' };

/**
 * The promotion decision for one row in use (R4, R5). TOTAL and DETERMINISTIC.
 * Anchoring is reported as a WISH — whether it fits the budget is the
 * executor's question (`anchoredBudgetFits`), and a row that does not fit stays
 * where it is, flagged (R17).
 */
export function decideTierPromotion(
  item: MemoryItem,
  evidence: MemoryTierEvidence = EMPTY_EVIDENCE,
): TierPromotion {
  if (item.status !== 'confirmed' || item.supersededAt !== undefined || item.archivedAt !== undefined) {
    return { op: 'none' };
  }
  if (item.tier === 'anchored') return { op: 'none' };
  if (meetsAutoAnchorRule(item, evidence)) return { op: 'anchor', origin: 'auto' };
  if ((item.tier ?? 'short') === 'short' && meetsLongTermRule(item, evidence)) return { op: 'long' };
  return { op: 'none' };
}

// ---------------------------------------------------------------------------
// The anchored budget (R15–R17)
// ---------------------------------------------------------------------------

/** The token cost of one anchored row: its WHOLE value, as injected (R16 —
 *  the summary is display only). */
export function anchoredCost(item: MemoryItem): number {
  return estimateTokens(renderMemoryLine(item));
}

/**
 * The anchored rows that would share a turn with `item`: every user-scope
 * anchored row (they reach every project, R15) plus those of the item's own
 * scope key. The budget is a per-turn budget, so this is the set it is
 * measured against.
 */
export function anchoredPeers(item: Pick<MemoryItem, 'id' | 'scope' | 'scopeKey'>, anchored: readonly MemoryItem[]): MemoryItem[] {
  return anchored.filter(
    (m) =>
      m.id !== item.id &&
      m.tier === 'anchored' &&
      m.archivedAt === undefined &&
      m.supersededAt === undefined &&
      (m.scope === 'user' || m.scope === 'org' || (m.scope === item.scope && m.scopeKey === item.scopeKey)),
  );
}

/** R16/R17: does `item` fit beside the anchored rows it would share a turn with? */
export function anchoredBudgetFits(item: MemoryItem, anchored: readonly MemoryItem[]): boolean {
  const peers = anchoredPeers(item, anchored);
  if (peers.length + 1 > ANCHORED_MAX_ROWS) return false;
  const used = peers.reduce((n, m) => n + anchoredCost(m), 0);
  return used + anchoredCost(item) <= ANCHORED_TOKEN_BUDGET;
}

/**
 * R15/R16: the anchored rows to inject this turn — oldest anchoring first, as
 * many as fit in `ANCHORED_TOKEN_BUDGET` and `ANCHORED_MAX_ROWS` (and the
 * turn's own budget, which may be smaller). Rows that do not fit are counted,
 * never silently dropped. The store's budget check at anchoring time makes
 * that rare; it can still happen when a person edits an anchored value longer.
 */
export function selectAnchoredForInjection(
  candidates: readonly MemoryItem[],
  turnBudget: number,
): { items: MemoryItem[]; tokensUsed: number; dropped: number } {
  const cap = Math.max(0, Math.min(ANCHORED_TOKEN_BUDGET, Math.floor(turnBudget)));
  const anchored = candidates
    .filter(
      (m) =>
        m.tier === 'anchored' &&
        m.status === 'confirmed' &&
        m.supersededAt === undefined &&
        m.archivedAt === undefined,
    )
    .sort(
      (a, b) =>
        (a.tierSince ?? a.createdAt) - (b.tierSince ?? b.createdAt) || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
    );
  const items: MemoryItem[] = [];
  let tokensUsed = 0;
  let dropped = 0;
  for (const item of anchored) {
    const cost = anchoredCost(item);
    if (items.length < ANCHORED_MAX_ROWS && tokensUsed + cost <= cap) {
      items.push(item);
      tokensUsed += cost;
    } else {
      dropped += 1;
    }
  }
  return { items, tokensUsed, dropped };
}

// ---------------------------------------------------------------------------
// Retention and deletion (R8, R9, R11–R14, R18, R22)
// ---------------------------------------------------------------------------

/** R9: how long a long-term memory of strength `S` survives unused. */
export function longTermRetentionMs(strength: number | undefined): number {
  return Math.min(LONG_TERM_BASE_RETENTION_MS * memoryStrength({ strength }), LONG_TERM_MAX_RETENTION_MS);
}

/** The clock retention measures from: the later of the last use and the moment
 *  the row entered its tier — so a restore (R11) or an unpin (R20) restarts it. */
export function memoryTierClock(item: Pick<MemoryItem, 'lastInjectedAt' | 'updatedAt' | 'tierSince'>): number {
  return Math.max(item.lastInjectedAt ?? item.updatedAt, item.tierSince ?? 0);
}

export type RetentionContext = {
  now: number;
  /** R22: archiving is suspended until this instant. */
  graceUntil?: number;
  /** R8: when the row's session was last active (session-scope rows only). */
  sessionLastActiveAt?: number;
};

/** Why a row is archived — for the log, never for a decision. */
export type ArchiveReason = 'short-expired' | 'session-ended' | 'transient-unused' | 'long-unused';

/**
 * The archive decision for one row in use (R8, R9, R18, R22). TOTAL and
 * DETERMINISTIC. An anchored row is never archived (R18); nothing is archived
 * inside the migration grace (R22).
 */
export function decideRetention(item: MemoryItem, ctx: RetentionContext): ArchiveReason | undefined {
  if (item.status !== 'confirmed' || item.supersededAt !== undefined || item.archivedAt !== undefined) return undefined;
  if (item.tier === 'anchored') return undefined;
  if (ctx.graceUntil !== undefined && ctx.now < ctx.graceUntil) return undefined;
  if (item.scope === 'session') {
    const ended = Math.max(ctx.sessionLastActiveAt ?? 0, memoryTierClock(item));
    return ctx.now - ended >= SESSION_MEMORY_RETENTION_MS ? 'session-ended' : undefined;
  }
  if (item.volatility === 'transient') {
    return ctx.now - memoryTierClock(item) >= TRANSIENT_MEMORY_RETENTION_MS ? 'transient-unused' : undefined;
  }
  if ((item.tier ?? 'short') === 'short') {
    const since = item.tierSince ?? item.updatedAt;
    return ctx.now - since >= SHORT_TERM_RETENTION_MS ? 'short-expired' : undefined;
  }
  return ctx.now - memoryTierClock(item) >= longTermRetentionMs(item.strength) ? 'long-unused' : undefined;
}

/** R12/R14: is this row past its restore window and due for deletion? */
export function shouldPurgeMemory(item: Pick<MemoryItem, 'archivedAt' | 'supersededAt'>, now: number): boolean {
  if (item.archivedAt !== undefined && now - item.archivedAt >= ARCHIVE_RESTORE_WINDOW_MS) return true;
  return item.supersededAt !== undefined && now - item.supersededAt >= SUPERSEDED_RETENTION_MS;
}

/** R11 / §6: whole days left before an archived row is deleted (0 = today). */
export function archiveDaysLeft(item: Pick<MemoryItem, 'archivedAt'>, now: number): number | undefined {
  if (item.archivedAt === undefined) return undefined;
  return Math.max(0, Math.ceil((item.archivedAt + ARCHIVE_RESTORE_WINDOW_MS - now) / DAY_MS));
}

/** R22: the instant archiving may begin, or undefined (no migration grace). */
export function readTierGraceUntil(store: Pick<Store, 'getSetting'>): number | undefined {
  try {
    const raw = store.getSetting(MEMORY_TIERS_MIGRATED_AT_KEY);
    const at = raw ? Number(raw) : NaN;
    return Number.isFinite(at) ? at + TIER_MIGRATION_GRACE_MS : undefined;
  } catch {
    return undefined;
  }
}

/** R22: should the memory screen show the one-time grace notice now? */
export function shouldShowTierGraceNotice(store: Pick<Store, 'getSetting'>, now: number): boolean {
  try {
    const until = readTierGraceUntil(store);
    if (until === undefined || now >= until) return false;
    return !store.getSetting(MEMORY_TIERS_NOTICE_SHOWN_KEY);
  } catch {
    return false;
  }
}

export function markTierGraceNoticeShown(store: Pick<Store, 'setSetting'>, now: number): void {
  store.setSetting(MEMORY_TIERS_NOTICE_SHOWN_KEY, String(Math.trunc(now)));
}

/** R13: one archive-log entry per local day. */
export type ArchiveLogEntry = { day: string; at: number; count: number };

export function readArchiveLog(store: Pick<Store, 'getSetting'>): ArchiveLogEntry[] {
  try {
    const raw = store.getSetting(MEMORY_TIERS_ARCHIVE_LOG_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is ArchiveLogEntry =>
        !!e && typeof e === 'object' && typeof (e as ArchiveLogEntry).day === 'string' &&
        typeof (e as ArchiveLogEntry).count === 'number' && typeof (e as ArchiveLogEntry).at === 'number',
    );
  } catch {
    return [];
  }
}

/** Fold `count` archived rows into today's line (R13). Pure. */
export function addToArchiveLog(log: readonly ArchiveLogEntry[], count: number, now: number): ArchiveLogEntry[] {
  if (count <= 0) return [...log];
  const day = localDayKey(now);
  const out = log.filter((e) => e.day !== day);
  const today = log.find((e) => e.day === day);
  out.push({ day, at: Math.trunc(now), count: (today?.count ?? 0) + count });
  return out.slice(-ARCHIVE_LOG_CAP);
}

// ---------------------------------------------------------------------------
// Executors over a Store — the worker jobs and the API actions call these
// ---------------------------------------------------------------------------

export type TierStore = Pick<
  Store,
  | 'getMemoryById'
  | 'setMemoryTierState'
  | 'listTieredMemory'
  | 'getMemoryTierEvidence'
  | 'archiveMemory'
  | 'listMemoryToPurge'
  | 'deleteMemory'
  | 'getSession'
  | 'getSetting'
  | 'setSetting'
>;

export type AnchorResult = 'anchored' | 'already' | 'full' | 'refused' | 'missing';

/**
 * Anchor one row (R5, R16, R17). The budget is checked against the anchored
 * rows the item would share a turn with. When it is full the row keeps its
 * tier and — for naby's own anchoring (auto / explicit) — is flagged as a
 * candidate for "needs checking" (R17). Nothing already anchored is ever
 * lowered to make room.
 */
export function anchorMemory(
  store: Pick<TierStore, 'getMemoryById' | 'setMemoryTierState' | 'listTieredMemory'>,
  id: string,
  origin: MemoryAnchorOrigin,
  now: number = Date.now(),
): AnchorResult {
  const item = store.getMemoryById(id);
  if (!item) return 'missing';
  if (item.tier === 'anchored') return 'already';
  if (!mayAnchor(item, origin)) return 'refused';
  const anchored = store.listTieredMemory({ tier: 'anchored' });
  if (!anchoredBudgetFits(item, anchored)) {
    if (origin !== 'user') {
      store.setMemoryTierState(id, { anchorCandidate: true, pinRequested: false });
    }
    return 'full';
  }
  store.setMemoryTierState(id, {
    tier: 'anchored',
    tierSince: Math.trunc(now),
    anchorOrigin: origin,
    anchorCandidate: false,
    pinRequested: false,
    // A person's own pin lifts an earlier "never again" (it was about naby).
    ...(origin === 'user' ? { anchorBlocked: false } : {}),
  });
  return 'anchored';
}

/**
 * Unanchor one row (R6 undo, R20 unpin): back to `long`, clock restarted, and
 * never anchored AUTOMATICALLY again — otherwise the next pass would re-anchor
 * it on the same three restatements. Returns whether anything changed.
 */
export function unanchorMemory(
  store: Pick<TierStore, 'getMemoryById' | 'setMemoryTierState'>,
  id: string,
  now: number = Date.now(),
): boolean {
  const item = store.getMemoryById(id);
  if (!item || item.tier !== 'anchored') return false;
  store.setMemoryTierState(id, {
    tier: 'long',
    tierSince: Math.trunc(now),
    anchorOrigin: null,
    anchorBlocked: true,
    anchorCandidate: false,
  });
  return true;
}

/**
 * R5 second bullet: the user asked for this to be anchored, with a verified
 * quote of their own words. A row already in use is anchored now; a row still
 * waiting for its review carries the request until the review confirms it
 * (`settlePinRequest`).
 */
export function requestMemoryPin(
  store: Pick<TierStore, 'getMemoryById' | 'setMemoryTierState' | 'listTieredMemory'>,
  id: string,
  now: number = Date.now(),
): AnchorResult | 'requested' {
  const item = store.getMemoryById(id);
  if (!item) return 'missing';
  if (item.status === 'confirmed' && item.reviewState === undefined) return anchorMemory(store, id, 'explicit', now);
  store.setMemoryTierState(id, { pinRequested: true });
  return 'requested';
}

/** After a review confirmed a row: act on a pin request it carried (R5). */
export function settlePinRequest(
  store: Pick<TierStore, 'getMemoryById' | 'setMemoryTierState' | 'listTieredMemory'>,
  id: string,
  now: number = Date.now(),
): AnchorResult | undefined {
  const item = store.getMemoryById(id);
  if (!item?.pinRequested) return undefined;
  if (item.status !== 'confirmed') {
    // Held for a person or refused: the request goes with the decision.
    store.setMemoryTierState(id, { pinRequested: false });
    return 'refused';
  }
  return anchorMemory(store, id, 'explicit', now);
}

export type TierPromotionResult = { long: number; anchored: number; full: number };

/**
 * One promotion pass over every row in use (R4, R5, R17). No model call. Pin
 * requests a review confirmed but nobody acted on are settled first.
 */
export function runTierPromotion(store: TierStore, now: number = Date.now()): TierPromotionResult {
  const result: TierPromotionResult = { long: 0, anchored: 0, full: 0 };
  const rows = store.listTieredMemory();
  for (const row of rows) {
    if (row.pinRequested && row.tier !== 'anchored') {
      const r = settlePinRequest(store, row.id, now);
      if (r === 'anchored') result.anchored += 1;
      else if (r === 'full') result.full += 1;
    }
  }
  const live = store.listTieredMemory().filter((m) => m.tier !== 'anchored');
  if (live.length === 0) return result;
  const evidence = store.getMemoryTierEvidence(live.map((m) => m.id));
  for (const row of live) {
    const decision = decideTierPromotion(row, evidence[row.id]);
    if (decision.op === 'long') {
      store.setMemoryTierState(row.id, { tier: 'long', tierSince: Math.trunc(now) });
      result.long += 1;
    } else if (decision.op === 'anchor') {
      // A short row that already meets R5 passes through long on the way.
      if ((row.tier ?? 'short') === 'short') store.setMemoryTierState(row.id, { tier: 'long', tierSince: Math.trunc(now) });
      const r = row.anchorCandidate && !anchoredBudgetFits(row, store.listTieredMemory({ tier: 'anchored' }))
        ? 'full'
        : anchorMemory(store, row.id, 'auto', now);
      if (r === 'anchored') result.anchored += 1;
      else if (r === 'full') result.full += 1;
    } else if (row.anchorCandidate && !meetsAutoAnchorRule(row, evidence[row.id])) {
      // The candidate no longer qualifies (its value changed, its evidence went).
      store.setMemoryTierState(row.id, { anchorCandidate: false });
    }
  }
  return result;
}

export type TierRetentionResult = { archived: number; purged: number; graceUntil?: number };

/**
 * One retention pass (R8, R9, R12, R13, R14, R22). No model call. Archives due
 * rows, deletes archived and superseded rows past their window (with their
 * evidence, verdicts and summary — `deleteMemory` takes those), and leaves one
 * line per day for "recently learned" (R13). Deletion is not suspended by the
 * migration grace: nothing was archived before the migration, and superseded
 * rows were always revertible for 30 days by design (R14).
 */
export function runTierRetention(store: TierStore, now: number = Date.now()): TierRetentionResult {
  const graceUntil = readTierGraceUntil(store);
  const due: string[] = [];
  const sessionLastActive = new Map<string, number | undefined>();
  for (const row of store.listTieredMemory()) {
    let sessionLastActiveAt: number | undefined;
    if (row.scope === 'session') {
      if (!sessionLastActive.has(row.scopeKey)) {
        let last: number | undefined;
        try {
          last = store.getSession(row.scopeKey)?.lastUsedAt;
        } catch {
          last = undefined;
        }
        sessionLastActive.set(row.scopeKey, last);
      }
      sessionLastActiveAt = sessionLastActive.get(row.scopeKey);
    }
    const reason = decideRetention(row, {
      now,
      ...(graceUntil !== undefined ? { graceUntil } : {}),
      ...(sessionLastActiveAt !== undefined ? { sessionLastActiveAt } : {}),
    });
    if (reason) due.push(row.id);
  }
  // Small batches (memory-worker R3): a user turn's write never waits long.
  let archived = 0;
  for (let i = 0; i < due.length; i += 50) archived += store.archiveMemory(due.slice(i, i + 50), now);
  if (archived > 0) {
    store.setSetting(MEMORY_TIERS_ARCHIVE_LOG_KEY, JSON.stringify(addToArchiveLog(readArchiveLog(store), archived, now)));
  }
  let purged = 0;
  for (const row of store.listMemoryToPurge(now - ARCHIVE_RESTORE_WINDOW_MS, now - SUPERSEDED_RETENTION_MS)) {
    if (row.tier === 'anchored' && row.archivedAt === undefined && row.supersededAt === undefined) continue;
    if (!shouldPurgeMemory(row, now)) continue;
    store.deleteMemory({ id: row.id });
    purged += 1;
  }
  return { archived, purged, ...(graceUntil !== undefined ? { graceUntil } : {}) };
}
