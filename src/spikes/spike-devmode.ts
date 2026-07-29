// src/spikes/spike-devmode.ts
//
// FORCED DEV MODE verification — electron/devmode.ts, the key-gated door that
// lets a SHIPPED build run the dev-only providers.
//
// WHY THIS SPIKE EXISTS. Two bugs shipped here in a row, and neither was
// catchable by reading the source: v1.4.0 baked an EMPTY hash because CI had no
// key (door absent from a release that needed one), and v1.5.0 baked the right
// hash but reported every failure — mismatch, unwritable home, no door at all —
// as the single word "wrong key", so a correct key being rejected was
// undiagnosable. Both live in the seam between the BUILD-TIME define and the
// runtime compare, which is exactly the seam a unit test that imports the
// TypeScript directly would skip.
//
// So this drives the REAL path: esbuild bundles electron/devmode.ts with a
// `__NABY_DEVMODE_HASH__` define, the same way scripts/build-electron.mjs does,
// and the assertions run against that bundle.
//
// It proves:
//
//   (a) NO KEY AT BUILD TIME -> NO DOOR. Empty define: unavailable, every unlock
//       attempt returns 'unavailable', and nothing is ever written.
//   (b) RIGHT KEY OPENS IT. 'unlocked', a 0600 marker holding the build's hash,
//       and isDevModeUnlocked() true on a fresh read.
//   (c) WRONG KEY IS 'mismatch' — distinct from every other failure.
//   (d) WHITESPACE TOLERANCE. A key pasted with a trailing newline or leading
//       space still opens the door; this is the v1.5.0 field report.
//   (e) UNWRITABLE HOME IS 'not-persisted', NOT 'mismatch'. The regression that
//       made a correct key look wrong.
//   (f) A MARKER FROM A DIFFERENT BUILD IS NOT HONOURED. Re-signing with another
//       key must not inherit the previous build's unlock.
//   (g) LOCK CLOSES IT, and is idempotent when nothing is open.
//   (h) applyDevModeToEnv() ONLY EVER TURNS THE SEAL ON, and never overrides an
//       explicit NABY_ENABLE_CHATGPT_OAUTH set by whoever launched the app.
//   (i) THE IPC HANDLER PASSES THE KEY. `handle(channel, fn)` calls
//       `fn(payload, event)`; the unlock handler was written `(_e, key)` as if
//       it were a raw ipcMain listener, so the key landed in the ignored
//       parameter and an EMPTY STRING reached the compare. Every correct key was
//       rejected. Both parameters are `unknown`, so nothing above catches it —
//       (a)-(h) all pass with the wiring inverted, because they call
//       unlockDevMode directly.
//
// NO NETWORK, NO KEYS, NO REAL ~/.naby — NABY_HOME is pointed at a temp dir for
// the whole run. Prints PASS/FAIL per assertion; exits non-zero on any FAIL.

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

type Check = { name: string; pass: boolean; evidence: string };

function record(checks: Check[], name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

type UnlockOutcome = 'unlocked' | 'mismatch' | 'unavailable' | 'not-persisted';

interface DevModeModule {
  isDevModeAvailable(): boolean;
  isDevModeUnlocked(): boolean;
  unlockDevMode(key: string): UnlockOutcome;
  lockDevMode(): void;
  applyDevModeToEnv(): void;
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const KEY = 'correct-horse-battery-staple';
const OTHER_KEY = 'a-different-signing-key';

/**
 * Bundle electron/devmode.ts exactly as the electron build does — same define,
 * same platform — and load the result. `seq` only keeps the ESM loader from
 * handing back a cached module for a second bundle at the same path.
 */
async function loadDevmode(hash: string, outDir: string, seq: number): Promise<DevModeModule> {
  const outfile = join(outDir, `devmode-${seq}.mjs`);
  await build({
    entryPoints: ['electron/devmode.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    define: { __NABY_DEVMODE_HASH__: JSON.stringify(hash) },
    logLevel: 'silent',
  });
  return (await import(pathToFileURL(outfile).href)) as DevModeModule;
}

function markerFile(): string {
  return join(process.env.NABY_HOME as string, 'devmode-unlocked');
}

/** Best-effort read of the marker; absence and unreadability are the same here. */
function markerContents(): string | null {
  try {
    return readFileSync(markerFile(), 'utf8');
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const checks: Check[] = [];
  const tmp = mkdtempSync(join(tmpdir(), 'naby-devmode-'));
  const home = join(tmp, 'home');
  mkdirSync(home, { recursive: true });

  // Every markerPath() call reads NABY_HOME fresh, so the real ~/.naby is never
  // touched by this spike.
  process.env.NABY_HOME = home;
  delete process.env.NABY_ENABLE_CHATGPT_OAUTH;

  try {
    // -- (a) no key at build time -> no door -------------------------------
    const noDoor = await loadDevmode('', tmp, 0);
    record(
      checks,
      '(a) empty define reports no door',
      noDoor.isDevModeAvailable() === false && noDoor.isDevModeUnlocked() === false,
      `available=${noDoor.isDevModeAvailable()} unlocked=${noDoor.isDevModeUnlocked()}`,
    );
    const noDoorAttempt = noDoor.unlockDevMode(KEY);
    record(
      checks,
      "(a) unlocking a doorless build is 'unavailable', not 'mismatch'",
      noDoorAttempt === 'unavailable' && markerContents() === null,
      `outcome=${noDoorAttempt} marker=${markerContents() === null ? 'absent' : 'WRITTEN'}`,
    );

    // -- (b) right key opens it --------------------------------------------
    const dm = await loadDevmode(sha256(KEY), tmp, 1);
    const opened = dm.unlockDevMode(KEY);
    const marker = markerContents();
    record(
      checks,
      '(b) the right key unlocks and persists the build hash',
      opened === 'unlocked' && marker?.trim() === sha256(KEY) && dm.isDevModeUnlocked() === true,
      `outcome=${opened} marker=${marker?.trim().slice(0, 12)}… unlocked=${dm.isDevModeUnlocked()}`,
    );
    // The marker records an unlock, so it is owner-only: 0600, not 0644.
    const mode = statSync(markerFile()).mode & 0o777;
    record(
      checks,
      '(b) the marker is written 0600',
      mode === 0o600,
      `mode=0o${mode.toString(8)}`,
    );

    // -- (c) wrong key -----------------------------------------------------
    record(
      checks,
      "(c) a wrong key is 'mismatch'",
      dm.unlockDevMode('not-the-key') === 'mismatch',
      `outcome=${dm.unlockDevMode('not-the-key')}`,
    );

    // -- (d) whitespace tolerance — the v1.5.0 field report -----------------
    dm.lockDevMode();
    const pastedNewline = dm.unlockDevMode(`${KEY}\n`);
    record(
      checks,
      '(d) a key pasted with a trailing newline still opens the door',
      pastedNewline === 'unlocked',
      `outcome=${pastedNewline}`,
    );
    dm.lockDevMode();
    const pastedSpaces = dm.unlockDevMode(`  ${KEY}  `);
    record(
      checks,
      '(d) surrounding spaces are tolerated too',
      pastedSpaces === 'unlocked',
      `outcome=${pastedSpaces}`,
    );
    // Tolerance must only ever ACCEPT MORE: an inner edit is still a mismatch.
    const innerEdit = dm.unlockDevMode(KEY.replace('-', ' '));
    record(
      checks,
      '(d) tolerance does not extend to whitespace INSIDE the key',
      innerEdit === 'mismatch',
      `outcome=${innerEdit}`,
    );

    // -- (e) unwritable home is 'not-persisted', not 'mismatch' -------------
    // A FILE where the home directory should be: mkdir -p cannot pass through it.
    const blocker = join(tmp, 'blocked');
    writeFileSync(blocker, 'not a directory\n');
    process.env.NABY_HOME = join(blocker, 'naby');
    const unwritable = dm.unlockDevMode(KEY);
    record(
      checks,
      "(e) a correct key with an unwritable home is 'not-persisted'",
      unwritable === 'not-persisted',
      `outcome=${unwritable}`,
    );
    process.env.NABY_HOME = home;

    // -- (f) a marker from a different build is not honoured ----------------
    writeFileSync(markerFile(), `${sha256(OTHER_KEY)}\n`, { mode: 0o600 });
    record(
      checks,
      "(f) another build's marker does not unlock this one",
      dm.isDevModeUnlocked() === false,
      `unlocked=${dm.isDevModeUnlocked()}`,
    );

    // -- (g) lock ----------------------------------------------------------
    dm.unlockDevMode(KEY);
    dm.lockDevMode();
    const lockedOut = dm.isDevModeUnlocked() === false && markerContents() === null;
    dm.lockDevMode(); // idempotent: nothing to remove, must not throw
    record(
      checks,
      '(g) lock removes the marker and is idempotent',
      lockedOut && dm.isDevModeUnlocked() === false,
      `unlocked=${dm.isDevModeUnlocked()} marker=${markerContents() === null ? 'absent' : 'present'}`,
    );

    // -- (h) applyDevModeToEnv ---------------------------------------------
    delete process.env.NABY_ENABLE_CHATGPT_OAUTH;
    dm.applyDevModeToEnv();
    record(
      checks,
      '(h) a locked door leaves the seal alone',
      !('NABY_ENABLE_CHATGPT_OAUTH' in process.env),
      `seal=${process.env.NABY_ENABLE_CHATGPT_OAUTH ?? '<unset>'}`,
    );

    dm.unlockDevMode(KEY);
    dm.applyDevModeToEnv();
    record(
      checks,
      '(h) an unlocked door opens the seal for this process',
      process.env.NABY_ENABLE_CHATGPT_OAUTH === '1',
      `seal=${process.env.NABY_ENABLE_CHATGPT_OAUTH ?? '<unset>'}`,
    );

    // An explicit choice by whoever launched the app outranks the marker.
    process.env.NABY_ENABLE_CHATGPT_OAUTH = '0';
    dm.applyDevModeToEnv();
    record(
      checks,
      '(h) an explicit NABY_ENABLE_CHATGPT_OAUTH=0 is never overridden',
      process.env.NABY_ENABLE_CHATGPT_OAUTH === '0',
      `seal=${process.env.NABY_ENABLE_CHATGPT_OAUTH}`,
    );

    // -- (i) the handler must forward the PAYLOAD, not the event -------------
    const ipcSrc = readFileSync(join(REPO, 'electron', 'ipc.ts'), 'utf8');
    const unlockHandler = /handle\('devmode:unlock',\s*\(([^)]*)\)/.exec(ipcSrc);
    const firstParam = unlockHandler?.[1]?.split(',')[0]?.trim().split(':')[0]?.trim();
    record(
      checks,
      '(i) the unlock IPC handler reads the payload, not the event',
      firstParam === 'payload',
      `first parameter = ${firstParam ?? '<handler not found>'}`,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  let failed = 0;
  for (const c of checks) {
    if (!c.pass) failed += 1;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  [${c.evidence}]`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  if (failed > 0) process.exit(1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
