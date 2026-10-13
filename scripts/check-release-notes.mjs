#!/usr/bin/env node
// scripts/check-release-notes.mjs
//
// DOES THIS RELEASE HAVE IN-APP RELEASE NOTES? (`npm run release:check-notes`, and
// the `release-notes` preflight job in .github/workflows/release.yml)
//
// WHY THIS EXISTS. The "What changed" popup reads `RELEASE_NOTES_MARKDOWN` from
// shell/packages/feature/workspace/src/client/releaseNotes.ts. Nothing generates
// that string and nothing checked it, so 1.40.0, 1.41.0 and 1.42.0 shipped with
// no entry at all — the popup fires on the upgrade launch and finds nothing in the
// range, which looks exactly like "nothing changed". This script makes a missing
// entry a failed release instead of a silent one.
//
// WHAT IT REQUIRES, for the version being released:
//   1. the FIRST `## ` heading in the template string is that exact version,
//   2. its date is a real calendar date written YYYY-MM-DD,
//   3. the block has a non-empty `### en` body AND a non-empty `### ko` body.
// Headings are matched with the same patterns as `parseReleaseNotes`
// (releaseNotesOps.ts `HEADING` / `LANG_HEADING`), so what passes here is what the
// popup will actually show.
//
// WHICH VERSION. Root package.json `version` is always read. A version may also
// come from argv, and on a tag build from GITHUB_REF_NAME (`vX.Y.Z`). Every source
// that is present must agree — a tag that does not match package.json is itself a
// broken release (electron-builder publishes under package.json's version), so a
// mismatch fails here too. GITHUB_REF_NAME is ignored when it is not a version tag
// (a `workflow_dispatch` dry run from `main` sets it to `main`).
//
// WHY THE TEMPLATE IS READ AS TEXT, not imported. The file is TypeScript inside a
// submodule; importing it would need a TS loader in a script that is meant to run
// on a bare runner before `npm ci`. Instead the template literal is located and
// scanned for its closing (unescaped) backtick, then its escapes are undone. A
// `${...}` interpolation is refused: the popup would render its value, not its
// source, and this script cannot know that value.
//
// USAGE
//   node scripts/check-release-notes.mjs [version]
//   --notes <file>     release notes source (default: the shell's releaseNotes.ts)
//   --package <file>   package.json to read the version from (default: root)
// Exit 0 with one OK line, or exit 1 with what to add and where.
//
// Plain Node, no dependencies. Code, comments and output are English (project rule).

import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_NOTES = join(
  ROOT,
  'shell/packages/feature/workspace/src/client/releaseNotes.ts',
);
const DEFAULT_PACKAGE = join(ROOT, 'package.json');
const EXPORT_MARKER = /export\s+const\s+RELEASE_NOTES_MARKDOWN\s*(?::\s*string\s*)?=\s*`/;

// Same shapes as releaseNotesOps.ts — kept in step deliberately.
const HEADING = /^##\s+(\S+)\s*(?:[—–-]\s*)?(.*)$/;
const LANG_HEADING = /^###\s+([A-Za-z-]+)\s*$/;
const REQUIRED_LANGS = ['en', 'ko'];

class CheckError extends Error {}

function parseArgs(argv) {
  const out = { version: null, notes: DEFAULT_NOTES, pkg: DEFAULT_PACKAGE };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--notes' || arg === '--package') {
      const value = argv[i + 1];
      if (!value) throw new CheckError(`${arg} needs a file path`);
      if (arg === '--notes') out.notes = value;
      else out.pkg = value;
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new CheckError(`unknown option ${arg}`);
    } else if (out.version === null) {
      out.version = arg;
    } else {
      throw new CheckError(`unexpected extra argument "${arg}"`);
    }
  }
  return out;
}

const stripV = (v) => v.trim().replace(/^v/i, '');

/** Decide the one version to check, failing when the sources disagree. */
function resolveVersion(argVersion, pkgPath, env) {
  let pkgVersion;
  try {
    pkgVersion = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
  } catch (err) {
    throw new CheckError(`cannot read the version from ${pkgPath}: ${err.message}`);
  }
  if (typeof pkgVersion !== 'string' || !pkgVersion.trim()) {
    throw new CheckError(`${pkgPath} has no "version" field`);
  }

  const sources = [{ name: shown(pkgPath), version: stripV(pkgVersion) }];
  if (argVersion) sources.push({ name: 'the command-line argument', version: stripV(argVersion) });

  const refName = env.GITHUB_REF_NAME;
  const refType = env.GITHUB_REF_TYPE;
  if (refName && refType !== 'branch' && /^v\d/i.test(refName)) {
    sources.push({ name: `the git tag GITHUB_REF_NAME=${refName}`, version: stripV(refName) });
  }

  const first = sources[0];
  const mismatch = sources.find((s) => s.version !== first.version);
  if (mismatch) {
    throw new CheckError(
      `version mismatch: ${sources.map((s) => `${s.name} says ${s.version}`).join(', ')}. ` +
        'The tag, package.json and any version passed in must all name the same release — ' +
        'bump package.json (and re-tag) so they agree.',
    );
  }
  return first.version;
}

/** Pull the template literal's text out of the TS source and undo its escapes. */
function extractTemplate(source, notesPath) {
  const marker = EXPORT_MARKER.exec(source);
  if (!marker) {
    throw new CheckError(
      `${notesPath} has no \`export const RELEASE_NOTES_MARKDOWN = \\\`...\\\`\` template literal`,
    );
  }
  const start = marker.index + marker[0].length;
  let raw = null;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\\') {
      i += 1; // skip whatever is escaped, including \` and \\
      continue;
    }
    if (ch === '$' && source[i + 1] === '{') {
      const line = source.slice(0, i).split('\n').length;
      throw new CheckError(
        `${notesPath}:${line} has a \${...} interpolation inside RELEASE_NOTES_MARKDOWN. ` +
          'Release notes must be literal text; escape it as \\${ if it is meant to be shown.',
      );
    }
    if (ch === '`') {
      raw = source.slice(start, i);
      break;
    }
  }
  if (raw === null) {
    throw new CheckError(`${notesPath}: the RELEASE_NOTES_MARKDOWN template literal is never closed`);
  }
  // Template-literal escapes that matter for markdown. Anything else (\n, \u…)
  // is left as written — it cannot affect a heading or a body's emptiness.
  return raw.replace(/\\([`\\$])/g, '$1');
}

function isValidDate(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** The first `## ` block: its heading pieces and its language bodies. */
function firstBlock(markdown) {
  const lines = markdown.split(/\r?\n/);
  let block = null;
  let lang = null;
  for (const line of lines) {
    const heading = HEADING.exec(line);
    if (heading) {
      if (block) break; // the second heading ends the first block
      block = { line, version: stripV(heading[1] ?? ''), date: (heading[2] ?? '').trim(), bodies: new Map() };
      continue;
    }
    if (!block) continue;
    const langHeading = LANG_HEADING.exec(line);
    if (langHeading) {
      lang = (langHeading[1] ?? '').toLowerCase();
      if (!block.bodies.has(lang)) block.bodies.set(lang, []);
      continue;
    }
    if (lang) block.bodies.get(lang).push(line);
  }
  return block;
}

/** A path as a person would type it from the current directory. */
function shown(p) {
  const rel = relative(process.cwd(), p);
  return rel && !rel.startsWith('..') ? rel : p;
}

function check(version, notesFile) {
  const notesPath = shown(notesFile);
  let source;
  try {
    source = readFileSync(notesFile, 'utf8');
  } catch (err) {
    throw new CheckError(
      `cannot read ${notesPath}: ${err.message}. Is the shell submodule checked out ` +
        '(git submodule update --init --recursive)?',
    );
  }
  const markdown = extractTemplate(source, notesPath);
  const today = new Date().toISOString().slice(0, 10);
  const howTo =
    `Add a block at the TOP of RELEASE_NOTES_MARKDOWN in ${notesPath}:\n\n` +
    `  ## ${version} — ${today}\n\n  ### en\n\n  <what changed, for the user>\n\n` +
    '  ### ko\n\n  <the same, in Korean>\n\n' +
    'The file header there describes the entry shape (New / Improved / Fixed groups as bold lines).';

  const block = firstBlock(markdown);
  if (!block) {
    throw new CheckError(`RELEASE_NOTES_MARKDOWN has no "## <version> — <date>" heading.\n${howTo}`);
  }
  if (block.version !== version) {
    throw new CheckError(
      `release notes are missing for ${version}: the newest entry in RELEASE_NOTES_MARKDOWN is ` +
        `"${block.line.trim()}", not ${version}.\n${howTo}`,
    );
  }
  if (!isValidDate(block.date)) {
    throw new CheckError(
      `the ${version} entry's heading "${block.line.trim()}" needs a valid YYYY-MM-DD date ` +
        `after the dash, e.g. "## ${version} — ${today}" (in ${notesPath}).`,
    );
  }
  const missing = REQUIRED_LANGS.filter((tag) => {
    const lines = block.bodies.get(tag);
    return !lines || !lines.join('\n').trim();
  });
  if (missing.length > 0) {
    throw new CheckError(
      `the ${version} entry in ${notesPath} is missing a non-empty ` +
        `${missing.map((t) => `"### ${t}"`).join(' and ')} section. ` +
        'Every release needs both an English (### en) and a Korean (### ko) body.',
    );
  }
  return block;
}

function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const version = resolveVersion(args.version, args.pkg, process.env);
    const block = check(version, args.notes);
    console.log(`release notes OK: ${version} — ${block.date} has en and ko bodies (${shown(args.notes)})`);
  } catch (err) {
    if (!(err instanceof CheckError)) throw err;
    const message = `release notes check FAILED: ${err.message}`;
    // On Actions, also surface it as an annotation on the run page.
    if (process.env.GITHUB_ACTIONS === 'true') {
      console.log(`::error title=Release notes missing::${err.message.split('\n')[0]}`);
    }
    console.error(message);
    process.exit(1);
  }
}

main();
