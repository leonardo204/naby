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

import { applyActivityLogSettings, logActivity } from './activity-log.js';
import type {
  Engine,
  EngineEvent,
  Executor,
  Gate,
  ModelSelection,
  RuntimeImage,
  SubagentSpec,
  ToolOutput,
  ToolSchema,
  VoicePort,
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
  /** Images attached to THIS user turn (multimodal input). Attached to the
   *  just-appended user message for the engine to build a native image block —
   *  TRANSIENT: not persisted (so a large paste is neither stored on disk nor
   *  replayed on every later turn) and not part of the reloaded transcript. */
  images?: RuntimeImage[];
  toolSchemas: ToolSchema[];
  executors: Record<string, Executor>;
  gate: Gate;
  /** Subagents the model may delegate to this turn (Phase 2.5 M4). Passed to the
   *  engine, which maps them if it supports native delegation (Claude Agent SDK)
   *  or ignores them (AI-SDK). */
  subagents?: SubagentSpec[];
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

  // -- the naby layer (P3-M14a, specs/naby-voice-layer.md §4.1, §8) ----------
  //
  // OPT-IN, and its absence is a full answer: no port means no deferral anyone can
  // observe, no call, no log — the turn is byte-for-byte what it was before this
  // field existed, which is the invariant the spike checks first. When present,
  // the LAST assistant text block of this step is offered to it before it reaches
  // `onEvent`, the store or the log, and whatever comes back is the ONE text all
  // three of them see (§2 principle 3: what was shown is what was stored).
  //
  // Only the last block: text that is followed by a tool call is a progress note,
  // and §4 is explicit that naby does not spend a model call tidying those.

  /** Restyle this step's final assistant block before it is shown and stored.
   *  Omit to disable the naby layer entirely (a pure no-op). */
  voice?: VoicePort;

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
    /**
     * The turn's own words, for RELEVANCE ranking (P3-M8c, contract §5).
     *
     * NOT defaulted to `userText`, deliberately. On an autonomy step 2+ the
     * `userText` is the harness's continuation prompt, which says nothing about
     * what the user wants and would rank memory against the wrong text; and an
     * omitted `queryText` keeps the pre-M8c order exactly, so every existing
     * caller (and every existing spike) is unchanged by this field's existence.
     * The caller that knows which text drives the turn passes it.
     */
    queryText?: string;
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
    /** Bare names of every tool this turn can run — a tool-bearing skill injects
     *  only when all its toolRefs are here, else it is excluded + counted (2.5). */
    availableTools?: string[];
    /** Harness rows the user NAMED in this turn's words (`/plan-review` written
     *  inside a sentence). A named row is relevant whatever its triggers say and
     *  is budgeted FIRST — see EXPLICIT NAMING in skill-inject.ts. The caller
     *  supplies it because only the caller has the user's raw text: by the time
     *  `userText` reaches here it may be an autonomy continuation prompt or an
     *  `@agent` task string. */
    explicitNames?: string[];
  };
  /** Called once with what was injected (skills, tokensUsed, droppedForBudget,
   * excludedForTools) so the caller can log/inspect the per-turn skill selection.
   * Fires only when `skillInjection` is set; the skills array is empty on a no-op
   * turn and `excludedForTools` reports tool-bearing skills held for Phase 2.5. */
  onSkillInjection?: (injected: InjectedSkills) => void;

  // -- activity log context (naby-activity-log) -----------------------------
  //
  // WHAT THE TURN RUNNER CANNOT KNOW. `runTurn` writes the activity log itself —
  // it is the one place that sees every event on every engine, so hooking it here
  // means the spikes, the app, a scheduled task and the Telegram bridge all log
  // identically and none can forget. But three facts about a turn are decided
  // ABOVE this seam and are invisible from inside it: which agent was routed to,
  // whether the session is a fast-growth drill, and what kicked the turn off. The
  // composition root that decided them passes them here rather than logging a
  // second, parallel event that could disagree.
  //
  // PURELY DESCRIPTIVE. Nothing in this object reaches an engine, a provider or
  // the store, and an omitted one changes only what the log says.

  /** Descriptive context stamped on this turn's log records. */
  activity?: {
    /** The agent this turn is attributed to (routed agent, else the persona). */
    agentId?: string;
    /** The acting agent's display name, so a log is readable without a db join. */
    agentName?: string;
    /** `SessionRef.fastGrowth` — this turn's check-ins are drills. */
    fastGrowth?: boolean;
    /** Which step of an autonomy run this is (1-based). Absent = an ordinary turn. */
    step?: number;
    /** What started the turn: 'chat' | 'telegram' | 'scheduled' | 'kickoff' | … */
    source?: string;
    /** Groups the steps of one autonomous run into one turn in the log. */
    runId?: string;
  };
};

/** Run one turn on the given engine, folding its events into the store. Returns
 * the full event list so a spike can assert on it. */
export async function runTurn(opts: RunTurnOptions): Promise<EngineEvent[]> {
  const { engine, store, sessionId, model, userText, toolSchemas, executors, gate } =
    opts;

  // -- THE ACTIVITY LOG (naby-activity-log) ---------------------------------
  //
  // WHY HERE AND NOWHERE ELSE. This function is the narrowest point through
  // which EVERY turn passes: both engines, both trees, the app, the Telegram
  // bridge, a scheduled task and every spike. It already sees the complete event
  // stream and every message that reaches the store, so a durable record built
  // here is complete by construction rather than by everyone remembering to call
  // a logger. Sprinkling `logActivity` through the engines would produce two
  // copies that drift the first time one engine grows an event the other lacks.
  //
  // The kill switch is resolved from the store on the first turn of the process
  // (once — see applyActivityLogSettings) and every call below is a no-op after
  // that if it is off. None of these calls can throw.
  const activityStartedAt = Date.now();
  applyActivityLogSettings(store);
  const activity = {
    sessionId,
    ...(opts.activity?.agentId !== undefined ? { agentId: opts.activity.agentId } : {}),
    ...(opts.activity?.agentName !== undefined ? { agentName: opts.activity.agentName } : {}),
    ...(opts.activity?.fastGrowth ? { fastGrowth: true } : {}),
    ...(opts.activity?.step !== undefined ? { step: opts.activity.step } : {}),
    ...(opts.activity?.source !== undefined ? { source: opts.activity.source } : {}),
    ...(opts.activity?.runId !== undefined ? { runId: opts.activity.runId } : {}),
  };
  logActivity('turn_started', {
    ...activity,
    engine: opts.engineId ?? 'ai-sdk',
    providerId: model.providerId,
    requestedModel: model.model,
    costBasis: opts.costBasis ?? 'metered',
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    toolCount: toolSchemas.length,
    subagentCount: opts.subagents?.length ?? 0,
    imageCount: opts.images?.length ?? 0,
  });
  // THE REQUEST, IN FULL. Truncation is the log module's business, not this
  // call's: a caller that pre-trimmed would decide for every reader that the tail
  // of a long prompt is not worth keeping.
  logActivity('user_message', { ...activity, text: userText });

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
      ...(opts.memoryInjection.queryText !== undefined
        ? { queryText: opts.memoryInjection.queryText }
        : {}),
    };
    const injectOpts: { userId?: string; orgId?: string } = {};
    if (opts.memoryInjection.userId !== undefined)
      injectOpts.userId = opts.memoryInjection.userId;
    if (opts.memoryInjection.orgId !== undefined)
      injectOpts.orgId = opts.memoryInjection.orgId;
    const injected = retrieveForInjection(store, query, injectOpts);
    effectiveSystem = composeSystemWithMemory(opts.system, injected);
    // -- ACCESS RECORDING (P3-M10, memory-hygiene §2.1) --------------------
    //
    // SELECTION IS ACCESS. The retrieval above just decided these particular
    // memories were worth spending this turn's budget on; that decision is the
    // usage signal decay is measured against, and this is the only place in the
    // codebase that holds it. Recording it anywhere else would mean either a
    // second retrieval or a caller who can forget — which is the same reasoning
    // that put corroboration inside `putMemory` rather than at its call sites.
    //
    // IT RIDES THE EXISTING INJECTION-LOG POINT, one line above the callback that
    // already reports what was injected, so the two can never describe different
    // sets. An empty injection writes NOTHING (the store's own guard), which is
    // what keeps a no-memory turn byte-for-byte AND write-for-write a Phase-1
    // turn.
    if (injected.items.length > 0) {
      store.markMemoriesInjected(injected.items.map((item) => item.id));
    }
    // Record what was injected (item ids, tokensUsed, droppedForBudget) so a
    // bad injection is auditable and memory hit rate is computable.
    opts.onMemoryInjection?.(injected);
    // Same fact, durably: "why did it answer like that" is usually "what did it
    // remember", and the injected set is not otherwise recoverable after the
    // turn — retrieval is ranked against this turn's words and would not reproduce.
    if (injected.items.length > 0 || injected.droppedForBudget > 0) {
      logActivity('memory_injected', {
        ...activity,
        count: injected.items.length,
        tokensUsed: injected.tokensUsed,
        droppedForBudget: injected.droppedForBudget,
        ids: injected.items.map((item) => item.id),
      });
    }
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
      ...(opts.skillInjection.availableTools !== undefined
        ? { availableTools: opts.skillInjection.availableTools }
        : {}),
      // The rows this turn asked for BY NAME. Passed through untouched (and only
      // when non-empty, so a turn that named nothing takes the byte-for-byte
      // path it always did).
      ...(opts.skillInjection.explicitNames !== undefined &&
      opts.skillInjection.explicitNames.length > 0
        ? { explicitNames: opts.skillInjection.explicitNames }
        : {}),
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

  // -- THE NABY LAYER'S ONE-SLOT DELAY (P3-M14a, naby-voice-layer §4.1) ------
  //
  // THE PROBLEM IT SOLVES. Restyling must apply to the step's LAST assistant
  // block and to nothing else (§4): the text before a tool call is a progress
  // note, and paying a model call to polish twenty of those is exactly the cost
  // §5 caps. But a streaming loop cannot know a block is the last one when it
  // arrives — only when something else does, or when the stream stops.
  //
  // SO THE LOOP HOLDS ONE BLOCK. A complete assistant text event is parked here
  // instead of being folded. Anything arriving after it proves it was not the
  // last thing said, so it is released VERBATIM and the new event is handled
  // normally. The engine's terminal `result` — and the end of the stream, for a
  // backend that produces none — is what proves it WAS the last, and that is the
  // one release that goes through the port.
  //
  // WHY `result` COUNTS AS THE END rather than as "something else arrived". Every
  // engine emits `result` after its final text, so treating it as an ordinary
  // event would mean the held block is always released verbatim and the layer
  // never runs at all. It also has to be this way round for the consumer: the
  // shell ends the client's turn on `result`, so a rewrite delivered after it
  // would arrive in a bubble that has already closed.
  //
  // NO OBSERVABLE COST WITHOUT A PORT — and, since the second review, no held
  // block either: the parking condition itself tests `opts.voice`, so a turn with
  // no naby layer never enters this machinery at all. The release happens before
  // the new event is pushed, so `events`, `onEvent` and the store see the same
  // values in the same order they always did.
  let heldText: Extract<EngineEvent, { kind: 'text' }> | undefined;

  /** The STORE half of an assistant text event — what the loop's own `text`
   *  branch has always done. Named so the held path and the immediate path run
   *  the same code rather than two copies of it. */
  const foldAssistantText = (
    ev: Extract<EngineEvent, { kind: 'text' }>,
    /** Extra fields for the log row — used by the one caller that delivers a block
     *  the naby layer was not allowed to touch (see `deliverText`). */
    note?: Record<string, string>,
  ): void => {
    store.appendMessage(sessionId, { role: 'assistant', content: ev.text });
    // THE RESPONSE, IN FULL — but only once. A streaming engine emits the same
    // sentence twice, as `partial` token deltas and then as one complete event;
    // logging both would write the answer to disk character by character and then
    // again whole. The complete event is the one that is also stored, so the log
    // matches the transcript.
    if (ev.partial !== true) {
      logActivity('assistant_text', { ...activity, text: ev.text, ...note });
    }
  };

  /**
   * Emit a held block: the same push, the same callback and the same fold the
   * loop performs for every other event, in the same order.
   *
   * IT ALWAYS DELIVERS, INCLUDING AFTER A STOP (second review, defect 3b — this
   * reverses the first review's instruction, and the reason is worth stating
   * because the reversal looks like a regression).
   *
   * The first round argued that a block released after an abort reaches the store
   * but not the screen, because the shell drops post-abort events — so keeping it
   * would put a paragraph in the transcript that the user never saw. That is true
   * about the EVENT and false about the TURN: pressing stop calls the shell's
   * `handleStop` → `endRun` → `onRunComplete`, which is the disk reconcile
   * (`Chat.tsx`, `reconcileFromDiskRef`). A stopped run reloads its transcript from
   * disk immediately, so a stored block IS displayed, and the two halves agree
   * after all. Dropping it was not a consistency measure; it deleted a completed
   * answer from both the screen and the record, which is the one outcome §2 never
   * chooses.
   *
   * What the abort still buys is that no rewrite is attempted (see
   * `releaseHeldRestyled`): the user gets the model's own words, immediately, which
   * is what they were waiting for when they pressed stop. `voiceSkipped` says so in
   * the log, on the same row as the text, so the missing correction is explainable
   * rather than mysterious.
   */
  const deliverText = (
    ev: Extract<EngineEvent, { kind: 'text' }>,
    note?: { voiceSkipped: 'aborted' },
  ): void => {
    events.push(ev);
    opts.onEvent?.(ev);
    foldAssistantText(ev, note);
  };

  /** Release the held block as the model wrote it — what happens whenever
   *  anything else arrives, i.e. whenever it was not the last block. */
  const releaseHeld = (): void => {
    const held = heldText;
    if (held === undefined) return;
    heldText = undefined;
    deliverText(held);
  };

  /**
   * Release the held block THROUGH the naby layer — this one WAS the last.
   *
   * ABORT SKIPS THE CALL, NOT THE BLOCK (§6). A user who pressed stop is not
   * waiting for a style correction, so no call is made and the block goes out
   * exactly as the model wrote it — the same bytes an engine with no port at all
   * would have produced. The signal is also handed to the port, which is a second
   * barrier for a call already in flight.
   *
   * The port is documented as never throwing and never returning empty; both are
   * re-checked here anyway, because the cost of being wrong about that is a turn
   * whose answer vanished.
   */
  const releaseHeldRestyled = async (): Promise<void> => {
    const held = heldText;
    if (held === undefined) return;
    heldText = undefined;
    if (signal.aborted) {
      deliverText(held, { voiceSkipped: 'aborted' });
      return;
    }
    let text = held.text;
    if (opts.voice) {
      try {
        const rendered = await opts.voice.render({
          text: held.text,
          userText,
          sessionId,
          signal,
        });
        if (typeof rendered === 'string' && rendered.length > 0) text = rendered;
      } catch {
        /* a port that broke its own contract still cannot cost the user the answer */
      }
    }
    deliverText(text === held.text ? held : { ...held, text });
  };

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

  // Read the transcript back from the store: after F1-05 this may have come
  // from disk, written by a previous process and possibly a different engine.
  // Then attach THIS turn's images to the just-appended (last) user message —
  // TRANSIENTLY: the store copy stays text-only, so images ride this one turn
  // to the engine without being persisted or replayed later. Attaching before
  // the loop keeps the engine seam unchanged (it just sees a user message that
  // happens to carry images).
  const turnMessages = store.getMessages(sessionId);
  if (opts.images && opts.images.length > 0) {
    for (let i = turnMessages.length - 1; i >= 0; i -= 1) {
      const m = turnMessages[i];
      if (m && m.role === 'user') {
        turnMessages[i] = { ...m, images: opts.images };
        break;
      }
    }
  }

  // Counted for the turn's closing record: "how much did this turn actually do"
  // is the first question asked of a turn that took too long or cost too much.
  let loggedToolCalls = 0;
  let loggedDenials = 0;
  let engineErrorMessage: string | undefined;

  try {
    for await (const ev of engine.run({
      model,
      messages: turnMessages,
      ...(effectiveSystem !== undefined ? { system: effectiveSystem } : {}),
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.subagents !== undefined && opts.subagents.length > 0
        ? { subagents: opts.subagents }
        : {}),
      toolSchemas,
      gate,
      executors,
      // -- ROLLING COMPACTION'S STORAGE (session-context-management §2.3) ----
      //
      // The engine that builds its own payload (AI-SDK) needs somewhere to keep
      // the summary it folds old turns into, and it must not learn what a store
      // is to get one. So the port is built HERE — the one place that holds both
      // the store and the session id — and handed down as two closures.
      //
      // The engine folds only the payload; NOTHING here writes a message. The
      // transcript stays exactly what was said (contract §6), which is what lets
      // the same session continue on the Agent SDK engine, whose own compaction
      // knows nothing about this summary.
      rollingSummary: {
        load: () => {
          try {
            return store.getSessionRollingSummary(sessionId);
          } catch {
            // A store that cannot answer reads as "nothing folded yet": the turn
            // regenerates a summary rather than failing over a cache.
            return undefined;
          }
        },
        save: (summary) => {
          try {
            store.setSessionRollingSummary(sessionId, summary);
          } catch {
            // Documented as non-throwing on the port: a failed write costs the
            // next turn one regeneration and nothing else.
          }
        },
      },
      signal,
    })) {
      // Cancellation: stop consuming the moment the turn is aborted. Breaking out
      // of the for-await calls the engine generator's return(), which unwinds the
      // engine's own loop — so an abort stops the model loop here and now rather
      // than letting it run to its iteration cap. The signal is ALSO handed to
      // the engine (and through it to the provider call), so this is a second
      // barrier, not the only one.
      if (signal.aborted) break;

      // THE ONE-SLOT DELAY (P3-M14a — see `heldText`). Two lines, in this order:
      // release whatever was held (restyled if this event proves the stream is
      // ending, verbatim otherwise), then park this event if it is itself a
      // complete assistant block. Releasing FIRST is what keeps `events`, the
      // callback and the store in their original order.
      //
      // A `partial` text event is NOT parked: it is a token delta, there is
      // nothing to restyle in a fragment, and holding one would stall the stream
      // the UI is rendering. No engine emits them today; the contract is kept.
      if (ev.kind === 'result') await releaseHeldRestyled();
      else releaseHeld();
      // NOTHING IS PARKED WITHOUT A PORT (second review, defect 3a). Holding a
      // block for a layer that does not exist buys nothing and costs a window: the
      // block sits here until the stream ends, and anything that goes wrong in
      // between — an abort, a throw — has to be careful not to lose it. With the
      // condition here, "no port = byte-for-byte the pre-M14a turn" is structural
      // rather than something each release path has to remember to preserve.
      if (opts.voice && ev.kind === 'text' && ev.role === 'assistant' && ev.partial !== true) {
        heldText = ev;
        continue;
      }

      events.push(ev);
      // Every event reaches the streaming caller, INCLUDING `harness` and
      // `rate_limit`. That is the only path either of them takes: both are
      // observational (see their docs in engine.ts), so they are forwarded for
      // display and then deliberately fall off the end of the fold below without
      // touching the store. There is no `ev.kind === 'harness'` branch there ON
      // PURPOSE — adding one would mint a `RuntimeMessage` for it, and
      // `RuntimeMessage` has a closed three-variant contract with NO system role
      // (see the note at engine.ts §"Runtime message"). A harness event is
      // transport, not conversation; persisting it would put backend-internal
      // bookkeeping into a transcript that must replay identically on an engine
      // that never emits it.
      //
      // `rate_limit` is held to the SAME RULE, and its temptation is a different
      // one: it carries numbers, so it looks like something to store and act on.
      // It is not. Storing it would put an account's billing state into a
      // transcript that must replay on an engine with no subscription at all, and
      // BRANCHING on it — ending a run early because the account is nearly out —
      // would make a run's length depend on a signal only one backend emits,
      // which is the provider-independence this seam exists to protect. It is for
      // telling the user, and for nothing else.
      opts.onEvent?.(ev);

      if (ev.kind === 'init') {
        if (ev.model) answeringModel = ev.model;
      } else if (ev.kind === 'text' && ev.role === 'assistant') {
        // WHAT REACHES HERE: every `partial` delta, and — on a turn with no naby
        // layer — complete blocks too, since those are no longer parked. Both are
        // folded by the same call the held path ends in (`deliverText` →
        // `foldAssistantText`), so the store sees one behaviour, not two.
        foldAssistantText(ev);
      } else if (ev.kind === 'thinking') {
        // Reasoning, not the reply — logged (it is the most useful thing in the
        // file when an answer is inexplicable) and, like text, only when complete.
        if (ev.partial !== true && ev.text) {
          logActivity('thinking', { ...activity, text: ev.text });
        }
      } else if (ev.kind === 'tool_request') {
        pending.set(ev.toolCallId, ev.toolName);
        loggedToolCalls += 1;
        // THE TRANSACTION. Arguments go in as the model wrote them (masked and
        // capped by the log module), because "what exactly did it pass" is the
        // question a tool call is usually being read for.
        logActivity('tool_call', {
          ...activity,
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          input: ev.input,
          ...(ev.subagent
            ? {
                subagentId: ev.subagent.agentId,
                ...(ev.subagent.agentType ? { subagentType: ev.subagent.agentType } : {}),
              }
            : {}),
        });
        store.appendMessage(sessionId, {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              toolCallId: ev.toolCallId,
              toolName: ev.toolName,
              input: ev.input,
              // WHO made the call, when the backend attributed it to a subagent.
              // Persisted with the call and not derived later, because the events
              // that describe a subagent's LIFE (`harness`) are observational and
              // never stored — so after a reload the call itself is the only thing
              // left that can say which delegated run it belonged to. Providers
              // map tool calls field by field, so an extra descriptive field never
              // reaches a provider payload.
              ...(ev.subagent ? { subagent: ev.subagent } : {}),
            },
          ],
        });
      } else if (ev.kind === 'gate_result') {
        // EVERY DECISION, allow as well as deny. A log that only recorded refusals
        // would answer "what was blocked" and not "what was permitted", and the
        // second is the question asked after something unwanted happened.
        if (ev.decision === 'deny') loggedDenials += 1;
        logActivity('gate_decision', {
          ...activity,
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          decision: ev.decision,
          ...(ev.reason !== undefined ? { reason: ev.reason } : {}),
        });
        if (ev.decision === 'deny') {
          closeCall(ev.toolCallId, {
            content: `Denied by policy gate: ${ev.reason ?? 'no reason given'}`,
            isError: true,
          });
        }
      } else if (ev.kind === 'tool_result') {
        logActivity('tool_result', {
          ...activity,
          toolCallId: ev.toolCallId,
          toolName: ev.toolName,
          isError: ev.isError,
          output: ev.output.content,
        });
        closeCall(ev.toolCallId, ev.output);
      } else if (ev.kind === 'error') {
        // Kept for the closing record rather than logged on its own line: an
        // engine error is how the turn ENDED, and one line per turn saying how it
        // ended is easier to read than two that have to be correlated.
        engineErrorMessage = ev.message;
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
          // The same row, in the file, so a support bundle that is only the log
          // directory still answers "what did this cost".
          logActivity('usage', {
            ...activity,
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
  } catch (error) {
    // NOTHING HELD MAY BE LOST, even on the failing path: the engine emitted that
    // block, so it belongs in the transcript exactly as it would have without the
    // delay. VERBATIM and synchronously — a turn that is already failing does not
    // stop to buy a style correction, and awaiting a model call inside a catch
    // before re-throwing would delay the error the caller is waiting for.
    //
    // A turn that failed BECAUSE it was stopped takes the abort path inside
    // `deliverText`: the block goes to the activity log and to neither sink, so the
    // screen and the transcript still agree.
    releaseHeld();
    // A THROWN turn is logged and RE-THROWN, unchanged. The log observes; it does
    // not handle. Swallowing here would turn a failing turn into a silent one for
    // every caller above.
    logActivity('turn_failed', {
      ...activity,
      durationMs: Date.now() - activityStartedAt,
      toolCalls: loggedToolCalls,
      denials: loggedDenials,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  // THE STREAM IS OVER, so a block still held IS this step's last one (§4.1) —
  // for a backend that ends without a `result`, and for the abort that breaks out
  // of the loop above. Restyled or not, it is folded before anything else closes
  // the turn out, so the transcript order is unchanged. A held block released by
  // the `result` edge leaves this a no-op.
  await releaseHeldRestyled();

  // Nothing may be left half-written: an unclosed call would be an orphan on
  // the next replay, which is the exact failure Bug B was about.
  for (const toolCallId of [...pending.keys()]) {
    closeCall(toolCallId, {
      content: 'Tool call did not complete.',
      isError: true,
    });
  }

  logActivity('turn_completed', {
    ...activity,
    engine: opts.engineId ?? 'ai-sdk',
    model: answeringModel,
    durationMs: Date.now() - activityStartedAt,
    events: events.length,
    toolCalls: loggedToolCalls,
    denials: loggedDenials,
    aborted: signal.aborted,
    ...(engineErrorMessage !== undefined ? { error: engineErrorMessage } : {}),
  });

  return events;
}
