// src/runtime/compaction.ts
//
// ROLLING COMPACTION — the PURE half (specs/session-context-management.md §2.3).
//
// The AI-SDK engine builds its own payload from our stored transcript, and until
// now it built ALL of it: a long conversation grew until the provider rejected the
// turn outright. This module decides what to send instead. It performs no I/O,
// calls no model and holds no state, so the decision can be asserted directly —
// which matters, because the failure it prevents only shows up on a conversation
// too long to reproduce by hand.
//
// THE ONE INVARIANT THAT OUTRANKS EVERYTHING HERE: the STORED transcript is never
// touched. Folding happens to the OUTGOING PAYLOAD only. A user scrolling back
// must still find every word they said, on any engine, after any restart — and a
// session that folded on the AI-SDK engine must replay in full if it is continued
// on the Agent SDK one (contract §6). Everything below returns a plan; nothing
// below writes.

import type { RuntimeMessage } from './engine.js';

/**
 * Characters per token, the crude way.
 *
 * WHY AN ESTIMATE AT ALL, when the last turn reported an exact figure: the exact
 * figure describes the payload we ALREADY sent, and this decision is about the one
 * we are about to build — which contains messages nobody has counted yet. A real
 * tokenizer would be a per-provider dependency (three of the five providers do not
 * even publish one) for a number whose only use is picking a fold point.
 *
 * 3.5 is deliberately PESSIMISTIC for English (~4 chars/token) and roughly right
 * for Korean, which is the language most of this app's conversations happen in.
 * Overestimating folds slightly early; underestimating would let a turn overflow
 * the window, which is the failure this exists to prevent.
 */
export const CHARS_PER_TOKEN = 3.5;

/** The share of the window at which we start folding (§2.3). Below it, nothing
 *  happens at all and the payload is byte-for-byte the pre-compaction one. */
export const FOLD_THRESHOLD = 0.7;

/**
 * The share of the window the FOLDED payload is aimed at. Lower than the trigger
 * on purpose: folding down to exactly 70% would put the next turn straight back
 * over the line and re-fold every single turn from then on.
 */
export const FOLD_TARGET = 0.45;

/** The tail is never emptied. A payload of "here is a summary, now answer" with no
 *  recent turns loses the thread the user is actually mid-way through, which is a
 *  worse outcome than a slightly-too-large request. */
export const MIN_TAIL_MESSAGES = 6;

/** Approximate token count of one message, including its tool payloads. */
export function estimateMessageTokens(m: RuntimeMessage): number {
  let chars = 0;
  if (m.role === 'tool') {
    chars += m.toolName.length + m.output.content.length;
  } else {
    chars += m.content.length;
    if (m.role === 'assistant' && m.toolCalls) {
      for (const c of m.toolCalls) {
        chars += c.toolName.length;
        try {
          chars += JSON.stringify(c.input ?? {}).length;
        } catch {
          // A non-serializable input is vanishingly rare and its size is not worth
          // a throw in a sizing helper; count the name alone.
        }
      }
    }
  }
  // Per-message envelope (role, framing, separators) that every provider adds.
  return Math.ceil(chars / CHARS_PER_TOKEN) + 4;
}

/** Approximate token count of a whole payload — history plus the system prompt,
 *  which is part of the window even though it is not a message. */
export function estimateTokens(
  messages: readonly RuntimeMessage[],
  system?: string,
): number {
  let total = system ? Math.ceil(system.length / CHARS_PER_TOKEN) : 0;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

/**
 * A tool RESULT cannot be sent without the assistant tool CALL that produced it —
 * every provider rejects the orphan, which is the same pairing rule the store
 * upholds (session.ts). So a fold boundary is only legal where the tail does not
 * start on a dangling `role:'tool'` message.
 *
 * Returns the first index at or after `from` that is a legal boundary.
 */
export function legalFoldBoundary(
  messages: readonly RuntimeMessage[],
  from: number,
): number {
  let i = Math.max(0, Math.min(from, messages.length));
  while (i < messages.length && messages[i]?.role === 'tool') i += 1;
  return i;
}

export type FoldPlan =
  | { fold: false; estimatedTokens: number }
  | {
      fold: true;
      /** How many LEADING messages are folded away. */
      foldedCount: number;
      /** The messages that survive verbatim (the recent tail). */
      tail: RuntimeMessage[];
      /** The messages being folded — what a summary must be written FROM. */
      folded: RuntimeMessage[];
      /** The pre-fold estimate, for the log/pill. */
      estimatedTokens: number;
    };

/**
 * Decide whether to fold, and where.
 *
 * The rule: if the estimate exceeds `threshold` of the budget, drop leading
 * messages until the SURVIVING tail fits `target` of the budget — then move the
 * boundary forward to the next legal one (never splitting a tool call from its
 * result) and keep at least `MIN_TAIL_MESSAGES`.
 *
 * A conversation whose recent tail ALONE is over budget still folds everything it
 * legally can; the payload is then as small as this mechanism can make it, and the
 * remaining overflow is the provider's to report. Silently dropping the newest
 * turns to force a fit would answer the user's question with someone else's
 * context.
 */
export function planFold(
  messages: readonly RuntimeMessage[],
  budget: number,
  opts: { system?: string; threshold?: number; target?: number; minTail?: number } = {},
): FoldPlan {
  const threshold = opts.threshold ?? FOLD_THRESHOLD;
  const target = opts.target ?? FOLD_TARGET;
  const minTail = opts.minTail ?? MIN_TAIL_MESSAGES;
  const estimatedTokens = estimateTokens(messages, opts.system);

  if (budget <= 0 || estimatedTokens <= budget * threshold) {
    return { fold: false, estimatedTokens };
  }
  if (messages.length <= minTail) {
    // Nothing may be folded without emptying the tail below its floor.
    return { fold: false, estimatedTokens };
  }

  const targetTokens = budget * target;
  const maxFold = messages.length - minTail;

  // Walk forward from the oldest message, accumulating what would be dropped,
  // until the remainder fits the target.
  let remaining = estimatedTokens;
  let cut = 0;
  while (cut < maxFold && remaining > targetTokens) {
    remaining -= estimateMessageTokens(messages[cut]!);
    cut += 1;
  }

  const boundary = Math.min(legalFoldBoundary(messages, cut), maxFold);
  if (boundary <= 0) return { fold: false, estimatedTokens };

  return {
    fold: true,
    foldedCount: boundary,
    tail: messages.slice(boundary),
    folded: messages.slice(0, boundary),
    estimatedTokens,
  };
}

/** The label the folded block carries into the payload. Named rather than
 *  disguised: the model is told these are compressed earlier turns, not that they
 *  are something the user just said. */
export const FOLDED_BLOCK_HEADER =
  'Earlier in this conversation (compressed summary of messages that were folded ' +
  'out of this request to fit the context window — treat as background, do not ' +
  'answer it again):';

/** Render the summary as the single user-role message that stands in for the
 *  folded range. A user role (not assistant) because it is CONTEXT handed to the
 *  model, not something the model said — and because `ai@7` rejects `role:'system'`
 *  inside `messages` (contract §6). */
export function foldedSummaryMessage(summaryText: string): RuntimeMessage {
  return { role: 'user', content: `${FOLDED_BLOCK_HEADER}\n\n${summaryText}` };
}

/**
 * THE HONEST FALLBACK. When the summary could not be generated (the extra model
 * call failed, timed out, or came back empty), the oldest turns are dropped with a
 * stated marker instead of quietly vanishing.
 *
 * Honesty beats silence: the model is told a piece of the conversation is missing,
 * so it can ask rather than confidently answer from a hole. The user is told too,
 * by the same system pill the summary path emits.
 */
export const TRUNCATION_NOTICE =
  'Note: earlier messages in this conversation were dropped to fit the context ' +
  'window, and no summary of them could be produced. If something references ' +
  'material you cannot see, say so and ask rather than guessing.';

export function truncationNoticeMessage(droppedCount: number): RuntimeMessage {
  return {
    role: 'user',
    content: `${TRUNCATION_NOTICE} (${droppedCount} earlier message${droppedCount === 1 ? '' : 's'} dropped)`,
  };
}

// ---------------------------------------------------------------------------
// The summary REQUEST (the model call itself lives in the engine)
// ---------------------------------------------------------------------------

/** How much of the folded range is fed to the summarizer. A cap, because the
 *  whole point of this call is to make a payload smaller — a summariser call that
 *  itself overflows the window is a loop that fails twice. Chars, not tokens: the
 *  input is being trimmed, not measured. */
export const SUMMARY_INPUT_MAX_CHARS = 24_000;

/** The summary itself is a compact block injected into EVERY later turn, so it is
 *  bounded too. */
export const SUMMARY_MAX_CHARS = 4_000;

export const SUMMARY_SYSTEM_PROMPT =
  'You compress a conversation so it can be carried forward in a smaller context ' +
  'window. Write a dense summary of what matters for continuing: decisions that ' +
  'were agreed, work in progress and its current state, open questions, and any ' +
  'facts, names, paths or numbers that later turns will need. Preserve the ' +
  "conversation's language. No preamble, no closing remark, no invitation to " +
  'continue — output the summary text and nothing else.';

/**
 * Render the folded range (and any previous summary it extends) as the user half
 * of the summariser call.
 *
 * EXTENDING RATHER THAN RE-READING is what keeps this cheap on a long session: the
 * previous summary already covers its own prefix, so only the newly folded turns
 * are sent alongside it.
 */
export function buildSummaryPrompt(
  folded: readonly RuntimeMessage[],
  previous?: string,
): string {
  // The previous summary is kept OUT of the trimmable body. It is the compressed
  // record of everything older than the messages below it, so trimming it away —
  // which a front-trim of one combined string does, since it sits at the front —
  // would silently turn an EXTEND into a fresh summary of the newest slice only,
  // and the older half of the conversation would vanish from every later turn.
  const head = previous
    ? [
        'Summary of the conversation so far (extend it; keep what still matters):',
        previous,
        '',
        'Newer messages to fold into it:',
      ].join('\n')
    : 'Messages to summarize:';

  const lines: string[] = [];
  for (const m of folded) {
    if (m.role === 'tool') {
      lines.push(`Tool ${m.toolName}${m.output.isError ? ' (failed)' : ''}: ${m.output.content}`);
    } else if (m.role === 'assistant') {
      const calls = m.toolCalls?.length
        ? ` [called: ${m.toolCalls.map((c) => c.toolName).join(', ')}]`
        : '';
      lines.push(`Assistant: ${m.content}${calls}`);
    } else {
      lines.push(`User: ${m.content}`);
    }
  }
  const body = lines.join('\n');
  // Trim the MESSAGES from the FRONT: the newest folded turns are the ones the
  // surviving tail depends on. The head above is never trimmed (see its note).
  const trimmed =
    body.length > SUMMARY_INPUT_MAX_CHARS
      ? `…(older material trimmed)…\n${body.slice(body.length - SUMMARY_INPUT_MAX_CHARS)}`
      : body;
  return `${head}\n${trimmed}`;
}

/** Bound and tidy whatever the summariser returned. Empty in, empty out — the
 *  caller treats an empty summary as a failed generation and truncates instead. */
export function normalizeSummary(text: string | undefined): string {
  const trimmed = (text ?? '').trim();
  return trimmed.length > SUMMARY_MAX_CHARS ? trimmed.slice(0, SUMMARY_MAX_CHARS) : trimmed;
}
