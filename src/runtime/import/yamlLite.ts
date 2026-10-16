// src/runtime/import/yamlLite.ts
//
// ENOUGH YAML FOR AGENT FRONTMATTER — and no dependency.
//
// The runtime bundle carries no YAML library (org-harness.ts makes the same
// choice for SKILL.md). Moving `parseSubagentArtifact` into the runtime
// (agent-import-adapters §3.1) means the runtime now reads Claude Code subagent
// frontmatter itself, and that frontmatter is richer than a SKILL.md's: tool
// lists in either form, `skills:`/`mcpServers:` sequences, nested `hooks:` maps.
//
// WHAT IT READS — the block subset real frontmatter uses:
//   * block mappings and sequences at any depth, including `- key: v` items and
//     a sequence written at its parent key's indentation;
//   * plain scalars (multi-line plain folds with spaces), `'single'` and
//     `"double"` quoted (escapes, multi-line), `|`/`>` block scalars with
//     chomping indicators;
//   * flow collections `[a, b]` / `{a: 1}`, nested, across lines;
//   * the YAML 1.2 core schema for plain scalars: true/false, null/~, ints and
//     floats. (`yes`/`no` stay strings — as js-yaml reads them.)
//   * comments after whitespace.
// What it does not: anchors/aliases (the `*name` stays a string), tags (dropped),
// multiple documents, complex keys. Anything it cannot read THROWS, and the
// caller (`parseFrontmatter`) degrades to "no frontmatter" — the same thing the
// shell's js-yaml path does on a parse error.

type Line = { indent: number; text: string; raw: string };

class YamlLiteError extends Error {}

const KEY_LINE =
  /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#?:,[\]{}|>!&*%@`-][^#]*?|-[^\s#][^#]*?)[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/;

function unquoteKey(k: string): string {
  if (k.startsWith('"')) return parseDoubleQuoted(k.slice(1, -1));
  if (k.startsWith("'")) return k.slice(1, -1).replace(/''/g, "'");
  return k.trim();
}

/** A plain scalar under the YAML 1.2 core schema. */
function coerce(s: string): unknown {
  const v = s.trim();
  if (v === '' || v === '~' || /^(?:null|Null|NULL)$/.test(v)) return null;
  if (/^(?:true|True|TRUE)$/.test(v)) return true;
  if (/^(?:false|False|FALSE)$/.test(v)) return false;
  if (/^[-+]?\d+$/.test(v)) {
    const n = Number(v);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?$/.test(v)) return Number(v);
  return v;
}

function parseDoubleQuoted(inner: string): string {
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const n = inner[++i];
    switch (n) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case '0': out += '\0'; break;
      case '"': out += '"'; break;
      case '\\': out += '\\'; break;
      case '/': out += '/'; break;
      case ' ': out += ' '; break;
      case 'x':
        out += String.fromCharCode(parseInt(inner.slice(i + 1, i + 3), 16));
        i += 2;
        break;
      case 'u':
        out += String.fromCharCode(parseInt(inner.slice(i + 1, i + 5), 16));
        i += 4;
        break;
      case 'U':
        out += String.fromCodePoint(parseInt(inner.slice(i + 1, i + 9), 16));
        i += 8;
        break;
      default:
        out += n ?? '';
    }
  }
  return out;
}

/** Strip a trailing ` # comment` from a plain scalar. */
function stripComment(s: string): string {
  const m = /(^|[ \t])#/.exec(s);
  return (m ? s.slice(0, m.index) : s).trimEnd();
}

/** Index just past the closing quote of a quoted scalar starting at s[0], or -1. */
function closingQuote(s: string): number {
  const q = s[0];
  for (let k = 1; k < s.length; k++) {
    if (q === "'" && s[k] === "'") {
      if (s[k + 1] === "'") {
        k += 1;
        continue;
      }
      return k + 1;
    }
    if (q === '"') {
      if (s[k] === '\\') {
        k += 1;
        continue;
      }
      if (s[k] === '"') return k + 1;
    }
  }
  return -1;
}

function readQuoted(s: string): string {
  return s[0] === '"' ? parseDoubleQuoted(s.slice(1, -1)) : s.slice(1, -1).replace(/''/g, "'");
}

// -- flow collections ---------------------------------------------------------

function parseFlow(src: string): unknown {
  let i = 0;
  const ws = () => {
    while (i < src.length && /\s/.test(src[i]!)) i++;
  };
  const value = (stops: string): unknown => {
    ws();
    const c = src[i];
    if (c === '[') {
      i++;
      const arr: unknown[] = [];
      ws();
      if (src[i] === ']') {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value(',]'));
        ws();
        if (src[i] === ',') {
          i++;
          ws();
          if (src[i] === ']') {
            i++;
            return arr;
          }
          continue;
        }
        if (src[i] === ']') {
          i++;
          return arr;
        }
        throw new YamlLiteError('unterminated flow sequence');
      }
    }
    if (c === '{') {
      i++;
      const obj: Record<string, unknown> = {};
      ws();
      if (src[i] === '}') {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        const k = value(':,}');
        ws();
        let v: unknown = null;
        if (src[i] === ':') {
          i++;
          v = value(',}');
        }
        obj[String(k)] = v;
        ws();
        if (src[i] === ',') {
          i++;
          ws();
          if (src[i] === '}') {
            i++;
            return obj;
          }
          continue;
        }
        if (src[i] === '}') {
          i++;
          return obj;
        }
        throw new YamlLiteError('unterminated flow mapping');
      }
    }
    if (c === '"' || c === "'") {
      const end = closingQuote(src.slice(i));
      if (end < 0) throw new YamlLiteError('unterminated quoted scalar');
      const s = readQuoted(src.slice(i, i + end));
      i += end;
      return s;
    }
    const start = i;
    while (i < src.length) {
      const ch = src[i]!;
      if (stops.includes(ch)) {
        // `:` ends a key only when followed by whitespace or a flow indicator.
        if (ch !== ':' || i + 1 >= src.length || /[\s,\]}]/.test(src[i + 1]!)) break;
      }
      i++;
    }
    return coerce(src.slice(start, i));
  };
  const v = value('');
  ws();
  if (i < src.length) throw new YamlLiteError('trailing characters after a flow collection');
  return v;
}

function flowBalanced(s: string): boolean {
  let depth = 0;
  let quote: string | undefined;
  for (let k = 0; k < s.length; k++) {
    const c = s[k]!;
    if (quote) {
      if (quote === '"' && c === '\\') k++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth <= 0 && !quote;
}

// -- block structure ----------------------------------------------------------

class Reader {
  i = 0;
  constructor(readonly lines: Line[]) {}

  /** Next line that carries content (not blank, not a full-line comment). */
  peek(): Line | undefined {
    while (this.i < this.lines.length) {
      const l = this.lines[this.i]!;
      if (l.text === '' || l.text.startsWith('#')) {
        this.i++;
        continue;
      }
      return l;
    }
    return undefined;
  }

  block(minIndent: number): unknown {
    const l = this.peek();
    if (!l || l.indent < minIndent) return null;
    if (l.text === '-' || l.text.startsWith('- ')) return this.seq(l.indent);
    if (KEY_LINE.test(l.text)) return this.map(l.indent);
    // A bare scalar block (rare in frontmatter): fold the lines.
    const parts: string[] = [];
    while (this.peek() && this.peek()!.indent >= minIndent) parts.push(this.lines[this.i++]!.text);
    return this.scalarRest(parts.join(' '), minIndent - 1);
  }

  map(indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (;;) {
      const l = this.peek();
      if (!l || l.indent < indent) return out;
      if (l.indent > indent) throw new YamlLiteError(`unexpected indentation: ${l.raw}`);
      const m = KEY_LINE.exec(l.text);
      if (!m) {
        if (l.text === '-' || l.text.startsWith('- ')) return out; // a sibling sequence ends the map
        throw new YamlLiteError(`not a key: ${l.raw}`);
      }
      this.i++;
      const key = unquoteKey(m[1]!);
      const rest = (m[2] ?? '').trim();
      out[key] = this.valueAfterKey(rest, indent);
    }
  }

  valueAfterKey(rest: string, indent: number): unknown {
    const body = stripTag(rest);
    if (stripComment(body) === '') {
      const next = this.peek();
      if (!next) return null;
      if (next.indent > indent) return this.block(next.indent);
      if (next.indent === indent && (next.text === '-' || next.text.startsWith('- '))) return this.seq(indent);
      return null;
    }
    return this.scalarRest(body, indent);
  }

  seq(indent: number): unknown[] {
    const out: unknown[] = [];
    for (;;) {
      const l = this.peek();
      if (!l || l.indent !== indent || !(l.text === '-' || l.text.startsWith('- '))) return out;
      const after = l.text === '-' ? '' : l.text.slice(2);
      const lead = after.length - after.trimStart().length;
      const content = after.trim();
      if (content === '' || content.startsWith('#')) {
        this.i++;
        const next = this.peek();
        out.push(next && next.indent > indent ? this.block(next.indent) : null);
        continue;
      }
      const itemIndent = indent + 2 + lead;
      if (content === '-' || content.startsWith('- ') || KEY_LINE.test(content)) {
        // `- key: v` / `- - x`: the item is a block that starts on this line, so
        // the line is re-read as if `- ` were indentation.
        this.lines[this.i] = { indent: itemIndent, text: content, raw: l.raw };
        out.push(this.block(itemIndent));
        continue;
      }
      this.i++;
      out.push(this.scalarRest(content, indent));
    }
  }

  /** The value text after `key:` or `- ` (already on the current line, which has
   *  been consumed), plus any continuation lines indented past `indent`. */
  scalarRest(first: string, indent: number): unknown {
    const s = first.trim();
    if (s.startsWith('"') || s.startsWith("'")) {
      let acc = s;
      let end = closingQuote(acc);
      while (end < 0) {
        const l = this.lines[this.i];
        if (!l) throw new YamlLiteError('unterminated quoted scalar');
        this.i++;
        acc += l.text === '' ? '\n' : ` ${l.text}`;
        end = closingQuote(acc);
      }
      const tail = stripComment(acc.slice(end)).trim();
      if (tail !== '') throw new YamlLiteError(`text after a quoted scalar: ${tail}`);
      // Folding: a line break inside quotes reads as a space (an empty line as \n).
      return readQuoted(acc.slice(0, end).replace(/ ?\n ?/g, '\n'));
    }
    if (s.startsWith('[') || s.startsWith('{')) {
      let acc = s;
      while (!flowBalanced(acc)) {
        const l = this.lines[this.i];
        if (!l) throw new YamlLiteError('unterminated flow collection');
        this.i++;
        acc += ` ${l.text}`;
      }
      return parseFlow(stripComment(acc));
    }
    const header = stripComment(s);
    const block = /^([|>])([+-]?)(\d?)$/.exec(header) ?? /^([|>])(\d?)([+-]?)$/.exec(header);
    if (block) {
      const folded = block[1] === '>';
      const chomp = header.includes('+') ? 'keep' : header.includes('-') ? 'strip' : 'clip';
      const raws: string[] = [];
      let blockIndent = -1;
      while (this.i < this.lines.length) {
        const l = this.lines[this.i]!;
        if (l.text === '') {
          raws.push('');
          this.i++;
          continue;
        }
        if (l.indent <= indent) break;
        if (blockIndent < 0) blockIndent = l.indent;
        if (l.indent < blockIndent) break;
        raws.push(l.raw.slice(blockIndent));
        this.i++;
      }
      let trailing = 0;
      while (raws.length > 0 && raws[raws.length - 1] === '') {
        raws.pop();
        trailing++;
      }
      let text: string;
      if (folded) {
        // Folding: adjacent text lines join with a space; each empty line is one
        // newline; more-indented lines keep their breaks.
        text = '';
        let prev: 'start' | 'text' | 'empty' | 'more' = 'start';
        for (const cur of raws) {
          if (cur === '') {
            text += '\n';
            prev = 'empty';
            continue;
          }
          const more = /^\s/.test(cur);
          if (prev === 'start' || prev === 'empty') text += cur;
          else if (prev === 'text' && !more) text += ` ${cur}`;
          else text += `\n${cur}`;
          prev = more ? 'more' : 'text';
        }
      } else {
        text = raws.join('\n');
      }
      if (raws.length === 0) return '';
      if (chomp === 'strip') return text;
      if (chomp === 'keep') return text + '\n'.repeat(trailing + 1);
      return `${text}\n`;
    }
    // A multi-line plain scalar folds its continuation lines with spaces.
    const parts = [header];
    while (this.i < this.lines.length) {
      const l = this.lines[this.i]!;
      if (l.text === '') {
        // A blank line inside a plain scalar is a newline — but only if the
        // scalar continues after it.
        let j = this.i;
        while (j < this.lines.length && this.lines[j]!.text === '') j++;
        const after = this.lines[j];
        if (!after || after.indent <= indent || after.text.startsWith('#')) break;
        parts.push('\n');
        this.i = j;
        continue;
      }
      if (l.indent <= indent || l.text.startsWith('#')) break;
      if (KEY_LINE.test(l.text) && l.indent <= indent + 1) break;
      parts.push(stripComment(l.text));
      this.i++;
    }
    const joined = parts.reduce((acc, p) => (p === '\n' ? `${acc}\n` : acc === '' || acc.endsWith('\n') ? acc + p : `${acc} ${p}`), '');
    return parts.length === 1 ? coerce(joined) : joined.trim();
  }
}

/** Drop a leading `!tag` and `&anchor` from a value. */
function stripTag(s: string): string {
  return s.replace(/^(?:[!&][^\s]*\s*)+/, '');
}

/**
 * Parse a YAML document (the frontmatter subset above). THROWS on anything it
 * cannot read — callers treat that as "no frontmatter".
 */
export function loadYamlLite(src: string): unknown {
  const lines: Line[] = src.split(/\r?\n/).map((raw) => {
    if (/^\t/.test(raw)) throw new YamlLiteError('tabs are not allowed for indentation');
    const text = raw.trim();
    return { indent: raw.length - raw.trimStart().length, text, raw };
  });
  const r = new Reader(lines);
  const first = r.peek();
  if (!first) return null;
  const v = r.block(first.indent);
  if (r.peek()) throw new YamlLiteError(`unexpected content: ${r.peek()!.raw}`);
  return v;
}
