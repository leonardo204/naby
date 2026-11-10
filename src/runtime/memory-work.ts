// src/runtime/memory-work.ts
//
// THE MEMORY-WORK QUEUE RULES (specs/memory-worker.md §1, R2/R5/R8).
//
// Memory work — the reflection sweep, the post-turn review, the long-memory
// summaries and the tidy pass — runs BESIDE the user's turns, in its own process
// (R1). That process owns a queue, and this file owns every rule about that queue
// that does not need a store, a clock or a model:
//
//   * one job per kind is ever waiting (a second kick of the same kind updates the
//     waiting one rather than stacking — three quick turns are one review, not
//     three, exactly as the old in-process "one more pass" loop behaved);
//   * which job runs next, and that NOTHING runs while a job is running — one model
//     call at a time, however many jobs are waiting (R2);
//   * how long a job backs off after the subscription or provider says "too many"
//     (R5: one minute, doubling, at most thirty);
//   * what to queue when the process starts with nothing in memory (R8: the queue
//     is never persisted — the database already says what is owed).
//
// THE KIND IS A STRING ON PURPOSE. The four kinds below are today's; memory tiers
// (promotion, archive) will add more. An unknown kind still queues, coalesces and
// backs off — it simply sorts after the known ones — so adding a kind is a matter
// of an executor in the shell, not a change here.
//
// EVERYTHING HERE IS PURE. No store handle, no clock, no model, no process.

/** The kinds memory work has today. Open-ended: see the file header.
 *  `promote` and `archive` are the memory-tiers passes (memory-tiers §3/§4):
 *  promotion short → long → anchored, and archival plus final deletion. Neither
 *  calls a model. */
export type KnownMemoryJobKind = 'review' | 'summary' | 'reflection' | 'tidy' | 'promote' | 'archive';
export type MemoryJobKind = KnownMemoryJobKind | (string & {});

/**
 * The turn a job is pinned to (memory-auto-apply R38) — SERIALIZABLE, because it
 * crosses from the app server to the memory process. Everything the reviewer
 * needs to rebuild the turn's backend on the other side: which engine branch,
 * which provider, which model, which subscription. Never a key.
 */
export type MemoryJobModel = {
  engineId: string;
  providerId: string;
  model?: string;
  /** dev-claude only: which subscription the turn ran on. */
  accountId?: string;
};

export type MemoryJob = {
  kind: MemoryJobKind;
  /** The session whose turn queued it — the review puts that session's rows
   *  first, and the run-time model is looked up by it (R38). */
  sessionId?: string;
  /** Reflection only: the session being typed in, never reflected on. */
  excludeSessionId?: string;
  /** The queuing turn's model, when one is known. Re-seeded jobs have none and
   *  borrow the latest turn's (R38: "the turn that woke the sweep"). */
  model?: MemoryJobModel;
  /** Why it is in the queue — for the status line, never for a decision. */
  reason: 'turn' | 'reseed' | 'followup';
  enqueuedAt: number;
  /** How many times it has been put back for a rate limit (R5). */
  attempts: number;
  /** Not to be run before this instant (R5). 0 = now. */
  notBefore: number;
};

/** Order among waiting jobs: what the user can see first. The review settles the
 *  chat chip ("기억하는 중…") of the turn that just ended, so it goes first; the
 *  summaries are a display nicety; the sweep and the backlog tidy are catch-up. */
const KIND_PRIORITY: Readonly<Record<KnownMemoryJobKind, number>> = {
  review: 0,
  summary: 1,
  reflection: 2,
  tidy: 3,
  // The tier passes are bookkeeping: a promotion is visible only as a chip
  // that already says "remembered", and archival is days-scale by definition.
  promote: 4,
  archive: 5,
};
const UNKNOWN_KIND_PRIORITY = 10;

export function memoryJobPriority(kind: MemoryJobKind): number {
  return (KIND_PRIORITY as Record<string, number>)[kind] ?? UNKNOWN_KIND_PRIORITY;
}

/**
 * Kinds that must run on a TURN's model (R38). Without one they wait in the
 * queue — "no model" is not a failure to report, it is a job that cannot be
 * asked yet. The reflection sweep is not here: its judge resolves its own
 * backend from the user's provider choice (continuous-learning §4.4).
 */
const NEEDS_TURN_MODEL: ReadonlySet<string> = new Set(['review', 'summary', 'tidy']);

export function memoryJobNeedsTurnModel(kind: MemoryJobKind): boolean {
  return NEEDS_TURN_MODEL.has(kind);
}

/**
 * Kinds that never call a model (memory-tiers: promotion and archival are
 * computed from observations). A rate-limit block does not hold them (R5 holds
 * "nothing that calls a model") — they still run one at a time with the rest.
 */
const NO_MODEL_KINDS: ReadonlySet<string> = new Set(['promote', 'archive']);

export function memoryJobCallsModel(kind: MemoryJobKind): boolean {
  return !NO_MODEL_KINDS.has(kind);
}

export type MemoryQueue = readonly MemoryJob[];

/**
 * Put a job in the queue, coalescing by kind.
 *
 * A waiting job of the same kind is UPDATED, not duplicated: the newer kick's
 * session, model and exclusion win (they describe the latest turn), the older
 * one's place in time is kept, and a backoff already in force is NOT reset — a
 * rate-limited review that gets kicked again by the next turn must still wait
 * out its window (R5: "do not hammer").
 */
export function enqueueMemoryJob(queue: MemoryQueue, job: MemoryJob): MemoryJob[] {
  const i = queue.findIndex((q) => q.kind === job.kind);
  if (i < 0) return [...queue, job];
  const prev = queue[i]!;
  const merged: MemoryJob = {
    ...prev,
    ...(job.sessionId !== undefined ? { sessionId: job.sessionId } : {}),
    ...(job.excludeSessionId !== undefined ? { excludeSessionId: job.excludeSessionId } : {}),
    ...(job.model !== undefined ? { model: job.model } : {}),
    // A turn's kick outranks a re-seed's as the reason shown.
    reason: job.reason === 'turn' || prev.reason !== 'turn' ? job.reason : prev.reason,
    enqueuedAt: Math.min(prev.enqueuedAt, job.enqueuedAt),
    attempts: Math.max(prev.attempts, job.attempts),
    notBefore: Math.max(prev.notBefore, job.notBefore),
  };
  const next = [...queue];
  next[i] = merged;
  return next;
}

export type PickOptions = {
  now: number;
  /** A job is running. Nothing else starts — one model call at a time (R2). */
  running: boolean;
  /** The latest turn's model, for jobs that carry none. */
  fallbackModel?: MemoryJobModel;
  /** A rate limit is in force until this instant: NOTHING that calls a model
   *  starts before it, whatever its kind (R5). The limit belongs to the
   *  subscription or the key, not to the job that happened to meet it — letting
   *  the next kind in line call straight away would be the hammering R5 forbids. */
  blockedUntil?: number;
};

/**
 * The next job to run, or undefined. Never two at once: with a job running the
 * answer is always undefined, whatever is waiting (R2). Among runnable jobs the
 * kind priority decides, then the age.
 *
 * NOT RUNNABLE YET: a job inside its backoff window (R5), and a job that needs a
 * turn's model when neither it nor the latest turn has one (R38).
 */
export function pickNextMemoryJob(
  queue: MemoryQueue,
  opts: PickOptions,
): { job: MemoryJob; rest: MemoryJob[] } | undefined {
  if (opts.running) return undefined;
  let best: MemoryJob | undefined;
  for (const job of queue) {
    if (!isRunnable(job, opts)) continue;
    if (
      !best ||
      memoryJobPriority(job.kind) < memoryJobPriority(best.kind) ||
      (memoryJobPriority(job.kind) === memoryJobPriority(best.kind) && job.enqueuedAt < best.enqueuedAt)
    ) {
      best = job;
    }
  }
  if (!best) return undefined;
  const chosen = best;
  return { job: chosen, rest: queue.filter((j) => j !== chosen) };
}

function isRunnable(job: MemoryJob, opts: PickOptions): boolean {
  if (job.notBefore > opts.now) return false;
  if (memoryJobCallsModel(job.kind) && opts.blockedUntil !== undefined && opts.blockedUntil > opts.now) return false;
  if (memoryJobNeedsTurnModel(job.kind) && !job.model && !opts.fallbackModel) return false;
  return true;
}

/** When the earliest waiting job becomes runnable — for a wake-up timer. A
 *  rate-limit block in force (R5) holds every job until it lifts. */
export function nextMemoryWakeAt(queue: MemoryQueue, now: number, blockedUntil = 0): number | undefined {
  let at: number | undefined;
  for (const job of queue) {
    const ready = memoryJobCallsModel(job.kind) ? Math.max(job.notBefore, blockedUntil) : job.notBefore;
    if (ready > now && (at === undefined || ready < at)) at = ready;
  }
  return at;
}

// ---------------------------------------------------------------------------
// Backoff (R5)
// ---------------------------------------------------------------------------

export const MEMORY_BACKOFF_BASE_MS = 60_000;
export const MEMORY_BACKOFF_MAX_MS = 30 * 60_000;

/** The wait after the `attempts`-th rate limit: 1, 2, 4, 8, 16, 30, 30… minutes. */
export function memoryBackoffMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  // 2^(n-1) overflows nothing before the cap bites (n=6 already exceeds it).
  const raw = MEMORY_BACKOFF_BASE_MS * 2 ** Math.min(n - 1, 16);
  return Math.min(raw, MEMORY_BACKOFF_MAX_MS);
}

/** Put a rate-limited job back with its next window. */
export function deferMemoryJob(job: MemoryJob, now: number): MemoryJob {
  const attempts = job.attempts + 1;
  return { ...job, attempts, notBefore: now + memoryBackoffMs(attempts) };
}

/**
 * Is this failure the provider saying "not now" — a usage limit or an overload
 * (HTTP 429 / 529, Anthropic `rate_limit_error` / `overloaded_error`, the
 * subscription's "usage limit reached")? Those back off (R5). Everything else is
 * an ordinary failure: the job is dropped and the next turn queues it again
 * (memory-auto-apply R42), which is the retry the design already had.
 *
 * Reads the message and any numeric `status`/`statusCode` on the error, because
 * the two engines surface the same condition differently — the AI SDK throws an
 * error object carrying the HTTP status, the Agent SDK emits an error event whose
 * text names it.
 */
export function isMemoryRateLimitError(error: unknown): boolean {
  if (error === null || error === undefined) return false;
  if (typeof error === 'object') {
    const e = error as { status?: unknown; statusCode?: unknown; message?: unknown; cause?: unknown };
    for (const s of [e.status, e.statusCode]) {
      if (s === 429 || s === 529) return true;
    }
    if (e.cause !== undefined && e.cause !== error && isMemoryRateLimitError(e.cause)) return true;
  }
  const text =
    typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : typeof (error as { message?: unknown }).message === 'string'
          ? ((error as { message: string }).message)
          : '';
  return RATE_LIMIT_PATTERN.test(text);
}

const RATE_LIMIT_PATTERN =
  /\b(429|529)\b|rate[ _-]?limit|too many requests|overloaded|usage limit|quota exceeded|resource[ _]exhausted/i;

// ---------------------------------------------------------------------------
// Re-seed (R8)
// ---------------------------------------------------------------------------

/** What the database says is owed — counts only, read by the memory process. */
export type MemoryBacklog = {
  /** Rows written review-pending (memory-auto-apply R36). */
  pendingReview: number;
  /** Long rows with no summary line yet (R45–R48). */
  toSummarize: number;
  /** Confirmed rows never compared with their scope (R14). */
  unreviewed: number;
  /** memory-tiers: run the promotion and retention passes at start. Absent =
   *  not asked (a caller that predates tiers). */
  tiers?: boolean;
};

/**
 * The jobs a freshly started memory process queues, from the backlog alone. The
 * queue is never written down: a crash or a restart loses nothing, because each
 * kind of owed work is a query away. The sweep is not re-seeded — whether a
 * session is due depends on idleness the next turn will judge anyway, and the
 * next turn's start kicks it.
 */
export function reseedMemoryJobs(backlog: MemoryBacklog, now: number): MemoryJob[] {
  const job = (kind: MemoryJobKind): MemoryJob => ({ kind, reason: 'reseed', enqueuedAt: now, attempts: 0, notBefore: 0 });
  const out: MemoryJob[] = [];
  if (backlog.pendingReview > 0) out.push(job('review'));
  if (backlog.toSummarize > 0) out.push(job('summary'));
  if (backlog.unreviewed > 0) out.push(job('tidy'));
  // memory-tiers: both passes are cheap and idempotent, so a start simply runs
  // them — the database is what says which rows are due.
  if (backlog.tiers) {
    out.push(job('promote'));
    out.push(job('archive'));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Status (§2) — what Settings → Memory shows. Counts and codes, never content.
// ---------------------------------------------------------------------------

/** idle = nothing waiting; working = a job is running; waiting = jobs are owed
 *  but none can run yet (a backoff window, or no turn model to run on). */
export type MemoryWorkState = 'idle' | 'working' | 'waiting';

export function memoryWorkState(queue: MemoryQueue, running: boolean): MemoryWorkState {
  if (running) return 'working';
  return queue.length > 0 ? 'waiting' : 'idle';
}

/** Waiting jobs per kind. */
export function countMemoryJobs(queue: MemoryQueue): Record<string, number> {
  const out: Record<string, number> = {};
  for (const job of queue) out[job.kind] = (out[job.kind] ?? 0) + 1;
  return out;
}

/** Why the last job failed — a CODE the client turns into words. Never the
 *  provider's message: it can quote the prompt, and the prompt is memory. */
export type MemoryFailureReason = 'no-model' | 'rate-limited' | 'failed' | 'crashed';

export type MemoryWorkStatus = {
  /** Where the work runs: its own process (R1), or this one after the process
   *  could not be started (the fallback that keeps memory from silently stopping). */
  mode: 'worker' | 'in-process';
  state: MemoryWorkState;
  current?: { kind: MemoryJobKind; startedAt: number; size?: number };
  /** Waiting jobs per kind. */
  queued: Record<string, number>;
  /** What the database says is owed, as of the last look. */
  backlog?: MemoryBacklog;
  /** The earliest instant a backed-off job may run (R5). */
  nextRetryAt?: number;
  /** Why nothing runs while jobs wait: a rate-limit window (R5), or no turn has
   *  named a model yet since the process started (R38). */
  waitingFor?: 'backoff' | 'turn-model';
  lastDone?: { kind: MemoryJobKind; at: number; counts: Record<string, number> };
  lastFailure?: { kind: MemoryJobKind; at: number; reason: MemoryFailureReason; retryAt?: number };
  /** The backend label of the last model call — engine and model, no key. */
  model?: string;
  /** Model calls made today (local calendar day). */
  callsToday: number;
  /** How many times the memory process has been restarted. */
  restarts?: number;
};

/** The local calendar day a call is counted under — `YYYY-MM-DD`. */
export function memoryCallDay(now: number): string {
  const d = new Date(now);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Supervision — when to restart the memory process, when to give up on it (R1)
// ---------------------------------------------------------------------------

/** A process that dies this many times inside the window is not coming back on
 *  its own; the work moves in-process rather than looping on a crash. */
export const MEMORY_WORKER_CRASH_LIMIT = 5;
export const MEMORY_WORKER_CRASH_WINDOW_MS = 60_000;
/** Restart delay after the n-th recent crash: 0.5s, 1s, 2s… at most 15s. */
export function memoryWorkerRestartDelayMs(recentCrashes: number): number {
  const n = Math.max(1, Math.floor(recentCrashes));
  return Math.min(500 * 2 ** Math.min(n - 1, 10), 15_000);
}

/**
 * After a crash at `now`, with earlier crash instants `crashes`: restart (after
 * how long), or fall back to in-process. A process that never became ready is
 * treated the same as one that crashed — it is the "cannot start" case.
 */
export function decideMemoryWorkerRestart(
  crashes: readonly number[],
  now: number,
): { action: 'restart'; delayMs: number; recent: number[] } | { action: 'fallback'; recent: number[] } {
  const recent = [...crashes.filter((t) => now - t < MEMORY_WORKER_CRASH_WINDOW_MS), now];
  if (recent.length >= MEMORY_WORKER_CRASH_LIMIT) return { action: 'fallback', recent };
  return { action: 'restart', delayMs: memoryWorkerRestartDelayMs(recent.length), recent };
}
