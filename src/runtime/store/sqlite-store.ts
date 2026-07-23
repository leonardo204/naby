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
import { decideMemoryWrite } from '../memory-gate.js';
import type { RuntimeMessage } from '../engine.js';
import type {
  GoldenConsent,
  GoldenItem,
  GoldenItemInput,
  MemoryDeleteSelector,
  MemoryItem,
  MemoryProvenance,
  MemoryScope,
  MemoryStatus,
  MemoryType,
  MemoryWriteRequest,
  McpEntry,
  Project,
  SessionRef,
  Store,
  TrustTier,
  UsageRecord,
} from './store.js';

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
//
// v3 adds the `projects` table (Naby-owned, keyed by cwd) and three columns on
// `sessions` — cwd (the owning-project LINK, not a key), pinned, status. The
// table and its index are IF NOT EXISTS so a fresh open is a no-op, and the
// three session columns are declared directly in the CREATE TABLE below so a
// BRAND-NEW database (current === 0) already has them. Because SQLite's
// `ALTER TABLE ... ADD COLUMN` cannot be IF NOT EXISTS-guarded, an EXISTING v1/
// v2 database instead picks the columns up through the version-gated ALTERs in
// migrate() (run only when 0 < current < 3). Additive: no backfill, no loss.
//
// v4 (Phase 1.5) replaces the session-scoped `memory(session_id, key, value)`
// table with the SCOPED `memory_items` table (user/project/session/org scope,
// provenance, type, confidence, status — phase-1_5-memory-contracts §3). The
// migration is LOSSLESS: every existing `memory` row is back-filled as
// {scope:'session', scopeKey:session_id, type:'working', provenance.source:
// 'user', status:'confirmed', confidence:1} and the old table is dropped, so the
// legacy setMemory/getMemory/getAllMemory path keeps behaving exactly as before
// (it now reads/writes the scope='session' view of memory_items).
//
// v5 (Phase 1.5 P15-04) adds the `golden_items` table — a per-user HOLDOUT of
// real artifacts, held OUT of learning and reserved as a fixed evaluation set
// (phase-1_5-personalization-data-layer §5). It is purely ADDITIVE: the table
// and its index are IF NOT EXISTS in the DDL, so a brand-new database gets it on
// first open and an existing v4 database picks it up on next open with NO data
// migration and NO loss (memory_items, sessions, everything else untouched). The
// version is bumped only to record that it happened. The excluded-from-learning
// invariant is structural: no injection or extraction path reads this table.
const SCHEMA_VERSION = 5;

const DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  provider_id  TEXT NOT NULL,          -- last provider used: a HINT, not a constraint
  title        TEXT,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  cwd          TEXT,                          -- owning project (a LINK, not a key); NULL = projectless
  pinned       INTEGER NOT NULL DEFAULT 0,    -- 0/1
  status       TEXT                           -- e.g. 'active' | 'ended'; NULL = unknown
);

CREATE TABLE IF NOT EXISTS messages (
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,          -- explicit ordering; never rely on rowid
  role       TEXT NOT NULL,             -- 'user' | 'assistant' | 'tool'
  payload    TEXT NOT NULL,             -- the RuntimeMessage, as JSON
  PRIMARY KEY (session_id, seq)
);

CREATE INDEX IF NOT EXISTS messages_by_session ON messages (session_id, seq);

-- v4 (Phase 1.5). SCOPED memory with provenance (phase-1_5-memory-contracts
-- §3). Replaces the session-scoped memory(session_id, key, value) table; the
-- legacy rows are back-filled into this one by migrate() and the old table is
-- dropped. (scope, scope_key, key) is the upsert identity; id is the
-- provenance/rollback handle. The CASCADE EXEMPTION (§2/§6) is enforced in
-- deleteSession/removeProject, not by any FK — user/org rows have no session or
-- project owner and are never cascaded.
CREATE TABLE IF NOT EXISTS memory_items (
  id                TEXT PRIMARY KEY,
  scope             TEXT NOT NULL,   -- session | project | user | org
  scope_key         TEXT NOT NULL,   -- sessionId | cwd | userId | orgId
  type              TEXT NOT NULL,   -- working | episodic | semantic | procedural
  key               TEXT NOT NULL,   -- stable slug within (scope, scope_key)
  value             TEXT NOT NULL,
  prov_source       TEXT NOT NULL,   -- user | artifact | external (trust tier)
  prov_session_id   TEXT,            -- session it was learned in (rollback)
  prov_basis        TEXT,            -- short "why this was written"
  prov_created_from TEXT,            -- eval_event / message id, if any
  confidence        REAL NOT NULL,   -- 0..1 (1 for user-confirmed)
  status            TEXT NOT NULL,   -- proposed | confirmed
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE (scope, scope_key, key)
);

CREATE INDEX IF NOT EXISTS memory_items_by_scope ON memory_items (scope, scope_key);
CREATE INDEX IF NOT EXISTS memory_items_by_source ON memory_items (prov_source);

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

-- v3. Naby-owned projects, keyed by cwd (the directory IS the project's
-- identity). A SEPARATE key space from sessions/messages/memory/usage (keyed by
-- session id); the session↔project relationship lives as sessions.cwd, a LINK
-- and never a key for session state, so the keying invariant is intact.
CREATE TABLE IF NOT EXISTS projects (
  cwd            TEXT PRIMARY KEY,
  title          TEXT,
  created_at     INTEGER NOT NULL,
  last_opened_at INTEGER NOT NULL,       -- drives MRU ordering of the project list
  pinned         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS projects_by_opened ON projects (last_opened_at DESC);

-- v5 (Phase 1.5 P15-04). Per-user golden-set HOLDOUT: N of the user's real past
-- artifacts (input -> expected output), held OUT of learning and reserved as a
-- fixed evaluation yardstick (phase-1_5-personalization-data-layer §5). A
-- DELIBERATELY SEPARATE table from memory_items: no injection/extraction path
-- reads it, which is what makes the excluded-from-learning invariant structural
-- rather than a flag someone must remember to check. excluded_from_learning is
-- stored (DEFAULT 1, always 1) as an auditable record of the invariant; id is
-- the addressable handle Phase 2b re-scoring (F2-07) selects on; last_scored_at
-- is NULL until that re-scoring runs (reserved so it needs no later migration).
CREATE TABLE IF NOT EXISTS golden_items (
  id                     TEXT PRIMARY KEY,
  scope_key              TEXT NOT NULL,   -- the user (userId); single-user machine: a constant
  task_type              TEXT NOT NULL,   -- aligns with eval_events.task_type (P15-03)
  input                  TEXT NOT NULL,   -- the original prompt/input
  expected               TEXT NOT NULL,   -- the held-out real output, scored against later
  excluded_from_learning INTEGER NOT NULL DEFAULT 1,  -- ALWAYS 1 (the invariant, recorded)
  consent                TEXT NOT NULL,   -- granted | revoked | pending
  created_at             INTEGER NOT NULL,
  last_scored_at         INTEGER          -- NULL until Phase 2b re-scoring (F2-07)
);

CREATE INDEX IF NOT EXISTS golden_items_by_scope ON golden_items (scope_key);
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
  // v3 additions. Optional on the type because a row read from a db that has
  // just migrated (or a partial SELECT) may not carry them.
  cwd?: string | null;
  pinned?: number | null;
  status?: string | null;
};

function toSessionRef(row: SessionRow): SessionRef {
  const ref: SessionRef = {
    sessionId: row.session_id,
    providerId: row.provider_id,
    createdAt: Number(row.created_at),
    lastUsedAt: Number(row.last_used_at),
  };
  if (row.title !== null && row.title !== undefined) ref.title = row.title;
  // cwd is a LINK, surfaced when present; it is never a key for session state.
  if (row.cwd !== null && row.cwd !== undefined) ref.cwd = row.cwd;
  if (row.pinned !== null && row.pinned !== undefined) ref.pinned = Number(row.pinned) !== 0;
  if (row.status !== null && row.status !== undefined) ref.status = row.status;
  return ref;
}

type ProjectRow = {
  cwd: string;
  title: string | null;
  created_at: number;
  last_opened_at: number;
  pinned: number;
};

function toProject(row: ProjectRow): Project {
  const project: Project = {
    cwd: row.cwd,
    createdAt: Number(row.created_at),
    lastOpenedAt: Number(row.last_opened_at),
    pinned: Number(row.pinned) !== 0,
  };
  if (row.title !== null && row.title !== undefined) project.title = row.title;
  return project;
}

// Row shape for memory_items as it comes back from node:sqlite.
type MemoryRow = {
  id: string;
  scope: string;
  scope_key: string;
  type: string;
  key: string;
  value: string;
  prov_source: string;
  prov_session_id: string | null;
  prov_basis: string | null;
  prov_created_from: string | null;
  confidence: number;
  status: string;
  created_at: number;
  updated_at: number;
};

function toMemoryItem(row: MemoryRow): MemoryItem {
  const provenance: MemoryProvenance = { source: row.prov_source as TrustTier };
  if (row.prov_session_id !== null && row.prov_session_id !== undefined)
    provenance.sessionId = row.prov_session_id;
  if (row.prov_basis !== null && row.prov_basis !== undefined)
    provenance.basis = row.prov_basis;
  if (row.prov_created_from !== null && row.prov_created_from !== undefined)
    provenance.createdFrom = row.prov_created_from;
  return {
    id: row.id,
    scope: row.scope as MemoryScope,
    scopeKey: row.scope_key,
    type: row.type as MemoryType,
    key: row.key,
    value: row.value,
    provenance,
    confidence: Number(row.confidence),
    status: row.status as MemoryStatus,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

let memoryIdCounter = 0;
function mintMemoryId(): string {
  memoryIdCounter += 1;
  return `m-${Date.now().toString(36)}-${memoryIdCounter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

// Row shape for golden_items as it comes back from node:sqlite.
type GoldenRow = {
  id: string;
  scope_key: string;
  task_type: string;
  input: string;
  expected: string;
  excluded_from_learning: number;
  consent: string;
  created_at: number;
  last_scored_at: number | null;
};

function toGoldenItem(row: GoldenRow): GoldenItem {
  return {
    id: row.id,
    scopeKey: row.scope_key,
    taskType: row.task_type,
    input: row.input,
    expected: row.expected,
    // The excluded-from-learning invariant: always true, regardless of the
    // stored int. The column records the invariant for audit; the read never
    // surfaces it as false (nothing should ever write a 0, but a defensive read
    // makes tampering unobservable to the learning pipeline).
    excludedFromLearning: true,
    consent: row.consent as GoldenConsent,
    createdAt: Number(row.created_at),
    lastScoredAt:
      row.last_scored_at === null || row.last_scored_at === undefined
        ? null
        : Number(row.last_scored_at),
  };
}

let goldenIdCounter = 0;
function mintGoldenId(): string {
  goldenIdCounter += 1;
  return `g-${Date.now().toString(36)}-${goldenIdCounter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
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

    // v0 -> v1 is just "the schema now exists". v1/v2 -> v3 needs real column
    // work: the `projects` table and its index are already handled by the DDL
    // above (IF NOT EXISTS), and a BRAND-NEW db (current === 0) got the three
    // new session columns directly from the CREATE TABLE. But SQLite's
    // `ALTER TABLE ... ADD COLUMN` is NOT IF NOT EXISTS-guarded, so for an
    // EXISTING v1/v2 db we must add those columns exactly once — gated on the
    // version so a re-open (current === 3) never re-runs them. Additive only:
    // every column is nullable or carries a DEFAULT, so existing session rows
    // stay valid with no backfill and no data is touched.
    if (current > 0 && current < 3) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN cwd TEXT');
      this.db.exec('ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
      this.db.exec('ALTER TABLE sessions ADD COLUMN status TEXT');
    }

    // v?->v4 (Phase 1.5): back-fill the legacy session-scoped `memory` table
    // into `memory_items`, LOSSLESSLY, then drop it. Gated on the legacy table
    // actually existing (rather than only the version) so it is self-healing and
    // never runs twice: after the first migration the `memory` table is gone, so
    // this is a no-op on every subsequent open and on any brand-new database.
    // Each row becomes {scope:'session', scopeKey:session_id, type:'working',
    // provenance.source:'user', status:'confirmed', confidence:1}, exactly as
    // phase-1_5-memory-contracts §3 requires. The id is a random hex handle;
    // (scope='session', session_id, key) is unique because the legacy PK was
    // (session_id, key). Wrapped in a transaction so a crash cannot half-migrate.
    const legacyMemory = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory'")
      .get() as { name: string } | undefined;
    if (legacyMemory) {
      const now = Date.now();
      this.db.exec('BEGIN');
      try {
        this.db.exec(
          `INSERT INTO memory_items
             (id, scope, scope_key, type, key, value,
              prov_source, confidence, status, created_at, updated_at)
           SELECT lower(hex(randomblob(16))), 'session', session_id, 'working', key, value,
                  'user', 1, 'confirmed', ${now}, ${now}
           FROM memory`,
        );
        this.db.exec('DROP TABLE memory');
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
    }

    if (current !== SCHEMA_VERSION) {
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('SqliteStore: use after close()');
  }

  // -- sessions ------------------------------------------------------------

  createSession(providerId: string, title?: string, cwd?: string): SessionRef {
    this.assertOpen();
    const now = Date.now();
    const ref: SessionRef = {
      sessionId: mintSessionId(),
      providerId,
      createdAt: now,
      lastUsedAt: now,
    };
    if (title !== undefined) ref.title = title;
    // cwd is the owning-project LINK, not a key: recording it here never
    // changes how messages/memory/usage are keyed (still session id only).
    if (cwd !== undefined) ref.cwd = cwd;
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, provider_id, title, created_at, last_used_at, cwd)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(ref.sessionId, providerId, title ?? null, now, now, cwd ?? null);
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
    // CASCADE EXEMPTION (phase-1_5-memory-contracts §2/§6): delete ONLY this
    // session's scope='session' memory. user/project/org memory has no session
    // owner and MUST survive a session delete — that is the exact break the
    // personalization strategy requires. A scopeKey match alone is not enough:
    // it is qualified by scope='session' so a project whose cwd happened to
    // equal this sessionId (it cannot, but the guard makes the intent legible)
    // is never touched.
    this.db
      .prepare("DELETE FROM memory_items WHERE scope = 'session' AND scope_key = ?")
      .run(sessionId);
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

  // -- memory: legacy session-scoped view of memory_items ------------------
  //
  // These three are the Phase-1 API, preserved EXACTLY (spikes and the shell
  // depend on them). They are now the scope='session' view of memory_items: a
  // legacy write is a session-scoped, working, user-provenance, confirmed row
  // with confidence 1 — the same mapping the v4 migration applied to existing
  // rows, so an in-place migration and a fresh legacy write are indistinguishable.
  // A direct user session write does not need the gate (source 'user', scope
  // 'session', confirmed is exactly what the gate would allow); writing directly
  // keeps the legacy semantics byte-identical.

  setMemory(sessionId: string, key: string, value: string): void {
    this.assertOpen();
    if (!this.getSession(sessionId)) this.touchSession(sessionId);
    this.writeMemoryRow({
      scope: 'session',
      scopeKey: sessionId,
      type: 'working',
      key,
      value,
      provenance: { source: 'user', sessionId },
      confidence: 1,
      status: 'confirmed',
    });
  }

  getMemory(sessionId: string, key: string): string | undefined {
    this.assertOpen();
    const row = this.db
      .prepare(
        "SELECT value FROM memory_items WHERE scope = 'session' AND scope_key = ? AND key = ?",
      )
      .get(sessionId, key) as { value: string } | undefined;
    return row?.value;
  }

  getAllMemory(sessionId: string): Record<string, string> {
    this.assertOpen();
    const rows = this.db
      .prepare(
        "SELECT key, value FROM memory_items WHERE scope = 'session' AND scope_key = ? ORDER BY key ASC",
      )
      .all(sessionId) as { key: string; value: string }[];
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  // -- scoped memory (Phase 1.5) -------------------------------------------

  /** The shared upsert by (scope, scopeKey, key). Preserves createdAt on update
   * and bumps updatedAt; returns the resulting row. Does NOT gate — callers that
   * must gate (putMemory) decide first and pass the resolved status. */
  private writeMemoryRow(fields: {
    scope: MemoryScope;
    scopeKey: string;
    type: MemoryType;
    key: string;
    value: string;
    provenance: MemoryProvenance;
    confidence: number;
    status: MemoryStatus;
  }): MemoryItem {
    const now = Date.now();
    const existing = this.db
      .prepare(
        'SELECT * FROM memory_items WHERE scope = ? AND scope_key = ? AND key = ?',
      )
      .get(fields.scope, fields.scopeKey, fields.key) as MemoryRow | undefined;

    const id = existing ? existing.id : mintMemoryId();
    const createdAt = existing ? Number(existing.created_at) : now;
    const prov = fields.provenance;

    if (existing) {
      this.db
        .prepare(
          `UPDATE memory_items SET
             type = ?, value = ?, prov_source = ?, prov_session_id = ?,
             prov_basis = ?, prov_created_from = ?, confidence = ?, status = ?,
             updated_at = ?
           WHERE id = ?`,
        )
        .run(
          fields.type,
          fields.value,
          prov.source,
          prov.sessionId ?? null,
          prov.basis ?? null,
          prov.createdFrom ?? null,
          fields.confidence,
          fields.status,
          now,
          id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO memory_items
             (id, scope, scope_key, type, key, value,
              prov_source, prov_session_id, prov_basis, prov_created_from,
              confidence, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          fields.scope,
          fields.scopeKey,
          fields.type,
          fields.key,
          fields.value,
          prov.source,
          prov.sessionId ?? null,
          prov.basis ?? null,
          prov.createdFrom ?? null,
          fields.confidence,
          fields.status,
          createdAt,
          now,
        );
    }

    const provenance: MemoryProvenance = { source: prov.source };
    if (prov.sessionId !== undefined) provenance.sessionId = prov.sessionId;
    if (prov.basis !== undefined) provenance.basis = prov.basis;
    if (prov.createdFrom !== undefined) provenance.createdFrom = prov.createdFrom;
    return {
      id,
      scope: fields.scope,
      scopeKey: fields.scopeKey,
      type: fields.type,
      key: fields.key,
      value: fields.value,
      provenance,
      confidence: fields.confidence,
      status: fields.status,
      createdAt,
      updatedAt: now,
    };
  }

  putMemory(req: MemoryWriteRequest): MemoryItem {
    this.assertOpen();
    const existingRow = this.db
      .prepare(
        'SELECT * FROM memory_items WHERE scope = ? AND scope_key = ? AND key = ?',
      )
      .get(req.scope, req.scopeKey, req.key) as MemoryRow | undefined;
    const decision = decideMemoryWrite(
      req,
      existingRow ? toMemoryItem(existingRow) : undefined,
    );
    if (decision.behavior === 'deny') {
      // A deny THROWS (contract §6): the caller must not treat a refused write
      // as a silent no-op — memory poisoning is exactly the thing that must be
      // loud.
      throw new Error(`memory write denied: ${decision.reason}`);
    }
    // 'allow' carries the (possibly downgraded) status; 'hold' pins 'proposed'.
    return this.writeMemoryRow({
      scope: req.scope,
      scopeKey: req.scopeKey,
      type: req.type,
      key: req.key,
      value: req.value,
      provenance: req.provenance,
      confidence: req.confidence,
      status: decision.status,
    });
  }

  getScopedMemory(
    scope: MemoryScope,
    scopeKey: string,
    opts?: { status?: MemoryStatus },
  ): MemoryItem[] {
    this.assertOpen();
    const rows = (
      opts?.status
        ? this.db
            .prepare(
              'SELECT * FROM memory_items WHERE scope = ? AND scope_key = ? AND status = ? ORDER BY created_at ASC',
            )
            .all(scope, scopeKey, opts.status)
        : this.db
            .prepare(
              'SELECT * FROM memory_items WHERE scope = ? AND scope_key = ? ORDER BY created_at ASC',
            )
            .all(scope, scopeKey)
    ) as MemoryRow[];
    return rows.map(toMemoryItem);
  }

  confirmMemory(id: string): void {
    this.assertOpen();
    // The ONLY path external-origin memory becomes confirmed (§4 invariant 1).
    // No-op if already confirmed or absent.
    this.db
      .prepare(
        "UPDATE memory_items SET status = 'confirmed', updated_at = ? WHERE id = ? AND status = 'proposed'",
      )
      .run(Date.now(), id);
  }

  deleteMemory(sel: MemoryDeleteSelector): void {
    this.assertOpen();
    if ('id' in sel) {
      this.db.prepare('DELETE FROM memory_items WHERE id = ?').run(sel.id);
      return;
    }
    // delete-by-source (poisoning rollback): drop every row from one trust tier,
    // optionally narrowed to the session it was learned in.
    const source: TrustTier = sel.source;
    if (sel.sessionId !== undefined) {
      this.db
        .prepare(
          'DELETE FROM memory_items WHERE prov_source = ? AND prov_session_id = ?',
        )
        .run(source, sel.sessionId);
    } else {
      this.db
        .prepare('DELETE FROM memory_items WHERE prov_source = ?')
        .run(source);
    }
  }

  // -- golden set (Phase 1.5 P15-04) ---------------------------------------

  addGoldenItem(item: GoldenItemInput): GoldenItem {
    this.assertOpen();
    const now = Date.now();
    const id = mintGoldenId();
    const consent: GoldenConsent = item.consent ?? 'pending';
    // excluded_from_learning is ALWAYS 1 — the invariant. The caller cannot set
    // it (GoldenItemInput has no such field); it is stamped here and read back
    // as the literal `true`. last_scored_at is NULL (Phase 2b reserves it).
    this.db
      .prepare(
        `INSERT INTO golden_items
           (id, scope_key, task_type, input, expected,
            excluded_from_learning, consent, created_at, last_scored_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
      )
      .run(id, item.scopeKey, item.taskType, item.input, item.expected, consent, now);
    return {
      id,
      scopeKey: item.scopeKey,
      taskType: item.taskType,
      input: item.input,
      expected: item.expected,
      excludedFromLearning: true,
      consent,
      createdAt: now,
      lastScoredAt: null,
    };
  }

  listGoldenSet(scopeKey: string, opts?: { consent?: GoldenConsent }): GoldenItem[] {
    this.assertOpen();
    const rows = (
      opts?.consent
        ? this.db
            .prepare(
              'SELECT * FROM golden_items WHERE scope_key = ? AND consent = ? ORDER BY created_at ASC',
            )
            .all(scopeKey, opts.consent)
        : this.db
            .prepare(
              'SELECT * FROM golden_items WHERE scope_key = ? ORDER BY created_at ASC',
            )
            .all(scopeKey)
    ) as GoldenRow[];
    return rows.map(toGoldenItem);
  }

  getGoldenItem(id: string): GoldenItem | undefined {
    this.assertOpen();
    const row = this.db
      .prepare('SELECT * FROM golden_items WHERE id = ?')
      .get(id) as GoldenRow | undefined;
    return row ? toGoldenItem(row) : undefined;
  }

  setGoldenConsent(id: string, consent: GoldenConsent): void {
    this.assertOpen();
    // No-op if absent (UPDATE simply matches no row).
    this.db
      .prepare('UPDATE golden_items SET consent = ? WHERE id = ?')
      .run(consent, id);
  }

  removeGoldenItem(id: string): void {
    this.assertOpen();
    this.db.prepare('DELETE FROM golden_items WHERE id = ?').run(id);
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

  // -- projects (keyed by cwd; contract §6.1) ------------------------------

  listProjects(): Project[] {
    this.assertOpen();
    const rows = this.db
      .prepare('SELECT * FROM projects ORDER BY last_opened_at DESC')
      .all() as ProjectRow[];
    return rows.map(toProject);
  }

  upsertProject(
    cwd: string,
    patch?: Partial<Omit<Project, 'cwd' | 'createdAt'>>,
  ): Project {
    this.assertOpen();
    const now = Date.now();
    const existing = this.db
      .prepare('SELECT * FROM projects WHERE cwd = ?')
      .get(cwd) as ProjectRow | undefined;

    if (!existing) {
      // Insert: createdAt AND lastOpenedAt = now unless the patch overrides
      // lastOpenedAt. title/pinned come from the patch or default.
      const title = patch?.title ?? null;
      const pinned = patch?.pinned ? 1 : 0;
      const lastOpenedAt = patch?.lastOpenedAt ?? now;
      this.db
        .prepare(
          `INSERT INTO projects (cwd, title, created_at, last_opened_at, pinned)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(cwd, title, now, lastOpenedAt, pinned);
      return toProject({
        cwd,
        title,
        created_at: now,
        last_opened_at: lastOpenedAt,
        pinned,
      });
    }

    // Update: apply only the fields present in the patch; leave createdAt and
    // (unless the patch sets it) lastOpenedAt untouched. Idempotent.
    const title = patch?.title !== undefined ? patch.title : existing.title;
    const pinned =
      patch?.pinned !== undefined ? (patch.pinned ? 1 : 0) : existing.pinned;
    const lastOpenedAt =
      patch?.lastOpenedAt !== undefined
        ? patch.lastOpenedAt
        : existing.last_opened_at;
    this.db
      .prepare(
        'UPDATE projects SET title = ?, pinned = ?, last_opened_at = ? WHERE cwd = ?',
      )
      .run(title ?? null, pinned, lastOpenedAt, cwd);
    return toProject({
      cwd,
      title: title ?? null,
      created_at: existing.created_at,
      last_opened_at: lastOpenedAt,
      pinned,
    });
  }

  touchProject(cwd: string): Project {
    this.assertOpen();
    return this.upsertProject(cwd, { lastOpenedAt: Date.now() });
  }

  removeProject(cwd: string): void {
    this.assertOpen();
    // CASCADE, explicit and in the right order — mirrors deleteSession. FK
    // enforcement is off (see constructor), so orphans would otherwise linger:
    // first every session-keyed row for the project's sessions, then the
    // sessions, then the project itself. Wrapped in a transaction so a crash
    // mid-cascade can never leave a half-deleted project.
    const sessionRows = this.db
      .prepare('SELECT session_id FROM sessions WHERE cwd = ?')
      .all(cwd) as { session_id: string }[];
    this.db.exec('BEGIN');
    try {
      for (const { session_id } of sessionRows) {
        this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(session_id);
        // CASCADE EXEMPTION (§2/§6): a session's scope='session' memory only.
        this.db
          .prepare("DELETE FROM memory_items WHERE scope = 'session' AND scope_key = ?")
          .run(session_id);
        this.db.prepare('DELETE FROM usage WHERE session_id = ?').run(session_id);
      }
      // The project's OWN scope='project' memory (scopeKey = cwd) goes with it.
      // user/org memory is NOT project-owned and MUST survive — it is never
      // touched here (phase-1_5-memory-contracts §2/§6).
      this.db
        .prepare("DELETE FROM memory_items WHERE scope = 'project' AND scope_key = ?")
        .run(cwd);
      this.db.prepare('DELETE FROM sessions WHERE cwd = ?').run(cwd);
      this.db.prepare('DELETE FROM projects WHERE cwd = ?').run(cwd);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // -- session ↔ project links ---------------------------------------------

  listSessionsByProject(cwd: string): SessionRef[] {
    this.assertOpen();
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE cwd = ? ORDER BY last_used_at DESC')
      .all(cwd) as SessionRow[];
    return rows.map(toSessionRef);
  }

  setSessionProject(sessionId: string, cwd: string | null): void {
    this.assertOpen();
    // Only the owning-project link moves; messages and memory are untouched.
    this.db
      .prepare('UPDATE sessions SET cwd = ? WHERE session_id = ?')
      .run(cwd, sessionId);
  }

  // -- pinned sessions -----------------------------------------------------

  setSessionPinned(sessionId: string, pinned: boolean): void {
    this.assertOpen();
    this.db
      .prepare('UPDATE sessions SET pinned = ? WHERE session_id = ?')
      .run(pinned ? 1 : 0, sessionId);
  }

  listPinnedSessions(): SessionRef[] {
    this.assertOpen();
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE pinned = 1 ORDER BY last_used_at DESC')
      .all() as SessionRow[];
    return rows.map(toSessionRef);
  }

  // -- lifecycle -----------------------------------------------------------

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
