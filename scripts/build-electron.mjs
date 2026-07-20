// scripts/build-electron.mjs
//
// Compile `electron/*.ts` → `dist/electron/*`.
//
// WHY A BUILD STEP AT ALL, given the project runs its spikes through tsx:
// Electron's main process cannot be driven by tsx. It boots a fixed entry file
// with its own Node build and there is no loader hook we can inject ahead of it,
// so the main process has to be real JavaScript on disk. Compiling (rather than
// authoring .mjs by hand) is what keeps this code inside `npm run typecheck`.
//
// TWO OUTPUTS, TWO FORMATS, AND THAT IS DELIBERATE:
//
//   * main.mjs / spike-entry.mjs — ESM. Electron ≥28 supports ESM in the main
//     process, and the rest of this repo is ESM ("type": "module"), so an
//     .mjs main is the consistent choice.
//   * preload.cjs — CommonJS, NON-NEGOTIABLE. A SANDBOXED preload cannot be an
//     ES module; Electron loads it through a CommonJS shim inside the sandbox.
//     Emitting ESM here would fail at runtime with a syntax error and the only
//     symptom would be a renderer with no `window.naby`. `sandbox: true` is a
//     design §1 requirement, so the preload bends, not the sandbox.
//
// WHAT IS KEPT EXTERNAL:
//   * `electron` — provided by the runtime, obviously not bundleable.
//   * `next` — deliberately NOT bundled. It is resolved at run time out of the
//     SHELL's node_modules (see next-server.ts); inlining it here would pull a
//     second copy of Next into the parent tree and defeat the point.
//   * `dist/naby-runtime.mjs` — loaded through a computed dynamic import, which
//     esbuild leaves alone by construction. Bundling it would inline ai@7 and
//     the five provider adapters into the main process a second time.

import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = resolve(root, 'dist/electron');
mkdirSync(outdir, { recursive: true });

/**
 * ESM-ONLY BANNER — makes `require` exist in the .mjs outputs.
 *
 * THIS IS NOT BOILERPLATE. It fixes a real, silent-until-runtime break found by
 * `npm run verify:updater`: bundling a CommonJS dependency (electron-updater)
 * into an ESM output leaves esbuild's `__require` shim in the code, and that
 * shim throws `Dynamic require of "fs" is not supported` the moment it is hit.
 * Nothing catches it at build time — esbuild emits no warning, typecheck is
 * clean, and the failure only appears when the updater is first used, which for
 * auto-update means "in production, days later".
 *
 * The shim's own first branch is `typeof require !== "undefined" ? require : …`,
 * so defining a real `require` at module scope is exactly what it is looking
 * for, and every dynamic require then resolves normally.
 *
 * WHY THIS IS SAFE HERE SPECIFICALLY, and would not be everywhere: the complete
 * set of dynamic requires in the bundle is node builtins (path, fs, url, stream,
 * crypto, os, child_process, util, zlib, tty, events, assert, http, constants)
 * plus `electron`. All of them resolve from Electron's own runtime with no
 * node_modules lookup, which matters because the packaged app ships none
 * (see electron-builder.yml `files`). Verify with:
 *
 *     grep -o '__require("[^"]*")' dist/electron/main.mjs | sort -u
 *
 * If that ever lists a third-party package, this banner is NOT sufficient for it
 * — that package must be shipped or bundled properly instead.
 */
const esmBanner = {
  js: [
    "import { createRequire as __nabyCreateRequire } from 'node:module';",
    'const require = __nabyCreateRequire(import.meta.url);',
  ].join('\n'),
};

/** Node 22 is Electron 43's floor; nothing here needs to go lower. */
const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  external: ['electron', 'next'],
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
};

/** Shared config for the four ESM main-process entries. */
const esm = { ...shared, format: 'esm', banner: esmBanner };

await Promise.all([
  build({
    ...esm,
    entryPoints: [resolve(root, 'electron/main.ts')],
    outfile: resolve(outdir, 'main.mjs'),
  }),
  build({
    ...esm,
    entryPoints: [resolve(root, 'electron/spike-entry.ts')],
    outfile: resolve(outdir, 'spike-entry.mjs'),
  }),
  build({
    ...esm,
    entryPoints: [resolve(root, 'electron/spike-f104-entry.ts')],
    outfile: resolve(outdir, 'spike-f104-entry.mjs'),
  }),
  // SPIKE-F110 — the UI assertions (tab close → home, title, login status).
  // Its own entry for the same reason as the others: the production main.ts
  // must not carry a test mode that could be switched on.
  build({
    ...esm,
    entryPoints: [resolve(root, 'electron/spike-f110-entry.ts')],
    outfile: resolve(outdir, 'spike-f110-entry.mjs'),
  }),
  // F1-09 verification harness. Its own entry rather than a flag on main.mjs:
  // the production entry must not carry a test mode that could be switched on.
  build({
    ...esm,
    entryPoints: [resolve(root, 'electron/updater-probe.ts')],
    outfile: resolve(outdir, 'updater-probe.mjs'),
  }),
  build({
    ...shared,
    entryPoints: [resolve(root, 'electron/preload.ts')],
    outfile: resolve(outdir, 'preload.cjs'),
    format: 'cjs',
  }),
]);

console.log(
  'electron: dist/electron/{main.mjs, spike-entry.mjs, spike-f104-entry.mjs, spike-f110-entry.mjs, updater-probe.mjs, preload.cjs}',
);
