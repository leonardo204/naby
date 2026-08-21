// electron/notifications.ts
//
// THE ONE CHANNEL THAT REACHES A USER WHO IS LOOKING AT SOMETHING ELSE.
//
// THE REPORT THIS EXISTS FOR. naby can now start a deploy in the background and
// speak first when it lands (src/runtime/jobs.ts + lib/backgroundJobReport.ts).
// That report arrives as an unread badge in a window the user walked away from
// twenty minutes ago — which is the same silence in a new shape. Until now this
// app used no OS notifications at all (`new Notification` appeared nowhere in
// electron/), so the desktop had strictly less reach than the web build, which at
// least has Web Push.
//
// WHY THE TEXT LIVES HERE AND NOT IN THE RENDERER. Preload's founding rule is one
// named function per channel and no generic escape hatch, precisely so the
// reachable IPC surface is auditable by reading it. A channel that took a title
// and a body would hand any script that achieves execution in the page a
// system-level banner generator — an OS-drawn, app-branded box saying whatever it
// liked. So the WORDS are a fixed catalogue in this file, keyed by an enum; the
// renderer chooses WHICH message and supplies one bounded, sanitized label (the
// session's title) for the body. It cannot invent a sentence, and it cannot make
// the banner say something naby would never say.
//
// EVEN THE LABEL IS TREATED AS HOSTILE. It is model- and user-authored text, so
// `sanitizeLabel` strips control characters (a lone \n in a banner is a second
// line the app did not write), collapses whitespace and truncates hard. A
// notification is not a place to render content; it is a place to name it.
//
// WHAT DECIDES WHETHER IT FIRES AT ALL is NOT here. "The app is focused and the
// user is looking at that very session" is a fact only the renderer knows, and it
// is decided by a pure function on that side (`shouldNotifySessionDone`) which is
// unit-tested. This module is the mechanism.
//
// ── THE PILE-UP, AND WHY A DEBOUNCE IS NOT THE FIX ─────────────────────────────
//
// THE REPORT. The user talks to naby over Telegram from their phone, comes back
// to the PC hours later, unlocks it, and finds the SAME banner stacked ten deep.
// Every turn from every source ends the same way — the orchestrator teardown
// writes `unread`, `/ws/global-state` pushes it, the renderer turns that edge
// into one banner — so ten Telegram messages are ten endings and ten banners, all
// with byte-identical text because they name the same session. Focus suppression
// cannot help: the user is on their phone, so the app is unfocused for every one
// of them, which is precisely when a banner is OWED.
//
// A DEBOUNCE ALONE WOULD MERGE NOTHING. Those ten are not a burst in app time —
// they are minutes or hours apart. The pile is assembled by the OS, which holds
// undelivered banners while the machine is locked and reveals them together at
// unlock. No aggregation window this side is wide enough, and one that were would
// mean sitting on the first banner for an hour.
//
// SO THE FIX IS REPLACEMENT. At most ONE banner is ever live. Each further run
// that finishes CLOSES it and shows its successor carrying a running count, so
// the pile the OS reveals at unlock is a single item saying "3 conversations
// finished". Two things make that hold, and both are needed:
//
//   1. WE KEEP THE INSTANCE AND `close()` IT. `showNotification` used to drop the
//      `Notification` on the floor the moment it called `show()`, which left
//      nothing to revoke. Now it is retained in `live`.
//   2. THE NOTIFICATION HAS A FIXED `id`. On macOS that is
//      `UNNotificationRequest.identifier`, on Windows the toast's `Tag`; posting
//      a second notification under an identifier the OS is already holding
//      REPLACES it rather than stacking it. The same one line serves both, so
//      nothing in this file branches on the platform — and it survives an app
//      restart, where an instance handle from the previous run does not.
//
// CLOSING SOMETHING THE OS IS ALREADY HOLDING IS SUPPORTED, and that is the part
// worth being sure of, since it is the whole locked-machine case. Electron's own
// contract (electron.d.ts, v43): `Notification.remove(id)` "removes one or more
// DELIVERED notifications from Notification Center" on macOS, and instance
// `close()` on Windows, "called after the notification is no longer visible on
// screen, will try [to] remove it from the Action Center". Delivered-but-unseen
// is exactly the state a locked machine leaves them in. The fixed `id` is the
// belt to that braces: if a `close()` ever failed to reach a held item, the
// successor posted under the same identifier still collapses onto it.
//
// ORDER MATTERS AND IS NOT INTERCHANGEABLE: close the old one BEFORE showing the
// new one. Both carry the same `id`, so closing the old instance after showing
// the new one would ask the OS to remove that identifier — and take the
// replacement with it.
//
// THE DEBOUNCE IS STILL WORTH HAVING, but as polish rather than as the fix: when
// several runs do land within a second of each other (a scheduled sweep, a
// reconnect) it spares the user a visible close/show flicker per run. It is
// TRAILING, so a burst produces one banner rather than one-then-a-correction.
//
// THE COUNT RESETS WHEN THE USER HAS ACTUALLY SEEN IT — otherwise it grows for
// ever and the banner eventually reads like a billing statement. See
// `clearRunsFinished` for which signals count as "seen" and, more importantly,
// which deliberately do not.

import { app, BrowserWindow, Notification } from 'electron';
import {
  NO_RUNS_FINISHED,
  addRunFinished,
  hasRunsToReport,
  notificationCopy,
  type NotifyKind,
  type NotifyLocale,
  type RunsFinishedState,
} from './notification-copy.js';

// The catalogue, the label sanitizer and the kind/locale guards live in
// ./notification-copy.ts — they import nothing, so they are decidable (and
// spike-tested) without a compositor. Re-exported here so callers have one
// import for the whole surface.
export {
  sanitizeLabel,
  asNotifyLocale,
  isNotifyKind,
  notificationCopy,
  addRunFinished,
  hasRunsToReport,
  asNotifyCount,
  NO_RUNS_FINISHED,
  NOTIFY_LABEL_MAX,
} from './notification-copy.js';
export type { NotifyKind, NotifyLocale, RunsFinishedState } from './notification-copy.js';

/**
 * The identifier every "runs finished" banner is posted under.
 *
 * FIXED ON PURPOSE — it is what makes the OS treat the next banner as a
 * REPLACEMENT for the one it is holding rather than as a second item (macOS
 * `UNNotificationRequest.identifier`, Windows toast `Tag`). One constant, both
 * platforms, no branch. It also spans app restarts, which an instance handle
 * cannot: a banner left in Notification Center by yesterday's run is replaced by
 * today's rather than sitting under it.
 */
const RUNS_FINISHED_ID = 'naby.runs-finished';

/**
 * How long to keep collecting before drawing.
 *
 * SMALL, because this is not the fix — replacement is (see the header). It only
 * absorbs the case where several runs land at once, so the user sees one banner
 * instead of watching one redraw three times. Long enough to swallow a burst,
 * short enough that a lone finish still feels immediate.
 */
const COALESCE_MS = 400;

/** The one live banner, retained so it can be revoked. `undefined` means there
 *  is nothing on the user's screen (or in their Notification Center) from us. */
let live: Notification | undefined;

/** What that banner stands for. Survives the banner itself: closing on focus
 *  clears both, but a run finishing while none is live rebuilds from here. */
let runs: RunsFinishedState = NO_RUNS_FINISHED;

/** The pending trailing debounce, if a flush is already scheduled. */
let flushTimer: ReturnType<typeof setTimeout> | undefined;

/** Which catalogue entry and language the pending flush will draw. There is one
 *  kind today; keeping them beside the tally means adding a second kind is a
 *  change to this pair, not a redesign. */
let pendingKind: NotifyKind = 'session-done';
let pendingLocale: NotifyLocale = 'en';

/** Bring the window the banner is about to the front. The banner says something
 *  finished; the thing that says WHAT is the window. */
function focusMainWindow(): void {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * Take back whatever is on screen, if anything.
 *
 * Safe to call when nothing is live and safe to call twice: `close()` on an
 * already-dismissed notification is a no-op, and the handle is dropped either
 * way so we never hold a dead instance whose `id` we might later revoke out from
 * under its replacement.
 */
function closeLive(): void {
  const current = live;
  live = undefined;
  if (!current) return;
  try {
    current.close();
  } catch {
    // A notification we cannot revoke is a cosmetic problem; throwing here would
    // make it an app problem.
  }
}

/**
 * Draw the one banner for everything collected so far.
 *
 * CLOSE THEN SHOW, never the other way round — they share `RUNS_FINISHED_ID`, so
 * closing the old instance after posting the new one would revoke that
 * identifier and delete the replacement along with the original.
 *
 * The tally is NOT cleared here. The banner is a view of `runs`, not a drain of
 * it: the next run that finishes has to be able to say "3", and only the user
 * seeing it (`clearRunsFinished`) sets it back to zero.
 */
function flushRunsFinished(): void {
  flushTimer = undefined;
  if (!hasRunsToReport(runs)) return;
  try {
    const { title, body } = notificationCopy(pendingKind, pendingLocale, runs.label, runs.count);
    closeLive();
    const notification = new Notification({ id: RUNS_FINISHED_ID, title, body, silent: false });
    // Clicking is the strongest possible evidence that the user saw it, so it
    // both acts and resets. Resetting HERE as well as on window focus is not
    // redundant: `focusMainWindow` may find no window at all (macOS keeps the app
    // resident with every window closed), and then no focus event ever arrives.
    notification.on('click', () => {
      clearRunsFinished();
      focusMainWindow();
    });
    // NOTE: `close` is deliberately NOT treated as "seen". Electron documents it
    // as "not guaranteed to be emitted in all cases", and on Windows it fires for
    // system timeout too — a banner ageing out into the Action Center unread
    // would reset the count in exactly the away-from-desk case this whole
    // mechanism exists for. We also keep the handle after a close rather than
    // dropping it there, so a banner the OS has merely tucked away can still be
    // revoked when its replacement arrives.
    notification.show();
    live = notification;
  } catch {
    // Rule: an observation channel must never break the thing it observes.
    live = undefined;
  }
}

/**
 * Record that one more run finished, and schedule the single banner that stands
 * for all of them. Returns whether this machine can show banners at all.
 *
 * NEVER THROWS. A machine with notifications turned off, a Linux session with no
 * notification daemon, a user who denied permission: all of them answer `false`,
 * and the app carries on. The badge in the sidebar is still there — this is the
 * additional reach, not the record.
 *
 * THE ANSWER IS "ACCEPTED", NOT "DRAWN". Because the draw is debounced, the only
 * honest synchronous answer is whether the platform has notifications and the
 * request was taken. The caller (`notify:show`) uses it for nothing more than
 * that, and the renderer treats a `false` the same way it always has — silently.
 */
export function showNotification(input: {
  kind: NotifyKind;
  locale: NotifyLocale;
  label: string;
}): boolean {
  try {
    if (!Notification.isSupported()) return false;
    pendingKind = input.kind;
    pendingLocale = input.locale;
    runs = addRunFinished(runs, input.label);
    if (flushTimer === undefined) {
      flushTimer = setTimeout(flushRunsFinished, COALESCE_MS);
      // A pending banner must never be the reason the app is still running.
      flushTimer.unref?.();
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The user has seen it: forget the tally and take the banner back.
 *
 * THE RESET RULE, and why it is this one. The count has to reset on something,
 * or it grows for ever; the signal has to mean "they have actually seen it", and
 * the only two that do are the user CLICKING the banner and the app WINDOW
 * COMING TO THE FRONT. Focus is the load-bearing one: the banner exists purely to
 * reach someone who is looking at something else, and the moment the window is in
 * front they are looking at the sidebar, which carries the same unread dots and
 * is the authoritative record. There is nothing left for the banner to say, so it
 * is dismissed too rather than left in Notification Center as a stale duplicate
 * of what is now on screen.
 *
 * IT ERRS TOWARDS UNDER-RESETTING, which is the safe direction. Someone who
 * focuses the window and walks away again without reading loses a count — and
 * loses nothing, because the dots remain. Whereas a rule that reset on dismissal
 * or timeout would forget runs the user never saw, in precisely the
 * away-from-the-desk case that produced the report.
 */
export function clearRunsFinished(): void {
  if (flushTimer !== undefined) {
    clearTimeout(flushTimer);
    flushTimer = undefined;
  }
  runs = NO_RUNS_FINISHED;
  closeLive();
}

/**
 * Arm the reset. Returns a disposer, so a test entry or a second app instance can
 * take it back down.
 *
 * `browser-window-focus` is an APP-level event on every platform, which is what
 * lets the accumulator live entirely in main: no new IPC channel, no renderer
 * telling main what the user has read, nothing on the bridge to trust.
 */
export function installRunsFinishedReset(): () => void {
  app.on('browser-window-focus', clearRunsFinished);
  return () => {
    app.off('browser-window-focus', clearRunsFinished);
  };
}
