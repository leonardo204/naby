// src/spikes/spike-org-harness-mcp.ts
//
// The org package's MCP addresses, followed (specs/org-harness-sync.md §3.10).
// A temp home with hand-written package folders and a temp database per case;
// no network, no real sign-in.
//
// Run: npm run spike:org-harness-mcp

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SPIKE_ROOT = mkdtempSync(join(tmpdir(), 'naby-spike-org-mcp-'));
process.env.NABY_HOME = SPIKE_ROOT;
process.env.NABY_DB_PATH = join(SPIKE_ROOT, 'app.db');

import {
  applyAtlassianOAuthSwapIfDue,
  atlassianOAuthEntry,
  currentLegacyAtlassianToolRefs,
  isAtlassianV2Url,
} from '../runtime/atlassian-migration.js';
import { DEFAULT_USER_ID } from '../runtime/memory-inject.js';
import { ATLASSIAN_MCP_URL, mcpOAuthStatus, readMcpOAuthRecord, writeMcpOAuthRecord } from '../runtime/mcp-oauth.js';
import { orgHarnessRoot } from '../runtime/org-harness.js';
import {
  applyOrgHarnessMcpIfDue,
  atlassianMcpUrl,
  ORG_MCP_URL_CHANGED_REASON,
  orgHarnessMcpUrl,
  readOrgPackageMcpUrls,
} from '../runtime/org-harness-mcp.js';
import { SqliteStore } from '../runtime/store/sqlite-store.js';
import type { McpEntry } from '../runtime/store/store.js';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, evidence = ''): void {
  checks.push({ name, pass, evidence });
}

const V1 = 'https://mcp.atlassian.com/v1/mcp';
const V2 = 'https://mcp.atlassian.com/v2/mcp?tools=all';
const CIC = 'https://cic.altimedia.com/mcp';
const CIC2 = 'https://cic2.altimedia.com/mcp';
const HUB = 'https://skills.altimedia.com/mcp';

let caseNo = 0;
function freshCase(): { store: SqliteStore; home: string } {
  caseNo += 1;
  const home = join(SPIKE_ROOT, `case-${caseNo}`);
  mkdirSync(home, { recursive: true });
  return { store: new SqliteStore({ path: join(home, 'app.db') }), home };
}

/** A complete package on disk, made `current` — what syncOrgHarnessPackage leaves. */
function installPackage(home: string, version: string, mcp: unknown): void {
  const root = orgHarnessRoot(home);
  const dir = join(root, version);
  mkdirSync(dir, { recursive: true });
  const sha256 = `sha-${version}`;
  if (mcp !== undefined) writeFileSync(join(dir, '.mcp.json'), typeof mcp === 'string' ? mcp : JSON.stringify(mcp));
  writeFileSync(
    join(dir, '.naby-package.json'),
    JSON.stringify({ name: 'altimedia-harness', version, sha256, extractedAt: Date.now() }),
  );
  writeFileSync(join(root, 'current.json'), JSON.stringify({ version, sha256 }));
}

function harnessMcp(atlassian: string, cic = CIC): unknown {
  return {
    mcpServers: {
      atlassian: { type: 'http', url: atlassian },
      'skill-hub': { type: 'http', url: HUB, headers: { Authorization: 'Bearer ${user_config.SHUB_API_KEY}' } },
      cic: { type: 'http', url: cic, headers: { Authorization: 'Bearer ${user_config.CIC_TOKEN}' } },
    },
  };
}

function signIn(store: SqliteStore): void {
  writeMcpOAuthRecord(store, 'atlassian', {
    v: 1,
    state: 'ok',
    client: { client_id: 'client_spike', redirect_uri: 'http://127.0.0.1:1/oauth/callback' },
    tokens: { access_token: 'at', token_type: 'Bearer', refresh_token: 'rt', obtained_at: Date.now() },
  });
}

function row(store: SqliteStore, name: string): McpEntry | undefined {
  return store.listMcpEntries().find((e) => e.name === name);
}
function urlOf(e: McpEntry | undefined): string | undefined {
  return e && e.transport !== 'stdio' ? e.url : undefined;
}

const ON = { apiKey: 'shub_spike', env: {} };

// 1. The report's shape: a signed-in v1 row, package 0.11.1 names v2.
{
  const { store, home } = freshCase();
  store.upsertMcpEntry(atlassianOAuthEntry(V1));
  store.upsertMcpEntry({ name: 'cic', transport: 'http', url: CIC, headers: { Authorization: 'Bearer tok' }, status: 'enabled' });
  signIn(store);
  installPackage(home, '0.11.1', harnessMcp(V2));
  const r = applyOrgHarnessMcpIfDue(store, { home, ...ON });
  const a = row(store, 'atlassian');
  record('v1 row follows the package to v2', urlOf(a) === V2, `url=${urlOf(a)}`);
  record(
    'the row keeps auth and status',
    a?.transport === 'http' && a.auth === 'oauth' && a.status === 'enabled',
    JSON.stringify(a),
  );
  record(
    'an OAuth row whose address moved asks to sign in again',
    mcpOAuthStatus(store, 'atlassian') === 'relogin' &&
      readMcpOAuthRecord(store, 'atlassian')?.reloginReason === ORG_MCP_URL_CHANGED_REASON,
  );
  const rec = readMcpOAuthRecord(store, 'atlassian');
  record('its tokens are dropped, its client kept', !rec?.tokens && rec?.client?.client_id === 'client_spike');
  record(
    'the result names exactly the one change',
    r.ran && r.changed.length === 1 && r.changed[0]!.name === 'atlassian' && r.changed[0]!.relogin,
    JSON.stringify(r.changed),
  );
  const c = row(store, 'cic');
  record('an unchanged address leaves the row alone (headers too)', urlOf(c) === CIC && c?.transport === 'http' && c.headers?.Authorization === 'Bearer tok');
  record('the address is remembered for later builds', atlassianMcpUrl(store) === V2 && orgHarnessMcpUrl(store, 'cic') === CIC);

  // Idempotent: the same package applies nothing again.
  const again = applyOrgHarnessMcpIfDue(store, { home, ...ON });
  record('the same package is applied once', !again.ran && again.changed.length === 0);
}

// 2. A user's hand edit survives until the org moves the address again.
{
  const { store, home } = freshCase();
  store.upsertMcpEntry({ name: 'cic', transport: 'http', url: CIC, headers: { Authorization: 'Bearer tok' }, status: 'enabled' });
  installPackage(home, '0.11.1', harnessMcp(V2));
  applyOrgHarnessMcpIfDue(store, { home, ...ON });
  const mine = 'https://cic.example.test/mcp';
  store.upsertMcpEntry({ name: 'cic', transport: 'http', url: mine, headers: { Authorization: 'Bearer tok' }, status: 'enabled' });
  installPackage(home, '0.11.2', harnessMcp(V2)); // same addresses, new package
  const r = applyOrgHarnessMcpIfDue(store, { home, ...ON });
  record('a new package with the same address keeps the hand edit', r.ran && urlOf(row(store, 'cic')) === mine);
  installPackage(home, '0.12.0', harnessMcp(V2, CIC2));
  const r2 = applyOrgHarnessMcpIfDue(store, { home, ...ON });
  const c = row(store, 'cic');
  record(
    'a moved address overrides it, keeping the bearer header and not touching OAuth',
    urlOf(c) === CIC2 && c?.transport === 'http' && c.headers?.Authorization === 'Bearer tok' && r2.changed[0]?.relogin === false,
  );
}

// 3. Not signed in yet: no row; the later sign-in swap builds the package's address.
{
  const { store, home } = freshCase();
  installPackage(home, '0.11.1', harnessMcp(V2));
  const r = applyOrgHarnessMcpIfDue(store, { home, ...ON });
  record('no row: nothing rewritten, the address remembered', r.changed.length === 0 && atlassianMcpUrl(store) === V2);
  record('no row: no OAuth record is invented', readMcpOAuthRecord(store, 'atlassian') === undefined);
  signIn(store);
  applyAtlassianOAuthSwapIfDue(store);
  record('the swap after the sign-in writes the v2 row', urlOf(row(store, 'atlassian')) === V2);
}

// 4. The legacy API-token row is left to the swap; a proposed row to a human.
{
  const { store, home } = freshCase();
  store.upsertMcpEntry({ name: 'atlassian', transport: 'stdio', command: 'uvx', args: ['mcp-atlassian'], status: 'enabled' });
  store.upsertMcpEntry({ name: 'cic', transport: 'http', url: CIC, status: 'proposed' });
  installPackage(home, '0.12.0', harnessMcp(V2, CIC2));
  applyOrgHarnessMcpIfDue(store, { home, ...ON });
  record('a stdio row is not rewritten', row(store, 'atlassian')?.transport === 'stdio');
  record('a proposed row is not rewritten', urlOf(row(store, 'cic')) === CIC);
}

// 5. Off, no package, and bad files.
{
  const { store, home } = freshCase();
  store.upsertMcpEntry(atlassianOAuthEntry(V1));
  installPackage(home, '0.11.1', harnessMcp(V2));
  const off = applyOrgHarnessMcpIfDue(store, { home, env: {} });
  record('org harness off (no key): nothing applied', !off.ran && urlOf(row(store, 'atlassian')) === V1);
  const envOff = applyOrgHarnessMcpIfDue(store, { home, apiKey: 'k', env: { NABY_ORG_HARNESS: '0' } });
  record('org harness off (env): nothing applied', !envOff.ran && urlOf(row(store, 'atlassian')) === V1);

  const empty = freshCase();
  record('no package on disk: nothing applied', !applyOrgHarnessMcpIfDue(empty.store, { home: empty.home, ...ON }).ran);
  record('no address applied: the built-in constant', atlassianMcpUrl(empty.store) === ATLASSIAN_MCP_URL);

  const bad = freshCase();
  installPackage(bad.home, '0.11.1', '{ not json');
  record('a broken .mcp.json is read as no servers', Object.keys(readOrgPackageMcpUrls(join(orgHarnessRoot(bad.home), '0.11.1'))).length === 0);
  const nofile = freshCase();
  installPackage(nofile.home, '0.11.1', undefined);
  record('a package without .mcp.json is read as no servers', applyOrgHarnessMcpIfDue(nofile.store, { home: nofile.home, ...ON }).changed.length === 0);

  const odd = freshCase();
  odd.store.upsertMcpEntry(atlassianOAuthEntry(V1));
  installPackage(odd.home, '0.11.1', {
    mcpServers: {
      atlassian: { type: 'http', url: 'http://mcp.atlassian.com/v2/mcp' },
      cic: { type: 'stdio', command: 'x' },
    },
  });
  applyOrgHarnessMcpIfDue(odd.store, { home: odd.home, ...ON });
  record('a non-https address is ignored', urlOf(row(odd.store, 'atlassian')) === V1 && atlassianMcpUrl(odd.store) === ATLASSIAN_MCP_URL);
}

// 6. The old-name warning, counted against the server the row points at now.
{
  const { store } = freshCase();
  const skill = (name: string, instructions: string, toolRefs: string[] = []) =>
    store.putHarnessItem({
      item: {
        scope: 'user',
        scopeKey: DEFAULT_USER_ID,
        kind: 'skill',
        name,
        description: name,
        provenance: { source: 'user' },
        skill: { instructions, triggers: [name], toolRefs },
      },
      requestedStatus: 'enabled',
    });
  skill('reader', 'Read the page with getConfluencePage, then summarise.');
  skill('both', 'Use getConfluenceContent (v2) or getConfluencePage (v1), whichever exists.');
  skill('comments', 'List comments with getConfluencePageFooterComments.');
  skill('jira', 'Look up the issue with getJiraIssue.');
  skill('ancient', 'x', ['atlassian__confluence_get_page']);
  store.putPolicyRule({ scope: 'user', scopeKey: DEFAULT_USER_ID, toolPattern: 'atlassian__searchConfluenceUsingCql', effect: 'allow' });
  store.putPolicyRule({ scope: 'user', scopeKey: DEFAULT_USER_ID, toolPattern: 'atlassian__getConfluencePageDescendants', effect: 'allow' });

  store.upsertMcpEntry(atlassianOAuthEntry(V1));
  const onV1 = currentLegacyAtlassianToolRefs(store).map((r) => r.ref).sort();
  record('on v1, v1 names are not old; only mcp-atlassian names are', onV1.join(',') === 'atlassian__confluence_get_page', onV1.join(','));

  store.upsertMcpEntry(atlassianOAuthEntry(V2));
  const refs = currentLegacyAtlassianToolRefs(store);
  const by = (name: string) => refs.find((r) => r.name === name);
  record('on v2, a v1 name in a skill body is old, with its v2 name', by('reader')?.ref === 'getConfluencePage' && by('reader')?.suggest === 'getConfluenceContent', JSON.stringify(by('reader')));
  record('a skill naming the v1 and v2 tools side by side is not flagged', by('both') === undefined);
  record('a v1 name with no one-to-one v2 tool is flagged without a guess', by('comments')?.ref === 'getConfluencePageFooterComments' && by('comments')?.suggest === undefined, JSON.stringify(by('comments')));
  record('a Jira name (unchanged in v2) is not flagged', by('jira') === undefined);
  record('mcp-atlassian names are still flagged on v2', by('ancient')?.ref === 'atlassian__confluence_get_page');
  record(
    'a permission rule naming a v1 tool is flagged, with the prefix kept',
    by('atlassian__searchConfluenceUsingCql')?.ref === 'atlassian__searchConfluenceUsingCql' &&
      by('atlassian__searchConfluenceUsingCql')?.suggest === 'searchConfluence' &&
      by('atlassian__getConfluencePageDescendants')?.suggest === undefined,
    JSON.stringify(refs.filter((r) => r.kind === 'policy')),
  );
  record('the count is exactly those five', refs.length === 5, refs.map((r) => r.name).join(','));

  store.upsertMcpEntry({ name: 'atlassian', transport: 'stdio', command: 'uvx', args: ['mcp-atlassian'], status: 'enabled' });
  record('no OAuth row: nothing is counted', currentLegacyAtlassianToolRefs(store).length === 0);
  record(
    'the v2 test reads the path, not the host',
    isAtlassianV2Url(V2) && isAtlassianV2Url('https://mcp.atlassian.com/v2/mcp') && !isAtlassianV2Url(V1) && !isAtlassianV2Url('https://x.test/a/v2/mcp') && !isAtlassianV2Url('not a url'),
  );
}

let failed = 0;
for (const c of checks) {
  if (!c.pass) failed += 1;
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.evidence && !c.pass ? `  — ${c.evidence}` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
rmSync(SPIKE_ROOT, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
