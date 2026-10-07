// src/spikes/spike-org-harness-migrate.ts
//
// ORG HARNESS M1 — package sync, rows, activation, and the upgrade path for an
// existing install (specs/org-harness-sync.md §3.1, §3.2, §3.6, §4.1–4.3, §4.5,
// §4.8, §4.9 cases 1–6 and 8).
//
// NO NETWORK, NO REAL HOME. Every case gets its own temp NABY_HOME + NABY_DB_PATH
// and a fake Skill Hub (`fakeHub`) that serves a marketplace manifest, package
// zips built from `fixtures/org-harness/altimedia-harness` (the real plugin's
// layout and frontmatter, synthetic bodies), and the bootstrap endpoint.
//
// WHAT IS ASSERTED, grouped by the spec's own list:
//
//   §4.9 case 1  fresh DB + skill-hub: three org rows, enabled, body-less payload
//   §4.9 case 2  v13 DB, NO skill-hub: zero fetches; harness_items + settings
//                byte-identical before/after; user_version still 13
//   §4.9 case 3  v13 DB with user data + skill-hub: rows arrive, user rows
//                untouched, no notices
//   §4.9 case 4  unmodified `task` copy: stays enabled, "unmodified" notice;
//                use-org-version disables + marks it; switch round-trips it
//   §4.9 case 5  edited `pdoc` copy (project scope): "edited" notice; keep-mine
//                suppresses it, also across a version bump
//   §4.9 case 6  offline first boot: nothing changes, injection identical; the
//                next (online) sync applies
//   §4.9 case 8  org rows are NOT injected by skill-inject and are counted in
//                `excludedForTools`
//   §3.1         sha256 mismatch rejected; interrupted extract keeps previous;
//                crashed staging leftover is cleaned; rerun is a no-op; exactly
//                one previous version kept; zip-slip / symlink rejected
//   §3.2         user-disabled row stays disabled across versions and the
//                switch; dropped skill → `org-withdrawn`, revived on return; a
//                user-deleted org row is never revived
//   §3.6         Bearer + X-Harness-Client; token in settings; once per KST day
//                per key; key change re-checks; 401 ⇒ off + flag; offline ≠ fail
//   §4.8         settings toggle and NABY_ORG_HARNESS=0 both round-trip
//
// Prints PASS/FAIL per assertion; exits non-zero on any FAIL.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { DEFAULT_USER_ID } from '../runtime/memory-inject.js';
import {
  applyOrgHarnessIfDue,
  checkOrgHarnessActivation,
  keepUserCopy,
  kstDay,
  listOrgPackageVersions,
  ORG_HARNESS_ENV_SWITCH,
  ORG_HARNESS_SCOPE_KEY,
  ORG_HARNESS_SETTING,
  ORG_SUPERSEDED_BY,
  orgHarnessAutoStatusKey,
  orgHarnessKeyHash,
  orgHarnessRoot,
  parseSkillFrontmatter,
  readCurrentOrgPackage,
  readOrgCopyNotices,
  readOrgHarnessState,
  runOrgHarnessSync,
  setOrgHarnessEnabled,
  syncOrgHarnessPackage,
  useOrgVersion,
  type OrgHarnessContext,
  type OrgHarnessFetch,
} from '../runtime/org-harness.js';
import { retrieveSkillsForInjection } from '../runtime/skill-inject.js';
import { SCHEMA_VERSION, SqliteStore } from '../runtime/store/sqlite-store.js';
import type { HarnessItem } from '../runtime/store/store.js';
import { buildZip, extractZip, ZipError, type ZipWriteEntry } from '../runtime/zip.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, evidence = ''): void {
  checks.push({ name, pass, evidence });
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = join(ROOT, 'src/spikes/fixtures/org-harness/altimedia-harness');
const SPIKE_ROOT = mkdtempSync(join(tmpdir(), 'naby-spike-org-harness-'));
// Belt and braces: nothing in this process may resolve the real ~/.naby.
process.env.NABY_HOME = join(SPIKE_ROOT, 'process-home');
process.env.NABY_DB_PATH = join(SPIKE_ROOT, 'process-home', 'app.db');
const DAY_MS = 24 * 60 * 60 * 1000;

const KEY = 'shub_spikeKeyAAAA';
const MARKETPLACE = 'https://hub.test/api/v1/marketplace.json';
const BOOTSTRAP = 'https://hub.test/api/v1/harness/bootstrap';

function freshCase(label: string): { home: string; dbPath: string; store: SqliteStore } {
  const home = join(SPIKE_ROOT, label);
  mkdirSync(home, { recursive: true });
  const dbPath = join(home, 'app.db');
  return { home, dbPath, store: new SqliteStore({ path: dbPath }) };
}

function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Read the fixture tree as zip entries, with the plugin version patched. */
function fixtureEntries(
  version: string,
  opts: { drop?: string[]; wrap?: string; patch?: Record<string, string> } = {},
): ZipWriteEntry[] {
  const out: ZipWriteEntry[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const rel = relative(FIXTURE, full).split('\\').join('/');
      if (opts.drop?.some((d) => rel.startsWith(`skills/${d}/`))) continue;
      let data = readFileSync(full, 'utf8');
      if (rel === '.claude-plugin/plugin.json') {
        const plugin = JSON.parse(data) as Record<string, unknown>;
        plugin.version = version;
        data = JSON.stringify(plugin, null, 2);
      }
      if (opts.patch?.[rel] !== undefined) data = opts.patch[rel]!;
      out.push({
        name: opts.wrap ? `${opts.wrap}/${rel}` : rel,
        data,
        ...(rel.endsWith('.py') || rel.endsWith('.js') ? { unixMode: 0o100755 } : {}),
      });
    }
  };
  walk(FIXTURE);
  return out;
}

type Hub = {
  fetch: OrgHarnessFetch;
  calls: { url: string; headers: Record<string, string> }[];
  offline: boolean;
  bootstrapStatus: number;
  publish(version: string, zip: Buffer, sha?: string): void;
};

/** A fake Skill Hub. `publish` sets what the marketplace offers next. */
function fakeHub(): Hub {
  let offered: { version: string; zip: Buffer; sha: string } | undefined;
  const hub: Hub = {
    calls: [],
    offline: false,
    bootstrapStatus: 200,
    publish(version, zip, sha) {
      offered = { version, zip, sha: sha ?? sha256(zip) };
    },
    fetch: async (url, init) => {
      hub.calls.push({ url, headers: { ...(init?.headers ?? {}) } });
      if (hub.offline) throw new TypeError('fetch failed (offline)');
      const respond = (status: number, body: unknown, bytes?: Buffer) => ({
        status,
        json: async () => body,
        arrayBuffer: async () => {
          const b = bytes ?? Buffer.from(JSON.stringify(body));
          return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
        },
      });
      if (url === MARKETPLACE) {
        return respond(200, {
          name: 'altimedia-skills',
          plugins: offered
            ? [
                { name: 'something-else', version: '9.9.9', source: { url: '/x', sha256: '0'.repeat(64) } },
                {
                  name: 'altimedia-harness',
                  version: offered.version,
                  source: { url: '/api/v1/plugins/altimedia-harness/download', sha256: offered.sha },
                },
              ]
            : [],
        });
      }
      if (url === 'https://hub.test/api/v1/plugins/altimedia-harness/download') {
        return offered ? respond(200, null, offered.zip) : respond(404, null);
      }
      if (url === BOOTSTRAP) {
        if (hub.bootstrapStatus === 200) {
          return respond(200, { env: { HARNESS_METRICS_TOKEN: 'hmt_spike_token' } });
        }
        return respond(hub.bootstrapStatus, { error: 'nope' });
      }
      return respond(404, null);
    },
  };
  return hub;
}

function ctxFor(home: string, extra: Partial<OrgHarnessContext> = {}): OrgHarnessContext {
  return { home, apiKey: KEY, env: {}, ...extra };
}

async function sync(
  store: SqliteStore,
  home: string,
  hub: Hub,
  extra: Partial<OrgHarnessContext> & { now?: () => number } = {},
) {
  return runOrgHarnessSync(store, {
    ...ctxFor(home, extra),
    fetch: hub.fetch,
    marketplaceUrl: MARKETPLACE,
    bootstrapUrl: BOOTSTRAP,
    ...(extra.now ? { now: extra.now } : {}),
  });
}

/** Raw table dump — the "byte-identical" comparison reads the file, not the API. */
function dumpTables(dbPath: string): { harness: string; settings: string; userVersion: number } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const harness = JSON.stringify(db.prepare('SELECT * FROM harness_items ORDER BY id').all());
    const settings = JSON.stringify(db.prepare('SELECT * FROM settings ORDER BY key').all());
    const uv = db.prepare('PRAGMA user_version').get() as { user_version: number };
    return { harness, settings, userVersion: Number(uv.user_version) };
  } finally {
    db.close();
  }
}

function orgRowsOf(store: SqliteStore): HarnessItem[] {
  return store.listHarness('org', ORG_HARNESS_SCOPE_KEY, { kind: 'skill' });
}
function orgRow(store: SqliteStore, name: string): HarnessItem | undefined {
  return orgRowsOf(store).find((r) => r.name === name);
}
function statusMap(store: SqliteStore): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of orgRowsOf(store)) out[r.name] = `${r.status}|${r.provenance.origin}`;
  return out;
}

/** A user's existing data, as a pre-upgrade install would have it. */
function seedExistingUser(store: SqliteStore, home: string): void {
  store.putHarnessItem({
    item: {
      scope: 'user',
      scopeKey: DEFAULT_USER_ID,
      kind: 'command',
      name: 'standup',
      provenance: { source: 'user' },
      command: { template: 'Summarize what I did yesterday.' },
    },
    requestedStatus: 'enabled',
  });
  store.putHarnessItem({
    item: {
      scope: 'user',
      scopeKey: DEFAULT_USER_ID,
      kind: 'skill',
      name: 'review-style',
      provenance: { source: 'external', origin: join(home, 'skills/review-style/SKILL.md') },
      skill: { instructions: 'Review with short bullet points.' },
    },
    requestedStatus: 'enabled',
    autoEnable: true,
  });
  store.setSetting('gate.allowChanges', 'true');
  store.setSetting('harness.builtin.explorer.autoStatus', 'enabled');
}

function fixtureBody(name: string): string {
  return parseSkillFrontmatter(readFileSync(join(FIXTURE, 'skills', name, 'SKILL.md'), 'utf8')).body.trim();
}

function putCopy(
  store: SqliteStore,
  home: string,
  name: string,
  body: string,
  where: { scope: 'user' | 'project'; scopeKey: string },
): HarnessItem {
  return store.putHarnessItem({
    item: {
      scope: where.scope,
      scopeKey: where.scopeKey,
      kind: 'skill',
      name,
      description: `${name} copy installed from Skill Hub`,
      provenance: {
        source: 'external',
        origin: join(where.scope === 'user' ? home : where.scopeKey, '.naby/skills', name, 'SKILL.md'),
        format: 'claude-skill-md',
      },
      skill: { instructions: body },
    },
    requestedStatus: 'enabled',
    autoEnable: true,
  });
}

// ---------------------------------------------------------------------------
// Unit-level: zip reader, frontmatter
// ---------------------------------------------------------------------------

function zipChecks(): void {
  const dest = join(SPIKE_ROOT, 'zip-unit');
  const tryExtract = (entries: ZipWriteEntry[], sub: string): string => {
    try {
      extractZip(buildZip(entries), join(dest, sub));
      return 'ok';
    } catch (e) {
      return e instanceof ZipError ? e.code : `other:${String(e)}`;
    }
  };
  const ok = tryExtract([{ name: 'a/b.txt', data: 'hello' }, { name: 'c.txt', data: 'x', method: 0 }], 'ok');
  record(
    '[zip] a well-formed archive extracts (deflate + stored)',
    ok === 'ok' && readFileSync(join(dest, 'ok/a/b.txt'), 'utf8') === 'hello',
    ok,
  );
  const slips: [string, string][] = [
    ['../evil.txt', 'parent segment'],
    ['skills/../../evil.txt', 'nested parent segment'],
    ['/abs/evil.txt', 'absolute'],
    ['C:/evil.txt', 'drive letter'],
    ['a\\..\\evil.txt', 'backslash'],
  ];
  for (const [name, why] of slips) {
    const r = tryExtract([{ name: 'fine.txt', data: '1' }, { name, data: 'pwned' }], `slip-${why.replace(/\W/g, '')}`);
    record(`[zip] zip-slip refused: ${why} ("${name}")`, r === 'unsafe-path', r);
  }
  record(
    '[zip] nothing was written outside the destination by any refused archive',
    !existsSync(join(dest, 'evil.txt')) && !existsSync(join(SPIKE_ROOT, 'evil.txt')),
  );
  record(
    '[zip] a refused archive writes NOTHING (names are validated before any byte)',
    !existsSync(join(dest, 'slip-parentsegment', 'fine.txt')),
  );
  const link = tryExtract([{ name: 'link', data: '/etc/passwd', unixMode: 0o120777 }], 'symlink');
  record('[zip] symlink entries are refused', link === 'symlink', link);
  const crc = tryExtract([{ name: 'a.txt', data: 'one' }, { name: 'b.txt', data: 'two', corruptCrc: true }], 'crc');
  record('[zip] a CRC mismatch is detected', crc === 'crc', crc);
  const dup = tryExtract([{ name: 'a.txt', data: '1' }, { name: 'a.txt', data: '2' }], 'dup');
  record('[zip] duplicate names are refused', dup === 'duplicate', dup);

  const ctx = parseSkillFrontmatter(readFileSync(join(FIXTURE, 'skills/ctx/SKILL.md'), 'utf8'));
  record(
    '[frontmatter] single-quoted description (ctx) parses to its text',
    ctx.data.name === 'ctx' &&
      (ctx.data.description ?? '').startsWith('컨텍스트 4계층') &&
      (ctx.data.description ?? '').endsWith('최소 상태 문서".'),
    (ctx.data.description ?? '').slice(0, 40),
  );
  const task = parseSkillFrontmatter(readFileSync(join(FIXTURE, 'skills/task/SKILL.md'), 'utf8'));
  record(
    '[frontmatter] plain description containing colons and quotes (task) parses whole',
    (task.data.description ?? '').includes('TRIGGER —') && (task.data.description ?? '').endsWith('하지 않는다.'),
    (task.data.description ?? '').slice(-30),
  );
}

// ---------------------------------------------------------------------------
// §4.9 case 1 — fresh DB, skill-hub configured
// ---------------------------------------------------------------------------

async function case1(): Promise<void> {
  const { home, dbPath, store } = freshCase('case1');
  const hub = fakeHub();
  hub.publish('0.7.1', buildZip(fixtureEntries('0.7.1')));
  const report = await sync(store, home, hub);
  const rows = orgRowsOf(store);
  record(
    '[case 1] fresh DB: package installed and three org rows arrive',
    report.package?.outcome === 'updated' && rows.length === 3,
    `${report.package?.outcome} rows=${rows.map((r) => r.name).join(',')}`,
  );
  record(
    '[case 1] rows arrive ENABLED with scope org / origin org:altimedia-harness@0.7.1',
    rows.every(
      (r) =>
        r.status === 'enabled' &&
        r.scope === 'org' &&
        r.scopeKey === ORG_HARNESS_SCOPE_KEY &&
        r.provenance.origin === 'org:altimedia-harness@0.7.1',
    ),
    JSON.stringify(statusMap(store)),
  );
  const task = orgRow(store, 'task');
  const desc = (parseSkillFrontmatter(readFileSync(join(FIXTURE, 'skills/task/SKILL.md'), 'utf8')).data
    .description ?? '').replace(/\s+/g, ' ').trim();
  record(
    '[§3.2] payload.skill: instructions = description paragraph only, no body',
    task?.skill?.instructions === desc && !task.skill.instructions.includes('Synthetic body'),
    task?.skill?.instructions.slice(0, 40),
  );
  record(
    '[§3.2] payload.skill: toolRefs [naby_skill_load, run_command], loadMode on-demand, packageRef',
    JSON.stringify(task?.skill?.toolRefs) === '["naby_skill_load","run_command"]' &&
      task?.skill?.loadMode === 'on-demand' &&
      task?.skill?.packageRef === 'altimedia-harness',
    JSON.stringify(task?.skill),
  );
  record(
    '[§3.2] no new trust tier: provenance.source is an existing tier (artifact)',
    rows.every((r) => r.provenance.source === 'artifact'),
  );
  record(
    '[§3.2] autoStatus recorded as enabled under harness.org.<name>.autoStatus',
    rows.every((r) => store.getSetting(orgHarnessAutoStatusKey(r.name)) === 'enabled'),
  );
  const pkg = readCurrentOrgPackage(home);
  record(
    '[§3.1] files extracted under <NABY_HOME>/org/altimedia-harness/0.7.1 with current pointer',
    pkg?.version === '0.7.1' &&
      pkg.dir === join(orgHarnessRoot(home), '0.7.1') &&
      existsSync(join(pkg.dir, 'skills/task/scripts/main.py')) &&
      existsSync(join(pkg.dir, 'hooks/hooks.json')),
    pkg?.dir,
  );
  const exec = statSync(join(pkg!.dir, 'skills/task/scripts/main.py')).mode & 0o111;
  record('[§3.1] executable bits survive extraction (unix)', process.platform === 'win32' || exec !== 0, `mode&111=${exec}`);
  const dump = dumpTables(dbPath);
  record(
    '[§4.1] SCHEMA_VERSION stays 13 and the DB reports user_version 13',
    SCHEMA_VERSION === 13 && dump.userVersion === 13,
    `SCHEMA_VERSION=${SCHEMA_VERSION} user_version=${dump.userVersion}`,
  );
  const injected = retrieveSkillsForInjection(
    store,
    { userText: 'hello', tokenBudget: 3000, availableTools: ['run_command', 'read_file'] },
    { orgId: ORG_HARNESS_SCOPE_KEY },
  );
  record(
    '[case 1] new install: the org rows are not injected without naby_skill_load (M2 adds it)',
    injected.skills.length === 0 && injected.excludedForTools === 3,
    `skills=${injected.skills.length} excludedForTools=${injected.excludedForTools}`,
  );
  store.close();
}

// ---------------------------------------------------------------------------
// §4.9 case 2 — v13 DB, skill-hub NOT configured: byte-identical
// ---------------------------------------------------------------------------

async function case2(): Promise<void> {
  const { home, dbPath, store } = freshCase('case2');
  seedExistingUser(store, home);
  store.close();
  const before = dumpTables(dbPath);

  // "Upgrade": the new build opens the same file and runs its boot + turn paths.
  const upgraded = new SqliteStore({ path: dbPath });
  const hub = fakeHub();
  hub.publish('0.7.1', buildZip(fixtureEntries('0.7.1')));
  const report = await runOrgHarnessSync(upgraded, {
    home,
    env: {},
    fetch: hub.fetch,
    marketplaceUrl: MARKETPLACE,
    bootstrapUrl: BOOTSTRAP,
  });
  const turn1 = applyOrgHarnessIfDue(upgraded, { home, env: {} });
  const turn2 = applyOrgHarnessIfDue(upgraded, { home, env: {} });
  const state = readOrgHarnessState(upgraded, { home, env: {} });
  upgraded.close();
  const after = dumpTables(dbPath);

  record('[case 2] no skill-hub: zero network calls', hub.calls.length === 0, `calls=${hub.calls.length}`);
  record(
    '[case 2] no skill-hub: sync and turn-boundary apply report skipped',
    report.skipped === 'no-skill-hub' && turn1.ran === 'skipped' && turn2.ran === 'skipped',
    `${report.skipped} ${turn1.ran} ${turn2.ran}`,
  );
  record('[case 2] harness_items byte-identical before/after', before.harness === after.harness);
  record('[case 2] settings byte-identical before/after', before.settings === after.settings);
  record('[case 2] user_version unchanged (13)', before.userVersion === 13 && after.userVersion === 13);
  record('[case 2] nothing written under <NABY_HOME>/org', !existsSync(join(home, 'org')));
  record(
    '[case 2] the state reader reports "not configured" without writing',
    state.configured === false && state.on === false && state.offReason === 'no-skill-hub',
  );
}

// ---------------------------------------------------------------------------
// §4.9 case 3 — v13 DB with user data, skill-hub configured, no same-name copy
// ---------------------------------------------------------------------------

async function case3(): Promise<void> {
  const { home, dbPath, store } = freshCase('case3');
  seedExistingUser(store, home);
  const userBefore = JSON.stringify(store.listHarness('user', DEFAULT_USER_ID));
  const hub = fakeHub();
  hub.publish('0.7.1', buildZip(fixtureEntries('0.7.1')));
  const report = await sync(store, home, hub);
  record(
    '[case 3] skill-hub configured: org rows arrive enabled',
    report.apply?.added.length === 3 && orgRowsOf(store).every((r) => r.status === 'enabled'),
    JSON.stringify(report.apply?.added),
  );
  record(
    '[case 3] existing user rows untouched',
    JSON.stringify(store.listHarness('user', DEFAULT_USER_ID)) === userBefore,
  );
  record('[case 3] no same-name copy ⇒ no notices', readOrgCopyNotices(store).length === 0);

  // §3.1 rerun is a no-op (sync + apply).
  const rowsBefore = dumpTables(dbPath);
  const again = await sync(store, home, hub);
  const turn = applyOrgHarnessIfDue(store, ctxFor(home));
  const rowsAfter = dumpTables(dbPath);
  const settingsSansLastSync = (s: string) =>
    JSON.stringify((JSON.parse(s) as { key: string }[]).filter((r) => r.key !== ORG_HARNESS_SETTING.lastSync));
  record(
    '[§3.1] rerun: package outcome "current", rows not rewritten (apply ran copies-only)',
    again.package?.outcome === 'current' && again.apply?.ran === 'copies' && turn.ran === 'copies',
    `${again.package?.outcome} ${again.apply?.ran} ${turn.ran}`,
  );
  record('[§3.1] rerun: harness_items byte-identical', rowsBefore.harness === rowsAfter.harness);
  record(
    '[§3.1] rerun: settings byte-identical except the lastSync timestamp',
    settingsSansLastSync(rowsBefore.settings) === settingsSansLastSync(rowsAfter.settings),
  );
  record(
    '[§3.1] rerun: no download (only marketplace + no bootstrap — activation cached for today)',
    hub.calls.filter((c) => c.url.endsWith('/download')).length === 1 &&
      hub.calls.filter((c) => c.url === BOOTSTRAP).length === 1,
    hub.calls.map((c) => c.url.split('/').pop()).join(','),
  );
  store.close();
}

// ---------------------------------------------------------------------------
// §4.9 case 4 — unmodified task copy; use-org-version; switch round trip
// ---------------------------------------------------------------------------

async function case4(): Promise<void> {
  const { home, store } = freshCase('case4');
  const copy = putCopy(store, home, 'task', fixtureBody('task'), { scope: 'user', scopeKey: DEFAULT_USER_ID });
  const hub = fakeHub();
  hub.publish('0.7.1', buildZip(fixtureEntries('0.7.1')));
  await sync(store, home, hub);

  const afterUpgrade = store.getHarnessItem(copy.id)!;
  const notices = readOrgCopyNotices(store);
  record('[case 4] the copy stays ENABLED after upgrade (never auto-disabled)', afterUpgrade.status === 'enabled');
  record(
    '[case 4] notice: task / user scope / "unmodified"',
    notices.length === 1 && notices[0]!.name === 'task' && notices[0]!.scope === 'user' && notices[0]!.copy === 'unmodified',
    JSON.stringify(notices),
  );

  const chosen = useOrgVersion(store, 'task', ctxFor(home));
  const marked = store.getHarnessItem(copy.id)!;
  record(
    '[case 4] use-org-version: copy disabled and marked supersededBy org:altimedia-harness',
    chosen.ok && marked.status === 'disabled' && marked.provenance.supersededBy === ORG_SUPERSEDED_BY,
    `${marked.status} ${marked.provenance.supersededBy}`,
  );
  record('[case 4] use-org-version: the notice is gone', readOrgCopyNotices(store).length === 0);
  record(
    '[case 4] use-org-version: the copy row is kept (not deleted), body intact',
    marked.skill?.instructions === fixtureBody('task'),
  );

  // A naby-home rescan re-states the copy's provenance from its file (refresh);
  // the user's decision must survive that.
  store.putHarnessItem({
    item: {
      ...(({ id: _i, createdAt: _c, updatedAt: _u, status: _s, ...rest }) => rest)(marked),
      provenance: { source: 'external', origin: marked.provenance.origin, format: 'claude-skill-md' },
      skill: { instructions: `${fixtureBody('task')}\n\nlocal tweak` },
    },
    requestedStatus: 'enabled',
    refresh: true,
  });
  const rescanned = store.getHarnessItem(copy.id)!;
  record(
    '[case 4] a rescan refresh keeps supersededBy and the disabled status',
    rescanned.provenance.supersededBy === ORG_SUPERSEDED_BY && rescanned.status === 'disabled',
    `${rescanned.status} ${rescanned.provenance.supersededBy}`,
  );

  // §4.8 — the settings toggle.
  const snapshot = (): string =>
    JSON.stringify({
      org: statusMap(store),
      copy: store.getHarnessItem(copy.id)!.status,
      marker: store.getHarnessItem(copy.id)!.provenance.supersededBy ?? null,
    });
  const onState = snapshot();
  const off = setOrgHarnessEnabled(store, false, ctxFor(home));
  const offRows = orgRowsOf(store);
  record(
    '[§4.8] toggle off: every org row disabled, none deleted',
    off.on === false && offRows.length === 3 && offRows.every((r) => r.status === 'disabled'),
    JSON.stringify(statusMap(store)),
  );
  record(
    '[§4.8] toggle off: the superseded copy is enabled again',
    store.getHarnessItem(copy.id)!.status === 'enabled',
  );
  const on = setOrgHarnessEnabled(store, true, ctxFor(home));
  record(
    '[§4.8] toggle back on: exactly the previous state (org rows enabled, copy disabled + marked)',
    on.on === true && snapshot() === onState,
    `${snapshot()} vs ${onState}`,
  );

  // §4.8 — the environment switch, same round trip.
  const envOff = applyOrgHarnessIfDue(store, ctxFor(home, { env: { [ORG_HARNESS_ENV_SWITCH]: '0' } }));
  const envOffOk =
    envOff.on === false &&
    envOff.offReason === 'env-off' &&
    orgRowsOf(store).every((r) => r.status === 'disabled') &&
    store.getHarnessItem(copy.id)!.status === 'enabled';
  record('[§4.8] NABY_ORG_HARNESS=0: org rows off, copy back', envOffOk, JSON.stringify(statusMap(store)));
  applyOrgHarnessIfDue(store, ctxFor(home));
  record('[§4.8] NABY_ORG_HARNESS unset again: previous state restored', snapshot() === onState, snapshot());

  // §4.5 "turning the copy back on returns it to how it was".
  store.setHarnessEnabled(copy.id, true);
  applyOrgHarnessIfDue(store, ctxFor(home));
  const reenabled = store.getHarnessItem(copy.id)!;
  record(
    '[case 4] user re-enables the copy: marker cleared, notice back (back to before the choice)',
    reenabled.status === 'enabled' &&
      reenabled.provenance.supersededBy === undefined &&
      readOrgCopyNotices(store).some((n) => n.name === 'task'),
    `${reenabled.status} ${reenabled.provenance.supersededBy} ${JSON.stringify(readOrgCopyNotices(store))}`,
  );
  record(
    '[case 4] the rescanned copy now reads "edited" (body differs from the package)',
    readOrgCopyNotices(store).find((n) => n.name === 'task')?.copy === 'edited',
  );
  store.close();
}

// ---------------------------------------------------------------------------
// §4.9 case 5 — edited pdoc copy (project scope); keep-mine
// ---------------------------------------------------------------------------

async function case5(): Promise<void> {
  const { home, store } = freshCase('case5');
  const cwd = join(home, 'work', 'proj');
  store.upsertProject(cwd);
  const copy = putCopy(store, home, 'pdoc', `${fixtureBody('pdoc')}\n\n## My team's extra rules\n`, {
    scope: 'project',
    scopeKey: cwd,
  });
  const disabledCopy = putCopy(store, home, 'ctx', fixtureBody('ctx'), { scope: 'user', scopeKey: DEFAULT_USER_ID });
  store.setHarnessEnabled(disabledCopy.id, false);
  const tombCopy = putCopy(store, home, 'task', fixtureBody('task'), { scope: 'user', scopeKey: DEFAULT_USER_ID });
  store.setHarnessStatus(tombCopy.id, 'removed');

  const hub = fakeHub();
  hub.publish('0.7.1', buildZip(fixtureEntries('0.7.1')));
  await sync(store, home, hub);
  const notices = readOrgCopyNotices(store);
  record('[case 5] edited copy stays enabled', store.getHarnessItem(copy.id)!.status === 'enabled');
  record(
    '[case 5] notice: pdoc / project scope / "edited"',
    notices.length === 1 && notices[0]!.name === 'pdoc' && notices[0]!.scope === 'project' && notices[0]!.copy === 'edited',
    JSON.stringify(notices),
  );
  record(
    '[§4.5] a disabled copy and a tombstoned copy are left alone and raise no notice',
    store.getHarnessItem(disabledCopy.id)!.status === 'disabled' &&
      store.getHarnessItem(tombCopy.id)!.status === 'removed' &&
      !notices.some((n) => n.name === 'ctx' || n.name === 'task'),
  );
  const kept = keepUserCopy(store, 'pdoc', ctxFor(home));
  record(
    '[case 5] keep-mine: notice suppressed, nothing changed, keepUserCopy recorded',
    kept.ok &&
      readOrgCopyNotices(store).length === 0 &&
      store.getHarnessItem(copy.id)!.status === 'enabled' &&
      store.getSetting('harness.org.pdoc.keepUserCopy') === 'true',
  );
  hub.publish('0.7.2', buildZip(fixtureEntries('0.7.2')));
  await sync(store, home, hub);
  record(
    '[case 5] keep-mine survives a version bump (notice does not come back)',
    orgRow(store, 'pdoc')?.provenance.origin === 'org:altimedia-harness@0.7.2' &&
      readOrgCopyNotices(store).length === 0,
  );
  const state = readOrgHarnessState(store, ctxFor(home));
  record(
    '[case 5] state reader exposes keepUserCopy and no secret',
    state.keepUserCopy.includes('pdoc') && !JSON.stringify(state).includes(KEY) && !JSON.stringify(state).includes('hmt_'),
  );
  store.close();
}

// ---------------------------------------------------------------------------
// §4.9 case 6 — offline first boot
// ---------------------------------------------------------------------------

async function case6(): Promise<void> {
  const { home, dbPath, store } = freshCase('case6');
  seedExistingUser(store, home);
  const hub = fakeHub();
  hub.publish('0.7.1', buildZip(fixtureEntries('0.7.1')));
  hub.offline = true;
  const query = { userText: 'review this', tokenBudget: 3000, availableTools: ['run_command', 'read_file'] };
  const injectBefore = JSON.stringify(retrieveSkillsForInjection(store, query, { orgId: ORG_HARNESS_SCOPE_KEY }));
  const harnessBefore = dumpTables(dbPath).harness;

  const report = await sync(store, home, hub);
  const turn = applyOrgHarnessIfDue(store, ctxFor(home));
  const injectAfter = JSON.stringify(retrieveSkillsForInjection(store, query, { orgId: ORG_HARNESS_SCOPE_KEY }));
  record(
    '[case 6] offline: activation unreachable (not a failure), package unreachable',
    report.activation?.status === 'unreachable' && report.package?.outcome === 'unreachable',
    `${report.activation?.status} ${report.package?.outcome}`,
  );
  record(
    '[case 6] offline: the org harness is NOT switched off by a network failure',
    readOrgHarnessState(store, ctxFor(home)).on === true,
  );
  record('[case 6] offline: harness rows unchanged', dumpTables(dbPath).harness === harnessBefore);
  record('[case 6] offline: the first turn injects exactly what it did before', injectAfter === injectBefore);
  record('[case 6] offline: no package on disk, no org rows', !readCurrentOrgPackage(home) && orgRowsOf(store).length === 0 && turn.added.length === 0);

  hub.offline = false;
  const online = await sync(store, home, hub);
  record(
    '[case 6] connected later: the package lands and rows are applied',
    online.package?.outcome === 'updated' && orgRowsOf(store).length === 3,
    `${online.package?.outcome} rows=${orgRowsOf(store).length}`,
  );
  store.close();
}

// ---------------------------------------------------------------------------
// §4.9 case 8 — the current skill-inject does not inject org rows
// ---------------------------------------------------------------------------

async function case8(): Promise<void> {
  const { home, store } = freshCase('case8');
  const hub = fakeHub();
  hub.publish('0.7.1', buildZip(fixtureEntries('0.7.1')));
  await sync(store, home, hub);
  const tools = ['run_command', 'read_file', 'write_file', 'edit_file'];
  const plain = retrieveSkillsForInjection(
    store,
    { userText: '회의록 작업 시작', tokenBudget: 3000, availableTools: tools },
    { orgId: ORG_HARNESS_SCOPE_KEY },
  );
  record(
    '[case 8] org rows are not injected; all three counted in excludedForTools',
    plain.skills.every((s) => s.scope !== 'org') && plain.excludedForTools === 3,
    `injected=${plain.skills.map((s) => s.name).join(',')} excluded=${plain.excludedForTools}`,
  );
  const named = retrieveSkillsForInjection(
    store,
    { userText: '/task start 회의록', tokenBudget: 3000, availableTools: tools, explicitNames: ['task'] },
    { orgId: ORG_HARNESS_SCOPE_KEY },
  );
  record(
    '[case 8] naming the skill does not bypass the tool gate (still excluded, still counted)',
    named.skills.every((s) => s.scope !== 'org') && named.excludedForTools === 3,
    `excluded=${named.excludedForTools}`,
  );
  const none = retrieveSkillsForInjection(store, { userText: 'x', tokenBudget: 3000 }, { orgId: ORG_HARNESS_SCOPE_KEY });
  record(
    '[case 8] a caller that passes no availableTools also excludes and counts them',
    none.skills.length === 0 && none.excludedForTools === 3,
  );
  store.close();
}

// ---------------------------------------------------------------------------
// §3.1 integrity, interruption, retention, wrapping
// ---------------------------------------------------------------------------

async function packageChecks(): Promise<void> {
  const { home, store } = freshCase('package');
  const hub = fakeHub();
  hub.publish('0.7.1', buildZip(fixtureEntries('0.7.1')));
  await sync(store, home, hub);
  const root = orgHarnessRoot(home);

  // sha256 mismatch.
  const good072 = buildZip(fixtureEntries('0.7.2'));
  hub.publish('0.7.2', good072, sha256(Buffer.from('not the zip')));
  const mismatch = await sync(store, home, hub);
  record(
    '[§3.1] sha256 mismatch: rejected, nothing written, previous version stays current',
    mismatch.package?.outcome === 'integrity-mismatch' &&
      readCurrentOrgPackage(home)?.version === '0.7.1' &&
      !existsSync(join(root, '0.7.2')) &&
      readdirSync(root).every((n) => !n.startsWith('.staging-')) &&
      orgRow(store, 'task')?.provenance.origin === 'org:altimedia-harness@0.7.1',
    `${mismatch.package?.outcome} ${mismatch.package?.detail?.slice(0, 50)}`,
  );

  // Interrupted extract: valid digest, but an entry fails mid-way.
  const corrupt = fixtureEntries('0.7.2');
  corrupt[corrupt.length - 1] = { ...corrupt[corrupt.length - 1]!, corruptCrc: true };
  hub.publish('0.7.2', buildZip(corrupt));
  const broken = await sync(store, home, hub);
  record(
    '[§3.1] interrupted extract: previous version kept, no partial folder, staging removed',
    broken.package?.outcome === 'invalid-package' &&
      readCurrentOrgPackage(home)?.version === '0.7.1' &&
      !existsSync(join(root, '0.7.2')) &&
      readdirSync(root).every((n) => !n.startsWith('.staging-')),
    `${broken.package?.outcome} ${broken.package?.detail}`,
  );

  // A crash between extract and rename leaves a staging dir; a crash before the
  // pointer flip leaves a complete folder current.json does not name.
  const stale = join(root, '.staging-0.7.2-999-deadbeef');
  mkdirSync(join(stale, 'skills/task'), { recursive: true });
  writeFileSync(join(stale, 'skills/task/SKILL.md'), 'half');
  const old = (Date.now() - 60 * 60 * 1000) / 1000;
  utimesSync(stale, old, old);
  record(
    '[§3.1] a crashed run\'s staging dir is never mistaken for a version',
    readCurrentOrgPackage(home)?.version === '0.7.1' && !listOrgPackageVersions(home).includes('0.7.2'),
  );

  // Zip-slip inside a correctly-hashed package.
  const slip = [...fixtureEntries('0.7.2'), { name: '../../escaped.txt', data: 'pwned' }];
  hub.publish('0.7.2', buildZip(slip));
  const slipped = await sync(store, home, hub);
  record(
    '[§3.1] zip-slip package (correct sha256) refused; nothing escapes; previous kept',
    slipped.package?.outcome === 'invalid-package' &&
      (slipped.package.detail ?? '').startsWith('unsafe-path') &&
      !existsSync(join(home, 'org', 'escaped.txt')) &&
      !existsSync(join(home, 'escaped.txt')) &&
      readCurrentOrgPackage(home)?.version === '0.7.1',
    slipped.package?.detail,
  );

  // A good 0.7.2, then 0.7.3 wrapped in a top folder: retention + wrapping.
  hub.publish('0.7.2', good072);
  const upd = await sync(store, home, hub);
  record(
    '[§3.1] next good version installs; stale staging cleaned up',
    upd.package?.outcome === 'updated' &&
      readCurrentOrgPackage(home)?.version === '0.7.2' &&
      !existsSync(stale),
    `${upd.package?.outcome} entries=${readdirSync(root).join(',')}`,
  );
  hub.publish('0.7.3', buildZip(fixtureEntries('0.7.3', { wrap: 'altimedia-harness' })));
  const wrapped = await sync(store, home, hub);
  record(
    '[§3.1] a package wrapped in one top folder is accepted',
    wrapped.package?.outcome === 'updated' && readCurrentOrgPackage(home)?.version === '0.7.3',
    wrapped.package?.detail,
  );
  record(
    '[§3.1] exactly one previous version kept (0.7.2 + 0.7.3; 0.7.1 deleted)',
    JSON.stringify(listOrgPackageVersions(home)) === JSON.stringify(['0.7.2', '0.7.3']),
    JSON.stringify(readdirSync(root)),
  );

  // Direct call to the package sync with a hostile marketplace entry.
  const badVersion: OrgHarnessFetch = async (url) => ({
    status: 200,
    json: async () =>
      url.endsWith('marketplace.json')
        ? { plugins: [{ name: 'altimedia-harness', version: '../../x', source: { url: '/d', sha256: 'a'.repeat(64) } }] }
        : null,
    arrayBuffer: async () => new ArrayBuffer(0),
  });
  const bad = await syncOrgHarnessPackage({ home, fetch: badVersion, marketplaceUrl: MARKETPLACE });
  record('[§3.1] an unsafe version string from the marketplace is refused', bad.outcome === 'no-plugin', bad.detail);
  store.close();
}

// ---------------------------------------------------------------------------
// §3.2 versions: user toggles, withdrawal, revival, user deletes
// ---------------------------------------------------------------------------

async function rowChecks(): Promise<void> {
  const { home, store } = freshCase('rows');
  const hub = fakeHub();
  hub.publish('0.7.1', buildZip(fixtureEntries('0.7.1')));
  await sync(store, home, hub);

  store.setHarnessEnabled(orgRow(store, 'ctx')!.id, false); // the user turns ctx off
  hub.publish('0.7.2', buildZip(fixtureEntries('0.7.2')));
  const v2 = await sync(store, home, hub);
  const ctx = orgRow(store, 'ctx')!;
  record(
    '[§3.2] user-disabled row stays disabled across a version update (content updated)',
    ctx.status === 'disabled' && ctx.provenance.origin === 'org:altimedia-harness@0.7.2' && v2.apply?.updated.length === 3,
    `${ctx.status} ${ctx.provenance.origin}`,
  );
  setOrgHarnessEnabled(store, false, ctxFor(home));
  setOrgHarnessEnabled(store, true, ctxFor(home));
  record(
    '[§3.2] user-disabled row stays disabled across the switch round trip (userOwned)',
    orgRow(store, 'ctx')!.status === 'disabled' && orgRow(store, 'task')!.status === 'enabled',
    JSON.stringify(statusMap(store)),
  );

  hub.publish('0.7.3', buildZip(fixtureEntries('0.7.3', { drop: ['pdoc'] })));
  const v3 = await sync(store, home, hub);
  const pdoc = orgRow(store, 'pdoc')!;
  record(
    '[§3.2] dropped skill → removed with origin org-withdrawn:… (not a user tombstone)',
    pdoc.status === 'removed' &&
      pdoc.provenance.origin === 'org-withdrawn:altimedia-harness@0.7.2' &&
      JSON.stringify(v3.apply?.withdrawn) === '["pdoc"]',
    `${pdoc.status} ${pdoc.provenance.origin}`,
  );
  // The user deletes task (a real tombstone, origin stays org:).
  store.setHarnessStatus(orgRow(store, 'task')!.id, 'removed');
  hub.publish('0.7.4', buildZip(fixtureEntries('0.7.4')));
  const v4 = await sync(store, home, hub);
  const revived = orgRow(store, 'pdoc')!;
  record(
    '[§3.2] a withdrawn skill that returns is revived, enabled, at the new version',
    revived.status === 'enabled' &&
      revived.provenance.origin === 'org:altimedia-harness@0.7.4' &&
      JSON.stringify(v4.apply?.revived) === '["pdoc"]',
    `${revived.status} ${revived.provenance.origin}`,
  );
  record(
    '[§3.2] a user-deleted org row is never revived by a later version',
    orgRow(store, 'task')!.status === 'removed' &&
      (orgRow(store, 'task')!.provenance.origin ?? '').startsWith('org:altimedia-harness@'),
    `${orgRow(store, 'task')!.status} ${orgRow(store, 'task')!.provenance.origin}`,
  );
  record('[§3.2] the user-disabled row is still disabled at 0.7.4', orgRow(store, 'ctx')!.status === 'disabled');

  // Withdrawn while the user had it disabled ⇒ comes back disabled.
  hub.publish('0.7.5', buildZip(fixtureEntries('0.7.5', { drop: ['ctx'] })));
  await sync(store, home, hub);
  hub.publish('0.7.6', buildZip(fixtureEntries('0.7.6')));
  await sync(store, home, hub);
  record(
    '[§3.2] a withdrawn row the user had disabled comes back disabled',
    orgRow(store, 'ctx')!.status === 'disabled' && orgRow(store, 'ctx')!.provenance.origin === 'org:altimedia-harness@0.7.6',
    `${orgRow(store, 'ctx')!.status} ${orgRow(store, 'ctx')!.provenance.origin}`,
  );

  // Preset removed later: with org rows present and no key, the harness is off.
  const removed = applyOrgHarnessIfDue(store, { home, env: {} });
  record(
    '[§4.3] skill-hub preset removed after install: org rows switched off, not deleted',
    removed.on === false &&
      removed.offReason === 'no-skill-hub' &&
      orgRowsOf(store).filter((r) => r.status !== 'removed').every((r) => r.status === 'disabled'),
    JSON.stringify(statusMap(store)),
  );
  store.close();
}

// ---------------------------------------------------------------------------
// §3.6 activation
// ---------------------------------------------------------------------------

async function activationChecks(): Promise<void> {
  const { home, store } = freshCase('activation');
  const hub = fakeHub();
  hub.publish('0.7.1', buildZip(fixtureEntries('0.7.1')));
  let clock = Date.parse('2026-10-07T03:00:00Z'); // 12:00 KST
  const now = () => clock;

  await sync(store, home, hub, { now });
  const boot = hub.calls.filter((c) => c.url === BOOTSTRAP);
  record(
    '[§3.6] bootstrap called with Bearer <key> and X-Harness-Client: naby',
    boot.length === 1 &&
      boot[0]!.headers.Authorization === `Bearer ${KEY}` &&
      boot[0]!.headers['X-Harness-Client'] === 'naby',
    JSON.stringify(boot[0]?.headers).replace(KEY, '<key>'),
  );
  record(
    '[§3.6] HARNESS_METRICS_TOKEN stored in naby settings',
    store.getSetting(ORG_HARNESS_SETTING.metricsToken) === 'hmt_spike_token',
  );
  record(
    '[§3.6] the activation record holds a key HASH and the KST day, never the key',
    (store.getSetting(ORG_HARNESS_SETTING.activation) ?? '').includes(orgHarnessKeyHash(KEY)) &&
      !(store.getSetting(ORG_HARNESS_SETTING.activation) ?? '').includes(KEY) &&
      (store.getSetting(ORG_HARNESS_SETTING.activation) ?? '').includes(kstDay(clock)),
  );
  clock += 6 * 60 * 60 * 1000; // 18:00 KST, same day
  await sync(store, home, hub, { now });
  record('[§3.6] same KST day, same key: no second bootstrap call', hub.calls.filter((c) => c.url === BOOTSTRAP).length === 1);
  clock += 7 * 60 * 60 * 1000; // 01:00 KST next day (still 16:00 UTC the same UTC day)
  await sync(store, home, hub, { now });
  record(
    '[§3.6] the KST day boundary (not UTC) triggers the next check',
    hub.calls.filter((c) => c.url === BOOTSTRAP).length === 2,
    `bootstrap calls=${hub.calls.filter((c) => c.url === BOOTSTRAP).length}`,
  );
  await sync(store, home, hub, { now, apiKey: 'shub_otherKeyBBBB' });
  record(
    '[§3.6] a changed key is re-checked immediately',
    hub.calls.filter((c) => c.url === BOOTSTRAP).length === 3,
  );

  // 401.
  hub.bootstrapStatus = 401;
  const bad = await sync(store, home, hub, { now, apiKey: 'shub_revokedCCCC' });
  const state = readOrgHarnessState(store, ctxFor(home, { apiKey: 'shub_revokedCCCC' }));
  record(
    '[§3.6] 401: org harness off, rows disabled, flag readable by the UI',
    bad.skipped === 'unauthorized' &&
      state.on === false &&
      state.offReason === 'unauthorized' &&
      state.auth === 'unauthorized' &&
      orgRowsOf(store).every((r) => r.status === 'disabled'),
    `${bad.skipped} ${state.offReason} ${state.auth} ${JSON.stringify(statusMap(store))}`,
  );
  record('[§3.6] 401: metrics token cleared', (store.getSetting(ORG_HARNESS_SETTING.metricsToken) ?? '') === '');
  const downloadsBefore = hub.calls.filter((c) => c.url.endsWith('/download')).length;
  record('[§3.6] 401: no package download attempted', downloadsBefore === 1);
  hub.bootstrapStatus = 200;
  await sync(store, home, hub, { now, apiKey: 'shub_freshDDDD' });
  record(
    '[§3.6] a new valid key turns it back on, same rows re-enabled',
    readOrgHarnessState(store, ctxFor(home, { apiKey: 'shub_freshDDDD' })).on === true &&
      orgRowsOf(store).every((r) => r.status === 'enabled'),
    JSON.stringify(statusMap(store)),
  );

  // Network error and 5xx are not failures.
  hub.bootstrapStatus = 503;
  clock += DAY_MS;
  const r503 = await checkOrgHarnessActivation(store, { apiKey: 'shub_freshDDDD', fetch: hub.fetch, now, url: BOOTSTRAP });
  record(
    '[§3.6] 5xx is "unreachable", the previous verdict stands',
    r503.status === 'unreachable' && readOrgHarnessState(store, ctxFor(home, { apiKey: 'shub_freshDDDD' })).on === true,
  );
  store.close();
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  zipChecks();
  await case1();
  await case2();
  await case3();
  await case4();
  await case5();
  await case6();
  await case8();
  await packageChecks();
  await rowChecks();
  await activationChecks();

  let failed = 0;
  for (const c of checks) {
    if (!c.pass) failed += 1;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.evidence ? `\n        ${c.evidence}` : ''}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  try {
    rmSync(SPIKE_ROOT, { recursive: true, force: true });
  } catch {
    /* temp */
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
