// src/runtime/reflection.ts
//
// SESSION REFLECTION (Phase 3) — specs/phase-3-continuous-learning.md §4 (M8a)
// and §5 (M8b).
//
// THE HOLE THIS FILLS. The ledger reserved `correctedAfter` on every `autonomous`
// row as the miss signal for the covered region (checkin-contracts §2), and then
// nothing ever wrote it. So `askDecisionQuality` scored `missedAsks = 0` forever,
// its recall was pinned at 1, and coverage could only inflate: an agent that acted
// alone and got it wrong looked exactly like one that acted alone and got it right.
// The evidence was sitting in the transcript the whole time — the user's next
// message, saying "no, not like that" — and no code read it.
//
// M8b ADDS THE SECOND TASK (spec §5). The same one-per-session judge call now
// also proposes MEMORY: durable facts about the user that the conversation
// showed. The same discipline applies twice over — a proposal survives only if
// it quotes a real user message, and then only if it clears the SAME
// deterministic guards `naby_remember` clears (`validateRememberInput`, reused
// rather than re-implemented). And because a proposal lands as `proposed`, it
// still cannot shape a single turn until a human (or corroboration across
// distinct sessions, opted into) confirms it.
//
// WHAT THIS MODULE IS. The pure half of the reflection pass: when a session is
// idle enough to look back at, which autonomous actions are worth judging, what the
// judge is asked, and — the load-bearing part — which of its answers are allowed to
// touch the ledger. IO (loading sessions, calling a model, writing rows) lives in
// the shell's lib/reflection.ts. Nothing here knows a provider, a store or a clock.
//
// WHY A MODEL JUDGES AND A FUNCTION VERIFIES. Detecting "the user corrected this"
// needs language understanding, so a cheap model call does it. But a model asked
// "did the user correct this?" will happily say yes and invent the quote to prove
// it — and an invented correction is a permanent, wrong, unfalsifiable row in a
// ledger the user cannot inspect line by line. So the verdict is only as good as
// the evidence it cites: `validateReflectionVerdicts` keeps a `corrected` verdict
// ONLY when its `evidenceQuote` is a verbatim substring of a real later user
// message from that very case. The model can therefore lower the ledger's opinion
// of the agent only by pointing at something the user actually typed.

import type { RuntimeMessage } from './engine.js';
import type { MemoryItem, MemoryScope, MemoryType, TrustTier } from './store/store.js';
// The write guards are NOT re-implemented here. `naby_remember` already decides
// what a well-formed memory write looks like (slug normalization, the value cap,
// the secret refusal, the type whitelist), and a second copy of those rules is a
// second thing to keep in sync — the exact failure mode the spec warns about when
// two functions answer the same question.
import { normalizeMemoryKey, validateRememberInput } from './tools.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How long a session must sit untouched before it is reflected on (spec §4.2).
 *
 * Reflection targets IDLENESS, not a "session ended" state: on a desktop app the
 * user walks away rather than closing anything, so a status nobody writes is a
 * trigger that never fires — the exact gap §1-3 describes. 30 minutes is a first
 * guess (§6 lists it as open) chosen so a coffee break reads as "done for now"
 * while a pause mid-thought does not.
 */
export const REFLECTION_IDLE_MS = 30 * 60_000;

/** How many sessions one sweep may reflect on. The sweep rides on a real turn
 *  (spec §4.3), so it must stay small enough that a busy machine never queues a
 *  pile of model calls behind ordinary work. */
export const REFLECTION_SWEEP_CAP = 3;

/**
 * Hard cap on transcript messages read for ONE session's reflection. A months-old
 * conversation can hold thousands of rows, and reading all of them would put an
 * unbounded amount of text into a prompt that is supposed to be cheap. The most
 * RECENT window is what matters: a correction follows its action closely.
 */
export const REFLECTION_MESSAGE_CAP = 200;

/** How many later user messages one case carries. A correction lands within a
 *  couple of turns of the action; ten turns later the user has moved on, and the
 *  extra text only gives the judge more to misread. */
export const REFLECTION_LATER_MESSAGE_CAP = 8;

/** Per-message character cap inside a case. Keeps one pasted stack trace from
 *  dominating the prompt. The judge and the validator see the SAME truncated
 *  strings, so a quote it cites is still checkable verbatim. */
export const REFLECTION_MESSAGE_CHARS = 600;

/** How many cases one judge call carries. One call per session (spec §6), so a
 *  session with fifty unjudged actions sends its most recent slice and the rest
 *  wait for the next sweep. */
export const REFLECTION_CASE_CAP = 12;

/** How many of the session's user messages the memory task (M8b, spec §5.2) is
 *  shown. The extraction question is "what did this person reveal about
 *  themselves", which the last stretch of conversation answers as well as the
 *  whole of it — and the window doubles as the evidence space, so a quote from
 *  outside it is a hallucination by definition. */
export const REFLECTION_USER_MESSAGE_CAP = 24;

/** How many memory proposals one judge call may produce. A model asked for
 *  "durable facts" will happily list twenty; each one is a row a human has to
 *  read, so the queue is capped at what a person will actually review. */
export const REFLECTION_MEMORY_CAP = 5;

/**
 * How many NEW user messages a case-less session needs before it is worth a
 * judge call of its own (M8c, spec §6.4).
 *
 * THE GAP THIS CLOSES. Through M8b a session that never triggered an autonomous
 * action produced no cases, and no cases meant no call — so the conversations
 * where a person actually says how they work ("always give me the SQL first",
 * "our team calls that a rollup") taught nothing, because nothing had been done
 * without asking in them. Those are the sessions memory extraction is FOR.
 *
 * TWO IS A FLOOR, NOT A TARGET. A one-message session is "thanks" or "what time
 * is it"; putting a model call behind every one of those would attach a cost to
 * closing a window. Two messages is the smallest exchange that can carry a
 * durable fact and its context. The COST ceiling is unchanged and still belongs
 * to the sweep cap (§4.3): whatever the threshold, one sweep spends at most
 * REFLECTION_SWEEP_CAP calls.
 */
export const REFLECTION_MIN_USER_MESSAGES = 2;

/**
 * How many DISTINCT sessions must agree with a memory's CURRENT value before the
 * opt-in consolidation step may confirm it on its own (spec §5.3/§5.4).
 *
 * Three is a first guess (§7 lists it as open) with a shape rather than a
 * measurement behind it: one session is a remark, two is a coincidence between
 * two conversations that may share one mistaken premise, three is a pattern that
 * survived the user forgetting and re-stating it. It is deliberately a count of
 * SESSIONS, not of mentions — repeating yourself twice in one conversation is one
 * piece of evidence, and counting it as two is how a meter starts flattering itself.
 */
export const CORROBORATION_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One autonomous action put to the judge, with the user's own later words as the
 *  only admissible evidence about it. */
export type ReflectionCase = {
  /** The eval-event id. Used as the case id so a verdict addresses a REAL ledger
   *  row and nothing has to be mapped back afterwards. */
  caseId: string;
  /** Bare tool name the action ran (e.g. 'Write'). */
  toolName: string;
  /** epoch ms the action was recorded. */
  eventAt: number;
  /** User messages that came after the action, oldest first, truncated. The
   *  evidence space: a quote outside this array is a hallucination by definition. */
  laterUserMessages: string[];
};

/** The judge's answer for one case. */
export type ReflectionVerdict = {
  caseId: string;
  /** True when the user fixed/undid/redirected what the action did. */
  corrected: boolean;
  /** The user's words that show it. REQUIRED for a `corrected` verdict to survive
   *  validation — see the header note. */
  evidenceQuote?: string;
};

// ---------------------------------------------------------------------------
// The second task (M8b, spec §5.2): memory proposals
// ---------------------------------------------------------------------------

/** Scopes the JUDGE may propose into. Narrower than what `naby_remember` allows:
 *  `session` memory dies with the conversation being reflected on (so proposing
 *  it buys a row nobody will ever see), and `org` memory is a shared asset a
 *  person curates — neither is something a background pass mints. */
export const REFLECTION_MEMORY_SCOPES: readonly MemoryScope[] = ['user', 'project'];

/** One durable fact the judge believes the conversation showed. Shaped like a
 *  `naby_remember` call, plus the quote that has to back it. */
export type ReflectionMemoryCandidate = {
  scope: MemoryScope;
  type: MemoryType;
  /** Free-form from the judge; normalized to a slug by the validator. */
  key: string;
  value: string;
  /** The user's own words the fact was read out of. REQUIRED — a candidate with
   *  no grounded quote is dropped (see `validateMemoryCandidates`). */
  evidenceQuote: string;
};

/** A user message in the reflected window, with the coordinate that makes it
 *  citable: `seq` is the message's position in the stored transcript, which is
 *  what `provenance.createdFrom` records (spec §5.2). */
export type ReflectionUserMessage = {
  seq: number;
  text: string;
};

/** What the judge is told about the session as a whole, beyond the per-action
 *  cases. Present only when the caller wants memory proposals; a judge handed no
 *  context answers the correction task alone. */
export type ReflectionSessionContext = {
  sessionId: string;
  /** The session's project directory, when it has one. `project`-scope proposals
   *  are refused without it — there would be nothing to key them on. */
  cwd?: string;
  /** The user's own messages in the window, oldest first. The evidence space for
   *  BOTH the quote check and `createdFrom`. */
  userMessages: readonly ReflectionUserMessage[];
};

/** Both halves of one judge call (spec §5.2: one call, two tasks). */
export type ReflectionAnswer = {
  corrections: ReflectionVerdict[];
  memories: ReflectionMemoryCandidate[];
};

/**
 * The judge seam (spec §4.4). Production passes a model-backed implementation;
 * spikes and tests pass a deterministic mock and drive the REAL sweep, validator
 * and store — the same technique spike:learn uses.
 *
 * TWO SHAPES ARE ACCEPTED, and it is not laziness. A bare `ReflectionVerdict[]`
 * means "corrections only, no memory proposed" — the M8a judge's whole answer,
 * and still the honest answer for a judge (or a model reply) that produced no
 * candidates. `normalizeReflectionAnswer` folds either into the two-task shape,
 * so the sweep has exactly one thing to read.
 */
export type ReflectionJudge = (
  cases: readonly ReflectionCase[],
  context?: ReflectionSessionContext,
) => Promise<ReflectionVerdict[] | ReflectionAnswer>;

/** Read either judge shape as the two-task answer. Anything unrecognizable reads
 *  as "no evidence produced", which leaves both the ledger and memory untouched. */
export function normalizeReflectionAnswer(
  answer: ReflectionVerdict[] | ReflectionAnswer | null | undefined,
): ReflectionAnswer {
  if (Array.isArray(answer)) return { corrections: answer, memories: [] };
  if (!answer || typeof answer !== 'object') return { corrections: [], memories: [] };
  return {
    corrections: Array.isArray(answer.corrections) ? answer.corrections : [],
    memories: Array.isArray(answer.memories) ? answer.memories : [],
  };
}

/** The subset of a session row reflection reads. Structural so callers can pass a
 *  full `SessionRef` without this module importing the store. */
export type ReflectionSessionRef = {
  sessionId: string;
  /** epoch ms of the last turn — what idleness is measured from. */
  lastUsedAt: number;
};

/** Where a session's last reflection stopped: the highest message seq already
 *  looked at, and when. */
export type ReflectionCursor = {
  lastSeq: number;
  reflectedAt: number;
};

// ---------------------------------------------------------------------------
// Due-ness (spec §4.2)
// ---------------------------------------------------------------------------

/**
 * Whether a session should be reflected on now: it has been idle for at least
 * `REFLECTION_IDLE_MS`, AND it has said something new since the last reflection.
 *
 * The second half is what makes repeated sweeps free. A session with no new
 * messages has no new evidence, so re-judging it would spend a model call to
 * re-derive the answer it already gave — and would keep doing so on every turn the
 * user takes for the rest of the day.
 *
 * `cursorLastSeq` is -1 for a session that has never been reflected on (message
 * seqs start at 0), so a fresh idle session with one message is due.
 */
export function isSessionDueForReflection(
  session: ReflectionSessionRef,
  cursorLastSeq: number,
  latestSeq: number,
  now: number,
): boolean {
  if (latestSeq <= cursorLastSeq) return false;
  return session.lastUsedAt + REFLECTION_IDLE_MS <= now;
}

// ---------------------------------------------------------------------------
// Building the cases (spec §4.4, "the input is per event")
// ---------------------------------------------------------------------------

/** The ledger fields case-building reads. Structural, so the runtime's `EvalEvent`
 *  and the shell's copy of it both satisfy it without an import. */
export type ReflectionLedgerRow = {
  id: string;
  kind: string;
  at: number;
  toolName?: string;
  correctedAfter?: boolean;
};

export type ReflectionCaseInput = {
  /** The session transcript in APPEND ORDER — index === stored seq. */
  messages: readonly RuntimeMessage[];
  /** The session's ledger rows (any kind; the filter is applied here). */
  events: readonly ReflectionLedgerRow[];
  /** Highest seq the previous reflection covered, or -1 for never. Only cases with
   *  at least one user message NEWER than this are built, which is what keeps a
   *  second sweep over the same span from re-asking the same question. */
  sinceSeq?: number;
  /** Cap on the number of cases returned (newest kept). */
  cap?: number;
  /** How far back into the transcript cases may be drawn from, in messages.
   *  Defaults to REFLECTION_MESSAGE_CAP. See the note in `buildReflectionCases`. */
  messageCap?: number;
};

/** Text of a user message, trimmed and truncated; '' for anything that is not a
 *  user message with content. */
function userText(msg: RuntimeMessage): string {
  if (msg.role !== 'user') return '';
  const text = typeof msg.content === 'string' ? msg.content.trim() : '';
  return text.length > REFLECTION_MESSAGE_CHARS ? text.slice(0, REFLECTION_MESSAGE_CHARS) : text;
}

/**
 * Pair each unjudged `autonomous` event with the user messages that followed it.
 *
 * THE JOIN, AND WHY IT IS STRUCTURAL RATHER THAN BY TIME. Ledger rows carry `at`
 * (epoch ms); stored messages carry only their append order (`seq`) — there is no
 * message timestamp to compare against (store.ts `messages`, session.ts
 * `appendMessage`). So the anchor is derived from the thing the two records
 * genuinely share: the tool call itself. `runTurn` appends exactly one `role:'tool'`
 * message per consequential call (a gate denial is appended as the tool result
 * too), and the gate writes exactly one ledger row per consequential call in the
 * same order — `autonomous` when it ran, `tripwire` when it was refused. Walking
 * both lists in order therefore lines the n-th gate row for a tool up with the
 * n-th tool message for that tool.
 *
 * When an event has no matching tool message (an older row, a transcript trimmed
 * by the cap) it simply produces no case: reflection stays silent rather than
 * guessing which part of the conversation an action belongs to.
 *
 * SKIPPED, per spec §4.4: rows already carrying `correctedAfter` (asked and
 * answered), and every `checkin`/`tripwire` row — a check-in already produced a
 * label, and a refusal never acted at all, so there is nothing to have corrected.
 *
 * BOUNDED BY `messageCap`. Only actions anchored inside the last `messageCap`
 * messages become cases, so one reflection over a months-long conversation reads a
 * bounded window rather than the whole thing. Anchors are still counted from the
 * start of the transcript (an in-memory walk) — truncating the list before counting
 * would shift every anchor and silently mis-attribute actions.
 */
export function buildReflectionCases(input: ReflectionCaseInput): ReflectionCase[] {
  const { messages, events } = input;
  const sinceSeq = input.sinceSeq ?? -1;
  const cap = Math.max(0, input.cap ?? REFLECTION_CASE_CAP);
  const messageCap = Math.max(1, input.messageCap ?? REFLECTION_MESSAGE_CAP);
  const windowStart = Math.max(0, messages.length - messageCap);
  if (cap === 0) return [];

  // Tool-message positions per bare tool name, in transcript order.
  const toolPositions = new Map<string, number[]>();
  messages.forEach((msg, index) => {
    if (msg.role !== 'tool') return;
    const list = toolPositions.get(msg.toolName);
    if (list) list.push(index);
    else toolPositions.set(msg.toolName, [index]);
  });

  // Gate-written rows, oldest first — the order they were appended in, which is
  // the order their tool messages appear in.
  const gateRows = events
    .filter((e) => e.kind === 'autonomous' || e.kind === 'tripwire')
    .slice()
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));

  const seen = new Map<string, number>();
  const cases: ReflectionCase[] = [];

  for (const row of gateRows) {
    const toolName = row.toolName ?? '';
    const nth = seen.get(toolName) ?? 0;
    seen.set(toolName, nth + 1);
    // Consume the anchor for EVERY gate row, including the ones skipped below:
    // a tripwire or an already-judged action still occupies its place in the
    // transcript, and skipping it here would shift every later anchor by one.
    const anchor = toolPositions.get(toolName)?.[nth];
    if (anchor === undefined || anchor < windowStart) continue;
    if (row.kind !== 'autonomous' || row.correctedAfter) continue;

    const later: string[] = [];
    let hasNewEvidence = false;
    for (let i = anchor + 1; i < messages.length; i += 1) {
      const msg = messages[i];
      if (!msg) continue;
      const text = userText(msg);
      if (!text) continue;
      later.push(text);
      if (i > sinceSeq) hasNewEvidence = true;
    }
    // Nothing the user said afterwards ⇒ nothing that could be a correction. And
    // nothing NEW said since the last reflection ⇒ the question was already put to
    // the judge once; asking again would buy the same answer for another call.
    if (later.length === 0 || !hasNewEvidence) continue;

    cases.push({
      caseId: row.id,
      toolName,
      eventAt: row.at,
      // The most RECENT window of what followed: a correction sits next to its
      // action, and the older messages in between only dilute the prompt.
      laterUserMessages: later.slice(-REFLECTION_LATER_MESSAGE_CAP),
    });
  }

  // Newest actions first in the queue for the cap, but the returned list stays in
  // chronological order so the prompt reads like the conversation did.
  return cases.slice(-cap);
}

// ---------------------------------------------------------------------------
// Validation — the part that makes a model verdict admissible
// ---------------------------------------------------------------------------

export type ReflectionValidation = {
  /** Verdicts that survived. Only these may touch the ledger. */
  kept: ReflectionVerdict[];
  /** How many were thrown out. Counted, never silent — the same principle the
   *  degenerate-checkin exclusion follows (checkin-contracts §7). */
  dropped: number;
};

/** Normalize a quote for the substring test: collapse whitespace so a model that
 *  re-wraps a multi-line quote is not punished for the line breaks, while every
 *  actual WORD still has to be the user's. */
function normalizeQuote(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The shortest quote that can carry evidence. One or two characters would match
 *  almost any message by accident, which would make the check decorative. */
const MIN_EVIDENCE_CHARS = 4;

/**
 * Keep only the verdicts that are ADMISSIBLE (spec §4.4):
 *
 *   - the `caseId` must name a case that was actually put to the judge. A verdict
 *     about an id nobody asked about is, at best, a mis-copy; at worst it is the
 *     model marking a row it was never shown.
 *   - a `corrected: true` verdict must cite an `evidenceQuote` that appears
 *     verbatim (whitespace-normalized) inside one of THAT case's later user
 *     messages. This is the whole anti-hallucination guarantee: the model cannot
 *     invent a correction, because the only way to write one into the ledger is to
 *     quote something the user really typed after the action.
 *   - `corrected: false` needs no evidence — it changes nothing.
 *
 * A duplicate verdict for a case already decided is dropped, so a model that
 * answers twice cannot get two votes.
 */
export function validateReflectionVerdicts(
  verdicts: readonly ReflectionVerdict[],
  cases: readonly ReflectionCase[],
): ReflectionValidation {
  const byId = new Map(cases.map((c) => [c.caseId, c]));
  const decided = new Set<string>();
  const kept: ReflectionVerdict[] = [];
  let dropped = 0;

  for (const verdict of verdicts) {
    const theCase = verdict && typeof verdict.caseId === 'string' ? byId.get(verdict.caseId) : undefined;
    if (!theCase || decided.has(verdict.caseId)) {
      dropped += 1;
      continue;
    }
    if (verdict.corrected !== true) {
      decided.add(verdict.caseId);
      kept.push({ caseId: verdict.caseId, corrected: false });
      continue;
    }
    const quote = normalizeQuote(typeof verdict.evidenceQuote === 'string' ? verdict.evidenceQuote : '');
    if (quote.length < MIN_EVIDENCE_CHARS) {
      dropped += 1;
      continue;
    }
    const grounded = theCase.laterUserMessages.some((m) => normalizeQuote(m).includes(quote));
    if (!grounded) {
      dropped += 1;
      continue;
    }
    decided.add(verdict.caseId);
    kept.push({ caseId: verdict.caseId, corrected: true, evidenceQuote: verdict.evidenceQuote });
  }

  return { kept, dropped };
}

// ---------------------------------------------------------------------------
// The memory window and its validator (M8b, spec §5.2)
// ---------------------------------------------------------------------------

/**
 * The user's own messages in the reflected window, oldest first, each carrying
 * the `seq` it is stored at.
 *
 * SEQ IS THE POINT. A proposal records `provenance.createdFrom =
 * "<sessionId>:<seq>"` (spec §5.2) — the coordinate of the message it was read
 * out of, which is what makes a proposal auditable months later: the reviewer can
 * open that exact line of the conversation instead of taking the model's word for
 * it. Indices are counted from the start of the transcript, so the coordinate
 * stays true regardless of how far back the window reaches.
 *
 * Texts are truncated to `REFLECTION_MESSAGE_CHARS` exactly as the case builder
 * truncates, so the judge and the validator compare the SAME strings and a quote
 * copied from the prompt is checkable verbatim.
 */
export function collectReflectionUserMessages(
  messages: readonly RuntimeMessage[],
  opts?: { messageCap?: number; cap?: number },
): ReflectionUserMessage[] {
  const messageCap = Math.max(1, opts?.messageCap ?? REFLECTION_MESSAGE_CAP);
  const cap = Math.max(0, opts?.cap ?? REFLECTION_USER_MESSAGE_CAP);
  if (cap === 0) return [];
  const windowStart = Math.max(0, messages.length - messageCap);
  const out: ReflectionUserMessage[] = [];
  for (let i = windowStart; i < messages.length; i += 1) {
    const msg = messages[i];
    if (!msg) continue;
    const text = userText(msg);
    if (!text) continue;
    out.push({ seq: i, text });
  }
  // The most RECENT slice: what the person said last is what they still mean.
  return out.slice(-cap);
}

/**
 * How many user messages the session has said that the last reflection did not
 * see. `sinceSeq` is the cursor (-1 for a session never reflected on), and the
 * same `userText` filter the case builder uses decides what counts — an empty or
 * non-user row is not something a person said.
 */
export function countUserMessagesSince(
  messages: readonly RuntimeMessage[],
  sinceSeq: number,
): number {
  let count = 0;
  for (let i = Math.max(0, sinceSeq + 1); i < messages.length; i += 1) {
    const msg = messages[i];
    if (!msg) continue;
    if (userText(msg)) count += 1;
  }
  return count;
}

/**
 * Whether a session with NO judgeable cases still earns a judge call, for the
 * memory task alone (M8c, spec §6.4).
 *
 * This is the whole widening, stated in one place so the cost of the decision is
 * findable: a purely conversational session — no autonomous action, therefore no
 * case — is read for durable facts once it has said `REFLECTION_MIN_USER_MESSAGES`
 * new things. Below that it is still SWEPT (the cursor advances; the span is
 * spent), it simply is not worth a model call.
 *
 * It does NOT widen the per-session budget: a session that has cases already gets
 * its one call and asks both tasks in it (§5.2), so this can only ever turn a
 * session that would have made ZERO calls into one that makes one.
 */
export function shouldExtractMemoryOnly(
  messages: readonly RuntimeMessage[],
  sinceSeq: number,
  opts?: { threshold?: number },
): boolean {
  const threshold = Math.max(1, opts?.threshold ?? REFLECTION_MIN_USER_MESSAGES);
  return countUserMessagesSince(messages, sinceSeq) >= threshold;
}

/** A candidate that cleared BOTH the evidence check and the write guards, with
 *  the two things a store write needs added: the normalized slug, and the exact
 *  message coordinate its evidence came from. */
export type ValidatedMemoryCandidate = ReflectionMemoryCandidate & {
  /** `normalizeMemoryKey`'d — the upsert identity within (scope, scopeKey). */
  key: string;
  /** Transcript seq of the user message whose words are quoted. */
  evidenceSeq: number;
};

export type MemoryCandidateValidation = {
  kept: ValidatedMemoryCandidate[];
  /** How many were thrown out — for the same reason verdicts count their drops:
   *  a silent refusal reads as "the model proposed nothing". */
  dropped: number;
};

/**
 * Keep only the memory proposals that are ADMISSIBLE (spec §5.2). Two layers,
 * both deterministic, both applied BEFORE anything is written:
 *
 *   1. EVIDENCE. `evidenceQuote` must appear verbatim (whitespace-normalized)
 *      inside one of the session's real user messages. Identical in principle to
 *      the verdict validator, and load-bearing for the same reason: a model asked
 *      "what did you learn about this person" will invent a preference and a
 *      sentence proving it, and an invented preference in durable memory is a
 *      lie the agent then acts on for weeks.
 *   2. THE WRITE GUARDS. Exactly the ones `naby_remember` applies
 *      (`validateRememberInput` — slug, empty/over-long value, `looksLikeSecret`,
 *      the type whitelist), plus the narrower scope rule of §5.2: `user` or
 *      `project` only, and `project` only when the session HAS a project. A
 *      background pass gets no more latitude than a tool call the user watched.
 *
 * Duplicates on (scope, key) keep the FIRST — one call cannot propose two values
 * for one row, which would make "which one landed" depend on write order.
 */
export function validateMemoryCandidates(
  candidates: readonly ReflectionMemoryCandidate[],
  userMessages: readonly ReflectionUserMessage[],
  opts?: { hasCwd?: boolean; cap?: number },
): MemoryCandidateValidation {
  const cap = Math.max(0, opts?.cap ?? REFLECTION_MEMORY_CAP);
  const hasCwd = opts?.hasCwd === true;
  const kept: ValidatedMemoryCandidate[] = [];
  const seen = new Set<string>();
  let dropped = 0;

  for (const candidate of candidates ?? []) {
    if (!candidate || typeof candidate !== 'object') {
      dropped += 1;
      continue;
    }
    if (kept.length >= cap) {
      dropped += 1;
      continue;
    }
    const scope = String(candidate.scope ?? '');
    const type = String(candidate.type ?? '');
    const key = String(candidate.key ?? '');
    const value = String(candidate.value ?? '').trim();

    // (2a) The scope whitelist, checked first because it is the one rule that is
    // STRICTER here than in the tool: `org` cannot be minted by anything, and
    // `session` is pointless for a pass that runs after the session went quiet.
    if (!(REFLECTION_MEMORY_SCOPES as readonly string[]).includes(scope)) {
      dropped += 1;
      continue;
    }
    if (scope === 'project' && !hasCwd) {
      dropped += 1;
      continue;
    }
    // (2b) Everything else `naby_remember` refuses, refused identically.
    if (validateRememberInput({ key, value, type, scope }).length > 0) {
      dropped += 1;
      continue;
    }
    const normalizedKey = normalizeMemoryKey(key);
    const identity = `${scope}:${normalizedKey}`;
    if (seen.has(identity)) {
      dropped += 1;
      continue;
    }

    // (1) The evidence, last: it is the most expensive check and the others have
    // already thrown out everything malformed.
    const quote = normalizeQuote(
      typeof candidate.evidenceQuote === 'string' ? candidate.evidenceQuote : '',
    );
    if (quote.length < MIN_EVIDENCE_CHARS) {
      dropped += 1;
      continue;
    }
    const source = userMessages.find((m) => normalizeQuote(m.text).includes(quote));
    if (!source) {
      dropped += 1;
      continue;
    }

    seen.add(identity);
    kept.push({
      scope: scope as MemoryScope,
      type: type as MemoryType,
      key: normalizedKey,
      value,
      evidenceQuote: candidate.evidenceQuote,
      evidenceSeq: source.seq,
    });
  }

  return { kept, dropped };
}

// ---------------------------------------------------------------------------
// Consolidation (M8b, spec §5.4) — the auto-confirm DECISION, as a pure function
// ---------------------------------------------------------------------------

/** The fields the auto-confirm decision reads. Structural so the shell can pass a
 *  whole `MemoryItem` and a test can pass three fields. */
export type AutoConfirmCandidate = Pick<MemoryItem, 'status'> & {
  provenance: { source: TrustTier };
};

/**
 * Whether the consolidation step may confirm this row on its own.
 *
 * FOUR CONDITIONS, ALL REQUIRED, and the order they are written in is the order
 * of how much trouble getting one wrong would cause:
 *
 *   1. `external` is NEVER auto-confirmed — checked first and independently of
 *      the setting, because memory-contracts §4 invariant 1 says a user action is
 *      the ONLY path external-origin memory becomes confirmed. A user who turns
 *      the setting on is opting into trusting THEIR OWN conversations, not into
 *      trusting a web page that talked its way into their memory.
 *   2. The setting is on. Off by default (§5.4): silent promotion is not
 *      something to opt a person out of.
 *   3. The row is still `proposed`. Confirming a confirmed row is a no-op the
 *      store would swallow, but counting it would inflate the log.
 *   4. Enough DISTINCT sessions agree with the row's CURRENT value.
 *
 * Deliberately NOT in the store: "may this be promoted" is policy, and policy
 * hidden inside a write path is policy nobody can find (the same reasoning that
 * keeps `decideMemoryWrite` a separate pure function from `putMemory`).
 */
export function shouldAutoConfirmMemory(
  item: AutoConfirmCandidate,
  corroboration: number,
  opts: { enabled: boolean; threshold?: number },
): boolean {
  if (item.provenance.source === 'external') return false;
  if (!opts.enabled) return false;
  if (item.status !== 'proposed') return false;
  const threshold = opts.threshold ?? CORROBORATION_THRESHOLD;
  return corroboration >= threshold;
}

// ---------------------------------------------------------------------------
// The prompt (pure — the shell only transports it)
// ---------------------------------------------------------------------------

/** The two halves of one judge call. Built here so the wording is testable and
 *  provider-independent; the shell hands `system` to the engine's system field and
 *  `user` as the single user message. */
export type ReflectionPrompt = { system: string; user: string };

/**
 * Ask, per case, one narrow question: did the user afterwards fix, undo or
 * redirect what this action did? And — when a session `context` is supplied
 * (M8b, spec §5.2) — a second one over the same conversation: what durable fact
 * about this person did it show?
 *
 * ONE CALL, TWO TASKS, on purpose. The judge is already reading this transcript;
 * asking the second question costs no extra round trip, and the two answers are
 * grounded in the same text, so a model that fabricates for one task is caught by
 * the same validator that catches it for the other.
 *
 * Kept compact deliberately — it is a cheap background call, not a turn. The
 * instructions state the things a model gets wrong here: that a follow-up REQUEST
 * is not a correction (asking for the next thing is normal work), that the quote
 * must be copied rather than paraphrased (a paraphrase fails validation and the
 * answer is discarded, so paraphrasing is silently useless), and that a fact true
 * only inside this conversation is not memory.
 */
export function buildReflectionPrompt(
  cases: readonly ReflectionCase[],
  context?: ReflectionSessionContext,
): ReflectionPrompt {
  const wantsMemory = context !== undefined && context.userMessages.length > 0;
  // MEMORY-ONLY (M8c, spec §6.4). A purely conversational session has nothing
  // that was done without asking, so the correction task has no case to put and
  // its instructions are dropped rather than sent with "0 case(s)" under them:
  // a model told to judge nothing tends to invent something to judge, and every
  // line it costs is a line of a call that exists only to read memory.
  const wantsCorrections = cases.length > 0;

  const system = [
    'You review a finished conversation between a user and an assistant.',
    ...(wantsCorrections
      ? [
          '',
          'TASK 1 — corrections. For each case you are given the tool the assistant ran WITHOUT asking, and',
          'the user messages that came after it. Decide ONLY this: did the user correct that action — undo',
          'it, redo it differently, or say it was wrong?',
          '',
          '- Asking for the NEXT thing is not a correction. Neither is praise, a question, or a new task.',
          '- Say corrected only when the user pushed back on what that action did.',
          '- When corrected is true you MUST copy the exact user words that show it into evidenceQuote,',
          '  character for character from the messages shown. A paraphrase is discarded.',
        ]
      : []),
    ...(wantsMemory
      ? [
          '',
          `TASK ${wantsCorrections ? '2' : '1'} — memory. From the user messages, propose up to ${REFLECTION_MEMORY_CAP} durable facts about THIS`,
          'person that would still be true and useful next week: how they want work done, a standing',
          'rule, a term their team uses, a stable preference.',
          '',
          '- Propose NOTHING rather than something weak. An empty list is a good answer.',
          '- Not memory: what they asked for in this one conversation, a passing detail, anything about',
          '  the assistant rather than the user, and never a secret (token, key, password).',
          '- scope: "user" for a fact that holds everywhere, "project" for one true only in this',
          `  working directory${context?.cwd ? ` (${context.cwd})` : ' (unavailable here — use "user")'}.`,
          '- type: "semantic" for a standing fact or preference, "procedural" for how they want a task',
          '  done, "episodic" for something that happened, "working" for current task state.',
          '- key: a short stable slug, e.g. "prefers-metric-units". value: one sentence that makes sense',
          '  with no conversation around it.',
          '- evidenceQuote MUST be copied character for character from one of the user messages below.',
          '  A proposal whose quote does not appear there is discarded.',
        ]
      : []),
    '',
    'Answer with JSON only — no prose, no code fence:',
    // The `corrections` array is still named in the memory-only shape, and still
    // expected to come back EMPTY. Naming it costs nothing and keeps one answer
    // shape for the parser; and a verdict about a case that was never sent is
    // dropped by the validator anyway (it can only address ids it was given).
    wantsMemory
      ? '{"corrections":[{"caseId":"<id>","corrected":true|false,"evidenceQuote":"<exact user words, only when corrected>"}],' +
        '"memories":[{"scope":"user|project","type":"semantic|procedural|episodic|working","key":"<slug>","value":"<one sentence>","evidenceQuote":"<exact user words>"}]}'
      : '{"corrections":[{"caseId":"<id>","corrected":true|false,"evidenceQuote":"<exact user words, only when corrected>"}]}',
  ].join('\n');

  const blocks = cases.map((c, index) => {
    const lines = c.laterUserMessages.map((m, i) => `  user[${i + 1}]: ${m}`);
    return [`case ${index + 1}`, `  caseId: ${c.caseId}`, `  action: ${c.toolName || 'unknown tool'}`, ...lines].join(
      '\n',
    );
  });

  const parts = wantsCorrections
    ? [`${cases.length} case(s) to judge.`, '', ...blocks]
    : ['There is nothing to judge in this conversation — no action was taken without asking.'];
  if (wantsMemory) {
    parts.push(
      '',
      `The user messages in this conversation, for TASK ${wantsCorrections ? '2' : '1'}:`,
      ...context.userMessages.map((m) => `  user: ${m.text}`),
    );
  }
  return { system, user: parts.join('\n') };
}

// ---------------------------------------------------------------------------
// Parsing the judge's answer
// ---------------------------------------------------------------------------

/**
 * Read verdicts out of a model's raw text. Tolerates a fenced code block and
 * leading prose (both are common failure modes of "JSON only" instructions) and
 * returns [] on anything it cannot read.
 *
 * RETURNING [] IS THE RIGHT FAILURE. An unreadable answer means "no evidence was
 * produced", and the ledger is left exactly as it was — the sweep will try again
 * once the session has something new to say. Guessing at half-parsed output is the
 * one thing that could put a fabricated correction on the record.
 */
export function parseReflectionVerdicts(raw: string): ReflectionVerdict[] {
  return parseReflectionAnswer(raw).corrections;
}

/**
 * Strip a fenced code block and any leading prose, then read the outermost JSON
 * value.
 *
 * WHICH BRACKET IS OUTERMOST IS DECIDED BY WHICH ONE COMES FIRST, not by which
 * one is being looked for. A corrections-only answer is `[{...}]`: hunting for
 * `{`…`}` in it would find the FIRST ELEMENT and read it as the whole answer,
 * quietly turning a list of verdicts into an object with no `corrections` field —
 * i.e. into silence. Returns undefined for anything unparseable; see the note on
 * `parseReflectionAnswer` for why that is the right failure.
 */
function extractJson(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] ?? raw).trim();
  const objectAt = body.indexOf('{');
  const arrayAt = body.indexOf('[');
  if (objectAt < 0 && arrayAt < 0) return undefined;
  const isObject = arrayAt < 0 || (objectAt >= 0 && objectAt < arrayAt);
  const start = isObject ? objectAt : arrayAt;
  const end = body.lastIndexOf(isObject ? '}' : ']');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function readVerdicts(value: unknown): ReflectionVerdict[] {
  if (!Array.isArray(value)) return [];
  const out: ReflectionVerdict[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { caseId?: unknown; corrected?: unknown; evidenceQuote?: unknown };
    if (typeof row.caseId !== 'string') continue;
    const verdict: ReflectionVerdict = { caseId: row.caseId, corrected: row.corrected === true };
    if (typeof row.evidenceQuote === 'string') verdict.evidenceQuote = row.evidenceQuote;
    out.push(verdict);
  }
  return out;
}

/** Candidates as the model wrote them — every field coerced to a string and
 *  nothing judged. Whether a candidate is ADMISSIBLE is
 *  `validateMemoryCandidates`'s decision, and keeping the two apart is what lets
 *  the drop count mean "the model proposed something it could not back up"
 *  rather than "the JSON was odd". */
function readCandidates(value: unknown): ReflectionMemoryCandidate[] {
  if (!Array.isArray(value)) return [];
  const out: ReflectionMemoryCandidate[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    out.push({
      scope: String(row.scope ?? '') as MemoryScope,
      type: String(row.type ?? '') as MemoryType,
      key: String(row.key ?? ''),
      value: String(row.value ?? ''),
      evidenceQuote: String(row.evidenceQuote ?? ''),
    });
  }
  return out;
}

/**
 * Read BOTH tasks out of a model's raw text (M8b, spec §5.2). Tolerates a fenced
 * code block and leading prose (both are common failure modes of "JSON only"
 * instructions), and tolerates either array being absent — a judge that found no
 * corrections, or no memory worth proposing, is answering correctly.
 *
 * IT ALSO STILL READS A BARE ARRAY as corrections-only. That is the M8a answer
 * shape, and a model handed the two-task instructions will occasionally reply
 * with it anyway; reading it costs one branch and saves throwing away a real
 * answer.
 *
 * RETURNING EMPTY IS THE RIGHT FAILURE. An unreadable answer means "no evidence
 * was produced": the ledger and memory are left exactly as they were, and the
 * sweep tries again once the session has something new to say. Guessing at
 * half-parsed output is the one thing that could put a fabricated correction on
 * the record, or a fabricated preference into durable memory.
 */
export function parseReflectionAnswer(raw: string): ReflectionAnswer {
  const empty: ReflectionAnswer = { corrections: [], memories: [] };
  if (typeof raw !== 'string' || raw.trim().length === 0) return empty;

  const parsed = extractJson(raw);
  if (Array.isArray(parsed)) return { corrections: readVerdicts(parsed), memories: [] };
  if (parsed && typeof parsed === 'object') {
    const row = parsed as { corrections?: unknown; memories?: unknown };
    return { corrections: readVerdicts(row.corrections), memories: readCandidates(row.memories) };
  }
  return empty;
}
