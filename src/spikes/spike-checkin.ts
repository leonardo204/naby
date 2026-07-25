// src/spikes/spike-checkin.ts
//
// Phase 3 (P3-M5) verification: THE CHECK-IN — the exchange that produces the
// trust meter's labels.
//
// spike-growth proved the arithmetic is sound given a ledger. This proves the
// ledger gets written correctly, by driving the REAL executor (`makeCheckin`)
// against a fake sink and then feeding what it recorded into the REAL meter. That
// closes the loop the product depends on: ask → answer → row → stage.
//
// Asserted:
//   (a) A malformed check-in fails as a tool error and NEVER interrupts the user.
//   (b) Taking the recommendation is a hit; picking another option is a miss.
//   (c) A free-text answer records chosen=-1, a miss, and keeps the user's words.
//   (d) An unanswered check-in writes NO row — absence is not a miss.
//   (e) Padded options are recorded but excluded from scoring, with a reason.
//   (f) The same question asked twice is excluded the SECOND time, not the first.
//   (g) The agent is never told how it scored.
//   (h) A check-in is owed by ACTION CLASS: mutation/exec/outbound yes, reads no.
//   (i) End to end: recorded check-ins take an egg to a butterfly.
//   (j) A padded question buys no accuracy but still costs coverage.
//
// No store and no engine: the sink is a fake, so this runs in milliseconds.

import {
  isConsequentialTool,
  isReversibleAction,
  type CheckinAnswer,
  type CheckinQuestion,
} from '../runtime/checkin.js';
import { makeCheckin, type CheckinLedgerRow } from '../runtime/tools.js';
import { computeGrowth, type CheckinRecord } from '../runtime/growth.js';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

/** A sink that answers however the test says and remembers what was recorded. */
function fakeSink(answer: (q: CheckinQuestion) => CheckinAnswer, recentQuestions?: string[]) {
  const asked: CheckinQuestion[] = [];
  const rows: CheckinLedgerRow[] = [];
  return {
    asked,
    rows,
    sink: {
      ask: async (q: CheckinQuestion) => {
        asked.push(q);
        return answer(q);
      },
      record: (r: CheckinLedgerRow) => {
        rows.push(r);
      },
      ...(recentQuestions ? { recentQuestions } : {}),
    },
  };
}

/** The mapping the shell performs: a recorded row becomes a ledger event the
 *  meter can read. Written out here so the spike asserts the SAME translation the
 *  engine does, rather than a convenient shortcut. */
function asRecord(row: CheckinLedgerRow, at: number): CheckinRecord {
  return {
    at,
    agentId: 'agent-under-test',
    kind: 'checkin',
    hit: row.hit,
    ...(row.taskType ? { taskType: row.taskType } : {}),
    ...(row.excludedFromScoring ? { excludedFromScoring: true } : {}),
  };
}

/** A minimal ExecCtx. The check-in executor reads only the tool-call id from it —
 *  the shell keys the pending prompt on it, exactly as M2 keys an approval. */
let callSeq = 0;
function ctx() {
  callSeq += 1;
  return {
    toolCall: { toolCallId: `call-${callSeq}`, toolName: 'naby_checkin', input: {} },
    signal: new AbortController().signal,
  };
}

const TAKE_RECOMMENDED = (q: CheckinQuestion): CheckinAnswer => ({ chosen: q.recommended });

// -- (a) a malformed check-in never reaches the user ------------------------
{
  const one = fakeSink(TAKE_RECOMMENDED);
  const outOne = await makeCheckin(one.sink)({
    question: 'Rename in place, or rename in place?',
    options: ['rename in place'],
    recommended: 0,
  }, ctx());
  const bad = fakeSink(TAKE_RECOMMENDED);
  const outBad = await makeCheckin(bad.sink)({
    question: 'How should I proceed?',
    options: ['a', 'b'],
    recommended: 7,
  }, ctx());
  record(
    '(a) a malformed check-in is a tool error and never interrupts the user',
    outOne.isError === true &&
      one.asked.length === 0 &&
      one.rows.length === 0 &&
      outBad.isError === true &&
      bad.asked.length === 0,
    `one-option: error=${outOne.isError} asked=${one.asked.length}; bad index: error=${outBad.isError} asked=${bad.asked.length}`,
  );
}

// -- (b) the label is what the user did ------------------------------------
{
  const q = { question: 'Migrate the column, or add a new one?', options: ['migrate', 'add new'], recommended: 0 };
  const took = fakeSink(TAKE_RECOMMENDED);
  await makeCheckin(took.sink)(q, ctx());
  const other = fakeSink(() => ({ chosen: 1 }));
  await makeCheckin(other.sink)(q, ctx());
  record(
    '(b) taking the recommendation is a hit; picking another option is a miss',
    took.rows[0]?.hit === true &&
      took.rows[0]?.chosen === 0 &&
      other.rows[0]?.hit === false &&
      other.rows[0]?.chosen === 1,
    `took → hit=${took.rows[0]?.hit} chosen=${took.rows[0]?.chosen}; other → hit=${other.rows[0]?.hit} chosen=${other.rows[0]?.chosen}`,
  );
}

// -- (c) a free-text answer keeps the user's words -------------------------
{
  const free = fakeSink(() => ({ chosen: -1, correction: 'neither — drop the column entirely' }));
  const out = await makeCheckin(free.sink)({
    question: 'Migrate the column, or add a new one?',
    options: ['migrate', 'add new'],
    recommended: 0,
    confidence: 0.7,
  }, ctx());
  const row = free.rows[0];
  record(
    '(c) a free-text answer records chosen=-1, a miss, and the correction',
    row?.chosen === -1 &&
      row?.hit === false &&
      row?.correction === 'neither — drop the column entirely' &&
      row?.confidence === 0.7 &&
      out.isError !== true &&
      String(out.content).includes('drop the column entirely'),
    `chosen=${row?.chosen} hit=${row?.hit} confidence=${row?.confidence} correction="${row?.correction}"`,
  );
}

// -- (d) nobody answered is not a miss -------------------------------------
{
  const gone = fakeSink(() => ({ chosen: -1, unanswered: true }));
  const out = await makeCheckin(gone.sink)({
    question: 'Migrate the column, or add a new one?',
    options: ['migrate', 'add new'],
    recommended: 0,
  }, ctx());
  record(
    '(d) an unanswered check-in writes no row at all',
    gone.rows.length === 0 && out.isError === true && !String(out.content).includes('chose'),
    `rows=${gone.rows.length} error=${out.isError}`,
  );
}

// -- (e) padded options are kept, marked, and unscored ---------------------
{
  const padded = fakeSink(TAKE_RECOMMENDED);
  await makeCheckin(padded.sink)({
    question: 'Shall I use the safe approach?',
    options: ['the safe approach', 'The Safe Approach!'],
    recommended: 0,
  }, ctx());
  const row = padded.rows[0];
  record(
    '(e) a padded question is recorded but excluded from scoring, with a reason',
    padded.rows.length === 1 && row?.excludedFromScoring === true && typeof row?.reason === 'string' && !!row.reason,
    `rows=${padded.rows.length} excluded=${row?.excludedFromScoring} reason="${row?.reason}"`,
  );
}

// -- (f) the repeat is excluded, the original is not -----------------------
{
  const question = 'Should I run the migration now or wait for the review?';
  const first = fakeSink(TAKE_RECOMMENDED);
  await makeCheckin(first.sink)({ question, options: ['run now', 'wait'], recommended: 0 }, ctx());
  const again = fakeSink(TAKE_RECOMMENDED, ['Should I run the migration now, or wait for the review?']);
  await makeCheckin(again.sink)({ question, options: ['run now', 'wait'], recommended: 0 }, ctx());
  const unrelated = fakeSink(TAKE_RECOMMENDED, ['Should I run the migration now, or wait for the review?']);
  await makeCheckin(unrelated.sink)({
    question: 'Reply to the customer in Korean or English?',
    options: ['Korean', 'English'],
    recommended: 0,
  }, ctx());
  record(
    '(f) asking the same thing again is excluded; the first ask and an unrelated one are not',
    !first.rows[0]?.excludedFromScoring &&
      again.rows[0]?.excludedFromScoring === true &&
      !unrelated.rows[0]?.excludedFromScoring,
    `first=${!!first.rows[0]?.excludedFromScoring} repeat=${!!again.rows[0]?.excludedFromScoring} unrelated=${!!unrelated.rows[0]?.excludedFromScoring}`,
  );
}

// -- (g) the agent cannot see its own score -------------------------------
{
  const s = fakeSink(TAKE_RECOMMENDED);
  const out = await makeCheckin(s.sink)({
    question: 'Migrate the column, or add a new one?',
    options: ['migrate', 'add new'],
    recommended: 0,
  }, ctx());
  const said = `${out.content} ${JSON.stringify(out.data ?? {})}`;
  const leaks = /\bhit\b|\bmiss\b|butterfly|pupa|larva|\begg\b|percent|%|stage|score/i.test(said);
  record(
    '(g) the returned value tells the agent the decision and nothing about its score',
    !leaks && String(out.content).includes('migrate'),
    leaks ? `LEAKED: ${said}` : `said: ${String(out.content).slice(0, 90)}…`,
  );
}

// -- (h) the obligation is a property of the action ------------------------
{
  const owed = ['Write', 'Edit', 'MultiEdit', 'Bash', 'send_message'];
  const notOwed = ['Read', 'Glob', 'Grep', 'WebSearch', 'echo_note', 'naby_remember'];
  record(
    '(h) mutation / exec / outbound calls are consequential; reads are not',
    owed.every(isConsequentialTool) &&
      notOwed.every((t) => !isConsequentialTool(t)) &&
      isReversibleAction('Write') &&
      !isReversibleAction('Bash'),
    `owed=${owed.filter(isConsequentialTool).join(',')} | notOwed leaks=${notOwed.filter(isConsequentialTool).join(',') || 'none'}`,
  );
}

// -- (i) end to end: asking moves the meter -------------------------------
{
  const rows: CheckinLedgerRow[] = [];
  let asked = 0;
  // Each question below names its own task, so no duplicate history is needed.
  const sink = {
    ask: async (q: CheckinQuestion): Promise<CheckinAnswer> =>
      // The user disagrees on the 4th, 9th and 14th; the rest take the pick.
      asked % 5 === 3 && asked < 15 ? { chosen: q.recommended === 0 ? 1 : 0 } : { chosen: q.recommended },
    record: (r: CheckinLedgerRow) => rows.push(r),
  };
  const exec = makeCheckin(sink);
  const before = computeGrowth([]);
  for (let i = 0; i < 20; i += 1) {
    await exec(
      {
        question: `Task ${i}: should I take path A or path B?`,
        options: [`path A for task ${i}`, `path B for task ${i}`],
        recommended: 0,
        taskType: 'code-refactor',
      },
      ctx(),
    );
    asked += 1;
  }
  const after = computeGrowth(rows.map((r, i) => asRecord(r, 1_000 + i)));
  record(
    '(i) end to end: 17 of 20 real check-ins take an egg to a butterfly',
    before.stage === 'egg' &&
      before.percent === 0 &&
      rows.length === 20 &&
      after.hits === 17 &&
      after.stage === 'butterfly' &&
      after.percent === 100,
    `before=${before.stage} ${before.percent}% → after=${after.stage} ${after.percent}% (${after.hits}/${after.trials}, bound ${after.lowerBound.toFixed(3)})`,
  );
}

// -- (j) padding buys no accuracy but still costs coverage ----------------
{
  const at = (i: number) => 2_000 + i;
  // Four honest check-ins, three hits — plus one autonomous action.
  const honest: CheckinRecord[] = [
    { at: at(0), agentId: 'a', kind: 'checkin', hit: true },
    { at: at(1), agentId: 'a', kind: 'checkin', hit: true },
    { at: at(2), agentId: 'a', kind: 'checkin', hit: true },
    { at: at(3), agentId: 'a', kind: 'checkin', hit: false },
    { at: at(4), agentId: 'a', kind: 'autonomous' },
  ];
  // The same run with three padded questions bolted on, all "hits".
  const padded: CheckinRecord[] = [
    ...honest,
    { at: at(5), agentId: 'a', kind: 'checkin', hit: true, excludedFromScoring: true },
    { at: at(6), agentId: 'a', kind: 'checkin', hit: true, excludedFromScoring: true },
    { at: at(7), agentId: 'a', kind: 'checkin', hit: true, excludedFromScoring: true },
  ];
  const h = computeGrowth(honest);
  const p = computeGrowth(padded);
  record(
    '(j) padded questions cannot raise the hit rate, and they lower coverage',
    h.hits === p.hits && h.trials === p.trials && p.coverage < h.coverage && p.excluded === 3,
    `honest ${h.hits}/${h.trials} coverage ${h.coverage.toFixed(2)} → padded ${p.hits}/${p.trials} coverage ${p.coverage.toFixed(2)} (excluded ${p.excluded})`,
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
