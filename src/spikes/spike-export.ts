// src/spikes/spike-export.ts
//
// Phase 3 (P3-M6) verification: TAKING A GROWN AGENT OUT OF NABY.
//
// Export is the moment data leaves the machine, so the properties below are
// mostly about what must NOT be in the file. Each is stated the way a user would
// ask it: "did my unreviewed notes go out?", "is my token in there?", "can
// somebody hand me a file that claims to be trusted?"
//
// Asserted:
//   (a) Unreviewed (`proposed`) memory never leaves, and the drop is counted.
//   (b) `session`-scoped memory never leaves — it was true for one conversation.
//   (c) Credential-shaped rows are dropped by the second sweep, key OR value.
//   (d) A row that is both unreviewed and session-scoped is counted ONCE.
//   (e) The learned facts are INLINE in the `.md`, in naby's own injection format.
//   (f) Free text in the ledger is redacted, and the row's score survives.
//   (g) The sidecar carries no `id` and no `kind` — an exported persona cannot
//       collide with, or claim to be, the importing machine's own persona.
//   (h) The stage appears only as a dated record, and `growthAtExport` is named so
//       it cannot be read as live state.
//   (i) A description full of YAML punctuation survives quoting.
//   (j) The sidecar is valid JSON and restores the rows byte-for-byte.
//
// The round trip through the REAL importer (`parseSubagentArtifact`) is asserted
// in the shell, where that parser lives.

import {
  buildAgentExport,
  exportBasename,
  memoryDropReason,
  yamlScalar,
  AGENT_EXPORT_FORMAT_VERSION,
  REDACTED,
} from '../runtime/agent-export.js';
import { renderMemoryLine } from '../runtime/memory-inject.js';
import type { Agent, EvalEvent, MemoryItem, MemoryScope, MemoryStatus } from '../runtime/store/store.js';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

const NOW = 1_784_000_000_000; // fixed so the dated comment is deterministic

function agent(over: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-persona-builtin',
    name: 'persona',
    kind: 'persona',
    description: 'Learns how you decide and acts on your behalf.',
    systemPrompt: 'You are the user\'s personal persona agent inside naby.',
    memoryScope: 'user',
    autonomy: { escalation: 'inline', maxSteps: 4 },
    createdAt: 1,
    updatedAt: 2,
    ...over,
  };
}

let memSeq = 0;
function mem(over: Partial<MemoryItem> = {}): MemoryItem {
  memSeq += 1;
  return {
    id: `m${memSeq}`,
    scope: 'user' as MemoryScope,
    scopeKey: 'local',
    type: 'semantic',
    key: `fact-${memSeq}`,
    value: `something true ${memSeq}`,
    provenance: { source: 'user', basis: 'they said so' },
    confidence: 1,
    status: 'confirmed' as MemoryStatus,
    createdAt: 10,
    updatedAt: 20,
    ...over,
  };
}

let evSeq = 0;
function ev(over: Partial<EvalEvent> = {}): EvalEvent {
  evSeq += 1;
  return {
    id: `e${evSeq}`,
    kind: 'checkin',
    at: 1_000 + evSeq,
    agentId: 'agent-persona-builtin',
    sessionId: 's1',
    hit: true,
    ...over,
  };
}

// -- (a)(b)(c)(d) what never leaves ----------------------------------------
{
  const memories = [
    mem({ key: 'prefers-metric-units', value: 'Distances and weights in metric.' }),
    mem({ status: 'proposed', key: 'guessed-thing', value: 'Maybe they like tabs.' }),
    mem({ scope: 'session', scopeKey: 's1', key: 'current-task', value: 'Fixing the parser.' }),
    // Synthetic but credential-SHAPED, so the sweep must fire.
    mem({ key: 'deploy-note', value: 'the deploy token is sk-EXAMPLE-not-a-real-key-000000' }),
    // The KEY is swept too, not just the value.
    mem({ key: 'ghp-EXAMPLE-not-a-real-token-000000', value: 'the old handle' }),
    // AND THE FALSE POSITIVE MUST NOT FIRE: a note ABOUT a credential is not a
    // credential. Dropping this would teach the user the sweep eats real notes.
    mem({ key: 'api-key', value: 'ask the admin for it' }),
    // Both unreviewed AND session-scoped: one row, one reason.
    mem({ status: 'proposed', scope: 'session', scopeKey: 's1', key: 'both', value: 'x' }),
  ];
  const out = buildAgentExport({ agent: agent(), memories, ledger: [], now: NOW });
  const r = out.report;
  const leaked = ['Maybe they like tabs', 'Fixing the parser', 'sk-EXAMPLE', 'ghp-EXAMPLE'].filter(
    (s) => out.markdown.includes(s) || out.sidecar.includes(s),
  );

  record(
    '(a) unreviewed memory never leaves, and the drop is counted',
    r.droppedProposed === 2 && !out.markdown.includes('Maybe they like tabs'),
    `droppedProposed=${r.droppedProposed} included=${r.memoriesIncluded}`,
  );
  record(
    '(b) session-scoped memory never leaves',
    r.droppedSession === 1 && !out.sidecar.includes('Fixing the parser'),
    `droppedSession=${r.droppedSession}`,
  );
  record(
    '(c) the second sweep drops credential-shaped rows by value OR key, and only those',
    r.droppedSecret === 2 &&
      leaked.length === 0 &&
      // The note ABOUT a credential went out, as it should.
      out.markdown.includes('ask the admin for it'),
    `droppedSecret=${r.droppedSecret}; leaked=${JSON.stringify(leaked)}; note kept=${out.markdown.includes('ask the admin for it')}`,
  );
  record(
    '(d) a row that is both unreviewed and session-scoped is counted once',
    r.droppedProposed + r.droppedSession + r.droppedSecret + r.memoriesIncluded === memories.length,
    `${r.droppedProposed}+${r.droppedSession}+${r.droppedSecret}+${r.memoriesIncluded} vs ${memories.length}`,
  );
  record(
    '(e) the learned facts are inline in the .md, in naby\'s own injection format',
    out.markdown.includes(renderMemoryLine(memories[0]!)) &&
      out.markdown.includes('What naby has learned'),
    `line present: ${out.markdown.includes(renderMemoryLine(memories[0]!))} — "${renderMemoryLine(memories[0]!)}"`,
  );
}

// -- (f) the ledger keeps its score and loses the secret -------------------
{
  const ledger = [
    ev({ question: 'Deploy with the token sk-EXAMPLE-not-a-real-key-000000?', options: ['yes', 'no'], recommended: 0, chosen: 0, hit: true }),
    ev({ question: 'Migrate in place, or add a column?', options: ['migrate', 'add'], recommended: 0, chosen: 1, hit: false, correction: 'use my key sk-EXAMPLE-not-a-real-key-111111 instead' }),
  ];
  const out = buildAgentExport({ agent: agent(), memories: [], ledger, now: NOW });
  const doc = JSON.parse(out.sidecar) as { ledger: EvalEvent[] };
  record(
    '(f) ledger free text is redacted while the row\'s score survives',
    !out.sidecar.includes('sk-EXAMPLE') &&
      out.report.redactedLedgerFields === 2 &&
      doc.ledger.length === 2 &&
      doc.ledger[0]!.question === REDACTED &&
      doc.ledger[0]!.hit === true &&
      doc.ledger[1]!.correction === REDACTED &&
      doc.ledger[1]!.hit === false,
    `redacted=${out.report.redactedLedgerFields} rows=${doc.ledger.length} hits=${doc.ledger.map((r) => r.hit).join(',')}`,
  );
}

// -- (g)(h) the artifact cannot claim identity or trust --------------------
{
  const ledger = Array.from({ length: 20 }, (_, i) => ev({ hit: i < 18 }));
  const out = buildAgentExport({ agent: agent(), memories: [], ledger, now: NOW });
  const doc = JSON.parse(out.sidecar) as Record<string, unknown>;
  const a = doc.agent as Record<string, unknown>;
  const origin = doc.origin as Record<string, unknown>;
  record(
    '(g) the restorable agent block carries no id and no kind',
    !('id' in a) &&
      !('kind' in a) &&
      origin.agentId === 'agent-persona-builtin' &&
      origin.kind === 'persona',
    `agent keys: ${Object.keys(a).join(',')}; origin.agentId=${String(origin.agentId)}`,
  );
  // The frontmatter is what another tool READS. A `stage:` key there would be a
  // claim; the stage belongs in a comment, as a dated note about where it was.
  const front = out.markdown.slice(0, out.markdown.indexOf('---', 4));
  record(
    '(h) the stage is a dated record, never a frontmatter claim or live state',
    !/stage/i.test(front) &&
      out.markdown.includes('a record, not a permission') &&
      out.markdown.includes('2026-') &&
      'growthAtExport' in doc &&
      !('growth' in doc) &&
      out.report.stage === 'butterfly',
    `frontmatter mentions stage: ${/stage/i.test(front)}; sidecar key: growthAtExport=${'growthAtExport' in doc} growth=${'growth' in doc}; stage=${out.report.stage}`,
  );
}

// -- (i) YAML punctuation survives ----------------------------------------
{
  const nasty = 'Reviews SQL: fast, "safely" — #1 choice {always}';
  const out = buildAgentExport({
    agent: agent({ name: 'sql reviewer!', description: nasty, model: 'claude-opus-5', toolRefs: ['Read', 'Grep'] }),
    memories: [],
    ledger: [],
    now: NOW,
  });
  const line = out.markdown.split('\n').find((l) => l.startsWith('description:')) ?? '';
  record(
    '(i) a description full of YAML punctuation is quoted, and the name is slugged',
    line.startsWith('description: "') &&
      line.includes('\\"safely\\"') &&
      out.markdown.includes('tools: Read, Grep') &&
      out.markdownName === 'sql-reviewer.md' &&
      out.sidecarName === 'sql-reviewer.naby.json',
    `${line} | files: ${out.markdownName}, ${out.sidecarName}`,
  );
}

// -- (j) the sidecar restores rows exactly --------------------------------
{
  const memories = [mem({ key: 'build-command', value: 'Build with npm run build:app.' })];
  const ledger = [ev({ taskType: 'code-refactor', confidence: 0.8 })];
  const out = buildAgentExport({ agent: agent(), memories, ledger, now: NOW });
  const doc = JSON.parse(out.sidecar) as {
    formatVersion: number;
    memories: MemoryItem[];
    ledger: EvalEvent[];
  };
  record(
    '(j) the sidecar is valid JSON and restores memory and ledger rows exactly',
    doc.formatVersion === AGENT_EXPORT_FORMAT_VERSION &&
      JSON.stringify(doc.memories) === JSON.stringify(memories) &&
      JSON.stringify(doc.ledger) === JSON.stringify(ledger),
    `formatVersion=${doc.formatVersion} memories match: ${JSON.stringify(doc.memories) === JSON.stringify(memories)} ledger match: ${JSON.stringify(doc.ledger) === JSON.stringify(ledger)}`,
  );
}

// -- helper-level checks ---------------------------------------------------
{
  // What matters about a scalar is that a YAML reader gets the STRING back, not
  // which quote style produced it — so the check is "quoted when it would
  // otherwise be read as something else", not an exact spelling.
  const quoted = (v: string) => /^['"]/.test(yamlScalar(v));
  record(
    '(k) the drop classifier and the slug behave at the edges',
    memoryDropReason(mem({ status: 'proposed' })) === 'proposed' &&
      memoryDropReason(mem({ scope: 'session' })) === 'session' &&
      memoryDropReason(mem({ value: 'password: hunter2hunter2' })) === 'secret' &&
      memoryDropReason(mem()) === undefined &&
      exportBasename('  ') === 'agent' &&
      exportBasename('나의 페르소나') === '나의-페르소나' &&
      // Bare words a YAML reader would turn into a boolean, a number, or a
      // truncated field must all come back as strings.
      quoted('yes') &&
      quoted('no') &&
      quoted('null') &&
      quoted('3.14') &&
      quoted('key: value') &&
      quoted('- dash first') &&
      yamlScalar('plain words') === 'plain words' &&
      yamlScalar('') === "''",
    `empty name → "${exportBasename('  ')}"; korean → "${exportBasename('나의 페르소나')}"; yaml("yes") → ${yamlScalar('yes')}; yaml("plain words") → ${yamlScalar('plain words')}`,
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
