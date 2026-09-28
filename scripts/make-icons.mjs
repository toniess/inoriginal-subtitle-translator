// Generates src/icons/icon-{16,32,48,128}.png without external dependencies.
// Design: dark rounded square with two yellow "subtitle lines".
// Run: npm run icons

import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'icons');
const SIZES = [16, 32, 48, 128];

const BG = [0x1a, 0x1a, 0x1a];
const FG = [0xff, 0xdd, 0x57];
const FG_DIM = [0xc9, 0xae, 0x44];

// Signed distance to a rounded rectangle (all coords in 0..1 space).
function sdRoundRect(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - hw + r;
  const dy = Math.abs(y - cy) - hh + r;
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r;
}

function coverage(d, px) {
  // Antialias over ~1 pixel.
  return Math.min(Math.max(0.5 - d / px, 0), 1);
}

function render(size) {
  const px = 1 / size;
  const data = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (i + 0.5) / size;
      const y = (j + 0.5) / size;

      const a = coverage(sdRoundRect(x, y, 0.5, 0.5, 0.47, 0.47, 0.2), px);
      const line1 = coverage(sdRoundRect(x, y, 0.5, 0.56, 0.32, 0.075, 0.075), px);
      const line2 = coverage(sdRoundRect(x, y, 0.5, 0.76, 0.22, 0.075, 0.075), px);
      const dot = coverage(sdRoundRect(x, y, 0.5, 0.28, 0.1, 0.1, 0.1), px);

      const color = mix(mix(BG, FG, Math.max(line1, line2)), FG_DIM, dot);

      const o = (j * size + i) * 4;
      data[o] = color[0];
      data[o + 1] = color[1];
      data[o + 2] = color[2];
      data[o + 3] = Math.round(a * 255);
    }
  }
  return encodePng(size, size, data);
}

function mix(a, b, t) {
  return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * t));
}

// ---------- Minimal PNG encoder (RGBA, 8-bit) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([len, typed, crc]);
}

function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, render(size));
  console.log(`wrote ${file}`);
}
