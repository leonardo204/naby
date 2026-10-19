// src/spikes/spike-participant-permission.ts
//
// multi-agent-chat MAC-M7 verification (specs/multi-agent-chat.md §8.14):
//
//   * `toolTierOf` — every built-in runtime tool, the Agent SDK built-ins, MCP
//     tools with and without a `readOnlyHint`, and names nobody has heard of
//     (fail closed → elevated);
//   * the tier is the ledger's classification, not a copy: for every name the
//     table checks, `read` ⇔ `classifyToolConsequence` says observation;
//   * `levelIncludesTier` — the five levels are nested, `custom` holds no tier;
//   * `participantPermissionOf` — a stored permission wins, a legacy row reads
//     as `custom` (toolRefs) or `none` (no toolRefs), a malformed one falls back;
//   * `resolvePermissionTools` — a level resolved against a turn's toolset, a new
//     tool joining its level without an edit, `custom` keeping only `toolRefs`;
//   * `participantCallPlan` — the 2026-10-19 rule: inside the level runs without
//     asking, outside asks, the switch asks for everything, a policy `deny` wins,
//     nobody to ask → refused;
//   * the profile gate accepts and cleans `permission`, refuses a bad level or
//     approval, and the value survives a store round trip on both drivers.
//
// Pure apart from the two stores; the sqlite one lives under mkdtemp — never
// ~/.naby. No model, no network. Exit 0 = pass, non-zero = fail.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryStore,
  SqliteStore,
  classifyToolConsequence,
  defaultParticipantProfile,
  levelIncludesTier,
  parseParticipantProfile,
  participantCallPlan,
  isApprovedTool,
  withApprovedTool,
  participantPermissionOf,
  resolvePermissionTools,
  runtimeToolNames,
  toolTierOf,
  PARTICIPANT_PERMISSION_LEVELS,
  type ParticipantPermissionLevel,
  type Store,
  type ToolTier,
} from '../runtime-entry.js';

let failures = 0;
let passes = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passes += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
function throws(fn: () => unknown, match?: RegExp): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return match ? match.test(e instanceof Error ? e.message : String(e)) : true;
  }
}

/** The tier table (R10.1). `hint` is the MCP annotation, when there is one. */
const TABLE: { name: string; hint?: boolean; tier: ToolTier }[] = [
  // our workspace reads
  { name: 'read_file', tier: 'read' },
  { name: 'glob', tier: 'read' },
  { name: 'grep', tier: 'read' },
  { name: 'list_dir', tier: 'read' },
  // other observations
  { name: 'fetch_url', tier: 'read' },
  { name: 'naby_skill_load', tier: 'read' },
  { name: 'naby_check_job', tier: 'read' },
  { name: 'naby_read_job_output', tier: 'read' },
  { name: 'echo_note', tier: 'read' },
  // file writes — reversible through the per-call snapshot
  { name: 'edit_file', tier: 'write' },
  { name: 'write_file', tier: 'write' },
  // commands, jobs, messages
  { name: 'run_command', tier: 'elevated' },
  { name: 'naby_start_job', tier: 'elevated' },
  { name: 'send_message', tier: 'elevated' },
  // the Agent SDK's built-ins (dev-claude)
  { name: 'Read', tier: 'read' },
  { name: 'Glob', tier: 'read' },
  { name: 'Grep', tier: 'read' },
  { name: 'WebFetch', tier: 'read' },
  { name: 'WebSearch', tier: 'read' },
  { name: 'Write', tier: 'write' },
  { name: 'Edit', tier: 'write' },
  { name: 'MultiEdit', tier: 'write' },
  { name: 'NotebookEdit', tier: 'write' },
  { name: 'Bash', tier: 'elevated' },
  { name: 'KillShell', tier: 'elevated' },
  // MCP: the server's declaration decides, silence fails closed
  { name: 'jira__search_issues', hint: true, tier: 'read' },
  { name: 'jira__create_issue', hint: false, tier: 'elevated' },
  { name: 'mail__send_email', tier: 'elevated' },
  // a built-in's own classification outranks a server claiming read-only
  { name: 'Bash', hint: true, tier: 'elevated' },
  { name: 'write_file', hint: true, tier: 'write' },
  // names nobody has heard of
  { name: 'totally_new_tool', tier: 'elevated' },
  { name: '', tier: 'elevated' },
];

function exerciseTiers(): void {
  console.log('\n[tiers] toolTierOf');
  for (const row of TABLE) {
    const got = toolTierOf(row.name, row.hint !== undefined ? { readOnlyHint: row.hint } : undefined);
    check(
      `${row.name || '(empty)'}${row.hint !== undefined ? ` readOnlyHint=${row.hint}` : ''} → ${row.tier}`,
      got === row.tier,
      `got ${got}`,
    );
  }
  // ONE JUDGE: the tier's read/not-read split IS the ledger's classifier.
  const agree = TABLE.every((row) => {
    const signals = row.hint !== undefined ? { readOnlyHint: row.hint } : undefined;
    const observation = classifyToolConsequence(row.name, signals) === 'observation';
    return observation === (toolTierOf(row.name, signals) === 'read');
  });
  check('read ⇔ classifyToolConsequence(...) === observation, for every row', agree);
  // Every tool a turn actually builds has a tier (none throws, none is undefined).
  const names = runtimeToolNames();
  check(
    `every runtime tool (${names.length}) gets a tier`,
    names.length > 0 && names.every((n) => ['read', 'write', 'elevated'].includes(toolTierOf(n))),
  );
}

function exerciseLevels(): void {
  console.log('\n[levels] levelIncludesTier');
  const want: Record<Exclude<ParticipantPermissionLevel, 'custom'>, ToolTier[]> = {
    none: [],
    read: ['read'],
    write: ['read', 'write'],
    elevated: ['read', 'write', 'elevated'],
    all: ['read', 'write', 'elevated'],
  };
  for (const [level, tiers] of Object.entries(want) as [Exclude<ParticipantPermissionLevel, 'custom'>, ToolTier[]][]) {
    const got = (['read', 'write', 'elevated'] as ToolTier[]).filter((t) => levelIncludesTier(level, t));
    check(`${level} includes [${tiers.join(', ')}]`, JSON.stringify(got) === JSON.stringify(tiers), JSON.stringify(got));
  }
  check(
    'custom includes no tier (it decides by name)',
    !levelIncludesTier('custom', 'read') && !levelIncludesTier('custom', 'elevated'),
  );
  check(
    'the level list is exactly the six of R10.1',
    JSON.stringify(PARTICIPANT_PERMISSION_LEVELS) === JSON.stringify(['none', 'read', 'write', 'elevated', 'all', 'custom']),
  );
}

function exerciseLegacy(): void {
  console.log('\n[legacy] participantPermissionOf');
  const p = (permission?: unknown) => ({ ...defaultParticipantProfile('X'), ...(permission !== undefined ? { permission } : {}) });
  check('no permission + toolRefs → custom/auto', JSON.stringify(participantPermissionOf({ toolRefs: ['read_file'], profile: p() })) === '{"level":"custom","approval":"auto"}');
  check('no permission + no toolRefs → none/auto', JSON.stringify(participantPermissionOf({ toolRefs: [], profile: p() })) === '{"level":"none","approval":"auto"}');
  check(
    'no permission + no toolRefs but MCP servers → custom (those servers kept working before)',
    participantPermissionOf({ toolRefs: [], profile: { ...p(), mcpServers: ['jira'] } }).level === 'custom',
  );
  check('no profile at all → none/auto', JSON.stringify(participantPermissionOf({})) === '{"level":"none","approval":"auto"}');
  check(
    'a stored permission wins over toolRefs',
    JSON.stringify(participantPermissionOf({ toolRefs: ['read_file'], profile: p({ level: 'write', approval: 'always' }) })) ===
      '{"level":"write","approval":"always"}',
  );
  check(
    'a stored permission without approval reads approval=auto',
    participantPermissionOf({ profile: p({ level: 'read' }) }).approval === 'auto',
  );
  check(
    'a malformed stored permission falls back to the legacy reading',
    participantPermissionOf({ toolRefs: ['x'], profile: p({ level: 'root' }) }).level === 'custom' &&
      participantPermissionOf({ toolRefs: [], profile: p('read') }).level === 'none',
  );
}

function exerciseResolve(): void {
  console.log('\n[resolve] resolvePermissionTools');
  const turn = ['read_file', 'grep', 'fetch_url', 'write_file', 'edit_file', 'run_command', 'send_message', 'jira__search', 'jira__create'];
  const annotations = { jira__search: { readOnlyHint: true } };
  const r = (level: ParticipantPermissionLevel, names = turn, toolRefs?: string[]) =>
    resolvePermissionTools({ level }, names, { annotations, ...(toolRefs ? { toolRefs } : {}) });
  check('none → []', r('none').length === 0);
  check('read → reads + read-only MCP', JSON.stringify(r('read')) === JSON.stringify(['read_file', 'grep', 'fetch_url', 'jira__search']));
  check(
    'write → read + file edits',
    JSON.stringify(r('write')) === JSON.stringify(['read_file', 'grep', 'fetch_url', 'write_file', 'edit_file', 'jira__search']),
  );
  check('elevated → everything in this toolset', JSON.stringify(r('elevated')) === JSON.stringify(turn));
  check('all → everything, in order', JSON.stringify(r('all')) === JSON.stringify(turn));
  check('custom → only toolRefs that exist this turn', JSON.stringify(r('custom', turn, ['grep', 'gone_tool'])) === '["grep"]');
  check('custom without toolRefs → []', r('custom').length === 0);
  // A tool that appears later joins its level with no edit (R10.3).
  const later = [...turn, 'wiki__read_page', 'new_runtime_tool'];
  const withHint = resolvePermissionTools({ level: 'read' }, later, {
    annotations: { ...annotations, wiki__read_page: { readOnlyHint: true } },
  });
  check('a new read-only MCP tool joins read; a new unknown tool does not', withHint.includes('wiki__read_page') && !withHint.includes('new_runtime_tool'));
  check('a new unknown tool joins elevated', r('elevated', later).includes('new_runtime_tool'));
}

function exerciseGate(): void {
  console.log('\n[profile] permission through the profile gate');
  const base = defaultParticipantProfile('Reader');
  const clean = parseParticipantProfile({ ...base, permission: { level: 'read', approval: 'always', extra: 1 } });
  check('accepted and cleaned', JSON.stringify(clean.permission) === '{"level":"read","approval":"always"}');
  check('approval defaults to auto', parseParticipantProfile({ ...base, permission: { level: 'all' } }).permission?.approval === 'auto');
  check('absent stays absent', parseParticipantProfile(base).permission === undefined);
  check('null reads as absent', parseParticipantProfile({ ...base, permission: null }).permission === undefined);
  check('unknown level refused', throws(() => parseParticipantProfile({ ...base, permission: { level: 'root' } }), /permission\.level/));
  check('unknown approval refused', throws(() => parseParticipantProfile({ ...base, permission: { level: 'read', approval: 'never' } }), /permission\.approval/));
  check('non-object refused', throws(() => parseParticipantProfile({ ...base, permission: 'read' }), /permission must be an object/));
  const twice = parseParticipantProfile(JSON.parse(JSON.stringify(clean)));
  check('a clean profile re-parses to the identical JSON', JSON.stringify(twice) === JSON.stringify(clean));
}

function exerciseStore(label: string, store: Store): string {
  const profile = parseParticipantProfile({ ...defaultParticipantProfile('Writer'), permission: { level: 'write', approval: 'always' } });
  const a = store.putAgent({
    name: `writer-${label}`,
    kind: 'participant',
    systemPrompt: 'You write.',
    toolRefs: ['read_file'],
    memoryScope: 'session',
    autonomy: { escalation: 'inline' },
    profile,
  });
  const back = store.getAgent(a.id);
  check(`${label}: profile.permission survives the round trip`, JSON.stringify(back?.profile?.permission) === '{"level":"write","approval":"always"}');
  check(`${label}: the stored level wins over toolRefs on read`, back ? participantPermissionOf(back).level === 'write' : false);
  const legacy = store.putAgent({
    name: `legacy-${label}`,
    kind: 'participant',
    systemPrompt: 'Old row.',
    toolRefs: ['grep'],
    memoryScope: 'session',
    autonomy: { escalation: 'inline' },
    profile: defaultParticipantProfile('Legacy'),
  });
  const lb = store.getAgent(legacy.id);
  check(`${label}: a row without permission reads as custom`, lb ? participantPermissionOf(lb).level === 'custom' : false);
  return JSON.stringify([back?.profile?.permission, lb?.profile?.permission ?? null]);
}

function exerciseCallPlan(): void {
  console.log('\n[plan] participantCallPlan — 2026-10-19 rule');
  const plan = (inLevel: boolean, approval: 'auto' | 'always', policyEffect?: 'allow' | 'ask' | 'deny', reachable = true) =>
    participantCallPlan({ inLevel, approval, ...(policyEffect ? { policyEffect } : {}), reachable });
  check('in level, switch off → policy only (runs without asking, even where a baseline would ask)', plan(true, 'auto') === 'policy');
  check('in level, switch off, no approval channel → still runs (policy only)', plan(true, 'auto', undefined, false) === 'policy');
  check('in level + policy ask rule → policy (the user’s own rule asks once)', plan(true, 'auto', 'ask') === 'policy');
  check('out of level → ask', plan(false, 'auto') === 'ask');
  check('out of level + policy allow rule → still ask', plan(false, 'auto', 'allow') === 'ask');
  check('out of level, no approval channel → refuse', plan(false, 'auto', undefined, false) === 'refuse');
  check('switch on, in-level read → ask', plan(true, 'always') === 'ask');
  check('switch on, no approval channel → refuse', plan(true, 'always', undefined, false) === 'refuse');
  check(
    'policy deny beats everything → policy (it denies, nobody asked)',
    plan(true, 'auto', 'deny') === 'policy' &&
      plan(false, 'auto', 'deny', false) === 'policy' &&
      plan(true, 'always', 'deny') === 'policy',
  );
}

function exerciseApproved(): void {
  console.log('\n[approved] withApprovedTool / isApprovedTool — R10.7');
  const auto = { level: 'read' as const, approval: 'auto' as const };
  const one = withApprovedTool(auto, 'send_message');
  check('allow remembers the tool', JSON.stringify(one.approvedTools) === '["send_message"]' && isApprovedTool(one, 'send_message'));
  check('remembering twice keeps one entry (same object back)', withApprovedTool(one, 'send_message') === one);
  check('nothing is recorded while the switch is on', withApprovedTool({ level: 'read', approval: 'always' }, 'send_message').approvedTools === undefined);
  check('a blank name is not recorded', withApprovedTool(auto, '  ') === auto);
  check('the input is not mutated', auto.hasOwnProperty('approvedTools') === false);
  const base = defaultParticipantProfile('A');
  const parsed = parseParticipantProfile({ ...base, permission: { level: 'none', approvedTools: [' x ', 'x', 'y', ''] } });
  check('the profile gate trims and de-duplicates approvedTools', JSON.stringify(parsed.permission?.approvedTools) === '["x","y"]');
  check('an empty list reads as absent', parseParticipantProfile({ ...base, permission: { level: 'none', approvedTools: [] } }).permission?.approvedTools === undefined);
  check('a non-string entry is refused', throws(() => parseParticipantProfile({ ...base, permission: { level: 'none', approvedTools: [1] } }), /approvedTools/));
  check(
    'participantPermissionOf keeps the remembered list',
    JSON.stringify(participantPermissionOf({ profile: { permission: { level: 'read', approvedTools: ['z'] } } }).approvedTools) === '["z"]',
  );
}

function main(): void {
  exerciseTiers();
  exerciseLevels();
  exerciseLegacy();
  exerciseResolve();
  exerciseCallPlan();
  exerciseApproved();
  exerciseGate();
  console.log('\n[store] both drivers');
  const mem = exerciseStore('memory', new MemoryStore());
  const dir = mkdtempSync(join(tmpdir(), 'naby-participant-permission-'));
  const sqlite = new SqliteStore({ path: join(dir, 'app.db') });
  const sql = exerciseStore('sqlite', sqlite);
  sqlite.close();
  check('memory and sqlite agree', mem === sql, `memory=${mem} sqlite=${sql}`);

  console.log('');
  if (failures === 0) {
    console.log(`PASS — ${passes}/${passes} participant permission checks.`);
    process.exit(0);
  }
  console.error(`FAIL — ${failures} of ${passes + failures} check(s) failed.`);
  process.exit(1);
}

main();
