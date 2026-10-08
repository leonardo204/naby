// src/spikes/spike-mcp-oauth.ts
//
// ORG HARNESS M3 — Atlassian browser OAuth for MCP (specs/org-harness-sync.md
// §3.8), against a FAKE local auth + MCP server that answers discovery exactly as
// the live one did on 2026-10-08 (fixtures/fake-atlassian.ts).
//
// NO NETWORK beyond 127.0.0.1, NO REAL HOME: a temp NABY_HOME + NABY_DB_PATH.
//
// WHAT IS ASSERTED:
//
//   discovery   with NO protected-resource metadata (404) and NO resource_metadata
//               on the 401, `@ai-sdk/mcp` still finds the root authorization-server
//               metadata; dynamic registration is a public client
//               (`token_endpoint_auth_method: none`) with a 127.0.0.1 loopback
//               redirect; PKCE is S256 (the fake checks the verifier)
//   login       the authorization URL is handed out (never opened by the runtime);
//               the callback stores tokens; `mcpOAuthStatus` = connected; the
//               client registration is persisted and REUSED by the next login
//   connect     `loadMcpToolset` lists the remote tools as `atlassian__…` through
//               the stored token; a row with no sign-in fails fast with no network
//   persist     a refresh writes the ROTATED refresh token to the store BEFORE the
//               new access token is used (checked from inside the fake MCP server)
//   single      two concurrent connects with an expired token → ONE refresh; a
//               401-driven refresh through the library's own path is single-flight
//               too, and a late caller holding the spent token sends nothing
//   relogin     `invalid_grant` → tokens cleared, status `relogin`, the connect
//               fails cleanly, no browser, no retry loop (refresh count bounded);
//               a 5xx is NOT a relogin
//   reduced     a listing without getConfluencePage (what the live server serves a
//               dead token, with a 200) → status `relogin`, tokens and registration
//               KEPT, no refresh / registration / browser, the next connect refuses
//               offline, a new login reuses the registration and recovers
//   cancel      a cancelled re-login gives the old working tokens back
//
// Prints PASS/FAIL per assertion; exits non-zero on any FAIL.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMcpToolset } from '../runtime/mcp.js';
import {
  mcpOAuthRefreshStats,
  mcpOAuthStatus,
  readMcpOAuthRecord,
  startMcpOAuthLogin,
  writeMcpOAuthRecord,
  type McpOAuthFetch,
} from '../runtime/mcp-oauth.js';
import { SqliteStore } from '../runtime/store/sqlite-store.js';
import type { McpEntry } from '../runtime/store/store.js';
import { startFakeAtlassian, type FakeAtlassian } from './fixtures/fake-atlassian.js';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, evidence = ''): void {
  checks.push({ name, pass, evidence });
}

const SPIKE_ROOT = mkdtempSync(join(tmpdir(), 'naby-spike-mcp-oauth-'));
process.env.NABY_HOME = SPIKE_ROOT;
process.env.NABY_DB_PATH = join(SPIKE_ROOT, 'app.db');

let caseNo = 0;
function freshStore(): SqliteStore {
  caseNo += 1;
  const dir = join(SPIKE_ROOT, `case-${caseNo}`);
  mkdirSync(dir, { recursive: true });
  return new SqliteStore({ path: join(dir, 'app.db') });
}

const SERVER = 'atlassian';
const entry = (fake: FakeAtlassian): McpEntry => ({
  name: SERVER,
  transport: 'http',
  url: fake.mcpUrl,
  auth: 'oauth',
  status: 'enabled',
});

/** Every request the client made, for "no network" assertions. */
function countingFetch(): { fetch: McpOAuthFetch; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${new URL(url).pathname}`);
      return fetch(input, init);
    },
  };
}

async function login(store: SqliteStore, fake: FakeAtlassian, f?: McpOAuthFetch): Promise<string> {
  const l = await startMcpOAuthLogin({ store, server: SERVER, serverUrl: fake.mcpUrl, ...(f ? { fetch: f } : {}) });
  const back = await fake.consent(l.authorizationUrl);
  const r = await l.done;
  if (!r.ok) throw new Error(`login failed: ${r.error} (${back.status} ${back.body.slice(0, 120)})`);
  return l.authorizationUrl;
}

// ---------------------------------------------------------------------------

async function discoveryAndLogin(): Promise<void> {
  const fake = await startFakeAtlassian();
  const store = freshStore();
  try {
    const counted = countingFetch();
    const l = await startMcpOAuthLogin({ store, server: SERVER, serverUrl: fake.mcpUrl, fetch: counted.fetch });
    const authUrl = new URL(l.authorizationUrl);
    record(
      'discovery: falls back from the 404 protected-resource metadata to the root authorization-server metadata',
      counted.calls.includes('GET /.well-known/oauth-protected-resource/v1/mcp') &&
        counted.calls.includes('GET /.well-known/oauth-authorization-server') &&
        authUrl.pathname === '/v1/authorize',
      counted.calls.join(', '),
    );
    const reg = fake.lastRegistration() ?? {};
    const redirect = ((reg.redirect_uris as string[]) ?? [])[0] ?? '';
    record(
      'registration: public client (token_endpoint_auth_method none) with a 127.0.0.1 loopback redirect',
      reg.token_endpoint_auth_method === 'none' && /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/.test(redirect),
      JSON.stringify(reg),
    );
    record(
      'authorization URL: PKCE S256, state, and the same redirect',
      authUrl.searchParams.get('code_challenge_method') === 'S256' &&
        (authUrl.searchParams.get('code_challenge') ?? '').length > 20 &&
        (authUrl.searchParams.get('state') ?? '').length > 10 &&
        authUrl.searchParams.get('redirect_uri') === redirect,
      authUrl.href,
    );
    record('login: nothing is connected before the browser comes back', mcpOAuthStatus(store, SERVER) === 'none');
    const back = await fake.consent(l.authorizationUrl);
    const done = await l.done;
    record('login: the callback completes the code exchange (PKCE verified by the fake)', done.ok && back.status === 200, `${JSON.stringify(done)} ${back.status}`);
    const rec = readMcpOAuthRecord(store, SERVER);
    record(
      'login: tokens and the registration are stored; status connected',
      mcpOAuthStatus(store, SERVER) === 'connected' &&
        rec?.tokens?.access_token === fake.current().access &&
        rec?.tokens?.refresh_token === fake.current().refresh &&
        typeof rec?.client?.client_id === 'string' &&
        typeof rec?.tokens?.expires_at === 'number',
      JSON.stringify({ status: mcpOAuthStatus(store, SERVER), hasClient: !!rec?.client }),
    );

    // Connect through the stored token.
    const load = await loadMcpToolset([entry(fake)], { oauth: { store } });
    record(
      'connect: the remote tools load as atlassian__<tool> through the stored token',
      load.failures.length === 0 &&
        load.toolSchemas.map((t) => t.name).sort().join(',') ===
          'atlassian__createConfluencePage,atlassian__getConfluencePage,atlassian__searchConfluenceUsingCql',
      JSON.stringify({ failures: load.failures, tools: load.toolSchemas.map((t) => t.name) }),
    );
    const call = await load.executors['atlassian__getConfluencePage']!({ pageId: '1' }, {
      toolCall: { toolCallId: 'c1', toolName: 'atlassian__getConfluencePage', input: {} },
      signal: new AbortController().signal,
    });
    record('connect: a tool call goes through', call.content === 'ok' && !call.isError, JSON.stringify(call));
    await load.closeAll();

    // A second login reuses the registration (no second /register).
    const regsBefore = fake.stats.registrations;
    await login(store, fake);
    record(
      'login again: the persisted registration is reused (no new dynamic registration)',
      fake.stats.registrations === regsBefore && mcpOAuthStatus(store, SERVER) === 'connected',
      `registrations ${regsBefore} → ${fake.stats.registrations}`,
    );
  } finally {
    await fake.close();
    store.close();
  }
}

async function noSignInFailsFast(): Promise<void> {
  const fake = await startFakeAtlassian();
  const store = freshStore();
  try {
    const before = fake.stats.mcpRequests;
    const load = await loadMcpToolset([entry(fake)], { oauth: { store } });
    record(
      'not signed in: the connect fails with a sign-in message and sends NOTHING',
      load.failures.length === 1 &&
        /not signed in/.test(load.failures[0]!.message) &&
        fake.stats.mcpRequests === before &&
        fake.stats.authorizations === 0,
      JSON.stringify(load.failures),
    );
    const noCtx = await loadMcpToolset([entry(fake)]);
    record(
      'no token store passed: refused, not a silent 401',
      noCtx.failures.length === 1 && /no token store/.test(noCtx.failures[0]!.message),
      JSON.stringify(noCtx.failures),
    );
  } finally {
    await fake.close();
    store.close();
  }
}

async function persistFirstAndSingleFlight(): Promise<void> {
  let store!: SqliteStore;
  const violations: string[] = [];
  const fake = await startFakeAtlassian({
    refreshDelayMs: 150,
    onAuthorizedMcp: (accessToken) => {
      // PERSIST FIRST: whenever the server sees an access token, the store must
      // already hold the refresh token issued WITH it.
      const rec = readMcpOAuthRecord(store, SERVER);
      if (rec?.tokens?.access_token !== accessToken || rec?.tokens?.refresh_token !== fake.current().refresh) {
        violations.push(`access ${accessToken.slice(0, 10)} used while store has ${rec?.tokens?.refresh_token?.slice(0, 10)}`);
      }
    },
  });
  store = freshStore();
  try {
    await login(store, fake);
    // Expire the stored access token (our clock), keep the refresh token.
    const rec = readMcpOAuthRecord(store, SERVER)!;
    writeMcpOAuthRecord(store, SERVER, { ...rec, tokens: { ...rec.tokens!, expires_at: Date.now() - 1000 } });
    const refreshesBefore = fake.stats.refreshes;
    const netBefore = mcpOAuthRefreshStats.networkRefreshes;
    const oldRefresh = rec.tokens!.refresh_token!;

    // Two "tabs" connect at the same moment.
    const [a, b] = await Promise.all([
      loadMcpToolset([entry(fake)], { oauth: { store } }),
      loadMcpToolset([entry(fake)], { oauth: { store } }),
    ]);
    record(
      'single-flight: two concurrent connects with an expired token cause ONE refresh',
      fake.stats.refreshes - refreshesBefore === 1 &&
        mcpOAuthRefreshStats.networkRefreshes - netBefore === 1 &&
        a.failures.length === 0 &&
        b.failures.length === 0 &&
        fake.stats.refreshReuse === 0,
      JSON.stringify({
        refreshes: fake.stats.refreshes - refreshesBefore,
        network: mcpOAuthRefreshStats.networkRefreshes - netBefore,
        stats: mcpOAuthRefreshStats,
        reuse: fake.stats.refreshReuse,
        a: a.failures,
        b: b.failures,
      }),
    );
    await a.closeAll();
    await b.closeAll();
    const after = readMcpOAuthRecord(store, SERVER)!;
    record(
      'rotation: the new refresh token replaced the old one in the store',
      after.tokens?.refresh_token === fake.current().refresh && after.tokens?.refresh_token !== oldRefresh,
    );
    record('persist-first: no access token was used before its refresh token was stored', violations.length === 0, violations.join('; '));

    // The library's own 401 path: the server revokes the access token though our
    // clock says it is fresh. Two connects get a 401 at once and both run the
    // library's auth() — the intercepted refresh must still be ONE.
    fake.revokeAccess();
    const r2 = fake.stats.refreshes;
    const [c, d] = await Promise.all([
      loadMcpToolset([entry(fake)], { oauth: { store } }),
      loadMcpToolset([entry(fake)], { oauth: { store } }),
    ]);
    record(
      '401 path: the library-driven refresh is single-flight too (no reuse at the server)',
      fake.stats.refreshes - r2 === 1 && fake.stats.refreshReuse === 0 && c.failures.length === 0 && d.failures.length === 0,
      JSON.stringify({ refreshes: fake.stats.refreshes - r2, reuse: fake.stats.refreshReuse, c: c.failures, d: d.failures }),
    );
    await c.closeAll();
    await d.closeAll();
    record('persist-first: still no violation after the 401-driven refresh', violations.length === 0, violations.join('; '));

    // A late caller presenting the SPENT refresh token sends nothing.
    const { refreshMcpOAuthTokens } = await import('../runtime/mcp-oauth.js');
    const r3 = fake.stats.refreshes;
    const late = await refreshMcpOAuthTokens(store, SERVER, { presentedRefreshToken: oldRefresh });
    record(
      'a refresh presenting an already-rotated token returns the stored set without a request',
      late.ok && !late.network && fake.stats.refreshes === r3,
      JSON.stringify(late),
    );
  } finally {
    await fake.close();
    store.close();
  }
}

async function reloginDetection(): Promise<void> {
  const fake = await startFakeAtlassian();
  const store = freshStore();
  try {
    await login(store, fake);
    const authsBefore = fake.stats.authorizations;

    // 5xx first: NOT a relogin.
    let rec = readMcpOAuthRecord(store, SERVER)!;
    writeMcpOAuthRecord(store, SERVER, { ...rec, tokens: { ...rec.tokens!, expires_at: Date.now() - 1000 } });
    fake.failNextRefresh('server_error', 503);
    fake.revokeAccess();
    const transient = await loadMcpToolset([entry(fake)], { oauth: { store } });
    await transient.closeAll();
    record(
      'a 5xx on refresh is not "sign in again": the tokens stay, status stays connected',
      mcpOAuthStatus(store, SERVER) === 'connected' && !!readMcpOAuthRecord(store, SERVER)?.tokens?.refresh_token,
      JSON.stringify({ status: mcpOAuthStatus(store, SERVER), failures: transient.failures }),
    );

    // invalid_grant: relogin.
    rec = readMcpOAuthRecord(store, SERVER)!;
    writeMcpOAuthRecord(store, SERVER, { ...rec, tokens: { ...rec.tokens!, expires_at: Date.now() - 1000 } });
    fake.failNextRefresh('invalid_grant', 400);
    fake.revokeAccess();
    const refreshesBefore = fake.stats.refreshes;
    const dead = await loadMcpToolset([entry(fake)], { oauth: { store } });
    await dead.closeAll();
    const after = readMcpOAuthRecord(store, SERVER);
    record(
      'invalid_grant → status relogin, tokens cleared, the connect fails',
      mcpOAuthStatus(store, SERVER) === 'relogin' && !after?.tokens && dead.failures.length === 1,
      JSON.stringify({ status: mcpOAuthStatus(store, SERVER), failures: dead.failures, reason: after?.reloginReason }),
    );
    record(
      'no loop and no browser: at most two refresh attempts, no authorize request',
      fake.stats.refreshes - refreshesBefore <= 2 && fake.stats.authorizations === authsBefore,
      `refreshes ${fake.stats.refreshes - refreshesBefore}, authorizations ${fake.stats.authorizations - authsBefore}`,
    );
    const mcpBefore = fake.stats.mcpRequests;
    const again = await loadMcpToolset([entry(fake)], { oauth: { store } });
    record(
      'after relogin: the next connect refuses without network ("sign in again")',
      again.failures.length === 1 && /sign in again/.test(again.failures[0]!.message) && fake.stats.mcpRequests === mcpBefore,
      JSON.stringify(again.failures),
    );

    // Signing in again recovers.
    await login(store, fake);
    const ok = await loadMcpToolset([entry(fake)], { oauth: { store } });
    record('signing in again recovers', mcpOAuthStatus(store, SERVER) === 'connected' && ok.failures.length === 0, JSON.stringify(ok.failures));
    await ok.closeAll();
  } finally {
    await fake.close();
    store.close();
  }
}

async function reducedToolsetIsRelogin(): Promise<void> {
  const fake = await startFakeAtlassian();
  const store = freshStore();
  try {
    await login(store, fake);
    // A full listing leaves the sign-in alone.
    const full = await loadMcpToolset([entry(fake)], { oauth: { store } });
    await full.closeAll();
    record('reduced: a full listing (getConfluencePage present) keeps status connected', mcpOAuthStatus(store, SERVER) === 'connected' && full.failures.length === 0);

    // The token dies; the server keeps answering 200 with the public subset (live behaviour).
    fake.invalidTokenGetsReducedSet(true);
    fake.revokeAccess();
    const before = readMcpOAuthRecord(store, SERVER)!;
    const refreshes = fake.stats.refreshes;
    const regs = fake.stats.registrations;
    const auths = fake.stats.authorizations;
    const reduced = await loadMcpToolset([entry(fake)], { oauth: { store } });
    await reduced.closeAll();
    const after = readMcpOAuthRecord(store, SERVER);
    record(
      'reduced: a listing without getConfluencePage sets "re-login needed" and the connect fails',
      mcpOAuthStatus(store, SERVER) === 'relogin' &&
        after?.reloginReason === 'reduced-toolset' &&
        reduced.failures.length === 1 &&
        /sign in again/.test(reduced.failures[0]!.message) &&
        reduced.toolSchemas.length === 0,
      JSON.stringify({ status: mcpOAuthStatus(store, SERVER), failures: reduced.failures, tools: reduced.toolSchemas.map((t) => t.name) }),
    );
    record(
      'reduced: the tokens and the client registration are KEPT',
      after?.tokens?.refresh_token === before.tokens?.refresh_token &&
        after?.tokens?.access_token === before.tokens?.access_token &&
        after?.client?.client_id === before.client?.client_id,
    );
    record(
      'reduced: no refresh, no registration, no browser — nothing loops',
      fake.stats.refreshes === refreshes && fake.stats.registrations === regs && fake.stats.authorizations === auths,
      JSON.stringify({ refreshes: fake.stats.refreshes - refreshes, regs: fake.stats.registrations - regs }),
    );
    const mcpBefore = fake.stats.mcpRequests;
    const again = await loadMcpToolset([entry(fake)], { oauth: { store } });
    record(
      'reduced: the next connect refuses without any network until the user logs in again',
      again.failures.length === 1 && fake.stats.mcpRequests === mcpBefore && fake.stats.refreshes === refreshes,
      JSON.stringify(again.failures),
    );
    // Logging in again reuses the stored registration and clears the state.
    await login(store, fake);
    const ok = await loadMcpToolset([entry(fake)], { oauth: { store } });
    await ok.closeAll();
    record(
      'reduced: logging in again reuses the registration and recovers the full tool set',
      fake.stats.registrations === regs &&
        mcpOAuthStatus(store, SERVER) === 'connected' &&
        ok.failures.length === 0 &&
        ok.toolSchemas.some((t) => t.name === 'atlassian__getConfluencePage') &&
        readMcpOAuthRecord(store, SERVER)?.reloginReason === undefined,
      JSON.stringify({ regs: fake.stats.registrations - regs, failures: ok.failures }),
    );
  } finally {
    await fake.close();
    store.close();
  }
}

async function cancelKeepsOldTokens(): Promise<void> {
  const fake = await startFakeAtlassian();
  const store = freshStore();
  try {
    await login(store, fake);
    const before = readMcpOAuthRecord(store, SERVER)!.tokens!;
    const l = await startMcpOAuthLogin({ store, server: SERVER, serverUrl: fake.mcpUrl });
    record('re-login in progress: the old tokens are set aside', !readMcpOAuthRecord(store, SERVER)?.tokens);
    l.cancel();
    const r = await l.done;
    const after = readMcpOAuthRecord(store, SERVER)?.tokens;
    record(
      'a cancelled re-login gives the old working tokens back',
      !r.ok && after?.refresh_token === before.refresh_token && mcpOAuthStatus(store, SERVER) === 'connected',
      JSON.stringify({ r, status: mcpOAuthStatus(store, SERVER) }),
    );
  } finally {
    await fake.close();
    store.close();
  }
}

async function main(): Promise<void> {
  try {
    await discoveryAndLogin();
    await noSignInFailsFast();
    await persistFirstAndSingleFlight();
    await reloginDetection();
    await reducedToolsetIsRelogin();
    await cancelKeepsOldTokens();
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
