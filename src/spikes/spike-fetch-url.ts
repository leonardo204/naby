// src/spikes/spike-fetch-url.ts
//
// The fetch_url tool: the SSRF guard, the http(s)-only rule, HTML→text, and the
// happy path (with an injected fetch — no real network).

import {
  buildToolset,
  makeFetchUrl,
  fetchUrlSchema,
  isBlockedFetchHost,
  htmlToText,
  Outbox,
} from '../runtime-entry.js';

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

const ctx = { sessionId: 's', cwd: '/tmp' } as never;

// -- (a) the tool is in the default toolset ---------------------------------
{
  const { toolSchemas, executors } = buildToolset(new Outbox());
  const present = toolSchemas.some((t) => t.name === 'fetch_url') && typeof executors.fetch_url === 'function';
  check('(a) fetch_url is a default builtin tool', present, `present=${present} schemaName=${fetchUrlSchema.name}`);
}

// -- (b) SSRF guard: loopback / private / link-local literals are blocked ----
{
  const blocked = [
    'localhost',
    'app.localhost',
    '127.0.0.1',
    '0.0.0.0',
    '10.1.2.3',
    '192.168.0.5',
    '172.16.9.9',
    '172.31.255.1',
    '169.254.1.1',
    '::1',
    'fd00::1',
    'fe80::1',
  ];
  const allowed = ['example.com', 'naver.com', '8.8.8.8', '172.15.0.1', '172.32.0.1', 'sub.altimedia.com'];
  const allBlocked = blocked.every((h) => isBlockedFetchHost(h));
  const noneAllowedBlocked = allowed.every((h) => !isBlockedFetchHost(h));
  check(
    '(b) SSRF guard blocks loopback/private/link-local, allows public',
    allBlocked && noneAllowedBlocked,
    `blocked=${allBlocked} public-open=${noneAllowedBlocked}`,
  );
}

// -- (c) executor rejects non-http + blocked host WITHOUT fetching -----------
await (async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls++;
    return new Response('should not be called', { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const exec = makeFetchUrl(fakeFetch);
  const badScheme = await exec({ url: 'file:///etc/passwd' }, ctx);
  const localhost = await exec({ url: 'http://127.0.0.1:8080/secret' }, ctx);
  const notUrl = await exec({ url: 'not a url' }, ctx);
  check(
    '(c) file://, localhost, and non-URL are refused and never fetched',
    badScheme.isError === true && localhost.isError === true && notUrl.isError === true && calls === 0,
    `errs=${badScheme.isError}/${localhost.isError}/${notUrl.isError} fetchCalls=${calls}`,
  );
})();

// -- (d) happy path: fetch + HTML→text + truncation -------------------------
await (async () => {
  const html =
    '<html><head><style>x{}</style><script>bad()</script></head><body><h1>Top</h1><p>Hello &amp; welcome</p></body></html>';
  const fakeFetch = (async () =>
    new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })) as unknown as typeof globalThis.fetch;
  const out = await makeFetchUrl(fakeFetch)({ url: 'https://example.com/news' }, ctx);
  const ok =
    !out.isError &&
    /Top/.test(out.content) &&
    /Hello & welcome/.test(out.content) &&
    !/bad\(\)/.test(out.content) && // script stripped
    !/<h1>/.test(out.content); // tags stripped
  check('(d) happy path fetches, strips script/tags, decodes entities', ok, `content="${out.content.replace(/\n/g, ' ').slice(0, 70)}…"`);
})();

// -- (e) htmlToText basics ---------------------------------------------------
{
  const t = htmlToText('<p>a</p><p>b</p><script>x</script>');
  const ok = /a/.test(t) && /b/.test(t) && !/x/.test(t);
  check('(e) htmlToText drops script and keeps text', ok, `"${t.replace(/\n/g, '\\n')}"`);
}

// -- (f) non-2xx is surfaced as an error ------------------------------------
await (async () => {
  const fakeFetch = (async () =>
    new Response('nope', { status: 404, statusText: 'Not Found' })) as unknown as typeof globalThis.fetch;
  const out = await makeFetchUrl(fakeFetch)({ url: 'https://example.com/missing' }, ctx);
  check('(f) HTTP 404 → isError with status', out.isError === true, `isError=${out.isError} content="${out.content.slice(0, 40)}…"`);
})();

console.log('');
if (failed === 0) {
  console.log(`SPIKE-FETCH-URL: ALL PASS (${passed}/${passed})`);
} else {
  console.error(`SPIKE-FETCH-URL: ${failed} FAILED (${passed}/${passed + failed})`);
  process.exit(1);
}
