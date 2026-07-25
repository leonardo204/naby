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
//
// Pure arithmetic, no store and no engine — runs in milliseconds.

import {
  BUTTERFLY_THRESHOLD,
  GROWTH_MIN_SAMPLE,
  GROWTH_WINDOW,
  canBeAddressed,
  computeGrowth,
  diagnoseChange,
  stageFor,
  wilsonLowerBound,
  type CheckinRecord,
} from '../runtime/growth.js';

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

// ---- report --------------------------------------------------------------
let failed = 0;
for (const c of checks) {
  if (!c.pass) failed += 1;
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}\n      ${c.evidence}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
if (failed > 0) process.exitCode = 1;
