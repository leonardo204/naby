// src/runtime/agent-import.ts
//
// BRINGING AN AGENT IN (Phase 3, P3-M7) — the other half of the export.
//
// THE CONFLICT THIS RESOLVES. The export design says two things that pull against
// each other. §1: a re-import must "단계를 다시 계산한다" rather than starting from
// scratch — otherwise moving machines throws away your own history. §4: an
// imported agent is UNTRUSTED content, default-inactive, because a colleague's
// persona can carry a prompt injection.
//
// Both are right, and the thing that separates them is a fact no file can prove:
// whose history is this? A ledger measures how well an agent predicts ONE person.
// A colleague's ledger is their patterns and says nothing about whether the agent
// knows you — but your own ledger from your old laptop is exactly your history.
//
// So it is ASKED, not guessed. `trustLedger` is the user's answer to "is this file
// your own export?", and it is the only thing that decides whether the rows count:
//
//   trustLedger: false (default)  rows land flagged `imported`, which every growth
//                                 axis ignores. The agent starts as an egg and
//                                 earns its stage HERE. This is §4's
//                                 default-inactive, achieved without a new column:
//                                 an egg cannot be addressed.
//   trustLedger: true             rows land unflagged and count. This is §1's
//                                 recomputation — from the LEDGER, never from the
//                                 file's `growthAtExport`, which is read for
//                                 display only and believed by nothing.
//
// WHERE THE IMPORTED FACTS GO, AND WHY NOT INTO MEMORY. The first build of this
// proposed each learned fact as a memory row, and every one was DENIED in live
// testing — correctly. `decideMemoryWrite` invariant 3 is absolute: external-origin
// content may never write `user`/`org` scope, because that is exactly how a
// poisoned file would mint durable cross-session identity. Proposing writes that
// can only fail is the silent half-run this project refuses elsewhere.
//
// So an imported fact goes into THAT AGENT'S OWN INSTRUCTIONS, rendered in the
// same line format naby injects at turn time — which is precisely what the
// portable `.md` already does, so the sidecar path gains no capability the plain
// file lacks. The rule states cleanly: an imported agent brings its own knowledge,
// and does not get to rewrite what naby believes about you. The facts shape that
// one agent's turns and nothing else.
//
// WHAT IS NEVER TRUSTED, WHATEVER THE USER SAYS:
//   * `kind` is always 'custom'. A machine has exactly one built-in persona and an
//     import may not claim that slot.
//   * `id` is discarded. Restoring it could collide with — or overwrite — the
//     importing machine's own rows.
//   * Any stage in the artifact. Nothing here reads one.

import type {
  AgentAutonomy,
  AgentEscalation,
  AgentInput,
  EvalEventInput,
  EvalEventKind,
  MemoryScope,
  MemoryType,
} from './store/store.js';
import { AGENT_EXPORT_FORMAT_VERSION, LEARNED_HEADING } from './agent-export.js';
import { looksLikeSecret } from './tools.js';

const MEMORY_SCOPES: readonly MemoryScope[] = ['session', 'project', 'user', 'org'];
const MEMORY_TYPES: readonly MemoryType[] = ['working', 'episodic', 'semantic', 'procedural'];
const LEDGER_KINDS: readonly EvalEventKind[] = ['checkin', 'autonomous', 'tripwire'];
const ESCALATIONS: readonly AgentEscalation[] = ['inline', 'telegram', 'both'];

/** Scopes an imported fact may come from. `session` is meaningless off its own
 *  machine and `org` is someone else's shared asset. */
const IMPORTABLE_SCOPES: readonly MemoryScope[] = ['project', 'user'];

/** What the user is shown after a successful parse and before anything is written. */
export interface AgentImportReport {
  /** Name as it will actually be created — suffixed if it collided. */
  name: string;
  /** Set when the requested name was taken, so the rename is never a surprise. */
  renamedFrom?: string;
  /** Learned facts written into the agent's own instructions (see the header:
   *  they do NOT become machine-wide memory, which the write gate forbids). */
  factsInlined: number;
  /** Facts the file offered that this machine will not take, by reason. */
  skippedFacts: number;
  ledgerRows: number;
  /** Whether those ledger rows will count toward the stage. */
  ledgerCounts: boolean;
  /** The file's own claim, for display. Believed by nothing. */
  claimedStage?: string;
  /** True when the imported system prompt looks like it contains a credential —
   *  a colleague's file, or your own with something you forgot in it. */
  promptLooksSecret: boolean;
  /** Free-text notes about anything the file got wrong but that did not stop the
   *  import (an unknown scope, a malformed row). Never silently dropped. */
  warnings: string[];
}

export interface AgentImportPlan {
  /** Ready for `putAgent`. No `id`; `kind` is 'custom'; the imported facts are
   *  already inlined into `systemPrompt`. */
  agent: AgentInput;
  /** Ready for `appendEvalEvent` once the new agent id exists — which is why
   *  `agentId` is absent here rather than carrying the file's stale one.
   *  `sessionId` is absent for the same reason: a foreign session id would point
   *  at a conversation that does not exist on this machine, and inventing one is
   *  the shell's call, not this parser's. */
  ledger: Array<Omit<EvalEventInput, 'agentId' | 'sessionId'>>;
  /** Where it came from, for provenance and for the UI to show. */
  origin: { agentId?: string; kind?: string; exportedAt?: number };
  report: AgentImportReport;
}

export type AgentImportResult =
  | { ok: true; plan: AgentImportPlan }
  | { ok: false; problems: string[] };

// ---------------------------------------------------------------------------
// Small readers — every one of them treats the file as hostile
// ---------------------------------------------------------------------------

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function strList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map((x) => str(x)).filter((x): x is string => !!x);
  return out.length > 0 ? out : undefined;
}

function readAutonomy(v: unknown): AgentAutonomy {
  const a = rec(v);
  const escalation = str(a.escalation);
  const maxSteps = num(a.maxSteps);
  return {
    escalation: escalation && ESCALATIONS.includes(escalation as AgentEscalation)
      ? (escalation as AgentEscalation)
      : 'inline',
    ...(maxSteps !== undefined && maxSteps > 0 ? { maxSteps: Math.floor(maxSteps) } : {}),
  };
}

// ---------------------------------------------------------------------------
// The parse
// ---------------------------------------------------------------------------

export interface AgentImportOptions {
  /** The user's answer to "is this your own export?" — the ONLY thing that makes
   *  the imported ledger count. Defaults to false: a file does not get to declare
   *  trust. */
  trustLedger?: boolean;
  /** Names already taken on this machine, so a collision is renamed rather than
   *  rejected by the store after the user already confirmed. */
  existingNames?: readonly string[];
  /** epoch ms. Kept for symmetry with the export and for future provenance. */
  now: number;
}

/** Free a colliding name by suffixing, so an import never overwrites and never
 *  fails late. `persona` → `persona-imported` → `persona-imported-2` → … */
export function freeAgentName(wanted: string, taken: readonly string[]): string {
  const set = new Set(taken);
  if (!set.has(wanted)) return wanted;
  const first = `${wanted}-imported`;
  if (!set.has(first)) return first;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${first}-${i}`;
    if (!set.has(candidate)) return candidate;
  }
  return `${first}-${taken.length + 1}`;
}

/**
 * Parse a `<name>.naby.json` sidecar into a plan the shell can apply. PURE: no
 * store, no clock, no filesystem. Returns problems instead of throwing, because
 * "this file is not one of ours" is an ordinary outcome the UI has to explain.
 */
export function parseAgentSidecar(text: string, opts: AgentImportOptions): AgentImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, problems: [`that file is not valid JSON (${e instanceof Error ? e.message : 'parse error'})`] };
  }
  const doc = rec(parsed);
  const problems: string[] = [];
  const warnings: string[] = [];

  const version = num(doc.formatVersion);
  if (version === undefined) {
    problems.push('this does not look like a naby export (no `formatVersion`)');
  } else if (version > AGENT_EXPORT_FORMAT_VERSION) {
    // Refused rather than best-effort: a newer file may carry fields whose absence
    // changes meaning, and silently importing half of it is worse than declining.
    problems.push(
      `this file was written by a newer naby (format ${version}, this one reads up to ${AGENT_EXPORT_FORMAT_VERSION})`,
    );
  }

  const agentDoc = rec(doc.agent);
  const wantedName = str(agentDoc.name);
  const systemPrompt = str(agentDoc.systemPrompt);
  if (!wantedName) problems.push('the agent has no `name`');
  if (!systemPrompt) problems.push('the agent has no instructions (`systemPrompt`)');
  if (problems.length > 0) return { ok: false, problems };

  const scope = str(agentDoc.memoryScope);
  const memoryScope: MemoryScope =
    scope && MEMORY_SCOPES.includes(scope as MemoryScope) ? (scope as MemoryScope) : 'user';
  if (scope && scope !== memoryScope) {
    warnings.push(`unknown memory scope "${scope}" — using "user"`);
  }

  const name = freeAgentName(wantedName!, opts.existingNames ?? []);
  const agent: AgentInput = {
    name,
    // ALWAYS custom. An import may not claim the built-in persona slot.
    kind: 'custom',
    ...(str(agentDoc.description) ? { description: str(agentDoc.description)! } : {}),
    systemPrompt: systemPrompt!,
    ...(str(agentDoc.model) ? { model: str(agentDoc.model)! } : {}),
    ...(strList(agentDoc.toolRefs) ? { toolRefs: strList(agentDoc.toolRefs)! } : {}),
    memoryScope,
    autonomy: readAutonomy(agentDoc.autonomy),
  };

  // -- the learned facts: into the agent's instructions, never into memory ----
  const facts: string[] = [];
  let skippedFacts = 0;
  const rawMemories = Array.isArray(doc.memories) ? doc.memories : [];
  for (const raw of rawMemories) {
    const m = rec(raw);
    const key = str(m.key);
    const value = str(m.value);
    const mScope = str(m.scope);
    const mType = str(m.type);
    if (!key || !value || !mScope || !mType) {
      skippedFacts += 1;
      warnings.push('skipped a learned fact that was missing key, value, scope or type');
      continue;
    }
    if (!IMPORTABLE_SCOPES.includes(mScope as MemoryScope)) {
      skippedFacts += 1;
      warnings.push(`skipped "${key}": a "${mScope}"-scoped fact cannot be imported`);
      continue;
    }
    if (!MEMORY_TYPES.includes(mType as MemoryType)) {
      skippedFacts += 1;
      warnings.push(`skipped "${key}": unknown fact type "${mType}"`);
      continue;
    }
    // A third sweep. Capture refused secrets and export swept them again; a file
    // can still have been hand-edited between the two.
    if (looksLikeSecret(value) || looksLikeSecret(key)) {
      skippedFacts += 1;
      warnings.push(`skipped "${key}": it looks like a credential`);
      continue;
    }
    // The SAME line format naby injects at turn time, so the imported agent reads
    // its own knowledge exactly as it did on the machine it came from.
    facts.push(`- (${mScope}/${mType}) ${key}: ${value}`);
  }

  // -- ledger: kept for the record, counted only if the user vouched for it ----
  const trustLedger = opts.trustLedger === true;
  const ledger: Array<Omit<EvalEventInput, 'agentId' | 'sessionId'>> = [];
  const rawLedger = Array.isArray(doc.ledger) ? doc.ledger : [];
  for (const raw of rawLedger) {
    const r = rec(raw);
    const kind = str(r.kind);
    const at = num(r.at);
    if (!kind || !LEDGER_KINDS.includes(kind as EvalEventKind) || at === undefined) {
      warnings.push('skipped a growth-record row with an unknown kind or timestamp');
      continue;
    }
    ledger.push({
      kind: kind as EvalEventKind,
      at,
      ...(str(r.taskType) ? { taskType: str(r.taskType)! } : {}),
      ...(typeof r.hit === 'boolean' ? { hit: r.hit } : {}),
      ...(strList(r.options) ? { options: strList(r.options)! } : {}),
      ...(num(r.recommended) !== undefined ? { recommended: num(r.recommended)! } : {}),
      ...(num(r.chosen) !== undefined ? { chosen: num(r.chosen)! } : {}),
      ...(num(r.confidence) !== undefined ? { confidence: num(r.confidence)! } : {}),
      ...(str(r.toolName) ? { toolName: str(r.toolName)! } : {}),
      ...(r.excludedFromScoring === true ? { excludedFromScoring: true } : {}),
      // THE LOAD-BEARING FLAG. Absent only when the user declared this their own
      // export; otherwise every growth axis ignores the row.
      ...(trustLedger ? {} : { imported: true }),
    });
  }

  // Appended after the loop because the agent block is read first: the prompt the
  // file carried, then what it learned, under the same heading the `.md` uses.
  if (facts.length > 0) {
    agent.systemPrompt = `${agent.systemPrompt}\n\n${LEARNED_HEADING}\n\n${facts.join('\n')}`;
  }

  const origin = rec(doc.origin);
  const claimed = rec(doc.growthAtExport);
  return {
    ok: true,
    plan: {
      agent,
      ledger,
      origin: {
        ...(str(origin.agentId) ? { agentId: str(origin.agentId)! } : {}),
        ...(str(origin.kind) ? { kind: str(origin.kind)! } : {}),
        ...(num(doc.exportedAt) !== undefined ? { exportedAt: num(doc.exportedAt)! } : {}),
      },
      report: {
        name,
        ...(name !== wantedName ? { renamedFrom: wantedName! } : {}),
        factsInlined: facts.length,
        skippedFacts,
        ledgerRows: ledger.length,
        ledgerCounts: trustLedger,
        ...(str(claimed.stage) ? { claimedStage: str(claimed.stage)! } : {}),
        promptLooksSecret: looksLikeSecret(systemPrompt!),
        warnings,
      },
    },
  };
}
