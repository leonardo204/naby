// src/runtime/org-harness.ts
//
// THE ORG HARNESS — altimedia-harness from Skill Hub, followed automatically
// (specs/org-harness-sync.md, M1: §3.1 package sync, §3.2 rows, §3.6 activation,
// §4.1–4.3 / §4.5 / §4.8 migration of existing installs).
//
// WHAT THIS FILE OWNS, AND WHAT IT DOES NOT.
//
//   * The package on disk: `<NABY_HOME>/org/altimedia-harness/<version>/`, plus a
//     `current.json` pointer that is flipped ONLY after a version is completely
//     extracted and verified. One previous version is kept so a turn that started
//     on it can finish (§4.7).
//   * The rows: one `harness_items` row per package skill, scope `org`, origin
//     `org:altimedia-harness@<version>`, body-less (`loadMode: 'on-demand'`).
//   * Activation: the daily `GET /api/v1/harness/bootstrap` that proves the
//     Skill Hub key and yields the metrics token.
//   * The two migration decisions an upgrade forces on an existing user: what to
//     do about a same-name copy they installed earlier (§4.5), and the switch that
//     undoes all of it (§4.8).
//
//   It does NOT read the MCP registry or the System MCP presets. "Which key is the
//   skill-hub key" is the shell's question (lib/systemMcp.ts owns the presets);
//   the shell hands the key in as `apiKey`. That keeps this module testable from a
//   spike with a fake fetch and a temp home, which is how every rule below is
//   checked (spike-org-harness-migrate.ts).
//
//   Out of scope for M1, by the spec's own staging: `naby_skill_load` and turn
//   injection (M2), the compatibility layer (M2), hooks (M3), the Atlassian gate
//   (M3). M4 added the six-hour re-check clock (`startOrgHarnessRecheck`, run by
//   the shell around `runOrgHarnessSync`) and package-folder leases, so the GC
//   never deletes a folder a running turn or hook still uses (§4.7).
//
// THE SAFETY PROPERTIES, in the order the spec states them.
//
//   NOTHING HAPPENS WITHOUT A SKILL-HUB KEY (§4.3). With no key and no org rows,
//   every entry point returns before its first write: rows and settings stay
//   byte-identical. (With no key but org rows present — the user removed the
//   preset — the org harness is treated as switched off.)
//
//   NEVER BLOCK, NEVER FAIL LOUDLY (§3.1, §4.2). Network failure is an outcome,
//   not an exception. A bad download is discarded and the previous version keeps
//   working. Callers run this in the background.
//
//   INTEGRITY, NOT AUTHENTICITY (§3.1). The zip's sha256 must equal the one the
//   marketplace lists. Both come from the same server, so this catches truncation
//   and corruption, not a compromised server.
//
//   NO SCHEMA CHANGE (§4.1). Everything new is payload JSON (`loadMode`,
//   `packageRef`, `supersededBy`) or a `harness.org.*` settings key.
//
//   THE USER'S TOGGLE WINS (§3.2). Org rows arrive enabled, and every later
//   automatic change goes through `applyAutoStatusTransition` — the same rule the
//   built-in bundles use (harness-seed.ts), keyed `harness.org.<name>.autoStatus`.
//
//   COPIES ARE NEVER DISABLED BEHIND THE USER'S BACK (§4.5). A same-name user or
//   project skill is reported, and only the user's choice changes it.

import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { applyAutoStatusTransition } from './harness-seed.js';
import { DEFAULT_USER_ID } from './memory-inject.js';
import type { HarnessItem, HarnessStatus, Store } from './store/store.js';
import { extractZip, ZipError } from './zip.js';
import { isOrgHookScriptWaiting, orgHookScriptsWaiting, type OrgHookScript } from './org-harness-hook-scripts.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The one package this feature follows (§6: other marketplace plugins are out of scope). */
export const ORG_HARNESS_PACKAGE = 'altimedia-harness';

/**
 * The `org` scopeKey org rows are written under.
 *
 * It MUST equal the shell's `DEFAULT_ORG_ID` ('default', engines/naby.ts,
 * lib/slashCommands.ts, api/commands.ts) — that is the key every existing reader
 * passes as `orgId`. §3.2's backward-compatibility argument ("an older build
 * excludes these rows and counts them in `excludedForTools`") only holds if the
 * older build actually READS them, so the rows go where it looks.
 */
export const ORG_HARNESS_SCOPE_KEY = 'default';

export const SKILL_HUB_ORIGIN = 'https://skills.altimedia.com';
export const ORG_HARNESS_MARKETPLACE_URL = `${SKILL_HUB_ORIGIN}/api/v1/marketplace.json`;
export const ORG_HARNESS_BOOTSTRAP_URL = `${SKILL_HUB_ORIGIN}/api/v1/harness/bootstrap`;
/** `X-Harness-Client` value (§3.7, appendix A3). */
export const ORG_HARNESS_CLIENT = 'naby';

/** `provenance.origin` prefix of a live org row; the version follows. */
export const ORG_HARNESS_ORIGIN_PREFIX = `org:${ORG_HARNESS_PACKAGE}@`;
/** `provenance.origin` prefix of a row whose skill a later version dropped (§3.2).
 *  Distinct from a user's tombstone, which keeps its `org:` origin. */
export const ORG_WITHDRAWN_ORIGIN_PREFIX = `org-withdrawn:${ORG_HARNESS_PACKAGE}@`;
/** `provenance.supersededBy` on a user/project copy set aside for the org version. */
export const ORG_SUPERSEDED_BY = `org:${ORG_HARNESS_PACKAGE}`;
/** Every org skill needs the loader (M2) and a shell (its scripts are Python). */
export const ORG_SKILL_TOOL_REFS: readonly string[] = ['naby_skill_load', 'run_command'];

/** Env kill switch (§4.8). `0` turns the whole org harness off. */
export const ORG_HARNESS_ENV_SWITCH = 'NABY_ORG_HARNESS';

const PACKAGE_MARKER = '.naby-package.json';
const POINTER_FILE = 'current.json';
const STAGING_PREFIX = '.staging-';
const TRASH_PREFIX = '.trash-';
/** A staging directory older than this is a crashed run's leftover. */
const STALE_STAGING_MS = 10 * 60 * 1000;
const MARKETPLACE_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const BOOTSTRAP_TIMEOUT_MS = 8_000;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

// -- settings keys (all under harness.org.*, §4.1) ----------------------------

export const ORG_HARNESS_SETTING = {
  /** User toggle (§4.8). Absent/anything but 'false' = on. */
  enabled: 'harness.org.enabled',
  /** JSON {keyHash, day, status, checkedAt} — the last activation answer. */
  activation: 'harness.org.activation',
  /** The bootstrap's HARNESS_METRICS_TOKEN (§3.6). Never returned by any reader. */
  metricsToken: 'harness.org.metricsToken',
  /** JSON fingerprint of what the rows were last reconciled against. */
  applied: 'harness.org.applied',
  /** JSON [{name, scope, scopeKey, itemId, copy}] — pending §4.5 notices. */
  copyNotices: 'harness.org.copyNotices',
  /** JSON [itemId] — copies the switch re-enabled while off (§4.8). */
  restoredCopies: 'harness.org.restoredCopies',
  /** JSON {at, outcome, version?, detail?} — the last package check. */
  lastSync: 'harness.org.lastSync',
  /** JSON OrgUpdateNotice — the latest version change and whether the user was
   *  told (§3.1 "silent update, one notice per version"). */
  updateNotice: 'harness.org.updateNotice',
  /** JSON OrgUpdateLogEntry[] — recent version changes with the hooks each one
   *  added that wait for a naby release (§3.5), newest first, capped. */
  updateLog: 'harness.org.updateLog',
} as const;

export function orgHarnessAutoStatusKey(name: string): string {
  return `harness.org.${name}.autoStatus`;
}
export function orgHarnessKeepUserCopyKey(name: string): string {
  return `harness.org.${name}.keepUserCopy`;
}
/** The status a withdrawn row had, so a revival restores exactly that (§3.2). */
export function orgHarnessWithdrawnFromKey(name: string): string {
  return `harness.org.${name}.withdrawnFrom`;
}

export function orgHarnessOrigin(version: string): string {
  return `${ORG_HARNESS_ORIGIN_PREFIX}${version}`;
}
export function orgHarnessWithdrawnOrigin(version: string): string {
  return `${ORG_WITHDRAWN_ORIGIN_PREFIX}${version}`;
}

/** Where every version of the package lives under a naby home. */
export function orgHarnessRoot(home: string): string {
  return join(home, 'org', ORG_HARNESS_PACKAGE);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** First 16 hex chars of sha256(key) — the same handle activate.js keeps, so a
 *  key change is detectable without storing the key a second time. */
export function orgHarnessKeyHash(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** The KST calendar day (YYYY-MM-DD) Skill Hub counts daily users by (§3.6). */
export function kstDay(ms: number): string {
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function sha256Hex(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** A version string that is safe as ONE path segment. */
export function isSafeVersion(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(v) &&
    !v.includes('..')
  );
}

function isSafeSkillName(v: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v) && !v.includes('..');
}

function readJsonSetting<T>(store: Pick<Store, 'getSetting'>, key: string): T | undefined {
  const raw = store.getSetting(key)?.trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

/** Write only when the value differs — a no-op rerun must leave settings alone. */
function setSettingIfChanged(store: Pick<Store, 'getSetting' | 'setSetting'>, key: string, value: string): boolean {
  // Absent and blank are the same value ("blank means absent" convention), so
  // clearing a key that was never written writes nothing.
  const current = store.getSetting(key) ?? '';
  if (current === value) return false;
  store.setSetting(key, value);
  return true;
}

function normalizeBody(s: string): string {
  return s.replace(/\r\n/g, '\n').trim();
}

/** The one-paragraph description an org row carries instead of a body (§3.2). */
export function descriptionParagraph(description: string | undefined, name: string): string {
  const para = (description ?? '').replace(/\s+/g, ' ').trim();
  return para.length > 0 ? para : `${name} (${ORG_HARNESS_PACKAGE}, loaded on demand)`;
}

// ---------------------------------------------------------------------------
// SKILL.md frontmatter — just enough YAML for `name` and `description`
// ---------------------------------------------------------------------------
//
// The runtime bundle carries no YAML library (the shell's importer uses
// js-yaml). The package's frontmatter uses three scalar forms — plain, single-
// quoted (ctx), and in principle double-quoted or block — and this reads those.
// Anything it cannot read yields no description, and the row falls back to a
// generic one rather than failing the package.

export function parseSkillFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const text = raw.replace(/^\uFEFF/, '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { data: {}, body: text };
  const lines = m[1]!.split(/\r?\n/);
  const data: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const km = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!km) {
      i += 1;
      continue;
    }
    const key = km[1]!;
    let rest = km[2]!;
    i += 1;
    const continuation = (): string[] => {
      const out: string[] = [];
      while (i < lines.length && (/^[ \t]/.test(lines[i]!) || lines[i]!.trim() === '')) {
        out.push(lines[i]!);
        i += 1;
      }
      while (out.length > 0 && out[out.length - 1]!.trim() === '') out.pop();
      return out;
    };
    if (rest.startsWith("'") || rest.startsWith('"')) {
      const q = rest[0]!;
      let acc = rest.slice(1);
      // Collect lines until the closing quote (folded with single spaces).
      const closes = (s: string): number => {
        if (q === "'") {
          for (let k = 0; k < s.length; k++) {
            if (s[k] === "'") {
              if (s[k + 1] === "'") {
                k += 1;
                continue;
              }
              return k;
            }
          }
          return -1;
        }
        for (let k = 0; k < s.length; k++) {
          if (s[k] === '\\') {
            k += 1;
            continue;
          }
          if (s[k] === '"') return k;
        }
        return -1;
      };
      let end = closes(acc);
      while (end < 0 && i < lines.length) {
        acc += ' ' + lines[i]!.trim();
        i += 1;
        end = closes(acc);
      }
      const inner = end >= 0 ? acc.slice(0, end) : acc;
      data[key] =
        q === "'"
          ? inner.replace(/''/g, "'")
          : inner.replace(/\\(["\\nt])/g, (_s, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
      continue;
    }
    if (/^[>|][+-]?$/.test(rest.trim())) {
      const folded = rest.trim().startsWith('>');
      const block = continuation().map((l) => l.trim());
      data[key] = folded ? block.join(' ').replace(/\s+/g, ' ').trim() : block.join('\n');
      continue;
    }
    const more = continuation().map((l) => l.trim());
    rest = [rest, ...more].join(' ').trim();
    data[key] = rest;
  }
  return { data, body: text.slice(m[0].length) };
}

// ---------------------------------------------------------------------------
// The package on disk
// ---------------------------------------------------------------------------

type PackagePointer = { version: string; sha256: string; previous?: string; flippedAt: number };
type PackageMarker = { name: string; version: string; sha256: string; extractedAt: number };

export type OrgPackageSkill = {
  name: string;
  description?: string;
  /** Absolute skill folder. */
  dir: string;
  /** SKILL.md body (frontmatter stripped). Read now so §4.5 can compare copies. */
  body: string;
};

export type OrgPackage = {
  version: string;
  sha256: string;
  /** Absolute package root (`<home>/org/altimedia-harness/<version>`). */
  dir: string;
  skills: OrgPackageSkill[];
};

function readPointer(root: string): PackagePointer | undefined {
  try {
    const p = JSON.parse(readFileSync(join(root, POINTER_FILE), 'utf8')) as PackagePointer;
    if (!isSafeVersion(p.version) || typeof p.sha256 !== 'string') return undefined;
    return p;
  } catch {
    return undefined;
  }
}

function readMarker(dir: string): PackageMarker | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, PACKAGE_MARKER), 'utf8')) as PackageMarker;
  } catch {
    return undefined;
  }
}

function readPackageSkills(dir: string): OrgPackageSkill[] {
  const skillsDir = join(dir, 'skills');
  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return [];
  }
  const out: OrgPackageSkill[] = [];
  for (const folder of entries.sort()) {
    const skillDir = join(skillsDir, folder);
    let raw: string;
    try {
      if (!statSync(skillDir).isDirectory()) continue;
      raw = readFileSync(join(skillDir, 'SKILL.md'), 'utf8');
    } catch {
      continue;
    }
    const { data, body } = parseSkillFrontmatter(raw);
    const name = (data.name ?? '').trim() || folder;
    if (!isSafeSkillName(name)) continue;
    out.push({
      name,
      ...(data.description ? { description: data.description } : {}),
      dir: skillDir,
      body: normalizeBody(body),
    });
  }
  return out;
}

/**
 * The package the `current` pointer names, if it is complete. Never throws.
 *
 * "Complete" means the version folder exists and carries the marker written as
 * the LAST step of extraction, with the same sha256 the pointer records. A
 * half-extracted version never has a marker — and never has a pointer either,
 * because the pointer is flipped after the rename — so this cannot return one.
 */
export function readCurrentOrgPackage(home: string): OrgPackage | undefined {
  const root = orgHarnessRoot(home);
  const ptr = readPointer(root);
  if (!ptr) return undefined;
  const dir = join(root, ptr.version);
  const marker = readMarker(dir);
  if (!marker || marker.sha256 !== ptr.sha256 || marker.version !== ptr.version) return undefined;
  return { version: ptr.version, sha256: ptr.sha256, dir, skills: readPackageSkills(dir) };
}

/** The `current` version, checked the same way as `readCurrentOrgPackage` but
 *  without reading any skill — for callers that poll (the chat status bar). */
export function currentOrgPackageVersion(home: string): string | undefined {
  const root = orgHarnessRoot(home);
  const ptr = readPointer(root);
  if (!ptr) return undefined;
  const marker = readMarker(join(root, ptr.version));
  if (!marker || marker.sha256 !== ptr.sha256 || marker.version !== ptr.version) return undefined;
  return ptr.version;
}

/** Versions present on disk (complete or not) — for spikes and diagnostics. */
export function listOrgPackageVersions(home: string): string[] {
  const root = orgHarnessRoot(home);
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && isSafeVersion(d.name) && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Fetching (§3.1, §3.6) — injectable so a spike never touches the network
// ---------------------------------------------------------------------------

export type OrgHarnessResponse = {
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
};
/** The subset of `fetch` this module uses. The global `fetch` satisfies it. */
export type OrgHarnessFetch = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<OrgHarnessResponse>;

export type OrgPackageSyncOutcome =
  /** A new version was extracted and is now current. */
  | 'updated'
  /** The marketplace version is already current. Nothing was written. */
  | 'current'
  /** Marketplace or download unreachable / non-200. Nothing was written. */
  | 'unreachable'
  /** The marketplace has no usable altimedia-harness entry. */
  | 'no-plugin'
  /** The download's sha256 differs from the marketplace's. Discarded. */
  | 'integrity-mismatch'
  /** The zip failed to extract or is not this package. Discarded. */
  | 'invalid-package';

export type OrgPackageSyncResult = {
  outcome: OrgPackageSyncOutcome;
  /** The version now current (unchanged on every outcome but 'updated'). */
  current?: string;
  /** The version the marketplace offered, when it got that far. */
  offered?: string;
  /** On 'updated': the version that was current before the flip (absent on a
   *  first install). */
  previous?: string;
  detail?: string;
};

type MarketplaceEntry = { version: string; url: string; sha256: string };

function pickMarketplaceEntry(body: unknown, marketplaceUrl: string): MarketplaceEntry | string {
  const plugins = (body as { plugins?: unknown })?.plugins;
  if (!Array.isArray(plugins)) return 'marketplace has no plugins array';
  const entry = plugins.find(
    (p) => p && typeof p === 'object' && (p as { name?: unknown }).name === ORG_HARNESS_PACKAGE,
  ) as { version?: unknown; source?: { url?: unknown; sha256?: unknown } } | undefined;
  if (!entry) return `marketplace lists no ${ORG_HARNESS_PACKAGE}`;
  if (!isSafeVersion(entry.version)) return 'marketplace version is missing or unsafe';
  const rawUrl = entry.source?.url;
  const sha = entry.source?.sha256;
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return 'marketplace source.url is missing';
  if (typeof sha !== 'string' || !/^[0-9a-fA-F]{64}$/.test(sha)) return 'marketplace source.sha256 is missing';
  let resolved: URL;
  try {
    resolved = new URL(rawUrl, marketplaceUrl);
  } catch {
    return 'marketplace source.url does not parse';
  }
  // Same origin as the marketplace, or HTTPS. The digest comes from the
  // marketplace anyway; this only refuses a plain-HTTP detour to another host.
  const base = new URL(marketplaceUrl);
  if (resolved.origin !== base.origin && resolved.protocol !== 'https:') {
    return 'marketplace source.url is neither same-origin nor https';
  }
  return { version: entry.version, url: resolved.toString(), sha256: sha.toLowerCase() };
}

// ---------------------------------------------------------------------------
// Package folders in use (§4.7, M4) — the GC must never pull a folder out from
// under a turn or a hook that is still running on it
// ---------------------------------------------------------------------------
//
// THE PROBLEM. The sync keeps `current` and ONE previous version (§3.1). That is
// enough while at most one new version lands per turn. It is not enough when two
// land during one long turn (an autonomous run, a slow hook): v1 pinned → v2
// arrives (v1 kept as previous) → v3 arrives (v2 previous) → v1 deleted while the
// turn — and the hooks it spawned, which read `${CLAUDE_PLUGIN_ROOT}` files after
// they start — still run from it.
//
// THE RULE. Whoever runs from a package folder holds a LEASE on it: the turn pin
// (`pinOrgHarnessTurn`) for the whole run, and the hook runner for the lifetime
// of each hook process. The GC keeps every leased folder on top of current +
// previous, and remembers that it skipped one; when the last lease on a folder is
// released, the deferred collection runs then. "Only one previous" is restored as
// soon as nothing needs the older folder.
//
// A LEASE CANNOT PIN FOREVER. A turn that throws before its `finally`, or a
// process that dies, would otherwise keep a folder on disk for the life of the
// app. A lease older than `ORG_PACKAGE_LEASE_MAX_AGE_MS` no longer protects its
// folder — far longer than any turn or hook runs.
//
// PROCESS-WIDE, NOT MODULE-WIDE. The registry rides `globalThis` under a
// `Symbol.for` key: the Next server bundles its own copy of this runtime (the
// same reason the quit hook does, org-harness-hooks.ts), and a turn pinned
// through one copy must be visible to a sync running through the other.

/** A lease older than this no longer keeps its folder (a leak guard, not a
 *  timeout: nothing is stopped when it passes). */
export const ORG_PACKAGE_LEASE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type LeaseRegistry = {
  /** normalized package dir → lease id → leased-at (epoch ms) */
  leases: Map<string, Map<number, number>>;
  /** package roots whose GC skipped a leased folder; collected on release */
  deferred: Set<string>;
  nextId: number;
};

const LEASE_KEY = Symbol.for('naby.orgHarness.packageLeases');

function leaseRegistry(): LeaseRegistry {
  const host = globalThis as unknown as Record<symbol, LeaseRegistry | undefined>;
  let reg = host[LEASE_KEY];
  if (!reg) {
    reg = { leases: new Map(), deferred: new Set(), nextId: 1 };
    host[LEASE_KEY] = reg;
  }
  return reg;
}

const FOLD_CASE = process.platform === 'darwin' || process.platform === 'win32';

function leaseKey(dir: string): string {
  const r = resolve(dir);
  return FOLD_CASE ? r.toLowerCase() : r;
}

/**
 * Hold a package folder for as long as something runs from it. Returns the
 * release function (idempotent). Releasing the last lease on a folder the GC
 * had to skip runs the deferred collection for its package root. Never throws.
 */
export function leaseOrgPackageDir(dir: string, now: () => number = Date.now): () => void {
  const reg = leaseRegistry();
  const key = leaseKey(dir);
  const id = reg.nextId++;
  let byId = reg.leases.get(key);
  if (!byId) {
    byId = new Map();
    reg.leases.set(key, byId);
  }
  byId.set(id, now());
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const m = reg.leases.get(key);
    if (!m) return;
    m.delete(id);
    if (m.size > 0) return;
    reg.leases.delete(key);
    const root = dirname(key);
    if (!reg.deferred.has(root)) return;
    try {
      collectOrgPackageRoot(root, Date.now());
    } catch {
      /* best effort; the next sync collects */
    }
  };
}

/** Version folder names under `root` that hold a live lease right now. */
function leasedVersions(root: string, now: number): Set<string> {
  const reg = leaseRegistry();
  const rootKey = leaseKey(root);
  const out = new Set<string>();
  for (const [key, byId] of reg.leases) {
    if (dirname(key) !== rootKey) continue;
    let live = false;
    for (const at of byId.values()) {
      if (now - at < ORG_PACKAGE_LEASE_MAX_AGE_MS) {
        live = true;
        break;
      }
    }
    if (live) out.add(basename(key));
  }
  return out;
}

/** Package folders (absolute, normalized) currently leased — spikes, diagnostics. */
export function leasedOrgPackageDirs(now: number = Date.now()): string[] {
  const out: string[] = [];
  for (const [key, byId] of leaseRegistry().leases) {
    if ([...byId.values()].some((at) => now - at < ORG_PACKAGE_LEASE_MAX_AGE_MS)) out.push(key);
  }
  return out.sort();
}

/**
 * The GC of one package root: keep `current`, the one previous version, and
 * every leased folder; delete the rest (and crashed runs' leftovers). Records
 * whether a leased folder was all that kept something alive, so the release of
 * that lease finishes the job.
 */
function collectOrgPackageRoot(root: string, now: number): void {
  const ptr = readPointer(root);
  const keep = new Set<string>();
  if (ptr) {
    keep.add(ptr.version);
    if (ptr.previous) keep.add(ptr.previous);
  }
  const leased = leasedVersions(root, now);
  const reg = leaseRegistry();
  const rootKey = leaseKey(root);
  let deferred = false;
  for (const v of leased) {
    if (FOLD_CASE ? [...keep].some((k) => k.toLowerCase() === v) : keep.has(v)) continue;
    deferred = true;
  }
  if (deferred) reg.deferred.add(rootKey);
  else reg.deferred.delete(rootKey);
  if (!ptr) return; // never delete versions without knowing which one is current
  cleanupLeftovers(root, keep, now, leased);
}

/** Run the package GC for a naby home now (spikes; the sync calls it itself). */
export function collectOrgHarnessGarbage(home: string, now: number = Date.now()): void {
  collectOrgPackageRoot(orgHarnessRoot(home), now);
}

/** Spikes: forget every lease. */
export function resetOrgPackageLeasesForTests(): void {
  const reg = leaseRegistry();
  reg.leases.clear();
  reg.deferred.clear();
}

function cleanupLeftovers(
  root: string,
  keep: ReadonlySet<string>,
  now: number,
  leased: ReadonlySet<string> = new Set(),
): void {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === POINTER_FILE || keep.has(name)) continue;
    if (leased.has(FOLD_CASE ? name.toLowerCase() : name)) continue;
    const full = join(root, name);
    if (name.startsWith(STAGING_PREFIX)) {
      // A staging dir younger than this may belong to a sync running right now
      // (another process); an old one is a crashed run's leftover.
      try {
        if (now - statSync(full).mtimeMs < STALE_STAGING_MS) continue;
      } catch {
        continue;
      }
    }
    if (name.endsWith('.tmp')) {
      try {
        rmSync(full, { force: true });
      } catch {
        /* next sync */
      }
      continue;
    }
    try {
      rmSync(full, { recursive: true, force: true });
    } catch {
      /* best effort; the next sync tries again */
    }
  }
}

/** Find the package root inside a fresh extraction: the top, or a single wrapping
 *  folder that holds `.claude-plugin/plugin.json`. */
function locatePackageRoot(staging: string): string | undefined {
  if (existsSync(join(staging, '.claude-plugin', 'plugin.json'))) return staging;
  let names: string[];
  try {
    names = readdirSync(staging).filter((n) => !n.startsWith('__MACOSX'));
  } catch {
    return undefined;
  }
  if (names.length !== 1) return undefined;
  const inner = join(staging, names[0]!);
  return existsSync(join(inner, '.claude-plugin', 'plugin.json')) ? inner : undefined;
}

const inflightSync = new Map<string, Promise<OrgPackageSyncResult>>();

/**
 * Check the marketplace and, if a new version is offered, download, verify,
 * extract and flip `current` to it (§3.1). Never throws. Single-flight per home
 * within a process.
 *
 * THE ORDER IS THE GUARANTEE.
 *   1. Download into memory. Nothing on disk yet.
 *   2. sha256 must match the marketplace. Mismatch ⇒ discard, write nothing.
 *   3. Extract into `.staging-<random>` (never the live folder). Any error ⇒
 *      delete staging, keep `current` as it was.
 *   4. Write the completeness marker inside staging, then rename staging to
 *      `<version>`. A crash before the rename leaves only a stale staging dir.
 *   5. Write `current.json.tmp`, rename it over `current.json` — atomic. A crash
 *      before this leaves `current` on the old version.
 *   6. Delete everything but `current` and the one previous version.
 */
export function syncOrgHarnessPackage(args: {
  home: string;
  fetch: OrgHarnessFetch;
  marketplaceUrl?: string;
  now?: () => number;
}): Promise<OrgPackageSyncResult> {
  const key = orgHarnessRoot(args.home);
  const running = inflightSync.get(key);
  if (running) return running;
  const p = syncOnce(args).finally(() => inflightSync.delete(key));
  inflightSync.set(key, p);
  return p;
}

async function syncOnce(args: {
  home: string;
  fetch: OrgHarnessFetch;
  marketplaceUrl?: string;
  now?: () => number;
}): Promise<OrgPackageSyncResult> {
  const now = args.now ?? Date.now;
  const marketplaceUrl = args.marketplaceUrl ?? ORG_HARNESS_MARKETPLACE_URL;
  const root = orgHarnessRoot(args.home);
  const before = readPointer(root);
  const current = before?.version;
  const base = (r: Omit<OrgPackageSyncResult, 'current'>): OrgPackageSyncResult => ({
    ...r,
    ...(current ? { current } : {}),
  });

  // 1. Marketplace.
  let manifest: unknown;
  try {
    const res = await args.fetch(marketplaceUrl, { signal: AbortSignal.timeout(MARKETPLACE_TIMEOUT_MS) });
    if (res.status !== 200) return base({ outcome: 'unreachable', detail: `marketplace HTTP ${res.status}` });
    manifest = await res.json();
  } catch (e) {
    return base({ outcome: 'unreachable', detail: `marketplace: ${e instanceof Error ? e.message : String(e)}` });
  }
  const entry = pickMarketplaceEntry(manifest, marketplaceUrl);
  if (typeof entry === 'string') return base({ outcome: 'no-plugin', detail: entry });

  // Already current, and the folder is intact: the rerun is a no-op.
  if (before && before.version === entry.version && before.sha256 === entry.sha256) {
    const marker = readMarker(join(root, entry.version));
    if (marker && marker.sha256 === entry.sha256) {
      return base({ outcome: 'current', offered: entry.version });
    }
  }

  // 2. Download + integrity.
  let bytes: Buffer;
  try {
    const res = await args.fetch(entry.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (res.status !== 200) {
      return base({ outcome: 'unreachable', offered: entry.version, detail: `download HTTP ${res.status}` });
    }
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return base({
      outcome: 'unreachable',
      offered: entry.version,
      detail: `download: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  if (bytes.length > MAX_DOWNLOAD_BYTES) {
    return base({ outcome: 'invalid-package', offered: entry.version, detail: `download is ${bytes.length} bytes` });
  }
  const digest = sha256Hex(bytes);
  if (digest !== entry.sha256) {
    return base({
      outcome: 'integrity-mismatch',
      offered: entry.version,
      detail: `sha256 ${digest} != marketplace ${entry.sha256}`,
    });
  }

  // 3. Extract into staging.
  try {
    mkdirSync(root, { recursive: true });
  } catch (e) {
    return base({ outcome: 'invalid-package', offered: entry.version, detail: `mkdir: ${String(e)}` });
  }
  const staging = join(root, `${STAGING_PREFIX}${entry.version}-${process.pid}-${randomBytes(4).toString('hex')}`);
  const discard = (detail: string): OrgPackageSyncResult => {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      /* the cleanup pass on the next sync gets it */
    }
    return base({ outcome: 'invalid-package', offered: entry.version, detail });
  };
  try {
    extractZip(bytes, staging);
  } catch (e) {
    return discard(e instanceof ZipError ? `${e.code}: ${e.message}` : `extract: ${String(e)}`);
  }
  const pkgRoot = locatePackageRoot(staging);
  if (!pkgRoot) return discard('no .claude-plugin/plugin.json in the archive');
  try {
    const plugin = JSON.parse(readFileSync(join(pkgRoot, '.claude-plugin', 'plugin.json'), 'utf8')) as {
      name?: unknown;
    };
    if (plugin.name !== undefined && plugin.name !== ORG_HARNESS_PACKAGE) {
      return discard(`plugin.json names "${String(plugin.name)}"`);
    }
  } catch (e) {
    return discard(`plugin.json: ${String(e)}`);
  }

  // 4. Marker, then rename into place.
  const finalDir = join(root, entry.version);
  try {
    const marker: PackageMarker = {
      name: ORG_HARNESS_PACKAGE,
      version: entry.version,
      sha256: entry.sha256,
      extractedAt: now(),
    };
    writeFileSync(join(pkgRoot, PACKAGE_MARKER), JSON.stringify(marker));
    if (existsSync(finalDir)) {
      // Same version string, different bytes (a re-publish), or a folder some
      // earlier run left without a marker. Move it aside rather than merging.
      renameSync(finalDir, join(root, `${TRASH_PREFIX}${entry.version}-${randomBytes(4).toString('hex')}`));
    }
    renameSync(pkgRoot, finalDir);
  } catch (e) {
    return discard(`install: ${String(e)}`);
  }
  if (pkgRoot !== staging) {
    try {
      rmSync(staging, { recursive: true, force: true });
    } catch {
      /* leftover wrapper dir; cleaned next time */
    }
  }

  // 5. Flip `current` atomically.
  const previous =
    before && before.version !== entry.version ? before.version : before?.previous;
  const pointer: PackagePointer = {
    version: entry.version,
    sha256: entry.sha256,
    ...(previous && previous !== entry.version ? { previous } : {}),
    flippedAt: now(),
  };
  try {
    const tmp = join(root, `${POINTER_FILE}.${randomBytes(4).toString('hex')}.tmp`);
    writeFileSync(tmp, JSON.stringify(pointer));
    renameSync(tmp, join(root, POINTER_FILE));
  } catch (e) {
    // The new folder exists but `current` still names the old one: the old
    // version keeps running, and the next sync finds the marker and flips.
    return base({ outcome: 'invalid-package', offered: entry.version, detail: `pointer: ${String(e)}` });
  }

  // 6. Keep current + one previous — and any folder a running turn or hook
  //    still leases (§4.7); that one goes when its last lease is released.
  collectOrgPackageRoot(root, now());
  return {
    outcome: 'updated',
    current: entry.version,
    offered: entry.version,
    ...(before?.version ? { previous: before.version } : {}),
  };
}

// ---------------------------------------------------------------------------
// Activation (§3.6) — replaces activate.js
// ---------------------------------------------------------------------------

export type OrgHarnessActivationRecord = {
  keyHash: string;
  day: string;
  status: 'ok' | 'unauthorized';
  checkedAt: number;
};

export type OrgHarnessActivationResult = {
  status:
    /** The key is valid; the metrics token is stored. */
    | 'ok'
    /** Skill Hub rejected the key (401/403). The org harness is off for it. */
    | 'unauthorized'
    /** Could not ask (offline, 5xx, 429, odd body). Not a failure (§3.6). */
    | 'unreachable';
  /** True when today's answer for this key was already on record. */
  cached: boolean;
};

/**
 * Prove the Skill Hub key once per KST day per key (§3.6).
 *
 * Mirrors activate.js on the parts that are protocol — the endpoint, the
 * Bearer header, the 200/401/other split, `env.HARNESS_METRICS_TOKEN`, the KST
 * day, the 16-hex key hash — and replaces the parts that were Claude Code
 * plumbing: the token goes to naby settings, never to
 * `~/.cache/altimedia-harness/activation.json`, and nothing touches
 * `~/.claude/settings.json`. Adds `X-Harness-Client: naby` (appendix A3).
 */
export async function checkOrgHarnessActivation(
  store: Pick<Store, 'getSetting' | 'setSetting'>,
  args: { apiKey: string; fetch: OrgHarnessFetch; now?: () => number; url?: string },
): Promise<OrgHarnessActivationResult> {
  const now = args.now ?? Date.now;
  const hash = orgHarnessKeyHash(args.apiKey);
  const today = kstDay(now());
  const rec = readJsonSetting<OrgHarnessActivationRecord>(store, ORG_HARNESS_SETTING.activation);
  if (rec && rec.keyHash === hash && rec.day === today) {
    return { status: rec.status, cached: true };
  }

  let status: number;
  let body: unknown = null;
  try {
    const res = await args.fetch(args.url ?? ORG_HARNESS_BOOTSTRAP_URL, {
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        'X-Harness-Client': ORG_HARNESS_CLIENT,
      },
      signal: AbortSignal.timeout(BOOTSTRAP_TIMEOUT_MS),
    });
    status = res.status;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
  } catch {
    return { status: 'unreachable', cached: false };
  }

  if (status === 200) {
    const token = (body as { env?: { HARNESS_METRICS_TOKEN?: unknown } } | null)?.env?.HARNESS_METRICS_TOKEN;
    // A 200 without a token is a server oddity, not a verdict on the key —
    // activate.js treats it the same way (retry next session).
    if (typeof token !== 'string' || token.length === 0) return { status: 'unreachable', cached: false };
    setSettingIfChanged(store, ORG_HARNESS_SETTING.metricsToken, token);
    const next: OrgHarnessActivationRecord = { keyHash: hash, day: today, status: 'ok', checkedAt: now() };
    store.setSetting(ORG_HARNESS_SETTING.activation, JSON.stringify(next));
    return { status: 'ok', cached: false };
  }
  if (status === 401 || status === 403) {
    setSettingIfChanged(store, ORG_HARNESS_SETTING.metricsToken, '');
    const next: OrgHarnessActivationRecord = {
      keyHash: hash,
      day: today,
      status: 'unauthorized',
      checkedAt: now(),
    };
    store.setSetting(ORG_HARNESS_SETTING.activation, JSON.stringify(next));
    return { status: 'unauthorized', cached: false };
  }
  return { status: 'unreachable', cached: false };
}

// ---------------------------------------------------------------------------
// Is the org harness on?
// ---------------------------------------------------------------------------

export type OrgHarnessOffReason = 'no-skill-hub' | 'env-off' | 'user-off' | 'unauthorized';

/** What every entry point needs from its caller. `apiKey` is the skill-hub
 *  preset's token, or undefined when no preset is configured (§4.3). */
export type OrgHarnessContext = {
  home: string;
  apiKey?: string;
  env?: Record<string, string | undefined>;
  userId?: string;
};

export function orgHarnessOnState(
  store: Pick<Store, 'getSetting'>,
  ctx: Pick<OrgHarnessContext, 'apiKey' | 'env'>,
): { on: true } | { on: false; reason: OrgHarnessOffReason } {
  if (!ctx.apiKey) return { on: false, reason: 'no-skill-hub' };
  if ((ctx.env?.[ORG_HARNESS_ENV_SWITCH] ?? '').trim() === '0') return { on: false, reason: 'env-off' };
  if ((store.getSetting(ORG_HARNESS_SETTING.enabled) ?? '').trim() === 'false') {
    return { on: false, reason: 'user-off' };
  }
  const rec = readJsonSetting<OrgHarnessActivationRecord>(store, ORG_HARNESS_SETTING.activation);
  if (rec && rec.status === 'unauthorized' && rec.keyHash === orgHarnessKeyHash(ctx.apiKey)) {
    return { on: false, reason: 'unauthorized' };
  }
  return { on: true };
}

// ---------------------------------------------------------------------------
// Rows (§3.2) and copies (§4.5), reconciled at a turn boundary
// ---------------------------------------------------------------------------

export type OrgHarnessStore = Pick<
  Store,
  | 'listHarness'
  | 'getHarnessItem'
  | 'putHarnessItem'
  | 'setHarnessEnabled'
  | 'setHarnessStatus'
  | 'getSetting'
  | 'setSetting'
  | 'listProjects'
>;

export type OrgCopyNotice = {
  name: string;
  scope: 'user' | 'project';
  scopeKey: string;
  itemId: string;
  /** Whether the copy's body matches the org package's (§4.5). In M1 the
   *  comparison is against the CURRENT package body only; 'unknown' when no
   *  package is on disk to compare with. */
  copy: 'unmodified' | 'edited' | 'unknown';
};

export type OrgHarnessApplyResult = {
  /** 'skipped' = nothing configured, nothing written. 'copies' = rows were up
   *  to date; only the copy reconciliation ran. 'full' = rows were reconciled. */
  ran: 'skipped' | 'copies' | 'full';
  on: boolean;
  offReason?: OrgHarnessOffReason;
  version?: string;
  added: string[];
  updated: string[];
  withdrawn: string[];
  revived: string[];
  /** Rows the automatic switch left alone because the user moved them. */
  userOwned: string[];
  /** Status changes made by the on/off transition. */
  switched: string[];
  notices: OrgCopyNotice[];
};

function orgRows(store: OrgHarnessStore): HarnessItem[] {
  return store.listHarness('org', ORG_HARNESS_SCOPE_KEY, { kind: 'skill' });
}

function isLiveOrgRow(row: HarnessItem): boolean {
  return (row.provenance.origin ?? '').startsWith(ORG_HARNESS_ORIGIN_PREFIX);
}
function isWithdrawnOrgRow(row: HarnessItem): boolean {
  return (row.provenance.origin ?? '').startsWith(ORG_WITHDRAWN_ORIGIN_PREFIX);
}

function orgSkillItem(skill: OrgPackageSkill, version: string): Omit<
  HarnessItem,
  'id' | 'createdAt' | 'updatedAt' | 'status'
> {
  const para = descriptionParagraph(skill.description, skill.name);
  return {
    scope: 'org',
    scopeKey: ORG_HARNESS_SCOPE_KEY,
    kind: 'skill',
    name: skill.name,
    description: para,
    provenance: {
      // 'artifact', not a new trust tier (§3.2): TrustTier is shared with memory.
      // What marks the row as org is the scope plus this verified origin.
      source: 'artifact',
      origin: orgHarnessOrigin(version),
      format: 'claude-skill-md',
    },
    skill: {
      // NO BODY. The description paragraph only; the body stays in the package
      // and is read by `naby_skill_load` (M2). With `naby_skill_load` in toolRefs a
      // build without that tool excludes this row and counts it (§3.2, §4.7).
      instructions: para,
      toolRefs: [...ORG_SKILL_TOOL_REFS],
      loadMode: 'on-demand',
      packageRef: ORG_HARNESS_PACKAGE,
    },
  };
}

function sameOrgContent(row: HarnessItem, want: ReturnType<typeof orgSkillItem>): boolean {
  const a = row.skill;
  const b = want.skill!;
  return (
    row.description === want.description &&
    row.provenance.origin === want.provenance.origin &&
    row.provenance.source === want.provenance.source &&
    row.provenance.format === want.provenance.format &&
    a !== undefined &&
    a.instructions === b.instructions &&
    JSON.stringify(a.toolRefs ?? []) === JSON.stringify(b.toolRefs ?? []) &&
    JSON.stringify(a.triggers ?? []) === JSON.stringify(b.triggers ?? []) &&
    a.loadMode === b.loadMode &&
    a.packageRef === b.packageRef
  );
}

function rowAsItem(row: HarnessItem): Omit<HarnessItem, 'id' | 'createdAt' | 'updatedAt' | 'status'> {
  const { id: _id, createdAt: _c, updatedAt: _u, status: _s, ...item } = row;
  return item;
}

/**
 * Set or clear `supersededBy` on a copy WITHOUT moving its status. Goes through
 * `putHarnessItem` as a refresh (same origin ⇒ the gate carries the status), and
 * re-asserts the status afterwards for a row the refresh rule cannot cover (one
 * with no origin).
 */
function patchSupersededBy(store: OrgHarnessStore, row: HarnessItem, value: string): void {
  const keep: HarnessStatus = row.status;
  const written = store.putHarnessItem({
    item: { ...rowAsItem(row), provenance: { ...row.provenance, supersededBy: value } },
    requestedStatus: keep === 'removed' ? 'disabled' : keep,
    refresh: true,
  });
  if (written.status !== keep) {
    if (keep === 'removed') store.setHarnessStatus(written.id, 'removed');
    else store.setHarnessEnabled(written.id, keep === 'enabled');
  }
}

/** The (scope, scopeKey) pairs a same-name copy can live in. */
function copyScopes(store: OrgHarnessStore, userId: string): { scope: 'user' | 'project'; scopeKey: string }[] {
  const out: { scope: 'user' | 'project'; scopeKey: string }[] = [{ scope: 'user', scopeKey: userId }];
  try {
    for (const p of store.listProjects()) out.push({ scope: 'project', scopeKey: p.cwd });
  } catch {
    /* no projects table in a minimal store */
  }
  return out;
}

function copyRows(store: OrgHarnessStore, userId: string): HarnessItem[] {
  const out: HarnessItem[] = [];
  for (const s of copyScopes(store, userId)) {
    out.push(...store.listHarness(s.scope, s.scopeKey, { kind: 'skill' }));
  }
  return out;
}

function noticesEqual(a: readonly OrgCopyNotice[], b: readonly OrgCopyNotice[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function readOrgCopyNotices(store: Pick<Store, 'getSetting'>): OrgCopyNotice[] {
  const v = readJsonSetting<OrgCopyNotice[]>(store, ORG_HARNESS_SETTING.copyNotices);
  return Array.isArray(v) ? v : [];
}

/**
 * The §4.5 / §4.8 half: same-name copies. Runs on EVERY apply (it is cheap and
 * the copies can change between package versions — the user installs a skill,
 * flips one, deletes one). Writes only when something actually changed.
 */
function reconcileCopies(
  store: OrgHarnessStore,
  on: boolean,
  pkg: OrgPackage | undefined,
  userId: string,
): OrgCopyNotice[] {
  const restored = readJsonSetting<string[]>(store, ORG_HARNESS_SETTING.restoredCopies) ?? [];
  let notices: OrgCopyNotice[] = [];

  if (!on) {
    // §4.8: give back every copy the user had set aside for the org version.
    const next = new Set(restored);
    for (const row of copyRows(store, userId)) {
      if (row.provenance.supersededBy === ORG_SUPERSEDED_BY && row.status === 'disabled') {
        store.setHarnessEnabled(row.id, true);
        next.add(row.id);
      }
    }
    const value = next.size > 0 ? JSON.stringify([...next].sort()) : '';
    setSettingIfChanged(store, ORG_HARNESS_SETTING.restoredCopies, value);
  } else {
    // Back on: set aside again exactly the copies the switch gave back.
    const restoredSet = new Set(restored);
    for (const id of restored) {
      const row = store.getHarnessItem(id);
      if (row && row.status === 'enabled' && row.provenance.supersededBy === ORG_SUPERSEDED_BY) {
        store.setHarnessEnabled(row.id, false);
      }
    }
    setSettingIfChanged(store, ORG_HARNESS_SETTING.restoredCopies, '');

    // A marked copy that is enabled and was NOT given back by the switch was
    // re-enabled by the user: "turning the copy back on returns it to how it
    // was" (§4.5). The marker goes, and the notice logic below sees it afresh.
    for (const row of copyRows(store, userId)) {
      if (
        row.provenance.supersededBy === ORG_SUPERSEDED_BY &&
        row.status === 'enabled' &&
        !restoredSet.has(row.id)
      ) {
        patchSupersededBy(store, row, '');
      }
    }

    const live = new Map<string, HarnessItem>();
    for (const row of orgRows(store)) {
      if (row.status === 'enabled' && isLiveOrgRow(row)) live.set(row.name, row);
    }
    const bodies = new Map((pkg?.skills ?? []).map((s) => [s.name, s.body] as const));
    for (const row of copyRows(store, userId)) {
      if (row.status !== 'enabled' || !live.has(row.name)) continue;
      if (row.provenance.supersededBy) continue;
      if ((store.getSetting(orgHarnessKeepUserCopyKey(row.name)) ?? '').trim() === 'true') continue;
      const orgBody = bodies.get(row.name);
      notices.push({
        name: row.name,
        scope: row.scope as 'user' | 'project',
        scopeKey: row.scopeKey,
        itemId: row.id,
        copy:
          orgBody === undefined
            ? 'unknown'
            : normalizeBody(row.skill?.instructions ?? '') === orgBody
              ? 'unmodified'
              : 'edited',
      });
    }
    notices = notices.sort((a, b) =>
      `${a.name}\0${a.scope}\0${a.scopeKey}`.localeCompare(`${b.name}\0${b.scope}\0${b.scopeKey}`),
    );
  }

  if (!noticesEqual(notices, readOrgCopyNotices(store))) {
    setSettingIfChanged(store, ORG_HARNESS_SETTING.copyNotices, notices.length > 0 ? JSON.stringify(notices) : '');
  }
  return notices;
}

function emptyResult(on: boolean): OrgHarnessApplyResult {
  return {
    ran: 'skipped',
    on,
    added: [],
    updated: [],
    withdrawn: [],
    revived: [],
    userOwned: [],
    switched: [],
    notices: [],
  };
}

/**
 * Bring the org rows and the same-name copies in line with the package on disk
 * and the on/off state. THE TURN-BOUNDARY ENTRY POINT (§4.2 step 3, §4.7): the
 * shell calls it before a turn assembles, and after a background sync when no
 * turn is running. Synchronous, idempotent, never throws for ordinary states.
 *
 * WHY "IF DUE". The rows only need work when the package or the switch changed,
 * so the reconciliation of rows is keyed by a fingerprint stored in
 * `harness.org.applied`; a turn where nothing changed reads one small file and a
 * few settings and writes nothing. Copies are reconciled every time, because
 * they change on the user's schedule, not the package's.
 *
 * WHY ROW WRITES ARE SAFE BETWEEN TWO TABS' TURNS. A turn reads its skill rows
 * once, when it assembles; nothing here reaches into a turn already running.
 * (M2 pins the package path per turn for the same reason; §4.7.)
 */
export function applyOrgHarnessIfDue(store: OrgHarnessStore, ctx: OrgHarnessContext): OrgHarnessApplyResult {
  const userId = ctx.userId ?? DEFAULT_USER_ID;
  const state = orgHarnessOnState(store, ctx);
  const rows = orgRows(store);

  // §4.3: no skill-hub preset and nothing ever installed ⇒ not one write.
  if (!ctx.apiKey && rows.length === 0) {
    return { ...emptyResult(false), offReason: 'no-skill-hub' };
  }

  const pkg = state.on ? readCurrentOrgPackage(ctx.home) : undefined;
  const fingerprint = JSON.stringify(
    state.on ? { on: true, version: pkg?.version ?? null, sha256: pkg?.sha256 ?? null } : { on: false },
  );
  const out = emptyResult(state.on);
  if (!state.on) out.offReason = state.reason;
  if (pkg) out.version = pkg.version;

  if ((store.getSetting(ORG_HARNESS_SETTING.applied) ?? '') !== fingerprint) {
    out.ran = 'full';
    // 1. The switch, through the shared auto-status rule. Only LIVE org rows: a
    //    tombstone is the user's, and a withdrawn row is dormant.
    for (const row of rows) {
      if (!isLiveOrgRow(row) || row.status === 'removed') continue;
      const r = applyAutoStatusTransition(store, row, orgHarnessAutoStatusKey(row.name), state.on);
      if (r === 'changed') out.switched.push(row.name);
      else if (r === 'userOwned') out.userOwned.push(row.name);
    }

    // 2. The package. Only when on AND a package is actually on disk — "no
    //    package" means "not downloaded yet", never "everything was withdrawn".
    if (state.on && pkg) {
      const byName = new Map(orgRows(store).map((r) => [r.name, r] as const));
      for (const skill of pkg.skills) {
        const want = orgSkillItem(skill, pkg.version);
        const row = byName.get(skill.name);
        if (!row) {
          store.putHarnessItem({ item: want, requestedStatus: 'enabled' });
          store.setSetting(orgHarnessAutoStatusKey(skill.name), 'enabled');
          out.added.push(skill.name);
          continue;
        }
        if (row.status === 'removed') {
          if (!isWithdrawnOrgRow(row)) continue; // the user deleted it: stays deleted
          const prior = store.getSetting(orgHarnessWithdrawnFromKey(skill.name))?.trim();
          const status: HarnessStatus = prior === 'disabled' ? 'disabled' : 'enabled';
          store.putHarnessItem({ item: want, requestedStatus: status });
          setSettingIfChanged(store, orgHarnessWithdrawnFromKey(skill.name), '');
          out.revived.push(skill.name);
          continue;
        }
        if (sameOrgContent(row, want)) continue;
        // New version: new description, new origin. The status is carried as it
        // is — a version bump is not an occasion to re-enable anything.
        store.putHarnessItem({ item: want, requestedStatus: row.status });
        out.updated.push(skill.name);
      }
      const offered = new Set(pkg.skills.map((s) => s.name));
      for (const row of orgRows(store)) {
        if (offered.has(row.name) || !isLiveOrgRow(row) || row.status === 'removed') continue;
        // Dropped by this version: tombstone it with a DIFFERENT origin, so it is
        // told apart from a user's delete and can come back (§3.2).
        const lastVersion = (row.provenance.origin ?? '').slice(ORG_HARNESS_ORIGIN_PREFIX.length) || pkg.version;
        store.setSetting(orgHarnessWithdrawnFromKey(row.name), row.status);
        const written = store.putHarnessItem({
          item: {
            ...rowAsItem(row),
            provenance: { ...row.provenance, origin: orgHarnessWithdrawnOrigin(lastVersion) },
          },
          requestedStatus: row.status,
        });
        store.setHarnessStatus(written.id, 'removed');
        out.withdrawn.push(row.name);
      }
    }
    store.setSetting(ORG_HARNESS_SETTING.applied, fingerprint);
  } else {
    out.ran = 'copies';
  }

  out.notices = reconcileCopies(store, state.on, pkg, userId);
  return out;
}

// ---------------------------------------------------------------------------
// The user's choices (§4.5, §4.8)
// ---------------------------------------------------------------------------

export type OrgHarnessActionResult =
  | { ok: true; changed: string[]; notices: OrgCopyNotice[] }
  | { ok: false; error: string };

/**
 * "Use the org version" for one skill name (§4.5): every ENABLED user/project
 * copy of that name is disabled and marked `supersededBy`. Files are not
 * touched. Turning a copy back on in Settings undoes it; so does the switch.
 */
export function useOrgVersion(
  store: OrgHarnessStore,
  name: string,
  ctx: OrgHarnessContext,
): OrgHarnessActionResult {
  const state = orgHarnessOnState(store, ctx);
  if (!state.on) return { ok: false, error: `the org harness is off (${state.reason})` };
  const org = orgRows(store).find((r) => r.name === name);
  if (!org || org.status === 'removed' || !isLiveOrgRow(org)) {
    return { ok: false, error: `no org skill named "${name}"` };
  }
  const userId = ctx.userId ?? DEFAULT_USER_ID;
  const changed: string[] = [];
  for (const row of copyRows(store, userId)) {
    if (row.name !== name || row.status !== 'enabled' || row.provenance.supersededBy) continue;
    patchSupersededBy(store, row, ORG_SUPERSEDED_BY);
    store.setHarnessEnabled(row.id, false);
    changed.push(row.id);
  }
  // Choosing the org version supersedes an earlier "keep mine".
  setSettingIfChanged(store, orgHarnessKeepUserCopyKey(name), '');
  const notices = reconcileCopies(store, true, readCurrentOrgPackage(ctx.home), userId);
  return { ok: true, changed, notices };
}

/** "Keep my copy" (§4.5): change nothing but remember the answer, so the notice
 *  stops. `useOrgVersion` remains available at any time. */
export function keepUserCopy(
  store: OrgHarnessStore,
  name: string,
  ctx: OrgHarnessContext,
): OrgHarnessActionResult {
  if (!isSafeSkillName(name)) return { ok: false, error: `invalid skill name "${name}"` };
  setSettingIfChanged(store, orgHarnessKeepUserCopyKey(name), 'true');
  const state = orgHarnessOnState(store, ctx);
  const notices = reconcileCopies(
    store,
    state.on,
    state.on ? readCurrentOrgPackage(ctx.home) : undefined,
    ctx.userId ?? DEFAULT_USER_ID,
  );
  return { ok: true, changed: [], notices };
}

/** The Settings toggle (§4.8). Applies immediately: the action runs outside any
 *  turn of the tab that clicked it, and row writes never reach a running turn. */
export function setOrgHarnessEnabled(
  store: OrgHarnessStore,
  enabled: boolean,
  ctx: OrgHarnessContext,
): OrgHarnessApplyResult {
  store.setSetting(ORG_HARNESS_SETTING.enabled, enabled ? 'true' : 'false');
  return applyOrgHarnessIfDue(store, ctx);
}

// ---------------------------------------------------------------------------
// The update notice (§3.1 "silent update", §3.5 "new hooks wait")
// ---------------------------------------------------------------------------
//
// A new version installs silently — the sync never asks. What the user gets is
// ONE notice per version, after the fact: "the org harness was updated to vX",
// plus a line when that version's hooks.json names scripts naby does not run yet
// (not on the allowlist, and not one of the three naby re-implements). Those
// hooks are installed with the package and simply wait for a naby release that
// reviews them (appendix A5).
//
//   ONCE ACROSS RESTARTS AND WINDOWS. The notice lives in `settings`; the popup
//   shows while `notifiedAt` is absent, and the ack writes it. Every window reads
//   the same row, so dismissing in one dismisses everywhere.
//
//   FIRST INSTALL IS QUIET. With no previous version there is nothing that was
//   "updated" — the Settings card already shows the version and the hooks naby
//   does not run. No notice, no log entry.
//
//   "NEW" IS AGAINST THE PREVIOUS VERSION. A waiting hook the previous version
//   already had was announced then. If the previous notice was never seen, its
//   waiting hooks that are still waiting carry over, so two quick updates do not
//   swallow the first one's line.
//
//   READ AGAINST THIS BUILD'S ALLOWLIST. A hook a later naby release allowlisted
//   no longer "waits"; readers filter, so an old notice never says otherwise.

export type OrgUpdateNotice = {
  version: string;
  /** The version before this one. */
  previous: string;
  /** Scripts this version added that wait for a naby release (§3.5). */
  newHooks: OrgHookScript[];
  detectedAt: number;
  /** When the user dismissed the popup; absent = still to be shown. */
  notifiedAt?: number;
};

export type OrgUpdateLogEntry = {
  version: string;
  previous: string;
  newHooks: OrgHookScript[];
  at: number;
};

/** How many version changes the Settings card keeps. */
export const ORG_UPDATE_LOG_MAX = 10;

function isHookList(v: unknown): v is OrgHookScript[] {
  return (
    Array.isArray(v) &&
    v.every(
      (h) =>
        h &&
        typeof (h as OrgHookScript).script === 'string' &&
        Array.isArray((h as OrgHookScript).events) &&
        (h as OrgHookScript).events.every((e) => typeof e === 'string'),
    )
  );
}

function stillWaiting(hooks: readonly OrgHookScript[]): OrgHookScript[] {
  return hooks.filter((h) => isOrgHookScriptWaiting(h.script));
}

/** The stored notice (seen or not), filtered against this build's allowlist. */
export function readOrgUpdateNotice(store: Pick<Store, 'getSetting'>): OrgUpdateNotice | undefined {
  const n = readJsonSetting<OrgUpdateNotice>(store, ORG_HARNESS_SETTING.updateNotice);
  if (!n || !isSafeVersion(n.version) || typeof n.previous !== 'string' || !isHookList(n.newHooks)) return undefined;
  return { ...n, newHooks: stillWaiting(n.newHooks) };
}

/** The notice the popup should show now, or undefined. */
export function pendingOrgUpdateNotice(store: Pick<Store, 'getSetting'>): OrgUpdateNotice | undefined {
  const n = readOrgUpdateNotice(store);
  return n && n.notifiedAt === undefined ? n : undefined;
}

/** Recent version changes, newest first, filtered against this build's allowlist. */
export function readOrgUpdateLog(store: Pick<Store, 'getSetting'>): OrgUpdateLogEntry[] {
  const log = readJsonSetting<OrgUpdateLogEntry[]>(store, ORG_HARNESS_SETTING.updateLog);
  if (!Array.isArray(log)) return [];
  return log
    .filter((e) => e && isSafeVersion(e.version) && typeof e.previous === 'string' && isHookList(e.newHooks))
    .map((e) => ({ ...e, newHooks: stillWaiting(e.newHooks) }));
}

/**
 * Record that `version` replaced `previous` (§3.1). Called by the sync right
 * after the `current` flip, while both folders are on disk. Returns the notice
 * written, or undefined when there is nothing to tell (first install, same
 * version re-published, or this version was already recorded). Never throws.
 */
export function recordOrgHarnessUpdate(
  store: Pick<Store, 'getSetting' | 'setSetting'>,
  args: {
    home: string;
    version: string;
    previous?: string;
    now?: () => number;
    log?: (line: string) => void;
  },
): OrgUpdateNotice | undefined {
  try {
    const { version, previous } = args;
    if (!previous || previous === version || !isSafeVersion(version) || !isSafeVersion(previous)) return undefined;
    const existing = readOrgUpdateNotice(store);
    if (existing && existing.version === version) return undefined;
    const root = orgHarnessRoot(args.home);
    const waitingNow = orgHookScriptsWaiting(join(root, version));
    const before = new Set(orgHookScriptsWaiting(join(root, previous)).map((h) => h.script));
    const added = waitingNow.filter((h) => !before.has(h.script));
    // An unseen notice is folded in: its hooks that still wait stay announced,
    // and "updated from" keeps naming the version the user last saw.
    const carried =
      existing && existing.notifiedAt === undefined
        ? waitingNow.filter((h) => existing.newHooks.some((o) => o.script === h.script))
        : [];
    const newHooks = [...added];
    for (const h of carried) if (!newHooks.some((x) => x.script === h.script)) newHooks.push(h);
    const at = (args.now ?? Date.now)();
    const notice: OrgUpdateNotice = {
      version,
      previous: existing && existing.notifiedAt === undefined ? existing.previous : previous,
      newHooks,
      detectedAt: at,
    };
    store.setSetting(ORG_HARNESS_SETTING.updateNotice, JSON.stringify(notice));
    const log = readOrgUpdateLog(store).filter((e) => e.version !== version);
    log.unshift({ version, previous, newHooks: added, at });
    store.setSetting(ORG_HARNESS_SETTING.updateLog, JSON.stringify(log.slice(0, ORG_UPDATE_LOG_MAX)));
    const say = args.log ?? ((line: string) => console.log(`[org-harness] ${line}`));
    say(`updated ${previous} -> ${version}`);
    if (added.length > 0) {
      say(
        `v${version} installs ${added.length} hook(s) naby does not run yet (waiting for a naby release): ` +
          added.map((h) => `${h.script} (${h.events.join(', ')})`).join('; '),
      );
    }
    return notice;
  } catch {
    return undefined;
  }
}

/**
 * The popup was dismissed (or "details" was chosen). Only the notice for
 * `version` is marked, so a stale window acking an older popup cannot hide a
 * newer one. True when something was written.
 */
export function ackOrgUpdateNotice(
  store: Pick<Store, 'getSetting' | 'setSetting'>,
  version: string,
  now: () => number = Date.now,
): boolean {
  const raw = readJsonSetting<OrgUpdateNotice>(store, ORG_HARNESS_SETTING.updateNotice);
  if (!raw || raw.version !== version || raw.notifiedAt !== undefined) return false;
  store.setSetting(ORG_HARNESS_SETTING.updateNotice, JSON.stringify({ ...raw, notifiedAt: now() }));
  return true;
}

// ---------------------------------------------------------------------------
// The whole background pass
// ---------------------------------------------------------------------------

export type OrgHarnessLastSync = {
  at: number;
  outcome: OrgPackageSyncOutcome | 'skipped';
  version?: string;
  detail?: string;
};

export type OrgHarnessSyncReport = {
  skipped?: OrgHarnessOffReason;
  activation?: OrgHarnessActivationResult;
  package?: OrgPackageSyncResult;
  /** Absent when `applyNow` was false (a turn was running); the next turn
   *  boundary applies instead. */
  apply?: OrgHarnessApplyResult;
  /** The update notice this pass recorded (a new version replaced an old one). */
  notice?: OrgUpdateNotice;
};

/**
 * One background pass: activation → package → rows (§4.2). What a boot calls
 * once, and what the six-hour re-check (`startOrgHarnessRecheck`) calls again.
 * Never throws.
 *
 * `applyNow: false` downloads and verifies but leaves the rows to the next turn
 * boundary (`applyOrgHarnessIfDue` from the engine), which is how "never in the
 * middle of a turn" is kept when a turn is in flight.
 */
export async function runOrgHarnessSync(
  store: OrgHarnessStore,
  ctx: OrgHarnessContext & {
    fetch: OrgHarnessFetch;
    now?: () => number;
    marketplaceUrl?: string;
    bootstrapUrl?: string;
    applyNow?: boolean;
  },
): Promise<OrgHarnessSyncReport> {
  const applyNow = ctx.applyNow ?? true;
  const apply = (): OrgHarnessApplyResult | undefined => (applyNow ? applyOrgHarnessIfDue(store, ctx) : undefined);
  try {
    const before = orgHarnessOnState(store, ctx);
    if (!before.on && before.reason !== 'unauthorized') {
      // No key, or switched off: no network at all. Off means off — Skill Hub does
      // not count a user who turned the org harness off as active today.
      const a = apply();
      return { skipped: before.reason, ...(a ? { apply: a } : {}) };
    }
    const activation = await checkOrgHarnessActivation(store, {
      apiKey: ctx.apiKey!,
      fetch: ctx.fetch,
      ...(ctx.now ? { now: ctx.now } : {}),
      ...(ctx.bootstrapUrl ? { url: ctx.bootstrapUrl } : {}),
    });
    if (activation.status === 'unauthorized') {
      const a = apply();
      return { skipped: 'unauthorized', activation, ...(a ? { apply: a } : {}) };
    }
    const pkg = await syncOrgHarnessPackage({
      home: ctx.home,
      fetch: ctx.fetch,
      ...(ctx.marketplaceUrl ? { marketplaceUrl: ctx.marketplaceUrl } : {}),
      ...(ctx.now ? { now: ctx.now } : {}),
    });
    const last: OrgHarnessLastSync = {
      at: (ctx.now ?? Date.now)(),
      outcome: pkg.outcome,
      ...(pkg.current ? { version: pkg.current } : {}),
      ...(pkg.detail ? { detail: pkg.detail } : {}),
    };
    store.setSetting(ORG_HARNESS_SETTING.lastSync, JSON.stringify(last));
    // Installed silently above; the one-per-version notice is recorded here, the
    // same place for the boot pass, the six-hour re-check and "check now".
    const notice =
      pkg.outcome === 'updated' && pkg.current
        ? recordOrgHarnessUpdate(store, {
            home: ctx.home,
            version: pkg.current,
            ...(pkg.previous ? { previous: pkg.previous } : {}),
            ...(ctx.now ? { now: ctx.now } : {}),
          })
        : undefined;
    const a = apply();
    return { activation, package: pkg, ...(notice ? { notice } : {}), ...(a ? { apply: a } : {}) };
  } catch (e) {
    // Belt and braces: every step above already turns failure into an outcome.
    return {
      package: { outcome: 'unreachable', detail: e instanceof Error ? e.message : String(e) },
    };
  }
}

// ---------------------------------------------------------------------------
// The six-hour re-check (§3.1, M4)
// ---------------------------------------------------------------------------
//
// "At app start and every 6 hours after" — the boot pass is the shell's
// (`ensureOrgHarnessSyncStarted`); this is the clock after it. One timer per
// process, owned by whoever calls `startOrgHarnessRecheck` (the shell, in the
// long-lived Next server realm that also runs the turns).
//
//   JITTERED. Every install opens the app around 9 a.m.; without jitter they
//   would all re-check together six hours later. Each wait is 6 h ± 15 min.
//
//   NEVER OVERLAPPING. The next wait starts after the current pass settles, so a
//   pass slower than the interval cannot stack up. The pass itself is the
//   shell's single-flight `syncOrgHarnessNow`, shared with the boot pass and the
//   "check now" button, so a tick that lands on a running pass joins it.
//
//   SKIPPABLE PER TICK. `shouldRun` is asked at every tick (the kill switch, the
//   Settings toggle and `NABY_ORG_HARNESS_SYNC=0` can all change while the app
//   runs). A skipped tick does no network and simply waits for the next one.
//
//   NEVER BLOCKING, NEVER FAILING. A pass that throws or rejects is logged and
//   the clock keeps going; the package on disk is whatever the last good pass
//   left (the sync never replaces it with something unverified). The timer is
//   unref'd, so it never keeps a process alive on its own.
//
// THE DAILY KEY CHECK (§3.6) RIDES THIS CLOCK. Each pass asks
// `checkOrgHarnessActivation`, which goes to the network only on the first pass
// of a new KST day for the key — so "once per day" holds for an app that is
// left running for days, not only for one that is restarted every morning.

export const ORG_HARNESS_RECHECK_MS = 6 * 60 * 60 * 1000;
export const ORG_HARNESS_RECHECK_JITTER_MS = 15 * 60 * 1000;

/** The next wait: `intervalMs` ± `jitterMs`, uniformly. Pure. */
export function orgHarnessRecheckDelay(
  random: () => number = Math.random,
  intervalMs: number = ORG_HARNESS_RECHECK_MS,
  jitterMs: number = ORG_HARNESS_RECHECK_JITTER_MS,
): number {
  const r = Math.min(Math.max(random(), 0), 1);
  return Math.max(1, Math.round(intervalMs + (r * 2 - 1) * jitterMs));
}

export type OrgHarnessRecheck = {
  stop(): void;
  /** Epoch ms of the next tick, or undefined after `stop()`. */
  readonly nextAt: number | undefined;
  /** Ticks so far: `ran` called the pass, `skipped` did not. */
  readonly stats: { ran: number; skipped: number; failed: number };
};

type TimerHandle = { unref?: () => unknown };

export function startOrgHarnessRecheck(args: {
  /** One pass. Awaited before the next wait starts. */
  run: () => Promise<unknown> | unknown;
  /** Asked at every tick; false skips that tick (no pass, no network). */
  shouldRun?: () => boolean;
  intervalMs?: number;
  jitterMs?: number;
  random?: () => number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (h: TimerHandle) => void;
  log?: (line: string) => void;
}): OrgHarnessRecheck {
  const setTimer = args.setTimer ?? ((fn, ms) => setTimeout(fn, ms) as unknown as TimerHandle);
  const clearTimer = args.clearTimer ?? ((h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>));
  const now = args.now ?? Date.now;
  const log = args.log ?? ((line: string) => console.log(`[org-harness] ${line}`));
  const stats = { ran: 0, skipped: 0, failed: 0 };
  let handle: TimerHandle | undefined;
  let nextAt: number | undefined;
  let stopped = false;

  const schedule = (): void => {
    if (stopped) return;
    const delay = orgHarnessRecheckDelay(args.random, args.intervalMs, args.jitterMs);
    nextAt = now() + delay;
    handle = setTimer(() => void tick(), delay);
    handle.unref?.();
  };

  const tick = async (): Promise<void> => {
    handle = undefined;
    if (stopped) return;
    let go = true;
    try {
      go = args.shouldRun ? args.shouldRun() : true;
    } catch {
      go = false;
    }
    if (!go) {
      stats.skipped += 1;
    } else {
      stats.ran += 1;
      try {
        await args.run();
      } catch (e) {
        stats.failed += 1;
        log(`re-check failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    schedule();
  };

  schedule();
  return {
    stop() {
      stopped = true;
      nextAt = undefined;
      if (handle) clearTimer(handle);
      handle = undefined;
    },
    get nextAt() {
      return nextAt;
    },
    stats,
  };
}

// ---------------------------------------------------------------------------
// What the UI may see — no key, no token
// ---------------------------------------------------------------------------

export type OrgHarnessState = {
  /** A skill-hub preset is configured (§4.3). */
  configured: boolean;
  on: boolean;
  offReason?: OrgHarnessOffReason;
  /** The Settings toggle's own value (§4.8). */
  enabledSetting: boolean;
  /** `NABY_ORG_HARNESS=0` is set. */
  envOff: boolean;
  /** Activation verdict for the CURRENT key: 'unknown' until checked. */
  auth: 'ok' | 'unauthorized' | 'unknown';
  package: { version: string; skills: string[] } | null;
  lastSync: OrgHarnessLastSync | null;
  rows: { name: string; status: HarnessStatus; origin: string; withdrawn: boolean }[];
  copyNotices: OrgCopyNotice[];
  keepUserCopy: string[];
  /** The latest version change (seen or not), §3.1. */
  updateNotice: OrgUpdateNotice | null;
  /** Recent version changes and the hooks each added that wait (§3.5). */
  updateLog: OrgUpdateLogEntry[];
};

/** The few fields a poller needs (the chat status bar): no rows, no skill
 *  bodies, no hooks.json. Same meanings as the matching `OrgHarnessState` fields. */
export type OrgHarnessStatus = Pick<OrgHarnessState, 'configured' | 'on' | 'offReason' | 'auth' | 'lastSync'> & {
  version?: string;
};

function orgHarnessAuth(store: Pick<Store, 'getSetting'>, ctx: OrgHarnessContext): OrgHarnessState['auth'] {
  const rec = readJsonSetting<OrgHarnessActivationRecord>(store, ORG_HARNESS_SETTING.activation);
  return ctx.apiKey && rec && rec.keyHash === orgHarnessKeyHash(ctx.apiKey) ? rec.status : 'unknown';
}

export function readOrgHarnessStatus(store: OrgHarnessStore, ctx: OrgHarnessContext): OrgHarnessStatus {
  const state = orgHarnessOnState(store, ctx);
  const version = currentOrgPackageVersion(ctx.home);
  return {
    configured: Boolean(ctx.apiKey),
    on: state.on,
    ...(state.on ? {} : { offReason: state.reason }),
    auth: orgHarnessAuth(store, ctx),
    lastSync: readJsonSetting<OrgHarnessLastSync>(store, ORG_HARNESS_SETTING.lastSync) ?? null,
    ...(version ? { version } : {}),
  };
}

export function readOrgHarnessState(store: OrgHarnessStore, ctx: OrgHarnessContext): OrgHarnessState {
  const state = orgHarnessOnState(store, ctx);
  const auth = orgHarnessAuth(store, ctx);
  const pkg = readCurrentOrgPackage(ctx.home);
  const rows = orgRows(store);
  const names = new Set<string>([...rows.map((r) => r.name), ...(pkg?.skills.map((s) => s.name) ?? [])]);
  return {
    configured: Boolean(ctx.apiKey),
    on: state.on,
    ...(state.on ? {} : { offReason: state.reason }),
    enabledSetting: (store.getSetting(ORG_HARNESS_SETTING.enabled) ?? '').trim() !== 'false',
    envOff: (ctx.env?.[ORG_HARNESS_ENV_SWITCH] ?? '').trim() === '0',
    auth,
    package: pkg ? { version: pkg.version, skills: pkg.skills.map((s) => s.name) } : null,
    lastSync: readJsonSetting<OrgHarnessLastSync>(store, ORG_HARNESS_SETTING.lastSync) ?? null,
    rows: rows.map((r) => ({
      name: r.name,
      status: r.status,
      origin: r.provenance.origin ?? '',
      withdrawn: isWithdrawnOrgRow(r),
    })),
    copyNotices: readOrgCopyNotices(store),
    keepUserCopy: [...names]
      .filter((n) => (store.getSetting(orgHarnessKeepUserCopyKey(n)) ?? '').trim() === 'true')
      .sort(),
    updateNotice: readOrgUpdateNotice(store) ?? null,
    updateLog: readOrgUpdateLog(store),
  };
}
