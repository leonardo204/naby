// src/runtime/mcp-oauth-probe.ts
//
// "DOES THIS REMOTE MCP SIGN IN THROUGH THE BROWSER?" — the URL check the general
// MCP form runs on save (specs/mcp-oauth-catalog.md §3.2).
//
// WHAT IT DOES. One unauthenticated request to the MCP URL — `initialize` POSTed
// for `http`, the event stream opened with GET for `sse` — and, on a 401, the
// OAuth metadata discovery a login would run. Four verdicts:
//
//   open             2xx: no sign-in needed; save the row as it is
//   oauth            401, and the authorization server publishes a registration
//                    endpoint: a browser login (dynamic registration + PKCE) works
//   no-registration  401, and no registration endpoint (or no metadata at all):
//                    the user has to put a token in a header
//   unreachable      a network failure, the 10 s budget ran out, any other status,
//                    or metadata the login itself would reject
//
// NOTHING IS STORED and no client is registered: the probe only reads.
//
// DISCOVERY MIRRORS `@ai-sdk/mcp` 2.0.15, ON PURPOSE. The library does not export
// its discovery functions, so the order is re-stated here from its source
// (`authInternal` → `discoverOAuthProtectedResourceMetadata` →
// `discoverAuthorizationServerMetadata`) — the point being that the probe and
// the login (`startMcpOAuthLogin`, which calls the library's `auth()`) never
// reach different conclusions about the same server:
//
//   1. protected-resource metadata — the 401's `resource_metadata` when it named
//      one (and then ONLY that URL, like the library); otherwise the path-specific
//      `/.well-known/oauth-protected-resource<path>`, then the root one on a 4xx
//   2. the authorization server is the metadata's first `authorization_servers`
//      entry, else the MCP URL itself
//   3. authorization-server metadata — `oauth-authorization-server` (path-specific,
//      then root), then `openid-configuration` (path-specific both ways), each
//      with the library's issuer check
//
// The `resourceMetadataUrl` a probe found is handed back so the shell can pass it
// to the login (`startMcpOAuthLogin`'s option of the same name), which hands it
// to `auth()` exactly as the transport does after a 401. `spike-mcp-oauth-catalog`
// pins the agreement against fake servers shaped like Notion and Sentry.

import type { McpOAuthFetch } from './mcp-oauth.js';

/** How long the whole probe may take (§3.2: "no answer in 10 s = cannot tell"). */
export const MCP_OAUTH_PROBE_TIMEOUT_MS = 10_000;

/** The MCP protocol version `@ai-sdk/mcp` 2.0.15 sends (its LATEST_PROTOCOL_VERSION). */
const PROBE_PROTOCOL_VERSION = '2025-11-25';

export type McpOAuthProbeVerdict = 'open' | 'oauth' | 'no-registration' | 'unreachable';

export type McpOAuthProbeResult = {
  verdict: McpOAuthProbeVerdict;
  /** HTTP status of the unauthenticated MCP request, when there was one. */
  status?: number;
  /** English, for `unreachable` (and a reason for `no-registration`). */
  error?: string;
  /** The 401's `resource_metadata`, when the server named one — pass it to the
   *  login so discovery starts where the probe's did. */
  resourceMetadataUrl?: string;
  /** Where the authorization-server metadata was looked up. */
  authorizationServerUrl?: string;
  registrationEndpoint?: string;
};

type Json = Record<string, unknown>;

function isHttpUrl(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** The library's `extractResourceMetadataUrl`: a Bearer challenge's
 *  `resource_metadata="…"`, or undefined. */
export function extractResourceMetadataUrl(res: Response): URL | undefined {
  const header = res.headers.get('www-authenticate');
  if (!header) return undefined;
  const [type, scheme] = header.split(' ');
  if (type?.toLowerCase() !== 'bearer' || !scheme) return undefined;
  const match = header.match(/resource_metadata="([^"]*)"/);
  if (!match) return undefined;
  try {
    return new URL(match[1]!);
  } catch {
    return undefined;
  }
}

function wellKnownPath(prefix: string, pathname: string): string {
  const p = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return `/.well-known/${prefix}${p}`;
}

/** One metadata GET. A network failure is `undefined` (the library's
 *  `fetchWithCorsRetry` outcome for a TypeError); an abort propagates. */
async function getMetadata(fetchImpl: McpOAuthFetch, url: URL, signal: AbortSignal): Promise<Response | undefined> {
  try {
    return await fetchImpl(url, { headers: { 'MCP-Protocol-Version': PROBE_PROTOCOL_VERSION }, signal });
  } catch (e) {
    if (signal.aborted) throw e;
    return undefined;
  }
}

/** Step 1 — `discoverOAuthProtectedResourceMetadata`. Undefined where the library
 *  would throw (it swallows that and falls back to the MCP URL). */
async function discoverProtectedResource(
  fetchImpl: McpOAuthFetch,
  serverUrl: URL,
  resourceMetadataUrl: URL | undefined,
  signal: AbortSignal,
): Promise<Json | undefined> {
  let res: Response | undefined;
  if (resourceMetadataUrl) {
    res = await getMetadata(fetchImpl, resourceMetadataUrl, signal);
  } else {
    const url = new URL(wellKnownPath('oauth-protected-resource', serverUrl.pathname), serverUrl);
    url.search = serverUrl.search;
    res = await getMetadata(fetchImpl, url, signal);
    const fallBack = !res || (res.status >= 400 && res.status < 500 && serverUrl.pathname !== '/');
    if (fallBack) {
      await res?.body?.cancel().catch(() => undefined);
      res = await getMetadata(fetchImpl, new URL('/.well-known/oauth-protected-resource', serverUrl), signal);
    }
  }
  if (!res || !res.ok) {
    await res?.body?.cancel().catch(() => undefined);
    return undefined;
  }
  const json = (await res.json().catch(() => undefined)) as Json | undefined;
  // The library's schema: `resource` is a URL; `authorization_servers` URLs.
  if (!json || typeof json !== 'object' || typeof json.resource !== 'string' || !URL.canParse(json.resource)) {
    return undefined;
  }
  return json;
}

/** The library's `checkResourceAllowed`. */
function resourceAllowed(requested: URL, configured: string): boolean {
  const c = new URL(configured);
  if (requested.origin !== c.origin) return false;
  if (requested.pathname.length < c.pathname.length) return false;
  const rp = requested.pathname.endsWith('/') ? requested.pathname : `${requested.pathname}/`;
  const cp = c.pathname.endsWith('/') ? c.pathname : `${c.pathname}/`;
  return rp.startsWith(cp);
}

/** Step 3 — `discoverAuthorizationServerMetadata` with `buildDiscoveryUrls`. */
async function discoverAuthorizationServer(
  fetchImpl: McpOAuthFetch,
  asUrl: URL,
  signal: AbortSignal,
): Promise<Json | undefined> {
  const root = asUrl.origin;
  const tries: { url: URL; type: 'oauth' | 'oidc'; issuer: string }[] = [];
  if (asUrl.pathname === '/') {
    tries.push({ url: new URL('/.well-known/oauth-authorization-server', root), type: 'oauth', issuer: root });
    tries.push({ url: new URL('/.well-known/openid-configuration', root), type: 'oidc', issuer: root });
  } else {
    const p = asUrl.pathname.endsWith('/') ? asUrl.pathname.slice(0, -1) : asUrl.pathname;
    const pathIssuer = `${root}${p}`;
    tries.push({ url: new URL(`/.well-known/oauth-authorization-server${p}`, root), type: 'oauth', issuer: pathIssuer });
    tries.push({ url: new URL('/.well-known/oauth-authorization-server', root), type: 'oauth', issuer: root });
    tries.push({ url: new URL(`/.well-known/openid-configuration${p}`, root), type: 'oidc', issuer: pathIssuer });
    tries.push({ url: new URL(`${p}/.well-known/openid-configuration`, root), type: 'oidc', issuer: pathIssuer });
  }
  for (const t of tries) {
    const res = await getMetadata(fetchImpl, t.url, signal);
    if (!res) continue;
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      if (res.status >= 400 && res.status < 500) continue;
      throw new Error(`HTTP ${res.status} loading ${t.type === 'oauth' ? 'OAuth' : 'OpenID provider'} metadata from ${t.url.href}`);
    }
    const json = (await res.json().catch(() => undefined)) as Json | undefined;
    // The library's zod schemas (`OAuthMetadataSchema`, and for OIDC
    // `OpenIdProviderMetadataSchema`): what they require, this requires.
    const malformed =
      !json ||
      typeof json.issuer !== 'string' ||
      !isHttpUrl(json.authorization_endpoint) ||
      !isHttpUrl(json.token_endpoint) ||
      !Array.isArray(json.response_types_supported) ||
      (t.type === 'oidc' &&
        (!isHttpUrl(json.jwks_uri) ||
          !Array.isArray(json.subject_types_supported) ||
          !Array.isArray(json.id_token_signing_alg_values_supported)));
    if (malformed || !json) {
      throw new Error(`malformed authorization server metadata at ${t.url.href}`);
    }
    if (json.issuer !== t.issuer) {
      throw new Error(`authorization server metadata issuer ${json.issuer} does not match expected issuer ${t.issuer}`);
    }
    if (t.type === 'oidc') {
      const methods = json.code_challenge_methods_supported;
      if (!Array.isArray(methods) || !methods.includes('S256')) {
        throw new Error(`OpenID provider at ${t.url.href} does not support S256`);
      }
    }
    return json;
  }
  return undefined;
}

/**
 * Probe one remote MCP URL without credentials. Never throws.
 *
 * `fetch` is injectable (spikes, tests); every request carries one abort signal
 * bounded by `timeoutMs`, so a server that never answers is "cannot tell" after
 * the budget, not a hung Settings form.
 */
export async function probeMcpOAuth(args: {
  url: string;
  transport: 'http' | 'sse';
  fetch?: McpOAuthFetch;
  timeoutMs?: number;
}): Promise<McpOAuthProbeResult> {
  let serverUrl: URL;
  try {
    serverUrl = new URL(args.url);
    if (serverUrl.protocol !== 'http:' && serverUrl.protocol !== 'https:') throw new Error('not http(s)');
  } catch {
    return { verdict: 'unreachable', error: `not an http(s) URL: ${args.url}` };
  }
  const fetchImpl = args.fetch ?? (globalThis.fetch as McpOAuthFetch);
  const ctl = new AbortController();
  const timeoutMs = args.timeoutMs ?? MCP_OAUTH_PROBE_TIMEOUT_MS;
  const timer = setTimeout(() => ctl.abort(new Error(`no answer within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  timer.unref?.();
  try {
    let res: Response;
    try {
      res =
        args.transport === 'sse'
          ? await fetchImpl(serverUrl, { method: 'GET', headers: { Accept: 'text/event-stream' }, signal: ctl.signal })
          : await fetchImpl(serverUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/event-stream',
              },
              body: JSON.stringify({
                jsonrpc: '2.0',
                id: 0,
                method: 'initialize',
                params: {
                  protocolVersion: PROBE_PROTOCOL_VERSION,
                  capabilities: {},
                  clientInfo: { name: 'naby', version: 'probe' },
                },
              }),
              signal: ctl.signal,
            });
    } catch (e) {
      const reason = ctl.signal.aborted ? ctl.signal.reason : e;
      return { verdict: 'unreachable', error: reason instanceof Error ? reason.message : String(reason) };
    }
    // Never read a body we do not need: an SSE stream would never end.
    await res.body?.cancel().catch(() => undefined);
    if (res.status >= 200 && res.status < 300) return { verdict: 'open', status: res.status };
    if (res.status !== 401) {
      return { verdict: 'unreachable', status: res.status, error: `HTTP ${res.status}` };
    }

    const named = extractResourceMetadataUrl(res);
    if (named && named.origin !== serverUrl.origin) {
      // The library refuses this before any discovery, at login and on every
      // 401-driven re-auth, so a login could never succeed.
      return {
        verdict: 'unreachable',
        status: 401,
        resourceMetadataUrl: named.href,
        error: `the server's resource metadata ${named.href} is not on ${serverUrl.origin}`,
      };
    }
    const prm = await discoverProtectedResource(fetchImpl, serverUrl, named, ctl.signal);
    const servers = prm?.authorization_servers;
    const first = Array.isArray(servers) ? servers.find((s) => isHttpUrl(s)) : undefined;
    const asUrl = new URL(typeof first === 'string' ? first : serverUrl.href);
    if (prm && !resourceAllowed(serverUrl, prm.resource as string)) {
      return {
        verdict: 'unreachable',
        status: 401,
        ...(named ? { resourceMetadataUrl: named.href } : {}),
        error: `protected resource ${String(prm.resource)} does not match ${serverUrl.href}`,
      };
    }
    let meta: Json | undefined;
    try {
      meta = await discoverAuthorizationServer(fetchImpl, asUrl, ctl.signal);
    } catch (e) {
      const reason = ctl.signal.aborted ? ctl.signal.reason : e;
      return {
        verdict: 'unreachable',
        status: 401,
        ...(named ? { resourceMetadataUrl: named.href } : {}),
        authorizationServerUrl: asUrl.href,
        error: reason instanceof Error ? reason.message : String(reason),
      };
    }
    const base = {
      status: 401,
      ...(named ? { resourceMetadataUrl: named.href } : {}),
      authorizationServerUrl: asUrl.href,
    };
    if (meta && isHttpUrl(meta.registration_endpoint)) {
      return { verdict: 'oauth', ...base, registrationEndpoint: meta.registration_endpoint };
    }
    return {
      verdict: 'no-registration',
      ...base,
      error: meta ? 'the authorization server has no registration endpoint' : 'no OAuth metadata was found',
    };
  } catch (e) {
    const reason = ctl.signal.aborted ? ctl.signal.reason : e;
    return { verdict: 'unreachable', error: reason instanceof Error ? reason.message : String(reason) };
  } finally {
    clearTimeout(timer);
  }
}
