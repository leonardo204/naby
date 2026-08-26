// src/spikes/spike-whats-new.ts
//
// THE "WHAT CHANGED" WATERMARK — electron/whats-new.ts, plus the two IPC
// channels and the preload surface that carry it.
//
// WHAT IS UNDER TEST, and why it is worth a spike at all. The DECISIONS — does
// this count as an upgrade, which entries fall in the gap, what a missing
// watermark means — are pure functions in the shell and are covered by vitest
// (releaseNotesOps.test.ts). What vitest cannot reach is what those decisions
// are made OF: two facts about this machine's disk.
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
//   AND A MISSING WATERMARK IS NOT A NEW USER.
//
// The second fact, added after the popup shipped and never fired. Every
// installation that predates the watermark has none either, so "no watermark"
// meant "brand-new user" and the launch after an update — the only launch this
// feature is for — was silent for everyone who already had the app. Section
// (d2) proves the distinction the renderer is now handed instead of guessing.
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
import { looksLikeFreshInstall, WhatsNewStore } from '../../electron/whats-new.js';

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

  // -- (d2) a missing watermark is not the same as a new user ---------------
  //
  // THE SECOND FACT, and the one the feature was broken without. An
  // installation that existed before the watermark did has no watermark either,
  // so the renderer could not tell it from a brand-new one — and chose silence,
  // for every existing user, on the exact launch the popup exists for.
  // `looksLikeFreshInstall` is that distinction, and it is a question about
  // files, which is why it is proven here rather than in vitest.
  const freshDir = mkdtempSync(join(tmpdir(), 'naby-whats-new-fresh-'));
  const oldDir = mkdtempSync(join(tmpdir(), 'naby-whats-new-existing-'));
  const evidenceOf = (dir: string): string[] => [
    join(dir, 'providers.json'),
    join(dir, 'naby', 'credentials.json'),
    join(dir, 'window-state.json'),
    join(dir, 'app.db'),
  ];
  record(
    '(d2) an untouched userData dir is a FRESH install — nothing is announced to a new user',
    looksLikeFreshInstall(evidenceOf(freshDir)) === true,
    `${freshDir} holds none of: providers.json, credentials.json, window-state.json, app.db`,
  );
  // One piece of evidence is enough, and each is tested on its own: an existing
  // user may have any subset of them.
  for (const rel of ['providers.json', 'window-state.json', 'app.db']) {
    const dir = mkdtempSync(join(tmpdir(), 'naby-whats-new-one-'));
    writeFileSync(join(dir, rel), '{}', 'utf8');
    record(
      `(d2) ${rel} alone proves the app has run here before`,
      looksLikeFreshInstall(evidenceOf(dir)) === false,
      `${rel} exists → not a fresh install → the running version IS announced`,
    );
    rmSync(dir, { recursive: true, force: true });
  }
  writeFileSync(join(oldDir, 'providers.json'), '{"version":1,"profiles":[]}', 'utf8');
  record(
    '(d2) an existing installation with NO watermark still reads as existing',
    looksLikeFreshInstall(evidenceOf(oldDir)) === false &&
      new WhatsNewStore({ userDataDir: oldDir, freshInstall: false }).lastSeenVersion() === null,
    'the two facts are independent: no watermark, and yet demonstrably not new',
  );
  record(
    '(d2) the watermark file is NOT evidence of itself',
    (() => {
      const dir = mkdtempSync(join(tmpdir(), 'naby-whats-new-self-'));
      const store = new WhatsNewStore({ userDataDir: dir });
      store.record('1.26.0');
      const fresh = looksLikeFreshInstall(evidenceOf(dir));
      rmSync(dir, { recursive: true, force: true });
      return fresh === true;
    })(),
    'whats-new.json is the question, not the answer — counting it would restore the original bug',
  );
  record(
    '(d2) the latch is carried on the store, so the renderer gets both facts from one call',
    new WhatsNewStore({ userDataDir: freshDir, freshInstall: true }).isFreshInstall() === true &&
      new WhatsNewStore({ userDataDir: oldDir, freshInstall: false }).isFreshInstall() === false &&
      new WhatsNewStore({ userDataDir: oldDir }).isFreshInstall() === true,
    'an unstated latch defaults to fresh — the silent answer',
  );
  record(
    '(d2) an unreadable path counts as absent rather than throwing on the startup path',
    looksLikeFreshInstall(['\0not-a-path']) === true,
    'a failing existsSync leans towards silence, not towards announcing',
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
    /new WhatsNewStore\(\{ userDataDir, freshInstall \}\)/.test(boot) && /\bwhatsNew,/.test(boot),
    'electron/boot.ts: new WhatsNewStore({ userDataDir, freshInstall }) → registerIpcHandlers({ …, whatsNew })',
  );
  record(
    '(e) the freshness latch is taken BEFORE the files it looks at can be written',
    (() => {
      const latch = boot.indexOf('looksLikeFreshInstall([');
      // Every one of these creates or opens one of the paths the latch reads.
      const writers = [
        boot.indexOf('await startEmbeddedNextServer('),
        boot.indexOf('new mod.SqliteStore('),
        boot.indexOf('installWindowStatePersistence('),
      ];
      return latch > 0 && writers.every((at) => at > latch);
    })(),
    'asked after the server opens app.db, a brand-new install would read as an old one',
  );
  record(
    '(e) main answers the third fact, and makes no decision with it',
    /freshInstall: deps\.whatsNew\?\.isFreshInstall\(\) \?\? true/.test(ipc),
    'whats-new:get returns {currentVersion, lastSeenVersion, freshInstall}; the renderer decides',
  );
  record(
    '(e) the renderer sees exactly two functions — a read and a write, no channel name',
    /const whatsNew = \{[\s\S]*?ipcRenderer\.invoke\('whats-new:get'\)[\s\S]*?ipcRenderer\.invoke\('whats-new:seen', version\)[\s\S]*?\};/.test(
      preload,
    ) && /\n  whatsNew,\n/.test(preload),
    'preload.ts exposes naby.whatsNew = { get, markSeen }',
  );
  record(
    '(e) the running version comes from NABY, not from Electron',
    /function safeAppVersion\(\)/.test(ipc) &&
      /currentVersion: safeAppVersion\(\)/.test(ipc) &&
      /return nabyVersion\(\);/.test(ipc) &&
      !/function safeAppVersion\(\)[\s\S]{0,200}?app\.getVersion\(\)/.test(ipc),
    'safeAppVersion reads the baked constant (electron/app-version.ts). It used to call ' +
      'app.getVersion() directly, which returns the EXECUTABLE\'s version when Electron ' +
      'cannot find the app package.json — the dev launcher hands it a file, so it did. ' +
      'The shell /api/version is a different number again (the cockpit package).',
  );

  // -- (f) nothing touched the real profile ---------------------------------
  const homeAfter = existsSync(realHome) ? readFileSync(join(realHome, 'app.db')).length : -1;
  record(
    '(f) the real ~/.naby was not touched — every write went to a throwaway userData dir',
    homeBefore === homeAfter && !existsSync(join(realHome, 'whats-new.json')),
    `~/.naby/app.db ${homeBefore} → ${homeAfter} bytes; no whats-new.json there`,
  );

  rmSync(userDataDir, { recursive: true, force: true });
  // ── THE VERSION THE WATERMARK IS WRITTEN WITH ───────────────────────────
  //
  // The number that reaches this file matters more than the file does, and it
  // was wrong for a year of dev runs. `app.getVersion()` falls back to the
  // version of the EXECUTABLE when Electron cannot find the app's package.json,
  // and `electron:dev` launches a FILE (`electron dist/electron/main.mjs`) —
  // so development reported naby's version as Electron's own `43.x`, and stamped
  // it into the userData directory the PACKAGED app shares. No real release
  // could ever be newer, and the popup went silent for good.
  //
  // Checked against the BUILD OUTPUT rather than the source: the constant is
  // injected by esbuild, so reading `electron/app-version.ts` would only prove
  // the intention. This proves the artifact.
  const pkgVersion = (JSON.parse(read('package.json')) as { version: string }).version;
  const built = existsSync(join(HERE, 'dist/electron/main.mjs'))
    ? read('dist/electron/main.mjs')
    : null;
  if (built === null) {
    record(
      'the app version is baked into the build',
      false,
      'dist/electron/main.mjs is missing — run `npm run build:electron` first',
    );
  } else {
    record(
      'the app version is baked into the build',
      built.includes(JSON.stringify(pkgVersion)),
      `package.json says ${pkgVersion}; main.mjs ${
        built.includes(JSON.stringify(pkgVersion)) ? 'carries it' : 'DOES NOT carry it'
      }`,
    );
    // The specific poisoning that happened. Electron's version must not be what
    // a caller receives — and it is a whole major ahead of anything naby will
    // ship, so believing it is permanent.
    const electronVersion = (
      JSON.parse(read('package.json')) as { devDependencies?: Record<string, string> }
    ).devDependencies?.electron;
    record(
      'the build does not hand out Electron’s version as naby’s',
      Number(pkgVersion.split('.')[0]) < 40,
      `naby ${pkgVersion} vs electron ${String(electronVersion)} — the changelog repair in ` +
        'releaseNotesOps tells them apart by major, so naby must stay well below it',
    );
  }

  rmSync(brokenDir, { recursive: true, force: true });
  rmSync(freshDir, { recursive: true, force: true });
  rmSync(oldDir, { recursive: true, force: true });

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
