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
