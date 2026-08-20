// src/spikes/spike-window-runtime.ts
//
// THE WINDOW-GEOMETRY REGRESSION NET, run against a REAL Electron process.
//
// WHY IT IS SEPARATE FROM `spike:window-state`. That spike passed 43/43 while
// v1.24.0 shipped a window that reopened at the wrong size, and it was not
// wrong: every function it tests was correct. The defect lived one layer below,
// in Electron itself — a constructor `width`/`height` is constrained against the
// PRIMARY display's work area BEFORE `x`/`y` move the window onto the display it
// belongs on, so a window saved larger than the primary panel came back cut down
// to it:
//
//     new BrowserWindow({ x: 1914, y: -366, width: 1909, height: 1215, … })
//       → getBounds() = { x: 1914, y: -366, width: 1512, height: 949 }
//
// A pure test cannot see that, by construction. So this driver spawns Electron
// on `dist/electron/spike-window-entry.mjs`, which runs the REAL production path
// (a saved state file → `createMainWindow(…, { persistWindowState: true })`, the
// same call `main.ts` makes), and asserts the window's actual bounds.
//
// Assertions:
//   (a) THE CLAMP IS REAL — a control window built from the constructor options
//       alone comes back smaller than asked. This one is EVIDENCE, not a
//       requirement: it is what decides whether the rest of the run proves
//       anything (see INCONCLUSIVE below).
//   (b) THE RESTORE PATH APPLIES THE SAVED RECTANGLE EXACTLY — position and
//       size, against what the pure resolver said it should be. This is the
//       assertion that would have FAILED before the fix.
//   (c) IT STICKS — the same bounds one second later, not taken back by the
//       window manager.
//   (d) A MAXIMIZED RESTORE KEEPS THE USER'S NORMAL BOUNDS, and un-maximizing
//       lands on them. This also settles the two Electron contracts the pure
//       spike's header lists as taken on trust (`getNormalBounds()` reports the
//       pre-maximize rectangle; `maximize()` has somewhere to restore down to).
//   (e) IT NEVER TOUCHED THE DEVELOPER'S OWN `~/.naby/window-state.json` —
//       checked by content, before and after, because this is the one spike that
//       opts into persistence and the user's saved geometry is live data.
//   (f) the process exits cleanly, with every probe reported.
//
// INCONCLUSIVE IS A THIRD OUTCOME, and it exists because a green run must not be
// mistaken for proof. The clamp only bites when the saved size exceeds the
// primary display's work area, which requires a second, larger display. On a
// single-display laptop assertion (b) is vacuous — it would pass with the fix
// reverted — so this driver reports INCONCLUSIVE with the display layout as the
// reason rather than printing a reassuring ALL PASS.
//
// Headless: the child disables hardware acceleration and shows no window.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = resolve(ROOT, 'dist/electron/spike-window-entry.mjs');
const ENTRY_SRC = resolve(ROOT, 'electron/spike-window-entry.ts');
const MARK = '##SPIKEWIN##';

// THE THROWAWAY HOME. `window-state.json` follows `nabyHomeDir()`, so handing
// the child its own NABY_HOME is what keeps a headless test window from
// overwriting the geometry of the app in daily use. The prefix is not cosmetic:
// the child REFUSES TO RUN unless its home is named this way, so a driver that
// forgot the env var aborts instead of writing to `~/.naby`.
const SANDBOX_PREFIX = 'naby-window-spike-';
const SANDBOX = resolve(tmpdir(), `${SANDBOX_PREFIX}${process.pid}-${Date.now()}`);

/** The file this spike must never modify. Read-only here, and only for (e). */
const REAL_STATE_FILE = join(homedir(), '.naby', 'window-state.json');

/** Generous, but far below a hang: three windows and two half-second settles. */
const RUN_TIMEOUT_MS = 90_000;

type Status = 'pass' | 'fail' | 'inconclusive';
type Check = { name: string; status: Status; evidence: string };
type Obs = { event: string; [k: string]: unknown };
type Rect = { x: number; y: number; width: number; height: number };

// ---------------------------------------------------------------------------
// Drive Electron
// ---------------------------------------------------------------------------

type ChildOutcome = {
  observations: Obs[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stderr: string;
};

async function runElectron(): Promise<ChildOutcome> {
  const electronBinary = require('electron') as string;
  mkdirSync(SANDBOX, { recursive: true });

  const child = spawn(electronBinary, [ENTRY], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // Both, because `boot()` sets each with `??=` and the child must not be
      // able to reach the real home through either door. NABY_DB_PATH is set
      // even though no store is opened: `nabyHomeDir()` reads it first.
      NABY_HOME: SANDBOX,
      NABY_DB_PATH: join(SANDBOX, 'app.db'),
      NODE_ENV: 'production',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
    },
  });

  const observations: Obs[] = [];
  let stdoutBuf = '';
  let stderr = '';
  let timedOut = false;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutBuf += chunk;
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() ?? '';
    for (const line of lines) {
      const at = line.indexOf(MARK);
      if (at === -1) continue;
      try {
        observations.push(JSON.parse(line.slice(at + MARK.length)) as Obs);
      } catch {
        /* a partial or malformed line is simply not an observation */
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolvePromise) => {
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, RUN_TIMEOUT_MS);
      // 'close', not 'exit' — the stdio pipes may still hold the last
      // observation when the process itself has already gone (see spike-04).
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolvePromise({ code, signal });
      });
    },
  );

  return { observations, exitCode: result.code, signal: result.signal, timedOut, stderr };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function findOne(obs: Obs[], event: string): Obs | undefined {
  return obs.find((o) => o.event === event);
}

function asRect(value: unknown): Rect | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const r = value as Record<string, unknown>;
  const nums = [r.x, r.y, r.width, r.height];
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined;
  return { x: r.x as number, y: r.y as number, width: r.width as number, height: r.height as number };
}

function fmt(r: Rect | undefined): string {
  return r ? `${r.width}x${r.height}+${r.x}+${r.y}` : 'n/a';
}

function sameRect(a: Rect | undefined, b: Rect | undefined): boolean {
  return (
    !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}

function sameSize(a: Rect | undefined, b: Rect | undefined): boolean {
  return !!a && !!b && a.width === b.width && a.height === b.height;
}

/** The state file's contents, or null when it does not exist. Never written. */
function fingerprint(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return `${statSync(path).size}:${createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)}`;
  } catch {
    return null;
  }
}

function evaluate(outcome: ChildOutcome, realBefore: string | null): Check[] {
  const obs = outcome.observations;
  const checks: Check[] = [];

  const fatal = findOne(obs, 'fatal');
  const displays = findOne(obs, 'displays');
  const target = findOne(obs, 'target');
  const control = findOne(obs, 'control');
  const restore = findOne(obs, 'restore');
  const settled = findOne(obs, 'settled');
  const maximized = findOne(obs, 'maximized');
  const unmaximized = findOne(obs, 'unmaximized');

  const asked = asRect(target?.asked);
  const expected = asRect(target?.expected);
  const layout = displays
    ? `primary ${fmt(asRect(displays.primary))}, all = ${JSON.stringify(displays.all)}`
    : 'no `displays` observation';

  // The child says whether the layout can stage the bug at all; the control
  // window says whether it actually did. Both must hold for (b) to mean
  // anything — a layout that could stage it but did not is itself news.
  const canStage = target?.exercisesClamp === true;
  const controlGot = asRect(control?.got);
  const clampObserved = !!controlGot && !!asked && !sameSize(controlGot, asked);
  const inconclusiveReason = !canStage
    ? String(target?.reason ?? 'the child reported no clamp-capable display layout')
    : !clampObserved
      ? `the layout could stage the clamp (${layout}) but the control window came back at the ` +
        `size asked for (${fmt(controlGot)}) — Electron's behaviour may have changed, so this ` +
        `run does not exercise the defect either`
      : '';

  // -- (a) the clamp itself -------------------------------------------------
  checks.push({
    name: '(a) the defect is reproducible here: constructor options alone come back clamped',
    status: clampObserved ? 'pass' : 'inconclusive',
    evidence: control
      ? `asked ${fmt(asked)} → constructor gave ${fmt(controlGot)}` +
        (clampObserved
          ? ' (size cut to the PRIMARY work area — the v1.24.0 symptom)'
          : ` — no clamp on this layout. ${inconclusiveReason}`)
      : 'no `control` observation',
  });

  // -- the sanity check that the test rectangle is the one under test -------
  // If the pure resolver had nudged or shrunk the chosen rectangle, (b) would be
  // asserting against the wrong number and a real clamp could hide inside the
  // difference.
  checks.push({
    name: '(b) the saved rectangle survives the pure resolver unchanged (so the target is the saved one)',
    status: sameRect(asked, expected) && target?.expectedSource === 'saved' ? 'pass' : 'fail',
    evidence: target
      ? `saved ${fmt(asked)} → resolveWindowStart ${fmt(expected)} ` +
        `[${String(target.expectedSource)}: ${String(target.expectedReason)}]`
      : 'no `target` observation',
  });

  // -- (b) THE ASSERTION THAT WOULD HAVE FAILED BEFORE THE FIX -------------
  const restoreGot = asRect(restore?.got);
  const restoreMatches = sameRect(restoreGot, expected);
  checks.push({
    name: '(b) createMainWindow opens the RESTORED window at exactly the saved geometry',
    status: restoreMatches ? (clampObserved ? 'pass' : 'inconclusive') : 'fail',
    evidence: restore
      ? `expected ${fmt(expected)} → got ${fmt(restoreGot)}` +
        (restoreMatches
          ? clampObserved
            ? ' (the constructor alone gave ' + fmt(controlGot) + ', so this is the fix working)'
            : ` — but VACUOUS on this machine: ${inconclusiveReason}`
          : ' — THE RESTORED SIZE IS NOT THE SAVED ONE')
      : 'no `restore` observation',
  });

  // -- (c) and it stays that way -------------------------------------------
  const settledGot = asRect(settled?.got);
  const settledMatches = sameRect(settledGot, expected);
  checks.push({
    name: '(c) …and the bounds still hold a second later (not taken back by the window manager)',
    status: settledMatches ? (clampObserved ? 'pass' : 'inconclusive') : 'fail',
    evidence: settled
      ? `after 1s: ${fmt(settledGot)} (normal ${fmt(asRect(settled.normal))})`
      : 'no `settled` observation',
  });

  // -- (d) the maximized restore, and Electron's two contracts -------------
  //
  // The ordering in createMainWindow — setBounds BEFORE maximize() — only pays
  // off if `getNormalBounds()` really is the pre-maximize rectangle. Reported as
  // INCONCLUSIVE rather than FAIL when the platform declines to maximize a
  // never-shown window, because that is a fact about headless windows, not about
  // the restore path.
  const didMaximize = maximized?.isMaximized === true;
  const normalWhileMax = asRect(maximized?.normal);
  const normalMatches = sameRect(normalWhileMax, expected);
  checks.push({
    name: "(d) a MAXIMIZED restore keeps the user's size as the window's normal bounds",
    status: !didMaximize ? 'inconclusive' : normalMatches ? 'pass' : 'fail',
    evidence: maximized
      ? `isMaximized=${String(maximized.isMaximized)} bounds=${fmt(asRect(maximized.got))} ` +
        `normalBounds=${fmt(normalWhileMax)} expected=${fmt(expected)}` +
        (didMaximize
          ? ''
          : ' — this platform did not maximize a never-shown window, so the contract went untested')
      : 'no `maximized` observation',
  });

  const afterUnmax = asRect(unmaximized?.got);
  const unmaxMatches = sameRect(afterUnmax, expected);
  checks.push({
    name: '(d) …and un-maximizing lands back on it (so "restore down" has somewhere to go)',
    status: !didMaximize ? 'inconclusive' : unmaxMatches ? 'pass' : 'fail',
    evidence: unmaximized
      ? `after unmaximize: ${fmt(afterUnmax)} isMaximized=${String(unmaximized.isMaximized)} ` +
        `expected=${fmt(expected)}`
      : 'no `unmaximized` observation',
  });

  // -- (e) the developer's own geometry is untouched ------------------------
  const realAfter = fingerprint(REAL_STATE_FILE);
  const untouched = realBefore === realAfter;
  const entrySrc = existsSync(ENTRY_SRC) ? readFileSync(ENTRY_SRC, 'utf8') : '';
  const childRefuses = entrySrc.includes(SANDBOX_PREFIX) && /refusing to run/.test(entrySrc);
  const statePath = typeof displays?.statePath === 'string' ? displays.statePath : '';
  checks.push({
    name: "(e) the real ~/.naby/window-state.json is byte-identical (this spike writes, so this is not optional)",
    status: untouched && statePath.startsWith(SANDBOX) && childRefuses ? 'pass' : 'fail',
    evidence:
      `real file ${realBefore === null ? 'absent' : realBefore} → ${realAfter === null ? 'absent' : realAfter}; ` +
      `child wrote to ${statePath || '<unreported>'}; ` +
      `child refuses a non-${SANDBOX_PREFIX}* home: ${String(childRefuses)}`,
  });

  // -- (f) every probe ran, and the process exited cleanly ------------------
  const missing = ['displays', 'target', 'control', 'restore', 'settled', 'maximized', 'unmaximized', 'done'].filter(
    (e) => !findOne(obs, e),
  );
  checks.push({
    name: '(f) every probe reported and Electron exited cleanly',
    status:
      missing.length === 0 && !fatal && !outcome.timedOut && outcome.exitCode === 0
        ? 'pass'
        : 'fail',
    evidence:
      (fatal ? `FATAL in main: ${String(fatal.error)} · ` : '') +
      (missing.length ? `MISSING observations: ${missing.join(', ')} · ` : '') +
      `exitCode=${String(outcome.exitCode)} signal=${String(outcome.signal)} timedOut=${String(outcome.timedOut)} · ` +
      layout,
  });

  return checks;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('SPIKE — window geometry under a REAL Electron process\n');

  if (!existsSync(ENTRY)) {
    console.error(`FAIL: ${ENTRY} is missing.`);
    console.error('      Run `npm run build:electron` first (npm run spike:window-runtime does this for you).');
    process.exit(1);
  }

  // Taken BEFORE the child runs, and compared after — assertion (e).
  const realBefore = fingerprint(REAL_STATE_FILE);

  const outcome = await runElectron();
  const checks = evaluate(outcome, realBefore);

  try {
    rmSync(SANDBOX, { recursive: true, force: true });
  } catch {
    /* a leftover temp directory is not worth failing a passing spike over */
  }

  for (const c of checks) {
    console.log(`${c.status === 'pass' ? 'PASS' : c.status === 'fail' ? 'FAIL' : 'INCONCLUSIVE'}  ${c.name}`);
    console.log(`      ${c.evidence}`);
  }

  const failed = checks.filter((c) => c.status === 'fail');
  const unproven = checks.filter((c) => c.status === 'inconclusive');
  console.log(
    `\n${checks.length - failed.length - unproven.length}/${checks.length} assertions passed` +
      (unproven.length ? `, ${unproven.length} INCONCLUSIVE` : '') +
      (failed.length ? `, ${failed.length} FAILED` : ''),
  );

  if (failed.length > 0) {
    const tail = outcome.stderr.trim().split('\n').slice(-40).join('\n');
    if (tail) console.error(`\n--- electron stderr (tail) ---\n${tail}`);
    process.exit(1);
  }

  if (unproven.length > 0) {
    // NOT A PASS, and deliberately not an exit code either: a laptop cannot
    // stage a two-display clamp, and failing the build on a hardware fact would
    // only teach people to ignore this spike. The banner is the honest answer —
    // this run did not prove the fix, and it says why.
    console.log(
      `\nINCONCLUSIVE — this run does NOT prove the v1.24.0 fix.\n` +
        `  ${unproven[0]?.evidence ?? ''}\n` +
        `  Re-run on a machine whose PRIMARY display is smaller than another connected display.`,
    );
  }
}

void main();
