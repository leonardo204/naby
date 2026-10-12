// src/runtime/approval-merge.ts
//
// ONE PROMPT PER DECISION (specs/org-harness-sync.md §7.10).
//
// Two things can ask the user about a tool call: an org harness PreToolUse hook
// (`permissionDecision: "ask"`) and the user's own policy rule (`ask`). They
// used to ask one after the other, so a call both cared about raised two
// prompts in a row for what the user experiences as one question. This module
// decides how many prompts a call gets and what each one says.
//
//   hook ask + policy ask, same input   ONE prompt ('hook+policy') carrying both
//                                       reasons. One answer settles both.
//   hook ask, policy allows             ONE prompt ('hook'), raised after the
//                                       policy has had its say.
//   policy ask, no hook opinion         ONE prompt ('policy'), as before.
//   hook ask + updatedInput, policy     TWO prompts: the hook's about the call
//   asks about the rewritten input      the model made ('hook'), then the
//                                       policy's about the input that will
//                                       actually run ('policy', `rewrittenBy`).
//                                       They are different decisions about
//                                       different inputs.
//   any deny (hook or policy)           NO prompt. A hook deny never gets here
//                                       (the caller refuses first); a policy
//                                       deny is returned before the hook's
//                                       prompt would be raised.
//
// "REMEMBER" IS THE POLICY'S BUSINESS ONLY. A merged prompt still offers the
// "always allow/block" buttons, because they write a POLICY rule; the hook part
// is never remembered — a hook decides per call. Next time the policy rule says
// allow and only the hook asks, which is one prompt again. That is the prompt
// layer's job (it only shows the buttons when `askedBy` includes 'policy'); this
// module just says who is asking.
//
// THE PROMPT SHOWS THE INPUT ITS DECIDER JUDGED. The hook judged the model's
// call; the policy judged whatever it was handed — the hook's rewrite when there
// is one. An allowed call carries the rewrite to the executor as
// `GateDecision.input` (contract §3 invariant 2), on both engines.
//
// Engine- and UI-independent: the shell supplies `prompt` (its approval bridge)
// and wires `policyAsk` into `realPolicy({ requestApproval })`.

import type { GateDecision, ToolCall } from './engine.js';
import type { DecisionPolicy } from './gate.js';

/** A hook's opinion that needs the merger: an `ask`, or an `allow` that
 *  rewrites the input. (`deny` is the caller's to refuse; a plain `allow` is
 *  no opinion.) `updatedInput` is already in naby's spelling for the tool. */
export type HookOpinion = {
  behavior: 'ask' | 'allow';
  script: string;
  reason?: string;
  updatedInput?: Record<string, unknown>;
};

/** One prompt to raise. */
export type ApprovalPromptRequest = {
  /** The call as the prompt shows it — `input` is what this prompt approves. */
  call: ToolCall;
  /** Who is asking: drives the reasons shown and whether "always" is offered
   *  (only when the policy is among the askers). */
  askedBy: 'hook' | 'policy' | 'hook+policy';
  /** The hook that asked ('hook' and 'hook+policy'). */
  hook?: { script: string; reason?: string };
  /** A 'policy' prompt whose input a hook rewrote: that hook's script. */
  rewrittenBy?: string;
};

export type ApprovalPrompt = (req: ApprovalPromptRequest) => Promise<GateDecision>;

export type ApprovalMerger = {
  /** Hand to `realPolicy({ requestApproval })`. A policy `ask` lands here and
   *  is merged with a pending hook ask on the same call, if any. */
  policyAsk(call: ToolCall): Promise<GateDecision>;
  /** Wrap the policy (the one whose requestApproval is `policyAsk`) so a call
   *  the hook had an opinion on is decided with the fewest prompts. */
  wrap(policy: DecisionPolicy, hookOpinion: (call: ToolCall) => HookOpinion | undefined): DecisionPolicy;
};

/** Structural equality for JSON-shaped tool input (key order ignored). */
export function sameToolInput(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => sameToolInput(x, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  return ak.length === bk.length && ak.every((k) => sameToolInput(ao[k], bo[k]));
}

type Open = {
  hook: HookOpinion;
  /** The call as the model made it (what the hook judged). */
  original: ToolCall;
  /** Set when the hook's rewrite differs from the original input. */
  rewritten: boolean;
  /** The policy asked (through `policyAsk`) while deciding this call. */
  policyAsked: boolean;
};

export function createApprovalMerger(prompt: ApprovalPrompt): ApprovalMerger {
  // Keyed by toolCallId: parallel calls in one step each have their own entry,
  // and the policy is handed the same id (a rewrite keeps the call's id).
  const open = new Map<string, Open>();

  const policyAsk = async (call: ToolCall): Promise<GateDecision> => {
    const o = open.get(call.toolCallId);
    if (!o) return prompt({ call, askedBy: 'policy' });
    o.policyAsked = true;
    const hook = { script: o.hook.script, ...(o.hook.reason ? { reason: o.hook.reason } : {}) };
    if (o.hook.behavior !== 'ask') {
      // A rewrite-only hook (`allow` + updatedInput): the policy's question is
      // the only one, about the input that will run.
      return prompt({ call, askedBy: 'policy', ...(o.rewritten ? { rewrittenBy: o.hook.script } : {}) });
    }
    if (!o.rewritten) return prompt({ call, askedBy: 'hook+policy', hook });
    // Different inputs, different decisions: the hook's first (about what the
    // model asked for), then the policy's (about what will run).
    const first = await prompt({ call: o.original, askedBy: 'hook', hook });
    if (first.behavior === 'deny') return first;
    return prompt({ call, askedBy: 'policy', rewrittenBy: o.hook.script });
  };

  const wrap: ApprovalMerger['wrap'] = (policy, hookOpinion) => async (call) => {
    const hook = hookOpinion(call);
    if (!hook) return policy(call);
    const rewrite =
      hook.updatedInput !== undefined && !sameToolInput(hook.updatedInput, call.input) ? hook.updatedInput : undefined;
    if (hook.behavior === 'allow' && rewrite === undefined) return policy(call);
    const target: ToolCall = rewrite !== undefined ? { ...call, input: rewrite } : call;
    const o: Open = { hook, original: call, rewritten: rewrite !== undefined, policyAsked: false };
    open.set(call.toolCallId, o);
    let decision: GateDecision;
    try {
      decision = await policy(target);
    } finally {
      open.delete(call.toolCallId);
    }
    // A policy deny wins outright — no prompt for a call that cannot run.
    if (decision.behavior === 'deny') return decision;
    // The policy allowed without asking: the hook's question is still open.
    if (hook.behavior === 'ask' && !o.policyAsked) {
      const answer = await prompt({
        call,
        askedBy: 'hook',
        hook: { script: hook.script, ...(hook.reason ? { reason: hook.reason } : {}) },
      });
      if (answer.behavior === 'deny') return answer;
    }
    const input = decision.input ?? rewrite;
    return input !== undefined ? { behavior: 'allow', input } : { behavior: 'allow' };
  };

  return { policyAsk, wrap };
}
