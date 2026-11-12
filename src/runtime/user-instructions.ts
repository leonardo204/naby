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
