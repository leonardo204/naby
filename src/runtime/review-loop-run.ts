// src/runtime/review-loop-run.ts
//
// THE REVIEW LOOP RUNNER — code owns the loop, models do the reviewing and fixing.
//
// `review-loop.ts` decides WHAT happens next (the ledger and its stop rules).
// This file is everything around it that is still pure:
//
//   * the tool naby calls (`naby_review_loop`) and its input check;
//   * the prompts a reviewer, a verifier and a fixer get, and the strict parsers
//     for what they send back (typed findings, per-finding fix outcomes);
//   * the TOOL POLICY per role — a reviewer may only read; a fixer may read and
//     edit ONE file. Enforced as a gate in front of the parent turn's gate, so it
//     only ever narrows what the turn may do;
//   * `runReviewLoop`, the loop itself, with the model calls injected. The shell
//     supplies the nested runs (engine, model, gate); a spike supplies fakes.
//
// WHY A BACKGROUND RUN AND NOT A TOOL THAT BLOCKS. A loop over seven documents
// is tens of minutes. The tool starts it and returns at once; the ending comes
// back as a report turn, the same way a background job's does.
//
// WHAT IS DELIBERATELY NOT HERE: deciding how to split the files into reviewer
// groups. That is a judgement about the documents, so the calling model makes it
// and passes `groups`.

import {
  ReviewLedger,
  REVIEW_MAX_FIX_ROUNDS,
  type FixOutcome,
  type ReviewEvidence,
  type ReviewFinding,
  type ReviewFindingInput,
  type ReviewHandoffReport,
  type ReviewSeverity,
  type FindingRelation,
} from './review-loop.js';
import type { ToolCall, ToolSchema } from './engine.js';

export const REVIEW_LOOP_TOOL_NAME = 'naby_review_loop';

/** Reviewers or fixers running at once. Three matched the field case's own
 *  choice and keeps one loop from monopolising the plan's rate limit. */
export const REVIEW_LOOP_CONCURRENCY = 3;
export const REVIEW_LOOP_MAX_GROUPS = 12;
export const REVIEW_LOOP_MAX_FILES_PER_GROUP = 12;
export const REVIEW_LOOP_GOAL_MAX = 4000;
/** The earlier-findings list a reviewer sees is capped; past this the oldest
 *  FIXED findings are dropped first (open and escalated ones always stay). */
export const REVIEW_INDEX_MAX_ITEMS = 300;

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export type ReviewGroup = { name: string; files: string[]; references?: string[] };

export type ReviewLoopInput = {
  /** What the documents must satisfy — the decisions, the standard, the scope. */
  goal: string;
  groups: ReviewGroup[];
  /** 0 = review only (no edits), up to REVIEW_MAX_FIX_ROUNDS. */
  maxFixRounds?: number;
  /** Known findings or decisions to apply. When present the loop skips its first
   *  review and starts with a fix round; the verify after it still checks. */
  findings?: ReviewFindingInput[];
};

export const REVIEW_LOOP_MAX_SEED_FINDINGS = 200;

export const reviewLoopSchema: ToolSchema = {
  name: REVIEW_LOOP_TOOL_NAME,
  description:
    'Review a set of files and fix what the reviewers find, as a BACKGROUND loop run by code. ' +
    'Use it instead of running review → fix → review rounds yourself or with subagents, whenever ' +
    'several documents or files need checking against a goal. Reviewers only read; each fixer edits ' +
    'only the one file it is given. A problem that comes back after it was fixed is NOT fixed again: ' +
    `it is handed to the user as a decision. At most ${REVIEW_MAX_FIX_ROUNDS} fix rounds, then whatever ` +
    'is still open is listed for the user. Returns at once; you get a report turn when it ends — tell ' +
    'the user it is running and do not start the same work yourself meanwhile. You choose the groups: ' +
    'one reviewer per group, files that must be read together in the same group.',
  parameters: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description:
          'What the files must satisfy, in full: the decisions to apply, the standard, what counts as a ' +
          'problem. Reviewers and fixers cannot see this conversation.',
      },
      groups: {
        type: 'array',
        description: 'One reviewer per group.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Short label, e.g. "DB and API".' },
            files: { type: 'array', items: { type: 'string' }, description: 'Files this reviewer checks (paths relative to the project).' },
            references: { type: 'array', items: { type: 'string' }, description: 'Files to compare against, read-only.' },
          },
          required: ['name', 'files'],
        },
      },
      maxFixRounds: {
        type: 'number',
        description: `0 for review only. Default and maximum ${REVIEW_MAX_FIX_ROUNDS}.`,
      },
      findings: {
        type: 'array',
        description:
          'Known findings or decisions to apply, when they already exist (a review you ran, decisions the user made). ' +
          'With these the loop starts by FIXING them instead of reviewing first. One item per change, each naming the file to edit first.',
        items: {
          type: 'object',
          properties: {
            severity: { type: 'string', enum: ['high', 'medium', 'low'] },
            files: { type: 'array', items: { type: 'string' }, description: 'First = the file to edit.' },
            location: { type: 'string' },
            problem: { type: 'string', description: 'What is wrong, or the decision to apply.' },
            fix: { type: 'string', description: 'The change to make, if known.' },
          },
          required: ['files', 'problem'],
        },
      },
    },
    required: ['goal', 'groups'],
  },
};

/** Every problem with a call, in words the model can act on. Empty = fine. */
export function validateReviewLoopInput(raw: unknown): { input?: ReviewLoopInput; problems: string[] } {
  const problems: string[] = [];
  const rec = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const goal = typeof rec.goal === 'string' ? rec.goal.trim() : '';
  if (!goal) problems.push('`goal` is empty — say what the files must satisfy; the reviewers cannot see this conversation');
  else if (goal.length > REVIEW_LOOP_GOAL_MAX) problems.push(`\`goal\` is ${goal.length} chars; keep it under ${REVIEW_LOOP_GOAL_MAX} (point to a file for the rest)`);
  const groupsRaw = Array.isArray(rec.groups) ? rec.groups : [];
  if (groupsRaw.length === 0) problems.push('`groups` is empty — give at least one group of files');
  if (groupsRaw.length > REVIEW_LOOP_MAX_GROUPS) problems.push(`at most ${REVIEW_LOOP_MAX_GROUPS} groups`);
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : []);
  const groups: ReviewGroup[] = groupsRaw.map((g, i) => {
    const r = (g && typeof g === 'object' ? g : {}) as Record<string, unknown>;
    const files = strs(r.files);
    if (files.length === 0) problems.push(`group ${i + 1} has no files`);
    if (files.length > REVIEW_LOOP_MAX_FILES_PER_GROUP) problems.push(`group ${i + 1} has ${files.length} files; at most ${REVIEW_LOOP_MAX_FILES_PER_GROUP}`);
    const references = strs(r.references);
    return {
      name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : `group ${i + 1}`,
      files,
      ...(references.length ? { references } : {}),
    };
  });
  let maxFixRounds = REVIEW_MAX_FIX_ROUNDS;
  if (rec.maxFixRounds !== undefined) {
    const n = Number(rec.maxFixRounds);
    if (!Number.isInteger(n) || n < 0 || n > REVIEW_MAX_FIX_ROUNDS) problems.push(`\`maxFixRounds\` must be 0..${REVIEW_MAX_FIX_ROUNDS}`);
    else maxFixRounds = n;
  }
  let findings: ReviewFindingInput[] | undefined;
  if (rec.findings !== undefined) {
    if (!Array.isArray(rec.findings)) problems.push('`findings` must be a list');
    else if (rec.findings.length > REVIEW_LOOP_MAX_SEED_FINDINGS) problems.push(`at most ${REVIEW_LOOP_MAX_SEED_FINDINGS} findings; put the rest in a file named in \`goal\``);
    else {
      // The same parser as a reviewer's answer, so a seed is held to the same
      // shape; a seed is something someone decided, so its evidence is "spec".
      const parsed = parseReviewerReply('```json\n' + JSON.stringify({ findings: rec.findings }) + '\n```');
      findings = parsed.findings.map((f) => ({ ...f, evidence: f.evidence.length ? f.evidence : ['spec'] }));
      if (parsed.dropped) problems.push(`${parsed.dropped} finding(s) have no \`problem\``);
      if (findings.some((f) => f.files.length === 0)) problems.push('every finding needs `files` (the first is the file to edit)');
      if (maxFixRounds === 0 && findings.length) problems.push('`findings` are for fixing; with `maxFixRounds: 0` leave them out');
    }
  }
  return problems.length ? { problems } : { input: { goal, groups, maxFixRounds, ...(findings?.length ? { findings } : {}) }, problems };
}

/**
 * The line naby's system prompt carries whenever the tool is offered.
 *
 * WHY A SYSTEM LINE AND NOT ONLY THE TOOL DESCRIPTION. In the isolated replay of
 * the field case (2026-11-16) naby saw the tool and still split the work across
 * Agent subagents, the habit the rest of its prompt teaches. A tool description
 * is read when a tool is being chosen; the choice to delegate is made earlier.
 */
export const REVIEW_LOOP_RULE =
  `Review-and-fix work over several files — checking documents or code against decisions or a standard, fixing what is found, checking again — goes to ${'`'}naby_review_loop${'`'}: not to subagents, and not done by you file by file. ` +
  'It runs the reviewers and fixers in the background, stops after two fix rounds, and hands any problem that comes back after a fix to the user as a decision. ' +
  'When the findings or decisions to apply are already known (you or the reviewers found them, the user decided them), pass them as `findings` so the loop starts by fixing instead of reviewing again. ' +
  'Do it yourself only for one or two files in a single pass.';

// ---------------------------------------------------------------------------
// Tool policy per role
// ---------------------------------------------------------------------------

/** Tools that only read, in both spellings (SDK built-ins and naby's own). */
export const REVIEW_READ_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep', 'LS', 'read_file', 'list_dir', 'glob', 'grep'];
/** Tools that write a file, with the field that names the file. */
const WRITE_TOOLS: Record<string, string> = { Edit: 'file_path', MultiEdit: 'file_path', Write: 'file_path', edit_file: 'path', write_file: 'path' };

export type ReviewRole = { kind: 'reviewer' } | { kind: 'fixer'; file: string };

/**
 * Why a call is refused for this role, or undefined to pass it on to the parent
 * turn's gate (which can still refuse). An ALLOWLIST: anything not named — the
 * shell, subagents, MCP tools, jobs — is refused, so a reviewer cannot change
 * anything and a fixer cannot reach beyond its file. `resolve` turns a path the
 * model wrote into an absolute one (the shell knows the project directory).
 */
export function reviewRoleRefusal(role: ReviewRole, call: ToolCall, resolve: (p: string) => string): string | undefined {
  if (REVIEW_READ_TOOLS.includes(call.toolName)) return undefined;
  if (role.kind === 'fixer' && call.toolName in WRITE_TOOLS) {
    const field = WRITE_TOOLS[call.toolName]!;
    const p = (call.input && typeof call.input === 'object' ? (call.input as Record<string, unknown>)[field] : undefined) as unknown;
    if (typeof p === 'string' && resolve(p) === resolve(role.file)) return undefined;
    return `In this review loop you may edit only ${role.file}. Report anything elsewhere in your answer instead.`;
  }
  return role.kind === 'reviewer'
    ? `Reviewers in this loop only read (allowed: ${REVIEW_READ_TOOLS.join(', ')}). Do not change anything; report it.`
    : `Fixers in this loop may read and edit only their own file (${role.file}); "${call.toolName}" is not available.`;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

export type IndexItem = { id: string; files: string[]; problem: string; status: string; fixNote?: string };

/** The earlier findings a reviewer links to, capped: open and escalated items
 *  always stay; the oldest fixed ones go first. */
export function capIndex(items: readonly IndexItem[], max = REVIEW_INDEX_MAX_ITEMS): IndexItem[] {
  if (items.length <= max) return [...items];
  const keep = items.filter((i) => i.status !== 'fixed');
  const fixed = items.filter((i) => i.status === 'fixed');
  return [...fixed.slice(Math.max(0, fixed.length - Math.max(0, max - keep.length))), ...keep];
}

const FINDINGS_FORMAT = `Answer with ONE \`\`\`json block and nothing after it:
{"findings": [{
  "severity": "high" | "medium" | "low",
  "files": ["path of the file to change first", "other files involved"],
  "location": "section or line",
  "problem": "one or two sentences: what is wrong and why it matters",
  "fix": "the smallest change that solves it",
  "evidence": ["quoted" | "cross-doc" | "spec" | "missing" | "inferred"],
  "relatesTo": {"findingId": "F12", "kind": "again" | "caused-by-fix"}   // optional
}]}
- high = building it as written fails or contradicts a decision; medium = a real gap or mismatch; low = wording, polish.
- evidence: "quoted" when you quote the text, "cross-doc" when you compared files, "inferred" when it is your guess.
- relatesTo: ONLY when this is the SAME specific problem as an earlier finding ("again"), or a problem CREATED by how an earlier finding was fixed ("caused-by-fix"; see its fixNote). Two findings being the same KIND of problem is not a link. When unsure, leave it out.
- An empty list is a fine answer.`;

function listIndex(items: readonly IndexItem[]): string {
  if (items.length === 0) return '(none yet)';
  return items
    .map((i) => `${i.id} [${i.status}] ${i.files.slice(0, 2).join(', ')} — ${i.problem.slice(0, 200)}${i.fixNote ? `\n    fixNote: ${i.fixNote.slice(0, 200)}` : ''}`)
    .join('\n');
}

export function reviewerPrompt(args: { goal: string; group: ReviewGroup; index: readonly IndexItem[]; verify?: { changedFiles: string[] } }): string {
  const { goal, group, index, verify } = args;
  const scope = verify
    ? `CHECK THE FIXES. These files were just changed: ${verify.changedFiles.join(', ')}.\n` +
      `Read what changed in them and anything in your group they touch. Report (a) earlier findings that are NOT actually fixed (relatesTo kind "again"), (b) problems the fixes created (kind "caused-by-fix"), and (c) any other problem in your files you can show.`
    : `Read every file in your group from start to end and compare them with each other and with the references.`;
  return [
    `You are a reviewer in a review loop. You only READ — do not change any file; edits are refused.`,
    '',
    `## Goal\n${goal}`,
    '',
    `## Your group: ${group.name}\nFiles: ${group.files.join(', ')}` + (group.references?.length ? `\nReferences (read-only): ${group.references.join(', ')}` : ''),
    '',
    `## Task\n${scope}`,
    '',
    `## Earlier findings (id [status] files — problem)\n${listIndex(index)}`,
    '',
    `## Answer\n${FINDINGS_FORMAT}`,
  ].join('\n');
}

export function fixerPrompt(args: { goal: string; file: string; findings: readonly ReviewFinding[] }): string {
  const { goal, file, findings } = args;
  const list = findings
    .map((f) => `${f.id} [${f.severity}]${f.location ? ` (${f.location})` : ''}: ${f.problem}${f.fix ? `\n    suggested fix: ${f.fix}` : ''}${f.files.length > 1 ? `\n    also involves: ${f.files.slice(1).join(', ')}` : ''}`)
    .join('\n');
  return [
    `You are a fixer in a review loop. You may read any file but EDIT ONLY ${file}; edits elsewhere are refused.`,
    '',
    `## Goal\n${goal}`,
    '',
    `## Findings to fix in ${file}\n${list}`,
    '',
    `## How\n- Read the relevant parts of ${file} (and the other files involved, read-only) before editing.\n- Make the smallest change that solves each finding and keeps ${file} consistent with itself.\n- If a finding needs a change in another file or a decision nobody has made, do not guess: mark it.`,
    '',
    `## Answer\nAnswer with ONE \`\`\`json block and nothing after it:\n{"results": [{"id": "F12", "outcome": "fixed" | "already-resolved" | "not-fixed" | "other-owner", "note": "what you changed, or why not"}]}\nOne item per finding above.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Parsers — strict about shape, tolerant about wrapping
// ---------------------------------------------------------------------------

function lastJsonObject(text: string): unknown {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]!);
  const candidates = fenced.length ? fenced.reverse() : [text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    try {
      return JSON.parse(c.replace(/^\s*\/\/.*$/gm, ''));
    } catch {
      /* try the next one */
    }
  }
  return undefined;
}

const SEVERITIES: readonly ReviewSeverity[] = ['high', 'medium', 'low'];
const EVIDENCE: readonly ReviewEvidence[] = ['quoted', 'cross-doc', 'spec', 'missing', 'inferred'];
const RELATIONS: readonly FindingRelation[] = ['again', 'caused-by-fix'];

/** A reviewer's answer → findings. `ok: false` when there is no readable JSON at
 *  all — the runner treats that reviewer as failed, never as "found nothing". */
export function parseReviewerReply(text: string): { ok: boolean; findings: ReviewFindingInput[]; dropped: number } {
  const data = lastJsonObject(text) as { findings?: unknown } | undefined;
  if (!data || !Array.isArray(data.findings)) return { ok: false, findings: [], dropped: 0 };
  const findings: ReviewFindingInput[] = [];
  let dropped = 0;
  for (const raw of data.findings) {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const problem = typeof r.problem === 'string' ? r.problem.trim() : '';
    if (!problem) {
      dropped += 1;
      continue;
    }
    const severity = SEVERITIES.includes(r.severity as ReviewSeverity) ? (r.severity as ReviewSeverity) : 'medium';
    const files = Array.isArray(r.files) ? r.files.filter((f): f is string => typeof f === 'string' && f.trim() !== '') : [];
    const evidence = Array.isArray(r.evidence) ? r.evidence.filter((e): e is ReviewEvidence => EVIDENCE.includes(e as ReviewEvidence)) : [];
    const rel = (r.relatesTo && typeof r.relatesTo === 'object' ? r.relatesTo : undefined) as Record<string, unknown> | undefined;
    const relatesTo =
      rel && typeof rel.findingId === 'string' && RELATIONS.includes(rel.kind as FindingRelation)
        ? { findingId: rel.findingId.trim(), kind: rel.kind as FindingRelation }
        : undefined;
    findings.push({
      severity,
      files,
      problem,
      evidence,
      ...(typeof r.location === 'string' && r.location.trim() ? { location: r.location.trim() } : {}),
      ...(typeof r.fix === 'string' && r.fix.trim() ? { fix: r.fix.trim() } : {}),
      ...(relatesTo ? { relatesTo } : {}),
    });
  }
  return { ok: true, findings, dropped };
}

const OUTCOMES: readonly FixOutcome[] = ['fixed', 'already-resolved', 'not-fixed', 'other-owner'];

/** A fixer's answer → outcomes for the findings it was given. Ids it was not
 *  given are ignored; findings it does not mention stay open (the ledger's rule). */
export function parseFixerReply(text: string, givenIds: readonly string[]): Array<{ findingId: string; outcome: FixOutcome; note?: string }> {
  const data = lastJsonObject(text) as { results?: unknown } | undefined;
  if (!data || !Array.isArray(data.results)) return [];
  const out: Array<{ findingId: string; outcome: FixOutcome; note?: string }> = [];
  for (const raw of data.results) {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    if (!givenIds.includes(id) || !OUTCOMES.includes(r.outcome as FixOutcome)) continue;
    out.push({ findingId: id, outcome: r.outcome as FixOutcome, ...(typeof r.note === 'string' && r.note.trim() ? { note: r.note.trim().slice(0, 500) } : {}) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export type NestedReply = { ok: boolean; text: string; error?: string };

export type ReviewLoopDeps = {
  /** Run one reviewer (read-only role). */
  review(group: ReviewGroup, prompt: string): Promise<NestedReply>;
  /** Run one fixer (may edit only `file`). */
  fix(file: string, prompt: string): Promise<NestedReply>;
  /** A line of progress for the log / the UI. Optional, must not throw. */
  progress?(line: string): void;
  /** Stop between steps when aborted. */
  signal?: AbortSignal;
  concurrency?: number;
};

export type ReviewLoopResult = {
  report: ReviewHandoffReport;
  /** Reviewers or fixers whose run failed or whose answer was unreadable. */
  failures: Array<{ step: string; who: string; error: string }>;
  aborted: boolean;
  ledger: ReviewLedger;
};

async function pool<T, R>(items: readonly T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function runReviewLoop(input: ReviewLoopInput, deps: ReviewLoopDeps): Promise<ReviewLoopResult> {
  const ledger = new ReviewLedger({ maxFixRounds: input.maxFixRounds ?? REVIEW_MAX_FIX_ROUNDS });
  const failures: ReviewLoopResult['failures'] = [];
  const n = deps.concurrency ?? REVIEW_LOOP_CONCURRENCY;
  const say = (l: string) => {
    try {
      deps.progress?.(l);
    } catch {
      /* observation must not break the loop */
    }
  };

  const reviewRound = async (label: string, verify?: { changedFiles: string[] }) => {
    const index = capIndex(ledger.reviewerIndex());
    // A verify only needs the groups that own or reference a changed file.
    const groups = verify
      ? input.groups.filter((g) => [...g.files, ...(g.references ?? [])].some((f) => verify.changedFiles.some((c) => sameFile(c, f))))
      : input.groups;
    say(`${label}: ${groups.length} reviewer(s)`);
    const replies = await pool(groups, n, (g) => deps.review(g, reviewerPrompt({ goal: input.goal, group: g, index, ...(verify ? { verify } : {}) })));
    const found: ReviewFindingInput[] = [];
    replies.forEach((r, i) => {
      const parsed = r.ok ? parseReviewerReply(r.text) : { ok: false, findings: [], dropped: 0 };
      if (!parsed.ok) failures.push({ step: label, who: groups[i]!.name, error: r.error ?? 'no readable findings block' });
      found.push(...parsed.findings);
    });
    const recorded = ledger.addReview(found);
    say(`${label}: ${recorded.length} finding(s)`);
  };

  if (input.findings?.length) {
    // Start from what is already known: record it as the first review and go
    // straight to fixing. The verify after the fix still reads the result.
    const seeded = ledger.addReview(input.findings);
    say(`seeded: ${seeded.length} known finding(s)`);
  } else {
    await reviewRound('review');
  }
  let afterFix = false;
  for (;;) {
    if (deps.signal?.aborted) return { report: ledger.report('fix-limit'), failures, aborted: true, ledger };
    const step = ledger.next(afterFix);
    if (step.kind === 'handoff') return { report: step.report, failures, aborted: false, ledger };
    if (step.kind === 'verify') {
      await reviewRound(`verify after fix ${ledger.rounds.fix}`, { changedFiles: step.files });
      afterFix = false;
      continue;
    }
    say(`fix ${step.round}: ${step.assignments.length} file(s)`);
    const changed: string[] = [];
    const allResults: Array<{ findingId: string; outcome: FixOutcome; note?: string }> = [];
    await pool(step.assignments, n, async (a) => {
      const ids = a.findings.map((f) => f.id);
      const r = await deps.fix(a.file, fixerPrompt({ goal: input.goal, file: a.file, findings: a.findings }));
      const results = r.ok ? parseFixerReply(r.text, ids) : [];
      if (!r.ok || results.length === 0) failures.push({ step: `fix ${step.round}`, who: a.file, error: r.error ?? 'no readable results block' });
      if (results.some((x) => x.outcome === 'fixed')) changed.push(a.file);
      allResults.push(...results);
    });
    // Recorded ONCE, after every fixer is done: recordFix returns anything still
    // `assigned` to open, so recording per fixer would reopen the findings other
    // fixers are still working on. The verify then reads exactly what changed.
    ledger.recordFix(allResults, changed);
    afterFix = true;
  }
}

function sameFile(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/^\.\//, '').replace(/\\/g, '/');
  const x = norm(a);
  const y = norm(b);
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

// ---------------------------------------------------------------------------
// The report naby reads
// ---------------------------------------------------------------------------

export function renderReviewReport(r: ReviewLoopResult, meta: { id: string; goal: string; minutes: number }): string {
  const { report } = r;
  const line = (f: ReviewFinding) => `- ${f.id} [${f.severity}] ${f.files[0] ?? '(no file)'}${f.location ? ` (${f.location})` : ''}: ${f.problem}${f.note ? ` — ${f.note}` : ''}`;
  const out: string[] = [
    `# Review loop ${meta.id}`,
    '',
    `Ended: ${r.aborted ? 'stopped' : report.reason} · fix rounds ${report.fixRounds} · fixed ${report.fixed} · ${meta.minutes} min`,
    '',
    `## Goal\n${meta.goal}`,
  ];
  if (report.decisions.length) {
    out.push('', `## Decisions for the user (${report.decisions.length})`, 'Each came back after it was fixed. Do not fix these again without the user.');
    for (const d of report.decisions) {
      out.push('', `### ${d.topic.title}`, ...d.findings.map(line));
      const history = r.ledger.allFindings().filter((f) => f.topicId === d.topic.id && f.status === 'fixed');
      for (const h of history) out.push(`  - earlier ${h.id} (fixed): ${h.problem}${h.fixNote ? ` → fix: ${h.fixNote}` : ''}`);
    }
  }
  // What the fixers changed, with their own notes. Shown because a "clean" end
  // can still hide a choice a fixer made or left ("not decided: store the raw
  // token or a hash") — the live run's own example — and the user should see it.
  const fixedList = r.ledger.allFindings().filter((f) => f.status === 'fixed');
  if (fixedList.length) {
    out.push('', `## Fixed (${fixedList.length}) — what each fixer changed`, 'Mention any choice or open question in these notes to the user.');
    for (const f of fixedList) out.push(`- ${f.id} [${f.severity}] ${f.files[0] ?? ''}: ${f.problem}${f.fixNote ? `\n  → ${f.fixNote}` : ''}`);
  }
  if (report.remaining.length) out.push('', `## Still open after the fix limit (${report.remaining.length})`, ...report.remaining.map(line));
  if (report.deferred.length) out.push('', `## Deferred (${report.deferred.length})`, ...report.deferred.map(line));
  if (r.failures.length) out.push('', `## Steps that failed (${r.failures.length})`, ...r.failures.map((f) => `- ${f.step} / ${f.who}: ${f.error}`));
  return out.join('\n');
}
