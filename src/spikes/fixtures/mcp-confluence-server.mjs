// src/spikes/fixtures/mcp-confluence-server.mjs
//
// A REAL MCP server over stdio that answers to the official Atlassian MCP's
// Confluence tool NAMES (`createConfluencePage`, `updateConfluencePage`,
// `getConfluencePage`), for spike-org-harness-metrics (org-harness-sync §3.7).
//
// The metrics script decides the "기록" stage from the tool name alone
// (`^mcp__.*__(…|(create|update)ConfluencePage)$`), so a local server under any
// name is enough to prove the stage — and it keeps the spike off the network and
// away from the special `atlassian` row (OAuth, gate). Same hand-rolled
// newline-delimited JSON-RPC as mcp-echo-server.mjs, for the same reason.

const TOOLS = [
  {
    name: 'createConfluencePage',
    description: 'Create a Confluence page (spike stand-in; writes nothing).',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, body: { type: 'string' } },
      required: ['title'],
    },
  },
  {
    name: 'updateConfluencePage',
    description: 'Update a Confluence page (spike stand-in; writes nothing).',
    inputSchema: {
      type: 'object',
      properties: { pageId: { type: 'string' }, body: { type: 'string' } },
      required: ['pageId'],
    },
  },
  {
    name: 'getConfluencePage',
    description: 'Read a Confluence page (spike stand-in).',
    annotations: { title: 'Get page', readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: { pageId: { type: 'string' } },
      required: ['pageId'],
    },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'naby-spike-confluence', version: '0.0.0' },
      },
    });
    return;
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (TOOLS.some((t) => t.name === name)) {
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `${name}:ok:${JSON.stringify(args).length}` }] } });
      return;
    }
    send({ jsonrpc: '2.0', id, error: { code: -32602, message: `no such tool: ${name}` } });
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch {
        /* ignored, as in mcp-echo-server.mjs */
      }
    }
    index = buffer.indexOf('\n');
  }
});
process.stdin.on('end', () => process.exit(0));
