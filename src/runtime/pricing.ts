// src/runtime/pricing.ts
//
// F1-07 — turning token counts into a dollar figure.
//
// WHY THIS FILE EXISTS AT ALL: the AI SDK reports `usage` (token counts) and
// nothing else. It has no price catalogue, and neither does any provider SDK we
// use — a price list is a business fact, not an API fact. So if we want to show
// cost, we have to carry the numbers ourselves.
//
// THE THREE RULES THIS TABLE IS BUILT AROUND
//
//   1. TOKENS ARE ALWAYS TRUTH; PRICE IS ALWAYS A LOOKUP. Token counts come
//      from the provider. Prices come from this hand-maintained file and go
//      stale the moment a provider changes its rate card. So an unknown or
//      stale model yields NO dollar figure — never a guessed one. A wrong
//      number is worse than an absent one, because a user cannot tell it is
//      wrong. `priceModel()` returning null is a normal, expected outcome.
//
//   2. EVERY ROW IS SOURCED AND DATED. `PRICES_AS_OF` and each entry's `source`
//      exist so that "is this still right?" is answerable by a human without
//      reverse-engineering where a number came from.
//
//   3. IT IS MEANT TO BE EDITED. One flat array, one row per model family,
//      matched by PREFIX so `claude-sonnet-4-5-20250929` picks up the
//      `claude-sonnet-4-5` row without a new entry per snapshot date.
//
// UNITS: every rate is US dollars per ONE MILLION tokens, which is how all five
// providers publish. Converting at the edge (rather than storing per-token
// floats) keeps the table readable against the published page.

import type { Usage } from './engine.js';

/**
 * When these rates were last checked against the providers' public pricing
 * pages. Bump this in the same commit as any rate change.
 *
 * NOTE FOR WHOEVER MAINTAINS THIS: these are LIST prices for the standard
 * (non-batch, non-priority) tier. Negotiated, committed-use and batch rates all
 * differ, so a figure shown from this table is "list price for the tokens we
 * observed", which is what the UI says it is.
 */
export const PRICES_AS_OF = '2026-07';

export type ModelPrice = {
  /** Which provider kind this row applies to (`ProviderKind`, as a string so
   *  this module stays free of the provider registry). */
  providerKind: string;
  /** Matched as a PREFIX against the model id, longest match wins. */
  modelPrefix: string;
  /** USD per 1M input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
  /**
   * USD per 1M tokens read from the prompt cache. Cheaper than fresh input on
   * every provider that offers it. Omitted means "billed as normal input",
   * which is the conservative reading — it can only overstate, never understate.
   */
  cachedInputPerMTok?: number;
  /** Where the numbers came from, so they can be rechecked. */
  source: string;
};

/**
 * The table. Keyed by provider + model prefix.
 *
 * Bedrock rows repeat the Anthropic rates because Bedrock bills the same model
 * under a different model id — the duplication is deliberate: an implicit
 * "bedrock falls back to anthropic" rule would silently price a Bedrock-only
 * model (Titan, Nova) at Claude rates.
 */
export const MODEL_PRICES: readonly ModelPrice[] = [
  // -- Anthropic direct ----------------------------------------------------
  {
    providerKind: 'anthropic',
    modelPrefix: 'claude-opus-4',
    inputPerMTok: 15,
    outputPerMTok: 75,
    cachedInputPerMTok: 1.5,
    source: 'anthropic.com/pricing (API, standard tier)',
  },
  {
    providerKind: 'anthropic',
    modelPrefix: 'claude-sonnet-4',
    inputPerMTok: 3,
    outputPerMTok: 15,
    cachedInputPerMTok: 0.3,
    source: 'anthropic.com/pricing (API, standard tier)',
  },
  {
    providerKind: 'anthropic',
    modelPrefix: 'claude-haiku-4',
    inputPerMTok: 1,
    outputPerMTok: 5,
    cachedInputPerMTok: 0.1,
    source: 'anthropic.com/pricing (API, standard tier)',
  },
  {
    providerKind: 'anthropic',
    modelPrefix: 'claude-3-5-haiku',
    inputPerMTok: 0.8,
    outputPerMTok: 4,
    cachedInputPerMTok: 0.08,
    source: 'anthropic.com/pricing (API, standard tier)',
  },

  // -- Amazon Bedrock (Claude on Bedrock) ----------------------------------
  {
    providerKind: 'bedrock',
    modelPrefix: 'anthropic.claude-opus-4',
    inputPerMTok: 15,
    outputPerMTok: 75,
    cachedInputPerMTok: 1.5,
    source: 'aws.amazon.com/bedrock/pricing (on-demand)',
  },
  {
    providerKind: 'bedrock',
    modelPrefix: 'anthropic.claude-sonnet-4',
    inputPerMTok: 3,
    outputPerMTok: 15,
    cachedInputPerMTok: 0.3,
    source: 'aws.amazon.com/bedrock/pricing (on-demand)',
  },

  // -- OpenAI --------------------------------------------------------------
  {
    providerKind: 'openai',
    modelPrefix: 'gpt-5',
    inputPerMTok: 1.25,
    outputPerMTok: 10,
    cachedInputPerMTok: 0.125,
    source: 'openai.com/api/pricing (standard tier)',
  },
  {
    providerKind: 'openai',
    modelPrefix: 'gpt-4.1-mini',
    inputPerMTok: 0.4,
    outputPerMTok: 1.6,
    cachedInputPerMTok: 0.1,
    source: 'openai.com/api/pricing (standard tier)',
  },
  {
    providerKind: 'openai',
    modelPrefix: 'gpt-4.1',
    inputPerMTok: 2,
    outputPerMTok: 8,
    cachedInputPerMTok: 0.5,
    source: 'openai.com/api/pricing (standard tier)',
  },
  {
    providerKind: 'openai',
    modelPrefix: 'gpt-4o-mini',
    inputPerMTok: 0.15,
    outputPerMTok: 0.6,
    cachedInputPerMTok: 0.075,
    source: 'openai.com/api/pricing (standard tier)',
  },
  {
    providerKind: 'openai',
    modelPrefix: 'gpt-4o',
    inputPerMTok: 2.5,
    outputPerMTok: 10,
    cachedInputPerMTok: 1.25,
    source: 'openai.com/api/pricing (standard tier)',
  },

  // -- Google Gemini -------------------------------------------------------
  {
    providerKind: 'google',
    modelPrefix: 'gemini-2.5-pro',
    inputPerMTok: 1.25,
    outputPerMTok: 10,
    cachedInputPerMTok: 0.31,
    source: 'ai.google.dev/pricing (paid tier, prompts <= 200k tokens)',
  },
  {
    providerKind: 'google',
    modelPrefix: 'gemini-2.5-flash',
    inputPerMTok: 0.3,
    outputPerMTok: 2.5,
    cachedInputPerMTok: 0.075,
    source: 'ai.google.dev/pricing (paid tier)',
  },

  // -- Azure OpenAI --------------------------------------------------------
  // Azure's model id IS the deployment name (contract §4), which is chosen by
  // the user and tells us nothing about the underlying model. So there is
  // deliberately NO Azure row: we cannot know what a deployment named
  // "my-deployment" costs, and guessing from a name is exactly the invented
  // number rule 1 forbids. Azure sessions show tokens, and say why.
];

/** The longest-prefix match for a provider+model, or null when unpriced. */
export function priceModel(providerKind: string, model: string): ModelPrice | null {
  let best: ModelPrice | null = null;
  for (const entry of MODEL_PRICES) {
    if (entry.providerKind !== providerKind) continue;
    if (!model.startsWith(entry.modelPrefix)) continue;
    if (!best || entry.modelPrefix.length > best.modelPrefix.length) best = entry;
  }
  return best;
}

/**
 * Cost of one turn's usage, or null when we have no price for that model.
 *
 * Cached input is billed at its own (lower) rate when the row declares one, and
 * subtracted from the fresh-input count so a cached token is never billed
 * twice. The subtraction is correct because `cachedInputTokens` is defined as a
 * SUBSET of `inputTokens` (see the `Usage` contract in runtime/engine.ts, which
 * each engine normalizes into); it is still clamped at zero so an engine that
 * ever violated that would produce a too-high estimate rather than a negative
 * one.
 *
 * KNOWN APPROXIMATION, stated rather than hidden: cache WRITES are billed above
 * the normal input rate by most providers (Anthropic charges 1.25x), but the
 * normalized `Usage` folds them into `inputTokens` without distinguishing them,
 * so they are priced at the plain input rate. The result is a slight UNDER-
 * estimate on turns that populate a large cache. Splitting them out means
 * widening `Usage` with a fourth count and a matching rate column here — worth
 * doing when a real metered provider is wired up (SPIKE-05), not before.
 */
export function costOfUsage(price: ModelPrice, usage: Usage): number {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cached = usage.cachedInputTokens ?? 0;
  const cachedRate = price.cachedInputPerMTok ?? price.inputPerMTok;
  const freshInput = Math.max(0, input - cached);
  return (
    (freshInput * price.inputPerMTok +
      cached * cachedRate +
      output * price.outputPerMTok) /
    1_000_000
  );
}
