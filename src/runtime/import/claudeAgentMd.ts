// src/runtime/import/claudeAgentMd.ts
//
// CLAUDE CODE SUBAGENT `.md` → PARTICIPANT (agent-import-adapters §3.1).
//
// ONE PARSER. `parseSubagentArtifact` used to live in the shell's harness
// importer (it fills `harness_items` rows). The adapter needs the same rules, so
// the parser moved here and the shell imports it — a second copy would drift,
// and the export's round-trip test (agent-export §5) is only meaningful if the
// thing that writes the `.md` and the thing that reads it agree.
//
// The YAML underneath is pluggable: the runtime reads frontmatter with its own
// dependency-free reader (yamlLite.ts), and the shell's harness importer passes
// js-yaml so its long-standing behaviour does not change. The FIELD RULES —
// which keys, in which order of preference, how a tool list is read — exist once,
// in `subagentFromFrontmatter`.

import { defaultParticipantProfile } from '../participants.js';
import { isRecord, sanitizeHandle, str, strList, stem, utf8 } from './common.js';
import { finalizePlan } from './finalize.js';
import type { ImportDraft, ImportEnv, ImportInput, ImportLoss, ImportResult, ParticipantAdapter } from './types.js';
import { loadYamlLite } from './yamlLite.js';

// ---------------------------------------------------------------------------
// The shared parser (was shell lib/harnessImporter.ts)
// ---------------------------------------------------------------------------

export type FrontmatterParser = (raw: string) => { data: Record<string, unknown>; body: string };

/**
 * Split a markdown document into its leading YAML frontmatter (parsed to an
 * object) and the remaining body. Degrades gracefully: a document with no
 * frontmatter, or with empty/unparseable/non-object frontmatter, yields
 * `{ data: {}, body: <whole trimmed text> }` rather than throwing. `load` is the
 * YAML reader (default: the runtime's own).
 */
export function parseFrontmatter(
  raw: string,
  load: (src: string) => unknown = loadYamlLite,
): { data: Record<string, unknown>; body: string } {
  const text = raw.replace(/^﻿/, '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text.trim() };
  let data: Record<string, unknown> = {};
  try {
    const parsed = load(m[1]!);
    if (isRecord(parsed)) data = parsed;
  } catch {
    data = {};
  }
  return { data, body: text.slice(m[0].length).trim() };
}

/** First present key's value, or undefined. */
function pick(data: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (k in data) return data[k];
  return undefined;
}

/** What a subagent `.md` says, in the harness row's shape. */
export interface ParsedSubagent {
  name: string;
  description?: string;
  subagent: { systemPrompt: string; model?: string; toolRefs?: string[] };
}

/** The frontmatter keys the subagent rules read — everything else is foreign. */
export const SUBAGENT_CORE_KEYS: readonly string[] = [
  'name',
  'description',
  'model',
  'tools',
  'allowed-tools',
  'allowedTools',
];

/** The field rules: frontmatter `name`/`description`/`model`/`tools` (or
 *  `allowed-tools`/`allowedTools`), body is the prompt. Null for an empty body. */
export function subagentFromFrontmatter(
  fallbackName: string,
  data: Record<string, unknown>,
  body: string,
): ParsedSubagent | null {
  if (body.length === 0) return null;
  const name = str(pick(data, 'name')) ?? fallbackName;
  const description = str(pick(data, 'description'));
  const model = str(pick(data, 'model'));
  const toolRefs = strList(pick(data, 'tools', 'allowed-tools', 'allowedTools'));
  return {
    name,
    ...(description ? { description } : {}),
    subagent: {
      systemPrompt: body,
      ...(model ? { model } : {}),
      ...(toolRefs ? { toolRefs } : {}),
    },
  };
}

/** agent `.md`: frontmatter `name`/`description`/`model`/`tools`, body is the
 *  prompt. `opts.parseFrontmatter` swaps the YAML reader (the shell passes
 *  js-yaml). */
export function parseSubagentArtifact(
  fallbackName: string,
  raw: string,
  opts?: { parseFrontmatter?: FrontmatterParser },
): ParsedSubagent | null {
  const { data, body } = (opts?.parseFrontmatter ?? ((r: string) => parseFrontmatter(r)))(raw);
  return subagentFromFrontmatter(fallbackName, data, body);
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

/** Claude Code's subagent colour names → the hex a participant stores. The
 *  export writes the NAME back when a colour is exactly one of these, so a
 *  round trip keeps both sides readable. */
export const CLAUDE_AGENT_COLORS: Readonly<Record<string, string>> = {
  red: '#ef4444',
  blue: '#3b82f6',
  green: '#22c55e',
  yellow: '#eab308',
  purple: '#a855f7',
  orange: '#f97316',
  pink: '#ec4899',
  cyan: '#06b6d4',
};

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** The Claude colour name for a stored hex, when it is exactly one of the table's. */
export function claudeColorName(hex: string): string | undefined {
  for (const [name, value] of Object.entries(CLAUDE_AGENT_COLORS)) if (value === hex) return name;
  return undefined;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/** Keys the adapter MAPS (beyond the core rules). Anything else in the
 *  frontmatter is kept in extensions and reported. */
const MAPPED_KEYS = new Set([...SUBAGENT_CORE_KEYS, 'skills', 'mcpServers', 'color', 'permissionMode']);

/** `mcpServers:` is a list of server names, or of inline definitions
 *  (`- name: {command: …}`). Names are what a participant can hold; an inline
 *  definition is not registered here, so only its name is offered (and the
 *  pipeline drops it unless a server of that name exists). */
function mcpServerNames(v: unknown): string[] {
  const out: string[] = [];
  const push = (n: unknown) => {
    const s = str(n);
    if (s && !out.includes(s)) out.push(s);
  };
  if (typeof v === 'string') for (const s of strList(v) ?? []) push(s);
  else if (Array.isArray(v)) {
    for (const item of v) {
      if (typeof item === 'string') push(item);
      else if (isRecord(item)) for (const k of Object.keys(item)) push(k);
    }
  } else if (isRecord(v)) {
    for (const k of Object.keys(v)) push(k);
  }
  return out;
}

export function draftFromClaudeAgentMd(input: ImportInput): { ok: true; draft: ImportDraft } | { ok: false; problems: string[] } {
  const text = utf8(input.bytes);
  const { data, body } = parseFrontmatter(text);
  const parsed = subagentFromFrontmatter(stem(input.fileName), data, body);
  if (!parsed) return { ok: false, problems: ['empty-instructions'] };

  const losses: ImportLoss[] = [];
  const displayName = parsed.name.trim();
  const base = defaultParticipantProfile(displayName);

  // -- model: `inherit` and empty mean "the session's".
  const model = parsed.subagent.model && parsed.subagent.model.toLowerCase() !== 'inherit' ? parsed.subagent.model : undefined;

  // -- colour
  let color = base.color;
  const rawColor = str(data.color);
  if (rawColor) {
    const named = CLAUDE_AGENT_COLORS[rawColor.toLowerCase()];
    if (named) color = named;
    else if (HEX.test(rawColor)) color = rawColor;
    else losses.push({ field: 'color', action: 'defaulted', into: 'profile.color', note: 'unknown-color', value: rawColor });
  }

  // -- permissionMode: only `plan` means something to a participant.
  const guardrails: ImportDraft['profile']['guardrails'] = {};
  const perm = str(data.permissionMode);
  if (perm === 'plan') guardrails.permissionMode = 'plan';
  else if (perm && perm !== 'default') {
    losses.push({
      field: 'permissionMode',
      action: 'defaulted',
      into: 'profile.guardrails.permissionMode',
      note: 'permission-mode-defaulted',
      value: perm,
    });
  }

  // -- everything else in the frontmatter: kept, and said so.
  for (const key of Object.keys(data)) {
    if (MAPPED_KEYS.has(key)) continue;
    losses.push({
      field: key,
      action: 'kept-in-extensions',
      into: "profile.extensions['claude-agent-md']",
      note: 'kept-unmapped-field',
    });
  }

  losses.push({ field: 'avatar', action: 'defaulted', into: 'profile.avatar', note: 'defaulted-avatar', value: '🤖' });

  return {
    ok: true,
    draft: {
      format: 'claude-agent-md',
      name: sanitizeHandle(displayName),
      ...(parsed.description ? { description: parsed.description } : {}),
      systemPrompt: parsed.subagent.systemPrompt,
      ...(model ? { model } : {}),
      toolRefs: parsed.subagent.toolRefs ?? [],
      profile: {
        displayName,
        avatar: base.avatar,
        color,
        knowledge: [],
        guardrails,
        mcpServers: mcpServerNames(data.mcpServers),
        skills: strList(data.skills) ?? [],
      },
      original: { frontmatter: data },
      losses,
      warnings: [],
    },
  };
}

export const claudeAgentMdAdapter: ParticipantAdapter = {
  format: 'claude-agent-md',
  detect({ fileName, bytes }) {
    const md = /\.(?:md|markdown)$/i.test(fileName);
    // A cheap look at the head only — a binary file must not be decoded whole.
    const head = utf8(bytes.subarray(0, 4096));
    const front = /^---[ \t]*\r?\n[\s\S]*?^(?:name|description)[ \t]*:/m.test(head) && head.startsWith('---');
    if (md && front) return 0.95;
    if (md) return 0.6;
    if (front) return 0.55;
    return 0;
  },
  parse(input: ImportInput, env?: ImportEnv): ImportResult {
    const d = draftFromClaudeAgentMd(input);
    if (!d.ok) return d;
    return finalizePlan(d.draft, input, env);
  },
};
