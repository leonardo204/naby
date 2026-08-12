// scripts/gen-builtin-harness.mjs
//
// Turn the VERBATIM built-in harness artifacts (src/runtime/harness-assets/**.md)
// into a TypeScript constant the runtime bundle can carry
// (src/runtime/harness-assets/generated.ts).
//
// WHY GENERATE RATHER THAN READ THE FILE AT RUNTIME. A `.md` read at runtime needs
// a base path, and this project has already paid for that once: Next (webpack)
// freezes `import.meta.url` into a BUILD MACHINE absolute path, so a path-resolving
// read passes on this machine and fails in the packaged app
// (specs/packaging-path-resolution.md). A constant compiled into
// dist/naby-runtime.mjs has no path to resolve and no filesystem to be wrong about.
//
// WHY NOT AN ESBUILD TEXT LOADER. The spikes run the same modules through `tsx`,
// which has no loader configuration of ours; an `import md from './SKILL.md'` would
// build but not spike, and the spikes are where the harness contracts are asserted.
//
// SO THE .md FILES STAY THE ORIGINAL and this file is their compiled twin. The
// generated module is COMMITTED, and `spike:harness-seed` re-reads the `.md` files
// and compares them byte for byte with the constant — drift fails the spike rather
// than shipping a stale copy.
//
// The frontmatter is parsed HERE so the runtime needs no YAML parser: what ships is
// already `{ name, description, model?, toolRefs?, triggers? }` plus the raw document.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The artifacts, in the order they are seeded. `path` is repo-relative so the
 *  spike can re-read exactly what was compiled. */
const SOURCES = [
  { kind: 'skill', path: 'src/runtime/harness-assets/skills/confluence-context/SKILL.md' },
  { kind: 'subagent', path: 'src/runtime/harness-assets/agents/confluence-researcher.md' },
  { kind: 'skill', path: 'src/runtime/harness-assets/skills/confluence-upload/SKILL.md' },
];

/**
 * Split a Claude-format artifact into frontmatter fields and body.
 *
 * Deliberately line-based rather than a YAML dependency: these two documents use
 * exactly five scalar keys (name, description, model, tools, triggers), and a
 * generator that needed js-yaml would put a build dependency in the parent tree for
 * two files whose shape we control.
 */
function parseArtifact(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) throw new Error('artifact has no frontmatter');
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    // A quoted scalar (the subagent's description) keeps its quotes in the file
    // and loses them here, exactly as a YAML reader would.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    fields[kv[1]] = value;
  }
  return { fields, body: raw.slice(m[0].length) };
}

/** `tools: a, b, c` (and `triggers: a, b, c`) -> ['a','b','c']; absent/blank ->
 *  undefined. Items are trimmed, so a trigger cannot carry padding whitespace —
 *  which matters, because skill-inject matches triggers as raw substrings. */
function csvList(value) {
  if (!value) return undefined;
  const out = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return out.length > 0 ? out : undefined;
}

function buildAssets() {
  return SOURCES.map((src) => {
    const raw = readFileSync(resolve(root, src.path), 'utf8');
    const { fields } = parseArtifact(raw);
    const name = fields.name;
    if (!name) throw new Error(`${src.path}: frontmatter has no name`);
    return {
      kind: src.kind,
      name,
      description: fields.description ?? '',
      ...(fields.model ? { model: fields.model } : {}),
      ...(csvList(fields.tools) ? { toolRefs: csvList(fields.tools) } : {}),
      ...(csvList(fields.triggers) ? { triggers: csvList(fields.triggers) } : {}),
      sourcePath: src.path,
      raw,
    };
  });
}

const HEADER = `// src/runtime/harness-assets/generated.ts
//
// GENERATED — DO NOT EDIT. Run \`node scripts/gen-builtin-harness.mjs\` after
// changing anything under src/runtime/harness-assets/**.md.
//
// The two built-in harness artifacts, compiled into the runtime bundle so seeding
// them needs no path resolution and no filesystem (see the generator's header, and
// specs/packaging-path-resolution.md for why a runtime read would be a trap).
//
// \`raw\` is the artifact BYTE FOR BYTE, frontmatter included — spike-harness-seed
// re-reads the .md files and compares, so this file cannot silently go stale. The
// frontmatter fields are pre-parsed so the runtime carries no YAML parser.

/** One built-in harness artifact: its parsed frontmatter plus the original text. */
export type BuiltinHarnessAsset = {
  kind: 'skill' | 'subagent';
  /** The frontmatter \`name\` — the harness row's name, and its upsert identity. */
  name: string;
  description: string;
  model?: string;
  /** The frontmatter \`tools\`, AS AUTHORED (Claude's \`mcp__<server>__<tool>\` form).
   *  The shell normalizes that form when it narrows a subagent's toolset. */
  toolRefs?: readonly string[];
  /** The frontmatter \`triggers\` — the turn-text hints that make a skill relevant
   *  (skill-inject.ts: case-insensitive SUBSTRING match). Absent means ALWAYS-ON,
   *  which for a long document is a per-turn tax on the skill budget, so a heavy
   *  built-in declares its triggers. */
  triggers?: readonly string[];
  /** Repo-relative path of the artifact this was generated from. */
  sourcePath: string;
  /** The whole document, verbatim. */
  raw: string;
};

export const BUILTIN_HARNESS_ASSETS: readonly BuiltinHarnessAsset[] = `;

const assets = buildAssets();
const out = `${HEADER}${JSON.stringify(assets, null, 2)} as const;\n`;
const target = resolve(root, 'src/runtime/harness-assets/generated.ts');

if (process.argv.includes('--check')) {
  const current = readFileSync(target, 'utf8');
  if (current !== out) {
    console.error('generated.ts is STALE — run `node scripts/gen-builtin-harness.mjs`');
    process.exit(1);
  }
  console.log('generated.ts is up to date');
} else {
  writeFileSync(target, out);
  console.log(`wrote ${target} (${assets.length} artifacts)`);
}
