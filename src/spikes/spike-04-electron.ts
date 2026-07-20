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
//       wrong token → 403, all correct → 200
//   (d) bound to 127.0.0.1 only — NOT reachable on the machine's LAN address
//   (e) node:sqlite works in the Electron main process and the runtime store
//       writes a real file under userData
//   (f) the process exits cleanly (no hang) and the store is closed
//
// Prints PASS/FAIL per assertion; exits non-zero on any FAIL.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = resolve(ROOT, 'dist/electron/spike-entry.mjs');
const MARK = '##SPIKE04##';

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

  const child = spawn(electronBinary, [ENTRY], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Isolate from the developer's real app data. Electron derives userData
      // from appData + the app name, so pointing appData at a temp dir keeps the
      // spike's SQLite file and Next cache out of ~/Library/Application Support.
      // The spike still asserts the db lands under the app's OWN userData path,
      // whatever that resolves to.
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

  // -- (c) hardening -------------------------------------------------------
  const hardenCases: Array<{ key: string; expect: number; label: string }> = [
    { key: 'foreign-host', expect: 403, label: 'foreign Host → 403 (DNS-rebinding kill switch)' },
    { key: 'foreign-origin', expect: 403, label: 'foreign Origin → 403' },
    { key: 'no-token', expect: 403, label: 'no session token → 403' },
    { key: 'bad-token', expect: 403, label: 'wrong session token → 403' },
    { key: 'all-correct', expect: 200, label: 'correct Host + Origin + token → 200' },
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
  const sq = findOne(obs, 'sqlite');
  checks.push({
    name: '(e) node:sqlite works in the Electron main process; store writes a file under userData',
    pass:
      sq?.ok === true &&
      sq.messageCount === 1 &&
      sq.dbExists === true &&
      sq.underUserData === true &&
      typeof sq.dbBytes === 'number' &&
      sq.dbBytes > 0,
    evidence: sq
      ? sq.ok === true
        ? `db=${String(sq.dbPath)} bytes=${String(sq.dbBytes)} messages=${String(sq.messageCount)} underUserData=${String(sq.underUserData)}`
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
