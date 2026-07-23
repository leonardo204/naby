// src/runtime/harness-gate.ts
//
// THE HARNESS IMPORT GATE (phase-1_6-harness-contracts §4, impl HP-01/HP-06).
//
// The harness analogue of the memory write gate (memory-gate.ts). An imported
// harness item — a teammate's skill, a `~/.claude` subagent, a shared set — is
// UNTRUSTED content that can carry prompt-injection or dangerous instructions
// (strategy D6; the harness twin of memory poisoning, OWASP ASI06). Every import
// clears this PURE, DETERMINISTIC gate BEFORE it can participate in a turn.
//
// It deliberately MIRRORS decideMemoryWrite and SHARES its trust ordering
// (trust.ts: user > artifact > external) so the two gates cannot drift apart.
//
// The four load-bearing invariants (contract §4), each implemented and labelled
// below:
//
//   (1) Imported (external) items NEVER auto-enable. `provenance.source ===
//       'external'` ⇒ the decision is at most `hold` with status:'disabled';
//       enabling requires an explicit user action (setHarnessEnabled). A
//       brand-new imported set is inert until reviewed.
//   (2) Trust ordering is FIXED: user > artifact > external. A lower-tier import
//       cannot overwrite a higher-tier ENABLED item without user action (deny).
//   (3) External imports always land DISABLED. Where memory blocks external
//       SCOPE ESCALATION, harness has no scope escalation — the analogous rule
//       is that an external import is never granted 'enabled' status (it can
//       only become enabled later via setHarnessEnabled). Enforced together with
//       (1): every external decision pins status:'disabled'.
//   (4) The gate is negative-tested: a simulated injection payload arriving via
//       `external` provenance must not produce an `enabled` row. (Enforced by
//       (1)+(3); asserted in the harness spike.)

import type {
  HarnessImportDecision,
  HarnessImportRequest,
  HarnessItem,
} from './store/store.js';
// The trust ordering (user > artifact > external) is factored into trust.ts and
// SHARED with the memory write-gate (memory-gate.ts) — the two gates rank
// provenance identically by construction (contract §4).
import { lowerTierThan } from './trust.js';

/**
 * Decide whether (and how) a harness import may land. Pure and deterministic.
 *
 * @param req       the requested import, carrying the item (with provenance) and
 *                  an optional requestedStatus the gate may downgrade.
 * @param existing  the row this import would overwrite (same scope/scopeKey/
 *                  kind/name), if any — needed for the trust-ordering invariant
 *                  (2).
 */
export function decideHarnessImport(
  req: HarnessImportRequest,
  existing?: HarnessItem,
): HarnessImportDecision {
  const source = req.item.provenance.source;
  // A missing requestedStatus defaults to the SAFE choice, 'disabled' — the
  // contract's "imported items default 'disabled'" (§3/§4).
  const requested = req.requestedStatus ?? 'disabled';

  // (2) TRUST ORDERING — a lower-tier import may not overwrite an ENABLED
  // higher-tier item without an explicit user action. (A same-or-higher tier
  // may; that is a legitimate update/supersede. An overwrite of a DISABLED item
  // is always fine — a disabled item is only a candidate.) Checked FIRST: a deny
  // here is absolute regardless of the requested status.
  if (
    existing &&
    existing.status === 'enabled' &&
    lowerTierThan(source, existing.provenance.source)
  ) {
    return {
      behavior: 'deny',
      reason: `a '${source}'-tier import may not overwrite an enabled '${existing.provenance.source}'-tier harness item without user action`,
    };
  }

  // (1)+(3) EXTERNAL NEVER AUTO-ENABLES / always lands disabled. A request to
  // enable is downgraded to a hold (it needs an explicit setHarnessEnabled); a
  // request to merely store disabled is allowed but pinned 'disabled'.
  if (source === 'external') {
    if (requested === 'enabled') {
      return {
        behavior: 'hold',
        status: 'disabled',
        reason:
          'external-origin harness must be user-enabled in review before it participates (auto-enable refused)',
      };
    }
    return { behavior: 'allow', status: 'disabled' };
  }

  // Trusted tiers (user/artifact): the requested status is honoured — a trusted
  // tier asking for 'enabled' is granted (a user creating/enabling their own
  // command), asking for 'disabled' stays disabled. The gate may only ever
  // DOWNGRADE, never upgrade past a request.
  return { behavior: 'allow', status: requested };
}
