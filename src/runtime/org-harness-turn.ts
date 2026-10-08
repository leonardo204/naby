// src/runtime/org-harness-turn.ts
//
// THE ORG HARNESS INSIDE ONE TURN (specs/org-harness-sync.md M2: §3.3 on-demand
// skills, §3.4 the compatibility layer, §4.7 the package pinned per turn).
//
// M1 (`org-harness.ts`) put the package on disk and the rows in the store. This
// file is what a TURN does with them:
//
//   * PIN (`pinOrgHarnessTurn`). Once, at turn start, the kill switch is read and
//     the `current` package is resolved to an absolute folder. The listing, every
//     `naby_skill_load` call and every `run_command` env of that turn use THAT
//     folder, even if a background sync flips `current` halfway through: M1 keeps
//     the previous version on disk exactly so a turn that started on it can finish
//     (§3.1, §4.7). Pinning is a value captured once, not a re-read. Since M4 the
//     pin also LEASES the folder until `release()`, so even a second flip during
//     the same run cannot get it deleted.
//   * LOAD (`makeOrgSkillLoadTool`). `naby_skill_load(name)` returns the §3.4
//     preamble, the skill folder's absolute path, and the SKILL.md body with the
//     Claude Code placeholders replaced by absolute paths. Both engines get it the
//     same way: it is an ordinary runtime tool, so the ai-sdk path calls it
//     directly and the Claude Agent SDK path sees it on the in-process
//     `nabytools` MCP server like every other runtime tool.
//   * ENV (`orgCommandEnv`). A `run_command` whose line refers to the package
//     gets `CLAUDE_PLUGIN_ROOT`, `CLAUDE_SKILL_DIR`, `CLAUDE_PROJECT_DIR`,
//     `HARNESS_CLIENT=naby` and, when the cic preset is configured,
//     `CLAUDE_PLUGIN_OPTION_CIC_TOKEN`. Never the Skill Hub key.
//
// THE KILL SWITCH (§4.8) IS HONOURED HERE, NOT ONLY BY ROW STATUS. M1 switches
// the rows off at the next turn boundary; between the switch and that boundary —
// or for a row the user re-enabled by hand while the harness is off — a row can
// still read `enabled`. So the pinned `on` decides the listing, and the tool and
// the env re-check the live switch on every call (off is the safe direction).
//
// WHAT IS NOT HERE: the hook runner (§3.5 — org-harness-hooks.ts), the Atlassian
// gate and the deps check (§3.6 — org-harness-gate.ts), metrics (§3.7, M4). The
// SDK engine's native `Bash` does NOT get the §3.4 env: the Agent SDK has no
// per-command env seam (its `env` is the whole CLI process, and a PreToolUse hook
// can only rewrite the input), and splicing an `export` into the command line
// would write the cic token into the transcript. Documented as a limitation in
// the spec (§7.5/§7.6) rather than worked around.

import { join } from 'node:path';
import type { Executor, ToolOutput, ToolSchema } from './engine.js';
import { CASE_INSENSITIVE_FS, isPathInside } from './fs-tools.js';
import {
  leaseOrgPackageDir,
  ORG_HARNESS_CLIENT,
  ORG_HARNESS_ORIGIN_PREFIX,
  ORG_HARNESS_PACKAGE,
  ORG_HARNESS_SCOPE_KEY,
  orgHarnessOnState,
  orgHarnessRoot,
  readCurrentOrgPackage,
  type OrgHarnessContext,
  type OrgHarnessOffReason,
  type OrgPackageSkill,
} from './org-harness.js';
import type { HarnessItem, Store } from './store/store.js';

/** The tool's name. Also the first entry of every org row's `toolRefs`. */
export const SKILL_LOAD_TOOL_NAME = 'naby_skill_load';

/** HARD cap on the on-demand LISTING per turn, separate from the skill-body
 *  budget (§3.3). The three org descriptions are ~1,000 characters together;
 *  this leaves room for a package that grows a few more skills. */
export const ORG_SKILL_LISTING_TOKEN_BUDGET = 1500;

/** The directory no file-writing tool may write into (§3.3): everything the org
 *  harness keeps on disk, all versions. */
export function orgHarnessProtectedRoot(home: string): string {
  return join(home, 'org');
}

/** Env names the compatibility layer sets on a package command (§3.4). */
export const ORG_COMMAND_ENV = {
  pluginRoot: 'CLAUDE_PLUGIN_ROOT',
  skillDir: 'CLAUDE_SKILL_DIR',
  projectDir: 'CLAUDE_PROJECT_DIR',
  client: 'HARNESS_CLIENT',
  cicToken: 'CLAUDE_PLUGIN_OPTION_CIC_TOKEN',
  /** The name pdoc's `template_source.py` reads (7.3). Set beside the plugin
   *  option name, with the same value (user decision 2026-10-08, §3.4). */
  cicApiToken: 'CIC_API_TOKEN',
} as const;

/** Names the Skill Hub key travels under in Claude Code. Removed from a package
 *  command's env, so it cannot reach a script even if the user's own shell
 *  profile exported it (§3.4: the key is never handed to scripts). */
export const ORG_KEY_ENV_NAMES: readonly string[] = ['CLAUDE_PLUGIN_OPTION_SHUB_API_KEY', 'SHUB_API_KEY'];

// ---------------------------------------------------------------------------
// The pinned turn
// ---------------------------------------------------------------------------

export type OrgHarnessTurn = {
  /** The switch as it stood at turn start. */
  readonly on: boolean;
  readonly offReason?: OrgHarnessOffReason;
  readonly home: string;
  /** The package `current` named at turn start — undefined when off or not yet
   *  downloaded. Its `dir` is THE path for this whole turn. */
  readonly pkg?: { readonly version: string; readonly dir: string; readonly skills: readonly OrgPackageSkill[] };
  /** The open project, for `CLAUDE_PROJECT_DIR`. */
  readonly projectDir?: string;
  /** Whether the engine runs the Agent SDK's own Bash/Read/Write/Edit, so the
   *  preamble's name table is the identity (§3.4 last paragraph). */
  readonly nativeClaudeTools: boolean;
  /** The live switch, re-read on every load and every package command. */
  stillOn(): boolean;
  /** Whether the org row for `name` is a live, enabled org row right now. */
  rowEnabled(name: string): boolean;
  /** The cic token, read lazily so it is never held where it is not used. */
  cicToken(): string | undefined;
  /** The skill folder the most recent `naby_skill_load` in this turn returned —
   *  the `CLAUDE_SKILL_DIR` for a command that only names the variable. */
  lastLoadedSkillDir?: string;
  /**
   * End this turn's lease on `pkg.dir` (§4.7, M4). Until it is called the
   * package GC keeps the folder even after two newer versions arrived; call it
   * once the run is over (idempotent; a no-op for a turn with no package).
   */
  release(): void;
};

export type PinOrgHarnessTurnArgs = OrgHarnessContext & {
  projectDir?: string;
  nativeClaudeTools?: boolean;
  /** Returns the cic preset's token, or undefined when it is not configured. */
  readCicToken?: () => string | undefined;
};

/**
 * Resolve the org harness for one turn: switch + package path, once (§4.7).
 * Never throws — a turn must not fail because the org harness could not be read;
 * any error yields an "off" turn.
 */
export function pinOrgHarnessTurn(
  store: Pick<Store, 'getSetting' | 'listHarness'>,
  args: PinOrgHarnessTurnArgs,
): OrgHarnessTurn {
  const base = {
    release: () => {},
    home: args.home,
    nativeClaudeTools: args.nativeClaudeTools === true,
    ...(args.projectDir ? { projectDir: args.projectDir } : {}),
    stillOn: () => {
      try {
        return orgHarnessOnState(store, args).on;
      } catch {
        return false;
      }
    },
    rowEnabled: (name: string) => {
      try {
        const key = name.trim().toLowerCase();
        return store
          .listHarness('org', ORG_HARNESS_SCOPE_KEY, { kind: 'skill' })
          .some(
            (r) =>
              r.name.toLowerCase() === key &&
              r.status === 'enabled' &&
              (r.provenance.origin ?? '').startsWith(ORG_HARNESS_ORIGIN_PREFIX),
          );
      } catch {
        return false;
      }
    },
    cicToken: () => {
      try {
        return args.readCicToken?.()?.trim() || undefined;
      } catch {
        return undefined;
      }
    },
  };
  try {
    const state = orgHarnessOnState(store, args);
    if (!state.on) return { ...base, on: false, offReason: state.reason };
    const pkg = readCurrentOrgPackage(args.home);
    if (!pkg) return { ...base, on: true };
    // The lease is what lets a turn outlive TWO version flips (§4.7): without it
    // the GC keeps only current + one previous. Taken in the same synchronous
    // step that read `current`, so no sync can slip in between.
    const release = leaseOrgPackageDir(pkg.dir);
    return { ...base, release, on: true, pkg: { version: pkg.version, dir: pkg.dir, skills: pkg.skills } };
  } catch {
    return { ...base, on: false };
  }
}

/** Whether this turn lists org skills at all: on at turn start AND a package on
 *  disk to load from. The listing's `enabled` flag. */
export function orgTurnListsSkills(turn: OrgHarnessTurn): boolean {
  return turn.on && turn.pkg !== undefined;
}

/** Read roots for `read_file` / `list_dir` this turn (§3.3 "reads allowed under
 *  ~/.naby/org"). Every version, so a path a previous turn was given still reads. */
export function orgReadRoots(turn: OrgHarnessTurn): string[] {
  return orgTurnListsSkills(turn) ? [orgHarnessRoot(turn.home)] : [];
}

// ---------------------------------------------------------------------------
// The compatibility layer (§3.4)
// ---------------------------------------------------------------------------

/**
 * The fixed note in front of every loaded body. The table is §3.4's, verbatim in
 * meaning. On the Agent SDK engine the tool names map to themselves, so that row
 * says so instead of sending the model to tools it does not have.
 */
export function orgCompatPreamble(args: {
  pluginRoot: string;
  skillDir: string;
  nativeClaudeTools: boolean;
}): string {
  const toolRows = args.nativeClaudeTools
    ? [
        '- `Bash`, `Read`, `Write`, `Edit`: use them as written — this engine has them.',
      ]
    : [
        '- `Bash` → `run_command` (runs in the open project directory)',
        '- `Read` / `Write` / `Edit` → `read_file` / `write_file` / `edit_file`',
      ];
  return [
    '[naby compatibility note — this skill was written for Claude Code]',
    ...toolRows,
    '- `AskUserQuestion` → ask in your reply text. For a choice that is hard to undo, use `naby_checkin` if you have it.',
    `- \`\${CLAUDE_PLUGIN_ROOT}\` is ${args.pluginRoot}`,
    `- \`\${CLAUDE_SKILL_DIR}\` is ${args.skillDir}`,
    '  Both are already replaced in the body below. Files you read from the skill folder are NOT ' +
      'rewritten: replace those placeholders with the paths above yourself.',
    '- `.claude/` inside the project repository may be used as written. Never read or change the ' +
      "user's own `~/.claude/`.",
    '- The skill folder is read-only. Read its files with absolute paths; write output into the project.',
  ].join('\n');
}

/** Replace the Claude Code placeholders in a body (§3.4): `${CLAUDE_PLUGIN_ROOT}`
 *  and `${CLAUDE_SKILL_DIR}`, braced or bare. */
export function substituteOrgPlaceholders(body: string, args: { pluginRoot: string; skillDir: string }): string {
  return body
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT\b/g, () => args.pluginRoot)
    .replace(/\$\{CLAUDE_SKILL_DIR\}|\$CLAUDE_SKILL_DIR\b/g, () => args.skillDir);
}

function findSkill(turn: OrgHarnessTurn, name: string): OrgPackageSkill | undefined {
  const key = name.trim().toLowerCase();
  return turn.pkg?.skills.find((s) => s.name.toLowerCase() === key);
}

/**
 * What `naby_skill_load` returns for one skill, or an error string. Shared by the
 * tool and the explicit-name preload, so naming a skill and loading it bring the
 * same words into the turn.
 */
export function orgSkillLoadText(turn: OrgHarnessTurn, name: string): { text: string; skill: OrgPackageSkill } | { error: string } {
  if (!turn.on || !turn.stillOn()) {
    return { error: 'The org harness is switched off, so org skills cannot be loaded.' };
  }
  if (!turn.pkg) {
    return { error: 'The org harness package has not been downloaded yet; org skills cannot be loaded this turn.' };
  }
  const skill = findSkill(turn, name);
  if (!skill || !turn.rowEnabled(skill.name)) {
    const available = turn.pkg.skills.filter((s) => turn.rowEnabled(s.name)).map((s) => s.name);
    return {
      error:
        `No enabled org skill named "${name}".` +
        (available.length > 0 ? ` Available: ${available.join(', ')}.` : ''),
    };
  }
  const pluginRoot = turn.pkg.dir;
  const skillDir = skill.dir;
  const text = [
    orgCompatPreamble({ pluginRoot, skillDir, nativeClaudeTools: turn.nativeClaudeTools }),
    '',
    `Skill: ${skill.name} (${ORG_HARNESS_PACKAGE} ${turn.pkg.version})`,
    `Skill folder: ${skillDir}`,
    '',
    substituteOrgPlaceholders(skill.body, { pluginRoot, skillDir }),
  ].join('\n');
  return { text, skill };
}

export const skillLoadSchema: ToolSchema = {
  name: SKILL_LOAD_TOOL_NAME,
  description:
    'Load the full instructions of an org skill listed under "Skills you can load on demand". ' +
    'Call it before you follow a listed skill: the listing only has its description. Returns the ' +
    "skill's instructions, a note on how its Claude Code tool names map to yours, and the absolute " +
    'path of its folder (scripts and reference files live there; read them with absolute paths).',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The skill name exactly as listed, e.g. "task".' },
    },
    required: ['name'],
  },
};

/** The tool, bound to one pinned turn. */
export function makeOrgSkillLoadTool(turn: OrgHarnessTurn): { schema: ToolSchema; executor: Executor } {
  const executor: Executor = async (input): Promise<ToolOutput> => {
    const name =
      input && typeof input === 'object' && typeof (input as { name?: unknown }).name === 'string'
        ? (input as { name: string }).name.trim()
        : '';
    if (!name) return { content: 'A skill `name` is required.', isError: true };
    const r = orgSkillLoadText(turn, name);
    if ('error' in r) return { content: r.error, isError: true };
    turn.lastLoadedSkillDir = r.skill.dir;
    return {
      content: r.text,
      data: { name: r.skill.name, version: turn.pkg!.version, dir: r.skill.dir },
    };
  };
  return { schema: skillLoadSchema, executor };
}

/** The preload hook the skill injector calls for a NAMED on-demand row. */
export function orgSkillPreloader(turn: OrgHarnessTurn): (item: HarnessItem) => string | undefined {
  return (item) => {
    const r = orgSkillLoadText(turn, item.name);
    if ('error' in r) return undefined;
    turn.lastLoadedSkillDir = r.skill.dir;
    return r.text;
  };
}

// ---------------------------------------------------------------------------
// Env for package commands (§3.4 "when a command runs")
// ---------------------------------------------------------------------------

/** Every spelling of `dir` a command line may use: native, and with forward
 *  slashes (what a model writes on Windows), case-folded where the FS is. */
function spellings(dir: string): string[] {
  const out = new Set<string>([dir, dir.split('\\').join('/')]);
  return [...out].map((d) => (CASE_INSENSITIVE_FS ? d.toLowerCase() : d));
}

function mentions(command: string, dir: string): boolean {
  const hay = CASE_INSENSITIVE_FS ? command.toLowerCase() : command;
  return spellings(dir).some((d) => hay.includes(d));
}

/**
 * The extra env for one `run_command`, or undefined for "leave it alone".
 *
 * THE TRIGGER (documented choice): the command line mentions the pinned package
 * folder, OR names one of the placeholders (`CLAUDE_PLUGIN_ROOT` /
 * `CLAUDE_SKILL_DIR` — a model copying a line from a reference file that was not
 * substituted), OR runs with its cwd inside the package. That is "a script in the
 * skill folder" as far as a command line can show it. Every other command keeps
 * the inherited env untouched, so the cic token never reaches an unrelated one.
 *
 * `CLAUDE_SKILL_DIR` is the skill folder the line names, else the one the last
 * `naby_skill_load` of this turn returned.
 */
export function orgCommandEnv(
  turn: OrgHarnessTurn,
  command: string,
  cwd: string,
): Record<string, string | undefined> | undefined {
  if (!turn.on || !turn.pkg) return undefined;
  const root = turn.pkg.dir;
  const refers =
    mentions(command, root) ||
    /\$\{?CLAUDE_(PLUGIN_ROOT|SKILL_DIR)\b/.test(command) ||
    isPathInside(root, cwd, { foldCase: CASE_INSENSITIVE_FS });
  if (!refers || !turn.stillOn()) return undefined;
  const named = turn.pkg.skills.find((s) => mentions(command, s.dir) || isPathInside(s.dir, cwd));
  const skillDir = named?.dir ?? turn.lastLoadedSkillDir;
  const cic = turn.cicToken();
  const env: Record<string, string | undefined> = {
    [ORG_COMMAND_ENV.pluginRoot]: root,
    ...(skillDir ? { [ORG_COMMAND_ENV.skillDir]: skillDir } : {}),
    ...(turn.projectDir ? { [ORG_COMMAND_ENV.projectDir]: turn.projectDir } : {}),
    [ORG_COMMAND_ENV.client]: ORG_HARNESS_CLIENT,
    ...(cic ? { [ORG_COMMAND_ENV.cicToken]: cic, [ORG_COMMAND_ENV.cicApiToken]: cic } : {}),
  };
  for (const k of ORG_KEY_ENV_NAMES) env[k] = undefined;
  return env;
}
