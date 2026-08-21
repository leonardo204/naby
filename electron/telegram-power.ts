// electron/telegram-power.ts
//
// "AS LONG AS NABY IS RUNNING, TELEGRAM SHOULD WORK" — the Electron half.
//
// Two jobs, and they are separate on purpose:
//
//   1. HOLD A POWER-SAVE BLOCKER while, and only while, the Telegram listener is
//      actually running. This is the App Nap opt-out. Without it macOS is free
//      to suspend a backgrounded, window-less app and the long-poll simply stops
//      — which is the locked-screen / screensaver case the user named.
//   2. KICK THE LISTENER ON WAKE. Coming back from sleep or a lock, the poll in
//      flight is holding a socket that no longer exists. Aborting it turns a
//      dead channel into a fresh poll on the next tick instead of one that waits
//      out the wall clock and then a back-off.
//
// WHAT IS STILL OUT OF SCOPE, and accepted: closing the lid, a real sleep, and
// power-off all stop the channel. `prevent-app-suspension` blocks IDLE sleep; it
// does not and should not fight a sleep the user asked for.
//
// WHY THE CONTROL SURFACE IS PASSED IN rather than imported. The listener lives
// in the shell's built bundle (`shell/dist/telegramChat.mjs`) and there must be
// exactly ONE instance of it in this process — two bridges means two getUpdates
// loops on one bot token, which Telegram answers with a 409 and which breaks
// both. `next-server.ts` already imports that single specifier, so it hands the
// functions down (`BackgroundServices.telegramControl`) and this file never
// resolves the bundle itself. Same rule as the file header there states.

import { powerMonitor, powerSaveBlocker } from 'electron';
import {
  blockerAction,
  POWER_SAVE_BLOCKER_TYPE,
  shouldWake,
  TELEGRAM_WAKE_EVENTS,
} from './power-policy.js';

/** The slice of `shell/dist/telegramChat.mjs` this file drives. Every member is
 *  optional: an older shell build simply does not have them, and a missing
 *  function must degrade to "no blocker, no kick" rather than to a crash on a
 *  `resume` event. */
export type TelegramChatControl = {
  /** Abort the poll in flight so the next one starts immediately. */
  wakeTelegramChat?: (reason: string) => void;
  /** Watch `loopRunning`. Fires once immediately; returns an unsubscribe. */
  observeTelegramChat?: (cb: (running: boolean) => void) => () => void;
};

export type TelegramPowerHandle = {
  /** Release the blocker and detach every listener. Idempotent. */
  dispose(): void;
  /** Whether a blocker is held right now — for the spike and for logging. */
  blockerHeld(): boolean;
};

/**
 * Wire the listener's lifetime to a power-save blocker, and the machine's wake
 * events to the listener.
 *
 * Never throws. `powerMonitor` and `powerSaveBlocker` are both available on
 * macOS, Windows and Linux, but every call is still guarded: this is a
 * background convenience, and refusing to boot over it would turn "your bot is
 * quiet" into "your app will not open".
 */
export function installTelegramPower(
  control: TelegramChatControl | undefined,
  log: (msg: string) => void = () => {},
): TelegramPowerHandle {
  let blockerId: number | undefined;
  let disposed = false;
  let lastWakeAt: number | undefined;
  const detach: Array<() => void> = [];

  // -- 1. the blocker, driven by the listener's own state ---------------------
  //
  // NEVER UNCONDITIONAL. It costs the user's machine its idle sleep, and that is
  // only proportionate while a phone-controlled agent is actually listening. So
  // it follows `loopRunning`: acquired when the loop starts, released when it
  // stops — including when Telegram is switched off in Settings or the config
  // goes half-written, both of which end the loop and so land here.

  const applyBlocker = (wanted: boolean): void => {
    if (disposed && wanted) return; // teardown never re-acquires
    try {
      const held = blockerId !== undefined && powerSaveBlocker.isStarted(blockerId);
      // `isStarted` disagreeing with our own handle means the blocker was
      // stopped underneath us; forget the stale id rather than trying to stop it
      // again.
      if (blockerId !== undefined && !held) blockerId = undefined;
      switch (blockerAction(held, wanted)) {
        case 'start': {
          blockerId = powerSaveBlocker.start(POWER_SAVE_BLOCKER_TYPE);
          log(
            `[telegram-power] ${POWER_SAVE_BLOCKER_TYPE} held (id ${blockerId}) — the listener is running`,
          );
          break;
        }
        case 'stop': {
          const id = blockerId;
          blockerId = undefined;
          if (id !== undefined) powerSaveBlocker.stop(id);
          log(`[telegram-power] ${POWER_SAVE_BLOCKER_TYPE} released (id ${id}) — no listener`);
          break;
        }
        case 'none':
          break;
      }
    } catch (err) {
      log(`[telegram-power] blocker ${wanted ? 'acquire' : 'release'} failed: ${String(err)}`);
    }
  };

  if (typeof control?.observeTelegramChat === 'function') {
    try {
      // Fires once immediately with the current state, so a listener that
      // started before this wiring — the ordinary case, `startTelegramChat()`
      // runs during boot — is not left unprotected until its next restart.
      const off = control.observeTelegramChat((running) => applyBlocker(running));
      detach.push(off);
    } catch (err) {
      log(`[telegram-power] listener observation failed: ${String(err)}`);
    }
  } else {
    log('[telegram-power] shell exports no observeTelegramChat — no suspension blocker');
  }

  // -- 2. the wake kick -------------------------------------------------------

  if (typeof control?.wakeTelegramChat === 'function') {
    const wake = control.wakeTelegramChat.bind(control);
    // `powerMonitor.on` is typed as one overload PER EVENT NAME, so a name taken
    // out of a list matches none of them — TypeScript has no way to pick. The
    // narrowing that matters (the name is one of ours) is already done by
    // `TELEGRAM_WAKE_EVENTS` being a const tuple; this only restates the
    // EventEmitter shape those overloads all share.
    const monitor = powerMonitor as unknown as {
      on(event: string, listener: () => void): void;
      removeListener(event: string, listener: () => void): void;
    };
    for (const event of TELEGRAM_WAKE_EVENTS) {
      const handler = (): void => {
        if (disposed) return;
        const now = Date.now();
        // One unlock fires two or three of these within a few hundred ms. Each
        // would abort the poll the previous one just started.
        if (!shouldWake(lastWakeAt, now)) {
          log(`[telegram-power] ${event} coalesced into the wake already handled`);
          return;
        }
        lastWakeAt = now;
        try {
          wake(event);
        } catch (err) {
          log(`[telegram-power] wake on ${event} failed: ${String(err)}`);
        }
      };
      try {
        monitor.on(event, handler);
        detach.push(() => monitor.removeListener(event, handler));
      } catch (err) {
        // A platform without this event: not an error, and nothing to undo.
        log(`[telegram-power] ${event} not available here: ${String(err)}`);
      }
    }
    log(`[telegram-power] wake events armed: ${TELEGRAM_WAKE_EVENTS.join(', ')}`);
  } else {
    log('[telegram-power] shell exports no wakeTelegramChat — no wake kick');
  }

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const off of detach) {
        try {
          off();
        } catch {
          /* already gone */
        }
      }
      detach.length = 0;
      // Last, and unconditionally: a held blocker outliving the app's teardown
      // would keep the machine awake with nothing left to listen.
      applyBlocker(false);
    },
    blockerHeld(): boolean {
      return blockerId !== undefined;
    },
  };
}
