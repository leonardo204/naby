// src/spikes/spike-review-loop.ts
//
// Review ledger verification (src/runtime/review-loop.ts, field case 2026-11-16):
//
//   * a clean review hands off at once as `clean`;
//   * open findings go to fixers grouped by the file they name first, and a
//     fixer only ever sees its own file's findings;
//   * a fix round is followed by a verify of exactly the changed files;
//   * a chain that comes back after a fix (a finding linked to a FIXED finding)
//     is escalated to the user — not sent to a fixer again, and later findings
//     of it go straight to the user; a link to an unfixed finding only groups;
//   * after the fix-round limit, what is open is handed off by severity;
//   * rules defer (guesses, low severity, no file) but never drop a finding:
//     every finding ends fixed or in the report;
//   * a link to an unknown finding id starts a new chain instead of merging.
//
// Pure — no store, no model, no network. Exit 0 = pass, non-zero = fail.

import {
  ReviewLedger,
  REVIEW_MAX_FIX_ROUNDS,
  validateReviewLoopInput,
  REVIEW_LOOP_RULE,
  reviewRoleRefusal,
  parseReviewerReply,
  parseFixerReply,
  reviewerPrompt,
  runReviewLoop,
  renderReviewReport,
  type ReviewFindingInput,
  type ReviewGroup,
} from '../runtime-entry.js';

let failures = 0;
let passes = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passes += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const f = (over: Partial<ReviewFindingInput>): ReviewFindingInput => ({
  severity: 'high',
  files: ['a.md'],
  problem: 'something is wrong',
  evidence: ['quoted'],
  ...over,
});

console.log('\n[clean] nothing found');
{
  const l = new ReviewLedger();
  l.addReview([]);
  const n = l.next();
  check('hands off as clean', n.kind === 'handoff' && n.reason === 'clean');
}

console.log('\n[fix] grouped by owning file');
{
  const l = new ReviewLedger();
  l.addReview([
    f({ topicTitle: 'login', files: ['db.md', 'api.md'] }),
    f({ topicTitle: 'push', files: ['api.md'], severity: 'medium' }),
    f({ topicTitle: 'naming', files: ['db.md'] }),
  ]);
  const n = l.next();
  check('first step is a fix round', n.kind === 'fix' && n.round === 1);
  if (n.kind === 'fix') {
    check('one assignment per owning file', n.assignments.map((a) => a.file).join(',') === 'api.md,db.md');
    const db = n.assignments.find((a) => a.file === 'db.md')!;
    check('a fixer sees only its file\'s findings', db.findings.length === 2 && db.findings.every((x) => x.files[0] === 'db.md'));
  }
  l.recordFix(
    l.allFindings().map((x) => ({ findingId: x.id, outcome: 'fixed' as const })),
    ['db.md', 'api.md'],
  );
  const v = l.next(true);
  check('a fix round is followed by a verify of the changed files', v.kind === 'verify' && v.files.join(',') === 'api.md,db.md');
}

console.log('\n[reopen] a chain that comes back after a fix goes to the user');
{
  const l = new ReviewLedger();
  const [m] = l.addReview([f({ topicTitle: 'name masking', files: ['server.md'] })]);
  l.next(); // fix round 1
  l.recordFix([{ findingId: m!.id, outcome: 'fixed', note: 'mapping kept per run in Redis' }], ['server.md']);
  l.next(true); // verify
  check('the reviewer sees what the fixer changed', l.reviewerIndex()[0]!.fixNote === 'mapping kept per run in Redis');
  const back = l.addReview([
    f({ relatesTo: { findingId: m!.id, kind: 'caused-by-fix' }, files: ['server.md'], problem: 'mapping per run breaks earlier messages' }),
    f({ relatesTo: { findingId: m!.id, kind: 'again' }, files: ['api.md'], problem: 'same, in the API doc' }),
    f({ topicTitle: 'retry window', files: ['server.md'], severity: 'medium' }),
  ]);
  const topic = l.allTopics().find((t) => t.id === m!.topicId)!;
  check('two links in one round count as one reopen', topic.reopened === 1);
  check('chain escalated', topic.escalated);
  check('its new findings go to the user, not a fixer', back[0]!.status === 'user' && back[1]!.status === 'user');
  check('an unlinked finding stays fixable', back[2]!.status === 'open');
  const n = l.next();
  check('next fix round excludes the escalated chain', n.kind === 'fix' && n.assignments.every((a) => a.findings.every((x) => x.topicId !== m!.topicId)));
  l.recordFix(l.allFindings().filter((x) => x.status === 'assigned').map((x) => ({ findingId: x.id, outcome: 'fixed' as const })), ['server.md']);
  const third = l.addReview([f({ relatesTo: { findingId: back[0]!.id, kind: 'again' }, files: ['server.md'] })]);
  check('later findings of an escalated chain go straight to the user', third[0]!.status === 'user');
  const h = l.next();
  check('hand-off lists the chain as one decision', h.kind === 'handoff' && h.report.decisions.length === 1 && h.report.decisions[0]!.findings.length === 3);
}

console.log('\n[low] a low follow-up does not make a user decision');
{
  const l = new ReviewLedger();
  const [m] = l.addReview([f({ files: ['db.md'] })]);
  l.next();
  l.recordFix([{ findingId: m!.id, outcome: 'fixed' }], ['db.md']);
  l.next(true);
  const [low] = l.addReview([f({ relatesTo: { findingId: m!.id, kind: 'caused-by-fix' }, severity: 'low', files: ['db.md'] })]);
  const t = l.allTopics()[0]!;
  check('not reopened, not escalated', t.reopened === 0 && !t.escalated);
  check('deferred like any low finding', low!.status === 'deferred');
}

console.log('\n[half] the unfinished half in another file is not a reopen');
{
  const l = new ReviewLedger();
  const [m] = l.addReview([f({ files: ['db.md', 'model.md'], problem: 'both files list the wrong writer' })]);
  l.next();
  l.recordFix([{ findingId: m!.id, outcome: 'fixed', note: 'fixed db.md; model.md needs the same change by its owner' }], ['db.md']);
  l.next(true);
  const [rest] = l.addReview([f({ relatesTo: { findingId: m!.id, kind: 'again' }, files: ['model.md'], severity: 'medium' })]);
  check('goes to a fixer, not the user', rest!.status === 'open' && !l.allTopics()[0]!.escalated);
  const n = l.next();
  check('assigned to the other file\'s fixer', n.kind === 'fix' && n.assignments.some((a) => a.file === 'model.md'));
}

console.log('\n[caused] a problem the fix caused counts in any file');
{
  const l = new ReviewLedger();
  const [m] = l.addReview([f({ files: ['server.md'], problem: 'mapping per request breaks a run' })]);
  l.next();
  l.recordFix([{ findingId: m!.id, outcome: 'fixed', note: 'mapping per run' }], ['server.md']);
  l.next(true);
  const [c] = l.addReview([f({ relatesTo: { findingId: m!.id, kind: 'caused-by-fix' }, files: ['agent.md'] })]);
  check('escalated even though it is another file', c!.status === 'user' && l.allTopics()[0]!.escalated);
}

console.log('\n[link] a link to an unfixed finding only groups');
{
  const l = new ReviewLedger();
  const [low] = l.addReview([f({ severity: 'low', topicTitle: 'wording' })]);
  l.next();
  const [again] = l.addReview([f({ relatesTo: { findingId: low!.id, kind: 'again' }, severity: 'medium' })]);
  const t = l.allTopics()[0]!;
  check('same chain', again!.topicId === low!.topicId);
  check('no reopen, not escalated', t.reopened === 0 && !t.escalated && again!.status === 'open');
}

console.log('\n[limit] fix rounds are capped');
{
  const l = new ReviewLedger();
  let n = l.next();
  for (let r = 1; r <= REVIEW_MAX_FIX_ROUNDS + 1; r++) {
    l.addReview([f({ topicTitle: `fresh ${r}`, files: [`doc${r}.md`] })]);
    n = l.next();
    if (n.kind === 'fix') {
      l.recordFix(n.assignments.flatMap((a) => a.findings.map((x) => ({ findingId: x.id, outcome: 'fixed' as const }))), n.assignments.map((a) => a.file));
      l.next(true);
    }
  }
  check(`stops after ${REVIEW_MAX_FIX_ROUNDS} fix rounds`, n.kind === 'handoff' && n.reason === 'fix-limit' && l.rounds.fix === REVIEW_MAX_FIX_ROUNDS);
  check('the open finding is in the report', n.kind === 'handoff' && n.report.remaining.length === 1 && n.report.remaining[0]!.topicId !== undefined);
}

console.log('\n[defer] rules hold back but never drop');
{
  const l = new ReviewLedger();
  const recorded = l.addReview([
    f({ topicTitle: 'guess', evidence: ['inferred'] }),
    f({ topicTitle: 'wording', severity: 'low' }),
    f({ topicTitle: 'orphan', files: [] }),
    f({ topicTitle: 'real' }),
    f({ relatesTo: { findingId: 'F999', kind: 'again' }, topicTitle: 'typo id' }),
  ]);
  check('guess deferred', recorded[0]!.status === 'deferred');
  check('low severity deferred', recorded[1]!.status === 'deferred');
  check('no file deferred', recorded[2]!.status === 'deferred');
  check('a link to an unknown finding starts a new chain', l.allTopics().length === 5 && recorded[4]!.status === 'open');
  const n = l.next();
  check('only fixable findings go to fixers', n.kind === 'fix' && n.assignments.flatMap((a) => a.findings).length === 2);
  l.recordFix([{ findingId: recorded[3]!.id, outcome: 'not-fixed', note: 'needs product call' }], []);
  const h = l.next();
  // Not fixed → back to open → next fix round (round 2) picks it up again.
  check('a not-fixed finding returns as open, not lost', h.kind === 'fix' && h.assignments.flatMap((a) => a.findings).some((x) => x.id === recorded[3]!.id));
  l.recordFix([], []);
  const end = l.next();
  if (end.kind === 'handoff') {
    const accounted = end.report.fixed + end.report.remaining.length + end.report.deferred.length + end.report.decisions.reduce((s, d) => s + d.findings.length, 0);
    check('every finding is accounted for in the report', accounted === l.allFindings().length, `${accounted} of ${l.allFindings().length}`);
    check('remaining is ordered by severity', end.report.remaining.every((x, i, a) => i === 0 || (a[i - 1]!.severity === 'high' || x.severity !== 'high')));
  } else {
    check('ends in a hand-off', false, end.kind);
  }
}

console.log('\n[tool] input check');
{
  check('empty goal and groups refused', validateReviewLoopInput({}).problems.length >= 2);
  check('bad maxFixRounds refused', validateReviewLoopInput({ goal: 'g', groups: [{ files: ['a.md'] }], maxFixRounds: 5 }).problems.length === 1);
  const ok = validateReviewLoopInput({ goal: 'g', groups: [{ name: 'x', files: [' a.md ', ''] }] });
  check('a good call passes, trimmed, default fix rounds', ok.problems.length === 0 && ok.input!.groups[0]!.files.join() === 'a.md' && ok.input!.maxFixRounds === REVIEW_MAX_FIX_ROUNDS);
}

console.log('\n[policy] reviewers read, fixers edit one file');
{
  const res = (p: string) => (p.startsWith('/') ? p : `/proj/${p}`);
  const call = (toolName: string, input: unknown) => ({ toolCallId: 'c', toolName, input });
  check('reviewer may Read', reviewRoleRefusal({ kind: 'reviewer' }, call('Read', { file_path: '/proj/a.md' }), res) === undefined);
  check('reviewer may not Edit', reviewRoleRefusal({ kind: 'reviewer' }, call('Edit', { file_path: '/proj/a.md' }), res) !== undefined);
  check('reviewer may not run Bash', reviewRoleRefusal({ kind: 'reviewer' }, call('Bash', { command: 'ls' }), res) !== undefined);
  check('reviewer may not spawn subagents', reviewRoleRefusal({ kind: 'reviewer' }, call('Agent', {}), res) !== undefined);
  const fixer = { kind: 'fixer' as const, file: 'docs/a.md' };
  check('fixer may Edit its file (relative or absolute)', reviewRoleRefusal(fixer, call('Edit', { file_path: '/proj/docs/a.md' }), res) === undefined && reviewRoleRefusal(fixer, call('edit_file', { path: 'docs/a.md' }), res) === undefined);
  check('fixer may not Edit another file', reviewRoleRefusal(fixer, call('Write', { file_path: '/proj/docs/b.md' }), res) !== undefined);
  check('fixer may not run Bash', reviewRoleRefusal(fixer, call('Bash', { command: 'sed -i' }), res) !== undefined);
}

console.log('\n[parse] replies');
{
  const r = parseReviewerReply('Thinking...\n```json\n{"findings":[{"severity":"high","files":["a.md"],"problem":"p","evidence":["quoted","bogus"],"relatesTo":{"findingId":"F3","kind":"again"}},{"severity":"x","problem":"q"},{"files":["a"]}]}\n```');
  check('findings read, bad severity → medium, bad evidence dropped', r.ok && r.findings.length === 2 && r.findings[1]!.severity === 'medium' && r.findings[0]!.evidence.join() === 'quoted');
  check('link kept', r.findings[0]!.relatesTo?.findingId === 'F3');
  check('a finding without a problem is dropped and counted', r.dropped === 1);
  check('no JSON → not ok (never "found nothing")', !parseReviewerReply('I could not finish.').ok);
  const fx = parseFixerReply('```json\n{"results":[{"id":"F1","outcome":"fixed","note":"n"},{"id":"F9","outcome":"fixed"},{"id":"F2","outcome":"maybe"}]}\n```', ['F1', 'F2']);
  check('fixer results: unknown ids and outcomes ignored', fx.length === 1 && fx[0]!.findingId === 'F1');
  const p = reviewerPrompt({ goal: 'G', group: { name: 'g', files: ['a.md'] }, index: [{ id: 'F1', files: ['a.md'], problem: 'x', status: 'fixed', fixNote: 'changed y' }], verify: { changedFiles: ['a.md'] } });
  check('verify prompt names the changed files and shows fix notes', p.includes('CHECK THE FIXES') && p.includes('fixNote: changed y'));
}

console.log('\n[loop] end to end with fake models');
{
  const groups: ReviewGroup[] = [{ name: 'db', files: ['db.md'] }, { name: 'api', files: ['api.md'], references: ['db.md'] }];
  let reviews = 0;
  const fixCalls: string[] = [];
  const json = (o: unknown) => '```json\n' + JSON.stringify(o) + '\n```';
  const result = await runReviewLoop(
    { goal: 'G', groups, maxFixRounds: 2 },
    {
      review: async (g, prompt) => {
        reviews += 1;
        if (!prompt.includes('CHECK THE FIXES')) {
          return { ok: true, text: json({ findings: g.name === 'db'
            ? [{ severity: 'high', files: ['db.md'], problem: 'login column missing', evidence: ['quoted'] }]
            : [{ severity: 'medium', files: ['api.md'], problem: 'field name differs', evidence: ['cross-doc'] }, { severity: 'low', files: ['api.md'], problem: 'typo', evidence: ['quoted'] }] }) };
        }
        // Verify: the db fix caused a new problem, linked to F1.
        return { ok: true, text: g.name === 'db' ? json({ findings: [{ severity: 'high', files: ['db.md'], problem: 'new NOT NULL column breaks first login', evidence: ['quoted'], relatesTo: { findingId: 'F1', kind: 'caused-by-fix' } }] }) : json({ findings: [] }) };
      },
      fix: async (file, prompt) => {
        fixCalls.push(file);
        const ids = [...prompt.matchAll(/^(F\d+) \[/gm)].map((m) => m[1]);
        return { ok: true, text: json({ results: ids.map((id) => ({ id, outcome: 'fixed', note: `edited ${file}` })) }) };
      },
    },
  );
  check('one fix round, then verify, then hand-off', result.report.fixRounds === 1 && result.report.reason === 'only-user-decisions', `${result.report.fixRounds} ${result.report.reason}`);
  check('fixers ran once per file', fixCalls.sort().join() === 'api.md,db.md');
  check('initial review + verify of both groups (api references db)', reviews === 4, String(reviews));
  check('the fix-caused problem is a user decision', result.report.decisions.length === 1 && result.report.decisions[0]!.findings[0]!.problem.includes('NOT NULL'));
  check('the low finding is deferred, not lost', result.report.deferred.length === 1);
  const md = renderReviewReport(result, { id: 'rl-test', goal: 'G', minutes: 1 });
  check('report shows the decision with its fix history', md.includes('Decisions for the user (1)') && md.includes('earlier F1 (fixed)') && md.includes('edited db.md'));
  check('report lists what each fixer changed', md.includes('## Fixed (') && md.includes('→ edited api.md'));
}

console.log('\n[loop] a failing reviewer is reported, not read as clean');
{
  const result = await runReviewLoop(
    { goal: 'G', groups: [{ name: 'db', files: ['db.md'] }], maxFixRounds: 0 },
    { review: async () => ({ ok: true, text: 'ran out of time' }), fix: async () => ({ ok: true, text: '' }) },
  );
  check('failure listed', result.failures.length === 1 && result.failures[0]!.who === 'db');
  check('review-only mode never fixes', result.report.fixRounds === 0);
}

console.log('\n[seed] known findings start with a fix');
{
  const v = validateReviewLoopInput({ goal: 'G', groups: [{ name: 'g', files: ['a.md'] }], findings: [{ files: ['a.md'], problem: 'apply D1' }, { files: [], problem: 'x' }] });
  check('a seed without files is refused', v.problems.some((p) => p.includes('files')));
  const ok = validateReviewLoopInput({ goal: 'G', groups: [{ name: 'g', files: ['a.md'] }], findings: [{ files: ['a.md'], problem: 'apply D1', severity: 'high' }] });
  check('a good seed passes with evidence "spec"', ok.problems.length === 0 && ok.input!.findings![0]!.evidence.join() === 'spec');
  check('seeds with review-only are refused', validateReviewLoopInput({ goal: 'G', groups: [{ name: 'g', files: ['a.md'] }], maxFixRounds: 0, findings: [{ files: ['a.md'], problem: 'p' }] }).problems.length === 1);
  const steps: string[] = [];
  const json = (o: unknown) => '```json\n' + JSON.stringify(o) + '\n```';
  const r = await runReviewLoop(ok.input!, {
    review: async (_g, prompt) => { steps.push(prompt.includes('CHECK THE FIXES') ? 'verify' : 'review'); return { ok: true, text: json({ findings: [] }) }; },
    fix: async (_file, prompt) => { steps.push('fix'); const ids = [...prompt.matchAll(/^(F\d+) \[/gm)].map((m) => m[1]); return { ok: true, text: json({ results: ids.map((id) => ({ id, outcome: 'fixed' })) }) }; },
  });
  check('no first review: fix, then verify', steps.join(',') === 'fix,verify', steps.join(','));
  check('ends clean with the seed fixed', r.report.reason === 'clean' && r.report.fixed === 1);
  check('the system rule names the tool and the findings input', REVIEW_LOOP_RULE.includes('naby_review_loop') && REVIEW_LOOP_RULE.includes('`findings`'));
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
