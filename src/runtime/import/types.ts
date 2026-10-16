// src/runtime/import/types.ts
//
// PARTICIPANT IMPORT ADAPTERS — the interface (specs/agent-import-adapters.md §2).
//
// An adapter turns the bytes of a foreign agent definition (a Claude Code subagent
// `.md`, a naby sidecar, a character card) into an `ImportPlan`: the participant
// row it WOULD write, plus what could not be carried over. It never touches a
// store — the shell's `participant.import` applies the plan on a second request
// (two steps, agent-export §7.4).
//
// Adapters MAP and nothing else. Every trust rule — the name, secrets, tool
// permissions, size limits, the keys a file may never set, provenance and the
// final profile gate — is the common pipeline `finalizePlan` (finalize.ts, §4).

import type { AgentInput } from '../store/store.js';
import type { ParticipantProfile } from '../participants.js';

/** The formats an adapter exists (or is reserved) for. The last four are later
 *  milestones (§3.4) and have no adapter yet. */
export type ImportFormat =
  | 'claude-agent-md'
  | 'naby-sidecar'
  | 'character-card-v2'
  | 'character-card-v3'
  | 'm365-declarative-agent'
  | 'crewai-agents-yaml'
  | 'dify-dsl'
  | 'letta-af';

export type ImportInput = {
  fileName: string;
  bytes: Uint8Array;
  /** epoch ms — the plan's `origin.importedAt`. Injected so the pipeline is pure. */
  now: number;
  /** Every agent name already on this machine. Compared IGNORING CASE, the way
   *  the participant name rule compares (`@Name` and `@name` are one handle). */
  existingNames: readonly string[];
};

/**
 * One thing the file carried that did not arrive as-is. Shown in the preview so
 * a silent drop never leaves the user believing everything came in (§1.2).
 *
 * `note` is a stable English KEY (`tool-not-installed`, `defaulted-avatar`, …)
 * that the client maps to a translated sentence; `value` (an addition to the §2
 * sketch) names the specific item — the tool, the server, the lorebook entry —
 * because "1 tool dropped" is not something a user can check.
 */
export type ImportLoss = {
  /** Path in the original, e.g. `tools`, `data.extensions.chub`. */
  field: string;
  action: 'kept-in-extensions' | 'merged' | 'dropped' | 'defaulted';
  /** Where it went, e.g. `profile.guardrails.policy`. */
  into?: string;
  note: string;
  value?: string;
};

export type ImportPlan = {
  format: ImportFormat;
  /** Ready for `putAgent`. No `id`; `kind` is ALWAYS 'participant' — the import
   *  path decides the kind, never the file (agent-export §7.3). */
  agent: AgentInput & { kind: 'participant'; profile: ParticipantProfile };
  losses: ImportLoss[];
  /** Stable English keys too (`prompt-looks-secret`, `renamed`, …). */
  warnings: string[];
  report: { renamedFrom?: string; sourceHash: string; secretsRedacted: number };
};

export type ImportResult = { ok: true; plan: ImportPlan } | { ok: false; problems: string[] };

/** What the machine has — the pipeline keeps only what matches (§4 step 3). */
export type ImportEnv = {
  /** Tool names a participant could be granted here (naby's runtime tools). */
  installedTools: readonly string[];
  /** `mcp_servers.name` of every registered server. */
  mcpServers: readonly string[];
  /** Enabled skill names (`harness_items`, kind 'skill'). */
  skills: readonly string[];
};

/** An empty machine: nothing installed, so every tool/server/skill is dropped.
 *  The safe default when a caller passes no environment. */
export const EMPTY_IMPORT_ENV: ImportEnv = { installedTools: [], mcpServers: [], skills: [] };

/**
 * What an adapter hands the pipeline: the mapped fields, BEFORE any trust rule.
 * Lists may hold names this machine does not have and texts may be oversized —
 * `finalizePlan` decides what survives.
 */
export type ImportDraft = {
  format: ImportFormat;
  /** The handle the file asks for (already shaped like a handle). */
  name: string;
  description?: string;
  systemPrompt: string;
  model?: string;
  toolRefs: string[];
  /** The profile as mapped. `origin` is set by the pipeline; `extensions` here
   *  are carried through (a v2 sidecar's own), and the pipeline adds
   *  `extensions[format] = original`. */
  profile: {
    displayName: string;
    avatar: ParticipantProfile['avatar'];
    color: string;
    greeting?: string;
    examples?: { user: string; assistant: string }[];
    knowledge: ParticipantProfile['knowledge'];
    guardrails: ParticipantProfile['guardrails'];
    mcpServers: string[];
    skills: string[];
    params?: ParticipantProfile['params'];
    extensions?: Record<string, unknown>;
  };
  /** The original, stored under `profile.extensions[format]`. Undefined = the
   *  format is naby's own and nothing in it is foreign (a v2 sidecar). */
  original?: unknown;
  losses: ImportLoss[];
  warnings: string[];
};

export interface ParticipantAdapter {
  readonly format: ImportFormat;
  /** 0..1 — how sure the adapter is that these bytes are its format. */
  detect(input: { fileName: string; bytes: Uint8Array }): number;
  parse(input: ImportInput, env?: ImportEnv): ImportResult;
}
