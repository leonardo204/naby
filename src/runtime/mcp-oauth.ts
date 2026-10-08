// src/runtime/mcp-oauth.ts
//
// MCP OVER BROWSER OAUTH — the Atlassian remote MCP's one way in
// (specs/org-harness-sync.md §3.8, M3).
//
// WHAT THIS FILE IS. An `OAuthClientProvider` for `@ai-sdk/mcp` 2.0.15 (the
// `authProvider` of an http transport), the token store behind it, and the
// interactive login that fills that store. The runtime owns all of it; the shell
// only opens the browser (it receives the authorization URL and hands it to the
// OS) and decides WHEN a login starts.
//
// ONE TOKEN STORE, BOTH ENGINES. Neither engine talks to an MCP server on its own:
// the AI-SDK engine calls our executors, and the Claude Agent SDK engine re-exports
// the same executors through its in-process `nabytools` server (strictMcpConfig —
// the SDK is never handed a remote MCP). So `loadMcpToolset` is the only MCP
// client in the app, it is the only reader of this store, and there is no second
// copy of a token anywhere (no SDK `mcpServers` entry with a bearer header).
//
// WHERE THE TOKENS LIVE. One JSON value per server in `settings`
// (`mcp.oauth.<server>`), in app.db beside the MCP registry and with the same
// protection grade as the other app.db secrets (the MCP headers/env, the
// Telegram token, the org harness metrics token). Not inside the `mcp_servers`
// row: the token must exist BEFORE §4.4 swaps the legacy stdio row for the OAuth
// one ("swap only after the user has logged in"), and the refresh path rewrites it
// far more often than the row should change. No reader hands this key to the UI.
//
// THE CHATGPT LESSONS (src/providers/chatgpt-oauth.ts), applied here:
//
//   ROTATION IS PERSISTED FIRST. A refresh response is written to the store before
//   anything is allowed to USE its access token. A crash between the two would
//   otherwise leave the old refresh token on disk, already spent, and the next
//   refresh fails with "reused".
//
//   ONE REFRESH AT A TIME (single-flight per server). Two tabs connecting at once
//   both see an expired token; with a rotating server the second refresh would
//   spend a token the first one already burned and log the user out. Every
//   refresh — the proactive one in `tokens()` and the library's own one after a
//   401 (intercepted in the transport's `fetch`) — goes through
//   `refreshMcpOAuthTokens`, which joins an in-flight refresh and refuses to send a
//   refresh token that is no longer the stored one.
//
//   "SIGN IN AGAIN" IS A STATE, NOT A LOOP. `invalid_grant` (expired, revoked or
//   reused refresh token) and `invalid_client` / `unauthorized_client` clear the
//   tokens and set status `relogin`. The provider never opens a browser outside an
//   explicit login, so a dead token costs one failed connect per turn and a
//   Settings badge — never a retry storm and never a browser tab out of nowhere.
//   A network failure or a 5xx is NOT a relogin: the tokens stay and the next turn
//   tries again.
//
// DISCOVERY (verified against the live server, 2026-10-08). Atlassian publishes no
// protected-resource metadata (`/.well-known/oauth-protected-resource` is 404 and
// the 401 carries no `resource_metadata`), so `@ai-sdk/mcp` falls back to the MCP
// URL as the authorization server, tries `/.well-known/oauth-authorization-server
// /v1/mcp` (404) and then the root `/.well-known/oauth-authorization-server`, whose
// `issuer` is the origin — exactly the issuer the library expects for that URL.
// No workaround is needed in our provider; `spike-mcp-oauth` pins the behaviour
// with a fake server that answers the same way.

import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  auth,
  type OAuthClientInformation,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
} from '@ai-sdk/mcp';
import type { Store } from './store/store.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The System MCP preset name. Also the plugin's own server name, so a tool is
 *  `mcp__atlassian__getConfluencePage` in naby and `mcp__plugin_…_atlassian__…`
 *  in Claude Code (§3.8, appendix A). */
export const ATLASSIAN_MCP_SERVER_NAME = 'atlassian';
/** The official remote MCP (§3.8). */
export const ATLASSIAN_MCP_URL = 'https://mcp.atlassian.com/v1/mcp';
/** The loopback callback path (§3.8 step 2). */
export const MCP_OAUTH_CALLBACK_PATH = '/oauth/callback';
/** Loopback host. An IP literal, never `localhost`: a resolver that maps
 *  `localhost` to ::1 would make the registered redirect and the listener disagree. */
export const MCP_OAUTH_LOOPBACK_HOST = '127.0.0.1';
/** How long an interactive login waits for the browser. */
export const MCP_OAUTH_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** Refresh this long before `expires_at` — never wait for a live 401 if avoidable. */
export const MCP_OAUTH_REFRESH_SKEW_MS = 60 * 1000;
/** OAuth error codes that mean "the user must sign in again" (§3.8). */
export const MCP_OAUTH_RELOGIN_ERRORS: readonly string[] = [
  'invalid_grant',
  'invalid_client',
  'unauthorized_client',
  // Non-standard spellings some servers use for the same states.
  'refresh_token_reused',
  'refresh_token_expired',
  'refresh_token_invalidated',
];

export function mcpOAuthSettingKey(server: string): string {
  return `mcp.oauth.${server}`;
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

export type McpOAuthTokens = OAuthTokens & {
  /** epoch ms the token set was stored. */
  obtained_at: number;
  /** epoch ms the access token expires, from `expires_in`; absent = unknown. */
  expires_at?: number;
};

export type McpOAuthStatus = 'connected' | 'relogin' | 'none';

export type McpOAuthRecord = {
  v: 1;
  /** The registered client (dynamic registration), reused across launches. */
  client?: OAuthClientInformation & { redirect_uri?: string };
  /** The authorization server that issued the stored credentials. */
  asInfo?: { authorizationServerUrl: string; tokenEndpoint: string };
  tokens?: McpOAuthTokens;
  /** `relogin` = the last refresh or connect proved the sign-in dead. */
  state: 'ok' | 'relogin' | 'none';
  reloginReason?: string;
  reloginAt?: number;
  loggedInAt?: number;
  refreshedAt?: number;
};

export type McpOAuthStore = Pick<Store, 'getSetting' | 'setSetting'>;

export function readMcpOAuthRecord(store: Pick<Store, 'getSetting'>, server: string): McpOAuthRecord | undefined {
  const raw = store.getSetting(mcpOAuthSettingKey(server))?.trim();
  if (!raw) return undefined;
  try {
    const rec = JSON.parse(raw) as McpOAuthRecord;
    return rec && typeof rec === 'object' && rec.v === 1 ? rec : undefined;
  } catch {
    return undefined;
  }
}

/** Synchronous by design: `setSetting` is a SQLite write, so when this returns the
 *  value is on disk — which is what "persist first" rests on. */
export function writeMcpOAuthRecord(store: McpOAuthStore, server: string, rec: McpOAuthRecord): void {
  store.setSetting(mcpOAuthSettingKey(server), JSON.stringify(rec));
}

function blankRecord(): McpOAuthRecord {
  return { v: 1, state: 'none' };
}

/** Forget everything (the preset was removed). */
export function clearMcpOAuth(store: McpOAuthStore, server: string): void {
  if (store.getSetting(mcpOAuthSettingKey(server)) !== undefined) {
    store.setSetting(mcpOAuthSettingKey(server), '');
  }
}

/**
 * The one answer to "is this server signed in" — used by the gate (§3.6), the
 * Settings card and the connect fast-path. `connected` needs a stored token AND a
 * last outcome that was not "sign in again" (the same bar `gate.js` sets: a token
 * exists).
 */
export function mcpOAuthStatus(store: Pick<Store, 'getSetting'>, server: string): McpOAuthStatus {
  const rec = readMcpOAuthRecord(store, server);
  if (!rec) return 'none';
  if (rec.state === 'relogin') return 'relogin';
  // A token with no registered client is not a sign-in this app made, and a
  // connect with it would make the library register a client mid-turn.
  if ((rec.tokens?.access_token || rec.tokens?.refresh_token) && rec.client?.client_id) return 'connected';
  return 'none';
}

function markRelogin(store: McpOAuthStore, server: string, reason: string, now: number): void {
  const rec = readMcpOAuthRecord(store, server) ?? blankRecord();
  const { tokens: _dropped, ...rest } = rec;
  writeMcpOAuthRecord(store, server, { ...rest, state: 'relogin', reloginReason: reason, reloginAt: now });
}

/**
 * THE TOOLS A REAL SIGN-IN ALWAYS HAS, per server (user decision 2026-10-08).
 *
 * Atlassian answers a dead or bogus bearer token with 200 and a REDUCED tool set
 * (`getContentFormatGuide` and three Teamwork Graph tools) instead of a 401 —
 * observed on the live server and in a real account. So "the connect succeeded"
 * does not mean "signed in": a listing without these names is treated as a sign-in
 * that has to be redone.
 */
export const MCP_OAUTH_REQUIRED_TOOLS: Readonly<Record<string, readonly string[]>> = {
  [ATLASSIAN_MCP_SERVER_NAME]: ['getConfluencePage'],
};

/**
 * Check a connected OAuth server's tool listing (REMOTE names). A listing that
 * lacks a required tool sets the status to "re-login needed" — the same state a
 * dead refresh token produces, so the gate, the Settings button and the pills all
 * follow it — but KEEPS the tokens and the client registration: a re-login reuses
 * the registration, and nothing here refreshes (no loop).
 */
export function checkMcpOAuthToolset(
  store: McpOAuthStore,
  server: string,
  remoteToolNames: readonly string[],
  now: number = Date.now(),
): { reduced: boolean; missing: string[] } {
  const required = MCP_OAUTH_REQUIRED_TOOLS[server] ?? [];
  const have = new Set(remoteToolNames);
  const missing = required.filter((t) => !have.has(t));
  if (missing.length === 0) return { reduced: false, missing };
  const rec = readMcpOAuthRecord(store, server);
  if (rec && rec.state !== 'relogin') {
    writeMcpOAuthRecord(store, server, { ...rec, state: 'relogin', reloginReason: 'reduced-toolset', reloginAt: now });
  }
  return { reduced: true, missing };
}

function withExpiry(tokens: OAuthTokens, now: number): McpOAuthTokens {
  const expiresIn = typeof tokens.expires_in === 'number' && tokens.expires_in > 0 ? tokens.expires_in : undefined;
  return {
    ...tokens,
    obtained_at: now,
    ...(expiresIn !== undefined ? { expires_at: now + expiresIn * 1000 } : {}),
  };
}

function needsRefresh(tokens: McpOAuthTokens | undefined, now: number): boolean {
  if (!tokens?.refresh_token) return false;
  if (!tokens.access_token) return true;
  return tokens.expires_at !== undefined && tokens.expires_at - MCP_OAUTH_REFRESH_SKEW_MS <= now;
}

// ---------------------------------------------------------------------------
// Refresh — single-flight, persist-first, relogin-aware
// ---------------------------------------------------------------------------

export type McpOAuthFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type McpOAuthRefreshOutcome =
  | { ok: true; tokens: McpOAuthTokens; network: boolean }
  | { ok: false; relogin: true; error: string; status?: number; body?: string }
  | { ok: false; relogin: false; error: string; status?: number; body?: string };

/** In-flight refreshes, per store and server. A WeakMap so a spike's throwaway
 *  stores do not pin each other's promises. */
const inflightRefresh = new WeakMap<object, Map<string, Promise<McpOAuthRefreshOutcome>>>();

/** Counters a spike reads to prove "one refresh, not two". */
export const mcpOAuthRefreshStats = { networkRefreshes: 0, joined: 0, staleSkipped: 0 };

/**
 * Refresh the stored token set ONCE, however many callers ask at the same moment.
 *
 * `presentedRefreshToken` is the refresh token the caller believed was current.
 * When the store already holds a different one, a refresh that finished a moment
 * ago rotated it: the stored set is returned and NOTHING is sent — sending the
 * stale token to a rotating server is exactly how a double refresh logs the user
 * out (`refresh_token_reused`).
 */
export function refreshMcpOAuthTokens(
  store: McpOAuthStore,
  server: string,
  args: { fetch?: McpOAuthFetch; presentedRefreshToken?: string; tokenUrl?: string; now?: () => number },
): Promise<McpOAuthRefreshOutcome> {
  let perStore = inflightRefresh.get(store);
  if (!perStore) {
    perStore = new Map();
    inflightRefresh.set(store, perStore);
  }
  const running = perStore.get(server);
  if (running) {
    mcpOAuthRefreshStats.joined += 1;
    return running;
  }
  // Registered BEFORE the refresh starts running: a caller arriving while it is
  // still synchronous must join it, not start a second one.
  const p = Promise.resolve()
    .then(() => refreshOnce(store, server, args))
    .finally(() => perStore!.delete(server));
  perStore.set(server, p);
  return p;
}

async function refreshOnce(
  store: McpOAuthStore,
  server: string,
  args: { fetch?: McpOAuthFetch; presentedRefreshToken?: string; tokenUrl?: string; now?: () => number },
): Promise<McpOAuthRefreshOutcome> {
  const now = args.now ?? Date.now;
  const rec = readMcpOAuthRecord(store, server);
  const stored = rec?.tokens;
  if (!rec || rec.state === 'relogin' || !stored?.refresh_token) {
    return { ok: false, relogin: true, error: 'no refresh token stored — sign in again' };
  }
  if (args.presentedRefreshToken !== undefined && args.presentedRefreshToken !== stored.refresh_token) {
    // Already rotated by a refresh that finished first. Hand back the CURRENT set.
    mcpOAuthRefreshStats.staleSkipped += 1;
    return { ok: true, tokens: stored, network: false };
  }
  const tokenUrl =
    stored.token_endpoint ?? rec.asInfo?.tokenEndpoint ?? rec.client?.token_endpoint ?? args.tokenUrl;
  if (!tokenUrl) return { ok: false, relogin: false, error: 'no token endpoint on record' };
  const clientId = rec.client?.client_id;
  if (!clientId) return { ok: false, relogin: true, error: 'no registered client — sign in again' };

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: stored.refresh_token,
    client_id: clientId,
  });
  if (rec.client?.client_secret) body.set('client_secret', rec.client.client_secret);
  const fetchImpl = args.fetch ?? (globalThis.fetch as McpOAuthFetch);
  let res: Response;
  try {
    mcpOAuthRefreshStats.networkRefreshes += 1;
    res = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
  } catch (e) {
    // Offline is not a verdict on the sign-in.
    return { ok: false, relogin: false, error: `token endpoint unreachable: ${e instanceof Error ? e.message : String(e)}` };
  }
  const text = await res.text().catch(() => '');
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = {};
  }
  if (!res.ok || typeof json.error === 'string') {
    const code = typeof json.error === 'string' ? json.error : '';
    if (MCP_OAUTH_RELOGIN_ERRORS.includes(code)) {
      markRelogin(store, server, code, now());
      return { ok: false, relogin: true, error: code, status: res.status, body: text };
    }
    return { ok: false, relogin: false, error: code || `HTTP ${res.status}`, status: res.status, body: text };
  }
  if (typeof json.access_token !== 'string' || !json.access_token) {
    return { ok: false, relogin: false, error: 'refresh response has no access_token', status: res.status, body: text };
  }
  // ROTATION: a new refresh token wins; a response without one keeps the old.
  const next = withExpiry(
    {
      ...(json as OAuthTokens),
      refresh_token: typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : stored.refresh_token,
      ...(stored.token_endpoint ? { token_endpoint: stored.token_endpoint } : {}),
      ...(stored.authorization_server ? { authorization_server: stored.authorization_server } : {}),
    } as OAuthTokens,
    now(),
  );
  // PERSIST FIRST. Nothing has seen `next.access_token` yet.
  const fresh = readMcpOAuthRecord(store, server) ?? rec;
  writeMcpOAuthRecord(store, server, {
    ...fresh,
    tokens: next,
    state: 'ok',
    refreshedAt: now(),
    ...(fresh.reloginReason ? { reloginReason: undefined } : {}),
  });
  return { ok: true, tokens: next, network: true };
}

/** The tokens as a token-endpoint JSON body (what the library parses). */
function tokenResponseBody(tokens: McpOAuthTokens): string {
  const { obtained_at: _o, expires_at, ...rest } = tokens;
  const out: Record<string, unknown> = { ...rest };
  if (expires_at !== undefined) out.expires_in = Math.max(1, Math.floor((expires_at - Date.now()) / 1000));
  return JSON.stringify(out);
}

/**
 * The transport's `fetch`. Everything passes through untouched EXCEPT a refresh
 * POST to the token endpoint, which is routed through `refreshMcpOAuthTokens` so
 * the library's own 401-driven refresh is single-flight and persist-first too.
 */
export function makeMcpOAuthFetch(
  store: McpOAuthStore,
  server: string,
  baseFetch: McpOAuthFetch = globalThis.fetch as McpOAuthFetch,
  now: () => number = Date.now,
  opts: { allowRegistration?: boolean } = {},
): McpOAuthFetch {
  return async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const body = init?.body;
    // NO DYNAMIC REGISTRATION OUTSIDE A LOGIN. A connect inside a turn that lost its
    // registration (`invalid_client`) would otherwise register a new client with
    // the authorization server mid-turn; the user's next explicit login does it.
    if (
      opts.allowRegistration === false &&
      method === 'POST' &&
      typeof body === 'string' &&
      body.includes('"redirect_uris"')
    ) {
      return new Response(
        JSON.stringify({ error: 'invalid_client_metadata', error_description: 'registration happens at sign-in only' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (method === 'POST' && body instanceof URLSearchParams && body.get('grant_type') === 'refresh_token') {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const outcome = await refreshMcpOAuthTokens(store, server, {
        fetch: baseFetch,
        presentedRefreshToken: body.get('refresh_token') ?? undefined,
        tokenUrl: url,
        now,
      });
      if (outcome.ok) {
        return new Response(tokenResponseBody(outcome.tokens), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const errorBody =
        outcome.body && outcome.body.trim().startsWith('{')
          ? outcome.body
          : JSON.stringify({ error: outcome.relogin ? 'invalid_grant' : 'server_error', error_description: outcome.error });
      return new Response(errorBody, {
        status: outcome.status && outcome.status >= 400 ? outcome.status : outcome.relogin ? 400 : 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return baseFetch(input, init);
  };
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

export type McpOAuthProviderOptions = {
  /** `login` = an explicit, user-started sign-in: `redirectToAuthorization`
   *  hands the URL to `onAuthorizationUrl`. `turn` (default) = a connect inside a
   *  turn or a probe: no browser, ever — a needed authorization is recorded as
   *  "sign in again". */
  mode?: 'turn' | 'login';
  /** The loopback redirect for this login (login mode). */
  redirectUrl?: string;
  onAuthorizationUrl?: (url: URL) => void;
  fetch?: McpOAuthFetch;
  now?: () => number;
  clientName?: string;
};

const DEFAULT_REDIRECT = `http://${MCP_OAUTH_LOOPBACK_HOST}${MCP_OAUTH_CALLBACK_PATH}`;

/**
 * `OAuthClientProvider` over the store record. One instance per connect (turn
 * mode) or per login (login mode); every read goes back to the store, so two
 * instances for the same server never disagree about which token is current.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  private verifier = '';
  private oauthState: string | undefined;
  private readonly mode: 'turn' | 'login';
  private readonly now: () => number;

  constructor(
    private readonly store: McpOAuthStore,
    private readonly server: string,
    private readonly opts: McpOAuthProviderOptions = {},
  ) {
    this.mode = opts.mode ?? 'turn';
    this.now = opts.now ?? Date.now;
  }

  private rec(): McpOAuthRecord {
    return readMcpOAuthRecord(this.store, this.server) ?? blankRecord();
  }

  private write(rec: McpOAuthRecord): void {
    writeMcpOAuthRecord(this.store, this.server, rec);
  }

  get redirectUrl(): string {
    return this.opts.redirectUrl ?? this.rec().client?.redirect_uri ?? DEFAULT_REDIRECT;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.opts.clientName ?? 'naby',
      redirect_uris: [String(this.redirectUrl)],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // A public client (§3.8): PKCE carries the proof, there is no secret to keep.
      token_endpoint_auth_method: 'none',
    };
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const rec = this.rec();
    if (rec.state === 'relogin') return undefined;
    const t = rec.tokens;
    if (!t) return undefined;
    if (this.mode === 'turn' && needsRefresh(t, this.now())) {
      // Proactive refresh: the same single-flight path a 401 would take, so a
      // turn does not spend a round trip on a token we already know is stale.
      const outcome = await refreshMcpOAuthTokens(this.store, this.server, {
        presentedRefreshToken: t.refresh_token,
        ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
        now: this.now,
      });
      if (outcome.ok) return outcome.tokens;
      if (outcome.relogin) return undefined;
      return t; // transient: try the old token; a 401 lands in the library's path
    }
    return t;
  }

  saveTokens(tokens: OAuthTokens): void {
    const rec = this.rec();
    const now = this.now();
    // The library hands back what the token endpoint said. When that was our
    // intercepted refresh, the record already holds it (persisted first); writing
    // the same values again is harmless and keeps `obtained_at` honest.
    const prev = rec.tokens;
    const same = prev && prev.access_token === tokens.access_token && prev.refresh_token === tokens.refresh_token;
    this.write({
      ...rec,
      tokens: same ? prev : withExpiry(tokens, now),
      state: 'ok',
      ...(this.mode === 'login' && !same ? { loggedInAt: now } : {}),
      ...(rec.reloginReason ? { reloginReason: undefined, reloginAt: undefined } : {}),
    });
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    if (this.mode === 'login') {
      this.opts.onAuthorizationUrl?.(authorizationUrl);
      return;
    }
    // A connect inside a turn reached "the user must authorize". With tokens still
    // on record this was a TRANSIENT failure the library could not tell apart (a
    // 5xx on refresh falls through to here) — keep them for the next turn. With
    // none left, the sign-in is gone: say so, once, and never open a browser.
    const rec = this.rec();
    if (rec.tokens?.refresh_token || rec.tokens?.access_token) return;
    if (rec.state === 'relogin') return;
    // Only a sign-in that EXISTED can be lost; a server never signed in stays 'none'.
    if (rec.state === 'ok' || rec.loggedInAt !== undefined) {
      markRelogin(this.store, this.server, 'authorization-required', this.now());
    }
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error('no PKCE code verifier for this login');
    return this.verifier;
  }

  clientInformation(): (OAuthClientInformation & { redirect_uri?: string }) | undefined {
    const c = this.rec().client;
    if (!c) return undefined;
    // A registration is bound to its redirect URI. A login that had to take a
    // different loopback port registers again rather than presenting a redirect
    // the server never saw.
    if (this.mode === 'login' && c.redirect_uri && c.redirect_uri !== this.redirectUrl) return undefined;
    return c;
  }

  saveClientInformation(info: OAuthClientInformation): void {
    const rec = this.rec();
    this.write({ ...rec, client: { ...info, redirect_uri: String(this.redirectUrl) } });
  }

  authorizationServerInformation(): { authorizationServerUrl: string; tokenEndpoint: string } | undefined {
    return this.rec().asInfo;
  }

  saveAuthorizationServerInformation(info: { authorizationServerUrl: string; tokenEndpoint: string }): void {
    const rec = this.rec();
    this.write({ ...rec, asInfo: { authorizationServerUrl: info.authorizationServerUrl, tokenEndpoint: info.tokenEndpoint } });
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier'): void {
    if (scope === 'verifier') {
      this.verifier = '';
      return;
    }
    const rec = this.rec();
    const next: McpOAuthRecord = { ...rec };
    if (scope === 'all' || scope === 'client') {
      delete next.client;
      delete next.asInfo;
    }
    if (scope === 'all' || scope === 'tokens') {
      delete next.tokens;
      if (this.mode === 'turn' && rec.state === 'ok') {
        next.state = 'relogin';
        next.reloginReason = scope === 'all' ? 'invalid_client' : 'invalid_grant';
        next.reloginAt = this.now();
      }
    }
    this.write(next);
  }

  state(): string {
    this.oauthState = randomBytes(24).toString('base64url');
    return this.oauthState;
  }

  saveState(state: string): void {
    this.oauthState = state;
  }

  storedState(): string | undefined {
    return this.oauthState;
  }
}

/** Raised by the connect fast-path: the entry needs a sign-in it does not have. */
export class McpOAuthRequiredError extends Error {
  constructor(
    readonly server: string,
    readonly status: McpOAuthStatus,
  ) {
    super(
      status === 'relogin'
        ? `"${server}" needs you to sign in again (Settings → Harness → Org harness, or the System MCP row).`
        : `"${server}" is not signed in yet (Settings → Harness → Org harness, or the System MCP row).`,
    );
    this.name = 'McpOAuthRequiredError';
  }
}

/** What `loadMcpToolset` needs to connect an OAuth entry. The shell passes the
 *  store; a spike may also pass a fake fetch. */
export type McpOAuthConnectContext = {
  store: McpOAuthStore;
  fetch?: McpOAuthFetch;
  now?: () => number;
};

/** The transport pieces for one OAuth entry, in turn mode. Throws
 *  `McpOAuthRequiredError` (no network at all) when there is nothing to send. */
export function mcpOAuthTransportAuth(
  server: string,
  ctx: McpOAuthConnectContext,
): { authProvider: OAuthClientProvider; fetch: McpOAuthFetch } {
  const status = mcpOAuthStatus(ctx.store, server);
  if (status !== 'connected') throw new McpOAuthRequiredError(server, status);
  const fetch = makeMcpOAuthFetch(ctx.store, server, ctx.fetch, ctx.now, { allowRegistration: false });
  return {
    authProvider: new McpOAuthProvider(ctx.store, server, {
      mode: 'turn',
      // The BASE fetch for the provider's own proactive refresh: the wrapped one
      // would route that refresh back through the interception below.
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
      ...(ctx.now ? { now: ctx.now } : {}),
    }),
    fetch,
  };
}

// ---------------------------------------------------------------------------
// The interactive login (§3.8 steps 1–3)
// ---------------------------------------------------------------------------

export type McpOAuthLoginResult = { ok: true } | { ok: false; error: string };

export type McpOAuthLogin = {
  /** Open this in the system browser (the shell's job). */
  authorizationUrl: string;
  redirectUrl: string;
  /** Settles when the callback arrives, the login fails, times out or is cancelled. */
  done: Promise<McpOAuthLoginResult>;
  cancel(): void;
};

function listenLoopback(server: Server, port: number): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      const addr = server.address();
      resolvePort(typeof addr === 'object' && addr ? addr.port : port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, MCP_OAUTH_LOOPBACK_HOST);
  });
}

function htmlPage(title: string, body: string): string {
  const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head>` +
    `<body style="font-family:system-ui;margin:3rem"><h2>${esc(title)}</h2><p>${esc(body)}</p></body></html>`
  );
}

/**
 * Start a browser sign-in for one OAuth MCP server.
 *
 * Binds a loopback listener (the port of the stored registration when it is
 * free, otherwise any port — and then the client registers again for the new
 * redirect), runs the library's `auth()` up to its redirect, and returns the
 * authorization URL for the shell to open. `done` settles after the code
 * exchange; the tokens are in the store by then.
 *
 * A login ALWAYS asks the browser: stored tokens are dropped first, so "sign in
 * again" means exactly that even while the old refresh token still works.
 */
export async function startMcpOAuthLogin(args: {
  store: McpOAuthStore;
  server: string;
  serverUrl: string;
  fetch?: McpOAuthFetch;
  timeoutMs?: number;
  /** Force a port (spikes). Default: the stored registration's, else ephemeral. */
  port?: number;
  now?: () => number;
}): Promise<McpOAuthLogin> {
  const now = args.now ?? Date.now;
  const rec = readMcpOAuthRecord(args.store, args.server) ?? blankRecord();
  // Drop the tokens (keep the registration) so the flow reaches the browser. They
  // are held here and put back if this login does not complete, so a cancelled
  // "sign in again" never costs a sign-in that still worked.
  const { tokens: stashed, ...kept } = rec;
  writeMcpOAuthRecord(args.store, args.server, { ...kept, state: rec.state === 'relogin' ? 'relogin' : 'none' });
  const restore = (): void => {
    if (!stashed) return;
    const cur = readMcpOAuthRecord(args.store, args.server);
    // The WHOLE previous record — tokens AND the registration they were issued to
    // (a login on a different port registers a new client, and the old tokens
    // only refresh under the old one).
    if (cur && !cur.tokens) writeMcpOAuthRecord(args.store, args.server, rec);
  };

  const http = createServer();
  let preferred = args.port ?? 0;
  if (args.port === undefined && rec.client?.redirect_uri) {
    try {
      const p = Number(new URL(rec.client.redirect_uri).port);
      if (Number.isInteger(p) && p > 0) preferred = p;
    } catch {
      /* ephemeral */
    }
  }
  // The registered port first — a registration is bound to its redirect, so a
  // free port means no new registration. A previous login's listener may still be
  // closing, so a busy port is retried briefly before falling back to any port
  // (which then registers again).
  let port = -1;
  if (preferred !== 0) {
    for (let attempt = 0; attempt < 5 && port < 0; attempt += 1) {
      try {
        port = await listenLoopback(http, preferred);
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }
  if (port < 0) {
    try {
      port = await listenLoopback(http, 0);
    } catch (e) {
      restore();
      throw e;
    }
  }
  const redirectUrl = `http://${MCP_OAUTH_LOOPBACK_HOST}:${port}${MCP_OAUTH_CALLBACK_PATH}`;
  const fetch = makeMcpOAuthFetch(args.store, args.server, args.fetch, now);

  let authorizationUrl: string | undefined;
  const provider = new McpOAuthProvider(args.store, args.server, {
    mode: 'login',
    redirectUrl,
    ...(args.fetch ? { fetch: args.fetch } : {}),
    now,
    onAuthorizationUrl: (u) => {
      authorizationUrl = u.href;
    },
  });

  const close = (): void => {
    try {
      http.closeAllConnections?.();
      http.close();
    } catch {
      /* already closed */
    }
  };

  let first: string;
  try {
    first = await auth(provider, { serverUrl: args.serverUrl, fetchFn: fetch });
  } catch (e) {
    close();
    restore();
    throw e;
  }
  if (first === 'AUTHORIZED') {
    // Nothing to ask the browser (cannot normally happen: tokens were dropped).
    close();
    return {
      authorizationUrl: '',
      redirectUrl,
      done: Promise.resolve({ ok: true }),
      cancel: () => {},
    };
  }
  if (!authorizationUrl) {
    close();
    restore();
    throw new Error('the authorization server returned no authorization URL');
  }

  let settle!: (r: McpOAuthLoginResult) => void;
  const done = new Promise<McpOAuthLoginResult>((resolve) => {
    settle = resolve;
  });
  let settled = false;
  const finish = (r: McpOAuthLoginResult): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    // Let the browser's response flush before the listener goes away.
    setTimeout(close, 50).unref?.();
    if (!r.ok) restore();
    settle(r);
  };
  const timer = setTimeout(
    () => finish({ ok: false, error: 'timed out waiting for the browser sign-in' }),
    args.timeoutMs ?? MCP_OAUTH_LOGIN_TIMEOUT_MS,
  );
  timer.unref?.();

  http.on('request', (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', redirectUrl);
      if (url.pathname !== MCP_OAUTH_CALLBACK_PATH) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state') ?? undefined;
      if (error || !code) {
        const msg = error ? `${error}${url.searchParams.get('error_description') ? `: ${url.searchParams.get('error_description')}` : ''}` : 'no authorization code';
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(htmlPage('Sign-in failed', msg));
        finish({ ok: false, error: msg });
        return;
      }
      try {
        const r = await auth(provider, {
          serverUrl: args.serverUrl,
          authorizationCode: code,
          ...(state !== undefined ? { callbackState: state } : {}),
          fetchFn: fetch,
        });
        if (r !== 'AUTHORIZED') throw new Error(`unexpected authorization result ${r}`);
        res
          .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
          .end(htmlPage('Signed in', 'naby is connected. You can close this tab and go back to naby.'));
        finish({ ok: true });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(htmlPage('Sign-in failed', msg));
        finish({ ok: false, error: msg });
      }
    })();
  });

  return {
    authorizationUrl,
    redirectUrl,
    done,
    cancel: () => finish({ ok: false, error: 'cancelled' }),
  };
}
