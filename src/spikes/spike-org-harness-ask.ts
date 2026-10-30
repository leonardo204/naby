// src/spikes/spike-org-harness-ask.ts
//
// ONE APPROVAL PROMPT PER DECISION (specs/org-harness-sync.md §7.10).
//
// When an org harness PreToolUse hook says `ask` and the user's policy rule says
// `ask` for the same call, the user gets ONE prompt carrying both reasons. Two
// prompts only when the hook rewrote the input (`updatedInput`) and the policy
// asks about the rewrite. Any deny wins with no prompt.
//
// NO NETWORK, NO REAL HOME. Temp NABY_HOME / NABY_DB_PATH / HOME, a fake Skill
// Hub (injected fetch), the fixture package whose stand-in `pre-commit.py` hook
// answers as a control file says, a mock model for the AI-SDK engine and the
// scripted Agent SDK stand-in for the Claude engine.
//
// WHAT IS ASSERTED:
//
//   parse      `updatedInput` is read with ask/allow, dropped with deny, ignored
//              when not an object; the launcher's hooks are labelled by skill
//              and hook file (`task/pre-commit.py`)
//   mapping    a hook's rewrite in Claude Code's spelling becomes naby's input
//              (run_command / write_file / edit_file); SDK built-ins pass through
//   merger     over the real `realPolicy`: both ask → 1 prompt ('hook+policy');
//              hook only → 1 ('hook'); policy only → 1 ('policy'); rewrite +
//              policy ask → 2 (original, then the rewrite); policy deny or a
//              denied first prompt → no further prompt; an allowed rewrite
//              carries `input`; parallel calls do not see each other's hook
//   engines    the same seven scenarios through the AI-SDK engine and the Claude
//              Agent SDK engine: the same prompts (who asked, which input) and the
//              same outcome (what ran) on both
//
// Prints PASS/FAIL per assertion; exits non-zero on any FAIL.

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Everything that resolves a home must see the temp one BEFORE any import runs.
const SPIKE_ROOT = mkdtempSync(join(tmpdir(), 'naby-spike-org-ask-'));
const FAKE_HOME = join(SPIKE_ROOT, 'user-home');
mkdirSync(FAKE_HOME, { recursive: true });
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
process.env.NABY_HOME = join(SPIKE_ROOT, 'naby-home');
process.env.NABY_DB_PATH = join(SPIKE_ROOT, 'naby-home', 'app.db');
mkdirSync(process.env.NABY_HOME, { recursive: true });
process.env.NABY_ORG_HARNESS_SYNC = '0';
process.env.HARNESS_GATE = '0';
process.env.HARNESS_METRICS_DRYRUN = '1';
delete process.env.HARNESS_METRICS_URL;
delete process.env.HARNESS_METRICS_TOKEN;
const HOOK_LOG = join(SPIKE_ROOT, 'hooks.jsonl');
const HOOK_CONTROL = join(SPIKE_ROOT, 'control.json');
process.env.NABY_SPIKE_HOOK_LOG = HOOK_LOG;
process.env.NABY_SPIKE_HOOK_CONTROL = HOOK_CONTROL;
writeFileSync(HOOK_LOG, '');
writeFileSync(HOOK_CONTROL, '{}');

import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import { createApprovalMerger, type ApprovalPromptRequest } from '../runtime/approval-merge.js';
import type { GateDecision, ToolCall } from '../runtime/engine.js';
import { fromClaudeToolInput, orgHookLabel, parseOrgHookOutput } from '../runtime/org-harness-hooks.js';
import { realPolicy } from '../runtime/policy.js';
import { DEFAULT_USER_ID } from '../runtime/memory-inject.js';
import { buildZip, type ZipWriteEntry } from '../runtime/zip.js';
import { fakeAgentSdk, type FakeSdkStep } from './fixtures/fake-agent-sdk.js';
import { createNabySpec, getStore } from '../../shell/packages/feature/agent/src/server/engines/naby.js';
import type { RunCtx, RunEvent } from '../../shell/packages/feature/agent/src/server/engines/types.js';
import { setOrgHarnessFetch, syncOrgHarnessNow } from '../../shell/packages/feature/agent/src/server/lib/orgHarness.js';
import { orgHooksIdle } from '../../shell/packages/feature/agent/src/server/lib/orgHarnessHooks.js';
import { resolveApproval } from '../../shell/packages/feature/agent/src/server/lib/approvalRegistry.js';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, evidence = ''): void {
  checks.push({ name, pass, evidence });
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = join(ROOT, 'src/spikes/fixtures/org-harness/altimedia-harness');
const PROJECT = join(SPIKE_ROOT, 'project');
const DIST = '../../dist/naby-runtime.mjs';

// ---------------------------------------------------------------------------
// 1. Parsing and mapping
// ---------------------------------------------------------------------------

function parseChecks(): void {
  const hso = (o: Record<string, unknown>) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...o } });
  const ask = parseOrgHookOutput('PreToolUse', hso({ permissionDecision: 'ask', updatedInput: { command: 'x' } }));
  const allow = parseOrgHookOutput('PreToolUse', hso({ permissionDecision: 'allow', updatedInput: { command: 'y' } }));
  const deny = parseOrgHookOutput('PreToolUse', hso({ permissionDecision: 'deny', updatedInput: { command: 'z' } }));
  const arr = parseOrgHookOutput('PreToolUse', hso({ permissionDecision: 'ask', updatedInput: ['no'] }));
  record(
    'parse: updatedInput kept with ask and allow, dropped with deny, ignored when not an object',
    JSON.stringify(ask.decision?.updatedInput) === '{"command":"x"}' &&
      JSON.stringify(allow.decision?.updatedInput) === '{"command":"y"}' &&
      deny.decision?.behavior === 'deny' &&
      deny.decision.updatedInput === undefined &&
      arr.decision?.behavior === 'ask' &&
      arr.decision.updatedInput === undefined,
    JSON.stringify({ ask, allow, deny, arr }),
  );
  const label = orgHookLabel({ script: 'run-skill-hook.js', args: ['/p/scripts/run-skill-hook.js', 'task', 'pre-commit.py'] });
  const ctx = orgHookLabel({
    script: 'run-skill-hook.js',
    args: ['/p/scripts/run-skill-hook.js', 'ctx', 'scripts/session-hook.py', '--timeout=25000'],
  });
  const plain = orgHookLabel({ script: 'metrics-emit.js', args: ['/p/scripts/metrics-emit.js'] });
  record(
    'parse: a skill hook is labelled by skill and hook file, other hooks by script',
    label === 'task/pre-commit.py' && ctx === 'ctx/session-hook.py' && plain === 'metrics-emit.js',
    JSON.stringify({ label, ctx, plain }),
  );

  const run = fromClaudeToolInput('run_command', { command: 'a', timeoutMs: 5 }, { command: 'b' });
  const write = fromClaudeToolInput('write_file', { path: 'x.md', content: '1' }, { file_path: '/abs/y.md', content: '2' });
  const edit = fromClaudeToolInput(
    'edit_file',
    { path: 'x.md', oldString: 'a', newString: 'b' },
    { file_path: '/abs/x.md', old_string: 'a', new_string: 'c', replace_all: true },
  );
  const bash = fromClaudeToolInput('Bash', { command: 'a' }, { command: 'b', description: 'd' });
  record(
    'mapping: a rewrite in Claude Code spelling becomes naby input; SDK built-ins pass through',
    JSON.stringify(run) === '{"command":"b","timeoutMs":5}' &&
      JSON.stringify(write) === '{"path":"/abs/y.md","content":"2"}' &&
      JSON.stringify(edit) === '{"path":"/abs/x.md","oldString":"a","newString":"c","replaceAll":true}' &&
      JSON.stringify(bash) === '{"command":"b","description":"d"}',
    JSON.stringify({ run, write, edit, bash }),
  );
}

// ---------------------------------------------------------------------------
// 2. The merger over the real policy
// ---------------------------------------------------------------------------

type Prompted = { askedBy: string; input: unknown; hook?: string; rewrittenBy?: string };

async function mergerChecks(): Promise<void> {
  const rule = (effect: 'ask' | 'deny' | 'allow') => [
    { id: 'r', scope: 'user' as const, scopeKey: 'u', toolPattern: 'run_command', effect, createdAt: 0, updatedAt: 0 },
  ];
  const run = async (opts: {
    effect?: 'ask' | 'deny' | 'allow';
    hook?: { behavior: 'ask' | 'allow'; reason?: string; updatedInput?: Record<string, unknown> };
    answer?: (i: number) => GateDecision;
    call?: ToolCall;
  }): Promise<{ prompts: Prompted[]; decision: GateDecision }> => {
    const prompts: Prompted[] = [];
    const merger = createApprovalMerger(async (req: ApprovalPromptRequest) => {
      prompts.push({
        askedBy: req.askedBy,
        input: req.call.input,
        ...(req.hook ? { hook: req.hook.script } : {}),
        ...(req.rewrittenBy ? { rewrittenBy: req.rewrittenBy } : {}),
      });
      return opts.answer ? opts.answer(prompts.length - 1) : { behavior: 'allow' };
    });
    const policy = merger.wrap(
      realPolicy({
        rules: opts.effect ? rule(opts.effect) : [],
        fallback: () => ({ behavior: 'allow' }),
        requestApproval: merger.policyAsk,
      }),
      () => (opts.hook ? { script: 'task/pre-commit.py', ...opts.hook } : undefined),
    );
    const call = opts.call ?? { toolCallId: 't1', toolName: 'run_command', input: { command: 'git commit' } };
    return { prompts, decision: await policy(call) };
  };
  const by = (p: Prompted[]) => p.map((x) => x.askedBy).join(',');

  const both = await run({ effect: 'ask', hook: { behavior: 'ask', reason: 'commit check' } });
  record(
    'merger: hook ask + policy ask → ONE prompt (hook+policy) naming the hook; allow',
    by(both.prompts) === 'hook+policy' && both.prompts[0]!.hook === 'task/pre-commit.py' && both.decision.behavior === 'allow',
    JSON.stringify(both),
  );
  const bothDeny = await run({ effect: 'ask', hook: { behavior: 'ask' }, answer: () => ({ behavior: 'deny', reason: 'no' }) });
  record('merger: the merged prompt denied → deny', by(bothDeny.prompts) === 'hook+policy' && bothDeny.decision.behavior === 'deny');
  const hookOnly = await run({ hook: { behavior: 'ask' } });
  record('merger: hook ask, no rule → ONE hook prompt', by(hookOnly.prompts) === 'hook' && hookOnly.decision.behavior === 'allow');
  const hookPolicyAllow = await run({ effect: 'allow', hook: { behavior: 'ask' } });
  record('merger: hook ask, policy rule allow → ONE hook prompt', by(hookPolicyAllow.prompts) === 'hook');
  const policyOnly = await run({ effect: 'ask' });
  record('merger: policy ask, no hook → ONE policy prompt', by(policyOnly.prompts) === 'policy');
  const pDeny = await run({ effect: 'deny', hook: { behavior: 'ask' } });
  record(
    'merger: hook ask + policy deny → NO prompt, deny',
    pDeny.prompts.length === 0 && pDeny.decision.behavior === 'deny',
    JSON.stringify(pDeny),
  );
  const rw = await run({ effect: 'ask', hook: { behavior: 'ask', updatedInput: { command: 'git commit -n' } } });
  record(
    'merger: hook ask + rewrite + policy ask → TWO prompts: hook on the original, policy on the rewrite; allow carries the rewrite',
    by(rw.prompts) === 'hook,policy' &&
      JSON.stringify(rw.prompts[0]!.input) === '{"command":"git commit"}' &&
      JSON.stringify(rw.prompts[1]!.input) === '{"command":"git commit -n"}' &&
      rw.prompts[1]!.rewrittenBy === 'task/pre-commit.py' &&
      rw.decision.behavior === 'allow' &&
      JSON.stringify(rw.decision.input) === '{"command":"git commit -n"}',
    JSON.stringify(rw),
  );
  const rwDeny = await run({
    effect: 'ask',
    hook: { behavior: 'ask', updatedInput: { command: 'git commit -n' } },
    answer: () => ({ behavior: 'deny', reason: 'no' }),
  });
  record('merger: rewrite case, first prompt denied → no second prompt, deny', by(rwDeny.prompts) === 'hook' && rwDeny.decision.behavior === 'deny');
  const sameRw = await run({ effect: 'ask', hook: { behavior: 'ask', updatedInput: { command: 'git commit' } } });
  record(
    'merger: an "updatedInput" equal to the original is no rewrite → ONE merged prompt',
    by(sameRw.prompts) === 'hook+policy' && sameRw.decision.behavior === 'allow' && !('input' in sameRw.decision),
    JSON.stringify(sameRw),
  );
  const rwOnly = await run({ hook: { behavior: 'allow', updatedInput: { command: 'git commit -n' } } });
  record(
    'merger: hook allow + rewrite, policy allows → no prompt, the rewrite runs',
    rwOnly.prompts.length === 0 && rwOnly.decision.behavior === 'allow' && JSON.stringify(rwOnly.decision.input) === '{"command":"git commit -n"}',
    JSON.stringify(rwOnly),
  );
  const rwOnlyAsk = await run({ effect: 'ask', hook: { behavior: 'allow', updatedInput: { command: 'git commit -n' } } });
  record(
    'merger: hook allow + rewrite, policy ask → ONE policy prompt on the rewrite, marked rewritten',
    by(rwOnlyAsk.prompts) === 'policy' && rwOnlyAsk.prompts[0]!.rewrittenBy === 'task/pre-commit.py',
    JSON.stringify(rwOnlyAsk),
  );

  // Parallel calls: only the call the hook asked about is merged.
  const prompts: ApprovalPromptRequest[] = [];
  const merger = createApprovalMerger(async (req) => {
    prompts.push(req);
    await new Promise((r) => setTimeout(r, 10));
    return { behavior: 'allow' };
  });
  const policy = merger.wrap(
    realPolicy({ rules: rule('ask'), fallback: () => ({ behavior: 'allow' }), requestApproval: merger.policyAsk }),
    (c) => (c.toolCallId === 'pa' ? { behavior: 'ask', script: 'task/pre-commit.py' } : undefined),
  );
  await Promise.all([
    policy({ toolCallId: 'pa', toolName: 'run_command', input: { command: 'a' } }),
    policy({ toolCallId: 'pb', toolName: 'run_command', input: { command: 'b' } }),
  ]);
  const seen = prompts.map((p) => `${p.call.toolCallId}:${p.askedBy}`).sort().join(',');
  record('merger: parallel calls each get their own prompt kind', seen === 'pa:hook+policy,pb:policy', seen);
}

// ---------------------------------------------------------------------------
// 3. Both engines through the shell
// ---------------------------------------------------------------------------

const USAGE = {
  inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 7, text: 7, reasoning: 0 },
};
const toolStep = (id: string, toolName: string, input: Record<string, unknown>): LanguageModelV4GenerateResult => ({
  content: [{ type: 'tool-call', toolCallId: id, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls', raw: 'tool_use' },
  usage: USAGE,
  warnings: [],
});
const textStep = (text: string): LanguageModelV4GenerateResult => ({
  content: [{ type: 'text', text }],
  finishReason: { unified: 'stop', raw: 'end_turn' },
  usage: USAGE,
  warnings: [],
});

type Engine = 'ai-sdk' | 'claude';
type DistRuntime = { ClaudeAgentSdkEngine: new (opts?: { sdk?: unknown }) => unknown };
let dist!: DistRuntime;

type Seen = { prompts: { askedBy: string; command: string; hook?: string; rewrittenBy?: string }[]; ran: string[]; ok: boolean };

async function engineTurn(engine: Engine, command: string, answer: 'allow' | 'deny'): Promise<Seen> {
  const events: RunEvent[] = [];
  const prompts: Seen['prompts'] = [];
  const claudeRan: string[] = [];
  let key = 'provisional';
  const ctx: RunCtx = {
    prompt: 'run it',
    images: undefined,
    cwd: PROJECT,
    sessionId: undefined,
    params: { prompt: 'run it', engine: 'naby' },
    signal: new AbortController().signal,
    emit(event: RunEvent) {
      events.push(event);
      if (event.type !== 'approval_request') return;
      const e = event as unknown as Record<string, unknown>;
      prompts.push({
        askedBy: typeof e.source === 'string' ? e.source : 'policy',
        command: String((e.input as { command?: unknown } | undefined)?.command ?? ''),
        ...(typeof e.hook_script === 'string' ? { hook: e.hook_script } : {}),
        ...(typeof e.rewritten_by === 'string' ? { rewrittenBy: e.rewritten_by } : {}),
      });
      const id = String(e.approvalId);
      setTimeout(() => resolveApproval(id, answer === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', reason: 'no' }), 5);
    },
    rekey(id: string) {
      key = id;
    },
    currentKey() {
      return key;
    },
  };
  const spec =
    engine === 'ai-sdk'
      ? createNabySpec({
          resolveModel: () =>
            new MockLanguageModelV4({ doGenerate: [toolStep('c1', 'run_command', { command }), textStep('done.')] }) as never,
        })
      : createNabySpec({
          devClaudeEngine: () =>
            new dist.ClaudeAgentSdkEngine({
              sdk: fakeAgentSdk(
                (): FakeSdkStep[] => [{ kind: 'tool', name: 'Bash', input: { command } }, { kind: 'text', text: 'done.' }],
                (name, input) => {
                  if (name === 'Bash') claudeRan.push(String(input.command ?? ''));
                  return { content: `ran ${String(input.command ?? '')}` };
                },
              ),
            }) as never,
        });
  await spec.runner.run(ctx);
  await orgHooksIdle(15_000);
  const result = events.find((e) => e.type === 'result') as { subtype?: string } | undefined;
  // What actually ran: the AI-SDK engine's run_command really runs `echo`, so
  // its output shows up in a tool_result; the stand-in records the SDK's Bash.
  const aiRan = events
    .filter((e) => e.type === 'user')
    .map((e) => JSON.stringify(e))
    .flatMap((s) => (s.match(/m710-[a-z-]+/g) ?? []).filter(() => !s.includes('Not run:')));
  return {
    prompts,
    ran: engine === 'claude' ? claudeRan.map((c) => c.replace(/^echo /, '')) : [...new Set(aiRan)],
    ok: result?.subtype === 'success',
  };
}

function fixtureZip(): Buffer {
  const out: ZipWriteEntry[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push({ name: relative(FIXTURE, full).split('\\').join('/'), data: readFileSync(full) });
    }
  };
  walk(FIXTURE);
  return buildZip(out);
}

async function engineChecks(): Promise<void> {
  dist = (await import(DIST)) as unknown as DistRuntime;
  mkdirSync(PROJECT, { recursive: true });
  const store = getStore();
  const zip = fixtureZip();
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
      return respond(200, { plugins: [{ name: 'altimedia-harness', version: '0.8.1', source: { url: '/dl', sha256: sha } }] });
    }
    if (url.endsWith('/dl')) return respond(200, null, zip);
    if (url.endsWith('/harness/bootstrap')) return respond(200, { env: { HARNESS_METRICS_TOKEN: 'hmt_ask' } });
    return respond(404, null);
  });
  store.upsertMcpEntry({
    name: 'skill-hub',
    transport: 'http',
    url: 'http://127.0.0.1:9/mcp',
    headers: { Authorization: 'Bearer shub_ask_key' },
    status: 'enabled',
  });
  const synced = await syncOrgHarnessNow(store, { applyNow: true });
  record('engines setup: the fixture package installed through the real sync', synced.package?.outcome === 'updated', JSON.stringify(synced.package));

  const setRules = (effect: 'ask' | 'deny' | undefined): void => {
    for (const r of store.listPolicyRules('user', DEFAULT_USER_ID)) store.removePolicyRule(r.id);
    if (!effect) return;
    // The same rule in each engine's spelling of the shell tool.
    store.putPolicyRule({ scope: 'user', scopeKey: DEFAULT_USER_ID, toolPattern: 'run_command', effect });
    store.putPolicyRule({ scope: 'user', scopeKey: DEFAULT_USER_ID, toolPattern: 'Bash', effect });
  };
  const hookSays = (out: Record<string, unknown> | undefined): void =>
    writeFileSync(
      HOOK_CONTROL,
      JSON.stringify(out ? { 'pre-commit.py': { stdout: { hookSpecificOutput: { hookEventName: 'PreToolUse', ...out } } } } : {}),
    );

  type Scenario = {
    name: string;
    rule?: 'ask' | 'deny';
    hook?: Record<string, unknown>;
    command: string;
    answer?: 'allow' | 'deny';
    want: { prompts: string; ran: string };
  };
  const ASK = { permissionDecision: 'ask', permissionDecisionReason: 'commit check' };
  const scenarios: Scenario[] = [
    {
      name: 'both ask → ONE merged prompt; allowed, it runs',
      rule: 'ask',
      hook: ASK,
      command: 'echo m710-both',
      want: { prompts: 'hook+policy:echo m710-both', ran: 'm710-both' },
    },
    {
      name: 'both ask, denied → ONE prompt, nothing runs',
      rule: 'ask',
      hook: ASK,
      command: 'echo m710-bothno',
      answer: 'deny',
      want: { prompts: 'hook+policy:echo m710-bothno', ran: '' },
    },
    { name: 'hook ask only → ONE hook prompt', hook: ASK, command: 'echo m710-hook', want: { prompts: 'hook:echo m710-hook', ran: 'm710-hook' } },
    { name: 'policy ask only → ONE policy prompt', rule: 'ask', command: 'echo m710-pol', want: { prompts: 'policy:echo m710-pol', ran: 'm710-pol' } },
    {
      name: 'hook ask + updatedInput + policy ask → TWO prompts (original, then rewrite); the rewrite runs',
      rule: 'ask',
      hook: { ...ASK, updatedInput: { command: 'echo m710-rewritten' } },
      command: 'echo m710-original',
      want: { prompts: 'hook:echo m710-original|policy:echo m710-rewritten', ran: 'm710-rewritten' },
    },
    { name: 'hook ask + policy deny → NO prompt, nothing runs', rule: 'deny', hook: ASK, command: 'echo m710-pdeny', want: { prompts: '', ran: '' } },
    {
      name: 'hook deny + policy ask → NO prompt, nothing runs',
      rule: 'ask',
      hook: { permissionDecision: 'deny', permissionDecisionReason: 'no commits' },
      command: 'echo m710-hdeny',
      want: { prompts: '', ran: '' },
    },
  ];

  for (const sc of scenarios) {
    const seen: Record<Engine, Seen> = {} as Record<Engine, Seen>;
    for (const engine of ['ai-sdk', 'claude'] as const) {
      setRules(sc.rule);
      hookSays(sc.hook);
      seen[engine] = await engineTurn(engine, sc.command, sc.answer ?? 'allow');
    }
    const shape = (s: Seen) => ({
      prompts: s.prompts.map((p) => `${p.askedBy}:${p.command}`).join('|'),
      ran: s.ran.join(','),
    });
    const a = shape(seen['ai-sdk']);
    const c = shape(seen.claude);
    const hookNamed = seen['ai-sdk'].prompts
      .concat(seen.claude.prompts)
      .every((p) => p.askedBy === 'policy' ? (p.rewrittenBy ?? 'task/pre-commit.py') === 'task/pre-commit.py' : p.hook === 'task/pre-commit.py');
    record(
      `engines: ${sc.name} — AI-SDK`,
      seen['ai-sdk'].ok && a.prompts === sc.want.prompts && a.ran === sc.want.ran && hookNamed,
      JSON.stringify(seen['ai-sdk']),
    );
    record(
      `engines: ${sc.name} — Claude Agent SDK, same as AI-SDK`,
      seen.claude.ok && c.prompts === sc.want.prompts && c.ran === sc.want.ran && JSON.stringify(c) === JSON.stringify(a),
      JSON.stringify(seen.claude),
    );
  }
  setRules(undefined);
  hookSays(undefined);
  setOrgHarnessFetch(undefined);
}

async function main(): Promise<void> {
  try {
    parseChecks();
    await mergerChecks();
    await engineChecks();
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
