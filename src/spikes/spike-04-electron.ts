// src/spikes/spike-04-electron.ts
//
// SPIKE-04 — Electron wrapping PoC (impl §2; gates F1-02 packaging).
//
// Pass condition from the plan: "Custom Next server boots in the Electron main
// process; webview loads 127.0.0.1". This spike asserts that AND the four
// localhost-hardening controls design §5 requires, because a localhost server
// that boots but is reachable by any web page the user visits is not a passing
// result — it is CVE-2025-52882.
//
// SHAPE. Electron cannot be driven in-process from tsx (the main process is a
// fixed entry file under Electron's own Node build), so this driver SPAWNS
// Electron on `dist/electron/spike-entry.mjs`, which runs the real boot path and
// emits NDJSON observations. The driver turns those into assertions. The split
// matters: the child only REPORTS, so a probe that silently fails to run shows
// up here as a missing observation — a FAIL — rather than as an assertion that
// quietly never executed.
//
// Headless and non-interactive: the child disables hardware acceleration and
// never shows the window. Nobody has to watch anything for this to pass.
//
// Assertions:
//   (a) the Next server boots in the Electron main process and the port is read
//       back off the BOUND HANDLE, not guessed
//   (b) the window loads http://127.0.0.1:<port> — did-finish-load fired, HTTP
//       200, and no main-frame did-fail-load
//   (c) hardening: foreign Host → 403, foreign Origin → 403, no token → 403,
//       wrong token → 403, all correct → 200 — plus the one deliberate
//       exemption (GET /manifest.webmanifest, which a browser can only fetch
//       without credentials) and the three edges that keep it narrow
//   (i) the background services `shell/server.mjs` starts — the scheduled-task
//       manager and the always-on Telegram listener — are started by the
//       EMBEDDED boot path too, which is where they were missing entirely
//   (h) the outbound Happy Eyeballs attempt timeout is raised in this process,
//       so a >250ms-RTT endpoint does not fail with `fetch failed`
//   (d) bound to 127.0.0.1 only — NOT reachable on the machine's LAN address
//   (e) node:sqlite works in the Electron main process and the runtime store
//       writes a real file at the path boot() resolved — checked against a temp
//       NABY_HOME this driver supplies, so the spike never writes to the
//       developer's real ~/.naby/app.db
//   (f) the process exits cleanly (no hang) and the store is closed
//
// Prints PASS/FAIL per assertion; exits non-zero on any FAIL.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, rmSync } from 'node:fs';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = resolve(ROOT, 'dist/electron/spike-entry.mjs');
const MARK = '##SPIKE04##';

// THE SPIKE MUST NOT TOUCH THE DEVELOPER'S REAL STORE.
//
// `boot()` resolves the store to `~/.naby/app.db` — deliberately, so the
// packaged app, `electron:dev` and the `cockpit` CLI all share one store — and
// only `NABY_DB_PATH` / `NABY_HOME` (both set with `??=`) can move it. This
// spike WRITES: it creates a session and appends a message to prove `node:sqlite`
// works in Electron's Node build. Without an override those rows land in the real
// database and push the developer's recent sessions down the list, which the
// project rules forbid outright. So the driver picks a throwaway home, passes it
// to the child, and asserts the store landed exactly there.
const DB_SANDBOX = resolve(tmpdir(), `naby-spike04-${process.pid}-${Date.now()}`);
const DB_PATH = resolve(DB_SANDBOX, 'app.db');

/** Hard ceiling for the whole child run. A Next cold start is the slow part. */
const RUN_TIMEOUT_MS = 180_000;

type Check = { name: string; pass: boolean; evidence: string };
type Obs = { event: string; [k: string]: unknown };

// ---------------------------------------------------------------------------
// Drive Electron
// ---------------------------------------------------------------------------

type ChildOutcome = {
  observations: Obs[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stderr: string;
};

async function runElectron(): Promise<ChildOutcome> {
  // `require('electron')` resolves to the absolute path of the binary — the
  // supported way to locate it, and it avoids depending on node_modules/.bin
  // shim behaviour across platforms.
  const electronBinary = require('electron') as string;

  mkdirSync(DB_SANDBOX, { recursive: true });

  const child = spawn(electronBinary, [ENTRY], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Isolate from the developer's real store — see DB_SANDBOX above. `boot()`
      // sets both of these with `??=`, so a value passed in here wins and the
      // spike's session/message round trip stays in a temp directory.
      NABY_HOME: DB_SANDBOX,
      NABY_DB_PATH: DB_PATH,
      NODE_ENV: 'production',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
  });

  const observations: Obs[] = [];
  let stdoutBuf = '';
  let stderr = '';
  let timedOut = false;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutBuf += chunk;
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() ?? '';
    for (const line of lines) {
      const at = line.indexOf(MARK);
      if (at === -1) continue;
      try {
        observations.push(JSON.parse(line.slice(at + MARK.length)) as Obs);
      } catch {
        /* a partial or malformed line is simply not an observation */
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolvePromise) => {
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, RUN_TIMEOUT_MS);
      // 'close', NOT 'exit'. 'exit' fires as soon as the process terminates,
      // while its stdio pipes may still hold bytes we have not been handed yet;
      // resolving there raced the last `emit('shutdown', …)` line and made
      // assertion (f) read `storeClosed=undefined` on a genuinely clean
      // teardown. The race is load-dependent, so it showed up when spike:04 ran
      // inside `spike:nokeys` (after 02/03b) but almost never standalone.
      // 'close' fires only once every stdio stream is drained and closed.
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolvePromise({ code, signal });
      });
    },
  );

  return { observations, exitCode: result.code, signal: result.signal, timedOut, stderr };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function findOne(obs: Obs[], event: string): Obs | undefined {
  return obs.find((o) => o.event === event);
}

function findHarden(obs: Obs[], name: string): Obs | undefined {
  return obs.find((o) => o.event === 'harden' && o.case === name);
}

function evaluate(outcome: ChildOutcome): Check[] {
  const { observations: obs } = outcome;
  const checks: Check[] = [];

  // -- (a) server boots; port read off the bound handle --------------------
  const server = findOne(obs, 'server');
  const port = typeof server?.port === 'number' ? server.port : 0;
  // The shell's own server.mjs hardcodes 3456 (dev) / 3457 (prod). Seeing
  // either would mean we booted its CLI server, not ours — and that our port
  // was a constant rather than a kernel assignment.
  const guessedPorts = [3000, 3456, 3457];
  const portFromHandle = port > 0 && port <= 65535 && !guessedPorts.includes(port);
  checks.push({
    name: '(a) Next server boots in the Electron main process; port read from the bound handle',
    pass: !!server && portFromHandle && server.address === '127.0.0.1',
    evidence: server
      ? `bound ${String(server.address)}:${port} (ephemeral, not a hardcoded default)`
      : 'no `server` observation — the server never came up',
  });

  // -- (b) window loads ----------------------------------------------------
  const win = findOne(obs, 'window');
  checks.push({
    name: '(b) window loads http://127.0.0.1:<port> — did-finish-load, HTTP 200, no main-frame failure',
    pass: win?.finished === true && win.httpStatus === 200 && win.mainFrameFailure === null,
    evidence: win
      ? `finished=${String(win.finished)} httpStatus=${String(win.httpStatus)} ` +
        `mainFrameFailure=${JSON.stringify(win.mainFrameFailure)} url=${String(win.url)}`
      : 'no `window` observation — the window never reported',
  });

  // -- (g) renderer bridge + cookie promotion ------------------------------
  // Placed with (b) conceptually: it is what makes "the window loads" mean the
  // app WORKS rather than merely that a document arrived.
  const br = findOne(obs, 'bridge');
  checks.push({
    name: "(g) renderer authenticates its own traffic (cookie + preload bridge); no node leaked into the page",
    pass:
      br?.bridgePresent === true &&
      typeof br.tokenLength === 'number' &&
      br.tokenLength === 64 && // 32 random bytes, hex — ≥128 bits as design §5.4 requires
      br.nodeLeaked === false &&
      br.cookieFetchStatus === 200 &&
      br.bridgeFetchStatus === 200,
    evidence: br
      ? `bridgePresent=${String(br.bridgePresent)} tokenLength=${String(br.tokenLength)} ` +
        `nodeLeaked=${String(br.nodeLeaked)} cookieFetch=${String(br.cookieFetchStatus)} ` +
        `bridgeFetch=${String(br.bridgeFetchStatus)}${br.error ? ` error=${String(br.error)}` : ''}`
      : 'no `bridge` observation',
  });

  // -- (i) background services started at boot -----------------------------
  //
  // `shell/server.mjs` starts the scheduled-task manager and the always-on
  // Telegram listener after Next is ready. The Electron app never runs that
  // file, so for as long as the wiring lived only there BOTH were dead in
  // `electron:dev` and in the packaged artifact: saved scheduled tasks never
  // fired, and the bot answered nothing until someone re-saved Telegram
  // settings. `next-server.ts` step 4 now starts them, and this reads the
  // outcome back out of the REAL main process — the only place the claim
  // "it actually runs at boot" can be tested.
  //
  // `telegramChat: 'started'` here means the listener entry ran, not that a bot
  // is polling: the spike's temp store has Telegram off, so the loop no-ops by
  // design. What is being asserted is that the call site is reachable at boot.
  const svc = findOne(obs, 'services');
  checks.push({
    name: '(i) embedded boot starts the shell background services (scheduled tasks + Telegram listener)',
    pass: svc?.scheduledTasks === 'started' && svc.telegramChat === 'started',
    evidence: svc
      ? `scheduledTasks=${String(svc.scheduledTasks)} telegramChat=${String(svc.telegramChat)}`
      : 'no `services` observation — the embedded server reported no background wiring',
  });

  // -- (c) hardening -------------------------------------------------------
  const hardenCases: Array<{ key: string; expect: number; label: string }> = [
    { key: 'foreign-host', expect: 403, label: 'foreign Host → 403 (DNS-rebinding kill switch)' },
    { key: 'foreign-origin', expect: 403, label: 'foreign Origin → 403' },
    { key: 'no-token', expect: 403, label: 'no session token → 403' },
    { key: 'bad-token', expect: 403, label: 'wrong session token → 403' },
    { key: 'all-correct', expect: 200, label: 'correct Host + Origin + token → 200' },
    // The single deliberate exemption (a browser fetches the manifest with
    // credentials omitted, so it can never present the cookie) and the three
    // edges that keep it narrow.
    {
      key: 'manifest-no-token',
      expect: 200,
      label: 'GET /manifest.webmanifest without a token → 200 (the one exemption)',
    },
    {
      key: 'manifest-lookalike-no-token',
      expect: 403,
      label: 'a path merely STARTING with the manifest name → 403 (exact match, not a prefix)',
    },
    { key: 'manifest-post-no-token', expect: 403, label: 'POST /manifest.webmanifest → 403 (GET only)' },
    {
      key: 'manifest-foreign-host',
      expect: 403,
      label: 'foreign Host on the manifest → 403 (Host is still checked first)',
    },
  ];
  for (const c of hardenCases) {
    const o = findHarden(obs, c.key);
    checks.push({
      name: `(c) hardening — ${c.label}`,
      pass: o?.status === c.expect,
      evidence: o
        ? `status=${String(o.status)} expected=${c.expect}${o.error ? ` error=${String(o.error)}` : ''}`
        : `no probe result for '${c.key}'`,
    });
  }

  // -- (h) outbound connect timeout ----------------------------------------
  //
  // Node's Happy Eyeballs abandons a connection attempt that has not completed
  // within `autoSelectFamilyAttemptTimeout` — 250ms by default. On a network
  // where the IPv4 handshake sits on that boundary and IPv6 is unreachable, the
  // address list is exhausted while a live attempt is still pending, and `fetch`
  // fails with `TypeError: fetch failed` (ETIMEDOUT). That is what made Telegram
  // sends fail intermittently while curl always worked. boot.ts raises it at
  // module scope; this reads the value back from inside the REAL main process,
  // which is the only place the claim can actually be checked.
  const netObs = findOne(obs, 'net');
  const attemptTimeout = typeof netObs?.attemptTimeoutMs === 'number' ? netObs.attemptTimeoutMs : 0;
  checks.push({
    name: '(h) outbound Happy Eyeballs attempt timeout is raised in the Electron main process (≥5000ms)',
    pass: attemptTimeout >= 5000,
    evidence: netObs
      ? `net.getDefaultAutoSelectFamilyAttemptTimeout() = ${String(netObs.attemptTimeoutMs)}ms ` +
        `(Node's default 250ms is the value that broke outbound fetch)`
      : 'no `net` observation',
  });

  // -- (d) loopback only ---------------------------------------------------
  const lo = findOne(obs, 'loopback');
  const lan = typeof lo?.lanAddress === 'string' ? lo.lanAddress : null;
  // A refusal is the pass. `status === 200` from tryConnect means the TCP
  // connect SUCCEEDED on a non-loopback address, i.e. the listener is exposed.
  const lanRefused = lan === null ? true : lo?.status === null;
  checks.push({
    name: '(d) bound to 127.0.0.1 only — not reachable on a non-loopback address',
    pass: lo?.boundAddress === '127.0.0.1' && lanRefused,
    evidence: lo
      ? `boundAddress=${String(lo.boundAddress)} lanAddress=${String(lan)} ` +
        (lan === null
          ? '(no LAN interface on this host — bound-address check only)'
          : `connect → ${lo.status === null ? `refused (${String(lo.error)})` : 'CONNECTED — EXPOSED'}`)
      : 'no `loopback` observation',
  });

  // -- (e) node:sqlite in the Electron main process ------------------------
  // The path assertion is against the sandbox this driver HANDED the child, not
  // against userData: `boot()` anchors the store at `~/.naby` on purpose (one
  // store across launch modes), so "under userData" stopped being true when that
  // decision was made, and asserting it only proved the spike was writing to the
  // developer's real database.
  const sq = findOne(obs, 'sqlite');
  checks.push({
    name: '(e) node:sqlite works in the Electron main process; the store writes a real file at the path boot() resolved',
    pass:
      sq?.ok === true &&
      sq.messageCount === 1 &&
      sq.dbExists === true &&
      sq.dbPath === DB_PATH &&
      typeof sq.dbBytes === 'number' &&
      sq.dbBytes > 0,
    evidence: sq
      ? sq.ok === true
        ? `db=${String(sq.dbPath)} bytes=${String(sq.dbBytes)} messages=${String(sq.messageCount)} ` +
          `isolated=${String(sq.dbPath === DB_PATH)} (expected ${DB_PATH})`
        : `store failed: ${String(sq.error)}`
      : 'no `sqlite` observation',
  });

  // -- (f) clean exit ------------------------------------------------------
  const shutdown = findOne(obs, 'shutdown');
  const fatal = findOne(obs, 'fatal');
  checks.push({
    name: '(f) store closed and the process exits cleanly (no hang)',
    pass:
      shutdown?.storeClosed === true &&
      shutdown.serverClosed === true &&
      !outcome.timedOut &&
      outcome.exitCode === 0 &&
      !fatal,
    evidence:
      (fatal ? `FATAL in main: ${String(fatal.error)} · ` : '') +
      `storeClosed=${String(shutdown?.storeClosed)} serverClosed=${String(shutdown?.serverClosed)} shutdownStalled=${String(shutdown?.shutdownStalled)} ` +
      `exitCode=${String(outcome.exitCode)} signal=${String(outcome.signal)} timedOut=${String(outcome.timedOut)}`,
  });

  return checks;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('SPIKE-04 — Electron wrapping PoC (F1-02)\n');

  if (!existsSync(ENTRY)) {
    console.error(`FAIL: ${ENTRY} is missing.`);
    console.error('      Run `npm run build:electron` first (npm run spike:04 does this for you).');
    process.exit(1);
  }

  const outcome = await runElectron();
  const checks = evaluate(outcome);

  // The sandbox has served its purpose once the observations are in hand. Best
  // effort: a leftover temp directory is not worth failing a passing spike over.
  try {
    rmSync(DB_SANDBOX, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  for (const c of checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`);
    console.log(`      ${c.evidence}`);
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} assertions passed`);

  if (failed.length > 0) {
    // Electron writes a lot of benign noise to stderr; it is only worth showing
    // when something actually failed, and then it is usually the whole answer.
    const tail = outcome.stderr.trim().split('\n').slice(-40).join('\n');
    if (tail) console.error(`\n--- electron stderr (tail) ---\n${tail}`);
    process.exit(1);
  }
}

void main();
