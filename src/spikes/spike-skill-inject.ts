// src/spikes/spike-skill-inject.ts
//
// Phase 1.6 HP-03a verification — turn-time SKILL instruction injection.
// Interface + invariants in phase-1_6-harness-contracts §3; task + acceptance in
// phase-1_6-harness-ownership §3 (HP-03a) / §2 (the 1.6-vs-2.5 split).
//
// It proves, against BOTH store drivers where the claim is meaningful, that an
// instruction-only skill injects into the turn's SYSTEM field above the engine
// seam — exactly the memory-injection path (P15-02) — and that the load-bearing
// invariants hold:
//
//   (a) TRIGGER INJECTION — an enabled instruction-only skill whose trigger
//       appears in the turn text is assembled into the engine's system field
//       (base preserved, skill instructions present). An always-on skill (no
//       triggers) injects unconditionally.
//   (b) TOKEN BUDGET is a HARD ceiling — over-budget skills are dropped and
//       COUNTED (droppedForBudget); tokensUsed ≤ budget always.
//   (c) TOOL-BEARING SKILLS EXCLUDED — a skill with toolRefs is NOT injected
//       (Phase 2.5), and the omission is OBSERVABLE via excludedForTools; its
//       instructions never reach the system field.
//   (d) NO-OP — a turn with no relevant skill (or no config at all) is
//       byte-for-byte the pre-HP-03a turn (identical system).
//   (e) ENABLED-ONLY — a disabled skill never injects even when its trigger fires.
//   (f) DRIVER PARITY — (a)/(c)/(e) hold identically on MemoryStore and
//       SqliteStore.
//
// NO NETWORK, NO KEYS. Prints PASS/FAIL per assertion; exits non-zero on any FAIL.

import { MockEngine } from '../engines/mock-engine.js';
import {
  DEFAULT_USER_ID,
  retrieveSkillsForInjection,
  selectSkillsForInjection,
} from '../runtime/skill-inject.js';
import { makeGate, scriptedPolicy } from '../runtime/gate.js';
import { runTurn } from '../runtime/session.js';
import { MemoryStore } from '../runtime/store/memory-store.js';
import { SqliteStore } from '../runtime/store/sqlite-store.js';
import type { HarnessImportRequest, Store } from '../runtime/store/store.js';
import { buildToolset, Outbox } from '../runtime/tools.js';

type Check = { name: string; pass: boolean; evidence: string };

function record(checks: Check[], name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

const USER = DEFAULT_USER_ID;

/** A user-authored (trusted) skill import request. `triggers`/`toolRefs` omitted
 * ⇒ always-on / instruction-only respectively. */
function skillReq(
  name: string,
  instructions: string,
  opts?: {
    triggers?: string[];
    toolRefs?: string[];
    status?: 'enabled' | 'disabled';
    scope?: 'user' | 'project' | 'org';
    scopeKey?: string;
  },
): HarnessImportRequest {
  const skill: { instructions: string; triggers?: string[]; toolRefs?: string[] } = {
    instructions,
  };
  if (opts?.triggers) skill.triggers = opts.triggers;
  if (opts?.toolRefs) skill.toolRefs = opts.toolRefs;
  return {
    item: {
      scope: opts?.scope ?? 'user',
      scopeKey: opts?.scopeKey ?? USER,
      kind: 'skill',
      name,
      description: `skill ${name}`,
      provenance: { source: 'user' },
      skill,
    },
    requestedStatus: opts?.status ?? 'enabled',
  };
}

function makeTurnKit() {
  const outbox = new Outbox();
  const { toolSchemas, executors } = buildToolset(outbox);
  const gate = makeGate(scriptedPolicy({ send_message: { behavior: 'allow' } }));
  return { toolSchemas, executors, gate: gate.gate };
}

/** Run one turn on a fresh MockEngine and return the system it received. */
async function systemAfterTurn(
  store: Store,
  userText: string,
  cfg?: { system?: string; skillBudget?: number },
): Promise<string | undefined> {
  const { toolSchemas, executors, gate } = makeTurnKit();
  const sid = store.createSession('provider-a', 'skill-turn').sessionId;
  const engine = new MockEngine();
  await runTurn({
    engine,
    store,
    sessionId: sid,
    model: { providerId: 'mock', model: 'm' },
    userText,
    ...(cfg?.system !== undefined ? { system: cfg.system } : {}),
    toolSchemas,
    executors,
    gate,
    ...(cfg?.skillBudget !== undefined
      ? { skillInjection: { tokenBudget: cfg.skillBudget, userId: USER } }
      : {}),
  });
  return engine.diagnostics.system;
}

// ---------------------------------------------------------------------------
// (a) trigger injection + (e) enabled-only + (c) tool-bearing excluded — per driver
// ---------------------------------------------------------------------------

async function checkPerDriver(checks: Check[], store: Store, label: string): Promise<void> {
  // Enabled, triggered, instruction-only.
  store.putHarnessItem(
    skillReq('tldr', 'When asked for a summary, answer in ONE crisp sentence.', {
      triggers: ['tl;dr', 'summari'],
    }),
  );
  // Enabled, always-on (no triggers), instruction-only.
  store.putHarnessItem(
    skillReq('tone', 'ALWAYS-ON-TONE: keep a warm, concise voice.'),
  );
  // Enabled but tool-bearing — must be EXCLUDED (Phase 2.5), observably.
  store.putHarnessItem(
    skillReq('websearch', 'TOOL-SKILL-BODY: search the web then cite.', {
      triggers: ['summari'],
      toolRefs: ['web_search'],
    }),
  );
  // Disabled instruction-only skill — must NEVER inject even though it triggers.
  store.putHarnessItem(
    skillReq('secret', 'DISABLED-BODY: should never appear.', {
      triggers: ['summari'],
      status: 'disabled',
    }),
  );

  // (a) trigger fires: triggered + always-on present; base preserved.
  const sysHit = await systemAfterTurn(store, 'please summarize this', {
    system: 'BASE-SYSTEM',
    skillBudget: 500,
  });
  const triggerInjected =
    typeof sysHit === 'string' &&
    sysHit.includes('BASE-SYSTEM') &&
    sysHit.includes('ONE crisp sentence') &&
    sysHit.includes('ALWAYS-ON-TONE');
  record(
    checks,
    `(a) [${label}] enabled instruction-only skill (triggered + always-on) injects into the turn SYSTEM field, base preserved`,
    triggerInjected,
    `system=${JSON.stringify(sysHit)}`,
  );

  // (c) tool-bearing skill excluded + (e) disabled excluded — both bodies absent.
  const toolExcluded =
    typeof sysHit === 'string' &&
    !sysHit.includes('TOOL-SKILL-BODY') &&
    !sysHit.includes('DISABLED-BODY');
  // and observable via excludedForTools on the pure retrieval
  const retrieved = retrieveSkillsForInjection(
    store,
    { userText: 'please summarize this', tokenBudget: 500 },
    { userId: USER },
  );
  const excludedObservable = retrieved.excludedForTools === 1;
  const disabledNeverInSelection = retrieved.skills.every(
    (s) => s.name !== 'secret',
  );
  record(
    checks,
    `(c) [${label}] tool-bearing skill EXCLUDED (Phase 2.5) — body absent, excludedForTools counted; (e) disabled skill never injected`,
    toolExcluded && excludedObservable && disabledNeverInSelection,
    `toolBodyAbsent+disabledBodyAbsent=${toolExcluded}; excludedForTools=${retrieved.excludedForTools}(want 1); injected=${JSON.stringify(retrieved.skills.map((s) => s.name))}`,
  );

  // (e-explicit) always-on injects when NOTHING triggers, disabled still out.
  const sysAlwaysOn = await systemAfterTurn(store, 'unrelated request', {
    system: 'BASE-SYSTEM',
    skillBudget: 500,
  });
  const alwaysOnOnly =
    typeof sysAlwaysOn === 'string' &&
    sysAlwaysOn.includes('ALWAYS-ON-TONE') &&
    !sysAlwaysOn.includes('ONE crisp sentence') && // tldr trigger did NOT fire
    !sysAlwaysOn.includes('DISABLED-BODY');
  record(
    checks,
    `(e) [${label}] non-triggering turn injects ONLY always-on skills; triggered + disabled skills stay out`,
    alwaysOnOnly,
    `system=${JSON.stringify(sysAlwaysOn)}`,
  );
}

// ---------------------------------------------------------------------------
// (b) token budget hard cap + droppedForBudget — pure selection
// ---------------------------------------------------------------------------

function checkBudget(checks: Check[]): void {
  const store = new MemoryStore();
  // 6 always-on instruction-only skills with fixed-ish bodies.
  for (let i = 0; i < 6; i++) {
    store.putHarnessItem(
      skillReq(`bulk${i}`, `Skill body number ${i} padded out with some words here.`),
    );
  }
  const candidates = store.listHarness('user', USER, {
    kind: 'skill',
    status: 'enabled',
  });
  const budget = 20;
  const selected = selectSkillsForInjection(candidates, 'anything', budget);
  const budgetRespected = selected.tokensUsed <= budget;
  const somethingDropped = selected.droppedForBudget > 0;
  const accountingExact = selected.skills.length + selected.droppedForBudget === 6;
  record(
    checks,
    '(b) token budget is a HARD ceiling; over-budget skills dropped AND counted; accounting exact',
    budgetRespected && somethingDropped && accountingExact,
    `budget=${budget} tokensUsed=${selected.tokensUsed}(<=${budget}=${budgetRespected}); injected=${selected.skills.length} dropped=${selected.droppedForBudget} total=6 accountingExact=${accountingExact}`,
  );

  // Zero budget ⇒ nothing injected, all dropped.
  const zero = selectSkillsForInjection(candidates, 'anything', 0);
  record(
    checks,
    '(b2) zero budget injects nothing; every candidate counted as dropped; tokensUsed=0',
    zero.skills.length === 0 && zero.tokensUsed === 0 && zero.droppedForBudget === 6,
    `${JSON.stringify({ injected: zero.skills.length, tokensUsed: zero.tokensUsed, dropped: zero.droppedForBudget })}`,
  );

  // Empty candidate set is a clean zero.
  const empty = selectSkillsForInjection([], 'anything', 100);
  record(
    checks,
    '(b3) empty candidate set selects nothing (tokensUsed=0, dropped=0, excludedForTools=0)',
    empty.skills.length === 0 &&
      empty.tokensUsed === 0 &&
      empty.droppedForBudget === 0 &&
      empty.excludedForTools === 0,
    `${JSON.stringify(empty.skills.length === 0 ? empty : {})}`,
  );
  store.close();
}

// ---------------------------------------------------------------------------
// (d) NO-OP — no config, and config-on-but-nothing-relevant, both byte-identical
// ---------------------------------------------------------------------------

async function checkNoop(checks: Check[]): Promise<void> {
  // Control: NO skill config at all.
  const store1 = new MemoryStore();
  const baseline = await systemAfterTurn(store1, 'hello', { system: 'BASE-ONLY' });

  // Skill injection ON, but the store has NO skills ⇒ nothing relevant.
  const store2 = new MemoryStore();
  const injectNoSkills = await systemAfterTurn(store2, 'hello', {
    system: 'BASE-ONLY',
    skillBudget: 500,
  });

  // Skill injection ON, a skill EXISTS but its trigger does NOT fire ⇒ no-op.
  const store3 = new MemoryStore();
  store3.putHarnessItem(
    skillReq('narrow', 'NARROW-BODY: only for a specific ask.', {
      triggers: ['a-very-specific-trigger'],
    }),
  );
  const injectNoTrigger = await systemAfterTurn(store3, 'hello', {
    system: 'BASE-ONLY',
    skillBudget: 500,
  });

  const noop =
    baseline === 'BASE-ONLY' &&
    injectNoSkills === baseline &&
    injectNoTrigger === baseline;
  record(
    checks,
    '(d) NO-OP: with no relevant skill (no config / empty store / non-firing trigger) the turn is byte-for-byte the pre-HP-03a turn',
    noop,
    `baseline=${JSON.stringify(baseline)}; empty-store=${JSON.stringify(injectNoSkills)}; non-firing-trigger=${JSON.stringify(injectNoTrigger)}`,
  );
  store1.close();
  store2.close();
  store3.close();
}

// ---------------------------------------------------------------------------

async function main(): Promise<boolean> {
  const checks: Check[] = [];

  // (a)/(c)/(e) + (f) driver parity — run against both drivers.
  for (const [label, make] of [
    ['MemoryStore', () => new MemoryStore()],
    ['SqliteStore', () => new SqliteStore({ path: ':memory:' })],
  ] as const) {
    const store = make();
    await checkPerDriver(checks, store, label);
    store.close();
  }

  // (b) budget — pure selection
  checkBudget(checks);

  // (d) no-op
  await checkNoop(checks);

  console.log('\n=== SPIKE-SKILL — instruction-only skill injection (HP-03a) ===\n');
  let allPass = true;
  for (const c of checks) {
    const tag = c.pass ? 'PASS' : 'FAIL';
    if (!c.pass) allPass = false;
    console.log(`[${tag}] ${c.name}`);
    console.log(`        evidence: ${c.evidence}`);
  }
  console.log(
    `\nSPIKE-SKILL: ${allPass ? 'ALL PASS' : 'FAILURES PRESENT'} (${checks.filter((c) => c.pass).length}/${checks.length})\n`,
  );
  return allPass;
}

main()
  .then((ok) => {
    if (!ok) process.exitCode = 1;
  })
  .catch((e) => {
    console.error('SPIKE-SKILL crashed:', e);
    process.exitCode = 1;
  });
