// src/spikes/spike-autonomy.ts
//
// Phase 3 (P3-M3c) verification: THE AUTONOMY LOOP, driven for real.
//
// NO NETWORK, NO KEYS. Same vertical slice — and same injection seam — as
// SPIKE-02: the shell's real EngineSpec drives our real AiSdkEngine, our real
// gate and our real executors, with `MockLanguageModelV4` substituted for the
// model through the production `ModelResolver`. The only new ingredient is an
// `agents` row with `autonomy.maxSteps`, so what runs here is exactly what runs
// when a user addresses an autonomous agent.
//
// The loop's contract is not something unit tests on lib/autonomy.ts can prove —
// those cover the DECISION, this covers the WIRING. Asserted, by execution:
//
//   (a) An autonomous agent takes MULTIPLE steps from ONE user message, and the
//       harness continuation is what drives step 2 (a `[naby autonomy]` user
//       message in the transcript, not something the user typed).
//   (b) The client sees EXACTLY ONE terminal `result` event for the whole goal.
//       This is the one that matters most: the client ends its turn on `result`,
//       so a leaked intermediate result would close the bubble while the agent
//       kept working. Intermediate steps surface as muted `autonomy` step bars.
//   (c) [[DONE]] stops the loop before the budget is spent.
//   (d) A step that uses NO tool ends the run (the anti-chatter rule) — a model
//       that just talks can never spin to the cap.
//   (e) The budget is a HARD stop: an agent that never finishes takes exactly
//       maxSteps steps, no more, and says why it stopped.
//   (f) NO-OP INVARIANT: an agent without maxSteps behaves exactly as it did
//       before M3c — one step, one result, no autonomy instruction in the system
//       prompt, no step bars.
//
// Prints PASS/FAIL per assertion; exits non-zero on any FAIL.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the shell adapter's SQLite store at a throwaway dir BEFORE importing it
// (the documented NABY_DB_PATH override — no test-only branch in the adapter).
const TMP_DIR = mkdtempSync(join(tmpdir(), 'naby-spike-autonomy-'));
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
import type { ModelResolver } from '../runtime-entry.js';

type Check = { name: string; pass: boolean; evidence: string };

function record(checks: Check[], name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

// ---------------------------------------------------------------------------
// Scripted model — one entry per doGenerate call, plus prompt capture.
// ---------------------------------------------------------------------------

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function toolCall(id: string): LanguageModelV4GenerateResult {
  return {
    content: [
      {
        type: 'tool-call',
        toolCallId: id,
        toolName: 'send_message',
        input: JSON.stringify({ to: 'alice', text: 'working' }),
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
  /** Every system/prompt payload the model was handed, JSON-stringified. */
  prompts: string[];
  calls: () => number;
};

/** A model that replays `script` in order and records what it was asked. Extra
 *  calls (a loop that ran longer than the script) return a plain text step, so an
 *  over-running loop shows up as a failed step-count assertion rather than a
 *  confusing crash. */
function scripted(script: LanguageModelV4GenerateResult[]): Scripted {
  const prompts: string[] = [];
  let i = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async (options: unknown): Promise<LanguageModelV4GenerateResult> => {
      prompts.push(JSON.stringify(options ?? {}));
      const next = script[i];
      i += 1;
      return next ?? text('(unscripted extra call)');
    },
  });
  return { model, prompts, calls: () => i };
}

// ---------------------------------------------------------------------------
// Fake RunCtx (same shape SPIKE-02 uses)
// ---------------------------------------------------------------------------

type Harness = { ctx: RunCtx; events: RunEvent[]; sessionId: () => string };

function makeHarness(controller: AbortController, prompt: string): Harness {
  const events: RunEvent[] = [];
  let key = 'provisional-run-key';
  const ctx: RunCtx = {
    prompt,
    images: undefined,
    cwd: TMP_DIR,
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

const typeOf = (e: RunEvent): string => String(e.type ?? '');

function results(events: RunEvent[]): RunEvent[] {
  return events.filter((e) => typeOf(e) === 'result');
}

/** The muted autonomy step bars, in order. */
function stepBars(events: RunEvent[]): string[] {
  return events
    .filter(
      (e) =>
        typeOf(e) === 'system' &&
        e.subtype === 'harness' &&
        (e as { harness_subtype?: string }).harness_subtype === 'autonomy',
    )
    .map((e) => String((e as { harness_detail?: string }).harness_detail ?? ''));
}

/** Register an agent and return the `@name <task>` prompt that routes to it. */
function makeAgent(name: string, maxSteps: number | undefined): string {
  getStore().putAgent({
    name,
    kind: 'custom',
    systemPrompt: `You are ${name}, a test agent.`,
    memoryScope: 'user',
    autonomy: {
      escalation: 'inline',
      ...(maxSteps !== undefined ? { maxSteps } : {}),
    },
  });
  return `@${name} send a message to alice, then keep going until done.`;
}

async function runOnce(
  prompt: string,
  script: LanguageModelV4GenerateResult[],
): Promise<{ h: Harness; s: Scripted }> {
  const controller = new AbortController();
  const h = makeHarness(controller, prompt);
  const s = scripted(script);
  const resolveModel: ModelResolver = () => s.model;
  await createNabySpec({ resolveModel }).runner.run(h.ctx);
  return { h, s };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const checks: Check[] = [];

  // ==== Run 1: two steps, then the agent declares itself done ==============
  //
  // Each step is: tool call → (executor runs) → text. Step 1's text says nothing
  // about being done, so the loop continues; step 2's carries [[DONE]].
  const prompt1 = makeAgent('autotwo', 4);
  const { h: h1, s: s1 } = await runOnce(prompt1, [
    toolCall('c1'),
    text('Step one done, continuing.'),
    toolCall('c2'),
    text('Goal reached.\n[[DONE]]'),
  ]);

  const bars1 = stepBars(h1.events);
  record(
    checks,
    '(a) one user message drives multiple steps',
    bars1.length === 2 && bars1[0]!.startsWith('step 1/4'),
    `step bars: ${JSON.stringify(bars1)}`,
  );

  // `RuntimeMessage` is a closed union whose 'tool' variant carries no `content`,
  // so the text is read structurally rather than by narrowing per variant.
  const bodyOf = (m: unknown): string => String((m as { content?: unknown }).content ?? '');
  const msgs1 = getStore().getMessages(h1.sessionId());
  const userTexts = msgs1.filter((m) => m.role === 'user').map(bodyOf);
  const continuation = userTexts.filter((t) => t.includes('[naby autonomy]'));
  record(
    checks,
    '(a2) step 2 was driven by the harness continuation, recorded in the transcript',
    continuation.length === 1 && continuation[0]!.includes('step 2 of 4'),
    `user messages: ${JSON.stringify(userTexts.map((t) => t.slice(0, 60)))}`,
  );

  const r1 = results(h1.events);
  record(
    checks,
    '(b) EXACTLY ONE terminal result reaches the client',
    r1.length === 1 && r1[0]!.is_error === false,
    `result events: ${r1.length}, is_error: ${JSON.stringify(r1.map((r) => r.is_error))}`,
  );
  record(
    checks,
    '(b2) the single result carries the whole goal (both steps of text)',
    String(r1[0]?.result ?? '').includes('Step one done') &&
      String(r1[0]?.result ?? '').includes('Goal reached'),
    `result text: ${JSON.stringify(String(r1[0]?.result ?? '').slice(0, 120))}`,
  );
  record(
    checks,
    '(c) [[DONE]] stops the loop before the budget is spent',
    bars1[1] === 'step 2/4 — stopped (done-marker)' && s1.calls() === 4,
    `last bar: ${JSON.stringify(bars1[1])}, model calls: ${s1.calls()}`,
  );
  record(
    checks,
    '(c2) the autonomy protocol was injected into the system prompt',
    s1.prompts.every((p) => p.includes('AUTONOMOUS MODE')) && s1.prompts.length === 4,
    `prompts carrying the instruction: ${s1.prompts.filter((p) => p.includes('AUTONOMOUS MODE')).length}/${s1.prompts.length}`,
  );

  // ==== Run 2: a step that only talks ends the run =========================
  const prompt2 = makeAgent('autotalk', 3);
  const { h: h2, s: s2 } = await runOnce(prompt2, [text('Here is my opinion, no tools needed.')]);
  const bars2 = stepBars(h2.events);
  record(
    checks,
    '(d) a step with no tool use ends the run (anti-chatter)',
    bars2.length === 1 &&
      bars2[0] === 'step 1/3 — stopped (no-tool-use)' &&
      results(h2.events).length === 1 &&
      s2.calls() === 1,
    `bars: ${JSON.stringify(bars2)}, model calls: ${s2.calls()}`,
  );

  // ==== Run 3: an agent that never finishes stops at the budget ============
  const prompt3 = makeAgent('autocap', 2);
  const { h: h3, s: s3 } = await runOnce(prompt3, [
    toolCall('d1'),
    text('still going'),
    toolCall('d2'),
    text('still going'),
    // A third step would consume these — it must not happen.
    toolCall('d3'),
    text('should never run'),
  ]);
  const bars3 = stepBars(h3.events);
  record(
    checks,
    '(e) the step budget is a hard stop, and the reason is reported',
    bars3.length === 2 &&
      bars3[1] === 'step 2/2 — stopped (max-steps)' &&
      s3.calls() === 4 &&
      results(h3.events).length === 1,
    `bars: ${JSON.stringify(bars3)}, model calls: ${s3.calls()} (a 3rd step would be 6)`,
  );

  // ==== Run 4: no maxSteps ⇒ pre-M3c behaviour, byte for byte ==============
  const prompt4 = makeAgent('autooff', undefined);
  const { h: h4, s: s4 } = await runOnce(prompt4, [toolCall('e1'), text('One turn, as always.')]);
  const r4 = results(h4.events);
  record(
    checks,
    '(f) NO-OP: without maxSteps there is one step, one result, no step bars',
    stepBars(h4.events).length === 0 && r4.length === 1 && r4[0]!.is_error === false && s4.calls() === 2,
    `bars: ${stepBars(h4.events).length}, results: ${r4.length}, model calls: ${s4.calls()}`,
  );
  record(
    checks,
    '(f2) NO-OP: the autonomy instruction is absent from a non-autonomous prompt',
    s4.prompts.every((p) => !p.includes('AUTONOMOUS MODE')),
    `prompts mentioning it: ${s4.prompts.filter((p) => p.includes('AUTONOMOUS MODE')).length}`,
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
    console.error('spike-autonomy threw:', e);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });
