// electron/power-policy.ts
//
// KEEPING THE TELEGRAM CHANNEL ALIVE WHILE NOBODY IS LOOKING — the decidable
// half. IMPORTS NOTHING, deliberately: `electron/telegram-power.ts` imports
// `electron` and therefore cannot be loaded outside an Electron process, so
// every rule that can be stated as arithmetic over plain values lives here and
// is asserted by `src/spikes/spike-telegram-power.ts` instead. Same device as
// `notification-copy.ts` next door, for the same reason.
//
// THE COMPLAINT THIS ANSWERS. "As long as naby is running, Telegram should work
// — locked screen, screensaver, backgrounded, no visible window." Sleep and
// power-off are out of scope and stay out: the user accepts those stopping it.
//
// WHY THE LOCK SCREEN WAS EVER A PROBLEM. The poll loop runs in the Electron
// MAIN process, so renderer timer throttling has nothing to do with it. What
// does is macOS App Nap (and, less aggressively, Windows' own idle handling):
// an app the user is not interacting with can have its timers coalesced and its
// process suspended outright, which stops a `getUpdates` long-poll dead. A
// power-save blocker is the documented opt-out.

/**
 * THE BLOCKER TYPE, and the one that is NOT used.
 *
 * `prevent-app-suspension` — "Prevent the app from being suspended. Keeps system
 * active but ALLOWS THE SCREEN TO BE TURNED OFF." That last clause is the whole
 * reason it is this one: the case the user named is a LOCKED LAPTOP, and the
 * screen must be free to go dark.
 *
 * `prevent-display-sleep` would keep the monitor lit on a locked machine — a
 * bright screen in a dark room all night, plus the battery to run it, in
 * exchange for nothing this feature needs. It is also higher precedence in
 * Electron's own model, so holding it would silently override anything else.
 * Never use it here.
 *
 * WHAT IT STILL COSTS, stated rather than buried. `prevent-app-suspension` also
 * stops the SYSTEM idle-sleeping for as long as it is held. On a laptop that is
 * real battery. That is proportionate only while the user has actually opted
 * into a phone-controlled agent, which is why `blockerAction` below is driven by
 * whether the listener is RUNNING and never by the app's lifetime.
 */
export const POWER_SAVE_BLOCKER_TYPE = 'prevent-app-suspension' as const;

/**
 * The `powerMonitor` events that mean "the machine is back, re-establish the
 * connection now".
 *
 * PLATFORM SUPPORT, from Electron 43's own typings — no platform branch here,
 * because none is needed: Electron simply never emits an event on a platform
 * that has none, so registering all three is correct everywhere and a `darwin`
 * check would only be a lie waiting to rot.
 *
 *   * `resume`                 — every platform. Waking from sleep.
 *   * `unlock-screen`          — macOS and Windows. Screen unlocked. This is
 *                                also what a password-protected screensaver
 *                                ending looks like: there is no screensaver
 *                                event of its own on either platform.
 *   * `user-did-become-active` — macOS only. A login session became active
 *                                again (fast user switching, and the
 *                                no-password screensaver case that never fires
 *                                `unlock-screen`).
 *
 * Not included, and why: `suspend` and `lock-screen` are the way OUT, and the
 * loop needs nothing done to it on the way out — its poll is already aborted by
 * the OS or simply resumes. Acting on them would only risk starting a poll the
 * machine is about to freeze.
 */
export const TELEGRAM_WAKE_EVENTS = ['resume', 'unlock-screen', 'user-did-become-active'] as const;

export type TelegramWakeEvent = (typeof TELEGRAM_WAKE_EVENTS)[number];

/** Whether a name is one of the events we act on. Exported so the wiring cannot
 *  drift from the list without the spike noticing. */
export function isTelegramWakeEvent(name: string): name is TelegramWakeEvent {
  return (TELEGRAM_WAKE_EVENTS as readonly string[]).includes(name);
}

/**
 * How close together two wake events have to be before the second is treated as
 * part of the same wake.
 *
 * Unlocking a slept laptop fires `resume`, `unlock-screen` AND
 * `user-did-become-active` within a few hundred milliseconds of each other. Each
 * one aborts the poll in flight, so acting on all three would abort the fresh
 * poll the first one just started — twice — which is exactly the hot spin the
 * listener's own abort ceiling exists to stop. One wake, one kick.
 */
export const WAKE_COALESCE_MS = 3_000;

/** Whether this wake event should actually reach the listener, or is a duplicate
 *  of one already acted on. `lastWakeAt` is `undefined` when none has been. */
export function shouldWake(
  lastWakeAt: number | undefined,
  now: number,
  coalesceMs: number = WAKE_COALESCE_MS,
): boolean {
  if (lastWakeAt === undefined) return true;
  // A clock that went BACKWARDS (a resume is exactly when that happens) must not
  // wedge the gate shut for however long the jump was.
  if (now < lastWakeAt) return true;
  return now - lastWakeAt >= coalesceMs;
}

/**
 * What to do with the power-save blocker given what is held and what is wanted.
 *
 * `wanted` is "a Telegram poll loop is running right now", nothing else. The
 * three-way answer rather than a boolean is what makes the acquire/release
 * IDEMPOTENT: the listener flips on every pause handshake (the Settings "Detect"
 * button ends the loop and restarts it), on every config save, and on shutdown,
 * so this is asked far more often than the answer changes.
 */
export function blockerAction(held: boolean, wanted: boolean): 'start' | 'stop' | 'none' {
  if (wanted && !held) return 'start';
  if (!wanted && held) return 'stop';
  return 'none';
}
