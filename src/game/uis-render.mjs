#!/usr/bin/env node
// uis-render.mjs — draw a UIStudio screen (as authored, before scripts run) to a PNG, in pure Node.
//
// What it reproduces (all from the executable):
//   * UI space is 854x480 (camera at 0x75520: centred on (427,240), 45 degree vertical FOV, so z=0 maps 1:1;
//     a 4:3 display shows x 107..747). Points with z != 0 are projected with d = 240 / tan(22.5 deg).
//   * State transform (0x140350, data at stateHeader+8): pos, pivot, rot (deg, X then Y then Z), scale,
//     colour multiplier (+0x34) and colour add (+0x44); M = parent * T(pos) * T(pivot) * R * S * T(-pivot).
//     A state is drawn when its header +4 (active) is set, or always with --all.
//   * Child group: { u32 *visible, count, items }; items are objects or nested states (type -1).
//   * Element (type 0, handler 0x13FC20, draw 0x143DC0): u8 flags (bit1 textured, bit2 cull back faces),
//     s16 texEntry +4, s16 texGroup +6, 4 x RGBA colour +0x14, 4 x (s16 u,v)/256 +0x24, 4 x (s16 x,y,z)/16 +0x34.
//   * Text (type 6, handler 0x141130, draw 0x140BD0): u16 flags (bits 0/1 centre/right, 0x10/0x40 shadow,
//     0x100 boxed, 0x200 clip, 0x1000 word wrap), font = texture group +3 / entry +2, s16 x,y,z +6,
//     shadow dx,dy +0xC,+0xD, s16 box w,h +0x14,+0x16, colour +0x18, shadow colour +0x1C, string record +0x20.
//   * Fonts (FNTS, uis_font.dat): glyph table {u16 char, u8 w, u8 h, u16 x, u16 y, s8 advance, s8 xoff, s8 yoff, u8},
//     kerning {u16 a, u16 b, s8}, 4-bit alpha sheet; missing glyphs fall back to 0xB5 (0x130110).
//   * Texture groups (tables 0x226A48 / 0x226AF0): group id -> uis_*.dat, entry = TERF entry (MMAP).
//
// usage: node uis-render.mjs <Data dir> <uis_all.dat|screen file> <group> <screen> <out.png> [--all] [--width 640]

import * as fs from "node:fs";
const { readFileSync, existsSync, readdirSync } = fs;
import { join } from "node:path";
import { parseTerf, isTerf, readTerfEntry } from "./terf.mjs";
import { MadDecoder, yuvToRgba, eaChunks } from "./ea-mad.mjs";
import { decodeMMAP, encodePNG } from "./mmap-tex.mjs";
import { decodePNG } from "./png-read.mjs";
import { screensIn, parseScreen } from "./uis-screen.mjs";

export const W = 854, H = 480, CAM_D = 240 / Math.tan(22.5 * Math.PI / 180);

export const TextureGroups = {
  0: "uis_font", 1: "uis_comn", 2: "uis_fe", 3: "uis_ig", 5: "uis_drpo", 6: "uis_drnm", 7: "uis_modl", 8: "uis_trpc",
  9: "uis_trlg", 10: "uis_smnm", 11: "uis_spon", 12: "uis_crew", 13: "uis_smap", 14: "uis_vide", 15: "uis_pltl",
  16: "uis_plts", 17: "uis_fmvs", 18: "uis_text", 19: "uis_gene", 20: "uis_shop", 21: "uis_icon", 22: "uis_trop",
  23: "uis_back", 24: "uis_awar", 25: "uis_cont", 26: "uis_anma", 27: "uis_race", 28: "uis_spdl", 29: "uis_cars",
  30: "uis_over", 31: "uis_logo", 32: "uis_cvd1", 33: "uis_cvd2", 34: "uis_cvd3", 35: "uis_cvd4",
};

// ---------------------------------------------------------------- assets
export class Assets {
  constructor(dataDir) { this.dir = dataDir; this.bundles = new Map(); this.tex = new Map(); this.fonts = new Map(); this.missing = new Set(); this.groupOverride = null; }
  // the bundle a texture group id stands for: the game registers its tables per module (frontend 0x226AF0, in-game
  // 0x226E20: there group 5 is uis_drps, the small driver portraits of the HUD's ally / rival panels, not uis_drpo);
  // gamecode keeps the live mapping in groupOverride
  groupName(group) { return this.groupOverride?.get(group) ?? TextureGroups[group]; }
  bundle(group) {
    const name = this.groupName(group);
    if (this.bundles.has(name)) return this.bundles.get(name);
    let t = null;
    const path = name && [name.toUpperCase() + ".DAT", name + ".dat"].map(n => join(this.dir, n)).find(existsSync);
    if (path) { const b = readFileSync(path); if (isTerf(b)) t = parseTerf(b); }
    if (!t) this.missing.add(name ?? `group ${group}`);
    this.bundles.set(name, t); return t;
  }
  texture(group, entry) {
    if (this.dynamic) { const t = this.dynamic(group, entry); if (t !== undefined) return t; }
    const k = `${this.groupName(group)}/${entry}`;
    if (this.tex.has(k)) return this.tex.get(k);
    if (VideoGroups.has(group)) { const t = this.video(group, entry); this.tex.set(k, t); return t; }
    let tex = this.override(this.groupName(group), entry); const t = tex ? null : this.bundle(group);
    try { if (t && entry < t.count) { const b = t.entry(entry); if (b.toString("latin1", 0, 4) === "MMAP") tex = decodeMMAP(b); } }
    catch (e) { this.missing.add(`${k}: ${e.message}`); }
    this.tex.set(k, tex); return tex;
  }
  // Texture overrides: PNGs in the textures folder (beside Data, or NT04_TEXTURES) replace entries of the UI bundles,
  // at any size: elements address textures in 0..1 coordinates, so a 2x image covers the same area, sharper.
  // Names (bundle in lower case, entry number as read_textures.py lists it):
  //   textures/uis_drpo/005.png   textures/uis_drpo/uis_drpo_005<anything>.png   textures/uis_drpo_005<anything>.png
  // The folder is read once, when the first texture is looked up (restart the server to pick up new files).
  override(bundle, entry) {
    if (!bundle) return null;
    if (this.overrides === undefined) {
      this.overrides = new Map();
      // roots: the texture folder, then roster/textures (portraits of drivers added in the launcher's Roster tab)
      const roots = [process.env.NT04_TEXTURES || join(this.dir, "..", "textures"), process.env.NT04_ROSTER_TEXTURES || join(process.env.NT04_USER || join(this.dir, ".."), "roster", "textures")];
      const add = (b, n, path) => { const key = `${b.toLowerCase()}/${+n}`; if (!this.overrides.has(key)) this.overrides.set(key, path); };
      for (const root of roots) {
        const before = this.overrides.size;
        try {
          for (const d of readdirSync(root, { withFileTypes: true })) {
            if (d.isDirectory()) {
              for (const f of readdirSync(join(root, d.name))) {
                const m = /^(?:[a-z0-9_]+?_)?(\d+)[^\\/]*\.png$/i.exec(f);
                if (m && (/^\d/.test(f) || f.toLowerCase().startsWith(d.name.toLowerCase() + "_"))) add(d.name, m[1], join(root, d.name, f));
              }
            } else { const m = /^(uis_[a-z0-9]+)_(\d+)[^\\/]*\.png$/i.exec(d.name); if (m) add(m[1], m[2], join(root, d.name)); }
          }
        } catch {}
        if (this.overrides.size > before) console.log(`texture overrides: ${this.overrides.size - before} from ${root}`);
      }
    }
    const path = this.overrides.get(`${bundle.toLowerCase()}/${entry}`); if (!path) return null;
    try { const p = decodePNG(readFileSync(path)); return { name: path, width: p.width, height: p.height, rgba: p.rgba, override: true }; }
    catch (e) { this.missing.add(`${path}: ${e.message}`); return null; }
  }
  // A video texture (texture groups registered with kind 5 in 0x226A48..: uis_vide, uis_cvd1-4): an EA Madcow clip,
  // entry `entry` of the bundle, shown in the top-left 320 x 240 of a 512 x 256 texture (the elements' uvs: 0.625 x
  // 0.9375). The page plays the clip itself (ui-remote sends { video: { file, index } }); rgba (the first frame) is
  // only decoded when a software canvas draws it.
  video(group, entry) {
    const name = TextureGroups[group].toUpperCase() + ".DAT", path = [name, name.toLowerCase()].map(n => join(this.dir, n)).find(existsSync);
    if (!path) { this.missing.add(name); return null; }
    const t = { width: 512, height: 256, video: { file: name, index: entry } };
    let px = null;
    Object.defineProperty(t, "rgba", { get: () => px ??= firstVideoFrame(path, entry) });
    return t;
  }
  // one playback of a clip (UIVM.video: started by the element's method 8): its own texture, so the page starts it afresh
  videoPlay(group, entry, seq) {
    const k = `play ${seq}`; let t = this.tex.get(k);
    if (t === undefined) { const base = this.video(group, entry); t = base && { width: base.width, height: base.height, video: { ...base.video, seq } };
      if (t) Object.defineProperty(t, "rgba", { get: () => base.rgba }); this.tex.set(k, t); }
    return t;
  }
  // a clip's length in ms (frame durations from the MAD frame headers), for the game's "video ended" flag
  videoDuration(group, entry) {
    const k = `dur ${group}/${entry}`; if (this.tex.has(k)) return this.tex.get(k);
    let ms = 0; const name = TextureGroups[group]?.toUpperCase() + ".DAT", path = [name, name.toLowerCase()].map(n => join(this.dir, n)).find(existsSync);
    try { const b = path && readTerfEntry(fs, path, entry); if (b) for (const c of eaChunks(b)) if (c.tag.startsWith("MAD")) ms += b.readUInt16LE(c.off + 14) || 33; } catch {}
    this.tex.set(k, ms); return ms;
  }
  font(group, entry) {
    const k = `${group}/${entry}`;
    if (this.fonts.has(k)) return this.fonts.get(k);
    let f = null; const t = this.bundle(group);
    if (t && entry < t.count) { const b = t.entry(entry); if (b.toString("latin1", 0, 4) === "FNTS") f = parseFont(b); }
    // an override of the font's glyph sheet (textures/uis_font/<NNN>.png, any size: its alpha is the glyph
    // coverage): glyph positions stay in the original sheet's pixels, so texture coordinates are taken against the
    // original size (uw, uh) while the bigger image is sampled
    const o = f && this.override(this.groupName(group), entry);
    if (o) f.tex = { width: o.width, height: o.height, rgba: o.rgba, uw: f.tex.width, uh: f.tex.height, override: true };
    this.fonts.set(k, f); return f;
  }
}

export const VideoGroups = new Set([14, 32, 33, 34, 35]);
function firstVideoFrame(path, entry) {
  const out = new Uint8Array(512 * 256 * 4); for (let i = 3; i < out.length; i += 4) out[i] = 255;
  try {
    const b = readTerfEntry(fs, path, entry), c = b && eaChunks(b).find(x => x.tag === "MADk");
    if (c) { const f = new MadDecoder().decode(b, c.off, c.len), rgba = yuvToRgba(f);
      for (let y = 0; y < Math.min(f.h, 256); y++) out.set(rgba.subarray(y * f.w * 4, y * f.w * 4 + Math.min(f.w, 512) * 4), y * 512 * 4); }
  } catch {}
  return out;
}

export function parseFont(b) {
  const count = b.readUInt16LE(0x0a), lineHeight = b[0x13], gOff = b.readUInt32LE(0x14), kOff = b.readUInt32LE(0x18), tOff = b.readUInt32LE(0x1c);
  const glyphs = new Map();
  for (let i = 0; i < count; i++) {
    const o = gOff + i * 12;
    glyphs.set(b.readUInt16LE(o), { w: b[o + 2], h: b[o + 3], x: b.readUInt16LE(o + 4), y: b.readUInt16LE(o + 6),
                                    adv: b.readInt8(o + 8), xoff: b.readInt8(o + 9), yoff: b.readInt8(o + 10) });
  }
  const kern = new Map();
  if (kOff && kOff + 4 <= b.length) for (let i = 0, n = b.readUInt32LE(kOff); i < n; i++) { const o = kOff + 4 + i * 8; kern.set(b.readUInt16LE(o) << 16 | b.readUInt16LE(o + 2), b.readInt8(o + 4)); }
  const width = b.readUInt16LE(tOff + 4), height = b.readUInt16LE(tOff + 6), px = b.subarray(tOff + 16);
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = ((px[i >> 1] >> ((i & 1) * 4)) & 15) * 17; }
  return { lineHeight, glyphs, kern, tex: { width, height, rgba } };
}
const glyphOf = (f, c) => f.glyphs.get(c) ?? (c === 13 ? null : f.glyphs.get(0xb5)) ?? null;

// ---------------------------------------------------------------- 3D state transforms (3x4, column vectors: p' = M p)
// The game's matrix stack (0x11F8B0 push, 0x11FE10 translate, 0x11FBD0 / 0x11FC90 / 0x11FD50 rotate x / y / z,
// 0x11FEF0 scale) is D3DX-style row-vector matrices with each op applied on the local side, which is
// M = parent * T * R... in column form. Angles: degrees * 46603.38 = 2^24 per turn.
const I3 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const mul = (m, n) => { const o = new Array(12);
  for (let r = 0; r < 3; r++) { const a = m[r * 4], b = m[r * 4 + 1], c = m[r * 4 + 2];
    for (let k = 0; k < 4; k++) o[r * 4 + k] = a * n[k] + b * n[4 + k] + c * n[8 + k] + (k === 3 ? m[r * 4 + 3] : 0); }
  return o; };
const T = (x, y, z = 0) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];
const S = (x, y, z = 1) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0];
const sc = deg => { const r = deg * Math.PI / 180; return [Math.sin(r), Math.cos(r)]; };
const RX = deg => { const [s, c] = sc(deg); return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0]; };
const RY = deg => { const [s, c] = sc(deg); return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0]; };
const RZ = deg => { const [s, c] = sc(deg); return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0]; };
// local point -> UI space (x, y, z), then the UI camera (z = 0 maps 1:1, +z away from the viewer)
const xform = (m, x, y, z = 0) => [m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]];
const project = (X, Y, Z) => { if (Z) { const k = CAM_D / Math.max(CAM_D + Z, 1e-3); X = W / 2 + (X - W / 2) * k; Y = H / 2 + (Y - H / 2) * k; } return [X, Y]; };
const apply = (m, x, y, z = 0) => project(...xform(m, x, y, z));

// ---------------------------------------------------------------- rasteriser
export class Canvas {
  // transparent: start clear and keep coverage in alpha (premultiplied colour), for an overlay over the 3D picture
  constructor(w = W, h = H, { transparent = false } = {}) { this.w = w; this.h = h; this.transparent = transparent; this.px = new Float32Array(w * h * 4); if (!transparent) for (let i = 3; i < this.px.length; i += 4) this.px[i] = 1; }
  // v = [{x,y,u,v,r,g,b,a}] x3 (colours 0..1), tex = {width,height,rgba} or null
  tri(v, tex, additive) {
    const [p0, p1, p2] = v;
    const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x, p2.x))), maxX = Math.min(this.w - 1, Math.ceil(Math.max(p0.x, p1.x, p2.x)));
    const minY = Math.max(0, Math.floor(Math.min(p0.y, p1.y, p2.y))), maxY = Math.min(this.h - 1, Math.ceil(Math.max(p0.y, p1.y, p2.y)));
    const area = (p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y);
    if (!area || minX > maxX || minY > maxY) return;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5, py = y + 0.5;
      let w0 = ((p1.x - px) * (p2.y - py) - (p2.x - px) * (p1.y - py)) / area;
      let w1 = ((p2.x - px) * (p0.y - py) - (p0.x - px) * (p2.y - py)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
      let r = w0 * p0.r + w1 * p1.r + w2 * p2.r, g = w0 * p0.g + w1 * p1.g + w2 * p2.g, b = w0 * p0.b + w1 * p1.b + w2 * p2.b, a = w0 * p0.a + w1 * p1.a + w2 * p2.a;
      if (tex) {
        const u = w0 * p0.u + w1 * p1.u + w2 * p2.u, vv = w0 * p0.v + w1 * p1.v + w2 * p2.v;
        const tx = Math.min(tex.width - 1, Math.max(0, Math.floor(u * tex.width))), ty = Math.min(tex.height - 1, Math.max(0, Math.floor(vv * tex.height)));
        const o = (ty * tex.width + tx) * 4;
        r *= tex.rgba[o] / 255; g *= tex.rgba[o + 1] / 255; b *= tex.rgba[o + 2] / 255; a *= tex.rgba[o + 3] / 255;
      }
      if (a <= 0) continue;
      const o = (y * this.w + x) * 4, P = this.px;
      if (additive) { P[o] = Math.min(1, P[o] + r * a); P[o + 1] = Math.min(1, P[o + 1] + g * a); P[o + 2] = Math.min(1, P[o + 2] + b * a); if (this.transparent) P[o + 3] = Math.max(P[o + 3], Math.min(1, a)); }
      else if (this.transparent) { const k = 1 - a; P[o] = P[o] * k + r * a; P[o + 1] = P[o + 1] * k + g * a; P[o + 2] = P[o + 2] * k + b * a; P[o + 3] = P[o + 3] * k + a; }
      else { P[o] += (r - P[o]) * a; P[o + 1] += (g - P[o + 1]) * a; P[o + 2] += (b - P[o + 2]) * a; }
    }
  }
  quad(v, tex, additive) { this.tri([v[0], v[1], v[2]], tex, additive); this.tri([v[0], v[2], v[3]], tex, additive); }
  // 8-bit RGBA of the full frame (for live display)
  rgba() {
    const out = new Uint8ClampedArray(this.w * this.h * 4), px = this.px;
    for (let i = 0; i < out.length; i += 4) { out[i] = px[i] * 255; out[i + 1] = px[i + 1] * 255; out[i + 2] = px[i + 2] * 255; out[i + 3] = this.transparent ? px[i + 3] * 255 : 255; }
    return out;
  }
  png(outW = this.w) {
    const scale = this.w / outW, outH = Math.round(this.h / scale), rgba = new Uint8Array(outW * outH * 4);
    for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) {
      const sx = Math.min(this.w - 1, Math.floor(x * scale)), sy = Math.min(this.h - 1, Math.floor(y * scale)), i = (sy * this.w + sx) * 4, o = (y * outW + x) * 4;
      for (let k = 0; k < 3; k++) rgba[o + k] = Math.round(Math.min(1, Math.max(0, this.px[i + k])) * 255);
      rgba[o + 3] = 255;
    }
    return encodePNG(outW, outH, rgba);
  }
}

// Pixel coverage as on the console: the UI is drawn 1 unit = 1 pixel (the 4:3 picture is x 107..747 of the 854), and
// D3D covers the pixels whose centres (integer coordinates) fall in [left, right) — so a screen-aligned element edge
// at x lands on the pixel boundary ceil(x) in the page's convention. Pieces authored a fraction apart close up that
// way: the race HUD's lap counter (10/0) ends one plate piece at 246.25 and starts the next at 246.75, which on the
// console share pixel 247; drawn at the fractional edges (and larger than 640 wide) the half-unit gap showed as a
// vertical line through the plate. Axis-aligned quads get their edges moved to the pixel boundaries, texture
// coordinates and colours carried along (extrapolated over the corners); rotated or 3D quads are left as they are.
const snapRect = Q => {
  const xs = [...new Set(Q.map(q => q.x))], ys = [...new Set(Q.map(q => q.y))];
  if (xs.length !== 2 || ys.length !== 2) return Q;
  const a = Math.min(...xs), b = Math.max(...xs), c = Math.min(...ys), d = Math.max(...ys);
  const corner = (x, y) => Q.find(q => q.x === x && q.y === y); const C00 = corner(a, c), C10 = corner(b, c), C11 = corner(b, d), C01 = corner(a, d);
  if (!C00 || !C10 || !C11 || !C01) return Q;
  const e = 1e-4, A = Math.ceil(a - e), B = Math.ceil(b - e), Cc = Math.ceil(c - e), D = Math.ceil(d - e);
  if (A === a && B === b && Cc === c && D === d) return Q;
  const at = (X, Y) => { const s = (X - a) / (b - a), t = (Y - c) / (d - c), o = { x: X, y: Y };
    for (const k of ["u", "v", "r", "g", "b", "a"]) o[k] = (C00[k] * (1 - s) + C10[k] * s) * (1 - t) + (C01[k] * (1 - s) + C11[k] * s) * t;
    for (const k of ["r", "g", "b", "a"]) o[k] = Math.min(1, Math.max(0, o[k])); return o; };
  return Q.map(q => at(q.x === a ? A : B, q.y === c ? Cc : D));
};

// ---------------------------------------------------------------- screen walk
export function renderScreen(buf, assets, canvas, opts = {}) {
  // opts.layout: parsed (unrelocated) screen when buf is live VM memory; opts.mem: VM memory for pointer fields
  const p = opts.layout ?? parseScreen(buf), stats = { elements: 0, texts: 0, states: 0, skipped: 0 };
  const f32 = o => buf.readFloatLE(o), rgba = o => [buf[o] / 255, buf[o + 1] / 255, buf[o + 2] / 255, buf[o + 3] / 255];
  const cstr = o => { let e = o; while (e < buf.length && buf[e]) e++; return buf.toString("latin1", o, e); };

  // Type 8 (handler 0x142200, draw -2 → 0x142100 → 0x144690): a filled ellipse or pie drawn in immediate mode
  // (Begin(TRIANGLEFAN) / SetVertexData4ub(diffuse) / SetVertexData4f(position) / End, cull off), vertices from
  // 0x1415F0: centre (+0x3C, +0x40) in the centre colour (+0x14: r, g, b, a), then segments + 1 rim points at
  // (cos a * rx (+0x2C), sin a * ry (+0x30)) for a from start (+0x34) to end (+0x38) degrees (flag 0x10: 0..360;
  // end < start: start - 360), segment count u16 +0x10; flag 0x20 shades the rim towards +0x18. The textured /
  // scaled variants (flags 1 / 4, 0x141A00) are not used by any screen. Methods 0..13 set these fields (uis-vm
  // keeps the object's data in its screen memory). Only one exists: the race HUD's translucent blue disc over the
  // speedometer's MPH face (10/0 state 16).
  const drawFan = (d, m, col) => {
    const flags = buf.readUInt16LE(d); if (flags & 5) { stats.skipped++; return; }
    const n = buf.readUInt16LE(d + 0x10); if (!n) return;
    const cx = f32(d + 0x3c), cy = f32(d + 0x40), rx = f32(d + 0x2c), ry = f32(d + 0x30);
    let a0 = flags & 0x10 ? 0 : f32(d + 0x34); const a1 = flags & 0x10 ? 360 : f32(d + 0x38); if (a1 < a0) a0 -= 360;
    const c0 = rgba(d + 0x14), c1 = flags & 0x20 ? rgba(d + 0x18) : c0;
    const V = (x, y, c) => { const [X, Y] = project(...xform(m, x, y, 0)); return { x: X, y: Y, u: 0, v: 0, r: c[0] * col[0], g: c[1] * col[1], b: c[2] * col[2], a: c[3] * col[3] }; };
    const centre = V(cx, cy, c0);
    const rim = i => { const a = (a0 + (a1 - a0) * i / n) * Math.PI / 180; return V(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry, c1); };
    let prev = rim(0);
    for (let i = 1; i <= n; i++) { const p = rim(i); canvas.tri([centre, prev, p], null, false); prev = p; }
    stats.elements++;
  };
  const drawElement = (d, m, col) => {
    const flags = buf[d], textured = flags & 2;
    let tex = null;
    if (textured) {
      const group = buf.readInt16LE(d + 6), entry = buf.readInt16LE(d + 4);
      // a video element (flag 0x20, video texture group): live screens (opts.video given) show the clip only while the
      // game plays it on this element (UIVM.video); the static renderer shows its first frame
      if ((flags & 0x20) && VideoGroups.has(group) && opts.video !== undefined) {
        const v = opts.video; if (!v || v.o !== (((opts.base ?? 0) + d) >>> 0)) { stats.skipped++; return; }
        tex = assets.videoPlay(v.group, v.entry, v.seq);
      } else tex = group >= 0 && entry >= 0 ? assets.texture(group, entry) : null;
      if (!tex) { stats.skipped++; return; }
    }
    // a textured element without flag bit 0 is drawn white (RGB ff, alpha kept): the game sets that when it loads the
    // element (0x142C80; uis-vm elementHandler -1, which also sets the bit, so colours a script sets later stand). This
    // covers screens drawn without the VM's load. (It is what made the magenta / ff3333 end caps grey on the console.)
    const white = textured && !(flags & 1);
    const L = [0, 1, 2, 3].map(i => {
      const c = rgba(d + 0x14 + i * 4);
      if (white) c[0] = c[1] = c[2] = 1;
      // video elements (flag 0x20, only the two video panels have it): the clip keeps its own colours; the main
      // menu's panel is authored red (ff0000ff) with the script fading its alpha, which tinted the footage red
      if (flags & 0x20) c[0] = c[1] = c[2] = 1;
      return { p: xform(m, buf.readInt16LE(d + 0x34 + i * 6) / 16, buf.readInt16LE(d + 0x36 + i * 6) / 16, buf.readInt16LE(d + 0x38 + i * 6) / 16),
               u: buf.readInt16LE(d + 0x24 + i * 4) / 256, v: buf.readInt16LE(d + 0x26 + i * 4) / 256,
               r: c[0] * col[0], g: c[1] * col[1], b: c[2] * col[2], a: c[3] * col[3] };
    });
    const vert = q => { const [x, y] = project(...q.p); return { x, y, u: q.u, v: q.v, r: q.r, g: q.g, b: q.b, a: q.a }; };
    // flag bit 2 (0x4): back faces culled — the element draw 0x143DC0 sets cull mode D3DCULL_CW for it (else none).
    // Only the race HUD's EA coin uses it (3/17, 3/18, 10/0, 11/0, 12/0: comn 0 on both faces, the back face with the
    // flag discs in a state turned 180 degrees about y): the coin flips round to show the flag; facing away, the
    // back's logo is not drawn. (This bit was taken for "additive" before: the front logo was added over the discs
    // behind it, so their colours showed through it all race.)
    if (flags & 4) { const P = L.map(q => project(...q.p)); let a2 = 0; for (let i = 0; i < 4; i++) { const [x0, y0] = P[i], [x1, y1] = P[(i + 1) & 3]; a2 += x0 * y1 - x1 * y0; }
      if (a2 < 0) { stats.skipped++; return; } }
    const zs = L.map(q => q.p[2]);
    if (Math.max(...zs) - Math.min(...zs) < 0.5) canvas.quad(snapRect(L.map(vert)), tex, false);
    else {
      // tilted in depth (a 3D-rotated state: floors, shadows): split into a grid so texture and colour follow the perspective
      const N = 8, lerp = (a, b, t) => a + (b - a) * t;
      const at = (s, t) => { const o = {}; o.p = [0, 1, 2].map(k => lerp(lerp(L[0].p[k], L[1].p[k], s), lerp(L[3].p[k], L[2].p[k], s), t));
        for (const k of ["u", "v", "r", "g", "b", "a"]) o[k] = lerp(lerp(L[0][k], L[1][k], s), lerp(L[3][k], L[2][k], s), t); return vert(o); };
      const G = []; for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) G.push(at(i / N, j / N));
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const k = j * (N + 1) + i; canvas.quad([G[k], G[k + 1], G[k + N + 2], G[k + N + 1]], tex, false); }
    }
    stats.elements++;
  };

  const drawText = (d, m, col) => {
    const flags = buf.readUInt16LE(d), font = assets.font(buf.readInt8(d + 3), buf.readInt8(d + 2));
    if (!font) { stats.skipped++; return; }
    let text;
    if (opts.mem) { const rec = buf.readUInt32LE(d + 0x20); text = rec ? opts.mem.cstr(opts.mem.r32(rec + 8)) : ""; }
    else { const rec = d + buf.readUInt32LE(d + 0x20); text = cstr(buf.readUInt32LE(rec + 8)); }
    if (!text) return;
    let x = buf.readInt16LE(d + 6); const y0 = buf.readInt16LE(d + 8), boxW = buf.readInt16LE(d + 0x14), boxH = buf.readInt16LE(d + 0x16);
    const align = flags & 3, boxed = flags & 0x100;
    if (boxed) x += align === 1 ? boxW >> 1 : align === 2 ? boxW : 0;
    const advance = (s) => { let w = 0, prev = -1; for (const ch of s) { const c = ch.charCodeAt(0), g = glyphOf(font, c); if (!g) continue;
      if (prev >= 0 && !(flags & 4)) w += font.kern.get(prev << 16 | c) ?? 0; w += g.adv; prev = c; } return w; };
    let lines = text.split("\n");
    if (boxed && (flags & 0x3000) && boxW > 0) lines = lines.flatMap(l => {
      const out = []; let cur = "";
      for (const word of l.split(/(?<= )/)) { if (cur && advance(cur + word) > boxW) { out.push(cur.trimEnd()); cur = word; } else cur += word; }
      return [...out, cur];
    });
    const color = rgba(d + 0x18), shadow = rgba(d + 0x1c), sdx = buf.readInt8(d + 0xc), sdy = buf.readInt8(d + 0xd);
    const pass = (c, dx, dy) => lines.forEach((line, li) => {
      const ly = y0 + li * font.lineHeight;
      if ((flags & 0x200) && boxed && ly + font.lineHeight > y0 + boxH) return;
      let pen = x - (align === 1 ? advance(line) / 2 : align === 2 ? advance(line) : 0), prev = -1;
      for (const ch of line) {
        const code = ch.charCodeAt(0), g = glyphOf(font, code); if (!g) continue;
        if (prev >= 0 && !(flags & 4)) pen += font.kern.get(prev << 16 | code) ?? 0;
        const gx = pen + g.xoff + dx, gy = ly + g.yoff + dy, tw = font.tex.uw ?? font.tex.width, th = font.tex.uh ?? font.tex.height;
        const corner = (cx, cy, u, v) => { const [X, Y] = apply(m, cx, cy); return { x: X, y: Y, u: u / tw, v: v / th, r: c[0] * col[0], g: c[1] * col[1], b: c[2] * col[2], a: c[3] * col[3] }; };
        if (g.w && g.h) canvas.quad([corner(gx, gy, g.x, g.y), corner(gx + g.w, gy, g.x + g.w, g.y), corner(gx + g.w, gy + g.h, g.x + g.w, g.y + g.h), corner(gx, gy + g.h, g.x, g.y + g.h)], font.tex, false);
        pen += g.adv; prev = code;
      }
    });
    if (flags & 0x50) pass(shadow, sdx, sdy);
    pass(color, 0, 0);
    stats.texts++;
  };

  // Draw traversal as 0x1398C0: a state is drawn when header+0 (visible) is set; a child group when the word its
  // header pointer points at is set; colour = parent * header+0x3C (mul), + header+0x4C (add).
  const childVisible = c => {
    const h = buf.readUInt32LE(c.offset);
    if (opts.mem) return opts.mem.r32(h) !== 0;
    return h + 4 <= buf.length ? buf.readUInt32LE(h) !== 0 : true;
  };
  const drawState = (idx, parent, pcol, padd, depth) => {
    const st = p.states[idx]; if (!st || depth > 64) return;
    const h = st.header, t = h + 8;
    if (!opts.all && !buf.readUInt32LE(h)) return;
    // 0x140350: translate position (+0) and pivot (+0xC), rotate x / y / z (+0x18 / +0x1C / +0x20), scale (+0x24), translate -pivot
    let m = mul(mul(parent, T(f32(t), f32(t + 4), f32(t + 8))), T(f32(t + 12), f32(t + 16), f32(t + 20)));
    const rx = f32(t + 24), ry = f32(t + 28), rz = f32(t + 32);
    if (rx || ry || rz) m = mul(mul(mul(m, RX(rx)), RY(ry)), RZ(rz));
    m = mul(mul(m, S(f32(t + 36), f32(t + 40), f32(t + 44))), T(-f32(t + 12), -f32(t + 16), -f32(t + 20)));
    const col = [0, 1, 2, 3].map(i => pcol[i] * f32(h + 0x3c + i * 4)), add = [0, 1, 2, 3].map(i => padd[i] + f32(h + 0x4c + i * 4));
    const eff = col.map((c, i) => c + add[i] * 0);   // additive term recorded; elements use mul (see notes)
    stats.states++;
    for (const c of st.children) {
      if (!opts.all && !childVisible(c)) continue;
      for (const it of c.items) {
        if (it.type === -1) drawState(it.state, m, col, add, depth + 1);
        else if (it.type === 0) drawElement(it.data, m, eff);
        else if (it.type === 6) drawText(it.data, m, eff);
        else if (it.type === 8) drawFan(it.data, m, eff);
        else if (it.type === 2) canvas.mark3d?.();                // a 3D car object: the game draws it here
        // a 3D object of type 4 ({ u16 7, u16 id 1..0x34 }: the map's flag, the trophies): drawn by the game too
        else if (it.type === 4 && buf.readUInt16LE(it.data) === 7 && buf.readUInt16LE(it.data + 2) >= 1 && buf.readUInt16LE(it.data + 2) <= 0x34) canvas.mark3d?.();
      }
    }
  };
  drawState(0, I3, [1, 1, 1, 1], [0, 0, 0, 0], 0);
  return stats;
}

function main() {
  const args = process.argv.slice(2), flag = k => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; };
  const all = args.includes("--all"); if (all) args.splice(args.indexOf("--all"), 1);
  const outW = Number(flag("--width") ?? W);
  const [dataDir, file, g, s, out] = args;
  if (!out) { console.error("usage: node uis-render.mjs <Data dir> <uis_all.dat|screen> <group> <screen> <out.png> [--all] [--width N]"); process.exit(1); }
  const sc = screensIn(readFileSync(file)).find(x => x.group == g && x.screen == s);
  if (!sc) throw new Error(`no screen ${g}/${s}`);
  const assets = new Assets(dataDir), canvas = new Canvas();
  const stats = renderScreen(sc.buf, assets, canvas, { all });
  import("node:fs").then(fs => fs.writeFileSync(out, canvas.png(outW)));
  console.log(`${out}: ${stats.states} states, ${stats.elements} elements, ${stats.texts} texts, ${stats.skipped} skipped` +
              (assets.missing.size ? `; missing: ${[...assets.missing].join(", ")}` : ""));
}

if (process.argv[1]?.endsWith("uis-render.mjs")) main();
