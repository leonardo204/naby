// src/runtime/delegation-policy.ts
//
// WHEN TO HAND WORK TO A SUBAGENT — one sentence-set, stated once, used by every
// engine (specs/subagent-delegation.md §4.2).
//
// WHY THE POLICY EXISTS AT ALL, AND WHY IT IS WORDED THE WAY IT IS. Delegation
// does not make the expensive model cheaper: the main thread still receives the
// whole transcript and still decides. What it saves is the TRANSCRIPT ITSELF —
// a subagent opens the files in its own window and only its conclusion comes
// back, so the tool output never becomes part of what every later turn re-sends.
// That is why the rule is "delegate the reading and the searching", NOT "delegate
// the easy things". A policy phrased as "delegate simple work" would send short
// questions away (saving nothing, and costing a round trip) while keeping the
// forty-file investigation right here in the record.
//
// TWO CALL SITES, ONE STRING:
//   * dev-claude has no tool schema to hang it on — the Agent SDK learns about
//     subagents through its own `agents` map — so the shell appends this block to
//     the turn's system prompt (M2).
//   * every other engine reaches subagents through `naby_delegate`, whose
//     description is where a model actually looks; `delegateSchema` appends it
//     there.
//
// CONDITIONAL ON THE ROSTER. `delegationPolicyFor` returns nothing unless at
// least one of the two built-ins is actually available this turn, and names only
// the ones that are. A policy that points at a subagent the model cannot call is
// worse than no policy: it invites a delegation that fails, and it describes a
// capability the turn does not have. The user may disable either row, so the
// roster is a per-turn fact, not a build-time one.
//
// AND CONDITIONAL ON THE TURN'S MUTATION ALLOWANCE. `implementer` is mentioned
// only when the turn actually permits changes. When "allow changes" is off or the
// session is in plan mode, the editing and command tools are absent and every
// attempt is refused at the gate (§2 principle 5: delegation is not a way around
// the policy) — so telling the model to send code changes to a subagent would be
// telling it to spend a round trip on a refusal. The explorer half is unaffected:
// reading and searching are exactly what a read-only turn is for.

/** Whether the turn permits changes — "allow changes" is on AND the session is
 *  not in plan mode. The same pair the shell already folds into
 *  `allowMutations` when it builds the workspace toolset. */
export type DelegationPolicyOptions = {
  canMutate: boolean;
};
//
// ADVISORY, NOT ENFORCED. Nothing checks that the model obeyed; a turn that does
// all the reading itself is a worse-value turn, not a failed one.
//
// PURE. No store, no environment, no I/O — a spike calls it with three fake
// rosters and reads the strings back.

/** The name of the built-in read-and-search subagent (`core` bundle). */
export const EXPLORER_SUBAGENT = 'explorer';

/** The name of the built-in code-change subagent (`core` bundle). */
export const IMPLEMENTER_SUBAGENT = 'implementer';

/** The sentence that says WHY, and is true of every shape of the policy. */
const POLICY_OPENING = 'Delegation policy: hand work to a subagent to keep this conversation small.';

/** The `explorer` half — the one that actually saves transcript. */
const EXPLORER_CLAUSE = `Any job that means reading or searching across several files, or that will produce long tool output — finding every use of a symbol, tracing a value through modules, surveying an unfamiliar directory, scanning logs or documents — goes to "${EXPLORER_SUBAGENT}", and you then work from its summary instead of reading everything yourself.`;

/** The `implementer` half. Only ever used on a turn that permits changes. */
const IMPLEMENTER_CLAUSE = `A code change that is already fully specified and self-contained — the paths, the constraints and what "done" means are all decided — goes to "${IMPLEMENTER_SUBAGENT}".`;

/** What is true of any delegation: keep the cheap work, and state the task in
 *  full because the other side is blind to this conversation. */
const POLICY_CLOSING =
  'Reading one or two known files, and answering a short question, you do yourself: delegating those costs a round trip and saves nothing. ' +
  'A subagent CANNOT see this conversation, so state the task in full — the file paths, the constraints, and the done-criteria.';

/**
 * The policy, in full — the wording used when BOTH built-ins are available and
 * the turn permits changes.
 *
 * English because it is a prompt, and every prompt in this codebase is English.
 * It is one paragraph on purpose: it is appended to a tool description and to a
 * system prompt, and both are places where a short instruction is read and a long
 * one is skimmed.
 */
export const DELEGATION_POLICY: string = `${POLICY_OPENING} ${EXPLORER_CLAUSE} ${IMPLEMENTER_CLAUSE} ${POLICY_CLOSING}`;

/**
 * The policy for what is ACTUALLY AVAILABLE this turn, or `undefined` when there
 * is nothing to say.
 *
 * Two conditions, both per-turn:
 *   * `explorer` is mentioned when it is in `subagentNames`;
 *   * `implementer` is mentioned when it is in `subagentNames` AND
 *     `opts.canMutate` is true — a turn that cannot change anything has nothing
 *     to hand it.
 * With neither left, the result is `undefined` rather than a policy about
 * delegation in general: the caller then appends nothing.
 *
 * Names are matched exactly (they are the harness rows' names, which are the
 * upsert identity). The closing two sentences are common to every shape, because
 * "do the small things yourself" and "the subagent cannot see this conversation"
 * are true of any delegation.
 */
export function delegationPolicyFor(
  subagentNames: readonly string[],
  opts: DelegationPolicyOptions,
): string | undefined {
  const names = new Set(subagentNames);
  const hasExplorer = names.has(EXPLORER_SUBAGENT);
  const hasImplementer = names.has(IMPLEMENTER_SUBAGENT) && opts.canMutate;
  if (!hasExplorer && !hasImplementer) return undefined;
  if (hasExplorer && hasImplementer) return DELEGATION_POLICY;

  const clause = hasExplorer ? EXPLORER_CLAUSE : IMPLEMENTER_CLAUSE;
  return `${POLICY_OPENING} ${clause} ${POLICY_CLOSING}`;
}
