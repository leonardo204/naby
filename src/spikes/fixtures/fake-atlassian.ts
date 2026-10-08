// src/spikes/fixtures/fake-atlassian.ts
//
// A LOCAL STAND-IN FOR ATLASSIAN'S REMOTE MCP AND ITS OAUTH SERVER
// (org-harness-sync §3.8, M3). Used by `spike:mcp-oauth`, `spike:org-harness-gate`
// and the shell's vitest — never by the app.
//
// It answers DISCOVERY the way the live server did on 2026-10-08:
//   /.well-known/oauth-protected-resource          404
//   /.well-known/oauth-authorization-server/v1/mcp 404
//   /.well-known/oauth-authorization-server        200, issuer = the origin
//   401 from /v1/mcp: `WWW-Authenticate: Bearer realm="OAuth", error="invalid_token"`
//                     with NO resource_metadata
// so a client that only works with protected-resource metadata fails here too.
//
// OAUTH: dynamic registration (public client, `token_endpoint_auth_method: none`),
// an authorize endpoint that "consents" at once by redirecting to the loopback
// callback, PKCE S256 checked on the code exchange, and ROTATING refresh tokens —
// a spent refresh token is `invalid_grant`, which is exactly what a double refresh
// trips on the real thing.
//
// MCP: streamable HTTP with plain JSON responses — initialize, tools/list,
// tools/call — behind the bearer token.

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export type FakeAtlassianOptions = {
  /** Access-token lifetime in seconds (default 3600). */
  expiresIn?: number;
  /** Called on every MCP request that carried a VALID access token. */
  onAuthorizedMcp?: (accessToken: string) => void;
  /** Delay every refresh by this many ms (to make concurrency observable). */
  refreshDelayMs?: number;
};

/** What the live server answered a bogus bearer with (2026-10-08): 200, and only
 *  these public tools — no Confluence or Jira. */
export const REDUCED_TOOL_NAMES = [
  'getContentFormatGuide',
  'getTeamworkGraphContext',
  'getTeamworkGraphObject',
  'addTeamworkGraphContext',
];

export type FakeAtlassian = {
  origin: string;
  mcpUrl: string;
  /** Counters. */
  stats: {
    registrations: number;
    authorizations: number;
    codeExchanges: number;
    refreshes: number;
    refreshReuse: number;
    mcpRequests: number;
    mcp401: number;
  };
  /** Next refresh answers with this OAuth error (once), e.g. `invalid_grant`. */
  failNextRefresh(error: string, status?: number): void;
  /** Revoke the current access token (the next MCP call is a 401 — or, with
   *  `invalidTokenGetsReducedSet`, a 200 with the reduced tool set). */
  revokeAccess(): void;
  /** Answer a present-but-invalid bearer the way the live server does: 200 and
   *  the reduced tool set, not 401. A missing header is still 401. */
  invalidTokenGetsReducedSet(on: boolean): void;
  /** The tokens currently valid. */
  current(): { access?: string; refresh?: string };
  /** The redirect_uris the last registration sent. */
  lastRegistration(): Record<string, unknown> | undefined;
  /** Simulate the browser: follow an authorization URL to the loopback callback. */
  consent(authorizationUrl: string): Promise<{ status: number; body: string }>;
  close(): Promise<void>;
};

const REDUCED_TOOLS = REDUCED_TOOL_NAMES.map((name) => ({
  name,
  description: `${name} (public)`,
  inputSchema: { type: 'object', properties: {} },
}));

const TOOLS = [
  { name: 'getConfluencePage', description: 'Get a Confluence page.', inputSchema: { type: 'object', properties: { pageId: { type: 'string' } } } },
  { name: 'searchConfluenceUsingCql', description: 'Search Confluence with CQL.', inputSchema: { type: 'object', properties: { cql: { type: 'string' } } } },
  { name: 'createConfluencePage', description: 'Create a Confluence page.', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(data));
  });
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

const token = (prefix: string): string => `${prefix}_${randomBytes(12).toString('hex')}`;

export async function startFakeAtlassian(opts: FakeAtlassianOptions = {}): Promise<FakeAtlassian> {
  const stats = {
    registrations: 0,
    authorizations: 0,
    codeExchanges: 0,
    refreshes: 0,
    refreshReuse: 0,
    mcpRequests: 0,
    mcp401: 0,
  };
  const clients = new Map<string, { redirect_uris: string[] }>();
  const codes = new Map<string, { clientId: string; challenge: string; redirectUri: string }>();
  let access: string | undefined;
  let refresh: string | undefined;
  const spentRefresh = new Set<string>();
  let failNext: { error: string; status: number } | undefined;
  let lastReg: Record<string, unknown> | undefined;
  let reducedForInvalid = false;
  let origin = '';

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', origin);
      const path = url.pathname;
      if (req.method === 'GET' && path.startsWith('/.well-known/oauth-protected-resource')) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not Found');
        return;
      }
      if (req.method === 'GET' && path === '/.well-known/oauth-authorization-server') {
        json(res, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/v1/authorize`,
          token_endpoint: `${origin}/v1/token`,
          registration_endpoint: `${origin}/v1/register`,
          response_types_supported: ['code'],
          response_modes_supported: ['query'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
          revocation_endpoint: `${origin}/v1/token`,
          code_challenge_methods_supported: ['plain', 'S256'],
        });
        return;
      }
      if (req.method === 'GET' && path.startsWith('/.well-known/')) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404 Not Found');
        return;
      }
      if (req.method === 'POST' && path === '/v1/register') {
        const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
        lastReg = body;
        stats.registrations += 1;
        if (body.token_endpoint_auth_method !== 'none') {
          json(res, 400, { error: 'invalid_client_metadata', error_description: 'public clients only in this fake' });
          return;
        }
        const id = token('client');
        clients.set(id, { redirect_uris: (body.redirect_uris as string[]) ?? [] });
        json(res, 201, { client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000), ...body });
        return;
      }
      if (req.method === 'GET' && path === '/v1/authorize') {
        stats.authorizations += 1;
        const clientId = url.searchParams.get('client_id') ?? '';
        const redirectUri = url.searchParams.get('redirect_uri') ?? '';
        const client = clients.get(clientId);
        if (!client || !client.redirect_uris.includes(redirectUri)) {
          res.writeHead(400, { 'Content-Type': 'text/plain' }).end('unknown client or redirect');
          return;
        }
        if (url.searchParams.get('code_challenge_method') !== 'S256') {
          res.writeHead(400, { 'Content-Type': 'text/plain' }).end('S256 required');
          return;
        }
        const code = token('code');
        codes.set(code, { clientId, challenge: url.searchParams.get('code_challenge') ?? '', redirectUri });
        const back = new URL(redirectUri);
        back.searchParams.set('code', code);
        const state = url.searchParams.get('state');
        if (state) back.searchParams.set('state', state);
        res.writeHead(302, { Location: back.href }).end();
        return;
      }
      if (req.method === 'POST' && path === '/v1/token') {
        const params = new URLSearchParams(await readBody(req));
        const grant = params.get('grant_type');
        if (grant === 'authorization_code') {
          stats.codeExchanges += 1;
          const code = codes.get(params.get('code') ?? '');
          const verifier = params.get('code_verifier') ?? '';
          const challenge = createHash('sha256').update(verifier).digest('base64url');
          if (!code || code.challenge !== challenge || code.clientId !== params.get('client_id')) {
            json(res, 400, { error: 'invalid_grant', error_description: 'bad code or PKCE verifier' });
            return;
          }
          codes.delete(params.get('code') ?? '');
          access = token('at');
          refresh = token('rt');
          json(res, 200, {
            access_token: access,
            token_type: 'Bearer',
            expires_in: opts.expiresIn ?? 3600,
            refresh_token: refresh,
          });
          return;
        }
        if (grant === 'refresh_token') {
          stats.refreshes += 1;
          if (opts.refreshDelayMs) await new Promise((r) => setTimeout(r, opts.refreshDelayMs));
          if (failNext) {
            const f = failNext;
            failNext = undefined;
            json(res, f.status, { error: f.error, error_description: 'forced by the fake' });
            return;
          }
          const presented = params.get('refresh_token') ?? '';
          if (spentRefresh.has(presented)) {
            stats.refreshReuse += 1;
            json(res, 400, { error: 'invalid_grant', error_description: 'refresh token reused' });
            return;
          }
          if (presented !== refresh) {
            json(res, 400, { error: 'invalid_grant', error_description: 'unknown refresh token' });
            return;
          }
          spentRefresh.add(presented);
          access = token('at');
          refresh = token('rt');
          json(res, 200, {
            access_token: access,
            token_type: 'Bearer',
            expires_in: opts.expiresIn ?? 3600,
            refresh_token: refresh,
          });
          return;
        }
        json(res, 400, { error: 'unsupported_grant_type' });
        return;
      }
      if (path === '/v1/mcp') {
        stats.mcpRequests += 1;
        const auth = req.headers.authorization ?? '';
        const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
        const reduced = reducedForInvalid && !!presented && presented !== access;
        if (!reduced && (!presented || presented !== access)) {
          stats.mcp401 += 1;
          res.writeHead(401, {
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer realm="OAuth", error="invalid_token"',
          });
          res.end(JSON.stringify({ error: 'invalid_token' }));
          return;
        }
        if (!reduced) opts.onAuthorizedMcp?.(presented);
        if (req.method === 'DELETE') {
          res.writeHead(200).end();
          return;
        }
        if (req.method === 'GET') {
          res.writeHead(405).end();
          return;
        }
        const msg = JSON.parse((await readBody(req)) || '{}') as { id?: unknown; method?: string; params?: Record<string, unknown> };
        if (msg.id === undefined) {
          res.writeHead(202).end();
          return;
        }
        if (msg.method === 'initialize') {
          json(
            res,
            200,
            {
              jsonrpc: '2.0',
              id: msg.id,
              result: {
                protocolVersion: (msg.params?.protocolVersion as string) ?? '2025-06-18',
                capabilities: { tools: {} },
                serverInfo: { name: 'fake-atlassian', version: '1.0.0' },
              },
            },
            { 'mcp-session-id': 'fake-session' },
          );
          return;
        }
        if (msg.method === 'tools/list') {
          json(res, 200, { jsonrpc: '2.0', id: msg.id, result: { tools: reduced ? REDUCED_TOOLS : TOOLS } });
          return;
        }
        if (msg.method === 'tools/call') {
          json(res, 200, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'ok' }] } });
          return;
        }
        json(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
        return;
      }
      res.writeHead(404).end();
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    mcpUrl: `${origin}/v1/mcp`,
    stats,
    failNextRefresh(error, status = 400) {
      failNext = { error, status };
    },
    revokeAccess() {
      access = token('revoked');
    },
    invalidTokenGetsReducedSet(on) {
      reducedForInvalid = on;
    },
    current() {
      return { ...(access ? { access } : {}), ...(refresh ? { refresh } : {}) };
    },
    lastRegistration() {
      return lastReg;
    },
    async consent(authorizationUrl) {
      // The browser: GET the authorize URL, follow the one redirect to the
      // loopback callback, return what the callback page said.
      const first = await fetch(authorizationUrl, { redirect: 'manual' });
      const location = first.headers.get('location');
      if (!location) return { status: first.status, body: await first.text() };
      const back = await fetch(location);
      return { status: back.status, body: await back.text() };
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
