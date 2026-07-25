// src/spikes/spike-learn.ts
//
// Phase 3 (P3-M4) verification: THE LEARNING LOOP, closed end to end.
//
// NO NETWORK, NO KEYS. Same seam as SPIKE-02 / spike-autonomy: the real shell
// EngineSpec drives the real AiSdkEngine, the real tool gate and the real
// executors, with only the language model mocked. So what runs here is the
// production capture path, not a simulation of it.
//
// The loop this proves (personalization-strategy §3.2 — the three stages that
// were empty):
//
//   turn 1  agent calls naby_remember  →  write gate  →  row lands as PROPOSED
//           …and is NOT injected, because only confirmed memory injects
//   review  the user confirms it (the /api/memory action's store call)
//   turn 2  the same fact arrives in the system prompt, without being re-taught
//
// Asserted, by execution:
//   (a) A routed agent HAS `naby_remember`; a plain turn does not (the tool is
//       only built for an agent — a normal turn is unchanged by M4).
//   (b) A capture lands as `proposed` with provenance source 'artifact' (NOT
//       'user' — the model reporting a preference is not the user stating it).
//   (c) A proposed row does NOT reach the next turn's prompt. This is the
//       poisoning defence: capture cannot shape an answer on its own.
//   (d) After the user confirms it, the SAME fact appears in the next turn's
//       system prompt — the loop is closed.
//   (e) Secret-shaped values are refused, and nothing is written.
//   (f) 'org' scope is refused to an agent; a projectless turn cannot write
//       'project' scope (and says so rather than writing it somewhere else).
//   (g) The learning instruction is injected for a routed agent and absent for
//       a plain turn.
//
// Prints PASS/FAIL per assertion; exits non-zero on any FAIL.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP_DIR = mkdtempSync(join(tmpdir(), 'naby-spike-learn-'));
process.env.NABY_DB_PATH = join(TMP_DIR, 'app.db');

import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';

import {
  createNabySpec,
  getStore,
} from '../../shell/packages/feature/agent/src/server/engines/naby.js';
import type {
  RunCtx,
  RunEvent,
} from '../../shell/packages/feature/agent/src/server/engines/types.js';
import type { MemoryItem, ModelResolver } from '../runtime-entry.js';

type Check = { name: string; pass: boolean; evidence: string };
function record(checks: Check[], name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

// ---------------------------------------------------------------------------
// Scripted model
// ---------------------------------------------------------------------------

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function rememberCall(
  id: string,
  args: Record<string, unknown>,
): LanguageModelV4GenerateResult {
  return {
    content: [
      {
        type: 'tool-call',
        toolCallId: id,
        toolName: 'naby_remember',
        input: JSON.stringify(args),
      },
    ],
    finishReason: { unified: 'tool-calls', raw: 'tool_use' },
    usage: USAGE,
    warnings: [],
  };
}

function text(t: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text: t }],
    finishReason: { unified: 'stop', raw: 'end_turn' },
    usage: USAGE,
    warnings: [],
  };
}

type Scripted = {
  model: MockLanguageModelV4;
  /** Every prompt payload handed to the model, JSON-stringified. */
  prompts: string[];
  /** Tool names the model was OFFERED on the last call. */
  offeredTools: string[];
};

function scripted(script: LanguageModelV4GenerateResult[]): Scripted {
  const prompts: string[] = [];
  const s: Scripted = { model: null as unknown as MockLanguageModelV4, prompts, offeredTools: [] };
  let i = 0;
  s.model = new MockLanguageModelV4({
    doGenerate: async (options: unknown): Promise<LanguageModelV4GenerateResult> => {
      prompts.push(JSON.stringify(options ?? {}));
      const tools = (options as { tools?: Array<{ name?: string }> } | undefined)?.tools;
      if (Array.isArray(tools)) s.offeredTools = tools.map((t) => String(t?.name ?? ''));
      const next = script[i];
      i += 1;
      return next ?? text('(unscripted extra call)');
    },
  });
  return s;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Harness = { ctx: RunCtx; events: RunEvent[]; sessionId: () => string };

function makeHarness(prompt: string, cwd: string | undefined): Harness {
  const events: RunEvent[] = [];
  const controller = new AbortController();
  let key = 'provisional-run-key';
  const ctx: RunCtx = {
    prompt,
    images: undefined,
    cwd: cwd ?? '',
    sessionId: undefined,
    params: { prompt, engine: 'naby' },
    signal: controller.signal,
    emit(event: RunEvent): void {
      events.push(event);
    },
    rekey(realSessionId: string): void {
      key = realSessionId;
    },
    currentKey(): string {
      return key;
    },
  };
  return { ctx, events, sessionId: () => key };
}

async function runOnce(
  prompt: string,
  script: LanguageModelV4GenerateResult[],
  opts?: { cwd?: string; sessionId?: string },
): Promise<{ h: Harness; s: Scripted }> {
  const h = makeHarness(prompt, opts?.cwd);
  if (opts?.sessionId) (h.ctx as { sessionId?: string }).sessionId = opts.sessionId;
  const s = scripted(script);
  const resolveModel: ModelResolver = () => s.model;
  await createNabySpec({ resolveModel }).runner.run(h.ctx);
  return { h, s };
}

/** The text of every tool_result block the turn emitted. */
function toolResults(events: RunEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (String(e.type ?? '') !== 'user') continue;
    const content = (e.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      const block = b as { tool_use_id?: string; content?: unknown };
      if (block.tool_use_id) out.push(String(block.content ?? ''));
    }
  }
  return out;
}

function makeAgent(name: string, scope: 'session' | 'project' | 'user' | 'org'): string {
  getStore().putAgent({
    name,
    kind: 'custom',
    systemPrompt: `You are ${name}.`,
    memoryScope: scope,
    autonomy: { escalation: 'inline' },
  });
  return `@${name} remember that I prefer metric units.`;
}

function allMemory(scope: 'session' | 'project' | 'user', scopeKey: string): MemoryItem[] {
  return getStore().getScopedMemory(scope, scopeKey);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const checks: Check[] = [];
  const USER_KEY = 'local';

  // ==== Turn 1: the agent captures a preference ============================
  const prompt1 = makeAgent('learner', 'user');
  const { h: h1, s: s1 } = await runOnce(
    prompt1,
    [
      rememberCall('r1', {
        key: 'Prefers Metric Units',
        value: 'Wants distances and weights in metric units.',
        type: 'semantic',
      }),
      text('Noted.'),
    ],
    { cwd: TMP_DIR },
  );

  record(
    checks,
    '(a) a routed agent is offered naby_remember',
    s1.offeredTools.includes('naby_remember'),
    `tools offered: ${JSON.stringify(s1.offeredTools)}`,
  );
  record(
    checks,
    '(g) the learning instruction is injected for a routed agent',
    s1.prompts.every((p) => p.includes('LEARNING:')) && s1.prompts.length === 2,
    `prompts with the instruction: ${s1.prompts.filter((p) => p.includes('LEARNING:')).length}/${s1.prompts.length}`,
  );

  const userMem = allMemory('user', USER_KEY);
  const row = userMem.find((m) => m.key === 'prefers-metric-units');
  record(
    checks,
    '(b) the capture landed as PROPOSED, artifact-tier, key slugified',
    !!row && row.status === 'proposed' && row.provenance.source === 'artifact',
    row
      ? `key=${row.key} status=${row.status} source=${row.provenance.source} basis=${row.provenance.basis ?? ''}`
      : `no row; user memory = ${JSON.stringify(userMem.map((m) => m.key))}`,
  );
  record(
    checks,
    '(b2) the tool told the model it is a proposal, not a live fact',
    toolResults(h1.events).some((t) => /PROPOSAL/.test(t) && /confirm/i.test(t)),
    `tool results: ${JSON.stringify(toolResults(h1.events).map((t) => t.slice(0, 70)))}`,
  );

  // ==== Turn 2: a proposed row must NOT be injected ========================
  const { s: s2 } = await runOnce('@learner what units do I use?', [text('Not sure yet.')], {
    cwd: TMP_DIR,
  });
  record(
    checks,
    '(c) a PROPOSED memory does not reach the next turn (only confirmed injects)',
    s2.prompts.every((p) => !p.includes('Wants distances and weights in metric units')),
    `prompts mentioning the unconfirmed fact: ${s2.prompts.filter((p) => p.includes('Wants distances')).length}`,
  );

  // ==== Review: the user confirms it, then turn 3 sees it ==================
  if (row) getStore().confirmMemory(row.id);
  const { s: s3 } = await runOnce('@learner what units do I use?', [text('Metric.')], {
    cwd: TMP_DIR,
  });
  record(
    checks,
    '(d) after the user confirms, the fact arrives in the next turn — loop closed',
    s3.prompts.some((p) => p.includes('Wants distances and weights in metric units')),
    `prompts carrying the confirmed fact: ${s3.prompts.filter((p) => p.includes('Wants distances')).length}/${s3.prompts.length}`,
  );

  // ==== A plain (unrouted) turn belongs to the PERSONA (changed in P3-M5) ===
  //
  // M4a attached learning only to a routed turn, and this check asserted that. It
  // was reversed on purpose: combined with M5's mention gate it deadlocked — the
  // persona cannot be `@`-addressed until it is a butterfly, and it could not
  // learn or check in unless it was addressed, so it could never become one.
  // Observation now follows the persona onto ordinary turns (`growthSubject`);
  // ADDRESSING it is still what has to be earned.
  const { s: s4 } = await runOnce('what units do I use?', [text('Metric.')], { cwd: TMP_DIR });
  record(
    checks,
    '(a2) a plain turn IS the persona\'s turn: it gets the tool and the instruction',
    s4.offeredTools.includes('naby_remember') && s4.prompts.some((p) => p.includes('LEARNING:')),
    `tools: ${JSON.stringify(s4.offeredTools)}; instruction present: ${s4.prompts.some((p) => p.includes('LEARNING:'))}`,
  );

  // ==== Secrets are refused ================================================
  const before = allMemory('user', USER_KEY).length;
  const { h: h5 } = await runOnce(
    '@learner remember my token',
    [
      rememberCall('r2', {
        key: 'api-token',
        // Synthetic on purpose: shaped like a key so looksLikeSecret fires, but
        // self-evidently not one, so no scanner (or reader) mistakes it for a leak.
        // Deliberately HYPHENATED in the token body — that is the shape of a real
        // Slack token (`xoxb-123-456-abc`), and an earlier version of the detector
        // required an unbroken alphanumeric run and would have let it through.
        value: 'the deploy token is sk-EXAMPLE-not-a-real-key-000000',
        type: 'semantic',
      }),
      text('I did not store that.'),
    ],
    { cwd: TMP_DIR },
  );
  const after = allMemory('user', USER_KEY).length;
  record(
    checks,
    '(e) a secret-shaped value is refused and nothing is written',
    after === before && toolResults(h5.events).some((t) => /credential/i.test(t)),
    `rows ${before}→${after}; result: ${JSON.stringify(toolResults(h5.events).map((t) => t.slice(0, 80)))}`,
  );

  // ==== Scope rules =======================================================
  const { h: h6 } = await runOnce(
    '@learner remember this org-wide',
    [
      rememberCall('r3', { key: 'team-terms', value: 'The team calls it "the cockpit".', type: 'semantic', scope: 'org' }),
      text('ok'),
    ],
    { cwd: TMP_DIR },
  );
  record(
    checks,
    "(f) 'org' scope is refused to an agent",
    toolResults(h6.events).some((t) => /Nothing was remembered/.test(t) && /scope/.test(t)),
    `result: ${JSON.stringify(toolResults(h6.events).map((t) => t.slice(0, 90)))}`,
  );

  // A projectless turn (no cwd) cannot write project scope.
  const { h: h7 } = await runOnce(
    '@learner remember this for the project',
    [
      rememberCall('r4', { key: 'build-cmd', value: 'Build with npm run build:app.', type: 'procedural', scope: 'project' }),
      text('ok'),
    ],
    {},
  );
  record(
    checks,
    "(f2) a projectless turn refuses 'project' scope and says why",
    toolResults(h7.events).some((t) => /no 'project' scope/.test(t)),
    `result: ${JSON.stringify(toolResults(h7.events).map((t) => t.slice(0, 90)))}`,
  );

  // ---- report -------------------------------------------------------------
  let failed = 0;
  for (const c of checks) {
    if (!c.pass) failed += 1;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}\n      ${c.evidence}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error('spike-learn threw:', e);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });
