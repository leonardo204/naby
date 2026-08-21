// src/spikes/spike-telegram-power.ts
//
// SPIKE-TELEGRAM-POWER — "as long as naby is running, Telegram should work."
//
// THE COMPLAINT. The bot went quiet while the app was still running: locked
// screen, screensaver, backgrounded, no visible window. Sleep and power-off are
// out of scope by agreement — the user accepts those stopping it.
//
// THE TWO CAUSES, and where each is verified:
//
//   1. THE POLL HAD NO WALL CLOCK OF ITS OWN. `timeout=25` in the getUpdates
//      query tells TELEGRAM how long to hold the request; it constrains nothing
//      on our side. A half-open socket therefore left the listener's single
//      `await` pending indefinitely, and the loop is single-threaded, so one hung
//      poll killed the whole channel — silently, since a hang is neither an
//      error nor an update and the loop logs only transitions. That fix is in
//      the shell and is covered by vitest (`telegram.test.ts`,
//      `telegramEscalation.test.ts`), including a test that hangs and fails if
//      the timer is removed.
//   2. NOTHING OPTED OUT OF APP NAP. A backgrounded, window-less Electron app
//      can be suspended by macOS outright, which stops a long-poll dead. THAT is
//      the locked-screen/screensaver half, and it is what this spike covers.
//
// WHY A SPIKE AND NOT A TEST. `electron/telegram-power.ts` imports `electron`
// and cannot be loaded by a test runner, and the thing that matters most — that
// the OS actually takes the assertion — is a runtime contract, not arithmetic.
// So this file does three things:
//
//   * PURE ASSERTIONS on `electron/power-policy.ts`, which imports nothing and
//     holds every decision that can be stated as arithmetic.
//   * SOURCE ASSERTIONS on `electron/telegram-power.ts` and its two call sites,
//     for facts no runtime check on this machine can reach — chiefly that
//     `prevent-display-sleep` appears nowhere, and that the blocker is driven by
//     the listener's own state rather than by the app's lifetime. Same device
//     `spike-notify.ts` uses next door.
//   * A REAL ELECTRON RUN (dist/electron/spike-power-entry.mjs) driving the
//     production `installTelegramPower` against the real `powerSaveBlocker` and
//     the real `powerMonitor`.
//
// A probe that fails to RUN is a missing observation and therefore a FAIL — it
// is never allowed to pass quietly by not executing.
//
// Run: npm run spike:telegram-power

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  blockerAction,
  isTelegramWakeEvent,
  POWER_SAVE_BLOCKER_TYPE,
  shouldWake,
  TELEGRAM_WAKE_EVENTS,
  WAKE_COALESCE_MS,
} from '../../electron/power-policy.js';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = resolve(ROOT, 'dist/electron/spike-power-entry.mjs');
const MARK = '##SPIKEPWR##';
const RUN_TIMEOUT_MS = 60_000;

const POWER_SRC = readFileSync(resolve(ROOT, 'electron/telegram-power.ts'), 'utf8');
const POLICY_SRC = readFileSync(resolve(ROOT, 'electron/power-policy.ts'), 'utf8');
const BOOT_SRC = readFileSync(resolve(ROOT, 'electron/boot.ts'), 'utf8');
const NEXT_SERVER_SRC = readFileSync(resolve(ROOT, 'electron/next-server.ts'), 'utf8');

type Check = { name: string; pass: boolean; evidence: string };
type Obs = { event: string; [k: string]: unknown };

const checks: Check[] = [];
function record(name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

// ---------------------------------------------------------------------------
// (a) the blocker TYPE — the one decision with a cost the user can feel
// ---------------------------------------------------------------------------

record(
  '(a1) the blocker is prevent-app-suspension, and prevent-display-sleep appears NOWHERE',
  POWER_SAVE_BLOCKER_TYPE === 'prevent-app-suspension' &&
    !POWER_SRC.includes("'prevent-display-sleep'") &&
    !POLICY_SRC.includes("start('prevent-display-sleep')"),
  // prevent-display-sleep would keep the monitor lit on a locked laptop all
  // night. The case the user named is a locked screen; the screen must be free
  // to go dark. It is also higher precedence in Electron's own model, so holding
  // it would silently override everything else.
  `type=${POWER_SAVE_BLOCKER_TYPE}; display-sleep mentioned only as the rejected option`,
);

record(
  '(a2) the cost of prevent-app-suspension is written down, not buried',
  /idle[- ]sleep/i.test(POLICY_SRC) && /batter/i.test(POLICY_SRC),
  'power-policy.ts states that the assertion also stops system idle sleep, and what that costs',
);

// ---------------------------------------------------------------------------
// (b) acquire / release is driven by the LISTENER, never by the app's lifetime
// ---------------------------------------------------------------------------

record(
  '(b1) the blocker follows observeTelegramChat, i.e. the listener loop itself',
  POWER_SRC.includes('observeTelegramChat') && POWER_SRC.includes('applyBlocker(running)'),
  'installTelegramPower subscribes to the listener state and applies the blocker from it',
);

record(
  '(b2) nothing acquires the blocker unconditionally',
  // The ONLY `.start(` in the file is inside the 'start' branch of the action
  // switch, which `blockerAction` can only return when the listener is running.
  (POWER_SRC.match(/powerSaveBlocker\.start\(/g) ?? []).length === 1 &&
    POWER_SRC.includes("case 'start'"),
  'exactly one powerSaveBlocker.start(), reachable only through blockerAction() === "start"',
);

record(
  '(b3) teardown releases it',
  /dispose\(\): void \{[\s\S]*applyBlocker\(false\)/.test(POWER_SRC) &&
    BOOT_SRC.includes('telegramPower.dispose()'),
  'dispose() ends with applyBlocker(false), and boot.ts calls it from shutdown()',
);

record(
  '(b4) a blocker is never re-acquired after teardown',
  POWER_SRC.includes('if (disposed && wanted) return'),
  'applyBlocker refuses an acquire once disposed — a late listener edge cannot resurrect it',
);

// ---------------------------------------------------------------------------
// (c) the acquire/release decision itself
// ---------------------------------------------------------------------------

record(
  '(c1) blockerAction is idempotent in both directions',
  blockerAction(false, true) === 'start' &&
    blockerAction(true, true) === 'none' &&
    blockerAction(true, false) === 'stop' &&
    blockerAction(false, false) === 'none',
  // Asked far more often than the answer changes: the listener flips on every
  // Detect handshake, every config save and every shutdown.
  'start / none / stop / none',
);

// ---------------------------------------------------------------------------
// (d) the wake events
// ---------------------------------------------------------------------------

record(
  '(d1) the three events that mean "the machine is back" are subscribed, and only those',
  TELEGRAM_WAKE_EVENTS.length === 3 &&
    isTelegramWakeEvent('resume') &&
    isTelegramWakeEvent('unlock-screen') &&
    isTelegramWakeEvent('user-did-become-active') &&
    !isTelegramWakeEvent('suspend') &&
    !isTelegramWakeEvent('lock-screen'),
  // `suspend`/`lock-screen` are the way OUT and need nothing done to the loop;
  // acting on them would only start a poll the machine is about to freeze.
  TELEGRAM_WAKE_EVENTS.join(', '),
);

record(
  '(d2) no platform branch — Electron simply does not emit an event a platform lacks',
  !/process\.platform/.test(POWER_SRC) && !/process\.platform/.test(POLICY_SRC),
  // `resume` is every platform; `unlock-screen` is macOS + Windows;
  // `user-did-become-active` is macOS only. A `darwin` check would be a lie
  // waiting to rot, and Windows matters here as much as macOS.
  'neither file branches on process.platform',
);

record(
  '(d3) one unlock is one kick: a burst inside the window collapses',
  shouldWake(undefined, 1_000) &&
    !shouldWake(1_000, 1_000 + WAKE_COALESCE_MS - 1) &&
    shouldWake(1_000, 1_000 + WAKE_COALESCE_MS) &&
    shouldWake(1_000, 1_000 + 60_000),
  // Unlocking a slept laptop fires all three within a few hundred ms. Each
  // aborts the poll in flight, so acting on all three would abort the fresh poll
  // the first one just started — twice.
  `coalesce window ${WAKE_COALESCE_MS}ms`,
);

record(
  '(d4) a clock that jumped BACKWARDS does not wedge the gate shut',
  shouldWake(5_000, 1_000),
  // A resume is precisely when the system clock moves, and a wake that a clock
  // jump can suppress is a wake that fails exactly when it is needed.
  'now < lastWakeAt is treated as a new wake',
);

// ---------------------------------------------------------------------------
// (e) ONE bridge in the process — the wiring that keeps it that way
// ---------------------------------------------------------------------------

record(
  '(e1) telegram-power never resolves the shell bundle itself',
  // The bundle is named in the header comment (explaining why it is NOT loaded
  // here); what must be absent is any means of loading it — no dynamic import,
  // no path built into dist. The control surface arrives as an argument.
  !/await import\(|pathToFileURL|createRequire/.test(POWER_SRC) &&
    POWER_SRC.includes('control: TelegramChatControl | undefined'),
  // Two bridges means two getUpdates loops on one bot token, which Telegram
  // answers with a 409 that breaks both. next-server.ts owns the single import
  // and hands the functions down.
  'the control surface is passed in, not imported',
);

record(
  '(e2) next-server hands out the control surface off the module it already loaded',
  NEXT_SERVER_SRC.includes('services.telegramControl') &&
    (NEXT_SERVER_SRC.match(/telegramChat\.mjs/g) ?? []).length === 1,
  'exactly one telegramChat.mjs specifier, and telegramControl is taken from it',
);

record(
  '(e3) the wiring is installed once, from boot()',
  (BOOT_SRC.match(/installTelegramPower\(/g) ?? []).length === 1 &&
    BOOT_SRC.includes('server.services.telegramControl'),
  'boot.ts installs it with the control surface the server reported',
);

// ---------------------------------------------------------------------------
// (f) the real Electron run
// ---------------------------------------------------------------------------

type ChildOutcome = {
  observations: Obs[];
  exitCode: number | null;
  timedOut: boolean;
  stderr: string;
};

async function runElectron(): Promise<ChildOutcome> {
  const electronBinary = require('electron') as string;
  const child = spawn(electronBinary, [ENTRY], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  });

  const observations: Obs[] = [];
  let buf = '';
  let stderr = '';
  let timedOut = false;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
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

  const code = await new Promise<number | null>((resolvePromise) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, RUN_TIMEOUT_MS);
    // 'close', not 'exit' — the pipes may still hold the last observation.
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolvePromise(exitCode);
    });
  });

  return { observations, exitCode: code, timedOut, stderr };
}

function find(obs: Obs[], event: string): Obs | undefined {
  return obs.find((o) => o.event === event);
}

const outcome = await runElectron();
const obs = outcome.observations;

record(
  '(f0) the Electron probe ran and exited cleanly',
  !outcome.timedOut && outcome.exitCode === 0 && find(obs, 'done') !== undefined,
  `exit=${outcome.exitCode} timedOut=${outcome.timedOut} observations=${obs.length}` +
    (outcome.stderr.trim() ? ` stderr=${outcome.stderr.trim().slice(0, 200)}` : ''),
);

const probe = find(obs, 'blocker-probe');
record(
  '(f1) THE OS TOOK IT: prevent-app-suspension starts, reports held, and stops',
  probe?.heldWhileStarted === true && probe?.heldAfterStop === false,
  // The assertion this whole feature rests on. Pure arithmetic cannot see it.
  probe
    ? `platform=${String(probe.platform)} id=${String(probe.id)} held=${String(probe.heldWhileStarted)} afterStop=${String(probe.heldAfterStop)}`
    : 'no blocker-probe observation',
);

const wakeEvents = find(obs, 'wake-events');
record(
  '(f2) every wake event name is one this powerMonitor accepts',
  wakeEvents !== undefined &&
    TELEGRAM_WAKE_EVENTS.every((n) => (wakeEvents.armed as Record<string, boolean>)?.[n] === true),
  wakeEvents ? JSON.stringify(wakeEvents.armed) : 'no wake-events observation',
);

const installed = find(obs, 'installed');
record(
  '(f3) installing takes NO blocker — there is nothing listening yet',
  installed?.blockerHeldAtInstall === false && installed?.subscribed === 1,
  installed
    ? `held=${String(installed.blockerHeldAtInstall)} subscribers=${String(installed.subscribed)}`
    : 'no installed observation',
);

record(
  '(f4) all three wake handlers are attached to the real powerMonitor',
  (() => {
    if (!installed) return false;
    const before = installed.listenerCountBefore as Record<string, number>;
    const after = installed.listenerCountAfter as Record<string, number>;
    return TELEGRAM_WAKE_EVENTS.every((n) => (after?.[n] ?? 0) === (before?.[n] ?? 0) + 1);
  })(),
  installed
    ? `${JSON.stringify(installed.listenerCountBefore)} -> ${JSON.stringify(installed.listenerCountAfter)}`
    : 'no installed observation',
);

record(
  '(f5) the blocker is taken when the LISTENER starts, and taking it twice is a no-op',
  find(obs, 'listener-started')?.blockerHeld === true &&
    find(obs, 'listener-started-again')?.blockerHeld === true,
  `started=${String(find(obs, 'listener-started')?.blockerHeld)} again=${String(find(obs, 'listener-started-again')?.blockerHeld)}`,
);

const burst = find(obs, 'wake-burst');
record(
  '(f6) a three-event unlock burst on the REAL emitter produces ONE kick',
  Array.isArray(burst?.kicks) && (burst.kicks as string[]).length === 1,
  burst ? `kicks=${JSON.stringify(burst.kicks)}` : 'no wake-burst observation',
);

const later = find(obs, 'wake-later');
record(
  '(f7) a genuinely separate wake, past the window, still gets through',
  Array.isArray(later?.kicks) && (later.kicks as string[]).length === 2,
  later ? `kicks=${JSON.stringify(later.kicks)}` : 'no wake-later observation',
);

record(
  '(f8) the blocker is RELEASED when the listener stops (config off, Telegram disabled, quit)',
  find(obs, 'listener-stopped')?.blockerHeld === false,
  `held after stop=${String(find(obs, 'listener-stopped')?.blockerHeld)}`,
);

const disposed = find(obs, 'disposed');
record(
  '(f9) dispose releases a held blocker and detaches every wake handler',
  disposed?.heldBeforeDispose === true &&
    disposed?.blockerHeld === false &&
    disposed?.subscribedAfterDispose === 0 &&
    TELEGRAM_WAKE_EVENTS.every(
      (n) =>
        ((disposed.listenerCountAfterDispose as Record<string, number>)?.[n] ?? -1) ===
        (((installed?.listenerCountBefore as Record<string, number>) ?? {})[n] ?? -2),
    ),
  disposed
    ? `heldBefore=${String(disposed.heldBeforeDispose)} held=${String(disposed.blockerHeld)} counts=${JSON.stringify(disposed.listenerCountAfterDispose)}`
    : 'no disposed observation',
);

record(
  '(f10) a listener edge after teardown cannot resurrect the blocker',
  find(obs, 'after-dispose')?.blockerHeld === false,
  `held=${String(find(obs, 'after-dispose')?.blockerHeld)}`,
);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

let failed = 0;
console.log('\nSPIKE-TELEGRAM-POWER — Telegram keeps working while nobody is looking\n');
for (const c of checks) {
  if (!c.pass) failed += 1;
  console.log(`${c.pass ? 'PASS' : 'FAIL'} ${c.name}\n     ${c.evidence}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
if (failed > 0) {
  console.error(`\n${failed} assertion(s) FAILED`);
  process.exit(1);
}
console.log('\nOut of scope by agreement: lid-close sleep and power-off still stop the channel.');
