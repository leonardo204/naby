---
id: phase-1_5-personalization-data-layer
title: Phase 1.5 — Personalization Data Layer (scoped memory, injection hook, event schema, golden set)
type: impl
version: 0.2.0
status: draft
scope: The four-task Phase 1.5 that turns Naby's store from a session-scoped key-value bag into a personalization substrate — scoped (user/project/session/org) memory with provenance, a turn-time memory retrieval+injection hook under a token budget, an eval-event schema extended for task-type/domain/edit-diff, and a per-user golden-set holdout — plus the seven memory-architecture decisions and the memory-poisoning write gate. Establishes tasks and acceptance; the on-disk contract lives in phase-1_5-memory-contracts.
related: [personalization-strategy, personalized-agent-desktop-app, phase-1-contracts, phase-1_5-memory-contracts, phase-2-personalization-hitl]
updated: 2026-07-23
---

# Phase 1.5 — Personalization Data Layer

> Execution plan for the personalization substrate. The strategy and rationale live in [`personalization-strategy`](../design/personalization-strategy.md); the on-disk memory schema, write-gate, and injection contract live in [`phase-1_5-memory-contracts`](../interface/phase-1_5-memory-contracts.md); the product-wide roadmap slots this between Phase 1 and Phase 2a in [`personalized-agent-desktop-app`](../design/personalized-agent-desktop-app.md) §5.

**Why this phase exists.** The repository audit ([`personalization-strategy`](../design/personalization-strategy.md) §1.2) found the exact structural reason Phase 1 feels like "just a multi-LLM wrapper": the `memory` table is keyed `(session_id, key)` — a **session-scoped** key-value bag — and the turn path (`session.ts` `runTurn`) neither reads nor writes it. There is no data structure to hold personalization and no path to inject it. A product named "personalized persona agent" has, today, nowhere to put the person. Phase 1.5 builds that substrate **before** Phase 2 so that when the extraction/injection loop and the LLM-judge arrive, there is accumulated data to learn from rather than a cold start measured in months.

**This phase is small and additive.** It is schema extension plus a retrieval hook plus an event-schema widening — no engine change, no provider change, no UI rewrite. The `Store` interface is already the clean seam (contracts §6.1), so the whole phase attaches there.

---

## 1. Entry conditions (carried from Phase 1)

- Phase 1 functional verification complete: chat round-trips on ≥2 metered providers **and** the dev engine, provider switch preserves history, and every session/project/recent/pinned/transcript browsing UI reads the Naby store (`app.db`), not a provider-native file (design §3.6). *(This is the user's stated gate: "우선 phase1 기능검증 모두 마치고 나서.")*
- The `Store` interface (contracts §6.1) exists and owns `userData/app.db` — sessions, transcripts, the session-scoped `memory` table, usage, MCP.
- The turn path `runTurn` is the single place a turn is assembled; it is where the injection hook (P15-02) attaches.

Phase 1.5 does **not** require Phase 2's tool executors or rich gate. It reuses Phase 1's minimal gate machinery only as the attachment pattern for the **memory write gate** (§4, P15-04-adjacent), which is a distinct, deterministic check on writes rather than tool calls.

---

## 2. The personalization loop — what Phase 1.5 builds

The strategy defines a six-stage loop (strategy §3.2). Phase 1.5 is not the whole loop; it lays the **substrate three stages depend on** and leaves extraction/verification to Phase 2b.

| Stage | Owner | Phase 1.5 contribution |
|---|---|---|
| A. Observe (draft · final · edit diff · gate decision) | Phase 2a F2-04 logger | **P15-03** widens the event schema so A can record task-type, domain, and edit diff from day one |
| B. Extract (candidate preference rules) | Phase 2b | — (out of scope; Phase 1.5 only guarantees the raw data exists to extract from) |
| C. Verify (user confirm or confidence threshold) | Phase 2b + memory write gate | **Memory write gate** (§4) + `status: proposed\|confirmed` on every memory row |
| D. Store (user/project-scoped memory) | **Phase 1.5** | **P15-01** — scoped memory tables with provenance |
| E. Inject (next-turn context assembly) | **Phase 1.5** | **P15-02** — retrieval + token-budgeted injection hook in `runTurn` |
| F. Re-measure (golden-set score · edit-rate curve) | Phase 2b dashboard | **P15-04** — golden-set holdout capture so F has a fixed yardstick |

**Diagnosis carried from the strategy:** of the loop's six stages, three were fully empty (B, C, E) and two structurally unfit (D session-only, F measurement-only). Phase 1.5 closes D and E and seeds A/C/F; B and the closed-loop C remain Phase 2b.

---

## 3. Feature list — the four minimum tasks

The completion criteria below are the acceptance for this phase. Priorities: **Must** = Phase 1.5 is not done without it; **Should** = strongly wanted this phase; **Could** = seed now, complete later.

> **Implementation status (2026-07-23).** ✅ **Done + verified**: P15-01 (scoped memory + provenance + lossless v3→v4 migration + cascade exemption), P15-02 (injection hook, token budget, confirmed-only, no-op), P15-05 (write gate, 4 invariants), P15-04 (golden-set holdout, consent, excluded-from-learning, v5), P15-06 (memory review/delete UI — `/api/memory` list/confirm/delete/delete-by-source + Settings "Memory" section). Evidence: parent `spike:p15` 11/11, `spike:golden` 11/11, regressions green; shell tsc baseline-only, vitest 139/139 (15 new), build ok. ⏸️ **Deferred to Phase 2**: **P15-03** — the eval-event schema is only meaningful once Phase 2a's F2-04 logger writes to it, so it lands **with F2-04** (phase-2 §5) rather than as an empty table now. ⬜ **Later**: P15-07 (cold-start bootstrap, Could).

| ID | Feature | Description | Priority | Completion criteria |
|------|------|------|------|------|
| **P15-01** | Scoped memory tables + provenance | Extend `memory` from `(session_id, key)` to a scoped model: **user / project / session / org(optional)** scope, each row carrying `type` (working/episodic/semantic/procedural), `provenance` (source, originating session, trust tier), `confidence`, and `status` (proposed/confirmed). Schema and keying in [`phase-1_5-memory-contracts`](../interface/phase-1_5-memory-contracts.md) §2–§3 | Must | **Deleting a session does NOT delete user-scoped memory** (the invariant break the strategy demands); project delete cascades project-scoped memory only; user/org memory survives both. Migration preserves existing session-scoped rows. |
| **P15-02** | Turn-time retrieval + injection hook | Add a memory read/inject step to `runTurn`: retrieve candidate memory by scope + task, rank, and inject within a **per-turn token budget**; record which items were injected. Retrieval + budget contract in memory-contracts §5 | Must | Injected items appear in a per-turn log; total injected memory tokens never exceed the configured budget; a turn with no relevant memory injects nothing and is unchanged from today. |
| **P15-03** | Eval-event schema extension | Widen the event record (the schema Phase 2a F2-04 will write) so each observation carries **task_type**, **domain**, and the **edit diff** (not just a scalar edit distance). Aligns with Phase 2 `eval_events` (phase-2 §5) so 2a writes into the widened shape | Must | Edit distance can be aggregated **per task type**; the schema is the one Phase 2a F2-04 targets (no second migration in Phase 2). |
| **P15-04** | Golden-set consent + storage | Capture per-user consent and a storage structure to **hold out N of the user's real past artifacts from learning**, reserved as a fixed evaluation set (strategy §4.4) | Must | Per-user holdout of N items exists and is flagged excluded-from-learning; consent state is recorded; the set is addressable for later re-scoring (Phase 2b F2-07). |

**Adjacent (built here because they are preconditions, not deferrable):**

| ID | Feature | Description | Priority | Completion criteria |
|------|------|------|------|------|
| **P15-05** | Memory write gate | A deterministic check on **memory writes** (distinct from tool-call gating): trust-tier classification (user-utterance > artifact > external-content), external-origin writes forced to `status: proposed` and never auto-confirmed. Contract in memory-contracts §4 | Must | An external-content-derived write cannot land as `confirmed` without explicit user confirmation; the gate is negative-tested with a simulated injection payload. |
| **P15-06** | Memory review surface (read/delete) | A screen that lists a scope's memory with provenance and allows delete; the last line of defense against poisoning and the signal source for the "memory correction rate" metric | Should | User can view and delete any memory item; deletes are provenance-addressable (can drop all items from one source). |
| **P15-07** | Cold-start bootstrap (seed) | Seed the three bootstrap paths (strategy §4.3): (A) import past artifacts, (B) onboarding interview, (C) org-persona inheritance. **Path C is the in-house differentiator** and the cheapest first win | Could | At least one path (recommend C for in-house, or B as the universal fallback) produces confirmed user/org memory for a brand-new user. |

---

## 4. Memory-architecture decisions (from strategy §4.1)

The strategy proposes seven decisions. Their **status** here — decided (baked into P15-01/02/05) vs. open (recorded in §7) — is:

1. **Scope layering** — *decided*: user / project / session / org(optional). P15-01. `projects` table already exists as the project-scope anchor (contracts §6.1).
2. **Memory type split** — *decided (taxonomy)*: working / episodic / semantic / procedural, with per-type retention and injection priority. P15-01 stores `type`; retention/priority tuning is §7-open.
3. **Write subject & approval** — *decided*: auto-extract by default, but `status: proposed\|confirmed` separates user-verified from auto rows; below-threshold stays `proposed`. P15-01 + P15-05.
4. **Memory write gate** — *decided*: gate memory writes, not only tool calls. P15-05.
5. **Injection strategy & token budget** — *decided (shape)*: retrieval-based injection + per-turn token cap; the strategy's two-stage "retrieve exemplars, then infer preference before generating" [strategy ref 3] is the target pattern. P15-02 builds retrieval+budget; the two-stage inference is Phase 2b.
6. **Update / conflict / forgetting** — *open (§7)*: latest-wins vs. explicit-supersede, conflict resolution, expiry. P15-01 carries `updatedAt` and `status` to make these expressible; the **policy** is deferred.
7. **Provenance** — *decided*: every row records when/which-session/what-basis/trust. P15-01 + memory-contracts §3. Precondition for P15-06 delete-by-source and poisoning rollback.

---

## 5. Evaluation — the golden set (P15-04)

- **Why not academic benchmarks.** LoCoMo/LongMemEval/BEAM measure multi-session recall, and recent work shows 94% / 85% of their items are answerable from the last two sessions alone [strategy ref 4] — they cannot measure "does it fit me better over time." (Consistent with phase-2 §1's existing rejection of factual-recall benchmarks.)
- **What we build instead.** Hold out N of the user's real artifacts from learning (P15-04). As memory accumulates, regenerate the same inputs and compare distance to the held-out truth — isolating **personalization progress** from task-difficulty drift.
- **North-star metric (strategy §2.2):** the **edit-rate reduction curve** within a fixed task type. Its confound is that better personalization invites harder tasks, which re-inflates edit distance — the golden set is the fixed-difficulty control that de-confounds it.
- **Supporting metrics (feed Phase 2 F2-05 dashboard):** memory hit rate (injected items actually reflected in output), memory correction rate (user edits/deletes — high is a *trust* signal, from P15-06), plus the existing approval/override rates.
- **Scoring** stays off the send path (weekly batch), and the LLM-judge (Phase 2b) should run on a **different provider** than the drafting model — a concrete payoff of the multi-provider runtime.

---

## 6. Definition of Done

- **P15-01/02**: session delete leaves user memory intact; a turn injects scope-appropriate memory within budget and logs what it injected; existing session memory migrated with no loss.
- **P15-03**: the eval-event schema Phase 2a will populate carries task_type/domain/edit-diff; edit distance aggregates per task type.
- **P15-04**: a per-user golden-set holdout exists, consented, excluded from learning, and addressable for later re-scoring.
- **P15-05**: no external-content-derived memory can auto-confirm; the write gate is negative-tested against a simulated injection.
- Substrate proven end-to-end: a confirmed user preference, stored once, is injected on a later session with a *different* provider and visibly shapes the draft — the loop's D→E stages demonstrated on real data.

---

## 7. Risks

- **Memory poisoning — the top risk (strategy §7.1).** Prompt injection dies with the session; memory poisoning persists and detonates weeks later. OWASP added memory/context poisoning (ASI06) as a distinct 2026 agentic risk; query-only long-term-memory poisoning is demonstrated at high success rates [strategy refs 9–12]. → **P15-05 memory write gate** (trust tiers; external-origin never auto-confirms), **P15-07/§4-decision-7 provenance** for selective rollback, **P15-06 review surface** as the last layer. This is why the write gate is *Must* in Phase 1.5 and not deferred to Phase 2 — it must exist before any tool that reads external content (Phase 2a) can write to memory.
- **Encryption at rest is now unavoidable.** `app.db` will hold drafts, finals, and personal preferences. Whether it is encrypted at rest was already an open question (design §6, contracts §6, phase-2 §9); once personalization is the point, it can no longer be deferred indefinitely. → §7-open; needs an in-house information-classification decision.
- **Learning bad habits / over-fitting.** → P15-06 per-rule enable/disable + delete; P15-02 injection budget and per-task-type scope prevent one context from dominating.
- **Retrieval quality collapse makes the layer useless.** → memory hit rate (§5) is the early-warning metric.
- **Self-build burden.** Mem0/Zep/Letta exist as off-the-shelf memory layers. → §7-open: adopt or reference **only** where it does not break local ownership and auditability (the whole differentiator).

---

## 8. How this changes the neighboring specs (sync map)

Phase 1.5 forces edits the strategy implies; recorded here so the graph stays honest:

- **[`phase-1-contracts`](../interface/phase-1-contracts.md) §6 / §6.1** — the "messages, memory, and usage remain keyed by `sessionId` only" invariant and the `removeProject`/`deleteSession` CASCADE-includes-memory rules are **Phase-1 session-memory rules**, not a ceiling. Phase 1.5 introduces scoped memory that is explicitly **exempt** from session/project cascade. Annotated there; the full scoped schema is [`phase-1_5-memory-contracts`](../interface/phase-1_5-memory-contracts.md).
- **[`personalized-agent-desktop-app`](../design/personalized-agent-desktop-app.md)** — Phase 1.5 inserted into the §5 roadmap; memory-poisoning added to §4 cross-phase risks; the memory box (§3.2) annotated as scoped-in-1.5.
- **[`phase-2-personalization-hitl`](phase-2-personalization-hitl.md)** — Phase 1.5 is a new entry condition; F2-04's `eval_events` targets the P15-03-widened schema; the extraction/injection loop (B/E) builds on P15-01/02; metrics gain the edit-rate curve and memory hit/correction rates.

---

## 9. Open questions

- **Update/conflict/forgetting policy** (decision 6): latest-wins vs. explicit-supersede, conflict resolution across scopes, per-type expiry. Blocks nothing in P15-01 (schema carries `updatedAt`/`status`) but must be set before auto-extraction (Phase 2b) writes at volume.
- **`app.db` encryption at rest** — tie to the in-house information-classification policy. Shared open question with design §6 / contracts §6 / phase-2 §9.
- **Memory ownership on offboarding** — user-scope memory when a person leaves / transfers. Legal/HR, not design; recorded as a decision request (strategy §9).
- **Off-the-shelf memory layer** (Mem0 / Zep / Letta) vs. self-build — decided against only if it breaks local ownership or auditability; needs a licensing/self-hosting review.
- **Golden-set size N and cadence** — depends on org size and per-user artifact volume; a proposal value, re-set at kickoff (strategy appendix).
- **Org-scope availability** — org memory is an in-house-only asset; whether it ships in the same build as the general app or behind a flag.

---

## References

Numbering matches the canonical list in [`personalization-strategy`](../design/personalization-strategy.md) §참고문헌; the load-bearing ones here are 3 (latent-preference-from-edits), 4 (recall-vs-forgetting benchmark critique), and 9–12 (memory poisoning / OWASP ASI06).
