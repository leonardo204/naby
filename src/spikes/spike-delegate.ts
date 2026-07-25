// src/spikes/spike-delegate.ts
//
// Phase 2.5 (M4b) verification: SUBAGENTS ON THE AI-SDK ENGINE, run for real.
//
// NO NETWORK, NO KEYS. The same vertical slice as SPIKE-02 and spike-autonomy:
// the shell's real EngineSpec drives our real AiSdkEngine, our real gate and our
// real executors, with `MockLanguageModelV4` substituted through the production
// `ModelResolver`. The new ingredient is an ENABLED `subagent` harness row, so
// what runs here is what runs when a user's imported subagent is delegated to.
//
// WHY THIS MILESTONE EXISTED AT ALL. M4a mapped `SubagentSpec` onto the Agent
// SDK's native `agents`; the AI-SDK engine ignored the field entirely. The same
// imported subagent was therefore reachable on one engine and invisible on the
// other — provider-dependence in the one place the runtime exists to prevent it.
//
// Asserted, by execution:
//   (a) The tool is offered when a subagent exists, and ABSENT when none does —
//       a turn never advertises delegation it cannot perform.
//   (b) Delegating actually runs a nested turn: the subagent's OWN system prompt
//       reaches the model, and its answer comes back as the tool result.
//   (c) The nested exchange lands in a CHILD session. The parent's transcript
//       must not contain words the user never said and never saw.
//   (d) `toolRefs` NARROWS the nested toolset, and cannot widen it.
//   (e) `naby_delegate` is never offered inside a nested turn — without this the
//       nested run inherits the parent's executor (depth 0) and recurses forever.
//   (f) An unknown subagent name is a tool error that names the real ones.
//
// Prints PASS/FAIL per assertion; exits non-zero on any FAIL.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point the shell adapter's SQLite store at a throwaway dir BEFORE importing it
// (the documented NABY_DB_PATH override — no test-only branch in the adapter).
const TMP_DIR = mkdtempSync(join(tmpdir(), 'naby-spike-delegate-'));
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
import { DEFAULT_USER_ID, DELEGATE_TOOL_NAME, type ModelResolver } from '../runtime-entry.js';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function text(t: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text: t }],
    finishReason: { unified: 'stop', raw: 'end_turn' },
    usage: USAGE,
    warnings: [],
  };
}

function delegateCall(id: string, agent: string, task: string): LanguageModelV4GenerateResult {
  return {
    content: [
      { type: 'tool-call', toolCallId: id, toolName: DELEGATE_TOOL_NAME, input: JSON.stringify({ agent, task }) },
    ],
    finishReason: { unified: 'tool-calls', raw: 'tool_use' },
    usage: USAGE,
    warnings: [],
  };
}

type Scripted = {
  model: MockLanguageModelV4;
  /** Every payload the model was handed, JSON-stringified — system prompt included. */
  prompts: string[];
  calls: () => number;
};

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

/** Register an ENABLED subagent the same way an import would, then enable it —
 *  external-origin harness lands disabled by the gate, which is the rule this
 *  spike must go through rather than around. */
function addSubagent(name: string, systemPrompt: string, toolRefs?: string[]): void {
  const saved = getStore().putHarnessItem({
    item: {
      scope: 'user',
      scopeKey: DEFAULT_USER_ID,
      kind: 'subagent',
      name,
      description: `${name} test subagent`,
      provenance: { source: 'user', origin: 'spike' },
      subagent: { systemPrompt, ...(toolRefs ? { toolRefs } : {}) },
    },
    requestedStatus: 'enabled',
  });
  if (saved.status !== 'enabled') getStore().setHarnessEnabled(saved.id, true);
}

async function runOnce(prompt: string, script: LanguageModelV4GenerateResult[]) {
  const controller = new AbortController();
  const h = makeHarness(controller, prompt);
  const s = scripted(script);
  const resolveModel: ModelResolver = () => s.model;
  await createNabySpec({ resolveModel }).runner.run(h.ctx);
  return { h, s };
}

const typeOf = (e: RunEvent): string => String(e.type ?? '');

/** The tool names the turn advertised, from its own init event. */
function offeredTools(events: RunEvent[]): string[] {
  const init = events.find((e) => typeOf(e) === 'system' && e.subtype === 'init');
  const tools = (init as { tools?: unknown } | undefined)?.tools;
  return Array.isArray(tools) ? tools.map(String) : [];
}

/** A message's text body, whatever variant it is. `RuntimeMessage` is a union and
 *  its 'tool' member has no `content`, so this reads structurally rather than
 *  narrowing on a discriminant the spike does not care about. */
function bodyOf(m: unknown): string {
  const r = (m ?? {}) as Record<string, unknown>;
  return JSON.stringify(r.content ?? r.output ?? '');
}

function toolResults(events: RunEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (typeOf(e) !== 'user') continue;
    const content = (e as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = block as { type?: string; content?: unknown };
      if (b.type === 'tool_result') out.push(typeof b.content === 'string' ? b.content : JSON.stringify(b.content));
    }
  }
  return out;
}

async function main(): Promise<void> {
  // ==== (a) absent with no subagents ======================================
  {
    const { h } = await runOnce('just answer me', [text('hello')]);
    record(
      '(a1) with no subagents registered, the delegate tool is not offered',
      !offeredTools(h.events).includes(DELEGATE_TOOL_NAME),
      `tools: ${JSON.stringify(offeredTools(h.events))}`,
    );
  }

  // ==== (a)(b)(c) delegate for real ======================================
  addSubagent('reviewer', 'You are the reviewer. Answer in one line.');
  const sessionsBefore = getStore().listSessions().length;
  const { h: h2, s: s2 } = await runOnce('review the parser for me', [
    // The parent delegates…
    delegateCall('d1', 'reviewer', 'Review src/parser.ts and list the risks.'),
    // …the NESTED turn answers (this call is the subagent's own)…
    text('The parser trusts its input length.'),
    // …and the parent wraps up.
    text('The reviewer found one risk.'),
  ]);

  const offered = offeredTools(h2.events);
  record(
    '(a2) with a subagent registered, the delegate tool IS offered',
    offered.includes(DELEGATE_TOOL_NAME),
    `tools: ${JSON.stringify(offered)}`,
  );

  // The nested call is the 2nd model call; its system prompt is the subagent's.
  const nestedPrompt = s2.prompts[1] ?? '';
  const parentPrompt = s2.prompts[0] ?? '';
  record(
    '(b) the nested turn carries the SUBAGENT\'s own system prompt, and its answer returns as the tool result',
    s2.calls() >= 2 &&
      nestedPrompt.includes('You are the reviewer') &&
      !parentPrompt.includes('You are the reviewer') &&
      nestedPrompt.includes('Review src/parser.ts') &&
      toolResults(h2.events).some((r) => r.includes('The parser trusts its input length')),
    `model calls=${s2.calls()}; nested system carries the subagent prompt=${nestedPrompt.includes('You are the reviewer')}; tool result=${JSON.stringify(toolResults(h2.events).map((r) => r.slice(0, 60)))}`,
  );

  const sessions = getStore().listSessions();
  const child = sessions.find((x) => (x.title ?? '').startsWith('[delegated]'));
  const parentMessages = getStore().getMessages(h2.sessionId());
  record(
    '(c) the nested exchange lands in a CHILD session, not in the parent transcript',
    sessions.length === sessionsBefore + 2 &&
      child !== undefined &&
      child.sessionId !== h2.sessionId() &&
      getStore()
        .getMessages(child!.sessionId)
        .some((m) => bodyOf(m).includes('Review src/parser.ts')) &&
      !parentMessages.some((m) => bodyOf(m).includes('You are the reviewer')),
    `sessions ${sessionsBefore} → ${sessions.length}; child="${child?.title ?? 'MISSING'}"`,
  );

  // ==== (d)(e) the nested toolset ========================================
  addSubagent('narrow', 'You are narrow.', ['echo_note']);
  const { h: h3, s: s3 } = await runOnce('use the narrow one', [
    delegateCall('d2', 'narrow', 'Say something.'),
    text('nested answer'),
    text('done'),
  ]);
  // What the nested call was actually offered, read out of its own payload.
  const nested3 = s3.prompts[1] ?? '';
  const nestedToolNames = [...nested3.matchAll(/"name":"([a-zA-Z0-9_]+)"/g)].map((m) => m[1]!);
  record(
    '(d) toolRefs narrows the nested toolset — and cannot widen it',
    nestedToolNames.includes('echo_note') &&
      !nestedToolNames.includes('send_message') &&
      !nestedToolNames.includes('fetch_url'),
    `nested tools: ${JSON.stringify([...new Set(nestedToolNames)])}`,
  );
  record(
    '(e) the nested turn is never offered naby_delegate — no unbounded recursion',
    !nestedToolNames.includes(DELEGATE_TOOL_NAME) &&
      // …while the PARENT of that same run was offered it.
      offeredTools(h3.events).includes(DELEGATE_TOOL_NAME),
    `nested has delegate=${nestedToolNames.includes(DELEGATE_TOOL_NAME)}; parent has delegate=${offeredTools(h3.events).includes(DELEGATE_TOOL_NAME)}`,
  );

  // ==== (f) an invented name ==============================================
  {
    const { h } = await runOnce('delegate to nobody', [
      delegateCall('d3', 'ghost', 'Do a thing.'),
      text('could not delegate'),
    ]);
    const results = toolResults(h.events);
    record(
      '(f) an unknown subagent is a tool error that names the ones that exist',
      results.some((r) => r.includes('no subagent called "ghost"')) &&
        results.some((r) => r.includes('reviewer')),
      `tool results: ${JSON.stringify(results.map((r) => r.slice(0, 110)))}`,
    );
  }
}

await main();

let failed = 0;
for (const c of checks) {
  if (!c.pass) failed += 1;
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}\n      ${c.evidence}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
rmSync(TMP_DIR, { recursive: true, force: true });
if (failed > 0) process.exitCode = 1;
