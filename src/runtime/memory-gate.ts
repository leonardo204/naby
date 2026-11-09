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
  MemoryScope,
  MemoryWriteDecision,
  MemoryWriteRequest,
  TrustTier,
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
      // Worded for the model that tried the write (it comes back as the tool
      // error): what it cannot do, and the two ways forward.
      reason:
        'text that came from a web page or tool output cannot be saved as a lasting memory about the user. ' +
        'Save it to the project scope, or ask the user to state it themselves.',
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
      reason:
        `the user already confirmed a memory under "${req.key}", and naby cannot overwrite it. ` +
        'Use a different key, or tell the user they can edit or delete it in Settings → Memory (설정 → 기억).',
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

// ---------------------------------------------------------------------------
// MEMORY AUTO-APPLY — the evidence rule (specs/memory-auto-apply.md §2)
// ---------------------------------------------------------------------------
//
// `decideMemoryWrite` above answers "may this write LAND, and as what at most?".
// The function below answers the question that comes BEFORE it: "what should the
// caller ASK for?" — whether a memory naby just learned may be put to use without
// a person clicking anything, and on which trust tier.
//
// IT IS CODE, NOT A MODEL, for the reason the gate is: eligibility is the part of
// the decision an injected instruction would most like to win. The model review
// that follows (§2a) can only ever LOWER what this decides (R40).
//
// The four invariants above are untouched (R6). An `external` answer here still
// meets invariant (1) inside putMemory, and an `external` write to `user` scope
// is still denied by invariant (3) — this function cannot route around either,
// because it only chooses the REQUEST.

/** The shortest quote that can carry evidence. One or two characters would match
 *  almost any message by accident, which would make the check decorative. */
export const MIN_EVIDENCE_CHARS = 4;

/** Normalize a quote for the substring test: collapse whitespace so a model that
 *  re-wraps a multi-line quote is not punished for the line breaks, while every
 *  actual WORD still has to be the user's. */
export function normalizeEvidenceQuote(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The user message a quote was copied from, or undefined (R2).
 *
 * THE ONE QUOTE CHECK. Session reflection validates its proposals with it and
 * `naby_remember` validates its `evidenceQuote` with it, so "did the user say
 * this" has one answer whichever path learned the fact. The caller supplies only
 * messages the user TYPED (`isUserAuthored`): a harness-written row, another
 * session's request and a participant hand-off never reach this function, so a
 * quote taken from one of them simply finds nothing.
 */
export function locateEvidenceQuote<M extends { text: string }>(
  quote: unknown,
  messages: readonly M[],
): M | undefined {
  const needle = normalizeEvidenceQuote(typeof quote === 'string' ? quote : '');
  if (needle.length < MIN_EVIDENCE_CHARS) return undefined;
  return messages.find((m) => normalizeEvidenceQuote(m.text).includes(needle));
}

/** What the evidence check found (R2). `none` = no quote was given. */
export type EvidenceQuoteCheck = 'verified' | 'fabricated' | 'none';

/** Stated by the user, or inferred by naby (R1). */
export type MemoryBasis = 'stated' | 'inferred';

/** Why a write is held for a person (R11) — a CODE the chat renders per locale. */
export type MemoryHoldReason =
  /** external content entered the turn before the write (R3 row 5, R4) */
  | 'external'
  /** a `user`-scope fact with no quote (R3 row 4, R5) */
  | 'user-scope-unquoted'
  /** the quote is not in anything the user typed (R3 row 6) */
  | 'unverified-quote'
  /** `memory.autoApply` is off (R8) */
  | 'auto-apply-off';

export type MemoryActivationInput = {
  scope: MemoryScope;
  basis?: MemoryBasis;
  quote: EvidenceQuoteCheck;
  /** External content entered this turn before the write (R4). */
  externalTurn: boolean;
  /** `memory.autoApply` (R8). */
  autoApply: boolean;
};

/** The request a write should make: the status it may reach (after review) and
 *  the trust tier it is written on. */
export type MemoryActivation =
  | { status: 'confirmed'; source: TrustTier }
  | { status: 'proposed'; source: TrustTier; holdReason: MemoryHoldReason };

/**
 * The evidence rule (R3), as one total function. Pure and deterministic.
 *
 * `confirmed` means "may become confirmed once the model review passes" (§2a) —
 * the caller writes the row `proposed` + review-pending either way.
 *
 * THE ORDER IS THE SPEC'S TABLE, with one choice the table leaves open: a quote
 * that FAILED the check in a turn where external content arrived reads as
 * `external`, not `artifact`. That is the indirect-injection shape exactly — a
 * web page telling the model to "remember" something and to cite a sentence the
 * user never typed — and the stricter tier is the one that can never reach
 * `user` scope (invariant 3). A VERIFIED quote wins over the external flag (rows
 * 1–2): the words are the user's own, whatever else the turn read (R9 names the
 * residual risk of the user pasting a page in, and accepts it).
 */
export function decideMemoryActivation(input: MemoryActivationInput): MemoryActivation {
  // R8: OFF IS THE OLD BEHAVIOUR EXACTLY — every write a proposal on the
  // artifact tier, the confirm button the only way in.
  if (!input.autoApply) return { status: 'proposed', source: 'artifact', holdReason: 'auto-apply-off' };

  if (input.quote === 'verified') {
    // Rows 1–2. `basis` only picks the tier (R7): the user's own statement is
    // `user`, naby's reading of what they said is `artifact`.
    return { status: 'confirmed', source: input.basis === 'stated' ? 'user' : 'artifact' };
  }
  // Row 5 (and a failed quote in an external turn — see above).
  if (input.externalTurn) return { status: 'proposed', source: 'external', holdReason: 'external' };
  // Row 6: a quote nobody typed.
  if (input.quote === 'fabricated') {
    return { status: 'proposed', source: 'artifact', holdReason: 'unverified-quote' };
  }
  // Row 4 (R5): a fact about the USER must come from the user's words.
  if (input.scope === 'user' || input.scope === 'org') {
    return { status: 'proposed', source: 'artifact', holdReason: 'user-scope-unquoted' };
  }
  // Row 3: project/session conventions naby picked up in a clean turn.
  return { status: 'confirmed', source: 'artifact' };
}

/** Built-in tools whose RESULT is someone else's words (R4). Bare names. */
const EXTERNAL_CONTENT_TOOLS: ReadonlySet<string> = new Set([
  // the web
  'WebFetch',
  'WebSearch',
  'fetch_url',
  // a subagent's or delegated run's output (its words, not the user's)
  'Task',
  'Agent',
  'naby_delegate',
  // another project's files (cross-project-context)
  'naby_read_project',
]);

/**
 * DID THIS TOOL BRING SOMEONE ELSE'S WORDS INTO THE TURN? (R4) — the ONE
 * predicate. The engine asks it of every tool call and carries a per-turn flag;
 * `naby_remember` reads the flag. Reading the current project's own files is NOT
 * external (R4) — those are the user's workspace.
 *
 * MCP tools are external whatever they do: naby cannot see inside one, and a
 * server that returns a web page or a ticket body looks exactly like one that
 * returns a timestamp. They arrive namespaced `<server>__<tool>` (runtime/mcp.ts)
 * or, from a backend's own MCP, `mcp__<server>__<tool>` — except naby's own
 * in-process `nabytools` server, which is how the runtime tools (naby_remember
 * itself among them) reach the Claude engine. Browser tools are matched by name
 * because they may come from either side.
 */
export function isExternalContentTool(name: string): boolean {
  if (!name) return false;
  if (name.startsWith('mcp__nabytools__')) {
    return isExternalContentTool(name.slice('mcp__nabytools__'.length));
  }
  if (EXTERNAL_CONTENT_TOOLS.has(name)) return true;
  if (/browser|playwright|chrome/i.test(name)) return true;
  if (name.startsWith('mcp__')) return true;
  return name.includes('__');
}
