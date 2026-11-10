// src/spikes/spike-memory-worker.ts
//
// specs/memory-worker.md §4 — the memory process, for real, with no model.
//
// What runs here is production code: the runtime's queue rules, the shell's
// supervisor, the BUILT worker entry (`shell/dist/memoryWorker.mjs`, forked as a
// real child process with its own SQLite connection to a temp database), the real
// review executor and the real store. The only fake is the model: the worker's
// descriptor names a key provider, so its call comes back to this process over
// IPC (memoryJobs.ts "WHERE A CALL RUNS"), and this process answers it — slowly.
//
// Asserted:
//   (a) R2/R5/R8 — the pure rules: coalescing, one job at a time, the backoff
//       schedule 1·2·4·8·16·30·30 min, what counts as a rate limit, the re-seed
//       selection, the restart/fallback decision.
//   (b) R1 — the entry resolves from the shell tree, forks, says ready, runs at
//       a lowered priority (R4), and its writes land in the app's database
//       through its OWN connection.
//   (c) §1 — while the worker reviews (and its model call is held 1.5 s), this
//       process's event loop stays free and its own writes never meet
//       SQLITE_BUSY (R3).
//   (d) R8 — the worker is SIGKILLed mid-call; the supervisor restarts it, the
//       new one re-seeds from the database and finishes the review.
//
// Run with a temp NABY_DB_PATH; prints PASS/FAIL per assertion; exits non-zero
// on any FAIL.

import { mkdtempSync, rmSync } from 'node:fs';
import { getPriority, tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP_DIR = mkdtempSync(join(tmpdir(), 'naby-spike-memory-worker-'));
process.env.NABY_DB_PATH = join(TMP_DIR, 'app.db');
process.env.NABY_HOME = TMP_DIR;
// This spike IS about the separate process.
delete process.env.NABY_MEMORY_WORKER;

import {
  decideMemoryWorkerRestart,
  deferMemoryJob,
  enqueueMemoryJob,
  isMemoryRateLimitError,
  memoryBackoffMs,
  pickNextMemoryJob,
  reseedMemoryJobs,
  MEMORY_WORKER_CRASH_LIMIT,
  type MemoryJob,
  type MemoryJobModel,
  type MemoryWriteRequest,
} from '../runtime-entry.js';
import { SqliteStore } from '../runtime/store/sqlite-store.js';
import {
  MemoryWorkSupervisor,
  resolveMemoryWorkerScript,
} from '../../shell/packages/feature/agent/src/server/lib/memoryWorker.js';
import type { MemoryWorkStore } from '../../shell/packages/feature/agent/src/server/lib/memoryJobs.js';
import type { MemoryCallReply } from '../../shell/packages/feature/agent/src/server/lib/memoryWorkerProtocol.js';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
function check(name: string, pass: boolean, evidence = ''): void {
  checks.push({ name, pass, evidence });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(20);
  }
  return cond();
}

// ---------------------------------------------------------------------------
// (a) the pure rules
// ---------------------------------------------------------------------------

function pureRules(): void {
  const job = (kind: string, over: Partial<MemoryJob> = {}): MemoryJob => ({
    kind,
    reason: 'turn',
    enqueuedAt: 1,
    attempts: 0,
    notBefore: 0,
    ...over,
  });
  const model: MemoryJobModel = { engineId: 'dev-claude', providerId: 'dev-claude' };

  let q = enqueueMemoryJob([], job('review', { sessionId: 'a', model }));
  q = enqueueMemoryJob(q, job('review', { sessionId: 'b', enqueuedAt: 5 }));
  check('(a) a second kick of one kind updates the waiting job', q.length === 1 && q[0]!.sessionId === 'b' && q[0]!.enqueuedAt === 1);

  const deferred = deferMemoryJob(job('review', { model }), 1000);
  q = enqueueMemoryJob([deferred], job('review', { model }));
  check('(a) a re-kick does not reset a backoff in force', q[0]!.notBefore === deferred.notBefore);

  const both = [job('tidy', { model }), job('review', { model, enqueuedAt: 9 })];
  check('(a) nothing starts while a job runs', pickNextMemoryJob(both, { now: 10, running: true }) === undefined);
  check('(a) the review goes before the tidy', pickNextMemoryJob(both, { now: 10, running: false })?.job.kind === 'review');
  check(
    '(a) a model-less review waits for a turn model',
    pickNextMemoryJob([job('review')], { now: 10, running: false }) === undefined &&
      pickNextMemoryJob([job('review')], { now: 10, running: false, fallbackModel: model }) !== undefined,
  );
  check(
    '(a) a rate-limit block holds every kind',
    pickNextMemoryJob(both, { now: 10, running: false, blockedUntil: 11 }) === undefined,
  );

  const minutes = [1, 2, 3, 4, 5, 6, 7].map((n) => memoryBackoffMs(n) / 60_000);
  check('(a) backoff 1·2·4·8·16·30·30 min', JSON.stringify(minutes) === JSON.stringify([1, 2, 4, 8, 16, 30, 30]), JSON.stringify(minutes));

  const limited = [
    Object.assign(new Error('x'), { status: 429 }),
    Object.assign(new Error('x'), { statusCode: 529 }),
    new Error('{"type":"error","error":{"type":"overloaded_error"}}'),
    new Error('Claude AI usage limit reached|1731234567'),
    new Error('rate_limit_error: Number of request tokens has exceeded your per-minute rate limit'),
  ];
  const notLimited = [new Error('401 Unauthorized'), new Error('timeout'), new Error('the answer was not JSON')];
  check(
    '(a) 429/529/overloaded/usage-limit read as rate limits, others do not',
    limited.every(isMemoryRateLimitError) && !notLimited.some(isMemoryRateLimitError),
  );

  const seeds = reseedMemoryJobs({ pendingReview: 2, toSummarize: 0, unreviewed: 7 }, 1);
  check('(a) re-seed queues exactly what is owed', JSON.stringify(seeds.map((j) => j.kind)) === '["review","tidy"]');

  let crashes: number[] = [];
  const actions: string[] = [];
  for (let i = 0; i < MEMORY_WORKER_CRASH_LIMIT; i += 1) {
    const d = decideMemoryWorkerRestart(crashes, 1_000 + i * 100);
    actions.push(d.action);
    crashes = d.recent;
  }
  check(
    '(a) a crash restarts; the fifth inside a minute falls back in-process',
    actions.slice(0, -1).every((a) => a === 'restart') && actions.at(-1) === 'fallback',
    actions.join(','),
  );
  check('(a) a crash after a quiet minute restarts again', decideMemoryWorkerRestart(crashes, 1_000_000).action === 'restart');
}

// ---------------------------------------------------------------------------
// (b)–(d) the real process
// ---------------------------------------------------------------------------

async function realProcess(): Promise<void> {
  const script = resolveMemoryWorkerScript();
  check('(b) the built entry resolves inside the shell tree', !!script && script.endsWith(join('shell', 'dist', 'memoryWorker.mjs')), String(script));
  if (!script) return;

  const store = new SqliteStore({ path: process.env.NABY_DB_PATH! });
  const pending = ['short answers', 'English commits'].map((v, i) =>
    store.putMemory({
      scope: 'user',
      scopeKey: 'local-user',
      type: 'semantic',
      key: `spike-pref-${i}`,
      value: `Prefers ${v}.`,
      provenance: { source: 'user', sessionId: 's-spike', evidenceQuote: v, basisKind: 'stated' },
      confidence: 0.5,
      requestedStatus: 'proposed',
      reviewState: 'pending',
    } as MemoryWriteRequest),
  );

  // The model: answered HERE, after 1.5 s. The first call is the one the worker
  // will be killed in the middle of; every later one confirms what it is shown.
  let calls = 0;
  let firstCallAt = 0;
  const answerCall = async (_t: unknown, prompt: { user: string }): Promise<MemoryCallReply> => {
    calls += 1;
    if (calls === 1) firstCallAt = Date.now();
    await sleep(1_500);
    const handles = [...prompt.user.matchAll(/^NEW (N\d+) /gm)].map((m) => m[1]);
    return {
      text: JSON.stringify({ reviews: handles.map((h) => ({ memory: h, supported: 'yes', relations: [] })) }),
      label: 'mock (spike)',
    };
  };
  const log: string[] = [];
  const supervisor = new MemoryWorkSupervisor({ answerCall, log: (l) => log.push(l) });

  // This process's event loop, measured the whole time.
  let maxLag = 0;
  let last = performance.now();
  const ticker = setInterval(() => {
    const now = performance.now();
    maxLag = Math.max(maxLag, now - last - 10);
    last = now;
  }, 10);
  // And this process's own writes, concurrently with the worker's.
  let busyErrors = 0;
  let writes = 0;
  const writer = setInterval(() => {
    try {
      store.setSetting('spike.app-write', String(writes++));
    } catch {
      busyErrors += 1;
    }
  }, 15);

  try {
    const model: MemoryJobModel = { engineId: 'ai-sdk', providerId: 'mock', model: 'mock-1' };
    const notice = { sessionId: 's-spike', model, store: store as unknown as MemoryWorkStore };
    const t0 = performance.now();
    supervisor.turnEnded({ ...notice, autoApply: true });
    const postMs = performance.now() - t0;
    check('(c) posting a turn notice is a message, not work', postMs < 20, `${postMs.toFixed(2)}ms`);

    const ready = await until(() => supervisor.currentMode() === 'worker' && supervisor.childPid() !== undefined, 15_000);
    check('(b) the memory process starts and says ready', ready, log.join(' | '));
    const pid1 = supervisor.childPid();
    if (pid1 !== undefined && process.platform !== 'win32') {
      const prio = getPriority(pid1);
      check('(b) R4: it runs below normal priority', prio >= 10, `nice ${prio}`);
    }

    // (d) Kill it in the middle of its first model call.
    const inCall = await until(() => calls >= 1, 10_000);
    check('(b) its review reaches the model port', inCall);
    const working = supervisor.status(store as unknown as MemoryWorkStore);
    check(
      '(b) status: working, on the review, sized, counts only',
      working.state === 'working' && working.current?.kind === 'review' && working.current.size === 2 &&
        !JSON.stringify(working).includes('Prefers'),
      JSON.stringify(working),
    );
    if (pid1 !== undefined) process.kill(pid1, 'SIGKILL');
    const restarted = await until(() => {
      const pid = supervisor.childPid();
      return pid !== undefined && pid !== pid1;
    }, 15_000);
    check('(d) a killed memory process is restarted', restarted, log.join(' | '));
    check(
      '(d) the restart is counted',
      (supervisor.status(store as unknown as MemoryWorkStore).restarts ?? 0) >= 1,
    );

    // The new process re-seeds from the database (the rows are still pending)
    // and runs on the latest turn's model, handed over in its hello.
    const settled = await until(
      () => pending.every((m) => store.getMemoryById(m.id)?.status === 'confirmed'),
      20_000,
    );
    check('(d) the re-seeded review finishes: both rows confirmed by the worker', settled);
    // The rows are written before the worker posts its status, so give the
    // "done" message a moment to cross the process boundary.
    await until(() => supervisor.status(store as unknown as MemoryWorkStore).lastDone !== undefined, 5_000);
    const status = supervisor.status(store as unknown as MemoryWorkStore);
    check(
      '(d) status after: a review done, calls counted, the model label',
      status.lastDone?.kind !== undefined && status.callsToday >= 2 && status.model === 'mock (spike)',
      JSON.stringify(status),
    );
    check('(c) a model call took 1.5 s while the app loop stayed free', firstCallAt > 0 && maxLag < 100, `max loop lag ${maxLag.toFixed(1)}ms`);
    check('(c) R3: the app\'s concurrent writes never met SQLITE_BUSY', busyErrors === 0 && writes > 20, `${writes} writes, ${busyErrors} errors`);
  } finally {
    clearInterval(ticker);
    clearInterval(writer);
    const pid = supervisor.childPid();
    supervisor.shutdown();
    if (pid !== undefined) {
      const gone = await until(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }, 5_000);
      check('(b) shutdown ends the memory process', gone);
    }
    store.close();
  }
}

async function main(): Promise<void> {
  try {
    pureRules();
    await realProcess();
  } catch (e) {
    check('spike ran to completion', false, e instanceof Error ? e.stack ?? e.message : String(e));
  }
  let failed = 0;
  for (const c of checks) {
    if (!c.pass) failed += 1;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.evidence ? `\n      ${c.evidence}` : ''}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  rmSync(TMP_DIR, { recursive: true, force: true });
  if (failed > 0) process.exitCode = 1;
}

void main();
