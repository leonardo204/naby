// src/spikes/spike-org-harness-metrics.ts
//
// ORG HARNESS M4 — H1–H4 metrics through both engines, and a package version
// replaced in the middle of a turn (specs/org-harness-sync.md §3.5, §3.6, §3.7,
// §4.7, §4.9 case 7).
//
// THE METRICS SCRIPT IS THE REAL ONE. The fixture's `scripts/metrics-emit.js` is
// altimedia-harness 0.8.1's file verbatim behind a fixture-only prelude; the
// first check re-hashes it against the upstream sha256. Its stage rules, its
// 8-field payload, its `agent_id` / `compact` filters and its `HARNESS_CLIENT`
// handling are therefore Skill Hub's, not a re-implementation.
//
// NO NETWORK, NO REAL HOME. A temp NABY_HOME + NABY_DB_PATH, a temp HOME (with a
// DECOY Claude Code activation cache that must never be read), a fake Skill Hub
// (injected fetch), a local stdio MCP server for the Confluence tool names, a
// scripted stand-in for the Agent SDK. Payloads are captured with
// `HARNESS_METRICS_DRYRUN=1` (stderr, kept by the hook log), and in one leg with
// `HARNESS_METRICS_URL` pointed at a local HTTP server — never skills.altimedia.com.
//
// WHAT IS ASSERTED:
//
//   fixture    the metrics script hashes to upstream 0.8.1; hooks.json carries
//              0.8.1's widened PostToolUse matcher
//   stages     through the runner: SessionStart → 입력, UserPromptSubmit → 맥락,
//              PostToolUse(Bash/Write/Edit) → 실행, PostToolUse on
//              `mcp__*__createConfluencePage|updateConfluencePage` (and the
//              mcp-atlassian and plugin spellings) → 기록, Stop → 검수;
//              getConfluencePage / Read never reach the script
//   filters    agent_id ⇒ not counted; SessionStart(compact) ⇒ not counted (the
//              script); SessionStart(resume) ⇒ not counted (naby skips the script)
//   payload    exactly the 8 fields, client "naby" (and "claude-code" without
//              HARNESS_CLIENT, so the field is naby's doing), repo from `git
//              remote`, team "unassigned", harness_version from the pinned
//              package; no prompt text, path or command
//   team       `env.HARNESS_TEAM` (that key only) from the project's
//              `.claude/settings.local.json` over `.claude/settings.json`, then
//              the process env, else "unassigned"; invalid JSON is ignored; the
//              files are never written; the payload `team` follows, on both engines
//   token      the bootstrap's HARNESS_METRICS_TOKEN is the bearer the script
//              sends (local URL); with no naby token NOTHING is emitted even under
//              DRYRUN, and the decoy ~/.cache/altimedia-harness token never appears
//   engines    ONE scripted turn through the AI-SDK engine (mock model) and the
//              Claude Agent SDK engine (scripted SDK): the same payloads, stage
//              for stage, and the same hook runs per event and script; the same
//              for a turn whose work a subagent does (naby_delegate vs an SDK
//              subagent) and for a resumed session
//   mid-turn   two new versions land during one turn: rows wait for the next
//              turn boundary; the running turn's hooks — including the Stop after
//              both flips — run from the OLD folder (harness_version 0.8.1); the
//              old folder survives both flips while leased and is collected once
//              the turn and its last hook are done; the next turn runs 0.8.3; the
//              session's SessionEnd runs from the folder of its latest turn
//
// Prints PASS/FAIL per assertion; exits non-zero on any FAIL.

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Everything that resolves a home must see the temp one BEFORE any import runs.
const SPIKE_ROOT = mkdtempSync(join(tmpdir(), 'naby-spike-org-metrics-'));
const FAKE_HOME = join(SPIKE_ROOT, 'user-home');
mkdirSync(join(FAKE_HOME, '.cache', 'altimedia-harness'), { recursive: true });
// The decoy: Claude Code's activation cache. naby must never read it (§3.6).
const DECOY_TOKEN = 'decoy_claude_code_cache_token';
writeFileSync(join(FAKE_HOME, '.cache', 'altimedia-harness', 'activation.json'), JSON.stringify({ token: DECOY_TOKEN }));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.NABY_HOME = join(SPIKE_ROOT, 'naby-home');
process.env.NABY_DB_PATH = join(SPIKE_ROOT, 'naby-home', 'app.db');
mkdirSync(process.env.NABY_HOME, { recursive: true });
// No background Skill Hub pass: the spike drives every sync itself.
process.env.NABY_ORG_HARNESS_SYNC = '0';
// The Atlassian gate is spike-org-harness-gate's subject.
process.env.HARNESS_GATE = '0';
// Payloads go to stderr, never to a server.
process.env.HARNESS_METRICS_DRYRUN = '1';
delete process.env.HARNESS_METRICS_URL;
delete process.env.HARNESS_METRICS_DISABLED;
delete process.env.HARNESS_METRICS_TOKEN;
delete process.env.HARNESS_TEAM;
delete process.env.HARNESS_CLIENT;
delete process.env.NABY_SPIKE_HOOK_LOG;

import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import {
  createOrgHookRunner,
  orgHookEnv,
  orgHooksIdle,
  orgProjectHarnessTeam,
  readOrgHookConfig,
  recentOrgHookLog,
  type OrgHookCall,
  type OrgHookLogEntry,
} from '../runtime/org-harness-hooks.js';
import { DEFAULT_USER_ID } from '../runtime/memory-inject.js';
import { buildZip, type ZipWriteEntry } from '../runtime/zip.js';
import { fakeAgentSdk, type FakeSdkStep } from './fixtures/fake-agent-sdk.js';
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
import { markRunIdle, startRun } from '../../shell/packages/feature/agent/src/server/sessionRunHub.js';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, evidence = ''): void {
  checks.push({ name, pass, evidence });
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = join(ROOT, 'src/spikes/fixtures/org-harness/altimedia-harness');
const CONFLUENCE_MCP = join(ROOT, 'src/spikes/fixtures/mcp-confluence-server.mjs');
/** sha256 of altimedia-harness 0.8.1 `scripts/metrics-emit.js` as published on
 *  Skill Hub (marketplace sha256 140fcdf1…ff27, fetched 2026-10-08). */
const UPSTREAM_METRICS_SHA256 = 'd0b047b90facb2e4ab96f55722ecd51c53b8470efa6f8f8a133b3907d932f1bf';
const PRELUDE_END = '// ---- end naby fixture prelude; upstream 0.8.1 follows verbatim ------------\n';
const M081 = '^mcp__.*__(confluence_(create|update)_page|(create|update)ConfluencePage)$';
const PROJECT = join(SPIKE_ROOT, 'project');
const REPO = 'altimedia/m4-demo';
const BOOT_TOKEN = 'hmt_m4_from_bootstrap';

// The DIST runtime: the instance the shell runs on (process-level state).
type DistRuntime = {
  ClaudeAgentSdkEngine: new (opts?: { sdk?: unknown }) => unknown;
  listOrgPackageVersions(home: string): string[];
  readCurrentOrgPackage(home: string): { version: string; dir: string } | undefined;
  leasedOrgPackageDirs(): string[];
};
const DIST = '../../dist/naby-runtime.mjs';

type Payload = Record<string, unknown>;
const STAGE_FIELDS = ['session_id', 'team', 'repo', 'event', 'stage', 'harness_version', 'client', 'ts'];

function payloadsOf(entries: readonly OrgHookLogEntry[]): Payload[] {
  const out: Payload[] = [];
  for (const e of entries) {
    if (e.script !== 'metrics-emit.js' || !e.stderr) continue;
    for (const line of e.stderr.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      try {
        out.push(JSON.parse(t) as Payload);
      } catch {
        /* not a payload */
      }
    }
  }
  return out;
}
const stagesOf = (ps: readonly Payload[]): string[] => ps.map((p) => `${String(p.event)}:${String(p.stage)}`).sort();
const runsBy = (entries: readonly OrgHookLogEntry[]): string[] =>
  entries.map((e) => `${e.event}:${e.script}`).sort();
function countMap(xs: readonly string[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const x of xs) m[x] = (m[x] ?? 0) + 1;
  return m;
}

// ---------------------------------------------------------------------------
// 0. The fixture is upstream 0.8.1
// ---------------------------------------------------------------------------

function fixtureChecks(): void {
  const text = readFileSync(join(FIXTURE, 'scripts/metrics-emit.js'), 'utf8');
  const at = text.indexOf(PRELUDE_END);
  const body = at >= 0 ? text.slice(at + PRELUDE_END.length) : '';
  const sha = createHash('sha256').update(`#!/usr/bin/env node\n${body}`).digest('hex');
  record(
    'fixture: scripts/metrics-emit.js below the prelude is upstream 0.8.1 byte for byte',
    at > 0 && sha === UPSTREAM_METRICS_SHA256,
    sha,
  );
  const hooks = JSON.parse(readFileSync(join(FIXTURE, 'hooks/hooks.json'), 'utf8')) as {
    hooks: Record<string, { matcher?: string; hooks: { args?: string[] }[] }[]>;
  };
  const metricsPost = hooks.hooks.PostToolUse!.find((g) => g.hooks.some((h) => (h.args?.[0] ?? '').endsWith('metrics-emit.js')));
  record(
    'fixture: hooks.json PostToolUse metrics matcher is 0.8.1\'s widened one',
    metricsPost?.matcher === `Write|Edit|Bash|${M081}`,
    String(metricsPost?.matcher),
  );
  const plugin = JSON.parse(readFileSync(join(FIXTURE, '.claude-plugin/plugin.json'), 'utf8')) as { version?: string };
  record('fixture: plugin.json is 0.8.1', plugin.version === '0.8.1');
}

// ---------------------------------------------------------------------------
// 1. Through the runner: every stage, every filter, the payload, the token
// ---------------------------------------------------------------------------

let PKG = '';

function setupProject(): void {
  mkdirSync(PROJECT, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: PROJECT });
  execFileSync('git', ['remote', 'add', 'origin', `git@bitbucket.org:${REPO}.git`], { cwd: PROJECT });
}

async function runnerChecks(): Promise<void> {
  PKG = join(SPIKE_ROOT, 'pkg-direct', '0.8.1');
  cpSync(FIXTURE, PKG, { recursive: true });
  const config = readOrgHookConfig(PKG);
  const mcp = new Set(['wiki__createConfluencePage', 'atlassian__updateConfluencePage', 'atlassian__confluence_create_page', 'atlassian__getConfluencePage']);
  const runner = createOrgHookRunner({
    config,
    env: orgHookEnv({ base: process.env, pkgDir: PKG, projectDir: PROJECT, metricsToken: 'hmt_direct' }),
  });
  const sid = 'direct-session-1';
  const base = (event: OrgHookCall['event']): OrgHookCall => ({
    event,
    sessionId: sid,
    cwd: PROJECT,
    transcriptPath: join(SPIKE_ROOT, 't.jsonl'),
    mcpToolNames: mcp,
  });
  const post = (toolName: string, toolInput: unknown, agentId?: string): OrgHookCall => ({
    ...base('PostToolUse'),
    toolName,
    toolInput,
    toolResponse: { content: 'ok' },
    ...(agentId ? { agentId } : {}),
  });
  const t0 = Date.now();
  await runner.dispatch({ ...base('SessionStart'), source: 'startup' });
  await runner.dispatch({ ...base('UserPromptSubmit'), prompt: 'SECRET-PROMPT-TEXT please' });
  await runner.dispatch(post('run_command', { command: 'cat /etc/SECRET-PATH' }));
  await runner.dispatch(post('write_file', { path: 'SECRET-FILE.md', content: 'x' }));
  await runner.dispatch(post('edit_file', { path: 'SECRET-FILE.md', oldString: 'x', newString: 'y' }));
  await runner.dispatch(post('wiki__createConfluencePage', { title: 't' }));
  await runner.dispatch(post('atlassian__updateConfluencePage', { pageId: '1' }));
  await runner.dispatch(post('atlassian__confluence_create_page', { title: 't' }));
  await runner.dispatch(post('mcp__plugin_altimedia-harness_atlassian__createConfluencePage', { title: 't' }));
  await runner.dispatch(post('atlassian__getConfluencePage', { pageId: '1' }));
  await runner.dispatch(post('read_file', { path: 'a.md' }));
  await runner.dispatch(post('write_file', { path: 'sub.md', content: 'x' }, 'naby-delegate-helper'));
  await runner.dispatch({ ...base('SessionStart'), source: 'compact' });
  await runner.dispatch({ ...base('SessionStart'), source: 'resume' });
  await runner.dispatch({ ...base('PreToolUse'), toolName: 'run_command', toolInput: { command: 'ls' } });
  await runner.dispatch({ ...base('PreCompact'), trigger: 'auto' });
  await runner.dispatch(base('Stop'));
  await runner.dispatch({ ...base('SessionEnd'), reason: 'other' });
  await orgHooksIdle(15_000);
  const entries = recentOrgHookLog().filter((e) => e.sessionId === sid && e.at >= t0);
  const metricsRuns = entries.filter((e) => e.script === 'metrics-emit.js');
  const payloads = payloadsOf(entries);
  const want = [
    'SessionStart:입력',
    'UserPromptSubmit:맥락',
    'PostToolUse:실행',
    'PostToolUse:실행',
    'PostToolUse:실행',
    'PostToolUse:기록',
    'PostToolUse:기록',
    'PostToolUse:기록',
    'PostToolUse:기록',
    'Stop:검수',
  ].sort();
  record(
    'stages: 입력 / 맥락 / 실행×3 (Bash, Write, Edit) / 기록×4 / 검수 — exactly',
    JSON.stringify(stagesOf(payloads)) === JSON.stringify(want),
    JSON.stringify(stagesOf(payloads)),
  );
  const recorded = payloads.filter((p) => p.stage === '기록').length;
  record(
    'stages: official OAuth MCP writes (createConfluencePage / updateConfluencePage) reach 기록 under the 0.8.1 regex',
    recorded === 4,
    String(recorded),
  );
  // 12 runs: SS(startup), UPS, 7 matched PostToolUse, the subagent's PostToolUse,
  // SS(compact), Stop. Not run: getConfluencePage / Read (matcher), SS(resume)
  // (naby), PreToolUse / PreCompact / SessionEnd (no metrics hook there).
  const runCounts = countMap(metricsRuns.map((e) => e.event));
  record(
    'runs: getConfluencePage and Read never reach the script; resume is skipped by naby; 12 runs in all',
    metricsRuns.length === 12 &&
      runCounts.SessionStart === 2 &&
      runCounts.PostToolUse === 8 &&
      runCounts.UserPromptSubmit === 1 &&
      runCounts.Stop === 1 &&
      !('PreToolUse' in runCounts) &&
      !('PreCompact' in runCounts) &&
      !('SessionEnd' in runCounts),
    JSON.stringify(runCounts),
  );
  record(
    'filters: the subagent call (agent_id) and SessionStart(compact) ran the script and produced NO payload',
    payloads.length === 10 && metricsRuns.length - payloads.length === 2,
    JSON.stringify({ runs: metricsRuns.length, payloads: payloads.length }),
  );
  const shapes = payloads.every((p) => JSON.stringify(Object.keys(p).sort()) === JSON.stringify([...STAGE_FIELDS].sort()));
  record('payload: exactly the eight fields (the seven of §3.7 plus client)', shapes, JSON.stringify(payloads[0]));
  record(
    'payload: client "naby", team "unassigned", repo from git remote, harness_version 0.8.1, the session id, an ISO ts',
    payloads.every(
      (p) =>
        p.client === 'naby' &&
        p.team === 'unassigned' &&
        p.repo === REPO &&
        p.harness_version === '0.8.1' &&
        p.session_id === sid &&
        typeof p.ts === 'string' &&
        !Number.isNaN(Date.parse(String(p.ts))),
    ),
    JSON.stringify(payloads.slice(0, 2)),
  );
  record(
    'payload: no prompt text, file path or command ever leaves',
    !JSON.stringify(payloads).includes('SECRET'),
  );

  // The client field is naby's doing: the same script without HARNESS_CLIENT says claude-code.
  const bare = spawnSync(process.execPath, [join(PKG, 'scripts', 'metrics-emit.js')], {
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'x', cwd: PROJECT }),
    env: { PATH: process.env.PATH ?? '', HOME: FAKE_HOME, HARNESS_METRICS_DRYRUN: '1', HARNESS_METRICS_TOKEN: 't' },
    encoding: 'utf8',
  });
  const bareClient = (() => {
    try {
      return (JSON.parse(bare.stderr.trim()) as Payload).client;
    } catch {
      return undefined;
    }
  })();
  record('payload: without HARNESS_CLIENT the same script reports client "claude-code"', bareClient === 'claude-code', bare.stderr);

  // No naby token: nothing at all, even under DRYRUN, and never the decoy.
  const noTok = createOrgHookRunner({ config, env: orgHookEnv({ base: process.env, pkgDir: PKG, projectDir: PROJECT }) });
  const sid2 = 'direct-session-notoken';
  const t1 = Date.now();
  await noTok.dispatch({ ...base('SessionStart'), sessionId: sid2, source: 'startup' });
  await noTok.dispatch({ ...base('UserPromptSubmit'), sessionId: sid2, prompt: 'hi' });
  await noTok.dispatch({ ...post('write_file', { path: 'a', content: '' }), sessionId: sid2 });
  await noTok.dispatch({ ...base('Stop'), sessionId: sid2 });
  await orgHooksIdle(15_000);
  const nt = recentOrgHookLog().filter((e) => e.sessionId === sid2 && e.at >= t1);
  record(
    'token: with no naby metrics token the script runs 4 times and emits NOTHING (HARNESS_METRICS_DISABLED=1), decoy cache unused',
    nt.filter((e) => e.script === 'metrics-emit.js').length === 4 && payloadsOf(nt).length === 0 && !JSON.stringify(nt).includes(DECOY_TOKEN),
    JSON.stringify(nt.map((e) => [e.event, e.script, e.stderr ?? ''])),
  );

  await teamChecks(config);
}

/** `team` in the payload for a Stop fired with the open project `dir`. */
async function teamOf(
  config: ReturnType<typeof readOrgHookConfig>,
  dir: string,
  base: Record<string, string | undefined>,
): Promise<unknown> {
  const team = orgProjectHarnessTeam(dir);
  const r = createOrgHookRunner({
    config,
    env: orgHookEnv({ base, pkgDir: PKG, projectDir: dir, metricsToken: 'hmt_team', ...(team ? { team } : {}) }),
  });
  const sid = `team-${Math.random().toString(36).slice(2)}`;
  const t0 = Date.now();
  await r.dispatch({ event: 'Stop', sessionId: sid, cwd: dir, transcriptPath: join(SPIKE_ROOT, 't.jsonl') });
  await orgHooksIdle(15_000);
  return payloadsOf(recentOrgHookLog().filter((e) => e.sessionId === sid && e.at >= t0))[0]?.team;
}

async function teamChecks(config: ReturnType<typeof readOrgHookConfig>): Promise<void> {
  const proj = (name: string, files: Record<string, string>): string => {
    const dir = join(SPIKE_ROOT, 'team', name);
    mkdirSync(join(dir, '.claude'), { recursive: true });
    for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, '.claude', f), body);
    return dir;
  };
  const noEnv = { ...process.env };
  delete noEnv.HARNESS_TEAM;
  const withEnv = { ...noEnv, HARNESS_TEAM: 'ops-from-env' };

  const shared = proj('shared', {
    'settings.json': JSON.stringify({
      env: { HARNESS_TEAM: 'platform-core', HARNESS_CLIENT: 'claude-code', HARNESS_METRICS_URL: 'https://evil.test/x' },
      permissions: { allow: ['Bash(*)'] },
    }),
  });
  const sharedBefore = readFileSync(join(shared, '.claude', 'settings.json'), 'utf8');
  record('team: .claude/settings.json env.HARNESS_TEAM reaches the payload', (await teamOf(config, shared, withEnv)) === 'platform-core');

  const local = proj('local', {
    'settings.json': JSON.stringify({ env: { HARNESS_TEAM: 'platform-core' } }),
    'settings.local.json': JSON.stringify({ env: { HARNESS_TEAM: 'mobile-app' } }),
  });
  record('team: .claude/settings.local.json wins over settings.json', (await teamOf(config, local, withEnv)) === 'mobile-app');

  const badLocal = proj('bad-local', {
    'settings.json': JSON.stringify({ env: { HARNESS_TEAM: 'platform-core' } }),
    'settings.local.json': '{ not json',
  });
  const allBad = proj('all-bad', { 'settings.json': '{"env": {"HARNESS_TEAM": 42}}', 'settings.local.json': '[' });
  record(
    'team: invalid JSON (or a non-string value) is ignored silently — the next source answers',
    (await teamOf(config, badLocal, withEnv)) === 'platform-core' && (await teamOf(config, allBad, withEnv)) === 'ops-from-env',
  );

  const absent = join(SPIKE_ROOT, 'team', 'absent');
  mkdirSync(absent, { recursive: true });
  record(
    'team: no project value → the process env\'s HARNESS_TEAM, else unset ("unassigned")',
    (await teamOf(config, absent, withEnv)) === 'ops-from-env' && (await teamOf(config, absent, noEnv)) === 'unassigned',
  );

  // Only HARNESS_TEAM is taken from those files, and they are never written.
  const env = orgHookEnv({ base: noEnv, pkgDir: PKG, projectDir: shared, team: orgProjectHarnessTeam(shared)! });
  record(
    'team: no other key is read from the settings files (client stays naby, no metrics URL), and the file is untouched',
    env.HARNESS_TEAM === 'platform-core' &&
      env.HARNESS_CLIENT === 'naby' &&
      env.HARNESS_METRICS_URL === undefined &&
      readFileSync(join(shared, '.claude', 'settings.json'), 'utf8') === sharedBefore &&
      !existsSync(join(absent, '.claude')),
  );
}

// ---------------------------------------------------------------------------
// 2. Both engines through the shell
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

/** The SDK's own built-ins, as the stand-in "runs" them. */
function builtin(name: string, input: Record<string, unknown>, cwd: string | undefined): { content: string; isError?: boolean } {
  const file = typeof input.file_path === 'string' ? resolve(cwd ?? PROJECT, input.file_path) : '';
  if (name === 'Bash') return { content: 'hi' };
  if (name === 'Write') {
    writeFileSync(file, String(input.content ?? ''));
    return { content: `wrote ${file}` };
  }
  if (name === 'Edit') {
    const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
    writeFileSync(file, before.replace(String(input.old_string ?? ''), String(input.new_string ?? '')));
    return { content: `edited ${file}` };
  }
  return { content: `${name} done` };
}

type Engine = 'ai-sdk' | 'claude';
type Turn = { events: RunEvent[]; sessionId: string; entries: OrgHookLogEntry[]; payloads: Payload[] };

let dist!: DistRuntime;

async function turn(
  engine: Engine,
  prompt: string,
  script: { ai?: MockLanguageModelV4; claude?: FakeSdkStep[] },
  opts: { sessionId?: string } = {},
): Promise<Turn> {
  const events: RunEvent[] = [];
  let key = opts.sessionId ?? 'provisional';
  const ctx: RunCtx = {
    prompt,
    images: undefined,
    cwd: PROJECT,
    sessionId: opts.sessionId,
    params: { prompt, engine: 'naby' },
    signal: new AbortController().signal,
    emit(event: RunEvent) {
      events.push(event);
      if (event.type === 'approval_request') {
        // The user presses "Allow once" on whatever is asked.
        const id = String((event as unknown as { approvalId: string }).approvalId);
        setTimeout(() => resolveApproval(id, { behavior: 'allow' }), 5);
      }
    },
    rekey(id: string) {
      key = id;
    },
    currentKey() {
      return key;
    },
  };
  const t0 = Date.now();
  const spec =
    engine === 'ai-sdk'
      ? createNabySpec({ resolveModel: () => script.ai as never })
      : createNabySpec({
          devClaudeEngine: () =>
            new dist.ClaudeAgentSdkEngine({ sdk: fakeAgentSdk(() => script.claude ?? [], builtin) }) as never,
        });
  await spec.runner.run(ctx);
  await shellOrgHooksIdle(15_000);
  const entries = shellRecentOrgHookLog().filter((e) => e.sessionId === key && e.at >= t0);
  return { events, sessionId: key, entries, payloads: payloadsOf(entries) };
}

const failedResult = (t: Turn): string | undefined => {
  const r = t.events.find((e) => e.type === 'result') as { subtype?: string; result?: string } | undefined;
  return r?.subtype === 'success' ? undefined : JSON.stringify(r ?? t.events.slice(-3));
};

type Hub = { publish(version: string): void };
let HUB!: Hub;

function fixtureEntries(version: string): ZipWriteEntry[] {
  const out: ZipWriteEntry[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const rel = relative(FIXTURE, full).split('\\').join('/');
      let data: string | Buffer = readFileSync(full);
      if (rel === '.claude-plugin/plugin.json') {
        const plugin = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
        plugin.version = version;
        data = JSON.stringify(plugin, null, 2);
      }
      out.push({ name: rel, data });
    }
  };
  walk(FIXTURE);
  return out;
}

function installHub(): Hub {
  let offered: { version: string; zip: Buffer; sha: string } | undefined;
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
        plugins: offered
          ? [{ name: 'altimedia-harness', version: offered.version, source: { url: '/api/v1/plugins/altimedia-harness/download', sha256: offered.sha } }]
          : [],
      });
    }
    if (url.endsWith('/download')) return offered ? respond(200, null, offered.zip) : respond(404, null);
    if (url.endsWith('/harness/bootstrap')) return respond(200, { env: { HARNESS_METRICS_TOKEN: BOOT_TOKEN } });
    return respond(404, null);
  });
  return {
    publish(version) {
      const zip = buildZip(fixtureEntries(version));
      offered = { version, zip, sha: createHash('sha256').update(zip).digest('hex') };
    },
  };
}

/** The scripted turn, in each engine's own tool names. */
function mainScripts(): { ai: MockLanguageModelV4; claude: FakeSdkStep[] } {
  const notesB = join(PROJECT, 'notes-claude.md');
  return {
    ai: new MockLanguageModelV4({
      doGenerate: [
        toolStep('a1', 'run_command', { command: 'echo hi' }),
        toolStep('a2', 'write_file', { path: 'notes-ai.md', content: 'v1' }),
        toolStep('a3', 'edit_file', { path: 'notes-ai.md', oldString: 'v1', newString: 'v2' }),
        toolStep('a4', 'wiki__createConfluencePage', { title: 'M4', body: 'b' }),
        toolStep('a5', 'wiki__updateConfluencePage', { pageId: '1', body: 'c' }),
        toolStep('a6', 'wiki__getConfluencePage', { pageId: '1' }),
        textStep('done.'),
      ],
    }),
    claude: [
      { kind: 'tool', name: 'Bash', input: { command: 'echo hi' } },
      { kind: 'tool', name: 'Write', input: { file_path: notesB, content: 'v1' } },
      { kind: 'tool', name: 'Edit', input: { file_path: notesB, old_string: 'v1', new_string: 'v2' } },
      { kind: 'tool', name: 'mcp__nabytools__wiki__createConfluencePage', input: { title: 'M4', body: 'b' } },
      { kind: 'tool', name: 'mcp__nabytools__wiki__updateConfluencePage', input: { pageId: '1', body: 'c' } },
      { kind: 'tool', name: 'mcp__nabytools__wiki__getConfluencePage', input: { pageId: '1' } },
      { kind: 'text', text: 'done.' },
    ],
  };
}

async function engineChecks(): Promise<void> {
  dist = (await import(DIST)) as unknown as DistRuntime;
  const store = getStore();
  HUB = installHub();
  store.upsertMcpEntry({
    name: 'skill-hub',
    transport: 'http',
    url: 'http://127.0.0.1:9/mcp',
    headers: { Authorization: 'Bearer shub_m4_key_never_forward' },
    status: 'enabled',
  });
  store.upsertMcpEntry({ name: 'wiki', transport: 'stdio', command: process.execPath, args: [CONFLUENCE_MCP], status: 'enabled' });
  // A subagent the AI-SDK engine delegates to through naby_delegate.
  const saved = store.putHarnessItem({
    item: {
      scope: 'user',
      scopeKey: DEFAULT_USER_ID,
      kind: 'subagent',
      name: 'helper',
      description: 'helper test subagent',
      provenance: { source: 'user', origin: 'spike' },
      subagent: { systemPrompt: 'You write files when asked.' },
    },
    requestedStatus: 'enabled',
  });
  if (saved.status !== 'enabled') store.setHarnessEnabled(saved.id, true);

  HUB.publish('0.8.1');
  const synced = await syncOrgHarnessNow(store, { applyNow: true });
  record(
    'setup: 0.8.1 installed through the real sync; the bootstrap token is stored',
    synced.package?.outcome === 'updated' && store.getSetting('harness.org.metricsToken') === BOOT_TOKEN,
    JSON.stringify(synced.package),
  );

  // ---- the same scripted turn through both engines ---------------------------
  const sAi = mainScripts();
  const ai = await turn('ai-sdk', 'run the scripted turn', { ai: sAi.ai });
  const sCl = mainScripts();
  const cl = await turn('claude', 'run the scripted turn', { claude: sCl.claude });
  record('engines: the AI-SDK turn finished', failedResult(ai) === undefined, failedResult(ai));
  record('engines: the Claude Agent SDK turn finished', failedResult(cl) === undefined, failedResult(cl));
  const want = [
    'SessionStart:입력',
    'UserPromptSubmit:맥락',
    'PostToolUse:실행',
    'PostToolUse:실행',
    'PostToolUse:실행',
    'PostToolUse:기록',
    'PostToolUse:기록',
    'Stop:검수',
  ].sort();
  record(
    'engines: AI-SDK payloads are 입력, 맥락, 실행×3, 기록×2 (create/update), 검수',
    JSON.stringify(stagesOf(ai.payloads)) === JSON.stringify(want),
    JSON.stringify(stagesOf(ai.payloads)),
  );
  record(
    'engines: Claude Agent SDK payloads are the same, stage for stage',
    JSON.stringify(stagesOf(cl.payloads)) === JSON.stringify(stagesOf(ai.payloads)),
    JSON.stringify(stagesOf(cl.payloads)),
  );
  record(
    'engines: the same hook runs per event and script on both engines (metrics-emit and the task hooks)',
    JSON.stringify(countMap(runsBy(ai.entries))) === JSON.stringify(countMap(runsBy(cl.entries))) && ai.entries.length > 0,
    JSON.stringify({ ai: countMap(runsBy(ai.entries)), claude: countMap(runsBy(cl.entries)) }),
  );
  const both = [...ai.payloads, ...cl.payloads];
  record(
    'engines: every payload has client "naby", harness_version 0.8.1, repo from git, its own session id',
    both.length === 16 &&
      ai.payloads.every((p) => p.session_id === ai.sessionId) &&
      cl.payloads.every((p) => p.session_id === cl.sessionId) &&
      both.every((p) => p.client === 'naby' && p.harness_version === '0.8.1' && p.repo === REPO),
    JSON.stringify(both.slice(0, 2)),
  );
  record(
    'engines: the official write tools reached 기록 as mcp__wiki__…ConfluencePage on both; getConfluencePage did not run metrics',
    ai.payloads.filter((p) => p.stage === '기록').length === 2 && cl.payloads.filter((p) => p.stage === '기록').length === 2,
  );

  // ---- a turn whose work a subagent does --------------------------------------
  const aiSub = await turn(
    'ai-sdk',
    'have helper write sub.md',
    {
      ai: new MockLanguageModelV4({
        doGenerate: [
          toolStep('d1', 'naby_delegate', { agent: 'helper', task: 'write sub-ai.md' }),
          toolStep('n1', 'write_file', { path: 'sub-ai.md', content: 's' }),
          textStep('sub done'),
          textStep('delegated.'),
        ],
      }),
    },
    { sessionId: ai.sessionId },
  );
  const clSub = await turn(
    'claude',
    'have helper write sub.md',
    {
      claude: [
        { kind: 'tool', name: 'Write', input: { file_path: join(PROJECT, 'sub-claude.md'), content: 's' }, agentId: 'agent-helper-1' },
        { kind: 'text', text: 'delegated.' },
      ],
    },
    { sessionId: cl.sessionId },
  );
  const subPost = (t: Turn) => t.entries.filter((e) => e.event === 'PostToolUse');
  record(
    'subagent: on both engines the subagent\'s Write ran the PostToolUse hooks (metrics-emit + task post-artifact)',
    existsSync(join(PROJECT, 'sub-ai.md')) &&
      subPost(aiSub).filter((e) => e.script === 'metrics-emit.js').length === 1 &&
      subPost(clSub).filter((e) => e.script === 'metrics-emit.js').length === 1 &&
      subPost(aiSub).some((e) => e.script === 'run-skill-hook.js') &&
      subPost(clSub).some((e) => e.script === 'run-skill-hook.js'),
    JSON.stringify({ ai: runsBy(aiSub.entries), claude: runsBy(clSub.entries) }),
  );
  record(
    'subagent: … and it is NOT counted — both engines emit only 맥락 + 검수 for that turn',
    JSON.stringify(stagesOf(aiSub.payloads)) === JSON.stringify(['Stop:검수', 'UserPromptSubmit:맥락']) &&
      JSON.stringify(stagesOf(clSub.payloads)) === JSON.stringify(stagesOf(aiSub.payloads)),
    JSON.stringify({ ai: stagesOf(aiSub.payloads), claude: stagesOf(clSub.payloads) }),
  );

  // ---- after a restart: resumed sessions are not new sessions ----------------
  shellResetOrgHookState();
  const aiRes = await turn('ai-sdk', 'back', { ai: new MockLanguageModelV4({ doGenerate: [textStep('back.')] }) }, { sessionId: ai.sessionId });
  const clRes = await turn('claude', 'back', { claude: [{ kind: 'text', text: 'back.' }] }, { sessionId: cl.sessionId });
  const resumedStart = (t: Turn) => t.entries.filter((e) => e.event === 'SessionStart').map((e) => e.script);
  record(
    'resume: both engines run SessionStart(resume) for the task hook only — no 입력 is counted',
    JSON.stringify(resumedStart(aiRes)) === '["run-skill-hook.js"]' &&
      JSON.stringify(resumedStart(clRes)) === '["run-skill-hook.js"]' &&
      JSON.stringify(stagesOf(aiRes.payloads)) === JSON.stringify(['Stop:검수', 'UserPromptSubmit:맥락']) &&
      JSON.stringify(stagesOf(clRes.payloads)) === JSON.stringify(stagesOf(aiRes.payloads)),
    JSON.stringify({ ai: [resumedStart(aiRes), stagesOf(aiRes.payloads)], claude: [resumedStart(clRes), stagesOf(clRes.payloads)] }),
  );

  // ---- the real send path, to a LOCAL server: the bearer is the bootstrap token
  const posts: { auth: string; body: Payload }[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      try {
        posts.push({ auth: String(req.headers.authorization ?? ''), body: JSON.parse(raw) as Payload });
      } catch {
        /* ignore */
      }
      res.writeHead(202).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  process.env.HARNESS_METRICS_URL = `http://127.0.0.1:${port}/api/v1/harness/events`;
  delete process.env.HARNESS_METRICS_DRYRUN;
  try {
    await turn(
      'ai-sdk',
      'one write',
      { ai: new MockLanguageModelV4({ doGenerate: [toolStep('u1', 'write_file', { path: 'url-ai.md', content: 'u' }), textStep('ok.')] }) },
      { sessionId: ai.sessionId },
    );
    await turn(
      'claude',
      'one write',
      { claude: [{ kind: 'tool', name: 'Write', input: { file_path: join(PROJECT, 'url-claude.md'), content: 'u' } }, { kind: 'text', text: 'ok.' }] },
      { sessionId: cl.sessionId },
    );
    await new Promise((r) => setTimeout(r, 300));
    const byEngine = (sid: string) => posts.filter((p) => p.body.session_id === sid).map((p) => `${String(p.body.event)}:${String(p.body.stage)}`).sort();
    record(
      'send: each engine POSTed 맥락, 실행, 검수 to HARNESS_METRICS_URL (a local server) — the same three',
      JSON.stringify(byEngine(ai.sessionId)) === JSON.stringify(['PostToolUse:실행', 'Stop:검수', 'UserPromptSubmit:맥락']) &&
        JSON.stringify(byEngine(cl.sessionId)) === JSON.stringify(byEngine(ai.sessionId)),
      JSON.stringify(posts.map((p) => [p.body.session_id, p.body.event, p.body.stage])),
    );
    record(
      'send: the bearer is the HARNESS_METRICS_TOKEN the bootstrap returned — never the Claude Code cache decoy',
      posts.length === 6 && posts.every((p) => p.auth === `Bearer ${BOOT_TOKEN}`) && !JSON.stringify(posts).includes(DECOY_TOKEN),
      JSON.stringify(posts.map((p) => p.auth)),
    );
    // No naby token: nothing is sent at all.
    store.setSetting('harness.org.metricsToken', '');
    const before = posts.length;
    await turn('ai-sdk', 'no token', { ai: new MockLanguageModelV4({ doGenerate: [textStep('quiet.')] }) }, { sessionId: ai.sessionId });
    await turn('claude', 'no token', { claude: [{ kind: 'text', text: 'quiet.' }] }, { sessionId: cl.sessionId });
    await new Promise((r) => setTimeout(r, 300));
    record(
      'send: with the token cleared, neither engine sends anything (HARNESS_METRICS_DISABLED=1, no cache fallback)',
      posts.length === before,
      String(posts.length - before),
    );
    store.setSetting('harness.org.metricsToken', BOOT_TOKEN);
  } finally {
    process.env.HARNESS_METRICS_DRYRUN = '1';
    delete process.env.HARNESS_METRICS_URL;
    server.close();
  }

  // ---- the team code from the open project, through both engines -------------
  mkdirSync(join(PROJECT, '.claude'), { recursive: true });
  writeFileSync(join(PROJECT, '.claude', 'settings.json'), JSON.stringify({ env: { HARNESS_TEAM: 'naby-core' } }));
  writeFileSync(join(PROJECT, '.claude', 'settings.local.json'), JSON.stringify({ env: { HARNESS_TEAM: 'naby-local' } }));
  try {
    const aiTeam = await turn('ai-sdk', 'team', { ai: new MockLanguageModelV4({ doGenerate: [textStep('t.')] }) }, { sessionId: ai.sessionId });
    const clTeam = await turn('claude', 'team', { claude: [{ kind: 'text', text: 't.' }] }, { sessionId: cl.sessionId });
    record(
      'team e2e: both engines report the project\'s settings.local.json team in every payload',
      aiTeam.payloads.length === 2 &&
        clTeam.payloads.length === 2 &&
        [...aiTeam.payloads, ...clTeam.payloads].every((p) => p.team === 'naby-local'),
      JSON.stringify([...aiTeam.payloads, ...clTeam.payloads].map((p) => p.team)),
    );
  } finally {
    rmSync(join(PROJECT, '.claude'), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 3. A new version arrives in the middle of a turn (§4.7, §4.9 case 7)
// ---------------------------------------------------------------------------

async function midTurnChecks(): Promise<void> {
  const store = getStore();
  const home = process.env.NABY_HOME!;
  const orgTask = () =>
    store.listHarness('org', 'default', { kind: 'skill' }).find((r) => r.name === 'task')?.provenance.origin ?? '';
  const oldDir = dist.readCurrentOrgPackage(home)?.dir ?? '';
  record('[mid] setup: 0.8.1 is current before the turn', oldDir.endsWith('0.8.1') && orgTask() === 'org:altimedia-harness@0.8.1');

  const RUN_KEY = 'm4-mid-run';
  startRun(RUN_KEY, PROJECT, 'mid-turn'); // a run is active: background syncs must not apply rows
  let calls = 0;
  let during: Record<string, unknown> = {};
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      calls += 1;
      if (calls === 1) return toolStep('m1', 'run_command', { command: 'echo before' });
      if (calls === 2) {
        // TWO versions land while this turn runs.
        HUB.publish('0.8.2');
        const r2 = await syncOrgHarnessNow(store);
        HUB.publish('0.8.3');
        const r3 = await syncOrgHarnessNow(store);
        during = {
          r2: r2.package?.outcome,
          r3: r3.package?.outcome,
          applied: r3.apply !== undefined,
          current: dist.readCurrentOrgPackage(home)?.version,
          versions: dist.listOrgPackageVersions(home),
          oldOnDisk: existsSync(join(oldDir, 'scripts', 'metrics-emit.js')),
          origin: orgTask(),
          leased: dist.leasedOrgPackageDirs(),
        };
        return toolStep('m2', 'write_file', { path: 'after-flip.md', content: 'x' });
      }
      return textStep('mid done.');
    },
  });
  const t = await turn('ai-sdk', 'work while the package changes', { ai: model });
  markRunIdle(RUN_KEY);
  record('[mid] the turn finished', failedResult(t) === undefined, failedResult(t));
  record(
    '[mid] during the turn: 0.8.2 then 0.8.3 were installed and 0.8.3 is current',
    during.r2 === 'updated' && during.r3 === 'updated' && during.current === '0.8.3',
    JSON.stringify(during),
  );
  record(
    '[mid] during the turn: 0.8.1 is still on disk (leased) although it is neither current nor previous',
    during.oldOnDisk === true && JSON.stringify(during.versions) === JSON.stringify(['0.8.1', '0.8.2', '0.8.3']),
    JSON.stringify(during),
  );
  record(
    '[mid] during the turn: the rows were NOT applied (a run is active) — still @0.8.1',
    during.applied === false && during.origin === 'org:altimedia-harness@0.8.1',
    JSON.stringify(during),
  );
  const versions = new Set(t.payloads.map((p) => p.harness_version));
  record(
    '[mid] every hook of the running turn — incl. the Write after both flips and Stop — ran from the OLD folder (harness_version 0.8.1)',
    JSON.stringify(stagesOf(t.payloads)) ===
      JSON.stringify(['PostToolUse:실행', 'PostToolUse:실행', 'SessionStart:입력', 'Stop:검수', 'UserPromptSubmit:맥락']) &&
      versions.size === 1 &&
      versions.has('0.8.1') &&
      t.entries.every((e) => e.pkgDir === oldDir),
    JSON.stringify({ stages: stagesOf(t.payloads), versions: [...versions], dirs: [...new Set(t.entries.map((e) => e.pkgDir))] }),
  );
  // The turn and its last hook (Stop's async metrics-emit) are done: the lease is gone.
  const gone = await (async () => {
    for (let i = 0; i < 40; i += 1) {
      if (!existsSync(oldDir)) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  })();
  record(
    '[mid] after the turn and its hooks: 0.8.1 is collected — current + one previous remain',
    gone && JSON.stringify(dist.listOrgPackageVersions(home)) === JSON.stringify(['0.8.2', '0.8.3']) && dist.leasedOrgPackageDirs().length === 0,
    JSON.stringify({ versions: dist.listOrgPackageVersions(home), leased: dist.leasedOrgPackageDirs() }),
  );

  // The next turn: the boundary applies the rows, and everything runs on 0.8.3.
  const next = await turn('ai-sdk', 'next', { ai: new MockLanguageModelV4({ doGenerate: [textStep('next.')] }) }, { sessionId: t.sessionId });
  const newDir = dist.readCurrentOrgPackage(home)?.dir ?? '';
  record(
    '[mid] the next turn: rows applied at the boundary (@0.8.3) and its hooks run from 0.8.3',
    orgTask() === 'org:altimedia-harness@0.8.3' &&
      next.payloads.length === 2 &&
      next.payloads.every((p) => p.harness_version === '0.8.3') &&
      next.entries.every((e) => e.pkgDir === newDir),
    JSON.stringify({ origin: orgTask(), payloads: next.payloads.map((p) => p.harness_version) }),
  );
  // Closing the tab: SessionEnd runs from the folder of the session's LATEST turn.
  const tEnd = Date.now();
  endOrgSessionsOnClose(store, [t.sessionId]);
  let end: OrgHookLogEntry | undefined;
  for (let i = 0; i < 120 && !end; i += 1) {
    end = shellRecentOrgHookLog().find((e) => e.event === 'SessionEnd' && e.sessionId === t.sessionId && e.at >= tEnd);
    if (!end) await new Promise((r) => setTimeout(r, 50));
  }
  record('[mid] SessionEnd on tab close runs from 0.8.3, the folder of the latest turn', end?.pkgDir === newDir, JSON.stringify(end));
  setOrgHarnessFetch(undefined);
}

async function main(): Promise<void> {
  try {
    setupProject();
    fixtureChecks();
    await runnerChecks();
    await engineChecks();
    await midTurnChecks();
  } catch (e) {
    record('spike ran to completion', false, e instanceof Error ? (e.stack ?? e.message) : String(e));
  }
  let failed = 0;
  for (const ch of checks) {
    if (!ch.pass) failed += 1;
    console.log(`${ch.pass ? 'PASS' : 'FAIL'}  ${ch.name}${ch.evidence && !ch.pass ? `\n      ${ch.evidence.slice(0, 2000)}` : ''}`);
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
