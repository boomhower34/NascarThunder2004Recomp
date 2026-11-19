// sponsor-decals.mjs — sponsors added to the game's own sponsor list (the launcher's Sponsors tab, "Sponsor list"):
// the car decals Create-A-Car and the career's Sign Sponsors put on the player's car, made from the sponsor's logo.
//
// The game: SPIN (SPID, SSID speech, SPLG logo, SNAM name) and SPON (one row per location a sponsor can take: STYP 0..4
// associate spots, 5 primary; SPLV level, CSPP payment, IAVA available). An associate's logo SPLG picks
//   - its menu logo: UIS_SPON entry SPLG (a primary's: SPLG + 45, 0x3E0D0), 128 x 128 DXT1;
//   - its car decals: CARPARTS.DAT entry base + SPLG for the decal kinds 7..15 of the part index 0x6D3D0 (bases 226,
//     271, 316, 361, 406, 451, 496, 541, 586; 45 stock associates each). LIN_L8 images, one level, read as indexes into
//     the colour ramps the paint compositor builds from the car's decal colours (0x6EE10: 0x00-0x0F clear, 0x10-0x3F
//     colour B -> black, 0x40-0xCF colour A -> colour B, 0xD0-0xFF black -> colour A; A and B: the car's decal colours).
// Added sponsors get SPLG = BRAND_SPLG(id) = 0x800 + id * 0x300, so base + SPLG lands past CARPARTS' own entries and
// (base < 0x300) identifies the kind: gamecode's archive view makes the entry from the logo here. The menu logo is
// the uis_spon texture override roster/textures/uis_spon/<SPLG>.png (uis-render), which the launcher writes. SPLG is
// read back as a 16-bit signed value by the menus (0x80BE7): ids 1..32.
import { resize } from "./paint-mmap.mjs";

// (SPID: the career's signing code keeps it in a byte (0x3BDD9 inserted CONT / SSTA rows with SPID & 0xFF), so the
// added sponsors take 188..219, past the stock 187)
export const BRAND_BASE = 0x800, BRAND_STEP = 0x300, MAX_BRANDS = 32, BRAND_SPID = 187, STOCK_DECALS = 45;
export const brandSplg = id => BRAND_BASE + id * BRAND_STEP;
// the decal kinds: CARPARTS base, how the logo is turned in it (clockwise degrees), the shape (from the stock decals)
export const DECAL_SETS = [
  { base: 226, rot: 90, name: "hood (128 x 128, turned)" }, { base: 271, rot: 0, name: "quarter panel (128 x 32)" },
  { base: 316, rot: 270, name: "pillar (64 x 128, turned)" }, { base: 361, rot: 0, name: "side (128 x 32)" },
  { base: 406, rot: 180, name: "side, other way (128 x 32)" }, { base: 451, rot: 0, name: "small 1 (32 x 32)" },
  { base: 496, rot: 0, name: "small 2" }, { base: 541, rot: 0, name: "small 3" }, { base: 586, rot: 0, name: "small 4" },
];
// which brand and kind a CARPARTS entry past the stock ones stands for (null: none)
export function brandEntry(e) {
  if (e < BRAND_BASE + BRAND_STEP) return null;
  const id = Math.floor((e - BRAND_BASE) / BRAND_STEP), base = (e - BRAND_BASE) % BRAND_STEP, set = DECAL_SETS.find(s => s.base === base);
  return set && id >= 1 && id <= MAX_BRANDS ? { id, set } : null;
}
// level -> payment (CSPP), the middle of the stock values of each level (table CSPL: 0..59, 60..69, ... 90..)
export const LEVEL_PAY = [51, 62, 72, 82, 92];

const linL8 = buf => { const w = buf.readUInt16LE(0x28), h = buf.readUInt16LE(0x2a), f = buf.readUInt32LE(0x2c); if (f !== 0x13) throw new Error(`decal template format 0x${f.toString(16)}`); return { w, h, off: 0x80 + buf.readUInt32LE(0x34) }; };

// where the stock decals of each kind sit in their image (the median box of the 45): a new logo goes in the same place
export function decalBoxes(carparts) {
  const out = new Map();
  for (const s of DECAL_SETS) {
    const boxes = [];
    for (let k = 0; k < STOCK_DECALS; k++) {
      const b = carparts.entry(s.base + k), { w, h, off } = linL8(b); let x0 = w, y0 = h, x1 = -1, y1 = -1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (b[off + y * w + x] >= 0x10) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (x1 >= 0) boxes.push([x0, y0, x1 + 1, y1 + 1]);
    }
    const med = i => { const v = boxes.map(b => b[i]).sort((a, b) => a - b); return v[v.length >> 1]; };
    const { w, h } = linL8(carparts.entry(s.base));
    out.set(s.base, boxes.length ? { x0: med(0), y0: med(1), x1: med(2), y1: med(3), w, h } : { x0: 0, y0: 0, x1: w, y1: h, w, h });
  }
  return out;
}

// the logo: cut out (a picture without transparency: its background colour, taken from the corners, is cut away),
// cropped to what is left
export function prepareLogo({ width: w, height: h, rgba }) {
  const px = Uint8Array.from(rgba);
  let clear = false; for (let i = 3; i < px.length; i += 4) if (px[i] < 250) { clear = true; break; }
  if (!clear) {
    const cs = [0, w - 1, (h - 1) * w, h * w - 1].map(i => px.subarray(i * 4, i * 4 + 3)), bg = [0, 1, 2].map(c => cs.reduce((a, p) => a + p[c], 0) / 4);
    for (let i = 0; i < w * h; i++) { const d = Math.hypot(px[i * 4] - bg[0], px[i * 4 + 1] - bg[1], px[i * 4 + 2] - bg[2]); px[i * 4 + 3] = d < 24 ? 0 : d < 56 ? Math.round((d - 24) / 32 * 255) : 255; }
  }
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[(y * w + x) * 4 + 3] > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) throw new Error("the logo is empty (all transparent or all one colour)");
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, out = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) out.set(px.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x1 + 1) * 4), y * cw * 4);
  return { width: cw, height: ch, rgba: out };
}
function turn({ width: w, height: h, rgba }, rot) {
  if (!rot) return { width: w, height: h, rgba };
  const W = rot === 180 ? w : h, H = rot === 180 ? h : w, out = new Uint8Array(W * H * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [X, Y] = rot === 90 ? [h - 1 - y, x] : rot === 270 ? [y, w - 1 - x] : [w - 1 - x, h - 1 - y];
    out.set(rgba.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), (Y * W + X) * 4);
  }
  return { width: W, height: H, rgba: out };
}
// premultiplied resize (no colour from transparent pixels)
function scale({ width: w, height: h, rgba }, W, H) {
  const p = Uint8Array.from(rgba); for (let i = 0; i < p.length; i += 4) { const a = p[i + 3] / 255; p[i] *= a; p[i + 1] *= a; p[i + 2] *= a; }
  const r = resize(p, w, h, W, H); for (let i = 0; i < r.length; i += 4) { const a = r[i + 3] / 255; if (a > 0) { r[i] = Math.min(255, r[i] / a); r[i + 1] = Math.min(255, r[i + 1] / a); r[i + 2] = Math.min(255, r[i + 2] / a); } }
  return r;
}

// one decal: the template (the stock decal of that kind) with the logo's indexes: light parts colour A, dark parts
// colour B (the ramp between them), edges / clear parts 0
export function makeDecal(template, logo, set, box) {
  const out = Buffer.from(template), { w, h, off } = linL8(out); out.fill(0, off, off + w * h);
  const t = turn(logo, set.rot), bw = box.x1 - box.x0, bh = box.y1 - box.y0, s = Math.min(bw / t.width, bh / t.height);
  const W = Math.max(1, Math.round(t.width * s)), H = Math.max(1, Math.round(t.height * s)), ox = box.x0 + Math.round((bw - W) / 2), oy = box.y0 + Math.round((bh - H) / 2);
  const px = scale(t, W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4, X = ox + x, Y = oy + y; if (X < 0 || Y < 0 || X >= w || Y >= h || px[i + 3] < 128) continue;
    const L = (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]) / 255;
    out[off + Y * w + X] = 0xcf - Math.round(L * 0x8f);
  }
  return out;
}

// how a decal looks with two decal colours (A light parts, B dark parts): a preview picture
export function previewDecal(buf, a = [255, 255, 255], b = [30, 30, 30]) {
  const { w, h, off } = linL8(buf), rgba = new Uint8Array(w * h * 4), mix = (p, q, f) => p.map((v, i) => v + (q[i] - v) * f);
  for (let i = 0; i < w * h; i++) {
    const v = buf[off + i]; let c = null;
    if (v >= 0xd0) c = mix([0, 0, 0], a, (v - 0xd0) / 0x2f); else if (v >= 0x40) c = mix(a, b, (v - 0x40) / 0x8f); else if (v >= 0x10) c = mix(b, [0, 0, 0], (v - 0x10) / 0x2f);
    if (c) { rgba.set(c.map(Math.round), i * 4); rgba[i * 4 + 3] = 255; }
  }
  return { width: w, height: h, rgba };
}
