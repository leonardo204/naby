// src/runtime/agent-export.ts
//
// TAKING A GROWN AGENT WITH YOU (Phase 3, P3-M6).
//
// An agent that only works inside naby is a hostage, not an asset. The whole
// premise — "기억과 하네스를 벤더 밖 내 자산으로 둔다" — requires that what naby
// learned about its user can leave, in a form other tools already understand.
//
// TWO FILES, and the split is the design:
//
//   <name>.md          A stock Claude Code subagent. Works with no naby at all,
//                      because the learned facts are INLINED into the body. One
//                      file is enough for the agent to actually behave the way it
//                      learned to — a package where the knowledge lives only in a
//                      sidecar would be a subagent that forgot everything.
//   <name>.naby.json   The lossless part Claude Code ignores: provenance,
//                      confidence, timestamps, the growth ledger. `.md` carries
//                      values; this carries where each value came from, without
//                      which a re-import could not apply the write gate.
//
// THE FORMAT IS NOT GUESSED. The shell already has an importer,
// `parseSubagentArtifact`, that reads `name`/`description`/`model`/`tools` and
// takes the body as the system prompt. This emits exactly what that parser reads
// back, so the round trip is a test rather than a hope.
//
// WHAT NEVER LEAVES:
//   * `proposed` memory — nobody reviewed it. Exporting it would launder
//     unverified claims into another environment.
//   * `session` scope — true only inside one conversation, by definition.
//   * anything credential-shaped — a second sweep at the moment data leaves the
//     machine. Capture already refuses secrets, but `app.db` encryption is still
//     undecided (strategy §7.2), so a token reaching a plain file would be a
//     plaintext credential. Dropped items are COUNTED and reported: a silent drop
//     leaves the user believing everything went.
//
// AND THE STAGE IS PROVENANCE, NOT PERMISSION. Stock Claude Code cannot verify
// `butterfly`, and a person can type it into a file. So the `.md` records only a
// fact ("reached the butterfly stage in naby on 2026-07-25") and no naby code path
// reads a stage from an artifact — addressability comes from `canBeAddressed(
// computeGrowth(ledger))` and nowhere else. An exported file therefore cannot
// DECLARE trust on another machine; the ledger has to earn it again.

import type { Agent, EvalEvent, MemoryItem } from './store/store.js';
import { looksLikeSecret } from './tools.js';
import { renderMemoryLine } from './memory-inject.js';
import { computeGrowth, type CheckinRecord, type GrowthStage } from './growth.js';

/** Bumped when the sidecar's shape changes in a way an older naby could not read.
 *  Present from version 1 so a migration never has to guess what it is looking at. */
export const AGENT_EXPORT_FORMAT_VERSION = 1;

/** Marker left where free text was redacted, so a reader sees that something was
 *  removed rather than silently reading a shortened sentence. */
export const REDACTED = '[redacted: looked like a credential]';

export interface AgentExportInput {
  agent: Agent;
  /** Every memory row the caller found for this agent's scope. Filtering happens
   *  HERE, not in the query, so the report can say what was dropped and why. */
  memories: readonly MemoryItem[];
  /** The agent's eval-event ledger, oldest-first. */
  ledger: readonly EvalEvent[];
  /** epoch ms — injected so this module needs no clock (and a test can pin it). */
  now: number;
}

/** What the user is told BEFORE anything is written. Every count is a number they
 *  can sanity-check, because "trust me, it exported" is not consent. */
export interface AgentExportReport {
  memoriesIncluded: number;
  /** Not reviewed by a human yet. */
  droppedProposed: number;
  /** Scoped to one conversation. NORMALLY 0, and that is not the same as "there
   *  were none": the shell's gather does not query the session scope at all, so
   *  this filter is defence in depth for a caller that hands session rows over
   *  anyway. Do not read a 0 here as evidence about the store. */
  droppedSession: number;
  /** Credential-shaped — the second sweep. */
  droppedSecret: number;
  /** Ledger rows carried, and how many had free text redacted. */
  ledgerRows: number;
  redactedLedgerFields: number;
  /** The stage as of export. Recorded as history; grants nothing anywhere. */
  stage: GrowthStage;
  /** True when the agent's OWN system prompt looks like it contains a credential.
   *  Not redacted — removing it would change how the agent behaves — so the
   *  decision is the user's, which means they have to be told. */
  promptLooksSecret: boolean;
}

export interface AgentExportResult {
  markdownName: string;
  markdown: string;
  sidecarName: string;
  sidecar: string;
  report: AgentExportReport;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/** Which single bucket a memory row falls into. Order is deliberate: a row that
 *  is BOTH proposed and session-scoped is counted once, under the reason that
 *  matters most to the user (nobody reviewed it). */
export type MemoryDropReason = 'proposed' | 'session' | 'secret';

export function memoryDropReason(item: MemoryItem): MemoryDropReason | undefined {
  if (item.status !== 'confirmed') return 'proposed';
  if (item.scope === 'session') return 'session';
  // Both halves: a key like `api-token` is as revealing as the value.
  if (looksLikeSecret(item.value) || looksLikeSecret(item.key)) return 'secret';
  return undefined;
}

/** Ledger rows keep their SCORING fields and lose any free text that looks like a
 *  credential. Dropping the whole row instead would quietly change the agent's
 *  measured history — the row is evidence about the agent, not about the secret. */
function scrubLedgerRow(row: EvalEvent): { row: EvalEvent; redacted: number } {
  let redacted = 0;
  const out: EvalEvent = { ...row };
  if (out.question && looksLikeSecret(out.question)) {
    out.question = REDACTED;
    redacted += 1;
  }
  if (out.correction && looksLikeSecret(out.correction)) {
    out.correction = REDACTED;
    redacted += 1;
  }
  if (out.options?.some((o) => looksLikeSecret(o))) {
    out.options = out.options.map((o) => (looksLikeSecret(o) ? REDACTED : o));
    redacted += 1;
  }
  return { row: out, redacted };
}

// ---------------------------------------------------------------------------
// YAML frontmatter
// ---------------------------------------------------------------------------

/**
 * Emit a YAML scalar the importer's `yaml.load` reads back as the same string.
 * Quoted whenever the value could otherwise be read as something else — a `key:`
 * inside a description would silently truncate the field, and a description is
 * exactly the kind of prose that contains colons.
 */
export function yamlScalar(value: string): string {
  // Frontmatter fields are single-line; a newline would end the scalar.
  const flat = value.replace(/\s*\r?\n\s*/g, ' ').trim();
  if (flat === '') return "''";
  const needsQuote =
    /[:#\-?{}[\],&*!|>'"%@`]/.test(flat[0]!) ||
    /:\s|\s#/.test(flat) ||
    /^(?:true|false|null|yes|no|on|off|~)$/i.test(flat) ||
    /^[\d.+-]/.test(flat);
  if (!needsQuote) return flat;
  return `"${flat.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** The `tools:` value, comma-separated as Claude Code writes it. A name holding a
 *  comma would make the list unparseable, so it is dropped rather than corrupting
 *  the whole field — tool names never contain one. */
function toolsScalar(toolRefs: readonly string[]): string | undefined {
  const usable = toolRefs.map((t) => t.trim()).filter((t) => t.length > 0 && !t.includes(','));
  return usable.length > 0 ? usable.join(', ') : undefined;
}

// ---------------------------------------------------------------------------
// The export
// ---------------------------------------------------------------------------

/** Section heading the learned facts go under, in the `.md` body. English on
 *  purpose: the artifact is read by other tooling and by a model in an unknown
 *  locale, while the facts themselves stay in whatever language they were
 *  written. */
const LEARNED_HEADING = '## What naby has learned about this user';

/** Filesystem-safe basename for the pair. */
export function exportBasename(agentName: string): string {
  const slug = agentName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
  return slug || 'agent';
}

/**
 * Build both files plus the report. PURE: no clock, no filesystem, no store — the
 * caller gathers the rows and writes the bytes, so this is fully spike-testable
 * and identical whichever shell calls it.
 */
export function buildAgentExport(input: AgentExportInput): AgentExportResult {
  const { agent, memories, ledger, now } = input;

  const kept: MemoryItem[] = [];
  const dropped: Record<MemoryDropReason, number> = { proposed: 0, session: 0, secret: 0 };
  for (const item of memories) {
    const reason = memoryDropReason(item);
    if (reason) dropped[reason] += 1;
    else kept.push(item);
  }

  let redactedLedgerFields = 0;
  const scrubbedLedger = ledger.map((row) => {
    const { row: clean, redacted } = scrubLedgerRow(row);
    redactedLedgerFields += redacted;
    return clean;
  });

  const growth = computeGrowth(scrubbedLedger as CheckinRecord[]);
  // UTC, and LABELLED as such below. A bare date would read as local time, and a
  // user exporting just after midnight would see yesterday — a small lie, but the
  // kind this project keeps deciding not to tell.
  const day = new Date(now).toISOString().slice(0, 10);

  // -- <name>.md ----------------------------------------------------------
  const front: string[] = ['---', `name: ${yamlScalar(agent.name)}`];
  if (agent.description) front.push(`description: ${yamlScalar(agent.description)}`);
  if (agent.model) front.push(`model: ${yamlScalar(agent.model)}`);
  const tools = agent.toolRefs ? toolsScalar(agent.toolRefs) : undefined;
  if (tools) front.push(`tools: ${tools}`);
  front.push('---');

  const body: string[] = [agent.systemPrompt.trim()];
  if (kept.length > 0) {
    // The SAME line format naby injects at turn time (`renderMemoryLine`), so a
    // model elsewhere reads these facts exactly as it would inside naby.
    body.push('', LEARNED_HEADING, '', ...kept.map(renderMemoryLine));
  }
  // A comment rather than frontmatter: `parseSubagentArtifact` would carry an
  // unknown frontmatter key nowhere, and a stage in frontmatter invites being read
  // as a claim. Here it is unmistakably a note about where the file came from.
  body.push(
    '',
    `<!-- exported from naby on ${day} (UTC) · ${kept.length} confirmed memories · ` +
      `reached the "${growth.stage}" stage there (a record, not a permission) -->`,
  );
  const markdown = `${front.join('\n')}\n\n${body.join('\n')}\n`;

  // -- <name>.naby.json ---------------------------------------------------
  //
  // NO `id` AND NO `kind`. Restoring an id would let an exported persona collide
  // with — or overwrite — the built-in persona on the importing machine, and a
  // restored `kind: 'persona'` would claim a slot that machine already fills. Both
  // survive as provenance under `origin`, where nothing can act on them.
  const sidecarDoc = {
    formatVersion: AGENT_EXPORT_FORMAT_VERSION,
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
    },
    origin: {
      agentId: agent.id,
      kind: agent.kind,
      createdAt: agent.createdAt,
    },
    memories: kept,
    ledger: scrubbedLedger,
    // NAMED so it cannot be mistaken for live state. An importer recomputes the
    // stage from `ledger`; this is what it looked like when it left.
    growthAtExport: {
      stage: growth.stage,
      percent: growth.percent,
      hits: growth.hits,
      trials: growth.trials,
    },
  };

  const base = exportBasename(agent.name);
  return {
    markdownName: `${base}.md`,
    markdown,
    sidecarName: `${base}.naby.json`,
    sidecar: `${JSON.stringify(sidecarDoc, null, 2)}\n`,
    report: {
      memoriesIncluded: kept.length,
      droppedProposed: dropped.proposed,
      droppedSession: dropped.session,
      droppedSecret: dropped.secret,
      ledgerRows: scrubbedLedger.length,
      redactedLedgerFields,
      stage: growth.stage,
      promptLooksSecret: looksLikeSecret(agent.systemPrompt),
    },
  };
}
