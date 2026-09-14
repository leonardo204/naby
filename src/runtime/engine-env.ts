// src/runtime/engine-env.ts
//
// WHAT THE SHELL ENVIRONMENT IS DOING TO THE ENGINE — the diagnostic list
// (specs/subagent-delegation.md §4.4).
//
// THE PROBLEM IT ANSWERS. naby does not read or write the variables that pick a
// model (§2 principle 1): it writes the model it wants into the subagent
// definition and lets the backend resolve. But the backend is a CLI child
// process, and when no account is selected it INHERITS naby's own environment
// (`buildQueryOptions`) — so a `CLAUDE_CODE_SUBAGENT_MODEL=opus` left in a shell
// profile silently changes what every delegation costs, and
// `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` overrides the definition outright. Not
// reading those variables is the right policy; leaving the user unable to SEE
// them is not. This turns them into something Settings can show.
//
// WHERE THE LIST COMES FROM, AND WHY IT EXPIRES. These names were taken from the
// STRINGS IN THE BUNDLED CLI BINARY — @anthropic-ai/claude-agent-sdk 0.3.259,
// whose manifest.json reports CLI **2.1.259** (build 2026-09-02). They are
// therefore a fact about one build, not a documented contract: the CLI has
// already changed how it resolves a subagent model once (the environment variable
// came FIRST before 2.1.251), and it can add or drop a variable in any release.
// SO, ON EVERY SDK BUMP: re-extract the strings from the new binary, reconcile
// them with this table, and re-run `npm run spike:subagent-model` against a real
// sign-in (§4.5, steps 2 and 3). A stale list here is worse than a short one — it
// reports a variable that no longer does anything as if it did.
//
// SETTINGS FILES ARE NOT IN SCOPE. naby runs the SDK with `settingSources: []`,
// so an `env` block in `~/.claude/settings.json` never reaches the child
// (harness-standalone §2.3). What this function reads is the PROCESS environment
// and nothing else — which is exactly what does reach it.
//
// PURE, AND IT NEVER RETURNS A SECRET. The two credential variables are reported
// as present and nothing more: this list is rendered in the UI, and a token
// printed on a settings screen is a token in every screenshot of it.

/** One environment variable that is set, and what it does to a turn. */
export type EngineEnvNote = {
  /** The variable name, exactly as it is spelled in the environment. */
  name: string;
  /** What to SHOW. The value for the ones that name a model or a level; the
   *  literal `'set'` for the two that are credentials. */
  value: string;
  /** One sentence, in plain English, about what having it changes. */
  effect: string;
};

/** The table, in the order §3 of the spec lists it: the two that decide a
 *  SUBAGENT's model first (they are the reason this list exists), then the ones
 *  that decide the main model, then effort and thinking, then the two
 *  credentials, then the two that move the whole run to another cloud. */
const ENTRIES: readonly { name: string; effect: string; secret?: true }[] = [
  {
    name: 'CLAUDE_CODE_SUBAGENT_MODEL',
    effect: 'Sets the default model for subagents, so a subagent that names none runs on this.',
  },
  {
    name: 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE',
    effect: 'Forces every subagent onto the default subagent model, overriding the model naby wrote.',
  },
  { name: 'ANTHROPIC_MODEL', effect: 'Overrides the model the main conversation runs on.' },
  {
    name: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
    effect: 'Remaps the "fable" alias to this model id.',
  },
  {
    name: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    effect: 'Remaps the "haiku" alias to this model id — which is the alias the explorer subagent asks for.',
  },
  {
    name: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    effect: 'Remaps the "opus" alias to this model id.',
  },
  {
    name: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    effect: 'Remaps the "sonnet" alias to this model id — which is the alias the implementer subagent asks for.',
  },
  {
    name: 'CLAUDE_CODE_EFFORT_LEVEL',
    effect: 'Sets how much effort the model spends per answer, which changes both latency and cost.',
  },
  {
    name: 'MAX_THINKING_TOKENS',
    effect: 'Caps how many tokens the model may spend on reasoning before it answers.',
  },
  {
    name: 'CLAUDE_CODE_OAUTH_TOKEN',
    effect: 'Signs the engine in with this token instead of the account picked in naby.',
    secret: true,
  },
  {
    name: 'ANTHROPIC_API_KEY',
    effect: 'May bill to an API key instead of the subscription sign-in.',
    secret: true,
  },
  {
    name: 'CLAUDE_CODE_USE_BEDROCK',
    effect: 'Routes the run through Amazon Bedrock instead of the Anthropic API.',
  },
  {
    name: 'CLAUDE_CODE_USE_VERTEX',
    effect: 'Routes the run through Google Vertex AI instead of the Anthropic API.',
  },
];

/**
 * The notes for the variables that are ACTUALLY SET in this environment.
 *
 * Only set, non-blank variables are returned, and the caller draws nothing when
 * the list is empty: a settings screen that lists thirteen variables as "not set"
 * teaches the reader to ignore the section, and the one case that matters is a
 * single unexpected line in an otherwise empty list.
 *
 * Takes the environment as an argument (defaulting to `process.env`) so a spike
 * can state the environment it is asserting about, the way the rest of this
 * codebase's environment readers do (`claudeCredentialsPath`, `checkClaudeLogin`).
 */
export function engineEnvironmentNotes(env: NodeJS.ProcessEnv = process.env): EngineEnvNote[] {
  const out: EngineEnvNote[] = [];
  for (const entry of ENTRIES) {
    const raw = env[entry.name];
    // Blank counts as absent — an exported-but-empty variable is what a shell
    // leaves behind after `unset` in some setups, and it changes nothing.
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    out.push({
      name: entry.name,
      // A credential is reported as PRESENT and never quoted: see the header.
      value: entry.secret ? 'set' : raw.trim(),
      effect: entry.effect,
    });
  }
  return out;
}
