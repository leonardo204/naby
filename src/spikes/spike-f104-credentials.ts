// src/spikes/spike-f104-credentials.ts
//
// SPIKE-F104 — per-provider API key storage (F1-04), proven WITHOUT A REAL KEY.
//
// What is in scope: that a key entered by a user is encrypted at rest, is never
// readable from the renderer, round-trips exactly, can be removed, that an
// insecure storage backend is reported and warned about rather than silently
// used, and that the engine's preflight fails as a VALUE rather than a crash
// when nothing is configured.
//
// What is deliberately NOT in scope: whether the key works. That needs a real
// credential and a network call to a provider, which is SPIKE-05. The bar here
// is "the app is correctly configured once a key is entered", not "we proved it
// against Anthropic". Every key below is a sentinel string.
//
// SHAPE, as SPIKE-04: the driver spawns Electron on
// `dist/electron/spike-f104-entry.mjs`, which runs the real boot path and emits
// NDJSON. The driver decides PASS/FAIL, so a probe that never ran shows up as a
// missing observation (a FAIL) rather than as a silently skipped assertion.
//
// Assertions:
//   (a) set → status reports stored:true, AND the ciphertext on disk does not
//       contain the plaintext key (the assertion that actually matters)
//   (b) `credential:status` never returns key material, and the bridge exposes
//       no read channel at all
//   (c) the vault decrypts to exactly what was stored (asserted in main)
//   (d) clear removes it; status reports stored:false
//   (e) an insecure backend (Linux basic_text) reports secure:false, refuses to
//       store silently, and the warning path is reachable — simulated, not
//       requiring a Linux box
//   (f) engine preflight returns a TYPED FAILURE when no credential exists and
//       succeeds once one is set — fake key, no provider call
//   (g) no key material appears anywhere in the app's log output

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, rmSync } from 'node:fs';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = resolve(ROOT, 'dist/electron/spike-f104-entry.mjs');
const MARK = '##SPIKEF104##';

const RUN_TIMEOUT_MS = 180_000;

// Must match electron/spike-f104-entry.ts exactly. Duplicated rather than
// imported because the entry is a compiled .mjs the driver must not load — and
// because a shared constant that drifted would make (a) pass vacuously.
const SENTINEL = 'sk-naby-spike-SENTINEL-b3d9f7a1c5e2-DO-NOT-LOG';
const SENTINEL_TWO = 'sk-naby-spike-SENTINEL-SECOND-9e14ab77-DO-NOT-LOG';

type Check = { name: string; pass: boolean; evidence: string };
type Obs = { event: string; [k: string]: unknown };

type ChildOutcome = {
  observations: Obs[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
};

async function runElectron(): Promise<ChildOutcome> {
  const electronBinary = require('electron') as string;

  const child = spawn(electronBinary, [ENTRY], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      // Assertion (f) resolves "no credential configured" by emptying the env
      // fallback inside the child. Clearing anything inherited here as well
      // means a developer with a real key exported cannot make it pass by
      // accident — and guarantees no real key is anywhere near this run.
      NABY_ANTHROPIC_API_KEY: '',
      NABY_OPENAI_API_KEY: '',
      NABY_GOOGLE_API_KEY: '',
      NABY_AZURE_OPENAI_API_KEY: '',
      NABY_BEDROCK_API_KEY: '',
      NABY_PROVIDER: '',
    },
  });

  const observations: Obs[] = [];
  let stdoutBuf = '';
  let stdout = '';
  let stderr = '';
  let timedOut = false;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    stdoutBuf += chunk;
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop() ?? '';
    for (const line of lines) {
      const at = line.indexOf(MARK);
      if (at === -1) continue;
      try {
        observations.push(JSON.parse(line.slice(at + MARK.length)) as Obs);
      } catch {
        /* a partial or malformed line is simply not an observation */
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolvePromise) => {
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, RUN_TIMEOUT_MS);
      // 'close', not 'exit' — see the note in spike-04-electron.ts. 'exit' can
      // fire while the stdio pipes still hold the final observation, and that
      // race is load-dependent, i.e. it shows up only inside spike:nokeys.
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolvePromise({ code, signal });
      });
    },
  );

  return { observations, exitCode: result.code, signal: result.signal, timedOut, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function findOne(obs: Obs[], event: string): Obs | undefined {
  return obs.find((o) => o.event === event);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** `Result<T>` unwrap that never throws — a malformed envelope is a FAIL. */
function resultValue(value: unknown): Record<string, unknown> | null {
  const r = asRecord(value);
  return r.ok === true ? asRecord(r.value) : null;
}

/** Deep search for a sentinel anywhere in a structured-clone-shaped value. */
function containsSentinel(value: unknown): boolean {
  const json = JSON.stringify(value ?? null);
  return json.includes(SENTINEL) || json.includes(SENTINEL_TWO);
}

function evaluate(outcome: ChildOutcome): Check[] {
  const { observations: obs } = outcome;
  const checks: Check[] = [];

  const vault = findOne(obs, 'vault');
  const ipc = findOne(obs, 'ipc');
  const disk = findOne(obs, 'disk');
  const roundtrip = findOne(obs, 'roundtrip');
  const preflight = findOne(obs, 'preflight');
  const insecure = findOne(obs, 'insecure');
  const cleared = findOne(obs, 'cleared');
  const shutdown = findOne(obs, 'shutdown');
  const fatal = findOne(obs, 'fatal');

  // -- (a) stored, and the ciphertext does not contain the plaintext -------
  const statusAfter = resultValue(ipc?.statusAfter);
  const setResult = resultValue(ipc?.setResult);
  // The DRIVER decodes and greps. The child reported the raw bytes; it does not
  // get to self-certify that its own file is clean.
  const vaultFileB64 = typeof disk?.vaultFileB64 === 'string' ? disk.vaultFileB64 : '';
  const vaultText = Buffer.from(vaultFileB64, 'base64').toString('utf8');
  const vaultBytes = Buffer.from(vaultFileB64, 'base64');
  const plaintextOnDisk =
    vaultText.includes(SENTINEL) ||
    vaultText.includes(SENTINEL_TWO) ||
    // Also check the raw bytes, in case a future format is not UTF-8 text.
    vaultBytes.includes(Buffer.from(SENTINEL, 'utf8')) ||
    vaultBytes.includes(Buffer.from(SENTINEL_TWO, 'utf8'));
  const profilesText = Buffer.from(
    typeof disk?.profilesFileB64 === 'string' ? disk.profilesFileB64 : '',
    'base64',
  ).toString('utf8');

  checks.push({
    name: '(a) credential:set → status stored:true, and the file on disk does NOT contain the plaintext key',
    pass:
      setResult !== null &&
      statusAfter?.stored === true &&
      vaultBytes.length > 0 &&
      !plaintextOnDisk &&
      !profilesText.includes(SENTINEL) &&
      !profilesText.includes(SENTINEL_TWO),
    evidence:
      ipc && disk
        ? `stored=${String(statusAfter?.stored)} backend=${String(statusAfter?.backend)} ` +
          `secure=${String(statusAfter?.secure)} vaultFile=${String(disk.vaultFileBytes)}B ` +
          `plaintextInVault=${String(plaintextOnDisk)} ` +
          `plaintextInProfiles=${String(profilesText.includes(SENTINEL) || profilesText.includes(SENTINEL_TWO))}`
        : 'missing `ipc` or `disk` observation',
  });

  // -- (b) status never returns key material; no read channel exists -------
  const statusBefore = resultValue(ipc?.statusBefore);
  const credentialKeys = Array.isArray(ipc?.credentialKeys) ? (ipc.credentialKeys as string[]) : [];
  const statusKeys = statusAfter ? Object.keys(statusAfter).sort().join(',') : '';
  checks.push({
    name: '(b) credential:status returns only {stored,backend,secure} — no key material, and the bridge has no read channel',
    pass:
      ipc?.bridgePresent === true &&
      ipc.hasGetChannel === false &&
      credentialKeys.length === 3 &&
      statusKeys === 'backend,secure,stored' &&
      !containsSentinel(ipc.statusAfter) &&
      !containsSentinel(ipc.statusBefore) &&
      !containsSentinel(ipc.setResult) &&
      !containsSentinel(ipc.describe) &&
      !containsSentinel(ipc.list),
    evidence: ipc
      ? `bridge.credentials=[${credentialKeys.join(',')}] readChannel=${String(ipc.hasGetChannel)} ` +
        `statusShape={${statusKeys}} storedBefore=${String(statusBefore?.stored)} ` +
        `sentinelInAnyIpcResponse=${String(containsSentinel(ipc))}`
      : 'no `ipc` observation',
  });

  // -- (c) round trip, asserted in main -----------------------------------
  checks.push({
    name: '(c) the vault decrypts to exactly what was stored (both providers, keyed independently)',
    pass:
      roundtrip?.matches === true &&
      roundtrip.secondMatches === true &&
      roundtrip.length === SENTINEL.length &&
      roundtrip.missingProvider === null,
    evidence: roundtrip
      ? `matches=${String(roundtrip.matches)} secondMatches=${String(roundtrip.secondMatches)} ` +
        `length=${String(roundtrip.length)}/${SENTINEL.length} ` +
        `unknownProvider=${JSON.stringify(roundtrip.missingProvider)}`
      : 'no `roundtrip` observation',
  });

  // -- (d) clear ----------------------------------------------------------
  const afterClear = resultValue(cleared?.statusAfterClear);
  const secondAfterClear = resultValue(cleared?.statusSecondAfterClear);
  const stillStored = Array.isArray(cleared?.vaultStillHasEntries)
    ? (cleared.vaultStillHasEntries as string[])
    : ['<missing>'];
  checks.push({
    name: '(d) credential:clear removes the key; status reports stored:false and the vault file is gone',
    pass:
      afterClear?.stored === false &&
      secondAfterClear?.stored === false &&
      stillStored.length === 0 &&
      cleared?.vaultFileGone === true,
    evidence: cleared
      ? `stored=${String(afterClear?.stored)} secondStored=${String(secondAfterClear?.stored)} ` +
        `remainingEntries=[${stillStored.join(',')}] fileRemoved=${String(cleared.vaultFileGone)}`
      : 'no `cleared` observation',
  });

  // -- (e) insecure backend ------------------------------------------------
  checks.push({
    name: '(e) basic_text backend → secure:false, a silent store is REFUSED with CREDENTIAL_INSECURE, and the warning path is reachable',
    pass:
      insecure?.backend === 'basic_text' &&
      insecure.secure === false &&
      insecure.statusSecure === false &&
      insecure.warningPresent === true &&
      insecure.refusedCode === 'CREDENTIAL_INSECURE' &&
      insecure.refusedMentionsRisk === true &&
      // The user can still proceed once told — a warning with no way forward
      // would be a dead end, not a control.
      insecure.acknowledgedStored === true &&
      insecure.acknowledgedSecure === false,
    evidence: insecure
      ? `backend=${String(insecure.backend)} secure=${String(insecure.secure)} ` +
        `statusSecure=${String(insecure.statusSecure)} refusedCode=${String(insecure.refusedCode)} ` +
        `warningChars=${String(insecure.warningLength)} ` +
        `afterAcknowledge: stored=${String(insecure.acknowledgedStored)} secure=${String(insecure.acknowledgedSecure)}`
      : 'no `insecure` observation',
  });

  // -- (f) preflight -------------------------------------------------------
  const message = typeof preflight?.withoutMessage === 'string' ? preflight.withoutMessage : '';
  checks.push({
    name: '(f) engine preflight: typed failure with no credential, success with a (fake) key — no provider call',
    pass:
      preflight?.withKeyOk === true &&
      preflight.withoutOk === false &&
      preflight.typedFailure === true &&
      preflight.withoutCode === 'CREDENTIAL_UNAVAILABLE' &&
      preflight.withoutStatus === 400 &&
      // The message is what a non-developer reads. It has to name the thing to
      // click, not just an env var, or it is not actionable for them.
      /settings/i.test(message) &&
      message.length > 80,
    evidence: preflight
      ? `withKey=${String(preflight.withKeyOk)} withoutKey=${String(preflight.withoutOk)} ` +
        `code=${String(preflight.withoutCode)} status=${String(preflight.withoutStatus)} ` +
        `messageChars=${message.length} mentionsSettings=${String(/settings/i.test(message))}`
      : 'no `preflight` observation',
  });

  // -- (g) no key material in any output -----------------------------------
  // The whole child stream, observations included. This is the assertion that
  // catches a well-meaning `console.log(payload)` added later.
  const inStdout = outcome.stdout.includes(SENTINEL) || outcome.stdout.includes(SENTINEL_TWO);
  const inStderr = outcome.stderr.includes(SENTINEL) || outcome.stderr.includes(SENTINEL_TWO);
  const inObservations = obs.some((o) => containsSentinel(o));
  checks.push({
    name: '(g) no key material appears in stdout, stderr, or any IPC response during the whole run',
    pass: !inStdout && !inStderr && !inObservations,
    evidence:
      `stdout=${outcome.stdout.length}B (sentinel=${String(inStdout)}) ` +
      `stderr=${outcome.stderr.length}B (sentinel=${String(inStderr)}) ` +
      `observations=${obs.length} (sentinel=${String(inObservations)})`,
  });

  // -- housekeeping: the vault lives where contract §6 says, and we exited --
  // The temp dir is removed by the driver AFTER the child is gone (see main),
  // because Chromium writes into userData until process exit; what is asserted
  // here is that the run completed and the vault file itself was removed by
  // `credential:clear`, not that a temp directory tidied itself up.
  checks.push({
    name: '(h) vault file lives under userData, is separate from providers.json, and the run exits cleanly',
    pass:
      vault?.underUserData === true &&
      typeof vault.filePath === 'string' &&
      vault.filePath !== vault.profilesPath &&
      shutdown?.vaultFileGone === true &&
      !outcome.timedOut &&
      outcome.exitCode === 0 &&
      !fatal,
    evidence:
      (fatal ? `FATAL in main: ${String(fatal.error)} · ` : '') +
      `underUserData=${String(vault?.underUserData)} backend=${String(vault?.backend)} ` +
      `secure=${String(vault?.secure)} vaultFileGoneAtExit=${String(shutdown?.vaultFileGone)} ` +
      `exitCode=${String(outcome.exitCode)} timedOut=${String(outcome.timedOut)}`,
  });

  // -- (i) F1-06: the wizard replaces the chat on first run, and stands down -
  const wizard = findOne(obs, 'wizard');
  const wizardAfter = findOne(obs, 'wizard-after');
  checks.push({
    name: '(i) F1-06 first run shows the setup wizard (5 registry-driven providers, masked key field); a reload WITH a key stored does not',
    pass:
      wizard?.wizardVisible === true &&
      wizard.providerChoices === 5 &&
      wizard.passwordInputs === 1 &&
      wizard.keyInputMasked === true &&
      wizardAfter?.wizardVisible === false,
    evidence:
      wizard && wizardAfter
        ? `firstRun: visible=${String(wizard.wizardVisible)} providerChoices=${String(wizard.providerChoices)}/5 ` +
          `maskedKeyFields=${String(wizard.passwordInputs)} · afterKeyStored: visible=${String(wizardAfter.wizardVisible)}`
        : 'missing `wizard` or `wizard-after` observation',
  });

  return checks;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('SPIKE-F104 — per-provider API key storage (F1-04), no real keys\n');

  if (!existsSync(ENTRY)) {
    console.error(`FAIL: ${ENTRY} is missing.`);
    console.error('      Run `npm run build:electron` first (npm run spike:f104 does this for you).');
    process.exit(1);
  }

  const outcome = await runElectron();
  const checks = evaluate(outcome);

  // Authoritative cleanup of the child's temp userData, now that the process is
  // gone and nothing is writing into it. Best-effort and never a FAIL: leaving
  // a directory in /tmp is not a defect in credential storage.
  const tempUserData = outcome.observations.find((o) => o.event === 'shutdown')?.tempUserData;
  if (typeof tempUserData === 'string' && tempUserData.includes('naby-f104-')) {
    rmSync(tempUserData, { recursive: true, force: true });
  }

  for (const c of checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`);
    console.log(`      ${c.evidence}`);
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} assertions passed`);

  if (failed.length > 0) {
    const tail = outcome.stderr.trim().split('\n').slice(-40).join('\n');
    if (tail) console.error(`\n--- electron stderr (tail) ---\n${tail}`);
    process.exit(1);
  }
}

void main();
