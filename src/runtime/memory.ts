// src/runtime/memory.ts
//
// A tiny in-memory, PROVIDER-INDEPENDENT store. Keyed by session id ONLY —
// never by provider or engine (contract §6: "Memory / context ... Keyed to
// user/session, NOT to provider or key"). SQLite replaces this later; for the
// spike, in-memory is fine — the invariant we must prove is the KEYING, not
// the durability.

import type { RuntimeMessage } from './engine.js';

export type SessionState = {
  messages: RuntimeMessage[];
  memory: Record<string, string>;
};

export class MemoryStore {
  // The map key is the session id. There is deliberately NO provider/engine
  // dimension anywhere in this structure — that is the property SPIKE-07 checks.
  private readonly sessions = new Map<string, SessionState>();

  /** Get (creating if absent) the state for a session. Same object identity is
   * returned across calls, so two different engines operating on the same
   * session id read and write the exact same arrays/records. */
  session(sessionId: string): SessionState {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { messages: [], memory: {} };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  appendMessage(sessionId: string, msg: RuntimeMessage): void {
    this.session(sessionId).messages.push(msg);
  }

  setMemory(sessionId: string, key: string, value: string): void {
    this.session(sessionId).memory[key] = value;
  }

  getMemory(sessionId: string, key: string): string | undefined {
    return this.session(sessionId).memory[key];
  }
}
