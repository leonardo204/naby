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
//   (g) THE DELEGATION POLICY RIDES IN THE TOOL DESCRIPTION, and only when it is
//       true (subagent-delegation §4.2). On every engine but dev-claude this
//       description is the only place a model is told when to delegate, so the
//       shared policy string is appended here — but a policy naming a subagent the
//       turn does not have invites a delegation that can only fail, and a policy
//       telling the model to hand code changes to `implementer` on a read-only
//       turn invites a refusal. So: explorer's half appears when explorer is in
//       the roster, implementer's half only when it is in the roster AND the turn
//       permits changes, and a roster of neither gets no policy at all.
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
import {
  DEFAULT_USER_ID,
  DELEGATE_TOOL_NAME,
  DELEGATION_POLICY,
  delegateSchema,
  EXPLORER_SUBAGENT,
  IMPLEMENTER_SUBAGENT,
  type ModelResolver,
  type SubagentSpec,
} from '../runtime-entry.js';

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

/** A roster entry, as `gatherSubagents` would hand one over. Only the name is
 *  load-bearing for the policy; the rest is what a real spec carries. */
function spec(name: string): SubagentSpec {
  return { name, description: `the ${name}`, systemPrompt: `You are the ${name}.` };
}

/** (g) The policy conditions, asserted against `delegateSchema` DIRECTLY rather
 *  than through a mock turn: the rosters that matter are the ones production will
 *  not produce until M2 wires the filter, and the description is the artifact
 *  under test. */
function checkDelegationPolicy(): void {
  const both = delegateSchema([spec(EXPLORER_SUBAGENT), spec(IMPLEMENTER_SUBAGENT)], {
    canMutate: true,
  }).description;
  record(
    '(g) both built-ins present on a turn that may change things -> the whole policy',
    both.includes(DELEGATION_POLICY) &&
      both.includes(`"${EXPLORER_SUBAGENT}"`) &&
      both.includes(`"${IMPLEMENTER_SUBAGENT}"`),
    `description ends: ${JSON.stringify(both.slice(-120))}`,
  );

  const readOnly = delegateSchema([spec(EXPLORER_SUBAGENT), spec(IMPLEMENTER_SUBAGENT)], {
    canMutate: false,
  }).description;
  record(
    '(g) the SAME roster on a read-only turn keeps explorer and drops implementer',
    readOnly.includes('Delegation policy:') &&
      readOnly.includes(`goes to "${EXPLORER_SUBAGENT}"`) &&
      !readOnly.includes(`goes to "${IMPLEMENTER_SUBAGENT}"`),
    `mentions explorer=${readOnly.includes(`goes to "${EXPLORER_SUBAGENT}"`)}; ` +
      `mentions implementer=${readOnly.includes(`goes to "${IMPLEMENTER_SUBAGENT}"`)}`,
  );

  const explorerOnly = delegateSchema([spec(EXPLORER_SUBAGENT), spec('reviewer')], {
    canMutate: true,
  }).description;
  record(
    '(g) a roster with explorer alone names explorer alone',
    explorerOnly.includes(`goes to "${EXPLORER_SUBAGENT}"`) &&
      !explorerOnly.includes(IMPLEMENTER_SUBAGENT),
    `implementer named anywhere=${explorerOnly.includes(IMPLEMENTER_SUBAGENT)}`,
  );

  const implementerOnly = delegateSchema([spec(IMPLEMENTER_SUBAGENT)], {
    canMutate: true,
  }).description;
  record(
    '(g) ...and a roster with implementer alone names implementer alone',
    implementerOnly.includes(`goes to "${IMPLEMENTER_SUBAGENT}"`) &&
      !implementerOnly.includes(EXPLORER_SUBAGENT),
    `explorer named anywhere=${implementerOnly.includes(EXPLORER_SUBAGENT)}`,
  );

  const none = delegateSchema([spec('reviewer'), spec('narrow')], { canMutate: true }).description;
  const noneReadOnly = delegateSchema([spec(IMPLEMENTER_SUBAGENT)], {
    canMutate: false,
  }).description;
  const defaulted = delegateSchema([spec(IMPLEMENTER_SUBAGENT)]).description;
  record(
    '(g) no built-in in the roster -> NO policy at all, and the old description is intact',
    !none.includes('Delegation policy:') &&
      none.includes('Hand a self-contained piece of work') &&
      none.includes('"reviewer"') &&
      // An implementer-only roster on a read-only turn has nothing left to say…
      !noneReadOnly.includes('Delegation policy:') &&
      // …and a caller that has not been taught about mutation gets that same
      // conservative answer rather than an instruction the turn may not follow.
      !defaulted.includes('Delegation policy:'),
    `no-builtin roster carries policy=${none.includes('Delegation policy:')}; ` +
      `implementer on a read-only turn=${noneReadOnly.includes('Delegation policy:')}; ` +
      `no canMutate argument=${defaulted.includes('Delegation policy:')}`,
  );
}

async function main(): Promise<void> {
  checkDelegationPolicy();

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
