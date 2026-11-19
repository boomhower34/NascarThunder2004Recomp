// paint-layout.mjs — car paints made on another game's template layout, rearranged onto this game's.
//
// Modders' high-resolution templates (e.g. 1252 x 1252, from a later EA NASCAR game) hold the same body parts as this
// game's paint, drawn the same way, but placed and sized differently on the sheet:
//   this game (CARDATA "DECAL", fractions of the sheet)    the 1252 layout ("ea1252")
//   body: both sides, hood / roof / deck, the spoiler       body block at the top left (0..0.84 wide, 0.04..0.58),
//     strip and the antenna, one block over the top 0.7     the same parts in the same arrangement, smaller
//   front bumper bottom left (y > 0.8)                     front bumper bottom left (y > 0.66)
//   rear deck lid + bumper bottom right (x > 0.46)         rear deck lid + bumper bottom middle
//   a small marker dot at the top middle (kept)           a disc at the top (left out)
// Each zone is found on both sheets from the opaque parts (alpha > 200, or not black when a sheet has no alpha;
// rows / columns with less than 8 % of the zone covered are left out, so a stray mark doesn't stretch the box: at 2.5 %
// the 1252 sheet's disc above the body counted, the box began 15 px too high and the car's right side came out 6 px
// off at its lower edge, a black strip along the rocker),
// and mapped box onto box (scale and shift per axis; measured on a Dodge: the body's scale 1.22 x 1.23, the spoiler
// and antenna land within a pixel). Outside the zones the template's pixels stay. The alpha is the template's (it
// is part of the car's look: windows, the alpha-0 areas); where a solid part of it falls just off a panel of the
// other sheet, the nearest painted pixel (within 8 px) fills in.
//
// usage: import { convertLayout, LAYOUTS, guessLayout } from "./paint-layout.mjs";
//        convertLayout(src: { width, height, rgba }, template: { width, height, rgba }, "ea1252", size) -> { width, height, rgba, zones }

import { resize } from "./paint-mmap.mjs";

// zones as [x0, y0, x1, y1] fractions: where to look on the source sheet / on this game's sheet
export const LAYOUTS = {
  ea1252: {
    name: "1252 modder template (later EA NASCAR layout)",
    src: { body: [0, 0.03, 0.84, 0.585], front: [0, 0.66, 0.36, 1], rear: [0.36, 0.58, 0.84, 1] },
  },
};
const DST = { body: [0, 0.035, 1, 0.745], front: [0, 0.8, 0.45, 1], rear: [0.46, 0.745, 1, 1] };
const ORDER = ["front", "rear", "body"];          // (a target pixel belongs to the first zone whose box holds it)

export function guessLayout(w, h) { return w === h && w >= 1200 && w <= 1300 ? "ea1252" : null; }

function mask(img) {
  const { width: w, height: h, rgba } = img, m = new Uint8Array(w * h);
  let anyAlpha = false; for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 250) { anyAlpha = true; break; }
  for (let i = 0; i < w * h; i++) m[i] = anyAlpha ? rgba[i * 4 + 3] > 200 : rgba[i * 4] + rgba[i * 4 + 1] + rgba[i * 4 + 2] > 40;
  return m;
}
function box(m, w, h, z) {                                // the opaque parts' box inside zone z (fractions), in pixels
  const X0 = Math.floor(z[0] * w), Y0 = Math.floor(z[1] * h), X1 = Math.ceil(z[2] * w), Y1 = Math.ceil(z[3] * h);
  const rows = new Uint32Array(Y1 - Y0), cols = new Uint32Array(X1 - X0);
  for (let y = Y0; y < Y1; y++) for (let x = X0; x < X1; x++) if (m[y * w + x]) { rows[y - Y0]++; cols[x - X0]++; }
  const rmin = Math.max(2, 0.08 * (X1 - X0)), cmin = Math.max(2, 0.08 * (Y1 - Y0));
  let y0 = rows.findIndex(v => v >= rmin), y1 = rows.length - 1 - [...rows].reverse().findIndex(v => v >= rmin);
  let x0 = cols.findIndex(v => v >= cmin), x1 = cols.length - 1 - [...cols].reverse().findIndex(v => v >= cmin);
  if (y0 < 0 || x0 < 0) {                                 // small zones (the dot): any opaque pixel
    y0 = rows.findIndex(v => v > 0); x0 = cols.findIndex(v => v > 0); if (y0 < 0) return null;
    y1 = rows.length - 1 - [...rows].reverse().findIndex(v => v > 0); x1 = cols.length - 1 - [...cols].reverse().findIndex(v => v > 0);
  }
  return [X0 + x0, Y0 + y0, X0 + x1 + 1, Y0 + y1 + 1];
}

export function convertLayout(src, template, layout = "ea1252", size = 1024) {
  const L = LAYOUTS[layout]; if (!L) throw new Error(`unknown template layout ${layout}`);
  const tpl = template.width === size ? template : { width: size, height: size, rgba: resize(template.rgba, template.width, template.height, size, size) };
  const sm = mask(src), tm = mask(tpl), zones = {};
  for (const k of ORDER) {
    const s = box(sm, src.width, src.height, L.src[k]), d = box(tm, size, size, DST[k]);
    if (s && d) zones[k] = { s, d, sx: (s[2] - s[0]) / (d[2] - d[0]), sy: (s[3] - s[1]) / (d[3] - d[1]) };
  }
  if (!zones.body) throw new Error("no car body found on the picture");
  const out = Uint8Array.from(tpl.rgba), S = src.rgba, W = src.width, H = src.height;
  const inZ = (z, x, y) => x >= z[0] * size && x < z[2] * size && y >= z[1] * size && y < z[3] * size;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const k = ORDER.find(k => zones[k] && inZ(DST[k], x, y)); if (!k) continue;
    const z = zones[k], u = z.s[0] + (x + 0.5 - z.d[0]) * z.sx - 0.5, v = z.s[1] + (y + 0.5 - z.d[1]) * z.sy - 0.5;
    if (u < -1 || v < -1 || u > W || v > H) continue;
    const x0 = Math.max(0, Math.min(W - 1, Math.floor(u))), y0 = Math.max(0, Math.min(H - 1, Math.floor(v))), x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1), fx = Math.max(0, Math.min(1, u - x0)), fy = Math.max(0, Math.min(1, v - y0));
    const o = (y * size + x) * 4;
    // a solid part of the car (template alpha > 200) over the other sheet's background (its panels a pixel or two
    // smaller there): the nearest painted pixel within 8 px instead of a black seam
    if (out[o + 3] > 200 && !sm[Math.round(Math.max(0, Math.min(H - 1, v))) * W + Math.round(Math.max(0, Math.min(W - 1, u)))]) {
      const cx = Math.round(u), cy = Math.round(v); let best = -1, bd = Infinity;
      for (let dy = -8; dy <= 8; dy++) for (let dx = -8; dx <= 8; dx++) { const px = cx + dx, py = cy + dy, d = dx * dx + dy * dy;
        if (d < bd && px >= 0 && py >= 0 && px < W && py < H && sm[py * W + px]) { bd = d; best = py * W + px; } }
      if (best >= 0) { out[o] = S[best * 4]; out[o + 1] = S[best * 4 + 1]; out[o + 2] = S[best * 4 + 2]; continue; }
    }
    for (let c = 0; c < 3; c++) out[o + c] = Math.round((S[(y0 * W + x0) * 4 + c] * (1 - fx) + S[(y0 * W + x1) * 4 + c] * fx) * (1 - fy) + (S[(y1 * W + x0) * 4 + c] * (1 - fx) + S[(y1 * W + x1) * 4 + c] * fx) * fy);
  }
  return { width: size, height: size, rgba: out, zones };
}
