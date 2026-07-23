// src/runtime/store/harness-set.ts
//
// Shared, driver-agnostic logic for harness-set EXPORT and IMPORT/merge
// (phase-1_6-harness-contracts §5/§6). Both Store drivers (SqliteStore,
// MemoryStore) call these so the bundle format and the merge/conflict rules are
// identical by construction — the same reason the two gates share trust.ts.
//
// The store-specific parts (how a row is found / written) are passed in as
// callbacks, keeping this module pure of any storage detail.

import type {
  HarnessImportRequest,
  HarnessItem,
  HarnessKind,
  HarnessScope,
  HarnessSet,
} from './store.js';

/** The provenance origin string for items imported from a set. Deterministic so
 * a re-import of the same set updates the same candidate rather than duplicating. */
export function harnessSetOrigin(set: { name: string; version: string }): string {
  return `set:${set.name}@${set.version}`;
}

/** Count items per kind for a set manifest. */
export function countHarnessKinds(items: HarnessItem[]): {
  command: number;
  skill: number;
  subagent: number;
} {
  const counts = { command: 0, skill: 0, subagent: 0 };
  for (const it of items) counts[it.kind] += 1;
  return counts;
}

/** Build a portable HarnessSet from already-selected items (the caller filters
 * to ENABLED + any id subset first). Payloads are inline; the manifest counts
 * are derived. */
export function buildHarnessSet(
  items: HarnessItem[],
  opts?: { name?: string; version?: string; description?: string; createdBy?: string },
): HarnessSet {
  const set: HarnessSet = {
    name: opts?.name ?? 'harness-set',
    version: opts?.version ?? '0.0.0',
    items: items.map((it) => ({ ...it, provenance: { ...it.provenance } })),
    manifest: {
      createdAt: Date.now(),
      counts: countHarnessKinds(items),
    },
  };
  if (opts?.description !== undefined) set.description = opts.description;
  if (opts?.createdBy !== undefined) set.manifest.createdBy = opts.createdBy;
  return set;
}

/**
 * Merge a HarnessSet into a scope through the import gate (contract §5).
 * Driver-agnostic: `find` looks a row up by identity, `put` runs the gate + upsert.
 *
 * Rules enforced here:
 *   - Everything lands DISABLED, provenance source:'external', origin
 *     'set:<name>@<version>' (the `put` callback's gate guarantees the disabled
 *     status; we set the provenance).
 *   - `ids` selects a subset (by the item's own id in the set).
 *   - CONFLICT: an incoming item never overwrites an ENABLED local item at
 *     (into.scope, into.scopeKey, kind, name). On such a conflict it lands under
 *     a DETERMINISTIC disambiguated name ("<name> (from set:x@ver)") as a
 *     separate disabled candidate for the user to compare — and a re-import
 *     updates that same candidate instead of duplicating. A local DISABLED item
 *     is a mere candidate and may be updated in place.
 */
export function mergeHarnessSet(
  set: HarnessSet,
  into: { scope: HarnessScope; scopeKey: string },
  opts: { ids?: string[] } | undefined,
  deps: {
    find: (
      scope: HarnessScope,
      scopeKey: string,
      kind: HarnessKind,
      name: string,
    ) => HarnessItem | undefined,
    put: (req: HarnessImportRequest) => HarnessItem,
  },
): HarnessItem[] {
  const origin = harnessSetOrigin(set);
  const importedAt = Date.now();
  const idFilter = opts?.ids ? new Set(opts.ids) : undefined;
  const landed: HarnessItem[] = [];

  for (const item of set.items) {
    if (idFilter && !idFilter.has(item.id)) continue;

    const landingName = resolveLandingName(
      into,
      item.kind,
      item.name,
      origin,
      deps.find,
    );

    const req: HarnessImportRequest = {
      item: buildExternalItem(item, into, landingName, origin, importedAt),
      requestedStatus: 'disabled',
    };
    landed.push(deps.put(req));
  }

  return landed;
}

/** Find a name to land the incoming item under. Prefer the item's own name; if a
 * local ENABLED item already sits there, fall back to a deterministic
 * "<name> (from <origin>)" candidate — and keep suffixing only if THAT name also
 * holds an enabled item (so the merge can never overwrite an enabled row). */
function resolveLandingName(
  into: { scope: HarnessScope; scopeKey: string },
  kind: HarnessKind,
  name: string,
  origin: string,
  find: (
    scope: HarnessScope,
    scopeKey: string,
    kind: HarnessKind,
    name: string,
  ) => HarnessItem | undefined,
): string {
  const existing = find(into.scope, into.scopeKey, kind, name);
  if (!existing || existing.status !== 'enabled') return name;

  const base = `${name} (from ${origin})`;
  let candidate = base;
  let n = 2;
  // Only an ENABLED occupant forces a further suffix; a disabled candidate is
  // updated in place (re-import idempotency).
  while (true) {
    const row = find(into.scope, into.scopeKey, kind, candidate);
    if (!row || row.status !== 'enabled') return candidate;
    candidate = `${base} #${n++}`;
  }
}

/** Rewrite one set item into an import request item: retarget the scope, force
 * external provenance with the set origin, keep the interchange format, and
 * carry the kind-specific payload through unchanged. */
function buildExternalItem(
  item: HarnessItem,
  into: { scope: HarnessScope; scopeKey: string },
  landingName: string,
  origin: string,
  importedAt: number,
): HarnessImportRequest['item'] {
  const out: HarnessImportRequest['item'] = {
    scope: into.scope,
    scopeKey: into.scopeKey,
    kind: item.kind,
    name: landingName,
    provenance: {
      source: 'external',
      origin,
      importedAt,
    },
  };
  if (item.description !== undefined) out.description = item.description;
  if (item.provenance.format !== undefined) out.provenance.format = item.provenance.format;
  if (item.command !== undefined) out.command = item.command;
  if (item.skill !== undefined) out.skill = item.skill;
  if (item.subagent !== undefined) out.subagent = item.subagent;
  return out;
}
