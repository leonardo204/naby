// src/runtime/memory-inject.ts
//
// TURN-TIME MEMORY RETRIEVAL + INJECTION (phase-1_5-memory-contracts §5, impl
// P15-02). Pure ranking + token-budget selection, plus a small store-reading
// gatherer and a renderer. Provider- and engine-independent: it runs in the
// runtime ABOVE the engine seam (design §3.4), so it behaves identically
// whichever model answers, and it assembles memory into the turn's SYSTEM field
// (never a stored transcript message — contract §3 "no role:'system' leakage").
//
// The load-bearing invariants (contract §5):
//   * Budget is a HARD ceiling: tokensUsed ≤ tokenBudget, always. Over-budget
//     candidates are dropped and COUNTED (droppedForBudget) — never silently.
//   * Only `confirmed` memory injects. `proposed` rows never shape a turn until
//     confirmed (prevents un-vetted / poisoned candidates from acting).
//   * Scope precedence on ties: session > project > user > org (immediacy).
//   * Empty is a NO-OP: no relevant memory ⇒ inject nothing ⇒ the turn is
//     byte-for-byte what Phase 1 would have sent.
//
// P3-M8c ADDS RELEVANCE (continuous-learning §6.2). The order used to be
// scope→type→recency alone, which meant a 2000-token budget was filled by the
// NEWEST confirmed facts whether or not they had anything to do with the turn.
// Now, when the turn supplies `queryText`, candidates are ordered by lexical
// overlap with it first and the old comparator only breaks ties. LEXICAL, not
// embeddings: the bottleneck is "irrelevant memory wins on recency", which token
// overlap already fixes, and it stays pure, deterministic and spike-checkable
// (embedding relevance is §8-open). The fallback is structural, not incidental —
// see `rankCandidates`.

// P3-M10 ADDS A FRESHNESS TIER to the tie-break chain (memory-hygiene §2.2). The
// staleness rule itself lives in memory-hygiene.ts — it is asked by the review
// queue and the browser filter too, and three copies of "how old is too old" is
// three places for the answer to drift.
//
// P3-M13b REPLACES THE BOOLEAN TIER WITH THE CONTINUOUS ONE it was standing in
// for (conversational-learning-hardening §3.2). `retrievability` is still asked
// of memory-hygiene, still lives strictly BELOW relevance, and still cannot
// change how much budget is spent — see `rankCandidates` for why moving from a
// boolean to a real number does not weaken the invariant P3-M10 wrote it for.
import { retrievability } from './memory-hygiene.js';
import type {
  InjectedMemory,
  MemoryInjectionQuery,
  MemoryItem,
  MemoryScope,
  MemoryType,
  Store,
} from './store/store.js';

/** Single-user machine default (contract §8 open q): the user scopeKey is a
 * constant until multi-user rollout. Callers may override. */
export const DEFAULT_USER_ID = 'local';

/** Scope precedence on ties (contract §5): session first, org last. */
const SCOPE_RANK: Record<MemoryScope, number> = {
  session: 0,
  project: 1,
  user: 2,
  org: 3,
};

/** Type priority — a TUNABLE, not a contract (contract §5 / §7-open). Working
 * state is the most immediately relevant in-session; procedural the least. */
const TYPE_RANK: Record<MemoryType, number> = {
  working: 0,
  episodic: 1,
  semantic: 2,
  procedural: 3,
};

/**
 * Token estimate for a piece of text. A deliberately simple, deterministic
 * heuristic (~4 chars/token) — the budget is a hard ceiling, not a billing
 * figure, so a conservative estimate is the right kind of wrong. Swappable
 * later without touching the selection logic.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/** The one-line rendering of an item — also the unit the budget is measured in,
 * so selection and rendering can never disagree on cost. */
export function renderMemoryLine(item: MemoryItem): string {
  return `- (${item.scope}/${item.type}) ${item.key}: ${item.value}`;
}

// ---------------------------------------------------------------------------
// Lexical relevance (P3-M8c, contract §5 `queryText`)
// ---------------------------------------------------------------------------

/**
 * Split text into comparable tokens. PURE and deterministic.
 *
 * The rules, and why each one is there:
 *   - LOWERCASED, so "Postgres" in a memory matches "postgres" in the turn.
 *   - Split on every non-letter/non-digit boundary. Punctuation, slashes and
 *     underscores are separators, so `config/prod.yaml` yields `config`, `prod`,
 *     `yaml` — the words a turn is likely to repeat, not the exact path.
 *   - HANGUL RUNS ARE THEIR OWN TOKENS, matched BEFORE the general letter run.
 *     Korean is written without spaces between a noun and its particle boundary
 *     markers in mixed text (`config파일`), so a single letter-run rule would
 *     produce the one token `config파일`, which matches neither `config` nor
 *     `파일`. Taking the Hangul run first splits scripts and both halves match.
 *   - ONE-CHARACTER TOKENS ARE DROPPED (§6.2). A single letter matches almost
 *     any text by accident, which would turn the score into noise.
 *
 * Not stemmed and not stop-worded on purpose: both are language-specific
 * guesses, and a wrong guess here silently changes which memory a turn sees.
 */
export function tokenizeForRelevance(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  // Hangul runs are FENCED OFF FIRST, then everything is split on letter/digit
  // runs. Doing it in one alternation does not work and the failure is silent:
  // a regex scanning `config파일` reaches `c` first, the Hangul branch does not
  // apply there, and the general letter branch then runs straight through the
  // script boundary to produce the single token `config파일` — which matches
  // neither half. Padding the Hangul run with spaces makes the boundary a
  // separator like any other.
  const fenced = text.toLowerCase().replace(/\p{Script=Hangul}+/gu, ' $& ');
  const matches = fenced.match(/[\p{L}\p{N}]+/gu);
  if (!matches) return [];
  return matches.filter((t) => t.length > 1);
}

/**
 * How much this memory has to do with the turn: the number of DISTINCT query
 * tokens that also appear in the memory's key+value, divided by the square root
 * of the memory's own token count.
 *
 * WHY THIS NORMALIZATION. Raw overlap alone rewards length — a rambling
 * 400-character memory would out-score a precise one-liner simply by containing
 * more words, which is the opposite of useful. Dividing by the FULL token count
 * over-corrects the other way (a long memory that genuinely covers the topic
 * loses to a short one that shares one incidental word). The square root sits
 * between the two: it is the usual length normalization for exactly this reason,
 * it is monotone in overlap for a fixed memory, and it is one arithmetic
 * expression — reproducible from the numbers a spike can print. Jaccard was the
 * alternative; it also divides by the QUERY length, which changes every memory's
 * score by the same factor and therefore cannot change the ORDER, so it buys
 * nothing here.
 *
 * 0 means "no shared word", and 0 is the value that makes the whole feature
 * fall back to the old order (see `rankCandidates`).
 */
export function relevanceScore(queryTokens: ReadonlySet<string>, item: MemoryItem): number {
  if (queryTokens.size === 0) return 0;
  const memTokens = tokenizeForRelevance(`${item.key} ${item.value}`);
  if (memTokens.length === 0) return 0;
  const distinct = new Set(memTokens);
  let overlap = 0;
  for (const token of distinct) {
    if (queryTokens.has(token)) overlap += 1;
  }
  if (overlap === 0) return 0;
  return overlap / Math.sqrt(memTokens.length);
}

/** The relevance-agnostic order: scope, then type priority, then most recently
 *  updated. Extracted so the ranking below can name it as its ONLY tiebreak —
 *  the Phase-1.5 order is not re-derived anywhere. */
function comparePrecedence(a: MemoryItem, b: MemoryItem): number {
  const s = SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope];
  if (s !== 0) return s;
  const t = TYPE_RANK[a.type] - TYPE_RANK[b.type];
  if (t !== 0) return t;
  return b.updatedAt - a.updatedAt; // newest first
}

// ---------------------------------------------------------------------------
// MMR duplicate suppression (P3-M13b §3.2)
// ---------------------------------------------------------------------------

/**
 * How similar two memories may be before the second one is pushed to the back of
 * the queue (§3.2). Jaccard over their key+value token sets.
 *
 * 0.6 is a first guess with a shape behind it rather than a measurement: two
 * memories sharing over half their distinct words are almost always the same
 * fact written twice ("prefers metric units" / "wants measurements in metric"),
 * while genuinely different facts about one topic overlap far less because the
 * TOPIC words are a small part of either sentence.
 */
export const MMR_SIM_THRESHOLD = 0.6;

/**
 * Token-set Jaccard similarity of two memories, in [0, 1].
 *
 * JACCARD RATHER THAN THE `relevanceScore` NORMALIZATION, deliberately: this
 * question is symmetric ("are these two the same thing?") where relevance is not
 * ("how much does this memory have to do with the turn?"), and a one-sided
 * measure would call a long memory a duplicate of a short one it merely
 * contains.
 */
export function memorySimilarity(a: MemoryItem, b: MemoryItem): number {
  const left = new Set(tokenizeForRelevance(`${a.key} ${a.value}`));
  const right = new Set(tokenizeForRelevance(`${b.key} ${b.value}`));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Rank candidates: most RELEVANT to this turn first, then by RETRIEVABILITY
 * (descending), with the Phase-1.5 precedence order (scope → type → recency)
 * breaking every remaining tie.
 *
 * THE FALLBACK IS STRUCTURAL, NOT INCIDENTAL, and that is the point. There is no
 * "did the query help?" branch to get wrong: when `queryText` is absent the score
 * map is EMPTY, and when no candidate shares a word with the turn every lookup
 * returns the same 0. Either way `scoreB - scoreA` is 0 for every pair and the
 * comparator falls through — as it did before relevance existed. `Array#sort` is
 * stable (ES2019), so genuinely equal elements keep their input order.
 *
 * Which is the guarantee contract §5 needs: a turn that relevance cannot help is
 * not made worse than it was, and the scope-precedence invariant still decides
 * every tie relevance and freshness both leave open.
 *
 * WHERE DECAY SITS, AND WHY EXACTLY THERE (P3-M10 §2.2, generalized by P3-M13b
 * §3.2). It is the SECOND comparison, never the first. The order of the two is
 * the whole design decision:
 *
 *   * RELEVANCE FIRST means a decayed memory that genuinely answers this turn
 *     still beats a fresh one that does not. Demoting it would trade the
 *     "confidently wrong from an old fact" failure for the strictly worse "did
 *     not know a fact it has written down" one. This is a BINDING invariant
 *     (§4 rejects multiplying decay into relevance), and it holds STRUCTURALLY
 *     here: the retrievability comparison is only reached when the relevance
 *     difference is exactly 0, so no amount of accumulated age can out-argue any
 *     relevance difference at all.
 *   * DECAY SECOND means it decides only what was otherwise ARBITRARY — two
 *     memories the turn matches equally well, or (on a query-less turn) every
 *     memory at once. That is where a month-dead fact was previously winning
 *     budget on nothing but scope order.
 *
 * WHAT CHANGED IN M13b, AND WHAT DID NOT. P3-M10 used a BOOLEAN tier (stale or
 * not) and said so, on the grounds that "a continuous decay curve would let
 * accumulated age out-argue a relevance difference somewhere". That risk was
 * real for a curve MULTIPLIED into the score; it does not exist for a curve
 * confined to a strictly lower comparison tier, which is what this is. The gain
 * is that two memories that are both stale — previously indistinguishable, and
 * therefore ordered by scope alone — are now ordered by how strongly they are
 * still held, which is the whole point of tracking strength.
 *
 * `now` is a parameter rather than a `Date.now()` call so the ordering is a pure
 * function of its inputs and a spike can pin it.
 */
function rankCandidates(
  items: readonly MemoryItem[],
  queryText?: string,
  now: number = Date.now(),
): MemoryItem[] {
  const queryTokens = new Set(tokenizeForRelevance(queryText ?? ''));
  const scores = new Map<string, number>();
  // An empty query token set scores nothing, so the map stays empty and the
  // relevance comparison below is a constant 0 for every pair.
  if (queryTokens.size > 0) {
    for (const item of items) {
      const score = relevanceScore(queryTokens, item);
      if (score > 0) scores.set(item.id, score);
    }
  }
  // Computed once per item rather than inside the comparator: a comparator runs
  // O(n log n) times and this is arithmetic, but more importantly it must answer
  // identically for the same item every time it is asked — a `Date.now()` read
  // inside the comparison could flip an answer mid-sort and produce an
  // inconsistent ordering, which V8 is entitled to turn into anything at all.
  const retention = new Map<string, number>();
  for (const item of items) retention.set(item.id, retrievability(item, now));
  return [...items].sort((a, b) => {
    const relevance = (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0);
    if (relevance !== 0) return relevance;
    // DESCENDING: the more retrievable memory first. Two rows with identical
    // access history and strength give exactly 0 here and fall through, which is
    // what keeps the Phase-1.5 precedence order deciding everything it used to.
    const decay = (retention.get(b.id) ?? 0) - (retention.get(a.id) ?? 0);
    if (decay !== 0) return decay;
    return comparePrecedence(a, b);
  });
}

/**
 * Push near-duplicates of something already selected to the BACK of the queue
 * (§3.2 — Maximal Marginal Relevance, Carbonell & Goldstein 1998).
 *
 * DEFERRED, NEVER DROPPED, and the difference is the entire design. A dropped
 * near-duplicate is a fact the turn cannot see because some other fact happened
 * to share its vocabulary — an invisible loss, caused by a threshold nobody
 * tuned. A deferred one simply loses its place: if the budget still has room
 * after everything distinct has been taken, it comes back in. So the worst case
 * of a badly-chosen threshold is a slightly odd ORDER, never a missing memory.
 *
 * THE BUDGET LOGIC IS UNTOUCHED (contract §5). This reorders the queue and
 * nothing else; the caller still walks it greedily and still counts every drop
 * as a budget drop, so `tokensUsed ≤ tokenBudget` cannot be affected by anything
 * here.
 *
 * Comparison is against what has ALREADY BEEN KEPT rather than against the whole
 * list, which is what makes it MMR rather than plain deduplication: the first of
 * a family of near-identical memories is kept in full standing, and only its
 * echoes are demoted.
 */
export function deferNearDuplicates(
  ranked: readonly MemoryItem[],
  threshold: number = MMR_SIM_THRESHOLD,
): MemoryItem[] {
  if (ranked.length < 2) return [...ranked];
  const kept: MemoryItem[] = [];
  const deferred: MemoryItem[] = [];
  for (const item of ranked) {
    const duplicate = kept.some((chosen) => memorySimilarity(chosen, item) > threshold);
    if (duplicate) deferred.push(item);
    else kept.push(item);
  }
  // The deferred keep their relative order: among echoes, the better-ranked one
  // is still the better one.
  return [...kept, ...deferred];
}

/**
 * Select, rank, and budget candidate memory for one turn. PURE. Filters to
 * `confirmed` only, ranks by relevance-then-precedence, then greedily fills up
 * to `tokenBudget` — every candidate that would push the total over the cap is
 * dropped and counted. `tokensUsed` is the summed cost of the included item
 * lines and is ALWAYS ≤ tokenBudget.
 *
 * `queryText` is the turn's own words (P3-M8c). Omit it and relevance ranks
 * nothing; the BUDGET half is untouched either way, so relevance changes WHICH
 * memory wins a contested budget and never how much of it is spent — and the same
 * is true of the P3-M10 freshness tier, which is why neither can breach the hard
 * ceiling.
 *
 * `now` (P3-M10) is what staleness is measured against; it defaults to the clock
 * and exists so a spike can make a memory 40 days old without waiting.
 */
export function selectMemoryForInjection(
  candidates: readonly MemoryItem[],
  tokenBudget: number,
  queryText?: string,
  now: number = Date.now(),
): InjectedMemory {
  const budget = Math.max(0, Math.floor(tokenBudget));
  // Only confirmed memory injects (contract §5) — and, since P3-M13a, only
  // memory nothing has REPLACED (§3.1).
  //
  // THE TWO CONDITIONS SIT TOGETHER ON PURPOSE. Both answer the same question —
  // "may this row shape a turn?" — and both are the reason a row can exist in the
  // store while being invisible to the model. Splitting them across two layers is
  // how one of them ends up applied on one read path and not another; the store
  // therefore has no opinion about supersession on the injection path at all, and
  // this line is the whole rule.
  const injectable = candidates.filter(
    (c) => c.status === 'confirmed' && c.supersededAt === undefined,
  );
  // MMR (P3-M13b §3.2) reorders AFTER the ranking and BEFORE the budget walk, so
  // it can only change which of two equally-affordable memories is reached first
  // — never the ceiling, and never whether something is reachable at all.
  const ranked = deferNearDuplicates(rankCandidates(injectable, queryText, now));

  const items: MemoryItem[] = [];
  let tokensUsed = 0;
  let droppedForBudget = 0;

  for (const item of ranked) {
    const cost = estimateTokens(renderMemoryLine(item));
    if (tokensUsed + cost <= budget) {
      items.push(item);
      tokensUsed += cost;
    } else {
      // Dropped PURELY due to the cap — counted, never silent (contract §5).
      droppedForBudget += 1;
    }
  }

  return { items, tokensUsed, droppedForBudget };
}

/**
 * Read the candidate memory for a query from the store: confirmed rows from the
 * session, project (if the session is projected), user, and org scopes. The
 * user/org scopeKeys are single-user-machine constants until multi-user rollout
 * (contract §8-open) and may be overridden.
 */
export function gatherCandidates(
  store: Store,
  query: MemoryInjectionQuery,
  opts?: { userId?: string; orgId?: string },
): MemoryItem[] {
  const out: MemoryItem[] = [];
  // session scope (always)
  out.push(
    ...store.getScopedMemory('session', query.sessionId, { status: 'confirmed' }),
  );
  // project scope (only when the session is projected)
  if (query.cwd) {
    out.push(...store.getScopedMemory('project', query.cwd, { status: 'confirmed' }));
  }
  // user scope (a constant scopeKey on a single-user machine)
  const userId = opts?.userId ?? DEFAULT_USER_ID;
  out.push(...store.getScopedMemory('user', userId, { status: 'confirmed' }));
  // org scope (only when an org id is supplied — org memory is in-house-only)
  if (opts?.orgId) {
    out.push(...store.getScopedMemory('org', opts.orgId, { status: 'confirmed' }));
  }
  return out;
}

/**
 * Gather + select in one call: the store-reading entry point runTurn uses.
 * Returns the ranked, budgeted, confirmed-only injection set. `query.queryText`,
 * when the caller supplies it, is what the ranking is relevant TO (P3-M8c).
 */
export function retrieveForInjection(
  store: Store,
  query: MemoryInjectionQuery,
  opts?: { userId?: string; orgId?: string; now?: number },
): InjectedMemory {
  return selectMemoryForInjection(
    gatherCandidates(store, query, opts),
    query.tokenBudget,
    query.queryText,
    opts?.now ?? Date.now(),
  );
}

/**
 * Render the selected memory as a system-prompt block. Returns `undefined` when
 * there is nothing to inject, so the caller can leave the turn's system field
 * BYTE-FOR-BYTE unchanged (the no-op invariant, contract §5).
 */
export function renderInjectedMemory(injected: InjectedMemory): string | undefined {
  if (injected.items.length === 0) return undefined;
  const lines = injected.items.map(renderMemoryLine);
  return [
    'Relevant remembered context about this user (apply where it fits; do not mention this block):',
    ...lines,
  ].join('\n');
}

/**
 * Compose a turn's effective system prompt from the caller's base system and the
 * injected memory block. When there is nothing to inject, returns the base
 * UNCHANGED (including `undefined`) — the no-op guarantee. When there is, the
 * memory block is appended after the base so the base instruction still leads.
 */
export function composeSystemWithMemory(
  baseSystem: string | undefined,
  injected: InjectedMemory,
): string | undefined {
  const block = renderInjectedMemory(injected);
  if (block === undefined) return baseSystem; // NO-OP: byte-for-byte unchanged
  if (baseSystem === undefined || baseSystem.length === 0) return block;
  return `${baseSystem}\n\n${block}`;
}
