// src/runtime/style-fingerprint.ts
//
// THE STYLE FINGERPRINT (Phase 3 P3-M13c —
// specs/phase-3-conversational-learning-hardening.md §3.3, second half).
//
// WHAT IT IS. A handful of COUNTS over the user's own messages: how long their
// sentences run, which endings they use, how often they ask rather than tell,
// how often they write in lists. Nothing here is inferred, judged or generated —
// it is arithmetic over text, and that is the whole point of splitting §3.3 in
// two. Preference STATEMENTS ("wants conclusions first") need a model to read
// them out of a conversation and therefore need the whole proposed → review
// machinery to make them safe. How long your sentences are needs a divider.
//
// WHY IT IS SEPARATE FROM MEMORY. A fingerprint is not a claim about the user
// that could be wrong in an interesting way, so it does not belong in a review
// queue: it is a summary of text they already wrote, recomputed from scratch
// whenever the sweep runs, and worth exactly nothing on its own. Putting it in
// `memory_items` would fill the browser with rows nobody can meaningfully
// confirm or delete ("your average sentence is 34 characters" — and?). It lives
// in ONE settings key, is shown read-only, and disappears the moment learning is
// off (`canCaptureMemory` — the gate is applied by the caller, exactly as it is
// for the LLM half; there is deliberately no style-specific switch, §4).
//
// WHY IT IS INJECTED AS ONE LINE. The agent does not need the numbers; it needs
// the instruction they imply. `renderStyleFingerprintLine` compresses the whole
// profile into a single English sentence and refuses to produce one at all below
// `STYLE_FINGERPRINT_MIN_SAMPLES`, because a "style" read off six messages is a
// description of six messages.
//
// PURE. No store, no clock of its own (`now` is a parameter), no model.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The settings key the JSON lives under. One key, one writer (the reflection
 *  sweep), one reader (the turn assembly + the settings panel). */
export const STYLE_FINGERPRINT_KEY = 'style.fingerprint';

/**
 * How many user messages must have gone into a fingerprint before it may shape a
 * turn.
 *
 * TWENTY IS A FLOOR AGAINST DESCRIBING AN ACCIDENT. Below it the "profile" is
 * whatever the last two conversations happened to look like — a week of debugging
 * (short fragments, no politeness endings) would teach naby that this person
 * writes in fragments, and it would keep answering that way through the next
 * month of ordinary work. The number is a first guess and is cheap to be wrong
 * about in the safe direction: too high merely delays a nicety.
 */
export const STYLE_FINGERPRINT_MIN_SAMPLES = 20;

/**
 * The largest `sampleCount` a stored fingerprint may claim.
 *
 * IT IS A FORGETTING MECHANISM, not a memory limit. The merge below is an
 * incremental mean weighted by sample count, so without a cap a profile built
 * from two thousand old messages would move by 0.1% when the user changed how
 * they write. Capping the accumulated weight at 200 means the last few hundred
 * messages always dominate — the profile follows a person who changes, which is
 * the only reason to keep recomputing it.
 */
export const STYLE_SAMPLE_CAP = 200;

/** Shortest run of text that counts as a sentence. One or two characters is
 *  punctuation debris from splitting, and letting it through would drag the
 *  average sentence length toward zero. */
const MIN_SENTENCE_CHARS = 2;

// ---------------------------------------------------------------------------
// The shape
// ---------------------------------------------------------------------------

/**
 * How the user's own sentences END, as fractions summing to ~1.
 *
 * `fragment` is everything that is neither: noun-final Korean (`~함`, `~것`),
 * every English sentence, and every genuine fragment. That bucket is
 * deliberately honest rather than clever — it says "no Korean politeness ending
 * was observed here", which is exactly true of an English writer, and the
 * rendered line says so in words rather than implying the person writes in
 * fragments.
 */
export type StyleEndings = {
  /** `~다` — the plain declarative the project's own documents are written in. */
  formal: number;
  /** `~요` / `~죠` — the polite conversational ending. */
  polite: number;
  /** Neither of the above. See the note above. */
  fragment: number;
};

export type StyleFingerprint = {
  /** User messages this profile was built from (capped at `STYLE_SAMPLE_CAP`). */
  sampleCount: number;
  /** Sentences seen — reported because `avgSentenceChars` is meaningless without
   *  the count it averages over. */
  sentenceCount: number;
  /**
   * Mean sentence length in CHARACTERS, not words.
   *
   * Words are a language-specific unit: Korean writes a noun and its particle
   * together, so a word count silently reports Korean as terser than English for
   * the same content. Characters are comparable across both scripts, which is
   * what a mixed-language user needs.
   */
  avgSentenceChars: number;
  endings: StyleEndings;
  /** Fraction of sentences that ASK. */
  questionRatio: number;
  /** Fraction of MESSAGES containing a bulleted or numbered line. Per message
   *  rather than per sentence because writing a list is a decision about a whole
   *  message. */
  listRatio: number;
  /** epoch ms this was computed. Stored so the settings panel can say how fresh
   *  it is, and so a fingerprint from a long-abandoned install is legible as old
   *  rather than silently current. */
  computedAt: number;
};

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

/**
 * Split one message into sentences.
 *
 * Terminators are `.`/`!`/`?`/`…` and their full-width forms, plus newlines —
 * a line break in a chat message is a sentence boundary far more often than not,
 * and treating a five-line bulleted message as one 300-character sentence would
 * be the single biggest distortion in the average.
 *
 * The terminator is KEPT on the fragment before it (the split is on a lookbehind
 * of sorts, implemented by capturing), because `questionRatio` needs to see the
 * `?`.
 */
export function splitSentences(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const out: string[] = [];
  let current = '';
  for (const ch of text) {
    if (ch === '\n') {
      if (current.trim().length >= MIN_SENTENCE_CHARS) out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
    if (ch === '.' || ch === '!' || ch === '?' || ch === '…' || ch === '。' || ch === '！' || ch === '？') {
      if (current.trim().length >= MIN_SENTENCE_CHARS) out.push(current.trim());
      current = '';
    }
  }
  if (current.trim().length >= MIN_SENTENCE_CHARS) out.push(current.trim());
  return out;
}

/** The sentence with its trailing punctuation and whitespace removed — what the
 *  ending classifier looks at. */
function endingChar(sentence: string): string {
  const stripped = sentence.replace(/[\s.!?…。！？~"'”’)\]]+$/u, '');
  return stripped.length === 0 ? '' : (stripped[stripped.length - 1] as string);
}

/** Does this sentence ASK?
 *
 *  A trailing `?` (either width) is the reliable signal in both languages. The
 *  Korean `~까` ending is added because a question mark is frequently dropped in
 *  chat ("이거 맞을까"), and it is the one ender that is almost never declarative.
 *  Nothing more is guessed: an over-eager interrogative detector would report a
 *  person as asking twice as often as they do, and the injected line would then
 *  tell the agent to answer questions nobody asked. */
export function isQuestionSentence(sentence: string): boolean {
  const trimmed = sentence.trim();
  if (trimmed.endsWith('?') || trimmed.endsWith('？')) return true;
  return endingChar(trimmed) === '까';
}

/** Does this message use a list? A line starting with `-`, `*`, `•` or `1.` —
 *  the four spellings that actually occur in chat. */
export function usesList(text: string): boolean {
  return /^[ \t]*(?:[-*•]\s|\d+[.)]\s)/mu.test(text);
}

/** Which of the three ending buckets this sentence falls in. */
export function classifyEnding(sentence: string): keyof StyleEndings {
  const last = endingChar(sentence);
  if (last === '다') return 'formal';
  if (last === '요' || last === '죠' || last === '조') return 'polite';
  return 'fragment';
}

function ratio(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return round2(part / whole);
}

/** Two decimals — enough resolution for a summary line, and it makes the stored
 *  JSON stable so an unchanged style does not rewrite the settings row with
 *  floating-point noise on every sweep. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Count a batch of user-authored messages into a fingerprint.
 *
 * `texts` must be the USER's own words and nothing else. An assistant reply in
 * here would teach naby to imitate itself, which is the one direction a style
 * profile must never drift — and it is why the caller passes texts rather than
 * transcript rows.
 */
export function computeStyleFingerprint(
  texts: readonly string[],
  now: number,
): StyleFingerprint {
  const messages = texts.filter((t) => typeof t === 'string' && t.trim().length > 0);
  let sentenceCount = 0;
  let totalChars = 0;
  let questions = 0;
  let lists = 0;
  const endings: Record<keyof StyleEndings, number> = { formal: 0, polite: 0, fragment: 0 };

  for (const text of messages) {
    if (usesList(text)) lists += 1;
    for (const sentence of splitSentences(text)) {
      sentenceCount += 1;
      totalChars += sentence.length;
      if (isQuestionSentence(sentence)) questions += 1;
      endings[classifyEnding(sentence)] += 1;
    }
  }

  return {
    sampleCount: messages.length,
    sentenceCount,
    avgSentenceChars: sentenceCount === 0 ? 0 : round2(totalChars / sentenceCount),
    endings: {
      formal: ratio(endings.formal, sentenceCount),
      polite: ratio(endings.polite, sentenceCount),
      fragment: ratio(endings.fragment, sentenceCount),
    },
    questionRatio: ratio(questions, sentenceCount),
    listRatio: ratio(lists, messages.length),
    computedAt: now,
  };
}

/**
 * Fold a freshly-counted batch into the stored profile.
 *
 * AN INCREMENTAL MEAN, weighted by sample count, because the sweep only ever
 * sees the sessions it swept — recomputing from scratch each time would make the
 * "profile" a description of the last two conversations, and re-reading every
 * transcript ever written would make a background pass O(history) on every run.
 *
 * The stored `sampleCount` is capped (`STYLE_SAMPLE_CAP`) while the WEIGHTS use
 * the true totals, which is what gives recent messages a permanent floor of
 * influence: see the constant for why a profile that cannot move is not worth
 * recomputing.
 */
export function mergeStyleFingerprint(
  previous: StyleFingerprint | undefined,
  batch: StyleFingerprint,
): StyleFingerprint {
  if (!previous || previous.sampleCount <= 0) return batch;
  if (batch.sampleCount <= 0) return { ...previous, computedAt: batch.computedAt };

  const oldWeight = Math.min(previous.sampleCount, STYLE_SAMPLE_CAP);
  const newWeight = batch.sampleCount;
  const total = oldWeight + newWeight;
  const blend = (a: number, b: number): number =>
    round2((a * oldWeight + b * newWeight) / total);

  return {
    sampleCount: Math.min(total, STYLE_SAMPLE_CAP),
    sentenceCount: previous.sentenceCount + batch.sentenceCount,
    avgSentenceChars: blend(previous.avgSentenceChars, batch.avgSentenceChars),
    endings: {
      formal: blend(previous.endings.formal, batch.endings.formal),
      polite: blend(previous.endings.polite, batch.endings.polite),
      fragment: blend(previous.endings.fragment, batch.endings.fragment),
    },
    questionRatio: blend(previous.questionRatio, batch.questionRatio),
    listRatio: blend(previous.listRatio, batch.listRatio),
    computedAt: batch.computedAt,
  };
}

// ---------------------------------------------------------------------------
// Storage + rendering
// ---------------------------------------------------------------------------

export function serializeStyleFingerprint(fingerprint: StyleFingerprint): string {
  return JSON.stringify(fingerprint);
}

/**
 * Read the stored JSON back. Returns undefined for anything unreadable, which is
 * the right failure everywhere it is used: no fingerprint means no injected line
 * and an empty settings row, i.e. the app behaves exactly as it did before the
 * feature existed rather than acting on half a profile.
 */
export function parseStyleFingerprint(raw: string | undefined | null): StyleFingerprint | undefined {
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const row = parsed as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const endings = (row.endings ?? {}) as Record<string, unknown>;
  const sampleCount = num(row.sampleCount);
  if (sampleCount <= 0) return undefined;
  return {
    sampleCount,
    sentenceCount: num(row.sentenceCount),
    avgSentenceChars: num(row.avgSentenceChars),
    endings: {
      formal: num(endings.formal),
      polite: num(endings.polite),
      fragment: num(endings.fragment),
    },
    questionRatio: num(row.questionRatio),
    listRatio: num(row.listRatio),
    computedAt: num(row.computedAt),
  };
}

/** Above this fraction an ending or a habit is worth mentioning at all. Below
 *  it, saying "sometimes uses lists" would be describing noise as a preference.
 *
 *  EXPORTED since P3-M14a: the naby layer (runtime/voice.ts) asks the same
 *  question of the same numbers — "does this person NOTABLY prefer an ending" —
 *  when it decides whether an answer's register is a deviation. Two copies of this
 *  threshold would mean the injected line and the rewrite trigger could disagree
 *  about what this user prefers. */
export const STYLE_NOTABLE = 0.3;

/**
 * The ONE English line injected into a persona turn, or undefined when there is
 * not enough evidence to say anything.
 *
 * ENGLISH, and compact, for the reason the whole codebase writes its prompts in
 * English: this is an instruction to a model, not UI copy. It names OBSERVED
 * HABITS and asks the agent to match them — it never states the numbers, because
 * a model handed "questionRatio: 0.41" will start reasoning about the number
 * instead of writing the way the person writes.
 *
 * IT IS ADVISORY, AND SAYS SO. Style is the thing a user notices least and
 * resents most when it is wrong, so the line ends by subordinating itself to
 * whatever the current turn actually asks for.
 */
export function renderStyleFingerprintLine(
  fingerprint: StyleFingerprint | undefined,
  minSamples: number = STYLE_FINGERPRINT_MIN_SAMPLES,
): string | undefined {
  if (!fingerprint || fingerprint.sampleCount < minSamples) return undefined;
  if (fingerprint.sentenceCount === 0) return undefined;

  const traits: string[] = [];
  traits.push(
    fingerprint.avgSentenceChars <= 40
      ? 'writes short sentences'
      : fingerprint.avgSentenceChars >= 90
        ? 'writes long, dense sentences'
        : 'writes medium-length sentences',
  );
  if (fingerprint.endings.polite >= STYLE_NOTABLE) traits.push('uses the polite Korean ~요 ending');
  if (fingerprint.endings.formal >= STYLE_NOTABLE) traits.push('uses the plain Korean ~다 ending');
  if (fingerprint.questionRatio >= STYLE_NOTABLE) traits.push('often asks rather than instructs');
  if (fingerprint.listRatio >= STYLE_NOTABLE) traits.push('often writes in bulleted lists');

  return (
    `Observed writing style of this user: ${traits.join('; ')}. ` +
    'Match it where it fits; the current request always wins.'
  );
}
