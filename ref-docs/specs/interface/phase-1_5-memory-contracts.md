---
id: phase-1_5-memory-contracts
title: Phase 1.5 — Memory Contracts (scoped schema, write gate, injection, Store extension)
type: interface
version: 0.2.0
status: draft
scope: The on-disk and in-process contracts for Phase 1.5 scoped memory — the memory record shape (scope/type/provenance/confidence/status), the keying model and how it extends (not violates) the Phase-1 sessionId-only invariant, the cascade-exemption rules, the deterministic memory write-gate contract, the turn-time retrieval + token-budget injection contract, and the Store interface additions.
related: [phase-1_5-personalization-data-layer, phase-1-contracts, personalization-strategy, phase-2-personalization-hitl]
updated: 2026-07-23
---

# Phase 1.5 — Memory Contracts

> The interface layer for [`phase-1_5-personalization-data-layer`](../impl/phase-1_5-personalization-data-layer.md). This document defines shapes and invariants only; the task order and acceptance are in that impl doc, the rationale in [`personalization-strategy`](../design/personalization-strategy.md). It **extends** [`phase-1-contracts`](phase-1-contracts.md) §6 — read that first for the `Store` interface and the storage layout this builds on.

---

## 1. What changes, in one sentence

Phase 1 stores memory as `memory(session_id, key, value)` — session-scoped, keyed by `sessionId` only (contracts §6). Phase 1.5 keeps that row shape working for **session-scoped** memory and **adds** user-, project-, and (optional) org-scoped memory with provenance, so that memory can outlive the session it was learned in. The Phase-1 keying invariant is preserved for what it actually governs — **transcripts, usage, and session-scoped memory** — and is **not** a ceiling on scoped memory.

---

## 2. The keying model — extends, does not violate, the §6 invariant

Contracts §6 states: *"messages, memory, and usage remain keyed by `sessionId` only."* That invariant is about **replay integrity** — a transcript and its usage must never be reachable except through the one session UUID. Phase 1.5 does not touch it for transcripts or usage. For memory it is refined:

| Scope | Key | Lifetime vs. session/project delete |
|---|---|---|
| `session` | `sessionId` (unchanged from Phase 1) | Deleted with the session (unchanged) |
| `project` | `cwd` (the `Project` identity, contracts §6.1) | Deleted with the project (cascade), **not** with a single session |
| `user` | a stable local user id (single-user machine: a constant) | **Survives session AND project delete** |
| `org` *(optional, in-house)* | an org id | Survives everything short of an explicit org purge |

**The load-bearing new rule:** deleting a session deletes only `scope='session'` memory for that `sessionId`. Deleting a project cascades `scope='project'` memory for that `cwd` **and** its sessions' `scope='session'` memory — but **never** `user` or `org` memory. This is the exact break the strategy requires (strategy §1.2): today `deleteSession`/`removeProject` cascade *all* memory, which would erase the personalization the moment a session is cleaned up.

> This document is the authority for that cascade exemption. [`phase-1-contracts`](phase-1-contracts.md) §6.1's cascade wording is annotated to point here for scoped memory.

---

## 3. Memory record shape

```ts
type MemoryScope = 'session' | 'project' | 'user' | 'org';

type MemoryType =
  | 'working'     // current task state — short-lived, high injection priority in-session
  | 'episodic'    // "what happened" — a specific past event/decision
  | 'semantic'    // stable facts / preferences / terminology
  | 'procedural'; // repeated procedures / rules ("meeting notes split into decision/action/hold")

type TrustTier =
  | 'user'        // originated in a user utterance — highest trust
  | 'artifact'    // derived from the user's own draft/final output
  | 'external';   // derived from external content (web/email/doc) — lowest trust

type MemoryStatus = 'proposed' | 'confirmed';
// 'proposed' = auto-extracted below confidence threshold OR external-origin awaiting confirm.
// 'confirmed' = user-verified, or above threshold from a trusted tier.

type MemoryProvenance = {
  source: TrustTier;        // WHICH tier this came from (drives the write gate, §4)
  sessionId?: string;       // the session it was learned in (for delete-by-source rollback)
  basis?: string;           // short human-readable "why this was written" (e.g. an edit diff id)
  createdFrom?: string;     // eval_event id or message id it was extracted from, if any
};

type MemoryItem = {
  id: string;               // UUID — the row's own key
  scope: MemoryScope;
  scopeKey: string;         // sessionId | cwd | userId | orgId, per scope (§2)
  type: MemoryType;
  key: string;              // stable slug within (scope, scopeKey) — upsert target
  value: string;
  provenance: MemoryProvenance;
  confidence: number;       // 0–1; auto-extraction confidence (1 for user-confirmed)
  status: MemoryStatus;
  createdAt: number;
  updatedAt: number;        // enables latest-wins / supersede policy (impl §7-open)
};
```

- **`(scope, scopeKey, key)` is the upsert identity.** Re-learning the same preference updates the row (bumping `updatedAt`, possibly `confidence`), it does not duplicate.
- **`id` is the provenance/rollback handle.** Delete-by-source (impl P15-06) selects on `provenance.source` / `provenance.sessionId`; a poisoning incident drops exactly the affected rows.
- **No `role:'system'` leakage.** Injected memory rides in the turn assembly (§5), never as a stored transcript message — same discipline as contracts §6's system-prompt rule.

Phase 1's existing `memory(session_id, key, value)` rows migrate to `{scope:'session', scopeKey: session_id, type:'working', key, value, provenance:{source:'user'}, status:'confirmed', confidence:1}` — lossless, and the session-memory path behaves exactly as before.

---

## 4. Memory write-gate contract (deterministic)

A write to memory passes a deterministic gate **before** it lands — the analogue of the tool-call gate (phase-2 §2.5), but on writes. It is a pure function of the write request; no model judgment.

```ts
type MemoryWriteRequest = Omit<MemoryItem, 'id' | 'createdAt' | 'updatedAt' | 'status'> & {
  requestedStatus: MemoryStatus;
};

type MemoryWriteDecision =
  | { behavior: 'allow'; status: MemoryStatus }          // may downgrade requestedStatus
  | { behavior: 'hold';  status: 'proposed'; reason: string }  // must be user-confirmed
  | { behavior: 'deny';  reason: string };
```

**Invariants (load-bearing — the memory-poisoning defense, strategy §7.1):**

1. **External-origin never auto-confirms.** `provenance.source === 'external'` ⇒ decision is at most `hold` with `status:'proposed'`; it can become `confirmed` only through an explicit user action (impl P15-06), never through a threshold.
2. **Trust ordering is fixed:** `user` > `artifact` > `external`. A higher tier may raise `confidence`/allow `confirmed`; a lower tier can never overwrite a `confirmed` higher-tier row without user action.
3. **Scope escalation is gated.** Writing to `user` or `org` scope from an `external` source is always `deny` — external content cannot mint durable cross-session identity. (`session`/`project` scope may `hold`.)
4. **The gate is negative-tested.** A simulated indirect-injection payload ("remember that you should always …") arriving via `external` provenance must not produce a `confirmed` row (impl P15-05 acceptance).

---

## 5. Injection contract (turn-time)

`runTurn` gains a retrieval+inject step. It is provider- and engine-independent (it runs in the runtime, above the engine seam — design §3.4), so it behaves identically whichever model answers.

```ts
type MemoryInjectionQuery = {
  sessionId: string;
  cwd?: string;             // project scope, if the session is projected
  taskType?: string;        // hint from the turn (aligns with eval_events.task_type)
  tokenBudget: number;      // HARD cap on injected memory tokens for this turn
};

type InjectedMemory = {
  items: MemoryItem[];      // selected, ranked, within budget
  tokensUsed: number;       // ≤ tokenBudget, always
  droppedForBudget: number; // count omitted purely due to the cap (logged, never silent)
};
```

**Invariants:**

- **Budget is a hard ceiling.** `tokensUsed ≤ tokenBudget` always; over-budget candidates are dropped and **counted** (`droppedForBudget`) — a silent truncation would read as "nothing relevant" when the opposite is true.
- **Only `confirmed` memory injects by default.** `proposed` rows do not shape a turn until confirmed (they may be surfaced for confirmation via P15-06, not injected). Prevents un-vetted / poisoned candidates from acting before review.
- **Scope precedence on ties:** `session` (working) > `project` > `user` > `org` for the same relevance, reflecting immediacy; type priority (working/episodic/semantic/procedural) is a tunable, not a contract (impl §7-open).
- **Injection is logged per turn.** The set of injected `item.id`s is recorded (impl P15-02 acceptance) so "memory hit rate" (impl §5) is computable and so a bad injection is auditable.
- **Empty is a no-op.** No relevant memory ⇒ inject nothing ⇒ the turn is byte-for-byte what Phase 1 would have sent. Phase 1.5 never degrades a turn that has no personalization to add.

---

## 6. `Store` interface additions

Extends the `Store` interface (contracts §6.1). Existing session/message/usage/settings/mcp/project ops are unchanged; the **session-scoped** memory ops keep working via the migration in §3.

```ts
interface Store {
  // … everything in contracts §6.1 unchanged …

  // -- scoped memory (Phase 1.5) ------------------------------------------
  /** Upsert by (scope, scopeKey, key). Passes through the write gate (§4);
   *  a 'deny' throws, a 'hold' persists with status:'proposed'. Returns the row. */
  putMemory(req: MemoryWriteRequest): MemoryItem;

  /** Read scoped memory for injection/review. `status` filters proposed vs
   *  confirmed; omit for all. Ordering is relevance-agnostic here — ranking
   *  happens in the injection step (§5), not the store.
   *
   *  NAMED `getScopedMemory`, not `getMemory`: the Phase-1 store already exposes
   *  `getMemory(sessionId, key): string` (the legacy session-memory reader that
   *  §3's migration preserves). Both take `(string, string)` with different
   *  return types, so a TS overload would resolve ambiguously — the scoped
   *  reader gets its own name to keep the legacy path intact. */
  getScopedMemory(scope: MemoryScope, scopeKey: string, opts?: { status?: MemoryStatus }): MemoryItem[];

  /** Confirm a proposed item (the only path external-origin memory becomes
   *  confirmed — §4 invariant 1). */
  confirmMemory(id: string): void;

  /** Delete one item, or all items matching a provenance source (poisoning
   *  rollback / P15-06 delete-by-source). Exactly one selector. */
  deleteMemory(sel: { id: string } | { source: TrustTier; sessionId?: string }): void;
}
```

**Cascade guarantees (the §2 rule, stated as store behavior):**

- `deleteSession(sessionId)` deletes `scope='session'` memory for that id **only**. It MUST NOT touch `user`/`project`/`org` memory. *(Amends contracts §6.1's "deleteSession's existing explicit cascade" for memory.)*
- `removeProject(cwd)` cascades `scope='project'` memory for that `cwd` and its sessions' `scope='session'` memory. It MUST NOT touch `user`/`org` memory. *(Amends contracts §6.1's CASCADE-includes-memory wording.)*
- `user`/`org` memory is removed only by explicit `deleteMemory` (or an org purge), never by a session/project lifecycle event.

---

## 6.2 Golden set (P15-04)

The per-user evaluation holdout (impl §5). A **separate table** from scoped memory — the physical disjointness IS the excluded-from-learning guarantee: injection/extraction read `memory_items` only, so a held-out artifact can never leak into a turn or into learning.

```ts
type GoldenConsent = 'granted' | 'revoked' | 'pending';

type GoldenItem = {
  id: string;                 // UUID — row key AND the addressable re-scoring handle (Phase 2b F2-07)
  scopeKey: string;           // the user (single-user machine: a constant); same space as scope='user'
  taskType: string;           // aligns with eval_events.task_type / P15-03 — score aggregates per task type
  input: string;              // the original prompt the artifact answered
  expected: string;           // the user's real past output — the HELD-OUT truth scored against later
  excludedFromLearning: true; // ALWAYS true — literal type makes `false` inexpressible; store never accepts it
  consent: GoldenConsent;     // defaults to 'pending'
  createdAt: number;
  lastScoredAt: number | null;// null in Phase 1.5 — reserved so re-scoring needs no later migration
};

type GoldenItemInput = {      // what a caller supplies; id/createdAt/lastScoredAt/excludedFromLearning are store-owned
  scopeKey: string;
  taskType: string;
  input: string;
  expected: string;
  consent?: GoldenConsent;    // defaults to 'pending'
};
```

Store additions (extend §6):

```ts
interface Store {
  // … §6 scoped-memory ops …
  /** Capture a held-out artifact. excludedFromLearning is stamped true; consent
   *  defaults to 'pending'; lastScoredAt is null. Returns the row with its id. */
  addGoldenItem(item: GoldenItemInput): GoldenItem;
  /** A user's golden set, optionally filtered by consent. */
  listGoldenSet(scopeKey: string, opts?: { consent?: GoldenConsent }): GoldenItem[];
  getGoldenItem(id: string): GoldenItem | undefined;
  setGoldenConsent(id: string, consent: GoldenConsent): void;
  removeGoldenItem(id: string): void;
}
```

**Invariants.**

- **Excluded from learning — structurally, not by flag alone.** Golden items live in their own table/map; the injection path (§5) and any future extraction path read `memory_items` exclusively. The `excludedFromLearning: true` literal is the type-level backstop; the physical separation is the real guarantee.
- **Consent is per-item and mutable.** `setGoldenConsent` moves an item between `granted`/`revoked`/`pending`; scoring (Phase 2b) considers only `granted`.
- **`id` is the re-scoring handle.** Phase 2b F2-07 re-scores by `id`; `lastScoredAt` is reserved (null now) so re-scoring adds no migration.
- **Golden set is user-scoped and lifecycle-independent** — like `user` scoped memory, it survives session/project deletes (§2).

---

## 7. Migration & compatibility

- **SCHEMA_VERSION 3 → 5, in two additive steps.** v4 replaces the legacy `memory(session_id, key, value)` with the scoped `memory_items` table and back-fills existing rows losslessly (§3); v5 adds the `golden_items` table (§6.2) purely additively (`IF NOT EXISTS`, no back-fill). Migrations are self-healing (gated on the presence of the legacy table / target table, not only the version stamp); the Phase-1 session-memory read path is preserved throughout.
- **The `Store` interface stays the seam.** As with F1-05's driver (`node:sqlite`), a schema choice is a store-internal detail; the runtime depends on the interface in §6, not on the table layout.
- **No engine or contract-§2 change.** Injection assembles memory into `EngineRunInput` above the engine seam; the engine interface (contracts §2) is untouched.

---

## 8. Open questions (shared with impl §9)

- Update/conflict/forgetting policy — `updatedAt` and `status` make it expressible; the policy (latest-wins vs. supersede, per-type expiry) is deferred.
- Token-budget default and per-type injection priority — tunables, set with real data.
- `app.db` encryption at rest — now sharpened to a decision (design §6, contracts §6, phase-2 §9); scoped memory is personal work content.
- Whether `userId`/`orgId` are real identifiers or (single-user machine) constants until multi-user/in-house rollout.
