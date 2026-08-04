// src/runtime/memory-consolidation.ts
//
// THE FOUR-OPERATION MEMORY UPDATE + SUPERSESSION (Phase 3 P3-M13a —
// specs/phase-3-conversational-learning-hardening.md §3.1).
//
// THE HOLE THIS FILLS. Until now every memory proposal was an ADD. A preference
// that changed produced a SECOND row saying the opposite of the first, both
// confirmed, both injected, and the model was left to reconcile them inside the
// prompt — which it does by picking whichever it read last. The user's own
// record of themselves accumulated contradictions and nothing in the system had
// the concept "this replaced that".
//
// THE DIVISION OF LABOUR, WHICH IS THE WHOLE DESIGN. Three steps, and only the
// middle one is a model:
//
//   1. MATCHING is CODE (`matchCandidates`) — lexical similarity against the
//      candidate's own scope, reusing the injection tokenizer so "which existing
//      memory is this about" is answered the same way "which memory is this turn
//      about" already is.
//   2. JUDGING is a MODEL, and it is asked ONE narrow question per pair:
//      equivalent | refines | contradicts | unrelated. It is not asked which one
//      is true, or which is newer, or what to do.
//   3. DECIDING is CODE (`applyConsolidation`) — a total function from verdict to
//      operation, and the winner of a contradiction is ALWAYS the newer
//      timestamp.
//
// WHY THE SPLIT IS NOT FASTIDIOUSNESS. The research the spec cites (arXiv:
// 2606.01435) measures it: leaving the recency judgement to the LLM as well
// costs 24–40 percentage points against exactly this arrangement. A model asked
// "which of these two contradicting facts is current?" answers from the
// plausibility of the sentences, and the older sentence is often the more
// plausible one — it has had longer to be phrased well. A timestamp comparison
// cannot make that mistake, and Mem0's ADD/UPDATE/DELETE/NOOP quartet
// (arXiv:2504.19413) plus Zep/Graphiti's "invalidate with a timestamp rather
// than delete" (arXiv:2501.13956) are the two shapes this file is built from.
//
// EVERYTHING HERE IS PURE. No store handle, no clock, no model. The shell's
// reflection sweep supplies the existing rows and executes the returned
// operation; the spikes drive the same functions with fixed inputs.

import { relevanceScore, tokenizeForRelevance } from './memory-inject.js';
import type { MemoryItem, MemoryVolatility } from './store/store.js';

// ---------------------------------------------------------------------------
// Matching (step 1 — code)
// ---------------------------------------------------------------------------

/** How many existing memories one candidate is matched against. Each match
 *  becomes a PAIR the judge has to label, so this is a direct multiplier on the
 *  prompt: three is enough to catch the row a candidate is really about (memory
 *  keys within one scope are not that similar to each other) and small enough
 *  that five candidates cost fifteen short lines rather than a second call. */
export const MATCH_CANDIDATE_CAP = 3;

/** Below this lexical score two memories are simply not about the same thing,
 *  and pairing them would spend prompt on a question whose answer is
 *  `unrelated` by construction. Anything above zero shares a real word; the
 *  floor is deliberately just above zero because `relevanceScore` already
 *  length-normalizes, so a shared incidental word scores low rather than being
 *  filtered by a threshold nobody can justify. */
export const MATCH_MIN_SCORE = 0.2;

/** The candidate side of a match — the shape a reflection proposal has before
 *  anything has been written. Structural so the validated-candidate type from
 *  reflection.ts satisfies it without this module importing it. */
export type ConsolidationCandidate = {
  scope: MemoryItem['scope'];
  key: string;
  value: string;
  volatility?: MemoryVolatility;
};

/**
 * The legible name of an existing memory in a prompt: `<scope>:<key>`.
 *
 * NOT THE ID. An id is a random handle a model has a real chance of mangling
 * when it copies it, and a mangled id is indistinguishable from a hallucinated
 * one. `(scope, key)` is unique within a scope key, is readable, and is
 * re-derivable in code from the same row — so a relation naming a handle can be
 * matched back to the exact row the prompt showed, and one naming anything else
 * simply finds nothing.
 */
export function memoryHandle(item: Pick<MemoryItem, 'scope' | 'key'>): string {
  return `${item.scope}:${item.key}`;
}

/** One existing memory a candidate might be about, with the score that put it
 *  there — carried so the sweep can log WHY a pair was judged. */
export type MemoryMatch = {
  item: MemoryItem;
  score: number;
};

/**
 * The existing memories this candidate might be about, best first.
 *
 * SAME SCOPE ONLY. A `user`-scope preference and a `project`-scope convention
 * can say word-for-word the same thing and still both be true — scope is what
 * makes them different facts, so a cross-scope "contradiction" would retire a
 * memory that was never in competition with anything.
 *
 * SUPERSEDED ROWS ARE NOT MATCHED. They are already retired; pairing against one
 * could only produce a chain that retires it twice, and `supersedeMemory`
 * refuses that anyway. Keeping the refusal out of the prompt saves the judge a
 * question with no useful answer.
 *
 * LEXICAL, NOT EMBEDDINGS, for exactly the reason the injection ranking is
 * (memory-inject header): the failure being fixed is "the same fact stated twice
 * in slightly different words", which token overlap catches, and staying pure
 * keeps the whole decision reproducible from a spike.
 */
export function matchCandidates(
  candidate: ConsolidationCandidate,
  existing: readonly MemoryItem[],
  opts?: { limit?: number; minScore?: number },
): MemoryMatch[] {
  const limit = Math.max(0, opts?.limit ?? MATCH_CANDIDATE_CAP);
  const minScore = opts?.minScore ?? MATCH_MIN_SCORE;
  if (limit === 0) return [];
  const tokens = new Set(tokenizeForRelevance(`${candidate.key} ${candidate.value}`));
  if (tokens.size === 0) return [];

  const scored: MemoryMatch[] = [];
  for (const item of existing) {
    if (item.scope !== candidate.scope) continue;
    if (item.supersededAt !== undefined) continue;
    const score = relevanceScore(tokens, item);
    if (score < minScore) continue;
    scored.push({ item, score });
  }
  // Ties broken by id so the pair list a prompt carries is deterministic — two
  // runs over the same store must ask the judge the same questions.
  scored.sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
  return scored.slice(0, limit);
}

// ---------------------------------------------------------------------------
// The verdict (step 2 — the model's ONLY say)
// ---------------------------------------------------------------------------

/**
 * What the judge is allowed to say about one (candidate, existing) pair.
 *
 *   * `equivalent` — the same claim, however differently worded.
 *   * `refines` — the same subject, said more precisely or more completely.
 *   * `contradicts` — both cannot be true of this person at once.
 *   * `unrelated` — different subjects.
 *
 * That is the entire vocabulary. Note what is NOT in it: no "the new one is
 * right", no "delete the old one", no confidence. The model reports a RELATION;
 * every consequence is decided below.
 */
export type PairVerdict = 'equivalent' | 'refines' | 'contradicts' | 'unrelated';

export const PAIR_VERDICTS: readonly PairVerdict[] = [
  'equivalent',
  'refines',
  'contradicts',
  'unrelated',
];

/** Read an untrusted string as a verdict; anything unrecognizable reads as
 *  `unrelated`, which is the operation that changes the least (a plain ADD). */
export function readPairVerdict(raw: unknown): PairVerdict {
  return typeof raw === 'string' && (PAIR_VERDICTS as readonly string[]).includes(raw)
    ? (raw as PairVerdict)
    : 'unrelated';
}

// ---------------------------------------------------------------------------
// The operation (step 3 — code, deterministic)
// ---------------------------------------------------------------------------

/**
 * What the sweep should actually do with a candidate.
 *
 *   * `noop` — write the EXISTING key with the EXISTING value. That reads like a
 *     no-op and is one, with the single intended side effect: `putMemory`
 *     records this session's corroboration observation (P3-M8b §5.3), and
 *     because the value is unchanged the existing evidence is kept rather than
 *     reset. Re-hearing a fact you already knew is the definition of a
 *     corroborating session, and routing it through the ordinary write path is
 *     what stops corroboration having a second, forgettable entry point.
 *   * `update` — write the EXISTING key with the CANDIDATE's value. The upsert
 *     identity is (scope, scopeKey, key), so this lands on the same row, and
 *     `putMemory`'s own rule then resets corroboration exactly when the claim
 *     materially changed. Nothing about that rule is re-implemented here.
 *   * `add` — write the candidate's own key as a new row. `supersedes` carries
 *     the RESERVATION when this add is a contradiction: the id it will retire
 *     once (and only once) it becomes confirmed.
 */
export type ConsolidationOp =
  | { op: 'noop'; targetId: string; key: string; value: string }
  | { op: 'update'; targetId: string; key: string; value: string }
  | { op: 'add'; key: string; value: string; supersedes?: string };

/**
 * Turn one pair verdict into the operation to perform. TOTAL and DETERMINISTIC.
 *
 * `existing` absent (nothing matched) is a plain ADD whatever the verdict says —
 * a relation to nothing is not a relation.
 *
 * THE SUPERSESSION RESERVATION, and the two rules that constrain it (§3.1):
 *
 *   * IT IS ONLY A RESERVATION. `add` with `supersedes` does not retire
 *     anything; it records which row this one WILL retire if it is ever
 *     confirmed. A `proposed` candidate supersedes nothing, so the old fact goes
 *     on living, injecting and being the agent's belief until a person agrees to
 *     the new one — which is the difference between a system that learns and one
 *     that overwrites you with a model's guess.
 *   * A TRANSIENT FACT NEVER RETIRES A STABLE ONE. "In Berlin this week" must
 *     not erase "lives in Lisbon"; it is the failure mode the literature names,
 *     and an untagged row counts as stable, so the guard also covers every row
 *     written before volatility existed. The result is a plain ADD: both facts
 *     live, which is correct — they were never in competition.
 *
 * The store re-checks the volatility rule inside `supersedeMemory`. That is
 * deliberate duplication of a REFUSAL (never of a decision): this function
 * decides whether to reserve, the store decides whether to stamp, and a bug in
 * either one alone still cannot erase a stable memory.
 */
export function applyConsolidation(
  verdict: PairVerdict,
  candidate: ConsolidationCandidate,
  existing?: MemoryItem,
): ConsolidationOp {
  if (!existing) return { op: 'add', key: candidate.key, value: candidate.value };

  switch (verdict) {
    case 'equivalent':
      return {
        op: 'noop',
        targetId: existing.id,
        key: existing.key,
        value: existing.value,
      };

    case 'refines':
      return {
        op: 'update',
        targetId: existing.id,
        key: existing.key,
        value: candidate.value,
      };

    case 'contradicts': {
      // SAME KEY IS AN UPDATE, NOT A SUPERSESSION. The upsert identity would put
      // the "new" row on top of the old one anyway, and a row cannot supersede
      // itself — reserving here would produce a reservation that can only ever
      // be refused. `putMemory`'s value-change rule already wipes the evidence
      // for the claim being replaced, which is the whole effect wanted.
      if (candidate.key === existing.key) {
        return { op: 'update', targetId: existing.id, key: existing.key, value: candidate.value };
      }
      if (!maySupersede(candidate, existing)) {
        return { op: 'add', key: candidate.key, value: candidate.value };
      }
      return { op: 'add', key: candidate.key, value: candidate.value, supersedes: existing.id };
    }

    case 'unrelated':
    default:
      return { op: 'add', key: candidate.key, value: candidate.value };
  }
}

/**
 * May a memory of this volatility retire one of that volatility (§3.1)?
 *
 * Only rule: a `transient` claimant cannot retire a row that is not itself
 * transient. Absent reads as `stable` on BOTH sides, which is what makes every
 * pre-v12 row safe from a passing detail.
 */
export function maySupersede(
  claimant: Pick<ConsolidationCandidate, 'volatility'>,
  target: Pick<MemoryItem, 'volatility'>,
): boolean {
  const claimantVolatility = claimant.volatility ?? 'stable';
  const targetVolatility = target.volatility ?? 'stable';
  return !(claimantVolatility === 'transient' && targetVolatility !== 'transient');
}
