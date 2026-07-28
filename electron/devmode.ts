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
 * What an unlock attempt did. This used to be a bare boolean, and that was a
 * mistake worth naming: a key that did not match and a key that matched but
 * could not be written to disk are different problems with different fixes, and
 * collapsing them meant the UI told the user "wrong key" for both. Whoever is
 * holding the right key then has no way to find out what actually went wrong.
 */
export type UnlockOutcome =
  /** Key matched and the marker was persisted. Takes effect next launch. */
  | 'unlocked'
  /** The key hashed to something else. */
  | 'mismatch'
  /** This build has no door — no key can open it. */
  | 'unavailable'
  /** Key matched, but the marker could not be written; it would not survive a restart. */
  | 'not-persisted';

/** Constant-time compare of `candidate`'s SHA-256 against the baked hash. */
function matches(candidate: string): boolean {
  const a = Buffer.from(sha256(candidate), 'utf8');
  const b = Buffer.from(EXPECTED_HASH, 'utf8');
  // Both are hex digests of the same algorithm, so unequal lengths mean the
  // baked value is not a digest at all. Bail rather than throw.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Compare a user-supplied key against the baked hash and, on a match, open the
 * door for subsequent launches.
 *
 * The comparison is constant-time. The window here is small — an attacker with
 * the app can hash offline far faster than they can drive this dialog — but a
 * timing-variable compare is the kind of thing that gets copied into somewhere
 * it matters, so it is written correctly once.
 *
 * TOLERATES SURROUNDING WHITESPACE, by trying the exact string first and the
 * trimmed one only if that fails. Keys get pasted out of a `.env` line or a
 * terminal, and a trailing newline rides along invisibly in a password field —
 * an unreadable input that silently rejects correct keys is a trap. Trying the
 * exact value first means a key that genuinely contains edge whitespace still
 * works; the fallback can only ever accept more, never less.
 */
export function unlockDevMode(key: string): UnlockOutcome {
  if (!isDevModeAvailable()) return 'unavailable';

  const typed = key ?? '';
  if (!matches(typed) && !matches(typed.trim())) return 'mismatch';

  try {
    mkdirSync(dirname(markerPath()), { recursive: true });
    writeFileSync(markerPath(), `${EXPECTED_HASH}\n`, { encoding: 'utf8', mode: 0o600 });
    return 'unlocked';
  } catch (err) {
    // Could not persist — say so rather than claim an unlock that will not
    // survive the restart the user is about to be asked for, and log the reason,
    // because "correct key, unwritable home" is invisible from the UI alone.
    console.error(`[devmode] key matched but the marker could not be written: ${String(err)}`);
    return 'not-persisted';
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
