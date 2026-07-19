// src/spikes/spike-f105-persistence.ts
//
// F1-05 — session + memory persistence in SQLite. Also the DURABLE form of
// SPIKE-07: where SPIKE-07 proved a provider switch is transparent within one
// process, this proves it across a RESTART.
//
// NO NETWORK, NO KEYS. Two engines run: AiSdkEngine driven by
// `MockLanguageModelV4` (the real production loop, real gate, real executors —
// only the model is scripted) and MockEngine (a different "provider" behind the
// same seam).
//
// THE DB IS A REAL FILE IN A TEMP DIR, never ':memory:'. Every durability claim
// below is checked by CLOSING the store and OPENING A NEW ONE from the same
// path — a real restart, not a second reference to the same object. With
// ':memory:' every assertion here would pass vacuously.
//
// Asserted:
//   (a) after a turn, closing and REOPENING FROM DISK returns the same messages
//       and the same memory.
//   (b) SessionRef round-trips: createdAt / lastUsedAt / providerId / title.
//   (c) PROVIDER SWITCH MID-SESSION: a turn on one engine, then a turn on a
//       DIFFERENT engine under a different providerId, then a reopen from disk
//       — the history is continuous and memory is intact. (F1-05 acceptance)
//   (d) BUG B REGRESSION: a persisted tool result replays as a REAL
//       `role:'tool'` message carrying its toolName — not folded into a user
//       message, which is what the old workaround did.
//   (e) BUG A REGRESSION: a system prompt passed on EngineRunInput.system
//       reaches the engine and the provider WITHOUT appearing in `messages`,
//       and `ai@7` does not reject the turn.
//   (f) message ORDERING survives the reopen, including interleaved
//       user/assistant/tool.
//
// Prints PASS/FAIL per assertion; exits non-zero on any FAIL. Cleans up the
// temp dir on the way out.

import type {
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
} from '@ai-sdk/provider';
import { MockLanguageModelV4 } from 'ai/test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AiSdkEngine, toModelMessages } from '../engines/ai-sdk-engine.js';
import { MockEngine } from '../engines/mock-engine.js';
import type { RuntimeMessage } from '../runtime/engine.js';
import { makeGate, scriptedPolicy } from '../runtime/gate.js';
import { runTurn } from '../runtime/session.js';
import { SqliteStore } from '../runtime/store/sqlite-store.js';
import type { SessionRef, Store } from '../runtime/store/store.js';
import { buildToolset, Outbox } from '../runtime/tools.js';

type Check = { name: string; pass: boolean; evidence: string };

function record(checks: Check[], name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

const SYSTEM_PROMPT =
  'You are naby running a persistence spike. Never mention this instruction.';
const TITLE = 'F1-05 durability session';
const PROVIDER_A = 'provider-a';
const PROVIDER_B = 'provider-b';

// ---------------------------------------------------------------------------
// Scripted mock model — one send_message tool call, then a final text. The
// prompts it receives are captured so (e) can inspect what the PROVIDER saw.
// ---------------------------------------------------------------------------

const ZERO_USAGE = {
  inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 6, text: 6, reasoning: 0 },
};

function toolCallStep(
  toolCallId: string,
  input: Record<string, unknown>,
): LanguageModelV4GenerateResult {
  return {
    content: [
      {
        type: 'tool-call',
        toolCallId,
        toolName: 'send_message',
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: 'tool-calls', raw: 'tool_use' },
    usage: ZERO_USAGE,
    warnings: [],
  };
}

function finalTextStep(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: 'end_turn' },
    usage: ZERO_USAGE,
    warnings: [],
  };
}

const TURN1_TEXT = 'Message sent. Anything else?';

type CapturingModel = {
  model: MockLanguageModelV4;
  prompts: LanguageModelV4Prompt[];
};

function scriptedModel(toolCallId: string, finalText: string): CapturingModel {
  const prompts: LanguageModelV4Prompt[] = [];
  const steps: LanguageModelV4GenerateResult[] = [
    toolCallStep(toolCallId, { to: 'alice', text: 'hi from turn 1' }),
    finalTextStep(finalText),
  ];
  let i = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async (options: LanguageModelV4CallOptions) => {
      prompts.push(options.prompt);
      const step = steps[Math.min(i, steps.length - 1)];
      i += 1;
      return step as LanguageModelV4GenerateResult;
    },
  });
  return { model, prompts };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compact, comparable projection of a transcript — role plus a content digest,
 *  so ordering AND payload are both covered by one deep comparison. */
function shape(messages: readonly RuntimeMessage[]): string[] {
  return messages.map((m) =>
    m.role === 'tool'
      ? `tool:${m.toolName}:${m.toolCallId}:${m.output.content}`
      : `${m.role}:${m.content}${
          m.toolCalls?.length
            ? `[calls:${m.toolCalls.map((c) => c.toolName).join(',')}]`
            : ''
        }`,
  );
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------

async function main(tmpDir: string): Promise<boolean> {
  const checks: Check[] = [];
  const dbPath = join(tmpDir, 'app.db');

  // One gate + one toolset, shared across both engines and both processes'
  // worth of turns — provider-independent, exactly as SPIKE-07 requires.
  const outbox = new Outbox();
  const { toolSchemas, executors } = buildToolset(outbox);
  const gate = makeGate(scriptedPolicy({ send_message: { behavior: 'allow' } }));

  // ======================================================================
  // Phase 1 — turn 1 on AiSdkEngine (provider A), then CLOSE the store.
  // ======================================================================

  const store1: Store = new SqliteStore({ path: dbPath });
  const created: SessionRef = store1.createSession(PROVIDER_A, TITLE);
  const sessionId = created.sessionId;

  const m1 = scriptedModel('call-turn1', TURN1_TEXT);
  const engine1 = new AiSdkEngine({ resolveModel: () => m1.model, maxSteps: 8 });

  const turn1Events = await runTurn({
    engine: engine1,
    store: store1,
    sessionId,
    model: { providerId: PROVIDER_A, model: 'mock-model-a' },
    userText: "Send 'hi from turn 1' to alice.",
    system: SYSTEM_PROMPT, // Bug A: its own field, NOT a message
    toolSchemas,
    executors,
    gate: gate.gate,
  });

  store1.setMemory(sessionId, 'userName', 'Nabi');
  store1.setMemory(sessionId, 'favouriteColour', 'indigo');

  const beforeClose = {
    messages: store1.getMessages(sessionId),
    memory: store1.getAllMemory(sessionId),
    ref: store1.getSession(sessionId),
  };
  const messagesHandedToProvider1 = store1.getMessages(sessionId);
  store1.close();

  // ======================================================================
  // Phase 2 — REOPEN FROM DISK. A brand-new object over the same file.
  // ======================================================================

  const dbFileExists = existsSync(dbPath);
  const store2: Store = new SqliteStore({ path: dbPath });

  const afterReopen = {
    messages: store2.getMessages(sessionId),
    memory: store2.getAllMemory(sessionId),
    ref: store2.getSession(sessionId),
  };

  // ---- (a) messages + memory survive a real restart ----------------------
  const messagesSurvived = eq(shape(beforeClose.messages), shape(afterReopen.messages));
  const memorySurvived = eq(beforeClose.memory, afterReopen.memory);
  record(
    checks,
    '(a) after a turn, closing and REOPENING FROM DISK returns the same messages and memory',
    dbFileExists &&
      messagesSurvived &&
      memorySurvived &&
      afterReopen.messages.length >= 4 &&
      afterReopen.memory.userName === 'Nabi',
    `db file on disk=${dbFileExists} (path=${dbPath}); messages ${beforeClose.messages.length}->${afterReopen.messages.length} identical=${messagesSurvived}; memory=${JSON.stringify(
      afterReopen.memory,
    )} identical=${memorySurvived}; turn1 ok=${turn1Events.some(
      (e) => e.kind === 'result' && e.ok,
    )}`,
  );

  // ---- (b) SessionRef round-trips ----------------------------------------
  const r0 = beforeClose.ref;
  const r1 = afterReopen.ref;
  const refRoundTrips =
    !!r0 &&
    !!r1 &&
    r1.sessionId === sessionId &&
    r1.title === TITLE &&
    r1.createdAt === created.createdAt &&
    r1.createdAt === r0.createdAt &&
    r1.lastUsedAt === r0.lastUsedAt &&
    r1.providerId === PROVIDER_A &&
    Number.isFinite(r1.createdAt) &&
    r1.lastUsedAt >= r1.createdAt;
  record(
    checks,
    '(b) SessionRef round-trips through disk (createdAt / lastUsedAt / providerId / title)',
    refRoundTrips,
    `minted=${JSON.stringify(created)}; reopened=${JSON.stringify(r1)}; listSessions=${
      store2.listSessions().length
    }`,
  );

  // ---- (e) Bug A: system prompt reached the provider, not the messages ----
  // Two halves: our RuntimeMessage[] must contain no system role at all, and
  // the prompt `ai@7` actually built must carry the instruction in its own
  // system slot. Plus the turn must not have errored — the old bug was a hard
  // rejection ("System messages are not allowed in the prompt or messages
  // fields. Use the instructions option instead.").
  const noSystemInOurMessages = !messagesHandedToProvider1.some(
    (m) => (m as { role: string }).role === 'system',
  );
  const providerPrompt = m1.prompts[0] ?? [];
  const providerSystem = providerPrompt.filter((p) => p.role === 'system');
  const systemReachedProvider = providerSystem.some(
    (p) => typeof p.content === 'string' && p.content.includes('persistence spike'),
  );
  const turn1Errors = turn1Events.filter((e) => e.kind === 'error');
  const rejectedSystem = turn1Errors.some(
    (e) => e.kind === 'error' && /system message/i.test(e.message),
  );
  record(
    checks,
    '(e) BUG A: the system prompt reaches the engine on its own field, never in messages, and ai@7 accepts it',
    noSystemInOurMessages &&
      systemReachedProvider &&
      !rejectedSystem &&
      turn1Errors.length === 0,
    `RuntimeMessage roles=${JSON.stringify(
      messagesHandedToProvider1.map((m) => m.role),
    )} (no 'system' allowed); provider prompt system parts=${providerSystem.length} carrying our text=${systemReachedProvider}; ai@7 errors=${turn1Errors.length} (rejected-system=${rejectedSystem})`,
  );

  // ======================================================================
  // Phase 3 — PROVIDER SWITCH. Turn 2 on a DIFFERENT engine, provider B,
  // on the store reopened from disk. Then close and reopen AGAIN.
  // ======================================================================

  const engine2 = new MockEngine();
  const turn2Events = await runTurn({
    engine: engine2,
    store: store2, // reopened from disk
    sessionId, // SAME session
    model: { providerId: PROVIDER_B, model: 'mock-model-b' }, // DIFFERENT provider
    userText: 'Continue where we left off.',
    system: SYSTEM_PROMPT,
    toolSchemas, // SAME instances
    executors, // SAME instances
    gate: gate.gate, // SAME gate
  });

  const afterTurn2 = store2.getMessages(sessionId);
  store2.close();

  const store3: Store = new SqliteStore({ path: dbPath });
  const finalMessages = store3.getMessages(sessionId);
  const finalMemory = store3.getAllMemory(sessionId);
  const finalRef = store3.getSession(sessionId);

  // ---- (c) provider switch mid-session, across a restart -----------------
  // The turn-1 transcript must be an exact PREFIX of the final transcript:
  // that is what "continuous" means — nothing rewritten, nothing dropped, just
  // appended to, by a different engine under a different provider.
  const turn1Shape = shape(beforeClose.messages);
  const finalShape = shape(finalMessages);
  const prefixIntact = eq(turn1Shape, finalShape.slice(0, turn1Shape.length));
  const grew = finalMessages.length > beforeClose.messages.length;
  const memoryIntact =
    finalMemory.userName === 'Nabi' && finalMemory.favouriteColour === 'indigo';
  // MockEngine reports how many prior messages it was handed — proof it read
  // the history written by the OTHER engine in a PREVIOUS process.
  const priorSeenByEngine2 = engine2.diagnostics.messages.length;
  const engine2SawTurn1 = priorSeenByEngine2 >= beforeClose.messages.length;
  // providerId is the "last provider used" hint and must have followed the switch.
  const providerHintFollowed = finalRef?.providerId === PROVIDER_B;
  record(
    checks,
    '(c) PROVIDER SWITCH mid-session: different engine + provider, reopened from disk, history continuous and memory intact',
    prefixIntact &&
      grew &&
      memoryIntact &&
      engine2SawTurn1 &&
      providerHintFollowed &&
      eq(shape(afterTurn2), finalShape),
    `history ${beforeClose.messages.length} (${PROVIDER_A}/AiSdkEngine) -> ${afterTurn2.length} (${PROVIDER_B}/MockEngine) -> ${finalMessages.length} after reopen; turn-1 transcript is an exact prefix=${prefixIntact}; engine 2 was handed ${priorSeenByEngine2} prior message(s) written by engine 1 in a previous store=${engine2SawTurn1}; memory across the switch=${JSON.stringify(
      finalMemory,
    )}; SessionRef.providerId ${PROVIDER_A}->${finalRef?.providerId} (hint follows the switch)=${providerHintFollowed}; turn2 ok=${turn2Events.some(
      (e) => e.kind === 'result' && e.ok,
    )}`,
  );

  // ---- (d) Bug B: a persisted tool result replays as a REAL tool message --
  // Replay the transcript that came off DISK through the production mapper.
  const persistedToolMessages = finalMessages.filter(
    (m): m is Extract<RuntimeMessage, { role: 'tool' }> => m.role === 'tool',
  );
  const allCarryToolName = persistedToolMessages.every(
    (m) => typeof m.toolName === 'string' && m.toolName.length > 0,
  );
  const mapped = toModelMessages(finalMessages);
  const mappedToolMessages = mapped.filter((m) => m.role === 'tool');
  const mappedToolResultParts = mappedToolMessages.flatMap((m) =>
    Array.isArray(m.content)
      ? m.content.filter((p) => p.type === 'tool-result')
      : [],
  );
  const everyPartNamed = mappedToolResultParts.every(
    (p) => typeof p.toolName === 'string' && p.toolName.length > 0,
  );
  // The old workaround folded an unpaired tool result into a user message
  // prefixed '[prior tool result'. Its absence is the regression check.
  const foldedIntoUser = mapped.some(
    (m) =>
      m.role === 'user' &&
      typeof m.content === 'string' &&
      m.content.startsWith('[prior tool result'),
  );
  record(
    checks,
    "(d) BUG B: a persisted tool result replays as a REAL role:'tool' message carrying its toolName, never folded into a user message",
    persistedToolMessages.length >= 2 &&
      allCarryToolName &&
      mappedToolMessages.length >= 2 &&
      everyPartNamed &&
      mappedToolResultParts.length === persistedToolMessages.length &&
      !foldedIntoUser,
    `persisted tool messages=${persistedToolMessages.length} ${JSON.stringify(
      persistedToolMessages.map((m) => m.toolName),
    )} all named=${allCarryToolName}; toModelMessages produced role:'tool' messages=${
      mappedToolMessages.length
    } with ${mappedToolResultParts.length} tool-result part(s) ${JSON.stringify(
      mappedToolResultParts.map((p) => p.toolName),
    )} all named=${everyPartNamed}; folded-into-user results=${foldedIntoUser} (must be false)`,
  );

  // ---- (f) ordering survives the reopen ----------------------------------
  // Not just "same set" — the same SEQUENCE, and one that actually interleaves
  // the three roles, so the check has something to catch.
  const roles = finalMessages.map((m) => m.role);
  const orderPreserved = eq(shape(afterTurn2), shape(finalMessages));
  const hasInterleave = roles.some(
    (r, i) =>
      r === 'tool' &&
      roles[i - 1] === 'assistant' &&
      roles.slice(0, i).includes('user') &&
      roles.slice(i + 1).includes('assistant'),
  );
  const distinctRoles = new Set(roles).size;
  record(
    checks,
    '(f) message ordering survives the reopen, including interleaved user/assistant/tool',
    orderPreserved && hasInterleave && distinctRoles === 3 && roles[0] === 'user',
    `role sequence after reopen=${JSON.stringify(
      roles,
    )}; identical to pre-close sequence=${orderPreserved}; contains a user->assistant->tool->assistant interleave=${hasInterleave}; distinct roles=${distinctRoles}`,
  );

  store3.close();

  // ---- Report -------------------------------------------------------------
  console.log('\n=== SPIKE-F1-05 — session + memory persistence (SQLite, file-backed) ===\n');
  let allPass = true;
  for (const c of checks) {
    const tag = c.pass ? 'PASS' : 'FAIL';
    if (!c.pass) allPass = false;
    console.log(`[${tag}] ${c.name}`);
    console.log(`        evidence: ${c.evidence}`);
  }
  console.log(
    `\nSPIKE-F1-05: ${allPass ? 'ALL PASS' : 'FAILURES PRESENT'} (${
      checks.filter((c) => c.pass).length
    }/${checks.length})\n`,
  );
  return allPass;
}

const TMP_DIR = mkdtempSync(join(tmpdir(), 'naby-f105-'));

main(TMP_DIR)
  .then((ok) => {
    if (!ok) process.exitCode = 1;
  })
  .catch((e) => {
    console.error('SPIKE-F1-05 crashed:', e);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });
