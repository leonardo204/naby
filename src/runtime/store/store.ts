// src/runtime/store/store.ts
//
// THE PERSISTENCE SEAM (contract §6: "we own persistence").
//
// The runtime depends on this interface and NOTHING below it. Two drivers
// implement it today — SqliteStore (durable, `node:sqlite`) and MemoryStore
// (ephemeral, for tests and spikes) — and the driver is chosen at the app's
// composition root, never named by the runtime.
//
// The interface is deliberately NARROW. It is the whole of what the runtime is
// allowed to ask of storage, which is what keeps the driver swappable: if
// `node:sqlite` turns out to be unavailable inside Electron (see the note in
// sqlite-store.ts — F1-02 / SPIKE-04 must verify this), swapping in another
// driver is a new file here, not a change to the runtime.
//
// THE KEYING INVARIANT (contract §6, proven by SPIKE-07 and spike:f105):
// sessions, messages and memory are keyed by SESSION ID ONLY. Nothing in this
// interface — and nothing in any implementation's schema — may be keyed by
// provider or engine. The single exception is `SessionRef.providerId`, which is
// explicitly "the LAST provider used — a hint, not a constraint": it records
// what answered last, and switching it mid-session changes nothing else.

import type { RuntimeMessage } from '../engine.js';

// ---------------------------------------------------------------------------
// Session index (contract §6)
// ---------------------------------------------------------------------------

export type SessionRef = {
  /** UUID we mint. The ONLY key for messages and memory. */
  sessionId: string;
  /** last provider used — a hint, not a constraint; switchable any turn. */
  providerId: string;
  title?: string;
  /** epoch ms */
  createdAt: number;
  /** epoch ms */
  lastUsedAt: number;
  /**
   * Owning project (its `cwd`), when the session belongs to one. This is a
   * LINK, not a key: it is consistent with the keying invariant above — nothing
   * looks a message/memory/usage row up by `cwd`, they stay keyed by
   * `sessionId` only. A projectless session (`cwd` absent) is fully valid.
   */
  cwd?: string;
  /** Whether the session is pinned in the browsing list. */
  pinned?: boolean;
  /**
   * WHEN it was pinned (epoch ms), or absent when it is not pinned — and also
   * absent for a session pinned before schema v7, which never recorded it.
   *
   * This is what orders pinned tabs: earliest pin sits leftmost. Recency cannot
   * stand in for it, which is why the field exists — sorting pinned tabs by
   * last use made them swap places the moment the user typed in one of them.
   */
  pinnedAt?: number;
  /** Coarse lifecycle state, e.g. 'active' | 'ended'; absent = unknown. */
  status?: string;
};

// ---------------------------------------------------------------------------
// Projects (Naby-owned; keyed by cwd) — contract §6.1
// ---------------------------------------------------------------------------

/**
 * A project is a working directory the user opens. Projects are keyed by `cwd`
 * (the directory is the project's identity), which is a DIFFERENT key space
 * from sessions/messages/memory/usage (keyed by `sessionId`). The session↔
 * project relationship is a LINK on the session (`SessionRef.cwd`), never a key
 * for session state — the keying invariant at the top of this file is intact.
 */
export type Project = {
  /** The working directory: the project's identity and primary key. */
  cwd: string;
  /** Display name; defaults (at the call site) to the cwd basename. */
  title?: string;
  /** epoch ms */
  createdAt: number;
  /** epoch ms — drives MRU ordering of the project list. */
  lastOpenedAt: number;
  pinned: boolean;
};

// ---------------------------------------------------------------------------
// MCP registry (contract §5, stored per §6)
// ---------------------------------------------------------------------------

/**
 * Whether an MCP entry is active (`enabled`) or a not-yet-trusted PROPOSAL
 * (`proposed`). Absent = `enabled` — every entry a user added by hand through
 * Settings is trusted and active, and old rows without the field stay active.
 * A proposal is one the CHAT AGENT added on the user's behalf (`naby_add_mcp`):
 * it is STORED and shown in Settings but NEVER loaded into the toolset until the
 * user explicitly approves it, mirroring the trust rule that external-origin
 * harness/memory lands disabled (trust.ts / harness-gate.ts).
 */
export type McpStatus = 'enabled' | 'proposed';

export type McpEntry =
  | {
      name: string;
      transport: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
      status?: McpStatus;
    }
  | {
      name: string;
      transport: 'http' | 'sse';
      url: string;
      headers?: Record<string, string>;
      timeoutMs?: number;
      status?: McpStatus;
    };

/** True when an MCP entry should be loaded into the live toolset — everything
 *  except an agent PROPOSAL awaiting user approval. */
export function isMcpEntryActive(entry: McpEntry): boolean {
  return entry.status !== 'proposed';
}

// ---------------------------------------------------------------------------
// Per-turn usage (F1-07)
// ---------------------------------------------------------------------------

/**
 * What one answered turn consumed. Written once per `result` event.
 *
 * WHY PER-TURN AND NOT A RUNNING TOTAL: a session's provider and model can
 * change on any turn (contract §6 — `providerId` is a hint, and switching it
 * mid-session is explicitly supported). A single accumulated counter could
 * therefore only ever be priced against ONE model, which would be wrong for
 * exactly the sessions the provider-independence property exists to enable. Per
 * turn, each row is priced against the model that actually ran, and the total
 * is a sum of correct parts.
 *
 * IT IS STILL KEYED BY SESSION ID ONLY. `providerId`/`model`/`engine` are
 * recorded as PROPERTIES OF THE TURN, not as keys — nothing looks a session up
 * by them, and the keying invariant at the top of this file is intact.
 */
export type UsageRecord = {
  /** epoch ms */
  at: number;
  /** which backend answered: 'ai-sdk' | 'dev-claude'. Recorded, never keyed on. */
  engine: string;
  /** provider that answered this turn. */
  providerId: string;
  /** model id that answered this turn — what the price lookup is keyed to. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /**
   * Whether these tokens are BILLED to the user (see engines/select.ts).
   * 'subscription' turns ran on a local Claude sign-in and cost nothing per
   * message; presenting them as dollars would be inventing a charge.
   */
  costBasis: 'metered' | 'subscription';
  /**
   * A cost the ENGINE itself reported, when it reports one (the Agent SDK
   * does). Kept distinct from our own priced figure because it means something
   * different on a subscription: it is what the tokens WOULD have cost on the
   * metered API, not what was charged.
   */
  reportedCostUsd?: number;
};

// ---------------------------------------------------------------------------
// Scoped memory (Phase 1.5) — phase-1_5-memory-contracts §2–§6
// ---------------------------------------------------------------------------
//
// Phase 1 stored memory as `memory(session_id, key, value)` — session-scoped,
// keyed by sessionId only. Phase 1.5 KEEPS that behaviour working (the legacy
// setMemory/getMemory/getAllMemory below still read/write session-scoped rows)
// and ADDS user-, project-, and org-scoped memory with provenance so that a
// learned preference can outlive the session it was learned in.
//
// THE LOAD-BEARING NEW RULE (contract §2/§6): deleting a session deletes only
// scope='session' memory for that id; deleting a project cascades scope='project'
// memory (for that cwd) plus its sessions' scope='session' memory — but NEVER
// user/org memory. user/org memory survives session AND project deletes; it is
// removed only by an explicit deleteMemory. This is the cascade EXEMPTION.

/** The four memory scopes (contract §2). `scopeKey` is sessionId | cwd | userId
 * | orgId respectively. */
export type MemoryScope = 'session' | 'project' | 'user' | 'org';

/** Memory taxonomy (contract §3). Drives per-type retention/injection priority
 * (the priority itself is a §7-open tunable, not a contract). */
export type MemoryType = 'working' | 'episodic' | 'semantic' | 'procedural';

/** Trust tier of a memory's ORIGIN (contract §3/§4). Fixed ordering
 * user > artifact > external; it is what the write gate keys on. */
export type TrustTier = 'user' | 'artifact' | 'external';

/** proposed = auto-extracted below threshold OR external-origin awaiting
 * confirm; confirmed = user-verified or above threshold from a trusted tier.
 * Only `confirmed` memory is injected by default (contract §5). */
export type MemoryStatus = 'proposed' | 'confirmed';

/** Where a memory came from — the rollback/provenance handle (contract §3). */
export type MemoryProvenance = {
  /** WHICH trust tier this came from — drives the write gate (§4). */
  source: TrustTier;
  /** The session it was learned in — for delete-by-source rollback. */
  sessionId?: string;
  /** Short human-readable "why this was written" (e.g. an edit-diff id). */
  basis?: string;
  /** eval_event id or message id it was extracted from, if any. */
  createdFrom?: string;
};

/** One scoped memory row (contract §3). `(scope, scopeKey, key)` is the upsert
 * identity; `id` is the provenance/rollback handle. */
export type MemoryItem = {
  /** UUID — the row's own key and the delete-by-id / provenance handle. */
  id: string;
  scope: MemoryScope;
  /** sessionId | cwd | userId | orgId, per scope (§2). */
  scopeKey: string;
  type: MemoryType;
  /** Stable slug within (scope, scopeKey) — the upsert target. */
  key: string;
  value: string;
  provenance: MemoryProvenance;
  /** 0–1 auto-extraction confidence (1 for user-confirmed). */
  confidence: number;
  status: MemoryStatus;
  /** epoch ms */
  createdAt: number;
  /** epoch ms — enables latest-wins / supersede policy (§7-open). */
  updatedAt: number;
};

/** A write request to the gate (contract §4). Everything a MemoryItem carries
 * except the store-assigned id/createdAt/updatedAt and the gate-decided status;
 * `requestedStatus` is what the caller ASKED for and the gate may downgrade. */
export type MemoryWriteRequest = Omit<
  MemoryItem,
  'id' | 'createdAt' | 'updatedAt' | 'status'
> & {
  requestedStatus: MemoryStatus;
};

/** The deterministic write-gate decision (contract §4). */
export type MemoryWriteDecision =
  | { behavior: 'allow'; status: MemoryStatus } // may downgrade requestedStatus
  | { behavior: 'hold'; status: 'proposed'; reason: string } // must be user-confirmed
  | { behavior: 'deny'; reason: string };

/** The turn-time retrieval query (contract §5). */
export type MemoryInjectionQuery = {
  sessionId: string;
  /** project scope, if the session is projected. */
  cwd?: string;
  /** hint from the turn (aligns with eval_events.task_type). */
  taskType?: string;
  /**
   * The turn's own user text, for relevance ranking (P3-M8c, contract §5,
   * additive in 0.4.0). Absent — or matching no candidate — leaves the ranking
   * exactly as it was: scope → type → recency. A turn with no relevance signal
   * is never made worse than it was before ranking existed.
   */
  queryText?: string;
  /** HARD cap on injected memory tokens for this turn. */
  tokenBudget: number;
};

/** The selected, ranked, within-budget memory for one turn (contract §5). */
export type InjectedMemory = {
  /** selected, ranked, within budget. */
  items: MemoryItem[];
  /** ≤ tokenBudget, always. */
  tokensUsed: number;
  /** count omitted PURELY due to the cap (logged, never silent). */
  droppedForBudget: number;
};

/** Exactly-one-selector for deleteMemory (contract §6). */
export type MemoryDeleteSelector =
  | { id: string }
  | { source: TrustTier; sessionId?: string };

/**
 * ONE SESSION AGREEING WITH A MEMORY'S CURRENT VALUE (Phase 3 P3-M8b,
 * phase-3-continuous-learning §5.3; memory-contracts §8 amendment).
 *
 * WHY IT EXISTS. `updatedAt` could already say when a fact was last written, but
 * not by how many DIFFERENT conversations — and those are not the same evidence
 * at all. Saying the same thing twice in one sitting is one belief stated twice;
 * saying it again three weeks later, in another session, after having forgotten
 * you said it, is the thing worth trusting. An observation row is the record of
 * the second kind.
 *
 * TWO RULES MAKE THE COUNT MEAN SOMETHING, both enforced by `putMemory`:
 *
 *   - it is written AUTOMATICALLY whenever a write with a `provenance.sessionId`
 *     lands, so the reflection pass and `naby_remember` fill the same pool and
 *     neither can forget to;
 *   - the rows are CLEARED when the value materially changes. A new claim needs
 *     new evidence, so the count is always "distinct sessions that agree with what
 *     this row says NOW" — which is why no separate "and no session contradicted
 *     it" condition is needed.
 *
 * Evidence, not progress state — but it is deleted with the conversation that
 * produced it (§5.3): a citation into a transcript nobody can open any more is
 * not evidence of anything. An already-`confirmed` item never reverts when its
 * observations go.
 */
/**
 * Whether two memory values are the SAME CLAIM — the test that decides whether a
 * write keeps an item's corroboration or wipes it (§5.3).
 *
 * Whitespace-insensitive, case-SENSITIVE. Re-saving a fact with a trailing space
 * or a rewrapped line is the same person saying the same thing, and resetting the
 * evidence for it would make corroboration unreachable for anyone whose tooling
 * touches whitespace. Case, by contrast, can be the whole content of a
 * preference ("writes SQL keywords in caps"), so it counts as a change.
 *
 * Lives here, next to the type, because both drivers must answer it identically:
 * two copies of this rule is a database where the same edit clears the evidence
 * on one driver and not the other.
 */
export function sameMemoryValue(a: string, b: string): boolean {
  const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim();
  return normalize(a) === normalize(b);
}

export type MemoryObservation = {
  /** The `MemoryItem.id` this observation is about. */
  memoryId: string;
  /** The session that agreed with the current value. Half of the primary key:
   *  one session counts ONCE per memory, however often it repeats itself. */
  sessionId: string;
  /** epoch ms of the write that recorded it. */
  observedAt: number;
  /** The `provenance.createdFrom` of that write — the message coordinate, when
   *  the writer supplied one (reflection does: "<sessionId>:<seq>"). */
  createdFrom?: string;
};

// ---------------------------------------------------------------------------
// Golden set (Phase 1.5 P15-04) — phase-1_5-personalization-data-layer §3/§5/§6
// ---------------------------------------------------------------------------
//
// The golden set is a per-user HOLDOUT: N of the user's own real past artifacts
// (input → expected output) reserved as a FIXED evaluation yardstick and held
// OUT of learning. As memory accumulates (Phase 2b), the same inputs are
// regenerated and the distance to the held-out `expected` truth is scored,
// isolating personalization progress from task-difficulty drift (impl §5).
//
// THE LOAD-BEARING INVARIANT (impl §5 "held out from learning", DoD §6): a
// golden item is ALWAYS excluded-from-learning. The extraction/injection
// pipeline (memory-inject, Phase 2b extraction) reads `memory_items` ONLY and
// never this table, so golden artifacts are STRUCTURALLY disjoint from anything
// that can shape a turn. `excludedFromLearning` is typed as the literal `true`
// so the invariant is not even expressible as false — the store never accepts a
// caller-supplied value for it and always stamps it true.
//
// SCOPE: Phase 1.5 builds storage + consent + CRUD + addressability ONLY. The
// scoring logic and the re-measure dashboard are Phase 2b (F2-07); `lastScoredAt`
// is reserved here (NULL now) so re-scoring is addressable without a later
// migration.

/** A user's consent for holding an artifact in the golden set. Recorded per
 * item so consent is auditable and revocable at the artifact granularity
 * (revoking consent does not silently drop the row — it flips this state, and a
 * caller decides whether a revoked item is still scored). */
export type GoldenConsent = 'granted' | 'revoked' | 'pending';

/** One held-out evaluation artifact (impl §5). `(scopeKey)` groups a user's
 * holdout; `id` is the addressable handle for later re-scoring (Phase 2b F2-07). */
export type GoldenItem = {
  /** UUID — the row's own key and the addressable re-scoring handle. */
  id: string;
  /** The user (single-user machine: a constant) whose holdout this belongs to.
   * Same key space as scope='user' scoped memory (userId). */
  scopeKey: string;
  /** Task type of the artifact (aligns with eval_events.task_type / P15-03) so
   * scoring can be aggregated per task type. */
  taskType: string;
  /** The original input/prompt the artifact answered. */
  input: string;
  /** The user's real past output — the HELD-OUT truth scored against later. */
  expected: string;
  /** ALWAYS true — the excluded-from-learning invariant (impl §5). The literal
   * type makes `false` inexpressible; the store never accepts it from a caller. */
  excludedFromLearning: true;
  /** Consent state for holding this artifact. */
  consent: GoldenConsent;
  /** epoch ms */
  createdAt: number;
  /** epoch ms of the last Phase-2b re-score, or null if never scored (always
   * null in Phase 1.5 — reserved so re-scoring needs no later migration). */
  lastScoredAt: number | null;
};

/** What a caller supplies to capture a holdout artifact. `excludedFromLearning`,
 * `id`, `createdAt`, and `lastScoredAt` are store-owned and NOT accepted here —
 * excludedFromLearning is always stamped true. `consent` defaults to 'pending'. */
export type GoldenItemInput = {
  scopeKey: string;
  taskType: string;
  input: string;
  expected: string;
  /** Consent at capture time; defaults to 'pending' when omitted. */
  consent?: GoldenConsent;
};

// ---------------------------------------------------------------------------
// Owned harness (Phase 1.6 HP-01) — phase-1_6-harness-contracts §2–§6
// ---------------------------------------------------------------------------
//
// Phase 1.6 makes commands, skills, subagents and named harness SETS into
// Naby-owned, scoped, provider-independent entities — the harness twin of Phase
// 1.5's scoped memory. It REUSES two things already built in Phase 1.5: the
// scoped-ownership + cascade-exemption model (§2 there) and the deterministic
// trust-gate (§4 there). See phase-1_6-harness-contracts.
//
// THE LOAD-BEARING RULES (contract §2/§4):
//   - Harness has NO session scope (a command/skill/subagent is a durable
//     capability, not per-conversation state). Scopes are user | project | org.
//   - CASCADE EXEMPTION: deleteSession NEVER touches harness; removeProject
//     removes only scope='project' harness for that cwd; user/org survive.
//   - (scope, scopeKey, kind, name) is the upsert identity; id is the
//     provenance/rollback handle.
//   - Imported (external) harness NEVER auto-enables — it lands 'disabled' and
//     becomes 'enabled' only through setHarnessEnabled (an explicit user act).

/** command verb | reusable skill | subagent persona (contract §3). */
export type HarnessKind = 'command' | 'skill' | 'subagent';

/** Harness scopes (contract §2). NO 'session' scope — durable capability, not
 * per-conversation state. `scopeKey` is userId | cwd | orgId respectively. */
export type HarnessScope = 'user' | 'project' | 'org';

/** Trust tier of a harness item's ORIGIN (contract §3/§4). Same fixed ordering
 * as memory (user > artifact > external); it is what the import gate keys on.
 * authored-by-user > local artifact > imported. */
export type HarnessTrust = 'user' | 'artifact' | 'external';

/** enabled participates in a turn (injection/expansion); disabled is visible in
 * the review UI but never injected. Imported items default 'disabled' (§4). */
export type HarnessStatus = 'enabled' | 'disabled';

/** Where a harness item came from — the rollback/provenance handle (contract
 * §3). `source` drives the import gate (§4); `origin`/`format` let export
 * round-trip. */
export type HarnessProvenance = {
  /** WHICH trust tier this came from — drives the import gate (§4). */
  source: HarnessTrust;
  /** e.g. '~/.claude/skills/foo/SKILL.md', 'set:team-onboarding@1.2'. */
  origin?: string;
  /** Interchange format the row came from, for round-trip export. */
  format?: 'claude-skill-md' | 'claude-agent-md' | 'claude-command-md' | 'naby';
  /** epoch ms the item was imported, if it was. */
  importedAt?: number;
};

/** One owned harness row (contract §3). `(scope, scopeKey, kind, name)` is the
 * upsert identity; `id` is the provenance/rollback handle. Exactly one of
 * command/skill/subagent is populated, matching `kind`. */
export type HarnessItem = {
  /** UUID — the row's own key and the delete-by-id / provenance handle. */
  id: string;
  scope: HarnessScope;
  /** userId | cwd | orgId, per scope (§2). */
  scopeKey: string;
  kind: HarnessKind;
  /** command verb (no leading slash) | skill/subagent name; unique within
   * (scope, scopeKey, kind). */
  name: string;
  description?: string;
  /** enabled | disabled (imported => disabled until reviewed). */
  status: HarnessStatus;
  provenance: HarnessProvenance;
  /** epoch ms */
  createdAt: number;
  /** epoch ms */
  updatedAt: number;

  // --- kind-specific payload (exactly one is populated, matching `kind`) ---
  /** kind='command': the prompt body the verb expands to (provider-independent). */
  command?: {
    template: string;
    argumentHint?: string;
  };
  /** kind='skill': SKILL.md body injected on trigger; toolRefs stored now,
   * executed in Phase 2.5. */
  skill?: {
    instructions: string;
    triggers?: string[];
    toolRefs?: string[];
  };
  /** kind='subagent': system prompt + optional model; toolRefs stored now,
   * orchestrated in Phase 2.5. */
  subagent?: {
    systemPrompt: string;
    model?: string;
    toolRefs?: string[];
  };
};

/** An import request to the gate (contract §4). Everything a HarnessItem carries
 * except the store-assigned id/createdAt/updatedAt and the gate-decided status;
 * `requestedStatus` is what the caller ASKED for and the gate may downgrade
 * (external can never be granted 'enabled'). */
export type HarnessImportRequest = {
  item: Omit<HarnessItem, 'id' | 'createdAt' | 'updatedAt' | 'status'>;
  requestedStatus?: HarnessStatus;
  /**
   * CONTENT REFRESH of an item the user has already reviewed — set ONLY by the
   * re-scan of a local `.claude` tree, never by an agent-driven write.
   *
   * A refresh re-reads the SAME file at the SAME origin and re-states its body.
   * Without this flag such a write goes through the gate as a brand-new external
   * import, which pins 'disabled' (invariant 3) and therefore ERASES the user's
   * explicit enable — the v1.8.1 bug where enabling an imported skill was undone
   * by the very next Settings list. With it, the gate carries the EXISTING row's
   * status through (harness-gate.ts invariant 5): a refresh may change content,
   * never trust.
   *
   * It cannot be used to smuggle an item to 'enabled': the status it preserves is
   * the stored one, which only setHarnessEnabled can ever have set, and a NEW row
   * (nothing to preserve) is unaffected.
   */
  refresh?: boolean;
};

/** The deterministic import-gate decision (contract §4). An 'allow' may downgrade
 * to 'disabled'; a 'hold' persists disabled and needs review; a 'deny' throws. */
export type HarnessImportDecision =
  | { behavior: 'allow'; status: HarnessStatus }
  | { behavior: 'hold'; status: 'disabled'; reason: string }
  | { behavior: 'deny'; reason: string };

/** A named, versioned bundle for team sharing (contract §5). Export produces
 * one; import merges it through the gate (§4) — everything lands disabled. */
export type HarnessSet = {
  /** e.g. 'team-onboarding'. */
  name: string;
  /** semver; import records origin 'set:<name>@<version>'. */
  version: string;
  description?: string;
  /** commands/skills/subagents with payloads inline. */
  items: HarnessItem[];
  manifest: {
    createdAt: number;
    /** display only; NOT a trust claim. */
    createdBy?: string;
    counts: { command: number; skill: number; subagent: number };
    /** optional org signing (open question — contract §7). */
    signature?: string;
  };
};

/** Exactly-one-selector for removeHarness (contract §6). */
export type HarnessRemoveSelector = { id: string } | { origin: string };

// ---------------------------------------------------------------------------
// Tool-execution policy (Phase 2, M1) — persistent per-scope rules the gate
// consults BEFORE running a tool. A rule maps a tool pattern to an effect; the
// runtime's `realPolicy` (policy.ts) resolves them, most-specific scope first
// (project > user > org), and falls back to the turn's baseline when no rule
// matches. Scopes reuse HarnessScope so rules key exactly like owned harness.
// ---------------------------------------------------------------------------

/** allow / deny outright, or 'ask' (defer to a human — the Phase 2 M2 approval
 *  bridge; with no bridge present a rule of 'ask' is treated as the baseline). */
export type PolicyEffect = 'allow' | 'deny' | 'ask';

/** A stored policy rule. `toolPattern` matches the BARE tool name the gate sees
 *  (after any `mcp__…__` namespacing is stripped): an exact name, or a trailing
 *  `*` wildcard (e.g. `mcp__jira__*`), or `*` for all tools. */
export type PolicyRule = {
  id: string;
  scope: HarnessScope;
  scopeKey: string;
  toolPattern: string;
  effect: PolicyEffect;
  createdAt: number;
  updatedAt: number;
};

/** Upsert input: identity is (scope, scopeKey, toolPattern); id/timestamps are
 *  store-assigned. */
export type PolicyRuleInput = Omit<PolicyRule, 'id' | 'createdAt' | 'updatedAt'>;

// ---------------------------------------------------------------------------
// naby agents (Phase 3, P3-M1) — the naby-OWNED agent layer, addressed by `@`.
//
// This is a NEW key space, deliberately separate from owned harness above. An
// `Agent` is a naby-owned actor (the built-in PERSONA that learns the user, plus
// any custom agents the user adds) — NOT a harness subagent (which is a
// user-authored capability under the `/` harness). The two are kept distinct in
// the data model on purpose: "an agent ≠ a harness item" is the Phase 3 pivot.
//
// Agents are GLOBAL (naby-owned, single-user machine) — they carry no
// scope/scopeKey. `memoryScope` records which memory scope an agent reads and
// writes as its learned memory; that is a LINK into scoped memory, not a key for
// the agent row (the keying invariant at the top of this file is intact — agent
// rows are keyed by their own id, and `name` is a unique addressing handle).
//
// THE BUILT-IN PERSONA (spec §4): exactly one row of kind='persona' is seeded on
// first run (seedBuiltinPersona, agents.ts). It is UNDELETABLE (removeAgent
// no-ops a persona row) and, since 2026-07-30, NOT EDITABLE EITHER: putAgent
// refuses to write a persona row at all, and the seed is the only thing that
// may — through `restoreBuiltinPersona`, the one narrow door. Users only ever
// create kind='custom' agents, so kind='persona' uniquely identifies the
// built-in.
//
// WHY THE REVERSAL. "Editable but undeletable" was the M1 decision, and it made
// the persona a thing the user could quietly break: its system prompt IS the
// persona contract that P3-M2..M8 build on (memory injection, escalation, the
// autonomy budget, everything the trust meter scores). A half-edited prompt
// produced an agent that behaved unlike the one being measured, with no way back
// short of deleting a row the product refuses to delete. Making it built-in and
// read-only means the contract is the product's to keep — and the seed HEALS a
// row an older build let the user edit (agents.ts `seedBuiltinPersona`).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The eval-event ledger (Phase 3, P3-M5) — specs/phase-3-checkin-contracts.md
// ---------------------------------------------------------------------------
//
// The stream P15-03 reserved (task_type, domain, and an observation of what the
// user actually wanted), given a writer at last. ONE discriminated stream rather
// than a table per observation kind: `MemoryProvenance.createdFrom` already
// documents itself as "eval_event id", and a second table for the same purpose
// would make that pointer ambiguous. A later F2-04 draft/final/edit-diff event
// adds a `kind`, not a table.
//
// Rows are keyed by `agentId` (growth is per agent) with `sessionId` as a LINK —
// deleting a conversation must not erase what the agent proved, exactly as
// user-scoped memory survives a session delete (§6 keying invariant).

/** What kind of observation a row is. */
export type EvalEventKind = 'checkin' | 'autonomous' | 'tripwire';

/** One observation. The kind-specific fields are all optional at this level; the
 *  invariants that tie them to a `kind` live in the contract doc §4 and are
 *  enforced by the writer, not the type. */
export type EvalEvent = {
  /** UUID — what `MemoryProvenance.createdFrom` points at. */
  id: string;
  kind: EvalEventKind;
  /** epoch ms — ordering, window cuts, drift detection. */
  at: number;
  agentId: string;
  sessionId: string;
  /** P15-03's task_type — the per-scope trust axis and what a regression names. */
  taskType?: string;
  /** P15-03's domain tag. Reserved; unused in M5 so no later migration is needed. */
  domain?: string;

  // -- kind: 'checkin' — the agent asked before an irreversible step --------
  /** What was asked, verbatim. Stored for two reasons: the growth panel shows the
   *  user the decisions their agent actually put to them, and the degenerate-check
   *  (`degenerateReason`) compares a new question against these to catch the same
   *  thing being asked twice for two free hits. Lives in the payload JSON, so it
   *  needed no schema migration. */
  question?: string;
  /** Options offered, in the order shown. */
  options?: string[];
  /** Index of the option the agent RECOMMENDED — its prediction. */
  recommended?: number;
  /** Index the user chose, or -1 when they answered freely. */
  chosen?: number;
  /** True iff the user took the recommendation unchanged. STORED, not derived:
   *  recomputing it later would let a reordered options list rewrite history. */
  hit?: boolean;
  /** The agent's own stated confidence, 0–1. Recorded but NOT trusted — the
   *  calibration axis measures whether it means anything. */
  confidence?: number;
  /** Free-text correction when `chosen` is -1 — the edit-diff analogue. */
  correction?: string;

  // -- kind: 'autonomous' — it acted without asking -------------------------
  /** Whether the action could be undone. */
  reversible?: boolean;
  /** Set when the user later fixed the result: the miss signal for the covered
   *  region, without which coverage would inflate for free. */
  correctedAfter?: boolean;
  /** Epoch ms the reflection pass put this action before its judge (P3-M8d,
   *  checkin-contracts 0.5.0). Present WITHOUT `correctedAfter` is the weak
   *  implicit accept the meter blends in at `IMPLICIT_WEIGHT`: the user had a
   *  chance to react to it and did not. Absent means never reviewed — "unseen"
   *  and "seen and let stand" must not be counted as the same thing, which is
   *  exactly what this field exists to separate. Lives in the payload JSON, so
   *  it needed no schema migration. */
  reviewedAt?: number;

  // -- kind: 'tripwire' — the gate refused a safety-relevant call ------------
  toolName?: string;
  reason?: string;

  /** Excluded from scoring as degenerate (near-duplicate question, one real
   *  option). Kept and counted so the exclusion is visible, never silent. */
  excludedFromScoring?: boolean;
  /** This row came in with an IMPORTED agent (P3-M7) rather than being observed
   *  on this machine. Kept for the record; every growth axis ignores it unless
   *  the user declared the file to be their own export. Lives in the payload
   *  JSON, so it needed no schema migration. */
  imported?: boolean;
};

/** What a caller supplies. `id` and `at` are store-owned when omitted. */
export type EvalEventInput = Omit<EvalEvent, 'id' | 'at'> & {
  id?: string;
  at?: number;
};

/** Exactly-one-selector for deleteEvalEvents. Growth history is the user's own
 *  behavioural record, so it has to be erasable — the same principle as memory's
 *  delete-by-source. */
export type EvalEventDeleteSelector = { agentId: string } | { sessionId: string };

/**
 * Where the session-reflection pass (Phase 3 P3-M8a) stopped reading a session's
 * transcript: the highest message `seq` it has already looked at, and when it did.
 *
 * PROGRESS STATE, NOT USER RECORD — which is why it is the one thing that IS
 * deleted with a session, unlike the ledger (invariant 4: growth survives a deleted
 * conversation). A cursor into a transcript that no longer exists means nothing.
 */
export type ReflectionCursor = {
  /** Highest message seq already reflected on. A session never reflected on has
   *  no row at all; callers read that as -1 (seqs start at 0). */
  lastSeq: number;
  /** epoch ms of that reflection. */
  reflectedAt: number;
};

/** built-in persona (learns the user, seeded once) | user-added custom agent. */
export type AgentKind = 'persona' | 'custom';

/** Where a critical decision is escalated to a human when the agent runs
 *  autonomously (Phase 3 P3-M3 wires the telegram channel; inline reuses the M2
 *  approval bridge). */
export type AgentEscalation = 'inline' | 'telegram' | 'both';

/** How far an agent may act on its own before it must stop and report, and how
 *  it escalates a decision it judges critical (spec §4). */
export type AgentAutonomy = {
  /** Hard cap on autonomous steps before the agent must stop/report. Undefined
   *  = no explicit cap (the turn's own limits still apply). */
  maxSteps?: number;
  /** Channel a critical decision is escalated on. */
  escalation: AgentEscalation;
};

/** One naby-owned agent (spec §4). Keyed by `id`; `name` is a UNIQUE addressing
 *  handle (the `@name` that routes a turn — P3-M2). */
export type Agent = {
  /** UUID — the row's own key and the delete/update handle. */
  id: string;
  /** Unique addressing name — the `@name` used to route a turn to this agent. */
  name: string;
  kind: AgentKind;
  description?: string;
  /** The agent's standing instruction / persona. Learned context is INJECTED at
   *  turn time (scoped memory), never stored inline here. */
  systemPrompt: string;
  /** Preferred model; undefined = inherit the turn's engine default. */
  model?: string;
  /** Allowed tool names; undefined = inherit the turn's toolset. */
  toolRefs?: string[];
  /** Which memory scope this agent reads and writes as its learned memory. */
  memoryScope: MemoryScope;
  autonomy: AgentAutonomy;
  /** epoch ms */
  createdAt: number;
  /** epoch ms */
  updatedAt: number;
};

/** Upsert input. `id` is OPTIONAL: omit to mint a new agent, or supply an
 *  existing id to update that row. createdAt/updatedAt are store-owned. Name
 *  uniqueness is enforced by the store (a different row with the same name is
 *  rejected). */
export type AgentInput = Omit<Agent, 'id' | 'createdAt' | 'updatedAt'> & {
  id?: string;
};

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

export interface Store {
  // -- sessions ------------------------------------------------------------

  /** Mint a new session. `providerId` records the provider expected to answer
   * first; it is a hint and may change on any later turn. `cwd`, when supplied,
   * links the new session to an owning project — a LINK, not a key (§6 keying
   * invariant); it is optional so existing callers are unaffected. */
  createSession(providerId: string, title?: string, cwd?: string): SessionRef;

  getSession(sessionId: string): SessionRef | undefined;

  /** Most-recently-used first. */
  listSessions(): SessionRef[];

  /** Mark the session used now, optionally recording the provider that just
   * answered. Creates the session if it does not exist, so a caller may drive a
   * session by a well-known id without minting one first. */
  touchSession(sessionId: string, providerId?: string): SessionRef;

  /** Remove the session and everything keyed to it (messages + usage +
   * scope='session' memory). Phase 1.5 CASCADE EXEMPTION: user/project/org
   * memory is NOT touched — a session delete removes only that session's
   * session-scoped memory (phase-1_5-memory-contracts §2/§6).
   *
   * P3-M8b: its MEMORY OBSERVATIONS go too. A surviving user-scope row keeps its
   * value and its status; it simply loses the vote of a conversation that no
   * longer exists to be checked against (§5.3). An already-confirmed row does not
   * revert. */
  deleteSession(sessionId: string): void;

  // -- messages ------------------------------------------------------------

  /** Append one message to the session's transcript. Append order is the replay
   * order and is preserved exactly (implementations keep an explicit seq). */
  appendMessage(sessionId: string, msg: RuntimeMessage): void;

  /** The session's full transcript, in append order. */
  getMessages(sessionId: string): RuntimeMessage[];

  // -- memory --------------------------------------------------------------

  setMemory(sessionId: string, key: string, value: string): void;
  getMemory(sessionId: string, key: string): string | undefined;
  getAllMemory(sessionId: string): Record<string, string>;

  // -- scoped memory (Phase 1.5) -------------------------------------------
  //
  // These extend the session-scoped legacy ops above with user/project/org
  // scope, provenance, type, confidence and status. The legacy three keep
  // working as the scope='session' view (they read/write the same rows). See
  // phase-1_5-memory-contracts §6.
  //
  // NOTE ON NAMING: the contract §6 names the scoped reader `getMemory(scope,
  // scopeKey)`. That exact name is already taken by the legacy
  // `getMemory(sessionId, key): string | undefined` above, and the two
  // signatures are ambiguous (both `(string, string)`) with incompatible return
  // types — a TS overload would silently pick the wrong one. To PRESERVE the
  // legacy read path (contract requirement, spikes depend on it) the scoped
  // reader is named `getScopedMemory`; it is the contract's §6 getMemory.

  /** Upsert by (scope, scopeKey, key). Passes through the write gate (§4): a
   * 'deny' THROWS, a 'hold' persists with status:'proposed', an 'allow' persists
   * with the gate-decided status. Returns the resulting row. */
  putMemory(req: MemoryWriteRequest): MemoryItem;

  /** Read memory for injection/review. `status` filters proposed vs confirmed;
   * omit for all. Ordering here is relevance-agnostic (createdAt asc) — ranking
   * happens in the injection step (§5), not the store. (Contract §6 getMemory.) */
  getScopedMemory(
    scope: MemoryScope,
    scopeKey: string,
    opts?: { status?: MemoryStatus },
  ): MemoryItem[];

  /** Confirm a proposed item — the ONLY path external-origin memory becomes
   * confirmed (§4 invariant 1). No-op if already confirmed or absent. */
  confirmMemory(id: string): void;

  /** Delete one item by id, or every item matching a provenance source
   * (poisoning rollback / delete-by-source). Exactly one selector. Takes the
   * items' observation rows with it (P3-M8b): evidence for a row that no longer
   * exists is unreachable by definition. */
  deleteMemory(sel: MemoryDeleteSelector): void;

  // -- cross-session corroboration (Phase 3 P3-M8b) ------------------------
  //
  // How many DISTINCT sessions agree with each item's CURRENT value
  // (phase-3-continuous-learning §5.3). The rows themselves are written by
  // `putMemory` — there is deliberately no public "record an observation" method,
  // because a caller that could forget to call it would produce a corroboration
  // count that silently under-reports.

  /** Distinct-session counts for the given item ids, keyed by id. Ids with no
   * observations are ABSENT from the result rather than present with 0, so a
   * caller reads `counts[id] ?? 0` and cannot mistake "never observed" for a real
   * zero. An empty input returns an empty record without touching the database. */
  getMemoryCorroboration(memoryIds: readonly string[]): Record<string, number>;

  /** Every `proposed` item corroborated by at least `threshold` distinct
   * sessions, across ALL scopes — the consolidation step's read (§5.4). Most
   * corroborated first.
   *
   * IT DOES NOT DECIDE ANYTHING. Whether such a row may be promoted is policy
   * (`shouldAutoConfirmMemory`: artifact-tier only, never `external`, and only
   * when the user opted in) and lives in the runtime where it can be read,
   * not inside a store method where it would be invisible. */
  listCorroboratedProposed(threshold: number): MemoryItem[];

  // -- golden set (Phase 1.5 P15-04) ---------------------------------------
  //
  // A per-user HOLDOUT of real artifacts, held OUT of learning and reserved as
  // a fixed evaluation set (impl §5). These are STRUCTURALLY separate from the
  // scoped-memory ops above — they live in their own store (a distinct table /
  // map) that no injection or extraction path reads — which is what enforces the
  // excluded-from-learning invariant. Phase 1.5 is storage + consent + CRUD +
  // addressability; scoring is Phase 2b (F2-07).

  /** Capture a held-out artifact into the user's golden set. `excludedFromLearning`
   * is always stamped true (never accepted from the caller); `consent` defaults
   * to 'pending'; `lastScoredAt` is null. Returns the stored row (with its id —
   * the addressable re-scoring handle). */
  addGoldenItem(item: GoldenItemInput): GoldenItem;

  /** The user's holdout, oldest first. `consent` filters by consent state; omit
   * for all. */
  listGoldenSet(scopeKey: string, opts?: { consent?: GoldenConsent }): GoldenItem[];

  /** Fetch one held-out artifact by id — the addressability the re-scoring in
   * Phase 2b F2-07 selects on. Undefined if absent. */
  getGoldenItem(id: string): GoldenItem | undefined;

  /** Record/change consent for one held-out artifact. No-op if absent. */
  setGoldenConsent(id: string, consent: GoldenConsent): void;

  /** Remove one held-out artifact by id. */
  removeGoldenItem(id: string): void;

  // -- owned harness (Phase 1.6 HP-01) -------------------------------------
  //
  // Naby-owned commands/skills/subagents; scoped (user/project/org); cascade-
  // exempt for user/org exactly like scoped memory. The import gate
  // (decideHarnessImport, harness-gate.ts) mirrors decideMemoryWrite: external
  // origin NEVER auto-enables. See phase-1_6-harness-contracts §6.

  /** Insert/update by (scope, scopeKey, kind, name). Import requests pass the
   *  gate (§4): a 'deny' THROWS, a 'hold' persists as status:'disabled', an
   *  'allow' persists with the gate-decided status (external is always
   *  'disabled'). Returns the resulting row. */
  putHarnessItem(req: HarnessImportRequest): HarnessItem;

  /** Items for a scope, optionally filtered by kind and/or status. Ranking /
   *  trigger-matching for injection happens ABOVE the store (impl), not here;
   *  ordering is relevance-agnostic (createdAt asc). */
  listHarness(
    scope: HarnessScope,
    scopeKey: string,
    opts?: { kind?: HarnessKind; status?: HarnessStatus },
  ): HarnessItem[];

  getHarnessItem(id: string): HarnessItem | undefined;

  /** Enable/disable — the ONLY path an imported (external) item becomes enabled
   *  (§4 invariant 1). No-op if absent. */
  setHarnessEnabled(id: string, enabled: boolean): void;

  /** Delete one item by id, or every item from a provenance origin (rollback of
   *  a bad imported set). Exactly one selector. */
  removeHarness(sel: HarnessRemoveSelector): void;

  /** Serialize a scope's ENABLED items (optionally a subset by id) into a
   *  portable HarnessSet. */
  exportHarnessSet(
    scope: HarnessScope,
    scopeKey: string,
    opts?: { name: string; version: string; ids?: string[] },
  ): HarnessSet;

  /** Merge a HarnessSet through the gate; returns what landed (all disabled,
   *  provenance source:'external', origin:'set:<name>@<version>'). `ids` selects
   *  a subset; a conflict never overwrites an ENABLED local item — it lands as a
   *  separate disabled candidate (contract §5). */
  importHarnessSet(
    set: HarnessSet,
    into: { scope: HarnessScope; scopeKey: string },
    opts?: { ids?: string[] },
  ): HarnessItem[];

  // -- tool-execution policy (Phase 2, M1) ---------------------------------
  //
  // Persistent per-scope rules the gate consults before running a tool. Keyed
  // like harness (scope, scopeKey), addressable by id for removal. Ordering is
  // createdAt asc; scope precedence is applied ABOVE the store (policy.ts).

  /** Rules for one scope, oldest first. */
  listPolicyRules(scope: HarnessScope, scopeKey: string): PolicyRule[];

  /** Insert/update by (scope, scopeKey, toolPattern). Returns the stored row. */
  putPolicyRule(rule: PolicyRuleInput): PolicyRule;

  /** Delete one rule by id. No-op if absent. */
  removePolicyRule(id: string): void;

  // -- naby agents (Phase 3, P3-M1) ----------------------------------------
  //
  // The naby-owned agent layer (built-in persona + custom agents), addressed by
  // `@`. Global (no scope); keyed by id; `name` is a UNIQUE addressing handle.
  // See the type block above for the built-in-persona invariant.

  /** All agents. The built-in persona (kind='persona') sorts FIRST; the rest
   *  follow by createdAt asc. */
  listAgents(): Agent[];

  getAgent(id: string): Agent | undefined;

  /** Look an agent up by its unique `name` — the `@name` routing path (P3-M2).
   *  Undefined if no agent has that name. */
  getAgentByName(name: string): Agent | undefined;

  /** Insert (no `id`) or update (existing `id`) an agent. THROWS if `name`
   *  collides with a DIFFERENT agent (names are unique — they address turns).
   *
   *  ALSO THROWS on any attempt to write the built-in persona: an update whose
   *  target row is kind='persona', or an insert asking for kind='persona'. The
   *  persona is built-in and read-only, and this is where that is enforced —
   *  below every caller, so a shell route, an import plan or a future feature
   *  cannot reach around it. The seed uses `restoreBuiltinPersona` instead.
   *
   *  Returns the stored row. */
  putAgent(input: AgentInput): Agent;

  /** THE ONLY WRITE PATH TO THE BUILT-IN PERSONA, and it exists for exactly one
   *  caller: `seedBuiltinPersona` (agents.ts). It inserts the seed when the
   *  persona is absent and OVERWRITES the stored row back to the seed when it is
   *  present but has drifted — which is how a persona edited by an older build
   *  heals on the next boot. `id` and `createdAt` are preserved; everything else
   *  becomes the seed.
   *
   *  It is a separate method rather than a flag on `putAgent` so the exception is
   *  named, greppable and impossible to pass by accident. THROWS if `input.kind`
   *  is not 'persona', or if a DIFFERENT agent already holds `input.name`. */
  restoreBuiltinPersona(input: AgentInput): Agent;

  /** Delete one agent by id. NO-OP for the built-in persona (kind='persona' is
   *  undeletable, spec §4) and no-op if absent. */
  removeAgent(id: string): void;

  // -- eval-event ledger (Phase 3 P3-M5, realizing P15-03) -----------------

  /** Append one observation. `id`/`at` are store-owned when omitted. */
  appendEvalEvent(event: EvalEventInput): EvalEvent;

  /** An agent's observations, OLDEST FIRST so the caller can window and run
   *  change detection without re-sorting. `limit` takes the newest N.
   *  `sessionId` narrows to one conversation — what the reflection pass reads
   *  (P3-M8a); the rows stay keyed by agent, this is a filter on the LINK. */
  listEvalEvents(
    agentId: string,
    opts?: { kind?: EvalEventKind; taskType?: string; sessionId?: string; limit?: number },
  ): EvalEvent[];

  /**
   * Flip `correctedAfter` on one `autonomous` row — THE ONLY after-the-fact
   * mutation the ledger allows (checkin-contracts invariant 8). Written by the
   * session-reflection pass (P3-M8a), never by an agent turn.
   *
   * Returns false and writes NOTHING for a missing id or any other `kind`. The
   * narrowness is the point: every additional field that can be rewritten later is
   * another way to make a past score look better than it was, so the exception is
   * one field on one kind and the type of the return value is what makes a refused
   * write observable rather than silent.
   */
  markEvalEventCorrected(id: string): boolean;

  /**
   * Stamp `reviewedAt` on one `autonomous` row — the SECOND (and last) mutation
   * the ledger allows (checkin-contracts 0.5.0 invariant 8, P3-M8d). Written by
   * the session-reflection pass for every action it actually put before its
   * judge, corrected or not.
   *
   * Returns false and writes NOTHING for a missing id or any other `kind`, and
   * KEEPS THE FIRST timestamp when one is already recorded (returning true). The
   * first review is when the user's chance to object began; letting a later sweep
   * push that forward would slide an old action into a recent window, which is
   * the one way this field could be used to flatter the meter.
   */
  markEvalEventReviewed(id: string, reviewedAt: number): boolean;

  /** Erase growth history for an agent or a session. */
  deleteEvalEvents(selector: EvalEventDeleteSelector): void;

  // -- reflection cursor (Phase 3 P3-M8a) ----------------------------------
  //
  // How far the reflection pass has read each session's transcript. Deleted WITH
  // the session (see the type's note) — the only session-keyed state that is,
  // apart from messages/usage/session-scoped memory.

  /** Undefined when the session has never been reflected on. */
  getReflectionCursor(sessionId: string): ReflectionCursor | undefined;

  /** Record how far reflection got. Upsert by session id. */
  setReflectionCursor(sessionId: string, lastSeq: number, reflectedAt: number): void;

  /**
   * When the reflection pass last ran on ANY session, or undefined if it never
   * has (P3-M8c §6.3 — the learning-depth block's "last looked back" line).
   *
   * A MAX over the cursors rather than a new column: the cursors already record
   * every reflection, so a second record of the same fact could disagree with
   * them, and "the newest cursor" is exactly what the panel means.
   */
  getLatestReflectionAt(): number | undefined;

  // -- usage (F1-07) -------------------------------------------------------

  /** Record what one answered turn consumed. Called once per `result` event. */
  appendUsage(sessionId: string, record: UsageRecord): void;

  /** Every recorded turn for the session, oldest first. */
  listUsage(sessionId: string): UsageRecord[];

  // -- app settings (F1-08) ------------------------------------------------
  //
  // APP-WIDE, not session-keyed: "which provider answers" is a preference the
  // user sets once, not a property of one conversation. It lives here rather
  // than in `providers.json` (which main owns and which holds credential
  // handles) because it is provider-INDEPENDENT configuration, exactly like the
  // MCP registry above — and because the runtime must be able to read it
  // without importing electron.
  //
  // NOTE this does NOT weaken the keying invariant. The invariant is that
  // SESSION state (messages, memory, usage) is keyed by session id and nothing
  // else. These are not session state; there is no per-session settings scope,
  // and switching this value changes only which model answers next — which is
  // the provider-independence property, not a violation of it.

  getSetting(key: string): string | undefined;
  setSetting(key: string, value: string): void;
  listSettings(): Record<string, string>;

  // -- MCP registry (provider-independent; contract §5) --------------------

  listMcpEntries(): McpEntry[];
  /** Insert or replace by `name`. */
  upsertMcpEntry(entry: McpEntry): void;
  removeMcpEntry(name: string): void;

  // -- projects (Naby-owned; keyed by cwd; contract §6.1) ------------------

  /** All projects, MOST-RECENTLY-OPENED FIRST (ORDER BY last_opened_at DESC). */
  listProjects(): Project[];

  /** Insert or update by `cwd`. Creates the row if absent (sets createdAt AND
   * lastOpenedAt = now); otherwise applies `patch` and leaves lastOpenedAt
   * untouched unless the patch sets it. Idempotent. */
  upsertProject(
    cwd: string,
    patch?: Partial<Omit<Project, 'cwd' | 'createdAt'>>,
  ): Project;

  /** Mark the project opened now (bumps lastOpenedAt → front of the MRU list).
   * Creates it if absent, so opening a new directory needs no prior upsert. */
  touchProject(cwd: string): Project;

  /** Delete the project AND CASCADE: every session whose `cwd` = this, each of
   * those sessions' messages + usage + scope='session' memory, AND the
   * project's own scope='project' memory (scopeKey = cwd). Never leaves orphaned
   * session state; sessions are NOT reparented. Phase 1.5 CASCADE EXEMPTION:
   * user/org memory is NOT cascaded and MUST survive
   * (phase-1_5-memory-contracts §2/§6). */
  removeProject(cwd: string): void;

  // -- session ↔ project links (§6.1) -------------------------------------

  /** Sessions owned by this project, MOST-RECENTLY-USED FIRST. */
  listSessionsByProject(cwd: string): SessionRef[];

  /** Link an existing session to a project (or pass null to unlink). Touches
   * neither messages nor memory — only the owning-project link. */
  setSessionProject(sessionId: string, cwd: string | null): void;

  // -- pinned sessions (§6.1) ---------------------------------------------

  /** Pin/unpin a session in the browsing list. */
  /** Pin or unpin. Pinning stamps `pinnedAt` (idempotent — re-pinning an
   *  already-pinned session keeps its original stamp, so a client re-sending its
   *  whole pinned set cannot reshuffle the order); unpinning clears it. */
  setSessionPinned(sessionId: string, pinned: boolean, at?: number): void;

  /** Pinned sessions, MOST-RECENTLY-USED FIRST. */
  listPinnedSessions(): SessionRef[];

  // -- lifecycle -----------------------------------------------------------

  /** Release the underlying handle. Safe to call twice. */
  close(): void;
}
