// src/runtime/org-harness-hook-scripts.ts
//
// WHICH SCRIPTS A PACKAGE'S hooks.json NAMES — a leaf module with no runtime
// imports (specs/org-harness-sync.md §3.5, §3.1 "silent update + notice").
//
// WHY A LEAF. Two modules need the allowlist: the hook runner
// (`org-harness-hooks.ts`, which already imports `org-harness.ts`) and the
// package sync (`org-harness.ts`, which detects hooks a new version adds that
// naby will not run yet). Keeping the list and the command splitter here lets
// both import it without a cycle between the two.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Scripts naby runs as-is (§3.5 table). Grows only with a naby release. */
export const ORG_HOOK_ALLOWLIST: readonly string[] = ['run-skill-hook.js', 'metrics-emit.js'];
/** Scripts naby re-implements and never runs (§3.6). Not "new" when they appear. */
export const ORG_HOOK_NATIVE: readonly string[] = ['activate.js', 'gate.js', 'deps-check.js'];

/** Shell-like split of a one-string command (`node "${CLAUDE_PLUGIN_ROOT}/x.js" a`):
 *  whitespace separates, single and double quotes group, nothing else is special. */
export function splitHookCommand(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | undefined;
  let any = false;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      any = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur || any) out.push(cur);
      cur = '';
      any = false;
      continue;
    }
    cur += ch;
  }
  if (cur || any) out.push(cur);
  return out;
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/** A script a package's hooks.json names, with every event that runs it. */
export type OrgHookScript = { script: string; events: string[] };

/**
 * Every script `hooks/hooks.json` of a package folder names, once each, with the
 * events that run it, in first-seen order. Never throws; a missing or broken
 * file names nothing.
 *
 * "Script" is the basename of the first argument (`node <pkg>/scripts/x.js` →
 * `x.js`); a command with no file-like argument is named by its executable; a
 * non-command hook (`type: "prompt"`) by `type:<type>`. That is enough to tell
 * which scripts the allowlist does not cover — the runner's own classification
 * (`classifyHookCommand`) still decides what actually runs.
 */
export function listOrgHookScripts(pkgDir: string): OrgHookScript[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(pkgDir, 'hooks', 'hooks.json'), 'utf8'));
  } catch {
    return [];
  }
  const hooks = (raw as { hooks?: unknown })?.hooks;
  if (!hooks || typeof hooks !== 'object') return [];
  const byScript = new Map<string, OrgHookScript>();
  const note = (script: string, event: string): void => {
    if (!script) return;
    const row = byScript.get(script) ?? { script, events: [] };
    if (!row.events.includes(event)) row.events.push(event);
    byScript.set(script, row);
  };
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const list = (group as { hooks?: unknown })?.hooks;
      if (!Array.isArray(list)) continue;
      for (const h of list) {
        const hk = h as { type?: unknown; command?: unknown; args?: unknown };
        if (hk.type !== undefined && hk.type !== 'command') {
          note(`type:${String(hk.type)}`, event);
          continue;
        }
        if (typeof hk.command !== 'string' || !hk.command.trim()) continue;
        let command: string;
        let args: string[];
        if (Array.isArray(hk.args)) {
          command = hk.command.trim();
          args = hk.args.filter((a): a is string => typeof a === 'string');
        } else {
          const parts = splitHookCommand(hk.command);
          command = parts[0] ?? '';
          args = parts.slice(1);
        }
        const first = args[0] ?? '';
        const fileLike = /[\\/]/.test(first) || /\.[A-Za-z0-9]+$/.test(first);
        note(baseName(fileLike ? first : command), event);
      }
    }
  }
  return [...byScript.values()];
}

/** Scripts a package names that are neither allowlisted nor re-implemented by
 *  naby — the hooks that are installed but wait for a naby release. */
export function orgHookScriptsWaiting(pkgDir: string): OrgHookScript[] {
  return listOrgHookScripts(pkgDir).filter((s) => isOrgHookScriptWaiting(s.script));
}

/** True when a script is not run by this naby build and is not one naby replaces. */
export function isOrgHookScriptWaiting(script: string): boolean {
  return !ORG_HOOK_ALLOWLIST.includes(script) && !ORG_HOOK_NATIVE.includes(script);
}
