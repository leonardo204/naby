// scripts/trace-profile-scan.cjs
//
// TEMPORARY DIAGNOSTIC — loaded via NODE_OPTIONS=--require on the Windows CI job
// only, to answer one question: WHO reads the user profile during `next build`?
//
// The Windows build dies with
//   glob error [EACCES: permission denied, scandir
//     'C:\Users\runneradmin\Local Settings\Microsoft\WindowsApps\...']
// and the error is reported without a stack, so the caller is invisible. Static
// reading of Next's internals narrowed it to "something globs the profile" and
// no further — the same build on macOS and Linux never touches HOME, and the
// emitted .nft.json traces contain no home paths, so the usual suspect (the file
// tracer following os.homedir()) is ruled out.
//
// This wraps the directory-reading syscalls, and the first few times one is
// asked for a path under the profile it prints the stack that led there. It
// never changes behaviour: every call is forwarded untouched, and a failure to
// patch is swallowed.
//
// Delete this file and its NODE_OPTIONS line once the caller is identified.

const fs = require('node:fs');
const os = require('node:os');

const PROFILE = (process.env.USERPROFILE || os.homedir() || '').toLowerCase();
const MAX_REPORTS = 6;
let reported = 0;

function isUnderProfile(target) {
  if (!PROFILE || typeof target !== 'string') return false;
  return target.toLowerCase().startsWith(PROFILE);
}

function report(fnName, target) {
  if (reported >= MAX_REPORTS || !isUnderProfile(target)) return;
  reported += 1;
  const stack = new Error('profile scan').stack ?? '(no stack)';
  console.error(`\n[trace-profile-scan] ${fnName} -> ${target}\n${stack}\n`);
}

function wrap(owner, name) {
  const original = owner?.[name];
  if (typeof original !== 'function') return;
  owner[name] = function patched(target, ...rest) {
    try {
      report(name, typeof target === 'string' ? target : String(target));
    } catch {
      // A diagnostic must never be the reason a build fails.
    }
    return original.call(this, target, ...rest);
  };
}

try {
  wrap(fs, 'readdirSync');
  wrap(fs, 'readdir');
  wrap(fs, 'opendirSync');
  wrap(fs, 'opendir');
  wrap(fs.promises, 'readdir');
  wrap(fs.promises, 'opendir');
  console.error(`[trace-profile-scan] armed; profile=${PROFILE}`);
} catch (e) {
  console.error(`[trace-profile-scan] could not arm: ${String(e)}`);
}
