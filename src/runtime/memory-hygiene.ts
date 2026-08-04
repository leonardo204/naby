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
// Strength + retrievability (P3-M13b —
// specs/phase-3-conversational-learning-hardening.md §3.2)
// ---------------------------------------------------------------------------

/**
 * The ceiling on `MemoryItem.strength` (§3.2).
 *
 * WHY THERE IS ONE AT ALL. Strength rises every time a memory is injected, and
 * an unbounded S makes `R = exp(-t / (S × 30d))` flat: a fact that was useful
 * every day for a year would take decades to go stale, so a preference the user
 * has silently outgrown would outlive them noticing. Twelve caps the effective
 * window at a YEAR of disuse (12 × 30 days) before staleness, which is long
 * enough that a genuinely core fact is never demoted for a summer's absence and
 * short enough that nothing is immortal.
 *
 * It is a TUNABLE, like the two windows above, and being wrong about it is cheap
 * for the same reason: strength only ever moves tie-break order and the review
 * queue, never whether a matching memory is injected.
 */
export const STRENGTH_CAP = 12;

/**
 * The strength of a row, floored at 1 and capped at `STRENGTH_CAP`.
 *
 * THE `?? 1` IS THE MIGRATION, exactly as `memoryLastAccessAt`'s fallback is.
 * A row written before v12 carries no strength, and 1 is the value at which the
 * whole continuous model reduces to the 30/90-day cliffs those rows were living
 * under — so nothing about them changes on the day the column appears. The clamp
 * covers a hand-edited or imported row that claims a thousand.
 */
export function memoryStrength(item: Pick<MemoryItem, 'strength'>): number {
  const raw = typeof item.strength === 'number' && Number.isFinite(item.strength) ? item.strength : 1;
  return Math.min(STRENGTH_CAP, Math.max(1, raw));
}

/** The retrievability at which a memory counts as STALE — `e^(-1)`, i.e. one
 *  full strength-scaled window of disuse. At S = 1 that is exactly 30 days. */
export const STALE_RETRIEVABILITY = Math.exp(-1);

/** The retrievability at which a CONFIRMED memory is offered for review —
 *  `e^(-3)`, three windows. At S = 1 that is exactly 90 days, which is what the
 *  fixed `MEMORY_DECAY_REVIEW_MS` cliff always was. */
export const REVIEW_RETRIEVABILITY = Math.exp(-3);

/**
 * HOW RETRIEVABLE this memory still is, in [0, 1] (§3.2):
 *
 *     R = exp(-t / (S × unitMs)),  t = now - last access
 *
 * The MemoryBank curve (arXiv:2305.10250, AAAI'24), which is the standard shape
 * for exactly naby's situation: an item that keeps being recalled decays more
 * slowly, and forgetting is a DEMOTION rather than a deletion. naby's "selection
 * is access" (P3-M10 §2.1) is the same signal that paper strengthens on, so the
 * two models line up without inventing a new one.
 *
 * WHAT IT IS ALLOWED TO DO, stated here because it is the binding constraint of
 * §3.2 and §4: R lives in the TIE-BREAK layer of the injection ranking and
 * nowhere else. It is never multiplied into relevance. An accumulated year of
 * age can therefore never out-argue a relevance difference — the same reason
 * P3-M10 rejected a decay curve, kept rather than quietly reversed.
 *
 * `unitMs` is the window one unit of strength buys; it defaults to
 * `MEMORY_STALE_MS` so `R < e^-1` and "stale" are the same statement.
 */
export function retrievability(
  item: Pick<MemoryItem, 'updatedAt' | 'lastInjectedAt' | 'strength'>,
  now: number,
  unitMs: number = MEMORY_STALE_MS,
): number {
  const elapsed = Math.max(0, now - memoryLastAccessAt(item));
  const window = Math.max(1, unitMs) * memoryStrength(item);
  return Math.exp(-elapsed / window);
}

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
 * Is this row STALE as of `now` — i.e. has its retrievability fallen below
 * `e^(-1)`?
 *
 * P3-M13b GENERALIZED THE CLIFF WITHOUT MOVING IT. The old rule was
 * `lastAccess < now - staleMs`, i.e. "unused for longer than one fixed window".
 * The new rule is `R < e^(-1)`, which expands to `elapsed > S × staleMs` — the
 * SAME inequality at S = 1, and every pre-v12 row is S = 1. So no existing
 * install's stale set moves on upgrade; what changes is that a memory the turns
 * keep using earns a longer window, up to `STRENGTH_CAP` of them.
 *
 * THE SIGNATURE IS UNCHANGED, deliberately: `staleMs` is still "one window", it
 * is simply scaled by strength now. Every existing caller keeps working and
 * keeps meaning what it meant.
 *
 * STATUS IS NOT PART OF IT. This is the RANKING predicate, and ranking only ever
 * sees confirmed rows (contract §5 filters first), so adding a status test here
 * would be dead weight in the hot path and a second place for the rule to live.
 * The REVIEW queue's "stale" is the narrower question — confirmed AND far enough
 * gone to be worth asking about — and it is asked by `isStaleForReview`.
 */
export function isMemoryStale(
  item: Pick<MemoryItem, 'updatedAt' | 'lastInjectedAt' | 'strength'>,
  now: number,
  staleMs: number = MEMORY_STALE_MS,
): boolean {
  return retrievability(item, now, staleMs) < STALE_RETRIEVABILITY;
}

/**
 * Is this row FAR ENOUGH GONE to be worth asking a person about — `R < e^(-3)`,
 * three strength-scaled windows of disuse (§3.2)?
 *
 * At S = 1 this is exactly `elapsed > reviewMs`, i.e. the fixed 90-day cliff
 * P3-M10 shipped. The `reviewMs / 3` unit is not a fudge: `reviewMs` is defined
 * as THREE staleness windows, so dividing recovers the one-strength-unit window
 * the curve is expressed in, and the two constants stay tied to each other
 * instead of drifting.
 *
 * WHAT CHANGES FOR A REAL USER. The queue stops being "everything old" and
 * becomes "everything that has lost its hold": a memory injected into most weeks
 * never enters it, however many months ago it was first written.
 */
export function isDueForReview(
  item: Pick<MemoryItem, 'updatedAt' | 'lastInjectedAt' | 'strength'>,
  now: number,
  reviewMs: number = MEMORY_DECAY_REVIEW_MS,
): boolean {
  return retrievability(item, now, Math.max(1, reviewMs) / 3) < REVIEW_RETRIEVABILITY;
}

/**
 * Should this row be OFFERED FOR REVIEW as of `now` (§2.2)? Confirmed, and past
 * the review threshold.
 *
 * The confirmed half is the point: a `proposed` row is not stale, it is
 * unanswered, and it already has its own queue. Mixing them would bury the
 * decisions that need a person under the ones that merely could use one.
 */
export function isStaleForReview(
  item: Pick<MemoryItem, 'status' | 'updatedAt' | 'lastInjectedAt' | 'strength'>,
  now: number,
  reviewMs: number = MEMORY_DECAY_REVIEW_MS,
): boolean {
  return item.status === 'confirmed' && isDueForReview(item, now, reviewMs);
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
