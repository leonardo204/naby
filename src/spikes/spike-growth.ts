// src/spikes/spike-growth.ts
//
// Phase 3 (P3-M5) verification: THE TRUST METER's arithmetic.
//
// The meter's whole value is that a user can believe it, so the properties below
// are the product, not implementation details. Each check states the property in
// the terms a sceptical user would ask it in.
//
// Asserted:
//   (a) A perfect but tiny record does NOT reach butterfly — 3/3 is not proof.
//   (b) Butterfly requires being right AND proving it: the same 85% rate reaches
//       it at n=20 but not at n=5.
//   (c) The bound never exceeds the observed rate, and both stay in [0,1].
//   (d) The stage REGRESSES when recent recommendations start missing.
//   (e) A regression caused by a NEW kind of work is diagnosed as such, naming
//       the task type — not as a generic accuracy drop.
//   (f) A rise from more evidence at the same rate is reported as 'evidence-grew',
//       not as the agent getting better.
//   (g) Only a butterfly may be addressed with `@`.
//   (h) The window is recent-weighted: an old perfect streak cannot hold the
//       stage up once recent work misses.
//   (j) An IMPORTED ledger grants no stage — a file cannot declare trust — and
//       does not disturb the rows actually observed here.
//   (k) The Brier axis separates being right from knowing when you are wrong: the
//       same hit rate can score differently, and 0.5-always is exactly the line.
//   (l) Ask precision and recall grade the decision to ask, and the tension with
//       a high hit rate is real rather than a bug.
// P3-M8d — the IMPLICIT half of the bound (trust-meter §4.11):
//   (n) THE REGRESSION INVARIANT: with nothing reviewed, every number the meter
//       exports is identical to what it was before the blend existed.
//   (o) Uncorrected reviewed actions raise the bound; corrected ones lower it.
//   (p) Implicit evidence alone cannot leave the egg — 40 clean actions and no
//       check-in is still "not measured".
//   (q) The implicit window caps at IMPLICIT_WINDOW, and the weight is real
//       (40 clean actions move the bound by less than 10 check-ins would).
//   (r) A detected change point drops the implicit rows from before the cut.
// P3-M12c — DRILLS, the discounted third label source (fast-evolution §3.4):
//   (s) Practice cannot start the measurement: drills alone leave an egg, and a
//       ledger four real answers short stays an egg however much was practised.
//   (t) The blend is exactly `s + 0.5·drill_s` over `n + 0.5·drill_n`, and the
//       real counts the panel prints are untouched by it.
//   (u) The daily cap holds: twelve drills in one day count as ten, and the
//       eleventh and twelfth are ignored rather than deleted.
//   (v) The drill window caps at DRILL_WINDOW, across days that each respect the
//       cap.
//   (w) NO DRILL PERTURBS AN EXISTING AXIS: with drills added, every other number
//       the meter exports is identical to the same ledger without them.
//
// Pure arithmetic, no store and no engine — runs in milliseconds.

import {
  BRIER_UNINFORMATIVE,
  askDecisionQuality,
  brierScore,
  BUTTERFLY_THRESHOLD,
  DRILL_DAILY_CAP,
  DRILL_WEIGHT,
  DRILL_WINDOW,
  GROWTH_MIN_SAMPLE,
  GROWTH_WINDOW,
  IMPLICIT_WEIGHT,
  IMPLICIT_WINDOW,
  canBeAddressed,
  computeGrowth,
  diagnoseChange,
  stageFor,
  wilsonLowerBound,
  type CheckinRecord,
} from '../runtime/growth.js';
// THE METER AS IT WAS, verbatim at c3a6613 (see the file's own header). Checking
// the blend against the code that implements the blend would prove nothing; this
// is the independent witness the regression invariant is measured against.
import {
  computeGrowth as preComputeGrowth,
  type CheckinRecord as PreCheckinRecord,
} from './fixtures/growth-pre-m8d.js';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

/** n check-ins, the first `hits` of them landing. `at` increases so ordering is
 *  unambiguous; `t0` lets a test place a run earlier or later in time. */
function runOf(hits: number, n: number, opts?: { t0?: number; taskType?: string }): CheckinRecord[] {
  const t0 = opts?.t0 ?? 1_000;
  return Array.from({ length: n }, (_, i) => ({
    at: t0 + i,
    agentId: 'a1',
    hit: i < hits,
    ...(opts?.taskType ? { taskType: opts.taskType } : {}),
  }));
}

// ---- (a) a tiny perfect record is not proof -------------------------------
{
  const g = computeGrowth(runOf(3, 3));
  record(
    '(a) 3-for-3 is not a butterfly — a tiny perfect record proves nothing',
    g.stage !== 'butterfly' && g.observedRate === 1 && g.lowerBound < BUTTERFLY_THRESHOLD,
    `observed=100% bound=${g.lowerBound.toFixed(3)} stage=${g.stage} percent=${g.percent}`,
  );
  record(
    '(a1) a perfect 3 stays an egg AND reads 0% — the gauge never contradicts the label',
    g.stage === 'egg' && g.percent === 0 && g.needsMoreSamples === GROWTH_MIN_SAMPLE - 3,
    `3/3 → stage=${g.stage} percent=${g.percent}% needsMore=${g.needsMoreSamples} (bound would be ${g.lowerBound.toFixed(3)})`,
  );
  const egg = computeGrowth(runOf(2, 2));
  record(
    `(a2) below ${GROWTH_MIN_SAMPLE} check-ins the meter says "not measured" (egg)`,
    egg.stage === 'egg' && egg.needsMoreSamples === GROWTH_MIN_SAMPLE - 2,
    `trials=${egg.trials} stage=${egg.stage} needsMore=${egg.needsMoreSamples}`,
  );
  const five = computeGrowth(runOf(5, 5));
  const eight = computeGrowth(runOf(8, 8));
  record(
    '(a3) a perfect 5 reaches pupa but NOT butterfly; a perfect 8 does',
    five.stage === 'pupa' && eight.stage === 'butterfly',
    `5/5 → ${five.stage} (bound ${five.lowerBound.toFixed(3)}); 8/8 → ${eight.stage} (bound ${eight.lowerBound.toFixed(3)})`,
  );
  const oneMiss = computeGrowth(runOf(4, 5));
  record(
    '(a4) one miss in five keeps it a larva — a track record, not a lucky streak',
    oneMiss.stage === 'larva',
    `4/5 → ${oneMiss.stage} (bound ${oneMiss.lowerBound.toFixed(3)}, observed ${Math.round(oneMiss.observedRate * 100)}%)`,
  );
}

// ---- (b) same rate, different evidence ------------------------------------
{
  const small = computeGrowth(runOf(4, 5)); // 80%, n=5
  const large = computeGrowth(runOf(17, 20)); // 85%, n=20
  record(
    '(b) butterfly needs the sample too: 80% of 5 falls short, 85% of 20 clears',
    small.stage !== 'butterfly' && large.stage === 'butterfly',
    `n=5 80% → bound=${small.lowerBound.toFixed(3)} (${small.stage}); n=20 85% → bound=${large.lowerBound.toFixed(3)} (${large.stage})`,
  );
}

// ---- (c) the bound is a conservative estimate, always ---------------------
{
  let ok = true;
  const detail: string[] = [];
  for (const [s, n] of [[0, 1], [1, 1], [3, 7], [10, 10], [0, 20], [13, 20], [50, 50]] as const) {
    const lb = wilsonLowerBound(s, n);
    const rate = s / n;
    if (!(lb >= 0 && lb <= 1 && lb <= rate + 1e-9)) ok = false;
    detail.push(`${s}/${n}: rate=${rate.toFixed(2)} lb=${lb.toFixed(3)}`);
  }
  // Degenerate inputs must not produce NaN — a NaN would render as a blank gauge.
  const zero = wilsonLowerBound(0, 0);
  if (!Number.isFinite(zero) || zero !== 0) ok = false;
  record('(c) the bound never exceeds the observed rate and stays in [0,1]', ok, detail.join('; '));
}

// ---- (d)+(h) regression when recent work misses ---------------------------
{
  // A full window of perfect work, then 8 misses arriving later in time.
  const grown = [...runOf(20, 20, { t0: 1_000 })];
  const before = computeGrowth(grown);
  const after = computeGrowth([...grown, ...runOf(0, 8, { t0: 5_000 })]);
  record(
    '(d) the stage regresses when recent recommendations start missing',
    before.stage === 'butterfly' && after.stage !== 'butterfly' && after.percent < before.percent,
    `before: ${before.stage} ${before.percent}% (bound ${before.lowerBound.toFixed(3)}) → after: ${after.stage} ${after.percent}% (bound ${after.lowerBound.toFixed(3)})`,
  );
  record(
    '(h) change detection DROPS the stale streak instead of waiting for it to age out',
    after.changePointAt !== undefined &&
      after.hits === 0 &&
      after.trials <= GROWTH_WINDOW &&
      after.lifetimeTrials === 28,
    `changePointAt=${String(after.changePointAt)} window=${after.hits}/${after.trials} (lifetime ${after.lifetimeHits}/${after.lifetimeTrials})`,
  );
}

// ---- (i) no false positive: a steady sequence keeps its whole window ------
{
  const steady: CheckinRecord[] = [];
  for (let i = 0; i < 24; i += 1) {
    steady.push({ at: 1_000 + i, agentId: 'a1', hit: i % 5 !== 4 }); // a flat 80%
  }
  const g = computeGrowth(steady);
  record(
    '(i) a steady pattern triggers NO change point — the meter must not flap on noise',
    g.changePointAt === undefined && g.trials === GROWTH_WINDOW,
    `changePointAt=${String(g.changePointAt)} trials=${g.trials} bound=${g.lowerBound.toFixed(3)} stage=${g.stage}`,
  );
}

// ---- (j) coverage is measured, and correction is not free -----------------
{
  const mixed: CheckinRecord[] = [
    ...runOf(8, 8, { t0: 1_000 }), // 8 check-ins, all hits
    // 12 autonomous actions, 2 of which the user had to fix afterwards
    ...Array.from({ length: 12 }, (_, i) => ({
      at: 2_000 + i,
      agentId: 'a1',
      kind: 'autonomous' as const,
      correctedAfter: i < 2,
    })),
  ];
  const g = computeGrowth(mixed);
  record(
    '(j) coverage counts what it did WITHOUT asking, and corrections are recorded',
    Math.abs(g.coverage - 12 / 20) < 1e-9 && g.correctedAfter === 2 && g.trials === 8,
    `coverage=${(g.coverage * 100).toFixed(0)}% correctedAfter=${g.correctedAfter} accuracy window=${g.hits}/${g.trials}`,
  );
}

// ---- (k) a tripwire blocks butterfly outright -----------------------------
{
  const clean = computeGrowth(runOf(17, 20, { t0: 1_000 }));
  const withTripwire = computeGrowth([
    ...runOf(17, 20, { t0: 1_000 }),
    { at: 1_500, agentId: 'a1', kind: 'tripwire' },
  ]);
  record(
    '(k) one safety refusal blocks butterfly, and the gauge stops short of 100%',
    clean.stage === 'butterfly' &&
      clean.percent === 100 &&
      withTripwire.stage !== 'butterfly' &&
      withTripwire.percent === 99 &&
      withTripwire.blockedByTripwire === true &&
      withTripwire.tripwires === 1,
    `clean=${clean.stage} ${clean.percent}%; with a tripwire=${withTripwire.stage} ${withTripwire.percent}% (bound unchanged at ${withTripwire.lowerBound.toFixed(3)}, blocked=${String(withTripwire.blockedByTripwire)})`,
  );
}

// ---- (l) trust is per task type, not one global number --------------------
{
  const mixed = [
    ...runOf(10, 10, { t0: 1_000, taskType: 'writing' }),
    ...runOf(0, 6, { t0: 2_000, taskType: 'sql-review' }),
  ];
  const writing = computeGrowth(mixed, { taskType: 'writing' });
  const sql = computeGrowth(mixed, { taskType: 'sql-review' });
  record(
    '(l) a butterfly at writing can still be an egg at a new kind of work',
    writing.stage === 'butterfly' && sql.stage !== 'butterfly',
    `writing=${writing.stage} ${writing.percent}% (${writing.hits}/${writing.trials}); sql-review=${sql.stage} ${sql.percent}% (${sql.hits}/${sql.trials})`,
  );
}

// ---- (m) degenerate check-ins are excluded but counted --------------------
{
  const g = computeGrowth([
    ...runOf(5, 5, { t0: 1_000 }),
    ...Array.from({ length: 4 }, (_, i) => ({
      at: 2_000 + i,
      agentId: 'a1',
      hit: true,
      excludedFromScoring: true,
    })),
  ]);
  record(
    '(m) degenerate check-ins do not inflate the score, and the exclusion is visible',
    g.trials === 5 && g.excluded === 4,
    `scored=${g.hits}/${g.trials} excluded=${g.excluded} stage=${g.stage} (4 padded hits ignored)`,
  );
}

// ---- (e) a new kind of work is named -------------------------------------
{
  const history = [
    ...runOf(10, 10, { t0: 1_000, taskType: 'writing' }),
    // A kind it has never seen, and it misses on all of them.
    ...runOf(0, 6, { t0: 9_000, taskType: 'sql-review' }),
  ];
  const change = diagnoseChange(history);
  record(
    '(e) a drop caused by unfamiliar work is diagnosed as a new pattern, and named',
    change.direction === 'down' && change.code === 'new-pattern' && change.taskType === 'sql-review',
    `direction=${change.direction} code=${change.code} taskType=${change.taskType} boundDelta=${change.boundDeltaPoints}pp misses=${change.recentMisses}/${change.recentTrials}`,
  );

  // Same drop, but the work is of a kind it already knew: that is an accuracy
  // drop, and claiming "new pattern" would be a fabricated excuse.
  const familiar = [
    ...runOf(10, 10, { t0: 1_000, taskType: 'writing' }),
    ...runOf(0, 6, { t0: 9_000, taskType: 'writing' }),
  ];
  const c2 = diagnoseChange(familiar);
  record(
    '(e2) the same drop on FAMILIAR work is not blamed on a new pattern',
    c2.direction === 'down' && c2.code === 'accuracy-drop' && c2.taskType === undefined,
    `direction=${c2.direction} code=${c2.code} taskType=${String(c2.taskType)}`,
  );
}

// ---- (f) evidence growth is not called improvement ------------------------
{
  // Same 80% rate throughout; the bound rises purely because n grew.
  const steadyRate: CheckinRecord[] = [];
  for (let i = 0; i < 30; i += 1) {
    steadyRate.push({ at: 1_000 + i, agentId: 'a1', hit: i % 5 !== 4 });
  }
  const change = diagnoseChange(steadyRate);
  record(
    '(f) a rise from firmer evidence is reported as such, not as improvement',
    change.direction !== 'down' && change.code !== 'accuracy-gain',
    `direction=${change.direction} code=${change.code} boundDelta=${change.boundDeltaPoints}pp`,
  );

  const improving = [...runOf(2, 10, { t0: 1_000 }), ...runOf(10, 10, { t0: 9_000 })];
  const up = diagnoseChange(improving);
  record(
    '(f2) genuine improvement IS reported as an accuracy gain',
    up.direction === 'up' && up.code === 'accuracy-gain',
    `direction=${up.direction} code=${up.code} boundDelta=${up.boundDeltaPoints}pp`,
  );
}

// ---- (g) the addressing gate ---------------------------------------------
{
  const gate = (['egg', 'larva', 'pupa', 'butterfly'] as const).map(
    (s) => `${s}=${canBeAddressed(s)}`,
  );
  record(
    '(g) only a butterfly may be addressed with @',
    !canBeAddressed('egg') &&
      !canBeAddressed('larva') &&
      !canBeAddressed('pupa') &&
      canBeAddressed('butterfly') &&
      stageFor(0.99, 2) === 'egg',
    `${gate.join(' ')}; a 0.99 bound on 2 samples still reads ${stageFor(0.99, 2)}`,
  );
}

// -- (j) an imported ledger cannot hand an agent a stage --------------------
{
  // 20 perfect rows that came in with an imported agent. If they counted, this
  // would read butterfly 100% the moment the file landed — a stage declared by a
  // file rather than earned here, which is exactly what the export format refuses
  // to let an artifact do.
  const imported = runOf(20, 20).map((r) => ({ ...r, imported: true }));
  const cold = computeGrowth(imported);
  // The same rows, declared by the user to be their OWN export, do count.
  const mine = computeGrowth(runOf(20, 20));
  // And imported rows sitting alongside real ones neither help nor hurt.
  const mixed = computeGrowth([...imported, ...runOf(4, 6, { t0: 900_000 })]);
  const alone = computeGrowth(runOf(4, 6, { t0: 900_000 }));
  record(
    '(j) an imported ledger grants no stage, and does not disturb a real one',
    cold.stage === 'egg' &&
      cold.percent === 0 &&
      cold.trials === 0 &&
      mine.stage === 'butterfly' &&
      mixed.stage === alone.stage &&
      mixed.hits === alone.hits &&
      mixed.trials === alone.trials &&
      diagnoseChange(imported).code === 'not-measured',
    `imported-only=${cold.stage} ${cold.percent}% (${cold.trials} trials); same rows as mine=${mine.stage}; mixed=${mixed.stage} ${mixed.hits}/${mixed.trials} vs real-only ${alone.stage} ${alone.hits}/${alone.trials}`,
  );
}

// -- (k) calibration is a different axis from accuracy ----------------------
{
  // Both are right 8 of 10. The first KNOWS which two it got wrong; the second
  // was loudly certain about all ten — same accuracy, worse calibration.
  const honest: CheckinRecord[] = Array.from({ length: 10 }, (_, i) => ({
    at: 1_000 + i,
    agentId: 'a',
    kind: 'checkin' as const,
    hit: i < 8,
    confidence: i < 8 ? 0.9 : 0.2,
  }));
  const overconfident: CheckinRecord[] = honest.map((r) => ({ ...r, confidence: 0.99 }));
  const hedging: CheckinRecord[] = honest.map((r) => ({ ...r, confidence: 0.5 }));
  // Certain every time and right half the time: THIS is confidence as decoration.
  const decorative: CheckinRecord[] = Array.from({ length: 10 }, (_, i) => ({
    at: 2_000 + i,
    agentId: 'a',
    kind: 'checkin' as const,
    hit: i < 5,
    confidence: 0.99,
  }));

  const h = brierScore(honest)!;
  const o = brierScore(overconfident)!;
  const d = brierScore(decorative)!;
  const g = computeGrowth(honest);
  const go = computeGrowth(overconfident);
  record(
    '(k) the same hit rate can score differently, and 0.5-always sits exactly on the line',
    // Same accuracy, better calibration scores lower.
    h.score < o.score &&
      h.samples === 10 &&
      // A constant 0.5 is EXACTLY the uninformative value, whatever the accuracy.
      Math.abs(brierScore(hedging)!.score - BRIER_UNINFORMATIVE) < 1e-9 &&
      h.score < BRIER_UNINFORMATIVE &&
      // Being loudly certain is NOT automatically worse than hedging: at 80%
      // accuracy 0.99 still beats always-0.5. It only crosses the line when the
      // certainty stops matching the outcomes.
      o.score < BRIER_UNINFORMATIVE &&
      d.score > BRIER_UNINFORMATIVE &&
      // The stage is untouched by any of it: this axis is measured, not gated.
      g.stage === go.stage &&
      g.brier !== undefined &&
      brierScore([{ at: 1, agentId: 'a', kind: 'checkin', hit: true }]) === undefined,
    `8/10 honest=${h.score.toFixed(3)} < 8/10 certain=${o.score.toFixed(3)} < line ${BRIER_UNINFORMATIVE} = always-0.5; 5/10 certain=${d.score.toFixed(3)} is above it. stage both ${g.stage}`,
  );
}

// -- (l) grading the decision to ask ---------------------------------------
{
  const rows: CheckinRecord[] = [
    // Asked, and the user went another way: the ask was warranted.
    { at: 1, agentId: 'a', kind: 'checkin', hit: false },
    { at: 2, agentId: 'a', kind: 'checkin', hit: false },
    // Asked, and the user agreed: it already knew.
    { at: 3, agentId: 'a', kind: 'checkin', hit: true },
    // Acted alone and had to be fixed: it should have asked.
    { at: 4, agentId: 'a', kind: 'autonomous', correctedAfter: true },
    // Acted alone, nothing needed fixing.
    { at: 5, agentId: 'a', kind: 'autonomous' },
    { at: 6, agentId: 'a', kind: 'autonomous' },
  ];
  const q = askDecisionQuality(rows)!;
  // A flawless agent: every ask turns out to have been unnecessary, so precision
  // is 0 — the signal that it can stop asking, NOT a failing grade.
  const flawless = askDecisionQuality([
    { at: 1, agentId: 'a', kind: 'checkin', hit: true },
    { at: 2, agentId: 'a', kind: 'checkin', hit: true },
    { at: 3, agentId: 'a', kind: 'autonomous' },
  ])!;
  record(
    '(l) ask precision and recall are graded, and a flawless agent scores 0 precision',
    Math.abs(q.precision - 2 / 3) < 1e-9 &&
      Math.abs(q.recall - 2 / 3) < 1e-9 &&
      q.warrantedAsks === 2 &&
      q.unnecessaryAsks === 1 &&
      q.missedAsks === 1 &&
      q.correctSilences === 2 &&
      q.samples === 6 &&
      flawless.precision === 0 &&
      flawless.recall === 0 &&
      // Nothing to score reads as absent, not as zero.
      askDecisionQuality([]) === undefined &&
      askDecisionQuality([{ at: 1, agentId: 'a', kind: 'tripwire' }]) === undefined,
    `precision=${q.precision.toFixed(2)} recall=${q.recall.toFixed(2)} (warranted ${q.warrantedAsks}, unnecessary ${q.unnecessaryAsks}, missed ${q.missedAsks}, silent ${q.correctSilences}); flawless precision=${flawless.precision}`,
  );
}

// ===========================================================================
// P3-M8d — the implicit half of the bound (trust-meter §4.11)
// ===========================================================================

/** `n` reviewed autonomous actions, the first `corrected` of them fixed by the
 *  user afterwards. This is what session reflection leaves behind. */
function reviewedOf(
  n: number,
  corrected: number,
  opts?: { t0?: number; reviewedAt?: number },
): CheckinRecord[] {
  const t0 = opts?.t0 ?? 3_000;
  return Array.from({ length: n }, (_, i) => ({
    at: t0 + i,
    agentId: 'a1',
    kind: 'autonomous' as const,
    reviewedAt: opts?.reviewedAt ?? t0 + i + 1,
    ...(i < corrected ? { correctedAfter: true } : {}),
  }));
}

// ---- (n) THE REGRESSION INVARIANT -----------------------------------------
{
  // Every population an existing check above builds, scored by BOTH meters: the
  // one in the runtime today and the verbatim pre-M8d copy under fixtures/. If a
  // ledger holds no reviewed rows the two must agree on every field, byte for
  // byte — that is the whole promise §4.11 makes to an existing user.
  const populations: Array<[string, CheckinRecord[]]> = [
    ['3/3 perfect', runOf(3, 3)],
    ['17/20', runOf(17, 20, { t0: 1_000 })],
    ['regressed', [...runOf(20, 20, { t0: 1_000 }), ...runOf(0, 8, { t0: 5_000 })]],
    [
      'mixed with autonomous rows (never reviewed)',
      [
        ...runOf(8, 8, { t0: 1_000 }),
        ...Array.from({ length: 12 }, (_, i) => ({
          at: 2_000 + i,
          agentId: 'a1',
          kind: 'autonomous' as const,
          correctedAfter: i < 2,
        })),
      ],
    ],
    [
      'with a tripwire',
      [...runOf(17, 20, { t0: 1_000 }), { at: 1_500, agentId: 'a1', kind: 'tripwire' as const }],
    ],
    [
      'imported alongside real rows',
      [...runOf(20, 20).map((r) => ({ ...r, imported: true })), ...runOf(4, 6, { t0: 900_000 })],
    ],
  ];
  const disagreements: string[] = [];
  for (const [name, rows] of populations) {
    const now = JSON.stringify(computeGrowth(rows));
    const then = JSON.stringify(preComputeGrowth(rows as PreCheckinRecord[]));
    if (now !== then) disagreements.push(`${name}: ${now} !== ${then}`);
    // The per-task-type reading takes the same path, so it is checked too.
    const nowW = JSON.stringify(computeGrowth(rows, { window: 8 }));
    const thenW = JSON.stringify(preComputeGrowth(rows as PreCheckinRecord[], { window: 8 }));
    if (nowW !== thenW) disagreements.push(`${name} (window 8): ${nowW} !== ${thenW}`);
  }
  record(
    '(n) with NOTHING reviewed, the meter is byte-for-byte the pre-M8d meter (6 populations, 2 windows each)',
    disagreements.length === 0,
    disagreements.length === 0
      ? `${populations.length * 2} readings identical to the pre-M8d copy in fixtures/growth-pre-m8d.ts`
      : disagreements.join(' | '),
  );
}

// ---- (o) implicit accepts raise the bound, implicit corrections lower it ---
{
  const explicit = runOf(4, 5, { t0: 1_000 }); // 4 of 5, a larva
  const alone = computeGrowth(explicit);
  const withAccepts = computeGrowth([...explicit, ...reviewedOf(12, 0)]);
  const withCorrections = computeGrowth([...explicit, ...reviewedOf(12, 12)]);
  // Reviewed rows must not disturb what the panel prints as the CHECK-IN record.
  const countsUntouched =
    withAccepts.hits === alone.hits &&
    withAccepts.trials === alone.trials &&
    withAccepts.observedRate === alone.observedRate &&
    withCorrections.trials === alone.trials;
  record(
    '(o) uncorrected reviewed actions raise the bound and corrections lower it, without touching the check-in counts',
    withAccepts.lowerBound > alone.lowerBound &&
      withCorrections.lowerBound < alone.lowerBound &&
      countsUntouched &&
      withAccepts.implicitTrials === 12 &&
      withAccepts.implicitHits === 12 &&
      withAccepts.implicitWeight === IMPLICIT_WEIGHT &&
      withCorrections.implicitHits === 0 &&
      alone.implicitTrials === undefined,
    `4/5 alone bound=${alone.lowerBound.toFixed(4)} → +12 uncorrected=${withAccepts.lowerBound.toFixed(4)}` +
      ` → +12 corrected=${withCorrections.lowerBound.toFixed(4)}; check-in counts stayed ${withAccepts.hits}/${withAccepts.trials}` +
      `; implicit reported raw as ${withAccepts.implicitHits}/${withAccepts.implicitTrials} at weight ${withAccepts.implicitWeight}`,
  );
}

// ---- (p) implicit evidence alone cannot leave the egg ----------------------
{
  // A full implicit window, perfectly clean, and not one answered check-in. The
  // floor of the meter is still "did it ask, and was it right" — so this is an
  // egg, at 0%, needing all GROWTH_MIN_SAMPLE answers.
  const implicitOnly = computeGrowth(reviewedOf(IMPLICIT_WINDOW, 0));
  // And four check-ins plus a mountain of clean implicit evidence is still short
  // of the minimum sample: the blend cannot buy the fifth answer.
  const almost = computeGrowth([...runOf(4, 4, { t0: 1_000 }), ...reviewedOf(IMPLICIT_WINDOW, 0)]);
  record(
    `(p) ${IMPLICIT_WINDOW} clean reviewed actions and no check-in is still an egg — the minimum sample counts EXPLICIT answers only`,
    implicitOnly.stage === 'egg' &&
      implicitOnly.percent === 0 &&
      implicitOnly.trials === 0 &&
      implicitOnly.needsMoreSamples === GROWTH_MIN_SAMPLE &&
      implicitOnly.implicitTrials === IMPLICIT_WINDOW &&
      almost.stage === 'egg' &&
      almost.needsMoreSamples === 1,
    `implicit-only: stage=${implicitOnly.stage} percent=${implicitOnly.percent}% trials=${implicitOnly.trials}` +
      ` needsMore=${implicitOnly.needsMoreSamples} (implicit ${implicitOnly.implicitHits}/${implicitOnly.implicitTrials});` +
      ` 4 check-ins + ${IMPLICIT_WINDOW} clean: stage=${almost.stage} needsMore=${almost.needsMoreSamples}`,
  );
}

// ---- (q) the implicit window caps, and the weight is really a quarter ------
{
  const explicit = runOf(5, 5, { t0: 1_000 });
  const capped = computeGrowth([...explicit, ...reviewedOf(IMPLICIT_WINDOW + 25, 0)]);
  const exactly = computeGrowth([...explicit, ...reviewedOf(IMPLICIT_WINDOW, 0)]);
  // THE DISCOUNT IS REAL: the same 40 actions, had they been answered check-ins,
  // would push the bound visibly higher. (They would also be worth exactly 10
  // check-ins after weighting — which is the ceiling §4.11 chose, not a
  // coincidence — so the comparison that means something is against 40 EXPLICIT
  // labels, not against 10.)
  const asExplicit = computeGrowth([...explicit, ...runOf(IMPLICIT_WINDOW, IMPLICIT_WINDOW, { t0: 3_000 })]);
  const effective = wilsonLowerBound(
    5 + IMPLICIT_WEIGHT * IMPLICIT_WINDOW,
    5 + IMPLICIT_WEIGHT * IMPLICIT_WINDOW,
  );
  record(
    `(q) the implicit pool stops at ${IMPLICIT_WINDOW}, and those actions count for a quarter each rather than as labels`,
    capped.implicitTrials === IMPLICIT_WINDOW &&
      Math.abs(capped.lowerBound - exactly.lowerBound) < 1e-12 &&
      capped.lowerBound < asExplicit.lowerBound &&
      Math.abs(capped.lowerBound - effective) < 1e-12,
    `${IMPLICIT_WINDOW + 25} reviewed rows → implicitTrials=${capped.implicitTrials} bound=${capped.lowerBound.toFixed(4)}` +
      ` (identical to exactly ${IMPLICIT_WINDOW}: ${exactly.lowerBound.toFixed(4)}, and to a hand-computed ${effective.toFixed(4)});` +
      ` the same ${IMPLICIT_WINDOW} as ANSWERED check-ins instead → ${asExplicit.lowerBound.toFixed(4)}`,
  );
}

// ---- (r) the change point drops stale implicit rows too --------------------
{
  // A perfect run, then a sharp collapse — the same shape check (d)/(h) uses, so
  // the detector really does fire. The implicit rows sit in the OLD era and are
  // clean, i.e. exactly the evidence that would prop the stage up if the cut did
  // not apply to them.
  const stale = [...runOf(20, 20, { t0: 1_000 }), ...runOf(0, 8, { t0: 5_000 })];
  const withOldImplicit = computeGrowth([...stale, ...reviewedOf(20, 0, { t0: 1_500 })]);
  const withNewImplicit = computeGrowth([...stale, ...reviewedOf(20, 0, { t0: 9_000 })]);
  const withoutImplicit = computeGrowth(stale);
  record(
    '(r) implicit rows from before a detected change point are dropped; rows from after it count',
    withOldImplicit.changePointAt !== undefined &&
      withOldImplicit.implicitTrials === undefined &&
      withOldImplicit.lowerBound === withoutImplicit.lowerBound &&
      withNewImplicit.implicitTrials === 20 &&
      withNewImplicit.lowerBound > withoutImplicit.lowerBound,
    `cut=${String(withOldImplicit.changePointAt)}; 20 clean actions BEFORE the cut → implicit=${String(withOldImplicit.implicitTrials)}` +
      ` bound=${withOldImplicit.lowerBound.toFixed(4)} (unchanged from ${withoutImplicit.lowerBound.toFixed(4)});` +
      ` the same 20 AFTER it → implicit=${String(withNewImplicit.implicitTrials)} bound=${withNewImplicit.lowerBound.toFixed(4)}`,
  );
}

// ===========================================================================
// P3-M12c — drills, the discounted third label source (fast-evolution §3.4)
// ===========================================================================

/** One UTC day in ms — the bucket `DRILL_DAILY_CAP` counts within. */
const DAY = 86_400_000;

/** `n` answered DRILLS, the first `hits` of them landing. `day` places the whole
 *  run inside one UTC day, which is what the cap buckets on. */
function drillsOf(
  n: number,
  hits: number,
  opts?: { day?: number; offset?: number },
): CheckinRecord[] {
  const base = (opts?.day ?? 0) * DAY + (opts?.offset ?? 1_000);
  return Array.from({ length: n }, (_, i) => ({
    at: base + i,
    agentId: 'a1',
    kind: 'checkin' as const,
    drill: true,
    hit: i < hits,
  }));
}

// ---- (s) practice cannot START the measurement -----------------------------
{
  // Five perfect drills and not one real answer. If practice could fill the
  // minimum sample, this would read pupa on the strength of five questions naby
  // wrote for itself — the exact self-grading loop §2 of the spec forbids.
  const drillsOnly = computeGrowth(drillsOf(5, 5));
  // Four real answers plus a full drill window is STILL an egg: the fifth real
  // answer cannot be bought.
  const almost = computeGrowth([...runOf(4, 4, { t0: 1_000 }), ...drillsOf(DRILL_WINDOW, DRILL_WINDOW, { day: 1 })]);
  record(
    '(s) drills alone leave an egg, and they cannot buy the missing real answers',
    drillsOnly.stage === 'egg' &&
      drillsOnly.percent === 0 &&
      drillsOnly.trials === 0 &&
      drillsOnly.hits === 0 &&
      drillsOnly.lowerBound === 0 &&
      drillsOnly.needsMoreSamples === GROWTH_MIN_SAMPLE &&
      drillsOnly.drillTrials === 5 &&
      drillsOnly.drillHits === 5 &&
      almost.stage === 'egg' &&
      almost.needsMoreSamples === 1 &&
      almost.lowerBound === computeGrowth(runOf(4, 4, { t0: 1_000 })).lowerBound,
    `5 perfect drills: stage=${drillsOnly.stage} percent=${drillsOnly.percent}% realTrials=${drillsOnly.trials}` +
      ` bound=${drillsOnly.lowerBound.toFixed(4)} needsMore=${drillsOnly.needsMoreSamples}` +
      ` (drills reported raw as ${drillsOnly.drillHits}/${drillsOnly.drillTrials});` +
      ` 4 real + ${DRILL_WINDOW} drills: stage=${almost.stage} needsMore=${almost.needsMoreSamples}` +
      ` bound unchanged at ${almost.lowerBound.toFixed(4)}`,
  );
}

// ---- (t) the blend is the arithmetic the spec wrote down --------------------
{
  const real = runOf(4, 5, { t0: 1_000 }); // 4 of 5 — a larva, and over the minimum
  const alone = computeGrowth(real);
  const withDrills = computeGrowth([...real, ...drillsOf(8, 6, { day: 1 })]);
  const withMissedDrills = computeGrowth([...real, ...drillsOf(8, 0, { day: 1 })]);
  // Computed by hand from the formula in §3.4, not from the implementation.
  const expected = wilsonLowerBound(4 + DRILL_WEIGHT * 6, 5 + DRILL_WEIGHT * 8);
  // The same eight answers, had they been REAL, would move the bound further:
  // that difference IS the discount.
  const asReal = computeGrowth([...real, ...runOf(6, 8, { t0: DAY + 1_000 })]);
  record(
    `(t) the bound blends drills at exactly ${DRILL_WEIGHT}, and the real counts the panel prints stay real`,
    Math.abs(withDrills.lowerBound - expected) < 1e-12 &&
      withDrills.hits === alone.hits &&
      withDrills.trials === alone.trials &&
      withDrills.observedRate === alone.observedRate &&
      withDrills.lifetimeTrials === alone.lifetimeTrials &&
      withDrills.drillTrials === 8 &&
      withDrills.drillHits === 6 &&
      withDrills.drillWeight === DRILL_WEIGHT &&
      withDrills.lowerBound > alone.lowerBound &&
      withMissedDrills.lowerBound < alone.lowerBound &&
      withDrills.lowerBound < asReal.lowerBound &&
      alone.drillTrials === undefined,
    `4/5 alone bound=${alone.lowerBound.toFixed(4)} → +6/8 drills=${withDrills.lowerBound.toFixed(4)}` +
      ` (hand-computed ${expected.toFixed(4)}) → +0/8 drills=${withMissedDrills.lowerBound.toFixed(4)};` +
      ` the same 6/8 as REAL check-ins would give ${asReal.lowerBound.toFixed(4)};` +
      ` real counts stayed ${withDrills.hits}/${withDrills.trials} (lifetime ${withDrills.lifetimeTrials})`,
  );
}

// ---- (u) the daily cap ------------------------------------------------------
{
  const real = runOf(5, 5, { t0: 1_000 });
  // Twelve drills inside ONE day, all hits. Only the first DRILL_DAILY_CAP count.
  const twelve = computeGrowth([...real, ...drillsOf(12, 12, { day: 1 })]);
  const ten = computeGrowth([...real, ...drillsOf(DRILL_DAILY_CAP, DRILL_DAILY_CAP, { day: 1 })]);
  // Spread over two days, all twelve count — the cap is per day, not per ledger.
  const spread = computeGrowth([
    ...real,
    ...drillsOf(6, 6, { day: 1 }),
    ...drillsOf(6, 6, { day: 2 }),
  ]);
  record(
    `(u) ${DRILL_DAILY_CAP} drills a day count; the 11th and 12th of one day do not`,
    twelve.drillTrials === DRILL_DAILY_CAP &&
      Math.abs(twelve.lowerBound - ten.lowerBound) < 1e-12 &&
      spread.drillTrials === 12 &&
      spread.lowerBound > twelve.lowerBound,
    `12 drills in one day → counted ${twelve.drillTrials} bound=${twelve.lowerBound.toFixed(4)}` +
      ` (identical to exactly ${DRILL_DAILY_CAP}: ${ten.lowerBound.toFixed(4)});` +
      ` the same 12 spread over two days → counted ${spread.drillTrials} bound=${spread.lowerBound.toFixed(4)}`,
  );
}

// ---- (v) the drill window ---------------------------------------------------
{
  const real = runOf(5, 5, { t0: 1_000 });
  // Enough days, each within the cap, to overrun the window twice over.
  const many: CheckinRecord[] = [];
  for (let day = 1; day <= 6; day += 1) many.push(...drillsOf(DRILL_DAILY_CAP, DRILL_DAILY_CAP, { day }));
  const capped = computeGrowth([...real, ...many]);
  // Exactly one window's worth, taken from the NEWEST days — what the slice keeps.
  const exactly = computeGrowth([
    ...real,
    ...drillsOf(DRILL_DAILY_CAP, DRILL_DAILY_CAP, { day: 5 }),
    ...drillsOf(DRILL_DAILY_CAP, DRILL_DAILY_CAP, { day: 6 }),
  ]);
  const effective = wilsonLowerBound(
    5 + DRILL_WEIGHT * DRILL_WINDOW,
    5 + DRILL_WEIGHT * DRILL_WINDOW,
  );
  record(
    `(v) the drill pool stops at ${DRILL_WINDOW}, however many days of practice sit behind it`,
    capped.drillTrials === DRILL_WINDOW &&
      Math.abs(capped.lowerBound - exactly.lowerBound) < 1e-12 &&
      Math.abs(capped.lowerBound - effective) < 1e-12,
    `${6 * DRILL_DAILY_CAP} capped drills over 6 days → drillTrials=${capped.drillTrials}` +
      ` bound=${capped.lowerBound.toFixed(4)} (identical to the newest ${DRILL_WINDOW}:` +
      ` ${exactly.lowerBound.toFixed(4)}, and to a hand-computed ${effective.toFixed(4)})`,
  );
}

// ---- (w) a drill perturbs NOTHING else --------------------------------------
{
  // The same ledger twice, once with a pile of drills mixed in. Every axis but
  // the bound and the drill counts must be identical — that is what "drills are
  // a separate pool" has to mean if the panel's other numbers are to stay
  // checkable against the user's own memory of what happened.
  const base: CheckinRecord[] = [
    ...runOf(8, 10, { t0: 1_000 }),
    ...Array.from({ length: 6 }, (_, i) => ({
      at: 2_000 + i,
      agentId: 'a1',
      kind: 'autonomous' as const,
      correctedAfter: i < 1,
      reviewedAt: 2_500 + i,
    })),
    { at: 2_900, agentId: 'a1', kind: 'checkin' as const, hit: true, confidence: 0.9 },
  ];
  const withDrills = [
    ...base,
    ...drillsOf(DRILL_DAILY_CAP, 7, { day: 1 }),
    // …including a degenerate one, which must be dropped from the drill pool the
    // same way a degenerate real check-in is dropped from the real one.
    { at: DAY + 5_000, agentId: 'a1', kind: 'checkin' as const, drill: true, hit: true, excludedFromScoring: true },
  ];
  const a = computeGrowth(base);
  const b = computeGrowth(withDrills);
  const strip = (g: typeof a) => {
    const { lowerBound, percent, stage, drillTrials, drillHits, drillWeight, ...rest } = g;
    return JSON.stringify(rest);
  };
  record(
    '(w) adding drills changes the bound and nothing else — not the counts, coverage, calibration, ask quality or the diagnosis',
    strip(a) === strip(b) &&
      b.drillTrials === DRILL_DAILY_CAP &&
      b.lowerBound !== a.lowerBound &&
      JSON.stringify(diagnoseChange(base)) === JSON.stringify(diagnoseChange(withDrills)) &&
      JSON.stringify(brierScore(base)) === JSON.stringify(brierScore(withDrills)) &&
      JSON.stringify(askDecisionQuality(base)) === JSON.stringify(askDecisionQuality(withDrills)),
    strip(a) === strip(b)
      ? `every non-bound field identical with ${b.drillTrials} drills added (an 11th, degenerate one was dropped);` +
        ` bound ${a.lowerBound.toFixed(4)} → ${b.lowerBound.toFixed(4)}; diagnosis, Brier and ask quality byte-identical`
      : `DIFFERED: ${strip(a)} !== ${strip(b)}`,
  );
}

// ---- report --------------------------------------------------------------
let failed = 0;
for (const c of checks) {
  if (!c.pass) failed += 1;
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}\n      ${c.evidence}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
if (failed > 0) process.exitCode = 1;
