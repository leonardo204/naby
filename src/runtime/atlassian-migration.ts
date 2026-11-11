// src/runtime/atlassian-migration.ts
//
// FROM THE API-TOKEN ATLASSIAN PRESET TO BROWSER OAUTH (specs/org-harness-sync.md
// §4.4, M3).
//
// Until a user signs in through the browser, an existing `atlassian` row that
// runs `mcp-atlassian` over stdio keeps working exactly as before ("OAuth 전환
// 대기"). The moment the OAuth sign-in exists, and only at a turn boundary, this
// file:
//
//   1. swaps the row IN PLACE — same name, now `http` to the official remote MCP
//      with `auth: 'oauth'` — and the stored Confluence URL, account and API
//      token go with the old row (nothing of them is kept);
//   2. withdraws the built-in `confluence-upload` skill: an untouched row becomes
//      `removed` with origin `builtin-withdrawn:confluence-upload` (told apart
//      from a user's own delete); a row the user moved or edited is theirs and
//      stays, with a note on the Settings card;
//   3. counts the user's harness rows and permission rules that still name the
//      OLD tool spellings (`atlassian__confluence_get_page` …) and keeps the list
//      for Settings. Nothing is rewritten automatically.
//
// Everything here is a function of the store — no network, no paths — so the
// migration spike runs it against a temp database.

import { createHash } from 'node:crypto';
import { DEFAULT_USER_ID } from './memory-inject.js';
import { ATLASSIAN_MCP_SERVER_NAME, ATLASSIAN_MCP_URL, mcpOAuthStatus } from './mcp-oauth.js';
import { atlassianMcpUrl } from './org-harness-mcp.js';
import type { HarnessItem, HarnessScope, McpEntry, Store } from './store/store.js';

export const CONFLUENCE_UPLOAD_SKILL = 'confluence-upload';
/** `provenance.origin` prefix of a built-in naby stopped shipping (§4.4). */
export const BUILTIN_WITHDRAWN_ORIGIN_PREFIX = 'builtin-withdrawn:';
/** The origin a seeded built-in carries (harness-seed.ts `builtinHarnessOrigin`). */
const BUILTIN_ORIGIN_PREFIX = 'builtin:';
/** The auto-status key the built-in switch kept for it (harness-seed.ts). */
const CONFLUENCE_UPLOAD_AUTO_STATUS_KEY = `harness.builtin.${CONFLUENCE_UPLOAD_SKILL}.autoStatus`;
/**
 * sha256 of the body naby shipped (1.20.0 – 1.39.x; one version ever), after
 * CRLF→LF and trim. The asset itself is gone from this release (§4.4), so this
 * digest is the only way to tell "unmodified" from "edited".
 */
export const SHIPPED_CONFLUENCE_UPLOAD_BODY_SHA256: readonly string[] = [
  'f97e62d36adddd5fa0d44b92464aaaa79517d163384be5a5d4a6a22b44411aef',
];

export const ATLASSIAN_MIGRATION_SETTING = {
  /** JSON AtlassianMigrationReport — what the swap did, for Settings. */
  report: 'atlassian.oauth.migration',
} as const;

/** `atlassian__confluence_get_page`, `mcp__atlassian__jira_get_issue` … — the
 *  mcp-atlassian spellings, which the remote MCP does not have. */
export const LEGACY_ATLASSIAN_TOOL_RE = /(?:^|[^A-Za-z0-9_])(?:mcp__)?atlassian__(?:confluence|jira)_[a-z0-9_]+/;

/**
 * THE v1 CONFLUENCE TOOLS v2 DOES NOT HAVE (org-harness-sync §3.10). v2
 * (`/v2/mcp`) renamed and regrouped Confluence; Jira names did not change. The
 * names are the v1 server's tool list; "not in v2" is Atlassian's v2 tool page
 * (support.atlassian.com/atlassian-ai-gateway/docs/supported-tools), read
 * 2026-11-11.
 */
export const ATLASSIAN_V1_ONLY_TOOLS: readonly string[] = [
  'getConfluencePage',
  'getConfluencePageDescendants',
  'getConfluencePageFooterComments',
  'getConfluencePageInlineComments',
  'getConfluenceCommentChildren',
  'getConfluenceSpaces',
  'getPagesInConfluenceSpace',
  'searchConfluenceUsingCql',
  'createConfluencePage',
  'updateConfluencePage',
  'createConfluenceFooterComment',
  'createConfluenceInlineComment',
];

/**
 * The v2 name for a v1 tool, only where Atlassian's v2 page names a one-to-one
 * replacement. For the rest the arguments differ enough (comments, descendants,
 * spaces) that a suggestion would be a guess, so none is shown.
 *
 * A HINT FOR SETTINGS, NOT A CALL REWRITE. naby does not translate a model's call
 * from a v1 name to a v2 one: the arguments are not the same shape, and the model
 * already sees the real v2 tool list.
 */
export const ATLASSIAN_V1_TO_V2_TOOL: Readonly<Record<string, string>> = {
  getConfluencePage: 'getConfluenceContent',
  searchConfluenceUsingCql: 'searchConfluence',
  createConfluencePage: 'createConfluenceContent',
  updateConfluencePage: 'updateConfluenceContent',
};

const V1_ONLY_RE = new RegExp(`(?<![A-Za-z0-9])(?:(?:mcp__)?atlassian__)?(${ATLASSIAN_V1_ONLY_TOOLS.join('|')})(?![A-Za-z0-9])`, 'g');
/** Any v2 Confluence tool name: a text that has one was written for v2 too. */
const V2_CONFLUENCE_RE = /(?<![A-Za-z0-9])(?:get|list|search|create|update)Confluence(?:Content|Spaces?|Comments?|Attachments?)?(?![A-Za-z0-9])/;

/** True for the v2 remote MCP address (`/v2/…`). */
export function isAtlassianV2Url(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return /^\/v2(?:\/|$)/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** The row a signed-in user should have. `url` is the org package's address
 *  when it names one (org-harness-sync §3.10, `atlassianMcpUrl`). */
export function atlassianOAuthEntry(url: string = ATLASSIAN_MCP_URL): McpEntry {
  return {
    name: ATLASSIAN_MCP_SERVER_NAME,
    transport: 'http',
    url,
    auth: 'oauth',
    status: 'enabled',
  };
}

export type AtlassianRowShape = 'none' | 'legacy' | 'oauth' | 'other';

/** What the `atlassian` row is today. `legacy` = the API-token stdio row (§4.4
 *  step 1, "OAuth 전환 대기"). */
export function atlassianRowShape(store: Pick<Store, 'listMcpEntries'>): AtlassianRowShape {
  const row = store.listMcpEntries().find((e) => e.name === ATLASSIAN_MCP_SERVER_NAME);
  if (!row) return 'none';
  if (row.transport === 'stdio') return 'legacy';
  if (row.auth === 'oauth') return 'oauth';
  return 'other';
}

export type AtlassianLegacyRef = {
  kind: 'policy' | 'skill' | 'subagent' | 'command';
  scope: HarnessScope;
  scopeKey: string;
  id: string;
  name: string;
  ref: string;
  /** The v2 name to use instead, when there is a one-to-one one. */
  suggest?: string;
};

type LegacyHit = { ref: string; suggest?: string };

function legacyMatch(text: string | undefined, v2: boolean): LegacyHit | undefined {
  if (!text) return undefined;
  const m = LEGACY_ATLASSIAN_TOOL_RE.exec(text);
  if (m) return { ref: m[0].replace(/^[^A-Za-z0-9_]/, '') };
  if (!v2) return undefined;
  // A v1 name is stale on v2 unless the same text also names the v2 tool — a
  // skill written for both servers (v1 and v2 names side by side) is fine.
  for (const hit of text.matchAll(V1_ONLY_RE)) {
    const v1 = hit[1]!;
    const suggest = ATLASSIAN_V1_TO_V2_TOOL[v1];
    const covered = suggest
      ? new RegExp(`(?<![A-Za-z0-9])${suggest}(?![A-Za-z0-9])`).test(text)
      : V2_CONFLUENCE_RE.test(text);
    if (!covered) return { ref: hit[0], ...(suggest ? { suggest } : {}) };
  }
  return undefined;
}

type ScanStore = Pick<Store, 'listPolicyRules' | 'listHarness' | 'listProjects'>;

function scopes(store: ScanStore, userId: string): { scope: HarnessScope; scopeKey: string }[] {
  const out: { scope: HarnessScope; scopeKey: string }[] = [
    { scope: 'user', scopeKey: userId },
    { scope: 'org', scopeKey: 'default' },
  ];
  try {
    for (const p of store.listProjects()) out.push({ scope: 'project', scopeKey: p.cwd });
  } catch {
    /* a minimal store */
  }
  return out;
}

/** Rules and harness rows that still name an mcp-atlassian tool (§4.4 step 4),
 *  and — with `v2` — a v1 Confluence tool v2 does not have (§3.10). */
export function findLegacyAtlassianToolRefs(
  store: ScanStore,
  userId = DEFAULT_USER_ID,
  opts: { v2?: boolean } = {},
): AtlassianLegacyRef[] {
  const v2 = opts.v2 === true;
  const out: AtlassianLegacyRef[] = [];
  for (const s of scopes(store, userId)) {
    try {
      for (const r of store.listPolicyRules(s.scope, s.scopeKey)) {
        const hit = legacyMatch(r.toolPattern, v2);
        if (hit) out.push({ kind: 'policy', scope: s.scope, scopeKey: s.scopeKey, id: r.id, name: r.toolPattern, ...hit });
      }
    } catch {
      /* no rules table */
    }
    let rows: HarnessItem[] = [];
    try {
      rows = store.listHarness(s.scope, s.scopeKey);
    } catch {
      rows = [];
    }
    for (const row of rows) {
      if (row.status === 'removed') continue;
      const texts: string[] = [];
      if (row.skill) texts.push(...(row.skill.toolRefs ?? []), row.skill.instructions);
      if (row.subagent) texts.push(...(row.subagent.toolRefs ?? []), row.subagent.systemPrompt);
      if (row.command?.template) texts.push(row.command.template);
      for (const t of texts) {
        const hit = legacyMatch(t, v2);
        if (hit) {
          out.push({
            kind: row.kind === 'skill' ? 'skill' : row.kind === 'subagent' ? 'subagent' : 'command',
            scope: s.scope,
            scopeKey: s.scopeKey,
            id: row.id,
            name: row.name,
            ...hit,
          });
          break;
        }
      }
    }
  }
  return out;
}

export type ConfluenceUploadWithdrawal = 'withdrawn' | 'kept' | 'absent' | 'already';

function bodyDigest(body: string): string {
  return createHash('sha256').update(body.replace(/\r\n/g, '\n').trim()).digest('hex');
}

/**
 * Withdraw the built-in `confluence-upload` (§4.4). Untouched ⇔ its status still
 * equals what the built-in switch last wrote AND its body is the shipped one AND
 * it still carries the built-in origin. Anything else is the user's.
 */
export function withdrawBuiltinConfluenceUpload(
  store: Pick<Store, 'listHarness' | 'putHarnessItem' | 'setHarnessStatus' | 'getSetting'>,
  userId = DEFAULT_USER_ID,
): ConfluenceUploadWithdrawal {
  const row = store
    .listHarness('user', userId, { kind: 'skill' })
    .find((r) => r.name === CONFLUENCE_UPLOAD_SKILL);
  if (!row) return 'absent';
  const origin = row.provenance.origin ?? '';
  if (origin.startsWith(BUILTIN_WITHDRAWN_ORIGIN_PREFIX)) return 'already';
  if (row.status === 'removed') return 'absent'; // the user deleted it: theirs
  const recorded = store.getSetting(CONFLUENCE_UPLOAD_AUTO_STATUS_KEY)?.trim() || 'disabled';
  const untouched =
    origin === `${BUILTIN_ORIGIN_PREFIX}${CONFLUENCE_UPLOAD_SKILL}` &&
    row.status === recorded &&
    SHIPPED_CONFLUENCE_UPLOAD_BODY_SHA256.includes(bodyDigest(row.skill?.instructions ?? ''));
  if (!untouched) return 'kept';
  const { id: _id, createdAt: _c, updatedAt: _u, status: _s, ...item } = row;
  const written = store.putHarnessItem({
    item: { ...item, provenance: { ...row.provenance, origin: `${BUILTIN_WITHDRAWN_ORIGIN_PREFIX}${CONFLUENCE_UPLOAD_SKILL}` } },
    requestedStatus: row.status,
  });
  store.setHarnessStatus(written.id, 'removed');
  return 'withdrawn';
}

export type AtlassianMigrationReport = {
  at: number;
  /** What the row was before the swap. */
  from: AtlassianRowShape;
  confluenceUpload: ConfluenceUploadWithdrawal;
  /** Old tool names still referenced (counted, never rewritten). */
  legacyRefs: AtlassianLegacyRef[];
};

export function readAtlassianMigrationReport(store: Pick<Store, 'getSetting'>): AtlassianMigrationReport | undefined {
  const raw = store.getSetting(ATLASSIAN_MIGRATION_SETTING.report)?.trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as AtlassianMigrationReport;
  } catch {
    return undefined;
  }
}

/**
 * The old-name warning as of NOW (§3.10): the store's rules and harness rows
 * against the server the `atlassian` row points at. The swap's report only ever
 * counted mcp-atlassian names, once, at the API-token → OAuth swap; a later move
 * from v1 to v2 renamed Confluence tools and nothing re-counted. Settings reads
 * this instead. Empty unless the row is the OAuth row.
 */
export function currentLegacyAtlassianToolRefs(
  store: ScanStore & Pick<Store, 'listMcpEntries'>,
  userId = DEFAULT_USER_ID,
): AtlassianLegacyRef[] {
  const row = store.listMcpEntries().find((e) => e.name === ATLASSIAN_MCP_SERVER_NAME);
  if (!row || row.transport === 'stdio' || row.auth !== 'oauth') return [];
  return findLegacyAtlassianToolRefs(store, userId, { v2: isAtlassianV2Url(row.url) });
}

export type AtlassianSwapStore = Pick<
  Store,
  | 'listMcpEntries'
  | 'upsertMcpEntry'
  | 'listHarness'
  | 'putHarnessItem'
  | 'setHarnessStatus'
  | 'getSetting'
  | 'setSetting'
  | 'listPolicyRules'
  | 'listProjects'
>;

/**
 * THE TURN-BOUNDARY ENTRY POINT (§4.4 step 3). A no-op unless the OAuth sign-in
 * exists and the row is not already the OAuth row. An agent-PROPOSED row is never
 * touched (a human approves those). Idempotent.
 */
export function applyAtlassianOAuthSwapIfDue(
  store: AtlassianSwapStore,
  opts: { now?: number; userId?: string } = {},
): AtlassianMigrationReport | undefined {
  if (mcpOAuthStatus(store, ATLASSIAN_MCP_SERVER_NAME) !== 'connected') return undefined;
  const row = store.listMcpEntries().find((e) => e.name === ATLASSIAN_MCP_SERVER_NAME);
  const from = atlassianRowShape(store);
  if (from === 'oauth') return undefined;
  if (row?.status === 'proposed') return undefined;
  // Same name, replaced whole: the stdio command, the env with the API token and
  // the Confluence URL are not carried into the new row.
  const url = atlassianMcpUrl(store);
  store.upsertMcpEntry(atlassianOAuthEntry(url));
  const userId = opts.userId ?? DEFAULT_USER_ID;
  // Only a user who HAD the API-token preset ever had the withdrawal to make; a
  // first-time sign-in still withdraws an untouched seed (§4.4: the skill is not
  // shipped any more), which is a no-op when no row exists.
  const confluenceUpload = withdrawBuiltinConfluenceUpload(store, userId);
  const report: AtlassianMigrationReport = {
    at: opts.now ?? Date.now(),
    from,
    confluenceUpload,
    legacyRefs: from === 'legacy' ? findLegacyAtlassianToolRefs(store, userId, { v2: isAtlassianV2Url(url) }) : [],
  };
  store.setSetting(ATLASSIAN_MIGRATION_SETTING.report, JSON.stringify(report));
  return report;
}
