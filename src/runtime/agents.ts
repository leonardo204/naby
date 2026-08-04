// src/runtime/agents.ts
//
// THE naby AGENT LAYER (Phase 3, P3-M1).
//
// naby's north star is a product that ACTS FOR the user, not merely a tool-host.
// This module owns the built-in PERSONA — the agent that learns the user and,
// once wired (P3-M2..M4), carries out delegated work, escalating only the
// critical calls. It is the seed + a couple of pure helpers over the `Agent`
// slice of the Store (store.ts); the CRUD itself lives on the store.
//
// WHY A STABLE, WELL-KNOWN ID: seeding must be IDEMPOTENT across restarts (we do
// not want a second persona on every boot), and the persona must stay
// addressable for its lifetime. A fixed id gives both: seedBuiltinPersona keys
// on it, and every later feature (memory injection, growth, export) points at
// the same row for the life of the install.
//
// THE PERSONA IS BUILT-IN AND READ-ONLY (user decision, 2026-07-30 — it replaces
// M1's "editable but undeletable"). Two invariants, both enforced in the STORE so
// a stray shell call cannot bypass either:
//
//   * UNDELETABLE — removeAgent no-ops a kind='persona' row.
//   * UNEDITABLE  — putAgent THROWS on any write to a persona row (and on any
//     attempt to mint a second persona). The one exception is
//     `store.restoreBuiltinPersona`, which exists for the seed below and for
//     nothing else.
//
// So seeding is no longer merely "insert when absent": it ENFORCES the seed. An
// install that ran an older build may carry a persona the user edited, and that
// row is exactly the drift the read-only rule exists to prevent — so the seed
// writes it back on the next boot rather than leaving one machine permanently
// off-contract. Only `id` and `createdAt` survive.

import type { Agent, AgentInput, Store } from './store/store.js';

/** The built-in persona's stable id. Seeding keys on it, and it is the persona's
 *  permanent handle for the life of the install — the ledger, its memory and its
 *  growth history all hang off it. */
export const BUILTIN_PERSONA_ID = 'agent-persona-builtin';

/** The `@name` the built-in persona is addressed by. It is part of the seed, so
 *  it is what the persona is called; the only way it differs is the collision
 *  corner described on `seedBuiltinPersona`.
 *
 *  2026-08-03 (user decision): the handle is `naby` — the persona IS the product,
 *  not a role the product hosts, and `@persona` named it as if it were one of
 *  several. Specialist roles are harness subagents; there is exactly one naby
 *  agent. Only the NAME moved: `kind='persona'` stays as the type discriminator
 *  every invariant keys on, and so does BUILTIN_PERSONA_ID, so no install loses
 *  its ledger, memory or growth history over a rename. */
export const BUILTIN_PERSONA_NAME = 'naby';

/** The seed row for the built-in persona. Deliberately conservative: no tool
 *  restriction (inherits the turn's toolset), memory scoped to the user (so what
 *  it learns outlives any one session/project), and INLINE escalation until the
 *  telegram channel is wired in P3-M3. The prompt states the persona contract in
 *  plain terms; learned context is injected at turn time (P3-M2), never inlined.
 *
 *  P3-M9 (G3): THE SEED IS NOW THE PERSONA'S ONLY WRITABLE SURFACE. Locking the
 *  row (read-only, 2026-07-30) means the user can no longer add an operating rule
 *  by editing the prompt, so the prompt itself has to carry the operating
 *  protocols the persona needs to be delegable — memory-first, clarify early,
 *  verify before done, and a report format. They are written at the "right
 *  altitude": heuristics the model applies with judgment, not an exhaustive
 *  rulebook it pattern-matches against.
 *
 *  Because `seedBuiltinPersona` ENFORCES this text (see below), editing it here
 *  is also how an already-installed persona is upgraded: the lock mechanism is
 *  the prompt's delivery channel. Add a protocol here and every install picks it
 *  up on its next boot. */
export const BUILTIN_PERSONA_SEED: AgentInput = {
  id: BUILTIN_PERSONA_ID,
  name: BUILTIN_PERSONA_NAME,
  kind: 'persona',
  description: 'naby — your personal agent. Learns how you decide and acts on your behalf.',
  systemPrompt: [
    'You are naby, the user\'s personal agent.',
    'Your job is to act ON THE USER\'S BEHALF: carry out delegated work the way',
    'they would, using what you have learned about their judgment, preferences and',
    'style (provided to you as injected memory).',
    '',
    'Operating principles:',
    '- Prefer to finish the task autonomously. Do not stop to ask about routine,',
    '  low-risk steps you are confident the user would approve.',
    '- Escalate ONLY genuinely critical or irreversible decisions (spending money,',
    '  deleting data, sending outward-facing communication, anything you are not',
    '  confident the user would want) — surface these for approval rather than',
    '  guessing.',
    '',
    'Operating protocols:',
    '- MEMORY FIRST. Read the injected memory before you plan, and let it decide',
    '  how you work. A confirmed procedural memory is a STANDING RULE — follow it',
    '  unless the user overrides it in this turn. This is how you get better: your',
    '  instructions never change, what you have learned does.',
    '- CLARIFY EARLY. If the goal or the definition of done is ambiguous, ask',
    '  within your FIRST few steps — never once the work is largely finished,',
    '  where the answer only buys a rewrite. Routine, low-risk steps still do not',
    '  warrant a question.',
    '- VERIFY BEFORE DONE. Do not declare a task finished until you have checked',
    '  the result against its success criteria. What you checked, and how, is part',
    '  of the report — not an afterthought.',
    '- REPORT in four parts, concisely: what you DID, what you DECIDED, what you',
    '  VERIFIED, and what you deliberately LEFT for the user.',
    '- LANGUAGE. Mirror the user\'s language. In Korean, write natural, polite',
    '  everyday Korean (해요체/합니다체): no crude or slangy idioms, no awkward',
    '  word-for-word translations of an English phrase, and keep questions short',
    '  and concrete.',
  ].join('\n'),
  memoryScope: 'user',
  // P3-M9 (G1): SHAPE COMPATIBILITY ONLY. How much the user delegates to the
  // persona is the USER's setting, not the agent definition's, so the engine
  // reads `persona.autonomy.*` from settings for a kind='persona' turn and
  // ignores this field. It stays because `Agent` requires it and because a
  // custom agent — whose row IS editable — still reads its own.
  autonomy: { escalation: 'inline' },
};

/** The fields the seed OWNS. `id` and `createdAt` are deliberately absent —
 *  those are the row's identity and its age, and healing a drifted persona must
 *  not mint a new agent or pretend it was created today. `updatedAt` is the
 *  store's. */
const SEEDED_FIELDS = [
  'name',
  'kind',
  'description',
  'systemPrompt',
  'model',
  'toolRefs',
  'memoryScope',
  'autonomy',
] as const;

/**
 * Does the stored persona still say exactly what the seed says?
 *
 * Compared by VALUE over the seeded fields, with `toolRefs`/`autonomy` compared
 * structurally (a stored `{escalation:'inline'}` is a different object every
 * read). `undefined` in the seed must match `undefined` in the row: the seed
 * pins NO model and NO tool restriction, so a stored model is drift, not a
 * default.
 */
export function builtinPersonaMatchesSeed(agent: Agent, seed: AgentInput): boolean {
  return SEEDED_FIELDS.every((field) => {
    const want = seed[field];
    const got = (agent as Record<string, unknown>)[field];
    if (want === undefined || got === undefined) return want === undefined && got === undefined;
    if (typeof want === 'object') return JSON.stringify(want) === JSON.stringify(got);
    return want === got;
  });
}

/**
 * Ensure the built-in persona exists AND matches the seed. Returns it as it now
 * stands in the store.
 *
 * Three outcomes, in order of how often they happen:
 *
 *   1. the row is already the seed  -> nothing is written (still idempotent: a
 *      second call in the same boot does no work);
 *   2. the row is absent            -> the seed is inserted;
 *   3. the row DRIFTED              -> it is written back to the seed. This is
 *      the heal for installs that edited their persona under an older build; the
 *      row keeps its id and createdAt, so its ledger, memory and growth history
 *      all stay attached.
 *
 * THE HEAL IS ALSO THE RENAME CHANNEL (2026-08-03). Every install made before the
 * handle became `naby` holds a row named `persona`, which `builtinPersonaMatchesSeed`
 * reads as drift (`name` is a seeded field) — so the ordinary boot heal renames it
 * to `@naby` in place, keeping id, createdAt and therefore its whole history. No
 * migration is needed and none is written.
 *
 * THE ONE CONCESSION, and it is about not damaging the user's own data. Restoring
 * the seed restores the seed NAME, and a user could already hold a custom agent
 * called `@naby` (or, before this rename, `@persona`). Taking that name back would
 * either throw (breaking boot) or require renaming an agent the user made. Neither
 * is worth it for a handle, so in that one case the row is restored in full EXCEPT
 * its name, which stays as the user left it — a pre-rename install simply keeps
 * `@persona`. Everything that governs behaviour — the prompt, the scope, the
 * autonomy — is still the seed's.
 */
export function seedBuiltinPersona(store: Store): Agent {
  const existing = store.getAgent(BUILTIN_PERSONA_ID);
  if (existing && builtinPersonaMatchesSeed(existing, BUILTIN_PERSONA_SEED)) return existing;

  const nameHolder = store.getAgentByName(BUILTIN_PERSONA_SEED.name);
  const nameTaken = nameHolder !== undefined && nameHolder.id !== BUILTIN_PERSONA_ID;
  const seed: AgentInput = nameTaken
    ? { ...BUILTIN_PERSONA_SEED, name: existing ? existing.name : freeName(store) }
    : BUILTIN_PERSONA_SEED;
  return store.restoreBuiltinPersona(seed);
}

/** A handle nobody holds, for the corner where the seed name is taken and there
 *  is no persona row to inherit a name from. Bounded, and it never returns a name
 *  already in use — the store would throw on it. */
function freeName(store: Store): string {
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${BUILTIN_PERSONA_NAME}-${n}`;
    if (!store.getAgentByName(candidate)) return candidate;
  }
  return `${BUILTIN_PERSONA_NAME}-${Date.now()}`;
}

/** True when an agent is the built-in persona (kind='persona'). The store keys
 *  BOTH invariants on this same predicate: undeletable and uneditable. */
export function isBuiltinPersona(agent: Agent): boolean {
  return agent.kind === 'persona';
}

// ---------------------------------------------------------------------------
// `@name` addressing (Phase 3, P3-M2).
// ---------------------------------------------------------------------------
//
// A turn is ROUTED to a naby agent when its prompt begins with `@<name>` and
// <name> resolves to a registered agent (via store.getAgentByName). This pure
// parser only splits the address from the task text — the store lookup and the
// turn composition happen at the shell's engine boundary. It is pure and
// spike-testable so the routing contract does not depend on a live model.
//
// COLLISION RULE (spec §5): a registered agent name wins over a harness subagent
// `@verb` and over a file reference. The shell's command expander defers to this
// by leaving an `@<registeredAgent>` line unexpanded so it reaches routing here.
//
// The name token is whitespace-delimited (`[^\s]+`), matching the store's
// name rule (putAgent rejects a name containing whitespace) — so any valid agent
// name is addressable, and a stray `@` in prose (not at line start, or followed
// by whitespace) never routes.

/** Parse a leading `@<name> <task>` address off a prompt. Returns the bare name
 *  and the remaining task text (trimmed), or undefined when the prompt does not
 *  start with an `@name` token. Does NOT consult the store — the caller resolves
 *  the name to an agent and decides whether to route. */
export function parseAgentAddress(
  prompt: string,
): { name: string; taskText: string } | undefined {
  const m = prompt.match(/^\s*@([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!m) return undefined;
  return { name: m[1]!, taskText: (m[2] ?? '').trim() };
}
