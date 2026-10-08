// src/spikes/spike-org-harness-gate.ts
//
// ORG HARNESS M3 — the Atlassian gate, the grace period, the dependency check and
// the API-token → OAuth swap (specs/org-harness-sync.md §3.6, §4.4, §4.6; the
// migration cases 9–11 of §4.9).
//
// NO NETWORK, NO REAL HOME: a temp NABY_HOME + NABY_DB_PATH; the dependency check
// runs against a fake command runner; the end-to-end part drives the shell's naby
// engine with a mock model and a fake Skill Hub.
//
// WHAT IS ASSERTED:
//
//   gate     off / no package / HARNESS_GATE=0 never block; a fresh install is
//            blocked as soon as the package is there; signed in is "ready" and the
//            confirmation is cached for a day; a `/` command is not blocked, an
//            org skill's `/task` is
//   grace    (case 9) an upgrade gets 7 days (the setting is honoured); during it
//            nothing is blocked and the days are counted down; after it only
//            sessions STARTED after the block began are blocked
//   deps     Python 3 + PyYAML: found / missing, `py -3` on Windows, a passing
//            check cached for a day and a failing one redone
//   swap     (case 10) before the sign-in the API-token row is untouched and still
//            what a turn loads; after it the same-name row is http + OAuth with no
//            token left anywhere, and the rules/harness rows naming old tool
//            spellings are counted (new spellings are not); idempotent; an
//            agent-proposed row is never swapped
//   withdraw (case 11) an untouched `confluence-upload` becomes `removed` with origin
//            `builtin-withdrawn:…`; a toggled one, an edited one and a deleted one
//            are left as they are
//   turn     through the shell engine: a blocked prompt answers with the
//            `atlassian-required` pill and an error result, mints no session, and
//            never reaches the model; a new session during the grace gets the
//            `atlassian-grace:<n>` pill; a legacy row gets `atlassian-migrate`
//
// Prints PASS/FAIL per assertion; exits non-zero on any FAIL.

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SPIKE_ROOT = mkdtempSync(join(tmpdir(), 'naby-spike-org-gate-'));
process.env.NABY_HOME = SPIKE_ROOT;
process.env.NABY_DB_PATH = join(SPIKE_ROOT, 'app.db');
process.env.NABY_ORG_HARNESS_SYNC = '0';
delete process.env.HARNESS_GATE;

import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import {
  applyAtlassianOAuthSwapIfDue,
  atlassianRowShape,
  BUILTIN_WITHDRAWN_ORIGIN_PREFIX,
  CONFLUENCE_UPLOAD_SKILL,
  withdrawBuiltinConfluenceUpload,
} from '../runtime/atlassian-migration.js';
import { builtinHarnessAutoStatusKey, builtinHarnessOrigin, harnessAssetBody } from '../runtime/harness-seed.js';
import { DEFAULT_USER_ID } from '../runtime/memory-inject.js';
import { writeMcpOAuthRecord } from '../runtime/mcp-oauth.js';
import {
  checkOrgHarnessDeps,
  DAY_MS,
  evaluateOrgAtlassianGate,
  ORG_GATE_SETTING,
  orgGateBlockFrom,
  readOrgDeps,
  type OrgDepsRunner,
} from '../runtime/org-harness-gate.js';
import { SqliteStore } from '../runtime/store/sqlite-store.js';
import type { McpEntry } from '../runtime/store/store.js';
import { buildZip, type ZipWriteEntry } from '../runtime/zip.js';
import { createNabySpec, getStore } from '../../shell/packages/feature/agent/src/server/engines/naby.js';
import type { RunCtx, RunEvent } from '../../shell/packages/feature/agent/src/server/engines/types.js';
import { setOrgHarnessFetch, syncOrgHarnessNow } from '../../shell/packages/feature/agent/src/server/lib/orgHarness.js';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, evidence = ''): void {
  checks.push({ name, pass, evidence });
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = join(ROOT, 'src/spikes/fixtures/org-harness/altimedia-harness');
const SHIPPED_UPLOAD = readFileSync(join(ROOT, 'src/spikes/fixtures/atlassian/confluence-upload-shipped-SKILL.md'), 'utf8');

let caseNo = 0;
function freshStore(): SqliteStore {
  caseNo += 1;
  const dir = join(SPIKE_ROOT, `case-${caseNo}`);
  mkdirSync(dir, { recursive: true });
  return new SqliteStore({ path: join(dir, 'app.db') });
}

function signIn(store: SqliteStore): void {
  writeMcpOAuthRecord(store, 'atlassian', {
    v: 1,
    state: 'ok',
    client: { client_id: 'client_spike', redirect_uri: 'http://127.0.0.1:1/oauth/callback' },
    tokens: { access_token: 'at', token_type: 'Bearer', refresh_token: 'rt', obtained_at: Date.now() },
  });
}

// ---------------------------------------------------------------------------
// gate + grace
// ---------------------------------------------------------------------------

function gateChecks(): void {
  const T0 = Date.UTC(2026, 9, 8, 0, 0, 0);
  const base = { on: true, packagePresent: true, env: {}, hasPriorSessions: () => false };

  {
    const s = freshStore();
    const off = evaluateOrgAtlassianGate(s, { ...base, on: false, now: T0 });
    const noPkg = evaluateOrgAtlassianGate(s, { ...base, packagePresent: false, now: T0 });
    const env = evaluateOrgAtlassianGate(s, { ...base, env: { HARNESS_GATE: '0' }, now: T0 });
    record(
      'gate: org harness off, no package, or HARNESS_GATE=0 → never blocks and arms nothing',
      !off.block && off.why === 'off' && !noPkg.block && noPkg.why === 'no-package' && !env.block && env.why === 'env-off' &&
        s.getSetting(ORG_GATE_SETTING.graceStartedAt) === undefined,
      JSON.stringify({ off, noPkg, env }),
    );
    s.close();
  }
  {
    const s = freshStore();
    const v = evaluateOrgAtlassianGate(s, { ...base, now: T0 });
    record(
      'gate: a FRESH install (no prior conversations) is blocked as soon as the package is there',
      v.block && s.getSetting(ORG_GATE_SETTING.graceKind) === 'new',
      JSON.stringify(v),
    );
    const cmd = evaluateOrgAtlassianGate(s, { ...base, now: T0, rawPrompt: '/clear', namesOrgSkill: false });
    const skill = evaluateOrgAtlassianGate(s, { ...base, now: T0, rawPrompt: '/task start', namesOrgSkill: true });
    record(
      'gate: a `/` naby command is not blocked; an org skill\'s `/task` is',
      !cmd.block && cmd.why === 'command' && skill.block,
      JSON.stringify({ cmd, skill }),
    );
    signIn(s);
    const ready = evaluateOrgAtlassianGate(s, { ...base, now: T0 + 1000 });
    record('gate: signed in → ready, and the confirmation is stamped', !ready.block && ready.why === 'ready' && s.getSetting(ORG_GATE_SETTING.okAt) === String(T0 + 1000));
    // The sign-in dies an hour later: still ready for the rest of the day (gate.js cache).
    writeMcpOAuthRecord(s, 'atlassian', { v: 1, state: 'relogin', reloginReason: 'invalid_grant' });
    const cached = evaluateOrgAtlassianGate(s, { ...base, now: T0 + 60 * 60 * 1000 });
    const nextDay = evaluateOrgAtlassianGate(s, { ...base, now: T0 + DAY_MS + 2000 });
    record(
      'gate: a confirmed sign-in is not re-checked for a day; the day after, a dead one blocks again',
      !cached.block && cached.why === 'ready' && nextDay.block && nextDay.atlassian === 'relogin',
      JSON.stringify({ cached, nextDay }),
    );
    s.close();
  }
  {
    // CASE 9 — an UPGRADE: grace, then only new sessions.
    const s = freshStore();
    const upgrade = { ...base, hasPriorSessions: () => true };
    const day0 = evaluateOrgAtlassianGate(s, { ...upgrade, now: T0 });
    const day3 = evaluateOrgAtlassianGate(s, { ...upgrade, now: T0 + 3 * DAY_MS });
    record(
      'grace (case 9): an existing install is not blocked for 7 days, and the days count down',
      !day0.block && day0.why === 'grace' && day0.graceDaysLeft === 7 && !day3.block && day3.graceDaysLeft === 4 &&
        s.getSetting(ORG_GATE_SETTING.graceKind) === 'upgrade' &&
        s.getSetting(ORG_GATE_SETTING.graceStartedAt) === String(T0),
      JSON.stringify({ day0, day3 }),
    );
    const blockFrom = orgGateBlockFrom(s)!;
    const oldSession = evaluateOrgAtlassianGate(s, { ...upgrade, now: T0 + 8 * DAY_MS, sessionCreatedAt: T0 + 2 * DAY_MS });
    const newSession = evaluateOrgAtlassianGate(s, { ...upgrade, now: T0 + 8 * DAY_MS });
    const lateSession = evaluateOrgAtlassianGate(s, { ...upgrade, now: T0 + 8 * DAY_MS, sessionCreatedAt: blockFrom + 1 });
    record(
      'grace (case 9): after 7 days a session already in progress is NOT blocked; new sessions are',
      !oldSession.block && oldSession.why === 'in-progress-session' && newSession.block && lateSession.block &&
        blockFrom === T0 + 7 * DAY_MS,
      JSON.stringify({ oldSession, newSession, lateSession, blockFrom }),
    );
    s.close();
  }
  {
    const s = freshStore();
    s.setSetting(ORG_GATE_SETTING.graceDays, '3');
    const v = evaluateOrgAtlassianGate(s, { ...base, hasPriorSessions: () => true, now: T0 });
    const after = evaluateOrgAtlassianGate(s, { ...base, hasPriorSessions: () => true, now: T0 + 3 * DAY_MS + 1 });
    record('grace: the length is a setting (3 days here)', !v.block && v.graceDaysLeft === 3 && after.block, JSON.stringify({ v, after }));
    s.close();
  }
}

// ---------------------------------------------------------------------------
// deps
// ---------------------------------------------------------------------------

async function depsChecks(): Promise<void> {
  const fake = (have: { python3?: string; py?: string; python?: string; yaml?: boolean }): { run: OrgDepsRunner; calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      run: async (cmd, args) => {
        calls.push([cmd, ...args].join(' '));
        const isYaml = args.includes('import yaml');
        const version = cmd === 'python3' ? have.python3 : cmd === 'py' ? have.py : cmd === 'python' ? have.python : undefined;
        if (!version) return { code: 1, stdout: '' };
        if (isYaml) return { code: have.yaml ? 0 : 1, stdout: '' };
        return { code: 0, stdout: `${version}\n` };
      },
    };
  };
  const T0 = Date.UTC(2026, 9, 8);
  {
    const s = freshStore();
    const f = fake({ python3: '3.12.1', yaml: false });
    const r = await checkOrgHarnessDeps(s, { now: T0, run: f.run, env: {}, platform: 'darwin' });
    record('deps: Python 3 found, PyYAML missing — recorded for the Settings card', r.python === '3.12.1' && !r.pyyaml && readOrgDeps(s)?.pyyaml === false, JSON.stringify(r));
    const f2 = fake({ python3: '3.12.1', yaml: true });
    const again = await checkOrgHarnessDeps(s, { now: T0 + 1000, run: f2.run, env: {}, platform: 'darwin' });
    record('deps: a FAILING check is redone at the next session start', again.pyyaml === true && f2.calls.length > 0, JSON.stringify(again));
    const f3 = fake({});
    const cached = await checkOrgHarnessDeps(s, { now: T0 + 2000, run: f3.run, env: {}, platform: 'darwin' });
    record('deps: a PASSING check is reused for a day (no commands run)', cached.pyyaml === true && f3.calls.length === 0);
    s.close();
  }
  {
    const s = freshStore();
    const f = fake({ py: '3.11.0', yaml: true });
    const r = await checkOrgHarnessDeps(s, { now: T0, run: f.run, env: {}, platform: 'win32' });
    record(
      'deps: on Windows `py -3` is tried (run-skill-hook.js\'s order) and found',
      r.python === '3.11.0' && r.pythonCommand === 'py -3' && f.calls.some((c) => c.startsWith('py -3')),
      JSON.stringify({ r, calls: f.calls }),
    );
    const none = freshStore();
    const n = await checkOrgHarnessDeps(none, { now: T0, run: fake({}).run, env: {}, platform: 'linux' });
    record('deps: no Python at all → python null, pyyaml false (nothing blocks)', n.python === null && !n.pyyaml, JSON.stringify(n));
    s.close();
    none.close();
  }
}

// ---------------------------------------------------------------------------
// swap (case 10) + withdraw (case 11)
// ---------------------------------------------------------------------------

const LEGACY: McpEntry = {
  name: 'atlassian',
  transport: 'stdio',
  command: '/usr/local/bin/uvx',
  args: ['mcp-atlassian'],
  env: {
    CONFLUENCE_URL: 'https://altimedia.atlassian.net/wiki',
    CONFLUENCE_USERNAME: 'me@altimedia.com',
    CONFLUENCE_API_TOKEN: 'ATATT_legacy_api_token_must_go',
  },
  status: 'enabled',
};

function seedShippedUpload(s: SqliteStore, opts: { status: 'enabled' | 'disabled'; autoStatus: string; body?: string }): void {
  s.putHarnessItem({
    item: {
      scope: 'user',
      scopeKey: DEFAULT_USER_ID,
      kind: 'skill',
      name: CONFLUENCE_UPLOAD_SKILL,
      description: 'upload',
      provenance: { source: 'artifact', origin: builtinHarnessOrigin(CONFLUENCE_UPLOAD_SKILL), format: 'claude-skill-md' },
      skill: { instructions: opts.body ?? harnessAssetBody(SHIPPED_UPLOAD), triggers: ['confluence'], toolRefs: ['run_command'] },
    },
    requestedStatus: opts.status,
  });
  s.setSetting(builtinHarnessAutoStatusKey(CONFLUENCE_UPLOAD_SKILL), opts.autoStatus);
}

const uploadRow = (s: SqliteStore) =>
  s.listHarness('user', DEFAULT_USER_ID, { kind: 'skill' }).find((r) => r.name === CONFLUENCE_UPLOAD_SKILL);

function swapChecks(): void {
  {
    const s = freshStore();
    s.upsertMcpEntry(LEGACY);
    seedShippedUpload(s, { status: 'disabled', autoStatus: 'disabled' });
    s.putPolicyRule({ scope: 'user', scopeKey: DEFAULT_USER_ID, toolPattern: 'atlassian__confluence_get_page', effect: 'allow' });
    s.putPolicyRule({ scope: 'user', scopeKey: DEFAULT_USER_ID, toolPattern: 'atlassian__getConfluencePage', effect: 'allow' });
    s.putHarnessItem({
      item: {
        scope: 'user',
        scopeKey: DEFAULT_USER_ID,
        kind: 'subagent',
        name: 'wiki-writer',
        provenance: { source: 'user' },
        subagent: { systemPrompt: 'Write pages.', toolRefs: ['mcp__atlassian__confluence_create_page'] },
      },
      requestedStatus: 'enabled',
    });

    const before = applyAtlassianOAuthSwapIfDue(s);
    record(
      'swap (case 10): before the sign-in the API-token row is left exactly as it is ("OAuth 전환 대기")',
      before === undefined && atlassianRowShape(s) === 'legacy' &&
        JSON.stringify(s.listMcpEntries().find((e) => e.name === 'atlassian')) === JSON.stringify(LEGACY),
    );
    signIn(s);
    const report = applyAtlassianOAuthSwapIfDue(s, { now: 42 });
    const row = s.listMcpEntries().find((e) => e.name === 'atlassian');
    const everything = JSON.stringify(s.listMcpEntries());
    record(
      'swap (case 10): after the sign-in the SAME-NAME row is http + OAuth to the official MCP',
      row?.transport === 'http' && row.auth === 'oauth' && row.url === 'https://mcp.atlassian.com/v1/mcp' && atlassianRowShape(s) === 'oauth',
      JSON.stringify(row),
    );
    record(
      'swap (case 10): no API token, account or Confluence URL is left in the registry',
      !everything.includes('ATATT_legacy') && !everything.includes('CONFLUENCE_') && !everything.includes('me@altimedia.com'),
      everything,
    );
    const refs = (report?.legacyRefs ?? []).map((r) => `${r.kind}:${r.ref}`).sort();
    record(
      'swap (case 10): rules and harness rows still naming OLD tool spellings are counted, new ones are not',
      report?.from === 'legacy' &&
        refs.length === 2 &&
        refs.includes('policy:atlassian__confluence_get_page') &&
        refs.includes('subagent:mcp__atlassian__confluence_create_page'),
      JSON.stringify(refs),
    );
    record(
      'withdraw (case 11): an untouched confluence-upload becomes removed with origin builtin-withdrawn',
      report?.confluenceUpload === 'withdrawn' &&
        uploadRow(s)?.status === 'removed' &&
        (uploadRow(s)?.provenance.origin ?? '').startsWith(BUILTIN_WITHDRAWN_ORIGIN_PREFIX),
      JSON.stringify(uploadRow(s)),
    );
    const again = applyAtlassianOAuthSwapIfDue(s);
    record('swap: idempotent — the next turn boundary changes nothing', again === undefined && atlassianRowShape(s) === 'oauth');
    s.close();
  }
  {
    // Toggled by hand, edited, deleted: all the user's.
    const toggled = freshStore();
    seedShippedUpload(toggled, { status: 'enabled', autoStatus: 'disabled' });
    const edited = freshStore();
    seedShippedUpload(edited, { status: 'disabled', autoStatus: 'disabled', body: 'my own upload instructions' });
    const deleted = freshStore();
    seedShippedUpload(deleted, { status: 'disabled', autoStatus: 'disabled' });
    deleted.setHarnessStatus(uploadRow(deleted)!.id, 'removed');
    const r1 = withdrawBuiltinConfluenceUpload(toggled);
    const r2 = withdrawBuiltinConfluenceUpload(edited);
    const r3 = withdrawBuiltinConfluenceUpload(deleted);
    record(
      'withdraw (case 11): a row the user toggled or edited is KEPT; a row they deleted stays deleted',
      r1 === 'kept' && uploadRow(toggled)?.status === 'enabled' &&
        r2 === 'kept' && uploadRow(edited)?.status === 'disabled' &&
        r3 === 'absent' && uploadRow(deleted)?.provenance.origin === builtinHarnessOrigin(CONFLUENCE_UPLOAD_SKILL),
      JSON.stringify({ r1, r2, r3 }),
    );
    toggled.close();
    edited.close();
    deleted.close();
  }
  {
    const s = freshStore();
    s.upsertMcpEntry({ ...LEGACY, status: 'proposed' });
    signIn(s);
    const r = applyAtlassianOAuthSwapIfDue(s);
    record('swap: an agent-PROPOSED atlassian row is never swapped (a human approves those)', r === undefined && atlassianRowShape(s) === 'legacy');
    s.close();
  }
  {
    const s = freshStore();
    signIn(s);
    const r = applyAtlassianOAuthSwapIfDue(s);
    record('swap: a first-time sign-in with no row creates the OAuth row (no legacy refs to count)', r?.from === 'none' && atlassianRowShape(s) === 'oauth' && r.legacyRefs.length === 0);
    s.close();
  }
}

// ---------------------------------------------------------------------------
// the gate inside a turn (shell engine, AI-SDK engine, mock model)
// ---------------------------------------------------------------------------

const textStep = (text: string): LanguageModelV4GenerateResult => ({
  content: [{ type: 'text', text }],
  finishReason: { unified: 'stop', raw: 'end_turn' },
  usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
  warnings: [],
});

async function turn(prompt: string, opts: { sessionId?: string } = {}): Promise<{ events: RunEvent[]; model: MockLanguageModelV4 }> {
  const events: RunEvent[] = [];
  const model = new MockLanguageModelV4({ doGenerate: [textStep('ok.')] });
  let key = opts.sessionId ?? 'provisional';
  const ctx: RunCtx = {
    prompt,
    images: undefined,
    cwd: join(SPIKE_ROOT, 'project'),
    sessionId: opts.sessionId,
    params: { prompt, engine: 'naby' },
    signal: new AbortController().signal,
    emit: (e: RunEvent) => void events.push(e),
    rekey: (id: string) => {
      key = id;
    },
    currentKey: () => key,
  };
  await createNabySpec({ resolveModel: () => model as never }).runner.run(ctx);
  return { events, model };
}

const pills = (events: RunEvent[]) =>
  events
    .filter((e) => e.type === 'system' && (e as { harness_subtype?: string }).harness_subtype === 'org-harness')
    .map((e) => String((e as { harness_detail?: string }).harness_detail));

function fixtureZip(): Buffer {
  const out: ZipWriteEntry[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push({ name: relative(FIXTURE, full).split('\\').join('/'), data: readFileSync(full) });
    }
  };
  walk(FIXTURE);
  return buildZip(out);
}

async function turnChecks(): Promise<void> {
  mkdirSync(join(SPIKE_ROOT, 'project'), { recursive: true });
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
      return respond(200, { plugins: [{ name: 'altimedia-harness', version: '0.7.1', source: { url: '/dl', sha256: sha } }] });
    }
    if (url.endsWith('/dl')) return respond(200, null, zip);
    if (url.endsWith('/harness/bootstrap')) return respond(200, { env: { HARNESS_METRICS_TOKEN: 'hmt' } });
    return respond(404, null);
  });
  store.upsertMcpEntry({
    name: 'skill-hub',
    transport: 'http',
    url: 'http://127.0.0.1:9/mcp',
    headers: { Authorization: 'Bearer shub_gate_spike' },
    status: 'enabled',
  });
  await syncOrgHarnessNow(store, { applyNow: true });

  // A fresh install: no conversations yet → blocked at once.
  const sessionsBefore = store.listSessions().length;
  const blocked = await turn('hello');
  const result = blocked.events.find((e) => e.type === 'result') as { is_error?: boolean; result?: string } | undefined;
  record(
    'turn: a blocked prompt answers with the atlassian-required pill and an error result',
    pills(blocked.events).some((p) => p.startsWith('atlassian-required')) && result?.is_error === true && /Atlassian sign-in/.test(String(result.result)),
    JSON.stringify(blocked.events.map((e) => e.type)),
  );
  record(
    'turn: the blocked prompt never reached the model and minted no session',
    blocked.model.doGenerateCalls.length === 0 && store.listSessions().length === sessionsBefore,
    `model calls ${blocked.model.doGenerateCalls.length}; sessions ${sessionsBefore} → ${store.listSessions().length}`,
  );

  // Make it an upgrade within its grace: rewind the stamp to an existing install.
  store.setSetting(ORG_GATE_SETTING.graceKind, 'upgrade');
  store.setSetting(ORG_GATE_SETTING.graceStartedAt, String(Date.now() - 2 * DAY_MS));
  store.upsertMcpEntry(LEGACY);
  const grace = await turn('hello again');
  const gp = pills(grace.events);
  record(
    'turn: during the grace a new session runs, told the days left and to log in once (legacy row)',
    grace.model.doGenerateCalls.length === 1 && gp.includes('atlassian-grace:5') && gp.includes('atlassian-migrate'),
    JSON.stringify(gp),
  );
  // The legacy row is still the one the turn loaded (not swapped without a sign-in).
  record('turn: without a sign-in the API-token row is still there after the turn', atlassianRowShape(store) === 'legacy');
  setOrgHarnessFetch(undefined);
}

async function main(): Promise<void> {
  try {
    gateChecks();
    await depsChecks();
    swapChecks();
    await turnChecks();
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
