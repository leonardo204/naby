// src/runtime/job-tools.ts
//
// THE BACKGROUND-JOB TOOLS — naby layer, not workspace.
//
// WHY THEY LIVE HERE AND NOT IN `fs-tools.ts`.
//
// The runtime has two toolsets and they answer two different questions.
// `buildWorkspaceTools` is a REPLACEMENT KIT: read/glob/grep/write/edit/run for
// the engines that bring none of their own, and it is deliberately withheld from
// the Claude Agent SDK engine, which ships Read/Write/Bash and would otherwise be
// handed two tools for every job. `buildToolset` is the NABY LAYER: what this app
// is, on every engine, whichever provider is signed in.
//
// Backgrounding was first bolted onto `run_command` as a `background: true` flag,
// which put it in the replacement kit — and so `dev-claude` had no background jobs
// at all. That was a filing error, not a design: naby SPAWNS the process, naby
// HOLDS the handle, naby HEARS it exit and naby STARTS the follow-up turn that
// reports it (see `jobs.ts`). None of that is a stand-in for a missing provider
// capability; the SDK's own `Bash run_in_background` cannot do the last part at
// all, because its lifecycle events stop arriving the moment the query ends.
// A capability that only naby has belongs to the naby layer.
//
// ONE STARTER, NOT TWO. `run_command` no longer takes a `background` flag. Two
// ways to start a background job would mean that on the ai-sdk engines the model
// picks between them, and only one of the two ends in a report — which is the bug
// this whole feature exists to remove, reintroduced as a coin flip.
//
// WHAT IS STILL IN `jobs.ts`. Everything that actually runs: spawn, the log cap,
// the registry, the restart rule, the sink. This module is the TOOL SURFACE over
// that — schemas the model reads, executors the runtime calls after the gate.

import type { Executor, ToolOutput, ToolSchema } from './engine.js';
import {
  JOB_OUTPUT_DEFAULT_CHARS,
  JOB_OUTPUT_MAX_CHARS,
  describeJob,
  getJob,
  isJobId,
  listJobs,
  readJobOutput,
  startJob,
  type JobSink,
} from './jobs.js';

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------
//
// `naby_*`, like every other tool this layer owns (`naby_remember`,
// `naby_checkin`, `naby_add_mcp`, `naby_delegate`). The prefix is not decoration:
// on the Claude Agent SDK engine these are surfaced through our own in-process
// MCP server and the model sees `mcp__nabytools__naby_start_job`, right next to
// the SDK's own `Bash` — the name is how the model (and the user reading a policy
// rule) tells whose tool it is.

/** Start a command that outlives this turn. */
export const START_JOB_TOOL_NAME = 'naby_start_job';

/** Ask how a started job is going, or how it ended. */
export const CHECK_JOB_TOOL_NAME = 'naby_check_job';

/** Read the tail of a job's log. */
export const READ_JOB_OUTPUT_TOOL_NAME = 'naby_read_job_output';

/**
 * The job tools that only LOOK.
 *
 * Exported for `checkin.ts`, which is FAIL-CLOSED: a tool it has never heard of
 * is recorded as an unsupervised consequential act, and a gate refusal of one
 * becomes a safety tripwire. Unlisted, "did my deploy finish?" would count
 * against the agent that was being diligent about reporting back.
 *
 * They are also the reason the job tools are offered in read-only / plan mode at
 * all: a turn that may change nothing can still be the turn that reports on work
 * already started, and refusing that would make plan mode unable to answer a
 * question about the past.
 */
export const JOB_OBSERVATION_TOOLS: readonly string[] = [
  CHECK_JOB_TOOL_NAME,
  READ_JOB_OUTPUT_TOOL_NAME,
];

/**
 * The job tools that EXECUTE.
 *
 * Read by `checkin.ts` (this is an act worth measuring) and by
 * `phase1HarnessFloor` in `gate.ts` (observation mode must refuse it). Starting a
 * shell command in the background is running a shell command; that the caller
 * does not wait for it changes who hears the result, not what it may do.
 */
export const JOB_EXECUTION_TOOLS: readonly string[] = [START_JOB_TOOL_NAME];

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/**
 * What the job tools need from the composition root.
 *
 * Injected exactly like `McpProposalSink`, `MemoryLearningSink` and `CheckinSink`
 * — the runtime declares the seam, the shell fills it, and a spike or a headless
 * runtime supplies whatever it can.
 *
 * NO SINK IS A SUPPORTED CONFIGURATION: the job still runs, still records its
 * outcome and is still readable with `naby_check_job`. The only thing missing is
 * the follow-up turn, and the start tool SAYS SO in its result rather than
 * letting the model promise a report nobody will deliver.
 */
export interface JobToolOptions {
  /** Where a started job runs. Required: a job has to have a directory, and the
   *  runtime never guesses one from `process.cwd()`. */
  cwd: string;
  /** Where an ending goes. Absent = nobody is woken. */
  sink?: JobSink;
  /** The conversation a job belongs to, so the sink can report into it. */
  sessionId?: string;
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

function fail(message: string): ToolOutput {
  return { content: message, isError: true };
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
//
// Written for the MODEL, and they say WHEN to reach for the tool. The starter's
// description carries the one fact the model cannot work out for itself: this is
// the only mechanism by which it is ever given another turn.

export const startJobSchema: ToolSchema = {
  name: START_JOB_TOOL_NAME,
  description:
    'Start a shell command that keeps running after this conversation turn ends, and returns a job ' +
    'id immediately instead of a result. Use it for anything that takes longer than a minute — a ' +
    'build, a deploy, a full test run, a long download. This is the ONLY way you are given a new ' +
    'turn when the work finishes, and therefore the only way you can report the outcome to the user ' +
    'later; a background shell started by any other tool cannot come back to you. Follow up with ' +
    `${CHECK_JOB_TOOL_NAME} and ${READ_JOB_OUTPUT_TOOL_NAME}. For a quick command that you need the ` +
    'output of right now, use the ordinary command tool and wait for it.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command line to run in the background.' },
    },
    required: ['command'],
  },
};

export const checkJobSchema: ToolSchema = {
  name: CHECK_JOB_TOOL_NAME,
  description:
    `Report on a background job started with ${START_JOB_TOOL_NAME}: whether it is still running, ` +
    'and how it ended. Give a job id for one job, or omit it to list the recent ones. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      jobId: {
        type: 'string',
        description: `The job id ${START_JOB_TOOL_NAME} returned. Omit to list recent jobs.`,
      },
    },
    required: [],
  },
};

export const readJobOutputSchema: ToolSchema = {
  name: READ_JOB_OUTPUT_TOOL_NAME,
  description:
    "Read the END of a background job's output — the part that says how it went. Use it after " +
    `${CHECK_JOB_TOOL_NAME} says the job finished, and before you report to the user. Read-only.`,
  parameters: {
    type: 'object',
    properties: {
      jobId: { type: 'string', description: `The job id ${START_JOB_TOOL_NAME} returned.` },
      maxChars: {
        type: 'number',
        description: `How many characters from the end to return (default ${JOB_OUTPUT_DEFAULT_CHARS}, max ${JOB_OUTPUT_MAX_CHARS}).`,
      },
    },
    required: ['jobId'],
  },
};

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

/**
 * `naby_start_job` — spawn it, answer with an id, let the turn end.
 *
 * The one thing this must never do is wait. The tool result is an
 * ACKNOWLEDGEMENT, and it says so in the words the model will otherwise get
 * wrong: it started, that is not the same as it worked, and whether a follow-up
 * turn is coming depends on whether a sink was injected.
 *
 * The turn's abort signal is deliberately NOT wired to the child — stopping the
 * conversation must not kill a deploy the user asked for.
 */
export function makeStartJob(opts: JobToolOptions): Executor {
  return async (input): Promise<ToolOutput> => {
    const rec = asRecord(input);
    const command = typeof rec.command === 'string' ? rec.command.trim() : '';
    if (!command) return fail('A `command` is required.');

    const started = startJob({
      command,
      cwd: opts.cwd,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.sink ? { sink: opts.sink } : {}),
    });
    if (!started.ok) {
      return fail(
        `Could not start the background job: ${started.error}\n` +
          'Run the command in the foreground instead, or tell the user it could not be started.',
      );
    }
    const willReport = opts.sink !== undefined;
    return {
      content:
        `Started in the background as ${started.job.id}:\n$ ${started.job.command}\n\n` +
        'It is still running — this result says it STARTED, not that it worked. ' +
        (willReport
          ? 'You will be given a new turn the moment it finishes; report to the user then. ' +
            'Right now, tell them it is running and what you will check when it lands — do NOT ' +
            'claim it succeeded.'
          : 'Nothing will wake you when it ends here, so tell the user to ask you to check on it ' +
            'rather than promising to come back to them.') +
        ` Use ${CHECK_JOB_TOOL_NAME}("${started.job.id}") and ` +
        `${READ_JOB_OUTPUT_TOOL_NAME}("${started.job.id}") to see how it went.`,
      data: { jobId: started.job.id, command: started.job.command, status: 'running' },
    };
  };
}

/**
 * `naby_check_job` — how is it going, and how did it end.
 *
 * Takes no `cwd`: a job is addressed by id, and its record already carries the
 * directory it ran in. The id is shape-checked (`isJobId`) before any file is
 * touched, so a model-supplied string can never become a path segment.
 */
export function makeCheckJob(): Executor {
  return async (input): Promise<ToolOutput> => {
    const rec = asRecord(input);
    const raw = rec.jobId ?? rec.id;
    if (raw === undefined || raw === null || raw === '') {
      const all = listJobs();
      if (all.length === 0) {
        return { content: 'No background jobs have been started.', data: { jobs: [] } };
      }
      return {
        content: `Recent background jobs (${all.length}):\n\n${all
          .map((j) => describeJob(j))
          .join('\n\n')}`,
        data: { jobs: all },
      };
    }
    if (!isJobId(raw)) {
      return fail(`"${String(raw)}" is not a job id. Job ids look like "job-1a2b3c4d".`);
    }
    const job = getJob(raw);
    if (!job) {
      return fail(`No job ${raw} — it was never started, or its record has been removed.`);
    }
    const hint =
      job.status === 'running'
        ? '\n\nStill going. Do not report a result yet.'
        : job.status === 'lost'
          ? `\n\n${job.note ?? ''}\nSay exactly that to the user: the outcome is unrecorded, not successful.`
          : `\n\nFinished. Read the output with ${READ_JOB_OUTPUT_TOOL_NAME} before you report anything about it.`;
    return { content: `${describeJob(job)}${hint}`, data: { job } };
  };
}

/** `naby_read_job_output` — the tail of a job's log. */
export function makeReadJobOutput(): Executor {
  return async (input): Promise<ToolOutput> => {
    const rec = asRecord(input);
    const raw = rec.jobId ?? rec.id;
    if (!isJobId(raw)) {
      return fail(`"${String(raw ?? '')}" is not a job id. Job ids look like "job-1a2b3c4d".`);
    }
    const job = getJob(raw);
    const want = Number(rec.maxChars ?? JOB_OUTPUT_DEFAULT_CHARS);
    const out = readJobOutput(raw, Number.isFinite(want) ? want : JOB_OUTPUT_DEFAULT_CHARS);
    if (!out) {
      return fail(`No output for ${raw} — the job was never started, or its log is gone.`);
    }
    const head =
      out.skippedBytes > 0
        ? `(the last ${out.text.length} of ${out.totalBytes} characters; ${out.skippedBytes} earlier characters not shown)`
        : `(all ${out.totalBytes} characters)`;
    const status = job ? `${job.status}` : 'unknown';
    return {
      content: `${raw} — ${status} ${head}\n\n${out.text}`,
      data: {
        jobId: raw,
        status,
        chars: out.text.length,
        totalBytes: out.totalBytes,
        skippedBytes: out.skippedBytes,
      },
    };
  };
}

/**
 * The three job tools, as schemas plus executors.
 *
 * Assembled as a unit because they are one capability: a starter with no way to
 * ask how it went would make the model report from hope, and observers with no
 * starter would describe a mechanism this turn cannot use.
 */
export function buildJobTools(opts: JobToolOptions): {
  toolSchemas: ToolSchema[];
  executors: Record<string, Executor>;
} {
  return {
    toolSchemas: [startJobSchema, checkJobSchema, readJobOutputSchema],
    executors: {
      [START_JOB_TOOL_NAME]: makeStartJob(opts),
      [CHECK_JOB_TOOL_NAME]: makeCheckJob(),
      [READ_JOB_OUTPUT_TOOL_NAME]: makeReadJobOutput(),
    },
  };
}
