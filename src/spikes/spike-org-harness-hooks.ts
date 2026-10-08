// src/spikes/spike-org-harness-hooks.ts
//
// ORG HARNESS M3 — the hook runner (specs/org-harness-sync.md §3.5, §4.7).
//
// NO NETWORK, NO REAL HOME: a temp NABY_HOME + NABY_DB_PATH, a fake Skill Hub,
// and the fixture package's stand-in scripts (`fixtures/org-harness/
// altimedia-harness/scripts`), which RECORD how they were called into
// `NABY_SPIKE_HOOK_LOG` and answer as `NABY_SPIKE_HOOK_CONTROL` says.
//
// WHAT IS ASSERTED:
//
//   allowlist   run-skill-hook.js / metrics-emit.js run; activate.js, gate.js,
//               deps-check.js are "native" and NEVER run; any other script is
//               "unsupported", listed for Settings, and NEVER runs
//   names       the whole naby → Claude Code tool table (run_command → Bash,
//               write_file → Write, edit_file → Edit, read_file → Read, MCP →
//               mcp__<server>__<tool>), with converted inputs; SDK built-ins and
//               runtime tools pass through
//   matchers    Claude Code semantics: exact word lists, regex (the 0.8.0
//               anchored one included), `*`; a bad regex skips one entry, logged
//   input       all seven events carry Claude Code's fields
//   env         HARNESS_CLIENT=naby, CLAUDE_PLUGIN_ROOT, CLAUDE_PROJECT_DIR, the
//               cic token under BOTH names, the metrics token (or
//               HARNESS_METRICS_DISABLED=1 without one), ELECTRON_RUN_AS_NODE=1,
//               never the Skill Hub key; `node` is this executable
//   outcomes    additionalContext collected; ask/deny/allow with deny > ask;
//               a crashing, failing or timed-out hook never blocks; async hooks
//               are not awaited
//   SessionEnd  capped at 5 s however long the hook runs
//   serial      PreCompact/SessionEnd one at a time per project, concurrent
//               across projects
//   resume      SessionStart(resume) runs task hooks but NOT metrics-emit (§4.7)
//   turn        END TO END through the shell's naby engine (AI-SDK engine, mock
//               model): SessionStart(startup), UserPromptSubmit, PreToolUse,
//               PostToolUse, Stop, PreCompact + SessionStart(compact) on a real
//               fold, SessionEnd on tab close and on app quit; a hook's `ask`
//               reaches the approval prompt with its reason; SessionStart context
//               reaches the model's system prompt; a crashing hook does not stop
//               the turn; a resumed session gets `resume` once
//   claude      the Agent SDK engine registers PreCompact + SessionStart(compact)
//               on the compaction port (`buildQueryOptions`)
//
// Prints PASS/FAIL per assertion; exits non-zero on any FAIL.

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Everything that resolves a home must see the temp one BEFORE any import runs.
const SPIKE_ROOT = mkdtempSync(join(tmpdir(), 'naby-spike-org-hooks-'));
process.env.NABY_HOME = SPIKE_ROOT;
process.env.NABY_DB_PATH = join(SPIKE_ROOT, 'app.db');
// No background Skill Hub pass: the spike drives the sync itself.
process.env.NABY_ORG_HARNESS_SYNC = '0';
const HOOK_LOG = join(SPIKE_ROOT, 'hooks.jsonl');
const HOOK_CONTROL = join(SPIKE_ROOT, 'control.json');
process.env.NABY_SPIKE_HOOK_LOG = HOOK_LOG;
process.env.NABY_SPIKE_HOOK_CONTROL = HOOK_CONTROL;
// A Skill Hub key the user's own shell profile exported: must never reach a hook.
process.env.SHUB_API_KEY = 'shub_from_the_profile_never_forward';
process.env.CLAUDE_PLUGIN_OPTION_SHUB_API_KEY = 'shub_option_never_forward';
// The Atlassian gate is spike-org-harness-gate's subject. Here it is switched off
// the plugin's way, so no Atlassian sign-in (and so no Atlassian row, and so no
// connection to the real remote MCP) is involved.
process.env.HARNESS_GATE = '0';

import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import { buildQueryOptions } from '../engines/claude-agent-sdk-engine.js';
import {
  buildOrgHookInput,
  claudeTranscriptLines,
  createOrgHookRunner,
  hookMatcherSelects,
  ORG_HOOK_EVENTS,
  orgHookEnv,
  orgHooksIdle,
  readOrgHookConfig,
  toClaudeToolCall,
  unsupportedOrgHooks,
  type OrgHookCall,
  type OrgHookConfig,
} from '../runtime/org-harness-hooks.js';
import { buildZip, type ZipWriteEntry } from '../runtime/zip.js';
import { createNabySpec, getStore } from '../../shell/packages/feature/agent/src/server/engines/naby.js';
import type { RunCtx, RunEvent } from '../../shell/packages/feature/agent/src/server/engines/types.js';
import { setOrgHarnessFetch, syncOrgHarnessNow } from '../../shell/packages/feature/agent/src/server/lib/orgHarness.js';
import {
  endOrgSessionsOnClose,
  orgHooksIdle as shellOrgHooksIdle,
  recentOrgHookLog as shellRecentOrgHookLog,
  resetOrgHookStateForTests as shellResetOrgHookState,
} from '../../shell/packages/feature/agent/src/server/lib/orgHarnessHooks.js';
import { resolveApproval } from '../../shell/packages/feature/agent/src/server/lib/approvalRegistry.js';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, evidence = ''): void {
  checks.push({ name, pass, evidence });
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = join(ROOT, 'src/spikes/fixtures/org-harness/altimedia-harness');

// The SAME runtime instance the shell uses (it imports the built bundle), for the
// process-level session bookkeeping and the quit handler.
type DistRuntime = {
  runOrgHarnessQuitHandler(capMs?: number): Promise<void>;
  orgTranscriptPath(home: string, sessionId: string): string;
};
const DIST = '../../dist/naby-runtime.mjs';

// ---------------------------------------------------------------------------
// Fixture package + log helpers
// ---------------------------------------------------------------------------

type LogLine = {
  script: string;
  args?: string[];
  input?: Record<string, unknown>;
  env?: Record<string, string>;
  cwd?: string;
  at?: number;
  forbidden?: boolean;
};

function readLog(): LogLine[] {
  if (!existsSync(HOOK_LOG)) return [];
  return readFileSync(HOOK_LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LogLine);
}
function clearLog(): void {
  writeFileSync(HOOK_LOG, '');
}
function control(c: Record<string, unknown>): void {
  writeFileSync(HOOK_CONTROL, JSON.stringify(c));
}
async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

function fixtureEntries(overrides: Record<string, string> = {}): ZipWriteEntry[] {
  const out: ZipWriteEntry[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const rel = relative(FIXTURE, full).split('\\').join('/');
        if (rel in overrides) continue;
        out.push({ name: rel, data: readFileSync(full) });
      }
    }
  };
  walk(FIXTURE);
  for (const [name, data] of Object.entries(overrides)) out.push({ name, data });
  return out;
}

/** The real 0.7.1 hooks.json plus the entries the allowlist must refuse, a bad
 *  matcher, a one-string command, and a short-timeout hook. */
function spikeHooksJson(): string {
  const real = JSON.parse(readFileSync(join(FIXTURE, 'hooks/hooks.json'), 'utf8')) as {
    hooks: Record<string, unknown[]>;
  };
  const h = real.hooks;
  h.PreToolUse!.push(
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/new-hook.js'] }] },
    { matcher: '(', hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/run-skill-hook.js', 'task', 'bad-matcher.py'] }] },
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 ${CLAUDE_PLUGIN_ROOT}/scripts/x.py' }] },
    { matcher: 'Edit', hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/run-skill-hook.js', 'task', 'slow.py'], timeout: 1 }] },
    { matcher: 'Edit', hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/run-skill-hook.js', 'task', 'deny.py'] }] },
  );
  h.UserPromptSubmit!.push({
    hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/run-skill-hook.js" task string-form.py' }],
  });
  (h as Record<string, unknown[]>).Notification = [
    { hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/run-skill-hook.js', 'task', 'notify.py'] }] },
  ];
  return JSON.stringify(real, null, 2);
}

const NEW_HOOK_JS =
  '#!/usr/bin/env node\n"use strict";\nconst fs = require("fs");\n' +
  'if (process.env.NABY_SPIKE_HOOK_LOG) fs.appendFileSync(process.env.NABY_SPIKE_HOOK_LOG, JSON.stringify({ script: "new-hook.js", forbidden: true }) + "\\n");\n';

function extractTo(dir: string, overrides: Record<string, string>): void {
  // A direct copy for the runner checks (the e2e path goes through the real sync).
  cpSync(FIXTURE, dir, { recursive: true });
  for (const [name, data] of Object.entries(overrides)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), data);
  }
}

// ---------------------------------------------------------------------------
// 1. Configuration, names, matchers, input
// ---------------------------------------------------------------------------

let PKG = '';
let CONFIG!: OrgHookConfig;
const PROJECT = join(SPIKE_ROOT, 'project');
const PROJECT_B = join(SPIKE_ROOT, 'project-b');

function configChecks(): void {
  PKG = join(SPIKE_ROOT, 'pkg-direct', '0.7.1');
  extractTo(PKG, { 'hooks/hooks.json': spikeHooksJson(), 'scripts/new-hook.js': NEW_HOOK_JS });
  CONFIG = readOrgHookConfig(PKG);
  const by = (script: string) => CONFIG.entries.filter((e) => e.script === script).map((e) => e.disposition);
  record(
    'allowlist: run-skill-hook.js and metrics-emit.js are run',
    by('run-skill-hook.js').filter((d) => d === 'run').length >= 6 && by('metrics-emit.js').every((d) => d === 'run'),
    JSON.stringify({ rsh: by('run-skill-hook.js'), me: by('metrics-emit.js') }),
  );
  record(
    'native: activate.js, gate.js, deps-check.js are never run (naby implements them)',
    ['activate.js', 'gate.js', 'deps-check.js'].every((s) => by(s).length > 0 && by(s).every((d) => d === 'native')),
  );
  record(
    'unsupported: a new script, a non-node command and an unmapped event are not run',
    by('new-hook.js').every((d) => d === 'unsupported') &&
      CONFIG.entries.some((e) => e.command === 'python3' && e.disposition === 'unsupported') &&
      CONFIG.entries.some((e) => e.event === 'Notification' && e.disposition === 'unsupported'),
  );
  const listed = unsupportedOrgHooks(CONFIG).map((u) => `${u.event}:${u.script}`);
  record(
    'Settings lists what naby does not run yet (new-hook.js, the python command, Notification)',
    listed.includes('PreToolUse:new-hook.js') && listed.some((l) => l.startsWith('PreToolUse:x.py')) && listed.includes('Notification:run-skill-hook.js'),
    JSON.stringify(listed),
  );
  const stringForm = CONFIG.entries.find((e) => e.args.includes('string-form.py'));
  record(
    'a one-string command is split and its ${CLAUDE_PLUGIN_ROOT} replaced',
    stringForm?.disposition === 'run' && stringForm.command === 'node' && stringForm.args[0] === join(PKG, 'scripts', 'run-skill-hook.js'),
    JSON.stringify(stringForm),
  );

  // The tool-name table, every row.
  const cwd = PROJECT;
  const mcp = new Set(['atlassian__createConfluencePage', 'atlassian__getConfluencePage']);
  const rows: [string, unknown, { tool_name: string; tool_input: unknown }][] = [
    ['run_command', { command: 'git commit -m x', timeoutMs: 5000 }, { tool_name: 'Bash', tool_input: { command: 'git commit -m x', timeout: 5000 } }],
    ['write_file', { path: 'docs/a.md', content: 'x' }, { tool_name: 'Write', tool_input: { file_path: join(cwd, 'docs/a.md'), content: 'x' } }],
    [
      'edit_file',
      { path: '/abs/b.md', oldString: 'a', newString: 'b', replaceAll: true },
      { tool_name: 'Edit', tool_input: { file_path: '/abs/b.md', old_string: 'a', new_string: 'b', replace_all: true } },
    ],
    ['read_file', { path: 'c.md', offset: 2, limit: 3 }, { tool_name: 'Read', tool_input: { file_path: join(cwd, 'c.md'), offset: 2, limit: 3 } }],
    ['atlassian__createConfluencePage', { title: 't' }, { tool_name: 'mcp__atlassian__createConfluencePage', tool_input: { title: 't' } }],
    ['Bash', { command: 'ls' }, { tool_name: 'Bash', tool_input: { command: 'ls' } }],
    ['Write', { file_path: '/x', content: '' }, { tool_name: 'Write', tool_input: { file_path: '/x', content: '' } }],
    ['naby_skill_load', { name: 'task' }, { tool_name: 'naby_skill_load', tool_input: { name: 'task' } }],
  ];
  for (const [name, input, want] of rows) {
    const got = toClaudeToolCall(name, input, { cwd, mcpToolNames: mcp });
    record(`tool name: ${name} → ${want.tool_name}`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
  }

  // Matchers.
  const m080 = '^mcp__.*__(confluence_(create|update)_page|(create|update)ConfluencePage)$';
  const mFixture = 'Write|Edit|Bash|mcp__.*__confluence_(create|update)_page';
  const cases: [string | undefined, string, boolean][] = [
    ['Bash', 'Bash', true],
    ['Bash', 'BashOutput', false],
    ['Write|Edit', 'Edit', true],
    ['Write|Edit', 'Read', false],
    [mFixture, 'mcp__atlassian__confluence_create_page', true],
    [mFixture, 'Write', true],
    [m080, 'mcp__atlassian__createConfluencePage', true],
    [m080, 'mcp__plugin_altimedia-harness_atlassian__updateConfluencePage', true],
    [m080, 'mcp__atlassian__getConfluencePage', false],
    ['*', 'anything', true],
    [undefined, 'anything', true],
    ['', 'anything', true],
  ];
  const bad = cases.filter(([m, t, want]) => hookMatcherSelects(m, t) !== want);
  record('matchers: exact word lists, regex (incl. the 0.8.0 one), * and empty', bad.length === 0, JSON.stringify(bad));
  let threw = false;
  try {
    hookMatcherSelects('(', 'Bash');
  } catch {
    threw = true;
  }
  record('a matcher that is not a valid regex is reported (and skipped by the runner)', threw);

  // Input for all seven events.
  const base = { sessionId: 's-1', cwd: PROJECT, transcriptPath: '/t/s-1.jsonl' };
  const inputs: Record<string, Record<string, unknown>> = {};
  for (const event of ORG_HOOK_EVENTS) {
    const call: OrgHookCall = {
      ...base,
      event,
      ...(event === 'SessionStart' ? { source: 'startup' as const } : {}),
      ...(event === 'UserPromptSubmit' ? { prompt: 'hi' } : {}),
      ...(event === 'PreToolUse' || event === 'PostToolUse'
        ? { toolName: 'run_command', toolInput: { command: 'ls' }, agentId: 'agent-1' }
        : {}),
      ...(event === 'PostToolUse' ? { toolResponse: { content: 'ok' } } : {}),
      ...(event === 'PreCompact' ? { trigger: 'manual' as const } : {}),
      ...(event === 'SessionEnd' ? { reason: 'other' } : {}),
    };
    inputs[event] = buildOrgHookInput(call);
  }
  const common = Object.values(inputs).every(
    (i) => i.session_id === 's-1' && i.cwd === PROJECT && i.transcript_path === '/t/s-1.jsonl' && typeof i.hook_event_name === 'string',
  );
  record(
    'input: all seven events carry session_id, cwd, hook_event_name, transcript_path',
    common && Object.keys(inputs).length === 7,
    JSON.stringify(inputs),
  );
  record(
    'input: event-specific fields (source, prompt, tool_name/tool_input, agent_id, tool_response, trigger, reason)',
    inputs.SessionStart!.source === 'startup' &&
      inputs.UserPromptSubmit!.prompt === 'hi' &&
      inputs.PreToolUse!.tool_name === 'Bash' &&
      (inputs.PreToolUse!.tool_input as { command?: string }).command === 'ls' &&
      inputs.PreToolUse!.agent_id === 'agent-1' &&
      inputs.PostToolUse!.tool_response !== undefined &&
      inputs.PreCompact!.trigger === 'manual' &&
      inputs.SessionEnd!.reason === 'other',
  );

  // Transcript in Claude Code's shape, with Claude Code tool names.
  const lines = claudeTranscriptLines('s-1', [
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: 'ok', toolCalls: [{ toolCallId: 'c1', toolName: 'run_command', input: { command: 'ls' } }] },
    { role: 'tool', toolCallId: 'c1', toolName: 'run_command', output: { content: 'a\nb' } },
  ]).map((l) => JSON.parse(l) as Record<string, unknown>);
  const tu = ((lines[1]!.message as { content: { type: string; name?: string }[] }).content ?? []).find((b) => b.type === 'tool_use');
  record(
    'transcript: Claude Code JSONL (user/assistant/tool_result) with Bash, not run_command',
    lines.length === 3 && lines[0]!.type === 'user' && lines[1]!.type === 'assistant' && tu?.name === 'Bash' && lines[2]!.parentUuid === lines[1]!.uuid,
    JSON.stringify(lines),
  );
}

// ---------------------------------------------------------------------------
// 2. The runner
// ---------------------------------------------------------------------------

function runner(cicToken?: string, metricsToken?: string, projectDir = PROJECT) {
  return createOrgHookRunner({
    config: CONFIG,
    env: orgHookEnv({
      base: process.env,
      pkgDir: PKG,
      projectDir,
      ...(cicToken ? { cicToken } : {}),
      ...(metricsToken ? { metricsToken } : {}),
    }),
  });
}

const call = (event: OrgHookCall['event'], extra: Partial<OrgHookCall> = {}, cwd = PROJECT): OrgHookCall => ({
  event,
  sessionId: 'sess-runner',
  cwd,
  transcriptPath: join(SPIKE_ROOT, 'transcripts', 'sess-runner.jsonl'),
  ...extra,
});

async function runnerChecks(): Promise<void> {
  mkdirSync(PROJECT, { recursive: true });
  mkdirSync(PROJECT_B, { recursive: true });
  clearLog();
  control({});
  const r = runner('cic_secret_for_scripts', 'hmt_secret_for_metrics');

  // All seven events.
  const results: Record<string, unknown> = {};
  results.SessionStart = await r.dispatch(call('SessionStart', { source: 'startup' }));
  results.UserPromptSubmit = await r.dispatch(call('UserPromptSubmit', { prompt: 'hi' }));
  results.PreToolUse = await r.dispatch(call('PreToolUse', { toolName: 'run_command', toolInput: { command: 'ls' } }));
  results.PostToolUse = await r.dispatch(call('PostToolUse', { toolName: 'write_file', toolInput: { path: 'a.md', content: 'x' } }));
  results.Stop = await r.dispatch(call('Stop'));
  results.PreCompact = await r.dispatch(call('PreCompact', { trigger: 'auto' }));
  results.SessionEnd = await r.dispatch(call('SessionEnd', { reason: 'other' }));
  await orgHooksIdle(5000);
  const log = readLog();
  const events = new Set(log.map((l) => String(l.input?.hook_event_name ?? '')));
  record(
    'runner: all seven events reach the allowlisted scripts',
    ORG_HOOK_EVENTS.every((e) => events.has(e)),
    JSON.stringify([...events]),
  );
  const ptu = log.find((l) => l.input?.hook_event_name === 'PreToolUse' && l.args?.[1] === 'pre-commit.py');
  record(
    'runner: PreToolUse(Bash) runs task pre-commit.py with tool_name Bash',
    ptu?.input?.tool_name === 'Bash' && (ptu.input.tool_input as { command?: string })?.command === 'ls',
    JSON.stringify(ptu),
  );
  const post = log.filter((l) => l.input?.hook_event_name === 'PostToolUse').map((l) => l.script + (l.args?.[1] ? `:${l.args[1]}` : ''));
  record(
    'runner: PostToolUse(Write) runs metrics-emit.js and task post-artifact.py',
    post.includes('metrics-emit.js') && post.includes('run-skill-hook.js:post-artifact.py'),
    JSON.stringify(post),
  );
  record('runner: no native or unsupported script ever ran', !log.some((l) => l.forbidden), JSON.stringify(log.filter((l) => l.forbidden)));
  const env = ptu?.env ?? {};
  record(
    'env: HARNESS_CLIENT=naby, plugin root, project dir, ELECTRON_RUN_AS_NODE=1',
    env.HARNESS_CLIENT === 'naby' && env.CLAUDE_PLUGIN_ROOT === PKG && env.CLAUDE_PROJECT_DIR === PROJECT && env.ELECTRON_RUN_AS_NODE === '1',
    JSON.stringify(env),
  );
  record(
    'env: the cic token under BOTH names, the metrics token, never a Skill Hub key',
    env.CLAUDE_PLUGIN_OPTION_CIC_TOKEN === 'cic_secret_for_scripts' &&
      env.CIC_API_TOKEN === 'cic_secret_for_scripts' &&
      env.HARNESS_METRICS_TOKEN === 'hmt_secret_for_metrics' &&
      env.SHUB_API_KEY === undefined &&
      env.CLAUDE_PLUGIN_OPTION_SHUB_API_KEY === undefined,
    JSON.stringify(env),
  );
  record('cwd: hooks run in the open project', ptu?.cwd === PROJECT || ptu?.cwd === `/private${PROJECT}`, String(ptu?.cwd));

  // No metrics token: metrics are disabled rather than falling back to Claude Code's cache.
  clearLog();
  await runner(undefined, undefined).dispatch(call('Stop'));
  await orgHooksIdle(5000);
  const stopEnv = readLog().find((l) => l.script === 'metrics-emit.js')?.env ?? {};
  record(
    'env: without a metrics token, HARNESS_METRICS_DISABLED=1 and no token',
    stopEnv.HARNESS_METRICS_DISABLED === '1' && stopEnv.HARNESS_METRICS_TOKEN === undefined && stopEnv.CIC_API_TOKEN === undefined,
    JSON.stringify(stopEnv),
  );

  // Outcomes: additionalContext, ask, deny > ask.
  clearLog();
  control({
    'session-start.py': { stdout: { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'TASK-STATE: open' } } },
    'pre-commit.py': { stdout: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'commit check' } } },
    'deny.py': { stdout: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no edits here' } } },
    'slow.py': { sleepMs: 3000 },
  });
  const ss = await r.dispatch(call('SessionStart', { source: 'startup' }));
  record('outcome: SessionStart additionalContext is collected', ss.additionalContext.includes('TASK-STATE: open'), JSON.stringify(ss));
  const ask = await r.dispatch(call('PreToolUse', { toolName: 'run_command', toolInput: { command: 'git commit' } }));
  record(
    'outcome: permissionDecision ask comes back with its reason',
    ask.decision?.behavior === 'ask' && ask.decision.reason === 'commit check' && ask.decision.script === 'run-skill-hook.js',
    JSON.stringify(ask),
  );
  const t0 = Date.now();
  const edit = await r.dispatch(call('PreToolUse', { toolName: 'edit_file', toolInput: { path: 'a', oldString: 'a', newString: 'b' } }));
  const took = Date.now() - t0;
  record(
    'outcome: deny wins over everything; a hook past its timeout is killed and ignored',
    edit.decision?.behavior === 'deny' && edit.timedOut === 1 && took < 2900,
    JSON.stringify({ ...edit, took }),
  );

  // Failures never block.
  control({ 'pre-commit.py': { crash: true }, 'post-artifact.py': { exit: 3 } });
  let threw = false;
  let crash: Awaited<ReturnType<typeof r.dispatch>> | undefined;
  let fail: Awaited<ReturnType<typeof r.dispatch>> | undefined;
  try {
    crash = await r.dispatch(call('PreToolUse', { toolName: 'run_command', toolInput: { command: 'ls' } }));
    fail = await r.dispatch(call('PostToolUse', { toolName: 'write_file', toolInput: { path: 'a', content: '' } }));
  } catch {
    threw = true;
  }
  record(
    'failure: a crashing and a non-zero hook are logged and ignored — no throw, no decision',
    !threw && crash?.failed === 1 && crash.decision === undefined && fail?.failed === 1,
    JSON.stringify({ crash, fail }),
  );
  const missingExe = createOrgHookRunner({
    config: CONFIG,
    env: orgHookEnv({ base: process.env, pkgDir: PKG, projectDir: PROJECT }),
    executable: join(SPIKE_ROOT, 'no-such-node'),
  });
  const spawnFail = await missingExe.dispatch(call('PreToolUse', { toolName: 'run_command', toolInput: { command: 'ls' } }));
  record('failure: an executable that cannot start is a failed hook, not an error', spawnFail.failed >= 1 && spawnFail.decision === undefined, JSON.stringify(spawnFail));

  // Async is not awaited.
  control({ metrics: { sleepMs: 1500 } });
  const ta = Date.now();
  const stop = await r.dispatch(call('Stop'));
  const asyncTook = Date.now() - ta;
  record('async: metrics-emit.js (async: true) is not waited for', stop.asyncStarted === 1 && asyncTook < 1200, `${asyncTook}ms`);
  await orgHooksIdle(5000);

  // Resume: task hooks yes, metrics no.
  clearLog();
  control({});
  await r.dispatch(call('SessionStart', { source: 'resume' }));
  await orgHooksIdle(5000);
  const resumed = readLog().map((l) => l.script);
  record(
    'resume: SessionStart(resume) runs the task hook but NOT metrics-emit.js (§4.7)',
    resumed.includes('run-skill-hook.js') && !resumed.includes('metrics-emit.js'),
    JSON.stringify(resumed),
  );

  // Serial per project, concurrent across projects.
  clearLog();
  control({ 'scripts/session-hook.py': { sleepMs: 600 } });
  await Promise.all([
    r.dispatch(call('PreCompact', { trigger: 'auto' })),
    r.dispatch(call('PreCompact', { trigger: 'auto' })),
  ]);
  const same = readLog().filter((l) => l.input?.hook_event_name === 'PreCompact').map((l) => l.at ?? 0).sort();
  record(
    'serial: two PreCompact hooks on ONE project run one after the other',
    same.length === 2 && same[1]! - same[0]! >= 500,
    JSON.stringify(same),
  );
  clearLog();
  const rB = runner(undefined, undefined, PROJECT_B);
  await Promise.all([
    r.dispatch(call('PreCompact', { trigger: 'auto' })),
    rB.dispatch(call('PreCompact', { trigger: 'auto' }, PROJECT_B)),
  ]);
  const diff = readLog().filter((l) => l.input?.hook_event_name === 'PreCompact').map((l) => l.at ?? 0).sort();
  record(
    'serial: PreCompact hooks on TWO projects run concurrently',
    diff.length === 2 && diff[1]! - diff[0]! < 400,
    JSON.stringify(diff),
  );

  // SessionEnd is capped at 5 s.
  control({ 'scripts/session-hook.py': { sleepMs: 8000 } });
  const te = Date.now();
  const end = await runner(undefined, undefined, join(SPIKE_ROOT, 'project-c')).dispatch(
    call('SessionEnd', { reason: 'other' }, join(SPIKE_ROOT, 'project-c')),
  );
  const endTook = Date.now() - te;
  record('SessionEnd: the wait stops at 5 s even though the hook runs 8 s', end.capped === true && endTook >= 4800 && endTook < 6500, `${endTook}ms`);
  control({});
}

// ---------------------------------------------------------------------------
// 3. End to end through the shell's naby engine (AI-SDK engine)
// ---------------------------------------------------------------------------

const ZERO_USAGE = {
  inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 },
};
const toolStep = (id: string, toolName: string, input: Record<string, unknown>): LanguageModelV4GenerateResult => ({
  content: [{ type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls', raw: 'tool_use' },
  usage: ZERO_USAGE,
  warnings: [],
});
const textStep = (text: string): LanguageModelV4GenerateResult => ({
  content: [{ type: 'text', text }],
  finishReason: { unified: 'stop', raw: 'end_turn' },
  usage: ZERO_USAGE,
  warnings: [],
});

async function turn(
  model: MockLanguageModelV4,
  prompt: string,
  opts: { sessionId?: string; cwd?: string; onEvent?: (e: RunEvent) => void } = {},
): Promise<{ events: RunEvent[]; sessionId: string }> {
  const events: RunEvent[] = [];
  let key = opts.sessionId ?? 'provisional';
  const ctx: RunCtx = {
    prompt,
    images: undefined,
    cwd: opts.cwd ?? PROJECT,
    sessionId: opts.sessionId,
    params: { prompt, engine: 'naby' },
    signal: new AbortController().signal,
    emit(event: RunEvent) {
      events.push(event);
      opts.onEvent?.(event);
    },
    rekey(id: string) {
      key = id;
    },
    currentKey() {
      return key;
    },
  };
  await createNabySpec({ resolveModel: () => model as never }).runner.run(ctx);
  return { events, sessionId: key };
}

const hookEvents = (): { event: string; script: string; file?: string; input: Record<string, unknown> }[] =>
  readLog()
    .filter((l) => !l.forbidden && l.input)
    .map((l) => ({
      event: String(l.input!.hook_event_name),
      script: l.script,
      ...(l.args?.[1] ? { file: l.args[1] } : {}),
      input: l.input!,
    }));

async function endToEndChecks(): Promise<void> {
  const dist = (await import(DIST)) as unknown as DistRuntime;
  const store = getStore();
  // The org harness: a Skill Hub key, a fake Skill Hub serving the fixture
  // package (the REAL 0.7.1 hooks.json plus the unsupported entry), a sync.
  const zip = buildZip(fixtureEntries({ 'scripts/new-hook.js': NEW_HOOK_JS }));
  const sha = createHash('sha256').update(zip).digest('hex');
  setOrgHarnessFetch(async (url) => {
    const respond = (status: number, body: unknown, bytes?: Buffer) => ({
      status,
      json: async () => body,
      arrayBuffer: async () => {
        const b = bytes ?? Buffer.alloc(0);
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      },
    });
    if (url.endsWith('/marketplace.json')) {
      return respond(200, {
        plugins: [{ name: 'altimedia-harness', version: '0.7.1', source: { url: '/api/v1/plugins/altimedia-harness/download', sha256: sha } }],
      });
    }
    if (url.endsWith('/download')) return respond(200, null, zip);
    if (url.endsWith('/harness/bootstrap')) return respond(200, { env: { HARNESS_METRICS_TOKEN: 'hmt_e2e' } });
    return respond(404, null);
  });
  store.upsertMcpEntry({
    name: 'skill-hub',
    transport: 'http',
    url: 'http://127.0.0.1:9/mcp',
    headers: { Authorization: 'Bearer shub_e2e_key_never_forward' },
    status: 'enabled',
  });
  store.upsertMcpEntry({
    name: 'cic',
    transport: 'http',
    url: 'http://127.0.0.1:9/cic',
    headers: { Authorization: 'Bearer cic_e2e_token' },
    status: 'enabled',
  });
  const synced = await syncOrgHarnessNow(store, { applyNow: true });
  record('e2e: the org harness package is installed through the real sync', synced.package?.outcome === 'updated', JSON.stringify(synced.package));

  // ---- turn 1: a new session that runs a command and writes a file ----------
  clearLog();
  control({
    'session-start.py': { stdout: { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'TASK-STATE: open' } } },
    'pre-commit.py': { stdout: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'commit check' } } },
  });
  const model1 = new MockLanguageModelV4({
    doGenerate: [
      toolStep('c1', 'run_command', { command: 'echo hi' }),
      toolStep('c2', 'write_file', { path: 'a.txt', content: 'x' }),
      textStep('done.'),
    ],
  });
  const approvals: Record<string, unknown>[] = [];
  const t1 = await turn(model1, 'please do it', {
    onEvent: (e) => {
      if (e.type === 'approval_request') {
        approvals.push(e as Record<string, unknown>);
        // The user presses "Allow once".
        setTimeout(() => resolveApproval(String((e as unknown as { approvalId: string }).approvalId), { behavior: 'allow' }), 10);
      }
    },
  });
  await orgHooksIdleDist();
  const ev1 = hookEvents();
  const names1 = ev1.map((e) => `${e.event}${e.file ? `:${e.file}` : ''}`);
  const seq = ['SessionStart:session-start.py', 'UserPromptSubmit', 'PreToolUse:pre-commit.py', 'PostToolUse', 'PostToolUse:post-artifact.py', 'Stop'];
  record('e2e turn: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop all fire', seq.every((s) => names1.includes(s)), JSON.stringify(names1));
  const ss = ev1.find((e) => e.event === 'SessionStart');
  record('e2e turn: a new session starts with source "startup"', ss?.input.source === 'startup', JSON.stringify(ss?.input));
  const pre = ev1.find((e) => e.event === 'PreToolUse');
  record(
    'e2e turn: PreToolUse sees run_command as Bash, with the command',
    pre?.input.tool_name === 'Bash' && (pre.input.tool_input as { command?: string }).command === 'echo hi',
    JSON.stringify(pre?.input),
  );
  const postWrite = ev1.find((e) => e.event === 'PostToolUse' && e.file === 'post-artifact.py');
  record(
    'e2e turn: PostToolUse sees write_file as Write with an absolute file_path',
    postWrite?.input.tool_name === 'Write' && (postWrite.input.tool_input as { file_path?: string }).file_path === join(PROJECT, 'a.txt'),
    JSON.stringify(postWrite?.input),
  );
  const ask = approvals[0] ?? {};
  record(
    'e2e ask: the hook\'s ask reaches the approval prompt with its reason, marked as a hook',
    approvals.length === 1 && ask.reason === 'commit check' && ask.source === 'hook' && ask.tool_name === 'run_command',
    JSON.stringify(approvals),
  );
  const ran = t1.events.some(
    (e) => e.type === 'user' && JSON.stringify(e).includes('hi') && !JSON.stringify(e).includes('Denied by policy gate'),
  );
  record('e2e ask: once allowed, the command runs', ran && existsSync(join(PROJECT, 'a.txt')));
  const systemPrompts = model1.doGenerateCalls.map((c) => JSON.stringify(c.prompt));
  record(
    'e2e context: SessionStart additionalContext is in the model\'s system prompt',
    systemPrompts.some((p) => p.includes('TASK-STATE: open')),
  );
  const envs = readLog().filter((l) => l.env);
  record(
    'e2e env: no hook saw the Skill Hub key; scripts got the cic token under both names',
    envs.every((l) => !JSON.stringify(l.env).includes('shub_')) &&
      envs.some((l) => l.env!.CIC_API_TOKEN === 'cic_e2e_token' && l.env!.CLAUDE_PLUGIN_OPTION_CIC_TOKEN === 'cic_e2e_token') &&
      envs.some((l) => l.env!.HARNESS_METRICS_TOKEN === 'hmt_e2e'),
  );
  record('e2e: no native or unsupported script ran', !readLog().some((l) => l.forbidden));

  // ---- turn 2: same session — no second SessionStart -------------------------
  clearLog();
  control({});
  await turn(new MockLanguageModelV4({ doGenerate: [textStep('again.')] }), 'again', { sessionId: t1.sessionId });
  await orgHooksIdleDist();
  const ev2 = hookEvents().map((e) => e.event);
  record('e2e: the next turn of the same session does not repeat SessionStart', !ev2.includes('SessionStart') && ev2.includes('UserPromptSubmit'), JSON.stringify(ev2));

  // ---- a failing hook does not stop a turn -----------------------------------
  clearLog();
  control({ 'pre-commit.py': { crash: true }, 'post-artifact.py': { exit: 2 } });
  const tFail = await turn(
    new MockLanguageModelV4({ doGenerate: [toolStep('f1', 'run_command', { command: 'echo ok' }), textStep('finished.')] }),
    'go',
    { sessionId: t1.sessionId },
  );
  const result = tFail.events.find((e) => e.type === 'result') as { subtype?: string } | undefined;
  record('e2e failure: a crashing PreToolUse hook does not block the tool or the turn', result?.subtype === 'success', JSON.stringify(result));
  control({});

  // ---- restart: the session resumes ------------------------------------------
  shellResetOrgHookState();
  clearLog();
  await turn(new MockLanguageModelV4({ doGenerate: [textStep('back.')] }), 'back again', { sessionId: t1.sessionId });
  await orgHooksIdleDist();
  const ev3 = hookEvents();
  const resume = ev3.filter((e) => e.event === 'SessionStart');
  record(
    'e2e resume: after a restart the session gets SessionStart(resume) once, and metrics-emit is skipped for it',
    resume.length === 1 && resume[0]!.input.source === 'resume' && resume[0]!.script === 'run-skill-hook.js',
    JSON.stringify(resume),
  );

  // ---- compaction: a session big enough to fold --------------------------------
  const big = store.createSession('', undefined, PROJECT);
  const chunk = 'lorem ipsum dolor sit amet '.repeat(1500); // ~40k chars
  for (let i = 0; i < 12; i += 1) {
    store.appendMessage(big.sessionId, { role: i % 2 === 0 ? 'user' : 'assistant', content: `${i} ${chunk}` });
  }
  clearLog();
  control({ 'session-start.py': { stdout: { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'RESTORED-AFTER-COMPACT' } } } });
  const model4 = new MockLanguageModelV4({ doGenerate: [textStep('A summary of the folded turns.'), textStep('compacted answer.')] });
  const t4 = await turn(model4, 'continue', { sessionId: big.sessionId });
  await orgHooksIdleDist();
  const ev4 = hookEvents();
  const folded = t4.events.some((e) => JSON.stringify(e).includes('context-compaction'));
  const pc = ev4.find((e) => e.event === 'PreCompact');
  const compactStart = ev4.find((e) => e.event === 'SessionStart' && e.input.source === 'compact');
  record('e2e compaction: the AI-SDK engine folded this session', folded);
  record('e2e compaction: PreCompact fires before the fold (ctx re-index hook)', pc?.file === 'scripts/session-hook.py' && pc.input.trigger === 'auto', JSON.stringify(pc));
  record('e2e compaction: SessionStart(compact) fires after it', !!compactStart, JSON.stringify(ev4.map((e) => `${e.event}:${String(e.input.source ?? '')}`)));
  const tp = String(pc?.input.transcript_path ?? '');
  record(
    'e2e compaction: transcript_path points at a freshly written Claude Code JSONL',
    tp === dist.orgTranscriptPath(SPIKE_ROOT, big.sessionId) && existsSync(tp) && readFileSync(tp, 'utf8').split('\n').filter(Boolean).length >= 12,
    tp,
  );
  const lastCall = model4.doGenerateCalls[model4.doGenerateCalls.length - 1];
  record(
    'e2e compaction: the compact SessionStart context reaches the system prompt of the run',
    JSON.stringify(lastCall?.prompt ?? '').includes('RESTORED-AFTER-COMPACT'),
  );
  control({});

  // ---- SessionEnd: tab close, then app quit -----------------------------------
  clearLog();
  endOrgSessionsOnClose(store, [t1.sessionId]);
  const closed = await waitFor(() => hookEvents().some((e) => e.event === 'SessionEnd'), 6000);
  const se = hookEvents().find((e) => e.event === 'SessionEnd');
  record(
    'e2e SessionEnd: closing the tab runs SessionEnd (ctx hook) with the transcript written',
    closed && se?.file === 'scripts/session-hook.py' && existsSync(String(se.input.transcript_path)),
    JSON.stringify(se),
  );
  clearLog();
  await turn(new MockLanguageModelV4({ doGenerate: [textStep('hi.')] }), 'a new tab', {});
  await orgHooksIdleDist();
  clearLog();
  const tq = Date.now();
  await dist.runOrgHarnessQuitHandler();
  const quitEnds = hookEvents().filter((e) => e.event === 'SessionEnd');
  record(
    'e2e SessionEnd: app quit ends every live session (bounded by the 5 s cap)',
    quitEnds.length >= 2 && quitEnds.every((e) => e.input.reason === 'prompt_input_exit') && Date.now() - tq < 6000,
    JSON.stringify(quitEnds.map((e) => e.input.session_id)),
  );
  record('e2e: still no native or unsupported script ran', !readLog().some((l) => l.forbidden));
  record(
    'e2e: every hook outcome is in the hook log (none of them errors)',
    shellRecentOrgHookLog().length > 0 && !shellRecentOrgHookLog().some((l) => l.outcome === 'matcher-error'),
  );
  record(
    'e2e: no Atlassian row was created and nothing connected to a remote MCP',
    !store.listMcpEntries().some((e) => e.name === 'atlassian'),
  );
  setOrgHarnessFetch(undefined);
}

async function orgHooksIdleDist(): Promise<void> {
  // The shell's own runtime instance — the one whose hooks are in flight.
  await shellOrgHooksIdle(8000);
}

// ---------------------------------------------------------------------------
// 4. The Agent SDK engine's compaction hooks
// ---------------------------------------------------------------------------

function claudeEngineChecks(): void {
  const noop = async () => ({});
  const opts = buildQueryOptions({
    input: {
      model: { providerId: 'dev-claude' },
      messages: [],
      toolSchemas: [],
      gate: async () => ({ behavior: 'allow' }),
      executors: {},
      signal: new AbortController().signal,
    },
    mcpServer: {} as never,
    preToolUse: noop as never,
    compactionHooks: { preCompact: noop as never, sessionStart: noop as never },
    abortController: new AbortController(),
    onStderr: () => {},
  });
  const hooks = (opts as { hooks?: Record<string, unknown[]> }).hooks ?? {};
  record(
    'claude engine: with a compaction port, PreCompact and SessionStart(compact) are registered SDK hooks',
    Array.isArray(hooks.PreCompact) && Array.isArray(hooks.SessionStart) && Array.isArray(hooks.PreToolUse),
    JSON.stringify(Object.keys(hooks)),
  );
  const none = buildQueryOptions({
    input: {
      model: { providerId: 'dev-claude' },
      messages: [],
      toolSchemas: [],
      gate: async () => ({ behavior: 'allow' }),
      executors: {},
      signal: new AbortController().signal,
    },
    mcpServer: {} as never,
    preToolUse: noop as never,
    abortController: new AbortController(),
    onStderr: () => {},
  });
  record(
    'claude engine: without one, the hook set is exactly PreToolUse (pre-M3)',
    JSON.stringify(Object.keys((none as { hooks?: object }).hooks ?? {})) === '["PreToolUse"]',
  );
}

async function main(): Promise<void> {
  try {
    configChecks();
    await runnerChecks();
    await endToEndChecks();
    claudeEngineChecks();
  } catch (e) {
    record('spike ran to completion', false, e instanceof Error ? (e.stack ?? e.message) : String(e));
  }
  let failed = 0;
  for (const ch of checks) {
    if (!ch.pass) failed += 1;
    console.log(`${ch.pass ? 'PASS' : 'FAIL'}  ${ch.name}${ch.evidence && !ch.pass ? `\n      ${ch.evidence.slice(0, 1500)}` : ''}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  try {
    rmSync(SPIKE_ROOT, { recursive: true, force: true });
  } catch {
    /* temp */
  }
  process.exit(failed === 0 ? 0 : 1);
}

void main();
