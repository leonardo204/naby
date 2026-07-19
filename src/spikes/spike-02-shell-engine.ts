// src/spikes/spike-02-shell-engine.ts
//
// SPIKE-02 — the shell's engine layer runs OUR runtime.
//
// NO NETWORK, NO KEYS. The seam under test is the whole vertical slice:
//
//     shell EngineSpec (shell/.../engines/naby.ts)
//       → our AiSdkEngine (production loop)
//         → our gate
//           → our executors
//       → back out as the Agent-SDK-shaped events the shell's client renders
//
// Everything in that chain is the real production code. The ONLY substitution
// is the language model itself: `MockLanguageModelV4` from `ai/test`, injected
// through the SAME `ModelResolver` seam production uses (`createNabySpec({
// resolveModel })`). No test-only branch exists inside the engine.
//
// Asserted, by execution:
//
//   (a) a `system`/init event carrying a session id is emitted, and ctx.rekey()
//       is called with that same id.
//   (b) assistant text reaches ctx.emit in the shape the shell's CLIENT
//       actually reads — proven by running the captured events through the
//       shell's own `applyStreamEvent` reducer and checking the rendered text.
//   (c) a tool call passes through OUR GATE BEFORE its executor runs. The gate
//       log entry and the tool_result event are recorded on one interleaved
//       timeline, so their order is observed, not inferred; and the result text
//       is the one only the real executor can produce.
//   (d) the turn ends with a `result` event, is_error:false.
//   (e) aborting ctx.signal stops the run and still yields a terminal error
//       result — with no tool ever executed.
//
// Prints PASS/FAIL per assertion; exits non-zero on any FAIL.

import type {
  LanguageModelV4GenerateResult,
} from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';

// The shell fork, imported directly — the same module its registry loads.
import { createNabySpec } from '../../shell/packages/feature/agent/src/server/engines/naby.js';
import type {
  RunCtx,
  RunEvent,
} from '../../shell/packages/feature/agent/src/server/engines/types.js';
import type { GateLogEntry, ModelResolver } from '../runtime-entry.js';

// The shell's CLIENT reducer, loaded through a non-literal specifier ON PURPOSE.
//
// We want to replay our events through the real `applyStreamEvent` — that is
// what makes assertion (b) a statement about the actual UI. But a static import
// would also drag the shell's client type tree (→ @cockpit/shared-utils) into
// THIS repo's tsc program, where our stricter options (noUncheckedIndexedAccess)
// reject code the shell compiles fine under its own tsconfig. The alternatives
// were to weaken our tsconfig or to patch shell source — both worse than
// deferring this one resolution to runtime. `applyStreamEvent` is a pure
// function whose only imports are type-only, so nothing else loads with it.
const CLIENT_REDUCER =
  '../../shell/packages/feature/agent/src/client/applyStreamEvent.js';

/** Structural mirror of the shell's ChatMessage — only the fields we assert on. */
type ClientChatMessage = {
  id: string;
  role: string;
  content: string;
  toolCalls?: { id: string; name: string; result?: string; isLoading?: boolean }[];
  isStreaming?: boolean;
};

type ApplyStreamEvent = (
  messages: ClientChatMessage[],
  ev: unknown,
  opts: { engine?: string; assistantId: string },
) => ClientChatMessage[];

type Check = { name: string; pass: boolean; evidence: string };

function record(checks: Check[], name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

// ---------------------------------------------------------------------------
// Scripted mock model — one send_message tool call, then a final text.
// ---------------------------------------------------------------------------

const ZERO_USAGE = {
  inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 },
};

function toolCallStep(
  toolCallId: string,
  input: Record<string, unknown>,
): LanguageModelV4GenerateResult {
  return {
    content: [
      { type: 'tool-call', toolCallId, toolName: 'send_message', input: JSON.stringify(input) },
    ],
    finishReason: { unified: 'tool-calls', raw: 'tool_use' },
    usage: ZERO_USAGE,
    warnings: [],
  };
}

function finalTextStep(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'end_turn' },
    usage: ZERO_USAGE,
    warnings: [],
  };
}

const FINAL_TEXT = 'Sent the message as requested.';

function scriptedModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: [
      toolCallStep('call-1', { to: 'alice', text: 'hi' }),
      finalTextStep(FINAL_TEXT),
    ],
  });
}

/** Aborts the run's signal from inside the model call, then returns a tool
 *  call. Nothing downstream of the abort may execute. */
function abortingModel(controller: AbortController): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async (): Promise<LanguageModelV4GenerateResult> => {
      controller.abort();
      return toolCallStep('call-abort', { to: 'alice', text: 'should never send' });
    },
  });
}

// ---------------------------------------------------------------------------
// A fake RunCtx that captures everything, on ONE interleaved timeline so that
// ordering between gate decisions and emitted events is directly observable.
// ---------------------------------------------------------------------------

type TimelineItem =
  | { k: 'emit'; event: RunEvent }
  | { k: 'gate'; entry: GateLogEntry };

type Harness = {
  ctx: RunCtx;
  timeline: TimelineItem[];
  events: RunEvent[];
  rekeys: string[];
  onGateDecision: (entry: GateLogEntry) => void;
};

function makeHarness(controller: AbortController, prompt: string): Harness {
  const timeline: TimelineItem[] = [];
  const events: RunEvent[] = [];
  const rekeys: string[] = [];
  let key = 'provisional-run-key';

  const ctx: RunCtx = {
    prompt,
    images: undefined,
    cwd: '/tmp/naby-spike',
    sessionId: undefined,
    params: { prompt, engine: 'naby' },
    signal: controller.signal,
    emit(event: RunEvent): void {
      events.push(event);
      timeline.push({ k: 'emit', event });
    },
    rekey(realSessionId: string): void {
      rekeys.push(realSessionId);
      key = realSessionId;
    },
    currentKey(): string {
      return key;
    },
  };

  return {
    ctx,
    timeline,
    events,
    rekeys,
    onGateDecision: (entry) => timeline.push({ k: 'gate', entry }),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const typeOf = (e: RunEvent): string => String(e.type ?? '');

function firstOfType(events: RunEvent[], type: string): RunEvent | undefined {
  return events.find((e) => typeOf(e) === type);
}

/** Index on the timeline of the first emitted event matching a predicate. */
function emitIndex(timeline: TimelineItem[], pred: (e: RunEvent) => boolean): number {
  return timeline.findIndex((t) => t.k === 'emit' && pred(t.event));
}

function gateIndex(timeline: TimelineItem[], toolName: string): number {
  return timeline.findIndex((t) => t.k === 'gate' && t.entry.toolName === toolName);
}

/** Does this event carry a tool_result block for the given tool_use id? */
function isToolResultFor(e: RunEvent, toolUseId: string): boolean {
  if (typeOf(e) !== 'user') return false;
  const content = (e.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return false;
  return content.some((b) => (b as { tool_use_id?: string }).tool_use_id === toolUseId);
}

function toolResultText(e: RunEvent): string {
  const content = (e.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => String((b as { content?: unknown }).content ?? ''))
    .join('');
}

/**
 * Replay the captured events through the shell's OWN client reducer. Whatever
 * this produces is literally what the chat bubble would show — so a passing
 * assertion here is a statement about the real UI, not about our event shapes.
 */
function renderThroughClient(
  applyStreamEvent: ApplyStreamEvent,
  events: RunEvent[],
): ClientChatMessage {
  const assistantId = 'asst-1';
  let messages: ClientChatMessage[] = [
    { id: assistantId, role: 'assistant', content: '', toolCalls: [], isStreaming: true },
  ];
  for (const e of events) {
    messages = applyStreamEvent(messages, e, { engine: 'naby', assistantId });
  }
  return messages[0]!;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const checks: Check[] = [];

  const { applyStreamEvent } = (await import(CLIENT_REDUCER)) as {
    applyStreamEvent: ApplyStreamEvent;
  };

  // ==== Run 1: the happy path ==============================================
  const controller = new AbortController();
  const h = makeHarness(controller, "Send 'hi' to alice using the send_message tool.");
  const model = scriptedModel();

  // The mock model is injected through the production ModelResolver seam.
  const resolveModel: ModelResolver = () => model;
  const spec = createNabySpec({ resolveModel, onGateDecision: h.onGateDecision });

  // preflight must pass without any API key present (a resolver is injected).
  const pre = await spec.preflight?.({ prompt: 'x', engine: 'naby' });

  await spec.runner.run(h.ctx);

  const rendered = renderThroughClient(applyStreamEvent, h.events);

  // ---- (a) init + rekey ---------------------------------------------------
  const init = firstOfType(h.events, 'system');
  const initSessionId = init?.session_id as string | undefined;
  const aOk =
    !!init &&
    init.subtype === 'init' &&
    typeof initSessionId === 'string' &&
    initSessionId.length > 0 &&
    h.rekeys.length === 1 &&
    h.rekeys[0] === initSessionId &&
    h.ctx.currentKey() === initSessionId;

  record(
    checks,
    '(a) system/init emitted with a session id, and rekey() called with the same id',
    aOk,
    `spec.name=${spec.name}; preflight=${JSON.stringify(pre)}; ` +
      `init.subtype=${String(init?.subtype)}; session_id=${String(initSessionId)}; ` +
      `tools=${JSON.stringify(init?.tools)}; model=${String(init?.model)}; ` +
      `rekey calls=${JSON.stringify(h.rekeys)}; currentKey=${h.ctx.currentKey()}`,
  );

  // ---- (b) assistant text in the client-expected shape --------------------
  const streamEvents = h.events.filter((e) => typeOf(e) === 'stream_event');
  const deltaTexts = streamEvents.map((e) => {
    const ev = e.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
    return ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta'
      ? (ev.delta.text ?? '')
      : '';
  });
  const bOk =
    deltaTexts.join('') === FINAL_TEXT && rendered.content.includes(FINAL_TEXT);

  record(
    checks,
    "(b) assistant text reaches emit in the client's shape (verified through the shell's own reducer)",
    bOk,
    `stream_event count=${streamEvents.length}; delta text=${JSON.stringify(deltaTexts.join(''))}; ` +
      `applyStreamEvent rendered content=${JSON.stringify(rendered.content)}`,
  );

  // ---- (c) gate BEFORE executor ------------------------------------------
  const gateAt = gateIndex(h.timeline, 'send_message');
  const toolUseAt = emitIndex(
    h.timeline,
    (e) =>
      typeOf(e) === 'assistant' &&
      Array.isArray((e.message as { content?: unknown }).content) &&
      ((e.message as { content: unknown[] }).content as { type?: string }[]).some(
        (b) => b.type === 'tool_use',
      ),
  );
  const toolResultAt = emitIndex(h.timeline, (e) => isToolResultFor(e, 'call-1'));
  const resultEvent = h.events.find((e) => isToolResultFor(e, 'call-1'));
  const resultText = resultEvent ? toolResultText(resultEvent) : '';
  const gateEntry = h.timeline.find(
    (t): t is { k: 'gate'; entry: GateLogEntry } => t.k === 'gate',
  )?.entry;

  const cOk =
    gateAt >= 0 &&
    toolResultAt >= 0 &&
    gateAt < toolResultAt &&
    toolUseAt >= 0 &&
    toolUseAt < toolResultAt &&
    gateEntry?.decision.behavior === 'allow' &&
    // Only the REAL send_message executor produces this receipt text.
    resultText.includes('sent to alice') &&
    // and the client merged it onto the tool call it belongs to.
    rendered.toolCalls?.some((tc) => tc.id === 'call-1' && !tc.isLoading) === true;

  record(
    checks,
    '(c) the tool call went through OUR GATE before its executor ran',
    cOk,
    `timeline: tool_use@${toolUseAt} gate@${gateAt} tool_result@${toolResultAt} ` +
      `(gate must precede tool_result); gate log entry=${JSON.stringify({
        toolName: gateEntry?.toolName,
        toolCallId: gateEntry?.toolCallId,
        input: gateEntry?.input,
        decision: gateEntry?.decision,
      })}; executor output=${JSON.stringify(resultText)}; ` +
      `client toolCalls=${JSON.stringify(rendered.toolCalls?.map((t) => ({ id: t.id, name: t.name, done: !t.isLoading })))}`,
  );

  // ---- (d) terminal result, is_error false --------------------------------
  const final = firstOfType(h.events, 'result');
  const dOk =
    !!final &&
    final.is_error === false &&
    final.subtype === 'success' &&
    final.session_id === initSessionId &&
    typeof final.usage === 'object' &&
    rendered.isStreaming === false;

  record(
    checks,
    '(d) a final result event with is_error:false ends the turn',
    dOk,
    `result=${JSON.stringify({
      subtype: final?.subtype,
      is_error: final?.is_error,
      session_id: final?.session_id,
      result: final?.result,
      usage: final?.usage,
      num_turns: final?.num_turns,
    })}; client bubble isStreaming=${String(rendered.isStreaming)}`,
  );

  // ==== Run 2: abort =======================================================
  const abortController = new AbortController();
  const ha = makeHarness(abortController, 'Send something, but I will stop you.');
  const aborting = abortingModel(abortController);
  const abortSpec = createNabySpec({
    resolveModel: () => aborting,
    onGateDecision: ha.onGateDecision,
  });

  await abortSpec.runner.run(ha.ctx);

  const abortResult = ha.events.filter((e) => typeOf(e) === 'result');
  const abortToolResults = ha.events.filter((e) => isToolResultFor(e, 'call-abort'));
  const abortGateCalls = ha.timeline.filter((t) => t.k === 'gate');
  const lastAbortResult = abortResult[abortResult.length - 1];

  const eOk =
    abortController.signal.aborted &&
    abortResult.length >= 1 &&
    lastAbortResult?.is_error === true &&
    lastAbortResult?.subtype === 'error_during_execution' &&
    abortToolResults.length === 0 &&
    abortGateCalls.length === 0;

  record(
    checks,
    '(e) aborting ctx.signal stops the run and yields an error result, with no tool executed',
    eOk,
    `aborted=${String(abortController.signal.aborted)}; result events=${abortResult.length}; ` +
      `final=${JSON.stringify({
        subtype: lastAbortResult?.subtype,
        is_error: lastAbortResult?.is_error,
        result: lastAbortResult?.result,
      })}; tool_result events=${abortToolResults.length} (must be 0); ` +
      `gate consultations=${abortGateCalls.length} (must be 0 — aborted before any tool)`,
  );

  // ==== Report =============================================================
  console.log('\n=== SPIKE-02 — the shell engine layer runs our runtime (mock model, no keys) ===\n');
  let allPass = true;
  for (const c of checks) {
    const tag = c.pass ? 'PASS' : 'FAIL';
    if (!c.pass) allPass = false;
    console.log(`[${tag}] ${c.name}`);
    console.log(`        evidence: ${c.evidence}`);
  }
  console.log(
    `\nSPIKE-02: ${allPass ? 'ALL PASS' : 'FAILURES PRESENT'} (${
      checks.filter((c) => c.pass).length
    }/${checks.length})\n`,
  );

  if (!allPass) process.exit(1);
}

main().catch((e) => {
  console.error('SPIKE-02 crashed:', e);
  process.exit(1);
});
