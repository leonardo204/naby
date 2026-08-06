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
 * NOT a default. Anthropic's long-context tier is a BETA that has to be active
 * for the turn, so this size is only reported when the run itself said so — see
 * the two signals below. Reporting it unconditionally would understate fullness
 * on every ordinary 200k turn, which is the mirror image of the bug this file
 * exists to prevent.
 *
 * 1,000,000 rather than 1,048,576: the beta is documented and named in whole
 * millions (`context-1m-…`), and the Gemini-style power-of-two figure would be a
 * guess dressed as precision.
 */
export const CLAUDE_1M_CONTEXT_WINDOW = 1_000_000;

/**
 * The Agent SDK's own name for the long-context beta, as it appears in the
 * `betas` array of the `system`/`init` message (`SdkBeta` in the installed
 * `@anthropic-ai/claude-agent-sdk` types is exactly this one string).
 *
 * THIS IS SIGNAL ONE for a 1M run: the init message reports what the CLI
 * actually negotiated, not what we asked for, so a sign-in whose plan turns the
 * beta on is visible here even though this app sends no beta header itself.
 */
export const CONTEXT_1M_BETA = 'context-1m-2025-08-07';

/**
 * SIGNAL TWO: the concrete model id carries the tier in brackets.
 *
 * Observed from a live Claude subscription run: the model reported by the SDK is
 * `claude-opus-5[1m]` — the same id with the long-context tier appended. The
 * bracket form is what a real run produces; the `-1m` / `_1m` forms are accepted
 * too so a differently-punctuated variant of the same marker is not read as an
 * ordinary 200k model.
 *
 * The marker must stand alone (bounded by a non-alphanumeric on each side) so a
 * version fragment that merely contains the two characters cannot trip it.
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
 * defaults (`claude-sonnet-4-5`, `anthropic.claude-…-v1:0`, `gemini-2.5-pro`,
 * `gpt-4o`), the client model catalog's ChatGPT slugs (`gpt-5.6-sol`, …) and the
 * Claude aliases. Sizes are the providers' published INPUT windows.
 */
const RULES: ReadonlyArray<{ test: (id: string) => boolean; window: number }> = [
  // Anthropic, direct or through Bedrock (`anthropic.claude-…`) — 200k.
  { test: (id) => id.includes('claude'), window: CLAUDE_CONTEXT_WINDOW },
  // The Agent SDK aliases, which name no generation at all.
  { test: (id) => id === 'opus' || id === 'sonnet' || id === 'haiku' || id === 'fable', window: CLAUDE_CONTEXT_WINDOW },
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

/** Whether an id names the Claude family — the only family with two window
 *  tiers, so the only one that has to be recognised before the 1M check. */
function isClaudeId(id: string): boolean {
  return (
    id.includes('claude') ||
    id === 'opus' ||
    id === 'sonnet' ||
    id === 'haiku' ||
    id === 'fable'
  );
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
 * message). It is the difference between a 200k Claude turn and a 1M one, and
 * neither can be inferred from the configured model string — which is why the
 * engines now carry the concrete id and the beta list out on the result event
 * instead of leaving this to the engine-level selection.
 */
export function contextWindowFor(
  engine: ContextWindowEngine | undefined,
  model: string | undefined,
  opts?: { betas?: readonly string[] },
): number | undefined {
  const id = (model ?? '').trim().toLowerCase();
  const oneMBeta = opts?.betas?.includes(CONTEXT_1M_BETA) === true;
  if (!id) {
    if (engine !== 'dev-claude') return undefined;
    // The sign-in's own default, on whichever tier the run negotiated.
    return oneMBeta ? CLAUDE_1M_CONTEXT_WINDOW : CLAUDE_CONTEXT_WINDOW;
  }
  // The long-context tier, checked BEFORE the ordinary rules: `claude-opus-5[1m]`
  // matches the plain `claude` rule too, and first-match-wins would answer 200k
  // for a run that has five times that.
  if (isClaudeId(id) && (oneMBeta || ONE_M_MARKER.test(id))) {
    return CLAUDE_1M_CONTEXT_WINDOW;
  }
  for (const rule of RULES) {
    if (rule.test(id)) return rule.window;
  }
  // An unknown model. The caller shows tokens without a ratio (gauge) or falls
  // back to FALLBACK_CONTEXT_WINDOW (compaction) — never a guess presented as fact.
  return undefined;
}
