// paint-mmap.mjs — custom car paint: a picture (RGBA, any size) turned into a CARDATA.DAT paint texture, and back.
//
// A car's paint in CARDATA.DAT is an MMAP "DECAL" with three P8 (paletted, swizzled) images: 512x512, 256x256 and
// 128x128 (image headers at 0x28 + k*0x10: u16 w, u16 h, u32 format 0x0B, u32 bytes, u32 offset; one mip chain), one
// 256-colour palette (header at [0x1C]: u32 1, u32 0x400, u32 offset from 0x80; entries BGRA). The template layout
// (where the hood, sides, roof and bumpers go) depends on the body (make); the launcher hands out a template car's
// paint as a PNG to paint over.
//
// encodePaint(template, rgba, w, h) -> a new MMAP with the template's header and the picture in all three images
// (one palette from median cut, nearest-colour mapping). decodePaint(mmap) -> { width, height, rgba } (largest image).
// encodePaintHD(template, rgba, w, h, size) -> the same paint at size x size (1024 / 2048: modders' templates are
// often 1252 or 2048 square) in DXT5 (full colour, the alpha kept), mips size, size / 2, size / 4: the template's
// header with the image headers, palette header and name moved (a stock DECAL paint holds a palette; this one keeps
// an unused grey one there).

import { decodeMMAP } from "./mmap-tex.mjs";

function morton(w, h) {
  const xs = new Uint32Array(w), ys = new Uint32Array(h); let bit = 1, xb = 1, yb = 1;
  while (xb < w || yb < h) {
    if (xb < w) { for (let x = 0; x < w; x++) if (x & xb) xs[x] |= bit; bit <<= 1; xb <<= 1; }
    if (yb < h) { for (let y = 0; y < h; y++) if (y & yb) ys[y] |= bit; bit <<= 1; yb <<= 1; }
  }
  return { xs, ys };
}

// resize RGBA: box average when shrinking, bilinear when growing (per axis)
export function resize(src, sw, sh, dw, dh) {
  const out = new Uint8Array(dw * dh * 4);
  const axis = (s, d) => {                       // for each destination index: list of [source index, weight]
    const taps = [];
    for (let i = 0; i < d; i++) {
      const t = [];
      if (s > d) { const a = i * s / d, b = (i + 1) * s / d; for (let k = Math.floor(a); k < Math.ceil(b); k++) { const wgt = Math.min(b, k + 1) - Math.max(a, k); if (wgt > 0) t.push([Math.min(s - 1, k), wgt]); } }
      else { const p = Math.max(0, Math.min(s - 1, (i + 0.5) * s / d - 0.5)), k = Math.floor(p), f = p - k; t.push([k, 1 - f]); if (f > 0 && k + 1 < s) t.push([k + 1, f]); }
      const sum = t.reduce((a, [, w]) => a + w, 0); taps.push(t.map(([k, w]) => [k, w / sum]));
    }
    return taps;
  };
  const tx = axis(sw, dw), ty = axis(sh, dh), row = new Float32Array(sw * 4);
  for (let y = 0; y < dh; y++) {
    row.fill(0);
    for (const [k, w] of ty[y]) for (let x = 0, o = k * sw * 4; x < sw * 4; x++) row[x] += src[o + x] * w;
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (const [k, w] of tx[x]) { const o = k * 4; r += row[o] * w; g += row[o + 1] * w; b += row[o + 2] * w; a += row[o + 3] * w; }
      const d = (y * dw + x) * 4; out[d] = r + 0.5; out[d + 1] = g + 0.5; out[d + 2] = b + 0.5; out[d + 3] = a + 0.5;
    }
  }
  return out;
}

// median cut to n colours over 5-5-5-4 bit buckets (alpha kept: decals have transparent parts)
export function quantize(rgba, n = 256) {
  const buckets = new Map();
  for (let i = 0; i < rgba.length; i += 4) {
    const k = (rgba[i] >> 3) << 13 | (rgba[i + 1] >> 3) << 8 | (rgba[i + 2] >> 3) << 3 | rgba[i + 3] >> 5;
    let b = buckets.get(k); if (!b) buckets.set(k, b = [0, 0, 0, 0, 0]);
    b[0] += rgba[i]; b[1] += rgba[i + 1]; b[2] += rgba[i + 2]; b[3] += rgba[i + 3]; b[4]++;
  }
  const cols = [...buckets.values()].map(b => [b[0] / b[4], b[1] / b[4], b[2] / b[4], b[3] / b[4], b[4]]);
  let boxes = [cols];
  while (boxes.length < n) {
    let best = -1, bestRange = 0, bestCh = 0;
    boxes.forEach((box, i) => { if (box.length < 2) return; for (let c = 0; c < 4; c++) { let lo = 1e9, hi = -1e9; for (const p of box) { if (p[c] < lo) lo = p[c]; if (p[c] > hi) hi = p[c]; } const r = (hi - lo) * Math.sqrt(box.reduce((a, p) => a + p[4], 0)); if (r > bestRange) { bestRange = r; best = i; bestCh = c; } } });
    if (best < 0) break;
    const box = boxes[best].sort((a, b) => a[bestCh] - b[bestCh]), total = box.reduce((a, p) => a + p[4], 0);
    let acc = 0, cut = 1; for (let i = 0; i < box.length - 1; i++) { acc += box[i][4]; if (acc >= total / 2) { cut = i + 1; break; } }
    boxes.splice(best, 1, box.slice(0, cut), box.slice(cut));
  }
  const pal = boxes.map(box => { const w = box.reduce((a, p) => a + p[4], 0); return [0, 1, 2, 3].map(c => Math.round(box.reduce((a, p) => a + p[c] * p[4], 0) / w)); });
  while (pal.length < n) pal.push([0, 0, 0, 0]);
  return pal;
}

function mapper(pal) {
  const cache = new Map();
  return (r, g, b, a) => {
    const k = (r >> 2) << 18 | (g >> 2) << 12 | (b >> 2) << 6 | a >> 2; let v = cache.get(k);
    if (v === undefined) { let bd = Infinity; for (let i = 0; i < pal.length; i++) { const p = pal[i], d = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2 + 2 * (p[3] - a) ** 2; if (d < bd) { bd = d; v = i; } } cache.set(k, v); }
    return v;
  };
}

// the images are one mip chain: the first at 0x80 + its offset (as mmap-tex.mjs reads it), the smaller ones right
// after it (their offset fields hold exactly that: 0x40100, 0x50100; the chain ends at the palette header)
export function paintImages(mmap) {
  const n = mmap.readUInt16LE(0x0e), out = []; let off = 0x80 + mmap.readUInt32LE(0x34);
  for (let k = 0; k < n; k++) { const h = 0x28 + k * 0x10, im = { w: mmap.readUInt16LE(h), h: mmap.readUInt16LE(h + 2), fmt: mmap.readUInt32LE(h + 4), bytes: mmap.readUInt32LE(h + 8), off }; out.push(im); off += im.bytes; }
  return out;
}

export function encodePaint(template, rgba, w, h) {
  if (template.toString("latin1", 0, 4) !== "MMAP") throw new Error("template is not an MMAP texture");
  const imgs = paintImages(template); if (!imgs.length || imgs.some(i => i.fmt !== 0x0b)) throw new Error("template is not a paletted paint texture");
  const out = Buffer.from(template), big = imgs[0];
  const top = Uint8Array.from((w === big.w && h === big.h) ? rgba : resize(rgba, w, h, big.w, big.h));
  // a picture without transparency (flattened in an editor) keeps the template's alpha: the paint's alpha channel is
  // part of the car's look (about a third of a template is alpha 0), not a cut-out
  let opaque = true; for (let i = 3; i < top.length; i += 4) if (top[i] !== 255) { opaque = false; break; }
  if (opaque) { const t = decodePaint(template), a = t.width === big.w && t.height === big.h ? t.rgba : resize(t.rgba, t.width, t.height, big.w, big.h); for (let i = 3; i < top.length; i += 4) top[i] = a[i]; }
  const pal = quantize(top), near = mapper(pal);
  const ph = out.readUInt32LE(0x1c), po = 0x80 + out.readUInt32LE(ph + 8);
  pal.forEach((p, i) => { out[po + i * 4] = p[2]; out[po + i * 4 + 1] = p[1]; out[po + i * 4 + 2] = p[0]; out[po + i * 4 + 3] = p[3]; });
  for (const im of imgs) {
    const px = im === big ? top : resize(top, big.w, big.h, im.w, im.h), { xs, ys } = morton(im.w, im.h);
    for (let y = 0; y < im.h; y++) for (let x = 0; x < im.w; x++) { const s = (y * im.w + x) * 4; out[im.off + ys[y] + xs[x]] = near(px[s], px[s + 1], px[s + 2], px[s + 3]); }
  }
  return out;
}

export function decodePaint(mmap) { const t = decodeMMAP(mmap); return { width: t.width, height: t.height, rgba: t.rgba }; }

// ---------------------------------------------------------------- high resolution (DXT5)
const c565 = (r, g, b) => (r >> 3) << 11 | (g >> 2) << 5 | b >> 3, un565 = v => [((v >> 11) & 31) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31];
function dxt5Block(px, out, o) {                     // px: 16 RGBA pixels (64 bytes) -> 16 bytes
  let a0 = 0, a1 = 255; for (let i = 0; i < 16; i++) { const a = px[i * 4 + 3]; if (a > a0) a0 = a; if (a < a1) a1 = a; }
  out[o] = a0; out[o + 1] = a1; let bits = 0n;
  for (let i = 0; i < 16; i++) { const a = px[i * 4 + 3]; let k;
    if (a0 === a1) k = 0; else { const t = Math.round((a0 - a) / (a0 - a1) * 7); k = t === 0 ? 0 : t === 7 ? 1 : t + 1; }   // 8-step ramp: 0 = a0, 1 = a1, 2..7 between
    bits |= BigInt(k) << BigInt(3 * i); }
  for (let j = 0; j < 6; j++) out[o + 2 + j] = Number((bits >> BigInt(8 * j)) & 255n);
  // colour: the two ends along the main axis (the extremes of the pixels' projection on the widest channel span)
  let mn = [255, 255, 255], mx = [0, 0, 0]; for (let i = 0; i < 16; i++) for (let c = 0; c < 3; c++) { const v = px[i * 4 + c]; if (v < mn[c]) mn[c] = v; if (v > mx[c]) mx[c] = v; }
  const ax = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]]; let lo = Infinity, hi = -Infinity, pl = null, ph = null;
  for (let i = 0; i < 16; i++) { const d = px[i * 4] * ax[0] + px[i * 4 + 1] * ax[1] + px[i * 4 + 2] * ax[2]; if (d < lo) { lo = d; pl = i; } if (d > hi) { hi = d; ph = i; } }
  // inset the ends a little (as the usual range fit) so the in-between colours land closer
  const end = (i, j) => [0, 1, 2].map(c => px[i * 4 + c] + (px[j * 4 + c] - px[i * 4 + c]) / 16);
  let e0 = c565(...end(ph, pl).map(Math.round)), e1 = c565(...end(pl, ph).map(Math.round));
  if (e0 < e1) [e0, e1] = [e1, e0];
  out[o + 8] = e0 & 255; out[o + 9] = e0 >> 8; out[o + 10] = e1 & 255; out[o + 11] = e1 >> 8;
  const p0 = un565(e0), p1 = un565(e1), pal = [p0, p1, p0.map((v, c) => (2 * v + p1[c]) / 3), p0.map((v, c) => (v + 2 * p1[c]) / 3)];
  let idx = 0; for (let i = 0; i < 16; i++) { let bk = 0, bd = Infinity; for (let k = 0; k < 4; k++) { const d = (pal[k][0] - px[i * 4]) ** 2 + (pal[k][1] - px[i * 4 + 1]) ** 2 + (pal[k][2] - px[i * 4 + 2]) ** 2; if (d < bd) { bd = d; bk = k; } } idx |= bk << (2 * i); }
  out.writeUInt32LE(idx >>> 0, o + 12);
}
export function encodeDXT5(rgba, w, h) {
  const out = Buffer.alloc(Math.max(1, w >> 2) * Math.max(1, h >> 2) * 16), px = new Uint8Array(64); let o = 0;
  for (let by = 0; by < h; by += 4) for (let bx = 0; bx < w; bx += 4) {
    for (let i = 0; i < 16; i++) { const x = Math.min(w - 1, bx + (i & 3)), y = Math.min(h - 1, by + (i >> 2)), s = (y * w + x) * 4; px.set(rgba.subarray(s, s + 4), i * 4); }
    dxt5Block(px, out, o); o += 16; }
  return out;
}
export function encodePaintHD(template, rgba, w, h, size = 1024) {
  if (template.toString("latin1", 0, 4) !== "MMAP") throw new Error("template is not an MMAP texture");
  const imgs = paintImages(template); if (!imgs.length || imgs.some(i => i.fmt !== 0x0b)) throw new Error("template is not a paletted paint texture");
  const top = Uint8Array.from(w === size && h === size ? rgba : resize(rgba, w, h, size, size));
  let opaque = true; for (let i = 3; i < top.length; i += 4) if (top[i] !== 255) { opaque = false; break; }
  if (opaque) { const t = decodePaint(template), a = resize(t.rgba, t.width, t.height, size, size); for (let i = 3; i < top.length; i += 4) top[i] = a[i]; }
  const sizes = imgs.map((_, k) => size >> k), data = sizes.map(sz => encodeDXT5(sz === size ? top : resize(top, size, size, sz, sz), sz, sz));
  const ph0 = template.readUInt32LE(0x1c), name0 = template.readUInt32LE(0x20), tail = template.subarray(name0);
  const E = 0x100 + data.reduce((a, d) => a + d.length, 0), PH = E, PD = E + 0x100, NM = PD + 0x400, out = Buffer.alloc(NM + tail.length);
  template.copy(out, 0, 0, 0x80);
  let off = 0x100; sizes.forEach((sz, k) => { const hh = 0x28 + k * 0x10; out.writeUInt16LE(sz, hh); out.writeUInt16LE(sz, hh + 2); out.writeUInt32LE(0x0f, hh + 4); out.writeUInt32LE(data[k].length, hh + 8); out.writeUInt32LE(k ? off : 0x80, hh + 12); data[k].copy(out, off); off += data[k].length; });
  out.writeUInt32LE(out.length - 0x0c, 0x14); out.writeUInt32LE(PH, 0x1c); out.writeUInt32LE(NM, 0x20);
  template.copy(out, PH, ph0, ph0 + 12); out.writeUInt32LE(PD - 0x80, PH + 8);
  for (let i = 0; i < 256; i++) out.writeUInt32LE(0xff808080, PD + i * 4);
  tail.copy(out, NM);
  return out;
}
// the size a picture of w x h gets: its own, to the nearest power of two from 512 to 2048 (1252 -> 1024)
export const paintSize = (w, h) => { const m = Math.max(w, h); return m > 1448 ? 2048 : m > 724 ? 1024 : 512; };
