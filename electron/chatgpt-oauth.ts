// electron/chatgpt-oauth.ts
//
// ChatGPT Subscription-OAuth — the DEV-ONLY Electron-main flow + token vault
// (CO-01, CO-02). Main process only.
//
// ⚠️  DEV / TEST ONLY — FLAG-SEALED OUT OF OFFICIAL BUILDS.  ⚠️
//
// This drives the interactive "Sign in with ChatGPT" OAuth (PKCE) and holds the
// resulting token set in the SAME safeStorage vault as the API keys. It exists
// only so a developer can exercise the provider-independent runtime on a signed-in
// ChatGPT subscription at no metered cost — the OpenAI analogue of the local
// Claude sign-in the Agent SDK reuses. It talks to the UNOFFICIAL ChatGPT backend
// (a ToS grey zone, spec §1/§2) and MUST NOT ship to end users.
//
// THE SEAL. This module is NOT an electron-builder entry point and is NOT
// imported by `main.ts`, so it is never compiled into a packaged app — the same
// "absent from the artifact" discipline the Agent SDK gets. Wiring it to IPC
// (wave 2) must stay behind `isChatgptOauthEnabled()` AND the build-dist seal.
//
// WHAT IT NEVER DOES. It never logs a token, never returns key material over IPC,
// and never writes plaintext to disk — the token set is encrypted through the
// vault exactly like an API key, and only the derived {accessToken, accountId}
// pair reaches the transport, in-process, for one request.
//
// The pure crypto/JWT/rotation logic lives in ../src/providers/chatgpt-oauth.ts
// (unit-tested there); this file is the IO composition around it.

import { createServer, type Server } from 'node:http';
import { shell } from 'electron';
import type { CredentialVault } from './credentials.js';
import {
  applyRefreshResponse,
  buildAuthorizeUrl,
  buildRefreshBody,
  buildTokenExchangeBody,
  CHATGPT_CALLBACK_FALLBACK_PORT,
  CHATGPT_CALLBACK_PATH,
  CHATGPT_CALLBACK_PORT,
  CHATGPT_OAUTH_PROVIDER_ID,
  CHATGPT_TOKEN_URL,
  generatePkce,
  generateState,
  isChatgptOauthEnabled,
  isPermanentRefreshFailure,
  isTokenExpired,
  tokensFromExchange,
  type ChatgptOauthTokens,
  type ChatgptTokenResponse,
  type ChatgptTokenSource,
} from '../src/providers/chatgpt-oauth.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when the refresh token is dead and the user must sign in again. The
 *  UI (wave 2) maps this to a re-login prompt rather than a transient error. */
export class ChatgptReloginRequiredError extends Error {
  readonly code = 'CHATGPT_RELOGIN_REQUIRED';
  constructor(message: string) {
    super(message);
    this.name = 'ChatgptReloginRequiredError';
  }
}

/** Thrown when the dev seal is closed but a caller tried to use this path. */
export class ChatgptSealedError extends Error {
  readonly code = 'CHATGPT_OAUTH_SEALED';
  constructor() {
    super(
      'ChatGPT subscription-OAuth is a dev-only, flag-sealed path; set ' +
        'NABY_ENABLE_CHATGPT_OAUTH to enable it (never in an official build).',
    );
    this.name = 'ChatgptSealedError';
  }
}

// ---------------------------------------------------------------------------
// The vault (CO-02 storage) — tokens as an encrypted JSON blob
// ---------------------------------------------------------------------------
//
// The vault stores STRINGS keyed by a provider id (see electron/credentials.ts).
// The token set is a small JSON object, so it is stored as `JSON.stringify(...)`
// under the reserved id `openai-chatgpt-oauth`, encrypted exactly like a key.
// `acknowledgeInsecure` is passed because on a machine with no secure backend the
// dev user has already been warned about the vault; refusing to store the dev
// token there would just break the dev flow the same warning already covered.

export async function loadTokens(vault: CredentialVault): Promise<ChatgptOauthTokens | null> {
  const raw = await vault.get(CHATGPT_OAUTH_PROVIDER_ID);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ChatgptOauthTokens;
    if (!parsed || typeof parsed.access_token !== 'string' || typeof parsed.refresh_token !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function saveTokens(vault: CredentialVault, tokens: ChatgptOauthTokens): Promise<void> {
  await vault.set(CHATGPT_OAUTH_PROVIDER_ID, JSON.stringify(tokens), { acknowledgeInsecure: true });
}

/** Logout — clear the stored token set. Idempotent. */
export function clearTokens(vault: CredentialVault): void {
  vault.clear(CHATGPT_OAUTH_PROVIDER_ID);
}

// ---------------------------------------------------------------------------
// Refresh (CO-02) — POST the token endpoint, ROTATE, persist
// ---------------------------------------------------------------------------

export type ChatgptOauthIo = {
  /** Injectable for tests; defaults to the global. */
  fetch?: typeof globalThis.fetch;
  /** Override "now" (epoch ms) for testable expiry. */
  now?: () => number;
  log?: (msg: string) => void;
};

async function postForm(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  body: string,
): Promise<ChatgptTokenResponse> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  });
  let json: ChatgptTokenResponse;
  try {
    json = (await res.json()) as ChatgptTokenResponse;
  } catch {
    json = { access_token: '', error: `non_json_response_${res.status}` };
  }
  if (!res.ok || json.error) {
    // A dead refresh token is a permanent failure the caller must surface as
    // "sign in again"; anything else is transient.
    const code = json.error ?? res.status;
    if (isPermanentRefreshFailure(code)) {
      throw new ChatgptReloginRequiredError(
        `ChatGPT sign-in expired (${json.error ?? `HTTP ${res.status}`}) — sign in again.`,
      );
    }
    throw new Error(`ChatGPT token request failed: ${json.error ?? `HTTP ${res.status}`}`);
  }
  return json;
}

/**
 * Refresh the access token, ROTATING the refresh token, and persist the new set.
 * OpenAI invalidates the old refresh token on every refresh, so the rotated one
 * MUST be saved (reusing the old trips `refresh_token_reused`).
 */
export async function refreshTokens(
  vault: CredentialVault,
  prev: ChatgptOauthTokens,
  io: ChatgptOauthIo = {},
): Promise<ChatgptOauthTokens> {
  const fetchImpl = io.fetch ?? globalThis.fetch;
  const now = io.now ?? Date.now;
  const resp = await postForm(fetchImpl, CHATGPT_TOKEN_URL, buildRefreshBody({ refreshToken: prev.refresh_token }));
  const next = applyRefreshResponse(prev, resp, now());
  await saveTokens(vault, next);
  io.log?.('[chatgpt-oauth] refreshed + rotated token');
  return next;
}

/**
 * Return a usable access token, refreshing transparently if it is expired or
 * within the refresh window (5 min before `exp`). Throws
 * `ChatgptReloginRequiredError` when no token is stored or the refresh is dead.
 */
export async function ensureFreshToken(
  vault: CredentialVault,
  io: ChatgptOauthIo = {},
): Promise<{ accessToken: string; accountId: string }> {
  if (!isChatgptOauthEnabled()) throw new ChatgptSealedError();
  const now = io.now ?? Date.now;
  const tokens = await loadTokens(vault);
  if (!tokens) {
    throw new ChatgptReloginRequiredError('Not signed in to ChatGPT — sign in first.');
  }
  const fresh = isTokenExpired(tokens.expires_at, now()) ? await refreshTokens(vault, tokens, io) : tokens;
  return { accessToken: fresh.access_token, accountId: fresh.account_id };
}

/**
 * The token SOURCE the AiSdkEngine custom transport pulls from (spec §8). Bound
 * to this vault; `ensureFreshToken` refreshes pre-emptively, `refreshNow` forces
 * a refresh after a live 401.
 */
export function makeVaultTokenSource(vault: CredentialVault, io: ChatgptOauthIo = {}): ChatgptTokenSource {
  return {
    ensureFreshToken: () => ensureFreshToken(vault, io),
    refreshNow: async () => {
      const tokens = await loadTokens(vault);
      if (!tokens) throw new ChatgptReloginRequiredError('Not signed in to ChatGPT — sign in first.');
      const next = await refreshTokens(vault, tokens, io);
      return { accessToken: next.access_token, accountId: next.account_id };
    },
  };
}

// ---------------------------------------------------------------------------
// The interactive OAuth flow (CO-01) — browser + loopback callback + exchange
// ---------------------------------------------------------------------------

export type StartLoginOptions = ChatgptOauthIo & {
  /** Open the authorize URL in the system browser. Injectable; defaults to
   *  Electron's `shell.openExternal`. */
  openExternal?: (url: string) => Promise<void> | void;
  /** How long to wait for the browser callback before giving up (ms). */
  timeoutMs?: number;
  /** Preferred loopback port; falls back to 1457 when busy. */
  port?: number;
};

const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** Bind an http server to 127.0.0.1 on the preferred port, falling back once. */
function listenLoopback(server: Server, preferred: number): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const tryPort = (port: number, isFallback: boolean) => {
      const onError = (err: NodeJS.ErrnoException) => {
        if (!isFallback && err.code === 'EADDRINUSE') {
          server.removeListener('error', onError);
          tryPort(CHATGPT_CALLBACK_FALLBACK_PORT, true);
          return;
        }
        reject(err);
      };
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', onError);
        resolvePort(port);
      });
    };
    tryPort(preferred, false);
  });
}

/**
 * Run the full sign-in: generate PKCE + state, start a loopback callback server,
 * open the browser to the authorize URL, and on the callback verify `state`,
 * exchange the code for tokens, and persist them. Resolves with the stored token
 * set (never returned to the renderer as-is).
 *
 * Does NOT block the caller's event loop beyond awaiting the user; the server is
 * torn down on success, error, or timeout.
 */
export async function startChatgptLogin(
  vault: CredentialVault,
  opts: StartLoginOptions = {},
): Promise<ChatgptOauthTokens> {
  if (!isChatgptOauthEnabled()) throw new ChatgptSealedError();

  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const openExternal = opts.openExternal ?? ((url: string) => shell.openExternal(url));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;

  const pkce = generatePkce();
  const state = generateState();

  return await new Promise<ChatgptOauthTokens>((resolveLogin, rejectLogin) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const server = createServer((req, res) => {
      void (async () => {
        try {
          const url = new URL(req.url ?? '/', `http://127.0.0.1`);
          if (url.pathname !== CHATGPT_CALLBACK_PATH) {
            res.writeHead(404).end('Not found');
            return;
          }
          const returnedState = url.searchParams.get('state');
          const code = url.searchParams.get('code');
          const oauthErr = url.searchParams.get('error');

          if (oauthErr) {
            respondHtml(res, 400, 'Sign-in failed. You can close this window.');
            finish(new Error(`ChatGPT authorize error: ${oauthErr}`));
            return;
          }
          // STATE must match exactly (CSRF / mix-up defence).
          if (!returnedState || returnedState !== state) {
            respondHtml(res, 400, 'Sign-in state mismatch. You can close this window.');
            finish(new Error('ChatGPT OAuth state mismatch — aborting'));
            return;
          }
          if (!code) {
            respondHtml(res, 400, 'No authorization code. You can close this window.');
            finish(new Error('ChatGPT OAuth callback carried no code'));
            return;
          }

          const resp = await postForm(
            fetchImpl,
            CHATGPT_TOKEN_URL,
            buildTokenExchangeBody({ code, verifier: pkce.verifier, redirectUri }),
          );
          const tokens = tokensFromExchange(resp, now());
          await saveTokens(vault, tokens);
          respondHtml(res, 200, 'Signed in to ChatGPT. You can close this window and return to Naby.');
          finish(null, tokens);
        } catch (err) {
          try {
            respondHtml(res, 500, 'Sign-in failed. You can close this window.');
          } catch {
            /* response may already be sent */
          }
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });

    let redirectUri = '';

    const finish = (err: Error | null, tokens?: ChatgptOauthTokens) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      server.close();
      if (err) {
        opts.log?.(`[chatgpt-oauth] login failed: ${err.message}`);
        rejectLogin(err);
      } else if (tokens) {
        opts.log?.('[chatgpt-oauth] login complete');
        resolveLogin(tokens);
      }
    };

    listenLoopback(server, opts.port ?? CHATGPT_CALLBACK_PORT)
      .then(async (port) => {
        redirectUri = `http://localhost:${port}${CHATGPT_CALLBACK_PATH}`;
        const authorizeUrl = buildAuthorizeUrl({
          challenge: pkce.challenge,
          state,
          redirectUri,
        });
        timer = setTimeout(
          () => finish(new Error('ChatGPT sign-in timed out waiting for the browser callback')),
          timeoutMs,
        );
        await openExternal(authorizeUrl);
        opts.log?.(`[chatgpt-oauth] opened browser; awaiting callback on ${redirectUri}`);
      })
      .catch((err: unknown) => finish(err instanceof Error ? err : new Error(String(err))));
  });
}

function respondHtml(
  res: import('node:http').ServerResponse,
  status: number,
  message: string,
): void {
  const body =
    `<!doctype html><html><head><meta charset="utf-8"><title>Naby — ChatGPT sign-in</title></head>` +
    `<body style="font-family:system-ui;padding:2rem;color:#222"><p>${message}</p></body></html>`;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(body);
}
