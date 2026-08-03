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
// P3-M9 adds two more wirings that only execution can prove:
//
//   (g) THE VERIFICATION STEP (G4). A run that tries to stop without saying what
//       it checked gets exactly ONE nudge — a different continuation prompt, not
//       the ordinary "carry on" — and the second stop always stops. A stop that
//       DOES carry [[VERIFIED: ...]] is never nudged, and the nudge can never
//       push a run past its step budget.
//   (h) THE `@` GATE (G2). An agent that is not a butterfly is not routed to: no
//       identity is adopted, the turn runs as an ordinary one on the task text,
//       and a muted harness pill says so. An agent that IS one still routes.
//   (i) THE PERSONA'S DELEGATION SETTINGS (G1). A persona turn takes its step
//       budget from the USER's settings rather than from its locked row — with
//       the row provably untouched — while a custom agent still reads its own.
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
// The HANDLE is imported rather than typed as a literal: this spike routes to the
// built-in agent by name, so a rename of the seed handle (2026-08-03: `persona` →
// `naby`) must move these turns with it. Addressing a name nobody holds does not
// fail loudly — it just runs an ordinary unrouted turn, and every assertion below
// about the persona's settings would then be measuring the wrong thing.
import { BUILTIN_PERSONA_ID, BUILTIN_PERSONA_NAME } from '../runtime-entry.js';
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

/** The muted harness pills of one subtype, in order, as `detail` strings. */
function harnessPills(events: RunEvent[], subtype: string): string[] {
  return events
    .filter(
      (e) =>
        typeOf(e) === 'system' &&
        e.subtype === 'harness' &&
        (e as { harness_subtype?: string }).harness_subtype === subtype,
    )
    .map((e) => String((e as { harness_detail?: string }).harness_detail ?? ''));
}

/** The muted autonomy step bars, in order. */
function stepBars(events: RunEvent[]): string[] {
  return harnessPills(events, 'autonomy');
}

/** Register an agent and return the `@name <task>` prompt that routes to it.
 *
 *  P3-M9 (G2): ROUTING NOW REQUIRES THE BUTTERFLY STAGE. The engine runs the same
 *  gate the `@` palette does, so a freshly created agent — an egg, no measured
 *  history — is deliberately NOT addressable and its turn runs unrouted. That is
 *  the new contract, not an obstacle to work around, so an agent that is meant to
 *  be delegated to EARNS the stage here the only way it can be earned: a clean
 *  run of check-ins in its ledger. 8 straight hits puts the Wilson lower bound at
 *  ~0.68, over the 0.60 butterfly line (runtime/growth.ts).
 *
 *  `addressable:false` is the deliberate opposite, for the gate's own checks. */
function makeAgent(
  name: string,
  maxSteps: number | undefined,
  opts: { addressable?: boolean } = {},
): string {
  const agent = getStore().putAgent({
    name,
    kind: 'custom',
    systemPrompt: `You are ${name}, a test agent.`,
    memoryScope: 'user',
    autonomy: {
      escalation: 'inline',
      ...(maxSteps !== undefined ? { maxSteps } : {}),
    },
  });
  if (opts.addressable !== false) growUp(agent.id);
  return `@${name} send a message to alice, then keep going until done.`;
}

/** Take an agent to the butterfly stage by giving it the record that earns it. */
function growUp(agentId: string): void {
  for (let i = 0; i < 8; i += 1) {
    getStore().appendEvalEvent({
      kind: 'checkin',
      agentId,
      sessionId: `grow-${agentId}-${i}`,
      taskType: 'testing',
      at: 1_000 + i,
      options: ['a', 'b'],
      recommended: 0,
      chosen: 0,
      hit: true,
    });
  }
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
  //
  // P3-M9: step 2 also carries [[VERIFIED: ...]], because a model that declares
  // itself done WITHOUT saying what it checked is now given one verification step
  // (checked in run 5). This run is about the pre-M9 stop path, so it takes the
  // exit a well-behaved agent takes — which is the point of the protocol.
  const prompt1 = makeAgent('autotwo', 4);
  const { h: h1, s: s1 } = await runOnce(prompt1, [
    toolCall('c1'),
    text('Step one done, continuing.'),
    toolCall('c2'),
    text('Goal reached.\n[[VERIFIED: re-read the message log, it is there]]\n[[DONE]]'),
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
  //
  // P3-M9: same treatment as run 1 — the verification marker keeps this run on
  // the anti-chatter path it was written to exercise. The unverified no-tool stop
  // is run 6's subject.
  const prompt2 = makeAgent('autotalk', 3);
  const { h: h2, s: s2 } = await runOnce(prompt2, [
    text('Here is my opinion, no tools needed. [[VERIFIED: nothing to check, this was a question]]'),
  ]);
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

  // ==== Run 5 (P3-M9 G4): stopping with no evidence buys ONE more step =====
  //
  // The agent declares [[DONE]] having said nothing about what it checked. The
  // harness does not take its word for it: the run continues, but with the
  // VERIFICATION prompt rather than the ordinary continuation — and when the
  // agent stops again, still unverified, that is the end. One nudge per run is
  // the whole bound; otherwise "verify first" would be a way never to finish.
  const prompt5 = makeAgent('autoverify', 5);
  const { h: h5, s: s5 } = await runOnce(prompt5, [
    toolCall('v1'),
    text('All finished.\n[[DONE]]'),
    // The nudged step: it doubles down instead of checking.
    toolCall('v2'),
    text('Still finished, I promise.\n[[DONE]]'),
    // A third stop must never be reached.
    toolCall('v3'),
    text('should never run'),
  ]);
  const bars5 = stepBars(h5.events);
  record(
    checks,
    '(g) an unverified stop is nudged EXACTLY once, then stops',
    bars5.length === 2 &&
      bars5[0] === 'step 1/5 — verifying before it stops' &&
      bars5[1] === 'step 2/5 — stopped (done-marker)' &&
      s5.calls() === 4 &&
      results(h5.events).length === 1,
    `bars: ${JSON.stringify(bars5)}, model calls: ${s5.calls()} (a 3rd step would be 6)`,
  );
  const nudgeMsgs = getStore()
    .getMessages(h5.sessionId())
    .filter((m) => m.role === 'user')
    .map((m) => String((m as { content?: unknown }).content ?? ''))
    .filter((t) => t.includes('[naby autonomy]'));
  record(
    checks,
    '(g2) the nudge asks the agent to VERIFY, not to carry on, and is in the transcript',
    nudgeMsgs.length === 1 &&
      nudgeMsgs[0]!.includes('You have not said what you checked') &&
      nudgeMsgs[0]!.includes('[[VERIFIED:'),
    `continuations: ${JSON.stringify(nudgeMsgs.map((t) => t.slice(0, 70)))}`,
  );
  record(
    checks,
    '(g3) the autonomy protocol asks for the verification marker',
    s5.prompts.every((p) => p.includes('[[VERIFIED:')),
    `prompts carrying the marker: ${s5.prompts.filter((p) => p.includes('[[VERIFIED:')).length}/${s5.prompts.length}`,
  );

  // ==== Run 6 (P3-M9 G4): the nudge never outruns the budget ===============
  //
  // maxSteps 2, and step 2 wants to stop unverified. A nudge would be step 3,
  // which the budget does not have — so the run stops. The nudge is an ordinary
  // step and is counted like one; the cap outranks the protocol.
  const prompt6 = makeAgent('autoverifycap', 2);
  const { h: h6, s: s6 } = await runOnce(prompt6, [
    toolCall('w1'),
    text('working'),
    // Step 2: no tool, no verification — the nudge case, with no budget for it.
    text('I think that is everything.'),
    toolCall('w3'),
    text('should never run'),
  ]);
  const bars6 = stepBars(h6.events);
  record(
    checks,
    '(g4) the nudge respects the step budget — no room, no nudge',
    bars6.length === 2 &&
      bars6[1] === 'step 2/2 — stopped (no-tool-use)' &&
      s6.calls() === 3 &&
      results(h6.events).length === 1,
    `bars: ${JSON.stringify(bars6)}, model calls: ${s6.calls()}`,
  );

  // ==== Run 7 (P3-M9 G2): the `@` gate, driven through the real engine =====
  //
  // A fresh agent is an EGG — no measured history — so `@`-addressing it must not
  // adopt its identity. What the palette has always shown, routing now honours.
  const prompt7 = makeAgent('autoegg', 4, { addressable: false });
  const { h: h7, s: s7 } = await runOnce(prompt7, [text('Answered as a plain turn.')]);
  const gatePills = harnessPills(h7.events, 'routing-gate');
  record(
    checks,
    '(h) a non-butterfly agent is NOT routed to — no identity, no autonomy',
    // No persona prompt adopted, and no autonomy: its maxSteps=4 is ignored
    // because there is no routed agent to read it from.
    s7.prompts.every((p) => !p.includes('You are autoegg, a test agent.')) &&
      s7.prompts.every((p) => !p.includes('AUTONOMOUS MODE')) &&
      stepBars(h7.events).length === 0 &&
      results(h7.events).length === 1,
    `prompts adopting the persona: ${s7.prompts.filter((p) => p.includes('You are autoegg')).length}, step bars: ${stepBars(h7.events).length}`,
  );
  record(
    checks,
    '(h2) the refused turn still RUNS, on the task text with the @name stripped',
    s7.calls() === 1 &&
      s7.prompts.some((p) => p.includes('send a message to alice')) &&
      s7.prompts.every((p) => !p.includes('@autoegg')),
    `model calls: ${s7.calls()}, prompts naming the handle: ${s7.prompts.filter((p) => p.includes('@autoegg')).length}`,
  );
  record(
    checks,
    '(h3) the user is told, on a muted harness pill carrying a locale-free code',
    gatePills.length === 1 && gatePills[0] === 'not-butterfly:autoegg',
    `routing-gate pills: ${JSON.stringify(gatePills)}`,
  );
  // …and the same agent, once it has earned the stage, routes exactly as before.
  growUp(getStore().getAgentByName('autoegg')!.id);
  const { h: h8, s: s8 } = await runOnce(prompt7, [toolCall('g1'), text('Routed.\n[[VERIFIED: sent]]\n[[DONE]]')]);
  record(
    checks,
    '(h4) the SAME agent routes once it is a butterfly — the gate is the only thing that changed',
    s8.prompts.every((p) => p.includes('You are autoegg, a test agent.')) &&
      s8.prompts.every((p) => p.includes('AUTONOMOUS MODE')) &&
      harnessPills(h8.events, 'routing-gate').length === 0 &&
      results(h8.events).length === 1,
    `prompts adopting the persona: ${s8.prompts.filter((p) => p.includes('You are autoegg')).length}/${s8.prompts.length}, gate pills: ${harnessPills(h8.events, 'routing-gate').length}`,
  );

  // ==== Run 9 (P3-M9 G1): the PERSONA reads the user's settings ============
  //
  // The persona row is read-only and its seed pins `escalation:'inline'` with no
  // maxSteps, so if the engine read the ROW the product's own promise ("keep
  // going until the tests pass") would be permanently unreachable. It reads the
  // user's settings instead — and the row stays exactly as the seed left it,
  // which is the invariant that made this necessary in the first place.
  const store = getStore();
  const personaRow = store.getAgent(BUILTIN_PERSONA_ID)!;
  growUp(BUILTIN_PERSONA_ID);
  store.setSetting('persona.autonomy.maxSteps', '3');
  store.setSetting('persona.autonomy.escalation', 'inline');
  const { h: h9, s: s9 } = await runOnce(`@${BUILTIN_PERSONA_NAME} keep working until it is done.`, [
    toolCall('p1'),
    text('step one'),
    toolCall('p2'),
    text('Done.\n[[VERIFIED: checked the log]]\n[[DONE]]'),
  ]);
  const bars9 = stepBars(h9.events);
  record(
    checks,
    '(i) a persona turn takes its step budget from the USER SETTING, not the locked row',
    personaRow.autonomy.maxSteps === undefined &&
      bars9.length === 2 &&
      bars9[0] === 'step 1/3 — continuing' &&
      bars9[1] === 'step 2/3 — stopped (done-marker)' &&
      s9.calls() === 4,
    `row maxSteps: ${String(personaRow.autonomy.maxSteps)}, bars: ${JSON.stringify(bars9)}, model calls: ${s9.calls()}`,
  );
  const personaAfter = store.getAgent(BUILTIN_PERSONA_ID)!;
  record(
    checks,
    '(i2) …and the read-only persona row was not touched to make that happen',
    JSON.stringify(personaAfter.autonomy) === JSON.stringify(personaRow.autonomy) &&
      personaAfter.systemPrompt === personaRow.systemPrompt &&
      personaAfter.updatedAt === personaRow.updatedAt,
    `autonomy: ${JSON.stringify(personaAfter.autonomy)}, updatedAt unchanged: ${personaAfter.updatedAt === personaRow.updatedAt}`,
  );
  // Turning the setting back off restores single-turn behaviour on the very next
  // message — the setting IS the switch, with no rebuild and no row write.
  store.setSetting('persona.autonomy.maxSteps', '1');
  const { h: h10, s: s10 } = await runOnce(`@${BUILTIN_PERSONA_NAME} one more thing.`, [
    toolCall('p3'),
    text('answered'),
  ]);
  record(
    checks,
    '(i3) setting it back to 1 turns autonomy off again, immediately',
    stepBars(h10.events).length === 0 &&
      s10.prompts.every((p) => !p.includes('AUTONOMOUS MODE')) &&
      results(h10.events).length === 1 &&
      s10.calls() === 2,
    `bars: ${stepBars(h10.events).length}, prompts with the protocol: ${s10.prompts.filter((p) => p.includes('AUTONOMOUS MODE')).length}`,
  );
  // A CUSTOM agent is unaffected: its row is editable, so it keeps reading it.
  const prompt11 = makeAgent('autocustom', 2);
  const { h: h11 } = await runOnce(prompt11, [toolCall('q1'), text('one'), toolCall('q2'), text('two')]);
  record(
    checks,
    '(i4) a custom agent still reads its OWN row — the persona setting does not leak',
    stepBars(h11.events).length === 2 && stepBars(h11.events)[1] === 'step 2/2 — stopped (max-steps)',
    `bars: ${JSON.stringify(stepBars(h11.events))} (persona setting is 1, this agent's row says 2)`,
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
