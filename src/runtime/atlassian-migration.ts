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

/** The row a signed-in user should have. */
export function atlassianOAuthEntry(): McpEntry {
  return {
    name: ATLASSIAN_MCP_SERVER_NAME,
    transport: 'http',
    url: ATLASSIAN_MCP_URL,
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
};

function legacyMatch(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = LEGACY_ATLASSIAN_TOOL_RE.exec(text);
  return m ? m[0].replace(/^[^A-Za-z0-9_]/, '') : undefined;
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

/** Rules and harness rows that still name an mcp-atlassian tool (§4.4 step 4). */
export function findLegacyAtlassianToolRefs(store: ScanStore, userId = DEFAULT_USER_ID): AtlassianLegacyRef[] {
  const out: AtlassianLegacyRef[] = [];
  for (const s of scopes(store, userId)) {
    try {
      for (const r of store.listPolicyRules(s.scope, s.scopeKey)) {
        const ref = legacyMatch(r.toolPattern);
        if (ref) out.push({ kind: 'policy', scope: s.scope, scopeKey: s.scopeKey, id: r.id, name: r.toolPattern, ref });
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
        const ref = legacyMatch(t);
        if (ref) {
          out.push({
            kind: row.kind === 'skill' ? 'skill' : row.kind === 'subagent' ? 'subagent' : 'command',
            scope: s.scope,
            scopeKey: s.scopeKey,
            id: row.id,
            name: row.name,
            ref,
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
  store.upsertMcpEntry(atlassianOAuthEntry());
  const userId = opts.userId ?? DEFAULT_USER_ID;
  // Only a user who HAD the API-token preset ever had the withdrawal to make; a
  // first-time sign-in still withdraws an untouched seed (§4.4: the skill is not
  // shipped any more), which is a no-op when no row exists.
  const confluenceUpload = withdrawBuiltinConfluenceUpload(store, userId);
  const report: AtlassianMigrationReport = {
    at: opts.now ?? Date.now(),
    from,
    confluenceUpload,
    legacyRefs: from === 'legacy' ? findLegacyAtlassianToolRefs(store, userId) : [],
  };
  store.setSetting(ATLASSIAN_MIGRATION_SETTING.report, JSON.stringify(report));
  return report;
}
