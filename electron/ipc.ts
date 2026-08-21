// electron/ipc.ts
//
// F1-04 — the IPC handlers behind contract §1.3's credential and provider
// channels, and the first `ipcMain.handle` code in the app.
//
// THREE RULES, ALL FROM CONTRACT §1.1/§1.2, AND ALL ENFORCED IN ONE PLACE
//
// 1. EVERY HANDLER VALIDATES `event.senderFrame`, with a real URL parser.
//    Not a `startsWith` — `http://127.0.0.1:5173.evil.com` starts with our
//    origin and is a different site. `new URL().origin` is the comparison that
//    cannot be tricked by a prefix. A frame that fails is refused, not
//    tolerated. This matters more here than anywhere else in the app: these are
//    the channels that touch keys.
//
// 2. NOTHING THROWS ACROSS IPC. Every channel returns `Result<T>`. A thrown
//    error would arrive at the renderer as a bare `.message` with no code
//    (structured clone drops the prototype), so the renderer could not branch
//    on CREDENTIAL_INSECURE vs CREDENTIAL_UNAVAILABLE — which is the one
//    decision the settings UI actually has to make. Errors are therefore data.
//
// 3. NO KEY MATERIAL TRAVELS TOWARD THE RENDERER. `credential:status` answers
//    `{stored, backend, secure}`; there is no `credential:get` channel at all,
//    and adding one would be the bug. The key leaves the vault only through the
//    in-process credential bridge, on its way to the engine.
//
// The handlers are registered ONCE per boot and removed on shutdown, so a
// second boot in the same process (the spike does this) does not hit
// "Attempted to register a second handler".

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  webContents,
  type IpcMainInvokeEvent,
  type OpenDialogOptions,
} from 'electron';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import type { CredentialVault } from './credentials.js';
import { CredentialError } from './credentials.js';
import type { ProviderProfileStore } from './providers.js';
import type { Updater, UpdateStatus } from './updater.js';
import type { WhatsNewStore } from './whats-new.js';
import { isDevModeAvailable, isDevModeUnlocked, lockDevMode, unlockDevMode } from './devmode.js';
import {
  asNotifyLocale,
  isNotifyKind,
  sanitizeLabel,
  showNotification,
} from './notifications.js';
import type { ProviderDescription, ProviderProfile } from '../dist/naby-runtime.mjs';
import { isChatgptOauthEnabled } from '../src/providers/chatgpt-oauth.js';

/**
 * The DEV-ONLY Electron ChatGPT-OAuth module (electron/chatgpt-oauth.ts),
 * loaded lazily through a computed dynamic import so esbuild never inlines the
 * unofficial-backend flow into `main.mjs`. Only the seam the IPC layer uses.
 */
export type ChatgptOauthMain = {
  startChatgptLogin: (
    vault: CredentialVault,
    opts?: Record<string, unknown>,
  ) => Promise<{ access_token: string; account_id: string }>;
  clearTokens: (vault: CredentialVault) => void;
  readSignInStatus: (
    vault: CredentialVault,
  ) => Promise<{ signedIn: boolean; email: string | null; accountId: string | null }>;
};

/** What `chatgpt-oauth:status`/`signin`/`signout` answer. Labels only — never a
 *  token. `available` is the dev seal; `signedIn` is whether a token set is
 *  stored; `email`/`accountId` label the account when signed in. */
export type ChatgptOauthStatus = {
  available: boolean;
  signedIn: boolean;
  email: string | null;
  accountId: string | null;
};

// ---------------------------------------------------------------------------
// Result envelope (contract §1.2)
// ---------------------------------------------------------------------------

export type ErrorCode =
  | 'CREDENTIAL_UNAVAILABLE'
  | 'CREDENTIAL_INSECURE'
  | 'PROVIDER_UNREACHABLE'
  | 'PROVIDER_AUTH_FAILED'
  | 'SESSION_NOT_FOUND'
  | 'GATE_UNSOUND'
  | 'INTERNAL';

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: ErrorCode; message: string; detail?: string } };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (code: ErrorCode, message: string, detail?: string): Result<never> => ({
  ok: false,
  error: detail === undefined ? { code, message } : { code, message, detail },
});

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export const CHANNELS = [
  'credential:status',
  'credential:set',
  'credential:clear',
  'provider:list',
  'provider:describe',
  'provider:upsert',
  'provider:select',
  'onboarding:state',
  'onboarding:complete',
  // -- F1-09 auto-update ---------------------------------------------------
  //
  // Contract §1.3 defines `update:status` as M→R only, which is the PUSH of a
  // status change. These three are the request side that a "check for updates"
  // button and a "restart now" button need, and they are named here as an
  // explicit, minimal extension of the contract rather than smuggled in through
  // a generic invoke:
  //
  //   update:get      — the current status, for a renderer that just mounted
  //                     and missed the pushes that came before it
  //   update:check    — user-initiated check, resolves when the check settles
  //   update:install  — apply a DOWNLOADED update now (no-op unless `ready`)
  //   update:open-releases — the `unsupported` escape hatch: open the public
  //                     releases page in the real browser
  //
  // None of them can start a download of an arbitrary URL or influence WHERE an
  // update comes from; the feed is compiled into app-update.yml at build time.
  'update:get',
  'update:check',
  'update:install',
  'update:open-releases',
  // -- "what changed" popup ------------------------------------------------
  //
  // The first-launch-after-an-update notes. TWO channels and no more, because
  // the CONTENT is not here: the changelog is compiled into the renderer bundle
  // (shell .../releaseNotes.ts), so this pair carries only the two facts the
  // renderer cannot know on its own.
  //
  //   whats-new:get  — {currentVersion, lastSeenVersion}. `currentVersion` is
  //                    `app.getVersion()`, which is the NABY version; the
  //                    shell's own /api/version answers the cockpit package's
  //                    version and is a different number entirely.
  //                    `lastSeenVersion` is null on a fresh install.
  //   whats-new:seen — record a version as announced. Idempotent, last write
  //                    wins.
  //
  // WHY THE WATERMARK IS NOT IN THE RENDERER: the embedded server binds
  // `listen(0)`, so the renderer origin changes every launch and localStorage
  // is empty on every restart. See electron/whats-new.ts.
  'whats-new:get',
  'whats-new:seen',
  // -- CO-05 ChatGPT subscription-OAuth (DEV-ONLY, flag-sealed) -------------
  //
  // The renderer face of the dev sign-in. All three are INERT unless the dev
  // seal is open (`isChatgptOauthEnabled()`): with the flag off, `status`
  // answers `{available:false}`, and `signin`/`signout` refuse — so a shipped
  // build (flag off, and the electron OAuth module excluded from the artifact)
  // exposes the channels but they can never sign in or reach the backend.
  //
  //   chatgpt-oauth:status   — {available, signedIn, email?, accountId?}. Labels
  //                            only; NEVER token material (rule 3).
  //   chatgpt-oauth:signin   — run the browser PKCE flow, store the token set in
  //                            the same safeStorage vault as the API keys.
  //   chatgpt-oauth:signout  — clear the stored token set. Idempotent.
  'chatgpt-oauth:status',
  'chatgpt-oauth:signin',
  'chatgpt-oauth:signout',

  // FORCED DEV MODE (electron/devmode.ts) — the key-gated door that lets a
  // SHIPPED build run the dev-only providers, so a release can be tested as the
  // artifact users actually get. `status` reports whether this build has a door
  // and whether it is open; it never exposes the key or its baked hash.
  //
  //   devmode:status  — {available, unlocked, activeNow}
  //   devmode:unlock  — compare a typed key against the baked hash; outcome out
  //   devmode:lock    — close it again
  'devmode:status',
  'devmode:unlock',
  'devmode:lock',

  // FILE-BROWSER OS OPERATIONS — the file operations that only the main process
  // can perform, for the chat file browser's rows and right-click menu. All
  // three take `{cwd, rel}`, never an absolute path from the renderer: the join
  // and the containment check happen HERE, in the trusted process, so a
  // renderer that is compromised (or simply buggy) cannot name a target outside
  // the project the user opened. This mirrors the `withinCwd` guard the shell's
  // /api/fs-op applies on the server side.
  //
  //   fs:reveal — `shell.showItemInFolder`. Opens Finder/Explorer at the item.
  //   fs:open   — `shell.openPath`. Hands the file to the OS default app for its
  //               extension, which is what a double-click on a file row means.
  //               Deliberately NOT an in-app viewer: the app has no business
  //               deciding it renders PSDs better than the user's own tools.
  //   fs:trash  — `shell.trashItem`. The RECOVERABLE delete, and the reason the
  //               renderer prefers this channel over /api/fs-op's `delete`
  //               (which is a permanent `fs.rm` and exists only for the
  //               plain-browser shell where this bridge is absent).
  //
  // None of them can read a file, list a directory, or reach anything the file
  // browser could not already display. `fs:open` hands a path to the OS, which
  // then applies its own handler rules — the containment check is what keeps
  // that path inside the project.
  'fs:reveal',
  'fs:open',
  'fs:trash',
  // fs:pickFolder — the OS folder chooser behind "add/open a project".
  //
  // The odd one out of this group: it takes no `{cwd, rel}`, because there is
  // no project yet — choosing one is the point. It cannot read, list or return
  // anything the user did not select in person, so there is nothing to contain.
  //
  // It exists because the web shell's fallback (/api/pick-folder) shells out to
  // `osascript`/`powershell`/`zenity`, and a panel owned by a MENULESS helper
  // process has no Edit menu — so on macOS cmd+C and cmd+V do nothing in the
  // panel's "New Folder" name field. `dialog.showOpenDialog(win, …)` runs the
  // same native panel owned by THIS app, attached to the window, which is what
  // gives it our menu bar and therefore working clipboard shortcuts.
  'fs:pickFolder',

  // OS NOTIFICATIONS — the only channel that reaches a user looking at another
  // window. It exists because naby can now finish work AFTER the turn that
  // started it (background jobs), and an unread badge in a window nobody is
  // looking at is the same silence in a new shape.
  //
  // IT CANNOT BE MADE TO SAY ANYTHING. The payload is `{kind, locale, label}`:
  // `kind` selects from a fixed catalogue in electron/notifications.ts, `locale`
  // picks en or ko, and `label` is the ONE variable field — a session title,
  // sanitized and truncated on the main side. There is no title/body channel,
  // for the same reason there is no `invoke(channel, payload)`: a renderer that
  // can compose an OS-drawn, app-branded banner is a phishing primitive.
  //
  // WHETHER to fire is decided in the renderer, which is the only place that
  // knows whether the user is already looking at the session in question.
  'notify:show',
] as const;

export type Channel = (typeof CHANNELS)[number];

/** The M→R push channel of contract §1.3. Not an `ipcMain.handle` channel. */
export const UPDATE_STATUS_EVENT = 'update:status';

export type IpcDeps = {
  vault: CredentialVault;
  profiles: ProviderProfileStore;
  /** `http://127.0.0.1:<port>` — the ONLY origin allowed to call these. */
  allowedOrigin: string;
  /**
   * Loads the runtime bundle — the source of `describeProviders()` (contract
   * §4's single provider list) and of the default profile shape. It is a
   * function, not a value, because the bundle is imported through a computed
   * URL so esbuild leaves it out of the main-process bundle (see boot.ts).
   */
  loadRuntime: () => Promise<{
    describeProviders: () => ProviderDescription[];
    defaultProfileFor: (kind: ProviderProfile['kind']) => ProviderProfile;
  }>;
  /**
   * F1-09. Optional so the spike harness can register IPC without an updater;
   * when absent the update channels answer a well-formed `unsupported` rather
   * than failing, which is the same shape the renderer already has to handle.
   */
  updater?: Updater;
  /**
   * The "what changed" watermark. Optional for the same reason `updater` is —
   * a harness may register IPC without one — and the absent case is inert
   * rather than an error: `lastSeenVersion` answers null, which the renderer
   * reads as a fresh install and therefore shows nothing.
   */
  whatsNew?: WhatsNewStore;
  /**
   * CO-05, DEV-ONLY. Loads the flag-sealed Electron ChatGPT-OAuth module through
   * a computed dynamic import (electron/boot.ts). Optional so the spike harness
   * registers IPC without it — the channels then answer `{available:false}` /
   * refuse, exactly as when the dev seal is closed.
   */
  loadChatgptOauth?: () => Promise<ChatgptOauthMain>;
  log?: (msg: string) => void;
};

/** Registers every channel. Returns a disposer that removes them all. */
export function registerIpcHandlers(deps: IpcDeps): () => void {
  const log = deps.log ?? ((msg: string) => console.log(msg));

  /**
   * Rule 1 + rule 2 in one wrapper, so a new channel cannot forget either.
   * A handler added below is guarded by construction; there is no path that
   * registers a raw `ipcMain.handle` for these channels.
   */
  function handle<T>(
    channel: Channel,
    fn: (payload: unknown, event: IpcMainInvokeEvent) => Promise<Result<T>> | Result<T>,
  ): void {
    ipcMain.handle(channel, async (event, payload: unknown): Promise<Result<T>> => {
      if (!isAllowedFrame(event, deps.allowedOrigin)) {
        log(`[ipc] REFUSED ${channel} from a frame outside ${deps.allowedOrigin}`);
        return fail('INTERNAL', 'refused: this frame is not allowed to call naby IPC');
      }
      try {
        return await fn(payload, event);
      } catch (err) {
        // The last line of defence for rule 2. A CredentialError carries its own
        // contract code; anything else is INTERNAL, and its message is the
        // error's message only — never the request payload, which would put a
        // key into a log line on the one path where a key is present.
        if (err instanceof CredentialError) {
          return fail(err.code as ErrorCode, err.message);
        }
        const message = err instanceof Error ? err.message : String(err);
        log(`[ipc] ${channel} failed: ${message}`);
        return fail('INTERNAL', message);
      }
    });
  }

  // -- credentials ---------------------------------------------------------

  handle('credential:status', (payload) => {
    const { providerId } = asObject(payload);
    if (typeof providerId !== 'string' || !providerId) {
      return fail('INTERNAL', 'providerId is required');
    }
    // Rule 3: this is the whole response shape. There is no branch that can
    // add key material to it.
    return ok(deps.vault.status(providerId));
  });

  handle('credential:set', async (payload) => {
    const { providerId, key, acknowledgeInsecure } = asObject(payload);
    if (typeof providerId !== 'string' || !providerId) {
      return fail('INTERNAL', 'providerId is required');
    }
    if (typeof key !== 'string' || !key.trim()) {
      return fail('INTERNAL', 'key is required');
    }
    const result = await deps.vault.set(providerId, key, {
      acknowledgeInsecure: acknowledgeInsecure === true,
    });
    // A key with no profile would be unreachable — the resolver walks profiles.
    // Materializing a default here is what makes the wizard "paste key → done"
    // instead of "paste key, then also configure a model".
    if (!deps.profiles.get(providerId)) {
      const runtime = await deps.loadRuntime();
      // Only for a providerId that IS one of the five kinds. A key stored under
      // some other id belongs to a profile the user upserted explicitly, and
      // inventing a default for it would guess at a config we do not have.
      const known = runtime.describeProviders().find((d) => d.kind === providerId);
      if (known) deps.profiles.upsert(runtime.defaultProfileFor(known.kind));
    }
    return ok(result);
  });

  handle('credential:clear', (payload) => {
    const { providerId } = asObject(payload);
    if (typeof providerId !== 'string' || !providerId) {
      return fail('INTERNAL', 'providerId is required');
    }
    deps.vault.clear(providerId);
    return ok(undefined as void);
  });

  // -- providers -----------------------------------------------------------

  handle('provider:list', async () => {
    // Profiles carry no secret (contract §4), so they cross whole. The stored
    // flag is joined in from the vault so the UI needs one round trip, not
    // one per provider.
    const stored = new Set(deps.vault.listStored());
    const profiles = deps.profiles.list().map((p) => ({ ...p, stored: stored.has(p.id) }));
    return ok(profiles);
  });

  /**
   * The five kinds and what each one needs — read from `describeProviders()`
   * in the runtime, which contract §4 makes the single list. The settings UI
   * and the wizard both render off THIS, so adding a sixth provider is a
   * registry change and nothing else.
   */
  handle('provider:describe', async () => {
    const runtime = await deps.loadRuntime();
    const stored = new Set(deps.vault.listStored());
    const profiles = deps.profiles.list();
    return ok({
      providers: runtime.describeProviders().map((d) => {
        const profile = profiles.find((p) => p.id === d.kind);
        return {
          ...d,
          // Everything the UI needs to render one row, already joined.
          stored: stored.has(d.kind),
          model: profile?.model ?? d.defaultModel,
          config: (profile?.config ?? { kind: d.kind }) as Record<string, unknown>,
        };
      }),
      security: deps.vault.security(),
    });
  });

  handle('provider:upsert', (payload) => {
    const profile = payload as ProviderProfile;
    if (!profile || typeof profile !== 'object') return fail('INTERNAL', 'profile is required');
    if (typeof profile.id !== 'string' || !profile.id) return fail('INTERNAL', 'profile.id is required');
    if (profile.config?.kind !== profile.kind) {
      // Contract §4: enforced in main, never assumed from the renderer.
      return fail('INTERNAL', `config.kind "${String(profile.config?.kind)}" != kind "${profile.kind}"`);
    }
    deps.profiles.upsert(profile);
    return ok(undefined as void);
  });

  handle('provider:select', (payload) => {
    const { sessionId, providerId } = asObject(payload);
    if (typeof sessionId !== 'string' || typeof providerId !== 'string') {
      return fail('INTERNAL', 'sessionId and providerId are required');
    }
    deps.profiles.select(sessionId, providerId);
    return ok(undefined as void);
  });

  // -- onboarding (F1-06) --------------------------------------------------

  handle('onboarding:state', () =>
    ok({
      ...deps.profiles.onboardingState(deps.vault.listStored()),
      security: deps.vault.security(),
    }),
  );

  handle('onboarding:complete', () => {
    deps.profiles.markOnboarded();
    return ok(undefined as void);
  });

  // -- CO-05 ChatGPT subscription-OAuth (DEV-ONLY, flag-sealed) -------------
  //
  // THE SEAL IS CHECKED ON EVERY CALL, not once at registration: the channels
  // always exist (so the renderer surface is uniform), but they do NOTHING
  // unless `isChatgptOauthEnabled()` AND the electron OAuth module was wired in
  // (`deps.loadChatgptOauth`). With the flag off, `status` reports `available:
  // false` and the renderer never offers the choice; `signin`/`signout` refuse.
  //
  // NO TOKEN MATERIAL CROSSES (rule 3). `status`/`signin` answer identity LABELS
  // (email, accountId) read from the JWT; the access/refresh tokens live only in
  // the safeStorage vault and reach only the in-process transport.

  const chatgptStatus = (
    v: Partial<ChatgptOauthStatus> & Pick<ChatgptOauthStatus, 'available' | 'signedIn'>,
  ): Result<ChatgptOauthStatus> =>
    ok({ email: null, accountId: null, ...v });

  handle<ChatgptOauthStatus>('chatgpt-oauth:status', async () => {
    if (!isChatgptOauthEnabled() || !deps.loadChatgptOauth) {
      return chatgptStatus({ available: false, signedIn: false });
    }
    const mod = await deps.loadChatgptOauth();
    return chatgptStatus({ available: true, ...(await mod.readSignInStatus(deps.vault)) });
  });

  handle<ChatgptOauthStatus>('chatgpt-oauth:signin', async () => {
    if (!isChatgptOauthEnabled() || !deps.loadChatgptOauth) {
      return fail('INTERNAL', 'ChatGPT subscription sign-in is a dev-only, flag-sealed feature.');
    }
    const mod = await deps.loadChatgptOauth();
    // Runs the browser PKCE flow + loopback callback + token exchange, and
    // stores the token set in the vault. Only labels come back to the renderer.
    await mod.startChatgptLogin(deps.vault);
    return chatgptStatus({ available: true, ...(await mod.readSignInStatus(deps.vault)) });
  });

  handle<ChatgptOauthStatus>('chatgpt-oauth:signout', async () => {
    if (!isChatgptOauthEnabled() || !deps.loadChatgptOauth) {
      return chatgptStatus({ available: false, signedIn: false });
    }
    const mod = await deps.loadChatgptOauth();
    mod.clearTokens(deps.vault);
    return chatgptStatus({ available: true, signedIn: false });
  });

  // -- auto-update (F1-09) -------------------------------------------------
  //
  // The `unsupported` fallback below is not defensive padding. It is the SAME
  // state the contract already requires for unsigned macOS, so a renderer that
  // handles the platform case correctly handles this one for free — there is no
  // second code path for "the updater was not wired up".

  const unavailable = (): UpdateStatus => ({
    state: 'unsupported',
    reason: 'Updates are not available in this build.',
    releasesUrl: 'https://github.com/leonardo204/naby/releases/latest',
    currentVersion: '0.0.0',
  });

  handle('update:get', () => ok(deps.updater ? deps.updater.status() : unavailable()));

  handle('update:check', async () => {
    if (!deps.updater) return ok(unavailable());
    return ok(await deps.updater.checkNow());
  });

  handle('update:install', () => {
    deps.updater?.installNow();
    return ok(undefined as void);
  });

  // -- "what changed" ------------------------------------------------------
  //
  // No decision is made here on purpose. Whether an upgrade happened, which
  // entries fall in the range, and whether a missing watermark means a fresh
  // install are all pure functions in the renderer (releaseNotesOps.ts), where
  // they are unit-tested; main answers two facts and stores one string.

  handle('whats-new:get', () =>
    ok({
      currentVersion: safeAppVersion(),
      lastSeenVersion: deps.whatsNew?.lastSeenVersion() ?? null,
    }),
  );

  handle('whats-new:seen', (payload) => {
    // The renderer names the version it is acknowledging rather than main
    // assuming `currentVersion`: dismissing is the acknowledgement of what was
    // ON SCREEN, and the two would differ if the app ever updated underneath an
    // open window.
    const version = typeof payload === 'string' ? payload : '';
    if (!version) return fail('INTERNAL', 'a version string is required');
    deps.whatsNew?.record(version);
    return ok(undefined as void);
  });

  // FORCED DEV MODE (see electron/devmode.ts). `status` is safe to expose: it
  // reveals whether this build HAS a door and whether it is open, never the key
  // or its hash. `unlock` returns only a boolean — a wrong key is
  // indistinguishable from a right one that could not be persisted, which is the
  // correct amount to tell a caller that may not be the user.
  handle('devmode:status', () =>
    ok({
      available: isDevModeAvailable(),
      unlocked: isDevModeUnlocked(),
      // Whether THIS launch is actually running with the dev providers on. It
      // differs from `unlocked` until the app is restarted, and the UI says so
      // rather than implying the switch already took effect.
      activeNow: process.env.NABY_ENABLE_CHATGPT_OAUTH === '1',
    }),
  );

  // Returns WHICH way the attempt went, not just whether it worked: the renderer
  // has to tell a mismatch apart from a match that could not be persisted, and
  // it cannot see the exception that distinguishes them.
  //
  // NOTE THE ARGUMENT ORDER. `handle` calls `fn(payload, event)` — payload
  // first, like every other handler here. This one was written `(_e, key)`, as
  // if it were a raw `ipcMain.handle` listener, so the key landed in `_e`, the
  // event landed in `key`, `typeof key === 'string'` was false, and the empty
  // string reached the compare. Every correct key was rejected, and the two
  // `unknown` parameters made it invisible to the type checker.
  handle('devmode:unlock', (payload: unknown) =>
    ok(unlockDevMode(typeof payload === 'string' ? payload : '')),
  );

  handle('devmode:lock', () => {
    lockDevMode();
    return ok(undefined as void);
  });

  handle('update:open-releases', async () => {
    if (deps.updater) await deps.updater.openReleasesPage();
    return ok(undefined as void);
  });

  // -- file-browser OS operations ------------------------------------------
  //
  // The renderer sends `{cwd, rel}` and NEVER an absolute path. `absWithin`
  // does the join and the containment check on this side; a payload that
  // escapes the project is refused here rather than handed to `shell`.

  handle('fs:reveal', (payload) => {
    const abs = absWithin(payload);
    if (!abs) return fail('INTERNAL', 'refused: that path is outside the project');
    // Fire-and-forget by design: showItemInFolder has no result, and whether
    // the user then closes the Finder window is not ours to report.
    shell.showItemInFolder(abs);
    return ok(undefined as void);
  });

  handle('fs:open', async (payload) => {
    const abs = absWithin(payload);
    if (!abs) return fail('INTERNAL', 'refused: that path is outside the project');
    // `openPath` DOES NOT REJECT. It resolves with a string: empty on success,
    // and the OS's reason on failure ("Failed to open path", no registered
    // handler, and so on). Awaiting it without reading that string is how a
    // double-click that opened nothing reports success — so the string is the
    // result, and a non-empty one becomes a failed Result the renderer can put
    // in a toast.
    const problem = await shell.openPath(abs);
    if (problem) return fail('INTERNAL', problem);
    return ok(undefined as void);
  });

  handle('fs:trash', async (payload) => {
    const abs = absWithin(payload);
    if (!abs) return fail('INTERNAL', 'refused: that path is outside the project');
    // Containment alone would ALLOW the project root, since the root is inside
    // itself. Trashing it would take every file the user has open with it, so
    // the one destructive channel says no.
    if (isProjectRoot(payload, abs)) {
      return fail('INTERNAL', 'refused: the project root cannot be trashed');
    }
    // `trashItem` rejects when the item is gone or the OS refuses; the wrapper
    // above turns that into a Result the renderer can show, and the file
    // browser then leaves the row alone rather than pretending it was deleted.
    await shell.trashItem(abs);
    return ok(undefined as void);
  });

  // -- folder chooser ------------------------------------------------------
  //
  // PARENTED TO THE CALLING WINDOW, AND THAT IS THE WHOLE POINT. Passing the
  // BrowserWindow makes this a window-modal sheet owned by naby, so the app's
  // menu bar stays in force while it is up — which is what makes cmd+C/cmd+V
  // work in the panel's "New Folder" field. The web fallback launches the same
  // panel out of `osascript`, a process with no menus, where those shortcuts
  // dispatch to nothing and silently do nothing.
  //
  // `event.sender` is the top-level webContents even when the call comes from
  // the project iframe (same-origin frames share it), so the sheet lands on the
  // window the user is actually looking at. The focused-window fallback covers
  // a sender whose window has already gone; with neither, the parentless form
  // still opens a usable app-owned panel rather than failing the call.
  handle('fs:pickFolder', async (payload, event) => {
    const { message } = asObject(payload);
    if (message !== undefined && typeof message !== 'string') {
      return fail('INTERNAL', 'message must be a string when present');
    }
    const options: OpenDialogOptions = {
      // `createDirectory` is what puts the "New Folder" button in the panel —
      // the button whose text field this fix is about.
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: homedir(),
      ...(message ? { message } : {}),
    };
    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow();
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    // Cancelling is a NORMAL outcome, not a failure: `null` is the answer the
    // renderer already handles (the web route returns `{folder: null}` for it),
    // so a dismissed panel must not become an error toast.
    if (result.canceled) return ok(null);
    const picked = result.filePaths[0];
    return ok(picked ? picked : null);
  });

  handle('notify:show', (payload) => {
    const { kind, locale, label } = asObject(payload);
    // The enum is the whole guard on what may be SAID. An unknown kind is a
    // refusal, not a fallback: falling back would let a caller reach the
    // catalogue by guessing.
    if (!isNotifyKind(kind)) {
      return fail('INTERNAL', 'unknown notification kind');
    }
    // ONE CALL PER FINISHED RUN, and no count on the wire. Main TALLIES these
    // calls and shows a single replaceable banner carrying the total, so the
    // renderer still supplies nothing but a kind, a locale and one bounded
    // label — it cannot author a sentence, and it cannot inflate a number.
    const shown = showNotification({
      kind,
      locale: asNotifyLocale(locale),
      // Sanitized HERE, on the trusted side, so a renderer bug cannot put a
      // second line (or a bidi override) into a banner drawn by the OS with our
      // name on it.
      label: sanitizeLabel(label),
    });
    // `shown` now means ACCEPTED: the platform has notifications and this run was
    // counted. The draw itself is debounced by a few hundred milliseconds so a
    // burst becomes one banner rather than one redraw per run.
    return ok({ shown });
  });

  // The M→R half of contract §1.3. Broadcast to every live webContents rather
  // than to a remembered window handle: the window can be closed and reopened
  // (macOS `activate`), and a stale handle would silently stop updating the UI.
  const unsubscribe = deps.updater?.onStatus((status) => {
    for (const wc of webContents.getAllWebContents()) {
      if (wc.isDestroyed()) continue;
      try {
        wc.send(UPDATE_STATUS_EVENT, status);
      } catch {
        // A webContents that died between the liveness check and the send is
        // not an error worth surfacing; the next push finds it gone.
      }
    }
  });

  return () => {
    unsubscribe?.();
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  };
}

/**
 * `app.getVersion()` throws outside an Electron app context, and this module is
 * imported by harnesses that have none. Same guarded accessor as updater.ts;
 * `0.0.0` is unparseable-as-an-upgrade from anything real, so a harness reading
 * it shows no notes rather than all of them.
 */
function safeAppVersion(): string {
  try {
    return app.getVersion();
  } catch {
    return '0.0.0';
  }
}

// ---------------------------------------------------------------------------
// Frame validation (contract §1.1)
// ---------------------------------------------------------------------------

/**
 * True only for a frame whose ORIGIN is exactly ours.
 *
 * `senderFrame` is null for a frame that has already been destroyed, and
 * reading `.url` on a destroyed frame throws — both are treated as "not
 * allowed", which is the safe direction. Same-origin iframes (the shell renders
 * each project in one) pass, which is intended: they are our own document
 * served by our own guarded server.
 */
function isAllowedFrame(event: IpcMainInvokeEvent, allowedOrigin: string): boolean {
  if (!allowedOrigin) return false;
  try {
    const frame = event.senderFrame;
    if (!frame) return false;
    return new URL(frame.url).origin === new URL(allowedOrigin).origin;
  } catch {
    return false;
  }
}

/** Structured clone gives us `unknown`; narrow it once, in one place. */
function asObject(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------------------
// Project containment for the fs channels
// ---------------------------------------------------------------------------

/**
 * `{cwd, rel}` → the absolute path, or null if it is not inside `cwd`.
 *
 * This is the main-process twin of the shell's `withinCwd`
 * (shell/src/lib/fsScope.ts), and it is deliberately a SECOND implementation
 * rather than a shared import: the shell is a separate repository (a submodule)
 * and the main process must not depend on it to know what it is allowed to
 * touch. The rule is the one the shell states — the target is the project root
 * itself or strictly inside it — and the `+ sep` is what stops `/work/proj-old`
 * from passing as `/work/proj`.
 *
 * `resolve` collapses any `..` BEFORE the comparison, so the check cannot be
 * walked around by a `rel` that climbs and comes back.
 */
function absWithin(payload: unknown): string | null {
  const { cwd, rel } = asObject(payload);
  if (typeof cwd !== 'string' || !cwd || !isAbsolute(cwd)) return null;
  if (typeof rel !== 'string') return null;
  const base = resolve(cwd);
  const target = resolve(join(base, rel));
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}

/** True when `{cwd, rel}` names the project root itself rather than something
 *  in it. Revealing the root is useful; TRASHING it would take the whole
 *  project, so only the destructive channel refuses it. */
function isProjectRoot(payload: unknown, abs: string): boolean {
  const { cwd } = asObject(payload);
  return typeof cwd === 'string' && resolve(cwd) === abs;
}
