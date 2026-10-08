// src/spikes/spike-mcp-oauth-live.ts
//
// MANUAL — the REAL Atlassian browser sign-in (specs/org-harness-sync.md §3.8, §5
// "실제 계정으로 atlassian-cloud 연결 1회"). NOT part of any automated suite: it
// needs a person at a browser and an Atlassian account.
//
//   npm run spike:mcp-oauth-live            # opens the system browser
//   npm run spike:mcp-oauth-live -- --no-open   # prints the URL instead
//   npm run spike:mcp-oauth-live -- --keep      # keep the temp home for inspection
//
// It runs the production code path (`startMcpOAuthLogin`, `loadMcpToolset` with
// the OAuth token store) against https://mcp.atlassian.com/v1/mcp in a THROWAWAY
// NABY_HOME — never ~/.naby — and checks:
//
//   1. discovery + dynamic registration + PKCE reach an authorization URL;
//   2. the browser sign-in (consent, and any org-admin approval) completes and
//      the tokens are stored;
//   3. the remote tools list through the stored token, including the three pdoc
//      calls (getConfluencePage, searchConfluenceUsingCql, createConfluencePage);
//   4. a forced refresh rotates/stores tokens and the tools still list;
//   5. (informational) what the server does with an INVALID bearer token — on
//      2026-10-08 it answered 200 with a reduced tool set instead of a 401.
//
// Prints PASS/FAIL/INFO lines and exits non-zero on any FAIL.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'naby-spike-mcp-oauth-live-'));
process.env.NABY_HOME = HOME;
process.env.NABY_DB_PATH = join(HOME, 'app.db');

import { loadMcpToolset } from '../runtime/mcp.js';
import {
  ATLASSIAN_MCP_SERVER_NAME,
  ATLASSIAN_MCP_URL,
  mcpOAuthStatus,
  readMcpOAuthRecord,
  startMcpOAuthLogin,
  writeMcpOAuthRecord,
} from '../runtime/mcp-oauth.js';
import { SqliteStore } from '../runtime/store/sqlite-store.js';
import type { McpEntry } from '../runtime/store/store.js';

const args = new Set(process.argv.slice(2));
const lines: { tag: 'PASS' | 'FAIL' | 'INFO'; text: string }[] = [];
const pass = (ok: boolean, text: string): void => void lines.push({ tag: ok ? 'PASS' : 'FAIL', text });
const info = (text: string): void => void lines.push({ tag: 'INFO', text });

function openBrowser(url: string): void {
  const [cmd, cmdArgs] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, cmdArgs as string[], { stdio: 'ignore', detached: true }).unref();
  } catch (e) {
    console.log(`could not open a browser (${e instanceof Error ? e.message : String(e)}); open the URL yourself.`);
  }
}

const ENTRY: McpEntry = {
  name: ATLASSIAN_MCP_SERVER_NAME,
  transport: 'http',
  url: ATLASSIAN_MCP_URL,
  auth: 'oauth',
  status: 'enabled',
};

async function main(): Promise<void> {
  const store = new SqliteStore({ path: join(HOME, 'app.db') });
  console.log(`temp NABY_HOME: ${HOME}`);

  // 1. Discovery, registration, PKCE.
  const login = await startMcpOAuthLogin({ store, server: ATLASSIAN_MCP_SERVER_NAME, serverUrl: ATLASSIAN_MCP_URL });
  const authUrl = new URL(login.authorizationUrl);
  pass(
    authUrl.host === 'mcp.atlassian.com' && authUrl.searchParams.get('code_challenge_method') === 'S256',
    `authorization URL via discovery + dynamic registration (redirect ${login.redirectUrl})`,
  );
  console.log(`\nSign in here (waiting up to 5 minutes):\n\n  ${login.authorizationUrl}\n`);
  if (!args.has('--no-open')) openBrowser(login.authorizationUrl);

  // 2. The browser comes back.
  const done = await login.done;
  pass(done.ok, `browser sign-in completed${done.ok ? '' : `: ${done.error}`}`);
  if (!done.ok) return finish(store);
  const rec = readMcpOAuthRecord(store, ATLASSIAN_MCP_SERVER_NAME);
  pass(mcpOAuthStatus(store, ATLASSIAN_MCP_SERVER_NAME) === 'connected', 'tokens stored; status connected');
  info(
    `token: expires_in ${rec?.tokens?.expires_in ?? '?'}s, refresh token ${rec?.tokens?.refresh_token ? 'present' : 'ABSENT'}, ` +
      `scope ${rec?.tokens?.scope ?? '-'}, client ${rec?.client?.client_id?.slice(0, 8) ?? '?'}…`,
  );

  // 3. Tools through the stored token.
  const load = await loadMcpToolset([ENTRY], { oauth: { store } });
  const names = load.toolSchemas.map((t) => t.name);
  pass(load.failures.length === 0 && names.length > 0, `connected: ${names.length} tools${load.failures[0] ? ` — ${load.failures[0].message}` : ''}`);
  for (const want of ['getConfluencePage', 'searchConfluenceUsingCql', 'createConfluencePage']) {
    pass(names.includes(`atlassian__${want}`), `pdoc's tool atlassian__${want} is offered`);
  }
  info(`tools: ${names.join(', ')}`);
  await load.closeAll();

  // 4. Forced refresh.
  const before = readMcpOAuthRecord(store, ATLASSIAN_MCP_SERVER_NAME)!;
  if (before.tokens?.refresh_token) {
    writeMcpOAuthRecord(store, ATLASSIAN_MCP_SERVER_NAME, {
      ...before,
      tokens: { ...before.tokens, expires_at: Date.now() - 1000 },
    });
    const again = await loadMcpToolset([ENTRY], { oauth: { store } });
    const after = readMcpOAuthRecord(store, ATLASSIAN_MCP_SERVER_NAME)!;
    pass(again.failures.length === 0 && again.toolSchemas.length > 0, `after a forced refresh the tools still list (${again.toolSchemas.length})`);
    pass(
      after.tokens?.access_token !== before.tokens.access_token && typeof after.refreshedAt === 'number',
      'the refresh stored a new access token',
    );
    info(`refresh token rotated: ${after.tokens?.refresh_token !== before.tokens.refresh_token ? 'yes' : 'no (server keeps it)'}`);
    await again.closeAll();
  } else {
    info('no refresh token was issued — forced refresh skipped');
  }

  // 5. Informational: an invalid bearer.
  const probe = new SqliteStore({ path: join(HOME, 'probe.db') });
  const cur = readMcpOAuthRecord(store, ATLASSIAN_MCP_SERVER_NAME)!;
  writeMcpOAuthRecord(probe, ATLASSIAN_MCP_SERVER_NAME, {
    ...cur,
    tokens: { access_token: 'invalid-token-probe', token_type: 'Bearer', obtained_at: Date.now() },
  });
  const bogus = await loadMcpToolset([ENTRY], { oauth: { store: probe } });
  info(
    `invalid bearer → ${bogus.failures.length ? `failure: ${bogus.failures[0]!.message}` : `${bogus.toolSchemas.length} tools: ${bogus.toolSchemas.map((t) => t.name).join(', ')}`}` +
      `; status now ${mcpOAuthStatus(probe, ATLASSIAN_MCP_SERVER_NAME)}`,
  );
  await bogus.closeAll();
  probe.close();
  return finish(store);
}

function finish(store: SqliteStore): void {
  store.close();
  let failed = 0;
  for (const l of lines) {
    if (l.tag === 'FAIL') failed += 1;
    console.log(`${l.tag}  ${l.text}`);
  }
  console.log(`\n${failed === 0 ? 'LIVE OAUTH: PASS' : `LIVE OAUTH: ${failed} FAIL`}`);
  if (!args.has('--keep')) {
    try {
      rmSync(HOME, { recursive: true, force: true });
    } catch {
      /* temp */
    }
  } else {
    console.log(`kept: ${HOME}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
