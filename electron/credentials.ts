// electron/credentials.ts
//
// F1-04 — THE CREDENTIAL VAULT. Main process only, and that is a boundary, not
// a convention: `safeStorage` exists only in main, and design §4.1 puts the key
// there on purpose. Nothing in this file is reachable from the renderer except
// through the four narrow IPC channels in `ipc.ts`, and none of those returns
// key material.
//
// WHAT IS ON DISK
// `<userData>/naby/credentials.json`, mode 0600, holding CIPHERTEXT ONLY:
//
//   { "version": 1, "entries": { "anthropic": { "ciphertext": "<base64>", … } } }
//
// The provider PROFILES (model, region, deployment) live in a different file
// entirely (`providers.ts`), because contract §4 requires the profiles file to
// hold no secret and the cheapest way to guarantee that is for the two never to
// share a writer. spike-f104 asserts the separation on both files.
//
// THE LINUX FALLBACK IS THE WHOLE DESIGN CONSTRAINT (design §4.1)
// Where no OS secret store is available — a bare tiling WM, a container, a
// broken keyring — `safeStorage` does NOT fail. It silently encrypts with a
// HARDCODED password, which is obfuscation, not encryption: the ciphertext on
// disk is recoverable by anyone who has the file and knows Chromium. Storing an
// API key that way without telling the user is the failure mode this class
// exists to prevent, so:
//
//   * `init()` runs AFTER `app.whenReady()` — `getSelectedStorageBackend()`
//     returns 'unknown' before ready, so a check made earlier is worthless.
//   * `secure` is false when encryption is unavailable OR the Linux backend is
//     'basic_text'.
//   * when `secure` is false, `set()` REFUSES unless the caller passes
//     `acknowledgeInsecure`. The UI turns that refusal into a visible warning
//     with an explicit "store it anyway" confirmation. A user may knowingly
//     accept the risk; they may not be exposed to it silently.
//
// (The refusal is a documented deviation from contract §1.3, which types
// `credential:set` as `{providerId, key}`. The extra optional flag is what
// makes "surface a real warning rather than silently storing" implementable —
// without it, `set` either has to store insecurely or become unusable on such a
// machine. The `Result<{secure}>` response shape is unchanged.)
//
// ASYNC API, per design §4.1's preference: Electron 43 does ship
// `encryptStringAsync` / `decryptStringAsync` / `isAsyncEncryptionAvailable`
// (verified in electron.d.ts against the pinned 43.1.1), so the note "which
// major shipped it could not be pinned" is now resolved for our target. The
// sync pair is kept as a fallback for an injected/older implementation, and
// `decryptStringAsync`'s `shouldReEncrypt` is honored rather than ignored.

import { safeStorage as electronSafeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CredentialSecurity } from '../dist/naby-runtime.mjs';

// ---------------------------------------------------------------------------
// The `safeStorage` surface we use — as an interface, so it can be faked.
// ---------------------------------------------------------------------------
//
// spike-f104 assertion (e) has to prove the insecure path is reported AND
// reachable. Requiring a Linux box with a broken keyring to run that assertion
// would mean it never runs, so the dependency is injectable and the spike hands
// in a fake that reports `basic_text`. The production path passes Electron's
// real `safeStorage` and is otherwise identical.

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  isAsyncEncryptionAvailable?(): Promise<boolean>;
  encryptStringAsync?(plainText: string): Promise<Buffer>;
  decryptStringAsync?(encrypted: Buffer): Promise<{ shouldReEncrypt: boolean; result: string }>;
  getSelectedStorageBackend?(): string;
}

export type CredentialErrorCode = 'CREDENTIAL_UNAVAILABLE' | 'CREDENTIAL_INSECURE' | 'INTERNAL';

export class CredentialError extends Error {
  readonly code: CredentialErrorCode;
  constructor(code: CredentialErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'CredentialError';
  }
}

/** What `credential:status` answers with (contract §1.3). Never a key. */
export type CredentialStatus = {
  stored: boolean;
  backend: string;
  secure: boolean;
};

type VaultEntry = {
  /** base64 of the safeStorage ciphertext. The ONLY form the key takes here. */
  ciphertext: string;
  updatedAt: number;
  /** Whether the backend was secure at the time of writing. Advisory. */
  secure: boolean;
};

type VaultFile = {
  version: 1;
  entries: Record<string, VaultEntry>;
};

const EMPTY_FILE: VaultFile = { version: 1, entries: {} };

export type CredentialVaultOptions = {
  /** Electron's `userData`. The vault file is created under `<userData>/naby`. */
  userDataDir: string;
  /** Defaults to Electron's real `safeStorage`; injectable for the spike. */
  safeStorage?: SafeStorageLike;
  /** Defaults to `process.platform`; injectable so the spike can act as linux. */
  platform?: NodeJS.Platform;
  /** File name override, so a test vault never collides with the real one. */
  fileName?: string;
  log?: (msg: string) => void;
};

export class CredentialVault {
  readonly filePath: string;

  #safeStorage: SafeStorageLike;
  #platform: NodeJS.Platform;
  #log: (msg: string) => void;

  #ready = false;
  #backend = 'unknown';
  #secure = false;
  #warning: string | null = null;

  constructor(opts: CredentialVaultOptions) {
    this.#safeStorage = opts.safeStorage ?? loadElectronSafeStorage();
    this.#platform = opts.platform ?? process.platform;
    this.#log = opts.log ?? ((msg) => console.log(msg));
    this.filePath = join(opts.userDataDir, 'naby', opts.fileName ?? 'credentials.json');
  }

  // -- readiness -----------------------------------------------------------

  /**
   * MUST be called after `app.whenReady()`, and the ordering is load-bearing:
   * `getSelectedStorageBackend()` returns 'unknown' before ready (design §4.1),
   * so an early call would report a backend that tells us nothing and we would
   * conclude "not basic_text" from ignorance.
   */
  async init(): Promise<CredentialSecurity> {
    let available = false;
    try {
      available = this.#safeStorage.isEncryptionAvailable();
      // The async encryptor initializes lazily; asking now means the first
      // `set()` is not also paying for initialization, and a backend that can
      // only do sync work is discovered here rather than mid-write.
      if (available && this.#safeStorage.isAsyncEncryptionAvailable) {
        available = await this.#safeStorage.isAsyncEncryptionAvailable();
      }
    } catch (err) {
      available = false;
      this.#log(`[credentials] isEncryptionAvailable threw: ${String(err)}`);
    }

    // `getSelectedStorageBackend` is Linux-only in Electron's API. On macOS and
    // Windows the backend is the OS keychain / DPAPI and there is no basic_text
    // equivalent, so the platform name is reported instead of a fake value.
    if (this.#platform === 'linux') {
      try {
        this.#backend = this.#safeStorage.getSelectedStorageBackend?.() ?? 'unknown';
      } catch {
        this.#backend = 'unknown';
      }
    } else if (!available) {
      this.#backend = 'unavailable';
    } else {
      this.#backend = this.#platform === 'darwin' ? 'macos_keychain' : 'dpapi';
    }

    this.#secure = available && this.#backend !== 'basic_text' && this.#backend !== 'unavailable';

    if (!available) {
      this.#warning =
        'This computer has no working secure credential store, so Naby cannot encrypt an API key ' +
        'the way it normally would. A key saved now would be readable by anything that can read ' +
        'your files. Fix the system keyring first if you can.';
    } else if (this.#backend === 'basic_text') {
      this.#warning =
        'No system keyring (GNOME Keyring / KWallet) is available on this desktop, so Naby would ' +
        'scramble your API key with a password that is public knowledge — which is not real ' +
        'protection. Anyone who can read your files could recover the key. Install and unlock a ' +
        'keyring, or save the key only if you accept that risk.';
    } else {
      this.#warning = null;
    }

    this.#ready = true;
    this.#log(
      `[credentials] backend=${this.#backend} secure=${String(this.#secure)} file=${this.filePath}`,
    );
    return this.security();
  }

  #requireReady(): void {
    if (!this.#ready) {
      throw new CredentialError(
        'INTERNAL',
        'credential vault used before init(); init() must run after app.whenReady()',
      );
    }
  }

  security(): CredentialSecurity {
    return { backend: this.#backend, secure: this.#secure, warning: this.#warning };
  }

  get secure(): boolean {
    return this.#secure;
  }

  get backend(): string {
    return this.#backend;
  }

  get warning(): string | null {
    return this.#warning;
  }

  // -- the file ------------------------------------------------------------

  #read(): VaultFile {
    if (!existsSync(this.filePath)) return { ...EMPTY_FILE, entries: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<VaultFile>;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.entries !== 'object') {
        return { ...EMPTY_FILE, entries: {} };
      }
      return { version: 1, entries: parsed.entries ?? {} };
    } catch (err) {
      // A corrupt vault must not brick the app. It is ciphertext we can no
      // longer use anyway; the user re-enters the key. Never echo the content.
      this.#log(`[credentials] vault file unreadable, treating as empty: ${errMessage(err)}`);
      return { ...EMPTY_FILE, entries: {} };
    }
  }

  #write(file: VaultFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    // Write-then-rename: a crash mid-write leaves the previous vault intact
    // rather than a truncated file that reads as "no keys stored".
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, this.filePath);
  }

  // -- operations ----------------------------------------------------------

  /** Providers that currently have a key. Ids only — never values. */
  listStored(): string[] {
    return Object.keys(this.#read().entries);
  }

  /** Contract §1.3 `credential:status`. Deliberately cannot return a key. */
  status(providerId: string): CredentialStatus {
    this.#requireReady();
    return {
      stored: Object.hasOwn(this.#read().entries, providerId),
      backend: this.#backend,
      secure: this.#secure,
    };
  }

  /**
   * Store (or replace) a provider's key.
   *
   * Refuses on an insecure backend unless the caller acknowledges it — see the
   * header. The refusal carries CREDENTIAL_INSECURE so the renderer can branch
   * on it and render the warning + confirmation rather than a generic error.
   */
  async set(
    providerId: string,
    key: string,
    opts: { acknowledgeInsecure?: boolean } = {},
  ): Promise<{ secure: boolean }> {
    this.#requireReady();
    if (!providerId) throw new CredentialError('INTERNAL', 'providerId is required');
    // Trimmed because a key pasted from a web page routinely arrives with a
    // trailing newline, and the provider would reject it with a 401 that looks
    // like "your key is wrong" rather than "your clipboard had whitespace".
    const trimmed = key.trim();
    if (!trimmed) throw new CredentialError('INTERNAL', 'key is empty');

    if (!this.#secure && !opts.acknowledgeInsecure) {
      throw new CredentialError(
        'CREDENTIAL_INSECURE',
        this.#warning ??
          'This computer has no secure credential store, so the key cannot be stored safely.',
      );
    }

    let ciphertext: Buffer;
    try {
      ciphertext = this.#safeStorage.encryptStringAsync
        ? await this.#safeStorage.encryptStringAsync(trimmed)
        : this.#safeStorage.encryptString(trimmed);
    } catch (err) {
      // errMessage, never the key: an encryption failure must not be the thing
      // that puts the plaintext into a log line.
      throw new CredentialError(
        'CREDENTIAL_UNAVAILABLE',
        `could not encrypt the key: ${errMessage(err)}`,
      );
    }

    const file = this.#read();
    file.entries[providerId] = {
      ciphertext: ciphertext.toString('base64'),
      updatedAt: Date.now(),
      secure: this.#secure,
    };
    this.#write(file);
    // Length is logged, value is not. It is the one property that helps
    // diagnose "I pasted the wrong thing" without leaking anything.
    this.#log(
      `[credentials] stored key for "${providerId}" (${trimmed.length} chars, secure=${String(this.#secure)})`,
    );
    return { secure: this.#secure };
  }

  /**
   * Decrypt a provider's key.
   *
   * THE ONLY function in the app that yields plaintext key material, and its
   * only caller is the credential bridge, whose only caller is the engine. It
   * is not exposed over IPC in any form.
   */
  async get(providerId: string): Promise<string | null> {
    this.#requireReady();
    const entry = this.#read().entries[providerId];
    if (!entry) return null;

    const buf = Buffer.from(entry.ciphertext, 'base64');
    try {
      if (this.#safeStorage.decryptStringAsync) {
        const { shouldReEncrypt, result } = await this.#safeStorage.decryptStringAsync(buf);
        if (shouldReEncrypt) {
          // The OS rotated its key or offers a stronger one. Re-encrypting now
          // is the documented response; skipping it would leave the entry on an
          // older key indefinitely. A failure here is not fatal — we still have
          // the decrypted value the caller asked for.
          void this.set(providerId, result, { acknowledgeInsecure: true }).catch((err: unknown) =>
            this.#log(`[credentials] re-encrypt failed for "${providerId}": ${errMessage(err)}`),
          );
        }
        return result;
      }
      return this.#safeStorage.decryptString(buf);
    } catch (err) {
      // Typically: the vault was written by another OS user, or the keychain
      // entry was revoked. Report it as unavailable rather than crashing a turn.
      this.#log(`[credentials] decrypt failed for "${providerId}": ${errMessage(err)}`);
      return null;
    }
  }

  /** Contract §1.3 `credential:clear`. Idempotent. */
  clear(providerId: string): void {
    this.#requireReady();
    const file = this.#read();
    if (!Object.hasOwn(file.entries, providerId)) return;
    delete file.entries[providerId];
    if (Object.keys(file.entries).length === 0 && existsSync(this.filePath)) {
      // Remove the file entirely rather than leaving `{"entries":{}}` behind,
      // so "no keys stored" looks the same on disk as a fresh install — which
      // is what the onboarding check reads.
      unlinkSync(this.filePath);
    } else {
      this.#write(file);
    }
    this.#log(`[credentials] cleared key for "${providerId}"`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Electron's real `safeStorage`.
 *
 * Read through a function rather than used directly at the call site so the
 * injected-fake path and the production path go through the same seam — and so
 * that a `CredentialVault` constructed with an explicit `safeStorage` never
 * touches Electron's at all, which is what lets the spike simulate a
 * basic_text machine on a Mac.
 */
function loadElectronSafeStorage(): SafeStorageLike {
  return electronSafeStorage as unknown as SafeStorageLike;
}
