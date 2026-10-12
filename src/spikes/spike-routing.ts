// src/spikes/spike-routing.ts
//
// Phase 3 (P3-M2) verification: AN `@`-ROUTED TURN, driven for real.
//
// P3-M2 wired `@name <task>` routing and left one line open: "not verified — does
// a routed turn really override the system prompt, does the toolRefs deny fire,
// does memory injection reach the model". Those are WIRING questions, so this
// spike answers them by execution rather than by reading the code.
//
// NO NETWORK, NO KEYS. Same vertical slice and injection seam as SPIKE-02 and
// spike-autonomy: the shell's real EngineSpec drives the real AiSdkEngine, gate
// and executors, with `MockLanguageModelV4` substituted through the production
// `ModelResolver`. What the mock records is exactly what a live model would be
// handed, so "is X in the prompt" is answered without paying for a model.
//
// The product has moved since P3-M2 and the checks follow it:
//   - P3-M11: the built-in agent is `@naby`, and there is no creation UI — a
//     custom agent now arrives by IMPORT (P3-M7), so the custom rows below stand
//     in for imported ones.
//   - P3-M12a: `@` routes at ANY stage; the stage decides the action range. So an
//     egg is routed (identity adopted) but stage-limited, and only a butterfly
//     runs unconstrained.
//
// Asserted:
//   (a)  `@naby <task>` adopts the built-in agent: its seed prompt OPENS the one
//        system message, the model sees the task without the `@naby` handle, and
//        the init event names naby as the acting agent.
//   (a2) the persona on a fresh install is an egg: still routed, with the
//        stage-limited pill (M12a), not refused.
//   (b)  memory injection reaches the model on a routed turn (a confirmed memory
//        is in the system prompt) and a PROPOSED one is not.
//   (c)  an unaddressed turn does NOT adopt an agent prompt, yet still gets the
//        general memory injection (P3-M2: "every turn").
//   (d)  toolRefs is an allowlist enforced at the gate: a tool outside it is
//        denied with the agent's reason and its executor never runs, a tool inside
//        it runs; the same script on an agent WITHOUT toolRefs is not denied.
//   (e)  the routed agent's `model` is the one the resolver is asked for.
//   (f)  an imported agent (custom row, no ledger → egg) is routed and its stage
//        contract refuses the irreversible tool.
//   (g)  `@nobody` (no such agent) is not routing: the text reaches the model
//        intact and no agent prompt is adopted.
//
// Prints PASS/FAIL per assertion; exits non-zero on any FAIL.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the shell adapter's SQLite store at a throwaway dir BEFORE importing it.
const TMP_DIR = mkdtempSync(join(tmpdir(), 'naby-spike-routing-'));
process.env.NABY_DB_PATH = join(TMP_DIR, 'app.db');

import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';

import {
  createNabySpec,
  getStore,
} from '../../shell/packages/feature/agent/src/server/engines/naby.js';
import { BUILTIN_PERSONA_ID, BUILTIN_PERSONA_NAME } from '../runtime-entry.js';
import type { RunCtx, RunEvent } from '../../shell/packages/feature/agent/src/server/engines/types.js';
import type { ModelResolver, MemoryWriteRequest } from '../runtime-entry.js';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

// ---------------------------------------------------------------------------
// Scripted model + prompt capture
// ---------------------------------------------------------------------------

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function call(id: string, toolName: string, input: object): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) }],
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

type PromptMsg = { role: string; content: unknown };

type Run = {
  events: RunEvent[];
  /** One entry per model call: the structured prompt the model was handed. */
  prompts: PromptMsg[][];
  /** Every ModelSelection the resolver was asked for. */
  selections: { providerId: string; model?: string }[];
  calls: number;
};

async function run(prompt: string, script: LanguageModelV4GenerateResult[]): Promise<Run> {
  const prompts: PromptMsg[][] = [];
  const selections: { providerId: string; model?: string }[] = [];
  let i = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async (options: unknown): Promise<LanguageModelV4GenerateResult> => {
      prompts.push(((options as { prompt?: PromptMsg[] }).prompt ?? []) as PromptMsg[]);
      const next = script[i];
      i += 1;
      return next ?? text('(unscripted extra call)');
    },
  });
  const resolveModel: ModelResolver = (selection) => {
    selections.push(selection);
    return model;
  };
  const events: RunEvent[] = [];
  const controller = new AbortController();
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
  await createNabySpec({ resolveModel }).runner.run(ctx);
  return { events, prompts, selections, calls: i };
}

/** Flatten one message's content (string or parts) to text. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        const part = p as { type?: string; text?: string; output?: unknown; result?: unknown };
        if (typeof part.text === 'string') return part.text;
        return JSON.stringify(part.output ?? part.result ?? part);
      })
      .join('\n');
  }
  return JSON.stringify(content ?? '');
}

const systemsOf = (p: PromptMsg[]): string[] =>
  p.filter((m) => m.role === 'system').map((m) => textOf(m.content));
const firstUserOf = (p: PromptMsg[]): string =>
  textOf(p.find((m) => m.role === 'user')?.content ?? '');
const toolResultsOf = (p: PromptMsg[]): string =>
  p.filter((m) => m.role === 'tool').map((m) => textOf(m.content)).join('\n');

function pills(events: RunEvent[], subtype: string): string[] {
  return events
    .filter(
      (e) =>
        String(e.type ?? '') === 'system' &&
        e.subtype === 'harness' &&
        (e as { harness_subtype?: string }).harness_subtype === subtype,
    )
    .map((e) => String((e as { harness_detail?: string }).harness_detail ?? ''));
}

function actingAgent(events: RunEvent[]): { name?: string; persona?: boolean } | undefined {
  const init = events.find((e) => String(e.type ?? '') === 'system' && e.subtype === 'init');
  return (init as { acting_agent?: { name?: string; persona?: boolean } } | undefined)?.acting_agent;
}

/** A butterfly's record: 8 straight check-in hits (Wilson lower bound over the
 *  0.60 line — runtime/growth.ts), the same way spike-autonomy earns it. */
function growUp(agentId: string): void {
  for (let k = 0; k < 8; k += 1) {
    getStore().appendEvalEvent({
      kind: 'checkin',
      agentId,
      sessionId: `grow-${agentId}-${k}`,
      taskType: 'testing',
      at: 1_000 + k,
      options: ['a', 'b'],
      recommended: 0,
      chosen: 0,
      hit: true,
    });
  }
}

function putCustom(name: string, extra: { toolRefs?: string[]; model?: string } = {}): string {
  return getStore().putAgent({
    name,
    kind: 'custom',
    systemPrompt: `You are ${name}, a routing test agent. ROUTE-MARK-${name}`,
    memoryScope: 'user',
    autonomy: { escalation: 'inline' },
    ...extra,
  }).id;
}

const CONFIRMED_FACT = 'Prefers metric units ZQX-CONFIRMED-7781';
const PROPOSED_FACT = 'Likes tabs over spaces ZQX-PROPOSED-4410';

function seedMemory(): void {
  const base = {
    scope: 'user',
    scopeKey: 'local',
    type: 'semantic',
    provenance: { source: 'user' },
    confidence: 1,
  };
  getStore().putMemory({
    ...base,
    key: 'units',
    value: CONFIRMED_FACT,
    requestedStatus: 'confirmed',
  } as MemoryWriteRequest);
  getStore().putMemory({
    ...base,
    key: 'indent',
    value: PROPOSED_FACT,
    requestedStatus: 'proposed',
  } as MemoryWriteRequest);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // getStore() seeds the built-in persona (composition root), so this read is
  // what a fresh install holds.
  const persona = getStore().getAgent(BUILTIN_PERSONA_ID);
  if (!persona) throw new Error('built-in persona was not seeded');
  seedMemory();

  // ==== (a)/(b) `@naby` on a fresh install =================================
  const task = 'summarise what we agreed yesterday';
  const r1 = await run(`@${BUILTIN_PERSONA_NAME} ${task}`, [text('Here is the summary.')]);
  const sys1 = r1.prompts[0] ? systemsOf(r1.prompts[0]) : [];
  record(
    '(a) @naby: the seed prompt OPENS the single system message (identity adopted)',
    sys1.length === 1 && sys1[0]!.startsWith(persona.systemPrompt),
    `system messages: ${sys1.length}, head: ${JSON.stringify((sys1[0] ?? '').slice(0, 60))}`,
  );
  const user1 = r1.prompts[0] ? firstUserOf(r1.prompts[0]) : '';
  record(
    '(a1) the model gets the task text without the @naby handle',
    user1.includes(task) && !user1.includes(`@${BUILTIN_PERSONA_NAME}`),
    `user text: ${JSON.stringify(user1.slice(0, 80))}`,
  );
  const acting1 = actingAgent(r1.events);
  record(
    '(a2) init names naby as the acting agent',
    acting1?.name === BUILTIN_PERSONA_NAME && acting1.persona === true,
    `acting_agent: ${JSON.stringify(acting1)}`,
  );
  const gate1 = pills(r1.events, 'routing-gate');
  record(
    '(a3) an egg persona is ROUTED, stage-limited (M12a), not refused',
    gate1.length === 1 && gate1[0] === `stage-limited:egg:${BUILTIN_PERSONA_NAME}`,
    `routing-gate pills: ${JSON.stringify(gate1)}`,
  );
  record(
    '(b) a CONFIRMED memory reaches the routed turn\'s system prompt',
    (sys1[0] ?? '').includes(CONFIRMED_FACT),
    `confirmed fact in system: ${(sys1[0] ?? '').includes(CONFIRMED_FACT)}`,
  );
  record(
    '(b2) a PROPOSED memory does not',
    !(sys1[0] ?? '').includes(PROPOSED_FACT),
    `proposed fact in system: ${(sys1[0] ?? '').includes(PROPOSED_FACT)}`,
  );

  // ==== (c) an unaddressed turn ============================================
  const r2 = await run('what units do I like?', [text('Metric.')]);
  const sys2 = r2.prompts[0] ? systemsOf(r2.prompts[0]) : [];
  const all2 = sys2.join('\n');
  record(
    '(c) an unaddressed turn adopts NO agent prompt',
    !all2.includes(persona.systemPrompt.slice(0, 40)) && !all2.includes('ROUTE-MARK-'),
    `persona head in system: ${all2.includes(persona.systemPrompt.slice(0, 40))}`,
  );
  record(
    '(c2) …but still gets the general memory injection',
    all2.includes(CONFIRMED_FACT) && !all2.includes(PROPOSED_FACT),
    `confirmed: ${all2.includes(CONFIRMED_FACT)}, proposed: ${all2.includes(PROPOSED_FACT)}`,
  );
  record(
    '(c3) the persona is still the acting agent (growthSubject) on a plain turn',
    actingAgent(r2.events)?.name === BUILTIN_PERSONA_NAME && pills(r2.events, 'routing-gate').length === 0,
    `acting_agent: ${JSON.stringify(actingAgent(r2.events))}`,
  );

  // ==== (d)/(e) toolRefs allowlist on a butterfly custom agent =============
  //
  // A butterfly, so the stage contract is out of the way and the only thing
  // that can deny `send_message` is the agent's own allowlist.
  const scoutId = putCustom('scout', { toolRefs: ['echo_note'], model: 'mock-scout-model' });
  growUp(scoutId);
  const toolScript = (): LanguageModelV4GenerateResult[] => [
    call('t1', 'send_message', { to: 'alice', text: 'ROUTE-SENT' }),
    call('t2', 'echo_note', { text: 'ECHO-OK-5521' }),
    text('done'),
  ];
  const r3 = await run('@scout send alice a note', toolScript());
  const sys3 = r3.prompts[0] ? systemsOf(r3.prompts[0]) : [];
  record(
    '(d0) @scout adopts the custom agent prompt, and is not stage-limited (butterfly)',
    (sys3[0] ?? '').startsWith('You are scout') && pills(r3.events, 'routing-gate').length === 0,
    `head: ${JSON.stringify((sys3[0] ?? '').slice(0, 40))}, pills: ${JSON.stringify(pills(r3.events, 'routing-gate'))}`,
  );
  const afterDeny = r3.prompts[1] ? toolResultsOf(r3.prompts[1]) : '';
  record(
    '(d) a tool OUTSIDE toolRefs is denied at the gate with the agent\'s reason',
    afterDeny.includes('agent @scout is limited to its allowed tools'),
    `tool result after send_message: ${JSON.stringify(afterDeny.slice(0, 160))}`,
  );
  record(
    '(d1) …and its executor never ran (no send receipt in the tool result)',
    !afterDeny.includes('sent to alice'),
    `send receipt present: ${afterDeny.includes('sent to alice')}`,
  );
  const afterEcho = r3.prompts[2] ? toolResultsOf(r3.prompts[2]) : '';
  record(
    '(d2) a tool INSIDE toolRefs runs',
    afterEcho.includes('ECHO-OK-5521') && r3.calls === 3,
    `echo result: ${JSON.stringify(afterEcho.slice(-120))}, model calls: ${r3.calls}`,
  );
  record(
    '(e) the routed agent\'s model is what the resolver is asked for',
    r3.selections.length > 0 && r3.selections.every((s) => s.model === 'mock-scout-model'),
    `selections: ${JSON.stringify(r3.selections)}`,
  );

  // Control: the same script on a butterfly WITHOUT toolRefs is not denied, so
  // the deny above is the allowlist and nothing else.
  const freeId = putCustom('freehand');
  growUp(freeId);
  const r4 = await run('@freehand send alice a note', toolScript());
  const afterSend4 = r4.prompts[1] ? toolResultsOf(r4.prompts[1]) : '';
  record(
    '(d3) control: without toolRefs the same send_message is not denied',
    afterSend4.length > 0 && !afterSend4.includes('limited to its allowed tools'),
    `tool result: ${JSON.stringify(afterSend4.slice(0, 120))}`,
  );

  // ==== (f) an imported agent: custom row, no ledger → egg =================
  putCustom('imported-helper');
  const r5 = await run('@imported-helper send alice a note', [
    call('i1', 'send_message', { to: 'alice', text: 'x' }),
    text('could not send'),
  ]);
  const sys5 = r5.prompts[0] ? systemsOf(r5.prompts[0]) : [];
  const afterSend5 = r5.prompts[1] ? toolResultsOf(r5.prompts[1]) : '';
  record(
    '(f) an imported (egg) agent is routed: its prompt opens the system message',
    (sys5[0] ?? '').startsWith('You are imported-helper') &&
      JSON.stringify(pills(r5.events, 'routing-gate')) === '["stage-limited:egg:imported-helper"]',
    `head: ${JSON.stringify((sys5[0] ?? '').slice(0, 40))}, pills: ${JSON.stringify(pills(r5.events, 'routing-gate'))}`,
  );
  record(
    '(f2) …and its stage contract refuses the irreversible tool',
    afterSend5.length > 0 && !afterSend5.includes('limited to its allowed tools') &&
      /stage|egg|not yet|cannot|refus|denied/i.test(afterSend5),
    `tool result: ${JSON.stringify(afterSend5.slice(0, 160))}`,
  );

  // ==== (g) `@nobody` is just text =========================================
  const r6 = await run('@nobody hello there', [text('hi')]);
  const sys6 = r6.prompts[0] ? systemsOf(r6.prompts[0]).join('\n') : '';
  const user6 = r6.prompts[0] ? firstUserOf(r6.prompts[0]) : '';
  record(
    '(g) @<unknown> is not routing: text intact, no agent prompt, no gate pill',
    user6.includes('@nobody hello there') &&
      !sys6.includes('ROUTE-MARK-') &&
      !sys6.includes(persona.systemPrompt.slice(0, 40)) &&
      pills(r6.events, 'routing-gate').length === 0,
    `user text: ${JSON.stringify(user6.slice(0, 60))}`,
  );

  // ---- report ---------------------------------------------------------------
  let failed = 0;
  for (const c of checks) {
    if (!c.pass) failed += 1;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}\n      ${c.evidence}`);
  }
  console.log(`\nspike-routing: ${checks.length - failed}/${checks.length} PASS`);
  return void (process.exitCode = failed > 0 ? 1 : 0);
}

main()
  .catch((err) => {
    console.error('spike-routing crashed:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });
