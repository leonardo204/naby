// src/spikes/spike-mcp-shutdown.ts
//
// Closing a turn's MCP connections must END the server processes — including a
// server that a launcher started as its own child (`uvx` → `uv` → `python`).
//
// Field case 2026-10-02: Activity Monitor showed a dozen `python3.12` processes
// (mcp-atlassian, launched with `uvx`) left over from finished turns. The
// `@ai-sdk/mcp` stdio transport's close() only sends SIGTERM to its direct child
// and leaves stdin open; `uv` survives SIGTERM, and the server never sees EOF
// while the app holds the pipe. `runtime/mcp.ts` now closes stdin first, then
// escalates (MCP spec, stdio shutdown).
//
// Deterministic: a fixture launcher that ignores SIGTERM stands in for `uv`.
// Check (b) runs the library's own transport to prove the fixture reproduces the
// leak — a check that cannot fail is not a check.

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport as StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { loadMcpToolset, MCP_STDIO_EXIT_GRACE_MS } from '../runtime/mcp.js';

const LAUNCHER = fileURLToPath(new URL('./fixtures/mcp-stubborn-launcher.mjs', import.meta.url));
const checks: { name: string; pass: boolean; evidence: string }[] = [];
const record = (name: string, pass: boolean, evidence: string): void => {
  checks.push({ name, pass, evidence });
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pidsFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'naby-mcp-shutdown-')), 'pids');
}
function readPids(file: string): number[] {
  return readFileSync(file, 'utf8').trim().split(' ').map(Number);
}

async function main(): Promise<boolean> {
  // (a) naby's path: the turn's closeAll ends launcher AND server.
  const fileA = pidsFile();
  const load = await loadMcpToolset([
    {
      name: 'stubborn',
      transport: 'stdio',
      command: process.execPath,
      args: [LAUNCHER],
      env: { NABY_SPIKE_PIDS: fileA },
    },
  ]);
  const pidsA = readPids(fileA);
  const connected = load.toolSchemas.length > 0 && load.failures.length === 0;
  await load.closeAll();
  await sleep(300);
  record(
    '(a) closeAll ends the launcher AND the server it started',
    connected && pidsA.every((p) => !alive(p)),
    `tools=${load.toolSchemas.length} failures=${JSON.stringify(load.failures)} ` +
      `launcher ${pidsA[0]} alive=${alive(pidsA[0]!)}, server ${pidsA[1]} alive=${alive(pidsA[1]!)}`,
  );

  // (b) the library's own close() leaves both running — the fixture reproduces
  // the field leak.
  const fileB = pidsFile();
  const client = await createMCPClient({
    transport: new StdioMCPTransport({
      command: process.execPath,
      args: [LAUNCHER],
      env: { ...(process.env as Record<string, string>), NABY_SPIKE_PIDS: fileB },
    }),
  });
  await client.listTools();
  const pidsB = readPids(fileB);
  await client.close();
  await sleep(MCP_STDIO_EXIT_GRACE_MS);
  const leaked = pidsB.every((p) => alive(p));
  for (const p of pidsB) if (alive(p)) process.kill(p, 'SIGKILL');
  record(
    '(b) control: the library transport alone leaves both processes running',
    leaked,
    `launcher ${pidsB[0]}, server ${pidsB[1]} survived close(): ${leaked}`,
  );

  console.log('=== SPIKE-MCP-SHUTDOWN ===');
  for (const c of checks) {
    console.log(`[${c.pass ? 'PASS' : 'FAIL'}] ${c.name}\n        evidence: ${c.evidence}`);
  }
  const ok = checks.every((c) => c.pass);
  console.log(`SPIKE-MCP-SHUTDOWN: ${ok ? 'ALL PASS' : 'FAILURES PRESENT'} (${checks.filter((c) => c.pass).length}/${checks.length})`);
  return ok;
}

main().then(
  (ok) => process.exit(ok ? 0 : 1),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
