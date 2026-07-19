// electron/boot.ts
//
// THE COMPOSITION ROOT of the desktop app — shared by the production entry
// (`main.ts`) and the SPIKE-04 entry (`spike-entry.ts`).
//
// It exists as its own module for one reason: the spike must exercise the
// REAL boot path, not a re-implementation of it. If the spike had its own copy
// of "start the server, open a window", it would be proving that the copy works.
// Everything SPIKE-04 asserts against is therefore constructed here, and the two
// entries differ only in what they do afterwards.

import { app, BrowserWindow } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mintSessionToken, TOKEN_QUERY_PARAM } from './hardening.js';
import { startEmbeddedNextServer, type EmbeddedServer } from './next-server.js';
// TYPE-ONLY. The runtime bundle is loaded lazily through a computed URL (see
// `openStore`) so esbuild leaves it alone and the app loads the real
// `dist/naby-runtime.mjs` at run time instead of inlining ai@7 into the main
// process bundle a second time.
import type { SqliteStore as SqliteStoreType, Store } from '../dist/naby-runtime.mjs';

export type BootResult = {
  server: EmbeddedServer;
  /** Per-launch session token (design §5.4). Never persisted, never logged. */
  token: string;
  /** Absolute path to the app root — the asar root in a packaged build. */
  appRoot: string;
  userDataDir: string;
  /** The URL to hand `loadURL`, with the first-navigation token attached. */
  windowUrl(pathAndQuery?: string): string;
  /** Lazily opened, main-process-only SQLite store. */
  openStore(): Promise<Store>;
  /** Idempotent teardown: closes the store, then the server. */
  shutdown(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Where "here" is
// ---------------------------------------------------------------------------
//
// `app.getAppPath()` is the design's answer (§2.2) and is correct in a packaged
// build (it points at the asar root). The `import.meta.url` derivation is the
// fallback for `electron <path/to/main.mjs>` during development, where
// `getAppPath()` depends on where a package.json happens to be found. Both
// resolve to the repo root in dev and the asar root when packaged; we prefer
// the documented one and only fall back if it does not contain what we need.

function locateAppRoot(): string {
  // dist/electron/main.mjs → ../../ → repo root (dev) or asar root (packaged)
  const fromModule = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  try {
    const fromApp = app.getAppPath();
    // A packaged build's getAppPath() is authoritative; in dev it can point at
    // the electron package itself, which has no `shell/`.
    return fromApp && fromApp !== fromModule && hasShell(fromApp) ? fromApp : fromModule;
  } catch {
    return fromModule;
  }
}

/** The app root is the directory that actually contains the Next app dir. */
function hasShell(root: string): boolean {
  return existsSync(join(root, 'shell', 'package.json'));
}

export type BootOptions = {
  /** Force Next into dev mode. Off by default; the packaged app is never dev. */
  dev?: boolean;
  log?: (msg: string) => void;
};

export async function boot(opts: BootOptions = {}): Promise<BootResult> {
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const appRoot = locateAppRoot();
  const shellDir = join(appRoot, 'shell');
  const userDataDir = app.getPath('userData');
  mkdirSync(userDataDir, { recursive: true });

  // The runtime's SQLite file lives under userData (contract §6). Both the
  // shell-side store (opened inside the Next server graph by
  // `packages/feature/agent/src/server/engines/naby.ts`) and our main-process
  // store resolve to this one path, because the shell reads NABY_DB_PATH first.
  // Setting it here rather than compiling a path into the shell is what keeps
  // the submodule diff at zero.
  const dbPath = join(userDataDir, 'naby', 'app.db');
  mkdirSync(dirname(dbPath), { recursive: true });
  process.env.NABY_DB_PATH ??= dbPath;
  process.env.NABY_HOME ??= join(userDataDir, 'naby');

  const token = mintSessionToken();

  const server = await startEmbeddedNextServer({
    shellDir,
    token,
    userDataDir,
    dev: opts.dev ?? false,
    log,
  });

  // -- store ---------------------------------------------------------------
  //
  // KNOWN GAP, stated rather than hidden: this closes OUR handle. The shell's
  // `naby.ts` keeps its own module-level `sharedStore` and exposes no way to
  // close it, so that handle still leaks on quit. Fixing it properly means
  // exporting a disposer from the shell — a submodule diff — and is deferred to
  // F1-03, where that file is rewritten anyway. Two handles on one WAL database
  // in one process is safe; the leak costs a file descriptor until exit, and
  // WAL means an unclean close cannot corrupt the file.
  let store: Store | undefined;
  async function openStore(): Promise<Store> {
    if (store) return store;
    const runtimeUrl = pathToFileURL(join(appRoot, 'dist', 'naby-runtime.mjs')).href;
    const runtime = (await import(runtimeUrl)) as {
      SqliteStore: typeof SqliteStoreType;
    };
    store = new runtime.SqliteStore({ path: dbPath });
    log(`[store] opened ${dbPath}`);
    return store;
  }

  let shuttingDown: Promise<void> | undefined;
  function shutdown(): Promise<void> {
    shuttingDown ??= (async () => {
      try {
        store?.close();
        if (store) log('[store] closed');
      } catch (err) {
        log(`[store] close failed: ${String(err)}`);
      }
      store = undefined;
      await server.close();
      log('[server] closed');
    })();
    return shuttingDown;
  }

  return {
    server,
    token,
    appRoot,
    userDataDir,
    windowUrl(pathAndQuery = '/') {
      // The token rides the FIRST navigation only; the guard converts it to an
      // HttpOnly cookie on that request, so nothing after this carries it in a
      // URL (and it never reaches the address bar, history, or a referer).
      const sep = pathAndQuery.includes('?') ? '&' : '?';
      return `${server.origin}${pathAndQuery}${sep}${TOKEN_QUERY_PARAM}=${encodeURIComponent(token)}`;
    },
    openStore,
    shutdown,
  };
}

// ---------------------------------------------------------------------------
// Window construction
// ---------------------------------------------------------------------------
//
// Electron 43 DEFAULTS are the secure ones (design §1) — `contextIsolation:
// true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`. They
// are written out explicitly anyway: a default that silently flips in a future
// major is exactly the kind of regression nobody notices, and being explicit
// makes the security posture reviewable in one place.
//
// The token reaches the preload through `additionalArguments`, NOT through IPC.
// A sandboxed preload gets a trimmed `process` object that still carries
// `argv`, and this runs before any page script, so there is no window in which
// the renderer exists without its credential. Passing it over IPC would mean an
// async round trip the page could race.

export function createMainWindow(bootResult: BootResult, opts: { show?: boolean } = {}): BrowserWindow {
  const preloadPath = join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs');

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: opts.show ?? true,
    backgroundColor: '#111111',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      additionalArguments: [
        `--naby-session-token=${bootResult.token}`,
        `--naby-origin=${bootResult.server.origin}`,
      ],
    },
  });

  // Nothing in this app should ever open a second window or navigate off
  // loopback. Both are refused rather than merely unused: an injected script in
  // the renderer would otherwise have a working exfiltration channel.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(bootResult.server.origin)) event.preventDefault();
  });

  return win;
}
