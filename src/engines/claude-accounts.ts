// src/engines/claude-accounts.ts
//
// THE OPERATIONS ON A CLAUDE ACCOUNT — add, verify, remove, and the one honesty
// check the whole feature rests on (claude-multi-account §5).
//
// EVERYTHING HERE IS THE CLI DOING THE WORK. naby creates an empty directory,
// sets `CLAUDE_CONFIG_DIR` to it, and runs the same `claude auth login/status/
// logout` the single-account path already runs — through the SAME functions
// (`claudeLogin`, `checkClaudeAuthStatus`, `claudeLogout`), which have taken an
// `env` override since they were written. No new execution path, no second way to
// find the binary, no second timeout policy, and no code anywhere in naby that
// reads or writes a credential (§2.1).
//
// THAT LAST CLAUSE STILL HOLDS, AND ONE THING NOW READS `~/.claude` ANYWAY — so
// it is recorded here, next to the invariant, rather than left for a later reader
// to discover and file as a bug.
//
// The plan-usage display (`engines/claude-hud-usage.ts`) takes a second reading
// of the account's 5-hour and 7-day limits from `~/.claude/.hud_cache`, which is
// Claude Code's own status-line cache, and merges it with the Agent SDK's usage
// query by keeping whichever reports less headroom. An explicit exception to the
// rule above was authorised for that feature, permitting the credential file and
// the OAuth usage endpoint if they were needed.
//
// THEY WERE NOT NEEDED, AND THE EXCEPTION WAS NOT SPENT. `.hud_cache` is a plain
// JSON cache of the same endpoint's own response — same field names, same 0-100
// scale — and carries no token, so the chosen implementation reads NO credential
// and makes NO network call. `.credentials.json` is still never opened, the
// Keychain is still never queried, and "naby has no code that could read a
// secret" is still literally true.
//
// What DID change is narrower and worth naming precisely: naby now reads two
// NON-SECRET artifacts of a directory it does not own — that cache, and
// `.claude.json`, which is Claude Code's identity file (`accountUuid`,
// `emailAddress`) and not its credential file. The identity read exists solely to
// enforce the guard that matters here: `~/.claude` may be a DIFFERENT
// subscription from the isolated account naby is running as, and a merged reading
// across two accounts describes neither. See that module's header for the guard
// and for why a refusal is the default.
//
// THE PURE HALF LIVES IN `runtime/claude-accounts.ts` — paths, ids, the
// environment rule, the stored list. This module is the half that spawns.
//
// TWO ORDERINGS ARE LOAD-BEARING AND ARE STATED WHERE THEY ARE DONE:
//
//   * REMOVE: logout FIRST, then delete the directory. The Keychain entry for an
//     account is named with the hash of its config directory path; deleting the
//     directory first does not delete the entry, it deletes the only thing that
//     could ever name it again.
//   * ADD: probe FIRST, then log in. A machine where the partition does not hold
//     must not be walked through a browser sign-in whose result would be a second
//     row pointing at the same credentials.

import {
  claudeAccountEnvFor,
  activeClaudeAccountId,
  deleteClaudeAccountMeta,
  ensureClaudeAccountDir,
  listClaudeAccounts,
  newClaudeAccountId,
  removeClaudeAccountDir,
  setActiveClaudeAccount,
  upsertClaudeAccount,
  writeClaudeAccountIsolation,
  readClaudeAccountIsolation,
  claudeAccountsRoot,
  claudeAccountsSupported,
  type ClaudeAccountIsolation,
  type ClaudeAccountMeta,
} from '../runtime/claude-accounts.js';
import type { Store } from '../runtime/store/store.js';
import {
  checkClaudeAuthStatus,
  claudeLogin,
  claudeLogout,
  claudeInstallHelp,
  describeClaudeLoginAsync,
  resetClaudeLoginCache,
  resolveClaudeBinary,
  CLAUDE_CLI_MISSING_MESSAGE,
  type ClaudeInstallHelp,
  type ClaudeLoginDescription,
  type ClaudeLoginResult,
  type ClaudeLoginState,
  type ClaudeLogoutResult,
} from './claude-login.js';

// ---------------------------------------------------------------------------
// Does the partition actually hold on THIS machine? (§5.3)
// ---------------------------------------------------------------------------

export type ClaudeIsolationProbe = {
  verdict: ClaudeAccountIsolation;
  /** One English sentence for a log — never shown to a user, never a path. */
  detail: string;
};

/**
 * Create an EMPTY config directory, ask `claude auth status` about it, and throw
 * the directory away.
 *
 * WHY THIS IS THE RIGHT QUESTION. A brand-new namespace has no credentials in it,
 * so the only truthful answer is "signed out". If the CLI answers "signed in"
 * about a directory that was created milliseconds ago and contains nothing, then
 * it is reading a credential store that this directory does not control — the
 * partition is not real here, and every "account" naby offered would be the same
 * account wearing different labels. That is the case §5.3 says to hide the
 * feature for, and this is a way to find out that needs no browser, no login, and
 * nothing of the user's.
 *
 * WHAT IT WILL NOT CLAIM. With no runnable `claude` and no named home the answer
 * is `unknown`, not `ok`: `checkClaudeAuthStatus` falls back to a credential-FILE
 * check when the CLI cannot run, and that fallback would report a shiny new empty
 * directory as signed out no matter what the machine's real behaviour is. An
 * inference drawn from our own fallback is not evidence.
 */
export async function probeClaudeAccountIsolation(
  base: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeIsolationProbe> {
  const root = claudeAccountsRoot();
  if (!root) {
    return { verdict: 'unknown', detail: 'no naby home is configured, so no probe directory exists' };
  }
  if (!resolveClaudeBinary(base)) {
    return { verdict: 'unknown', detail: 'no runnable claude executable to ask' };
  }
  // A probe id is an ordinary account id, so it lands under the accounts root and
  // is subject to the same refusal rules. It never reaches the stored list.
  const probeId = newClaudeAccountId();
  const dir = ensureClaudeAccountDir(probeId);
  if (!dir) {
    return { verdict: 'unknown', detail: 'could not create a probe directory' };
  }
  try {
    const env = claudeAccountEnvFor(probeId, base);
    if (!env) return { verdict: 'unknown', detail: 'could not build the probe environment' };
    // UNCACHED on purpose: `checkClaudeAuthStatus` is the raw check, so a probe is
    // never answered from another namespace's ten-second-old answer.
    const state = await checkClaudeAuthStatus({ env });
    if (!state.cliFound) {
      return { verdict: 'unknown', detail: 'the claude executable disappeared mid-probe' };
    }
    if (state.status === 'signed-in') {
      return {
        verdict: 'broken',
        detail: 'a brand-new, empty config directory reported a live sign-in',
      };
    }
    if (state.status === 'signed-out') {
      return { verdict: 'ok', detail: 'a brand-new, empty config directory reported signed out' };
    }
    return { verdict: 'unknown', detail: `the CLI answered "${state.status}"` };
  } finally {
    removeClaudeAccountDir(probeId);
  }
}

// ---------------------------------------------------------------------------
// Add
// ---------------------------------------------------------------------------

export type AddClaudeAccountResult =
  | {
      ok: true;
      /** The new account's id. The ONLY handle the caller gets — no path. */
      accountId: string;
      /** The exact command that was launched, as the copy-paste fallback for a
       *  machine where no browser can open. Identical in spirit to
       *  `claudeLogin`'s. */
      command: string;
    }
  | {
      ok: false;
      error: string;
      /** Set when the refusal was "there is no CLI here", so the UI can offer the
       *  install routes instead of only the complaint (the `claude.login`
       *  precedent). */
      installHelp?: ClaudeInstallHelp;
      /** Set when the refusal was §5.3 — the partition does not hold here. The
       *  caller hides the feature; the verdict is already stored. */
      isolationBroken?: boolean;
    };

/**
 * Mint an account, prove the machine can keep it separate, then start the browser
 * sign-in in ITS namespace.
 *
 * Does NOT wait for the user (same contract as `claudeLogin`): the caller polls
 * `verifyClaudeAccount` until an identity appears. A failure at any step leaves
 * NOTHING behind — the directory is removed and no metadata row is written, so a
 * refused add cannot leave a ghost row that a later remove would try to log out
 * of.
 */
export async function addClaudeAccount(
  store: Store,
  opts: { email?: string; console?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<AddClaudeAccountResult> {
  const base = opts.env ?? process.env;
  if (!claudeAccountsRoot()) {
    return {
      ok: false,
      error:
        'No naby home is configured in this process, so there is nowhere to keep a second account.',
    };
  }
  if (!resolveClaudeBinary(base)) {
    return { ok: false, error: CLAUDE_CLI_MISSING_MESSAGE, installHelp: claudeInstallHelp() };
  }

  // §5.3 — ask before asking the user for anything.
  const probe = await probeClaudeAccountIsolation(base);
  if (probe.verdict !== 'unknown') writeClaudeAccountIsolation(store, probe.verdict);
  if (probe.verdict === 'broken') {
    return {
      ok: false,
      isolationBroken: true,
      error:
        'This computer does not keep Claude sign-ins separate per configuration directory, ' +
        `so a second account would be the same account (${probe.detail}).`,
    };
  }

  const id = newClaudeAccountId();
  const dir = ensureClaudeAccountDir(id);
  if (!dir) {
    return { ok: false, error: 'Could not create the folder for the new account.' };
  }

  const env = claudeAccountEnvFor(id, base);
  if (!env) {
    removeClaudeAccountDir(id);
    return { ok: false, error: 'Could not build the environment for the new account.' };
  }

  const started = claudeLogin({
    env,
    ...(opts.email ? { email: opts.email } : {}),
    ...(opts.console !== undefined ? { console: opts.console } : {}),
  });
  if (!started.ok) {
    removeClaudeAccountDir(id);
    return {
      ok: false,
      error: started.error,
      ...(started.installHelp ? { installHelp: started.installHelp } : {}),
    };
  }

  const meta: ClaudeAccountMeta = {
    id,
    addedAt: Date.now(),
    email: null,
    orgName: null,
    subscriptionType: null,
    status: 'signed-out',
    checkedAt: null,
  };
  upsertClaudeAccount(store, meta);
  return { ok: true, accountId: id, command: started.command };
}

// ---------------------------------------------------------------------------
// Verify — who is in this namespace now?
// ---------------------------------------------------------------------------

export type VerifyClaudeAccountResult =
  | { ok: true; account: ClaudeAccountMeta; state: ClaudeLoginState }
  | { ok: false; error: string };

/**
 * Run `claude auth status` in ONE account's environment and write what it says
 * back onto that account's row.
 *
 * This is both the post-login poll ("has the browser flow landed yet?") and the
 * refresh a user can ask for. It is also where the identity comes from at all:
 * the credential file has no email, `auth status` does, and this is the same
 * function the single-account chip uses — with a different `env`.
 *
 * FORCED, not cached: a poll that reuses a ten-second-old answer would show a
 * user who has just finished signing in a "signed out" row for another ten
 * seconds, which is the exact moment they are watching.
 */
export async function verifyClaudeAccount(
  store: Store,
  id: string,
  base: NodeJS.ProcessEnv = process.env,
): Promise<VerifyClaudeAccountResult> {
  const meta = listClaudeAccounts(store).find((a) => a.id === id);
  if (!meta) return { ok: false, error: 'unknown account' };
  const env = claudeAccountEnvFor(id, base);
  if (!env) return { ok: false, error: 'unknown account' };

  const state = await checkClaudeAuthStatus({ env });
  const next: ClaudeAccountMeta = {
    ...meta,
    email: state.account?.email ?? null,
    orgName: state.account?.orgName ?? null,
    subscriptionType: state.account?.subscriptionType ?? null,
    status:
      state.status === 'signed-in' || state.status === 'signed-out' ? state.status : 'unknown',
    checkedAt: state.checkedAt,
  };
  upsertClaudeAccount(store, next);
  return { ok: true, account: next, state };
}

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

export type RemoveClaudeAccountResult =
  | {
      ok: true;
      /** Whether `claude auth logout` succeeded in that namespace. The directory
       *  is removed either way — a stale namespace nobody can reach is worse than
       *  a Keychain entry we failed to revoke — but the caller may want to say so. */
      loggedOut: boolean;
      /** Whether this removal also cleared the ACTIVE selection. */
      wasActive: boolean;
    }
  | { ok: false; error: string };

/**
 * Sign out of the account, THEN delete its directory, THEN forget it.
 *
 * THE ORDER IS THE WHOLE FUNCTION. `claude auth logout` must run while
 * `CLAUDE_CONFIG_DIR` still points at the directory whose path hash names the
 * Keychain entry. Delete the directory first and the entry becomes unreachable
 * forever: nothing left on the machine can reconstruct the name, so it survives
 * every future logout, every reinstall, and every attempt by the user to clean up
 * after us.
 */
export async function removeClaudeAccount(
  store: Store,
  id: string,
  base: NodeJS.ProcessEnv = process.env,
): Promise<RemoveClaudeAccountResult> {
  const meta = listClaudeAccounts(store).find((a) => a.id === id);
  if (!meta) return { ok: false, error: 'unknown account' };
  const env = claudeAccountEnvFor(id, base);
  if (!env) return { ok: false, error: 'unknown account' };

  const wasActive = activeClaudeAccountId(store) === id;

  // 1. Revoke, while the path that names the credential still exists.
  const out = await claudeLogout(env);

  // 2. Now the directory may go.
  removeClaudeAccountDir(id);

  // 3. And only then the row, so a crash between 1 and 3 leaves an account the
  //    user can see and retry rather than an orphaned directory nobody knows of.
  deleteClaudeAccountMeta(store, id);
  if (wasActive) setActiveClaudeAccount(store, null);

  // Any cached answer about ANY namespace may now be about an account that no
  // longer exists.
  resetClaudeLoginCache();
  return { ok: true, loggedOut: out.ok, wasActive };
}

// ---------------------------------------------------------------------------
// The single-account entry points, pointed at whichever account is active
// ---------------------------------------------------------------------------
//
// THE CHIP MUST DESCRIBE THE ACCOUNT THAT ANSWERS. Without these three, the app
// would read `claude auth status` for the MACHINE DEFAULT while turns spent the
// selected account — the header naming one account and the answer belonging to
// another, which is precisely the disagreement §5.4 refuses a mid-turn switch to
// avoid. The same reasoning makes log in / log out follow the selection: a
// "Log out" button that signs out of a namespace the app is not using is a
// button that does nothing the user can see.
//
// EACH TAKES AN ID, NOT A PATH, and resolves the directory in here — so no caller
// (the shell included) ever holds one. `undefined` means the machine default and
// takes the byte-for-byte original path: no environment override at all.

/** `claude auth status` for the active account, or for the machine's own sign-in
 *  when none is selected. Same shape and same cache as the single-account read. */
export async function describeClaudeLoginForAccount(
  accountId: string | undefined,
  opts: { force?: boolean } = {},
): Promise<ClaudeLoginDescription> {
  const env = accountId ? claudeAccountEnvFor(accountId) : undefined;
  return describeClaudeLoginAsync({
    ...(env ? { env } : {}),
    ...(opts.force ? { force: true } : {}),
  });
}

/** Start the browser sign-in in the active account's namespace (or the machine's
 *  own when none is selected). */
export function claudeLoginForAccount(
  accountId: string | undefined,
  opts: { email?: string; console?: boolean } = {},
): ClaudeLoginResult {
  const env = accountId ? claudeAccountEnvFor(accountId) : undefined;
  return claudeLogin({ ...opts, ...(env ? { env } : {}) });
}

/** Sign out of the active account's namespace (or the machine's own). The
 *  ACCOUNT ITSELF SURVIVES — this is the chip's "Log out", not a removal, so the
 *  folder and the row stay and a later sign-in lands back in the same place. */
export async function claudeLogoutForAccount(
  accountId: string | undefined,
): Promise<ClaudeLogoutResult> {
  const env = accountId ? claudeAccountEnvFor(accountId) : undefined;
  return claudeLogout(env ?? process.env);
}

// ---------------------------------------------------------------------------
// What the UI is told (§5.6)
// ---------------------------------------------------------------------------

/** One account as it crosses the wire: id, labels, timestamps. NO PATH — see rule
 *  3 in `runtime/claude-accounts.ts`. */
export type ClaudeAccountView = ClaudeAccountMeta;

export type ClaudeAccountsDescription = {
  /** Whether to offer the feature at all (§5.3). */
  supported: boolean;
  /** Why: 'ok' / 'broken' / 'unknown' (we have not been able to ask yet). */
  isolation: ClaudeAccountIsolation;
  /** The chosen account, or null for "the one sign-in this computer has". */
  activeId: string | null;
  accounts: ClaudeAccountView[];
};

/**
 * The whole account block for one GET. Reads only the store — no process is
 * spawned — because this is polled by an open settings screen and a probe per
 * poll would be a process per poll.
 */
export function describeClaudeAccounts(store: Store): ClaudeAccountsDescription {
  return {
    supported: claudeAccountsSupported(store),
    isolation: readClaudeAccountIsolation(store),
    activeId: activeClaudeAccountId(store) ?? null,
    accounts: listClaudeAccounts(store),
  };
}
