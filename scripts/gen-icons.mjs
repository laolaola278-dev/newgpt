/**
 * Generate GPT++ toolbar/store icons (PNG, RGBA) without external deps.
 *
 * Output: public/icons/gptpp-{16,32,48,128}.png
 * Design: dark navy rounded square with a diagonal sky-blue gradient and a
 * white lightning bolt. Re-run after changing the design:
 *
 *   node scripts/gen-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'icons');
mkdirSync(outDir, { recursive: true });

// --- minimal PNG encoder ----------------------------------------------------
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- design -----------------------------------------------------------------
const BOLT = [
  [0.58, 0.10],
  [0.24, 0.56],
  [0.46, 0.56],
  [0.42, 0.90],
  [0.76, 0.42],
  [0.53, 0.42],
];

function inBolt(x, y) {
  let inside = false;
  for (let i = 0, j = BOLT.length - 1; i < BOLT.length; j = i++) {
    const [xi, yi] = BOLT[i];
    const [xj, yj] = BOLT[j];
    if (
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const corner = Math.max(2, Math.round(size * 0.22));
  const r2 = corner * corner;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const idx = (py * size + px) * 4;

      // rounded-square alpha mask
      const cx = Math.min(px, size - 1 - px);
      const cy = Math.min(py, size - 1 - py);
      if (cx < corner && cy < corner) {
        const dx = corner - cx - 0.5;
        const dy = corner - cy - 0.5;
        if (dx * dx + dy * dy > r2) continue; // transparent
      }

      // diagonal gradient #0b1220 -> #0369a1
      const t = (px / size) * 0.35 + (py / size) * 0.65;
      let r = Math.round(11 + (3 - 11) * t);
      let g = Math.round(18 + (105 - 18) * t);
      let b = Math.round(32 + (161 - 32) * t);

      const u = (px + 0.5) / size;
      const v = (py + 0.5) / size;
      if (inBolt(u, v)) {
        r = 240;
        g = 249;
        b = 255;
      }

      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = 255;
    }
  }
  return rgba;
}

for (const size of [16, 32, 48, 128]) {
  const file = join(outDir, `gptpp-${size}.png`);
  writeFileSync(file, encodePng(size, size, render(size)));
  console.log('wrote', file);
}
