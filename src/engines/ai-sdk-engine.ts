// src/engines/ai-sdk-engine.ts
//
// AiSdkEngine — the PRODUCTION backend (contract §2.1). Wraps `ai` v7.
//
// THE LOAD-BEARING PROPERTY: **we own the loop and the gate; the SDK must never
// auto-execute a tool.** Each piece below maps to a gate invariant (§3):
//
//   * tools are defined EXECUTE-LESS — `tool({ inputSchema })` with no
//     `execute`. An execute-less tool is returned to the caller as a tool call;
//     there is no code path by which the SDK can run it. (§3 invariant 3)
//   * `generateText` is called ONE STEP AT A TIME. We never pass a multi-step
//     `stopWhen`; ai v7's default is `stepCountIs(1)`, so control returns to us
//     after every model turn and the SDK cannot continue on its own.
//   * between the surfaced call and the executor there is ONLY our gate. On
//     allow we run `executors[name]` on the gate-approved (possibly rewritten)
//     input — the rewrite is applied in the wrapper, so no window exists in
//     which the input can change after approval. (§3 invariant 2)
//   * on deny the executor is NEVER invoked and a denial tool result is fed
//     back to the model. (§3 invariant 1)
//   * we ASSERT the SDK executed nothing: after each step `result.toolResults`
//     must be empty. A non-empty value would mean something auto-executed
//     behind the gate, so we abort the turn with GATE_BYPASSED rather than
//     continue ungated. (§3 invariant 4 — refuse rather than run ungated)
//   * an ITERATION CAP bounds the loop; exceeding it is a clean, surfaced error.
//
// The key never reaches this file. The engine holds a `resolveModel` function
// (see src/providers/registry.ts) which is the only thing that reads a
// credential; the engine receives an already-constructed model.

import {
  generateText,
  jsonSchema,
  tool,
  type ModelMessage,
  type ToolResultPart,
  type ToolSet,
} from 'ai';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import type {
  Engine,
  EngineEvent,
  EngineRunInput,
  JsonSchema,
  ModelSelection,
  RuntimeMessage,
  ToolCall,
  ToolOutput,
  Usage,
} from '../runtime/engine.js';

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** Hands back a provider model for a selection. The ONLY key-touching seam —
 * implemented by src/providers/registry.ts (makeModelResolver). */
export type ModelResolver = (
  selection: ModelSelection,
) => LanguageModelV4 | Promise<LanguageModelV4>;

export type AiSdkEngineOptions = {
  resolveModel: ModelResolver;
  /** Loop bound (contract §2.1 requires the loop be bounded). Default 16. */
  maxSteps?: number;
  /** Engine-level DEFAULT system prompt, used when a run does not supply its
   * own `EngineRunInput.system`. The per-run field wins. */
  system?: string;
};

/** Diagnostics the spike asserts on. Never contains a key or provider secret. */
export type AiSdkEngineDiagnostics = {
  /** model steps actually taken. */
  steps: number;
  /** per step: how many tool results the SDK produced ITSELF. Must be all 0 —
   * anything else means a tool auto-executed behind our gate. */
  sdkToolResultCounts: number[];
  /** per step: how many `role:'tool'` messages the SDK emitted itself. Must be
   * all 0 for the same reason. */
  sdkToolMessageCounts: number[];
  /** true iff the iteration cap stopped the loop. */
  maxStepsExceeded: boolean;
  /** names of executors we actually invoked, in order. */
  executorsRun: string[];
};

const DEFAULT_MAX_STEPS = 16;

// ---------------------------------------------------------------------------
// JSON-Schema -> the SDK's input schema. Our runtime speaks engine-agnostic
// JSON Schema (contract §2); `jsonSchema()` wraps it for the SDK without a zod
// round-trip, so the schema the model sees is exactly the one we declared.
// This conversion is engine-internal and never leaks upward.
// ---------------------------------------------------------------------------

type JsonSchema7 = Record<string, unknown>;

function toJsonSchema7(s: JsonSchema): JsonSchema7 {
  const out: JsonSchema7 = {};
  if (s.type) out.type = s.type;
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (s.items) out.items = toJsonSchema7(s.items);
  if (s.properties) {
    const props: Record<string, JsonSchema7> = {};
    for (const [k, v] of Object.entries(s.properties)) props[k] = toJsonSchema7(v);
    out.properties = props;
  }
  if (s.required) out.required = [...s.required];
  if (s.type === 'object') out.additionalProperties = false;
  return out;
}

/** Build the EXECUTE-LESS tool set. The absence of `execute` is the invariant:
 * an execute-less tool is surfaced back to us, never run by the SDK. */
function buildToolSet(schemas: EngineRunInput['toolSchemas']): ToolSet {
  const tools: ToolSet = {};
  for (const ts of schemas) {
    tools[ts.name] = tool({
      description: ts.description,
      inputSchema: jsonSchema<Record<string, unknown>>(
        toJsonSchema7(ts.parameters) as never,
      ),
      // NO `execute` — deliberately. See the header note.
    });
  }
  return tools;
}

// ---------------------------------------------------------------------------
// RuntimeMessage <-> ModelMessage. Our runtime types stay provider-independent;
// the SDK shapes exist only inside this file.
// ---------------------------------------------------------------------------

/**
 * Map our history into the SDK's prompt shape.
 *
 * A `role:'tool'` RuntimeMessage carries its own `toolName` (contract §6), so a
 * tool result maps to a REAL tool message regardless of whether its originating
 * tool call appears in the history being mapped. That is what makes a persisted
 * transcript replayable after a restart or a provider switch, where the call
 * was written by a previous turn or by a different engine.
 *
 * There is no `role:'system'` case: a system prompt is not a message, it comes
 * in on `EngineRunInput.system` and is passed to `generateText`'s own `system`
 * option (`ai@7` rejects `role:'system'` inside `messages`).
 */
export function toModelMessages(messages: readonly RuntimeMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];

  for (const m of messages) {
    if (m.role === 'tool') {
      const part: ToolResultPart = {
        type: 'tool-result',
        toolCallId: m.toolCallId,
        toolName: m.toolName,
        output: m.output.isError
          ? { type: 'error-text', value: m.output.content }
          : { type: 'text', value: m.output.content },
      };
      const prev = out[out.length - 1];
      if (prev && prev.role === 'tool' && Array.isArray(prev.content)) {
        prev.content.push(part);
      } else {
        out.push({ role: 'tool', content: [part] });
      }
      continue;
    }

    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
      continue;
    }

    // assistant
    if (m.toolCalls && m.toolCalls.length > 0) {
      const content: Exclude<
        Extract<ModelMessage, { role: 'assistant' }>['content'],
        string
      > = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls) {
        content.push({
          type: 'tool-call',
          toolCallId: c.toolCallId,
          toolName: c.toolName,
          input: c.input,
        });
      }
      out.push({ role: 'assistant', content });
    } else {
      out.push({ role: 'assistant', content: m.content });
    }
  }
  return out;
}

/** The inverse projection, back into our provider-independent shape. Used when
 * the SDK's accumulated messages need to be folded into our own store. */
export function toRuntimeMessages(
  messages: readonly ModelMessage[],
): RuntimeMessage[] {
  const out: RuntimeMessage[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      for (const part of m.content) {
        if (part.type !== 'tool-result') continue;
        const o = part.output;
        const isError = o.type === 'error-text' || o.type === 'error-json';
        const content =
          o.type === 'text' || o.type === 'error-text'
            ? o.value
            : o.type === 'json' || o.type === 'error-json'
              ? JSON.stringify(o.value)
              : o.type === 'execution-denied'
                ? `execution denied: ${o.reason ?? 'no reason given'}`
                : '';
        out.push({
          role: 'tool',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          output: { content, isError },
        });
      }
      continue;
    }
    // A system message has no RuntimeMessage counterpart — the system prompt
    // rides on EngineRunInput.system, not on the history (contract §6).
    if (m.role === 'system') continue;
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const text = m.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('');
    const toolCalls: ToolCall[] = [];
    if (m.role === 'assistant') {
      for (const p of m.content) {
        if (p.type === 'tool-call') {
          toolCalls.push({
            toolCallId: p.toolCallId,
            toolName: p.toolName,
            input: p.input,
          });
        }
      }
    }
    out.push(
      m.role === 'assistant' && toolCalls.length > 0
        ? { role: 'assistant', content: text, toolCalls }
        : { role: m.role, content: text },
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

/** mcp__<server>__<tool> -> <tool>. Kept identical to the dev engine so both
 * engines hand the runtime the SAME bare names (contract §4: per-provider
 * quirks are normalized inside the engine). */
function bareName(toolName: string): string {
  if (toolName.startsWith('mcp__')) return toolName.split('__').slice(2).join('__');
  return toolName;
}

function addUsage(
  acc: Required<Usage>,
  u: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    inputTokenDetails?: { cacheReadTokens?: number | undefined };
  },
): void {
  acc.inputTokens += u.inputTokens ?? 0;
  acc.outputTokens += u.outputTokens ?? 0;
  acc.cachedInputTokens += u.inputTokenDetails?.cacheReadTokens ?? 0;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

export class AiSdkEngine implements Engine {
  private readonly resolveModel: ModelResolver;
  private readonly maxSteps: number;
  private readonly system: string | undefined;

  /** Diagnostics from the most recent run(); the spike asserts on this. */
  diagnostics: AiSdkEngineDiagnostics = {
    steps: 0,
    sdkToolResultCounts: [],
    sdkToolMessageCounts: [],
    maxStepsExceeded: false,
    executorsRun: [],
  };

  constructor(options: AiSdkEngineOptions) {
    this.resolveModel = options.resolveModel;
    this.maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS;
    this.system = options.system;
  }

  async *run(input: EngineRunInput): AsyncIterable<EngineEvent> {
    const diagnostics: AiSdkEngineDiagnostics = {
      steps: 0,
      sdkToolResultCounts: [],
      sdkToolMessageCounts: [],
      maxStepsExceeded: false,
      executorsRun: [],
    };
    this.diagnostics = diagnostics;

    const usage: Required<Usage> = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    };

    let model: LanguageModelV4;
    try {
      model = await this.resolveModel(input.model);
    } catch (e) {
      yield {
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
        code: 'MODEL_RESOLVE_FAILED',
      };
      yield { kind: 'result', ok: false };
      return;
    }

    yield { kind: 'init', providerId: input.model.providerId, model: model.modelId };

    const tools = buildToolSet(input.toolSchemas);
    const messages = toModelMessages(input.messages);

    // The system prompt is NOT a message (contract §6): `ai@7` rejects
    // `role:'system'` inside `messages` and directs it to the dedicated
    // instructions slot, which is exactly what `system` is here. Per-run wins
    // over the engine-level default.
    const system = input.system ?? this.system;

    // -- OUR loop. One model step per iteration; the SDK never continues on
    //    its own (no multi-step stopWhen; v7 default is stepCountIs(1)).
    for (let step = 0; ; step++) {
      if (step >= this.maxSteps) {
        diagnostics.maxStepsExceeded = true;
        yield {
          kind: 'error',
          message: `iteration cap reached: the model requested tools for ${this.maxSteps} consecutive steps without finishing`,
          code: 'MAX_STEPS_EXCEEDED',
        };
        yield { kind: 'result', ok: false, usage };
        return;
      }

      let result: Awaited<ReturnType<typeof generateText>>;
      try {
        result = await generateText({
          model,
          tools,
          messages,
          abortSignal: input.signal,
          ...(system ? { system } : {}),
          // NOTE: `stopWhen` is deliberately UNSET. The v7 default is
          // stepCountIs(1) — a single model step, then control back to us.
          // Passing a multi-step stopWhen would let the SDK drive the loop.
        });
      } catch (e) {
        // DEV diagnostic: the model step threw (e.g. the provider adapter could
        // not parse the response, an auth/quota error, an aborted turn). Surface
        // it to the terminal so a "no visible answer" turn is debuggable; the UI
        // still gets the error event below.
        const msg = e instanceof Error ? e.message : String(e);
        const detail =
          e && typeof e === 'object' && 'cause' in e && (e as { cause?: unknown }).cause
            ? ` | cause: ${String((e as { cause?: unknown }).cause)}`
            : '';
        console.error(`[ai-sdk-engine] model step threw: ${msg}${detail}`);
        yield {
          kind: 'error',
          message: msg,
          code: 'ENGINE_THREW',
        };
        yield { kind: 'result', ok: false, usage };
        return;
      }

      diagnostics.steps = step + 1;
      addUsage(usage, result.usage);

      // -- Invariant check: the SDK must have executed NOTHING. Our tools are
      //    execute-less, so any tool result here came from a path that skipped
      //    the gate. Refuse rather than continue ungated (§3 invariant 4).
      const sdkToolResults = result.toolResults.length;
      const sdkToolMessages = result.response.messages.filter(
        (m) => m.role === 'tool',
      ).length;
      diagnostics.sdkToolResultCounts.push(sdkToolResults);
      diagnostics.sdkToolMessageCounts.push(sdkToolMessages);
      if (sdkToolResults > 0 || sdkToolMessages > 0) {
        yield {
          kind: 'error',
          message:
            `REFUSED: the SDK produced ${sdkToolResults} tool result(s) and ` +
            `${sdkToolMessages} tool message(s) on its own — a tool executed without the gate`,
          code: 'GATE_BYPASSED',
        };
        yield { kind: 'result', ok: false, usage };
        return;
      }

      if (result.text) {
        yield { kind: 'text', role: 'assistant', text: result.text };
      }

      const calls = result.toolCalls;
      if (result.finishReason !== 'tool-calls' || calls.length === 0) {
        // Terminal: the model stopped asking for tools.
        yield { kind: 'result', ok: true, usage };
        return;
      }

      // Carry the assistant turn (text + tool-call parts) into the next step.
      messages.push(...result.response.messages);

      const toolResultParts: ToolResultPart[] = [];
      for (const rawCall of calls) {
        const name = bareName(rawCall.toolName);
        const call: ToolCall = {
          toolCallId: rawCall.toolCallId,
          toolName: name,
          input: rawCall.input,
        };

        yield {
          kind: 'tool_request',
          toolCallId: call.toolCallId,
          toolName: name,
          input: call.input,
        };

        // -- THE GATE. Nothing runs before this returns allow.
        const decision = await input.gate(call);

        yield {
          kind: 'gate_result',
          toolCallId: call.toolCallId,
          toolName: name,
          decision: decision.behavior,
          reason: decision.behavior === 'deny' ? decision.reason : undefined,
        };

        if (decision.behavior === 'deny') {
          // The executor is NEVER invoked. The model is told, so it can adapt.
          // `error-text` (not `execution-denied`) is used deliberately: every
          // one of the five providers renders it as plain tool-result text the
          // model reliably reads, and the reason stays visible in transcripts.
          toolResultParts.push({
            type: 'tool-result',
            toolCallId: call.toolCallId,
            toolName: rawCall.toolName,
            output: {
              type: 'error-text',
              value: `Denied by policy gate: ${decision.reason}`,
            },
          });
          continue;
        }

        // allow — possibly with a rewritten input. The rewrite is applied HERE,
        // in the wrapper, so there is no window between approval and execution
        // in which the input can change (§3 invariant 2).
        const approvedInput = decision.input ?? call.input;

        const executor = input.executors[name];
        if (!executor) {
          toolResultParts.push({
            type: 'tool-result',
            toolCallId: call.toolCallId,
            toolName: rawCall.toolName,
            output: { type: 'error-text', value: `no executor for ${name}` },
          });
          yield {
            kind: 'error',
            message: `no executor for ${name}`,
            code: 'NO_EXECUTOR',
          };
          continue;
        }

        let output: ToolOutput;
        try {
          diagnostics.executorsRun.push(name);
          output = await executor(approvedInput, {
            toolCall: {
              toolCallId: call.toolCallId,
              toolName: name,
              input: approvedInput,
            },
            signal: input.signal,
          });
        } catch (e) {
          output = {
            content: e instanceof Error ? e.message : String(e),
            isError: true,
          };
        }

        yield {
          kind: 'tool_result',
          toolCallId: call.toolCallId,
          toolName: name,
          isError: !!output.isError,
          output,
        };

        toolResultParts.push({
          type: 'tool-result',
          toolCallId: call.toolCallId,
          toolName: rawCall.toolName,
          output: output.isError
            ? { type: 'error-text', value: output.content }
            : { type: 'text', value: output.content },
        });
      }

      messages.push({ role: 'tool', content: toolResultParts });
    }
  }
}
