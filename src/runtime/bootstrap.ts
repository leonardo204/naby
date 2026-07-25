// src/runtime/bootstrap.ts
//
// COLD START (Phase 1.5, P15-07) — the first thing naby knows about you.
//
// THE PROBLEM THIS SOLVES. A fresh install knows nothing, so the persona is an
// egg with nothing to go on: its first recommendations are guesses, the check-ins
// that score them measure noise, and the user's early experience is of an agent
// that does not know them at all. The strategy names three ways out (§4.3):
//
//   A  import past artifacts (documents the user already wrote)
//   B  an onboarding interview
//   C  inherit an org persona
//
// THIS IMPLEMENTS B, and the reason is coverage rather than preference. C is the
// in-house differentiator, but it needs an org someone has already curated — for
// a genuinely new user there is nothing to inherit. A needs artifacts and a
// consent flow for reading them. B works with nobody's help and no prior state,
// which is exactly the situation "cold start" names.
//
// WHY THESE ANSWERS ARE `confirmed` AND `user`-TIER, unlike anything else that
// writes memory. The user typed them, deliberately, in answer to a direct
// question — that is the definition of the `user` tier, and the write gate's rule
// is about EXTERNAL content never auto-confirming (memory-contracts §4 invariant
// 1). Routing the user's own words through a review queue so they can confirm
// what they just wrote would be theatre.
//
// WHAT IS DELIBERATELY NOT ASKED: anything that goes stale. An early draft had
// "what are you working on now", which would have been written as a confirmed
// durable fact and then been wrong within a week — and confirmed memory is
// injected, so a stale one actively misleads. Every question below is one whose
// answer is still true next month; the current task is something the persona
// learns from the conversation, where it can also be forgotten.

import type { MemoryType, MemoryWriteRequest } from './store/store.js';
import { looksLikeSecret } from './tools.js';

/** Setting key recording that the interview was completed (or dismissed), so it
 *  is never asked twice. */
export const BOOTSTRAP_DONE_KEY = 'bootstrap.interviewDone';

/** Max length of one answer. Long enough for a sentence or two, short enough that
 *  an injected block cannot be dominated by one answer. */
export const BOOTSTRAP_ANSWER_MAX = 300;

/** One interview question. `id` becomes the memory key, so it is a stable slug
 *  the user's later edits update rather than duplicate. */
export interface BootstrapQuestion {
  id: string;
  type: MemoryType;
  /** i18n key the shell renders. The runtime holds NO display text — the same
   *  rule the growth reason codes follow. */
  labelKey: string;
  placeholderKey: string;
}

/**
 * The questions. FOUR, and the count is a decision: an interview long enough to
 * feel like a form gets abandoned, and each of these earns its place by changing
 * what the agent does on its very first turn.
 */
export const BOOTSTRAP_QUESTIONS: readonly BootstrapQuestion[] = [
  // How to address the user — the first thing that makes an answer feel written
  // for them rather than to nobody.
  { id: 'how-to-address-me', type: 'semantic', labelKey: 'bootstrap.q.address', placeholderKey: 'bootstrap.q.addressHint' },
  // Which language to answer in. Guessing this wrong is the most visible possible
  // failure, and it cannot be inferred from one message reliably.
  { id: 'answer-language', type: 'semantic', labelKey: 'bootstrap.q.language', placeholderKey: 'bootstrap.q.languageHint' },
  // How they want work done — the procedural core the persona is FOR.
  { id: 'how-i-want-work-done', type: 'procedural', labelKey: 'bootstrap.q.style', placeholderKey: 'bootstrap.q.styleHint' },
  // A standing prohibition. Asked separately from style because a "never do X" is
  // the one thing a user most wants honoured from turn one, and it gets lost when
  // folded into a general preference.
  { id: 'standing-rule', type: 'procedural', labelKey: 'bootstrap.q.rule', placeholderKey: 'bootstrap.q.ruleHint' },
];

/** Why an answer was not stored. Codes, not prose — the shell renders them. */
export type BootstrapSkipReason = 'empty' | 'too-long' | 'looks-like-secret' | 'unknown-question';

export interface BootstrapWriteSet {
  writes: MemoryWriteRequest[];
  skipped: Array<{ id: string; reason: BootstrapSkipReason }>;
}

/**
 * Turn interview answers into memory writes. PURE: no store, no clock beyond what
 * is handed in.
 *
 * Blank answers are SKIPPED, not stored as empty facts — "I did not want to say"
 * is not a preference, and an empty confirmed row would be injected as noise. Any
 * question may be left blank, which is why the interview can be finished in one
 * field.
 */
export function answersToMemory(
  answers: Readonly<Record<string, string>>,
  opts: { userId: string; now: number },
): BootstrapWriteSet {
  const writes: MemoryWriteRequest[] = [];
  const skipped: Array<{ id: string; reason: BootstrapSkipReason }> = [];
  const known = new Map(BOOTSTRAP_QUESTIONS.map((q) => [q.id, q]));

  for (const [id, raw] of Object.entries(answers)) {
    const q = known.get(id);
    if (!q) {
      skipped.push({ id, reason: 'unknown-question' });
      continue;
    }
    const value = String(raw ?? '').trim();
    if (!value) {
      skipped.push({ id, reason: 'empty' });
      continue;
    }
    if (value.length > BOOTSTRAP_ANSWER_MAX) {
      skipped.push({ id, reason: 'too-long' });
      continue;
    }
    // The same sweep every other write path runs. A user CAN type a token into a
    // free-text box, and app.db encryption is still undecided.
    if (looksLikeSecret(value)) {
      skipped.push({ id, reason: 'looks-like-secret' });
      continue;
    }
    writes.push({
      scope: 'user',
      scopeKey: opts.userId,
      type: q.type,
      key: q.id,
      value,
      provenance: {
        // The user's own words, typed deliberately. This is what the `user` tier
        // means, and it is what lets the answer be confirmed immediately.
        source: 'user',
        basis: 'answered during first-run setup',
      },
      confidence: 1,
      requestedStatus: 'confirmed',
    });
  }
  return { writes, skipped };
}

/** Whether the interview still has anything to offer: not yet done, and at least
 *  one question unanswered in the store. Kept here so the shell and the UI cannot
 *  disagree about when to show it. */
export function shouldOfferBootstrap(opts: {
  doneFlag: string | undefined;
  existingKeys: readonly string[];
}): boolean {
  if (opts.doneFlag === 'true') return false;
  const have = new Set(opts.existingKeys);
  return BOOTSTRAP_QUESTIONS.some((q) => !have.has(q.id));
}
