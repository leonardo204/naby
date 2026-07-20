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
// The environment sits BELOW the stored setting deliberately... with one
// exception, `NABY_ENGINE`, which sits above it: forcing the engine is a
// developer/debugging affordance ("make this run on the dev engine right now"),
// and a stored UI preference silently overriding an explicitly exported
// variable would make that affordance unreliable exactly when it is needed.

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
 * `forced` is left UNDEFINED when the user chose automatic, so that
 * `selectEngine` falls through to `process.env.NABY_ENGINE` — which is how the
 * environment keeps its precedence over an unset preference without this module
 * having to read the environment itself.
 */
export function toSelectOptions(settings: NabySettings): {
  forced?: string;
  providerId?: string;
} {
  const out: { forced?: string; providerId?: string } = {};
  // NABY_ENGINE wins over a stored preference — see the header.
  const envEngine = process.env.NABY_ENGINE?.trim();
  const engine = envEngine || settings.enginePreference;
  if (engine && engine !== 'auto') out.forced = engine;
  if (settings.selectedProvider) out.providerId = settings.selectedProvider;
  return out;
}
