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
import type {
  McpEntry,
  MemoryItem,
  MemoryScope,
  MemoryType,
  MemoryWriteRequest,
} from './store/store.js';
import { validateMcpEntry } from './mcp.js';
import {
  CHECKIN_TOOL_NAME,
  CHECKIN_MAX_OPTIONS,
  CHECKIN_MIN_OPTIONS,
  degenerateReason,
  scoreCheckin,
  type DegenerateCode,
  shouldRecord,
  validateCheckinInput,
  type CheckinAnswer,
  type CheckinQuestion,
} from './checkin.js';

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
// naby_remember — HOW THE AGENT LEARNS ITS USER (Phase 3, P3-M4a)
//
// Phase 1.5 built the memory store, the write gate and turn-time injection, and
// P3-M2 wired injection into every turn. But nothing ever WROTE a row, so the
// store stayed empty and the loop never closed. This tool is the writer.
//
// WHY A TOOL, and not a second model call at end of turn: the agent already
// knows, mid-conversation, when it just learned something durable — and a tool
// call costs no extra round trip, streams into the transcript where the user can
// see it, and (the part that matters) passes THE SAME gate as every other call.
// A policy rule can deny or ask for `naby_remember` exactly like Bash.
//
// TWO GATES, both of which must pass:
//   1. the tool-call gate (Phase 2 policy) — may deny or require approval;
//   2. the memory write gate (decideMemoryWrite, applied inside store.putMemory)
//      — trust ordering and scope-escalation rules.
//
// WHAT KEEPS THIS FROM BECOMING A POISONING VECTOR:
//   * Every write asks for `proposed`, never `confirmed`. Only confirmed memory
//     is injected (contract §5), so a captured row cannot shape a single turn
//     until the human confirms it in the review UI. "완전 자동 메모리는 만들지
//     않는다" (strategy §2.3) is enforced here, by construction.
//   * provenance.source is 'artifact' — a local artifact tier, NOT 'user'. The
//     model saying "the user prefers X" is not the same as the user saying it,
//     and the trust ordering must reflect that (a later 'user'-tier row wins).
//   * Secret-shaped values are refused deterministically (looksLikeSecret).
//     app.db encryption is still an open decision (strategy §7.2), so a token
//     written into durable memory would be a plaintext credential at rest.
// ---------------------------------------------------------------------------

/** The bare name of the learning tool — also the gate/allowlist key. */
export const REMEMBER_TOOL_NAME = 'naby_remember';

/** Max stored value length. Memory lines are injected under a per-turn token
 *  budget, so a long value would crowd out everything else; a fact that needs
 *  more than this is a document, not a memory. */
export const MEMORY_VALUE_MAX = 400;

/** Fixed confidence for a tool-captured row. The model has no calibrated
 *  probability to report, so asking it for one would be theater; the row is
 *  `proposed` and a human decides. */
const CAPTURE_CONFIDENCE = 0.5;

/** What the remember executor needs: somewhere to write, plus THIS turn's scope
 *  keys. Scope→key is a runtime contract fact (contract §2: sessionId | cwd |
 *  userId | orgId), so it is resolved here rather than in each shell. */
export interface MemoryLearningSink {
  putMemory(req: MemoryWriteRequest): MemoryItem;
  /** The session this turn runs in — the 'session' scope key AND provenance. */
  sessionId: string;
  /** The project directory, when the turn has one — the 'project' scope key. */
  cwd?: string;
  /** The user scope key (a single-user-machine constant). */
  userId: string;
  /** The routed agent's own scope, used when the model names none (P3-M4b). */
  defaultScope?: MemoryScope;
}

/** Scopes the agent may write. 'org' is deliberately absent: team-wide memory is
 *  a shared asset a person curates, not something one agent turn mints. */
const WRITABLE_SCOPES: readonly MemoryScope[] = ['session', 'project', 'user'];
const MEMORY_TYPES: readonly MemoryType[] = ['working', 'episodic', 'semantic', 'procedural'];

/** Normalize a caller-supplied key into a stable slug — the upsert identity
 *  within (scope, scopeKey), so "Prefers Dark Mode" and "prefers-dark-mode" must
 *  land on ONE row rather than two. Keeps Hangul (a Korean-language user's
 *  memory keys are legitimate) and returns '' when nothing usable is left. */
export function normalizeMemoryKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_./]+/g, '-')
    .replace(/[^a-z0-9가-힣-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}

/** Refuse anything shaped like a credential. Deterministic and deliberately
 *  broad: a false positive costs the agent one memory, a false negative writes a
 *  plaintext secret into a file that outlives the session. */
export function looksLikeSecret(value: string): boolean {
  const v = value.trim();
  return (
    // The token BODY may itself contain - and _ : a Slack bot token really is
    // `xoxb-1234-5678-abcd…`, so requiring an unbroken alphanumeric run here
    // would miss the very credentials this is meant to catch.
    /\b(?:sk|pk|shub|ghp|gho|xox[bap])[-_][A-Za-z0-9][A-Za-z0-9_-]{15,}/.test(v) ||
    /\bBearer\s+[A-Za-z0-9._-]{16,}/i.test(v) ||
    /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/.test(v) || // telegram bot token
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(v) ||
    /\b(?:password|passwd|api[_ -]?key|secret|token|credential)\b\s*[:=]\s*\S+/i.test(v) ||
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(v) // JWT
  );
}

/** Resolve a scope name to this turn's scope key, or undefined when the turn has
 *  no such scope (a projectless turn has no 'project' key). */
export function resolveMemoryScopeKey(
  scope: MemoryScope,
  sink: Pick<MemoryLearningSink, 'sessionId' | 'cwd' | 'userId'>,
): string | undefined {
  if (scope === 'session') return sink.sessionId || undefined;
  if (scope === 'project') return sink.cwd || undefined;
  if (scope === 'user') return sink.userId || undefined;
  return undefined; // 'org' is not writable by an agent
}

/** Everything wrong with a remember request, in the words the MODEL needs to fix
 *  it. Empty array = the request is well-formed. Pure. */
export function validateRememberInput(input: {
  key: string;
  value: string;
  type: string;
  scope: string;
}): string[] {
  const problems: string[] = [];
  if (!normalizeMemoryKey(input.key)) {
    problems.push('`key` must contain letters or digits (it becomes a stable slug, e.g. "prefers-metric-units")');
  }
  const value = input.value.trim();
  if (!value) problems.push('`value` is empty — say what was learned, as one sentence');
  if (value.length > MEMORY_VALUE_MAX) {
    problems.push(`\`value\` is ${value.length} chars; keep it under ${MEMORY_VALUE_MAX} (one fact, one sentence)`);
  }
  if (looksLikeSecret(value)) {
    problems.push(
      'that `value` looks like a credential (token/key/password) — never store secrets in memory; store the preference, not the secret',
    );
  }
  if (!MEMORY_TYPES.includes(input.type as MemoryType)) {
    problems.push(`\`type\` must be one of ${MEMORY_TYPES.join(', ')}`);
  }
  if (!WRITABLE_SCOPES.includes(input.scope as MemoryScope)) {
    problems.push(`\`scope\` must be one of ${WRITABLE_SCOPES.join(', ')} ('org' memory is curated by a person, not an agent)`);
  }
  return problems;
}

/** Build the remember executor bound to a turn's sink. Every write lands as a
 *  PROPOSAL and the returned message tells the model exactly that, so it neither
 *  claims to the user that the fact is now active nor repeats the call. */
export function makeRemember(sink: MemoryLearningSink): Executor {
  return async (input): Promise<ToolOutput> => {
    const rec = asRecord(input);
    const key = String(rec.key ?? '');
    const value = String(rec.value ?? '');
    const type = String(rec.type ?? 'semantic');
    const scope = String(rec.scope ?? sink.defaultScope ?? 'user');

    const problems = validateRememberInput({ key, value, type, scope });
    if (problems.length) {
      return {
        content: `Nothing was remembered: ${problems.join('; ')}.`,
        isError: true,
      };
    }

    const scopeKey = resolveMemoryScopeKey(scope as MemoryScope, sink);
    if (!scopeKey) {
      return {
        content:
          `Nothing was remembered: this turn has no '${scope}' scope to write to` +
          (scope === 'project' ? ' (no working directory). Use scope "user" for a fact that holds everywhere.' : '.'),
        isError: true,
      };
    }

    const normalizedKey = normalizeMemoryKey(key);
    try {
      // The write gate runs INSIDE putMemory (decideMemoryWrite): it can refuse
      // outright (throws) or pin the status. We ask for 'proposed' regardless, so
      // a capture never becomes injectable without a human.
      const saved = sink.putMemory({
        scope: scope as MemoryScope,
        scopeKey,
        type: type as MemoryType,
        key: normalizedKey,
        value: value.trim(),
        provenance: {
          source: 'artifact',
          sessionId: sink.sessionId,
          basis: 'learned from this conversation',
        },
        confidence: CAPTURE_CONFIDENCE,
        requestedStatus: 'proposed',
      });
      return {
        content:
          `Noted "${normalizedKey}" in ${scope} memory as a PROPOSAL. It is not in use yet — ` +
          'memory only shapes future answers after the user confirms it in Settings → Agents → ' +
          'memory review. Do not call this again for the same fact, and do not tell the user it is ' +
          'already being applied.',
        data: { id: saved.id, key: saved.key, scope: saved.scope, status: saved.status },
      };
    } catch (e) {
      // A gate deny (e.g. a lower tier trying to overwrite a confirmed row).
      return {
        content: `Nothing was remembered: ${e instanceof Error ? e.message : String(e)}.`,
        isError: true,
      };
    }
  };
}

// ---------------------------------------------------------------------------
// naby_checkin — HOW THE TRUST METER GETS ITS LABELS (Phase 3, P3-M5)
//
// P3-M5 built `growth.ts` (the meter) and the `eval_events` ledger, but nothing
// wrote a row, so every agent read "egg 0%" no matter how well it worked. This
// tool is the writer, and the exchange it performs is the measurement:
//
//   the agent proposes → the user picks → hit or miss → the ledger → the stage
//
// WHY A TOOL AND NOT A PROMPT CONVENTION. A "please ask before you act" line in
// the system prompt produces prose the app cannot score: no options, no recorded
// recommendation, no label. A tool call has a schema, so the recommendation is
// pinned BEFORE the user answers — which is the whole reason the answer means
// something. It also pauses the turn properly (the shell suspends on the sink's
// promise) and passes the same gate as every other call.
//
// WHAT THIS TOOL CANNOT DO. It cannot decide when a check-in was owed. The
// obligation is a property of the action class and is enforced on the gate path
// (`isConsequentialTool`), where a consequential call with no check-in is
// recorded as `autonomous`. Otherwise the agent would ask only where it felt
// safe and the hit rate would measure its taste in questions, not its knowledge
// of its user.
//
// AND IT CANNOT SEE ITS OWN SCORE. Nothing in the return value mentions hits,
// stages or percentages, and the ledger is not readable by any tool (contract §4,
// invariant 5). An agent that could read the metric would optimize the metric.
// ---------------------------------------------------------------------------

/** One scored check-in, ready for the ledger. The shell maps this onto an
 *  `eval_events` row — the runtime does not know the store's column names. */
export interface CheckinLedgerRow {
  question: string;
  options: string[];
  recommended: number;
  /** Index the user chose, or -1 when they answered in their own words. */
  chosen: number;
  /** The label. Decided here, stored as-is, never recomputed (contract §4.1). */
  hit: boolean;
  confidence?: number;
  correction?: string;
  taskType?: string;
  /** Set when the question was degenerate: kept, marked, out of the hit rate. */
  excludedFromScoring?: boolean;
  /** Why it was excluded, as a CODE the shell renders per locale. */
  reason?: DegenerateCode;
}

/** What the check-in executor needs from the shell: a way to interrupt the user,
 *  a place to write the outcome, and enough history to spot a repeat. */
export interface CheckinSink {
  /** Suspend the turn and put the question in front of the user. Resolves with
   *  their choice, or `{unanswered: true}` on stop/timeout.
   *
   *  `meta.toolCallId` is passed through so the shell can key the pending prompt
   *  the same way M2 keys an approval (`sessionId:toolCallId`) — a stable id the
   *  resolving request and the UI can both name. */
  ask(question: CheckinQuestion, meta: { toolCallId: string }): Promise<CheckinAnswer>;
  /** Append the scored row. Separate from `ask` so a failed ledger write can
   *  never swallow an answer the user already gave. */
  record(row: CheckinLedgerRow): void;
  /** The agent's recent check-in questions, newest first — the duplicate check
   *  reads these. Absent is fine (a first check-in has no history). */
  recentQuestions?: readonly string[];
}

/** Build the check-in executor bound to a turn's sink. */
export function makeCheckin(sink: CheckinSink): Executor {
  return async (input, ctx): Promise<ToolOutput> => {
    const rec = asRecord(input);
    const question = String(rec.question ?? '');
    const rawOptions = rec.options;
    const recommended = rec.recommended;

    const problems = validateCheckinInput({
      question,
      options: rawOptions,
      recommended,
      confidence: rec.confidence,
    });
    if (problems.length) {
      // A malformed check-in fails as a TOOL ERROR and the user is never
      // interrupted: a prompt with one option or an out-of-range recommendation
      // is not something they could answer.
      return {
        content: `The check-in was not shown: ${problems.join('; ')}.`,
        isError: true,
      };
    }

    const options = (rawOptions as unknown[]).map((o) => String(o).trim());
    const recIndex = recommended as number;
    const confidence = typeof rec.confidence === 'number' ? rec.confidence : undefined;
    const taskType = typeof rec.taskType === 'string' && rec.taskType.trim() ? rec.taskType.trim() : undefined;

    const answer = await sink.ask(
      {
        question: question.trim(),
        options,
        recommended: recIndex,
        ...(confidence !== undefined ? { confidence } : {}),
        ...(taskType ? { taskType } : {}),
      },
      { toolCallId: ctx.toolCall.toolCallId },
    );

    if (!shouldRecord(answer)) {
      // Nobody answered. No row, and the model is told to stop rather than pick
      // for the user — the whole point of asking was that it did not know.
      return {
        content:
          'Nobody answered the check-in (the turn was stopped or the prompt expired). ' +
          'Do not guess and do not proceed with the consequential step; say it is still waiting on a decision.',
        isError: true,
      };
    }

    const excluded = degenerateReason({ question, options, recentQuestions: sink.recentQuestions });
    const hit = scoreCheckin(recIndex, answer);
    try {
      sink.record({
        question: question.trim(),
        options,
        recommended: recIndex,
        chosen: answer.chosen,
        hit,
        ...(confidence !== undefined ? { confidence } : {}),
        ...(answer.correction ? { correction: answer.correction } : {}),
        ...(taskType ? { taskType } : {}),
        ...(excluded ? { excludedFromScoring: true, reason: excluded } : {}),
      });
    } catch {
      // The answer is what the turn needs; a ledger hiccup must not lose it.
    }

    // WHAT THE MODEL IS TOLD: the decision, and nothing about how it scored.
    if (answer.chosen < 0) {
      return {
        content:
          `The user did not pick any option. In their words: "${answer.correction ?? ''}". ` +
          'Follow that instead of your recommendation, and do not ask this again.',
        data: { chosen: -1, correction: answer.correction ?? '' },
      };
    }
    const picked = options[answer.chosen] ?? '';
    return {
      content:
        `The user chose option ${answer.chosen + 1}: "${picked}". Proceed exactly that way ` +
        'and do not ask this again.',
      data: { chosen: answer.chosen, option: picked },
    };
  };
}

// ---------------------------------------------------------------------------
// JSON-schema tool definitions (NO execute). The engine converts these to
// whatever its SDK needs; the runtime supplies the executors separately.
// ---------------------------------------------------------------------------

export const checkinSchema: ToolSchema = {
  name: CHECKIN_TOOL_NAME,
  description:
    'Ask the user how to proceed, RIGHT BEFORE a step that changes something they cannot easily undo — ' +
    'writing or editing files, running a command, sending anything outward — when there is a real choice ' +
    'about HOW to do it. State the decision as a question, offer the genuinely different ways to proceed, ' +
    'and mark the one you believe they want. The turn pauses until they answer, and their answer overrides ' +
    'your recommendation. Do NOT use it for read-only steps, for questions with only one real answer, or to ' +
    're-ask something already decided in this conversation — and never pad the options.',
  parameters: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description:
          'The decision, as one question the user can answer by picking — e.g. "Rename the column in place, or add a new one and migrate?"',
      },
      options: {
        type: 'array',
        items: { type: 'string' },
        description: `The genuinely different ways to proceed, ${CHECKIN_MIN_OPTIONS}–${CHECKIN_MAX_OPTIONS} of them, each a short concrete action.`,
      },
      recommended: {
        type: 'number',
        description:
          'Zero-based index of the option you believe this user wants. Commit to your real best guess — a deliberately safe guess teaches nothing.',
      },
      confidence: {
        type: 'number',
        description: 'How sure you are of that recommendation, 0–1. Report it honestly; it is not used to decide anything.',
      },
      taskType: {
        type: 'string',
        description:
          'Short slug for the kind of work this decision belongs to, e.g. "code-refactor", "email-draft". Reuse the same slug for the same kind of work.',
      },
    },
    required: ['question', 'options', 'recommended'],
  },
};

export const rememberSchema: ToolSchema = {
  name: REMEMBER_TOOL_NAME,
  description:
    'Remember a durable fact about THIS user so future conversations start from it — how they want ' +
    'work done, a standing rule, a term their team uses, the state of an ongoing project. Call it the ' +
    'moment you learn something that would still be true next week. The entry is saved as a PROPOSAL ' +
    'and does NOT affect any answer until the user confirms it, so proposing one is safe and cheap. ' +
    'Do NOT store: transient task state, anything you were told only for this one message, secrets ' +
    '(tokens, keys, passwords), or a fact you already remembered. One fact per call.',
  parameters: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description:
          'Short stable slug naming the fact, e.g. "prefers-metric-units". Reusing a key updates that entry instead of adding a duplicate.',
      },
      value: {
        type: 'string',
        description: `The fact itself, in one sentence (max ${MEMORY_VALUE_MAX} chars). Write it so it makes sense with no conversation around it.`,
      },
      type: {
        type: 'string',
        enum: ['working', 'episodic', 'semantic', 'procedural'],
        description:
          'working = current task state; episodic = something that happened; semantic = a standing fact or preference; procedural = how they want a task done.',
      },
      scope: {
        type: 'string',
        enum: ['session', 'project', 'user'],
        description:
          'How far it applies: "user" for anywhere, "project" for this working directory only, "session" for this conversation only. Defaults to the agent\'s own scope.',
      },
    },
    required: ['key', 'value', 'type'],
  },
};

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
 * with no store to write to.
 *
 * When a `memory` sink is supplied, `naby_remember` is included so the agent can
 * capture what it learns about the user (also as a proposal — see makeRemember).
 * It carries THIS turn's scope keys, so it is built per turn rather than once.
 *
 * When a `checkin` sink is supplied, `naby_checkin` is included so the agent can
 * pause and ask how to proceed — the exchange the trust meter scores (P3-M5).
 * Also per turn: the sink holds this turn's suspend/resume plumbing. */
export function buildToolset(
  outbox: Outbox,
  mcp?: McpProposalSink,
  memory?: MemoryLearningSink,
  checkin?: CheckinSink,
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
  if (memory) {
    toolSchemas.push(rememberSchema);
    executors[REMEMBER_TOOL_NAME] = makeRemember(memory);
  }
  if (checkin) {
    toolSchemas.push(checkinSchema);
    executors[CHECKIN_TOOL_NAME] = makeCheckin(checkin);
  }
  return { toolSchemas, executors };
}
