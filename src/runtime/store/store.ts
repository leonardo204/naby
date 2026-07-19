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
// The interface
// ---------------------------------------------------------------------------

export interface Store {
  // -- sessions ------------------------------------------------------------

  /** Mint a new session. `providerId` records the provider expected to answer
   * first; it is a hint and may change on any later turn. */
  createSession(providerId: string, title?: string): SessionRef;

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

  // -- MCP registry (provider-independent; contract §5) --------------------

  listMcpEntries(): McpEntry[];
  /** Insert or replace by `name`. */
  upsertMcpEntry(entry: McpEntry): void;
  removeMcpEntry(name: string): void;

  // -- lifecycle -----------------------------------------------------------

  /** Release the underlying handle. Safe to call twice. */
  close(): void;
}
