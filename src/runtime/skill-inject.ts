// src/runtime/skill-inject.ts
//
// TURN-TIME SKILL INSTRUCTION INJECTION (phase-1_6-harness-contracts §3, impl
// HP-03a). The harness twin of memory-inject.ts: pure trigger-matching + ranking
// + token-budget selection, plus a small store-reading gatherer and a renderer.
// Provider- and engine-independent — it runs in the runtime ABOVE the engine
// seam (design §3.4), so an instruction-only skill behaves identically whichever
// model answers, and its `instructions` assemble into the turn's SYSTEM field
// (never a stored transcript message), exactly where memory injection attaches
// (P15-02). No engine-interface change.
//
// The load-bearing invariants:
//   * INSTRUCTION-ONLY. A skill with `toolRefs` (non-empty) is NOT injected here
//     — its tools cannot run until Phase 2.5, and half-running its instructions
//     without them is the "silent half-working skill" risk (impl §6). Such a
//     skill is EXCLUDED and COUNTED (excludedForTools) so the omission is
//     observable, never silent.
//   * ENABLED-ONLY. Only `status:'enabled'` skills participate (contract §4) —
//     an imported/disabled skill is inert until reviewed.
//   * TRIGGER-GATED. A skill with `triggers` injects only when the turn text
//     matches one; a skill with no triggers is ALWAYS-ON (always relevant).
//   * Budget is a HARD ceiling: tokensUsed ≤ tokenBudget, always. Over-budget
//     candidates are dropped and COUNTED (droppedForBudget) — never silently.
//   * Empty is a NO-OP: no relevant skill ⇒ inject nothing ⇒ the turn is
//     byte-for-byte what it would have been without HP-03a.
//
// Its token budget is a SEPARATE parameter from memory's (impl step 4): the two
// blocks assemble side by side under distinct section headers, each capped on its
// own. This keeps each invariant local and the accounting simple.

import { DEFAULT_USER_ID, estimateTokens } from './memory-inject.js';
import type { HarnessItem, HarnessScope, Store } from './store/store.js';

/** Single-user machine default — the user scopeKey is a constant until multi-user
 * rollout (contract §2). Mirrors memory-inject's DEFAULT_USER_ID; re-exported for
 * callers that want a single import site. */
export { DEFAULT_USER_ID };

/** The inputs one turn needs to select skills. `userText` is what the trigger
 * hints are matched against; `cwd`, when set, adds the project-scope skills. */
export type SkillInjectionQuery = {
  /** The turn's user text — trigger hints match against this. */
  userText: string;
  /** HARD cap on injected skill tokens for this turn. */
  tokenBudget: number;
  /** project scopeKey — only when the session is projected. */
  cwd?: string;
  /** The bare names of every tool THIS turn can actually run (runtime tools + MCP
   *  + the engine's built-ins). A tool-bearing skill is injected only when EVERY
   *  `toolRef` it declares is in this set — otherwise it is excluded and counted,
   *  so a skill never half-runs against a tool the turn cannot call (Phase 2.5).
   *  Omitted ⇒ no tool is considered available ⇒ every tool-bearing skill is
   *  excluded (the pre-2.5 behaviour, preserved for callers that don't pass it). */
  availableTools?: string[];
};

/** What was selected for a turn. `skills` are the injected instruction-only
 * skills in ranked order; `excludedForTools` counts relevant, enabled skills that
 * were held back because they carry tools (Phase 2.5). */
export type InjectedSkills = {
  skills: HarnessItem[];
  tokensUsed: number;
  droppedForBudget: number;
  excludedForTools: number;
};

/** Scope precedence on ties: project (most specific to this turn) first, org
 * last. Mirrors memory's scope precedence, minus session (harness has none). */
const SCOPE_RANK: Record<HarnessScope, number> = {
  project: 0,
  user: 1,
  org: 2,
};

/** A skill is INSTRUCTION-ONLY when it has a skill payload and no (or empty)
 * toolRefs. Such a skill is always injectable — it needs no tool present. */
export function isInstructionOnly(item: HarnessItem): boolean {
  const skill = item.skill;
  if (!skill) return false;
  return skill.toolRefs === undefined || skill.toolRefs.length === 0;
}

/** Whether a skill's declared tools are ALL available this turn (Phase 2.5). An
 * instruction-only skill is trivially satisfied; a tool-bearing skill needs every
 * `toolRef` present in `availableTools`. With no `availableTools` set, a
 * tool-bearing skill is NOT satisfied — the safe default that keeps it excluded
 * (and counted) rather than half-running against absent tools. */
export function skillToolsSatisfied(
  item: HarnessItem,
  availableTools: ReadonlySet<string> | undefined,
): boolean {
  const refs = item.skill?.toolRefs;
  if (refs === undefined || refs.length === 0) return true;
  if (!availableTools) return false;
  return refs.every((r) => availableTools.has(r));
}

/** Whether a skill is relevant to this turn: a skill with no triggers is
 * always-on; a skill with triggers matches when any trigger appears (case-
 * insensitively) in the turn text. */
export function skillMatchesTurn(item: HarnessItem, userText: string): boolean {
  const triggers = item.skill?.triggers;
  if (triggers === undefined || triggers.length === 0) return true; // always-on
  const hay = userText.toLowerCase();
  return triggers.some((t) => t.length > 0 && hay.includes(t.toLowerCase()));
}

/** Rank candidates deepest-first: scope precedence, then most-recently-updated.
 * (Real relevance ranking is a later phase; this is the deterministic order.) */
function rankSkills(items: readonly HarnessItem[]): HarnessItem[] {
  return [...items].sort((a, b) => {
    const s = SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope];
    if (s !== 0) return s;
    return b.updatedAt - a.updatedAt; // newest first
  });
}

/** The rendered block for one skill — also the unit the budget is measured in, so
 * selection and rendering can never disagree on cost. */
export function renderSkillBlock(item: HarnessItem): string {
  const instructions = item.skill?.instructions ?? '';
  return `## ${item.name}\n${instructions}`;
}

/**
 * Select, rank, and budget candidate skills for one turn. PURE. Filters to
 * enabled + relevant; a skill PARTICIPATES when it is instruction-only OR every
 * tool it declares is available this turn (`availableTools`) — a tool-bearing
 * skill whose tools are absent is held back and COUNTED (`excludedForTools`), so
 * it never half-runs (Phase 2.5). Participants are ranked by precedence and
 * greedily filled up to `tokenBudget`; anything over the cap is dropped and
 * counted. `tokensUsed` is ALWAYS ≤ tokenBudget.
 */
export function selectSkillsForInjection(
  candidates: readonly HarnessItem[],
  userText: string,
  tokenBudget: number,
  availableTools?: ReadonlySet<string>,
): InjectedSkills {
  const budget = Math.max(0, Math.floor(tokenBudget));

  // Enabled skills only, that are relevant to this turn (trigger or always-on).
  const relevant = candidates.filter(
    (c) =>
      c.kind === 'skill' &&
      c.skill !== undefined &&
      c.status === 'enabled' &&
      skillMatchesTurn(c, userText),
  );

  // A tool-bearing skill participates only when its tools are all present this
  // turn; otherwise it is held back and counted so the omission is observable
  // (impl §6 "no silent half-working skills").
  const participates = (c: HarnessItem) => skillToolsSatisfied(c, availableTools);
  const excludedForTools = relevant.filter((c) => !participates(c)).length;

  const ranked = rankSkills(relevant.filter(participates));

  const skills: HarnessItem[] = [];
  let tokensUsed = 0;
  let droppedForBudget = 0;

  for (const item of ranked) {
    const cost = estimateTokens(renderSkillBlock(item));
    if (tokensUsed + cost <= budget) {
      skills.push(item);
      tokensUsed += cost;
    } else {
      // Dropped PURELY due to the cap — counted, never silent.
      droppedForBudget += 1;
    }
  }

  return { skills, tokensUsed, droppedForBudget, excludedForTools };
}

/**
 * Read the candidate skills for a query from the store: enabled skills from the
 * project (if projected), user, and org scopes. Harness has no session scope
 * (contract §2). The user/org scopeKeys are single-user-machine constants until
 * multi-user rollout and may be overridden.
 */
export function gatherSkillCandidates(
  store: Store,
  query: SkillInjectionQuery,
  opts?: { userId?: string; orgId?: string },
): HarnessItem[] {
  const out: HarnessItem[] = [];
  // project scope (only when the session is projected)
  if (query.cwd) {
    out.push(
      ...store.listHarness('project', query.cwd, { kind: 'skill', status: 'enabled' }),
    );
  }
  // user scope (a constant scopeKey on a single-user machine)
  const userId = opts?.userId ?? DEFAULT_USER_ID;
  out.push(...store.listHarness('user', userId, { kind: 'skill', status: 'enabled' }));
  // org scope (only when an org id is supplied)
  if (opts?.orgId) {
    out.push(
      ...store.listHarness('org', opts.orgId, { kind: 'skill', status: 'enabled' }),
    );
  }
  return out;
}

/**
 * Gather + select in one call: the store-reading entry point runTurn uses.
 * Returns the ranked, budgeted, enabled, instruction-only injection set.
 */
export function retrieveSkillsForInjection(
  store: Store,
  query: SkillInjectionQuery,
  opts?: { userId?: string; orgId?: string },
): InjectedSkills {
  return selectSkillsForInjection(
    gatherSkillCandidates(store, query, opts),
    query.userText,
    query.tokenBudget,
    query.availableTools ? new Set(query.availableTools) : undefined,
  );
}

/**
 * Render the selected skills as a system-prompt block. Returns `undefined` when
 * there is nothing to inject, so the caller can leave the turn's system field
 * BYTE-FOR-BYTE unchanged (the no-op invariant).
 */
export function renderInjectedSkills(injected: InjectedSkills): string | undefined {
  if (injected.skills.length === 0) return undefined;
  const blocks = injected.skills.map(renderSkillBlock);
  return [
    'Skills available for this turn (apply where they fit; do not mention this block):',
    ...blocks,
  ].join('\n\n');
}

/**
 * Compose a turn's effective system prompt from the caller's base system and the
 * injected skill block. When there is nothing to inject, returns the base
 * UNCHANGED (including `undefined`) — the no-op guarantee. When there is, the
 * skill block is appended after the base (and after any memory block the base
 * already carries) under its own header, so the base instruction still leads and
 * the two injected blocks sit side by side.
 */
export function composeSystemWithSkills(
  baseSystem: string | undefined,
  injected: InjectedSkills,
): string | undefined {
  const block = renderInjectedSkills(injected);
  if (block === undefined) return baseSystem; // NO-OP: byte-for-byte unchanged
  if (baseSystem === undefined || baseSystem.length === 0) return block;
  return `${baseSystem}\n\n${block}`;
}
