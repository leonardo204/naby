// src/spikes/spike-harness-seed.ts
//
// THE BUILT-IN HARNESS BUNDLE — verification (skill-hub-builtin §2.7).
//
// naby ships two harness artifacts: the `confluence-context` skill and the
// `confluence-researcher` subagent. Together they are one capability — ask the
// company wiki — and that capability is worthless without the `cic` MCP server,
// because the subagent's only four tools are cic's. This spike proves the three
// claims that make shipping them safe rather than annoying:
//
//   (a) THE COMPILED COPY IS THE FILE. `harness-assets/generated.ts` is a build
//       product of two `.md` documents that are kept VERBATIM in the tree. The
//       runtime carries the compiled copy because a path-resolving read is a known
//       trap in the packaged app (packaging-path-resolution.md) — so the only thing
//       that can go wrong is drift, and this re-reads both files and compares byte
//       for byte.
//   (b) SEEDING IS INERT AND POLITE. Rows arrive disabled; a second boot writes
//       nothing; an edited item is never rewritten; a deleted one never returns.
//   (f) IT FIRES ON THE TURNS THAT WANT IT, AND COSTS NOTHING ON THE REST. The
//       skill body is ~1.7k tokens against a 2000-token skill budget, so an
//       always-on version (a skill with NO triggers, per skill-inject.ts) would tax
//       almost every turn to answer the few that ask about the company wiki. Its
//       frontmatter therefore declares triggers, and this asserts both directions:
//       'cic에서 …' reaches it, '이 함수 리팩터링해줘' does not.
//   (c) THE CREDENTIAL IS THE SWITCH, AND THE USER OUTRANKS IT. Saving a cic token
//       enables both; removing it disables both; and an item the user turned off by
//       hand stays off through any number of save/remove cycles. That last one is
//       the whole point — an automatic switch that can undo a person's explicit
//       choice makes the choice meaningless, which is the same rule the import gate
//       states for re-scans (harness-gate invariants 5 and 7).
//
// It also proves the thing that silently defeated all of the above the first time
// it was wired: A SUBAGENT FILE NAMES ITS TOOLS IN A SPELLING NABY DOES NOT USE.
// `tools: mcp__cic__find_docs` versus naby's `cic__find_docs`, and on the Agent SDK
// path a third spelling again (`mcp__nabytools__cic__find_docs`, because naby
// re-exports every tool through one in-process server). Matched literally, the
// subagent gets NO TOOLS — and still runs, and still answers, reporting only its
// own failure. So (d) asserts the matcher and (e) asserts the Agent SDK
// re-qualification.
//
// No filesystem writes, no sqlite file, no network: MemoryStore plus two reads of
// the repo's own asset files.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_HARNESS_ASSETS } from '../runtime/harness-assets/generated.js';
import {
  applyBuiltinHarnessActivation,
  builtinHarnessAutoStatusKey,
  builtinHarnessOrigin,
  BUILTIN_HARNESS_BUNDLES,
  CIC_HARNESS_BUNDLE_ID,
  harnessAssetBody,
  seedBuiltinHarness,
} from '../runtime/harness-seed.js';
import { parseToolRefs, resolveToolRefs, toolRefsAllow } from '../runtime/delegate.js';
import { qualifiedToolName } from '../runtime/mcp.js';
import { DEFAULT_USER_ID, estimateTokens } from '../runtime/memory-inject.js';
import {
  renderSkillBlock,
  selectSkillsForInjection,
  skillMatchesTurn,
} from '../runtime/skill-inject.js';
import { MemoryStore } from '../runtime/store/memory-store.js';
import type { HarnessItem } from '../runtime/store/store.js';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SKILL = 'confluence-context';
const SUBAGENT = 'confluence-researcher';

function rowFor(store: MemoryStore, name: string): HarnessItem | undefined {
  const asset = BUILTIN_HARNESS_ASSETS.find((a) => a.name === name)!;
  return store.listHarness('user', DEFAULT_USER_ID, { kind: asset.kind }).find((r) => r.name === name);
}

function seeded(): MemoryStore {
  const store = new MemoryStore();
  seedBuiltinHarness(store);
  return store;
}

// ---------------------------------------------------------------------------
// (a) the compiled copy IS the file
// ---------------------------------------------------------------------------

function checkAssetsAreVerbatim(): void {
  let allMatch = true;
  const detail: string[] = [];
  for (const asset of BUILTIN_HARNESS_ASSETS) {
    const onDisk = readFileSync(resolve(ROOT, asset.sourcePath), 'utf8');
    const same = onDisk === asset.raw;
    if (!same) allMatch = false;
    detail.push(`${asset.sourcePath}: ${same ? 'identical' : 'DRIFTED'} (${asset.raw.length} chars)`);
  }
  record(
    '(a) generated.ts holds the .md files byte for byte',
    allMatch,
    detail.join('; ') + ' — regenerate with `node scripts/gen-builtin-harness.mjs`',
  );

  const skill = BUILTIN_HARNESS_ASSETS.find((a) => a.name === SKILL)!;
  const agent = BUILTIN_HARNESS_ASSETS.find((a) => a.name === SUBAGENT)!;
  record(
    '(a) frontmatter parsed at build time: kinds, model, tools, triggers',
    skill.kind === 'skill' &&
      skill.toolRefs === undefined &&
      (skill.triggers?.length ?? 0) > 0 &&
      agent.kind === 'subagent' &&
      agent.model === 'opus' &&
      (agent.toolRefs?.length ?? 0) === 4,
    `skill.toolRefs=${String(skill.toolRefs)} (none, so skill-inject never withholds it); ` +
      `skill.triggers=${skill.triggers?.length ?? 0} hints; ` +
      `agent.model=${agent.model}; agent.toolRefs=${agent.toolRefs?.join(',')}`,
  );

  const body = harnessAssetBody(skill.raw);
  record(
    '(a) the injected body is the document WITHOUT its frontmatter',
    !body.startsWith('---') && body.includes('# confluence-context'),
    `body starts: ${JSON.stringify(body.slice(0, 40))}`,
  );
}

// ---------------------------------------------------------------------------
// (b) seeding is inert and polite
// ---------------------------------------------------------------------------

function checkSeeding(): void {
  const store = new MemoryStore();
  const first = seedBuiltinHarness(store);
  const skill = rowFor(store, SKILL);
  const agent = rowFor(store, SUBAGENT);
  record(
    '(b) both items seed, DISABLED — a skill that cannot research must not fire',
    first.seeded.length === 2 && skill?.status === 'disabled' && agent?.status === 'disabled',
    `seeded=${first.seeded.join(',')}; statuses=${skill?.status}/${agent?.status}`,
  );

  record(
    '(b) provenance is a non-path handle, so the delete tier tombstones it',
    skill?.provenance.source === 'artifact' &&
      skill?.provenance.origin === builtinHarnessOrigin(SKILL) &&
      !skill.provenance.origin.includes('/'),
    `source=${skill?.provenance.source}; origin=${skill?.provenance.origin}`,
  );

  record(
    '(b) the subagent row carries its model and its tool allow-list',
    agent?.subagent?.model === 'opus' && agent.subagent.toolRefs?.[0] === 'mcp__cic__find_docs',
    `model=${agent?.subagent?.model}; toolRefs[0]=${agent?.subagent?.toolRefs?.[0]}`,
  );

  const before = rowFor(store, SKILL)!;
  const second = seedBuiltinHarness(store);
  const after = rowFor(store, SKILL)!;
  record(
    '(b) a second boot seeds nothing and does not touch the row',
    second.seeded.length === 0 &&
      second.kept.length === 2 &&
      after.id === before.id &&
      after.updatedAt === before.updatedAt,
    `seeded=${second.seeded.length}; kept=${second.kept.join(',')}; id stable=${after.id === before.id}`,
  );

  // The user rewrites the skill in their own words.
  store.putHarnessItem({
    item: {
      scope: 'user',
      scopeKey: DEFAULT_USER_ID,
      kind: 'skill',
      name: SKILL,
      provenance: { source: 'user' },
      skill: { instructions: 'my own version' },
    },
    requestedStatus: 'enabled',
  });
  seedBuiltinHarness(store);
  record(
    '(b) a boot NEVER rewrites what the user edited',
    rowFor(store, SKILL)?.skill?.instructions === 'my own version',
    `instructions=${JSON.stringify(rowFor(store, SKILL)?.skill?.instructions)}`,
  );

  // ...and a delete stays deleted (a built-in has no file, so it tombstones).
  const dead = seeded();
  dead.setHarnessStatus(rowFor(dead, SKILL)!.id, 'removed');
  const third = seedBuiltinHarness(dead);
  record(
    '(b) a deleted built-in is not resurrected by the next boot',
    third.seeded.length === 0 && rowFor(dead, SKILL)?.status === 'removed',
    `seeded=${third.seeded.length}; status=${rowFor(dead, SKILL)?.status}`,
  );
}

// ---------------------------------------------------------------------------
// (c) the credential is the switch — and the user outranks it
// ---------------------------------------------------------------------------

function checkActivation(): void {
  const store = seeded();
  const on = applyBuiltinHarnessActivation(store, CIC_HARNESS_BUNDLE_ID, true);
  record(
    '(c) saving the cic token enables the whole bundle',
    on.changed.length === 2 &&
      rowFor(store, SKILL)?.status === 'enabled' &&
      rowFor(store, SUBAGENT)?.status === 'enabled',
    `changed=${on.changed.join(',')}`,
  );

  const again = applyBuiltinHarnessActivation(store, CIC_HARNESS_BUNDLE_ID, true);
  record(
    '(c) re-saving the same credential is a no-op',
    again.changed.length === 0,
    `changed=${again.changed.length}`,
  );

  const off = applyBuiltinHarnessActivation(store, CIC_HARNESS_BUNDLE_ID, false);
  record(
    '(c) removing the preset disables both — no skill firing into an empty toolset',
    off.changed.length === 2 && rowFor(store, SKILL)?.status === 'disabled',
    `changed=${off.changed.join(',')}; skill=${rowFor(store, SKILL)?.status}`,
  );

  // THE REGRESSION. Connect, then turn the skill off by hand, then reconnect.
  const user = seeded();
  applyBuiltinHarnessActivation(user, CIC_HARNESS_BUNDLE_ID, true);
  user.setHarnessEnabled(rowFor(user, SKILL)!.id, false);
  const resaved = applyBuiltinHarnessActivation(user, CIC_HARNESS_BUNDLE_ID, true);
  applyBuiltinHarnessActivation(user, CIC_HARNESS_BUNDLE_ID, false);
  applyBuiltinHarnessActivation(user, CIC_HARNESS_BUNDLE_ID, true);
  record(
    '(c) WHAT THE USER TURNED OFF STAYS OFF, through re-save and reconnect',
    resaved.userOwned.includes(SKILL) &&
      resaved.changed.length === 0 &&
      rowFor(user, SKILL)?.status === 'disabled' &&
      rowFor(user, SUBAGENT)?.status === 'enabled',
    `userOwned=${resaved.userOwned.join(',')}; skill=${rowFor(user, SKILL)?.status}; ` +
      `subagent (untouched by the user)=${rowFor(user, SUBAGENT)?.status}`,
  );

  const early = seeded();
  early.setHarnessEnabled(rowFor(early, SUBAGENT)!.id, true);
  const removed = applyBuiltinHarnessActivation(early, CIC_HARNESS_BUNDLE_ID, false);
  record(
    '(c) an item the user enabled BEFORE any credential is left alone',
    removed.userOwned.includes(SUBAGENT) && rowFor(early, SUBAGENT)?.status === 'enabled',
    `userOwned=${removed.userOwned.join(',')}; status=${rowFor(early, SUBAGENT)?.status}`,
  );

  const dead = seeded();
  dead.setHarnessStatus(rowFor(dead, SKILL)!.id, 'removed');
  const resurrect = applyBuiltinHarnessActivation(dead, CIC_HARNESS_BUNDLE_ID, true);
  record(
    '(c) a tombstone is never resurrected by the switch',
    resurrect.userOwned.includes(SKILL) && rowFor(dead, SKILL)?.status === 'removed',
    `status=${rowFor(dead, SKILL)?.status}`,
  );

  const empty = new MemoryStore();
  const missing = applyBuiltinHarnessActivation(empty, CIC_HARNESS_BUNDLE_ID, true);
  record(
    '(c) the switch reports absent rows rather than creating them',
    missing.missing.length === 2 && missing.changed.length === 0,
    `missing=${missing.missing.join(',')}`,
  );

  const legacy = seeded();
  legacy.setSetting(builtinHarnessAutoStatusKey(SKILL), '');
  const healed = applyBuiltinHarnessActivation(legacy, CIC_HARNESS_BUNDLE_ID, true);
  record(
    '(c) a blank auto-status record reads as the disabled the seed always wrote',
    healed.changed.includes(SKILL),
    `changed=${healed.changed.join(',')}`,
  );

  record(
    '(c) the bundle names exactly the two shipped items',
    (BUILTIN_HARNESS_BUNDLES[CIC_HARNESS_BUNDLE_ID] ?? []).join(',') === `${SKILL},${SUBAGENT}`,
    `bundle=${(BUILTIN_HARNESS_BUNDLES[CIC_HARNESS_BUNDLE_ID] ?? []).join(',')}`,
  );
}

// ---------------------------------------------------------------------------
// (f) the skill is TRIGGERED, not always-on
// ---------------------------------------------------------------------------

/** Turns that must reach the skill — one per trigger family (handle, product name,
 *  Korean product name, wiki, ADR, runbook/on-call, company jargon, team practice). */
const TRIGGERING_TURNS = [
  'cic에서 배포 정책 찾아줘',
  '그 서비스 ADR 어디 있어',
  'confluence에 정리된 내부 정책 좀 보여줘',
  '컨플루언스에서 그 용어 뜻 찾아줘',
  '사내 위키에 이 약칭 설명 있나',
  'the runbook for this alert — where is it',
  '온콜 런북 절차 알려줘',
  '우리 팀 관행이 어떻게 되지',
];

/** Turns that must NOT pay for it: ordinary coding work, answerable from the code
 *  in front of us. This is the whole reason the skill stopped being always-on. */
const QUIET_TURNS = [
  '이 함수 리팩터링해줘',
  '이 테스트가 왜 실패하는지 봐줘',
  'JSON 파싱 유틸 하나 짜줘',
  'rename this variable and update the callers',
];

function checkTriggerGating(): void {
  const asset = BUILTIN_HARNESS_ASSETS.find((a) => a.name === SKILL)!;
  const triggers = asset.triggers ?? [];
  record(
    '(f) the shipped skill DECLARES triggers — no triggers would mean ALWAYS-ON',
    triggers.length > 0 && triggers.includes('cic') && triggers.includes('confluence'),
    `triggers=${triggers.join(', ')}`,
  );

  const store = seeded();
  applyBuiltinHarnessActivation(store, CIC_HARNESS_BUNDLE_ID, true);
  const row = rowFor(store, SKILL)!;
  record(
    '(f) the SEEDED ROW carries them, so the runtime gate sees what the file says',
    (row.skill?.triggers ?? []).join(',') === triggers.join(','),
    `row.skill.triggers=${(row.skill?.triggers ?? []).join(', ') || 'NONE'}`,
  );

  const missed = TRIGGERING_TURNS.filter((t) => !skillMatchesTurn(row, t));
  record(
    '(f) a company-wiki turn matches — including the `cic` handle people actually type',
    missed.length === 0,
    `${TRIGGERING_TURNS.length} turns, all matched: ${missed.length === 0 ? 'yes' : `NO — missed ${JSON.stringify(missed)}`}`,
  );

  // Substring matching is what skill-inject does (case-insensitive `includes`), so
  // a false positive costs tokens, never a wrong action — but the ordinary coding
  // turn is the one that must stay clean, because it is the common case.
  const leaked = QUIET_TURNS.filter((t) => skillMatchesTurn(row, t));
  record(
    '(f) an ordinary coding turn does NOT match — the document stays out',
    leaked.length === 0,
    `${QUIET_TURNS.length} turns, none matched: ${leaked.length === 0 ? 'yes' : `NO — leaked ${JSON.stringify(leaked)}`}`,
  );

  // What the gating is worth, in the unit that motivated it: the skill budget.
  const SKILL_BUDGET = 2000;
  const cost = estimateTokens(renderSkillBlock(row));
  const onQuiet = selectSkillsForInjection([row], QUIET_TURNS[0]!, SKILL_BUDGET);
  const onWiki = selectSkillsForInjection([row], TRIGGERING_TURNS[0]!, SKILL_BUDGET);
  record(
    '(f) so an unrelated turn pays ZERO of the skill budget, and a wiki turn pays once',
    onQuiet.skills.length === 0 &&
      onQuiet.tokensUsed === 0 &&
      onWiki.skills.length === 1 &&
      onWiki.tokensUsed === cost,
    `block=${cost} tokens = ${Math.round((cost / SKILL_BUDGET) * 100)}% of a ${SKILL_BUDGET}-token budget; ` +
      `quiet turn tokensUsed=${onQuiet.tokensUsed}; wiki turn tokensUsed=${onWiki.tokensUsed}`,
  );
}

// ---------------------------------------------------------------------------
// (d) + (e) the three spellings of one tool
// ---------------------------------------------------------------------------

function checkToolRefSpellings(): void {
  // What naby actually calls cic's tools, derived from the SAME function the MCP
  // loader uses — so this cannot pass while the loader names them differently.
  const turnTools = [
    'Read',
    'Bash',
    qualifiedToolName('cic', 'find_docs'),
    qualifiedToolName('cic', 'read_section'),
    qualifiedToolName('cic', 'search_cql'),
    qualifiedToolName('cic', 'read_page'),
    qualifiedToolName('skill-hub', 'list'),
  ];
  record(
    '(d) naby names an MCP tool <server>__<tool>, with no mcp__ prefix',
    turnTools[2] === 'cic__find_docs',
    `qualifiedToolName('cic','find_docs')=${turnTools[2]}`,
  );

  const agent = BUILTIN_HARNESS_ASSETS.find((a) => a.name === SUBAGENT)!;
  const refs = [...(agent.toolRefs ?? [])];
  const { matched, unmatched } = resolveToolRefs(refs, turnTools);
  record(
    "(d) the subagent's own mcp__cic__* list resolves onto all four cic tools",
    matched.length === 4 && matched.every((m) => m.startsWith('cic__')) && unmatched.length === 0,
    `refs=${refs.join(',')} -> matched=${matched.join(',')}; unmatched=${unmatched.join(',') || 'none'}`,
  );

  const allow = parseToolRefs(refs);
  record(
    '(d) narrowing still NARROWS — nothing outside cic gets in',
    !toolRefsAllow(allow, 'Bash') &&
      !toolRefsAllow(allow, 'skill-hub__list') &&
      toolRefsAllow(allow, 'cic__find_docs'),
    'Bash=denied; skill-hub__list=denied; cic__find_docs=allowed',
  );

  const wholeServer = resolveToolRefs(['mcp__cic'], turnTools);
  record(
    '(d) a two-segment mcp__<server> ref means the whole server',
    wholeServer.matched.length === 4 && wholeServer.unmatched.length === 0,
    `matched=${wholeServer.matched.join(',')}`,
  );

  const builtins = resolveToolRefs(['Read', 'mcp__cic__find_docs'], turnTools);
  record(
    '(d) a plain built-in name is matched literally, never mangled',
    builtins.matched.includes('Read') && builtins.matched.includes('cic__find_docs'),
    `matched=${builtins.matched.join(',')}`,
  );

  const stale = resolveToolRefs(['mcp__cic__find_docs', 'Grep'], ['cic__find_docs']);
  record(
    '(d) a ref this turn cannot satisfy is REPORTED, not silently dropped',
    stale.matched.join(',') === 'cic__find_docs' && stale.unmatched.join(',') === 'Grep',
    `matched=${stale.matched.join(',')}; unmatched=${stale.unmatched.join(',')}`,
  );

  // (e) The Agent SDK sees a THIRD spelling: naby re-exports every tool through one
  // in-process MCP server, so the backend's name carries `nabytools` in the middle.
  // Asserted against the engine's own function, and against its source, so a rename
  // of the server constant cannot pass here while breaking there.
  const sdkNames = sdkToolNamesFor(refs, turnTools);
  record(
    '(e) the Agent SDK path re-qualifies matches into the nabytools namespace',
    sdkNames.length === 4 && sdkNames.every((n) => n.startsWith('mcp__nabytools__cic__')),
    `tools=${sdkNames.join(', ')}`,
  );

  // A ref naming a tool NABY DOES NOT HAVE is how a spec asks for an SDK BUILT-IN
  // (`Grep` is the backend's, not ours). It must survive unqualified: re-qualifying
  // it would point at a tool inside naby's server that does not exist, and dropping
  // it would silently take a capability away from an imported subagent.
  const withBuiltin = sdkToolNamesFor(['Grep', 'mcp__cic__find_docs'], turnTools);
  record(
    '(e) an SDK built-in naby does not offer passes through unqualified',
    withBuiltin.includes('Grep') &&
      withBuiltin.includes('mcp__nabytools__cic__find_docs') &&
      !withBuiltin.includes('mcp__nabytools__Grep'),
    `tools=${withBuiltin.join(', ')}`,
  );

  // ...whereas a tool naby DOES offer under that name is naby's own, and is
  // re-qualified like any other, because that is where the backend will find it.
  const ourRead = sdkToolNamesFor(['Read'], turnTools);
  record(
    "(e) a tool naby offers is re-qualified even when it shares a built-in's name",
    ourRead.join(',') === 'mcp__nabytools__Read',
    `tools=${ourRead.join(', ')}`,
  );
}

/** `sdkAgentTools` without importing the engine module (which loads the SDK
 *  resolver): the same two lines, kept honest by the source assertion below. */
function sdkToolNamesFor(refs: readonly string[], toolNames: readonly string[]): string[] {
  const { matched, unmatched } = resolveToolRefs(refs, toolNames);
  return [...matched.map((n) => `mcp__nabytools__${n}`), ...unmatched];
}

function checkEngineSource(): void {
  const src = readFileSync(resolve(ROOT, 'src/engines/claude-agent-sdk-engine.ts'), 'utf8');
  record(
    "(e) the engine really does hand `agents` the re-qualified list",
    /tools: sdkAgentTools\(s\.toolRefs, input\.toolSchemas\)/.test(src) &&
      /const MCP_SERVER_NAME = 'nabytools'/.test(src) &&
      /matched\.map\(\(n\) => `mcp__\$\{MCP_SERVER_NAME\}__\$\{n\}`\)/.test(src),
    'claude-agent-sdk-engine.ts: subagent tools -> sdkAgentTools -> mcp__nabytools__<naby name>',
  );
}

function main(): boolean {
  checkAssetsAreVerbatim();
  checkSeeding();
  checkActivation();
  checkTriggerGating();
  checkToolRefSpellings();
  checkEngineSource();

  console.log('\n=== SPIKE-HARNESS-SEED — the built-in Confluence bundle and its switch ===\n');
  let allPass = true;
  for (const c of checks) {
    const tag = c.pass ? 'PASS' : 'FAIL';
    if (!c.pass) allPass = false;
    console.log(`[${tag}] ${c.name}`);
    console.log(`        evidence: ${c.evidence}`);
  }
  console.log(
    `\nSPIKE-HARNESS-SEED: ${allPass ? 'ALL PASS' : 'FAILURES PRESENT'} (${checks.filter((c) => c.pass).length}/${checks.length})\n`,
  );
  return allPass;
}

try {
  if (!main()) process.exitCode = 1;
} catch (e) {
  console.error('SPIKE-HARNESS-SEED crashed:', e);
  process.exitCode = 1;
}
