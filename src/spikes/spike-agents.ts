// src/spikes/spike-agents.ts
//
// Phase 3 (P3-M1) verification: the `agents` store slice round-trips, enforces
// its invariants (unique name, undeletable persona, idempotent seed, persona-
// first ordering), and behaves IDENTICALLY on the in-memory store and SQLite so
// the two drivers agree. Exit 0 = pass, non-zero = fail.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryStore,
  SqliteStore,
  BUILTIN_PERSONA_ID,
  BUILTIN_PERSONA_NAME,
  parseAgentAddress,
  seedBuiltinPersona,
  computeGrowth,
  type AgentInput,
  type Store,
} from '../runtime-entry.js';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name}`);
    failures += 1;
  }
}

const customAgent = (name: string): AgentInput => ({
  name,
  kind: 'custom',
  systemPrompt: `I am ${name}.`,
  memoryScope: 'user',
  autonomy: { escalation: 'inline' },
});

async function exerciseStore(label: string, store: Store): Promise<void> {
  console.log(`\n[${label}] agents store round-trip`);

  // Empty to start.
  check('starts empty', store.listAgents().length === 0);

  // Seed the built-in persona (idempotent).
  const persona = seedBuiltinPersona(store);
  check('seed creates the persona', persona.id === BUILTIN_PERSONA_ID);
  check('persona is kind=persona', persona.kind === 'persona');
  check('persona default name', persona.name === BUILTIN_PERSONA_NAME);
  check('persona memoryScope=user', persona.memoryScope === 'user');
  check('seed idempotent (still one agent)', (seedBuiltinPersona(store), store.listAgents().length === 1));

  // Add a custom agent (id minted).
  const drafter = store.putAgent(customAgent('drafter'));
  check('custom agent minted an id', typeof drafter.id === 'string' && drafter.id.length > 0);
  check('two agents now', store.listAgents().length === 2);

  // getAgent / getAgentByName.
  check('getAgent by id', store.getAgent(drafter.id)?.name === 'drafter');
  check('getAgentByName routes', store.getAgentByName('drafter')?.id === drafter.id);
  check('getAgentByName persona', store.getAgentByName(BUILTIN_PERSONA_NAME)?.id === BUILTIN_PERSONA_ID);
  check('getAgentByName miss → undefined', store.getAgentByName('nope') === undefined);

  // Persona sorts FIRST regardless of insertion order.
  check('persona sorts first', store.listAgents()[0]?.id === BUILTIN_PERSONA_ID);

  // Unique-name invariant: a second agent may NOT take an in-use name.
  let threw = false;
  try {
    store.putAgent(customAgent('drafter'));
  } catch {
    threw = true;
  }
  check('duplicate name rejected', threw);
  check('rejection did not add a row', store.listAgents().length === 2);

  // Update by id: same-row rename is allowed and preserves createdAt.
  const renamed = store.putAgent({ ...customAgent('composer'), id: drafter.id });
  check('rename kept the id', renamed.id === drafter.id);
  check('rename preserved createdAt', renamed.createdAt === drafter.createdAt);
  check('rename bumped updatedAt', renamed.updatedAt >= drafter.updatedAt);
  check('old name now free', store.getAgentByName('drafter') === undefined);
  check('new name resolves', store.getAgentByName('composer')?.id === drafter.id);

  // Persona is EDITABLE (putAgent updates it) …
  const editedPersona = store.putAgent({
    id: BUILTIN_PERSONA_ID,
    name: 'aria',
    kind: 'persona',
    systemPrompt: 'edited',
    memoryScope: 'user',
    autonomy: { escalation: 'telegram', maxSteps: 20 },
  });
  check('persona edit applied', editedPersona.systemPrompt === 'edited');
  check('persona rename applied', store.getAgentByName('aria')?.id === BUILTIN_PERSONA_ID);
  check('persona autonomy round-trips', editedPersona.autonomy.escalation === 'telegram' && editedPersona.autonomy.maxSteps === 20);

  // … but UNDELETABLE (removeAgent no-ops a persona).
  store.removeAgent(BUILTIN_PERSONA_ID);
  check('persona survives removeAgent', store.getAgent(BUILTIN_PERSONA_ID) !== undefined);

  // Custom agent IS deletable.
  store.removeAgent(drafter.id);
  check('custom agent removed', store.getAgent(drafter.id) === undefined);
  check('only persona remains', store.listAgents().length === 1 && store.listAgents()[0]?.kind === 'persona');

  // toolRefs / optional fields round-trip.
  const scoped = store.putAgent({
    name: 'scout',
    kind: 'custom',
    description: 'read-only',
    systemPrompt: 'scout the repo',
    model: 'claude-sonnet-5',
    toolRefs: ['Read', 'Grep'],
    memoryScope: 'project',
    autonomy: { escalation: 'both', maxSteps: 5 },
  });
  const back = store.getAgent(scoped.id)!;
  check('toolRefs round-trip', JSON.stringify(back.toolRefs) === JSON.stringify(['Read', 'Grep']));
  check('model round-trip', back.model === 'claude-sonnet-5');
  check('description round-trip', back.description === 'read-only');
  check('memoryScope=project round-trip', back.memoryScope === 'project');

  // -- the eval-event ledger (P3-M5) ---------------------------------------
  // The trust meter reads this, so both drivers must agree on ordering, the
  // limit window, the kind/taskType filters, and delete-by-session.
  // A literal id on purpose: the ledger has NO foreign key to agents (a
  // conversation or an agent row may be gone while its record stands), so the
  // slice must work without one existing.
  const aid = 'agent-under-test';
  store.appendEvalEvent({ kind: 'checkin', agentId: aid, sessionId: 's1', taskType: 'writing', hit: true, at: 1000, options: ['a', 'b'], recommended: 0, chosen: 0, confidence: 0.7 });
  store.appendEvalEvent({ kind: 'checkin', agentId: aid, sessionId: 's1', taskType: 'writing', hit: false, at: 2000, options: ['a', 'b'], recommended: 0, chosen: 1 });
  store.appendEvalEvent({ kind: 'autonomous', agentId: aid, sessionId: 's2', at: 3000, reversible: true, correctedAfter: true });
  store.appendEvalEvent({ kind: 'tripwire', agentId: aid, sessionId: 's2', at: 4000, toolName: 'Bash', reason: 'destructive' });
  store.appendEvalEvent({ kind: 'checkin', agentId: aid, sessionId: 's3', taskType: 'sql', hit: true, at: 5000, options: ['x', 'y'], recommended: 1, chosen: 1, excludedFromScoring: true });

  const all = store.listEvalEvents(aid);
  check(`${label}: ledger returns all rows OLDEST first`, all.length === 5 && all[0]!.at === 1000 && all[4]!.at === 5000);
  check(`${label}: ledger round-trips the kind-specific payload`, all[0]!.options?.length === 2 && all[0]!.recommended === 0 && all[0]!.confidence === 0.7 && all[0]!.hit === true);
  check(`${label}: ledger preserves hit=false (not conflated with absent)`, all[1]!.hit === false);
  check(`${label}: ledger round-trips the autonomous + tripwire fields`, all[2]!.correctedAfter === true && all[3]!.toolName === 'Bash');
  check(`${label}: excludedFromScoring survives the round trip`, all[4]!.excludedFromScoring === true);
  check(`${label}: kind filter`, store.listEvalEvents(aid, { kind: 'checkin' }).length === 3);
  check(`${label}: taskType filter`, store.listEvalEvents(aid, { taskType: 'writing' }).length === 2);
  check(`${label}: limit takes the NEWEST rows`, (() => { const r = store.listEvalEvents(aid, { limit: 2 }); return r.length === 2 && r[0]!.at === 4000 && r[1]!.at === 5000; })());
  check(`${label}: another agent's ledger is separate`, store.listEvalEvents('no-such-agent').length === 0);

  // The meter must read the same numbers off either driver.
  const g = computeGrowth(store.listEvalEvents(aid));
  // coverage is 1 autonomous of 4 decisions: the DEGENERATE check-in still counts
  // as an ask (else padding questions would be free), though it is excluded from accuracy.
  check(`${label}: meter reads the ledger — 1 scored hit of 2, 1 tripwire, 1 excluded, coverage 1/4`, g.hits === 1 && g.trials === 2 && g.tripwires === 1 && g.excluded === 1 && Math.abs(g.coverage - 0.25) < 1e-9);

  store.deleteEvalEvents({ sessionId: 's2' });
  check(`${label}: delete-by-session removes only that session's rows`, store.listEvalEvents(aid).length === 3);
  store.deleteEvalEvents({ agentId: aid });
  check(`${label}: delete-by-agent clears the ledger`, store.listEvalEvents(aid).length === 0);
}

function exerciseAddressParser(): void {
  console.log('\n[parse] parseAgentAddress (P3-M2 routing)');
  const p1 = parseAgentAddress('@persona fix the tests');
  check('parses @name + task', p1?.name === 'persona' && p1?.taskText === 'fix the tests');
  const p2 = parseAgentAddress('@persona');
  check('name-only → empty task', p2?.name === 'persona' && p2?.taskText === '');
  const p3 = parseAgentAddress('  @scout   go  ');
  check('tolerates leading/inner whitespace', p3?.name === 'scout' && p3?.taskText === 'go');
  const p4 = parseAgentAddress('@persona do this\nand that');
  check('multi-line task preserved', p4?.name === 'persona' && p4?.taskText === 'do this\nand that');
  check('no leading @ → undefined', parseAgentAddress('hello @persona') === undefined);
  check('bare text → undefined', parseAgentAddress('just a message') === undefined);
  check('lone @ → undefined', parseAgentAddress('@ hi') === undefined);
}

async function main(): Promise<void> {
  await exerciseStore('memory', new MemoryStore());
  exerciseAddressParser();

  const dir = mkdtempSync(join(tmpdir(), 'naby-agents-'));
  const sqlite = new SqliteStore({ path: join(dir, 'app.db') });
  await exerciseStore('sqlite', sqlite);

  // Durability: a fresh handle on the same file re-reads the seeded persona and
  // does NOT double-seed.
  const path2 = join(dir, 'app.db');
  const reopened = new SqliteStore({ path: path2 });
  seedBuiltinPersona(reopened);
  const personas = reopened.listAgents().filter((a) => a.kind === 'persona');
  check('reopen: exactly one persona (no double-seed)', personas.length === 1);
  reopened.close();

  console.log('');
  if (failures === 0) {
    console.log('PASS — agents store slice + persona seed verified on both drivers.');
    process.exit(0);
  }
  console.error(`FAIL — ${failures} check(s) failed.`);
  process.exit(1);
}

void main();
