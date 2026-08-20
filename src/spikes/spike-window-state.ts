// src/spikes/spike-window-state.ts
//
// WINDOW GEOMETRY PERSISTENCE verification — electron/windowState.ts.
//
// WHAT IS UNDER TEST. Naby reopened at 1280x860 every launch, discarding
// whatever the user had arranged. Remembering it is easy; remembering it SAFELY
// is not, and the failure modes are the kind a user cannot work around:
//
//   * The saved coordinates name a display that is no longer connected — the
//     laptop was undocked, the resolution changed — and the window opens in
//     empty space. It is running, it is invisible, and there is nothing in the
//     UI to fix it because the UI is off-screen too.
//   * The maximized size gets saved as the normal size, so after a restart
//     "restore down" does nothing: the window has no smaller size to go back to.
//   * A minimized window's bounds get saved, and the app reopens as a sliver.
//   * The saved size is below the shell's 960px floor, which does not merely
//     look cramped — public/boot.js redirects a <768px viewport to the MOBILE
//     route, so the whole shell changes identity.
//   * The state file is truncated by a crash and the app now fails to launch.
//
// WHY A SPIKE AND NOT A PROBE, in the spirit of spike-reload-guard: none of the
// above can be staged by opening a real window on this machine. Undocking a
// display, a 4K monitor and a corrupt file are all just INPUTS to a decision, and
// the decision was factored into pure functions for exactly that reason. What a
// real Electron launch would add is a window nobody can watch and a display
// layout nobody can change from a test.
//
// WHAT IS LEFT UNPROVEN BY CONSTRUCTION, stated rather than hidden: that
// Electron's `getNormalBounds()` really reports the pre-maximize rectangle, and
// that `maximize()` on a window constructed with those bounds really restores
// down to them. Those are Electron's documented contracts. What IS proven is
// that our code asks for the right one, wires the events it says it wires, and
// that the production entry — and only the production entry — turns persistence
// on (assertion (i), read off the real sources).
//
// It proves:
//
//   (a) ROUND TRIP. Capture → serialize → parse → resolve returns the geometry
//       the window had, byte-identically.
//   (b) A DISCONNECTED DISPLAY. Bounds entirely off every connected work area
//       are discarded for the centred default.
//   (c) PARTIAL OVERLAP. >= 50% visible is nudged fully onto the display holding
//       it; below 50% is discarded. Both directions, plus the boundary.
//   (d) THE FLOOR. A saved size under 960x640 is clamped up — and the floor wins
//       over a work area too small to honour it.
//   (e) THE DISPLAY CEILING. An oversized window is clamped down to the work
//       area it lands on.
//   (f) MAXIMIZED / FULL SCREEN. The NORMAL bounds are what gets saved, the flag
//       is separate, and the restore is a flag rather than screen-sized bounds.
//   (g) MINIMIZED WINDOWS ARE NOT SAVED, and do not destroy a pending save.
//   (h) CORRUPTION NEVER BREAKS LAUNCH. Truncated JSON, wrong types, NaN, a
//       zero-height rectangle, an empty file and a missing file all degrade to a
//       first launch. Plus a real temp-dir write/read round trip.
//   (i) DEBOUNCE. A drag's worth of events costs one write; close flushes; an
//       unchanged state is not rewritten. Driven through the real
//       `installWindowStatePersistence` wiring with a fake window and fake timers.
//   (j) IT IS ACTUALLY WIRED: main.ts opts in, the three spike entries do not,
//       and the window's own minWidth/minHeight come from the same constant the
//       clamp uses.
//
// NO ELECTRON, NO NETWORK, NO KEYS, NO DB, and no write outside a temp
// directory. Prints PASS/FAIL per assertion; exits non-zero on any FAIL.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  captureWindowState,
  centredDefaultBounds,
  createWindowStateWriter,
  DEFAULT_WINDOW_SIZE,
  installWindowStatePersistence,
  MIN_VISIBLE_FRACTION,
  MIN_WINDOW_SIZE,
  parseWindowState,
  readWindowStateFile,
  resolveWindowStart,
  serializeWindowState,
  visibleFraction,
  windowStateFilePath,
  writeWindowStateFile,
  type Bounds,
  type PersistableWindow,
  type Scheduler,
  type WindowState,
  type WindowStateEvent,
} from '../../electron/windowState.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];

function record(name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

function fmt(b: { x?: number; y?: number; width: number; height: number }): string {
  const pos = b.x === undefined || b.y === undefined ? '' : `+${b.x}+${b.y}`;
  return `${b.width}x${b.height}${pos}`;
}

function startGeometry(s: ReturnType<typeof resolveWindowStart>): string {
  return `${fmt({ ...s.size, ...(s.position ?? {}) })}${s.maximized ? ' maximized' : ''}${
    s.fullScreen ? ' fullscreen' : ''
  } [${s.source}: ${s.reason}]`;
}

// ---------------------------------------------------------------------------
// A display layout to reason against
// ---------------------------------------------------------------------------
//
// Realistic on purpose: a built-in laptop panel as primary and a larger external
// display to its right, mounted higher (a negative y, which is where sign
// mistakes in bounds arithmetic show up).

const LAPTOP: Bounds = { x: 0, y: 0, width: 1512, height: 944 };
const EXTERNAL: Bounds = { x: 1512, y: -200, width: 2560, height: 1415 };
const DOCKED = [LAPTOP, EXTERNAL];
const UNDOCKED = [LAPTOP];

const state = (bounds: Bounds, extra: Partial<WindowState> = {}): WindowState => ({
  bounds,
  maximized: false,
  fullScreen: false,
  ...extra,
});

// ---------------------------------------------------------------------------
// A fake BrowserWindow
// ---------------------------------------------------------------------------

type FakeWindow = PersistableWindow & {
  /** Present so the test can prove we never read it — see (f). */
  getBounds(): Bounds;
  emit(event: WindowStateEvent): void;
  getBoundsCalls: number;
};

function fakeWindow(opts: {
  normalBounds: Bounds;
  screenBounds?: Bounds;
  minimized?: boolean;
  maximized?: boolean;
  fullScreen?: boolean;
}): FakeWindow {
  const listeners = new Map<WindowStateEvent, Array<() => void>>();
  const win: FakeWindow = {
    getBoundsCalls: 0,
    isMinimized: () => opts.minimized === true,
    isMaximized: () => opts.maximized === true,
    isFullScreen: () => opts.fullScreen === true,
    getNormalBounds: () => ({ ...opts.normalBounds }),
    getBounds: () => {
      win.getBoundsCalls += 1;
      return { ...(opts.screenBounds ?? opts.normalBounds) };
    },
    on: (event, listener) => {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return win;
    },
    emit: (event) => {
      for (const listener of listeners.get(event) ?? []) listener();
    },
  };
  return win;
}

/** Timers the test drives by hand, so the debounce is deterministic. */
function fakeScheduler(): Scheduler & { fire(): number; count(): number } {
  let pending: Array<{ fn: () => void }> = [];
  return {
    setTimeout(fn) {
      const handle = { fn };
      pending.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      pending = pending.filter((h) => h !== handle);
    },
    fire() {
      const due = pending;
      pending = [];
      for (const h of due) h.fn();
      return due.length;
    },
    count() {
      return pending.length;
    },
  };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function main(): void {
  // -- (a) the ordinary round trip -----------------------------------------
  {
    const win = fakeWindow({ normalBounds: { x: 2000, y: 40, width: 1600, height: 1000 } });
    const captured = captureWindowState(win);
    const reparsed = captured ? parseWindowState(serializeWindowState(captured)) : undefined;
    const start = resolveWindowStart(reparsed, DOCKED);
    record(
      '(a) capture → file → parse → restore returns the exact geometry the window had',
      start.source === 'saved' &&
        start.size.width === 1600 &&
        start.size.height === 1000 &&
        start.position?.x === 2000 &&
        start.position.y === 40,
      startGeometry(start),
    );
    record(
      '(a) …and the parsed state is identical to the captured one',
      JSON.stringify(captured) === JSON.stringify(reparsed),
      `captured=${JSON.stringify(captured?.bounds)} parsed=${JSON.stringify(reparsed?.bounds)}`,
    );
  }

  // -- (b) the display that is no longer there ------------------------------
  //
  // THE CASE THIS WHOLE MODULE EXISTS FOR. The window lived on the external
  // display; the user undocked. Those coordinates are now empty space, and a
  // window opened there cannot be seen, moved, or closed from the UI.
  {
    const saved = state({ x: 2200, y: 100, width: 1600, height: 1000 });
    const docked = resolveWindowStart(saved, DOCKED);
    const undocked = resolveWindowStart(saved, UNDOCKED);
    const expected = centredDefaultBounds(LAPTOP);
    record(
      '(b) bounds on a NOW-DISCONNECTED display are discarded for the centred default',
      undocked.source === 'default' &&
        undocked.position?.x === expected.x &&
        undocked.position.y === expected.y &&
        undocked.size.width === DEFAULT_WINDOW_SIZE.width &&
        undocked.size.height === DEFAULT_WINDOW_SIZE.height,
      startGeometry(undocked),
    );
    record(
      '(b) …while the same state IS restored when that display is still attached',
      docked.source === 'saved' && docked.position?.x === 2200,
      startGeometry(docked),
    );
    record(
      '(b) the centred default really is centred on the primary work area',
      expected.x * 2 + expected.width === LAPTOP.width &&
        expected.y * 2 + expected.height === LAPTOP.height,
      `${fmt(expected)} on ${fmt(LAPTOP)}`,
    );
    record(
      '(b) no displays at all → default size and NO position (the OS places it)',
      (() => {
        const s = resolveWindowStart(saved, []);
        return (
          s.position === null &&
          s.size.width === DEFAULT_WINDOW_SIZE.width &&
          s.source === 'default'
        );
      })(),
      startGeometry(resolveWindowStart(saved, [])),
    );
  }

  // -- (c) partial overlap, both sides of the rule ---------------------------
  //
  // THE RULE: keep the geometry only when at least MIN_VISIBLE_FRACTION of it
  // lands on ONE connected work area, then slide it fully inside that display.
  // Below the threshold the window is more off-screen than on, the user may have
  // no title bar to grab, and a predictable default beats a hunt.
  {
    // 612 of 1200 columns are on the laptop panel → 51%.
    const mostlyOn = state({ x: 900, y: 100, width: 1200, height: 800 });
    const start = resolveWindowStart(mostlyOn, UNDOCKED);
    const fraction = visibleFraction(mostlyOn.bounds, UNDOCKED);
    record(
      `(c) ${(fraction * 100).toFixed(0)}% visible (>= ${(MIN_VISIBLE_FRACTION * 100).toFixed(0)}%) → kept at its size and nudged fully on-screen`,
      start.source === 'saved' &&
        start.size.width === 1200 &&
        start.size.height === 800 &&
        start.position?.x === LAPTOP.width - 1200 &&
        start.position.y === 100,
      startGeometry(start),
    );
    record(
      '(c) …and the nudged window is then 100% visible',
      start.position !== null &&
        visibleFraction({ ...start.size, ...start.position }, UNDOCKED) === 1,
      `fraction after fit = ${start.position ? visibleFraction({ ...start.size, ...start.position }, UNDOCKED) : 'n/a'}`,
    );

    // Only a 112-column sliver of 1200 is on-screen → 9%.
    const mostlyOff = state({ x: 1400, y: 100, width: 1200, height: 800 });
    const off = resolveWindowStart(mostlyOff, UNDOCKED);
    record(
      `(c) ${(visibleFraction(mostlyOff.bounds, UNDOCKED) * 100).toFixed(0)}% visible (< 50%) → discarded, not merely nudged`,
      off.source === 'default',
      startGeometry(off),
    );

    // Exactly on the boundary: 600 of 1200 columns, full height → 50.0%.
    const onBoundary = state({ x: 912, y: 0, width: 1200, height: 800 });
    const boundary = resolveWindowStart(onBoundary, UNDOCKED);
    record(
      '(c) exactly 50% visible is KEPT (the threshold is inclusive)',
      visibleFraction(onBoundary.bounds, UNDOCKED) === MIN_VISIBLE_FRACTION &&
        boundary.source === 'saved',
      `fraction=${visibleFraction(onBoundary.bounds, UNDOCKED)} → ${startGeometry(boundary)}`,
    );

    // Straddling two displays scores only its larger half by design; it must
    // still be well over the threshold and land whole on that display.
    const straddling = state({ x: 1200, y: 100, width: 1200, height: 800 });
    const straddle = resolveWindowStart(straddling, DOCKED);
    record(
      '(c) a window straddling two displays is restored onto the one holding more of it',
      straddle.source === 'saved' && straddle.position?.x === 1512,
      startGeometry(straddle),
    );
  }

  // -- (d) the floor --------------------------------------------------------
  {
    const tiny = resolveWindowStart(state({ x: 100, y: 100, width: 400, height: 300 }), UNDOCKED);
    record(
      '(d) a saved size below the 960x640 floor is clamped UP (below it the shell redirects to /m)',
      tiny.size.width === MIN_WINDOW_SIZE.width && tiny.size.height === MIN_WINDOW_SIZE.height,
      startGeometry(tiny),
    );

    // A netbook-class work area shorter than the floor. The floor still wins:
    // overhanging the screen edge is recoverable, a mobile-route shell is not.
    const cramped: Bounds[] = [{ x: 0, y: 0, width: 900, height: 600 }];
    const onCramped = resolveWindowStart(state({ x: 0, y: 0, width: 880, height: 580 }), cramped);
    record(
      '(d) the floor wins over a work area too small to honour it',
      onCramped.size.width === MIN_WINDOW_SIZE.width &&
        onCramped.size.height === MIN_WINDOW_SIZE.height &&
        onCramped.position?.x === 0 &&
        onCramped.position.y === 0,
      `${startGeometry(onCramped)} on a ${fmt(cramped[0]!)} work area`,
    );
    record(
      '(d) …and the default path is clamped to the floor on that display too',
      centredDefaultBounds(cramped[0]!).width === MIN_WINDOW_SIZE.width,
      fmt(centredDefaultBounds(cramped[0]!)),
    );
    record(
      '(d) centring never puts the title bar off the top-left edge (overhang goes right/bottom)',
      centredDefaultBounds(cramped[0]!).x === cramped[0]!.x &&
        centredDefaultBounds(cramped[0]!).y === cramped[0]!.y,
      fmt(centredDefaultBounds(cramped[0]!)),
    );
  }

  // -- (e) the display ceiling ----------------------------------------------
  {
    const huge = resolveWindowStart(state({ x: 0, y: 0, width: 1800, height: 1000 }), UNDOCKED);
    record(
      '(e) a window larger than the display it lands on is clamped down to the work area',
      huge.source === 'saved' &&
        huge.size.width === LAPTOP.width &&
        huge.size.height === LAPTOP.height &&
        huge.position?.x === 0,
      startGeometry(huge),
    );
  }

  // -- (f) maximized and full screen are separate facts ---------------------
  {
    const normal: Bounds = { x: 120, y: 80, width: 1100, height: 700 };
    const win = fakeWindow({
      normalBounds: normal,
      screenBounds: { ...LAPTOP },
      maximized: true,
    });
    const captured = captureWindowState(win);
    record(
      '(f) a MAXIMIZED window saves its pre-maximize bounds, not the screen-filling ones',
      captured?.bounds.width === 1100 &&
        captured.bounds.height === 700 &&
        captured.maximized === true,
      `saved ${captured ? fmt(captured.bounds) : 'nothing'} maximized=${String(captured?.maximized)}`,
    );
    record(
      '(f) …and getBounds() is never consulted (it is what returns the screen)',
      win.getBoundsCalls === 0,
      `getBounds calls = ${win.getBoundsCalls}`,
    );

    const start = resolveWindowStart(captured, UNDOCKED);
    record(
      '(f) the restore re-maximizes a normally-sized window, so "restore down" has somewhere to go',
      start.maximized === true &&
        start.size.width === 1100 &&
        start.size.height === 700 &&
        start.size.width !== LAPTOP.width,
      startGeometry(start),
    );

    const fs = fakeWindow({ normalBounds: normal, screenBounds: LAPTOP, fullScreen: true });
    const fsState = captureWindowState(fs);
    const fsStart = resolveWindowStart(fsState, UNDOCKED);
    record(
      '(f) full screen is stored and restored the same way, and keeps the normal size underneath',
      fsState?.fullScreen === true &&
        fsStart.fullScreen === true &&
        fsStart.maximized === false &&
        fsStart.size.width === 1100,
      startGeometry(fsStart),
    );
  }

  // -- (g) minimized ---------------------------------------------------------
  {
    const win = fakeWindow({
      normalBounds: { x: -32000, y: -32000, width: 160, height: 28 },
      minimized: true,
    });
    record(
      '(g) a MINIMIZED window reports nothing to save (its bounds are meaningless)',
      captureWindowState(win) === undefined,
      'captureWindowState → undefined',
    );

    // Being minimized must not throw away a save that is already owed, because
    // that pending save holds the last good geometry.
    const scheduler = fakeScheduler();
    const written: WindowState[] = [];
    const writer = createWindowStateWriter({
      write: (s) => written.push(s),
      delayMs: 400,
      scheduler,
    });
    const good = state({ x: 10, y: 20, width: 1300, height: 900 });
    writer.schedule(good);
    writer.schedule(undefined); // minimized
    scheduler.fire();
    record(
      '(g) …and minimizing does not discard a save that was already pending',
      written.length === 1 && written[0]?.bounds.width === 1300,
      `writes=${written.length} ${written[0] ? fmt(written[0].bounds) : ''}`,
    );

    // A degenerate rectangle (reported mid-transition on some platforms) is
    // rejected by the same path.
    const degenerate = fakeWindow({ normalBounds: { x: 0, y: 0, width: 0, height: 0 } });
    record(
      '(g) a zero-sized rectangle is not saved either',
      captureWindowState(degenerate) === undefined,
      'captureWindowState → undefined',
    );
  }

  // -- (h) a damaged file must never break launch ---------------------------
  {
    const garbage: Array<[string, string]> = [
      ['truncated JSON (a crash mid-write)', '{"bounds":{"x":10,"y":20,"wid'],
      ['an empty file', ''],
      ['whitespace only', '   \n'],
      ['a JSON null', 'null'],
      ['a JSON array', '[1,2,3]'],
      ['a bare string', '"1280x860"'],
      ['no bounds key', '{"maximized":true}'],
      ['string coordinates', '{"bounds":{"x":"10","y":"20","width":"1280","height":"860"}}'],
      ['NaN smuggled in as a string', '{"bounds":{"x":"NaN","y":0,"width":1280,"height":860}}'],
      ['a null width', '{"bounds":{"x":0,"y":0,"width":null,"height":860}}'],
      ['a zero-height rectangle', '{"bounds":{"x":0,"y":0,"width":1280,"height":0}}'],
      ['a negative size', '{"bounds":{"x":0,"y":0,"width":-1280,"height":-860}}'],
    ];
    let allRejected = true;
    const offenders: string[] = [];
    for (const [label, raw] of garbage) {
      if (parseWindowState(raw) !== undefined) {
        allRejected = false;
        offenders.push(label);
      }
    }
    record(
      `(h) all ${garbage.length} kinds of damaged state parse to "no saved state", never to an error`,
      allRejected,
      allRejected ? garbage.map(([l]) => l).join('; ') : `ACCEPTED: ${offenders.join('; ')}`,
    );
    record(
      '(h) …and a damaged file therefore launches exactly like a first run',
      resolveWindowStart(parseWindowState('{"bounds":{"x":10'), DOCKED).source === 'default',
      startGeometry(resolveWindowStart(parseWindowState('{"bounds":{"x":10'), DOCKED)),
    );
    record(
      '(h) a file written by an older build with no flags keeps its rectangle',
      (() => {
        const parsed = parseWindowState('{"bounds":{"x":10,"y":20,"width":1280,"height":860}}');
        return parsed?.maximized === false && parsed.fullScreen === false && parsed.bounds.x === 10;
      })(),
      'missing maximized/fullScreen default to false',
    );

    // The real filesystem path, in a temp directory — never the developer's own
    // ~/.naby (the project rules forbid a spike touching it).
    const home = mkdtempSync(join(tmpdir(), 'naby-window-state-'));
    try {
      const path = windowStateFilePath(home);
      const original = state({ x: 300, y: 150, width: 1440, height: 900 }, { maximized: true });
      writeWindowStateFile(path, original);
      const readBack = readWindowStateFile(path);
      record(
        '(h) write → read round trip through a real file',
        JSON.stringify(readBack) === JSON.stringify(original),
        `${path} → ${JSON.stringify(readBack?.bounds)} maximized=${String(readBack?.maximized)}`,
      );
      record(
        '(h) the file is named window-state.json under the naby home',
        path === join(home, 'window-state.json') && readFileSync(path, 'utf8').startsWith('{'),
        path,
      );
      record(
        '(h) a MISSING file reads as "no saved state", not as a throw',
        readWindowStateFile(join(home, 'does-not-exist.json')) === undefined,
        'readWindowStateFile → undefined',
      );
      writeFileSync(path, '{"bounds":{"x":10,"y":2', 'utf8');
      record(
        '(h) a file truncated on disk reads as "no saved state"',
        readWindowStateFile(path) === undefined,
        'readWindowStateFile → undefined',
      );
      // An impossible path (a directory that cannot exist because its parent is
      // a file): an OS-level failure, swallowed rather than thrown at a user who
      // is only trying to resize a window.
      const impossible = join(path, 'nested', 'window-state.json');
      record(
        '(h) an unwritable path does not throw out of the save path',
        (() => {
          try {
            writeWindowStateFile(impossible, original);
            return true;
          } catch {
            return false;
          }
        })(),
        `writeWindowStateFile('${impossible}') → no exception`,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  // -- (i) the debounce, through the real event wiring -----------------------
  {
    const scheduler = fakeScheduler();
    const written: WindowState[] = [];
    let x = 100;
    const bounds: Bounds = { x, y: 100, width: 1300, height: 900 };
    const win = fakeWindow({ normalBounds: bounds });
    installWindowStatePersistence(win, {
      write: (s) => written.push(s),
      delayMs: 400,
      scheduler,
    });

    // A drag: 120 frames of `move`, each with different bounds.
    for (let i = 0; i < 120; i += 1) {
      x += 1;
      bounds.x = x;
      win.emit('move');
    }
    record(
      '(i) 120 move events while dragging cost ZERO writes until the drag stops',
      written.length === 0 && scheduler.count() === 1,
      `writes=${written.length} pendingTimers=${scheduler.count()}`,
    );
    scheduler.fire();
    record(
      '(i) …then exactly one write, carrying the LAST position',
      written.length === 1 && written[0]?.bounds.x === 220,
      `writes=${written.length} x=${String(written[0]?.bounds.x)} (expected 220)`,
    );

    // Nothing changed → nothing written.
    win.emit('resize');
    scheduler.fire();
    record(
      '(i) an unchanged state is not rewritten',
      written.length === 1,
      `writes=${written.length}`,
    );

    // A resize immediately before quitting: the debounce has not fired yet, and
    // `close` must not let it be lost.
    bounds.width = 1010;
    win.emit('resize');
    record(
      '(i) the pre-quit resize is still only pending…',
      written.length === 1 && scheduler.count() === 1,
      `writes=${written.length} pendingTimers=${scheduler.count()}`,
    );
    win.emit('close');
    record(
      '(i) …and `close` flushes it synchronously (nothing is lost by quitting)',
      written.length === 2 && written[1]?.bounds.width === 1010 && scheduler.count() === 0,
      `writes=${written.length} lastWidth=${String(written[1]?.bounds.width)} pendingTimers=${scheduler.count()}`,
    );
  }
  {
    // A maximize fires both `resize` and `maximize`; it must still be one write,
    // and it must be written immediately rather than waiting on the debounce.
    const scheduler = fakeScheduler();
    const written: WindowState[] = [];
    const win = fakeWindow({
      normalBounds: { x: 120, y: 80, width: 1100, height: 700 },
      screenBounds: LAPTOP,
      maximized: true,
    });
    installWindowStatePersistence(win, { write: (s) => written.push(s), scheduler });
    win.emit('resize');
    win.emit('maximize');
    scheduler.fire();
    record(
      '(i) maximizing writes once, immediately, with maximized=true and the normal bounds',
      written.length === 1 &&
        written[0]?.maximized === true &&
        written[0]?.bounds.width === 1100,
      `writes=${written.length} ${written[0] ? fmt(written[0].bounds) : ''} maximized=${String(written[0]?.maximized)}`,
    );
  }

  // -- (j) it is actually wired ---------------------------------------------
  //
  // A perfect set of pure functions that nothing calls is the failure mode a
  // pure-function test cannot see — and the spike-clobber guard is only real if
  // the spike entries genuinely do not opt in.
  {
    const bootSrc = readFileSync(join(REPO, 'electron', 'boot.ts'), 'utf8');
    const mainSrc = readFileSync(join(REPO, 'electron', 'main.ts'), 'utf8');

    record(
      '(j) createMainWindow restores the saved geometry and installs the persistence',
      /resolveWindowStart\(/.test(bootSrc) &&
        /readWindowStateFile\(windowStateFilePath\(\)\)/.test(bootSrc) &&
        /installWindowStatePersistence\(win\)/.test(bootSrc) &&
        /if \(start\.maximized\) win\.maximize\(\);/.test(bootSrc),
      'boot.ts: resolveWindowStart + readWindowStateFile + win.maximize() + installWindowStatePersistence(win)',
    );
    record(
      '(j) the window floor comes from the same constant the clamp uses (no second copy to drift)',
      /minWidth: MIN_WINDOW_SIZE\.width/.test(bootSrc) &&
        /minHeight: MIN_WINDOW_SIZE\.height/.test(bootSrc) &&
        !/minWidth:\s*\d/.test(bootSrc),
      'boot.ts: minWidth/minHeight = MIN_WINDOW_SIZE.*',
    );
    record(
      '(j) persistence is OPT-IN (a caller that says nothing saves nothing)',
      /opts\.persistWindowState \?\? false/.test(bootSrc),
      'boot.ts: const persist = opts.persistWindowState ?? false',
    );
    record(
      '(j) the production entry opts in',
      /createMainWindow\(bootResult, \{ persistWindowState: true \}\)/.test(mainSrc),
      'main.ts: createMainWindow(bootResult, { persistWindowState: true })',
    );

    // THE CLOBBER GUARD. These three run against the developer's real ~/.naby
    // (only spike-04 overrides NABY_HOME), so any of them opting in would let a
    // headless test window overwrite the geometry of the app in daily use.
    const entries = ['spike-entry.ts', 'spike-f104-entry.ts', 'spike-f110-entry.ts'];
    const optedIn = entries.filter((f) =>
      /persistWindowState/.test(readFileSync(join(REPO, 'electron', f), 'utf8')),
    );
    record(
      '(j) NO spike entry opts in — a spike cannot overwrite the real window geometry',
      optedIn.length === 0,
      optedIn.length === 0 ? entries.join(', ') : `OPTED IN: ${optedIn.join(', ')}`,
    );

    // Second line of defence: the file follows the naby home, so a spike that
    // sets NABY_HOME is isolated even if it did opt in.
    const previous = process.env.NABY_HOME;
    try {
      process.env.NABY_HOME = join(tmpdir(), 'naby-elsewhere');
      const redirected = windowStateFilePath();
      process.env.NABY_HOME = previous;
      record(
        '(j) the state file follows NABY_HOME (second line of defence for spikes)',
        redirected === join(tmpdir(), 'naby-elsewhere', 'window-state.json'),
        redirected,
      );
    } finally {
      if (previous === undefined) delete process.env.NABY_HOME;
      else process.env.NABY_HOME = previous;
    }
  }

  const failed = checks.filter((c) => !c.pass);
  for (const c of checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`);
    console.log(`      ${c.evidence}`);
  }
  console.log(
    failed.length === 0
      ? `\nALL PASS — ${checks.length}/${checks.length} assertions`
      : `\nFAILED — ${failed.length} of ${checks.length} assertions:\n${failed
          .map((c) => `  - ${c.name}`)
          .join('\n')}`,
  );
  if (failed.length > 0) process.exit(1);
}

main();
