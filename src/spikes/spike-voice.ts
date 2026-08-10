// src/spikes/spike-voice.ts
//
// Phase 3 (P3-M14a) verification: THE NABY LAYER — specs/naby-voice-layer.md.
//
// The layer that rewrites naby's answers is also the layer that could break them,
// so this spike spends most of its checks on the REFUSALS: every way a rewrite can
// change something that carries meaning, and the fact that each of them is thrown
// away rather than shown. §2 principle 2 in executable form — "의심스러우면 원문을
// 낸다".
//
// Asserted, all against the REAL functions (nothing here is a model):
//   PROSE EXTRACTION (§5)
//     (a) Fences, inline code, URLs, paths and control markers are taken out
//         before any language or style judgement is made.
//   DEVIATION DETECTION (§5)
//     (b) Language, both directions: an English answer to a Korean user and a
//         Korean answer to an English user.
//     (c) Endings: an answer in the family the fingerprint says this user does not
//         use.
//     (d) Length: an answer whose sentences run several times the user's own.
//     (e) It ABSTAINS rather than guesses — too little prose, no fingerprint, a
//         fingerprint below the sample floor, too little of the user's own text,
//         and a matching answer.
//     (f) Priority: language outranks endings outranks length.
//   WHEN TO SPEND A CALL (§5)
//     (g) The stage table, every row, with and without the per-turn cap.
//   THE PROMPT (§2)
//     (h) It states the hard rules, carries the user's words, the deviation and
//         the style line, and never asks for anything but the rewritten body.
//   THE SAFETY NET (§6)
//     (i) A faithful rewrite passes.
//     (j) Every tamper is refused, by name: a changed code block, a dropped URL, a
//         changed number, a dropped path, a lost `[[DONE]]`, a summary, a sermon,
//         and an empty answer.
//   THE TURN RUNNER'S ONE-SLOT DELAY (§4.1)
//     (k) NO PORT = byte-for-byte the old turn: identical events, identical
//         transcript.
//     (l) Only the LAST assistant block is offered; text followed by a tool call
//         is not.
//     (m) What the caller streamed, what the events array holds and what the store
//         kept are the SAME text.
//     (n) An aborted turn is never held up for a rewrite: the port is not called,
//         the held block reaches NEITHER the caller nor the store, and it is
//         written to the activity log instead (§2 principle 3 — what is shown and
//         what is kept are the same thing).
//     (o) A port that answers with nothing cannot empty an answer.
//
// P3-M14a REVIEW REGRESSIONS (each one reproduces a defect the code review
// demonstrated, and each was watched to FAIL before the fix landed):
//   (p) An explicit language request is never undone — "번역해줘" and "commit
//       message in English" produce no `language` deviation.
//   (q) A pasted English stack trace cannot flip the user's language: the user's
//       side is judged by how much Hangul is THERE, not by its share.
//   (r) The invariants actually hold: `v20`, a commit hash, a sign, a percentage,
//       an email, a bare filename, a flipped negation, a dropped list item, a
//       ticked checkbox, a lost table row — every one refused.
//   (s) Endings: a tie reads as formal, headings and bullets are not sentences,
//       and an answer under three sentences is not shaped at all.
//   (t) The per-turn cap is a HARD cap: past it nothing buys another call.
//   (u) Paths: Korean prose, a leading paren, markdown bold and a date are not
//       file paths.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { activityLogFile } from '../runtime/activity-log.js';
import type {
  Engine,
  EngineEvent,
  EngineRunInput,
  VoicePort,
  VoiceRenderRequest,
} from '../runtime/engine.js';
import { runTurn } from '../runtime/session.js';
import { MemoryStore } from '../runtime/store/memory-store.js';
import type { StyleFingerprint } from '../runtime/style-fingerprint.js';
import {
  buildVoicePrompt,
  detectVoiceDeviation,
  extractInvariants,
  shouldRestyle,
  stripNonProse,
  verifyVoiceRewrite,
  voiceRewriteMode,
  VOICE_MIN_PROSE_CHARS,
  VOICE_TIMEOUT_MS,
  VOICE_TURN_REWRITE_CAP,
  type VoiceDeviation,
} from '../runtime/voice.js';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A profile of somebody who writes short, plain `~다` Korean — the project's own
 *  house style, and well past the sample floor so it is allowed to shape a turn. */
const FORMAL_SHORT: StyleFingerprint = {
  sampleCount: 60,
  sentenceCount: 240,
  avgSentenceChars: 30,
  endings: { formal: 0.7, polite: 0.1, fragment: 0.2 },
  questionRatio: 0.2,
  listRatio: 0.1,
  computedAt: 1_700_000_000_000,
};

/** The same person, one sample short of being describable. */
const TOO_FEW_SAMPLES: StyleFingerprint = { ...FORMAL_SHORT, sampleCount: 19 };

const KOREAN_USER = '이 프로젝트에서 세션 스토어를 어디에 두는 게 좋을지 알려줘.';
const ENGLISH_USER = 'Tell me where the session store should live in this project.';

const KOREAN_ANSWER =
  '세션 스토어는 런타임에 둔다. 프로바이더를 바꿔도 남아야 하는 코드이기 때문이다. 셸은 HTTP 액션만 맡는다.';
const ENGLISH_ANSWER =
  'The session store belongs in the runtime, because it has to survive a provider swap. ' +
  'The shell only owns the HTTP action that reaches it.';

// ---------------------------------------------------------------------------
// (a) prose extraction
// ---------------------------------------------------------------------------

function checkProseExtraction(): void {
  const source = [
    '설정은 여기에 있다.',
    '```ts',
    'const store = new SqliteStore(path);',
    '```',
    '`NABY_DB_PATH` 를 https://example.com/docs 문서대로 src/runtime/store/sqlite-store.ts 에 맞춘다.',
    '[[DONE]]',
  ].join('\n');
  const prose = stripNonProse(source);
  const gone = ['SqliteStore', 'NABY_DB_PATH', 'https://', 'sqlite-store.ts', '[[DONE]]'];
  const survived = prose.includes('설정은 여기에 있다') && prose.includes('문서대로');
  const removed = gone.filter((needle) => !prose.includes(needle));
  record(
    '(a) stripNonProse leaves prose and nothing else',
    removed.length === gone.length && survived,
    `removed ${removed.length}/${gone.length} non-prose forms; prose = ${JSON.stringify(prose)}`,
  );
}

// ---------------------------------------------------------------------------
// (b)-(f) deviation detection
// ---------------------------------------------------------------------------

function detect(
  answer: string,
  userText: string,
  fingerprint?: StyleFingerprint,
): VoiceDeviation | undefined {
  return detectVoiceDeviation({
    answer,
    userText,
    ...(fingerprint ? { fingerprint } : {}),
  });
}

function checkLanguage(): void {
  const englishToKorean = detect(ENGLISH_ANSWER, KOREAN_USER);
  const koreanToEnglish = detect(KOREAN_ANSWER, ENGLISH_USER);
  record(
    '(b) language deviation is detected in BOTH directions, with no fingerprint at all',
    englishToKorean === 'language' && koreanToEnglish === 'language',
    `english-answer/korean-user = ${englishToKorean}, korean-answer/english-user = ${koreanToEnglish}`,
  );

  const matched = detect(KOREAN_ANSWER, KOREAN_USER, FORMAL_SHORT);
  record(
    '(e1) an answer in the user\'s own language and register is NOT a deviation',
    matched === undefined,
    `verdict = ${matched}`,
  );
}

function checkEndings(): void {
  // Same content, same language, polite endings — the family this fingerprint says
  // the user does not use.
  const polite =
    '세션 스토어는 런타임에 두는 게 좋아요. 프로바이더를 바꿔도 남아야 하니까요. 셸은 HTTP 액션만 맡아요.';
  const verdict = detect(polite, KOREAN_USER, FORMAL_SHORT);
  record(
    '(c) endings deviation: a polite answer to a plain-~다 writer',
    verdict === 'endings',
    `verdict = ${verdict} (fingerprint prefers formal ${FORMAL_SHORT.endings.formal})`,
  );

  const withoutFingerprint = detect(polite, KOREAN_USER);
  const belowFloor = detect(polite, KOREAN_USER, TOO_FEW_SAMPLES);
  record(
    '(e2) no fingerprint — and one below the sample floor — judge no endings at all',
    withoutFingerprint === undefined && belowFloor === undefined,
    `no-fingerprint = ${withoutFingerprint}, sampleCount=${TOO_FEW_SAMPLES.sampleCount} = ${belowFloor}`,
  );
}

function checkLength(): void {
  // Plain `~다`, correct language, but sentences four times the user's own.
  //
  // THREE sentences, not two: since the review fix an answer under
  // `MIN_SENTENCES_FOR_SHAPE` prose sentences has its shape left alone, because
  // two sentences are a fact about two sentences.
  const long =
    '세션 스토어를 런타임에 두는 이유는 프로바이더를 교체하더라도 스키마와 드라이버가 그대로 남아야 하고 ' +
    '셸이 사라지더라도 데이터가 살아남아야 하기 때문이며 이것이 이 프로젝트의 계층 규칙이 말하는 유일한 판단 기준이다. ' +
    '셸은 HTTP 액션과 어댑터와 UI만 맡고 그 밖의 어떤 상태도 직접 소유하지 않으며 검증은 vitest로 하고 ' +
    '런타임의 검증은 스파이크로 하는 식으로 두 트리의 책임이 갈린다. ' +
    '이 규칙을 지키면 프로바이더를 바꾸는 작업이 스토어의 스키마를 건드리지 않고 끝나며 셸을 새로 쓰더라도 ' +
    '데이터와 정책은 그대로 남기 때문에 두 트리를 따로 검증하는 비용이 회수된다.';
  const verdict = detect(long, KOREAN_USER, FORMAL_SHORT);
  record(
    '(d) length deviation: sentences several times the fingerprint average',
    verdict === 'length',
    `verdict = ${verdict} (fingerprint avg ${FORMAL_SHORT.avgSentenceChars} chars)`,
  );
}

function checkAbstains(): void {
  // Below the prose floor: a short acknowledgement in the wrong language is not
  // evidence of anything.
  const short = 'Done.';
  const shortVerdict = detect(short, KOREAN_USER, FORMAL_SHORT);
  record(
    `(e3) prose under ${VOICE_MIN_PROSE_CHARS} chars is never judged`,
    shortVerdict === undefined,
    `answer ${JSON.stringify(short)} -> ${shortVerdict}`,
  );

  // An answer that is only code and a path has no surface to correct.
  const codeOnly = ['```sh', 'npm run build:app && npm run spike:voice', '```'].join('\n');
  const codeVerdict = detect(codeOnly, KOREAN_USER, FORMAL_SHORT);
  record(
    '(e4) an answer that is only code is never judged',
    codeVerdict === undefined,
    `prose length = ${stripNonProse(codeOnly).length} -> ${codeVerdict}`,
  );

  // Too little of the USER's own text: "ok" from a Korean writer must not
  // translate their answer into English.
  const thinUser = detect(KOREAN_ANSWER, 'ok', FORMAL_SHORT);
  record(
    '(e5) a two-letter user turn cannot decide the language of an answer',
    thinUser === undefined,
    `user "ok" + korean answer -> ${thinUser}`,
  );
}

function checkPriority(): void {
  // English, polite-less, and enormously long sentences: all three rules would
  // fire, and exactly one answer comes back.
  const englishLong =
    'The session store belongs in the runtime because everything that must outlive a provider swap ' +
    'belongs there, and the shell should own nothing more than the HTTP action, the engine adapter ' +
    'and the user interface that reaches them, which is the only rule this project applies when it ' +
    'decides which of the two trees a new file goes into.';
  const verdict = detect(englishLong, KOREAN_USER, FORMAL_SHORT);
  record(
    '(f) one verdict, in priority order: language outranks endings and length',
    verdict === 'language',
    `verdict = ${verdict}`,
  );
}

// ---------------------------------------------------------------------------
// (p) an explicit language request is never undone  [review defect 1]
// ---------------------------------------------------------------------------

function checkLanguageDirective(): void {
  // THE BUG. "translate this into English" → an English answer → a `language`
  // deviation → the layer translates it back into Korean, i.e. the one thing the
  // user asked for is the one thing that gets undone.
  const cases: { name: string; user: string; answer: string }[] = [
    {
      name: '번역 요청',
      user: '아래 문단을 영어로 번역해줘. 문장 순서는 그대로 두고.',
      answer: ENGLISH_ANSWER,
    },
    {
      name: 'in English',
      user: 'Summarise the layering rule in English, please. 한 문단이면 된다.',
      answer: ENGLISH_ANSWER,
    },
    {
      name: '커밋 메시지 (this repo writes them in English)',
      user: '방금 고친 내용으로 커밋 메시지 하나 써줘.',
      answer:
        'Fix the voice layer so an explicit language request is never reverted. ' +
        'The suppressor runs before the language rule and the prompt states the same thing.',
    },
  ];
  const verdicts = cases.map((c) => ({ ...c, verdict: detect(c.answer, c.user, FORMAL_SHORT) }));
  const quiet = verdicts.filter((v) => v.verdict !== 'language');
  record(
    '(p1) an explicit language request suppresses the language rule entirely',
    quiet.length === cases.length,
    verdicts.map((v) => `${v.name} -> ${v.verdict}`).join('; '),
  );

  // The control: the SAME English answer, to a user who asked for nothing of the
  // kind, is still a deviation. Without this the check above would pass on a
  // detector that had simply stopped working.
  const control = detect(ENGLISH_ANSWER, KOREAN_USER, FORMAL_SHORT);
  record(
    '(p2) …and an English answer to a Korean user who asked for no such thing is STILL a deviation',
    control === 'language',
    `verdict = ${control}`,
  );

  // THE PROMPT SAYS THE SAME THING (second review, fix 5). A style-mode call — the
  // always-on pupa/butterfly rewrite, and every turn where the user named a
  // language — is told not to change the language AT ALL. The old prompt told every
  // call to "write in the language the USER wrote in", which on a commit-message
  // turn is an instruction to translate the thing the user asked for in English.
  const prompt = buildVoicePrompt({ answer: ENGLISH_ANSWER, userText: KOREAN_USER });
  const states =
    /DO NOT CHANGE THE LANGUAGE OF THE ANSWER/.test(prompt.system) &&
    /commit message/i.test(prompt.system) &&
    !/Render the answer in the language the USER wrote in/.test(prompt.system);
  record(
    '(p3) a style-mode prompt forbids changing the language outright, and names the by-convention artefacts',
    states,
    `system states the prohibition = ${states}`,
  );

  // …and the language-mode prompt says the opposite, because that call's whole job
  // is the change the other one forbids.
  const translating = buildVoicePrompt({
    answer: ENGLISH_ANSWER,
    userText: KOREAN_USER,
    deviation: 'language',
    mode: 'language',
  });
  const asksForTranslation =
    /Render the answer in the language the USER wrote in/.test(translating.system) &&
    !/DO NOT CHANGE THE LANGUAGE/.test(translating.system);
  record(
    '(p4) …while the language-mode prompt asks for exactly that change and nothing else',
    asksForTranslation,
    `language-mode system asks for the rendering = ${asksForTranslation}`,
  );
}

// ---------------------------------------------------------------------------
// (q) a pasted stack trace cannot flip the user's language  [review defect 2]
// ---------------------------------------------------------------------------

function checkPastedLog(): void {
  // A real turn: eight Hangul characters of question, three hundred Latin
  // characters of pasted stack trace, no fence. By RATIO this user "writes
  // English", so a Korean answer was being translated into English.
  const user = [
    '이거 왜 터지는지 봐줘',
    'TypeError: Cannot read properties of undefined (reading \'stage\')',
    '    at createVoicePort (packages/feature/agent/src/server/lib/voice.ts:305:21)',
    '    at Object.render (packages/feature/agent/src/server/lib/voice.ts:337:13)',
    '    at releaseHeldRestyled (src/runtime/session.ts:425:17)',
    '    at async runTurn (src/runtime/session.ts:746:3)',
  ].join('\n');
  const koreanAnswer = detect(KOREAN_ANSWER, user, FORMAL_SHORT);
  const englishAnswer = detect(ENGLISH_ANSWER, user, FORMAL_SHORT);
  record(
    '(q1) a Korean question with a pasted English stack trace is a KOREAN user',
    koreanAnswer !== 'language' && englishAnswer === 'language',
    `korean answer -> ${koreanAnswer}, english answer -> ${englishAnswer}`,
  );

  // The floor still holds on the other side: a genuinely English user is still an
  // English user, and a two-word acknowledgement still decides nothing.
  const english = detect(KOREAN_ANSWER, ENGLISH_USER, FORMAL_SHORT);
  const thin = detect(KOREAN_ANSWER, 'ok', FORMAL_SHORT);
  record(
    '(q2) …and the absolute rule did not break the English side or the abstain floor',
    english === 'language' && thin === undefined,
    `english user -> ${english}, "ok" -> ${thin}`,
  );
}

// ---------------------------------------------------------------------------
// (s) the shape rules  [review defect 4]
// ---------------------------------------------------------------------------

function checkShapeRules(): void {
  // THE BUG. `dominantEnding` started at `fragment` and compared with `>`, so a
  // one-formal / one-fragment answer read as `fragment` — and `splitSentences`
  // breaks on every newline, so a markdown heading and three bullets were four
  // "fragment sentences". An ordinary answer therefore read as the wrong register
  // and bought a rewrite.
  // The bullets end in NOUNS, which is what a list actually looks like — so
  // classified as sentences they are three `fragment`s against three `formal`s,
  // the exact tie the old `>` comparison handed to `fragment`.
  const structured = [
    '## 결론',
    '',
    '- 런타임: 스토어와 게이트',
    '- 셸: HTTP 액션과 UI',
    '',
    '프로바이더를 바꿔도 남아야 하는 코드이기 때문이다. 이 규칙은 두 트리에 모두 적용된다. 예외는 없다.',
  ].join('\n');
  const verdict = detect(structured, KOREAN_USER, FORMAL_SHORT);
  record(
    '(s1) headings and bullets are not sentences: a plain-~다 answer with a list is not an ending deviation',
    verdict !== 'endings',
    `verdict = ${verdict}`,
  );

  // A table is structure too — and its rows would otherwise be counted as very
  // long `fragment` sentences, which moves both the register and the average
  // length. Asserted as an INVARIANCE: the same prose with and without the table
  // must reach the same verdict, which is exactly the claim "the table shapes
  // nothing" and cannot pass by accident of what that verdict happens to be.
  const prose = '판단 기준은 하나다. 프로바이더를 바꿔도 남아야 하면 런타임이다. 나머지는 셸이다.';
  const table = [
    '| 레이어 | 책임 |',
    '| --- | --- |',
    '| 런타임 | 스토어와 게이트를 소유한다 |',
    '| 셸 | HTTP 액션과 UI를 맡는다 |',
    '',
    prose,
  ].join('\n');
  const tableVerdict = detect(table, KOREAN_USER, FORMAL_SHORT);
  const proseVerdict = detect(`${prose} 예외는 두지 않는다.`, KOREAN_USER, FORMAL_SHORT);
  const proseOnly = detect(prose, KOREAN_USER, FORMAL_SHORT);
  record(
    '(s2) a table is structure, not prose — its rows shape nothing',
    tableVerdict === proseOnly && tableVerdict !== 'endings',
    `with table = ${tableVerdict}, prose alone = ${proseOnly}, longer prose = ${proseVerdict}`,
  );

  // Under three prose sentences nothing about the shape is judged at all.
  const twoSentences = '세션 스토어는 런타임에 둔다. 프로바이더를 바꿔도 남아야 하는 코드이기 때문이다.';
  const shortVerdict = detect(twoSentences, KOREAN_USER, FORMAL_SHORT);
  record(
    '(s3) two sentences are a fact about two sentences: no endings and no length verdict',
    shortVerdict === undefined,
    `verdict = ${shortVerdict}`,
  );
}

// ---------------------------------------------------------------------------
// (u) what is and is not a path  [review defect 10]
// ---------------------------------------------------------------------------

function checkPaths(): void {
  const korean = '읽기/쓰기 권한을 먼저 확인한다. 그 다음에 스토어를 연다. 순서를 바꾸면 실패한다.';
  const prose = stripNonProse(korean);
  const keptKorean = prose.includes('읽기/쓰기');
  const koreanPaths = extractInvariants(korean).paths;
  record(
    '(u1) a Korean word pair with a slash is prose, not a path',
    keptKorean && koreanPaths.length === 0,
    `prose = ${JSON.stringify(prose)}, paths = ${JSON.stringify(koreanPaths)}`,
  );

  // The same path, wearing four different bits of punctuation. All four must
  // extract to the SAME token, or a rewrite that merely moved the emphasis is
  // refused as "a path changed".
  const forms = ['src/a.ts', '(src/a.ts', '**src/a.ts**', '`src/a.ts`,'];
  const extracted = forms.map((f) => extractInvariants(`이 파일 ${f} 를 본다.`).paths.join('|'));
  const allSame = extracted.every((p) => p === 'src/a.ts');
  record(
    '(u2) a leading paren and markdown emphasis are stripped symmetrically',
    allSame,
    `${forms.map((f, i) => `${f} -> ${JSON.stringify(extracted[i])}`).join('; ')}`,
  );

  const dated = extractInvariants('마지막 업데이트: 2026/08/10 이다.');
  record(
    '(u3) a date is not a path (its digits are still protected as numbers)',
    dated.paths.length === 0 && dated.numbers.length > 0,
    `paths = ${JSON.stringify(dated.paths)}, numbers = ${JSON.stringify(dated.numbers)}`,
  );

  // End to end: an honest rewrite of a sentence carrying all three is ACCEPTED.
  const before = '읽기/쓰기 순서는 **src/a.ts** 에 있다. 날짜는 2026/08/10 이다. 확인해라.';
  const after = '읽기/쓰기 순서는 **src/a.ts** 에 적혀 있다. 날짜는 2026/08/10 이다. 확인해 보라.';
  const verdict = verifyVoiceRewrite(before, after, STYLE_MODE);
  record(
    '(u4) …so an honest rewrite carrying all three is accepted, not refused',
    verdict.ok === true,
    `verdict = ${JSON.stringify(verdict)}`,
  );
}

// ---------------------------------------------------------------------------
// (g) the stage table
// ---------------------------------------------------------------------------

function checkStageTable(): void {
  const rows: { stage: 'egg' | 'larva' | 'pupa' | 'butterfly' | undefined; expected: boolean }[] = [
    { stage: 'egg', expected: false },
    { stage: 'larva', expected: false },
    { stage: 'pupa', expected: true },
    { stage: 'butterfly', expected: true },
    { stage: undefined, expected: false },
  ];
  const noDeviation = rows.every(
    (row) => shouldRestyle({ stage: row.stage, deviation: undefined, capReached: false }) === row.expected,
  );
  const withDeviation = rows.every(
    (row) => shouldRestyle({ stage: row.stage, deviation: 'language', capReached: false }) === true,
  );
  record(
    '(g1) stage table: pupa and butterfly always, egg/larva/unknown only on a deviation',
    noDeviation && withDeviation,
    `no-deviation row match = ${noDeviation}, every stage restyles a measured deviation = ${withDeviation}`,
  );

  // THE CAP IS A HARD CAP (review defect 9). It used to fall back to "only on a
  // measured deviation", which is not a cap at all: `length` fires on almost any
  // step, so a twenty-step run could buy twenty calls while reporting that it had
  // stopped at three.
  const cappedClean = rows.every(
    (row) => shouldRestyle({ stage: row.stage, deviation: undefined, capReached: true }) === false,
  );
  const cappedDirty = rows.every(
    (row) => shouldRestyle({ stage: row.stage, deviation: 'endings', capReached: true }) === false,
  );
  const cappedLanguage = rows.every(
    (row) => shouldRestyle({ stage: row.stage, deviation: 'language', capReached: true }) === false,
  );
  record(
    `(t) the ${VOICE_TURN_REWRITE_CAP}-call cap is a HARD cap — past it no stage and no deviation buys a call`,
    cappedClean && cappedDirty && cappedLanguage,
    `capped+clean = ${cappedClean}, capped+endings = ${cappedDirty}, capped+language = ${cappedLanguage}`,
  );
}

// ---------------------------------------------------------------------------
// (h) the prompt
// ---------------------------------------------------------------------------

function checkPrompt(): void {
  const styleLine = 'Observed writing style of this user: writes short sentences.';
  const prompt = buildVoicePrompt({
    answer: ENGLISH_ANSWER,
    userText: KOREAN_USER,
    styleLine,
    deviation: 'language',
    mode: 'language',
  });
  const systemRules = [
    'Do not add facts',
    'CHARACTER FOR CHARACTER',
    'markdown structure',
    'language the USER wrote in',
    'no preamble',
  ];
  const missing = systemRules.filter((rule) => !prompt.system.includes(rule));
  const userHas =
    prompt.user.includes(KOREAN_USER) &&
    prompt.user.includes(ENGLISH_ANSWER) &&
    prompt.user.includes(styleLine) &&
    prompt.user.includes('not in the language the user wrote in');
  record(
    '(h) the prompt states every hard rule and carries the words, the deviation and the style line',
    missing.length === 0 && userHas,
    `missing system rules = ${JSON.stringify(missing)}, user half complete = ${userHas}`,
  );
}

// ---------------------------------------------------------------------------
// (i)-(j) the safety net
// ---------------------------------------------------------------------------

/** An answer with one of everything the layer must not touch. */
const RICH_ANSWER = [
  'The store lives in the runtime. Run it like this:',
  '',
  '```sh',
  'NABY_DB_PATH=/tmp/app.db npm run spike:voice',
  '```',
  '',
  'It writes 3 rows, reads `app.db` from src/runtime/store/, and the notes are at https://example.com/x.',
  '[[DONE]]',
].join('\n');

function checkVerifier(): void {
  const faithful = [
    '스토어는 런타임에 있다. 이렇게 실행한다:',
    '',
    '```sh',
    'NABY_DB_PATH=/tmp/app.db npm run spike:voice',
    '```',
    '',
    '행 3개를 쓰고 src/runtime/store/ 에서 `app.db` 를 읽는다. 설명은 https://example.com/x 에 있다.',
    '[[DONE]]',
  ].join('\n');
  // A TRANSLATION, so it is checked the way its caller would check it: the
  // deviation that bought this call was `language`, and the user writes Korean.
  const ok = verifyVoiceRewrite(RICH_ANSWER, faithful, languageMode('korean'));
  record(
    '(i) a faithful rewrite — same code, same path, same number, same URL, same marker — passes',
    ok.ok === true,
    `verdict = ${JSON.stringify(ok)}`,
  );

  const tampers: { name: string; text: string; reason: string }[] = [
    {
      name: 'a retyped code block (one flag changed)',
      text: faithful.replace('npm run spike:voice', 'npm run spike:voices'),
      reason: 'a code block changed',
    },
    {
      name: 'a dropped URL',
      text: faithful.replace(' 설명은 https://example.com/x 에 있다.', ''),
      reason: 'a URL changed',
    },
    { name: 'a changed number', text: faithful.replace('행 3개', '행 4개'), reason: 'a number changed' },
    {
      name: 'a dropped path',
      text: faithful.replace('src/runtime/store/ 에서 ', ''),
      reason: 'a path changed',
    },
    {
      name: 'a lost [[DONE]] marker',
      text: faithful.replace('[[DONE]]', ''),
      reason: 'a control marker changed',
    },
    {
      name: 'inline code that became prose',
      text: faithful.replace('`app.db`', 'app.db'),
      reason: 'inline code changed',
    },
  ];
  // The REASON is asserted too, not just the refusal: a base rewrite that failed
  // for an unrelated invariant would refuse every tamper on the same line and the
  // check would pass without testing anything.
  const verdicts = tampers.map((t) => ({
    ...t,
    verdict: verifyVoiceRewrite(RICH_ANSWER, t.text, languageMode('korean')),
  }));
  const refused = verdicts.filter((v) => v.verdict.ok === false && v.verdict.reason === v.reason);
  record(
    '(j1) every invariant tamper is refused, each for its OWN reason',
    refused.length === tampers.length,
    verdicts
      .map((v) => `${v.name}: ${v.verdict.ok ? 'ACCEPTED' : `refused (${v.verdict.reason})`}`)
      .join('; '),
  );

  // Length: a summary and a sermon, both with the invariants intact so that ONLY
  // the ratio can be what refuses them.
  const plain = 'The store lives in the runtime and the shell owns the HTTP action that reaches it.';
  const summary = 'Runtime.';
  const sermon = `${plain} ${plain} ${plain} ${plain}`;
  const summaryVerdict = verifyVoiceRewrite(plain, summary, STYLE_MODE);
  const sermonVerdict = verifyVoiceRewrite(plain, sermon, STYLE_MODE);
  const emptyVerdict = verifyVoiceRewrite(plain, '   ', STYLE_MODE);
  record(
    '(j2) the length ratio refuses a summary and a sermon, and an empty rewrite is never adopted',
    summaryVerdict.ok === false && sermonVerdict.ok === false && emptyVerdict.ok === false,
    `summary ${(summary.length / plain.length).toFixed(2)}x -> ${JSON.stringify(summaryVerdict)}; ` +
      `sermon ${(sermon.length / plain.length).toFixed(2)}x -> ${JSON.stringify(sermonVerdict)}; ` +
      `empty -> ${JSON.stringify(emptyVerdict)}`,
  );

  const invariants = extractInvariants(RICH_ANSWER);
  record(
    '(j3) the invariants are extracted as multisets, sorted, so a moved sentence is still a match',
    invariants.codeBlocks.length === 1 &&
      invariants.urls.length === 1 &&
      invariants.markers.length === 1 &&
      invariants.paths.length >= 1 &&
      invariants.numbers.length >= 1 &&
      invariants.inlineCode.length === 1,
    `code=${invariants.codeBlocks.length} inline=${invariants.inlineCode.length} url=${invariants.urls.length} ` +
      `path=${invariants.paths.length} num=${invariants.numbers.length} marker=${invariants.markers.length}`,
  );
}

// ---------------------------------------------------------------------------
// (r) the invariants that were not actually invariant  [review defect 3]
// ---------------------------------------------------------------------------

/**
 * Every tamper the review demonstrated PASSING, each as a minimal pair.
 *
 * MINIMAL, and that is the point: the two texts differ in exactly one respect, so
 * a refusal can only come from the rule under test. A big fixture with one changed
 * character would be refused by whichever rule happened to fire first and would
 * prove nothing about the one being asserted.
 */
function checkInvariantTampers(): void {
  const pairs: { name: string; before: string; after: string; reason: string }[] = [
    {
      name: 'a version suffix (Node v20 → v18)',
      before: '테스트는 Node v20에서 돌린다. 더 낮은 버전은 지원하지 않는다. 먼저 확인해라.',
      after: '테스트는 Node v18에서 돌린다. 더 낮은 버전은 지원하지 않는다. 먼저 확인해라.',
      reason: 'a number changed',
    },
    {
      name: 'one character of a commit hash',
      before: '커밋 9f8e7d6 에서 갈라졌다. 그 앞은 그대로다. 되돌릴 필요는 없다.',
      after: '커밋 9f8e7d5 에서 갈라졌다. 그 앞은 그대로다. 되돌릴 필요는 없다.',
      reason: 'a number changed',
    },
    {
      name: 'a lost minus sign',
      before: '차이는 -5 다. 기준선보다 낮다는 뜻이다. 원인을 찾아라.',
      after: '차이는 5 다. 기준선보다 낮다는 뜻이다. 원인을 찾아라.',
      reason: 'a number changed',
    },
    {
      name: 'a dropped unit (12% → 12)',
      before: '커버리지는 12% 다. 목표에는 못 미친다. 더 올려라.',
      after: '커버리지는 12 다. 목표에는 못 미친다. 더 올려라.',
      reason: 'a number changed',
    },
    {
      name: 'a retyped email address',
      before: '문의는 zerolive@altimedia.com 으로 보낸다. 답장은 하루 안에 온다. 급하면 전화해라.',
      after: '문의는 zerolife@altimedia.com 으로 보낸다. 답장은 하루 안에 온다. 급하면 전화해라.',
      reason: 'an email address changed',
    },
    {
      name: 'a bare filename with no separator (config.yaml → config.yml)',
      before: '설정은 config.yaml 에 둔다. 다른 파일은 읽지 않는다. 이름을 바꾸지 마라.',
      after: '설정은 config.yml 에 둔다. 다른 파일은 읽지 않는다. 이름을 바꾸지 마라.',
      reason: 'a file name changed',
    },
    {
      name: 'a flipped negation (실행하지 마라 → 실행하라)',
      before: '이 스크립트는 실행하지 마라. 데이터가 지워진다. 백업부터 확인해라.',
      after: '이 스크립트는 실행하라고 한다. 데이터가 지워진다. 백업부터 확인해라.',
      reason: 'a negation was added or dropped',
    },
    {
      name: 'a dropped list item',
      before: '순서는 이렇다.\n- 스토어를 연다\n- 게이트를 건다\n- 턴을 돌린다',
      after: '순서는 이렇다.\n- 스토어를 연다\n- 턴을 돌린다',
      reason: 'a list item was added or dropped',
    },
    {
      name: 'a ticked checkbox',
      before: '남은 일이다.\n- [ ] 스파이크 추가\n- [ ] 셸 테스트 추가\n- [x] 타입체크',
      after: '남은 일이다.\n- [x] 스파이크 추가\n- [ ] 셸 테스트 추가\n- [x] 타입체크',
      reason: 'a checkbox changed',
    },
    {
      name: 'a lost table row',
      before: '| 레이어 | 책임 |\n| --- | --- |\n| 런타임 | 스토어 |\n| 셸 | UI |',
      after: '| 레이어 | 책임 |\n| --- | --- |\n| 런타임 | 스토어 |',
      reason: 'a table row was added or dropped',
    },
    {
      name: 'a whole sentence deleted (same language)',
      before:
        '세션 스토어는 런타임에 둔다. 프로바이더를 바꿔도 남아야 하기 때문이다. 셸은 HTTP 액션만 맡는다. 검증은 스파이크로 한다.',
      after: '세션 스토어는 런타임에 둔다. 셸은 HTTP 액션만 맡는다.',
      reason: 'ratio',
    },
  ];

  // ALL SAME-LANGUAGE, so all of them are checked in the mode a same-language
  // rewrite is called in.
  const verdicts = pairs.map((p) => ({
    ...p,
    verdict: verifyVoiceRewrite(p.before, p.after, STYLE_MODE),
  }));
  const refused = verdicts.filter(
    (v) =>
      v.verdict.ok === false &&
      (v.reason === 'ratio' ? v.verdict.reason.includes('too short') : v.verdict.reason === v.reason),
  );
  record(
    '(r1) every tamper the review demonstrated is now refused, each for its OWN reason',
    refused.length === pairs.length,
    verdicts
      .map((v) => `${v.name}: ${v.verdict.ok ? 'ACCEPTED' : `refused (${v.verdict.reason})`}`)
      .join('; '),
  );

  // THE OTHER HALF, and the reason the ratio is not simply tightened everywhere: a
  // faithful TRANSLATION is half the characters of its English original, and
  // refusing it would kill the deviation the layer exists to fix. The bound is
  // tight WITHIN a language and loose ACROSS one, which is the only split that
  // makes both statements true.
  const translated = verifyVoiceRewrite(ENGLISH_ANSWER, KOREAN_ANSWER, languageMode('korean'));
  record(
    '(r2) …while a faithful translation, which is legitimately much shorter, is still accepted',
    translated.ok === true,
    `${(KOREAN_ANSWER.length / ENGLISH_ANSWER.length).toFixed(2)}x -> ${JSON.stringify(translated)}`,
  );

  // A same-language rewrite that only reorders and rephrases keeps every count.
  const before = '남은 일이다.\n- [ ] 스파이크 추가\n- [ ] 셸 테스트 추가\n\n| 레이어 | 책임 |\n| --- | --- |\n| 런타임 | 스토어 |';
  const after = '남은 작업이다.\n- [ ] 스파이크를 추가한다\n- [ ] 셸 테스트를 추가한다\n\n| 레이어 | 책임 |\n| --- | --- |\n| 런타임 | 스토어 |';
  const honest = verifyVoiceRewrite(before, after, STYLE_MODE);
  record(
    '(r3) …and an honest restyle of the same list and table is accepted',
    honest.ok === true,
    `verdict = ${JSON.stringify(honest)}`,
  );
}

// ---------------------------------------------------------------------------
// (v) THE TWO VERIFICATION MODES  [second review, defect 1]
// ---------------------------------------------------------------------------

/**
 * THE PAIRS THE SECOND REVIEW MEASURED — seven rewrites of the kind this layer
 * actually produces, fixed here because all seven were being REFUSED.
 *
 * The defect they reproduce is not a wrong threshold, it is a category error: one
 * band was being applied to two different operations. A LANGUAGE correction is a
 * translation, and a translation changes the character count (0.32x here for a
 * faithful English→Korean rendering), the number of negation words (English needs
 * three where Korean needs one), and the way numbers are spelled (`3 phases` →
 * `세 단계`). Judging it by the style band refused the layer's own first-priority
 * repair. Judging a STYLE rewrite by the translation band, meanwhile, let a
 * rewrite model that sprinkled some Hangul into its output pick the loose band for
 * itself.
 *
 * So each pair carries the mode its CALLER would have chosen, and both verdicts
 * are asserted: what the right mode does with it, and what the wrong one does.
 */
type Pair = {
  name: string;
  before: string;
  after: string;
  /** The mode the caller picks for this rewrite (fix 1's rule). */
  mode: 'style' | 'language';
  /** The user's language, which the CALLER hands to a language-mode check. */
  target?: 'korean' | 'other';
  /** What the style band does with the same pair, asserted so the split is not
   *  vacuous: `ok` means the pair is legitimately style-safe too. */
  styleVerdict: 'ok' | 'refused';
};

const REALISTIC_PAIRS: Pair[] = [
  {
    name: 'faithful EN→KO, layering (0.39x)',
    before:
      'The session store belongs in the runtime, because everything that has to outlive a provider swap belongs there. The shell owns the HTTP action, the engine adapter and the user interface, and it owns nothing else.',
    after:
      '세션 스토어는 런타임에 둔다. 프로바이더를 바꿔도 남아야 하는 것은 전부 거기에 두기 때문이다. 셸은 HTTP 액션과 엔진 어댑터와 UI만 맡는다.',
    mode: 'language',
    target: 'korean',
    styleVerdict: 'refused',
  },
  {
    name: 'faithful EN→KO, a prohibition (3 English negations, 1 Korean)',
    before: 'Do not run this script. There is no way back once it has started.',
    after: '이 스크립트는 실행을 금지한다. 한번 시작하면 되돌리는 것은 불가능하다.',
    mode: 'language',
    target: 'korean',
    styleVerdict: 'refused',
  },
  {
    name: 'faithful KO→EN, verification (2.12x — the other direction)',
    before: '검증은 스파이크로 한다. 셸 테스트는 vitest로 돌린다. 실 DB는 건드리지 않는다.',
    after:
      'Verification is done with a spike. The shell tests run under vitest. The real database is never touched.',
    mode: 'language',
    target: 'other',
    styleVerdict: 'refused',
  },
  {
    name: 'faithful EN→KO, invariants (0.32x — the shortest honest translation)',
    before:
      'You should keep the invariants in one place, because the moment there are two copies of them one of the two will be the one that is out of date, and the code that reads it will be wrong in a way that nobody can see.',
    after:
      '불변식은 한곳에 둔다. 사본이 둘이면 한쪽은 반드시 낡아버리고, 그것을 읽는 코드는 아무도 못 보는 방식으로 틀리게 된다.',
    mode: 'language',
    target: 'korean',
    styleVerdict: 'refused',
  },
  {
    name: 'word order only — 제안/방안/보안 are nouns, not negations',
    before: '제안 3건을 먼저 검토한다. 그 다음에 방안 2개를 고른다. 보안 검토는 마지막이다.',
    after: '3건의 제안을 먼저 검토한다. 2개의 방안을 그 다음에 고른다. 보안 검토는 마지막이다.',
    mode: 'style',
    styleVerdict: 'ok',
  },
  {
    name: 'endings only — 합니다 → 한다',
    before: '세션 스토어는 런타임에 둡니다. 프로바이더를 바꿔도 남아야 하기 때문입니다. 셸은 HTTP 액션만 맡습니다.',
    after: '세션 스토어는 런타임에 둔다. 프로바이더를 바꿔도 남아야 하기 때문이다. 셸은 HTTP 액션만 맡는다.',
    mode: 'style',
    styleVerdict: 'ok',
  },
  {
    name: 'numeral notation — 3 phases → 세 단계',
    before: 'The rollout has 3 phases. Each phase takes 2 weeks. Nothing ships before the third one is done.',
    after: '배포는 세 단계로 나눈다. 각 단계는 두 주가 걸린다. 세 번째 단계가 끝나기 전에는 아무것도 내보내지 않는다.',
    mode: 'language',
    target: 'korean',
    styleVerdict: 'refused',
  },
];

/** The options a caller passes for a language-mode check. Written as a helper so
 *  the spike states the contract once: the target language comes from the CALLER,
 *  never from the rewrite. */
function languageMode(target: 'korean' | 'other'): { mode: 'language'; targetLanguage: 'korean' | 'other' } {
  return { mode: 'language', targetLanguage: target };
}
const STYLE_MODE = { mode: 'style' } as const;

function checkVerificationModes(): void {
  // (v1) Every pair, in the mode its caller would have chosen, is ACCEPTED. This
  // is the regression: before the split, seven of seven were refused, so the
  // layer's first-priority repair could never reach the user.
  const inOwnMode = REALISTIC_PAIRS.map((p) => ({
    p,
    verdict:
      p.mode === 'language'
        ? verifyVoiceRewrite(p.before, p.after, languageMode(p.target ?? 'korean'))
        : verifyVoiceRewrite(p.before, p.after, STYLE_MODE),
  }));
  const accepted = inOwnMode.filter((v) => v.verdict.ok === true);
  record(
    `(v1) all ${REALISTIC_PAIRS.length} realistic rewrites pass in the mode their CALLER chose`,
    accepted.length === REALISTIC_PAIRS.length,
    inOwnMode
      .map(
        (v) =>
          `${v.p.name} [${v.p.mode}] -> ${v.verdict.ok ? 'ok' : `REFUSED (${v.verdict.reason})`}`,
      )
      .join('; '),
  );

  // (v2) …and the style band is still a band. The four translations are refused by
  // it, which is what makes the split meaningful rather than a blanket loosening.
  const inStyle = REALISTIC_PAIRS.map((p) => ({
    p,
    verdict: verifyVoiceRewrite(p.before, p.after, STYLE_MODE),
  }));
  const agree = inStyle.filter(
    (v) => (v.verdict.ok === true ? 'ok' : 'refused') === v.p.styleVerdict,
  );
  record(
    '(v2) …and the style band still refuses every one of them that is a translation',
    agree.length === REALISTIC_PAIRS.length,
    inStyle
      .map(
        (v) =>
          `${v.p.name}: expected ${v.p.styleVerdict}, got ${v.verdict.ok ? 'ok' : `refused (${v.verdict.reason})`}`,
      )
      .join('; '),
  );

  // (v3) THE MODE IS THE CALLER'S, AND IT IS A FUNCTION OF THE REASON. Only a
  // `language` deviation on a turn that did NOT name a language buys the loose
  // band; everything else — including a language deviation the suppressor would
  // have blocked anyway — is judged as a restyle.
  const modeRows: { name: string; deviation: VoiceDeviation | undefined; user: string; expected: 'style' | 'language' }[] = [
    { name: 'language deviation, ordinary turn', deviation: 'language', user: KOREAN_USER, expected: 'language' },
    { name: 'language deviation, but the user asked for a translation', deviation: 'language', user: '아래 문단을 영어로 번역해줘.', expected: 'style' },
    { name: 'language deviation, but the user asked for a commit message', deviation: 'language', user: '방금 고친 내용으로 커밋 메시지 하나 써줘.', expected: 'style' },
    { name: 'endings deviation', deviation: 'endings', user: KOREAN_USER, expected: 'style' },
    { name: 'length deviation', deviation: 'length', user: KOREAN_USER, expected: 'style' },
    { name: 'no deviation at all (the always-on stage rule)', deviation: undefined, user: KOREAN_USER, expected: 'style' },
  ];
  const modes = modeRows.map((r) => ({
    ...r,
    got: voiceRewriteMode({ deviation: r.deviation, userText: r.user }),
  }));
  const modesAgree = modes.every((m) => m.got === m.expected);
  record(
    '(v3) the mode comes from WHY the call was made — never from what came back',
    modesAgree,
    modes.map((m) => `${m.name} -> ${m.got} (expected ${m.expected})`).join('; '),
  );

  // …and the same claim from the other side: a style rewrite that sprinkled Hangul
  // into its output cannot buy itself the loose band. Under the old measured rule
  // this pair was judged as a translation and adopted; the caller said `style`, so
  // it is judged as one.
  const selfSelected = verifyVoiceRewrite(
    'The session store belongs in the runtime, because everything that has to outlive a provider swap belongs there, and the shell owns only the HTTP action that reaches it.',
    '런타임이다.',
    STYLE_MODE,
  );
  record(
    '(v3b) a rewrite cannot pick its own band by changing script — the style floor still applies',
    selfSelected.ok === false,
    `verdict = ${JSON.stringify(selfSelected)}`,
  );

  // (v4) NUMBERS IN LANGUAGE MODE ARE A SUBSET, NOT A MATCH. A spelled-out numeral
  // has no number token at all, so requiring a match refuses every translation
  // that writes `3` as `세`. A number the rewrite INVENTED is still refused, which
  // is the half that carries the meaning.
  const droppedNumeral = verifyVoiceRewrite(
    'The rollout has 3 phases and each phase takes 2 weeks, so the whole thing lands in six weeks.',
    '배포는 세 단계로 나누고 각 단계는 두 주가 걸리므로 전체는 여섯 주 만에 끝난다.',
    languageMode('korean'),
  );
  const inventedNumber = verifyVoiceRewrite(
    'Tests run on Node v20. Nothing below that is supported. Check the version first.',
    '테스트는 Node v18에서 돌린다. 그 아래 버전은 지원하지 않는다. 버전을 먼저 확인해라.',
    languageMode('korean'),
  );
  record(
    '(v4) language mode: a numeral that became a word passes, a number that CHANGED does not',
    droppedNumeral.ok === true &&
      inventedNumber.ok === false &&
      inventedNumber.reason === 'a number changed',
    `3 phases → 세 단계: ${JSON.stringify(droppedNumeral)}; v20 → v18: ${JSON.stringify(inventedNumber)}`,
  );

  // (v5) THE TARGET LANGUAGE COMES FROM THE CALLER. A rewrite that came back in
  // the language it started in has not done the one thing it was called for.
  const stayedEnglish = verifyVoiceRewrite(
    ENGLISH_ANSWER,
    'The session store belongs in the runtime because it must survive a provider swap. The shell owns only the HTTP action.',
    languageMode('korean'),
  );
  record(
    '(v5) language mode: a rewrite that is not in the USER\'s language is refused',
    stayedEnglish.ok === false && /language/i.test(stayedEnglish.ok ? '' : stayedEnglish.reason),
    `verdict = ${JSON.stringify(stayedEnglish)}`,
  );

  // (v6) STYLE MODE PRESERVES THE LANGUAGE. A rewrite bought for an ENDING
  // deviation that came back translated changed the one thing nobody asked it to,
  // and until the split there was no rule against it at all.
  const translatedAnyway = verifyVoiceRewrite(KOREAN_ANSWER, ENGLISH_ANSWER, STYLE_MODE);
  record(
    '(v6) style mode: a rewrite that changed the answer\'s language is refused',
    translatedAnyway.ok === false &&
      /language/i.test(translatedAnyway.ok ? '' : translatedAnyway.reason),
    `verdict = ${JSON.stringify(translatedAnyway)}`,
  );
}

// ---------------------------------------------------------------------------
// (w) NEGATION DETECTION — the holes and the over-detection  [second review, 2]
// ---------------------------------------------------------------------------

function checkNegationDetection(): void {
  // THE HOLES. `않` (U+C54A) is not `안` (U+C548), and the class had only the
  // second one — so the commonest Korean negation in this codebase's own prose was
  // invisible, and a rewrite could delete it and keep the count.
  const flips: { name: string; before: string; after: string }[] = [
    {
      name: '지우지 않는다 → 지운다',
      before: '이 스크립트는 실 DB를 지우지 않는다. 임시 경로만 쓴다. 그대로 돌려라.',
      after: '이 스크립트는 실 DB를 지운다. 임시 경로만 쓴다. 그대로 돌려라.',
    },
    {
      name: '접근하지 못한다 → 접근한다',
      before: '셸은 스토어에 직접 접근하지 못한다. 런타임을 거친다. 순서를 지켜라.',
      after: '셸은 스토어에 직접 접근한다. 런타임을 거친다. 순서를 지켜라.',
    },
    {
      name: '불가능하다 → 가능하다',
      before: '이 경로를 되돌리는 것은 불가능하다. 백업이 유일한 수단이다. 먼저 떠라.',
      after: '이 경로를 되돌리는 것은 가능하다. 백업이 유일한 수단이다. 먼저 떠라.',
    },
    {
      name: 'without → with',
      before: 'The store opens without a lock. Nothing else touches the file. Keep it that way.',
      after: 'The store opens with a lock. Nothing else touches the file. Keep it that way.',
    },
  ];
  const verdicts = flips.map((f) => ({
    ...f,
    verdict: verifyVoiceRewrite(f.before, f.after, STYLE_MODE),
  }));
  const refused = verdicts.filter(
    (v) => v.verdict.ok === false && v.verdict.reason === 'a negation was added or dropped',
  );
  record(
    '(w1) the negation class covers 않 / 못하 / 불가 / without — every flip is refused',
    refused.length === flips.length,
    verdicts
      .map((v) => `${v.name}: ${v.verdict.ok ? 'ACCEPTED' : `refused (${v.verdict.reason})`}`)
      .join('; '),
  );

  // THE OVER-DETECTION. `안\s` counted the tail of 제안 / 방안 / 보안 / 대안 / 초안,
  // so an honest reordering that moved a particle changed the "negation count" and
  // the rewrite was thrown away.
  const nouns = extractInvariants('제안 3건과 방안 2개와 보안 검토와 대안 하나와 초안 하나가 있다.');
  record(
    '(w2) 제안 · 방안 · 보안 · 대안 · 초안 are nouns: they are not counted as negations',
    nouns.negations === 0,
    `negations = ${nouns.negations}`,
  );

  // …and the real thing still counts, in both spellings.
  const real = extractInvariants('그 파일은 안 지운다. 지금은 못 한다. 방법이 없다. 그렇게 하지 마라.');
  record(
    '(w3) …while 안 지운다 / 못 한다 / 없다 / 마라 are all still counted',
    real.negations === 4,
    `negations = ${real.negations} (expected 4)`,
  );
}

// ---------------------------------------------------------------------------
// (x) THE REWRITE TIMEOUT  [second review, defect 4]
// ---------------------------------------------------------------------------

function checkTimeout(): void {
  // A held block is INVISIBLE while the rewrite is in flight, so this constant is
  // how long the screen may stay empty after the model has finished answering. A
  // minute reads as a hung app.
  record(
    '(x) the rewrite timeout is 15s, not a minute — a held block cannot blank the screen for longer',
    VOICE_TIMEOUT_MS === 15_000,
    `VOICE_TIMEOUT_MS = ${VOICE_TIMEOUT_MS}`,
  );
}

// ---------------------------------------------------------------------------
// (k)-(o) the turn runner's one-slot delay
// ---------------------------------------------------------------------------

/**
 * An engine that yields a fixed script.
 *
 * `afterYield` fires once the consumer has finished with the event it was handed
 * — a generator only resumes when its consumer asks for the next value — which is
 * what lets the cancellation check press stop at an exact point in the stream
 * (after the final text has been held, before the result arrives).
 */
class ScriptedEngine implements Engine {
  constructor(
    private readonly script: EngineEvent[],
    private readonly afterYield?: (ev: EngineEvent) => void,
  ) {}
  async *run(_input: EngineRunInput): AsyncIterable<EngineEvent> {
    for (const ev of this.script) {
      yield ev;
      this.afterYield?.(ev);
    }
  }
}

const TURN_SCRIPT = (): EngineEvent[] => [
  { kind: 'init', providerId: 'mock', model: 'mock-1' },
  { kind: 'text', role: 'assistant', text: 'Looking at the store now.' },
  { kind: 'tool_request', toolCallId: 'c1', toolName: 'noop', input: {} },
  { kind: 'gate_result', toolCallId: 'c1', toolName: 'noop', decision: 'allow' },
  {
    kind: 'tool_result',
    toolCallId: 'c1',
    toolName: 'noop',
    isError: false,
    output: { content: 'ok' },
  },
  { kind: 'text', role: 'assistant', text: 'The store lives in the runtime.' },
  { kind: 'result', ok: true, usage: { inputTokens: 10, outputTokens: 5 } },
];

async function runScripted(opts: {
  voice?: VoicePort;
  signal?: AbortSignal;
  script?: EngineEvent[];
  afterYield?: (ev: EngineEvent) => void;
}): Promise<{
  events: EngineEvent[];
  streamed: EngineEvent[];
  stored: string[];
}> {
  const store = new MemoryStore();
  const session = store.createSession('mock');
  const streamed: EngineEvent[] = [];
  const events = await runTurn({
    engine: new ScriptedEngine(opts.script ?? TURN_SCRIPT(), opts.afterYield),
    store,
    sessionId: session.sessionId,
    model: { providerId: 'mock', model: 'mock-1' },
    userText: KOREAN_USER,
    toolSchemas: [],
    executors: {},
    gate: async () => ({ behavior: 'allow' as const }),
    onEvent: (ev) => streamed.push(ev),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.voice ? { voice: opts.voice } : {}),
  });
  const stored = store
    .getMessages(session.sessionId)
    .filter((m) => m.role === 'assistant')
    .map((m) => (m.role === 'assistant' ? m.content : ''));
  return { events, streamed, stored };
}

/** A port that marks whatever it is given, and counts its calls. */
function markingPort(): VoicePort & { calls: VoiceRenderRequest[] } {
  const calls: VoiceRenderRequest[] = [];
  return {
    calls,
    async render(req) {
      calls.push(req);
      return `«${req.text}»`;
    },
  };
}

async function checkTurnLoop(): Promise<void> {
  // (k) no port at all
  const plain = await runScripted({});
  const script = TURN_SCRIPT();
  const sameEvents = JSON.stringify(plain.events) === JSON.stringify(script);
  const sameStore =
    JSON.stringify(plain.stored) ===
    JSON.stringify(['Looking at the store now.', '', 'The store lives in the runtime.']);
  record(
    '(k) NO PORT: the event stream and the transcript are byte-for-byte the pre-M14a turn',
    sameEvents && sameStore,
    `events identical = ${sameEvents}; assistant rows = ${JSON.stringify(plain.stored)}`,
  );

  // (l) + (m) with a port
  const port = markingPort();
  const voiced = await runScripted({ voice: port });
  const offered = port.calls.map((c) => c.text);
  const onlyLast =
    port.calls.length === 1 && offered[0] === 'The store lives in the runtime.';
  record(
    '(l) ONLY the last assistant block is offered — the text before a tool call is not',
    onlyLast,
    `calls = ${port.calls.length}, offered = ${JSON.stringify(offered)}`,
  );

  const finalFromEvents = voiced.events
    .filter((e): e is Extract<EngineEvent, { kind: 'text' }> => e.kind === 'text')
    .map((e) => e.text);
  const finalFromStream = voiced.streamed
    .filter((e): e is Extract<EngineEvent, { kind: 'text' }> => e.kind === 'text')
    .map((e) => e.text);
  const expected = ['Looking at the store now.', '«The store lives in the runtime.»'];
  const agree =
    JSON.stringify(finalFromEvents) === JSON.stringify(expected) &&
    JSON.stringify(finalFromStream) === JSON.stringify(expected) &&
    voiced.stored.includes('«The store lives in the runtime.»') &&
    !voiced.stored.includes('The store lives in the runtime.');
  record(
    '(m) returned events, streamed events and the stored transcript all carry the SAME final text',
    agree,
    `events = ${JSON.stringify(finalFromEvents)}, streamed = ${JSON.stringify(finalFromStream)}, ` +
      `stored = ${JSON.stringify(voiced.stored)}`,
  );

  // Ordering: the rewritten block must reach the caller BEFORE the result, or the
  // consumer's turn has already closed by the time it arrives.
  const streamKinds = voiced.streamed.map((e) => e.kind);
  const textAt = streamKinds.lastIndexOf('text');
  const resultAt = streamKinds.indexOf('result');
  record(
    '(m2) the rewritten block is streamed BEFORE the terminal result',
    textAt >= 0 && resultAt >= 0 && textAt < resultAt,
    `order = ${JSON.stringify(streamKinds)}`,
  );

  // (n) AN ABORT MID-STREAM: no rewrite call, and the block goes out AS THE MODEL
  // WROTE IT — to the caller and to the store, exactly as it would have without
  // this layer. Stop is pressed the instant the final block has been held, which is
  // the exact moment the layer would otherwise spend a call on it.
  //
  // THE SECOND REVIEW REVERSED THE FIRST ONE HERE, and the reason is the shell:
  // `handleStop` calls `endRun`, `endRun` calls `onRunComplete`, and that is the
  // disk reconcile — so a stopped run reloads the transcript from disk, and a block
  // that was stored is displayed. Dropping it was not "keeping the two halves in
  // agreement", it was deleting a finished answer from both of them.
  const controller = new AbortController();
  const abortPort = markingPort();
  const aborted = await runScripted({
    voice: abortPort,
    signal: controller.signal,
    script: [
      { kind: 'init', providerId: 'mock', model: 'mock-1' },
      { kind: 'text', role: 'assistant', text: 'The store lives in the runtime.' },
      { kind: 'result', ok: true },
    ],
    afterYield: (ev) => {
      if (ev.kind === 'text') controller.abort();
    },
  });
  const streamedAfterAbort = aborted.streamed.filter(
    (e) => e.kind === 'text' && e.text === 'The store lives in the runtime.',
  );
  record(
    '(n) a stopped turn still delivers the held block VERBATIM to both sinks — no rewrite, no loss',
    abortPort.calls.length === 0 &&
      aborted.stored.includes('The store lives in the runtime.') &&
      streamedAfterAbort.length === 1,
    `calls = ${abortPort.calls.length}, stored = ${JSON.stringify(aborted.stored)}, ` +
      `streamed text events = ${streamedAfterAbort.length}`,
  );

  // ...and the activity row says WHY it was not restyled, so a run whose answers
  // suddenly stop matching the user's voice is explainable.
  const logged = readActivityLog().filter(
    (row) =>
      row.kind === 'assistant_text' &&
      row.text === 'The store lives in the runtime.' &&
      row.voiceSkipped === 'aborted',
  );
  record(
    '(n2) the delivered block records that the rewrite was skipped because the turn was stopped',
    logged.length >= 1,
    `matching activity rows = ${logged.length}`,
  );

  // (n3) NO PORT, AND A STOP: the one that regressed. Without a port there is
  // nothing to wait for, so nothing may be parked and nothing may be lost —
  // byte-for-byte the pre-M14a turn, stop included.
  const plainController = new AbortController();
  const plainAborted = await runScripted({
    signal: plainController.signal,
    script: [
      { kind: 'init', providerId: 'mock', model: 'mock-1' },
      { kind: 'text', role: 'assistant', text: 'The store lives in the runtime.' },
      { kind: 'result', ok: true },
    ],
    afterYield: (ev) => {
      if (ev.kind === 'text') plainController.abort();
    },
  });
  record(
    '(n3) NO PORT + stop: the finished block is still returned and still stored, as it was before M14a',
    plainAborted.events.map((e) => e.kind).join(',') === 'init,text' &&
      plainAborted.stored.includes('The store lives in the runtime.'),
    `events = ${JSON.stringify(plainAborted.events.map((e) => e.kind))}, stored = ${JSON.stringify(plainAborted.stored)}`,
  );

  // (o) a port that answers with nothing
  const emptyPort: VoicePort = { async render() { return ''; } };
  const empty = await runScripted({ voice: emptyPort });
  record(
    '(o) a port that returns nothing cannot empty the answer',
    empty.stored.includes('The store lives in the runtime.'),
    `stored = ${JSON.stringify(empty.stored)}`,
  );

  // ...and one that throws, which the port contract forbids but the runtime does
  // not rely on.
  const throwingPort: VoicePort = {
    async render() {
      throw new Error('port broke its contract');
    },
  };
  const threw = await runScripted({ voice: throwingPort });
  record(
    '(o2) a port that throws cannot fail the turn',
    threw.stored.includes('The store lives in the runtime.'),
    `stored = ${JSON.stringify(threw.stored)}`,
  );
}

// ---------------------------------------------------------------------------

/** Every activity row this process wrote. The log is JSONL under NABY_HOME, which
 *  is the throwaway directory pinned at the bottom of this file. */
function readActivityLog(): Record<string, unknown>[] {
  const file = activityLogFile();
  if (!file) return [];
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

async function main(): Promise<boolean> {
  checkProseExtraction();
  checkLanguage();
  checkEndings();
  checkLength();
  checkAbstains();
  checkPriority();
  checkLanguageDirective();
  checkPastedLog();
  checkShapeRules();
  checkPaths();
  checkStageTable();
  checkPrompt();
  checkVerifier();
  checkInvariantTampers();
  checkVerificationModes();
  checkNegationDetection();
  checkTimeout();
  await checkTurnLoop();

  console.log('\n=== SPIKE-VOICE — the naby layer (P3-M14a, specs/naby-voice-layer.md) ===\n');
  let allPass = true;
  for (const c of checks) {
    const tag = c.pass ? 'PASS' : 'FAIL';
    if (!c.pass) allPass = false;
    console.log(`[${tag}] ${c.name}`);
    console.log(`        evidence: ${c.evidence}`);
  }
  console.log(
    `\nSPIKE-VOICE: ${allPass ? 'ALL PASS' : 'FAILURES PRESENT'} (${checks.filter((c) => c.pass).length}/${checks.length})\n`,
  );
  return allPass;
}

const TMP_DIR = mkdtempSync(join(tmpdir(), 'naby-voice-'));
// The spike never touches the real database: every store above is in memory, and
// NABY_DB_PATH is pinned here for anything that resolves a default path on its own
// (the activity log, notably — it must not append to the user's real one).
process.env.NABY_DB_PATH = join(TMP_DIR, 'app.db');
process.env.NABY_HOME = TMP_DIR;

try {
  const ok = await main();
  if (!ok) process.exitCode = 1;
} catch (e) {
  console.error('SPIKE-VOICE crashed:', e);
  process.exitCode = 1;
} finally {
  rmSync(TMP_DIR, { recursive: true, force: true });
}
