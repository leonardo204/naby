// src/runtime/policy.ts
//
// Phase 2 (M1) — the REAL tool-execution decision policy, replacing the Phase-1
// floor's role as the sole gatekeeper. It resolves the user's persistent policy
// rules (PolicyRule, stored per scope) against the tool a turn is about to run,
// and falls back to a caller-supplied BASELINE when no rule matches — so with no
// rules configured the behaviour is byte-for-byte the pre-M1 behaviour (the
// shell's `allowChanges ? allow-all : phase1HarnessFloor`). Additive by design.
//
// M1 is rules-only: an 'allow'/'deny' rule decides outright; an 'ask' rule needs
// the Phase-2 M2 approval bridge (`requestApproval`) and, absent it, defers to
// the baseline rather than inventing a decision. The gate is already async
// (engine.ts), so the M2 bridge drops in here with no signature change.

import type { GateDecision, ToolCall } from './engine.js';
import type { DecisionPolicy } from './gate.js';
import type { HarnessScope, PolicyEffect, PolicyRule } from './store/store.js';

/** The tool name a rule matches against. The gate sees bare names (engine.ts);
 *  kept as a seam so a future change to how MCP names are presented has ONE place
 *  to normalize. Identity today. */
export function normalizeToolName(name: string): string {
  return name;
}

/** Does `pattern` match tool `name`? `*` matches everything; a trailing `*`
 *  matches by prefix (`mcp__jira__*`); otherwise an exact match. */
export function matchToolPattern(pattern: string, name: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
}

/** Higher = more specific: an exact name beats a prefix wildcard beats `*`. */
function specificity(pattern: string): number {
  if (pattern === '*') return 0;
  if (pattern.endsWith('*')) return 1;
  return 2;
}

/** Scope precedence: the project a turn runs in is most specific, org least. */
const SCOPE_RANK: Record<HarnessScope, number> = { project: 0, user: 1, org: 2 };

/**
 * The winning effect for `name` among `rules`, or undefined if none match.
 * PURE. Precedence: more-specific SCOPE first (project > user > org), then the
 * more-specific PATTERN (exact > prefix > all). Deterministic so it is testable
 * and the UI can explain why a tool was allowed/denied.
 */
export function resolvePolicyEffect(
  rules: readonly PolicyRule[],
  name: string,
): PolicyEffect | undefined {
  const matches = rules.filter((r) => matchToolPattern(r.toolPattern, normalizeToolName(name)));
  if (matches.length === 0) return undefined;
  matches.sort(
    (a, b) =>
      SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] ||
      specificity(b.toolPattern) - specificity(a.toolPattern),
  );
  const [winner] = matches;
  return winner?.effect;
}

/**
 * Build the M1 decision policy. Rule match wins; otherwise the baseline runs.
 *
 * @param rules       every applicable rule across scopes for this turn (the
 *                    caller gathers project + user + org). Precedence is resolved
 *                    here, so the caller need not pre-order them.
 * @param fallback    the baseline policy for tools no rule covers — today the
 *                    shell passes `allowChanges ? allow-all : phase1HarnessFloor`,
 *                    keeping M1 non-breaking.
 * @param requestApproval  M2 approval bridge; when present an 'ask' rule (and,
 *                    later, an uncovered dangerous tool) suspends the turn for a
 *                    human decision. Absent in M1 → 'ask' falls through to the
 *                    baseline.
 */
/**
 * THE ONE SHAPE OF CALL THAT IS REFUSED BEFORE ANY RULE IS CONSULTED.
 *
 * There are two ways to put a shell command in the background and only one of
 * them can ever report back. `naby_start_job` spawns the child in naby's own
 * registry: naby holds the handle, hears it exit and starts the turn that tells
 * the user. The engine's built-in `Bash` with `run_in_background` hands the
 * child to the SDK, whose lifecycle events STOP THE MOMENT THE TURN ENDS — so
 * the job keeps running, nothing ever reports it, and the transcript's own block
 * flips to "outcome not recorded" while the work is still going.
 *
 * Leaving both available made the outcome a coin flip decided by which tool the
 * model happened to reach for, which is precisely the bug `job-tools.ts` warned
 * about when it refused to offer two starters of its own.
 *
 * WHY HERE AND NOT `disallowedTools`. That list is by tool NAME, and denying
 * `Bash` would take foreground commands with it. The distinction lives in the
 * INPUT, so the gate is the only place that can see it.
 *
 * WHY ABOVE THE RULES. A user allow-rule for `Bash` is about running commands,
 * not about adopting a reporting path that cannot report. This is a capability
 * fact rather than a permission, so no rule may grant it.
 *
 * The refusal NAMES THE REPLACEMENT. A bare denial gets retried and then
 * abandoned; a denial that says which tool to use instead is followed.
 */
export function backgroundBashRefusal(call: ToolCall): GateDecision | undefined {
  if (normalizeToolName(call.toolName) !== 'Bash') return undefined;
  const input = call.input;
  if (typeof input !== 'object' || input === null) return undefined;
  if ((input as { run_in_background?: unknown }).run_in_background !== true) return undefined;
  return {
    behavior: 'deny',
    reason:
      'Backgrounding through Bash is not available: its progress and completion events stop when ' +
      'this turn ends, so the job would run on with nobody able to report it. Start it with ' +
      'naby_start_job instead — that one gives you a new turn when the work finishes, and ' +
      'naby_check_job / naby_read_job_output let you look in on it meanwhile.',
  };
}

export function realPolicy(deps: {
  rules: readonly PolicyRule[];
  fallback: DecisionPolicy;
  requestApproval?: (call: ToolCall) => Promise<GateDecision>;
}): DecisionPolicy {
  return async (call: ToolCall): Promise<GateDecision> => {
    // Above the rules on purpose — see `backgroundBashRefusal`.
    const refused = backgroundBashRefusal(call);
    if (refused) return refused;
    const name = normalizeToolName(call.toolName);
    const effect = resolvePolicyEffect(deps.rules, name);
    if (effect === 'allow') return { behavior: 'allow' };
    if (effect === 'deny') {
      return { behavior: 'deny', reason: `blocked by your policy rule for '${name}'` };
    }
    if (effect === 'ask' && deps.requestApproval) {
      return deps.requestApproval(call);
    }
    // No rule (or 'ask' with no approval bridge yet) → the turn's baseline.
    return deps.fallback(call);
  };
}
