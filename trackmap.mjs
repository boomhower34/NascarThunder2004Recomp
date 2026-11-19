// trackmap.mjs — the race HUD's track map (TMAPDAT.DAT) for a track with a layout of its own.
//
// TMAPDAT: entry 0 a small common texture, then 4 entries per track from TRCK.IDTM (the race reads it with
// "select TRCK.IDTM from TRCK join GINF on TRID", 0xDABF0, and loads IDTM + 1 or + 3 at 0xDAC10):
//   IDTM + 0  small map, 128 x 128 MMAP (paletted 0x0B), the track in the right half on a transparent background
//   IDTM + 1  its placement: 4 floats sc, th, ox, oy
//   IDTM + 2  large map, 256 x 256, the track in the middle on black
//   IDTM + 3  its placement
// A car at physics (x, y) feet shows at u = (A cos th - B sin th + ox) sc, v = (A sin th + B cos th + oy) sc with
// A = 30.48 x, B = 30.48 y (centimetres); pixel ((u + 1) / 2 W, (1 - v) / 2 H). Fitted on the stock maps: the racing
// lines of 35 tracks land on the grey of their maps (Atlanta 0.96, Bristol / Martinsville / Phoenix 1.00). The large
// map's track spans u -0.5..0.5 and v about -0.98..0.98; the small one is the same shifted by u +0.5 (ox + 0.5 / sc).
// Colours as the stock maps: track 131 grey with 106 edges, apron / grass 32,139,32, pit road 106,90,205, a white start
// line.
//
// usage: import { buildTrackMap } from "./trackmap.mjs";
//        buildTrackMap(layout, { small: templateMMAP, large: templateMMAP }) -> { small, smallPos, large, largePos } buffers

import { encodePaint } from "./paint-mmap.mjs";

const FT = 30.48;
export function mapTransform(points) {
  // the rotation that stands the track up (its long side vertical), then the scale that fits u -0.5..0.5, v -0.97..0.97
  let best = null, square = null;
  for (let k = 0; k < 180; k++) { const th = (k / 180) * Math.PI - Math.PI / 2, c = Math.cos(th), s = Math.sin(th);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [x, y] of points) { const A = x * FT, B = y * FT, u = A * c - B * s, v = A * s + B * c; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const sc = Math.min(1 / (u1 - u0), 1.94 / (v1 - v0)), cand = { sc, th, ox: -(u0 + u1) / 2, oy: -(v0 + v1) / 2 };
    if (!best || sc > best.sc) best = cand; if (k % 90 === 0 && (!square || sc > square.sc)) square = cand; }
  return square && square.sc >= 0.9 * best.sc ? square : best;      // (upright, as the stock maps, unless that is much smaller)
}
const posBuf = ({ sc, th, ox, oy }) => { const b = Buffer.alloc(16); [sc, th, ox, oy].forEach((v, i) => b.writeFloatLE(v, i * 4)); return b; };

function render(L, T, W, H, shift, background) {
  const P = L.points, n = P.length, inE = L.edges.in, outE = L.edges.out, win = L.walls?.in ?? [], near = L.pit?.near ?? [], far = L.pit?.far ?? [];
  const tan = P.map((p, i) => { const a = P[(i - 1 + n) % n], b = P[(i + 1) % n], dx = b[0] - a[0], dy = b[1] - a[1], m = Math.hypot(dx, dy) || 1; return [dx / m, dy / m]; });
  // spatial grid of layout points
  const cell = 60, grid = new Map(), key = (x, y) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  P.forEach((p, i) => { const k = key(p[0], p[1]); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
  const nearest = (x, y) => { let bi = -1, bd = Infinity; const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    for (let r = 0; r < 6 && (bi < 0 || r < 2); r++) for (let ix = gx - r; ix <= gx + r; ix++) for (let iy = gy - r; iy <= gy + r; iy++) { if (Math.max(Math.abs(ix - gx), Math.abs(iy - gy)) !== r) continue;
      for (const i of grid.get(`${ix},${iy}`) ?? []) { const d = (P[i][0] - x) ** 2 + (P[i][1] - y) ** 2; if (d < bd) { bd = d; bi = i; } } }
    return bi; };
  const c = Math.cos(T.th), s = Math.sin(T.th), feetPerPx = 2 / (W * T.sc * FT);
  const colourAt = (x, y) => { const i = nearest(x, y); if (i < 0) return background;
    const [tx, ty] = tan[i], d = (x - P[i][0]) * ty - (y - P[i][1]) * tx, along = (x - P[i][0]) * tx + (y - P[i][1]) * ty;   // d right +
    if (Math.abs(along) > 40) return background;
    const ein = inE[i], eout = outE[i], edge = Math.max(1.5 * feetPerPx, 3);
    if (d >= ein && d <= eout) { if (i < 2 || i > n - 3) { if (Math.abs(along) < 1.5 * feetPerPx) return [255, 255, 255, 255]; } return d - ein < edge || eout - d < edge ? [106, 106, 106, 255] : [131, 131, 131, 255]; }
    if (Number.isFinite(near[i]) && Number.isFinite(far[i])) { const a = Math.min(near[i], far[i]), b = Math.max(near[i], far[i]); if (d >= a && d <= b) return [106, 90, 205, 255]; }
    const inner = Number.isFinite(win[i]) ? Math.max(win[i], ein - 40) : ein - 25; if (d < ein && d >= inner) return [32, 139, 32, 255];
    if (d > eout && d <= eout + 6) return [106, 106, 106, 255];
    return background; };
  const out = new Uint8Array(W * H * 4);
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) { const acc = [0, 0, 0, 0];
    for (const [sx, sy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      const u = ((px + sx) / W) * 2 - 1 - shift, v = 1 - ((py + sy) / H) * 2, a = u / T.sc - T.ox, b = v / T.sc - T.oy;   // inverse: rotate back
      const A = a * c + b * s, B = -a * s + b * c, col = colourAt(A / FT, B / FT); for (let k = 0; k < 4; k++) acc[k] += col[k] / 4; }
    out.set(acc.map(Math.round), (py * W + px) * 4); }
  return out;
}

export function buildTrackMap(layout, templates) {
  const T = mapTransform(layout.points), small = { ...T, ox: T.ox + 0.5 / T.sc };
  const big = render(layout, T, 256, 256, 0, [0, 0, 0, 255]), sm = render(layout, T, 128, 128, 0.5, [0, 0, 0, 0]);
  return { large: encodePaint(templates.large, big, 256, 256), largePos: posBuf(T), small: encodePaint(templates.small, sm, 128, 128), smallPos: posBuf(small), images: { large: big, small: sm }, transform: T };
}
