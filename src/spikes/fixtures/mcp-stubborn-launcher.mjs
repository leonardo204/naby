// src/spikes/fixtures/mcp-stubborn-launcher.mjs
//
// A launcher shaped like `uvx`: it ignores SIGTERM and runs the real server as a
// CHILD that shares its stdio, exiting only when that child exits. This is the
// shape that leaked one `uv`+`python` pair per chat turn — a client that only
// sends SIGTERM to its direct child reaches nothing here. Used by
// spike-mcp-shutdown. Writes `<launcher pid> <server pid>` to NABY_SPIKE_PIDS.

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.on('SIGTERM', () => {});
const server = spawn(
  process.execPath,
  [fileURLToPath(new URL('./mcp-echo-server.mjs', import.meta.url))],
  { stdio: 'inherit' },
);
if (process.env.NABY_SPIKE_PIDS) {
  writeFileSync(process.env.NABY_SPIKE_PIDS, `${process.pid} ${server.pid}`);
}
server.on('exit', (code) => process.exit(code ?? 0));
