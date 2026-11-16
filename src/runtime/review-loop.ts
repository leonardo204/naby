// src/runtime/review-loop.ts
//
// THE REVIEW LEDGER — WHO DECIDES WHEN A REVIEW-AND-FIX LOOP STOPS.
//
// Field case (2026-11-16): naby reviewed seven design documents with eight
// subagents, then ran fix → review → fix → fix → review → fix on its own for an
// hour (30 subagents). Three things went wrong, and none was a model failing to
// reason:
//
//   * FINDINGS DID NOT CONVERGE. Each review of a design document finds a new,
//     deeper layer; the medium count went UP between the second and the last
//     review. "Fix until clean" never ends on documents like these.
//   * A FIX MOVED A PROBLEM INSTEAD OF SOLVING IT. The same topic (how person
//     names are masked for the AI) was "fixed" twice and found wrong a third
//     time, each time in a new form. That was a design decision only the user
//     could make, and the loop kept handing it back to a fixer.
//   * READING GREW EVERY ROUND. Instructions were layered (round 3: "read the
//     round 1 and 2 instructions first"), so a fixer read 3.2M tokens in round 1
//     and 16.7M in round 4. 78% of the hour's reading came after round 2.
//
// So the CONTROL is code and the JUDGEMENT stays with models and the user:
//
//   * a reviewer returns typed findings. A finding that continues an earlier one
//     NAMES THAT FINDING (`relatesTo`): "the same problem again" or "caused by
//     the fix for it". Deciding that link is a judgement, so a model makes it;
//     counting is code. Linking finding-to-finding, not tagging categories, is
//     deliberate: in the replay of the field case a reviewer tagging TOPICS
//     made category buckets ("values differ between documents") and 18 unrelated
//     new findings counted as "came back" — the matching error, amplified by the
//     rule. A link to one specific finding cannot form a bucket.
//   * a chain that comes back after one of its findings was FIXED is not sent to
//     a fixer again: it is ESCALATED to the user with its history
//     (`REVIEW_TOPIC_REOPEN_LIMIT`). A link to a finding that was never fixed
//     only groups; it is not a reopen. Only findings at or above the fix
//     severity reopen a chain or become user decisions — in the replay, low
//     follow-ups (a missing index, a nonce format) would otherwise have filled
//     the user's decision list; they are deferred like any low finding.
//   * at most `REVIEW_MAX_FIX_ROUNDS` fix rounds; whatever is still open after
//     that goes to the user as a list, by severity.
//   * a fixer gets only the open findings for the files it owns — the ledger is
//     the one current state, nothing is layered.
//   * NOTHING IS DROPPED SILENTLY. A rule may defer a finding or hand it to the
//     user; it never discards one. Every finding ends in the hand-off report or
//     as fixed.
//   * the ledger lives for ONE loop. A later loop starts fresh, so a wrong
//     verdict cannot be replayed forever.
//
// Everything here is PURE — no store, no clock, no model — so a spike can pin
// every rule, and the same ledger can be replayed over recorded reviews.

// ---------------------------------------------------------------------------
// Thresholds — exported so the spike and the runner read the same numbers
// ---------------------------------------------------------------------------

/** Fix rounds before the remaining findings go to the user. Two because the
 *  field case showed the first two rounds fixing real, specific problems and
 *  everything after them mostly chasing a growing tail. */
export const REVIEW_MAX_FIX_ROUNDS = 2;

/** How many times a topic may come back after a fix before the user decides it.
 *  1 = the first reappearance after a fix escalates. */
export const REVIEW_TOPIC_REOPEN_LIMIT = 1;

/** Findings at or above this severity are sent to a fixer; below it they are
 *  listed for the user. */
export const REVIEW_MIN_FIX_SEVERITY: ReviewSeverity = 'medium';

/** Topic titles are short labels, not sentences. */
export const REVIEW_TOPIC_TITLE_MAX = 80;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReviewSeverity = 'high' | 'medium' | 'low';

const SEVERITY_RANK: Record<ReviewSeverity, number> = { high: 3, medium: 2, low: 1 };

/** What the finding stands on. `inferred` alone is a guess, so it is deferred. */
export type ReviewEvidence = 'quoted' | 'cross-doc' | 'spec' | 'missing' | 'inferred';

/** How a finding continues an earlier one. */
export type FindingRelation = 'again' | 'caused-by-fix';

/** One finding as a reviewer returns it. */
export type ReviewFindingInput = {
  /** The earlier finding this one continues, from `reviewerIndex()`. An id the
   *  ledger does not know is ignored — the finding starts its own chain. */
  relatesTo?: { findingId: string; kind: FindingRelation };
  /** Short label for the report; defaults to the problem text. */
  topicTitle?: string;
  severity: ReviewSeverity;
  /** Files the finding is about; the FIRST is the one a fixer edits. */
  files: string[];
  location?: string;
  problem: string;
  fix?: string;
  evidence: ReviewEvidence[];
};

export type ReviewFindingStatus =
  | 'open' // waiting for a fixer
  | 'assigned' // handed to a fixer this round
  | 'fixed'
  | 'deferred' // a rule held it back; listed for the user
  | 'user'; // escalated: the user decides

export type ReviewFinding = ReviewFindingInput & {
  id: string;
  topicId: string;
  round: number;
  status: ReviewFindingStatus;
  /** Why it is deferred or escalated, in words a person reads. */
  note?: string;
  /** What the fixer says it changed — shown to the next reviewer. */
  fixNote?: string;
};

/** A chain of findings linked by `relatesTo`, rooted at the first one. */
export type ReviewTopic = {
  id: string;
  title: string;
  /** Review rounds the topic was found in, in order. */
  seenInRounds: number[];
  /** How many times it came back after a fix had been handed out for it. */
  reopened: number;
  /** A fix was handed out for this topic at least once. */
  fixAttempted: boolean;
  escalated: boolean;
};

export type FixOutcome = 'fixed' | 'already-resolved' | 'not-fixed' | 'other-owner';

/** One fixer's job: one file it owns and the open findings for it. */
export type FixAssignment = { file: string; findings: ReviewFinding[] };

export type ReviewNextStep =
  | { kind: 'fix'; round: number; assignments: FixAssignment[] }
  | { kind: 'verify'; files: string[] }
  | { kind: 'handoff'; reason: ReviewHandoffReason; report: ReviewHandoffReport };

export type ReviewHandoffReason = 'clean' | 'fix-limit' | 'only-user-decisions';

export type ReviewHandoffReport = {
  reason: ReviewHandoffReason;
  fixRounds: number;
  fixed: number;
  /** Topics that came back after a fix — the user decides these. */
  decisions: Array<{ topic: ReviewTopic; findings: ReviewFinding[] }>;
  /** Still open after the fix limit, by severity, highest first. */
  remaining: ReviewFinding[];
  /** Held back by a rule (guesses, below the fix severity), with the reason. */
  deferred: ReviewFinding[];
};

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

export type ReviewLedgerOptions = {
  maxFixRounds?: number;
  topicReopenLimit?: number;
  minFixSeverity?: ReviewSeverity;
};

export class ReviewLedger {
  readonly maxFixRounds: number;
  readonly topicReopenLimit: number;
  readonly minFixSeverity: ReviewSeverity;

  private readonly findings: ReviewFinding[] = [];
  private readonly topics = new Map<string, ReviewTopic>();
  private reviewRounds = 0;
  private fixRounds = 0;
  /** Files changed by fixers since the last review — what a verify reads. */
  private changedSinceReview = new Set<string>();
  private nextTopic = 1;
  private nextFinding = 1;

  constructor(opts: ReviewLedgerOptions = {}) {
    this.maxFixRounds = opts.maxFixRounds ?? REVIEW_MAX_FIX_ROUNDS;
    this.topicReopenLimit = opts.topicReopenLimit ?? REVIEW_TOPIC_REOPEN_LIMIT;
    this.minFixSeverity = opts.minFixSeverity ?? REVIEW_MIN_FIX_SEVERITY;
  }

  /** What a reviewer is shown so it can link a new finding to an earlier one:
   *  every finding so far, with its status and what the fixer changed. */
  reviewerIndex(): Array<{ id: string; files: string[]; problem: string; status: ReviewFindingStatus; fixNote?: string }> {
    return this.findings.map((f) => ({
      id: f.id,
      files: f.files,
      problem: f.problem,
      status: f.status,
      ...(f.fixNote ? { fixNote: f.fixNote } : {}),
    }));
  }

  /**
   * Record one review round. A finding linked to a known finding joins its
   * chain; a link to an unknown id is ignored (a typo must not merge two
   * problems). Returns the recorded findings with their ids.
   */
  addReview(inputs: readonly ReviewFindingInput[]): ReviewFinding[] {
    this.reviewRounds += 1;
    const round = this.reviewRounds;
    this.changedSinceReview.clear();
    const out: ReviewFinding[] = [];
    const reopenedNow = new Set<string>();

    for (const input of inputs) {
      const files = input.files.map((f) => f.trim()).filter(Boolean);
      const target = input.relatesTo ? this.findings.find((x) => x.id === input.relatesTo!.findingId && x.round < round) : undefined;
      const topic = target ? this.topics.get(target.topicId)! : this.newTopic(input);
      // A reopen is a link to a finding that was FIXED: the fix did not hold,
      // or it caused this. Counted once per chain per round.
      // A low-severity follow-up is not worth a user decision: it is deferred
      // below like any low finding, and the chain is not reopened by it.
      const weighty = SEVERITY_RANK[input.severity] >= SEVERITY_RANK[this.minFixSeverity];
      // "AGAIN" counts only in the file that fix EDITED. A fixer owns one file,
      // so a finding that spans two is fixed in its first file only; the same
      // problem found next round in the OTHER file is the unfinished half, not a
      // fix that failed (emulation 2026-11-16: its one "decision" was exactly
      // this). "CAUSED-BY-FIX" counts wherever it lands: the fix itself made a
      // new problem, and in the field case that new problem sat in the other
      // document (name masking: fixed in 20-7-3, broke 20-7-5).
      const sameFile = !!target && !!files[0] && !!target.files[0] && samePath(files[0], target.files[0]);
      const failedFix = input.relatesTo?.kind === 'caused-by-fix' || sameFile;
      if (target && target.status === 'fixed' && weighty && failedFix && !reopenedNow.has(topic.id)) {
        topic.reopened += 1;
        reopenedNow.add(topic.id);
      }
      if (topic.seenInRounds[topic.seenInRounds.length - 1] !== round) topic.seenInRounds.push(round);
      const finding: ReviewFinding = {
        ...input,
        files,
        id: `F${this.nextFinding++}`,
        topicId: topic.id,
        round,
        status: 'open',
      };
      this.classify(finding, topic);
      this.findings.push(finding);
      out.push(finding);
    }

    // A topic that just crossed the limit pulls every open finding of it — this
    // round's and any left over — to the user.
    for (const id of reopenedNow) {
      const topic = this.topics.get(id)!;
      if (topic.reopened >= this.topicReopenLimit) this.escalate(topic);
    }
    return out;
  }

  /** Record what a fixer did with each finding it was given. */
  recordFix(results: ReadonlyArray<{ findingId: string; outcome: FixOutcome; note?: string }>, changedFiles: readonly string[]): void {
    for (const f of changedFiles) this.changedSinceReview.add(f);
    for (const r of results) {
      const f = this.findings.find((x) => x.id === r.findingId);
      if (!f || f.status !== 'assigned') continue;
      if (r.outcome === 'fixed' || r.outcome === 'already-resolved') {
        f.status = 'fixed';
        if (r.note) f.fixNote = r.note;
      } else {
        // Not fixed, or someone else's file: back to open for the next round,
        // never dropped.
        f.status = 'open';
        if (r.note) f.note = r.note;
      }
    }
    // Anything a fixer did not report on stays visible as open.
    for (const f of this.findings) if (f.status === 'assigned') f.status = 'open';
  }

  /**
   * What happens next. `afterFix` is true right after a fix round: the changed
   * files are verified before anything else is decided.
   */
  next(afterFix = false): ReviewNextStep {
    if (afterFix && this.changedSinceReview.size > 0) {
      return { kind: 'verify', files: [...this.changedSinceReview].sort() };
    }
    const open = this.findings.filter((f) => f.status === 'open');
    if (open.length > 0 && this.fixRounds < this.maxFixRounds) {
      this.fixRounds += 1;
      for (const f of open) {
        f.status = 'assigned';
        this.topics.get(f.topicId)!.fixAttempted = true;
      }
      return { kind: 'fix', round: this.fixRounds, assignments: groupByFile(open) };
    }
    const reason: ReviewHandoffReason =
      open.length > 0 ? 'fix-limit' : this.findings.some((f) => f.status === 'user') ? 'only-user-decisions' : 'clean';
    return { kind: 'handoff', reason, report: this.report(reason) };
  }

  report(reason: ReviewHandoffReason): ReviewHandoffReport {
    const decisions = [...this.topics.values()]
      .filter((t) => t.escalated)
      .map((topic) => ({ topic, findings: this.findings.filter((f) => f.topicId === topic.id && f.status === 'user') }))
      .filter((d) => d.findings.length > 0);
    return {
      reason,
      fixRounds: this.fixRounds,
      fixed: this.findings.filter((f) => f.status === 'fixed').length,
      decisions,
      remaining: bySeverity(this.findings.filter((f) => f.status === 'open')),
      deferred: bySeverity(this.findings.filter((f) => f.status === 'deferred')),
    };
  }

  /** Read-only views for the runner and the spike. */
  allFindings(): readonly ReviewFinding[] {
    return this.findings;
  }
  allTopics(): readonly ReviewTopic[] {
    return [...this.topics.values()];
  }
  get rounds(): { review: number; fix: number } {
    return { review: this.reviewRounds, fix: this.fixRounds };
  }

  // -- internals -------------------------------------------------------------

  private newTopic(input: ReviewFindingInput): ReviewTopic {
    const title = (input.topicTitle || input.problem).replace(/\s+/g, ' ').trim().slice(0, REVIEW_TOPIC_TITLE_MAX);
    const topic: ReviewTopic = {
      id: `T${this.nextTopic++}`,
      title,
      seenInRounds: [],
      reopened: 0,
      fixAttempted: false,
      escalated: false,
    };
    this.topics.set(topic.id, topic);
    return topic;
  }

  private classify(f: ReviewFinding, topic: ReviewTopic): void {
    const weighty = SEVERITY_RANK[f.severity] >= SEVERITY_RANK[this.minFixSeverity];
    if (topic.escalated && weighty) {
      f.status = 'user';
      f.note = 'The topic is already with the user.';
    } else if (f.evidence.length > 0 && f.evidence.every((e) => e === 'inferred')) {
      f.status = 'deferred';
      f.note = 'Only inferred evidence; listed for the user rather than fixed.';
    } else if (SEVERITY_RANK[f.severity] < SEVERITY_RANK[this.minFixSeverity]) {
      f.status = 'deferred';
      f.note = `Below the fix threshold (${this.minFixSeverity}).`;
    } else if (f.files.length === 0) {
      f.status = 'deferred';
      f.note = 'No file named, so no fixer owns it.';
    }
  }

  private escalate(topic: ReviewTopic): void {
    topic.escalated = true;
    for (const f of this.findings) {
      const weighty = SEVERITY_RANK[f.severity] >= SEVERITY_RANK[this.minFixSeverity];
      if (f.topicId === topic.id && weighty && (f.status === 'open' || f.status === 'deferred')) {
        f.status = 'user';
        f.note = `Came back after ${topic.reopened} fix attempt(s); the user decides.`;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function samePath(a: string, b: string): boolean {
  const n = (p: string) => p.trim().replace(/^\.\//, '').replace(/\\/g, '/');
  const x = n(a);
  const y = n(b);
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

function groupByFile(findings: readonly ReviewFinding[]): FixAssignment[] {
  const byFile = new Map<string, ReviewFinding[]>();
  for (const f of findings) {
    const file = f.files[0]!;
    const list = byFile.get(file) ?? [];
    list.push(f);
    byFile.set(file, list);
  }
  return [...byFile.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, list]) => ({ file, findings: bySeverity(list) }));
}

function bySeverity(findings: readonly ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.id.localeCompare(b.id, 'en', { numeric: true }));
}
