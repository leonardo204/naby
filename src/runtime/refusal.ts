// src/runtime/refusal.ts
//
// WHAT KIND OF "NO" A GATE REFUSAL IS (checkin-contracts §2, trust-meter §4.8).
//
// The growth ledger turns a refused consequential call into a `tripwire`, and a
// tripwire is the meter's one HARD block: a single one inside the window keeps an
// agent off butterfly however accurate it is. That is right for a SAFETY refusal
// — the agent reached for something the user, the org or naby itself decided it
// must not do. It is wrong for a CAPABILITY refusal — the call was refused
// because the thing cannot be done here at all, and asking first would have
// changed nothing.
//
// The first real ledger showed what mixing the two costs: all 34 tripwires were
// "Backgrounding through Bash is not available" (`policy.ts`), and three of them
// inside the window held a persona that was butterfly by accuracy at pupa.
//
// So the distinction is made at the SOURCE: whoever builds a deny decision says
// which kind it is (`GateDecision.refusal`), and the ledger writer acts on that
// instead of guessing from the reason text at count time. Absent means SAFETY —
// fail-closed, so a new refusal nobody classified still blocks butterfly rather
// than quietly not counting.
//
// Pure and dependency-free on purpose: `growth.ts` (pure) and `policy.ts` both
// read it, and neither may pull the other's imports in.

/** `safety` — refused because it must not happen (policy rule, org hook, a write
 *  into a protected directory, a user's "no", a read-only turn).
 *  `capability` — refused because it cannot be done here (an engine path that
 *  cannot report back, a tool the acting agent was never given). */
export type RefusalKind = 'safety' | 'capability';

/** Is this a refusal the trust meter should treat as a tripwire? Absent ⇒ yes. */
export function isSafetyRefusal(refusal: RefusalKind | undefined): boolean {
  return refusal !== 'capability';
}

/**
 * Reasons that were written into the ledger as `tripwire` rows BEFORE the
 * distinction existed, and that are capability refusals.
 *
 * FROZEN HISTORY, NOT THE LIVE TEXT. The rows already on disk carry the reason
 * as it was worded when they were written, so this list has to keep that wording
 * even if the live refusal is reworded later. New capability refusals never
 * reach the ledger (`recordGateOutcome` writes no row for them), so nothing is
 * ever added here for a refusal born after 2026-10-12.
 *
 * Matched by PREFIX: the full reason is one long sentence and only its opening
 * clause is the identity of the refusal.
 */
export const LEGACY_CAPABILITY_TRIPWIRE_PREFIXES: readonly string[] = [
  // policy.ts `backgroundBashRefusal`, every real tripwire row up to 2026-10-12.
  'Backgrounding through Bash is not available',
];

/** Was this recorded tripwire reason actually a capability refusal? */
export function isLegacyCapabilityTripwire(reason: string | undefined): boolean {
  if (typeof reason !== 'string') return false;
  return LEGACY_CAPABILITY_TRIPWIRE_PREFIXES.some((p) => reason.startsWith(p));
}
