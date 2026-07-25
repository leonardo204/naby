// src/spikes/spike-policy.ts
//
// Phase 2 (M1) verification: the PolicyStore round-trips rules, and `realPolicy`
// resolves them with the right precedence while staying non-breaking (no rule →
// the baseline decides). Runs on the in-memory store AND SQLite so the two
// drivers agree. Exit 0 = pass, non-zero = fail.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MemoryStore,
  SqliteStore,
  makeGate,
  realPolicy,
  resolvePolicyEffect,
  matchToolPattern,
  phase1HarnessFloor,
  type DecisionPolicy,
  type PolicyRule,
  type Store,
} from '../runtime-entry.js';

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name}`);
    failures += 1;
  }
}

const call = (toolName: string) => ({ toolCallId: 'c1', toolName, input: {} });

async function decide(policy: DecisionPolicy, toolName: string) {
  return policy(call(toolName));
}

async function exerciseStore(label: string, store: Store): Promise<void> {
  console.log(`\n[${label}] PolicyStore round-trip`);
  const USER = 'default-user';
  const PROJ = '/work/proj';

  // upsert + list
  store.putPolicyRule({ scope: 'user', scopeKey: USER, toolPattern: 'Bash', effect: 'allow' });
  store.putPolicyRule({ scope: 'user', scopeKey: USER, toolPattern: 'mcp__jira__*', effect: 'deny' });
  const userRules = store.listPolicyRules('user', USER);
  check('two user rules stored', userRules.length === 2);

  // upsert is by (scope,scopeKey,pattern): change effect, count unchanged
  const updated = store.putPolicyRule({ scope: 'user', scopeKey: USER, toolPattern: 'Bash', effect: 'deny' });
  check('upsert keeps count at 2', store.listPolicyRules('user', USER).length === 2);
  check('upsert changed the effect', updated.effect === 'deny');
  check('upsert kept the id', store.listPolicyRules('user', USER).some((r) => r.id === updated.id));

  // scope isolation
  check('project scope empty', store.listPolicyRules('project', PROJ).length === 0);

  // remove
  const one = store.listPolicyRules('user', USER)[0]!;
  store.removePolicyRule(one.id);
  check('remove drops one', store.listPolicyRules('user', USER).length === 1);

  console.log(`[${label}] realPolicy resolution`);
  // A project 'allow' beats a user 'deny' for the same tool (scope precedence).
  const rules: PolicyRule[] = [
    { id: 'r1', scope: 'user', scopeKey: USER, toolPattern: 'Bash', effect: 'deny', createdAt: 1, updatedAt: 1 },
    { id: 'r2', scope: 'project', scopeKey: PROJ, toolPattern: 'Bash', effect: 'allow', createdAt: 2, updatedAt: 2 },
    { id: 'r3', scope: 'user', scopeKey: USER, toolPattern: '*', effect: 'deny', createdAt: 3, updatedAt: 3 },
    { id: 'r4', scope: 'user', scopeKey: USER, toolPattern: 'mcp__jira__*', effect: 'allow', createdAt: 4, updatedAt: 4 },
  ];
  check('project allow beats user deny', resolvePolicyEffect(rules, 'Bash') === 'allow');
  check('prefix wildcard matches', matchToolPattern('mcp__jira__*', 'mcp__jira__create') === true);
  check('prefix wildcard beats catch-all', resolvePolicyEffect(rules, 'mcp__jira__x') === 'allow');
  check('catch-all applies when no specific rule', resolvePolicyEffect(rules, 'Write') === 'deny');
  check('no rule → undefined', resolvePolicyEffect([], 'Bash') === undefined);

  // Non-breaking: no rules → the baseline decides. Deny-baseline denies Bash;
  // allow-baseline allows it.
  const denyBaseline = makeGate(phase1HarnessFloor([])).gate;
  const allowBaseline: DecisionPolicy = () => ({ behavior: 'allow' });

  const pFloor = realPolicy({ rules: [], fallback: denyBaseline });
  check('baseline(floor): Bash denied', (await decide(pFloor, 'Bash')).behavior === 'deny');
  check('baseline(floor): Read allowed', (await decide(pFloor, 'Read')).behavior === 'allow');

  const pAllow = realPolicy({ rules: [], fallback: allowBaseline });
  check('baseline(allow-all): Bash allowed', (await decide(pAllow, 'Bash')).behavior === 'allow');

  // Rule overrides the baseline both ways.
  const pDenyRule = realPolicy({
    rules: [{ id: 'x', scope: 'user', scopeKey: USER, toolPattern: 'Read', effect: 'deny', createdAt: 1, updatedAt: 1 }],
    fallback: allowBaseline,
  });
  check('deny rule blocks an otherwise-allowed tool', (await decide(pDenyRule, 'Read')).behavior === 'deny');

  const pAllowRule = realPolicy({
    rules: [{ id: 'y', scope: 'project', scopeKey: PROJ, toolPattern: 'Bash', effect: 'allow', createdAt: 1, updatedAt: 1 }],
    fallback: denyBaseline,
  });
  check('allow rule permits an otherwise-denied tool', (await decide(pAllowRule, 'Bash')).behavior === 'allow');

  // 'ask' with no approval bridge → baseline (never invents a decision).
  const pAsk = realPolicy({
    rules: [{ id: 'z', scope: 'user', scopeKey: USER, toolPattern: 'Bash', effect: 'ask', createdAt: 1, updatedAt: 1 }],
    fallback: denyBaseline,
  });
  check("'ask' with no bridge falls to baseline (deny)", (await decide(pAsk, 'Bash')).behavior === 'deny');

  // 'ask' WITH a bridge routes to it.
  let asked = false;
  const pAskBridge = realPolicy({
    rules: [{ id: 'z', scope: 'user', scopeKey: USER, toolPattern: 'Bash', effect: 'ask', createdAt: 1, updatedAt: 1 }],
    fallback: denyBaseline,
    requestApproval: async () => {
      asked = true;
      return { behavior: 'allow' };
    },
  });
  const askedDecision = await decide(pAskBridge, 'Bash');
  check("'ask' with bridge calls requestApproval", asked && askedDecision.behavior === 'allow');
}

async function main(): Promise<void> {
  await exerciseStore('memory', new MemoryStore());

  const dir = mkdtempSync(join(tmpdir(), 'naby-policy-'));
  const sqlite = new SqliteStore({ path: join(dir, 'app.db') });
  await exerciseStore('sqlite', sqlite);

  console.log('');
  if (failures === 0) {
    console.log('PASS — PolicyStore + realPolicy verified on both drivers.');
    process.exit(0);
  }
  console.error(`FAIL — ${failures} check(s) failed.`);
  process.exit(1);
}

void main();
