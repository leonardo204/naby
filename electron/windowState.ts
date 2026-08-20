// electron/windowState.ts
//
// REMEMBERING THE WINDOW — where it was, how big it was, and whether it was
// maximized or full screen.
//
// NO `electron` IMPORT, AT RUNTIME OR OTHERWISE. Every judgement this feature
// makes — is the saved rectangle still on a display the user has? how small may
// a window legally be? is this stored file trustworthy? should this resize be
// written to disk yet? — is a pure function of plain objects here, and the
// Electron surface (`screen`, `BrowserWindow`, its event emitter) is passed in
// structurally by boot.ts. That is what lets `npm run spike:window-state`
// exercise all of it under plain tsx: the cases worth testing are undocking a
// display and a truncated JSON file, and neither can be staged by opening a real
// window on the developer's machine.
//
// THE STATE FILE lives at `<naby home>/window-state.json`, and the home comes
// from `nabyHomeDir()` — the one resolver (NABY_DB_PATH > NABY_HOME >
// COCKPIT_HOME > ~/.naby). It is deliberately NOT in the database: this is read
// once, before the store is opened, on the path that decides whether a window
// appears at all, and it must survive a database that fails to open.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nabyHomeDir } from '../src/runtime/naby-home.js';

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** A rectangle in Electron's screen coordinate space (DIP, y-down). */
export type Bounds = { x: number; y: number; width: number; height: number };

export type Size = { width: number; height: number };

/** What is written to disk, and what a launch reads back. */
export type WindowState = {
  /**
   * The NORMAL bounds — the size the window returns to when it is un-maximized
   * or leaves full screen, never the screen-filling ones. See
   * `captureWindowState`.
   */
  bounds: Bounds;
  maximized: boolean;
  fullScreen: boolean;
};

/**
 * THE FLOOR, not a preference — and the reason it lives here rather than as a
 * literal in the `BrowserWindow` options is that a restored size has to obey the
 * same limit the window itself enforces. Two copies of this number drift, and
 * the drift is invisible: the clamp would hand back a width the window silently
 * refuses, or worse, one it accepts and should not.
 *
 * Dragged narrow enough the desktop UI does not merely look cramped, it changes
 * identity: `public/boot.js` redirects any top-level viewport matching
 * `(max-width: 767px)` to the mobile route `/m`, so a window shrunk past that
 * point swaps the whole shell out from under the user — and the only way back is
 * the /m "use desktop" escape hatch. 960 keeps the top-level viewport ~200px
 * clear of that breakpoint even after the window frame is subtracted, and clears
 * the Settings modal's own floor as well (880px panel + the 2rem mx-4 gutters =
 * 912).
 *
 * 640 tall is the height at which the three-panel layout and the sidebar still
 * show a usable amount of each panel; below it the chat composer and the panel
 * headers eat the whole window.
 */
export const MIN_WINDOW_SIZE: Size = { width: 960, height: 640 };

/** First-launch size, and the size any discarded geometry falls back to. */
export const DEFAULT_WINDOW_SIZE: Size = { width: 1280, height: 860 };

/**
 * How much of the saved rectangle must land on ONE currently connected work
 * area for the geometry to be considered still valid.
 *
 * Half is the point at which the window is more off-screen than on. Below it the
 * user may have no title bar to grab and no reliable way to tell the window is
 * even open, so a "restore" that plants it there is worse than a predictable
 * default — the failure has no in-app remedy, which is exactly what makes this
 * case worth being strict about.
 */
export const MIN_VISIBLE_FRACTION = 0.5;

/**
 * Trailing-edge debounce for `resize` / `move`, which fire per frame of a drag.
 * Long enough that a drag writes once when it stops, short enough that a resize
 * followed immediately by Cmd+Q is already on disk before `close` flushes.
 */
export const SAVE_DEBOUNCE_MS = 400;

export const WINDOW_STATE_FILE_NAME = 'window-state.json';

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function clamp(value: number, min: number, max: number): number {
  // `max` first so a max below min (a work area narrower than the floor) still
  // yields min rather than an inverted range.
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * A rectangle we are willing to reason about, or undefined.
 *
 * Rejects NaN/Infinity (JSON.parse happily produces neither, but `null` and
 * strings coerce into them downstream) and any non-positive extent, which is
 * what a window reports mid-transition on some platforms.
 */
function normaliseBounds(value: unknown): Bounds | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const b = value as Record<string, unknown>;
  if (!isFiniteNumber(b.x) || !isFiniteNumber(b.y)) return undefined;
  if (!isFiniteNumber(b.width) || !isFiniteNumber(b.height)) return undefined;
  if (b.width < 1 || b.height < 1) return undefined;
  // Electron takes integers; fractional bounds round-trip badly on HiDPI and
  // accumulate drift across restarts.
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.round(b.width),
    height: Math.round(b.height),
  };
}

/** Overlap of two rectangles, in square DIP. Zero when they do not touch. */
export function intersectionArea(a: Bounds, b: Bounds): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * The work area that holds the most of `bounds`, or undefined when none holds
 * any of it.
 *
 * Largest SINGLE intersection, not the union across displays: a window straddling
 * two screens scores only its bigger half, which understates how visible it is.
 * That is the safe direction — the worst outcome is a window that gets tidied
 * onto one display, against a window nobody can find.
 */
export function findHomeWorkArea(
  bounds: Bounds,
  workAreas: readonly Bounds[],
): { workArea: Bounds; area: number } | undefined {
  let best: { workArea: Bounds; area: number } | undefined;
  for (const workArea of workAreas) {
    const area = intersectionArea(bounds, workArea);
    if (area > 0 && (!best || area > best.area)) best = { workArea, area };
  }
  return best;
}

/** The fraction of `bounds` that is visible on the display that holds most of it. */
export function visibleFraction(bounds: Bounds, workAreas: readonly Bounds[]): number {
  const area = bounds.width * bounds.height;
  if (area <= 0) return 0;
  return (findHomeWorkArea(bounds, workAreas)?.area ?? 0) / area;
}

/**
 * Shrink to what the display can show, never below the floor, then slide the
 * whole rectangle inside the work area.
 *
 * WHEN THE TWO LIMITS CONFLICT — a work area narrower or shorter than the floor,
 * which a 1366x768 laptop already is vertically — THE FLOOR WINS. A window that
 * overhangs the screen edge is a cosmetic problem the user can drag away from; a
 * window below 960px wide is a different application (see MIN_WINDOW_SIZE).
 */
export function fitIntoWorkArea(bounds: Bounds, workArea: Bounds): Bounds {
  const width = Math.max(MIN_WINDOW_SIZE.width, Math.min(bounds.width, workArea.width));
  const height = Math.max(MIN_WINDOW_SIZE.height, Math.min(bounds.height, workArea.height));
  return {
    width,
    height,
    x: Math.round(clamp(bounds.x, workArea.x, workArea.x + workArea.width - width)),
    y: Math.round(clamp(bounds.y, workArea.y, workArea.y + workArea.height - height)),
  };
}

/** The default size, centred on a work area. */
export function centredDefaultBounds(workArea: Bounds): Bounds {
  const width = Math.max(MIN_WINDOW_SIZE.width, Math.min(DEFAULT_WINDOW_SIZE.width, workArea.width));
  const height = Math.max(
    MIN_WINDOW_SIZE.height,
    Math.min(DEFAULT_WINDOW_SIZE.height, workArea.height),
  );
  return {
    width,
    height,
    // Never above/left of the work area origin. On a display too small for the
    // floor, true centring yields a negative offset that puts the title bar off
    // the top-left edge — the one part of the window the user needs in order to
    // move it. Overhang goes to the right and bottom instead.
    x: Math.round(Math.max(workArea.x, workArea.x + (workArea.width - width) / 2)),
    y: Math.round(Math.max(workArea.y, workArea.y + (workArea.height - height) / 2)),
  };
}

// ---------------------------------------------------------------------------
// The launch decision
// ---------------------------------------------------------------------------

export type WindowStart = {
  size: Size;
  /**
   * null ONLY when no display information was available at all, in which case
   * the caller omits x/y and lets the OS place the window. Every other path
   * names a position, so placement is deterministic and testable.
   */
  position: { x: number; y: number } | null;
  maximized: boolean;
  fullScreen: boolean;
  source: 'saved' | 'default';
  /** Human-readable, for the boot log and for spike evidence. */
  reason: string;
};

/**
 * Turn a (possibly absent, possibly stale) saved state into the geometry a new
 * window should open with.
 *
 * `workAreas` is the CURRENTLY connected set — `screen.getAllDisplays()` mapped
 * to `.workArea`, PRIMARY FIRST, which is the convention the fallback relies on
 * (the caller orders it; this function does not know what a "primary" display
 * is). Saved coordinates name a point in a layout that may no longer exist: the
 * user undocked, changed resolution, or unplugged the screen the window lived
 * on, and those coordinates now describe empty space. A window opened there is
 * invisible and the app looks dead with nothing in the UI to fix it — so the
 * saved rectangle is checked against reality here, every launch, and thrown away
 * when reality disagrees.
 */
export function resolveWindowStart(
  saved: WindowState | undefined,
  workAreas: readonly Bounds[],
): WindowStart {
  const primary = workAreas[0];

  if (!primary) {
    return {
      size: { ...DEFAULT_WINDOW_SIZE },
      position: null,
      maximized: false,
      fullScreen: false,
      source: 'default',
      reason: 'no displays reported; letting the OS place the window',
    };
  }

  const fallback = (reason: string): WindowStart => {
    const bounds = centredDefaultBounds(primary);
    return {
      size: { width: bounds.width, height: bounds.height },
      position: { x: bounds.x, y: bounds.y },
      maximized: false,
      fullScreen: false,
      source: 'default',
      reason,
    };
  };

  if (!saved) return fallback('no saved window state');

  const home = findHomeWorkArea(saved.bounds, workAreas);
  const savedArea = saved.bounds.width * saved.bounds.height;
  const fraction = home && savedArea > 0 ? home.area / savedArea : 0;

  if (!home || fraction < MIN_VISIBLE_FRACTION) {
    // Falling back to the DEFAULT SIZE too, not merely to a default position: it
    // is the one geometry known to be good on an unknown display arrangement,
    // and it makes this branch identical to a first launch — one shape to
    // reason about instead of two.
    return fallback(
      home
        ? `saved bounds only ${(fraction * 100).toFixed(0)}% visible (< ${(MIN_VISIBLE_FRACTION * 100).toFixed(0)}%)`
        : 'saved bounds are on no currently connected display',
    );
  }

  const bounds = fitIntoWorkArea(saved.bounds, home.workArea);
  return {
    size: { width: bounds.width, height: bounds.height },
    position: { x: bounds.x, y: bounds.y },
    // Restored by CALLING maximize()/entering full screen on a window sized to
    // the normal bounds — never by opening at screen size. A window opened at
    // screen-sized bounds has no smaller size to go back to, so un-maximizing it
    // after a restart does nothing.
    maximized: saved.maximized,
    fullScreen: saved.fullScreen,
    source: 'saved',
    reason:
      fraction >= 0.999
        ? 'restored'
        : `restored, nudged onto the display holding ${(fraction * 100).toFixed(0)}% of it`,
  };
}

// ---------------------------------------------------------------------------
// Reading and writing the file
// ---------------------------------------------------------------------------

/**
 * Parse the state file's contents. Returns undefined for ANYTHING that is not a
 * complete, sane state — truncated JSON, a null, an object with a string width,
 * a rectangle of zero height.
 *
 * A window that will not open is far worse than a window at the wrong size, so
 * there is no error path out of here: every kind of damage degrades to "no saved
 * state", which is a first launch.
 */
export function parseWindowState(raw: string | null | undefined): WindowState | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  const bounds = normaliseBounds(obj.bounds);
  if (!bounds) return undefined;
  return {
    bounds,
    // Absent flags are a legitimate older file, not damage — default them rather
    // than discarding a perfectly good rectangle.
    maximized: obj.maximized === true,
    fullScreen: obj.fullScreen === true,
  };
}

export function serializeWindowState(state: WindowState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/** `<naby home>/window-state.json`, honouring NABY_DB_PATH / NABY_HOME. */
export function windowStateFilePath(homeDir: string = nabyHomeDir()): string {
  return join(homeDir, WINDOW_STATE_FILE_NAME);
}

/** The stored state, or undefined if it is missing, unreadable or damaged. */
export function readWindowStateFile(path: string): WindowState | undefined {
  try {
    return parseWindowState(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Write via a temp file + rename, so a crash or a full disk mid-write leaves the
 * PREVIOUS state intact instead of a half-written file. Failure is swallowed:
 * losing the window size is not a reason to interrupt anything the user is doing.
 */
export function writeWindowStateFile(path: string, state: WindowState): void {
  const tmp = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, serializeWindowState(state), 'utf8');
    renameSync(tmp, path);
  } catch {
    /* ignore — see above */
  }
}

// ---------------------------------------------------------------------------
// Capturing the live window
// ---------------------------------------------------------------------------

/** The part of `BrowserWindow` this module reads. Structural, so a test can fake it. */
export type WindowLike = {
  isMinimized(): boolean;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  /** The bounds the window returns to — NOT the maximized/full-screen ones. */
  getNormalBounds(): Bounds;
};

/**
 * The state worth saving, or undefined when there is none.
 *
 * TWO THINGS THIS GETS DELIBERATELY RIGHT:
 *
 *  * `getNormalBounds()`, never `getBounds()`. While maximized, `getBounds()`
 *    returns the screen. Saving that makes the next launch open a window whose
 *    "restore down" size IS the screen, so un-maximizing appears to do nothing
 *    and the user has no way back to a small window. Maximized-ness is a
 *    separate boolean precisely so the size underneath it survives.
 *  * MINIMIZED WINDOWS ARE NOT SAVED. Their bounds are meaningless (Windows
 *    reports the thumbnail; other platforms report stale or off-screen values),
 *    and persisting them means reopening as a sliver or off-screen. Returning
 *    undefined here is what the writer treats as "nothing happened".
 */
export function captureWindowState(win: WindowLike): WindowState | undefined {
  if (win.isMinimized()) return undefined;
  let bounds: Bounds | undefined;
  try {
    bounds = normaliseBounds(win.getNormalBounds());
  } catch {
    return undefined;
  }
  if (!bounds) return undefined;
  return { bounds, maximized: win.isMaximized(), fullScreen: win.isFullScreen() };
}

export function windowStateEquals(a: WindowState | undefined, b: WindowState | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.maximized === b.maximized &&
    a.fullScreen === b.fullScreen &&
    a.bounds.x === b.bounds.x &&
    a.bounds.y === b.bounds.y &&
    a.bounds.width === b.bounds.width &&
    a.bounds.height === b.bounds.height
  );
}

// ---------------------------------------------------------------------------
// The debounced writer
// ---------------------------------------------------------------------------

type TimerHandle = unknown;

/** Injectable timers, so the debounce can be driven deterministically in a test. */
export type Scheduler = {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
};

const realScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type WindowStateWriter = {
  /** A continuous event (resize/move). Coalesced; `undefined` is ignored. */
  schedule(state: WindowState | undefined): void;
  /** A discrete event (maximize, close). Writes now if anything is pending or new. */
  flush(state: WindowState | undefined): void;
  /** True while a debounced write is still owed. */
  isPending(): boolean;
  /** Drop any pending write without performing it. */
  cancel(): void;
};

/**
 * Coalesce a storm of geometry events into one write.
 *
 * `resize` and `move` fire per frame of a drag — hundreds of events for one
 * gesture — and each one is a whole file write plus an fsync-ish rename. The
 * trailing-edge debounce restarts on every event, so a drag costs exactly one
 * write when the user lets go, and `flush()` on close covers the case the
 * debounce cannot: a resize immediately followed by quitting.
 *
 * Identical states are dropped rather than rewritten, which is what keeps a
 * maximize (which fires `resize` AND `maximize`) from writing twice.
 */
export function createWindowStateWriter(opts: {
  write: (state: WindowState) => void;
  delayMs?: number;
  scheduler?: Scheduler;
}): WindowStateWriter {
  const scheduler = opts.scheduler ?? realScheduler;
  const delayMs = opts.delayMs ?? SAVE_DEBOUNCE_MS;
  let timer: TimerHandle | undefined;
  let pending: WindowState | undefined;
  let lastWritten: WindowState | undefined;

  const commit = (): void => {
    timer = undefined;
    const state = pending;
    pending = undefined;
    if (!state || windowStateEquals(state, lastWritten)) return;
    lastWritten = state;
    opts.write(state);
  };

  return {
    schedule(state) {
      // A minimized or degenerate window reports nothing worth keeping. Note it
      // does NOT cancel a pending write: that write still holds the last good
      // geometry, which is exactly what should survive being minimized.
      if (!state) return;
      pending = state;
      if (timer !== undefined) scheduler.clearTimeout(timer);
      timer = scheduler.setTimeout(commit, delayMs);
    },
    flush(state) {
      if (state) pending = state;
      if (timer !== undefined) {
        scheduler.clearTimeout(timer);
        timer = undefined;
      }
      commit();
    },
    isPending() {
      return timer !== undefined;
    },
    cancel() {
      if (timer !== undefined) scheduler.clearTimeout(timer);
      timer = undefined;
      pending = undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Wiring it to a window
// ---------------------------------------------------------------------------

/** The `BrowserWindow` events this listens to. */
export type WindowStateEvent =
  | 'resize'
  | 'move'
  | 'maximize'
  | 'unmaximize'
  | 'enter-full-screen'
  | 'leave-full-screen'
  | 'close';

export type PersistableWindow = WindowLike & {
  on(event: WindowStateEvent, listener: () => void): unknown;
};

/**
 * Save this window's geometry from now until it closes.
 *
 * The discrete events flush immediately (there is nothing to coalesce about a
 * single maximize, and the user has just told us something we would hate to
 * lose); the continuous ones debounce. `close` — not `closed` — because the
 * window must still be able to answer `getNormalBounds()` when we ask.
 */
export function installWindowStatePersistence(
  win: PersistableWindow,
  opts: {
    path?: string;
    delayMs?: number;
    scheduler?: Scheduler;
    /** Overridable so a test never touches a real file. */
    write?: (state: WindowState) => void;
  } = {},
): WindowStateWriter {
  const path = opts.path ?? windowStateFilePath();
  const writer = createWindowStateWriter({
    write: opts.write ?? ((state) => writeWindowStateFile(path, state)),
    delayMs: opts.delayMs,
    scheduler: opts.scheduler,
  });

  for (const event of ['resize', 'move'] as const) {
    win.on(event, () => writer.schedule(captureWindowState(win)));
  }
  for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) {
    win.on(event, () => writer.flush(captureWindowState(win)));
  }
  win.on('close', () => writer.flush(captureWindowState(win)));

  return writer;
}
