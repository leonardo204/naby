// electron/providers.ts
//
// F1-04 — provider PROFILES. `<userData>/providers.json`, per contract §6.
//
// THE INVARIANT THIS FILE EXISTS TO HOLD (contract §4): the profiles file holds
// NO SECRET. It carries the model id, the Azure resource/deployment/apiVersion,
// the Bedrock region — the things a user would happily read out loud — plus an
// OPAQUE `credentialRef`. The key itself lives in `credentials.ts`, in a
// different file, written by a different class. That separation is not
// stylistic: it means "did a key leak into the profiles file" is answerable by
// grepping one file that this class is the only writer of, which is exactly
// what spike-f104 does.
//
// `provider:select` is here too. Contract §1.3 scopes it to a `sessionId`
// because switching provider mid-session must not disturb history or memory
// (design §3.4) — so the selection is recorded as a session→provider map
// alongside the profiles, and NOTHING about the conversation is touched.
//
// LIMITATION, stated rather than hidden: the runtime's SessionRef also carries
// a `providerId`, and reconciling the two is F1-03's job (it owns the session
// lifecycle). Until then this map is the desktop-side record of the user's
// choice and the runtime keeps its own hint; they agree in the only case that
// exists today, which is one provider.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProviderProfile } from '../dist/naby-runtime.mjs';

type ProvidersFile = {
  version: 1;
  profiles: ProviderProfile[];
  /** sessionId → providerId (contract §1.3 `provider:select`). */
  selections: Record<string, string>;
  /** Provider used when a session has not chosen one. */
  activeProviderId?: string;
  /**
   * F1-06. Set once the user finishes (or explicitly skips) the wizard.
   * Onboarding ALSO ends implicitly when any key exists — see
   * `OnboardingState` below — so this flag only carries the "I skipped" case.
   */
  onboardedAt?: number;
};

const EMPTY: ProvidersFile = { version: 1, profiles: [], selections: {} };

export type OnboardingState = {
  /**
   * True when the app should show chat rather than the wizard.
   *
   * INFERRED from "any provider has a key", with the explicit flag only able to
   * ADD to that. Inference is the primary signal because it cannot go stale: a
   * user who clears their last key is genuinely back to an unusable app and
   * should be walked through setup again, which a sticky boolean would prevent.
   */
  onboarded: boolean;
  /** Providers that currently have a key stored. Ids only. */
  configured: string[];
  /** True when the user dismissed the wizard without configuring anything. */
  skipped: boolean;
};

export class ProviderProfileStore {
  readonly filePath: string;

  constructor(opts: { userDataDir: string; fileName?: string }) {
    this.filePath = join(opts.userDataDir, opts.fileName ?? 'providers.json');
  }

  #read(): ProvidersFile {
    if (!existsSync(this.filePath)) return { ...EMPTY, profiles: [], selections: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<ProvidersFile>;
      return {
        version: 1,
        profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
        selections: parsed.selections ?? {},
        ...(parsed.activeProviderId ? { activeProviderId: parsed.activeProviderId } : {}),
        ...(parsed.onboardedAt ? { onboardedAt: parsed.onboardedAt } : {}),
      };
    } catch {
      return { ...EMPTY, profiles: [], selections: {} };
    }
  }

  #write(file: ProvidersFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8');
    renameSync(tmp, this.filePath);
  }

  list(): ProviderProfile[] {
    return this.#read().profiles;
  }

  get(providerId: string): ProviderProfile | undefined {
    return this.#read().profiles.find((p) => p.id === providerId);
  }

  /**
   * Insert or replace a profile.
   *
   * `credentialRef` is FORCED here rather than trusted from the renderer. The
   * renderer has no business naming a vault entry, and a ref it controlled
   * would be a way to point one provider's profile at another's key.
   */
  upsert(profile: ProviderProfile): void {
    const file = this.#read();
    const clean: ProviderProfile = { ...profile, credentialRef: `vault:${profile.id}` };
    const at = file.profiles.findIndex((p) => p.id === clean.id);
    if (at >= 0) file.profiles[at] = clean;
    else file.profiles.push(clean);
    file.activeProviderId ??= clean.id;
    this.#write(file);
  }

  remove(providerId: string): void {
    const file = this.#read();
    file.profiles = file.profiles.filter((p) => p.id !== providerId);
    if (file.activeProviderId === providerId) {
      delete file.activeProviderId;
      const first = file.profiles[0];
      if (first) file.activeProviderId = first.id;
    }
    this.#write(file);
  }

  /** Contract §1.3 `provider:select`. Touches selection ONLY. */
  select(sessionId: string, providerId: string): void {
    const file = this.#read();
    file.selections[sessionId] = providerId;
    file.activeProviderId = providerId;
    this.#write(file);
  }

  selectionFor(sessionId: string): string | undefined {
    const file = this.#read();
    return file.selections[sessionId] ?? file.activeProviderId;
  }

  markOnboarded(): void {
    const file = this.#read();
    file.onboardedAt = Date.now();
    this.#write(file);
  }

  /** F1-06. `configured` comes from the VAULT, which is the honest source. */
  onboardingState(configured: string[]): OnboardingState {
    const file = this.#read();
    const skipped = configured.length === 0 && typeof file.onboardedAt === 'number';
    return { onboarded: configured.length > 0 || skipped, configured, skipped };
  }
}
