// src/runtime/import/finalize.ts
//
// THE COMMON PIPELINE every adapter ends in (agent-import-adapters §4). The
// order is the rule:
//
//   1. name        — a free `@` handle (`freeAgentName`), compared ignoring case;
//                    the hub's handles are never free.
//   2. secrets     — `looksLikeSecret` over policy / greeting / examples /
//                    inline knowledge: a hit is replaced by REDACTED and counted.
//                    The instructions are NOT redacted (that would change the
//                    agent) — the user is warned instead (agent-export §2).
//   3. permissions — tools, MCP servers and skills survive only when THIS
//                    machine has them. A file cannot grant a tool by naming it.
//   4. size        — knowledge 20 · inline 16 KB · examples 5 · avatar 64 KB ·
//                    instructions 32 KB (and the profile gate's per-field caps).
//                    Whatever is over is dropped and reported.
//   5. ignored     — `id`, `kind`, `stage`, `trusted`, `autonomy` are stripped
//                    from everything the plan carries, extensions included. The
//                    row's `kind` is 'participant' because THIS path says so.
//   6. provenance  — `profile.origin` with the sha256 of the bytes;
//                    `extensions[format]` = the original.
//   7. the gate    — `parseParticipantProfile` has the last word.
//
// PURE: no store, no clock (`input.now`), no network.

import { createHash } from 'node:crypto';
import { REDACTED } from '../agent-export.js';
import { freeAgentName } from '../agent-import.js';
import {
  HUB_MENTION_ALIASES,
  PARTICIPANT_MAX_EMOJI_CHARS,
  PARTICIPANT_MAX_EXAMPLE_BYTES,
  PARTICIPANT_MAX_EXAMPLES,
  PARTICIPANT_MAX_EXTENSIONS_BYTES,
  PARTICIPANT_MAX_GREETING_BYTES,
  PARTICIPANT_MAX_IMAGE_BYTES,
  PARTICIPANT_MAX_INLINE_BYTES,
  PARTICIPANT_MAX_KNOWLEDGE,
  PARTICIPANT_MAX_POLICY_BYTES,
  defaultParticipantProfile,
  parseParticipantProfile,
  type KnowledgeItem,
  type ParticipantProfile,
} from '../participants.js';
import { looksLikeSecret } from '../tools.js';
import { clipUtf8, isRecord, utf8Bytes } from './common.js';
import { EMPTY_IMPORT_ENV, type ImportDraft, type ImportEnv, type ImportInput, type ImportLoss, type ImportResult } from './types.js';

/** At most this many bytes (UTF-8) of imported instructions (§4 step 4). */
export const IMPORT_MAX_SYSTEM_PROMPT_BYTES = 32 * 1024;

/** Keys a file may never set, wherever they appear (§4 step 5). */
export const IMPORT_IGNORED_KEYS: readonly string[] = ['id', 'kind', 'stage', 'trusted', 'autonomy'];

/** Claude Code's own tool names. They mean nothing to naby's engines, so they
 *  are reported by name ("a Claude Code built-in") rather than as "not installed". */
export const CLAUDE_BUILTIN_TOOLS: ReadonlySet<string> = new Set([
  'Read', 'Write', 'Edit', 'MultiEdit', 'Bash', 'BashOutput', 'KillShell', 'KillBash', 'Glob', 'Grep', 'LS',
  'WebFetch', 'WebSearch', 'NotebookEdit', 'NotebookRead', 'TodoWrite', 'Task', 'Agent', 'SlashCommand',
  'ExitPlanMode', 'Skill',
]);

/** Image types an imported avatar may be. SVG is refused: it is a document that
 *  can carry script, and an avatar from a file is untrusted content. */
const AVATAR_IMAGE = /^data:image\/(?:png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i;

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** The environment `finalizePlan` reads. `existingNames`/`now` override the
 *  input's when given (the shell re-reads names at apply time). */
export type FinalizeEnv = ImportEnv & { existingNames?: readonly string[]; now?: number };

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Step 1 — a free handle, ignoring case. `freeAgentName` compares exactly, so
 *  every candidate it could try that collides in another case is added to the
 *  taken list in the candidate's own spelling. */
export function freeParticipantName(wanted: string, existing: readonly string[]): string {
  const takenLower = new Set([...existing, ...HUB_MENTION_ALIASES].map((n) => n.toLowerCase()));
  const candidates = [wanted, `${wanted}-imported`];
  for (let i = 2; i < 1000; i += 1) candidates.push(`${wanted}-imported-${i}`);
  const taken = [...existing, ...candidates.filter((c) => takenLower.has(c.toLowerCase()))];
  return freeAgentName(wanted, taken);
}

/** Step 5 — a deep copy without the ignored keys; `stripped` collects the paths. */
function stripIgnored(v: unknown, path: string, stripped: string[]): unknown {
  if (Array.isArray(v)) return v.map((x, i) => stripIgnored(x, `${path}[${i}]`, stripped));
  if (!isRecord(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (IMPORT_IGNORED_KEYS.includes(k)) {
      stripped.push(path ? `${path}.${k}` : k);
      continue;
    }
    out[k] = stripIgnored(x, path ? `${path}.${k}` : k, stripped);
  }
  return out;
}

/** JSON-safe copy (drops functions/undefined, turns non-finite numbers to null). */
function jsonCopy(v: unknown): unknown {
  if (v === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(v)) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Run the pipeline on an adapter's draft. Never throws: a draft the profile
 * gate still refuses after every step comes back as `problems`.
 */
export function finalizePlan(draft: ImportDraft, input: ImportInput, env: FinalizeEnv = EMPTY_IMPORT_ENV): ImportResult {
  const losses: ImportLoss[] = [...draft.losses];
  const warnings: string[] = [...draft.warnings];
  const now = env.now ?? input.now;

  // -- 1. name ---------------------------------------------------------------
  const wanted = draft.name.trim() || 'participant';
  const name = freeParticipantName(wanted, env.existingNames ?? input.existingNames);
  const renamedFrom = name !== wanted ? wanted : undefined;
  if (renamedFrom) warnings.push('renamed');

  // -- 2. secrets ------------------------------------------------------------
  let secretsRedacted = 0;
  const scrub = (s: string | undefined): string | undefined => {
    if (s === undefined) return undefined;
    if (looksLikeSecret(s)) {
      secretsRedacted += 1;
      return REDACTED;
    }
    return s;
  };
  let systemPrompt = draft.systemPrompt.trim();
  if (!systemPrompt) return { ok: false, problems: ['empty-instructions'] };
  if (looksLikeSecret(systemPrompt)) warnings.push('prompt-looks-secret');
  const p = draft.profile;
  let greeting = scrub(p.greeting);
  let policy = scrub(p.guardrails.policy);
  let examples = (p.examples ?? []).map((e) => ({ user: scrub(e.user)!, assistant: scrub(e.assistant)! }));
  let knowledge: KnowledgeItem[] = p.knowledge.map((k) =>
    k.source.kind === 'inline' ? { ...k, source: { kind: 'inline', text: scrub(k.source.text)! } } : k,
  );

  // -- 3. permissions --------------------------------------------------------
  const installed = new Set(env.installedTools);
  const servers = new Set(env.mcpServers);
  const skillSet = new Set(env.skills);
  const toolRefs: string[] = [];
  for (const raw of draft.toolRefs) {
    const t = raw.trim();
    if (!t) continue;
    // Claude Code names an MCP tool `mcp__<server>__<tool>`; naby names it
    // `<server>__<tool>`. Same tool, so the name is translated, not dropped.
    const mcp = /^mcp__(.+?)__(.+)$/.exec(t);
    const local = mcp ? `${mcp[1]}__${mcp[2]}` : t;
    const sep = local.indexOf('__');
    const server = sep > 0 ? local.slice(0, sep) : '';
    if (installed.has(local) || (server && servers.has(server))) {
      if (!toolRefs.includes(local)) toolRefs.push(local);
      if (local !== t) losses.push({ field: 'tools', action: 'merged', into: 'toolRefs', note: 'mcp-tool-renamed', value: `${t} → ${local}` });
      continue;
    }
    losses.push({
      field: 'tools',
      action: 'dropped',
      note: CLAUDE_BUILTIN_TOOLS.has(t) ? 'claude-builtin-tool' : server ? 'mcp-server-not-registered' : 'tool-not-installed',
      value: t,
    });
  }
  const keepNames = (list: string[], have: Set<string>, field: string, note: string): string[] => {
    const out: string[] = [];
    for (const n of list) {
      const v = n.trim();
      if (!v || out.includes(v)) continue;
      if (have.has(v)) out.push(v);
      else losses.push({ field, action: 'dropped', note, value: v });
    }
    return out;
  };
  const mcpServers = keepNames(p.mcpServers, servers, 'mcpServers', 'mcp-server-not-registered');
  const skills = keepNames(p.skills, skillSet, 'skills', 'skill-not-installed');

  // -- 4. size ---------------------------------------------------------------
  if (utf8Bytes(systemPrompt) > IMPORT_MAX_SYSTEM_PROMPT_BYTES) {
    systemPrompt = clipUtf8(systemPrompt, IMPORT_MAX_SYSTEM_PROMPT_BYTES);
    losses.push({ field: 'systemPrompt', action: 'dropped', note: 'truncated', value: `${IMPORT_MAX_SYSTEM_PROMPT_BYTES / 1024} KB` });
  }
  if (greeting !== undefined && utf8Bytes(greeting) > PARTICIPANT_MAX_GREETING_BYTES) {
    greeting = clipUtf8(greeting, PARTICIPANT_MAX_GREETING_BYTES);
    losses.push({ field: 'greeting', action: 'dropped', note: 'truncated', value: `${PARTICIPANT_MAX_GREETING_BYTES / 1024} KB` });
  }
  if (policy !== undefined && utf8Bytes(policy) > PARTICIPANT_MAX_POLICY_BYTES) {
    policy = clipUtf8(policy, PARTICIPANT_MAX_POLICY_BYTES);
    losses.push({ field: 'guardrails.policy', action: 'dropped', note: 'truncated', value: `${PARTICIPANT_MAX_POLICY_BYTES / 1024} KB` });
  }
  examples = examples.filter((e, i) => {
    if (utf8Bytes(e.user) + utf8Bytes(e.assistant) > PARTICIPANT_MAX_EXAMPLE_BYTES) {
      losses.push({ field: `examples[${i}]`, action: 'dropped', note: 'example-too-large' });
      return false;
    }
    return true;
  });
  if (examples.length > PARTICIPANT_MAX_EXAMPLES) {
    for (let i = PARTICIPANT_MAX_EXAMPLES; i < examples.length; i += 1) {
      losses.push({ field: `examples[${i}]`, action: 'dropped', note: 'over-example-limit' });
    }
    examples = examples.slice(0, PARTICIPANT_MAX_EXAMPLES);
  }
  // Knowledge: a `file` source from another machine names a path that does not
  // exist here (and a hostile one could name a secret file for a later reader),
  // so only inline knowledge is imported.
  const seenIds = new Set<string>();
  knowledge = knowledge.filter((k, i) => {
    if (k.source.kind !== 'inline') {
      losses.push({ field: `knowledge[${i}]`, action: 'dropped', note: 'knowledge-file-dropped', value: k.title });
      return false;
    }
    return true;
  });
  if (knowledge.length > PARTICIPANT_MAX_KNOWLEDGE) {
    for (let i = PARTICIPANT_MAX_KNOWLEDGE; i < knowledge.length; i += 1) {
      losses.push({ field: `knowledge[${i}]`, action: 'dropped', note: 'over-knowledge-limit', value: knowledge[i]!.title });
    }
    knowledge = knowledge.slice(0, PARTICIPANT_MAX_KNOWLEDGE);
  }
  knowledge = knowledge.map((k, i) => {
    let id = k.id.trim() || `k${i + 1}`;
    while (seenIds.has(id)) id = `${id}-${i + 1}`;
    seenIds.add(id);
    const title = k.title.trim() || `Item ${i + 1}`;
    let text = k.source.kind === 'inline' ? k.source.text : '';
    if (utf8Bytes(text) > PARTICIPANT_MAX_INLINE_BYTES) {
      text = clipUtf8(text, PARTICIPANT_MAX_INLINE_BYTES);
      losses.push({ field: `knowledge[${i}]`, action: 'dropped', note: 'truncated', value: title });
    }
    return {
      id,
      title,
      inject: k.inject === 'always' ? 'always' : 'on-demand',
      ...(k.keywords && k.keywords.length > 0 ? { keywords: [...k.keywords] } : {}),
      source: { kind: 'inline', text },
    };
  });

  const fallback = defaultParticipantProfile(p.displayName || wanted);
  let avatar: ParticipantProfile['avatar'] = p.avatar;
  if (avatar.kind === 'image') {
    if (!AVATAR_IMAGE.test(avatar.dataUrl)) {
      losses.push({ field: 'avatar', action: 'defaulted', into: 'profile.avatar', note: 'avatar-unsupported-image', value: fallback.avatar.kind === 'emoji' ? fallback.avatar.value : '' });
      avatar = fallback.avatar;
    } else if (utf8Bytes(avatar.dataUrl) > PARTICIPANT_MAX_IMAGE_BYTES) {
      losses.push({ field: 'avatar', action: 'defaulted', into: 'profile.avatar', note: 'avatar-too-large', value: `${Math.ceil(utf8Bytes(avatar.dataUrl) / 1024)} KB` });
      avatar = fallback.avatar;
    }
  } else if (!avatar.value.trim() || [...avatar.value.trim()].length > PARTICIPANT_MAX_EMOJI_CHARS) {
    losses.push({ field: 'avatar', action: 'defaulted', into: 'profile.avatar', note: 'avatar-unsupported-emoji' });
    avatar = fallback.avatar;
  }
  let color = p.color.trim();
  if (!HEX_COLOR.test(color)) {
    losses.push({ field: 'color', action: 'defaulted', into: 'profile.color', note: 'unknown-color', value: color });
    color = fallback.color;
  }
  let params: ParticipantProfile['params'];
  if (p.params) {
    const out: NonNullable<ParticipantProfile['params']> = {};
    const { temperature, maxOutputTokens } = p.params;
    if (typeof temperature === 'number' && Number.isFinite(temperature) && temperature >= 0 && temperature <= 2) out.temperature = temperature;
    else if (temperature !== undefined) losses.push({ field: 'params.temperature', action: 'dropped', note: 'invalid-value' });
    if (typeof maxOutputTokens === 'number' && Number.isInteger(maxOutputTokens) && maxOutputTokens >= 1) out.maxOutputTokens = maxOutputTokens;
    else if (maxOutputTokens !== undefined) losses.push({ field: 'params.maxOutputTokens', action: 'dropped', note: 'invalid-value' });
    if (Object.keys(out).length > 0) params = out;
  }

  // -- 5 + 6. extensions: carried, the original added, ignored keys stripped --
  const stripped: string[] = [];
  let extensions: Record<string, unknown> = {};
  const carried = jsonCopy(p.extensions);
  if (isRecord(carried)) extensions = stripIgnored(carried, 'extensions', stripped) as Record<string, unknown>;
  const original = jsonCopy(draft.original);
  if (original !== undefined) extensions[draft.format] = stripIgnored(original, draft.format, stripped);
  // One line per key, not per place: a lorebook carries an `id` on every entry,
  // and twenty identical lines would bury the rest of the report.
  const byKey = new Map<string, string[]>();
  for (const path of stripped) {
    const key = path.slice(Math.max(path.lastIndexOf('.'), 0)).replace(/^\./, '');
    byKey.set(key, [...(byKey.get(key) ?? []), path]);
  }
  for (const [key, paths] of byKey) {
    losses.push({
      field: paths.length > 1 ? `${paths[0]} (+${paths.length - 1})` : paths[0]!,
      action: 'dropped',
      note: 'ignored-key',
      value: key,
    });
  }
  if (extensions[draft.format] !== undefined && utf8Bytes(JSON.stringify(extensions)) > PARTICIPANT_MAX_EXTENSIONS_BYTES) {
    const bytes = utf8Bytes(JSON.stringify(extensions[draft.format]));
    extensions[draft.format] = { omitted: 'too-large', bytes };
    losses.push({ field: draft.format, action: 'dropped', into: `profile.extensions['${draft.format}']`, note: 'original-too-large', value: `${Math.ceil(bytes / 1024)} KB` });
  }
  if (utf8Bytes(JSON.stringify(extensions)) > PARTICIPANT_MAX_EXTENSIONS_BYTES) {
    losses.push({ field: 'extensions', action: 'dropped', note: 'original-too-large' });
    extensions = original !== undefined ? { [draft.format]: extensions[draft.format] } : {};
  }

  const profileInput: ParticipantProfile = {
    displayName: p.displayName.trim() || wanted,
    avatar,
    color,
    ...(greeting !== undefined && greeting.trim() ? { greeting } : {}),
    ...(examples.length > 0 ? { examples } : {}),
    knowledge,
    guardrails: {
      ...(policy !== undefined && policy.trim() ? { policy } : {}),
      ...(p.guardrails.permissionMode ? { permissionMode: p.guardrails.permissionMode } : {}),
    },
    mcpServers,
    skills,
    ...(params ? { params } : {}),
    origin: { format: draft.format, importedAt: now, sourceHash: sha256Hex(input.bytes), sourceName: input.fileName },
    ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
  };

  // -- 7. the gate -----------------------------------------------------------
  let profile: ParticipantProfile;
  try {
    profile = parseParticipantProfile(profileInput);
  } catch (e) {
    return { ok: false, problems: [`profile-invalid: ${e instanceof Error ? e.message : String(e)}`] };
  }

  const description = draft.description?.trim();
  const model = draft.model?.trim();
  return {
    ok: true,
    plan: {
      format: draft.format,
      agent: {
        name,
        kind: 'participant',
        ...(description ? { description } : {}),
        systemPrompt,
        ...(model ? { model } : {}),
        toolRefs,
        // An imported participant reads only its own conversation until the user
        // widens it — the same default a new participant gets (§8.1, MAC-M1 #5).
        memoryScope: 'session',
        // NOT NULL in the table; nothing reads it for a participant (§8.1).
        autonomy: { escalation: 'inline' },
        profile,
      },
      losses,
      warnings: [...new Set(warnings)],
      report: { ...(renamedFrom ? { renamedFrom } : {}), sourceHash: profile.origin!.sourceHash, secretsRedacted },
    },
  };
}
