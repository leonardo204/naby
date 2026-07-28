// src/spikes/spike-sdk-resolve.ts
//
// AGENT SDK RESOLUTION verification — can the dev engine FIND the Claude Agent
// SDK in the layout it is actually shipped in?
//
// WHY THIS SPIKE EXISTS. v1.4.0/v1.5.0 shipped the SDK — package, native engine
// binary, asarUnpack'd, all of it — and the app still said "the built-in
// development model is not part of this installed app", so the Claude
// subscription option vanished from the provider list. Nothing was missing. The
// RESOLVER was wrong: electron-builder drops the root node_modules
// (`'!node_modules/**'` in electron-builder.yml), so in a packaged build the SDK
// arrives only through `shell/node_modules`, and Node resolves by walking
// ANCESTORS — `app.asar/shell/node_modules` is a sibling of `app.asar/dist`,
// never an ancestor.
//
// A source checkout cannot catch this, because there the root node_modules has
// the package and the first anchor always wins. So this spike RECONSTRUCTS THE
// PACKAGED LAYOUT in a temp dir — dist/naby-runtime.mjs beside a shell/ tree,
// with no root node_modules — and asks the real bundle to resolve itself.
//
// It proves:
//
//   (a) SOURCE CHECKOUT still resolves (the anchor that always worked).
//   (b) PACKAGED LAYOUT resolves, THROUGH shell/node_modules — the regression.
//   (c) GENUINELY ABSENT still reports absent. The fallback must not turn a
//       missing package into a bogus path; "available" has to stay honest, or
//       the UI offers an engine that cannot run.
//   (d) The resolved package is REAL — its package.json parses and names the
//       SDK — rather than merely a string that came back non-null.
//
// NO NETWORK, NO KEYS, NO MODEL CALL. Prints PASS/FAIL per assertion; exits
// non-zero on any FAIL. Cleans up its temp dirs.

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Check = { name: string; pass: boolean; evidence: string };

function record(checks: Check[], name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
}

interface RuntimeExports {
  resolveClaudeAgentSdkPath(): string | null;
  isClaudeAgentSdkAvailable(): boolean;
}

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUNDLE = join(REPO, 'dist', 'naby-runtime.mjs');

/**
 * Load a COPY of the runtime bundle placed at `<root>/dist/naby-runtime.mjs`.
 *
 * The copy is the point: resolution is anchored on `import.meta.url`, so the
 * bundle has to physically sit in the layout under test. `seq` keeps the ESM
 * loader from returning a cached module for a second copy.
 */
async function loadBundleAt(root: string, seq: number): Promise<RuntimeExports> {
  const distDir = join(root, 'dist');
  mkdirSync(distDir, { recursive: true });
  const target = join(distDir, `naby-runtime.mjs`);
  copyFileSync(BUNDLE, target);
  const url = `${pathToFileURL(target).href}?copy=${seq}`;
  return (await import(url)) as RuntimeExports;
}

/** The packaged shape: a shell/ tree carrying the SDK, and NO root node_modules. */
function buildPackagedLayout(root: string): void {
  const scope = join(root, 'shell', 'node_modules', '@anthropic-ai');
  mkdirSync(scope, { recursive: true });
  // Symlink rather than copy: the real package is ~200 MB with its engine binary.
  // Node resolves through the link and reports the real path, which is exactly
  // what the packaged app does with app.asar.unpacked.
  symlinkSync(
    join(REPO, 'shell', 'node_modules', '@anthropic-ai', 'claude-agent-sdk'),
    join(scope, 'claude-agent-sdk'),
    'dir',
  );
}

async function main(): Promise<void> {
  const checks: Check[] = [];
  const tmpRoots: string[] = [];

  try {
    // -- (a) source checkout ------------------------------------------------
    const dev = (await import(pathToFileURL(BUNDLE).href)) as RuntimeExports;
    const devPath = dev.resolveClaudeAgentSdkPath();
    record(
      checks,
      '(a) a source checkout resolves the SDK',
      devPath !== null && dev.isClaudeAgentSdkAvailable(),
      `path=${devPath === null ? 'null' : '…' + devPath.slice(-48)}`,
    );

    // -- (b) packaged layout — the regression -------------------------------
    const packaged = mkdtempSync(join(tmpdir(), 'naby-sdk-packaged-'));
    tmpRoots.push(packaged);
    buildPackagedLayout(packaged);
    const pkgRuntime = await loadBundleAt(packaged, 1);
    const pkgPath = pkgRuntime.resolveClaudeAgentSdkPath();
    record(
      checks,
      '(b) the packaged layout resolves the SDK through shell/node_modules',
      pkgPath !== null && pkgRuntime.isClaudeAgentSdkAvailable(),
      `path=${pkgPath === null ? 'null' : '…' + pkgPath.slice(-56)}`,
    );

    // -- (d) and it is a real package ---------------------------------------
    let named = false;
    let version = '?';
    if (pkgPath !== null) {
      // Walk up from the resolved entry to the package root. The entry sits some
      // levels below it, so look for the nearest package.json that names the SDK.
      let dir = dirname(pkgPath);
      for (let i = 0; i < 6; i += 1) {
        try {
          const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
            name?: string;
            version?: string;
          };
          if (pj.name === '@anthropic-ai/claude-agent-sdk') {
            named = true;
            version = pj.version ?? '?';
            break;
          }
        } catch {
          /* keep walking */
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    record(
      checks,
      '(d) the resolved path belongs to a real @anthropic-ai/claude-agent-sdk',
      named,
      `version=${version}`,
    );

    // -- (c) genuinely absent still reports absent ---------------------------
    const bare = mkdtempSync(join(tmpdir(), 'naby-sdk-bare-'));
    tmpRoots.push(bare);
    const bareRuntime = await loadBundleAt(bare, 2);
    const barePath = bareRuntime.resolveClaudeAgentSdkPath();
    record(
      checks,
      '(c) a layout without the SDK still reports it missing',
      barePath === null && bareRuntime.isClaudeAgentSdkAvailable() === false,
      `path=${barePath ?? 'null'} available=${bareRuntime.isClaudeAgentSdkAvailable()}`,
    );
  } finally {
    for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
  }

  let failed = 0;
  for (const c of checks) {
    if (!c.pass) failed += 1;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  [${c.evidence}]`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} passed`);
  if (failed > 0) process.exit(1);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
