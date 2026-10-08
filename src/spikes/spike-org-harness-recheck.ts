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
  readCurrentOrgPackage,
  resetOrgPackageLeasesForTests,
  runOrgHarnessSync,
  startOrgHarnessRecheck,
  type OrgHarnessFetch,
} from '../runtime/org-harness.js';
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

function fixtureEntries(version: string): ZipWriteEntry[] {
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
  publish(version: string, opts?: { badSha?: boolean; brokenZip?: boolean }): void;
};

function fakeHub(): Hub {
  let offered: { version: string; zip: Buffer; sha: string } | undefined;
  const hub: Hub = {
    calls: [],
    offline: false,
    publish(version, opts = {}) {
      const zip = opts.brokenZip ? Buffer.from('not a zip at all') : buildZip(fixtureEntries(version));
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

async function main(): Promise<void> {
  try {
    await clockChecks();
    await passChecks();
    await leaseChecks();
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
