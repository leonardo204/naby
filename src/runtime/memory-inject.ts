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

/**
 * Rank candidates deepest-first by relevance-agnostic precedence: scope, then
 * type priority, then most-recently-updated. (Real relevance ranking is Phase
 * 2b; this is the deterministic Phase-1.5 order.)
 */
function rankCandidates(items: readonly MemoryItem[]): MemoryItem[] {
  return [...items].sort((a, b) => {
    const s = SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope];
    if (s !== 0) return s;
    const t = TYPE_RANK[a.type] - TYPE_RANK[b.type];
    if (t !== 0) return t;
    return b.updatedAt - a.updatedAt; // newest first
  });
}

/**
 * Select, rank, and budget candidate memory for one turn. PURE. Filters to
 * `confirmed` only, ranks by precedence, then greedily fills up to `tokenBudget`
 * — every candidate that would push the total over the cap is dropped and
 * counted. `tokensUsed` is the summed cost of the included item lines and is
 * ALWAYS ≤ tokenBudget.
 */
export function selectMemoryForInjection(
  candidates: readonly MemoryItem[],
  tokenBudget: number,
): InjectedMemory {
  const budget = Math.max(0, Math.floor(tokenBudget));
  // Only confirmed memory injects (contract §5).
  const confirmed = candidates.filter((c) => c.status === 'confirmed');
  const ranked = rankCandidates(confirmed);

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
 * Returns the ranked, budgeted, confirmed-only injection set.
 */
export function retrieveForInjection(
  store: Store,
  query: MemoryInjectionQuery,
  opts?: { userId?: string; orgId?: string },
): InjectedMemory {
  return selectMemoryForInjection(
    gatherCandidates(store, query, opts),
    query.tokenBudget,
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
