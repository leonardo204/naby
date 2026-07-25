// src/spikes/spike-import.ts
//
// Phase 3 (P3-M7) verification: BRINGING AN AGENT IN — and what a file cannot do.
//
// The export made a promise: "권한은 늘 그 기기의 원장에서 다시 나온다." Until now
// that was true only because no code read a stage from a file. Import is where the
// promise is actually tested, so most of these checks are adversarial: they hand
// the parser a file that has been edited to claim more than it earned.
//
// Asserted:
//   (a) The full loop: export → import → the same agent, restorable.
//   (b) A file cannot declare a stage. A perfect imported ledger leaves the agent
//       an egg, and it is NOT addressable.
//   (c) Unless the user says it is their own export — then, and only then, the
//       rows count and the stage is recomputed FROM THE LEDGER.
//   (d) `growthAtExport` is never believed: editing it changes nothing.
//   (e) An import can never claim the built-in persona: no id, kind always custom.
//   (f) Learned facts land in the agent's INSTRUCTIONS, not in machine memory —
//       the write gate forbids external content from writing user scope at all,
//       so proposing rows that can only be denied would be a silent half-run.
//   (g) A name collision is renamed, never overwritten — and the rename is
//       reported rather than silent.
//   (h) A newer format version is refused, not half-read.
//   (i) Hostile input fails as problems, not as an exception.
//   (j) A hand-edited credential in the file is caught by the third sweep.
//   (k) `session`/`org`-scoped rows are refused, and every skip is explained.
//
// Pure: no store, no filesystem.

import { buildAgentExport } from '../runtime/agent-export.js';
import { parseAgentSidecar, freeAgentName } from '../runtime/agent-import.js';
import { canBeAddressed, computeGrowth, type CheckinRecord } from '../runtime/growth.js';
import type { Agent, EvalEvent, MemoryItem } from '../runtime/store/store.js';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

const NOW = 1_784_000_000_000;
const OPTS = { now: NOW, userId: 'local-user', cwd: '/repo' };

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-persona-builtin',
    name: 'persona',
    kind: 'persona',
    description: 'Learns how you decide and acts on your behalf.',
    systemPrompt: 'You are the persona agent.',
    model: 'claude-opus-5',
    toolRefs: ['Read', 'naby_remember'],
    memoryScope: 'user',
    autonomy: { escalation: 'telegram', maxSteps: 6 },
    createdAt: 1,
    updatedAt: 2,
    ...over,
  };
}

let n = 0;
function mem(over: Partial<MemoryItem> = {}): MemoryItem {
  n += 1;
  return {
    id: `m${n}`,
    scope: 'user',
    scopeKey: 'their-machine-user',
    type: 'semantic',
    key: `fact-${n}`,
    value: `something true ${n}`,
    // A file claiming the HIGHEST tier and a confirmed status is the interesting
    // case: neither may survive the crossing.
    provenance: { source: 'user', basis: 'they said so' },
    confidence: 1,
    status: 'confirmed',
    createdAt: 10,
    updatedAt: 20,
    ...over,
  } as MemoryItem;
}

/** A perfect 20-row ledger — the strongest thing a file could try to claim. */
function perfectLedger(): EvalEvent[] {
  return Array.from({ length: 20 }, (_, i) => ({
    id: `e${i}`,
    kind: 'checkin' as const,
    at: 1_000 + i,
    agentId: 'agent-persona-builtin',
    sessionId: 'their-session',
    question: `Q${i}?`,
    options: [`A${i}`, `B${i}`],
    recommended: 0,
    chosen: 0,
    hit: true,
    taskType: 'code-refactor',
  })) as EvalEvent[];
}

/** The ledger rows as the meter would see them once stored under a new agent. */
function asRecords(plan: { ledger: Array<Record<string, unknown>> }, agentId: string): CheckinRecord[] {
  return plan.ledger.map((r) => ({ ...(r as object), agentId }) as CheckinRecord);
}

// -- (a) the full loop -----------------------------------------------------
{
  const a = agent();
  const out = buildAgentExport({ agent: a, memories: [], ledger: [], now: NOW });
  const res = parseAgentSidecar(out.sidecar, OPTS);
  const p = res.ok ? res.plan : null;
  record(
    '(a) export → import restores the agent, minus what must not survive',
    res.ok === true &&
      p!.agent.name === 'persona' &&
      p!.agent.description === a.description &&
      p!.agent.systemPrompt === a.systemPrompt &&
      p!.agent.model === 'claude-opus-5' &&
      JSON.stringify(p!.agent.toolRefs) === JSON.stringify(['Read', 'naby_remember']) &&
      p!.agent.memoryScope === 'user' &&
      p!.agent.autonomy.escalation === 'telegram' &&
      p!.agent.autonomy.maxSteps === 6 &&
      p!.origin.agentId === 'agent-persona-builtin',
    res.ok
      ? `name=${p!.agent.name} model=${p!.agent.model} autonomy=${JSON.stringify(p!.agent.autonomy)} origin=${p!.origin.agentId}`
      : `FAILED: ${res.problems.join('; ')}`,
  );
}

// -- (b)(c)(d) a file cannot declare a stage -------------------------------
{
  const out = buildAgentExport({ agent: agent(), memories: [], ledger: perfectLedger(), now: NOW });
  // The file itself says butterfly — truthfully, about the machine it left.
  const claimed = JSON.parse(out.sidecar).growthAtExport as { stage: string };

  const cold = parseAgentSidecar(out.sidecar, OPTS);
  const coldGrowth = computeGrowth(asRecords(cold.ok ? cold.plan : { ledger: [] }, 'new-id'));

  const mine = parseAgentSidecar(out.sidecar, { ...OPTS, trustLedger: true });
  const mineGrowth = computeGrowth(asRecords(mine.ok ? mine.plan : { ledger: [] }, 'new-id'));

  record(
    '(b) a perfect imported ledger leaves the agent an egg, and unaddressable',
    claimed.stage === 'butterfly' &&
      cold.ok === true &&
      cold.plan.report.ledgerRows === 20 &&
      cold.plan.report.ledgerCounts === false &&
      coldGrowth.stage === 'egg' &&
      coldGrowth.trials === 0 &&
      canBeAddressed(coldGrowth.stage) === false,
    `file claims "${claimed.stage}"; imported → ${coldGrowth.stage} ${coldGrowth.percent}% (${coldGrowth.trials} scored of ${cold.ok ? cold.plan.report.ledgerRows : 0} kept), addressable=${canBeAddressed(coldGrowth.stage)}`,
  );
  record(
    '(c) the same file, declared the user\'s own, recomputes from the ledger',
    mine.ok === true &&
      mine.plan.report.ledgerCounts === true &&
      mineGrowth.stage === 'butterfly' &&
      mineGrowth.trials === 20 &&
      canBeAddressed(mineGrowth.stage) === true,
    `trustLedger → ${mineGrowth.stage} ${mineGrowth.percent}% (${mineGrowth.trials} scored), addressable=${canBeAddressed(mineGrowth.stage)}`,
  );

  // Now edit the file's own claim to the maximum and re-import untrusted.
  const doc = JSON.parse(out.sidecar);
  doc.growthAtExport = { stage: 'butterfly', percent: 100, hits: 999, trials: 999 };
  doc.stage = 'butterfly';
  doc.addressable = true;
  doc.trusted = true;
  const tampered = parseAgentSidecar(JSON.stringify(doc), OPTS);
  const tamperedGrowth = computeGrowth(asRecords(tampered.ok ? tampered.plan : { ledger: [] }, 'new-id'));
  record(
    '(d) editing the claimed stage (or inventing fields) changes nothing',
    tampered.ok === true &&
      tamperedGrowth.stage === 'egg' &&
      canBeAddressed(tamperedGrowth.stage) === false &&
      // It is SHOWN, labelled as the file's claim, and acted on nowhere.
      tampered.plan.report.claimedStage === 'butterfly' &&
      !JSON.stringify(tampered.plan.agent).includes('trusted'),
    `after tampering → ${tamperedGrowth.stage}, addressable=${canBeAddressed(tamperedGrowth.stage)}, shown claim="${tampered.ok ? tampered.plan.report.claimedStage : ''}"`,
  );
}

// -- (e) an import cannot become the built-in persona ----------------------
{
  const out = buildAgentExport({ agent: agent(), memories: [], ledger: [], now: NOW });
  const doc = JSON.parse(out.sidecar);
  // Put back exactly what the export refused to carry.
  doc.agent.id = 'agent-persona-builtin';
  doc.agent.kind = 'persona';
  const res = parseAgentSidecar(JSON.stringify(doc), OPTS);
  record(
    '(e) an import is always a custom agent, and carries no id',
    res.ok === true &&
      res.plan.agent.kind === 'custom' &&
      !('id' in res.plan.agent) &&
      // The original id survives only as provenance.
      res.plan.origin.agentId === 'agent-persona-builtin',
    res.ok ? `kind=${res.plan.agent.kind} id present=${'id' in res.plan.agent}` : 'parse failed',
  );
}

// -- (f) the facts go into the instructions, not into memory ---------------
{
  const out = buildAgentExport({
    agent: agent(),
    memories: [
      mem({ key: 'prefers-metric-units', value: 'Metric everywhere.' }),
      mem({ key: 'build-command', type: 'procedural', value: 'npm run build:app' }),
    ],
    ledger: [],
    now: NOW,
  });
  // Even the most trusting import: the answer does not change.
  const res = parseAgentSidecar(out.sidecar, { ...OPTS, trustLedger: true });
  const prompt = res.ok ? res.plan.agent.systemPrompt : '';
  record(
    '(f) learned facts land in the agent\'s instructions, never as machine memory',
    res.ok === true &&
      res.plan.report.factsInlined === 2 &&
      // The original instruction is still first, and the facts follow it in the
      // SAME line format naby injects at turn time.
      prompt.startsWith('You are the persona agent.') &&
      prompt.includes('- (user/semantic) prefers-metric-units: Metric everywhere.') &&
      prompt.includes('- (user/procedural) build-command: npm run build:app') &&
      // No memory-write path exists to be denied.
      !('memories' in res.plan),
    res.ok ? `factsInlined=${res.plan.report.factsInlined}; prompt grew to ${prompt.length} chars` : 'parse failed',
  );
}

// -- (g) a name collision is renamed, and reported ------------------------
{
  const out = buildAgentExport({ agent: agent(), memories: [], ledger: [], now: NOW });
  const res = parseAgentSidecar(out.sidecar, { ...OPTS, existingNames: ['persona', 'persona-imported'] });
  record(
    '(g) a taken name is renamed rather than overwritten, and the rename is shown',
    res.ok === true &&
      res.plan.agent.name === 'persona-imported-2' &&
      res.plan.report.renamedFrom === 'persona' &&
      freeAgentName('fresh', ['persona']) === 'fresh' &&
      // And a first-time collision gets the readable suffix.
      freeAgentName('persona', ['persona']) === 'persona-imported',
    res.ok ? `name=${res.plan.agent.name} renamedFrom=${res.plan.report.renamedFrom}` : 'parse failed',
  );
}

// -- (h)(i) hostile and unreadable input ---------------------------------
{
  const future = parseAgentSidecar(JSON.stringify({ formatVersion: 99, agent: { name: 'x', systemPrompt: 'y' } }), OPTS);
  const notJson = parseAgentSidecar('{ this is not json', OPTS);
  const notOurs = parseAgentSidecar(JSON.stringify({ hello: 'world' }), OPTS);
  const noPrompt = parseAgentSidecar(JSON.stringify({ formatVersion: 1, agent: { name: 'x' } }), OPTS);
  const empty = parseAgentSidecar('', OPTS);
  const arr = parseAgentSidecar('[1,2,3]', OPTS);
  record(
    '(h) a newer format is refused rather than half-read',
    future.ok === false && future.problems.some((p) => p.includes('newer naby')),
    future.ok ? 'ACCEPTED — bad' : future.problems.join('; '),
  );
  record(
    '(i) unreadable or foreign input fails as problems, never as an exception',
    notJson.ok === false &&
      notOurs.ok === false &&
      noPrompt.ok === false &&
      empty.ok === false &&
      arr.ok === false &&
      notOurs.problems.some((p) => p.includes('formatVersion')),
    [notJson, notOurs, noPrompt, empty, arr].map((r) => (r.ok ? 'ok?!' : r.problems[0])).join(' | '),
  );
}

// -- (j)(k) the third sweep, and refused scopes --------------------------
{
  const doc = {
    formatVersion: 1,
    agent: { name: 'colleague', systemPrompt: 'do things', memoryScope: 'user' },
    memories: [
      { scope: 'user', type: 'semantic', key: 'ok-fact', value: 'Metric everywhere.' },
      // Hand-edited back in after the export swept it.
      { scope: 'user', type: 'semantic', key: 'token', value: 'the deploy token is sk-EXAMPLE-not-a-real-key-000000' },
      { scope: 'session', type: 'working', key: 'their-task', value: 'their current task' },
      { scope: 'org', type: 'semantic', key: 'team-rule', value: 'someone else\'s shared asset' },
      { scope: 'user', type: 'nonsense', key: 'bad-type', value: 'x' },
      { scope: 'user', type: 'semantic', value: 'no key at all' },
    ],
    ledger: [{ kind: 'nonsense', at: 1 }, { kind: 'checkin' }],
  };
  const res = parseAgentSidecar(JSON.stringify(doc), OPTS);
  // Read back out of the instructions, which is where they now live.
  const kept = res.ok
    ? [...res.plan.agent.systemPrompt.matchAll(/^- \([a-z]+\/[a-z]+\) ([^:]+):/gm)].map((m) => m[1]!)
    : [];
  const w = res.ok ? res.plan.report.warnings : [];
  record(
    '(j) a hand-edited credential is caught by the third sweep',
    res.ok === true &&
      !kept.includes('token') &&
      !JSON.stringify(res.plan).includes('sk-EXAMPLE') &&
      w.some((x) => x.includes('credential')),
    `kept=${JSON.stringify(kept)}`,
  );
  record(
    '(k) session/org rows and malformed rows are refused, and every skip is explained',
    res.ok === true &&
      kept.length === 1 &&
      kept[0] === 'ok-fact' &&
      res.plan.report.skippedFacts === 5 &&
      w.length >= 5 &&
      // Both bad ledger rows are dropped with a note, not silently.
      res.plan.report.ledgerRows === 0 &&
      w.some((x) => x.includes('growth-record')),
    `skipped=${res.ok ? res.plan.report.skippedFacts : '?'} warnings=${w.length}: ${w.slice(0, 3).join(' | ')}`,
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
