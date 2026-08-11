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

import { BrowserWindow, Notification } from 'electron';
import { notificationCopy, type NotifyKind, type NotifyLocale } from './notification-copy.js';

// The catalogue, the label sanitizer and the kind/locale guards live in
// ./notification-copy.ts — they import nothing, so they are decidable (and
// spike-tested) without a compositor. Re-exported here so callers have one
// import for the whole surface.
export {
  sanitizeLabel,
  asNotifyLocale,
  isNotifyKind,
  notificationCopy,
  NOTIFY_LABEL_MAX,
} from './notification-copy.js';
export type { NotifyKind, NotifyLocale } from './notification-copy.js';

/**
 * Put one banner on the desktop. Returns whether the OS actually took it.
 *
 * NEVER THROWS. A machine with notifications turned off, a Linux session with no
 * notification daemon, a user who denied permission: all of them answer `false`,
 * and the app carries on. The badge in the sidebar is still there — this is the
 * additional reach, not the record.
 *
 * CLICKING IT BRINGS THE APP FORWARD, which is the only sensible action: the
 * banner says something finished, and the thing that says WHAT is the window.
 */
export function showNotification(input: {
  kind: NotifyKind;
  locale: NotifyLocale;
  label: string;
}): boolean {
  try {
    if (!Notification.isSupported()) return false;
    const { title, body } = notificationCopy(input.kind, input.locale, input.label);
    const notification = new Notification({ title, body, silent: false });
    notification.on('click', () => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
    notification.show();
    return true;
  } catch {
    // Rule: an observation channel must never break the thing it observes.
    return false;
  }
}
