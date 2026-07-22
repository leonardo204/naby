// src/spikes/spike-claude-auth.ts
//
// SPIKE — Claude account management drives the `claude auth` CLI, and does so
// against the RIGHT binary.
//
// The account chip (F2) logs in, logs out, and shows WHO is signed in — the real
// EMAIL — by running `claude auth status/login/logout`. Two things had to be
// proven without touching the developer's real account or opening a browser:
//
//   1. BINARY RESOLUTION skips the cmux shim. In dev a `claude` on PATH is a
//      cmux shim that deadlocks a nested `claude`; `resolveClaudeBinary` must
//      pick the real one from a non-shim dir instead.
//   2. STATUS PARSE surfaces the email. `checkClaudeAuthStatus` must map the
//      `claude auth status` JSON — which carries the email the credential file
//      lacks — into `account.email`.
//   3. LOGOUT invokes the CLI (`claude auth logout`), not a file delete.
//   4. SIGNED-OUT is mapped from `loggedIn:false`.
//
// It uses a FAKE `claude` executable that prints the known JSON for `auth status`
// and records `auth logout` — so no real `claude auth login/logout` ever runs
// against the user's account, and no browser opens.
//
// Prints PASS/FAIL per assertion; exits non-zero on any FAIL.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkClaudeAuthStatus,
  claudeLogout,
  resolveClaudeBinary,
} from '../engines/claude-login.js';

type Check = { name: string; pass: boolean; evidence: string };

const KNOWN_EMAIL = 'spike-user@example.com';
const KNOWN_ORG = "spike-user@example.com's Organization";
const KNOWN_PLAN = 'max';

/** Write an executable `claude` shell script into `dir`. When `loggedIn` it
 *  prints the known status JSON; `auth logout` appends a line to `marker`. */
function writeFakeClaude(dir: string, opts: { loggedIn: boolean; marker: string }): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'claude');
  const statusJson = opts.loggedIn
    ? JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
        email: KNOWN_EMAIL,
        orgId: '00000000-0000-0000-0000-000000000000',
        orgName: KNOWN_ORG,
        subscriptionType: KNOWN_PLAN,
      })
    : JSON.stringify({ loggedIn: false });
  const script =
    '#!/bin/sh\n' +
    'if [ "$1" = "auth" ] && [ "$2" = "status" ]; then\n' +
    `  cat <<'JSON'\n${statusJson}\nJSON\n` +
    '  exit 0\n' +
    'fi\n' +
    'if [ "$1" = "auth" ] && [ "$2" = "logout" ]; then\n' +
    `  echo "auth logout" >> "${opts.marker}"\n` +
    '  exit 0\n' +
    'fi\n' +
    'exit 1\n';
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

/** A bare `claude` file (not a working script) — enough for stat-based
 *  resolution to consider it, used to prove a shim dir is SKIPPED. */
function writeStubClaude(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'claude');
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  chmodSync(path, 0o755);
  return path;
}

async function main(): Promise<void> {
  const checks: Check[] = [];
  const root = mkdtempSync(join(tmpdir(), 'naby-claude-auth-spike-'));

  try {
    // ---- 1. binary resolution skips the cmux shim -----------------------
    // A shim dir (name contains 'cmux-cli-shims') and a real dir both hold a
    // `claude`. HOME points at an empty temp home so the ~/.local/bin/claude
    // probe misses and the PATH search is what decides.
    const shimDir = join(root, 'T', 'cmux-cli-shims', 'ABC');
    const realDir = join(root, 'realbin');
    writeStubClaude(shimDir);
    const realClaude = writeStubClaude(realDir);
    const emptyHome = join(root, 'home-empty');
    mkdirSync(emptyHome, { recursive: true });

    const resolveEnv: NodeJS.ProcessEnv = {
      HOME: emptyHome,
      PATH: `${shimDir}:${realDir}`,
    };
    const resolved = resolveClaudeBinary(resolveEnv);
    checks.push({
      name: 'resolveClaudeBinary skips the cmux-shim dir, picks the real one',
      pass: resolved === realClaude,
      evidence: `resolved=${resolved} expected=${realClaude} shim=${join(shimDir, 'claude')}`,
    });

    // ---- 2. status parse surfaces the real email ------------------------
    const marker = join(root, 'logout-marker.txt');
    const fakeBin = writeFakeClaude(join(root, 'fakebin'), { loggedIn: true, marker });
    const statusEnv: NodeJS.ProcessEnv = { NABY_CLAUDE_BIN: fakeBin };
    const signedIn = await checkClaudeAuthStatus({ env: statusEnv, now: Date.UTC(2026, 0, 1) });
    checks.push({
      name: 'checkClaudeAuthStatus surfaces email/org/plan from `auth status`',
      pass:
        signedIn.status === 'signed-in' &&
        signedIn.account?.email === KNOWN_EMAIL &&
        signedIn.account?.orgName === KNOWN_ORG &&
        signedIn.account?.subscriptionType === KNOWN_PLAN &&
        signedIn.cliFound === true,
      evidence: `status=${signedIn.status} account=${JSON.stringify(signedIn.account)}`,
    });

    // ---- 3. logout invokes the CLI (`claude auth logout`) ---------------
    const logoutRes = await claudeLogout(statusEnv);
    let markerBody = '';
    try {
      markerBody = readFileSync(marker, 'utf8');
    } catch {
      markerBody = '';
    }
    checks.push({
      name: 'claudeLogout runs `claude auth logout` (CLI, not a file delete)',
      pass: logoutRes.ok === true && /auth logout/.test(markerBody),
      evidence: `result=${JSON.stringify(logoutRes)} marker=${JSON.stringify(markerBody.trim())}`,
    });

    // ---- 4. signed-out mapping from loggedIn:false ----------------------
    const fakeOut = writeFakeClaude(join(root, 'fakebin-out'), { loggedIn: false, marker });
    const outEnv: NodeJS.ProcessEnv = { NABY_CLAUDE_BIN: fakeOut };
    const signedOut = await checkClaudeAuthStatus({ env: outEnv, now: Date.UTC(2026, 0, 1) });
    checks.push({
      name: 'checkClaudeAuthStatus maps loggedIn:false to signed-out',
      pass: signedOut.status === 'signed-out' && signedOut.account === null && signedOut.cliFound === true,
      evidence: `status=${signedOut.status} account=${JSON.stringify(signedOut.account)}`,
    });

    // ---- 5. missing binary is a clear state, not a hang -----------------
    const noBinEnv: NodeJS.ProcessEnv = { NABY_CLAUDE_BIN: join(root, 'does-not-exist') };
    const noBin = resolveClaudeBinary(noBinEnv);
    checks.push({
      name: 'resolveClaudeBinary returns null when the override points nowhere',
      pass: noBin === null,
      evidence: `resolved=${noBin}`,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  let failed = false;
  for (const c of checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  —  ${c.evidence}`);
    if (!c.pass) failed = true;
  }
  console.log(failed ? '\nSPIKE FAILED' : '\nSPIKE PASSED');
  process.exit(failed ? 1 : 0);
}

void main();
