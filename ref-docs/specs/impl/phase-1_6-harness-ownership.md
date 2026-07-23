---
id: phase-1_6-harness-ownership
title: Phase 1.6 — Harness Ownership (commands/skills/subagents as Naby-owned, portable, importable assets)
type: impl
version: 0.1.1
status: draft
scope: The Phase-2-independent core of harness portability, sequenced BEFORE Phase 2 — Naby-owned scoped harness (commands/skills/subagents/sets) with provenance, provider-independent command CRUD + expansion, instruction-only skill runtime, a ~/.claude importer, harness-set export/import + team sharing, an import trust-gate reusing the Phase-1.5 memory gate, and org-scope inheritance. Establishes tasks and acceptance; shapes live in phase-1_6-harness-contracts. Tool-execution-dependent pieces (tool-bearing skills, subagent orchestration) are Phase 2.5.
related: [harness-portability-strategy, phase-1_6-harness-contracts, personalized-agent-desktop-app, phase-1-contracts, phase-1_5-memory-contracts, phase-2-personalization-hitl]
updated: 2026-07-23
---

# Phase 1.6 — Harness Ownership

> Execution plan for the harness-portability **core**. Strategy and the phase-boundary rationale are in [`harness-portability-strategy`](../design/harness-portability-strategy.md); entity shapes / bundle format / import gate / Store additions are in [`phase-1_6-harness-contracts`](../interface/phase-1_6-harness-contracts.md); the roadmap slots this **between Phase 1.5 and Phase 2a** in [`personalized-agent-desktop-app`](../design/personalized-agent-desktop-app.md) §5.

**Why before Phase 2.** The dev/prod harness cliff exists *today*: on the dev Claude engine the full `~/.claude` harness is inherited (`settingSources`), but a switch to any metered provider drops every skill/command/subagent, and the shell slash palette is hardcoded with no CRUD (audit in strategy §1). None of the *core* fixes need Phase 2's tool executors — commands are prompt templates and skills inject instructions, both on the **same turn-assembly path as memory injection (P15-02)**, so they work on all five providers now. Only tool-*executing* pieces (tool-bearing skills, subagents) need Phase 2, and they are split out to Phase 2.5. This phase is the harness twin of Phase 1.5: same store + trust-gate pattern, **reusing the memory write-gate and provenance already built**.

---

## 1. Entry conditions

- **Phase 1 verified** and **Phase 1.5 done** (scoped store + `decideMemoryWrite` trust-gate + provenance + the review-UI pattern in `NabyMemoryReview`). Phase 1.6 reuses all of these.
- The turn path `runTurn` already assembles memory into `EngineRunInput.system` above the engine seam (P15-02) — command/skill injection attaches at the same point.
- The shell already has a hardcoded slash palette and a `/api/*` + `getStore()` pattern to build the CRUD/review UI on.

Phase 1.6 does **not** need Phase 2's tool executors or rich gate. `toolRefs` on skills/subagents are *stored* faithfully but not executed here.

---

## 2. What Phase 1.6 builds vs. defers

| Piece | Phase 1.6 | Phase 2.5 (deferred) |
|---|---|---|
| Owned harness schema + scopes + provenance | ✅ HP-01 | |
| Command CRUD + provider-independent expansion | ✅ HP-02 | |
| Skill runtime — instruction injection only | ✅ HP-03a | |
| Skill runtime — tool-bearing skills execute | | ⏸️ HP-03b (needs Phase 2 executors) |
| `~/.claude` / `.claude` importer | ✅ HP-04 | |
| Harness-set export/import + merge | ✅ HP-05 | |
| Import trust-gate + provenance + review UI | ✅ HP-06 | |
| Org-scope harness inheritance | ✅ HP-08 | |
| Subagent orchestration (tool-using) | | ⏸️ HP-07 (needs Phase 2 loop/executors) |

---

## 3. Feature list

Priorities: **Must** = Phase 1.6 not done without it; **Should** = strongly wanted; **Could** = seed now.

> **Implementation status (2026-07-23).** ✅ **Done + verified**: HP-01 (owned harness schema + import gate `decideHarnessImport` reusing the shared `trust.ts` tiers + SCHEMA v5→v6 + cascade exemption + export/import-set store surface; parent `spike:harness` 13/13, regressions green), HP-02 (command CRUD `/api/harness` + Settings "Commands" section + palette merge/override + builtin non-regression; shell tsc baseline-only, vitest 174/174 with 35 new, build ok). 🔧 **Next**: HP-03a (instruction-only skill runtime), HP-04 (`~/.claude` importer), HP-06 (import review UI), HP-05 (set export/import UI), HP-08 (org inheritance). ⏸️ **Phase 2.5**: HP-03b (tool-bearing skills), HP-07 (subagent orchestration).

| ID | Feature | Description | Priority | Completion criteria |
|------|------|------|------|------|
| **HP-01** | Owned harness schema + provenance | `HarnessItem` (kind command/skill/subagent, scope user/project/org, status enabled/disabled, provenance, kind-specific payload) in the store; contract [`phase-1_6-harness-contracts`](../interface/phase-1_6-harness-contracts.md) §2–§3. Additive SCHEMA bump | Must | Session/project delete never removes user/org harness (cascade exemption); `(scope,scopeKey,kind,name)` upsert identity; scopes addressable |
| **HP-02** | Command CRUD + provider-independent expansion | Turn the hardcoded slash palette into owned commands: create/edit/delete a command (verb + template + argumentHint); expansion assembles into the turn above the engine seam | Must | User adds/edits/deletes a command from the UI; the same command expands identically on all five providers **and** the dev engine; existing builtins migrate to owned rows (still shown, editable/removable) |
| **HP-03a** | Skill runtime — instruction injection | Load enabled skills, progressive disclosure, inject `instructions` into the turn context (no tool execution). Same mechanism as memory injection (P15-02), under a token budget | Must | An instruction-only skill triggers and injects on both dev and prod engines; a skill with `toolRefs` is stored but marked "needs Phase 2.5", not half-run |
| **HP-04** | `~/.claude` / `.claude` importer | Parse Claude Code commands/skills/subagents (command `.md`, SKILL.md, agent `.md` frontmatter) into owned rows via the import gate; **hooks are dropped** (§4 contract) | Must | Existing Claude Code harness imports losslessly into Naby-owned rows (disabled, provenance recorded); hooks are skipped and reported; re-import updates, not duplicates |
| **HP-06** | Import trust-gate + provenance + review UI | Reuse the Phase-1.5 trust model for imports: external-origin lands `disabled`, never auto-enables; provenance for rollback; a review surface to inspect/enable/delete (extends `NabyMemoryReview` pattern) | Must | Imported items inert until enabled in review; a simulated injection payload cannot auto-enable (negative test); delete-by-origin rolls back a bad set |
| **HP-05** | Harness-set export/import + merge | Export a scope's enabled items as a named/versioned `HarnessSet`; import merges through the gate with item-level selection and conflict handling (contract §5) | Should | Export → another machine/teammate imports (all disabled); item-level pick; a conflict never overwrites an enabled local item |
| **HP-08** | Org-scope harness inheritance | Seed a new user from the org harness set (team persona); still gate-disabled unless org policy pre-approves | Should | A brand-new user inherits the org set's items (disabled by default); org scope survives session/project deletes |

**Cheapest first win: HP-02.** It directly answers the owner's original question ("add/delete these commands"), closes the first slice of the dev/prod cliff, and is pure store + expansion + UI.

---

## 4. Reuse from Phase 1.5 (don't rebuild)

- **Trust-gate:** the import gate (contract §4) mirrors `decideMemoryWrite` — same trust tiers (`user`>`artifact`>`external`), external-never-auto-enables, negative-tested against an injection payload. Factor the shared logic rather than duplicating.
- **Provenance + rollback:** same `{source, origin}` shape; delete-by-origin is the harness twin of memory delete-by-source.
- **Cascade exemption:** same rule as scoped memory (user/org survive session/project delete) — implement in the store's `deleteSession`/`removeProject` alongside the memory exemption.
- **Review UI:** extend the `NabyMemoryReview` pattern (scope filter, status filter, provenance display, enable/delete) rather than a new surface.
- **Injection path:** command expansion and skill instructions assemble into `EngineRunInput.system` exactly where memory injection attaches (P15-02) — one turn-assembly seam, provider-independent.

---

## 5. Definition of Done

- Commands/skills/subagents are Naby-owned, scoped, and survive a provider switch and a session/project delete (user/org).
- A user can add/edit/delete a command and it works identically across all five providers + dev.
- An instruction-only skill injects on both engines; tool-bearing skills/subagents are captured (disabled, marked Phase 2.5), never half-executed.
- `~/.claude` imports losslessly (hooks dropped/reported); imports are inert until reviewed; a bad set rolls back by origin.
- A harness set exports and re-imports on another machine/teammate; org inheritance seeds a new user.
- Verified with a spike suite (parent store + gate, like `spike:p15`) and shell tsc/vitest/build green.

---

## 6. Risks

- **Import poisoning** — the top risk, identical in shape to memory poisoning (ASI06). → the import gate (§4 contract) + default-disabled + provenance rollback + review UI. This is why HP-06 is Must and imports are inert until reviewed.
- **hooks = arbitrary code execution** — never imported (contract §4 invariant 3); Naby's gate/events cover the legitimate uses.
- **Silent half-working tool-bearing skills** — avoided by capturing `toolRefs` but keeping such items disabled with an explicit "needs Phase 2.5" state.
- **Builtin migration regression** — turning the hardcoded palette into owned rows must not lose the current commands; migrate them as `user`-scope owned rows and keep them editable/removable.

---

## 7. Open questions (shared with contract §7)

- Self-format extension beyond Claude formats (per-item model, memory linkage) and graceful round-trip export.
- `toolRefs` resolution when a referenced tool is absent (stub/disable/warn) — item stays disabled until Phase 2.5 regardless.
- Subagent provider independence (Phase 2.5).
- Set signing / trust chain for org sets that may pre-approve `enabled` on inheritance (HP-08).
- Whether builtins, once migrated to owned rows, are seeded per-user on first run or shipped as a default org set.

---

## 8. Sequenced after this (Phase 2.5)

- **HP-03b** tool-bearing skills — the referenced tools execute under Phase 2's gate/executors.
- **HP-07** subagent orchestration — Naby's runtime spawns/gates/observes subagents provider-independently. Overlaps Phase 2 loop ownership; see [`phase-2-personalization-hitl`](phase-2-personalization-hitl.md).
