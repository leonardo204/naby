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

import { ipcMain, webContents, type IpcMainInvokeEvent } from 'electron';
import type { CredentialVault } from './credentials.js';
import { CredentialError } from './credentials.js';
import type { ProviderProfileStore } from './providers.js';
import type { Updater, UpdateStatus } from './updater.js';
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

  handle('update:open-releases', async () => {
    if (deps.updater) await deps.updater.openReleasesPage();
    return ok(undefined as void);
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
