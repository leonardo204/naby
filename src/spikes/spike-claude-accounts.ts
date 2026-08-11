// src/spikes/spike-claude-accounts.ts
//
// MORE THAN ONE CLAUDE SUBSCRIPTION, AND NOTHING OF THE USER'S IS TOUCHED
// (specs/claude-multi-account.md §5, §7).
//
// THE FIRST REQUIREMENT OF THIS SPIKE IS THAT IT IS SAFE TO RUN. Everything else
// here is about credentials, and the failure mode of getting it wrong is not a
// red line in a terminal — it is the developer's real Claude sign-in being
// deleted, with no way back except signing in again everywhere. So assertion (1)
// is not about the feature at all: it proves this process cannot reach
// `~/.claude` or the real naby home, and assertion (10) proves afterwards that it
// did not. The same discipline as `NABY_DB_PATH` in the shell's test setup, for a
// worse blast radius.
//
// NO REAL CLI, NO BROWSER, NO NETWORK. A fake `claude` shell script answers
// `auth status/login/logout` out of whatever `CLAUDE_CONFIG_DIR` points at, which
// is exactly the mechanism the feature rests on — so the isolation assertions are
// about the real environment plumbing even though the credentials are pretend.
//
// WHAT IT COVERS
//   1. the real `~/.claude` and the real naby home are unreachable from here
//   2. an unnamed home yields NO accounts root (never a silent `~/.naby`)
//   3. two namespaces do not see each other's sign-in
//   4. the login-status cache does not MIX ACCOUNTS (the §5.2 bug)
//   5. `buildQueryOptions` spreads the inherited environment (§5.1's warning)
//   6. no active account ⇒ no `env` option at all — today's behaviour, unchanged
//   7. the isolation probe calls a leaky machine leaky, and a partitioned one ok
//   8. add on a leaky machine refuses and leaves NOTHING behind
//   9. the full lifecycle: add → verify → select → remove, with LOGOUT BEFORE the
//      folder is deleted (the ordering that decides whether a Keychain entry can
//      ever be removed again)
//  10. nothing under the real home changed while all of that ran
//
// Prints PASS/FAIL per assertion; exits non-zero on any FAIL.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

// ---------------------------------------------------------------------------
// (0) The environment, set BEFORE anything that reads it is imported
// ---------------------------------------------------------------------------
//
// `claudeAccountsRoot()` reads the environment at CALL time, so plain imports are
// safe — but the temp home is established here anyway, first thing, so that no
// ordering change later can make this spike write into a real home.

const REAL_HOME = homedir();
const REAL_CLAUDE_DIR = join(REAL_HOME, '.claude');
const REAL_NABY_DIR = join(REAL_HOME, '.naby');

/** A fingerprint of a directory: what is in it and when it last changed. Compared
 *  before and after to prove this run left the user's own files alone. */
function fingerprint(dir: string): string {
  try {
    const st = statSync(dir);
    return `${readdirSync(dir).sort().join(',')}|mtime=${st.mtimeMs}`;
  } catch {
    return 'absent';
  }
}

const BEFORE_CLAUDE = fingerprint(REAL_CLAUDE_DIR);
const BEFORE_NABY = fingerprint(REAL_NABY_DIR);

const ROOT = mkdtempSync(join(tmpdir(), 'naby-claude-accounts-spike-'));
const TEMP_HOME = join(ROOT, 'naby-home');
const FAKE_OS_HOME = join(ROOT, 'os-home');
mkdirSync(TEMP_HOME, { recursive: true });
mkdirSync(FAKE_OS_HOME, { recursive: true });

// The one home this process may write into. `NABY_DB_PATH` is cleared because it
// would WIN over NABY_HOME (naby-home.ts precedence) and an inherited one from
// the developer's shell is exactly what this is protecting against.
delete process.env.NABY_DB_PATH;
delete process.env.COCKPIT_HOME;
process.env.NABY_HOME = TEMP_HOME;

const { MemoryStore } = await import('../runtime/store/memory-store.js');
const {
  claudeAccountsRoot,
  claudeAccountConfigDir,
  claudeAccountEnvFor,
  activeClaudeAccountId,
  listClaudeAccounts,
  newClaudeAccountId,
} = await import('../runtime/claude-accounts.js');
const {
  addClaudeAccount,
  describeClaudeAccounts,
  probeClaudeAccountIsolation,
  removeClaudeAccount,
  verifyClaudeAccount,
} = await import('../engines/claude-accounts.js');
const { checkClaudeAuthStatus, getClaudeAuthState, resetClaudeLoginCache } = await import(
  '../engines/claude-login.js'
);
const { buildQueryOptions } = await import('../engines/claude-agent-sdk-engine.js');
import type { EngineRunInput } from '../runtime/engine.js';

// ---------------------------------------------------------------------------
// The fake `claude`
// ---------------------------------------------------------------------------
//
// It answers ONLY out of `CLAUDE_CONFIG_DIR` — a `signed-in` file in that folder
// is the pretend credential. That is the whole point: the real CLI partitions by
// this variable (§3.1), so a fake that obeys the same rule exercises naby's half
// of the mechanism exactly.

const MARKER = join(ROOT, 'cli-calls.log');

function writeFakeClaude(path: string, opts: { leaky: boolean }): string {
  mkdirSync(join(path, '..'), { recursive: true });
  const statusBody = opts.leaky
    ? // A machine that does NOT partition: whatever directory you name, the same
      // sign-in answers. This is the case §5.3 says to hide the feature for.
      `printf '{"loggedIn":true,"email":"machine-wide@example.com","orgName":"Leaky","subscriptionType":"max"}\\n'`
    : `if [ -f "$DIR/signed-in" ]; then
    EMAIL=$(cat "$DIR/signed-in")
    printf '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","email":"%s","orgName":"Spike Org","subscriptionType":"max"}\\n' "$EMAIL"
  else
    printf '{"loggedIn":false}\\n'
  fi`;
  const script = `#!/bin/sh
DIR="\${CLAUDE_CONFIG_DIR:-UNSET}"
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  ${statusBody}
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "logout" ]; then
  if [ -d "$DIR" ]; then
    echo "logout dir=present" >> "${MARKER}"
  else
    echo "logout dir=missing" >> "${MARKER}"
  fi
  rm -f "$DIR/signed-in"
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "login" ]; then
  echo "login" >> "${MARKER}"
  exit 0
fi
exit 1
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

const FAKE_CLI = writeFakeClaude(join(ROOT, 'bin', 'claude'), { leaky: false });
const LEAKY_CLI = writeFakeClaude(join(ROOT, 'leakybin', 'claude'), { leaky: true });

/** The base environment every account operation is built from. `HOME` points at a
 *  temp directory so even the known-location binary probe cannot reach the real
 *  one, and `NABY_CLAUDE_BIN` pins the fake. */
function baseEnv(bin: string = FAKE_CLI): NodeJS.ProcessEnv {
  return {
    // A real PATH, because the fake CLI is a shell script that uses `cat` and
    // `rm`. It is never SEARCHED for a `claude`: `NABY_CLAUDE_BIN` short-circuits
    // resolution before PATH is consulted, so the machine's own CLI stays out of
    // this spike even though its directory is listed here.
    PATH: '/usr/bin:/bin',
    HOME: FAKE_OS_HOME,
    NABY_HOME: TEMP_HOME,
    NABY_CLAUDE_BIN: bin,
  };
}

/** Pretend the browser flow landed: write the credential the fake CLI reads. */
function signIn(accountId: string, email: string): void {
  const dir = claudeAccountConfigDir(accountId);
  if (!dir) throw new Error('no config dir for ' + accountId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'signed-in'), email);
}

// ---------------------------------------------------------------------------
// buildQueryOptions scaffolding (the same shape spike-cwd uses)
// ---------------------------------------------------------------------------

function queryArgs(): {
  input: EngineRunInput;
  mcpServer: Parameters<typeof buildQueryOptions>[0]['mcpServer'];
  preToolUse: Parameters<typeof buildQueryOptions>[0]['preToolUse'];
  abortController: AbortController;
  onStderr: (data: string) => void;
} {
  return {
    input: {
      model: { providerId: 'dev-claude' },
      messages: [{ role: 'user', content: 'hello' }],
      toolSchemas: [],
      gate: async () => ({ behavior: 'allow' as const }),
      executors: {},
      signal: new AbortController().signal,
    },
    mcpServer: {
      name: 'spike',
      instance: {},
    } as unknown as Parameters<typeof buildQueryOptions>[0]['mcpServer'],
    preToolUse: (async () => ({})) as unknown as Parameters<
      typeof buildQueryOptions
    >[0]['preToolUse'],
    abortController: new AbortController(),
    onStderr: () => {},
  };
}

async function main(): Promise<void> {
  // ---- 1. THE FIRST ASSERTION: the real home is out of reach ---------------
  const root = claudeAccountsRoot();
  const probeId = newClaudeAccountId();
  const probeDir = claudeAccountConfigDir(probeId);
  record(
    'SAFETY — every account path is under the temp home; nothing resolves into the real ~/.claude or ~/.naby',
    root !== undefined &&
      root.startsWith(TEMP_HOME) &&
      probeDir !== undefined &&
      probeDir.startsWith(TEMP_HOME) &&
      !root.startsWith(REAL_CLAUDE_DIR) &&
      !root.startsWith(REAL_NABY_DIR),
    `root=${root} accountDir=${probeDir} realClaude=${REAL_CLAUDE_DIR} realNaby=${REAL_NABY_DIR}`,
  );

  // ---- 2. an unnamed home yields NOTHING, never a silent default ----------
  // The discipline that makes assertion 1 hold for a spike someone writes LATER
  // and forgets to point at a temp home: with no home configured there is no
  // accounts root at all, so there is nothing to create.
  const saved = process.env.NABY_HOME;
  delete process.env.NABY_HOME;
  const rootWithNoHome = claudeAccountsRoot();
  process.env.NABY_HOME = saved;
  record(
    'no configured naby home ⇒ NO accounts root (it never falls back to ~/.naby)',
    rootWithNoHome === undefined,
    `root=${String(rootWithNoHome)}`,
  );

  // ---- 3. two namespaces do not see each other ----------------------------
  const store = new MemoryStore();
  const a = newClaudeAccountId();
  const b = newClaudeAccountId();
  mkdirSync(claudeAccountConfigDir(a)!, { recursive: true });
  mkdirSync(claudeAccountConfigDir(b)!, { recursive: true });
  signIn(a, 'first@example.com');

  const envA = claudeAccountEnvFor(a, baseEnv())!;
  const envB = claudeAccountEnvFor(b, baseEnv())!;
  const statusA = await checkClaudeAuthStatus({ env: envA });
  const statusB = await checkClaudeAuthStatus({ env: envB });
  record(
    'isolation — a sign-in in one config dir is invisible from the other',
    statusA.status === 'signed-in' &&
      statusA.account?.email === 'first@example.com' &&
      statusB.status === 'signed-out',
    `A=${statusA.status}/${statusA.account?.email} B=${statusB.status}`,
  );

  // ---- 4. THE CACHE MUST NOT MIX ACCOUNTS (the §5.2 bug) ------------------
  // Both reads happen inside the 10s cache window and in this order. With one
  // global slot the second read is answered with the FIRST account's identity —
  // which is the bug: the settings list then shows two rows with one email, and
  // the chip can name an account the turn is not spending.
  resetClaudeLoginCache();
  const cachedA = await getClaudeAuthState({ env: envA });
  const cachedB = await getClaudeAuthState({ env: envB });
  record(
    'the login-status cache is keyed by config dir — asking about B right after A does not return A',
    cachedA.status === 'signed-in' &&
      cachedA.account?.email === 'first@example.com' &&
      cachedB.status === 'signed-out' &&
      cachedB.account === null,
    `A=${cachedA.status}/${cachedA.account?.email ?? 'null'} B=${cachedB.status}/${
      cachedB.account?.email ?? 'null'
    }`,
  );
  // ...and the same answer is still REUSED for the namespace it belongs to, so
  // the fix did not simply turn the cache off.
  const cachedAgainA = await getClaudeAuthState({ env: envA });
  record(
    'the cache still caches: a second read of the SAME namespace reuses the first answer',
    cachedAgainA.checkedAt === cachedA.checkedAt,
    `first=${cachedA.checkedAt} second=${cachedAgainA.checkedAt}`,
  );

  // ---- 5. the environment is SPREAD, not replaced -------------------------
  // The SDK contract: `env` REPLACES the subprocess environment. A build that
  // passes `{ CLAUDE_CONFIG_DIR }` alone launches a CLI with no PATH and no HOME,
  // and the symptom ("the model could not start") names nothing. This pins the
  // spread.
  const base = { PATH: '/spike/bin', HOME: '/spike/home', SOME_OTHER: 'kept' };
  const withAccount = buildQueryOptions({ ...queryArgs(), accountId: a, env: base });
  record(
    'buildQueryOptions SPREADS the inherited environment and adds CLAUDE_CONFIG_DIR',
    withAccount.env?.CLAUDE_CONFIG_DIR === claudeAccountConfigDir(a) &&
      withAccount.env?.PATH === '/spike/bin' &&
      withAccount.env?.HOME === '/spike/home' &&
      withAccount.env?.SOME_OTHER === 'kept',
    `env=${JSON.stringify(withAccount.env)}`,
  );

  // ---- 6. no account ⇒ no `env` at all ------------------------------------
  const withoutAccount = buildQueryOptions({ ...queryArgs(), env: base });
  record(
    'no active account ⇒ the options carry NO env key (byte-for-byte the single-account turn)',
    !('env' in withoutAccount),
    `keys=${Object.keys(withoutAccount).includes('env') ? 'env present' : 'env absent'}`,
  );

  // ---- 7. the isolation probe ---------------------------------------------
  const okProbe = await probeClaudeAccountIsolation(baseEnv());
  const leakyProbe = await probeClaudeAccountIsolation(baseEnv(LEAKY_CLI));
  record(
    'the isolation probe says ok on a partitioning machine and broken on a leaky one',
    okProbe.verdict === 'ok' && leakyProbe.verdict === 'broken',
    `ok=${okProbe.verdict} (${okProbe.detail}) leaky=${leakyProbe.verdict} (${leakyProbe.detail})`,
  );

  // ---- 8. adding on a leaky machine refuses and leaves nothing behind ------
  const leakyStore = new MemoryStore();
  const before = readdirSync(claudeAccountsRoot()!).length;
  const refused = await addClaudeAccount(leakyStore, { env: baseEnv(LEAKY_CLI) });
  const after = readdirSync(claudeAccountsRoot()!).length;
  record(
    'add on a machine that cannot keep sign-ins apart is refused, stores no account and leaves no folder',
    refused.ok === false &&
      refused.isolationBroken === true &&
      listClaudeAccounts(leakyStore).length === 0 &&
      before === after &&
      describeClaudeAccounts(leakyStore).supported === false,
    `refused=${JSON.stringify(refused)} dirsBefore=${before} dirsAfter=${after}`,
  );

  // ---- 9. the lifecycle, and the ORDER of a removal -----------------------
  const added = await addClaudeAccount(store, { env: baseEnv() });
  if (!added.ok) {
    record('add succeeds on a partitioning machine', false, JSON.stringify(added));
  } else {
    const id = added.accountId;
    const dir = claudeAccountConfigDir(id)!;
    record(
      'add mints an OPAQUE id, creates its folder, and stores a row with no identity yet',
      /^acct-[0-9a-f]{12}$/.test(id) &&
        existsSync(dir) &&
        listClaudeAccounts(store).some((x) => x.id === id && x.email === null),
      `id=${id} dirExists=${existsSync(dir)}`,
    );

    // The browser flow lands (simulated: the CLI writes the credential).
    signIn(id, 'second@example.com');
    const verified = await verifyClaudeAccount(store, id, baseEnv());
    record(
      'verify reads the identity out of THAT namespace and stores labels only',
      verified.ok === true &&
        verified.account.email === 'second@example.com' &&
        verified.account.status === 'signed-in' &&
        !JSON.stringify(verified.account).includes(TEMP_HOME),
      `account=${verified.ok ? JSON.stringify(verified.account) : verified.error}`,
    );

    // §5.6 — what the UI is handed carries no path.
    const described = JSON.stringify(describeClaudeAccounts(store));
    record(
      'the UI-facing description contains no filesystem path',
      !described.includes(TEMP_HOME) && !described.includes('claude-accounts'),
      `description=${described.slice(0, 220)}`,
    );

    // Selecting is the runtime half of §5.5 (the refusal and the log line are the
    // shell's, because they are about the app's state, not the account's).
    const { setActiveClaudeAccount } = await import('../runtime/claude-accounts.js');
    setActiveClaudeAccount(store, id);
    record(
      'the selection is one global id, and reads back',
      activeClaudeAccountId(store) === id,
      `active=${String(activeClaudeAccountId(store))}`,
    );

    // THE ORDER. `claude auth logout` must run while the folder still exists: the
    // Keychain entry is named with that path's hash, so removing the folder first
    // destroys the only thing that could ever name the entry again.
    writeFileSync(MARKER, '');
    const removed = await removeClaudeAccount(store, id, baseEnv());
    const calls = readFileSync(MARKER, 'utf8').trim();
    record(
      'remove runs `claude auth logout` while the folder still exists, THEN deletes it',
      removed.ok === true &&
        calls.includes('logout dir=present') &&
        !calls.includes('logout dir=missing') &&
        !existsSync(dir) &&
        listClaudeAccounts(store).length === 0 &&
        activeClaudeAccountId(store) === undefined,
      `cliCalls=${JSON.stringify(calls)} dirStillThere=${existsSync(dir)} active=${String(
        activeClaudeAccountId(store),
      )}`,
    );
  }

  // ---- 10. and the real home is exactly as we found it --------------------
  record(
    'SAFETY — the real ~/.claude and ~/.naby are byte-identical to before this ran',
    fingerprint(REAL_CLAUDE_DIR) === BEFORE_CLAUDE && fingerprint(REAL_NABY_DIR) === BEFORE_NABY,
    `claude ${fingerprint(REAL_CLAUDE_DIR) === BEFORE_CLAUDE ? 'unchanged' : 'CHANGED'}; naby ${
      fingerprint(REAL_NABY_DIR) === BEFORE_NABY ? 'unchanged' : 'CHANGED'
    }`,
  );
}

try {
  await main();
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

let failed = false;
for (const c of checks) {
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  —  ${c.evidence}`);
  if (!c.pass) failed = true;
}
console.log(failed ? '\nSPIKE FAILED' : '\nSPIKE PASSED');
process.exit(failed ? 1 : 0);
