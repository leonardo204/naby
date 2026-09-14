// src/engines/subagent-model.ts
//
// WHICH MODEL A SUBAGENT ACTUALLY RAN ON — read once per delegated run
// (specs/subagent-delegation.md §4.3).
//
// WHY THIS IS OBSERVED RATHER THAN ASSUMED. naby writes `model: haiku` into the
// `explorer` definition and hands it to the backend, but the backend decides. The
// Agent SDK has moved the resolution order between CLI versions (call-site model
// → definition → `CLAUDE_CODE_SUBAGENT_MODEL` → main model is 2.1.259's order;
// before 2.1.251 the environment variable came FIRST), and
// `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` overrides all of it. So the honest answer
// to "what did the cheap subagent cost" is not in our configuration — it is in
// the assistant messages the subagent produced, each of which names the model
// that produced it. Reading it is what keeps a silent override visible instead of
// turning a haiku delegation into an opus one nobody notices (§2 principle 2).
//
// ONCE PER DELEGATED RUN. A subagent emits many assistant messages and every one
// of them carries the same model; the consumer wants a label for the block, not a
// stream. `parent_tool_use_id` — the id of the `Task` call that spawned the run,
// and the same key the attributed `text` events already travel under — is the
// deduplication identity, held in a Set owned by ONE `run()` call.
//
// A SEPARATE FILE, AND IT MUST NOT IMPORT THE SDK. The engine module resolves and
// loads the Agent SDK when it is imported, which is exactly why this logic lives
// here: a spike can feed it fabricated message shapes and assert the contract
// without a sign-in, a network, or the 200 MB CLI.

import type { EngineEvent } from '../runtime/engine.js';

/** The only two fields of an Agent SDK assistant message this reads. Declared
 *  structurally (and loosely) rather than imported from the vendor package: the
 *  caller passes the real `SDKAssistantMessage` fields in, and a spike passes
 *  fabricated ones, and neither needs the SDK's types to do it. */
export type SubagentModelSource = {
  /** `msg.parent_tool_use_id` — a string names the `Task` call this message
   *  belongs to; null/undefined means the MAIN thread. */
  parentToolUseId?: unknown;
  /** `msg.message.model` — the concrete id the provider ran. */
  model?: unknown;
};

/**
 * The `subagent_model` event for this message, or `undefined` when there is
 * nothing new to say.
 *
 * Returns undefined when:
 *   * the message is from the main thread (no `parent_tool_use_id`) — the main
 *     model is already reported by `init` and by the result's `contextModel`;
 *   * the message names no model, or names a blank one — a reading that says
 *     nothing must not overwrite a real one downstream, and an event with an
 *     empty `model` would render as a subagent labelled with nothing;
 *   * this `parent_tool_use_id` has been reported already.
 *
 * MUTATES `seen`. The caller owns the Set (one per run), so the "once" is scoped
 * to a turn and two concurrent runs cannot silence each other.
 */
export function subagentModelEvent(
  seen: Set<string>,
  msg: SubagentModelSource,
): EngineEvent | undefined {
  const agentToolCallId = typeof msg.parentToolUseId === 'string' ? msg.parentToolUseId : undefined;
  if (!agentToolCallId) return undefined;
  const model = typeof msg.model === 'string' ? msg.model.trim() : '';
  if (!model) return undefined;
  if (seen.has(agentToolCallId)) return undefined;
  seen.add(agentToolCallId);
  return { kind: 'subagent_model', agentToolCallId, model };
}
