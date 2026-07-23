// src/runtime/session.ts
//
// The provider-independent turn runner. This is the seam the app drives: it
// owns the store, hands the engine the provider-independent inputs, and folds
// the engine's normalized events back into our own message history. It is
// identical regardless of which engine (= which provider) runs the turn.
//
// Since F1-05 the store is the `Store` INTERFACE, not a concrete class — the
// same runTurn drives an in-memory store in a spike and a SQLite file on disk
// in the app, and neither the engines nor this file know which one they got.

import type {
  Engine,
  EngineEvent,
  Executor,
  Gate,
  ModelSelection,
  ToolOutput,
  ToolSchema,
} from './engine.js';
import { composeSystemWithMemory, retrieveForInjection } from './memory-inject.js';
import {
  composeSystemWithSkills,
  retrieveSkillsForInjection,
  type InjectedSkills,
  type SkillInjectionQuery,
} from './skill-inject.js';
import type { InjectedMemory, MemoryInjectionQuery, Store } from './store/store.js';

export type RunTurnOptions = {
  engine: Engine;
  store: Store;
  sessionId: string;
  model: ModelSelection;
  userText: string;
  toolSchemas: ToolSchema[];
  executors: Record<string, Executor>;
  gate: Gate;
  /** System prompt for this turn. Passed to the engine on its OWN field, never
   * appended to the history — `ai@7` rejects `role:'system'` inside `messages`
   * and a system prompt is not part of the transcript we replay (contract §6). */
  system?: string;
  /** The directory this turn is ABOUT — passed straight through to the engine.
   * Callers that name a working directory in `system` should pass the SAME one
   * here: the two disagreeing is the bug documented on `EngineRunInput.cwd`
   * (the model is told one directory while the backend sits in another). Not
   * persisted and not part of the transcript — it describes where the turn
   * runs, not what was said. */
  cwd?: string;
  /** Called for each event AS IT ARRIVES, before runTurn returns. A caller that
   * must stream (the shell adapter translating to its client's event shapes)
   * uses this instead of re-implementing the loop — which keeps the store
   * writes, and the tool-call pairing below, in ONE place. Throwing from here
   * aborts the turn. */
  onEvent?: (ev: EngineEvent) => void;
  signal?: AbortSignal;

  // -- usage accounting (F1-07) ---------------------------------------------
  //
  // These two describe the ENGINE that is about to run, which `runTurn` cannot
  // infer: `Engine` is an interface and deliberately says nothing about which
  // backend implements it or what it costs. The composition root (the shell's
  // adapter) picks the engine, so it is the only place that knows.
  //
  // They are recorded, never used for control flow — the keying invariant
  // (contract §6) is untouched.

  /** Which backend answers: 'ai-sdk' | 'dev-claude'. Default 'ai-sdk'. */
  engineId?: string;
  /**
   * Whether this turn's tokens are billed to the user. Default 'metered'.
   * 'subscription' means a local sign-in paid for it and no dollar figure may
   * be presented as a charge (see runtime/usage.ts).
   */
  costBasis?: 'metered' | 'subscription';

  // -- memory injection (Phase 1.5, P15-02) ---------------------------------
  //
  // OPT-IN. When absent, runTurn does ZERO memory work and the turn is
  // byte-for-byte what Phase 1 would have sent (the no-op invariant, contract
  // §5) — which is why the existing spikes, which pass no config here, are
  // unchanged. When present, runTurn retrieves confirmed, scope-appropriate
  // memory within `tokenBudget`, assembles it into the turn's SYSTEM field
  // (above the engine seam — never a stored transcript message), and reports the
  // selection so the injected item ids can be logged.

  /** Retrieve + inject confirmed memory into this turn's system prompt, under a
   * hard token budget. Omit to disable injection entirely (a pure no-op). */
  memoryInjection?: {
    /** HARD cap on injected memory tokens for this turn. */
    tokenBudget: number;
    /** Task-type hint (aligns with eval_events.task_type). */
    taskType?: string;
    /** user-scope key — a single-user-machine constant by default. */
    userId?: string;
    /** org-scope key — omit unless in-house org memory is in play. */
    orgId?: string;
  };
  /** Called once with what was injected (items, tokensUsed, droppedForBudget) so
   * the caller can record the per-turn memory log (contract §5). Fires only when
   * `memoryInjection` is set; the items array is empty on a no-op turn. */
  onMemoryInjection?: (injected: InjectedMemory) => void;

  // -- skill instruction injection (Phase 1.6, HP-03a) ----------------------
  //
  // OPT-IN, and independent of memory injection above. When absent, runTurn does
  // ZERO skill work and the turn is byte-for-byte what it would have been (the
  // no-op invariant) — which is why the existing spikes, passing no config here,
  // are unchanged. When present, runTurn injects the ENABLED, INSTRUCTION-ONLY
  // skills that the turn triggers (or that are always-on), within a hard token
  // budget SEPARATE from memory's, into the turn's SYSTEM field (above the engine
  // seam — never a stored transcript message), side by side with any memory
  // block. Tool-bearing skills are NOT injected (Phase 2.5) but are counted so
  // the omission is observable (contract §3, impl §6).

  /** Inject enabled, instruction-only skills into this turn's system prompt,
   * under a hard token budget. Omit to disable skill injection entirely (a pure
   * no-op). */
  skillInjection?: {
    /** HARD cap on injected skill tokens for this turn (separate from memory's). */
    tokenBudget: number;
    /** user-scope key — a single-user-machine constant by default. */
    userId?: string;
    /** org-scope key — omit unless in-house org harness is in play. */
    orgId?: string;
  };
  /** Called once with what was injected (skills, tokensUsed, droppedForBudget,
   * excludedForTools) so the caller can log/inspect the per-turn skill selection.
   * Fires only when `skillInjection` is set; the skills array is empty on a no-op
   * turn and `excludedForTools` reports tool-bearing skills held for Phase 2.5. */
  onSkillInjection?: (injected: InjectedSkills) => void;
};

/** Run one turn on the given engine, folding its events into the store. Returns
 * the full event list so a spike can assert on it. */
export async function runTurn(opts: RunTurnOptions): Promise<EngineEvent[]> {
  const { engine, store, sessionId, model, userText, toolSchemas, executors, gate } =
    opts;

  // Record the provider that is about to answer. This is the ONLY place a
  // provider id touches storage, and it is a hint — see SessionRef.providerId.
  store.touchSession(sessionId, model.providerId);

  store.appendMessage(sessionId, { role: 'user', content: userText });

  // -- MEMORY INJECTION (Phase 1.5, P15-02) ---------------------------------
  // Retrieve confirmed, scope-appropriate memory within a hard token budget and
  // assemble it into THIS turn's system prompt — provider/engine-independent,
  // above the engine seam. `effectiveSystem` is what the engine receives; when
  // injection is off, or when nothing relevant is confirmed, it is IDENTICAL to
  // `opts.system` (including undefined), so the turn is byte-for-byte what it
  // would have been without Phase 1.5 — the no-op invariant (contract §5). The
  // injected block rides on the system field only; it is never appended to the
  // transcript we store (contract §3 "no role:'system' leakage").
  let effectiveSystem = opts.system;
  if (opts.memoryInjection) {
    const query: MemoryInjectionQuery = {
      sessionId,
      tokenBudget: opts.memoryInjection.tokenBudget,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.memoryInjection.taskType !== undefined
        ? { taskType: opts.memoryInjection.taskType }
        : {}),
    };
    const injectOpts: { userId?: string; orgId?: string } = {};
    if (opts.memoryInjection.userId !== undefined)
      injectOpts.userId = opts.memoryInjection.userId;
    if (opts.memoryInjection.orgId !== undefined)
      injectOpts.orgId = opts.memoryInjection.orgId;
    const injected = retrieveForInjection(store, query, injectOpts);
    effectiveSystem = composeSystemWithMemory(opts.system, injected);
    // Record what was injected (item ids, tokensUsed, droppedForBudget) so a
    // bad injection is auditable and memory hit rate is computable.
    opts.onMemoryInjection?.(injected);
  }

  // -- SKILL INSTRUCTION INJECTION (Phase 1.6, HP-03a) ----------------------
  // Assemble the enabled, instruction-only skills this turn triggers into the
  // SAME system field, right after any memory block, under their own header —
  // provider/engine-independent, above the engine seam. When skill injection is
  // off, or nothing relevant is enabled, `effectiveSystem` is left exactly as the
  // memory step produced it (byte-for-byte the no-op), so a turn with neither
  // config is what Phase 1 would have sent. Tool-bearing skills are excluded (no
  // half-run before Phase 2.5) and reported via `excludedForTools`.
  if (opts.skillInjection) {
    const skillQuery: SkillInjectionQuery = {
      userText,
      tokenBudget: opts.skillInjection.tokenBudget,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    };
    const skillOpts: { userId?: string; orgId?: string } = {};
    if (opts.skillInjection.userId !== undefined)
      skillOpts.userId = opts.skillInjection.userId;
    if (opts.skillInjection.orgId !== undefined)
      skillOpts.orgId = opts.skillInjection.orgId;
    const injectedSkills = retrieveSkillsForInjection(store, skillQuery, skillOpts);
    effectiveSystem = composeSystemWithSkills(effectiveSystem, injectedSkills);
    opts.onSkillInjection?.(injectedSkills);
  }

  const controller = new AbortController();
  const signal = opts.signal ?? controller.signal;

  const events: EngineEvent[] = [];

  // The model that ACTUALLY answered, for the usage row (F1-07).
  //
  // `model.model` is what we ASKED for, and it is routinely not what ran: it is
  // optional (the dev engine has its own default and picks one itself), and an
  // engine may resolve an alias to a concrete id. Pricing is keyed by model, so
  // recording the request rather than the result would price the wrong thing —
  // or, when we asked for nothing at all, price nothing. Every engine reports
  // what it settled on in its `init` event, so that is what gets recorded.
  let answeringModel = model.model ?? '';

  // -- Tool-call PAIRING -----------------------------------------------------
  // A persisted tool result is only replayable if the assistant tool-call that
  // produced it is in the transcript too: providers reject a tool result with
  // no matching call just as they reject a call with no matching result. So we
  // record BOTH, and we guarantee the pairing rather than hoping for it —
  //
  //   tool_request        -> append assistant(toolCalls:[call]), mark pending
  //   tool_result         -> append tool(result), clear pending
  //   gate_result 'deny'  -> no executor runs and no tool_result follows, so
  //                          append the denial AS the tool result (which is
  //                          also exactly what the engine fed the model)
  //   stream ended        -> close out anything still pending (e.g. NO_EXECUTOR,
  //                          or an abort mid-call) so no orphan call survives
  //
  // Each pair is appended adjacently, which keeps the transcript valid for
  // every provider without any provider-specific reordering.
  const pending = new Map<string, string>(); // toolCallId -> toolName

  const closeCall = (toolCallId: string, output: ToolOutput): void => {
    const toolName = pending.get(toolCallId);
    if (toolName === undefined) return; // already closed
    pending.delete(toolCallId);
    // `toolName` is carried explicitly (contract §6): a persisted tool result
    // must be replayable as a REAL tool message even when its originating call
    // was written by an earlier turn, an earlier process, or another engine.
    store.appendMessage(sessionId, {
      role: 'tool',
      toolCallId,
      toolName,
      output,
    });
  };

  for await (const ev of engine.run({
    model,
    // Read the transcript back from the store: after F1-05 this may have come
    // from disk, written by a previous process and possibly a different engine.
    messages: store.getMessages(sessionId),
    ...(effectiveSystem !== undefined ? { system: effectiveSystem } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    toolSchemas,
    gate,
    executors,
    signal,
  })) {
    // Cancellation: stop consuming the moment the turn is aborted. Breaking out
    // of the for-await calls the engine generator's return(), which unwinds the
    // engine's own loop — so an abort stops the model loop here and now rather
    // than letting it run to its iteration cap. The signal is ALSO handed to
    // the engine (and through it to the provider call), so this is a second
    // barrier, not the only one.
    if (signal.aborted) break;

    events.push(ev);
    // Every event reaches the streaming caller, INCLUDING `harness`. That is
    // the only path a harness event takes: it is observational (see the
    // `harness` doc in engine.ts), so it is forwarded for display and then
    // deliberately falls off the end of the fold below without touching the
    // store. There is no `ev.kind === 'harness'` branch there ON PURPOSE —
    // adding one would mint a `RuntimeMessage` for it, and `RuntimeMessage` has
    // a closed three-variant contract with NO system role (see the note at
    // engine.ts §"Runtime message"). A harness event is transport, not
    // conversation; persisting it would put backend-internal bookkeeping into a
    // transcript that must replay identically on an engine that never emits it.
    opts.onEvent?.(ev);

    if (ev.kind === 'init') {
      if (ev.model) answeringModel = ev.model;
    } else if (ev.kind === 'text' && ev.role === 'assistant') {
      store.appendMessage(sessionId, { role: 'assistant', content: ev.text });
    } else if (ev.kind === 'tool_request') {
      pending.set(ev.toolCallId, ev.toolName);
      store.appendMessage(sessionId, {
        role: 'assistant',
        content: '',
        toolCalls: [
          { toolCallId: ev.toolCallId, toolName: ev.toolName, input: ev.input },
        ],
      });
    } else if (ev.kind === 'gate_result' && ev.decision === 'deny') {
      closeCall(ev.toolCallId, {
        content: `Denied by policy gate: ${ev.reason ?? 'no reason given'}`,
        isError: true,
      });
    } else if (ev.kind === 'tool_result') {
      closeCall(ev.toolCallId, ev.output);
    } else if (ev.kind === 'result') {
      // F1-07. One row per ANSWERED turn, recorded here rather than in the
      // shell adapter so that every caller of runTurn — the app, the spikes, a
      // future scheduled task — accounts identically and none can forget.
      //
      // A pure failure (no tokens reported, not ok) is NOT recorded: a row of
      // zeros would inflate the turn count without adding information. A turn
      // that failed AFTER consuming tokens still is, because those tokens were
      // still billed.
      const usage = ev.usage;
      const anyTokens =
        (usage?.inputTokens ?? 0) > 0 ||
        (usage?.outputTokens ?? 0) > 0 ||
        (usage?.cachedInputTokens ?? 0) > 0;
      if (ev.ok || anyTokens) {
        const costBasis = opts.costBasis ?? 'metered';
        store.appendUsage(sessionId, {
          at: Date.now(),
          engine: opts.engineId ?? 'ai-sdk',
          providerId: model.providerId,
          model: answeringModel,
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          cachedInputTokens: usage?.cachedInputTokens ?? 0,
          costBasis,
          ...(ev.costUsd !== undefined ? { reportedCostUsd: ev.costUsd } : {}),
        });
      }
    }
  }

  // Nothing may be left half-written: an unclosed call would be an orphan on
  // the next replay, which is the exact failure Bug B was about.
  for (const toolCallId of [...pending.keys()]) {
    closeCall(toolCallId, {
      content: 'Tool call did not complete.',
      isError: true,
    });
  }

  return events;
}
