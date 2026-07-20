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

await Promise.all([
  build({
    ...shared,
    entryPoints: [resolve(root, 'electron/main.ts')],
    outfile: resolve(outdir, 'main.mjs'),
    format: 'esm',
  }),
  build({
    ...shared,
    entryPoints: [resolve(root, 'electron/spike-entry.ts')],
    outfile: resolve(outdir, 'spike-entry.mjs'),
    format: 'esm',
  }),
  build({
    ...shared,
    entryPoints: [resolve(root, 'electron/spike-f104-entry.ts')],
    outfile: resolve(outdir, 'spike-f104-entry.mjs'),
    format: 'esm',
  }),
  build({
    ...shared,
    entryPoints: [resolve(root, 'electron/preload.ts')],
    outfile: resolve(outdir, 'preload.cjs'),
    format: 'cjs',
  }),
]);

console.log(
  'electron: dist/electron/{main.mjs, spike-entry.mjs, spike-f104-entry.mjs, preload.cjs}',
);
