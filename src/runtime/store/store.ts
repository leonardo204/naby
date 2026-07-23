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

export type McpEntry =
  | {
      name: string;
      transport: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      name: string;
      transport: 'http' | 'sse';
      url: string;
      headers?: Record<string, string>;
      timeoutMs?: number;
    };

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
   * session-scoped memory (phase-1_5-memory-contracts §2/§6). */
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
   * (poisoning rollback / delete-by-source). Exactly one selector. */
  deleteMemory(sel: MemoryDeleteSelector): void;

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
  setSessionPinned(sessionId: string, pinned: boolean): void;

  /** Pinned sessions, MOST-RECENTLY-USED FIRST. */
  listPinnedSessions(): SessionRef[];

  // -- lifecycle -----------------------------------------------------------

  /** Release the underlying handle. Safe to call twice. */
  close(): void;
}
