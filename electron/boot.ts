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
import { CredentialVault, type SafeStorageLike } from './credentials.js';
import { mintSessionToken, TOKEN_QUERY_PARAM } from './hardening.js';
import { registerIpcHandlers } from './ipc.js';
import { startEmbeddedNextServer, type EmbeddedServer } from './next-server.js';
import { ProviderProfileStore } from './providers.js';
import { createUpdater, type Updater } from './updater.js';
// TYPE-ONLY. The runtime bundle is loaded lazily through a computed URL (see
// `openStore`) so esbuild leaves it alone and the app loads the real
// `dist/naby-runtime.mjs` at run time instead of inlining ai@7 into the main
// process bundle a second time.
import type {
  CredentialBridge,
  installCredentialBridge as InstallCredentialBridgeType,
  ProviderDescription,
  SqliteStore as SqliteStoreType,
  Store,
  defaultProfileFor as DefaultProfileForType,
} from '../dist/naby-runtime.mjs';

/** The subset of the runtime bundle the main process calls into. */
type NabyRuntime = {
  SqliteStore: typeof SqliteStoreType;
  describeProviders: () => ProviderDescription[];
  defaultProfileFor: typeof DefaultProfileForType;
  installCredentialBridge: typeof InstallCredentialBridgeType;
};

export type BootResult = {
  server: EmbeddedServer;
  /** Per-launch session token (design §5.4). Never persisted, never logged. */
  token: string;
  /** Absolute path to the app root — the asar root in a packaged build. */
  appRoot: string;
  userDataDir: string;
  /** F1-04. safeStorage-backed key store. Main process only. */
  vault: CredentialVault;
  /** F1-04. Provider profiles — no secrets (contract §4). */
  profiles: ProviderProfileStore;
  /**
   * F1-09. CONSTRUCTED HERE BUT NOT STARTED.
   *
   * That split is the point. Building it here means the `update:*` IPC channels
   * exist on every boot — including the spike's — so the renderer surface is the
   * same everywhere and contract §1.3 is satisfied unconditionally. Starting it
   * is `main.ts`'s job alone, because starting is what performs network I/O, and
   * SPIKE-04 boots this same path in CI where an update check would be both
   * pointless and a source of flake.
   */
  updater: Updater;
  /** The URL to hand `loadURL`, with the first-navigation token attached. */
  windowUrl(pathAndQuery?: string): string;
  /** Lazily opened, main-process-only SQLite store. */
  openStore(): Promise<Store>;
  /** The runtime bundle, loaded through a computed URL. Cached after the first. */
  loadRuntime(): Promise<NabyRuntime>;
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
  /**
   * F1-04 test seam. Replaces Electron's `safeStorage` in the vault, so
   * spike-f104 can assert the insecure-backend path (design §4.1's Linux
   * basic_text case) without requiring a Linux box with a broken keyring.
   * Production never sets it.
   */
  safeStorage?: SafeStorageLike;
  /** Test seam paired with the above — makes the vault believe it is on linux. */
  platform?: NodeJS.Platform;
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

  // -- runtime bundle ------------------------------------------------------
  //
  // ONE lazy loader for the whole main process. The computed URL is what keeps
  // esbuild from inlining ai@7 here a second time (see the type-only import
  // above); caching the module means the vault bridge, the IPC handlers and the
  // store all share one instance rather than three copies of a 5 MB bundle.
  let runtime: Promise<NabyRuntime> | undefined;
  function loadRuntime(): Promise<NabyRuntime> {
    runtime ??= import(pathToFileURL(join(appRoot, 'dist', 'naby-runtime.mjs')).href) as Promise<NabyRuntime>;
    return runtime;
  }

  // -- credentials (F1-04) -------------------------------------------------
  //
  // ORDER IS LOAD-BEARING (design §4.1). `boot()` is only ever called after
  // `app.whenReady()`, which is what makes `getSelectedStorageBackend()`
  // meaningful — before ready it returns 'unknown' and the basic_text check
  // would silently pass on a machine that deserves a warning.
  const vault = new CredentialVault({
    userDataDir,
    ...(opts.safeStorage ? { safeStorage: opts.safeStorage } : {}),
    ...(opts.platform ? { platform: opts.platform } : {}),
    log,
  });
  const security = await vault.init();
  if (!security.secure) {
    // Logged here so the condition is visible in a terminal run; the USER-facing
    // warning is the renderer's (settings + wizard both render it), because a
    // native dialog at startup would fire before there is any context for it.
    log(`[credentials] WARNING insecure backend "${security.backend}": ${security.warning ?? ''}`);
  }
  const profiles = new ProviderProfileStore({ userDataDir });

  // The engine reads keys through this bridge. It is an IN-PROCESS function
  // table, not IPC: the Next server (and therefore the shell's naby engine)
  // runs inside this very process, so the key never crosses a process boundary
  // and the shell never imports `electron`. Nothing here is reachable from the
  // renderer — contextBridge exposes none of it.
  const bridge: CredentialBridge = {
    listProfiles: () => profiles.list(),
    getKey: (providerId: string) => vault.get(providerId),
    security: () => vault.security(),
  };
  (await loadRuntime()).installCredentialBridge(bridge);

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
    const mod = await loadRuntime();
    store = new mod.SqliteStore({ path: dbPath });
    log(`[store] opened ${dbPath}`);
    return store;
  }

  // -- IPC (F1-04) ---------------------------------------------------------
  //
  // Registered only now, because `allowedOrigin` is the server's origin and the
  // server's port is not known until it is bound. A handler registered earlier
  // would have to compare against a placeholder, i.e. would be unguarded for
  // the window in which it existed.
  // F1-09. Inert until `updater.start()` — see the BootResult field comment.
  const updater = createUpdater({ log });

  const disposeIpc = registerIpcHandlers({
    vault,
    profiles,
    allowedOrigin: server.origin,
    loadRuntime,
    updater,
    log,
  });

  let shuttingDown: Promise<void> | undefined;
  function shutdown(): Promise<void> {
    shuttingDown ??= (async () => {
      // Before disposeIpc: the updater's status listener pushes through the IPC
      // layer, and an interval that fired mid-teardown would try to send on a
      // webContents that is already on its way out.
      updater.dispose();
      disposeIpc();
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
    vault,
    profiles,
    updater,
    loadRuntime,
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
