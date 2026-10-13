// src/spikes/spike-mcp-oauth-catalog.ts
//
// REMOTE MCP BROWSER LOGIN BEYOND ATLASSIAN (specs/mcp-oauth-catalog.md §5), against
// FAKE local auth + MCP servers in the discovery shapes the quick-connect servers
// use (fixtures/fake-oauth-mcp.ts):
//
//   Notion-shaped  root protected-resource metadata only; the 401 names none
//   Sentry-shaped  the 401 carries `resource_metadata`; path-specific metadata only
//   no-registration  authorization-server metadata without a registration endpoint
//
// NO NETWORK beyond 127.0.0.1, NO REAL HOME: a temp NABY_HOME + NABY_DB_PATH.
//
// WHAT IS ASSERTED:
//
//   probe       `probeMcpOAuth` verdicts: oauth (both shapes, http and sse),
//               no-registration, open (http and sse — the open stream does not
//               hang the probe), unreachable (closed port, a non-401 status, a
//               server that never answers within the budget); the probe sends no
//               token and registers no client
//   agreement   the probe's discovery and the login's discovery ask the same
//               protected-resource URL first (Sentry: the 401's resource_metadata,
//               never the root; Notion: path-specific, then root); a server the
//               probe calls no-registration also fails to log in
//   login       per shape: authorization URL, callback, tokens stored, connected
//   connect     `loadMcpToolset` lists `<server>__<tool>` through the stored token
//   refresh     an expired token is refreshed once, rotated, and persisted
//   relogin     `invalid_grant` → status relogin, the connect fails, no browser;
//               logging in again recovers
//
// Prints PASS/FAIL per assertion; exits non-zero on any FAIL.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMcpToolset } from '../runtime/mcp.js';
import {
  mcpOAuthStatus,
  readMcpOAuthRecord,
  startMcpOAuthLogin,
  writeMcpOAuthRecord,
  type McpOAuthFetch,
} from '../runtime/mcp-oauth.js';
import { probeMcpOAuth } from '../runtime/mcp-oauth-probe.js';
import { SqliteStore } from '../runtime/store/sqlite-store.js';
import type { McpEntry } from '../runtime/store/store.js';
import { startFakeOAuthMcp, type FakeOAuthMcp, type FakeOAuthMcpShape } from './fixtures/fake-oauth-mcp.js';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, evidence = ''): void {
  checks.push({ name, pass, evidence });
}

const SPIKE_ROOT = mkdtempSync(join(tmpdir(), 'naby-spike-mcp-oauth-catalog-'));
process.env.NABY_HOME = SPIKE_ROOT;
process.env.NABY_DB_PATH = join(SPIKE_ROOT, 'app.db');

let caseNo = 0;
function freshStore(): SqliteStore {
  caseNo += 1;
  const dir = join(SPIKE_ROOT, `case-${caseNo}`);
  mkdirSync(dir, { recursive: true });
  return new SqliteStore({ path: join(dir, 'app.db') });
}

/** Every request the client made, for "what did it ask" assertions. */
function countingFetch(): { fetch: McpOAuthFetch; calls: string[]; authHeaders: number } {
  const out = { calls: [] as string[], authHeaders: 0, fetch: undefined as unknown as McpOAuthFetch };
  out.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    out.calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${new URL(url).pathname}`);
    const h = new Headers(init?.headers);
    if (h.has('authorization')) out.authHeaders += 1;
    return fetch(input, init);
  };
  return out;
}

const TOOLS: Record<'notion' | 'sentry', string[]> = {
  notion: ['notion-search', 'notion-fetch'],
  sentry: ['find_issues', 'get_issue_details'],
};

// ---------------------------------------------------------------------------

async function probeVerdicts(): Promise<void> {
  const notion = await startFakeOAuthMcp({ shape: 'notion', tools: TOOLS.notion });
  const sentry = await startFakeOAuthMcp({ shape: 'sentry', tools: TOOLS.sentry });
  const atl = await startFakeOAuthMcp({ shape: 'atlassian' });
  const noReg = await startFakeOAuthMcp({ shape: 'notion', registration: false });
  const open = await startFakeOAuthMcp({ shape: 'notion', open: true });
  try {
    // Notion-shaped: path-specific 404 → root protected-resource → AS at the origin.
    const n = countingFetch();
    const pn = await probeMcpOAuth({ url: notion.mcpUrl, transport: 'http', fetch: n.fetch });
    record(
      'probe (Notion-shaped, http): oauth, via path-specific then ROOT protected-resource metadata',
      pn.verdict === 'oauth' &&
        pn.status === 401 &&
        pn.resourceMetadataUrl === undefined &&
        pn.registrationEndpoint === `${notion.origin}/v1/register` &&
        n.calls[0] === 'POST /mcp' &&
        n.calls[1] === 'GET /.well-known/oauth-protected-resource/mcp' &&
        n.calls[2] === 'GET /.well-known/oauth-protected-resource' &&
        n.calls[3] === 'GET /.well-known/oauth-authorization-server',
      JSON.stringify({ pn, calls: n.calls }),
    );
    record(
      'probe: no token sent, no client registered, nothing stored',
      n.authHeaders === 0 && notion.stats.registrations === 0 && notion.stats.authorizations === 0,
      JSON.stringify({ auth: n.authHeaders, regs: notion.stats.registrations }),
    );

    // Sentry-shaped: the 401's resource_metadata, and ONLY that.
    const s = countingFetch();
    const ps = await probeMcpOAuth({ url: sentry.mcpUrl, transport: 'http', fetch: s.fetch });
    record(
      'probe (Sentry-shaped, http): oauth, via the 401 resource_metadata (path-specific), never the root',
      ps.verdict === 'oauth' &&
        ps.resourceMetadataUrl === `${sentry.origin}/.well-known/oauth-protected-resource/mcp` &&
        s.calls[1] === 'GET /.well-known/oauth-protected-resource/mcp' &&
        !s.calls.includes('GET /.well-known/oauth-protected-resource') &&
        ps.authorizationServerUrl === `${sentry.origin}/`,
      JSON.stringify({ ps, calls: s.calls }),
    );
    const sse = countingFetch();
    const pss = await probeMcpOAuth({ url: sentry.mcpUrl, transport: 'sse', fetch: sse.fetch });
    record(
      'probe (Sentry-shaped, sse): the stream is opened with GET and the 401 reads the same',
      pss.verdict === 'oauth' && sse.calls[0] === 'GET /mcp' && pss.resourceMetadataUrl === ps.resourceMetadataUrl,
      JSON.stringify({ pss, calls: sse.calls }),
    );

    // Atlassian (no protected-resource metadata at all) still reads as oauth.
    const pa = await probeMcpOAuth({ url: atl.mcpUrl, transport: 'http' });
    record(
      'probe (Atlassian-shaped): no protected-resource metadata, root AS metadata → oauth',
      pa.verdict === 'oauth' && pa.authorizationServerUrl === atl.mcpUrl,
      JSON.stringify(pa),
    );

    // No registration endpoint.
    const pr = await probeMcpOAuth({ url: noReg.mcpUrl, transport: 'http' });
    record(
      'probe (no registration endpoint): no-registration — "put a token in a header"',
      pr.verdict === 'no-registration' && pr.status === 401 && /registration/.test(pr.error ?? ''),
      JSON.stringify(pr),
    );

    // Open server: http and sse (the open stream must not hang the probe).
    const po = await probeMcpOAuth({ url: open.mcpUrl, transport: 'http' });
    const t0 = Date.now();
    const pos = await probeMcpOAuth({ url: open.mcpUrl, transport: 'sse', timeoutMs: 3000 });
    record(
      'probe (no sign-in needed): 2xx → open, for http and for an sse stream that never ends',
      po.verdict === 'open' && pos.verdict === 'open' && Date.now() - t0 < 2000,
      JSON.stringify({ po, pos, ms: Date.now() - t0 }),
    );

    // Unreachable: a closed port, a non-401 status, and a server that never answers.
    const closed = await startFakeOAuthMcp({ shape: 'notion' });
    const closedUrl = closed.mcpUrl;
    await closed.close();
    const pc = await probeMcpOAuth({ url: closedUrl, transport: 'http' });
    const p404 = await probeMcpOAuth({ url: `${notion.origin}/not-mcp`, transport: 'http' });
    const silent: Server = createServer(() => {
      /* never answers */
    });
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
    const addr = silent.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const t1 = Date.now();
    const pt = await probeMcpOAuth({ url: `http://127.0.0.1:${port}/mcp`, transport: 'http', timeoutMs: 300 });
    const elapsed = Date.now() - t1;
    silent.closeAllConnections?.();
    await new Promise<void>((r) => silent.close(() => r()));
    record(
      'probe: connection refused, a 404 and a silent server are all "unreachable" (the timeout holds)',
      pc.verdict === 'unreachable' &&
        p404.verdict === 'unreachable' &&
        p404.status === 404 &&
        pt.verdict === 'unreachable' &&
        elapsed < 2000 &&
        /no answer/.test(pt.error ?? ''),
      JSON.stringify({ pc, p404, pt, elapsed }),
    );
    const bad = await probeMcpOAuth({ url: 'ftp://example.invalid/mcp', transport: 'http' });
    record('probe: a non-http URL is refused without any request', bad.verdict === 'unreachable', JSON.stringify(bad));

    // Agreement: the login asks the same protected-resource URL first.
    for (const [fake, probe, label] of [
      [notion, pn, 'Notion'],
      [sentry, ps, 'Sentry'],
    ] as const) {
      const store = freshStore();
      const before = fake.stats.wellKnown.length;
      const l = await startMcpOAuthLogin({
        store,
        server: label.toLowerCase(),
        serverUrl: fake.mcpUrl,
        ...(probe.resourceMetadataUrl ? { resourceMetadataUrl: probe.resourceMetadataUrl } : {}),
      });
      l.cancel();
      await l.done;
      const loginAsked = fake.stats.wellKnown.slice(before);
      const probeAsked = label === 'Sentry' ? s.calls : n.calls;
      const probePrm = probeAsked.filter((c) => c.includes('oauth-protected-resource')).map((c) => c.slice(4));
      const loginPrm = loginAsked.filter((c) => c.includes('oauth-protected-resource'));
      record(
        `agreement (${label}): the login reads the same protected-resource metadata as the probe`,
        JSON.stringify(probePrm) === JSON.stringify(loginPrm) && l.authorizationUrl.includes('/v1/authorize'),
        JSON.stringify({ probePrm, loginPrm }),
      );
      store.close();
    }
    {
      const store = freshStore();
      let err = '';
      try {
        const l = await startMcpOAuthLogin({ store, server: 'noreg', serverUrl: noReg.mcpUrl });
        l.cancel();
      } catch (e) {
        err = e instanceof Error ? e.message : String(e);
      }
      record(
        'agreement (no registration): the login fails too, and stores no sign-in',
        /registration/i.test(err) && mcpOAuthStatus(store, 'noreg') === 'none',
        err,
      );
      store.close();
    }
  } finally {
    await Promise.all([notion.close(), sentry.close(), atl.close(), noReg.close(), open.close()]);
  }
}

async function shapeLifecycle(shape: Extract<FakeOAuthMcpShape, 'notion' | 'sentry'>): Promise<void> {
  const fake: FakeOAuthMcp = await startFakeOAuthMcp({ shape, tools: TOOLS[shape] });
  const store = freshStore();
  const server = shape;
  const entry: McpEntry = { name: server, transport: 'http', url: fake.mcpUrl, auth: 'oauth', status: 'enabled' };
  const login = async (): Promise<void> => {
    const probe = await probeMcpOAuth({ url: fake.mcpUrl, transport: 'http' });
    const l = await startMcpOAuthLogin({
      store,
      server,
      serverUrl: fake.mcpUrl,
      ...(probe.resourceMetadataUrl ? { resourceMetadataUrl: probe.resourceMetadataUrl } : {}),
    });
    const back = await fake.consent(l.authorizationUrl);
    const r = await l.done;
    if (!r.ok) throw new Error(`login failed: ${r.error} (${back.status} ${back.body.slice(0, 120)})`);
  };
  try {
    await login();
    const rec = readMcpOAuthRecord(store, server);
    record(
      `${shape}: login stores tokens and a public-client registration; status connected`,
      mcpOAuthStatus(store, server) === 'connected' &&
        rec?.tokens?.access_token === fake.current().access &&
        typeof rec?.client?.client_id === 'string' &&
        fake.lastRegistration()?.token_endpoint_auth_method === 'none',
      JSON.stringify({ status: mcpOAuthStatus(store, server) }),
    );

    const load = await loadMcpToolset([entry], { oauth: { store } });
    record(
      `${shape}: connect lists ${server}__<tool> through the stored token`,
      load.failures.length === 0 &&
        load.toolSchemas.map((t) => t.name).sort().join(',') ===
          TOOLS[shape].map((t) => `${server}__${t}`).sort().join(','),
      JSON.stringify({ failures: load.failures, tools: load.toolSchemas.map((t) => t.name) }),
    );
    await load.closeAll();

    // Refresh: our clock says expired.
    let r0 = readMcpOAuthRecord(store, server)!;
    const oldRefresh = r0.tokens!.refresh_token!;
    writeMcpOAuthRecord(store, server, { ...r0, tokens: { ...r0.tokens!, expires_at: Date.now() - 1000 } });
    const refreshes = fake.stats.refreshes;
    const [a, b] = await Promise.all([
      loadMcpToolset([entry], { oauth: { store } }),
      loadMcpToolset([entry], { oauth: { store } }),
    ]);
    await a.closeAll();
    await b.closeAll();
    const after = readMcpOAuthRecord(store, server);
    record(
      `${shape}: an expired token is refreshed ONCE, rotated and persisted`,
      fake.stats.refreshes - refreshes === 1 &&
        fake.stats.refreshReuse === 0 &&
        a.failures.length === 0 &&
        b.failures.length === 0 &&
        after?.tokens?.refresh_token === fake.current().refresh &&
        after?.tokens?.refresh_token !== oldRefresh,
      JSON.stringify({ refreshes: fake.stats.refreshes - refreshes, a: a.failures, b: b.failures }),
    );

    // invalid_grant → relogin.
    r0 = readMcpOAuthRecord(store, server)!;
    writeMcpOAuthRecord(store, server, { ...r0, tokens: { ...r0.tokens!, expires_at: Date.now() - 1000 } });
    fake.failNextRefresh('invalid_grant', 400);
    fake.revokeAccess();
    const auths = fake.stats.authorizations;
    const dead = await loadMcpToolset([entry], { oauth: { store } });
    await dead.closeAll();
    record(
      `${shape}: invalid_grant → status relogin, tokens cleared, the connect fails, no browser`,
      mcpOAuthStatus(store, server) === 'relogin' &&
        !readMcpOAuthRecord(store, server)?.tokens &&
        dead.failures.length === 1 &&
        fake.stats.authorizations === auths,
      JSON.stringify({ status: mcpOAuthStatus(store, server), failures: dead.failures }),
    );
    const mcpBefore = fake.stats.mcpRequests;
    const again = await loadMcpToolset([entry], { oauth: { store } });
    record(
      `${shape}: after relogin the connect refuses offline, pointing at Settings → Connections`,
      again.failures.length === 1 &&
        /sign in again/.test(again.failures[0]!.message) &&
        /Connections/.test(again.failures[0]!.message) &&
        fake.stats.mcpRequests === mcpBefore,
      JSON.stringify(again.failures),
    );
    await login();
    const ok = await loadMcpToolset([entry], { oauth: { store } });
    await ok.closeAll();
    record(
      `${shape}: logging in again recovers`,
      mcpOAuthStatus(store, server) === 'connected' && ok.failures.length === 0 && ok.toolSchemas.length === TOOLS[shape].length,
      JSON.stringify(ok.failures),
    );
  } finally {
    await fake.close();
    store.close();
  }
}

async function main(): Promise<void> {
  try {
    await probeVerdicts();
    await shapeLifecycle('notion');
    await shapeLifecycle('sentry');
  } catch (e) {
    record('spike ran to completion', false, e instanceof Error ? (e.stack ?? e.message) : String(e));
  }
  let failed = 0;
  for (const ch of checks) {
    if (!ch.pass) failed += 1;
    console.log(`${ch.pass ? 'PASS' : 'FAIL'}  ${ch.name}${ch.evidence && !ch.pass ? `\n      ${ch.evidence}` : ''}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  try {
    rmSync(SPIKE_ROOT, { recursive: true, force: true });
  } catch {
    /* temp */
  }
  process.exit(failed === 0 ? 0 : 1);
}

void main();
