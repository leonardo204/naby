// src/spikes/spike-store-projects.ts
//
// Phase B verification — the Naby store's PROJECTS layer and the session↔
// project link (contracts §6.1, architecture §8, impl §9 Phase B, test §2a).
//
// It proves, against BOTH drivers where the claim is meaningful:
//
//   (1) MIGRATION v2 -> v4, no loss, idempotent. A real file-backed v2 database
//       (old schema, `user_version = 2`, real session/message/memory rows) is
//       reopened with the NEW code. It must upgrade to v4 in place — the three
//       new `sessions` columns added by version-gated ALTER, the `projects`
//       table created, and the legacy `memory` rows losslessly back-filled into
//       the scoped `memory_items` table (Phase 1.5) — with every existing row
//       intact (the migrated session memory still reads through getAllMemory),
//       and a SECOND reopen must be a no-op. This is SqliteStore-only: with ':memory:' or MemoryStore
//       there is no schema to migrate and the assertion would pass vacuously,
//       so the db is a REAL FILE in a temp dir, closed and REOPENED.
//   (2) projects CRUD + MRU. upsert/touch/listProjects returns
//       last_opened_at DESC.
//   (3) session↔project link. createSession(cwd) and setSessionProject →
//       listSessionsByProject (MRU); getSession surfaces cwd.
//   (4) removeProject CASCADE, ZERO ORPHANS. A project with 2 sessions, each
//       carrying messages + memory + usage, is removed; every one of those
//       rows must be gone (asserted directly per session).
//   (5) pinned sessions. setSessionPinned + listPinnedSessions (MRU).
//
// (2)–(5) run against a fresh file-backed SqliteStore AND a MemoryStore, so the
// two drivers are proven observationally identical across the new surface —
// the same property spike:f105 leans on. Prints PASS/FAIL per assertion; exits
// non-zero on any FAIL. Cleans up the temp dir on the way out.

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RuntimeMessage } from '../runtime/engine.js';
import { MemoryStore } from '../runtime/store/memory-store.js';
import { SqliteStore } from '../runtime/store/sqlite-store.js';
import type { Store, UsageRecord } from '../runtime/store/store.js';

type Check = { name: string; pass: boolean; evidence: string };

function record(checks: Check[], name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

/** Spin until the wall clock advances one ms, so operations that key MRU order
 * off Date.now() get strictly-increasing timestamps and the ordering asserts
 * are deterministic rather than dependent on sub-ms scheduling. */
function tick(): void {
  const t = Date.now();
  while (Date.now() === t) {
    /* busy-wait one ms */
  }
}

function userMsg(text: string): RuntimeMessage {
  return { role: 'user', content: text };
}

function usage(model: string): UsageRecord {
  return {
    at: Date.now(),
    engine: 'mock-engine',
    providerId: 'provider-a',
    model,
    inputTokens: 10,
    outputTokens: 4,
    cachedInputTokens: 0,
    costBasis: 'metered',
  };
}

// ---------------------------------------------------------------------------
// (1) Migration v2 -> v3 — SqliteStore only, real file, real restart.
// ---------------------------------------------------------------------------

/** Build a genuine v2 database at `path`: the OLD schema (no cwd/pinned/status
 * on sessions, no projects table), real rows, `user_version = 2`. */
function buildV2Db(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE sessions (
      session_id   TEXT PRIMARY KEY,
      provider_id  TEXT NOT NULL,
      title        TEXT,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      session_id TEXT NOT NULL,
      seq        INTEGER NOT NULL,
      role       TEXT NOT NULL,
      payload    TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
    CREATE TABLE memory (
      session_id TEXT NOT NULL,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      PRIMARY KEY (session_id, key)
    );
    CREATE TABLE usage (
      session_id          TEXT NOT NULL,
      seq                 INTEGER NOT NULL,
      at                  INTEGER NOT NULL,
      engine              TEXT NOT NULL,
      provider_id         TEXT NOT NULL,
      model               TEXT NOT NULL,
      input_tokens        INTEGER NOT NULL,
      output_tokens       INTEGER NOT NULL,
      cached_input_tokens INTEGER NOT NULL,
      cost_basis          TEXT NOT NULL,
      reported_cost_usd   REAL,
      PRIMARY KEY (session_id, seq)
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE mcp_servers (name TEXT PRIMARY KEY, payload TEXT NOT NULL);
  `);
  db.prepare(
    `INSERT INTO sessions (session_id, provider_id, title, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('sess-v2', 'provider-a', 'Old v2 session', 1000, 2000);
  db.prepare(
    'INSERT INTO messages (session_id, seq, role, payload) VALUES (?, ?, ?, ?)',
  ).run('sess-v2', 0, 'user', JSON.stringify(userMsg('hello from v2')));
  db.prepare('INSERT INTO memory (session_id, key, value) VALUES (?, ?, ?)').run(
    'sess-v2',
    'userName',
    'Nabi',
  );
  db.exec('PRAGMA user_version = 2');
  db.close();
}

/** Read `user_version` from a fresh connection — a real out-of-band check that
 * the stamp landed, not the store's own opinion of itself. */
function userVersion(path: string): number {
  const db = new DatabaseSync(path);
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  db.close();
  return Number(row.user_version);
}

function checkMigration(checks: Check[], dbPath: string): void {
  buildV2Db(dbPath);
  const startedAt = userVersion(dbPath); // 2

  // --- reopen with the NEW code: this is the migration under test ----------
  const store1 = new SqliteStore({ path: dbPath });
  const sess = store1.getSession('sess-v2');
  const msgs = store1.getMessages('sess-v2');
  const mem = store1.getAllMemory('sess-v2');
  // the new columns must now be usable on the pre-existing row
  store1.setSessionPinned('sess-v2', true);
  const afterPin = store1.getSession('sess-v2');
  store1.close();

  const versionAfter1 = userVersion(dbPath);

  const noLoss =
    !!sess &&
    sess.sessionId === 'sess-v2' &&
    sess.title === 'Old v2 session' &&
    sess.providerId === 'provider-a' &&
    sess.createdAt === 1000 &&
    sess.lastUsedAt === 2000 &&
    sess.cwd === undefined && // new column present but NULL on the old row
    msgs.length === 1 &&
    msgs[0]?.role === 'user' &&
    (msgs[0] as { content: string }).content === 'hello from v2' &&
    mem.userName === 'Nabi';

  record(
    checks,
    '(1a) MIGRATION v2->v4: existing sessions/messages/memory survive; new columns become usable',
    startedAt === 2 && versionAfter1 === 4 && noLoss && afterPin?.pinned === true,
    `user_version ${startedAt}->${versionAfter1}; session=${JSON.stringify(sess)}; messages=${msgs.length} ("${
      (msgs[0] as { content?: string } | undefined)?.content
    }"); memory=${JSON.stringify(mem)}; new column write pinned=${afterPin?.pinned}`,
  );

  // --- second reopen: current === 4, must be a pure no-op ------------------
  const store2 = new SqliteStore({ path: dbPath });
  const sess2 = store2.getSession('sess-v2');
  const msgs2 = store2.getMessages('sess-v2');
  const mem2 = store2.getAllMemory('sess-v2');
  // projects table exists and is queryable after migration
  const projects2 = store2.listProjects();
  store2.close();
  const versionAfter2 = userVersion(dbPath);

  record(
    checks,
    '(1b) MIGRATION is idempotent: a second reopen is a no-op, data + version unchanged',
    versionAfter2 === 4 &&
      !!sess2 &&
      sess2.pinned === true &&
      sess2.cwd === undefined &&
      msgs2.length === 1 &&
      mem2.userName === 'Nabi' &&
      Array.isArray(projects2) &&
      projects2.length === 0,
    `user_version still ${versionAfter2}; session intact=${!!sess2} pinned=${sess2?.pinned}; messages=${msgs2.length}; memory=${JSON.stringify(
      mem2,
    )}; projects table queryable, rows=${projects2.length}`,
  );
}

// ---------------------------------------------------------------------------
// (2)–(5) driver-agnostic checks — run against BOTH SqliteStore and MemoryStore.
// ---------------------------------------------------------------------------

function checkProjectsCrudMru(checks: Check[], store: Store, label: string): void {
  // Insert with explicit, strictly-increasing last_opened_at so the MRU order
  // is deterministic and independent of same-ms collisions.
  store.upsertProject('/proj/a', { title: 'A', lastOpenedAt: 1000 });
  store.upsertProject('/proj/b', { title: 'B', lastOpenedAt: 2000 });
  store.upsertProject('/proj/c', { title: 'C', lastOpenedAt: 3000 });

  const afterInsert = store.listProjects().map((p) => p.cwd);
  const insertMru = JSON.stringify(afterInsert) === JSON.stringify(['/proj/c', '/proj/b', '/proj/a']);

  // upsert patch is idempotent on identity fields and applies the patch
  const patched = store.upsertProject('/proj/a', { title: 'A-renamed', pinned: true });
  const patchOk =
    patched.title === 'A-renamed' &&
    patched.pinned === true &&
    patched.cwd === '/proj/a' &&
    patched.lastOpenedAt === 1000; // untouched by a patch that did not set it

  // touchProject bumps /proj/a to the front of the MRU list
  const touched = store.touchProject('/proj/a');
  const afterTouch = store.listProjects().map((p) => p.cwd);
  const touchMru = JSON.stringify(afterTouch) === JSON.stringify(['/proj/a', '/proj/c', '/proj/b']);
  const touchBumped = touched.lastOpenedAt > 3000 && touched.title === 'A-renamed';

  record(
    checks,
    `(2) [${label}] projects CRUD + MRU: listProjects is last_opened_at DESC; upsert patch + touch behave`,
    insertMru && patchOk && touchMru && touchBumped,
    `after insert=${JSON.stringify(afterInsert)} mru=${insertMru}; patch={title:${patched.title},pinned:${patched.pinned},lastOpened:${patched.lastOpenedAt}} ok=${patchOk}; after touch=${JSON.stringify(
      afterTouch,
    )} mru=${touchMru} bumped=${touchBumped}`,
  );
}

function checkSessionProjectLink(checks: Check[], store: Store, label: string): void {
  const cwd = '/link/project';
  store.upsertProject(cwd, { title: 'Linked', lastOpenedAt: 5000 });

  // (a) createSession(cwd) links at birth; getSession surfaces the cwd
  const s1 = store.createSession('provider-a', 'linked at birth', cwd);
  const s1ref = store.getSession(s1.sessionId);

  // (b) an initially-projectless session linked later via setSessionProject
  tick();
  const s2 = store.createSession('provider-a', 'linked later');
  const s2Before = store.getSession(s2.sessionId);
  store.setSessionProject(s2.sessionId, cwd);
  const s2After = store.getSession(s2.sessionId);

  // (c) listSessionsByProject returns both, MRU (last_used_at DESC). Bump s1 so
  // its order is deterministic and provably newest.
  tick();
  store.touchSession(s1.sessionId);
  const byProject = store.listSessionsByProject(cwd).map((r) => r.sessionId);
  const mruOrder = JSON.stringify(byProject) === JSON.stringify([s1.sessionId, s2.sessionId]);

  // (d) unlink via null removes it from the project's list
  store.setSessionProject(s2.sessionId, null);
  const afterUnlink = store.listSessionsByProject(cwd).map((r) => r.sessionId);
  const unlinkOk =
    afterUnlink.length === 1 &&
    afterUnlink[0] === s1.sessionId &&
    store.getSession(s2.sessionId)?.cwd === undefined;

  record(
    checks,
    `(3) [${label}] session<->project link: createSession(cwd) + setSessionProject; getSession shows cwd; listSessionsByProject MRU`,
    s1ref?.cwd === cwd &&
      s2Before?.cwd === undefined &&
      s2After?.cwd === cwd &&
      mruOrder &&
      unlinkOk,
    `s1.cwd=${s1ref?.cwd}; s2 cwd before=${s2Before?.cwd} after link=${s2After?.cwd}; byProject=${JSON.stringify(
      byProject,
    )} mru=${mruOrder}; after unlink=${JSON.stringify(afterUnlink)} ok=${unlinkOk}`,
  );
}

function checkRemoveProjectCascade(checks: Check[], store: Store, label: string): void {
  const cwd = '/cascade/project';
  store.upsertProject(cwd, { title: 'Doomed', lastOpenedAt: 6000 });

  const a = store.createSession('provider-a', 'cascade a', cwd);
  const b = store.createSession('provider-a', 'cascade b', cwd);
  for (const s of [a, b]) {
    store.appendMessage(s.sessionId, userMsg(`msg for ${s.sessionId}`));
    store.appendMessage(s.sessionId, userMsg(`msg2 for ${s.sessionId}`));
    store.setMemory(s.sessionId, 'k', 'v');
    store.appendUsage(s.sessionId, usage('model-x'));
  }

  // sanity: everything is present BEFORE the remove
  const before =
    store.listSessionsByProject(cwd).length === 2 &&
    store.getMessages(a.sessionId).length === 2 &&
    store.getMessages(b.sessionId).length === 2 &&
    store.getAllMemory(a.sessionId).k === 'v' &&
    store.listUsage(a.sessionId).length === 1 &&
    store.listUsage(b.sessionId).length === 1;

  store.removeProject(cwd);

  // AFTER: zero sessions for the project AND zero orphan rows for either
  // session — asserted directly against messages/memory/usage per session.
  const projectGone = !store.listProjects().some((p) => p.cwd === cwd);
  const sessionsGone =
    store.listSessionsByProject(cwd).length === 0 &&
    store.getSession(a.sessionId) === undefined &&
    store.getSession(b.sessionId) === undefined;
  const zeroOrphans =
    store.getMessages(a.sessionId).length === 0 &&
    store.getMessages(b.sessionId).length === 0 &&
    Object.keys(store.getAllMemory(a.sessionId)).length === 0 &&
    Object.keys(store.getAllMemory(b.sessionId)).length === 0 &&
    store.listUsage(a.sessionId).length === 0 &&
    store.listUsage(b.sessionId).length === 0;

  record(
    checks,
    `(4) [${label}] removeProject CASCADE: project + its sessions + every message/memory/usage row gone (ZERO orphans)`,
    before && projectGone && sessionsGone && zeroOrphans,
    `before(all present)=${before}; projectGone=${projectGone}; sessionsGone=${sessionsGone}; orphans: msgs a=${store.getMessages(
      a.sessionId,
    ).length} b=${store.getMessages(b.sessionId).length}, mem a=${Object.keys(
      store.getAllMemory(a.sessionId),
    ).length} b=${Object.keys(store.getAllMemory(b.sessionId)).length}, usage a=${store.listUsage(
      a.sessionId,
    ).length} b=${store.listUsage(b.sessionId).length}`,
  );
}

function checkPinned(checks: Check[], store: Store, label: string): void {
  const p1 = store.createSession('provider-a', 'pin 1');
  tick();
  const p2 = store.createSession('provider-a', 'pin 2');

  store.setSessionPinned(p1.sessionId, true);
  tick();
  store.setSessionPinned(p2.sessionId, true);
  // bump p1 so pinned MRU is deterministic: p1 newest
  tick();
  store.touchSession(p1.sessionId);

  const pinnedIds = store.listPinnedSessions().map((r) => r.sessionId);
  const bothPinnedMru = JSON.stringify(pinnedIds) === JSON.stringify([p1.sessionId, p2.sessionId]);
  const flagOnRef = store.getSession(p1.sessionId)?.pinned === true;

  // unpin one → drops out of the list
  store.setSessionPinned(p2.sessionId, false);
  const afterUnpin = store.listPinnedSessions().map((r) => r.sessionId);
  const unpinOk =
    afterUnpin.length === 1 &&
    afterUnpin[0] === p1.sessionId &&
    store.getSession(p2.sessionId)?.pinned === false;

  record(
    checks,
    `(5) [${label}] pinned sessions: setSessionPinned + listPinnedSessions (MRU); unpin drops out`,
    bothPinnedMru && flagOnRef && unpinOk,
    `pinned(MRU)=${JSON.stringify(pinnedIds)} ok=${bothPinnedMru}; ref.pinned=${flagOnRef}; after unpin=${JSON.stringify(
      afterUnpin,
    )} ok=${unpinOk}`,
  );
}

// ---------------------------------------------------------------------------

function runDriverChecks(checks: Check[], store: Store, label: string): void {
  checkProjectsCrudMru(checks, store, label);
  checkSessionProjectLink(checks, store, label);
  checkRemoveProjectCascade(checks, store, label);
  checkPinned(checks, store, label);
}

function main(tmpDir: string): boolean {
  const checks: Check[] = [];

  // (1) migration — SqliteStore, real file, real restart
  checkMigration(checks, join(tmpDir, 'migrate.db'));

  // (2)-(5) against BOTH drivers
  const sqlite: Store = new SqliteStore({ path: join(tmpDir, 'crud.db') });
  runDriverChecks(checks, sqlite, 'sqlite');
  sqlite.close();

  const memory: Store = new MemoryStore();
  runDriverChecks(checks, memory, 'memory');
  memory.close();

  // ---- Report -------------------------------------------------------------
  console.log('\n=== SPIKE-STORE-PROJECTS — projects, session<->project link, migration v2->v3 ===\n');
  let allPass = true;
  for (const c of checks) {
    const tag = c.pass ? 'PASS' : 'FAIL';
    if (!c.pass) allPass = false;
    console.log(`[${tag}] ${c.name}`);
    console.log(`        evidence: ${c.evidence}`);
  }
  console.log(
    `\nSPIKE-STORE-PROJECTS: ${allPass ? 'ALL PASS' : 'FAILURES PRESENT'} (${
      checks.filter((c) => c.pass).length
    }/${checks.length})\n`,
  );
  return allPass;
}

const TMP_DIR = mkdtempSync(join(tmpdir(), 'naby-store-projects-'));

try {
  const ok = main(TMP_DIR);
  if (!ok) process.exitCode = 1;
} catch (e) {
  console.error('SPIKE-STORE-PROJECTS crashed:', e);
  process.exitCode = 1;
} finally {
  rmSync(TMP_DIR, { recursive: true, force: true });
}
