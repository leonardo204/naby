// src/runtime/delegate.ts
//
// naby_delegate — SUBAGENTS ON AN ENGINE THAT HAS NONE (Phase 2.5, M4b).
//
// M4a mapped `SubagentSpec` onto the Claude Agent SDK's native `agents`, so on
// that engine the model delegates through its own gated `Task` tool. The AI-SDK
// engine has no such concept and simply IGNORED the specs — meaning every
// subagent the user imported was invisible on the provider path, and which
// engine happened to be selected silently changed what the app could do. That is
// exactly the provider-dependence the runtime exists to prevent.
//
// So this is the manual equivalent: a tool that runs the subagent as a NESTED
// TURN and returns its answer as a tool result. The shape is deliberately the
// same as the native path from the model's point of view — name a subagent, hand
// it a task, get back text — so a prompt written for one engine works on the
// other.
//
// WHAT MAKES IT SAFE, and each of these is load-bearing:
//
//   * THE NESTED TURN RUNS BEHIND THE SAME GATE. The shell hands its own gate
//     down, so a subagent's Bash call is decided by the same policy (and can
//     still suspend for the same human approval) as the parent's. A nested run
//     with its own permissive gate would be a hole big enough to drive the whole
//     Phase 2 policy through.
//   * `toolRefs` RESTRICTS, never widens. A subagent limited to Read cannot
//     reach Write by being delegated to — the filter is applied to the parent's
//     already-gated toolset, so the nested set is always a subset.
//   * DEPTH IS CAPPED. Without it, a subagent whose prompt says "delegate this"
//     recurses until something runs out, and each level costs a real model call.
//   * THE MODEL CANNOT INVENT A TARGET. The schema enumerates the available
//     names, and an unknown name is a tool error naming the ones that exist
//     rather than a silent no-op.

import type { Executor, SubagentSpec, ToolOutput, ToolSchema } from './engine.js';

/** The bare name of the delegation tool — also its gate/allowlist key. */
export const DELEGATE_TOOL_NAME = 'naby_delegate';

/**
 * How many levels of nesting are allowed. 0 is the user's own turn, so 2 permits
 * A → B → C and stops there.
 *
 * A cap rather than a ban because one level of hand-off is the common useful case
 * ("have the reviewer look at this") and two covers a coordinator delegating to
 * specialists. Beyond that the cost compounds — every level is a full model call
 * — and the transcript stops being something a person can follow.
 */
export const MAX_DELEGATION_DEPTH = 2;

/** Max task length handed to a subagent. A task longer than this is a document,
 *  and pasting one into a nested turn wastes the budget the subagent needs for
 *  its own work. */
export const DELEGATE_TASK_MAX = 4000;

/** The result of a nested run, as the shell reports it. */
export interface DelegationResult {
  ok: boolean;
  /** What the subagent answered. May be present even when `ok` is false (a run
   *  that produced partial text then failed). */
  text: string;
  error?: string;
}

/** What the delegate executor needs from the shell. */
export interface DelegationSink {
  /** Who may be delegated to on this turn. */
  subagents: readonly SubagentSpec[];
  /** Nesting level of the CURRENT turn. 0 = the user's own. */
  depth: number;
  /** Run the subagent as a nested turn and return its answer. The shell owns
   *  this: only it has the engine, the model and the gate. */
  run(input: { spec: SubagentSpec; task: string }): Promise<DelegationResult>;
}

/** Whether delegation is possible at all on this turn: someone to delegate to,
 *  and depth left to do it in. */
export function canDelegate(sink: Pick<DelegationSink, 'subagents' | 'depth'>): boolean {
  return sink.subagents.length > 0 && sink.depth < MAX_DELEGATION_DEPTH;
}

/** Find a subagent by name, case-insensitively — the model reproduces a name from
 *  a list and should not fail on capitalisation. */
export function findSubagent(
  subagents: readonly SubagentSpec[],
  name: string,
): SubagentSpec | undefined {
  const wanted = name.trim().toLowerCase();
  return subagents.find((s) => s.name.trim().toLowerCase() === wanted);
}

/** Everything wrong with a delegate call, in the words the MODEL needs to fix it.
 *  Empty array = well-formed. Pure. */
export function validateDelegateInput(
  input: { agent: string; task: string },
  subagents: readonly SubagentSpec[],
): string[] {
  const problems: string[] = [];
  const name = input.agent.trim();
  if (!name) {
    problems.push('`agent` is empty — name one of the available subagents');
  } else if (!findSubagent(subagents, name)) {
    problems.push(
      subagents.length > 0
        ? `there is no subagent called "${name}". Available: ${subagents.map((s) => s.name).join(', ')}`
        : `there is no subagent called "${name}", and none are available on this turn`,
    );
  }
  const task = input.task.trim();
  if (!task) {
    problems.push('`task` is empty — say what the subagent should do, in full, since it cannot see this conversation');
  } else if (task.length > DELEGATE_TASK_MAX) {
    problems.push(`\`task\` is ${task.length} chars; keep it under ${DELEGATE_TASK_MAX}`);
  }
  return problems;
}

/** Build the delegate executor bound to a turn's sink. */
export function makeDelegate(sink: DelegationSink): Executor {
  return async (input): Promise<ToolOutput> => {
    const rec = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const agent = String(rec.agent ?? '');
    const task = String(rec.task ?? '');

    // Checked before validation: at the cap, WHICH subagent was named does not
    // matter, and the model needs to hear the real reason rather than a name error.
    if (sink.depth >= MAX_DELEGATION_DEPTH) {
      return {
        content:
          `Delegation is already ${sink.depth} level(s) deep, which is the limit. ` +
          'Do this part of the work yourself.',
        isError: true,
      };
    }

    const problems = validateDelegateInput({ agent, task }, sink.subagents);
    if (problems.length) {
      return { content: `Nothing was delegated: ${problems.join('; ')}.`, isError: true };
    }

    const spec = findSubagent(sink.subagents, agent)!;
    let result: DelegationResult;
    try {
      result = await sink.run({ spec, task: task.trim() });
    } catch (e) {
      return {
        content: `@${spec.name} could not be run: ${e instanceof Error ? e.message : String(e)}.`,
        isError: true,
      };
    }

    if (!result.ok) {
      // Partial text is still worth handing back — it may be most of the answer,
      // and hiding it would make the parent redo work that was already done.
      const detail = result.error ? ` (${result.error})` : '';
      return {
        content: result.text
          ? `@${spec.name} did not finish${detail}. What it produced before stopping:\n\n${result.text}`
          : `@${spec.name} did not finish${detail}.`,
        isError: true,
      };
    }
    return {
      content: `@${spec.name} answered:\n\n${result.text}`,
      data: { agent: spec.name },
    };
  };
}

/**
 * The tool schema, built per turn because it ENUMERATES the available subagents.
 * Listing them in the schema is what stops the model inventing a target, and the
 * descriptions are what let it choose sensibly — a bare string parameter would
 * make delegation a guessing game.
 */
export function delegateSchema(subagents: readonly SubagentSpec[]): ToolSchema {
  const names = subagents.map((s) => s.name);
  const roster = subagents
    .map((s) => `"${s.name}"${s.description ? ` — ${s.description}` : ''}`)
    .join('; ');
  return {
    name: DELEGATE_TOOL_NAME,
    description:
      'Hand a self-contained piece of work to a specialist subagent and get its answer back. ' +
      `Available: ${roster}. ` +
      'The subagent CANNOT see this conversation, so the task must be complete on its own — include ' +
      'the file paths, the constraints and what "done" looks like. Use it when a subagent is clearly ' +
      'better suited than you are; do the work yourself when it is not.',
    parameters: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          ...(names.length > 0 ? { enum: names } : {}),
          description: 'Name of the subagent to hand the work to.',
        },
        task: {
          type: 'string',
          description: `What it should do, stated in full (max ${DELEGATE_TASK_MAX} chars). It has no other context.`,
        },
      },
      required: ['agent', 'task'],
    },
  };
}
