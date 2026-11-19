// png-read.mjs — a small PNG decoder (for the texture override folder, see uis-render.mjs Assets.override):
// non-interlaced, bit depth 8 or 16 (16 keeps the high byte), colour types 0 grey, 2 RGB, 3 palette (+ tRNS),
// 4 grey + alpha, 6 RGBA. Returns { width, height, rgba } (RGBA bytes, rows top to bottom).
import { inflateSync } from "node:zlib";

export function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG file");
  let p = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0, pal = null, trns = null; const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p), tag = buf.toString("latin1", p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (tag === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; interlace = d[12]; }
    else if (tag === "PLTE") pal = d;
    else if (tag === "tRNS") trns = d;
    else if (tag === "IDAT") idat.push(d);
    else if (tag === "IEND") break;
    p += 12 + len;
  }
  if (interlace) throw new Error("interlaced PNG (save it without interlacing)");
  if (depth !== 8 && depth !== 16) throw new Error(`PNG bit depth ${depth} (8 or 16 only)`);
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type]; if (!ch) throw new Error(`PNG colour type ${type}`);
  const bpp = ch * depth / 8, stride = w * bpp, raw = inflateSync(Buffer.concat(idat)), px = Buffer.alloc(stride * h);
  for (let y = 0, s = 0; y < h; y++) {                        // undo the per-row filters
    const f = raw[s++], row = px.subarray(y * stride, (y + 1) * stride), prev = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0, b = prev ? prev[x] : 0, c = prev && x >= bpp ? prev[x - bpp] : 0, r = raw[s++];
      let v;
      if (f === 0) v = r; else if (f === 1) v = r + a; else if (f === 2) v = r + b; else if (f === 3) v = r + ((a + b) >> 1);
      else { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v = r + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      row[x] = v & 255;
    }
  }
  const rgba = new Uint8Array(w * h * 4), step = depth / 8;
  for (let i = 0; i < w * h; i++) {
    const o = i * bpp, s = k => px[o + k * step], d = i * 4;
    if (type === 6) { rgba[d] = s(0); rgba[d + 1] = s(1); rgba[d + 2] = s(2); rgba[d + 3] = s(3); }
    else if (type === 2) { rgba[d] = s(0); rgba[d + 1] = s(1); rgba[d + 2] = s(2); rgba[d + 3] = 255; }
    else if (type === 0) { rgba[d] = rgba[d + 1] = rgba[d + 2] = s(0); rgba[d + 3] = 255; }
    else if (type === 4) { rgba[d] = rgba[d + 1] = rgba[d + 2] = s(0); rgba[d + 3] = s(1); }
    else { const k = px[o]; rgba[d] = pal[k * 3]; rgba[d + 1] = pal[k * 3 + 1]; rgba[d + 2] = pal[k * 3 + 2]; rgba[d + 3] = trns && k < trns.length ? trns[k] : 255; }
  }
  return { width: w, height: h, rgba };
}
