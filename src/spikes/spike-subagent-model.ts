// src/spikes/spike-subagent-model.ts
//
// LIVE PROBE — does the model naby WRITES into a subagent definition survive to
// the run, and can we SEE which one answered? (specs/subagent-delegation.md
// §4.3, §4.5 step 2.)
//
// WHY THIS IS A DECISION RECORD, NOT A REGRESSION GATE. The Agent SDK resolves a
// subagent's model through an order that has MOVED between CLI versions — at
// 2.1.259 it is call-site `model` → the definition's `model` → the
// `CLAUDE_CODE_SUBAGENT_MODEL` environment variable → the main model, and before
// 2.1.251 the environment variable came first. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`
// overrides all of it. naby deliberately does not read or write those variables
// (§2 principle 1), so the only honest way to know what a haiku delegation
// actually costs is to run one and look. That answer belongs to ONE SDK build,
// which is why this spike is re-run on every SDK bump and its result is written
// down here with the version.
//
// It is NOT in `spike:all`: it needs a real sign-in, it spends real tokens, and
// it depends on the model CHOOSING to delegate — so INCONCLUSIVE (exit 2) is a
// legitimate outcome that means nothing is broken. The rule itself (one event per
// `Task` call, read from `message.model`) is asserted every run, with no
// credentials, by `spike:subagent-model-event`.
//
// ---------------------------------------------------------------------------
// RESULT — 2026-09-14, SDK 0.3.259 / bundled CLI 2.1.259, signed in as a
// Claude subscription account (macOS, darwin-arm64). ONE run, LEG 1 only:
//
//   VERDICT: PASS. The main thread answered on `claude-opus-5[1m]`; the model
//   delegated once (tool requests: Agent, then the subagent's Grep, Grep) and the
//   subagent answered on **claude-haiku-4-5-20251001** — i.e. the `model: haiku`
//   naby wrote into the definition is what ran, at this CLI version, with no
//   `CLAUDE_CODE_SUBAGENT_MODEL` in the environment. Exactly ONE `subagent_model`
//   event was emitted for the one `Task` id, across several subagent messages,
//   which is the deduplication contract.
//
//   NOT MEASURED IN THAT RUN: the block-before-label ordering assertion, which
//   was added afterwards — re-run to record it.
//
//   NOT TESTED IN THAT RUN: the override order. LEG 2 was skipped (it costs a
//   second live turn), so whether the definition beats
//   `CLAUDE_CODE_SUBAGENT_MODEL` at 2.1.259 is still only what the SDK's own
//   documentation says. Run LEG 2 on the next SDK bump — that is the reading §4.5
//   step 2 actually wants.
//
// ---------------------------------------------------------------------------
//
// HOW IT RUNS. One turn through the REAL `ClaudeAgentSdkEngine` and the REAL
// `runTurn`, with the SHIPPED `explorer` definition (taken from
// BUILTIN_HARNESS_ASSETS, so what is probed is what users get) handed over as
// `subagents`. The gate is the real `phase1HarnessFloor`: the subagent may read,
// glob and grep, and may not write or run anything. The prompt asks for the thing
// §7 names — every place `effectiveAgentModel` is used in this repository — and
// NUDGES the model to delegate it, because what is under test is the model
// REPORTING, not the model's taste in delegation.
//
// LEG 2, OPT-IN. §4.5 also asks whether the model naby wrote beats an environment
// variable under the current resolution order. That leg costs a second live turn,
// so it runs only when you ask for it:
//
//   NABY_SPIKE_SUBAGENT_MODEL_ENV=opus npm run spike:subagent-model
//
// which sets `CLAUDE_CODE_SUBAGENT_MODEL` for the child CLI and reports which of
// the two won. naby itself never sets that variable.
//
// PATH HYGIENE. A `cmux` shim on PATH named `claude` deadlocks a nested claude
// process (it waits on a terminal that is not there), and the SDK spawns the CLI
// by name. The shim directories are stripped from this process's PATH below, so
// the spike does not depend on the operator remembering.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TMP_DIR = mkdtempSync(join(tmpdir(), 'naby-spike-subagent-model-live-'));
// A throwaway store: this spike must never write into the developer's real
// ~/.naby/app.db, whose session list is what they look at every day.
process.env.NABY_DB_PATH = join(TMP_DIR, 'app.db');

// Strip the cmux shims BEFORE anything can spawn the CLI (see the header).
const strippedPathEntries: string[] = [];
process.env.PATH = (process.env.PATH ?? '')
  .split(':')
  .filter((entry) => {
    const bad = entry.includes('cmux-cli-shims') || entry.includes('cmux.app');
    if (bad) strippedPathEntries.push(entry);
    return !bad;
  })
  .join(':');

import { ClaudeAgentSdkEngine } from '../engines/claude-agent-sdk-engine.js';
import { checkClaudeLogin } from '../engines/claude-login.js';
import { BUILTIN_HARNESS_ASSETS } from '../runtime/harness-assets/generated.js';
import { harnessAssetBody } from '../runtime/harness-seed.js';
import { makeGate, phase1HarnessFloor } from '../runtime/gate.js';
import { runTurn } from '../runtime/session.js';
import { MemoryStore } from '../runtime/store/memory-store.js';
import { buildToolset, Outbox } from '../runtime/tools.js';
import type { EngineEvent, ModelSelection, SubagentSpec } from '../runtime/engine.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MODEL: ModelSelection = { providerId: 'anthropic-dev-oauth' };
const EXPLORER = 'explorer';
/** What the explorer is asked to find — the symbol §7 of the spec names. */
const TARGET = 'effectiveAgentModel';

/** The bundled CLI version, read from the SDK's own manifest. It is the thing
 *  this spike's result is ABOUT, so it is printed rather than assumed. */
function bundledCliVersion(): string {
  const file = resolve(ROOT, 'shell/node_modules/@anthropic-ai/claude-agent-sdk/manifest.json');
  if (!existsSync(file)) return 'unknown (manifest.json not found)';
  try {
    const m = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown };
    return typeof m.version === 'string' ? m.version : 'unknown (no version field)';
  } catch (e) {
    return `unreadable (${e instanceof Error ? e.message : String(e)})`;
  }
}

/** The SHIPPED explorer definition, as the shell's `gatherSubagents` would build
 *  it from the seeded row: the body without frontmatter, the pinned model, the
 *  authored tool list. Probing anything else would prove nothing about what a
 *  user runs. */
function explorerSpec(): SubagentSpec {
  const asset = BUILTIN_HARNESS_ASSETS.find((a) => a.name === EXPLORER);
  if (!asset) throw new Error('the explorer asset is missing from generated.ts');
  return {
    name: asset.name,
    description: asset.description,
    systemPrompt: harnessAssetBody(asset.raw),
    ...(asset.model ? { model: asset.model } : {}),
    ...(asset.toolRefs ? { toolRefs: [...asset.toolRefs] } : {}),
  };
}

type LegResult = {
  label: string;
  delegated: boolean;
  models: { agentToolCallId: string; model: string }[];
  mainModel?: string;
  toolNames: string[];
  /**
   * Did the BLOCK exist before its label did? For every `subagent_model` event,
   * whether a `harness` event naming the same `task.toolCallId` arrived earlier
   * in the stream.
   *
   * THE CLIENT ASSUMES IT. `subagent_model` carries no description and no
   * lifecycle — it is a label to hang on the subagent block the `harness` task
   * events already opened. If the model event can arrive FIRST, the reducer has
   * nothing to attach it to and the label is dropped silently: the run still
   * works, the block still renders, and it simply never says which model
   * answered. Only a live run orders these two, so the ordering is recorded here.
   */
  blockBeforeModel: boolean;
};

async function runLeg(label: string): Promise<LegResult> {
  const store = new MemoryStore();
  const outbox = new Outbox();
  const { toolSchemas, executors } = buildToolset(outbox);
  // The real floor: read-only built-ins and delegation allowed, mutation denied —
  // inside the subagent as well as on the main thread (spike-subagent-gate).
  const gate = makeGate(phase1HarnessFloor(toolSchemas.map((t) => t.name)));

  const events: EngineEvent[] = await runTurn({
    engine: new ClaudeAgentSdkEngine(),
    store,
    sessionId: `subagent-model-${Math.random().toString(36).slice(2)}`,
    model: MODEL,
    userText:
      `Use the ${EXPLORER} subagent to find every place \`${TARGET}\` is used in this repository. ` +
      `Hand it the task in full — it cannot see this conversation. ` +
      `When it answers, report its findings as a short list of paths with line numbers.`,
    toolSchemas,
    executors,
    gate: gate.gate,
    subagents: [explorerSpec()],
    system: `You are running inside the naby shell. Working directory: ${ROOT}`,
    cwd: ROOT,
    engineId: 'dev-claude',
  });

  const models = events
    .filter((e): e is Extract<EngineEvent, { kind: 'subagent_model' }> => e.kind === 'subagent_model')
    .map((e) => ({ agentToolCallId: e.agentToolCallId, model: e.model }));
  // INDEX COMPARISON, in the ORIGINAL stream order — the reducer sees exactly
  // this sequence, so the question is only ever "which index is smaller".
  const blockBeforeModel = events.every((e, i) => {
    if (e.kind !== 'subagent_model') return true;
    const block = events.findIndex(
      (h) => h.kind === 'harness' && h.task?.toolCallId === e.agentToolCallId,
    );
    return block >= 0 && block < i;
  });
  const toolNames = events
    .filter((e): e is Extract<EngineEvent, { kind: 'tool_request' }> => e.kind === 'tool_request')
    .map((e) => e.toolName);
  const init = events.find((e): e is Extract<EngineEvent, { kind: 'init' }> => e.kind === 'init');
  return {
    label,
    delegated: toolNames.some((n) => n === 'Task' || n === 'Agent'),
    models,
    ...(init?.model ? { mainModel: init.model } : {}),
    toolNames,
    blockBeforeModel,
  };
}

function report(leg: LegResult): void {
  console.log(`\n===== ${leg.label} =====`);
  console.log('main thread model   :', leg.mainModel ?? '(not reported)');
  console.log('tool requests       :', JSON.stringify(leg.toolNames));
  console.log('delegated           :', leg.delegated);
  console.log('subagent_model      :', JSON.stringify(leg.models));
  console.log('block before label  :', leg.blockBeforeModel);
}

async function main(): Promise<number> {
  const cli = bundledCliVersion();
  console.log('===== SPIKE-SUBAGENT-MODEL (LIVE) =====');
  console.log('bundled CLI version :', cli);
  console.log('naby db path        :', process.env.NABY_DB_PATH);
  if (strippedPathEntries.length > 0) {
    console.log('PATH entries removed:', JSON.stringify(strippedPathEntries));
  }

  const login = checkClaudeLogin();
  console.log('claude sign-in      :', login.status);
  if (login.status !== 'signed-in') {
    console.log('\nVERDICT: INCONCLUSIVE — no Claude sign-in, so no live turn was run.');
    console.log('Sign in with `claude auth login` and re-run.');
    return 2;
  }

  const leg1 = await runLeg('LEG 1 — the shipped explorer definition, no environment override');
  report(leg1);

  if (!leg1.delegated || leg1.models.length === 0) {
    console.log('\nVERDICT: INCONCLUSIVE — the model did not delegate, so no subagent answered.');
    console.log('Nothing about the model resolution was tested. Re-run; the prompt only nudges.');
    return 2;
  }

  const haiku = leg1.models.filter((m) => m.model.startsWith('claude-haiku'));
  const oneEventPerCall =
    new Set(leg1.models.map((m) => m.agentToolCallId)).size === leg1.models.length;
  const pass = haiku.length === leg1.models.length && oneEventPerCall && leg1.blockBeforeModel;

  console.log('\n----- assertions -----');
  console.log(
    `[${haiku.length === leg1.models.length ? 'PASS' : 'FAIL'}] every subagent answered on claude-haiku-* ` +
      `(${haiku.length}/${leg1.models.length})`,
  );
  console.log(
    `[${oneEventPerCall ? 'PASS' : 'FAIL'}] one event per Task call ` +
      `(${leg1.models.length} events, ${new Set(leg1.models.map((m) => m.agentToolCallId)).size} distinct ids)`,
  );
  console.log(
    `[${leg1.blockBeforeModel ? 'PASS' : 'FAIL'}] the subagent block opened BEFORE its model was ` +
      `named (a harness task event with the same toolCallId precedes every subagent_model event)`,
  );

  // LEG 2 (opt-in): does the definition beat the environment variable?
  const envModel = process.env.NABY_SPIKE_SUBAGENT_MODEL_ENV?.trim();
  if (envModel) {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = envModel;
    const leg2 = await runLeg(`LEG 2 — with CLAUDE_CODE_SUBAGENT_MODEL=${envModel}`);
    report(leg2);
    const stillHaiku = leg2.models.every((m) => m.model.startsWith('claude-haiku'));
    console.log(
      `\nWHICH WON: ${
        leg2.models.length === 0
          ? 'inconclusive (no delegation)'
          : stillHaiku
            ? "naby's definition (the variable did NOT override it)"
            : `the environment variable (${leg2.models.map((m) => m.model).join(', ')})`
      }`,
    );
    delete process.env.CLAUDE_CODE_SUBAGENT_MODEL;
  } else {
    console.log(
      '\n(LEG 2 skipped — set NABY_SPIKE_SUBAGENT_MODEL_ENV=opus to test the override order.)',
    );
  }

  console.log(
    `\nVERDICT: ${pass ? 'PASS' : 'FAIL'} — CLI ${cli}: the model naby wrote into the definition ` +
      `${pass ? 'is what answered' : 'is NOT what answered'}.`,
  );
  return pass ? 0 : 1;
}

let code = 1;
try {
  code = await main();
} catch (e) {
  console.error('SPIKE-SUBAGENT-MODEL crashed:', e);
  code = 1;
} finally {
  rmSync(TMP_DIR, { recursive: true, force: true });
}
process.exit(code);
