// electron/spike-power-entry.ts
//
// THE RUNTIME HALF of "naby's Telegram keeps working while nobody is looking" —
// the code that runs INSIDE a real Electron main process, against the real
// `powerSaveBlocker` and the real `powerMonitor`.
//
// WHY A REAL PROCESS IS REQUIRED HERE. The pure half
// (`src/spikes/spike-telegram-power.ts`) can prove that our arithmetic decides
// to acquire and release at the right moments. It cannot prove that the OS
// actually took the assertion, that `'prevent-app-suspension'` is a type this
// Electron accepts, or that `powerMonitor` really carries the three event names
// the wiring subscribes to. Those are runtime contracts of the platform, and a
// green pure spike that asserts them by construction is exactly the trap
// `spike-window-state.ts` documents at length.
//
// WHAT IT DRIVES. The PRODUCTION `installTelegramPower`, fed a FAKE control
// surface. The fake stands in for the shell's built bundle and nothing else —
// there is no Telegram config here, no store, and no network. The listener's own
// start/stop signal is a function this file calls, which is precisely the signal
// the real bundle emits.
//
// WHAT IT CANNOT STAGE, said plainly rather than faked: a real sleep, a real
// screen lock, and a real screensaver. No test process can put the machine to
// sleep and be around to report on it. What IS staged is the handler path those
// events run down — `powerMonitor` is an EventEmitter, so emitting `resume` on
// it runs the exact listener the OS would run, through the exact coalescing
// window.
//
// SAFETY: this holds a `prevent-app-suspension` blocker for a few hundred
// milliseconds and releases it before exiting. It never touches
// `prevent-display-sleep`, and the final observation reports the blocker's state
// at exit so a leak would be visible rather than assumed away.

import { app, powerMonitor, powerSaveBlocker } from 'electron';
import { writeSync } from 'node:fs';
import { installTelegramPower, type TelegramChatControl } from './telegram-power.js';
import { TELEGRAM_WAKE_EVENTS, WAKE_COALESCE_MS } from './power-policy.js';

const MARK = '##SPIKEPWR##';

function emit(event: string, data: Record<string, unknown>): void {
  // writeSync to fd 1: an async write's callback fires when libuv accepts the
  // buffer, not when the OS has it, so `app.exit()` can discard the last
  // observation. Same reason spike-entry.ts gives.
  writeSync(1, `${MARK}${JSON.stringify({ event, ...data })}\n`);
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', () => {
  /* no windows are ever opened — this spike is entirely main-process */
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The shell bundle's control surface, faked. `setRunning` is the listener's own
 *  `loopRunning` edge — the thing the real bridge notifies on. */
function fakeControl(): {
  control: TelegramChatControl;
  setRunning: (running: boolean) => void;
  wakes: string[];
  subscribers: () => number;
} {
  const watchers = new Set<(running: boolean) => void>();
  let running = false;
  const wakes: string[] = [];
  return {
    control: {
      wakeTelegramChat: (reason: string): void => {
        wakes.push(reason);
      },
      observeTelegramChat: (cb): (() => void) => {
        watchers.add(cb);
        cb(running); // fires immediately, exactly as the real one does
        return () => watchers.delete(cb);
      },
    },
    setRunning: (next: boolean): void => {
      if (running === next) return;
      running = next;
      for (const w of watchers) w(next);
    },
    wakes,
    subscribers: () => watchers.size,
  };
}

async function run(): Promise<void> {
  await app.whenReady();

  // -- (a) the platform actually honours the blocker type we chose -----------
  //
  // Asserted directly, before any of our own code, so a failure here reads as
  // "Electron/the OS refused" rather than as a bug in the wiring.
  const probeId = powerSaveBlocker.start('prevent-app-suspension');
  const probeHeld = powerSaveBlocker.isStarted(probeId);
  powerSaveBlocker.stop(probeId);
  emit('blocker-probe', {
    platform: process.platform,
    id: probeId,
    heldWhileStarted: probeHeld,
    heldAfterStop: powerSaveBlocker.isStarted(probeId),
  });

  // -- (b) the wake events exist on this powerMonitor ------------------------
  //
  // Subscribing to an event a platform does not emit is harmless; subscribing to
  // one that THROWS is not, and that is what a typo would look like.
  const armed: Record<string, boolean> = {};
  for (const name of TELEGRAM_WAKE_EVENTS) {
    const noop = (): void => {};
    try {
      (powerMonitor as unknown as { on(e: string, l: () => void): void }).on(name, noop);
      (powerMonitor as unknown as { removeListener(e: string, l: () => void): void }).removeListener(
        name,
        noop,
      );
      armed[name] = true;
    } catch {
      armed[name] = false;
    }
  }
  emit('wake-events', { armed });

  // -- (c) the production lifecycle, end to end ------------------------------
  const fake = fakeControl();
  const before = Object.fromEntries(
    TELEGRAM_WAKE_EVENTS.map((n) => [n, powerMonitor.listenerCount(n)]),
  );
  const handle = installTelegramPower(fake.control, (msg) => emit('log', { msg }));
  const after = Object.fromEntries(
    TELEGRAM_WAKE_EVENTS.map((n) => [n, powerMonitor.listenerCount(n)]),
  );

  emit('installed', {
    // NOT held: the fake listener starts stopped, and a blocker taken before
    // there is anything to protect is the "unconditional for the app's lifetime"
    // mistake this design exists to avoid.
    blockerHeldAtInstall: handle.blockerHeld(),
    subscribed: fake.subscribers(),
    listenerCountBefore: before,
    listenerCountAfter: after,
  });

  // The listener starts — this is `ensureListener` in the real bridge.
  fake.setRunning(true);
  await wait(50);
  emit('listener-started', { blockerHeld: handle.blockerHeld() });

  // Idempotence: the bridge notifies on edges, but a second identical notify
  // (a re-subscribe, a hot reload) must not take a second assertion.
  fake.setRunning(true);
  await wait(20);
  emit('listener-started-again', { blockerHeld: handle.blockerHeld() });

  // -- (d) the wake path, through the REAL emitter ---------------------------
  //
  // `powerMonitor` is an EventEmitter, so this runs the exact handler the OS
  // would run. One unlock fires two or three of these within a few hundred ms
  // and they must collapse into ONE kick — each one aborts the poll in flight,
  // so acting on all three would abort the fresh poll the first one started.
  for (const name of TELEGRAM_WAKE_EVENTS) {
    (powerMonitor as unknown as { emit(e: string): void }).emit(name);
  }
  await wait(20);
  emit('wake-burst', { kicks: [...fake.wakes] });

  // Past the coalescing window, a genuinely separate wake gets through.
  await wait(WAKE_COALESCE_MS + 250);
  (powerMonitor as unknown as { emit(e: string): void }).emit('resume');
  await wait(20);
  emit('wake-later', { kicks: [...fake.wakes] });

  // -- (e) the listener stops — the config went unready, or Telegram was
  //        switched off, or the app is quitting. The blocker goes with it.
  fake.setRunning(false);
  await wait(50);
  emit('listener-stopped', { blockerHeld: handle.blockerHeld() });

  // -- (f) dispose releases everything and detaches ---------------------------
  fake.setRunning(true);
  await wait(20);
  const heldBeforeDispose = handle.blockerHeld();
  handle.dispose();
  const finalCounts = Object.fromEntries(
    TELEGRAM_WAKE_EVENTS.map((n) => [n, powerMonitor.listenerCount(n)]),
  );
  emit('disposed', {
    heldBeforeDispose,
    blockerHeld: handle.blockerHeld(),
    listenerCountAfterDispose: finalCounts,
    subscribedAfterDispose: fake.subscribers(),
  });

  // Dispose twice: teardown paths run more than once in practice.
  handle.dispose();
  // And a listener edge AFTER dispose must not resurrect the blocker.
  fake.setRunning(false);
  fake.setRunning(true);
  await wait(20);
  emit('after-dispose', { blockerHeld: handle.blockerHeld() });

  emit('done', {});
  app.exit(0);
}

void run().catch((err: unknown) => {
  emit('fatal', { error: err instanceof Error ? err.message : String(err) });
  app.exit(1);
});
