// src/engines/claude-agent-sdk-engine.ts
//
// ClaudeAgentSdkEngine — the DEV / TEST backend (contract §2.2). Wraps
// @anthropic-ai/claude-agent-sdk on the developer's LOCAL OAuth (no API key).
//
// THE VERIFIED CONFIG — the load-bearing details, each mapped to a contract
// invariant (§3):
//
//   * options.tools: []                    -> strip ALL built-in executors.
//   * our tools via createSdkMcpServer      -> the only tools the model can call
//     are ours, each dispatched to our runtime Executor.
//   * gate as a PreToolUse hook             -> deny is authoritative even under
//     bypassPermissions; the tool never runs until the gate returns allow.
//   * NEVER list a tool in allowedTools     -> that auto-approves it and
//     silently shadows the gate. We verify the SDK does not emit
//     CLAUDE_SDK_CAN_USE_TOOL_SHADOWED (captured off stderr).
//   * normalize mcp__<server>__<tool>       -> bare tool names, and the SDK's
//     events -> our EngineEvent.
//
// The SDK owns its model loop; that is expected. This engine drives query() to
// completion and surfaces the gate + executor callbacks.
//
// Input-rewrite note: when the gate allows with a rewritten input, the rewrite
// is applied AUTHORITATIVELY in the executor wrapper, from the decision queued
// by the PreToolUse hook — there is no window between approval and execution in
// which the input can change (contract §3 invariant 2). We ALSO return
// `updatedInput` from the hook so the model's transcript reflects the rewrite,
// but the wrapper is the source of truth because propagation of `updatedInput`
// into the in-process MCP handler is not something we want to depend on.

import {
  createSdkMcpServer,
  query,
  tool,
  type HookCallback,
  type HookInput,
  type PreToolUseHookInput,
  type PreToolUseHookSpecificOutput,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type {
  Engine,
  EngineEvent,
  EngineRunInput,
  JsonSchema,
  ToolCall,
  Usage,
} from '../runtime/engine.js';

// ---------------------------------------------------------------------------
// Small async channel: hooks, the tool handler, and the query-message loop all
// push EngineEvents here; run() yields them out in order.
// ---------------------------------------------------------------------------

class Channel<T> {
  private readonly queue: T[] = [];
  private readonly resolvers: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(v: T): void {
    if (this.closed) return;
    const r = this.resolvers.shift();
    if (r) r({ value: v, done: false });
    else this.queue.push(v);
  }

  close(): void {
    this.closed = true;
    let r = this.resolvers.shift();
    while (r) {
      r({ value: undefined as unknown as T, done: true });
      r = this.resolvers.shift();
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const v = this.queue.shift();
        if (v !== undefined) return Promise.resolve({ value: v, done: false });
        if (this.closed)
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}

// ---------------------------------------------------------------------------
// JSON-Schema -> zod. The runtime hands the engine engine-agnostic JSON schema
// (contract §2); the SDK's tool() wants a zod raw shape, so we convert here —
// the conversion is an engine-internal detail, never leaked upward.
// ---------------------------------------------------------------------------

function jsonSchemaToZod(s: JsonSchema): z.ZodTypeAny {
  switch (s.type) {
    case 'string':
      return z.string();
    case 'number':
    case 'integer':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'array':
      return z.array(s.items ? jsonSchemaToZod(s.items) : z.unknown());
    case 'object':
      return z.object(objectShape(s));
    default:
      return z.unknown();
  }
}

function objectShape(s: JsonSchema): Record<string, z.ZodTypeAny> {
  const props = s.properties ?? {};
  const required = new Set(s.required ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [k, v] of Object.entries(props)) {
    let zt = jsonSchemaToZod(v);
    if (v.description) zt = zt.describe(v.description);
    if (!required.has(k)) zt = zt.optional();
    shape[k] = zt;
  }
  return shape;
}

// ---------------------------------------------------------------------------
// Name + content normalization
// ---------------------------------------------------------------------------

/** mcp__<server>__<tool> -> <tool> (bare). Non-mcp names pass through. */
function bareName(toolName: string): string {
  if (toolName.startsWith('mcp__')) return toolName.split('__').slice(2).join('__');
  return toolName;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (b): b is { type: 'text'; text: string } =>
        !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text',
    )
    .map((b) => String(b.text ?? ''))
    .join('');
}

function lastUserText(messages: EngineRunInput['messages']): string {
  const users = messages.filter((m) => m.role === 'user');
  const last = users[users.length - 1];
  if (last && 'content' in last) return last.content;
  // fall back to any content we have
  const any = messages.find((m) => 'content' in m);
  return any && 'content' in any ? any.content : '';
}

// ---------------------------------------------------------------------------
// Diagnostics surfaced to the spike (stderr + shadow-warning detection).
// ---------------------------------------------------------------------------

export type ClaudeEngineDiagnostics = {
  stderr: string[];
  /** true iff the SDK warned that our tool was shadowed (gate bypassed). */
  shadowWarningSeen: boolean;
};

const SHADOW_WARNING = 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED';
const MCP_SERVER_NAME = 'nabytools';

export class ClaudeAgentSdkEngine implements Engine {
  /** Diagnostics from the most recent run(); the spike asserts on this. */
  diagnostics: ClaudeEngineDiagnostics = { stderr: [], shadowWarningSeen: false };

  async *run(input: EngineRunInput): AsyncIterable<EngineEvent> {
    const channel = new Channel<EngineEvent>();
    const diagnostics: ClaudeEngineDiagnostics = {
      stderr: [],
      shadowWarningSeen: false,
    };
    this.diagnostics = diagnostics;

    // Gate decisions the hook approved, awaiting their executor. FIFO per bare
    // tool name. The PreToolUse hook fires immediately before the handler for
    // the same call and the SDK runs calls sequentially, so FIFO correlation
    // holds for the spike; duplicate-input calls in one turn dequeue in order.
    const pending = new Map<string, { input: unknown; toolCallId: string }[]>();
    const enqueue = (name: string, e: { input: unknown; toolCallId: string }) => {
      const q = pending.get(name) ?? [];
      q.push(e);
      pending.set(name, q);
    };
    const dequeue = (name: string) => pending.get(name)?.shift();

    // Build our tools as an in-process MCP server. Each handler runs the
    // runtime executor on the GATE-APPROVED input, and refuses to run if no
    // gate decision is queued (which would mean the gate was bypassed).
    const sdkTools = input.toolSchemas.map((ts) =>
      tool(
        ts.name,
        ts.description,
        objectShape(ts.parameters),
        async () => {
          const approved = dequeue(ts.name);
          if (!approved) {
            // Invariant 3: no auto-execution path may bypass the gate.
            channel.push({
              kind: 'error',
              message: `REFUSED: ${ts.name} reached the executor without a gate decision`,
              code: 'GATE_BYPASSED',
            });
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `REFUSED: ${ts.name} was not gated`,
                },
              ],
              isError: true,
            };
          }
          const executor = input.executors[ts.name];
          if (!executor) {
            return {
              content: [
                { type: 'text' as const, text: `no executor for ${ts.name}` },
              ],
              isError: true,
            };
          }
          const output = await executor(approved.input, {
            toolCall: {
              toolCallId: approved.toolCallId,
              toolName: ts.name,
              input: approved.input,
            },
            signal: input.signal,
          });
          channel.push({
            kind: 'tool_result',
            toolCallId: approved.toolCallId,
            toolName: ts.name,
            isError: !!output.isError,
            output,
          });
          return {
            content: [{ type: 'text' as const, text: output.content }],
            isError: !!output.isError,
          };
        },
      ),
    );

    const server = createSdkMcpServer({
      name: MCP_SERVER_NAME,
      version: '0.0.0',
      tools: sdkTools,
    });

    // The gate, attached at the SDK's only sound pre-execution point.
    const preToolUse: HookCallback = async (hookInput: HookInput) => {
      if (hookInput.hook_event_name !== 'PreToolUse') return {};
      const h = hookInput as PreToolUseHookInput;
      const name = bareName(h.tool_name);
      const call: ToolCall = {
        toolCallId: h.tool_use_id,
        toolName: name,
        input: h.tool_input,
      };
      channel.push({
        kind: 'tool_request',
        toolCallId: call.toolCallId,
        toolName: name,
        input: h.tool_input,
      });

      const decision = await input.gate(call);

      channel.push({
        kind: 'gate_result',
        toolCallId: call.toolCallId,
        toolName: name,
        decision: decision.behavior,
        reason: decision.behavior === 'deny' ? decision.reason : undefined,
      });

      if (decision.behavior === 'deny') {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: decision.reason,
          },
        };
      }

      // allow (possibly with a rewritten input). Queue the approved input for
      // the executor wrapper — the authoritative rewrite path.
      const approvedInput = decision.input ?? h.tool_input;
      enqueue(name, { input: approvedInput, toolCallId: call.toolCallId });

      const out: PreToolUseHookSpecificOutput = {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'gate allow',
      };
      if (
        decision.input !== undefined &&
        approvedInput &&
        typeof approvedInput === 'object'
      ) {
        out.updatedInput = approvedInput as Record<string, unknown>;
      }
      return { hookSpecificOutput: out };
    };

    // Forward our abort signal into an AbortController the SDK owns.
    const ac = new AbortController();
    if (input.signal.aborted) ac.abort();
    else input.signal.addEventListener('abort', () => ac.abort(), { once: true });

    const q = query({
      prompt: lastUserText(input.messages),
      options: {
        tools: [], // strip ALL built-ins
        mcpServers: { [MCP_SERVER_NAME]: server },
        hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
        // deny is authoritative even here:
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        // The system prompt travels on its OWN field (contract §2/§6), never as
        // a `role:'system'` message. The Agent SDK's native slot for it is
        // `systemPrompt`; passing a bare string replaces the default preset.
        ...(input.system ? { systemPrompt: input.system } : {}),
        // NOTE: allowedTools is deliberately UNSET — listing our tool there
        // would auto-approve it and silently shadow the gate.
        abortController: ac,
        stderr: (data: string) => {
          diagnostics.stderr.push(data);
          if (data.includes(SHADOW_WARNING)) diagnostics.shadowWarningSeen = true;
        },
        ...(input.model.model ? { model: input.model.model } : {}),
      },
    });

    const driver = (async () => {
      try {
        for await (const msg of q) {
          if (msg.type === 'system' && msg.subtype === 'init') {
            channel.push({
              kind: 'init',
              providerId: input.model.providerId,
              model: msg.model,
            });
          } else if (msg.type === 'assistant') {
            const text = extractText(msg.message.content);
            if (text) channel.push({ kind: 'text', role: 'assistant', text });
            if (msg.error) {
              channel.push({
                kind: 'error',
                message: `assistant error: ${msg.error}`,
                code: msg.error,
              });
            }
          } else if (msg.type === 'result') {
            const u = msg.usage as
              | {
                  input_tokens?: number;
                  output_tokens?: number;
                  cache_read_input_tokens?: number;
                }
              | undefined;
            const usage: Usage = {
              inputTokens: u?.input_tokens,
              outputTokens: u?.output_tokens,
              cachedInputTokens: u?.cache_read_input_tokens,
            };
            channel.push({
              kind: 'result',
              ok: !msg.is_error,
              usage,
              costUsd: msg.total_cost_usd,
            });
          }
        }
      } catch (e) {
        channel.push({
          kind: 'error',
          message: e instanceof Error ? e.message : String(e),
          code: 'ENGINE_THREW',
        });
      } finally {
        channel.close();
      }
    })();

    yield* channel;
    await driver;
  }
}
