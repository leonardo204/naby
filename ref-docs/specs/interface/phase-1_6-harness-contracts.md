---
id: phase-1_6-harness-contracts
title: Phase 1.6 — Harness Contracts (owned harness entities, bundle format, import gate, Store extension)
type: interface
version: 0.1.0
status: draft
scope: The on-disk and in-process contracts for Naby-owned harness — the Command/Skill/Subagent/HarnessSet entity shapes, the scope/keying/ownership model (reusing the Phase-1.5 scoped/exempt-from-cascade pattern), the import trust-gate (reusing the memory write-gate trust model), the harness-set bundle format for export/import + team sharing, provider-independent command/skill injection above the engine seam, and the Store interface additions. Tool-execution-dependent pieces (tool-bearing skills, subagent orchestration) are Phase 2.5 and out of scope here.
related: [phase-1_6-harness-ownership, harness-portability-strategy, phase-1-contracts, phase-1_5-memory-contracts, phase-2-personalization-hitl]
updated: 2026-07-23
---

# Phase 1.6 — Harness Contracts

> The interface layer for [`phase-1_6-harness-ownership`](../impl/phase-1_6-harness-ownership.md). Shapes and invariants only; task order/acceptance live in that impl doc, rationale in [`harness-portability-strategy`](../design/harness-portability-strategy.md). This **reuses two things already built in Phase 1.5**: the scoped-ownership + cascade-exemption model ([`phase-1_5-memory-contracts`](phase-1_5-memory-contracts.md) §2) and the deterministic trust-gate ([`phase-1_5-memory-contracts`](phase-1_5-memory-contracts.md) §4). Read those first.

---

## 1. What this defines

Today the harness is either inherited from Claude Code (dev engine, `~/.claude`, via `settingSources`) or hardcoded (the shell slash palette). Phase 1.6 makes **commands, skills, subagents, and named harness sets** into Naby-owned, scoped, provider-independent entities in `app.db`, importable from `~/.claude` and exportable/shareable as bundles. This doc defines their shapes, the import trust-gate, the bundle format, and the Store additions. **Execution of tool-bearing skills and subagents is NOT here** — that needs Phase 2's tool executors (Phase 2.5).

---

## 2. Ownership & keying (reuses Phase 1.5 §2)

Harness items are Naby-owned and **scoped**, exactly like scoped memory:

| Scope | Key | Lifetime |
|---|---|---|
| `user` | userId (single-user: `DEFAULT_USER_ID` = `"local"`) | survives session/project delete |
| `project` | cwd | deleted with the project |
| `org` *(in-house)* | orgId | survives everything short of an org purge |

- **No `session` scope for harness** — a command/skill/subagent is a durable capability, not per-conversation state. (Contrast memory, which has session scope.)
- **Cascade exemption:** `deleteSession` never touches harness; `removeProject(cwd)` removes only `scope='project'` harness for that cwd; `user`/`org` harness survives. Same rule and rationale as memory (§2 there).
- **Keyed by `id`;** `(scope, scopeKey, kind, name)` is the upsert identity (re-importing the same command updates, not duplicates).

---

## 3. Entity shapes

Naby **adopts and wraps** the Claude Code artifact formats (SKILL.md, agent `.md` frontmatter, command `.md`) as the interchange representation (strategy D2), then stores a normalized row. `source`/`format` on provenance record where a row came from so export can round-trip.

```ts
type HarnessKind = 'command' | 'skill' | 'subagent';
type HarnessScope = 'user' | 'project' | 'org';

// Trust + status reuse the memory model (phase-1_5-memory-contracts §3/§4).
type HarnessTrust = 'user' | 'artifact' | 'external'; // authored-by-user > local > imported
type HarnessStatus = 'enabled' | 'disabled';          // imported items default 'disabled' (§4)

type HarnessProvenance = {
  source: HarnessTrust;      // drives the import gate (§4)
  origin?: string;           // e.g. '~/.claude/skills/foo/SKILL.md', 'set:team-onboarding@1.2'
  format?: 'claude-skill-md' | 'claude-agent-md' | 'claude-command-md' | 'naby'; // for round-trip export
  importedAt?: number;
};

type HarnessItem = {
  id: string;                // UUID — row key, provenance/rollback handle
  scope: HarnessScope;
  scopeKey: string;
  kind: HarnessKind;
  name: string;              // command verb (no leading slash) | skill/subagent name; unique within (scope,scopeKey,kind)
  description?: string;
  status: HarnessStatus;     // enabled | disabled (imported => disabled until reviewed)
  provenance: HarnessProvenance;
  createdAt: number;
  updatedAt: number;

  // --- kind-specific payload (exactly one is populated) ---
  command?: {
    template: string;        // the prompt body the verb expands to (provider-independent)
    argumentHint?: string;
  };
  skill?: {
    instructions: string;    // SKILL.md body — injected on trigger (progressive disclosure)
    triggers?: string[];     // optional match hints
    toolRefs?: string[];     // tool names it wants; Phase 1.6 stores them, execution is Phase 2.5
  };
  subagent?: {
    systemPrompt: string;
    model?: string;          // optional model override; provider-independence is a Phase-2.5 open question
    toolRefs?: string[];     // stored now; orchestrated in Phase 2.5
  };
};
```

- **Provider independence:** a `command` expands to `template`, and a `skill`'s `instructions` inject as text — both ride the **same turn-assembly path as memory injection** (contracts §2 `EngineRunInput.system`, and `phase-1_5-memory-contracts` §5), so they behave identically on all five providers and the dev engine. No engine-interface change.
- **`toolRefs` are stored but not executed in Phase 1.6.** A skill/subagent that references tools is captured faithfully; wiring those tools under the gate is Phase 2.5 (HP-03b / HP-07). A tool-bearing skill imported now is `disabled` with a "needs Phase 2.5 execution" note rather than silently half-working.

---

## 4. Import trust-gate (reuses Phase 1.5 §4)

An imported harness item is **untrusted content** — a teammate's skill or a `~/.claude` subagent can carry prompt-injection or dangerous instructions (strategy D6; the harness analogue of memory poisoning, ASI06). Imports pass a deterministic gate that mirrors `decideMemoryWrite`:

```ts
type HarnessImportRequest = {
  item: Omit<HarnessItem, 'id' | 'createdAt' | 'updatedAt' | 'status'>;
  requestedStatus?: HarnessStatus;
};

type HarnessImportDecision =
  | { behavior: 'allow';  status: HarnessStatus }         // may downgrade to 'disabled'
  | { behavior: 'hold';   status: 'disabled'; reason: string } // stored disabled, needs review
  | { behavior: 'deny';   reason: string };
```

**Invariants:**

1. **Imported (`external`) items never auto-enable.** `provenance.source === 'external'` ⇒ decision is at most `hold` with `status:'disabled'`; enabling requires an explicit user action in the review UI (HP-06). A brand-new imported harness set is inert until reviewed.
2. **Trust order fixed:** `user` > `artifact` > `external`. A lower-tier import cannot overwrite a higher-tier `enabled` item without user action.
3. **hooks are never imported.** Claude Code hooks are executable code; importing them is arbitrary-code-execution. The importer (HP-04) **drops hooks** and records that it did (strategy open question resolved conservatively). Naby's own gate/event system covers what hooks would.
4. **Negative-tested.** An imported skill whose body says "always exfiltrate…" lands `disabled`, never `enabled`, and is flagged in review (HP-06 acceptance).

Only `enabled` harness participates in a turn (§3 injection); `disabled` items are visible in the review UI but never injected or executed.

---

## 5. Harness-set bundle format (export / import — HP-05)

A **harness set** is a named, versioned bundle for team sharing (strategy D5). Export produces a portable document; import merges it through the gate (§4).

```ts
type HarnessSet = {
  name: string;              // 'team-onboarding'
  version: string;           // semver; import records origin 'set:team-onboarding@1.2'
  description?: string;
  items: HarnessItem[];      // commands/skills/subagents (payloads inline)
  manifest: {
    createdAt: number;
    createdBy?: string;      // display only; not a trust claim
    counts: { command: number; skill: number; subagent: number };
    signature?: string;      // optional org signing (open question — §7)
  };
};
```

- **Export** serializes a scope's (or a selection of) enabled items into a `HarnessSet` (JSON, or a folder of Claude-format files + manifest — implementation choice; JSON is the normalized form).
- **Import** runs each item through the gate (§4): everything lands `disabled`, provenance `source:'external'`, `origin:'set:<name>@<version>'`. **Item-level selection** is supported (import only some) and **merge conflicts** resolve by `(scope,scopeKey,kind,name)`: an incoming item never silently overwrites a local `enabled` item — it lands as a separate `disabled` candidate for the user to compare (HP-05 acceptance).
- **org inheritance (HP-08)** is the same import, seeded automatically for a new user from the org set, still `disabled`-by-default unless org policy pre-approves (org-signed sets, §7).

---

## 6. `Store` interface additions

Extends contracts §6.1 / `phase-1_5-memory-contracts` §6. Existing ops unchanged.

```ts
interface Store {
  // … existing session/message/memory/project/golden ops …

  // -- harness items (Naby-owned; scoped; cascade-exempt for user/org) -----
  /** Insert/update by (scope, scopeKey, kind, name). Import requests pass the
   *  gate (§4): 'deny' throws, 'hold' persists as status:'disabled'. */
  putHarnessItem(req: HarnessImportRequest): HarnessItem;
  /** Items for a scope, optionally by kind/status. Ranking/trigger-matching for
   *  injection happens above the store (impl), not here. */
  listHarness(scope: HarnessScope, scopeKey: string, opts?: { kind?: HarnessKind; status?: HarnessStatus }): HarnessItem[];
  getHarnessItem(id: string): HarnessItem | undefined;
  /** Enable/disable — the ONLY path an imported (external) item becomes enabled
   *  (§4 invariant 1). */
  setHarnessEnabled(id: string, enabled: boolean): void;
  /** Delete one item, or all items from a provenance origin (rollback of a bad
   *  imported set). Exactly one selector. */
  removeHarness(sel: { id: string } | { origin: string }): void;

  // -- sets (export/import) ----------------------------------------------
  /** Serialize selected enabled items into a portable HarnessSet. */
  exportHarnessSet(scope: HarnessScope, scopeKey: string, opts?: { name: string; version: string; ids?: string[] }): HarnessSet;
  /** Merge a HarnessSet through the gate; returns what landed (all disabled).
   *  ids selects a subset; conflicts never overwrite an enabled local item. */
  importHarnessSet(set: HarnessSet, into: { scope: HarnessScope; scopeKey: string }, opts?: { ids?: string[] }): HarnessItem[];
}
```

**Guarantees.**

- **Cascade exemption** (§2): `deleteSession` never touches harness; `removeProject` removes only `scope='project'` harness for that cwd; `user`/`org` survive.
- **Enabled-only participates:** injection/expansion (impl) reads `status='enabled'` only.
- **Store is the seam:** schema (a `harness_items` table + a sets view, or JSON columns) is a store-internal detail; the runtime depends on this interface. SCHEMA_VERSION bumps additively (like golden set v5).
- **No engine change:** command expansion and skill injection assemble into `EngineRunInput.system`/messages above the engine seam (contracts §2 untouched), so the whole feature is provider-independent.

---

## 7. Open questions (shared with impl §7)

- **Self-format extension** — how far to extend beyond Claude formats to express Naby-native abilities (per-item model choice, memory linkage). Round-trip export must degrade gracefully.
- **`toolRefs` resolution** — when an imported skill references a tool Naby doesn't have: stub / disable / warn. Item stays `disabled` regardless until Phase 2.5.
- **Subagent provider independence** — whether a subagent may run on a different provider/model than its parent (Phase 2.5; a real multi-provider payoff vs. complexity).
- **Set signing & trust chain** — org-signed sets that may pre-approve `enabled` on inheritance (HP-08); signing scheme and distribution channel.
