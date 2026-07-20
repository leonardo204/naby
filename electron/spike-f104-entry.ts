// electron/spike-f104-entry.ts
//
// SPIKE-F104's payload — the code that runs INSIDE the Electron main process.
//
// Same shape as spike-entry.ts (SPIKE-04) and for the same reason: it exercises
// the REAL boot path, emits NDJSON observations, and decides nothing. The driver
// (`src/spikes/spike-f104-credentials.ts`) turns the observations into
// assertions, so a probe that silently fails to run is a FAIL rather than an
// assertion that quietly never executed.
//
// NO REAL KEYS, NO PROVIDER CALLS. Every key here is a recognisable SENTINEL
// string. That is deliberate and is what makes the load-bearing assertion
// possible: after storing the sentinel we hand the driver the raw bytes of the
// vault file, and the driver greps them for the sentinel. If safeStorage were
// not actually encrypting — or if a future refactor wrote the key alongside the
// ciphertext "for debugging" — the sentinel would be sitting right there and
// the assertion fails. Proving encryption by asserting `encrypt()` was called
// would prove nothing of the sort.
//
// USER DATA IS REDIRECTED to a temp directory before `app.whenReady()`, so this
// never reads, writes or deletes the developer's real credential vault.

import { app } from 'electron';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialVault, type SafeStorageLike } from './credentials.js';
import { boot, createMainWindow } from './boot.js';

const MARK = '##SPIKEF104##';

function emit(event: string, data: Record<string, unknown>): void {
  process.stdout.write(`${MARK}${JSON.stringify({ event, ...data })}\n`);
}

// The strings the driver greps for. Distinctive enough that a substring match
// cannot collide with base64 ciphertext or with Electron's own log noise.
const SENTINEL = 'sk-naby-spike-SENTINEL-b3d9f7a1c5e2-DO-NOT-LOG';
const SENTINEL_TWO = 'sk-naby-spike-SENTINEL-SECOND-9e14ab77-DO-NOT-LOG';

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

// Before ready, or `userData` is already resolved and the redirect is a no-op.
const tempUserData = mkdtempSync(join(tmpdir(), 'naby-f104-'));
app.setPath('userData', tempUserData);

// ---------------------------------------------------------------------------
// A fake safeStorage that behaves like a Linux box with no keyring.
// ---------------------------------------------------------------------------
//
// Assertion (e) has to prove the insecure path is REPORTED and REACHABLE. The
// real condition needs a Linux desktop with no GNOME Keyring / KWallet, which
// is not something a Mac CI run can produce — so the condition is simulated at
// the only seam that matters: what `safeStorage` tells the vault about itself.
// Everything downstream (the secure computation, the refusal, the warning text)
// is the production code path, unmodified.
const basicTextSafeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'basic_text',
  // What Chromium actually does in this mode is encrypt with a hardcoded
  // password. The fake is deliberately even weaker (base64) so that a test
  // which accidentally treats this path as secure fails loudly.
  encryptString: (s: string) => Buffer.from(s, 'utf8'),
  decryptString: (b: Buffer) => b.toString('utf8'),
};

async function run(): Promise<void> {
  await app.whenReady();

  // -- boot the real app ---------------------------------------------------
  // Boot logs are forwarded as observations so assertion (g) — "no key material
  // in any log output" — actually covers what the app logs, not just what this
  // spike prints.
  const bootResult = await boot({ log: (msg) => emit('log', { msg }) });
  const { vault, profiles } = bootResult;

  emit('vault', {
    filePath: vault.filePath,
    profilesPath: profiles.filePath,
    backend: vault.backend,
    secure: vault.secure,
    underUserData: vault.filePath.startsWith(bootResult.userDataDir),
  });

  // -- the window, so the RENDERER can drive the IPC -----------------------
  // Assertions (a), (b) and (d) go through `window.naby.credentials.*` rather
  // than through the vault object, because the contract being tested is the IPC
  // one. Calling the vault directly would prove the vault works and leave the
  // preload surface and the senderFrame guard untested.
  const win = createMainWindow(bootResult, { show: false });
  const loaded = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 90_000);
    win.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  await win.loadURL(bootResult.windowUrl('/'));
  const windowLoaded = await loaded;
  emit('window', { finished: windowLoaded });

  // -- (i) F1-06: the WIZARD is on screen, before any key exists -----------
  //
  // Asserted against the real DOM rather than against the onboarding state,
  // because the F1-06 claim is "the user sees a setup flow instead of a chat
  // they cannot use" — and a correct `onboarded:false` behind a component that
  // never rendered would satisfy the state check while failing the user.
  //
  // The wizard mounts after its async `onboarding.state()` round trip, so this
  // polls rather than sampling once; a fixed sleep would either be flaky or be
  // slower than it needs to be.
  const wizardBefore = (await win.webContents.executeJavaScript(
    `(async () => {
       const deadline = Date.now() + 20000;
       const seen = () => document.body.innerText.includes('Welcome to Naby');
       while (Date.now() < deadline && !seen()) {
         await new Promise((r) => setTimeout(r, 250));
       }
       const text = document.body.innerText;
       const out = {
         wizardVisible: seen(),
         // The five provider choices are rendered from describeProviders(), so
         // finding them proves the UI is driven off the registry.
         providerChoices: ['Anthropic', 'Amazon Bedrock', 'Azure OpenAI', 'Google Gemini', 'OpenAI']
           .filter((label) => text.includes(label)).length,
         passwordInputs: 0,
         keyInputMasked: false,
       };
       // Walk the flow the user walks: choose a provider, and check that the
       // key field that appears is MASKED. A text input here would put the key
       // on screen (and into any screen share) and is the kind of regression a
       // state-only assertion cannot see.
       const choose = Array.from(document.querySelectorAll('button'))
         .find((b) => b.textContent && b.textContent.includes('Anthropic'));
       if (choose) {
         choose.click();
         const deadline2 = Date.now() + 10000;
         while (Date.now() < deadline2 && document.querySelectorAll('input[type="password"]').length === 0) {
           await new Promise((r) => setTimeout(r, 250));
         }
       }
       out.passwordInputs = document.querySelectorAll('input[type="password"]').length;
       out.keyInputMasked = out.passwordInputs > 0 &&
         document.querySelectorAll('input[type="text"][name*="key" i]').length === 0;
       return out;
     })()`,
  )) as Record<string, unknown>;
  emit('wizard', wizardBefore);

  // -- (a)/(b) set then status, entirely from the renderer -----------------
  const ipc = (await win.webContents.executeJavaScript(
    `(async () => {
       const naby = window.naby;
       const out = { bridgePresent: !!(naby && naby.credentials), hasGetChannel: false };
       if (!out.bridgePresent) return out;
       // Rule 3 (preload.ts): there must be NO read path on the bridge. This
       // enumerates what was actually exposed rather than trusting the source.
       out.credentialKeys = Object.keys(naby.credentials);
       out.hasGetChannel = out.credentialKeys.some((k) => /get|read|reveal|show/i.test(k));
       out.statusBefore = await naby.credentials.status('anthropic');
       out.setResult = await naby.credentials.set('anthropic', ${JSON.stringify(SENTINEL)});
       out.statusAfter = await naby.credentials.status('anthropic');
       // A second provider, to prove the vault is keyed rather than global.
       out.setSecond = await naby.credentials.set('openai', ${JSON.stringify(SENTINEL_TWO)});
       out.describe = await naby.providers.describe();
       out.list = await naby.providers.list();
       out.onboardingAfter = await naby.onboarding.state();
       return out;
     })()`,
  )) as Record<string, unknown>;
  emit('ipc', ipc);

  // -- (i cont.) the wizard STANDS DOWN once a key exists ------------------
  // A fresh load with keys in the vault is exactly what a user's second launch
  // is, so this is the "first run vs. after a key exists" difference, observed
  // rather than described.
  const reloaded = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 60_000);
    win.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  win.webContents.reload();
  await reloaded;
  const wizardAfter = (await win.webContents.executeJavaScript(
    `(async () => {
       // Give the wizard the same chance to appear that it had the first time;
       // asserting absence immediately after load would pass even if it were
       // about to mount.
       const deadline = Date.now() + 8000;
       let seen = false;
       while (Date.now() < deadline && !seen) {
         seen = document.body.innerText.includes('Welcome to Naby');
         await new Promise((r) => setTimeout(r, 250));
       }
       return { wizardVisible: seen };
     })()`,
  )) as Record<string, unknown>;
  emit('wizard-after', wizardAfter);

  // -- (a) the bytes on disk ----------------------------------------------
  // Handed to the driver raw (base64 of the file) so the grep that matters is
  // performed by the DRIVER, not self-reported by the code under test.
  const vaultBytes = existsSync(vault.filePath) ? readFileSync(vault.filePath) : Buffer.alloc(0);
  const profileBytes = existsSync(profiles.filePath)
    ? readFileSync(profiles.filePath)
    : Buffer.alloc(0);
  emit('disk', {
    vaultFileB64: vaultBytes.toString('base64'),
    vaultFileBytes: vaultBytes.length,
    profilesFileB64: profileBytes.toString('base64'),
    profilesFileBytes: profileBytes.length,
  });

  // -- (c) round trip, asserted in MAIN ------------------------------------
  // Deliberately NOT over IPC: there is no channel that returns a key, and
  // adding one for the test would create the exact hole the test exists to
  // prevent. The vault is asked directly, in the process that owns it.
  const decrypted = await vault.get('anthropic');
  const decryptedSecond = await vault.get('openai');
  emit('roundtrip', {
    matches: decrypted === SENTINEL,
    secondMatches: decryptedSecond === SENTINEL_TWO,
    // Length only. The value never goes into an observation, because the driver
    // also greps this whole stream for the sentinel (assertion g).
    length: decrypted?.length ?? 0,
    missingProvider: await vault.get('does-not-exist'),
  });

  // -- (f) engine preflight, with a FAKE key and no provider call ----------
  // `preflightProvider` is the exact function the shell engine's preflight
  // calls. Asserting it here rather than through an HTTP request is what keeps
  // "succeeds once a key is set" from meaning "we called Anthropic".
  const runtime = (await bootResult.loadRuntime()) as unknown as {
    preflightProvider: (opts?: {
      requestedModel?: string;
      providerId?: string;
    }) => Promise<{ ok: boolean; status?: number; code?: string; error?: string }>;
    getCredentialBridge: () => unknown;
    installCredentialBridge: (b: unknown) => void;
  };

  const preflightWithKey = await runtime.preflightProvider({ providerId: 'anthropic' });

  // Now the same call with NOTHING configured. The bridge is swapped for one
  // that reports an empty vault, and the env fallback is emptied, so this is
  // genuinely the "fresh install, no key" case rather than a mocked return.
  const savedEnv: Record<string, string | undefined> = {};
  for (const name of Object.keys(process.env)) {
    if (/^NABY_.*API_KEY$/.test(name) || name === 'NABY_PROVIDER') {
      savedEnv[name] = process.env[name];
      delete process.env[name];
    }
  }
  const realBridge = runtime.getCredentialBridge();
  runtime.installCredentialBridge({
    listProfiles: () => [],
    getKey: () => null,
    security: () => ({ backend: 'test', secure: true, warning: null }),
  });
  const preflightWithout = await runtime.preflightProvider({});
  // Put the real one back: the renderer-driven assertions below run against the
  // booted app, and leaving a stub bridge installed would silently change what
  // they exercise.
  runtime.installCredentialBridge(realBridge);
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value !== undefined) process.env[name] = value;
  }

  emit('preflight', {
    withKeyOk: preflightWithKey.ok,
    withoutOk: preflightWithout.ok,
    withoutCode: preflightWithout.code ?? null,
    withoutStatus: preflightWithout.status ?? null,
    withoutMessage: preflightWithout.error ?? '',
    // A crash would have taken the whole run down; reaching here at all means
    // the failure was returned as a value, which is the actual claim.
    typedFailure: preflightWithout.ok === false && typeof preflightWithout.code === 'string',
  });

  // -- (e) the insecure backend --------------------------------------------
  // A SECOND vault over the same production class, differing only in the
  // injected safeStorage and platform. Everything asserted below — the secure
  // computation, the refusal, the warning, the acknowledged override — is
  // production code.
  const insecure = new CredentialVault({
    userDataDir: tempUserData,
    safeStorage: basicTextSafeStorage,
    platform: 'linux',
    fileName: 'credentials-insecure-test.json',
    log: () => {},
  });
  const insecureSecurity = await insecure.init();

  let refusedCode: string | null = null;
  let refusedMessage = '';
  try {
    await insecure.set('anthropic', SENTINEL);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    refusedCode = e.code ?? null;
    refusedMessage = e.message ?? '';
  }

  // …and the user may still proceed, once told. That is the "reachable" half of
  // the assertion: a warning the user cannot act on would be a dead end.
  const acknowledged = await insecure.set('anthropic', SENTINEL, { acknowledgeInsecure: true });

  emit('insecure', {
    backend: insecureSecurity.backend,
    secure: insecureSecurity.secure,
    warningPresent: typeof insecureSecurity.warning === 'string' && insecureSecurity.warning.length > 0,
    warningLength: insecureSecurity.warning?.length ?? 0,
    refusedCode,
    refusedMentionsRisk: /risk|not real protection|readable|recover/i.test(refusedMessage),
    acknowledgedStored: insecure.listStored().includes('anthropic'),
    acknowledgedSecure: acknowledged.secure,
    statusSecure: insecure.status('anthropic').secure,
    statusBackend: insecure.status('anthropic').backend,
  });
  insecure.clear('anthropic');

  // -- (d) clear, from the renderer ----------------------------------------
  const cleared = (await win.webContents.executeJavaScript(
    `(async () => {
       const naby = window.naby;
       const out = {};
       out.clearResult = await naby.credentials.clear('anthropic');
       out.statusAfterClear = await naby.credentials.status('anthropic');
       out.clearSecond = await naby.credentials.clear('openai');
       out.statusSecondAfterClear = await naby.credentials.status('openai');
       out.onboardingAfterClear = await naby.onboarding.state();
       return out;
     })()`,
  )) as Record<string, unknown>;
  emit('cleared', {
    ...cleared,
    vaultFileGone: !existsSync(vault.filePath),
    vaultStillHasEntries: vault.listStored(),
  });

  // -- teardown ------------------------------------------------------------
  //
  // THE FINAL OBSERVATION IS EMITTED AND FLUSHED **BEFORE** TEARDOWN, which is
  // the opposite of SPIKE-04 and deliberate. SPIKE-04's last assertion is ABOUT
  // teardown (it proves the store and the listener actually closed), so it has
  // to report afterwards. This spike asserts nothing about teardown — SPIKE-04
  // already owns that — so reporting first removes a whole class of false FAIL:
  // destroying the window triggers Electron's default `window-all-closed` quit,
  // which races `shutdown()`, and whichever of the two wins, this spike's
  // result is already on the wire.
  //
  // (Suppressing that default quit with a no-op handler was tried and is worse:
  // `server.close()` then never resolves, because the quit sequence is what
  // reaps the renderer's remaining sockets. That is a property of the teardown
  // path SPIKE-04 already exercises, not of anything F1-04 introduces.)
  emit('shutdown', {
    tempUserData,
    vaultFileGone: !existsSync(vault.filePath),
  });
  await new Promise<void>((resolve) => {
    // Wait on the WRITE CALLBACK, not on `write()`'s return value — see the
    // long note in spike-entry.ts. A ~90-byte line sits under the pipe's
    // highWaterMark, so `write('')` returns true and exiting here would drop
    // the observation the driver is waiting for.
    process.stdout.write('', 'utf8', () => resolve());
  });

  win.destroy();
  await bootResult.shutdown();
  // Best-effort: Chromium writes profile data into userData until process exit,
  // so the DRIVER does the authoritative cleanup once this process is gone.
  try {
    rmSync(tempUserData, { recursive: true, force: true });
  } catch {
    /* the driver cleans up after exit */
  }
  app.exit(0);
}

run().catch((err: unknown) => {
  emit('fatal', { error: err instanceof Error ? `${err.message}\n${err.stack}` : String(err) });
  try {
    rmSync(tempUserData, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  app.exit(1);
});
