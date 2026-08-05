// src/spikes/spike-subagent.ts
//
// WHO DID THIS TOOL CALL? — the attribution that lets a delegated run have its
// own block in the transcript.
//
// THE BUG THIS IS ABOUT. When the model delegates (the Claude Agent SDK's `Task`
// tool), the subagent runs its own tools, and every one of those calls used to
// reach the UI indistinguishable from a call the main thread made — so a turn
// that ran four research agents showed ONE anonymous "133 tool calls" batch,
// with four interchangeable `system/task_started · agent=general-purpose` pills
// beside it. Nothing said which agent did what, or that four separate runs had
// happened.
//
// The fix rests on two claims about the SDK, and this spike pins both to the
// exported pure functions that read them, so neither can regress without a
// failure here (a live model call proves nothing that is not already in these
// message shapes):
//
//   (a) A TOOL CALL CARRIES ITS AUTHOR. The pre-execution hook input sets
//       `agent_id` (and `agent_type`) ONLY when the hook fires inside a
//       subagent — the SDK is explicit that this, not `agent_type`, is the field
//       that distinguishes a subagent call from a main-thread one, because a
//       session started with `--agent` sets the type on the main thread too.
//       `subagentAttribution` must therefore return null for a main-thread call
//       and for a type-only one, or a whole turn gets filed under a subagent
//       block that never existed.
//
//   (b) A RUN'S LIFECYCLE CARRIES ITS IDENTITY. `system/task_started` /
//       `_progress` / `_updated` / `_notification` are the edges of ONE run and
//       carry `task_id` — which, for a Task-tool subagent, is the same id its
//       tool calls are tagged with, since the SDK registers the task under the
//       agent's own id. Without that id on the event, four parallel agents are
//       four identical strings and the UI cannot draw four blocks.
//
// And one rule that outranks both: NO FREE TEXT ESCAPES. A task's description,
// summary and prompt are model-authored content from whatever project is open,
// and these values are rendered — so the mapping may echo ids, enums and short
// label-shaped type names, and nothing else.
//
// NO NETWORK, NO KEYS, NO SDK PROCESS. Pure functions only. Prints PASS/FAIL per
// assertion; exits non-zero on any FAIL.

import {
  describeHarnessMessage,
  subagentAttribution,
} from '../engines/claude-agent-sdk-engine.js';

type Check = { name: string; pass: boolean; evidence: string };

const checks: Check[] = [];
function record(name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

// The literal message shapes the SDK documents (sdk.d.ts: SDKTaskStartedMessage,
// SDKTaskProgressMessage, SDKTaskUpdatedMessage, SDKTaskNotificationMessage).
const SECRET = 'PROJECT SECRET: do not render me';

const taskStarted = {
  type: 'system',
  subtype: 'task_started',
  task_id: 'agent-7f3a',
  tool_use_id: 'toolu_01Task',
  description: SECRET,
  prompt: SECRET,
  subagent_type: 'general-purpose',
  task_type: 'local_agent',
};

const taskProgress = {
  type: 'system',
  subtype: 'task_progress',
  task_id: 'agent-7f3a',
  description: SECRET,
  subagent_type: 'general-purpose',
  usage: { total_tokens: 120, tool_uses: 3, duration_ms: 900 },
  last_tool_name: 'Grep',
};

const taskNotification = {
  type: 'system',
  subtype: 'task_notification',
  task_id: 'agent-7f3a',
  tool_use_id: 'toolu_01Task',
  status: 'completed',
  summary: SECRET,
  output_file: '/tmp/agent-7f3a.md',
};

const taskUpdatedRunning = {
  type: 'system',
  subtype: 'task_updated',
  task_id: 'agent-7f3a',
  patch: { description: SECRET, is_backgrounded: true },
};

const taskUpdatedFailed = {
  type: 'system',
  subtype: 'task_updated',
  task_id: 'agent-7f3a',
  patch: { status: 'failed', error: SECRET },
};

// ---------------------------------------------------------------------------
// (b) lifecycle → identity
// ---------------------------------------------------------------------------

const started = describeHarnessMessage(taskStarted);
record(
  '(b1) task_started carries the run id, its agent type and the call that spawned it',
  started?.task?.id === 'agent-7f3a' &&
    started.task.phase === 'started' &&
    started.task.agentType === 'general-purpose' &&
    started.task.toolCallId === 'toolu_01Task',
  JSON.stringify(started),
);

const progress = describeHarnessMessage(taskProgress);
record(
  '(b2) task_progress is a heartbeat — same id, phase progress (never an ending)',
  progress?.task?.id === 'agent-7f3a' && progress.task.phase === 'progress',
  JSON.stringify(progress?.task),
);

const ended = describeHarnessMessage(taskNotification);
record(
  '(b3) task_notification ends the run and says how',
  ended?.task?.id === 'agent-7f3a' &&
    ended.task.phase === 'ended' &&
    ended.task.status === 'completed',
  JSON.stringify(ended?.task),
);

const patchedRunning = describeHarnessMessage(taskUpdatedRunning);
record(
  '(b4) a task_updated with no terminal status does NOT close the block',
  patchedRunning?.task?.phase === 'progress' && patchedRunning.task.status === undefined,
  JSON.stringify(patchedRunning?.task),
);

const patchedFailed = describeHarnessMessage(taskUpdatedFailed);
record(
  '(b5) a task_updated that reports a terminal status does close it',
  patchedFailed?.task?.phase === 'ended' && patchedFailed.task.status === 'failed',
  JSON.stringify(patchedFailed?.task),
);

// Four parallel agents of the SAME type must remain four distinguishable runs —
// this is precisely what a label-only pill could not express.
const parallel = ['agent-1', 'agent-2', 'agent-3', 'agent-4'].map((id) =>
  describeHarnessMessage({ ...taskStarted, task_id: id }),
);
const parallelIds = new Set(parallel.map((d) => d?.task?.id));
record(
  '(b6) four concurrent runs of one agent type stay four distinct ids',
  parallelIds.size === 4 && !parallelIds.has(undefined),
  [...parallelIds].join(','),
);

// A malformed / absent id is DROPPED rather than sanitized: a mangled id would
// silently merge two runs, which is worse than having no block at all.
const noId = describeHarnessMessage({ ...taskStarted, task_id: undefined });
const badId = describeHarnessMessage({ ...taskStarted, task_id: 'has spaces and / slashes' });
record(
  '(b7) an absent or malformed task id yields no task descriptor (pill still renders)',
  noId?.task === undefined &&
    badId?.task === undefined &&
    noId?.subtype === 'system/task_started' &&
    badId?.subtype === 'system/task_started',
  `noId=${JSON.stringify(noId)} badId=${JSON.stringify(badId)}`,
);

// The old pill text is unchanged, so a consumer that never learned about `task`
// renders exactly what it did before.
// A notification carries no `subagent_type` (the SDK's type does not have one),
// which is exactly why the block must keep the type it learned when the run
// STARTED rather than re-deriving it from the closing edge.
record(
  '(b8) the pill label and detail are unchanged (backward compatible)',
  started?.subtype === 'system/task_started' &&
    started.detail === 'agent=general-purpose' &&
    ended?.subtype === 'system/task_notification' &&
    ended.detail === 'status=completed' &&
    ended.task?.agentType === undefined,
  `${started?.subtype}/${started?.detail} | ${ended?.subtype}/${ended?.detail}`,
);

// THE RULE THAT OUTRANKS THE REST.
const leaked = [started, progress, ended, patchedRunning, patchedFailed]
  .map((d) => JSON.stringify(d))
  .filter((s) => s.includes('SECRET') || s.includes('output_file') || s.includes('/tmp/'));
record(
  '(b9) no model-authored free text (description / summary / prompt) is echoed',
  leaked.length === 0,
  leaked.length === 0 ? 'clean' : leaked.join(' | '),
);

// ---------------------------------------------------------------------------
// (a) tool call → author
// ---------------------------------------------------------------------------

const mainThread = {
  hook_event_name: 'PreToolUse',
  session_id: 's1',
  cwd: '/proj',
  tool_name: 'Read',
  tool_use_id: 'toolu_01Read',
};

record(
  '(a1) a main-thread call is NOT attributed to any subagent',
  subagentAttribution(mainThread) === null,
  JSON.stringify(subagentAttribution(mainThread)),
);

record(
  '(a2) agent_type WITHOUT agent_id is still the main thread (--agent sessions)',
  subagentAttribution({ ...mainThread, agent_type: 'general-purpose' }) === null,
  'null expected',
);

const inSubagent = subagentAttribution({
  ...mainThread,
  agent_id: 'agent-7f3a',
  agent_type: 'general-purpose',
});
record(
  '(a3) a call made inside a subagent carries that agent id and type',
  inSubagent?.agentId === 'agent-7f3a' && inSubagent.agentType === 'general-purpose',
  JSON.stringify(inSubagent),
);

// The join that survives a reload: `task_started` is the only message where the
// agent id and the spawning `Task` call are both in scope, so the engine records
// the pair there and stamps it onto the agent's calls.
const spawnedBy = new Map<string, string>([['agent-7f3a', 'toolu_01Task']]);
const joined = subagentAttribution({ ...mainThread, agent_id: 'agent-7f3a' }, spawnedBy);
record(
  '(a4) the spawning Task call is joined in when the engine knows it',
  joined?.parentToolCallId === 'toolu_01Task',
  JSON.stringify(joined),
);

record(
  '(a5) an unknown agent simply has no parent — never a borrowed one',
  subagentAttribution({ ...mainThread, agent_id: 'agent-other' }, spawnedBy)?.parentToolCallId ===
    undefined,
  'undefined expected',
);

record(
  '(a6) a malformed agent id is refused rather than rendered',
  subagentAttribution({ ...mainThread, agent_id: 'a b/c' }) === null &&
    subagentAttribution({ ...mainThread, agent_id: 'agent-1', agent_type: SECRET })?.agentType ===
      undefined,
  'null / no agentType',
);

let failed = 0;
for (const c of checks) {
  if (!c.pass) failed += 1;
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  [${c.evidence}]`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
if (failed > 0) process.exit(1);
