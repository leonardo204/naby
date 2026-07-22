// src/runtime/settings.ts
//
// F1-08 — "which provider answers", as a thing the USER sets rather than an
// environment variable a developer exports.
//
// WHY THIS IS NOT AN ENV VAR AND NOT `providers.json`
//
//   * `NABY_PROVIDER` / `NABY_ENGINE` still work and still WIN (see below).
//     They are the CI and developer path and nothing here removes them. But a
//     non-developer cannot set an env var for a double-clicked desktop app, and
//     F1-08's completion criterion is a person choosing between providers.
//   * `providers.json` is the Electron main process's file and holds credential
//     HANDLES. This is provider-independent preference, not credential state,
//     and the runtime must be able to read it without importing electron — the
//     same reason the MCP registry lives in the store rather than in main.
//
// PRECEDENCE, stated once and implemented once:
//
//     explicit call argument  >  stored setting  >  environment  >  automatic
//
// The environment sits BELOW the stored setting, with NO exception. An earlier
// version put `NABY_ENGINE` ABOVE the stored setting as a developer override,
// but that broke the product invariant "dev vs prod differs ONLY by agent-sdk
// vs api-key": a developer who launches with `NABY_ENGINE=dev-claude` and then
// EXPLICITLY picks a provider in Settings must get that provider — otherwise the
// UI choice is silently dead and the app reads as broken. So an explicit UI
// choice always wins; `NABY_ENGINE` only supplies the DEFAULT when the user has
// not chosen (preference is unset/auto), which is exactly the CI / first-run
// developer path it exists for.

import type { Store } from './store/store.js';

/** Keys in the store's settings table. Namespaced so a future setting from
 *  another feature cannot collide. */
export const SETTING_KEYS = {
  /** '' | 'auto' | 'dev-claude' | 'ai-sdk' */
  enginePreference: 'engine.preference',
  /** Provider PROFILE id (which, per providers/resolve.ts, defaults to the
   *  provider kind). Empty means "whichever provider has a key". */
  selectedProvider: 'provider.selected',
} as const;

export type NabySettings = {
  /** undefined = automatic. */
  enginePreference?: string;
  /** undefined = whichever configured provider resolves first. */
  selectedProvider?: string;
};

/** Read the user's stored choices. Absent/blank values become `undefined` so a
 *  caller can spread them into options without clobbering a real default. */
export function readSettings(store: Store): NabySettings {
  const out: NabySettings = {};
  const engine = store.getSetting(SETTING_KEYS.enginePreference)?.trim();
  const provider = store.getSetting(SETTING_KEYS.selectedProvider)?.trim();
  if (engine) out.enginePreference = engine;
  if (provider) out.selectedProvider = provider;
  return out;
}

/** Persist a choice. An empty string CLEARS it (back to automatic), which is
 *  what the UI's "Automatic" option sends — so "unset" needs no second channel. */
export function writeSettings(store: Store, next: NabySettings): void {
  if (next.enginePreference !== undefined) {
    store.setSetting(SETTING_KEYS.enginePreference, next.enginePreference);
  }
  if (next.selectedProvider !== undefined) {
    store.setSetting(SETTING_KEYS.selectedProvider, next.selectedProvider);
  }
}

/**
 * Turn stored settings into the options `selectEngine` takes.
 *
 * Precedence (see the header): a stored UI preference wins over `NABY_ENGINE`;
 * the environment is only the DEFAULT for an unset/auto preference. So an
 * explicit provider pick in Settings takes effect even when the app was launched
 * with `NABY_ENGINE=dev-claude`. `forced` is left undefined for automatic so
 * `selectEngine` runs its "a configured provider wins, else dev" auto logic.
 */
export function toSelectOptions(settings: NabySettings): {
  forced?: string;
  providerId?: string;
} {
  const out: { forced?: string; providerId?: string } = {};
  // Stored preference first; env is only the fallback when the user hasn't chosen.
  const engine = settings.enginePreference || process.env.NABY_ENGINE?.trim();
  if (engine && engine !== 'auto') out.forced = engine;
  if (settings.selectedProvider) out.providerId = settings.selectedProvider;
  return out;
}
