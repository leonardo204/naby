// src/runtime/import/png.ts
//
// PNG TEXT CHUNKS — just enough to read (and, for fixtures, write) the card a
// character-card PNG carries (agent-import-adapters §3.3). A card is stored as a
// `tEXt` chunk whose keyword is `chara` (V2, base64 JSON) or `ccv3` (V3, base64
// JSON); some writers use `iTXt`/`zTXt`, which are read too.
//
// Strict and bounded: the signature is checked, every chunk length must fit in
// the buffer, the walk stops at IEND, and an inflated text chunk is capped.

import * as zlib from 'node:zlib';
import { crc32 } from '../zip.js';
import { isPng } from './common.js';

export type PngTextChunk = { keyword: string; text: string; type: 'tEXt' | 'iTXt' | 'zTXt' };

/** A text chunk larger than this (inflated) is refused — a card is kilobytes. */
const MAX_TEXT_BYTES = 8 * 1024 * 1024;

type RawChunk = { type: string; data: Uint8Array; start: number; end: number };

function readChunks(bytes: Uint8Array): RawChunk[] | undefined {
  if (!isPng(bytes)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: RawChunk[] = [];
  let off = 8;
  while (off + 12 <= bytes.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(bytes[off + 4]!, bytes[off + 5]!, bytes[off + 6]!, bytes[off + 7]!);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > bytes.length) return undefined; // truncated
    out.push({ type, data: bytes.subarray(dataStart, dataEnd), start: off, end: dataEnd + 4 });
    off = dataEnd + 4;
    if (type === 'IEND') break;
  }
  return out;
}

function latin1(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
}

/** Every text chunk in the PNG, or undefined when the bytes are not a PNG. */
export function readPngTextChunks(bytes: Uint8Array): PngTextChunk[] | undefined {
  const chunks = readChunks(bytes);
  if (!chunks) return undefined;
  const out: PngTextChunk[] = [];
  for (const c of chunks) {
    try {
      if (c.type === 'tEXt') {
        const nul = c.data.indexOf(0);
        if (nul <= 0) continue;
        out.push({ type: 'tEXt', keyword: latin1(c.data.subarray(0, nul)), text: latin1(c.data.subarray(nul + 1)) });
      } else if (c.type === 'zTXt') {
        const nul = c.data.indexOf(0);
        if (nul <= 0) continue;
        const inflated = zlib.inflateSync(c.data.subarray(nul + 2), { maxOutputLength: MAX_TEXT_BYTES });
        out.push({ type: 'zTXt', keyword: latin1(c.data.subarray(0, nul)), text: latin1(inflated) });
      } else if (c.type === 'iTXt') {
        const nul = c.data.indexOf(0);
        if (nul <= 0) continue;
        const keyword = latin1(c.data.subarray(0, nul));
        const compressed = c.data[nul + 1] === 1;
        let p = nul + 3;
        const langEnd = c.data.indexOf(0, p);
        if (langEnd < 0) continue;
        const transEnd = c.data.indexOf(0, langEnd + 1);
        if (transEnd < 0) continue;
        p = transEnd + 1;
        const raw = c.data.subarray(p);
        const body = compressed ? zlib.inflateSync(raw, { maxOutputLength: MAX_TEXT_BYTES }) : raw;
        out.push({ type: 'iTXt', keyword, text: new TextDecoder('utf-8').decode(body) });
      }
    } catch {
      /* an unreadable chunk is skipped, not fatal */
    }
  }
  return out;
}

/** The PNG without any text chunk whose keyword is in `keywords` — the image a
 *  card PNG shows, minus the card JSON it carries (§4 step 6: the avatar is the
 *  picture; the card lives in extensions). Undefined when not a PNG. */
export function stripPngTextChunks(bytes: Uint8Array, keywords: readonly string[]): Uint8Array | undefined {
  const chunks = readChunks(bytes);
  if (!chunks) return undefined;
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  for (const c of chunks) {
    if (c.type === 'tEXt' || c.type === 'zTXt' || c.type === 'iTXt') {
      const nul = c.data.indexOf(0);
      const keyword = nul > 0 ? latin1(c.data.subarray(0, nul)) : '';
      if (keywords.includes(keyword)) continue;
    }
    parts.push(bytes.subarray(c.start, c.end));
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// -- writing (fixtures and tests) ---------------------------------------------

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * A valid PNG of `width`×`height` solid RGB pixels, with `tEXt` chunks for each
 * `text` entry (latin-1 text — base64 for a card). `padBytes` adds an ancillary
 * private chunk of that size so a test can build an image over the avatar cap
 * without a real photo.
 */
export function buildPng(opts: {
  width?: number;
  height?: number;
  rgb?: [number, number, number];
  text?: Record<string, string>;
  padBytes?: number;
}): Uint8Array {
  const w = opts.width ?? 1;
  const h = opts.height ?? 1;
  const [r, g, b] = opts.rgb ?? [109, 74, 255];
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const raw = new Uint8Array(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const parts: Uint8Array[] = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
  ];
  for (const [keyword, text] of Object.entries(opts.text ?? {})) {
    const data = new Uint8Array(keyword.length + 1 + text.length);
    for (let i = 0; i < keyword.length; i++) data[i] = keyword.charCodeAt(i) & 0xff;
    data[keyword.length] = 0;
    for (let i = 0; i < text.length; i++) data[keyword.length + 1 + i] = text.charCodeAt(i) & 0xff;
    parts.push(chunk('tEXt', data));
  }
  if (opts.padBytes && opts.padBytes > 0) {
    // An ancillary, private, safe-to-copy chunk type: decoders skip it.
    const pad = new Uint8Array(opts.padBytes);
    for (let i = 0; i < pad.length; i++) pad[i] = (i * 2654435761) & 0xff;
    parts.push(chunk('prVt', pad));
  }
  parts.push(chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', new Uint8Array(0)));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
