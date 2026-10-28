// src/runtime/cic-url-migration.ts
//
// CIC MOVED FROM THE VM TO K8S (2026-10-28). The old path
// `https://skills.altimedia.com/cic/*` now answers 404 — the VM nginx rule that
// forwarded it is gone — and the service lives at the root of
// `https://cic.altimedia.com` (so `/mcp`, not `/cic/mcp`). The Bearer token is
// unchanged: the k8s CIC_API_TOKEN is the VM's value.
//
// The cic preset froze its URL into the stored row at save time, and a user may
// also have pinned the old URL as the `cic.url` override. Both are rewritten
// here, once per process, on the way in (getStore). Only the retired prefix is
// touched: any other URL is the user's choice and stays.
//
// No MCP session id survives this: naby opens MCP clients per turn
// (`loadMcpToolset`) and keeps none between turns, so the first connect after
// the rewrite initializes a fresh session against the new server.

import type { McpEntry, Store } from './store/store.js';

/** The address the cic preset ships with. */
export const CIC_MCP_URL = 'https://cic.altimedia.com/mcp';
/** The settings key that overrides the preset URL (shell systemMcp.ts). */
const CIC_URL_SETTING = 'cic.url';

/** `http(s)://skills.altimedia.com/cic…` — the retired VM path. `/cic-old` is a
 *  read-only snapshot and is NOT matched: it must never be used, but it is not
 *  ours to redirect either. */
const RETIRED_CIC_RE = /^https?:\/\/skills\.altimedia\.com\/cic(?=\/|$)/i;

/** The new URL for a retired one, or undefined when `url` is not retired. */
export function migratedCicUrl(url: string): string | undefined {
  const trimmed = url.trim();
  if (!RETIRED_CIC_RE.test(trimmed)) return undefined;
  // `/cic/mcp` → `/mcp`; anything else under `/cic` keeps its tail.
  const tail = trimmed.replace(RETIRED_CIC_RE, '') || '/mcp';
  return `https://cic.altimedia.com${tail}`;
}

export type CicUrlMigration = { entries: string[]; setting: boolean };

/** Rewrite stored rows and the override that still point at the retired path.
 *  Returns what changed; never throws. */
export function migrateCicUrl(
  store: Pick<Store, 'listMcpEntries' | 'upsertMcpEntry' | 'getSetting' | 'setSetting'>,
): CicUrlMigration {
  const out: CicUrlMigration = { entries: [], setting: false };
  try {
    for (const e of store.listMcpEntries()) {
      if (e.transport !== 'http' && e.transport !== 'sse') continue;
      const next = migratedCicUrl(e.url);
      if (!next) continue;
      store.upsertMcpEntry({ ...e, url: next } as McpEntry);
      out.entries.push(e.name);
    }
  } catch {
    /* a store without MCP rows */
  }
  try {
    const override = store.getSetting(CIC_URL_SETTING);
    if (override && migratedCicUrl(override)) {
      // Empty = "no override": the preset default (the new URL) answers.
      store.setSetting(CIC_URL_SETTING, '');
      out.setting = true;
    }
  } catch {
    /* no settings table */
  }
  return out;
}
