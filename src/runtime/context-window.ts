// src/runtime/context-window.ts
//
// HOW BIG IS THE WINDOW THIS TURN IS FILLING — the DENOMINATOR of the status
// bar's usage gauge (specs/session-context-management.md §2.1) and of the
// AI-SDK engine's rolling compaction threshold (§2.3).
//
// THE ONE RULE: AN UNKNOWN MODEL ANSWERS `undefined`, NEVER A GUESS. The
// numerator (the last step's reported input tokens) is a MEASUREMENT; dividing a
// measurement by an invented denominator produces a percentage that looks exactly
// as authoritative as a correct one. The gauge therefore hides the ratio and shows
// the token count alone when this returns undefined, and the compaction path falls
// back to a conservative default that is documented at its own call site.
//
// It is a pure lookup with no I/O: the shell imports it to label a status bar and
// the engine imports it to size a payload, and neither can be made to wait.

/** Which backend answers the turn (see runtime/select.ts `EngineId`). */
export type ContextWindowEngine = 'dev-claude' | 'ai-sdk' | (string & {});

/**
 * Every current Claude generation ships a 200k window, and the Agent SDK's model
 * ARGUMENT is usually an alias (`opus` / `sonnet` / `haiku` / `fable`) that
 * resolves to whatever the local sign-in grants — so the alias cannot be mapped
 * to a size, but every model it can resolve to has this one.
 *
 * (Anthropic's 1M-token beta exists for some Sonnet/Opus tiers behind an opt-in
 * header we do not send, so reporting 1M here would overstate the window for
 * every turn this app actually makes.)
 */
export const CLAUDE_CONTEXT_WINDOW = 200_000;

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

/**
 * The window `model` runs in on `engine`, or undefined when we do not know.
 *
 * `engine` matters for exactly one case: the Claude Agent SDK answers with the
 * sign-in's own default when no model was requested, so an EMPTY model on that
 * engine still has a known window. On any other engine an empty model is a
 * genuine unknown — the provider's default could be anything.
 */
export function contextWindowFor(
  engine: ContextWindowEngine | undefined,
  model: string | undefined,
): number | undefined {
  const id = (model ?? '').trim().toLowerCase();
  if (!id) {
    return engine === 'dev-claude' ? CLAUDE_CONTEXT_WINDOW : undefined;
  }
  for (const rule of RULES) {
    if (rule.test(id)) return rule.window;
  }
  // An unknown model. The caller shows tokens without a ratio (gauge) or falls
  // back to FALLBACK_CONTEXT_WINDOW (compaction) — never a guess presented as fact.
  return undefined;
}
