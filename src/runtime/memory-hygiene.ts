// src/runtime/memory-hygiene.ts
//
// MEMORY DECAY + SOVEREIGNTY RULES (Phase 3 P3-M10 —
// specs/phase-3-memory-hygiene.md §2 and §3).
//
// Everything here is PURE and DETERMINISTIC: two constants, two predicates about
// a memory row, and the two switches that decide whether a turn may learn at all.
// No model call, no clock of its own (every function takes `now`), no store
// handle. That is what lets a spike drive the real rules with a fixed timestamp
// and get the same answer the app gets.
//
// WHY ONE FILE FOR BOTH HALVES. They are asked by three different layers — the
// injection ranking (runtime), the reflection sweep and the engine composition
// root (shell) — and each layer answering for itself is exactly how a codebase
// ends up with a UI that believes one thing and an engine that does another
// (CLAUDE.md: find the function that already answers the question). So the
// question "is this memory stale?" and the question "may this turn learn?" each
// have exactly ONE implementation, here, and every caller imports it.
//
// THE DECAY POSTURE, stated once (§2.2):
//
//   * Staleness NEVER deletes anything. It never even lowers a relevance score.
//     Its whole effect is to lose a TIE — see memory-inject `rankCandidates`.
//     A stale memory that genuinely matches the turn still wins, because the
//     alternative (confidently answering from a fact nobody has needed in a
//     month) is the failure decay exists to reduce, and dropping a matching fact
//     is a different, worse failure.
//   * The 90-day review queue is DERIVED on read, not stored. There is no
//     `stale` column and no sweep that sets one: a derivation cannot drift out of
//     date, and a flag can. The user decides what happens to a stale row —
//     delete it, or keep it (which stamps access and resets the clock).

import type { MemoryItem, Store } from './store/store.js';

// ---------------------------------------------------------------------------
// The two decay constants (§2.2)
// ---------------------------------------------------------------------------

/**
 * How long a memory goes UNUSED before it loses relevance ties (§2.2, default 30
 * days).
 *
 * A TUNABLE, and openly a guess — spec §6 lists exactly this number as
 * undecided pending real usage. It is short enough that a preference nothing has
 * needed in a month stops crowding out a fresher one, and long enough that a
 * fact you use monthly (a billing routine, a quarterly report format) never
 * crosses it. Being wrong here is cheap by construction: the only consequence is
 * tie-break order.
 */
export const MEMORY_STALE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How long a CONFIRMED memory goes unused before it is offered for review (§2.2,
 * default 90 days) — three times the staleness window, so a row is demoted long
 * before anyone is asked about it.
 *
 * Reaching it does NOTHING on its own. It puts the row behind the browser's
 * "stale" filter, and a person decides. Automatic deletion was considered and
 * rejected: memory is the user's own record of themselves, and an app that
 * quietly discards parts of it is not one you can trust with the rest.
 */
export const MEMORY_DECAY_REVIEW_MS = 90 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Staleness (§2.1 / §2.2)
// ---------------------------------------------------------------------------

/**
 * When this memory was last USED, for decay purposes.
 *
 * `lastInjectedAt` when it exists, `updatedAt` otherwise. THE FALLBACK IS THE
 * MIGRATION: every row written before schema v10 has no access history, and
 * treating "we never recorded it" as "it was never used" would mark a user's
 * entire existing memory stale on the day they updated the app. `updatedAt` is
 * the last moment we KNOW something happened to the row, which is the most
 * generous honest answer — and it is what the SQL `COALESCE` in both drivers
 * computes, so the store and this function can never disagree.
 */
export function memoryLastAccessAt(item: Pick<MemoryItem, 'updatedAt' | 'lastInjectedAt'>): number {
  return item.lastInjectedAt ?? item.updatedAt;
}

/**
 * Is this row STALE as of `now` — i.e. unused for longer than `staleMs`?
 *
 * STATUS IS NOT PART OF IT. This is the RANKING predicate, and ranking only ever
 * sees confirmed rows (contract §5 filters first), so adding a status test here
 * would be dead weight in the hot path and a second place for the rule to live.
 * The REVIEW queue's "stale" is the narrower question — confirmed AND unused for
 * 90 days — and it is asked by `isStaleForReview`.
 */
export function isMemoryStale(
  item: Pick<MemoryItem, 'updatedAt' | 'lastInjectedAt'>,
  now: number,
  staleMs: number = MEMORY_STALE_MS,
): boolean {
  return memoryLastAccessAt(item) < now - staleMs;
}

/**
 * Should this row be OFFERED FOR REVIEW as of `now` (§2.2)? Confirmed, and unused
 * for longer than `reviewMs`.
 *
 * The confirmed half is the point: a `proposed` row is not stale, it is
 * unanswered, and it already has its own queue. Mixing them would bury the
 * decisions that need a person under the ones that merely could use one.
 */
export function isStaleForReview(
  item: Pick<MemoryItem, 'status' | 'updatedAt' | 'lastInjectedAt'>,
  now: number,
  reviewMs: number = MEMORY_DECAY_REVIEW_MS,
): boolean {
  return item.status === 'confirmed' && isMemoryStale(item, now, reviewMs);
}

/** The epoch-ms cutoff a `staleBefore` store query takes, for a given `now`.
 *  One expression, so the API route, the reflection sweep and a spike cannot
 *  each subtract a slightly different window. */
export function staleReviewCutoff(now: number, reviewMs: number = MEMORY_DECAY_REVIEW_MS): number {
  return now - reviewMs;
}

// ---------------------------------------------------------------------------
// Sovereignty: the two switches (§3)
// ---------------------------------------------------------------------------

/**
 * The app-wide "learn from my conversations" setting (§3). Stored as the string
 * `'true'`/`'false'`, matching `gate.allowChanges` and
 * `memory.autoConfirmCorroborated` — one spelling for every boolean setting.
 */
export const MEMORY_LEARNING_ENABLED_KEY = 'memory.learningEnabled';

/**
 * Read the setting. ABSENT READS AS ON, which is the opposite default from
 * `memory.autoConfirmCorroborated` — deliberately, and the asymmetry is the
 * point. Auto-confirmation off-by-default protects the user from something
 * happening silently; learning on-by-default is the product working as described
 * on an install that has never opened Settings. Only an explicit `'false'` turns
 * it off, so a corrupt or half-written value fails toward the documented
 * behaviour rather than toward an agent that has quietly stopped learning.
 */
export function readLearningEnabled(store: Pick<Store, 'getSetting'>): boolean {
  return (store.getSetting(MEMORY_LEARNING_ENABLED_KEY) ?? 'true') !== 'false';
}

/** Write the setting. */
export function writeLearningEnabled(
  store: Pick<Store, 'setSetting'>,
  enabled: boolean,
): void {
  store.setSetting(MEMORY_LEARNING_ENABLED_KEY, enabled ? 'true' : 'false');
}

/**
 * MAY THIS TURN CAPTURE MEMORY? The single predicate both switches feed into
 * (§3), asked by the engine (does the turn get `naby_remember` and the learning
 * instruction?) and by the reflection sweep (may this session produce proposals?).
 *
 * ONE FUNCTION, because the two switches must compose the same way everywhere and
 * because a turn whose TOOL is present but whose INSTRUCTION is absent — or the
 * reverse — is the "silent half-run" the skill injection already refuses. With
 * one predicate the two cannot disagree.
 *
 * NEITHER SWITCH TOUCHES INJECTION. "Stop learning" is not "forget" (§3): already
 * confirmed memory keeps shaping turns in both states, which is why
 * `retrieveForInjection` does not read this.
 */
export function canCaptureMemory(opts: {
  /** The app-wide setting (`readLearningEnabled`). */
  learningEnabled: boolean;
  /** This session's `noLearn` flag — the temporary-session switch. */
  sessionNoLearn: boolean;
}): boolean {
  return opts.learningEnabled && !opts.sessionNoLearn;
}
