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
//
// -- EXPLICIT NAMING (`explicitNames`) ---------------------------------------
//
// Everything above is AUTOMATIC relevance: the turn's words happen to contain a
// trigger, or the skill is always-on. `explicitNames` is the other case — the
// user wrote the row's name into the sentence ("…를 /plan-review 스킬로 해봐"),
// which is not a hint to be ranked but an instruction. Three consequences, and
// they are the whole feature:
//
//   * TRIGGER-INDEPENDENT. A named row participates even when no trigger of its
//     matches. Someone who typed the name has already answered the question
//     triggers exist to guess at.
//   * FIRST IN THE BUDGET. Named rows are ranked ahead of everything automatic,
//     so a turn crowded with always-on skills cannot push out the one the user
//     asked for by name. The cap itself is still HARD — a named row bigger than
//     the whole budget is dropped and counted like anything else, because a
//     silent overrun is worse than a counted omission.
//   * ANY KIND, not just skills. The composer's "/" palette is UNIFIED: command,
//     skill and subagent rows sit in one list, and a command row carries no glyph
//     at all, so the user cannot tell which kind they picked. A rule that worked
//     for skills and silently did nothing for commands would be a new invisible
//     failure of exactly the kind this feature fixes. So a NAMED row of any kind
//     contributes its kind-appropriate body (`harnessBody`), the same mapping the
//     shell's line-led dispatcher uses. Non-skill rows still participate ONLY
//     when named — they have no triggers, so "no triggers" must not be read as
//     "always-on" for them.
//
// What explicit naming does NOT override: `status:'enabled'` (a disabled row
// stays inert — it is disabled), the tool gate (a named tool-bearing skill whose
// tools are absent is still excluded and counted, since half-running it is the
// risk the gate exists for), and the budget ceiling. A name nobody registered
// matches nothing and changes nothing — no warning, no expansion.

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
  /** Harness rows the user NAMED in this turn's text — `/plan-review` written
   *  inside a sentence (shell: `shared/slashTokens.ts`). See EXPLICIT NAMING at
   *  the head of this file: a named row is relevant whatever its triggers say,
   *  is budgeted FIRST, and may be any kind. Empty/omitted ⇒ nothing about the
   *  turn changes. */
  explicitNames?: string[];
  /** ON-DEMAND SKILLS (org-harness-sync §3.3) — see ON-DEMAND ROWS below. Absent
   *  ⇒ an on-demand row is never listed or loaded (it is still excluded and
   *  counted when its tools are absent, which is what an older build does). */
  onDemand?: OnDemandQuery;
};

// -- ON-DEMAND ROWS (org-harness-sync §3.3) -----------------------------------
//
// A row with `skill.loadMode: 'on-demand'` carries no body: its `instructions` is
// a one-paragraph description and the real SKILL.md (24–84KB for the org skills)
// lives in a package on disk, read by the `naby_skill_load` tool. Such a row
// therefore NEVER enters the body selection above — injecting a description as
// if it were instructions is the failure the payload shape exists to prevent.
// Instead it joins a separate LISTING (name + description), on its own budget and
// its own counters, so the body budget and every existing skill's behaviour are
// untouched: a turn with no on-demand rows takes byte-for-byte the old path.
//
// What still applies to an on-demand row, unchanged: `enabled` only, the tool
// gate (no `naby_skill_load` or no `run_command` this turn ⇒ excluded and counted
// in `excludedForTools`), and scope precedence — an enabled project/user skill of
// the same name SHADOWS it (§3.2: the copy hides the org version), so the listing
// never offers two things under one name.
//
// What is new: the caller's switch (`enabled`, the org kill switch resolved once
// at turn start, honoured whatever the row's status says), and PRELOADING — a
// row the user named (`explicitNames`, e.g. `/task start …`) gets its full body
// in the system field this turn via `loadBody`, the same text the tool returns.
// A preload is NOT charged to either budget: it is the tool's answer delivered
// early, and dropping it for size would make naming a skill do nothing.

export type OnDemandQuery = {
  /** The org kill switch for this turn (settings toggle + env), resolved at turn
   *  start. False ⇒ nothing is listed or preloaded, whatever the rows say. */
  enabled: boolean;
  /** HARD cap on listing tokens, separate from `tokenBudget`. */
  listingTokenBudget: number;
  /** The text `naby_skill_load` would return for this row, for a named row's
   *  preload. Undefined/returns undefined ⇒ no preload (the listing still shows
   *  it, and the model can call the tool). */
  loadBody?: (item: HarnessItem) => string | undefined;
};

/** What the on-demand half of a turn's selection did. Present only when the
 *  candidates held an on-demand row, so a turn without one reports exactly the
 *  fields it always did. */
export type OnDemandSelection = {
  /** Listed rows, in listing order (named first, then by name). */
  listed: HarnessItem[];
  listingTokens: number;
  listingDroppedForBudget: number;
  /** Named rows whose body was loaded into this turn. */
  preloaded: { item: HarnessItem; text: string }[];
  preloadTokens: number;
  /** Enabled, tool-satisfied rows held back by the kill switch. */
  switchedOff: number;
  /** Rows hidden by an enabled same-name project/user skill. */
  shadowed: number;
};

/** What was selected for a turn. `skills` are the injected instruction-only
 * skills in ranked order; `excludedForTools` counts relevant, enabled skills that
 * were held back because they carry tools (Phase 2.5). */
export type InjectedSkills = {
  skills: HarnessItem[];
  tokensUsed: number;
  droppedForBudget: number;
  excludedForTools: number;
  /** The on-demand listing and preloads (see ON-DEMAND ROWS). Absent when no
   *  on-demand row was a candidate. */
  onDemand?: OnDemandSelection;
};

/** Whether a row's body lives in a package and is loaded on demand. */
export function isOnDemandSkill(item: HarnessItem): boolean {
  return item.kind === 'skill' && item.skill?.loadMode === 'on-demand';
}

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

/** The name lookup key — harness names are matched case-insensitively, because
 * the composer lowercases what the user typed and the stored row need not be. */
function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** The set of names this turn asked for by name. Empty when nothing was named,
 * which is the path every pre-existing caller takes. */
export function explicitNameSet(names: readonly string[] | undefined): ReadonlySet<string> {
  const set = new Set<string>();
  for (const n of names ?? []) {
    const key = nameKey(n);
    if (key.length > 0) set.add(key);
  }
  return set;
}

/** Whether this row is one the turn NAMED. */
export function isExplicitlyNamed(
  item: HarnessItem,
  explicit: ReadonlySet<string>,
): boolean {
  return explicit.size > 0 && explicit.has(nameKey(item.name));
}

/** The prompt text one harness row contributes, by kind — the same mapping the
 * shell's line-led dispatcher uses (`ownedBody` in lib/slashCommands.ts), so a
 * row named mid-sentence and the same row invoked at the head of a line bring
 * the same words into the turn. For a skill this is exactly what
 * `renderSkillBlock` always read, so the skill path is byte-for-byte unchanged. */
export function harnessBody(item: HarnessItem): string {
  if (item.kind === 'skill') return item.skill?.instructions ?? '';
  if (item.kind === 'command') return item.command?.template ?? '';
  if (item.kind === 'subagent') return item.subagent?.systemPrompt ?? '';
  return '';
}

/** The rendered block for one row — also the unit the budget is measured in, so
 * selection and rendering can never disagree on cost. */
export function renderSkillBlock(item: HarnessItem): string {
  return `## ${item.name}\n${harnessBody(item)}`;
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
  allCandidates: readonly HarnessItem[],
  userText: string,
  tokenBudget: number,
  availableTools?: ReadonlySet<string>,
  explicitNames?: readonly string[],
  onDemandQuery?: OnDemandQuery,
): InjectedSkills {
  const budget = Math.max(0, Math.floor(tokenBudget));
  const explicit = explicitNameSet(explicitNames);
  // On-demand rows take their own path (ON-DEMAND ROWS, above). Everything below
  // until `return` is the established selection, run over the rest unchanged.
  const candidates = allCandidates.filter((c) => !isOnDemandSkill(c));
  const onDemandCandidates = allCandidates.filter(isOnDemandSkill);

  // Two ways in, and only two:
  //   * NAMED — the user wrote this row's name in the turn. Any kind, whatever
  //     its triggers say. A row with no body to contribute is not a way in: an
  //     empty block would spend a header's worth of budget to say nothing.
  //   * AUTOMATIC — a skill (only a skill: a command has no triggers, so the
  //     always-on branch of `skillMatchesTurn` would make every one of them fire
  //     on every turn) that is relevant by trigger or is always-on.
  // Both require `enabled`; explicit naming does not resurrect a disabled row.
  const relevant = candidates.filter((c) => {
    if (c.status !== 'enabled') return false;
    if (isExplicitlyNamed(c, explicit)) return harnessBody(c).length > 0;
    return c.kind === 'skill' && c.skill !== undefined && skillMatchesTurn(c, userText);
  });

  // A tool-bearing skill participates only when its tools are all present this
  // turn; otherwise it is held back and counted so the omission is observable
  // (impl §6 "no silent half-working skills"). Naming it does NOT waive this —
  // half-running against absent tools is the risk, whoever asked for it.
  const participates = (c: HarnessItem) => skillToolsSatisfied(c, availableTools);
  const excludedForTools = relevant.filter((c) => !participates(c)).length;

  // NAMED ROWS LEAD, in the order they were named, so the budget below spends on
  // what the user asked for before it spends on what merely matched. Everything
  // else keeps the established precedence order.
  const participating = relevant.filter(participates);
  const namedOrder = new Map<string, number>();
  for (const n of explicitNames ?? []) {
    const key = nameKey(n);
    if (key.length > 0 && !namedOrder.has(key)) namedOrder.set(key, namedOrder.size);
  }
  const named = participating
    .filter((c) => isExplicitlyNamed(c, explicit))
    .sort((a, b) => {
      const order =
        (namedOrder.get(nameKey(a.name)) ?? 0) - (namedOrder.get(nameKey(b.name)) ?? 0);
      // Same name in two scopes: the more specific one first, as everywhere else.
      return order !== 0 ? order : SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope];
    });
  const ranked = [
    ...named,
    ...rankSkills(participating.filter((c) => !isExplicitlyNamed(c, explicit))),
  ];

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

  if (onDemandCandidates.length === 0) {
    return { skills, tokensUsed, droppedForBudget, excludedForTools };
  }
  const od = selectOnDemand(onDemandCandidates, candidates, availableTools, explicit, explicitNames, onDemandQuery);
  return {
    skills,
    tokensUsed,
    droppedForBudget,
    excludedForTools: excludedForTools + od.excludedForTools,
    onDemand: od.selection,
  };
}

/** One listing line — also the unit the listing budget is measured in. */
export function renderOnDemandLine(item: HarnessItem): string {
  const desc = (item.skill?.instructions ?? item.description ?? '').replace(/\s+/g, ' ').trim();
  return `- ${item.name}: ${desc}`;
}

function selectOnDemand(
  rows: readonly HarnessItem[],
  others: readonly HarnessItem[],
  availableTools: ReadonlySet<string> | undefined,
  explicit: ReadonlySet<string>,
  explicitNames: readonly string[] | undefined,
  query: OnDemandQuery | undefined,
): { excludedForTools: number; selection: OnDemandSelection } {
  const selection: OnDemandSelection = {
    listed: [],
    listingTokens: 0,
    listingDroppedForBudget: 0,
    preloaded: [],
    preloadTokens: 0,
    switchedOff: 0,
    shadowed: 0,
  };
  let excludedForTools = 0;
  const eligible: HarnessItem[] = [];
  for (const row of rows) {
    if (row.status !== 'enabled') continue;
    // The tool gate first: this is the count an older build reports, and it must
    // not depend on whether the switch happens to be on.
    if (!skillToolsSatisfied(row, availableTools)) {
      excludedForTools += 1;
      continue;
    }
    if (!query?.enabled) {
      selection.switchedOff += 1;
      continue;
    }
    const key = nameKey(row.name);
    const shadow = others.some(
      (o) =>
        o.status === 'enabled' &&
        o.kind === 'skill' &&
        nameKey(o.name) === key &&
        SCOPE_RANK[o.scope] < SCOPE_RANK[row.scope],
    );
    if (shadow) {
      selection.shadowed += 1;
      continue;
    }
    if (eligible.some((e) => nameKey(e.name) === key)) continue; // one entry per name
    eligible.push(row);
  }

  // Named first, in the order named; then by name — deterministic, and the one
  // the user asked for cannot be crowded out of the listing.
  const namedOrder = new Map<string, number>();
  for (const n of explicitNames ?? []) {
    const key = nameKey(n);
    if (key.length > 0 && !namedOrder.has(key)) namedOrder.set(key, namedOrder.size);
  }
  const ordered = [...eligible].sort((a, b) => {
    const na = namedOrder.get(nameKey(a.name));
    const nb = namedOrder.get(nameKey(b.name));
    if (na !== undefined || nb !== undefined) {
      if (na === undefined) return 1;
      if (nb === undefined) return -1;
      return na - nb;
    }
    return nameKey(a.name).localeCompare(nameKey(b.name));
  });

  const cap = Math.max(0, Math.floor(query?.listingTokenBudget ?? 0));
  for (const row of ordered) {
    const cost = estimateTokens(renderOnDemandLine(row));
    if (selection.listingTokens + cost <= cap) {
      selection.listed.push(row);
      selection.listingTokens += cost;
    } else {
      selection.listingDroppedForBudget += 1;
    }
  }

  for (const row of selection.listed) {
    if (!isExplicitlyNamed(row, explicit) || !query?.loadBody) continue;
    let text: string | undefined;
    try {
      text = query.loadBody(row);
    } catch {
      text = undefined;
    }
    if (!text) continue;
    selection.preloaded.push({ item: row, text });
    selection.preloadTokens += estimateTokens(text);
  }
  return { excludedForTools, selection };
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
  const explicit = explicitNameSet(query.explicitNames);
  // WITH NOTHING NAMED this is the exact query it always was — skills only, asked
  // of the store. A named row may be a command or a subagent, so that turn (and
  // only that turn) has to see the other kinds; they are then narrowed to the
  // names actually asked for, so nothing else about the selection changes.
  const listScope = (scope: HarnessScope, scopeKey: string): HarnessItem[] => {
    if (explicit.size === 0) {
      return store.listHarness(scope, scopeKey, { kind: 'skill', status: 'enabled' });
    }
    return store
      .listHarness(scope, scopeKey, { status: 'enabled' })
      .filter((item) => item.kind === 'skill' || isExplicitlyNamed(item, explicit));
  };

  const out: HarnessItem[] = [];
  // project scope (only when the session is projected)
  if (query.cwd) {
    out.push(...listScope('project', query.cwd));
  }
  // user scope (a constant scopeKey on a single-user machine)
  const userId = opts?.userId ?? DEFAULT_USER_ID;
  out.push(...listScope('user', userId));
  // org scope (only when an org id is supplied)
  if (opts?.orgId) {
    out.push(...listScope('org', opts.orgId));
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
    query.explicitNames,
    query.onDemand,
  );
}

/** The listing block's header. Carries the one instruction the listing exists
 *  for: read the body before acting on a listed skill. */
export const ON_DEMAND_LISTING_HEADER =
  'Skills you can load on demand (do not mention this block). Before you use one, call ' +
  'naby_skill_load with its name to read its full instructions; the description alone is not ' +
  'enough to follow it:';

/** The preload block for one named on-demand skill. */
export function renderPreloadBlock(name: string, text: string): string {
  return `Skill "${name}" was named in this turn, so its full instructions are loaded here ` +
    `(no need to call naby_skill_load for it):\n\n${text}`;
}

/**
 * Render the selected skills as a system-prompt block. Returns `undefined` when
 * there is nothing to inject, so the caller can leave the turn's system field
 * BYTE-FOR-BYTE unchanged (the no-op invariant).
 */
export function renderInjectedSkills(injected: InjectedSkills): string | undefined {
  const parts: string[] = [];
  if (injected.skills.length > 0) {
    // The established block, byte-for-byte.
    parts.push(
      [
        'Skills available for this turn (apply where they fit; do not mention this block):',
        ...injected.skills.map(renderSkillBlock),
      ].join('\n\n'),
    );
  }
  const od = injected.onDemand;
  if (od && od.listed.length > 0) {
    parts.push([ON_DEMAND_LISTING_HEADER, ...od.listed.map(renderOnDemandLine)].join('\n'));
  }
  for (const p of od?.preloaded ?? []) parts.push(renderPreloadBlock(p.item.name, p.text));
  if (parts.length === 0) return undefined;
  return parts.join('\n\n');
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
