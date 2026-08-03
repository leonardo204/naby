// src/spikes/spike-net-timeout.ts
//
// HAPPY EYEBALLS — the outbound-connect timeout both server processes must raise.
//
// WHAT BROKE. Telegram sends failed INTERMITTENTLY with `400 {"error":"fetch
// failed"}`. The token, the chat id and the settings were all correct, and curl
// to the same endpoint from the same machine always worked — which is what made
// it read as an application bug for a whole session.
//
// The cause was a Node default. `autoSelectFamily` is on by default: Node
// resolves both A and AAAA records and races the addresses, starting the next
// attempt when the current one has not connected within
// `autoSelectFamilyAttemptTimeout` — DEFAULT 250ms. On the reporting network the
// IPv4 handshake to api.telegram.org measured ~250-280ms, straddling that
// boundary, and IPv6 was EHOSTUNREACH. So the address list was exhausted while
// the v4 attempt was still pending and about to succeed, and `fetch` rejected
// with `TypeError: fetch failed`, cause ETIMEDOUT. curl succeeds on the same box
// because its own Happy Eyeballs uses a HEAD START, not a deadline, and never
// abandons a live attempt.
//
// It is not a Telegram problem. It affects EVERY outbound fetch to a >250ms-RTT
// endpoint — providers and the skill hub included — which is why the fix is set
// once per process rather than per call site.
//
// WHAT THIS ASSERTS
//   (a) the mechanism: node:net exposes the setter/getter, the default really is
//       the documented 250ms, and setting it takes effect process-wide
//   (b) electron/boot.ts raises it — at MODULE SCOPE, guarded, >= 5000ms, and
//       positioned before the embedded Next server is started
//   (c) shell/server.mjs raises it — same shape, before Next is constructed
//   (d) the built main-process bundle (dist/electron/main.mjs) still CONTAINS
//       the call, i.e. esbuild did not tree-shake a side-effect-only statement
//
// (b) and (c) are source assertions on purpose: the property is "this runs
// before any outbound connection in that process", which is a claim about module
// load order in an entry file. Importing either entry to check it would boot a
// server — boot.ts needs a live Electron main process, server.mjs binds a port.
// The RUNTIME half is covered where a runtime is available: spike-04 reads
// `net.getDefaultAutoSelectFamilyAttemptTimeout()` from INSIDE the real Electron
// main process after boot() and asserts >= 5000.
//
// NO NETWORK, NO KEYS. Prints PASS/FAIL per assertion; exits non-zero on a FAIL.

import { existsSync, readFileSync } from 'node:fs';
import * as net from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BOOT_TS = resolve(ROOT, 'electron/boot.ts');
const SERVER_MJS = resolve(ROOT, 'shell/server.mjs');
const MAIN_BUNDLE = resolve(ROOT, 'dist/electron/main.mjs');

/** The floor. 250ms is the broken default; a second would still be thin for a
 *  handshake that has to cross an ocean on a bad day. */
const MIN_ATTEMPT_TIMEOUT_MS = 5000;

/** Node's documented default, and the number this whole spike exists about. */
const NODE_DEFAULT_ATTEMPT_TIMEOUT_MS = 250;

type Check = { name: string; pass: boolean; evidence: string };

const checks: Check[] = [];
function record(name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

const CALL = /setDefaultAutoSelectFamilyAttemptTimeout\(\s*([A-Za-z0-9_.]+)\s*\)/;

/** Resolve the numeric literal a named constant is assigned in the same file. */
function constantValue(src: string, name: string): number {
  const m = src.match(new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*([0-9_]+)`));
  return m ? Number(m[1]!.replace(/_/g, '')) : Number.NaN;
}

// ---------------------------------------------------------------------------
// (a) the mechanism
// ---------------------------------------------------------------------------

function checkMechanism(): void {
  const hasSetter = typeof net.setDefaultAutoSelectFamilyAttemptTimeout === 'function';
  const hasGetter = typeof net.getDefaultAutoSelectFamilyAttemptTimeout === 'function';
  record(
    '(a1) node:net exposes the attempt-timeout setter and getter',
    hasSetter && hasGetter,
    `node=${process.version} setter=${hasSetter} getter=${hasGetter}`,
  );
  if (!hasSetter || !hasGetter) return;

  const before = net.getDefaultAutoSelectFamilyAttemptTimeout();
  record(
    `(a2) the untouched default is the documented ${NODE_DEFAULT_ATTEMPT_TIMEOUT_MS}ms — the value that broke sends`,
    before === NODE_DEFAULT_ATTEMPT_TIMEOUT_MS,
    `default=${before}ms`,
  );

  net.setDefaultAutoSelectFamilyAttemptTimeout(MIN_ATTEMPT_TIMEOUT_MS);
  const after = net.getDefaultAutoSelectFamilyAttemptTimeout();
  record(
    '(a3) setting it takes effect process-wide',
    after === MIN_ATTEMPT_TIMEOUT_MS,
    `after set → ${after}ms`,
  );
  net.setDefaultAutoSelectFamilyAttemptTimeout(before);
}

// ---------------------------------------------------------------------------
// (b) + (c) the two entries
// ---------------------------------------------------------------------------

function checkEntry(label: string, file: string, beforeMarker: string, markerLabel: string): void {
  if (!existsSync(file)) {
    record(`(${label}) ${file} exists`, false, 'file missing');
    return;
  }
  const src = readFileSync(file, 'utf8');
  const m = src.match(CALL);
  record(
    `(${label}1) ${label === 'b' ? 'electron/boot.ts' : 'shell/server.mjs'} calls setDefaultAutoSelectFamilyAttemptTimeout`,
    !!m,
    m ? `argument=${m[1]}` : 'no call found — outbound fetch keeps the 250ms default',
  );
  if (!m) return;

  const value = constantValue(src, m[1]!);
  record(
    `(${label}2) the timeout is at least ${MIN_ATTEMPT_TIMEOUT_MS}ms`,
    Number.isFinite(value) && value >= MIN_ATTEMPT_TIMEOUT_MS,
    `${m[1]} = ${Number.isFinite(value) ? `${value}ms` : 'not a resolvable literal'}`,
  );

  const guard = /typeof net\.setDefaultAutoSelectFamilyAttemptTimeout === 'function'/.test(src);
  record(
    `(${label}3) the call is guarded, so a Node without the API cannot make the process unstartable`,
    guard,
    guard ? 'typeof guard present' : 'unguarded call',
  );

  // Module scope, not inside some function that may never be called: every
  // brace before the guard must be balanced.
  const guardAt = src.indexOf("typeof net.setDefaultAutoSelectFamilyAttemptTimeout === 'function'");
  const before = src.slice(0, guardAt);
  const opens = (before.match(/\{/g) ?? []).length;
  const closes = (before.match(/\}/g) ?? []).length;
  record(
    `(${label}4) it runs at MODULE SCOPE — no enclosing function to forget to call`,
    guardAt > -1 && opens === closes,
    `open braces before the call: ${opens} vs ${closes} closed`,
  );

  const callAt = src.search(CALL);
  const markerAt = src.indexOf(beforeMarker);
  record(
    `(${label}5) it happens before ${markerLabel}, i.e. before anything in the process can fetch`,
    callAt > -1 && markerAt > -1 && callAt < markerAt,
    `call@${callAt} < ${markerLabel}@${markerAt}`,
  );
}

// ---------------------------------------------------------------------------
// (d) the built bundle
// ---------------------------------------------------------------------------

function checkBundle(): void {
  if (!existsSync(MAIN_BUNDLE)) {
    record(
      '(d) dist/electron/main.mjs carries the call',
      false,
      `${MAIN_BUNDLE} is missing — run \`npm run build:electron\` (npm run spike:net does this for you)`,
    );
    return;
  }
  const bundle = readFileSync(MAIN_BUNDLE, 'utf8');
  const present = CALL.test(bundle);
  record(
    '(d) the built main-process bundle still carries the call (esbuild kept the side effect)',
    present,
    present ? 'call found in dist/electron/main.mjs' : 'CALL MISSING FROM THE BUNDLE — dropped at build time',
  );
}

// ---------------------------------------------------------------------------

function main(): void {
  console.log('SPIKE — Happy Eyeballs attempt timeout (outbound fetch on border-RTT networks)\n');

  checkMechanism();
  // The CALL SITE, not the import: `await startEmbeddedNextServer(` is the
  // moment the embedded server — and every route in it that can fetch — comes
  // alive inside the Electron main process.
  checkEntry('b', BOOT_TS, 'await startEmbeddedNextServer(', 'the embedded Next server starts');
  checkEntry('c', SERVER_MJS, 'next({', 'Next is constructed');
  checkBundle();

  let failed = 0;
  for (const c of checks) {
    if (!c.pass) failed += 1;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`);
    console.log(`      ${c.evidence}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} assertions passed`);
  if (failed > 0) process.exit(1);
}

main();
