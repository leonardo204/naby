/**
 * app-version.ts — what version of naby this is, reliably.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY `app.getVersion()` IS NOT THE ANSWER
 *
 * Electron resolves the app version from the app's `package.json`, and FALLS
 * BACK TO THE VERSION OF THE EXECUTABLE when it cannot find one. `electron:dev`
 * launches a FILE — `electron dist/electron/main.mjs` — so there is no directory
 * with a `package.json` beside it, and every caller in a development run was
 * told naby's version was `43.1.1`: Electron's own.
 *
 * That was not cosmetic. The what's-new watermark is PERSISTED, into a userData
 * directory the dev run and the packaged app share, so a single dev launch
 * stamped `43.1.1` on disk — a number no real release can ever exceed — and the
 * popup went silent permanently, on an installation that had never done anything
 * wrong.
 *
 * So the version is baked in at build time from the one file that states it, and
 * `app.getVersion()` is kept only as the fallback for a harness that was built
 * some other way.
 */
import { app } from 'electron';

declare const __NABY_APP_VERSION__: string;

/** Injected by scripts/build-electron.mjs from package.json. Absent only in a
 *  harness compiled without that define. */
const BAKED: string = typeof __NABY_APP_VERSION__ === 'string' ? __NABY_APP_VERSION__ : '';

/**
 * Naby's version.
 *
 * `0.0.0` is the last resort and is deliberately unparseable as an upgrade from
 * anything real: a harness that reads it shows no release notes rather than all
 * of them, and — more importantly — writes no watermark that could outrank a
 * real release.
 */
export function nabyVersion(): string {
  if (BAKED) return BAKED;
  try {
    // A packaged app answers correctly here; this is the path for a build that
    // somehow carries no define.
    return app.getVersion();
  } catch {
    return '0.0.0';
  }
}
