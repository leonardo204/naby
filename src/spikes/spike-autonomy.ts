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
// P3-M12b adds one more, and it is about the turn a real user actually takes:
//
//   (j) THE FAST-GROWTH SESSION INTERVIEWS WITHOUT BEING ADDRESSED. The button
//       opens a session and the person types an ordinary message into it; the
//       interview instruction has to be in that turn's system prompt with no `@`
//       anywhere. And a session without the flag must never see it.
//
// P3-M12b-5 adds the half that a real session proved was missing:
//
//   (k) AN EGG CAN ACTUALLY PRACTISE. A user ran a whole fast-growth sitting, was
//       interviewed well, and got a growth report reading "check-ins 0/0, egg" —
//       naby never called `naby_checkin` once. The instruction was the cause (it
//       branched to interview-only below ten confirmed facts), but the question it
//       raised is about the WIRING: with the persona at the egg stage, is the
//       check-in sink even live in that session, and does the row it writes carry
//       the session's practice stamp? Driven here for real — scripted tool call,
//       prompt answered through the same registry the API route uses, ledger read
//       back — plus the two numbers that turn's instruction was handed.
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
// The USER's half of a check-in. The same module `POST /api/naby
// {checkin.resolve}` calls, so (k) answers the prompt through the production
// path rather than reaching into the sink.
import { resolveCheckin } from '../../shell/packages/feature/agent/src/server/lib/checkinRegistry.js';
import type {
  RunCtx,
  RunEvent,
} from '../../shell/packages/feature/agent/src/server/engines/types.js';
import type { Engine, EngineEvent, ModelResolver } from '../runtime-entry.js';

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

/** A `naby_checkin` call — the practice question of check (k). */
function checkinCall(
  id: string,
  input: { question: string; options: string[]; recommended: number },
): LanguageModelV4GenerateResult {
  return {
    content: [
      {
        type: 'tool-call',
        toolCallId: id,
        toolName: 'naby_checkin',
        input: JSON.stringify(input),
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

function makeHarness(
  controller: AbortController,
  prompt: string,
  // RESUMING a session rather than minting one. Needed by the fast-growth check
  // (j): that flag lives on the SESSION ROW and is set by the user before any
  // turn runs, so the only honest way to exercise it is to hand the engine a
  // session that already carries it.
  sessionId?: string,
  // The USER, for a turn that stops and asks one something. A check-in suspends
  // the turn on a promise, so a spike that only collects events would deadlock
  // until the TTL; this is where (j3) plays the person clicking an option.
  onEvent?: (event: RunEvent) => void,
): Harness {
  const events: RunEvent[] = [];
  let key = sessionId ?? 'provisional-run-key';
  const ctx: RunCtx = {
    prompt,
    images: undefined,
    cwd: TMP_DIR,
    sessionId,
    params: { prompt, engine: 'naby' },
    signal: controller.signal,
    emit(event: RunEvent): void {
      events.push(event);
      onEvent?.(event);
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
 *  P3-M9 (G2), AS AMENDED BY P3-M12a: AUTONOMY REQUIRES THE BUTTERFLY STAGE —
 *  routing no longer does. A freshly created agent (an egg, no measured history)
 *  IS routed to: it answers as itself, but its stage contract pins it to one step
 *  and refuses every tool that changes anything (fast-evolution §3.1). Since every
 *  run below is about the multi-step loop, an agent meant to be delegated to still
 *  EARNS the stage here the only way it can be earned: a clean run of check-ins in
 *  its ledger. 8 straight hits puts the Wilson lower bound at
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
  sessionId?: string,
  onEvent?: (event: RunEvent) => void,
  voiceBackend?: NonNullable<Parameters<typeof createNabySpec>[0]>['resolveVoiceBackend'],
): Promise<{ h: Harness; s: Scripted }> {
  const controller = new AbortController();
  const h = makeHarness(controller, prompt, sessionId, onEvent);
  const s = scripted(script);
  const resolveModel: ModelResolver = () => s.model;
  await createNabySpec({
    resolveModel,
    // Left unset, the naby layer (P3-M14a) is SILENT here: an injected model
    // resolver means this process must not reach a provider on its own, so a
    // scripted run does not quietly pay a real backend to polish its scripted
    // answer. Run 8 injects a deterministic one to prove the layer's own
    // contract instead.
    ...(voiceBackend ? { resolveVoiceBackend: voiceBackend } : {}),
  }).runner.run(h.ctx);
  return { h, s };
}

/** A voice backend that always answers with `rewrite`, and counts its calls. The
 *  port strips the protocol markers before the model is asked, so this stands in
 *  for a model that returns prose and nothing else — which is exactly the case the
 *  marker re-attachment has to survive. */
function scriptedVoiceBackend(rewrite: string): {
  resolve: () => Promise<{ engine: Engine; model: { providerId: string }; label: string }>;
  calls: () => number;
  prompts: string[];
} {
  let calls = 0;
  const prompts: string[] = [];
  const engine: Engine = {
    async *run(input): AsyncIterable<EngineEvent> {
      calls += 1;
      prompts.push(JSON.stringify(input.messages));
      yield { kind: 'init', providerId: 'voice-mock', model: 'voice-mock-1' };
      yield { kind: 'text', role: 'assistant', text: rewrite };
      yield { kind: 'result', ok: true, usage: { inputTokens: 40, outputTokens: 30 } };
    },
  };
  return {
    resolve: async () => ({ engine, model: { providerId: 'voice-mock' }, label: 'voice-mock' }),
    calls: () => calls,
    prompts,
  };
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

  // ==== Run 7 (P3-M9 G2 → P3-M12a): the `@` gate, driven through the real engine
  //
  // ASSERTIONS UPDATED FOR M12a, deliberately and not reluctantly. What run 7 used
  // to prove — "an egg is not routed to, the turn runs unrouted" — stopped being
  // the product's rule: an agent nobody may address never gets the conversations
  // it would grow from, so the butterfly line moved off the mention and onto
  // AUTONOMOUS DELEGATION (trust-meter §4.9 0.7.0, fast-evolution §3.1). The
  // property worth proving is now the stronger one: the egg IS routed to, answers
  // as itself, and is held to its stage contract — one step and no tool that
  // leaves a trace.
  const prompt7 = makeAgent('autoegg', 4, { addressable: false });
  const { h: h7, s: s7 } = await runOnce(prompt7, [text('Answered as a draft.')]);
  const gatePills = harnessPills(h7.events, 'routing-gate');
  record(
    checks,
    '(h) an EGG agent IS routed to — it adopts its identity, but its stage caps it at one step',
    // The identity is adopted (that is the M12a change), and its maxSteps=4 is
    // narrowed to the egg contract's 1, so no autonomy protocol and no step bars.
    s7.prompts.every((p) => p.includes('You are autoegg, a test agent.')) &&
      s7.prompts.every((p) => !p.includes('AUTONOMOUS MODE')) &&
      stepBars(h7.events).length === 0 &&
      results(h7.events).length === 1,
    `prompts adopting the identity: ${s7.prompts.filter((p) => p.includes('You are autoegg')).length}/${s7.prompts.length}, step bars: ${stepBars(h7.events).length}`,
  );
  record(
    checks,
    '(h1b) the stage contract is STATED in the system prompt, with the real numbers behind it',
    s7.prompts.every((p) => p.includes('YOUR STAGE: egg')) &&
      // The honest-refusal protocol and the ledger's own count of what is missing
      // — not a number the model estimated.
      s7.prompts.every((p) => p.includes('WHEN A REQUEST NEEDS MORE THAN YOU MAY DO')) &&
      s7.prompts.every((p) => p.includes('5 more check-in(s)')),
    `prompts carrying the stage block: ${s7.prompts.filter((p) => p.includes('YOUR STAGE: egg')).length}/${s7.prompts.length}`,
  );
  record(
    checks,
    '(h2) the turn RUNS on the task text with the @name stripped',
    s7.calls() === 1 &&
      s7.prompts.some((p) => p.includes('send a message to alice')) &&
      s7.prompts.every((p) => !p.includes('@autoegg')),
    `model calls: ${s7.calls()}, prompts naming the handle: ${s7.prompts.filter((p) => p.includes('@autoegg')).length}`,
  );
  record(
    checks,
    '(h3) the user is told the SCOPE, on a muted harness pill carrying a locale-free code',
    gatePills.length === 1 && gatePills[0] === 'stage-limited:egg:autoegg',
    `routing-gate pills: ${JSON.stringify(gatePills)}`,
  );

  // ==== Run 8 (P3-M12a): the contract is a GATE, not a suggestion ==========
  //
  // The egg tries to send a message anyway. Two things must be true, and the
  // second is the one that is easy to get wrong:
  //
  //   * the call does not run, and the model is told why in words it can act on;
  //   * NO LEDGER ROW IS WRITTEN. A `tripwire` row is the meter's hard block on
  //     butterfly, so filing one here would mean an agent that obeyed its own
  //     contract had thereby made the stage it needs unreachable.
  const eggId = getStore().getAgentByName('autoegg')!.id;
  const ledgerBefore = getStore().listEvalEvents(eggId).length;
  const { h: h7b } = await runOnce(prompt7, [toolCall('e1'), text('I cannot send it — here is the draft.')]);
  const ledgerAfter = getStore().listEvalEvents(eggId);
  const toolResults = h7b.events
    .filter((e) => typeOf(e) === 'user')
    .flatMap((e) => {
      const content = (e as { message?: { content?: unknown[] } }).message?.content ?? [];
      return content.map((c) => String((c as { content?: unknown }).content ?? ''));
    });
  record(
    checks,
    '(h5) a consequential tool is REFUSED at the egg stage, with a reason the model can act on',
    toolResults.some((r) => r.includes('Blocked by the stage contract')) &&
      toolResults.some((r) => r.includes('send_message')),
    `tool results: ${JSON.stringify(toolResults.map((r) => r.slice(0, 70)))}`,
  );
  record(
    checks,
    '(h6) and the refusal writes NO ledger row — obeying the contract is not a safety violation',
    ledgerAfter.length === ledgerBefore &&
      ledgerAfter.every((e) => e.kind !== 'tripwire') &&
      ledgerAfter.every((e) => e.kind !== 'autonomous'),
    `ledger rows ${ledgerBefore} → ${ledgerAfter.length}; kinds: ${JSON.stringify([...new Set(ledgerAfter.map((e) => e.kind))])}`,
  );
  // …and the same agent, once it has earned the stage, gets the autonomy its row
  // asks for: the contract stops narrowing, the protocol appears, the tool runs
  // and the scope pill is gone.
  growUp(eggId);
  const { h: h8, s: s8 } = await runOnce(prompt7, [toolCall('g1'), text('Routed.\n[[VERIFIED: sent]]\n[[DONE]]')]);
  record(
    checks,
    '(h4) the SAME agent becomes autonomous once it is a butterfly — the stage is the only thing that changed',
    s8.prompts.every((p) => p.includes('You are autoegg, a test agent.')) &&
      s8.prompts.every((p) => p.includes('AUTONOMOUS MODE')) &&
      s8.prompts.every((p) => !p.includes('YOUR STAGE:')) &&
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

  // ==== Run 8b: AN EGG PRACTISES, AND THE ROW LANDS STAMPED ================
  //
  // (k) P3-M12b-5, and it has to run HERE — before `growUp` below gives the persona
  // a record. Everything this proves is about the agent at the EGG stage with an
  // EMPTY ledger, which is the only state a real user's naby is in when they
  // press the fast-growth button.
  //
  // Nothing about a stage may gate a check-in. Check-ins are how an egg grows
  // (trust-meter §4.1: the ledger is the only input to the stage), so a sink
  // withheld until the agent is trusted is the M5 deadlock rebuilt — and the
  // session that produced no check-ins at all raised exactly this question. The
  // assertion is deliberately end to end: the model calls the tool, the turn
  // SUSPENDS, the user answers through the same registry the API route resolves
  // through, and the row that lands is read back off the store.
  const eggLedgerBefore = store.listEvalEvents(BUILTIN_PERSONA_ID, { kind: 'checkin' }).length;
  const practiceRef = store.createSession('', 'fast-growth practice', TMP_DIR);
  store.setSessionFastGrowth(practiceRef.sessionId, true);
  const { h: h8b, s: s8b } = await runOnce(
    'ok, ask me something.',
    [
      checkinCall('d1', {
        question: 'For the release notes on this project, would you rather I draft them or outline them?',
        options: ['draft the notes in full', 'outline the headings only'],
        recommended: 0,
      }),
      text('Understood — I will draft them in full next time.'),
    ],
    practiceRef.sessionId,
    // THE USER. Answering synchronously inside the emit is safe and deliberate:
    // the sink registers the resolver BEFORE it emits the request (checkinTurn),
    // so the prompt is already answerable by the time this runs.
    (event) => {
      if (String(event.type ?? '') !== 'checkin_request') return;
      resolveCheckin(String((event as { checkinId?: unknown }).checkinId ?? ''), { chosen: 0 });
    },
  );
  const eggRows = store.listEvalEvents(BUILTIN_PERSONA_ID, {
    kind: 'checkin',
    sessionId: practiceRef.sessionId,
  });
  const eggRow = eggRows[0] as { drill?: boolean; hit?: boolean } | undefined;
  record(
    checks,
    '(k) an EGG persona in a fast-growth session really checks in, and the row is stamped as practice',
    eggLedgerBefore === 0 &&
      eggRows.length === 1 &&
      eggRow?.drill === true &&
      eggRow?.hit === true &&
      // The turn RESUMED rather than dying on the TTL: the model was called again
      // once the answered tool result came back.
      s8b.calls() === 2 &&
      results(h8b.events).length === 1,
    `ledger before: ${eggLedgerBefore}, rows for this session: ${eggRows.length}, ` +
      `drill: ${eggRow?.drill}, hit: ${eggRow?.hit}, model calls: ${s8b.calls()}`,
  );

  // …and the sitting was HANDED the numbers rather than left to estimate them.
  // `5` is GROWTH_MIN_SAMPLE against an empty ledger — the same figure the growth
  // panel shows the user, which is the whole reason the engine computes it.
  const numbered = s8b.prompts.filter(
    (p) =>
      p.includes('PART 2 — PRACTISE PREDICTING THEM') &&
      p.includes('still needed before your stage can be read at all: 5'),
  );
  record(
    checks,
    '(k2) …and it was told the REAL numbers, from the same ledger the growth panel reads',
    numbered.length === s8b.prompts.length && s8b.prompts.length > 0,
    `prompts: ${s8b.prompts.length}, carrying part 2 with the ledger's number: ${numbered.length}`,
  );

  // The SECOND turn of the same sitting sees the count the first one produced.
  // That is what makes the closing sentence ("this session has run N") a fact
  // rather than a guess, and it can only hold if the count is re-read per turn
  // from the rows themselves.
  const { s: s8c } = await runOnce('go on then.', [text('One more?')], practiceRef.sessionId);
  record(
    checks,
    '(k3) the next turn of that sitting counts the practice check-in it already ran',
    s8c.prompts.length > 0 &&
      s8c.prompts.every((p) => p.includes('One has been recorded in it so far')),
    `prompts: ${s8c.prompts.length}, carrying the running count: ${
      s8c.prompts.filter((p) => p.includes('One has been recorded in it so far')).length
    }`,
  );

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

  // ==== Run 12: THE FAST-GROWTH SESSION INTERVIEWS ON AN ORDINARY TURN ======
  //
  // (j) P3-M12b, and the thing a user actually does. The button mints a session
  // and drops the person into it; what they type there is "안녕" — a plain
  // message, no `@naby`. If the interview block only rode ADDRESSED turns, the
  // session the product just told them to open would behave exactly like every
  // other conversation, and the feature would be invisible in the one place it
  // exists. So this asserts the ORDINARY path: no `@`, and the instruction is in
  // the system prompt anyway.
  //
  // It works because `growthSubject` is `routedAgent ?? persona` — an unrouted
  // turn IS the persona's turn (P3-M5) — which is the same reason ordinary turns
  // already learn and check in. This check pins that down, because the condition
  // is one `?? persona` away from silently becoming @-only again.
  const fastRef = store.createSession('', 'fast-growth', TMP_DIR);
  store.setSessionFastGrowth(fastRef.sessionId, true);
  const { s: s12 } = await runOnce(
    'hello — I would like you to get to know me.',
    [text('Sure. What are you working on at the moment?')],
    fastRef.sessionId,
  );
  const interviewed = s12.prompts.filter((p) => p.includes('FAST-GROWTH SESSION'));
  record(
    checks,
    '(j) a fast-growth session interviews on an ORDINARY, unaddressed turn',
    interviewed.length === s12.prompts.length && s12.prompts.length > 0,
    `prompts: ${s12.prompts.length}, carrying the interview block: ${interviewed.length}`,
  );

  // …and an ordinary session is untouched, byte for byte. Without this the check
  // above would pass just as happily if the block were injected into every turn
  // the engine ever ran, which is a different (and worse) bug.
  const plainRef = store.createSession('', 'plain', TMP_DIR);
  const { s: s13 } = await runOnce('hello.', [text('Hi.')], plainRef.sessionId);
  record(
    checks,
    '(j2) …and a session WITHOUT the flag never sees the interview block',
    s13.prompts.length > 0 && s13.prompts.every((p) => !p.includes('FAST-GROWTH SESSION')),
    `prompts: ${s13.prompts.length}, carrying the interview block: ${
      s13.prompts.filter((p) => p.includes('FAST-GROWTH SESSION')).length
    }`,
  );

  // ==== THE CHECK-IN WORDING FOLLOWS THE SUBJECT'S RECORD (P3-M12e) ========
  //
  // Why this is checked end to end rather than in a unit test alone: the unit
  // test proves `checkinInstruction(stage)` produces two wordings, and the bug it
  // guards against is the engine never HANDING it a stage — which is exactly the
  // shape of the failure this milestone came from (a working check-in machine
  // that nothing ever pushed to ask, giving a ledger of ~197 autonomous rows and
  // zero real check-ins; trust-meter §4.12).
  //
  // Both sides are read off runs that already happened above, so the assertion
  // costs no extra turn and cannot drift from what those runs actually did:
  //
  //   s8b  the EGG persona's turn (run 11 — `eggLedgerBefore === 0`, before
  //        `growUp`): the eager clause must be in the system prompt.
  //   s13  an ordinary turn AFTER `growUp` made the persona a butterfly: the
  //        eager clause must be gone, and the original block still there.
  const EAGER = 'PREFER asking over deciding on your own';
  const BASE = 'CHECKING IN: right before you do something';
  record(
    checks,
    "(l) an EGG's turn is pushed to ask before deciding for the user",
    s8b.prompts.length > 0 && s8b.prompts.every((p) => p.includes(EAGER) && p.includes(BASE)),
    `prompts: ${s8b.prompts.length}, carrying the eager clause: ${
      s8b.prompts.filter((p) => p.includes(EAGER)).length
    }`,
  );
  record(
    checks,
    '(l2) …and a butterfly goes back to the light wording, with the block itself intact',
    s13.prompts.length > 0 && s13.prompts.every((p) => !p.includes(EAGER) && p.includes(BASE)),
    `prompts: ${s13.prompts.length}, carrying the eager clause: ${
      s13.prompts.filter((p) => p.includes(EAGER)).length
    }, carrying the check-in block: ${s13.prompts.filter((p) => p.includes(BASE)).length}`,
  );

  // ==== THE NABY LAYER DOES NOT BREAK THE LOOP (P3-M14a) ==================
  //
  // THE REGRESSION THIS MILESTONE IS MOST ABLE TO CAUSE. The autonomy loop stops
  // when it sees `[[DONE]]` in the step's text — and since M14a that text has been
  // through a model that was asked to rewrite it. A rewrite that dropped the
  // marker would produce an agent that never stops: it would run to its step cap
  // on every goal it finished, silently, and only the bill would say so.
  //
  // So the layer is driven for real here, through the production engine path,
  // with a deterministic backend standing in for the model: the port strips the
  // markers, the "model" answers with prose alone, the port puts them back, and
  // the loop must still stop on the FIRST step.
  const rewritten =
    'The message went out and the log confirms it, so the goal is met and nothing is left pending.';
  const voice = scriptedVoiceBackend(rewritten);
  const prompt14 = makeAgent('autovoice', 3);
  const { h: h14 } = await runOnce(
    prompt14,
    [
      toolCall('v1'),
      text(
        'The message has been delivered and I checked the log to be sure of it, so the work is finished.\n' +
          '[[VERIFIED: re-read the message log, it is there]]\n[[DONE]]',
      ),
    ],
    undefined,
    undefined,
    voice.resolve,
  );
  const bars14 = stepBars(h14.events);
  const assistant14 = getStore()
    .getMessages(h14.sessionId())
    .filter((m) => m.role === 'assistant')
    .map(bodyOf)
    .filter((t) => t.length > 0);
  const last14 = assistant14.at(-1) ?? '';
  record(
    checks,
    '(m) the naby layer restyles the final block and the run still stops on [[DONE]]',
    voice.calls() === 1 &&
      bars14.length === 1 &&
      bars14[0] === 'step 1/3 — stopped (done-marker)',
    `voice calls: ${voice.calls()}, step bars: ${JSON.stringify(bars14)}`,
  );
  record(
    checks,
    '(m2) the markers were never shown to the rewriting model, and came back on the result',
    voice.prompts.every((p) => !p.includes('[[DONE]]') && !p.includes('[[VERIFIED:')) &&
      last14.includes(rewritten) &&
      last14.trimEnd().endsWith('[[DONE]]') &&
      last14.includes('[[VERIFIED:'),
    `stored last block: ${JSON.stringify(last14.slice(0, 160))}`,
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
