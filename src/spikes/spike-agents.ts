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
  seedBuiltinPersona,
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
}

async function main(): Promise<void> {
  await exerciseStore('memory', new MemoryStore());

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
