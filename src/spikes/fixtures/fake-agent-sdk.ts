// src/spikes/fixtures/fake-agent-sdk.ts
//
// A SCRIPTED STAND-IN FOR @anthropic-ai/claude-agent-sdk (org-harness-sync M4).
//
// `ClaudeAgentSdkEngine` takes it through its `sdk` constructor option, so the
// engine's own code — the PreToolUse hook that calls the gate, the in-process
// `nabytools` wrappers that run runtime/MCP executors, the `user`-message
// tool_result mapping for the SDK's built-ins, subagent attribution from
// `agent_id` — runs for real, with no sign-in, no CLI process and no model call.
//
// What the stand-in plays is the CLI's part, in the order the CLI does it:
//
//   system/init → for each scripted step:
//     text  → one assistant message
//     tool  → assistant tool_use; the registered PreToolUse hook (the engine's
//             gate) is awaited; a deny becomes an error tool_result; otherwise a
//             `mcp__nabytools__*` call runs the engine's own wrapper (which emits
//             its own tool_result), and a built-in (`Bash`, `Write`, `Edit`, …)
//             is "run" by `builtin` and reported on a `user` message
//   → result
//
// A step with `agentId` is a call made inside a subagent: the hook input carries
// `agent_id` (and `agent_type`), and the messages carry a `parent_tool_use_id`,
// exactly the fields the engine keys subagent attribution on.

import type { ClaudeAgentSdkModule } from '../../engines/claude-agent-sdk-engine.js';

export type FakeSdkStep =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool';
      /** As the CLI names it: `Bash`, `Write`, `mcp__nabytools__<tool>`, … */
      name: string;
      input: Record<string, unknown>;
      /** Run inside a subagent with this id. */
      agentId?: string;
    };

export type FakeBuiltin = (
  name: string,
  input: Record<string, unknown>,
  cwd: string | undefined,
) => { content: string; isError?: boolean };

type ToolDef = { name: string; handler: (args: unknown, extra: unknown) => Promise<unknown> };
type HookFn = (input: unknown, toolUseId: string | undefined, opts: { signal: AbortSignal }) => Promise<unknown>;

export type FakeSdkRecord = {
  /** Hook outputs, in order, for each tool step. */
  decisions: { name: string; decision: string | undefined }[];
  runs: number;
};

const NABYTOOLS_PREFIX = 'mcp__nabytools__';

/** Build a stand-in that plays `script` on every `query()` call. */
export function fakeAgentSdk(script: () => FakeSdkStep[], builtin: FakeBuiltin): ClaudeAgentSdkModule & { record: FakeSdkRecord } {
  const record: FakeSdkRecord = { decisions: [], runs: 0 };
  const tool = ((name: string, _description: string, _shape: unknown, handler: ToolDef['handler']) => ({
    name,
    handler,
  })) as unknown as ClaudeAgentSdkModule['tool'];
  const createSdkMcpServer = ((cfg: { name: string; tools?: ToolDef[] }) => ({
    type: 'sdk',
    name: cfg.name,
    instance: { tools: cfg.tools ?? [] },
  })) as unknown as ClaudeAgentSdkModule['createSdkMcpServer'];

  const query = ((args: { prompt: unknown; options?: Record<string, unknown> }) => {
    const options = args.options ?? {};
    const hooks = (options.hooks ?? {}) as Record<string, { hooks: HookFn[] }[] | undefined>;
    const preToolUse = hooks.PreToolUse?.[0]?.hooks?.[0];
    const servers = (options.mcpServers ?? {}) as Record<string, { instance?: { tools?: ToolDef[] } }>;
    const nabytools = servers.nabytools?.instance?.tools ?? [];
    const cwd = typeof options.cwd === 'string' ? options.cwd : undefined;
    const signal = (options.abortController as AbortController | undefined)?.signal ?? new AbortController().signal;
    record.runs += 1;
    let n = 0;
    const usage = { input_tokens: 40, output_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

    async function* play(): AsyncGenerator<Record<string, unknown>> {
      yield { type: 'system', subtype: 'init', model: 'fake-claude', session_id: 'fake-cli', tools: [], mcp_servers: [] };
      for (const step of script()) {
        if (step.kind === 'text') {
          yield {
            type: 'assistant',
            parent_tool_use_id: null,
            session_id: 'fake-cli',
            message: { model: 'fake-claude', role: 'assistant', content: [{ type: 'text', text: step.text }], usage },
          };
          continue;
        }
        n += 1;
        const id = `toolu_fake_${record.runs}_${n}`;
        const parent = step.agentId ? `toolu_task_${step.agentId}` : null;
        yield {
          type: 'assistant',
          parent_tool_use_id: parent,
          session_id: 'fake-cli',
          message: {
            model: 'fake-claude',
            role: 'assistant',
            content: [{ type: 'tool_use', id, name: step.name, input: step.input }],
            usage,
          },
        };
        const hookInput = {
          hook_event_name: 'PreToolUse',
          session_id: 'fake-cli',
          transcript_path: '',
          cwd: cwd ?? '',
          tool_name: step.name,
          tool_input: step.input,
          tool_use_id: id,
          ...(step.agentId ? { agent_id: step.agentId, agent_type: 'general-purpose' } : {}),
        };
        const out = (preToolUse ? await preToolUse(hookInput, id, { signal }) : {}) as {
          hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> };
        };
        const decision = out.hookSpecificOutput?.permissionDecision;
        record.decisions.push({ name: step.name, decision });
        let content: string;
        let isError = false;
        if (decision === 'deny') {
          content = out.hookSpecificOutput?.permissionDecisionReason ?? 'denied';
          isError = true;
        } else if (step.name.startsWith(NABYTOOLS_PREFIX)) {
          const bare = step.name.slice(NABYTOOLS_PREFIX.length);
          const def = nabytools.find((t) => t.name === bare);
          if (!def) {
            content = `no such tool ${bare}`;
            isError = true;
          } else {
            const r = (await def.handler(out.hookSpecificOutput?.updatedInput ?? step.input, {})) as {
              content?: { text?: string }[];
              isError?: boolean;
            };
            content = (r.content ?? []).map((c) => c.text ?? '').join('');
            isError = r.isError === true;
          }
        } else {
          const r = builtin(step.name, out.hookSpecificOutput?.updatedInput ?? step.input, cwd);
          content = r.content;
          isError = r.isError === true;
        }
        yield {
          type: 'user',
          parent_tool_use_id: parent,
          session_id: 'fake-cli',
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
        };
      }
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: 'fake-cli',
        num_turns: 1,
        result: '',
        usage,
        total_cost_usd: 0,
        modelUsage: {},
      };
    }
    return play();
  }) as unknown as ClaudeAgentSdkModule['query'];

  return { tool, createSdkMcpServer, query, record };
}
