// src/spikes/spike-add-mcp.ts
//
// The `naby_add_mcp` agent tool + the proposed/enabled MCP status model.
//
// Asserts the SAFE-BY-CONSTRUCTION contract:
//   (a) buildToolset exposes naby_add_mcp ONLY when a store sink is supplied.
//   (b) the executor writes every add as a PROPOSAL (status:'proposed') — never
//       enabled — and returns a non-error "needs approval" message.
//   (c) invalid input (bad transport / missing url / missing command) is a clean
//       tool error and NEVER touches the store.
//   (d) isMcpEntryActive excludes proposals (so the engine never loads them) and
//       includes enabled / status-less entries.

import {
  buildToolset,
  makeAddMcp,
  ADD_MCP_TOOL_NAME,
  Outbox,
  isMcpEntryActive,
  type McpEntry,
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

// A fake sink that records upserts.
function fakeSink() {
  const writes: McpEntry[] = [];
  return { upsertMcpEntry: (e: McpEntry) => void writes.push(e), writes };
}

const ctx = { sessionId: 's', cwd: '/tmp' } as never;

// -- (a) tool presence is gated on the sink ---------------------------------
{
  const without = buildToolset(new Outbox());
  const withSink = buildToolset(new Outbox(), fakeSink());
  const nameIn = (ts: { name: string }[]) => ts.some((t) => t.name === ADD_MCP_TOOL_NAME);
  const ok =
    !nameIn(without.toolSchemas) &&
    without.executors[ADD_MCP_TOOL_NAME] === undefined &&
    nameIn(withSink.toolSchemas) &&
    typeof withSink.executors[ADD_MCP_TOOL_NAME] === 'function';
  check(
    '(a) buildToolset exposes naby_add_mcp only WITH a store sink',
    ok,
    `without=${nameIn(without.toolSchemas)} with=${nameIn(withSink.toolSchemas)}`,
  );
}

// -- (b) a valid add lands as a PROPOSAL ------------------------------------
await (async () => {
  const sink = fakeSink();
  const exec = makeAddMcp(sink);
  const out = await exec(
    { name: 'skill-hub', transport: 'http', url: 'https://skillhub.example/mcp', headers: { Authorization: 'Bearer x' } },
    ctx,
  );
  const wrote = sink.writes[0];
  const ok =
    !out.isError &&
    sink.writes.length === 1 &&
    wrote?.name === 'skill-hub' &&
    wrote?.transport === 'http' &&
    wrote?.status === 'proposed' &&
    // secrets are carried through to the store (redaction happens on read, not here)
    (wrote as { headers?: Record<string, string> }).headers?.Authorization === 'Bearer x' &&
    /approve/i.test(out.content);
  check(
    '(b) valid add stores status:proposed and asks for approval',
    ok,
    `status=${wrote?.status} isError=${out.isError} msg="${out.content.slice(0, 48)}…"`,
  );
})();

// -- (b2) stdio add proposes too --------------------------------------------
await (async () => {
  const sink = fakeSink();
  const out = await makeAddMcp(sink)(
    { name: 'local', transport: 'stdio', command: 'npx', args: ['-y', '@x/mcp'] },
    ctx,
  );
  const wrote = sink.writes[0] as { transport?: string; command?: string; args?: string[]; status?: string };
  const ok =
    !out.isError &&
    wrote?.transport === 'stdio' &&
    wrote?.command === 'npx' &&
    Array.isArray(wrote?.args) &&
    wrote?.status === 'proposed';
  check('(b2) stdio add stores command/args as proposal', ok, `command=${wrote?.command} args=${JSON.stringify(wrote?.args)}`);
})();

// -- (c) invalid input is a clean error and never writes --------------------
await (async () => {
  const badTransport = fakeSink();
  const o1 = await makeAddMcp(badTransport)({ name: 'x', transport: 'carrier-pigeon' }, ctx);
  const missingUrl = fakeSink();
  const o2 = await makeAddMcp(missingUrl)({ name: 'x', transport: 'http' }, ctx);
  const missingCmd = fakeSink();
  const o3 = await makeAddMcp(missingCmd)({ name: 'x', transport: 'stdio' }, ctx);
  const ok =
    o1.isError === true &&
    badTransport.writes.length === 0 &&
    o2.isError === true &&
    missingUrl.writes.length === 0 &&
    o3.isError === true &&
    missingCmd.writes.length === 0;
  check(
    '(c) invalid transport / missing url / missing command → error, no store write',
    ok,
    `errs=${o1.isError}/${o2.isError}/${o3.isError} writes=${badTransport.writes.length}/${missingUrl.writes.length}/${missingCmd.writes.length}`,
  );
})();

// -- (d) isMcpEntryActive excludes proposals --------------------------------
{
  const proposed: McpEntry = { name: 'p', transport: 'http', url: 'https://h/mcp', status: 'proposed' };
  const enabled: McpEntry = { name: 'e', transport: 'http', url: 'https://h/mcp', status: 'enabled' };
  const legacy: McpEntry = { name: 'l', transport: 'http', url: 'https://h/mcp' };
  const ok = !isMcpEntryActive(proposed) && isMcpEntryActive(enabled) && isMcpEntryActive(legacy);
  check(
    '(d) isMcpEntryActive: proposed→false, enabled→true, status-less(legacy)→true',
    ok,
    `proposed=${isMcpEntryActive(proposed)} enabled=${isMcpEntryActive(enabled)} legacy=${isMcpEntryActive(legacy)}`,
  );
}

console.log('');
if (failed === 0) {
  console.log(`SPIKE-ADD-MCP: ALL PASS (${passed}/${passed})`);
} else {
  console.error(`SPIKE-ADD-MCP: ${failed} FAILED (${passed}/${passed + failed})`);
  process.exit(1);
}
