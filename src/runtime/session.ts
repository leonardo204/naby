// src/runtime/session.ts
//
// The provider-independent turn runner. This is the seam the app drives: it
// owns the store, hands the engine the provider-independent inputs, and folds
// the engine's normalized events back into our own message history. It is
// identical regardless of which engine (= which provider) runs the turn.

import type {
  Engine,
  EngineEvent,
  Executor,
  Gate,
  ModelSelection,
  ToolSchema,
} from './engine.js';
import type { MemoryStore } from './memory.js';

export type RunTurnOptions = {
  engine: Engine;
  store: MemoryStore;
  sessionId: string;
  model: ModelSelection;
  userText: string;
  toolSchemas: ToolSchema[];
  executors: Record<string, Executor>;
  gate: Gate;
  signal?: AbortSignal;
};

/** Run one turn on the given engine, folding its events into the store. Returns
 * the full event list so a spike can assert on it. */
export async function runTurn(opts: RunTurnOptions): Promise<EngineEvent[]> {
  const { engine, store, sessionId, model, userText, toolSchemas, executors, gate } =
    opts;

  store.appendMessage(sessionId, { role: 'user', content: userText });

  const controller = new AbortController();
  const signal = opts.signal ?? controller.signal;

  const events: EngineEvent[] = [];
  for await (const ev of engine.run({
    model,
    messages: store.session(sessionId).messages,
    toolSchemas,
    gate,
    executors,
    signal,
  })) {
    events.push(ev);
    if (ev.kind === 'text' && ev.role === 'assistant') {
      store.appendMessage(sessionId, { role: 'assistant', content: ev.text });
    } else if (ev.kind === 'tool_result') {
      store.appendMessage(sessionId, {
        role: 'tool',
        toolCallId: ev.toolCallId,
        output: ev.output,
      });
    }
  }
  return events;
}
