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
// addressable for its lifetime even as the user edits it. A fixed id gives both:
// seedBuiltinPersona checks for the id and only inserts when it is absent, and it
// never overwrites the row afterwards (the user's edits win).
//
// THE UNDELETABLE INVARIANT (spec §4) is enforced in the store — removeAgent
// no-ops a kind='persona' row — not here, so a stray shell call cannot bypass it.

import type { Agent, AgentInput, Store } from './store/store.js';

/** The built-in persona's stable id. Seeding keys on it (idempotent) and it is
 *  the persona's permanent handle even after the user renames/edits it. */
export const BUILTIN_PERSONA_ID = 'agent-persona-builtin';

/** The default `@name` the built-in persona is addressed by. The user may rename
 *  it; this is only the seed value. */
export const BUILTIN_PERSONA_NAME = 'persona';

/** The seed row for the built-in persona. Deliberately conservative: no tool
 *  restriction (inherits the turn's toolset), memory scoped to the user (so what
 *  it learns outlives any one session/project), and INLINE escalation until the
 *  telegram channel is wired in P3-M3. The prompt states the persona contract in
 *  plain terms; learned context is injected at turn time (P3-M2), never inlined. */
export const BUILTIN_PERSONA_SEED: AgentInput = {
  id: BUILTIN_PERSONA_ID,
  name: BUILTIN_PERSONA_NAME,
  kind: 'persona',
  description: 'Your personal persona agent — learns how you decide and acts on your behalf.',
  systemPrompt: [
    'You are the user\'s personal persona agent inside naby.',
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
    '- When you finish, report concisely: what you did, what you decided, and',
    '  anything you deliberately left for the user.',
  ].join('\n'),
  memoryScope: 'user',
  autonomy: { escalation: 'inline' },
};

/** Ensure the built-in persona exists. IDEMPOTENT: inserts the seed only when the
 *  persona id is absent, and NEVER overwrites an existing row (the user's edits
 *  are preserved). Returns the persona as it now stands in the store. */
export function seedBuiltinPersona(store: Store): Agent {
  const existing = store.getAgent(BUILTIN_PERSONA_ID);
  if (existing) return existing;
  return store.putAgent(BUILTIN_PERSONA_SEED);
}

/** True when an agent is the built-in persona (kind='persona'). The store keys
 *  the undeletable invariant on the same predicate. */
export function isBuiltinPersona(agent: Agent): boolean {
  return agent.kind === 'persona';
}
