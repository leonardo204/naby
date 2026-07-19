// src/runtime-entry.ts
//
// THE PUBLIC SURFACE OF THE NABY RUNTIME.
//
// This barrel exists for exactly one consumer: the shell (our OpenCockpit fork,
// `shell/` — a git submodule). The shell is a separate npm workspace tree with
// its OWN node_modules, and it pins `ai@6` while we pin `ai@7`. Letting the
// shell resolve our imports through ITS node_modules would silently hand our
// engine the wrong `ai` major.
//
// So the linkage is: `npm run build:runtime` bundles this file — and every
// dependency it pulls in, including `ai@7` and the five provider adapters —
// into ONE self-contained ESM file, `dist/naby-runtime.mjs`. The shell imports
// that single artifact by relative path. It contains no bare imports other than
// node builtins, so there is nothing left for the shell's node_modules to
// resolve, and therefore nothing to get wrong.
//
// Nothing key-dependent lives here. `makeModelResolver` is re-exported because
// the shell's engine boundary is where a credential is read; the credential
// itself never crosses this barrel.

export type {
  Engine,
  EngineEvent,
  EngineRunInput,
  ExecCtx,
  Executor,
  Gate,
  GateDecision,
  JsonSchema,
  ModelSelection,
  RuntimeMessage,
  ToolCall,
  ToolOutput,
  ToolSchema,
  Usage,
} from './runtime/engine.js';

export {
  makeGate,
  scriptedPolicy,
  type DecisionPolicy,
  type GateLogEntry,
  type MakeGateResult,
  type ScriptRule,
} from './runtime/gate.js';

export {
  buildToolset,
  echoNote,
  echoNoteSchema,
  makeSendMessage,
  Outbox,
  sendMessageSchema,
  type OutboxEntry,
} from './runtime/tools.js';

// Persistence (F1-05). The shell depends on the `Store` INTERFACE; the driver
// it constructs is its own choice. SqliteStore is the durable one — note that
// `node:sqlite` is experimental and its availability inside Electron is still
// to be verified in F1-02/SPIKE-04 (see sqlite-store.ts).
export type { McpEntry, SessionRef, Store } from './runtime/store/store.js';
export { MemoryStore } from './runtime/store/memory-store.js';
export { SqliteStore, type SqliteStoreOptions } from './runtime/store/sqlite-store.js';

export { runTurn, type RunTurnOptions } from './runtime/session.js';

export {
  AiSdkEngine,
  type AiSdkEngineDiagnostics,
  type AiSdkEngineOptions,
  type ModelResolver,
} from './engines/ai-sdk-engine.js';

export {
  apiKeyCredential,
  createModel,
  describeProviders,
  makeModelResolver,
  PROVIDER_KINDS,
  type CredentialResolver,
  type ProviderConfig,
  type ProviderCredential,
  type ProviderDescription,
  type ProviderKind,
  type ProviderProfile,
} from './providers/registry.js';
