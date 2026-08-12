// src/runtime/harness-seed.ts
//
// THE BUILT-IN HARNESS — a skill and a subagent that ship WITH naby, and the one
// switch that turns them on (skill-hub-builtin §2.7).
//
// WHAT SHIPS. `confluence-context` (skill) decides whether a question needs the
// company wiki, and hands the actual research to `confluence-researcher`
// (subagent), which talks to the `cic` MCP server and returns a compressed answer.
// The two are one capability in two pieces: the skill without the subagent has
// nobody to delegate to, and the subagent without the skill is never called.
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

/**
 * Which built-in items each bundle owns.
 *
 * Declared here rather than in the artifact frontmatter because it is not a fact
 * about the document — it is a fact about which SERVER makes the document useful,
 * and that pairing belongs next to the activation rule it drives.
 */
export const BUILTIN_HARNESS_BUNDLES: Readonly<Record<string, readonly string[]>> = {
  [CIC_HARNESS_BUNDLE_ID]: ['confluence-context', 'confluence-researcher'],
};

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
 * the old one; that is the right trade for two documents the user is invited to
 * edit, and a future upgrade path can be an explicit, reported action.
 *
 * ARRIVES DISABLED, ALWAYS. `requestedStatus:'disabled'` is what the gate is handed,
 * and the automatic status is recorded as 'disabled' so the first activation knows
 * the row is still untouched.
 */
export function seedBuiltinHarness(
  store: HarnessSeedStore,
  opts?: BuiltinHarnessOptions,
): BuiltinHarnessSeedResult {
  const userId = opts?.userId ?? DEFAULT_USER_ID;
  const out: BuiltinHarnessSeedResult = { seeded: [], kept: [] };

  for (const asset of BUILTIN_HARNESS_ASSETS) {
    if (findRow(store, userId, asset)) {
      out.kept.push(asset.name);
      continue;
    }
    const body = harnessAssetBody(asset.raw);
    const toolRefs = asset.toolRefs ? [...asset.toolRefs] : undefined;
    // The skill's frontmatter `triggers` become the row's triggers, which is what
    // keeps a ~1.7k-token document OFF the turns that do not want it: a skill with
    // no triggers is ALWAYS-ON (skill-inject.ts), and always-on here would spend
    // most of the skill budget on every turn (skill-hub-builtin §2.7).
    const triggers = asset.triggers ? [...asset.triggers] : undefined;
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
              },
            }),
      },
      requestedStatus: 'disabled',
    });
    store.setSetting(builtinHarnessAutoStatusKey(asset.name), 'disabled');
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
