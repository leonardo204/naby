// src/runtime/naby-home.ts
//
// WHERE NABY'S OWN FILES LIVE — resolved ONCE, here.
//
// The database, the harness home and (since the activity log) the log directory
// all answer the same question: "which directory is this install's naby home?".
// That question had two answers in the tree — the shell's `resolveDbPath` and
// electron/boot.ts — and a third would have arrived with the log directory. Two
// copies of a path resolver is the same failure mode CLAUDE.md warns about for
// judgement functions: when they drift, one subsystem writes beside the database
// and another writes beside something else, and nobody notices until a support
// bundle is missing half of itself.
//
// PRECEDENCE, stated once and implemented once:
//
//     NABY_DB_PATH   the full path to the db FILE (tests point this at a temp
//                    dir; the home is its directory)
//     NABY_HOME      our own home directory
//     COCKPIT_HOME   the shell's home directory, when running inside cockpit
//     ~/.naby        the default every launch mode already converges on
//
// The packaged app and `npm run electron:dev` set NABY_HOME/NABY_DB_PATH at boot
// (electron/boot.ts), and the plain `cockpit` CLI falls through to the default —
// which is the same directory, so every launch mode shares one home.

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** The directory name of the naby home under `~`. */
export const NABY_HOME_DIR_NAME = '.naby';

/**
 * The home a caller EXPLICITLY configured, or undefined when nothing did.
 *
 * Separate from `nabyHomeDir()` because the two have different callers and
 * different stakes. A caller that needs a path to open (the store) wants the
 * default; a caller deciding whether it may write into the user's real home at
 * all (the activity log, running inside a spike that never named a home) needs
 * to know that NOBODY asked for `~/.naby` — see activity-log.ts.
 */
export function configuredNabyHome(): string | undefined {
  const dbPath = process.env.NABY_DB_PATH;
  if (dbPath) return dirname(dbPath);
  const home = process.env.NABY_HOME || process.env.COCKPIT_HOME;
  return home || undefined;
}

/** The naby home directory, defaulting to `~/.naby`. */
export function nabyHomeDir(): string {
  return configuredNabyHome() ?? join(homedir(), NABY_HOME_DIR_NAME);
}

/**
 * The database file. `NABY_DB_PATH` names the FILE (not a directory), so it is
 * read here directly rather than round-tripped through `nabyHomeDir()` — a home
 * plus 'app.db' would rename a db the user pointed us at.
 */
export function nabyDbPath(): string {
  return process.env.NABY_DB_PATH || join(nabyHomeDir(), 'app.db');
}
