// crew-tex.mjs — pit crew uniforms (CHARTEX.DAT) for added drivers.
//
// The pit crew wears CHARTEX entry CRSK.PTEX (Rusty Wallace #2: 3, the blue Miller Lite suits; Home Depot #20: 17).
// An entry is one MMAP with 7 paletted (0x0B, swizzled) textures, each with its own palette (header +0x0E texture
// count, +0x10 palette count, +0x1C palette headers 12 bytes each; texture headers at 0x28 + k * 0x10: u16 w, u16 h,
// u32 format, u32 bytes, u32 offset from 0x80 — unlike a DECAL paint's mips, which follow image 0):
//   ARM 64x128, PANTS 64x128, TORSO 128x256, HELMET 128x64, FACE 64x64, SHADES 16x8, VISOR 16x16
// A uniform sheet (what the launcher hands out and takes back) puts the first five side by side, 256 x 256 at 1x:
//   ARM (0,0)  PANTS (64,0)  TORSO (128,0)  HELMET (0,128)  FACE (0,192, not changed)
// and may be any multiple of that (it is scaled down to each part's own size).
//
// usage: import { decodeCrew, crewSheet, encodeCrew, madeCrew } from "./crew-tex.mjs";
//        decodeCrew(mmap) -> { NAME: { w, h, rgba } }; crewSheet(parts) -> { width, height, rgba }
//        encodeCrew(templateMMAP, sheet) -> MMAP; madeCrew(templateMMAP, { primary, secondary }) -> MMAP (plain suits)

import { resize, quantize } from "./paint-mmap.mjs";

const NAMES = ["ARM", "PANTS", "TORSO", "HELMET", "FACE", "SHADES", "VISOR"];
export const SHEET = { ARM: [0, 0], PANTS: [64, 0], TORSO: [128, 0], HELMET: [0, 128], FACE: [0, 192] };   // (1x positions)
const SIZE = { ARM: [64, 128], PANTS: [64, 128], TORSO: [128, 256], HELMET: [128, 64], FACE: [64, 64] };   // (their places on the sheet; a set with other sizes is scaled to them)
const EDIT = ["ARM", "PANTS", "TORSO", "HELMET"];

function morton(w, h) {
  const xs = new Uint32Array(w), ys = new Uint32Array(h); let bit = 1, xb = 1, yb = 1;
  while (xb < w || yb < h) { if (xb < w) { for (let x = 0; x < w; x++) if (x & xb) xs[x] |= bit; bit <<= 1; xb <<= 1; } if (yb < h) { for (let y = 0; y < h; y++) if (y & yb) ys[y] |= bit; bit <<= 1; yb <<= 1; } }
  return { xs, ys };
}
function layout(b) {
  if (b.toString("latin1", 0, 4) !== "MMAP") throw new Error("not an MMAP texture");
  const n = b.readUInt16LE(0x0e), ph = b.readUInt32LE(0x1c), np = b.readUInt32LE(0x10), out = [];
  for (let k = 0; k < n; k++) { const h = 0x28 + k * 0x10;
    out.push({ name: NAMES[k] ?? `T${k}`, w: b.readUInt16LE(h), h: b.readUInt16LE(h + 2), fmt: b.readUInt32LE(h + 4), off: 0x80 + b.readUInt32LE(h + 12), pal: 0x80 + b.readUInt32LE(ph + Math.min(k, np - 1) * 12 + 8) }); }
  if (out.some(t => t.fmt !== 0x0b)) throw new Error("not a paletted crew texture set");
  return out;
}
export function decodeCrew(b) {
  const parts = {};
  for (const t of layout(b)) { const { xs, ys } = morton(t.w, t.h), rgba = new Uint8Array(t.w * t.h * 4);
    for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) { const i = b[t.off + (ys[y] | xs[x])], q = t.pal + i * 4, d = (y * t.w + x) * 4; rgba[d] = b[q + 2]; rgba[d + 1] = b[q + 1]; rgba[d + 2] = b[q]; rgba[d + 3] = b[q + 3]; }
    parts[t.name] = { w: t.w, h: t.h, rgba }; }
  return parts;
}
export function crewSheet(parts, scale = 1) {
  const W = 256 * scale, rgba = new Uint8Array(W * W * 4);
  for (const [k, [x0, y0]] of Object.entries(SHEET)) { const p = parts[k]; if (!p) continue; const [sw, sh] = SIZE[k], w = sw * scale, h = sh * scale, px = p.w === w && p.h === h ? p.rgba : resize(p.rgba, p.w, p.h, w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const s = (y * w + x) * 4, d = ((y0 * scale + y) * W + x0 * scale + x) * 4; rgba.set(px.subarray(s, s + 4), d); rgba[d + 3] = 255; } }
  return { width: W, height: W, rgba };
}
// one texture of the set from new pixels: its own palette (median cut), nearest colour, swizzled
function put(out, t, rgba) {
  const pal = quantize(rgba), cache = new Map();
  pal.forEach((p, i) => { out[t.pal + i * 4] = p[2]; out[t.pal + i * 4 + 1] = p[1]; out[t.pal + i * 4 + 2] = p[0]; out[t.pal + i * 4 + 3] = p[3]; });
  const near = (r, g, b, a) => { const k = (r >> 2) << 18 | (g >> 2) << 12 | (b >> 2) << 6 | a >> 2; let v = cache.get(k); if (v === undefined) { let bd = Infinity; for (let i = 0; i < pal.length; i++) { const p = pal[i], d = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2 + 2 * (p[3] - a) ** 2; if (d < bd) { bd = d; v = i; } } cache.set(k, v); } return v; };
  const { xs, ys } = morton(t.w, t.h);
  for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) { const s = (y * t.w + x) * 4; out[t.off + (ys[y] | xs[x])] = near(rgba[s], rgba[s + 1], rgba[s + 2], rgba[s + 3]); }
}
// the template set with the sheet's ARM / PANTS / TORSO / HELMET (the template's alpha kept)
export function encodeCrew(template, sheet) {
  const L = layout(template), parts = decodeCrew(template), out = Buffer.from(template), sc = sheet.width / 256;
  for (const t of L) { if (!EDIT.includes(t.name)) continue; const [x0, y0] = SHEET[t.name], w = Math.round(SIZE[t.name][0] * sc), h = Math.round(SIZE[t.name][1] * sc), cut = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const s = ((Math.round(y0 * sc) + y) * sheet.width + Math.round(x0 * sc) + x) * 4; cut.set(sheet.rgba.subarray(s, s + 4), (y * w + x) * 4); }
    const px = w === t.w && h === t.h ? cut : resize(cut, w, h, t.w, t.h), a = parts[t.name].rgba; for (let i = 3; i < px.length; i += 4) px[i] = a[i];
    put(out, t, px); }
  return out;
}
// plain suits in the team's colours: the template's folds and shading (its brightness blurred over ~10 px, so logos
// and names fade out) on the primary colour, the helmet in the secondary; dark parts (gloves, shoes, visor) kept
const hex = h => /^#[0-9a-f]{6}$/i.test(h ?? "") ? [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)) : null;
function blur(L, w, h, r) {
  const t = new Float32Array(w * h), o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let a = 0, c = 0; for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < w) { a += L[y * w + xx]; c++; } } t[y * w + x] = a / c; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let a = 0, c = 0; for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < h) { a += t[yy * w + x]; c++; } } o[y * w + x] = a / c; }
  return o;
}
export function madeCrew(template, colors, base = template) {   // base: a light suit to take the shading from (CHARTEX 0)
  const pri = hex(colors?.primary) ?? [200, 0, 0], sec = hex(colors?.secondary) ?? [255, 255, 255], parts = decodeCrew(base), made = {};
  for (const k of EDIT) { const p = parts[k], n = p.w * p.h, L = new Float32Array(n), rgba = Uint8Array.from(p.rgba);
    for (let i = 0; i < n; i++) L[i] = 0.3 * p.rgba[i * 4] + 0.59 * p.rgba[i * 4 + 1] + 0.11 * p.rgba[i * 4 + 2];
    const B = blur(L, p.w, p.h, Math.max(4, Math.round(p.w / 8))); let mean = 0, c = 0; for (let i = 0; i < n; i++) if (L[i] > 45) { mean += B[i]; c++; } mean = c ? mean / c : 128;
    const col = k === "HELMET" ? sec : pri;
    for (let i = 0; i < n; i++) { if (L[i] <= 45 && B[i] <= 70) continue;                  // gloves, shoes: as they are
      const s = Math.max(0.55, Math.min(1.25, 0.8 + 0.45 * (B[i] / mean - 1)));
      for (let ch = 0; ch < 3; ch++) rgba[i * 4 + ch] = Math.max(0, Math.min(255, Math.round(col[ch] * s))); }
    made[k] = { w: p.w, h: p.h, rgba }; }
  return encodeCrew(template, crewSheet({ ...decodeCrew(template), ...made }));
}
