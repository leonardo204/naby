// src/spikes/spike-org-harness-recheck.ts
//
// ORG HARNESS M4 — the six-hour re-check and package-folder leases
// (specs/org-harness-sync.md §3.1, §3.6, §4.7, §4.9 case 7).
//
// NO NETWORK, NO REAL HOME: a temp NABY_HOME + NABY_DB_PATH and a fake Skill Hub
// (an injected fetch). The clock is driven with injected timers and an injected
// `now`, so six hours and a KST day boundary pass in milliseconds.
//
// WHAT IS ASSERTED:
//
//   delay      every wait is 6 h ± 15 min, uniformly spread (jitter)
//   clock      the first tick runs the pass; the next wait starts only after the
//              pass settles (no overlap); `shouldRun: false` skips a tick with no
//              pass; a throwing pass is counted and the clock keeps going;
//              `stop()` clears the timer and nothing is rescheduled; timers are
//              unref'd
//   daily key  four passes six hours apart across a KST midnight call the
//              bootstrap exactly twice (once per KST day), the marketplace four
//              times — "once a day" holds for an app left running (§3.6)
//   off        `NABY_ORG_HARNESS=0` and the Settings toggle off ⇒ the pass makes
//              no request at all
//   failure    offline, an integrity mismatch and a broken zip each keep the
//              current version (and its folder) exactly as it was
//   leases     a turn pinned on v1 survives TWO flips (v2, v3): v1 stays on disk
//              while leased; a hook lease keeps it after the turn releases; the
//              last release collects it, leaving current + one previous; release
//              is idempotent; an unleased old version is collected at once; a
//              lease older than the cap no longer protects its folder
//   notice     (§3.1, §3.5 silent update + one notice per version) a first
//              install records nothing; an update records one pending notice and
//              a log entry; the ack marks only that version, once; a re-run does
//              not re-raise it; hooks a version adds outside the allowlist (and
//              outside the three naby re-implements) are listed and logged by
//              name, and the runner still does not run them; an unseen notice
//              carries its waiting hooks into the next one; a seen one does not;
//              readers drop hooks this build's allowlist now covers; the state a
//              fresh store reads (a restart) is the same; the log is capped
//
// Prints PASS/FAIL per assertion; exits non-zero on any FAIL.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SPIKE_ROOT = mkdtempSync(join(tmpdir(), 'naby-spike-org-recheck-'));
process.env.NABY_HOME = join(SPIKE_ROOT, 'process-home');
process.env.NABY_DB_PATH = join(SPIKE_ROOT, 'process-home', 'app.db');

import {
  ackOrgUpdateNotice,
  collectOrgHarnessGarbage,
  leasedOrgPackageDirs,
  leaseOrgPackageDir,
  listOrgPackageVersions,
  ORG_HARNESS_RECHECK_JITTER_MS,
  ORG_HARNESS_RECHECK_MS,
  ORG_HARNESS_SETTING,
  ORG_PACKAGE_LEASE_MAX_AGE_MS,
  orgHarnessRecheckDelay,
  orgHarnessRoot,
  ORG_UPDATE_LOG_MAX,
  pendingOrgUpdateNotice,
  readCurrentOrgPackage,
  readOrgHarnessState,
  readOrgUpdateLog,
  readOrgUpdateNotice,
  recordOrgHarnessUpdate,
  resetOrgPackageLeasesForTests,
  runOrgHarnessSync,
  startOrgHarnessRecheck,
  type OrgHarnessFetch,
} from '../runtime/org-harness.js';
import { readOrgHookConfig } from '../runtime/org-harness-hooks.js';
import { pinOrgHarnessTurn } from '../runtime/org-harness-turn.js';
import { SqliteStore } from '../runtime/store/sqlite-store.js';
import { buildZip, type ZipWriteEntry } from '../runtime/zip.js';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, evidence = ''): void {
  checks.push({ name, pass, evidence });
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = join(ROOT, 'src/spikes/fixtures/org-harness/altimedia-harness');
const KEY = 'shub_recheckKeyAAAA';
const MARKETPLACE = 'https://hub.test/api/v1/marketplace.json';
const DOWNLOAD = 'https://hub.test/api/v1/plugins/altimedia-harness/download';
const BOOTSTRAP = 'https://hub.test/api/v1/harness/bootstrap';
const HOUR = 60 * 60 * 1000;

/** Rewrites a parsed hooks.json (adds hooks a new version might ship). */
type HooksTransform = (hooks: Record<string, unknown[]>) => void;

function fixtureEntries(version: string, hooksTransform?: HooksTransform): ZipWriteEntry[] {
  const out: ZipWriteEntry[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const rel = relative(FIXTURE, full).split('\\').join('/');
      let data: string | Buffer = readFileSync(full);
      if (rel === '.claude-plugin/plugin.json') {
        const plugin = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
        plugin.version = version;
        data = JSON.stringify(plugin, null, 2);
      }
      if (rel === 'hooks/hooks.json' && hooksTransform) {
        const parsed = JSON.parse(data.toString('utf8')) as { hooks: Record<string, unknown[]> };
        hooksTransform(parsed.hooks);
        data = JSON.stringify(parsed, null, 2);
      }
      out.push({ name: rel, data });
    }
  };
  walk(FIXTURE);
  return out;
}

type Hub = {
  fetch: OrgHarnessFetch;
  calls: string[];
  offline: boolean;
  publish(version: string, opts?: { badSha?: boolean; brokenZip?: boolean; hooks?: HooksTransform }): void;
};

function fakeHub(): Hub {
  let offered: { version: string; zip: Buffer; sha: string } | undefined;
  const hub: Hub = {
    calls: [],
    offline: false,
    publish(version, opts = {}) {
      const zip = opts.brokenZip ? Buffer.from('not a zip at all') : buildZip(fixtureEntries(version, opts.hooks));
      const sha = createHash('sha256').update(zip).digest('hex');
      offered = { version, zip, sha: opts.badSha ? '0'.repeat(64) : sha };
    },
    fetch: async (url) => {
      hub.calls.push(url);
      if (hub.offline) throw new TypeError('fetch failed (offline)');
      const respond = (status: number, body: unknown, bytes?: Buffer) => ({
        status,
        json: async () => body,
        arrayBuffer: async () => {
          const b = bytes ?? Buffer.alloc(0);
          return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
        },
      });
      if (url === MARKETPLACE) {
        return respond(200, {
          plugins: offered
            ? [{ name: 'altimedia-harness', version: offered.version, source: { url: DOWNLOAD, sha256: offered.sha } }]
            : [],
        });
      }
      if (url === DOWNLOAD) return offered ? respond(200, null, offered.zip) : respond(404, null);
      if (url === BOOTSTRAP) return respond(200, { env: { HARNESS_METRICS_TOKEN: 'hmt_recheck' } });
      return respond(404, null);
    },
  };
  return hub;
}

function freshCase(label: string): { home: string; store: SqliteStore; hub: Hub } {
  const home = join(SPIKE_ROOT, label);
  mkdirSync(home, { recursive: true });
  return { home, store: new SqliteStore({ path: join(home, 'app.db') }), hub: fakeHub() };
}

function pass(
  c: { home: string; store: SqliteStore; hub: Hub },
  opts: { now?: () => number; env?: Record<string, string | undefined> } = {},
) {
  return runOrgHarnessSync(c.store, {
    home: c.home,
    apiKey: KEY,
    env: opts.env ?? {},
    fetch: c.hub.fetch,
    marketplaceUrl: MARKETPLACE,
    bootstrapUrl: BOOTSTRAP,
    ...(opts.now ? { now: opts.now } : {}),
  });
}

// ---------------------------------------------------------------------------
// 1. The delay and the clock
// ---------------------------------------------------------------------------

async function clockChecks(): Promise<void> {
  const lo = ORG_HARNESS_RECHECK_MS - ORG_HARNESS_RECHECK_JITTER_MS;
  const hi = ORG_HARNESS_RECHECK_MS + ORG_HARNESS_RECHECK_JITTER_MS;
  record(
    'delay: 6 h ± 15 min at the extremes and the middle',
    orgHarnessRecheckDelay(() => 0) === lo &&
      orgHarnessRecheckDelay(() => 1) === hi &&
      orgHarnessRecheckDelay(() => 0.5) === ORG_HARNESS_RECHECK_MS &&
      ORG_HARNESS_RECHECK_MS === 6 * HOUR,
  );
  const samples = Array.from({ length: 2000 }, () => orgHarnessRecheckDelay());
  const inRange = samples.every((d) => d >= lo && d <= hi);
  const below = samples.filter((d) => d < ORG_HARNESS_RECHECK_MS).length;
  record(
    'delay: 2000 random waits all inside the band and spread on both sides (jitter)',
    inRange && below > 700 && below < 1300 && new Set(samples).size > 1500,
    JSON.stringify({ min: Math.min(...samples), max: Math.max(...samples), below }),
  );

  // Injected timers: nothing really waits.
  type Pending = { fn: () => void; ms: number; unrefd: boolean; cleared: boolean };
  const timers: Pending[] = [];
  const setTimer = (fn: () => void, ms: number) => {
    const t: Pending = { fn, ms, unrefd: false, cleared: false };
    timers.push(t);
    return {
      unref: () => {
        t.unrefd = true;
      },
      t,
    };
  };
  const clearTimer = (h: { t?: Pending }) => {
    if (h.t) h.t.cleared = true;
  };
  let release!: () => void;
  let runs = 0;
  let shouldRun = true;
  let throwNext = false;
  const clock = startOrgHarnessRecheck({
    run: () => {
      runs += 1;
      if (throwNext) {
        throwNext = false;
        throw new Error('pass exploded');
      }
      return new Promise<void>((r) => {
        release = r;
      });
    },
    shouldRun: () => shouldRun,
    random: () => 0.5,
    setTimer: setTimer as never,
    clearTimer: clearTimer as never,
    log: () => {},
  });
  record(
    'clock: starts with ONE unref\'d 6 h wait and no pass yet',
    timers.length === 1 && timers[0]!.ms === ORG_HARNESS_RECHECK_MS && timers[0]!.unrefd && runs === 0 && clock.nextAt !== undefined,
  );
  timers[0]!.fn();
  await new Promise((r) => setTimeout(r, 5));
  record('clock: the tick runs the pass', runs === 1);
  record('clock: no next wait while the pass is still running (never overlapping)', timers.length === 1, String(timers.length));
  release();
  await new Promise((r) => setTimeout(r, 5));
  record('clock: the next wait is scheduled once the pass settles', timers.length === 2 && clock.stats.ran === 1);

  shouldRun = false;
  timers[1]!.fn();
  await new Promise((r) => setTimeout(r, 5));
  record(
    'clock: shouldRun=false skips the tick — no pass — and waits for the next one',
    runs === 1 && clock.stats.skipped === 1 && timers.length === 3,
    JSON.stringify(clock.stats),
  );
  shouldRun = true;
  throwNext = true;
  timers[2]!.fn();
  await new Promise((r) => setTimeout(r, 5));
  record(
    'clock: a pass that throws is counted, and the clock keeps going',
    runs === 2 && clock.stats.failed === 1 && timers.length === 4,
    JSON.stringify(clock.stats),
  );
  clock.stop();
  record('clock: stop() clears the pending timer and forgets nextAt', timers[3]!.cleared && clock.nextAt === undefined);
  timers[3]!.fn(); // a timer that fires anyway after stop
  await new Promise((r) => setTimeout(r, 5));
  record('clock: after stop() nothing runs and nothing is rescheduled', runs === 2 && timers.length === 4);
}

// ---------------------------------------------------------------------------
// 2. The daily key check rides the clock; off means no network; failures keep
// ---------------------------------------------------------------------------

async function passChecks(): Promise<void> {
  // 10:00 KST on some day = 01:00 UTC.
  const day1 = Date.UTC(2026, 9, 8, 1, 0, 0);
  const c = freshCase('daily');
  c.hub.publish('0.8.1');
  const times = [day1, day1 + 6 * HOUR, day1 + 12 * HOUR, day1 + 18 * HOUR]; // the last is 04:00 KST next day
  for (const t of times) await pass(c, { now: () => t });
  const boots = c.hub.calls.filter((u) => u === BOOTSTRAP).length;
  const markets = c.hub.calls.filter((u) => u === MARKETPLACE).length;
  record(
    'daily key: four 6-hourly passes across a KST midnight call the bootstrap exactly twice',
    boots === 2 && markets === 4,
    JSON.stringify({ boots, markets }),
  );
  record(
    'daily key: the metrics token from the bootstrap is stored for the hooks (§3.6)',
    c.store.getSetting(ORG_HARNESS_SETTING.metricsToken) === 'hmt_recheck',
  );
  record('package: the first pass installed 0.8.1, later passes were no-ops', readCurrentOrgPackage(c.home)?.version === '0.8.1');

  // Off: no request at all.
  const before = c.hub.calls.length;
  const envOff = await pass(c, { env: { NABY_ORG_HARNESS: '0' } });
  c.store.setSetting(ORG_HARNESS_SETTING.enabled, 'false');
  const userOff = await pass(c);
  c.store.setSetting(ORG_HARNESS_SETTING.enabled, 'true');
  record(
    'off: NABY_ORG_HARNESS=0 and the Settings toggle each skip the pass with zero requests',
    envOff.skipped === 'env-off' && userOff.skipped === 'user-off' && c.hub.calls.length === before,
    JSON.stringify({ envOff: envOff.skipped, userOff: userOff.skipped, calls: c.hub.calls.length - before }),
  );

  // Failures keep the current version and its folder.
  const dir = readCurrentOrgPackage(c.home)!.dir;
  c.hub.offline = true;
  const offline = await pass(c, { now: () => day1 + 30 * HOUR });
  c.hub.offline = false;
  c.hub.publish('0.8.2', { badSha: true });
  const mismatch = await pass(c);
  c.hub.publish('0.8.3', { brokenZip: true });
  const broken = await pass(c);
  const still = readCurrentOrgPackage(c.home);
  record(
    'failure: offline / sha256 mismatch / broken zip each keep 0.8.1 current, its folder intact',
    offline.package?.outcome === 'unreachable' &&
      mismatch.package?.outcome === 'integrity-mismatch' &&
      broken.package?.outcome === 'invalid-package' &&
      still?.version === '0.8.1' &&
      existsSync(join(dir, 'skills', 'task', 'SKILL.md')) &&
      listOrgPackageVersions(c.home).join() === '0.8.1',
    JSON.stringify({ offline: offline.package, mismatch: mismatch.package?.outcome, broken: broken.package?.outcome, versions: listOrgPackageVersions(c.home) }),
  );
}

// ---------------------------------------------------------------------------
// 3. Leases: the GC never deletes a folder a running turn or hook uses
// ---------------------------------------------------------------------------

async function leaseChecks(): Promise<void> {
  resetOrgPackageLeasesForTests();
  const c = freshCase('leases');
  const ctx = { home: c.home, apiKey: KEY, env: {} };
  c.hub.publish('1.0.0');
  await pass(c);
  // A turn starts on 1.0.0 (pinned AND leased).
  const turn = pinOrgHarnessTurn(c.store, ctx);
  const v1 = turn.pkg?.dir ?? '';
  record('[lease] setup: the turn pinned 1.0.0 and holds a lease on it', turn.pkg?.version === '1.0.0' && leasedOrgPackageDirs().length === 1);

  // Two versions land during the same turn.
  c.hub.publish('1.0.1');
  await pass(c);
  c.hub.publish('1.0.2');
  await pass(c);
  record(
    '[lease] two flips mid-turn: 1.0.0 is NOT deleted (leased) although it is neither current nor previous',
    readCurrentOrgPackage(c.home)?.version === '1.0.2' &&
      existsSync(join(v1, 'skills', 'task', 'SKILL.md')) &&
      listOrgPackageVersions(c.home).join() === '1.0.0,1.0.1,1.0.2',
    JSON.stringify(listOrgPackageVersions(c.home)),
  );

  // A hook started by that turn still runs when the turn ends.
  const hookRelease = leaseOrgPackageDir(v1);
  turn.release();
  turn.release(); // idempotent
  record(
    '[lease] the turn released, but a hook process still holds 1.0.0: kept',
    existsSync(v1) && listOrgPackageVersions(c.home).includes('1.0.0'),
  );
  hookRelease();
  record(
    '[lease] the last release collects 1.0.0: back to current + one previous',
    !existsSync(v1) && listOrgPackageVersions(c.home).join() === '1.0.1,1.0.2' && leasedOrgPackageDirs().length === 0,
    JSON.stringify(listOrgPackageVersions(c.home)),
  );
  hookRelease(); // idempotent, no throw, nothing else deleted
  record('[lease] a second release is a no-op', listOrgPackageVersions(c.home).join() === '1.0.1,1.0.2');

  // Nothing leased: the old version goes at once.
  c.hub.publish('1.0.3');
  await pass(c);
  record(
    '[lease] with no lease, the version older than previous is collected by the sync itself',
    listOrgPackageVersions(c.home).join() === '1.0.2,1.0.3',
    JSON.stringify(listOrgPackageVersions(c.home)),
  );

  // A stale lease (older than the cap) does not protect its folder.
  const v3dir = join(orgHarnessRoot(c.home), '1.0.2');
  const staleRelease = leaseOrgPackageDir(v3dir, () => Date.now() - ORG_PACKAGE_LEASE_MAX_AGE_MS - 1000);
  c.hub.publish('1.0.4');
  await pass(c);
  c.hub.publish('1.0.5');
  await pass(c);
  record(
    '[lease] a lease older than the 24 h cap no longer keeps its folder (leak guard)',
    !existsSync(v3dir) && listOrgPackageVersions(c.home).join() === '1.0.4,1.0.5',
    JSON.stringify(listOrgPackageVersions(c.home)),
  );
  staleRelease();

  // An "off" turn or a turn with no package holds nothing.
  const offTurn = pinOrgHarnessTurn(c.store, { ...ctx, env: { NABY_ORG_HARNESS: '0' } });
  offTurn.release();
  record('[lease] an off turn takes no lease and its release is a no-op', offTurn.pkg === undefined && leasedOrgPackageDirs().length === 0);

  // collectOrgHarnessGarbage on its own respects leases too.
  const t2 = pinOrgHarnessTurn(c.store, ctx); // 1.0.5
  c.hub.publish('1.0.6');
  await pass(c);
  c.hub.publish('1.0.7');
  await pass(c);
  collectOrgHarnessGarbage(c.home);
  const kept = listOrgPackageVersions(c.home).join();
  t2.release();
  record(
    '[lease] an explicit GC pass keeps the leased folder; its release then collects it',
    kept === '1.0.5,1.0.6,1.0.7' && listOrgPackageVersions(c.home).join() === '1.0.6,1.0.7',
    JSON.stringify({ kept, after: listOrgPackageVersions(c.home) }),
  );
}


// ---------------------------------------------------------------------------
// 4. The update notice (§3.1 silent update, §3.5 new hooks wait)
// ---------------------------------------------------------------------------

/** The hooks a "future" Skill Hub version might add: two new scripts (one in the
 *  args form, one as a one-line string), a native script on another event and
 *  an allowlisted one on an event naby has no moment for — only the first two
 *  are "new hooks waiting for naby". */
const addHooks: HooksTransform = (hooks) => {
  (hooks.SessionStart ??= []).push({
    hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/remind.js'], timeout: 5 }],
  });
  (hooks.PostToolUse ??= []).push({
    matcher: 'Bash',
    hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/new-audit.js" --quiet' }],
  });
  (hooks.Stop ??= []).push({
    hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/activate.js'] }],
  });
  (hooks.Notification ??= []).push({
    hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/metrics-emit.js'] }],
  });
};

async function noticeChecks(): Promise<void> {
  const c = freshCase('notice');
  const names = (hooks: { script: string }[] | undefined) => (hooks ?? []).map((h) => h.script).join(',');

  c.hub.publish('2.0.0');
  const first = await pass(c);
  record(
    '[notice] a first install records no notice and no log entry (quiet first install)',
    first.package?.outcome === 'updated' &&
      first.notice === undefined &&
      readOrgUpdateNotice(c.store) === undefined &&
      readOrgUpdateLog(c.store).length === 0,
    JSON.stringify({ pkg: first.package, notice: first.notice }),
  );

  c.hub.publish('2.0.1');
  const second = await pass(c);
  const n1 = pendingOrgUpdateNotice(c.store);
  record(
    '[notice] an update records one pending notice (version, previous, no new hooks) and a log entry',
    second.package?.outcome === 'updated' &&
      second.package.previous === '2.0.0' &&
      n1?.version === '2.0.1' &&
      n1.previous === '2.0.0' &&
      n1.newHooks.length === 0 &&
      n1.notifiedAt === undefined &&
      readOrgUpdateLog(c.store).map((e) => e.version).join() === '2.0.1',
    JSON.stringify({ pkg: second.package, n1, log: readOrgUpdateLog(c.store) }),
  );

  const again = await pass(c);
  record(
    '[notice] a re-run on the same version records nothing new',
    again.package?.outcome === 'current' && again.notice === undefined && pendingOrgUpdateNotice(c.store)?.version === '2.0.1',
  );

  const wrong = ackOrgUpdateNotice(c.store, '2.0.0');
  const ok = ackOrgUpdateNotice(c.store, '2.0.1', () => 1234);
  const twice = ackOrgUpdateNotice(c.store, '2.0.1');
  record(
    '[notice] the ack marks only the named version, once; the notice is then not pending',
    !wrong && ok && !twice && pendingOrgUpdateNotice(c.store) === undefined && readOrgUpdateNotice(c.store)?.notifiedAt === 1234,
    JSON.stringify({ wrong, ok, twice, stored: readOrgUpdateNotice(c.store) }),
  );

  // Restart: a fresh store over the same database reads the same thing.
  const reopened = new SqliteStore({ path: join(c.home, 'app.db') });
  record(
    '[notice] a fresh store (a restart, another window) sees it as already shown',
    pendingOrgUpdateNotice(reopened) === undefined && readOrgUpdateNotice(reopened)?.version === '2.0.1',
  );

  c.hub.publish('2.0.2', { hooks: addHooks });
  const third = await pass(c);
  const n2 = pendingOrgUpdateNotice(c.store);
  const n2events = Object.fromEntries((n2?.newHooks ?? []).map((h) => [h.script, h.events.join('|')]));
  record(
    '[notice] new scripts outside the allowlist are listed with their events; native and allowlisted ones are not',
    third.notice?.version === '2.0.2' &&
      names(n2?.newHooks) === 'remind.js,new-audit.js' &&
      n2events['remind.js'] === 'SessionStart' &&
      n2events['new-audit.js'] === 'PostToolUse',
    JSON.stringify(n2),
  );
  const cfg = readOrgHookConfig(join(orgHarnessRoot(c.home), '2.0.2'));
  const disp = (script: string) => cfg.entries.filter((e) => e.script === script).map((e) => e.disposition);
  record(
    '[notice] the waiting hooks are installed but the runner still does not run them',
    existsSync(join(orgHarnessRoot(c.home), '2.0.2', 'hooks', 'hooks.json')) &&
      disp('remind.js').join() === 'unsupported' &&
      disp('new-audit.js').join() === 'unsupported' &&
      !cfg.entries.some((e) => e.disposition === 'run' && /remind|new-audit/.test(e.script)),
    JSON.stringify({ remind: disp('remind.js'), audit: disp('new-audit.js') }),
  );

  // Unseen, then another update that keeps the same hooks: they carry over.
  c.hub.publish('2.0.3', { hooks: addHooks });
  await pass(c);
  const n3 = pendingOrgUpdateNotice(c.store);
  const log3 = readOrgUpdateLog(c.store);
  record(
    '[notice] an unseen notice carries its waiting hooks and its "from" version into the next one',
    n3?.version === '2.0.3' &&
      n3.previous === '2.0.1' &&
      names(n3.newHooks) === 'remind.js,new-audit.js' &&
      log3.map((e) => e.version).join() === '2.0.3,2.0.2,2.0.1' &&
      log3[0]!.newHooks.length === 0 &&
      names(log3[1]!.newHooks) === 'remind.js,new-audit.js',
    JSON.stringify({ n3, log3 }),
  );

  ackOrgUpdateNotice(c.store, '2.0.3');
  c.hub.publish('2.0.4', { hooks: addHooks });
  await pass(c);
  const n4 = pendingOrgUpdateNotice(c.store);
  record(
    '[notice] after the ack, the same waiting hooks are not announced again',
    n4?.version === '2.0.4' && n4.previous === '2.0.3' && n4.newHooks.length === 0,
    JSON.stringify(n4),
  );

  // Readers re-check against this build's allowlist.
  c.store.setSetting(
    ORG_HARNESS_SETTING.updateNotice,
    JSON.stringify({
      version: '2.0.4',
      previous: '2.0.3',
      newHooks: [
        { script: 'metrics-emit.js', events: ['Stop'] },
        { script: 'remind.js', events: ['SessionStart'] },
      ],
      detectedAt: 1,
    }),
  );
  record(
    '[notice] a hook this build allowlists no longer reads as waiting',
    names(readOrgUpdateNotice(c.store)?.newHooks) === 'remind.js',
    JSON.stringify(readOrgUpdateNotice(c.store)),
  );

  // The UI state carries both; nothing secret rides along.
  const state = readOrgHarnessState(c.store, { home: c.home, apiKey: KEY, env: {} });
  record(
    '[notice] the org harness state carries the notice and the log, no key',
    state.updateNotice?.version === '2.0.4' &&
      state.updateLog.length === 4 &&
      !JSON.stringify(state).includes(KEY) &&
      !JSON.stringify(state).includes('hmt_recheck'),
    JSON.stringify({ notice: state.updateNotice, log: state.updateLog.length }),
  );

  // The log line names the scripts.
  const lines: string[] = [];
  const d = freshCase('notice-log');
  d.hub.publish('3.0.0');
  await pass(d);
  d.hub.publish('3.0.1', { hooks: addHooks });
  await pass(d, {});
  // Re-record through the function directly to capture its log output.
  d.store.setSetting(ORG_HARNESS_SETTING.updateNotice, '');
  const direct = recordOrgHarnessUpdate(d.store, {
    home: d.home,
    version: '3.0.1',
    previous: '3.0.0',
    log: (l) => lines.push(l),
  });
  record(
    '[notice] the waiting hooks are logged by name with their events',
    names(direct?.newHooks) === 'remind.js,new-audit.js' &&
      lines.some((l) => l.includes('remind.js (SessionStart)') && l.includes('new-audit.js (PostToolUse)')),
    JSON.stringify(lines),
  );
  record(
    '[notice] no previous (first install), the same version, or a version already recorded: nothing recorded',
    recordOrgHarnessUpdate(d.store, { home: d.home, version: '3.0.1' }) === undefined &&
      recordOrgHarnessUpdate(d.store, { home: d.home, version: '3.0.1', previous: '3.0.1' }) === undefined &&
      recordOrgHarnessUpdate(d.store, { home: d.home, version: '3.0.1', previous: '3.0.0' }) === undefined,
  );

  // The log keeps the newest ORG_UPDATE_LOG_MAX.
  const e = freshCase('notice-cap');
  e.hub.publish('4.0.0');
  await pass(e);
  for (let i = 1; i <= ORG_UPDATE_LOG_MAX + 2; i += 1) {
    e.hub.publish(`4.0.${i}`);
    await pass(e);
  }
  const capped = readOrgUpdateLog(e.store);
  record(
    `[notice] the log keeps the newest ${ORG_UPDATE_LOG_MAX}, newest first`,
    capped.length === ORG_UPDATE_LOG_MAX &&
      capped[0]!.version === `4.0.${ORG_UPDATE_LOG_MAX + 2}` &&
      capped[ORG_UPDATE_LOG_MAX - 1]!.version === '4.0.3',
    JSON.stringify(capped.map((x) => x.version)),
  );
}

async function main(): Promise<void> {
  try {
    await clockChecks();
    await passChecks();
    await leaseChecks();
    await noticeChecks();
  } catch (e) {
    record('spike ran to completion', false, e instanceof Error ? (e.stack ?? e.message) : String(e));
  }
  let failed = 0;
  for (const ch of checks) {
    if (!ch.pass) failed += 1;
    console.log(`${ch.pass ? 'PASS' : 'FAIL'}  ${ch.name}${ch.evidence && !ch.pass ? `\n      ${ch.evidence.slice(0, 1500)}` : ''}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  try {
    rmSync(SPIKE_ROOT, { recursive: true, force: true });
  } catch {
    /* temp */
  }
  process.exit(failed === 0 ? 0 : 1);
}

void main();
