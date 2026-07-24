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
import type { McpEntry } from './store/store.js';
import { validateMcpEntry } from './mcp.js';

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
// fetch_url — read a public web page/API so the model can answer about current
// web content the user references. WITHOUT this the model has NO way to reach the
// web (it is not a network bug — there was simply no tool), so it correctly says
// "I can't open web pages." Read-only GET, provider-independent, on every engine.
//
// SSRF GUARD (this app binds a token-protected loopback server — never let the
// model aim a fetch at it or the private network): http/https only, and the host
// must not be localhost / a loopback / link-local / private-range literal. This
// is a literal check (no DNS rebinding defense) — enough for a dev convenience
// tool; a hardened version would also re-validate every redirect hop's resolved
// IP.
// ---------------------------------------------------------------------------

/** True for a host we must NOT fetch — loopback, link-local, or private ranges,
 *  by literal (localhost + RFC1918 / RFC4193 / etc.). Not a DNS-resolving check. */
export function isBlockedFetchHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (!h || h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '0.0.0.0' || h === '::' || h === '::1') return true;
  if (h.startsWith('127.') || h.startsWith('10.') || h.startsWith('192.168.')) return true;
  if (h.startsWith('169.254.')) return true; // link-local
  // 172.16.0.0 – 172.31.255.255
  const m = /^172\.(\d{1,3})\./.exec(h);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10)
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe8') || h.startsWith('fe9') || h.startsWith('fea') || h.startsWith('feb')) return true;
  return false;
}

/** Strip HTML to readable text: drop script/style, tags → space, decode a few
 *  common entities, collapse whitespace. Cheap and lossy — enough for the model
 *  to read an article without drowning in markup. Non-HTML passes through. */
export function htmlToText(input: string): string {
  let s = input
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br)\s*>/gi, '\n')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return s.replace(/[ \t\f\v]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
}

const FETCH_URL_DEFAULT_MAX = 20_000;
const FETCH_URL_HARD_MAX = 100_000;
const FETCH_URL_TIMEOUT_MS = 15_000;

/** Build the fetch_url executor. `fetchImpl` is injectable for tests. */
export function makeFetchUrl(fetchImpl: typeof globalThis.fetch = globalThis.fetch): Executor {
  return async (input): Promise<ToolOutput> => {
    const rec = asRecord(input);
    const rawUrl = String(rec.url ?? '').trim();
    const maxChars = Math.min(
      typeof rec.maxChars === 'number' && rec.maxChars > 0 ? rec.maxChars : FETCH_URL_DEFAULT_MAX,
      FETCH_URL_HARD_MAX,
    );
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { content: `"${rawUrl}" is not a valid URL.`, isError: true };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { content: `Only http/https URLs can be fetched (got "${url.protocol}").`, isError: true };
    }
    if (isBlockedFetchHost(url.hostname)) {
      return {
        content: `Refusing to fetch "${url.hostname}" — localhost and private-network addresses are not allowed.`,
        isError: true,
      };
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_URL_TIMEOUT_MS);
    try {
      const res = await fetchImpl(url.toString(), {
        method: 'GET',
        redirect: 'follow',
        signal: ctl.signal,
        headers: { 'user-agent': 'naby/fetch_url', accept: 'text/html,text/plain,application/json,*/*' },
      });
      const ctype = res.headers.get('content-type') ?? '';
      const raw = await res.text();
      const body = /html/i.test(ctype) ? htmlToText(raw) : raw.trim();
      const clipped = body.length > maxChars ? `${body.slice(0, maxChars)}\n…[truncated]` : body;
      if (!res.ok) {
        return {
          content: `HTTP ${res.status} ${res.statusText} from ${url.toString()}\n${clipped.slice(0, 2000)}`,
          isError: true,
          data: { status: res.status },
        };
      }
      return {
        content: `# ${url.toString()} (HTTP ${res.status})\n\n${clipped}`,
        data: { status: res.status, contentType: ctype, chars: clipped.length },
      };
    } catch (e) {
      const msg = e instanceof Error && e.name === 'AbortError' ? 'request timed out' : e instanceof Error ? e.message : String(e);
      return { content: `Could not fetch ${url.toString()}: ${msg}`, isError: true };
    } finally {
      clearTimeout(timer);
    }
  };
}

export const fetchUrlSchema: ToolSchema = {
  name: 'fetch_url',
  description:
    'Fetch a PUBLIC web page or HTTP API by URL and return its text, so you can read and summarize ' +
    'current web content the user points you at (news, docs, an API response). Read-only HTTP(S) GET. ' +
    'Cannot reach localhost or private networks. Use this whenever the user asks you to open/read a URL.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The absolute http(s) URL to fetch.' },
      maxChars: {
        type: 'number',
        description: `Max characters of text to return (default ${FETCH_URL_DEFAULT_MAX}).`,
      },
    },
    required: ['url'],
  },
};

// ---------------------------------------------------------------------------
// naby_add_mcp — the agent registers an MCP server ON THE USER'S BEHALF.
//
// This is the one runtime tool that MUTATES Naby-layer state. It is deliberately
// SAFE-BY-CONSTRUCTION: it never activates anything. It writes the entry as a
// PROPOSAL (`status:'proposed'`), which Settings shows but the engine never loads
// into the toolset — the user must explicitly approve it (mcp.approve) before its
// tools go live. That mirrors the trust rule that external-origin harness/memory
// lands disabled (trust.ts / harness-gate.ts): the agent may PROPOSE a
// credential-bearing server, but only a human turns it on. MCP connection details
// (transport, command/url, secrets) come from the conversation — when they are
// missing or invalid the executor says so and the model asks the user for them.
// ---------------------------------------------------------------------------

/** The minimal store surface the add-mcp executor needs. The engine passes the
 *  real store; a test passes a fake. Keeps tools.ts from depending on the whole
 *  store implementation. */
export interface McpProposalSink {
  upsertMcpEntry(entry: McpEntry): void;
}

/** The bare name of the add-mcp tool — also the gate/allowlist key. */
export const ADD_MCP_TOOL_NAME = 'naby_add_mcp';

function optStringRecord(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = String(val);
  return Object.keys(out).length ? out : undefined;
}

function optStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map((x) => String(x));
}

/** Build the add-mcp executor bound to a store sink. Every add lands as a
 *  PROPOSAL; the returned message tells the model to have the user approve it. */
export function makeAddMcp(sink: McpProposalSink): Executor {
  return async (input): Promise<ToolOutput> => {
    const rec = asRecord(input);
    const name = String(rec.name ?? '').trim();
    const transport = String(rec.transport ?? '').trim();

    let entry: McpEntry;
    if (transport === 'stdio') {
      entry = {
        name,
        transport: 'stdio',
        command: String(rec.command ?? '').trim(),
        ...(optStringArray(rec.args) ? { args: optStringArray(rec.args) } : {}),
        ...(optStringRecord(rec.env) ? { env: optStringRecord(rec.env) } : {}),
        status: 'proposed',
      };
    } else if (transport === 'http' || transport === 'sse') {
      entry = {
        name,
        transport,
        url: String(rec.url ?? '').trim(),
        ...(optStringRecord(rec.headers) ? { headers: optStringRecord(rec.headers) } : {}),
        ...(typeof rec.timeoutMs === 'number' ? { timeoutMs: rec.timeoutMs } : {}),
        status: 'proposed',
      };
    } else {
      return {
        content:
          'Cannot add the MCP server: `transport` must be one of "stdio", "http", or "sse". Ask the user which it is.',
        isError: true,
      };
    }

    const problems = validateMcpEntry(entry);
    if (problems.length) {
      return {
        content:
          `Cannot add the MCP server "${name || '(unnamed)'}": ${problems.join('; ')}. ` +
          'Ask the user for the missing details and call this tool again.',
        isError: true,
      };
    }

    sink.upsertMcpEntry(entry);
    return {
      content:
        `Proposed the MCP server "${name}" (${transport}). It is saved but NOT active yet — ` +
        'for safety an agent-added server must be approved by a human. Tell the user to open ' +
        'Settings → AI provider → MCP servers and enable "' +
        name +
        '"; once approved, its tools become available on the next message.',
      data: { name, transport, status: 'proposed' },
    };
  };
}

// ---------------------------------------------------------------------------
// JSON-schema tool definitions (NO execute). The engine converts these to
// whatever its SDK needs; the runtime supplies the executors separately.
// ---------------------------------------------------------------------------

export const addMcpSchema: ToolSchema = {
  name: ADD_MCP_TOOL_NAME,
  description:
    'Register a Model Context Protocol (MCP) server for this app when the user asks to add/connect ' +
    'one (e.g. "add the skill-hub MCP"). The server is saved as a PROPOSAL and does NOT run until the ' +
    'user approves it in Settings — so proposing one is safe. Ask the user for any missing connection ' +
    'details (transport, command or URL, and any token/env) before calling. Never invent credentials.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'A short unique name for the server, e.g. "skill-hub".' },
      transport: {
        type: 'string',
        enum: ['stdio', 'http', 'sse'],
        description: 'How to reach it: "stdio" (a local command) or "http"/"sse" (a URL endpoint).',
      },
      command: { type: 'string', description: 'stdio only: the executable to run, e.g. "npx".' },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'stdio only: command arguments, e.g. ["-y", "@scope/skill-hub-mcp"].',
      },
      env: {
        type: 'object',
        description:
          'stdio only: environment variables as a JSON object of string values (e.g. an API token), like {"API_TOKEN":"sk-..."}.',
      },
      url: { type: 'string', description: 'http/sse only: the server endpoint URL.' },
      headers: {
        type: 'object',
        description:
          'http/sse only: request headers as a JSON object of string values (e.g. an Authorization token), like {"Authorization":"Bearer ..."}.',
      },
      timeoutMs: { type: 'number', description: 'http/sse only: optional request timeout in ms.' },
    },
    required: ['name', 'transport'],
  },
};

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
 * provider-independent — the SAME objects are handed to every engine.
 *
 * When an `mcp` sink is supplied, the `naby_add_mcp` tool is included so the
 * agent can register an MCP server on the user's behalf (as a proposal — see
 * makeAddMcp). Omit it (undefined) and the tool is absent, e.g. in a context
 * with no store to write to. */
export function buildToolset(
  outbox: Outbox,
  mcp?: McpProposalSink,
): {
  toolSchemas: ToolSchema[];
  executors: Record<string, Executor>;
} {
  const toolSchemas: ToolSchema[] = [echoNoteSchema, sendMessageSchema, fetchUrlSchema];
  const executors: Record<string, Executor> = {
    echo_note: echoNote,
    send_message: makeSendMessage(outbox),
    fetch_url: makeFetchUrl(),
  };
  if (mcp) {
    toolSchemas.push(addMcpSchema);
    executors[ADD_MCP_TOOL_NAME] = makeAddMcp(mcp);
  }
  return { toolSchemas, executors };
}
