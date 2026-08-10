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
//   5. WINDOWS RESOLUTION finds `%USERPROFILE%\.local\bin\claude.exe`. The known
//      location was probed WITHOUT an extension, which is a name that never
//      exists on Windows, so that probe always missed and PATH was the only
//      thing left — and PATH in an already-running Electron process does not
//      contain what was installed five minutes ago. A Windows user could install
//      the CLI correctly and still be told it was not there. `platform` is a
//      parameter of `resolveClaudeBinary` so this is provable from a Mac.
//   6. INSTALL HELP is a pure function of the platform, and says what the
//      official setup page says — so the settings UI can offer the right
//      command with a copy button instead of "install it, then run…".
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
  claudeExecutableNames,
  claudeInstallHelp,
  claudeLogin,
  claudeLogout,
  resolveClaudeBinary,
  CLAUDE_INSTALL_DOCS_URL,
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
 *  resolution to consider it, used to prove a shim dir is SKIPPED and to lay out
 *  a fake Windows install (`name` = 'claude.exe') on a machine that is not one. */
function writeStubClaude(dir: string, name = 'claude'): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
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

    // ---- 6. WINDOWS: the known location is probed WITH an extension -------
    // REGRESSION. The native Windows installer writes
    // `%USERPROFILE%\.local\bin\claude.exe`; the known-location probe stat'd the
    // extensionless name only, so it never matched and the app fell back to
    // PATH — which an already-running Electron process inherited BEFORE the
    // install. PATH is empty here precisely to prove the known location alone
    // now answers.
    const winHome = join(root, 'win-home');
    const winExe = writeStubClaude(join(winHome, '.local', 'bin'), 'claude.exe');
    const winFromHome = resolveClaudeBinary({ HOME: winHome, PATH: '' }, 'win32');
    checks.push({
      name: 'win32: ~/.local/bin/claude.exe is found with no PATH at all',
      pass: winFromHome === winExe,
      evidence: `resolved=${winFromHome} expected=${winExe}`,
    });

    // The variable the setup docs name for that path is USERPROFILE, and Windows
    // usually has no HOME at all.
    const winFromUserProfile = resolveClaudeBinary({ USERPROFILE: winHome, PATH: '' }, 'win32');
    checks.push({
      name: 'win32: %USERPROFILE% is honoured when HOME is unset',
      pass: winFromUserProfile === winExe,
      evidence: `resolved=${winFromUserProfile} expected=${winExe}`,
    });

    // The extension list is PATHEXT's, applied to the known location as well as
    // to PATH — an extensionless file in that directory is not executable on
    // Windows and must not be picked.
    const winBareHome = join(root, 'win-home-bare');
    writeStubClaude(join(winBareHome, '.local', 'bin'), 'claude');
    const winBare = resolveClaudeBinary({ HOME: winBareHome, PATH: '' }, 'win32');
    checks.push({
      name: 'win32: an extensionless ~/.local/bin/claude is NOT accepted',
      pass: winBare === null,
      evidence: `resolved=${winBare}`,
    });

    // A `.cmd` install (npm global on Windows) is found because PATHEXT lists it.
    const winCmdHome = join(root, 'win-home-cmd');
    const winCmd = writeStubClaude(join(winCmdHome, '.local', 'bin'), 'claude.cmd');
    const winCmdResolved = resolveClaudeBinary(
      { HOME: winCmdHome, PATH: '', PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      'win32',
    );
    checks.push({
      name: 'win32: PATHEXT drives the names tried (claude.cmd resolves)',
      pass: winCmdResolved === winCmd,
      evidence: `resolved=${winCmdResolved} expected=${winCmd}`,
    });

    // ---- 7. NON-WIN32 IS UNCHANGED --------------------------------------
    // The same probe on a POSIX platform: the bare name, and only the bare name.
    const posixHome = join(root, 'posix-home');
    const posixBin = writeStubClaude(join(posixHome, '.local', 'bin'), 'claude');
    const posixResolved = resolveClaudeBinary({ HOME: posixHome, PATH: '' }, 'linux');
    const posixNames = claudeExecutableNames({ PATHEXT: '.EXE;.CMD' }, 'darwin');
    checks.push({
      name: 'non-win32: ~/.local/bin/claude still resolves, and only that name is tried',
      pass:
        posixResolved === posixBin &&
        posixNames.length === 1 &&
        posixNames[0] === 'claude' &&
        // The default (no platform argument) is this machine, as before.
        resolveClaudeBinary({ HOME: posixHome, PATH: '' }) === posixBin,
      evidence: `resolved=${posixResolved} expected=${posixBin} names=${JSON.stringify(posixNames)}`,
    });

    // An empty PATHEXT entry (a trailing ';' is common on Windows) must not
    // become the bare, unexecutable name.
    const extNames = claudeExecutableNames({ PATHEXT: '.EXE;.CMD;' }, 'win32');
    checks.push({
      name: 'win32: empty PATHEXT entries are dropped rather than becoming `claude`',
      pass: JSON.stringify(extNames) === JSON.stringify(['claude.exe', 'claude.cmd']),
      evidence: `names=${JSON.stringify(extNames)}`,
    });

    // ---- 8. INSTALL HELP is the official setup page, as data --------------
    const win = claudeInstallHelp('win32');
    const mac = claudeInstallHelp('darwin');
    const linux = claudeInstallHelp('linux');
    const ids = (h: { alternatives: { id: string }[] }) => h.alternatives.map((a) => a.id);
    checks.push({
      name: 'claudeInstallHelp(win32) recommends the native PowerShell installer',
      pass:
        win.platform === 'windows' &&
        win.recommended.id === 'windows-powershell' &&
        win.recommended.command === 'irm https://claude.ai/install.ps1 | iex' &&
        JSON.stringify(ids(win)) === JSON.stringify(['windows-cmd', 'windows-winget', 'npm']) &&
        win.docsUrl === CLAUDE_INSTALL_DOCS_URL,
      evidence: `recommended=${win.recommended.command} alternatives=${JSON.stringify(ids(win))}`,
    });
    checks.push({
      name: 'claudeInstallHelp(darwin/linux) recommends the native script; brew is macOS-only',
      pass:
        mac.platform === 'macos' &&
        mac.recommended.command === 'curl -fsSL https://claude.ai/install.sh | bash' &&
        JSON.stringify(ids(mac)) === JSON.stringify(['macos-homebrew', 'npm']) &&
        linux.platform === 'linux' &&
        linux.recommended.command === mac.recommended.command &&
        JSON.stringify(ids(linux)) === JSON.stringify(['npm']),
      evidence: `mac=${JSON.stringify(ids(mac))} linux=${JSON.stringify(ids(linux))}`,
    });
    checks.push({
      name: 'every platform carries the two caveats: no admin rights, paid plan required',
      pass: [win, mac, linux].every(
        (h) =>
          h.notes.includes('no-admin-required') &&
          h.notes.includes('paid-plan-required') &&
          h.alternatives.some((a) => a.command === 'npm install -g @anthropic-ai/claude-code'),
      ),
      evidence: `notes=${JSON.stringify(win.notes)}`,
    });

    // ---- 9. a login attempt with no CLI hands back the install help -------
    // No browser can open here: resolution fails before anything is spawned.
    const loginNoCli = claudeLogin({ env: { NABY_CLAUDE_BIN: join(root, 'does-not-exist') } });
    checks.push({
      name: 'claudeLogin with no CLI returns structured install help, not just "install it"',
      pass:
        loginNoCli.ok === false &&
        loginNoCli.installHelp?.docsUrl === CLAUDE_INSTALL_DOCS_URL &&
        (loginNoCli.installHelp?.recommended.command.length ?? 0) > 0 &&
        loginNoCli.error.includes(CLAUDE_INSTALL_DOCS_URL) &&
        // The copy-paste sign-in command still comes back for a headless box.
        loginNoCli.command === 'claude auth login --claudeai',
      evidence: `error=${JSON.stringify(loginNoCli.ok === false ? loginNoCli.error : '')} help=${JSON.stringify(
        loginNoCli.ok === false ? loginNoCli.installHelp?.recommended : null,
      )}`,
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
