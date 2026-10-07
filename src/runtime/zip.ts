// src/runtime/zip.ts
//
// A SMALL, STRICT ZIP READER (and a writer for fixtures) — org-harness-sync §3.1.
//
// WHY NOT A DEPENDENCY. The org package is one zip of ~0.5 MB, produced by one
// server we know (Skill Hub), extracted in the Electron main process and in a
// spike. Everything a reader needs is already in Node: `zlib.inflateRawSync` for
// deflate and `zlib.crc32` for the checksum. A library (yauzl, fflate, adm-zip)
// would add a supply-chain surface to the one code path that writes
// network-delivered bytes onto the user's disk, to save ~200 lines whose every
// branch a spike exercises. The runtime bundle (`build:runtime`) also inlines its
// dependencies, so a library would ship twice (runtime + shell).
//
// WHAT IT ACCEPTS, AND WHAT IT REFUSES. Deliberately narrow, because a narrow
// reader is an auditable one:
//
//   * methods 0 (stored) and 8 (deflate) only; encrypted entries are refused;
//   * no ZIP64 (the package is far below 4 GiB; a ZIP64 marker is refused rather
//     than misread);
//   * sizes and offsets come from the CENTRAL DIRECTORY, never from the local
//     header — the local header's sizes are zero when a data descriptor is used;
//   * every entry's CRC-32 and inflated size are checked, and inflation is capped
//     at the declared size (`maxOutputLength`), so a lying entry cannot balloon;
//   * total entry count and total inflated bytes are capped;
//   * ZIP-SLIP: a name that is absolute, has a drive letter, contains a `..`
//     segment, a backslash or a NUL, or resolves outside the destination is
//     refused — the whole archive, not just the entry, because an archive that
//     tries to write outside its folder is not one we want any part of;
//   * symlink entries are refused (a link inside the package could point
//     anywhere, and nothing in the package needs one);
//   * duplicate names are refused (`wx` open), so a later entry cannot overwrite
//     an earlier one.
//
// THE CALLER EXTRACTS INTO AN EMPTY STAGING DIRECTORY. This module never decides
// where a package "lives"; it fills a directory or throws. On a throw the staging
// directory may be half-written, and it is the caller's job to delete it — the
// live version is untouched because it is somewhere else (org-harness.ts).

import { mkdirSync, openSync, closeSync, writeSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import * as zlib from 'node:zlib';

/** Thrown for anything this reader refuses. `code` names the reason so a caller
 *  (and a spike) can tell a zip-slip from a corrupt entry. */
export class ZipError extends Error {
  constructor(
    readonly code:
      | 'not-zip'
      | 'zip64'
      | 'encrypted'
      | 'method'
      | 'unsafe-path'
      | 'symlink'
      | 'duplicate'
      | 'crc'
      | 'size'
      | 'limit'
      | 'truncated',
    message: string,
  ) {
    super(message);
    this.name = 'ZipError';
  }
}

export type ZipLimits = {
  /** Maximum number of entries (files + directories). */
  maxEntries: number;
  /** Maximum sum of inflated file sizes, in bytes. */
  maxTotalBytes: number;
};

/** Generous for a ~0.5 MB package of ~150 files, small enough that a hostile
 *  archive cannot fill a disk. */
export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 5000,
  maxTotalBytes: 256 * 1024 * 1024,
};

/** One entry as read from the central directory. */
type CentralEntry = {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  madeByHost: number;
  externalAttrs: number;
};

// -- CRC-32 -------------------------------------------------------------------
//
// `zlib.crc32` exists from Node 20.15 / 22.2. Electron 43 and the dev toolchain
// have it; the table fallback keeps an older embedded Node from failing open
// (a missing checksum function must not mean "skip the checksum").

let crcTable: Uint32Array | undefined;
function crc32Fallback(buf: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function crc32(buf: Uint8Array): number {
  const native = (zlib as { crc32?: (data: Uint8Array) => number }).crc32;
  return native ? native(buf) >>> 0 : crc32Fallback(buf);
}

// -- reading ------------------------------------------------------------------

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function findEocd(buf: Buffer): number {
  // The EOCD record is 22 bytes plus a comment of up to 65535 bytes.
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new ZipError('not-zip', 'no end-of-central-directory record');
}

function readCentralDirectory(buf: Buffer): CentralEntry[] {
  if (buf.length < 22) throw new ZipError('not-zip', 'too short to be a zip');
  const eocd = findEocd(buf);
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipError('zip64', 'ZIP64 archives are not supported');
  }
  if (cdOffset + cdSize > eocd) throw new ZipError('truncated', 'central directory out of range');

  const entries: CentralEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) {
      throw new ZipError('truncated', `central directory entry ${i} is malformed`);
    }
    const madeBy = buf.readUInt16LE(p + 4);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttrs = buf.readUInt32LE(p + 38);
    const localOffset = buf.readUInt32LE(p + 42);
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw new ZipError('zip64', 'ZIP64 entries are not supported');
    }
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({
      name,
      method,
      flags,
      crc,
      compressedSize,
      size,
      localOffset,
      madeByHost: madeBy >> 8,
      externalAttrs,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * The ZIP-SLIP check. Returns the absolute target for a SAFE entry name, or
 * throws. Stated as rules on the raw name first (cheap, and the error names the
 * actual reason), then confirmed by resolving against the destination — the
 * second check is the one that cannot be argued with.
 */
export function safeEntryTarget(destDir: string, name: string): string {
  const reject = (why: string): never => {
    throw new ZipError('unsafe-path', `refusing entry "${name}": ${why}`);
  };
  if (name.length === 0) reject('empty name');
  if (name.includes('\0')) reject('NUL in name');
  if (name.includes('\\')) reject('backslash in name');
  if (name.startsWith('/') || isAbsolute(name)) reject('absolute path');
  if (/^[A-Za-z]:/.test(name)) reject('drive letter');
  const segments = name.split('/');
  if (segments.some((s) => s === '..')) reject('parent-directory segment');
  const root = resolve(destDir);
  const target = resolve(root, name);
  if (target !== root && !target.startsWith(root + sep)) reject('resolves outside destination');
  return target;
}

function isSymlink(e: CentralEntry): boolean {
  // Unix "made by" (3) carries st_mode in the high 16 bits of the external attrs.
  if (e.madeByHost !== 3) return false;
  const mode = (e.externalAttrs >>> 16) & 0o170000;
  return mode === 0o120000;
}

function isExecutable(e: CentralEntry): boolean {
  if (e.madeByHost !== 3) return false;
  return ((e.externalAttrs >>> 16) & 0o111) !== 0;
}

function entryData(buf: Buffer, e: CentralEntry): Buffer {
  const p = e.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== LOC_SIG) {
    throw new ZipError('truncated', `local header of "${e.name}" is malformed`);
  }
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const end = start + e.compressedSize;
  if (end > buf.length) throw new ZipError('truncated', `data of "${e.name}" runs past the end`);
  const raw = buf.subarray(start, end);
  let out: Buffer;
  if (e.method === 0) {
    out = Buffer.from(raw);
  } else if (e.method === 8) {
    try {
      // Capped at the DECLARED size: an entry that inflates past what it claims is
      // either corrupt or a bomb, and either way we stop at the claim.
      out = e.size === 0 ? Buffer.alloc(0) : zlib.inflateRawSync(raw, { maxOutputLength: e.size });
    } catch (err) {
      throw new ZipError(
        'size',
        `"${e.name}" does not inflate to its declared size: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    throw new ZipError('method', `"${e.name}" uses unsupported compression method ${e.method}`);
  }
  if (out.length !== e.size) {
    throw new ZipError('size', `"${e.name}" inflated to ${out.length} bytes, declared ${e.size}`);
  }
  if (crc32(out) !== e.crc) throw new ZipError('crc', `"${e.name}" failed its CRC-32 check`);
  return out;
}

export type ExtractResult = { files: number; directories: number; bytes: number };

/**
 * Extract `zip` into `destDir`, which should be a fresh, empty staging directory.
 *
 * VALIDATES EVERY NAME BEFORE WRITING ANY BYTE. A zip-slip entry anywhere in the
 * archive refuses the whole archive with nothing written, which is simpler to
 * reason about than "it wrote the first 40 files and then stopped". Corruption
 * that can only be seen by inflating (a CRC mismatch) is necessarily found
 * mid-way; the caller discards the staging directory either way.
 */
export function extractZip(
  zip: Uint8Array,
  destDir: string,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): ExtractResult {
  const buf = Buffer.isBuffer(zip) ? zip : Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  const entries = readCentralDirectory(buf);
  if (entries.length > limits.maxEntries) {
    throw new ZipError('limit', `archive has ${entries.length} entries (limit ${limits.maxEntries})`);
  }

  // Pass 1: decide everything that can be decided without inflating.
  const seen = new Set<string>();
  let declaredTotal = 0;
  const plan = entries.map((e) => {
    if (e.flags & 0x1) throw new ZipError('encrypted', `"${e.name}" is encrypted`);
    if (isSymlink(e)) throw new ZipError('symlink', `"${e.name}" is a symbolic link`);
    const isDir = e.name.endsWith('/');
    const target = safeEntryTarget(destDir, isDir ? e.name.slice(0, -1) || '.' : e.name);
    const key = target.toLowerCase(); // case-insensitive filesystems collide too
    if (!isDir) {
      if (seen.has(key)) throw new ZipError('duplicate', `"${e.name}" appears twice`);
      seen.add(key);
      declaredTotal += e.size;
    }
    return { e, isDir, target };
  });
  if (declaredTotal > limits.maxTotalBytes) {
    throw new ZipError('limit', `archive inflates to ${declaredTotal} bytes (limit ${limits.maxTotalBytes})`);
  }

  // Pass 2: write.
  mkdirSync(destDir, { recursive: true });
  const out: ExtractResult = { files: 0, directories: 0, bytes: 0 };
  for (const { e, isDir, target } of plan) {
    if (isDir) {
      mkdirSync(target, { recursive: true });
      out.directories += 1;
      continue;
    }
    const data = entryData(buf, e);
    mkdirSync(dirname(target), { recursive: true });
    // 'wx' — never overwrite. The staging directory is fresh, so an existing file
    // here can only be a second entry for the same path.
    const fd = openSync(target, 'wx', isExecutable(e) ? 0o755 : 0o644);
    try {
      writeSync(fd, data);
    } finally {
      closeSync(fd);
    }
    if (isExecutable(e)) {
      try {
        chmodSync(target, 0o755);
      } catch {
        /* Windows: no mode bits to keep */
      }
    }
    out.files += 1;
    out.bytes += data.length;
  }
  return out;
}

/** List entry names without extracting — for diagnostics and spikes. */
export function listZipEntries(zip: Uint8Array): string[] {
  const buf = Buffer.isBuffer(zip) ? zip : Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  return readCentralDirectory(buf).map((e) => e.name);
}

// -- writing (fixtures) -------------------------------------------------------
//
// The product never writes a zip. This exists so a spike and a shell test can
// build a package (or a hostile one) from a directory listing without a binary
// fixture in the tree. It deliberately writes WHATEVER NAME IT IS GIVEN — the
// zip-slip test needs a `../` entry, and refusing it here would make that test
// impossible to write.

export type ZipWriteEntry = {
  name: string;
  data: string | Uint8Array;
  /** 0 = stored, 8 = deflate (default). */
  method?: 0 | 8;
  /** Unix mode bits (e.g. 0o755, or 0o120777 for a symlink entry). */
  unixMode?: number;
  /** Fixture-only: write a wrong CRC so extraction fails on this entry. */
  corruptCrc?: boolean;
};

export function buildZip(entries: readonly ZipWriteEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : Buffer.from(entry.data);
    const method = entry.method ?? 8;
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = (crc32(data) ^ (entry.corruptCrc ? 0xdeadbeef : 0)) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOC_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CEN_SIG, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    const mode = entry.unixMode ?? (entry.name.endsWith('/') ? 0o040755 : 0o100644);
    central.writeUInt32LE(((mode & 0xffff) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
