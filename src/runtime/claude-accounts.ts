// src/runtime/claude-accounts.ts
//
// MORE THAN ONE CLAUDE SUBSCRIPTION, CHOSEN BY HAND (claude-multi-account §5).
//
// WHAT THIS MODULE IS. A NAMESPACE ALLOCATOR AND A LIST. Nothing here reads or
// writes a credential, because the whole design rests on one fact: Claude Code
// partitions its own credentials BY CONFIG DIRECTORY. With `CLAUDE_CONFIG_DIR`
// set, the macOS Keychain service name gets that path's hash appended, and the
// plaintext credential file and the identity file (`.claude.json`) move into that
// directory too. Measured on a signed-in machine: pointing `claude auth status`
// at a different directory answered "fully signed out" while the real sign-in
// stayed untouched.
//
// So switching accounts is NOT swapping credentials — no backup, no restore, no
// rollback, nothing that can half-fail and log the user out of the terminal
// `claude` they also use. It is choosing WHICH NAMESPACE the child process looks
// at. naby creates a directory and sets one environment variable; the CLI fills
// it in. That is the entire mechanism, and it is why this module can be honest
// about never touching secrets: it has no code that could.
//
// WHAT LIVES HERE vs IN `engines/claude-accounts.ts`. This half is pure and
// store-backed — paths, ids, the environment rule, the metadata list. The other
// half drives the `claude` CLI (probe / add / verify / remove) and therefore
// imports `engines/claude-login.ts`. The split is not taste: the Agent SDK engine
// needs the ENVIRONMENT RULE on its turn path, and `claude-login.ts` imports the
// engine, so a single module would close an import cycle through the engine's own
// module graph. Keeping the pure half free of engine imports keeps that graph a
// tree.
//
// THREE RULES THIS MODULE OBEYS
//
//   1. AN ACCOUNT ID IS OPAQUE AND MINTED HERE. Never derived from an email: an
//      email can change under the same account, and one person can hold two
//      accounts (personal and work seat) that report the SAME email in different
//      organisations. An id derived from identity would collide exactly there.
//   2. NO TOKEN IS EVER STORED. The metadata is labels — the email, org and plan
//      the CLI last reported — plus timestamps. Everything secret stays inside
//      the config directory, owned by the CLI.
//   3. A PATH NEVER LEAVES THE RUNTIME. The API and the UI trade in account ids
//      only (§5.6). If a path went to the renderer there would soon be an API
//      that accepts one back, and that is arbitrary-path injection with extra
//      steps. `claudeAccountConfigDir` refuses any id it did not mint.

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configuredNabyHome } from './naby-home.js';
import type { Store } from './store/store.js';

// ---------------------------------------------------------------------------
// The contract, as constants
// ---------------------------------------------------------------------------

/** Where per-account config directories live, under the naby home. */
export const CLAUDE_ACCOUNTS_DIR_NAME = 'claude-accounts';

/** The environment variable Claude Code partitions its credentials by. Named
 *  once, here, because the whole feature is this string. */
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/** Settings keys. Namespaced like every other setting so a future key cannot
 *  collide (settings.ts SETTING_KEYS is the precedent). */
export const CLAUDE_ACCOUNTS_KEY = 'claude.accounts';
export const CLAUDE_ACTIVE_ACCOUNT_KEY = 'claude.activeAccount';
export const CLAUDE_ACCOUNT_ISOLATION_KEY = 'claude.accountIsolation';

/**
 * WHY THE SETTINGS TABLE AND NOT A NEW TABLE OR A JSON FILE.
 *
 *   * A new table would need a migration for data that is a handful of rows a
 *     user edits by hand, and the store's migration budget is better spent on
 *     things turns depend on.
 *   * A JSON file beside the database would be a second home resolver and a
 *     second thing to back up — the exact duplication `naby-home.ts` exists to
 *     prevent.
 *   * The settings table already holds structured JSON for precisely this shape
 *     of data (the model catalogue cache, `models.claude.cache`, and the shell's
 *     Telegram config), it is in `app.db` (the one file naby claims), and it is
 *     what `gate.allowChanges` and the model picks use. Following it means the
 *     account list is exported, backed up and migrated by whatever already
 *     handles the database.
 */

/** A brand-new account id: `acct-` plus 12 hex characters from a UUID. Opaque by
 *  construction — see rule 1 in the header. */
export function newClaudeAccountId(): string {
  return `acct-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/** Whether a string is an id THIS module minted. The gate on path building: an
 *  id from anywhere else (a request body, a hand-edited setting) is refused
 *  rather than joined onto the accounts root. */
export function isClaudeAccountId(id: unknown): id is string {
  return typeof id === 'string' && /^acct-[0-9a-f]{12}$/.test(id);
}

// ---------------------------------------------------------------------------
// What we remember about an account (labels only)
// ---------------------------------------------------------------------------

/** What the last `claude auth status` in this account's environment said. */
export type ClaudeAccountStatus = 'signed-in' | 'signed-out' | 'unknown';

/**
 * One account, as naby remembers it. Every field is a LABEL or a timestamp; there
 * is deliberately no path field, and no token field could be added without
 * breaking rule 2.
 */
export type ClaudeAccountMeta = {
  /** The opaque id. Also the directory name, but the UI is never told that. */
  id: string;
  /** When the user added it (epoch ms). Used to order the list stably. */
  addedAt: number;
  /** The identity the CLI last reported for this namespace, or null when it has
   *  never answered (a login that has not landed yet). */
  email: string | null;
  orgName: string | null;
  subscriptionType: string | null;
  /** What that answer was, and when. `checkedAt` is null before the first check. */
  status: ClaudeAccountStatus;
  checkedAt: number | null;
};

/**
 * Whether credentials really are partitioned on THIS machine (§5.3).
 *
 *   ok       a freshly created, empty config directory reported SIGNED OUT — the
 *            partition holds, so a second account is a real second account.
 *   broken   that same empty directory reported SIGNED IN, which can only mean
 *            the CLI is reading a credential store the directory does not
 *            control. Multi-account is then a lie and the feature hides itself.
 *   unknown  we could not ask (no CLI, no named home). Not proof of failure, so
 *            the feature stays available and single-account behaviour is
 *            unchanged either way.
 */
export type ClaudeAccountIsolation = 'ok' | 'broken' | 'unknown';

// ---------------------------------------------------------------------------
// Where the directories live
// ---------------------------------------------------------------------------

/**
 * The accounts root, or undefined when this process must not create one.
 *
 * THE SAME RULE AS THE ACTIVITY LOG AND THE JOB RUNNER, for the same reason: only
 * a home somebody NAMED (`NABY_DB_PATH` / `NABY_HOME` / `COCKPIT_HOME`) counts,
 * and `nabyHomeDir()`'s `~/.naby` default is deliberately not used. A spike drives
 * this code with no home configured, and a default would have it create
 * directories — and, on the add path, run `claude auth` against them — inside the
 * developer's real naby home. Both production launch paths set the environment at
 * boot (electron/boot.ts), so nothing real loses the feature.
 */
export function claudeAccountsRoot(): string | undefined {
  const home = configuredNabyHome();
  return home ? join(home, CLAUDE_ACCOUNTS_DIR_NAME) : undefined;
}

/**
 * The config directory for one account, or undefined when the id is not one of
 * ours or no home was named. A PURE function of the id and the environment —
 * which is what makes the layout assertable from a spike rather than only from a
 * running app.
 */
export function claudeAccountConfigDir(id: string): string | undefined {
  if (!isClaudeAccountId(id)) return undefined;
  const root = claudeAccountsRoot();
  return root ? join(root, id) : undefined;
}

/**
 * THE ENVIRONMENT RULE, in one place.
 *
 * The Agent SDK's `env` option REPLACES the child process's environment — it is
 * not merged (sdk.d.ts: "this value REPLACES the subprocess environment entirely
 * … Spread `process.env` yourself"). A caller that passes `{ CLAUDE_CONFIG_DIR }`
 * alone launches a CLI with no `PATH` and no `HOME`, which fails as "the model
 * could not start" — a symptom that names nothing. So the spread lives here, is
 * used by every caller, and is pinned by a spike assertion.
 */
export function claudeAccountEnv(
  configDir: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...base, [CLAUDE_CONFIG_DIR_ENV]: configDir };
}

/** The environment for one account, or undefined when the id is unknown or no
 *  home was named. The one function callers outside this module should need. */
export function claudeAccountEnvFor(
  id: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv | undefined {
  const dir = claudeAccountConfigDir(id);
  return dir ? claudeAccountEnv(dir, base) : undefined;
}

/** Create an account's directory (idempotent). Returns the path, or undefined
 *  when it could not be created — never throws into a request handler. */
export function ensureClaudeAccountDir(id: string): string | undefined {
  const dir = claudeAccountConfigDir(id);
  if (!dir) return undefined;
  try {
    mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return undefined;
  }
}

/**
 * Delete an account's directory.
 *
 * ORDER MATTERS AND IT IS NOT ENFORCEABLE HERE — the caller must run
 * `claude auth logout` in this account's environment FIRST. Once the directory is
 * gone, the path hash that names its Keychain entry is gone with it, and that
 * entry can never be removed. See `removeClaudeAccount` in
 * `engines/claude-accounts.ts`, which is the only caller and does it in that
 * order.
 */
export function removeClaudeAccountDir(id: string): boolean {
  const dir = claudeAccountConfigDir(id);
  if (!dir) return false;
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The list, in the settings table
// ---------------------------------------------------------------------------

function isMeta(value: unknown): value is ClaudeAccountMeta {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return isClaudeAccountId(v.id) && typeof v.addedAt === 'number';
}

/** Normalise a stored row: unknown/absent fields become the honest null, and a
 *  status we do not recognise becomes 'unknown' rather than being believed. */
function toMeta(v: Record<string, unknown>): ClaudeAccountMeta {
  const status = v.status;
  return {
    id: String(v.id),
    addedAt: Number(v.addedAt),
    email: typeof v.email === 'string' && v.email ? v.email : null,
    orgName: typeof v.orgName === 'string' && v.orgName ? v.orgName : null,
    subscriptionType:
      typeof v.subscriptionType === 'string' && v.subscriptionType ? v.subscriptionType : null,
    status:
      status === 'signed-in' || status === 'signed-out' || status === 'unknown'
        ? status
        : 'unknown',
    checkedAt: typeof v.checkedAt === 'number' ? v.checkedAt : null,
  };
}

/** Every account naby knows about, oldest first. A malformed setting reads as an
 *  empty list — a settings row a user hand-edited into nonsense must not take the
 *  settings screen down with it. */
export function listClaudeAccounts(store: Store): ClaudeAccountMeta[] {
  const raw = store.getSetting(CLAUDE_ACCOUNTS_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isMeta)
      .map((v) => toMeta(v as unknown as Record<string, unknown>))
      .sort((a, b) => a.addedAt - b.addedAt);
  } catch {
    return [];
  }
}

/** Replace the whole list. Private-ish: callers use upsert/delete below. */
function writeClaudeAccounts(store: Store, accounts: ClaudeAccountMeta[]): void {
  store.setSetting(CLAUDE_ACCOUNTS_KEY, JSON.stringify(accounts));
}

/** Add or replace one account's metadata, keeping the list ordered by `addedAt`. */
export function upsertClaudeAccount(store: Store, meta: ClaudeAccountMeta): void {
  const next = listClaudeAccounts(store).filter((a) => a.id !== meta.id);
  next.push(meta);
  next.sort((a, b) => a.addedAt - b.addedAt);
  writeClaudeAccounts(store, next);
}

/** Forget one account's metadata. Does NOT touch its directory — see
 *  `removeClaudeAccountDir` for why the order is the caller's responsibility. */
export function deleteClaudeAccountMeta(store: Store, id: string): void {
  writeClaudeAccounts(
    store,
    listClaudeAccounts(store).filter((a) => a.id !== id),
  );
}

/**
 * WHICH account answers turns right now, or undefined for "none — behave exactly
 * as a single-account install always has".
 *
 * SELF-HEALING BY DESIGN: an id that is no longer in the list (a row removed
 * outside the remove path, a restored database) reads as undefined rather than
 * pointing turns at a directory nobody owns.
 */
export function activeClaudeAccountId(store: Store): string | undefined {
  const id = store.getSetting(CLAUDE_ACTIVE_ACCOUNT_KEY)?.trim();
  if (!id || !isClaudeAccountId(id)) return undefined;
  return listClaudeAccounts(store).some((a) => a.id === id) ? id : undefined;
}

/** Choose the account (or '' / null for none). The caller owns the policy around
 *  it — refusing mid-turn (§5.4), resetting the login cache, and writing the
 *  activity-log line (§5.5) — because those are decisions, not storage. */
export function setActiveClaudeAccount(store: Store, id: string | null): void {
  store.setSetting(CLAUDE_ACTIVE_ACCOUNT_KEY, id && isClaudeAccountId(id) ? id : '');
}

/** The stored isolation verdict. Unset reads as 'unknown' — we have not asked. */
export function readClaudeAccountIsolation(store: Store): ClaudeAccountIsolation {
  const v = store.getSetting(CLAUDE_ACCOUNT_ISOLATION_KEY)?.trim();
  return v === 'ok' || v === 'broken' ? v : 'unknown';
}

export function writeClaudeAccountIsolation(store: Store, verdict: ClaudeAccountIsolation): void {
  store.setSetting(CLAUDE_ACCOUNT_ISOLATION_KEY, verdict);
}

/**
 * Whether to OFFER multi-account at all (§5.3).
 *
 * Hidden only on proof of failure. 'unknown' keeps it visible because we have not
 * shown that it cannot work, and the cost of being wrong is one refused add with
 * a clear message — whereas hiding a feature that works leaves the user with no
 * way to discover it and nothing to read.
 */
export function claudeAccountsSupported(store: Store): boolean {
  return readClaudeAccountIsolation(store) !== 'broken' && claudeAccountsRoot() !== undefined;
}
