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

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type {
  HookCallback,
  HookInput,
  PreToolUseHookInput,
  PreToolUseHookSpecificOutput,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  Engine,
  EngineEvent,
  EngineRunInput,
  JsonSchema,
  RuntimeMessage,
  ToolCall,
  Usage,
} from '../runtime/engine.js';

// ---------------------------------------------------------------------------
// THE LAZY BOUNDARY — why this is not a plain `import` (design §3.3).
// ---------------------------------------------------------------------------
//
// The Agent SDK must NEVER be in a shipped build. `electron-builder.yml`
// already excludes `@anthropic-ai/claude-agent-sdk*` from the package, so in a
// packaged app the module is simply ABSENT. A static import here would defeat
// that twice over:
//
//   1. `scripts/build-runtime.mjs` bundles this file into
//      `dist/naby-runtime.mjs` with `external: []` — every static import is
//      INLINED. A static SDK import would therefore ship the SDK inside our own
//      bundle, straight past the electron-builder exclusion.
//   2. Even if it were excluded, a static import is evaluated at module load,
//      so the shell's engine module would throw on import in the packaged app —
//      taking the PRODUCTION path down with it.
//
// So the specifier is resolved at RUNTIME, through a require created from this
// module's own URL, and imported by file URL. Both are opaque to esbuild's
// static analysis, which is the point: nothing about the SDK ends up in the
// bundle, and a missing module is a `null` we can explain rather than a crash.
//
// `import type` above is erased at compile time and costs nothing at runtime.

const AGENT_SDK_SPECIFIER = '@anthropic-ai/claude-agent-sdk';

/** The three runtime values this engine uses. Typed off the real package so a
 *  bump that changes a signature fails `npm run typecheck`, not production. */
type AgentSdk = {
  createSdkMcpServer: typeof import('@anthropic-ai/claude-agent-sdk').createSdkMcpServer;
  query: typeof import('@anthropic-ai/claude-agent-sdk').query;
  tool: typeof import('@anthropic-ai/claude-agent-sdk').tool;
};

/**
 * Where the Agent SDK lives, or null when it is not installed.
 *
 * Resolution is relative to THIS module's URL, which is what makes it correct
 * in both linkages: under `tsx` that is `src/engines/`, and inside the bundle it
 * is `dist/naby-runtime.mjs` — both walk up to the parent repo's node_modules.
 */
export function resolveClaudeAgentSdkPath(): string | null {
  try {
    return createRequire(import.meta.url).resolve(AGENT_SDK_SPECIFIER);
  } catch {
    return null;
  }
}

/** True when the dev engine can actually run here. Cheap; no module is loaded. */
export function isClaudeAgentSdkAvailable(): boolean {
  return resolveClaudeAgentSdkPath() !== null;
}

/** What a caller is told when the SDK is missing. Written for a NON-DEVELOPER:
 *  the dev engine is a development-only path, so the actionable advice is to
 *  configure a provider key, not to install an npm package. */
export const AGENT_SDK_UNAVAILABLE_MESSAGE =
  'The built-in development model is not part of this installed app, so it cannot answer. ' +
  'Open Settings (gear icon, bottom left) → "AI provider", pick a provider and paste its API key. ' +
  '(Developers: the development model only works when running from a source checkout, ' +
  'where @anthropic-ai/claude-agent-sdk is installed.)';

let cachedSdk: Promise<AgentSdk> | undefined;

/** Load the SDK once per process. Rejects with a readable error when absent. */
async function loadAgentSdk(): Promise<AgentSdk> {
  if (!cachedSdk) {
    cachedSdk = (async (): Promise<AgentSdk> => {
      const resolved = resolveClaudeAgentSdkPath();
      if (!resolved) throw new Error(AGENT_SDK_UNAVAILABLE_MESSAGE);
      // Imported by FILE URL, from a variable: esbuild cannot fold this into
      // the bundle, and node needs a URL (not a path) on Windows.
      //
      // `webpackIgnore` is not decoration. The shell is a Next/webpack app that
      // imports our esbuild bundle, so this expression gets analyzed a SECOND
      // time by webpack, which reports "Critical dependency: the request of a
      // dependency is an expression" and would try to trace it. esbuild
      // preserves this specific comment through the bundle, so the marker
      // written here is the one webpack reads there — and the import stays a
      // plain runtime import in both toolchains, which is the whole point.
      return (await import(/* webpackIgnore: true */ pathToFileURL(resolved).href)) as AgentSdk;
    })().catch((e) => {
      // Do not cache a failure forever — a dev who runs `npm i` mid-session
      // should not have to restart the app to pick the engine up.
      cachedSdk = undefined;
      throw e;
    });
  }
  return cachedSdk;
}

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

/**
 * Anthropic's raw token counts -> our normalized `Usage` (see the `Usage` doc
 * in runtime/engine.ts).
 *
 * Exported so the normalization is assertable directly, without a live model
 * call: this is the single most costly thing in the file to get wrong quietly,
 * because a wrong answer here does not fail — it just prices the turn by three
 * orders of magnitude.
 */
export function normalizeAgentSdkUsage(raw: {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}): Usage {
  const cacheRead = raw.cache_read_input_tokens ?? 0;
  const cacheWrite = raw.cache_creation_input_tokens ?? 0;
  return {
    // Anthropic reports these three DISJOINTLY; our contract wants a total.
    inputTokens: (raw.input_tokens ?? 0) + cacheRead + cacheWrite,
    outputTokens: raw.output_tokens ?? 0,
    cachedInputTokens: cacheRead,
  };
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
// MULTI-TURN — divergence point "loop ownership", normalized (design §3.4).
// ---------------------------------------------------------------------------
//
// WE own the transcript (contract §6): `runTurn` reloads the whole history from
// SQLite and re-sends it every turn, which is exactly what makes a session
// provider-independent. The Agent SDK, though, takes a single `prompt` and owns
// its own loop — it has no `messages` array to hand our history to, and its own
// session resumption is keyed to ITS transcript directory, which contract §6
// says we ignore.
//
// So the history is RENDERED into the prompt: prior turns as a clearly-fenced
// context block, then the new user turn as the actual instruction. This keeps
// the store as the single source of truth (a session started on the dev engine
// and continued on a provider — or the reverse — replays identically), at the
// cost of prior turns being framed as text rather than as native turns. That
// tradeoff is deliberate and is the only shape the SDK's single-prompt entry
// point allows.
//
// A first turn renders as the bare user text, so the single-turn spikes see
// exactly the prompt they saw before this existed.

function renderHistoryLine(m: RuntimeMessage): string | null {
  if (m.role === 'tool') {
    const status = m.output.isError ? ' (failed)' : '';
    return `Tool ${m.toolName}${status} returned: ${m.output.content}`;
  }
  if (m.role === 'assistant') {
    if (m.toolCalls?.length) {
      const names = m.toolCalls.map((c) => c.toolName).join(', ');
      return m.content ? `Assistant: ${m.content}` : `Assistant called tool: ${names}`;
    }
    return m.content ? `Assistant: ${m.content}` : null;
  }
  return m.content ? `User: ${m.content}` : null;
}

/** The prompt for this turn: prior history as context, then the new user text. */
export function renderPrompt(messages: EngineRunInput['messages']): string {
  // `runTurn` appends the user turn BEFORE calling the engine, so the last user
  // message is the new one and everything before it is history.
  let lastUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      lastUserIndex = i;
      break;
    }
  }
  const current = lastUserText(messages);
  const prior = lastUserIndex >= 0 ? messages.slice(0, lastUserIndex) : [];
  const lines = prior
    .map(renderHistoryLine)
    .filter((l): l is string => l !== null && l.length > 0);
  if (lines.length === 0) return current;

  return [
    'Earlier messages in this conversation, for context only — do not answer them again:',
    '<conversation_history>',
    ...lines,
    '</conversation_history>',
    '',
    'The user now says:',
    current,
  ].join('\n');
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
    // The SDK is loaded HERE, inside run(), so that constructing the engine is
    // always safe. A packaged build can hold a reference to this class without
    // the module existing; only an attempt to actually answer fails, and it
    // fails as a surfaced EngineEvent rather than a thrown module-load error.
    let sdk: AgentSdk;
    try {
      sdk = await loadAgentSdk();
    } catch (e) {
      yield {
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
        code: 'DEV_ENGINE_UNAVAILABLE',
      };
      yield { kind: 'result', ok: false };
      return;
    }
    const { createSdkMcpServer, query, tool } = sdk;

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
      prompt: renderPrompt(input.messages),
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
                  cache_creation_input_tokens?: number;
                }
              | undefined;
            // Observed in a real dev turn before this was normalized:
            // input_tokens=4 with cache_read_input_tokens=9435 — i.e. a 9.4k
            // prompt reported as 4 tokens.
            const usage: Usage = normalizeAgentSdkUsage(u ?? {});
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
