#!/usr/bin/env node
// Generates the extension's PNG icons with no dependencies: a dark rounded
// square with three "text lines", the middle one highlighted. Run:
//   node tools/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
fs.mkdirSync(outDir, { recursive: true });

const BG = [0x1f, 0x23, 0x2b];      // dark slate
const LINE = [0x9a, 0xa4, 0xb2];    // muted text lines
const HILITE = [0xff, 0xd6, 0x5c];  // highlight yellow
const INK = [0x1f, 0x23, 0x2b];     // text on the highlight

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Signed distance to a rounded rectangle, for anti-aliased edges.
function roundedRectAlpha(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const d = Math.hypot(x - cx, y - cy) - r;
  return Math.max(0, Math.min(1, 0.5 - d));
}

function draw(size) {
  const s = size;
  const pad = s * 0.06;
  const lineH = s * 0.11;
  const lineR = lineH / 2;
  const rows = [0.30, 0.50, 0.70]; // y centers as fraction of size
  const widths = [0.62, 0.72, 0.48];
  return (px, py) => {
    const x = px + 0.5, y = py + 0.5;
    let col = [0, 0, 0], alpha = roundedRectAlpha(x, y, pad, pad, s - pad, s - pad, s * 0.22);
    if (alpha <= 0) return [0, 0, 0, 0];
    col = BG;
    rows.forEach((fy, i) => {
      const cy = fy * s;
      const x0 = s * 0.2, x1 = x0 + widths[i] * s;
      if (i === 1) {
        // highlight block slightly taller than the line, then ink line on top
        const a = roundedRectAlpha(x, y, x0 - s * 0.05, cy - lineH, x1 + s * 0.05, cy + lineH, lineR);
        if (a > 0) col = mix(col, HILITE, a);
        const b = roundedRectAlpha(x, y, x0, cy - lineR * 0.8, x1, cy + lineR * 0.8, lineR * 0.8);
        if (b > 0) col = mix(col, INK, b);
      } else {
        const a = roundedRectAlpha(x, y, x0, cy - lineR, x1, cy + lineR, lineR);
        if (a > 0) col = mix(col, LINE, a);
      }
    });
    return [col[0], col[1], col[2], Math.round(alpha * 255)];
  };
}

function mix(a, b, t) { return a.map((v, i) => Math.round(v + (b[i] - v) * t)); }

for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, png(size, draw(size)));
  console.log('wrote', path.relative(process.cwd(), file));
}
