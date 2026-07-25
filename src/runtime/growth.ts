// src/runtime/growth.ts
//
// THE TRUST METER (Phase 3, P3-M5) — how far can this agent be trusted to act
// for its user, measured rather than accumulated.
//
// WHY NOT A COUNTER. The obvious "learning rate" is a tally: memories stored,
// turns taken. It is worthless as a trust signal — an agent that stored fifty
// wrong facts would read as fully grown. The strategy doc already rejected this
// (§2.2): the north-star is the EDIT-RATE DECLINE, and edit distance is "a loss
// function, not a dashboard number".
//
// WHAT WE MEASURE INSTEAD. The agent CHECKS IN mid-task: it states how it plans
// to proceed and asks. The user either takes the recommendation or picks
// something else. That single interaction is a labelled prediction —
//
//     hit  = the user took naby's recommended option unchanged
//     miss = the user chose differently, or corrected it
//
// so the hit rate is literally "how often naby already knows what I want". This
// is PRELUDE/CIPHER's metric (Gao et al., NeurIPS 2024 — total edit distance and
// the share of ZERO-EDIT examples, 60% for CIPHER vs 76.7% for an oracle)
// applied to proposals instead of documents. It needs no holdout corpus, no
// consent flow and no second scoring model: the app's own conversation produces
// the labels, which is the same insight as "the approval button is the training
// signal" (strategy §3.1), generalized from tool gates to task decisions.
//
// WHY A CONFIDENCE BOUND, NOT THE RAW RATE. Three-for-three is not 100%. Using
// the raw proportion would let an agent reach "fully grown" on a handful of easy
// calls, which is exactly the false confidence that would make the meter a lie.
// So every stage keys on the WILSON SCORE INTERVAL's lower bound: with little
// evidence it sits far below the observed rate, and it converges upward only as
// the sample grows. Growth therefore has to be EARNED twice — by being right,
// and by being right often enough to prove it.
//
// AND IT CAN GO DOWN. A user's patterns shift; when they do, recent
// recommendations start missing and the bound falls, so the stage regresses.
// That is a feature, not a bug — a meter that only rises is decoration. What the
// UI owes the user then is an honest reason, which is what `diagnoseChange`
// produces (as structured codes; the shell renders them in the user's language).

/** The four visible stages. Only a butterfly may be addressed with `@`. */
export type GrowthStage = 'egg' | 'larva' | 'pupa' | 'butterfly';

/** One row of the ledger. THREE kinds, because accuracy alone is gameable:
 *
 *   checkin     — it asked before an irreversible step; `hit` is the label
 *   autonomous  — it acted without asking; this is what coverage counts
 *   tripwire    — a safety-relevant call was refused by the gate
 *
 * Shape mirrors `EvalEvent` in specs/phase-3-checkin-contracts.md, which
 * realizes the `eval_events` stream P15-03 reserved. The runtime type carries
 * only the fields the METER reads; the store row carries the rest (question
 * text, options, confidence) for the UI and for later axes. */
export type LedgerKind = 'checkin' | 'autonomous' | 'tripwire';

export type CheckinRecord = {
  /** epoch ms — ordering, window cuts, drift detection. */
  at: number;
  /** Which agent (growth is per agent). */
  agentId: string;
  /** Defaults to 'checkin' so pre-existing callers keep working. */
  kind?: LedgerKind;
  /** Coarse kind of work — the per-scope trust axis (§4.9) and the thing a
   *  regression can NAME. */
  taskType?: string;
  /** kind='checkin': the user took the recommendation unchanged. */
  hit?: boolean;
  /** kind='autonomous': the user corrected the result afterwards. The miss
   *  signal for the covered region — without it coverage inflates for free. */
  correctedAfter?: boolean;
  /** Excluded from scoring as degenerate (near-duplicate question, one real
   *  option). Kept and counted, never silently dropped (§7 anti-gaming). */
  excludedFromScoring?: boolean;
};

/** Rows that count toward accuracy: real check-ins that were not excluded. */
function scorable(records: readonly CheckinRecord[]): CheckinRecord[] {
  return records.filter(
    (r) => (r.kind ?? 'checkin') === 'checkin' && !r.excludedFromScoring && r.hit !== undefined,
  );
}

/** How many check-ins must exist before any stage above 'egg' is possible.
 *  Below this the Wilson bound is meaninglessly wide, so the honest reading is
 *  "not measured yet" rather than a number. */
export const GROWTH_MIN_SAMPLE = 5;

/** The recent window the CURRENT stage is computed over. Growth reflects how the
 *  agent is doing NOW, not a lifetime average that a good first week would keep
 *  propping up forever. */
export const GROWTH_WINDOW = 20;

/** Stage cut-offs on the Wilson lower bound. The butterfly line is set at the
 *  zero-edit rate CIPHER reached in the PRELUDE paper (~60%): an agent whose
 *  recommendations are provably taken 3 times in 5 is at the level the
 *  literature treats as working personalization. Reaching a 0.60 LOWER BOUND
 *  needs roughly 17 of the last 20 check-ins to land, which is deliberately hard. */
// Calibrated against what the bound actually does, so a stage means what it says:
//   4 of 5   → 0.38  larva      (one miss in five is not a track record)
//   5 of 5   → 0.57  pupa       (perfect, but five is still a small sample)
//   8 of 8   → 0.68  butterfly  (a clean run long enough to be unlikely by luck)
//  17 of 20  → 0.64  butterfly  (the realistic route: high rate, real sample)
export const PUPA_THRESHOLD = 0.45;
export const BUTTERFLY_THRESHOLD = 0.6;

/** z for a 95% interval. */
const Z_95 = 1.96;

/**
 * Wilson score interval lower bound for a binomial proportion. The standard
 * small-sample-safe alternative to the Wald interval: it stays inside [0,1] and
 * does not collapse to a point estimate at the extremes (0/0 and n/n), which is
 * precisely where a naive rate would report false certainty.
 */
export function wilsonLowerBound(successes: number, trials: number, z: number = Z_95): number {
  if (trials <= 0) return 0;
  const s = Math.max(0, Math.min(successes, trials));
  const n = trials;
  const p = s / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (center - margin) / denom);
}

/** The stage a bound + sample size earns. */
export function stageFor(lowerBound: number, trials: number): GrowthStage {
  if (trials < GROWTH_MIN_SAMPLE) return 'egg';
  if (lowerBound >= BUTTERFLY_THRESHOLD) return 'butterfly';
  if (lowerBound >= PUPA_THRESHOLD) return 'pupa';
  return 'larva';
}

/** Only a butterfly can be addressed directly — the gate the `@` palette and the
 *  engine both key on, so UI and routing can never disagree. */
export function canBeAddressed(stage: GrowthStage): boolean {
  return stage === 'butterfly';
}

// ---------------------------------------------------------------------------
// ADWIN-style change detection (§4.6)
// ---------------------------------------------------------------------------

/** Confidence for the split test. Lower δ = more evidence needed to declare a
 *  change, so the meter does not flap on noise. */
const ADWIN_DELTA = 0.05;

/**
 * Find the most recent CHANGE POINT in a hit/miss sequence, ADWIN-style: try
 * every split, and accept the latest one whose two halves' means differ by more
 * than a Hoeffding-style bound. Returns the index the surviving window STARTS at
 * (0 = no change detected, keep everything).
 *
 * WHY THIS REPLACES A FIXED WINDOW. After a real preference shift, stale rows
 * actively poison the estimate and a fixed window of 20 takes 20 check-ins to
 * flush. Detection lets the window collapse the moment the pattern moves — and
 * the detected index is also the honest basis for the explanation ("we saw the
 * pattern change here, and are counting only from there"), instead of a
 * halves-comparison heuristic.
 */
export function detectChangePoint(records: readonly CheckinRecord[]): number {
  const rows = scorable(records);
  const n = rows.length;
  if (n < 2 * GROWTH_MIN_SAMPLE) return 0; // not enough on both sides to judge
  let cut = 0;
  for (let split = GROWTH_MIN_SAMPLE; split <= n - GROWTH_MIN_SAMPLE; split += 1) {
    const left = rows.slice(0, split);
    const right = rows.slice(split);
    const meanL = left.filter((r) => r.hit).length / left.length;
    const meanR = right.filter((r) => r.hit).length / right.length;
    // Hoeffding bound on the difference of two means (ADWIN's ε_cut), using the
    // harmonic mean of the window sizes.
    const m = 1 / (1 / left.length + 1 / right.length);
    const epsilon = Math.sqrt((1 / (2 * m)) * Math.log(4 / ADWIN_DELTA));
    if (Math.abs(meanL - meanR) > epsilon) cut = split; // keep the LATEST cut
  }
  return cut;
}

/** The computed state of one agent's growth. */
export type GrowthState = {
  stage: GrowthStage;
  /** Progress toward butterfly, 0–100. A PROGRESS figure, not the hit rate:
   *  `lowerBound / BUTTERFLY_THRESHOLD`, capped. The panel shows the underlying
   *  rate next to it so the gauge is never the only number on screen. */
  percent: number;
  /** Wilson lower bound over the recent window — what the stage keys on. */
  lowerBound: number;
  /** Raw observed rate over the recent window (always ≥ lowerBound). */
  observedRate: number;
  hits: number;
  trials: number;
  /** Lifetime totals, for "you have answered N check-ins so far". */
  lifetimeHits: number;
  lifetimeTrials: number;
  /** How many more check-ins are needed before a stage above egg is possible. */
  needsMoreSamples: number;

  // -- the axes beyond accuracy (§5) ---------------------------------------
  /** Share of decisions it made WITHOUT asking. Measured and shown from day
   *  one; not yet a gate (its floor has no evidence-based value — see the doc's
   *  §11), so a low coverage is reported rather than punished. */
  coverage: number;
  /** How many autonomous actions the user had to fix afterwards. */
  correctedAfter: number;
  /** Safety refusals inside the window. Non-zero BLOCKS butterfly outright —
   *  a safety failure must not be averaged away by a good hit rate. */
  tripwires: number;
  /** Check-ins dropped as degenerate. Surfaced so the exclusion is visible. */
  excluded: number;
  /** Where the surviving window starts, if a pattern change was detected. */
  changePointAt?: number;
  /** True when accuracy alone would have earned butterfly but a safety refusal in
   *  the window blocks it. Lets the panel say WHY it stalled at 99%. */
  blockedByTripwire?: boolean;
};

/** Sort newest-last, then take the recent window. */
function recentWindow(records: readonly CheckinRecord[], window: number): CheckinRecord[] {
  return [...records].sort((a, b) => a.at - b.at).slice(-Math.max(1, window));
}

/**
 * Compute an agent's growth from its check-in history. Pure: the same records
 * always give the same stage, so the meter is reproducible and explainable.
 */
export function computeGrowth(
  records: readonly CheckinRecord[],
  opts?: { window?: number; taskType?: string },
): GrowthState {
  const window = opts?.window ?? GROWTH_WINDOW;
  // Per-task-type scoping (§4.9): trust is graduated, the way Claude Code grants
  // it per tool and per directory. A new kind of work starts in its own egg
  // instead of dragging the global number down.
  const scoped = opts?.taskType
    ? records.filter((r) => r.taskType === opts.taskType)
    : records;

  // ADWIN first: if the pattern changed, everything before the change point is
  // stale and must not prop the current stage up. Only then take the recent
  // window — so the effective window is min(detected, GROWTH_WINDOW).
  const ordered = [...scoped].sort((a, b) => a.at - b.at);
  const cut = detectChangePoint(ordered);
  const scorableRows = scorable(ordered);
  const afterChange = cut > 0 ? scorableRows.slice(cut) : scorableRows;
  const recent = recentWindow(afterChange, window);

  const trials = recent.length;
  const hits = recent.filter((r) => r.hit).length;
  const lowerBound = wilsonLowerBound(hits, trials);
  const observedRate = trials > 0 ? hits / trials : 0;

  // The other axes read the SAME time span as accuracy, so the panel never
  // mixes a fresh hit rate with a lifetime coverage figure.
  const since = recent.length > 0 ? recent[0]!.at : 0;
  const spanRows = ordered.filter((r) => r.at >= since);
  const autonomous = spanRows.filter((r) => r.kind === 'autonomous');
  // NOTE the asymmetry, and it is deliberate: a DEGENERATE check-in is excluded
  // from accuracy (it would inflate the hit rate) but still counts here. It asked,
  // so it did not act on its own. Leaving it out would make padding questions
  // free — an agent could ask a hundred meaningless things at no cost to coverage,
  // which is the very hole the exclusion exists to close.
  const checkins = spanRows.filter((r) => (r.kind ?? 'checkin') === 'checkin');
  const tripwires = spanRows.filter((r) => r.kind === 'tripwire').length;
  const decisions = autonomous.length + checkins.length;

  // A safety refusal is a HARD block, not a term in an average (§4.8).
  const accuracyStage = stageFor(lowerBound, trials);
  const blockedByTripwire = tripwires > 0 && accuracyStage === 'butterfly';
  const stage: GrowthStage = blockedByTripwire ? 'pupa' : accuracyStage;
  return {
    stage,
    // An unmeasurable sample reads 0, NOT the bound it happens to produce. A
    // perfect 3-for-3 has a bound of 0.44, which would paint a 73% gauge next to
    // an "egg — not measured yet" label: the number and the word would be telling
    // the user different things, and the number is the one they would believe.
    // While in the egg the panel shows `needsMoreSamples` instead.
    // 100% must mean "butterfly". When a tripwire holds an otherwise-qualified
    // agent back, the accuracy progress really is at the line — but printing
    // "pupa 100%" would have the number and the label contradicting each other
    // again (the same trap as the egg case above), and the number is the one a
    // user believes. So a blocked agent reads 99%: nearly there, not there.
    percent:
      stage === 'egg'
        ? 0
        : blockedByTripwire
          ? Math.min(99, Math.round((lowerBound / BUTTERFLY_THRESHOLD) * 100))
          : Math.min(100, Math.round((lowerBound / BUTTERFLY_THRESHOLD) * 100)),
    lowerBound,
    observedRate,
    hits,
    trials,
    lifetimeHits: scorable(scoped).filter((r) => r.hit).length,
    lifetimeTrials: scorable(scoped).length,
    needsMoreSamples: Math.max(0, GROWTH_MIN_SAMPLE - trials),
    coverage: decisions > 0 ? autonomous.length / decisions : 0,
    correctedAfter: autonomous.filter((r) => r.correctedAfter).length,
    tripwires,
    excluded: spanRows.filter((r) => r.excludedFromScoring).length,
    ...(cut > 0 ? { changePointAt: cut } : {}),
    ...(blockedByTripwire ? { blockedByTripwire: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// Explaining a change (the part the user actually reads)
// ---------------------------------------------------------------------------

/** Why growth moved. STRUCTURED, not prose: the runtime must not hardcode
 *  Korean or English — the shell renders these codes in the user's language
 *  (and the numbers make the sentence specific rather than generic). */
export type GrowthReasonCode =
  | 'not-measured' // below the minimum sample
  | 'new-pattern' // work of a kind it had not seen, and it missed there
  | 'accuracy-drop' // same kind of work, more misses than before
  | 'accuracy-gain' // recommendations landing more often
  | 'evidence-grew' // same rate, but the bound rose because the sample did
  | 'steady';

export type GrowthChange = {
  direction: 'up' | 'down' | 'flat';
  code: GrowthReasonCode;
  /** Percentage points moved (absolute), for the sentence. */
  delta: number;
  /** The kind of work that drove it, when one clearly did. */
  taskType?: string;
  /** Misses in the recent half, for "3 of the last 8 went differently". */
  recentMisses?: number;
  recentTrials?: number;
};

/**
 * Diagnose the most recent movement by comparing the latest half of the window
 * against the half before it. Deliberately DETERMINISTIC — no model call — so the
 * explanation is reproducible, free, and cannot invent a reason.
 *
 * Order of checks is the order of honesty: "we cannot say yet" beats any story;
 * a genuinely new kind of work beats a generic accuracy claim; and a bound that
 * moved only because the sample grew is reported as such rather than dressed up
 * as the agent improving.
 */
export function diagnoseChange(records: readonly CheckinRecord[]): GrowthChange {
  const all = [...records].sort((a, b) => a.at - b.at);
  if (all.length < GROWTH_MIN_SAMPLE) {
    return { direction: 'flat', code: 'not-measured', delta: 0 };
  }
  const recent = all.slice(-Math.ceil(all.length / 2));
  const earlier = all.slice(0, all.length - recent.length);

  const recentHits = recent.filter((r) => r.hit).length;
  const recentBound = wilsonLowerBound(recentHits, recent.length);
  const earlierBound = earlier.length
    ? wilsonLowerBound(earlier.filter((r) => r.hit).length, earlier.length)
    : 0;
  const delta = Math.round(Math.abs(recentBound - earlierBound) * 100);
  const direction: GrowthChange['direction'] =
    recentBound > earlierBound + 0.01 ? 'up' : recentBound < earlierBound - 0.01 ? 'down' : 'flat';

  const recentRate = recent.length ? recentHits / recent.length : 0;
  const earlierRate = earlier.length ? earlier.filter((r) => r.hit).length / earlier.length : 0;
  const recentMisses = recent.length - recentHits;

  // A task type that shows up in the recent half, was absent before, and missed:
  // the most useful thing we can say, because it tells the user WHY and implies
  // what fixes it (answer a few more of these).
  const earlierTypes = new Set(earlier.map((r) => r.taskType).filter(Boolean));
  const newTypeMisses = new Map<string, number>();
  for (const r of recent) {
    if (!r.taskType || r.hit || earlierTypes.has(r.taskType)) continue;
    newTypeMisses.set(r.taskType, (newTypeMisses.get(r.taskType) ?? 0) + 1);
  }
  let worstNewType: string | undefined;
  let worstCount = 0;
  for (const [type, count] of newTypeMisses) {
    if (count > worstCount) {
      worstNewType = type;
      worstCount = count;
    }
  }
  if (direction === 'down' && worstNewType) {
    return {
      direction,
      code: 'new-pattern',
      delta,
      taskType: worstNewType,
      recentMisses,
      recentTrials: recent.length,
    };
  }
  if (direction === 'down') {
    return { direction, code: 'accuracy-drop', delta, recentMisses, recentTrials: recent.length };
  }
  if (direction === 'up') {
    // Distinguish "getting better" from "same rate, firmer evidence" — the second
    // is real progress too, but calling it improvement would be a small lie.
    const code: GrowthReasonCode = recentRate > earlierRate + 0.01 ? 'accuracy-gain' : 'evidence-grew';
    return { direction, code, delta, recentMisses, recentTrials: recent.length };
  }
  return { direction: 'flat', code: 'steady', delta, recentMisses, recentTrials: recent.length };
}
