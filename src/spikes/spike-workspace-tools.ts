// src/spikes/spike-workspace-tools.ts
//
// SPIKE-WORKSPACE-TOOLS — the workspace toolset, exercised against a real
// temporary project.
//
// WHAT THIS IS FOR. `read_file`/`glob`/`grep`/`write_file`/`edit_file`/
// `run_command` are the tools that made every provider able to see the project,
// and three properties of them are load-bearing enough that a regression would
// be worse than not having shipped them:
//
//   (a) CONTAINMENT — a path argument cannot escape the project directory. If it
//       can, a model that misreads a request reads the user's ssh key.
//   (b) READ-ONLY REALLY MEANS READ-ONLY — with mutations disallowed the writing
//       tools are not merely refused, they are absent, AND the gate floor denies
//       them even if a name is called from memory of an earlier turn.
//   (c) EDIT IS EXACT — an ambiguous edit refuses rather than guessing which
//       occurrence the model meant.
//
// Run: npm run spike:workspace-tools

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWorkspaceTools, MUTATING_TOOLS } from '../runtime/fs-tools.js';
import { phase1HarnessFloor } from '../runtime/gate.js';
import { isConsequentialTool } from '../runtime/checkin.js';
import type { Executor, ToolOutput } from '../runtime/engine.js';

type Check = { name: string; pass: boolean; evidence: string };

function record(checks: Check[], name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

const ctx = () => ({
  toolCall: { toolCallId: 'c1', toolName: 't', input: {} },
  signal: new AbortController().signal,
});

const call = (exec: Executor, input: unknown): Promise<ToolOutput> => exec(input, ctx());

function seedProject(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'junk'), { recursive: true });
  writeFileSync(join(root, 'README.md'), '# Demo\n\nA project.\n');
  writeFileSync(join(root, 'src', 'a.ts'), 'export const answer = 42;\nexport const other = 1;\n');
  writeFileSync(join(root, 'src', 'b.ts'), 'import { answer } from "./a";\nconsole.log(answer);\n');
  writeFileSync(join(root, 'node_modules', 'junk', 'c.ts'), 'export const answer = 999;\n');
}

async function main(tmpDir: string): Promise<boolean> {
  const checks: Check[] = [];
  const root = join(tmpDir, 'project');
  seedProject(root);
  // A file OUTSIDE the project, standing in for anything in the user's home.
  writeFileSync(join(tmpDir, 'secret.txt'), 'do-not-read-me\n');

  const full = buildWorkspaceTools({ cwd: root, allowMutations: true });
  const ro = buildWorkspaceTools({ cwd: root, allowMutations: false });

  // -- (a) containment ------------------------------------------------------
  const escapes = await Promise.all([
    call(full.executors.read_file!, { path: '../secret.txt' }),
    call(full.executors.read_file!, { path: join(tmpDir, 'secret.txt') }),
    call(full.executors.write_file!, { path: '../pwned.txt', content: 'x' }),
    call(full.executors.read_file!, { path: 'src/../../secret.txt' }),
  ]);
  record(
    checks,
    '(a) every path argument is contained inside the project',
    escapes.every((r) => r.isError === true && /outside the project/.test(r.content)),
    escapes.map((r) => `${r.isError ? 'refused' : 'ALLOWED'}: ${r.content.slice(0, 60)}`).join(' | '),
  );

  // A path that merely LOOKS like an escape but normalises back inside is fine.
  const backInside = await call(full.executors.read_file!, { path: 'src/../README.md' });
  record(
    checks,
    '(a2) containment is checked after normalisation, not by looking for ".."',
    backInside.isError !== true && backInside.content.includes('# Demo'),
    `content starts: ${backInside.content.slice(0, 48).replace(/\n/g, '\\n')}`,
  );

  // -- (b) read-only is read-only ------------------------------------------
  const roNames = ro.toolSchemas.map((t) => t.name);
  const fullNames = full.toolSchemas.map((t) => t.name);
  record(
    checks,
    '(b) with mutations disallowed the writing tools are ABSENT, not just refused',
    MUTATING_TOOLS.every((n) => !roNames.includes(n) && !(n in ro.executors)) &&
      MUTATING_TOOLS.every((n) => fullNames.includes(n)),
    `read-only=${JSON.stringify(roNames)}; full=${JSON.stringify(fullNames)}`,
  );

  // The gate floor is the second barrier: it must deny the mutating names even
  // when a composition root hands them in as "our own runtime tools".
  const floor = phase1HarnessFloor([...fullNames, 'echo_note']);
  // A DecisionPolicy may answer synchronously or not; await covers both.
  const floorVerdicts = await Promise.all(
    fullNames.map(async (n) => ({
      n,
      d: await floor({ toolCallId: 'x', toolName: n, input: {} }),
    })),
  );
  const mutatingDenied = floorVerdicts
    .filter((v) => MUTATING_TOOLS.includes(v.n))
    .every((v) => v.d.behavior === 'deny');
  const readingAllowed = floorVerdicts
    .filter((v) => !MUTATING_TOOLS.includes(v.n))
    .every((v) => v.d.behavior === 'allow');
  record(
    checks,
    '(b2) the gate floor denies the mutating runtime tools and allows the reading ones',
    mutatingDenied && readingAllowed,
    floorVerdicts.map((v) => `${v.n}=${v.d.behavior}`).join(' '),
  );

  record(
    checks,
    '(b3) writing tools count as consequential, so the trust meter sees them',
    MUTATING_TOOLS.every((n) => isConsequentialTool(n)) && !isConsequentialTool('read_file'),
    `${MUTATING_TOOLS.join('/')} consequential=true; read_file=${isConsequentialTool('read_file')}`,
  );

  // -- reading --------------------------------------------------------------
  const read = await call(full.executors.read_file!, { path: 'src/a.ts' });
  record(
    checks,
    '(c) read_file returns numbered lines with a path header',
    read.content.includes('src/a.ts') && /1\texport const answer = 42;/.test(read.content),
    read.content.split('\n').slice(0, 2).join(' / '),
  );

  const listed = await call(full.executors.list_dir!, { path: '.' });
  record(
    checks,
    '(d) list_dir shows directories first and marks them',
    listed.content.includes('src/') && listed.content.includes('README.md'),
    listed.content.replace(/\n/g, ' '),
  );

  const globbed = await call(full.executors.glob!, { pattern: '**/*.ts' });
  record(
    checks,
    '(e) glob finds project files and skips node_modules',
    globbed.content.includes('src/a.ts') &&
      globbed.content.includes('src/b.ts') &&
      !globbed.content.includes('node_modules'),
    globbed.content.replace(/\n/g, ' '),
  );

  const grepped = await call(full.executors.grep!, { pattern: 'answer' });
  record(
    checks,
    '(f) grep reports file:line for content matches, skipping node_modules',
    grepped.content.includes('src/a.ts:1') &&
      grepped.content.includes('src/b.ts:') &&
      !grepped.content.includes('node_modules'),
    grepped.content.replace(/\n/g, ' ').slice(0, 160),
  );

  // -- writing --------------------------------------------------------------
  const wrote = await call(full.executors.write_file!, {
    path: 'src/new/deep.ts',
    content: 'export const x = 1;\n',
  });
  const wroteOk = readFileSync(join(root, 'src', 'new', 'deep.ts'), 'utf8') === 'export const x = 1;\n';
  record(
    checks,
    '(g) write_file creates missing parent directories',
    wrote.isError !== true && wroteOk,
    `${wrote.content} | on disk=${wroteOk}`,
  );

  const ambiguous = await call(full.executors.edit_file!, {
    path: 'src/a.ts',
    oldString: 'export const',
    newString: 'const',
  });
  record(
    checks,
    '(h) edit_file refuses an ambiguous match instead of guessing',
    ambiguous.isError === true && /appears 2 times/.test(ambiguous.content),
    ambiguous.content.slice(0, 100),
  );

  const edited = await call(full.executors.edit_file!, {
    path: 'src/a.ts',
    oldString: 'answer = 42',
    newString: 'answer = 43',
  });
  const editedOk = readFileSync(join(root, 'src', 'a.ts'), 'utf8').includes('answer = 43');
  record(
    checks,
    '(h2) a unique edit applies exactly once',
    edited.isError !== true && editedOk,
    `${edited.content} | on disk=${editedOk}`,
  );

  const missing = await call(full.executors.edit_file!, {
    path: 'src/a.ts',
    oldString: 'never appears anywhere',
    newString: 'x',
  });
  record(
    checks,
    '(h3) an edit whose target is not in the file explains itself',
    missing.isError === true && /does not appear/.test(missing.content),
    missing.content.slice(0, 90),
  );

  // -- running --------------------------------------------------------------
  const ran = await call(full.executors.run_command!, { command: 'echo hello && pwd' });
  record(
    checks,
    '(i) run_command runs in the project directory and reports the exit code',
    ran.isError !== true && ran.content.includes('hello') && ran.content.includes('(exit 0)'),
    ran.content.replace(/\n/g, ' ').slice(0, 120),
  );

  const failed = await call(full.executors.run_command!, { command: 'exit 3' });
  record(
    checks,
    '(i2) a non-zero exit is surfaced as an error, not silently swallowed',
    failed.isError === true && failed.content.includes('(exit 3)'),
    failed.content.replace(/\n/g, ' ').slice(0, 90),
  );

  const timedOut = await call(full.executors.run_command!, {
    command: 'sleep 5',
    timeoutMs: 1_000,
  });
  record(
    checks,
    '(i3) a hanging command is killed at its timeout rather than blocking the turn',
    timedOut.isError === true && /timed out/.test(timedOut.content),
    timedOut.content.replace(/\n/g, ' ').slice(0, 90),
  );

  // ---- Report -------------------------------------------------------------
  console.log('\n=== SPIKE-WORKSPACE-TOOLS — read/search/edit/run over the open project ===\n');
  let allPass = true;
  for (const c of checks) {
    if (!c.pass) allPass = false;
    console.log(`[${c.pass ? 'PASS' : 'FAIL'}] ${c.name}`);
    console.log(`        evidence: ${c.evidence}`);
  }
  console.log(
    `\nSPIKE-WORKSPACE-TOOLS: ${allPass ? 'ALL PASS' : 'FAILURES PRESENT'} (${
      checks.filter((c) => c.pass).length
    }/${checks.length})\n`,
  );
  return allPass;
}

const tmpDir = mkdtempSync(join(tmpdir(), 'naby-workspace-tools-'));
try {
  const ok = await main(tmpDir);
  process.exit(ok ? 0 : 1);
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
