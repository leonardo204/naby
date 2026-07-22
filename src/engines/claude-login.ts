// src/engines/claude-login.ts
//
// WHO IS SIGNED IN TO CLAUDE ON THIS COMPUTER — AND THE ACTIONS TO CHANGE IT.
//
// The dev engine (`ClaudeAgentSdkEngine`) answers on the Claude sign-in that
// already exists on this computer — no API key, no metered bill. That is a
// lovely property right up to the moment the sign-in is absent or stale, at
// which point the app looked fine, accepted a message, and only then failed
// with whatever the Agent SDK chose to throw.
//
// This module answers "who is signed in" BEFORE a turn, and drives login/logout
// FROM INSIDE THE APP, by running the real `claude auth` CLI. The Next server
// runs inside the Electron main process, so this parent runtime can spawn child
// processes (the same way electron/updater.ts spawns `codesign`).
//
// THE SOURCE OF TRUTH IS `claude auth status`
// -------------------------------------------
// `claude auth status` prints JSON:
//   { loggedIn, authMethod, apiProvider, email, orgId, orgName, subscriptionType }
// This carries the REAL EMAIL — the OAuth credential FILE does not. An earlier
// implementation read only the file, which is why the account chip showed no
// email and why a fresh re-login was not detected. So when the CLI is runnable,
// its answer WINS, and `account.email` is populated from it.
//
// RESOLVING THE `claude` BINARY (the one caveat worth spending care on)
// --------------------------------------------------------------------
// We must NOT run whatever `claude` is first on PATH: in dev a cmux shim shadows
// the real binary and hangs; in a packaged app PATH may be minimal. So we
// resolve a REAL binary explicitly (see `resolveClaudeBinary`): an override env
// var, then a known location (`~/.local/bin/claude`), then a PATH search that
// SKIPS any directory belonging to a cmux shim. If none is found we surface a
// clear "claude CLI not found" state rather than hang.
//
// WHAT IT DELIBERATELY DOES NOT DO
// --------------------------------
//   * It never makes a model call. "Are you signed in" answered by spending
//     money is not an answer worth having.
//   * Every CLI invocation is TIMEOUT-GUARDED (a hung exec must not wedge a
//     request), CACHED (10s), and non-fatal (a failure falls back to the old
//     credential-file check so nothing regresses where claude is not runnable).
//   * It never returns, logs, or retains credential material. `auth status`
//     reports identity LABELS (email, org name, plan) — not tokens — and the
//     credential-file fallback reads only the two expiry timestamps.
//
// UNKNOWN IS A REAL ANSWER. A machine whose sign-in we cannot model must not be
// reported "signed out" — that would tell the user to run a command that fixes
// nothing. `unknown` renders as a muted dot and blocks nothing.

import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

export type ClaudeLoginStatus = 'signed-in' | 'signed-out' | 'unknown';

/**
 * WHICH account is signed in.
 *
 * When the answer comes from `claude auth status` (the normal case), `email` and
 * `orgName` are the REAL identity the CLI reports. When it comes from the
 * credential-file fallback (CLI not runnable), those are `null` — the file
 * carries no email — and only `subscriptionType`/`rateLimitTier` may be present.
 * Every field here is a LABEL, not a secret: no token material reaches this type.
 */
export type ClaudeLoginAccount = {
  /** The signed-in account's email, from `claude auth status`. `null` when the
   *  identity came from the credential file (which has no email) or is absent. */
  email: string | null;
  /** The organisation name from `claude auth status`, when present. `null`
   *  otherwise. Informational. */
  orgName: string | null;
  /** The plan label (e.g. 'max', 'pro'), or `null` when not reported. */
  subscriptionType: string | null;
  /** The rate-limit tier label from the credential file, when the fallback path
   *  read one (e.g. 'default_claude_max_5x'). `null` otherwise. */
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
  /** Whether a real `claude` executable was resolved (shim-skipping). Reported
   *  separately because "signed out" and "not installed" need different advice. */
  cliFound: boolean;
  /** When this answer was computed (epoch ms). The UI shows staleness rather
   *  than pretending a cached answer is live. */
  checkedAt: number;
  /** Who is signed in. `null` when signed out or unknown. See
   *  `ClaudeLoginAccount` — carries the real email from `claude auth status`. */
  account: ClaudeLoginAccount | null;
};

/** The command a signed-out user runs. Named so the string exists once. It is
 *  the interactive browser OAuth flow the app kicks off via `claudeLogin`; the
 *  same string is the copy-paste fallback for a headless machine. */
export const CLAUDE_LOGIN_COMMAND = 'claude auth login';

// ---------------------------------------------------------------------------
// Resolving a REAL `claude` binary (never the cmux shim)
// ---------------------------------------------------------------------------

/** PATH directories belonging to a cmux shim. A `claude` found in one of these
 *  is the shim that deadlocks a nested `claude`, so those dirs are skipped. */
const CMUX_SHIM_MARKERS = ['cmux-cli-shims', 'cmux.app'];

function pathDirIsShim(dir: string): boolean {
  return CMUX_SHIM_MARKERS.some((marker) => dir.includes(marker));
}

/** A path is usable as the CLI if it resolves to a file (symlinks followed —
 *  every npm-global / versioned install of the CLI is a symlink to a script). */
function isClaudeExecutable(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The absolute path of a REAL `claude` binary, or `null` when none is found.
 *
 * Order, most-authoritative first:
 *   1. `NABY_CLAUDE_BIN` — an explicit override. Used by the spikes (to point at
 *      a fake `claude`) and by a power user whose install we do not model.
 *   2. `~/.local/bin/claude` — the known location the CLI installs to. Preferred
 *      over PATH because PATH is exactly where the cmux shim shadows it.
 *   3. A PATH search that SKIPS shim directories. First non-shim hit wins.
 *
 * Never spawns anything — resolution is a handful of `stat` calls, cheap enough
 * to run on the resolve path of every status check.
 */
export function resolveClaudeBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.NABY_CLAUDE_BIN?.trim();
  if (override) return isClaudeExecutable(override) ? override : null;

  // `env.HOME` is honoured (not just `homedir()`) so a test can redirect the
  // known-location probe at a temp home and force the PATH search.
  const home = env.HOME?.trim() || homedir();
  const explicit = join(home, '.local', 'bin', 'claude');
  if (isClaudeExecutable(explicit)) return explicit;

  const pathVar = env.PATH || '';
  if (!pathVar) return null;
  const sep = process.platform === 'win32' ? ';' : ':';
  const names =
    process.platform === 'win32'
      ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map((ext) => `claude${ext.toLowerCase()}`)
      : ['claude'];
  for (const dir of pathVar.split(sep)) {
    if (!dir || pathDirIsShim(dir)) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (isClaudeExecutable(candidate)) return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Running the CLI
// ---------------------------------------------------------------------------

/** How long any `claude auth …` invocation may take before it is killed. A hung
 *  exec must never wedge the request that triggered it. */
const EXEC_TIMEOUT_MS = 8_000;

type ClaudeAuthStatusJson = {
  loggedIn?: boolean;
  authMethod?: string;
  apiProvider?: string;
  email?: string;
  orgId?: string;
  orgName?: string;
  subscriptionType?: string;
};

type CliResult = { ok: true; stdout: string } | { ok: false; error: string };

/** Run `claude <args>` at an absolute, de-shimmed path, timeout-guarded. Never
 *  rejects — a non-zero exit or a timeout is returned as `{ ok:false }`. */
function runClaudeCli(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { timeout: EXEC_TIMEOUT_MS, env, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const tail = String(stderr ?? '').trim().slice(0, 200);
          resolve({ ok: false, error: (err.message || String(err)) + (tail ? ` — ${tail}` : '') });
          return;
        }
        resolve({ ok: true, stdout: String(stdout) });
      },
    );
  });
}

/** Extract the JSON object from `claude auth status` output. The CLI prints a
 *  bare object today, but we slice `{`…`}` so a stray warning line cannot break
 *  parsing. Returns `null` on anything unparseable. */
function parseAuthStatus(stdout: string): ClaudeAuthStatusJson | null {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(stdout.slice(start, end + 1)) as ClaudeAuthStatusJson;
  } catch {
    return null;
  }
}

/** A non-empty trimmed string, or `null`. Keeps empty CLI fields out of the UI. */
function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// ---------------------------------------------------------------------------
// Where the sign-in lives (credential-file fallback)
// ---------------------------------------------------------------------------

/**
 * The credential file Claude Code writes on login. Used ONLY as a fallback when
 * the CLI is not runnable; `CLAUDE_CONFIG_DIR` is honoured because the CLI does.
 */
export function claudeCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
  return join(dir, '.credentials.json');
}

/**
 * Whether a `claude` executable exists WITHOUT spawning one — used only by the
 * synchronous file-fallback check. Skips shim directories for parity with
 * `resolveClaudeBinary`.
 */
function findClaudeCli(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveClaudeBinary(env) !== null;
}

/**
 * Whether the Agent SDK itself is present. Reused rather than reimplemented so
 * "the dev engine can run" has one definition.
 */
function agentSdkResolvable(): boolean {
  try {
    createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
    return true;
  } catch {
    return false;
  }
}

/**
 * Read ONLY the two expiry timestamps (plus non-secret plan labels) out of the
 * credential file. The single function that touches the file's bytes; only small
 * strings and numbers escape, never a token, and the catch swallows parse errors
 * (which could otherwise quote the file's contents).
 */
function readExpiries(
  path: string,
): { present: false } | {
  present: true;
  expiresAt?: number;
  refreshExpiresAt?: number;
  subscriptionType?: string;
  rateLimitTier?: string;
} {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { present: false };
  }
  try {
    const parsed = JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> };
    const oauth = parsed.claudeAiOauth;
    if (!oauth || typeof oauth !== 'object') {
      return { present: true };
    }
    const expiresAt = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined;
    const refreshExpiresAt =
      typeof oauth.refreshTokenExpiresAt === 'number' ? oauth.refreshTokenExpiresAt : undefined;
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

/** Build the account label object from the credential-file fields. `email` and
 *  `orgName` are always `null` here — the file has neither. */
function toFileAccount(creds: {
  subscriptionType?: string;
  rateLimitTier?: string;
}): ClaudeLoginAccount | null {
  if (creds.subscriptionType === undefined && creds.rateLimitTier === undefined) return null;
  return {
    email: null,
    orgName: null,
    subscriptionType: creds.subscriptionType ?? null,
    rateLimitTier: creds.rateLimitTier ?? null,
  };
}

export type CheckClaudeLoginOptions = {
  /** Override the environment. Used by the spikes so login state is testable
   *  without touching the developer's real sign-in. */
  env?: NodeJS.ProcessEnv;
  /** Override "now" (epoch ms), so expiry handling is testable. */
  now?: number;
};

/**
 * The FALLBACK answer, computed from the filesystem alone (no CLI). Synchronous
 * and cheap. Kept for the case where a real `claude` binary is not resolvable,
 * and used verbatim by the older spikes/electron harness.
 */
export function checkClaudeLogin(opts: CheckClaudeLoginOptions = {}): ClaudeLoginState {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const checkedAt = now;
  const cliFound = findClaudeCli(env);

  if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
    return {
      status: 'signed-in',
      summary: 'Signed in to Claude via CLAUDE_CODE_OAUTH_TOKEN in this environment.',
      remedy: null,
      cliFound,
      checkedAt,
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
        ? `Run \`${CLAUDE_LOGIN_COMMAND}\`, then re-check.`
        : `Install the Claude Code CLI, then run \`${CLAUDE_LOGIN_COMMAND}\`.`,
      cliFound,
      checkedAt,
      account: null,
    };
  }

  if (creds.expiresAt === undefined && creds.refreshExpiresAt === undefined) {
    return {
      status: 'unknown',
      summary:
        'A Claude sign-in exists on this computer, but its status could not be determined. ' +
        'The development model will most likely work.',
      remedy: null,
      cliFound,
      checkedAt,
      account: toFileAccount(creds),
    };
  }

  const accessLive = creds.expiresAt !== undefined && creds.expiresAt > now;
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
      account: toFileAccount(creds),
    };
  }

  return {
    status: 'signed-out',
    summary: 'The Claude sign-in on this computer has expired, so the development model cannot answer.',
    remedy: `Run \`${CLAUDE_LOGIN_COMMAND}\` to sign in again, then re-check.`,
    cliFound,
    checkedAt,
    account: null,
  };
}

// ---------------------------------------------------------------------------
// The authoritative check — `claude auth status`
// ---------------------------------------------------------------------------

/**
 * The real answer: run `claude auth status`, parse its JSON, and map it —
 * including the REAL EMAIL. Non-fatal and timeout-guarded at every step:
 *   * no resolvable binary        → fall back to the credential-file check;
 *   * exec fails / times out       → fall back to the credential-file check;
 *   * output does not parse        → fall back to the credential-file check;
 *   * loggedIn:true                → signed-in, with email/orgName/plan;
 *   * loggedIn:false               → signed-out.
 * The fallback guarantees nothing regresses where `claude` is not runnable, but
 * when the CLI answers, ITS result (with the email) wins.
 */
export async function checkClaudeAuthStatus(
  opts: CheckClaudeLoginOptions = {},
): Promise<ClaudeLoginState> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now();
  const checkedAt = now;

  const bin = resolveClaudeBinary(env);
  if (!bin) {
    // No real CLI to ask. The file fallback still reports a useful answer, and
    // its `cliFound` will be false too, so the UI can say "not installed".
    return checkClaudeLogin(opts);
  }

  const res = await runClaudeCli(bin, ['auth', 'status'], env);
  if (!res.ok) {
    // A hung/failed status probe must not block the request or lie; fall back to
    // the cheap file check, which is a good approximation.
    return checkClaudeLogin(opts);
  }

  const parsed = parseAuthStatus(res.stdout);
  if (!parsed || typeof parsed.loggedIn !== 'boolean') {
    return checkClaudeLogin(opts);
  }

  if (parsed.loggedIn) {
    const email = nonEmpty(parsed.email);
    const account: ClaudeLoginAccount = {
      email,
      orgName: nonEmpty(parsed.orgName),
      subscriptionType: nonEmpty(parsed.subscriptionType),
      rateLimitTier: null,
    };
    return {
      status: 'signed-in',
      summary: email
        ? `Signed in to Claude as ${email}. The development model can answer with no API key.`
        : 'Signed in to Claude on this computer. The development model can answer with no API key.',
      remedy: null,
      cliFound: true,
      checkedAt,
      account,
    };
  }

  return {
    status: 'signed-out',
    summary: 'Not signed in to Claude on this computer, so the development model cannot answer.',
    remedy: `Sign in with \`${CLAUDE_LOGIN_COMMAND}\`, then re-check.`,
    cliFound: true,
    checkedAt,
    account: null,
  };
}

// ---------------------------------------------------------------------------
// The cached entry points
// ---------------------------------------------------------------------------

/** How long an answer is reused — short, because a human may log in/out in
 *  another window, but long enough that a burst of focus events does not spawn a
 *  `claude auth status` per flick. */
const CACHE_MS = 10_000;

let cached: ClaudeLoginState | undefined;

/**
 * The synchronous, file-only cached entry point. Retained for the electron spike
 * harness and any caller that must not await. Prefer `getClaudeAuthState`.
 */
export function getClaudeLoginState(
  opts: CheckClaudeLoginOptions & { force?: boolean } = {},
): ClaudeLoginState {
  const now = opts.now ?? Date.now();
  if (!opts.force && cached && now - cached.checkedAt < CACHE_MS) return cached;
  cached = checkClaudeLogin(opts);
  return cached;
}

/**
 * The authoritative cached entry point the UI path uses. Same answer as
 * `checkClaudeAuthStatus`, but at most one CLI invocation per `CACHE_MS`.
 * `force` exists for the UI's "Re-check" and for polling after a login/logout,
 * where a stale answer would be wrong for up to ten seconds.
 */
export async function getClaudeAuthState(
  opts: CheckClaudeLoginOptions & { force?: boolean } = {},
): Promise<ClaudeLoginState> {
  const now = opts.now ?? Date.now();
  if (!opts.force && cached && now - cached.checkedAt < CACHE_MS) return cached;
  cached = await checkClaudeAuthStatus(opts);
  return cached;
}

/** Drop the cache. Exported for the spikes, and called after login/logout so the
 *  next check reflects the new reality rather than a 10s-stale answer. */
export function resetClaudeLoginCache(): void {
  cached = undefined;
}

// ---------------------------------------------------------------------------
// Log in — kick off the interactive browser OAuth
// ---------------------------------------------------------------------------

export type ClaudeLoginOptions = {
  /** Pre-fill the email for the OAuth flow (`--email`). Optional. */
  email?: string;
  /** Use the Console (API) flow (`--console`) instead of the default claude.ai
   *  browser flow (`--claudeai`). */
  console?: boolean;
  /** Override the environment (tests / binary resolution). */
  env?: NodeJS.ProcessEnv;
};

export type ClaudeLoginResult =
  /** The browser flow was launched. The UI must now POLL `getClaudeAuthState`
   *  (force) until `loggedIn` flips — this call does NOT wait for the user. */
  | { ok: true; started: true; command: string }
  /** Could not launch (no CLI, or spawn failed). `command` is the copy-paste
   *  fallback the UI shows for a headless machine. */
  | { ok: false; error: string; command: string };

/**
 * Start `claude auth login` so a browser opens for the user to authorise.
 *
 * HOW THE BROWSER OPENS AND WHY THIS DOES NOT BLOCK. `claude auth login` runs an
 * OAuth flow: it opens the system browser, waits on a localhost callback, writes
 * the credential, and exits. That is INTERACTIVE and can take as long as the user
 * takes, so we do NOT await it. We spawn it DETACHED with stdio ignored and
 * `unref()` it, returning `{ started:true }` immediately. The CLI itself owns
 * opening the browser (it prints/opens the auth URL); the app's job is only to
 * launch it and then poll `claude auth status` until the login lands.
 *
 * WHAT THE UI DOES AFTER THIS. It shows a "waiting for browser sign-in…" state
 * and polls `getClaudeAuthState({ force:true })` (~every 2s for ~60s) until the
 * status flips to signed-in, then stops. On a headless box where no browser can
 * open, the UI offers `command` as copy-paste so the user can run it themselves.
 */
export function claudeLogin(opts: ClaudeLoginOptions = {}): ClaudeLoginResult {
  const env = opts.env ?? process.env;
  const args = ['auth', 'login'];
  // Default to the claude.ai browser flow; only switch to Console on request.
  args.push(opts.console ? '--console' : '--claudeai');
  if (opts.email?.trim()) args.push('--email', opts.email.trim());
  const command = `claude ${args.join(' ')}`;

  const bin = resolveClaudeBinary(env);
  if (!bin) {
    return {
      ok: false,
      error: 'The `claude` CLI was not found on this computer. Install it, then run the command below.',
      command,
    };
  }

  try {
    const child = spawn(bin, args, { detached: true, stdio: 'ignore', env });
    // A spawn error (e.g. EACCES) arrives asynchronously; swallow it so it never
    // becomes an unhandled 'error' event. The UI learns the outcome by polling.
    child.on('error', () => {});
    child.unref();
    resetClaudeLoginCache();
    return { ok: true, started: true, command };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), command };
  }
}

// ---------------------------------------------------------------------------
// Log out
// ---------------------------------------------------------------------------

export type ClaudeLogoutResult =
  /** `removed` distinguishes "we cleared a live sign-in" from "there was nothing
   *  to clear". Both are success; the UI can phrase it either way. */
  | { ok: true; removed: boolean }
  | { ok: false; error: string };

/** The credential-file logout, kept as the fallback for when the CLI is not
 *  resolvable. Deletes ONLY the path this module computes; a missing file is
 *  success (idempotent); never reads the file's contents. */
function claudeLogoutViaFile(env: NodeJS.ProcessEnv): ClaudeLogoutResult {
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
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Sign out by running `claude auth logout` — a clean logout that revokes the
 * session the way the CLI intends, rather than leaving a half-state by deleting
 * a file behind the CLI's back.
 *
 * Idempotent and non-fatal: `claude auth logout` when already signed out still
 * succeeds. The login cache is reset either way so the next check is fresh. When
 * no real `claude` binary is resolvable (or the CLI errors), it falls back to
 * deleting the credential file, so logout still works where the CLI cannot run.
 */
export async function claudeLogout(env: NodeJS.ProcessEnv = process.env): Promise<ClaudeLogoutResult> {
  const bin = resolveClaudeBinary(env);
  if (bin) {
    const res = await runClaudeCli(bin, ['auth', 'logout'], env);
    resetClaudeLoginCache();
    if (res.ok) return { ok: true, removed: true };
    // CLI present but the logout failed — try the file fallback before giving up.
    const fallback = claudeLogoutViaFile(env);
    if (fallback.ok) return fallback;
    return { ok: false, error: res.error };
  }
  return claudeLogoutViaFile(env);
}

// ---------------------------------------------------------------------------
// The shape the UI needs
// ---------------------------------------------------------------------------

/**
 * The authoritative status PLUS whether the dev engine is part of this build. A
 * packaged app has no Agent SDK, so a sign-in indicator there would describe a
 * capability the app does not have — the UI uses `relevant` to hide itself.
 *
 * Async because it runs `claude auth status` (cached). Prefer this over the
 * synchronous `describeClaudeLogin`, which reads only the credential file.
 */
export async function describeClaudeLoginAsync(
  opts: CheckClaudeLoginOptions & { force?: boolean } = {},
): Promise<ClaudeLoginState & { relevant: boolean }> {
  return { ...(await getClaudeAuthState(opts)), relevant: agentSdkResolvable() };
}

/**
 * The synchronous, file-only variant. Retained for callers that must not await
 * (and for backward compatibility). Prefer `describeClaudeLoginAsync`.
 */
export function describeClaudeLogin(
  opts: CheckClaudeLoginOptions & { force?: boolean } = {},
): ClaudeLoginState & { relevant: boolean } {
  return { ...getClaudeLoginState(opts), relevant: agentSdkResolvable() };
}
