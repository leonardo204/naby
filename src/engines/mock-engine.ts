// src/engines/mock-engine.ts
//
// MockEngine — a second `Engine` with NO external calls. It exists so SPIKE-07
// can prove provider/engine independence WITHOUT a second API key: it is a
// different "provider" behind the exact same Engine seam.
//
// It deterministically:
//   1. reads the continuous message history it was handed (proving the history
//      written under the FIRST engine is visible here),
//   2. emits ONE send_message tool call — so the SAME runtime gate is
//      exercised, exactly as it would be on any real engine,
//   3. runs the SAME runtime executor on the gate-approved input (so a message
//      lands in the session), and
//   4. emits a final text.
//
// Everything provider-independent (messages, gate, executors) comes in through
// EngineRunInput unchanged — the engine never sees a provider or a key.

import type {
  Engine,
  EngineEvent,
  EngineRunInput,
  ToolCall,
} from '../runtime/engine.js';

/** What the engine was handed on its most recent run. Lets a spike assert on
 *  the INPUTS at the seam — notably that the system prompt arrived on its own
 *  field and not smuggled into `messages` (contract §2/§6). */
export type MockEngineDiagnostics = {
  /** the `EngineRunInput.system` value received, if any. */
  system: string | undefined;
  /** the message history received, verbatim. */
  messages: EngineRunInput['messages'];
};

export class MockEngine implements Engine {
  /** Diagnostics from the most recent run(); the spike asserts on this. */
  diagnostics: MockEngineDiagnostics = { system: undefined, messages: [] };

  /** The deterministic tool call this engine always makes. */
  private readonly plannedCall = {
    toolName: 'send_message',
    input: { to: 'bob', text: 'hello from the mock engine' },
  };

  async *run(input: EngineRunInput): AsyncIterable<EngineEvent> {
    this.diagnostics = { system: input.system, messages: [...input.messages] };
    const model = input.model.model ?? 'mock-model-v0';
    yield { kind: 'init', providerId: input.model.providerId, model };

    // (1) Read the history handed to us. This is the SAME RuntimeMessage[] the
    // first engine's turn produced — proof the session is continuous across a
    // provider switch.
    const priorCount = input.messages.length;
    yield {
      kind: 'text',
      role: 'assistant',
      text: `MockEngine resumed a session with ${priorCount} prior message(s).`,
    };

    // (2) Emit one tool call through the runtime gate.
    const toolCallId = `mock-${Date.now()}`;
    const call: ToolCall = {
      toolCallId,
      toolName: this.plannedCall.toolName,
      input: this.plannedCall.input,
    };
    yield {
      kind: 'tool_request',
      toolCallId,
      toolName: call.toolName,
      input: call.input,
    };

    const decision = await input.gate(call);
    yield {
      kind: 'gate_result',
      toolCallId,
      toolName: call.toolName,
      decision: decision.behavior,
      reason: decision.behavior === 'deny' ? decision.reason : undefined,
    };

    if (decision.behavior === 'deny') {
      yield {
        kind: 'text',
        role: 'assistant',
        text: `Tool blocked by gate: ${decision.reason}`,
      };
      yield { kind: 'result', ok: true };
      return;
    }

    // (3) Run the SAME runtime executor on the gate-approved input.
    const approvedInput = decision.input ?? call.input;
    const executor = input.executors[call.toolName];
    if (!executor) {
      yield {
        kind: 'error',
        message: `no executor for ${call.toolName}`,
        code: 'NO_EXECUTOR',
      };
      yield { kind: 'result', ok: false };
      return;
    }
    const output = await executor(approvedInput, {
      toolCall: { toolCallId, toolName: call.toolName, input: approvedInput },
      signal: input.signal,
    });
    yield {
      kind: 'tool_result',
      toolCallId,
      toolName: call.toolName,
      isError: !!output.isError,
      output,
    };

    // (4) Final text.
    yield {
      kind: 'text',
      role: 'assistant',
      text: 'MockEngine finished its turn.',
    };
    yield { kind: 'result', ok: true, costUsd: 0 };
  }
}
