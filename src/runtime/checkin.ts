// src/runtime/checkin.ts
//
// THE CHECK-IN (Phase 3, P3-M5) — the interaction that produces the trust
// meter's labels.
//
// `growth.ts` can score a ledger but nothing wrote one, so the meter sat at
// "egg 0%" forever. This module is the missing half: the agent states how it
// plans to proceed, offers concrete alternatives, marks the one it recommends,
// and the user picks. That single exchange is a labelled prediction — hit when
// the user took the recommendation unchanged, miss otherwise — which is exactly
// what `CheckinRecord.hit` means.
//
// WHY THE AGENT AUTHORS THE QUESTION BUT NOT THE OBLIGATION. The options have to
// come from the model: only it knows which two ways of doing this task are
// actually different. But if it also decided WHEN to ask, it would ask only
// where it felt safe and the hit rate would measure nothing (trust-meter spec
// §4.5). So the obligation is a property of the ACTION CLASS, enforced
// elsewhere: every consequential call is recorded either as a `checkin` (it
// asked) or as `autonomous` (it did not), and `isConsequentialTool` below is the
// classifier both paths share. The agent can choose to ask; it cannot choose to
// be un-counted.
//
// WHY DEGENERATE QUESTIONS ARE DETECTED HERE. A padded question — "shall I use
// approach A, or approach A?" — is a free hit. Asking the same thing five times
// is five free hits. Both are caught deterministically (no second model call)
// and marked `excludedFromScoring`, which keeps them out of the hit rate while
// STILL counting them in coverage. That asymmetry is deliberate and documented in
// `computeGrowth`: padding must cost something, or the exclusion just makes it
// cheap instead of impossible.

import { DANGEROUS_BUILTINS } from './gate.js';
import { MUTATING_TOOLS } from './fs-tools.js';

// ---------------------------------------------------------------------------
// Which actions are consequential enough to be scored
// ---------------------------------------------------------------------------

/**
 * Runtime tools that change something outside the app and cannot be taken back.
 * The built-in classification (`DANGEROUS_BUILTINS`) only knows the harness's own
 * tools, so our outbound tools are named here rather than in the gate — the gate
 * decides permission, this decides whether an action is worth measuring.
 */
export const CONSEQUENTIAL_RUNTIME_TOOLS: readonly string[] = [
  'send_message',
  // The workspace tools that write or execute. Named here as well as in the
  // gate for the reason above: the gate decides whether a call is permitted,
  // this decides whether it is the kind of act the trust meter is measuring.
  // Omitting them would let the agent edit a project all day and register as
  // having done nothing worth being asked about.
  ...MUTATING_TOOLS,
];

/**
 * Whether a call is the kind of action a check-in is ABOUT: it mutates the
 * filesystem, executes code, or leaves the machine. Reads and searches are not —
 * scoring them would flood the ledger with decisions nobody would ever have
 * wanted to be asked about.
 *
 * KNOWN LIMIT: this classifies the harness built-ins and our own tools. A
 * third-party MCP tool that sends an email is consequential in reality but
 * unclassified here, so it produces no ledger row. That is deliberate — inferring
 * danger from a tool name would be a guess, and a wrong guess either floods the
 * ledger or hard-blocks growth on a harmless call. Classifying MCP tools needs a
 * real signal (a declared annotation, or the user's own policy rule).
 *
 * @param bareName the tool name the gate sees (`ToolCall.toolName`)
 */
export function isConsequentialTool(bareName: string): boolean {
  return DANGEROUS_BUILTINS.includes(bareName) || CONSEQUENTIAL_RUNTIME_TOOLS.includes(bareName);
}

/**
 * Coarse "could this be undone" tag for an autonomous action. File edits go
 * through the shell's per-call snapshot (a shadow git commit per mutating call),
 * so they are recoverable; a shell command or a sent message is not.
 *
 * Recorded for the audit trail and for later axes — the meter does not read it,
 * so a wrong guess here cannot move a stage. Kept honest rather than optimistic.
 */
export function isReversibleAction(bareName: string): boolean {
  return (
    bareName === 'Write' ||
    bareName === 'Edit' ||
    bareName === 'MultiEdit' ||
    bareName === 'NotebookEdit' ||
    // Our own file writes take the same snapshot path, so they are recoverable
    // for the same reason. `run_command` is deliberately absent: a shell command
    // is not.
    bareName === 'write_file' ||
    bareName === 'edit_file'
  );
}

// ---------------------------------------------------------------------------
// The question and the answer
// ---------------------------------------------------------------------------

/** The bare name of the check-in tool — also its gate/allowlist key. */
export const CHECKIN_TOOL_NAME = 'naby_checkin';

/** Fewer than two options is not a question (contract §4, invariant 2). */
export const CHECKIN_MIN_OPTIONS = 2;
/** More than this is a menu, not a decision — and it dilutes the label: with ten
 *  options a hit means much less than with two. */
export const CHECKIN_MAX_OPTIONS = 5;
export const CHECKIN_QUESTION_MAX = 240;
export const CHECKIN_OPTION_MAX = 160;

/** What the agent asks. Mirrors the `checkin` fields of `EvalEvent`. */
export interface CheckinQuestion {
  /** What it is about to do, phrased as a question the user can answer by picking. */
  question: string;
  /** The concrete ways to proceed, in the order they will be shown. */
  options: string[];
  /** Index into `options` that the agent recommends. Its prediction. */
  recommended: number;
  /** The agent's own stated confidence, 0–1. RECORDED BUT NOT TRUSTED — the
   *  Brier axis exists to find out whether it is calibrated (spec §4.7). */
  confidence?: number;
  /** The trust axis this decision belongs to (spec §4.9). Model-supplied for now;
   *  recorded verbatim so a later audit can see what it claimed. */
  taskType?: string;
}

/** What came back from the user. */
export interface CheckinAnswer {
  /** Index into `options`, or -1 when they answered in their own words. */
  chosen: number;
  /** Their words, when `chosen` is -1 — the edit-diff analogue. */
  correction?: string;
  /** Nobody answered: the turn was stopped, or the prompt timed out. NOT a miss —
   *  see `shouldRecord`. */
  unanswered?: boolean;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Everything wrong with a check-in, in the words the MODEL needs to fix it.
 * Empty array = well-formed. Pure.
 *
 * These are the contract's invariants (§4.2), enforced before the user is ever
 * interrupted: a malformed check-in must fail as a tool error, not as a prompt
 * the user cannot answer.
 */
export function validateCheckinInput(input: {
  question: string;
  options: unknown;
  recommended: unknown;
  confidence?: unknown;
}): string[] {
  const problems: string[] = [];
  const question = input.question.trim();
  if (!question) {
    problems.push('`question` is empty — say what you are about to do, as a question the user can answer by picking an option');
  } else if (question.length > CHECKIN_QUESTION_MAX) {
    problems.push(`\`question\` is ${question.length} chars; keep it under ${CHECKIN_QUESTION_MAX} (one decision, one sentence)`);
  }

  if (!Array.isArray(input.options)) {
    problems.push('`options` must be an array of strings');
    return problems; // nothing else can be checked without them
  }
  const options = input.options.map((o) => String(o ?? '').trim());
  if (options.length < CHECKIN_MIN_OPTIONS) {
    problems.push(
      `\`options\` needs at least ${CHECKIN_MIN_OPTIONS} genuinely different ways to proceed — one option is not a question`,
    );
  }
  if (options.length > CHECKIN_MAX_OPTIONS) {
    problems.push(`\`options\` has ${options.length}; offer at most ${CHECKIN_MAX_OPTIONS} so the choice stays a decision`);
  }
  if (options.some((o) => !o)) problems.push('every option must be non-empty');
  const tooLong = options.find((o) => o.length > CHECKIN_OPTION_MAX);
  if (tooLong) {
    problems.push(`each option must be under ${CHECKIN_OPTION_MAX} chars; shorten "${tooLong.slice(0, 40)}…"`);
  }

  const recommended = input.recommended;
  if (typeof recommended !== 'number' || !Number.isInteger(recommended)) {
    problems.push('`recommended` must be the integer index of the option you think the user wants');
  } else if (recommended < 0 || recommended >= options.length) {
    problems.push(`\`recommended\` must be between 0 and ${Math.max(0, options.length - 1)}`);
  }

  if (input.confidence !== undefined) {
    const c = input.confidence;
    if (typeof c !== 'number' || Number.isNaN(c) || c < 0 || c > 1) {
      problems.push('`confidence` must be a number between 0 and 1');
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Degenerate check-ins (§7 anti-gaming)
// ---------------------------------------------------------------------------

/** Similarity at or above which two questions count as the same one asked twice.
 *  High on purpose: a false positive silently discards a real label, which costs
 *  more than letting a borderline repeat through. */
export const DEGENERATE_SIMILARITY = 0.8;

/** Comparable form of a question: lowercased, punctuation dropped, collapsed. */
export function normalizeCheckinQuestion(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Jaccard overlap of the two questions' word sets, 0–1. Word-set rather than edit
 * distance because the gaming move is re-wording the same ask, and reordered or
 * lightly-padded sentences keep almost the same words. Works for Korean, which
 * also separates words by spaces.
 */
export function questionSimilarity(a: string, b: string): number {
  const at = new Set(normalizeCheckinQuestion(a).split(' ').filter(Boolean));
  const bt = new Set(normalizeCheckinQuestion(b).split(' ').filter(Boolean));
  if (at.size === 0 || bt.size === 0) return at.size === bt.size ? 1 : 0;
  let shared = 0;
  for (const t of at) if (bt.has(t)) shared += 1;
  return shared / (at.size + bt.size - shared);
}

/** Why a check-in was thrown out. A CODE, not prose, for the same reason
 *  `GrowthReasonCode` is: the runtime must not hardcode a language, and the shell
 *  renders it in the user's own words. Storing the English sentence would leak it
 *  straight into a Korean panel. */
export type DegenerateCode = 'one-real-option' | 'repeat-question';

/**
 * Why this check-in must not count toward accuracy, or undefined when it is a
 * real question. The code is stored on the row so the panel can say what was
 * excluded and why — never a silent drop.
 *
 * @param recentQuestions the agent's recent check-in questions, newest first
 */
export function degenerateReason(input: {
  question: string;
  options: readonly string[];
  recentQuestions?: readonly string[];
}): DegenerateCode | undefined {
  const distinct = new Set(input.options.map((o) => normalizeCheckinQuestion(o)).filter(Boolean));
  if (distinct.size < CHECKIN_MIN_OPTIONS) return 'one-real-option';
  for (const prior of input.recentQuestions ?? []) {
    if (questionSimilarity(input.question, prior) >= DEGENERATE_SIMILARITY) {
      return 'repeat-question';
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Turn an answer into the stored label. `hit` is DERIVED ONCE, HERE, and stored —
 * never recomputed from `recommended === chosen` at read time (contract §4,
 * invariant 1): options are model-authored text, so a later row with a different
 * ordering would silently change what an old row meant.
 */
export function scoreCheckin(recommended: number, answer: CheckinAnswer): boolean {
  if (answer.unanswered) return false; // never reaches a row — see shouldRecord
  return answer.chosen >= 0 && answer.chosen === recommended;
}

/**
 * Whether this answer becomes a ledger row at all.
 *
 * An UNANSWERED check-in is not an observation: the user closed the app or
 * stopped the turn, and nothing was learned about what they wanted. Recording it
 * as a miss would punish the agent for the user's absence, and recording it as an
 * excluded row would still drag coverage down for the same reason. So it is
 * dropped — the one case where "keep everything" is the wrong rule, because the
 * event being kept would be a fabrication.
 */
export function shouldRecord(answer: CheckinAnswer): boolean {
  return !answer.unanswered;
}
