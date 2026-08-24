// src/engines/claude-hud-usage.ts
//
// THE SECOND OPINION ON "HOW MUCH IS LEFT" — Claude Code's own already-fetched
// usage cache, read from disk, and the guard that decides whether it is even
// talking about the same person.
//
// ===========================================================================
// AN AUTHORISED EXCEPTION, AND EXACTLY HOW FAR IT WAS TAKEN
// ===========================================================================
//
// naby's Claude integration has one standing rule, stated at the head of
// `engines/claude-accounts.ts`: no code anywhere in naby reads or writes a
// credential. The whole multi-account design is built on being able to say that —
// switching accounts is choosing a `CLAUDE_CONFIG_DIR`, never moving secrets
// around.
//
// The product decision was to make ONE exception for Claude: take usage readings
// from both the Agent SDK and the CLI side, and believe whichever reports less
// headroom. Two mechanisms were on the table for the CLI side:
//
//   A. `~/.claude/.credentials.json` → `GET /api/oauth/usage` with the OAuth
//      token as a bearer header. This reads a credential and calls the network.
//   B. `~/.claude/.hud_cache` — a plain JSON cache of THAT ENDPOINT'S OWN
//      `five_hour` / `seven_day` objects, written every fifteen minutes by the
//      status-line poller that is already running on the machine.
//
// **B WAS CHOSEN, AND THE CREDENTIAL RULE THEREFORE STILL HOLDS UNBROKEN.** The
// exception was granted and did not need to be spent: B yields the SAME NUMBERS,
// in the same field names, on the same 0-100 scale (verified against a live file:
// `five_hour.utilization` 5, `seven_day.utilization` 84, `resets_at` an ISO 8601
// string with offset — identical in shape to the SDK response's windows). An
// authorised exception is not a free one, and A costs three things B does not:
// naby would have to touch a token, it would put an `Authorization` header in
// this codebase, and it would add load to an endpoint that is genuinely
// rate-limited (a live `rate_limit_error` was observed from it). B costs a
// `readFileSync` of a file that is not secret.
//
// So the invariant in `claude-accounts.ts` is amended to RECORD this — naby now
// reads one non-secret artifact of Claude Code's own directory — rather than to
// weaken it. No token is read here. No network call is made here.
//
// ===========================================================================
// THE PART THAT IS ACTUALLY DANGEROUS: WHOSE PLAN IS THIS?
// ===========================================================================
//
// `.hud_cache` describes whatever account owns the directory it sits in. naby is
// MULTI-ACCOUNT and isolates each subscription behind its own `CLAUDE_CONFIG_DIR`,
// so the account the current naby session is authenticated as can be a completely
// different subscription from the one Claude Code is signed into. Merging across
// those two produces a number that describes NEITHER account — and it fails in
// the worst available direction, because the merge takes the pessimistic reading:
// a stranger's exhausted week would silently become the user's.
//
// This module therefore refuses to merge unless the two are PROVABLY the same
// account. Two ways that is proved, in order:
//
//   1. SAME DIRECTORY. If the config directory naby's CLI child will use IS the
//      directory the cache came from, they are the same namespace and there is
//      nothing left to check. This is the single-account case — no naby account
//      chosen, no ambient `CLAUDE_CONFIG_DIR` — and it is the common one, where
//      the identity holds structurally rather than by comparison.
//   2. SAME `accountUuid`. Otherwise, compare the `oauthAccount` block of each
//      directory's `.claude.json`. That file is Claude Code's IDENTITY file, not
//      its credential file — it holds `accountUuid`, `emailAddress`,
//      `organizationUuid` and a pile of UI state, and no token. A user who has
//      signed the same subscription into both places legitimately gets the merge.
//
// ANYTHING ELSE REFUSES, INCLUDING "I COULD NOT TELL". Unreadable identity file,
// missing `accountUuid`, different uuids, no naby home to resolve against — all
// of them mean the CLI reading is dropped and the SDK reading stands alone. That
// is the conservative behaviour and it is the right default: the SDK reading is
// already correct for the account naby is using, so refusing to merge costs a
// second opinion, whereas merging wrongly costs the user a true one.
//
// `accountUuid` IS COMPARED, NOT `emailAddress`. One person can hold two accounts
// that report the same email in different organisations — the same reason
// `runtime/claude-accounts.ts` refuses to derive an account id from an email
// (rule 1 there). Email is read only to LABEL the comparison for a human reading
// a tooltip, never to decide it.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  CLAUDE_CONFIG_DIR_ENV,
  claudeAccountConfigDir,
} from '../runtime/claude-accounts.js';
import {
  parseHudUsage,
  SUBSCRIPTION_USAGE_MAX_STALE_MS,
  type SubscriptionUsage,
} from '../runtime/subscription-usage.js';

/** The status-line cache file, named once. */
export const HUD_CACHE_FILE = '.hud_cache';

/** Claude Code's identity file. NOT its credential file — see the header. */
export const CLAUDE_IDENTITY_FILE = '.claude.json';

/**
 * WHERE CLAUDE CODE KEEPS ITS STATE when no account has been chosen: the ambient
 * `CLAUDE_CONFIG_DIR` if the user set one, otherwise `~/.claude`.
 *
 * Read from a passed environment rather than from `process.env` directly so the
 * rule is assertable without mutating the process running the assertion — the
 * same argument `buildQueryOptions` makes about its own `env` parameter.
 */
export function defaultClaudeConfigDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configured = env[CLAUDE_CONFIG_DIR_ENV]?.trim();
  return configured ? resolve(configured) : join(home, '.claude');
}

/**
 * WHICH CONFIG DIRECTORY THE NABY SESSION'S CLI CHILD WILL ACTUALLY USE.
 *
 * With an account chosen this is that account's namespace; with none, it is
 * whatever the child would inherit — which is exactly what `probeClaudeUsage`
 * does, since it passes `env` only when an account is named. Returns undefined
 * when an id was given that does not resolve (not one we minted, or no naby home
 * configured); the caller treats that as "cannot tell" and refuses to merge.
 */
export function nabyClaudeConfigDir(
  accountId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string | undefined {
  if (!accountId) return defaultClaudeConfigDir(env, home);
  const dir = claudeAccountConfigDir(accountId);
  return dir ? resolve(dir) : undefined;
}

/**
 * WHERE THE IDENTITY FILE FOR A CONFIG DIRECTORY LIVES, and this is NOT uniform —
 * which is precisely why it is a named function with a test rather than a `join`
 * at each call site.
 *
 * With `CLAUDE_CONFIG_DIR` set, Claude Code moves `.claude.json` INSIDE that
 * directory (that relocation is the mechanism naby's whole multi-account design
 * rests on). With it unset, the file sits at `~/.claude.json` — BESIDE `~/.claude`,
 * not within it. Verified on a live machine: `~/.claude/.claude.json` does not
 * exist while `~/.claude.json` does. Getting this wrong would make every identity
 * comparison come back "cannot tell", which fails safe but silently disables the
 * whole second source — a bug that looks exactly like the feature working.
 *
 * `home` is passed so the default case can be located; `configDir` is compared
 * against the default rather than sniffed, so the two cases are decided by the
 * same rule that produced the directory in the first place.
 */
export function claudeIdentityPath(
  configDir: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const isDefaultHomeDir = resolve(configDir) === join(home, '.claude') && !env[CLAUDE_CONFIG_DIR_ENV]?.trim();
  return isDefaultHomeDir ? join(home, CLAUDE_IDENTITY_FILE) : join(configDir, CLAUDE_IDENTITY_FILE);
}

/** Who a config directory belongs to. `uuid` is what decides a comparison;
 *  `email` exists only so a human can be shown which two things were compared. */
export type ClaudeAccountIdentity = {
  uuid: string;
  email?: string;
};

/**
 * The `oauthAccount` identity of a config directory, or undefined.
 *
 * Reads ONE non-secret file and pulls TWO labels out of it. Undefined for every
 * failure — no file, unparseable JSON, no `oauthAccount`, no `accountUuid` —
 * because the caller's rule is "prove they match or do not merge", and an
 * unreadable identity proves nothing.
 *
 * Typed against `unknown` throughout: this is another program's file, its shape
 * is not ours, and it grows fields constantly.
 */
export function readClaudeIdentity(path: string): ClaudeAccountIdentity | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
  return readClaudeIdentityFrom(parsed);
}

/** The pure half of the above, so the shape rules are exercised against fixtures
 *  rather than against whatever happens to be on the developer's disk. */
export function readClaudeIdentityFrom(parsed: unknown): ClaudeAccountIdentity | undefined {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const acct = (parsed as { oauthAccount?: unknown }).oauthAccount;
  if (!acct || typeof acct !== 'object') return undefined;
  const a = acct as Record<string, unknown>;
  const uuid = typeof a.accountUuid === 'string' ? a.accountUuid.trim() : '';
  if (!uuid) return undefined;
  const email = typeof a.emailAddress === 'string' && a.emailAddress.trim() ? a.emailAddress.trim() : undefined;
  return { uuid, ...(email ? { email } : {}) };
}

/**
 * WHETHER TWO READINGS MAY BE MERGED AT ALL — the guard, as a pure decision.
 *
 * Same directory wins immediately (case 1 in the header). Otherwise both
 * identities must be present and their `accountUuid`s must be equal. Every other
 * combination — one missing, both missing, different uuids — is `false`.
 *
 * There is no third state. "Probably the same" is not a thing this can return,
 * because the caller would have to decide what to do with it and the only safe
 * answer is the one `false` already gives.
 */
export function sameClaudeAccount(args: {
  nabyConfigDir: string | undefined;
  cliConfigDir: string;
  nabyIdentity: ClaudeAccountIdentity | undefined;
  cliIdentity: ClaudeAccountIdentity | undefined;
}): boolean {
  if (!args.nabyConfigDir) return false;
  if (resolve(args.nabyConfigDir) === resolve(args.cliConfigDir)) return true;
  const a = args.nabyIdentity?.uuid;
  const b = args.cliIdentity?.uuid;
  return !!a && !!b && a === b;
}

/** Why the CLI reading was or was not used. Carried out of the read so the
 *  caller can log it and a tooltip can be honest about how many sources are
 *  behind a number, instead of the answer just silently being one source. */
export type ClaudeCliUsageReason =
  /** Merged: the two sources are provably the same account. */
  | 'same-account'
  /** A cache exists but belongs to a different (or unprovable) account. */
  | 'different-account'
  /** No cache file, or it did not parse. */
  | 'no-cache'
  /** A cache, but too old (or `_ok: false`) to be a reading. See the ceiling. */
  | 'stale-cache';

export type ClaudeCliUsageReading = {
  /** The reading, ONLY when it may be merged. Never populated for a refusal —
   *  so a caller that ignores `reason` still cannot merge across accounts. */
  usage: SubscriptionUsage | null;
  reason: ClaudeCliUsageReason;
};

/**
 * Read Claude Code's cache and decide whether it describes the account naby is
 * using.
 *
 * THE REFUSAL IS STRUCTURAL, NOT ADVISORY: on any refusal `usage` is null, so the
 * guard cannot be defeated by a caller that forgets to look at `reason`. The
 * reason exists for logging and for the tooltip, not as a thing to override.
 *
 * Never throws. Every disk and parse failure is one of the reasons above.
 */
export function readClaudeCliUsage(opts: {
  /** The naby account whose plan we are asking about; undefined = the single
   *  sign-in this computer has. */
  accountId?: string;
  now: number;
  maxAgeMs?: number;
  env?: NodeJS.ProcessEnv;
  home?: string;
}): ClaudeCliUsageReading {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const cliConfigDir = defaultClaudeConfigDir(env, home);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(cliConfigDir, HUD_CACHE_FILE), 'utf8'));
  } catch {
    return { usage: null, reason: 'no-cache' };
  }

  // FRESHNESS IS CHECKED BEFORE IDENTITY, deliberately: a stale cache is not a
  // reading no matter whose it is, and reporting 'different-account' for a file
  // that was simply old would send the next reader looking for a multi-account
  // bug that is not there.
  const usage = parseHudUsage(raw, {
    now: opts.now,
    maxAgeMs: opts.maxAgeMs ?? SUBSCRIPTION_USAGE_MAX_STALE_MS,
  });
  if (!usage) return { usage: null, reason: 'stale-cache' };

  const nabyConfigDir = nabyClaudeConfigDir(opts.accountId, env, home);
  if (!nabyConfigDir) return { usage: null, reason: 'different-account' };

  // CASE 1 FIRST, AND IT SHORT-CIRCUITS. Same directory is already proof, so the
  // two identity files are not read at all in the common single-account case —
  // and, more importantly, an unreadable `.claude.json` cannot refuse a merge
  // that the directory itself has already settled. (The argument list of
  // `sameClaudeAccount` is evaluated eagerly, so this had to be a branch here
  // rather than a lazy argument there.)
  const same =
    resolve(nabyConfigDir) === resolve(cliConfigDir) ||
    sameClaudeAccount({
      nabyConfigDir,
      cliConfigDir,
      nabyIdentity: readClaudeIdentity(claudeIdentityPath(nabyConfigDir, env, home)),
      cliIdentity: readClaudeIdentity(claudeIdentityPath(cliConfigDir, env, home)),
    });
  if (!same) return { usage: null, reason: 'different-account' };
  return { usage, reason: 'same-account' };
}
