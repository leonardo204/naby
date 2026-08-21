// src/spikes/spike-notify.ts
//
// SPIKE-NOTIFY — what an OS notification is allowed to say.
//
// WHY A SPIKE AND NOT A TEST OF THE BANNER. A banner cannot be verified
// headlessly: there is no notification centre, no daemon and no compositor in
// CI, and `Notification.isSupported()` is false in a process with no display.
// So the part that is DECIDABLE is separated (`electron/notification-copy.ts`
// imports nothing at all) and asserted here, while the wiring — the IPC channel,
// the preload shape, the renderer's mount point — is pinned by source assertions
// in the shell's `sessionDoneNotify.test.ts`.
//
// WHAT MATTERS ENOUGH TO PIN:
//
//   (a) THE RENDERER CANNOT AUTHOR A SENTENCE. Only a `kind` from the catalogue
//       becomes text; an unknown kind is refused rather than defaulted.
//   (b) THE LABEL IS TREATED AS HOSTILE. Newlines, control characters and bidi
//       overrides never reach an OS-drawn box with this app's name on it.
//   (c) BOTH LANGUAGES EXIST, and an unknown locale is English rather than blank.
//   (d) THE PILE-UP CANNOT COME BACK. Runs that finish while the user is away
//       accumulate into ONE banner carrying a count, that count reads like a
//       sentence a person wrote in both languages, and it resets only on
//       evidence the user saw it.
//   (e) THERE IS ONE LIVE NOTIFICATION. Asserted on the source of
//       `electron/notifications.ts`, because that file imports `electron` and
//       so cannot be loaded here — the same device the shell's
//       `sessionDoneNotify.test.ts` uses for facts no runtime check can reach.
//
// Run: npm run spike:notify

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NOTIFY_LABEL_MAX,
  NO_RUNS_FINISHED,
  addRunFinished,
  asNotifyCount,
  asNotifyLocale,
  hasRunsToReport,
  isNotifyKind,
  notificationCopy,
  sanitizeLabel,
} from '../../electron/notification-copy.js';

type Check = { name: string; pass: boolean; evidence: string };

const checks: Check[] = [];
function record(name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

// ---- (a) the renderer picks a message, it does not write one ---------------
record(
  '(a1) only the catalogue kind is accepted; anything else is refused, not defaulted',
  isNotifyKind('session-done') &&
    !isNotifyKind('anything-else') &&
    !isNotifyKind('') &&
    !isNotifyKind({ title: 'Your bank needs you' }),
  `session-done=${isNotifyKind('session-done')} other=${isNotifyKind('anything-else')}`,
);

const en = notificationCopy('session-done', 'en', 'Deploy prod', 1);
const ko = notificationCopy('session-done', 'ko', '프로덕션 배포', 1);
record(
  '(a2) the TITLE is fixed copy — a caller can never change what the banner is called',
  en.title === 'naby has an update' && ko.title === '나비가 알려드릴 게 있어요',
  `en="${en.title}" ko="${ko.title}"`,
);
record(
  '(a3) the label is the ONLY variable part of the body',
  en.body.includes('Deploy prod') && ko.body.includes('프로덕션 배포'),
  `en="${en.body}" ko="${ko.body}"`,
);
const blank = notificationCopy('session-done', 'en', '', 1);
record(
  '(a4) with no label the body still says something true rather than trailing off',
  blank.body.length > 0 && !blank.body.endsWith(': '),
  `"${blank.body}"`,
);

// ---- (b) the label is treated as hostile ----------------------------------
const injected = sanitizeLabel('Deploy prod\nYour password has expired — click here');
record(
  '(b1) a newline cannot add a second line to a box the OS draws with our name on it',
  !injected.includes('\n') && injected.startsWith('Deploy prod Your password'),
  `"${injected}"`,
);
const controls = sanitizeLabel('a\u0007b\u0000c\u001Bd\u202Ee');
record(
  '(b2) control characters and bidi overrides are stripped',
  !/[\u0000-\u001F\u007F-\u009F\u202A-\u202E]/.test(controls),
  `"${controls}"`,
);
const long = sanitizeLabel('x'.repeat(500));
record(
  '(b3) the label is truncated to a bounded length, by us rather than by the OS',
  long.length === NOTIFY_LABEL_MAX && long.endsWith('…'),
  `${long.length} chars (max ${NOTIFY_LABEL_MAX})`,
);
record(
  '(b4) a non-string label becomes an empty label instead of "[object Object]"',
  sanitizeLabel(undefined) === '' &&
    sanitizeLabel({ toString: () => 'sneaky' }) === '' &&
    sanitizeLabel(42) === '',
  `undefined="${sanitizeLabel(undefined)}" object="${sanitizeLabel({})}"`,
);
record(
  '(b5) a label of only whitespace collapses to empty, so the body uses its fallback',
  sanitizeLabel('   \n\t  ') === '',
  `"${sanitizeLabel('   \n\t  ')}"`,
);

// ---- (c) locales ----------------------------------------------------------
record(
  '(c1) an unknown locale falls back to English rather than to nothing',
  asNotifyLocale('ko') === 'ko' &&
    asNotifyLocale('en') === 'en' &&
    asNotifyLocale('fr') === 'en' &&
    asNotifyLocale(undefined) === 'en',
  `ko=${asNotifyLocale('ko')} fr=${asNotifyLocale('fr')} none=${asNotifyLocale(undefined)}`,
);
record(
  '(c2) the Korean copy is real Korean, not an English string in a ko slot',
  /[가-힣]/.test(ko.title) && /[가-힣]/.test(ko.body),
  `"${ko.title}" / "${ko.body}"`,
);

// ---- (d) the pile-up cannot come back ------------------------------------
//
// THE REPORT. The user talked to naby over Telegram from their phone, came back
// to the PC and found the same banner stacked ten deep — ten turns, ten endings,
// ten banners, all with identical text because they named one session. The cure
// is that runs accumulate into ONE banner carrying a count.

record(
  '(d1) one finished run reads like one finished run, in both languages',
  notificationCopy('session-done', 'en', 'Deploy prod', 1).body === 'Finished: Deploy prod' &&
    !/\b1\b/.test(notificationCopy('session-done', 'en', 'Deploy prod', 1).body) &&
    !/\b1\b/.test(notificationCopy('session-done', 'ko', '프로덕션 배포', 1).body),
  `en="${notificationCopy('session-done', 'en', 'Deploy prod', 1).body}" ko="${
    notificationCopy('session-done', 'ko', '프로덕션 배포', 1).body
  }"`,
);

const three = notificationCopy('session-done', 'en', 'Deploy prod', 3);
const threeKo = notificationCopy('session-done', 'ko', '프로덕션 배포', 3);
record(
  '(d2) several finished runs say HOW MANY, and name only the most recent',
  three.body.includes('3') &&
    three.body.includes('Deploy prod') &&
    !three.body.includes('1 conversations') &&
    threeKo.body.includes('3') &&
    threeKo.body.includes('프로덕션 배포'),
  `en="${three.body}" ko="${threeKo.body}"`,
);

const manyBlank = notificationCopy('session-done', 'en', '', 4);
record(
  '(d3) with no label a counted banner still says something true, not "latest: "',
  manyBlank.body.includes('4') && !manyBlank.body.includes('latest'),
  `"${manyBlank.body}"`,
);

record(
  '(d4) the TITLE stays fixed however many runs it stands for',
  notificationCopy('session-done', 'en', 'x', 9).title === en.title &&
    notificationCopy('session-done', 'ko', 'x', 9).title === ko.title,
  `"${notificationCopy('session-done', 'en', 'x', 9).title}"`,
);

// The accumulator itself: ten runs while the user is away are ONE banner saying
// ten, not ten banners.
let state = NO_RUNS_FINISHED;
record(
  '(d5) nothing has finished yet, so there is nothing to draw',
  !hasRunsToReport(state) && state.count === 0,
  `count=${state.count}`,
);
state = addRunFinished(state, 'Deploy prod');
const afterOne = state;
state = addRunFinished(state, 'Write the release notes');
state = addRunFinished(state, 'Check the logs');
record(
  '(d6) each finished run increments the count the ONE banner carries',
  afterOne.count === 1 && state.count === 3 && hasRunsToReport(state),
  `1 run -> ${afterOne.count}, 3 runs -> ${state.count}`,
);
record(
  '(d7) the newest label wins, because the copy calls it "latest"',
  state.label === 'Check the logs' && afterOne.label === 'Deploy prod',
  `latest="${state.label}"`,
);
record(
  '(d8) the reducer does not mutate what it was handed — the caller adopts it',
  afterOne.count === 1 && afterOne.label === 'Deploy prod',
  `earlier state still count=${afterOne.count} label="${afterOne.label}"`,
);
const reset = NO_RUNS_FINISHED;
record(
  '(d9) the reset drops the tally to zero, and the next run starts again at one',
  !hasRunsToReport(reset) && addRunFinished(reset, 'Deploy prod').count === 1,
  `after reset=${reset.count}, next=${addRunFinished(reset, 'Deploy prod').count}`,
);
record(
  '(d10) a run with no title counts, and falls back to counting rather than naming',
  addRunFinished(afterOne, '').count === 2 &&
    notificationCopy('session-done', 'en', addRunFinished(afterOne, '').label, 2).body.includes(
      '2',
    ),
  `"${notificationCopy('session-done', 'en', addRunFinished(afterOne, '').label, 2).body}"`,
);
record(
  '(d11) a count that is not a whole positive number never reaches an OS-drawn box',
  asNotifyCount(0) === 1 &&
    asNotifyCount(-4) === 1 &&
    asNotifyCount(Number.NaN) === 1 &&
    asNotifyCount(undefined) === 1 &&
    asNotifyCount(2.7) === 2 &&
    !notificationCopy('session-done', 'en', 'x', Number.NaN).body.includes('NaN'),
  `0->${asNotifyCount(0)} NaN->${asNotifyCount(Number.NaN)} 2.7->${asNotifyCount(2.7)}`,
);
record(
  '(d12) a hostile session title is still bounded and flattened when it is counted',
  (() => {
    const label = sanitizeLabel(`${'x'.repeat(500)}\nYour password has expired`);
    const body = notificationCopy('session-done', 'en', label, 7).body;
    return label.length === NOTIFY_LABEL_MAX && !body.includes('\n') && body.includes('7');
  })(),
  `"${notificationCopy('session-done', 'en', sanitizeLabel('a\nb'), 7).body}"`,
);

// ---- (e) exactly one live notification, asserted on the source -------------
//
// `electron/notifications.ts` imports `electron`, so it cannot be loaded in a
// bare tsx process. What matters about it is structural, and structure is
// readable.
const notificationsSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'electron', 'notifications.ts'),
  'utf8',
);

record(
  '(e1) there is exactly ONE place a notification is constructed',
  (notificationsSrc.match(/new Notification\(/g) ?? []).length === 1,
  `${(notificationsSrc.match(/new Notification\(/g) ?? []).length} construction site(s)`,
);
record(
  '(e2) the instance is RETAINED rather than dropped on the floor at show()',
  /live\s*=\s*notification/.test(notificationsSrc) &&
    /let live: Notification \| undefined/.test(notificationsSrc),
  'live holds the one instance',
);
const flushSrc = notificationsSrc.slice(notificationsSrc.indexOf('function flushRunsFinished'));
record(
  '(e3) the old banner is closed BEFORE the replacement is posted — they share an id, so the other order would delete the replacement',
  flushSrc.indexOf('closeLive()') < flushSrc.indexOf('new Notification(') &&
    flushSrc.indexOf('new Notification(') < flushSrc.indexOf('notification.show()'),
  `close@${flushSrc.indexOf('closeLive()')} < new@${flushSrc.indexOf(
    'new Notification(',
  )} < show@${flushSrc.indexOf('notification.show()')}`,
);
record(
  '(e4) every banner is posted under one fixed id, so the OS replaces instead of stacking',
  /RUNS_FINISHED_ID\s*=\s*'[^']+'/.test(notificationsSrc) &&
    /new Notification\(\{\s*id:\s*RUNS_FINISHED_ID/.test(notificationsSrc),
  'macOS UNNotificationRequest.identifier / Windows toast Tag',
);
record(
  '(e5) the same code runs on macOS and Windows — nothing branches on the platform',
  !notificationsSrc.includes('process.platform'),
  'no platform branch in notifications.ts',
);
record(
  '(e6) the count resets on window focus and on click, and NOT on dismissal',
  /app\.on\('browser-window-focus',\s*clearRunsFinished\)/.test(notificationsSrc) &&
    /on\('click',\s*\(\)\s*=>\s*\{\s*clearRunsFinished\(\)/.test(notificationsSrc) &&
    !/on\('close'/.test(notificationsSrc),
  'close fires on Windows system timeout too — that is not evidence the user saw it',
);
record(
  '(e7) the draw is debounced, so a burst is one banner rather than one redraw per run',
  /COALESCE_MS\s*=\s*\d+/.test(notificationsSrc) &&
    /setTimeout\(flushRunsFinished, COALESCE_MS\)/.test(notificationsSrc) &&
    /flushTimer\.unref\?\.\(\)/.test(notificationsSrc),
  `${notificationsSrc.match(/COALESCE_MS\s*=\s*(\d+)/)?.[1] ?? '?'}ms, unref'd so it never holds the app open`,
);

console.log('\n=== SPIKE-NOTIFY — what an OS notification is allowed to say ===\n');
let allPass = true;
for (const c of checks) {
  if (!c.pass) allPass = false;
  console.log(`[${c.pass ? 'PASS' : 'FAIL'}] ${c.name}`);
  console.log(`        evidence: ${c.evidence}`);
}
console.log(
  `\nSPIKE-NOTIFY: ${allPass ? 'ALL PASS' : 'FAILURES PRESENT'} (${
    checks.filter((c) => c.pass).length
  }/${checks.length})\n`,
);
process.exit(allPass ? 0 : 1);
