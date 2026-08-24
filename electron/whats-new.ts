// electron/whats-new.ts
//
// "What changed" — the ONE fact the release-notes popup needs to persist: the
// last app version this installation actually ran and showed notes for.
//
// WHY THIS LIVES IN THE MAIN PROCESS AND NOT IN THE RENDERER. The obvious home
// for a once-per-version dismissal is `localStorage`, and it is wrong HERE for
// a reason that is specific to this app: `electron/next-server.ts` binds with
// `server.listen(0)`, so the embedded server takes a fresh ephemeral port on
// every launch and the renderer's origin (`http://127.0.0.1:<port>`) is
// different every time. `localStorage` is keyed by origin, so after a restart
// it is ALWAYS empty — selectionChatOps.ts already records that finding for the
// popup size. A version watermark kept there would read "no previous version"
// on every single launch, which by rule 2 (never announce to a brand-new user)
// means the popup would never appear at all. Silently. Forever.
//
// The file is `<userData>/whats-new.json`, deliberately the same shape and the
// same directory as `providers.json` (electron/providers.ts) — the existing
// once-only-state precedent in this codebase. Not app.db: this is desktop-side
// installation state with no relation to a session, a project or a memory, and
// keeping it out of the store means the popup cannot be broken by a store
// migration and needs none of its own.
//
// EVERY READ FAILS SOFT. A missing file is no watermark, and so is a corrupt
// one: both answer `null`. A startup path that can throw is not worth a
// changelog.
//
// A MISSING WATERMARK IS NOT THE SAME AS A NEW USER, which is the bug this file
// grew a second answer for. Every installation that existed before the popup
// shipped has no watermark either, and reading that as "brand-new user" made
// the first launch after an update — the one launch the whole feature is for —
// the one launch that said nothing. `looksLikeFreshInstall` below is the fact
// that separates them, and it is a fact about the DISK, which only the main
// process can see.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

type WhatsNewFile = {
  version: 1;
  /** The app version whose notes the user has already been shown. */
  lastSeenVersion?: string;
  /** When it was recorded. Diagnostics only; nothing reads it. */
  seenAt?: number;
};

/**
 * Has this installation NEVER run before?
 *
 * Answered from the state files earlier launches leave behind — the caller
 * names them (`electron/boot.ts` passes the real `filePath` of each store, so
 * this cannot drift from where those files actually live). ANY of them existing
 * means the app has run here before; none existing means this is the first
 * launch of a new installation, which is the only case that must stay silent.
 *
 * TWO THINGS MAKE THIS CORRECT, and both are easy to lose:
 *
 *   1. IT MUST BE LATCHED, not asked later. Every path handed in is a file THIS
 *      launch will create within seconds — the vault on the first key, app.db
 *      when the embedded server opens the store, the window state on the first
 *      move. Asked after boot it would answer "not fresh" on a brand-new
 *      installation's first launch, which is exactly the answer that would put
 *      a changelog in a new user's face.
 *   2. THE WATERMARK FILE IS NOT EVIDENCE. Its absence is the question being
 *      asked; including it would make the answer "yes, fresh" every time and
 *      restore the original bug.
 *
 * A path that cannot be tested (permissions, a disappearing volume) counts as
 * absent: the failure then leans towards silence, not towards announcing.
 */
export function looksLikeFreshInstall(priorStatePaths: readonly string[]): boolean {
  return !priorStatePaths.some((path) => {
    try {
      return existsSync(path);
    } catch {
      return false;
    }
  });
}

export class WhatsNewStore {
  readonly filePath: string;

  readonly #freshInstall: boolean;

  constructor(opts: { userDataDir: string; fileName?: string; freshInstall?: boolean }) {
    this.filePath = join(opts.userDataDir, opts.fileName ?? 'whats-new.json');
    // Conservative default, matching the renderer's: an unstated answer means
    // "treat it as a new installation", i.e. say nothing.
    this.#freshInstall = opts.freshInstall ?? true;
  }

  /**
   * The latched answer to "has this installation ever run before", as decided
   * at boot. Stored beside the watermark because the renderer needs BOTH facts
   * to make one decision, and a caller that could get one without the other
   * would eventually get exactly one of them.
   */
  isFreshInstall(): boolean {
    return this.#freshInstall;
  }

  /**
   * The recorded version, or `null` for "this installation has never recorded
   * one" — which the renderer treats as a fresh install.
   *
   * A non-string value is `null` too. The renderer parses whatever it gets and
   * falls back to the fresh-install branch on anything it cannot read, so the
   * two layers agree without either trusting the other.
   */
  lastSeenVersion(): string | null {
    if (!existsSync(this.filePath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<WhatsNewFile>;
      const value = parsed.lastSeenVersion;
      return typeof value === 'string' && value ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * Record a version as seen. Last write wins — there is no merge to do and no
   * history to keep, because the ONLY question ever asked of this file is
   * "which version was the user last told about".
   *
   * Written through a temp file and renamed, like providers.json: a half-written
   * JSON here would read as a fresh install and re-silence the popup.
   */
  record(version: string): void {
    if (typeof version !== 'string' || !version) return;
    const file: WhatsNewFile = { version: 1, lastSeenVersion: version, seenAt: Date.now() };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
    renameSync(tmp, this.filePath);
  }
}
