// src/spikes/spike-jobs.ts
//
// SPIKE-JOBS — background work that outlives the turn that started it.
//
// WHAT THIS IS FOR. "배포하고 끝나면 알려줘" used to end in silence: the model
// promised a follow-up it had no mechanism to deliver. `src/runtime/jobs.ts` is
// that mechanism, and five of its properties are load-bearing enough that a
// regression would be worse than not having shipped it:
//
//   (a) STARTING RETURNS AT ONCE and the work keeps going. If the call waits,
//       the turn waits, and we are back to a timeout.
//   (b) THE ENDING IS DELIVERED EXACTLY ONCE. Twice is two follow-up turns for
//       one deploy; zero is the original bug.
//   (c) THE STATUS IS THE TRUTH — succeeded, failed and killed are three
//       different things, and a killed process must never read as exit 0.
//   (d) THE LOG IS BOUNDED, and says when it was cut.
//   (e) NO SINK IS SAFE. A spike or a headless runtime runs jobs and tells
//       nobody, rather than crashing.
//
// Plus the LAYER the tools belong to, which is the thing this spike now pins
// hardest. The job tools are `naby_*` tools in `buildToolset` — the naby layer,
// attached to EVERY engine — and they are NOT in `buildWorkspaceTools`, the
// replacement kit that is deliberately withheld from the Claude Agent SDK
// engine. While backgrounding was a `run_command` flag, dev-claude had no
// background jobs at all, which is the regression these checks exist to catch.
//
// Plus the classification facts the trust meter and the gate floor depend on:
// `naby_check_job` / `naby_read_job_output` are OBSERVATIONS and `naby_start_job`
// is not — under the fail-closed default an unlisted tool would score as an
// unsupervised consequential act and a refusal of it would raise a tripwire.
//
// IT WRITES INTO A TEMP HOME. `NABY_HOME` is pointed at a temp directory before
// anything is imported that could resolve it, so the user's real `~/.naby` is
// never touched.
//
// Run: npm run spike:jobs

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpRoot = mkdtempSync(join(tmpdir(), 'naby-jobs-'));
process.env.NABY_HOME = tmpRoot;
delete process.env.NABY_DB_PATH;

const {
  startJob,
  getJob,
  killJob,
  listJobs,
  readJobOutput,
  resolveJobRecord,
  statusFromExit,
  isJobId,
  jobsDir,
  resetJobRegistry,
  listJobRecords,
  markLostJobs,
  JOB_TAIL_MAX_BYTES,
  JOB_PROGRESS_MIN_GAP_MS,
} = await import('../runtime/jobs.js');
type JobRecord = import('../runtime/jobs.js').JobRecord;
const { buildWorkspaceTools, READONLY_TOOLS, MUTATING_TOOLS } = await import('../runtime/fs-tools.js');
const { buildToolset, Outbox } = await import('../runtime/tools.js');
const {
  START_JOB_TOOL_NAME,
  CHECK_JOB_TOOL_NAME,
  READ_JOB_OUTPUT_TOOL_NAME,
  JOB_OBSERVATION_TOOLS,
  JOB_EXECUTION_TOOLS,
} = await import('../runtime/job-tools.js');
const { isConsequentialTool, classifyToolConsequence } = await import('../runtime/checkin.js');
const { phase1HarnessFloor } = await import('../runtime/gate.js');
const { realPolicy, backgroundBashRefusal } = await import('../runtime/policy.js');
const { BUILTIN_PERSONA_SEED } = await import('../runtime/agents.js');
type Executor = import('../runtime/engine.js').Executor;
type ToolOutput = import('../runtime/engine.js').ToolOutput;

type Check = { name: string; pass: boolean; evidence: string };

function record(checks: Check[], name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

const ctx = () => ({
  toolCall: { toolCallId: 'c1', toolName: 't', input: {} },
  signal: new AbortController().signal,
});

const call = (exec: Executor, input: unknown): Promise<ToolOutput> => exec(input, ctx());

/** Wait until a job leaves `running`, or give up. Used only where there is no
 *  sink to wait on — the sink path is what production uses and is asserted
 *  directly. */
async function waitForEnd(id: string, deadlineMs = 15_000): Promise<JobRecord | undefined> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const job = getJob(id);
    if (job && job.status !== 'running') return job;
    if (Date.now() > until) return job;
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function main(): Promise<boolean> {
  const checks: Check[] = [];
  const cwd = tmpRoot;

  // ---- (a) starting returns at once, and the work continues ---------------
  const finishes: JobRecord[] = [];
  const sink = { onFinished: (job: JobRecord) => void finishes.push(job) };
  const t0 = Date.now();
  const started = startJob({ command: 'sleep 1; echo finished-late', cwd, sink, sessionId: 'sess-1' });
  const startElapsed = Date.now() - t0;
  record(
    checks,
    '(a1) starting a background job returns immediately, before the work is done',
    started.ok && startElapsed < 500,
    `ok=${started.ok} elapsed=${startElapsed}ms`,
  );
  if (!started.ok) {
    console.error(`cannot continue: ${started.error}`);
    return false;
  }
  const id = started.job.id;
  record(
    checks,
    '(a2) the job is running right after the call returned, and nothing was delivered yet',
    getJob(id)?.status === 'running' && finishes.length === 0,
    `status=${getJob(id)?.status} deliveries=${finishes.length}`,
  );

  // ---- (b) + (c) the ending is delivered once, and says "succeeded" -------
  const done = await waitForEnd(id);
  // Give the sink a beat beyond the state change to prove it does not fire twice.
  await new Promise((r) => setTimeout(r, 200));
  record(
    checks,
    '(b) the sink was called EXACTLY once, with the finished job',
    finishes.length === 1 && finishes[0]?.id === id && finishes[0]?.status === 'succeeded',
    `deliveries=${finishes.length} status=${finishes[0]?.status} session=${finishes[0]?.sessionId}`,
  );
  record(
    checks,
    '(c1) a command that exits 0 is `succeeded`, with its exit code recorded',
    done?.status === 'succeeded' && done.exitCode === 0 && typeof done.endedAt === 'number',
    `status=${done?.status} exit=${done?.exitCode}`,
  );
  const out = readJobOutput(id);
  record(
    checks,
    '(c2) the output written after the tool call returned is in the log',
    (out?.text ?? '').includes('finished-late'),
    (out?.text ?? '').replace(/\n/g, ' ').slice(-70),
  );

  // ---- (c) failure --------------------------------------------------------
  const failedStart = startJob({ command: 'echo boom >&2; exit 3', cwd, sink });
  const failed = failedStart.ok ? await waitForEnd(failedStart.job.id) : undefined;
  record(
    checks,
    '(c3) a non-zero exit is `failed`, not `succeeded`',
    failed?.status === 'failed' && failed.exitCode === 3,
    `status=${failed?.status} exit=${failed?.exitCode}`,
  );

  // ---- (c) killed ---------------------------------------------------------
  const longStart = startJob({ command: 'sleep 30', cwd, sink });
  const killedOk = longStart.ok ? killJob(longStart.job.id) : false;
  const killed = longStart.ok ? await waitForEnd(longStart.job.id) : undefined;
  record(
    checks,
    '(c4) a killed job is `killed` — a signal never reads as exit 0',
    killedOk && killed?.status === 'killed' && killed.exitCode === undefined,
    `killed=${killedOk} status=${killed?.status} signal=${killed?.signal} exit=${killed?.exitCode}`,
  );
  record(
    checks,
    '(c5) statusFromExit is the one rule: signal wins over a null code',
    statusFromExit(null, 'SIGKILL') === 'killed' &&
      statusFromExit(0, null) === 'succeeded' &&
      statusFromExit(1, null) === 'failed',
    `${statusFromExit(null, 'SIGKILL')}/${statusFromExit(0, null)}/${statusFromExit(1, null)}`,
  );

  // ---- (d) the log is bounded and says so ---------------------------------
  const noisy = startJob({
    command: 'for i in $(seq 1 4000); do echo "line $i padding padding padding padding"; done',
    cwd,
    sink,
    maxLogBytes: 4_000,
  });
  const noisyDone = noisy.ok ? await waitForEnd(noisy.ok ? noisy.job.id : '') : undefined;
  const noisySize = noisy.ok ? statSync(join(jobsDir()!, `${noisy.job.id}.log`)).size : 0;
  record(
    checks,
    '(d) the log stops at its cap and the record is stamped truncated',
    noisyDone?.truncated === true && noisySize < 4_000 + 500,
    `truncated=${noisyDone?.truncated} bytes=${noisySize} cap=4000`,
  );

  // ---- (e) no sink is safe ------------------------------------------------
  const sinkless = startJob({ command: 'echo quiet', cwd });
  const sinklessDone = sinkless.ok ? await waitForEnd(sinkless.job.id) : undefined;
  record(
    checks,
    '(e) a job with NO sink runs, records its outcome, and tells nobody',
    sinkless.ok && sinklessDone?.status === 'succeeded',
    `ok=${sinkless.ok} status=${sinklessDone?.status}`,
  );

  // ---- restart honesty ----------------------------------------------------
  const stored: JobRecord = {
    id: 'job-deadbeef',
    command: 'npm run deploy',
    cwd,
    status: 'running',
    startedAt: Date.now() - 60_000,
  };
  const afterRestart = resolveJobRecord(undefined, stored);
  record(
    checks,
    '(f1) a job whose owning process is gone reports `lost`, never `running`',
    afterRestart?.status === 'lost' && (afterRestart.note ?? '').includes('never recorded'),
    `status=${afterRestart?.status}`,
  );
  const terminalStored: JobRecord = { ...stored, status: 'succeeded', endedAt: Date.now() };
  record(
    checks,
    '(f2) a recorded ending survives the restart unchanged',
    resolveJobRecord(undefined, terminalStored)?.status === 'succeeded' &&
      resolveJobRecord(undefined, undefined) === undefined,
    `stored=${resolveJobRecord(undefined, terminalStored)?.status} absent=${String(
      resolveJobRecord(undefined, undefined),
    )}`,
  );
  // The registry is in this process; forgetting it is what a restart does.
  const liveBefore = getJob(id)?.status;
  resetJobRegistry();
  record(
    checks,
    '(f3) after the registry is cleared, a FINISHED job still answers from disk',
    liveBefore === 'succeeded' && getJob(id)?.status === 'succeeded',
    `before=${liveBefore} after=${getJob(id)?.status}`,
  );

  // ---- the id can never become a path -------------------------------------
  record(
    checks,
    '(g) a job id is shape-checked, so `../../etc/passwd` never reaches the filesystem',
    !isJobId('../../etc/passwd') && !isJobId('job-../x') && isJobId('job-1a2b3c4d'),
    `traversal=${isJobId('../../etc/passwd')} valid=${isJobId('job-1a2b3c4d')}`,
  );

  // ---- the tools, and WHICH LAYER they are in -----------------------------
  //
  // This is the point of the move. `buildToolset` is the naby layer and reaches
  // every engine; `buildWorkspaceTools` is the replacement kit for engines with
  // no tools of their own, and dev-claude never receives it.
  const naby = buildToolset(new Outbox(), undefined, undefined, undefined, undefined, {
    cwd,
    sink,
    sessionId: 'sess-2',
  });
  const nabyNames = naby.toolSchemas.map((s) => s.name);
  const ro = buildWorkspaceTools({ cwd, allowMutations: false });
  const full = buildWorkspaceTools({ cwd, allowMutations: true });
  const roNames = ro.toolSchemas.map((s) => s.name);
  const fullNames = full.toolSchemas.map((s) => s.name);

  record(
    checks,
    '(h1) the three job tools are in the NABY-LAYER toolset, under naby_* names',
    nabyNames.includes(START_JOB_TOOL_NAME) &&
      nabyNames.includes(CHECK_JOB_TOOL_NAME) &&
      nabyNames.includes(READ_JOB_OUTPUT_TOOL_NAME) &&
      [START_JOB_TOOL_NAME, CHECK_JOB_TOOL_NAME, READ_JOB_OUTPUT_TOOL_NAME].every((n) =>
        n.startsWith('naby_'),
      ),
    nabyNames.join(','),
  );
  record(
    checks,
    '(h2) NO job tool is in the workspace toolset — the kit dev-claude never gets',
    ![...roNames, ...fullNames].some((n) => n.includes('job')),
    `readonly=[${roNames.join(',')}] full=[${fullNames.join(',')}]`,
  );
  record(
    checks,
    '(h3) with no jobs options the naby layer offers no job tools at all (no cwd, no job)',
    !buildToolset(new Outbox()).toolSchemas.some((s) => s.name.includes('job')),
    buildToolset(new Outbox())
      .toolSchemas.map((s) => s.name)
      .join(','),
  );

  // THE OTHER HALF OF "ONE STARTER". A `background` parameter on run_command
  // would give an ai-sdk turn two ways to start a job, one of which reports and
  // one of which does not — the original bug, as a coin flip.
  const runCommand = full.toolSchemas.find((s) => s.name === 'run_command');
  const runCommandProps = Object.keys(
    (runCommand?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties ??
      {},
  );
  record(
    checks,
    '(h4) run_command is purely synchronous again: no `background` in its schema',
    runCommand !== undefined &&
      runCommandProps.length > 0 &&
      !runCommandProps.includes('background') &&
      // The whole parameter object, not just the key list: an enum or a nested
      // property that smuggled the flag back in would fail here too. (The
      // DESCRIPTION still says the word — it tells the model to start long work
      // as a job instead, which is the point.)
      !JSON.stringify(runCommand.parameters).includes('background'),
    `run_command params = ${runCommandProps.join(',')}`,
  );

  // THE dev-claude PATH, asserted where it is actually decided. The Agent SDK
  // engine turns `input.toolSchemas` — the list the shell assembles from
  // buildToolset — into its in-process MCP server, so a naby-layer tool arrives
  // as `mcp__nabytools__<name>`. Nothing filters that list by engine.
  const sdkEngineSource = readFileSync(
    new URL('../engines/claude-agent-sdk-engine.ts', import.meta.url),
    'utf8',
  );
  record(
    checks,
    '(h5) the Agent SDK engine exposes every runtime schema as an MCP tool, so dev-claude gets these',
    /const sdkTools = input\.toolSchemas\.map\(/.test(sdkEngineSource) &&
      /createSdkMcpServer\(\{[\s\S]{0,200}tools: sdkTools/.test(sdkEngineSource) &&
      /const MCP_SERVER_NAME = 'nabytools'/.test(sdkEngineSource),
    'claude-agent-sdk-engine.ts: toolSchemas -> sdkTools -> createSdkMcpServer(nabytools)',
  );

  const bgResult = await call(naby.executors[START_JOB_TOOL_NAME]!, {
    command: 'sleep 0.4; echo via-tool',
  });
  const bgId = (bgResult.data as { jobId?: string } | undefined)?.jobId ?? '';
  record(
    checks,
    '(h6) naby_start_job answers with a job id, not with a result',
    bgResult.isError !== true && isJobId(bgId) && !bgResult.content.includes('exit 0'),
    bgResult.content.replace(/\n/g, ' ').slice(0, 100),
  );

  const checking = await call(naby.executors[CHECK_JOB_TOOL_NAME]!, { jobId: bgId });
  record(
    checks,
    '(h7) naby_check_job reports it as still running, and says not to report a result yet',
    checking.content.includes('running') && checking.content.includes('Do not report'),
    checking.content.replace(/\n/g, ' ').slice(0, 100),
  );

  const bgDone = await waitForEnd(bgId);
  const reading = await call(naby.executors[READ_JOB_OUTPUT_TOOL_NAME]!, { jobId: bgId });
  record(
    checks,
    '(h8) naby_read_job_output returns the tail of the finished job',
    bgDone?.status === 'succeeded' && reading.content.includes('via-tool'),
    reading.content.replace(/\n/g, ' ').slice(-70),
  );

  const badId = await call(naby.executors[CHECK_JOB_TOOL_NAME]!, { jobId: 'not-a-job' });
  record(
    checks,
    '(h9) a malformed job id is refused as a tool error, not a filesystem read',
    badId.isError === true,
    badId.content.slice(0, 70),
  );

  const listed = await call(naby.executors[CHECK_JOB_TOOL_NAME]!, {});
  record(
    checks,
    '(h10) naby_check_job with no id lists the recent jobs',
    listed.isError !== true && listJobs().length >= 5 && listed.content.includes('job-'),
    `${listJobs().length} jobs on disk`,
  );

  // A start tool built WITHOUT a sink must not let the model promise a report.
  const noSinkLayer = buildToolset(new Outbox(), undefined, undefined, undefined, undefined, {
    cwd,
  });
  const quiet = await call(noSinkLayer.executors[START_JOB_TOOL_NAME]!, { command: 'echo lonely' });
  record(
    checks,
    '(h11) with no sink the start tool says nobody will be woken, rather than promising a follow-up',
    quiet.isError !== true &&
      quiet.content.includes('Nothing will wake you') &&
      !quiet.content.includes('You will be given a new turn'),
    quiet.content.replace(/\n/g, ' ').slice(0, 120),
  );

  // ---- classification -----------------------------------------------------
  record(
    checks,
    '(i1) the job observers classify as OBSERVATION, and starting a job is consequential',
    classifyToolConsequence(CHECK_JOB_TOOL_NAME) === 'observation' &&
      classifyToolConsequence(READ_JOB_OUTPUT_TOOL_NAME) === 'observation' &&
      isConsequentialTool(START_JOB_TOOL_NAME),
    `${CHECK_JOB_TOOL_NAME}=${classifyToolConsequence(CHECK_JOB_TOOL_NAME)} ` +
      `${READ_JOB_OUTPUT_TOOL_NAME}=${classifyToolConsequence(READ_JOB_OUTPUT_TOOL_NAME)} ` +
      `${START_JOB_TOOL_NAME}=${classifyToolConsequence(START_JOB_TOOL_NAME)}`,
  );
  record(
    checks,
    '(i2) the job classification travelled WITH the tools — out of the workspace lists, into their own',
    JOB_OBSERVATION_TOOLS.includes(CHECK_JOB_TOOL_NAME) &&
      JOB_OBSERVATION_TOOLS.includes(READ_JOB_OUTPUT_TOOL_NAME) &&
      JOB_EXECUTION_TOOLS.includes(START_JOB_TOOL_NAME) &&
      !READONLY_TOOLS.some((n) => n.includes('job')) &&
      !MUTATING_TOOLS.some((n) => n.includes('job')),
    `observation=[${JOB_OBSERVATION_TOOLS.join(',')}] execution=[${JOB_EXECUTION_TOOLS.join(
      ',',
    )}] workspace-readonly=[${READONLY_TOOLS.join(',')}]`,
  );

  // The floor is what plan mode and "allow changes: off" run on. The naby layer
  // is attached to those turns too, so the floor — not tool absence — is what
  // stops a read-only turn from starting work.
  const floor = phase1HarnessFloor(nabyNames);
  const floorCheck = await floor({ toolCallId: 'x', toolName: CHECK_JOB_TOOL_NAME, input: {} });
  const floorRead = await floor({ toolCallId: 'x', toolName: READ_JOB_OUTPUT_TOOL_NAME, input: {} });
  const floorStart = await floor({ toolCallId: 'x', toolName: START_JOB_TOOL_NAME, input: {} });
  const floorRun = await floor({ toolCallId: 'x', toolName: 'run_command', input: {} });
  record(
    checks,
    '(i3) observation mode allows asking about a job and DENIES starting one',
    floorCheck.behavior === 'allow' &&
      floorRead.behavior === 'allow' &&
      floorStart.behavior === 'deny' &&
      floorRun.behavior === 'deny',
    `check=${floorCheck.behavior} read=${floorRead.behavior} start=${floorStart.behavior} run_command=${floorRun.behavior}`,
  );

  // ---- the persona is told which mechanism reports back -------------------
  record(
    checks,
    '(i4) the persona seed points at naby_start_job and warns off the engine\'s own background shell',
    BUILTIN_PERSONA_SEED.systemPrompt.includes(START_JOB_TOOL_NAME) &&
      BUILTIN_PERSONA_SEED.systemPrompt.includes(CHECK_JOB_TOOL_NAME) &&
      BUILTIN_PERSONA_SEED.systemPrompt.includes(READ_JOB_OUTPUT_TOOL_NAME) &&
      !BUILTIN_PERSONA_SEED.systemPrompt.includes('background: ') &&
      /cannot come back to you/.test(BUILTIN_PERSONA_SEED.systemPrompt),
    BUILTIN_PERSONA_SEED.systemPrompt
      .split('\n')
      .filter((l) => l.includes('naby_') || l.includes('background'))
      .join(' | ')
      .slice(0, 200),
  );

  // ---- a sink that throws must not take anything down ---------------------
  const angry = startJob({
    command: 'echo ok',
    cwd,
    sink: {
      onFinished: () => {
        throw new Error('the shell blew up');
      },
    },
  });
  const angryDone = angry.ok ? await waitForEnd(angry.job.id) : undefined;
  record(
    checks,
    '(j) a sink that throws is swallowed — the job still records its outcome',
    angryDone?.status === 'succeeded',
    `status=${angryDone?.status}`,
  );

  // ---- the record on disk is the contract ---------------------------------
  const onDisk = JSON.parse(readFileSync(join(jobsDir()!, `${id}.json`), 'utf8')) as JobRecord;
  record(
    checks,
    '(k) the record on disk carries the command, the session and the outcome',
    onDisk.status === 'succeeded' && onDisk.sessionId === 'sess-1' && onDisk.command.includes('sleep 1'),
    `${onDisk.id} ${onDisk.status} session=${onDisk.sessionId}`,
  );

  // ---- Liveness while it runs ---------------------------------------------
  //
  // THE FAILURE THIS PINS. A job past the log cap used to look identical to a
  // wedged one: `append` returned early, so nothing recorded that the child was
  // still writing, and the model's own `naby_read_job_output` kept returning the
  // same first-minutes bytes for hours.
  {
    const progress: { at: number; tail: string }[] = [];
    const chattyStart = startJob({
      // Writes far past the tiny cap below, in bursts, then exits.
      command: 'for i in $(seq 1 400); do echo "line $i"; done; sleep 0.2; echo FINAL_LINE',
      cwd: tmpRoot,
      maxLogBytes: 200,
      sink: {
        onFinished: () => {},
        onProgress: (_job, tail) => progress.push({ at: Date.now(), tail }),
      },
    });

    await new Promise((r) => setTimeout(r, 900));
    const chattyId = chattyStart.ok ? chattyStart.job.id : '';
    const after = chattyId ? getJob(chattyId) : undefined;

    record(
      checks,
      'a job past the log cap still reports that it is alive',
      after?.lastOutputAt !== undefined && (after?.outputBytes ?? 0) > 200,
      `truncated=${after?.truncated} outputBytes=${after?.outputBytes} lastOutputAt=${
        after?.lastOutputAt !== undefined ? 'set' : 'unset'
      }`,
    );

    // The head-keeping log is deliberately untouched by all of this.
    const logSize = statSync(join(jobsDir()!, `${chattyId}.log`)).size;
    record(
      checks,
      'the log still keeps the head and stops at the cap',
      logSize <= 400 && (after?.outputBytes ?? 0) > logSize,
      `log=${logSize}B outputBytes=${after?.outputBytes}B`,
    );

    // What the model gets asked for: the RECENT end, not the first minutes.
    const out = readJobOutput(chattyId, 2000);
    record(
      checks,
      'reading a finished chatty job returns something',
      out !== undefined && out.text.length > 0,
      `chars=${out?.text.length ?? 0}`,
    );

    record(
      checks,
      'the tail never exceeds its bound',
      progress.every((p) => p.tail.length <= JOB_TAIL_MAX_BYTES),
      `edges=${progress.length} maxTail=${Math.max(0, ...progress.map((p) => p.tail.length))}`,
    );

    // NOT A TIMER: with the gap at 5s a sub-second job emits at most one edge.
    record(
      checks,
      'progress is rate-limited rather than per-chunk',
      progress.length <= 2,
      `edges=${progress.length} over a ~0.9s job, gap=${JOB_PROGRESS_MIN_GAP_MS}ms`,
    );
  }

  // ---- What a restart leaves behind ---------------------------------------
  //
  // A record that still says `running` with nothing live behind it is a job this
  // process can never hear end. It must stop claiming to be watched.
  {
    // A job that is genuinely still running when the registry is forgotten —
    // which is exactly what an app restart looks like from the record's side.
    const survivor = startJob({ command: 'sleep 30', cwd: tmpRoot });
    const survivorId = survivor.ok ? survivor.job.id : '';
    const before = listJobRecords(200).length;
    resetJobRegistry();
    const lost = markLostJobs();
    record(
      checks,
      'the orphan is the one that was still running',
      lost.some((j) => j.id === survivorId),
      `settled=${lost.map((j) => j.id).join(',') || 'none'} expected=${survivorId}`,
    );
    record(
      checks,
      'records are listable without the in-process registry',
      listJobRecords(200).length === before,
      `records=${before} after forgetting the registry`,
    );
    record(
      checks,
      'a job orphaned by a restart is settled as lost, not left running',
      lost.length > 0 && lost.every((j) => j.status === 'lost' && j.note !== undefined),
      `settled=${lost.length}${lost.length ? ` first=${lost[0]!.id}` : ''}`,
    );
  }

  // ---- One way to background, not two -------------------------------------
  //
  // The coin flip this removes: `Bash` with `run_in_background` keeps running
  // but can never report, because its lifecycle stops with the turn.
  {
    const bashBg = { toolCallId: 't1', toolName: 'Bash', input: { command: 'sleep 99', run_in_background: true } };
    const bashFg = { toolCallId: 't2', toolName: 'Bash', input: { command: 'ls' } };

    const refused = backgroundBashRefusal(bashBg as never);
    record(
      checks,
      'backgrounding through Bash is refused',
      refused?.behavior === 'deny',
      `behavior=${refused?.behavior}`,
    );
    record(
      checks,
      'the refusal names naby_start_job, so the model has somewhere to go',
      (refused?.behavior === 'deny' ? refused.reason : '').includes('naby_start_job'),
      `reason=${(refused?.behavior === 'deny' ? refused.reason : '').slice(0, 60)}…`,
    );
    record(
      checks,
      'a foreground Bash is untouched',
      backgroundBashRefusal(bashFg as never) === undefined,
      'foreground Bash returns no refusal',
    );

    // AND NO RULE MAY GRANT IT. A user allow-rule for Bash is about running
    // commands, not about adopting a reporting path that cannot report.
    const permissive = realPolicy({
      rules: [{ toolPattern: 'Bash', effect: 'allow', scope: 'user' }] as never,
      fallback: () => ({ behavior: 'allow' }) as never,
    });
    const viaPolicy = await permissive(bashBg as never);
    record(
      checks,
      'an allow-rule for Bash still does not buy backgrounding',
      viaPolicy.behavior === 'deny',
      `behavior=${viaPolicy.behavior}`,
    );
    const fgViaPolicy = await permissive(bashFg as never);
    record(
      checks,
      'that same allow-rule still allows an ordinary command',
      fgViaPolicy.behavior === 'allow',
      `behavior=${fgViaPolicy.behavior}`,
    );
  }

  // ---- Report -------------------------------------------------------------
  console.log('\n=== SPIKE-JOBS — background work that outlives its turn ===\n');
  let allPass = true;
  for (const c of checks) {
    if (!c.pass) allPass = false;
    console.log(`[${c.pass ? 'PASS' : 'FAIL'}] ${c.name}`);
    console.log(`        evidence: ${c.evidence}`);
  }
  console.log(
    `\nSPIKE-JOBS: ${allPass ? 'ALL PASS' : 'FAILURES PRESENT'} (${
      checks.filter((c) => c.pass).length
    }/${checks.length})\n`,
  );
  return allPass;
}

try {
  const ok = await main();
  process.exit(ok ? 0 : 1);
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}
