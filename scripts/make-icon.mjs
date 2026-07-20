// scripts/make-icon.mjs
//
// Generates `build/icon.png` — a 1024×1024 PLACEHOLDER app mark.
//
// >>> THIS IS A PLACEHOLDER. IT IS MEANT TO BE REPLACED. <<<
// It exists because electron-builder warns on a missing icon and then ships the
// default Electron logo, which is worse than a plain mark: it tells every user
// that nobody chose an icon. To replace it, drop your own 1024×1024 PNG at
// `build/icon.png` and delete this script — nothing imports it, it is run by
// hand (`npm run icon`) and its only output is that one file.
//
// WHY IT IS GENERATED IN CODE AND NOT COMMITTED AS A BINARY BLOB: a checked-in
// PNG that nobody can regenerate is a small mystery in the repo forever. This is
// ~100 lines, has no dependencies (zlib is a node builtin), and can be tweaked.
//
// ONE PNG IS ENOUGH. electron-builder derives `.icns` (macOS) and `.ico`
// (Windows) from a single `build/icon.png` of at least 512×512, and Linux takes
// the PNG directly. There is no per-platform derivative to maintain.
//
// The mark: a flat rounded square in deep indigo with a white "N" formed by two
// stems and a diagonal, and a small accent dot. Rendered by supersampling 4× and
// box-filtering down, which is what keeps the diagonal from looking like a
// staircase without pulling in a rasteriser.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
const SS = 4; // supersample factor
const W = SIZE * SS;

// Flat palette, no gradients — a mark, not an illustration.
const BG = [0x1e, 0x1b, 0x4b]; // indigo 950
const FG = [0xf8, 0xfa, 0xfc]; // slate 50
const ACCENT = [0x6d, 0x8f, 0xff]; // periwinkle

/** Signed distance from p to the segment ab — the whole geometry kernel. */
function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const len2 = vx * vx + vy * vy;
  let t = len2 === 0 ? 0 : (wx * vx + wy * vy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (ax + t * vx);
  const dy = py - (ay + t * vy);
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Rounded-square coverage test, over the INSET box [x0,x1]×[y0,y1].
 *
 * The inset matters. macOS composites app icons on a grid that assumes ~10%
 * transparent margin and a squircle silhouette; a full-bleed square renders as
 * a visibly larger, visibly square tile next to every other icon in the Dock.
 * Windows and Linux are happy either way, so the macOS convention wins.
 */
function inRoundedSquare(x, y, x0, y0, x1, y1, radius) {
  const cx = Math.min(Math.max(x, x0 + radius), x1 - radius);
  const cy = Math.min(Math.max(y, y0 + radius), y1 - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

// -- render at 4× ----------------------------------------------------------

// RGBA: the margin outside the squircle is genuinely transparent, not black.
const hi = new Uint8Array(W * W * 4);

const MARGIN = 0.085;
const BOX0 = W * MARGIN;
const BOX1 = W * (1 - MARGIN);

// "N" geometry, in 0..1 units of the full canvas.
const u = (v) => v * W;
const STEM = u(0.085); // stroke half-width
const TOP = u(0.3);
const BOT = u(0.72);
const LEFT = u(0.315);
const RIGHT = u(0.685);

const strokes = [
  [LEFT, BOT, LEFT, TOP], // left stem
  [RIGHT, BOT, RIGHT, TOP], // right stem
  [LEFT, TOP, RIGHT, BOT], // diagonal
];

const dotX = u(0.685);
const dotY = u(0.253);
const dotR = u(0.052);

for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    const px = x + 0.5;
    const py = y + 0.5;
    let c = BG;
    let a = 255;

    if (!inRoundedSquare(px, py, BOX0, BOX0, BOX1, BOX1, u(0.2))) {
      a = 0;
    } else {
      let isFg = false;
      for (const [ax, ay, bx, by] of strokes) {
        if (segDist(px, py, ax, ay, bx, by) <= STEM) {
          isFg = true;
          break;
        }
      }
      if (isFg) c = FG;
      const dd = Math.hypot(px - dotX, py - dotY);
      if (dd <= dotR) c = ACCENT;
    }

    const i = (y * W + x) * 4;
    hi[i] = c[0];
    hi[i + 1] = c[1];
    hi[i + 2] = c[2];
    hi[i + 3] = a;
  }
}

// -- box-filter down to 1024 ----------------------------------------------

const lo = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * W + (x * SS + sx)) * 4;
        r += hi[i];
        g += hi[i + 1];
        b += hi[i + 2];
        a += hi[i + 3];
      }
    }
    const n = SS * SS;
    const o = (y * SIZE + x) * 4;
    // RGB is averaged UNPREMULTIPLIED and that is safe here: every subsample of
    // a boundary pixel carries the squircle's own background colour, so there is
    // no foreign colour to bleed in and no dark fringe to correct for.
    lo[o] = Math.round(r / n);
    lo[o + 1] = Math.round(g / n);
    lo[o + 2] = Math.round(b / n);
    lo[o + 3] = Math.round(a / n);
  }
}

// -- PNG encode (RGBA8, filter 0) -----------------------------------------

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

let CRC_TABLE;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter type: none
  lo.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'build', 'icon.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);

console.log(`icon: build/icon.png ${SIZE}x${SIZE} (${(png.length / 1024).toFixed(1)} KB) — PLACEHOLDER, replace me`);
