// scripts/verify-mac.mjs
//
// F1-10 ACCEPTANCE for the macOS half. Runs the three checks that actually
// determine whether a build is distributable AND updatable, against the real
// artifact, and exits non-zero if any of them fails.
//
// The three are not redundant — each catches a different failure that the other
// two pass:
//
//   codesign -dv --verbose=4
//     Is it signed, and by WHOM? An ad-hoc signature (`Signature=adhoc`) passes
//     a naive "is it signed" test and is useless for updates: its designated
//     requirement is pinned to this build's own cdhash, so the NEXT build can
//     never satisfy it. This step asserts the Authority is a Developer ID.
//
//   spctl -a -vvv -t exec
//     Would Gatekeeper let a user OPEN it? This is the check that fails when the
//     app is signed but NOT notarised — the "Naby is damaged and can't be
//     opened" case. Signing alone does not get past Gatekeeper.
//
//   stapler validate
//     Is the notarisation ticket IN the bundle? Without a staple the app still
//     opens, but only after an online check with Apple; offline or during an
//     Apple outage it fails. Stapling is what makes it deterministic.
//
// Only the first of these has anything to do with auto-update; the other two are
// about first launch. Both matter, and passing one is routinely mistaken for
// passing all three.

import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(cmd, args) {
  return new Promise((resolveP) => {
    execFile(cmd, args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolveP({ code: err?.code ?? 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/** Find the built .app under release/, preferring an explicit argv path. */
function findApp() {
  const explicit = process.argv[2];
  if (explicit) return explicit;

  const releaseDir = resolve(root, 'release');
  if (!existsSync(releaseDir)) return undefined;

  for (const entry of readdirSync(releaseDir)) {
    // mac-arm64/Naby.app for an arch build, mac/Naby.app otherwise
    if (!entry.startsWith('mac')) continue;
    const dir = join(releaseDir, entry);
    for (const inner of readdirSync(dir)) {
      if (inner.endsWith('.app')) return join(dir, inner);
    }
  }
  return undefined;
}

const appPath = findApp();
if (!appPath || !existsSync(appPath)) {
  console.error('[verify:mac] no .app found under release/. Build one first: npm run dist:mac');
  process.exit(1);
}

console.log(`[verify:mac] ${appPath}\n`);

let failed = false;
function report(name, passOk, output) {
  console.log(`--- ${name} ---`);
  console.log(output.trim());
  console.log(passOk ? `\n==> ${name}: PASS\n` : `\n==> ${name}: FAIL\n`);
  if (!passOk) failed = true;
}

// 1. codesign — signed, and by a Developer ID (not ad-hoc, not unsigned).
{
  const r = await run('codesign', ['-dv', '--verbose=4', appPath]);
  const out = r.stderr || r.stdout; // codesign reports on stderr
  const isDeveloperId = /Authority=Developer ID Application/.test(out);
  const isAdhoc = /Signature=adhoc/.test(out);
  report('codesign -dv --verbose=4', r.code === 0 && isDeveloperId && !isAdhoc, out);
  if (isAdhoc) {
    console.error(
      '[verify:mac] AD-HOC SIGNATURE. This build can never auto-update: Squirrel.Mac ' +
        "validates against the running app's designated requirement, and an ad-hoc " +
        'requirement is pinned to this exact binary.',
    );
  }
}

// 1b. A strict structural verification, since -dv only reads the header.
{
  const r = await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  report('codesign --verify --deep --strict', r.code === 0, r.stderr || r.stdout);
}

// 2. spctl — would Gatekeeper open it?
{
  const r = await run('spctl', ['-a', '-vvv', '-t', 'exec', appPath]);
  const out = r.stderr || r.stdout;
  report('spctl -a -vvv', r.code === 0 && /accepted/.test(out), out);
}

// 3. stapler — is the notarisation ticket in the bundle?
{
  const r = await run('xcrun', ['stapler', 'validate', appPath]);
  const out = r.stdout || r.stderr;
  report('stapler validate', r.code === 0 && /The validate action worked/.test(out), out);
}

if (failed) {
  console.error('[verify:mac] FAILED — this build is not distributable.');
  process.exit(1);
}
console.log('[verify:mac] all checks passed — signed, notarised, stapled, and updatable.');
