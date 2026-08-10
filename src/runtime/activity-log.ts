// src/runtime/activity-log.ts
//
// THE ACTIVITY LOG — every request, response, decision and transaction, on disk,
// in files, greppable, and self-cleaning after a month.
//
// WHY FILES AND NOT THE DATABASE. The store already holds the transcript, and
// that is not what this is for. This log exists for the two jobs a transcript
// table is bad at:
//
//   * DEBUGGING A RUN THAT WENT WRONG — including one that ended by crashing the
//     process. A SQLite row written inside a transaction that never committed is
//     gone; an appended line is not. `grep` across a day is one command, needs no
//     schema, and works when the app will not start.
//   * DOWNSTREAM TOOLING — anything that wants to read naby's activity (a
//     dashboard, an evaluation harness, an export) can tail JSONL without taking
//     a lock on the database the app is actively writing.
//
// SHAPE. One file per DAY, `<naby home>/logs/YYYY-MM-DD.jsonl`, one event per
// line: `{at, iso, kind, sessionId?, agentId?, ...payload}`. The FILENAME IS THE
// CONTRACT — retention reads the date out of the name, never out of mtime, so a
// file that was copied, restored from a backup or touched by a sync client ages
// by what it holds rather than by what the filesystem remembers about it.
//
// RULES THIS MODULE OBEYS ABSOLUTELY
//
//   1. IT NEVER THROWS INTO ITS CALLER. Every public entry point swallows its own
//      failures. A full disk, a read-only directory, a circular payload: the turn
//      continues. Logging is observation, and observation that can fail the thing
//      it observes is worse than no logging at all.
//   2. IT NEVER LOSES THE TAIL. `appendFileSync` per line — no buffer to flush,
//      so a process killed mid-turn still has every line that was written before
//      the kill. The cost (one synchronous write per event) is paid deliberately:
//      the events are small, and the alternative is a log that is missing exactly
//      the part you needed.
//   3. IT NEVER WRITES INTO A HOME NOBODY NAMED. See `activityLogDir()`.
//   4. IT NEVER LOGS A SECRET IT CAN RECOGNISE. Best-effort, key-name based —
//      see `maskSecrets`.

import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configuredNabyHome } from './naby-home.js';

// ---------------------------------------------------------------------------
// Constants — the contract
// ---------------------------------------------------------------------------

/** How long a day's file survives. Older files are deleted, silently. */
export const LOG_RETENTION_DAYS = 30;

/** The log directory's name, under the naby home. */
export const ACTIVITY_LOG_DIR_NAME = 'logs';

/** Kill switch. Settings key, read once per process boot (see `applyActivityLogSettings`). */
export const ACTIVITY_LOG_ENABLED_KEY = 'logging.activityEnabled';

/**
 * Per-STRING cap. A `Read` of a 4MB file comes back through `tool_result`, and a
 * log that faithfully records it is a log that fills the disk it was supposed to
 * help debug. Anything longer is cut and the RECORD is stamped `truncated: true`,
 * so a reader can always tell "this is all there was" from "this is what fit".
 */
export const ACTIVITY_LOG_MAX_FIELD_CHARS = 32 * 1024;

/** Per-LINE cap — the backstop for a payload that is wide rather than deep (many
 *  fields, each under the field cap). A record over this is replaced by a stub
 *  that still names the kind and the session, so the event is never simply lost. */
export const ACTIVITY_LOG_MAX_LINE_CHARS = 256 * 1024;

/** How deep the sanitizer walks before it summarises. Deeper than any payload we
 *  build; the limit exists for tool arguments, which come from a model. */
const MAX_DEPTH = 8;

/** How many array entries survive. Same reasoning as the depth cap. */
const MAX_ARRAY_ITEMS = 200;

/** The filename pattern retention is allowed to touch. Anything else in the
 *  directory — a README, a rotated file from some other tool, a subdirectory —
 *  is not ours and is left alone. */
const LOG_FILE_RE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

/**
 * The event kinds this codebase writes. A union rather than free-form strings so
 * that a grep for a kind finds both the writer and this catalogue, and so a typo
 * is a type error rather than an event that silently never matches a query.
 * `(string & {})` is deliberately NOT included: a new kind belongs here.
 */
export type ActivityKind =
  // -- turn lifecycle -------------------------------------------------------
  //
  // TWO LEVELS, because there are two things a reader means by "a turn":
  //   run_*   one dispatched REQUEST — what the user (or Telegram, or the
  //           scheduler) asked for, from the shell, spanning every autonomy step.
  //           Carries the step count and the wall-clock duration of the whole
  //           thing.
  //   turn_*  one MODEL turn — one `runTurn` call, written by the runtime, so it
  //           exists on every engine and in a spike with no shell at all.
  // An ordinary message is one run containing one turn.
  | 'run_started'
  | 'run_completed'
  | 'run_failed'
  | 'turn_started'
  | 'turn_completed'
  | 'turn_failed'
  // -- conversation ---------------------------------------------------------
  | 'user_message'
  | 'assistant_text'
  | 'thinking'
  // THE NABY LAYER'S SPEND (P3-M14a, naby-voice-layer §7.1). A rewrite call is
  // deliberately absent from the transcript and from the usage table (§8), so
  // without this line it would be money spent where nobody can count it. The
  // record carries the model and the tokens for exactly that reason.
  | 'voice_rewrite'
  // -- tools and decisions --------------------------------------------------
  | 'tool_call'
  | 'tool_result'
  | 'gate_decision'
  | 'stage_refusal'
  | 'approval_requested'
  | 'approval_resolved'
  // -- growth / check-ins ---------------------------------------------------
  | 'checkin_asked'
  | 'checkin_answered'
  | 'ledger_event'
  // -- memory ---------------------------------------------------------------
  | 'memory_injected'
  | 'memory_write'
  | 'memory_confirmed'
  | 'memory_updated'
  | 'memory_superseded'
  | 'memory_deleted'
  | 'reflection_run'
  // -- harness / settings ---------------------------------------------------
  | 'harness_change'
  | 'setting_change'
  // -- outside channels -----------------------------------------------------
  | 'telegram_in'
  | 'telegram_out'
  | 'escalation'
  | 'scheduled_task_run'
  // -- accounting -----------------------------------------------------------
  | 'usage';

/** One line of the log, as it is written. */
export type ActivityRecord = {
  /** epoch ms. */
  at: number;
  /** the same instant, ISO-8601, so a human reading the file needs no converter. */
  iso: string;
  kind: ActivityKind;
  sessionId?: string;
  agentId?: string;
  /** set when any field in this record was cut to fit a cap. */
  truncated?: boolean;
  [key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Where the log lives
// ---------------------------------------------------------------------------

/**
 * The durable store's directory, registered by `SqliteStore` when it opens a
 * database. This is what makes "logs live beside the database" true even when
 * nobody set an environment variable: a spike that opens a store on a temp path
 * gets its logs on that temp path, and the user's real home is untouched.
 */
let registeredStoreDir: string | undefined;

/**
 * Tell the log which database is open. Called by `SqliteStore` on construction —
 * not by application code, which should not have to know this module exists.
 * Environment configuration still WINS (see `activityLogDir`): an explicitly
 * pointed home is an instruction, an opened store is only evidence.
 */
export function registerActivityLogStore(dbFilePath: string): void {
  try {
    registeredStoreDir = dirname(dbFilePath);
  } catch {
    /* never throws into a store constructor */
  }
}

/** Test seam: forget the registered store (and, with it, the ensured-dir cache). */
export function unregisterActivityLogStore(): void {
  registeredStoreDir = undefined;
}

/**
 * The directory this process logs into, or undefined when it must not log at all.
 *
 * WHY THIS CAN BE UNDEFINED, when `nabyHomeDir()` never is. `~/.naby` is the
 * right DEFAULT for a database — every launch mode converges on it deliberately.
 * It is the wrong default for a log, because of who else calls this runtime: the
 * spikes. A spike drives real turns against an in-memory store and names no home;
 * defaulting would have it append its fixtures to the user's real activity log,
 * which is both noise in the one file you read when something is wrong and a
 * write into `~/.naby` that a test has no business making.
 *
 * So the log home is only ever something a caller ASKED for:
 *   1. the environment (`NABY_DB_PATH` / `NABY_HOME` / `COCKPIT_HOME`), or
 *   2. the directory of the SQLite database that is actually open.
 *
 * Both production launch paths satisfy one of those — the packaged app and
 * `electron:dev` set the environment at boot, and the plain `cockpit` CLI opens
 * `~/.naby/app.db`, which registers `~/.naby`. A caller with neither is, by
 * construction, not an install.
 */
export function activityLogDir(): string | undefined {
  const home = configuredNabyHome() ?? registeredStoreDir;
  return home ? join(home, ACTIVITY_LOG_DIR_NAME) : undefined;
}

/** The file a given instant belongs in. LOCAL date: the person grepping is
 *  looking for "what happened yesterday afternoon" in their own timezone. */
export function activityLogFileName(at: number = Date.now()): string {
  return `${dayKey(at)}.jsonl`;
}

/** Full path of the file a given instant belongs in, when logging is possible. */
export function activityLogFile(at: number = Date.now()): string | undefined {
  const dir = activityLogDir();
  return dir ? join(dir, activityLogFileName(at)) : undefined;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Days since the epoch for a calendar date — DST-proof, because it compares
 *  calendar days rather than subtracting two wall-clock instants. */
function dayNumber(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

// ---------------------------------------------------------------------------
// The kill switch
// ---------------------------------------------------------------------------

/** undefined = not yet resolved; the default is ON. */
let enabled: boolean | undefined;
/** Whether the store has already been consulted this process. */
let resolvedFromStore = false;

/**
 * Read the setting. ABSENT READS AS ON, the same direction (and for the same
 * reason) as `memory.learningEnabled`: the product works as described on an
 * install that has never opened Settings, and only an explicit `'false'` turns it
 * off — so a corrupt value fails toward the documented behaviour.
 */
export function readActivityLogEnabled(store: {
  getSetting(key: string): string | undefined;
}): boolean {
  try {
    return (store.getSetting(ACTIVITY_LOG_ENABLED_KEY) ?? 'true') !== 'false';
  } catch {
    return true;
  }
}

/**
 * Resolve the kill switch from the store, ONCE per process boot — the same
 * lifetime `readLearningEnabled` deliberately does NOT have. The asymmetry is the
 * point: learning is re-read per turn because flipping it must land on the very
 * next message, whereas a log that stopped and restarted mid-process would
 * produce a file with a hole in it, which is worse for debugging than a file that
 * consistently is not there.
 */
export function applyActivityLogSettings(store: {
  getSetting(key: string): string | undefined;
}): void {
  if (resolvedFromStore) return;
  resolvedFromStore = true;
  enabled = readActivityLogEnabled(store);
  if (enabled) initActivityLog();
}

/** Whether this process is logging. */
export function isActivityLogEnabled(): boolean {
  if (process.env.NABY_ACTIVITY_LOG !== undefined) {
    const v = process.env.NABY_ACTIVITY_LOG.trim().toLowerCase();
    if (v === '0' || v === 'off' || v === 'false' || v === 'no') return false;
  }
  return enabled ?? true;
}

/**
 * Test seam / explicit override. `undefined` resets to "unresolved", which is
 * what a test needs between cases: the once-per-boot rule above is correct for a
 * process and useless for a suite that has to check both states.
 */
export function setActivityLogEnabled(value: boolean | undefined): void {
  enabled = value;
  resolvedFromStore = value !== undefined;
}

// ---------------------------------------------------------------------------
// Secret masking — best effort, by key name
// ---------------------------------------------------------------------------

/**
 * Field names whose STRING values are redacted. Key-name based and documented as
 * BEST EFFORT: this is a net for the obvious paths (a settings write carrying an
 * API key, a Telegram bot token, an `Authorization` header inside an MCP tool
 * argument), not a classifier. A secret pasted into prose is logged, because the
 * prose is the thing being debugged.
 */
const SECRET_KEY_PARTS = [
  'apikey',
  'authorization',
  'accesskey',
  'bearer',
  'clientsecret',
  'cookie',
  'credential',
  'password',
  'passwd',
  'privatekey',
  'refreshtoken',
  'secret',
  'sessionkey',
  'token',
];

/**
 * Names that CONTAIN a secret word but hold a count, not a secret. Without this,
 * `inputTokens` reads as a token. Numbers are already exempt (only strings are
 * masked), so this only catches a count that arrived as a string.
 */
const SECRET_KEY_EXCEPTIONS = ['inputtokens', 'outputtokens', 'cachedinputtokens', 'tokens', 'tokenbudget', 'tokensused', 'maxtokens', 'tokencount'];

const REDACTED = '[redacted]';

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSecretKey(key: string): boolean {
  const k = normalizeKey(key);
  if (SECRET_KEY_EXCEPTIONS.includes(k)) return false;
  return SECRET_KEY_PARTS.some((part) => k.includes(part));
}

// ---------------------------------------------------------------------------
// Sanitizing: mask, truncate, and survive anything a model can produce
// ---------------------------------------------------------------------------

type SanitizeState = { truncated: boolean; seen: WeakSet<object> };

function sanitizeValue(value: unknown, state: SanitizeState, depth: number): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string') {
    const s = value as string;
    if (s.length <= ACTIVITY_LOG_MAX_FIELD_CHARS) return s;
    state.truncated = true;
    return `${s.slice(0, ACTIVITY_LOG_MAX_FIELD_CHARS)}…[truncated ${s.length - ACTIVITY_LOG_MAX_FIELD_CHARS} chars]`;
  }
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return String(value);
  if (t === 'function' || t === 'symbol') return `[${t}]`;
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (depth >= MAX_DEPTH) {
    state.truncated = true;
    return '[depth limit]';
  }
  const obj = value as object;
  if (state.seen.has(obj)) return '[circular]';
  state.seen.add(obj);
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((v) => sanitizeValue(v, state, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      state.truncated = true;
      items.push(`[${value.length - MAX_ARRAY_ITEMS} more items]`);
    }
    return items;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    // MASK BEFORE TRUNCATE: a redacted value is short, so a masked key never
    // spends the field budget, and a long secret cannot be half-logged.
    if (isSecretKey(k) && typeof v === 'string') {
      out[k] = REDACTED;
      continue;
    }
    out[k] = sanitizeValue(v, state, depth + 1);
  }
  return out;
}

/**
 * Mask + truncate a payload. Exported so a caller (and the spike) can see exactly
 * what would be written without writing it.
 */
export function sanitizeActivityPayload(payload: Record<string, unknown>): {
  value: Record<string, unknown>;
  truncated: boolean;
} {
  const state: SanitizeState = { truncated: false, seen: new WeakSet() };
  const value = sanitizeValue(payload, state, 0) as Record<string, unknown>;
  return { value, truncated: state.truncated };
}

/** Mask secrets in a value, leaving lengths alone. The masker on its own. */
export function maskSecrets(value: unknown): unknown {
  const state: SanitizeState = { truncated: false, seen: new WeakSet() };
  return sanitizeValue(value, state, 0);
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** Directories whose existence has already been ensured this process. */
const ensuredDirs = new Set<string>();
/** Per-directory day key of the last retention pass — "once per day thereafter". */
const lastPruneDay = new Map<string, string>();

/**
 * Delete day files older than `LOG_RETENTION_DAYS`, by FILENAME date.
 *
 * Silent and safe by construction: a missing directory is nothing to do, a name
 * that is not `YYYY-MM-DD.jsonl` is not ours and is skipped, and a delete that
 * fails (a file held open by another process) is ignored rather than retried.
 *
 * @returns how many files were removed — for the spike, which otherwise could
 *   only assert on the directory listing afterwards.
 */
export function pruneActivityLogs(now: number = Date.now(), dir?: string): number {
  const target = dir ?? activityLogDir();
  if (!target) return 0;
  let removed = 0;
  try {
    const today = new Date(now);
    const todayNum = dayNumber(today.getFullYear(), today.getMonth() + 1, today.getDate());
    for (const name of readdirSync(target)) {
      const m = LOG_FILE_RE.exec(name);
      if (!m) continue; // not ours
      const fileNum = dayNumber(Number(m[1]), Number(m[2]), Number(m[3]));
      if (todayNum - fileNum <= LOG_RETENTION_DAYS) continue;
      try {
        unlinkSync(join(target, name));
        removed += 1;
      } catch {
        /* held open, already gone, permissions — not worth a word */
      }
    }
  } catch {
    /* no directory yet, or unreadable: nothing to age out */
  }
  return removed;
}

/** Create the directory (once) and run retention (once per day). */
function ensureDir(dir: string, now: number): void {
  if (!ensuredDirs.has(dir)) {
    mkdirSync(dir, { recursive: true });
    ensuredDirs.add(dir);
  }
  const today = dayKey(now);
  if (lastPruneDay.get(dir) !== today) {
    lastPruneDay.set(dir, today);
    pruneActivityLogs(now, dir);
  }
}

/**
 * Create the directory and age out old files now, rather than on the first event.
 * Called when the kill switch is resolved; safe to call repeatedly.
 */
export function initActivityLog(): void {
  try {
    const dir = activityLogDir();
    if (!dir || !isActivityLogEnabled()) return;
    ensureDir(dir, Date.now());
  } catch {
    /* rule 1 */
  }
}

/** Test seam: forget the ensured-dir and last-prune caches. */
export function resetActivityLogCaches(): void {
  ensuredDirs.clear();
  lastPruneDay.clear();
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Append one event. THE ONLY WRITE PATH — every hook in the runtime and the shell
 * goes through here, so the file format, the masking and the caps are decided in
 * one place and cannot be bypassed by a caller in a hurry.
 *
 * Never throws (rule 1). Returns nothing: a caller that branched on whether the
 * log succeeded would be a caller whose behaviour depends on the log.
 */
export function logActivity(kind: ActivityKind, payload: Record<string, unknown> = {}): void {
  try {
    if (!isActivityLogEnabled()) return;
    const dir = activityLogDir();
    if (!dir) return;
    const at = typeof payload.at === 'number' ? (payload.at as number) : Date.now();
    const { value, truncated } = sanitizeActivityPayload(payload);
    // The record's own fields are not overridable by a payload that happens to
    // carry the same name — a line whose `kind` came from a tool argument would
    // be a line that lies about what it is.
    delete value.at;
    delete value.iso;
    delete value.kind;
    delete value.truncated;
    const record: ActivityRecord = {
      at,
      iso: new Date(at).toISOString(),
      kind,
      ...value,
      ...(truncated ? { truncated: true } : {}),
    };
    let line = `${JSON.stringify(record)}\n`;
    if (line.length > ACTIVITY_LOG_MAX_LINE_CHARS) {
      // Wide rather than deep. Keep the event — its identity is most of its value
      // — and say plainly that the payload did not fit.
      line = `${JSON.stringify({
        at,
        iso: record.iso,
        kind,
        ...(typeof record.sessionId === 'string' ? { sessionId: record.sessionId } : {}),
        ...(typeof record.agentId === 'string' ? { agentId: record.agentId } : {}),
        truncated: true,
        note: `record dropped: ${line.length} chars over the ${ACTIVITY_LOG_MAX_LINE_CHARS} line cap`,
      })}\n`;
    }
    ensureDir(dir, at);
    appendFileSync(join(dir, activityLogFileName(at)), line, 'utf8');
  } catch {
    // RULE 1. A disk that is full, a directory that went read-only, a payload
    // that defeated the sanitizer: the caller is running a TURN, and it finishes.
  }
}
