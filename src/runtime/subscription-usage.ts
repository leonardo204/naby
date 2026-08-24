// src/runtime/subscription-usage.ts
//
// HOW MUCH OF THE SUBSCRIPTION IS LEFT, AS A THING YOU CAN ASK FOR — the pure
// half (specs/claude-multi-account.md §3.3, §4; specs/session-context-management
// .md §2.1 for the display doctrine this reuses).
//
// WHY THIS EXISTS BESIDE `rate_limit`, RATHER THAN INSTEAD OF IT. The engine's
// `rate_limit` EventKind is a PUSH: the backend says "you are being throttled",
// mid-turn, about ONE window, and only when it decides the information changed.
// It carries `status` (allowed / allowed_warning / rejected), which is the one
// thing a push can tell you and a poll cannot — and it is useless for the
// question the status bar actually gets asked, which is "how much have I got
// left right now", before a turn, for BOTH windows at once. The two are
// complementary and both are kept. Nothing here replaces or reads that event.
//
// THE UNITS ARE THE WHOLE HAZARD OF THIS FILE, so they are named in the types
// and converted exactly once, here:
//
//   * `utilizationPercent` IS ALREADY A PERCENTAGE, 0-100. It is NOT the
//     `utilization` that rides on a `rate_limit_event` — that one is
//     undocumented, has never been observed arriving, and the client's
//     `rateLimitUtilizationPercent` multiplies it by 100 on the assumption that
//     it is a 0..1 fraction. Both sources here document 0-100 and both have been
//     OBSERVED at 0-100 (a live `.hud_cache` read 5 and 84). Handing one of these
//     to that function would render 84 as `8400%`. The field is named for its
//     scale so the mistake has to be typed out in full to be made.
//   * `resetsAt` IS UNIX **SECONDS**, matching the `rate_limit` event's contract
//     exactly, so the client's single existing conversion (`rateLimitResetsAtMs`)
//     serves both paths. Both sources send ISO 8601 strings; `isoToUnixSeconds`
//     below is the only place that conversion happens.
//
// EVERYTHING HERE IS PURE AND TAKES `unknown`. That is not test scaffolding: the
// SDK call these shapes come from is literally named
// `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`, the other source
// is a cache file owned by a different program, and neither can be driven to a
// chosen percentage on demand. Captured fixtures are the ONLY way any of this is
// ever exercised — the same argument `describeRateLimit` makes about itself — so
// the parsers must accept `unknown` and must not import a vendor type.
//
// AND THE DOCTRINE THE WHOLE FILE OBEYS: absent is a legitimate answer, and it is
// never a zero. A window we could not read is omitted, not defaulted — a `0` here
// would tell the user "your window just reset" when the truth is "we could not
// find out". `0` is a real reading and is deliberately distinguishable from
// absence, which is why every optional is `undefined` and never a falsy number.

/**
 * WHICH READING THIS IS, kept on the window rather than on the envelope.
 *
 * The merge below picks a WINNER PER WINDOW, so after it runs the two windows in
 * one result can legitimately come from different places. Recording it per window
 * is what lets the display say so honestly instead of implying a single origin.
 *
 * `sdk` — the Agent SDK's own usage query, asked through the session naby
 *   authenticated, so it is per-account correct by construction.
 * `cli` — Claude Code's own already-fetched cache of the same numbers.
 */
export type SubscriptionUsageSource = 'sdk' | 'cli';

/** One rate-limit window. Both readings are optional and independently so: the
 *  backend sends `utilization: null` and `resets_at: null` in the same object,
 *  and either can be the only thing present. */
export type SubscriptionUsageWindow = {
  /** 0-100, ALREADY A PERCENTAGE. See the header. May exceed 100 on overage and
   *  is deliberately not clamped — a clamp would hide the one state the number
   *  most needs to be able to report. */
  utilizationPercent?: number;
  /** UNIX **SECONDS**. See the header. */
  resetsAt?: number;
  source: SubscriptionUsageSource;
};

/**
 * The account's usage, as far as we could find out.
 *
 * DECLARED FLAT AND VENDOR-FREE, for the same reason the `rate_limit` event is
 * (runtime/engine.ts): this is the runtime, the runtime is what makes a provider
 * swappable, and a type imported from one vendor's package would put that vendor
 * in the definition of every consumer. Any engine that learns of usage windows
 * can fill these fields; the ai-sdk and mock engines never will, and their
 * absence is the ordinary case rather than an error.
 */
export type SubscriptionUsage = {
  /** The 5-hour window. */
  fiveHour?: SubscriptionUsageWindow;
  /** The rolling 7-day window. */
  sevenDay?: SubscriptionUsageWindow;
  /**
   * THE SUB-WINDOWS, KEYED BY THE VENDOR'S OWN NAME (`seven_day_opus`,
   * `seven_day_sonnet`, `seven_day_oauth_apps`).
   *
   * An open record rather than named fields, and that is the same argument
   * `limitType` makes on the `rate_limit` event: the set is the vendor's plan
   * catalogue and it grows whenever a plan does. Named fields would make a new
   * bucket fail to compile in code that only passes a label through.
   *
   * They are CARRIED BUT NOT PROMOTED. The bar shows two windows; these are what
   * its tooltip lists. See the display note in TokenUsageBar.tsx for why five
   * chips is not a bar.
   */
  extra?: Record<string, SubscriptionUsageWindow>;
};

// ---------------------------------------------------------------------------
// The two clocks this feature runs on
// ---------------------------------------------------------------------------

/**
 * HOW OFTEN A READING MAY BE REFETCHED — the poll FLOOR, not a target.
 *
 * Fifteen minutes, because both sources ultimately resolve to the same
 * server-side accounting and that accounting is rate-limited in practice (an
 * observed `rate_limit_error` from the usage endpoint on a live account). The
 * dotclaude HUD polls at this interval and is the reason a `.hud_cache` exists at
 * all, so matching it means naby adds no load beyond what the machine was already
 * generating.
 *
 * The client is free to ASK on any natural event (a turn completing, a mount) —
 * this constant is enforced server-side, so those asks are cache reads and only
 * one in fifteen minutes reaches a source.
 */
export const SUBSCRIPTION_USAGE_TTL_MS = 15 * 60 * 1000;

/**
 * HOW STALE A READING MAY GET BEFORE IT IS NO LONGER A READING — thirty minutes,
 * twice the TTL.
 *
 * TWO DIFFERENT FAILURES ARE BOTH THIS NUMBER, on purpose:
 *
 *   1. Our own cache, when a refetch fails. Serving the last good answer through
 *      a transient hiccup is right; serving it forever is the "silently frozen
 *      numbers" failure that disqualified reading `.hud_cache` on its own in the
 *      first place. Past the ceiling we show nothing rather than something old.
 *   2. `.hud_cache` itself. It only advances while another program's daemon is
 *      alive, and a dead daemon leaves a file that still parses perfectly. Since
 *      the merge takes the WORSE of two readings, a frozen 84% would win forever
 *      and pin the bar to a number from last week. `_ts` is therefore mandatory
 *      and checked — a cache with no timestamp is refused outright, because
 *      "arbitrarily old" and "current" are indistinguishable without one.
 */
export const SUBSCRIPTION_USAGE_MAX_STALE_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Field readers — each refuses rather than coerces
// ---------------------------------------------------------------------------

/**
 * A utilization percentage, or nothing.
 *
 * Rejects NaN and Infinity (`NaN%` is not a reading) and rejects NEGATIVES, which
 * are not a scale either source documents. Does NOT reject values above 100: an
 * account in overage genuinely is past its window, and clamping would erase
 * exactly the state worth showing. `0` passes — a freshly reset window really is
 * 0%, and folding it in with absence is the error this whole file is about.
 */
export function usagePercent(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * An ISO 8601 instant as UNIX SECONDS — THE ONLY PLACE THAT CONVERSION HAPPENS.
 *
 * Both sources send strings like `2026-08-24T05:19:59.552361+00:00`. `Date.parse`
 * handles the offset and the six-digit fraction; anything it cannot read comes
 * back NaN and is returned as absent, so a vendor format change degrades to "no
 * countdown" rather than to `Invalid Date` or to 1970.
 *
 * NO CLOCK IS READ HERE. Whether a reset is in the PAST is a display question
 * with a different answer in a test than in a browser, and a `Date.now()` in a
 * parser is how a fixture stops being reproducible. The expiry rule lives at the
 * point of render (`usageWindowView`, contextGauge.ts) with `now` injected.
 */
export function isoToUnixSeconds(v: unknown): number | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.floor(ms / 1000);
}

/** One `{ utilization, resets_at }` object — the shape BOTH sources use for a
 *  window, which is why one reader serves both. Returns undefined when neither
 *  field survived: a window object carrying no readings is not a window, and
 *  emitting it would put an empty chip on the bar. */
function readWindow(v: unknown, source: SubscriptionUsageSource): SubscriptionUsageWindow | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const utilizationPercent = usagePercent(o.utilization);
  const resetsAt = isoToUnixSeconds(o.resets_at);
  if (utilizationPercent === undefined && resetsAt === undefined) return undefined;
  return {
    ...(utilizationPercent !== undefined ? { utilizationPercent } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    source,
  };
}

/** An epoch stamp that may have been written in either unit. `.hud_cache` writes
 *  milliseconds (an observed `_ts` is 1787531824602), but the same <1e12 guard
 *  the client uses for `resetsAt` is applied for the same reason: the unit is the
 *  one thing that can be wrong here without looking wrong, and a seconds value
 *  read as milliseconds lands in 1970 — which would make every cache read as
 *  impossibly stale and silently disable the source. */
function epochMs(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  return v < 1e12 ? v * 1000 : v;
}

/** True when a parse produced nothing at all — used to return `null` rather than
 *  an empty envelope, so callers have one thing to check instead of three. */
function isEmpty(u: SubscriptionUsage): boolean {
  return (
    u.fiveHour === undefined &&
    u.sevenDay === undefined &&
    (u.extra === undefined || Object.keys(u.extra).length === 0)
  );
}

/** The sub-window keys the vendor currently ships, in the order a tooltip should
 *  list them. Consulted only to give `extra` a stable order — an unknown key is
 *  still carried (see `parseSdkUsage`), because the catalogue grows. */
const EXTRA_WINDOW_KEYS = ['seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps'] as const;

// ---------------------------------------------------------------------------
// Source 1: the Agent SDK's usage query
// ---------------------------------------------------------------------------

/**
 * `SDKControlGetUsageResponse` → `SubscriptionUsage`, or null.
 *
 * THE API THIS PARSES IS NAMED `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_
 * THIS_API_YET`, AND THAT NAME IS TREATED AS A SPECIFICATION. Every field in the
 * vendor's own typings is optional-or-null, the method may vanish in a bump, and
 * the call may simply throw. So: `unknown` in, nothing imported from the SDK, and
 * every failure mode collapses to `null`, which the display renders as silence.
 *
 * `rate_limits_available: false` IS A FIRST-CLASS ANSWER, NOT A FAILURE. The
 * vendor documents it for API-key, Bedrock and Vertex sessions — accounts that
 * have no plan window at all — and the honest rendering of "this account has no
 * subscription limits" is no chip, not a chip reading 0%. It returns null before
 * `rate_limits` is even looked at, so a stray object alongside the false flag
 * cannot be read by accident.
 *
 * The three model/app sub-windows are carried into `extra` rather than dropped;
 * unrecognised keys are carried too, so a bucket the vendor adds tomorrow reaches
 * the tooltip without a code change.
 */
export function parseSdkUsage(raw: unknown): SubscriptionUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  // Strict `=== true`: a missing flag, a string, a truthy object — none of them
  // is the vendor saying "plan limits apply here".
  if (r.rate_limits_available !== true) return null;
  const limits = r.rate_limits;
  if (!limits || typeof limits !== 'object') return null;
  const l = limits as Record<string, unknown>;

  const fiveHour = readWindow(l.five_hour, 'sdk');
  const sevenDay = readWindow(l.seven_day, 'sdk');

  const extra: Record<string, SubscriptionUsageWindow> = {};
  // Known keys first so the tooltip's order is stable, then anything else the
  // vendor has started sending.
  const seen = new Set<string>(['five_hour', 'seven_day']);
  for (const key of EXTRA_WINDOW_KEYS) {
    seen.add(key);
    const w = readWindow(l[key], 'sdk');
    if (w) extra[key] = w;
  }
  for (const key of Object.keys(l)) {
    if (seen.has(key)) continue;
    const w = readWindow(l[key], 'sdk');
    if (w) extra[key] = w;
  }

  const usage: SubscriptionUsage = {
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };
  return isEmpty(usage) ? null : usage;
}

// ---------------------------------------------------------------------------
// Source 2: Claude Code's own usage cache
// ---------------------------------------------------------------------------

/**
 * `~/.claude/.hud_cache` → `SubscriptionUsage`, or null.
 *
 * WHAT THIS FILE IS, AND WHY IT IS THE SECOND SOURCE. It is Claude Code's status
 * line cache: an already-fetched copy of the same `five_hour` / `seven_day`
 * objects the plan-usage endpoint returns, written by a poller that runs every
 * fifteen minutes. Reading it gets the numbers WITHOUT a credential and WITHOUT a
 * network call — naby never touches a token, never sees an `Authorization`
 * header, and adds nothing to the load on an endpoint that is rate-limited in
 * practice. That is why it was chosen over the endpoint itself; see the note at
 * the head of `engines/claude-hud-usage.ts` for the full argument, including the
 * account-identity guard that decides whether this reading may be merged at all.
 *
 * FRESHNESS IS MANDATORY AND `_ts` IS THE ONLY WAY TO KNOW IT. A stopped poller
 * leaves a file that still parses perfectly, and because the merge takes the
 * WORSE of two readings a frozen number would win every comparison forever. So a
 * cache with no usable `_ts`, or one older than `maxAgeMs`, is refused entirely
 * rather than partially trusted.
 *
 * `_ok !== true` is refused for the same reason: the poller records whether its
 * last fetch actually succeeded, and a `false` there means the numbers below it
 * are whatever survived from before.
 *
 * `now` and `maxAgeMs` are PARAMETERS so the staleness rule is exercised against
 * fixtures at a fixed clock. Nothing in this module reads a real one.
 */
export function parseHudUsage(
  raw: unknown,
  opts: { now: number; maxAgeMs: number },
): SubscriptionUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r._ok !== true) return null;
  const ts = epochMs(r._ts);
  if (ts === undefined) return null;
  // A future timestamp is as unreadable as a missing one — a clock that
  // disagrees with ours by more than the ceiling cannot be used to establish
  // freshness, so it is refused in both directions rather than trusted forward.
  const age = opts.now - ts;
  if (age > opts.maxAgeMs || age < -opts.maxAgeMs) return null;

  const fiveHour = readWindow(r.five_hour, 'cli');
  const sevenDay = readWindow(r.seven_day, 'cli');
  // NO `extra` FROM THIS SOURCE. The cache carries the two plan windows and
  // nothing else; inventing empty model sub-windows for it would make the merge
  // below compare a real bucket against a fabricated one.
  const usage: SubscriptionUsage = {
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
  };
  return isEmpty(usage) ? null : usage;
}

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

/**
 * THE PESSIMISTIC READING WINS — of two readings of the SAME window, keep the one
 * with the LEAST headroom left.
 *
 * WHY, STATED PLAINLY: the two sources are sampled at different moments and
 * neither is authoritative about the other's freshness. A user who is told 5%
 * when the truth is 84% will start a long run and lose it; a user told 84% when
 * the truth is 5% loses nothing but a little optimism. The failure is asymmetric,
 * so the tie-break is too. This is a deliberate exception, authorised for the
 * Claude path specifically, to the "one source of truth per fact" habit the rest
 * of the runtime keeps.
 *
 * THE WINNING SOURCE'S WINDOW IS TAKEN WHOLE — its percentage AND its reset AND
 * its `source` label. It is never assembled field-by-field from both. A chip
 * reading "84% · resets in 12m" built from a percentage taken at one moment and a
 * clock taken at another describes no state that ever existed, and it would be
 * indistinguishable from one that did.
 *
 * THE LADDER, IN ORDER:
 *   1. Only one side has the window → that one. (Nothing to compare.)
 *   2. Both have a percentage → the HIGHER percentage. Ties keep `a`, which the
 *      caller passes as the SDK reading, so the per-account-correct source wins a
 *      draw.
 *   3. Only one has a percentage → that one. The percentage is the number the
 *      display exists for; a window with only a clock cannot be compared on
 *      headroom, and preferring it would drop the only usable reading.
 *   4. Neither has a percentage → the SOONER reset, which is the only sense in
 *      which "less left" can still be read. Then `a`.
 */
export function leastRemainingWindow(
  a: SubscriptionUsageWindow | undefined,
  b: SubscriptionUsageWindow | undefined,
): SubscriptionUsageWindow | undefined {
  if (!a) return b;
  if (!b) return a;
  const pa = a.utilizationPercent;
  const pb = b.utilizationPercent;
  if (pa !== undefined && pb !== undefined) return pb > pa ? b : a;
  if (pa !== undefined) return a;
  if (pb !== undefined) return b;
  const ra = a.resetsAt;
  const rb = b.resetsAt;
  if (ra !== undefined && rb !== undefined) return rb < ra ? b : a;
  return ra !== undefined ? a : b;
}

/**
 * Merge two readings of the same account, window by window.
 *
 * ⚠️ THE CALLER IS RESPONSIBLE FOR THE PRECONDITION IN THAT SENTENCE: **the same
 * account**. This function cannot check it — it is handed two bags of numbers
 * with no identity on them — and merging readings from two different
 * subscriptions produces a figure that describes neither, which is worse than
 * either alone. naby is multi-account and isolates accounts by `CLAUDE_CONFIG_DIR`,
 * so the two sources genuinely can be different people's plans. The guard lives
 * where the identities are knowable (`sameClaudeAccount`, engines/claude-hud-
 * usage.ts) and refuses to call this when they are not provably equal.
 *
 * `a` is the PREFERRED source on a tie — pass the SDK reading there.
 */
export function mergeSubscriptionUsage(
  a: SubscriptionUsage | null | undefined,
  b: SubscriptionUsage | null | undefined,
): SubscriptionUsage | null {
  if (!a) return b ?? null;
  if (!b) return a;

  const fiveHour = leastRemainingWindow(a.fiveHour, b.fiveHour);
  const sevenDay = leastRemainingWindow(a.sevenDay, b.sevenDay);

  const extra: Record<string, SubscriptionUsageWindow> = {};
  for (const key of new Set([...Object.keys(a.extra ?? {}), ...Object.keys(b.extra ?? {})])) {
    const w = leastRemainingWindow(a.extra?.[key], b.extra?.[key]);
    if (w) extra[key] = w;
  }

  const usage: SubscriptionUsage = {
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };
  return isEmpty(usage) ? null : usage;
}
