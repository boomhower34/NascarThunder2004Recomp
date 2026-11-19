// number-paint.mjs — car numbers drawn onto a paint that has none (the Sponsors tab's paint schemes), with the game's
// own Create-A-Car number fonts.
//
// Fonts: CARPARTS.DAT entries 192..206 (side) and 207..221 (roof), one per FONT row (0 Regular .. 14 Pale): 512 x 64
// strips of the digits 0-9 in grey levels (fill ~210, outline ~50, highlights up to 255; cells 38 / 46 px apart).
// Number spots: where the stock paints of each make (CARS CMDL 0 Monte Carlo, 1 Intrepid, 2 Taurus, 3 Grand Prix)
// carry their numbers on the 512 x 512 layout, as fractions of the paint: both doors (the upper one upside down),
// the roof, a headlight and the rear (by the tail light). A scheme can move them (spots in its record).
//
//   const fonts = loadFonts(carparts terf (terf.mjs parseTerf), decodeMMAP)
//   drawNumber(rgba, width, height, "24", spots, { font: 2, fill: "#ffffff", outline: "#000000", outline2: "#c00000" }, fonts)

const box = (x0, y0, x1, y1, rot = 0, name = "") => ({ name, x: x0 / 512, y: y0 / 512, w: (x1 - x0) / 512, h: (y1 - y0) / 512, rot });
export const DEFAULT_SPOTS = {
  0: [box(204, 42, 292, 98, 180, "door (top)"), box(226, 148, 350, 238, 0, "roof"), box(210, 284, 294, 342, 0, "door"), box(16, 425, 43, 444, 0, "headlight"), box(460, 434, 502, 464, 0, "rear")],
  1: [box(200, 46, 290, 94, 180, "door (top)"), box(228, 155, 335, 232, 0, "roof"), box(198, 290, 290, 335, 0, "door"), box(22, 450, 46, 470, 0, "headlight"), box(465, 437, 495, 453, 0, "rear")],
  2: [box(220, 47, 290, 93, 180, "door (top)"), box(230, 150, 345, 232, 0, "roof"), box(220, 292, 290, 338, 0, "door"), box(27, 445, 55, 463, 0, "headlight"), box(462, 437, 495, 458, 0, "rear")],
  3: [box(212, 47, 288, 93, 180, "door (top)"), box(235, 152, 350, 232, 0, "roof"), box(217, 292, 293, 338, 0, "door"), box(27, 437, 50, 453, 0, "headlight"), box(460, 435, 495, 460, 0, "rear")],
};
export const FONT_NAMES = ["Regular", "Italic", "Bold", "Skinny", "Square", "Shadow", "Normal", "Big", "Big Outline", "3D", "Standard", "Thin", "Round", "Straight", "Pale"];
export const FONT_SIDE = 192, FONT_ROOF = 207;

// the digit cells of one strip: { w, h, v (Uint8 grey), glyphs: [[x0, x1, y0, y1] x 10] }
function strip(img, pitch) {
  const { width: w, height: h, rgba } = img, v = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) v[i] = Math.max(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]) * rgba[i * 4 + 3] / 255;
  const glyphs = [];
  for (let d = 0; d < 10; d++) {
    let x0 = Math.min(w, d * pitch), x1 = Math.min(w, (d + 1) * pitch), y0 = h, y1 = 0, a = x1, b = x0;
    for (let x = x0; x < x1; x++) for (let y = 0; y < h; y++) if (v[y * w + x] > 20) { a = Math.min(a, x); b = Math.max(b, x + 1); y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1); }
    glyphs.push(b > a ? [a, b, y0, y1] : [x0, x0 + 1, 0, 1]);
  }
  return { w, h, v, glyphs };
}
export function loadFonts(terf, decodeMMAP) {
  const fonts = [];
  for (let i = 0; i < 15; i++) {
    try { fonts.push({ side: strip(decodeMMAP(terf.entry(FONT_SIDE + i)), 38), roof: strip(decodeMMAP(terf.entry(FONT_ROOF + i)), 46) }); }
    catch { fonts.push(null); }
  }
  return fonts;
}
const rgb = h => /^#[0-9a-f]{6}$/i.test(h ?? "") ? [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)) : null;

// the number as one grey picture: digits side by side (2 strip px apart), rows from the tallest digit's top to bottom
function numberImage(text, s) {
  const ds = String(text).replace(/\D/g, "").slice(0, 3).split("").map(Number); if (!ds.length) return null;
  const gap = 2, top = Math.min(...ds.map(d => s.glyphs[d][2])), bot = Math.max(...ds.map(d => s.glyphs[d][3]));
  const W = ds.reduce((a, d) => a + s.glyphs[d][1] - s.glyphs[d][0], 0) + gap * (ds.length - 1), H = bot - top, out = new Float32Array(W * H);
  let x = 0;
  for (const d of ds) { const [a, b] = s.glyphs[d]; for (let yy = 0; yy < H; yy++) for (let xx = a; xx < b; xx++) out[yy * W + x + xx - a] = s.v[(top + yy) * s.w + xx]; x += b - a + gap; }
  return { W, H, v: out };
}

export function drawNumber(rgba, width, height, text, spots, style = {}, fonts) {
  const f = fonts?.[style.font ?? 2] ?? fonts?.find(Boolean); if (!f) return rgba;
  const fill = rgb(style.fill) ?? [255, 255, 255], out1 = rgb(style.outline) ?? [0, 0, 0], out2 = rgb(style.outline2);
  for (const sp of spots ?? []) {
    const n = numberImage(text, sp.name === "roof" ? f.roof : f.side); if (!n) continue;
    const bx = sp.x * width, by = sp.y * height, bw = sp.w * width, bh = sp.h * height, rot = ((sp.rot ?? 0) % 360 + 360) % 360, turn = rot === 90 || rot === 270;
    // fit (keeping the font's shape) in the spot, centred
    const tw = turn ? bh : bw, th = turn ? bw : bh, s = Math.min(tw / n.W, th / n.H), gw = n.W * s, gh = n.H * s;
    const k2 = out2 ? Math.max(1, gh * 0.07) : 0;                       // the second outline's thickness, px
    const cx = bx + bw / 2, cy = by + bh / 2, half = (turn ? Math.max(gh, gw) : Math.max(gw, gh)) / 2 + k2 + 2;
    const sample = (u, v) => {                                             // bilinear, in number-picture px
      if (u < 0 || v < 0 || u > n.W - 1 || v > n.H - 1) return 0;
      const x0 = Math.floor(u), y0 = Math.floor(v), x1 = Math.min(n.W - 1, x0 + 1), y1 = Math.min(n.H - 1, y0 + 1), fx = u - x0, fy = v - y0, V = n.v;
      return (V[y0 * n.W + x0] * (1 - fx) + V[y0 * n.W + x1] * fx) * (1 - fy) + (V[y1 * n.W + x0] * (1 - fx) + V[y1 * n.W + x1] * fx) * fy;
    };
    const local = (px, py) => {                                            // paint px -> number-picture coords
      let dx = px - cx, dy = py - cy;
      if (rot === 180) { dx = -dx; dy = -dy; } else if (rot === 90) [dx, dy] = [dy, -dx]; else if (rot === 270) [dx, dy] = [-dy, dx];
      return [(dx + gw / 2) / s, (dy + gh / 2) / s];
    };
    const X0 = Math.max(0, Math.floor(cx - half)), X1 = Math.min(width - 1, Math.ceil(cx + half)), Y0 = Math.max(0, Math.floor(cy - half)), Y1 = Math.min(height - 1, Math.ceil(cy + half));
    // coverage of the number's own outline (alpha) on the paint grid, for the second outline
    let cover = null;
    if (out2) {
      const w = X1 - X0 + 1, h = Y1 - Y0 + 1; cover = new Float32Array(w * h);
      for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) { const [u, v] = local(x + 0.5, y + 0.5); cover[(y - Y0) * w + x - X0] = Math.min(1, sample(u, v) / 40); }
      const r = Math.ceil(k2), grown = new Float32Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let m = 0; for (let j = -r; j <= r && m < 1; j++) for (let i = -r; i <= r; i++) { if (i * i + j * j > k2 * k2) continue; const xx = x + i, yy = y + j; if (xx >= 0 && yy >= 0 && xx < w && yy < h) m = Math.max(m, cover[yy * w + xx]); } grown[y * w + x] = m; }
      cover = { w, a: grown };
    }
    for (let y = Y0; y <= Y1; y++) for (let x = X0; x <= X1; x++) {
      const [u, v] = local(x + 0.5, y + 0.5), g = sample(u, v), o = (y * width + x) * 4;
      const fa = Math.max(0, Math.min(1, (g - 120) / 60)), oa = Math.min(1, g / 40), a2 = cover ? cover.a[(y - Y0) * cover.w + x - X0] : 0;
      if (fa <= 0 && oa <= 0 && a2 <= 0) continue;
      let r = rgba[o], gg = rgba[o + 1], b = rgba[o + 2];
      if (a2 > 0) { r += (out2[0] - r) * a2; gg += (out2[1] - gg) * a2; b += (out2[2] - b) * a2; }
      if (oa > 0) { r += (out1[0] - r) * oa; gg += (out1[1] - gg) * oa; b += (out1[2] - b) * oa; }
      if (fa > 0) { const sh = Math.max(0.6, Math.min(1.2, g / 210)); r += (Math.min(255, fill[0] * sh) - r) * fa; gg += (Math.min(255, fill[1] * sh) - gg) * fa; b += (Math.min(255, fill[2] * sh) - b) * fa; }
      rgba[o] = r; rgba[o + 1] = gg; rgba[o + 2] = b;
    }
  }
  return rgba;
}

// spots of a scheme for a make: its own, else the make's defaults; scaled when a scheme's paint is not 512 square
export const spotsFor = (scheme, make) => (scheme?.spots?.[make]?.length ? scheme.spots[make] : DEFAULT_SPOTS[make] ?? DEFAULT_SPOTS[0]);
