// src/providers/resolve.ts
//
// F1-04 — "which provider answers this turn, and where does its key come from".
//
// WHY THIS LIVES IN THE RUNTIME AND NOT IN THE SHELL'S ENGINE
// The shell's `naby.ts` used to own this: it read `NABY_*_API_KEY` off the
// environment and built a profile inline. That put the one piece of logic F1-04
// has to PROVE (a typed failure when no credential is configured) inside a
// submodule TypeScript file that neither the Electron main process nor a tsx
// spike driver can import. Moving it here makes it:
//
//   * testable — spike-f104 asserts against the same function preflight calls,
//   * single-sourced — the provider list, the default models and the env-var
//     names all come from `describeProviders()`, so there is no second list,
//   * shell-diff-free — `naby.ts` shrinks to one `await` instead of growing.
//
// WHERE THE KEY COMES FROM (in order)
//   1. the CREDENTIAL BRIDGE, if the host installed one. In the desktop app the
//      Electron main process installs a bridge backed by `safeStorage`
//      (electron/credentials.ts). The Next server runs INSIDE that same main
//      process, so this is an in-process function call, not IPC — and the shell
//      never imports `electron`, so it still runs headless under the plain CLI.
//   2. the ENVIRONMENT, as a documented fallback. CI has no keychain and
//      SPIKE-05 will want to point at a key without clicking through a wizard.
//
// The key is returned to exactly one caller — the engine, which passes it
// straight into `createModel` for one turn. It is never persisted here, never
// logged here, and never travels back toward the renderer.

import {
  describeProviders,
  type ProviderConfig,
  type ProviderKind,
  type ProviderProfile,
} from './registry.js';

// ---------------------------------------------------------------------------
// The bridge — implemented by the privileged host (Electron main).
// ---------------------------------------------------------------------------

/** Vault health, as the renderer and the engine both need to see it. */
export type CredentialSecurity = {
  /** e.g. 'macos_keychain', 'dpapi', 'gnome_libsecret', 'basic_text'. */
  backend: string;
  /** false when safeStorage fell back to a hardcoded password, or is absent. */
  secure: boolean;
  /** Human-readable warning when `secure` is false; null otherwise. */
  warning: string | null;
};

/**
 * The narrow surface the runtime needs from a credential store.
 *
 * NOTE the asymmetry, which is the point: `listProfiles` returns profiles (no
 * secrets, contract §4) and can be handed to anyone; `getKey` returns a secret
 * and is called from exactly one place, the engine boundary below.
 */
export interface CredentialBridge {
  listProfiles(): Promise<ProviderProfile[]> | ProviderProfile[];
  getKey(providerId: string): Promise<string | null> | string | null;
  security(): Promise<CredentialSecurity> | CredentialSecurity;
}

// A global rather than a parameter because the two ends cannot see each other:
// the Electron main process cannot import the shell's engine module (it lives
// in the Next graph), and the shell must not import `electron`. They share a
// process, so a well-known global is the only seam that does not require one to
// depend on the other. It is deliberately NOT reachable from the renderer —
// nothing here crosses contextBridge.
const BRIDGE_KEY = '__nabyCredentialBridge';

type BridgeHost = { [BRIDGE_KEY]?: CredentialBridge };

export function installCredentialBridge(bridge: CredentialBridge): void {
  (globalThis as BridgeHost)[BRIDGE_KEY] = bridge;
}

export function getCredentialBridge(): CredentialBridge | undefined {
  return (globalThis as BridgeHost)[BRIDGE_KEY];
}

export function clearCredentialBridge(): void {
  delete (globalThis as BridgeHost)[BRIDGE_KEY];
}

// ---------------------------------------------------------------------------
// Result shape — contract §1.2 codes, so the engine can map straight through.
// ---------------------------------------------------------------------------

export type CredentialSource = 'vault' | 'env';

export type ResolvedProvider = {
  profile: ProviderProfile;
  /** The secret. Used once, by the engine, to construct the model. */
  apiKey: string;
  source: CredentialSource;
  /** Vault health when the key came from the vault; null for the env path. */
  security: CredentialSecurity | null;
};

export type ProviderResolutionError = {
  code: 'CREDENTIAL_UNAVAILABLE' | 'PROVIDER_CONFIG_INVALID';
  message: string;
};

export type ProviderResolution =
  | { ok: true; value: ResolvedProvider }
  | { ok: false; error: ProviderResolutionError };

/**
 * The message a NON-DEVELOPER sees when nothing is configured.
 *
 * It is written for that reader deliberately: it names the thing to click, not
 * the env var to export, because the env var is the fallback for CI and the
 * wizard is the path a person is meant to take. The env vars are mentioned last
 * and marked as optional so a developer still finds them.
 */
export const NO_CREDENTIAL_MESSAGE =
  'Naby does not have an AI provider key yet, so there is nothing to answer with. ' +
  'Open Settings (gear icon, bottom left) → "AI provider", pick your provider, ' +
  'paste its API key and press Save — that is the whole setup. ' +
  'The key is stored in this computer\'s secure credential store and is never sent anywhere except to the provider you chose. ' +
  `(Developers: setting ${describeProviders()
    .map((d) => d.envVar)
    .join(' / ')} in the environment also works.)`;

// ---------------------------------------------------------------------------
// Default profiles — what a bare "here is my key" means
// ---------------------------------------------------------------------------

function defaultConfigFor(kind: ProviderKind): ProviderConfig {
  switch (kind) {
    case 'bedrock':
      return { kind, region: process.env.AWS_REGION || 'us-east-1' };
    case 'azure-openai':
      return { kind, resource: '', deployment: '', apiVersion: '2024-10-21' };
    default:
      return { kind };
  }
}

/**
 * The profile a provider gets when the user has only supplied a key.
 *
 * `id` is the kind. That is a choice worth stating: contract §4 makes `id`
 * free-form, but the onboarding flow is "one key per provider" (design §4.2),
 * so making the id predictable means the wizard, the vault and the engine can
 * all name the same provider without a lookup table. A user who later wants two
 * Azure deployments upserts a second profile with its own id, and nothing here
 * blocks that.
 */
export function defaultProfileFor(kind: ProviderKind): ProviderProfile {
  const description = describeProviders().find((d) => d.kind === kind);
  return {
    id: kind,
    label: description?.label ?? kind,
    kind,
    config: defaultConfigFor(kind),
    model: description?.defaultModel ?? '',
    // Opaque handle (contract §4). It names the vault entry, and the vault is
    // keyed by provider id — so this carries no secret and no path.
    credentialRef: `vault:${kind}`,
  };
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type ResolveOptions = {
  /** Per-turn model override. Never changes which provider answers. */
  requestedModel?: string | undefined;
  /** Force one provider by id. Defaults to `NABY_PROVIDER`. */
  providerId?: string | undefined;
};

function applyModel(profile: ProviderProfile, requestedModel?: string): ProviderProfile {
  const model = requestedModel || process.env.NABY_MODEL || profile.model;
  return model === profile.model ? profile : { ...profile, model };
}

/** The env fallback, derived from `describeProviders()` so it cannot drift. */
function resolveFromEnv(opts: ResolveOptions): ResolvedProvider | null {
  const forced = opts.providerId || process.env.NABY_PROVIDER || '';
  for (const description of describeProviders()) {
    if (forced && forced !== description.kind) continue;
    const apiKey = process.env[description.envVar];
    if (!apiKey) continue;
    const profile = applyModel(defaultProfileFor(description.kind), opts.requestedModel);
    return {
      apiKey,
      source: 'env',
      security: null,
      // The ref records WHERE the secret came from, still without carrying it.
      profile: { ...profile, credentialRef: `env:${description.envVar}` },
    };
  }
  return null;
}

/**
 * Pick the provider for a turn and fetch its key.
 *
 * Vault first, environment second. A provider that has a profile but no stored
 * key is skipped rather than failing the whole resolution — a half-configured
 * Azure entry must not stop a perfectly good Anthropic key from answering.
 */
export async function resolveProviderCredential(
  opts: ResolveOptions = {},
): Promise<ProviderResolution> {
  const forced = opts.providerId || process.env.NABY_PROVIDER || '';
  const bridge = getCredentialBridge();

  if (bridge) {
    const profiles = await bridge.listProfiles();
    const candidates = forced ? profiles.filter((p) => p.id === forced) : profiles;
    for (const profile of candidates) {
      const apiKey = await bridge.getKey(profile.id);
      if (!apiKey) continue;
      // A profile whose required config is blank cannot construct a model, and
      // failing here with a config code is far more useful than letting the
      // provider SDK throw something opaque mid-turn.
      const missing = missingConfigFields(profile);
      if (missing.length > 0) {
        return {
          ok: false,
          error: {
            code: 'PROVIDER_CONFIG_INVALID',
            message:
              `"${profile.label}" still needs: ${missing.join(', ')}. ` +
              'Open Settings → "AI provider" and fill those in.',
          },
        };
      }
      return {
        ok: true,
        value: {
          apiKey,
          source: 'vault',
          security: await bridge.security(),
          profile: applyModel(profile, opts.requestedModel),
        },
      };
    }
  }

  const fromEnv = resolveFromEnv(opts);
  if (fromEnv) return { ok: true, value: fromEnv };

  return { ok: false, error: { code: 'CREDENTIAL_UNAVAILABLE', message: NO_CREDENTIAL_MESSAGE } };
}

/** Config fields the profile declares as required but has left empty. */
export function missingConfigFields(profile: ProviderProfile): string[] {
  const description = describeProviders().find((d) => d.kind === profile.kind);
  if (!description) return [];
  const config = profile.config as Record<string, unknown>;
  const missing = description.configFields.filter((field) => !config[field]);
  if (!profile.model) missing.push('model');
  return missing;
}

// ---------------------------------------------------------------------------
// Preflight — the engine's "can this run at all" check.
// ---------------------------------------------------------------------------

export type PreflightResult =
  | { ok: true }
  | { ok: false; status: 400; code: ProviderResolutionError['code']; error: string };

/**
 * Answer "is a turn possible" WITHOUT calling the provider.
 *
 * It deliberately stops at "a key exists and the profile is complete". Proving
 * the key actually works needs a network round trip against a real provider,
 * which is SPIKE-05's job — and doing it here would turn every app start into a
 * billable request. A wrong key surfaces as PROVIDER_AUTH_FAILED on the first
 * turn instead, which is the same information one turn later.
 */
export async function preflightProvider(opts: ResolveOptions = {}): Promise<PreflightResult> {
  const resolution = await resolveProviderCredential(opts);
  if (resolution.ok) return { ok: true };
  return { ok: false, status: 400, code: resolution.error.code, error: resolution.error.message };
}
