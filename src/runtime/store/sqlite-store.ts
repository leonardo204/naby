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
import { logActivity, registerActivityLogStore } from '../activity-log.js';
import { decideMemoryWrite } from '../memory-gate.js';
import { decideHarnessImport } from '../harness-gate.js';
import { buildHarnessSet, mergeHarnessSet } from './harness-set.js';
// The "is this the same claim" rule (P3-M8b §5.3) lives with the type so both
// drivers reset corroboration on exactly the same edits.
import { sameMemoryValue } from './store.js';
// The strength ceiling (P3-M13b §3.2) lives with the rest of the decay model in
// memory-hygiene, so the SQL that raises strength and the predicate that reads it
// can never disagree about the cap.
import { STRENGTH_CAP } from '../memory-hygiene.js';
import type { RollingSummary, RuntimeMessage } from '../engine.js';
import type {
  Agent,
  AgentInput,
  EvalEvent,
  EvalEventDeleteSelector,
  EvalEventInput,
  EvalEventKind,
  GoldenConsent,
  GoldenItem,
  GoldenItemInput,
  HarnessImportRequest,
  HarnessItem,
  HarnessKind,
  HarnessProvenance,
  HarnessRemoveSelector,
  HarnessScope,
  HarnessSet,
  HarnessStatus,
  HarnessTrust,
  MemoryDeleteSelector,
  MemoryItem,
  MemoryProvenance,
  MemoryScope,
  MemoryStatus,
  MemoryType,
  MemoryVolatility,
  MemoryWriteRequest,
  McpEntry,
  PolicyRule,
  PolicyRuleInput,
  Project,
  ReflectionCursor,
  ScopedMemoryQuery,
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
//
// v6 (Phase 1.6 HP-01) adds the `harness_items` table — Naby-owned, scoped
// commands/skills/subagents with provenance (phase-1_6-harness-contracts §2/§3).
// Purely ADDITIVE, exactly like v5: the table and its indexes are IF NOT EXISTS
// in the DDL, so a brand-new database gets it on first open and an existing v5
// database picks it up on next open with NO data migration and NO loss
// (memory_items, golden_items, sessions, everything else untouched). NO BACKFILL.
// The version is bumped only to record that it happened. Self-healing:
// re-opening is a no-op. (scope, scope_key, kind, name) is the upsert identity;
// the kind-specific payload is stored as a JSON column (a store-internal detail
// — the interface exposes typed command/skill/subagent). CASCADE EXEMPTION
// (§2): deleteSession never touches harness; removeProject removes only
// scope='project' harness for that cwd; user/org survive — enforced in the
// methods, not by any FK.
//
// v8 (Phase 3 P3-M8a) adds the `reflection_state` table — one row per session
// recording how far the session-reflection pass has read its transcript
// (specs/phase-3-continuous-learning.md §4.5). Purely ADDITIVE, exactly like v5
// and v6: the table is IF NOT EXISTS in the DDL, so a brand-new database gets it
// on first open and an existing v7 database picks it up on next open with NO data
// migration and NO loss (a session with no row simply reads as "never reflected
// on"). The version is bumped only to record that it happened. UNLIKE every other
// session-linked table this one IS deleted with its session — the cursor is
// progress state, not the user's record (see `ReflectionCursor` in store.ts).
//
// v9 (Phase 3 P3-M8b) adds the `memory_observations` table — which DISTINCT
// sessions agree with a memory item's CURRENT value
// (specs/phase-3-continuous-learning.md §5.3). Purely ADDITIVE, exactly like v5,
// v6 and v8: the table and its index are IF NOT EXISTS in the DDL, so a brand-new
// database gets them on first open and an existing v8 database picks them up on
// next open with NO data migration and NO loss. NO BACKFILL — and the absence of
// one is correct rather than lazy: an existing row's history of which sessions
// agreed with it was never recorded, so inventing observations for it would mean
// inventing evidence, and the honest reading of a pre-v9 row is "corroborated by
// nobody yet". Rows are written only by putMemory and are cascade-deleted with
// their memory item AND with the session that produced them.
/**
 * Exported so tests and spikes can assert "stamped to the CURRENT version"
 * instead of hardcoding a number that goes stale on the next migration — which
 * is exactly what happened when v7 landed and spike:harness started failing on
 * a lossless migration it had verified correctly.
 */
//
// v10 (Phase 3 P3-M10) adds TWO COLUMNS and no tables
// (specs/phase-3-memory-hygiene.md §2.1/§3): `memory_items.last_injected_at`
// (epoch ms, NULL = never used) and `sessions.no_learn` (0/1, DEFAULT 0). Both
// are added by `ALTER TABLE ... ADD COLUMN`, which — unlike CREATE TABLE — has no
// IF NOT EXISTS form, so each one is gated on the COLUMN being absent rather than
// on the version number. That is deliberate and it is what makes the migration
// self-healing: a database that skipped versions, or one whose user_version was
// stamped before a crash, still lands with exactly the right columns and never
// throws "duplicate column name" on a second open. NO BACKFILL, and its absence
// is again the honest reading rather than laziness: no row has an access history
// we never recorded (NULL means "never used", and `memoryLastAccessAt` falls back
// to updated_at so nothing is treated as stale for lack of data), and no existing
// session was a non-learning one.
//
// v11 (Phase 3 P3-M12b) adds ONE COLUMN and no tables: `sessions.fast_growth`
// (0/1, DEFAULT 0), the flag that marks a session the user opened to help naby
// learn faster (specs/phase-3-fast-evolution.md §3.3). Added the same way v10's
// two were — an `ALTER TABLE ... ADD COLUMN` gated on the COLUMN being absent
// rather than on the version number, so a database that skipped versions or was
// stamped before a crash still self-heals and never throws "duplicate column
// name". NO BACKFILL, and again that is the honest reading rather than laziness:
// every session that existed before this flag was ordinary work, and marking any
// of them as practice would retroactively discount a record the user earned.
//
// v12 (Phase 3 P3-M13) adds FIVE COLUMNS to `memory_items` and no tables
// (specs/phase-3-conversational-learning-hardening.md §3.1/§3.2):
// `superseded_at` (epoch ms, NULL = still current), `superseded_by` (the id of
// the memory that replaced it), `prov_supersedes` (the RESERVATION: which row
// this one will replace once it is confirmed), `volatility` (stable | transient;
// NULL = stable) and `strength` (REAL NOT NULL DEFAULT 1 — the S of the
// retrievability curve). Added exactly the way v10's and v11's were: an
// `ALTER TABLE ... ADD COLUMN` gated on the COLUMN being absent rather than on
// the version number, so a database that skipped versions or was stamped before
// a crash self-heals and never throws "duplicate column name".
//
// NO BACKFILL, and every default is the honest reading rather than a convenient
// one. NULL `superseded_at` says "nothing has replaced this", which is true of
// every row that existed before supersession did. NULL `volatility` reads as
// `stable`, which is the reading that cannot cause harm — an untagged fact can
// therefore never be erased by a passing detail that claims to contradict it.
// And `strength` DEFAULT 1 is not a placeholder: S = 1 makes the continuous
// decay curve reproduce the old 30-day/90-day cliffs EXACTLY, so an existing
// install's stale set is byte-for-byte what it was the day before the upgrade,
// and every row earns its slower ageing from its own use afterwards.
// v13 (session-context-management §2.2/§2.3) adds THREE COLUMNS to `sessions` and
// no tables: `handoff` (the previous session's summary, injected into every turn of
// this one — NULL = this session was not continued from another), `rolling_summary`
// (what the AI-SDK engine folded the older turns of THIS session into) and
// `rolling_summary_upto` (how many leading messages that summary covers, which is
// what makes reusing it safe rather than hopeful).
//
// COLUMNS AND NOT SETTINGS, deliberately. Both are read on the HOT PATH — the
// handoff on every turn of the session while the system prompt is assembled, the
// rolling summary on every AI-SDK payload build — which is precisely the shape
// `sessions.fast_growth` has, and it is read the same way: one row the engine
// already loads (`getSession`), no second lookup. `session.customTitle.*` is the
// counter-example and rightly so — a title is read when a LIST is drawn, not when
// a turn runs.
//
// Added the same way v10-v12's were: an `ALTER TABLE ... ADD COLUMN` gated on the
// COLUMN being absent rather than on the version number, so a database that
// skipped versions or was stamped before a crash self-heals and never throws
// "duplicate column name". NO BACKFILL, and NULL is the honest reading in all
// three cases: no session that predates this was continued from another one, and
// none of them ever folded a payload.
export const SCHEMA_VERSION = 13;

const DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  provider_id  TEXT NOT NULL,          -- last provider used: a HINT, not a constraint
  title        TEXT,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  cwd          TEXT,                          -- owning project (a LINK, not a key); NULL = projectless
  pinned       INTEGER NOT NULL DEFAULT 0,    -- 0/1
  pinned_at    INTEGER,                       -- WHEN it was pinned; NULL = not pinned
  status       TEXT,                          -- e.g. 'active' | 'ended'; NULL = unknown
  no_learn     INTEGER NOT NULL DEFAULT 0,    -- v10: 1 = temporary session, nothing is learned from it
  fast_growth  INTEGER NOT NULL DEFAULT 0,    -- v11: 1 = fast-growth session; its check-ins are drills
  handoff      TEXT,                          -- v13: previous session's handoff summary; NULL = not continued from one
  rolling_summary      TEXT,                  -- v13: what the older turns of THIS session were folded into
  rolling_summary_upto INTEGER                -- v13: how many leading messages that summary covers
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
  last_injected_at  INTEGER,         -- v10: last USE (injected/confirmed/edited); NULL = never
  superseded_at     INTEGER,         -- v12: WHEN a newer memory replaced this; NULL = current
  superseded_by     TEXT,            -- v12: the memory_items.id that replaced it
  prov_supersedes   TEXT,            -- v12: RESERVATION — the row this one replaces once confirmed
  volatility        TEXT,            -- v12: stable | transient; NULL reads as stable
  strength          REAL NOT NULL DEFAULT 1,  -- v12: S of R = exp(-t / (S x 30d)); 1..STRENGTH_CAP
  UNIQUE (scope, scope_key, key)
);

CREATE INDEX IF NOT EXISTS memory_items_by_scope ON memory_items (scope, scope_key);
CREATE INDEX IF NOT EXISTS memory_items_by_source ON memory_items (prov_source);
-- NOTE: the v10 memory_items_by_access index is NOT declared here. It names
-- last_injected_at, and on an UPGRADING database this DDL runs BEFORE the ALTER
-- that adds that column — CREATE INDEX would throw "no such column", and because
-- the whole DDL is executed as ONE statement batch the throw would abort the
-- migration mid-way and take every later statement with it. It is created in
-- migrate() instead, after the column is guaranteed to exist; a fresh database
-- gets it from that same line, so both end up identical.

-- v9 (Phase 3 P3-M8b). CROSS-SESSION CORROBORATION: which distinct sessions
-- agree with a memory item's CURRENT value (phase-3-continuous-learning §5.3).
--
-- THE COMPOSITE PRIMARY KEY IS THE WHOLE MECHANISM. (memory_id, session_id) means
-- one session votes ONCE per memory however many times it restates the fact, so
-- the count is "how many conversations independently said this" rather than "how
-- chatty was the user" — the distinction the trust meter exists to keep (§2, the
-- decision not to count volume). Written ONLY by putMemory, cleared for an item
-- whose value materially changes, and cascade-deleted with the memory item and
-- with the session (both explicit in the methods, like every other cascade here —
-- foreign_keys is ON but no FK is declared, because memory items outlive the
-- sessions that taught them).
CREATE TABLE IF NOT EXISTS memory_observations (
  memory_id    TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  observed_at  INTEGER NOT NULL,   -- epoch ms of the write that recorded it
  created_from TEXT,               -- "<sessionId>:<seq>" of the evidence, if any
  PRIMARY KEY (memory_id, session_id)
);
CREATE INDEX IF NOT EXISTS memory_observations_by_session ON memory_observations (session_id);

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

-- v6 (Phase 1.6 HP-01). Naby-owned harness: commands/skills/subagents, scoped
-- (user/project/org — NO session scope), with provenance
-- (phase-1_6-harness-contracts §2/§3). Purely ADDITIVE: this table + its indexes
-- are IF NOT EXISTS, so a brand-new db gets it on first open and an existing v5
-- db picks it up with NO backfill and NO loss. (scope, scope_key, kind, name) is
-- the upsert identity; id is the provenance/rollback handle. The kind-specific
-- payload (command|skill|subagent) is stored as a single JSON column — a
-- store-internal detail; the interface exposes it as typed fields. The CASCADE
-- EXEMPTION (§2) is enforced in deleteSession/removeProject, not by any FK:
-- deleteSession never touches this table; removeProject deletes only
-- scope='project' rows for that cwd; user/org rows have no session/project owner
-- and are never cascaded.
CREATE TABLE IF NOT EXISTS harness_items (
  id                TEXT PRIMARY KEY,
  scope             TEXT NOT NULL,   -- user | project | org
  scope_key         TEXT NOT NULL,   -- userId | cwd | orgId
  kind              TEXT NOT NULL,   -- command | skill | subagent
  name              TEXT NOT NULL,   -- verb / skill / subagent name (upsert target within scope+kind)
  description       TEXT,
  status            TEXT NOT NULL,   -- enabled | disabled | removed (imported => disabled; removed = user-deleted tombstone, no migration: free-text column, no CHECK)
  prov_source       TEXT NOT NULL,   -- user | artifact | external (trust tier)
  prov_origin       TEXT,            -- '~/.claude/...' | 'set:name@ver' (rollback)
  prov_format       TEXT,            -- claude-skill-md | claude-agent-md | claude-command-md | naby
  prov_imported_at  INTEGER,         -- epoch ms it was imported, if it was
  payload           TEXT NOT NULL,   -- kind-specific payload, as JSON (store-internal)
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE (scope, scope_key, kind, name)
);

CREATE INDEX IF NOT EXISTS harness_items_by_scope ON harness_items (scope, scope_key);
CREATE INDEX IF NOT EXISTS harness_items_by_origin ON harness_items (prov_origin);

-- Tool-execution policy rules (Phase 2, M1). Additive table: an existing DB
-- picks it up on next open with NO data migration and NO loss. Keyed like
-- harness (scope, scope_key); identity for upsert is (scope, scope_key,
-- tool_pattern). Never session-keyed and never cascaded on session delete.
CREATE TABLE IF NOT EXISTS policy_rules (
  id           TEXT PRIMARY KEY,
  scope        TEXT NOT NULL,   -- user | project | org
  scope_key    TEXT NOT NULL,   -- userId | cwd | orgId
  tool_pattern TEXT NOT NULL,   -- bare tool name, trailing-* wildcard, or '*'
  effect       TEXT NOT NULL,   -- allow | deny | ask
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (scope, scope_key, tool_pattern)
);
CREATE INDEX IF NOT EXISTS policy_rules_by_scope ON policy_rules (scope, scope_key);

-- The eval-event ledger (Phase 3, P3-M5) — the stream P15-03 RESERVED, finally
-- given a writer. Additive table: an existing DB picks it up on next open with NO
-- data migration and NO loss.
--
-- ONE stream, discriminated by kind, deliberately: memory provenance already
-- points here (MemoryProvenance.createdFrom = "eval_event id"), and a second
-- table for the same purpose would make that pointer ambiguous. A later F2-04
-- draft/final/edit-diff observation adds a kind, not a table.
--
-- Keyed by its own id and indexed by agent_id, because the trust meter reads
-- "this agent's recent rows". session_id is a LINK, not a key — deleting a
-- conversation must not erase what the agent proved (the same reasoning as the
-- memory keying invariant, phase-1-contracts §6). The agent NEVER reads this
-- table: no tool and no injection exposes it, or it would optimize its own score.
CREATE TABLE IF NOT EXISTS eval_events (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,          -- checkin | autonomous | tripwire
  at           INTEGER NOT NULL,
  agent_id     TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  task_type    TEXT,                   -- P15-03 task_type — the per-scope trust axis
  domain       TEXT,                   -- P15-03 domain tag (reserved; unused in M5)
  payload      TEXT NOT NULL,          -- JSON: kind-specific fields (options, hit, …)
  excluded     INTEGER NOT NULL DEFAULT 0  -- 1 = degenerate, kept but not scored
);
CREATE INDEX IF NOT EXISTS eval_events_by_agent ON eval_events (agent_id, at);
CREATE INDEX IF NOT EXISTS eval_events_by_session ON eval_events (session_id);

-- v8 (Phase 3 P3-M8a). How far the session-reflection pass has read each
-- session's transcript (specs/phase-3-continuous-learning.md §4.5). Additive: an
-- existing DB picks it up on next open with NO data migration and NO loss — an
-- absent row means "never reflected on", which is the correct reading for every
-- session that predates this table.
--
-- THE ONE SESSION-KEYED TABLE THAT IS CASCADE-DELETED WITH ITS SESSION. The
-- ledger deliberately survives a deleted conversation (checkin-contracts
-- invariant 4: what the agent proved is not erased by tidying up chats), but a
-- cursor is not a record of anything the user or the agent did — it is a
-- bookmark into a transcript. Keeping bookmarks for deleted transcripts would
-- only leave rows nothing can ever read.
CREATE TABLE IF NOT EXISTS reflection_state (
  session_id   TEXT PRIMARY KEY,
  last_seq     INTEGER NOT NULL,   -- highest message seq already reflected on
  reflected_at INTEGER NOT NULL    -- epoch ms of that reflection
);

-- naby agents (Phase 3, P3-M1). Additive table: an existing DB picks it up on
-- next open with NO data migration and NO loss. The naby-OWNED agent layer
-- (built-in persona + custom agents), addressed by the @ prefix. Global — NO
-- scope; keyed by id, with name UNIQUE (it is the @-routing handle). Never
-- session-keyed and never cascaded on session/project delete.
CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,   -- @-routing handle, unique across agents
  kind          TEXT NOT NULL,          -- persona | custom
  description   TEXT,
  system_prompt TEXT NOT NULL,
  model         TEXT,
  tool_refs     TEXT,                   -- JSON string[] | null (inherit toolset)
  memory_scope  TEXT NOT NULL,          -- session | project | user | org
  autonomy      TEXT NOT NULL,          -- JSON AgentAutonomy
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agents_by_kind ON agents (kind);
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
  // v7. Orders the pinned tabs: earliest pin sits leftmost. `last_used_at` used
  // to stand in for this and could not express it — a pinned tab jumped around
  // as soon as the user typed in another one.
  pinned_at?: number | null;
  // v10 (P3-M10). 1 = a temporary session nothing is learned from. Optional on
  // the type for the same reason as the v3 columns: a partial SELECT, or a row
  // read from a database mid-migration, may not carry it.
  no_learn?: number | null;
  // v11 (P3-M12b). 1 = a fast-growth session, whose check-ins are drills.
  // Optional on the type for the same reason as every column above it.
  fast_growth?: number | null;
  // v13 (session-context-management §2.2). The previous session's handoff summary.
  // NULL = this session was not continued from another one.
  handoff?: string | null;
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
  if (row.pinned_at !== null && row.pinned_at !== undefined) ref.pinnedAt = Number(row.pinned_at);
  // v10. Surfaced ONLY when it is on: `noLearn: false` and an absent field mean
  // the same thing everywhere that reads it (`=== true`), and leaving the field
  // off keeps every existing SessionRef comparison — and every stored JSON
  // snapshot of one — byte-for-byte what it was.
  if (row.no_learn !== null && row.no_learn !== undefined && Number(row.no_learn) !== 0) {
    ref.noLearn = true;
  }
  // v11. Surfaced only when it is on, for the same reason `noLearn` is: absent
  // and false must mean the same thing to every reader, and a field that appears
  // on every SessionRef would change what a stored snapshot of one looks like.
  if (row.fast_growth !== null && row.fast_growth !== undefined && Number(row.fast_growth) !== 0) {
    ref.fastGrowth = true;
  }
  // v13. Surfaced only when there is one, for the same reason the two flags above
  // are: absent must read as "no handoff" everywhere, and a field present on every
  // SessionRef would change what a stored snapshot of one looks like.
  //
  // The ROLLING SUMMARY is deliberately NOT here. It is read by exactly one caller
  // at exactly one moment (the AI-SDK engine, while sizing a payload), and it can
  // be thousands of characters — carrying it on every row of every session LIST
  // would spend that on every screen that draws one. It has its own accessor.
  if (row.handoff !== null && row.handoff !== undefined && row.handoff !== '') {
    ref.handoff = row.handoff;
  }
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
  // v10 (P3-M10). Epoch ms of the last USE; NULL = never used. Optional on the
  // type because a partial SELECT (or a pre-migration read) may not carry it.
  last_injected_at?: number | null;
  // v12 (P3-M13). All optional on the type for the same reason.
  superseded_at?: number | null;
  superseded_by?: string | null;
  prov_supersedes?: string | null;
  volatility?: string | null;
  strength?: number | null;
};

function toMemoryItem(row: MemoryRow): MemoryItem {
  const provenance: MemoryProvenance = { source: row.prov_source as TrustTier };
  if (row.prov_session_id !== null && row.prov_session_id !== undefined)
    provenance.sessionId = row.prov_session_id;
  if (row.prov_basis !== null && row.prov_basis !== undefined)
    provenance.basis = row.prov_basis;
  if (row.prov_created_from !== null && row.prov_created_from !== undefined)
    provenance.createdFrom = row.prov_created_from;
  if (row.prov_supersedes !== null && row.prov_supersedes !== undefined)
    provenance.supersedes = row.prov_supersedes;
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
    // Absent rather than null when never used (P3-M10) — `memoryLastAccessAt`
    // reads `?? updatedAt`, and a literal null would satisfy `!== undefined`
    // checks while being useless arithmetic.
    ...(row.last_injected_at !== null && row.last_injected_at !== undefined
      ? { lastInjectedAt: Number(row.last_injected_at) }
      : {}),
    // v12 (P3-M13). Absent rather than null for the same reason as above: a
    // literal null satisfies `!== undefined` while being useless arithmetic, and
    // "this row was never superseded" is an ABSENCE, not a value.
    ...(row.superseded_at !== null && row.superseded_at !== undefined
      ? { supersededAt: Number(row.superseded_at) }
      : {}),
    ...(row.superseded_by !== null && row.superseded_by !== undefined
      ? { supersededBy: row.superseded_by }
      : {}),
    ...(row.volatility === 'stable' || row.volatility === 'transient'
      ? { volatility: row.volatility }
      : {}),
    // Strength is NOT NULL in the table, so a read always has it — the fallback
    // covers only a partial SELECT and a row read mid-migration, where 1 (the
    // column's own DEFAULT) is the right answer.
    strength: row.strength === null || row.strength === undefined ? 1 : Number(row.strength),
  };
}

// ---------------------------------------------------------------------------
// The scoped-memory read filter, as SQL (P3-M10 §4).
// ---------------------------------------------------------------------------

/**
 * Build the WHERE fragment + bound parameters shared by `getScopedMemory` and
 * `countScopedMemory`.
 *
 * ONE BUILDER FOR BOTH, deliberately: a list and its total that computed their
 * predicates separately would eventually disagree, and the symptom — a page
 * saying "showing 12 of 40" while holding 12 of 12 — is the kind of bug that gets
 * blamed on the UI for a week.
 *
 * `search` is matched with LIKE over key and value. The term is ESCAPED first:
 * `%` and `_` are LIKE wildcards, so an un-escaped search for "50%" would quietly
 * match everything containing "50". LIKE's default case-insensitivity is
 * ASCII-only, which is exactly what `memoryMatchesSearch` implements on the
 * in-memory side — see that function for why both sides fold only A–Z.
 */
/**
 * The staleness comparison, as one SQL fragment taking `(staleBefore, windowMs)`
 * in that order — used by the scoped filter and by `listStaleConfirmedMemory`, so
 * the browser's "unused" chip and the sweep's review queue cannot describe
 * different sets.
 *
 * `COALESCE(last_injected_at, updated_at)` is the `lastInjectedAt ?? updatedAt`
 * fallback: a pre-v10 row is judged on when it was last WRITTEN rather than
 * treated as infinitely old.
 *
 * THE STRENGTH TERM (P3-M13b §3.2). `access < before - (strength - 1) × window`
 * is `elapsed > strength × window` rearranged, which is exactly `R < e^-3` for
 * the review window. It is written as a SHIFT OF THE CUTOFF rather than as an
 * exponential because SQLite has no `exp()` — and because a shift is index-
 * friendly arithmetic on the same column the cutoff already compares. With
 * `windowMs = 0` (every pre-M13 caller) the term vanishes and the fragment is
 * byte-for-byte the P3-M10 comparison.
 */
function staleSql(): string {
  return 'COALESCE(last_injected_at, updated_at) < ? - (COALESCE(strength, 1) - 1) * ?';
}

function scopedMemoryFilter(
  scope: MemoryScope,
  scopeKey: string,
  opts?: ScopedMemoryQuery,
): {
  sql: string;
  params: (string | number)[];
} {
  const clauses: string[] = ['scope = ?', 'scope_key = ?'];
  // Bound in the same order the clauses are appended — which is why the scope
  // pair is pushed here rather than left for the caller to remember.
  const params: (string | number)[] = [scope, scopeKey];
  if (opts?.status) {
    clauses.push('status = ?');
    params.push(opts.status);
  }
  if (opts?.type) {
    clauses.push('type = ?');
    params.push(opts.type);
  }
  const term = opts?.search?.trim();
  if (term) {
    const escaped = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    clauses.push("(key LIKE ? ESCAPE '\\' OR value LIKE ? ESCAPE '\\')");
    params.push(escaped, escaped);
  }
  const prefix = opts?.keyPrefix?.trim();
  if (prefix) {
    // KEY NAMESPACE, not a search: anchored at the start and on the key only
    // (see `ScopedMemoryQuery.keyPrefix`). `%` and `_` are escaped for the same
    // reason the search term is — `style_` would otherwise match `styleX`.
    // GLOB, not LIKE, because LIKE is case-insensitive over A–Z and the
    // in-memory twin compares with `startsWith`; two answers to "does this key
    // begin with style/" is exactly the divergence spike:f105 exists to catch.
    clauses.push("key GLOB ?");
    params.push(`${prefix.replace(/[[\]*?]/g, (c) => `[${c}]`)}*`);
  }
  if (typeof opts?.staleBefore === 'number') {
    // The `isStaleForReview` predicate, in SQL: confirmed AND last access before
    // the cutoff. COALESCE is the `lastInjectedAt ?? updatedAt` fallback, so a
    // pre-v10 row (last_injected_at NULL) is judged on when it was last written
    // rather than being treated as infinitely old.
    // The `isStaleForReview` predicate, in SQL — see `staleSql` for the strength
    // term and why it is expressed as a shift of the cutoff.
    clauses.push("status = 'confirmed'", staleSql());
    params.push(Math.trunc(opts.staleBefore), Math.max(0, Math.trunc(opts.staleWindowMs ?? 0)));
  }
  if (typeof opts?.superseded === 'boolean') {
    // NULL-vs-NOT-NULL, not a boolean column: supersession is a TIMESTAMP, so
    // "was it replaced" and "when" are the same fact and cannot drift apart.
    clauses.push(opts.superseded ? 'superseded_at IS NOT NULL' : 'superseded_at IS NULL');
  }
  return { sql: clauses.join(' AND '), params };
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

// Row shape for harness_items as it comes back from node:sqlite. The
// kind-specific payload lives in the `payload` JSON column (store-internal).
type HarnessRow = {
  id: string;
  scope: string;
  scope_key: string;
  kind: string;
  name: string;
  description: string | null;
  status: string;
  prov_source: string;
  prov_origin: string | null;
  prov_format: string | null;
  prov_imported_at: number | null;
  payload: string;
  created_at: number;
  updated_at: number;
};

/** The payload JSON as stored — the three optional kind-specific fields of
 * HarnessItem (one populated), plus `importedFrom`.
 *
 * WHY importedFrom RIDES IN THE JSON. It is an audit-only string added by
 * harness-standalone §2.1, and nothing queries or indexes it — so it earns a
 * JSON key, not a column. Adding a column would mean an ALTER on a table shipped
 * installations already have; the payload column is already free-form and
 * forward-compatible, which is the same trick eval_events uses for its
 * kind-specific fields. A row written before this existed simply has no key. */
type HarnessPayload = Pick<HarnessItem, 'command' | 'skill' | 'subagent'> & {
  importedFrom?: string;
};

function toHarnessItem(row: HarnessRow): HarnessItem {
  const provenance: HarnessProvenance = { source: row.prov_source as HarnessTrust };
  if (row.prov_origin !== null && row.prov_origin !== undefined)
    provenance.origin = row.prov_origin;
  if (row.prov_format !== null && row.prov_format !== undefined)
    provenance.format = row.prov_format as HarnessProvenance['format'];
  if (row.prov_imported_at !== null && row.prov_imported_at !== undefined)
    provenance.importedAt = Number(row.prov_imported_at);

  const payload = JSON.parse(row.payload) as HarnessPayload;
  if (typeof payload.importedFrom === 'string' && payload.importedFrom.length > 0)
    provenance.importedFrom = payload.importedFrom;

  const item: HarnessItem = {
    id: row.id,
    scope: row.scope as HarnessScope,
    scopeKey: row.scope_key,
    kind: row.kind as HarnessKind,
    name: row.name,
    status: row.status as HarnessStatus,
    provenance,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
  if (row.description !== null && row.description !== undefined)
    item.description = row.description;
  if (payload.command !== undefined) item.command = payload.command;
  if (payload.skill !== undefined) item.skill = payload.skill;
  if (payload.subagent !== undefined) item.subagent = payload.subagent;
  return item;
}

/** Extract the JSON-stored slice: the kind-specific payload plus the audit-only
 *  `provenance.importedFrom` (see HarnessPayload for why it lives here). */
function harnessPayloadOf(item: {
  command?: HarnessItem['command'];
  skill?: HarnessItem['skill'];
  subagent?: HarnessItem['subagent'];
  provenance?: HarnessProvenance;
}): HarnessPayload {
  const payload: HarnessPayload = {};
  if (item.command !== undefined) payload.command = item.command;
  if (item.skill !== undefined) payload.skill = item.skill;
  if (item.subagent !== undefined) payload.subagent = item.subagent;
  if (item.provenance?.importedFrom !== undefined)
    payload.importedFrom = item.provenance.importedFrom;
  return payload;
}

let harnessIdCounter = 0;
function mintHarnessId(): string {
  harnessIdCounter += 1;
  return `h-${Date.now().toString(36)}-${harnessIdCounter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

let policyIdCounter = 0;
function mintPolicyId(): string {
  policyIdCounter += 1;
  return `p-${Date.now().toString(36)}-${policyIdCounter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

type PolicyRow = {
  id: string;
  scope: string;
  scope_key: string;
  tool_pattern: string;
  effect: string;
  created_at: number;
  updated_at: number;
};

function toPolicyRule(row: PolicyRow): PolicyRule {
  return {
    id: row.id,
    scope: row.scope as PolicyRule['scope'],
    scopeKey: row.scope_key,
    toolPattern: row.tool_pattern,
    effect: row.effect as PolicyRule['effect'],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

let agentIdCounter = 0;
function mintAgentId(): string {
  agentIdCounter += 1;
  return `a-${Date.now().toString(36)}-${agentIdCounter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

type AgentRow = {
  id: string;
  name: string;
  kind: string;
  description: string | null;
  system_prompt: string;
  model: string | null;
  tool_refs: string | null;
  memory_scope: string;
  autonomy: string;
  created_at: number;
  updated_at: number;
};

function toAgent(row: AgentRow): Agent {
  const agent: Agent = {
    id: row.id,
    name: row.name,
    kind: row.kind as Agent['kind'],
    systemPrompt: row.system_prompt,
    memoryScope: row.memory_scope as Agent['memoryScope'],
    autonomy: JSON.parse(row.autonomy) as Agent['autonomy'],
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
  if (row.description != null) agent.description = row.description;
  if (row.model != null) agent.model = row.model;
  if (row.tool_refs != null) agent.toolRefs = JSON.parse(row.tool_refs) as string[];
  return agent;
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

let evalEventCounter = 0;
function mintEvalEventId(): string {
  // Same reasoning as mintSessionId: no node:crypto import for one call.
  evalEventCounter += 1;
  return `ev-${Date.now().toString(36)}-${evalEventCounter.toString(36)}-${Math.random()
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
    // THE ACTIVITY LOG LIVES BESIDE THE DATABASE (naby-activity-log §2). Said
    // here rather than resolved independently by the logger, because this is the
    // only place that knows which file was actually opened: a spike that points a
    // store at a temp directory gets its logs there, and the user's real
    // `~/.naby` is not touched by a test that never named it. An environment-
    // configured home still wins — see activity-log.ts `activityLogDir`.
    if (path !== ':memory:') registerActivityLogStore(path);
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
    // v?->v7: pin ORDER. Adding the column is enough for correctness — a row
    // pinned before this migration has pinned_at NULL and sorts last, which is
    // the only honest answer since the moment it was pinned was never recorded.
    // Gated on the column being absent rather than on the version, so a database
    // that skipped versions self-heals; ALTER TABLE ADD COLUMN has no
    // IF NOT EXISTS and throws on a second run.
    const sessionCols = this.db.prepare('PRAGMA table_info(sessions)').all() as {
      name: string;
    }[];
    if (sessionCols.length > 0 && !sessionCols.some((c) => c.name === 'pinned_at')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN pinned_at INTEGER');
    }

    // v?->v10 (P3-M10): the two hygiene columns. Gated on the COLUMN, not the
    // version, for the reason spelled out at SCHEMA_VERSION — ADD COLUMN has no
    // IF NOT EXISTS and throws on a second run, so a version-gated migration that
    // ever half-ran would brick every subsequent open. Additive and backfill-free:
    // `last_injected_at` is nullable ("never used", which is true) and
    // `no_learn` carries a DEFAULT 0 ("this session was learned from", which is
    // also true of every session that existed before the flag).
    if (sessionCols.length > 0 && !sessionCols.some((c) => c.name === 'no_learn')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN no_learn INTEGER NOT NULL DEFAULT 0');
    }

    // v?->v11 (P3-M12b): the fast-growth flag. Column-gated for the same reason,
    // additive, and backfill-free — DEFAULT 0 says "this was ordinary work", which
    // is true of every session that existed before the fast-growth session did.
    if (sessionCols.length > 0 && !sessionCols.some((c) => c.name === 'fast_growth')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN fast_growth INTEGER NOT NULL DEFAULT 0');
    }

    // v?->v13 (session-context-management): the handoff and the rolling summary.
    // Column-gated like every ALTER above, additive, and backfill-free — NULL says
    // "this session was not continued from another" and "nothing has been folded",
    // both of which are true of every session that existed before this landed.
    // Driven off a list for the same reason v12's five were.
    if (sessionCols.length > 0) {
      for (const [name, decl] of [
        ['handoff', 'TEXT'],
        ['rolling_summary', 'TEXT'],
        ['rolling_summary_upto', 'INTEGER'],
      ] as [string, string][]) {
        if (!sessionCols.some((c) => c.name === name)) {
          this.db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${decl}`);
        }
      }
    }
    const memoryCols = this.db.prepare('PRAGMA table_info(memory_items)').all() as {
      name: string;
    }[];
    if (memoryCols.length > 0 && !memoryCols.some((c) => c.name === 'last_injected_at')) {
      this.db.exec('ALTER TABLE memory_items ADD COLUMN last_injected_at INTEGER');
    }

    // v?->v12 (P3-M13): supersession, volatility and strength. Column-gated for
    // the same reason as every ALTER above, and driven off a LIST so five
    // near-identical guards do not become five places to forget one.
    //
    // ORDER MATTERS ONLY IN ONE WAY: `strength` is the sole NOT NULL addition, and
    // SQLite accepts that only because it carries a DEFAULT — which is also what
    // makes the migration backfill-free, since DEFAULT 1 is the value that
    // reproduces the pre-M13 decay behaviour exactly (see SCHEMA_VERSION).
    if (memoryCols.length > 0) {
      const additions: [string, string][] = [
        ['superseded_at', 'INTEGER'],
        ['superseded_by', 'TEXT'],
        ['prov_supersedes', 'TEXT'],
        ['volatility', 'TEXT'],
        ['strength', 'REAL NOT NULL DEFAULT 1'],
      ];
      for (const [name, decl] of additions) {
        if (!memoryCols.some((c) => c.name === name)) {
          this.db.exec(`ALTER TABLE memory_items ADD COLUMN ${name} ${decl}`);
        }
      }
    }
    // The stale-review index, created HERE rather than in the DDL because it names
    // the column added just above — see the note where the other memory_items
    // indexes are declared. IF NOT EXISTS, so it is a no-op on every later open,
    // and unconditional, so a fresh database and an upgraded one end up identical
    // (an upgraded install is the one with the rows that need the index).
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS memory_items_by_access ON memory_items (status, last_injected_at, updated_at)',
    );

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
    // The doomed session-scoped items' observations first, while the rows they
    // point at still exist to be selected.
    this.db
      .prepare(
        `DELETE FROM memory_observations WHERE memory_id IN
           (SELECT id FROM memory_items WHERE scope = 'session' AND scope_key = ?)`,
      )
      .run(sessionId);
    this.db
      .prepare("DELETE FROM memory_items WHERE scope = 'session' AND scope_key = ?")
      .run(sessionId);
    // CORROBORATION CASCADE (P3-M8b §5.3): this session's vote on every SURVIVING
    // memory item goes too — a citation into a transcript that no longer exists
    // cannot be checked, so it may not keep counting as evidence. The item itself
    // is untouched: a user-scope fact keeps its value and its status, and an
    // already-confirmed row never reverts because its evidence shrank.
    this.db.prepare('DELETE FROM memory_observations WHERE session_id = ?').run(sessionId);
    this.db.prepare('DELETE FROM usage WHERE session_id = ?').run(sessionId);
    // HARNESS CASCADE EXEMPTION (phase-1_6-harness-contracts §2/§6): a session
    // delete NEVER touches harness. Harness has no session scope (a
    // command/skill/subagent is a durable capability, not per-conversation
    // state), so there is deliberately no harness_items delete here.
    //
    // The reflection CURSOR, by contrast, does go (P3-M8a): it is a bookmark into
    // the transcript being deleted, not a record of anything. The eval-event
    // LEDGER still survives (invariant 4) — deleting a chat must not erase what
    // the agent proved.
    this.db.prepare('DELETE FROM reflection_state WHERE session_id = ?').run(sessionId);
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
    volatility?: MemoryVolatility;
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
             prov_basis = ?, prov_created_from = ?, prov_supersedes = ?,
             volatility = ?, confidence = ?, status = ?,
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
          prov.supersedes ?? null,
          fields.volatility ?? null,
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
              prov_supersedes, volatility,
              confidence, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          prov.supersedes ?? null,
          fields.volatility ?? null,
          fields.confidence,
          fields.status,
          createdAt,
          now,
        );
    }

    // Re-read rather than reconstruct. The row now carries columns this method
    // never writes (`last_injected_at`, `superseded_at`, `strength`), and a
    // hand-built return value is exactly how the in-memory twin once dropped the
    // access stamp on an upsert — one field forgotten, two drivers disagreeing.
    const saved = this.db
      .prepare('SELECT * FROM memory_items WHERE id = ?')
      .get(id) as MemoryRow | undefined;
    if (saved) return toMemoryItem(saved);

    const provenance: MemoryProvenance = { source: prov.source };
    if (prov.sessionId !== undefined) provenance.sessionId = prov.sessionId;
    if (prov.basis !== undefined) provenance.basis = prov.basis;
    if (prov.createdFrom !== undefined) provenance.createdFrom = prov.createdFrom;
    if (prov.supersedes !== undefined) provenance.supersedes = prov.supersedes;
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
      ...(fields.volatility ? { volatility: fields.volatility } : {}),
      strength: 1,
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
      //
      // It is also the single most interesting thing this method does, from a
      // debugging seat: the agent tried to learn something and the memory gate
      // refused. Logged before the throw so the record exists even though the
      // caller is about to unwind.
      logActivity('memory_write', {
        scope: req.scope,
        scopeKey: req.scopeKey,
        key: req.key,
        decision: 'deny',
        reason: decision.reason,
        ...(req.provenance.sessionId ? { sessionId: req.provenance.sessionId } : {}),
      });
      throw new Error(`memory write denied: ${decision.reason}`);
    }
    const valueChanged = existingRow ? !sameMemoryValue(existingRow.value, req.value) : false;
    // 'allow' carries the (possibly downgraded) status; 'hold' pins 'proposed'.
    const saved = this.writeMemoryRow({
      scope: req.scope,
      scopeKey: req.scopeKey,
      type: req.type,
      key: req.key,
      value: req.value,
      provenance: req.provenance,
      confidence: req.confidence,
      status: decision.status,
      ...(req.volatility ? { volatility: req.volatility } : {}),
    });

    // A SUPERSEDED ROW THAT IS RE-CLAIMED COMES BACK (P3-M13a §3.1). Only when
    // the value MATERIALLY changed, and the asymmetry is the point: what was
    // retired is a CLAIM, not a key. Re-stating the retired sentence verbatim
    // must leave it retired (otherwise a stray re-extraction would undo the
    // user's history), while writing a genuinely different sentence at that key
    // is a new claim — and a new claim that could never inject, because a stamp
    // about its predecessor still sat on the row, would be an invisible memory
    // nobody could explain. The rule is the same `sameMemoryValue` test
    // corroboration already turns on, so the two cannot drift apart.
    if (existingRow && valueChanged && existingRow.superseded_at != null) {
      this.db
        .prepare(
          'UPDATE memory_items SET superseded_at = NULL, superseded_by = NULL WHERE id = ?',
        )
        .run(saved.id);
      delete saved.supersededAt;
      delete saved.supersededBy;
    }

    // CORROBORATION (P3-M8b, §5.3). Recorded HERE rather than by the caller so a
    // write through the reflection pass and a write through `naby_remember` land
    // in the same pool, and neither can forget to. Both an 'allow' and a 'hold'
    // count: a held row still IS this session asserting the fact.
    //
    // P3-M13a: NOT for a row that is still superseded. Corroboration exists to
    // decide whether a proposal is worth confirming, and confirming a memory
    // that has already been replaced would promote the agent's OLD belief on the
    // strength of evidence for a sentence nobody is injecting.
    if (req.provenance.sessionId && saved.supersededAt === undefined) {
      this.recordMemoryObservation(
        saved.id,
        req.provenance.sessionId,
        valueChanged,
        req.provenance.createdFrom,
      );
    }
    // WHAT THE AGENT LEARNED, AND ON WHOSE SAY-SO. `status` distinguishes a
    // proposal from a confirmed write, `valueChanged` says whether this replaced
    // a claim or merely restated one.
    logActivity('memory_write', {
      id: saved.id,
      scope: req.scope,
      scopeKey: req.scopeKey,
      type: req.type,
      key: req.key,
      value: req.value,
      status: saved.status,
      decision: decision.behavior,
      valueChanged,
      createdFrom: req.provenance.createdFrom,
      ...(req.provenance.sessionId ? { sessionId: req.provenance.sessionId } : {}),
    });
    return saved;
  }

  supersedeMemory(oldId: string, newId: string, at: number = Date.now()): boolean {
    this.assertOpen();
    if (!oldId || !newId || oldId === newId) return false;
    const older = this.db
      .prepare('SELECT * FROM memory_items WHERE id = ?')
      .get(oldId) as MemoryRow | undefined;
    if (!older || older.superseded_at != null) return false;
    const newer = this.db
      .prepare('SELECT * FROM memory_items WHERE id = ?')
      .get(newId) as MemoryRow | undefined;
    if (!newer) return false;
    // THE VOLATILITY GUARD (§3.1). A `transient` fact never retires a `stable`
    // (or untagged) one — "in Berlin this week" must not erase "lives in
    // Lisbon". Asked here rather than at the call site because it has to hold
    // however the reservation was made.
    if (newer.volatility === 'transient' && older.volatility !== 'transient') return false;
    this.db
      .prepare('UPDATE memory_items SET superseded_at = ?, superseded_by = ? WHERE id = ?')
      .run(Math.trunc(at), newId, oldId);
    logActivity('memory_superseded', { oldId, newId, key: older.key, scope: older.scope });
    return true;
  }

  revertSupersession(id: string, at: number = Date.now()): boolean {
    this.assertOpen();
    const now = Math.trunc(at);
    const row = this.db
      .prepare('SELECT * FROM memory_items WHERE id = ?')
      .get(id) as MemoryRow | undefined;
    if (!row || row.superseded_at == null) return false;
    // ACCESS IS STAMPED TOO, for the reason `confirmMemory` stamps it: a person
    // just read this row and said it is the one they want. Without it a memory
    // rescued from supersession would immediately look like something nothing
    // had touched in months.
    this.db
      .prepare(
        `UPDATE memory_items
            SET superseded_at = NULL, superseded_by = NULL, last_injected_at = ?
          WHERE id = ?`,
      )
      .run(now, id);
    return true;
  }

  /**
   * Upsert one session's observation of a memory item, clearing the item's other
   * observations first when the value MATERIALLY changed.
   *
   * WHY THE CLEAR IS THE IMPORTANT HALF. Without it, "three sessions corroborate
   * this" would survive the fact being rewritten into something the other two
   * sessions never said — a count of agreement with a claim nobody agreed to.
   * Wiping on a real change makes the number mean exactly one thing, always:
   * distinct sessions that agree with the value stored RIGHT NOW. It is also why
   * the spec needs no separate "and nothing contradicted it" test (§5.3).
   */
  private recordMemoryObservation(
    memoryId: string,
    sessionId: string,
    valueChanged: boolean,
    createdFrom?: string,
    at?: number,
  ): void {
    if (valueChanged) {
      this.db.prepare('DELETE FROM memory_observations WHERE memory_id = ?').run(memoryId);
    }
    this.db
      .prepare(
        `INSERT INTO memory_observations (memory_id, session_id, observed_at, created_from)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(memory_id, session_id) DO UPDATE SET
           observed_at = excluded.observed_at,
           created_from = excluded.created_from`,
      )
      .run(memoryId, sessionId, Math.trunc(at ?? Date.now()), createdFrom ?? null);
  }

  getMemoryById(id: string): MemoryItem | undefined {
    this.assertOpen();
    const row = this.db
      .prepare('SELECT * FROM memory_items WHERE id = ?')
      .get(id) as MemoryRow | undefined;
    return row ? toMemoryItem(row) : undefined;
  }

  corroborateMemory(
    id: string,
    sessionId: string,
    opts?: { createdFrom?: string; at?: number },
  ): boolean {
    this.assertOpen();
    if (!id || !sessionId) return false;
    const row = this.db
      .prepare('SELECT id, superseded_at FROM memory_items WHERE id = ?')
      .get(id) as { id: string; superseded_at?: number | null } | undefined;
    if (!row || row.superseded_at != null) return false;
    // `valueChanged: false` — the whole point of this method is that nothing
    // changed, so the existing evidence is kept and this session is added to it.
    this.recordMemoryObservation(id, sessionId, false, opts?.createdFrom, opts?.at);
    return true;
  }

  getMemoryCorroboration(memoryIds: readonly string[]): Record<string, number> {
    this.assertOpen();
    const out: Record<string, number> = {};
    if (memoryIds.length === 0) return out;
    // ONE query, not one per id: the review panel asks about every row it just
    // listed, and a per-id round trip would turn a page render into N statements.
    const placeholders = memoryIds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT memory_id, COUNT(DISTINCT session_id) AS n
           FROM memory_observations
          WHERE memory_id IN (${placeholders})
          GROUP BY memory_id`,
      )
      .all(...memoryIds) as { memory_id: string; n: number }[];
    for (const row of rows) out[row.memory_id] = Number(row.n);
    return out;
  }

  listCorroboratedProposed(threshold: number): MemoryItem[] {
    this.assertOpen();
    const min = Math.max(1, Math.trunc(threshold));
    const rows = this.db
      .prepare(
        `SELECT m.*, COUNT(DISTINCT o.session_id) AS n
           FROM memory_items m
           JOIN memory_observations o ON o.memory_id = m.id
          WHERE m.status = 'proposed' AND m.superseded_at IS NULL
          GROUP BY m.id
         HAVING n >= ?
          ORDER BY n DESC, m.updated_at DESC`,
      )
      .all(min) as (MemoryRow & { n: number })[];
    return rows.map(toMemoryItem);
  }

  getScopedMemory(
    scope: MemoryScope,
    scopeKey: string,
    opts?: ScopedMemoryQuery,
  ): MemoryItem[] {
    this.assertOpen();
    const filter = scopedMemoryFilter(scope, scopeKey, opts);
    // LIMIT/OFFSET only when a page was ASKED for. A bare `LIMIT -1` would work
    // in SQLite but would put a window clause on the injection path's read, and
    // "the query is literally the one it always was" is a cheaper thing to
    // verify than "the window happens to be unbounded".
    const limit = typeof opts?.limit === 'number' ? Math.max(0, Math.trunc(opts.limit)) : undefined;
    const offset =
      typeof opts?.offset === 'number' ? Math.max(0, Math.trunc(opts.offset)) : 0;
    const window = limit === undefined ? '' : ` LIMIT ${limit} OFFSET ${offset}`;
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_items WHERE ${filter.sql} ORDER BY created_at ASC${window}`,
      )
      .all(...filter.params) as MemoryRow[];
    return rows.map(toMemoryItem);
  }

  countScopedMemory(
    scope: MemoryScope,
    scopeKey: string,
    opts?: Omit<ScopedMemoryQuery, 'limit' | 'offset'>,
  ): number {
    this.assertOpen();
    const filter = scopedMemoryFilter(scope, scopeKey, opts);
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM memory_items WHERE ${filter.sql}`)
      .get(...filter.params) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  }

  listStaleConfirmedMemory(
    before: number,
    opts?: { limit?: number; windowMs?: number },
  ): MemoryItem[] {
    this.assertOpen();
    // OLDEST ACCESS FIRST: the review queue should open on the memory that has
    // been ignored longest, which is the one most likely to be genuinely dead.
    const limit =
      typeof opts?.limit === 'number' ? ` LIMIT ${Math.max(0, Math.trunc(opts.limit))}` : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_items
          WHERE status = 'confirmed' AND ${staleSql()}
          ORDER BY COALESCE(last_injected_at, updated_at) ASC${limit}`,
      )
      .all(Math.trunc(before), Math.max(0, Math.trunc(opts?.windowMs ?? 0))) as MemoryRow[];
    return rows.map(toMemoryItem);
  }

  confirmMemory(id: string): void {
    this.assertOpen();
    // The ONLY path external-origin memory becomes confirmed (§4 invariant 1).
    // No-op if already confirmed or absent.
    //
    // P3-M10: the same statement stamps ACCESS. A person just looked at this row
    // and said yes to it — recording that in a second UPDATE would be two writes
    // for one act, and one of them could fail alone.
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE memory_items SET status = 'confirmed', updated_at = ?, last_injected_at = ?
          WHERE id = ? AND status = 'proposed'`,
      )
      .run(now, now, id);
    // The one act that turns a proposal into something that will shape future
    // turns. Logged unconditionally — a confirm of an already-confirmed row is a
    // no-op in SQL, and knowing it was attempted is worth a line.
    logActivity('memory_confirmed', { id });
  }

  updateMemoryValue(id: string, value: string, at: number = Date.now()): MemoryItem | undefined {
    this.assertOpen();
    const existing = this.db
      .prepare('SELECT * FROM memory_items WHERE id = ?')
      .get(id) as MemoryRow | undefined;
    if (!existing) return undefined;
    const now = Math.trunc(at);
    // The SAME "is this the same claim" test putMemory applies (P3-M8b §5.3),
    // asked BEFORE the write while the old value is still readable.
    const changed = !sameMemoryValue(existing.value, value);
    this.db
      .prepare(
        `UPDATE memory_items
            SET value = ?, prov_source = 'user', updated_at = ?, last_injected_at = ?
          WHERE id = ?`,
      )
      .run(value, now, now, id);
    // A materially different value is a NEW claim, so the sessions that agreed
    // with the OLD one no longer agree with anything — the identical rule, and
    // the identical statement, as `recordMemoryObservation`'s clear. A pure
    // whitespace/format fix keeps the evidence, because it is the same claim.
    if (changed) {
      this.db.prepare('DELETE FROM memory_observations WHERE memory_id = ?').run(id);
    }
    // BOTH VALUES. An edit is the one memory event whose "before" is otherwise
    // unrecoverable — the row now holds only the "after".
    logActivity('memory_updated', {
      id,
      key: existing.key,
      previousValue: existing.value,
      value,
      changed,
    });
    const row = this.db
      .prepare('SELECT * FROM memory_items WHERE id = ?')
      .get(id) as MemoryRow | undefined;
    return row ? toMemoryItem(row) : undefined;
  }

  markMemoriesInjected(ids: readonly string[], at: number = Date.now()): void {
    this.assertOpen();
    // NOTHING AT ALL for an empty list — not even a prepared statement. This runs
    // on every turn, and a turn that injected no memory must leave the database
    // untouched (contract §5's no-op invariant, extended to writes).
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(', ');
    // P3-M13b (§3.2): SELECTION IS REHEARSAL. The same statement that records
    // WHEN a memory was used also raises HOW STRONGLY it is held, capped at
    // STRENGTH_CAP so nothing becomes immortal — the MemoryBank model, where a
    // recalled item decays more slowly next time rather than being pinned.
    //
    // ONE UPDATE, not a read-modify-write: `MIN(strength + 1, cap)` in SQL keeps
    // this a single statement on the hot injection path and makes the cap
    // impossible to race past.
    this.db
      .prepare(
        `UPDATE memory_items
            SET last_injected_at = ?, strength = MIN(COALESCE(strength, 1) + 1, ${STRENGTH_CAP})
          WHERE id IN (${placeholders})`,
      )
      .run(Math.trunc(at), ...ids);
  }

  deleteMemory(sel: MemoryDeleteSelector): void {
    this.assertOpen();
    // A DELETION IS THE ONE EVENT THE DATABASE CANNOT TESTIFY ABOUT AFTERWARDS.
    // The selector is logged (not the rows): a source-wide rollback can be tens of
    // thousands of rows, and the selector is what actually explains the event.
    logActivity('memory_deleted', { ...sel });
    // The observations go with the items (P3-M8b §5.3). Deleted through the same
    // WHERE clause rather than by collecting ids first, so a rollback of ten
    // thousand poisoned rows stays two statements.
    if ('id' in sel) {
      this.db.prepare('DELETE FROM memory_observations WHERE memory_id = ?').run(sel.id);
      this.db.prepare('DELETE FROM memory_items WHERE id = ?').run(sel.id);
      return;
    }
    // delete-by-source (poisoning rollback): drop every row from one trust tier,
    // optionally narrowed to the session it was learned in.
    const source: TrustTier = sel.source;
    if (sel.sessionId !== undefined) {
      this.db
        .prepare(
          `DELETE FROM memory_observations WHERE memory_id IN
             (SELECT id FROM memory_items WHERE prov_source = ? AND prov_session_id = ?)`,
        )
        .run(source, sel.sessionId);
      this.db
        .prepare(
          'DELETE FROM memory_items WHERE prov_source = ? AND prov_session_id = ?',
        )
        .run(source, sel.sessionId);
    } else {
      this.db
        .prepare(
          `DELETE FROM memory_observations WHERE memory_id IN
             (SELECT id FROM memory_items WHERE prov_source = ?)`,
        )
        .run(source);
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

  // -- owned harness (Phase 1.6 HP-01) -------------------------------------

  /** Find one harness row by its upsert identity (scope, scopeKey, kind, name). */
  private findHarnessRow(
    scope: HarnessScope,
    scopeKey: string,
    kind: HarnessKind,
    name: string,
  ): HarnessItem | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM harness_items WHERE scope = ? AND scope_key = ? AND kind = ? AND name = ?',
      )
      .get(scope, scopeKey, kind, name) as HarnessRow | undefined;
    return row ? toHarnessItem(row) : undefined;
  }

  /** The shared upsert by (scope, scopeKey, kind, name). Preserves id/createdAt
   * on update and bumps updatedAt. Does NOT gate — callers that must gate
   * (putHarnessItem) decide first and pass the resolved status. */
  private writeHarnessRow(fields: {
    scope: HarnessScope;
    scopeKey: string;
    kind: HarnessKind;
    name: string;
    description?: string;
    status: HarnessStatus;
    provenance: HarnessProvenance;
    command?: HarnessItem['command'];
    skill?: HarnessItem['skill'];
    subagent?: HarnessItem['subagent'];
  }): HarnessItem {
    const now = Date.now();
    const existing = this.db
      .prepare(
        'SELECT * FROM harness_items WHERE scope = ? AND scope_key = ? AND kind = ? AND name = ?',
      )
      .get(fields.scope, fields.scopeKey, fields.kind, fields.name) as
      | HarnessRow
      | undefined;

    const id = existing ? existing.id : mintHarnessId();
    const createdAt = existing ? Number(existing.created_at) : now;
    const prov = fields.provenance;
    const payloadJson = JSON.stringify(harnessPayloadOf(fields));

    if (existing) {
      this.db
        .prepare(
          `UPDATE harness_items SET
             description = ?, status = ?, prov_source = ?, prov_origin = ?,
             prov_format = ?, prov_imported_at = ?, payload = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          fields.description ?? null,
          fields.status,
          prov.source,
          prov.origin ?? null,
          prov.format ?? null,
          prov.importedAt ?? null,
          payloadJson,
          now,
          id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO harness_items
             (id, scope, scope_key, kind, name, description, status,
              prov_source, prov_origin, prov_format, prov_imported_at,
              payload, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          fields.scope,
          fields.scopeKey,
          fields.kind,
          fields.name,
          fields.description ?? null,
          fields.status,
          prov.source,
          prov.origin ?? null,
          prov.format ?? null,
          prov.importedAt ?? null,
          payloadJson,
          createdAt,
          now,
        );
    }

    const stored = this.db
      .prepare('SELECT * FROM harness_items WHERE id = ?')
      .get(id) as HarnessRow;
    return toHarnessItem(stored);
  }

  putHarnessItem(req: HarnessImportRequest): HarnessItem {
    this.assertOpen();
    const existing = this.findHarnessRow(
      req.item.scope,
      req.item.scopeKey,
      req.item.kind,
      req.item.name,
    );
    const decision = decideHarnessImport(req, existing);
    if (decision.behavior === 'deny') {
      // A deny THROWS: an import that violates the trust ordering must be loud,
      // never a silent no-op (the harness twin of memory-poisoning defense).
      logActivity('harness_change', {
        action: 'import',
        decision: 'deny',
        reason: decision.reason,
        kind: req.item.kind,
        name: req.item.name,
        scope: req.item.scope,
        scopeKey: req.item.scopeKey,
      });
      throw new Error(`harness import denied: ${decision.reason}`);
    }
    // WHAT ARRIVED IN THE HARNESS AND IN WHAT STATE. A skill the agent installed
    // during a turn is a capability change, and "when did this thing appear" is
    // the first question about behaviour that changed without a release.
    logActivity('harness_change', {
      action: 'import',
      decision: decision.behavior,
      status: decision.status,
      kind: req.item.kind,
      name: req.item.name,
      scope: req.item.scope,
      scopeKey: req.item.scopeKey,
      origin: req.item.provenance.origin,
      source: req.item.provenance.source,
      replacing: existing?.id,
    });
    // 'allow' carries the (possibly downgraded) status; 'hold' pins 'disabled'.
    return this.writeHarnessRow({
      scope: req.item.scope,
      scopeKey: req.item.scopeKey,
      kind: req.item.kind,
      name: req.item.name,
      ...(req.item.description !== undefined ? { description: req.item.description } : {}),
      status: decision.status,
      provenance: req.item.provenance,
      ...(req.item.command !== undefined ? { command: req.item.command } : {}),
      ...(req.item.skill !== undefined ? { skill: req.item.skill } : {}),
      ...(req.item.subagent !== undefined ? { subagent: req.item.subagent } : {}),
    });
  }

  listHarness(
    scope: HarnessScope,
    scopeKey: string,
    opts?: { kind?: HarnessKind; status?: HarnessStatus },
  ): HarnessItem[] {
    this.assertOpen();
    const clauses = ['scope = ?', 'scope_key = ?'];
    const params: unknown[] = [scope, scopeKey];
    if (opts?.kind) {
      clauses.push('kind = ?');
      params.push(opts.kind);
    }
    if (opts?.status) {
      clauses.push('status = ?');
      params.push(opts.status);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM harness_items WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC`,
      )
      .all(...(params as [])) as HarnessRow[];
    return rows.map(toHarnessItem);
  }

  getHarnessItem(id: string): HarnessItem | undefined {
    this.assertOpen();
    const row = this.db
      .prepare('SELECT * FROM harness_items WHERE id = ?')
      .get(id) as HarnessRow | undefined;
    return row ? toHarnessItem(row) : undefined;
  }

  setHarnessEnabled(id: string, enabled: boolean): void {
    this.assertOpen();
    // The ONLY path an imported (external) item becomes enabled (§4 invariant 1).
    // No-op if absent. An explicit toggle also LEAVES the 'removed' tombstone —
    // that is the restore action (store.ts setHarnessEnabled).
    this.db
      .prepare('UPDATE harness_items SET status = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 'enabled' : 'disabled', Date.now(), id);
    logActivity('harness_change', {
      action: enabled ? 'enable' : 'disable',
      id,
      name: this.getHarnessItem(id)?.name,
    });
  }

  setHarnessStatus(id: string, status: HarnessStatus): void {
    this.assertOpen();
    // The tombstone path. `status` is a TEXT column with no CHECK constraint, so
    // 'removed' needs no migration — an older build reading such a row simply
    // sees a status it never treats as enabled, which is the safe direction.
    this.db
      .prepare('UPDATE harness_items SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, Date.now(), id);
    logActivity('harness_change', { action: 'status', id, status });
  }

  removeHarness(sel: HarnessRemoveSelector): void {
    this.assertOpen();
    logActivity('harness_change', { action: 'remove', ...sel });
    if ('id' in sel) {
      this.db.prepare('DELETE FROM harness_items WHERE id = ?').run(sel.id);
      return;
    }
    // delete-by-origin: roll back a whole imported set.
    this.db.prepare('DELETE FROM harness_items WHERE prov_origin = ?').run(sel.origin);
  }

  exportHarnessSet(
    scope: HarnessScope,
    scopeKey: string,
    opts?: { name: string; version: string; ids?: string[] },
  ): HarnessSet {
    this.assertOpen();
    // Export only ENABLED items (contract §5/§6), optionally a subset by id.
    let items = this.listHarness(scope, scopeKey, { status: 'enabled' });
    if (opts?.ids) {
      const wanted = new Set(opts.ids);
      items = items.filter((it) => wanted.has(it.id));
    }
    return buildHarnessSet(items, opts);
  }

  importHarnessSet(
    set: HarnessSet,
    into: { scope: HarnessScope; scopeKey: string },
    opts?: { ids?: string[] },
  ): HarnessItem[] {
    this.assertOpen();
    return mergeHarnessSet(set, into, opts, {
      find: (s, k, kind, name) => this.findHarnessRow(s, k, kind, name),
      put: (req) => this.putHarnessItem(req),
    });
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
    // A settings row is a CONFIGURATION CHANGE — the answer to "it worked
    // yesterday" often enough to be worth a line each.
    //
    // THE VALUE IS PASSED THROUGH THE MASKER BY KEY NAME (`value` under a key
    // like `telegram.botToken`). The masker keys on the FIELD name, and the field
    // here is always literally `value`, so the setting's own key is what has to be
    // consulted: this is the one call site that has to do the masking itself.
    logActivity('setting_change', {
      key,
      value: /token|secret|password|apikey|api_key|credential/i.test(key)
        ? '[redacted]'
        : value,
    });
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

  // -- tool-execution policy (Phase 2, M1) ---------------------------------

  listPolicyRules(scope: HarnessScope, scopeKey: string): PolicyRule[] {
    this.assertOpen();
    const rows = this.db
      .prepare(
        `SELECT * FROM policy_rules WHERE scope = ? AND scope_key = ? ORDER BY created_at ASC`,
      )
      .all(scope, scopeKey) as PolicyRow[];
    return rows.map(toPolicyRule);
  }

  putPolicyRule(rule: PolicyRuleInput): PolicyRule {
    this.assertOpen();
    const now = Date.now();
    const existing = this.db
      .prepare(
        `SELECT * FROM policy_rules WHERE scope = ? AND scope_key = ? AND tool_pattern = ?`,
      )
      .get(rule.scope, rule.scopeKey, rule.toolPattern) as PolicyRow | undefined;
    const id = existing ? existing.id : mintPolicyId();
    this.db
      .prepare(
        `INSERT INTO policy_rules (id, scope, scope_key, tool_pattern, effect, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (scope, scope_key, tool_pattern)
         DO UPDATE SET effect = excluded.effect, updated_at = excluded.updated_at`,
      )
      .run(
        id,
        rule.scope,
        rule.scopeKey,
        rule.toolPattern,
        rule.effect,
        existing ? Number(existing.created_at) : now,
        now,
      );
    const row = this.db
      .prepare(`SELECT * FROM policy_rules WHERE id = ?`)
      .get(id) as PolicyRow;
    return toPolicyRule(row);
  }

  removePolicyRule(id: string): void {
    this.assertOpen();
    this.db.prepare(`DELETE FROM policy_rules WHERE id = ?`).run(id);
  }

  // -- naby agents (Phase 3, P3-M1) ----------------------------------------

  listAgents(): Agent[] {
    this.assertOpen();
    // Built-in persona first (kind='persona' sorts before 'custom'), then oldest
    // first within a kind.
    const rows = this.db
      .prepare(
        `SELECT * FROM agents
         ORDER BY CASE kind WHEN 'persona' THEN 0 ELSE 1 END ASC, created_at ASC`,
      )
      .all() as AgentRow[];
    return rows.map(toAgent);
  }

  getAgent(id: string): Agent | undefined {
    this.assertOpen();
    const row = this.db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as
      | AgentRow
      | undefined;
    return row ? toAgent(row) : undefined;
  }

  getAgentByName(name: string): Agent | undefined {
    this.assertOpen();
    const row = this.db.prepare(`SELECT * FROM agents WHERE name = ?`).get(name) as
      | AgentRow
      | undefined;
    return row ? toAgent(row) : undefined;
  }

  putAgent(input: AgentInput): Agent {
    return this.writeAgent(input, { allowPersona: false });
  }

  restoreBuiltinPersona(input: AgentInput): Agent {
    if (input.kind !== 'persona') {
      throw new Error('restoreBuiltinPersona only writes a kind=persona row');
    }
    return this.writeAgent(input, { allowPersona: true });
  }

  /** The single agent write. `allowPersona` is the ONE door to a kind='persona'
   *  row, and only `restoreBuiltinPersona` opens it — see the Store interface for
   *  why the built-in persona is not editable. */
  private writeAgent(input: AgentInput, opts: { allowPersona: boolean }): Agent {
    this.assertOpen();
    const now = Date.now();
    const existing = input.id
      ? (this.db.prepare(`SELECT * FROM agents WHERE id = ?`).get(input.id) as
          | AgentRow
          | undefined)
      : undefined;
    if (!opts.allowPersona) {
      // Two ways to touch the built-in, both refused: editing the row that IS the
      // persona, and minting a second one. Checked on the STORED kind, not on the
      // id, so a renamed or hand-migrated persona is still protected.
      if (existing?.kind === 'persona') {
        throw new Error('the built-in persona is read-only and cannot be edited');
      }
      if (input.kind === 'persona') {
        throw new Error('the built-in persona is the only kind=persona agent and it is created by naby');
      }
    }
    // Names are the @-routing handle and must be unique. Reject a name already
    // held by a DIFFERENT agent (same-row rename is fine).
    const nameHolder = this.db
      .prepare(`SELECT id FROM agents WHERE name = ?`)
      .get(input.name) as { id: string } | undefined;
    if (nameHolder && nameHolder.id !== (existing?.id ?? '')) {
      throw new Error(`agent name '${input.name}' is already in use`);
    }
    const id = existing ? existing.id : input.id ?? mintAgentId();
    this.db
      .prepare(
        `INSERT INTO agents
           (id, name, kind, description, system_prompt, model, tool_refs, memory_scope, autonomy, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name,
           kind = excluded.kind,
           description = excluded.description,
           system_prompt = excluded.system_prompt,
           model = excluded.model,
           tool_refs = excluded.tool_refs,
           memory_scope = excluded.memory_scope,
           autonomy = excluded.autonomy,
           updated_at = excluded.updated_at`,
      )
      .run(
        id,
        input.name,
        input.kind,
        input.description ?? null,
        input.systemPrompt,
        input.model ?? null,
        input.toolRefs ? JSON.stringify(input.toolRefs) : null,
        input.memoryScope,
        JSON.stringify(input.autonomy),
        existing ? Number(existing.created_at) : now,
        now,
      );
    const row = this.db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as AgentRow;
    return toAgent(row);
  }

  removeAgent(id: string): void {
    this.assertOpen();
    // The built-in persona (kind='persona') is UNDELETABLE (spec §4) — no-op it.
    const row = this.db.prepare(`SELECT kind FROM agents WHERE id = ?`).get(id) as
      | { kind: string }
      | undefined;
    if (!row || row.kind === 'persona') return;
    this.db.prepare(`DELETE FROM agents WHERE id = ?`).run(id);
  }

  // -- eval-event ledger (Phase 3 P3-M5, realizing P15-03) ------------------
  //
  // The kind-specific fields ride in a JSON `payload` column rather than twenty
  // sparse columns: only the meter's hot filters (agent, time, kind, task type)
  // need to be queryable, and a JSON blob means a later F2-04 observation kind
  // adds no migration. Same trick the harness rows use for their kind payload.

  appendEvalEvent(event: EvalEventInput): EvalEvent {
    this.assertOpen();
    const { id, at, kind, agentId, sessionId, taskType, domain, excludedFromScoring, ...rest } =
      event;
    const row: EvalEvent = {
      ...event,
      id: id ?? mintEvalEventId(),
      at: at ?? Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO eval_events (id, kind, at, agent_id, session_id, task_type, domain, payload, excluded)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        kind,
        row.at,
        agentId,
        sessionId,
        taskType ?? null,
        domain ?? null,
        JSON.stringify(rest),
        excludedFromScoring ? 1 : 0,
      );
    // THE GROWTH LEDGER, IN THE LOG. Every kind lands here — a scored check-in
    // (question, options, recommended, chosen, hit, drill), an `autonomous` row
    // for a consequential call the agent made without asking, a `tripwire` for one
    // the gate refused — so this single hook covers all three rather than three
    // hooks in the shell that could each be forgotten. Logged AFTER the insert, so
    // a line in the file means a row in the database.
    logActivity('ledger_event', {
      id: row.id,
      at: row.at,
      ledgerKind: kind,
      agentId,
      sessionId,
      ...(taskType !== undefined ? { taskType } : {}),
      ...(domain !== undefined ? { domain } : {}),
      ...(excludedFromScoring ? { excludedFromScoring: true } : {}),
      ...rest,
    });
    return row;
  }

  listEvalEvents(
    agentId: string,
    opts?: { kind?: EvalEventKind; taskType?: string; sessionId?: string; limit?: number },
  ): EvalEvent[] {
    this.assertOpen();
    const where: string[] = ['agent_id = ?'];
    const args: unknown[] = [agentId];
    if (opts?.kind) {
      where.push('kind = ?');
      args.push(opts.kind);
    }
    if (opts?.taskType) {
      where.push('task_type = ?');
      args.push(opts.taskType);
    }
    // One conversation's rows — what the reflection pass reads (P3-M8a). The
    // eval_events_by_session index already exists for it.
    if (opts?.sessionId) {
      where.push('session_id = ?');
      args.push(opts.sessionId);
    }
    // Newest-first in SQL so `limit` takes the most RECENT rows, then reversed so
    // the caller gets oldest-first (what windowing and change detection expect).
    const limit = opts?.limit != null ? ` LIMIT ${Math.max(0, Math.floor(opts.limit))}` : '';
    const rows = this.db
      .prepare(
        `SELECT id, kind, at, agent_id, session_id, task_type, domain, payload, excluded
           FROM eval_events WHERE ${where.join(' AND ')} ORDER BY at DESC, id DESC${limit}`,
      )
      .all(...(args as never[])) as Array<{
      id: string;
      kind: string;
      at: number;
      agent_id: string;
      session_id: string;
      task_type: string | null;
      domain: string | null;
      payload: string;
      excluded: number;
    }>;
    return rows.reverse().map((r) => {
      let payload: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(r.payload) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          payload = parsed as Record<string, unknown>;
        }
      } catch {
        /* a corrupt payload must not break the meter — treat it as an empty row */
      }
      return {
        ...payload,
        id: r.id,
        kind: r.kind as EvalEventKind,
        at: Number(r.at),
        agentId: r.agent_id,
        sessionId: r.session_id,
        ...(r.task_type != null ? { taskType: r.task_type } : {}),
        ...(r.domain != null ? { domain: r.domain } : {}),
        ...(r.excluded ? { excludedFromScoring: true } : {}),
      } as EvalEvent;
    });
  }

  /**
   * The ledger's ONE permitted after-the-fact edit (checkin-contracts invariant
   * 8): mark an `autonomous` row as having been corrected by the user afterwards.
   *
   * The `kind` is re-read from the row rather than trusted from the caller, so a
   * check-in's stored `hit` can never be reached through this door — the flag that
   * decides accuracy stays fixed at record time (invariant 1). Everything else in
   * the payload is preserved: only `correctedAfter` is added.
   */
  markEvalEventCorrected(id: string): boolean {
    this.assertOpen();
    const row = this.db.prepare('SELECT kind, payload FROM eval_events WHERE id = ?').get(id) as
      | { kind: string; payload: string }
      | undefined;
    if (!row || row.kind !== 'autonomous') return false;
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.payload) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      /* a corrupt payload is rewritten as just the flag rather than blocking it */
    }
    if (payload.correctedAfter === true) return true; // idempotent: already recorded
    payload.correctedAfter = true;
    this.db
      .prepare('UPDATE eval_events SET payload = ? WHERE id = ?')
      .run(JSON.stringify(payload), id);
    return true;
  }

  /**
   * The ledger's SECOND permitted after-the-fact edit (checkin-contracts 0.5.0
   * invariant 8, P3-M8d): record WHEN the reflection pass put this autonomous
   * action before its judge.
   *
   * FIRST WRITE WINS. A row already carrying `reviewedAt` is left exactly as it
   * is and reported as marked, so a re-sweep cannot move an old action's review
   * time forward into the current window. Same narrowness as the corrected
   * marker: the `kind` is re-read from the row, and nothing else in the payload
   * is touched.
   */
  markEvalEventReviewed(id: string, reviewedAt: number): boolean {
    this.assertOpen();
    const row = this.db.prepare('SELECT kind, payload FROM eval_events WHERE id = ?').get(id) as
      | { kind: string; payload: string }
      | undefined;
    if (!row || row.kind !== 'autonomous') return false;
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.payload) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      /* a corrupt payload is rewritten as just the stamp rather than blocking it */
    }
    if (typeof payload.reviewedAt === 'number') return true; // the first review stands
    payload.reviewedAt = Math.trunc(reviewedAt);
    this.db
      .prepare('UPDATE eval_events SET payload = ? WHERE id = ?')
      .run(JSON.stringify(payload), id);
    return true;
  }

  deleteEvalEvents(selector: EvalEventDeleteSelector): void {
    this.assertOpen();
    if ('agentId' in selector) {
      this.db.prepare(`DELETE FROM eval_events WHERE agent_id = ?`).run(selector.agentId);
    } else {
      this.db.prepare(`DELETE FROM eval_events WHERE session_id = ?`).run(selector.sessionId);
    }
  }

  // -- reflection cursor (Phase 3 P3-M8a) -----------------------------------

  getReflectionCursor(sessionId: string): ReflectionCursor | undefined {
    this.assertOpen();
    const row = this.db
      .prepare('SELECT last_seq, reflected_at FROM reflection_state WHERE session_id = ?')
      .get(sessionId) as { last_seq: number; reflected_at: number } | undefined;
    return row ? { lastSeq: Number(row.last_seq), reflectedAt: Number(row.reflected_at) } : undefined;
  }

  setReflectionCursor(sessionId: string, lastSeq: number, reflectedAt: number): void {
    this.assertOpen();
    this.db
      .prepare(
        `INSERT INTO reflection_state (session_id, last_seq, reflected_at) VALUES (?, ?, ?)
         ON CONFLICT (session_id) DO UPDATE SET last_seq = excluded.last_seq,
                                                reflected_at = excluded.reflected_at`,
      )
      .run(sessionId, Math.trunc(lastSeq), Math.trunc(reflectedAt));
  }

  /** The newest reflection across every cursor; undefined before the first one
   *  (P3-M8c §6.3). MAX() over an empty table returns a row holding NULL, which
   *  is why the null is checked rather than the row. */
  getLatestReflectionAt(): number | undefined {
    this.assertOpen();
    const row = this.db
      .prepare('SELECT MAX(reflected_at) AS latest FROM reflection_state')
      .get() as { latest: number | null } | undefined;
    return row?.latest == null ? undefined : Number(row.latest);
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
          .prepare(
            `DELETE FROM memory_observations WHERE memory_id IN
               (SELECT id FROM memory_items WHERE scope = 'session' AND scope_key = ?)`,
          )
          .run(session_id);
        this.db
          .prepare("DELETE FROM memory_items WHERE scope = 'session' AND scope_key = ?")
          .run(session_id);
        // This session's vote on every surviving item goes too (P3-M8b §5.3) —
        // same reasoning as in deleteSession.
        this.db.prepare('DELETE FROM memory_observations WHERE session_id = ?').run(session_id);
        this.db.prepare('DELETE FROM usage WHERE session_id = ?').run(session_id);
        // The reflection cursor follows its transcript out (P3-M8a) — same
        // reasoning as in deleteSession.
        this.db.prepare('DELETE FROM reflection_state WHERE session_id = ?').run(session_id);
      }
      // The project's OWN scope='project' memory (scopeKey = cwd) goes with it.
      // user/org memory is NOT project-owned and MUST survive — it is never
      // touched here (phase-1_5-memory-contracts §2/§6).
      this.db
        .prepare(
          `DELETE FROM memory_observations WHERE memory_id IN
             (SELECT id FROM memory_items WHERE scope = 'project' AND scope_key = ?)`,
        )
        .run(cwd);
      this.db
        .prepare("DELETE FROM memory_items WHERE scope = 'project' AND scope_key = ?")
        .run(cwd);
      // HARNESS CASCADE EXEMPTION (phase-1_6-harness-contracts §2/§6): the
      // project's OWN scope='project' harness (scopeKey = cwd) goes with it;
      // user/org harness is NOT project-owned and MUST survive. Harness has no
      // session scope, so a doomed session carries none.
      this.db
        .prepare("DELETE FROM harness_items WHERE scope = 'project' AND scope_key = ?")
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

  /**
   * Pin or unpin, STAMPING WHEN. The timestamp is what orders the pinned tabs
   * (earliest first); unpinning clears it so a re-pin goes to the end rather
   * than reclaiming its old position.
   *
   * Re-pinning an already-pinned session does NOT restamp — the call is
   * idempotent, so a client that re-sends its full pinned set (which
   * /api/pinned-sessions does on every change) cannot silently reshuffle the
   * order it is trying to preserve.
   */
  setSessionPinned(sessionId: string, pinned: boolean, at: number = Date.now()): void {
    this.assertOpen();
    if (!pinned) {
      this.db
        .prepare('UPDATE sessions SET pinned = 0, pinned_at = NULL WHERE session_id = ?')
        .run(sessionId);
      return;
    }
    this.db
      .prepare(
        `UPDATE sessions
            SET pinned = 1,
                pinned_at = COALESCE(pinned_at, ?)
          WHERE session_id = ?`,
      )
      .run(at, sessionId);
  }

  listPinnedSessions(): SessionRef[] {
    this.assertOpen();
    const rows = this.db
      // Pin ORDER, not recency: the tab bar stacks pinned tabs left-to-right in
      // the order they were pinned. Rows pinned before v7 have no stamp and
      // sort last, then by recency among themselves.
      .prepare(
        `SELECT * FROM sessions
          WHERE pinned = 1
          ORDER BY pinned_at IS NULL, pinned_at ASC, last_used_at DESC`,
      )
      .all() as SessionRow[];
    return rows.map(toSessionRef);
  }

  // -- temporary (non-learning) sessions (P3-M10 §3) -----------------------

  setSessionNoLearn(sessionId: string, noLearn: boolean): void {
    this.assertOpen();
    // No-op on a missing session, exactly like setSessionPinned: the UI can only
    // reach this through a tab that has one, and an UPDATE matching no row is the
    // right shape for "there is nothing to mark".
    this.db
      .prepare('UPDATE sessions SET no_learn = ? WHERE session_id = ?')
      .run(noLearn ? 1 : 0, sessionId);
  }

  // -- fast-growth (drill) sessions (P3-M12b §3.3) -------------------------

  setSessionFastGrowth(sessionId: string, fastGrowth: boolean): void {
    this.assertOpen();
    // No-op on a missing session, exactly like the two setters above it.
    this.db
      .prepare('UPDATE sessions SET fast_growth = ? WHERE session_id = ?')
      .run(fastGrowth ? 1 : 0, sessionId);
  }

  // -- continuing in a new tab, and rolling compaction (session-context §2.2/2.3)

  setSessionHandoff(sessionId: string, handoff: string | undefined): void {
    this.assertOpen();
    // No-op on a missing session, exactly like the setters above it.
    this.db
      .prepare('UPDATE sessions SET handoff = ? WHERE session_id = ?')
      .run(handoff && handoff.length > 0 ? handoff : null, sessionId);
  }

  getSessionRollingSummary(sessionId: string): RollingSummary | undefined {
    this.assertOpen();
    const row = this.db
      .prepare(
        'SELECT rolling_summary, rolling_summary_upto FROM sessions WHERE session_id = ?',
      )
      .get(sessionId) as
      | { rolling_summary?: string | null; rolling_summary_upto?: number | null }
      | undefined;
    const text = row?.rolling_summary;
    if (!row || text === null || text === undefined || text === '') return undefined;
    // A summary with no range is not reusable — the range is what says WHICH
    // messages it describes — so it reads as "nothing stored" rather than as a
    // summary that could be applied to the wrong prefix.
    const upto = row.rolling_summary_upto;
    if (upto === null || upto === undefined) return undefined;
    return { text, foldedCount: Number(upto) };
  }

  setSessionRollingSummary(sessionId: string, summary: RollingSummary | undefined): void {
    this.assertOpen();
    this.db
      .prepare(
        'UPDATE sessions SET rolling_summary = ?, rolling_summary_upto = ? WHERE session_id = ?',
      )
      .run(
        summary && summary.text ? summary.text : null,
        summary && summary.text ? summary.foldedCount : null,
        sessionId,
      );
  }

  // -- lifecycle -----------------------------------------------------------

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
