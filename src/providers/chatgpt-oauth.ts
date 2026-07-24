// src/providers/chatgpt-oauth.ts
//
// ChatGPT Subscription-OAuth — the DEV-ONLY pure core (CO-01..05).
//
// ⚠️  DEV / TEST ONLY — FLAG-SEALED OUT OF OFFICIAL BUILDS.  ⚠️
//
// This module talks to the UNOFFICIAL ChatGPT subscription backend
// (`chatgpt.com/backend-api/codex`), the OpenAI analogue of the dev Claude
// Agent SDK engine. It answers turns on a signed-in ChatGPT Plus/Pro
// subscription instead of a metered API key. That backend is a ToS grey zone
// (spec §1/§2): OpenAI has neither clearly permitted nor forbidden third-party
// reuse of its "Sign in with ChatGPT" OAuth. So — exactly like the Agent SDK —
// the whole path is DEV-ONLY and sealed out of any official/public build by a
// build-time flag AND a runtime env flag (defense in depth):
//
//   * runtime seal   `isChatgptOauthEnabled(env)` — false unless
//                    `NABY_ENABLE_CHATGPT_OAUTH` is set. `describeProviders`
//                    and `isChatgptOauthAvailable` are gated on it, so with the
//                    flag off the provider is never offered and every code path
//                    below is dead.
//   * build seal     `scripts/build-dist.mjs` (the NABY_BUNDLE_AGENT_SDK
//                    pattern) — an official artifact must not enable it, and the
//                    electron OAuth entry is never bundled into a shipped app.
//
// NOTHING HERE CLAIMS OPENAI ENDORSEMENT. It is a developer convenience with a
// stated ToS caveat, nothing more.
//
// This file is PURE (no `@ai-sdk/*` import, only `node:crypto`) so it is:
//   * unit-testable without a browser, a network, or safeStorage, and
//   * importable by the Electron main process directly (the model factory that
//     needs `@ai-sdk/openai` lives in `registry.ts`, which already imports it).
//
// Google Gemini OAuth is NOT here and never will be — its ToS names the exact
// reuse pattern as a violation (spec §1). The Gemini API-key path is untouched.

import { createHash, randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants (verified against openai/codex + openclaw — see the spec)
// ---------------------------------------------------------------------------

/** The public Codex "Sign in with ChatGPT" client id. Not a secret. */
export const CHATGPT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CHATGPT_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
/** Auth-code exchange AND refresh share this endpoint. */
export const CHATGPT_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const CHATGPT_REVOKE_URL = 'https://auth.openai.com/oauth/revoke';
export const CHATGPT_SCOPE = 'openid profile email offline_access';
/** The UNOFFICIAL subscription backend. Responses API, not api.openai.com/v1. */
export const CHATGPT_QUERY_BASE_URL = 'https://chatgpt.com/backend-api/codex';
/** Any app identifier; codex uses codex_cli_rs, we use this. */
export const CHATGPT_ORIGINATOR = 'naby';
/** Loopback callback the local server binds. Fallback port for a busy 1455. */
export const CHATGPT_CALLBACK_PORT = 1455;
export const CHATGPT_CALLBACK_FALLBACK_PORT = 1457;
export const CHATGPT_CALLBACK_PATH = '/auth/callback';
/** The one env flag that opens the runtime seal. Default (unset) = off. */
export const CHATGPT_OAUTH_ENABLE_FLAG = 'NABY_ENABLE_CHATGPT_OAUTH';
/** The provider id / kind under which tokens live in the vault. */
export const CHATGPT_OAUTH_PROVIDER_ID = 'openai-chatgpt-oauth';

/** JWT custom claim namespace carrying the ChatGPT account id + plan. */
const AUTH_CLAIM = 'https://api.openai.com/auth';
const PROFILE_CLAIM = 'https://api.openai.com/profile';

/** Refresh this many ms BEFORE `exp` — never wait for a live 401 if avoidable. */
export const REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * OAuth error codes (and HTTP 401) that mean the refresh token is dead and the
 * user must sign in again — no amount of retrying fixes them. `refresh_token_reused`
 * is the one a double-refresh trips, which is why rotation must persist the new
 * token every time (see `applyRefreshResponse`).
 */
export const PERMANENT_REFRESH_FAILURES: readonly string[] = [
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated',
];

// ---------------------------------------------------------------------------
// The runtime seal
// ---------------------------------------------------------------------------

/**
 * Whether the ChatGPT-OAuth dev path is enabled in THIS process. False unless
 * `NABY_ENABLE_CHATGPT_OAUTH` is a truthy value. Everything that could offer or
 * run the provider is gated on this, so an app that does not set it never shows
 * — let alone runs — a subscription-OAuth choice.
 */
export function isChatgptOauthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[CHATGPT_OAUTH_ENABLE_FLAG] ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------

export function base64UrlEncode(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlToBuffer(input: string): Buffer {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + pad;
  return Buffer.from(b64, 'base64');
}

// ---------------------------------------------------------------------------
// PKCE (S256)
// ---------------------------------------------------------------------------

export type PkcePair = {
  /** base64url of 32–64 random bytes, no padding. Kept private; sent only on
   *  the token exchange. */
  verifier: string;
  /** base64url(sha256(verifier)), no padding. Goes in the authorize URL. */
  challenge: string;
  method: 'S256';
};

/**
 * Generate a PKCE verifier + S256 challenge.
 *
 * @param bytes injectable random source (a spike passes fixed bytes to assert
 *              the S256 relation deterministically). Defaults to 32 CSPRNG bytes.
 */
export function generatePkce(bytes: Buffer = randomBytes(32)): PkcePair {
  const verifier = base64UrlEncode(bytes);
  const challenge = base64UrlEncode(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

/** A random opaque `state` (and reusable for a callback nonce). */
export function generateState(bytes: Buffer = randomBytes(24)): string {
  return base64UrlEncode(bytes);
}

// ---------------------------------------------------------------------------
// Authorize URL
// ---------------------------------------------------------------------------

export type AuthorizeUrlOptions = {
  challenge: string;
  state: string;
  redirectUri: string;
  clientId?: string;
  originator?: string;
  scope?: string;
};

/** Build the browser authorize URL (spec §1). */
export function buildAuthorizeUrl(opts: AuthorizeUrlOptions): string {
  const url = new URL(CHATGPT_AUTHORIZE_URL);
  const q = url.searchParams;
  q.set('response_type', 'code');
  q.set('client_id', opts.clientId ?? CHATGPT_CLIENT_ID);
  q.set('redirect_uri', opts.redirectUri);
  q.set('scope', opts.scope ?? CHATGPT_SCOPE);
  q.set('code_challenge', opts.challenge);
  q.set('code_challenge_method', 'S256');
  q.set('state', opts.state);
  q.set('id_token_add_organizations', 'true');
  q.set('codex_cli_simplified_flow', 'true');
  q.set('originator', opts.originator ?? CHATGPT_ORIGINATOR);
  return url.toString();
}

// ---------------------------------------------------------------------------
// Token exchange / refresh request bodies (application/x-www-form-urlencoded)
// ---------------------------------------------------------------------------

export function buildTokenExchangeBody(opts: {
  code: string;
  verifier: string;
  redirectUri: string;
  clientId?: string;
}): string {
  const body = new URLSearchParams();
  body.set('grant_type', 'authorization_code');
  body.set('code', opts.code);
  body.set('code_verifier', opts.verifier);
  body.set('client_id', opts.clientId ?? CHATGPT_CLIENT_ID);
  body.set('redirect_uri', opts.redirectUri);
  return body.toString();
}

export function buildRefreshBody(opts: { refreshToken: string; clientId?: string }): string {
  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', opts.refreshToken);
  body.set('client_id', opts.clientId ?? CHATGPT_CLIENT_ID);
  return body.toString();
}

// ---------------------------------------------------------------------------
// JWT payload extraction (account id / exp / email)
// ---------------------------------------------------------------------------

type JwtPayload = {
  exp?: number;
  email?: string;
  [k: string]: unknown;
};

/** Decode a JWT's payload segment. Never verifies a signature — we only READ
 *  claims OpenAI put there (the account id, the expiry), never trust them for
 *  authz. Returns null on any malformed input. */
export function decodeJwtPayload(token: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    return JSON.parse(base64UrlToBuffer(parts[1]).toString('utf8')) as JwtPayload;
  } catch {
    return null;
  }
}

/**
 * The ChatGPT account id, from `payload["https://api.openai.com/auth"].chatgpt_account_id`.
 * This is the value the query backend wants in the `chatgpt-account-id` header.
 * Null when the token is not a JWT or does not carry the claim.
 */
export function extractAccountId(accessToken: string): string | null {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload?.[AUTH_CLAIM];
  if (auth && typeof auth === 'object') {
    const id = (auth as Record<string, unknown>).chatgpt_account_id;
    if (typeof id === 'string' && id) return id;
  }
  return null;
}

/** Whether the account is a FedRAMP tenant (needs an extra query header). */
export function extractIsFedramp(accessToken: string): boolean {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload?.[AUTH_CLAIM];
  if (auth && typeof auth === 'object') {
    return (auth as Record<string, unknown>).chatgpt_account_is_fedramp === true;
  }
  return false;
}

/** The signed-in email, from the standard claim or the profile claim. Label
 *  only — never used for auth. */
export function extractEmail(accessToken: string): string | null {
  const payload = decodeJwtPayload(accessToken);
  if (payload && typeof payload.email === 'string' && payload.email) return payload.email;
  const profile = payload?.[PROFILE_CLAIM];
  if (profile && typeof profile === 'object') {
    const email = (profile as Record<string, unknown>).email;
    if (typeof email === 'string' && email) return email;
  }
  return null;
}

/** The JWT `exp` (seconds) as epoch ms, or null when absent/malformed. */
export function extractExpiryMs(accessToken: string): number | null {
  const payload = decodeJwtPayload(accessToken);
  if (payload && typeof payload.exp === 'number' && Number.isFinite(payload.exp)) {
    return payload.exp * 1000;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

/**
 * Compute the absolute expiry (epoch ms) for a freshly issued/refreshed token.
 * Prefers the `expires_in` seconds the server returned; falls back to the
 * access-token JWT `exp`; finally a conservative 1-hour default so a token with
 * neither is still treated as short-lived rather than eternal.
 */
export function expiresAtFrom(
  resp: { expires_in?: number; access_token?: string },
  now: number = Date.now(),
): number {
  if (typeof resp.expires_in === 'number' && Number.isFinite(resp.expires_in)) {
    return now + resp.expires_in * 1000;
  }
  if (resp.access_token) {
    const fromJwt = extractExpiryMs(resp.access_token);
    if (fromJwt !== null) return fromJwt;
  }
  return now + 60 * 60 * 1000;
}

/** True when the token is expired OR within the refresh window (`skewMs`). */
export function isTokenExpired(
  expiresAt: number,
  now: number = Date.now(),
  skewMs: number = REFRESH_SKEW_MS,
): boolean {
  return now >= expiresAt - skewMs;
}

// ---------------------------------------------------------------------------
// The stored token set + refresh rotation
// ---------------------------------------------------------------------------

/** What the vault holds, encrypted (spec §7). Only labels + tokens; no secret
 *  ever leaves this shape as anything but ciphertext on disk. */
export type ChatgptOauthTokens = {
  access_token: string;
  refresh_token: string;
  /** epoch ms. */
  expires_at: number;
  account_id: string;
  id_token?: string;
};

/** The JSON a token endpoint returns (exchange or refresh). */
export type ChatgptTokenResponse = {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

/**
 * Build the persisted token set from an AUTH-CODE exchange response. The account
 * id is derived from the access token's JWT (spec §3); the id_token is stored
 * only if present (it is not required — the account id comes from access_token).
 */
export function tokensFromExchange(
  resp: ChatgptTokenResponse,
  now: number = Date.now(),
): ChatgptOauthTokens {
  if (!resp.access_token) throw new Error('token exchange response has no access_token');
  if (!resp.refresh_token) throw new Error('token exchange response has no refresh_token');
  return {
    access_token: resp.access_token,
    refresh_token: resp.refresh_token,
    expires_at: expiresAtFrom(resp, now),
    account_id: extractAccountId(resp.access_token) ?? '',
    ...(resp.id_token ? { id_token: resp.id_token } : {}),
  };
}

/**
 * Apply a REFRESH response to the previous token set — ROTATING the refresh
 * token. OpenAI issues a new refresh token on every refresh and invalidates the
 * old one; reusing the old one trips `refresh_token_reused`. So the new refresh
 * token, when present, WINS and must be persisted. When the response omits one
 * (some servers only rotate sometimes) the previous refresh token is kept. The
 * account id is recomputed from the new access token, falling back to the old.
 */
export function applyRefreshResponse(
  prev: ChatgptOauthTokens,
  resp: ChatgptTokenResponse,
  now: number = Date.now(),
): ChatgptOauthTokens {
  if (!resp.access_token) throw new Error('refresh response has no access_token');
  const nextRefresh = resp.refresh_token ?? prev.refresh_token;
  return {
    access_token: resp.access_token,
    refresh_token: nextRefresh,
    expires_at: expiresAtFrom(resp, now),
    account_id: extractAccountId(resp.access_token) ?? prev.account_id,
    ...(resp.id_token ? { id_token: resp.id_token } : prev.id_token ? { id_token: prev.id_token } : {}),
  };
}

/** Whether a token-endpoint error (or an HTTP status) means "sign in again". */
export function isPermanentRefreshFailure(errorOrStatus: string | number): boolean {
  if (typeof errorOrStatus === 'number') return errorOrStatus === 401;
  return PERMANENT_REFRESH_FAILURES.includes(errorOrStatus);
}

// ---------------------------------------------------------------------------
// Query headers (spec §4)
// ---------------------------------------------------------------------------

export type QueryHeaderOptions = {
  accessToken: string;
  accountId: string;
  originator?: string;
  /** For the User-Agent string, e.g. `darwin`, `24.5.0`, `arm64`. */
  platform?: string;
  release?: string;
  arch?: string;
  /** FedRAMP tenants need `X-OpenAI-Fedramp: true`. */
  fedramp?: boolean;
};

/** Assemble the exact headers the subscription backend requires (spec §4). */
export function buildQueryHeaders(opts: QueryHeaderOptions): Record<string, string> {
  const originator = opts.originator ?? CHATGPT_ORIGINATOR;
  const platform = opts.platform ?? process.platform;
  const release = opts.release ?? '';
  const arch = opts.arch ?? process.arch;
  const headers: Record<string, string> = {
    authorization: `Bearer ${opts.accessToken}`,
    'chatgpt-account-id': opts.accountId,
    'openai-beta': 'responses=experimental',
    originator,
    'user-agent': `${originator} (${platform} ${release}; ${arch})`,
  };
  if (opts.fedramp) headers['x-openai-fedramp'] = 'true';
  return headers;
}

// ---------------------------------------------------------------------------
// store:false body injection (spec §4 — the backend REJECTS store:true)
// ---------------------------------------------------------------------------

/**
 * Force `store:false` into a JSON request body. The ChatGPT backend rejects
 * `store:true` ("Store must be set to false"), and the AI-SDK OpenAI adapter
 * does not set it, so the transport injects it. A non-JSON / unparseable body is
 * returned untouched (there is nothing safe to rewrite).
 */
export function forceStoreFalse(body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      parsed.store = false;
      return JSON.stringify(parsed);
    }
    return body;
  } catch {
    return body;
  }
}

// ---------------------------------------------------------------------------
// The custom fetch (the AiSdkEngine custom transport — spec §8)
// ---------------------------------------------------------------------------

/**
 * The token source the transport pulls from. Implemented by the Electron
 * safeStorage vault (electron/chatgpt-oauth.ts): `ensureFreshToken` refreshes
 * transparently before expiry; `refreshNow` forces a refresh after a live 401.
 */
export interface ChatgptTokenSource {
  ensureFreshToken(): Promise<{ accessToken: string; accountId: string }>;
  refreshNow(): Promise<{ accessToken: string; accountId: string }>;
}

export type ChatgptFetchOptions = {
  /** The underlying fetch to wrap. Defaults to the global. Injectable for tests. */
  fetch?: typeof globalThis.fetch;
  originator?: string;
  platform?: string;
  release?: string;
  arch?: string;
  fedramp?: boolean;
};

/** Overlay our auth/query headers + store:false onto a request init. */
function injectRequest(
  init: RequestInit | undefined,
  token: { accessToken: string; accountId: string },
  opts: ChatgptFetchOptions,
): RequestInit {
  const headers = new Headers(init?.headers);
  const injected = buildQueryHeaders({
    accessToken: token.accessToken,
    accountId: token.accountId,
    ...(opts.originator !== undefined ? { originator: opts.originator } : {}),
    ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
    ...(opts.release !== undefined ? { release: opts.release } : {}),
    ...(opts.arch !== undefined ? { arch: opts.arch } : {}),
    ...(opts.fedramp !== undefined ? { fedramp: opts.fedramp } : {}),
  });
  // Our headers WIN over anything the adapter set (e.g. a dummy Bearer key).
  for (const [k, v] of Object.entries(injected)) headers.set(k, v);

  const next: RequestInit = { ...init, headers };
  if (typeof init?.body === 'string') {
    next.body = forceStoreFalse(init.body);
  }
  return next;
}

/**
 * Build the custom `fetch` for `createOpenAI({ fetch })`. On every call it:
 *   1. `ensureFreshToken()` (refreshes if within the skew window),
 *   2. injects the §4 headers + forces `store:false`,
 *   3. on a live 401, `refreshNow()` and retries ONCE.
 *
 * It matches `typeof globalThis.fetch`, so it drops straight into the adapter.
 */
export function makeChatgptFetch(
  source: ChatgptTokenSource,
  opts: ChatgptFetchOptions = {},
): typeof globalThis.fetch {
  const underlying = opts.fetch ?? globalThis.fetch;
  const doFetch: typeof globalThis.fetch = async (input, init) => {
    const token = await source.ensureFreshToken();
    const res = await underlying(input, injectRequest(init, token, opts));
    if (res.status !== 401) return res;
    // A 401 despite a "fresh" token means the access token was rejected — force
    // a refresh and retry exactly once. A second 401 surfaces to the caller.
    const refreshed = await source.refreshNow();
    return underlying(input, injectRequest(init, refreshed, opts));
  };
  return doFetch;
}
