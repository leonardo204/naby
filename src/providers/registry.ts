// src/providers/registry.ts
//
// The five first-party provider adapters (contract §4). This file is the ONLY
// place in the codebase that touches a credential. Everything above it — the
// runtime, the gate, the executors, the session store — is key-independent and
// never sees a secret.
//
// Contract §4 invariants enforced here:
//
//   * Exactly five ProviderKinds. No gateway/tier concept.
//   * `config.kind` must match `kind` (validated in createModel).
//   * A key is read ONLY when constructing the model for a turn. It is never
//     stored in a profile, never logged, never returned. `credentialRef` is an
//     opaque handle into the keychain; resolving it is the caller's job (main
//     process), and the resolved value is passed in and used once.
//   * Per-provider quirks (Azure deployment-as-model-id, Bedrock SigV4 vs
//     bearer key) are normalized here and never leak into the runtime.
//
// NOTE (no keys in this environment): this module is written to be
// constructible and type-correct; SPIKE-05 supplies real credentials and calls
// it live. `describeProviders()` documents exactly what each kind needs so that
// spike is a matter of filling in values, not re-deriving the shape.

import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV4 } from '@ai-sdk/provider';

// ---------------------------------------------------------------------------
// Profile shape (contract §4, verbatim)
// ---------------------------------------------------------------------------

export type ProviderKind =
  | 'anthropic'
  | 'bedrock'
  | 'azure-openai'
  | 'google'
  | 'openai';

export type ProviderConfig =
  | { kind: 'anthropic' }
  | { kind: 'bedrock'; region: string } // Claude models on Bedrock
  | {
      kind: 'azure-openai';
      deployment: string;
      /**
       * TWO Azure endpoint shapes, normalized here.
       *
       * CLASSIC: a `resource` sub-domain (→ `https://{resource}.openai.azure.com`)
       *   with an `apiVersion`. The `@ai-sdk/azure` deployment-URL form addresses
       *   `{base}/deployments/{deployment}{path}?api-version=…`.
       *
       * V1 / AI-SERVICES: a full `baseURL` ending in `/openai/v1`
       *   (`https://{resource}.services.ai.azure.com/openai/v1`). This surface is
       *   OpenAI-COMPATIBLE — Bearer auth, no `api-version`, no `/deployments/`
       *   segment — so it is driven through the OpenAI adapter with that baseURL,
       *   NOT through `createAzure`'s deployment-URL builder (which would emit a
       *   `/deployments/…?api-version=` URL the v1 endpoint rejects with 404).
       *
       * Exactly one of `resource` / `baseURL` is used; `baseURL` wins when set.
       */
      resource?: string;
      baseURL?: string;
      apiVersion?: string;
    }
  | { kind: 'google' } // Gemini
  | { kind: 'openai' };

export type ProviderProfile = {
  id: string;
  label: string;
  kind: ProviderKind;
  config: ProviderConfig;
  /** model id, or the deployment name for azure-openai. */
  model: string;
  /** opaque handle into the keychain; never the key itself. */
  credentialRef: string;
};

// ---------------------------------------------------------------------------
// Credentials — the resolved secret, passed in for exactly one construction.
// ---------------------------------------------------------------------------

/**
 * DEVIATION (documented): contract §4 speaks of "a key", and the task brief
 * suggests `createModel(profile, apiKey)`. Bedrock's SigV4 path needs an
 * access-key PAIR (plus optional session token), which a single string cannot
 * carry — so the credential is a small union instead of a bare string. The
 * invariant that matters is unchanged: the secret is read here, used once to
 * construct the model, and never stored, logged, or returned.
 *
 * `apiKeyCredential()` keeps the common case a one-liner.
 */
export type ProviderCredential =
  | { kind: 'api-key'; apiKey: string }
  | {
      kind: 'aws-sigv4';
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken?: string;
    };

export const apiKeyCredential = (apiKey: string): ProviderCredential => ({
  kind: 'api-key',
  apiKey,
});

class ProviderConfigError extends Error {
  readonly code = 'PROVIDER_CONFIG_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'ProviderConfigError';
  }
}

/** Never let a secret reach an error string. */
function requireApiKey(
  credential: ProviderCredential,
  kind: ProviderKind,
): string {
  if (credential.kind !== 'api-key') {
    throw new ProviderConfigError(
      `provider "${kind}" requires an api-key credential, got "${credential.kind}"`,
    );
  }
  if (!credential.apiKey) {
    throw new ProviderConfigError(`provider "${kind}" got an empty api key`);
  }
  return credential.apiKey;
}

// ---------------------------------------------------------------------------
// The factory — the ONLY key-reading function in the codebase.
// ---------------------------------------------------------------------------

/**
 * Construct the provider model for one turn.
 *
 * @param profile    provider profile (holds NO secret; `credentialRef` is opaque)
 * @param credential the resolved secret, used once, never retained
 */
export function createModel(
  profile: ProviderProfile,
  credential: ProviderCredential,
): LanguageModelV4 {
  // Contract §4: `config.kind` must match `kind`.
  if (profile.config.kind !== profile.kind) {
    throw new ProviderConfigError(
      `profile "${profile.id}": config.kind "${profile.config.kind}" does not match kind "${profile.kind}"`,
    );
  }
  if (!profile.model) {
    throw new ProviderConfigError(`profile "${profile.id}": model is required`);
  }

  const config = profile.config;
  switch (config.kind) {
    case 'anthropic': {
      const anthropic = createAnthropic({
        apiKey: requireApiKey(credential, 'anthropic'),
      });
      return anthropic(profile.model);
    }

    case 'openai': {
      const openai = createOpenAI({
        apiKey: requireApiKey(credential, 'openai'),
      });
      return openai(profile.model);
    }

    case 'google': {
      const google = createGoogleGenerativeAI({
        apiKey: requireApiKey(credential, 'google'),
      });
      return google(profile.model);
    }

    case 'azure-openai': {
      // Azure quirk, normalized here: the "model id" IS the deployment name.
      // `config.deployment` is authoritative; `profile.model` must agree, so a
      // profile cannot silently address a different deployment than it names.
      if (config.deployment !== profile.model) {
        throw new ProviderConfigError(
          `profile "${profile.id}": azure deployment "${config.deployment}" != model "${profile.model}" ` +
            '(for azure-openai the model id IS the deployment name)',
        );
      }
      const apiKey = requireApiKey(credential, 'azure-openai');
      // V1 / AI-Services endpoint: OpenAI-compatible. Drive it through the
      // OpenAI adapter pointed at the `/openai/v1` base — Bearer auth, the
      // deployment as the model id, no api-version, no `/deployments/` segment.
      if (config.baseURL) {
        const compat = createOpenAI({ apiKey, baseURL: config.baseURL.replace(/\/$/, '') });
        return compat(config.deployment);
      }
      // Classic endpoint: the `@ai-sdk/azure` deployment-URL builder.
      if (!config.resource) {
        throw new ProviderConfigError(
          `profile "${profile.id}": azure-openai needs either a baseURL (v1 endpoint) or a resource (classic)`,
        );
      }
      const azure = createAzure({
        resourceName: config.resource,
        apiKey,
        apiVersion: config.apiVersion,
        // apiVersion is only honored on the deployment-based URL shape
        // (`{base}/deployments/{id}{path}?api-version=…`), which is the shape a
        // pinned apiVersion in the profile is asking for.
        useDeploymentBasedUrls: true,
      });
      return azure(config.deployment);
    }

    case 'bedrock': {
      // Bedrock quirk, normalized here: two auth shapes. A bearer api key
      // (AWS_BEARER_TOKEN_BEDROCK style) or classic SigV4 access keys.
      // `profile.model` may be a plain model id or an inference-profile ID —
      // both are passed through untouched.
      const bedrock =
        credential.kind === 'api-key'
          ? createAmazonBedrock({
              region: config.region,
              apiKey: requireApiKey(credential, 'bedrock'),
            })
          : createAmazonBedrock({
              region: config.region,
              accessKeyId: credential.accessKeyId,
              secretAccessKey: credential.secretAccessKey,
              ...(credential.sessionToken
                ? { sessionToken: credential.sessionToken }
                : {}),
            });
      return bedrock(profile.model);
    }
  }
}

// ---------------------------------------------------------------------------
// Self-description — so SPIKE-05 only has to supply values.
// ---------------------------------------------------------------------------

export type ProviderDescription = {
  kind: ProviderKind;
  label: string;
  /** fields required on `ProviderProfile.config` for this kind. */
  configFields: string[];
  /** which credential shapes this kind accepts. */
  credentialKinds: ProviderCredential['kind'][];
  /** what `ProviderProfile.model` means for this kind. */
  modelMeaning: string;
  /**
   * F1-04. What to prefill when a user adds this provider through the UI, so
   * onboarding is "paste key → done" rather than "go read a model catalogue".
   * It lives HERE because this file is the single list the UI is driven off
   * (contract §4); a default kept anywhere else would be a second list.
   */
  defaultModel: string;
  /**
   * F1-04. The env var consulted as a FALLBACK when no key is in the vault —
   * CI and SPIKE-05 use it. Also derived from this one list rather than
   * hardcoded at the consumer, for the same reason.
   */
  envVar: string;
  /** Where a non-developer goes to obtain the key. Rendered in the wizard. */
  keyHelp: string;
};

export const PROVIDER_KINDS: readonly ProviderKind[] = [
  'anthropic',
  'bedrock',
  'azure-openai',
  'google',
  'openai',
] as const;

/** The five supported kinds and the config each one needs. */
export function describeProviders(): ProviderDescription[] {
  return [
    {
      kind: 'anthropic',
      label: 'Anthropic (direct API)',
      configFields: [],
      credentialKinds: ['api-key'],
      modelMeaning: 'Anthropic model id, e.g. claude-sonnet-4-5',
      defaultModel: 'claude-sonnet-4-5',
      envVar: 'NABY_ANTHROPIC_API_KEY',
      keyHelp: 'console.anthropic.com → Settings → API keys',
    },
    {
      kind: 'bedrock',
      label: 'Amazon Bedrock',
      configFields: ['region'],
      credentialKinds: ['api-key', 'aws-sigv4'],
      modelMeaning: 'Bedrock model id or inference-profile ID',
      defaultModel: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
      envVar: 'NABY_BEDROCK_API_KEY',
      keyHelp: 'AWS console → Bedrock → API keys (long-term bearer key)',
    },
    {
      kind: 'azure-openai',
      label: 'Azure OpenAI',
      configFields: ['resource', 'deployment', 'apiVersion'],
      credentialKinds: ['api-key'],
      modelMeaning: 'the DEPLOYMENT name (must equal config.deployment)',
      defaultModel: '',
      envVar: 'NABY_AZURE_OPENAI_API_KEY',
      keyHelp: 'Azure portal → your Azure OpenAI resource → Keys and Endpoint',
    },
    {
      kind: 'google',
      label: 'Google Gemini',
      configFields: [],
      credentialKinds: ['api-key'],
      modelMeaning: 'Gemini model id, e.g. gemini-2.5-pro',
      defaultModel: 'gemini-2.5-pro',
      envVar: 'NABY_GOOGLE_API_KEY',
      keyHelp: 'aistudio.google.com → Get API key',
    },
    {
      kind: 'openai',
      label: 'OpenAI',
      configFields: [],
      credentialKinds: ['api-key'],
      modelMeaning: 'OpenAI model id, e.g. gpt-5',
      defaultModel: 'gpt-4o',
      envVar: 'NABY_OPENAI_API_KEY',
      keyHelp: 'platform.openai.com → API keys',
    },
  ];
}

// ---------------------------------------------------------------------------
// Bridge to the engine: a ModelResolver the engine can hold without ever
// seeing a key. The app closes a credential lookup over this ONE function.
// ---------------------------------------------------------------------------

/** Resolve `credentialRef` -> the secret. Implemented by the keychain layer. */
export type CredentialResolver = (
  credentialRef: string,
) => Promise<ProviderCredential> | ProviderCredential;

/**
 * Build the resolver `AiSdkEngine` takes. The engine calls it with a
 * `providerId`; the key is fetched, used to construct the model, and dropped —
 * the engine only ever holds the constructed model.
 */
export function makeModelResolver(
  profiles: readonly ProviderProfile[],
  resolveCredential: CredentialResolver,
): (providerId: string, model?: string) => Promise<LanguageModelV4> {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  return async (providerId: string, model?: string) => {
    const profile = byId.get(providerId);
    if (!profile) {
      throw new ProviderConfigError(`no provider profile with id "${providerId}"`);
    }
    // A per-turn model override still goes through the profile's provider.
    const effective: ProviderProfile = model ? { ...profile, model } : profile;
    const credential = await resolveCredential(profile.credentialRef);
    return createModel(effective, credential);
  };
}
