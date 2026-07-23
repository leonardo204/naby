// src/spikes/spike-p15-golden.ts
//
// Phase 1.5 verification — the GOLDEN SET (P15-04): per-user holdout of real
// artifacts, held OUT of learning and reserved as a fixed evaluation set.
// Acceptance in phase-1_5-personalization-data-layer §3 (P15-04 row) / §5 / §6;
// the storage/consent/CRUD contract this proves is the store additions in
// store.ts (GoldenItem / GoldenItemInput / add/list/get/setConsent/remove).
//
// It proves, against BOTH store drivers where the claim is meaningful:
//
//   (a) HOLDOUT of N items. N real artifacts are captured and read back:
//       listGoldenSet returns all N (oldest first) and each is ADDRESSABLE by
//       its id via getGoldenItem — the handle Phase 2b re-scoring (F2-07) uses.
//   (b) EXCLUDED-FROM-LEARNING invariant. Every stored item's
//       `excludedFromLearning` is true; the caller cannot express false
//       (GoldenItemInput has no such field), and the read never surfaces false.
//   (c) CONSENT recorded + changed. Consent defaults to 'pending' and is
//       recorded; setGoldenConsent flips it; listGoldenSet filters by consent.
//   (d) CRUD + lifecycle independence. removeGoldenItem drops exactly one item;
//       a golden item is NOT keyed to any session — deleting the session it was
//       captured in leaves the holdout intact (it must survive for re-scoring).
//   (f) STRUCTURAL EXCLUSION from learning. Golden artifacts live in a store
//       disjoint from memory_items: their content never appears in getScopedMemory
//       for the same user, and the turn-time injection path (retrieveForInjection)
//       never selects them — only confirmed scoped MEMORY is injected. This is
//       the structural guarantee behind (b): nothing in the learning/injection
//       pipeline reads the golden set.
//   (e) LOSSLESS MIGRATION v4 -> v5. A real file-backed v4 database (scoped
//       memory_items + a session + memory rows, user_version = 4) is reopened
//       with the new code: the golden_items table is added (add/list work), every
//       memory_items row and the session SURVIVE, and user_version is stamped 5.
//
// NO NETWORK, NO KEYS. Prints PASS/FAIL per assertion; exits non-zero on any
// FAIL. Cleans up its temp dir on the way out.

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { retrieveForInjection } from '../runtime/memory-inject.js';
import { MemoryStore } from '../runtime/store/memory-store.js';
import { SqliteStore } from '../runtime/store/sqlite-store.js';
import type { GoldenItem, Store } from '../runtime/store/store.js';

type Check = { name: string; pass: boolean; evidence: string };

function record(checks: Check[], name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

const USER = 'local';
const N = 5;
const MARKER = 'GOLDEN-HELDOUT-DO-NOT-LEARN';

/** Seed N holdout artifacts for the user; returns the stored rows. */
function seedHoldout(store: Store, marker = MARKER): GoldenItem[] {
  const out: GoldenItem[] = [];
  for (let i = 0; i < N; i++) {
    out.push(
      store.addGoldenItem({
        scopeKey: USER,
        taskType: 'email',
        input: `past prompt ${i}`,
        expected: `${marker} real output ${i}`,
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// (a) holdout of N + addressability by id
// ---------------------------------------------------------------------------

function checkHoldout(checks: Check[], store: Store, label: string): void {
  const seeded = seedHoldout(store);
  const listed = store.listGoldenSet(USER);
  const countOk = listed.length === N;
  // oldest-first ordering (createdAt asc) matches insertion order
  const orderOk = listed.every((it, i) => it.input === `past prompt ${i}`);
  // each addressable by id, returning the exact held-out expected truth
  const addressable = seeded.every((s) => {
    const got = store.getGoldenItem(s.id);
    return got?.id === s.id && got.expected === s.expected && got.taskType === 'email';
  });
  const missingIsUndefined = store.getGoldenItem('no-such-id') === undefined;

  record(
    checks,
    `(a) [${label}] HOLDOUT of N=${N}: listGoldenSet returns all, each addressable by id (Phase 2b re-scoring handle)`,
    countOk && orderOk && addressable && missingIsUndefined,
    `listed=${listed.length}(want ${N}) order=${orderOk} addressable=${addressable} missing->undefined=${missingIsUndefined}`,
  );
}

// ---------------------------------------------------------------------------
// (b) excluded-from-learning invariant
// ---------------------------------------------------------------------------

function checkExcludedFlag(checks: Check[], store: Store, label: string): void {
  seedHoldout(store);
  const all = store.listGoldenSet(USER);
  const everyExcluded = all.length === N && all.every((it) => it.excludedFromLearning === true);
  // addGoldenItem's return value also carries it, and lastScoredAt starts null.
  const fresh = store.addGoldenItem({
    scopeKey: USER,
    taskType: 'summary',
    input: 'x',
    expected: 'y',
  });
  const freshOk = fresh.excludedFromLearning === true && fresh.lastScoredAt === null;

  record(
    checks,
    `(b) [${label}] EXCLUDED-FROM-LEARNING: every golden item is excludedFromLearning=true; lastScoredAt starts null`,
    everyExcluded && freshOk,
    `everyExcluded=${everyExcluded} (n=${all.length}); fresh excluded=${fresh.excludedFromLearning} lastScoredAt=${fresh.lastScoredAt}`,
  );
}

// ---------------------------------------------------------------------------
// (c) consent recorded + changed + filtered
// ---------------------------------------------------------------------------

function checkConsent(checks: Check[], store: Store, label: string): void {
  // default consent is 'pending'
  const pendingItem = store.addGoldenItem({
    scopeKey: USER,
    taskType: 'email',
    input: 'p',
    expected: 'q',
  });
  const defaultPending = pendingItem.consent === 'pending';

  // captured with explicit consent
  const grantedItem = store.addGoldenItem({
    scopeKey: USER,
    taskType: 'email',
    input: 'g',
    expected: 'h',
    consent: 'granted',
  });
  const explicitGranted = grantedItem.consent === 'granted';

  // change consent: pending -> granted, then granted -> revoked
  store.setGoldenConsent(pendingItem.id, 'granted');
  const afterGrant = store.getGoldenItem(pendingItem.id)?.consent === 'granted';
  store.setGoldenConsent(grantedItem.id, 'revoked');
  const afterRevoke = store.getGoldenItem(grantedItem.id)?.consent === 'revoked';

  // filter by consent
  const grantedOnly = store.listGoldenSet(USER, { consent: 'granted' });
  const revokedOnly = store.listGoldenSet(USER, { consent: 'revoked' });
  const filterOk =
    grantedOnly.length === 1 &&
    grantedOnly[0]?.id === pendingItem.id &&
    revokedOnly.length === 1 &&
    revokedOnly[0]?.id === grantedItem.id;

  // setGoldenConsent on an absent id is a no-op (does not throw / create)
  store.setGoldenConsent('ghost', 'granted');
  const noopOk = store.getGoldenItem('ghost') === undefined;

  record(
    checks,
    `(c) [${label}] CONSENT: defaults to 'pending', recorded, changeable (setGoldenConsent), filterable`,
    defaultPending && explicitGranted && afterGrant && afterRevoke && filterOk && noopOk,
    `defaultPending=${defaultPending} explicitGranted=${explicitGranted} afterGrant=${afterGrant} afterRevoke=${afterRevoke} filter=${filterOk} absent-noop=${noopOk}`,
  );
}

// ---------------------------------------------------------------------------
// (d) CRUD + session-lifecycle independence
// ---------------------------------------------------------------------------

function checkCrudIndependence(checks: Check[], store: Store, label: string): void {
  // A golden item captured DURING a session must NOT be keyed to it: the holdout
  // has to survive session deletion so it stays addressable for re-scoring.
  const sess = store.createSession('provider-a', 'capture');
  const g = store.addGoldenItem({
    scopeKey: USER,
    taskType: 'email',
    input: 'during a session',
    expected: `${MARKER} survives`,
  });
  const presentBefore = store.getGoldenItem(g.id)?.expected === `${MARKER} survives`;

  store.deleteSession(sess.sessionId);
  const survivesSessionDelete = store.getGoldenItem(g.id)?.id === g.id;

  // removeGoldenItem drops exactly that one
  const other = store.addGoldenItem({
    scopeKey: USER,
    taskType: 'email',
    input: 'other',
    expected: 'keep me',
  });
  store.removeGoldenItem(g.id);
  const removedOk =
    store.getGoldenItem(g.id) === undefined && store.getGoldenItem(other.id)?.id === other.id;

  record(
    checks,
    `(d) [${label}] CRUD + INDEPENDENCE: golden item survives its session's delete; removeGoldenItem drops exactly one`,
    presentBefore && survivesSessionDelete && removedOk,
    `presentBefore=${presentBefore} survivesSessionDelete=${survivesSessionDelete} removedExactlyOne=${removedOk}`,
  );
}

// ---------------------------------------------------------------------------
// (f) structural exclusion from the learning / injection pipeline
// ---------------------------------------------------------------------------

function checkStructuralExclusion(checks: Check[], store: Store, label: string): void {
  // Seed the golden holdout with a distinctive marker...
  seedHoldout(store, MARKER);
  // ...and ONE confirmed scoped memory the injection path SHOULD surface.
  store.putMemory({
    scope: 'user',
    scopeKey: USER,
    type: 'semantic',
    key: 'greeting',
    value: 'INJECT-ME-real-memory',
    provenance: { source: 'user' },
    confidence: 1,
    requestedStatus: 'confirmed',
  });

  // Golden content must NOT appear in scoped memory for the same user.
  const scoped = store.getScopedMemory('user', USER);
  const notInMemory = scoped.every((m) => !m.value.includes(MARKER));

  // The turn-time injection path never selects a golden artifact — only the
  // confirmed scoped memory is a candidate.
  const injected = retrieveForInjection(store, { sessionId: 'none', tokenBudget: 5000 }, { userId: USER });
  const noGoldenInjected = injected.items.every((m) => !m.value.includes(MARKER));
  const realMemoryInjected = injected.items.some((m) => m.value === 'INJECT-ME-real-memory');

  // And the golden set itself is intact (unaffected by memory writes).
  const goldenIntact = store.listGoldenSet(USER).length === N;

  record(
    checks,
    `(f) [${label}] STRUCTURAL EXCLUSION: golden content is absent from scoped memory AND never injected; real memory still injects`,
    notInMemory && noGoldenInjected && realMemoryInjected && goldenIntact,
    `notInScopedMemory=${notInMemory} noGoldenInjected=${noGoldenInjected} realMemoryInjected=${realMemoryInjected} goldenIntact=${goldenIntact} (injected ${injected.items.length} items)`,
  );
}

// ---------------------------------------------------------------------------
// (e) lossless migration v4 -> v5 — SqliteStore file only.
// ---------------------------------------------------------------------------

/** Build a genuine v4 database: the scoped memory_items table (Phase 1.5 v4),
 * a session, two memory rows, user_version = 4, and NO golden_items table. */
function buildV4Db(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, title TEXT,
      created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL,
      cwd TEXT, pinned INTEGER NOT NULL DEFAULT 0, status TEXT
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
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE mcp_servers (name TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE projects (
      cwd TEXT PRIMARY KEY, title TEXT, created_at INTEGER NOT NULL,
      last_opened_at INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.prepare(
    'INSERT INTO sessions (session_id, provider_id, title, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)',
  ).run('sess-v4', 'provider-a', 'Old v4', 1000, 2000);
  // a user-scoped confirmed memory (must survive) + a session-scoped one
  db.prepare(
    `INSERT INTO memory_items
       (id, scope, scope_key, type, key, value, prov_source, confidence, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('mi-user', 'user', USER, 'semantic', 'name', 'Nabi', 'user', 1, 'confirmed', 1000, 1000);
  db.prepare(
    `INSERT INTO memory_items
       (id, scope, scope_key, type, key, value, prov_source, confidence, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('mi-sess', 'session', 'sess-v4', 'working', 'tone', 'warm', 'user', 1, 'confirmed', 1000, 1000);
  db.exec('PRAGMA user_version = 4');
  db.close();
}

function userVersion(path: string): number {
  const db = new DatabaseSync(path);
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  db.close();
  return Number(row.user_version);
}

function checkMigration(checks: Check[], dbPath: string): void {
  buildV4Db(dbPath);
  const started = userVersion(dbPath);

  const store = new SqliteStore({ path: dbPath });
  // pre-existing scoped memory survives, on both read paths
  const userMem = store.getScopedMemory('user', USER);
  const legacySess = store.getAllMemory('sess-v4');
  const sess = store.getSession('sess-v4');
  // the new golden_items table is now usable
  const g = store.addGoldenItem({
    scopeKey: USER,
    taskType: 'email',
    input: 'post-migration',
    expected: `${MARKER} added after upgrade`,
  });
  const golden = store.listGoldenSet(USER);
  const addressable = store.getGoldenItem(g.id)?.expected === `${MARKER} added after upgrade`;
  store.close();
  const after = userVersion(dbPath);

  const memorySurvived =
    userMem.length === 1 &&
    userMem[0]?.value === 'Nabi' &&
    userMem[0]?.status === 'confirmed' &&
    legacySess.tone === 'warm';
  const sessionSurvived = sess?.sessionId === 'sess-v4' && sess.title === 'Old v4';
  const goldenUsable = golden.length === 1 && golden[0]?.excludedFromLearning === true && addressable;

  record(
    checks,
    '(e) LOSSLESS MIGRATION v4->v5: golden_items added and usable; memory_items + session SURVIVE; version stamped 5',
    started === 4 && after === 5 && memorySurvived && sessionSurvived && goldenUsable,
    `user_version ${started}->${after}; userMem=${JSON.stringify(userMem.map((m) => ({ k: m.key, v: m.value, s: m.status })))} legacyTone=${legacySess.tone} sessionSurvived=${sessionSurvived}; golden usable=${goldenUsable} (rows=${golden.length})`,
  );
}

// ---------------------------------------------------------------------------

function runDriverChecks(checks: Check[], make: () => Store, label: string): void {
  // Each check gets its own fresh store so seeded holdouts do not bleed across.
  let s = make();
  checkHoldout(checks, s, label);
  s.close();
  s = make();
  checkExcludedFlag(checks, s, label);
  s.close();
  s = make();
  checkConsent(checks, s, label);
  s.close();
  s = make();
  checkCrudIndependence(checks, s, label);
  s.close();
  s = make();
  checkStructuralExclusion(checks, s, label);
  s.close();
}

function main(tmpDir: string): boolean {
  const checks: Check[] = [];

  // (a)-(f) against BOTH drivers
  runDriverChecks(checks, () => new MemoryStore(), 'MemoryStore');
  runDriverChecks(checks, () => new SqliteStore({ path: ':memory:' }), 'SqliteStore');

  // (e) migration — file-backed, real restart
  checkMigration(checks, join(tmpDir, 'v4.db'));

  console.log('\n=== SPIKE-P15-GOLDEN — golden-set holdout, consent, CRUD, exclusion ===\n');
  let allPass = true;
  for (const c of checks) {
    const tag = c.pass ? 'PASS' : 'FAIL';
    if (!c.pass) allPass = false;
    console.log(`[${tag}] ${c.name}`);
    console.log(`        evidence: ${c.evidence}`);
  }
  console.log(
    `\nSPIKE-P15-GOLDEN: ${allPass ? 'ALL PASS' : 'FAILURES PRESENT'} (${checks.filter((c) => c.pass).length}/${checks.length})\n`,
  );
  return allPass;
}

const TMP_DIR = mkdtempSync(join(tmpdir(), 'naby-p15-golden-'));

try {
  const ok = main(TMP_DIR);
  if (!ok) process.exitCode = 1;
} catch (e) {
  console.error('SPIKE-P15-GOLDEN crashed:', e);
  process.exitCode = 1;
} finally {
  rmSync(TMP_DIR, { recursive: true, force: true });
}
