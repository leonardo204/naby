// scripts/build-dist.mjs
//
// Runs electron-builder with `.env` loaded FIRST.
//
// WHY A WRAPPER INSTEAD OF LOADING `.env` FROM THE afterSign HOOK: timing. The
// signing variables — CSC_NAME and CSC_IDENTITY_AUTO_DISCOVERY — are read by
// electron-builder while it signs, which happens BEFORE afterSign runs. A hook
// that loads `.env` can fix up notarisation credentials but arrives far too late
// to influence which identity was used, or whether auto-discovery grabbed the
// wrong certificate off the keychain. So the environment has to be complete
// before electron-builder's process starts, and the only way to guarantee that
// is to be the thing that starts it.
//
// CSC_IDENTITY_AUTO_DISCOVERY=false IS NOT A DETAIL. With auto-discovery on,
// electron-builder scans the keychain and picks an identity itself. On a machine
// with more than one Apple certificate that is a coin flip, and design §6.2's
// one-way door makes a coin flip unacceptable: signing a release with the wrong
// identity permanently strands every user who installs it, because Squirrel.Mac
// validates future updates against the identity of the app they are RUNNING.
// Auto-discovery off + CSC_NAME pinned to
// `Developer ID Application: YONGSUB LEE (XU8HS9JUTS)` makes the identity an
// explicit, reviewable input instead of an ambient one.
//
// Pass-through: everything after `--` reaches electron-builder verbatim, so
// `node scripts/build-dist.mjs --mac --publish never` works as expected.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './load-env.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Resolve electron-builder from node_modules/.bin rather than trusting PATH.
 *
 * npm puts node_modules/.bin on PATH for scripts it runs itself, so a bare
 * `spawn('electron-builder')` works from an npm script and fails with ENOENT
 * the moment anyone runs `node scripts/build-dist.mjs` directly — which is
 * exactly how the CI workflow invokes it. Resolving the path ourselves makes
 * the two invocation styles behave identically.
 */
function electronBuilderBin() {
  const bin = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
  return existsSync(bin) ? bin : 'electron-builder'; // fall back to PATH
}

const applied = loadEnv();
if (applied.length > 0) {
  // NAMES ONLY — see load-env.mjs rule 1. This line is the only acknowledgement
  // the credentials exist, and it must stay safe to paste into an issue.
  console.log(`[build] loaded from .env: ${applied.join(', ')}`);
}

// A guard, not a nicety. If CSC_NAME is set but auto-discovery was left on,
// electron-builder can still pick a different certificate and the resulting
// build walks through the one-way door with the wrong key.
if (process.env.CSC_NAME && process.env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false') {
  console.warn(
    '[build] WARNING CSC_NAME is set but CSC_IDENTITY_AUTO_DISCOVERY is not "false"; ' +
      'electron-builder may pick a different keychain identity. Forcing it off.',
  );
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
}

const args = process.argv.slice(2);

// A `--dir` build is an unpacked tree for local smoke-testing — there is no
// installer, nothing to distribute, and notarisation would add minutes and a
// network round trip to the inner loop for an artifact nobody can install.
// Setting this here (rather than expecting the caller to remember) is what keeps
// `npm run electron:pack` fast and offline even on a machine that has full Apple
// credentials sitting in its environment.
if (args.includes('--dir')) {
  process.env.SKIP_NOTARIZE ??= '1';
}

const child = spawn(electronBuilderBin(), args, {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

child.on('error', (err) => {
  console.error(`[build] failed to start electron-builder: ${err.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[build] electron-builder terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
