// src/runtime/memory-gate.ts
//
// THE MEMORY WRITE GATE (phase-1_5-memory-contracts §4, impl P15-05).
//
// The analogue of the tool-call gate (runtime/gate.ts), but on memory WRITES.
// It is a PURE, DETERMINISTIC function of the write request (and the row it
// would overwrite) — no model judgment. This is the memory-poisoning defense
// (strategy §7.1, OWASP ASI06): prompt injection dies with the session, but a
// poisoned memory persists and detonates weeks later, so a write must clear this
// gate BEFORE it lands.
//
// The four load-bearing invariants (contract §4), each implemented and labelled
// below:
//
//   (1) External-origin NEVER auto-confirms. `provenance.source === 'external'`
//       ⇒ the decision is at most `hold` with status:'proposed'; it can become
//       `confirmed` only through an explicit user action (confirmMemory), never
//       through a threshold or a requestedStatus.
//   (2) Trust ordering is FIXED: user > artifact > external. A lower tier can
//       never overwrite a CONFIRMED higher-tier row without user action.
//   (3) Scope escalation is gated. Writing to `user`/`org` scope from an
//       `external` source is always `deny` — external content cannot mint
//       durable cross-session identity.
//   (4) The gate is negative-tested: a simulated indirect-injection payload
//       arriving via `external` provenance must not produce a `confirmed` row.
//       (Enforced by (1)+(3); asserted in the P15 spike.)

import type {
  MemoryItem,
  MemoryWriteDecision,
  MemoryWriteRequest,
} from './store/store.js';
// The trust ordering (user > artifact > external) is factored into trust.ts and
// SHARED with the harness import-gate (harness-gate.ts), so the two gates can
// never drift apart on how they rank provenance (contract §4).
import { lowerTierThan } from './trust.js';

/**
 * Decide whether (and how) a memory write may land. Pure and deterministic.
 *
 * @param req       the requested write, carrying provenance + requestedStatus.
 * @param existing  the row this write would overwrite (same scope/scopeKey/key),
 *                  if any — needed for the trust-ordering invariant (2).
 */
export function decideMemoryWrite(
  req: MemoryWriteRequest,
  existing?: MemoryItem,
): MemoryWriteDecision {
  const source = req.provenance.source;

  // (3) SCOPE ESCALATION — external content may not write durable cross-session
  // identity. Checked FIRST: a deny here is absolute regardless of status.
  if (source === 'external' && (req.scope === 'user' || req.scope === 'org')) {
    return {
      behavior: 'deny',
      reason: `external-origin content cannot write to '${req.scope}' scope (scope escalation blocked)`,
    };
  }

  // (2) TRUST ORDERING — a lower-tier write may not overwrite a CONFIRMED
  // higher-tier row without an explicit user action. (A same-or-higher tier may;
  // that is a legitimate update/supersede.)
  if (
    existing &&
    existing.status === 'confirmed' &&
    lowerTierThan(source, existing.provenance.source)
  ) {
    return {
      behavior: 'deny',
      reason: `a '${source}'-tier write may not overwrite a confirmed '${existing.provenance.source}'-tier row without user confirmation`,
    };
  }

  // (1) EXTERNAL NEVER AUTO-CONFIRMS — at most hold/proposed. A request to
  // confirm is downgraded to a hold (it needs an explicit confirmMemory); a
  // request to merely propose is allowed but pinned to 'proposed'.
  if (source === 'external') {
    if (req.requestedStatus === 'confirmed') {
      return {
        behavior: 'hold',
        status: 'proposed',
        reason:
          'external-origin memory must be user-confirmed before it can become confirmed (auto-confirm refused)',
      };
    }
    return { behavior: 'allow', status: 'proposed' };
  }

  // Trusted tiers (user/artifact): the requested status is honoured — a trusted
  // tier asking for 'confirmed' is granted, asking for 'proposed' stays
  // proposed. (The gate may only ever DOWNGRADE, never upgrade past a request.)
  return { behavior: 'allow', status: req.requestedStatus };
}
