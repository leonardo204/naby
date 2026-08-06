// src/spikes/spike-activity-log.ts
//
// THE ACTIVITY LOG — verification (naby-activity-log).
//
// What is under test is a file on disk, so nothing here is mocked: the spike
// points a naby home at a temp directory, drives the REAL `runTurn` against the
// REAL SqliteStore with a mock model, and then reads the JSONL back off the
// filesystem and parses it. If a line is unparseable, or an event is missing, or
// a file that should have aged out is still there, the spike fails.
//
// Asserted:
//   (a) A driven turn appends VALID JSONL — every line parses, and the day's
//       file carries the whole shape: turn_started, user_message, tool_call,
//       gate_decision, tool_result, assistant_text, usage, turn_completed.
//   (b) The file is chosen by the event's DAY: an event stamped tomorrow lands in
//       tomorrow's file, not today's (the rollover).
//   (c) Retention deletes only files matching `YYYY-MM-DD.jsonl` that are older
//       than LOG_RETENTION_DAYS — by FILENAME, and foreign files are untouched.
//   (d) A huge tool result is cut at the field cap and the record says so.
//   (e) Token-ish KEYS are masked; token COUNTS (numbers, and the count-shaped
//       names) are not.
//   (f) An unwritable log directory does not throw into the turn.
//   (g) The kill switch off = not one byte written.
//   (h) With no home configured and no store open, nothing is written ANYWHERE —
//       in particular not into the developer's real ~/.naby.
//
// No network and no keys: the model is `MockLanguageModelV4`, injected through
// the ordinary AiSdkEngine seam.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// The naby home for this run. Set BEFORE anything imports the log module, the
// same documented NABY_DB_PATH override the other spikes use — so this spike
// never touches the developer's real ~/.naby.
const TMP_DIR = mkdtempSync(join(tmpdir(), 'naby-spike-activity-'));
process.env.NABY_DB_PATH = join(TMP_DIR, 'app.db');

import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { AiSdkEngine } from '../engines/ai-sdk-engine.js';
import {
  ACTIVITY_LOG_MAX_FIELD_CHARS,
  LOG_RETENTION_DAYS,
  activityLogDir,
  activityLogFileName,
  logActivity,
  maskSecrets,
  pruneActivityLogs,
  resetActivityLogCaches,
  sanitizeActivityPayload,
  setActivityLogEnabled,
  unregisterActivityLogStore,
} from '../runtime/activity-log.js';
import { runTurn } from '../runtime/session.js';
import { SqliteStore } from '../runtime/store/sqlite-store.js';
import type { ActivityRecord } from '../runtime/activity-log.js';
import type { ToolSchema } from '../runtime/engine.js';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

/** Read a day file back as parsed records. Throws on a malformed line, which is
 *  the point: "valid JSONL" is asserted by parsing, not by eyeballing. */
function readDay(at: number = Date.now(), dir?: string): ActivityRecord[] {
  const target = dir ?? activityLogDir();
  if (!target) return [];
  const file = join(target, activityLogFileName(at));
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as ActivityRecord);
}

function kinds(records: readonly ActivityRecord[]): string[] {
  return records.map((r) => r.kind);
}

// ---------------------------------------------------------------------------
// (a) a real turn writes the whole shape, as valid JSONL
// ---------------------------------------------------------------------------

const BIG_OUTPUT = 'x'.repeat(ACTIVITY_LOG_MAX_FIELD_CHARS + 5000);

const toolSchemas: ToolSchema[] = [
  {
    name: 'read_big_file',
    description: 'returns something enormous',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, apiKey: { type: 'string' } },
    },
  },
];

/** The usage shape ai@7 reports. Same literal the other spikes use — the point
 *  here is the log, not the accounting. */
const USAGE = {
  inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 },
};

/** A model that calls the tool once, then answers. The two-step shape is what
 *  produces tool_call / gate_decision / tool_result in one turn. The tool input
 *  carries an `apiKey` on purpose: it is what the masker has to catch on the way
 *  through, and a model CAN pass one (an MCP tool that takes a credential). */
function mockModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: [
      {
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'read_big_file',
            input: JSON.stringify({ path: '/tmp/huge', apiKey: 'sk-live-must-not-appear' }),
          },
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool_use' },
        usage: USAGE,
        warnings: [],
      },
      {
        content: [{ type: 'text', text: 'done reading.' }],
        finishReason: { unified: 'stop', raw: 'end_turn' },
        usage: USAGE,
        warnings: [],
      },
    ] as LanguageModelV4GenerateResult[],
  });
}

const store = new SqliteStore({ path: join(TMP_DIR, 'app.db') });
const session = store.createSession('mock');

const turnEvents = await runTurn({
  engine: new AiSdkEngine({ resolveModel: () => mockModel() }),
  store,
  sessionId: session.sessionId,
  model: { providerId: 'mock', model: 'mock-1' },
  userText: 'read the big file for me',
  toolSchemas,
  executors: {
    read_big_file: async () => ({ content: BIG_OUTPUT }),
  },
  gate: async () => ({ behavior: 'allow' }),
  engineId: 'ai-sdk',
  activity: { agentId: 'agent-1', agentName: 'naby', source: 'spike', step: 1, fastGrowth: true },
});

let today: ActivityRecord[] = [];
let parseError = '';
try {
  today = readDay();
} catch (e) {
  parseError = e instanceof Error ? e.message : String(e);
}
const seen = new Set(kinds(today));
const wanted = [
  'turn_started',
  'user_message',
  'tool_call',
  'gate_decision',
  'tool_result',
  'assistant_text',
  'usage',
  'turn_completed',
];
const missing = wanted.filter((k) => !seen.has(k));
record(
  '(a) a driven turn appends valid JSONL covering the whole turn',
  parseError === '' && missing.length === 0 && today.length >= wanted.length,
  parseError
    ? `unparseable line: ${parseError}`
    : `${today.length} records: ${[...seen].join(', ')}${missing.length ? ` — MISSING ${missing.join(', ')}` : ''} (engine produced ${turnEvents.length} events)`,
);

// The context the runtime cannot infer rides every record of the turn.
const started = today.find((r) => r.kind === 'turn_started');
const completed = today.find((r) => r.kind === 'turn_completed');
record(
  '(a2) turn_started carries session, engine, routed agent and the fast-growth flag; turn_completed the duration',
  started?.sessionId === session.sessionId &&
    started?.engine === 'ai-sdk' &&
    started?.agentId === 'agent-1' &&
    started?.fastGrowth === true &&
    started?.source === 'spike' &&
    typeof completed?.durationMs === 'number' &&
    completed?.toolCalls === 1,
  `turn_started=${JSON.stringify({ sessionId: started?.sessionId, engine: started?.engine, agentId: started?.agentId, fastGrowth: started?.fastGrowth })}; turn_completed=${JSON.stringify({ durationMs: completed?.durationMs, toolCalls: completed?.toolCalls })}`,
);

// The request and the response, in full.
const userMsg = today.find((r) => r.kind === 'user_message');
const assistant = today.find((r) => r.kind === 'assistant_text');
record(
  '(a3) the request and the response are logged in full',
  userMsg?.text === 'read the big file for me' && assistant?.text === 'done reading.',
  `user_message=${JSON.stringify(userMsg?.text)}; assistant_text=${JSON.stringify(assistant?.text)}`,
);

// The ledger/growth path shares one store hook — prove a row reaches the file.
store.appendEvalEvent({
  kind: 'checkin',
  agentId: 'agent-1',
  sessionId: session.sessionId,
  question: 'Ship it?',
  options: ['ship', 'wait'],
  recommended: 0,
  chosen: 1,
  hit: false,
  drill: true,
});
const ledger = readDay().find((r) => r.kind === 'ledger_event');
record(
  '(a4) a growth-ledger row (check-in, autonomous, tripwire) reaches the log through the store hook',
  ledger?.ledgerKind === 'checkin' &&
    ledger?.question === 'Ship it?' &&
    ledger?.chosen === 1 &&
    ledger?.hit === false &&
    ledger?.drill === true,
  JSON.stringify({
    ledgerKind: ledger?.ledgerKind,
    question: ledger?.question,
    chosen: ledger?.chosen,
    hit: ledger?.hit,
    drill: ledger?.drill,
  }),
);

// A memory write goes through the same driver hook.
store.putMemory({
  scope: 'user',
  scopeKey: 'me',
  type: 'semantic',
  key: 'editor',
  value: 'neovim',
  provenance: { source: 'user', sessionId: session.sessionId, basis: 'spike' },
  confidence: 0.9,
  requestedStatus: 'confirmed',
});
const memWrite = readDay().find((r) => r.kind === 'memory_write');
record(
  '(a5) a memory write is logged with what was learned and on whose authority',
  memWrite?.key === 'editor' && memWrite?.value === 'neovim' && memWrite?.decision === 'allow',
  JSON.stringify({ key: memWrite?.key, value: memWrite?.value, status: memWrite?.status, decision: memWrite?.decision }),
);

// ---------------------------------------------------------------------------
// (d) truncation — asserted on the record the real turn produced
// ---------------------------------------------------------------------------

const toolResult = today.find((r) => r.kind === 'tool_result');
const output = typeof toolResult?.output === 'string' ? toolResult.output : '';
record(
  '(d) a huge tool result is cut at the field cap and the record is flagged truncated',
  toolResult?.truncated === true &&
    output.length < BIG_OUTPUT.length &&
    output.includes('[truncated') &&
    output.startsWith('x'.repeat(64)),
  `output ${BIG_OUTPUT.length} chars → ${output.length}; truncated=${String(toolResult?.truncated)}; cap=${ACTIVITY_LOG_MAX_FIELD_CHARS}`,
);

// ---------------------------------------------------------------------------
// (e) masking
// ---------------------------------------------------------------------------

const toolCall = today.find((r) => r.kind === 'tool_call');
const loggedInput = JSON.stringify(toolCall?.input ?? {});
const masked = maskSecrets({
  apiKey: 'sk-live-1',
  api_key: 'sk-live-2',
  Authorization: 'Bearer abc',
  botToken: 't-123',
  nested: { password: 'hunter2', refresh_token: 'r-1' },
  // NOT secrets: counts that merely contain a secret word, and a plain field.
  inputTokens: 4096,
  outputTokens: '512',
  tokenBudget: 2000,
  model: 'claude-x',
}) as Record<string, unknown>;
const nested = masked.nested as Record<string, unknown>;
record(
  '(e) token-ish keys are masked, token COUNTS and ordinary fields are not',
  masked.apiKey === '[redacted]' &&
    masked.api_key === '[redacted]' &&
    masked.Authorization === '[redacted]' &&
    masked.botToken === '[redacted]' &&
    nested.password === '[redacted]' &&
    nested.refresh_token === '[redacted]' &&
    masked.inputTokens === 4096 &&
    masked.outputTokens === '512' &&
    masked.tokenBudget === 2000 &&
    masked.model === 'claude-x' &&
    // and end to end: the model's own tool argument named apiKey never lands.
    !loggedInput.includes('sk-live-must-not-appear'),
  `${JSON.stringify(masked)}; logged tool_call input=${loggedInput.slice(0, 120)}`,
);

// ---------------------------------------------------------------------------
// (b) day rollover
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const tomorrow = Date.now() + DAY;
logActivity('turn_started', { at: tomorrow, sessionId: 'tomorrow-session' });
const tomorrowRecords = readDay(tomorrow);
const todayCountAfter = readDay().length;
record(
  '(b) an event stamped for another day lands in that day’s file',
  tomorrowRecords.length === 1 &&
    tomorrowRecords[0]?.sessionId === 'tomorrow-session' &&
    activityLogFileName(tomorrow) !== activityLogFileName(Date.now()) &&
    !kinds(readDay()).includes('turn_started_tomorrow'),
  `${activityLogFileName(tomorrow)} has ${tomorrowRecords.length} record(s); today's file still has ${todayCountAfter}`,
);

// ---------------------------------------------------------------------------
// (c) retention — by filename, ours only
// ---------------------------------------------------------------------------

const logDir = activityLogDir();
if (!logDir) throw new Error('the log directory should be resolvable inside this spike');

function dayName(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * DAY);
  const p = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.jsonl`;
}

const oldFiles = [dayName(LOG_RETENTION_DAYS + 10), dayName(LOG_RETENTION_DAYS + 1)];
const keptFiles = [dayName(LOG_RETENTION_DAYS), dayName(LOG_RETENTION_DAYS - 1), dayName(1)];
const foreignFiles = ['README.md', 'activity.log', '2026-13-45.jsonl', 'not-a-date.jsonl'];
for (const name of [...oldFiles, ...keptFiles, ...foreignFiles]) {
  writeFileSync(join(logDir, name), '{"kind":"fixture"}\n', 'utf8');
}
const removed = pruneActivityLogs(Date.now(), logDir);
const after = new Set(readdirSync(logDir));
record(
  '(c) retention deletes only our own files older than the window, by filename',
  removed === oldFiles.length &&
    oldFiles.every((f) => !after.has(f)) &&
    keptFiles.every((f) => after.has(f)) &&
    foreignFiles.every((f) => after.has(f)),
  `removed ${removed} (${oldFiles.join(', ')}); kept ${keptFiles.length} recent + ${foreignFiles.length} foreign; dir now ${after.size} entries`,
);

// A mtime-based sweep would delete the opposite set: every fixture above was
// WRITTEN just now. Stated as its own check because "by filename, not mtime" is
// the contract the file names carry.
record(
  '(c2) a file whose NAME is old is deleted even though its mtime is seconds old',
  !after.has(oldFiles[0] as string),
  `${oldFiles[0]} was written this second and still aged out`,
);

// ---------------------------------------------------------------------------
// (f) a broken log never breaks a turn
// ---------------------------------------------------------------------------

let turnThrew = '';
let turnFinished = false;
{
  const home = mkdtempSync(join(tmpdir(), 'naby-spike-activity-ro-'));
  const roLogs = join(home, 'logs');
  mkdirSync(roLogs);
  // Read-only directory: appendFileSync inside will fail on every write.
  chmodSync(roLogs, 0o500);
  const previousDb = process.env.NABY_DB_PATH;
  const roStore = new SqliteStore({ path: join(home, 'app.db') });
  process.env.NABY_DB_PATH = join(home, 'app.db');
  resetActivityLogCaches();
  const roSession = roStore.createSession('mock');
  try {
    await runTurn({
      engine: new AiSdkEngine({
        resolveModel: () =>
          new MockLanguageModelV4({
            doGenerate: [
              {
                content: [{ type: 'text', text: 'still answered' }],
                finishReason: { unified: 'stop', raw: 'end_turn' },
                usage: USAGE,
                warnings: [],
              },
            ] as LanguageModelV4GenerateResult[],
          }),
      }),
      store: roStore,
      sessionId: roSession.sessionId,
      model: { providerId: 'mock', model: 'mock-1' },
      userText: 'the disk is angry',
      toolSchemas: [],
      executors: {},
      gate: async () => ({ behavior: 'allow' }),
    });
    turnFinished =
      roStore.getMessages(roSession.sessionId).some((m) => m.role === 'assistant');
  } catch (e) {
    turnThrew = e instanceof Error ? e.message : String(e);
  } finally {
    chmodSync(roLogs, 0o700);
    roStore.close?.();
    if (previousDb) process.env.NABY_DB_PATH = previousDb;
    resetActivityLogCaches();
    rmSync(home, { recursive: true, force: true });
  }
}
record(
  '(f) an unwritable log directory does not throw into the turn',
  turnThrew === '' && turnFinished,
  turnThrew ? `turn threw: ${turnThrew}` : 'the turn completed and the assistant message was stored',
);

// ---------------------------------------------------------------------------
// (g) the kill switch
// ---------------------------------------------------------------------------

const beforeSwitch = readDay().length;
setActivityLogEnabled(false);
logActivity('turn_started', { sessionId: 'must-not-appear' });
logActivity('tool_call', { sessionId: 'must-not-appear', toolName: 'nope' });
const duringSwitch = readDay().length;
setActivityLogEnabled(true);
logActivity('turn_started', { sessionId: 'back-on' });
const afterSwitch = readDay();
record(
  '(g) with the kill switch off not one line is written; turning it back on resumes',
  duringSwitch === beforeSwitch &&
    afterSwitch.length === beforeSwitch + 1 &&
    !JSON.stringify(afterSwitch).includes('must-not-appear'),
  `before=${beforeSwitch} during=${duringSwitch} after=${afterSwitch.length}`,
);

// The setting is what the app reads. Prove the store round-trip decides it.
setActivityLogEnabled(undefined);
store.setSetting('logging.activityEnabled', 'false');
const { applyActivityLogSettings, isActivityLogEnabled } = await import('../runtime/activity-log.js');
applyActivityLogSettings(store);
const offFromStore = !isActivityLogEnabled();
setActivityLogEnabled(undefined);
store.setSetting('logging.activityEnabled', 'true');
applyActivityLogSettings(store);
const onFromStore = isActivityLogEnabled();
record(
  '(g2) the kill switch is the `logging.activityEnabled` setting, read from the store',
  offFromStore && onFromStore,
  `setting 'false' ⇒ enabled=${!offFromStore ? 'true (WRONG)' : 'false'}; setting 'true' ⇒ enabled=${onFromStore}`,
);

// ---------------------------------------------------------------------------
// (h) no home named ⇒ nothing written, anywhere
// ---------------------------------------------------------------------------

const realHomeLogs = join(homedir(), '.naby', 'logs');
const realBefore = existsSync(realHomeLogs) ? readdirSync(realHomeLogs).length : -1;
const savedDb = process.env.NABY_DB_PATH;
const savedHome = process.env.NABY_HOME;
const savedCockpit = process.env.COCKPIT_HOME;
delete process.env.NABY_DB_PATH;
delete process.env.NABY_HOME;
delete process.env.COCKPIT_HOME;
unregisterActivityLogStore();
resetActivityLogCaches();
const dirWithNoHome = activityLogDir();
logActivity('turn_started', { sessionId: 'no-home-anywhere' });
const realAfter = existsSync(realHomeLogs) ? readdirSync(realHomeLogs).length : -1;
let realHomeUntouched = realBefore === realAfter;
if (realHomeUntouched && realAfter > 0) {
  // Stronger: not just the same COUNT of files, but no line naming this spike.
  realHomeUntouched = !readdirSync(realHomeLogs).some((f) => {
    try {
      return readFileSync(join(realHomeLogs, f), 'utf8').includes('no-home-anywhere');
    } catch {
      return false;
    }
  });
}
if (savedDb) process.env.NABY_DB_PATH = savedDb;
if (savedHome) process.env.NABY_HOME = savedHome;
if (savedCockpit) process.env.COCKPIT_HOME = savedCockpit;
resetActivityLogCaches();
record(
  '(h) with no home configured and no store open, nothing is written — least of all to ~/.naby',
  dirWithNoHome === undefined && realHomeUntouched,
  `activityLogDir()=${String(dirWithNoHome)}; ~/.naby/logs entries before=${realBefore} after=${realAfter}`,
);

// ---------------------------------------------------------------------------
// sanitizer edge cases — a payload a model can produce must never win
// ---------------------------------------------------------------------------

const circular: Record<string, unknown> = { name: 'loop' };
circular.self = circular;
const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: 'too deep' } } } } } } } } };
const wide = { items: Array.from({ length: 500 }, (_, i) => i) };
let sanitizerThrew = '';
let sane = false;
try {
  const c = sanitizeActivityPayload(circular);
  const d = sanitizeActivityPayload(deep);
  const w = sanitizeActivityPayload(wide);
  sane =
    JSON.stringify(c.value).includes('[circular]') &&
    JSON.stringify(d.value).includes('[depth limit]') &&
    d.truncated &&
    (w.value.items as unknown[]).length === 201 &&
    w.truncated;
} catch (e) {
  sanitizerThrew = e instanceof Error ? e.message : String(e);
}
record(
  '(i) the sanitizer survives circular, over-deep and over-wide payloads',
  sanitizerThrew === '' && sane,
  sanitizerThrew ? `threw: ${sanitizerThrew}` : 'circular → [circular], deep → [depth limit], 500 items → 200 + a count',
);

store.close?.();
rmSync(TMP_DIR, { recursive: true, force: true });

// ---- report --------------------------------------------------------------
let failed = 0;
for (const c of checks) {
  if (!c.pass) failed += 1;
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}\n      ${c.evidence}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
if (failed > 0) process.exitCode = 1;
