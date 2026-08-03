// src/spikes/spike-cwd.ts
//
// SPIKE-CWD — the Agent SDK engine runs in the directory it is TOLD to run in.
//
// THE BUG THIS PINS DOWN
// ----------------------
// `ClaudeAgentSdkEngine` used to call the SDK's `query()` with no `cwd`, so the
// SDK inherited the host process's cwd — naby's own source checkout — while the
// shell's system prompt announced the project the user had actually opened. The
// model believed one directory and the backend stood in another, so the backend
// loaded NABY's `.claude/` harness (CLAUDE.md, hooks) into chats about other
// projects. Full write-up on `EngineRunInput.cwd`.
//
// The failure was invisible because nothing ever OBSERVED the resolved
// directory. That is what this spike fixes, at two levels of strength:
//
//   A. STRUCTURAL (always runs, no model, no network, deterministic).
//      Asserts the plumbing: that `cwd` survives from `EngineRunInput` into the
//      object handed to `query()`, and — just as importantly — that ABSENT
//      stays absent rather than being defaulted to `process.cwd()`, which is
//      the exact inheritance that caused the bug. It asserts the PRODUCTION
//      object, not a copy: `buildQueryOptions` is the same function the engine
//      calls, extracted for exactly this reason.
//
//   B. EMPIRICAL (needs the local Claude sign-in; SKIPS cleanly without it).
//      Runs a real turn with `cwd` pointed at a fresh temp directory holding a
//      `CLAUDE.md` with a unique token, and asserts the model reports the token
//      back. Because `settingSources` includes 'project', a correct `cwd` is
//      the ONLY way that file can be read — so the token appearing is direct
//      evidence that the SDK loaded the harness of the directory we named, and
//      not naby's. This is the end-to-end version of the observation that was
//      missing.
//
// Prints PASS/FAIL per assertion; exits non-zero on any FAIL. A skipped (B)
// is not a failure, but it IS reported as a skip rather than as a pass.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildQueryOptions,
  ClaudeAgentSdkEngine,
  isClaudeAgentSdkAvailable,
} from '../engines/claude-agent-sdk-engine.js';
import type { EngineEvent, EngineRunInput } from '../runtime/engine.js';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];

/** Drain an engine run, collecting every event. */
async function drain(it: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const ev of it) out.push(ev);
  return out;
}

function assistantText(events: EngineEvent[]): string {
  return events
    .filter((e): e is Extract<EngineEvent, { kind: 'text' }> => e.kind === 'text')
    .map((e) => e.text)
    .join('');
}

function authFailed(events: EngineEvent[]): string | null {
  const err = events.find(
    (e): e is Extract<EngineEvent, { kind: 'error' }> =>
      e.kind === 'error' &&
      (e.code === 'DEV_ENGINE_UNAVAILABLE' ||
        e.code === 'authentication_failed' ||
        /auth|oauth|login|credential|api key/i.test(e.message)),
  );
  return err ? err.message : null;
}

// ---------------------------------------------------------------------------
// (A) STRUCTURAL — does `cwd` actually reach query()'s options?
// ---------------------------------------------------------------------------

function baseInput(cwd?: string): EngineRunInput {
  return {
    model: { providerId: 'dev-claude' },
    messages: [{ role: 'user', content: 'hello' }],
    toolSchemas: [],
    executors: {},
    gate: async () => ({ behavior: 'allow' as const }),
    ...(cwd !== undefined ? { cwd } : {}),
    signal: new AbortController().signal,
  };
}

/** The non-input arguments `buildQueryOptions` needs; irrelevant to what is
 *  under test here, so they are the cheapest valid values. */
function otherArgs(): {
  mcpServer: Parameters<typeof buildQueryOptions>[0]['mcpServer'];
  preToolUse: Parameters<typeof buildQueryOptions>[0]['preToolUse'];
  abortController: AbortController;
  onStderr: (d: string) => void;
} {
  return {
    mcpServer: {
      type: 'sdk',
      name: 'nabytools',
      instance: undefined,
    } as unknown as Parameters<typeof buildQueryOptions>[0]['mcpServer'],
    preToolUse: async () => ({}),
    abortController: new AbortController(),
    onStderr: () => {},
  };
}

function runStructural(): void {
  const PROBE_DIR = mkdtempSync(join(tmpdir(), 'naby-cwd-structural-'));

  const withCwd = buildQueryOptions({ input: baseInput(PROBE_DIR), ...otherArgs() });
  const withoutCwd = buildQueryOptions({ input: baseInput(), ...otherArgs() });

  checks.push({
    name: 'A1. EngineRunInput.cwd reaches the query() options object',
    pass: withCwd.cwd === PROBE_DIR,
    evidence: `passed cwd=${JSON.stringify(PROBE_DIR)}, query() options carry cwd=${JSON.stringify(
      withCwd.cwd,
    )}`,
  });

  // INVERTED at harness-standalone §2.3, and the inversion is the assertion.
  // This check used to PASS on ['user','project','local'] — naby loading the
  // user's and the project's `.claude` settings, CLAUDE.md and hooks into every
  // dev-engine turn. A standalone app loads none of them: naby's own injection is
  // the single path anything reaches the model by. `[]` is the SDK's documented
  // way to say so ("Pass [] to disable filesystem settings").
  checks.push({
    name: 'A2. settingSources is [] — UNCONDITIONALLY, for every turn',
    pass:
      JSON.stringify(withCwd.settingSources) === '[]' &&
      JSON.stringify(withoutCwd.settingSources) === '[]',
    evidence: `with cwd: settingSources=${JSON.stringify(withCwd.settingSources)}; ` +
      `without cwd: settingSources=${JSON.stringify(withoutCwd.settingSources)}`,
  });

  // The other half of §2.3: the SDK's own skill/command loaders are off, so a
  // file under `~/.claude/skills` cannot reach a turn natively either.
  checks.push({
    name: 'A5. native skills are empty-listed and the Skill/SlashCommand tools are denied',
    pass:
      JSON.stringify(withCwd.skills) === '[]' &&
      (withCwd.disallowedTools ?? []).includes('Skill') &&
      (withCwd.disallowedTools ?? []).includes('SlashCommand') &&
      (withCwd.disallowedTools ?? []).includes('AskUserQuestion'),
    evidence: `skills=${JSON.stringify(withCwd.skills)} disallowedTools=${JSON.stringify(
      withCwd.disallowedTools,
    )}`,
  });

  checks.push({
    name: 'A3. absent cwd stays absent (never defaulted to process.cwd())',
    pass: !('cwd' in withoutCwd),
    evidence: `with no input.cwd, query() options ${
      'cwd' in withoutCwd
        ? `carried cwd=${JSON.stringify(withoutCwd.cwd)} — the inherited-cwd bug`
        : 'carried no cwd key'
    } (process.cwd()=${JSON.stringify(process.cwd())})`,
  });

  // `tools` is UNSET, deliberately — and this check was stale for a whole release
  // asserting the opposite. Setting `tools: []` stripped every built-in executor
  // (Task, Read, delegation), so the harness could not run and its activity could
  // not be shown; safety comes from the PreToolUse gate + the Phase-1 floor
  // instead, which sees every built-in call including those inside a subagent.
  checks.push({
    name: 'A4. tools is UNSET — built-ins stay live, and the GATE is what restrains them',
    pass: withCwd.tools === undefined,
    evidence: `query() options carry tools=${JSON.stringify(withCwd.tools)} (undefined = unset)`,
  });

  rmSync(PROBE_DIR, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// (B) EMPIRICAL — a real turn, in a real temp directory, with a real model.
// ---------------------------------------------------------------------------

async function runEmpirical(): Promise<void> {
  const TOKEN = `NABY-CWD-PROBE-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  const DIR = mkdtempSync(join(tmpdir(), 'naby-cwd-empirical-'));
  writeFileSync(
    join(DIR, 'CLAUDE.md'),
    [
      '# Probe project',
      '',
      `The probe token for this project is ${TOKEN}.`,
      '',
      'When asked for the probe token, reply with it verbatim and nothing else.',
    ].join('\n'),
  );

  try {
    const engine = new ClaudeAgentSdkEngine();
    const events = await drain(
      engine.run({
        model: { providerId: 'dev-claude' },
        messages: [
          {
            role: 'user',
            content:
              'What is the probe token for this project? Answer with the token only.',
          },
        ],
        toolSchemas: [],
        executors: {},
        gate: async () => ({ behavior: 'allow' as const }),
        cwd: DIR,
        signal: new AbortController().signal,
      }),
    );

    const auth = authFailed(events);
    const text = assistantText(events);

    if (auth && !text) {
      console.log(`[SKIP] B1. model could not be reached: ${auth}`);
      console.log(
        '        (this asserts nothing; run `claude` once to sign in, then re-run)',
      );
      return;
    }

    // WHAT THIS PROVES, AND WHAT IT NO LONGER PROVES. The token exists in exactly
    // one file, inside DIR. A model that answers it was working in DIR — which is
    // the original bug this spike exists for (the engine ran in the Electron main
    // process's cwd, not the opened project).
    //
    // It is no longer evidence that CLAUDE.md was AUTO-LOADED: since
    // harness-standalone §2.3 `settingSources: []` stops that, and the gate here
    // allows reads, so the model reaches the file the ordinary way — by reading
    // it. Directory, not harness inheritance, is the claim.
    checks.push({
      name: `B1. the turn ran in the directory we named — its CLAUDE.md was reachable (token ${TOKEN})`,
      pass: text.includes(TOKEN),
      evidence: `cwd=${DIR}; model answered ${JSON.stringify(text.slice(0, 200))}`,
    });
  } finally {
    rmSync(DIR, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (C) HARNESS FORWARDING — the driver loop no longer drops what it used to.
// ---------------------------------------------------------------------------
//
// This is the other half of the same silence. The driver loop acted on three
// SDK message types and dropped every other one on the floor, including the
// `user` messages through which the SDK surfaces HOOK OUTPUT — so a hook
// belonging to some other project could fire into our loop and leave no trace
// anywhere. That is precisely how the wrong-`.claude/` bug stayed hidden.
//
// The probe installs a real project hook in the temp cwd, fires a turn, and
// asserts a `harness` event comes out. It also asserts the event is a LABEL and
// not the hook's text: the hook prints a canary string, and that string must
// NOT appear anywhere in the emitted event, because hook output is arbitrary
// project content and this ends up in the UI.
//
// SINCE harness-standalone §2.3 THE PLANTED HOOK IS ALSO THE NEGATIVE CONTROL.
// `settingSources: []` means a project's `.claude/settings.json` is not loaded,
// so that hook must NEVER RUN — and C3 says so empirically, which is the one
// claim in this file that a structural assertion cannot make. (C1 stands on the
// other harness message types the loop used to drop; it never needed the hook.)

async function runHarnessProbe(): Promise<void> {
  const CANARY = `CANARY-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  const DIR = mkdtempSync(join(tmpdir(), 'naby-harness-probe-'));
  mkdirSync(join(DIR, '.claude'), { recursive: true });
  writeFileSync(
    join(DIR, '.claude', 'settings.json'),
    JSON.stringify(
      {
        hooks: {
          UserPromptSubmit: [
            { hooks: [{ type: 'command', command: `echo "${CANARY}"` }] },
          ],
        },
      },
      null,
      2,
    ),
  );

  try {
    const engine = new ClaudeAgentSdkEngine();
    const events = await drain(
      engine.run({
        model: { providerId: 'dev-claude' },
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        toolSchemas: [],
        executors: {},
        gate: async () => ({ behavior: 'allow' as const }),
        cwd: DIR,
        signal: new AbortController().signal,
      }),
    );

    const harness = events.filter(
      (e): e is Extract<EngineEvent, { kind: 'harness' }> => e.kind === 'harness',
    );
    const auth = authFailed(events);
    if (auth && harness.length === 0 && assistantText(events).length === 0) {
      console.log(`[SKIP] C1/C2. model could not be reached: ${auth}`);
      return;
    }

    checks.push({
      name: 'C1. harness messages the driver loop used to drop are now forwarded',
      pass: harness.length > 0,
      evidence: `harness events=${JSON.stringify(harness.map((h) => h.subtype))}`,
    });

    const serialized = JSON.stringify(harness);
    checks.push({
      name: 'C2. the hook body is NOT leaked into the harness event (label only)',
      pass: !serialized.includes(CANARY),
      evidence: `hook printed ${CANARY}; emitted harness events=${serialized.slice(0, 300)}`,
    });

    // The whole point of §2.3, measured rather than argued: a project hook that
    // WOULD have fired (and did, before this change — the events carried
    // `system/hook_started` / `system/hook_response`) does not fire at all.
    const hookSubtypes = harness.map((h) => h.subtype).filter((s) => s.includes('hook'));
    checks.push({
      name: "C3. the project's `.claude` HOOK never ran — settingSources:[] holds empirically",
      pass: hookSubtypes.length === 0,
      evidence: `hook-related harness subtypes=${JSON.stringify(hookSubtypes)} (must be empty); ` +
        `planted ${join(DIR, '.claude', 'settings.json')}`,
    });
  } finally {
    rmSync(DIR, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // (A) needs nothing but the type shapes, so it runs unconditionally.
  runStructural();

  // (B) needs the SDK actually installed AND a local sign-in. Missing either is
  // a SKIP, not a failure — it is the stronger check, not the required one.
  if (isClaudeAgentSdkAvailable()) {
    await runEmpirical();
    await runHarnessProbe();
  } else {
    console.log('[SKIP] the Agent SDK is not installed here — empirical (B) not run.');
  }

  console.log('\n=== SPIKE-CWD — the engine runs where it is told ===\n');
  let allPass = true;
  for (const c of checks) {
    const tag = c.pass ? 'PASS' : 'FAIL';
    if (!c.pass) allPass = false;
    console.log(`[${tag}] ${c.name}`);
    console.log(`        evidence: ${c.evidence}`);
  }
  console.log(
    `\nSPIKE-CWD: ${allPass ? 'ALL PASS' : 'FAILURES PRESENT'} (${
      checks.filter((c) => c.pass).length
    }/${checks.length})\n`,
  );
  if (!allPass) process.exit(1);
}

main().catch((e) => {
  console.error('SPIKE-CWD crashed:', e);
  process.exit(1);
});
