// src/runtime/session.ts
//
// The provider-independent turn runner. This is the seam the app drives: it
// owns the store, hands the engine the provider-independent inputs, and folds
// the engine's normalized events back into our own message history. It is
// identical regardless of which engine (= which provider) runs the turn.
//
// Since F1-05 the store is the `Store` INTERFACE, not a concrete class — the
// same runTurn drives an in-memory store in a spike and a SQLite file on disk
// in the app, and neither the engines nor this file know which one they got.

import type {
  Engine,
  EngineEvent,
  Executor,
  Gate,
  ModelSelection,
  ToolOutput,
  ToolSchema,
} from './engine.js';
import type { Store } from './store/store.js';

export type RunTurnOptions = {
  engine: Engine;
  store: Store;
  sessionId: string;
  model: ModelSelection;
  userText: string;
  toolSchemas: ToolSchema[];
  executors: Record<string, Executor>;
  gate: Gate;
  /** System prompt for this turn. Passed to the engine on its OWN field, never
   * appended to the history — `ai@7` rejects `role:'system'` inside `messages`
   * and a system prompt is not part of the transcript we replay (contract §6). */
  system?: string;
  /** Called for each event AS IT ARRIVES, before runTurn returns. A caller that
   * must stream (the shell adapter translating to its client's event shapes)
   * uses this instead of re-implementing the loop — which keeps the store
   * writes, and the tool-call pairing below, in ONE place. Throwing from here
   * aborts the turn. */
  onEvent?: (ev: EngineEvent) => void;
  signal?: AbortSignal;
};

/** Run one turn on the given engine, folding its events into the store. Returns
 * the full event list so a spike can assert on it. */
export async function runTurn(opts: RunTurnOptions): Promise<EngineEvent[]> {
  const { engine, store, sessionId, model, userText, toolSchemas, executors, gate } =
    opts;

  // Record the provider that is about to answer. This is the ONLY place a
  // provider id touches storage, and it is a hint — see SessionRef.providerId.
  store.touchSession(sessionId, model.providerId);

  store.appendMessage(sessionId, { role: 'user', content: userText });

  const controller = new AbortController();
  const signal = opts.signal ?? controller.signal;

  const events: EngineEvent[] = [];

  // -- Tool-call PAIRING -----------------------------------------------------
  // A persisted tool result is only replayable if the assistant tool-call that
  // produced it is in the transcript too: providers reject a tool result with
  // no matching call just as they reject a call with no matching result. So we
  // record BOTH, and we guarantee the pairing rather than hoping for it —
  //
  //   tool_request        -> append assistant(toolCalls:[call]), mark pending
  //   tool_result         -> append tool(result), clear pending
  //   gate_result 'deny'  -> no executor runs and no tool_result follows, so
  //                          append the denial AS the tool result (which is
  //                          also exactly what the engine fed the model)
  //   stream ended        -> close out anything still pending (e.g. NO_EXECUTOR,
  //                          or an abort mid-call) so no orphan call survives
  //
  // Each pair is appended adjacently, which keeps the transcript valid for
  // every provider without any provider-specific reordering.
  const pending = new Map<string, string>(); // toolCallId -> toolName

  const closeCall = (toolCallId: string, output: ToolOutput): void => {
    const toolName = pending.get(toolCallId);
    if (toolName === undefined) return; // already closed
    pending.delete(toolCallId);
    // `toolName` is carried explicitly (contract §6): a persisted tool result
    // must be replayable as a REAL tool message even when its originating call
    // was written by an earlier turn, an earlier process, or another engine.
    store.appendMessage(sessionId, {
      role: 'tool',
      toolCallId,
      toolName,
      output,
    });
  };

  for await (const ev of engine.run({
    model,
    // Read the transcript back from the store: after F1-05 this may have come
    // from disk, written by a previous process and possibly a different engine.
    messages: store.getMessages(sessionId),
    ...(opts.system !== undefined ? { system: opts.system } : {}),
    toolSchemas,
    gate,
    executors,
    signal,
  })) {
    // Cancellation: stop consuming the moment the turn is aborted. Breaking out
    // of the for-await calls the engine generator's return(), which unwinds the
    // engine's own loop — so an abort stops the model loop here and now rather
    // than letting it run to its iteration cap. The signal is ALSO handed to
    // the engine (and through it to the provider call), so this is a second
    // barrier, not the only one.
    if (signal.aborted) break;

    events.push(ev);
    opts.onEvent?.(ev);

    if (ev.kind === 'text' && ev.role === 'assistant') {
      store.appendMessage(sessionId, { role: 'assistant', content: ev.text });
    } else if (ev.kind === 'tool_request') {
      pending.set(ev.toolCallId, ev.toolName);
      store.appendMessage(sessionId, {
        role: 'assistant',
        content: '',
        toolCalls: [
          { toolCallId: ev.toolCallId, toolName: ev.toolName, input: ev.input },
        ],
      });
    } else if (ev.kind === 'gate_result' && ev.decision === 'deny') {
      closeCall(ev.toolCallId, {
        content: `Denied by policy gate: ${ev.reason ?? 'no reason given'}`,
        isError: true,
      });
    } else if (ev.kind === 'tool_result') {
      closeCall(ev.toolCallId, ev.output);
    }
  }

  // Nothing may be left half-written: an unclosed call would be an orphan on
  // the next replay, which is the exact failure Bug B was about.
  for (const toolCallId of [...pending.keys()]) {
    closeCall(toolCallId, {
      content: 'Tool call did not complete.',
      isError: true,
    });
  }

  return events;
}
