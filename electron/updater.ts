// electron/updater.ts
//
// F1-09 — auto-update, and the `update:status` channel of contract §1.3.
//
// THE WHOLE POINT OF THIS FILE IS THAT AUTO-UPDATE IS NOT UNIFORM ACROSS THE
// THREE PLATFORMS, AND PRETENDING OTHERWISE PRODUCES A SILENT FAILURE.
// Design §6.2, restated because every line below follows from it:
//
//   Windows  WORKS UNSIGNED. electron-updater skips signature verification
//            entirely when `publisherName` is null, which is exactly the
//            unsigned case. We have no Windows certificate yet, so this ships
//            unsigned and updates anyway.
//   Linux    WORKS. AppImage and deb are both auto-updatable.
//   macOS    BLOCKED UNLESS SIGNED. Squirrel.Mac captures the RUNNING app's
//            designated requirement via SecCodeCopySelf() and validates the
//            downloaded archive against it. On an unsigned app the very first
//            step fails. There is no electron-updater switch for this — the
//            control lives in Apple's Security framework, not in our code.
//
// So on macOS this module asks a question no other platform needs asked: is the
// app I am running actually signed with a Developer ID? If it is not, the honest
// answer to the user is "I cannot update myself, here is where to download" —
// state `'unsupported'` in the contract — and NOT a checking spinner that
// resolves to nothing, or a download that fails at the moment of applying.
//
// THE ONE-WAY DOOR, repeated here because this file is where someone will one
// day be tempted to walk through it: because Squirrel validates against the
// RUNNING app's designated requirement, changing the macOS signing identity
// strands every already-installed user with no auto-update path at all. Windows
// has an escape hatch (`publisherName` accepts an array, so an old and a new
// name can both be honoured); macOS has none. The identity is
// `Developer ID Application: YONGSUB LEE (XU8HS9JUTS)` and it is permanent.

import { app, BrowserWindow, dialog, shell } from 'electron';
import { execFile } from 'node:child_process';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Contract §1.3 — the `update:status` payload
// ---------------------------------------------------------------------------
//
// `state` and `version` are the contract. Everything else is additive and
// optional: a renderer written against the contract alone still works, and a
// renderer that wants a progress bar or a reason string can have one.

export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'unsupported';

export type UpdateStatus = {
  state: UpdateState;
  /** The version being offered — present from `available` onward. */
  version?: string;
  /** 0–100, only while `downloading`. */
  percent?: number;
  /** Why updating is unsupported, in words a non-developer can act on. */
  reason?: string;
  /** Last error message, if a check or download failed. Never a stack trace. */
  error?: string;
  /** Where to download by hand. Always present, so the UI never has a dead end. */
  releasesUrl: string;
  /** The version currently running, so the UI can say "you have X, Y is out". */
  currentVersion: string;
};

/** The public releases page. Public repo — no token is embedded anywhere. */
export const RELEASES_URL = 'https://github.com/leonardo204/naby/releases/latest';

// ---------------------------------------------------------------------------
// Support detection
// ---------------------------------------------------------------------------

export type SupportVerdict = { supported: true } | { supported: false; reason: string };

/**
 * Is the app I am running actually signed with a Developer ID?
 *
 * WHY THIS IS A `codesign` SPAWN AND NOT A FLAG. There is no Electron API that
 * answers it. The distinctions that matter here are invisible from JS:
 *
 *   unsigned      — no signature at all. Squirrel's SecCodeCopySelf() fails.
 *   ad-hoc (`-`)  — passes `codesign --verify`, and would fool a naive check.
 *                   Its designated requirement is pinned to the binary's own
 *                   cdhash, which by construction differs in the NEXT build, so
 *                   every update would fail validation at the last moment. This
 *                   is the case worth spending a subprocess to exclude.
 *   Developer ID  — the only signature whose designated requirement is stable
 *                   across builds, i.e. the only one that can ever update.
 *
 * So the test is not "is it signed" but "is the authority a Developer ID", which
 * is what the Authority line of `codesign -dv` reports. Failure is treated as
 * unsupported in every direction — an unreadable signature is not a signature.
 */
function verifyDeveloperIdSignature(appPath: string): Promise<SupportVerdict> {
  return new Promise((resolve) => {
    execFile(
      'codesign',
      ['-dv', '--verbose=4', appPath],
      { timeout: 15_000 },
      (err, _stdout, stderr) => {
        // codesign writes its report to STDERR even on success. A non-zero exit
        // means unsigned or unreadable; both are "cannot update".
        const report = String(stderr ?? '');
        if (err && !/Authority=/.test(report)) {
          resolve({
            supported: false,
            reason: 'This copy of Naby is not code-signed, so macOS will not allow it to update itself.',
          });
          return;
        }
        if (!/Authority=Developer ID Application/.test(report)) {
          resolve({
            supported: false,
            reason:
              'This copy of Naby is not signed with a Developer ID, so macOS will not allow it to update itself.',
          });
          return;
        }
        resolve({ supported: true });
      },
    );
  });
}

/** The `.app` bundle root, which is what `codesign` wants — not the executable. */
function macAppBundlePath(): string {
  // …/Naby.app/Contents/MacOS/Naby → …/Naby.app
  return join(app.getPath('exe'), '..', '..', '..');
}

export type SupportProbe = {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  /** Injected in tests; production uses the real `codesign` probe. */
  verifySignature?: (appPath: string) => Promise<SupportVerdict>;
  appBundlePath?: string;
};

export async function detectUpdateSupport(probe: SupportProbe): Promise<SupportVerdict> {
  // A `electron dist/electron/main.mjs` run has no installer, no app-update.yml
  // and no signature. electron-updater itself throws here; saying so up front is
  // better than surfacing its exception as an error state.
  if (!probe.isPackaged) {
    return {
      supported: false,
      reason: 'Updates are disabled in a development build.',
    };
  }

  // Windows: unsigned auto-update works, deliberately (design §6.2). Do not add
  // a signature check here — it would turn a working path into a broken one.
  // Linux: AppImage and deb are both updatable.
  if (probe.platform !== 'darwin') return { supported: true };

  const verify = probe.verifySignature ?? verifyDeveloperIdSignature;
  return verify(probe.appBundlePath ?? macAppBundlePath());
}

// ---------------------------------------------------------------------------
// The updater
// ---------------------------------------------------------------------------

export type UpdaterDeps = {
  log?: (msg: string) => void;
  /** How often to re-check after the first check. Default 6h. */
  intervalMs?: number;
  /** Delay before the FIRST check, so it never competes with boot. Default 20s. */
  initialDelayMs?: number;
  /** Test seam — see detectUpdateSupport. */
  probe?: Partial<SupportProbe>;
  /**
   * Test seam — the "Update ready" dialog. Resolves to the index of the button
   * the user pressed, matching `dialog.showMessageBox`'s `response`: 0 is
   * "Restart now", 1 is "Later". Production leaves this unset and gets the real
   * dialog. It exists because the one behaviour worth regression-testing here —
   * that the prompt appears ONCE per version — is otherwise only observable as
   * a modal window, which no harness can see.
   */
  showRestartPrompt?: (version: string) => Promise<number>;
};

export type Updater = {
  /** The latest status. Cheap; the renderer gets this on connect. */
  status(): UpdateStatus;
  /**
   * Begin checking. Called by the PRODUCTION entry only — `boot()` constructs
   * the updater but never starts it, so the spike harness performs no network
   * I/O and its assertions are unaffected.
   */
  start(): void;
  /** User-initiated check. Resolves once the check settles. */
  checkNow(): Promise<UpdateStatus>;
  /** Restart into the downloaded update. No-op unless state is `ready`. */
  installNow(): void;
  /** Open the releases page in the real browser — the `unsupported` escape. */
  openReleasesPage(): Promise<void>;
  /** Push status to a window as it changes. Returns an unsubscriber. */
  onStatus(fn: (s: UpdateStatus) => void): () => void;
  dispose(): void;
};

export function createUpdater(deps: UpdaterDeps = {}): Updater {
  const log = deps.log ?? ((msg: string) => console.log(msg));
  const intervalMs = deps.intervalMs ?? 6 * 60 * 60 * 1000;
  const initialDelayMs = deps.initialDelayMs ?? 20_000;

  const currentVersion = safeVersion();
  let status: UpdateStatus = {
    state: 'idle',
    releasesUrl: RELEASES_URL,
    currentVersion,
  };

  const listeners = new Set<(s: UpdateStatus) => void>();
  let timer: NodeJS.Timeout | undefined;
  let started = false;
  let disposed = false;
  let supportPromise: Promise<SupportVerdict> | undefined;
  let settle: ((s: UpdateStatus) => void) | undefined;

  // -- why the prompt needs its own memory ----------------------------------
  //
  // `update-downloaded` IS NOT A ONE-SHOT EVENT. Once the update file sits in
  // the cache, electron-updater re-fires it on EVERY subsequent check without
  // re-downloading anything: AppUpdater's download path finds a valid cached
  // file and calls `done(false)`, which BaseUpdater turns straight into
  // `dispatchUpdateDownloaded`. With a check every 6h, an app left running for
  // a week produced ~24 stacked dialogs. On macOS they were sheets attached to
  // the parent window, so they queued invisibly rather than tiling — the same
  // bug, merely better hidden. It is not a platform quirk.
  //
  // The key is the VERSION, deliberately, and it is NOT persisted to disk:
  //   - version-keyed means "Later" needs no separate record. The user is not
  //     re-nagged for a version they already dismissed, and a genuinely NEW
  //     version still gets its one announcement.
  //   - in-memory means a restart re-announces once, which is correct. Making
  //     it durable would trade this bug for a worse one: press "Later" and the
  //     app never mentions the waiting update again.
  let promptedVersion: string | undefined;
  // Covers what the version key cannot: two `update-downloaded` events landing
  // before the first dialog has been answered.
  let promptOpen = false;

  function emit(next: Partial<UpdateStatus>): void {
    status = { ...status, ...next };
    for (const fn of listeners) {
      try {
        fn(status);
      } catch (err) {
        log(`[updater] listener threw: ${String(err)}`);
      }
    }
    // A check that reached a terminal state resolves any pending `checkNow`.
    if (settle && (status.state === 'idle' || status.state === 'ready' || status.state === 'unsupported')) {
      const done = settle;
      settle = undefined;
      done(status);
    }
  }

  function support(): Promise<SupportVerdict> {
    supportPromise ??= detectUpdateSupport({
      isPackaged: deps.probe?.isPackaged ?? app.isPackaged,
      platform: deps.probe?.platform ?? process.platform,
      ...(deps.probe?.verifySignature ? { verifySignature: deps.probe.verifySignature } : {}),
      ...(deps.probe?.appBundlePath ? { appBundlePath: deps.probe.appBundlePath } : {}),
    });
    return supportPromise;
  }

  // -- electron-updater is loaded LAZILY ------------------------------------
  //
  // Importing it at module scope would run its module initialisation (which
  // touches `app` and reads app-update.yml) in every process that imports this
  // file, including the spike entry that must never do either. Loading it at
  // the first check keeps the unsupported path completely inert.
  //
  // THE CACHE IS THE PROMISE, NOT THE RESOLVED VALUE. An `if (autoUpdater)
  // return` guard sitting in front of an `await import(...)` is not a guard at
  // all: two callers that arrive before the import settles both sail past it
  // and both register a full set of listeners on `ns.autoUpdater`, which is a
  // PROCESS SINGLETON. That is not hypothetical — the boot timer's first check
  // and a user clicking "Check for updates" overlap easily. Two listener sets
  // mean two `emit`s and two prompts per event. Caching the in-flight promise
  // makes concurrent callers share one load.
  let autoUpdater: import('electron-updater').AppUpdater | undefined;
  let autoUpdaterPromise: Promise<import('electron-updater').AppUpdater> | undefined;
  /** Detaches exactly the handlers we attached. See `dispose`. */
  let detachListeners: (() => void) | undefined;

  function loadAutoUpdater(): Promise<import('electron-updater').AppUpdater> {
    // A FAILED load must not poison the cache, or one transient import error
    // would disable updates for the rest of the process's life.
    autoUpdaterPromise ??= initAutoUpdater().catch((err: unknown) => {
      autoUpdaterPromise = undefined;
      throw err;
    });
    return autoUpdaterPromise;
  }

  async function initAutoUpdater(): Promise<import('electron-updater').AppUpdater> {
    const mod = await import('electron-updater');
    // electron-updater ships CJS; the default export is the namespace under
    // some bundler/interop combinations. Normalise rather than assume.
    const ns = ((mod as unknown as { default?: unknown }).default ?? mod) as typeof import('electron-updater');
    const updater = ns.autoUpdater;

    updater.autoDownload = true;
    // Applying on quit is the least intrusive install moment there is: the user
    // already decided to stop using the app. The explicit "restart now" prompt
    // below is the fast path, not the only path.
    updater.autoInstallOnAppQuit = true;
    updater.logger = {
      info: (m: unknown) => log(`[updater] ${String(m)}`),
      warn: (m: unknown) => log(`[updater] WARN ${String(m)}`),
      error: (m: unknown) => log(`[updater] ERROR ${String(m)}`),
      debug: () => {},
    };

    // Held in a table so `dispose` can take back exactly what it gave. Anonymous
    // inline handlers could only be removed with `removeAllListeners`, which on
    // a process singleton would also rip out electron-updater's own internals.
    const handlers: Record<string, (...args: never[]) => void> = {
      'checking-for-update': () => emit({ state: 'checking', error: undefined }),
      'update-available': (info: { version: string }) =>
        emit({ state: 'available', version: info.version }),
      'update-not-available': () => emit({ state: 'idle', version: undefined }),
      'download-progress': (p: { percent: number }) =>
        emit({ state: 'downloading', percent: Math.round(p.percent) }),
      // THE STATUS PUSH IS UNCONDITIONAL AND MUST STAY THAT WAY. The settings
      // panel's "ready to install" row is driven by it, and this event re-fires
      // on every check once the file is cached. Suppressing the repeat would
      // blank a correct panel. Only the DIALOG is rate-limited, one per version.
      'update-downloaded': (info: { version: string }) => {
        emit({ state: 'ready', version: info.version, percent: 100 });
        if (promptedVersion === info.version) return;
        void promptToRestart(info.version);
      },
      error: (err: Error) => {
        // An error must NOT leave the UI stuck on "checking" forever.
        log(`[updater] check failed: ${err.message}`);
        emit({ state: 'idle', error: err.message });
      },
    };

    for (const [event, handler] of Object.entries(handlers)) {
      updater.on(event as Parameters<typeof updater.on>[0], handler as () => void);
    }
    detachListeners = () => {
      for (const [event, handler] of Object.entries(handlers)) {
        updater.removeListener(event as Parameters<typeof updater.on>[0], handler as () => void);
      }
    };

    autoUpdater = updater;
    return updater;
  }

  /**
   * The one moment this feature interrupts the user.
   *
   * Wording is deliberate: it says what happened, what will happen, and that
   * doing nothing is safe. "Later" is not a deferral that nags — the update is
   * already on disk and `autoInstallOnAppQuit` applies it the next time the app
   * closes, so choosing "Later" genuinely costs the user nothing.
   */
  const showRestartPrompt = deps.showRestartPrompt ?? defaultRestartPrompt;

  async function promptToRestart(version: string): Promise<void> {
    // Two independent reasons to say nothing, both of which end with the user
    // NOT looking at a second copy of the same dialog.
    if (promptOpen || promptedVersion === version) return;
    promptOpen = true;
    // Marked as announced only once we have actually committed to showing it,
    // so a version dropped by the re-entrancy guard is still announced later.
    promptedVersion = version;
    try {
      const response = await showRestartPrompt(version);
      if (response === 0) installNow();
    } catch (err) {
      log(`[updater] restart prompt failed: ${String(err)}`);
    } finally {
      promptOpen = false;
    }
  }

  async function defaultRestartPrompt(version: string): Promise<number> {
    const win = BrowserWindow.getAllWindows()[0];
    const opts = {
      type: 'info' as const,
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Naby ${version} has been downloaded.`,
      detail:
        'The update is already on your computer. Restart to start using it, or choose Later — it will be applied automatically the next time you quit Naby.',
    };
    const { response } = win
      ? await dialog.showMessageBox(win, opts)
      : await dialog.showMessageBox(opts);
    return response;
  }

  async function runCheck(): Promise<void> {
    if (disposed) return;
    const verdict = await support();
    if (!verdict.supported) {
      emit({ state: 'unsupported', reason: verdict.reason });
      return;
    }
    try {
      const updater = await loadAutoUpdater();
      await updater.checkForUpdates();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[updater] check failed: ${message}`);
      emit({ state: 'idle', error: message });
    }
  }

  function installNow(): void {
    if (status.state !== 'ready' || !autoUpdater) return;
    // isSilent=false so Windows shows its installer UI; isForceRunAfter=true so
    // the user lands back in the app rather than at their desktop.
    autoUpdater.quitAndInstall(false, true);
  }

  return {
    status: () => status,

    start(): void {
      if (started || disposed) return;
      started = true;
      // The first check is DELAYED. At launch the app is already contending for
      // I/O with the Next server and the SQLite open; an update check is the
      // least urgent thing happening and should not be in that queue.
      const first = setTimeout(() => void runCheck(), initialDelayMs);
      first.unref?.();
      timer = setInterval(() => void runCheck(), intervalMs);
      timer.unref?.();
    },

    async checkNow(): Promise<UpdateStatus> {
      const verdict = await support();
      if (!verdict.supported) {
        emit({ state: 'unsupported', reason: verdict.reason });
        return status;
      }
      const settled = new Promise<UpdateStatus>((resolve) => {
        settle = resolve;
      });
      void runCheck();
      return settled;
    },

    installNow,

    async openReleasesPage(): Promise<void> {
      await shell.openExternal(RELEASES_URL);
    },

    onStatus(fn: (s: UpdateStatus) => void): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    dispose(): void {
      disposed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      listeners.clear();
      // `ns.autoUpdater` is a PROCESS SINGLETON that outlives this closure. A
      // disposed updater that leaves its handlers attached keeps emitting into
      // a dead `listeners` set and keeps its own prompt bookkeeping alive, so a
      // later instance sees phantom duplicates. Give back what we took.
      detachListeners?.();
      detachListeners = undefined;
      autoUpdaterPromise = undefined;
      autoUpdater = undefined;
    },
  };
}

/** `app.getVersion()` throws outside an Electron app context; the spikes care. */
function safeVersion(): string {
  try {
    return app.getVersion();
  } catch {
    return '0.0.0';
  }
}
