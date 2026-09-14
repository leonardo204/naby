// src/runtime/harness-seed.ts
//
// THE BUILT-IN HARNESS — the artifacts that ship WITH naby, and the switches that
// turn them on (skill-hub-builtin §2.7).
//
// WHAT SHIPS, IN THREE BUNDLES.
//
//   `core`: `explorer` (subagent, haiku) and `implementer` (subagent, sonnet) —
//   the two cheap delegates that exist to keep the MAIN transcript small
//   (specs/subagent-delegation.md §4.1). They hang off NO credential, so unlike
//   the two bundles below their switch is not a token: the shell adds `core` to
//   `activeBundles` UNCONDITIONALLY at every boot, which is what "always active"
//   means here. See CORE_HARNESS_BUNDLE_ID below for why that is still compatible
//   with the write-once seed rule and with user ownership.
//
//   `cic`: `confluence-context` (skill) decides whether a question needs the
//   company wiki, and hands the actual research to `confluence-researcher`
//   (subagent), which talks to the `cic` MCP server and returns a compressed
//   answer. The two are one capability in two pieces: the skill without the
//   subagent has nobody to delegate to, and the subagent without the skill is
//   never called.
//
//   `atlassian`: `confluence-upload` (skill) drives the confUploader CLI so a
//   markdown file becomes a Confluence page with its tables, links and mermaid
//   diagrams intact. It is READ's opposite number and it hangs off a different
//   credential, which is why it is a second bundle rather than a third cic item.
//
// A BUNDLE IS THE UNIT, NOT THE ITEM. Every rule below is stated over a bundle id,
// so a third server with its own harness is one entry in BUILTIN_HARNESS_BUNDLES
// and one `harnessBundle` on its preset — no new branch anywhere.
//
// WHY THEY ARE ROWS, NOT FILES. The alternative was writing the two `.md` files
// into the naby harness home at boot and letting the scanner import them. That
// loses on three counts: it writes into the user's home directory for something
// they never asked for; a delete would be undone by the next boot (the file comes
// back, the scanner re-imports it); and the naby-home scan grants `enabled` on
// arrival (harness-gate invariant 7), which is exactly the opposite of what this
// bundle wants — it must stay inert until the `cic` token exists. Seeding rows
// directly keeps all three answers ours. `seedBuiltinPersona` (agents.ts) set the
// precedent: a built-in is a row the product writes once, not a file it plants.
//
// THE ACTIVATION RULE, AND WHY IT IS THE POINT.
//
//   The seed arrives DISABLED. Enabled, it would fire on the first question that
//   smells like company jargon, delegate to a subagent whose only tools are
//   `cic__*` — and, with no cic server configured, that subagent has NO TOOLS AT
//   ALL. The user's reward for asking a question would be a confident "I could not
//   research Confluence". So the bundle's switch is the credential: saving a cic
//   token is the user's explicit opt-in, and removing the preset turns it back off.
//
//   BUT IT NEVER OVERRIDES THE USER. If the user disabled the skill by hand, a
//   later re-save of the token must NOT switch it back on. This is the harness's
//   existing principle — an import never beats what the user turned off (gate
//   invariants 5 and 7: a re-scan may restate content, never trust) — restated for
//   a switch that is driven by a setting rather than by a file walk. It has the
//   same justification: the user's own toggle is the highest-trust statement about
//   an item, and anything automatic that could undo it makes the toggle a lie.
//
//   HOW WE KNOW. Every automatic write records WHAT IT WROTE, in
//   `harness.builtin.<name>.autoStatus`. A later transition compares the row's
//   current status with that record: equal means nothing has touched the row since
//   we last set it, so we may set it again; different means a human moved it, and
//   we leave it alone forever after. No timestamps, no heuristics — just "is this
//   still the value we wrote".
//
// PURE-ISH AND SPIKE-TESTABLE. Everything here is a function of (store, args); it
// reads no environment, resolves no path and touches no filesystem. The shell owns
// the two call sites (boot, and the System MCP save/remove), which is where the
// knowledge of "the cic preset changed" actually lives.

import { BUILTIN_HARNESS_ASSETS, type BuiltinHarnessAsset } from './harness-assets/generated.js';
import { DEFAULT_USER_ID } from './memory-inject.js';
import type { HarnessItem, HarnessStatus, Store } from './store/store.js';

export { BUILTIN_HARNESS_ASSETS };
export type { BuiltinHarnessAsset };

/** The bundle id the `cic` System MCP preset switches. A preset names a bundle;
 *  the bundle names its items. Nothing branches on the string anywhere else. */
export const CIC_HARNESS_BUNDLE_ID = 'cic';

/** The bundle id the `atlassian` System MCP preset switches.
 *
 *  WHY ATLASSIAN AND NOT CIC. `confluence-upload` drives the confUploader CLI with
 *  `CONFLUENCE_BASE_URL` / `CONFLUENCE_EMAIL` / `CONFLUENCE_API_TOKEN` — the same
 *  three values the atlassian preset already collects (`CONFLUENCE_URL`,
 *  `CONFLUENCE_USERNAME`, `CONFLUENCE_API_TOKEN`, systemMcp.ts). A user who has
 *  configured atlassian has, by construction, a Confluence account and a token;
 *  a user who has only cic has a READ index and may have neither. So the atlassian
 *  credential is the honest opt-in signal for a skill that WRITES pages.
 *
 *  NOTE what this does NOT claim: naby does not hand those stored values to the
 *  skill. They live in the mcp-atlassian entry's `env` and reach that stdio process
 *  only — `run_command` gets the app's own environment. The preset proves the user
 *  HAS Confluence access; the skill still asks for the values it needs (which is
 *  what its body says). */
export const ATLASSIAN_HARNESS_BUNDLE_ID = 'atlassian';

/**
 * The bundle that is MEANT TO BE ALWAYS ACTIVE — `explorer` and `implementer`
 * (specs/subagent-delegation.md §4.1).
 *
 * WHY IT NEEDS NO CREDENTIAL, AND WHAT SWITCHES IT INSTEAD. The other two bundles
 * are inert without a server: a Confluence skill with no cic token is a confident
 * apology. These two need nothing but the turn's own tools, so there is no
 * credential to wait for and no honest moment to turn them on later. The shell
 * therefore puts this id in `activeBundles` at EVERY boot, unconditionally — the
 * same argument the atlassian case uses for a preset that was saved long ago,
 * applied to a bundle whose precondition is simply "naby is running".
 *
 * WHAT DOES NOT CHANGE, and must not:
 *
 *   * THE WRITE-ONCE SEED RULE. `seedBuiltinHarness` still seeds only what is
 *     ABSENT. `activeBundles` decides the ARRIVAL STATUS of a row being created,
 *     never the status of a row that already exists — so "always active" cannot
 *     become "re-enabled on every boot". The two names are new (§2 principle 6),
 *     so on an existing install the rows are absent and arrive enabled; on the
 *     next boot they are present and nothing is written at all.
 *   * USER OWNERSHIP. A row seeded 'enabled' records 'enabled' as its automatic
 *     status, so a user who turns `explorer` off in Settings breaks that equality
 *     and owns the row from then on: `applyBuiltinHarnessActivation` reports it
 *     `userOwned` forever after, and the unconditional boot-time `activeBundles`
 *     never reaches it because the row is not absent. Turning it off keeps it off
 *     (§7), by exactly the mechanism the credential bundles already use.
 */
export const CORE_HARNESS_BUNDLE_ID = 'core';

/**
 * The bundles that have NO System MCP preset behind them and are therefore always
 * active — today, exactly `core`.
 *
 * WHY A LIST AND NOT AN ASSUMPTION. The seed and the switch are both driven by
 * "which bundles are configured", and that question is answered by the shell's
 * `configuredHarnessBundles`, which walks the MCP registry. A bundle with no
 * preset is invisible to that walk, so it would answer "not configured" forever
 * and the rows would arrive disabled with nothing left to turn them on. Naming
 * the always-on set HERE, next to the table it indexes, means the call site is
 * one spread rather than a special case:
 *
 *     seedBuiltinHarness(store, {
 *       activeBundles: [...configuredHarnessBundles(store), ...ALWAYS_ON_HARNESS_BUNDLES],
 *     });
 *
 * and each id in that spread is one `applyBuiltinHarnessActivation(store, id,
 * true)` — that function switches ONE bundle per call.
 * NOTHING ELSE CHANGES: a row is still seeded once and only when absent, a
 * transition still writes only while the row matches the automatic status we last
 * recorded, and a row the user moved (or deleted) is theirs forever. "Always on"
 * describes the DEFAULT this bundle arrives with, not a value re-asserted on
 * every boot.
 */
export const ALWAYS_ON_HARNESS_BUNDLES: readonly string[] = [CORE_HARNESS_BUNDLE_ID];

/**
 * May this subagent run on this engine? (specs/subagent-delegation.md §4.1.)
 *
 * The rule is permissive by default: a subagent that declares NO engines (every
 * one written before the `core` bundle, and every imported one) runs on all of
 * them, so this filter can be applied unconditionally at the roster call site
 * without changing what any existing install sees.
 *
 * `explorer` and `implementer` declare `dev-claude` because they are written
 * against the Agent SDK's own tools and Anthropic's model aliases. Offering them
 * on another provider would not fail loudly — it would produce a subagent with an
 * empty toolset, or a model name the provider rejects — which is the failure mode
 * this exists to prevent.
 *
 * Takes the PAYLOAD, not a row, so the shell can call it on whatever shape it has
 * to hand (a `HarnessItem.subagent`, an asset, a `SubagentSpec` that grew the
 * field) and a spike can call it on an object literal.
 *
 * AN UNKNOWN ENGINE FAILS CLOSED for a subagent that named one: "I do not know
 * which engine this is" is not evidence that a dev-claude-only agent will work
 * here. An undeclared subagent is unaffected — it was always allowed anyway.
 */
export function subagentAllowedForEngine(
  subagent: { engines?: readonly string[] } | undefined,
  engineId: string | undefined,
): boolean {
  const engines = subagent?.engines;
  if (!engines || engines.length === 0) return true;
  if (!engineId) return false;
  // Both sides are compared AS THEY ARE: the generator's `csvList` already trims
  // every entry, so trimming one side here would only hide a padded engine id
  // arriving from somewhere that does not.
  return engines.some((e) => e === engineId);
}

/**
 * Which built-in items each bundle owns.
 *
 * Declared here rather than in the artifact frontmatter because it is not a fact
 * about the document — it is a fact about which SERVER makes the document useful,
 * and that pairing belongs next to the activation rule it drives.
 *
 * A bundle is a SET OF NAMES, and the bundles are disjoint. Nothing here
 * assumes a name belongs to at most one bundle, but `bundleOwning` (below) does
 * take the first match, so keep them disjoint.
 */
export const BUILTIN_HARNESS_BUNDLES: Readonly<Record<string, readonly string[]>> = {
  [CIC_HARNESS_BUNDLE_ID]: ['confluence-context', 'confluence-researcher'],
  [ATLASSIAN_HARNESS_BUNDLE_ID]: ['confluence-upload'],
  [CORE_HARNESS_BUNDLE_ID]: ['explorer', 'implementer'],
};

/** The bundle that owns an item, if any. The inverse of the table above, computed
 *  rather than maintained, so the two can never disagree. */
export function bundleOwning(name: string): string | undefined {
  for (const [bundleId, names] of Object.entries(BUILTIN_HARNESS_BUNDLES)) {
    if (names.includes(name)) return bundleId;
  }
  return undefined;
}

/** `provenance.origin` of a seeded row: a non-path HANDLE, like a set import's
 *  `set:<name>@<version>`. It must not look like a file, because there is no file
 *  — and the delete tiers read origin to decide whether to unlink something
 *  (harnessSource.ts). A non-path origin lands on the tombstone tier, which is the
 *  correct answer: deleting a built-in removes the row and leaves a marker, and
 *  `seedBuiltinHarness` then never brings it back. */
export function builtinHarnessOrigin(name: string): string {
  return `builtin:${name}`;
}

/** Where the automatic switch records what IT last wrote, per item. */
export function builtinHarnessAutoStatusKey(name: string): string {
  return `harness.builtin.${name}.autoStatus`;
}

/** The store surface these functions need — small on purpose, so a spike can fake
 *  it and a caller can see exactly what is touched. */
export type HarnessSeedStore = Pick<
  Store,
  'listHarness' | 'putHarnessItem' | 'setHarnessEnabled' | 'getSetting' | 'setSetting'
>;

export type BuiltinHarnessOptions = {
  /** User-scope key. Defaults to the single-user id the rest of the runtime uses. */
  userId?: string;
};

export type BuiltinHarnessSeedOptions = BuiltinHarnessOptions & {
  /**
   * Bundle ids whose server is ALREADY CONFIGURED at seed time. Items of those
   * bundles are seeded ENABLED instead of disabled.
   *
   * WHY THIS EXISTS. The switch (`applyBuiltinHarnessActivation`) fires when a
   * credential is SAVED or REMOVED. A built-in that ships in a LATER release is
   * seeded on the next boot of an install where the credential was saved months
   * ago — no save happens, so nothing ever turns it on, and the user's reward for
   * having configured the server early is a permanently inert skill they must find
   * in Settings. Seeding it active closes that hole without asking them to re-save.
   *
   * WHY IT IS A CALLER ARGUMENT AND NOT A STORE READ. This module reads no
   * settings and no MCP registry on purpose (see the header): "is this preset
   * configured" is the shell's question, asked at the one call site that already
   * owns the registry. Absent/empty ⇒ every item seeds disabled, which is exactly
   * what this function did before this parameter existed.
   *
   * WHY THIS DOES NOT CHANGE `cic`. The caller passes EVERY configured bundle —
   * no per-bundle special case, which is the property §2.1 keeps everywhere. It
   * still cannot alter the cic path, because this branch only runs for an ABSENT
   * row, and no release ever had the cic preset without the cic rows (they shipped
   * together in 0.6.0). An install that has the credential therefore always has the
   * rows, seeding reports them `kept`, and nothing here is reached. The atlassian
   * bundle is the opposite and is exactly why the parameter exists: its preset has
   * existed since 0.2.0 and its skill arrives now.
   */
  activeBundles?: readonly string[];
};

/** What a seed run did. Returned rather than logged so a spike can assert it. */
export type BuiltinHarnessSeedResult = {
  /** Names of rows this call created. */
  seeded: string[];
  /** Names that already had a row (of ANY status, tombstone included) and were
   *  therefore left exactly as they were. */
  kept: string[];
};

/** What an activation transition did. */
export type BuiltinHarnessActivationResult = {
  /** Names whose status this call changed. */
  changed: string[];
  /** Names left alone because the user had moved them since our last write. */
  userOwned: string[];
  /** Names with no row at all (never seeded, or deleted outright). */
  missing: string[];
};

/** Strip the leading YAML frontmatter — the body is what an engine injects, and it
 *  is what the importer stores for a file-borne skill, so a built-in must match. */
export function harnessAssetBody(raw: string): string {
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? raw.slice(m[0].length) : raw;
}

function findRow(
  store: HarnessSeedStore,
  userId: string,
  asset: BuiltinHarnessAsset,
): HarnessItem | undefined {
  // No status filter: a tombstone ('removed') is a row, and finding it is the
  // whole point — a deleted built-in must not be re-seeded on the next boot.
  return store
    .listHarness('user', userId, { kind: asset.kind })
    .find((row) => row.name === asset.name);
}

/**
 * Ensure the built-in harness rows exist. Idempotent; call it at every boot.
 *
 * SEEDS ONLY WHAT IS ABSENT. An existing row is never rewritten — not its status,
 * not its body. That is stricter than the file scanner (which refreshes changed
 * content) and deliberately so: there is no file to have changed, so any difference
 * between the row and the asset is the USER'S edit, and a boot-time "refresh" would
 * be a product that silently rewrites what its owner wrote. The cost is that a
 * later naby release cannot push a corrected skill body into an install that has
 * the old one; that is the right trade for documents the user is invited to edit,
 * and a future upgrade path can be an explicit, reported action.
 *
 * ARRIVES DISABLED UNLESS ITS SERVER IS ALREADY THERE. `requestedStatus:'disabled'`
 * is what the gate is normally handed, and the automatic status is recorded to match
 * so the first activation knows the row is still untouched. When the caller says the
 * item's bundle is already configured (`activeBundles`), the row is seeded 'enabled'
 * and the record says 'enabled' — the same two writes the switch would have made, at
 * the only moment the switch cannot run (see `BuiltinHarnessSeedOptions`). Either
 * way the record and the row agree on arrival, which is what makes "the user has not
 * touched this" decidable later.
 */
export function seedBuiltinHarness(
  store: HarnessSeedStore,
  opts?: BuiltinHarnessSeedOptions,
): BuiltinHarnessSeedResult {
  const userId = opts?.userId ?? DEFAULT_USER_ID;
  const active = new Set(opts?.activeBundles ?? []);
  const out: BuiltinHarnessSeedResult = { seeded: [], kept: [] };

  for (const asset of BUILTIN_HARNESS_ASSETS) {
    if (findRow(store, userId, asset)) {
      out.kept.push(asset.name);
      continue;
    }
    const bundleId = bundleOwning(asset.name);
    // 'artifact' is a TRUSTED tier, so the gate honours an 'enabled' request
    // (harness-gate invariant 1/3 pins only 'external'). Nothing here can enable
    // an EXISTING row: the `findRow` guard above already returned for those.
    const arrivesEnabled = bundleId !== undefined && active.has(bundleId);
    const arrivalStatus: HarnessStatus = arrivesEnabled ? 'enabled' : 'disabled';
    const body = harnessAssetBody(asset.raw);
    const toolRefs = asset.toolRefs ? [...asset.toolRefs] : undefined;
    // The skill's frontmatter `triggers` become the row's triggers, which is what
    // keeps a ~1.7k-token document OFF the turns that do not want it: a skill with
    // no triggers is ALWAYS-ON (skill-inject.ts), and always-on here would spend
    // most of the skill budget on every turn (skill-hub-builtin §2.7).
    const triggers = asset.triggers ? [...asset.triggers] : undefined;
    // Absent = every engine, which is what every artifact but the `core` pair
    // says (see `subagentAllowedForEngine`).
    const engines = asset.engines ? [...asset.engines] : undefined;
    store.putHarnessItem({
      item: {
        scope: 'user',
        scopeKey: userId,
        kind: asset.kind,
        name: asset.name,
        ...(asset.description ? { description: asset.description } : {}),
        provenance: {
          // 'artifact', not 'user' and not 'external'. These bytes ship inside
          // naby: nobody imported them from a stranger's tree (external), and the
          // owner did not write them (user). The tier also does useful work — a
          // later external import of the same name cannot overwrite an ENABLED
          // built-in (gate invariant 2).
          source: 'artifact',
          origin: builtinHarnessOrigin(asset.name),
          format: asset.kind === 'skill' ? 'claude-skill-md' : 'claude-agent-md',
        },
        ...(asset.kind === 'skill'
          ? {
              skill: {
                instructions: body,
                ...(triggers ? { triggers } : {}),
                ...(toolRefs ? { toolRefs } : {}),
              },
            }
          : {
              subagent: {
                systemPrompt: body,
                ...(asset.model ? { model: asset.model } : {}),
                ...(toolRefs ? { toolRefs } : {}),
                // The frontmatter `engines`, carried into the row so the roster
                // filter reads the STORED item and never has to go back to the
                // asset — the user may edit the row, and a filter that consulted
                // the shipped document would then answer about a different agent.
                ...(engines ? { engines } : {}),
              },
            }),
      },
      requestedStatus: arrivalStatus,
    });
    store.setSetting(builtinHarnessAutoStatusKey(asset.name), arrivalStatus);
    out.seeded.push(asset.name);
  }
  return out;
}

/**
 * Switch a bundle on or off because the server it depends on arrived or left.
 *
 * THE ONE RULE: touch a row only while it still holds the value we last wrote to
 * it. `harness.builtin.<name>.autoStatus` is that memory. A user who flips the
 * switch in Settings breaks the equality, and from then on this function reports
 * the item as `userOwned` and never writes it again — including on a re-save of the
 * credential, which is the regression this exists to prevent.
 *
 * A MISSING RECORD IS TREATED AS 'disabled'. Rows seeded by a build before this
 * setting existed are indistinguishable from freshly seeded ones, and 'disabled' is
 * what the seed always wrote — so the first activation still works for them, and a
 * row a user had already enabled by hand is (correctly) left alone.
 *
 * A TOMBSTONE IS NEVER TOUCHED. `setHarnessEnabled` on a 'removed' row would
 * RESURRECT it (store.ts documents the toggle as the restore action), so a deleted
 * built-in is reported `userOwned` and left dead.
 */
export function applyBuiltinHarnessActivation(
  store: HarnessSeedStore,
  bundleId: string,
  active: boolean,
  opts?: BuiltinHarnessOptions,
): BuiltinHarnessActivationResult {
  const userId = opts?.userId ?? DEFAULT_USER_ID;
  const names = BUILTIN_HARNESS_BUNDLES[bundleId] ?? [];
  const want: HarnessStatus = active ? 'enabled' : 'disabled';
  const out: BuiltinHarnessActivationResult = { changed: [], userOwned: [], missing: [] };

  for (const name of names) {
    const asset = BUILTIN_HARNESS_ASSETS.find((a) => a.name === name);
    if (!asset) continue;
    const row = findRow(store, userId, asset);
    if (!row) {
      out.missing.push(name);
      continue;
    }
    if (row.status === 'removed') {
      out.userOwned.push(name);
      continue;
    }
    // Blank counts as absent (the `readPresetUrl` convention), so a half-written
    // setting cannot freeze an item into "the user owns this" forever.
    const recorded = store.getSetting(builtinHarnessAutoStatusKey(name))?.trim() || 'disabled';
    if (row.status !== recorded) {
      // A human moved this row since we last wrote it. It is theirs now.
      out.userOwned.push(name);
      continue;
    }
    if (row.status === want) continue;
    store.setHarnessEnabled(row.id, active);
    store.setSetting(builtinHarnessAutoStatusKey(name), want);
    out.changed.push(name);
  }
  return out;
}
