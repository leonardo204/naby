// src/runtime/context-window.ts
//
// HOW BIG IS THE WINDOW THIS TURN IS FILLING — the DENOMINATOR of the status
// bar's usage gauge (specs/session-context-management.md §2.1) and of the
// AI-SDK engine's rolling compaction threshold (§2.3).
//
// THE ONE RULE HERE: AN UNKNOWN MODEL ANSWERS `undefined`, NEVER A GUESS. This
// file reports only sizes a provider published for an id it recognises, so a
// caller can always tell a fact from an estimate.
//
// WHAT THE CALLERS DO WITH `undefined` CHANGED (spec §2.1, v0.3.0). The gauge used
// to hide its ratio and show a bare token count; a bare `293k` turned out to mean
// nothing to the person reading it, so the gauge now falls back to a family
// default and MARKS the percentage approximate (`~29%`) — the estimate is still
// distinguishable from a fact, which is what the original rule was protecting.
// That fallback lives in the shell's contextGauge.ts, next to the rendering it
// qualifies; the compaction path has its own documented default below. Neither
// makes this function guess.
//
// THIS IS NOW THE FALLBACK ON THE AGENT SDK PATH, NOT THE FIRST ANSWER. That
// backend reports the window it actually ran on (`modelUsage[model].contextWindow`
// on its result message), and a reported size outranks anything inferred here —
// see the `contextWindow` contract in runtime/engine.ts. The reason is the 1M
// tier going GA: it stopped announcing itself through the served id and the beta
// alike, and this file went on answering 200k for a 1,000,000-token run.
//
// SO THE INFERENCE GREW A THIRD SIGNAL: the id we REQUESTED (`opus[1m]`), read
// only when the run served the same model (`requestedOneMTier`). It matters
// because the measurement is not always there — a result that bills two models
// (an ordinary turn now that subagents route to a cheap model) can name no single
// window — and without it the requested tier was being thrown away on exactly
// those turns. Everything else is unchanged: this file still answers every
// backend that reports no window of its own (all of the AI-SDK ones) and every
// Agent SDK turn that ends before a result.
//
// It is a pure lookup with no I/O: the shell imports it to label a status bar and
// the engine imports it to size a payload, and neither can be made to wait.

/** Which backend answers the turn (see runtime/select.ts `EngineId`). */
export type ContextWindowEngine = 'dev-claude' | 'ai-sdk' | (string & {});

/**
 * Every current Claude generation ships a 200k window by default, and the Agent
 * SDK's model ARGUMENT is usually an alias (`opus` / `sonnet` / `haiku` /
 * `fable`) that resolves to whatever the local sign-in grants — so the alias
 * cannot be mapped to a size, but every model it can resolve to has at least
 * this one.
 */
export const CLAUDE_CONTEXT_WINDOW = 200_000;

/**
 * The 1M-context Claude window, when the run is actually on it.
 *
 * NOT a default. Reporting it unconditionally would understate fullness on every
 * ordinary 200k turn, which is the mirror image of the bug this file exists to
 * prevent — so it is answered only for a run that can be SHOWN to be on the tier.
 *
 * THE TIER IS GA, AND IT ANNOUNCES ITSELF THROUGH NEITHER OF THE TWO ORIGINAL
 * SIGNALS. Verified twice against a live @anthropic-ai/claude-agent-sdk run
 * requesting `claude-opus-5[1m]`: the result carried NO `betas` array at all, and
 * every assistant step reported the served id as `claude-opus-5` — the marker
 * stripped. Across every local Claude transcript the served id never carries
 * `[1m]` (24747 × `claude-opus-5`, 0 × any `[1m]` form). What survives is the id
 * we REQUESTED, which keeps the marker (`modelUsage` is keyed by it), so that is
 * now the live signal and the two below are legacy.
 *
 * 1,000,000 rather than 1,048,576: Anthropic names the tier in whole millions
 * (`context-1m-…`), and the Gemini-style power-of-two figure would be a guess
 * dressed as precision.
 */
export const CLAUDE_1M_CONTEXT_WINDOW = 1_000_000;

/**
 * The Agent SDK's own name for the long-context beta, as it appears in the
 * `betas` array of the `system`/`init` message (`SdkBeta` in the installed
 * `@anthropic-ai/claude-agent-sdk` types is exactly this one string).
 *
 * LEGACY SIGNAL, KEPT FOR OLDER RUNS. It was signal one while the tier was a
 * beta: the init message reported what the CLI had negotiated, so a plan that
 * turned the beta on was visible here even though this app sends no beta header.
 * The tier is GA now and a live run sends no `betas` array whatsoever, so this
 * answers only for a CLI old enough to still negotiate it. The live signal is
 * `requestedOneMTier` below.
 */
export const CONTEXT_1M_BETA = 'context-1m-2025-08-07';

/**
 * The long-context tier written into a model id: `claude-opus-5[1m]`.
 *
 * TWO USES, AND ONLY ONE OF THEM IS STILL LIVE.
 *
 *   LEGACY — the id the run SERVED. This was signal two, and the observed fact is
 *   now the opposite: the SDK strips the marker from the served id (every
 *   assistant step reports `claude-opus-5` for a 1M run), and no local transcript
 *   has ever carried it. The check stays because a served id that DOES name the
 *   tier still means the tier, and nothing is gained by refusing to read it.
 *
 *   LIVE — the id we REQUESTED, which keeps the marker (`requestedOneMTier`).
 *
 * The bracket form is what the catalog and the SDK write; the `-1m` / `_1m` forms
 * are accepted too so a differently-punctuated variant of the same marker is not
 * read as an ordinary 200k model. The marker must stand alone (bounded by a
 * non-alphanumeric on each side) so a version fragment that merely contains the
 * two characters cannot trip it.
 */
const ONE_M_MARKER = /(^|[^a-z0-9])1m($|[^a-z0-9])/;

/**
 * The fallback the AI-SDK compaction uses when the model is unknown. NOT used by
 * the gauge — see the header: the gauge would rather show nothing than a ratio
 * against a number nobody verified. Compaction is different in kind: it has to
 * pick SOME budget or it cannot protect the turn at all, and 128k is the smallest
 * window any provider we support ships, so folding against it is early rather
 * than wrong.
 */
export const FALLBACK_CONTEXT_WINDOW = 128_000;

/**
 * Model id -> window size, as ordered prefix rules (first match wins).
 *
 * The ids are the ones this codebase actually produces: `describeProviders`
 * defaults (`claude-sonnet-4-5`, `anthropic.claude-…-v1:0`, `gemini-2.5-flash-lite`,
 * `gpt-4o`), the client model catalog's ChatGPT slugs (`gpt-5.6-sol`, …) and the
 * Claude aliases. Sizes are the providers' published INPUT windows.
 */
const RULES: ReadonlyArray<{ test: (id: string) => boolean; window: number }> = [
  // Fable (5 and 5.1) — 1M is the DEFAULT, not a negotiated tier: Anthropic
  // publishes the maximum as the default for this family, and a live run
  // served `claude-fable-5` on a 1,000,000-token window with no beta and no
  // `[1m]` marker (see engine.ts `contextWindowReported`). Checked BEFORE the
  // generic Claude rule, which would answer 200k.
  { test: (id) => id.includes('claude-fable'), window: CLAUDE_1M_CONTEXT_WINDOW },
  // Anthropic, direct or through Bedrock (`anthropic.claude-…`) — 200k.
  { test: (id) => id.includes('claude'), window: CLAUDE_CONTEXT_WINDOW },
  // The Agent SDK aliases, which name no generation at all.
  { test: (id) => isClaudeAlias(id), window: CLAUDE_CONTEXT_WINDOW },
  // Gemini 1.5/2.x — 1,048,576 input tokens.
  { test: (id) => id.startsWith('gemini'), window: 1_048_576 },
  // GPT-4.1 — 1,047,576 input tokens. Checked BEFORE the gpt-4o rule so
  // `gpt-4.1-mini` cannot fall through to the 128k branch.
  { test: (id) => id.startsWith('gpt-4.1'), window: 1_047_576 },
  // GPT-4o and 4o-mini — 128k.
  { test: (id) => id.startsWith('gpt-4o') || id.startsWith('gpt-4-turbo'), window: 128_000 },
  // GPT-5 family, including the ChatGPT/codex slugs (`gpt-5.6-sol`, `gpt-5.4-mini`).
  // 272k is the INPUT budget; the widely quoted 400k is the total, of which 128k
  // is reserved for output — and this gauge measures input occupancy.
  { test: (id) => id.startsWith('gpt-5'), window: 272_000 },
  // o-series reasoning models — 200k.
  { test: (id) => /^o[1-9](-|$)/.test(id), window: 200_000 },
];

/**
 * A tier marker appended to a model name, as the live catalog and the SDK write
 * it: `opus[1m]`, `claude-opus-5[1m]`, `claude-fable-5-1[1m]`.
 *
 * The catalog's own values are `default` · `opus[1m]` · `claude-fable-5-1[1m]` ·
 * `sonnet` · `haiku` (specs/model-auto-routing.md §3), so the bracketed form is
 * not hypothetical — it is the value this app passes to the SDK for the 1M tier.
 *
 * EXPORTED, because the Agent SDK engine needs THE SAME rule: it matches a
 * `modelUsage` key against a served id, and the two differ by exactly this suffix
 * (see `reportedContextWindow`). A second copy of the regex there would be a
 * second answer to one question, and the UI would end up believing the wrong one.
 * Anchored and unflagged, so `.test` / `.replace` are safe to share.
 */
export const TIER_SUFFIX = /\[[^\]]*\]$/;

/** The Agent SDK aliases, with or without a tier suffix. */
function isClaudeAlias(id: string): boolean {
  const bare = id.replace(TIER_SUFFIX, '');
  return bare === 'opus' || bare === 'sonnet' || bare === 'haiku' || bare === 'fable';
}

/**
 * "Does this concrete id name that alias" — one regex per alias, built once.
 *
 * The alias has to stand ALONE inside the id (`claude-opus-5` names `opus`,
 * `claude-sonnet-5` does not), which is what keeps a request for one tier from
 * being answered by whichever model the run happened to serve. Same bounding rule
 * as ONE_M_MARKER, for the same reason: a substring is not a name.
 */
const ALIAS_IN_ID: Readonly<Record<string, RegExp>> = {
  opus: /(^|[^a-z0-9])opus($|[^a-z0-9])/,
  sonnet: /(^|[^a-z0-9])sonnet($|[^a-z0-9])/,
  haiku: /(^|[^a-z0-9])haiku($|[^a-z0-9])/,
  fable: /(^|[^a-z0-9])fable($|[^a-z0-9])/,
};

/** Whether an id names the Claude family — the only family with two window
 *  tiers, so the only one that has to be recognised before the 1M check.
 *
 *  THE ALIAS COMPARISON IGNORES A TIER SUFFIX, and that is load-bearing rather
 *  than tidy: `opus[1m]` matched neither `includes('claude')` nor the exact
 *  alias, so it reached no rule at all and this function answered `undefined`
 *  for the one value the catalog uses to name a 1M window. The `[1m]` marker was
 *  already understood (ONE_M_MARKER above) — the id simply never got that far. */
function isClaudeId(id: string): boolean {
  return id.includes('claude') || isClaudeAlias(id);
}

/**
 * WHETHER THE TIER WE ASKED FOR IS THE TIER THIS RUN IS ON — the live 1M signal.
 *
 * `requested` is the id we SENT (`claude-opus-5[1m]` / `opus[1m]`, the catalog's
 * own values); `served` is the id the run reported back. A GA run keeps the
 * marker on the first and strips it from the second, so the request is the only
 * statement about the tier left standing.
 *
 * TRUE ONLY WHEN THE TWO NAME THE SAME MODEL. That is the whole safety of reading
 * a request as a fact:
 *   - `served` equals `requested` with its tier suffix stripped
 *     (`claude-opus-5[1m]` → `claude-opus-5`), or
 *   - `requested` is an ALIAS (`opus` / `sonnet` / `haiku` / `fable`) and the
 *     served Claude id names that alias as a standalone token
 *     (`opus[1m]` → `claude-opus-5`), or
 *   - `served` is empty, which names no other model at all — the caller gates
 *     that case on the Claude engine, where an empty id has a known default.
 *
 * DELIBERATELY NOT `max(servedWindow, requestedWindow)`. The CLI can swap the
 * model mid-turn — a refusal fallback drops `opus[1m]` to
 * `claude-haiku-4-5-20251001` — and that turn is on haiku's 200k window however
 * loudly we asked for a million. The same-model check is what makes the
 * difference, so it is exported and asserted on its own.
 */
export function requestedOneMTier(
  requested: string | undefined,
  served: string | undefined,
): boolean {
  const want = (requested ?? '').trim().toLowerCase();
  // No request, or a request that says nothing about the tier (`default`,
  // `opus`): there is nothing here to carry over.
  if (!want || !ONE_M_MARKER.test(want) || !isClaudeId(want)) return false;
  const base = want.replace(TIER_SUFFIX, '');
  const got = (served ?? '').trim().toLowerCase();
  // An empty served id names no competing model.
  if (!got) return true;
  if (got === base || got.replace(TIER_SUFFIX, '') === base) return true;
  // The alias case: `opus[1m]` was served as `claude-opus-5`. The alias must be a
  // standalone token so `claude-sonnet-5` cannot satisfy a request for opus by
  // accident, and the served id must name Claude — no other family has this tier.
  const alias = ALIAS_IN_ID[base];
  return alias !== undefined && isClaudeId(got) && alias.test(got);
}

/**
 * The window `model` runs in on `engine`, or undefined when we do not know.
 *
 * `engine` matters for exactly one case: the Claude Agent SDK answers with the
 * sign-in's own default when no model was requested, so an EMPTY model on that
 * engine still has a known window. On any other engine an empty model is a
 * genuine unknown — the provider's default could be anything.
 *
 * `opts.betas` is what the RUN reported about itself (the Agent SDK's init
 * message) — a legacy 1M signal, kept for a CLI old enough to negotiate the beta.
 *
 * `opts.requested` is the id we ASKED FOR, and it is the LIVE 1M signal: the tier
 * went GA, so a 1M run sends no beta and reports a served id with the marker
 * stripped, leaving the request as the only place the tier appears. It is read
 * only when it names the same model the run served (`requestedOneMTier`), so a
 * mid-turn model swap cannot inherit a tier it is not on.
 */
export function contextWindowFor(
  engine: ContextWindowEngine | undefined,
  model: string | undefined,
  opts?: { betas?: readonly string[]; requested?: string },
): number | undefined {
  const id = (model ?? '').trim().toLowerCase();
  const oneMBeta = opts?.betas?.includes(CONTEXT_1M_BETA) === true;
  const oneMRequested = requestedOneMTier(opts?.requested, id);
  if (!id) {
    if (engine !== 'dev-claude') return undefined;
    // The sign-in's own default, on whichever tier the run negotiated — or the
    // one we asked for, which is all a GA run tells us.
    return oneMBeta || oneMRequested ? CLAUDE_1M_CONTEXT_WINDOW : CLAUDE_CONTEXT_WINDOW;
  }
  // The long-context tier, checked BEFORE the ordinary rules: `claude-opus-5[1m]`
  // matches the plain `claude` rule too, and first-match-wins would answer 200k
  // for a run that has five times that. Gated on the served id naming Claude, so
  // a requested tier can never resize another family's model.
  if (isClaudeId(id) && (oneMBeta || ONE_M_MARKER.test(id) || oneMRequested)) {
    return CLAUDE_1M_CONTEXT_WINDOW;
  }
  for (const rule of RULES) {
    if (rule.test(id)) return rule.window;
  }
  // An unknown model. The caller shows tokens without a ratio (gauge) or falls
  // back to FALLBACK_CONTEXT_WINDOW (compaction) — never a guess presented as fact.
  return undefined;
}
