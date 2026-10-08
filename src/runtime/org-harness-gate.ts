// src/runtime/org-harness-gate.ts
//
// THE TWO THINGS naby DOES INSTEAD OF gate.js AND deps-check.js
// (specs/org-harness-sync.md M3: §3.6, with the grace period of §4.6).
//
// THE GATE. With the org harness on and its package on disk, a prompt is blocked
// until Atlassian's browser sign-in is done — the plugin's rule ("the harness is
// not installed until Atlassian is authorized"). naby's version reads its own
// token store (`mcp-oauth.ts`), never Claude Code's credential store.
//
//   NOT FOR SETTINGS, NOT FOR `/` COMMANDS. Settings is not a prompt, and a `/`
//   line that is not an org skill is a naby command; neither is blocked, so the
//   user can always reach the place that unblocks them.
//   ONE DAY. A confirmed sign-in is not re-checked for a day (`gate.js` caches the
//   same way), so a refresh hiccup mid-day does not lock anyone out.
//   `HARNESS_GATE=0` turns it off, the plugin's switch.
//
// THE GRACE (§4.6). An install that already had conversations when the gate first
// armed is an UPGRADE and gets `harness.org.gateGraceDays` (default 7) before
// anything is blocked; a fresh install is blocked once the package arrives. When
// blocking starts, a session that already existed keeps working — only sessions
// started after that moment are blocked.
//
// THE DEPENDENCY CHECK. Python 3 and PyYAML, the two the package's scripts need.
// Missing ones are shown on the Settings card with the install command; nothing
// is blocked. A passing check is remembered for a day, a failing one is redone at
// every session start (so installing makes the note go away at once — deps-check's
// own rule).

import { execFile } from 'node:child_process';
import type { Store } from './store/store.js';
import { ATLASSIAN_MCP_SERVER_NAME, mcpOAuthStatus, type McpOAuthStatus } from './mcp-oauth.js';

export const ORG_GATE_ENV_SWITCH = 'HARNESS_GATE';
export const DAY_MS = 24 * 60 * 60 * 1000;
export const ORG_GATE_GRACE_DAYS_DEFAULT = 7;

export const ORG_GATE_SETTING = {
  /** epoch ms the gate first armed (§4.6 "유예 시작일"). */
  graceStartedAt: 'harness.org.gateGraceStartedAt',
  /** 'upgrade' | 'new' — decided once, at that same moment. */
  graceKind: 'harness.org.gateGraceKind',
  /** Grace length in days (a setting, §4.6). */
  graceDays: 'harness.org.gateGraceDays',
  /** epoch ms of the last confirmed sign-in (the one-day cache). */
  okAt: 'harness.org.gateOkAt',
  /** JSON OrgDepsState — the last dependency check. */
  deps: 'harness.org.deps',
} as const;

export type OrgGateArgs = {
  /** The org harness is on (the turn's pinned switch). */
  on: boolean;
  /** A package is on disk (§3.1: no package, no gate). */
  packagePresent: boolean;
  env?: Record<string, string | undefined>;
  now?: number;
  /** The session's creation time, or undefined for a session this turn mints. */
  sessionCreatedAt?: number;
  /** The text the user typed (before any expansion). */
  rawPrompt?: string;
  /** Whether the line-led `/verb` names an org skill (those ARE the harness). */
  namesOrgSkill?: boolean;
  /** "Did this install have conversations before?" — asked once, when the
   *  grace is first stamped. */
  hasPriorSessions: () => boolean;
};

export type OrgGateVerdict =
  | {
      block: false;
      why: 'off' | 'no-package' | 'env-off' | 'ready' | 'grace' | 'in-progress-session' | 'command';
      /** Days until new sessions are blocked (grace only). */
      graceDaysLeft?: number;
      atlassian: McpOAuthStatus;
    }
  | { block: true; why: 'atlassian-required'; atlassian: McpOAuthStatus };

function readNum(store: Pick<Store, 'getSetting'>, key: string): number | undefined {
  const raw = store.getSetting(key)?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function orgGateGraceDays(store: Pick<Store, 'getSetting'>): number {
  const n = readNum(store, ORG_GATE_SETTING.graceDays);
  return n !== undefined && n >= 0 && n <= 365 ? n : ORG_GATE_GRACE_DAYS_DEFAULT;
}

/** When blocking starts (epoch ms), or undefined before the gate ever armed. */
export function orgGateBlockFrom(store: Pick<Store, 'getSetting'>): number | undefined {
  const at = readNum(store, ORG_GATE_SETTING.graceStartedAt);
  if (at === undefined) return undefined;
  const kind = store.getSetting(ORG_GATE_SETTING.graceKind)?.trim();
  return kind === 'new' ? at : at + orgGateGraceDays(store) * DAY_MS;
}

/** Is a `/` line a naby command (never blocked) rather than a prompt? */
function isCommandLine(raw: string | undefined, namesOrgSkill: boolean | undefined): boolean {
  if (!raw) return false;
  return raw.trimStart().startsWith('/') && namesOrgSkill !== true;
}

/**
 * Decide whether this prompt is blocked (§3.6, §4.6). Writes only the two
 * bookkeeping values it owns: the one-day "ok" stamp, and the grace start the
 * first time the gate arms. Never throws for ordinary states.
 */
export function evaluateOrgAtlassianGate(
  store: Pick<Store, 'getSetting' | 'setSetting'>,
  args: OrgGateArgs,
): OrgGateVerdict {
  const now = args.now ?? Date.now();
  const atlassian = mcpOAuthStatus(store, ATLASSIAN_MCP_SERVER_NAME);
  if (!args.on) return { block: false, why: 'off', atlassian };
  if (!args.packagePresent) return { block: false, why: 'no-package', atlassian };
  if ((args.env?.[ORG_GATE_ENV_SWITCH] ?? '').trim() === '0') return { block: false, why: 'env-off', atlassian };

  if (atlassian === 'connected') {
    const okAt = readNum(store, ORG_GATE_SETTING.okAt);
    if (okAt === undefined || now - okAt >= DAY_MS) store.setSetting(ORG_GATE_SETTING.okAt, String(now));
    return { block: false, why: 'ready', atlassian };
  }
  // Confirmed within the last day: not re-checked (gate.js's cache).
  const okAt = readNum(store, ORG_GATE_SETTING.okAt);
  if (okAt !== undefined && now - okAt < DAY_MS) return { block: false, why: 'ready', atlassian };

  if (isCommandLine(args.rawPrompt, args.namesOrgSkill)) return { block: false, why: 'command', atlassian };

  // Arm the gate: the grace starts now, and whether this is an upgrade is decided
  // now, once (§4.6).
  if (readNum(store, ORG_GATE_SETTING.graceStartedAt) === undefined) {
    let prior = false;
    try {
      prior = args.hasPriorSessions();
    } catch {
      prior = true; // unknown history reads as an existing install: never block early
    }
    store.setSetting(ORG_GATE_SETTING.graceStartedAt, String(now));
    store.setSetting(ORG_GATE_SETTING.graceKind, prior ? 'upgrade' : 'new');
  }
  const blockFrom = orgGateBlockFrom(store) ?? now;
  if (now < blockFrom) {
    return {
      block: false,
      why: 'grace',
      graceDaysLeft: Math.max(1, Math.ceil((blockFrom - now) / DAY_MS)),
      atlassian,
    };
  }
  // §4.6: a session already in progress when blocking started is never blocked.
  if (args.sessionCreatedAt !== undefined && args.sessionCreatedAt < blockFrom) {
    return { block: false, why: 'in-progress-session', atlassian };
  }
  return { block: true, why: 'atlassian-required', atlassian };
}

// ---------------------------------------------------------------------------
// Dependency check (deps-check.js replacement)
// ---------------------------------------------------------------------------

export type OrgDepsState = {
  at: number;
  /** The Python 3 version found, or null when none was. */
  python: string | null;
  /** The command that ran it (`python3`, `py -3`, …), for the install hint. */
  pythonCommand?: string;
  pyyaml: boolean;
};

export type OrgDepsRunner = (cmd: string, args: string[]) => Promise<{ code: number | null; stdout: string }>;

const defaultRunner: OrgDepsRunner = (cmd, args) =>
  new Promise((resolveRun) => {
    try {
      execFile(cmd, args, { timeout: 4000, windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
        // Any error — a non-zero exit, ENOENT, a timeout — is "not usable".
        resolveRun({ code: err ? 1 : 0, stdout: String(stdout ?? '') });
      });
    } catch {
      resolveRun({ code: 1, stdout: '' });
    }
  });

export function readOrgDeps(store: Pick<Store, 'getSetting'>): OrgDepsState | undefined {
  const raw = store.getSetting(ORG_GATE_SETTING.deps)?.trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as OrgDepsState;
  } catch {
    return undefined;
  }
}

let inflightDeps: Promise<OrgDepsState> | undefined;

/**
 * Check Python 3 and PyYAML (§3.6). Single-flight; a passing result is reused
 * for a day, a failing one is checked again. Never throws, never blocks a turn
 * (callers do not await it).
 */
export function checkOrgHarnessDeps(
  store: Pick<Store, 'getSetting' | 'setSetting'>,
  opts: { now?: number; run?: OrgDepsRunner; env?: Record<string, string | undefined>; platform?: string; force?: boolean } = {},
): Promise<OrgDepsState> {
  const now = opts.now ?? Date.now();
  const prev = readOrgDeps(store);
  if (!opts.force && prev && prev.python && prev.pyyaml && now - prev.at < DAY_MS) return Promise.resolve(prev);
  if (inflightDeps) return inflightDeps;
  const run = opts.run ?? defaultRunner;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  inflightDeps = (async (): Promise<OrgDepsState> => {
    // run-skill-hook.js's own search order: HARNESS_PYTHON, python3, py -3 (Windows), python.
    const candidates: [string, string[]][] = [];
    const override = env.HARNESS_PYTHON?.trim();
    if (override) candidates.push([override, []]);
    candidates.push(['python3', []]);
    if (platform === 'win32') candidates.push(['py', ['-3']]);
    candidates.push(['python', []]);
    let python: string | null = null;
    let pythonCommand: string | undefined;
    let pyCmd: [string, string[]] | undefined;
    for (const [cmd, pre] of candidates) {
      const r = await run(cmd, [...pre, '-c', "import sys; print('%d.%d.%d' % sys.version_info[:3])"]);
      const v = r.stdout.trim();
      if (r.code === 0 && v.startsWith('3.')) {
        python = v;
        pythonCommand = [cmd, ...pre].join(' ');
        pyCmd = [cmd, pre];
        break;
      }
    }
    let pyyaml = false;
    if (pyCmd) {
      const r = await run(pyCmd[0], [...pyCmd[1], '-c', 'import yaml']);
      pyyaml = r.code === 0;
    }
    const state: OrgDepsState = { at: now, python, ...(pythonCommand ? { pythonCommand } : {}), pyyaml };
    try {
      store.setSetting(ORG_GATE_SETTING.deps, JSON.stringify(state));
    } catch {
      /* the card just shows nothing */
    }
    return state;
  })().finally(() => {
    inflightDeps = undefined;
  });
  return inflightDeps;
}
