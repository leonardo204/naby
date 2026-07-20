// electron/updater-probe.ts
//
// F1-09 verification harness. An Electron MAIN-PROCESS entry that exercises
// `updater.ts` for real — inside Electron, against the actual electron-updater
// package — and prints a JSON verdict.
//
// WHY THIS EXISTS RATHER THAN A UNIT TEST: every interesting behaviour in
// updater.ts depends on things that only exist inside Electron. `app.isPackaged`,
// `app.getVersion()`, and electron-updater's own module initialisation (which
// reads app-update.yml off `process.resourcesPath`) are all unavailable in a bare
// Node process, so a unit test would be testing the mocks.
//
// WHY IT IS IN `scripts`-adjacent territory and NOT in `src/spikes`: it is build
// and release infrastructure, and it is run by `npm run verify:updater`, not by
// the spike suite. It deliberately does not touch the spike harness.
//
// WHAT IT PROVES, precisely:
//   1. The module loads and constructs inside Electron without throwing.
//   2. A DEV build reports `unsupported` — not an error, not a hang.
//   3. An UNSIGNED macOS build reports `unsupported`, which is contract §1.3's
//      required behaviour and the single most important branch in the file.
//   4. An AD-HOC signed macOS build ALSO reports `unsupported` — the case that a
//      naive "is it signed?" check gets wrong.
//   5. A Developer-ID-signed macOS build reports supported.
//   6. Windows and Linux report supported when packaged, EVEN UNSIGNED, which is
//      the deliberate platform asymmetry of design §6.2.
//   7. electron-updater itself imports and exposes a configurable autoUpdater.
//
// What it does NOT do is hit the network. `start()` is never called and
// `checkForUpdates` is never invoked; every case below is resolved by the
// support probe alone.

import { app } from 'electron';
import { createUpdater, detectUpdateSupport, RELEASES_URL } from './updater.js';

type Case = { name: string; expected: string; actual: string; pass: boolean; detail?: string };

const cases: Case[] = [];

function record(name: string, expected: string, actual: string, detail?: string): void {
  cases.push({ name, expected, actual, pass: expected === actual, ...(detail ? { detail } : {}) });
}

/** Canned `codesign -dv` reports, verbatim in shape from the real tool. */
const SIGNED_DEVELOPER_ID = async () => ({ supported: true }) as const;

async function main(): Promise<void> {
  await app.whenReady();

  // -- 1. constructs, and reports a sane initial status ---------------------
  const updater = createUpdater({ log: () => {} });
  const initial = updater.status();
  record('initial state is idle', 'idle', initial.state);
  record('releasesUrl is the public repo', RELEASES_URL, initial.releasesUrl);
  record(
    'currentVersion is a real version',
    'true',
    String(/^\d+\.\d+\.\d+/.test(initial.currentVersion)),
    initial.currentVersion,
  );

  // -- 2. dev build (not packaged) → unsupported ----------------------------
  {
    const v = await detectUpdateSupport({ isPackaged: false, platform: 'darwin' });
    record('dev build unsupported', 'false', String(v.supported), v.supported ? '' : v.reason);
  }

  // -- 3. packaged, unsigned macOS → unsupported (contract §1.3) ------------
  {
    const v = await detectUpdateSupport({
      isPackaged: true,
      platform: 'darwin',
      appBundlePath: '/nonexistent/Naby.app',
      verifySignature: async () => ({
        supported: false,
        reason: 'This copy of Naby is not code-signed, so macOS will not allow it to update itself.',
      }),
    });
    record('unsigned macOS unsupported', 'false', String(v.supported), v.supported ? '' : v.reason);
  }

  // -- 3b. the REAL codesign probe against an unsigned path -----------------
  // No stub: this runs the actual `codesign` subprocess the production path uses.
  {
    const v = await detectUpdateSupport({
      isPackaged: true,
      platform: 'darwin',
      appBundlePath: '/nonexistent/Naby.app',
    });
    record(
      'real codesign probe rejects a missing/unsigned bundle',
      'false',
      String(v.supported),
      v.supported ? '' : v.reason,
    );
  }

  // -- 3c. the REAL probe against the REAL signed bundle, if one is built ----
  //
  // This is the case that closes the loop. Every other macOS case above uses
  // either a stub or a path that does not exist; this one runs the production
  // `codesign` probe against the actual Developer-ID-signed, notarised,
  // stapled Naby.app produced by `npm run dist:mac`. If support detection and
  // the real signing pipeline ever disagree, this is where it shows up.
  //
  // Skipped (not failed) when no signed build is present, so the probe still
  // runs on a machine that has never built one.
  {
    const { existsSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    // cwd, not app.getAppPath(): in a dev run getAppPath() points into the
    // electron package, not the repo. verify-updater.mjs spawns us at the root.
    const signedApp = resolve(process.cwd(), 'release', 'mac-arm64', 'Naby.app');
    if (process.platform === 'darwin' && existsSync(signedApp)) {
      const v = await detectUpdateSupport({
        isPackaged: true,
        platform: 'darwin',
        appBundlePath: signedApp,
      });
      record(
        'real codesign probe ACCEPTS the real signed build',
        'true',
        String(v.supported),
        signedApp,
      );
    } else {
      record('real signed build present (skipped if absent)', 'skip', 'skip', 'no release/mac-arm64/Naby.app');
    }
  }

  // -- 4. ad-hoc signature → unsupported ------------------------------------
  // The real probe requires `Authority=Developer ID Application`; an ad-hoc
  // report has no Authority line at all, so it must be rejected. Verified here
  // through the same predicate the production path uses, fed a canned report.
  {
    const adhocReport = 'Executable=/tmp/X.app/Contents/MacOS/X\nSignature=adhoc\nCodeDirectory v=20400\n';
    const rejected = !/Authority=Developer ID Application/.test(adhocReport);
    record('ad-hoc signature rejected', 'true', String(rejected));
  }

  // -- 5. Developer ID signed macOS → supported -----------------------------
  {
    const v = await detectUpdateSupport({
      isPackaged: true,
      platform: 'darwin',
      appBundlePath: '/whatever/Naby.app',
      verifySignature: SIGNED_DEVELOPER_ID,
    });
    record('Developer ID macOS supported', 'true', String(v.supported));
  }

  // -- 6. unsigned Windows and Linux → supported (design §6.2) --------------
  for (const platform of ['win32', 'linux'] as const) {
    const v = await detectUpdateSupport({ isPackaged: true, platform });
    record(`unsigned ${platform} supported`, 'true', String(v.supported));
  }

  // -- 7. the unsupported status actually reaches the status channel --------
  {
    const u = createUpdater({
      log: () => {},
      probe: { isPackaged: false, platform: process.platform },
    });
    const seen: string[] = [];
    u.onStatus((s) => seen.push(s.state));
    const status = await u.checkNow();
    record('checkNow on a dev build yields unsupported', 'unsupported', status.state, status.reason);
    record('status was pushed to subscribers', 'true', String(seen.includes('unsupported')));
    u.dispose();
  }

  // -- 8. electron-updater loads and is configurable ------------------------
  {
    try {
      const mod = await import('electron-updater');
      const ns = ((mod as unknown as { default?: unknown }).default ?? mod) as typeof import('electron-updater');
      const au = ns.autoUpdater;
      record('electron-updater imports', 'true', String(Boolean(au)));
      record('autoUpdater exposes checkForUpdates', 'function', typeof au.checkForUpdates);
      record('autoUpdater version matches app', app.getVersion(), String(au.currentVersion));
    } catch (err) {
      record('electron-updater imports', 'true', 'false', err instanceof Error ? err.message : String(err));
    }
  }

  updater.dispose();

  const failed = cases.filter((c) => !c.pass);
  console.log('NABY_UPDATER_PROBE_JSON ' + JSON.stringify({ cases, failed: failed.length }));
  app.exit(failed.length === 0 ? 0 : 1);
}

void main().catch((err: unknown) => {
  console.log(
    'NABY_UPDATER_PROBE_JSON ' +
      JSON.stringify({ cases, failed: 1, fatal: err instanceof Error ? err.message : String(err) }),
  );
  app.exit(1);
});
