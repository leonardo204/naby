// electron/main.ts
//
// F1-02 — the production Electron entry point.
//
// Sequence, and why it is this order:
//   1. single-instance lock  — two copies would race on one SQLite file
//   2. app.whenReady()       — `app.getPath('userData')` is only meaningful after
//   3. boot()                — bind 127.0.0.1:0, read the port back, prepare Next
//   4. createMainWindow()    — only now; there is nothing to load before step 3
//
// The window is created AFTER the server is ready rather than in parallel with a
// retry loop, because Next has no production port-collision fallback (design
// §2.2) — there is no "try again in 200ms" that could rescue a failed bind, so a
// retry loop would only paper over the real error. `did-fail-load` is kept as a
// backoff net, not as the readiness signal.

import { app, BrowserWindow, dialog } from 'electron';
import { boot, createMainWindow, type BootResult } from './boot.js';

let bootResult: BootResult | undefined;
let mainWindow: BrowserWindow | undefined;

// One instance per user. The second copy would open a second server AND a second
// writer on the same SQLite file under userData; the lock is cheaper than
// reconciling that.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  void start();
}

async function start(): Promise<void> {
  await app.whenReady();

  try {
    bootResult = await boot();
  } catch (err) {
    // A failed boot is terminal — there is no UI to show the error in, because
    // the UI is served by the thing that failed. A native dialog is the only
    // channel left.
    const message = err instanceof Error ? err.message : String(err);
    dialog.showErrorBox('Naby could not start', message);
    app.exit(1);
    return;
  }

  openWindow();

  // macOS convention: clicking the dock icon with no windows open reopens one.
  // The server is still running at that point, so this is just a window.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) openWindow();
  });
}

function openWindow(): void {
  if (!bootResult) return;
  const win = createMainWindow(bootResult);
  mainWindow = win;

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
    // Guarded on isMainFrame: subresource failures are noise, and treating them
    // as a boot failure would make the app unlaunchable over one missing icon.
    if (!isMainFrame) return;
    console.error(`[window] main frame failed to load: ${errorCode} ${errorDescription}`);
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = undefined;
  });

  void win.loadURL(bootResult.windowUrl('/'));
}

// Platform convention: on macOS the app stays resident with no windows; on
// Windows and Linux, closing the last window quits.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------
//
// `before-quit` is where the store handle and the HTTP listener are released.
// It is made async the only way Electron allows — preventDefault, finish the
// work, then quit again — with a re-entry guard so the second `app.quit()` does
// not loop. Without this, quit races teardown and the SQLite handle is closed by
// process exit rather than by us. (WAL means that is survivable, not that it is
// acceptable.)

let teardownDone = false;
app.on('before-quit', (event) => {
  if (teardownDone || !bootResult) return;
  event.preventDefault();
  void bootResult
    .shutdown()
    .catch((err: unknown) => console.error('[shutdown]', err))
    .finally(() => {
      teardownDone = true;
      app.quit();
    });
});
