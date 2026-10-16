// src/spikes/spike-participant-import.ts
//
// multi-agent-chat MAC-M4 verification — PARTICIPANT IMPORT ADAPTERS AND THE
// SIDECAR v2 EXPORT (specs/agent-import-adapters.md §6).
//
// Asserted, against the fixtures in src/spikes/fixtures/import/:
//   (a) detection picks the right adapter for each format, and refuses garbage;
//   (b) each adapter's mapping (§3.1–§3.3) and its loss report;
//   (c) the pipeline (§4): a free name, secrets redacted, tools/MCP/skills only
//       when this machine has them, size limits, ignored keys, provenance, the
//       profile gate;
//   (d) ADVERSARIAL: a file that plants id / kind:'persona' / stage:'butterfly' /
//       trusted / autonomy / toolRefs:['Bash'] gets none of it; secrets are
//       masked; name collisions rename; formatVersion 3 is refused; a PNG with
//       no card chunk is refused; an icon over 64 KB falls back to the emoji; the
//       21st lorebook entry is dropped;
//   (e) the export (§5): `.md` frontmatter Claude Code reads, sidecar v2, a zip
//       bundle with a manifest — and the round trip export → import gives the
//       same profile (origin aside).
//
// Pure: no store, no network. The temporary directory holds the extracted zip.

import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  importParticipant,
  detectImportFormat,
  runtimeToolNames,
  parseSubagentArtifact,
  parseFrontmatter,
  loadYamlLite,
  readPngTextChunks,
  buildPng,
  sha256Hex,
  type ImportEnv,
  type ImportInput,
  type ImportPlan,
  type ImportResult,
} from '../runtime/import/index.js';
import { buildParticipantExport, buildParticipantBundle, PARTICIPANT_EXPORT_FORMAT_VERSION } from '../runtime/participant-export.js';
import { AGENT_EXPORT_FORMAT_VERSION, REDACTED } from '../runtime/agent-export.js';
import { parseAgentSidecar } from '../runtime/agent-import.js';
import { parseParticipantProfile, type ParticipantProfile } from '../runtime/participants.js';
import { extractZip, listZipEntries } from '../runtime/zip.js';
import type { Agent } from '../runtime/store/store.js';
import { charx, minjiV3Png, noCardPng } from './fixtures/import/generate.js';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, 'fixtures', 'import');
const NOW = 1_784_000_000_000;
const ENV: ImportEnv = {
  installedTools: ['read_file', 'grep', 'write_file', 'fetch_url'],
  mcpServers: ['github'],
  skills: ['review-helper'],
};

function file(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIX, name)));
}
function input(fileName: string, bytes: Uint8Array, existingNames: string[] = ['naby']): ImportInput {
  return { fileName, bytes, now: NOW, existingNames };
}
function plan(r: ImportResult): ImportPlan {
  if (!r.ok) throw new Error(`expected a plan, got problems: ${r.problems.join('; ')}`);
  return r.plan;
}
const lossOf = (p: ImportPlan, note: string, value?: string) =>
  p.losses.find((l) => l.note === note && (value === undefined || l.value === value));
/** Every key, at any depth. */
function allKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      allKeys(x, out);
    }
  }
  return out;
}

// ---- (a) detection -------------------------------------------------------
{
  const cases: [string, Uint8Array, string][] = [
    ['explorer.md', file('explorer.md'), 'claude-agent-md'],
    ['minji.v2.json', file('minji.v2.json'), 'character-card-v2'],
    ['minji.v3.png', file('minji.v3.png'), 'character-card-v3'],
    ['legacy.v1.naby.json', file('legacy.v1.naby.json'), 'naby-sidecar'],
  ];
  for (const [name, bytes, want] of cases) {
    const d = detectImportFormat({ fileName: name, bytes });
    record(`detect: ${name} → ${want}`, d?.format === want, `got ${d?.format} (${d?.score})`);
  }
  const garbage = new Uint8Array(256).map((_, i) => (i * 37 + 11) & 0xff);
  const r = importParticipant(input('mystery.bin', garbage));
  record(
    "detect: unknown bytes → problems ['unrecognized format']",
    !r.ok && r.problems[0] === 'unrecognized format',
    JSON.stringify(r.ok ? 'ok' : r.problems),
  );
  const committed = file('minji.v3.png');
  record(
    'fixtures: the committed PNGs equal what generate.ts builds (no drift)',
    Buffer.from(committed).equals(Buffer.from(minjiV3Png())) &&
      Buffer.from(file('broken-no-card.png')).equals(Buffer.from(noCardPng())) &&
      Buffer.from(file('broken-card.charx')).equals(Buffer.from(charx())),
    `minji.v3.png ${committed.length} B`,
  );
}

// ---- (b) Claude Code subagent .md ------------------------------------------
const explorerBytes = file('explorer.md');
const ex = plan(importParticipant(input('explorer.md', explorerBytes), { env: ENV }));
{
  record(
    'md: name, displayName, description with a colon, model, instructions',
    ex.agent.name === 'explorer' &&
      ex.agent.profile.displayName === 'explorer' &&
      ex.agent.description === 'Fast codebase explorer. Use when: you need to find where something lives, before editing.' &&
      ex.agent.model === 'haiku' &&
      ex.agent.systemPrompt.startsWith('You are a read-only explorer.') &&
      ex.agent.systemPrompt.includes('never edit anything.'),
    `${ex.agent.name} · ${ex.agent.model} · ${ex.agent.description}`,
  );
  record(
    "md: tools keep only this machine's — read_file, and mcp__github__… renamed to github__…",
    JSON.stringify(ex.agent.toolRefs) === JSON.stringify(['read_file', 'github__search_issues']) &&
      !!lossOf(ex, 'mcp-tool-renamed'),
    JSON.stringify(ex.agent.toolRefs),
  );
  record(
    'md: Claude Code built-ins (Read, Grep, Glob) are dropped BY NAME; jira__ tool dropped (server not registered)',
    ['Read', 'Grep', 'Glob'].every((t) => !!lossOf(ex, 'claude-builtin-tool', t)) &&
      !!lossOf(ex, 'mcp-server-not-registered', 'jira__get_issue'),
    ex.losses.filter((l) => l.field === 'tools').map((l) => `${l.value}:${l.note}`).join(', '),
  );
  record(
    'md: colour name → hex (cyan → #06b6d4); permissionMode plan kept',
    ex.agent.profile.color === '#06b6d4' && ex.agent.profile.guardrails.permissionMode === 'plan',
    `${ex.agent.profile.color} · ${ex.agent.profile.guardrails.permissionMode}`,
  );
  record(
    'md: skills and mcpServers intersect with what is installed; the rest reported',
    JSON.stringify(ex.agent.profile.skills) === '["review-helper"]' &&
      JSON.stringify(ex.agent.profile.mcpServers) === '["github"]' &&
      !!lossOf(ex, 'skill-not-installed', 'not-installed-skill') &&
      !!lossOf(ex, 'mcp-server-not-registered', 'jira'),
    `${ex.agent.profile.skills} · ${ex.agent.profile.mcpServers}`,
  );
  const ext = ex.agent.profile.extensions?.['claude-agent-md'] as { frontmatter?: Record<string, unknown> } | undefined;
  record(
    'md: hooks / maxTurns / memory kept in extensions and reported as kept',
    !!ext?.frontmatter?.hooks &&
      ext.frontmatter.maxTurns === 8 &&
      ['hooks', 'maxTurns', 'memory'].every((f) => ex.losses.some((l) => l.field === f && l.action === 'kept-in-extensions')),
    JSON.stringify(Object.keys(ext?.frontmatter ?? {})),
  );
  record(
    'md: avatar is the default emoji, reported as defaulted',
    ex.agent.profile.avatar.kind === 'emoji' && ex.agent.profile.avatar.value === '🤖' && !!lossOf(ex, 'defaulted-avatar'),
    JSON.stringify(ex.agent.profile.avatar),
  );
  record(
    'md: kind participant, no id, memoryScope session, inline autonomy',
    ex.agent.kind === 'participant' && !('id' in ex.agent) && ex.agent.memoryScope === 'session' && ex.agent.autonomy.escalation === 'inline',
    `${ex.agent.kind} ${ex.agent.memoryScope}`,
  );
  record(
    'provenance: origin.format/sourceName/importedAt and sourceHash = sha256(bytes)',
    ex.agent.profile.origin?.format === 'claude-agent-md' &&
      ex.agent.profile.origin.sourceName === 'explorer.md' &&
      ex.agent.profile.origin.importedAt === NOW &&
      ex.agent.profile.origin.sourceHash === sha256Hex(explorerBytes) &&
      ex.report.sourceHash === sha256Hex(explorerBytes) &&
      /^[0-9a-f]{64}$/.test(ex.report.sourceHash),
    ex.report.sourceHash.slice(0, 12),
  );
  // The moved parser still reads what the shell's copy read.
  const parsed = parseSubagentArtifact('fallback', readFileSync(join(FIX, 'explorer.md'), 'utf8'));
  record(
    'parseSubagentArtifact (now in the runtime) reads name / description / model / tools',
    parsed?.name === 'explorer' &&
      parsed.subagent.model === 'haiku' &&
      parsed.subagent.toolRefs?.length === 6 &&
      parsed.description?.includes('Use when:') === true,
    JSON.stringify(parsed?.subagent.toolRefs),
  );
}

// ---- (b) character card V2 (JSON) -------------------------------------------
const v2 = plan(importParticipant(input('minji.v2.json', file('minji.v2.json')), { env: ENV }));
{
  record(
    'card v2: handle is lowercase-hyphen, displayName kept',
    v2.format === 'character-card-v2' && v2.agent.name === 'minji-kim' && v2.agent.profile.displayName === 'Minji Kim',
    `${v2.agent.name} · ${v2.agent.profile.displayName}`,
  );
  const sp = v2.agent.systemPrompt;
  record(
    'card v2: system_prompt + description + personality + scenario merged in sections; {{char}}/{{user}} substituted; {{original}} removed',
    sp.startsWith('Stay in character as Minji Kim.') &&
      sp.includes('## Character') &&
      sp.includes('## Personality') &&
      sp.includes('## Scenario') &&
      sp.includes('helps 사용자 practise') &&
      !/\{\{/.test(sp) &&
      ['data.description', 'data.personality', 'data.scenario'].every((f) => v2.losses.some((l) => l.field === f && l.action === 'merged')),
    sp.slice(0, 80).replace(/\n/g, '⏎'),
  );
  record(
    'card v2: empty creator_notes → description synthesized from the first sentence (merged)',
    v2.agent.description === 'Minji Kim is a patient Korean tutor who helps 사용자 practise everyday conversation.' &&
      !!lossOf(v2, 'description-synthesized'),
    String(v2.agent.description),
  );
  record(
    'card v2: first_mes → greeting; the 2 alternates kept in extensions',
    v2.agent.profile.greeting === '안녕하세요, 사용자! 오늘은 어떤 표현을 연습해 볼까요?' && lossOf(v2, 'alternate-greetings-kept')?.value === '2',
    String(v2.agent.profile.greeting),
  );
  const exs = v2.agent.profile.examples ?? [];
  record(
    'card v2: mes_example → 3 few-shot pairs across <START> blocks (multi-line turn kept)',
    exs.length === 3 &&
      exs[0]!.user === 'How do I say thank you?' &&
      exs[0]!.assistant.startsWith('고맙습니다') &&
      exs[2]!.assistant === 'It makes a sentence polite.\nIt is very common.',
    JSON.stringify(exs.map((e) => e.user)),
  );
  record(
    'card v2: post_history_instructions → guardrails.policy (merged, substituted)',
    v2.agent.profile.guardrails.policy === "Correct 사용자's Korean gently, one mistake at a time." && !!lossOf(v2, 'merged-into-policy'),
    String(v2.agent.profile.guardrails.policy),
  );
  const k = v2.agent.profile.knowledge;
  record(
    'card v2: lorebook → knowledge: keyword entry on-demand+keywords, constant entry always (no keywords)',
    k.length === 2 &&
      k[0]!.title === 'Honorifics' &&
      k[0]!.inject === 'on-demand' &&
      JSON.stringify(k[0]!.keywords) === '["honorific","존댓말"]' &&
      k[1]!.title === 'Hometown' &&
      k[1]!.inject === 'always' &&
      k[1]!.keywords === undefined &&
      k[1]!.source.kind === 'inline' &&
      k[1]!.source.text === 'Minji Kim grew up in Busan.',
    JSON.stringify(k.map((x) => [x.title, x.inject, x.keywords])),
  );
  record(
    'card v2: enabled:false entry dropped, regex entry kept-in-extensions (not used as keywords)',
    !!lossOf(v2, 'lore-disabled', 'Disabled entry') && !!lossOf(v2, 'lore-regex-kept', 'Food regex'),
    v2.losses.filter((l) => l.note.startsWith('lore')).map((l) => `${l.value}:${l.action}`).join(', '),
  );
  const orig = v2.agent.profile.extensions?.['character-card-v2'] as { data?: { extensions?: { chub?: unknown }; tags?: unknown } } | undefined;
  record(
    'card v2: tags / creator / version / extensions kept verbatim in extensions[format] and reported',
    !!orig?.data?.extensions?.chub &&
      JSON.stringify(orig.data.tags) === '["tutor","korean"]' &&
      ['data.tags', 'data.creator', 'data.character_version', 'data.extensions'].every((f) =>
        v2.losses.some((l) => l.field === f && l.action === 'kept-in-extensions'),
      ),
    JSON.stringify(Object.keys(orig?.data ?? {})).slice(0, 120),
  );
  record(
    'card v2: no tools / MCP / model (defaulted, reported); JSON card → emoji avatar',
    (v2.agent.toolRefs ?? []).length === 0 &&
      v2.agent.profile.mcpServers.length === 0 &&
      v2.agent.model === undefined &&
      !!lossOf(v2, 'card-has-no-tools') &&
      v2.agent.profile.avatar.kind === 'emoji',
    JSON.stringify(v2.agent.profile.avatar),
  );
}

// ---- (b) character card V3 (PNG) --------------------------------------------
const v3bytes = file('minji.v3.png');
const v3 = plan(importParticipant(input('minji.v3.png', v3bytes), { env: ENV }));
{
  record(
    'card v3 png: the ccv3 chunk wins over the chara chunk; nickname used for {{char}}; creator_notes → description',
    v3.format === 'character-card-v3' &&
      v3.agent.profile.greeting === '사용자, 반가워요! 저는 Minji예요.' &&
      v3.agent.description === 'A Korean conversation tutor. Call her for Korean phrasing, honorifics and practice dialogues.' &&
      !lossOf(v3, 'description-synthesized'),
    `${v3.agent.profile.greeting} · ${v3.agent.description}`,
  );
  const av = v3.agent.profile.avatar;
  const avBytes = av.kind === 'image' ? new Uint8Array(Buffer.from(av.dataUrl.split(',')[1]!, 'base64')) : undefined;
  const avChunks = avBytes ? readPngTextChunks(avBytes) ?? [] : undefined;
  record(
    'card v3 png: icon `ccdefault:` → the PNG itself as the avatar, WITHOUT the card chunks',
    av.kind === 'image' &&
      av.dataUrl.startsWith('data:image/png;base64,') &&
      !!avChunks &&
      !avChunks.some((c) => c.keyword === 'ccv3' || c.keyword === 'chara') &&
      avBytes!.length < v3bytes.length,
    `avatar ${avBytes?.length} B vs file ${v3bytes.length} B`,
  );
  const ext3 = v3.agent.profile.extensions?.['character-card-v3'] as Record<string, unknown> | undefined;
  record(
    'card v3 png: extensions[format] is the chunk JSON only — no image bytes',
    ext3?.spec === 'chara_card_v3' && !JSON.stringify(ext3).includes('data:image') && JSON.stringify(ext3).length < 4000,
    `${JSON.stringify(ext3).length} chars`,
  );
  record(
    'card v3: lorebook decorators (@@depth) stripped from content and reported; non-icon asset kept',
    v3.agent.profile.knowledge[0]?.source.kind === 'inline' &&
      v3.agent.profile.knowledge[0].source.text === 'Minji grew up in Busan.' &&
      !!lossOf(v3, 'lore-decorators-kept') &&
      v3.losses.some((l) => l.field === 'data.assets' && l.value === '1') &&
      v3.losses.some((l) => l.field === 'data.group_only_greetings'),
    JSON.stringify(v3.agent.profile.knowledge[0]),
  );
  // A V2 reader of the same PNG reads the `chara` chunk.
  const forced = plan(importParticipant(input('minji.v3.png', v3bytes), { format: 'character-card-v2', env: ENV }));
  record('card png: forcing V2 reads the chara chunk', forced.format === 'character-card-v2' && forced.agent.profile.displayName === 'Minji Kim', forced.format);
}

// ---- (b) naby sidecar v1 --------------------------------------------------
const v1 = plan(importParticipant(input('legacy.v1.naby.json', file('legacy.v1.naby.json')), { env: ENV }));
{
  record(
    'sidecar v1: base fields + default profile; Bash dropped, read_file kept',
    v1.format === 'naby-sidecar' &&
      v1.agent.name === 'reviewer' &&
      v1.agent.description === 'Reviews pull requests for risky changes.' &&
      v1.agent.model === 'sonnet' &&
      JSON.stringify(v1.agent.toolRefs) === '["read_file"]' &&
      !!lossOf(v1, 'claude-builtin-tool', 'Bash') &&
      v1.agent.profile.knowledge.length === 0 &&
      !!lossOf(v1, 'v1-default-profile'),
    JSON.stringify(v1.agent.toolRefs),
  );
  record(
    'sidecar v1: memories / ledger / growthAtExport DROPPED and reported; preview points at agent.import',
    lossOf(v1, 'participants-do-not-learn', '1') !== undefined &&
      v1.losses.filter((l) => l.note === 'participants-do-not-learn').length === 3 &&
      v1.warnings.includes('sidecar-v1-use-agent-import'),
    v1.losses.filter((l) => l.action === 'dropped').map((l) => l.field).join(', '),
  );
  record(
    "sidecar v1: memoryScope 'user' → session (defaulted); autonomy telegram/6 not taken",
    v1.agent.memoryScope === 'session' &&
      lossOf(v1, 'memory-scope-session', 'user') !== undefined &&
      JSON.stringify(v1.agent.autonomy) === '{"escalation":"inline"}',
    `${v1.agent.memoryScope} ${JSON.stringify(v1.agent.autonomy)}`,
  );
}

// ---- (d) ADVERSARIAL --------------------------------------------------------
{
  const hostileBytes = file('broken-hostile.naby.json');
  const h = plan(importParticipant(input('broken-hostile.naby.json', hostileBytes, ['naby', 'Persona']), { env: ENV }));
  record(
    "hostile: planted id / kind:'persona' / stage / trusted / autonomy have NO effect",
    h.agent.kind === 'participant' &&
      !('id' in h.agent) &&
      JSON.stringify(h.agent.autonomy) === '{"escalation":"inline"}' &&
      h.agent.memoryScope === 'session' &&
      // Not at the profile's top level, and nowhere at all inside extensions.
      !Object.keys(h.agent.profile).some((key) => ['id', 'kind', 'stage', 'trusted', 'autonomy'].includes(key)) &&
      !allKeys(h.agent.profile.extensions).some((key) => ['id', 'kind', 'stage', 'trusted', 'autonomy'].includes(key)) &&
      (h.agent.profile.extensions?.other as { keep?: string } | undefined)?.keep === 'yes' &&
      h.losses.some((l) => l.note === 'ignored-key'),
    `kind=${h.agent.kind} keys-stripped=${h.losses.filter((l) => l.note === 'ignored-key').map((l) => l.field).join(',')}`,
  );
  record(
    "hostile: toolRefs ['Bash','naby_remember','write_file'] → only write_file (installed here); evil MCP server dropped",
    JSON.stringify(h.agent.toolRefs) === '["write_file"]' &&
      !!lossOf(h, 'claude-builtin-tool', 'Bash') &&
      !!lossOf(h, 'tool-not-installed', 'naby_remember') &&
      h.agent.profile.mcpServers.length === 0,
    JSON.stringify(h.agent.toolRefs),
  );
  record(
    'hostile: secrets in greeting / policy / knowledge are REDACTED and counted; the prompt is warned about, not redacted',
    h.agent.profile.greeting === REDACTED &&
      h.agent.profile.guardrails.policy === REDACTED &&
      h.agent.profile.knowledge[0]?.source.kind === 'inline' &&
      h.agent.profile.knowledge[0].source.text === REDACTED &&
      h.report.secretsRedacted === 3 &&
      h.warnings.includes('prompt-looks-secret') &&
      h.agent.systemPrompt.includes('sk-live-'),
    `redacted=${h.report.secretsRedacted} warnings=${h.warnings.join(',')}`,
  );
  record(
    "hostile: the name 'naby' is never free → naby-imported (renamedFrom reported)",
    h.agent.name === 'naby-imported' && h.report.renamedFrom === 'naby' && h.warnings.includes('renamed'),
    `${h.agent.name} ← ${h.report.renamedFrom}`,
  );
  record(
    'hostile: a file-sourced knowledge item is dropped; an SVG avatar falls back to the emoji',
    h.agent.profile.knowledge.length === 1 &&
      !!lossOf(h, 'knowledge-file-dropped', 'ssh') &&
      h.agent.profile.avatar.kind === 'emoji' &&
      !!lossOf(h, 'avatar-unsupported-image'),
    JSON.stringify(h.agent.profile.avatar),
  );
  record(
    'hostile: the plan passes the profile gate as-is (parseParticipantProfile is idempotent on it)',
    JSON.stringify(parseParticipantProfile(h.agent.profile)) === JSON.stringify(h.agent.profile),
    'ok',
  );

  // Name collisions — ignoring case, and twice.
  const c1 = plan(importParticipant(input('minji.v2.json', file('minji.v2.json'), ['Minji-Kim']), { env: ENV }));
  const c2 = plan(importParticipant(input('minji.v2.json', file('minji.v2.json'), ['minji-kim', 'MINJI-KIM-IMPORTED']), { env: ENV }));
  record(
    'collision: an existing name in another case renames to -imported; a second collision to -imported-2',
    c1.agent.name === 'minji-kim-imported' && c1.report.renamedFrom === 'minji-kim' && c2.agent.name === 'minji-kim-imported-2',
    `${c1.agent.name}, ${c2.agent.name}`,
  );

  const fut = importParticipant(input('broken-future.naby.json', file('broken-future.naby.json')), { env: ENV });
  record('formatVersion 3 is refused (not half-read)', !fut.ok && fut.problems[0]!.startsWith('newer-format: 3'), JSON.stringify(fut.ok ? 'ok' : fut.problems));

  const noCard = importParticipant(input('broken-no-card.png', file('broken-no-card.png')));
  record("a PNG with no chara/ccv3 chunk is refused ('png-no-card')", !noCard.ok && noCard.problems[0] === 'png-no-card', JSON.stringify(noCard.ok ? 'ok' : noCard.problems));

  const cx = importParticipant(input('broken-card.charx', file('broken-card.charx')));
  record("CHARX (zip) is refused: 'charx not supported yet'", !cx.ok && cx.problems[0] === 'charx not supported yet', JSON.stringify(cx.ok ? 'ok' : cx.problems));

  const empty = importParticipant(input('broken-empty.md', file('broken-empty.md')));
  record('an .md with no body is refused', !empty.ok && empty.problems[0] === 'empty-instructions', JSON.stringify(empty.ok ? 'ok' : empty.problems));

  // An icon over 64 KB: the emoji, reported.
  const card = { spec: 'chara_card_v2', data: { name: 'Big Picture', description: 'Has a huge portrait.', first_mes: 'Hi.' } };
  const big = buildPng({ width: 4, height: 4, text: { chara: Buffer.from(JSON.stringify(card)).toString('base64') }, padBytes: 70 * 1024 });
  const bp = plan(importParticipant(input('big.png', big), { env: ENV }));
  record(
    'an image avatar over 64 KB falls back to the emoji (no canvas to downscale in Node), reported',
    bp.agent.profile.avatar.kind === 'emoji' && !!lossOf(bp, 'avatar-too-large'),
    `${big.length} B → ${JSON.stringify(bp.agent.profile.avatar)} (${lossOf(bp, 'avatar-too-large')?.value})`,
  );
  const small = buildPng({ width: 4, height: 4, text: { chara: Buffer.from(JSON.stringify(card)).toString('base64') } });
  const sp = plan(importParticipant(input('small.png', small), { env: ENV }));
  record('a small V2 PNG keeps its picture as the avatar', sp.agent.profile.avatar.kind === 'image', sp.agent.profile.avatar.kind);

  // 21 lorebook entries: the 21st is dropped.
  const entries = Array.from({ length: 21 }, (_, i) => ({ keys: [`k${i}`], content: `fact ${i + 1}`, enabled: true, name: `Fact ${i + 1}` }));
  const lore = { spec: 'chara_card_v2', data: { name: 'Lorekeeper', description: 'Knows things.', character_book: { entries } } };
  const lp = plan(importParticipant(input('lore.json', new TextEncoder().encode(JSON.stringify(lore))), { env: ENV }));
  record(
    'lorebook: 21 entries → 20 knowledge items, the 21st dropped and named',
    lp.agent.profile.knowledge.length === 20 && !!lossOf(lp, 'over-knowledge-limit', 'Fact 21'),
    `${lp.agent.profile.knowledge.length} items · ${lossOf(lp, 'over-knowledge-limit')?.field}`,
  );

  // Oversized instructions and inline knowledge are clipped, not refused.
  const huge = { spec: 'chara_card_v2', data: { name: 'Verbose', description: 'x'.repeat(40 * 1024), character_book: { entries: [{ keys: ['a'], content: 'y'.repeat(20 * 1024), enabled: true }] } } };
  const hp = plan(importParticipant(input('huge.json', new TextEncoder().encode(JSON.stringify(huge))), { env: ENV }));
  record(
    'size: instructions clipped to 32 KB and inline knowledge to 16 KB (dropped parts reported); the oversize original is omitted from extensions',
    Buffer.byteLength(hp.agent.systemPrompt) <= 32 * 1024 &&
      hp.agent.profile.knowledge[0]!.source.kind === 'inline' &&
      Buffer.byteLength(hp.agent.profile.knowledge[0]!.source.text) <= 16 * 1024 &&
      hp.losses.filter((l) => l.note === 'truncated').length === 2,
    hp.losses.filter((l) => l.action === 'dropped').map((l) => `${l.field}:${l.note}`).join(', '),
  );

  // A caller that forgets the environment grants nothing.
  const bare = plan(importParticipant(input('explorer.md', explorerBytes)));
  record(
    'no environment → no tools, no MCP servers, no skills (the safe default)',
    (bare.agent.toolRefs ?? []).length === 0 && bare.agent.profile.mcpServers.length === 0 && bare.agent.profile.skills.length === 0,
    JSON.stringify(bare.agent.toolRefs),
  );

  // Forcing an unbuilt format is a problem, not a guess.
  const m365 = importParticipant(input('x.json', file('minji.v2.json')), { format: 'm365-declarative-agent' });
  record('a format with no adapter yet is refused', !m365.ok && m365.problems[0]!.startsWith('format not supported yet'), JSON.stringify(m365.ok ? 'ok' : m365.problems));
}

// ---- (e) export ------------------------------------------------------------
const PROFILE: ParticipantProfile = parseParticipantProfile({
  displayName: 'Translator',
  avatar: { kind: 'emoji', value: '🌐' },
  color: '#06b6d4',
  greeting: 'Hi! Send me text to translate.',
  examples: [{ user: 'Translate: 안녕', assistant: 'Hello' }],
  knowledge: [
    { id: 'glossary', title: 'Glossary', inject: 'always', source: { kind: 'inline', text: 'naby = 나비 (never translate)' } },
    { id: 'style', title: 'Style', inject: 'on-demand', keywords: ['formal', '존댓말'], source: { kind: 'inline', text: 'Use polite forms.' } },
  ],
  guardrails: { policy: 'Never translate legal contracts; refer to a lawyer.', permissionMode: 'plan' },
  mcpServers: ['github'],
  skills: ['review-helper'],
  params: { temperature: 0.3 },
  origin: { format: 'character-card-v2', importedAt: 1, sourceHash: 'abc', sourceName: 'old.json' },
  extensions: { 'character-card-v2': { spec: 'chara_card_v2', data: { name: 'Translator', tags: ['lang'] } } },
});
const AGENT: Agent = {
  id: 'participant-1',
  name: 'translator',
  kind: 'participant',
  description: 'Translates Korean ↔ English: call for any translation request.',
  systemPrompt: 'You translate between Korean and English.',
  model: 'sonnet',
  toolRefs: ['fetch_url'],
  memoryScope: 'session',
  autonomy: { escalation: 'inline' },
  profile: PROFILE,
  createdAt: 5,
  updatedAt: 6,
};
{
  const out = buildParticipantExport({ agent: AGENT, now: NOW });
  const { data, body } = parseFrontmatter(out.markdown);
  record(
    'export .md: frontmatter name / description (colon-safe) / model / tools / skills / mcpServers / color (Claude name)',
    data.name === 'translator' &&
      data.description === AGENT.description &&
      data.model === 'sonnet' &&
      data.tools === 'fetch_url' &&
      JSON.stringify(data.skills) === '["review-helper"]' &&
      JSON.stringify(data.mcpServers) === '["github"]' &&
      data.color === 'cyan',
    JSON.stringify(data),
  );
  record(
    'export .md: body = instructions + guardrails section + "N knowledge items in the sidecar"; knowledge NOT inlined',
    body.startsWith('You translate between Korean and English.') &&
      body.includes('## Guardrails\n\nNever translate legal contracts') &&
      body.includes('2 knowledge items in the sidecar') &&
      !body.includes('never translate)'),
    body.split('\n').slice(-1)[0]!,
  );
  // The shell's js-yaml reads the same frontmatter the same way.
  const require = createRequire(import.meta.url);
  let jsYamlSame = false;
  try {
    const jy = require('js-yaml') as { load(s: string): unknown };
    jsYamlSame = JSON.stringify(parseFrontmatter(out.markdown, jy.load).data) === JSON.stringify(data);
  } catch {
    jsYamlSame = false;
  }
  record('export .md: js-yaml (the harness importer\'s reader) reads the identical frontmatter', jsYamlSame, String(jsYamlSame));

  const side = JSON.parse(out.sidecar) as Record<string, unknown> & { agent: Record<string, unknown>; origin: Record<string, unknown> };
  record(
    'export sidecar: formatVersion 2, profile included, memories=[] ledger=[], no growthAtExport, no id/kind in the agent block',
    side.formatVersion === 2 &&
      PARTICIPANT_EXPORT_FORMAT_VERSION === 2 &&
      AGENT_EXPORT_FORMAT_VERSION === 1 &&
      !!side.agent.profile &&
      JSON.stringify(side.memories) === '[]' &&
      JSON.stringify(side.ledger) === '[]' &&
      !('growthAtExport' in side) &&
      !('id' in side.agent) &&
      !('kind' in side.agent) &&
      side.origin.kind === 'participant',
    `v${side.formatVersion} · ${Object.keys(side).join(',')}`,
  );
  record(
    'export: the existing agent.import parser refuses the v2 sidecar (formatVersion > 1)',
    (() => {
      const r = parseAgentSidecar(out.sidecar, { now: NOW });
      return !r.ok && r.problems.some((p) => p.includes('format 2'));
    })(),
    'refused',
  );

  // ROUND TRIP: export → import → the same profile, origin aside.
  const back = plan(importParticipant(input(out.sidecarName, new TextEncoder().encode(out.sidecar), ['naby']), { env: ENV }));
  const strip = (p: ParticipantProfile) => {
    const { origin: _o, ...rest } = p;
    return JSON.stringify(rest);
  };
  record(
    'round trip: export → importParticipant → identical profile (origin aside) and row fields',
    back.format === 'naby-sidecar' &&
      strip(back.agent.profile) === strip(PROFILE) &&
      back.agent.name === AGENT.name &&
      back.agent.description === AGENT.description &&
      back.agent.systemPrompt === AGENT.systemPrompt &&
      back.agent.model === AGENT.model &&
      JSON.stringify(back.agent.toolRefs) === JSON.stringify(AGENT.toolRefs) &&
      back.losses.length === 0,
    `losses=${back.losses.length} ${strip(back.agent.profile) === strip(PROFILE) ? 'profile equal' : 'DIFF'}`,
  );
  record(
    'round trip: the new origin records the sidecar import (format, hash of THESE bytes)',
    back.agent.profile.origin?.format === 'naby-sidecar' && back.agent.profile.origin.sourceHash === sha256Hex(new TextEncoder().encode(out.sidecar)),
    String(back.agent.profile.origin?.sourceName),
  );
  // And the .md half: Claude Code fields come back through the md adapter.
  const mdBack = plan(importParticipant(input(out.markdownName, new TextEncoder().encode(out.markdown), ['naby']), { env: ENV }));
  record(
    'round trip (.md): name, model, tools, skills, mcpServers and colour survive the Claude Code file',
    mdBack.format === 'claude-agent-md' &&
      mdBack.agent.name === 'translator' &&
      mdBack.agent.model === 'sonnet' &&
      JSON.stringify(mdBack.agent.toolRefs) === '["fetch_url"]' &&
      JSON.stringify(mdBack.agent.profile.skills) === '["review-helper"]' &&
      JSON.stringify(mdBack.agent.profile.mcpServers) === '["github"]' &&
      mdBack.agent.profile.color === '#06b6d4',
    `${mdBack.agent.name} ${mdBack.agent.profile.color}`,
  );

  // Secrets on the way out.
  const leaky: Agent = {
    ...AGENT,
    systemPrompt: 'Use password: hunter22 when asked.',
    profile: { ...PROFILE, guardrails: { policy: 'token = abcdefabcdef' } },
  };
  const lo = buildParticipantExport({ agent: leaky, now: NOW });
  record(
    'export: a credential-shaped policy is redacted in BOTH files and counted; the prompt is flagged, not redacted',
    lo.report.secretsRedacted === 1 &&
      lo.report.promptLooksSecret &&
      !lo.markdown.includes('abcdefabcdef') &&
      !lo.sidecar.includes('abcdefabcdef') &&
      lo.markdown.includes('hunter22'),
    JSON.stringify(lo.report),
  );

  // The bundle.
  const twin: Agent = { ...AGENT, id: 'participant-2', name: 'Translator', profile: { ...PROFILE, knowledge: [] } };
  const bundle = buildParticipantBundle([AGENT, twin], NOW);
  const names = listZipEntries(bundle.bytes);
  const dir = mkdtempSync(join(tmpdir(), 'naby-bundle-'));
  let manifestOk = false;
  let pairOk = false;
  try {
    extractZip(bundle.bytes, dir);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { formatVersion: number; exportedAt: number; agents: string[] };
    manifestOk = manifest.formatVersion === 2 && manifest.exportedAt === NOW && JSON.stringify(manifest.agents) === '["translator","Translator"]';
    const md = readFileSync(join(dir, 'translator.md'), 'utf8');
    pairOk = md === out.markdown && readdirSync(dir).length === 5;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  record(
    'bundle: one zip = manifest.json + a .md/.naby.json pair per participant; colliding basenames get -2',
    JSON.stringify(names) === JSON.stringify(['manifest.json', 'translator.md', 'translator.naby.json', 'translator-2.md', 'translator-2.naby.json']) &&
      manifestOk &&
      pairOk &&
      bundle.fileName === 'naby-participants-2026-07-14.zip',
    `${names.join(', ')} · ${bundle.fileName}`,
  );
}

// ---- the YAML reader -------------------------------------------------------
{
  const doc = 'a: 1\nb: [x, "y z"]\nc:\n  - k: v\n    n: 2\nd: |\n  one\n  two\ne: \'it\'\'s\'\nf: true\ng: ~\n';
  const v = loadYamlLite(doc) as Record<string, unknown>;
  record(
    'yamlLite: maps, flow + block sequences, sequence of maps, block scalar, quotes, core-schema scalars',
    JSON.stringify(v) === JSON.stringify({ a: 1, b: ['x', 'y z'], c: [{ k: 'v', n: 2 }], d: 'one\ntwo\n', e: "it's", f: true, g: null }),
    JSON.stringify(v),
  );
  const broken = parseFrontmatter('---\nname: [unclosed\n---\nbody');
  record('yamlLite: unreadable frontmatter degrades to "none" (body kept), never throws', JSON.stringify(broken.data) === '{}' && broken.body === 'body', JSON.stringify(broken));
}

// ---- the tool catalogue ------------------------------------------------------
{
  const names = runtimeToolNames();
  record(
    "runtimeToolNames: built from the turn's own builders (fetch_url, read_file, run_command, naby_start_job, naby_skill_load)",
    ['fetch_url', 'read_file', 'write_file', 'run_command', 'naby_start_job', 'naby_skill_load'].every((n) => names.includes(n)) &&
      !names.includes('naby_remember'),
    names.join(', '),
  );
}

// ---- report --------------------------------------------------------------
let failed = 0;
for (const c of checks) {
  if (!c.pass) failed += 1;
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}\n      ${c.evidence}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
if (failed > 0) process.exitCode = 1;
