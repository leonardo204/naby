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

import { app, BrowserWindow, screen, shell } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import * as net from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CredentialVault, type SafeStorageLike } from './credentials.js';
import { mintSessionToken, TOKEN_QUERY_PARAM } from './hardening.js';
import { registerIpcHandlers } from './ipc.js';
import { startEmbeddedNextServer, type EmbeddedServer } from './next-server.js';
import { installReloadGuard } from './reload-guard.js';
import { ProviderProfileStore } from './providers.js';
import { createUpdater, type Updater } from './updater.js';
import {
  installWindowStatePersistence,
  MIN_WINDOW_SIZE,
  readWindowStateFile,
  resolveWindowStart,
  windowStateFilePath,
  type Bounds,
} from './windowState.js';
// TYPE-ONLY. The runtime bundle is loaded lazily through a computed URL (see
// `openStore`) so esbuild leaves it alone and the app loads the real
// `dist/naby-runtime.mjs` at run time instead of inlining ai@7 into the main
// process bundle a second time.
import type {
  ChatgptOauthBridge,
  ChatgptTokenSource,
  CredentialBridge,
  installCredentialBridge as InstallCredentialBridgeType,
  ProviderDescription,
  SqliteStore as SqliteStoreType,
  Store,
  defaultProfileFor as DefaultProfileForType,
} from '../dist/naby-runtime.mjs';
// TYPE-ONLY (erased at build). The DEV-ONLY ChatGPT-OAuth module is never
// statically imported — it is reached through a computed dynamic import below —
// so this type import adds nothing to `main.mjs`.
import type * as ChatgptOauthModule from './chatgpt-oauth.js';

// ---------------------------------------------------------------------------
// Outbound connect timeout — Happy Eyeballs (RFC 8305)
// ---------------------------------------------------------------------------
//
// THIS RUNS AT MODULE LOAD, WHICH IS THE POINT. `main.ts` imports this module,
// so ESM evaluates this block before a single line of `main.ts`'s own body —
// therefore before `app.whenReady()`, before the embedded Next server exists,
// and before anything in this process can issue a `fetch`. The setting is
// process-wide and read by `net.connect` at CALL time, so every later outbound
// connection (Telegram, the updater, skill hub, provider APIs) inherits it.
//
// WHAT IT FIXES. Node enables `autoSelectFamily` by default: it resolves both A
// and AAAA records and races the addresses, starting the next attempt when the
// current one has not connected within `autoSelectFamilyAttemptTimeout` —
// DEFAULT 250 ms. On a network where the IPv4 TCP handshake to a host straddles
// that boundary (api.telegram.org measured ~250-280 ms here) and IPv6 is
// EHOSTUNREACH, the race walks the whole address list and gives up while the
// v4 attempt it started is STILL PENDING and about to succeed. `fetch` then
// rejects with the famously uninformative `TypeError: fetch failed`, cause
// ETIMEDOUT — intermittently, because the RTT sits right on the threshold.
// `curl` on the same box succeeds, because it runs its own Happy Eyeballs with
// a 200 ms *head start* rather than a 250 ms *deadline*, and never abandons a
// live attempt.
//
// 5 s is chosen to be far above any plausible TCP handshake while staying far
// below a request timeout, so a genuinely dead address family still fails over
// quickly. This does NOT disable Happy Eyeballs — a truly unreachable family is
// still abandoned, just not one that is merely slow.
export const HAPPY_EYEBALLS_ATTEMPT_TIMEOUT_MS = 5_000;

// Guarded because the API is a relatively recent addition (Node >= 18.13/19.4).
// Electron 43 ships Node 22, so the guard is belt-and-braces rather than a real
// branch — but a main process that refuses to boot because a tuning knob moved
// would be a far worse bug than the one this fixes.
if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout === 'function') {
  net.setDefaultAutoSelectFamilyAttemptTimeout(HAPPY_EYEBALLS_ATTEMPT_TIMEOUT_MS);
}

/** The subset of the runtime bundle the main process calls into. */
type NabyRuntime = {
  SqliteStore: typeof SqliteStoreType;
  describeProviders: () => ProviderDescription[];
  defaultProfileFor: typeof DefaultProfileForType;
  installCredentialBridge: typeof InstallCredentialBridgeType;
  /** CO-05 dev seal + token-source seam (both dead unless the flag is set). */
  isChatgptOauthEnabled: (env?: NodeJS.ProcessEnv) => boolean;
  installChatgptTokenSource: (source: ChatgptTokenSource | undefined) => void;
  /** CO-06 — the account bridge the `/api/naby` server reads to show the chat
   *  bottom-bar ChatGPT chip and to run sign-in/out from inside the iframe. */
  installChatgptOauthBridge: (bridge: ChatgptOauthBridge | undefined) => void;
};

/** The flag-sealed Electron ChatGPT-OAuth module, as loaded at runtime. */
type ChatgptOauthMain = typeof ChatgptOauthModule;

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

  // The runtime's SQLite file lives at the LAUNCH-MODE-INDEPENDENT home
  // ~/.naby/app.db, so the SAME store is used whether this runs as the packaged
  // Electron build, `npm run electron:dev`, or the plain `cockpit` CLI — harness /
  // skills / commands / MCP configured in one are visible in all. (Credentials and
  // provider profiles stay under userData; only the shared DB is unified — it is
  // the piece that must not diverge across launch modes.) Both the shell-side
  // store (opened inside the Next server graph by
  // `packages/feature/agent/src/server/engines/naby.ts`) and our main-process
  // store resolve to this one path, because the shell reads NABY_DB_PATH first.
  // NABY_DB_PATH/NABY_HOME still win when already set, so tests can override.
  const nabyHome = join(homedir(), '.naby');
  const dbPath = join(nabyHome, 'app.db');
  mkdirSync(nabyHome, { recursive: true });
  process.env.NABY_DB_PATH ??= dbPath;
  process.env.NABY_HOME ??= nabyHome;

  // THE NABY HARNESS HOME (skill-hub-builtin §2.5). `~/.naby/{skills,commands,
  // agents}` is where an install driven by this product belongs — a file there is
  // loaded by no vendor SDK, so every engine receives it by the one path naby
  // owns (the store, after the import gate). The importer treats a missing
  // directory as empty, so this is not required for correctness; it exists so the
  // model and the user find a REAL directory when they go to install something,
  // instead of the vendor's `~/.claude` that already exists on their disk.
  // Best-effort: a home that cannot be written is a reason to skip the mkdir, not
  // to refuse to boot.
  for (const dir of ['skills', 'commands', 'agents']) {
    try {
      mkdirSync(join(nabyHome, dir), { recursive: true });
    } catch (e) {
      log(`[boot] could not create ~/.naby/${dir}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // WHERE THIS INSTALL LIVES, published for code that cannot work it out itself.
  //
  // `appRoot` is derived here from `app.getAppPath()` and this module's own
  // location, both of which are real at RUNTIME. Inside the embedded Next
  // server that is not available: webpack CONSTANT-FOLDS `import.meta.url` into
  // the build machine's absolute path, so a CI-built release carries
  // `file:///Users/runner/work/naby/naby/...` and any path derived from it
  // points at a directory that exists on no user's disk. That is exactly how the
  // Agent SDK went missing in v1.5.0/v1.5.1 — the package shipped, and the
  // resolver was anchored on a phantom.
  //
  // The Next server runs IN THIS PROCESS (see next-server.ts), so an env var set
  // before it starts is visible to it. `??=` so a test or a launcher can override.
  process.env.NABY_APP_ROOT ??= appRoot;

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

  // -- CO-05: the DEV-ONLY ChatGPT-OAuth module (flag-sealed) ---------------
  //
  // Reached ONLY through this computed dynamic import, so esbuild never inlines
  // the unofficial-backend flow into `main.mjs` (the same trick that keeps the
  // runtime bundle out of the main bundle). The compiled entry lives next to
  // `main.mjs` in `dist/electron/` and is EXCLUDED from the packaged artifact
  // (electron-builder.yml), so a shipped app cannot load it even if the flag
  // somehow leaked on. Callers gate on `isChatgptOauthEnabled()` first.
  let chatgptOauth: Promise<ChatgptOauthMain> | undefined;
  function loadChatgptOauth(): Promise<ChatgptOauthMain> {
    const url = pathToFileURL(
      join(dirname(fileURLToPath(import.meta.url)), 'chatgpt-oauth.mjs'),
    ).href;
    chatgptOauth ??= import(url) as Promise<ChatgptOauthMain>;
    return chatgptOauth;
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
  const runtimeMod = await loadRuntime();
  runtimeMod.installCredentialBridge(bridge);

  // -- CO-05: inject the vault-backed ChatGPT token SOURCE (dev seal only) --
  //
  // The subscription transport (registry.ts `createModel` for
  // `openai-chatgpt-oauth`) pulls a fresh access token from a `ChatgptTokenSource`
  // per request. That source is the safeStorage vault, which the runtime must
  // not import — so, exactly like the credential bridge, the main process
  // INSTALLS it here after boot. Gated on the runtime seal: with
  // `NABY_ENABLE_CHATGPT_OAUTH` unset (the default, every official build), the
  // OAuth module is never even loaded and no source is installed, so the
  // provider has nothing to construct a turn from. (The live query still needs
  // the owner's ChatGPT sign-in — CO-06 — which this only makes reachable.)
  if (runtimeMod.isChatgptOauthEnabled()) {
    try {
      const chatgpt = await loadChatgptOauth();
      runtimeMod.installChatgptTokenSource(chatgpt.makeVaultTokenSource(vault));
      // CO-06 — the ACCOUNT bridge the `/api/naby` server reads. It is the exact
      // sibling of the credential bridge above: the vault lives in this process,
      // the Next server runs in this process, so the shell's ChatGPT chip reaches
      // sign-in status + sign-in/out over HTTP (working inside the project iframe,
      // where the preload `window.naby` bridge does not exist) instead of IPC.
      // Labels only ever cross — the tokens stay in the vault.
      runtimeMod.installChatgptOauthBridge({
        status: () => chatgpt.readSignInStatus(vault),
        signIn: async () => {
          // Runs the browser PKCE flow + loopback callback + token exchange and
          // stores the token set in the vault; resolves with labels only.
          await chatgpt.startChatgptLogin(vault);
          return chatgpt.readSignInStatus(vault);
        },
        signOut: async () => {
          chatgpt.clearTokens(vault);
        },
      });
      log('[chatgpt-oauth] DEV seal open — vault-backed token source + account bridge installed');
    } catch (err) {
      // Never fatal: a broken dev-only path must not stop the app booting.
      log(`[chatgpt-oauth] token source not installed: ${String(err)}`);
    }
  }

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
    // CO-05, DEV-ONLY. The IPC channels gate on `isChatgptOauthEnabled()` before
    // ever calling this, so passing it unconditionally is safe — with the seal
    // closed the loader is never invoked.
    loadChatgptOauth,
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

export function createMainWindow(
  bootResult: BootResult,
  opts: { show?: boolean; packaged?: boolean; persistWindowState?: boolean } = {},
): BrowserWindow {
  const preloadPath = join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs');

  // OPT-IN, AND DEFAULTING TO OFF ON PURPOSE. Three spike entries share this
  // function (spike-entry, spike-f104-entry, spike-f110-entry) and two of them
  // run against the developer's REAL naby home, so a window state that saved
  // itself by default would let `npm run spike:f110` overwrite the geometry of
  // the app the developer actually uses — with a headless, never-shown window at
  // that. Only `main.ts` asks for persistence; a future entry that forgets gets
  // the harmless behaviour rather than the destructive one. (The file also lives
  // under `nabyHomeDir()`, so a spike that sets NABY_HOME — spike-04 does — is
  // isolated a second time.)
  const persist = opts.persistWindowState ?? false;

  // The saved rectangle is validated against the displays connected RIGHT NOW;
  // see resolveWindowStart. Primary first, which is the order it expects.
  const workAreas: Bounds[] = persist
    ? (() => {
        const primary = screen.getPrimaryDisplay();
        return [
          primary.workArea,
          ...screen.getAllDisplays().filter((d) => d.id !== primary.id).map((d) => d.workArea),
        ];
      })()
    : [];
  const start = resolveWindowStart(
    persist ? readWindowStateFile(windowStateFilePath()) : undefined,
    workAreas,
  );

  const win = new BrowserWindow({
    width: start.size.width,
    height: start.size.height,
    // Omitted entirely when there is no display information, which is the one
    // case where Electron's own centring beats anything we could compute.
    ...(start.position ?? {}),
    // A FLOOR, not a preference — the full reasoning, and the reason the numbers
    // live in one place, is on MIN_WINDOW_SIZE in windowState.ts. The restore
    // clamp reads the same constant.
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    // Full screen is applied at construction so the window never flashes at its
    // normal size first. The bounds above stay the window's NORMAL bounds, so
    // leaving full screen lands back on the size the user actually chose.
    fullscreen: start.fullScreen,
    show: opts.show ?? true,
    backgroundColor: '#111111',
    // WINDOWS/LINUX ONLY, and deliberately NOT `Menu.setApplicationMenu(null)`.
    // The menu (now built in menu.ts — the default roles minus the Cmd/Ctrl+W
    // close binding) is a File/Edit/View/Window bar the product never asked to
    // SEE, sitting above a UI that already owns its own chrome. Hiding the BAR
    // while keeping the MENU alive is the difference that matters: the menu is
    // also where the accelerators live (Ctrl+Shift+I devtools, Ctrl+0/+/- zoom
    // — and Ctrl+R reload in a DEV build only, see menu-template.ts), and
    // dropping the application menu entirely would take those with it.
    // `autoHideMenuBar` keeps them bound, and Alt still reveals the bar for
    // anyone who wants it.
    //
    // macOS has no in-window menu bar to hide — its menu belongs to the system
    // strip — so the flag is left off there rather than asking Electron to
    // no-op on a platform contract we do not want to touch.
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      // Load the preload in the /project SUBFRAME too, so the chat UI (which
      // renders inside that same-origin iframe) can reach `window.naby`. The only
      // capability this actually unlocks there is `getPathForFile` — resolving an
      // OS-dropped file to its absolute path (Feature: Finder drag-drop). Node stays
      // OFF (nodeIntegration:false) and contextIsolation/sandbox remain ON, so the
      // subframe gets the same guarded bridge the main frame has, nothing more, and
      // only our own loopback UI is ever loaded in it (will-navigate + webSecurity).
      nodeIntegrationInSubFrames: true,
      webSecurity: true,
      additionalArguments: [
        `--naby-session-token=${bootResult.token}`,
        `--naby-origin=${bootResult.server.origin}`,
      ],
    },
  });

  // MAXIMIZED IS RESTORED BY MAXIMIZING, never by opening at screen-sized
  // bounds: the window keeps the normal bounds it was constructed with, so
  // "restore down" has somewhere to go.
  if (start.maximized) win.maximize();

  if (persist) {
    installWindowStatePersistence(win);
    console.log(
      `[window] ${start.source === 'saved' ? 'restored' : 'default'} geometry ` +
        `${start.size.width}x${start.size.height}` +
        `${start.position ? `+${start.position.x}+${start.position.y}` : ''}` +
        `${start.maximized ? ' maximized' : ''}${start.fullScreen ? ' fullscreen' : ''} — ${start.reason}`,
    );
  }

  // `autoHideMenuBar` alone still paints the bar until the first Alt toggle on
  // some Windows builds; this starts it hidden. Guarded to non-darwin so the
  // macOS system menu is never touched.
  if (process.platform !== 'darwin') win.setMenuBarVisibility(false);

  // THE BROWSER REFRESH KEYS, in a window that is not a browser. Cmd/Ctrl+R and
  // F5 would throw away the running turn's stream and the whole renderer state
  // to re-fetch a page this very process serves. menu-template.ts already keeps
  // Reload off a packaged build's View menu, which kills the accelerators; this
  // catches the keystroke itself, which is what covers F5 (no menu item ever
  // bound it) and anything the renderer might bind. Packaged builds only — see
  // reload-guard.ts. `app.isPackaged` is false for both spike entries that
  // share this function, so their windows are untouched.
  installReloadGuard(win.webContents, { packaged: opts.packaged ?? app.isPackaged });

  // Nothing in this app should ever open a second WINDOW or navigate this
  // window off loopback. Both stay refused — an injected script in the renderer
  // would otherwise have a working exfiltration channel. But refusal alone made
  // every link in a chat reply dead: rendered markdown anchors carry
  // target="_blank", which lands in setWindowOpenHandler, and a bare deny
  // swallows the click. The link's DESTINATION is not the threat — the second
  // window is — so web links are handed to the OS browser and the window
  // request is still denied.
  const openExternally = (url: string): void => {
    // http(s) only, and never our own loopback UI (that is in-app navigation,
    // not a link out). Anything else — file:, custom schemes — stays refused:
    // shell.openExternal on those is an execution channel, not a link.
    if (!/^https?:\/\//.test(url)) return;
    if (url.startsWith(bootResult.server.origin)) return;
    void shell.openExternal(url);
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(bootResult.server.origin)) {
      event.preventDefault();
      // A plain anchor without target=_blank tries to NAVIGATE instead of
      // opening a window; same intent, same answer — the OS browser.
      openExternally(url);
    }
  });

  return win;
}
