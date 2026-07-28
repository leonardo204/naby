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
//   (e) A DEAD `import.meta.url` STILL RESOLVES, given NABY_APP_ROOT. This is the
//       SECOND bug, and the one v1.5.1 shipped without fixing: Next/webpack
//       constant-folds `import.meta.url` into the BUILD MACHINE's absolute path,
//       so the release that serves /api/naby carries
//       `file:///Users/runner/work/naby/naby/dist/...` — a phantom on every user
//       machine. (a)-(d) all pass with that bug present, because on the build
//       machine the frozen path is real. Only an anchor that comes from the
//       RUNTIME can catch it.
//   (f) NABY_APP_ROOT WINS over a resolvable module-relative anchor, so a
//       packaged app uses ITS OWN copy rather than whatever stale checkout the
//       frozen path happens to name on the machine it runs on.
//
// NO NETWORK, NO KEYS, NO MODEL CALL. Prints PASS/FAIL per assertion; exits
// non-zero on any FAIL. Cleans up its temp dirs.

import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
  /** `relevant` is what the Claude account chip hides itself on. */
  describeClaudeLogin(opts?: Record<string, unknown>): { relevant: boolean };
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

/**
 * The same shape, but with a STUB package carrying a marker version.
 *
 * Needed because Node reports the REALPATH of a resolved module, so two roots
 * that both symlink the one real package are indistinguishable in the result —
 * and "which root answered" is precisely what (e) and (f) assert. A stub is
 * honest here: these two checks are about resolution order, not about the SDK.
 */
function buildStubLayout(root: string, marker: string): void {
  const pkg = join(root, 'shell', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({ name: '@anthropic-ai/claude-agent-sdk', version: marker, main: 'sdk.mjs' }),
  );
  writeFileSync(join(pkg, 'sdk.mjs'), 'export const stub = true;\n');
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

    // -- (e) dead import.meta.url + NABY_APP_ROOT ---------------------------
    // `bareRuntime` is loaded from a temp dir with no shell/ and no
    // node_modules, so EVERY module-relative anchor is a dead end — which is
    // what a CI-built release looks like on a user's machine, where the frozen
    // build path names a directory that does not exist. The app root is the only
    // thing left, and it has to be enough.
    const stubRoot = mkdtempSync(join(tmpdir(), 'naby-sdk-approot-'));
    tmpRoots.push(stubRoot);
    buildStubLayout(stubRoot, '9.9.9-app-root');
    process.env.NABY_APP_ROOT = stubRoot;
    // Compare against the REAL path: on macOS mkdtemp hands back /var/... while
    // Node reports the resolved module under /private/var/....
    const stubReal = realpathSync(stubRoot);
    const viaAppRoot = bareRuntime.resolveClaudeAgentSdkPath();
    record(
      checks,
      '(e) NABY_APP_ROOT resolves it when the module-relative anchors are dead',
      viaAppRoot !== null && viaAppRoot.startsWith(stubReal),
      `path=${viaAppRoot === null ? 'null' : '…' + viaAppRoot.slice(-40)}`,
    );

    // The env var must not manufacture a hit either: pointed somewhere empty,
    // absent stays absent.
    const empty = mkdtempSync(join(tmpdir(), 'naby-sdk-empty-'));
    tmpRoots.push(empty);
    process.env.NABY_APP_ROOT = empty;
    const viaEmptyRoot = bareRuntime.resolveClaudeAgentSdkPath();
    record(
      checks,
      '(e) an app root without the SDK does not manufacture a hit',
      viaEmptyRoot === null,
      `path=${viaEmptyRoot ?? 'null'}`,
    );

    // -- (f) the app root outranks a resolvable module-relative anchor -------
    // `pkgRuntime` sits in a layout that resolves on its own. Pointed at a
    // DIFFERENT root that also has the SDK, it must follow the app root — a
    // packaged app has to use its own copy, not a checkout that happens to be
    // on the same disk.
    const other = mkdtempSync(join(tmpdir(), 'naby-sdk-other-'));
    tmpRoots.push(other);
    buildStubLayout(other, '9.9.9-other-root');
    process.env.NABY_APP_ROOT = other;
    const otherReal = realpathSync(other);
    const preferred = pkgRuntime.resolveClaudeAgentSdkPath();
    record(
      checks,
      '(f) NABY_APP_ROOT wins over the module-relative anchor',
      preferred !== null && preferred.startsWith(otherReal),
      `answered=${preferred?.startsWith(otherReal) === true ? 'app root' : 'module-relative'}`,
    );
    delete process.env.NABY_APP_ROOT;

    // -- (g) ONE definition of "can the dev engine run here" ----------------
    // The Claude account chip hides itself on `describeClaudeLogin().relevant`,
    // which had its OWN copy of the resolver. The copy was not fixed when the
    // engine's was, so v1.5.2 shipped an app whose Claude engine worked while
    // its account chip stayed invisible. Asserting the two agree — in BOTH
    // directions, so a hardcoded `true` cannot pass — is what keeps the
    // predicate single.
    const agree = (rt: RuntimeExports): boolean =>
      rt.describeClaudeLogin().relevant === rt.isClaudeAgentSdkAvailable();

    process.env.NABY_APP_ROOT = stubRoot;
    const agreeWhenPresent = agree(bareRuntime) && bareRuntime.describeClaudeLogin().relevant;
    delete process.env.NABY_APP_ROOT;
    const agreeWhenAbsent = agree(bareRuntime) && !bareRuntime.describeClaudeLogin().relevant;
    record(
      checks,
      '(g) the account chip and the engine share one availability answer',
      agreeWhenPresent && agreeWhenAbsent,
      `withAppRoot=${agreeWhenPresent} withoutAppRoot=${agreeWhenAbsent}`,
    );
  } finally {
    delete process.env.NABY_APP_ROOT;
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
