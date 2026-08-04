// src/runtime/stage-contract.ts
//
// THE STAGE CAPABILITY CONTRACT (Phase 3, P3-M12a) — what an agent may DO at the
// stage it has actually earned.
//
// WHAT CHANGED AND WHY. Until M12 the butterfly stage was a MENTION gate: an
// agent that was not a butterfly could not be `@`-addressed at all. That produced
// an agent nobody could use before it was fully grown, which is also an agent
// that never gets the conversations it would grow from — and the honest reading
// of "you may not call this" is "this product does nothing for a new user for
// weeks". So the gate MOVED rather than loosened (trust-meter §4.9, 0.7.0): the
// mention is free, and the stage now decides the ACTION RANGE.
//
// WHY ACTION CLASS AND NOT DIFFICULTY. The obvious design is to let the model
// judge whether a request is "at its level". It cannot: self-reported abstention
// is badly miscalibrated — about a third of the questions a model declines it can
// in fact answer (arXiv:2507.16199) — so a difficulty-based contract would be
// enforced by the least reliable judge available. The contract is therefore keyed
// on the MECHANICAL classification the ledger already uses
// (`classifyToolConsequence` / `isReversibleAction`): read, propose, reversible
// act, irreversible act. Those are properties of the tool, decided before the
// model is consulted, and the model cannot argue with them.
//
// TWO ENFORCEMENT POINTS, and only the first one is a gate:
//
//   * THE TOOL GATE (binding). The engine refuses a call the contract does not
//     allow. This holds whatever the prompt says, so a model that ignores its
//     instructions still cannot act outside its stage.
//   * THE STAGE INSTRUCTION (advisory). The turn's system prompt states the
//     contract and the REAL numbers from `stageProgressSummary`, so the agent
//     refuses honestly and up front instead of trying, being blocked, and
//     narrating a failure.
//
// A REFUSAL HERE IS NOT A SAFETY EVENT. The caller must NOT write a `tripwire`
// row for it: a tripwire is a hard block on the butterfly stage (trust-meter
// §4.8), and stamping one every time a larva declines to edit a file would mean
// the meter punishes an agent for obeying its own contract — growth would become
// literally unreachable. Policy refusals still write one; this does not.
//
// Pure: no store, no clock, no I/O. The engine composes it.

import { isConsequentialTool, isReversibleAction, type ToolConsequenceSignals } from './checkin.js';
import {
  BUTTERFLY_THRESHOLD,
  GROWTH_MIN_SAMPLE,
  PUPA_THRESHOLD,
  type GrowthStage,
  type GrowthState,
} from './growth.js';

/** What one stage is allowed to do (fast-evolution §3.1). */
export type StageContract = {
  /** May it call tools that leave a result behind at all? */
  allowConsequential: boolean;
  /** May it call the ones that cannot be undone (a shell command, an outbound
   *  message)? Only meaningful when `allowConsequential` is true. */
  allowIrreversible: boolean;
  /** The step ceiling this stage imposes, or undefined for "whatever the user
   *  configured". Undefined rather than a large number on purpose: a butterfly
   *  is NOT capped by the contract, it is capped by the persona setting, and
   *  writing a number here would silently become a second, competing limit. */
  maxSteps: number | undefined;
};

/**
 * The contract for a stage.
 *
 *   egg / larva — read, interview, propose, draft. Nothing that leaves a trace.
 *                 One step: an agent that cannot act has nothing to do with a
 *                 second turn but talk to itself.
 *   pupa        — reversible action, with the check-in habit already in place.
 *                 Three steps, or the user's setting if it is smaller.
 *   butterfly   — the full autonomous delegation the meter was always gating.
 *
 * The egg/larva line is deliberately identical: what separates them is how much
 * they KNOW (larva has measured history behind its proposals), not what they are
 * permitted to touch, and inventing a capability difference would mean promising
 * the user something the evidence has not yet earned.
 */
export function stageContract(stage: GrowthStage): StageContract {
  switch (stage) {
    case 'egg':
    case 'larva':
      return { allowConsequential: false, allowIrreversible: false, maxSteps: 1 };
    case 'pupa':
      return { allowConsequential: true, allowIrreversible: false, maxSteps: 3 };
    case 'butterfly':
      return { allowConsequential: true, allowIrreversible: true, maxSteps: undefined };
  }
}

/**
 * Why this call is not allowed at this stage, in the words the MODEL reads, or
 * undefined when the contract permits it.
 *
 * English, and specific about which rule bit: the string comes back as the tool
 * error, and "not allowed" without a reason produces an agent that retries the
 * same call. It names the alternative too, because the refusal the user should
 * see is "I cannot write the file, but here is the draft" — see
 * `stageInstruction` in the shell for the protocol this half enforces.
 *
 * The consequence classification is the LEDGER's, passed through unchanged
 * (annotations and policy included), so "consequential" can never mean one thing
 * to the meter and another to this gate.
 */
export function stageRefusalReason(input: {
  /** The bare tool name the gate sees. */
  toolName: string;
  stage: GrowthStage;
  contract: StageContract;
  signals?: ToolConsequenceSignals;
}): string | undefined {
  if (!isConsequentialTool(input.toolName, input.signals)) return undefined;
  if (!input.contract.allowConsequential) {
    return (
      `Blocked by the stage contract: \`${input.toolName}\` changes something outside this ` +
      `conversation, and at the ${input.stage} stage this agent may only read, ask and propose. ` +
      `Do not retry it and do not look for another tool that does the same thing. Say plainly ` +
      `what you cannot do, do the part you CAN do (a draft, a plan, the exact commands for the ` +
      `user to run), and say what is still needed to reach the next stage.`
    );
  }
  if (!input.contract.allowIrreversible && !isReversibleAction(input.toolName)) {
    return (
      `Blocked by the stage contract: \`${input.toolName}\` cannot be undone, and at the ` +
      `${input.stage} stage this agent may only take actions that can be rolled back. Do not ` +
      `retry it. Say what you cannot do, offer the reversible way of doing it (or the exact ` +
      `command for the user to run themselves), and say what is still needed to reach the next stage.`
    );
  }
  return undefined;
}

/**
 * How far this agent is from the next stage — the NUMBERS the honest refusal
 * quotes (fast-evolution §3.2, point 3).
 *
 * Computed from the ledger rather than estimated by the model, and that is the
 * whole point: an agent asked to guess how close it is will produce an
 * encouraging sentence, and an encouraging sentence about a number the user can
 * check is how a meter loses its credibility.
 */
export type StageProgress =
  /** Below the minimum sample: the honest answer is a COUNT of answers still
   *  needed, not a percentage of an interval that does not exist yet. */
  | { kind: 'samples'; remaining: number }
  /** Measured: how far the Wilson lower bound is from the next cut-off. */
  | { kind: 'bound'; lowerBound: number; nextThreshold: number; nextStage: GrowthStage }
  /** Already a butterfly — there is nothing above it. */
  | { kind: 'top' };

export function stageProgressSummary(state: GrowthState): StageProgress {
  // The minimum sample is counted in REAL, explicit check-ins (drills can never
  // fill it — fast-evolution §3.4), which is exactly what `state.trials` holds.
  if (state.trials < GROWTH_MIN_SAMPLE) {
    return { kind: 'samples', remaining: Math.max(1, GROWTH_MIN_SAMPLE - state.trials) };
  }
  if (state.stage === 'butterfly') return { kind: 'top' };
  // A pupa held back by a tripwire can sit ABOVE the butterfly threshold; the gap
  // then reads as already-met, which is true — what blocks it is the safety
  // refusal, and that is reported separately (`blockedByTripwire`) rather than
  // being smuggled into this number.
  const nextStage: GrowthStage = state.stage === 'pupa' ? 'butterfly' : 'pupa';
  const nextThreshold = state.stage === 'pupa' ? BUTTERFLY_THRESHOLD : PUPA_THRESHOLD;
  return { kind: 'bound', lowerBound: state.lowerBound, nextThreshold, nextStage };
}
