// src/runtime/tools.ts
//
// Two test executors WE own (contract §2: tool schemas carry no execute; the
// runtime runs the executor after the gate). These are plain async functions
// `(input, ctx) => ToolOutput`. They are provider-independent and identical
// regardless of which engine surfaces the call — that shared identity is what
// SPIKE-07 asserts.
//
//   echo_note     — read-safe: returns its input text.
//   send_message  — outbound-irreversible: records that it "sent" a message to
//                   an in-memory outbox and returns a receipt. This is exactly
//                   the class of call the gate exists to guard.

import type { Executor, ToolOutput, ToolSchema } from './engine.js';

// ---------------------------------------------------------------------------
// send_message outbox — in-memory record of everything actually sent. A test
// asserts the executor never ran under a deny by checking this stays empty.
// ---------------------------------------------------------------------------

export type OutboxEntry = { to: string; text: string; at: number };

export class Outbox {
  private readonly entries: OutboxEntry[] = [];
  record(to: string, text: string): OutboxEntry {
    const e: OutboxEntry = { to, text, at: Date.now() };
    this.entries.push(e);
    return e;
  }
  all(): readonly OutboxEntry[] {
    return this.entries;
  }
  get size(): number {
    return this.entries.length;
  }
}

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

/** read-safe: echoes its input text back. */
export const echoNote: Executor = async (input): Promise<ToolOutput> => {
  const text = String(asRecord(input).text ?? '');
  return { content: text, data: { text } };
};

/** Build a send_message executor bound to a specific outbox. The binding is
 * done by the RUNTIME (not the engine), so the executor closes over its side
 * effect target without the engine knowing anything about it. */
export function makeSendMessage(outbox: Outbox): Executor {
  return async (input): Promise<ToolOutput> => {
    const rec = asRecord(input);
    const to = String(rec.to ?? '');
    const text = String(rec.text ?? '');
    const entry = outbox.record(to, text);
    return {
      content: `sent to ${to}: "${text}" (receipt ${entry.at})`,
      data: { receipt: entry },
    };
  };
}

// ---------------------------------------------------------------------------
// JSON-schema tool definitions (NO execute). The engine converts these to
// whatever its SDK needs; the runtime supplies the executors separately.
// ---------------------------------------------------------------------------

export const echoNoteSchema: ToolSchema = {
  name: 'echo_note',
  description: 'Echo a short note back verbatim. Read-safe; has no side effects.',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'The text to echo back.' },
    },
    required: ['text'],
  },
};

export const sendMessageSchema: ToolSchema = {
  name: 'send_message',
  description:
    'Send a message to a recipient. Outbound and irreversible once sent.',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient name.' },
      text: { type: 'string', description: 'Message body to send.' },
    },
    required: ['to', 'text'],
  },
};

/** Assemble the full runtime tool set for a session: the schemas the engine
 * surfaces, and the executor map keyed by bare tool name. Both are
 * provider-independent — the SAME objects are handed to every engine. */
export function buildToolset(outbox: Outbox): {
  toolSchemas: ToolSchema[];
  executors: Record<string, Executor>;
} {
  return {
    toolSchemas: [echoNoteSchema, sendMessageSchema],
    executors: {
      echo_note: echoNote,
      send_message: makeSendMessage(outbox),
    },
  };
}
