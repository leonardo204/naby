// src/runtime/fs-tools.ts
//
// THE WORKSPACE TOOLS — read, search, edit and run, for every provider.
//
// WHY THESE LIVE IN THE RUNTIME AND NOT IN AN ENGINE.
//
// The Claude Agent SDK ships its own Read/Write/Edit/Bash/Glob/Grep, so a turn
// on `dev-claude` could always open a file. Every OTHER provider — the ai-sdk
// path, which is what a ChatGPT or OpenAI subscription runs on — saw only our
// built-ins, and those were `echo_note`, `send_message`, `fetch_url` and three
// naby-specific ones. So "이 프로젝트 파악해줘" on ChatGPT produced an apology:
// the model had no way to read a file, and said so. That is not a provider
// capability difference, it is a hole in OUR layer, and the fix belongs where
// provider independence is defined (contract §2) rather than in one engine.
//
// SANDBOX, AND WHAT IT IS NOT. Every path argument resolves against the project
// `cwd` and must stay inside it; `../../.ssh/id_rsa` is refused, as is an
// absolute path outside the project. This is a CONTAINMENT boundary for honest
// mistakes and confused models, not a security boundary against a hostile one:
// `run_command` runs a real shell, and a shell can go anywhere the user can. The
// gate is what stands in front of that (see MUTATING_TOOLS below), and the shell
// tool is deliberately in the mutating set even when the command only reads.
//
// NO DEPENDENCIES. `src/` is bundled into one self-contained artifact whose only
// imports are node builtins (scripts/build-runtime.mjs), so the glob matcher and
// the file walker here are written out rather than pulled from fast-glob and
// ripgrep the way the shell's ollama toolset does.

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Executor, ToolOutput, ToolSchema } from './engine.js';

// ---------------------------------------------------------------------------
// Which of these the gate must treat as dangerous
// ---------------------------------------------------------------------------

/**
 * Workspace tools that mutate the project or execute code.
 *
 * Exported because `phase1HarnessFloor` needs it: the floor allows every runtime
 * tool name the composition root hands it, on the reasoning that our own
 * executors are ours. That reasoning held while every runtime tool was a note or
 * an HTTP GET. It does not hold for a tool that writes a file, and without this
 * list "읽기 전용(관찰)" mode would have quietly permitted exactly what it
 * exists to forbid.
 */
export const MUTATING_TOOLS: readonly string[] = ['write_file', 'edit_file', 'run_command'];

/**
 * Workspace tools that only inspect. Safe under a read-only baseline.
 *
 * The classification is load-bearing twice over — `checkin.ts` spreads this list
 * into `OBSERVATION_RUNTIME_TOOLS`, which is FAIL-CLOSED (an unlisted name is
 * recorded as an unsupervised consequential act, and a gate refusal of one
 * becomes a safety tripwire), and `phase1HarnessFloor` allows exactly the
 * non-mutating runtime tools.
 *
 * THE BACKGROUND-JOB TOOLS ARE NOT HERE ANY MORE. They moved to the naby layer
 * (`job-tools.ts`), which is where a capability naby owns end to end belongs —
 * see that module's header. Their classification moved with them
 * (`JOB_OBSERVATION_TOOLS` / `JOB_EXECUTION_TOOLS`); nothing about it is inferred
 * from where a tool is defined.
 */
export const READONLY_TOOLS: readonly string[] = ['read_file', 'list_dir', 'glob', 'grep'];

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------
//
// Every one of these exists to keep a tool result from eating the context
// window. A model that asked for a directory listing does not benefit from
// 40,000 entries, and the turn after it would carry them all.

const READ_MAX_LINES = 2_000;
const READ_MAX_LINE_CHARS = 2_000;
const LIST_MAX_ENTRIES = 500;
const GLOB_MAX_RESULTS = 300;
const GREP_MAX_MATCHES = 200;
const WALK_MAX_FILES = 20_000;
const COMMAND_MAX_CHARS = 30_000;
const COMMAND_DEFAULT_TIMEOUT_MS = 60_000;
const COMMAND_MAX_TIMEOUT_MS = 600_000;

/** Directories never worth walking. Skipped by glob and grep, not by list_dir —
 *  listing a directory the user named should show what is actually in it. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.next-prod',
  'dist',
  'build',
  'out',
  'coverage',
  '.turbo',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  'target',
]);

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
}

function fail(message: string): ToolOutput {
  return { content: message, isError: true };
}

/**
 * Resolve a tool's path argument inside the project, or explain the refusal.
 *
 * Containment is checked on the RESOLVED path, so `a/../../b` is caught after
 * normalisation rather than by looking for '..' in the input — the latter is the
 * check everybody writes and every traversal payload is designed to walk past.
 */
function resolveInside(cwd: string, raw: unknown): { path: string } | { error: string } {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { error: 'A `path` is required.' };

  const abs = isAbsolute(value) ? resolve(value) : resolve(cwd, value);
  const rel = relative(cwd, abs);
  const inside = abs === cwd || (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel));
  if (!inside) {
    return {
      error:
        `Refusing to touch "${value}" — it resolves outside the project directory. ` +
        `Paths must stay within ${cwd}.`,
    };
  }
  return { path: abs };
}

/** Display form: project-relative, so results read like the user's own paths. */
function display(cwd: string, abs: string): string {
  const rel = relative(cwd, abs);
  return rel === '' ? '.' : rel;
}

/** A NUL byte in the first chunk is the standard "this is not text" heuristic. */
function looksBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, 8_000);
  for (let i = 0; i < end; i += 1) if (buf[i] === 0) return true;
  return false;
}

function clip(line: string): string {
  return line.length <= READ_MAX_LINE_CHARS ? line : `${line.slice(0, READ_MAX_LINE_CHARS)}…`;
}

/**
 * Translate a glob into a regex.
 *
 * Supports `**` (any depth, including none), `*` (within one segment), `?` and
 * character classes. Everything else is escaped — a pattern is a path, and a
 * path full of regex metacharacters must not become an accidental regex.
 */
function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]!;
    if (c === '*') {
      const doubled = pattern[i + 1] === '*';
      if (doubled) {
        // `**/` may match nothing at all, so `**/x` also matches a top-level `x`.
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) {
        out += '\\[';
      } else {
        out += pattern.slice(i, close + 1);
        i = close;
      }
    } else {
      out += c.replace(/[.+^${}()|\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

/** Depth-first file walk, skipping build/vendor directories and symlinks. */
function walkFiles(root: string, onFile: (abs: string) => boolean | void): void {
  let seen = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory — skip it, never fail the whole walk
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue; // a link can leave the project
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      seen += 1;
      if (seen > WALK_MAX_FILES) return;
      if (onFile(abs) === false) return;
    }
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
//
// Descriptions are written for the MODEL, and they say when to reach for the
// tool, not only what it does — a description that only names the function gets
// the tool ignored in favour of asking the user to paste a file.

export const readFileSchema: ToolSchema = {
  name: 'read_file',
  description:
    'Read a text file from the project and return its contents with line numbers. ' +
    'Use this whenever you need to see actual code or configuration rather than guess at it. ' +
    'Paths are relative to the project directory.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the project directory.' },
      offset: { type: 'number', description: '1-based line to start at. Default 1.' },
      limit: { type: 'number', description: `Maximum lines to return (default ${READ_MAX_LINES}).` },
    },
    required: ['path'],
  },
};

export const listDirSchema: ToolSchema = {
  name: 'list_dir',
  description:
    'List the entries of a directory in the project. Use this to orient yourself before reading ' +
    "files — start at '.' to see the project root.",
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: "Directory path relative to the project. Default '.'." },
    },
  },
};

export const globSchema: ToolSchema = {
  name: 'glob',
  description:
    "Find files by name pattern, e.g. '**/*.ts' or 'src/**/*.test.*'. " +
    'Use this to locate files when you know roughly what they are called. ' +
    'Skips node_modules, .git and build output.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: "Glob pattern, e.g. '**/*.ts'." },
      path: { type: 'string', description: "Directory to search under. Default '.'." },
    },
    required: ['pattern'],
  },
};

export const grepSchema: ToolSchema = {
  name: 'grep',
  description:
    'Search file CONTENTS by regular expression and return matching lines with their file and ' +
    'line number. Use this to find where something is defined or used. ' +
    'Skips node_modules, .git and build output.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      path: { type: 'string', description: "Directory to search under. Default '.'." },
      glob: { type: 'string', description: "Only search files matching this glob, e.g. '**/*.ts'." },
      ignoreCase: { type: 'boolean', description: 'Case-insensitive search. Default false.' },
    },
    required: ['pattern'],
  },
};

export const writeFileSchema: ToolSchema = {
  name: 'write_file',
  description:
    'Create a file or replace its entire contents. Parent directories are created as needed. ' +
    'To change part of an existing file, prefer edit_file — this overwrites everything.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the project directory.' },
      content: { type: 'string', description: 'The complete new contents of the file.' },
    },
    required: ['path', 'content'],
  },
};

export const editFileSchema: ToolSchema = {
  name: 'edit_file',
  description:
    'Replace an exact string in an existing file. The old string must appear EXACTLY once ' +
    'unless replaceAll is true, so include enough surrounding context to be unambiguous. ' +
    'Read the file first — an edit against remembered content usually fails to match.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the project directory.' },
      oldString: { type: 'string', description: 'Exact text to replace, including indentation.' },
      newString: { type: 'string', description: 'Replacement text.' },
      replaceAll: { type: 'boolean', description: 'Replace every occurrence. Default false.' },
    },
    required: ['path', 'oldString', 'newString'],
  },
};

/**
 * `run_command` — SYNCHRONOUS, and only that.
 *
 * It had a `background: true` flag once. That put the one mechanism that can give
 * the model another turn inside the toolset we withhold from `dev-claude`, and it
 * meant an ai-sdk turn had TWO ways to start background work — one that ends in a
 * report and one that does not, chosen by whichever tool the model happened to
 * reach for. Backgrounding is now `naby_start_job` in the naby layer, on every
 * engine, and this tool waits for its command like the name says.
 */
export const runCommandSchema: ToolSchema = {
  name: 'run_command',
  description:
    'Run a shell command in the project directory and WAIT for it, returning its output and exit ' +
    'code. Use it for builds, tests, git and other tooling that finishes quickly. Avoid interactive ' +
    'commands — there is no terminal to answer a prompt, and the command will simply time out. ' +
    'For work that takes longer than a minute, do not run it here and do not raise the timeout: ' +
    'start it as a background job instead, which is the only way you can report the outcome after ' +
    'this turn ends.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command line to run.' },
      timeoutMs: {
        type: 'number',
        description: `Timeout in ms (default ${COMMAND_DEFAULT_TIMEOUT_MS}, max ${COMMAND_MAX_TIMEOUT_MS}).`,
      },
    },
    required: ['command'],
  },
};

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

export function makeReadFile(cwd: string): Executor {
  return async (input): Promise<ToolOutput> => {
    const rec = asRecord(input);
    const target = resolveInside(cwd, rec.path);
    if ('error' in target) return fail(target.error);
    if (!existsSync(target.path)) return fail(`No such file: ${display(cwd, target.path)}`);

    let stat;
    try {
      stat = statSync(target.path);
    } catch (e) {
      return fail(`Could not stat ${display(cwd, target.path)}: ${String(e)}`);
    }
    if (stat.isDirectory()) {
      return fail(`${display(cwd, target.path)} is a directory — use list_dir.`);
    }

    let buf: Buffer;
    try {
      buf = readFileSync(target.path);
    } catch (e) {
      return fail(`Could not read ${display(cwd, target.path)}: ${String(e)}`);
    }
    if (looksBinary(buf)) {
      return fail(`${display(cwd, target.path)} looks like a binary file (${stat.size} bytes).`);
    }

    const lines = buf.toString('utf8').split('\n');
    const offset = Math.max(1, Math.floor(Number(rec.offset ?? 1)) || 1);
    const limit = Math.min(
      READ_MAX_LINES,
      Math.max(1, Math.floor(Number(rec.limit ?? READ_MAX_LINES)) || READ_MAX_LINES),
    );
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    if (slice.length === 0) {
      return fail(`${display(cwd, target.path)} has only ${lines.length} lines; offset ${offset} is past the end.`);
    }

    const width = String(offset + slice.length - 1).length;
    const body = slice
      .map((line, i) => `${String(offset + i).padStart(width, ' ')}\t${clip(line)}`)
      .join('\n');
    const last = offset + slice.length - 1;
    const more = last < lines.length ? `\n\n… ${lines.length - last} more lines. Read again with offset ${last + 1}.` : '';

    return {
      content: `${display(cwd, target.path)} (lines ${offset}-${last} of ${lines.length})\n${body}${more}`,
      data: { path: display(cwd, target.path), totalLines: lines.length, from: offset, to: last },
    };
  };
}

export function makeListDir(cwd: string): Executor {
  return async (input): Promise<ToolOutput> => {
    const rec = asRecord(input);
    const target = resolveInside(cwd, rec.path ?? '.');
    if ('error' in target) return fail(target.error);
    if (!existsSync(target.path)) return fail(`No such directory: ${display(cwd, target.path)}`);

    let entries;
    try {
      entries = readdirSync(target.path, { withFileTypes: true });
    } catch (e) {
      return fail(`Could not list ${display(cwd, target.path)}: ${String(e)}`);
    }

    const rows = entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort((a, b) => {
        const aDir = a.endsWith('/');
        const bDir = b.endsWith('/');
        if (aDir !== bDir) return aDir ? -1 : 1; // directories first
        return a.localeCompare(b);
      });

    const shown = rows.slice(0, LIST_MAX_ENTRIES);
    const truncated =
      rows.length > shown.length ? `\n… and ${rows.length - shown.length} more entries.` : '';
    const body = shown.length > 0 ? shown.join('\n') : '(empty)';

    return {
      content: `${display(cwd, target.path)}/\n${body}${truncated}`,
      data: { path: display(cwd, target.path), count: rows.length },
    };
  };
}

export function makeGlob(cwd: string): Executor {
  return async (input): Promise<ToolOutput> => {
    const rec = asRecord(input);
    const pattern = typeof rec.pattern === 'string' ? rec.pattern.trim() : '';
    if (!pattern) return fail('A `pattern` is required, e.g. "**/*.ts".');

    const root = resolveInside(cwd, rec.path ?? '.');
    if ('error' in root) return fail(root.error);

    let re: RegExp;
    try {
      re = globToRegExp(pattern);
    } catch (e) {
      return fail(`Invalid pattern "${pattern}": ${String(e)}`);
    }

    const hits: string[] = [];
    walkFiles(root.path, (abs) => {
      const rel = relative(root.path, abs).split(sep).join('/');
      if (!re.test(rel)) return;
      hits.push(display(cwd, abs));
      if (hits.length >= GLOB_MAX_RESULTS) return false;
      return;
    });

    if (hits.length === 0) {
      return { content: `No files match "${pattern}" under ${display(cwd, root.path)}.`, data: { count: 0 } };
    }
    const capped = hits.length >= GLOB_MAX_RESULTS ? `\n… stopped at ${GLOB_MAX_RESULTS} results.` : '';
    return {
      content: `${hits.length} file(s) matching "${pattern}":\n${hits.sort().join('\n')}${capped}`,
      data: { count: hits.length },
    };
  };
}

export function makeGrep(cwd: string): Executor {
  return async (input): Promise<ToolOutput> => {
    const rec = asRecord(input);
    const pattern = typeof rec.pattern === 'string' ? rec.pattern : '';
    if (!pattern) return fail('A `pattern` is required.');

    const root = resolveInside(cwd, rec.path ?? '.');
    if ('error' in root) return fail(root.error);

    let re: RegExp;
    try {
      re = new RegExp(pattern, rec.ignoreCase === true ? 'i' : '');
    } catch (e) {
      return fail(`Invalid regular expression "${pattern}": ${String(e)}`);
    }

    let fileFilter: RegExp | undefined;
    if (typeof rec.glob === 'string' && rec.glob.trim()) {
      try {
        fileFilter = globToRegExp(rec.glob.trim());
      } catch {
        return fail(`Invalid glob "${String(rec.glob)}".`);
      }
    }

    const out: string[] = [];
    let files = 0;
    walkFiles(root.path, (abs) => {
      if (fileFilter) {
        const rel = relative(root.path, abs).split(sep).join('/');
        if (!fileFilter.test(rel)) return;
      }
      let buf: Buffer;
      try {
        buf = readFileSync(abs);
      } catch {
        return; // unreadable file — not a reason to fail the search
      }
      if (looksBinary(buf)) return;
      const lines = buf.toString('utf8').split('\n');
      let matchedHere = false;
      for (let i = 0; i < lines.length; i += 1) {
        if (!re.test(lines[i]!)) continue;
        matchedHere = true;
        out.push(`${display(cwd, abs)}:${i + 1}: ${clip(lines[i]!.trim())}`);
        if (out.length >= GREP_MAX_MATCHES) return false;
      }
      if (matchedHere) files += 1;
      return;
    });

    if (out.length === 0) {
      return { content: `No matches for /${pattern}/ under ${display(cwd, root.path)}.`, data: { count: 0 } };
    }
    const capped = out.length >= GREP_MAX_MATCHES ? `\n… stopped at ${GREP_MAX_MATCHES} matches.` : '';
    return {
      content: `${out.length} match(es) in ${files} file(s):\n${out.join('\n')}${capped}`,
      data: { count: out.length, files },
    };
  };
}

export function makeWriteFile(cwd: string): Executor {
  return async (input): Promise<ToolOutput> => {
    const rec = asRecord(input);
    const target = resolveInside(cwd, rec.path);
    if ('error' in target) return fail(target.error);
    if (typeof rec.content !== 'string') return fail('`content` must be a string.');

    const existed = existsSync(target.path);
    if (existed) {
      try {
        if (statSync(target.path).isDirectory()) {
          return fail(`${display(cwd, target.path)} is a directory.`);
        }
      } catch {
        /* fall through to the write, which will report its own failure */
      }
    }

    try {
      mkdirSync(resolve(target.path, '..'), { recursive: true });
      writeFileSync(target.path, rec.content, 'utf8');
    } catch (e) {
      return fail(`Could not write ${display(cwd, target.path)}: ${String(e)}`);
    }

    const lines = rec.content === '' ? 0 : rec.content.split('\n').length;
    return {
      content: `${existed ? 'Overwrote' : 'Created'} ${display(cwd, target.path)} (${lines} lines, ${Buffer.byteLength(rec.content)} bytes).`,
      data: { path: display(cwd, target.path), created: !existed, bytes: Buffer.byteLength(rec.content) },
    };
  };
}

export function makeEditFile(cwd: string): Executor {
  return async (input): Promise<ToolOutput> => {
    const rec = asRecord(input);
    const target = resolveInside(cwd, rec.path);
    if ('error' in target) return fail(target.error);
    if (typeof rec.oldString !== 'string' || rec.oldString === '') {
      return fail('`oldString` must be a non-empty string.');
    }
    if (typeof rec.newString !== 'string') return fail('`newString` must be a string.');
    if (rec.oldString === rec.newString) return fail('`oldString` and `newString` are identical.');
    if (!existsSync(target.path)) {
      return fail(`No such file: ${display(cwd, target.path)} — use write_file to create it.`);
    }

    let original: string;
    try {
      original = readFileSync(target.path, 'utf8');
    } catch (e) {
      return fail(`Could not read ${display(cwd, target.path)}: ${String(e)}`);
    }

    const occurrences = original.split(rec.oldString).length - 1;
    if (occurrences === 0) {
      return fail(
        `\`oldString\` does not appear in ${display(cwd, target.path)}. ` +
          'Read the file and copy the text exactly, including indentation.',
      );
    }
    if (occurrences > 1 && rec.replaceAll !== true) {
      return fail(
        `\`oldString\` appears ${occurrences} times in ${display(cwd, target.path)}. ` +
          'Add surrounding context to make it unique, or pass replaceAll: true.',
      );
    }

    const updated =
      rec.replaceAll === true
        ? original.split(rec.oldString).join(rec.newString)
        : original.replace(rec.oldString, rec.newString);
    try {
      writeFileSync(target.path, updated, 'utf8');
    } catch (e) {
      return fail(`Could not write ${display(cwd, target.path)}: ${String(e)}`);
    }

    const replaced = rec.replaceAll === true ? occurrences : 1;
    return {
      content: `Edited ${display(cwd, target.path)} — ${replaced} replacement(s).`,
      data: { path: display(cwd, target.path), replacements: replaced },
    };
  };
}

export function makeRunCommand(cwd: string): Executor {
  return async (input, ctx): Promise<ToolOutput> => {
    const rec = asRecord(input);
    const command = typeof rec.command === 'string' ? rec.command.trim() : '';
    if (!command) return fail('A `command` is required.');

    const requested = Number(rec.timeoutMs ?? COMMAND_DEFAULT_TIMEOUT_MS);
    const timeoutMs = Number.isFinite(requested)
      ? Math.min(COMMAND_MAX_TIMEOUT_MS, Math.max(1_000, Math.floor(requested)))
      : COMMAND_DEFAULT_TIMEOUT_MS;

    return await new Promise<ToolOutput>((done) => {
      // `shell: true` on purpose — pipes and redirection are most of why a model
      // reaches for a command at all. It is also why this tool is in
      // MUTATING_TOOLS regardless of what the command appears to do.
      const child = spawn(command, {
        cwd,
        shell: true,
        // Detached so the whole process GROUP can be killed on timeout: a plain
        // kill would take the shell and leave its children running.
        detached: process.platform !== 'win32',
        env: process.env,
      });

      let out = '';
      let truncated = false;
      let settled = false;
      const append = (chunk: Buffer) => {
        if (truncated) return;
        out += chunk.toString('utf8');
        if (out.length > COMMAND_MAX_CHARS) {
          out = out.slice(0, COMMAND_MAX_CHARS);
          truncated = true;
        }
      };
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);

      const kill = () => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        kill();
        done({
          content:
            `Command timed out after ${timeoutMs}ms and was killed:\n$ ${command}\n\n` +
            `${out}${truncated ? '\n… output truncated.' : ''}`,
          isError: true,
          data: { command, timedOut: true },
        });
      }, timeoutMs);

      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        kill();
        done({ content: `Command cancelled:\n$ ${command}`, isError: true, data: { command, cancelled: true } });
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });

      const finish = (result: ToolOutput) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        done(result);
      };

      child.on('error', (e) => {
        finish(fail(`Could not run the command: ${e.message}\n$ ${command}`));
      });

      child.on('close', (code) => {
        const body = out.trim() === '' ? '(no output)' : out;
        const note = truncated ? `\n… output truncated at ${COMMAND_MAX_CHARS} characters.` : '';
        finish({
          content: `$ ${command}\n(exit ${code ?? 0})\n\n${body}${note}`,
          ...(code === 0 ? {} : { isError: true }),
          data: { command, exitCode: code ?? 0 },
        });
      });
    });
  };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Build the workspace toolset for one project directory.
 *
 * `allowMutations: false` returns ONLY the read-only tools — the model is not
 * told the others exist. That is deliberately stronger than gating them: a tool
 * the model can see but never use produces a turn that keeps trying and keeps
 * being refused, which reads to the user as the assistant being broken rather
 * than as the mode doing its job.
 */
export function buildWorkspaceTools(opts: {
  cwd: string;
  allowMutations: boolean;
}): { toolSchemas: ToolSchema[]; executors: Record<string, Executor> } {
  const { cwd } = opts;
  const toolSchemas: ToolSchema[] = [readFileSchema, listDirSchema, globSchema, grepSchema];
  const executors: Record<string, Executor> = {
    read_file: makeReadFile(cwd),
    list_dir: makeListDir(cwd),
    glob: makeGlob(cwd),
    grep: makeGrep(cwd),
  };

  if (opts.allowMutations) {
    toolSchemas.push(writeFileSchema, editFileSchema, runCommandSchema);
    executors.write_file = makeWriteFile(cwd);
    executors.edit_file = makeEditFile(cwd);
    executors.run_command = makeRunCommand(cwd);
  }

  return { toolSchemas, executors };
}
