// scripts/verify-updater.mjs
//
// Runs `dist/electron/updater-probe.mjs` inside a real Electron main process and
// reports the result. See electron/updater-probe.ts for what is actually being
// asserted and — just as important — what is NOT.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const electronBin = require('electron');

const entry = resolve(root, 'dist/electron/updater-probe.mjs');
if (!existsSync(entry)) {
  console.error('[verify:updater] build first: npm run build:electron');
  process.exit(1);
}

const child = spawn(electronBin, [entry], {
  cwd: root,
  // Electron needs a display on Linux CI; the probe opens no window, but
  // Chromium still initialises. Same trick the existing spikes use.
  env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let out = '';
child.stdout.on('data', (d) => {
  out += d;
});
child.stderr.on('data', (d) => {
  out += d;
});

child.on('exit', (code) => {
  const line = out.split('\n').find((l) => l.includes('NABY_UPDATER_PROBE_JSON'));
  if (!line) {
    console.error('[verify:updater] probe produced no verdict. Raw output:\n' + out);
    process.exit(1);
  }
  const verdict = JSON.parse(line.slice(line.indexOf('{')));

  for (const c of verdict.cases) {
    const mark = c.pass ? 'PASS' : 'FAIL';
    const detail = c.detail ? `  — ${c.detail}` : '';
    console.log(`${mark}  ${c.name}: expected ${c.expected}, got ${c.actual}${detail}`);
  }
  if (verdict.fatal) console.error(`\n[verify:updater] FATAL ${verdict.fatal}`);

  const total = verdict.cases.length;
  const passed = total - verdict.failed;
  console.log(`\n[verify:updater] ${passed}/${total} passed`);
  console.log(
    '[verify:updater] UNPROVEN here: actual download + apply, and Squirrel.Mac signature\n' +
      '                 validation of a real update. Both require a published release.',
  );
  process.exit(code === 0 && verdict.failed === 0 ? 0 : 1);
});
