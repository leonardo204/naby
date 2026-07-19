---
id: phase-1-contracts
title: Phase 1 — Interface Contracts (IPC, engine interface, provider config, storage)
type: interface
version: 0.2.1
status: draft
scope: Contracts between renderer and main, the engine abstraction seam and its two backends, the gate contract, the provider configuration schema, and the on-disk storage layout for Phase 1
related: [phase-1-shell-architecture, phase-1-desktop-shell, phase-1-test-plan, personalized-agent-desktop-app]
updated: 2026-07-20
---

# Phase 1 — Interface Contracts

> Contracts only. Rationale lives in [`phase-1-shell-architecture`](../design/phase-1-shell-architecture.md).

**Engine-facing types** are drawn from `ai` (Vercel AI SDK) v7 for `AiSdkEngine`, and from `@anthropic-ai/claude-agent-sdk@0.3.215`'s `sdk.d.ts` for the dev-only `ClaudeAgentSdkEngine`. Both are hidden behind the runtime's `Engine` interface (§3), so the rest of the app depends on our contract, not on either SDK's surface.

---

## 1. IPC contract

### 1.1 Transport rules

- `contextBridge` + `ipcRenderer.invoke` ↔ `ipcMain.handle`. The renderer never receives `ipcRenderer` itself.
- Every handler validates `event.senderFrame` against an allowlist using a real URL parser.
- Payloads cross by structured clone: **symbols and prototypes are dropped**, and a thrown error arrives with only `.message`. Errors therefore travel as data.

### 1.2 Error envelope

Every channel returns this shape rather than throwing, so the renderer can branch on a stable code:

```ts
type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: ErrorCode; message: string; detail?: string } };

type ErrorCode =
  | 'CREDENTIAL_UNAVAILABLE'    // no key stored for the selected provider
  | 'CREDENTIAL_INSECURE'       // Linux safeStorage fell back to basic_text
  | 'PROVIDER_UNREACHABLE'
  | 'PROVIDER_AUTH_FAILED'      // 401/403 from the provider
  | 'SESSION_NOT_FOUND'
  | 'GATE_UNSOUND'              // §3.4 — refuse to run rather than run ungated
  | 'INTERNAL';
```

### 1.3 Channels

| Channel | Direction | Request | Response |
|---|---|---|---|
| `credential:status` | R→M | `{ providerId: string }` | `Result<{ stored: boolean; backend: string; secure: boolean }>` |
| `credential:set` | R→M | `{ providerId: string; key: string }` | `Result<{ secure: boolean }>` |
| `credential:clear` | R→M | `{ providerId: string }` | `Result<void>` |
| `provider:list` | R→M | — | `Result<ProviderProfile[]>` |
| `provider:upsert` | R→M | `ProviderProfile` | `Result<void>` |
| `provider:select` | R→M | `{ sessionId: string; providerId: string }` | `Result<void>` |
| `provider:probe` | R→M | `{ providerId: string }` | `Result<{ reachable: boolean }>` |
| `session:list` | R→M | — | `Result<SessionRef[]>` |
| `session:start` | R→M | `{ providerId: string; title?: string }` | `Result<{ sessionId: string }>` |
| `session:resume` | R→M | `{ sessionId: string }` | `Result<{ sessionId: string }>` |
| `session:send` | R→M | `{ sessionId: string; text: string }` | `Result<void>` — output streams on `session:event` |
| `session:interrupt` | R→M | `{ sessionId: string }` | `Result<void>` |
| `session:event` | M→R | — | `SessionEvent` (stream) |
| `gate:respond` | R→M | `{ toolCallId: string; decision: 'allow' \| 'deny'; input?: unknown; reason?: string }` | `Result<void>` |
| `mcp:list` / `mcp:upsert` / `mcp:remove` / `mcp:test` | R→M | see §5 | `Result<…>` |
| `update:status` | M→R | — | `{ state: 'idle'\|'checking'\|'available'\|'downloading'\|'ready'\|'unsupported'; version?: string }` |

`provider:select` takes a `sessionId` because switching provider is a mid-session operation that **must not** disturb memory or history (design §3.4). `gate:respond` is the renderer's answer to a `gate_request` event — the human approval that the engine-side gate `await`s. `update:status` reports `'unsupported'` on unsigned macOS; the renderer renders a manual-download path for that state.

### 1.4 `SessionEvent`

The renderer consumes a narrowed projection, uniform across both engines — the runtime normalizes each engine's native events into this one shape (design §3.4, "seven divergence points").

```ts
type SessionEvent =
  | { kind: 'init';         sessionId: string; providerId: string; model: string }
  | { kind: 'text';         sessionId: string; role: 'assistant' | 'user'; text: string; partial?: boolean }
  | { kind: 'tool_request'; sessionId: string; toolCallId: string; toolName: string; input: unknown }
  | { kind: 'gate_request'; sessionId: string; toolCallId: string; toolName: string; input: unknown } // awaiting gate:respond
  | { kind: 'gate_result';  sessionId: string; toolCallId: string; decision: 'allow' | 'deny'; reason?: string }
  | { kind: 'tool_result';  sessionId: string; toolCallId: string; isError: boolean }
  | { kind: 'result';       sessionId: string; ok: boolean; usage?: Usage; costUsd?: number }
  | { kind: 'error';        sessionId: string; code: ErrorCode; message: string };

type Usage = { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number };
```

There is deliberately no `apiKeySource` field — the renderer never needs to know which credential answered, only which provider was selected. In Phase 1 the gate is minimal (always prompt); Phase 2 attaches the rich risk-classified approval UI to `gate_request` / `gate:respond`.

---

## 2. Engine interface (the swappable seam)

The rest of the app depends only on this. Two backends implement it; nothing above the engine names a provider SDK.

```ts
interface Engine {
  // The engine owns the model loop and calls back into the injected gate + executors.
  run(input: EngineRunInput): AsyncIterable<EngineEvent>;
}

type EngineRunInput = {
  model: ModelSelection;               // provider + model id/deployment — the ONLY key-dependent input
  messages: RuntimeMessage[];          // conversation so far (from our store, provider-independent)
  system?: string;                     // system prompt — its OWN field, never a message (see §6)
  toolSchemas: ToolSchema[];           // JSON-schema tool definitions; NO execute — the engine surfaces, we run
  gate: Gate;                          // runtime-owned; the engine attaches it at its pre-execution point
  executors: Record<string, Executor>; // runtime-owned; keyed by tool name
  signal: AbortSignal;
};

type Gate = (call: ToolCall) => Promise<GateDecision>;
type GateDecision =
  | { behavior: 'allow'; input?: unknown }   // input rewrite allowed
  | { behavior: 'deny';  reason: string };

type Executor = (input: unknown, ctx: ExecCtx) => Promise<ToolOutput>;
type ToolCall = { toolCallId: string; toolName: string; input: unknown };
```

- **`system` is not a message.** It travels on its own field and each engine forwards it through its provider's dedicated slot (`ai` v7's `system`/instructions option; the Agent SDK's `systemPrompt`). `ai` v7 **rejects** `role:'system'` inside `messages` outright — *"System messages are not allowed in the prompt or messages fields. Use the instructions option instead."* — so a system prompt is neither stored in the transcript nor replayed as history; it is supplied per turn.
- **`model` is the only key-dependent field.** The engine reads the provider key (via the credential vault) solely to construct the model. `messages`, `system`, `toolSchemas`, `gate`, and `executors` are all provider-independent — the same values are passed whether the backend is `AiSdkEngine` or `ClaudeAgentSdkEngine`, and whichever provider is selected.
- **Tool schemas carry no `execute`.** The engine must surface each tool call; the runtime runs the gate and the executor. Any engine that cannot honor this (executes tools itself) does not implement the interface.

### 2.1 `AiSdkEngine` (production)

Wraps `ai` v7. Internally runs our loop over **execute-less** `tool({ inputSchema })` definitions: call `generateText`/`streamText` for one step → receive `toolCalls` (finishReason `'tool-calls'`) → for each, `await gate(call)` then `executors[name]` → append a `tool` message → repeat until `finishReason !== 'tool-calls'`. Streaming text, `usage`, and continuation are intact. MCP tools are loaded via `listTools()` + `callTool()` (§5), never `tools()`.

### 2.2 `ClaudeAgentSdkEngine` (dev/test only)

Wraps `@anthropic-ai/claude-agent-sdk`. Config: `tools: []` (strip built-ins) + our tools exposed as an in-process `createSdkMcpServer` whose handler calls our `executors`, wrapped so the gate runs first. The gate attaches as a **`PreToolUse` hook** (deny authoritative under `bypassPermissions`); **never** list a tool in `allowedTools` (silently shadows the gate). Runs on local OAuth, no API key. The SDK owns its loop and calls our code back; the engine normalizes its events into `EngineEvent` and its tool names (`mcp__server__tool`) into bare names.

---

## 3. Gate contract — the load-bearing invariants

The gate is defined **once, in the runtime**, and passed into whichever engine runs. Each engine attaches it at the only sound pre-execution point it has. These invariants hold on both:

1. **A tool never executes until the gate returns `allow`.** In `AiSdkEngine`, our loop holds the surfaced call; in `ClaudeAgentSdkEngine`, the `PreToolUse` hook fires before our handler and its deny is authoritative even under `bypassPermissions`.
2. **`allow` may rewrite input** (`GateDecision.input`); the executor then runs on the rewritten input, with no window between approval and execution in which the input can change. **Implementation note (verified in the spike harness):** apply the rewrite in the **executor wrapper** — the runtime runs the executor on the gate-approved input — rather than relying on an engine's own input-rewrite path. In `ClaudeAgentSdkEngine`, `PreToolUse`'s `updatedInput` is *also* returned so the model transcript reflects the rewrite, but its propagation into the in-process tool handler is not a guarantee we depend on; the wrapper is the source of truth. SPIKE-03(a) confirms this end to end (a gate-rewritten `send_message` landed the rewritten text, not the model's original).
3. **No auto-execution path may bypass the gate.** For `AiSdkEngine`: tools are always execute-less, and MCP tools use `listTools()`/`callTool()` (never the auto-executing `tools()`). For `ClaudeAgentSdkEngine`: built-ins are stripped and no tool is listed in `allowedTools`. **Provider-side server-executed tools are never enabled** on any provider.
4. **If the gate cannot be attached, the session refuses to start** and surfaces `GATE_UNSOUND`. Running ungated is the failure the product exists to prevent, not a degraded mode.

In Phase 1 the runtime supplies a **minimal always-prompt gate**: every tool call emits `gate_request` and waits for `gate:respond`. Phase 2 replaces the decision logic with risk classification and the rich approval card — but the contract above is unchanged, so Phase 1 code does not move.

---

## 4. Provider configuration

```ts
type ProviderKind = 'anthropic' | 'bedrock' | 'azure-openai' | 'google' | 'openai';

type ProviderProfile = {
  id: string;
  label: string;
  kind: ProviderKind;
  config:
    | { kind: 'anthropic' }
    | { kind: 'bedrock';      region: string }              // Claude models on Bedrock
    | { kind: 'azure-openai'; resource: string; deployment: string; apiVersion: string }
    | { kind: 'google' }                                    // Gemini
    | { kind: 'openai' };
  model: string;              // model id, or the deployment name for azure-openai
  credentialRef: string;      // opaque handle into the keychain; never the key itself
};
```

**Invariants** (enforced in main):

- Exactly the five `ProviderKind`s are supported; there is no gateway/tier concept.
- `config.kind` matches `kind`.
- **A key is read only when constructing the model** for a turn — never stored in a profile, never logged, never sent to the renderer. `credentialRef` is an opaque handle; the profiles file holds no secret.
- Provider selection changes **only** which model answers. It does not touch `messages`, memory, MCP, or session state.
- Per-provider quirks (Azure deployment names, Bedrock inference-profile IDs, Gemini tool-call ID shape) are normalized inside the engine, never leaked into the runtime.

---

## 5. MCP configuration

```ts
type McpEntry =
  | { name: string; transport: 'stdio'; command: string; args?: string[]; env?: Record<string,string> }
  | { name: string; transport: 'http' | 'sse'; url: string; headers?: Record<string,string>; timeoutMs?: number };
```

The MCP registry is **provider- and key-independent** — it lives in the runtime, keyed to the user/workspace, and is identical regardless of which provider is selected.

**Tools are loaded through the gate, not around it.** Call the MCP client's `listTools()` for schemas only, wrap each as an execute-less runtime tool, and dispatch approved calls with `callTool()`. Never use AI SDK's `tools()`, which binds an auto-executing `execute` that would skip the gate. Pin and drift-check tool definitions (`fingerprintTools()` / `detectToolDrift()`) so an MCP server cannot silently change a tool between connects. `timeoutMs` below 1000 is ignored.

---

## 6. Storage layout — we own persistence

Unlike the Agent-SDK plan, **no engine persists for us.** The runtime owns a local SQLite database; the AI SDK does not write transcripts, and the dev Agent SDK's own transcript directory is ignored.

The runtime depends on a narrow `Store` interface, not on a driver. The F1-05 driver is **`node:sqlite`** (built into Node 24) rather than better-sqlite3, which as a native module would reintroduce the `electron-rebuild` / `asar-unpack` / per-OS-prebuild burden that dropping the Agent SDK from production just removed. `node:sqlite` is **experimental** in Node 24 and its availability inside Electron is **unverified — F1-02 / SPIKE-04 must confirm it**; the `Store` interface exists so that a negative result is a new driver file, not a change to the runtime.

| What | Where | Owner | Notes |
|---|---|---|---|
| Provider keys | OS keychain via `safeStorage` | main | One per provider; verify backend ≠ `basic_text` on Linux before writing |
| Provider profiles | `userData/providers.json` | main | No secrets — only `credentialRef` |
| **Conversation transcripts** | `userData/app.db` (SQLite) | **the runtime** | We store and replay history; provider-independent |
| **Memory / context** | `userData/app.db` (SQLite) | **the runtime** | Keyed to user/session, **not** to provider or key |
| Session index | `userData/app.db` (SQLite) | the runtime | `SessionRef` |
| MCP registry | `userData/app.db` (SQLite) | the runtime | `McpEntry[]`, provider-independent |
| Next runtime caches | `userData/next-cache/` | Next | Install dir is read-only |

```ts
type SessionRef = {
  sessionId: string;      // UUID we mint
  providerId: string;     // last provider used — a hint, not a constraint; switchable any turn
  title?: string;
  createdAt: number;
  lastUsedAt: number;
};

type RuntimeMessage =    // provider-independent internal message shape
  | { role: 'user' | 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; toolName: string; output: ToolOutput };
```

Two shapes above are deliberate and load-bearing for replay:

- **There is no `role:'system'`.** A system prompt is not part of the transcript — it rides on `EngineRunInput.system` (§2) and is supplied per turn. Besides `ai` v7 rejecting system messages in `messages`, storing one would make "which system prompt wins" ambiguous on replay.
- **A tool result carries its `toolName`.** The originating tool call may have been written by an earlier turn, an earlier *process*, or a **different engine** (the provider-switch case), so the name cannot be recovered from the history being replayed. Without it, a persisted tool result becomes an orphan that providers reject. Carrying the name makes tool results self-describing. The runtime also persists the assistant tool-call message adjacent to its result, so every call/result pair stays intact across a restart or a provider switch.

**We hold the full conversation and re-send it each turn** (the engine is stateless across turns at our seam). This is what makes a session provider-independent: switching provider mid-conversation just changes which model receives the same `RuntimeMessage[]`. Losing `providers.json` loses credentials’ handles, not history; losing the SQLite db loses history.

Whether `app.db` is encrypted at rest is an open question (design §6), sharpened in Phase 2 when it also holds draft/final eval content.

---

## 7. Version pinning

Pin the `ai` (AI SDK) **minor** and keep both engines behind the `Engine` interface (§2). A future AI SDK major — or an Agent SDK bump for the dev engine — is then a change in one adapter, not across the app. Regenerate the engine-facing types from the installed SDK on any bump, and re-run the gate regression suite (which runs against **both** engines) before the bump lands.
