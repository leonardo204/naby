// src/spikes/spike-stream.ts
//
// Verification: THE ANSWER APPEARS WHILE IT IS BEING WRITTEN.
//
// Reported as "over a minute of thinking and no response at all". Two separate
// causes, and this covers the second: the Claude Agent SDK was never asked for
// partial messages, so it yielded only COMPLETE assistant messages and nothing
// reached the screen until a whole message finished. The shell already turned
// every text event into a `content_block_delta`, so the render path existed — the
// deltas did not.
//
// Asserted:
//   (a) The production options object asks for partial messages. This is the whole
//       fix in one flag, so it is asserted on the SAME function the engine calls.
//   (b) A text delta is read out of the raw provider event.
//   (c) A THINKING delta is NOT read as answer text — reasoning must not land in
//       the transcript as if it were the reply. It is read by its OWN function, so
//       the collapsed block gets it and the answer does not.
//   (d) Event shapes that carry no text yield '' rather than throwing: `stream_event`
//       wraps the provider's stream, whose shape is not ours to assume.

import {
  buildQueryOptions,
  readTextDelta,
  readThinkingDelta,
} from '../engines/claude-agent-sdk-engine.js';
import type { EngineRunInput } from '../runtime/engine.js';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

// -- (a) the option the engine actually sends ------------------------------
{
  const input = {
    model: { providerId: 'anthropic' },
    messages: [{ role: 'user' as const, content: 'hi' }],
    toolSchemas: [],
    executors: {},
    gate: async () => ({ behavior: 'allow' as const }),
    signal: new AbortController().signal,
  } as unknown as EngineRunInput;
  const opts = buildQueryOptions({
    input,
    mcpServer: {} as never,
    preToolUse: (async () => ({})) as never,
    abortController: new AbortController(),
    onStderr: () => {},
  }) as unknown as { includePartialMessages?: boolean };
  record(
    '(a) the production options ask the SDK for partial messages',
    opts.includePartialMessages === true,
    `includePartialMessages=${String(opts.includePartialMessages)}`,
  );
}

// -- (b)(c)(d) reading one delta ------------------------------------------
{
  const textDelta = {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
  };
  const thinkingDelta = {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
  };
  record(
    '(b) a text delta is read as text',
    readTextDelta(textDelta) === 'Hel',
    `-> "${readTextDelta(textDelta)}"`,
  );
  record(
    '(c) a thinking delta is not answer text, and IS read as reasoning',
    readTextDelta(thinkingDelta) === '' &&
      readThinkingDelta(thinkingDelta) === 'hmm' &&
      // And the reverse: an answer delta is not mistaken for reasoning, or the
      // collapsed block would duplicate the reply.
      readThinkingDelta(textDelta) === '',
    `asText="${readTextDelta(thinkingDelta)}" asThinking="${readThinkingDelta(thinkingDelta)}"; text delta asThinking="${readThinkingDelta(textDelta)}"`,
  );
  const empties: unknown[] = [
    {},
    { type: 'stream_event' },
    { type: 'stream_event', event: { type: 'message_start' } },
    { type: 'stream_event', event: { type: 'content_block_start', delta: null } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 7 } } },
    null,
    undefined,
  ];
  const bad = empties.filter((e) => readTextDelta(e) !== '' || readThinkingDelta(e) !== '');
  record(
    '(d) events with no text yield an empty string rather than throwing',
    bad.length === 0,
    bad.length === 0 ? `${empties.length} shapes all read as ''` : `LEAKED: ${JSON.stringify(bad)}`,
  );
}

let failed = 0;
for (const c of checks) {
  if (!c.pass) failed += 1;
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}\n      ${c.evidence}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
if (failed > 0) process.exitCode = 1;
