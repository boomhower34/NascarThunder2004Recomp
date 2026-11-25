#!/usr/bin/env node
// mmap-tex.mjs — decoder for the game's "MMAP" texture resources (Xbox D3D texture formats), to RGBA or PNG.
//
// MMAP LAYOUT (little-endian; offsets are from the start of the MMAP resource)
//   0x00 "MMAP"      0x04 u32 version (2)      0x08 bytes 00 01 02 03      0x0C u16 1, u16 1
//   0x10 u32 palette count (0/1)               0x14 u32 resource size - 0x0C
//   0x18 u32 0x28 (image header size)          0x1C u32 palette header offset (absolute)
//   0x20 u32 name offset (absolute; NUL-terminated name, e.g. "LOADING", then u16 1, u16 1)
//   0x24 u32 0
//   0x28 u16 width   0x2A u16 height   0x2C u32 D3D format   0x30 u32 pixel bytes   0x34 u32 pixel offset (relative to 0x80)
//   Palette header (at 0x1C): u32 count?, u32 palette bytes (0x400), u32 palette data offset (relative to 0x80)
//   Palette entries are 32-bit BGRA (D3DCOLOR).
//   Swizzled formats store pixels in Morton (Z) order: bits of x and y interleaved, x first.
//
// Usage
//   node mmap-tex.mjs list    <file>                     (a TERF bundle like LOADDATA.DAT, or a raw .mmap)
//   node mmap-tex.mjs convert <file> <outDir> [--index N]

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { deflateSync } from "node:zlib";
import { parseTerf, isTerf } from "./terf.mjs";

// Xbox D3DFORMAT codes (swizzled unless "LIN_"), with bytes per pixel or block info.
export const Formats = {
  0x00: { name: "L8", bpp: 1, swz: true },
  0x01: { name: "AL8", bpp: 1, swz: true },
  0x02: { name: "A1R5G5B5", bpp: 2, swz: true },
  0x03: { name: "X1R5G5B5", bpp: 2, swz: true },
  0x04: { name: "A4R4G4B4", bpp: 2, swz: true },
  0x05: { name: "R5G6B5", bpp: 2, swz: true },
  0x06: { name: "A8R8G8B8", bpp: 4, swz: true },
  0x07: { name: "X8R8G8B8", bpp: 4, swz: true },
  0x0B: { name: "P8", bpp: 1, swz: true, pal: true },
  0x0C: { name: "DXT1", block: 8 },
  0x0E: { name: "DXT3", block: 16 },
  0x0F: { name: "DXT5", block: 16 },
  0x10: { name: "LIN_A1R5G5B5", bpp: 2 },
  0x11: { name: "LIN_R5G6B5", bpp: 2 },
  0x12: { name: "LIN_A8R8G8B8", bpp: 4 },
  0x13: { name: "LIN_L8", bpp: 1 },
  0x19: { name: "A8", bpp: 1, swz: true },
  0x1A: { name: "A8L8", bpp: 2, swz: true },
  0x1D: { name: "LIN_A4R4G4B4", bpp: 2 },
  0x1E: { name: "LIN_X8R8G8B8", bpp: 4 },
  0x1B: { name: "LIN_AL8", bpp: 1 },
  0x1C: { name: "LIN_X1R5G5B5", bpp: 2 },
  0x1F: { name: "LIN_A8", bpp: 1 },
  0x20: { name: "LIN_A8L8", bpp: 2 },
};

const mortonCache = new Map();
function mortonTables(w, h) {
  const k = w * 65536 + h; let t = mortonCache.get(k); if (t) return t;
  t = mortonTables0(w, h); if (mortonCache.size < 64) mortonCache.set(k, t); return t;
}
// P8 (swizzled, paletted) texture -> its palette indices in row order (the page expands them through the palette:
// a quarter of the RGBA bytes, and no per-pixel decode here)
export function decodeIndices(src, off, w, h) {
  const out = new Uint8Array(w * h), { xs, ys } = mortonTables(w, h);
  for (let y = 0, d = 0; y < h; y++) { const yo = off + ys[y]; for (let x = 0; x < w; x++) out[d++] = src[yo + xs[x]]; }
  return out;
}
function mortonTables0(w, h) {
  const xs = new Uint32Array(w), ys = new Uint32Array(h);
  let bit = 1, xb = 1, yb = 1;
  while (xb < w || yb < h) {
    if (xb < w) { for (let x = 0; x < w; x++) if (x & xb) xs[x] |= bit; bit <<= 1; xb <<= 1; }
    if (yb < h) { for (let y = 0; y < h; y++) if (y & yb) ys[y] |= bit; bit <<= 1; yb <<= 1; }
  }
  return { xs, ys };
}

const c5 = v => (v << 3) | (v >> 2), c6 = v => (v << 2) | (v >> 4), c4 = v => v * 17;

function pixelToRGBA(fmt, src, o, out, d, pal) {
  switch (fmt) {
    case 0x0B: { const i = src[o] * 4; out[d] = pal[i + 2]; out[d + 1] = pal[i + 1]; out[d + 2] = pal[i]; out[d + 3] = pal[i + 3]; return; }
    case 0x06: case 0x12: out[d] = src[o + 2]; out[d + 1] = src[o + 1]; out[d + 2] = src[o]; out[d + 3] = src[o + 3]; return;
    case 0x07: case 0x1E: out[d] = src[o + 2]; out[d + 1] = src[o + 1]; out[d + 2] = src[o]; out[d + 3] = 255; return;
    case 0x05: case 0x11: { const v = src[o] | (src[o + 1] << 8); out[d] = c5(v >> 11); out[d + 1] = c6((v >> 5) & 63); out[d + 2] = c5(v & 31); out[d + 3] = 255; return; }
    case 0x02: case 0x03: case 0x10: case 0x1C: { const v = src[o] | (src[o + 1] << 8); out[d] = c5((v >> 10) & 31); out[d + 1] = c5((v >> 5) & 31); out[d + 2] = c5(v & 31); out[d + 3] = fmt === 0x03 || fmt === 0x1C ? 255 : (v >> 15) * 255; return; }
    case 0x04: case 0x1D: { const v = src[o] | (src[o + 1] << 8); out[d] = c4((v >> 8) & 15); out[d + 1] = c4((v >> 4) & 15); out[d + 2] = c4(v & 15); out[d + 3] = c4(v >> 12); return; }
    case 0x00: case 0x13: out[d] = out[d + 1] = out[d + 2] = src[o]; out[d + 3] = 255; return;
    case 0x01: case 0x1B: out[d] = out[d + 1] = out[d + 2] = out[d + 3] = src[o]; return;
    case 0x19: case 0x1F: out[d] = out[d + 1] = out[d + 2] = 255; out[d + 3] = src[o]; return;
    case 0x1A: case 0x20: out[d] = out[d + 1] = out[d + 2] = src[o]; out[d + 3] = src[o + 1]; return;
  }
}

function decodeDXT(fmt, src, off, w, h) {
  const out = new Uint8Array(w * h * 4), bs = fmt === 0x0C ? 8 : 16;
  let p = off;
  for (let by = 0; by < h; by += 4) for (let bx = 0; bx < w; bx += 4, p += bs) {
    const cb = fmt === 0x0C ? p : p + 8;
    const c0 = src[cb] | (src[cb + 1] << 8), c1 = src[cb + 2] | (src[cb + 3] << 8);
    const pal = [[c5(c0 >> 11), c6((c0 >> 5) & 63), c5(c0 & 31), 255], [c5(c1 >> 11), c6((c1 >> 5) & 63), c5(c1 & 31), 255]];
    if (c0 > c1 || fmt !== 0x0C) {
      pal[2] = pal[0].map((v, i) => i < 3 ? ((2 * v + pal[1][i]) / 3) | 0 : 255);
      pal[3] = pal[0].map((v, i) => i < 3 ? ((v + 2 * pal[1][i]) / 3) | 0 : 255);
    } else { pal[2] = pal[0].map((v, i) => i < 3 ? (v + pal[1][i]) >> 1 : 255); pal[3] = [0, 0, 0, 0]; }
    const bits = src[cb + 4] | (src[cb + 5] << 8) | (src[cb + 6] << 16) | (src[cb + 7] << 24);
    let alpha = null;
    if (fmt === 0x0E) alpha = i => c4((src[p + (i >> 1)] >> ((i & 1) * 4)) & 15);
    if (fmt === 0x0F) {
      const a0 = src[p], a1 = src[p + 1];
      let ab = 0n; for (let i = 5; i >= 0; i--) ab = (ab << 8n) | BigInt(src[p + 2 + i]);
      const ap = [a0, a1];
      if (a0 > a1) for (let i = 1; i < 7; i++) ap.push((((7 - i) * a0 + i * a1) / 7) | 0);
      else { for (let i = 1; i < 5; i++) ap.push((((5 - i) * a0 + i * a1) / 5) | 0); ap.push(0, 255); }
      alpha = i => ap[Number((ab >> BigInt(3 * i)) & 7n)];
    }
    for (let i = 0; i < 16; i++) {
      const x = bx + (i & 3), y = by + (i >> 2); if (x >= w || y >= h) continue;
      const c = pal[(bits >>> (2 * i)) & 3], d = (y * w + x) * 4;
      out[d] = c[0]; out[d + 1] = c[1]; out[d + 2] = c[2]; out[d + 3] = alpha ? alpha(i) : c[3];
    }
  }
  return out;
}

// Decode pixels of one image level in any supported format (swizzled, linear with a pitch, DXT, paletted with a
// BGRA palette) to RGBA. Returns null for formats not handled.
export function decodePixels(format, src, off, width, height, pal = null, pitch = 0) {
  const info = Formats[format]; if (!info) return null;
  if (info.block) return decodeDXT(format, src, off, width, height);
  const rgba = new Uint8Array(width * height * 4), { xs, ys } = info.swz ? mortonTables(width, height) : {};
  const rowBytes = pitch || width * info.bpp;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const o = info.swz ? off + (xs[x] | ys[y]) * info.bpp : off + y * rowBytes + x * info.bpp;
    pixelToRGBA(format, src, o, rgba, (y * width + x) * 4, pal);
  }
  return rgba;
}

// Parse one MMAP resource. Returns { name, width, height, format, formatName, rgba }.
export function decodeMMAP(buf) {
  if (buf.toString("latin1", 0, 4) !== "MMAP") throw new Error("not an MMAP resource");
  const width = buf.readUInt16LE(0x28), height = buf.readUInt16LE(0x2a), format = buf.readUInt32LE(0x2c);
  const pixOff = 0x80 + buf.readUInt32LE(0x34);
  const nameOff = buf.readUInt32LE(0x20);
  let z = nameOff; while (z < buf.length && buf[z] !== 0) z++;
  const name = buf.toString("latin1", nameOff, z);
  const info = Formats[format];
  if (!info) throw new Error(`MMAP "${name}": unsupported D3D format 0x${format.toString(16)}`);
  let rgba;
  if (info.block) rgba = decodeDXT(format, buf, pixOff, width, height);
  else {
    let pal = null;
    if (info.pal) { const ph = buf.readUInt32LE(0x1c); pal = buf.subarray(0x80 + buf.readUInt32LE(ph + 8)); }
    rgba = new Uint8Array(width * height * 4);
    const { xs, ys } = info.swz ? mortonTables(width, height) : {};
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const idx = info.swz ? (xs[x] | ys[y]) : y * width + x;
      pixelToRGBA(format, buf, pixOff + idx * info.bpp, rgba, (y * width + x) * 4, pal);
    }
  }
  return { name, width, height, format, formatName: info.name, rgba };
}

export function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  const crcTable = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = b => { let c = -1; for (const v of b) c = crcTable[(c ^ v) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => {
    const t = Buffer.concat([Buffer.from(type, "latin1"), data]), len = Buffer.alloc(4), c = Buffer.alloc(4);
    len.writeUInt32BE(data.length); c.writeUInt32BE(crc(t)); return Buffer.concat([len, t, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr),
                        chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// Return the MMAP resources in a file: a TERF bundle's MMAP entries, or the file itself.
export function mmapEntries(buf) {
  if (buf.toString("latin1", 0, 4) === "MMAP") return [{ index: 0, buf }];
  if (!isTerf(buf)) throw new Error("neither a TERF bundle nor an MMAP resource");
  const t = parseTerf(buf), out = [];
  for (const e of t.entries) {
    const b = t.entry(e.index);
    if (b.toString("latin1", 0, 4) === "MMAP") out.push({ index: e.index, buf: b });
    else if (isTerf(b)) for (const n of mmapEntries(b)) out.push({ index: `${e.index}.${n.index}`, buf: n.buf });
  }
  return out;
}

function main() {
  const [cmd, file, outDir, ...rest] = process.argv.slice(2);
  if (!cmd || !file) { console.error("usage: node mmap-tex.mjs list|convert <file> [outDir] [--index N]"); process.exit(1); }
  const iArg = rest.indexOf("--index"), only = iArg >= 0 ? Number(rest[iArg + 1]) : (outDir === "--index" ? Number(rest[0]) : null);
  const entries = mmapEntries(readFileSync(file)).filter(e => only === null || e.index === only);
  const stem = basename(file, extname(file)).toLowerCase();
  if (cmd === "convert") mkdirSync(outDir, { recursive: true });
  for (const e of entries) {
    const b = e.buf, w = b.readUInt16LE(0x28), h = b.readUInt16LE(0x2a), f = b.readUInt32LE(0x2c);
    const nameOff = b.readUInt32LE(0x20); let z = nameOff; while (z < b.length && b[z]) z++;
    const name = b.toString("latin1", nameOff, z);
    if (cmd === "list") { console.log(`${String(e.index).padStart(4)}  ${String(w).padStart(4)}x${String(h).padEnd(4)}  ${(Formats[f]?.name || "0x" + f.toString(16)).padEnd(13)} ${name}`); continue; }
    try {
      const t = decodeMMAP(b);
      const safe = name.replace(/[^A-Za-z0-9_.-]+/g, "_") || "unnamed";
      const path = join(outDir, `${stem}_${String(e.index).padStart(3, "0")}_${safe}.png`);
      writeFileSync(path, encodePNG(t.width, t.height, t.rgba));
      console.log(`wrote ${path}`);
    } catch (err) { console.error(`entry ${e.index}: ${err.message}`); }
  }
}

if (process.argv[1] && process.argv[1].endsWith("mmap-tex.mjs")) main();
