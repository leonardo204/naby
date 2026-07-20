// scripts/load-env.mjs
//
// Reads `.env` into `process.env` for LOCAL builds. Deliberately ~40 lines and
// zero dependencies rather than `dotenv`: this file handles Apple credentials,
// and the smallest auditable thing that can do that is the right thing.
//
// THREE RULES, ALL SECURITY-RELEVANT:
//
//   1. NEVER PRINT A VALUE. Not on success, not on error, not in a "loaded X=Y"
//      debug line. The only thing this module will ever say out loud is the
//      NAMES of the keys it set. That distinction is the whole reason it exists
//      instead of `console.log(process.env)` somewhere.
//   2. NEVER OVERWRITE AN EXISTING VARIABLE. In CI the credentials arrive from
//      repo secrets and there is no `.env` at all; if one ever did exist on a
//      runner, the ambient environment must still win. `??=` semantics, not `=`.
//   3. `.env` IS GITIGNORED AND STAYS THAT WAY. Nothing here writes it, and a
//      missing `.env` is a normal, silent condition — CI has none.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {string} [file]
 * @returns {string[]} the names (never values) of the variables that were set
 */
export function loadEnv(file = resolve(root, '.env')) {
  if (!existsSync(file)) return [];

  const applied = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    // Strip one layer of matching quotes. An app-specific password is
    // `abcd-efgh-ijkl-mnop` and needs none, but CSC_NAME contains spaces and a
    // user may well have quoted it.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] !== undefined) continue; // rule 2
    process.env[key] = value;
    applied.push(key);
  }
  return applied; // rule 1: names only, and the caller prints only these
}
