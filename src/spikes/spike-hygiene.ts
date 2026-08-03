// src/spikes/spike-hygiene.ts
//
// Phase 3 (P3-M10) verification: MEMORY HYGIENE + SOVEREIGNTY, at the store and
// runtime layers. Contract: specs/phase-3-memory-hygiene.md §2–§4,
// ref-docs/specs/interface/phase-1_5-memory-contracts.md §5/§6.
//
// WHAT THIS SPIKE IS ACTUALLY GUARDING. M10 adds two columns to a schema that
// eight prior versions have migrated through, a write on the hot injection path,
// and a filter whose predicate is now spelled out in THREE places (a SQL WHERE,
// an in-memory loop, and a pure runtime predicate). Each of those is a place the
// two store drivers can quietly diverge — and a divergence here does not crash
// anything, it just means the app remembers different things depending on which
// driver a code path happened to use. So the load-bearing assertions below are
// cross-driver equalities, not single-driver behaviours.
//
// Asserted:
//   (a) v9 -> v10 MIGRATION IS LOSSLESS on a real database file: a v9 schema with
//       memory, sessions, messages and observations in it gains both columns,
//       keeps every row, stamps the version, and re-opening is a no-op.
//   (b) The migration is SELF-HEALING: a v10-stamped database that is somehow
//       missing a column still gets it (the columns are gated on the column, not
//       on the version number).
//   (c) INJECTION MARKS ACCESS: retrieveForInjection through runTurn stamps
//       `lastInjectedAt` on exactly the rows it selected — and a turn that
//       injected nothing writes nothing at all.
//   (d) CONFIRM and EDIT both stamp access (§2.1 — a person looked at it).
//   (e) EDIT promotes provenance to `user` and RESETS corroboration when the
//       claim changed — and KEEPS it when only whitespace changed (the M8b
//       `sameMemoryValue` rule, reused rather than re-implemented).
//   (f) The STALE derivation agrees across both drivers AND with the pure
//       `isStaleForReview` predicate, including the pre-v10 fallback (a row with
//       no `lastInjectedAt` is judged on `updatedAt`, never treated as ancient).
//   (g) PAGINATION + SEARCH + TYPE filters return identical results on both
//       drivers, and `countScopedMemory` always agrees with the unwindowed list.
//   (h) An UNFILTERED, UNPAGED read is byte-for-byte the pre-M10 read (the
//       additive-only guarantee every existing call site depends on).
//   (i) The `noLearn` session flag round-trips on both drivers and is surfaced
//       only when it is ON.
//   (j) `canCaptureMemory` composes the two switches, and NEITHER of them
//       touches injection (§3: "stop learning" is not "forget").
//
// NO NETWORK, NO KEYS. Temp dir only; the real ~/.naby/app.db is never touched.
// Prints PASS/FAIL per assertion; exits non-zero on any FAIL.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP_DIR = mkdtempSync(join(tmpdir(), 'naby-spike-hygiene-'));
process.env.NABY_DB_PATH = join(TMP_DIR, 'app.db');
process.env.NABY_HOME = TMP_DIR;

import { DatabaseSync } from 'node:sqlite';
import { MockEngine } from '../engines/mock-engine.js';
import { makeGate, scriptedPolicy } from '../runtime/gate.js';
import {
  canCaptureMemory,
  isStaleForReview,
  MEMORY_DECAY_REVIEW_MS,
  memoryLastAccessAt,
  readLearningEnabled,
  staleReviewCutoff,
  writeLearningEnabled,
} from '../runtime/memory-hygiene.js';
import { runTurn } from '../runtime/session.js';
import { MemoryStore } from '../runtime/store/memory-store.js';
import { SCHEMA_VERSION, SqliteStore } from '../runtime/store/sqlite-store.js';
import type { MemoryItem, MemoryWriteRequest, Store } from '../runtime/store/store.js';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

/**
 * ONE "now" for the whole run, captured once.
 *
 * NOT a hardcoded constant, and the difference matters: rows written through
 * `putMemory` are stamped by the store with the REAL clock, so a fixed NOW in the
 * future would make every freshly-written row older than the 90-day window and
 * the staleness checks would pass for the wrong reason. Capturing the clock once
 * keeps the run deterministic in the way that actually counts — every age below
 * is an offset from this single instant, so no two checks disagree about when
 * "now" was.
 */
const NOW = Date.now();
const DAY = 86_400_000;

/** Both drivers, run through the same body — the shape every cross-driver check
 *  below uses. A closed store leaks nothing between cases. */
function onBothDrivers(body: (store: Store, label: string) => void): void {
  for (const [label, make] of [
    ['MemoryStore', () => new MemoryStore()],
    ['SqliteStore', () => new SqliteStore({ path: ':memory:' })],
  ] as const) {
    const store = make();
    try {
      body(store, label);
    } finally {
      store.close();
    }
  }
}

let seq = 0;
function write(store: Store, over: Partial<MemoryWriteRequest> = {}): MemoryItem {
  seq += 1;
  return store.putMemory({
    scope: 'user',
    scopeKey: 'local',
    type: 'semantic',
    key: `fact-${seq}`,
    value: `a fact numbered ${seq}`,
    provenance: { source: 'user' },
    confidence: 1,
    requestedStatus: 'confirmed',
    ...over,
  } as MemoryWriteRequest);
}

const ids = (rows: readonly { id: string }[]): string => rows.map((r) => r.id).join(',');

// ---------------------------------------------------------------------------
// (a)/(b) the v9 -> v10 migration, on a REAL file
// ---------------------------------------------------------------------------

/**
 * Build a database that looks exactly like a v9 one: the v9 schema, v9 data, and
 * `user_version = 9`.
 *
 * WRITTEN OUT BY HAND rather than produced by an old copy of the code, because
 * the point is to test the migration against the schema as it was SHIPPED. A
 * fixture generated by the current source would migrate itself before we ever
 * looked at it, and the check would pass by construction.
 */
function makeV9Database(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, title TEXT,
      created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL,
      cwd TEXT, pinned INTEGER NOT NULL DEFAULT 0, pinned_at INTEGER, status TEXT
    );
    CREATE TABLE messages (
      session_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL,
      payload TEXT NOT NULL, PRIMARY KEY (session_id, seq)
    );
    CREATE TABLE memory_items (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, scope_key TEXT NOT NULL,
      type TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
      prov_source TEXT NOT NULL, prov_session_id TEXT, prov_basis TEXT,
      prov_created_from TEXT, confidence REAL NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE (scope, scope_key, key)
    );
    CREATE TABLE memory_observations (
      memory_id TEXT NOT NULL, session_id TEXT NOT NULL,
      observed_at INTEGER NOT NULL, created_from TEXT,
      PRIMARY KEY (memory_id, session_id)
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO sessions (session_id, provider_id, title, created_at, last_used_at)
      VALUES ('s-old', 'anthropic', 'an old chat', 100, 200);
    INSERT INTO messages VALUES ('s-old', 0, 'user', '{"role":"user","content":"hello"}');
    INSERT INTO memory_items VALUES
      ('m-old', 'user', 'local', 'semantic', 'tone', 'writes concisely',
       'user', 's-old', NULL, NULL, 1.0, 'confirmed', 100, 12345);
    INSERT INTO memory_observations VALUES ('m-old', 's-old', 300, NULL);
    PRAGMA user_version = 9;
  `);
  db.close();
}

function userVersion(path: string): number {
  const db = new DatabaseSync(path);
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  db.close();
  return Number(row?.user_version ?? 0);
}

function columnsOf(path: string, table: string): string[] {
  const db = new DatabaseSync(path);
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  db.close();
  return rows.map((r) => r.name);
}

function checkMigration(): void {
  const path = join(TMP_DIR, 'v9.db');
  makeV9Database(path);
  const before = userVersion(path);

  const store = new SqliteStore(path);
  const memory = store.getScopedMemory('user', 'local');
  const session = store.getSession('s-old');
  const messages = store.getMessages('s-old');
  const observations = store.getMemoryCorroboration(['m-old']);
  store.close();

  const after = userVersion(path);
  const sessionCols = columnsOf(path, 'sessions');
  const memoryCols = columnsOf(path, 'memory_items');

  record(
    `(a) LOSSLESS MIGRATION v9 -> current: both v10 columns added, every row SURVIVES, version stamped ${SCHEMA_VERSION}`,
    before === 9 &&
      after === SCHEMA_VERSION &&
      sessionCols.includes('no_learn') &&
      memoryCols.includes('last_injected_at') &&
      memory.length === 1 &&
      memory[0]?.value === 'writes concisely' &&
      // The pre-v10 row has NO access history, and inventing one would be
      // inventing evidence — exactly the reasoning v9 used for observations.
      memory[0]?.lastInjectedAt === undefined &&
      session?.title === 'an old chat' &&
      session.noLearn === undefined &&
      messages.length === 1 &&
      observations['m-old'] === 1,
    `version ${before} -> ${after}; sessions.no_learn=${sessionCols.includes('no_learn')} ` +
      `memory_items.last_injected_at=${memoryCols.includes('last_injected_at')}; ` +
      `memory=${memory.length} (lastInjectedAt=${String(memory[0]?.lastInjectedAt)}) ` +
      `messages=${messages.length} observations=${observations['m-old'] ?? 0}`,
  );

  // Re-opening must be a no-op — ALTER TABLE ADD COLUMN has no IF NOT EXISTS and
  // throws on a second run, so this is the check that the gating actually works.
  let reopened = '';
  try {
    const again = new SqliteStore(path);
    reopened = `rows=${again.getScopedMemory('user', 'local').length}`;
    again.close();
  } catch (e) {
    reopened = `THREW: ${e instanceof Error ? e.message : String(e)}`;
  }
  record(
    '(a2) re-opening a migrated database is a NO-OP (the column gate is not version-gated)',
    reopened === 'rows=1',
    reopened,
  );

  // SELF-HEALING: a database stamped at the current version but missing a column
  // — what a crash between the ALTER and the PRAGMA leaves behind. A
  // version-gated migration would skip the repair and every later read would
  // throw "no such column".
  const brokenPath = join(TMP_DIR, 'broken.db');
  makeV9Database(brokenPath);
  const raw = new DatabaseSync(brokenPath);
  raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  raw.close();
  let healed = '';
  try {
    const store2 = new SqliteStore(brokenPath);
    store2.markMemoriesInjected(['m-old'], NOW);
    healed = String(store2.getScopedMemory('user', 'local')[0]?.lastInjectedAt);
    store2.close();
  } catch (e) {
    healed = `THREW: ${e instanceof Error ? e.message : String(e)}`;
  }
  record(
    '(b) a database stamped v10 but MISSING the column still gets it (self-healing)',
    healed === String(NOW),
    `lastInjectedAt after repair = ${healed}`,
  );
}

// ---------------------------------------------------------------------------
// (c) injection marks access — through the real runTurn
// ---------------------------------------------------------------------------

async function checkInjectionMarksAccess(): Promise<void> {
  const store = new SqliteStore({ path: ':memory:' });
  try {
    const session = store.createSession('mock');
    const injected = write(store, { key: 'tone', value: 'Writes in short sentences.' });
    const pending = write(store, {
      key: 'pending-thing',
      value: 'Something nobody has confirmed.',
      requestedStatus: 'proposed',
      provenance: { source: 'artifact' },
    });

    const before = store.getScopedMemory('user', 'local');
    const engine = new MockEngine();
    const gate = makeGate(scriptedPolicy({}));
    await runTurn({
      engine,
      store,
      sessionId: session.sessionId,
      model: { providerId: 'mock' },
      userText: 'how should I write this?',
      toolSchemas: [],
      executors: {},
      gate: gate.gate,
      memoryInjection: { tokenBudget: 2_000, queryText: 'how should I write this?' },
    });
    const after = store.getScopedMemory('user', 'local');
    const stampedIds = after.filter((m) => m.lastInjectedAt !== undefined).map((m) => m.id);

    record(
      '(c) a turn STAMPS the rows it injected — and only those (a proposal was never injected, so it is untouched)',
      before.every((m) => m.lastInjectedAt === undefined) &&
        stampedIds.length === 1 &&
        stampedIds[0] === injected.id &&
        after.find((m) => m.id === pending.id)?.lastInjectedAt === undefined,
      `stamped=${stampedIds.join(',') || '(none)'} injected=${injected.id} proposal=${pending.id}`,
    );

    // A turn with NOTHING to inject must not write at all — the no-op invariant
    // (contract §5), extended from the prompt to the store.
    const empty = new SqliteStore({ path: ':memory:' });
    const s2 = empty.createSession('mock');
    const proposalOnly = empty.putMemory({
      scope: 'user',
      scopeKey: 'local',
      type: 'semantic',
      key: 'nothing-confirmed',
      value: 'A row nobody agreed to.',
      provenance: { source: 'artifact' },
      confidence: 0.5,
      requestedStatus: 'proposed',
    });
    await runTurn({
      engine: new MockEngine(),
      store: empty,
      sessionId: s2.sessionId,
      model: { providerId: 'mock' },
      userText: 'anything at all',
      toolSchemas: [],
      executors: {},
      gate: makeGate(scriptedPolicy({})).gate,
      memoryInjection: { tokenBudget: 2_000, queryText: 'anything at all' },
    });
    const untouched = empty.getScopedMemory('user', 'local');
    empty.close();
    record(
      '(c2) a turn that injected NOTHING writes nothing (the no-op invariant reaches the store)',
      untouched.length === 1 &&
        untouched[0]?.id === proposalOnly.id &&
        untouched[0]?.lastInjectedAt === undefined,
      `rows=${untouched.length} lastInjectedAt=${String(untouched[0]?.lastInjectedAt)}`,
    );
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// (d)/(e) confirm and edit
// ---------------------------------------------------------------------------

function checkConfirmAndEdit(): void {
  onBothDrivers((store, label) => {
    // A row two sessions agree with, so the corroboration reset is observable.
    const base: MemoryWriteRequest = {
      scope: 'user',
      scopeKey: 'local',
      type: 'semantic',
      key: 'editable',
      value: 'Deploys on Fridays.',
      provenance: { source: 'artifact', sessionId: 'sess-a' },
      confidence: 0.5,
      requestedStatus: 'proposed',
    };
    const item = store.putMemory(base);
    store.putMemory({ ...base, provenance: { source: 'artifact', sessionId: 'sess-b' } });
    const corroborationBefore = store.getMemoryCorroboration([item.id])[item.id] ?? 0;

    store.confirmMemory(item.id);
    const confirmed = store.getScopedMemory('user', 'local').find((m) => m.id === item.id);
    record(
      `(d) [${label}] CONFIRM stamps access — a row a person just said yes to is not stale tomorrow`,
      confirmed?.status === 'confirmed' && typeof confirmed.lastInjectedAt === 'number',
      `status=${confirmed?.status} lastInjectedAt=${String(confirmed?.lastInjectedAt)}`,
    );

    // A WHITESPACE-ONLY change is the same claim (sameMemoryValue), so the
    // evidence survives — the M8b rule, reused rather than restated.
    const reflowed = store.updateMemoryValue(item.id, '  Deploys   on Fridays. ', NOW);
    const afterReflow = store.getMemoryCorroboration([item.id])[item.id] ?? 0;
    record(
      `(e1) [${label}] EDITING only the whitespace keeps the corroboration (same claim)`,
      corroborationBefore === 2 && afterReflow === 2 && reflowed?.provenance.source === 'user',
      `corroboration ${corroborationBefore} -> ${afterReflow}; source=${reflowed?.provenance.source}`,
    );

    const edited = store.updateMemoryValue(item.id, 'Never deploys on Fridays.', NOW);
    const afterEdit = store.getMemoryCorroboration([item.id])[item.id] ?? 0;
    record(
      `(e2) [${label}] EDITING the claim promotes it to 'user' tier, RESETS corroboration, stamps access, and leaves status alone`,
      edited?.value === 'Never deploys on Fridays.' &&
        edited.provenance.source === 'user' &&
        afterEdit === 0 &&
        edited.lastInjectedAt === NOW &&
        // An edit is not a confirm: rewording a proposal must not agree to it.
        edited.status === 'confirmed',
      `value="${edited?.value}" source=${edited?.provenance.source} corroboration=${afterEdit} ` +
        `lastInjectedAt=${String(edited?.lastInjectedAt)} status=${edited?.status}`,
    );

    record(
      `(e3) [${label}] editing an unknown id returns undefined rather than inventing a row`,
      store.updateMemoryValue('no-such-id', 'anything') === undefined,
      'updateMemoryValue("no-such-id") === undefined',
    );
  });
}

// ---------------------------------------------------------------------------
// (f) the stale derivation, three ways
// ---------------------------------------------------------------------------

function checkStaleDerivation(): void {
  const cutoff = staleReviewCutoff(NOW, MEMORY_DECAY_REVIEW_MS);
  const seen: Record<string, string> = {};

  onBothDrivers((store, label) => {
    // Four rows spanning every case the predicate has to separate.
    const fresh = write(store, { key: 'fresh', value: 'used yesterday' });
    store.markMemoriesInjected([fresh.id], NOW - DAY);

    const stale = write(store, { key: 'stale', value: 'used a year ago' });
    store.markMemoriesInjected([stale.id], NOW - 365 * DAY);

    // NO ACCESS HISTORY (a pre-v10 row): judged on updatedAt. Written now, so it
    // must count as FRESH — the fallback is what stops an upgrade marking a
    // user's whole memory stale on day one.
    const neverUsed = write(store, { key: 'never-used', value: 'written just now' });

    // A PROPOSAL that has not been touched in a year is NOT stale — it is
    // unanswered, and it has its own queue (§2.2).
    const oldProposal = write(store, {
      key: 'old-proposal',
      value: 'proposed long ago',
      requestedStatus: 'proposed',
      provenance: { source: 'artifact' },
    });
    store.markMemoriesInjected([oldProposal.id], NOW - 365 * DAY);

    const listed = store.listStaleConfirmedMemory(cutoff);
    const filtered = store.getScopedMemory('user', 'local', { staleBefore: cutoff });
    const counted = store.countScopedMemory('user', 'local', { staleBefore: cutoff });
    // The PURE predicate, asked of every row independently.
    const predicted = store
      .getScopedMemory('user', 'local')
      .filter((m) => isStaleForReview(m, NOW, MEMORY_DECAY_REVIEW_MS))
      .map((m) => m.key);

    const keys = (rows: readonly MemoryItem[]): string => rows.map((r) => r.key).sort().join(',');
    seen[label] = keys(listed);

    record(
      `(f) [${label}] STALE = confirmed AND unused: the cross-scope list, the scoped filter, the count and the pure predicate all agree`,
      keys(listed) === 'stale' &&
        keys(filtered) === 'stale' &&
        counted === 1 &&
        predicted.join(',') === 'stale' &&
        // The fallback, stated explicitly: a row with no access history reads as
        // "last touched when it was written", not as infinitely old.
        memoryLastAccessAt({ updatedAt: 999, lastInjectedAt: undefined }) === 999,
      `list=[${keys(listed)}] filter=[${keys(filtered)}] count=${counted} predicate=[${predicted.join(',')}] ` +
        `(fresh=${fresh.key} neverUsed=${neverUsed.key} oldProposal=${oldProposal.key} excluded)`,
    );
  });

  record(
    '(f2) both drivers derive the SAME stale set',
    seen.MemoryStore === seen.SqliteStore,
    `MemoryStore=[${seen.MemoryStore}] SqliteStore=[${seen.SqliteStore}]`,
  );
}

// ---------------------------------------------------------------------------
// (g)/(h) pagination, search, type filter — and the additive guarantee
// ---------------------------------------------------------------------------

function checkQueryFilters(): void {
  const results: Record<string, string[]> = {};

  onBothDrivers((store, label) => {
    // A population big enough to page, with a couple of rows a search must find
    // and a couple it must not.
    for (let i = 0; i < 12; i += 1) {
      store.putMemory({
        scope: 'user',
        scopeKey: 'local',
        type: i % 2 === 0 ? 'semantic' : 'procedural',
        key: `row-${String(i).padStart(2, '0')}`,
        value: i < 3 ? `Prefers POSTGRES for row ${i}` : `an unrelated fact ${i}`,
        provenance: { source: 'user' },
        confidence: 1,
        requestedStatus: 'confirmed',
      });
    }

    const all = store.getScopedMemory('user', 'local');
    const page1 = store.getScopedMemory('user', 'local', { limit: 5, offset: 0 });
    const page2 = store.getScopedMemory('user', 'local', { limit: 5, offset: 5 });
    const page3 = store.getScopedMemory('user', 'local', { limit: 5, offset: 10 });
    // ASCII-case-insensitive, and the term is not a LIKE wildcard.
    const search = store.getScopedMemory('user', 'local', { search: 'postgres' });
    const searchUpper = store.getScopedMemory('user', 'local', { search: 'POSTGRES' });
    const wildcard = store.getScopedMemory('user', 'local', { search: '%' });
    const typed = store.getScopedMemory('user', 'local', { type: 'procedural' });
    const combined = store.getScopedMemory('user', 'local', {
      type: 'semantic',
      search: 'postgres',
      limit: 1,
      offset: 1,
    });

    results[label] = [
      all.map((r) => r.key).join(','),
      page1.map((r) => r.key).join(','),
      page2.map((r) => r.key).join(','),
      page3.map((r) => r.key).join(','),
      search.map((r) => r.key).join(','),
      typed.map((r) => r.key).join(','),
      combined.map((r) => r.key).join(','),
    ];

    record(
      `(g) [${label}] pagination WINDOWS a stable order and never overlaps or skips`,
      all.length === 12 &&
        page1.length === 5 &&
        page2.length === 5 &&
        page3.length === 2 &&
        ids([...page1, ...page2, ...page3]) === ids(all),
      `pages ${page1.length}/${page2.length}/${page3.length} reassemble the full list: ` +
        `${ids([...page1, ...page2, ...page3]) === ids(all)}`,
    );

    record(
      `(g2) [${label}] SEARCH folds ASCII case and treats a LIKE wildcard as a literal`,
      search.length === 3 &&
        searchUpper.length === 3 &&
        ids(search) === ids(searchUpper) &&
        // '%' matches every row on a naive LIKE and no row here on an escaped one.
        wildcard.length === 0,
      `"postgres"=${search.length} "POSTGRES"=${searchUpper.length} "%"=${wildcard.length}`,
    );

    // The combined filter, read WITHOUT a window — the honest baseline for the
    // count. Derived rather than written down as a number: a hardcoded
    // expectation here would be asserting how the fixture's `i % 2` happened to
    // fall, not that the count and the list agree.
    const combinedAll = store.getScopedMemory('user', 'local', {
      type: 'semantic',
      search: 'postgres',
    });
    record(
      `(g3) [${label}] countScopedMemory always agrees with the UNWINDOWED list for the same filter`,
      store.countScopedMemory('user', 'local') === all.length &&
        store.countScopedMemory('user', 'local', { search: 'postgres' }) === search.length &&
        store.countScopedMemory('user', 'local', { type: 'procedural' }) === typed.length &&
        // The WINDOW must not reach the count — that is the whole point of it
        // being a separate method. `combined` asked for one row on page 2 of this
        // same filter, and the count must still report the full set.
        store.countScopedMemory('user', 'local', { type: 'semantic', search: 'postgres' }) ===
          combinedAll.length &&
        combinedAll.length > combined.length,
      `count(all)=${store.countScopedMemory('user', 'local')} vs ${all.length}; ` +
        `count(search)=${store.countScopedMemory('user', 'local', { search: 'postgres' })} vs ${search.length}; ` +
        `count(type+search)=${store.countScopedMemory('user', 'local', { type: 'semantic', search: 'postgres' })} ` +
        `vs unwindowed ${combinedAll.length}, windowed page held ${combined.length}`,
    );

    // (h) THE ADDITIVE GUARANTEE: no options at all, an empty object, and a
    // status-only read are the three shapes every pre-M10 caller uses.
    const bare = store.getScopedMemory('user', 'local');
    const emptyOpts = store.getScopedMemory('user', 'local', {});
    const statusOnly = store.getScopedMemory('user', 'local', { status: 'confirmed' });
    record(
      `(h) [${label}] an unfiltered/unpaged read is UNCHANGED by M10 (additive only)`,
      ids(bare) === ids(all) && ids(emptyOpts) === ids(all) && ids(statusOnly) === ids(all),
      `bare=${bare.length} {}=${emptyOpts.length} {status}=${statusOnly.length} all=${all.length}`,
    );
  });

  record(
    '(g4) both drivers answer every filter IDENTICALLY',
    JSON.stringify(results.MemoryStore) === JSON.stringify(results.SqliteStore),
    `MemoryStore=${JSON.stringify(results.MemoryStore)?.slice(0, 120)}… ` +
      `SqliteStore=${JSON.stringify(results.SqliteStore)?.slice(0, 120)}…`,
  );
}

// ---------------------------------------------------------------------------
// (i)/(j) the two sovereignty switches
// ---------------------------------------------------------------------------

function checkSovereigntySwitches(): void {
  onBothDrivers((store, label) => {
    const session = store.createSession('mock');
    const initial = store.getSession(session.sessionId)?.noLearn;
    store.setSessionNoLearn(session.sessionId, true);
    const on = store.getSession(session.sessionId)?.noLearn;
    store.setSessionNoLearn(session.sessionId, false);
    const off = store.getSession(session.sessionId)?.noLearn;
    record(
      `(i) [${label}] the noLearn flag round-trips and is surfaced ONLY when it is on`,
      initial === undefined && on === true && off === undefined,
      `initial=${String(initial)} on=${String(on)} off=${String(off)}`,
    );

    record(
      `(i2) [${label}] marking a session that does not exist is a no-op, not a throw`,
      (() => {
        try {
          store.setSessionNoLearn('no-such-session', true);
          return true;
        } catch {
          return false;
        }
      })(),
      'setSessionNoLearn("no-such-session", true) did not throw',
    );

    // The app-wide switch: absent reads as ON.
    const byDefault = readLearningEnabled(store);
    writeLearningEnabled(store, false);
    const afterOff = readLearningEnabled(store);
    writeLearningEnabled(store, true);
    const afterOn = readLearningEnabled(store);
    record(
      `(j) [${label}] memory.learningEnabled defaults to ON and round-trips`,
      byDefault === true && afterOff === false && afterOn === true,
      `default=${byDefault} off=${afterOff} on=${afterOn}`,
    );
  });

  record(
    '(j2) canCaptureMemory composes BOTH switches: either one off means no capture',
    canCaptureMemory({ learningEnabled: true, sessionNoLearn: false }) === true &&
      canCaptureMemory({ learningEnabled: false, sessionNoLearn: false }) === false &&
      canCaptureMemory({ learningEnabled: true, sessionNoLearn: true }) === false &&
      canCaptureMemory({ learningEnabled: false, sessionNoLearn: true }) === false,
    'on/on=true, off/on=false, on/no-learn=false, off/no-learn=false',
  );
}

/**
 * §3's load-bearing asymmetry: NEITHER switch touches INJECTION. "Do not learn
 * from this" is not "forget what you know", and an implementation that quietly
 * conflated them would take a user's whole personalization away the moment they
 * asked it to stop recording new things.
 */
async function checkSwitchesDoNotAffectInjection(): Promise<void> {
  const store = new SqliteStore({ path: ':memory:' });
  try {
    const session = store.createSession('mock');
    write(store, { key: 'tone', value: 'Writes in short sentences.' });
    // Both switches OFF for learning, in the strongest combination.
    writeLearningEnabled(store, false);
    store.setSessionNoLearn(session.sessionId, true);

    const engine = new MockEngine();
    let systemSeen: string | undefined;
    const originalRun = engine.run.bind(engine);
    // The engine records what system prompt it was handed — the only thing that
    // decides whether the memory reached the model.
    engine.run = ((opts: Parameters<typeof originalRun>[0]) => {
      systemSeen = opts.system;
      return originalRun(opts);
    }) as typeof engine.run;

    await runTurn({
      engine,
      store,
      sessionId: session.sessionId,
      model: { providerId: 'mock' },
      userText: 'how should I write this?',
      toolSchemas: [],
      executors: {},
      gate: makeGate(scriptedPolicy({})).gate,
      memoryInjection: { tokenBudget: 2_000, queryText: 'how should I write this?' },
    });

    record(
      '(j3) with learning OFF and the session marked temporary, confirmed memory STILL injects (§3: stop learning ≠ forget)',
      Boolean(systemSeen?.includes('Writes in short sentences.')),
      `system prompt carried the fact: ${Boolean(systemSeen?.includes('Writes in short sentences.'))}`,
    );
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<boolean> {
  checkMigration();
  await checkInjectionMarksAccess();
  checkConfirmAndEdit();
  checkStaleDerivation();
  checkQueryFilters();
  checkSovereigntySwitches();
  await checkSwitchesDoNotAffectInjection();

  console.log('\n=== SPIKE-HYGIENE — memory decay + sovereignty (P3-M10 §2–§4) ===\n');
  let allPass = true;
  for (const c of checks) {
    const tag = c.pass ? 'PASS' : 'FAIL';
    if (!c.pass) allPass = false;
    console.log(`[${tag}] ${c.name}`);
    console.log(`        evidence: ${c.evidence}`);
  }
  console.log(
    `\nSPIKE-HYGIENE: ${allPass ? 'ALL PASS' : 'FAILURES PRESENT'} (${checks.filter((c) => c.pass).length}/${checks.length})\n`,
  );
  return allPass;
}

try {
  const ok = await main();
  if (!ok) process.exitCode = 1;
} catch (e) {
  console.error('SPIKE-HYGIENE crashed:', e);
  process.exitCode = 1;
} finally {
  rmSync(TMP_DIR, { recursive: true, force: true });
}
