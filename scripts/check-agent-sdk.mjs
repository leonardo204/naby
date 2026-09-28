#!/usr/bin/env node
// scripts/check-agent-sdk.mjs
//
// IS THERE A NEWER CLAUDE AGENT SDK, AND WHICH MODELS DOES IT KNOW THAT OURS
// DOES NOT? (`npm run sdk:check`, and weekly in .github/workflows/agent-sdk-check.yml)
//
// WHY THIS EXISTS. naby pins `@anthropic-ai/claude-agent-sdk` exactly, in BOTH
// package.json files (root and shell/). The model list the app shows comes from
// the CLI binary bundled in the SDK's platform package (`supportedModels()`), so a
// new model — Opus 5.5 was the first case — reaches naby only when someone bumps
// that pin. Until then the app keeps offering the old list and nothing says so.
// This script is the "something says so": it compares the pins with npm latest
// and, when latest is newer, downloads the platform tarballs of BOTH versions and
// diffs the Claude model ids written into the two binaries.
//
// WHY GREP THE BINARY rather than ask the CLI. `supportedModels()` needs a
// signed-in account and spawns the CLI (see probeClaudeModels); a CI runner has
// neither, and a local run would spend a CLI start per version. The ids are plain
// strings in the binary, so a grep answers "which ids does this build know" with
// no account, no network beyond npm, and nothing billed. It is a HINT, not the
// catalog: an id can be present and still not be offered to a given plan. The
// live probe in the bump checklist is what confirms.
//
// WHAT IT DOES NOT DO: bump anything. The shell is a submodule of another repo,
// so a bump is two commits in two repos plus a pointer move — a human does it,
// following the checklist this prints.
//
// USAGE
//   node scripts/check-agent-sdk.mjs                 local: report, always exit 0
//   node scripts/check-agent-sdk.mjs --ci            CI: also write $GITHUB_STEP_SUMMARY,
//                                                    $GITHUB_OUTPUT; exit 1 only on errors
//   --pinned <version>   pretend this is the pinned version (testing the diff path)
//   --latest <version>   pretend this is npm latest (skips `npm view`)
//   --out <file>         also write the markdown report to <file>
//   --platform <p>       platform package to compare (default: this machine's,
//                        e.g. darwin-arm64, linux-x64)
//
// Code, comments and output are English (project rule); the report is Markdown so
// the same text serves the terminal, the step summary and the issue body.

import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SDK = '@anthropic-ai/claude-agent-sdk';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A Claude model id as the binary spells it: family, then a version that starts
 * with a digit (`claude-opus-5-5`, `claude-haiku-4-5-20251001`). The trailing
 * `[-0-9]*` can swallow a dash that belongs to the next token, so matches are
 * trimmed of trailing dashes before use.
 */
const MODEL_ID = /claude-(?:opus|sonnet|haiku|fable)-[0-9][-0-9]*/g;

const HELP = `Usage: node scripts/check-agent-sdk.mjs [options]

Compares the pinned ${SDK} (root and shell/package.json) with npm latest.
When latest is newer, diffs the Claude model ids in the two bundled CLI binaries.

  --ci                 write $GITHUB_STEP_SUMMARY and $GITHUB_OUTPUT; exit 1 only on errors
  --pinned <version>   treat this as the pinned version (test the diff path)
  --latest <version>   treat this as npm latest (skips \`npm view\`)
  --out <file>         also write the markdown report to <file>
  --platform <p>       platform package to compare (darwin-arm64, linux-x64, ...)

Without --ci the exit code is always 0.`;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { ci: false, pinned: undefined, latest: undefined, out: undefined, platform: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--ci') opts.ci = true;
    else if (a === '--pinned') opts.pinned = next();
    else if (a === '--latest') opts.latest = next();
    else if (a === '--out') opts.out = next();
    else if (a === '--platform') opts.platform = next();
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/** The exact pin in one package.json, or undefined when the file is absent (a CI
 *  checkout without the submodule). A RANGE is an error: the whole point of the
 *  pin is that the bundled CLI — and so the model list — changes only on purpose. */
function readPin(file) {
  if (!existsSync(file)) return undefined;
  const pkg = JSON.parse(readFileSync(file, 'utf8'));
  const spec = pkg.dependencies?.[SDK] ?? pkg.devDependencies?.[SDK];
  if (spec === undefined) return undefined;
  if (!/^\d+\.\d+\.\d+$/.test(spec)) {
    throw new Error(`${file}: ${SDK} is "${spec}", expected an exact version`);
  }
  return spec;
}

/** Numeric semver compare on MAJOR.MINOR.PATCH (the SDK publishes no prereleases
 *  on `latest`). */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function npm(args, opts = {}) {
  // `shell: true` only on Windows, where npm is a .cmd shim that execFile cannot
  // start directly.
  return execFileSync('npm', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    ...opts,
  });
}

function npmLatest() {
  return JSON.parse(npm(['view', SDK, 'version', '--json'])).toString().trim();
}

// ---------------------------------------------------------------------------
// Platform package + binary
// ---------------------------------------------------------------------------

/** The platform package name this machine (or `--platform`) uses. The SDK ships
 *  one per OS/arch; the model ids are the same in all of them, so any one will
 *  do — the local one is just the one most likely to be cached. */
function platformPackage(override) {
  if (override) return `${SDK}-${override}`;
  const os = process.platform;
  const arch = process.arch;
  const known = new Set(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64', 'win32-x64']);
  const key = `${os}-${arch}`;
  if (!known.has(key)) throw new Error(`no ${SDK} platform package for ${key}; pass --platform`);
  return `${SDK}-${key}`;
}

/** Recursively list files under `dir`. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push({ path: p, size: st.size });
  }
  return out;
}

/**
 * Download and unpack `<pkg>@<version>`, returning the path of the CLI binary.
 *
 * The binary's path inside the tarball is FOUND, not assumed: `claude` /
 * `claude.exe` if present, otherwise the largest file in the package (the binary
 * is hundreds of MB; everything else is a few KB of metadata).
 */
function fetchBinary(pkg, version, workDir) {
  const dest = mkdtempSync(join(workDir, `${version}-`));
  const packed = JSON.parse(npm(['pack', `${pkg}@${version}`, '--json', '--pack-destination', dest]));
  const filename = packed?.[0]?.filename;
  if (!filename) throw new Error(`npm pack ${pkg}@${version} returned no file`);
  // `npm pack --json` reports scoped names with the scope flattened
  // (`anthropic-ai-claude-agent-sdk-…tgz`); join with dest either way.
  const tarball = join(dest, filename.replace(/^@/, '').replace(/\//g, '-'));
  if (!existsSync(tarball)) throw new Error(`packed tarball not found: ${tarball}`);
  execFileSync('tar', ['xzf', tarball, '-C', dest]);
  rmSync(tarball, { force: true });
  const files = walk(join(dest, 'package'));
  const named = files.find((f) => /(^|[\\/])claude(\.exe)?$/.test(f.path));
  const binary = named ?? files.sort((a, b) => b.size - a.size)[0];
  if (!binary) throw new Error(`${pkg}@${version}: no files in the tarball`);
  return binary.path;
}

/**
 * Every Claude model id written into a binary, sorted and de-duplicated.
 *
 * STREAMED, with a small overlap between chunks so an id that straddles a chunk
 * boundary is still seen whole — the binary is ~225 MB and does not need to be
 * one string in memory.
 */
async function modelIdsIn(file) {
  const ids = new Set();
  const OVERLAP = 128;
  let carry = '';
  for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) {
    const text = carry + chunk.toString('latin1');
    for (const m of text.matchAll(MODEL_ID)) {
      // A match that ends exactly at the chunk end may be truncated; the overlap
      // re-reads it in full on the next pass, so skip it here.
      if (m.index + m[0].length === text.length) continue;
      ids.add(m[0].replace(/-+$/, ''));
    }
    carry = text.slice(-OVERLAP);
  }
  for (const m of carry.matchAll(MODEL_ID)) ids.add(m[0].replace(/-+$/, ''));
  return [...ids].sort();
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const CHECKLIST = [
  '- [ ] Bump `@anthropic-ai/claude-agent-sdk` to the new exact version in `package.json` AND `shell/package.json`',
  '- [ ] `npm install` in the root and in `shell/` (both lockfiles move)',
  '- [ ] `npm run build:runtime`, then `npm run typecheck`',
  '- [ ] `npm run spike:autonomy` and `npm run spike:02` (temp `NABY_DB_PATH`)',
  '- [ ] `npm run spike:model-router` (temp `NABY_DB_PATH`)',
  '- [ ] `cd shell && npm test`',
  '- [ ] Live probe with the bundled CLI (`supportedModels()`; strip cmux shims from `PATH` first) — confirm which value each alias resolves to',
  '- [ ] For each NEW model id: window (`ONE_M_DEFAULT_CLAUDE_MODELS` in `src/runtime/context-window.ts` if 1M by default), price (`src/runtime/pricing.ts` and `shell/.../TokenStatsModal.tsx`), and whether `pickCatalogValue` still picks the right opus/fable row',
  '- [ ] Re-extract the env-var names from the new binary and reconcile `src/runtime/engine-env.ts`',
  '- [ ] Commit the shell repo, then the root repo (moves the submodule pointer)',
];

function list(ids) {
  return ids.length === 0 ? '_none_' : ids.map((id) => `\`${id}\``).join(', ');
}

function renderReport(r) {
  const lines = [];
  lines.push(`## Claude Agent SDK check`);
  lines.push('');
  lines.push(`| | version |`);
  lines.push(`|---|---|`);
  lines.push(`| pinned (root \`package.json\`) | \`${r.rootPin ?? 'missing'}\` |`);
  lines.push(`| pinned (\`shell/package.json\`) | \`${r.shellPin ?? 'not checked out'}\` |`);
  lines.push(`| npm latest | \`${r.latest}\` |`);
  lines.push('');
  if (r.pinMismatch) {
    lines.push(`> **The two pins disagree.** Root and shell must bundle the same CLI; align them in the next bump.`);
    lines.push('');
  }
  if (!r.newer) {
    lines.push(`**Up to date** — the pinned SDK \`${r.pinned}\` is npm latest.`);
    return lines.join('\n') + '\n';
  }
  lines.push(`**Agent SDK \`${r.latest}\` is available** (pinned: \`${r.pinned}\`).`);
  lines.push('');
  lines.push(`Model ids in the bundled CLI binary (\`${r.platformPkg}\`):`);
  lines.push('');
  lines.push(`- **New in ${r.latest}:** ${list(r.added)}`);
  lines.push(`- Gone since ${r.pinned}: ${list(r.removed)}`);
  lines.push(`- Known to both: ${r.common.length} ids`);
  lines.push('');
  lines.push(
    `_Ids are grepped from the binary: a hint of what the build knows, not what a given plan is offered. The live probe confirms._`,
  );
  lines.push('');
  lines.push(`### Bump checklist`);
  lines.push('');
  lines.push(...CHECKLIST);
  return lines.join('\n') + '\n';
}

/** `key=value` lines for `$GITHUB_OUTPUT`. Values are single-line by construction. */
function writeGithubOutput(outputs) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  appendFileSync(file, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(opts) {
  const rootPin = readPin(join(ROOT, 'package.json'));
  const shellPin = readPin(join(ROOT, 'shell', 'package.json'));
  if (!rootPin && !opts.pinned) throw new Error(`root package.json does not depend on ${SDK}`);
  const pinned = opts.pinned ?? rootPin;
  const latest = opts.latest ?? npmLatest();
  const pinMismatch = rootPin !== undefined && shellPin !== undefined && rootPin !== shellPin;

  // "Newer" is judged against the OLDER of the two pins, so a half-done bump
  // (root moved, shell did not) still reports.
  const oldestPin =
    opts.pinned ?? [rootPin, shellPin].filter(Boolean).sort(compareVersions)[0];
  const newer = compareVersions(latest, oldestPin) > 0;

  const report = { rootPin, shellPin, latest, pinned: oldestPin, pinMismatch, newer };
  if (newer) {
    const platformPkg = platformPackage(opts.platform);
    const work = mkdtempSync(join(tmpdir(), 'naby-sdk-check-'));
    try {
      console.error(`[sdk:check] downloading ${platformPkg}@${oldestPin} and @${latest} …`);
      const [oldBin, newBin] = [
        fetchBinary(platformPkg, oldestPin, work),
        fetchBinary(platformPkg, latest, work),
      ];
      const [oldIds, newIds] = await Promise.all([modelIdsIn(oldBin), modelIdsIn(newBin)]);
      const oldSet = new Set(oldIds);
      const newSet = new Set(newIds);
      Object.assign(report, {
        platformPkg,
        added: newIds.filter((id) => !oldSet.has(id)),
        removed: oldIds.filter((id) => !newSet.has(id)),
        common: newIds.filter((id) => oldSet.has(id)),
      });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  return report;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`[sdk:check] ${err.message}`);
    process.exitCode = 1;
    return;
  }
  if (opts.help) {
    console.log(HELP);
    return;
  }
  try {
    const report = await run(opts);
    const md = renderReport(report);
    process.stdout.write(md);
    if (opts.out) writeFileSync(opts.out, md);
    if (opts.ci) {
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
      writeGithubOutput({
        newer: String(report.newer),
        latest: report.latest,
        pinned: report.pinned,
        new_models: (report.added ?? []).join(','),
      });
    }
  } catch (err) {
    console.error(`[sdk:check] failed: ${err.stack ?? err}`);
    // Local runs are informational and never fail a chain of commands; CI fails
    // the job so a broken check is noticed rather than silently green.
    process.exitCode = opts.ci ? 1 : 0;
  }
}

await main();
