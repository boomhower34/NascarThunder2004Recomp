// nr2003-mip.mjs — Papyrus NR2003 .mip textures -> RGBA (and PNG).
//
// File: a 32-byte header (u16 version 2 / 4, u8 format, u8 flags, u32 log2 width, u32 log2 height, u8[4] colour,
// u32 levels, ...), then one chunk group per mip level, smallest first:
//   "PAMB" u32 0 u32 size { "DHMB" u32 0 u32 14: u8 format, u32 width, u32 height, u32 ?, u8 packed (padded to 4)
//                           "ATAD" u32 0 u32 size: the level's pixels }
// (IFF-style tags stored backwards: BMAP / BMHD / DATA.) Formats: 0x0a DXT1 (8 bytes per 4x4 block; flags bit 1 = has
// 1-bit alpha), 0x0b DXT3 (explicit 4-bit alpha), 3 / 4 uncompressed (bytes per pixel from the level size).
//
// usage: import { readMip, pngOf } from "./nr2003-mip.mjs"; const { width, height, rgba } = readMip(buf)
//        node nr2003-mip.mjs <in.mip> <out.png>

import { readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { basename } from "node:path";
import { explode } from "./nr2003-dat.mjs";

export function mipLevels(b) {
  const levels = []; let p = 0x20, cur = null;
  while (p + 12 <= b.length) {
    const tag = b.toString("latin1", p, p + 4), size = b.readUInt32LE(p + 8);
    if (tag === "PAMB") { p += 12; continue; }                    // a container: walk into it
    if (tag === "DHMB") cur = { format: b[p + 12], width: b.readUInt32LE(p + 13), height: b.readUInt32LE(p + 17), packed: b[p + 25] };
    else if (tag === "ATAD" && cur) { const raw = b.subarray(p + 12, p + 12 + size); levels.push({ ...cur, data: cur.packed ? explode(raw) : raw }); cur = null; }
    else if (!/^[A-Z]{4}$/.test(tag)) break;
    p += 12 + size + (-size & 3);
  }
  return levels;
}

const c565 = v => [((v >> 11) & 31) * 255 / 31 | 0, ((v >> 5) & 63) * 255 / 63 | 0, (v & 31) * 255 / 31 | 0];
function dxt(data, w, h, alpha) {
  const out = new Uint8Array(w * h * 4), bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2), bs = alpha ? 16 : 8;
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const o = (by * bw + bx) * bs; if (o + bs > data.length) continue;
    const co = o + (alpha ? 8 : 0), v0 = data[co] | data[co + 1] << 8, v1 = data[co + 2] | data[co + 3] << 8, a = c565(v0), b = c565(v1);
    const pal = v0 > v1 || alpha ? [a, b, a.map((x, i) => (2 * x + b[i]) / 3 | 0), a.map((x, i) => (x + 2 * b[i]) / 3 | 0)] : [a, b, a.map((x, i) => (x + b[i]) >> 1), [0, 0, 0]];
    const idx = data.readUInt32LE(co + 4);
    for (let k = 0; k < 16; k++) {
      const x = bx * 4 + (k & 3), y = by * 4 + (k >> 2); if (x >= w || y >= h) continue;
      const s = (idx >> (2 * k)) & 3, c = pal[s], q = (y * w + x) * 4;
      out[q] = c[0]; out[q + 1] = c[1]; out[q + 2] = c[2];
      out[q + 3] = alpha ? ((data[o + (k >> 1)] >> ((k & 1) * 4)) & 15) * 17 : (v0 <= v1 && s === 3 ? 0 : 255);
    }
  }
  return out;
}

export function readMip(b) {
  const levels = mipLevels(b); if (!levels.length) throw new Error("no image data");
  const L = levels.reduce((m, l) => l.width * l.height > m.width * m.height ? l : m), { width: w, height: h, data } = L;
  let rgba;
  if (L.format === 0x0a) rgba = dxt(data, w, h, false);
  else if (L.format === 0x0b) rgba = dxt(data, w, h, true);
  else {
    const bpp = Math.round(data.length / (w * h)); rgba = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      if (bpp === 4) { rgba[i * 4] = data[i * 4 + 2]; rgba[i * 4 + 1] = data[i * 4 + 1]; rgba[i * 4 + 2] = data[i * 4]; rgba[i * 4 + 3] = data[i * 4 + 3]; }
      else if (bpp === 3) { rgba[i * 4] = data[i * 3 + 2]; rgba[i * 4 + 1] = data[i * 3 + 1]; rgba[i * 4 + 2] = data[i * 3]; rgba[i * 4 + 3] = 255; }
      else if (bpp === 2) { const v = data.readUInt16LE(i * 2), c = c565(v); rgba.set([...c, 255], i * 4); }
      else { const v = data[i * bpp]; rgba.set([v, v, v, 255], i * 4); }
    }
  }
  const hasAlpha = rgba.some((v, i) => (i & 3) === 3 && v < 250);
  return { width: w, height: h, rgba, format: L.format, hasAlpha };
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = b => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]), c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); };
export function pngOf({ width: w, height: h, rgba }) {
  const raw = Buffer.alloc((w * 4 + 1) * h); for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const hd = Buffer.alloc(13); hd.writeUInt32BE(w); hd.writeUInt32BE(h, 4); hd[8] = 8; hd[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", hd), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

if (process.argv[1] && basename(process.argv[1]) === "nr2003-mip.mjs") {
  const [i, o] = process.argv.slice(2); if (!o) { console.log("usage: node nr2003-mip.mjs <in.mip> <out.png>"); process.exit(1); }
  const m = readMip(readFileSync(i)); writeFileSync(o, pngOf(m)); console.log(`${m.width}x${m.height} format ${m.format}${m.hasAlpha ? " alpha" : ""} -> ${o}`);
}
