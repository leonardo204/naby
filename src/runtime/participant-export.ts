// src/runtime/participant-export.ts
//
// EXPORTING A PARTICIPANT (agent-import-adapters §5, multi-agent-chat R4.4).
//
// The same two files agent-export writes for naby and custom agents, with the
// participant's own shape:
//
//   <name>.md          A stock Claude Code subagent. Frontmatter `name`,
//                      `description`, `model`, `tools`, and — the participant's
//                      resources, in Claude Code's own field names — `skills`,
//                      `mcpServers`, `color`. The body is the instructions plus
//                      the guardrail policy as a section. Knowledge is NOT
//                      inlined (20 × 16 KB would swamp the prompt, and Claude Code
//                      has no notion of it); a trailing comment says how many
//                      items stayed in the sidecar.
//   <name>.naby.json   Sidecar v2 (`PARTICIPANT_EXPORT_FORMAT_VERSION`): the
//                      agent row plus `agent.profile`, whole. `memories` and
//                      `ledger` are empty and there is no `growthAtExport` —
//                      a participant does not grow.
//
// v2 IS FOR PARTICIPANTS ONLY. `AGENT_EXPORT_FORMAT_VERSION` stays 1, so a
// persona/custom export remains readable by an older naby; only this file
// carries the new constant (§5).
//
// SECRETS. The data is leaving the machine, so the profile's free text (policy,
// greeting, examples, inline knowledge) is swept with `looksLikeSecret`; a hit is
// replaced by REDACTED and counted. The instructions are not redacted — that
// would change the agent — the report flags them instead (agent-export §2).

import type { Agent } from './store/store.js';
import { REDACTED, exportBasename, yamlScalar } from './agent-export.js';
import { looksLikeSecret } from './tools.js';
import type { ParticipantProfile } from './participants.js';
import { PARTICIPANT_EXPORT_FORMAT_VERSION } from './import/nabySidecar.js';
import { claudeColorName } from './import/claudeAgentMd.js';
import { buildZip } from './zip.js';

export { PARTICIPANT_EXPORT_FORMAT_VERSION };

/** The `.md` section the guardrail policy goes under. English: the file is read
 *  by other tools and by a model in an unknown locale. */
export const GUARDRAILS_HEADING = '## Guardrails';

export interface ParticipantExportReport {
  formatVersion: number;
  /** Knowledge items carried in the sidecar (none are inlined in the `.md`). */
  knowledgeItems: number;
  /** Profile text fields replaced by REDACTED. */
  secretsRedacted: number;
  /** The instructions look like they contain a credential — not redacted. */
  promptLooksSecret: boolean;
}

export interface ParticipantExportResult {
  markdownName: string;
  markdown: string;
  sidecarName: string;
  sidecar: string;
  report: ParticipantExportReport;
}

function redactProfile(profile: ParticipantProfile): { profile: ParticipantProfile; redacted: number } {
  let redacted = 0;
  const scrub = (s: string): string => {
    if (looksLikeSecret(s)) {
      redacted += 1;
      return REDACTED;
    }
    return s;
  };
  const out: ParticipantProfile = JSON.parse(JSON.stringify(profile)) as ParticipantProfile;
  if (out.greeting !== undefined) out.greeting = scrub(out.greeting);
  if (out.guardrails.policy !== undefined) out.guardrails.policy = scrub(out.guardrails.policy);
  if (out.examples) out.examples = out.examples.map((e) => ({ user: scrub(e.user), assistant: scrub(e.assistant) }));
  out.knowledge = out.knowledge.map((k) =>
    k.source.kind === 'inline' ? { ...k, source: { kind: 'inline', text: scrub(k.source.text) } } : k,
  );
  return { profile: out, redacted };
}

function yamlList(key: string, values: readonly string[]): string[] {
  const usable = values.map((v) => v.trim()).filter(Boolean);
  if (usable.length === 0) return [];
  return [`${key}:`, ...usable.map((v) => `  - ${yamlScalar(v)}`)];
}

/**
 * Build both files and the report for one participant. PURE: no clock (`now`),
 * no filesystem, no store. Throws only when `agent` is not a participant.
 */
export function buildParticipantExport(input: { agent: Agent; now: number }): ParticipantExportResult {
  const { agent, now } = input;
  if (agent.kind !== 'participant' || !agent.profile) {
    throw new Error('buildParticipantExport: not a participant');
  }
  const { profile, redacted } = redactProfile(agent.profile);
  const day = new Date(now).toISOString().slice(0, 10);

  // -- <name>.md ------------------------------------------------------------
  const front: string[] = ['---', `name: ${yamlScalar(agent.name)}`];
  if (agent.description) front.push(`description: ${yamlScalar(agent.description)}`);
  if (agent.model) front.push(`model: ${yamlScalar(agent.model)}`);
  const tools = (agent.toolRefs ?? []).map((t) => t.trim()).filter((t) => t && !t.includes(','));
  if (tools.length > 0) front.push(`tools: ${tools.join(', ')}`);
  front.push(...yamlList('skills', profile.skills));
  front.push(...yamlList('mcpServers', profile.mcpServers));
  // Claude Code knows colour NAMES; a colour that is exactly one of its names is
  // written as the name, any other as the hex (the naby importer reads both).
  front.push(`color: ${yamlScalar(claudeColorName(profile.color) ?? profile.color)}`);
  front.push('---');

  const body: string[] = [agent.systemPrompt.trim()];
  if (profile.guardrails.policy?.trim()) body.push('', GUARDRAILS_HEADING, '', profile.guardrails.policy.trim());
  body.push(
    '',
    `<!-- exported from naby on ${day} (UTC) · ${profile.knowledge.length} knowledge items in the sidecar -->`,
  );
  const markdown = `${front.join('\n')}\n\n${body.join('\n')}\n`;

  // -- <name>.naby.json -----------------------------------------------------
  // No `id`, no `kind` in the agent block — they survive only under `origin`,
  // where nothing acts on them (agent-export §3).
  const sidecarDoc = {
    formatVersion: PARTICIPANT_EXPORT_FORMAT_VERSION,
    source: 'naby',
    exportedAt: now,
    agent: {
      name: agent.name,
      ...(agent.description ? { description: agent.description } : {}),
      systemPrompt: agent.systemPrompt,
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.toolRefs ? { toolRefs: agent.toolRefs } : {}),
      memoryScope: agent.memoryScope,
      autonomy: agent.autonomy,
      profile,
    },
    origin: { agentId: agent.id, kind: agent.kind, createdAt: agent.createdAt },
    memories: [],
    ledger: [],
  };

  const base = exportBasename(agent.name);
  return {
    markdownName: `${base}.md`,
    markdown,
    sidecarName: `${base}.naby.json`,
    sidecar: `${JSON.stringify(sidecarDoc, null, 2)}\n`,
    report: {
      formatVersion: PARTICIPANT_EXPORT_FORMAT_VERSION,
      knowledgeItems: profile.knowledge.length,
      secretsRedacted: redacted,
      promptLooksSecret: looksLikeSecret(agent.systemPrompt),
    },
  };
}

export interface ParticipantBundle {
  fileName: string;
  /** The zip, in memory — the caller decides where (if anywhere) it is saved. */
  bytes: Uint8Array;
  manifest: { formatVersion: number; exportedAt: number; agents: string[] };
  reports: Record<string, ParticipantExportReport>;
}

/**
 * Several participants in one zip (§5): a `<name>.md` + `<name>.naby.json` pair
 * each and `manifest.json {formatVersion: 2, exportedAt, agents}`. Entries are
 * STORED (no compression) — the files are small text and a store-only archive is
 * the simplest one every unzip reads. Two participants whose basenames collide
 * get `-2`, `-3` so no pair overwrites another.
 */
export function buildParticipantBundle(agents: readonly Agent[], now: number): ParticipantBundle {
  const entries: { name: string; data: string; method: 0 }[] = [];
  const used = new Set<string>();
  const names: string[] = [];
  const reports: Record<string, ParticipantExportReport> = {};
  for (const agent of agents) {
    const out = buildParticipantExport({ agent, now });
    const stem = out.markdownName.replace(/\.md$/, '');
    let base = stem;
    for (let i = 2; used.has(base.toLowerCase()); i += 1) base = `${stem}-${i}`;
    used.add(base.toLowerCase());
    entries.push({ name: `${base}.md`, data: out.markdown, method: 0 }, { name: `${base}.naby.json`, data: out.sidecar, method: 0 });
    names.push(agent.name);
    reports[agent.name] = out.report;
  }
  const manifest = { formatVersion: PARTICIPANT_EXPORT_FORMAT_VERSION, exportedAt: now, agents: names };
  entries.unshift({ name: 'manifest.json', data: `${JSON.stringify(manifest, null, 2)}\n`, method: 0 });
  const day = new Date(now).toISOString().slice(0, 10);
  return {
    fileName: `naby-participants-${day}.zip`,
    bytes: new Uint8Array(buildZip(entries)),
    manifest,
    reports,
  };
}
