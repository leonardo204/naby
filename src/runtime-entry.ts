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
  phase1HarnessFloor,
  scriptedPolicy,
  OBSERVATION_BUILTINS,
  DANGEROUS_BUILTINS,
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
export type {
  McpEntry,
  Project,
  SessionRef,
  Store,
  UsageRecord,
  // Scoped memory (Phase 1.5) — phase-1_5-memory-contracts §3–§6.
  InjectedMemory,
  MemoryDeleteSelector,
  MemoryInjectionQuery,
  MemoryItem,
  MemoryProvenance,
  MemoryScope,
  MemoryStatus,
  MemoryType,
  MemoryWriteDecision,
  MemoryWriteRequest,
  TrustTier,
  // Golden set (Phase 1.5 P15-04) — phase-1_5-personalization-data-layer §5.
  GoldenConsent,
  GoldenItem,
  GoldenItemInput,
} from './runtime/store/store.js';
export { MemoryStore } from './runtime/store/memory-store.js';
export { SqliteStore, type SqliteStoreOptions } from './runtime/store/sqlite-store.js';

export { runTurn, type RunTurnOptions } from './runtime/session.js';

// Phase 1.5 — the deterministic memory write gate (P15-05) and the turn-time
// retrieval/injection helpers (P15-02). The gate is pure; the store's putMemory
// runs it before a write lands. The injection helpers are what runTurn uses to
// assemble memory into a turn (and are exported so the shell can pre/post-inspect).
export { decideMemoryWrite } from './runtime/memory-gate.js';
export {
  composeSystemWithMemory,
  DEFAULT_USER_ID,
  estimateTokens,
  gatherCandidates,
  renderInjectedMemory,
  renderMemoryLine,
  retrieveForInjection,
  selectMemoryForInjection,
} from './runtime/memory-inject.js';

// F1-08 — the user's stored "which provider answers" choice, and the mapping
// from it to selectEngine's options (including where the env vars rank).
export {
  readSettings,
  SETTING_KEYS,
  toSelectOptions,
  writeSettings,
  type NabySettings,
} from './runtime/settings.js';

export {
  AiSdkEngine,
  type AiSdkEngineDiagnostics,
  type AiSdkEngineOptions,
  type ModelResolver,
} from './engines/ai-sdk-engine.js';

// The DEV engine (design §3.3). Exporting the class is safe even though the
// Agent SDK is excluded from packaged builds: this module imports the SDK
// LAZILY, by a runtime-resolved specifier, so nothing about it is bundled here
// and constructing the engine never loads it. See the header of
// engines/claude-agent-sdk-engine.ts for why that indirection is load-bearing.
export {
  AGENT_SDK_UNAVAILABLE_MESSAGE,
  ClaudeAgentSdkEngine,
  isClaudeAgentSdkAvailable,
  resolveClaudeAgentSdkPath,
  type ClaudeEngineDiagnostics,
} from './engines/claude-agent-sdk-engine.js';

// Whether the LOCAL Claude sign-in the dev engine runs on actually exists and
// is usable. Separate from `isClaudeAgentSdkAvailable` on purpose: that asks
// "is the code here", this asks "is the account here", and a machine can fail
// either one independently. Reads no credential material — see the module
// header for what it refuses to do.
export {
  checkClaudeAuthStatus,
  checkClaudeLogin,
  CLAUDE_LOGIN_COMMAND,
  claudeCredentialsPath,
  claudeLogin,
  claudeLogout,
  describeClaudeLogin,
  describeClaudeLoginAsync,
  getClaudeAuthState,
  getClaudeLoginState,
  resetClaudeLoginCache,
  resolveClaudeBinary,
  type CheckClaudeLoginOptions,
  type ClaudeLoginAccount,
  type ClaudeLoginOptions,
  type ClaudeLoginResult,
  type ClaudeLoginState,
  type ClaudeLoginStatus,
  type ClaudeLogoutResult,
} from './engines/claude-login.js';

// Which engine answers a turn, and the sentence that explains it to a user.
export {
  DEV_ENGINE_LABEL,
  ENGINE_ENV_VAR,
  noEngineMessage,
  preflightEngine,
  selectEngine,
  type CostBasis,
  type EngineId,
  type EnginePreflight,
  type EngineSelection,
  type SelectEngineOptions,
} from './engines/select.js';

// F1-07 — usage accounting and the price table behind the cost display.
export {
  costOfUsage,
  MODEL_PRICES,
  priceModel,
  PRICES_AS_OF,
  type ModelPrice,
} from './runtime/pricing.js';

export {
  formatTokens,
  formatUsd,
  summarizeSessionUsage,
  summarizeUsage,
  type ModelUsageBreakdown,
  type SessionUsageSummary,
} from './runtime/usage.js';

// F1-08 — MCP servers, loaded via listTools()/callTool() so every call is
// dispatched through a runtime Executor and therefore through the gate.
export {
  assertMcpToolsAreGateable,
  connectMcpServer,
  detectToolDrift,
  fingerprintTools,
  loadMcpToolset,
  qualifiedToolName,
  toRuntimeJsonSchema,
  validateMcpEntry,
  type McpConnection,
  type McpLoadResult,
} from './runtime/mcp.js';

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

// F1-04. The credential bridge and the provider resolution the shell's engine
// runs on. The SECRET never crosses this barrel as data — `getKey` is called on
// the far side of the bridge, in the same process, by the engine alone.
export {
  clearCredentialBridge,
  defaultProfileFor,
  getCredentialBridge,
  installCredentialBridge,
  missingConfigFields,
  NO_CREDENTIAL_MESSAGE,
  preflightProvider,
  resolveProviderCredential,
  type CredentialBridge,
  type CredentialSecurity,
  type CredentialSource,
  type PreflightResult,
  type ProviderResolution,
  type ResolvedProvider,
} from './providers/resolve.js';
