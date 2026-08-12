// src/spikes/spike-harness-seed.ts
//
// THE BUILT-IN HARNESS BUNDLES — verification (skill-hub-builtin §2.7).
//
// naby ships three harness artifacts in TWO bundles. `cic` owns the
// `confluence-context` skill and the `confluence-researcher` subagent: together
// they are one capability — ask the company wiki — and that capability is
// worthless without the `cic` MCP server, because the subagent's only four tools
// are cic's. `atlassian` owns the `confluence-upload` skill, which drives the
// confUploader CLI; its switch is the atlassian preset because that preset already
// collects the same three Confluence values the CLI needs. This spike proves the
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
//   (g) A SECOND BUNDLE IS A SECOND SWITCH, AND THE TWO DO NOT TOUCH. atlassian's
//       save/remove moves `confluence-upload` and NOTHING else; cic's moves the
//       other two and not it. Plus the case a save/remove cannot cover: a skill
//       that ships LATER than its preset. The atlassian preset has existed since
//       0.2.0, so an existing user will never save it again — `activeBundles` makes
//       the boot seed arrive enabled for them, while still arriving disabled for
//       someone who has not configured the preset.
//   (h) THE TWO SKILLS FIT IN ONE TURN. Both declare `confluence` as a trigger,
//       because both are about Confluence — so a turn naming it wants BOTH, and
//       skill-inject ranks by scope-then-recency with no relevance signal. At the
//       old 2000-token budget their sum (2828) did not fit and the loser was picked
//       by seed order, which for an upload request meant the model got the RESEARCH
//       skill and reached for a page-create path that mangles markdown. This checks
//       the budget the shell actually uses, read out of the shell's own source.
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
  ATLASSIAN_HARNESS_BUNDLE_ID,
  builtinHarnessAutoStatusKey,
  builtinHarnessOrigin,
  bundleOwning,
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
const UPLOAD = 'confluence-upload';

/** The shell's per-turn skill budget, READ OUT OF THE SHELL rather than restated.
 *  Every budget claim below is measured against the number the engine will really
 *  use, so lowering it there fails here instead of quietly killing a skill. */
function shellSkillTokenBudget(): number {
  const src = readFileSync(
    resolve(ROOT, 'shell/packages/feature/agent/src/server/engines/naby.ts'),
    'utf8',
  );
  const m = src.match(/const SKILL_TOKEN_BUDGET = (\d[\d_]*);/);
  if (!m) throw new Error('SKILL_TOKEN_BUDGET not found in the shell engine');
  return Number(m[1]!.replace(/_/g, ''));
}

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

  // The upload skill is TOOL-BEARING, and that is the point: it does its work by
  // running a CLI, so a turn with no shell (an unprojected session has no
  // `run_command` executor — fs-tools registers it only with a cwd) must not be
  // handed 1.1k tokens telling it to run one. skill-inject holds it back and
  // COUNTS it (excludedForTools), which is the observable form of that decision.
  const upload = BUILTIN_HARNESS_ASSETS.find((a) => a.name === UPLOAD)!;
  record(
    '(a) the upload skill declares the one tool it actually needs: run_command',
    upload.kind === 'skill' &&
      (upload.toolRefs ?? []).join(',') === 'run_command' &&
      (upload.triggers?.length ?? 0) > 0,
    `toolRefs=${(upload.toolRefs ?? []).join(',') || 'NONE'}; triggers=${upload.triggers?.length ?? 0}`,
  );

  // What the naby edit is FOR. The upstream document told the model to reach for
  // `AskUserQuestion` and described "Claude Code's Bash tool"; naby denies the
  // former outright (claude-agent-sdk-engine NATIVE_ASK_USER_QUESTION_TOOL) and
  // does not have the latter. A skill body that names tools naby refuses is a skill
  // that stalls at the first question it needs to ask.
  const uploadBody = harnessAssetBody(upload.raw);
  // The upstream told the model to ASK with `AskUserQuestion` ("… `AskUserQuestion`
  // 또는 …", "… `AskUserQuestion` 으로 묻기"). The shipped body may only name that
  // tool to say naby does not have it; every instruction to ask must point at
  // naby's answer (a direct question, or `naby_checkin` for a decision).
  const instructsAsk = /`AskUserQuestion`\s*(또는|으로|로)\b/.test(uploadBody);
  record(
    '(a) the shipped body names no tool naby denies, and names the ones it has',
    !instructsAsk &&
      uploadBody.includes('`AskUserQuestion` 도구가 없다') &&
      !/Claude Code의 `Bash`/.test(uploadBody) &&
      uploadBody.includes('`run_command`') &&
      uploadBody.includes('`naby_checkin`'),
    `instructs AskUserQuestion: ${instructsAsk ? 'STILL THERE' : 'no'}; ` +
      `states naby lacks it: ${uploadBody.includes('`AskUserQuestion` 도구가 없다')}; ` +
      `run_command named: ${uploadBody.includes('`run_command`')}; ` +
      `naby_checkin offered instead: ${uploadBody.includes('`naby_checkin`')}`,
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
  const upload = rowFor(store, UPLOAD);
  record(
    '(b) all three items seed, DISABLED — a skill with no server must not fire',
    first.seeded.length === BUILTIN_HARNESS_ASSETS.length &&
      skill?.status === 'disabled' &&
      agent?.status === 'disabled' &&
      upload?.status === 'disabled',
    `seeded=${first.seeded.join(',')}; statuses=${skill?.status}/${agent?.status}/${upload?.status}`,
  );

  record(
    '(b) the upload row carries its trigger list and its tool requirement',
    (upload?.skill?.triggers?.length ?? 0) > 0 &&
      (upload?.skill?.toolRefs ?? []).join(',') === 'run_command',
    `triggers=${(upload?.skill?.triggers ?? []).join(', ')}; toolRefs=${(upload?.skill?.toolRefs ?? []).join(',')}`,
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
      second.kept.length === BUILTIN_HARNESS_ASSETS.length &&
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
// (g) a second bundle, a second switch — and the seed-time case a switch misses
// ---------------------------------------------------------------------------

function checkSecondBundle(): void {
  const cic = BUILTIN_HARNESS_BUNDLES[CIC_HARNESS_BUNDLE_ID] ?? [];
  const atl = BUILTIN_HARNESS_BUNDLES[ATLASSIAN_HARNESS_BUNDLE_ID] ?? [];
  record(
    '(g) the bundles are disjoint, and every shipped asset belongs to exactly one',
    atl.join(',') === UPLOAD &&
      cic.every((n) => !atl.includes(n)) &&
      BUILTIN_HARNESS_ASSETS.every((a) => bundleOwning(a.name) !== undefined) &&
      bundleOwning(UPLOAD) === ATLASSIAN_HARNESS_BUNDLE_ID &&
      bundleOwning(SKILL) === CIC_HARNESS_BUNDLE_ID,
    `atlassian=[${atl.join(',')}]; cic=[${cic.join(',')}]; unowned=${
      BUILTIN_HARNESS_ASSETS.filter((a) => !bundleOwning(a.name))
        .map((a) => a.name)
        .join(',') || 'none'
    }`,
  );

  // Saving the atlassian credential moves ITS item and nothing else. This is the
  // check that would have caught a bundle table where one name appeared twice.
  const store = seeded();
  const on = applyBuiltinHarnessActivation(store, ATLASSIAN_HARNESS_BUNDLE_ID, true);
  record(
    '(g) saving atlassian enables ONLY the upload skill — cic\'s two stay off',
    on.changed.join(',') === UPLOAD &&
      rowFor(store, UPLOAD)?.status === 'enabled' &&
      rowFor(store, SKILL)?.status === 'disabled' &&
      rowFor(store, SUBAGENT)?.status === 'disabled',
    `changed=${on.changed.join(',')}; upload=${rowFor(store, UPLOAD)?.status}; ` +
      `context=${rowFor(store, SKILL)?.status}; researcher=${rowFor(store, SUBAGENT)?.status}`,
  );

  // ...and the cic switch does not reach across either.
  const cicOn = applyBuiltinHarnessActivation(store, CIC_HARNESS_BUNDLE_ID, true);
  const atlOff = applyBuiltinHarnessActivation(store, ATLASSIAN_HARNESS_BUNDLE_ID, false);
  record(
    '(g) removing atlassian disables only the upload skill — cic keeps running',
    cicOn.changed.length === 2 &&
      atlOff.changed.join(',') === UPLOAD &&
      rowFor(store, UPLOAD)?.status === 'disabled' &&
      rowFor(store, SKILL)?.status === 'enabled',
    `cic changed=${cicOn.changed.join(',')}; atlassian off changed=${atlOff.changed.join(',')}; ` +
      `upload=${rowFor(store, UPLOAD)?.status}; context=${rowFor(store, SKILL)?.status}`,
  );

  // THE CASE THE SWITCH CANNOT REACH. The atlassian preset shipped in 0.2.0; this
  // skill ships now. An existing user saved that credential long ago and will never
  // save it again, so without a seed-time answer the row would arrive disabled and
  // stay there — a shipped feature nobody is told to turn on.
  const existing = new MemoryStore();
  const early = seedBuiltinHarness(existing, {
    activeBundles: [ATLASSIAN_HARNESS_BUNDLE_ID],
  });
  record(
    '(g) a user who configured atlassian LAST YEAR gets the new skill switched on',
    early.seeded.length === BUILTIN_HARNESS_ASSETS.length &&
      rowFor(existing, UPLOAD)?.status === 'enabled' &&
      existing.getSetting(builtinHarnessAutoStatusKey(UPLOAD)) === 'enabled',
    `upload=${rowFor(existing, UPLOAD)?.status}; ` +
      `autoStatus=${existing.getSetting(builtinHarnessAutoStatusKey(UPLOAD))}`,
  );

  record(
    '(g) ...and the bundles whose server is NOT configured still arrive disabled',
    rowFor(existing, SKILL)?.status === 'disabled' &&
      rowFor(existing, SUBAGENT)?.status === 'disabled',
    `context=${rowFor(existing, SKILL)?.status}; researcher=${rowFor(existing, SUBAGENT)?.status}`,
  );

  // The record written at seed time is what makes ownership decidable afterwards:
  // an item seeded ENABLED and then turned off by hand must stay off when the
  // credential is re-saved, exactly like one that was switched on later.
  existing.setHarnessEnabled(rowFor(existing, UPLOAD)!.id, false);
  const resaved = applyBuiltinHarnessActivation(existing, ATLASSIAN_HARNESS_BUNDLE_ID, true);
  record(
    '(g) an item seeded ON and then turned OFF by hand stays off through a re-save',
    resaved.userOwned.includes(UPLOAD) &&
      resaved.changed.length === 0 &&
      rowFor(existing, UPLOAD)?.status === 'disabled',
    `userOwned=${resaved.userOwned.join(',')}; status=${rowFor(existing, UPLOAD)?.status}`,
  );

  // An unknown bundle id is inert rather than fatal — the seed must not care that
  // some caller knows about a preset this build does not.
  const unknown = new MemoryStore();
  seedBuiltinHarness(unknown, { activeBundles: ['no-such-bundle'] });
  record(
    '(g) an unknown active bundle changes nothing',
    rowFor(unknown, UPLOAD)?.status === 'disabled' && rowFor(unknown, SKILL)?.status === 'disabled',
    `upload=${rowFor(unknown, UPLOAD)?.status}; context=${rowFor(unknown, SKILL)?.status}`,
  );

  // And the default — no `activeBundles` at all — is byte-for-byte the old
  // behaviour, which is what keeps the cic path unchanged by this parameter.
  const plain = new MemoryStore();
  seedBuiltinHarness(plain);
  record(
    '(g) with no activeBundles argument, seeding is exactly what it always was',
    BUILTIN_HARNESS_ASSETS.every((a) => {
      const row = plain.listHarness('user', DEFAULT_USER_ID, { kind: a.kind }).find((r) => r.name === a.name);
      return row?.status === 'disabled' && plain.getSetting(builtinHarnessAutoStatusKey(a.name)) === 'disabled';
    }),
    `all ${BUILTIN_HARNESS_ASSETS.length} rows disabled with autoStatus 'disabled'`,
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
  const SKILL_BUDGET = shellSkillTokenBudget();
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
// (h) the upload skill: which turns reach it, and whether it fits
// ---------------------------------------------------------------------------

/** Turns that must reach `confluence-upload`. Note the third and fourth: they carry
 *  no full "confluence"/"컨플루언스" at all, which is why the trigger list also has
 *  the abbreviation people type and the CLI's own name. The fifth is a pasted parent
 *  page URL — the strongest upload signal there is, and it names no product. */
const UPLOAD_TURNS = [
  '이 md 파일을 컨플루언스에 올려줘',
  'design.md를 confluence 부모 페이지 아래 자식으로 올려줘',
  '컨플에 올려줘',
  'confupload로 문서 세 개 정리해서 올려줘',
  '이 문서를 https://altimedia.atlassian.net/wiki/spaces/ENG/pages/123/Design 아래에 붙여줘',
];

/** Ordinary work in a coding agent, four of which are ABOUT UPLOADING SOMETHING
 *  ELSE. This corpus is the reason `업로드`/`upload` are NOT triggers: as raw
 *  substrings (skill-inject matches with `includes`) they are among the most common
 *  words in a product codebase, and each false positive costs a 1.1k-token document
 *  on a turn that will never touch Confluence. */
const UPLOAD_DECOYS = [
  '파일 업로드 API 만들어줘',
  's3 uploadFile이 왜 실패하는지 봐줘',
  '이미지 업로드 컴포넌트에 진행률 붙여줘',
  'review the multipart upload retry logic',
  '이 함수 리팩터링해줘',
  '이 테스트가 왜 실패하는지 봐줘',
  'rename this variable and update the callers',
  '사내 위키에서 그 용어 찾아줘',
];

function checkUploadTriggersAndBudget(): void {
  const budget = shellSkillTokenBudget();
  const store = seeded();
  applyBuiltinHarnessActivation(store, CIC_HARNESS_BUNDLE_ID, true);
  applyBuiltinHarnessActivation(store, ATLASSIAN_HARNESS_BUNDLE_ID, true);
  const upload = rowFor(store, UPLOAD)!;
  const context = rowFor(store, SKILL)!;
  const triggers = upload.skill?.triggers ?? [];
  // A turn that can run commands — what the upload skill needs to participate.
  const withShell = new Set(['read_file', 'write_file', 'run_command']);

  record(
    '(h) the upload skill declares the two words the request always contains',
    triggers.includes('confluence') && triggers.includes('컨플루언스'),
    `triggers=${triggers.join(', ')}`,
  );

  const missed = UPLOAD_TURNS.filter((t) => !skillMatchesTurn(upload, t));
  record(
    '(h) every way a person asks for an upload reaches it',
    missed.length === 0,
    `${UPLOAD_TURNS.length} turns, all matched: ${missed.length === 0 ? 'yes' : `NO — missed ${JSON.stringify(missed)}`}`,
  );

  const leaked = UPLOAD_DECOYS.filter((t) => skillMatchesTurn(upload, t));
  record(
    '(h) an ordinary turn about uploading something else does NOT reach it',
    leaked.length === 0,
    `${UPLOAD_DECOYS.length} decoys, none matched: ${leaked.length === 0 ? 'yes' : `NO — leaked ${JSON.stringify(leaked)}`}`,
  );

  // THE MEASUREMENT THAT DECIDED THE TRIGGER LIST. `업로드`/`upload` look like the
  // obvious triggers for an upload skill and are exactly wrong: substring-matched,
  // they fire on the decoy corpus. Kept as a check so a later "just add upload"
  // has to look at this number first.
  const naive: HarnessItem = {
    ...upload,
    skill: { ...upload.skill!, triggers: ['업로드', 'upload'] },
  };
  const naiveHits = UPLOAD_DECOYS.filter((t) => skillMatchesTurn(naive, t));
  record(
    '(h) ...whereas `업로드`/`upload` as triggers would fire on unrelated work',
    naiveHits.length >= 4 && leaked.length === 0,
    `naive triggers hit ${naiveHits.length}/${UPLOAD_DECOYS.length}: ${JSON.stringify(naiveHits)}`,
  );

  // A skill nobody can inject is a dead row. The upstream document was 2585 tokens
  // — over the budget BY ITSELF, so it would have been dropped on every turn it
  // ever matched. This is the check that made compressing it a precondition.
  const uploadCost = estimateTokens(renderSkillBlock(upload));
  const contextCost = estimateTokens(renderSkillBlock(context));
  record(
    '(h) the shipped body fits the turn budget ON ITS OWN — otherwise it is a dead row',
    uploadCost <= budget,
    `upload=${uploadCost} tokens vs budget ${budget} (${Math.round((uploadCost / budget) * 100)}%); ` +
      `the upstream 265-line original was 2585 — over a 2000 budget by itself`,
  );

  // BOTH skills fire on any turn naming Confluence, because both are about
  // Confluence. Ranking has no relevance signal (scope, then recency), so if they
  // do not both fit, the survivor is decided by seed order rather than by the
  // request — and for "upload this md" the survivor was the RESEARCH skill.
  const enabled = store.listHarness('user', DEFAULT_USER_ID, { kind: 'skill', status: 'enabled' });
  const both = selectSkillsForInjection(enabled, UPLOAD_TURNS[0]!, budget, withShell);
  record(
    '(h) a turn that names Confluence gets BOTH — no coin flip between them',
    both.skills.length === 2 &&
      both.droppedForBudget === 0 &&
      both.tokensUsed === uploadCost + contextCost &&
      both.tokensUsed <= budget,
    `injected=${both.skills.map((s) => s.name).join(',')}; used=${both.tokensUsed}` +
      ` (${contextCost}+${uploadCost}) of ${budget}; dropped=${both.droppedForBudget}`,
  );

  // The regression this budget change fixed, pinned so it cannot come back
  // silently: at the old 2000 the pair did not fit and the upload skill lost.
  const old = selectSkillsForInjection(enabled, UPLOAD_TURNS[0]!, 2000, withShell);
  record(
    '(h) ...which at the OLD 2000 budget it did not — one was dropped and counted',
    old.skills.length === 1 && old.droppedForBudget === 1,
    `at 2000: injected=${old.skills.map((s) => s.name).join(',')}; dropped=${old.droppedForBudget}` +
      ` — the pair costs ${uploadCost + contextCost}`,
  );

  // Tool gating, the other half of "never half-run": no shell this turn, no
  // instructions telling the model to run a CLI. Held back AND counted.
  const noShell = selectSkillsForInjection(enabled, UPLOAD_TURNS[0]!, budget, new Set(['read_file']));
  record(
    '(h) a turn with no run_command is not handed a CLI runbook — held and counted',
    noShell.excludedForTools === 1 && !noShell.skills.some((s) => s.name === UPLOAD),
    `excludedForTools=${noShell.excludedForTools}; injected=${noShell.skills.map((s) => s.name).join(',') || 'none'}`,
  );

  // And the quiet turns stay quiet for the pair, not just for one of them.
  const quiet = selectSkillsForInjection(enabled, QUIET_TURNS[0]!, budget, withShell);
  record(
    '(h) an ordinary coding turn still pays ZERO for either built-in skill',
    quiet.skills.length === 0 && quiet.tokensUsed === 0,
    `turn=${JSON.stringify(QUIET_TURNS[0])}; injected=${quiet.skills.length}; used=${quiet.tokensUsed}`,
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
  checkSecondBundle();
  checkTriggerGating();
  checkUploadTriggersAndBudget();
  checkToolRefSpellings();
  checkEngineSource();

  console.log('\n=== SPIKE-HARNESS-SEED — the built-in Confluence bundles and their switches ===\n');
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
