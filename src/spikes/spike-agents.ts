// src/spikes/spike-agents.ts
//
// Phase 3 (P3-M1) verification: the `agents` store slice round-trips, enforces
// its invariants (unique name, undeletable persona, idempotent seed, persona-
// first ordering), and behaves IDENTICALLY on the in-memory store and SQLite so
// the two drivers agree. Exit 0 = pass, non-zero = fail.
//
// 2026-07-30: the persona became BUILT-IN AND READ-ONLY, which turns two of those
// invariants over. `putAgent` now THROWS on a persona row instead of updating it,
// and the seed ENFORCES itself — a persona edited under an older build is written
// back to the seed on the next boot, keeping only its id and createdAt. Both are
// asserted below, on both drivers, because a heal that works on one store and not
// the other would leave half the installs off-contract.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryStore,
  SqliteStore,
  builtinPersonaMatchesSeed,
  BUILTIN_PERSONA_ID,
  BUILTIN_PERSONA_NAME,
  BUILTIN_PERSONA_SEED,
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
  // Pinned to the LITERAL, not just to the constant (2026-08-03 user decision):
  // the handle is part of the product's identity, so a rename has to be a
  // deliberate edit here rather than something a constant quietly carries.
  check('the built-in handle is @naby', persona.name === 'naby');
  check(
    'the seed identifies itself as naby',
    persona.systemPrompt.startsWith('You are naby, the user\'s personal agent.'),
  );
  // The KIND did NOT move with the name: every invariant (undeletable,
  // uneditable, single-row) keys on kind='persona', and so does the engine.
  check('the kind discriminator is still persona', persona.kind === 'persona');
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

  // Persona is NOT EDITABLE (2026-07-30 decision, replacing M1's "editable but
  // undeletable"). putAgent THROWS rather than no-oping: a silent no-op would let
  // a caller believe it had saved something.
  let editThrew = false;
  try {
    store.putAgent({
      id: BUILTIN_PERSONA_ID,
      name: 'aria',
      kind: 'persona',
      systemPrompt: 'edited',
      memoryScope: 'user',
      autonomy: { escalation: 'telegram', maxSteps: 20 },
    });
  } catch {
    editThrew = true;
  }
  check('persona edit rejected', editThrew);
  check('persona unchanged after refused edit', store.getAgent(BUILTIN_PERSONA_ID)?.systemPrompt === BUILTIN_PERSONA_SEED.systemPrompt);
  check('persona kept its name', store.getAgentByName(BUILTIN_PERSONA_NAME)?.id === BUILTIN_PERSONA_ID);

  // Nor can the shape be laundered: an update that DROPS kind='persona' still
  // targets a persona row, and a fresh insert asking for kind='persona' would
  // mint a second built-in. Both refused, on the STORED kind and on the input.
  let launderThrew = false;
  try {
    store.putAgent({ id: BUILTIN_PERSONA_ID, name: 'aria', kind: 'custom', systemPrompt: 'edited', memoryScope: 'user', autonomy: { escalation: 'inline' } });
  } catch {
    launderThrew = true;
  }
  check('persona edit disguised as kind=custom is rejected', launderThrew);
  let secondPersonaThrew = false;
  try {
    store.putAgent({ name: 'persona-two', kind: 'persona', systemPrompt: 'me too', memoryScope: 'user', autonomy: { escalation: 'inline' } });
  } catch {
    secondPersonaThrew = true;
  }
  check('a second kind=persona row is rejected', secondPersonaThrew);
  check('no extra agent was added', store.listAgents().length === 2);

  // … and UNDELETABLE (removeAgent no-ops a persona).
  store.removeAgent(BUILTIN_PERSONA_ID);
  check('persona survives removeAgent', store.getAgent(BUILTIN_PERSONA_ID) !== undefined);

  // THE HEAL. An install that ran an OLDER build may hold a persona the user
  // edited, so the seed must write it back — through the one door the store
  // opens for it. Driven here with `restoreBuiltinPersona` standing in for that
  // older build's edit, then healed by an ordinary `seedBuiltinPersona`.
  //
  // The drifted row is named `persona` on purpose (2026-08-03): that is the handle
  // EVERY install made before the rename carries, so this is not a synthetic edit
  // — it is the upgrade path itself. `name` is a seeded field, so the ordinary
  // boot heal renames the row to `@naby` in place. No migration exists because
  // none is needed.
  const beforeDrift = store.getAgent(BUILTIN_PERSONA_ID)!;
  store.restoreBuiltinPersona({
    id: BUILTIN_PERSONA_ID,
    name: 'persona',
    kind: 'persona',
    description: 'hand-edited',
    systemPrompt: 'edited by an older build',
    model: 'some-model',
    toolRefs: ['Read'],
    memoryScope: 'project',
    autonomy: { escalation: 'telegram', maxSteps: 20 },
  });
  check('drift detected', !builtinPersonaMatchesSeed(store.getAgent(BUILTIN_PERSONA_ID)!, BUILTIN_PERSONA_SEED));
  const healed = seedBuiltinPersona(store);
  check('seed restored the prompt', healed.systemPrompt === BUILTIN_PERSONA_SEED.systemPrompt);
  // P3-M9 (G3): the heal is the PROTOCOL DELIVERY CHANNEL. An install that ran an
  // older build carries the pre-M9 prompt, and since the row is read-only the
  // user cannot add these rules themselves — so what matters is not merely that
  // the prompt was restored but that the restored text actually carries the four
  // operating protocols. Asserted on the HEALED row (what the engine will read),
  // not on the seed constant, because a heal that dropped them would still make
  // the equality check above pass on a stale seed.
  for (const marker of [
    'MEMORY FIRST',
    'CLARIFY EARLY',
    'VERIFY BEFORE DONE',
    'REPORT in four parts',
  ]) {
    check(`healed prompt carries the "${marker}" protocol`, healed.systemPrompt.includes(marker));
  }
  // The pre-M9 contract lines survive alongside them — the protocols were ADDED,
  // not swapped in for the persona's original job description.
  check(
    'healed prompt keeps the act-on-behalf contract',
    healed.systemPrompt.includes("ON THE USER'S BEHALF"),
  );
  check(
    'healed prompt keeps the escalate-only-critical contract',
    healed.systemPrompt.includes('Escalate ONLY genuinely critical or irreversible'),
  );
  check('seed restored the name', healed.name === BUILTIN_PERSONA_NAME);
  // Stated as the migration it is: a pre-rename row comes out of boot as @naby,
  // and the old handle stops resolving.
  check('an old @persona row is renamed to @naby on boot', healed.name === 'naby');
  check('the old handle no longer resolves', store.getAgentByName('persona') === undefined);
  check('the new handle resolves to the same row', store.getAgentByName('naby')?.id === BUILTIN_PERSONA_ID);
  check('seed restored the description', healed.description === BUILTIN_PERSONA_SEED.description);
  check('seed restored memoryScope', healed.memoryScope === 'user');
  check('seed restored autonomy', healed.autonomy.escalation === 'inline' && healed.autonomy.maxSteps === undefined);
  // An absent seed field must come back ABSENT, not left over from the edit.
  check('seed cleared the model the user set', healed.model === undefined);
  check('seed cleared the toolRefs the user set', healed.toolRefs === undefined);
  // Identity and age survive the heal — the ledger, memory and growth history all
  // hang off this id, and a persona that claims to be new would reset its own age.
  check('heal kept the id', healed.id === BUILTIN_PERSONA_ID);
  check('heal kept createdAt', healed.createdAt === beforeDrift.createdAt);
  check('heal added no row', store.listAgents().length === 2);
  check('seed is a no-op once the row matches', (() => {
    const again = seedBuiltinPersona(store);
    return again.updatedAt === healed.updatedAt && store.listAgents().length === 2;
  })());

  // THE CONCESSION (2026-08-03). The rename above is a heal, and a heal must not
  // damage data the user made. Drive the one case where it would: an install whose
  // persona is still `@persona` and whose user already made a custom `@naby`.
  // Taking the handle back would throw on the unique-name invariant — i.e. break
  // boot — so the seed restores everything EXCEPT the name.
  store.restoreBuiltinPersona({ ...BUILTIN_PERSONA_SEED, name: 'persona', systemPrompt: 'drifted again' });
  const squatter = store.putAgent(customAgent('naby'));
  const conceded = seedBuiltinPersona(store);
  check('name collision does not break boot', conceded.id === BUILTIN_PERSONA_ID);
  check('collision keeps the handle the user holds', store.getAgentByName('naby')?.id === squatter.id);
  check('collision leaves the persona on its old handle', conceded.name === 'persona');
  // What actually governs behaviour is still restored — the concession is about a
  // handle, not about letting a drifted prompt stand.
  check('collision still restores the prompt', conceded.systemPrompt === BUILTIN_PERSONA_SEED.systemPrompt);
  store.removeAgent(squatter.id);
  const renamedLater = seedBuiltinPersona(store);
  check('the rename lands once the handle frees up', renamedLater.name === 'naby');
  check('collision minted no extra row', store.listAgents().length === 2);

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
