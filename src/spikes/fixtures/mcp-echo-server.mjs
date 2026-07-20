// src/spikes/fixtures/mcp-echo-server.mjs
//
// A REAL MCP server over stdio, for spike-f108.
//
// WHY HAND-ROLLED AND NOT `@modelcontextprotocol/sdk`: the thing under test is
// our client path (`listTools()` / `callTool()` and the gate in front of it),
// and a fixture that shares a library with the code under test can hide a
// protocol mistake behind a matched pair of bugs. Speaking the wire protocol
// directly — newline-delimited JSON-RPC 2.0 — means the spike proves we talk to
// an MCP server, not that we talk to ourselves. It also adds no dependency.
//
// It records every tools/call it receives to NABY_SPIKE_MCP_LOG. That file is
// the evidence for the assertion that matters most: under a gate DENY the
// server must never be contacted at all. "No tool result appeared" only proves
// we did not surface one; an empty log proves nothing ran.

import { appendFileSync } from 'node:fs';

const LOG = process.env.NABY_SPIKE_MCP_LOG;

function record(event) {
  if (!LOG) return;
  appendFileSync(LOG, `${JSON.stringify(event)}\n`);
}

const TOOLS = [
  {
    name: 'mcp_echo',
    description: 'Echo text back. Read-safe; used to prove MCP calls are gated.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo.' } },
      required: ['text'],
    },
  },
  {
    name: 'mcp_danger',
    description: 'Pretends to do something irreversible. Used to prove deny blocks it.',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string', description: 'What to act on.' } },
      required: ['target'],
    },
  },
];

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(msg) {
  const { id, method, params } = msg;

  // Notifications carry no id and get no response.
  if (id === undefined || id === null) return;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        // Echo the client's version back — this fixture is compatible with
        // whatever revision the ai-sdk client negotiates.
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'naby-spike-echo', version: '0.0.0' },
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
    // THE EVIDENCE FILE. Written BEFORE any decision about what to return, so a
    // call cannot reach this server without leaving a trace.
    record({ at: Date.now(), name, args });

    if (name === 'mcp_echo') {
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `mcp-echo:${args.text ?? ''}` }] },
      });
      return;
    }
    if (name === 'mcp_danger') {
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: `DID THE DANGEROUS THING to ${args.target ?? ''}` }] },
      });
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
        // A malformed line is ignored rather than fatal — the client is the
        // thing under test, and killing the server would mask its behaviour.
      }
    }
    index = buffer.indexOf('\n');
  }
});

process.stdin.on('end', () => process.exit(0));
