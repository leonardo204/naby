// src/runtime/import/characterCard.ts
//
// CHARACTER CARD V2 / V3 → PARTICIPANT (agent-import-adapters §3.3).
//
// A character card (SillyTavern and friends) is a persona: who the character is,
// how it talks, what it says first, a lorebook of facts it recalls by keyword.
// It maps onto a participant well — the identity and instructions directly, the
// lorebook onto `knowledge` with keywords — and badly only where a card has no
// notion at all (tools, MCP, model), which are reported as defaulted.
//
// INPUT. JSON (`spec: 'chara_card_v2' | 'chara_card_v3'`, or a V1 card with the
// fields at the top level), or a PNG whose `tEXt` chunk `chara` (V2) / `ccv3`
// (V3) holds the card as base64 JSON. CHARX (a zip) is a later milestone and is
// refused with a problem rather than half-read.
//
// THE PICTURE. A PNG card's image is the character's portrait, so it becomes the
// avatar — minus the text chunks (the card JSON lives in extensions, not inside
// a data URL). It must fit the 64 KB avatar cap AS IS: Node has no canvas, so
// the runtime cannot downscale an image. A larger PNG falls back to the default
// emoji and the preview says so (`avatar-too-large`).

import { defaultParticipantProfile, type KnowledgeItem } from '../participants.js';
import { isRecord, isPng, isZip, jsonObject, str, strList, toHandle } from './common.js';
import { finalizePlan } from './finalize.js';
import { readPngTextChunks, stripPngTextChunks } from './png.js';
import type {
  ImportDraft,
  ImportEnv,
  ImportFormat,
  ImportInput,
  ImportLoss,
  ImportResult,
  ParticipantAdapter,
} from './types.js';

/** `{{user}}` becomes this — the participant talks to "the user" in Korean UI. */
export const CARD_USER_LABEL = '사용자';

/** Card fields the adapter maps. Everything else stays in extensions. */
const MAPPED = new Set([
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'creator_notes',
  'system_prompt',
  'post_history_instructions',
  'alternate_greetings',
  'character_book',
  'assets',
]);

type CardSource = { doc: Record<string, unknown>; png?: Uint8Array };

function decodeBase64Json(text: string): Record<string, unknown> | undefined {
  try {
    const raw = Buffer.from(text.trim(), 'base64').toString('utf8');
    const v = JSON.parse(raw) as unknown;
    if (isRecord(v)) return v;
  } catch {
    /* fall through */
  }
  // Some writers store the JSON itself rather than base64.
  try {
    const v = JSON.parse(text) as unknown;
    return isRecord(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** The card a file carries, for the given version. */
function readCard(bytes: Uint8Array, version: 2 | 3): { ok: true; card: CardSource } | { ok: false; problems: string[] } {
  if (isZip(bytes)) return { ok: false, problems: ['charx not supported yet'] };
  if (isPng(bytes)) {
    const chunks = readPngTextChunks(bytes) ?? [];
    const key = version === 3 ? 'ccv3' : 'chara';
    const chunk = chunks.find((c) => c.keyword === key) ?? (version === 3 ? undefined : chunks.find((c) => c.keyword === 'ccv3'));
    if (!chunk) return { ok: false, problems: ['png-no-card'] };
    const doc = decodeBase64Json(chunk.text);
    if (!doc) return { ok: false, problems: ['card-unreadable'] };
    return { ok: true, card: { doc, png: bytes } };
  }
  const doc = jsonObject(bytes);
  if (!doc) return { ok: false, problems: ['card-unreadable'] };
  return { ok: true, card: { doc } };
}

/** `mes_example` → `{user, assistant}` pairs. Blocks are split on `<START>`;
 *  inside a block a turn starts at `{{user}}:` / `{{char}}:` (or the V1
 *  `<USER>:` / `<BOT>:`) and runs until the next one. A user turn followed by a
 *  character turn is one pair. */
export function parseMesExample(mes: string): { user: string; assistant: string }[] {
  const pairs: { user: string; assistant: string }[] = [];
  for (const block of mes.split(/<START>/i)) {
    const turns: { who: 'user' | 'char'; text: string }[] = [];
    for (const line of block.split(/\r?\n/)) {
      const m = /^\s*(\{\{user\}\}|\{\{char\}\}|<USER>|<BOT>)\s*:\s?(.*)$/i.exec(line);
      if (m) {
        const who = /user/i.test(m[1]!) ? 'user' : 'char';
        const last = turns[turns.length - 1];
        if (last && last.who === who) last.text += `\n${m[2]!}`;
        else turns.push({ who, text: m[2]! });
      } else if (turns.length > 0) {
        turns[turns.length - 1]!.text += `\n${line}`;
      }
    }
    for (let i = 0; i + 1 < turns.length; i++) {
      if (turns[i]!.who === 'user' && turns[i + 1]!.who === 'char') {
        pairs.push({ user: turns[i]!.text.trim(), assistant: turns[i + 1]!.text.trim() });
        i++;
      }
    }
  }
  return pairs.filter((p) => p.user && p.assistant);
}

function firstSentence(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?。！？])(?:\s|$)/u.exec(flat);
  const one = m ? m[1]! : flat;
  return one.length > 200 ? `${one.slice(0, 199)}…` : one;
}

function bytesToDataUrl(png: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
}

export function draftFromCharacterCard(
  input: ImportInput,
  version: 2 | 3,
): { ok: true; draft: ImportDraft } | { ok: false; problems: string[] } {
  const read = readCard(input.bytes, version);
  if (!read.ok) return read;
  const { doc, png } = read.card;
  const format: ImportFormat = version === 3 ? 'character-card-v3' : 'character-card-v2';
  const ext = `profile.extensions['${format}']`;
  // V2/V3 nest the fields under `data`; a V1 card has them at the top level.
  const data = isRecord(doc.data) ? doc.data : doc;
  const charName = str(data.name);
  if (!charName) return { ok: false, problems: ['card-no-name'] };
  const label = (version === 3 ? str(data.nickname) : undefined) ?? charName;
  const sub = (s: string) =>
    s
      .replace(/\{\{char\}\}|<BOT>/gi, label)
      .replace(/\{\{user\}\}|<USER>/gi, CARD_USER_LABEL)
      .replace(/\{\{original\}\}/gi, '')
      .trim();
  const text = (v: unknown) => (typeof v === 'string' ? sub(v) : '');

  const losses: ImportLoss[] = [];
  const base = defaultParticipantProfile(charName);

  // -- instructions: system_prompt, then the character, in labelled sections.
  const sections: string[] = [];
  const sp = text(data.system_prompt);
  sections.push(sp || `You are ${label}.`);
  for (const [key, heading] of [
    ['description', 'Character'],
    ['personality', 'Personality'],
    ['scenario', 'Scenario'],
  ] as const) {
    const v = text(data[key]);
    if (!v) continue;
    sections.push(`## ${heading}\n\n${v}`);
    losses.push({ field: `data.${key}`, action: 'merged', into: 'systemPrompt', note: 'merged-into-instructions' });
  }
  const systemPrompt = sections.join('\n\n');

  // -- description: what naby routes on.
  let description = text(data.creator_notes);
  if (!description) {
    description = firstSentence(`${text(data.description)} ${text(data.personality)}`);
    if (description) {
      losses.push({ field: 'data.creator_notes', action: 'merged', into: 'description', note: 'description-synthesized' });
    }
  }

  // -- greeting and the alternates.
  let greeting = text(data.first_mes);
  const alternates = Array.isArray(data.alternate_greetings)
    ? data.alternate_greetings.filter((g): g is string => typeof g === 'string' && g.trim().length > 0)
    : [];
  if (!greeting && alternates.length > 0) greeting = sub(alternates[0]!);
  const leftover = greeting && text(data.first_mes) ? alternates.length : alternates.length - 1;
  if (leftover > 0) {
    losses.push({
      field: 'data.alternate_greetings',
      action: 'kept-in-extensions',
      into: ext,
      note: 'alternate-greetings-kept',
      value: String(leftover),
    });
  }

  // -- few-shot examples.
  const mes = typeof data.mes_example === 'string' ? data.mes_example : '';
  const examples = mes.trim()
    ? parseMesExample(mes).map((p) => ({ user: sub(p.user), assistant: sub(p.assistant) }))
    : [];
  if (mes.trim() && examples.length === 0) {
    losses.push({ field: 'data.mes_example', action: 'kept-in-extensions', into: ext, note: 'examples-unparsed' });
  }

  // -- post-history instructions: a guardrail, in words.
  const policy = text(data.post_history_instructions);
  if (policy) {
    losses.push({ field: 'data.post_history_instructions', action: 'merged', into: 'profile.guardrails.policy', note: 'merged-into-policy' });
  }

  // -- the lorebook → knowledge.
  const knowledge: KnowledgeItem[] = [];
  const book = isRecord(data.character_book) ? data.character_book : undefined;
  const entries = book && Array.isArray(book.entries) ? book.entries : [];
  let decorators = false;
  entries.forEach((e, i) => {
    if (!isRecord(e)) return;
    const keys = strList(e.keys) ?? [];
    const label2 = str(e.name) ?? str(e.comment) ?? keys[0] ?? `Entry ${i + 1}`;
    const field = `data.character_book.entries[${i}]`;
    if (e.enabled === false) {
      losses.push({ field, action: 'dropped', note: 'lore-disabled', value: label2 });
      return;
    }
    if (e.use_regex === true) {
      // A regex key is not a keyword; matching it as one would fire on the wrong
      // text. The entry is kept verbatim, not used.
      losses.push({ field, action: 'kept-in-extensions', into: ext, note: 'lore-regex-kept', value: label2 });
      return;
    }
    let content = typeof e.content === 'string' ? e.content : '';
    if (/^@@/m.test(content)) {
      decorators = true;
      content = content
        .split(/\r?\n/)
        .filter((l) => !l.startsWith('@@'))
        .join('\n');
    }
    content = sub(content);
    if (!content) {
      losses.push({ field, action: 'dropped', note: 'lore-empty', value: label2 });
      return;
    }
    const constant = e.constant === true;
    knowledge.push({
      id: `lore-${i + 1}`,
      title: label2,
      inject: constant ? 'always' : 'on-demand',
      // A constant entry is always injected; keywords would gate it (§8.1).
      ...(!constant && keys.length > 0 ? { keywords: keys } : {}),
      source: { kind: 'inline', text: content },
    });
  });
  if (decorators) {
    losses.push({ field: 'data.character_book.entries[].content', action: 'kept-in-extensions', into: ext, note: 'lore-decorators-kept' });
  }

  // -- the picture.
  let avatar: ImportDraft['profile']['avatar'] = base.avatar;
  const assets = Array.isArray(data.assets) ? data.assets.filter(isRecord) : [];
  const icon = assets.find((a) => a.type === 'icon' && a.name === 'main') ?? assets.find((a) => a.type === 'icon');
  const iconUri = icon ? str(icon.uri) : undefined;
  const portrait = () => {
    const image = png ? stripPngTextChunks(png, ['chara', 'ccv3']) : undefined;
    return image ? bytesToDataUrl(image) : undefined;
  };
  if (iconUri && /^data:image\//i.test(iconUri)) {
    avatar = { kind: 'image', dataUrl: iconUri };
  } else if (iconUri && /^(?:ccdefault:|embed+ed:\/\/)/i.test(iconUri) && png) {
    avatar = { kind: 'image', dataUrl: portrait()! };
  } else if (iconUri && !png) {
    // A remote or packaged image: naby fetches nothing on import.
    losses.push({ field: 'data.assets[icon]', action: 'defaulted', into: 'profile.avatar', note: 'avatar-not-embedded', value: iconUri.slice(0, 80) });
  } else if (png) {
    avatar = { kind: 'image', dataUrl: portrait()! };
  } else {
    losses.push({ field: 'avatar', action: 'defaulted', into: 'profile.avatar', note: 'defaulted-avatar', value: '🤖' });
  }

  // -- what a card does not have.
  losses.push({ field: 'tools, mcpServers, model', action: 'defaulted', into: 'toolRefs, profile.mcpServers, model', note: 'card-has-no-tools' });

  // -- everything else: in the original, reported by name.
  for (const key of Object.keys(data)) {
    if (MAPPED.has(key)) continue;
    const v = data[key];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0) || (isRecord(v) && Object.keys(v).length === 0)) continue;
    losses.push({ field: `data.${key}`, action: 'kept-in-extensions', into: ext, note: 'kept-unmapped-field' });
  }
  const otherAssets = assets.filter((a) => a !== icon);
  if (otherAssets.length > 0) {
    losses.push({ field: 'data.assets', action: 'kept-in-extensions', into: ext, note: 'kept-unmapped-field', value: String(otherAssets.length) });
  }

  return {
    ok: true,
    draft: {
      format,
      name: toHandle(charName),
      ...(description ? { description } : {}),
      systemPrompt,
      toolRefs: [],
      profile: {
        displayName: charName,
        avatar,
        color: base.color,
        ...(greeting ? { greeting } : {}),
        ...(examples.length > 0 ? { examples } : {}),
        knowledge,
        guardrails: policy ? { policy } : {},
        mcpServers: [],
        skills: [],
      },
      // The card JSON as the file held it (a PNG's chunk JSON — never the image).
      original: doc,
      losses,
      warnings: [],
    },
  };
}

function cardSpec(bytes: Uint8Array): { spec?: string; v1?: boolean; chunks?: string[] } {
  if (isPng(bytes)) return { chunks: (readPngTextChunks(bytes) ?? []).map((c) => c.keyword) };
  const doc = jsonObject(bytes);
  if (!doc) return {};
  if (typeof doc.spec === 'string') return { spec: doc.spec };
  const looksV1 = typeof doc.name === 'string' && ('first_mes' in doc || 'personality' in doc || 'mes_example' in doc);
  return { v1: looksV1 };
}

export const characterCardV2Adapter: ParticipantAdapter = {
  format: 'character-card-v2',
  detect({ bytes }) {
    const s = cardSpec(bytes);
    if (s.chunks) {
      if (s.chunks.includes('chara') && !s.chunks.includes('ccv3')) return 0.95;
      if (s.chunks.includes('chara')) return 0.8;
      // A PNG with no card chunk: claim it just enough to explain why it fails.
      return s.chunks.includes('ccv3') ? 0 : 0.5;
    }
    if (s.spec === 'chara_card_v2') return 0.95;
    if (s.v1) return 0.6;
    return 0;
  },
  parse(input: ImportInput, env?: ImportEnv): ImportResult {
    const d = draftFromCharacterCard(input, 2);
    if (!d.ok) return d;
    return finalizePlan(d.draft, input, env);
  },
};

export const characterCardV3Adapter: ParticipantAdapter = {
  format: 'character-card-v3',
  detect({ fileName, bytes }) {
    if (isZip(bytes)) return /\.charx$/i.test(fileName) ? 0.95 : 0.5;
    const s = cardSpec(bytes);
    if (s.chunks) return s.chunks.includes('ccv3') ? 0.95 : 0;
    return s.spec === 'chara_card_v3' ? 0.95 : 0;
  },
  parse(input: ImportInput, env?: ImportEnv): ImportResult {
    const d = draftFromCharacterCard(input, 3);
    if (!d.ok) return d;
    return finalizePlan(d.draft, input, env);
  },
};
