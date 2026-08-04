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
  /** kind='checkin': the agent's OWN stated confidence in its recommendation,
   *  0–1. Recorded but never trusted — `brierScore` measures whether it means
   *  anything (§4.7). */
  confidence?: number;
  /** kind='autonomous': the user corrected the result afterwards. The miss
   *  signal for the covered region — without it coverage inflates for free. */
  correctedAfter?: boolean;
  /** kind='autonomous': epoch ms the session-reflection pass put this action
   *  before its judge (P3-M8d). Set + no `correctedAfter` = a WEAK implicit
   *  accept; absent = never looked at, which is NOT the same thing and must not
   *  be scored as one. Mirrors `EvalEvent.reviewedAt`. */
  reviewedAt?: number;
  /** Excluded from scoring as degenerate (near-duplicate question, one real
   *  option). Kept and counted, never silently dropped (§7 anti-gaming). */
  excludedFromScoring?: boolean;
  /** This row arrived with an IMPORTED agent rather than being observed here
   *  (P3-M6/M7). Kept for the record and ignored by every axis — see
   *  `withoutImported`. */
  imported?: boolean;
  /** kind='checkin': this question was asked inside a FAST-GROWTH (drill)
   *  session (P3-M12c). Stamped by the sink from the SESSION's flag — the model
   *  cannot set it, because a model able to label its own rows could file its
   *  real misses as practice (checkin-contracts §4, invariant 9).
   *
   *  A drill is still a genuine prediction the user answered, so it is evidence;
   *  it is just not the same evidence. It enters the bound at `DRILL_WEIGHT`,
   *  gets its own window and daily cap, and can NEVER fill `GROWTH_MIN_SAMPLE` —
   *  see `drillPool`. */
  drill?: boolean;
};

/**
 * Drop rows that were imported rather than observed on this machine.
 *
 * WHY THE METER IGNORES THEM BY DEFAULT. A ledger measures how well an agent
 * predicts ONE person. A colleague's ledger is their history with their patterns
 * and says nothing about whether the agent knows *you*, and nothing in a file can
 * prove whose history it is. So an imported row is provenance, not evidence: the
 * stage has to be earned again here, which is what "권한은 늘 그 기기의 원장에서
 * 다시 나온다" means in practice.
 *
 * The user can say "this is my own export" at import time, and then the rows come
 * in WITHOUT this flag and count normally. That is a question only they can
 * answer, so it is asked rather than guessed.
 */
function withoutImported(records: readonly CheckinRecord[]): CheckinRecord[] {
  return records.filter((r) => !r.imported);
}

/** Rows that count toward accuracy: real check-ins that were not excluded.
 *
 *  DRILL ROWS ARE NOT AMONG THEM (P3-M12c). Everything downstream of this
 *  function — the minimum sample, the recent window, ADWIN, the Brier axis, the
 *  lifetime totals — is therefore REAL-ONLY by construction rather than by six
 *  separate filters that could drift apart. A drill's only path into the meter is
 *  `drillPool`, at a discount. */
function scorable(records: readonly CheckinRecord[]): CheckinRecord[] {
  return records.filter(
    (r) =>
      (r.kind ?? 'checkin') === 'checkin' &&
      !r.drill &&
      !r.excludedFromScoring &&
      r.hit !== undefined,
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

// ---------------------------------------------------------------------------
// Implicit labels (P3-M8d) — trust-meter §4.11
// ---------------------------------------------------------------------------
//
// THE SECOND LABEL SOURCE, AND WHY IT IS WORTH A QUARTER. Session reflection
// (continuous-learning §4) reads finished conversations and stamps `reviewedAt`
// on every autonomous action it put before its judge. A reviewed action the user
// never corrected is evidence — they had the result in front of them and a
// chance to push back, and did not — but WEAK evidence: silence is not the same
// as approval, and nothing proves they read it closely. So it enters the same
// Wilson bound the check-ins do, at a quarter of their weight:
//
//     s = s_checkin + w·s_implicit     n = n_checkin + w·n_implicit
//
// Four uncorrected actions therefore say as much as one check-in the user
// actually answered.

/** What one uncorrected reviewed action is worth against one answered check-in.
 *  A quarter, because "they did not object" is not "they agreed" (§4.11). */
export const IMPLICIT_WEIGHT = 0.25;

/** How many reviewed actions the implicit pool holds — its OWN window, separate
 *  from `GROWTH_WINDOW`. 40 at weight 0.25 is an effective sample of at most 10,
 *  which is the ceiling that keeps the weak signal from ever outweighing the
 *  explicit one: a full implicit window still counts for less than a full
 *  check-in window. */
export const IMPLICIT_WINDOW = 40;

// ---------------------------------------------------------------------------
// Drill labels (P3-M12c) — fast-evolution §3.4
// ---------------------------------------------------------------------------
//
// THE THIRD LABEL SOURCE, AND WHY IT IS WORTH A HALF. In a fast-growth session
// naby invents a decision the user could plausibly face, commits to what it
// thinks they would pick, and asks. The user's answer grades it. That IS a real
// prediction — the examiner does not mark its own paper, which is the property
// self-scored practice lacks and the reason self-play is otherwise banned from
// this ledger (LLM self-evaluation is measurably self-flattering, NeurIPS 2024
// openreview Ns8zGZ0lmM, and the bias compounds over loops).
//
// But it cannot be worth what real work is worth, for two reasons that have
// nothing to do with the user's honesty:
//
//   1. NABY CHOSE THE QUESTION. It will pick scenarios it has some purchase on,
//      the way any examiner writing its own paper would. Voyager keeps the same
//      separation from the other side — the agent proposes tasks, the ENVIRONMENT
//      judges them (arXiv:2305.16291).
//   2. A HYPOTHETICAL ANSWER IS NOT A DECISION. What someone says they would do
//      about a file they are not actually holding is weaker evidence than what
//      they did when it was their afternoon on the line.
//
// So: half of a real check-in, its own window, a daily cap, and — the load-
// bearing rule — no power whatsoever to fill the minimum sample. Practice can
// speed up a measured agent; it cannot start the measurement.

/** What one answered drill is worth against one real check-in. Heavier than an
 *  implicit accept (0.25, where the user only failed to object) and lighter than
 *  a decision they actually made. */
export const DRILL_WEIGHT = 0.5;

/** How many drills the pool holds — its OWN window, separate from
 *  `GROWTH_WINDOW`. 20 at weight 0.5 is an effective sample of at most 10: half a
 *  check-in window, so a marathon practice session still cannot outweigh the real
 *  record it sits beside. */
export const DRILL_WINDOW = 20;

/** How many drills can count in ONE DAY. Without it, twenty minutes of rapid-fire
 *  practice would fill the whole window, and the fastest route to a stage would be
 *  the one with the least real work in it. Rows past the cap are still STORED and
 *  still shown — they are dropped from SCORING only, which is the same "keep
 *  everything, count honestly" rule the degenerate exclusion follows. */
export const DRILL_DAILY_CAP = 10;

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

// ---------------------------------------------------------------------------
// The second tier of axes (§4.7, §4.5) — measured, shown, and NOT gated on
// ---------------------------------------------------------------------------
//
// Accuracy answers "does it know what I want". These answer two different
// questions that a person deciding whether to delegate actually cares about:
// does it know WHEN IT DOES NOT know, and does it interrupt me at the right
// moments. Neither gates a stage — their thresholds would be numbers invented
// before any real ledger existed (§11) — but both are computed and displayed
// from day one, because an axis nobody can see is an axis nobody fixes.

/**
 * BRIER SCORE over the agent's stated confidence: the mean squared error between
 * what it claimed and what happened. Lower is better; 0 is perfect.
 *
 * The reference point that makes it readable: an agent that always says "0.5"
 * scores exactly 0.25 no matter how often it is right, so **0.25 is the
 * uninformative line.** Below it the confidence carries information; at or above
 * it the number is decoration.
 *
 * This is a DIFFERENT axis from accuracy, and ConfidenceBench (2026) is blunt
 * about why it matters: the most accurate model is not the best calibrated one.
 * Selective automation rests on the second property — "0.8 confident" has to mean
 * "right about 80% of the time" before anyone can safely let it act alone.
 *
 * Returns undefined when no row carried a confidence: an absent axis reads as
 * absent, never as a zero that looks like a perfect score.
 */
export function brierScore(
  records: readonly CheckinRecord[],
): { score: number; samples: number } | undefined {
  const rated = scorable(withoutImported(records)).filter(
    (r) => typeof r.confidence === 'number' && r.confidence >= 0 && r.confidence <= 1,
  );
  if (rated.length === 0) return undefined;
  const total = rated.reduce((sum, r) => {
    const outcome = r.hit ? 1 : 0;
    return sum + (r.confidence! - outcome) ** 2;
  }, 0);
  return { score: total / rated.length, samples: rated.length };
}

/** How well the agent judges WHEN to ask. */
export type AskQuality = {
  /** Of the times it asked, how often the ask was warranted. */
  precision: number;
  /** Of the times an ask was warranted, how often it asked. */
  recall: number;
  /** It asked and the user chose differently — the ask caught a divergence. */
  warrantedAsks: number;
  /** It asked and the user took the recommendation — it already knew. */
  unnecessaryAsks: number;
  /** It acted alone and the user had to fix it — it should have asked. */
  missedAsks: number;
  /** It acted alone and nothing needed fixing. */
  correctSilences: number;
  /** Consequential decisions this is computed over. */
  samples: number;
};

/**
 * Score the DECISION TO ASK as its own classifier, which is what LangSmith does
 * when it grades "did it stop for approval" separately from "was the answer
 * right" (§4.5). Treating every consequential action as one labelled instance:
 *
 *   asked + user diverged   → warranted   (true positive)
 *   asked + user agreed     → unnecessary (false positive)
 *   acted + user corrected  → missed      (false negative)
 *   acted + nothing fixed   → correct silence (true negative)
 *
 * NOTE THE DELIBERATE TENSION with the hit rate: an agent that is always right
 * has LOW ask precision, because every ask turns out to have been unnecessary.
 * That is not a contradiction, it is the signal — it means "you can stop asking
 * about this kind of thing", which is precisely the transition from a supervised
 * agent to a trusted one. The panel therefore shows the pair, never precision
 * alone, or the number would read as a failing grade for an agent doing well.
 *
 * Returns undefined when there is nothing to score.
 */
export function askDecisionQuality(records: readonly CheckinRecord[]): AskQuality | undefined {
  const rows = withoutImported(records);
  // Real asks only (P3-M12c). A drill is naby asking about a situation it made
  // up, so counting it here would grade the decision to ask about a decision that
  // was never going to happen.
  const asks = rows.filter(
    (r) => (r.kind ?? 'checkin') === 'checkin' && !r.drill && r.hit !== undefined,
  );
  const acts = rows.filter((r) => r.kind === 'autonomous');
  if (asks.length + acts.length === 0) return undefined;

  const warrantedAsks = asks.filter((r) => !r.hit).length;
  const unnecessaryAsks = asks.filter((r) => r.hit).length;
  const missedAsks = acts.filter((r) => r.correctedAfter).length;
  const correctSilences = acts.length - missedAsks;

  const askedTotal = warrantedAsks + unnecessaryAsks;
  const neededTotal = warrantedAsks + missedAsks;
  return {
    precision: askedTotal > 0 ? warrantedAsks / askedTotal : 0,
    recall: neededTotal > 0 ? warrantedAsks / neededTotal : 0,
    warrantedAsks,
    unnecessaryAsks,
    missedAsks,
    correctSilences,
    samples: asks.length + acts.length,
  };
}

/** The Brier value an agent scores by always claiming 0.5 — the line below which
 *  its stated confidence starts carrying information. */
export const BRIER_UNINFORMATIVE = 0.25;

/** The computed state of one agent's growth. */
export type GrowthState = {
  stage: GrowthStage;
  /** Progress toward butterfly, 0–100. A PROGRESS figure, not the hit rate:
   *  `lowerBound / BUTTERFLY_THRESHOLD`, capped. The panel shows the underlying
   *  rate next to it so the gauge is never the only number on screen. */
  percent: number;
  /** Wilson lower bound over the recent window — what the stage keys on. Since
   *  P3-M8d it is computed over the check-ins PLUS the implicit pool at
   *  `IMPLICIT_WEIGHT`; with nothing reviewed the implicit terms are 0 and this
   *  is the same number it always was. */
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

  // -- the implicit axis (§4.11, P3-M8d) ------------------------------------
  //
  // RAW COUNTS, plus the weight they entered at. The panel needs all three to
  // say something true: "14 of 15 reviewed actions stood, and they count for a
  // quarter each" is checkable, while a pre-multiplied 3.5 is a number nobody
  // can tie back to anything they remember doing.
  //
  // ABSENT WHEN NOTHING HAS BEEN REVIEWED, deliberately: with an empty pool this
  // state is deep-equal to the pre-M8d one, so the regression invariant ("zero
  // reviewed events ⇒ every number identical") is a property of the shape rather
  // than a promise in a comment.
  /** Reviewed autonomous actions in the implicit window. */
  implicitTrials?: number;
  /** Of those, the ones the user never corrected — the weak accepts. */
  implicitHits?: number;
  /** What each of them counted for against one answered check-in. Sent rather
   *  than hardcoded in the UI: a sentence with a hand-typed 0.25 in it goes
   *  quietly wrong the day the constant is retuned. */
  implicitWeight?: number;

  // -- the drill axis (fast-evolution §3.4, P3-M12c) -------------------------
  //
  // Reported for the same reason as the implicit trio, and one more: the panel
  // has to be able to say "real N · practice M" separately. A gauge that moves on
  // practice while the screen only shows real answers is a number the user will
  // stop believing the first time they notice — and they will notice.
  /** Answered drills inside the drill window, after the daily cap. */
  drillTrials?: number;
  /** How many of them naby called correctly. */
  drillHits?: number;
  /** What each of them counted for against one real check-in. */
  drillWeight?: number;
  /** Where the surviving window starts, if a pattern change was detected. */
  changePointAt?: number;
  /** True when accuracy alone would have earned butterfly but a safety refusal in
   *  the window blocks it. Lets the panel say WHY it stalled at 99%. */
  blockedByTripwire?: boolean;

  // -- the second tier: measured and shown, never gated on ------------------
  /** Mean squared error of its stated confidence over the same window. Absent
   *  when no check-in carried one — never 0, which would look perfect. */
  brier?: number;
  brierSamples: number;
  /** How well it judges when to ask. Absent when there is nothing to score. */
  ask?: AskQuality;
};

/** Sort newest-last, then take the recent window. */
function recentWindow(records: readonly CheckinRecord[], window: number): CheckinRecord[] {
  return [...records].sort((a, b) => a.at - b.at).slice(-Math.max(1, window));
}

/**
 * The rows the implicit half of the bound is computed over (§4.11): autonomous
 * actions that reflection has REVIEWED, newest `IMPLICIT_WINDOW` of them.
 *
 * @param ordered  the agent's rows, oldest first, imported ones already dropped
 * @param afterAt  the ADWIN cut's timestamp when a pattern change was detected.
 *   Rows at or before it are stale for exactly the reason the explicit ones are:
 *   the change point says the user's preferences moved, and an accept from
 *   before the move is evidence about a person who has since changed their mind.
 *
 * Returns [] when nothing has been reviewed — which is what makes the regression
 * invariant structural rather than a special case: an empty pool contributes
 * 0 to both s and n, so every number is arithmetically identical to what it was
 * before this section existed.
 */
function implicitPool(ordered: readonly CheckinRecord[], afterAt?: number): CheckinRecord[] {
  const pool = ordered.filter(
    (r) =>
      r.kind === 'autonomous' &&
      typeof r.reviewedAt === 'number' &&
      // A row excluded from scoring is excluded from BOTH halves. The exclusion
      // exists so a degenerate observation cannot buy score, and an implicit
      // accept is score.
      !r.excludedFromScoring &&
      (afterAt === undefined || r.at > afterAt),
  );
  return pool.slice(-IMPLICIT_WINDOW);
}

/**
 * Apply `DRILL_DAILY_CAP` to a chronological run of drills: within one calendar
 * day only the FIRST `DRILL_DAILY_CAP` of them count.
 *
 * THE DAY IS THE UTC CALENDAR DAY, not a rolling 24-hour window, and the choice
 * is deliberate. A rolling window makes "does this row count" depend on which
 * other rows exist near it, so the same ledger can score differently depending on
 * where the sweep starts — and the answer would silently change as time passed
 * even though nothing was added. A calendar bucket is stable, reproducible and
 * explainable to a user in one sentence ("ten a day count"), which is worth more
 * here than the marginal fairness of a sliding boundary.
 *
 * FIRST-OF-DAY rather than last: the cap exists to stop a practice binge from
 * filling the window, and taking the earliest rows means an honest morning of
 * work is not retroactively erased by an evening of grinding.
 *
 * Rows are never mutated — the overflow is simply not returned, exactly as the
 * excluded-but-kept rule requires.
 */
function capDrillsPerDay(ordered: readonly CheckinRecord[]): CheckinRecord[] {
  const perDay = new Map<number, number>();
  const kept: CheckinRecord[] = [];
  for (const r of ordered) {
    const day = Math.floor(r.at / 86_400_000); // UTC day index
    const seen = perDay.get(day) ?? 0;
    if (seen >= DRILL_DAILY_CAP) continue;
    perDay.set(day, seen + 1);
    kept.push(r);
  }
  return kept;
}

/**
 * The rows the drill half of the bound is computed over (§3.4): answered check-ins
 * from fast-growth sessions, capped per day and cut to the newest `DRILL_WINDOW`.
 *
 * @param ordered  the agent's rows, oldest first, imported ones already dropped
 * @param afterAt  the ADWIN cut's timestamp when a pattern change was detected.
 *   Drills from before the cut are stale for the same reason the explicit and
 *   implicit rows are: the detector said this user's preferences moved, and
 *   practice against the person they used to be is not evidence about the person
 *   they are now.
 *
 * The degenerate defence needs no special case here. A drill goes through the
 * SAME sink as a real check-in, so `degenerateReason` compares it against
 * `recentQuestions` — which reads the ledger by kind, not by drill flag — and a
 * near-duplicate lands with `excludedFromScoring` set and is filtered out below.
 * That is what stops naby from asking one easy question twenty ways.
 */
function drillPool(ordered: readonly CheckinRecord[], afterAt?: number): CheckinRecord[] {
  const pool = ordered.filter(
    (r) =>
      (r.kind ?? 'checkin') === 'checkin' &&
      r.drill === true &&
      !r.excludedFromScoring &&
      r.hit !== undefined &&
      (afterAt === undefined || r.at > afterAt),
  );
  return capDrillsPerDay(pool).slice(-DRILL_WINDOW);
}

/**
 * Compute an agent's growth from its check-in history. Pure: the same records
 * always give the same stage, so the meter is reproducible and explainable.
 */
export function computeGrowth(
  allRecords: readonly CheckinRecord[],
  opts?: { window?: number; taskType?: string },
): GrowthState {
  const window = opts?.window ?? GROWTH_WINDOW;
  const records = withoutImported(allRecords);
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

  // THE IMPLICIT HALF (§4.11, P3-M8d). Its own window, drawn from the same
  // change-point cut: the ADWIN test runs on the EXPLICIT sequence only (the
  // labels a user actually gave), and whatever it declares stale for them is
  // stale for the weak labels too. The cut's timestamp is the last row the
  // detector threw away, so an action taken after the pattern moved still counts.
  const cutAt = cut > 0 ? scorableRows[cut - 1]?.at : undefined;
  const implicit = implicitPool(ordered, cutAt);
  const implicitTrials = implicit.length;
  const implicitHits = implicit.filter((r) => !r.correctedAfter).length;

  // THE DRILL HALF (§3.4, P3-M12c). Same treatment as the implicit pool — its own
  // window, the same change-point cut — and one extra rule that is the whole
  // point of the section: practice does not enter the bound AT ALL until the real
  // record has reached the minimum sample. Otherwise an agent with four real
  // answers and twenty drills would leave the egg on the strength of questions it
  // wrote itself, which is precisely the loop §2 of the spec forbids. Below the
  // minimum the stage is 'egg' regardless, so this only keeps the BOUND honest;
  // the raw counts are still reported (below), because a panel that hides the
  // practice while the gauge moves is a panel nobody can audit.
  const drills = drillPool(ordered, cutAt);
  const drillTrials = drills.length;
  const drillHits = drills.filter((r) => r.hit).length;
  const drillsCount = trials >= GROWTH_MIN_SAMPLE;
  const drillTrialsScored = drillsCount ? drillTrials : 0;
  const drillHitsScored = drillsCount ? drillHits : 0;

  // The blend. `hits`/`trials` stay the EXPLICIT counts, because they are what
  // the panel prints as "guessed right, N of M" and what the stage's minimum
  // sample counts — only the bound is blended.
  const lowerBound = wilsonLowerBound(
    hits + DRILL_WEIGHT * drillHitsScored + IMPLICIT_WEIGHT * implicitHits,
    trials + DRILL_WEIGHT * drillTrialsScored + IMPLICIT_WEIGHT * implicitTrials,
  );
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
  // Drills are left out of coverage too (P3-M12c): they measure whether naby can
  // predict this user, not whether it interrupts them at the right moments, and a
  // practice run would otherwise make its "handled without asking" share collapse
  // for having practised.
  const checkins = spanRows.filter((r) => (r.kind ?? 'checkin') === 'checkin' && !r.drill);
  const tripwires = spanRows.filter((r) => r.kind === 'tripwire').length;
  const decisions = autonomous.length + checkins.length;

  const brier = brierScore(spanRows);
  const ask = askDecisionQuality(spanRows);

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
    excluded: spanRows.filter((r) => r.excludedFromScoring && !r.drill).length,
    ...(implicitTrials > 0
      ? { implicitTrials, implicitHits, implicitWeight: IMPLICIT_WEIGHT }
      : {}),
    // RAW drill counts, and the weight they entered at — the same shape (and the
    // same reasoning) as the implicit trio: all three absent when nothing was
    // practised, so a ledger with no drills is deep-equal to a pre-M12c one.
    ...(drillTrials > 0 ? { drillTrials, drillHits, drillWeight: DRILL_WEIGHT } : {}),
    ...(cut > 0 ? { changePointAt: cut } : {}),
    ...(blockedByTripwire ? { blockedByTripwire: true } : {}),
    // Computed over the SAME span as accuracy, so the panel never mixes a recent
    // hit rate with a lifetime calibration figure.
    ...(brier ? { brier: brier.score } : {}),
    brierSamples: brier?.samples ?? 0,
    ...(ask ? { ask } : {}),
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
  /** How far the Wilson BOUND moved between the two halves, in absolute points
   *  (0–100). NOT the same scale as `GrowthState.percent`, which is the bound
   *  normalized against the butterfly threshold — a 9-point bound move is a
   *  ~15-point gauge move. Named for the scale on purpose: a panel that printed
   *  this next to the gauge as "down 9%" would have two numbers on screen
   *  disagreeing, which is the trap the egg-0% and blocked-99% rules already
   *  exist to avoid. Lead the sentence with `recentMisses`/`recentTrials`, which
   *  the user can verify against their own conversation. */
  boundDeltaPoints: number;
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
  // Drills are excluded here too (P3-M12c): this sentence explains a movement of
  // the REAL record to the user, and "your patterns changed" must not be inferred
  // from questions naby invented for practice.
  const all = withoutImported(records)
    .filter((r) => !r.drill)
    .sort((a, b) => a.at - b.at);
  if (all.length < GROWTH_MIN_SAMPLE) {
    return { direction: 'flat', code: 'not-measured', boundDeltaPoints: 0 };
  }
  const recent = all.slice(-Math.ceil(all.length / 2));
  const earlier = all.slice(0, all.length - recent.length);

  const recentHits = recent.filter((r) => r.hit).length;
  const recentBound = wilsonLowerBound(recentHits, recent.length);
  const earlierBound = earlier.length
    ? wilsonLowerBound(earlier.filter((r) => r.hit).length, earlier.length)
    : 0;
  const boundDeltaPoints = Math.round(Math.abs(recentBound - earlierBound) * 100);
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
      boundDeltaPoints,
      taskType: worstNewType,
      recentMisses,
      recentTrials: recent.length,
    };
  }
  if (direction === 'down') {
    return { direction, code: 'accuracy-drop', boundDeltaPoints, recentMisses, recentTrials: recent.length };
  }
  if (direction === 'up') {
    // Distinguish "getting better" from "same rate, firmer evidence" — the second
    // is real progress too, but calling it improvement would be a small lie.
    const code: GrowthReasonCode = recentRate > earlierRate + 0.01 ? 'accuracy-gain' : 'evidence-grew';
    return { direction, code, boundDeltaPoints, recentMisses, recentTrials: recent.length };
  }
  return { direction: 'flat', code: 'steady', boundDeltaPoints, recentMisses, recentTrials: recent.length };
}
