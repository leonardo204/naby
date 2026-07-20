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

/** A single tool invocation the engine surfaces to the runtime. */
export type ToolCall = {
  toolCallId: string;
  toolName: string; // BARE name (mcp__server__tool already normalized off)
  input: unknown;
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

export type RuntimeMessage =
  | {
      role: 'user' | 'assistant';
      content: string;
      toolCalls?: ToolCall[];
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

export type EngineEvent =
  | { kind: 'init'; providerId: string; model: string }
  | {
      kind: 'text';
      role: 'assistant' | 'user';
      text: string;
      partial?: boolean;
    }
  | { kind: 'tool_request'; toolCallId: string; toolName: string; input: unknown }
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
  | { kind: 'result'; ok: boolean; usage?: Usage; costUsd?: number }
  | { kind: 'error'; message: string; code?: string };

// ---------------------------------------------------------------------------
// The Engine interface (contract §2). The rest of the app depends only on this.
// ---------------------------------------------------------------------------

export type EngineRunInput = {
  /** provider + model id/deployment — the ONLY key-dependent input. */
  model: ModelSelection;
  /** conversation so far, from our provider-independent store. */
  messages: RuntimeMessage[];
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
  signal: AbortSignal;
};

export interface Engine {
  /** The engine owns the model loop and calls back into the injected gate +
   * executors, normalizing its native events into EngineEvent. */
  run(input: EngineRunInput): AsyncIterable<EngineEvent>;
}
