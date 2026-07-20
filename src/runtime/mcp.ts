// src/runtime/mcp.ts
//
// F1-08 — MCP servers, loaded THROUGH the gate rather than around it.
//
// THE ONE THING THAT MUST NOT HAPPEN
// ----------------------------------
// `@ai-sdk/mcp`'s `client.tools()` returns AI-SDK tools with an `execute` bound
// to the MCP call. Handing those to a model means the SDK runs them itself, at
// which point our gate is not "bypassed" so much as absent — there is no code
// path on which it would have been consulted. That is precisely the failure the
// product exists to prevent (contract §3 invariant 3), and it would be a silent
// one: everything would appear to work.
//
// So this module NEVER calls `tools()`. It calls:
//
//   listTools()  -> schemas ONLY, converted into our engine-agnostic ToolSchema
//                   (which by construction carries no `execute`; contract §2)
//   callTool()   -> invoked from a runtime Executor, i.e. only ever from the
//                   place the runtime reaches AFTER the gate has returned allow
//
// The result is that an MCP tool is indistinguishable from one of our own
// built-in tools as far as the gate is concerned. It is not gated by a rule we
// remembered to apply; it is gated because the only path from model to MCP
// server runs through `Executor`, and the runtime runs the gate before every
// executor. `assertMcpToolsAreGateable()` below turns that into a check a spike
// can assert rather than a property we assert in prose.
//
// PROVIDER-INDEPENDENCE (contract §5): nothing here knows which provider is
// selected, and the registry it reads (`Store.listMcpEntries`) has no provider
// dimension. The same servers and the same tools are present whichever engine
// runs — which is the property SPIKE-07 protects.

import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport as StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import type { Executor, JsonSchema, ToolOutput, ToolSchema } from './engine.js';
import type { McpEntry } from './store/store.js';

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------
//
// Two MCP servers may each expose a tool called `search`, and our executor map
// is keyed by BARE tool name — so a collision would silently shadow one server
// with the other. Names are therefore namespaced `<server>__<tool>`.
//
// The separator is deliberately `__`: `ClaudeAgentSdkEngine` normalizes
// `mcp__<server>__<tool>` by dropping the first two segments, so a tool we call
// `weather__forecast` arrives back from the SDK as `mcp__nabytools__weather__forecast`
// and normalizes to `weather__forecast` again. Any other separator would break
// that round trip.

/** Providers accept `^[a-zA-Z0-9_-]{1,64}$` for a tool name. Anything else is
 *  replaced rather than rejected, so a server with an exotic name still works. */
function sanitizeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function qualifiedToolName(serverName: string, toolName: string): string {
  return `${sanitizeSegment(serverName)}__${sanitizeSegment(toolName)}`.slice(0, 64);
}

// ---------------------------------------------------------------------------
// Schema conversion — MCP JSON Schema -> our JsonSchema subset
// ---------------------------------------------------------------------------
//
// Narrowing, not widening: anything we do not model is dropped rather than
// passed through, so a malformed or hostile schema from an MCP server cannot
// reach a provider's tool-definition validator intact.

const SCALARS = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);

export function toRuntimeJsonSchema(raw: unknown): JsonSchema {
  if (!raw || typeof raw !== 'object') return { type: 'object', properties: {} };
  const r = raw as Record<string, unknown>;
  const out: JsonSchema = {};

  if (typeof r.type === 'string' && SCALARS.has(r.type)) {
    out.type = r.type as JsonSchema['type'];
  }
  if (typeof r.description === 'string') out.description = r.description;
  if (Array.isArray(r.enum)) out.enum = [...r.enum];
  if (r.items !== undefined) out.items = toRuntimeJsonSchema(r.items);
  if (r.properties && typeof r.properties === 'object') {
    const props: Record<string, JsonSchema> = {};
    for (const [k, v] of Object.entries(r.properties as Record<string, unknown>)) {
      props[k] = toRuntimeJsonSchema(v);
    }
    out.properties = props;
    if (!out.type) out.type = 'object';
  }
  if (Array.isArray(r.required)) {
    out.required = r.required.filter((x): x is string => typeof x === 'string');
  }
  if (!out.type) out.type = 'object';
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}

// ---------------------------------------------------------------------------
// Result conversion — MCP CallToolResult -> our ToolOutput
// ---------------------------------------------------------------------------

type McpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: string; [k: string]: unknown };

/** The text the MODEL sees. Non-text blocks are described rather than inlined —
 *  base64 image bytes in a tool result would blow the context window. */
function renderContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as McpContentBlock[]) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'image') {
      parts.push(`[image: ${String(block.mimeType ?? 'unknown type')}]`);
    } else if (block.type === 'resource') {
      const res = block.resource as { uri?: string; text?: string } | undefined;
      parts.push(res?.text ?? `[resource: ${String(res?.uri ?? 'unknown')}]`);
    } else {
      parts.push(`[${String(block.type)}]`);
    }
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Tool pinning + drift detection (contract §5)
// ---------------------------------------------------------------------------

/** A stable digest of a tool set's SHAPE (names + schemas), so a server that
 *  changes a tool between connects can be detected rather than trusted. */
export function fingerprintTools(schemas: readonly ToolSchema[]): string {
  const canonical = [...schemas]
    .map((s) => ({ n: s.name, d: s.description, p: s.parameters }))
    .sort((a, b) => a.n.localeCompare(b.n));
  const json = JSON.stringify(canonical);
  // A small non-cryptographic digest: this detects accidental and observable
  // drift, which is what the contract asks for. It is NOT a security boundary —
  // the gate is, and it runs on every call regardless of this value.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < json.length; i += 1) {
    const c = json.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/** Human-readable description of what changed between two tool sets. */
export function detectToolDrift(
  previous: readonly ToolSchema[],
  next: readonly ToolSchema[],
): string[] {
  const drift: string[] = [];
  const prev = new Map(previous.map((s) => [s.name, s]));
  const cur = new Map(next.map((s) => [s.name, s]));
  for (const name of prev.keys()) if (!cur.has(name)) drift.push(`removed: ${name}`);
  for (const name of cur.keys()) if (!prev.has(name)) drift.push(`added: ${name}`);
  for (const [name, before] of prev) {
    const after = cur.get(name);
    if (!after) continue;
    if (JSON.stringify(before.parameters) !== JSON.stringify(after.parameters)) {
      drift.push(`schema changed: ${name}`);
    }
    if (before.description !== after.description) {
      drift.push(`description changed: ${name}`);
    }
  }
  return drift;
}

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------

/** The contract says a `timeoutMs` below 1000 is ignored. */
const MIN_TIMEOUT_MS = 1000;
const DEFAULT_TIMEOUT_MS = 30_000;

function timeoutFor(entry: McpEntry): number {
  if (entry.transport === 'stdio') return DEFAULT_TIMEOUT_MS;
  const t = entry.timeoutMs;
  if (typeof t !== 'number' || t < MIN_TIMEOUT_MS) return DEFAULT_TIMEOUT_MS;
  return t;
}

export type McpConnection = {
  entry: McpEntry;
  /** Execute-less schemas, namespaced. Safe to hand any engine. */
  toolSchemas: ToolSchema[];
  /** Executors keyed by the SAME namespaced names. The runtime gates each. */
  executors: Record<string, Executor>;
  /** Shape digest, for drift detection across reconnects. */
  fingerprint: string;
  /** The server's own reported name/version, for the UI. */
  serverInfo: { name?: string; version?: string };
  close(): Promise<void>;
};

type McpClient = Awaited<ReturnType<typeof createMCPClient>>;

async function openClient(entry: McpEntry): Promise<McpClient> {
  if (entry.transport === 'stdio') {
    return createMCPClient({
      transport: new StdioMCPTransport({
        command: entry.command,
        ...(entry.args ? { args: entry.args } : {}),
        ...(entry.env ? { env: entry.env } : {}),
      }),
      clientName: 'naby',
    });
  }
  return createMCPClient({
    transport: {
      type: entry.transport,
      url: entry.url,
      ...(entry.headers ? { headers: entry.headers } : {}),
    },
    clientName: 'naby',
  });
}

/**
 * Connect one MCP server and build its GATEABLE toolset.
 *
 * Every tool comes back as a `ToolSchema` (no execute) plus an `Executor`. The
 * executor is the ONLY thing that can reach `callTool`, and the runtime never
 * invokes an executor without first awaiting the gate — so there is no arrangement
 * of these two values that results in an ungated MCP call.
 */
export async function connectMcpServer(entry: McpEntry): Promise<McpConnection> {
  const client = await openClient(entry);
  const timeout = timeoutFor(entry);

  // listTools(), NOT tools(). See the header.
  const listed = await client.listTools();

  const toolSchemas: ToolSchema[] = [];
  const executors: Record<string, Executor> = {};

  for (const t of listed.tools) {
    const qualified = qualifiedToolName(entry.name, t.name);
    toolSchemas.push({
      name: qualified,
      description: t.description ?? `${t.name} (from MCP server "${entry.name}")`,
      parameters: toRuntimeJsonSchema(t.inputSchema),
    });

    // The remote name is captured HERE, at load time, and is what callTool is
    // given. The model can only ever name the qualified alias, so it cannot
    // steer a call at a different remote tool by renaming its own request.
    const remoteName = t.name;
    executors[qualified] = async (input, ctx): Promise<ToolOutput> => {
      try {
        const result = await client.callTool({
          name: remoteName,
          arguments: (input && typeof input === 'object'
            ? (input as Record<string, unknown>)
            : {}),
          options: { signal: ctx.signal, timeout },
        });
        const content = renderContent((result as { content?: unknown }).content);
        const isError = (result as { isError?: boolean }).isError === true;
        return {
          content: content || (isError ? 'The MCP tool reported an error.' : ''),
          isError,
          data: { server: entry.name, tool: remoteName },
        };
      } catch (e) {
        // A transport failure must not take the turn down — the model gets a
        // tool error and can react, exactly as with any other failing tool.
        return {
          content: `MCP tool "${remoteName}" on server "${entry.name}" failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
          isError: true,
        };
      }
    };
  }

  const info = (client.serverInfo ?? {}) as { name?: string; version?: string };

  return {
    entry,
    toolSchemas,
    executors,
    fingerprint: fingerprintTools(toolSchemas),
    serverInfo: { ...(info.name ? { name: info.name } : {}), ...(info.version ? { version: info.version } : {}) },
    close: () => client.close(),
  };
}

// ---------------------------------------------------------------------------
// Loading the whole registry
// ---------------------------------------------------------------------------

export type McpLoadResult = {
  toolSchemas: ToolSchema[];
  executors: Record<string, Executor>;
  connections: McpConnection[];
  /** Servers that could not be reached. Never throws the turn away for one. */
  failures: { name: string; message: string }[];
  closeAll(): Promise<void>;
};

/**
 * Connect every configured MCP server and merge their toolsets.
 *
 * A server that is down is a FAILURE ENTRY, not an exception: one unreachable
 * MCP server must not stop the user from chatting, and the UI can show which
 * one is broken. This mirrors how `resolveProviderCredential` skips a
 * half-configured provider rather than failing the whole resolution.
 */
export async function loadMcpToolset(
  entries: readonly McpEntry[],
): Promise<McpLoadResult> {
  const connections: McpConnection[] = [];
  const failures: { name: string; message: string }[] = [];

  for (const entry of entries) {
    try {
      connections.push(await connectMcpServer(entry));
    } catch (e) {
      failures.push({
        name: entry.name,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const toolSchemas: ToolSchema[] = [];
  const executors: Record<string, Executor> = {};
  for (const c of connections) {
    toolSchemas.push(...c.toolSchemas);
    Object.assign(executors, c.executors);
  }

  return {
    toolSchemas,
    executors,
    connections,
    failures,
    closeAll: async (): Promise<void> => {
      await Promise.allSettled(connections.map((c) => c.close()));
    },
  };
}

// ---------------------------------------------------------------------------
// The invariant, as a check
// ---------------------------------------------------------------------------

/**
 * Assert that a loaded MCP toolset is gateable: every schema is execute-less and
 * every tool has exactly one executor the runtime can hold behind the gate.
 *
 * This exists so contract §3 invariant 3 is verified by a spike rather than
 * argued in a comment. Returns the problems it found; empty means sound.
 */
export function assertMcpToolsAreGateable(load: {
  toolSchemas: readonly ToolSchema[];
  executors: Record<string, Executor>;
}): string[] {
  const problems: string[] = [];
  for (const schema of load.toolSchemas) {
    // A ToolSchema has no `execute` field in its type; this catches an object
    // that acquired one at runtime (e.g. an AI-SDK tool leaking in from
    // `tools()`), which is the failure mode that matters.
    if ('execute' in (schema as object)) {
      problems.push(`${schema.name}: schema carries an execute (auto-executing tool)`);
    }
    if (!load.executors[schema.name]) {
      problems.push(`${schema.name}: no runtime executor — the call could not be dispatched`);
    }
  }
  for (const name of Object.keys(load.executors)) {
    if (!load.toolSchemas.some((s) => s.name === name)) {
      problems.push(`${name}: executor with no declared schema`);
    }
  }
  return problems;
}

/** Validation for an entry coming from the UI (F1-08 CRUD). Returns problems. */
export function validateMcpEntry(entry: unknown): string[] {
  const problems: string[] = [];
  if (!entry || typeof entry !== 'object') return ['not an object'];
  const e = entry as Record<string, unknown>;
  if (typeof e.name !== 'string' || !e.name.trim()) problems.push('name is required');
  if (e.transport === 'stdio') {
    if (typeof e.command !== 'string' || !e.command.trim()) {
      problems.push('command is required for a stdio server');
    }
    if (e.args !== undefined && !Array.isArray(e.args)) problems.push('args must be a list');
  } else if (e.transport === 'http' || e.transport === 'sse') {
    if (typeof e.url !== 'string' || !e.url.trim()) {
      problems.push('url is required for an http/sse server');
    } else {
      try {
        // eslint-disable-next-line no-new
        new URL(e.url);
      } catch {
        problems.push(`"${e.url}" is not a valid URL`);
      }
    }
  } else {
    problems.push('transport must be one of: stdio, http, sse');
  }
  return problems;
}
