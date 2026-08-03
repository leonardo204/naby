// src/spikes/spike-boot-services.ts
//
// THE TWO BOOT PATHS MUST START THE SAME BACKGROUND SERVICES.
//
// WHAT BROKE. `shell/server.mjs` — the standalone CLI server — starts two things
// after Next is ready: the scheduled-task manager (`scheduledTaskManager.init()`)
// and the always-on Telegram chat listener (`startTelegramChat()`, telegram-chat
// §5). The Electron app does not run that file at all; it hosts Next itself in
// the main process via `electron/next-server.ts`. So in `electron:dev` AND in
// the packaged artifact, neither service ever started.
//
// Telegram was the visible half: a freshly launched app never answered the bot,
// because the ONLY other thing that ever called `ensureListener` was the
// `telegram.set` settings action — re-saving settings "fixed" it until the next
// restart. Scheduled tasks were the invisible half of exactly the same bug: no
// timers were rebuilt at boot, so a task saved yesterday never fired today.
//
// WHY SOURCE ASSERTIONS. The property is "this code is present in the embedded
// boot path and survives into the shipped bundle". Importing `next-server.ts` to
// check it would need a live Electron main process, and importing `server.mjs`
// would bind a port and install signal handlers. The RUNTIME half is covered
// where a runtime exists: spike-04 boots real Electron and asserts the
// `services` observation reports both as started.
//
// WHAT THIS ASSERTS
//   (a) `shell/server.mjs` still starts both services — the reference behaviour
//       this spike keeps the Electron path aligned with. If the shell ever drops
//       one, this fails loudly rather than letting the two paths drift silently.
//   (b) `electron/next-server.ts` imports BOTH built entries by their
//       `shell/dist/*.mjs` specifiers and calls `scheduledTaskManager.init()`
//       and `startTelegramChat()` after `app.prepare()`.
//   (c) SINGLE-STORE SEMANTICS: those imports name the built `dist/` entries,
//       which tsup emits from one `splitting: true` build so they share chunks —
//       one store, one scheduled singleton, one Telegram loop. Re-resolving the
//       TypeScript sources instead would create a second realm, and two
//       getUpdates loops on one bot token is the documented 409 trap.
//   (d) `shell/tsup.server.ts` declares both entries with splitting on, and both
//       built files exist in `shell/dist/`.
//   (e) the built main-process bundle `dist/electron/main.mjs` still CONTAINS
//       both specifiers — esbuild did not drop a dynamic import it could not see
//       being used.
//   (f) `electron-builder.yml` ships `shell/dist/**`, so the packaged app can
//       resolve them at all.
//
// NO NETWORK, NO KEYS. Prints PASS/FAIL per assertion; exits non-zero on a FAIL.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NEXT_SERVER_TS = resolve(ROOT, 'electron/next-server.ts');
const SERVER_MJS = resolve(ROOT, 'shell/server.mjs');
const TSUP_CONFIG = resolve(ROOT, 'shell/tsup.server.ts');
const MAIN_BUNDLE = resolve(ROOT, 'dist/electron/main.mjs');
const BUILDER_YML = resolve(ROOT, 'electron-builder.yml');
const SHELL_DIST = resolve(ROOT, 'shell/dist');

type Check = { name: string; pass: boolean; evidence: string };

const checks: Check[] = [];
function record(name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

/** Read a required file, or return null so the check fails with a real reason. */
function readOrNull(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** Strip `//` line comments so a specifier named in prose is never mistaken for
 *  a live call site. This file's own subject matter is heavily commented, and a
 *  source assertion that passes on a comment asserts nothing. */
function stripLineComments(src: string): string {
  return src
    .split('\n')
    .map((line) => {
      const at = line.indexOf('//');
      if (at === -1) return line;
      // Keep anything before the comment marker; a `//` inside a string literal
      // is not a case that occurs in these files (no URLs with schemes).
      return line.slice(0, at);
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// (a) the reference behaviour — shell/server.mjs
// ---------------------------------------------------------------------------

function checkShellServer(): void {
  const raw = readOrNull(SERVER_MJS);
  if (raw === null) {
    record('(a) shell/server.mjs starts both background services', false, `missing: ${SERVER_MJS}`);
    return;
  }
  const src = stripLineComments(raw);
  const hasScheduled = /scheduledTaskManager\s*\}\s*=\s*await import\(/.test(src) &&
    /scheduledTaskManager\.init\(\)/.test(src);
  const hasTelegram = /startTelegramChat\s*\}\s*=\s*await import\(/.test(src) &&
    /startTelegramChat\(\)/.test(src);
  record(
    '(a) shell/server.mjs (the CLI path) starts the scheduled-task manager and the Telegram listener',
    hasScheduled && hasTelegram,
    `scheduledTaskManager.init()=${hasScheduled} startTelegramChat()=${hasTelegram}`,
  );
}

// ---------------------------------------------------------------------------
// (b) + (c) the embedded path — electron/next-server.ts
// ---------------------------------------------------------------------------

function checkEmbeddedServer(): void {
  const raw = readOrNull(NEXT_SERVER_TS);
  if (raw === null) {
    record('(b) electron/next-server.ts starts both background services', false, `missing: ${NEXT_SERVER_TS}`);
    record('(c) the embedded path imports the BUILT dist entries (one store)', false, 'source unavailable');
    return;
  }
  const src = stripLineComments(raw);

  // The specifiers are built with join(shellDir, 'dist', '<name>.mjs'), so match
  // the join form rather than a literal path — the literal never appears.
  const joinSpecifier = (name: string): RegExp =>
    new RegExp(`join\\(\\s*shellDir\\s*,\\s*'dist'\\s*,\\s*'${name}\\.mjs'\\s*\\)`);

  const importsScheduled = joinSpecifier('scheduledTasks').test(src);
  const importsTelegram = joinSpecifier('telegramChat').test(src);
  const callsInit = /manager\.init\(\)/.test(src);
  const callsTelegram = /startTelegramChat\(\)/.test(src);
  const wiresBroadcast = /setOnTaskFired\(/.test(src) && /broadcastToGlobalState/.test(src);

  record(
    '(b) electron/next-server.ts (the EMBEDDED path) imports both entries and starts both services',
    importsScheduled && importsTelegram && callsInit && callsTelegram,
    `import scheduledTasks.mjs=${importsScheduled} import telegramChat.mjs=${importsTelegram} ` +
      `init()=${callsInit} startTelegramChat()=${callsTelegram}`,
  );

  record(
    '(b2) the fired-task WS broadcast is attached, as the CLI server does',
    wiresBroadcast,
    `setOnTaskFired + broadcastToGlobalState present=${wiresBroadcast}`,
  );

  // The services must be started AFTER `app.prepare()` — before it, Next has not
  // built its module graph and the WS dispatcher is not installed, so a task
  // firing immediately on init() would broadcast into nothing.
  const prepareAt = src.indexOf('await app.prepare()');
  const servicesAt = src.indexOf('startBackgroundServices({');
  record(
    '(b3) the services are started AFTER app.prepare() and after the WS dispatcher is installed',
    prepareAt !== -1 && servicesAt !== -1 && servicesAt > prepareAt,
    `prepare@${prepareAt} startBackgroundServices@${servicesAt}`,
  );

  // Single-store semantics: nothing may reach around the built bundles into the
  // shell's TypeScript sources or its workspace package names. Either would be a
  // SECOND copy of the store and of the Telegram loop.
  const reachesAround =
    /@cockpit\/feature-agent\/server\/scheduledTasks/.test(src) ||
    /@cockpit\/feature-agent\/server\/lib\/telegramChatBoot/.test(src) ||
    /packages\/feature\/agent\/src\/server/.test(src);
  record(
    '(c) single store: the embedded path uses the BUILT dist entries only — no second bundling',
    importsScheduled && importsTelegram && !reachesAround,
    reachesAround
      ? 'a shell SOURCE specifier is imported — that is a second module realm (second store, second getUpdates loop)'
      : 'both services resolved through shell/dist/*.mjs, which share tsup chunks with wsServer.mjs',
  );
}

// ---------------------------------------------------------------------------
// (d) the build that makes chunk sharing true
// ---------------------------------------------------------------------------

function checkTsupAndDist(): void {
  const raw = readOrNull(TSUP_CONFIG);
  const src = raw === null ? '' : stripLineComments(raw);
  const declaresScheduled = /scheduledTasks\s*:/.test(src);
  const declaresTelegram = /telegramChat\s*:/.test(src);
  const declaresWs = /wsServer\s*:/.test(src);
  const splitting = /splitting\s*:\s*true/.test(src);
  record(
    '(d) shell/tsup.server.ts emits wsServer + scheduledTasks + telegramChat from ONE build with splitting on',
    raw !== null && declaresScheduled && declaresTelegram && declaresWs && splitting,
    raw === null
      ? `missing: ${TSUP_CONFIG}`
      : `wsServer=${declaresWs} scheduledTasks=${declaresScheduled} telegramChat=${declaresTelegram} splitting=${splitting}`,
  );

  const built = ['wsServer.mjs', 'scheduledTasks.mjs', 'telegramChat.mjs'];
  const missing = built.filter((f) => !existsSync(resolve(SHELL_DIST, f)));
  record(
    '(d2) the built entries exist in shell/dist/',
    missing.length === 0,
    missing.length === 0
      ? `present: ${built.join(', ')}`
      : `missing (run \`npm run build:shell\`): ${missing.join(', ')}`,
  );
}

// ---------------------------------------------------------------------------
// (e) the shipped main-process bundle
// ---------------------------------------------------------------------------

function checkMainBundle(): void {
  const src = readOrNull(MAIN_BUNDLE);
  if (src === null) {
    record(
      '(e) dist/electron/main.mjs still contains both dist specifiers',
      false,
      `missing: ${MAIN_BUNDLE} — run \`npm run build:electron\` (the spike script does this)`,
    );
    return;
  }
  const hasScheduled = src.includes('"scheduledTasks.mjs"') || src.includes("'scheduledTasks.mjs'");
  const hasTelegram = src.includes('"telegramChat.mjs"') || src.includes("'telegramChat.mjs'");
  record(
    '(e) the BUILT main-process bundle still references both entries (not tree-shaken)',
    hasScheduled && hasTelegram,
    `scheduledTasks.mjs=${hasScheduled} telegramChat.mjs=${hasTelegram} in ${MAIN_BUNDLE}`,
  );
}

// ---------------------------------------------------------------------------
// (f) packaging
// ---------------------------------------------------------------------------

function checkPackaging(): void {
  const src = readOrNull(BUILDER_YML);
  if (src === null) {
    record('(f) electron-builder ships shell/dist/**', false, `missing: ${BUILDER_YML}`);
    return;
  }
  // The include must be present AND not negated anywhere after it.
  const included = /^\s*-\s*shell\/dist\/\*\*\s*$/m.test(src);
  const excluded = /^\s*-\s*'?!shell\/dist/m.test(src);
  record(
    '(f) electron-builder.yml ships shell/dist/** — the packaged app can resolve both entries',
    included && !excluded,
    `include=${included} exclude=${excluded} (packaged-path behaviour is only truly verifiable on a GitHub artifact)`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

checkShellServer();
checkEmbeddedServer();
checkTsupAndDist();
checkMainBundle();
checkPackaging();

console.log('SPIKE — boot services parity between shell/server.mjs and the embedded Electron server\n');
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`      ${c.evidence}`);
}
const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} assertions passed`);
if (failed.length > 0) process.exit(1);
