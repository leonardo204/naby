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
// var, then a known location (`~/.local/bin/claude`, and on Windows the same
// directory with a PATHEXT extension), then a PATH search that SKIPS any
// directory belonging to a cmux shim. If none is found we surface a clear
// "claude CLI not found" state — WITH INSTALL INSTRUCTIONS (`claudeInstallHelp`)
// rather than a bare "install it" — instead of hanging.
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

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';

// THE one definition of "is the Agent SDK reachable from here". Importing it
// rather than re-deriving it is the point: see `agentSdkResolvable` below.
import { isClaudeAgentSdkAvailable } from './claude-agent-sdk-engine.js';

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
// Installing the CLI — the official instructions, in a shape the UI can render
// ---------------------------------------------------------------------------
//
// "Install it, then run the command below" was the whole of the old advice, and
// it is advice only for someone who already knows where "it" comes from. The
// user this text exists for does not: they clicked "Log in", nothing happened,
// and the app told them to install something it would not name.
//
// So the missing-CLI answer is STRUCTURED rather than one sentence: a docs link,
// the recommended command FOR THIS MACHINE, and the alternatives. The UI turns
// that into a link plus copy buttons (a command shown as prose is a command that
// gets mis-typed), and `claudeInstallHelp` stays a PURE function of the platform
// so the choice is testable without a Windows machine.
//
// Everything below is verbatim from https://code.claude.com/docs/en/setup. It is
// not paraphrased and must not be: an install command that is nearly right is
// worse than none.

/** The official setup page. Rendered as a `target="_blank"` anchor, which
 *  electron/boot.ts opens in the OS browser rather than inside the app. */
export const CLAUDE_INSTALL_DOCS_URL = 'https://code.claude.com/docs/en/setup';

/** Which install route a command is. A STABLE ID, not a label: the UI names it
 *  in the user's own language (i18n), so no English leaks out of the runtime. */
export type ClaudeInstallCommandId =
  | 'windows-powershell'
  | 'windows-cmd'
  | 'windows-winget'
  | 'unix-native'
  | 'macos-homebrew'
  | 'npm';

export type ClaudeInstallCommand = {
  id: ClaudeInstallCommandId;
  /** The exact command, copy-paste ready: no prompt character, no placeholder,
   *  nothing for the user to edit before it runs. */
  command: string;
};

/** A fact the reader needs BEFORE running any of the commands. Ids, for the same
 *  reason as `ClaudeInstallCommandId`.
 *   * `no-admin-required` — the native installer needs no administrator rights,
 *     which is the first thing a locked-down work machine's owner asks.
 *   * `paid-plan-required` — Claude Code needs Pro/Max/Team/Enterprise or a
 *     Console account. Learning that AFTER installing is a wasted evening. */
export type ClaudeInstallNote = 'no-admin-required' | 'paid-plan-required';

export type ClaudeInstallHelp = {
  /** The platform family the advice was computed for. Reported so a UI (or a
   *  test) can say WHICH machine these commands are for. */
  platform: 'windows' | 'macos' | 'linux';
  docsUrl: string;
  /** The one command to try first on this platform — the native installer. */
  recommended: ClaudeInstallCommand;
  /** The other supported routes, best first. Never empty: npm is always here,
   *  because it is the route that works when the native one is blocked. */
  alternatives: ClaudeInstallCommand[];
  notes: ClaudeInstallNote[];
};

/** Node 22+; the route that works everywhere, so it is every platform's last
 *  alternative rather than a platform-specific one. */
const NPM_INSTALL: ClaudeInstallCommand = {
  id: 'npm',
  command: 'npm install -g @anthropic-ai/claude-code',
};

/** Both facts apply on every platform, so the note list does not vary; it is a
 *  field rather than a constant so a future platform-specific caveat has an
 *  obvious home. */
const INSTALL_NOTES: ClaudeInstallNote[] = ['no-admin-required', 'paid-plan-required'];

/**
 * How to install Claude Code on `platform` — pure, total, and offline.
 *
 * A pure function of one argument because that is what makes it checkable: the
 * spike asserts the Windows answer on a Mac, which is exactly the case that
 * cannot be exercised by running the app.
 */
export function claudeInstallHelp(
  platform: NodeJS.Platform = process.platform,
): ClaudeInstallHelp {
  if (platform === 'win32') {
    return {
      platform: 'windows',
      docsUrl: CLAUDE_INSTALL_DOCS_URL,
      recommended: {
        id: 'windows-powershell',
        command: 'irm https://claude.ai/install.ps1 | iex',
      },
      alternatives: [
        {
          id: 'windows-cmd',
          command:
            'curl -fsSL https://claude.ai/install.cmd -o install.cmd && install.cmd && del install.cmd',
        },
        { id: 'windows-winget', command: 'winget install Anthropic.ClaudeCode' },
        NPM_INSTALL,
      ],
      notes: INSTALL_NOTES,
    };
  }

  const unixNative: ClaudeInstallCommand = {
    id: 'unix-native',
    command: 'curl -fsSL https://claude.ai/install.sh | bash',
  };

  if (platform === 'darwin') {
    return {
      platform: 'macos',
      docsUrl: CLAUDE_INSTALL_DOCS_URL,
      recommended: unixNative,
      alternatives: [
        { id: 'macos-homebrew', command: 'brew install --cask claude-code' },
        NPM_INSTALL,
      ],
      notes: INSTALL_NOTES,
    };
  }

  // Everything else takes the Linux advice: the native installer plus npm.
  // Homebrew is deliberately NOT offered here — the docs list it for macOS.
  return {
    platform: 'linux',
    docsUrl: CLAUDE_INSTALL_DOCS_URL,
    recommended: unixNative,
    alternatives: [NPM_INSTALL],
    notes: INSTALL_NOTES,
  };
}

/** What a user is told when no `claude` executable can be found anywhere.
 *
 *  It names the thing, says it needs installing, warns about the plan (the one
 *  fact that turns a successful install into a dead end), and points at the
 *  page. The STRUCTURED `claudeInstallHelp` above carries the same instructions
 *  for a UI that can draw a link and a copy button; this string is for the
 *  places that can only carry a sentence. */
/** The first sentence on its own, for somewhere with no room for the rest.
 *
 *  THE CHAT CHIP IS WHY THIS EXISTS. It renders a sign-in failure in a small
 *  amber span inside a popover; four sentences there is a wall of text, and the
 *  reader is one click from a settings card that shows the commands anyway. The
 *  full message stays for the places that DO have room (and for a caller that
 *  has only a string), so this is a prefix of it, not a second wording — the
 *  composition below is what keeps them from drifting apart. */
export const CLAUDE_CLI_MISSING_HEADLINE =
  'Claude Code is not installed on this computer, so there is no sign-in to use.';

export const CLAUDE_CLI_MISSING_MESSAGE =
  `${CLAUDE_CLI_MISSING_HEADLINE} ` +
  'Install it with the command for your system (the native installer needs no administrator rights), ' +
  'then sign in. Claude Code requires a Pro, Max, Team or Enterprise plan, or a Console account — ' +
  `the free plan does not include it. Setup guide: ${CLAUDE_INSTALL_DOCS_URL}`;

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
 * The file names a `claude` executable can have HERE.
 *
 * On POSIX there is exactly one: the mode bits carry executability, so the file
 * is called `claude`. On Windows executability lives in the EXTENSION, and the
 * set of extensions that count is `PATHEXT` — the native installer writes
 * `claude.exe`, an npm global writes `claude.cmd`.
 *
 * ONE FUNCTION BECAUSE THERE ARE TWO PROBES. `resolveClaudeBinary` looks in the
 * known install location AND along PATH, and the extension list was applied to
 * only the second one. So on Windows the known-location probe stat'd
 * `%USERPROFILE%\.local\bin\claude` — a name that never exists there, the
 * installer having written `claude.exe` — and always missed. PATH was then the
 * only thing left, and PATH is exactly what a JUST-INSTALLED CLI is missing from
 * in an already-running Electron process: the installer edits the registry, and
 * this process inherited its environment at launch. Install, restart nothing,
 * and the app still says the CLI is not there.
 */
export function claudeExecutableNames(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform !== 'win32') return ['claude'];
  return (env.PATHEXT || '.EXE;.CMD;.BAT')
    .split(';')
    .map((ext) => ext.trim())
    // An empty PATHEXT entry (a trailing ';' is common) would otherwise become
    // the bare name — which on Windows is not executable, so it is dropped.
    .filter((ext) => ext.length > 0)
    .map((ext) => `claude${ext.toLowerCase()}`);
}

/**
 * The absolute path of a REAL `claude` binary, or `null` when none is found.
 *
 * Order, most-authoritative first:
 *   1. `NABY_CLAUDE_BIN` — an explicit override. Used by the spikes (to point at
 *      a fake `claude`) and by a power user whose install we do not model.
 *   2. `~/.local/bin/claude` — the known location the CLI installs to (on
 *      Windows, `%USERPROFILE%\.local\bin\claude.exe`). Preferred over PATH
 *      because PATH is where the cmux shim shadows it, and because a freshly
 *      installed CLI is not on THIS process's PATH at all.
 *   3. A PATH search that SKIPS shim directories. First non-shim hit wins.
 *
 * `platform` is a parameter rather than a read of `process.platform` so the
 * Windows layout is assertable from a spike on any machine — the bug above was
 * invisible precisely because it could not be exercised where it was written.
 *
 * Never spawns anything — resolution is a handful of `stat` calls, cheap enough
 * to run on the resolve path of every status check.
 */
export function resolveClaudeBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const override = env.NABY_CLAUDE_BIN?.trim();
  if (override) return isClaudeExecutable(override) ? override : null;

  const names = claudeExecutableNames(env, platform);

  // `env.HOME` is honoured (not just `homedir()`) so a test can redirect the
  // known-location probe at a temp home and force the PATH search. On Windows
  // `HOME` is usually unset, so `USERPROFILE` — the variable the setup docs
  // themselves use for this path — is consulted before falling back.
  const home =
    env.HOME?.trim() ||
    (platform === 'win32' ? env.USERPROFILE?.trim() : undefined) ||
    homedir();
  const knownDir = join(home, '.local', 'bin');
  for (const name of names) {
    const explicit = join(knownDir, name);
    if (isClaudeExecutable(explicit)) return explicit;
  }

  const pathVar = env.PATH || '';
  if (!pathVar) return null;
  const sep = platform === 'win32' ? ';' : ':';
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
 * Whether the Agent SDK itself is present.
 *
 * This used to be a local `createRequire(import.meta.url).resolve(...)` under a
 * comment claiming it was "reused rather than reimplemented" — it was a
 * reimplementation, and it carried the whole bug on its own. When the engine's
 * resolver learned that `import.meta.url` is constant-folded by webpack into the
 * build machine's path (see resolveClaudeAgentSdkPath), this copy did not, so
 * `relevant` stayed false in a shipped build and the Claude account chip
 * rendered nothing while the engine itself worked fine.
 *
 * Now it genuinely is one definition. Two copies of a predicate is two answers
 * to "can the dev engine run here", and the UI believed the wrong one.
 */
const agentSdkResolvable = isClaudeAgentSdkAvailable;

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
        : `${CLAUDE_CLI_MISSING_MESSAGE} Then run \`${CLAUDE_LOGIN_COMMAND}\`.`,
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

/**
 * THE CACHE IS KEYED BY CREDENTIAL NAMESPACE, NOT GLOBAL.
 *
 * It used to be one slot: `let cached`. With one sign-in that is merely a cache;
 * with more than one (claude-multi-account §5.2) it is a bug that MIXES ACCOUNTS.
 * Ask about account A, ask about account B within ten seconds, and B is answered
 * with A's email, A's organisation and A's plan — the settings list then shows two
 * rows with one identity, and the chip can name an account the turn is not using.
 *
 * `CLAUDE_CONFIG_DIR` is exactly the right key because it is exactly what
 * partitions the credentials themselves: the Keychain service name carries that
 * path's hash, and the credential file and identity file live inside it. Same
 * directory = same sign-in = the answer is reusable. Different directory = a
 * different account, and nothing about A's answer is evidence about B.
 *
 * The empty-string key is the machine default (`~/.claude`) — the one every
 * single-account install uses, whose behaviour is unchanged.
 */
const cached = new Map<string, ClaudeLoginState>();

/** The namespace an environment points at: the config directory, or '' for the
 *  machine default. */
function cacheKey(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || '';
}

/**
 * The synchronous, file-only cached entry point. Retained for the electron spike
 * harness and any caller that must not await. Prefer `getClaudeAuthState`.
 */
export function getClaudeLoginState(
  opts: CheckClaudeLoginOptions & { force?: boolean } = {},
): ClaudeLoginState {
  const now = opts.now ?? Date.now();
  const key = cacheKey(opts.env ?? process.env);
  const hit = cached.get(key);
  if (!opts.force && hit && now - hit.checkedAt < CACHE_MS) return hit;
  const fresh = checkClaudeLogin(opts);
  cached.set(key, fresh);
  return fresh;
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
  const key = cacheKey(opts.env ?? process.env);
  const hit = cached.get(key);
  if (!opts.force && hit && now - hit.checkedAt < CACHE_MS) return hit;
  const fresh = await checkClaudeAuthStatus(opts);
  cached.set(key, fresh);
  return fresh;
}

/**
 * Drop the cache — ALL OF IT, deliberately.
 *
 * Every caller means "something changed" (a login, a logout, an account added or
 * removed, an account switch), and none of them is in a position to know which
 * namespaces that change is evidence about: `claude auth logout` in one directory
 * can end a session the other directory's answer described. Clearing one entry
 * would be a guess; clearing everything costs one CLI call per namespace that is
 * actually asked about again.
 */
export function resetClaudeLoginCache(): void {
  cached.clear();
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
   *  fallback the UI shows for a headless machine.
   *
   *  `installHelp` is present ONLY for the "there is no CLI here" failure, and
   *  its presence is the signal: a spawn that failed for some other reason is
   *  not fixed by installing anything, so offering install instructions there
   *  would be a wrong answer stated confidently. */
  | { ok: false; error: string; command: string; installHelp?: ClaudeInstallHelp };

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
    // WHERE and HOW, not just "install it": the sentence for a caller that can
    // only render text, plus the structured form for one that can draw a link
    // and a copy button (see `claudeInstallHelp`).
    return {
      ok: false,
      error: CLAUDE_CLI_MISSING_MESSAGE,
      command,
      installHelp: claudeInstallHelp(),
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

/** What the UI reads: the status, whether the dev engine exists in this build,
 *  and — ONLY when no CLI was found — how to install one. */
export type ClaudeLoginDescription = ClaudeLoginState & {
  relevant: boolean;
  /** Install instructions for THIS machine, or `null` when a `claude` binary was
   *  found (nothing to install). Computed here, in the one place that already
   *  knows `cliFound`, so no UI has to re-derive "should I be offering this". */
  installHelp: ClaudeInstallHelp | null;
};

/** Attach install instructions when, and only when, the CLI is missing. */
function describe(state: ClaudeLoginState): ClaudeLoginDescription {
  return {
    ...state,
    relevant: agentSdkResolvable(),
    installHelp: state.cliFound ? null : claudeInstallHelp(),
  };
}

/**
 * The authoritative status PLUS whether the dev engine is part of this build.
 * `relevant` is false when the Agent SDK does not resolve here, and the UI hides
 * itself rather than showing a sign-in for a capability that cannot run.
 *
 * Async because it runs `claude auth status` (cached). Prefer this over the
 * synchronous `describeClaudeLogin`, which reads only the credential file.
 */
export async function describeClaudeLoginAsync(
  opts: CheckClaudeLoginOptions & { force?: boolean } = {},
): Promise<ClaudeLoginDescription> {
  return describe(await getClaudeAuthState(opts));
}

/**
 * The synchronous, file-only variant. Retained for callers that must not await
 * (and for backward compatibility). Prefer `describeClaudeLoginAsync`.
 */
export function describeClaudeLogin(
  opts: CheckClaudeLoginOptions & { force?: boolean } = {},
): ClaudeLoginDescription {
  return describe(getClaudeLoginState(opts));
}
