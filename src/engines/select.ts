// src/engines/select.ts
//
// WHICH ENGINE ANSWERS THIS TURN — and how we say so to a non-developer.
//
// There are two backends behind the `Engine` seam (contract §2): `AiSdkEngine`
// (production, five providers, needs an API key) and `ClaudeAgentSdkEngine`
// (development, local Claude OAuth, no key, no metered cost). Until now the
// shell only ever built the first one, so a user with no API key had no way to
// use the app at all even on a machine where the dev engine would work.
//
// THE CONSTRAINT THAT SHAPES THIS (design §3.3): the Agent SDK must never be in
// a shipped build, and `electron-builder.yml` already excludes it. So the dev
// engine is available exactly when the app runs UNPACKAGED — from a source
// checkout, where node_modules exists. That is not something to infer from a
// build flag; it is something to ASK, which is what
// `isClaudeAgentSdkAvailable()` does (a resolve, no module load).
//
// SELECTION IS EXPLICIT FIRST, AUTOMATIC SECOND:
//
//   NABY_ENGINE=dev-claude   force the dev engine. If the SDK is missing this
//                            is an ERROR, not a silent downgrade — someone who
//                            asked for it should be told it is not there.
//   NABY_ENGINE=ai-sdk       force production. Never touches the Agent SDK.
//   NABY_ENGINE unset/auto   a configured provider credential wins; otherwise
//                            the dev engine, if it is resolvable; otherwise
//                            neither, with an explanation.
//
// The order in `auto` matters and is deliberate: a user who has gone to the
// trouble of entering an API key expects THAT provider to answer. The dev engine
// is the fallback that makes the app usable with no key at all, not a default
// that quietly overrides a configured provider.

import {
  AGENT_SDK_UNAVAILABLE_MESSAGE,
  isClaudeAgentSdkAvailable,
} from './claude-agent-sdk-engine.js';
import {
  NO_CREDENTIAL_MESSAGE,
  resolveProviderCredential,
  type ResolveOptions,
} from '../providers/resolve.js';

// ---------------------------------------------------------------------------
// Names + cost basis
// ---------------------------------------------------------------------------

export type EngineId = 'dev-claude' | 'ai-sdk';

/**
 * How a turn's cost should be READ (F1-07). This is not decoration — it is what
 * keeps the cost display honest:
 *
 *   'metered'      a per-token bill lands on the user's provider account. A
 *                  dollar figure is meaningful if we have a price.
 *   'subscription' the turn ran on a local Claude sign-in. The Agent SDK still
 *                  reports `total_cost_usd`, but that is what the same tokens
 *                  WOULD have cost on the metered API — it is not a charge to
 *                  this user. Showing it as "cost" would be inventing a bill.
 */
export type CostBasis = 'metered' | 'subscription';

/** How the dev engine is described wherever a person can see it. */
export const DEV_ENGINE_LABEL = 'Development model (local Claude sign-in)';

/** The env var that forces the choice. */
export const ENGINE_ENV_VAR = 'NABY_ENGINE';

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export type EngineSelection =
  | {
      ok: true;
      engine: 'dev-claude';
      /** Model id to ask the SDK for; undefined means "the SDK's own default". */
      model?: string;
      costBasis: 'subscription';
      /** One sentence a non-developer can read. */
      summary: string;
    }
  | {
      ok: true;
      engine: 'ai-sdk';
      costBasis: 'metered';
      summary: string;
    }
  | {
      ok: false;
      code: 'NO_ENGINE_AVAILABLE' | 'DEV_ENGINE_UNAVAILABLE' | 'CREDENTIAL_UNAVAILABLE';
      /** The full explanation, written for a non-developer. */
      message: string;
    };

export type SelectEngineOptions = ResolveOptions & {
  /** Override the env var. Used by the spikes so selection is testable without
   *  mutating process.env. */
  forced?: string | undefined;
  /** Override the availability probe. Spikes use it to exercise the packaged
   *  ("SDK absent") branch on a machine where the SDK IS installed. */
  devEngineAvailable?: () => boolean;
};

/**
 * The message shown when NOTHING can answer.
 *
 * It has to serve two very different readers at once, so it is ordered for the
 * one who cannot fix it by reading code: what is wrong, then the one action that
 * fixes it, then — parenthesised and last — the developer's alternative.
 */
export function noEngineMessage(): string {
  return (
    'Naby has no way to answer yet. ' +
    'Open Settings (gear icon, bottom left) → "AI provider", pick your provider, paste its API key and press Save. ' +
    "The key is stored in this computer's secure credential store and is only ever sent to the provider you chose. " +
    '(Developers: running from a source checkout with @anthropic-ai/claude-agent-sdk installed also enables the ' +
    'built-in development model, which uses your local Claude sign-in and needs no API key. ' +
    `Set ${ENGINE_ENV_VAR}=dev-claude to force it.)`
  );
}

/** Pick the engine for a turn. Reads no credential VALUE — only whether one
 *  exists — so this is safe to call from a preflight. */
export async function selectEngine(
  opts: SelectEngineOptions = {},
): Promise<EngineSelection> {
  const forced = (opts.forced ?? process.env[ENGINE_ENV_VAR] ?? '').trim();
  const devAvailable = (opts.devEngineAvailable ?? isClaudeAgentSdkAvailable)();
  const devModel = process.env.NABY_DEV_MODEL || undefined;

  const devSelection = (why: string): EngineSelection => ({
    ok: true,
    engine: 'dev-claude',
    ...(devModel ? { model: devModel } : {}),
    costBasis: 'subscription',
    summary:
      `${DEV_ENGINE_LABEL} will answer — it uses the Claude sign-in already on this computer, ` +
      `so it needs no API key and adds no per-message charge. (${why})`,
  });

  // -- explicit: dev engine ------------------------------------------------
  if (forced === 'dev-claude') {
    if (!devAvailable) {
      return {
        ok: false,
        code: 'DEV_ENGINE_UNAVAILABLE',
        message: `${ENGINE_ENV_VAR}=dev-claude was set, but ${AGENT_SDK_UNAVAILABLE_MESSAGE}`,
      };
    }
    return devSelection(`${ENGINE_ENV_VAR}=dev-claude`);
  }

  // -- explicit: production ------------------------------------------------
  if (forced === 'ai-sdk') {
    const resolution = await resolveProviderCredential(opts);
    if (!resolution.ok) {
      return {
        ok: false,
        code: resolution.error.code === 'PROVIDER_CONFIG_INVALID'
          ? 'CREDENTIAL_UNAVAILABLE'
          : 'CREDENTIAL_UNAVAILABLE',
        message: resolution.error.message,
      };
    }
    return {
      ok: true,
      engine: 'ai-sdk',
      costBasis: 'metered',
      summary:
        `${resolution.value.profile.label} (${resolution.value.profile.model}) will answer, ` +
        `using the API key you saved. Messages are billed to that provider account. ` +
        `(${ENGINE_ENV_VAR}=ai-sdk)`,
    };
  }

  // -- auto: a configured provider wins ------------------------------------
  const resolution = await resolveProviderCredential(opts);
  if (resolution.ok) {
    return {
      ok: true,
      engine: 'ai-sdk',
      costBasis: 'metered',
      summary:
        `${resolution.value.profile.label} (${resolution.value.profile.model}) will answer, ` +
        'using the API key you saved. Messages are billed to that provider account.',
    };
  }

  // A HALF-CONFIGURED provider is a different situation from an unconfigured
  // one: the user has already chosen, and silently answering on a different
  // engine would hide their mistake. Say what is missing instead.
  if (resolution.error.code === 'PROVIDER_CONFIG_INVALID') {
    return {
      ok: false,
      code: 'CREDENTIAL_UNAVAILABLE',
      message: resolution.error.message,
    };
  }

  // -- auto: fall back to the dev engine -----------------------------------
  if (devAvailable) {
    return devSelection('no AI provider key is configured yet');
  }

  return { ok: false, code: 'NO_ENGINE_AVAILABLE', message: noEngineMessage() };
}

/**
 * The preflight answer, in the shape the shell's `EngineSpec.preflight` wants.
 *
 * On success it carries `summary` — the sentence that says WHICH engine will
 * answer — because "the app works but I have no idea what is answering me or
 * whether it costs money" is the exact confusion F1-07 and this task exist to
 * remove.
 */
export type EnginePreflight =
  | { ok: true; engine: EngineId; costBasis: CostBasis; summary: string }
  | { ok: false; status: 400; code: string; error: string };

export async function preflightEngine(
  opts: SelectEngineOptions = {},
): Promise<EnginePreflight> {
  const selection = await selectEngine(opts);
  if (!selection.ok) {
    return { ok: false, status: 400, code: selection.code, error: selection.message };
  }
  return {
    ok: true,
    engine: selection.engine,
    costBasis: selection.costBasis,
    summary: selection.summary,
  };
}

/** Kept separate from `NO_CREDENTIAL_MESSAGE` so the provider-only wording is
 *  still available to callers that genuinely mean "no provider key". */
export { NO_CREDENTIAL_MESSAGE };
