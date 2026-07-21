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

  /** Remove the session and everything keyed to it (messages + memory). */
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

  /** Delete the project AND CASCADE: every session whose `cwd` = this, and each
   * of those sessions' messages + memory + usage. Never leaves orphaned session
   * state; sessions are NOT reparented. */
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
