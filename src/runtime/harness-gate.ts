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
// The load-bearing invariants (contract §4 for (1)-(4); (5)-(7) were added as the
// scan, the delete and the install flow taught us what the first four were and
// were not saying), each implemented and labelled below:
//
//   (1) Imported (external) items NEVER auto-enable. `provenance.source ===
//       'external'` ⇒ the decision is at most `hold` with status:'disabled';
//       enabling requires an explicit user action (setHarnessEnabled). A
//       brand-new imported set is inert until reviewed. SEE (7) for the one
//       arrival this does not describe: a file installed into naby's OWN harness
//       home, where the explicit user action is the chat turn that put it there.
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
//   (5) A CONTENT REFRESH of an item the user already reviewed preserves that
//       row's status. `req.refresh` marks a re-read of the SAME file at the SAME
//       origin (the naby harness home re-scan); it may restate the body, never the
//       trust decision. This is not a hole in (1)/(3): a refresh only ever hands
//       back the STORED status, which nothing but setHarnessEnabled can have set,
//       and a brand-new row has no stored status to preserve so it still lands
//       disabled. A different origin claiming the same identity is a takeover,
//       not a refresh, and is gated normally (lands disabled).
//       THE TOMBSTONE RIDES THIS SAME RULE. A row the user deleted while its
//       source file stayed on disk is stored 'removed' (store.ts HarnessStatus),
//       and a refresh carries THAT through exactly like enabled/disabled — which
//       is what stops the re-scan of an edited artifact naby could not delete from
//       resurrecting a deletion. It is carried, never granted: see (6).
//   (6) 'removed' IS NEVER GRANTED, ONLY CARRIED. No import may REQUEST a
//       tombstone: `requestedStatus:'removed'` is read as 'disabled'. A tombstone
//       is a user action recorded by setHarnessStatus; an import that could ask
//       for one would be a way for written content to hide itself from the very
//       review UI that is supposed to show it. (5) is unaffected — it hands back
//       the STORED status, which only a user action can have set to 'removed'.
//   (7) A USER-DRIVEN ARRIVAL MAY LAND ENABLED — BUT ONLY AS A NEW ROW.
//       `req.autoEnable` says the caller has established that this artifact
//       arrived through an install the USER ASKED FOR: it sits under a naby
//       harness home, which is a directory nothing but naby writes and which the
//       skill-hub chat flow only writes to after a gated, visible turn the user
//       requested. That is a different fact from "these bytes are trustworthy",
//       and it is the fact (1)/(3) were always standing in for: a `~/.claude`
//       tree merely EXISTS on disk — nobody asked for it today — so an import out
//       of one still lands disabled, and so does a set import, and so does an
//       unknown origin. Only the caller that resolved the naby bases may set the
//       flag, and only for artifacts read from one.
//       ITS LIMITS ARE THE OTHER INVARIANTS, ALL OF WHICH STAND. It is checked
//       AFTER the (2) deny (a deny is absolute) and AFTER (5) (an EXISTING row's
//       status is the user's, and a re-scan may never restate it — a skill the
//       user disabled stays disabled however many times the tree is walked). It
//       applies to a row that does not exist yet, and only when the import asked
//       for 'enabled', so (6) still holds: 'removed' was already read as
//       'disabled' before this branch and can never be granted.
//       IT IS ALSO KILLABLE. The flag is off unless the shell's
//       'harness.autoEnableNabyHome' setting is on (default on); with it off, a
//       naby-home arrival behaves exactly as it did before — disabled until
//       reviewed. The gate does not read that setting: it is pure, and the caller
//       states the conclusion.

import type {
  HarnessImportDecision,
  HarnessImportRequest,
  HarnessItem,
  HarnessStatus,
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
  //
  // (6) An explicit 'removed' is read as 'disabled': a tombstone is a user
  // action (setHarnessStatus), never something an import may ask for. Written
  // here, once, so every branch below sees a requestable status.
  const asked = req.requestedStatus ?? 'disabled';
  const requested: HarnessStatus = asked === 'removed' ? 'disabled' : asked;

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

  // (5) CONTENT REFRESH — a re-read of the SAME file at the SAME origin restates
  // the body of a row the user has already ruled on, so it carries the STORED
  // status through instead of re-deciding it. Checked after the trust-ordering
  // deny (a deny stays absolute) and BEFORE the external rule, which would
  // otherwise pin 'disabled' and erase an explicit enable on every re-scan.
  //
  // The origin must MATCH: a different file claiming an existing (scope,scopeKey,
  // kind,name) is a takeover of that name, not a refresh of that item, and must
  // be gated as the new import it is. An existing row with no recorded origin has
  // nothing to match, so it likewise falls through.
  //
  // `existing.status` is handed back WHATEVER it is — enabled, disabled, or the
  // 'removed' tombstone. Carrying the tombstone is the point: the re-scan of an
  // artifact the user deleted (whose file naby does not own, so it is still on
  // disk) restates its body and leaves it deleted.
  if (
    req.refresh &&
    existing &&
    existing.provenance.origin !== undefined &&
    existing.provenance.origin === req.item.provenance.origin
  ) {
    return { behavior: 'allow', status: existing.status };
  }

  // (7) USER-DRIVEN ARRIVAL, NEW ROW ONLY. The caller has established that this
  // artifact's file sits under a naby harness home — a place it can only have
  // reached through an install the user asked for — and the kill switch is on, so
  // the requested 'enabled' is granted instead of being held for a second click
  // the user has no way to know is needed.
  //
  // `existing === undefined` is the load-bearing half of the condition, and it is
  // why this sits BELOW the refresh branch rather than above it: every path that
  // could move an ALREADY-REVIEWED row's status has already returned by here. A
  // row the user disabled is either refreshed (5, status carried) or, if its
  // origin changed, a takeover that falls through to (1)/(3) and lands disabled.
  // Neither can be turned back on by a scan.
  if (!existing && req.autoEnable === true && requested === 'enabled') {
    return { behavior: 'allow', status: 'enabled' };
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
