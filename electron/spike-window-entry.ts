// electron/spike-window-entry.ts
//
// THE RUNTIME HALF of the window-geometry check — the code that runs INSIDE a
// real Electron main process, on real displays, against a real BrowserWindow.
//
// WHY THIS EXISTS AT ALL. `npm run spike:window-state` reported 43/43 PASS while
// the feature was broken in the field, and it was right to: every pure function
// it tests was correct. The defect was ELECTRON'S behaviour — a constructor
// `width`/`height` is constrained against the PRIMARY display's work area BEFORE
// `x`/`y` move the window to the display it belongs on, so any window larger
// than the primary panel reopened shrunk to it. That is a runtime contract, not
// arithmetic, and the only instrument that can see it is a real window. This
// spike is the assertion the pure one cannot make.
//
// WHAT IT REPORTS (the driver, src/spikes/spike-window-runtime.ts, decides
// PASS/FAIL — nothing here judges, so a probe that fails to run is a missing
// observation and therefore a FAIL rather than an assertion that quietly never
// executed):
//
//   * `displays`  — the real work areas, so the evidence names the layout.
//   * `control`   — a window built from the constructor options ALONE. This is
//                   the bug's own footprint: when its size comes back smaller
//                   than asked, the clamp is live on this machine and the checks
//                   below are meaningful. When it does not (a single-display
//                   laptop cannot stage it), the driver says INCONCLUSIVE rather
//                   than green.
//   * `restore`   — the REAL production path: a saved state file, then
//                   `createMainWindow(…, { persistWindowState: true })`, which is
//                   what `main.ts` calls. Its bounds must be the ones asked for.
//   * `settled`   — the same bounds one second later, because a size the window
//                   manager takes back a moment afterwards is not a fix.
//   * `maximized` / `unmaximized` — the two contracts the pure spike's header
//                   listed as unproven by construction: that `getNormalBounds()`
//                   really reports the pre-maximize rectangle, and that
//                   un-maximizing lands back on it.
//
// SAFETY: THIS ENTRY OPTS INTO PERSISTENCE, which no other spike entry may do —
// it writes `window-state.json`, and the developer's own saved geometry is live
// data. Two independent guards keep it off that file: the driver hands us a
// throwaway NABY_HOME (the state file follows the naby home), and the assertion
// at the top of `run()` REFUSES TO PROCEED unless the resolved path is inside a
// directory named for this spike. A missing env var must abort, not fall back.
//
// Headless: hardware acceleration is off and no window is ever shown. Geometry
// is a property of the native window, not of anything painted in it.

import { app, BrowserWindow, screen } from 'electron';
import { writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { createMainWindow, type BootResult } from './boot.js';
import {
  MIN_WINDOW_SIZE,
  resolveWindowStart,
  windowStateFilePath,
  writeWindowStateFile,
  type Bounds,
  type WindowState,
} from './windowState.js';

const MARK = '##SPIKEWIN##';

/**
 * The directory name the driver must use. See the SAFETY note above.
 *
 * Not imported by the driver — importing this module outside Electron would load
 * `electron` under plain tsx and fail — so the driver carries its own copy and
 * asserts this file still contains the same literal. That is the drift guard.
 */
const SANDBOX_PREFIX = 'naby-window-spike-';

function emit(event: string, data: Record<string, unknown>): void {
  // writeSync to fd 1, for the reason spike-entry.ts documents at length: an
  // async write's callback fires when libuv accepts the buffer, not when the OS
  // has it, so `app.exit()` can discard the final observation.
  writeSync(1, `${MARK}${JSON.stringify({ event, ...data })}\n`);
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

// Destroying the last window would otherwise quit the process out from under the
// remaining observations — the same race spike-entry.ts documents.
app.on('window-all-closed', () => {
  /* deliberately empty — see spike-entry.ts */
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ENOUGH OF A `BootResult` FOR A WINDOW, and nothing more.
 *
 * `createMainWindow` reads exactly two things off it — the session token and the
 * server origin — both of which only ever reach `webPreferences` and the
 * external-link guard. Booting the embedded Next server to obtain a real one
 * would add a minute of cold start and a dependency on a built shell to a check
 * about pixels.
 *
 * The cast is deliberate and its failure mode is acceptable: if
 * `createMainWindow` ever dereferences a field that is absent here, it throws,
 * the `fatal` observation fires, and the driver reports a FAIL. That is loud.
 */
function stubBootResult(): BootResult {
  return {
    token: 'f'.repeat(64),
    server: { origin: 'http://127.0.0.1:1' },
    windowUrl: (pathAndQuery = '/') => `http://127.0.0.1:1${pathAndQuery}`,
  } as unknown as BootResult;
}

/** `{x,y,width,height}` as the driver compares it — plain numbers, no methods. */
function rect(b: Bounds): Bounds {
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

/**
 * A saved rectangle that would exercise the clamp, if this machine can stage it.
 *
 * THE CLAMP ONLY BITES when the saved size exceeds the PRIMARY work area while
 * still fitting on the display it lives on — so it needs a non-primary display
 * bigger than the primary in at least one dimension. A laptop on its own cannot
 * produce one, which is a fact about the hardware, not a passing result: the
 * caller reports `exercisesClamp: false` and the driver refuses to call that
 * proof.
 *
 * The rectangle is inset from the work area so it is strictly inside one display
 * — that keeps `resolveWindowStart` on its "restored, unchanged" path, so what
 * the window is asked for is exactly what was saved.
 */
function pickTarget(
  primary: Bounds,
  workAreas: readonly Bounds[],
): { bounds: Bounds; exercisesClamp: boolean; reason: string } {
  const INSET = 20;
  const fits = (wa: Bounds): Bounds => ({
    x: wa.x + INSET,
    y: wa.y + INSET,
    width: Math.max(MIN_WINDOW_SIZE.width, wa.width - INSET * 2),
    height: Math.max(MIN_WINDOW_SIZE.height, wa.height - INSET * 2),
  });

  for (const wa of workAreas) {
    const candidate = fits(wa);
    if (candidate.width > primary.width || candidate.height > primary.height) {
      return {
        bounds: candidate,
        exercisesClamp: true,
        reason:
          `saved ${candidate.width}x${candidate.height} exceeds the primary work area ` +
          `${primary.width}x${primary.height}, so a clamp against the primary is observable`,
      };
    }
  }

  // Nothing on this machine is bigger than the primary panel. Still run every
  // probe — a regression that broke ORDINARY restores would show up here — but
  // say plainly that the cross-display clamp went untested.
  return {
    bounds: fits(primary),
    exercisesClamp: false,
    reason:
      `no connected display's work area exceeds the primary ${primary.width}x${primary.height} ` +
      `in either dimension, so no saved size can be larger than the display Electron clamps ` +
      `against — the v1.24.0 defect cannot be staged on this layout`,
  };
}

async function run(): Promise<void> {
  await app.whenReady();

  // -- the safety interlock, before anything is written --------------------
  const statePath = windowStateFilePath();
  const home = process.env.NABY_HOME ?? '';
  const sandboxed =
    home !== '' &&
    home !== join(homedir(), '.naby') &&
    home.split(sep).some((segment) => segment.startsWith(SANDBOX_PREFIX)) &&
    statePath.startsWith(home);
  if (!sandboxed) {
    emit('fatal', {
      error:
        `refusing to run: NABY_HOME must be a throwaway directory named ${SANDBOX_PREFIX}* ` +
        `(got ${home || '<unset>'}), or this spike would overwrite the developer's own ` +
        `window-state.json`,
    });
    app.exit(1);
    return;
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  const workAreas: Bounds[] = [
    rect(primaryDisplay.workArea),
    ...screen
      .getAllDisplays()
      .filter((d) => d.id !== primaryDisplay.id)
      .map((d) => rect(d.workArea)),
  ];
  const primary = workAreas[0]!;
  emit('displays', { primary, all: workAreas, statePath });

  const target = pickTarget(primary, workAreas);
  const saved: WindowState = { bounds: target.bounds, maximized: false, fullScreen: false };

  // What the PURE resolver makes of that rectangle, computed with the same
  // primary-first ordering boot.ts uses. This is what the window must end up
  // with — asserting against the raw target instead would confuse "Electron
  // clamped it" with "our own containment rule moved it".
  const expected = resolveWindowStart(saved, workAreas);
  emit('target', {
    asked: target.bounds,
    exercisesClamp: target.exercisesClamp,
    reason: target.reason,
    expected: { ...expected.size, ...(expected.position ?? {}) },
    expectedSource: expected.source,
    expectedReason: expected.reason,
  });

  // -- (1) the control: constructor options only ---------------------------
  //
  // No setBounds, no restore path — just the options createMainWindow passes.
  // Whatever comes back is Electron's unaided answer, and it is what makes the
  // difference between "the fix works" and "nothing needed fixing here".
  const control = new BrowserWindow({
    x: target.bounds.x,
    y: target.bounds.y,
    width: target.bounds.width,
    height: target.bounds.height,
    minWidth: MIN_WINDOW_SIZE.width,
    minHeight: MIN_WINDOW_SIZE.height,
    show: false,
  });
  emit('control', { asked: target.bounds, got: rect(control.getBounds()) });
  control.destroy();

  // -- (2) the real path: saved file → createMainWindow --------------------
  writeWindowStateFile(statePath, saved);
  const win = createMainWindow(stubBootResult(), { show: false, persistWindowState: true });
  emit('restore', {
    got: rect(win.getBounds()),
    normal: rect(win.getNormalBounds()),
    maximized: win.isMaximized(),
    fullScreen: win.isFullScreen(),
  });

  // A size the window manager takes back a moment later is not a restored size.
  // The wait doubles as a drain for the persistence debounce (400ms): the write
  // this window owes must land BEFORE step 3 rewrites the state file, or a stale
  // `maximized: false` would arrive after it and the next window would restore
  // the wrong state.
  await wait(1000);
  emit('settled', { got: rect(win.getBounds()), normal: rect(win.getNormalBounds()) });
  win.destroy();

  // -- (3) the maximized restore, and the two Electron contracts under it ---
  //
  // The pure spike's header says outright that `getNormalBounds()` reporting the
  // pre-maximize rectangle, and `maximize()` restoring down to it, are Electron's
  // documented contracts taken on trust. Both are cheap to settle here, and the
  // ordering in createMainWindow (setBounds BEFORE maximize) is only correct if
  // they hold.
  writeWindowStateFile(statePath, { ...saved, maximized: true });
  const maxWin = createMainWindow(stubBootResult(), { show: false, persistWindowState: true });
  await wait(500);
  emit('maximized', {
    isMaximized: maxWin.isMaximized(),
    got: rect(maxWin.getBounds()),
    normal: rect(maxWin.getNormalBounds()),
  });

  maxWin.unmaximize();
  await wait(500);
  emit('unmaximized', {
    isMaximized: maxWin.isMaximized(),
    got: rect(maxWin.getBounds()),
    normal: rect(maxWin.getNormalBounds()),
  });
  maxWin.destroy();

  emit('done', { statePath });
  app.exit(0);
}

run().catch((err: unknown) => {
  emit('fatal', { error: err instanceof Error ? `${err.message}\n${err.stack}` : String(err) });
  app.exit(1);
});
