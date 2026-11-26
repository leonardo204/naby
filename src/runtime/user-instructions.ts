/**
 * THE USER'S STANDING INSTRUCTIONS (specs/user-instructions.md).
 *
 * One free-text block the user writes once in Settings and naby reads on EVERY
 * turn, in every project and every session — the counterpart of a global
 * `CLAUDE.md` or a chat app's "custom instructions".
 *
 * WHY NOT A MEMORY. Memories are recalled by relevance, decay through tiers and
 * can be merged or retired by the memory worker; a rule like "always answer in
 * Korean and show the command before running it" has to be present on turn one
 * of every session, verbatim, and must never be rewritten by anything but the
 * user. Hence a setting, not a memory row.
 *
 * WHY NOT `~/.claude/CLAUDE.md`. naby runs the Agent SDK with
 * `settingSources: []` (engine-env.ts) on purpose, and the ai-sdk engines never
 * read such files at all. A store setting reaches every engine the same way.
 *
 * Stored as a plain string under one setting key; empty / whitespace-only means
 * "none" and injects nothing.
 */

import type { Store } from './store/store.js';

/** The setting key. One writer (`instructions.set`), one reader (the turn). */
export const USER_INSTRUCTIONS_KEY = 'instructions.global';

/**
 * Hard cap, in characters. The block rides on every turn, so it is paid for on
 * every turn; 8,000 characters is roughly 2–3k tokens — room for a real rule
 * list, not for pasting a manual. The writer refuses longer text rather than
 * truncating it silently, so the user never believes a rule is in force that
 * was cut off.
 */
export const USER_INSTRUCTIONS_MAX_CHARS = 8000;

/** The stored text, trimmed; '' when unset or unreadable. */
export function readUserInstructions(store: Pick<Store, 'getSetting'>): string {
  try {
    return (store.getSetting(USER_INSTRUCTIONS_KEY) ?? '').trim();
  } catch {
    return '';
  }
}

export type WriteUserInstructionsResult =
  | { ok: true; text: string }
  | { ok: false; error: 'not-a-string' | 'too-long' };

/**
 * Store the text (trimmed). Line endings are normalised to `\n` so the same
 * rules typed on Windows and macOS produce the same prompt bytes.
 */
export function writeUserInstructions(
  store: Pick<Store, 'setSetting'>,
  value: unknown,
): WriteUserInstructionsResult {
  if (typeof value !== 'string') return { ok: false, error: 'not-a-string' };
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (text.length > USER_INSTRUCTIONS_MAX_CHARS) return { ok: false, error: 'too-long' };
  store.setSetting(USER_INSTRUCTIONS_KEY, text);
  return { ok: true, text };
}

/**
 * The system-prompt block, or undefined when there is nothing to say.
 *
 * The framing does two jobs. It tells the model these come from the USER (not
 * from a tool result or a participant), so they outrank naby's learned style
 * and defaults. And it states the one thing they cannot do: lift a safety rule
 * or a switch — the gate enforces those in code anyway, but a model told
 * "always run commands without asking" should say why it still has to ask
 * instead of pretending it tried.
 */
export function userInstructionsBlock(text: string | undefined): string | undefined {
  const body = (text ?? '').trim();
  if (!body) return undefined;
  return [
    "## The user's standing instructions",
    'The user wrote these in Settings for every project and every session. Follow them on every turn; ' +
      "where they conflict with naby's learned style or defaults, they win. They do not lift safety rules, " +
      "the permission gate or a switch the user turned off — if a rule asks for that, say which switch holds you back.",
    '',
    body,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Keeping the instructions in force in a LONG session (2026-11-26)
// ---------------------------------------------------------------------------
//
// The block above sits at the END of the system prompt — the START of the
// model's context. In a long session hundreds of thousands of tokens of
// conversation follow it, while this turn's own context (org hooks, round
// progress, memory) rides next to the newest message. The model follows what
// is near, and its own recent replies, so the standing instructions faded
// ("세션이 길어지면 간혹 잊어버린다"). The fix keeps the system-prompt block and
// ALSO reminds the model next to the newest message: a one-line pointer every
// turn, and the full text every `USER_INSTRUCTIONS_FULL_EVERY` turns — the
// full text on every turn would add ~1k tokens to the stored history each
// time.
//
// And the instructions reached only naby's own turns. Participants, delegated
// subagents and the review loop's reviewers and fixers work for the same user
// and never saw them; `delegatedInstructionsBlock` is their version.

/** A long session repeats the full text next to the newest message this often
 *  (counted in the user's own messages). */
export const USER_INSTRUCTIONS_FULL_EVERY = 8;

/** The heading every version of the block starts with — also how the
 *  idempotent appender recognises a prompt that already carries one. */
export const USER_INSTRUCTIONS_HEADING = "## The user's standing instructions";

/**
 * This turn's reminder, for the per-turn context next to the newest message.
 * `userTurns` = the user's own messages in the session, this one included.
 * Undefined when there are no instructions or on the session's first turn (the
 * system prompt is right there). The full text on every
 * `USER_INSTRUCTIONS_FULL_EVERY`-th turn, a one-line pointer otherwise.
 */
export function userInstructionsReminder(text: string | undefined, userTurns: number): string | undefined {
  const body = (text ?? '').trim();
  if (!body || userTurns <= 1) return undefined;
  if (userTurns % USER_INSTRUCTIONS_FULL_EVERY === 0) {
    return [
      `${USER_INSTRUCTIONS_HEADING} (reminder)`,
      'Still in force on this turn, however long the conversation has run — the same text as in your system prompt. ' +
        'If your recent replies drifted from them, follow them again from this reply on.',
      '',
      body,
    ].join('\n');
  }
  return (
    "Reminder: the user's standing instructions (\"" +
    USER_INSTRUCTIONS_HEADING.replace(/^## /, '') +
    '" in your system prompt) apply to this reply too.'
  );
}

/**
 * The block for anyone naby puts to work for the user — a participant, a
 * delegated subagent, a reviewer or fixer. The same text; the framing says the
 * rules about naby's own role apply only where they fit.
 */
export function delegatedInstructionsBlock(text: string | undefined): string | undefined {
  const body = (text ?? '').trim();
  if (!body) return undefined;
  return [
    USER_INSTRUCTIONS_HEADING,
    'The user wrote these in Settings for naby and for everyone who works for them in naby — that includes you. ' +
      'Follow them in what you write and do (language, tone, format, how to check and report). ' +
      'A rule about naby\'s own role applies to you only where it fits your task. ' +
      'Your task and the rules above them still decide what you may do; these do not lift safety rules or the permission gate.',
    '',
    body,
  ].join('\n');
}

/** `prompt` with the delegated block appended — unless it already carries one. */
export function withDelegatedInstructions(prompt: string | undefined, text: string | undefined): string | undefined {
  const block = delegatedInstructionsBlock(text);
  if (!block) return prompt;
  if (prompt && prompt.includes(USER_INSTRUCTIONS_HEADING)) return prompt;
  return prompt ? `${prompt}\n\n${block}` : block;
}
