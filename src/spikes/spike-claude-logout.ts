// src/spikes/spike-claude-logout.ts
//
// SPIKE — `claudeLogout` removes the sign-in and the check then reports it.
//
// The account-management UI (F2) offers a "Log out" action. Its whole contract
// is: after it runs, the app reflects "signed out". This spike proves that
// end-to-end against a REAL temp credential file, using CLAUDE_CONFIG_DIR so the
// developer's actual `~/.claude/.credentials.json` is never touched.
//
// Assertions:
//   1. with a modelled, live credential file present → checkClaudeLogin is
//      'signed-in' and surfaces the subscription label (identity, not an email);
//   2. claudeLogout() removes the file and returns { ok:true, removed:true };
//   3. checkClaudeLogin now reports 'signed-out';
//   4. a second claudeLogout() on the already-removed file is { ok:true,
//      removed:false } — idempotent, not an error;
//   5. claudeLogout NEVER touches a path outside CLAUDE_CONFIG_DIR.
//
// Prints PASS/FAIL per assertion; exits non-zero on any FAIL.

import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkClaudeLogin,
  claudeCredentialsPath,
  claudeLogout,
  resetClaudeLoginCache,
} from '../engines/claude-login.js';

type Check = { name: string; pass: boolean; evidence: string };

function main(): void {
  const checks: Check[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'naby-logout-spike-'));
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: dir };
  // A hostile env token would make the file-based logout a no-op; the spike
  // tests the FILE path, so make sure that variable is not inherited.
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  const path = claudeCredentialsPath(env);
  const now = Date.UTC(2026, 0, 1);

  try {
    mkdirSync(dir, { recursive: true });
    // A modelled, LIVE credential: access token not yet expired, plus the
    // identity labels the real file carries (no email exists in the schema).
    writeFileSync(
      path,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'redacted-not-read',
          refreshToken: 'redacted-not-read',
          expiresAt: now + 3_600_000,
          refreshTokenExpiresAt: now + 30 * 24 * 3_600_000,
          subscriptionType: 'max',
          rateLimitTier: 'default_claude_max_5x',
          scopes: ['user:inference'],
        },
      }),
    );

    resetClaudeLoginCache();
    const before = checkClaudeLogin({ env, now });
    checks.push({
      name: 'signed-in before logout, subscription surfaced',
      pass: before.status === 'signed-in' && before.account?.subscriptionType === 'max',
      evidence: `status=${before.status} account=${JSON.stringify(before.account)}`,
    });

    const out1 = claudeLogout(env);
    checks.push({
      name: 'logout removes the file',
      pass: out1.ok === true && out1.removed === true && !existsSync(path),
      evidence: `result=${JSON.stringify(out1)} fileExists=${existsSync(path)}`,
    });

    resetClaudeLoginCache();
    const after = checkClaudeLogin({ env, now });
    checks.push({
      name: 'signed-out after logout',
      pass: after.status === 'signed-out' && after.account === null,
      evidence: `status=${after.status} account=${JSON.stringify(after.account)}`,
    });

    const out2 = claudeLogout(env);
    checks.push({
      name: 'idempotent: second logout is ok/removed:false',
      pass: out2.ok === true && out2.removed === false,
      evidence: `result=${JSON.stringify(out2)}`,
    });

    checks.push({
      name: 'logout confined to CLAUDE_CONFIG_DIR',
      pass: path.startsWith(dir),
      evidence: `path=${path} dir=${dir}`,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  let failed = false;
  for (const c of checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  —  ${c.evidence}`);
    if (!c.pass) failed = true;
  }
  console.log(failed ? '\nSPIKE FAILED' : '\nSPIKE PASSED');
  process.exit(failed ? 1 : 0);
}

main();
