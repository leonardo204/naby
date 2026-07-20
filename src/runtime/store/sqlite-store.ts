// src/runtime/store/sqlite-store.ts
//
// SqliteStore — the DURABLE `Store` driver (F1-05, contract §6).
//
// WHY `node:sqlite` AND NOT better-sqlite3
// ----------------------------------------
// better-sqlite3 is a NATIVE module. Shipping one inside Electron drags back
// the entire burden we just paid to remove by moving production off the Claude
// Agent SDK: an `electron-rebuild` step against Electron's own ABI, an
// `asar-unpack` rule so the .node binary is loadable from the packaged app, and
// a per-OS prebuild matrix (three OSes, and the rebuild must happen on each).
// `node:sqlite` is BUILT INTO Node 24 — no native dependency, no rebuild step,
// no unpack rule, nothing added to the installer.
//
// THE CAVEAT, STATED PLAINLY
// --------------------------
// `node:sqlite` is EXPERIMENTAL in Node 24: it emits an ExperimentalWarning on
// load and its API may change in a future Node major. More sharply for us, its
// availability inside ELECTRON is not yet verified — Electron ships its own
// Node build and can compile out or lag a built-in module.
//
//   ==> F1-02 / SPIKE-04 MUST verify `require('node:sqlite')` resolves and
//       opens a database inside the Electron main process, on all three OSes.
//
// That unverified assumption is precisely why `Store` (store.ts) exists as an
// interface rather than this class being the runtime's direct dependency. If
// SPIKE-04 comes back negative, the fallback is a new driver file implementing
// the same interface — better-sqlite3 with the rebuild burden accepted, or a
// WASM build — and the runtime above does not change at all.

import { createRequire } from 'node:module';
// TYPE-ONLY import: `import type` is erased, so it does NOT load node:sqlite —
// which matters, because loading it is what emits the experimental warning, and
// a static ESM import is hoisted above any code that could suppress it. The
// actual load happens lazily inside openSilently() below.
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { RuntimeMessage } from '../engine.js';
import type { McpEntry, SessionRef, Store, UsageRecord } from './store.js';

// ---------------------------------------------------------------------------
// Experimental-warning suppression — TARGETED, not blanket.
// ---------------------------------------------------------------------------
//
// LOADING node:sqlite emits `ExperimentalWarning: SQLite is an experimental
// feature...`. In a desktop app that fires on every launch and trains the user
// (and us) to ignore stderr. We suppress EXACTLY that one warning, for EXACTLY
// the duration of the module load, by delegating everything else to the
// original `process.emitWarning`. A blanket
// `process.removeAllListeners('warning')` or a `--no-warnings` flag would also
// hide deprecations and real problems, so neither is used.
//
// The load is deliberately LAZY (createRequire, not a static import): a static
// ESM import is hoisted above every statement in this module, so the warning
// would already have been emitted before any suppression could be installed.

type SqliteModule = { DatabaseSync: new (path: string) => DatabaseSyncType };

const nodeRequire = createRequire(import.meta.url);
let sqliteModule: SqliteModule | undefined;

function loadSqlite(): SqliteModule {
  if (sqliteModule) return sqliteModule;
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
    const message = typeof warning === 'string' ? warning : (warning?.message ?? '');
    const first = rest[0];
    const type =
      typeof first === 'string'
        ? first
        : ((first as { type?: string } | undefined)?.type ?? '');
    if (type === 'ExperimentalWarning' && /SQLite/i.test(message)) return;
    (original as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    sqliteModule = nodeRequire('node:sqlite') as SqliteModule;
    return sqliteModule;
  } finally {
    process.emitWarning = original;
  }
}

function openSilently(path: string): DatabaseSyncType {
  return new (loadSqlite().DatabaseSync)(path);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
//
// SCHEMA VERSION lives in SQLite's `user_version` pragma so a future migration
// can branch on it. Bump it whenever the DDL below changes and add the matching
// migration step in `migrate()`.
//
// KEYING (contract §6, load-bearing): every table is keyed by SESSION ID. There
// is no provider or engine column ANYWHERE except `sessions.provider_id`, which
// is documented in the contract as "last provider used — a hint, not a
// constraint". Nothing reads it to decide what a session may do; it exists so
// the UI can show what answered last and pre-select it. Adding a provider or
// engine dimension to messages/memory would break the provider-switch property
// that F1-05 and SPIKE-07 exist to protect.

// v2 adds the `usage` table (F1-07) and the `settings` table (F1-08). Both are
// additive and every statement is IF NOT EXISTS, so an existing v1 database
// picks them up on next open with no data migration — the version is stamped to
// record that it happened.
const SCHEMA_VERSION = 2;

const DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  provider_id  TEXT NOT NULL,          -- last provider used: a HINT, not a constraint
  title        TEXT,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,          -- explicit ordering; never rely on rowid
  role       TEXT NOT NULL,             -- 'user' | 'assistant' | 'tool'
  payload    TEXT NOT NULL,             -- the RuntimeMessage, as JSON
  PRIMARY KEY (session_id, seq)
);

CREATE INDEX IF NOT EXISTS messages_by_session ON messages (session_id, seq);

CREATE TABLE IF NOT EXISTS memory (
  session_id TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  PRIMARY KEY (session_id, key)
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  name    TEXT PRIMARY KEY,
  payload TEXT NOT NULL                 -- the McpEntry, as JSON
);

-- F1-07. One row per ANSWERED TURN. Keyed by session id like everything else;
-- engine/provider/model are recorded as properties of the turn so each row can
-- be priced against the model that actually ran (a session may switch model or
-- provider on any turn).
CREATE TABLE IF NOT EXISTS usage (
  session_id          TEXT NOT NULL,
  seq                 INTEGER NOT NULL,   -- explicit ordering, as with messages
  at                  INTEGER NOT NULL,
  engine              TEXT NOT NULL,
  provider_id         TEXT NOT NULL,
  model               TEXT NOT NULL,
  input_tokens        INTEGER NOT NULL,
  output_tokens       INTEGER NOT NULL,
  cached_input_tokens INTEGER NOT NULL,
  cost_basis          TEXT NOT NULL,      -- 'metered' | 'subscription'
  reported_cost_usd   REAL,               -- NULL when the engine reported none
  PRIMARY KEY (session_id, seq)
);

CREATE INDEX IF NOT EXISTS usage_by_session ON usage (session_id, seq);

-- F1-08. App-wide, provider-independent preferences (e.g. which provider
-- answers). Deliberately NOT session-keyed: see the note on Store.getSetting.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// ---------------------------------------------------------------------------
// Row shapes as they come back from node:sqlite (null-prototype objects).
// ---------------------------------------------------------------------------

type SessionRow = {
  session_id: string;
  provider_id: string;
  title: string | null;
  created_at: number;
  last_used_at: number;
};

function toSessionRef(row: SessionRow): SessionRef {
  const ref: SessionRef = {
    sessionId: row.session_id,
    providerId: row.provider_id,
    createdAt: Number(row.created_at),
    lastUsedAt: Number(row.last_used_at),
  };
  if (row.title !== null && row.title !== undefined) ref.title = row.title;
  return ref;
}

let uuidCounter = 0;
function mintSessionId(): string {
  // randomUUID would do; this keeps the bundle free of a node:crypto import for
  // one call and is still collision-safe for our single-process use.
  uuidCounter += 1;
  return `s-${Date.now().toString(36)}-${uuidCounter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

export type SqliteStoreOptions = {
  /** File path, or ':memory:'. The directory must already exist. */
  path: string;
};

export class SqliteStore implements Store {
  private readonly db: DatabaseSyncType;
  private closed = false;

  constructor(options: SqliteStoreOptions | string) {
    const path = typeof options === 'string' ? options : options.path;
    this.db = openSilently(path);
    // Durability + concurrency posture for a desktop app: WAL survives a hard
    // kill of the renderer, and FK enforcement is off by design (we cascade
    // deletes explicitly, so a partially-written session is never referenced).
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  /** Idempotent: creating the schema on every open is a no-op after the first
   * (CREATE TABLE IF NOT EXISTS), so opening an existing DB is safe. */
  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as
      | { user_version: number }
      | undefined;
    const current = Number(row?.user_version ?? 0);

    this.db.exec(DDL);

    // v0 -> v1 is just "the schema now exists". Future migrations branch here
    // on `current` before the version is stamped.
    if (current !== SCHEMA_VERSION) {
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('SqliteStore: use after close()');
  }

  // -- sessions ------------------------------------------------------------

  createSession(providerId: string, title?: string): SessionRef {
    this.assertOpen();
    const now = Date.now();
    const ref: SessionRef = {
      sessionId: mintSessionId(),
      providerId,
      createdAt: now,
      lastUsedAt: now,
    };
    if (title !== undefined) ref.title = title;
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, provider_id, title, created_at, last_used_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(ref.sessionId, providerId, title ?? null, now, now);
    return ref;
  }

  getSession(sessionId: string): SessionRef | undefined {
    this.assertOpen();
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE session_id = ?')
      .get(sessionId) as SessionRow | undefined;
    return row ? toSessionRef(row) : undefined;
  }

  listSessions(): SessionRef[] {
    this.assertOpen();
    const rows = this.db
      .prepare('SELECT * FROM sessions ORDER BY last_used_at DESC')
      .all() as SessionRow[];
    return rows.map(toSessionRef);
  }

  touchSession(sessionId: string, providerId?: string): SessionRef {
    this.assertOpen();
    const now = Date.now();
    const existing = this.getSession(sessionId);
    if (!existing) {
      // Implicit creation: a caller may drive a session by a well-known id
      // (spikes, the shell's resumed ctx.sessionId) without minting one first.
      this.db
        .prepare(
          `INSERT INTO sessions (session_id, provider_id, title, created_at, last_used_at)
           VALUES (?, ?, NULL, ?, ?)`,
        )
        .run(sessionId, providerId ?? '', now, now);
      return { sessionId, providerId: providerId ?? '', createdAt: now, lastUsedAt: now };
    }
    // providerId is only OVERWRITTEN when a new one is supplied — it records
    // the last provider that answered and is never used as a constraint.
    const nextProvider = providerId ?? existing.providerId;
    this.db
      .prepare('UPDATE sessions SET last_used_at = ?, provider_id = ? WHERE session_id = ?')
      .run(now, nextProvider, sessionId);
    return { ...existing, providerId: nextProvider, lastUsedAt: now };
  }

  deleteSession(sessionId: string): void {
    this.assertOpen();
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM memory WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM usage WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId);
  }

  // -- messages ------------------------------------------------------------

  appendMessage(sessionId: string, msg: RuntimeMessage): void {
    this.assertOpen();
    // Ensure the session row exists so a transcript is never orphaned.
    if (!this.getSession(sessionId)) this.touchSession(sessionId);
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), -1) AS m FROM messages WHERE session_id = ?')
      .get(sessionId) as { m: number } | undefined;
    const seq = Number(row?.m ?? -1) + 1;
    this.db
      .prepare('INSERT INTO messages (session_id, seq, role, payload) VALUES (?, ?, ?, ?)')
      .run(sessionId, seq, msg.role, JSON.stringify(msg));
  }

  getMessages(sessionId: string): RuntimeMessage[] {
    this.assertOpen();
    const rows = this.db
      .prepare('SELECT payload FROM messages WHERE session_id = ? ORDER BY seq ASC')
      .all(sessionId) as { payload: string }[];
    return rows.map((r) => JSON.parse(r.payload) as RuntimeMessage);
  }

  // -- memory --------------------------------------------------------------

  setMemory(sessionId: string, key: string, value: string): void {
    this.assertOpen();
    if (!this.getSession(sessionId)) this.touchSession(sessionId);
    this.db
      .prepare(
        `INSERT INTO memory (session_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT (session_id, key) DO UPDATE SET value = excluded.value`,
      )
      .run(sessionId, key, value);
  }

  getMemory(sessionId: string, key: string): string | undefined {
    this.assertOpen();
    const row = this.db
      .prepare('SELECT value FROM memory WHERE session_id = ? AND key = ?')
      .get(sessionId, key) as { value: string } | undefined;
    return row?.value;
  }

  getAllMemory(sessionId: string): Record<string, string> {
    this.assertOpen();
    const rows = this.db
      .prepare('SELECT key, value FROM memory WHERE session_id = ? ORDER BY key ASC')
      .all(sessionId) as { key: string; value: string }[];
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  // -- usage (F1-07) -------------------------------------------------------

  appendUsage(sessionId: string, record: UsageRecord): void {
    this.assertOpen();
    if (!this.getSession(sessionId)) this.touchSession(sessionId);
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), -1) AS m FROM usage WHERE session_id = ?')
      .get(sessionId) as { m: number } | undefined;
    const seq = Number(row?.m ?? -1) + 1;
    this.db
      .prepare(
        `INSERT INTO usage (
           session_id, seq, at, engine, provider_id, model,
           input_tokens, output_tokens, cached_input_tokens,
           cost_basis, reported_cost_usd
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        sessionId,
        seq,
        record.at,
        record.engine,
        record.providerId,
        record.model,
        record.inputTokens,
        record.outputTokens,
        record.cachedInputTokens,
        record.costBasis,
        record.reportedCostUsd ?? null,
      );
  }

  listUsage(sessionId: string): UsageRecord[] {
    this.assertOpen();
    const rows = this.db
      .prepare('SELECT * FROM usage WHERE session_id = ? ORDER BY seq ASC')
      .all(sessionId) as {
      at: number;
      engine: string;
      provider_id: string;
      model: string;
      input_tokens: number;
      output_tokens: number;
      cached_input_tokens: number;
      cost_basis: string;
      reported_cost_usd: number | null;
    }[];
    return rows.map((r) => {
      const record: UsageRecord = {
        at: Number(r.at),
        engine: r.engine,
        providerId: r.provider_id,
        model: r.model,
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        cachedInputTokens: Number(r.cached_input_tokens),
        costBasis: r.cost_basis === 'subscription' ? 'subscription' : 'metered',
      };
      if (r.reported_cost_usd !== null && r.reported_cost_usd !== undefined) {
        record.reportedCostUsd = Number(r.reported_cost_usd);
      }
      return record;
    });
  }

  // -- app settings (F1-08) ------------------------------------------------

  getSetting(key: string): string | undefined {
    this.assertOpen();
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.assertOpen();
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  listSettings(): Record<string, string> {
    this.assertOpen();
    const rows = this.db
      .prepare('SELECT key, value FROM settings ORDER BY key ASC')
      .all() as { key: string; value: string }[];
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  // -- MCP registry --------------------------------------------------------

  listMcpEntries(): McpEntry[] {
    this.assertOpen();
    const rows = this.db
      .prepare('SELECT payload FROM mcp_servers ORDER BY name ASC')
      .all() as { payload: string }[];
    return rows.map((r) => JSON.parse(r.payload) as McpEntry);
  }

  upsertMcpEntry(entry: McpEntry): void {
    this.assertOpen();
    this.db
      .prepare(
        `INSERT INTO mcp_servers (name, payload) VALUES (?, ?)
         ON CONFLICT (name) DO UPDATE SET payload = excluded.payload`,
      )
      .run(entry.name, JSON.stringify(entry));
  }

  removeMcpEntry(name: string): void {
    this.assertOpen();
    this.db.prepare('DELETE FROM mcp_servers WHERE name = ?').run(name);
  }

  // -- lifecycle -----------------------------------------------------------

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
