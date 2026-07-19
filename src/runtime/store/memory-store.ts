// src/runtime/store/memory-store.ts
//
// MemoryStore — the EPHEMERAL `Store` driver. Same interface as SqliteStore,
// no disk. Tests and spikes that are not about durability use this so they
// neither touch the filesystem nor depend on `node:sqlite` being available.
//
// It is a real implementation of the seam, not a stub: swapping it for
// SqliteStore must change nothing above the interface, which is exactly the
// property spike:f105 leans on when it runs the same turns against both.
//
// THE KEYING INVARIANT, again (contract §6, SPIKE-07): the maps below are keyed
// by SESSION ID and nothing else. There is deliberately no provider or engine
// dimension in this structure — that is the property SPIKE-07 checks, and it is
// why two different engines operating on one session id read and write the same
// state.

import type { RuntimeMessage } from '../engine.js';
import type { McpEntry, SessionRef, Store } from './store.js';

type SessionState = {
  ref: SessionRef;
  messages: RuntimeMessage[];
  memory: Record<string, string>;
};

let counter = 0;
function mintSessionId(): string {
  counter += 1;
  return `s-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

export class MemoryStore implements Store {
  private readonly sessions = new Map<string, SessionState>();
  private readonly mcp = new Map<string, McpEntry>();
  private closed = false;

  /** Get (creating if absent) the state for a session. The same object identity
   * is returned across calls, so two different engines operating on one session
   * id share the exact same arrays/records. */
  private state(sessionId: string, providerId = ''): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      const now = Date.now();
      s = {
        ref: { sessionId, providerId, createdAt: now, lastUsedAt: now },
        messages: [],
        memory: {},
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  // -- sessions ------------------------------------------------------------

  createSession(providerId: string, title?: string): SessionRef {
    const sessionId = mintSessionId();
    const s = this.state(sessionId, providerId);
    if (title !== undefined) s.ref.title = title;
    return { ...s.ref };
  }

  getSession(sessionId: string): SessionRef | undefined {
    const s = this.sessions.get(sessionId);
    return s ? { ...s.ref } : undefined;
  }

  listSessions(): SessionRef[] {
    return [...this.sessions.values()]
      .map((s) => ({ ...s.ref }))
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  touchSession(sessionId: string, providerId?: string): SessionRef {
    const s = this.state(sessionId, providerId ?? '');
    s.ref.lastUsedAt = Date.now();
    // Only overwritten when a new one is supplied: it records the LAST provider
    // that answered and is never a constraint on the session.
    if (providerId !== undefined) s.ref.providerId = providerId;
    return { ...s.ref };
  }

  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  // -- messages ------------------------------------------------------------

  appendMessage(sessionId: string, msg: RuntimeMessage): void {
    this.state(sessionId).messages.push(msg);
  }

  getMessages(sessionId: string): RuntimeMessage[] {
    return [...this.state(sessionId).messages];
  }

  // -- memory --------------------------------------------------------------

  setMemory(sessionId: string, key: string, value: string): void {
    this.state(sessionId).memory[key] = value;
  }

  getMemory(sessionId: string, key: string): string | undefined {
    return this.state(sessionId).memory[key];
  }

  getAllMemory(sessionId: string): Record<string, string> {
    return { ...this.state(sessionId).memory };
  }

  // -- MCP registry --------------------------------------------------------

  listMcpEntries(): McpEntry[] {
    return [...this.mcp.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  upsertMcpEntry(entry: McpEntry): void {
    this.mcp.set(entry.name, entry);
  }

  removeMcpEntry(name: string): void {
    this.mcp.delete(name);
  }

  // -- lifecycle -----------------------------------------------------------

  close(): void {
    this.closed = true;
  }

  /** True once close() has run. Nothing enforces it — an in-memory store has no
   * handle to leak — but it keeps the two drivers observationally similar. */
  get isClosed(): boolean {
    return this.closed;
  }
}
