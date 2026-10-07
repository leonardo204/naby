// src/spikes/spike-org-harness-load.ts
//
// ORG HARNESS M2 — on-demand skills, `naby_skill_load`, the compatibility layer,
// the per-turn package pin and the write-protected org folder
// (specs/org-harness-sync.md §3.3, §3.4, §4.7, §4.8, §4.9 case 7).
//
// NO NETWORK, NO REAL HOME. Every case gets its own temp NABY_HOME + NABY_DB_PATH
// and a fake Skill Hub serving zips built from
// `fixtures/org-harness/altimedia-harness`.
//
// WHAT IS ASSERTED:
//
//   listing    org rows are LISTED (name + description), not injected as bodies;
//              the listing has its own budget and counters, and the body budget
//              selection is identical with and without org rows; a listing budget
//              too small for all three drops and counts; a same-name user copy
//              shadows the org entry; a turn with no org rows renders byte-for-
//              byte what it did before M2
//   load       naby_skill_load returns the §3.4 preamble, the absolute skill
//              folder, and the body with ${CLAUDE_PLUGIN_ROOT} / ${CLAUDE_SKILL_DIR}
//              replaced by absolute paths; unknown / disabled names refuse
//   switch     settings toggle and NABY_ORG_HARNESS=0 hide the listing and make
//              the load refuse EVEN WHILE THE ROWS STILL READ `enabled`; flipping
//              the switch mid-turn makes the next load refuse
//   explicit   `/task` named ⇒ the body is preloaded into the turn's system
//              field (through runTurn and a mock engine, i.e. the real path)
//   no shell   no run_command ⇒ org rows excluded and counted, nothing listed
//   pin        §4.9 case 7: a new version lands mid-turn; that turn's load and
//              env stay on the old folder (still on disk); the next turn uses
//              the new one
//   gate       read_file may read under <home>/org with the read root and is
//              refused without it; write_file / Write / Edit / MultiEdit /
//              NotebookEdit into <home>/org are denied by realPolicy above an
//              allow-all baseline and any user allow-rule; writes elsewhere pass
//   env        a run_command naming the package gets CLAUDE_PLUGIN_ROOT,
//              CLAUDE_SKILL_DIR, CLAUDE_PROJECT_DIR, HARNESS_CLIENT=naby and the
//              cic token; an unrelated command gets none of them; the Skill Hub
//              key is never in a child's environment
//
// Prints PASS/FAIL per assertion; exits non-zero on any FAIL.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MockEngine } from '../engines/mock-engine.js';
import { classifyToolConsequence } from '../runtime/checkin.js';
import type { Executor, GateDecision, ToolCall } from '../runtime/engine.js';
import { buildWorkspaceTools, makeReadFile, makeRunCommand } from '../runtime/fs-tools.js';
import { DEFAULT_USER_ID } from '../runtime/memory-inject.js';
import {
  applyOrgHarnessIfDue,
  ORG_HARNESS_ENV_SWITCH,
  ORG_HARNESS_SETTING,
  orgHarnessRoot,
  readCurrentOrgPackage,
  runOrgHarnessSync,
  setOrgHarnessEnabled,
  type OrgHarnessContext,
  type OrgHarnessFetch,
} from '../runtime/org-harness.js';
import {
  makeOrgSkillLoadTool,
  ORG_SKILL_LISTING_TOKEN_BUDGET,
  orgCommandEnv,
  orgHarnessProtectedRoot,
  orgReadRoots,
  orgSkillPreloader,
  orgTurnListsSkills,
  pinOrgHarnessTurn,
  type OrgHarnessTurn,
} from '../runtime/org-harness-turn.js';
import { realPolicy } from '../runtime/policy.js';
import { runTurn } from '../runtime/session.js';
import {
  ON_DEMAND_LISTING_HEADER,
  renderInjectedSkills,
  retrieveSkillsForInjection,
  type SkillInjectionQuery,
} from '../runtime/skill-inject.js';
import { SqliteStore } from '../runtime/store/sqlite-store.js';
import type { HarnessItem } from '../runtime/store/store.js';
import { buildZip, type ZipWriteEntry } from '../runtime/zip.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, evidence = ''): void {
  checks.push({ name, pass, evidence });
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = join(ROOT, 'src/spikes/fixtures/org-harness/altimedia-harness');
const SPIKE_ROOT = mkdtempSync(join(tmpdir(), 'naby-spike-org-load-'));
process.env.NABY_HOME = join(SPIKE_ROOT, 'process-home');
process.env.NABY_DB_PATH = join(SPIKE_ROOT, 'process-home', 'app.db');

const KEY = 'shub_spikeLoadKeyMUSTNOTLEAK';
const CIC = 'cic_spikeToken123';
const MARKETPLACE = 'https://hub.test/api/v1/marketplace.json';
const BOOTSTRAP = 'https://hub.test/api/v1/harness/bootstrap';
const DOWNLOAD = 'https://hub.test/api/v1/plugins/altimedia-harness/download';
const ORG_TOOLS = ['naby_skill_load', 'run_command', 'read_file', 'write_file', 'edit_file'];

function sha256(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

function packageZip(version: string): Buffer {
  const out: ZipWriteEntry[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const rel = relative(FIXTURE, full).split('\\').join('/');
      let data = readFileSync(full, 'utf8');
      if (rel === '.claude-plugin/plugin.json') {
        const plugin = JSON.parse(data) as Record<string, unknown>;
        plugin.version = version;
        data = JSON.stringify(plugin, null, 2);
      }
      out.push({ name: rel, data });
    }
  };
  walk(FIXTURE);
  return buildZip(out);
}

function fakeHub(): { fetch: OrgHarnessFetch; publish(version: string): void } {
  let offered: { version: string; zip: Buffer } | undefined;
  return {
    publish(version) {
      offered = { version, zip: packageZip(version) };
    },
    fetch: async (url) => {
      const respond = (status: number, body: unknown, bytes?: Buffer) => ({
        status,
        json: async () => body,
        arrayBuffer: async () => {
          const b = bytes ?? Buffer.from(JSON.stringify(body));
          return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
        },
      });
      if (url === MARKETPLACE) {
        return respond(200, {
          plugins: offered
            ? [
                {
                  name: 'altimedia-harness',
                  version: offered.version,
                  source: { url: DOWNLOAD, sha256: sha256(offered.zip) },
                },
              ]
            : [],
        });
      }
      if (url === DOWNLOAD) return offered ? respond(200, null, offered.zip) : respond(404, null);
      if (url === BOOTSTRAP) return respond(200, { env: { HARNESS_METRICS_TOKEN: 'hmt_spike' } });
      return respond(404, null);
    },
  };
}

type Case = { home: string; store: SqliteStore; project: string; hub: ReturnType<typeof fakeHub> };

async function installedCase(label: string, version = '0.7.1'): Promise<Case> {
  const home = join(SPIKE_ROOT, label);
  const project = join(home, 'project');
  mkdirSync(project, { recursive: true });
  const store = new SqliteStore({ path: join(home, 'app.db') });
  const hub = fakeHub();
  hub.publish(version);
  await syncWith(store, home, hub);
  return { home, store, project, hub };
}

function ctxFor(home: string, extra: Partial<OrgHarnessContext> = {}): OrgHarnessContext {
  return { home, apiKey: KEY, env: {}, ...extra };
}

async function syncWith(store: SqliteStore, home: string, hub: ReturnType<typeof fakeHub>, applyNow = true) {
  return runOrgHarnessSync(store, {
    ...ctxFor(home),
    fetch: hub.fetch,
    marketplaceUrl: MARKETPLACE,
    bootstrapUrl: BOOTSTRAP,
    applyNow,
  });
}

function pin(c: Case, extra: Partial<OrgHarnessContext> = {}, nativeClaudeTools = false): OrgHarnessTurn {
  return pinOrgHarnessTurn(c.store, {
    ...ctxFor(c.home, extra),
    projectDir: c.project,
    nativeClaudeTools,
    readCicToken: () => CIC,
  });
}

function query(turn: OrgHarnessTurn, over: Partial<SkillInjectionQuery> = {}): SkillInjectionQuery {
  return {
    userText: 'hello',
    tokenBudget: 3000,
    availableTools: ORG_TOOLS,
    onDemand: {
      enabled: orgTurnListsSkills(turn),
      listingTokenBudget: ORG_SKILL_LISTING_TOKEN_BUDGET,
      loadBody: orgSkillPreloader(turn),
    },
    ...over,
  };
}

const ORG_OPTS = { userId: DEFAULT_USER_ID, orgId: 'default' };

function putUserSkill(store: SqliteStore, name: string, body: string): HarnessItem {
  return store.putHarnessItem({
    item: {
      scope: 'user',
      scopeKey: DEFAULT_USER_ID,
      kind: 'skill',
      name,
      description: `${name} (user)`,
      provenance: { source: 'user', origin: `spike:${name}`, format: 'claude-skill-md' },
      skill: { instructions: body },
    },
    requestedStatus: 'enabled',
    autoEnable: true,
  });
}

async function load(turn: OrgHarnessTurn, name: string): Promise<{ content: string; isError: boolean }> {
  const tool = makeOrgSkillLoadTool(turn);
  const out = await tool.executor({ name }, {
    toolCall: { toolCallId: 't1', toolName: 'naby_skill_load', input: { name } },
    signal: new AbortController().signal,
  });
  return { content: out.content, isError: out.isError === true };
}

// ---------------------------------------------------------------------------
// listing
// ---------------------------------------------------------------------------

async function listingChecks(): Promise<void> {
  const c = await installedCase('listing');
  const turn = pin(c);
  record('[setup] package installed and pinned', orgTurnListsSkills(turn) && turn.pkg?.version === '0.7.1');

  // A user instruction-only skill big enough to matter for the body budget.
  putUserSkill(c.store, 'house-style', 'Write short sentences. '.repeat(200));

  const withOrg = retrieveSkillsForInjection(c.store, query(turn), ORG_OPTS);
  const od = withOrg.onDemand;
  record(
    '[listing] the three org skills are LISTED, none injected as a body',
    od !== undefined &&
      od.listed.map((r) => r.name).sort().join(',') === 'ctx,pdoc,task' &&
      !withOrg.skills.some((s) => s.scope === 'org'),
    `listed=${od?.listed.map((r) => r.name).join(',')} bodies=${withOrg.skills.map((s) => s.name).join(',')}`,
  );
  record(
    '[listing] listing tokens within the listing budget, counted apart from the body budget',
    od !== undefined && od.listingTokens > 0 && od.listingTokens <= ORG_SKILL_LISTING_TOKEN_BUDGET,
    `listingTokens=${od?.listingTokens} bodyTokens=${withOrg.tokensUsed}`,
  );

  // Body selection unchanged by the org rows: same as a turn that cannot see them.
  const bodyOnly = retrieveSkillsForInjection(c.store, query(turn), { userId: DEFAULT_USER_ID });
  record(
    '[listing] body budget selection identical with and without org rows',
    withOrg.tokensUsed === bodyOnly.tokensUsed &&
      withOrg.droppedForBudget === bodyOnly.droppedForBudget &&
      withOrg.skills.map((s) => s.id).join() === bodyOnly.skills.map((s) => s.id).join(),
    `with=${withOrg.tokensUsed} without=${bodyOnly.tokensUsed}`,
  );
  record(
    '[listing] a turn with no org rows renders byte-for-byte the pre-M2 block',
    renderInjectedSkills(bodyOnly) ===
      [
        'Skills available for this turn (apply where they fit; do not mention this block):',
        ...bodyOnly.skills.map((s) => `## ${s.name}\n${s.skill?.instructions ?? ''}`),
      ].join('\n\n') && bodyOnly.onDemand === undefined,
  );

  const rendered = renderInjectedSkills(withOrg) ?? '';
  const task = c.store.listHarness('org', 'default', { kind: 'skill' }).find((r) => r.name === 'task')!;
  record(
    '[listing] rendered: listing header tells the model to call naby_skill_load first; no body text',
    rendered.includes(ON_DEMAND_LISTING_HEADER) &&
      ON_DEMAND_LISTING_HEADER.includes('naby_skill_load') &&
      rendered.includes(`- task: ${task.skill!.instructions}`) &&
      !rendered.includes('Synthetic body for spike-org-harness-migrate'),
  );

  const tight = retrieveSkillsForInjection(
    c.store,
    query(turn, {
      onDemand: { enabled: true, listingTokenBudget: 120, loadBody: orgSkillPreloader(turn) },
    }),
    ORG_OPTS,
  );
  record(
    '[listing] a listing budget too small for three drops and COUNTS (hard cap)',
    (tight.onDemand?.listingDroppedForBudget ?? 0) > 0 &&
      (tight.onDemand?.listingTokens ?? 999) <= 120 &&
      (tight.onDemand?.listed.length ?? 0) + (tight.onDemand?.listingDroppedForBudget ?? 0) === 3,
    JSON.stringify({ listed: tight.onDemand?.listed.length, dropped: tight.onDemand?.listingDroppedForBudget }),
  );

  // Same-name user copy shadows the org entry (§3.2 precedence project > user > org).
  putUserSkill(c.store, 'pdoc', 'my own pdoc');
  const shadowed = retrieveSkillsForInjection(c.store, query(turn), ORG_OPTS);
  record(
    '[listing] an enabled same-name user copy shadows the org listing entry',
    shadowed.onDemand?.shadowed === 1 &&
      !shadowed.onDemand.listed.some((r) => r.name === 'pdoc') &&
      shadowed.skills.some((s) => s.name === 'pdoc' && s.scope === 'user'),
  );

  record(
    '[listing] naby_skill_load is scored as an observation by the growth ledger',
    classifyToolConsequence('naby_skill_load') === 'observation',
    classifyToolConsequence('naby_skill_load'),
  );
}

// ---------------------------------------------------------------------------
// load + compatibility layer
// ---------------------------------------------------------------------------

async function loadChecks(): Promise<void> {
  const c = await installedCase('load');
  const turn = pin(c);
  const pkgDir = turn.pkg!.dir;
  const taskDir = join(pkgDir, 'skills', 'task');
  const r = await load(turn, 'task');
  record('[load] naby_skill_load("task") succeeds', !r.isError, r.content.slice(0, 120));
  record(
    '[load] result carries the §3.4 preamble (tool name table, AskUserQuestion, ~/.claude rule)',
    r.content.startsWith('[naby compatibility note') &&
      r.content.includes('`Bash` → `run_command`') &&
      r.content.includes('`read_file` / `write_file` / `edit_file`') &&
      r.content.includes('AskUserQuestion') &&
      r.content.includes('naby_checkin') &&
      r.content.includes('~/.claude/'),
  );
  record('[load] result names the absolute skill folder', r.content.includes(`Skill folder: ${taskDir}`));
  record(
    '[load] ${CLAUDE_PLUGIN_ROOT} and ${CLAUDE_SKILL_DIR} are replaced in the body',
    r.content.includes(`python3 ${pkgDir}/skills/task/scripts/main.py`) &&
      r.content.includes(`python3 "${taskDir}/scripts/main.py" start`) &&
      !r.content.includes('${CLAUDE_PLUGIN_ROOT}/') &&
      !r.content.includes('"${CLAUDE_SKILL_DIR}/'),
  );
  record('[load] the absolute path really exists on disk', existsSync(join(taskDir, 'scripts', 'main.py')));

  const native = await load(pin(c, {}, true), 'task');
  record(
    '[load] on the Agent SDK engine the name table is the identity',
    !native.isError && native.content.includes('use them as written') && !native.content.includes('→ `run_command`'),
  );

  const unknown = await load(turn, 'nope');
  record(
    '[load] an unknown name refuses and lists what exists',
    unknown.isError && unknown.content.includes('ctx, pdoc, task'),
    unknown.content,
  );
  const ctxRow = c.store.listHarness('org', 'default', { kind: 'skill' }).find((x) => x.name === 'ctx')!;
  c.store.setHarnessEnabled(ctxRow.id, false);
  const disabled = await load(turn, 'ctx');
  record('[load] a skill the user disabled refuses', disabled.isError, disabled.content);
}

// ---------------------------------------------------------------------------
// kill switch (§4.8) at injection, regardless of row status
// ---------------------------------------------------------------------------

async function switchChecks(): Promise<void> {
  const c = await installedCase('switch');
  const rowsEnabled = () =>
    c.store.listHarness('org', 'default', { kind: 'skill' }).every((r) => r.status === 'enabled');

  // Settings toggle written WITHOUT the turn-boundary apply: rows still read enabled.
  c.store.setSetting(ORG_HARNESS_SETTING.enabled, 'false');
  const offTurn = pin(c);
  const off = retrieveSkillsForInjection(c.store, query(offTurn, { explicitNames: ['task'] }), ORG_OPTS);
  record(
    '[switch] settings off: rows still enabled, yet nothing listed or preloaded (counted switchedOff)',
    rowsEnabled() &&
      off.onDemand?.listed.length === 0 &&
      off.onDemand.preloaded.length === 0 &&
      off.onDemand.switchedOff === 3 &&
      renderInjectedSkills(off) === undefined,
    JSON.stringify(off.onDemand && { listed: off.onDemand.listed.length, off: off.onDemand.switchedOff }),
  );
  const refused = await load(offTurn, 'task');
  record('[switch] settings off: naby_skill_load refuses', refused.isError && /switched off/.test(refused.content));
  record('[switch] settings off: no package-command env', orgCommandEnv(offTurn, `ls ${join(c.home, 'org')}`, c.project) === undefined);
  record('[switch] settings off: no org read root', orgReadRoots(offTurn).length === 0);
  c.store.setSetting(ORG_HARNESS_SETTING.enabled, 'true');

  const envOff = pin(c, { env: { [ORG_HARNESS_ENV_SWITCH]: '0' } });
  const envOffSel = retrieveSkillsForInjection(c.store, query(envOff), ORG_OPTS);
  const envRefused = await load(envOff, 'task');
  record(
    '[switch] NABY_ORG_HARNESS=0: nothing listed, load refuses (rows still enabled)',
    rowsEnabled() && envOffSel.onDemand?.listed.length === 0 && envRefused.isError,
  );

  // Mid-turn: pinned on, switched off before the call ⇒ the call refuses.
  const live = pin(c);
  const before = await load(live, 'task');
  setOrgHarnessEnabled(c.store, false, ctxFor(c.home));
  const after = await load(live, 'task');
  record(
    '[switch] switched off mid-turn: the next load refuses (the live switch is re-read)',
    !before.isError && after.isError,
  );
  setOrgHarnessEnabled(c.store, true, ctxFor(c.home));
  record('[switch] switched back on: listing returns', orgTurnListsSkills(pin(c)));
}

// ---------------------------------------------------------------------------
// explicit naming preloads, through runTurn
// ---------------------------------------------------------------------------

async function explicitChecks(): Promise<void> {
  const c = await installedCase('explicit');
  const turn = pin(c);
  const sel = retrieveSkillsForInjection(c.store, query(turn, { explicitNames: ['task'] }), ORG_OPTS);
  record(
    '[explicit] /task named ⇒ its body is preloaded (and only task)',
    sel.onDemand?.preloaded.length === 1 &&
      sel.onDemand.preloaded[0]!.item.name === 'task' &&
      sel.onDemand.preloaded[0]!.text.includes('Skill folder:') &&
      sel.onDemand.preloadTokens > 0 &&
      sel.tokensUsed === 0,
    JSON.stringify({ pre: sel.onDemand?.preloaded.map((p) => p.item.name), tokens: sel.onDemand?.preloadTokens }),
  );

  // The real path: runTurn → skill injection → the engine's system field.
  const engine = new MockEngine();
  const sessionId = c.store.createSession('mock').sessionId;
  const allow = async (): Promise<GateDecision> => ({ behavior: 'allow' });
  const send: Executor = async () => ({ content: 'sent' });
  const loadTool = makeOrgSkillLoadTool(turn);
  await runTurn({
    engine,
    store: c.store,
    sessionId,
    model: { providerId: 'mock' },
    userText: '/task start 회의록',
    toolSchemas: [loadTool.schema],
    executors: { naby_skill_load: loadTool.executor, send_message: send },
    gate: allow,
    cwd: c.project,
    skillInjection: {
      tokenBudget: 3000,
      userId: DEFAULT_USER_ID,
      orgId: 'default',
      availableTools: ORG_TOOLS,
      explicitNames: ['task'],
      onDemand: {
        enabled: orgTurnListsSkills(turn),
        listingTokenBudget: ORG_SKILL_LISTING_TOKEN_BUDGET,
        loadBody: orgSkillPreloader(turn),
      },
    },
  });
  const system = engine.diagnostics.system ?? '';
  record(
    '[explicit] runTurn: the engine received the listing AND the preloaded task body',
    system.includes(ON_DEMAND_LISTING_HEADER) &&
      system.includes('Skill "task" was named in this turn') &&
      system.includes(`Skill folder: ${join(turn.pkg!.dir, 'skills', 'task')}`) &&
      !system.includes('# pdoc (fixture)'),
    `system length ${system.length}`,
  );
  record(
    '[explicit] the preload sets CLAUDE_SKILL_DIR for a later command that only names the variable',
    orgCommandEnv(turn, 'python3 "${CLAUDE_SKILL_DIR}/scripts/main.py"', c.project)?.CLAUDE_SKILL_DIR ===
      join(turn.pkg!.dir, 'skills', 'task'),
  );
}

// ---------------------------------------------------------------------------
// no shell
// ---------------------------------------------------------------------------

async function noShellChecks(): Promise<void> {
  const c = await installedCase('noshell');
  const turn = pin(c);
  const sel = retrieveSkillsForInjection(
    c.store,
    query(turn, { availableTools: ['naby_skill_load', 'read_file'], explicitNames: ['task'] }),
    ORG_OPTS,
  );
  record(
    '[no shell] no run_command: all three excluded and COUNTED, nothing listed or preloaded',
    sel.excludedForTools === 3 &&
      sel.onDemand?.listed.length === 0 &&
      sel.onDemand.preloaded.length === 0 &&
      renderInjectedSkills(sel) === undefined,
    JSON.stringify({ excluded: sel.excludedForTools }),
  );
  const noLoader = retrieveSkillsForInjection(c.store, { userText: 'x', tokenBudget: 3000, availableTools: ['run_command'] }, ORG_OPTS);
  record(
    '[no shell] a build without naby_skill_load (no onDemand config) still excludes and counts (§4.7)',
    noLoader.excludedForTools === 3 && noLoader.skills.length === 0,
  );
}

// ---------------------------------------------------------------------------
// §4.9 case 7 — a new version arrives mid-turn
// ---------------------------------------------------------------------------

async function pinChecks(): Promise<void> {
  const c = await installedCase('pin');
  const turn = pin(c);
  const oldDir = turn.pkg!.dir;
  // Mid-turn: the background sync downloads 0.7.2 and flips `current` (no apply,
  // a turn is running).
  c.hub.publish('0.7.2');
  const report = await syncWith(c.store, c.home, c.hub, false);
  const flipped = readCurrentOrgPackage(c.home);
  record(
    '[pin] setup: 0.7.2 landed and `current` flipped mid-turn',
    report.package?.outcome === 'updated' && flipped?.version === '0.7.2',
    JSON.stringify(report.package),
  );
  const mid = await load(turn, 'task');
  const env = orgCommandEnv(turn, `python3 ${oldDir}/skills/task/scripts/main.py`, c.project);
  record(
    '[pin] the running turn still loads from the OLD folder',
    !mid.isError && mid.content.includes(`Skill folder: ${join(oldDir, 'skills', 'task')}`) && oldDir.endsWith('0.7.1'),
  );
  record('[pin] the running turn\'s command env names the OLD folder', env?.CLAUDE_PLUGIN_ROOT === oldDir);
  record('[pin] the old folder is still on disk (one previous version kept)', existsSync(join(oldDir, 'skills', 'task', 'SKILL.md')));

  applyOrgHarnessIfDue(c.store, ctxFor(c.home)); // the next turn boundary
  const next = pin(c);
  const nextLoad = await load(next, 'task');
  record(
    '[pin] the next turn pins and loads from the NEW folder',
    next.pkg?.version === '0.7.2' &&
      nextLoad.content.includes(`Skill folder: ${join(orgHarnessRoot(c.home), '0.7.2', 'skills', 'task')}`),
  );
}

// ---------------------------------------------------------------------------
// gate: read-allow / write-deny under <home>/org
// ---------------------------------------------------------------------------

async function gateChecks(): Promise<void> {
  const c = await installedCase('gate');
  const turn = pin(c);
  const skillMd = join(turn.pkg!.dir, 'skills', 'pdoc', 'docs', 'commands.md');
  const ctx = { toolCall: { toolCallId: 'r', toolName: 'read_file', input: {} }, signal: new AbortController().signal };

  const withRoot = await makeReadFile(c.project, { readRoots: orgReadRoots(turn) })({ path: skillMd }, ctx);
  record('[gate] read_file reads under <home>/org with the turn\'s read root', !withRoot.isError, withRoot.content.slice(0, 80));
  const without = await makeReadFile(c.project)({ path: skillMd }, ctx);
  record('[gate] read_file without the read root is refused (the sandbox is unchanged)', without.isError === true);
  const ws = buildWorkspaceTools({ cwd: c.project, allowMutations: true, readRoots: orgReadRoots(turn) });
  const wsWrite = await ws.executors.write_file!({ path: join(turn.pkg!.dir, 'x.txt'), content: 'x' }, ctx);
  record(
    '[gate] write_file is still contained to the project (read roots never widen writes)',
    wsWrite.isError === true && !existsSync(join(turn.pkg!.dir, 'x.txt')),
  );

  const allowAll = () => ({ behavior: 'allow' as const });
  const policy = realPolicy({
    rules: [
      // A user allow-rule must not be able to grant it.
      {
        id: 'r1',
        scope: 'user',
        scopeKey: DEFAULT_USER_ID,
        toolPattern: '*',
        effect: 'allow',
        createdAt: 0,
        updatedAt: 0,
      },
    ],
    fallback: allowAll,
    writeProtectedRoots: [orgHarnessProtectedRoot(c.home)],
    cwd: c.home, // a project opened AT the naby home: relative paths reach org/
  });
  const decide = async (toolName: string, input: unknown): Promise<GateDecision> =>
    policy({ toolCallId: 'g', toolName, input } as ToolCall);
  const inOrg = join(turn.pkg!.dir, 'skills', 'task', 'SKILL.md');
  const denials = await Promise.all([
    decide('write_file', { path: inOrg, content: 'x' }),
    decide('edit_file', { path: 'org/altimedia-harness/0.7.1/skills/task/SKILL.md', oldString: 'a', newString: 'b' }),
    decide('Write', { file_path: inOrg, content: 'x' }),
    decide('Edit', { file_path: inOrg, old_string: 'a', new_string: 'b' }),
    decide('MultiEdit', { file_path: inOrg, edits: [] }),
    decide('NotebookEdit', { notebook_path: join(c.home, 'org', 'n.ipynb') }),
  ]);
  record(
    '[gate] write_file / edit_file (relative) / Write / Edit / MultiEdit / NotebookEdit into <home>/org: all denied over allow-all + an allow-rule',
    denials.every((d) => d.behavior === 'deny'),
    denials.map((d) => d.behavior).join(','),
  );
  if (process.platform === 'darwin' || process.platform === 'win32') {
    const upper = await decide('Write', { file_path: inOrg.replace('/org/', '/ORG/'), content: 'x' });
    record('[gate] a case-changed spelling is denied on a case-insensitive FS', upper.behavior === 'deny');
  }
  const passes = await Promise.all([
    decide('write_file', { path: join(c.project, 'out.md'), content: 'x' }),
    decide('Write', { file_path: join(c.home, 'organizer.txt'), content: 'x' }),
    decide('read_file', { path: inOrg }),
    decide('Read', { file_path: inOrg }),
  ]);
  record(
    '[gate] writes elsewhere (incl. a sibling named "organizer") and reads under org/ pass',
    passes.every((d) => d.behavior === 'allow'),
    passes.map((d) => d.behavior).join(','),
  );
}

// ---------------------------------------------------------------------------
// env for package commands; the Skill Hub key never leaks
// ---------------------------------------------------------------------------

async function envChecks(): Promise<void> {
  const c = await installedCase('env');
  const turn = pin(c);
  const pkgDir = turn.pkg!.dir;
  const taskScript = join(pkgDir, 'skills', 'task', 'scripts', 'main.py');

  const env = orgCommandEnv(turn, `python3 ${taskScript} start`, c.project);
  record(
    '[env] a command naming a package script gets the §3.4 env',
    env?.CLAUDE_PLUGIN_ROOT === pkgDir &&
      env.CLAUDE_SKILL_DIR === join(pkgDir, 'skills', 'task') &&
      env.CLAUDE_PROJECT_DIR === c.project &&
      env.HARNESS_CLIENT === 'naby' &&
      env.CLAUDE_PLUGIN_OPTION_CIC_TOKEN === CIC,
    JSON.stringify(env && { ...env, CLAUDE_PLUGIN_OPTION_CIC_TOKEN: env.CLAUDE_PLUGIN_OPTION_CIC_TOKEN ? '<set>' : undefined }),
  );
  record('[env] an unrelated command gets nothing', orgCommandEnv(turn, 'git status', c.project) === undefined);
  const noCic = orgCommandEnv(
    pinOrgHarnessTurn(c.store, { ...ctxFor(c.home), projectDir: c.project, readCicToken: () => undefined }),
    `python3 ${taskScript}`,
    c.project,
  );
  record('[env] no cic preset ⇒ no cic token variable', noCic !== undefined && !('CLAUDE_PLUGIN_OPTION_CIC_TOKEN' in noCic));

  // Run real commands. The parent env carries the key under both names a user
  // shell might export; the child must see neither, nor the key anywhere.
  process.env.SHUB_API_KEY = KEY;
  process.env.CLAUDE_PLUGIN_OPTION_SHUB_API_KEY = KEY;
  const run = makeRunCommand(c.project, { envFor: (cmd, cwd) => orgCommandEnv(turn, cmd, cwd) });
  const ctx = { toolCall: { toolCallId: 'e', toolName: 'run_command', input: {} }, signal: new AbortController().signal };
  const dump = `node -e "process.stdout.write(JSON.stringify(process.env))"`;
  const pkgRun = await run({ command: `${dump} "${pkgDir}"` }, ctx);
  const plainRun = await run({ command: dump }, ctx);
  delete process.env.SHUB_API_KEY;
  delete process.env.CLAUDE_PLUGIN_OPTION_SHUB_API_KEY;
  const parse = (out: string): Record<string, string> => {
    const start = out.indexOf('{');
    try {
      return JSON.parse(out.slice(start)) as Record<string, string>;
    } catch {
      return {};
    }
  };
  const pkgEnv = parse(pkgRun.content);
  const plainEnv = parse(plainRun.content);
  record(
    '[env] run_command on a package path: the child sees CLAUDE_PLUGIN_ROOT / HARNESS_CLIENT / CLAUDE_PROJECT_DIR / cic',
    pkgEnv.CLAUDE_PLUGIN_ROOT === pkgDir &&
      pkgEnv.HARNESS_CLIENT === 'naby' &&
      pkgEnv.CLAUDE_PROJECT_DIR === c.project &&
      pkgEnv.CLAUDE_PLUGIN_OPTION_CIC_TOKEN === CIC,
    `exit/len ${pkgRun.content.length}`,
  );
  record(
    '[env] run_command on a package path: the Skill Hub key is in NO variable of the child',
    !pkgRun.content.includes(KEY) && !('SHUB_API_KEY' in pkgEnv) && !('CLAUDE_PLUGIN_OPTION_SHUB_API_KEY' in pkgEnv),
  );
  record(
    '[env] an unrelated run_command gets no org variables (inherited env untouched)',
    !('CLAUDE_PLUGIN_ROOT' in plainEnv) && !('CLAUDE_PLUGIN_OPTION_CIC_TOKEN' in plainEnv) && !('HARNESS_CLIENT' in plainEnv),
  );
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  try {
    await listingChecks();
    await loadChecks();
    await switchChecks();
    await explicitChecks();
    await noShellChecks();
    await pinChecks();
    await gateChecks();
    await envChecks();
  } catch (e) {
    record('spike ran to completion', false, e instanceof Error ? (e.stack ?? e.message) : String(e));
  }
  let failed = 0;
  for (const ch of checks) {
    if (!ch.pass) failed += 1;
    console.log(`${ch.pass ? 'PASS' : 'FAIL'}  ${ch.name}${ch.evidence && !ch.pass ? `\n      ${ch.evidence}` : ''}`);
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
