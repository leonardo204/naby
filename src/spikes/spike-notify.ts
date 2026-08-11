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
//
// Run: npm run spike:notify

import {
  NOTIFY_LABEL_MAX,
  asNotifyLocale,
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

const en = notificationCopy('session-done', 'en', 'Deploy prod');
const ko = notificationCopy('session-done', 'ko', '프로덕션 배포');
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
const blank = notificationCopy('session-done', 'en', '');
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
