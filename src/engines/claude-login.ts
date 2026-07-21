// src/engines/claude-login.ts
//
// IS THE LOCAL CLAUDE SIGN-IN PRESENT AND USABLE?
//
// The dev engine (`ClaudeAgentSdkEngine`) answers on the Claude sign-in that
// already exists on this computer — no API key, no metered bill. That is a
// lovely property right up to the moment the sign-in is absent or stale, at
// which point the app looked fine, accepted a message, and only then failed
// with whatever the Agent SDK chose to throw. The user had no way to know
// beforehand and no idea what to do afterwards.
//
// This module answers the question BEFORE a turn, cheaply, so the UI can show
// it next to the engine choice and say `claude login` when the answer is no.
//
// WHAT IT DELIBERATELY DOES NOT DO
// --------------------------------
//   * It never makes a model call. "Are you signed in" answered by spending
//     money (or by consuming rate limit) is not an answer worth having, and a
//     status indicator that bills the user on a poll is a bug, not a feature.
//   * It never runs the `claude` CLI interactively, and never runs it at all on
//     the hot path — `claude --version` is a subprocess spawn (~100ms+), which
//     is far too expensive for something polled and re-run on window focus.
//     The CLI is looked for on PATH by FILE RESOLUTION only (see `findClaudeCli`).
//   * It never returns, logs, includes in an error message, or retains any
//     credential material. The file is parsed in order to read exactly two
//     numbers — the two expiry timestamps — and every other field is dropped on
//     the floor by destructuring before the parsed value goes out of scope. The
//     RESULT type has no field that could carry a token even by accident.
//
// WHY PARSE AT ALL RATHER THAN JUST `existsSync`
// ----------------------------------------------
// Existence is not usability. `~/.claude/.credentials.json` survives a token
// expiring, so an existence-only check reports "signed in" on exactly the
// machine this feature exists to warn — the one where the next send will fail.
// The two expiry fields distinguish the three real cases:
//
//   accessToken live                    -> signed in
//   accessToken stale, refreshToken live -> signed in (the CLI refreshes
//                                           silently on first use; warning here
//                                           would be a false alarm)
//   both stale                           -> signed out, and `claude login` is
//                                           genuinely the fix
//
// UNKNOWN IS A REAL ANSWER. A malformed file, an unreadable one, or a Claude
// install that keeps its credentials somewhere we do not model (a future
// keychain-backed layout, an enterprise SSO variant) must not be reported as
// "signed out" — that would tell the user to run a command that fixes nothing.
// `unknown` renders as a muted dot and blocks nothing.

import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

export type ClaudeLoginStatus = 'signed-in' | 'signed-out' | 'unknown';

/**
 * WHICH account is signed in — as much as the credential file honestly tells us.
 *
 * IMPORTANT: the Claude Code OAuth credential file carries NO email and NO
 * account id. Its only human-facing identity fields are the SUBSCRIPTION tier
 * (`subscriptionType`, e.g. "max"/"pro") and a rate-limit tier. We surface those
 * and nothing else — inventing an email from what is not there would be worse
 * than saying "signed in" plainly. Both fields are labels, not secrets: no token
 * material reaches this type.
 */
export type ClaudeLoginAccount = {
  /** The plan label from the credential (e.g. 'max', 'pro'), or `null` when the
   *  file does not carry one. Never an email — the file has none. */
  subscriptionType: string | null;
  /** The rate-limit tier label, when present (e.g. 'default_claude_max_5x').
   *  Purely informational; `null` when absent. */
  rateLimitTier: string | null;
};

export type ClaudeLoginState = {
  status: ClaudeLoginStatus;
  /** One sentence for a non-developer. Never contains a path to a secret and
   *  never contains credential material. */
  summary: string;
  /** The command that fixes it, when there is one. `null` when nothing is
   *  wrong or when we cannot tell what is wrong. */
  remedy: string | null;
  /** Whether a `claude` executable is resolvable on PATH. Reported separately
   *  because "signed out" and "not installed" need different advice. */
  cliFound: boolean;
  /** When this answer was computed (epoch ms). The UI shows staleness rather
   *  than pretending a cached answer is live. */
  checkedAt: number;
  /** Who is signed in, to the extent the credential file says so. `null` when
   *  signed out, unknown, or when the file carries no identity fields. NEVER an
   *  email (the file has none) — see `ClaudeLoginAccount`. */
  account: ClaudeLoginAccount | null;
};

/** The command a signed-out user runs. Named so the string exists once. */
export const CLAUDE_LOGIN_COMMAND = 'claude login';

// ---------------------------------------------------------------------------
// Where the sign-in lives
// ---------------------------------------------------------------------------

/**
 * The credential file Claude Code writes on `claude login`.
 *
 * `CLAUDE_CONFIG_DIR` is honoured because Claude Code honours it; a developer
 * who has relocated their config would otherwise get a permanent, unfixable
 * "signed out" from us while the CLI works perfectly.
 */
export function claudeCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
  return join(dir, '.credentials.json');
}

/**
 * Whether a `claude` executable exists, WITHOUT spawning one.
 *
 * `claude --version` would be the obvious check and is the wrong one: this
 * function runs on every poll and every window focus, and a subprocess spawn per
 * focus event is exactly the kind of chatty background work the feature was
 * asked not to introduce. Resolution is a handful of `stat` calls.
 */
function findClaudeCli(env: NodeJS.ProcessEnv = process.env): boolean {
  const pathVar = env.PATH || '';
  if (!pathVar) return false;
  const sep = process.platform === 'win32' ? ';' : ':';
  // On Windows the executable carries an extension; PATHEXT is the authority on
  // which. Elsewhere the bare name is the whole story.
  const candidates =
    process.platform === 'win32'
      ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map((ext) => `claude${ext.toLowerCase()}`)
      : ['claude'];
  for (const dir of pathVar.split(sep)) {
    if (!dir) continue;
    for (const name of candidates) {
      try {
        // `statSync` follows symlinks, which is what we want: every npm-global
        // and shim install of the CLI is a symlink to the real script.
        if (statSync(join(dir, name)).isFile()) return true;
      } catch {
        // Not here. Next candidate — a missing directory on PATH is normal.
      }
    }
  }
  return false;
}

/**
 * Whether the Agent SDK itself is present. Reused rather than reimplemented so
 * "the dev engine can run" has one definition. Imported lazily through
 * `createRequire` for the same reason the engine does — see the header of
 * `claude-agent-sdk-engine.ts`.
 */
function agentSdkResolvable(): boolean {
  try {
    createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * Read ONLY the two expiry timestamps out of the credential file.
 *
 * This is the single function in the codebase that touches the file's bytes,
 * and it is written so that nothing else can leak: the parsed object is local,
 * only two numbers escape, and the catch swallows the error rather than
 * propagating it — a JSON parse error message can quote the offending input,
 * which for this file would mean a token in a stack trace.
 */
function readExpiries(
  path: string,
): { present: false } | {
  present: true;
  expiresAt?: number;
  refreshExpiresAt?: number;
  /** Non-secret identity labels — see `ClaudeLoginAccount`. Read here because
   *  this is the ONE function allowed to touch the file's bytes; only these
   *  small strings escape, never a token. */
  subscriptionType?: string;
  rateLimitTier?: string;
} {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    // ENOENT (never logged in), EACCES (someone else's file), EISDIR — all of
    // which mean "no usable sign-in here" and none of which we can act on
    // differently.
    return { present: false };
  }
  try {
    const parsed = JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> };
    const oauth = parsed.claudeAiOauth;
    if (!oauth || typeof oauth !== 'object') {
      // The file exists but is not the shape we model. Present, no expiries →
      // the caller reports `unknown`, not `signed-out`.
      return { present: true };
    }
    const expiresAt = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined;
    const refreshExpiresAt =
      typeof oauth.refreshTokenExpiresAt === 'number' ? oauth.refreshTokenExpiresAt : undefined;
    // Identity labels: strings only, and only when non-empty. These are the
    // ONLY human-facing account fields the file carries — there is no email.
    const subscriptionType =
      typeof oauth.subscriptionType === 'string' && oauth.subscriptionType
        ? oauth.subscriptionType
        : undefined;
    const rateLimitTier =
      typeof oauth.rateLimitTier === 'string' && oauth.rateLimitTier
        ? oauth.rateLimitTier
        : undefined;
    return { present: true, ...(expiresAt !== undefined ? { expiresAt } : {}),
             ...(refreshExpiresAt !== undefined ? { refreshExpiresAt } : {}),
             ...(subscriptionType !== undefined ? { subscriptionType } : {}),
             ...(rateLimitTier !== undefined ? { rateLimitTier } : {}) };
  } catch {
    return { present: true };
  }
}

/** Build the account label object from whatever identity fields were present.
 *  Returns `null` when nothing usable was found, so the UI shows a plain
 *  "signed in" rather than an empty identity chip. */
function toAccount(creds: {
  subscriptionType?: string;
  rateLimitTier?: string;
}): ClaudeLoginAccount | null {
  if (creds.subscriptionType === undefined && creds.rateLimitTier === undefined) return null;
  return {
    subscriptionType: creds.subscriptionType ?? null,
    rateLimitTier: creds.rateLimitTier ?? null,
  };
}

export type CheckClaudeLoginOptions = {
  /** Override the environment. Used by the spikes so the signed-out branch is
   *  testable without touching the developer's real sign-in. */
  env?: NodeJS.ProcessEnv;
  /** Override "now" (epoch ms), so expiry handling is testable without waiting
   *  for a token to expire. */
  now?: number;
};

/**
 * The whole answer, computed from the filesystem. Synchronous and cheap
 * (a few `stat`s plus one small file read), so it is safe on a poll — but see
 * `getClaudeLoginState` for the cached, rate-limited entry point the UI uses.
 */
export function checkClaudeLogin(opts: CheckClaudeLoginOptions = {}): ClaudeLoginState {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const checkedAt = now;
  const cliFound = findClaudeCli(env);

  // An explicit OAuth token in the environment is how CI and some containerised
  // setups sign in; it bypasses the credential file entirely, so checking the
  // file first would report "signed out" on a machine that works.
  if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
    return {
      status: 'signed-in',
      summary: 'Signed in to Claude via CLAUDE_CODE_OAUTH_TOKEN in this environment.',
      remedy: null,
      cliFound,
      checkedAt,
      // An env token carries no subscription/identity fields we can read.
      account: null,
    };
  }

  const creds = readExpiries(claudeCredentialsPath(env));

  if (!creds.present) {
    return {
      status: 'signed-out',
      summary: cliFound
        ? 'Not signed in to Claude on this computer, so the development model cannot answer.'
        : 'Not signed in to Claude, and no `claude` command was found on this computer.',
      remedy: cliFound
        ? `Run \`${CLAUDE_LOGIN_COMMAND}\` in a terminal, then re-check.`
        : `Install the Claude Code CLI, then run \`${CLAUDE_LOGIN_COMMAND}\` in a terminal.`,
      cliFound,
      checkedAt,
      account: null,
    };
  }

  // Present but unmodelled shape → we genuinely do not know. Telling the user
  // to log in when they may already be logged in (via a layout we do not
  // recognise) is worse than admitting ignorance.
  if (creds.expiresAt === undefined && creds.refreshExpiresAt === undefined) {
    return {
      status: 'unknown',
      summary:
        'A Claude sign-in exists on this computer, but its status could not be determined. ' +
        'The development model will most likely work.',
      remedy: null,
      cliFound,
      checkedAt,
      // Present but unmodelled shape — surface whatever identity we did manage
      // to read (may be null).
      account: toAccount(creds),
    };
  }

  const accessLive = creds.expiresAt !== undefined && creds.expiresAt > now;
  // A live refresh token is as good as a live access token from the user's
  // point of view: the CLI/SDK exchanges it silently on first use. Warning here
  // would be a false alarm on any machine idle for more than a few hours.
  const refreshLive = creds.refreshExpiresAt !== undefined && creds.refreshExpiresAt > now;

  if (accessLive || refreshLive) {
    return {
      status: 'signed-in',
      summary: accessLive
        ? 'Signed in to Claude on this computer. The development model can answer with no API key.'
        : 'Signed in to Claude; the session will be renewed automatically on the next message.',
      remedy: null,
      cliFound,
      checkedAt,
      // The one place identity is genuinely meaningful: a live sign-in.
      account: toAccount(creds),
    };
  }

  return {
    status: 'signed-out',
    summary: 'The Claude sign-in on this computer has expired, so the development model cannot answer.',
    remedy: `Run \`${CLAUDE_LOGIN_COMMAND}\` in a terminal to sign in again, then re-check.`,
    cliFound,
    checkedAt,
    account: null,
  };
}

// ---------------------------------------------------------------------------
// The cached entry point
// ---------------------------------------------------------------------------

/**
 * How long an answer is reused. The underlying state changes when a human runs
 * `claude login` in another window, so a short TTL is right — but the UI polls
 * and also re-checks on every window focus, and focus events arrive in bursts
 * (alt-tab, notification, cmd-tab back). Without this, a user flicking between
 * windows would trigger a filesystem read per flick.
 */
const CACHE_MS = 10_000;

let cached: ClaudeLoginState | undefined;

/**
 * The entry point the shell calls. Same answer as `checkClaudeLogin`, but at
 * most one filesystem check per `CACHE_MS`.
 *
 * `force` exists for the "Re-check" the UI offers after telling the user to run
 * `claude login`: having just followed the instruction, the user must not be
 * shown a stale "signed out" for another ten seconds.
 */
export function getClaudeLoginState(
  opts: CheckClaudeLoginOptions & { force?: boolean } = {},
): ClaudeLoginState {
  const now = opts.now ?? Date.now();
  if (!opts.force && cached && now - cached.checkedAt < CACHE_MS) return cached;
  cached = checkClaudeLogin(opts);
  return cached;
}

/** Drop the cache. Exported for the spikes, which change the environment
 *  underneath the check and must not read a pre-change answer. */
export function resetClaudeLoginCache(): void {
  cached = undefined;
}

// ---------------------------------------------------------------------------
// Sign out
// ---------------------------------------------------------------------------

export type ClaudeLogoutResult =
  /** `removed` distinguishes "we deleted a live sign-in" from "there was nothing
   *  to delete" (already signed out) — both are success, but the UI can say so. */
  | { ok: true; removed: boolean }
  | { ok: false; error: string };

/**
 * Sign out by deleting the OAuth credential file — the same effect `claude
 * logout` has, and the only sign-out this app can perform without an
 * interactive CLI.
 *
 * SAFETY:
 *   * It only ever touches `claudeCredentialsPath(env)` — the one file whose
 *     path this module computes. It never takes a caller-supplied path, so it
 *     cannot be pointed at arbitrary files.
 *   * A missing file is SUCCESS, not an error: "sign me out" when already signed
 *     out is satisfied, and reporting a failure there would be a lie.
 *   * It resets the login cache so the very next `checkClaudeLogin` reflects the
 *     new (signed-out) reality rather than a 10s-stale "signed in".
 *   * It does NOT clear `CLAUDE_CODE_OAUTH_TOKEN` — that is an environment
 *     variable owned by the process/shell, not a file we may delete. When such a
 *     token is set, the caller is told (see the guard below) so the UI does not
 *     promise a sign-out it cannot deliver.
 */
export function claudeLogout(env: NodeJS.ProcessEnv = process.env): ClaudeLogoutResult {
  // An env-token sign-in cannot be revoked by deleting a file. Say so plainly
  // rather than delete the file and still report "signed in" on the next check.
  if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
    return {
      ok: false,
      error:
        'Signed in via CLAUDE_CODE_OAUTH_TOKEN in this environment. Unset that variable to sign out — there is no credential file to remove.',
    };
  }
  const path = claudeCredentialsPath(env);
  try {
    if (!existsSync(path)) {
      resetClaudeLoginCache();
      return { ok: true, removed: false };
    }
    unlinkSync(path);
    resetClaudeLoginCache();
    return { ok: true, removed: true };
  } catch (e) {
    // EACCES / EPERM / EISDIR: we found something but could not remove it. The
    // error message is safe to surface — it names the operation, never the
    // file's contents.
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The shape the UI needs: the sign-in status PLUS whether the dev engine is
 * even part of this build. A packaged app has no Agent SDK, so a sign-in
 * indicator there would describe a capability the app does not have — the UI
 * uses `relevant` to hide itself rather than mislead.
 */
export function describeClaudeLogin(
  opts: CheckClaudeLoginOptions & { force?: boolean } = {},
): ClaudeLoginState & { relevant: boolean } {
  return { ...getClaudeLoginState(opts), relevant: agentSdkResolvable() };
}
