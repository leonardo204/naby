// src/spikes/spike-subagent-model-event.ts
//
// "WHICH MODEL DID THAT SUBAGENT ACTUALLY RUN ON" — the contract, without the SDK
// (specs/subagent-delegation.md §4.3).
//
// WHY A MOCK SPIKE EXISTS ALONGSIDE THE LIVE ONE. The live probe
// (`spike:subagent-model`) needs a sign-in, a network and a model that chooses to
// delegate, so it can legitimately come back INCONCLUSIVE — it is a decision
// record, not a regression gate. The RULE, though, is pure: read
// `message.model` on assistant messages that carry a `parent_tool_use_id`, emit
// once per id. That rule is what this asserts, every run, with no credentials,
// by feeding fabricated SDK message shapes through the same helper the engine
// calls.
//
// Asserted:
//   (a) ONE EVENT PER DELEGATED RUN. A subagent emits many assistant messages
//       and every one names the same model; the consumer wants a label, not a
//       stream. Two parallel subagents get one event each, keyed by the `Task`
//       call that spawned them.
//   (b) SILENCE WHERE THERE IS NOTHING TO SAY: main-thread messages (no parent
//       id), messages with no model, messages with a blank model. In particular
//       a blank reading must not consume the id — otherwise the FIRST message of
//       a run, which sometimes carries no model, would suppress the real one.
//   (c) THE ENGINE REALLY CALLS IT, and with a per-run Set. Asserted against the
//       engine's own source, because this file cannot import that module without
//       loading the Agent SDK — the same technique spike-harness-seed uses for
//       the tool re-qualification claim.
//   (d) THE RUNTIME LOGS IT, end to end: a fake Engine emits the event through
//       the REAL `runTurn` against the REAL SqliteStore, and the activity log
//       gets a `subagent_model` row carrying the model, the attribution key and
//       the agent type taken from the `Task` call that preceded it.
//   (e) IT IS OBSERVATIONAL. The turn's transcript must not grow a message for
//       it: the event is display and accounting, never conversation.
//   (f) THE ENVIRONMENT DIAGNOSTIC NEVER LEAKS A CREDENTIAL (§4.4). The other
//       half of "make the override visible": `engineEnvironmentNotes` reports the
//       variables that are set — and reports the two credential variables as
//       present and NOTHING MORE, because that list is drawn on a settings screen
//       and therefore into every screenshot of one. Asserted here because it is
//       the same kind of claim as the rest of this file: pure, and cheap to get
//       silently wrong.
//
// No network, no keys, no sign-in. A temp naby home, removed at exit.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The naby home for this run, set BEFORE the log module is imported — the
// documented NABY_DB_PATH override, so this never touches the real ~/.naby.
const TMP_DIR = mkdtempSync(join(tmpdir(), 'naby-spike-subagent-model-'));
process.env.NABY_DB_PATH = join(TMP_DIR, 'app.db');

import { subagentModelEvent } from '../engines/subagent-model.js';
import { activityLogDir, activityLogFileName } from '../runtime/activity-log.js';
import type { ActivityRecord } from '../runtime/activity-log.js';
import { engineEnvironmentNotes } from '../runtime/engine-env.js';
import type { Engine, EngineEvent } from '../runtime/engine.js';
import { runTurn } from '../runtime/session.js';
import { SqliteStore } from '../runtime/store/sqlite-store.js';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** One fabricated Agent SDK assistant message, reduced to the two fields the
 *  helper reads. The engine passes exactly these two. */
function assistant(parentToolUseId: unknown, model: unknown): { parentToolUseId: unknown; model: unknown } {
  return { parentToolUseId, model };
}

// ---------------------------------------------------------------------------
// (a) + (b) the rule itself
// ---------------------------------------------------------------------------

function checkHelper(): void {
  const seen = new Set<string>();
  const stream = [
    // The main thread announces itself first — nothing to report.
    assistant(null, 'claude-opus-5'),
    // Subagent A starts. Its very first message carries no model (observed on
    // replayed/synthesized messages), which must NOT burn the id.
    assistant('toolu_A', undefined),
    assistant('toolu_A', 'claude-haiku-4-5-20260101'),
    // …and keeps talking, on the same model, for the rest of its run.
    assistant('toolu_A', 'claude-haiku-4-5-20260101'),
    assistant('toolu_A', 'claude-haiku-4-5-20260101'),
    // A second, parallel delegation on a different model.
    assistant('toolu_B', 'claude-sonnet-5'),
    assistant('toolu_B', 'claude-sonnet-5'),
    // More main-thread narration in between.
    assistant(undefined, 'claude-opus-5'),
    // A blank model is a non-reading, not an event with an empty label.
    assistant('toolu_C', '   '),
    // A non-string parent id is not an attribution key.
    assistant(42, 'claude-haiku-4-5-20260101'),
  ];

  const events = stream
    .map((m) => subagentModelEvent(seen, m))
    .filter((e): e is Extract<EngineEvent, { kind: 'subagent_model' }> => e !== undefined);

  record(
    '(a) one event per delegated run, keyed by the Task call, in first-seen order',
    events.length === 2 &&
      events[0]?.agentToolCallId === 'toolu_A' &&
      events[0]?.model === 'claude-haiku-4-5-20260101' &&
      events[1]?.agentToolCallId === 'toolu_B' &&
      events[1]?.model === 'claude-sonnet-5',
    `${stream.length} messages -> ${events.length} events: ` +
      JSON.stringify(events.map((e) => `${e.agentToolCallId}=${e.model}`)),
  );

  record(
    '(b) nothing for the main thread, a missing model, a blank model or a non-string id',
    !events.some((e) => e.model.trim() === '') &&
      !seen.has('toolu_C') &&
      // The 'toolu_A' reading that mattered is the SECOND message of that run,
      // which is only true if the first (model-less) one did not consume the id.
      events[0]?.model === 'claude-haiku-4-5-20260101',
    `ids reported: ${JSON.stringify([...seen])} (toolu_C, whose model was blank, is absent)`,
  );

  // A second run's Set is its own.
  const fresh = new Set<string>();
  const again = subagentModelEvent(fresh, assistant('toolu_A', 'claude-haiku-4-5-20260101'));
  record(
    '(b) the "once" is per run — a new Set reports the same id again',
    again?.kind === 'subagent_model' && again.agentToolCallId === 'toolu_A',
    `second run reported=${again !== undefined}`,
  );
}

// ---------------------------------------------------------------------------
// (c) the engine really calls it, per run
// ---------------------------------------------------------------------------

function checkEngineSource(): void {
  const src = readFileSync(resolve(ROOT, 'src/engines/claude-agent-sdk-engine.ts'), 'utf8');
  const callsHelper = /subagentModelEvent\(reportedSubagentModels, \{/.test(src);
  const passesBothFields =
    /parentToolUseId: msg\.parent_tool_use_id/.test(src) && /model: msg\.message\.model/.test(src);
  // Declared with `const` INSIDE `run()`, next to the other per-run state — a
  // module-level Set would make one turn silence the next one's first reading.
  const perRunSet = /const reportedSubagentModels = new Set<string>\(\);/.test(src);
  record(
    '(c) the engine reads message.model on the subagent branch through the helper',
    callsHelper && passesBothFields && perRunSet,
    `calls helper=${callsHelper}; passes parent_tool_use_id + message.model=${passesBothFields}; per-run Set=${perRunSet}`,
  );
}

// ---------------------------------------------------------------------------
// (d) + (e) the runtime logs it, and stores nothing
// ---------------------------------------------------------------------------

/** An engine that emits a scripted event stream. It stands in for dev-claude,
 *  which is the only engine that can produce these events — what is under test
 *  is `runTurn`'s handling of them, not the engine that found them. */
class ScriptedEngine implements Engine {
  constructor(private readonly events: readonly EngineEvent[]) {}
  async *run(): AsyncIterable<EngineEvent> {
    for (const ev of this.events) yield ev;
  }
}

function readDay(): ActivityRecord[] {
  const dir = activityLogDir();
  if (!dir) return [];
  const file = join(dir, activityLogFileName(Date.now()));
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as ActivityRecord);
}

async function checkRuntimeLogging(): Promise<void> {
  const store = new SqliteStore({ path: join(TMP_DIR, 'app.db') });
  const session = store.createSession('mock');

  const events = await runTurn({
    engine: new ScriptedEngine([
      { kind: 'init', providerId: 'anthropic-dev-oauth', model: 'claude-opus-5' },
      // The delegation itself: a `Task` call whose id is what the subagent's
      // messages will carry as `parent_tool_use_id`, and whose arguments name
      // the agent that was asked for.
      {
        kind: 'tool_request',
        toolCallId: 'toolu_task_1',
        toolName: 'Task',
        input: { subagent_type: 'explorer', prompt: 'find every use of effectiveAgentModel' },
      },
      { kind: 'gate_result', toolCallId: 'toolu_task_1', toolName: 'Task', decision: 'allow' },
      { kind: 'subagent_model', agentToolCallId: 'toolu_task_1', model: 'claude-haiku-4-5' },
      {
        kind: 'text',
        role: 'assistant',
        text: 'Found it in three places.',
        agentToolCallId: 'toolu_task_1',
      },
      {
        kind: 'tool_result',
        toolCallId: 'toolu_task_1',
        toolName: 'Task',
        isError: false,
        output: { content: '@explorer answered: three places.' },
      },
      { kind: 'text', role: 'assistant', text: 'The explorer found three call sites.' },
      { kind: 'result', ok: true, usage: { inputTokens: 10, outputTokens: 5 } },
    ]),
    store,
    sessionId: session.sessionId,
    model: { providerId: 'anthropic-dev-oauth', model: 'claude-opus-5' },
    userText: 'where is effectiveAgentModel used?',
    toolSchemas: [],
    executors: {},
    gate: async () => ({ behavior: 'allow' }),
    engineId: 'dev-claude',
  });

  const forwarded = events.filter((e) => e.kind === 'subagent_model');
  record(
    '(d) the event reaches the caller unchanged — it is forwarded, not swallowed',
    forwarded.length === 1,
    `forwarded ${forwarded.length} subagent_model event(s)`,
  );

  const rows = readDay().filter((r) => r.kind === 'subagent_model');
  const row = rows[0];
  record(
    '(d) ...and lands in the activity log with the model, the key and the agent type',
    rows.length === 1 &&
      row?.model === 'claude-haiku-4-5' &&
      row.agentToolCallId === 'toolu_task_1' &&
      // Taken from the `Task` call's own arguments, which is the only place the
      // name the model asked for appears.
      row.agentType === 'explorer' &&
      row.sessionId === session.sessionId,
    `rows=${rows.length}; ${JSON.stringify({
      model: row?.model,
      agentToolCallId: row?.agentToolCallId,
      agentType: row?.agentType,
    })}`,
  );

  // (e) OBSERVATIONAL. The transcript is what replays on the next turn and on
  // the OTHER engine; a model label is not something the user or the model said.
  const messages = store.getMessages(session.sessionId);
  const leaked = messages.filter((m) => JSON.stringify(m).includes('claude-haiku-4-5'));
  record(
    '(e) nothing about it enters the transcript — it mints no message',
    leaked.length === 0,
    `${messages.length} stored messages, ${leaked.length} mentioning the subagent model`,
  );
}

// ---------------------------------------------------------------------------
// (f) the environment diagnostic
// ---------------------------------------------------------------------------

/** The variables §3 of the spec extracted from the bundled CLI binary. Restated
 *  here so the list cannot shrink unnoticed: a name that stops being reported is
 *  a piece of the engine's behaviour that stops being explainable. */
const SPEC_VARIABLES = [
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL_FORCE',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'CLAUDE_CODE_EFFORT_LEVEL',
  'MAX_THINKING_TOKENS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
];

const FAKE_TOKEN = 'sk-ant-oat01-MUST-NOT-APPEAR';

function checkEngineEnv(): void {
  // Every variable in the spec's list, all set — the only way to prove the table
  // covers exactly those names and nothing has been dropped.
  const all: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: '/home/nobody' };
  for (const name of SPEC_VARIABLES) all[name] = `value-of-${name}`;
  all.CLAUDE_CODE_OAUTH_TOKEN = FAKE_TOKEN;
  all.ANTHROPIC_API_KEY = FAKE_TOKEN;
  const everything = engineEnvironmentNotes(all);
  record(
    '(f) the diagnostic reports exactly the spec list, in order, and nothing else',
    everything.map((n) => n.name).join(',') === SPEC_VARIABLES.join(','),
    `${everything.length} notes: ${everything.map((n) => n.name).join(', ')}`,
  );

  record(
    '(f) every note carries a one-line effect',
    everything.every((n) => n.effect.trim().length > 0 && n.effect.trim().endsWith('.')),
    `effects present=${everything.filter((n) => n.effect.trim().length > 0).length}/${everything.length}; ` +
      `ANTHROPIC_API_KEY: ${JSON.stringify(everything.find((n) => n.name === 'ANTHROPIC_API_KEY')?.effect)}`,
  );

  // THE ONE THAT MATTERS. This list is rendered in Settings.
  const serialized = JSON.stringify(everything);
  record(
    '(f) a credential is reported as present and NEVER quoted',
    everything.find((n) => n.name === 'CLAUDE_CODE_OAUTH_TOKEN')?.value === 'set' &&
      everything.find((n) => n.name === 'ANTHROPIC_API_KEY')?.value === 'set' &&
      !serialized.includes(FAKE_TOKEN) &&
      // ...while a variable that names a MODEL does show its value, which is the
      // whole point of showing the list at all.
      everything.find((n) => n.name === 'CLAUDE_CODE_SUBAGENT_MODEL')?.value ===
        'value-of-CLAUDE_CODE_SUBAGENT_MODEL',
    `token value rendered as ${JSON.stringify(everything.find((n) => n.name === 'ANTHROPIC_API_KEY')?.value)}; ` +
      `the token string appears in the payload: ${serialized.includes(FAKE_TOKEN)}`,
  );

  // Set-but-blank is what a half-unset shell leaves behind, and it changes
  // nothing — so a settings screen must not claim it does.
  const sparse = engineEnvironmentNotes({
    CLAUDE_CODE_SUBAGENT_MODEL: 'opus',
    ANTHROPIC_MODEL: '   ',
    MAX_THINKING_TOKENS: '',
    PATH: '/usr/bin',
  });
  record(
    '(f) only set, non-blank variables come back — and an empty environment draws nothing',
    sparse.length === 1 &&
      sparse[0]?.name === 'CLAUDE_CODE_SUBAGENT_MODEL' &&
      sparse[0].value === 'opus' &&
      engineEnvironmentNotes({}).length === 0,
    `sparse=${JSON.stringify(sparse.map((n) => `${n.name}=${n.value}`))}; empty env -> ${engineEnvironmentNotes({}).length} notes`,
  );
}

async function main(): Promise<boolean> {
  checkHelper();
  checkEngineSource();
  checkEngineEnv();
  await checkRuntimeLogging();

  console.log('\n=== SPIKE-SUBAGENT-MODEL-EVENT — one model reading per delegated run ===\n');
  let allPass = true;
  for (const c of checks) {
    if (!c.pass) allPass = false;
    console.log(`[${c.pass ? 'PASS' : 'FAIL'}] ${c.name}`);
    console.log(`        evidence: ${c.evidence}`);
  }
  console.log(
    `\nSPIKE-SUBAGENT-MODEL-EVENT: ${allPass ? 'ALL PASS' : 'FAILURES PRESENT'} (${checks.filter((c) => c.pass).length}/${checks.length})\n`,
  );
  return allPass;
}

try {
  if (!(await main())) process.exitCode = 1;
} catch (e) {
  console.error('SPIKE-SUBAGENT-MODEL-EVENT crashed:', e);
  process.exitCode = 1;
} finally {
  rmSync(TMP_DIR, { recursive: true, force: true });
}
