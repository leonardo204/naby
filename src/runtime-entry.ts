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
  SubagentSpec,
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

// Phase 2 (M1) — the real tool-execution decision policy. `realPolicy` resolves
// the user's stored PolicyRules and falls back to a baseline; the shell swaps it
// in for the interim `allowChanges ? allow-all : floor` ternary.
export {
  realPolicy,
  resolvePolicyEffect,
  matchToolPattern,
  normalizeToolName,
} from './runtime/policy.js';

export {
  buildToolset,
  echoNote,
  echoNoteSchema,
  makeSendMessage,
  Outbox,
  sendMessageSchema,
  // naby_add_mcp — the agent registers an MCP server (as a proposal).
  makeAddMcp,
  addMcpSchema,
  ADD_MCP_TOOL_NAME,
  type McpProposalSink,
  // naby_remember — the agent captures what it learned about the user (P3-M4a).
  // Every capture lands as a PROPOSAL; only a human confirm makes it injectable.
  makeRemember,
  rememberSchema,
  REMEMBER_TOOL_NAME,
  MEMORY_VALUE_MAX,
  normalizeMemoryKey,
  looksLikeSecret,
  resolveMemoryScopeKey,
  validateRememberInput,
  type MemoryLearningSink,
  // naby_checkin — the agent pauses and asks how to proceed (P3-M5). The answer
  // is the trust meter's label; the agent is never told how it scored.
  makeCheckin,
  checkinSchema,
  type CheckinSink,
  type CheckinLedgerRow,
  // fetch_url — the model reads a public web page/API.
  makeFetchUrl,
  fetchUrlSchema,
  isBlockedFetchHost,
  htmlToText,
  type OutboxEntry,
} from './runtime/tools.js';

// The WORKSPACE toolset — read/search/edit/run over the open project, so a turn
// on ANY provider can look at the code instead of asking the user to paste it.
// Merged alongside MCP in the shell rather than folded into `buildToolset`,
// because it needs a `cwd` and a permission mode that only the composition root
// knows. `MUTATING_TOOLS` is what the gate floor keys on.
export {
  buildWorkspaceTools,
  MUTATING_TOOLS,
  READONLY_TOOLS,
  makeReadFile,
  makeListDir,
  makeGlob,
  makeGrep,
  makeWriteFile,
  makeEditFile,
  makeRunCommand,
  readFileSchema,
  listDirSchema,
  globSchema,
  grepSchema,
  writeFileSchema,
  editFileSchema,
  runCommandSchema,
} from './runtime/fs-tools.js';

// Persistence (F1-05). The shell depends on the `Store` INTERFACE; the driver
// it constructs is its own choice. SqliteStore is the durable one — note that
// `node:sqlite` is experimental and its availability inside Electron is still
// to be verified in F1-02/SPIKE-04 (see sqlite-store.ts).
export { isMcpEntryActive } from './runtime/store/store.js';
export type {
  McpEntry,
  McpStatus,
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
  // Owned harness (Phase 1.6 HP-01) — phase-1_6-harness-contracts §2–§6. The
  // shell (HP-02+) builds command/skill/subagent CRUD + review on these.
  HarnessKind,
  HarnessScope,
  HarnessTrust,
  HarnessStatus,
  HarnessProvenance,
  HarnessItem,
  HarnessImportRequest,
  HarnessImportDecision,
  HarnessSet,
  HarnessRemoveSelector,
  // Tool-execution policy (Phase 2, M1) — the shell builds a permissions CRUD
  // surface on these and gathers rules per turn for `realPolicy`.
  PolicyEffect,
  PolicyRule,
  PolicyRuleInput,
  // naby agents (Phase 3, P3-M1) — the naby-owned agent layer (built-in persona
  // + custom agents), addressed by `@`. The shell builds an "Agents" Settings
  // section and `/api/agents` CRUD on these.
  Agent,
  AgentInput,
  AgentKind,
  AgentEscalation,
  AgentAutonomy,
  // The eval-event ledger (Phase 3, P3-M5) — realizes the stream P15-03 reserved.
  // The shell appends check-in / autonomous / tripwire observations here and the
  // trust meter reads them. NEVER exposed to the agent itself.
  EvalEvent,
  EvalEventInput,
  EvalEventKind,
  EvalEventDeleteSelector,
  // The reflection cursor (Phase 3, P3-M8a) — how far the session-reflection
  // pass has read one session's transcript.
  ReflectionCursor,
  // Cross-session corroboration (Phase 3, P3-M8b) — which DISTINCT sessions
  // agree with a memory item's CURRENT value. Written by putMemory, never by a
  // caller; reset when the value materially changes.
  MemoryObservation,
} from './runtime/store/store.js';
// The "is this the same claim" test corroboration resets on. Exported because a
// caller that needs to predict whether a write will clear the evidence (the
// review UI, a spike) must ask the same question the store asks.
export { sameMemoryValue } from './runtime/store/store.js';
export { MemoryStore } from './runtime/store/memory-store.js';
export { SqliteStore, type SqliteStoreOptions } from './runtime/store/sqlite-store.js';

export { runTurn, type RunTurnOptions } from './runtime/session.js';

// Phase 3 P3-M1 — the naby agent layer's built-in PERSONA seed + helpers. The
// shell seeds the persona at its composition root (idempotent) so a fresh install
// always has exactly one persona to address with `@`.
export {
  BUILTIN_PERSONA_ID,
  BUILTIN_PERSONA_NAME,
  BUILTIN_PERSONA_SEED,
  isBuiltinPersona,
  parseAgentAddress,
  seedBuiltinPersona,
} from './runtime/agents.js';

// Phase 1.5 — the deterministic memory write gate (P15-05) and the turn-time
// retrieval/injection helpers (P15-02). The gate is pure; the store's putMemory
// runs it before a write lands. The injection helpers are what runTurn uses to
// assemble memory into a turn (and are exported so the shell can pre/post-inspect).
export { decideMemoryWrite } from './runtime/memory-gate.js';
// Phase 1.6 HP-01 — the deterministic harness IMPORT gate. Pure; the store's
// putHarnessItem/importHarnessSet run it before an import lands. Exported so the
// shell (HP-06 review UI) can pre-inspect an import decision.
export { decideHarnessImport } from './runtime/harness-gate.js';
export {
  composeSystemWithMemory,
  DEFAULT_USER_ID,
  estimateTokens,
  gatherCandidates,
  relevanceScore,
  renderInjectedMemory,
  renderMemoryLine,
  retrieveForInjection,
  selectMemoryForInjection,
  tokenizeForRelevance,
} from './runtime/memory-inject.js';
// Phase 1.6 HP-03a — turn-time SKILL instruction injection. Pure trigger-match +
// budget selection + assembly, mirroring the memory helpers; what runTurn uses to
// inject enabled, instruction-only skills into a turn (exported so the shell can
// pre/post-inspect a selection). Tool-bearing skills are excluded here (Phase 2.5).
export {
  composeSystemWithSkills,
  gatherSkillCandidates,
  isInstructionOnly,
  renderInjectedSkills,
  renderSkillBlock,
  retrieveSkillsForInjection,
  selectSkillsForInjection,
  skillMatchesTurn,
  skillToolsSatisfied,
  type InjectedSkills,
  type SkillInjectionQuery,
} from './runtime/skill-inject.js';

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
  // Asks the LOCAL sign-in which models it may use, so the chat bar's list is not
  // a constant that goes stale the day a new model ships.
  readTextDelta,
  readThinkingDelta,
  probeClaudeModels,
  MODEL_PROBE_TIMEOUT_MS,
  MODEL_PROBE_RETRY_TIMEOUT_MS,
  type ClaudeEngineDiagnostics,
  type ClaudeModelInfo,
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
  CHATGPT_OAUTH_COST_BASIS,
  CHATGPT_OAUTH_LABEL,
  DEV_ENGINE_LABEL,
  ENGINE_ENV_VAR,
  isChatgptOauthAvailable,
  noEngineMessage,
  preflightEngine,
  selectEngine,
  type CostBasis,
  type EngineId,
  type EnginePreflight,
  type EngineSelection,
  type SelectEngineOptions,
} from './engines/select.js';

// DEV-ONLY, FLAG-SEALED ChatGPT subscription-OAuth (spec chatgpt-oauth-dev-provider).
// Exported pure core: PKCE, JWT account-id extraction, query-header assembly,
// store:false injection, expiry/refresh-rotation, the runtime flag gate, and the
// custom transport fetch. Constructing anything here is inert unless the seal is
// open (`isChatgptOauthEnabled`); with the flag off — the default — the provider
// is never OFFERED (describeProviders/isChatgptOauthAvailable), so this is dead
// code in an official build. NOTHING here claims OpenAI endorsement.
export {
  applyRefreshResponse,
  base64UrlEncode,
  buildAuthorizeUrl,
  buildQueryHeaders,
  buildRefreshBody,
  buildTokenExchangeBody,
  CHATGPT_AUTHORIZE_URL,
  CHATGPT_CALLBACK_FALLBACK_PORT,
  CHATGPT_CALLBACK_PATH,
  CHATGPT_CALLBACK_PORT,
  CHATGPT_CLIENT_ID,
  CHATGPT_OAUTH_DEFAULT_MODEL,
  CHATGPT_OAUTH_ENABLE_FLAG,
  CHATGPT_OAUTH_PROVIDER_ID,
  CHATGPT_ORIGINATOR,
  CHATGPT_QUERY_BASE_URL,
  CHATGPT_REVOKE_URL,
  CHATGPT_SCOPE,
  CHATGPT_TOKEN_URL,
  decodeJwtPayload,
  expiresAtFrom,
  extractAccountId,
  extractEmail,
  extractExpiryMs,
  extractIsFedramp,
  forceStoreFalse,
  generatePkce,
  generateState,
  getChatgptOauthBridge,
  getChatgptTokenSource,
  installChatgptOauthBridge,
  installChatgptTokenSource,
  isChatgptOauthEnabled,
  isPermanentRefreshFailure,
  isTokenExpired,
  makeChatgptFetch,
  PERMANENT_REFRESH_FAILURES,
  REFRESH_SKEW_MS,
  tokensFromExchange,
  type ChatgptFetchOptions,
  type ChatgptOauthBridge,
  type ChatgptOauthStatusLabels,
  type ChatgptOauthTokens,
  type ChatgptTokenResponse,
  type ChatgptTokenSource,
  type PkcePair,
  type QueryHeaderOptions,
} from './providers/chatgpt-oauth.js';

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
  type McpToolAnnotations,
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

// -- the butterfly trust meter (Phase 3, P3-M5) ------------------------------
// Pure arithmetic: Wilson bound, stage thresholds, ADWIN-style change detection,
// coverage, and the deterministic regression diagnosis. Reason codes are
// structured so the shell renders them per locale.
export {
  wilsonLowerBound,
  stageFor,
  brierScore,
  askDecisionQuality,
  BRIER_UNINFORMATIVE,
  canBeAddressed,
  computeGrowth,
  detectChangePoint,
  diagnoseChange,
  GROWTH_MIN_SAMPLE,
  GROWTH_WINDOW,
  IMPLICIT_WEIGHT,
  IMPLICIT_WINDOW,
  PUPA_THRESHOLD,
  BUTTERFLY_THRESHOLD,
  type GrowthStage,
  type GrowthState,
  type GrowthChange,
  type GrowthReasonCode,
  type AskQuality,
  type CheckinRecord,
  type LedgerKind,
} from './runtime/growth.js';

// -- cold start (Phase 1.5, P15-07) ------------------------------------------
// The onboarding interview: four durable questions whose answers become CONFIRMED
// user-tier memory, because the user typed them in answer to a direct question.
// Path B of the strategy's three, chosen for coverage — C needs an org someone
// curated and A needs artifacts, while a genuinely new user has neither.
export {
  BOOTSTRAP_QUESTIONS,
  BOOTSTRAP_DONE_KEY,
  BOOTSTRAP_ANSWER_MAX,
  answersToMemory,
  shouldOfferBootstrap,
  type BootstrapQuestion,
  type BootstrapWriteSet,
  type BootstrapSkipReason,
} from './runtime/bootstrap.js';

// -- naby_delegate (Phase 2.5, M4b) ------------------------------------------
// Subagents on an engine with no native ones: the AI-SDK path IGNORED
// SubagentSpec, so which engine was selected silently changed what the app could
// do. The nested turn runs behind the SAME gate, `toolRefs` only ever narrows, and
// depth is capped.
export {
  makeDelegate,
  delegateSchema,
  canDelegate,
  findSubagent,
  validateDelegateInput,
  DELEGATE_TOOL_NAME,
  MAX_DELEGATION_DEPTH,
  DELEGATE_TASK_MAX,
  type DelegationSink,
  type DelegationResult,
} from './runtime/delegate.js';

// -- taking a grown agent with you (Phase 3, P3-M6) --------------------------
// Pure packaging: a stock Claude Code subagent `.md` (learned facts inlined, so
// one file is enough) plus a lossless `.naby.json` sidecar. `proposed`, `session`
// and credential-shaped rows never leave, and every drop is counted for the user.
export {
  buildAgentExport,
  exportBasename,
  memoryDropReason,
  yamlScalar,
  AGENT_EXPORT_FORMAT_VERSION,
  LEARNED_HEADING,
  REDACTED,
  type AgentExportInput,
  type AgentExportReport,
  type AgentExportResult,
  type MemoryDropReason,
} from './runtime/agent-export.js';

// -- bringing an agent in (Phase 3, P3-M7) -----------------------------------
// The other half of the export, and the place its central claim is enforced: a
// file cannot declare trust. An imported ledger lands flagged `imported` (which
// every growth axis ignores) unless the user says the file is their own export.
// Memory always arrives external-tier and proposed, whatever the file says.
export {
  parseAgentSidecar,
  freeAgentName,
  type AgentImportOptions,
  type AgentImportPlan,
  type AgentImportReport,
  type AgentImportResult,
} from './runtime/agent-import.js';

// -- the check-in itself (Phase 3, P3-M5) ------------------------------------
// What the meter measures: the agent's own proposal, the user's pick, and the
// deterministic rules that keep a padded or repeated question from counting.
// `classifyToolConsequence` is the classifier the gate path shares, so "when a
// check-in was owed" is decided by the action, never by the agent.
export {
  CHECKIN_TOOL_NAME,
  CHECKIN_MIN_OPTIONS,
  CHECKIN_MAX_OPTIONS,
  CHECKIN_QUESTION_MAX,
  CONSEQUENTIAL_RUNTIME_TOOLS,
  OBSERVATION_RUNTIME_TOOLS,
  DEGENERATE_SIMILARITY,
  classifyToolConsequence,
  isConsequentialTool,
  isReversibleAction,
  validateCheckinInput,
  normalizeCheckinQuestion,
  questionSimilarity,
  degenerateReason,
  scoreCheckin,
  shouldRecord,
  type CheckinQuestion,
  type CheckinAnswer,
  type DegenerateCode,
  type ToolConsequence,
  type ToolConsequenceSignals,
} from './runtime/checkin.js';

// -- session reflection (Phase 3, P3-M8a) ------------------------------------
// The pure half of the pass that finally WRITES `correctedAfter`: which idle
// session is worth looking back at, which autonomous actions to put to a judge,
// and the validator that throws away any verdict whose evidence the user did not
// actually type. The model can lower the agent's score, never invent a reason to.
//
// M8b adds the second task the same call performs: memory PROPOSALS, held to the
// same standard (a quote the user really typed, then the very guards
// `naby_remember` applies), and the corroboration threshold the opt-in
// consolidation step measures against.
export {
  REFLECTION_IDLE_MS,
  REFLECTION_SWEEP_CAP,
  REFLECTION_MESSAGE_CAP,
  REFLECTION_LATER_MESSAGE_CAP,
  REFLECTION_MESSAGE_CHARS,
  REFLECTION_CASE_CAP,
  REFLECTION_USER_MESSAGE_CAP,
  REFLECTION_MEMORY_CAP,
  REFLECTION_MEMORY_SCOPES,
  REFLECTION_MIN_USER_MESSAGES,
  CORROBORATION_THRESHOLD,
  isSessionDueForReflection,
  buildReflectionCases,
  collectReflectionUserMessages,
  countUserMessagesSince,
  shouldExtractMemoryOnly,
  validateReflectionVerdicts,
  validateMemoryCandidates,
  shouldAutoConfirmMemory,
  normalizeReflectionAnswer,
  buildReflectionPrompt,
  parseReflectionVerdicts,
  parseReflectionAnswer,
  type ReflectionCase,
  type ReflectionVerdict,
  type ReflectionJudge,
  type ReflectionPrompt,
  type ReflectionValidation,
  type ReflectionSessionRef,
  type ReflectionLedgerRow,
  type ReflectionCaseInput,
  type ReflectionAnswer,
  type ReflectionMemoryCandidate,
  type ReflectionSessionContext,
  type ReflectionUserMessage,
  type ValidatedMemoryCandidate,
  type MemoryCandidateValidation,
  type AutoConfirmCandidate,
} from './runtime/reflection.js';
