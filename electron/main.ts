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
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot, createMainWindow, type BootResult } from './boot.js';
import { applyDevModeToEnv } from './devmode.js';

// ---------------------------------------------------------------------------
// Identity — must run before anything reads `userData`
// ---------------------------------------------------------------------------
//
// Unpackaged, Electron names the app "Electron", so `userData` resolved to
// Application Support/Electron in development and Application Support/Naby once
// packaged. Two different data directories meant a developer's projects,
// credentials and chat history simply were not the ones the shipped app would
// use — and the intended difference between dev and prod is which ENGINE
// answers, nothing else.
//
// `setName` must precede the first `app.getPath('userData')`; Electron caches
// the resolved path.
app.setName('Naby');

type SqliteHandle = {
  prepare(sql: string): { get(): unknown };
  close(): void;
};

/**
 * Does this database hold anything a user would miss?
 *
 * `undefined` means "could not tell" — locked, corrupt, or not a database at
 * all. Each caller resolves that ambiguity in the direction that keeps data:
 * never clobber a target we cannot read, never move a source we cannot read.
 *
 * FILE SIZE CANNOT ANSWER THIS, and assuming it could is what broke: an empty
 * database still carries its full schema and a seeded builtin agent, so a
 * pristine placeholder is thousands of bytes. Gating on `size > 0` read that
 * placeholder as live data and left every real session stranded in the old home.
 *
 * `node:sqlite` is loaded lazily, with the same targeted ExperimentalWarning
 * suppression sqlite-store.ts documents at length — a static import is hoisted
 * above any suppression, so the warning would escape before it could be muted.
 */
function holdsUserData(dbPath: string): boolean | undefined {
  if (!existsSync(dbPath) || statSync(dbPath).size === 0) return false;

  let db: SqliteHandle | undefined;
  const emitWarning = process.emitWarning;
  try {
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
      const message = typeof warning === 'string' ? warning : (warning?.message ?? '');
      const first = rest[0];
      const type =
        typeof first === 'string' ? first : ((first as { type?: string } | undefined)?.type ?? '');
      if (type === 'ExperimentalWarning' && /SQLite/i.test(message)) return;
      (emitWarning as (...a: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;

    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (path: string) => SqliteHandle;
    };
    db = new DatabaseSync(dbPath);

    // Opened read-write on purpose: a read-only open fails outright on a
    // database left with a hot -wal, which is exactly the state a crashed
    // session leaves behind — the one case where the data matters most.
    let counted = false;
    for (const table of ['sessions', 'messages', 'projects', 'memory_items']) {
      try {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as
          | { n: number }
          | undefined;
        counted = true;
        if (Number(row?.n ?? 0) > 0) return true;
      } catch {
        // Absent in an older schema. Not an answer either way — ask the next one.
      }
    }

    // Not one of the four tables exists. This opened, but it is not a Naby
    // database — a corrupt or foreign file, which is emphatically not the same
    // as an empty one and must not be treated as free space.
    return counted ? false : undefined;
  } catch {
    return undefined;
  } finally {
    process.emitWarning = emitWarning;
    try {
      db?.close();
    } catch {
      // Nothing left to do with a handle we are discarding anyway.
    }
  }
}

/**
 * Move a legacy database into the unified ~/.naby home (the launch-mode-
 * independent location boot() now points every store at).
 *
 * Runs once and only when the unified home has no real database yet, so it can
 * never overwrite live data, and a failure is logged rather than thrown — an
 * un-migratable old profile must not stop the app from starting. Without this,
 * unifying the path would silently orphan every session recorded before it.
 */
function migrateLegacyUserData(): void {
  const target = join(homedir(), '.naby');
  const targetDb = join(target, 'app.db');

  // If the unified home already holds real data, keep it — never clobber. An
  // unreadable target counts as occupied for the same reason: "I cannot tell"
  // is not permission to overwrite.
  if (holdsUserData(targetDb) !== false) return;

  // Legacy homes the DB may have lived in before it was unified, newest-intent
  // first: the packaged/dev userData dir ("<userData>/naby") and the pre-setName
  // development dir ("<Application Support>/Electron/naby").
  const candidates = [
    join(app.getPath('userData'), 'naby'),
    join(dirname(app.getPath('userData')), 'Electron', 'naby'),
  ];

  for (const src of candidates) {
    if (src === target) continue;

    // Two things this has to get right, both learned the hard way.
    //
    // Gate on the DATABASE, not on the directory: boot creates directories (for
    // credentials) before this runs, so a directory check is permanently true.
    // And gate on its CONTENTS, not its size: a candidate that only ever got as
    // far as a schema has nothing to give, and claiming it would stop the search
    // before the home that does hold the sessions is ever examined.
    const fromDb = join(src, 'app.db');
    if (holdsUserData(fromDb) !== true) continue;

    try {
      mkdirSync(target, { recursive: true });
      // Move the set ATOMICALLY. A -wal/-shm pair belongs to one specific
      // database file; migrating them independently can pair a WAL with a
      // different database, a corruption risk rather than an inconvenience. So
      // the sidecars move only alongside the db they belong to.
      for (const name of ['app.db', 'app.db-wal', 'app.db-shm']) {
        const from = join(src, name);
        if (!existsSync(from)) continue;
        rmSync(join(target, name), { force: true }); // clears any empty placeholder
        renameSync(from, join(target, name));
      }
      console.log(`[naby-home] migrated the database to the unified ~/.naby home from ${src}`);
    } catch (err) {
      // Never fatal: an un-migratable old profile must not stop the app.
      console.warn(`[naby-home] could not migrate the legacy database from ${src}: ${String(err)}`);
    }
    return; // first candidate with real data wins
  }
}

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

/**
 * Set the dock icon when running UNPACKAGED.
 *
 * In a packaged build electron-builder bakes `build/icon.png` into the bundle
 * (`Resources/icon.icns` + `CFBundleIconFile`) and the OS reads it from there —
 * nothing to do at runtime. Unpackaged, there is no bundle, so macOS shows
 * Electron's own atom icon and the app looks unbranded during development.
 *
 * Best-effort on purpose: a missing or unreadable icon must never stop the app
 * from launching. `app.dock` is macOS-only.
 */
function applyDevDockIcon(): void {
  if (process.platform !== 'darwin' || app.isPackaged || !app.dock) return;
  const iconPath = join(dirname(fileURLToPath(import.meta.url)), '../../build/icon.png');
  if (!existsSync(iconPath)) {
    console.warn(`[icon] dev dock icon not found at ${iconPath}`);
    return;
  }
  try {
    app.dock.setIcon(iconPath);
    // Logged so this is verifiable without screenshotting someone's desktop:
    // setIcon returns void and throws only on a hard failure, so the log is the
    // only evidence that the branded icon was actually applied in dev.
    console.log(`[icon] dev dock icon applied from ${iconPath}`);
  } catch (err) {
    // Cosmetic only — never fatal.
    console.warn(`[icon] dev dock icon failed: ${String(err)}`);
  }
}

/**
 * DEV-ONLY: open the ChatGPT subscription-OAuth seal automatically when running
 * UNPACKAGED, so a source checkout shows the ChatGPT sign-in without the
 * developer having to export `NABY_ENABLE_CHATGPT_OAUTH=1` by hand.
 *
 * WHY THIS IS SAFE FOR OFFICIAL BUILDS. `app.isPackaged` is true for every
 * shipped artifact, so this is a no-op there: the seal stays closed, exactly as
 * it is today. The DOUBLE SEAL is preserved too — electron-builder still
 * EXCLUDES `chatgpt-oauth.mjs` from the packaged app (electron-builder.yml), so
 * even if this flag somehow leaked on in a packaged build the OAuth module could
 * not be loaded. This only flips the RUNTIME flag, and only when unpackaged.
 *
 * An EXPLICIT value is always respected: if the developer already exported the
 * flag (either to force it on, or to `0`/empty to keep it off), we do not touch
 * it. We only fill in the default for the common "just ran the dev app" case.
 */
function autoOpenChatgptSealInDev(): void {
  if (app.isPackaged) return; // packaged official build stays sealed
  if ('NABY_ENABLE_CHATGPT_OAUTH' in process.env) return; // respect an explicit flag
  process.env.NABY_ENABLE_CHATGPT_OAUTH = '1';
  console.log('[chatgpt-oauth] DEV (unpackaged): seal auto-opened — NABY_ENABLE_CHATGPT_OAUTH=1');
}

async function start(): Promise<void> {
  await app.whenReady();

  migrateLegacyUserData();
  applyDevDockIcon();
  // Must run BEFORE boot(): boot reads `isChatgptOauthEnabled()` (which reads
  // this env var) to decide whether to install the vault-backed token source.
  autoOpenChatgptSealInDev();
  // A packaged build stays sealed above; this is the deliberate exception —
  // someone who typed the build's dev-mode key gets the dev providers in the
  // REAL artifact. Must be before boot(), which reads the seal exactly once.
  applyDevModeToEnv();

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

  // F1-09. Started HERE and nowhere else — `boot()` builds the updater but does
  // not run it, so the SPIKE-04 entry that shares this boot path performs no
  // network I/O. `start()` itself only arms timers; the first check is delayed
  // (see updater.ts) so it never competes with the window's first paint.
  bootResult.updater.start();

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

// The timeout is not belt-and-braces, it is the whole point. Deferring the quit
// means the app can only exit if `shutdown()` settles — and SPIKE-04 already
// caught it failing to, which is exactly how Cmd+Q became unable to quit the
// app. A clean release of the SQLite handle is worth waiting a moment for; it
// is not worth trapping the user in a process they cannot close. WAL makes an
// abrupt close survivable, so on timeout we log and quit anyway.
const TEARDOWN_TIMEOUT_MS = 5_000;

let teardownDone = false;
app.on('before-quit', (event) => {
  if (teardownDone || !bootResult) return;
  event.preventDefault();

  const finish = (): void => {
    if (teardownDone) return; // whichever of the two paths lands first wins
    teardownDone = true;
    app.quit();
  };

  const timer = setTimeout(() => {
    console.error(`[shutdown] timed out after ${TEARDOWN_TIMEOUT_MS}ms — quitting anyway`);
    finish();
  }, TEARDOWN_TIMEOUT_MS);

  void bootResult
    .shutdown()
    .catch((err: unknown) => console.error('[shutdown]', err))
    .finally(() => {
      clearTimeout(timer);
      finish();
    });
});
