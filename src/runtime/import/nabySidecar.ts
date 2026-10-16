// src/runtime/import/nabySidecar.ts
//
// A NABY SIDECAR (`<name>.naby.json`) → PARTICIPANT (agent-import-adapters §3.2).
//
//   v2 — a participant export (`PARTICIPANT_EXPORT_FORMAT_VERSION`). The profile
//        is read as written; nothing in it is foreign, so no original is kept.
//   v1 — a persona/custom export (agent-export §1). The base fields come in and
//        the profile is the default one. Its memories, growth ledger and the
//        stage it reached mean nothing for a participant (participants do not
//        grow, R3.8), so they are DROPPED and reported — and the preview points
//        at `agent.import`, which is the path that keeps them (as a custom agent).
//   >2 — refused: a newer file may carry fields whose absence changes meaning.
//
// Never read, in either version: `id`, `kind`, `stage`, `autonomy`, the memory
// scope (an import starts at `session`), and the origin block.

import { defaultParticipantProfile, type KnowledgeItem } from '../participants.js';
import { isRecord, jsonObject, sanitizeHandle, str, strList } from './common.js';
import { finalizePlan } from './finalize.js';
import type { ImportDraft, ImportEnv, ImportInput, ImportLoss, ImportResult, ParticipantAdapter } from './types.js';

/** The sidecar version a participant export writes (agent-import-adapters §5).
 *  Separate from `AGENT_EXPORT_FORMAT_VERSION` (=1) on purpose: bumping that one
 *  would make every persona/custom export unreadable to an older naby. */
export const PARTICIPANT_EXPORT_FORMAT_VERSION = 2;

/** A loosely-typed profile → the draft's profile. Types are checked field by
 *  field; caps and the final gate are the pipeline's. */
function looseProfile(raw: Record<string, unknown>, displayName: string): ImportDraft['profile'] {
  const base = defaultParticipantProfile(displayName);
  const av = isRecord(raw.avatar) ? raw.avatar : undefined;
  const avatar: ImportDraft['profile']['avatar'] =
    av?.kind === 'image' && typeof av.dataUrl === 'string'
      ? { kind: 'image', dataUrl: av.dataUrl }
      : av?.kind === 'emoji' && typeof av.value === 'string'
        ? { kind: 'emoji', value: av.value }
        : base.avatar;
  const examples = Array.isArray(raw.examples)
    ? raw.examples
        .filter(isRecord)
        .filter((e) => typeof e.user === 'string' && typeof e.assistant === 'string')
        .map((e) => ({ user: e.user as string, assistant: e.assistant as string }))
    : [];
  const knowledge: KnowledgeItem[] = [];
  if (Array.isArray(raw.knowledge)) {
    raw.knowledge.filter(isRecord).forEach((k, i) => {
      const src = isRecord(k.source) ? k.source : {};
      const source: KnowledgeItem['source'] | undefined =
        src.kind === 'inline' && typeof src.text === 'string'
          ? { kind: 'inline', text: src.text }
          : src.kind === 'file' && typeof src.path === 'string'
            ? { kind: 'file', path: src.path }
            : undefined;
      if (!source) return;
      const keywords = strList(k.keywords);
      knowledge.push({
        id: str(k.id) ?? `k${i + 1}`,
        title: str(k.title) ?? `Item ${i + 1}`,
        inject: k.inject === 'always' ? 'always' : 'on-demand',
        ...(keywords ? { keywords } : {}),
        source,
      });
    });
  }
  const g = isRecord(raw.guardrails) ? raw.guardrails : {};
  const params = isRecord(raw.params) ? raw.params : undefined;
  return {
    displayName: str(raw.displayName) ?? displayName,
    avatar,
    color: typeof raw.color === 'string' ? raw.color : base.color,
    ...(typeof raw.greeting === 'string' && raw.greeting.trim() ? { greeting: raw.greeting } : {}),
    ...(examples.length > 0 ? { examples } : {}),
    knowledge,
    guardrails: {
      ...(typeof g.policy === 'string' && g.policy.trim() ? { policy: g.policy } : {}),
      ...(g.permissionMode === 'plan' || g.permissionMode === 'default' ? { permissionMode: g.permissionMode } : {}),
    },
    mcpServers: strList(raw.mcpServers) ?? [],
    skills: strList(raw.skills) ?? [],
    ...(params
      ? {
          params: {
            ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
            ...(typeof params.maxOutputTokens === 'number' ? { maxOutputTokens: params.maxOutputTokens } : {}),
          },
        }
      : {}),
    ...(isRecord(raw.extensions) ? { extensions: raw.extensions } : {}),
  };
}

export function draftFromNabySidecar(input: ImportInput): { ok: true; draft: ImportDraft } | { ok: false; problems: string[] } {
  const doc = jsonObject(input.bytes);
  if (!doc) return { ok: false, problems: ['not-json'] };
  const version = typeof doc.formatVersion === 'number' && Number.isFinite(doc.formatVersion) ? doc.formatVersion : undefined;
  if (version === undefined) return { ok: false, problems: ['not-a-naby-export'] };
  if (version > PARTICIPANT_EXPORT_FORMAT_VERSION) {
    return { ok: false, problems: [`newer-format: ${version} (this naby reads up to ${PARTICIPANT_EXPORT_FORMAT_VERSION})`] };
  }
  const agent = isRecord(doc.agent) ? doc.agent : {};
  const wanted = str(agent.name);
  const systemPrompt = str(agent.systemPrompt);
  if (!wanted) return { ok: false, problems: ['no-name'] };
  if (!systemPrompt) return { ok: false, problems: ['empty-instructions'] };

  const losses: ImportLoss[] = [];
  const warnings: string[] = [];
  const v2 = version >= 2 && isRecord(agent.profile);
  const profile = v2 ? looseProfile(agent.profile as Record<string, unknown>, wanted) : looseProfile({}, wanted);
  if (!v2) {
    losses.push({ field: 'agent.profile', action: 'defaulted', into: 'profile', note: 'v1-default-profile' });
    const memories = Array.isArray(doc.memories) ? doc.memories.length : 0;
    const ledger = Array.isArray(doc.ledger) ? doc.ledger.length : 0;
    if (memories > 0) losses.push({ field: 'memories', action: 'dropped', note: 'participants-do-not-learn', value: String(memories) });
    if (ledger > 0) losses.push({ field: 'ledger', action: 'dropped', note: 'participants-do-not-learn', value: String(ledger) });
    if (doc.growthAtExport !== undefined) losses.push({ field: 'growthAtExport', action: 'dropped', note: 'participants-do-not-learn' });
    // "Want it as a custom agent, memories and all? That's the other door."
    warnings.push('sidecar-v1-use-agent-import');
  }
  const scope = str(agent.memoryScope);
  if (scope && scope !== 'session') {
    losses.push({ field: 'agent.memoryScope', action: 'defaulted', into: 'memoryScope', note: 'memory-scope-session', value: scope });
  }

  return {
    ok: true,
    draft: {
      format: 'naby-sidecar',
      name: sanitizeHandle(wanted),
      ...(str(agent.description) ? { description: str(agent.description)! } : {}),
      systemPrompt,
      ...(str(agent.model) ? { model: str(agent.model)! } : {}),
      toolRefs: strList(agent.toolRefs) ?? [],
      profile,
      // v2 is naby's own shape — nothing foreign to keep, and keeping the file
      // would make a re-import differ from the export it came from. v1 keeps its
      // provenance block (not the memories or the ledger, which were dropped).
      ...(v2
        ? {}
        : {
            original: {
              formatVersion: version,
              ...(doc.source !== undefined ? { source: doc.source } : {}),
              ...(doc.exportedAt !== undefined ? { exportedAt: doc.exportedAt } : {}),
              ...(isRecord(doc.origin) ? { origin: doc.origin } : {}),
            },
          }),
      losses,
      warnings,
    },
  };
}

export const nabySidecarAdapter: ParticipantAdapter = {
  format: 'naby-sidecar',
  detect({ fileName, bytes }) {
    const doc = jsonObject(bytes);
    if (!doc) return 0;
    const named = /\.naby\.json$/i.test(fileName);
    if (doc.source === 'naby' && typeof doc.formatVersion === 'number') return 0.95;
    if (typeof doc.formatVersion === 'number' && isRecord(doc.agent)) return named ? 0.9 : 0.7;
    return named ? 0.5 : 0;
  },
  parse(input: ImportInput, env?: ImportEnv): ImportResult {
    const d = draftFromNabySidecar(input);
    if (!d.ok) return d;
    return finalizePlan(d.draft, input, env);
  },
};
