// src/spikes/spike-multimodal.ts
//
// Image (multimodal) input reaches BOTH engines: the ai-sdk projection builds
// image content parts, and the dev-claude prompt builder yields a one-shot
// SDKUserMessage with Anthropic base64 image blocks. Text-only turns are
// byte-identical to before (no regression).

import { toModelMessages } from '../engines/ai-sdk-engine.js';
import { buildAgentPrompt } from '../engines/claude-agent-sdk-engine.js';
import type { RuntimeMessage } from '../runtime/engine.js';

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, evidence: string): void {
  if (ok) {
    passed++;
    console.log(`[PASS] ${name}\n        ${evidence}`);
  } else {
    failed++;
    console.error(`[FAIL] ${name}\n        ${evidence}`);
  }
}

const IMG = { media_type: 'image/png', data: 'AAAABBBB' };

// -- (a) ai-sdk: user WITH images -> text + image parts ----------------------
{
  const msgs: RuntimeMessage[] = [{ role: 'user', content: 'what is this?', images: [IMG] }];
  const out = toModelMessages(msgs);
  const u = out[0] as { role: string; content: unknown };
  const parts = Array.isArray(u.content) ? (u.content as { type: string; text?: string; image?: string }[]) : null;
  const textPart = parts?.find((p) => p.type === 'text');
  const imagePart = parts?.find((p) => p.type === 'image');
  const ok =
    u.role === 'user' &&
    !!parts &&
    textPart?.text === 'what is this?' &&
    typeof imagePart?.image === 'string' &&
    imagePart.image === 'data:image/png;base64,AAAABBBB';
  check('(a) ai-sdk: user with images -> [text, image(dataURL)] parts', ok, `parts=${parts?.map((p) => p.type).join(',')} img=${imagePart?.image?.slice(0, 24)}`);
}

// -- (b) ai-sdk: user WITHOUT images -> plain string (no regression) ---------
{
  const out = toModelMessages([{ role: 'user', content: 'hello' }]);
  const u = out[0] as { role: string; content: unknown };
  check('(b) ai-sdk: text-only user stays a string', u.content === 'hello', `content=${JSON.stringify(u.content)}`);
}

// -- (c) dev-claude: text-only -> string prompt -----------------------------
{
  const p = buildAgentPrompt([{ role: 'user', content: 'hello' }]);
  check('(c) dev-claude: text-only -> string prompt', typeof p === 'string' && /hello/.test(p as string), `type=${typeof p}`);
}

// -- (d) dev-claude: with images -> AsyncIterable<SDKUserMessage> w/ image block
await (async () => {
  const p = buildAgentPrompt([{ role: 'user', content: 'describe', images: [IMG] }]);
  const isIterable = typeof p !== 'string' && typeof (p as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function';
  let yielded: { type?: string; message?: { role?: string; content?: unknown } } | null = null;
  if (isIterable) {
    for await (const m of p as AsyncIterable<typeof yielded>) {
      yielded = m;
      break;
    }
  }
  const content = Array.isArray(yielded?.message?.content)
    ? (yielded!.message!.content as { type: string; text?: string; source?: { type?: string; media_type?: string; data?: string } }[])
    : null;
  const textBlock = content?.find((b) => b.type === 'text');
  const imageBlock = content?.find((b) => b.type === 'image');
  const ok =
    isIterable &&
    yielded?.type === 'user' &&
    yielded?.message?.role === 'user' &&
    textBlock?.text?.includes('describe') === true &&
    imageBlock?.source?.type === 'base64' &&
    imageBlock?.source?.media_type === 'image/png' &&
    imageBlock?.source?.data === 'AAAABBBB';
  check(
    '(d) dev-claude: images -> AsyncIterable w/ text + base64 image block',
    ok,
    `iterable=${isIterable} blocks=${content?.map((b) => b.type).join(',')} media=${imageBlock?.source?.media_type}`,
  );
})();

console.log('');
if (failed === 0) {
  console.log(`SPIKE-MULTIMODAL: ALL PASS (${passed}/${passed})`);
} else {
  console.error(`SPIKE-MULTIMODAL: ${failed} FAILED (${passed}/${passed + failed})`);
  process.exit(1);
}
