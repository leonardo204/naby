// src/runtime/import/common.ts
//
// Small readers every adapter shares. Each treats its input as hostile: a value
// of the wrong type reads as absent, never as a throw.

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A non-empty trimmed string, or undefined. */
export function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/** A string list from a YAML sequence or a comma-separated scalar (the two forms
 *  Claude Code frontmatter uses for tool lists). Undefined when empty. */
export function strList(v: unknown): string[] | undefined {
  let arr: string[];
  if (Array.isArray(v)) {
    arr = v
      .filter((x) => typeof x === 'string' || typeof x === 'number')
      .map((x) => String(x).trim())
      .filter(Boolean);
  } else if (typeof v === 'string') {
    arr = v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } else {
    return undefined;
  }
  return arr.length > 0 ? arr : undefined;
}

/** UTF-8 text of the bytes (a BOM is dropped; bad sequences become U+FFFD). */
export function utf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
}

export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Cut a string to at most `max` UTF-8 bytes without splitting a character. */
export function clipUtf8(s: string, max: number): string {
  if (utf8Bytes(s) <= max) return s;
  let out = '';
  let used = 0;
  for (const ch of s) {
    const n = utf8Bytes(ch);
    if (used + n > max) break;
    out += ch;
    used += n;
  }
  return out;
}

/** The base name without its last extension (and without `.naby` before `.json`). */
export function stem(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  return base.replace(/\.naby\.json$/i, '').replace(/\.[^.]+$/, '');
}

/**
 * Shape any display name into an `@` handle: lowercase, runs of anything other
 * than a letter, digit, `_` or `-` become one `-`. Letters are Unicode letters,
 * so a Korean name stays Korean (§3.3: no romanisation) and only its spaces turn
 * into hyphens. Never starts with `/`, `.` or `~` and never holds `@` (the
 * participant name rule). Empty → `participant`.
 */
export function toHandle(name: string): string {
  const h = name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return h || 'participant';
}

/**
 * Make a name usable as an `@` handle WITHOUT restyling it (a Claude subagent's
 * or a naby sidecar's name is already a handle): whitespace runs become `-`,
 * `@` is removed, and a leading `/`, `.` or `~` is dropped (those read as a file
 * reference). Empty → `participant`.
 */
export function sanitizeHandle(name: string): string {
  const h = name
    .trim()
    .replace(/\s+/g, '-')
    .replace(/@/g, '')
    .replace(/^[/.~]+/, '')
    .slice(0, 64);
  return h || 'participant';
}

/** `true` when the bytes start with the PNG signature. */
export function isPng(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

/** `true` when the bytes start with a zip local-file header (`PK\x03\x04`). */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** JSON of the bytes when they are a JSON object, else undefined. Cheap reject
 *  for binary input (first non-space byte must be `{`). */
export function jsonObject(bytes: Uint8Array): Record<string, unknown> | undefined {
  let i = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x0a || bytes[i] === 0x0d || bytes[i] === 0x09)) i++;
  if (bytes[i] !== 0x7b) return undefined;
  try {
    const v = JSON.parse(utf8(bytes)) as unknown;
    return isRecord(v) ? v : undefined;
  } catch {
    return undefined;
  }
}
