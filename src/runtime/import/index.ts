// src/runtime/import/index.ts
//
// THE ENTRY POINT for participant imports (agent-import-adapters §2).
//
// `importParticipant` picks the adapter — the one the caller named, or the one
// most sure the bytes are its format (`detect`, below 0.5 = not recognised) —
// and returns its plan. Pure: the shell's `participant.import` action applies the
// plan on a second request.

import { characterCardV2Adapter, characterCardV3Adapter } from './characterCard.js';
import { claudeAgentMdAdapter } from './claudeAgentMd.js';
import { nabySidecarAdapter } from './nabySidecar.js';
import type { ImportEnv, ImportFormat, ImportInput, ImportResult, ParticipantAdapter } from './types.js';
import { buildToolset, Outbox } from '../tools.js';
import { buildWorkspaceTools } from '../fs-tools.js';
import { SKILL_LOAD_TOOL_NAME } from '../org-harness-turn.js';

/** Every adapter, in tie-break order (the first wins an equal score). */
export const PARTICIPANT_ADAPTERS: readonly ParticipantAdapter[] = [
  nabySidecarAdapter,
  characterCardV3Adapter,
  characterCardV2Adapter,
  claudeAgentMdAdapter,
];

/** Below this, no adapter claims the file. */
export const DETECT_THRESHOLD = 0.5;

/** The adapter for these bytes and its score, or undefined below the threshold. */
export function detectImportFormat(input: { fileName: string; bytes: Uint8Array }): { format: ImportFormat; score: number } | undefined {
  let best: { adapter: ParticipantAdapter; score: number } | undefined;
  for (const adapter of PARTICIPANT_ADAPTERS) {
    let score = 0;
    try {
      score = adapter.detect(input);
    } catch {
      score = 0;
    }
    if (!best || score > best.score) best = { adapter, score };
  }
  return best && best.score >= DETECT_THRESHOLD ? { format: best.adapter.format, score: best.score } : undefined;
}

/**
 * Parse `input` into a participant plan. `opts.format` forces an adapter (a
 * format with no adapter yet is a problem, not a guess); `opts.env` is what this
 * machine has — tools, MCP servers, skills — and defaults to NOTHING, so a
 * caller that forgets it gets a participant with no tools rather than one with
 * whatever the file asked for.
 */
export function importParticipant(
  input: ImportInput,
  opts: { format?: ImportFormat; env?: ImportEnv } = {},
): ImportResult {
  let adapter: ParticipantAdapter | undefined;
  if (opts.format) {
    adapter = PARTICIPANT_ADAPTERS.find((a) => a.format === opts.format);
    if (!adapter) return { ok: false, problems: [`format not supported yet: ${opts.format}`] };
  } else {
    const hit = detectImportFormat(input);
    if (!hit) return { ok: false, problems: ['unrecognized format'] };
    adapter = PARTICIPANT_ADAPTERS.find((a) => a.format === hit.format)!;
  }
  try {
    return adapter.parse(input, opts.env);
  } catch (e) {
    // An adapter bug must read as "this file could not be imported", never as a
    // 500 from the action.
    return { ok: false, problems: [`import failed: ${e instanceof Error ? e.message : String(e)}`] };
  }
}

/**
 * The names of naby's own runtime tools — the ones a participant's `toolRefs`
 * can grant (MCP tools are `<server>__<tool>` and are matched by server). Built
 * with the SAME builders a turn uses (`buildToolset`, `buildWorkspaceTools`), so
 * the catalogue cannot drift from what an engine actually offers. Includes the
 * mutating workspace tools (a participant may be granted them; the turn's own
 * mode still removes them in plan mode).
 */
export function runtimeToolNames(): string[] {
  const builtin = buildToolset(new Outbox(), undefined, undefined, undefined, undefined, { cwd: '/' });
  const workspace = buildWorkspaceTools({ cwd: '/', allowMutations: true });
  const names = [...builtin.toolSchemas, ...workspace.toolSchemas].map((t) => t.name);
  names.push(SKILL_LOAD_TOOL_NAME);
  return [...new Set(names)].sort();
}

export * from './types.js';
export { finalizePlan, freeParticipantName, sha256Hex, CLAUDE_BUILTIN_TOOLS, IMPORT_IGNORED_KEYS, IMPORT_MAX_SYSTEM_PROMPT_BYTES, type FinalizeEnv } from './finalize.js';
export {
  claudeAgentMdAdapter,
  parseFrontmatter,
  parseSubagentArtifact,
  subagentFromFrontmatter,
  claudeColorName,
  CLAUDE_AGENT_COLORS,
  SUBAGENT_CORE_KEYS,
  type FrontmatterParser,
  type ParsedSubagent,
} from './claudeAgentMd.js';
export { nabySidecarAdapter, PARTICIPANT_EXPORT_FORMAT_VERSION } from './nabySidecar.js';
export { characterCardV2Adapter, characterCardV3Adapter, parseMesExample, CARD_USER_LABEL } from './characterCard.js';
export { buildPng, readPngTextChunks, stripPngTextChunks, type PngTextChunk } from './png.js';
export { loadYamlLite } from './yamlLite.js';
