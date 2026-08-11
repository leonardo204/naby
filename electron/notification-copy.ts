// electron/notification-copy.ts
//
// WHAT AN OS NOTIFICATION IS ALLOWED TO SAY — and nothing about how it is shown.
//
// Split out of `notifications.ts` so it imports NOTHING (not even `electron`),
// for the same reason the runtime separates pure rules from IO: the words on a
// banner and the guard on what may become one are decidable without a compositor,
// a notification daemon or a display server, and therefore testable
// (`npm run spike:notify`).
//
// WHY THE WORDS LIVE IN THE MAIN PROCESS AT ALL. Preload's founding rule is one
// named function per channel and no generic escape hatch, precisely so the
// reachable IPC surface is auditable by reading it. A channel that took a title
// and a body would hand any script that achieves execution in the page a
// system-level banner generator — an OS-drawn, app-branded box saying whatever it
// liked. So the renderer picks a KIND from this catalogue and supplies one
// bounded label; it cannot author a sentence.

/**
 * The messages this app is allowed to put on the desktop. An enum, because the
 * renderer picks from it — a string it supplied would be a sentence it authored.
 */
export type NotifyKind = 'session-done';

/** The two languages the app ships (shared/i18n). Anything else falls back to
 *  English rather than failing: a wrong-language banner is recoverable, no
 *  banner is the bug this feature exists to fix. */
export type NotifyLocale = 'en' | 'ko';

/** Longest label that reaches the OS. A banner truncates anyway; doing it here
 *  means the cut is ours and predictable. */
export const NOTIFY_LABEL_MAX = 80;

/** The catalogue. `title` is fixed; `body` takes the sanitized label, or its
 *  own fallback when there is none. */
const COPY: Record<
  NotifyKind,
  Record<NotifyLocale, { title: string; body: (label: string) => string }>
> = {
  'session-done': {
    en: {
      title: 'naby has an update',
      body: (label) =>
        label ? `Finished: ${label}` : 'A conversation finished while you were away.',
    },
    ko: {
      title: '나비가 알려드릴 게 있어요',
      body: (label) => (label ? `작업이 끝났어요: ${label}` : '자리를 비운 사이에 작업이 끝났어요.'),
    },
  },
};

/**
 * Make a label safe to hand to the OS: no control characters, no newlines, one
 * run of spaces, bounded length.
 *
 * THE LABEL IS TREATED AS HOSTILE, because it is model- and user-authored text.
 * A raw newline in a banner is a second line the app did not write; a bidi
 * override is a line that reads backwards. A notification is not a place to
 * render content, it is a place to NAME it.
 */
export function sanitizeLabel(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const flat = raw
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= NOTIFY_LABEL_MAX) return flat;
  return `${flat.slice(0, NOTIFY_LABEL_MAX - 1)}…`;
}

/** Narrow whatever crossed the bridge to a locale we have words for. */
export function asNotifyLocale(raw: unknown): NotifyLocale {
  return raw === 'ko' ? 'ko' : 'en';
}

/** Whether a value names a message in the catalogue. An unknown kind is a
 *  REFUSAL upstream, not a fallback: falling back would let a caller reach the
 *  catalogue by guessing. */
export function isNotifyKind(raw: unknown): raw is NotifyKind {
  return raw === 'session-done';
}

/** The exact strings a given request produces. Pure — the whole point is that
 *  this is decidable without an OS. */
export function notificationCopy(
  kind: NotifyKind,
  locale: NotifyLocale,
  label: string,
): { title: string; body: string } {
  const entry = COPY[kind][locale];
  return { title: entry.title, body: entry.body(label) };
}
