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
// EVERY READ FAILS SOFT. A missing file is a fresh install, and so is a corrupt
// one: both answer `null`, the renderer records the current version silently,
// and nothing is shown. A startup path that can throw is not worth a changelog.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

type WhatsNewFile = {
  version: 1;
  /** The app version whose notes the user has already been shown. */
  lastSeenVersion?: string;
  /** When it was recorded. Diagnostics only; nothing reads it. */
  seenAt?: number;
};

export class WhatsNewStore {
  readonly filePath: string;

  constructor(opts: { userDataDir: string; fileName?: string }) {
    this.filePath = join(opts.userDataDir, opts.fileName ?? 'whats-new.json');
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
