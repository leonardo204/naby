// src/spikes/spike-whats-new.ts
//
// THE "WHAT CHANGED" WATERMARK — electron/whats-new.ts, plus the two IPC
// channels and the preload surface that carry it.
//
// WHAT IS UNDER TEST, and why it is worth a spike at all. The DECISIONS — does
// this count as an upgrade, which entries fall in the gap, is this a fresh
// install — are pure functions in the shell and are covered by vitest
// (releaseNotesOps.test.ts, 40 assertions). What vitest cannot reach is the one
// thing the whole feature rests on:
//
//   THE WATERMARK MUST SURVIVE A RESTART.
//
// That is the requirement that killed the obvious implementation. `localStorage`
// is the natural home for a once-per-version dismissal, and here it is useless:
// electron/next-server.ts binds `listen(0)`, so the embedded server takes a
// fresh ephemeral port on every launch and the renderer's origin
// (`http://127.0.0.1:<port>`) is different every time. localStorage is keyed by
// origin, so it is EMPTY on every restart — selectionChatOps.ts already recorded
// that finding for the popup size. A watermark kept there would read "no
// previous version" forever, which by the fresh-install rule means the popup
// would never appear at all. Silently, and indistinguishably from working.
//
// So the store is a file in userData, and the assertions below are about the
// file: a second instance is a restart, and it has to see what the first wrote.
//
// WHAT IS NOT PROVEN HERE. That the renderer calls these channels in the right
// order — that is asserted against the source in whatsNewWiring.test.ts — and
// that Electron's `app.getVersion()` reports the naby version in a packaged
// build. The latter is the same accessor the updater has shipped with since
// F1-09; it is stated rather than assumed.

import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WhatsNewStore } from '../../electron/whats-new.js';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
const record = (name: string, pass: boolean, evidence: string): void => {
  checks.push({ name, pass, evidence });
};

const HERE = join(fileURLToPath(import.meta.url), '..', '..', '..');
const read = (rel: string): string => readFileSync(join(HERE, rel), 'utf8');

function main(): void {
  const userDataDir = mkdtempSync(join(tmpdir(), 'naby-whats-new-'));
  const realHome = join(homedir(), '.naby');
  const homeBefore = existsSync(realHome) ? readFileSync(join(realHome, 'app.db')).length : -1;

  // -- (a) a fresh install has no watermark ---------------------------------
  const first = new WhatsNewStore({ userDataDir });
  record(
    '(a) a fresh install reports NO last-seen version — the renderer records silently and shows nothing',
    first.lastSeenVersion() === null,
    `no ${first.filePath} yet → ${String(first.lastSeenVersion())}`,
  );
  record(
    '(a) …and reading a store that has never been written creates no file',
    !existsSync(first.filePath),
    'a read is a read; only record() writes',
  );

  // -- (b) it survives a restart --------------------------------------------
  //
  // THE ASSERTION THE FEATURE LIVES OR DIES ON. A SECOND INSTANCE against the
  // same directory is what a relaunch looks like from the store's side.
  first.record('1.25.0');
  const afterRestart = new WhatsNewStore({ userDataDir });
  record(
    '(b) a recorded version survives a "restart" — a second instance reads it back',
    afterRestart.lastSeenVersion() === '1.25.0',
    `instance #2 at the same userData reads ${String(afterRestart.lastSeenVersion())}`,
  );
  record(
    '(b) …from a real file on disk, not from process memory',
    existsSync(afterRestart.filePath) &&
      JSON.parse(readFileSync(afterRestart.filePath, 'utf8')).lastSeenVersion === '1.25.0',
    `${afterRestart.filePath} = ${readFileSync(afterRestart.filePath, 'utf8').replace(/\s+/g, ' ')}`,
  );

  // -- (c) last write wins ---------------------------------------------------
  afterRestart.record('1.26.0');
  record(
    '(c) recording again replaces rather than appends — there is no history to keep',
    new WhatsNewStore({ userDataDir }).lastSeenVersion() === '1.26.0',
    'the only question ever asked is "which version was the user last told about"',
  );

  // -- (d) every failure degrades to "fresh install" -------------------------
  //
  // The popup is on the startup path. A corrupt file must cost the user the
  // popup and nothing else — never a throw before the window appears.
  const brokenDir = mkdtempSync(join(tmpdir(), 'naby-whats-new-broken-'));
  const broken = new WhatsNewStore({ userDataDir: brokenDir });
  for (const [label, contents] of [
    ['truncated by a crash', '{"version":1,"lastSeen'],
    ['not an object', '[]'],
    ['the key missing', '{"version":1}'],
    ['the key of the wrong type', '{"version":1,"lastSeenVersion":42}'],
    ['empty', ''],
  ] as const) {
    writeFileSync(broken.filePath, contents, 'utf8');
    let threw = '';
    let value: string | null = 'unread';
    try {
      value = broken.lastSeenVersion();
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    record(
      `(d) a watermark file that is ${label} reads as a fresh install rather than throwing`,
      !threw && value === null,
      threw ? `THREW: ${threw}` : `→ ${String(value)}`,
    );
  }
  record(
    '(d) recording an empty version is refused, so a bad call cannot erase a good watermark',
    (() => {
      const s = new WhatsNewStore({ userDataDir });
      s.record('');
      return s.lastSeenVersion() === '1.26.0';
    })(),
    'record("") is a no-op; 1.26.0 is still on file',
  );

  // -- (e) the channels and the bridge exist --------------------------------
  //
  // Source assertions: the renderer's only route to this store is the preload
  // bridge, and a channel missing from CHANNELS is a handler that is never
  // registered and never removed on teardown.
  const ipc = read('electron/ipc.ts');
  const preload = read('electron/preload.ts');
  const boot = read('electron/boot.ts');
  for (const channel of ['whats-new:get', 'whats-new:seen']) {
    record(
      `(e) '${channel}' is in the CHANNELS allowlist AND has a handler`,
      new RegExp(`'${channel}',`).test(ipc) && new RegExp(`handle\\('${channel}'`).test(ipc),
      'CHANNELS drives both registration and the teardown loop',
    );
  }
  record(
    '(e) the store is constructed at boot and handed to the IPC layer',
    /new WhatsNewStore\(\{ userDataDir \}\)/.test(boot) && /\bwhatsNew,/.test(boot),
    'electron/boot.ts: new WhatsNewStore({ userDataDir }) → registerIpcHandlers({ …, whatsNew })',
  );
  record(
    '(e) the renderer sees exactly two functions — a read and a write, no channel name',
    /const whatsNew = \{[\s\S]*?ipcRenderer\.invoke\('whats-new:get'\)[\s\S]*?ipcRenderer\.invoke\('whats-new:seen', version\)[\s\S]*?\};/.test(
      preload,
    ) && /\n  whatsNew,\n/.test(preload),
    'preload.ts exposes naby.whatsNew = { get, markSeen }',
  );
  record(
    '(e) the running version comes from app.getVersion(), through a guarded accessor',
    /function safeAppVersion\(\)/.test(ipc) && /currentVersion: safeAppVersion\(\)/.test(ipc),
    'the shell /api/version answers the COCKPIT package version — a different number entirely',
  );

  // -- (f) nothing touched the real profile ---------------------------------
  const homeAfter = existsSync(realHome) ? readFileSync(join(realHome, 'app.db')).length : -1;
  record(
    '(f) the real ~/.naby was not touched — every write went to a throwaway userData dir',
    homeBefore === homeAfter && !existsSync(join(realHome, 'whats-new.json')),
    `~/.naby/app.db ${homeBefore} → ${homeAfter} bytes; no whats-new.json there`,
  );

  rmSync(userDataDir, { recursive: true, force: true });
  rmSync(brokenDir, { recursive: true, force: true });

  const failed = checks.filter((c) => !c.pass);
  for (const c of checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`);
    console.log(`      ${c.evidence}`);
  }
  console.log(
    failed.length === 0
      ? `\nALL PASS — ${checks.length}/${checks.length} assertions`
      : `\nFAILED — ${failed.length} of ${checks.length} assertions:\n${failed
          .map((c) => `  - ${c.name}`)
          .join('\n')}`,
  );
  if (failed.length > 0) process.exit(1);
}

main();
