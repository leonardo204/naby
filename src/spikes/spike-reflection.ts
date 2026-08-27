// src/spikes/spike-reflection.ts
//
// Phase 3 (P3-M8a + P3-M8b) verification: SESSION REFLECTION — the
// `correctedAfter` writer, and the memory proposals / cross-session corroboration
// built on top of it. Contract: specs/phase-3-continuous-learning.md §4 and §5,
// specs/phase-3-checkin-contracts.md §3 (markEvalEventCorrected, listEvalEvents
// sessionId) and invariant 8, phase-1_5-memory-contracts §4 invariant 1 and §8.
//
// The ledger reserved `correctedAfter` as the miss signal for everything the agent
// did WITHOUT asking, and nothing ever wrote it — so ask-recall was pinned at 1 and
// coverage could only inflate. This drives the REAL sweep, the REAL validator and
// the REAL store with a MOCK judge (the spike:learn technique), and then reads the
// result through the REAL meter, so the whole chain is proven end to end minus the
// model's judgement quality (which no mock can prove — §4.7 lists it as the one
// thing that stays unverified here).
//
// Asserted, against BOTH store drivers:
//   (a) A session used a moment ago is NOT reflected on: no judge call, no cursor.
//   (b) An idle session is: the corrected action is marked and the cursor advances.
//   (c) The second sweep is a NO-OP — nothing new was said, so nothing is re-judged.
//   (d) The validator throws away invented verdicts: an unknown case id, and a quote
//       the user never typed. The cursor still advances (the session WAS read).
//   (e) The active session is excluded, and one sweep stops at REFLECTION_SWEEP_CAP.
//   (f) A FAILING judge leaves the cursor untouched, so the evidence is retried.
//   (y) An UNAVAILABLE judge — no provider key and no local Claude sign-in — is
//       not the same thing as a judge that read the session and found nothing.
//       It stamps no `reviewedAt` and advances no cursor, so no weak-accept
//       evidence is manufactured out of an absence.
//   (z) …and the next sweep, once a judge exists, judges exactly that backlog.
//   (aa) The subscription fallback runs HEADLESS: `settingSources: []`, so a
//       background judge call adopts no directory's CLAUDE.md or hooks. Omitting
//       `cwd` is not enough — the SDK defaults it to `process.cwd()`.
//   (g) `markEvalEventCorrected` refuses every kind but `autonomous`.
//   (h) What it wrote reaches the meter: missedAsks rises, ask-recall falls below 1,
//       and `correctedAfter` shows in the growth state.
// M8b (§5), also against BOTH drivers:
//   (j) A grounded proposal lands as `proposed` + `artifact` with
//       `createdFrom = "<sessionId>:<seq>"` pointing at the message it was read from.
//   (k) The guards refuse, with NO row written: an invented quote, a secret-shaped
//       value, an `org`-scope proposal, a `session`-scope proposal, and a `project`
//       proposal from a session with no project.
//   (l) A `proposed` row still does not inject — the M8b writer changes nothing
//       about contract §5.
//   (m) Corroboration accumulates across three DISTINCT sessions, and one session
//       saying it twice still counts once.
//   (n) A materially changed value RESETS the count to 1; a whitespace-only edit
//       does not.
//   (o) Consolidation: nothing while the opt-in is off; at the threshold it
//       promotes an artifact-tier row; an `external` row with more than enough
//       observations is NEVER promoted (memory-contracts §4 invariant 1).
//   (p) `deleteSession` removes that session's observations while the memory row
//       itself, and a confirmed row's status, survive.
// M8c (§6.4) — the widened trigger, also against BOTH drivers:
//   (s) A session with NO autonomous action at all still earns ONE judge call, for
//       the memory task alone, once it has said REFLECTION_MIN_USER_MESSAGES new
//       things: the proposal lands and the cursor advances.
//   (t) Below the threshold the judge is NOT called (counted, not inferred) and the
//       cursor advances anyway — the span is spent either way.
// M8d (§7.2) — the `reviewedAt` writer, against BOTH drivers:
//   (u) The second mutable field is as narrow as the first: `autonomous` only, and
//       FIRST-WINS, so a re-sweep cannot move an old action's review time forward.
//   (w) The sweep stamps EVERY action it put to the judge, the corrected ones
//       included, and leaves an action that never reached the judge unstamped.
//   (x) Those stamps arrive in the meter as the implicit half of the bound, with
//       the raw counts reported and the check-in record untouched.
// P3-M13a (conversational-learning-hardening §3.1) — the four-op update and
// supersession, against BOTH drivers:
//   (bb) THE DECISION TABLE, driven directly: equivalent→NOOP, refines→UPDATE of
//       the existing key, contradicts→ADD + reservation, unrelated→plain ADD —
//       and a verdict with nothing matched is an ADD whatever it claimed.
//   (bb2) A TRANSIENT candidate never reserves over a stable (or untagged) row.
//   (bb3) MATCHING IS CODE and is the gate on the model: it finds the row a
//       candidate is about, ignores an unrelated one, and never crosses scope.
//   (cc) A PROPOSED contradiction retires NOTHING — the reservation is recorded
//       and the old fact goes on living.
//   (dd) CONFIRMATION is what stamps it, through the same helper `/api/memory`
//       calls, and the old row is kept rather than deleted.
//   (ee) The store enforces the transient rule and never re-stamps a row that is
//       already superseded.
//   (ff) `style/<taskType>` is auto-confirmed at the threshold; `style/global/*`
//       NEVER is, whatever the opt-in says (§3.3).
//   (gg) A superseded row is out of injection AND out of the evidence pool.
//   (hh) EQUIVALENT writes nothing and corroborates; REFINES rewrites the
//       existing key instead of minting a near-duplicate beside it.
//   (ii) A relation whose quote the user never typed is dropped and counted.
// P3-M13c (§3.3) — style:
//   (jj) Style preferences are ordinary proposed `procedural`/`user` memory under
//       `style/<target>/<slug>`, travelling the identical machinery.
//   (kk) The FINGERPRINT is counted (no model), stored under one settings key,
//       injected only above the sample floor, silenced by the learning gate with
//       NO new switch, and merged with a cap so a long history cannot freeze it.
//
// And once, against a real file:
//   (i) LOSSLESS MIGRATION v7 -> current: reflection_state appears and works, and
//       the pre-existing session / messages / ledger rows all survive.
//   (q) LOSSLESS MIGRATION v8 -> v9: memory_observations appears and works, and
//       the pre-existing memory rows and cursors survive.
//
// NO NETWORK, NO KEYS: the judge is injected. Temp dir only; the real ~/.naby/app.db
// is never touched.

import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStore } from '../runtime/store/memory-store.js';
import { SCHEMA_VERSION, SqliteStore } from '../runtime/store/sqlite-store.js';
import type { MemoryItem, MemoryWriteRequest, Store } from '../runtime/store/store.js';
import {
  CORROBORATION_THRESHOLD,
  isGlobalStyleMemoryKey,
  isStyleMemoryKey,
  parseReflectionAnswer,
  REFLECTION_IDLE_MS,
  REFLECTION_MIN_USER_MESSAGES,
  REFLECTION_SWEEP_CAP,
  shouldAutoConfirmMemory,
  validateReflectionVerdicts,
  type ReflectionCase,
  type ReflectionJudge,
  type ReflectionMemoryCandidate,
  type ReflectionPairRelation,
  type ReflectionStyleCandidate,
} from '../runtime/reflection.js';
// P3-M13a (§3.1): the decision table and the matcher — pure, so the spike drives
// the very functions the sweep calls rather than a second copy of the rules.
import {
  applyConsolidation,
  matchCandidates,
  maySupersede,
  memoryHandle,
} from '../runtime/memory-consolidation.js';
// P3-M13c (§3.3): the deterministic half.
import {
  computeStyleFingerprint,
  mergeStyleFingerprint,
  parseStyleFingerprint,
  renderStyleFingerprintLine,
  STYLE_FINGERPRINT_KEY,
  STYLE_FINGERPRINT_MIN_SAMPLES,
  STYLE_SAMPLE_CAP,
} from '../runtime/style-fingerprint.js';
import {
  askDecisionQuality,
  computeGrowth,
  IMPLICIT_WEIGHT,
  type CheckinRecord,
} from '../runtime/growth.js';
import {
  DEFAULT_USER_ID,
  retrieveForInjection,
  selectMemoryForInjection,
} from '../runtime/memory-inject.js';
// P3-M10 (memory-hygiene §2.2/§3): the decay window and the app-wide learning
// switch, imported from the runtime so the spike drives the SAME rules the sweep
// does rather than a second copy of them.
import {
  MEMORY_DECAY_REVIEW_MS,
  staleReviewCutoff,
  writeLearningEnabled,
} from '../runtime/memory-hygiene.js';
import { buildQueryOptions } from '../engines/claude-agent-sdk-engine.js';
import type { EngineRunInput } from '../runtime/engine.js';
import {
  activateSupersession,
  MEMORY_AUTO_CONFIRM_KEY,
  ReflectionJudgeUnavailableError,
  runReflectionSweep,
} from '../../shell/packages/feature/agent/src/server/lib/reflection.js';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

const AGENT = 'agent-under-test';
const CORRECTION = 'no, that was the wrong file — undo it and edit config/prod.yaml instead';

/** A "much later" clock: every seeded session is idle at this instant. */
const LATER = (): number => Date.now() + REFLECTION_IDLE_MS * 2;

/**
 * Seed one conversation in which the agent wrote a file WITHOUT asking and the
 * user pushed back afterwards. The transcript is shaped exactly as `runTurn`
 * writes one (user → assistant tool-call → tool result → assistant → user), which
 * is what the case-builder's anchoring depends on.
 */
function seedActionSession(
  store: Store,
  sessionId: string,
  at: number,
  finalUserMessage: string,
): string {
  store.touchSession(sessionId, 'test-provider');
  store.appendMessage(sessionId, { role: 'user', content: 'update the config for me' });
  store.appendMessage(sessionId, {
    role: 'assistant',
    content: '',
    toolCalls: [{ toolCallId: 'call-1', toolName: 'Write', input: { path: 'config/dev.yaml' } }],
  });
  store.appendMessage(sessionId, {
    role: 'tool',
    toolCallId: 'call-1',
    toolName: 'Write',
    output: { content: 'wrote config/dev.yaml' },
  });
  store.appendMessage(sessionId, { role: 'assistant', content: 'Updated config/dev.yaml.' });
  store.appendMessage(sessionId, { role: 'user', content: finalUserMessage });
  const row = store.appendEvalEvent({
    kind: 'autonomous',
    agentId: AGENT,
    sessionId,
    toolName: 'Write',
    reversible: true,
    at,
  });
  return row.id;
}

function seedCorrectedSession(store: Store, sessionId: string, at: number): string {
  return seedActionSession(store, sessionId, at, CORRECTION);
}

/** A judge that marks a case corrected when the user's own words say so, quoting
 *  them verbatim — i.e. what a good model would return. */
const honestJudge = (calls: ReflectionCase[][]): ReflectionJudge => {
  return async (cases) => {
    calls.push([...cases]);
    return cases.map((c) => {
      const evidence = c.laterUserMessages.find((m) => m.includes('undo it'));
      return evidence
        ? { caseId: c.caseId, corrected: true, evidenceQuote: 'undo it' }
        : { caseId: c.caseId, corrected: false };
    });
  };
};

/** A judge that invents: one verdict about a case it was never shown, and one
 *  whose "quote" nobody typed. */
const hallucinatingJudge: ReflectionJudge = async (cases) => [
  { caseId: 'a-case-that-was-never-put-to-me', corrected: true, evidenceQuote: 'undo it' },
  ...cases.map((c) => ({
    caseId: c.caseId,
    corrected: true,
    evidenceQuote: 'the user said this was completely wrong',
  })),
];

const failingJudge: ReflectionJudge = async () => {
  throw new Error('provider unavailable');
};

/** A machine with NO judge on it: no provider key AND no local Claude sign-in.
 *  Distinct from `failingJudge` on purpose — a failed CALL is one session's bad
 *  luck, while this is a fact about the machine, and the two are handled
 *  differently by the sweep. */
const unavailableJudge: ReflectionJudge = async () => {
  throw new ReflectionJudgeUnavailableError('no reflection judge is available (spike)');
};

function correctedFlag(store: Store, id: string): boolean {
  return store.listEvalEvents(AGENT).find((e) => e.id === id)?.correctedAfter === true;
}

// ---------------------------------------------------------------------------
// (a)+(b)+(c) due-ness, the write, and idempotency
// ---------------------------------------------------------------------------

async function checkSweep(store: Store, label: string): Promise<void> {
  const eventId = seedCorrectedSession(store, 'sess-idle', 1_000);

  // (a) NOT DUE: the session was touched just now.
  const freshCalls: ReflectionCase[][] = [];
  const notDue = await runReflectionSweep(store, honestJudge(freshCalls), { now: Date.now() });
  record(
    `(a) [${label}] a session used moments ago is not reflected on — no judge call, no cursor`,
    notDue.sweptSessions === 0 &&
      freshCalls.length === 0 &&
      store.getReflectionCursor('sess-idle') === undefined &&
      !correctedFlag(store, eventId),
    `swept=${notDue.sweptSessions} judgeCalls=${freshCalls.length} cursor=${JSON.stringify(store.getReflectionCursor('sess-idle'))}`,
  );

  // (b) DUE: idle long enough, and it has something new to say.
  const calls: ReflectionCase[][] = [];
  const now = LATER();
  const first = await runReflectionSweep(store, honestJudge(calls), { now });
  const cursor = store.getReflectionCursor('sess-idle');
  const latestSeq = store.getMessages('sess-idle').length - 1;
  record(
    `(b) [${label}] an idle session is judged once, the corrected action is marked, the cursor advances`,
    first.sweptSessions === 1 &&
      first.markedEvents === 1 &&
      first.droppedVerdicts === 0 &&
      calls.length === 1 &&
      calls[0]?.length === 1 &&
      calls[0]?.[0]?.caseId === eventId &&
      correctedFlag(store, eventId) &&
      cursor?.lastSeq === latestSeq &&
      cursor?.reflectedAt === now,
    `swept=${first.sweptSessions} marked=${first.markedEvents} calls=${calls.length} cases=${calls[0]?.length} cursor=${JSON.stringify(cursor)} latestSeq=${latestSeq}`,
  );

  // (c) IDEMPOTENT: nothing was said since, so there is nothing to re-judge.
  const secondCalls: ReflectionCase[][] = [];
  const second = await runReflectionSweep(store, honestJudge(secondCalls), { now: LATER() });
  record(
    `(c) [${label}] the second sweep is a no-op: no judge call, no new marks, cursor unmoved`,
    second.sweptSessions === 0 &&
      second.markedEvents === 0 &&
      secondCalls.length === 0 &&
      store.getReflectionCursor('sess-idle')?.lastSeq === latestSeq,
    `swept=${second.sweptSessions} marked=${second.markedEvents} calls=${secondCalls.length} cursor=${JSON.stringify(store.getReflectionCursor('sess-idle'))}`,
  );
}

// ---------------------------------------------------------------------------
// (d) invented verdicts are refused
// ---------------------------------------------------------------------------

async function checkHallucination(store: Store, label: string): Promise<void> {
  const eventId = seedCorrectedSession(store, 'sess-halluc', 2_000);
  const out = await runReflectionSweep(store, hallucinatingJudge, { now: LATER() });
  const cursor = store.getReflectionCursor('sess-halluc');
  record(
    `(d) [${label}] an unknown case id and an ungrounded quote are both thrown out; nothing is marked`,
    out.markedEvents === 0 &&
      out.droppedVerdicts === 2 &&
      out.sweptSessions === 1 &&
      !correctedFlag(store, eventId) &&
      cursor !== undefined,
    `marked=${out.markedEvents} dropped=${out.droppedVerdicts} correctedAfter=${correctedFlag(store, eventId)} cursor=${JSON.stringify(cursor)}`,
  );
}

// ---------------------------------------------------------------------------
// (e) the active session is skipped, and the cap holds
// ---------------------------------------------------------------------------

async function checkExclusionAndCap(store: Store, label: string): Promise<void> {
  const ids: string[] = [];
  for (let i = 0; i < REFLECTION_SWEEP_CAP + 2; i += 1) {
    ids.push(seedCorrectedSession(store, `sess-${i}`, 3_000 + i));
  }
  const calls: ReflectionCase[][] = [];
  const out = await runReflectionSweep(store, honestJudge(calls), {
    now: LATER(),
    excludeSessionId: 'sess-0',
  });
  const activeUntouched =
    store.getReflectionCursor('sess-0') === undefined && !correctedFlag(store, ids[0]!);
  record(
    `(e) [${label}] the live session is never reflected on, and one sweep stops at ${REFLECTION_SWEEP_CAP} sessions`,
    out.sweptSessions === REFLECTION_SWEEP_CAP && calls.length === REFLECTION_SWEEP_CAP && activeUntouched,
    `swept=${out.sweptSessions} (cap ${REFLECTION_SWEEP_CAP}) judgeCalls=${calls.length} activeSessionUntouched=${activeUntouched}`,
  );
}

// ---------------------------------------------------------------------------
// (f) a failed judge must not lose the evidence
// ---------------------------------------------------------------------------

async function checkJudgeFailure(store: Store, label: string): Promise<void> {
  const eventId = seedCorrectedSession(store, 'sess-fail', 4_000);
  const failed = await runReflectionSweep(store, failingJudge, { now: LATER() });
  const cursorAfterFailure = store.getReflectionCursor('sess-fail');
  // The retry, with a working judge, still finds the case.
  const calls: ReflectionCase[][] = [];
  const retry = await runReflectionSweep(store, honestJudge(calls), { now: LATER() });
  record(
    `(f) [${label}] a failed judge advances no cursor, and the next sweep still finds the evidence`,
    failed.sweptSessions === 0 &&
      cursorAfterFailure === undefined &&
      retry.markedEvents === 1 &&
      correctedFlag(store, eventId),
    `afterFailure: swept=${failed.sweptSessions} cursor=${JSON.stringify(cursorAfterFailure)}; retry: marked=${retry.markedEvents} correctedAfter=${correctedFlag(store, eventId)}`,
  );
}

// ---------------------------------------------------------------------------
// (y) NO JUDGE AT ALL is not an empty answer
// ---------------------------------------------------------------------------

/**
 * The regression this pins is the one that made the meter lie on every
 * subscription-only machine.
 *
 * `modelReflectionJudge` used to answer "no provider credential" by returning
 * `[]` — the SAME value it returns after reading a session and finding nothing
 * wrong. The sweep cannot tell those apart, so it did what it does after a real
 * answer: stamped every case `reviewedAt` and advanced the cursor. Since
 * reviewed-and-uncorrected is the weak ACCEPT that M8d blends into the trust
 * bound, the meter was fed evidence that no model had ever produced, and the
 * cursor had moved past it so it could never be re-read.
 *
 * Asserted here on the REAL sweep: an unavailable judge stamps nothing, moves no
 * cursor, and leaves the backlog for a sweep that can actually read it.
 */
async function checkJudgeUnavailable(store: Store, label: string): Promise<void> {
  const eventId = seedActionSession(store, 'sess-nojudge', 4_500, CORRECTION);

  const out = await runReflectionSweep(store, unavailableJudge, { now: LATER() });
  const cursorAfter = store.getReflectionCursor('sess-nojudge');
  const rowAfter = store.listEvalEvents(AGENT).find((e) => e.id === eventId);

  record(
    `(y) [${label}] an unavailable judge stamps no reviewedAt and advances no cursor`,
    out.sweptSessions === 0 &&
      out.reviewedEvents === 0 &&
      out.markedEvents === 0 &&
      cursorAfter === undefined &&
      rowAfter?.reviewedAt === undefined &&
      rowAfter?.correctedAfter === undefined,
    `swept=${out.sweptSessions} reviewed=${out.reviewedEvents} marked=${out.markedEvents}; ` +
      `cursor=${JSON.stringify(cursorAfter)}; row reviewedAt=${String(rowAfter?.reviewedAt)} correctedAfter=${String(rowAfter?.correctedAfter)}`,
  );

  // AND THE EVIDENCE IS STILL THERE. The next sweep — on a machine that now has
  // a key, or a user who has signed in — judges exactly what the first one could
  // not, which is the whole point of not advancing.
  const calls: ReflectionCase[][] = [];
  const retry = await runReflectionSweep(store, honestJudge(calls), { now: LATER() });
  const rowRetried = store.listEvalEvents(AGENT).find((e) => e.id === eventId);
  record(
    `(z) [${label}] the same evidence is judged on the next sweep, once a judge exists`,
    calls.length === 1 &&
      retry.sweptSessions === 1 &&
      retry.reviewedEvents === 1 &&
      retry.markedEvents === 1 &&
      typeof rowRetried?.reviewedAt === 'number' &&
      rowRetried?.correctedAfter === true &&
      store.getReflectionCursor('sess-nojudge') !== undefined,
    `judge calls on retry=${calls.length}; swept=${retry.sweptSessions} reviewed=${retry.reviewedEvents} marked=${retry.markedEvents}; ` +
      `row reviewedAt=${String(rowRetried?.reviewedAt)} correctedAfter=${String(rowRetried?.correctedAfter)}`,
  );
}

// ---------------------------------------------------------------------------
// (aa) the subscription fallback adopts nobody's harness
// ---------------------------------------------------------------------------

/**
 * The judge's SECOND backend is `ClaudeAgentSdkEngine`, driven headlessly on a
 * local Claude sign-in — which is what makes reflection work at all on a machine
 * with no API key. Driving it for real needs that sign-in, so what is asserted
 * here is the part that is a pure function of our own code and would otherwise be
 * verified by nobody: WHAT THE ENGINE ASKS THE SDK FOR.
 *
 * The trap being pinned: "give it no cwd" does NOT mean "it loads no harness".
 * The SDK documents `cwd` as defaulting to `process.cwd()`, so a judge call that
 * merely omits `cwd` would load the CLAUDE.md, settings and HOOKS of whatever
 * directory the Electron main process happens to sit in (naby's own checkout, in
 * development) into a background call the user never made and cannot see.
 *
 * This used to be bought with an `isolated: true` the judge passed and a turn did
 * not. Since harness-standalone §2.3 there is no flag: `settingSources: []` is
 * unconditional, so the judge and the user's turn are isolated by the same line.
 * The assertion below therefore checks BOTH — a regression that re-enabled
 * setting sources for turns would otherwise sail past a judge-only check.
 */
function checkHeadlessJudgeIsolation(): void {
  const input = {
    model: { providerId: 'dev-claude' },
    messages: [{ role: 'user' as const, content: 'judge this' }],
    toolSchemas: [],
    executors: {},
    gate: async () => ({ behavior: 'deny' as const }),
    signal: new AbortController().signal,
  } as unknown as EngineRunInput;
  const other = {
    mcpServer: {} as never,
    preToolUse: (async () => ({})) as never,
    abortController: new AbortController(),
    onStderr: () => {},
  };
  const headless = buildQueryOptions({ input, ...other });
  const turn = buildQueryOptions({ input, ...other });

  record(
    '(aa) NEITHER the headless judge NOR an ordinary turn loads any setting source',
    JSON.stringify(headless.settingSources) === '[]' &&
      JSON.stringify(turn.settingSources) === '[]' &&
      // No cwd is named either way here — which is exactly why settingSources had
      // to be the lever: absent cwd silently becomes process.cwd().
      headless.cwd === undefined &&
      // Isolation is not a licence: the gate hook and the disallowed native
      // ask-the-user tool are unchanged on the background path.
      headless.hooks !== undefined &&
      (headless.disallowedTools ?? []).includes('AskUserQuestion') &&
      // …and the native skill/command loaders are denied on both paths too.
      JSON.stringify(headless.skills) === '[]' &&
      (headless.disallowedTools ?? []).includes('Skill'),
    `headless settingSources=${JSON.stringify(headless.settingSources)} cwd=${String(headless.cwd)} ` +
      `skills=${JSON.stringify(headless.skills)} ` +
      `disallowedTools=${JSON.stringify(headless.disallowedTools)}; turn settingSources=${JSON.stringify(turn.settingSources)}`,
  );
}

// ---------------------------------------------------------------------------
// (g) the ledger's one mutable field stays narrow (contract invariant 8)
// ---------------------------------------------------------------------------

function checkKindGuard(store: Store, label: string): void {
  const checkin = store.appendEvalEvent({
    kind: 'checkin',
    agentId: AGENT,
    sessionId: 'sess-kinds',
    question: 'Migrate the column, or add a new one?',
    options: ['migrate', 'add new'],
    recommended: 0,
    chosen: 0,
    hit: true,
    at: 5_000,
  });
  const tripwire = store.appendEvalEvent({
    kind: 'tripwire',
    agentId: AGENT,
    sessionId: 'sess-kinds',
    toolName: 'Bash',
    reason: 'denied by policy',
    at: 5_001,
  });
  const autonomous = store.appendEvalEvent({
    kind: 'autonomous',
    agentId: AGENT,
    sessionId: 'sess-kinds',
    toolName: 'Write',
    reversible: true,
    at: 5_002,
  });

  const checkinRefused = store.markEvalEventCorrected(checkin.id) === false;
  const tripwireRefused = store.markEvalEventCorrected(tripwire.id) === false;
  const missingRefused = store.markEvalEventCorrected('no-such-id') === false;
  const autonomousAccepted = store.markEvalEventCorrected(autonomous.id) === true;

  // P3-M8d: the SECOND mutable field obeys the same narrowness, plus first-wins.
  const reviewRefusals =
    store.markEvalEventReviewed(checkin.id, 5_500) === false &&
    store.markEvalEventReviewed(tripwire.id, 5_500) === false &&
    store.markEvalEventReviewed('no-such-id', 5_500) === false;
  const reviewAccepted = store.markEvalEventReviewed(autonomous.id, 5_500) === true;
  // A second review reports success and changes NOTHING: the first review is
  // when the user's chance to object began, and letting a later sweep push that
  // forward would slide an old action into the current implicit window.
  const reviewRepeated = store.markEvalEventReviewed(autonomous.id, 9_999) === true;

  const rows = store.listEvalEvents(AGENT, { sessionId: 'sess-kinds' });
  const checkinRow = rows.find((r) => r.id === checkin.id);
  const tripwireRow = rows.find((r) => r.id === tripwire.id);
  const autonomousRow = rows.find((r) => r.id === autonomous.id);
  const untouched =
    checkinRow?.correctedAfter === undefined &&
    checkinRow?.hit === true &&
    checkinRow?.reviewedAt === undefined &&
    tripwireRow?.correctedAfter === undefined &&
    tripwireRow?.reviewedAt === undefined;
  const firstReviewStands = autonomousRow?.reviewedAt === 5_500;
  // The sessionId selector is exercised here too: three rows in, three rows out,
  // and none of the other sessions' rows.
  const selectorWorks = rows.length === 3 && rows.every((r) => r.sessionId === 'sess-kinds');

  record(
    `(g) [${label}] only an 'autonomous' row can be marked; checkin/tripwire/missing are refused with no write`,
    checkinRefused &&
      tripwireRefused &&
      missingRefused &&
      autonomousAccepted &&
      untouched &&
      selectorWorks,
    `checkin=${checkinRefused} tripwire=${tripwireRefused} missing=${missingRefused} autonomous=${autonomousAccepted} rowsUntouched=${untouched} sessionSelector=${rows.length} rows`,
  );

  record(
    `(u) [${label}] reviewedAt is autonomous-only and FIRST-WINS: a second review reports success and moves nothing`,
    reviewRefusals && reviewAccepted && reviewRepeated && firstReviewStands,
    `refusedForOtherKinds=${reviewRefusals} accepted=${reviewAccepted} secondCall=${reviewRepeated} storedReviewedAt=${String(autonomousRow?.reviewedAt)} (re-review asked for 9999)`,
  );
}

// ---------------------------------------------------------------------------
// (h) it reaches the meter
// ---------------------------------------------------------------------------

async function checkMeter(store: Store, label: string): Promise<void> {
  // Four answered check-ins: two the user took, two they did not (warranted asks).
  for (let i = 0; i < 4; i += 1) {
    store.appendEvalEvent({
      kind: 'checkin',
      agentId: AGENT,
      sessionId: 'sess-meter',
      question: `Task ${i}: path A or path B?`,
      options: [`A${i}`, `B${i}`],
      recommended: 0,
      chosen: i < 2 ? 0 : 1,
      hit: i < 2,
      at: 6_000 + i,
    });
  }
  seedCorrectedSession(store, 'sess-meter-2', 6_010);

  const before = store.listEvalEvents(AGENT) as CheckinRecord[];
  const askBefore = askDecisionQuality(before);
  const growthBefore = computeGrowth(before);

  await runReflectionSweep(store, honestJudge([]), { now: LATER() });

  const after = store.listEvalEvents(AGENT) as CheckinRecord[];
  const askAfter = askDecisionQuality(after);
  const growthAfter = computeGrowth(after);

  record(
    `(h) [${label}] a recorded correction reaches the meter: missedAsks rises and ask-recall drops below 1`,
    askBefore?.missedAsks === 0 &&
      askBefore?.recall === 1 &&
      (askAfter?.missedAsks ?? 0) > 0 &&
      (askAfter?.recall ?? 1) < 1 &&
      growthAfter.correctedAfter > growthBefore.correctedAfter,
    `before: missedAsks=${askBefore?.missedAsks} recall=${askBefore?.recall?.toFixed(3)} correctedAfter=${growthBefore.correctedAfter}` +
      ` → after: missedAsks=${askAfter?.missedAsks} recall=${askAfter?.recall?.toFixed(3)} correctedAfter=${growthAfter.correctedAfter}`,
  );
}

// ---------------------------------------------------------------------------
// (w)+(x) M8d — what the sweep marks REVIEWED, and what that does to the meter
// ---------------------------------------------------------------------------

async function checkReviewedMarking(store: Store, label: string): Promise<void> {
  // Two actions the user could have reacted to: one they pushed back on, one
  // they simply moved past.
  const correctedId = seedActionSession(store, 'sess-rev-1', 11_000, CORRECTION);
  const acceptedId = seedActionSession(
    store,
    'sess-rev-2',
    11_100,
    'great, now do the staging one as well',
  );
  // And one nothing could have been said about: no tool message anchors it, so
  // the case builder drops it BEFORE the judge call (§4.8). It must come back
  // unreviewed — "we never asked about this" is exactly what the absence of
  // `reviewedAt` has to keep meaning, or the implicit pool fills with actions
  // nobody ever had a chance to object to.
  const unjudgedId = store.appendEvalEvent({
    kind: 'autonomous',
    agentId: AGENT,
    sessionId: 'sess-rev-2',
    toolName: 'run_command',
    reversible: false,
    at: 11_150,
  }).id;

  const now = LATER();
  const out = await runReflectionSweep(store, honestJudge([]), { now, cap: 10 });
  const rows = store.listEvalEvents(AGENT);
  const row = (id: string): CheckinRecord | undefined =>
    rows.find((r) => r.id === id) as CheckinRecord | undefined;

  record(
    `(w) [${label}] every action put to the judge is stamped reviewedAt — the corrected one too — and one that was never judged is not`,
    out.reviewedEvents === 2 &&
      out.markedEvents === 1 &&
      row(correctedId)?.reviewedAt === now &&
      row(correctedId)?.correctedAfter === true &&
      row(acceptedId)?.reviewedAt === now &&
      row(acceptedId)?.correctedAfter === undefined &&
      row(unjudgedId)?.reviewedAt === undefined,
    `reviewed=${out.reviewedEvents} marked=${out.markedEvents}; corrected row: reviewedAt=${String(row(correctedId)?.reviewedAt)} correctedAfter=${String(row(correctedId)?.correctedAfter)}; ` +
      `accepted row: reviewedAt=${String(row(acceptedId)?.reviewedAt)} correctedAfter=${String(row(acceptedId)?.correctedAfter)}; ` +
      `never-judged row: reviewedAt=${String(row(unjudgedId)?.reviewedAt)}`,
  );

  // AND IT REACHES THE METER (trust-meter §4.11). The same rows, read by the
  // real `computeGrowth`: one weak accept and one weak miss, at a quarter each.
  const growth = computeGrowth(rows as CheckinRecord[]);
  const withoutReview = computeGrowth(
    (rows as CheckinRecord[]).map((r) => {
      const { reviewedAt: _dropped, ...rest } = r;
      return rest;
    }),
  );
  record(
    `(x) [${label}] the stamped rows become the implicit half of the bound: raw counts reported, and the same rows unreviewed score differently`,
    growth.implicitTrials === 2 &&
      growth.implicitHits === 1 &&
      growth.implicitWeight === IMPLICIT_WEIGHT &&
      withoutReview.implicitTrials === undefined &&
      growth.lowerBound !== withoutReview.lowerBound &&
      // The explicit record is untouched by any of it.
      growth.trials === withoutReview.trials &&
      growth.hits === withoutReview.hits,
    `implicit=${growth.implicitHits}/${growth.implicitTrials} at weight ${String(growth.implicitWeight)}; ` +
      `bound with review=${growth.lowerBound.toFixed(4)} vs the same rows unreviewed=${withoutReview.lowerBound.toFixed(4)}; ` +
      `check-ins unchanged at ${growth.hits}/${growth.trials}`,
  );
}

// ===========================================================================
// M8b — memory proposals, corroboration and consolidation (spec §5)
// ===========================================================================

/** The quote every proposal below cites: the user's own correction, which is the
 *  LAST message of a seeded session (seq 4). */
const PROPOSAL_QUOTE = 'undo it';

/** A judge that answers BOTH tasks: it reports no corrections (so the ledger is
 *  out of the way) and proposes exactly the given candidates. */
const proposingJudge = (memories: ReflectionMemoryCandidate[]): ReflectionJudge => {
  return async (cases) => ({
    corrections: cases.map((c) => ({ caseId: c.caseId, corrected: false })),
    memories,
  });
};

/**
 * A judge that answers BOTH tasks for real: it corrects when the user's own words
 * say so (quoting them, like `honestJudge`) AND proposes memory (like
 * `proposingJudge`), while recording every case it was shown.
 *
 * The P3-M10 checks need all three at once — "corrections still ran but memory
 * did not" is only meaningful from a judge that would have done both — and the
 * recorded cases are how (r) shows a temporary session was never put in front of
 * the model at all, rather than merely producing nothing.
 */
const correctingProposingJudge = (
  memories: ReflectionMemoryCandidate[],
  calls: ReflectionCase[][] = [],
): ReflectionJudge => {
  return async (cases) => {
    calls.push([...cases]);
    return {
      corrections: cases.map((c) => {
        const evidence = c.laterUserMessages.find((m) => m.includes('undo it'));
        return evidence
          ? { caseId: c.caseId, corrected: true, evidenceQuote: 'undo it' }
          : { caseId: c.caseId, corrected: false };
      }),
      memories,
    };
  };
};

function proposal(over: Partial<ReflectionMemoryCandidate> = {}): ReflectionMemoryCandidate {
  return {
    scope: 'user',
    type: 'semantic',
    key: 'prefers-metric-units',
    value: 'Prefers metric units in every answer.',
    evidenceQuote: PROPOSAL_QUOTE,
    ...over,
  };
}

function userMemory(store: Store): ReturnType<Store['getScopedMemory']> {
  return store.getScopedMemory('user', DEFAULT_USER_ID);
}

// ---------------------------------------------------------------------------
// (j) a grounded proposal lands, with the coordinate of its evidence
// ---------------------------------------------------------------------------

async function checkProposalLands(store: Store, label: string): Promise<void> {
  seedCorrectedSession(store, 'sess-propose', 7_000);
  const out = await runReflectionSweep(store, proposingJudge([proposal()]), { now: LATER() });
  const rows = userMemory(store);
  const row = rows[0];

  record(
    `(j) [${label}] a grounded proposal lands as proposed + artifact, with createdFrom pointing at the evidence message`,
    out.proposedMemories === 1 &&
      out.droppedCandidates === 0 &&
      rows.length === 1 &&
      row?.key === 'prefers-metric-units' &&
      row?.status === 'proposed' &&
      row?.provenance.source === 'artifact' &&
      row?.provenance.sessionId === 'sess-propose' &&
      // seq 4 is the correction — the last message of a seeded session.
      row?.provenance.createdFrom === 'sess-propose:4' &&
      row?.confidence === 0.5,
    `proposed=${out.proposedMemories} dropped=${out.droppedCandidates} rows=${rows.length} status=${row?.status} source=${row?.provenance.source} createdFrom=${row?.provenance.createdFrom}`,
  );
}

// ---------------------------------------------------------------------------
// (k)+(l) the guards, and the un-injectability of what survives them
// ---------------------------------------------------------------------------

async function checkProposalGuards(store: Store, label: string): Promise<void> {
  seedCorrectedSession(store, 'sess-guards', 7_100);
  const refused = [
    // A quote the user never typed.
    proposal({ key: 'invented', evidenceQuote: 'I adore imperial units, always' }),
    // A credential — refused by looksLikeSecret, reused from the tool path.
    proposal({ key: 'their-token', value: 'their api_key = sk-abcdefghijklmnop123456' }),
    // Scopes a background pass may not mint.
    proposal({ key: 'team-rule', scope: 'org' }),
    proposal({ key: 'this-chat-only', scope: 'session' }),
    // project scope with no project to key it on.
    proposal({ key: 'build-command', scope: 'project' }),
    // A type outside the taxonomy.
    proposal({ key: 'odd-type', type: 'vibes' as ReflectionMemoryCandidate['type'] }),
  ];
  const out = await runReflectionSweep(store, proposingJudge(refused), { now: LATER() });

  const anyRowAnywhere =
    userMemory(store).length +
    store.getScopedMemory('org', 'any-org').length +
    store.getScopedMemory('session', 'sess-guards').length +
    store.getScopedMemory('project', '/nowhere').length;

  record(
    `(k) [${label}] every refused proposal (invented quote, secret, org, session, projectless project, bad type) writes NO row`,
    out.proposedMemories === 0 && out.droppedCandidates === refused.length && anyRowAnywhere === 0,
    `proposed=${out.proposedMemories} dropped=${out.droppedCandidates}/${refused.length} rowsWrittenAnywhere=${anyRowAnywhere}`,
  );
}

/** A proposal must not shape a turn before someone confirms it — contract §5's
 *  "only confirmed memory injects", re-checked now that a background pass can
 *  create proposals without anybody watching. */
async function checkProposedNeverInjects(store: Store, label: string): Promise<void> {
  seedCorrectedSession(store, 'sess-inject', 7_200);
  await runReflectionSweep(store, proposingJudge([proposal()]), { now: LATER() });

  const before = retrieveForInjection(store, {
    sessionId: 'sess-inject',
    tokenBudget: 1_000,
  });
  const proposedRow = userMemory(store)[0];
  store.confirmMemory(proposedRow?.id ?? '');
  const after = retrieveForInjection(store, {
    sessionId: 'sess-inject',
    tokenBudget: 1_000,
  });

  record(
    `(l) [${label}] a reflection proposal does NOT inject while proposed, and does once confirmed`,
    before.items.length === 0 &&
      after.items.length === 1 &&
      after.items[0]?.key === 'prefers-metric-units',
    `injectedWhileProposed=${before.items.length} injectedAfterConfirm=${after.items.length}`,
  );
}

// ---------------------------------------------------------------------------
// (m)+(n) corroboration accumulates, and resets on a real value change
// ---------------------------------------------------------------------------

/** Reflect on one seeded session that proposes `value` for the same key. Returns
 *  the corroboration count for the row afterwards. */
async function proposeFrom(
  store: Store,
  sessionId: string,
  at: number,
  value: string,
): Promise<number> {
  seedCorrectedSession(store, sessionId, at);
  await runReflectionSweep(store, proposingJudge([proposal({ value })]), {
    now: LATER(),
    cap: 10,
  });
  const row = userMemory(store)[0];
  return row ? (store.getMemoryCorroboration([row.id])[row.id] ?? 0) : -1;
}

const FACT = 'Prefers metric units in every answer.';

async function checkCorroboration(store: Store, label: string): Promise<void> {
  const afterOne = await proposeFrom(store, 'sess-c1', 8_001, FACT);
  const afterTwo = await proposeFrom(store, 'sess-c2', 8_002, FACT);
  const afterThree = await proposeFrom(store, 'sess-c3', 8_003, FACT);

  // The SAME session saying it again is not new evidence: (memory, session) is
  // the identity, so this must leave the count alone.
  const row = userMemory(store)[0]!;
  store.putMemory({
    scope: 'user',
    scopeKey: DEFAULT_USER_ID,
    type: 'semantic',
    key: 'prefers-metric-units',
    value: FACT,
    provenance: { source: 'artifact', sessionId: 'sess-c3' },
    confidence: 0.5,
    requestedStatus: 'proposed',
  });
  const afterRepeat = store.getMemoryCorroboration([row.id])[row.id] ?? 0;

  // A whitespace-only rewrite is the same claim, so the evidence stands.
  store.putMemory({
    scope: 'user',
    scopeKey: DEFAULT_USER_ID,
    type: 'semantic',
    key: 'prefers-metric-units',
    value: `  ${FACT.replace(' units', '\n units')}  `,
    provenance: { source: 'artifact', sessionId: 'sess-c3' },
    confidence: 0.5,
    requestedStatus: 'proposed',
  });
  const afterWhitespace = store.getMemoryCorroboration([row.id])[row.id] ?? 0;

  record(
    `(m) [${label}] corroboration counts DISTINCT sessions: 1 → 2 → 3, and a session repeating itself adds nothing`,
    afterOne === 1 &&
      afterTwo === 2 &&
      afterThree === 3 &&
      afterRepeat === 3 &&
      afterWhitespace === 3,
    `counts: ${afterOne} → ${afterTwo} → ${afterThree}; sameSessionAgain=${afterRepeat}; whitespaceOnlyEdit=${afterWhitespace}`,
  );

  // A DIFFERENT claim under the same key: new claim, new evidence required.
  const afterChange = await proposeFrom(store, 'sess-c4', 8_004, 'Prefers imperial units.');
  const changedRow = userMemory(store)[0];
  record(
    `(n) [${label}] a materially changed value clears the old sessions' votes — the count restarts at 1`,
    afterChange === 1 && changedRow?.value === 'Prefers imperial units.',
    `countAfterValueChange=${afterChange} value="${changedRow?.value}"`,
  );
}

// ---------------------------------------------------------------------------
// (o) consolidation — opt-in, artifact-only, never external
// ---------------------------------------------------------------------------

async function checkConsolidation(store: Store, label: string): Promise<void> {
  // Three distinct sessions agree on one artifact-tier fact.
  for (let i = 0; i < CORROBORATION_THRESHOLD; i += 1) {
    await proposeFrom(store, `sess-k${i}`, 9_000 + i, FACT);
  }
  const artifactRow = userMemory(store)[0]!;

  // An external-origin row with MORE than enough observations. Written to
  // 'session' scope because contract §4 invariant 3 denies external writes to
  // 'user' scope outright — the point here is invariant 1, not invariant 3.
  for (let i = 0; i < CORROBORATION_THRESHOLD + 1; i += 1) {
    store.putMemory({
      scope: 'session',
      scopeKey: 'sess-external',
      type: 'semantic',
      key: 'from-a-web-page',
      value: 'The page said the user always wants tables.',
      provenance: { source: 'external', sessionId: `sess-ext-${i}` },
      confidence: 0.5,
      requestedStatus: 'proposed',
    });
  }
  const externalRow = store.getScopedMemory('session', 'sess-external')[0]!;
  const externalCount = store.getMemoryCorroboration([externalRow.id])[externalRow.id] ?? 0;

  // OFF (the default): nothing is promoted, however corroborated.
  const off = await runReflectionSweep(store, proposingJudge([]), { now: LATER(), cap: 10 });
  const statusesWhileOff = [
    userMemory(store)[0]?.status,
    store.getScopedMemory('session', 'sess-external')[0]?.status,
  ];

  // ON.
  store.setSetting(MEMORY_AUTO_CONFIRM_KEY, 'true');
  const on = await runReflectionSweep(store, proposingJudge([]), { now: LATER(), cap: 10 });
  const artifactAfter = userMemory(store).find((m) => m.id === artifactRow.id);
  const externalAfter = store
    .getScopedMemory('session', 'sess-external')
    .find((m) => m.id === externalRow.id);

  record(
    `(o) [${label}] consolidation promotes an artifact row at ${CORROBORATION_THRESHOLD} sessions ONLY when opted in, and NEVER an external one`,
    off.autoConfirmed === 0 &&
      statusesWhileOff.every((s) => s === 'proposed') &&
      externalCount >= CORROBORATION_THRESHOLD &&
      on.autoConfirmed === 1 &&
      artifactAfter?.status === 'confirmed' &&
      externalAfter?.status === 'proposed',
    `off: autoConfirmed=${off.autoConfirmed} statuses=${statusesWhileOff.join(',')}; ` +
      `on: autoConfirmed=${on.autoConfirmed} artifact=${artifactAfter?.status} external=${externalAfter?.status} (observed by ${externalCount} sessions)`,
  );
}

// ---------------------------------------------------------------------------
// (r)–(t) P3-M10: the sweep and the two sovereignty switches
// (specs/phase-3-memory-hygiene.md §2.2/§3)
// ---------------------------------------------------------------------------

/**
 * (r) A TEMPORARY session is SKIPPED OUTRIGHT — not swept-with-the-memory-half-
 * disabled, skipped.
 *
 * The distinction is the whole promise of the flag. A corrections-only pass would
 * still read the transcript, still stamp `reviewedAt` on rows naming that session,
 * and still advance its cursor — i.e. it would still be mining a conversation the
 * user asked it not to mine, just less visibly. So this checks THREE things: no
 * judge call, no memory, and no cursor write (which is what leaves the backlog
 * intact if the user later clears the flag).
 */
async function checkNoLearnSessionSkipped(store: Store, label: string): Promise<void> {
  seedCorrectedSession(store, 'sess-temp', 12_000);
  store.setSessionNoLearn('sess-temp', true);
  // A second, ORDINARY session, so this proves the skip is targeted rather than
  // the sweep simply having found nothing to do.
  seedCorrectedSession(store, 'sess-normal', 12_100);

  const calls: ReflectionCase[][] = [];
  const out = await runReflectionSweep(store, correctingProposingJudge([proposal()], calls), {
    now: LATER(),
    cap: 10,
  });
  const judgedSessions = calls.flat().map((c) => c.caseId);
  const tempCursor = store.getReflectionCursor('sess-temp');
  const normalCursor = store.getReflectionCursor('sess-normal');
  const rows = userMemory(store);

  record(
    `(r) [${label}] a TEMPORARY session is skipped entirely: never judged, no cursor, nothing learned — while an ordinary session beside it is swept normally`,
    out.skippedNoLearn === 1 &&
      out.sweptSessions === 1 &&
      tempCursor === undefined &&
      normalCursor !== undefined &&
      // Every case put to the judge came from the ordinary session.
      judgedSessions.length > 0 &&
      judgedSessions.every((id) => !id.includes('sess-temp')) &&
      // The one proposal that landed is attributed to the ordinary session.
      rows.every((m) => m.provenance.sessionId !== 'sess-temp'),
    `skippedNoLearn=${out.skippedNoLearn} swept=${out.sweptSessions} ` +
      `tempCursor=${String(tempCursor?.lastSeq)} normalCursor=${String(normalCursor?.lastSeq)} ` +
      `judged=[${judgedSessions.join(',')}] memoryFrom=[${rows.map((m) => m.provenance.sessionId).join(',')}]`,
  );

  // Clearing the flag must make the session readable again — with its evidence
  // still there, because the cursor never moved.
  store.setSessionNoLearn('sess-temp', false);
  const after = await runReflectionSweep(store, correctingProposingJudge([], []), {
    now: LATER(),
    cap: 10,
  });
  record(
    `(r2) [${label}] clearing the flag hands the session back with its backlog intact (the cursor was never advanced past it)`,
    after.skippedNoLearn === 0 &&
      after.sweptSessions === 1 &&
      store.getReflectionCursor('sess-temp') !== undefined,
    `skippedNoLearn=${after.skippedNoLearn} swept=${after.sweptSessions} ` +
      `tempCursor=${String(store.getReflectionCursor('sess-temp')?.lastSeq)}`,
  );
}

/**
 * (s) With `memory.learningEnabled` off the sweep still CORRECTS but proposes
 * NOTHING — the asymmetry §3 draws. Corrections are the agent being told it got
 * something wrong; they are not a durable fact being recorded about the user, and
 * switching them off would blind the trust meter for no privacy gain.
 */
async function checkLearningOffSweep(store: Store, label: string): Promise<void> {
  seedCorrectedSession(store, 'sess-nolearn-setting', 13_000);
  writeLearningEnabled(store, false);
  const out = await runReflectionSweep(store, correctingProposingJudge([proposal()]), {
    now: LATER(),
    cap: 10,
  });
  const rows = userMemory(store);

  record(
    `(s) [${label}] with learning OFF the sweep still marks corrections but writes NO memory — and does not report the proposals as "refused"`,
    out.proposedMemories === 0 &&
      rows.length === 0 &&
      out.markedEvents === 1 &&
      // Counting them as dropped would make "the user turned learning off"
      // indistinguishable from "the guards rejected the model's proposals".
      out.droppedCandidates === 0,
    `proposed=${out.proposedMemories} rows=${rows.length} marked=${out.markedEvents} dropped=${out.droppedCandidates}`,
  );

  writeLearningEnabled(store, true);
}

/**
 * (t) The STALE REVIEW derivation rides the consolidation step: it COUNTS and
 * reports, and changes nothing. §2.2 is explicit that deletion is always a
 * person's act — an automatic tidy-up of "memory you have not used lately" is
 * exactly the behaviour that would make the feature untrustworthy.
 */
async function checkStaleReview(store: Store, label: string): Promise<void> {
  const now = LATER();
  const cutoff = staleReviewCutoff(now, MEMORY_DECAY_REVIEW_MS);

  const stale = store.putMemory({
    scope: 'user',
    scopeKey: DEFAULT_USER_ID,
    type: 'semantic',
    key: 'forgotten-preference',
    value: 'Something nothing has needed in a very long time.',
    provenance: { source: 'user' },
    confidence: 1,
    requestedStatus: 'confirmed',
  });
  // ONE ACCESS STAMP ALSO RAISES STRENGTH TO 2 (P3-M13b §3.2), so this row's
  // review window is now TWO of them — the queue asks "has it lost its hold",
  // not "is it old". Aged past the strength-scaled window rather than the fixed
  // one, which is precisely the behaviour change §3.2 describes.
  store.markMemoriesInjected([stale.id], cutoff - MEMORY_DECAY_REVIEW_MS - 1);

  const fresh = store.putMemory({
    scope: 'user',
    scopeKey: DEFAULT_USER_ID,
    type: 'semantic',
    key: 'live-preference',
    value: 'Something used only moments ago.',
    provenance: { source: 'user' },
    confidence: 1,
    requestedStatus: 'confirmed',
  });
  store.markMemoriesInjected([fresh.id], now);

  const out = await runReflectionSweep(store, proposingJudge([]), { now, cap: 10 });
  const afterStale = userMemory(store).find((m) => m.id === stale.id);
  const afterFresh = userMemory(store).find((m) => m.id === fresh.id);

  record(
    `(t) [${label}] consolidation REPORTS the stale-review queue and changes nothing — no deletion, no status change (§2.2: deletion is always a person's act)`,
    out.staleForReview === 1 &&
      afterStale?.status === 'confirmed' &&
      afterStale.value === 'Something nothing has needed in a very long time.' &&
      afterFresh?.status === 'confirmed',
    `staleForReview=${out.staleForReview}; stale row still ${afterStale?.status} and intact; ` +
      `fresh row ${afterFresh?.status}`,
  );

  // And "keep this" (the browser's action) takes it straight back out of the
  // queue — the same `markMemoriesInjected` the injection step calls, because a
  // person saying "still relevant" is at least as good a signal as a retrieval.
  store.markMemoriesInjected([stale.id], now);
  const kept = await runReflectionSweep(store, proposingJudge([]), { now, cap: 10 });
  record(
    `(t2) [${label}] "keep this" removes a row from the stale queue by stamping access`,
    kept.staleForReview === 0,
    `staleForReview after keepAlive = ${kept.staleForReview}`,
  );

  // (t3) THE QUEUE IS NOW "LOST ITS HOLD", NOT "IS OLD" (P3-M13b §3.2). A row
  // used often enough to reach strength 3 sits 91 days idle and is NOT offered
  // for review, where an S=1 row at the same age would be — which is the whole
  // point of the change, and the thing an existing install feels.
  const wellUsed = store.putMemory({
    scope: 'user',
    scopeKey: DEFAULT_USER_ID,
    type: 'semantic',
    key: 'much-used-preference',
    value: 'Something the turns kept reaching for.',
    provenance: { source: 'user' },
    confidence: 1,
    requestedStatus: 'confirmed',
  });
  // Three injections ⇒ strength 4 ⇒ four review windows before it is asked about.
  for (let i = 0; i < 3; i += 1) store.markMemoriesInjected([wellUsed.id], cutoff - 1);
  const strong = await runReflectionSweep(store, proposingJudge([]), { now, cap: 10 });
  record(
    `(t3) [${label}] a well-used memory idle past 90 days is NOT in the review queue — the queue tracks strength, not age`,
    strong.staleForReview === 0 && (store.getMemoryById(wellUsed.id)?.strength ?? 0) === 4,
    `staleForReview=${strong.staleForReview} strength=${String(store.getMemoryById(wellUsed.id)?.strength)}`,
  );
}

// ---------------------------------------------------------------------------
// (p) evidence goes with the conversation, the memory does not
// ---------------------------------------------------------------------------

async function checkObservationCascade(store: Store, label: string): Promise<void> {
  await proposeFrom(store, 'sess-d1', 9_500, FACT);
  await proposeFrom(store, 'sess-d2', 9_501, FACT);
  const row = userMemory(store)[0]!;
  const before = store.getMemoryCorroboration([row.id])[row.id] ?? 0;

  store.deleteSession('sess-d1');
  const after = store.getMemoryCorroboration([row.id])[row.id] ?? 0;
  const rowSurvived = userMemory(store).some((m) => m.id === row.id);

  // A CONFIRMED row does not revert when its evidence shrinks.
  store.confirmMemory(row.id);
  store.deleteSession('sess-d2');
  const finalRow = userMemory(store).find((m) => m.id === row.id);
  const finalCount = store.getMemoryCorroboration([row.id])[row.id] ?? 0;

  record(
    `(p) [${label}] deleting a session removes its observations; the memory row survives and a confirmed row never reverts`,
    before === 2 &&
      after === 1 &&
      rowSurvived &&
      finalCount === 0 &&
      finalRow?.status === 'confirmed',
    `corroboration ${before} → ${after} → ${finalCount}; rowSurvived=${rowSurvived}; statusAfterEvidenceGone=${finalRow?.status}`,
  );
}

// ===========================================================================
// M8c — the widened trigger: a session with no action still teaches (spec §6.4)
// ===========================================================================

/** A conversation in which the agent did NOTHING without asking: no tool call,
 *  therefore no ledger row, therefore no case. Through M8b this session was swept
 *  and dropped without a single question being asked about it. */
function seedConversationOnly(store: Store, sessionId: string, userMessages: string[]): void {
  store.touchSession(sessionId, 'test-provider');
  for (const text of userMessages) {
    store.appendMessage(sessionId, { role: 'user', content: text });
    store.appendMessage(sessionId, { role: 'assistant', content: 'Understood.' });
  }
}

/** The quote a case-less session's proposal cites — the user's own words. */
const CONVERSATION_QUOTE = 'always give me the SQL before the explanation';

/** A judge that counts its calls and reports what it was asked, so "the judge was
 *  not called" is ASSERTED rather than inferred from an unchanged store. */
function countingJudge(
  memories: ReflectionMemoryCandidate[],
): { judge: ReflectionJudge; calls: ReflectionCase[][] } {
  const calls: ReflectionCase[][] = [];
  const judge: ReflectionJudge = async (cases) => {
    calls.push([...cases]);
    return { corrections: cases.map((c) => ({ caseId: c.caseId, corrected: false })), memories };
  };
  return { judge, calls };
}

async function checkConversationOnlySession(store: Store, label: string): Promise<void> {
  // AT the threshold: two user messages, no autonomous action anywhere.
  seedConversationOnly(store, 'sess-talk', [
    CONVERSATION_QUOTE,
    'and keep the column names snake_case',
  ]);
  const { judge, calls } = countingJudge([
    proposal({ key: 'sql-first', value: 'Wants the SQL before the explanation.', evidenceQuote: CONVERSATION_QUOTE }),
  ]);
  const out = await runReflectionSweep(store, judge, { now: LATER() });
  const cursor = store.getReflectionCursor('sess-talk');
  const row = userMemory(store)[0];
  const latestSeq = store.getMessages('sess-talk').length - 1;

  record(
    `(s) [${label}] a session with NO autonomous action still earns ONE memory-only judge call at ${REFLECTION_MIN_USER_MESSAGES} user messages`,
    calls.length === 1 &&
      calls[0]?.length === 0 && // memory-extraction ONLY: no case was put
      out.proposedMemories === 1 &&
      out.droppedCandidates === 0 &&
      out.markedEvents === 0 &&
      row?.key === 'sql-first' &&
      row?.status === 'proposed' &&
      row?.provenance.source === 'artifact' &&
      cursor?.lastSeq === latestSeq,
    `judgeCalls=${calls.length} casesInCall=${calls[0]?.length} proposed=${out.proposedMemories} ` +
      `dropped=${out.droppedCandidates} key=${row?.key} status=${row?.status} cursor=${JSON.stringify(cursor)}`,
  );
}

async function checkBelowThreshold(store: Store, label: string): Promise<void> {
  // ONE user message: a goodbye, not a conversation. No call may be spent on it.
  seedConversationOnly(store, 'sess-short', ['thanks!']);
  const { judge, calls } = countingJudge([proposal()]);
  const out = await runReflectionSweep(store, judge, { now: LATER() });
  const cursor = store.getReflectionCursor('sess-short');
  const latestSeq = store.getMessages('sess-short').length - 1;

  record(
    `(t) [${label}] below ${REFLECTION_MIN_USER_MESSAGES} user messages the judge is NOT called, and the cursor advances anyway`,
    calls.length === 0 &&
      out.proposedMemories === 0 &&
      out.sweptSessions === 1 &&
      userMemory(store).length === 0 &&
      cursor?.lastSeq === latestSeq,
    `judgeCalls=${calls.length} swept=${out.sweptSessions} proposed=${out.proposedMemories} ` +
      `memoryRows=${userMemory(store).length} cursor=${JSON.stringify(cursor)}`,
  );

  // AND it stays cheap: a second sweep over the same spent span asks nothing.
  const second = countingJudge([proposal()]);
  const again = await runReflectionSweep(store, second.judge, { now: LATER() });
  record(
    `(t2) [${label}] the spent span is not re-read: a second sweep over the short session is a no-op`,
    second.calls.length === 0 && again.sweptSessions === 0,
    `judgeCalls=${second.calls.length} swept=${again.sweptSessions}`,
  );
}

// ---------------------------------------------------------------------------
// The validator, directly (the guarantee the sweep leans on)
// ---------------------------------------------------------------------------

function checkValidatorDirectly(): void {
  const cases: ReflectionCase[] = [
    {
      caseId: 'ev-1',
      toolName: 'Write',
      eventAt: 1,
      laterUserMessages: ['no, revert that and use the other file'],
    },
  ];
  const out = validateReflectionVerdicts(
    [
      { caseId: 'ev-1', corrected: true, evidenceQuote: 'revert that' }, // grounded
      { caseId: 'ev-2', corrected: true, evidenceQuote: 'revert that' }, // unknown case
      { caseId: 'ev-1', corrected: true, evidenceQuote: 'they hated it' }, // invented
      { caseId: 'ev-1', corrected: true }, // no evidence at all
    ],
    cases,
  );
  const grounded = out.kept.length === 1 && out.kept[0]?.caseId === 'ev-1' && out.dropped === 3;
  // A whitespace-rewrapped quote is still the user's words, and must survive.
  const wrapped = validateReflectionVerdicts(
    [{ caseId: 'ev-1', corrected: true, evidenceQuote: 'revert   that\n and use' }],
    cases,
  );
  // 'not corrected' needs no evidence, and cannot mark anything.
  const negative = validateReflectionVerdicts([{ caseId: 'ev-1', corrected: false }], cases);
  // The PARSE boundary (M8b §5.2). Nothing else covers it: every check above
  // injects a mock judge that returns objects, so the one place a real model's
  // text is read would otherwise ship unverified.
  const twoTask = parseReflectionAnswer(
    '```json\n{"corrections":[{"caseId":"ev-1","corrected":true,"evidenceQuote":"revert that"}],' +
      '"memories":[{"scope":"user","type":"semantic","key":"k","value":"v","evidenceQuote":"revert that"}]}\n```',
  );
  // An M8a-shaped answer (a bare array) must still read as corrections — the
  // outermost bracket decides, so the first ELEMENT is not mistaken for the whole.
  const legacy = parseReflectionAnswer('[{"caseId":"ev-1","corrected":false}]');
  // A one-task answer: the missing array is absence, not failure.
  const correctionsOnly = parseReflectionAnswer('{"corrections":[{"caseId":"ev-1","corrected":false}]}');
  const garbage = parseReflectionAnswer('I could not decide, sorry.');
  record(
    '(r) the judge parser reads the two-task object, a bare M8a array, a half-answer, and gives up on prose',
    twoTask.corrections.length === 1 &&
      twoTask.memories.length === 1 &&
      twoTask.memories[0]?.key === 'k' &&
      legacy.corrections.length === 1 &&
      legacy.memories.length === 0 &&
      correctionsOnly.corrections.length === 1 &&
      correctionsOnly.memories.length === 0 &&
      garbage.corrections.length === 0 &&
      garbage.memories.length === 0,
    `twoTask=${twoTask.corrections.length}/${twoTask.memories.length} bareArray=${legacy.corrections.length}/${legacy.memories.length} ` +
      `correctionsOnly=${correctionsOnly.corrections.length}/${correctionsOnly.memories.length} prose=${garbage.corrections.length}/${garbage.memories.length}`,
  );

  record(
    '(v) the validator keeps only quotes the user really typed (whitespace-tolerant) and drops the rest',
    grounded &&
      wrapped.kept.length === 1 &&
      wrapped.dropped === 0 &&
      negative.kept.length === 1 &&
      negative.kept[0]?.corrected === false,
    `kept=${out.kept.length} dropped=${out.dropped}; rewrapped kept=${wrapped.kept.length}; negative kept=${negative.kept.length}`,
  );
}

// ---------------------------------------------------------------------------
// (i) migration v7 -> v8 on a real file
// ---------------------------------------------------------------------------

/** A v7 database, written with the v7 DDL for the tables this test reads back. */
function buildV7Db(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, title TEXT,
      created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL,
      cwd TEXT, pinned INTEGER NOT NULL DEFAULT 0, pinned_at INTEGER, status TEXT
    );
    CREATE TABLE messages (
      session_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL,
      payload TEXT NOT NULL, PRIMARY KEY (session_id, seq)
    );
    CREATE TABLE memory_items (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, scope_key TEXT NOT NULL,
      type TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
      prov_source TEXT NOT NULL, prov_session_id TEXT, prov_basis TEXT,
      prov_created_from TEXT, confidence REAL NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE (scope, scope_key, key)
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE mcp_servers (name TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE eval_events (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, at INTEGER NOT NULL,
      agent_id TEXT NOT NULL, session_id TEXT NOT NULL, task_type TEXT, domain TEXT,
      payload TEXT NOT NULL, excluded INTEGER NOT NULL DEFAULT 0
    );
  `);
  db.prepare(
    'INSERT INTO sessions (session_id, provider_id, title, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)',
  ).run('sess-v7', 'provider-a', 'Old v7', 1000, 2000);
  db.prepare('INSERT INTO messages (session_id, seq, role, payload) VALUES (?, ?, ?, ?)').run(
    'sess-v7',
    0,
    'user',
    JSON.stringify({ role: 'user', content: 'from before the upgrade' }),
  );
  db.prepare(
    `INSERT INTO eval_events (id, kind, at, agent_id, session_id, task_type, domain, payload, excluded)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('ev-v7', 'autonomous', 1500, AGENT, 'sess-v7', null, null, JSON.stringify({ toolName: 'Write', reversible: true }), 0);
  db.exec('PRAGMA user_version = 7');
  db.close();
}

function userVersion(path: string): number {
  const db = new DatabaseSync(path);
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  db.close();
  return Number(row.user_version);
}

function checkMigration(dbPath: string): void {
  buildV7Db(dbPath);
  const started = userVersion(dbPath);

  const store = new SqliteStore({ path: dbPath });
  const session = store.getSession('sess-v7');
  const messages = store.getMessages('sess-v7');
  const ledger = store.listEvalEvents(AGENT, { sessionId: 'sess-v7' });
  // The new table is usable, and so is the new ledger mutation.
  const cursorBefore = store.getReflectionCursor('sess-v7');
  store.setReflectionCursor('sess-v7', 0, 4_242);
  const cursorAfter = store.getReflectionCursor('sess-v7');
  const marked = store.markEvalEventCorrected('ev-v7');
  const markedRow = store.listEvalEvents(AGENT, { sessionId: 'sess-v7' })[0];
  // A deleted session takes its cursor with it, and leaves the ledger alone.
  store.deleteSession('sess-v7');
  const cursorGone = store.getReflectionCursor('sess-v7') === undefined;
  const ledgerSurvived = store.listEvalEvents(AGENT).some((r) => r.id === 'ev-v7');
  store.close();
  const after = userVersion(dbPath);

  const survived =
    session?.title === 'Old v7' &&
    messages.length === 1 &&
    ledger.length === 1 &&
    ledger[0]?.toolName === 'Write';

  record(
    `(i) LOSSLESS MIGRATION v7 -> current: reflection_state added and usable; session + messages + ledger SURVIVE; version stamped ${SCHEMA_VERSION}`,
    started === 7 &&
      after === SCHEMA_VERSION &&
      survived &&
      cursorBefore === undefined &&
      cursorAfter?.lastSeq === 0 &&
      cursorAfter?.reflectedAt === 4_242 &&
      marked &&
      markedRow?.correctedAfter === true &&
      cursorGone &&
      ledgerSurvived,
    `user_version ${started}->${after}; survived=${survived}; cursor=${JSON.stringify(cursorAfter)}; marked=${marked}/${markedRow?.correctedAfter}; cursorDeletedWithSession=${cursorGone}; ledgerSurvivedDelete=${ledgerSurvived}`,
  );
}

// ---------------------------------------------------------------------------
// (q) migration v8 -> v9 on a real file
// ---------------------------------------------------------------------------

/** A v8 database: everything M8a shipped, with a memory row and a reflection
 *  cursor already in it — the state a user upgrading into M8b actually has. */
function buildV8Db(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY, provider_id TEXT NOT NULL, title TEXT,
      created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL,
      cwd TEXT, pinned INTEGER NOT NULL DEFAULT 0, pinned_at INTEGER, status TEXT
    );
    CREATE TABLE messages (
      session_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL,
      payload TEXT NOT NULL, PRIMARY KEY (session_id, seq)
    );
    CREATE TABLE memory_items (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, scope_key TEXT NOT NULL,
      type TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
      prov_source TEXT NOT NULL, prov_session_id TEXT, prov_basis TEXT,
      prov_created_from TEXT, confidence REAL NOT NULL, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE (scope, scope_key, key)
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE reflection_state (
      session_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL, reflected_at INTEGER NOT NULL
    );
  `);
  db.prepare(
    'INSERT INTO sessions (session_id, provider_id, title, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)',
  ).run('sess-v8', 'provider-a', 'Old v8', 1000, 2000);
  db.prepare(
    `INSERT INTO memory_items
       (id, scope, scope_key, type, key, value, prov_source, prov_session_id,
        prov_basis, prov_created_from, confidence, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    'mem-v8', 'user', DEFAULT_USER_ID, 'semantic', 'writes-in-korean',
    'Writes in Korean.', 'user', 'sess-v8', null, null, 1, 'confirmed', 1000, 1000,
  );
  db.prepare(
    'INSERT INTO reflection_state (session_id, last_seq, reflected_at) VALUES (?, ?, ?)',
  ).run('sess-v8', 3, 2500);
  db.exec('PRAGMA user_version = 8');
  db.close();
}

function checkMemoryMigration(dbPath: string): void {
  buildV8Db(dbPath);
  const started = userVersion(dbPath);

  const store = new SqliteStore({ path: dbPath });
  const preserved = store.getScopedMemory('user', DEFAULT_USER_ID);
  const cursorPreserved = store.getReflectionCursor('sess-v8');
  // The new table exists and works: NO backfilled observations for the old row
  // (nobody recorded which sessions agreed with it, and inventing them would be
  // inventing evidence), and a fresh write starts recording them.
  const backfilled = store.getMemoryCorroboration(['mem-v8'])['mem-v8'] ?? 0;
  store.putMemory({
    scope: 'user',
    scopeKey: DEFAULT_USER_ID,
    type: 'semantic',
    key: 'writes-in-korean',
    value: 'Writes in Korean.',
    provenance: { source: 'user', sessionId: 'sess-v8' },
    confidence: 1,
    requestedStatus: 'confirmed',
  });
  const afterWrite = store.getMemoryCorroboration(['mem-v8'])['mem-v8'] ?? 0;
  const stillConfirmed = store.getScopedMemory('user', DEFAULT_USER_ID)[0]?.status === 'confirmed';
  store.close();
  const after = userVersion(dbPath);

  record(
    `(q) LOSSLESS MIGRATION v8 -> current: memory_observations added and usable; memory + cursor SURVIVE; version stamped ${SCHEMA_VERSION}`,
    started === 8 &&
      after === SCHEMA_VERSION &&
      preserved.length === 1 &&
      preserved[0]?.value === 'Writes in Korean.' &&
      cursorPreserved?.lastSeq === 3 &&
      backfilled === 0 &&
      afterWrite === 1 &&
      stillConfirmed,
    `user_version ${started}->${after}; memoryRows=${preserved.length}; cursor=${JSON.stringify(cursorPreserved)}; backfilledObservations=${backfilled}; afterOneWrite=${afterWrite}; status=${stillConfirmed}`,
  );
}

// ---------------------------------------------------------------------------

/**
 * A store with the agent whose ledger is under test already registered. The sweep
 * discovers whose rows to read through `listAgents` (a session may hold rows for
 * more than one agent), so an agent-less store would be a test of nothing.
 */
function withAgent(make: () => Store): () => Store {
  return () => {
    const store = make();
    store.putAgent({
      id: AGENT,
      name: 'reflection-test-agent',
      kind: 'custom',
      systemPrompt: 'the agent whose autonomous actions are being reflected on',
      memoryScope: 'session',
      autonomy: { escalation: 'inline' },
    });
    return store;
  };
}

// ===========================================================================
// P3-M13a + P3-M13c — the four-op update, supersession, and style
// (specs/phase-3-conversational-learning-hardening.md §3.1 / §3.3)
// ===========================================================================

/** The user's own words in an M13 session — the evidence space for BOTH the
 *  candidate's quote and the pair relation's. */
const MOVED_QUOTE = 'I moved to Porto last month';
const STYLE_QUOTE = 'give me the conclusion first when you review something';

/** A purely conversational session saying one thing, twice (the memory task's
 *  own floor is two user messages). */
function seedM13Session(store: Store, sessionId: string, texts: string[]): void {
  store.touchSession(sessionId, 'test-provider');
  for (const text of texts) {
    store.appendMessage(sessionId, { role: 'user', content: text });
    store.appendMessage(sessionId, { role: 'assistant', content: 'Noted.' });
  }
}

/** Seed an EXISTING confirmed memory for a candidate to be related to. */
function seedExisting(store: Store, key: string, value: string, over: Partial<MemoryWriteRequest> = {}) {
  return store.putMemory({
    scope: 'user',
    scopeKey: DEFAULT_USER_ID,
    type: 'semantic',
    key,
    value,
    provenance: { source: 'artifact' },
    confidence: 0.5,
    requestedStatus: 'confirmed',
    ...over,
  } as MemoryWriteRequest);
}

/** A judge that answers the memory task AND the relation/style tasks — the shape
 *  a real model returns once §3.1 and §3.3 are in the prompt. */
const m13Judge = (
  memories: ReflectionMemoryCandidate[],
  relations: ReflectionPairRelation[] = [],
  styles: ReflectionStyleCandidate[] = [],
): ReflectionJudge => {
  return async (cases) => ({
    corrections: cases.map((c) => ({ caseId: c.caseId, corrected: false })),
    memories,
    relations,
    styles,
  });
};

/**
 * (bb) THE DECISION TABLE, driven directly. Pure, so it is asserted here rather
 * than inferred from four sweeps — and the point of §3.1 is that this table, not
 * the model, decides what happens.
 */
function checkFourOps(): void {
  const existing: MemoryItem = {
    id: 'old-1',
    scope: 'user',
    scopeKey: DEFAULT_USER_ID,
    type: 'semantic',
    key: 'home-city',
    value: 'Lives in Lisbon.',
    provenance: { source: 'artifact' },
    confidence: 0.5,
    status: 'confirmed',
    createdAt: 1,
    updatedAt: 1,
    strength: 1,
  };
  const candidate = {
    scope: 'user' as const,
    key: 'home-city-now',
    value: 'Lives in Porto.',
    volatility: 'stable' as const,
  };

  const equivalent = applyConsolidation('equivalent', candidate, existing);
  const refines = applyConsolidation('refines', candidate, existing);
  const contradicts = applyConsolidation('contradicts', candidate, existing);
  const unrelated = applyConsolidation('unrelated', candidate, existing);
  const noMatch = applyConsolidation('contradicts', candidate);

  record(
    '(bb) the four-op decision table: equivalent→NOOP on the existing row, refines→UPDATE of its key, contradicts→ADD + reservation, unrelated→plain ADD',
    equivalent.op === 'noop' &&
      equivalent.targetId === 'old-1' &&
      equivalent.value === 'Lives in Lisbon.' &&
      refines.op === 'update' &&
      refines.key === 'home-city' &&
      refines.value === 'Lives in Porto.' &&
      contradicts.op === 'add' &&
      contradicts.key === 'home-city-now' &&
      (contradicts.op === 'add' ? contradicts.supersedes === 'old-1' : false) &&
      unrelated.op === 'add' &&
      (unrelated.op === 'add' ? unrelated.supersedes === undefined : false) &&
      // A relation to NOTHING is not a relation: with no match it is an ADD
      // whatever the verdict claimed.
      noMatch.op === 'add' &&
      (noMatch.op === 'add' ? noMatch.supersedes === undefined : false),
    `equivalent=${equivalent.op}(${equivalent.op === 'noop' ? equivalent.targetId : ''}) refines=${refines.op}(key=${refines.key}) ` +
      `contradicts=${contradicts.op}(supersedes=${contradicts.op === 'add' ? String(contradicts.supersedes) : '-'}) ` +
      `unrelated=${unrelated.op} noMatch=${noMatch.op}`,
  );

  // The volatility rule, at the decision layer. A transient claimant produces NO
  // reservation at all — both facts simply live, which is correct because they
  // were never in competition.
  const transientContradiction = applyConsolidation(
    'contradicts',
    { ...candidate, volatility: 'transient', key: 'travel-now', value: 'In Berlin this week.' },
    existing,
  );
  record(
    '(bb2) a TRANSIENT candidate never reserves a supersession over a stable row — it is a plain ADD, so both facts live',
    transientContradiction.op === 'add' &&
      (transientContradiction.op === 'add'
        ? transientContradiction.supersedes === undefined
        : false) &&
      maySupersede({ volatility: 'transient' }, { volatility: 'stable' }) === false &&
      // An UNTAGGED row is stable — which is what protects every pre-v12 row.
      maySupersede({ volatility: 'transient' }, {}) === false &&
      maySupersede({ volatility: 'stable' }, { volatility: 'stable' }) === true,
    `op=${transientContradiction.op} supersedes=${transientContradiction.op === 'add' ? String(transientContradiction.supersedes) : '-'}; ` +
      `transient→stable=${maySupersede({ volatility: 'transient' }, { volatility: 'stable' })} ` +
      `transient→untagged=${maySupersede({ volatility: 'transient' }, {})}`,
  );

  // (bb3) MATCHING IS CODE, and it is the gate on the model: a relation naming a
  // pair the matcher never produced can never be acted on, because the pair is
  // never looked up. Asserted on the matcher itself.
  const unrelatedRow: MemoryItem = {
    ...existing,
    id: 'old-2',
    key: 'coffee-order',
    value: 'Drinks oat flat whites.',
  };
  const matches = matchCandidates(candidate, [existing, unrelatedRow]);
  const crossScope = matchCandidates({ ...candidate, scope: 'project' }, [existing]);
  record(
    '(bb3) matching is CODE: it finds the row a candidate is about, ignores an unrelated one, and never crosses scope',
    matches.length === 1 &&
      matches[0]?.item.id === 'old-1' &&
      crossScope.length === 0 &&
      memoryHandle(existing) === 'user:home-city',
    `matches=${matches.map((m) => `${m.item.key}@${m.score.toFixed(2)}`).join(',')} crossScope=${crossScope.length} handle=${memoryHandle(existing)}`,
  );
}

/**
 * (cc)+(dd) THE SUPERSESSION LIFECYCLE, through the REAL sweep and the REAL
 * store: a proposal reserves and retires NOTHING, and confirmation is what makes
 * the stamp.
 */
async function checkSupersessionLifecycle(store: Store, label: string): Promise<void> {
  const older = seedExisting(store, 'home-city', 'Lives in Lisbon.');
  seedM13Session(store, 'sess-m13a', [MOVED_QUOTE, 'so update my address please']);

  const out = await runReflectionSweep(
    store,
    m13Judge(
      [
        {
          scope: 'user',
          type: 'semantic',
          key: 'home-city-now',
          value: 'Lives in Porto.',
          volatility: 'stable',
          evidenceQuote: MOVED_QUOTE,
        },
      ],
      [
        {
          key: 'home-city-now',
          existing: 'user:home-city',
          verdict: 'contradicts',
          evidenceQuote: MOVED_QUOTE,
        },
      ],
    ),
    { now: LATER(), cap: 10 },
  );

  const newer = userMemory(store).find((m) => m.key === 'home-city-now');
  const oldAfterProposal = store.getMemoryById(older.id);
  record(
    `(cc) [${label}] a PROPOSED contradiction reserves the supersession and retires nothing — the old fact still lives`,
    out.supersessionsReserved === 1 &&
      out.supersessionsActivated === 0 &&
      newer?.status === 'proposed' &&
      newer.provenance.supersedes === older.id &&
      oldAfterProposal?.supersededAt === undefined &&
      oldAfterProposal?.status === 'confirmed',
    `reserved=${out.supersessionsReserved} activated=${out.supersessionsActivated}; ` +
      `new row ${newer?.status} supersedes=${String(newer?.provenance.supersedes)}; ` +
      `old row supersededAt=${String(oldAfterProposal?.supersededAt)}`,
  );

  // CONFIRMATION is the activation — the same two calls `/api/memory` makes when
  // a person clicks confirm.
  store.confirmMemory(newer!.id);
  const activated = activateSupersession(store, newer!.id, LATER());
  const oldAfterConfirm = store.getMemoryById(older.id);
  record(
    `(dd) [${label}] confirming the replacement STAMPS the old row — superseded_at + superseded_by, and the row is kept`,
    activated &&
      oldAfterConfirm?.supersededAt !== undefined &&
      oldAfterConfirm?.supersededBy === newer!.id &&
      oldAfterConfirm?.value === 'Lives in Lisbon.',
    `activated=${activated} supersededBy=${String(oldAfterConfirm?.supersededBy)} value kept="${oldAfterConfirm?.value}"`,
  );

  // (gg) A superseded row is out of the injection candidates AND out of the
  // evidence pool — corroboration must not accrue behind a replaced belief.
  const injected = selectMemoryForInjection(userMemory(store), 2_000, 'where do I live?', LATER());
  const corroborationRefused = store.corroborateMemory(older.id, 'sess-anything');
  record(
    `(gg) [${label}] a superseded row is excluded from injection and can no longer accrue corroboration`,
    !injected.items.some((i) => i.id === older.id) &&
      injected.items.some((i) => i.id === newer!.id) &&
      corroborationRefused === false,
    `injected=${injected.items.map((i) => i.key).join(',')}; corroborateMemory(old)=${corroborationRefused}`,
  );
}

/** (ee) The transient rule, enforced by the STORE as well as by the decision —
 *  it has to hold however the reservation was made. */
function checkTransientNeverSupersedes(store: Store, label: string): void {
  const stable = seedExisting(store, 'home-base', 'Lives in Lisbon.');
  const transient = seedExisting(store, 'travel-now', 'In Berlin this week.', {
    volatility: 'transient',
  });
  const refused = store.supersedeMemory(stable.id, transient.id, LATER());

  // …while a stable replacement is allowed.
  const stableReplacement = seedExisting(store, 'home-base-new', 'Lives in Porto.');
  const allowed = store.supersedeMemory(stable.id, stableReplacement.id, LATER());

  record(
    `(ee) [${label}] the STORE refuses a transient row superseding a stable one, and allows a stable one`,
    refused === false &&
      allowed === true &&
      store.getMemoryById(stable.id)?.supersededBy === stableReplacement.id,
    `transient→stable refused=${!refused}; stable→stable allowed=${allowed}`,
  );

  // Already-superseded rows are never re-stamped: history names the row that
  // actually replaced this one, not the latest claimant.
  const third = seedExisting(store, 'home-base-newer', 'Lives in Madrid.');
  const reStamp = store.supersedeMemory(stable.id, third.id, LATER());
  record(
    `(ee2) [${label}] an already-superseded row is not re-stamped by a later claimant`,
    reStamp === false && store.getMemoryById(stable.id)?.supersededBy === stableReplacement.id,
    `reStamp=${reStamp} supersededBy still ${String(store.getMemoryById(stable.id)?.supersededBy)}`,
  );
}

/** (hh) `equivalent` writes nothing and corroborates; `refines` rewrites the
 *  EXISTING key rather than minting a near-duplicate. */
async function checkNoopAndUpdate(store: Store, label: string): Promise<void> {
  const existing = seedExisting(store, 'metric-units', 'Prefers metric units in every answer.');
  seedM13Session(store, 'sess-m13b', [MOVED_QUOTE, 'and keep using metric units please']);

  const before = store.getMemoryCorroboration([existing.id])[existing.id] ?? 0;
  const noop = await runReflectionSweep(
    store,
    m13Judge(
      [
        {
          scope: 'user',
          type: 'semantic',
          key: 'metric-please',
          value: 'Wants metric units used in answers.',
          evidenceQuote: MOVED_QUOTE,
        },
      ],
      [
        {
          key: 'metric-please',
          existing: 'user:metric-units',
          verdict: 'equivalent',
          evidenceQuote: MOVED_QUOTE,
        },
      ],
    ),
    { now: LATER(), cap: 10 },
  );
  const after = store.getMemoryCorroboration([existing.id])[existing.id] ?? 0;
  const rowsAfterNoop = userMemory(store);
  const unchanged = store.getMemoryById(existing.id);

  record(
    `(hh) [${label}] EQUIVALENT is a NOOP: no new row, the existing value and status untouched, and one more session of corroboration`,
    noop.consolidatedNoops === 1 &&
      noop.proposedMemories === 0 &&
      rowsAfterNoop.length === 1 &&
      unchanged?.value === 'Prefers metric units in every answer.' &&
      unchanged?.status === 'confirmed' &&
      after === before + 1,
    `noops=${noop.consolidatedNoops} proposed=${noop.proposedMemories} rows=${rowsAfterNoop.length} ` +
      `value unchanged=${unchanged?.value === 'Prefers metric units in every answer.'} status=${unchanged?.status} ` +
      `corroboration ${before} → ${after}`,
  );

  // REFINES lands on the SAME key — the whole point is that it does not create a
  // second, slightly better row beside the first.
  seedM13Session(store, 'sess-m13c', [MOVED_QUOTE, 'metric, and to two decimal places']);
  const refined = await runReflectionSweep(
    store,
    m13Judge(
      [
        {
          scope: 'user',
          type: 'semantic',
          key: 'metric-precise',
          value: 'Prefers metric units to two decimal places.',
          evidenceQuote: MOVED_QUOTE,
        },
      ],
      [
        {
          key: 'metric-precise',
          existing: 'user:metric-units',
          verdict: 'refines',
          evidenceQuote: MOVED_QUOTE,
        },
      ],
    ),
    { now: LATER(), cap: 10 },
  );
  const rowsAfterRefine = userMemory(store);
  const refinedRow = store.getMemoryById(existing.id);
  record(
    `(hh2) [${label}] REFINES rewrites the EXISTING key instead of minting a near-duplicate row`,
    refined.consolidatedUpdates === 1 &&
      rowsAfterRefine.length === 1 &&
      refinedRow?.key === 'metric-units' &&
      refinedRow?.value === 'Prefers metric units to two decimal places.',
    `updates=${refined.consolidatedUpdates} rows=${rowsAfterRefine.length} key=${refinedRow?.key} value="${refinedRow?.value}"`,
  );
}

/** (ii) An UNGROUNDED relation is thrown away and the candidate falls back to a
 *  plain ADD — the model cannot claim a contradiction it did not evidence. */
async function checkRelationEvidence(store: Store, label: string): Promise<void> {
  const older = seedExisting(store, 'home-city', 'Lives in Lisbon.');
  seedM13Session(store, 'sess-m13d', [MOVED_QUOTE, 'please update it']);

  const out = await runReflectionSweep(
    store,
    m13Judge(
      [
        {
          scope: 'user',
          type: 'semantic',
          key: 'home-city-now',
          value: 'Lives in Porto.',
          evidenceQuote: MOVED_QUOTE,
        },
      ],
      [
        {
          key: 'home-city-now',
          existing: 'user:home-city',
          verdict: 'contradicts',
          // A quote nobody typed. The candidate itself is grounded, so this
          // isolates the RELATION's evidence rule.
          evidenceQuote: 'the user said they no longer live in Lisbon',
        },
      ],
    ),
    { now: LATER(), cap: 10 },
  );

  const newer = userMemory(store).find((m) => m.key === 'home-city-now');
  record(
    `(ii) [${label}] a relation whose quote the user never typed is DROPPED and counted — the candidate lands as a plain ADD with no reservation`,
    out.droppedRelations === 1 &&
      out.supersessionsReserved === 0 &&
      newer !== undefined &&
      newer.provenance.supersedes === undefined &&
      store.getMemoryById(older.id)?.supersededAt === undefined,
    `droppedRelations=${out.droppedRelations} reserved=${out.supersessionsReserved} ` +
      `supersedes=${String(newer?.provenance.supersedes)}`,
  );
}

/**
 * (jj) STYLE preferences are ordinary memory with a namespaced key — and
 * `style/global/*` is the ONE class corroboration may never confirm (§3.3).
 */
async function checkStylePreferences(store: Store, label: string): Promise<void> {
  seedM13Session(store, 'sess-m13e', [STYLE_QUOTE, 'that applies to everything you write too']);

  const out = await runReflectionSweep(
    store,
    m13Judge(
      [],
      [],
      [
        {
          target: 'review',
          key: 'conclusion-first',
          value: 'Wants the conclusion before the reasoning when reviewing.',
          evidenceQuote: STYLE_QUOTE,
        },
        {
          target: 'global',
          key: 'conclusion-first',
          value: 'Wants the conclusion first, always.',
          evidenceQuote: STYLE_QUOTE,
        },
      ],
    ),
    { now: LATER(), cap: 10 },
  );

  const rows = userMemory(store);
  const scoped = rows.find((m) => m.key === 'style/review/conclusion-first');
  const global = rows.find((m) => m.key === 'style/global/conclusion-first');
  record(
    `(jj) [${label}] style preferences land as ordinary proposed procedural/user memory under style/<target>/<slug>`,
    out.proposedStyles === 2 &&
      scoped?.type === 'procedural' &&
      scoped?.scope === 'user' &&
      scoped?.status === 'proposed' &&
      global?.status === 'proposed' &&
      isStyleMemoryKey(scoped!.key) &&
      isGlobalStyleMemoryKey(global!.key) &&
      !isGlobalStyleMemoryKey(scoped!.key),
    `proposedStyles=${out.proposedStyles} scoped=${scoped?.key}(${scoped?.type}/${scoped?.scope}) global=${global?.key}`,
  );

  // Now corroborate BOTH to the threshold and turn the opt-in on. The scoped one
  // is promoted; the global one is not, and no setting can change that.
  store.setSetting(MEMORY_AUTO_CONFIRM_KEY, 'true');
  for (let i = 0; i < CORROBORATION_THRESHOLD; i += 1) {
    store.corroborateMemory(scoped!.id, `sess-style-${i}`);
    store.corroborateMemory(global!.id, `sess-style-${i}`);
  }
  const promoted = await runReflectionSweep(store, m13Judge([]), { now: LATER(), cap: 10 });
  const scopedAfter = store.getMemoryById(scoped!.id);
  const globalAfter = store.getMemoryById(global!.id);

  record(
    `(ff) [${label}] style/<taskType> is auto-confirmed at the threshold; style/global NEVER is, whatever the setting says (§3.3, HAX cautious adaptation)`,
    scopedAfter?.status === 'confirmed' &&
      globalAfter?.status === 'proposed' &&
      promoted.autoConfirmed === 1 &&
      // …and the pure predicate says the same thing on its own.
      shouldAutoConfirmMemory(globalAfter!, 99, { enabled: true }) === false &&
      shouldAutoConfirmMemory(
        { status: 'proposed', key: 'style/review/x', provenance: { source: 'artifact' } },
        CORROBORATION_THRESHOLD,
        { enabled: true },
      ) === true,
    `scoped=${scopedAfter?.status} global=${globalAfter?.status} autoConfirmed=${promoted.autoConfirmed}`,
  );
  store.setSetting(MEMORY_AUTO_CONFIRM_KEY, 'false');
}

/**
 * (kk) THE STYLE FINGERPRINT — deterministic, gated, and injected only once
 * there is enough of it (§3.3, second half).
 */
async function checkStyleFingerprint(store: Store, label: string): Promise<void> {
  // The pure counting, first: no model, no store.
  const korean = ['오늘은 로그를 확인한다.', '이 부분은 왜 이렇게 했나요?', '- 첫째\n- 둘째'];
  const counted = computeStyleFingerprint(korean, 1_000);
  record(
    `(kk) [${label}] the fingerprint is COUNTED, not inferred: endings, questions and list use come straight out of the text`,
    counted.sampleCount === 3 &&
      counted.endings.formal > 0 &&
      counted.endings.polite > 0 &&
      counted.questionRatio > 0 &&
      counted.listRatio > 0 &&
      counted.avgSentenceChars > 0,
    `samples=${counted.sampleCount} sentences=${counted.sentenceCount} formal=${counted.endings.formal} ` +
      `polite=${counted.endings.polite} questions=${counted.questionRatio} lists=${counted.listRatio}`,
  );

  // The injection gate: below the sample floor there is no line at all, so a
  // fresh install's turn is byte-for-byte what it was.
  const thin = { ...counted, sampleCount: STYLE_FINGERPRINT_MIN_SAMPLES - 1 };
  const thick = { ...counted, sampleCount: STYLE_FINGERPRINT_MIN_SAMPLES };
  record(
    `(kk2) [${label}] no line is injected below ${STYLE_FINGERPRINT_MIN_SAMPLES} samples, and one English line above it`,
    renderStyleFingerprintLine(thin) === undefined &&
      renderStyleFingerprintLine(undefined) === undefined &&
      (renderStyleFingerprintLine(thick)?.startsWith('Observed writing style') ?? false) &&
      !renderStyleFingerprintLine(thick)!.includes('\n'),
    `below=${String(renderStyleFingerprintLine(thin))} above="${renderStyleFingerprintLine(thick)}"`,
  );

  // THROUGH THE REAL SWEEP: THE PROFILE IS NO LONGER LEARNED AT ALL.
  //
  // This check used to assert the opposite, and the reversal is the point. The
  // fingerprint measured how the USER TYPES, and the voice layer corrected
  // answers toward it — but how someone writes a prompt and how they want to be
  // answered are different facts. A user who types "커밋 푸시 릴리즈 배포" and has
  // asked, in words, for polite answers was being steered back toward their own
  // terse instructions, and no amount of asking could have changed it.
  //
  // How naby SPEAKS is now something the user states: a memory, injected every
  // turn, outranking observations (runtime/memory-inject.ts `TRUST_RANK`). What
  // is worth learning from a conversation is intent and direction, not the shape
  // of someone's sentences.
  seedM13Session(store, 'sess-m13f', [STYLE_QUOTE, '그리고 로그는 짧게 남긴다.']);
  const swept = await runReflectionSweep(store, m13Judge([]), { now: LATER(), cap: 10 });
  const stored = parseStyleFingerprint(store.getSetting(STYLE_FINGERPRINT_KEY));
  record(
    `(kk3) [${label}] the sweep no longer learns a writing style`,
    swept.fingerprintSamples === 0 && stored === undefined,
    `fingerprintSamples=${swept.fingerprintSamples} stored=${JSON.stringify(stored)}`,
  );

  // AND AN EXISTING PROFILE IS LEFT ALONE, not deleted. Removing a user's data
  // to finish a refactor is not this change's business — nothing reads it now.
  // Written through the same JSON the parser reads back, so this fixture is a
  // profile the code would actually accept rather than a shape only this test
  // believes in.
  const PRIOR = JSON.stringify(counted);
  store.setSetting(STYLE_FINGERPRINT_KEY, PRIOR);
  seedM13Session(store, 'sess-m13g', ['완전히 다른 문체로 아주 길게 씁니다', '정말로요']);
  const gated = await runReflectionSweep(store, m13Judge([]), { now: LATER(), cap: 10 });
  record(
    `(kk4) [${label}] a profile already on disk is neither updated nor erased`,
    gated.fingerprintSamples === 0 &&
      store.getSetting(STYLE_FINGERPRINT_KEY) === PRIOR &&
      parseStyleFingerprint(store.getSetting(STYLE_FINGERPRINT_KEY))?.sampleCount ===
        counted.sampleCount,
    `fingerprintSamples=${gated.fingerprintSamples} untouched=${
      store.getSetting(STYLE_FINGERPRINT_KEY) === PRIOR
    }`,
  );
  store.setSetting(STYLE_FINGERPRINT_KEY, '');

  // And the merge is an incremental mean with a cap, so a long history cannot
  // freeze the profile against a person who changes how they write.
  const merged = mergeStyleFingerprint(
    { ...counted, sampleCount: STYLE_SAMPLE_CAP * 5, avgSentenceChars: 10 },
    { ...counted, sampleCount: STYLE_SAMPLE_CAP, avgSentenceChars: 110 },
  );
  record(
    `(kk5) [${label}] merging CAPS the accumulated weight, so recent messages always move the profile`,
    merged.sampleCount === STYLE_SAMPLE_CAP && merged.avgSentenceChars === 60,
    `sampleCount=${merged.sampleCount} (cap ${STYLE_SAMPLE_CAP}) avgSentenceChars 10+110 -> ${merged.avgSentenceChars}`,
  );
}

async function runDriverChecks(makeBase: () => Store, label: string): Promise<void> {
  const make = withAgent(makeBase);
  // A fresh store per check so seeded sessions never bleed across assertions.
  let s = make();
  await checkSweep(s, label);
  s.close();
  s = make();
  await checkHallucination(s, label);
  s.close();
  s = make();
  await checkExclusionAndCap(s, label);
  s.close();
  s = make();
  await checkJudgeFailure(s, label);
  s.close();
  s = make();
  await checkJudgeUnavailable(s, label);
  s.close();
  s = make();
  checkKindGuard(s, label);
  s.close();
  s = make();
  await checkMeter(s, label);
  s.close();
  // M8d (§7.2) — the reviewedAt writer and its arrival in the meter.
  s = make();
  await checkReviewedMarking(s, label);
  s.close();
  // M8b (§5) — the memory half.
  s = make();
  await checkProposalLands(s, label);
  s.close();
  s = make();
  await checkProposalGuards(s, label);
  s.close();
  s = make();
  await checkProposedNeverInjects(s, label);
  s.close();
  s = make();
  await checkCorroboration(s, label);
  s.close();
  s = make();
  await checkConsolidation(s, label);
  s.close();
  // P3-M10 (§2.2/§3) — the decay queue and the two sovereignty switches.
  s = make();
  await checkNoLearnSessionSkipped(s, label);
  s.close();
  s = make();
  await checkLearningOffSweep(s, label);
  s.close();
  s = make();
  await checkStaleReview(s, label);
  s.close();
  s = make();
  await checkObservationCascade(s, label);
  s.close();
  // M8c (§6.4) — the widened trigger.
  s = make();
  await checkConversationOnlySession(s, label);
  s.close();
  s = make();
  await checkBelowThreshold(s, label);
  s.close();
  // P3-M13a (§3.1) — the four-op update and the supersession lifecycle.
  s = make();
  await checkSupersessionLifecycle(s, label);
  s.close();
  s = make();
  checkTransientNeverSupersedes(s, label);
  s.close();
  s = make();
  await checkNoopAndUpdate(s, label);
  s.close();
  s = make();
  await checkRelationEvidence(s, label);
  s.close();
  // P3-M13c (§3.3) — style preferences and the counted fingerprint.
  s = make();
  await checkStylePreferences(s, label);
  s.close();
  s = make();
  await checkStyleFingerprint(s, label);
  s.close();
}

async function main(tmpDir: string): Promise<boolean> {
  await runDriverChecks(() => new MemoryStore(), 'MemoryStore');
  await runDriverChecks(() => new SqliteStore({ path: ':memory:' }), 'SqliteStore');
  checkValidatorDirectly();
  checkHeadlessJudgeIsolation();
  // P3-M13a §3.1 step 3: the decision table itself, driven directly — it is pure,
  // and it is what decides every operation above.
  checkFourOps();
  checkMigration(join(tmpDir, 'v7.db'));
  checkMemoryMigration(join(tmpDir, 'v8.db'));

  console.log(
    '\n=== SPIKE-REFLECTION — session reflection: the correctedAfter writer, and memory proposals ===\n',
  );
  let allPass = true;
  for (const c of checks) {
    const tag = c.pass ? 'PASS' : 'FAIL';
    if (!c.pass) allPass = false;
    console.log(`[${tag}] ${c.name}`);
    console.log(`        evidence: ${c.evidence}`);
  }
  console.log(
    `\nSPIKE-REFLECTION: ${allPass ? 'ALL PASS' : 'FAILURES PRESENT'} (${checks.filter((c) => c.pass).length}/${checks.length})\n`,
  );
  return allPass;
}

const TMP_DIR = mkdtempSync(join(tmpdir(), 'naby-reflection-'));
// The spike never touches the real database: every store above is in-memory or
// under this temp dir, and NABY_DB_PATH is pinned here for anything that resolves
// a default path on its own.
process.env.NABY_DB_PATH = join(TMP_DIR, 'app.db');
process.env.NABY_HOME = TMP_DIR;

try {
  const ok = await main(TMP_DIR);
  if (!ok) process.exitCode = 1;
} catch (e) {
  console.error('SPIKE-REFLECTION crashed:', e);
  process.exitCode = 1;
} finally {
  rmSync(TMP_DIR, { recursive: true, force: true });
}
