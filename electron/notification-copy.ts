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
//
// WHY A COUNT IS COMPUTED HERE AND NOT SENT ACROSS THE BRIDGE. The banner now
// says how many runs finished, and the obvious shortcut — let the renderer pass
// the number — would breach the rule above by degrees: a count is one more field
// the page controls, and "17 conversations finished" is a sentence it authored.
// So the renderer keeps sending exactly one bounded label per finished run, main
// TALLIES those calls (`addRunFinished`), and the tally reaches the words here.
// The reducer lives in this file rather than beside the `Notification` instance
// because it is the part that is decidable without a compositor, and therefore
// the part `npm run spike:notify` can assert.

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

/** The catalogue. `title` is fixed; `body` takes the sanitized label (or its own
 *  fallback when there is none) and how many runs the one live banner now stands
 *  for.
 *
 *  ONE finished run must still read like one finished run. The count is not
 *  printed at all when it is 1, because "1 conversations finished" is the tell
 *  that a machine wrote the sentence — and this is the case the user sees most.
 *  Above 1 the banner leads with the number, because THAT is the news; the label
 *  names only the most recent, which is why it is introduced as "latest". */
const COPY: Record<
  NotifyKind,
  Record<NotifyLocale, { title: string; body: (label: string, count: number) => string }>
> = {
  'session-done': {
    en: {
      title: 'naby has an update',
      body: (label, count) => {
        if (count > 1) {
          return label
            ? `${count} conversations finished — latest: ${label}`
            : `${count} conversations finished while you were away.`;
        }
        return label ? `Finished: ${label}` : 'A conversation finished while you were away.';
      },
    },
    ko: {
      title: '나비가 알려드릴 게 있어요',
      body: (label, count) => {
        if (count > 1) {
          return label
            ? `대화 ${count}개가 끝났어요 — 마지막: ${label}`
            : `자리를 비운 사이에 대화 ${count}개가 끝났어요.`;
        }
        return label ? `작업이 끝났어요: ${label}` : '자리를 비운 사이에 작업이 끝났어요.';
      },
    },
  },
};

/**
 * What the ONE live banner currently stands for: how many runs have finished
 * since the user last saw it, and what to call the most recent of them.
 *
 * The main process keeps exactly one of these, next to the one `Notification`
 * instance, because that is the only place it can live — the renderer cannot
 * hold a `Notification`, and a count kept per-window would restart every time a
 * window closed.
 */
export interface RunsFinishedState {
  /** Runs finished since the last reset. 0 means there is nothing to show. */
  count: number;
  /** The most recent run's already-sanitized label. May be empty. */
  label: string;
}

/** Nothing has finished — the state after a reset, and before the first run. */
export const NO_RUNS_FINISHED: RunsFinishedState = { count: 0, label: '' };

/**
 * Fold one more finished run into the live banner's state.
 *
 * THE NEWEST LABEL WINS, including when it is empty. The copy above calls the
 * label "latest", so carrying a previous run's title forward would make the
 * banner name the wrong conversation — a banner that is quietly wrong is worse
 * than one that falls back to counting.
 *
 * Returns a NEW object; the caller decides when to adopt it, exactly as
 * `rememberStatuses` does on the renderer side.
 */
export function addRunFinished(
  state: RunsFinishedState,
  label: string,
): RunsFinishedState {
  return { count: asNotifyCount(state.count + 1), label };
}

/** Whether this state has anything to put on screen. */
export function hasRunsToReport(state: RunsFinishedState): boolean {
  return state.count > 0;
}

/** Clamp whatever arrives to a whole, positive, sayable number of runs. Main
 *  owns the tally so this should never fire — but a banner reading "NaN
 *  conversations finished" would be an OS-drawn box with this app's name on it,
 *  and the cost of not being able to produce one is a single `Math` call. */
export function asNotifyCount(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : 1;
  return n < 1 ? 1 : n;
}

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
 *  this is decidable without an OS.
 *
 *  `count` is REQUIRED rather than defaulted to 1: every call site now has a
 *  tally to hand over, and a default would let a new one silently render the
 *  singular sentence for a banner standing in for ten runs. */
export function notificationCopy(
  kind: NotifyKind,
  locale: NotifyLocale,
  label: string,
  count: number,
): { title: string; body: string } {
  const entry = COPY[kind][locale];
  return { title: entry.title, body: entry.body(label, asNotifyCount(count)) };
}
