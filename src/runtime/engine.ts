// src/runtime/engine.ts
//
// The swappable engine seam. Everything above the engine depends ONLY on the
// types in this file — nothing here names a provider SDK. Two backends
// implement `Engine` (dev: ClaudeAgentSdkEngine, test: MockEngine); the runtime
// passes the SAME provider-independent gate, executors, messages, and tool
// schemas to whichever engine runs.
//
// Contract source: ref-docs/specs/interface/phase-1-contracts.md §2, §3, §6.

// ---------------------------------------------------------------------------
// Tool + message shapes (contract §2, §6)
// ---------------------------------------------------------------------------

/**
 * WHO issued a tool call, when the backend ran it inside a SUBAGENT rather than
 * on the main thread.
 *
 * This is ATTRIBUTION the backend reports about itself — never a guess. The
 * Claude Agent SDK gives it on the pre-execution hook (`agent_id` / `agent_type`
 * on every hook input; both are absent on the main thread, which is exactly what
 * makes "absent = top level" sound). An engine with no notion of subagents (the
 * AI-SDK one) simply never sets it.
 *
 * It exists so a consumer can show a delegated run as its OWN block instead of
 * folding a subagent's twenty calls into the turn's generic tool-call batch. It
 * is DESCRIPTIVE ONLY: nothing may branch on it to decide whether a call is
 * allowed — the gate's inputs are the tool name and its input, and adding "but
 * it was a subagent" to that decision would make authorization depend on
 * backend-internal bookkeeping the other engine cannot report.
 */
export type SubagentAttribution = {
  /** The backend's id for the running subagent. Opaque, closed-form (an id, not
   *  free text) — safe to key UI state on and to persist. */
  agentId: string;
  /** The subagent's TYPE, e.g. `general-purpose`. Free-form in principle, so
   *  engines pass it through only when it looks like a label (see the engine's
   *  sanitizer) — it is rendered. */
  agentType?: string;
  /** The tool call that SPAWNED this subagent (the `Task` call on the main
   *  thread), when the engine can correlate the two. Lets a consumer fold the
   *  parent call and its children into one block; absent is not an error, and a
   *  consumer must still group by `agentId` alone. */
  parentToolCallId?: string;
};

/** A single tool invocation the engine surfaces to the runtime. */
export type ToolCall = {
  toolCallId: string;
  toolName: string; // BARE name (mcp__server__tool already normalized off)
  input: unknown;
  /** Set only when the BACKEND says this call ran inside a subagent. Carried on
   *  the call (not looked up later) so it survives persistence and replay, and
   *  so a consumer never has to infer parentage from timing. */
  subagent?: SubagentAttribution;
};

/** What an executor returns. Provider-independent. */
export type ToolOutput = {
  content: string; // text the model sees
  isError?: boolean;
  data?: unknown; // structured payload for our own use (never provider-specific)
};

/** Context handed to an executor. The session/memory binding is closed over by
 * the runtime when it builds the executor map, so the engine need not know the
 * session id or which provider is selected. */
export type ExecCtx = {
  toolCall: ToolCall;
  signal: AbortSignal;
};

/** Runtime-owned tool executor, keyed by bare tool name in EngineRunInput. */
export type Executor = (input: unknown, ctx: ExecCtx) => Promise<ToolOutput>;

// ---------------------------------------------------------------------------
// The gate (contract §3) — defined once in the runtime, attached per engine.
// ---------------------------------------------------------------------------

export type GateDecision =
  | { behavior: 'allow'; input?: unknown } // input rewrite allowed
  | { behavior: 'deny'; reason: string };

export type Gate = (call: ToolCall) => Promise<GateDecision>;

// ---------------------------------------------------------------------------
// Tool schemas — JSON-schema definitions, NO execute (contract §2).
// The engine surfaces each call; the runtime runs the gate then the executor.
// ---------------------------------------------------------------------------

/** A minimal JSON-Schema subset — enough for the spike's tools and, crucially,
 * engine-agnostic (no zod, no provider surface). Each engine converts this to
 * whatever its SDK needs. */
export type JsonSchema = {
  type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
};

export type ToolSchema = {
  name: string;
  description: string;
  parameters: JsonSchema; // JSON-schema; deliberately carries NO execute
};

// ---------------------------------------------------------------------------
// Model selection — the ONLY key-dependent input (contract §2, §4).
// ---------------------------------------------------------------------------

export type ModelSelection = {
  providerId: string;
  /** model id / deployment; optional for engines that use a local default. */
  model?: string;
};

// ---------------------------------------------------------------------------
// Runtime message — provider-independent internal shape (contract §6).
// ---------------------------------------------------------------------------

// NOTE on the two shapes below (both are deliberate contract decisions):
//
//   * there is NO `role:'system'`. A system prompt is NOT a message — it rides
//     on `EngineRunInput.system` and each engine forwards it through its
//     provider's dedicated slot. `ai@7` rejects `role:'system'` inside
//     `messages` outright ("System messages are not allowed in the prompt or
//     messages fields. Use the instructions option instead."), and modelling it
//     as a message also made "which system prompt wins" ambiguous on replay.
//
//   * a tool result carries its `toolName`. Without it a persisted tool result
//     cannot be replayed: the originating tool call may have been written by a
//     previous turn or by a DIFFERENT engine (the provider-switch case), so the
//     name cannot be recovered from the history being mapped, and providers
//     reject an orphan tool result. Carrying the name makes tool results
//     self-describing and round-trippable across a provider switch.

/** A base64 image attached to a user turn (multimodal input). `data` is raw
 *  base64 (no `data:` prefix); `media_type` is an image MIME type. Carried on the
 *  user RuntimeMessage so both engines can build a provider-native image block.
 *  Transient by default — runTurn attaches this turn's images to the just-appended
 *  user message WITHOUT persisting them, so a 5 MB paste is not re-sent every turn
 *  nor stored on disk (see session.ts). */
export type RuntimeImage = {
  /** e.g. 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'. */
  media_type: string;
  /** base64, no `data:` prefix. */
  data: string;
};

/**
 * How the TURN that produced a row went, measured by whoever ran it.
 *
 * Both numbers come from ONE clock reading at the turn's end, so they can never
 * disagree with each other. `durationMs` is authoritative: the client must not
 * recompute it from timestamps, because the browser's clock and the runner's are
 * different clocks and the stream can arrive late.
 *
 * Written onto the LAST assistant row of a turn (see Store.stampTurnEnd), which
 * is the row the transcript view renders the turn's closing line under. Optional
 * and additive: every row written before this existed simply lacks it, and a
 * reader that finds it absent shows nothing rather than a zero.
 */
export type TurnStats = {
  /** Wall-clock length of the turn, in ms. */
  durationMs: number;
  /** When the turn ENDED (epoch ms) — not when its bubble was created. */
  endedAt: number;
};

export type RuntimeMessage =
  | {
      role: 'user' | 'assistant';
      content: string;
      toolCalls?: ToolCall[];
      /** Images on a USER turn (multimodal). Absent on assistant/tool. */
      images?: RuntimeImage[];
      /** ASSISTANT rows only, and only the last one of a turn. Descriptive: no
       *  provider payload is built from it (providers map role/content/toolCalls
       *  field by field), so it round-trips as inert JSON. */
      turn?: TurnStats;
    }
  | {
      role: 'tool';
      toolCallId: string;
      toolName: string; // BARE name — see the note above
      output: ToolOutput;
    };

// ---------------------------------------------------------------------------
// Engine events — the narrowed projection uniform across both engines
// (contract §1.4, normalized at the engine boundary). No provider/key leaks.
// ---------------------------------------------------------------------------

/**
 * Token accounting, NORMALIZED at the engine boundary.
 *
 * "Turn accounting" is one of the seven divergence points the engine boundary
 * exists to flatten (design §3.4), and this is one of them in its sharpest
 * form — the two engines' sources disagree about what "input tokens" MEANS:
 *
 *   * `ai` v7 reports `inputTokens.total` as the TOTAL prompt size, with
 *     `cacheRead` as a SUBSET of it.
 *   * the Agent SDK passes Anthropic's raw shape through, where `input_tokens`
 *     counts only the NON-cached tokens and `cache_read_input_tokens` /
 *     `cache_creation_input_tokens` are DISJOINT from it.
 *
 * Left unnormalized, the same conversation reports `input=4, cached=9435` on
 * one engine and `input=9439, cached=9435` on the other — and any cost
 * computed from the first is wrong by three orders of magnitude. So the
 * contract is fixed here and each engine converts INTO it:
 *
 *   inputTokens       TOTAL prompt tokens, INCLUDING anything served from cache.
 *   cachedInputTokens the SUBSET of `inputTokens` that was a cache read.
 *   outputTokens      generated tokens.
 *
 * Consumers may therefore rely on `cachedInputTokens <= inputTokens`, which is
 * what makes "bill the cached part at the cached rate" (runtime/pricing.ts) a
 * correct subtraction rather than a double count.
 */
export type Usage = {
  /** TOTAL input tokens, including cached ones. */
  inputTokens?: number;
  outputTokens?: number;
  /** The subset of `inputTokens` that was read from cache. */
  cachedInputTokens?: number;
};

/**
 * The IDENTITY half of a harness event about a subagent / background task.
 *
 * Every field is closed-form (an id, an enum, a label-shaped type name) — the
 * free text a task carries (`description`, `summary`, a model-authored prompt)
 * is deliberately NOT here, for the same reason `detail` never echoes a raw
 * body: it is arbitrary content from whatever project is open and it is
 * rendered.
 *
 * `id` is the backend's task id. For a `Task`-tool subagent it is ALSO the
 * subagent's agent id — the Claude Agent SDK registers the task under the
 * agent's own id — which is what lets a consumer join this lifecycle to the
 * tool calls attributed to that agent (`SubagentAttribution.agentId`). A
 * consumer must treat a non-matching id as "no lifecycle known" rather than
 * guessing.
 */
export type HarnessTask = {
  id: string;
  /** e.g. `general-purpose`. Absent for non-subagent tasks (a shell task). */
  agentType?: string;
  /**
   * WHAT KIND OF TASK IT IS, as the backend's own closed-form discriminant:
   * `local_bash` (a BACKGROUND SHELL JOB — `Bash` with `run_in_background`, or a
   * foreground one that was later backgrounded), `local_agent` (a `Task`-tool
   * subagent), `local_workflow`, `monitor_mcp`, … (Claude Agent SDK
   * `SDKTaskStartedMessage.task_type`).
   *
   * IT IS THE ONLY THING THAT TELLS THE TWO APART. Both kinds arrive on the same
   * four subtypes with the same fields, and a shell job carries no
   * `subagent_type` — so without this a consumer either files a background
   * `npm run deploy` under a block labelled "Subagent", or (worse) shows nothing
   * at all and the user cannot tell that a job is still running. A label, not
   * prose: the free text a shell task carries (its command line, its
   * description) is NOT here, for the same reason `detail` never echoes a body.
   *
   * REPORTED ON THE OPENING EDGE ONLY. `task_started` carries it; `task_progress`
   * / `task_updated` / `task_notification` do not, so a consumer keeps the kind
   * it learned when the run started rather than re-deriving it from a later edge.
   */
  taskType?: string;
  /** The tool call that spawned it, when the backend reports one. */
  toolCallId?: string;
  /** Which edge of the lifecycle this event is. */
  phase: 'started' | 'progress' | 'ended';
  /** Terminal status, on `phase:'ended'`. */
  status?: 'completed' | 'failed' | 'stopped';
  /**
   * WHEN THE RUNTIME SAW THIS EDGE (epoch ms) — so a consumer can say how long a
   * background job has been running instead of only that it started.
   *
   * Stamped HERE, at the seam, and not by the UI on arrival: the shell replays a
   * run's whole event buffer into the reducer on every reconnect, and a
   * client-side clock would restart the elapsed count from zero each time — a
   * ten-minute deploy would keep reading "3s". The backend reports no start
   * timestamp of its own (`task_started` has no time field), so the moment the
   * event crossed this seam is the earliest honest one we have.
   */
  observedAt?: number;
};

/**
 * How close an account is to a usage limit (specs/claude-multi-account.md §3.4).
 *
 * A CLOSED set, unlike the window's name — these three are what the display
 * BRANCHES on (silence / amber / red), so a fourth value arriving must fail to
 * compile here rather than fall through to the quiet case and hide a refusal.
 */
export type RateLimitStatus = 'allowed' | 'allowed_warning' | 'rejected';

export type EngineEvent =
  | { kind: 'init'; providerId: string; model: string }
  | {
      kind: 'text';
      role: 'assistant' | 'user';
      text: string;
      partial?: boolean;
      /**
       * WHOSE WORDS THESE ARE — absent for the main thread, set for a subagent.
       *
       * The value is the id of the `Task` call that spawned the subagent
       * (`parent_tool_use_id`), which is the only handle both sides already
       * share: the tool calls a subagent makes carry it, and the transcript's
       * subagent block is keyed on it.
       *
       * WHY THIS FIELD HAD TO EXIST. Without it a subagent's answer is
       * indistinguishable from the main agent's, and the shell appended both to
       * the same bubble — so a delegated run's narration ("I'll start by
       * examining…", "I've been blocked, so I'm stopping here") appeared in the
       * conversation as if naby had said it. The user could not tell which
       * sentences were the answer to their question. The engine already knew the
       * difference and was spending it only on the token gauge.
       */
      agentToolCallId?: string;
    }
  /**
   * The model's REASONING, not its reply.
   *
   * Kept a separate kind rather than folded into `text` on purpose: a consumer
   * that renders thinking as the answer puts working-out into the transcript as
   * if it were the response, which is worse than not showing it. A distinct kind
   * forces every consumer to decide what to do with it — the shell renders it in
   * a collapsed block, and the transcript copy never includes it.
   */
  | { kind: 'thinking'; text: string; partial?: boolean }
  | {
      kind: 'tool_request';
      toolCallId: string;
      toolName: string;
      input: unknown;
      /** Present only when the backend attributes this call to a subagent it is
       *  running (see SubagentAttribution). Absent = the main thread. */
      subagent?: SubagentAttribution;
    }
  | {
      kind: 'gate_result';
      toolCallId: string;
      toolName: string;
      decision: 'allow' | 'deny';
      reason?: string;
    }
  | {
      kind: 'tool_result';
      toolCallId: string;
      toolName: string;
      isError: boolean;
      output: ToolOutput;
    }
  | {
      kind: 'result';
      ok: boolean;
      usage?: Usage;
      costUsd?: number;
      /**
       * HOW FULL THE WINDOW IS — the LAST step's reported input tokens (cache
       * reads included), i.e. what the model actually received on its final call
       * of this turn (specs/session-context-management.md §2.1).
       *
       * A SEPARATE FIELD FROM `usage`, and it must stay separate. `usage.inputTokens`
       * is the turn's TOTAL across steps: a four-step turn on a 30k conversation
       * reports ~120k there, which is not a window occupancy and reads as one. This
       * field is a single step's prompt size, so it is directly comparable to
       * `contextWindowFor(engine, model)`.
       *
       * UNDEFINED WHEN THE BACKEND REPORTS NO PER-STEP USAGE. Consumers must hide
       * the gauge rather than substitute the summed figure — the spec's rule is
       * that a wrong number is worse than no number.
       */
      contextTokens?: number;
      /**
       * WHICH MODEL ACTUALLY ANSWERED — the concrete id the provider ran, as the
       * provider reported it, NOT the id we asked for.
       *
       * It exists because the two differ exactly when the denominator matters. A
       * turn configured as `default` (the Agent SDK's own "let Claude pick" row)
       * or as an alias (`opus`) names no window at all, so the registry answered
       * `undefined` and the gauge lost its percentage on the app's most common
       * path. The run itself always knows: the Agent SDK's init message and every
       * assistant message carry the resolved id, and `ai@7` reports the resolved
       * id on the step response.
       *
       * Undefined only when the backend reported nothing at all (a turn that
       * failed before its first step). Consumers fall back to the configured id.
       */
      contextModel?: string;
      /**
       * The betas the RUN negotiated, as the backend reported them. Currently one
       * thing depends on it: `context-1m-2025-08-07` is how a Claude turn on the
       * long-context tier is distinguished from an ordinary 200k one — a
       * difference of five times the denominator that nothing in our own
       * configuration can predict, because the plan decides it.
       */
      contextBetas?: readonly string[];
      /**
       * THE WINDOW SIZE THE BACKEND ITSELF REPORTED for the model that produced
       * the reading above (the Agent SDK's `modelUsage[model].contextWindow` on
       * its result message).
       *
       * It outranks everything the two fields above feed, because it is a
       * measurement rather than an inference. Both of those signals are
       * conditional on how the tier is ANNOUNCED, and the announcement moves: a
       * live 0.3.215 run served `claude-fable-5` on a 1,000,000-token window with
       * no `context-1m-2025-08-07` beta and no `[1m]` marker on the id — 1M had
       * gone GA — and the gauge read `64% (127k/200k)` on a window that was five
       * times larger. A number the run states about itself cannot go stale that
       * way.
       *
       * Absent when the backend reported none (every AI-SDK turn, and an Agent
       * SDK turn whose result names no usable entry). Consumers then fall back to
       * `contextWindowFor(contextModel, { betas: contextBetas })` exactly as
       * before, so this field only ever adds an answer.
       */
      contextWindow?: number;
    }
  /**
   * HOW MUCH OF THE SUBSCRIPTION IS LEFT — the backend's own statement about the
   * account's usage window (specs/claude-multi-account.md §3.3, §4).
   *
   * A SIBLING OF `result`, not a field on it, because it does not belong to a
   * turn. The backend reports it whenever the limit information CHANGES, which
   * can be mid-turn, more than once, or never — a turn on an API key, Bedrock or
   * Vertex produces none at all, since there is no subscription to be limited.
   * Folding it into `result` would have forced a turn boundary onto a fact that
   * has none, and would have thrown away every reading but the last.
   *
   * OBSERVATIONAL, exactly like `harness` — see the contract in that doc below.
   * It is not persisted, it mints no `RuntimeMessage`, and nothing downstream may
   * branch on it. In particular the autonomy loop must NOT read it: "stop because
   * the account is nearly out" is a policy decision, and taking it here would
   * silently make a run's length depend on backend billing state that the other
   * engine never reports. The one thing it is for is telling the user.
   *
   * DECLARED FLAT, on purpose. The SDK's own type is not re-exported and not
   * referenced: this seam is what makes a provider swappable (contract §2), and a
   * type imported from one vendor's package would put that vendor in the
   * definition of every consumer. Any engine that learns of a usage window can
   * fill these fields; the ones it cannot answer stay absent.
   */
  | {
      /**
       * The three states the backend distinguishes. `allowed_warning` is the one
       * this whole path exists for — it is the only advance notice there is.
       * Always present: a reading with no status says nothing at all, so an
       * engine that cannot determine one emits no event rather than a default.
       */
      kind: 'rate_limit';
      status: RateLimitStatus;
      /**
       * WHEN THE WINDOW ROLLS OVER — **UNIX time in SECONDS**, not milliseconds.
       *
       * THE UNIT IS PART OF THE CONTRACT and is stated here because it is the one
       * thing about this event that can be wrong without looking wrong: a seconds
       * value read as milliseconds puts the reset in 1970 (the countdown then
       * shows nothing at all), and a milliseconds value read as seconds puts it
       * roughly fifty thousand years out. Neither throws.
       *
       * Seconds because that is what the backend sends (an observed reading:
       * `1786426200` → 2026-08-11T05:30Z) and because a conversion is a second
       * place for the unit to be lost. Consumers multiply by 1000 to compare
       * against `Date.now()`.
       *
       * Optional: the backend omits it on some readings, and an absent reset is
       * rendered as no countdown rather than as zero.
       */
      resetsAt?: number;
      /**
       * WHICH WINDOW is the one currently binding — `five_hour`, `seven_day`,
       * `seven_day_opus`, … as the backend names it.
       *
       * An open string rather than a closed union, deliberately: the set is the
       * vendor's plan catalog and it grows whenever a plan does. A closed union
       * would make a new plan fail to compile here — at the seam, in code that
       * only passes the label through — while the label itself is perfectly
       * renderable. Consumers must treat it as a label to display, never as a
       * value to branch on.
       */
      limitType?: string;
      /**
       * HOW FULL THE WINDOW IS, as the backend reports it — RAW and UNNORMALIZED.
       *
       * ⚠️ THE SCALE IS UNVERIFIED. The SDK documents none, and it did not appear
       * at all in the readings we have observed. Nothing here assumes a fraction
       * or a percentage; the one place that turns it into a number for a human is
       * a single normalization function in the shell, and the rule that survives
       * either answer is `undefined` → draw nothing.
       */
      utilization?: number;
      /** The same three states, for the paid-overage allowance when the account
       *  has one. Absent on accounts that do not. */
      overageStatus?: RateLimitStatus;
      /** Reset for the OVERAGE window. Same unit as `resetsAt` — UNIX SECONDS. */
      overageResetsAt?: number;
      /** Why overage is unavailable (`org_level_disabled`, `out_of_credits`, …).
       *  An open string for the same reason as `limitType`. */
      overageDisabledReason?: string;
      /** True while the account is spending overage rather than its included
       *  allowance — the one field here that changes what the usage COSTS. */
      isUsingOverage?: boolean;
      /** The threshold the backend says was just crossed, when it names one. */
      surpassedThreshold?: number;
    }
  | { kind: 'error'; message: string; code?: string }
  /**
   * A transport-level observation from the engine's own harness — something the
   * BACKEND did that is not part of the conversation: a background task
   * starting or reporting back, a context compaction boundary, hook output the
   * provider injected into its own loop.
   *
   * OBSERVATIONAL ONLY. This is the whole contract, and it is load-bearing in
   * two directions:
   *
   *   * it must NEVER influence the model loop. Nothing downstream may branch
   *     on a harness event to decide what to send, whether to continue, or what
   *     the model sees next. The transcript we replay (contract §6) is built
   *     from `text` / `tool_request` / `tool_result` alone, and adding a
   *     harness event to it would make replay depend on backend-internal
   *     bookkeeping that the OTHER engine does not emit — i.e. it would break
   *     the provider-independence the seam exists to guarantee.
   *   * it must NEVER influence the gate. The gate's inputs are ToolCalls and
   *     nothing else (contract §3); a harness event is not a request to do
   *     anything, so there is nothing here to authorize.
   *
   * Consequently it does not become a `RuntimeMessage` and is not persisted —
   * `runTurn` deliberately has no store branch for it. It exists so the UI can
   * show a muted "something happened in the harness" line instead of the
   * silence that made the wrong-cwd bug (see `EngineRunInput.cwd`) invisible
   * for as long as it was.
   *
   * `subtype` is a SHORT, SAFE label (e.g. `system/compact_boundary`), never a
   * raw message body: hook output can contain arbitrary content from whatever
   * project is open, and this string is rendered in the UI. `detail` is
   * likewise a curated summary, not a dump.
   *
   * `task` is the same rule applied to IDENTITY rather than prose: when the
   * event is a subagent/background-task LIFECYCLE edge, the closed-form fields
   * that say WHICH task it is travel structurally instead of being flattened
   * into `detail`. Without it a consumer cannot tell four parallel subagents
   * apart — every one of them reports `agent=general-purpose` — so four blocks
   * collapse into one. Still observational: it changes nothing about the loop.
   */
  | { kind: 'harness'; subtype: string; detail?: string; task?: HarnessTask };

// ---------------------------------------------------------------------------
// The Engine interface (contract §2). The rest of the app depends only on this.
// ---------------------------------------------------------------------------

/** A subagent the model may delegate to for this turn (Phase 2.5 M4).
 *  Engine-neutral: the Claude Agent SDK engine maps it to a native `agents`
 *  definition (spawned via the gated `Task` tool); the AI-SDK engine has no
 *  native subagents and ignores it. `toolRefs`, when set, RESTRICTS the subagent
 *  to those tools; omitted = inherit the turn's tools. */
export type SubagentSpec = {
  name: string;
  description?: string;
  systemPrompt: string;
  model?: string;
  toolRefs?: string[];
};

export type EngineRunInput = {
  /** provider + model id/deployment — the ONLY key-dependent input. */
  model: ModelSelection;
  /** conversation so far, from our provider-independent store. */
  messages: RuntimeMessage[];
  /** Subagents the model may delegate to (Phase 2.5 M4). Engine-specific: the
   *  Claude Agent SDK maps these to native agents; other engines ignore them. */
  subagents?: SubagentSpec[];
  /** System prompt / instructions for the turn. NOT a message — each engine
   * forwards this through its provider's dedicated slot (`ai@7`'s `system`
   * option, the Agent SDK's `systemPrompt`). Provider-independent: the same
   * string is passed whichever engine runs. */
  system?: string;
  /** JSON-schema tool definitions; NO execute — the engine surfaces, we run. */
  toolSchemas: ToolSchema[];
  /** runtime-owned gate; the engine attaches it at its pre-execution point. */
  gate: Gate;
  /** runtime-owned executors, keyed by BARE tool name. */
  executors: Record<string, Executor>;
  /**
   * The directory the turn is ABOUT — the project the user actually opened.
   *
   * WHY THIS EXISTS (it fixes a confirmed correctness+safety bug, not a nicety)
   * -------------------------------------------------------------------------
   * An engine whose backend touches a filesystem needs to be TOLD where it is.
   * Left unset, a backend inherits the host process's cwd — which for us is the
   * Electron main process, i.e. NABY'S OWN SOURCE CHECKOUT, never the opened
   * project. Meanwhile the shell adapter builds a system prompt that states
   * `Working directory: <the opened project>`. The two disagreed silently, and
   * the disagreement was invisible because nothing ever printed either one:
   *
   *   * the MODEL believed it was in the opened project (the prompt said so),
   *   * the BACKEND was sitting in naby's source tree,
   *   * so the backend loaded NABY's `.claude/` harness — its CLAUDE.md, its
   *     hooks — instead of the opened project's. Observed in the wild: naby's
   *     own dotclaude session counter ("Session #94") was injected into a chat
   *     about an entirely different project. Confirmed against the databases:
   *     naby's `.claude/db/context.db` holds the 97 sessions those numbers came
   *     from; the opened project's holds 5.
   *
   * The safety half is worse than the confusion half: any file-touching tool
   * resolving a relative path would have targeted the WRONG REPOSITORY.
   *
   * So the directory travels EXPLICITLY, on its own field, from the composition
   * root that actually knows it (the shell adapter, from `RunCtx.cwd`) down to
   * the engine — rather than being inherited from ambient process state that
   * nothing in this contract controls.
   *
   * OPTIONAL, and meaningfully so. It is `undefined` when there is no directory
   * to speak of — a headless spike, a scheduled task, `RunCtx.cwd` being the
   * empty string. Engines must treat absent as "say nothing about a directory"
   * and MUST NOT substitute `process.cwd()`, which is exactly the inheritance
   * this field exists to stop. Engines with no filesystem notion at all
   * (AiSdkEngine) correctly ignore it.
   */
  cwd?: string;
  /**
   * WHERE THIS SESSION'S ROLLING SUMMARY LIVES (specs/session-context-management
   * §2.3). Supplied by the turn runner, which owns the store; an engine that folds
   * old turns into a summary needs somewhere to keep it across turns, and it must
   * not learn what a store is to get one.
   *
   * OPTIONAL, and its absence is a full answer: no port = fold nothing and keep
   * nothing, which is byte-for-byte the pre-compaction payload. Engines with no
   * payload of their own to size (the Claude Agent SDK compacts itself) ignore it.
   */
  rollingSummary?: RollingSummaryPort;
  signal: AbortSignal;
};

/**
 * The session-scoped rolling summary: the text that stands in for the turns an
 * engine folded out of its outgoing payload, plus HOW MANY leading messages it
 * covers.
 *
 * `foldedCount` is what makes reuse safe. A summary is only valid for the exact
 * prefix it was written from, so a fold of the same range reuses it verbatim and a
 * LARGER fold extends it — and a stored count that no longer matches is simply
 * regenerated rather than silently applied to a range it never read.
 *
 * NOTHING HERE TOUCHES THE TRANSCRIPT. The stored messages are never rewritten;
 * this is a description of the payload, kept beside the session (contract §6).
 */
export type RollingSummaryPort = {
  /** The stored summary, or undefined when this session has never folded. */
  load(): RollingSummary | undefined;
  /** Persist (or replace) the summary. Must not throw — a failed write costs the
   *  next turn a regeneration, and nothing else. */
  save(summary: RollingSummary): void;
};

export type RollingSummary = {
  /** The compressed stand-in for the folded turns. */
  text: string;
  /** How many leading messages of the session it covers. */
  foldedCount: number;
};

export interface Engine {
  /** The engine owns the model loop and calls back into the injected gate +
   * executors, normalizing its native events into EngineEvent. */
  run(input: EngineRunInput): AsyncIterable<EngineEvent>;
}

// ---------------------------------------------------------------------------
// The naby layer's port (P3-M14a — specs/naby-voice-layer.md §8)
// ---------------------------------------------------------------------------

/** One block of assistant prose, offered for restyling. */
export type VoiceRenderRequest = {
  /** The text as the model wrote it — the LAST assistant block of this step. */
  readonly text: string;
  /** The user's own words for this turn, which is what "the language the user
   *  wrote in" and "the way this person writes" are measured against. */
  readonly userText: string;
  readonly sessionId: string;
  /** The TURN's abort signal, passed straight through. A user who pressed stop is
   *  not waiting for a style correction (§6): an implementation must abandon its
   *  call and answer with `req.text`. */
  readonly signal: AbortSignal;
};

/**
 * THE NABY LAYER, as a port: the seam through which the turn runner offers its
 * last assistant block for restyling before the user sees it.
 *
 * OPTIONAL BY CONSTRUCTION. `runTurn` without one is byte-for-byte the turn it
 * ran before this port existed — no deferral is observable, no call is made,
 * nothing is logged. That is what keeps every spike and every headless caller
 * unchanged, and it is the invariant the spike checks first.
 *
 * IT LIVES ABOVE THE ENGINE, NOT INSIDE IT. Restyling is provider-independent —
 * the same rules apply whichever backend answered — and putting it here means the
 * implementation can drive a DIFFERENT, cheaper backend than the turn did without
 * the turn's engine knowing anything about it.
 */
export interface VoicePort {
  /**
   * Return the text to show the user.
   *
   * MUST NOT THROW AND MUST NOT RETURN EMPTY. Every failure — no backend, a
   * timeout, a provider error, a rewrite that failed verification, an aborted turn
   * — returns `req.text` unchanged. This layer is not allowed to be the reason an
   * answer does not arrive (§6: "답을 막을 수 없는 층"), so the contract is stated
   * on the port rather than left to each implementation's judgement.
   */
  render(req: VoiceRenderRequest): Promise<string>;
}
