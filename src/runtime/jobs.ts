// src/runtime/jobs.ts
//
// BACKGROUND JOBS — work that outlives the turn that started it.
//
// THE REPORT THIS EXISTS FOR. The user said "배포하고 끝나면 알려줘". naby
// answered "완료되면 알려드릴게요", the turn ended, and nothing was ever said
// again. Not a wording bug: there was no mechanism. A tool call has to return
// before the turn can end, so a fifteen-minute deploy either blocked the turn
// until it timed out, or was fired and forgotten.
//
// WHY NOT THE SDK'S OWN BACKGROUNDING. The Claude Agent SDK can background a
// Bash call, but its lifecycle edges only arrive while that query() is still
// running — the shell says so itself (client/backgroundJobs.ts): once the turn
// ends the job's status is `unknown` and stays there. It is also Claude-only, so
// on Gemini or any other ai-sdk provider there is nothing at all. naby's whole
// premise is that the harness is OURS and provider-independent, so the process
// has to be ours: we spawn it, we hold the handle, we hear it exit.
//
// THIS IS NOT A DAEMON, AND THE DIFFERENCE IS THE WHOLE DESIGN. The repo bans
// standing pollers (phase-3-continuous-learning §60, telegram-chat §43) and this
// obeys that ban: nothing here wakes up on a timer, scans a table or asks "is it
// done yet". A child process's `close` event is an INTERRUPT the OS delivers
// once, to a listener that costs nothing while it waits. The event loop is held
// open by the child, not by us. When no job is running this module is inert.
//
// WHAT THE RUNTIME MAY AND MAY NOT DO WITH THE ENDING. It may notice it; it may
// not act on it. Dispatching a turn is the shell's job (only the shell has
// sessions, an orchestrator and a run hub), so the ending leaves through a
// `JobSink` the shell injects at the SAME seam as `McpProposalSink`,
// `CheckinSink` and `MemorySink` — the naby-layer toolset (`buildToolset`),
// because owning the process end to end is what makes this a naby capability
// rather than a stand-in for a provider that cannot run a shell. The tool
// surface over this module is `job-tools.ts`. NO SINK IS A SUPPORTED
// CONFIGURATION: a spike or a headless runtime still runs jobs, still records
// their outcome, and simply tells nobody.
//
// WHERE THE OUTPUT GOES. Not into memory, and not into the tool result: a build
// log is megabytes and the turn that reads it is a context window. Each job owns
// two files under `<naby home>/jobs/`:
//
//     <id>.log    combined stdout+stderr, capped at JOB_LOG_MAX_BYTES
//     <id>.json   the record — command, cwd, status, exit code, timings
//
// The `.json` is written at spawn (status `running`) and rewritten on exit, and
// that is what makes the honest answer to "what happened to job X" possible
// after a restart. See `resolveJobRecord`.
//
// WHAT AN APP RESTART COSTS, SAID OUT LOUD. The registry is in this process and
// dies with it. A job whose `.json` still says `running` when no live record
// backs it is reported as `lost` — we know we STOPPED WATCHING, we do not know
// what the command did. Reporting it as `running` would be a spinner attached to
// nothing; reporting it as `succeeded` would be a fabrication. `lost` is the
// only true thing left to say.

import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  closeSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configuredNabyHome } from './naby-home.js';

// ---------------------------------------------------------------------------
// The contract, as constants
// ---------------------------------------------------------------------------

/** The directory jobs live in, under the naby home. */
export const JOBS_DIR_NAME = 'jobs';

/**
 * Hard cap on one job's log file.
 *
 * Two orders of magnitude above the foreground `run_command` cap (30k chars),
 * because the jobs that need backgrounding are the ones that talk: a webpack
 * build, a test suite, a deploy. Once the cap is hit the writer STOPS — it does
 * not rotate and it does not drop the head — and the record is stamped
 * `truncated`. Keeping the head is deliberate: the head holds the command's
 * configuration and its first error, which is what a reader needs when a job
 * failed early and then spewed.
 */
export const JOB_LOG_MAX_BYTES = 1_000_000;

/**
 * How much of the RECENT output is kept, separately from the log above.
 *
 * THE LOG KEEPS THE HEAD AND THIS KEEPS THE TAIL, and both are right for their
 * own reader. A person debugging a job that failed early needs the first error;
 * a person watching a job that is still running needs the last line. One file
 * cannot be both, and the head-keeping rule above is deliberate — so rather than
 * weaken it, the recent end is kept here, in memory, bounded, and thrown away
 * when the job ends.
 *
 * In memory and not on disk because it exists only for a job that is CURRENTLY
 * running: once the job is over the log is the record, and a second file would
 * be a second thing to clean up.
 */
export const JOB_TAIL_MAX_BYTES = 8_000;

/**
 * The floor between two progress signals.
 *
 * NOT A TIMER, AND THE DIFFERENCE MATTERS — this module is forbidden a standing
 * poller (see the header). Progress rides the child's own `data` event, which
 * the OS delivers when the child actually wrote something; this constant only
 * decides how many of those to ignore. A job that prints nothing emits nothing,
 * and a job that prints a thousand lines a second still signals once a window.
 */
export const JOB_PROGRESS_MIN_GAP_MS = 5_000;

/** Default number of characters `naby_read_job_output` returns. Sized to be
 *  readable inside a turn without spending the window on one tool result. */
export const JOB_OUTPUT_DEFAULT_CHARS = 8_000;

/** Hard ceiling on one `naby_read_job_output` call, whatever the model asks for. */
export const JOB_OUTPUT_MAX_CHARS = 30_000;

/** How long a job may run before it is killed. A background job is allowed to be
 *  slow — that is the point — but not immortal: an orphaned process group that
 *  outlives the app is a resource leak the user never asked for. Six hours is
 *  longer than any build and shorter than a forgotten process. */
export const JOB_MAX_RUNTIME_MS = 6 * 60 * 60 * 1_000;

/** Command lines longer than this are stored clipped. A record is a label, not
 *  an archive; the full command is in the log file's header line. */
const COMMAND_LABEL_MAX = 400;

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/**
 * Where a job stands.
 *
 *   running    the child is alive and THIS process is holding its handle
 *   succeeded  it exited 0
 *   failed     it exited non-zero, or could not be spawned at all
 *   killed     something stopped it (killJob, or the runtime ceiling)
 *   lost       it was started by an app session that has since ended; whether
 *              the command finished is unrecorded. See the module header.
 *   unknown    no job by that id was ever started on this machine
 */
export type JobStatus = 'running' | 'succeeded' | 'failed' | 'killed' | 'lost' | 'unknown';

/** Statuses a job never leaves. */
const TERMINAL: readonly JobStatus[] = ['succeeded', 'failed', 'killed'];

/** True when a status is final — the job will never change again. */
export function isTerminalJobStatus(status: JobStatus): boolean {
  return TERMINAL.includes(status);
}

/** One job, as it is stored and as it is reported. Plain data on purpose: it is
 *  written to JSON, handed to a sink the shell owns, and rendered into a tool
 *  result, and none of those may depend on a prototype. */
export interface JobRecord {
  id: string;
  /** The command line, clipped to a label length. */
  command: string;
  /** The directory it runs in. */
  cwd: string;
  status: JobStatus;
  startedAt: number;
  endedAt?: number;
  /** Present once the child exited on its own. */
  exitCode?: number;
  /** Present when it was ended by a signal. */
  signal?: string;
  /** Set when the log hit `JOB_LOG_MAX_BYTES` and stopped growing. */
  truncated?: boolean;
  /** Absolute path of the log file, so a human can `tail -f` it. */
  logPath?: string;
  /**
   * WHEN THE JOB LAST WROTE ANYTHING (epoch ms).
   *
   * The difference between "running" and "running and alive". A job that has
   * printed nothing for an hour may be working or may be wedged, and the reader
   * deserves to be able to tell them apart. Absent until the first byte.
   */
  lastOutputAt?: number;
  /** Total bytes the child has written, including anything past the log cap.
   *  Keeps counting after `truncated`, so it still reads as progress. */
  outputBytes?: number;
  /** Why a job could not start, or why it was killed. */
  note?: string;
  /** The session that started it, when a caller named one. Carried so a sink
   *  can dispatch the follow-up turn into the RIGHT conversation. */
  sessionId?: string;
}

/**
 * Where a finished job's ending is delivered.
 *
 * The runtime cannot dispatch a turn — it has no sessions and no orchestrator —
 * so it hands the ending to whoever injected this. Called EXACTLY ONCE per job,
 * and never for a job that is still running.
 *
 * It must not throw: `notifyFinished` swallows anything it does, on the same
 * reasoning as the activity log (observation must not break the thing observed).
 */
export interface JobSink {
  onFinished(job: JobRecord): void;
  /**
   * The job is alive and has written something. OPTIONAL, and rate-limited to
   * one call per `JOB_PROGRESS_MIN_GAP_MS` per job.
   *
   * WHY THIS IS NOT A SECOND `onFinished`. It carries no promise and starts no
   * turn: an ending is news, and "still going" is a display. A consumer is
   * expected to update something already on screen, not to speak. That is also
   * why it may be dropped — a missed progress edge costs a stale elapsed count,
   * while a missed ending costs the report.
   *
   * `tail` is the recent output, already bounded to `JOB_TAIL_MAX_BYTES`.
   */
  onProgress?(job: JobRecord, tail: string): void;
}

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

/** A fresh job id. Prefixed so it is recognisable in a log directory listing and
 *  in a tool result, and so a stray id from somewhere else cannot be mistaken
 *  for one of ours. */
export function newJobId(): string {
  return `job-${randomUUID().slice(0, 8)}`;
}

/** Whether a string could be one of our job ids. Used before touching the
 *  filesystem, so a model-supplied id can never become a path segment: no
 *  separators, no dots, no traversal. */
export function isJobId(value: unknown): value is string {
  return typeof value === 'string' && /^job-[a-z0-9-]{4,64}$/i.test(value);
}

/** The command as it is stored on the record — one line, bounded. */
export function jobCommandLabel(raw: string): string {
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length <= COMMAND_LABEL_MAX
    ? oneLine
    : `${oneLine.slice(0, COMMAND_LABEL_MAX - 1)}…`;
}

/**
 * The status an exit means.
 *
 * A signal ALWAYS wins over the code: a process killed by SIGKILL reports
 * `code: null`, and reading that as "exit 0, succeeded" is exactly the
 * fabrication this whole module is trying not to commit.
 */
export function statusFromExit(code: number | null, signal: string | null): JobStatus {
  if (signal) return 'killed';
  return code === 0 ? 'succeeded' : 'failed';
}

/**
 * What to report for a job, given what the live registry knows and what is on
 * disk. THE ONE PLACE the restart rule is written down.
 *
 *   live record          -> it, whatever it says (this process owns the truth)
 *   stored + terminal    -> it, because somebody observed the ending and wrote it
 *   stored + running     -> `lost`: the owner process is gone, the outcome was
 *                          never recorded, and neither "running" nor an invented
 *                          exit code would be true
 *   nothing              -> `unknown`
 *
 * Pure, so the rule is testable without spawning anything.
 */
export function resolveJobRecord(
  live: JobRecord | undefined,
  stored: JobRecord | undefined,
): JobRecord | undefined {
  if (live) return live;
  if (!stored) return undefined;
  if (isTerminalJobStatus(stored.status)) return stored;
  return {
    ...stored,
    status: 'lost',
    note:
      'the app session that started this job has ended, so its outcome was never recorded. ' +
      'The log file below is everything that was written before we stopped watching.',
  };
}

/** A one-line human summary of a record, for a tool result. */
export function describeJob(job: JobRecord, now: number = Date.now()): string {
  const end = job.endedAt ?? now;
  const seconds = Math.max(0, Math.round((end - job.startedAt) / 1000));
  const parts = [`${job.id} — ${job.status}`, `${seconds}s`];
  if (job.exitCode !== undefined) parts.push(`exit ${job.exitCode}`);
  if (job.signal) parts.push(`signal ${job.signal}`);
  if (job.truncated) parts.push('output truncated');
  return `${parts.join(', ')}\n$ ${job.command}`;
}

// ---------------------------------------------------------------------------
// Where the files live
// ---------------------------------------------------------------------------

/**
 * The job directory, or undefined when this process must not write into a home
 * nobody named.
 *
 * SAME RULE AS THE ACTIVITY LOG, and for the same reason: a spike that starts a
 * job must not leave files in the user's real `~/.naby`. The store registers its
 * own directory there; here the environment is the only source, because a job
 * can be started with no store open at all. `nabyHomeDir()`'s `~/.naby` default
 * is deliberately NOT used.
 */
export function jobsDir(): string | undefined {
  const home = configuredNabyHome() ?? registeredJobsHome;
  return home ? join(home, JOBS_DIR_NAME) : undefined;
}

/** A home registered by the app at boot, for the case where the environment did
 *  not name one. Set by `setJobsHome`; the environment still wins. */
let registeredJobsHome: string | undefined;

/** Point jobs at a home explicitly (tests, and any embedder that resolves its
 *  own home). `undefined` forgets it. */
export function setJobsHome(dir: string | undefined): void {
  registeredJobsHome = dir;
}

function logPathFor(dir: string, id: string): string {
  return join(dir, `${id}.log`);
}

function recordPathFor(dir: string, id: string): string {
  return join(dir, `${id}.json`);
}

// ---------------------------------------------------------------------------
// The registry — in this process, and honest about it
// ---------------------------------------------------------------------------

type LiveJob = {
  record: JobRecord;
  /** Bytes written to the log so far, so the cap is enforced without stat()ing. */
  written: number;
  /** The recent end of the output, bounded to `JOB_TAIL_MAX_BYTES`. Unlike the
   *  log it keeps the LAST bytes, and unlike the log it never stops growing. */
  tail: string;
  /** When a progress edge was last emitted, so the next one can be skipped. */
  lastProgressAt: number;
  /** Cleared on exit, so a finished job stops holding a timer. */
  ceiling?: ReturnType<typeof setTimeout>;
  kill: (signal?: NodeJS.Signals) => void;
  /** Guards the exactly-once contract on `sink.onFinished`. */
  settled: boolean;
};

const live = new Map<string, LiveJob>();

/** Every job this process is currently running. */
export function listRunningJobs(): JobRecord[] {
  return [...live.values()].map((j) => ({ ...j.record }));
}

/**
 * Every job record on disk, newest first — including the ones this process never
 * started. Bounded, because a long-lived home accumulates them.
 *
 * WHY THE SHELL NEEDS THIS AND `listRunningJobs` IS NOT ENOUGH. The in-process
 * registry knows only what THIS process spawned; after a restart it is empty
 * while the records are still there, saying `running` about children that are
 * now orphans. A reader that asked only the registry would show nothing and be
 * wrong in the reassuring direction.
 */
export function listJobRecords(limit = 50): JobRecord[] {
  const dir = jobsDir();
  if (!dir) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: JobRecord[] = [];
  for (const name of names) {
    const id = name.slice(0, -'.json'.length);
    if (!isJobId(id)) continue;
    const record = resolveJobRecord(live.get(id)?.record, readRecord(dir, id));
    if (record) out.push({ ...record });
  }
  out.sort((a, b) => b.startedAt - a.startedAt);
  return out.slice(0, Math.max(1, limit));
}

/**
 * Settle the records that an unclean shutdown left saying `running`.
 *
 * WHAT THIS DOES NOT DO: touch the processes. A background child is spawned
 * detached into its own process group, so after a restart it may well still be
 * encoding — this process simply no longer holds its handle and can never hear
 * it end. Killing it would destroy work the user asked for; adopting it is not
 * possible. So the honest move is to stop CLAIMING to be watching: the record is
 * stamped `lost`, which `resolveJobRecord` already means as "it ran, and how it
 * ended was never recorded", and the log path is left in place so a person can
 * still read what it managed to say.
 *
 * Returns what it settled, so a caller can tell the user once at boot rather
 * than leaving the discovery to whenever they next ask.
 */
export function markLostJobs(): JobRecord[] {
  const dir = jobsDir();
  if (!dir) return [];
  const settled: JobRecord[] = [];
  for (const record of listJobRecords(200)) {
    if (record.status !== 'lost') continue;
    if (live.has(record.id)) continue;
    const next: JobRecord = {
      ...record,
      note: record.note ?? 'the app restarted while this job was running',
    };
    writeRecord(dir, next);
    settled.push(next);
  }
  return settled;
}

/** Forget every live job WITHOUT killing anything. Test seam only — production
 *  never wants this, because forgetting a job is how a spinner outlives it. */
export function resetJobRegistry(): void {
  for (const job of live.values()) if (job.ceiling) clearTimeout(job.ceiling);
  live.clear();
}

// ---------------------------------------------------------------------------
// Persistence of the record
// ---------------------------------------------------------------------------

function writeRecord(dir: string, record: JobRecord): void {
  try {
    writeFileSync(recordPathFor(dir, record.id), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  } catch {
    // A job whose record could not be written still runs, and its ending still
    // reaches the sink in this process. Only the after-a-restart answer is lost.
  }
}

function readRecord(dir: string, id: string): JobRecord | undefined {
  try {
    const raw = readFileSync(recordPathFor(dir, id), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return undefined;
    const rec = parsed as JobRecord;
    return typeof rec.id === 'string' && typeof rec.status === 'string' ? rec : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Starting one
// ---------------------------------------------------------------------------

export interface StartJobInput {
  command: string;
  cwd: string;
  /** The session this job belongs to, when the caller has one. Carried onto the
   *  record so a sink can report back into the right conversation. */
  sessionId?: string;
  /** Where the ending goes. Absent is supported: the job runs, its outcome is
   *  recorded, and nobody is told. */
  sink?: JobSink;
  /** Overridable so a test does not wait six hours to observe the ceiling. */
  maxRuntimeMs?: number;
  /** Overridable so a test does not have to produce a megabyte of output. */
  maxLogBytes?: number;
}

export type StartJobResult =
  | { ok: true; job: JobRecord }
  | { ok: false; error: string };

/**
 * Spawn a command, return immediately, and hear about the ending.
 *
 * The one thing this function must never do is wait. It returns as soon as the
 * child is spawned (or fails to spawn), which is what lets the tool result be
 * "started, here is the id" and the turn end normally.
 */
export function startJob(input: StartJobInput): StartJobResult {
  const dir = jobsDir();
  if (!dir) {
    return {
      ok: false,
      error:
        'background jobs need a naby home to write their log into, and this process has none ' +
        '(no NABY_DB_PATH / NABY_HOME / COCKPIT_HOME).',
    };
  }
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { ok: false, error: `could not create the job directory: ${String(e)}` };
  }

  const id = newJobId();
  const logPath = logPathFor(dir, id);
  const maxLogBytes = input.maxLogBytes ?? JOB_LOG_MAX_BYTES;
  const record: JobRecord = {
    id,
    command: jobCommandLabel(input.command),
    cwd: input.cwd,
    status: 'running',
    startedAt: Date.now(),
    logPath,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  };

  // The header is written before the child says anything, so a log file always
  // identifies its own job even if the command produces no output at all.
  const header =
    `# naby background job ${id}\n` +
    `# started ${new Date(record.startedAt).toISOString()}\n` +
    `# cwd ${input.cwd}\n` +
    `$ ${input.command}\n\n`;
  try {
    writeFileSync(logPath, header, 'utf8');
  } catch (e) {
    return { ok: false, error: `could not open the job log: ${String(e)}` };
  }

  let child;
  try {
    // `shell: true` for the same reason the foreground tool does it — pipes and
    // redirection are most of why a command is reached for. `detached` puts the
    // child in its own process GROUP so the whole tree can be killed; a plain
    // kill would take the shell and orphan its children.
    child = spawn(input.command, {
      cwd: input.cwd,
      shell: true,
      detached: process.platform !== 'win32',
      env: process.env,
    });
  } catch (e) {
    const failed: JobRecord = {
      ...record,
      status: 'failed',
      endedAt: Date.now(),
      note: `could not start: ${e instanceof Error ? e.message : String(e)}`,
    };
    writeRecord(dir, failed);
    return { ok: false, error: failed.note ?? 'could not start' };
  }

  const entry: LiveJob = {
    record,
    written: header.length,
    tail: '',
    lastProgressAt: 0,
    settled: false,
    kill: (signal: NodeJS.Signals = 'SIGKILL') => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        /* already gone */
      }
    },
  };
  live.set(id, entry);
  writeRecord(dir, record);

  const append = (chunk: Buffer): void => {
    const raw = chunk.toString('utf8');

    // ── LIVENESS FIRST, and deliberately BEFORE the log cap. ───────────────
    // A job that has passed the cap is still running and still writing, and the
    // old code returned here — which is how a two-hour encode became
    // indistinguishable from a wedged one. These two fields are the answer to
    // "is it alive", and they keep counting when the log has stopped.
    entry.record.lastOutputAt = Date.now();
    entry.record.outputBytes = (entry.record.outputBytes ?? 0) + raw.length;

    // The recent end, bounded. Kept whole-string rather than by lines: a
    // progress bar that rewrites one line with \r has no newlines at all, and
    // slicing by line would keep nothing for exactly the job that needs it most.
    entry.tail = (entry.tail + raw).slice(-JOB_TAIL_MAX_BYTES);

    // ── THE LOG, unchanged: head-keeping, capped, stops for good. ──────────
    if (!entry.record.truncated) {
      let text = raw;
      const room = maxLogBytes - entry.written;
      if (room <= 0) {
        entry.record.truncated = true;
      } else {
        if (text.length > room) {
          text = `${text.slice(0, room)}\n\n[naby] output truncated at ${maxLogBytes} bytes.\n`;
          entry.record.truncated = true;
        }
        entry.written += text.length;
        try {
          appendFileSync(logPath, text, 'utf8');
        } catch {
          // A log that cannot be written must not kill the job it is observing.
        }
      }
    }

    // ── THE PROGRESS EDGE, rate-limited. ──────────────────────────────────
    // Rides this event; adds no timer. The record is rewritten on the same beat
    // so a reader that only has the file — another process, or this one after a
    // restart — sees the same liveness the sink was told about.
    const now = entry.record.lastOutputAt;
    if (now - entry.lastProgressAt < JOB_PROGRESS_MIN_GAP_MS) return;
    entry.lastProgressAt = now;
    writeRecord(dir, entry.record);
    if (!input.sink?.onProgress) return;
    try {
      input.sink.onProgress({ ...entry.record }, entry.tail);
    } catch (e) {
      // Same rule as `notifyFinished`: observing must not break the observed.
      console.warn(
        `[jobs] the job sink threw on progress for ${entry.record.id}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);

  // THE CEILING, not a poll. One timer per job, cleared the moment the job ends;
  // it never fires for a job that finished, and there is no timer at all when no
  // job is running.
  const maxRuntimeMs = input.maxRuntimeMs ?? JOB_MAX_RUNTIME_MS;
  entry.ceiling = setTimeout(() => {
    if (entry.settled) return;
    entry.record.note = `killed after the ${maxRuntimeMs}ms background-job ceiling`;
    entry.kill('SIGKILL');
  }, maxRuntimeMs);
  // A pending ceiling must not, by itself, hold the process open — the CHILD is
  // what keeps the event loop alive, and when the child is gone the timer has
  // nothing left to protect.
  entry.ceiling.unref?.();

  const settle = (status: JobStatus, extra: Partial<JobRecord>): void => {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.ceiling) clearTimeout(entry.ceiling);
    entry.ceiling = undefined;
    entry.record = { ...entry.record, ...extra, status, endedAt: Date.now() };
    live.delete(id);
    writeRecord(dir, entry.record);
    try {
      appendFileSync(
        logPath,
        `\n[naby] job ${status}${
          extra.exitCode !== undefined ? ` (exit ${extra.exitCode})` : ''
        } at ${new Date(entry.record.endedAt ?? Date.now()).toISOString()}\n`,
        'utf8',
      );
    } catch {
      /* the record is the contract; the footer is a courtesy */
    }
    notifyFinished(input.sink, entry.record);
  };

  child.on('error', (e) => {
    settle('failed', { note: `could not run the command: ${e.message}` });
  });
  child.on('close', (code, signal) => {
    settle(statusFromExit(code, signal), {
      ...(typeof code === 'number' ? { exitCode: code } : {}),
      ...(signal ? { signal: String(signal) } : {}),
    });
  });

  return { ok: true, job: { ...record } };
}

/**
 * Hand a finished job to the sink, exactly once, and never let it break
 * anything. Separated out (and exported) so the "no sink is fine" rule is a
 * function with a name rather than an `if` somebody could drop.
 */
export function notifyFinished(sink: JobSink | undefined, job: JobRecord): void {
  if (!sink) return;
  try {
    sink.onFinished({ ...job });
  } catch (e) {
    console.warn(
      `[jobs] the job sink threw for ${job.id}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Asking about one
// ---------------------------------------------------------------------------

/** The current answer for a job id, live registry first and disk second. */
export function getJob(id: string): JobRecord | undefined {
  if (!isJobId(id)) return undefined;
  const dir = jobsDir();
  const stored = dir ? readRecord(dir, id) : undefined;
  return resolveJobRecord(live.get(id)?.record, stored);
}

/**
 * Every job this naby home knows about, newest first.
 *
 * Reads the directory rather than the registry so a restart still lists what ran
 * — with the restart rule applied to each, so nothing claims to be running that
 * this process is not watching.
 */
export function listJobs(limit = 20): JobRecord[] {
  const dir = jobsDir();
  const out = new Map<string, JobRecord>();
  for (const j of live.values()) out.set(j.record.id, { ...j.record });
  if (dir) {
    try {
      for (const name of readdirSync(dir)) {
        const m = /^(job-[A-Za-z0-9-]+)\.json$/.exec(name);
        if (!m || out.has(m[1]!)) continue;
        const resolved = resolveJobRecord(undefined, readRecord(dir, m[1]!));
        if (resolved) out.set(resolved.id, resolved);
      }
    } catch {
      /* no directory yet */
    }
  }
  return [...out.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
}

/** Stop a running job. Answers whether there was one to stop. Exported rather
 *  than surfaced as a tool: the model's job is to start work and report on it,
 *  and a "stop" it can call on its own is a way for it to abandon work the user
 *  asked for. */
export function killJob(id: string, signal: NodeJS.Signals = 'SIGKILL'): boolean {
  const entry = live.get(id);
  if (!entry) return false;
  entry.record.note = entry.record.note ?? 'stopped by naby';
  entry.kill(signal);
  return true;
}

/**
 * The TAIL of a job's output.
 *
 * The tail and not the head, because the question a reader has is "how did it
 * end". The head is still on disk for anyone who wants it, and the return says
 * how much was skipped so the number is never mistaken for the whole log.
 *
 * Reads only the bytes it returns: a 1MB log is never loaded to show 8k of it.
 */
export function readJobOutput(
  id: string,
  maxChars: number = JOB_OUTPUT_DEFAULT_CHARS,
): { text: string; skippedBytes: number; totalBytes: number } | undefined {
  if (!isJobId(id)) return undefined;
  const dir = jobsDir();
  if (!dir) return undefined;
  const path = logPathFor(dir, id);
  if (!existsSync(path)) return undefined;
  const want = Math.min(JOB_OUTPUT_MAX_CHARS, Math.max(200, Math.floor(maxChars)));

  // A RUNNING JOB PAST THE LOG CAP IS READ FROM THE TAIL, NOT THE FILE.
  //
  // The file keeps the head and stops (see `JOB_LOG_MAX_BYTES`), which is right
  // for a post-mortem and wrong for "how far along is it". Once a chatty job has
  // passed the cap, tailing the file returns bytes from its first minutes — and
  // returns them again on every call, so the model asking twice sees no change
  // and reasonably concludes the job is stuck. The in-memory tail is the only
  // thing that answers the question that was actually asked.
  const running = live.get(id);
  if (running && running.record.truncated && running.tail) {
    const text = running.tail.slice(-want);
    return {
      text,
      skippedBytes: Math.max(0, (running.record.outputBytes ?? text.length) - text.length),
      totalBytes: running.record.outputBytes ?? text.length,
    };
  }
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - want);
    const length = size - start;
    const buf = Buffer.alloc(length);
    fd = openSync(path, 'r');
    readSync(fd, buf, 0, length, start);
    return { text: buf.toString('utf8'), skippedBytes: start, totalBytes: size };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
  }
}
