// src/spikes/spike-participant-history.ts
//
// multi-agent-chat MAC-M2 verification (specs/multi-agent-chat.md §8.1, §8.3, §8.8):
//
//   * the HISTORY VIEW (`viewHistoryFor`, R2.3): only the viewer's own speech
//     stays `assistant`; naby's and other participants' speech is user-side
//     context labelled `[@name]`; a hand-off reads `[나비 → @x]` unless it targets
//     the viewer; another speaker's tool calls (and their results) are dropped;
//     a session with no labelled row is the IDENTITY (same array);
//   * BOTH ENGINES' INPUTS: `toModelMessages` (AI-SDK) keeps consecutive user
//     rows and their labels; `renderPrompt` (Agent SDK) puts `speaker="@name"` on
//     a labelled line and names a hand-off as the host speaking, and is byte-for-
//     byte unchanged for a session without participants;
//   * `runTurn` with `speaker` / `routing` / `assistantRouting`: the rows it
//     writes, and the view the engine receives — and the unchanged rows of an
//     ordinary turn;
//   * the `isUserAuthored` CONSUMERS: reflection's user-message evidence and its
//     new-message count skip hand-off rows; compaction's summary input labels
//     speakers without double-labelling;
//   * a participant's read-only memory scope and explicit-only skill selection.
//
// In-memory stores only (no ~/.naby), a recording fake engine, no network.
// Exit 0 = pass, non-zero = fail.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryStore,
  runTurn,
  viewHistoryFor,
  isUserAuthored,
  mentionsHub,
  speakerPrefix,
  handoffPrefix,
  collectReflectionUserMessages,
  countUserMessagesSince,
  type Engine,
  type EngineEvent,
  type EngineRunInput,
  type RuntimeMessage,
} from '../runtime-entry.js';
import { renderPrompt } from '../engines/claude-agent-sdk-engine.js';
import { toModelMessages } from '../engines/ai-sdk-engine.js';
import { buildSummaryPrompt } from '../runtime/compaction.js';
import { gatherCandidates } from '../runtime/memory-inject.js';
import { selectSkillsForInjection } from '../runtime/skill-inject.js';

let failures = 0;
let passes = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passes += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const NABY = { agentId: 'agent-persona-builtin', name: 'naby' };
const TR = { agentId: 'p-tr', name: '번역가' };
const CR = { agentId: 'p-cr', name: 'critic' };

/** A round transcript as `runTurn` writes it: the user asks, naby hands to the
 *  translator, the translator answers (with a tool call), naby hands to the critic,
 *  the critic answers, naby adds a note to itself and answers. */
function roundTranscript(): RuntimeMessage[] {
  return [
    { role: 'user', content: '이 계약서 영어로 바꿔줘' },
    {
      role: 'user',
      content: 'Translate the contract.',
      speaker: NABY,
      routing: { kind: 'delegate', targetAgentId: TR.agentId, targetName: TR.name, reason: 'translation' },
    },
    { role: 'assistant', content: '', speaker: TR, toolCalls: [{ toolCallId: 'tc-tr', toolName: 'read_file', input: {} }] },
    { role: 'tool', toolCallId: 'tc-tr', toolName: 'read_file', output: { content: 'file body', isError: false } },
    { role: 'assistant', content: 'Here is the English version.', speaker: TR },
    {
      role: 'user',
      content: 'Review the translation.',
      speaker: NABY,
      routing: { kind: 'delegate', targetAgentId: CR.agentId, targetName: CR.name, reason: 'review' },
    },
    { role: 'assistant', content: 'Looks fine. @naby anything else?', speaker: CR, routing: { kind: 'return', reason: 'asked' } },
    {
      role: 'user',
      content: '@critic addressed you. Answer it.',
      speaker: NABY,
      routing: { kind: 'delegate', targetAgentId: NABY.agentId, targetName: NABY.name, reason: 'followup' },
    },
    { role: 'assistant', content: 'All done.' },
  ];
}

function contentOf(m: RuntimeMessage | undefined): string {
  return m && m.role !== 'tool' ? m.content : '';
}

/** A fake engine that records its input and answers with fixed text. */
class RecordingEngine implements Engine {
  inputs: EngineRunInput[] = [];
  constructor(private readonly reply: string) {}
  async *run(input: EngineRunInput): AsyncIterable<EngineEvent> {
    this.inputs.push({ ...input, messages: [...input.messages] });
    yield { kind: 'init', providerId: input.model.providerId, model: 'fake' };
    yield { kind: 'text', role: 'assistant', text: this.reply };
    yield { kind: 'result', ok: true, usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

const allowAll = async () => ({ behavior: 'allow' as const });

async function main(): Promise<void> {
  // Anything this spike might log lands in a temp home — never ~/.naby.
  const home = mkdtempSync(join(tmpdir(), 'naby-spike-participant-history-'));
  process.env.NABY_HOME = home;
  process.env.NABY_DB_PATH = join(home, 'app.db');
  // ---------------------------------------------------------------- the view
  console.log('\nviewHistoryFor — identity');
  {
    const plain: RuntimeMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    check('no labelled row → the SAME array', viewHistoryFor(plain) === plain);
    check('no labelled row, viewed by a participant → still the same array', viewHistoryFor(plain, TR) === plain);
  }

  console.log('\nviewHistoryFor — the translator (a participant) speaking');
  {
    const v = viewHistoryFor(roundTranscript(), TR, { hubId: NABY.agentId });
    const assistants = v.filter((m) => m.role === 'assistant');
    check(
      'only its own speech is assistant',
      assistants.length === 2 && assistants.every((m) => m.role === 'assistant' && m.speaker?.agentId === TR.agentId),
      JSON.stringify(assistants.map(contentOf)),
    );
    check('its own tool call and result survive', v.some((m) => m.role === 'tool' && m.toolCallId === 'tc-tr'));
    check('the hand-off TO it is as-is (no prefix)', v.some((m) => m.role === 'user' && m.content === 'Translate the contract.'));
    check(
      "naby's hand-off to the critic reads [나비 → @critic]",
      v.some((m) => m.role === 'user' && m.content === `${handoffPrefix('critic')}Review the translation.`),
    );
    check(
      "the critic's speech is a user row labelled [@critic]",
      v.some((m) => m.role === 'user' && m.content === `${speakerPrefix('critic')}Looks fine. @naby anything else?`),
    );
    check(
      "naby's speech is a user row labelled [@naby]",
      v.some((m) => m.role === 'user' && m.content === '[@naby] All done.'),
    );
    check(
      "naby's note to itself reads [@naby] to others",
      v.some((m) => m.role === 'user' && m.content === '[@naby] @critic addressed you. Answer it.'),
    );
    check('the user’s own words stay unlabelled', contentOf(v[0]) === '이 계약서 영어로 바꿔줘');
  }

  console.log('\nviewHistoryFor — naby speaking');
  {
    const v = viewHistoryFor(roundTranscript(), undefined, { hubId: NABY.agentId });
    const assistants = v.filter((m) => m.role === 'assistant');
    check('only naby’s speech is assistant', assistants.length === 1 && contentOf(assistants[0]) === 'All done.');
    check(
      'another speaker’s tool call is dropped, and its result with it',
      !v.some((m) => m.role === 'tool') && !v.some((m) => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0),
    );
    check(
      'naby’s own hand-off to the translator reads [나비 → @번역가]',
      v.some((m) => m.role === 'user' && m.content === `${handoffPrefix('번역가')}Translate the contract.`),
    );
    check(
      'naby’s note to itself is as-is',
      v.some((m) => m.role === 'user' && m.content === '@critic addressed you. Answer it.'),
    );
    check(
      'the translator reads [@번역가] to naby',
      v.some((m) => m.role === 'user' && m.content === '[@번역가] Here is the English version.'),
    );
  }

  // ------------------------------------------------------- both engines' input
  console.log('\nengine inputs');
  {
    const v = viewHistoryFor(roundTranscript(), TR, { hubId: NABY.agentId });
    const mm = toModelMessages(v);
    check(
      'AI-SDK payload: every assistant message is the viewer’s own',
      mm.filter((m) => m.role === 'assistant').length === 2,
    );
    const firstUserRun = mm.slice(0, 2).every((m) => m.role === 'user');
    check('AI-SDK payload keeps consecutive user rows (user, hand-off) and their text', firstUserRun);
    check(
      'AI-SDK payload keeps the [@critic] label',
      mm.some((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[@critic] ')),
    );

    // The participant's NEXT turn: a fresh hand-off is the last user row.
    const next = viewHistoryFor(
      [
        ...roundTranscript(),
        { role: 'user', content: 'Again, shorter.', speaker: NABY, routing: { kind: 'delegate', targetAgentId: TR.agentId, targetName: TR.name } },
      ],
      TR,
      { hubId: NABY.agentId },
    );
    const prompt = renderPrompt(next);
    check('Agent SDK prompt: speaker="@critic" on the critic’s line', prompt.includes('User (speaker="@critic"): [@critic] Looks fine.'));
    check('Agent SDK prompt: speaker="@naby" on naby’s line', prompt.includes('User (speaker="@naby"): [@naby] All done.'));
    check('Agent SDK prompt: the viewer’s own speech is Assistant:', prompt.includes('Assistant: Here is the English version.'));
    check('Agent SDK prompt: the hand-off is the host speaking, not the user', prompt.includes('@naby (the host) now says to you:\nAgain, shorter.'));
    check('Agent SDK prompt: the user’s own words keep the plain label', prompt.includes('User: 이 계약서 영어로 바꿔줘'));

    const plain: RuntimeMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'second' },
    ];
    const plainPrompt = renderPrompt(viewHistoryFor(plain));
    check(
      'Agent SDK prompt with no participants is unchanged',
      plainPrompt ===
        [
          'Earlier messages in this conversation, for context only — do not answer them again:',
          '<conversation_history>',
          'User: first',
          'Assistant: answer',
          '</conversation_history>',
          '',
          'The user now says:',
          'second',
        ].join('\n'),
      plainPrompt,
    );
    check('Agent SDK prompt has no speaker attribute without participants', !plainPrompt.includes('speaker='));
  }

  // ---------------------------------------------------------------- runTurn
  console.log('\nrunTurn — speaker, routing, assistantRouting');
  {
    const store = new MemoryStore();
    const sessionId = store.createSession('fake').sessionId;
    store.appendMessage(sessionId, { role: 'user', content: '이 계약서 영어로 바꿔줘' });
    store.appendMessage(sessionId, { role: 'assistant', content: 'Sure, one moment.' });

    const engine = new RecordingEngine('Here you go. @naby is this formal enough?');
    await runTurn({
      engine,
      store,
      sessionId,
      model: { providerId: 'fake' },
      userText: 'Translate the contract.',
      toolSchemas: [],
      executors: {},
      gate: allowAll,
      speaker: TR,
      routing: { from: NABY, kind: 'delegate', targetAgentId: TR.agentId, targetName: TR.name, reason: 'translation' },
      hub: NABY,
      assistantRouting: (text) => (mentionsHub(text) ? { kind: 'return', reason: 'asked' } : undefined),
    });
    const rows = store.getMessages(sessionId);
    const handoff = rows[2];
    check(
      'the user row is naby’s hand-off (speaker naby + routing)',
      handoff?.role === 'user' &&
        handoff.speaker?.agentId === NABY.agentId &&
        handoff.routing?.kind === 'delegate' &&
        handoff.routing.targetAgentId === TR.agentId &&
        !('from' in (handoff.routing as object)),
      JSON.stringify(handoff),
    );
    check('the hand-off row is not user-authored', handoff !== undefined && !isUserAuthored(handoff));
    const reply = rows[3];
    check(
      'the assistant row carries the participant as speaker',
      reply?.role === 'assistant' && reply.speaker?.agentId === TR.agentId,
      JSON.stringify(reply),
    );
    check(
      'assistantRouting stamps the RETURN on that row (@naby)',
      reply?.role === 'assistant' && reply.routing?.kind === 'return' && reply.routing.reason === 'asked',
    );
    const seen = engine.inputs[0]!.messages;
    check(
      'the engine saw naby’s earlier speech as a [@naby] user row',
      seen.some((m) => m.role === 'user' && m.content === '[@naby] Sure, one moment.'),
      JSON.stringify(seen),
    );
    check('the engine saw the hand-off last, as-is', contentOf(seen[seen.length - 1]) === 'Translate the contract.');

    // naby's ordinary turn in the same session: the participant is context.
    const nabyEngine = new RecordingEngine('noted');
    await runTurn({
      engine: nabyEngine,
      store,
      sessionId,
      model: { providerId: 'fake' },
      userText: 'thanks',
      toolSchemas: [],
      executors: {},
      gate: allowAll,
    });
    const nabySeen = nabyEngine.inputs[0]!.messages;
    check(
      'naby’s turn sees the participant as [@번역가] user context',
      nabySeen.some((m) => m.role === 'user' && m.content.startsWith('[@번역가] Here you go.')),
    );
    check(
      'naby’s turn keeps its own speech as assistant',
      nabySeen.some((m) => m.role === 'assistant' && m.content === 'Sure, one moment.'),
    );
    // Review finding 3: the session's ONE rolling-summary row is naby's. A
    // participant's turn gets no port (it would read/write a foldedCount counted
    // in its own view's coordinates); naby's turn keeps it.
    check(
      'a participant turn is handed NO rolling-summary port; naby’s turn is',
      engine.inputs[0]!.rollingSummary === undefined && nabyEngine.inputs[0]!.rollingSummary !== undefined,
    );
    store.setSessionRollingSummary(sessionId, { text: 'naby summary', foldedCount: 2 });
    const pEngine2 = new RecordingEngine('again');
    await runTurn({
      engine: pEngine2,
      store,
      sessionId,
      model: { providerId: 'fake' },
      userText: 'Once more.',
      toolSchemas: [],
      executors: {},
      gate: allowAll,
      speaker: TR,
      routing: { from: NABY, kind: 'delegate', targetAgentId: TR.agentId, targetName: TR.name, reason: 'again' },
      hub: NABY,
    });
    check(
      'a participant turn neither reads nor overwrites naby’s stored summary',
      pEngine2.inputs[0]!.rollingSummary === undefined &&
        store.getSessionRollingSummary(sessionId)?.text === 'naby summary' &&
        store.getSessionRollingSummary(sessionId)?.foldedCount === 2,
    );
    const last = store.getMessages(sessionId).slice(-4, -2);
    check(
      'an ordinary turn still writes plain rows (no speaker, no routing)',
      last.every((m) => m.role !== 'tool' && m.speaker === undefined && m.routing === undefined),
      JSON.stringify(last),
    );
  }

  console.log('\nrunTurn — a session with no participant is untouched');
  {
    const store = new MemoryStore();
    const sessionId = store.createSession('fake').sessionId;
    store.appendMessage(sessionId, { role: 'user', content: 'a' });
    store.appendMessage(sessionId, { role: 'assistant', content: 'b' });
    const engine = new RecordingEngine('c');
    await runTurn({ engine, store, sessionId, model: { providerId: 'fake' }, userText: 'd', toolSchemas: [], executors: {}, gate: allowAll });
    const seen = engine.inputs[0]!.messages;
    check('a session without participants keeps its rolling-summary port', engine.inputs[0]!.rollingSummary !== undefined);
    check(
      'the engine input equals the stored rows exactly',
      JSON.stringify(seen) === JSON.stringify(store.getMessages(sessionId).slice(0, 3)),
    );
  }

  // ------------------------------------------------- isUserAuthored consumers
  console.log('\nisUserAuthored consumers');
  {
    const t = roundTranscript();
    const evidence = collectReflectionUserMessages(t);
    check(
      'reflection evidence holds only the user’s own message',
      evidence.length === 1 && evidence[0]!.text === '이 계약서 영어로 바꿔줘',
      JSON.stringify(evidence),
    );
    check('reflection’s new-message count skips hand-offs', countUserMessagesSince(t, -1) === 1);

    const summary = buildSummaryPrompt(t);
    check('summary input labels a participant’s line', summary.includes('Assistant: [@번역가] Here is the English version.'));
    check('summary input labels naby’s hand-off with its speaker', summary.includes('User: [@naby] Translate the contract.'));
    const viewed = buildSummaryPrompt(viewHistoryFor(t, TR, { hubId: NABY.agentId }));
    check('an already-labelled line is not labelled twice', !viewed.includes('[@critic] [@critic]'));
    const plainSummary = buildSummaryPrompt([{ role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }]);
    check('summary input without participants is unchanged', plainSummary === 'Messages to summarize:\nUser: x\nAssistant: y');
  }

  // ---------------------------------------- the participant's memory and skills
  console.log('\nparticipant memory scope and skills');
  {
    const store = new MemoryStore();
    const sessionId = store.createSession('fake').sessionId;
    store.setMemory(sessionId, 'session-fact', 'only in this conversation');
    const all = gatherCandidates(store, { sessionId, tokenBudget: 1000 });
    const userOnly = gatherCandidates(store, { sessionId, tokenBudget: 1000, scopes: ['user'] });
    check('without scopes every scope is read (the established read)', all.some((m) => m.key === 'session-fact'));
    check('a participant with memoryScope=user does not read session memory', !userOnly.some((m) => m.key === 'session-fact'));

    const now = Date.now();
    const skill = (name: string, triggers: string[]) => ({
      id: `h-${name}`,
      kind: 'skill' as const,
      scope: 'user' as const,
      scopeKey: 'local',
      name,
      status: 'enabled' as const,
      skill: { description: name, triggers, instructions: `Do ${name}.`, toolRefs: [] },
      createdAt: now,
      updatedAt: now,
    });
    const rows = [skill('glossary', ['contract']), skill('style', ['contract'])];
    const normal = selectSkillsForInjection(rows as never, 'translate the contract', 2000, new Set(), ['glossary']);
    const only = selectSkillsForInjection(rows as never, 'translate the contract', 2000, new Set(), ['glossary'], undefined, true);
    check('a naby turn injects named AND trigger-matched skills', normal.skills.length === 2, JSON.stringify(normal.skills.map((s) => s.name)));
    check(
      'explicitOnly injects only the participant’s own named skill',
      only.skills.length === 1 && only.skills[0]!.name === 'glossary',
      JSON.stringify(only.skills.map((s) => s.name)),
    );
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
