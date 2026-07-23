// src/runtime/trust.ts
//
// THE SHARED TRUST ORDERING (phase-1_5-memory-contracts §4, reused by
// phase-1_6-harness-contracts §4).
//
// Both the memory write-gate (memory-gate.ts) and the harness import-gate
// (harness-gate.ts) key on the SAME fixed trust ordering: user > artifact >
// external. Rather than duplicate the rank table and the comparison in two
// gates (and risk them drifting apart), the ordering lives here once and both
// gates import it. This is the "factor the shared logic rather than duplicating"
// the harness contract §4 / impl §4 calls for.
//
// The tier NAMES are identical across the two features by design: a memory's
// TrustTier and a harness item's HarnessTrust are both 'user' | 'artifact' |
// 'external', with the same meaning (authored-by-user > local artifact >
// imported/foreign). `Tier` below is that common union.

/** The common trust tier union shared by memory (TrustTier) and harness
 * (HarnessTrust). authored-by-user > local artifact > imported/foreign. */
export type Tier = 'user' | 'artifact' | 'external';

/** Fixed trust ordering (contract §4 invariant 2): user > artifact > external.
 * Higher number = more trusted. */
export const TRUST_RANK: Record<Tier, number> = {
  user: 3,
  artifact: 2,
  external: 1,
};

/** True when `a` is strictly less trusted than `b`. */
export function lowerTierThan(a: Tier, b: Tier): boolean {
  return TRUST_RANK[a] < TRUST_RANK[b];
}
