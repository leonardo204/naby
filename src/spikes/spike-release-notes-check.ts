// src/spikes/spike-release-notes-check.ts
//
// THE RELEASE-NOTES GUARD — scripts/check-release-notes.mjs, run as the release
// workflow runs it: a child `node` process, judged by exit code and message.
//
// WHY IT EXISTS. 1.40.0–1.42.0 shipped with no entry in the shell's
// RELEASE_NOTES_MARKDOWN, so the "What changed" popup had nothing to say on the
// one launch it exists for. The guard turns that into a failed release. A guard
// that never fails is indistinguishable from one that works, so this spike makes
// it fail on purpose, once per rule, and makes it pass once on a good file.
//
// EVERYTHING IS A TEMP FILE. Each case writes its own releaseNotes.ts-shaped
// source and its own package.json under a mkdtemp directory and points the
// script at them with --notes / --package. The real releaseNotes.ts is never
// read here — it is edited by hand at release time and its state says nothing
// about whether the guard is correct.
//
// GITHUB_* ARE SCRUBBED from the child's environment unless a case sets them, so
// running this inside an Actions job (where GITHUB_REF_NAME is set) cannot change
// the verdicts.

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

type Check = { name: string; pass: boolean; evidence: string };
const checks: Check[] = [];
const record = (name: string, pass: boolean, evidence: string): void => {
  checks.push({ name, pass, evidence });
};

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'check-release-notes.mjs');

/** A releaseNotes.ts lookalike: the header comment and the exported template. */
function notesSource(markdown: string): string {
  return [
    '/**',
    ' * Fixture. `## 9.9.9 — 2000-01-01` in a comment must not count as an entry.',
    ' */',
    'export const RELEASE_NOTES_MARKDOWN = `',
    markdown,
    '`;',
    '',
  ].join('\n');
}

const block = (
  version: string,
  date: string,
  opts: { en?: string | null; ko?: string | null } = {},
): string => {
  const en = opts.en === undefined ? 'Something changed, with \\`code\\` in it.' : opts.en;
  const ko = opts.ko === undefined ? '무언가 바뀌었어요. \\`코드\\`도 있어요.' : opts.ko;
  const parts = [`## ${version} — ${date}`, ''];
  if (en !== null) parts.push('### en', '', en, '');
  if (ko !== null) parts.push('### ko', '', ko, '');
  return parts.join('\n');
};

interface Run {
  status: number | null;
  out: string;
}

function run(
  dir: string,
  name: string,
  opts: {
    pkgVersion: string;
    markdown?: string;
    source?: string;
    args?: string[];
    env?: Record<string, string>;
  },
): Run {
  const notes = join(dir, `${name}.releaseNotes.ts`);
  const pkg = join(dir, `${name}.package.json`);
  writeFileSync(notes, opts.source ?? notesSource(opts.markdown ?? ''));
  writeFileSync(pkg, JSON.stringify({ name: 'fixture', version: opts.pkgVersion }));

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('GITHUB_')) env[k] = v;
  }
  Object.assign(env, opts.env ?? {});

  const res = spawnSync(
    process.execPath,
    [SCRIPT, ...(opts.args ?? []), '--notes', notes, '--package', pkg],
    { env, encoding: 'utf8' },
  );
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() };
}

const firstLine = (s: string): string => s.split('\n')[0] ?? '';

function main(): void {
  const dir = mkdtempSync(join(tmpdir(), 'naby-release-notes-'));
  const goodMd = `\n${block('1.43.0', '2026-10-13')}\n${block('1.42.0', '2026-10-07')}`;

  // (a) the happy path — the first heading is the version, both bodies present,
  // escaped backticks inside the bodies do not end the template early.
  {
    const r = run(dir, 'ok', { pkgVersion: '1.43.0', markdown: goodMd });
    record(
      'matching first entry with en + ko passes',
      r.status === 0 && /^release notes OK: 1\.43\.0 — 2026-10-13/.test(r.out),
      `exit ${r.status}: ${firstLine(r.out)}`,
    );
  }

  // (b) the 1.40–1.42 failure mode: the newest entry is an older release.
  {
    const r = run(dir, 'older', { pkgVersion: '1.44.0', markdown: goodMd });
    record(
      'first heading is an older version → fail',
      r.status === 1 && r.out.includes('missing for 1.44.0') && r.out.includes('## 1.44.0 — '),
      `exit ${r.status}: ${firstLine(r.out)}`,
    );
  }

  // (c) one language written, the other forgotten.
  {
    const md = `\n${block('1.43.0', '2026-10-13', { ko: null })}\n${block('1.42.0', '2026-10-07')}`;
    const r = run(dir, 'noko', { pkgVersion: '1.43.0', markdown: md });
    record(
      'missing ### ko section → fail',
      r.status === 1 && r.out.includes('"### ko"') && !r.out.includes('"### en"'),
      `exit ${r.status}: ${firstLine(r.out)}`,
    );
  }

  // (c2) the heading is there but the body is blank — still not a release note.
  // The NEXT block's ko must not be borrowed to fill it.
  {
    const md = `\n${block('1.43.0', '2026-10-13', { ko: '   ' })}\n${block('1.42.0', '2026-10-07')}`;
    const r = run(dir, 'emptyko', { pkgVersion: '1.43.0', markdown: md });
    record(
      'empty ### ko body → fail (no borrowing from the next block)',
      r.status === 1 && r.out.includes('"### ko"'),
      `exit ${r.status}: ${firstLine(r.out)}`,
    );
  }

  // (d) a tag that does not match package.json is a broken release on its own.
  {
    const r = run(dir, 'tagmismatch', {
      pkgVersion: '1.43.0',
      markdown: goodMd,
      env: { GITHUB_REF_NAME: 'v1.43.1', GITHUB_REF_TYPE: 'tag' },
    });
    record(
      'tag / package.json mismatch → fail even though the notes match package.json',
      r.status === 1 && r.out.includes('version mismatch') && r.out.includes('1.43.1'),
      `exit ${r.status}: ${firstLine(r.out)}`,
    );
  }

  // (d2) the same rule for a version passed on the command line.
  {
    const r = run(dir, 'argmismatch', { pkgVersion: '1.43.0', markdown: goodMd, args: ['1.42.0'] });
    record(
      'argv / package.json mismatch → fail',
      r.status === 1 && r.out.includes('version mismatch'),
      `exit ${r.status}: ${firstLine(r.out)}`,
    );
  }

  // (d3) and the matching tag passes.
  {
    const r = run(dir, 'tagmatch', {
      pkgVersion: '1.43.0',
      markdown: goodMd,
      args: ['v1.43.0'],
      env: { GITHUB_REF_NAME: 'v1.43.0', GITHUB_REF_TYPE: 'tag' },
    });
    record('matching tag + argv + package.json passes', r.status === 0, `exit ${r.status}: ${firstLine(r.out)}`);
  }

  // (e) a workflow_dispatch dry run from a branch sets GITHUB_REF_NAME=main; that
  // is not a version and must not be read as one.
  {
    const r = run(dir, 'branch', {
      pkgVersion: '1.43.0',
      markdown: goodMd,
      env: { GITHUB_REF_NAME: 'main', GITHUB_REF_TYPE: 'branch' },
    });
    record('a branch ref name is ignored', r.status === 0, `exit ${r.status}: ${firstLine(r.out)}`);
  }

  // (f) a date that is not a real YYYY-MM-DD.
  {
    const md = `\n${block('1.43.0', '2026-13-40')}\n${block('1.42.0', '2026-10-07')}`;
    const r = run(dir, 'baddate', { pkgVersion: '1.43.0', markdown: md });
    const md2 = `\n${block('1.43.0', '')}\n${block('1.42.0', '2026-10-07')}`.replace('## 1.43.0 — ', '## 1.43.0');
    const r2 = run(dir, 'nodate', { pkgVersion: '1.43.0', markdown: md2 });
    record(
      'invalid or missing date → fail',
      r.status === 1 && r.out.includes('YYYY-MM-DD') && r2.status === 1 && r2.out.includes('YYYY-MM-DD'),
      `exit ${r.status}: ${firstLine(r.out)} / exit ${r2.status}: ${firstLine(r2.out)}`,
    );
  }

  // (g) a `## ` line inside the comment header or an escaped backtick must not
  // fool the scanner; an unescaped interpolation is refused outright.
  {
    const src = notesSource(goodMd).replace('Something changed', 'Costs \\${price} and ${price}');
    const r = run(dir, 'interp', { pkgVersion: '1.43.0', source: src });
    record(
      'a ${...} interpolation in the template → fail',
      r.status === 1 && r.out.includes('interpolation'),
      `exit ${r.status}: ${firstLine(r.out)}`,
    );
  }

  // (h) no template at all — e.g. the submodule was not checked out.
  {
    const r = run(dir, 'nofile', { pkgVersion: '1.43.0', source: 'export const OTHER = 1;\n' });
    record(
      'source without RELEASE_NOTES_MARKDOWN → fail',
      r.status === 1 && r.out.includes('RELEASE_NOTES_MARKDOWN'),
      `exit ${r.status}: ${firstLine(r.out)}`,
    );
  }

  rmSync(dir, { recursive: true, force: true });

  const failed = checks.filter((c) => !c.pass);
  for (const c of checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`);
    console.log(`      ${c.evidence}`);
  }
  console.log(
    failed.length === 0
      ? `\nALL PASS — ${checks.length}/${checks.length} assertions`
      : `\nFAILED — ${failed.length} of ${checks.length} assertions:\n${failed
          .map((c) => `  - ${c.name}`)
          .join('\n')}`,
  );
  if (failed.length > 0) process.exit(1);
}

main();
