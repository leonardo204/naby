// electron/devmode.ts
//
// FORCED DEV MODE — turning the dev-only providers on inside a shipped build.
//
// WHY THIS EXISTS. The Claude local sign-in and the ChatGPT subscription path
// are sealed in a packaged build on purpose (main.ts only auto-opens the seal
// when `!app.isPackaged`; see the ToS note in providers/chatgpt-oauth.ts). That
// is right for users and wrong for the person who has to TEST the thing they
// just released: reproducing a bug in the real artifact meant rebuilding it
// unpackaged, which is a different binary from the one that shipped.
//
// WHAT SHIPS, AND WHY IT IS NOT THE KEY. The build bakes in a SHA-256 of
// `FORCE_DEVMODE_KEY`, never the key itself. That distinction is the whole
// security story: a packaged app is a zip anyone can open, so a plaintext secret
// compiled into it is a published secret — `strings` on the asar would hand it
// to every user, and the seal that exists for ToS reasons would be open to all
// of them. A hash gives an attacker a brute-force problem instead, and gives us
// the same UX.
//
// When no key is configured at build time the hash is empty, every unlock
// attempt fails, and the UI hides the control entirely — an official build has
// no dev-mode door at all, not even a locked one.
//
// WHY A MARKER FILE AND A RESTART. `boot()` reads `isChatgptOauthEnabled()` once
// to decide whether to install the vault-backed token source, so flipping an
// in-memory flag after boot would change nothing observable. Unlocking therefore
// writes a marker that `main.ts` consults BEFORE boot on the next launch. The UI
// says so rather than pretending the switch took effect.

import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * SHA-256 of `FORCE_DEVMODE_KEY`, injected by scripts/build-electron.mjs at
 * build time. Empty string when the building environment had no key — which is
 * the case for any build made from a checkout without that `.env` entry.
 */
declare const __NABY_DEVMODE_HASH__: string;
const EXPECTED_HASH: string =
  typeof __NABY_DEVMODE_HASH__ === 'string' ? __NABY_DEVMODE_HASH__ : '';

/** Lives beside the database rather than in userData: `~/.naby` is the one home
 *  every launch mode already agrees on (see main.ts's migration). */
function markerPath(): string {
  const home = process.env.NABY_HOME || join(homedir(), '.naby');
  return join(home, 'devmode-unlocked');
}

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** Whether this build has a dev-mode door at all. */
export function isDevModeAvailable(): boolean {
  return EXPECTED_HASH.length > 0;
}

/** Whether the door is currently open — read fresh, so an external edit or a
 *  lock from another window is honoured. */
export function isDevModeUnlocked(): boolean {
  if (!isDevModeAvailable()) return false;
  try {
    if (!existsSync(markerPath())) return false;
    // The marker records the hash it was opened with. A build signed with a
    // DIFFERENT key must not inherit a previous build's unlock.
    return readFileSync(markerPath(), 'utf8').trim() === EXPECTED_HASH;
  } catch {
    return false;
  }
}

/**
 * Compare a user-supplied key against the baked hash and, on a match, open the
 * door for subsequent launches.
 *
 * The comparison is constant-time. The window here is small — an attacker with
 * the app can hash offline far faster than they can drive this dialog — but a
 * timing-variable compare is the kind of thing that gets copied into somewhere
 * it matters, so it is written correctly once.
 */
export function unlockDevMode(key: string): boolean {
  if (!isDevModeAvailable()) return false;
  const candidate = Buffer.from(sha256(key ?? ''), 'utf8');
  const expected = Buffer.from(EXPECTED_HASH, 'utf8');
  if (candidate.length !== expected.length) return false;
  if (!timingSafeEqual(candidate, expected)) return false;

  try {
    mkdirSync(dirname(markerPath()), { recursive: true });
    writeFileSync(markerPath(), `${EXPECTED_HASH}\n`, { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch {
    // Could not persist — report failure rather than claim an unlock that will
    // not survive the restart the user is about to be asked for.
    return false;
  }
}

/** Close the door again. Takes effect on the next launch, like opening it. */
export function lockDevMode(): void {
  try {
    rmSync(markerPath(), { force: true });
  } catch {
    /* nothing useful to do; the next status read reports the truth */
  }
}

/**
 * Apply the unlock to this process, BEFORE boot() reads the seal.
 *
 * Only ever turns the seal ON: an explicit env var already set by whoever
 * launched the app wins, so this cannot override a deliberate
 * `NABY_ENABLE_CHATGPT_OAUTH=0`.
 */
export function applyDevModeToEnv(): void {
  if (!isDevModeUnlocked()) return;
  if ('NABY_ENABLE_CHATGPT_OAUTH' in process.env) return;
  process.env.NABY_ENABLE_CHATGPT_OAUTH = '1';
  console.log('[devmode] unlocked by key — dev providers enabled for this launch');
}
