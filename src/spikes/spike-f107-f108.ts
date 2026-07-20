// src/spikes/spike-f107-f108.ts
//
// F1-07 (cost / usage) + F1-08 (provider selection + MCP), and the engine
// SELECTION logic that lets the app answer with no API key at all.
//
// NO KEYS, NO NETWORK, NO METERED COST. Everything here runs against either a
// scripted `MockLanguageModelV4` (the real production loop and gate, only the
// model is fake), fake environment keys that are never used to reach a network,
// or a REAL MCP server we spawn ourselves over stdio.
//
// ---------------------------------------------------------------------------
// WHAT THIS PROVES
// ---------------------------------------------------------------------------
//
// ENGINE SELECTION (the "usable with no API key" requirement)
//   (a1) NABY_ENGINE=dev-claude selects the dev engine when the Agent SDK
//        resolves.
//   (a2) ...and FAILS LOUDLY, with a readable message, when it does not — the
//        packaged-app case. It must never silently downgrade.
//   (a3) with no credential and no dev engine, selection fails with a message
//        that tells a non-developer what to click.
//   (a4) with no credential but a resolvable dev engine, the dev engine is
//        chosen automatically — this is the "just let me use the app" path.
//   (a5) a CONFIGURED PROVIDER WINS over the dev engine. Someone who entered a
//        key expects that provider to answer.
//
// PROVIDER SELECTION (F1-08 "two providers reachable", minus real keys)
//   (b1) two providers configured; the stored setting decides which one
//        resolves, and switching the setting switches the answer.
//
// USAGE + COST (F1-07)
//   (c1) a turn's usage is PERSISTED and survives a store reopen.
//   (c2) a priced metered model yields a plausible dollar figure, computed
//        from the published rate rather than invented.
//   (c3) an UNPRICED metered model yields tokens and NO dollar figure.
//   (c4) subscription turns yield NO dollar figure even though the engine
//        reported one, and say why.
//
// MCP THROUGH THE GATE (F1-08's load-bearing acceptance)
//   (d1) a real MCP server connects and its tools load via listTools().
//   (d2) the loaded toolset is GATEABLE: execute-less schemas, one executor each.
//   (d3) ALLOW: the MCP tool runs and its result comes back from the server.
//   (d4) DENY: the executor never runs AND THE SERVER IS NEVER CONTACTED —
//        proven by the server's own call log being empty, not merely by the
//        absence of a tool result on our side.
//
// Prints PASS/FAIL per assertion; exits non-zero on any FAIL.

import type {
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
} from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AiSdkEngine } from '../engines/ai-sdk-engine.js';
import {
  isClaudeAgentSdkAvailable,
  normalizeAgentSdkUsage,
} from '../engines/claude-agent-sdk-engine.js';
import { selectEngine } from '../engines/select.js';
import type { Executor, ToolSchema } from '../runtime/engine.js';
import { makeGate, scriptedPolicy } from '../runtime/gate.js';
import {
  assertMcpToolsAreGateable,
  loadMcpToolset,
} from '../runtime/mcp.js';
import { priceModel, costOfUsage } from '../runtime/pricing.js';
import { runTurn } from '../runtime/session.js';
import { SqliteStore } from '../runtime/store/sqlite-store.js';
import type { McpEntry, Store } from '../runtime/store/store.js';
import { readSettings, toSelectOptions, writeSettings } from '../runtime/settings.js';
import { summarizeSessionUsage } from '../runtime/usage.js';
import { clearCredentialBridge } from '../providers/resolve.js';

type Check = { name: string; pass: boolean; evidence: string };

const checks: Check[] = [];
function record(name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

const here = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER = resolve(here, 'fixtures/mcp-echo-server.mjs');

// ---------------------------------------------------------------------------
// Environment isolation
// ---------------------------------------------------------------------------
//
// Every selection assertion depends on the ambient environment, and a developer
// machine may well have NABY_ANTHROPIC_API_KEY or NABY_ENGINE exported. So the
// relevant variables are cleared up front and restored at the end — without
// this the spike would pass or fail based on whose laptop it ran on, which is
// exactly the load-dependent flakiness we are trying not to add.

const MANAGED_ENV = [
  'NABY_ENGINE',
  'NABY_PROVIDER',
  'NABY_MODEL',
  'NABY_DEV_MODEL',
  'NABY_ANTHROPIC_API_KEY',
  'NABY_OPENAI_API_KEY',
  'NABY_GOOGLE_API_KEY',
  'NABY_BEDROCK_API_KEY',
  'NABY_AZURE_OPENAI_API_KEY',
];

const savedEnv = new Map<string, string | undefined>();
function isolateEnv(): void {
  for (const k of MANAGED_ENV) {
    savedEnv.set(k, process.env[k]);
    delete process.env[k];
  }
  // A credential bridge installed by a previous spike in the same process would
  // answer ahead of the environment; make sure nothing is left over.
  clearCredentialBridge();
}
function restoreEnv(): void {
  for (const [k, v] of savedEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// ---------------------------------------------------------------------------
// A scripted model — the production AiSdkEngine loop with a fake model.
// ---------------------------------------------------------------------------

function usageOf(input: number, output: number, cacheRead = 0) {
  return {
    inputTokens: { total: input, noCache: input - cacheRead, cacheRead, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

// The mock carries a `modelId`, because the engine reports the model that
// ACTUALLY answered (see runTurn's `answeringModel`) rather than the one that
// was requested — so a mock that does not impersonate a real model id would be
// recorded, correctly, as an unpriced unknown model.
function textOnlyModel(
  text: string,
  input: number,
  output: number,
  modelId: string,
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId,
    doGenerate: async (_options: LanguageModelV4CallOptions) =>
      ({
        content: [{ type: 'text', text }],
        finishReason: { unified: 'stop', raw: 'end_turn' },
        usage: usageOf(input, output),
        warnings: [],
      }) as LanguageModelV4GenerateResult,
  });
}

/** A model that calls one named tool once, then finishes. */
function toolCallingModel(toolName: string, input: Record<string, unknown>): MockLanguageModelV4 {
  const steps: LanguageModelV4GenerateResult[] = [
    {
      content: [
        {
          type: 'tool-call',
          toolCallId: `call-${toolName}`,
          toolName,
          input: JSON.stringify(input),
        },
      ],
      finishReason: { unified: 'tool-calls', raw: 'tool_use' },
      usage: usageOf(10, 5),
      warnings: [],
    } as LanguageModelV4GenerateResult,
    {
      content: [{ type: 'text', text: 'done' }],
      finishReason: { unified: 'stop', raw: 'end_turn' },
      usage: usageOf(12, 4),
      warnings: [],
    } as LanguageModelV4GenerateResult,
  ];
  let i = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const step = steps[Math.min(i, steps.length - 1)];
      i += 1;
      return step as LanguageModelV4GenerateResult;
    },
  });
}

// ---------------------------------------------------------------------------
// (a) engine selection
// ---------------------------------------------------------------------------

async function checkSelection(): Promise<void> {
  const devReallyAvailable = isClaudeAgentSdkAvailable();

  // (a1) explicit dev-claude, SDK present.
  const a1 = await selectEngine({ forced: 'dev-claude', devEngineAvailable: () => true });
  record(
    '(a1) NABY_ENGINE=dev-claude selects the dev engine',
    a1.ok && a1.engine === 'dev-claude' && a1.costBasis === 'subscription',
    `ok=${a1.ok} engine=${a1.ok ? a1.engine : '-'} costBasis=${a1.ok ? a1.costBasis : '-'}; ` +
      `SDK actually resolvable here=${devReallyAvailable}`,
  );

  // (a2) explicit dev-claude, SDK absent — the PACKAGED APP case. Must fail
  // loudly rather than silently falling back.
  const a2 = await selectEngine({ forced: 'dev-claude', devEngineAvailable: () => false });
  record(
    '(a2) forced dev engine FAILS LOUDLY when the Agent SDK is absent (packaged build)',
    !a2.ok && a2.code === 'DEV_ENGINE_UNAVAILABLE' && a2.message.length > 80,
    !a2.ok ? `code=${a2.code} message="${a2.message.slice(0, 90)}…"` : 'unexpectedly ok',
  );

  // (a3) nothing configured, no dev engine.
  const a3 = await selectEngine({ devEngineAvailable: () => false });
  record(
    '(a3) no credential + no dev engine → readable NO_ENGINE_AVAILABLE',
    !a3.ok &&
      a3.code === 'NO_ENGINE_AVAILABLE' &&
      /Settings/.test(a3.message) &&
      /API key/.test(a3.message),
    !a3.ok ? `code=${a3.code} mentionsSettings=${/Settings/.test(a3.message)}` : 'unexpectedly ok',
  );

  // (a4) nothing configured, dev engine available → auto-select it.
  const a4 = await selectEngine({ devEngineAvailable: () => true });
  record(
    '(a4) no credential + dev engine available → dev engine chosen automatically',
    a4.ok && a4.engine === 'dev-claude',
    `ok=${a4.ok} engine=${a4.ok ? a4.engine : '-'} summary="${a4.ok ? a4.summary.slice(0, 70) : '-'}…"`,
  );

  // (a5) a configured provider WINS over the dev engine.
  process.env.NABY_ANTHROPIC_API_KEY = 'sk-ant-fake-not-a-real-key';
  const a5 = await selectEngine({ devEngineAvailable: () => true });
  delete process.env.NABY_ANTHROPIC_API_KEY;
  record(
    '(a5) a configured provider wins over the dev engine',
    a5.ok && a5.engine === 'ai-sdk' && a5.costBasis === 'metered',
    `ok=${a5.ok} engine=${a5.ok ? a5.engine : '-'}`,
  );
}

// ---------------------------------------------------------------------------
// (a6) the Agent SDK must never reach a shipped build
// ---------------------------------------------------------------------------
//
// THE HIGHEST-CONSEQUENCE, LOWEST-VISIBILITY REGRESSION IN THIS FEATURE.
//
// design §3.3 says the Agent SDK is never shipped, and `electron-builder.yml`
// excludes it from the package. But `scripts/build-runtime.mjs` bundles the
// runtime with `external: []` — EVERY static import is inlined. So the moment
// someone "tidies up" the lazy `import(pathToFileURL(...))` in
// claude-agent-sdk-engine.ts into an ordinary top-level import, the SDK gets
// baked into `dist/naby-runtime.mjs` and ships INSIDE our own artifact, sailing
// straight past the electron-builder exclusion.
//
// Nothing would fail. The app would work. The installer would just quietly grow
// by a non-OSS engine we are not licensed to redistribute — which is exactly
// the kind of mistake that is only ever found by someone auditing a release.
// So it is asserted here, against the real built artifact.

function checkBundleIsSdkFree(): void {
  const bundle = resolve(here, '../../dist/naby-runtime.mjs');
  if (!existsSync(bundle)) {
    record(
      '(a6) the built runtime bundle contains no Agent SDK code',
      false,
      `${bundle} does not exist — run \`npm run build:runtime\` first`,
    );
    return;
  }
  const text = readFileSync(bundle, 'utf8');

  // Markers that exist ONLY inside the SDK's own implementation.
  const sdkInternals = ['CLAUDE_CODE_ENTRYPOINT', 'claude_code_sdk'];
  const found = sdkInternals.filter((m) => text.includes(m));

  // A STATIC import would look like `from"@anthropic-ai/claude-agent-sdk"` or
  // `require("@anthropic-ai/claude-agent-sdk")` in the emitted file. Our own
  // runtime-resolved specifier is a bare string assignment, which does not.
  const staticImport =
    /from\s*["']@anthropic-ai\/claude-agent-sdk["']/.test(text) ||
    /require\(\s*["']@anthropic-ai\/claude-agent-sdk["']\s*\)/.test(text);

  record(
    '(a6) the built runtime bundle contains NO Agent SDK code and no static import of it',
    found.length === 0 && !staticImport,
    `bundle=${(text.length / 1024).toFixed(0)}KB; SDK internals found=[${found.join(', ')}] (must be empty); ` +
      `static import present=${staticImport} (must be false); ` +
      'the specifier appears only as a runtime-resolved string',
  );
}

// ---------------------------------------------------------------------------
// (b) provider selection via the stored setting
// ---------------------------------------------------------------------------

async function checkProviderSelection(store: Store): Promise<void> {
  // TWO providers "configured", via the documented environment fallback. These
  // keys are fake and are never used to reach a network — what is under test is
  // the SELECTION wiring, not the providers themselves.
  process.env.NABY_ANTHROPIC_API_KEY = 'sk-ant-fake';
  process.env.NABY_OPENAI_API_KEY = 'sk-openai-fake';

  writeSettings(store, { enginePreference: 'ai-sdk', selectedProvider: 'anthropic' });
  const first = await selectEngine({
    ...toSelectOptions(readSettings(store)),
    devEngineAvailable: () => true,
  });

  writeSettings(store, { enginePreference: 'ai-sdk', selectedProvider: 'openai' });
  const second = await selectEngine({
    ...toSelectOptions(readSettings(store)),
    devEngineAvailable: () => true,
  });

  const firstIsAnthropic = first.ok && /Anthropic/i.test(first.summary);
  const secondIsOpenAI = second.ok && /OpenAI/i.test(second.summary);

  record(
    '(b1) the stored provider choice decides which of two providers answers',
    firstIsAnthropic && secondIsOpenAI,
    `selected "anthropic" → "${first.ok ? first.summary.slice(0, 40) : '-'}…"; ` +
      `selected "openai" → "${second.ok ? second.summary.slice(0, 40) : '-'}…"`,
  );

  // Back to automatic so later checks are not affected.
  writeSettings(store, { enginePreference: '', selectedProvider: '' });
  delete process.env.NABY_ANTHROPIC_API_KEY;
  delete process.env.NABY_OPENAI_API_KEY;
}

// ---------------------------------------------------------------------------
// (c) usage + cost
// ---------------------------------------------------------------------------

async function checkUsage(dbPath: string): Promise<void> {
  const gate = makeGate(() => ({ behavior: 'allow' }));

  // -- (c1)+(c2) a PRICED metered model -----------------------------------
  let store: Store = new SqliteStore({ path: dbPath });
  const pricedSession = store.createSession('anthropic').sessionId;

  const pricedModel = textOnlyModel('hello', 1000, 500, 'claude-sonnet-4-5');
  await runTurn({
    engine: new AiSdkEngine({ resolveModel: () => pricedModel }),
    store,
    sessionId: pricedSession,
    model: { providerId: 'anthropic', model: 'claude-sonnet-4-5' },
    userText: 'hi',
    toolSchemas: [],
    executors: {},
    gate: gate.gate,
    engineId: 'ai-sdk',
    costBasis: 'metered',
  });
  store.close();

  // Reopen from disk — usage must be DURABLE, like everything else we own.
  store = new SqliteStore({ path: dbPath });
  const priced = summarizeSessionUsage(store, pricedSession);

  record(
    '(c1) per-turn usage is persisted, keyed to the model that ACTUALLY answered, and survives a reopen',
    priced.turns === 1 &&
      priced.inputTokens === 1000 &&
      priced.outputTokens === 500 &&
      priced.perModel[0]?.model === 'claude-sonnet-4-5',
    `turns=${priced.turns} input=${priced.inputTokens} output=${priced.outputTokens} ` +
      `model="${priced.perModel[0]?.model}" (from the engine's init event, reopened from disk)`,
  );

  // The expected figure is computed from the SAME published rate the display
  // uses, so this asserts the plumbing, and independently the rate is asserted
  // to be a real entry rather than a fallback.
  const rate = priceModel('anthropic', 'claude-sonnet-4-5');
  const expected = rate
    ? costOfUsage(rate, { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0 })
    : NaN;
  const plausible =
    priced.billedUsd !== undefined &&
    priced.billedComplete &&
    Math.abs(priced.billedUsd - expected) < 1e-9 &&
    priced.billedUsd > 0 &&
    priced.billedUsd < 1; // 1.5k tokens can never cost a dollar

  record(
    '(c2) a priced metered model yields a plausible cost from the published rate',
    plausible,
    `billedUsd=${priced.billedUsd} expected=${expected} complete=${priced.billedComplete} ` +
      `label="${priced.label}" (rate: $${rate?.inputPerMTok}/$${rate?.outputPerMTok} per MTok)`,
  );

  // -- (c3) an UNPRICED metered model --------------------------------------
  const unpricedSession = store.createSession('azure-openai').sessionId;
  const unpricedModel = textOnlyModel('hello', 300, 100, 'my-private-deployment');
  await runTurn({
    engine: new AiSdkEngine({ resolveModel: () => unpricedModel }),
    store,
    sessionId: unpricedSession,
    model: { providerId: 'azure-openai', model: 'my-private-deployment' },
    userText: 'hi',
    toolSchemas: [],
    executors: {},
    gate: gate.gate,
    engineId: 'ai-sdk',
    costBasis: 'metered',
  });
  const unpriced = summarizeSessionUsage(store, unpricedSession);
  record(
    '(c3) an unpriced model shows TOKENS and no invented dollar figure',
    unpriced.billedUsd === undefined &&
      unpriced.totalTokens === 400 &&
      !unpriced.billedComplete &&
      /cost unknown/i.test(unpriced.label),
    `billedUsd=${String(unpriced.billedUsd)} tokens=${unpriced.totalTokens} ` +
      `label="${unpriced.label}" unpriced=[${unpriced.unpricedModels.join(', ')}]`,
  );

  // -- (c4) a SUBSCRIPTION turn --------------------------------------------
  // The dev engine reports a `total_cost_usd`; it must NOT become a charge.
  const subSession = store.createSession('dev-claude').sessionId;
  store.appendUsage(subSession, {
    at: Date.now(),
    engine: 'dev-claude',
    providerId: 'dev-claude',
    model: 'claude-sonnet-4-5',
    inputTokens: 2000,
    outputTokens: 800,
    cachedInputTokens: 0,
    costBasis: 'subscription',
    reportedCostUsd: 0.0234,
  });
  const sub = summarizeSessionUsage(store, subSession);
  record(
    '(c4) a subscription turn shows NO cost even though the engine reported one',
    sub.billedUsd === undefined &&
      sub.subscriptionTurns === 1 &&
      /no metered cost/i.test(sub.label) &&
      sub.subscriptionEquivalentUsd === 0.0234,
    `billedUsd=${String(sub.billedUsd)} label="${sub.label}" ` +
      `engineReported=${sub.subscriptionEquivalentUsd} (surfaced separately, never as a charge)`,
  );

  // -- (c5) the dev engine's usage NORMALIZATION ---------------------------
  //
  // REGRESSION GUARD for a bug found by a real dev turn: Anthropic reports
  // `input_tokens` EXCLUDING cache reads/writes, while `ai` v7 reports a total
  // that INCLUDES them. Unnormalized, a 9.4k-token prompt was recorded as 4
  // input tokens with 9435 cached — which both looks absurd and, on a metered
  // provider, would under-price the turn by three orders of magnitude.
  //
  // The numbers below are the ACTUAL counts from that turn.
  const normalized = normalizeAgentSdkUsage({
    input_tokens: 4,
    output_tokens: 99,
    cache_read_input_tokens: 9435,
    cache_creation_input_tokens: 0,
  });
  record(
    '(c5) Agent SDK usage is normalized so cached tokens are a SUBSET of input',
    normalized.inputTokens === 9439 &&
      normalized.cachedInputTokens === 9435 &&
      normalized.outputTokens === 99 &&
      (normalized.cachedInputTokens ?? 0) <= (normalized.inputTokens ?? 0),
    `raw{input:4, cacheRead:9435} -> normalized{input:${normalized.inputTokens}, ` +
      `cached:${normalized.cachedInputTokens}} (contract: cached <= input)`,
  );

  store.close();
}

// ---------------------------------------------------------------------------
// (d) MCP through the gate
// ---------------------------------------------------------------------------

async function checkMcp(dbPath: string, logPath: string): Promise<void> {
  const entry: McpEntry = {
    name: 'spike',
    transport: 'stdio',
    command: process.execPath,
    args: [MCP_SERVER],
    env: { NABY_SPIKE_MCP_LOG: logPath },
  };

  const load = await loadMcpToolset([entry]);
  try {
    const names = load.toolSchemas.map((t) => t.name);
    record(
      '(d1) a real MCP server connects and its tools load via listTools()',
      load.failures.length === 0 &&
        names.includes('spike__mcp_echo') &&
        names.includes('spike__mcp_danger'),
      `failures=${load.failures.length} tools=[${names.join(', ')}] ` +
        `server=${load.connections[0]?.serverInfo.name ?? '?'} ` +
        `fingerprint=${load.connections[0]?.fingerprint ?? '?'}`,
    );

    const problems = assertMcpToolsAreGateable(load);
    record(
      '(d2) the loaded MCP toolset is gateable: execute-less schemas, one executor each',
      problems.length === 0,
      problems.length === 0
        ? `${load.toolSchemas.length} schema(s), none carrying an execute; every one has a runtime executor`
        : problems.join('; '),
    );

    // -- drive real turns through the runtime --------------------------------
    const store: Store = new SqliteStore({ path: dbPath });
    const toolSchemas: ToolSchema[] = load.toolSchemas;
    const executors: Record<string, Executor> = load.executors;

    // (d3) ALLOW — the MCP tool runs and the server answers.
    const allowSession = store.createSession('mock').sessionId;
    const allowGate = makeGate(scriptedPolicy({ spike__mcp_echo: { behavior: 'allow' } }));
    const allowEvents = await runTurn({
      engine: new AiSdkEngine({
        resolveModel: () => toolCallingModel('spike__mcp_echo', { text: 'through-the-gate' }),
      }),
      store,
      sessionId: allowSession,
      model: { providerId: 'mock', model: 'mock-model' },
      userText: 'echo please',
      toolSchemas,
      executors,
      gate: allowGate.gate,
    });

    const allowResult = allowEvents.find(
      (e) => e.kind === 'tool_result' && e.toolName === 'spike__mcp_echo',
    );
    const allowText =
      allowResult && allowResult.kind === 'tool_result' ? allowResult.output.content : '';
    const gateRanFirst =
      allowGate.log.length > 0 && allowGate.log[0]?.toolName === 'spike__mcp_echo';

    record(
      '(d3) ALLOW: the MCP tool is callable THROUGH the gate and the server answers',
      gateRanFirst && allowText === 'mcp-echo:through-the-gate',
      `gate saw "${allowGate.log[0]?.toolName}" → ${allowGate.log[0]?.decision.behavior}; ` +
        `server returned "${allowText}"`,
    );

    // (d4) DENY — the server must never be contacted at all.
    const logBefore = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    const denySession = store.createSession('mock').sessionId;
    const denyGate = makeGate(
      scriptedPolicy({
        spike__mcp_danger: { behavior: 'deny', reason: 'irreversible; denied by spike policy' },
      }),
    );
    await runTurn({
      engine: new AiSdkEngine({
        resolveModel: () => toolCallingModel('spike__mcp_danger', { target: 'production' }),
      }),
      store,
      sessionId: denySession,
      model: { providerId: 'mock', model: 'mock-model' },
      userText: 'do the dangerous thing',
      toolSchemas,
      executors,
      gate: denyGate.gate,
    });
    const logAfter = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    const dangerCalls = logAfter
      .split('\n')
      .filter((l) => l.includes('mcp_danger')).length;

    record(
      '(d4) DENY: the MCP SERVER is never contacted (its own call log stays empty)',
      dangerCalls === 0 &&
        denyGate.log.some((l) => l.decision.behavior === 'deny') &&
        logAfter.length === logBefore.length,
      `gate decision=${denyGate.log[0]?.decision.behavior}; ` +
        `mcp_danger invocations recorded BY THE SERVER=${dangerCalls} (must be 0); ` +
        `server log bytes before=${logBefore.length} after=${logAfter.length}`,
    );

    store.close();
  } finally {
    await load.closeAll();
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('\n=== SPIKE-F107/F108 — cost/usage, provider selection, MCP through the gate ===\n');

  isolateEnv();
  const dir = mkdtempSync(join(tmpdir(), 'naby-f107-'));
  const dbPath = join(dir, 'app.db');
  const usageDb = join(dir, 'usage.db');
  const logPath = join(dir, 'mcp-calls.log');
  writeFileSync(logPath, '');

  try {
    await checkSelection();
    checkBundleIsSdkFree();

    const settingsStore: Store = new SqliteStore({ path: dbPath });
    await checkProviderSelection(settingsStore);
    settingsStore.close();

    await checkUsage(usageDb);
    await checkMcp(dbPath, logPath);
  } finally {
    restoreEnv();
    rmSync(dir, { recursive: true, force: true });
  }

  let failed = 0;
  for (const c of checks) {
    if (!c.pass) failed += 1;
    console.log(`[${c.pass ? 'PASS' : 'FAIL'}] ${c.name}`);
    console.log(`        evidence: ${c.evidence}`);
  }
  const total = checks.length;
  console.log(
    `\nSPIKE-F107/F108: ${failed === 0 ? `ALL PASS (${total}/${total})` : `${total - failed}/${total} passed, ${failed} FAILED`}\n`,
  );
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error('SPIKE-F107/F108 threw:', e);
  process.exit(1);
});
