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
import {
  CHATGPT_OAUTH_DEFAULT_MODEL,
  CHATGPT_QUERY_BASE_URL,
  isChatgptOauthEnabled,
  makeChatgptFetch,
  type ChatgptTokenSource,
} from './chatgpt-oauth.js';

// ---------------------------------------------------------------------------
// Profile shape (contract §4, verbatim)
// ---------------------------------------------------------------------------

export type ProviderKind =
  | 'anthropic'
  | 'bedrock'
  | 'azure-openai'
  | 'google'
  | 'openai'
  // DEV-ONLY, flag-sealed (see chatgpt-oauth.ts). Answers on a signed-in ChatGPT
  // subscription via the unofficial Codex Responses backend. Never offered unless
  // `isChatgptOauthEnabled()` — the type includes it so `createModel`'s switch is
  // exhaustive, but `describeProviders`/selection gate it behind the flag.
  | 'openai-chatgpt-oauth';

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
  | { kind: 'openai' }
  | { kind: 'openai-chatgpt-oauth' }; // DEV-ONLY subscription OAuth (flag-sealed)

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
    }
  // DEV-ONLY (flag-sealed). Not a static secret: a live token SOURCE that the
  // custom transport pulls a fresh access token from per request, refreshing +
  // rotating behind a 401. The vault (electron/chatgpt-oauth.ts) implements it.
  | {
      kind: 'chatgpt-oauth';
      source: ChatgptTokenSource;
      platform?: string;
      release?: string;
      arch?: string;
      fedramp?: boolean;
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

    case 'openai-chatgpt-oauth': {
      // DEV-ONLY, flag-sealed subscription transport (spec §3/§8). The runtime
      // seal is enforced where the provider is OFFERED (describeProviders /
      // isChatgptOauthAvailable); this factory refuses to construct if the flag
      // is off, so even a hand-built profile cannot reach the backend in an
      // official build. The credential is a token SOURCE, not a key.
      if (!isChatgptOauthEnabled()) {
        throw new ProviderConfigError(
          `provider "openai-chatgpt-oauth" is a dev-only, flag-sealed path and is not enabled here`,
        );
      }
      if (credential.kind !== 'chatgpt-oauth') {
        throw new ProviderConfigError(
          `provider "openai-chatgpt-oauth" requires a chatgpt-oauth credential, got "${credential.kind}"`,
        );
      }
      // A DUMMY apiKey keeps the adapter happy; the real auth is the Bearer token
      // our customFetch injects (and which wins over this placeholder). The
      // RESPONSES factory hits `/responses`, not `/chat/completions`.
      const openai = createOpenAI({
        baseURL: CHATGPT_QUERY_BASE_URL,
        apiKey: 'chatgpt-oauth-subscription',
        fetch: makeChatgptFetch(credential.source, {
          ...(credential.platform !== undefined ? { platform: credential.platform } : {}),
          ...(credential.release !== undefined ? { release: credential.release } : {}),
          ...(credential.arch !== undefined ? { arch: credential.arch } : {}),
          ...(credential.fedramp !== undefined ? { fedramp: credential.fedramp } : {}),
        }),
      });
      return openai.responses(profile.model);
    }

    case 'bedrock': {
      // Bedrock quirk, normalized here: two auth shapes. A bearer api key
      // (AWS_BEARER_TOKEN_BEDROCK style) or classic SigV4 access keys.
      // `profile.model` may be a plain model id or an inference-profile ID —
      // both are passed through untouched.
      if (credential.kind === 'api-key') {
        const bedrock = createAmazonBedrock({
          region: config.region,
          apiKey: requireApiKey(credential, 'bedrock'),
        });
        return bedrock(profile.model);
      }
      if (credential.kind !== 'aws-sigv4') {
        throw new ProviderConfigError(
          `provider "bedrock" requires an api-key or aws-sigv4 credential, got "${credential.kind}"`,
        );
      }
      const bedrock = createAmazonBedrock({
        region: config.region,
        accessKeyId: credential.accessKeyId,
        secretAccessKey: credential.secretAccessKey,
        ...(credential.sessionToken ? { sessionToken: credential.sessionToken } : {}),
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

/**
 * The five supported (metered, API-key) kinds and the config each needs.
 *
 * A SIXTH, DEV-ONLY kind (`openai-chatgpt-oauth`) is appended ONLY when the
 * runtime seal is open (`isChatgptOauthEnabled(env)`). With the flag off — the
 * default, and every official build — this returns exactly the five metered
 * providers, so nothing downstream (resolution, selection, the settings UI) can
 * even see the subscription-OAuth provider, let alone run it.
 */
export function describeProviders(env: NodeJS.ProcessEnv = process.env): ProviderDescription[] {
  const base: ProviderDescription[] = [
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
      // baseURL is the newer AI-Services endpoint (…/openai/v1); resource +
      // apiVersion are the classic shape. Supply EITHER baseURL OR resource —
      // baseURL wins when both are set (see the ProviderConfig doc).
      label: 'Azure OpenAI',
      configFields: ['baseURL', 'resource', 'deployment', 'apiVersion'],
      credentialKinds: ['api-key'],
      modelMeaning: 'the DEPLOYMENT name (must equal config.deployment)',
      defaultModel: '',
      envVar: 'NABY_AZURE_OPENAI_API_KEY',
      keyHelp:
        'Azure portal → your resource → Keys and Endpoint. Newer resources give a ' +
        '“…services.ai.azure.com/openai/v1” endpoint → paste it as baseURL; older ' +
        '“…openai.azure.com” resources → use resource + apiVersion instead.',
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

  // DEV-ONLY, flag-sealed. Appended last, and ONLY when the seal is open. This
  // is the single point where the subscription-OAuth provider becomes visible;
  // everything else keys off `describeProviders`, so the flag gate here is the
  // seal for resolution and the settings list alike.
  if (isChatgptOauthEnabled(env)) {
    base.push({
      kind: 'openai-chatgpt-oauth',
      label: 'ChatGPT (subscription, dev-only — ToS caveat)',
      configFields: [],
      credentialKinds: ['chatgpt-oauth'],
      modelMeaning: 'ChatGPT/Codex model slug, e.g. gpt-5.6-sol or gpt-5.6',
      defaultModel: CHATGPT_OAUTH_DEFAULT_MODEL,
      // Not a plain API-key env: the credential is an OAuth token set in the
      // vault. Named so the "developers can also set …" copy stays coherent; the
      // resolver skips this kind (no 'api-key'), so it never reads this var.
      envVar: 'NABY_ENABLE_CHATGPT_OAUTH',
      keyHelp:
        'Dev-only: sign in with your ChatGPT subscription. Uses the unofficial ' +
        'ChatGPT backend — a ToS grey zone, never shipped to end users.',
    });
  }

  return base;
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
