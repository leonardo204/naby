// src/runtime/org-harness-mcp.ts
//
// THE ORG PACKAGE'S MCP ADDRESSES, FOLLOWED (specs/org-harness-sync.md §3.10).
//
// The package ships a Claude Code `.mcp.json` naming the servers its skills call
// (`atlassian`, `skill-hub`, `cic`). naby does not load that file as MCP config —
// its servers are System MCP presets with naby's own auth (§3.8) — but the
// ADDRESS in it is the org's decision. When 0.11.1 moved Atlassian from `/v1/mcp`
// to `/v2/mcp?tools=all`, naby kept connecting to v1 because the address was a
// constant here and the package file was never read.
//
// THE RULE. For each `http` server in the package's `.mcp.json` whose name matches
// a naby MCP row:
//   * the address the package names is remembered (`harness.org.mcp.<name>.url`),
//     so a preset saved or signed in LATER is built with it, not the constant;
//   * when that address CHANGED since the last time it was applied, the row's URL
//     is rewritten. Everything else in the row (headers, auth, status) stays.
//   * an OAuth row whose address changed is put into "sign in again". Its tokens
//     were issued for the old resource, and keeping them would send a bearer
//     token to an address it was never granted for.
//
// "CHANGED SINCE LAST APPLIED", NOT "DIFFERS FROM THE ROW". A user who edits a
// row's address by hand keeps their edit until the org moves the address again.
//
// Never touched: an agent-PROPOSED row (a human approves those), a stdio row (the
// Atlassian API-token row waiting for its sign-in, §4.4 — the swap after the
// sign-in builds the row with the remembered address), a non-https address.
//
// Like org-harness.ts, a function of the store and a directory: no network. Keyed
// by the package fingerprint so a turn where nothing changed writes nothing.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ATLASSIAN_MCP_SERVER_NAME, ATLASSIAN_MCP_URL, clearMcpOAuthTokensForRelogin } from './mcp-oauth.js';
import {
  type OrgHarnessContext,
  orgHarnessOnState,
  readCurrentOrgPackage,
} from './org-harness.js';
import type { McpEntry, Store } from './store/store.js';

/** The package file, Claude Code's plugin MCP config. */
export const ORG_PACKAGE_MCP_FILE = '.mcp.json';
/** Fingerprint of the package whose addresses were last applied. */
export const ORG_HARNESS_MCP_APPLIED_SETTING = 'harness.org.mcp.applied';
/** The OAuth relogin reason this module writes. */
export const ORG_MCP_URL_CHANGED_REASON = 'server-url-changed';

export function orgHarnessMcpUrlKey(name: string): string {
  return `harness.org.mcp.${name}.url`;
}

/** `name → https URL` for the package's http servers. Never throws. */
export function readOrgPackageMcpUrls(dir: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, ORG_PACKAGE_MCP_FILE), 'utf8'));
  } catch {
    return {};
  }
  const servers = (parsed as { mcpServers?: unknown })?.mcpServers;
  if (!servers || typeof servers !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    const s = raw as { type?: unknown; url?: unknown };
    if (s?.type !== 'http' || typeof s.url !== 'string') continue;
    const url = s.url.trim();
    if (!isHttpsUrl(url)) continue;
    out[name] = url;
  }
  return out;
}

function isHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** The address the org package names for a server, if one was ever applied. */
export function orgHarnessMcpUrl(store: Pick<Store, 'getSetting'>, name: string): string | undefined {
  const v = store.getSetting(orgHarnessMcpUrlKey(name))?.trim();
  return v && isHttpsUrl(v) ? v : undefined;
}

/** The Atlassian remote MCP address this install should use: the org package's,
 *  else the built-in one. */
export function atlassianMcpUrl(store: Pick<Store, 'getSetting'>): string {
  return orgHarnessMcpUrl(store, ATLASSIAN_MCP_SERVER_NAME) ?? ATLASSIAN_MCP_URL;
}

export type OrgHarnessMcpStore = Pick<Store, 'getSetting' | 'setSetting' | 'listMcpEntries' | 'upsertMcpEntry'>;

export type OrgHarnessMcpChange = { name: string; from: string; to: string; relogin: boolean };

export type OrgHarnessMcpResult = {
  ran: boolean;
  /** Rows whose URL was rewritten. */
  changed: OrgHarnessMcpChange[];
};

/**
 * Apply the package's MCP addresses (§3.10). A no-op when the org harness is off,
 * when no package is on disk, or when this package was already applied.
 */
export function applyOrgHarnessMcpIfDue(
  store: OrgHarnessMcpStore,
  ctx: Pick<OrgHarnessContext, 'home' | 'apiKey' | 'env'>,
  opts: { now?: number } = {},
): OrgHarnessMcpResult {
  const out: OrgHarnessMcpResult = { ran: false, changed: [] };
  if (!orgHarnessOnState(store, ctx).on) return out;
  const pkg = readCurrentOrgPackage(ctx.home);
  if (!pkg) return out;
  const fingerprint = JSON.stringify({ version: pkg.version, sha256: pkg.sha256 });
  if ((store.getSetting(ORG_HARNESS_MCP_APPLIED_SETTING) ?? '') === fingerprint) return out;
  out.ran = true;

  const urls = readOrgPackageMcpUrls(pkg.dir);
  const rows = new Map(store.listMcpEntries().map((e) => [e.name, e] as const));
  for (const [name, url] of Object.entries(urls)) {
    const prev = store.getSetting(orgHarnessMcpUrlKey(name))?.trim() ?? '';
    if (prev === url) continue;
    store.setSetting(orgHarnessMcpUrlKey(name), url);
    const row = rows.get(name);
    if (!row || row.transport === 'stdio' || row.status === 'proposed' || row.url === url) continue;
    const next: McpEntry = { ...row, url };
    store.upsertMcpEntry(next);
    const relogin = row.auth === 'oauth';
    if (relogin) clearMcpOAuthTokensForRelogin(store, name, ORG_MCP_URL_CHANGED_REASON, opts.now ?? Date.now());
    out.changed.push({ name, from: row.url, to: url, relogin });
  }
  store.setSetting(ORG_HARNESS_MCP_APPLIED_SETTING, fingerprint);
  return out;
}
