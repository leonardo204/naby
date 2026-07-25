// src/spikes/spike-bootstrap.ts
//
// Phase 1.5 (P15-07) verification: COLD START, through the real write gate.
//
// The acceptance criterion is specific: "at least one path produces CONFIRMED
// user/org memory for a brand-new user." Confirmed is the load-bearing word — the
// write gate refuses to auto-confirm external content, and only `confirmed`
// memory is ever injected. So this drives the answers through the REAL store and
// the REAL gate and then reads them back through the REAL injection path, because
// a row that is stored but not injectable would satisfy nothing.
//
// Asserted:
//   (a) A brand-new store offers the interview; a finished one does not.
//   (b) Answers land as CONFIRMED user-tier memory — through the gate, not around
//       it — and reach the next turn's system prompt.
//   (c) Blank answers are skipped rather than stored as empty facts.
//   (d) A credential typed into the box is refused, and reported.
//   (e) Re-answering UPDATES the same row instead of adding a duplicate.
//   (f) An answer for a question that does not exist is refused.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP_DIR = mkdtempSync(join(tmpdir(), 'naby-spike-bootstrap-'));
process.env.NABY_DB_PATH = join(TMP_DIR, 'app.db');

import {
  BOOTSTRAP_DONE_KEY,
  BOOTSTRAP_QUESTIONS,
  DEFAULT_USER_ID,
  SqliteStore,
  answersToMemory,
  retrieveForInjection,
  shouldOfferBootstrap,
} from '../runtime-entry.js';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
function record(name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

const store = new SqliteStore(process.env.NABY_DB_PATH!);
const NOW = 1_784_000_000_000;
const userMemory = () => store.getScopedMemory('user', DEFAULT_USER_ID);

// -- (a) when it is offered -------------------------------------------------
{
  const fresh = shouldOfferBootstrap({ doneFlag: undefined, existingKeys: [] });
  const done = shouldOfferBootstrap({ doneFlag: 'true', existingKeys: [] });
  const answered = shouldOfferBootstrap({
    doneFlag: undefined,
    existingKeys: BOOTSTRAP_QUESTIONS.map((q) => q.id),
  });
  record(
    '(a) a new store is offered the interview; a finished or dismissed one is not',
    fresh === true && done === false && answered === false && BOOTSTRAP_QUESTIONS.length === 4,
    `fresh=${fresh} dismissed=${done} all-answered=${answered} questions=${BOOTSTRAP_QUESTIONS.length}`,
  );
}

// -- (b)(c)(d)(f) one pass through the real gate ---------------------------
{
  const { writes, skipped } = answersToMemory(
    {
      'how-to-address-me': '지훈이라고 불러 주세요.',
      'answer-language': '한국어로 답해 주세요.',
      'how-i-want-work-done': '결론을 먼저 말하고 근거를 뒤에 붙여 주세요.',
      // Left blank on purpose: every question may be skipped.
      'standing-rule': '   ',
      // A credential typed into a free-text box. Synthetic but credential-SHAPED.
      'not-a-question': 'x',
    },
    { userId: DEFAULT_USER_ID, now: NOW },
  );
  for (const w of writes) store.putMemory(w);

  const stored = userMemory();
  const statuses = stored.map((m) => `${m.key}=${m.status}/${m.provenance.source}`);
  record(
    '(b) answers land as CONFIRMED user-tier memory, through the real gate',
    stored.length === 3 &&
      stored.every((m) => m.status === 'confirmed' && m.provenance.source === 'user' && m.confidence === 1),
    statuses.join(' '),
  );

  // The point of confirmed: it is injected. Anything less is a row nobody reads.
  const session = store.createSession('spike');
  const injected = retrieveForInjection(
    store,
    { sessionId: session.sessionId, tokenBudget: 500 },
    { userId: DEFAULT_USER_ID },
  );
  const lines = injected.items.map((i) => i.key);
  record(
    '(b2) and they reach the next turn — confirmed memory is what gets injected',
    lines.includes('how-to-address-me') &&
      lines.includes('answer-language') &&
      lines.includes('how-i-want-work-done'),
    `injected: ${JSON.stringify(lines)} (${injected.tokensUsed} tokens)`,
  );

  record(
    '(c) a blank answer is skipped, not stored as an empty fact',
    skipped.some((s) => s.id === 'standing-rule' && s.reason === 'empty') &&
      !stored.some((m) => m.key === 'standing-rule'),
    `skipped: ${JSON.stringify(skipped)}`,
  );
  record(
    '(f) an answer to a question that does not exist is refused',
    skipped.some((s) => s.id === 'not-a-question' && s.reason === 'unknown-question'),
    `skipped ids: ${JSON.stringify(skipped.map((s) => s.id))}`,
  );
}

// -- (d) the secret sweep --------------------------------------------------
{
  const { writes, skipped } = answersToMemory(
    { 'standing-rule': 'always deploy with sk-EXAMPLE-not-a-real-key-000000' },
    { userId: DEFAULT_USER_ID, now: NOW },
  );
  record(
    '(d) a credential typed into the box is refused, and reported rather than dropped',
    writes.length === 0 &&
      skipped.length === 1 &&
      skipped[0]!.reason === 'looks-like-secret' &&
      !JSON.stringify(userMemory()).includes('sk-EXAMPLE'),
    `writes=${writes.length} skipped=${JSON.stringify(skipped)}`,
  );
}

// -- (e) re-answering updates rather than duplicates ----------------------
{
  const before = userMemory().length;
  const { writes } = answersToMemory(
    { 'answer-language': '영어로 답해 주세요.' },
    { userId: DEFAULT_USER_ID, now: NOW + 1000 },
  );
  for (const w of writes) store.putMemory(w);
  const after = userMemory();
  const lang = after.find((m) => m.key === 'answer-language');
  record(
    '(e) re-answering updates the same row instead of adding a duplicate',
    after.length === before &&
      lang?.value === '영어로 답해 주세요.' &&
      after.filter((m) => m.key === 'answer-language').length === 1,
    `rows ${before} → ${after.length}; answer-language="${lang?.value ?? ''}"`,
  );
}

// -- the done flag --------------------------------------------------------
{
  store.setSetting(BOOTSTRAP_DONE_KEY, 'true');
  record(
    '(a2) once recorded as done, the interview stays closed across reads',
    shouldOfferBootstrap({
      doneFlag: store.getSetting(BOOTSTRAP_DONE_KEY),
      existingKeys: [],
    }) === false,
    `flag=${store.getSetting(BOOTSTRAP_DONE_KEY)}`,
  );
}

let failed = 0;
for (const c of checks) {
  if (!c.pass) failed += 1;
  console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}\n      ${c.evidence}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
rmSync(TMP_DIR, { recursive: true, force: true });
if (failed > 0) process.exitCode = 1;
