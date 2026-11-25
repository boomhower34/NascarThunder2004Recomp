// trackwarp.mjs — a new track layout from an existing one: the base track's physics (TK_PHYS: collision, sections,
// walls, AI / pit lines, spots, cameras, lights), AI speeds (AI_SPDS) and render model (TK_REND) are carried along a
// new centreline. Every point keeps its lap fraction (position along the base track) and its sideways offset from
// the base track's centre; heights follow the new layout's banking. Long triangles and wall panels are cut first so
// straights can bend. The result is a complete, consistent track the game drives: a new shape with the base track's
// structure (pit road, lanes, grid, AI behaviour), to be dressed with a model of its own.
//
//   layout (JSON, feet, TK_PHYS frame: x, y ground plane, z up; driven counter-clockwise like the base tracks):
//     { "points": [[x, y], ...]   closed centreline (smoothed: Catmull-Rom), first point = the start / finish line,
//       "bank": deg | [deg per point] | "auto" (default: bankStraight 5, bankTurn 20 by curvature),
//       "z": ft | [ft per point] (default: the base track's height) }
//   centrelineFromGLTF(file): the layout from a model: a mesh named like "centerline" / "centreline" made of edges
//   (Blender: an edge loop, exported as lines), metres y up -> feet; driven counter-clockwise, starting at its
//   first vertex (or the vertex nearest an object named "start"); meshes / materials named like road, track,
//   surface or asphalt give the heights and banking along it (else the centreline's heights and "auto" banking)
//   warpTrack({ data, baseRend, basePhys, layout }) -> { phys, ai, rend, info }
//
// CLI: node trackwarp.mjs <Data> <base TK_REND entry> <base TK_PHYS entry> <layout.json> <outDir>
//      writes tk_phys.bin, ai_spds.bin, tk_rend.bin, layout.svg
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import * as nodeFs from "node:fs";
import { join, basename } from "node:path";
import { readTerfEntry } from "../game/terf.mjs";
import { physDocument, physFromDocument } from "./tkphys.mjs";
import { parseAISpeeds, writeAISpeeds, SAMPLES } from "./aispeeds.mjs";
import { parseDb } from "../game/nascar-db.mjs";
import { parseTMdl, drawTriangles, textureRGBA, nodeMatrix } from "./tmdl.mjs";
import { buildTMdl } from "./tmdl-build.mjs";
import { generateLines, baseFlipped } from "./linegen.mjs";

const FT = 30.48, MAX_EDGE = +(process.env.NT04_WARP_EDGE ?? 0), REND_EDGE = 24;   // cm per foot; physics edges cut only where the warp bends them (a length: cut everything longer, for tests); scenery edges cut past 24 ft
const bez = (p0, c, p1, t) => [0, 1, 2].map(k => (1 - t) ** 2 * p0[k] + 2 * (1 - t) * t * c[k] + t * t * p1[k]);
const bezD = (p0, c, p1, t) => [0, 1].map(k => 2 * (1 - t) * (c[k] - p0[k]) + 2 * t * (p1[k] - c[k]));
const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------- the collision surface as a height lookup
function heightField(C) {
  const V = C.vertices, tris = [], cell = 40, grid = new Map();
  for (const s of C.sections) for (const t of [...s.surface, ...s.B, ...s.apron]) if (t.plane.every(x => typeof x === "number") && t.plane[2]) tris.push(t);
  tris.forEach((t, i) => { const xs = t.v.map(k => V[k].x), ys = t.v.map(k => V[k].y);
    for (let gx = Math.floor(Math.min(...xs) / cell); gx <= Math.floor(Math.max(...xs) / cell); gx++) for (let gy = Math.floor(Math.min(...ys) / cell); gy <= Math.floor(Math.max(...ys) / cell); gy++) { const k = gx * 100003 + gy; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); } });
  return (x, y) => { for (const i of grid.get(Math.floor(x / cell) * 100003 + Math.floor(y / cell)) ?? []) { const t = tris[i], [a, b, c] = t.v.map(k => V[k]);
    const d = (p, q) => (q.x - p.x) * (y - p.y) - (q.y - p.y) * (x - p.x), d1 = d(a, b), d2 = d(b, c), d3 = d(c, a);
    if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) return -(t.plane[3] + t.plane[0] * x + t.plane[1] * y) / t.plane[2]; } return null; };
}

// The starting grid from the track's own (nr2003-track.mjs layout.grid: per car [x, y, heading] in feet / radians,
// pole first, inside / outside alternating as the game's): spot table 0 (44 places; past the track's own the rows go
// on at its spacing) and table 6 (the pace car's). Height: the new surface, keeping the spot's own height above it;
// orientation: the mapped spot's turned to the heading; section: the one whose triangle is under it.
function setGrid(nd, grid, log) {
  const C = nd.collision, V = C.vertices, cell = 40, idx = new Map(), list = [];
  C.sections.forEach((sec, si) => { for (const t of [...sec.surface, ...sec.B, ...sec.apron]) if (t.plane.every(x => typeof x === "number") && t.plane[2]) list.push({ t, si }); });
  list.forEach((e, i) => { const xs = e.t.v.map(k => V[k].x), ys = e.t.v.map(k => V[k].y);
    for (let gx = Math.floor(Math.min(...xs) / cell); gx <= Math.floor(Math.max(...xs) / cell); gx++) for (let gy = Math.floor(Math.min(...ys) / cell); gy <= Math.floor(Math.max(...ys) / cell); gy++) { const k = gx * 100003 + gy; if (!idx.has(k)) idx.set(k, []); idx.get(k).push(i); } });
  const under = (x, y) => { for (const i of idx.get(Math.floor(x / cell) * 100003 + Math.floor(y / cell)) ?? []) { const { t, si } = list[i], [a, b, c] = t.v.map(k => V[k]);
    const d = (p, q) => (q.x - p.x) * (y - p.y) - (q.y - p.y) * (x - p.x), d1 = d(a, b), d2 = d(b, c), d3 = d(c, a);
    if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) return { z: -(t.plane[3] + t.plane[0] * x + t.plane[1] * y) / t.plane[2], section: si }; } return null; };
  const place = (sp, [x, y, h]) => { const u = under(x, y), u0 = under(sp.pos[0], sp.pos[1]); if (!u) return sp;
    const ax = sp.axes.map(Number), cur = Math.atan2(ax[1], ax[0]), turn = h - cur, r = v => rot2(v, turn);
    return { ...sp, pos: [x, y, u.z + (u0 ? sp.pos[2] - u0.z : 0)], axes: [...r(ax.slice(0, 3)), ...r(ax.slice(3, 6)), ...ax.slice(6, 9)], section: u.section }; };
  const cars = grid.cars.slice(), T0 = nd.spots[0];
  while (cars.length < T0.length && cars.length >= 3) { const a = cars.at(-1), b = cars.at(-3); cars.push([2 * a[0] - b[0], 2 * a[1] - b[1], a[2]]); }
  nd.spots[0] = T0.map((sp, i) => cars[i] ? place(sp, cars[i]) : sp);
  if (grid.pace && nd.spots[6]?.length) nd.spots[6] = nd.spots[6].map(sp => place(sp, grid.pace));
  log.push(`starting grid: ${grid.cars.length} places from the track${grid.pace ? " and the pace car's" : ""}`);
}

// ---------------------------------------------------------------- frames: a centreline sampled every ~2 ft
// { n, X, Y, Z, TX, TY, K (signed curvature, + = turning left), EIN / EOUT (racing surface edges from the centre,
//   right positive), SL (cross slope: dz per ft to the right), len }
function resample(px, py, extra, step = 2) {          // closed polyline -> uniform samples
  const n = px.length, cum = [0]; for (let i = 1; i <= n; i++) cum.push(cum[i - 1] + Math.hypot(px[i % n] - px[i - 1], py[i % n] - py[i - 1]));
  const len = cum[n], m = Math.max(64, Math.round(len / step)), out = { n: m, len, X: [], Y: [] }; for (const k of Object.keys(extra)) out[k] = [];
  let j = 0; for (let i = 0; i < m; i++) { const s = len * i / m; while (cum[j + 1] < s) j++; const t = (s - cum[j]) / ((cum[j + 1] - cum[j]) || 1), a = j, b = (j + 1) % n;
    out.X.push(lerp(px[a], px[b], t)); out.Y.push(lerp(py[a], py[b], t)); for (const [k, arr] of Object.entries(extra)) out[k].push(lerp(arr[a], arr[b], t)); }
  return out;
}
function finishFrame(F, smooth = 0) {
  const n = F.n, w = (a, i) => a[((i % n) + n) % n];
  for (let pass = 0; pass < smooth; pass++) for (const key of ["X", "Y"]) { const a = F[key]; F[key] = a.map((_, i) => (w(a, i - 2) + w(a, i - 1) * 2 + w(a, i) * 3 + w(a, i + 1) * 2 + w(a, i + 2)) / 9); }
  F.TX = []; F.TY = []; F.K = []; F.H = [];
  for (let i = 0; i < n; i++) { const dx = w(F.X, i + 1) - w(F.X, i - 1), dy = w(F.Y, i + 1) - w(F.Y, i - 1), l = Math.hypot(dx, dy) || 1; F.TX.push(dx / l); F.TY.push(dy / l); F.H.push(Math.atan2(dy, dx)); }
  const step = F.len / n; for (let i = 0; i < n; i++) { let dh = w(F.H, i + 3) - w(F.H, i - 3); while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI; F.K.push(dh / (6 * step)); }
  // room on each side: half the distance to the centreline's other parts ahead along the normal (within 45 degrees),
  // ROOML on the left (the infield of a counter-clockwise track), ROOMR on the right; 5000 ft when open
  F.ROOML = []; F.ROOMR = []; const sep = Math.max(150, F.len * 0.02) / step, J = Math.max(1, Math.round(4 / step));
  for (let i = 0; i < n; i++) { let rl = 1e4, rr = 1e4; const tx = F.TX[i], ty = F.TY[i];
    for (let j = 0; j < n; j += J) { let di = Math.abs(j - i); di = Math.min(di, n - di); if (di < sep) continue;
      const vx = F.X[j] - F.X[i], vy = F.Y[j] - F.Y[i], along = vx * -ty + vy * tx, lat = Math.abs(vx * tx + vy * ty), dist = Math.hypot(vx, vy);
      if (along > 0 && lat < along) rl = Math.min(rl, dist); else if (along < 0 && lat < -along) rr = Math.min(rr, dist); }
    F.ROOML.push(Math.min(5000, rl / 2)); F.ROOMR.push(Math.min(5000, rr / 2)); }
  return F;
}
const at = (F, key, s) => { const f = ((s % 1) + 1) % 1 * F.n, i = Math.floor(f), t = f - i; return lerp(F[key][i], F[key][(i + 1) % F.n], t); };
const headingAt = (F, s) => Math.atan2(at(F, "TY", s), at(F, "TX", s));

// the base track's centre: the middle of the racing surface, from the racing line and its profile arrays
function baseFrame(doc, zAt) {
  const R = doc.lines.lines.find(l => l.group === 0), K = 16, px = [], py = [], ex = { EIN: [], EOUT: [], WIN: [], WOUT: [] };
  R.segments.forEach((sg, i) => { const [p0, c, p1] = [R.points[2 * i], R.points[2 * i + 1], R.points[2 * i + 2]];
    for (let k = 0; k < K; k++) { const t = k / K, p = bez(p0, c, p1, t), d = bezD(p0, c, p1, t), l = Math.hypot(...d), nx = d[1] / l, ny = -d[0] / l;   // right normal
      const f = 7 * i + 7 * t, j = Math.floor(f), u = f - j, pr = a => lerp(R.profile[a][j], R.profile[a][Math.min(j + 1, R.profile[a].length - 1)], u) / 12;
      const ein = pr(1), eout = pr(2), mid = (ein + eout) / 2; px.push(p[0] + nx * mid); py.push(p[1] + ny * mid); ex.EIN.push(ein - mid); ex.EOUT.push(eout - mid);
      ex.WIN.push(Math.min(pr(5), ein) - mid); ex.WOUT.push(Math.max(pr(6), eout) - mid); } });
  const F = finishFrame(resample(px, py, ex), 3);
  F.Z = []; F.SL = [];
  for (let i = 0; i < F.n; i++) { const nx = F.TY[i], ny = -F.TX[i], h = Math.max(4, Math.min(15, 0.6 * Math.min(-F.EIN[i], F.EOUT[i])));
    const zc = zAt(F.X[i], F.Y[i]), zl = zAt(F.X[i] - nx * h, F.Y[i] - ny * h), zr = zAt(F.X[i] + nx * h, F.Y[i] + ny * h);
    F.Z.push(zc ?? R.points[0][2]); F.SL.push(zl !== null && zr !== null ? (zr - zl) / (2 * h) : 0); }
  // nearest-sample grid
  F.cell = 60; F.grid = new Map(); for (let i = 0; i < F.n; i++) { const k = Math.floor(F.X[i] / F.cell) * 100003 + Math.floor(F.Y[i] / F.cell); if (!F.grid.has(k)) F.grid.set(k, []); F.grid.get(k).push(i); }
  F.zAt = zAt;
  // pit road's far side (PFAR, from the centre; NaN where the base has no pit road): the pit lanes (line group 11),
  // the per-stall paths (9 / 10) and the pit-stall triangles (apron type 3), 4 ft beyond the farthest of them
  { const near = (x, y) => { let best = -1, bd = Infinity; const gx = Math.floor(x / F.cell), gy = Math.floor(y / F.cell);
      for (let ix = gx - 2; ix <= gx + 2; ix++) for (let iy = gy - 2; iy <= gy + 2; iy++) for (const i of F.grid.get(ix * 100003 + iy) ?? []) { const d2 = (F.X[i] - x) ** 2 + (F.Y[i] - y) ** 2; if (d2 < bd) { bd = d2; best = i; } }
      if (best < 0) for (let i = 0; i < F.n; i++) { const d2 = (F.X[i] - x) ** 2 + (F.Y[i] - y) ** 2; if (d2 < bd) { bd = d2; best = i; } }
      return [best, (x - F.X[best]) * F.TY[best] - (y - F.Y[best]) * F.TX[best]]; };
    const far = new Array(F.n).fill(Infinity), put = (x, y) => { const [i, d] = near(x, y); if (d < F.WIN[i] + 1) far[i] = Math.min(far[i], d); };
    for (const l of doc.lines.lines) if ([9, 10, 11].includes(l.group)) for (let k = 0; k + 1 < l.points.length; k++) { const a = l.points[k], b = l.points[k + 1], m = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4)); for (let j = 0; j < m; j++) put(lerp(a[0], b[0], j / m), lerp(a[1], b[1], j / m)); }
    const V = doc.collision.vertices; for (const sec of doc.collision.sections) for (const t of sec.apron) if (t.type === 3) for (const k of t.v) put(V[k].x, V[k].y);
    // Along the stalls the far side is the wall behind them (the base's stops sit ~8 ft short of it): the new track's
    // far side (layout pit.far: its own wall behind the stalls) then takes that wall, and the stops land as far short
    // of it as the track's own stalls (before, with the far side 15-50 ft past that wall, Milwaukee's stops came out
    // 12 ft short of its stall row and the base's wall 15 ft short of its armco).
    { const stop = new Array(F.n).fill(Infinity); for (const l of doc.lines.lines) if (l.group === 9) { const [i, d] = near(...l.points.at(-1)); stop[i] = Math.min(stop[i], d); }
      const ws = Math.round(60 / (F.len / F.n)), row = stop.map((_, i) => { let m = Infinity; for (let j = -ws; j <= ws; j++) m = Math.min(m, stop[(i + j + F.n) % F.n]); return m; });
      const P = doc.collision.points, seen = new Set(), wall = new Array(F.n).fill(-Infinity);
      for (const sec of doc.collision.sections) for (const wl of sec.walls?.inner ?? []) { const k = wl.top.join(); if (seen.has(k)) continue; seen.add(k);
        const a = P[wl.top[0]], b = P[wl.top[1]]; if (!a || !b) continue; const ax = a.x ?? a[0], ay = a.y ?? a[1], bx = b.x ?? b[0], by = b.y ?? b[1], m = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 3));
        for (let j = 0; j <= m; j++) { const [i, d] = near(lerp(ax, bx, j / m), lerp(ay, by, j / m)); if (Number.isFinite(row[i]) && d < row[i] - 1 && d > row[i] - 40) wall[i] = Math.max(wall[i], d); } }
      F.SWALL = wall; }
    // (the farthest within 150 ft either way, then averaged over 300 ft: within 30 ft it followed each stall's loop in
    // and out, and the mapping's scale across pit road with it: the warped stall paths and pit lanes wobbled 10-20 ft)
    const w = Math.round(150 / (F.len / F.n)), raw = far.map((_, i) => { let m = Infinity; for (let j = -w; j <= w; j++) m = Math.min(m, far[(i + j + F.n) % F.n]); return m === Infinity ? NaN : m - 4; });
    { const W = F.SWALL, wa = Math.round(60 / (F.len / F.n)); for (let i = 0; i < F.n; i++) { let a = 0, c = 0; for (let j = -wa; j <= wa; j++) { const u = W[(i + j + F.n) % F.n]; if (u > -Infinity) { a += u; c++; } } if (c) raw[i] = a / c; } delete F.SWALL; }
    F.PFAR = raw.map((v, i) => { if (!Number.isFinite(v)) return NaN; let a = 0, c = 0; for (let j = -w; j <= w; j++) { const u = raw[(i + j + F.n) % F.n]; if (Number.isFinite(u)) { a += u; c++; } } return a / c; });
    // where the base's pit road ends (PFAR NaN) the pit road mapping eases out over 200 ft (PFARX: the nearest known far
    // side, PFW: 1 on pit road, down to 0): it stopped at once before, and the base's points there jumped up to 30 ft
    // sideways between neighbours (Milwaukee's pit exit: zigzag walls and stall paths, a car leaving its stall stuck)
    const fade = Math.round(200 / (F.len / F.n)), have = F.PFAR.map(Number.isFinite), dist = new Array(F.n).fill(Infinity), src = new Array(F.n).fill(-1);
    for (let pass = 0; pass < 2; pass++) for (let k = 0; k < 2 * F.n; k++) { const i = pass ? (2 * F.n - 1 - k) % F.n : k % F.n, j = pass ? (i + 1) % F.n : (i - 1 + F.n) % F.n;
      if (have[i]) { dist[i] = 0; src[i] = i; } else if (dist[j] + 1 < dist[i]) { dist[i] = dist[j] + 1; src[i] = src[j]; } }
    F.PFARX = F.PFAR.map((v, i) => have[i] ? v : dist[i] <= fade ? F.PFAR[src[i]] : NaN);
    F.PFW = F.PFAR.map((v, i) => { if (have[i]) return 1; if (dist[i] > fade) return 0; const t = dist[i] / fade; return 1 - t * t * (3 - 2 * t); }); }
  return F;
}
function layoutFrame(L, base) {
  const P = L.points, n = P.length, cr = (a, b, c, d, t) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
  const auto = L.bank === undefined || L.bank === "auto", per = v => Array.isArray(v) ? v : Array(n).fill(v), bank = per(auto ? 0 : L.bank), zz = per(L.z ?? base.Z.reduce((a, b) => a + b, 0) / base.n);
  const px = [], py = [], ex = { B: [], Z: [] }, sub = 24;
  // the model's widths (centrelineFromGLTF): road edges and walls either side, per point (null: not known)
  const W = { EIN: L.edges?.in, EOUT: L.edges?.out, WIN: L.walls?.in, WOUT: L.walls?.out }, wk = Object.keys(W).filter(k => Array.isArray(W[k]) && W[k].some(v => v !== null));
  const fill = a => { const known = a.map((v, i) => v === null || v === undefined ? null : i).filter(v => v !== null); return a.map((v, i) => v ?? a[known.reduce((bi, k) => Math.abs(k - i) < Math.abs(bi - i) ? k : bi, known[0])]); };
  for (const k of wk) { W[k] = fill(W[k]); ex[k] = []; }
  // the model's pit road (a mesh named like "pit"): its far side per point, NaN where it has none (not filled)
  const pitFar = Array.isArray(L.pit?.far) && L.pit.far.some(v => v !== null) ? L.pit.far.map(v => v ?? NaN) : null; if (pitFar) { W.PFAR = pitFar; ex.PFAR = []; }
  // a racing line of its own (nr2003-track.mjs: the track's raceline.lp), sideways distance per point (right +); used only
  // with layoutOptions.useRaceline: at Milwaukee it changed nothing, at Wilkesboro the field did worse on it (32 vs 37
  // of 43 past 0.9 laps in 90 s; the lanes and AI speeds stay the base track's, warped)
  const RLA = Array.isArray(L.raceline) && L.raceline.length === n, RL = RLA ? L.raceline : null; if (RL) ex.RL = [];
  const AIV = Array.isArray(L.aiSpeed) && L.aiSpeed.length === n ? L.aiSpeed : null; if (AIV) ex.AIV = [];
  for (let i = 0; i < n; i++) { const a = P[(i - 1 + n) % n], b = P[i], c = P[(i + 1) % n], d = P[(i + 2) % n];
    for (let k = 0; k < sub; k++) { const t = k / sub; px.push(cr(a[0], b[0], c[0], d[0], t)); py.push(cr(a[1], b[1], c[1], d[1], t)); ex.B.push(lerp(bank[i], bank[(i + 1) % n], t)); ex.Z.push(lerp(zz[i], zz[(i + 1) % n], t));
      for (const key of wk) ex[key].push(lerp(W[key][i], W[key][(i + 1) % n], t)); if (pitFar) ex.PFAR.push(lerp(pitFar[i], pitFar[(i + 1) % n], t)); if (RL) ex.RL.push(lerp(RL[i], RL[(i + 1) % n], t)); if (AIV) ex.AIV.push(lerp(AIV[i], AIV[(i + 1) % n], t)); } }
  const F = finishFrame(resample(px, py, ex), 1); F.widths = wk; F.groundAt = L.groundAt ?? null; F.groundGrid = !!L.ground?.z; F.hasRL = !!(RL && L.useRaceline); F.lanesOnRL = !!RL && L.aiLanesFromRaceline !== false; F.pitWall = L.pitWall ?? null; F.hideBase = L.hideBaseObjects; F.hasAIV = !!AIV;
  // the pit road's far side as the mapper uses it: the model's where it has one, faded over 200 ft to the plain
  // shifted position (nwin + base distance past its pit wall) where it has none, NaN where the base has no pit road
  if (pitFar) { const P2 = F.PFAR, fade = Math.round(200 / (F.len / F.n)), have = P2.map(Number.isFinite), dist = new Array(F.n).fill(Infinity), src = new Array(F.n).fill(-1);
    for (let pass = 0; pass < 2; pass++) for (let k = 0; k < 2 * F.n; k++) { const i = pass ? (2 * F.n - 1 - k) % F.n : k % F.n, j = pass ? (i + 1) % F.n : (i - 1 + F.n) % F.n;
      if (have[i]) { dist[i] = 0; src[i] = i; } else if (dist[j] + 1 < dist[i]) { dist[i] = dist[j] + 1; src[i] = src[j]; } }
    F.PITN = P2.map((v, i) => have[i] ? v : dist[i] <= fade ? { from: P2[src[i]], f: dist[i] / fade } : null); }
  // "auto" banking: straights bankStraight (default 5 degrees), turns up to bankTurn (default 20) by curvature
  if (auto) { const st = L.bankStraight ?? 5, tu = L.bankTurn ?? 20, raw = F.K.map(k => st + (tu - st) * Math.min(1, Math.abs(k) * 700)), w = 60;
    F.B = raw.map((_, i) => { let a = 0; for (let j = -w; j <= w; j++) a += raw[(i + j + F.n) % F.n]; return a / (2 * w + 1); }); }
  F.SL = F.B.map(b => Math.tan(b * Math.PI / 180)); return F;
}

// The AI's race lanes (line group 1: the main lane, then two more) on the track's own racing line (layout.raceline,
// NR2003 raceline.lp). Warped, they kept the base's line relative to its track: Lowe's dives in and out across its
// dogleg front stretch, and on Milwaukee's straight front stretch the lanes cut in and out by up to 40 ft. Now the
// first lane is the track's racing line and the others keep their distance from the first (the base's, averaged over
// 300 ft either way), inside the road's edges (layout.aiLanesFromRaceline: false keeps the warped lanes).
function lanesOnRaceline(lines, N, M) {
  const G = new Map(), cell = 60; for (let i = 0; i < N.n; i++) { const k = Math.floor(N.X[i] / cell) * 100003 + Math.floor(N.Y[i] / cell); if (!G.has(k)) G.set(k, []); G.get(k).push(i); }
  const loc = (x, y) => { let best = -1, bd = Infinity; const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    for (let r = 0; r < 20 && (best < 0 || r < 2); r++) for (let ix = gx - r; ix <= gx + r; ix++) for (let iy = gy - r; iy <= gy + r; iy++) { if (Math.max(Math.abs(ix - gx), Math.abs(iy - gy)) !== r) continue;
      for (const i of G.get(ix * 100003 + iy) ?? []) { const d2 = (N.X[i] - x) ** 2 + (N.Y[i] - y) ** 2; if (d2 < bd) { bd = d2; best = i; } } }
    return { i: best, s: best / N.n, d: (x - N.X[best]) * N.TY[best] - (y - N.Y[best]) * N.TX[best] }; };
  const lanes = lines.filter(l => l.group === 1); if (lanes.length < 1) return;
  // each lane's sideways distance per frame sample (from its curve, sampled finely)
  const bz = (a, c, b, t) => [0, 1, 2].map(j => (1 - t) ** 2 * a[j] + 2 * (1 - t) * t * c[j] + t * t * b[j]);
  const profile = l => { const D = new Array(N.n).fill(NaN); l.segments.forEach((_, i) => { for (let q = 0; q < 16; q++) { const p = bz(l.points[2 * i], l.points[2 * i + 1], l.points[2 * i + 2], q / 16), r = loc(p[0], p[1]); D[r.i] = r.d; } });
    const known = D.map((v, i) => Number.isFinite(v) ? i : -1).filter(i => i >= 0); if (!known.length) return null;
    for (let k = 0; k < known.length; k++) { const a = known[k], b = known[(k + 1) % known.length], gap = (b - a + N.n) % N.n; for (let j = 1; j < gap; j++) D[(a + j) % N.n] = lerp(D[a], D[b], j / gap); } return D; };
  const P = lanes.map(profile); if (P.some(p => !p)) return;
  const w = Math.round(300 / (N.len / N.n)), smooth = A => { const c = [0]; for (let i = 0; i < 2 * N.n + 2 * w + 2; i++) c.push(c[i] + A[(i - w - 1 + 2 * N.n) % N.n]); return A.map((_, i) => (c[i + 2 * w + 1] - c[i]) / (2 * w + 1)); };
  const OFF = P.map(p => smooth(p.map((v, i) => v - P[0][i])));
  const ein = N.widths.includes("EIN") ? N.EIN : null, eout = N.widths.includes("EOUT") ? N.EOUT : null;
  lanes.forEach((l, k) => { l.points = l.points.map(p => { const r = loc(p[0], p[1]), i = r.i; let d = N.RL[i] + OFF[k][i];
    if (ein) d = Math.max(ein[i] + 4, d); if (eout) d = Math.min(eout[i] - 4, d);
    return [N.X[i] + N.TY[i] * d, N.Y[i] - N.TX[i] * d, p[2] + N.SL[i] * (d - r.d)]; }); });
}

// The track's pit wall (layout.pitWall, nr2003-track.mjs: runs of [x, y, d] along a wall between the racing surface and
// the stalls) as a free-standing wall, the way stock tracks build theirs (Atlanta, Bristol...: TK_PHYS "other" walls):
// a closed loop 1 ft thick, each face a wall segment (top / bottom points, a vertical plane whose normal points out of
// the loop: left of the direction of travel), kind 10, 3.3 ft high, linked into a ring (z20 = section << 16 | index of
// the segment ending where this one starts, (c, a) = section / index of the one starting where it ends), each listed in
// every section whose end planes take it in. Where the warped base already has a wall within 8 ft (Wilkesboro's turns 3
// and 4: its inside wall) none is added, nor pieces under 100 ft (stubs beside a wall snag cars). Without it cars drove through Milwaukee's pit wall (Lowe's has grass there).
function addPitWall(C, runs, N, lines, log = () => {}) {
  const P = C.points, cell = 20, near = new Map(), key = (x, y) => Math.floor(x / cell) * 100003 + Math.floor(y / cell), seen = new Set();
  for (const sec of C.sections) for (const list of Object.values(sec.walls ?? {})) for (const w of list) { const k = w.top.join(); if (seen.has(k)) continue; seen.add(k);
    const a = P[w.top[0]], b = P[w.top[1]], m = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2));
    for (let j = 0; j <= m; j++) { const x = lerp(a[0], b[0], j / m), y = lerp(a[1], b[1], j / m), kk = key(x, y); if (!near.has(kk)) near.set(kk, []); near.get(kk).push([x, y]); } }
  const covered = (x, y) => { const gx = Math.floor(x / cell), gy = Math.floor(y / cell); for (let i = gx - 1; i <= gx + 1; i++) for (let j = gy - 1; j <= gy + 1; j++) for (const q of near.get(i * 100003 + j) ?? []) if (Math.hypot(q[0] - x, q[1] - y) < 8) return true; return false; };
  let nearest = null; { const G = new Map(), c2 = 60; for (let i = 0; i < N.n; i++) { const k = Math.floor(N.X[i] / c2) * 100003 + Math.floor(N.Y[i] / c2); if (!G.has(k)) G.set(k, []); G.get(k).push(i); }
    nearest = (x, y) => { let best = 0, bd = Infinity; const gx = Math.floor(x / c2), gy = Math.floor(y / c2); for (let i = gx - 2; i <= gx + 2; i++) for (let j = gy - 2; j <= gy + 2; j++) for (const q of G.get(i * 100003 + j) ?? []) { const d2 = (N.X[q] - x) ** 2 + (N.Y[q] - y) ** 2; if (d2 < bd) { bd = d2; best = q; } } return best; }; }
  // openings: the warped pit lines (groups 3-11: in / out lines, stall paths, pit lanes) cross where the base's pit road
  // opens, which need not be where the track's wall ends (Milwaukee's exit end, all of Wilkesboro's, whose pit road
  // stays at the base's place): the wall is left out within 15 ft of each crossing
  const cuts = []; { const bz = (a, c, b, t) => [0, 1].map(j => (1 - t) ** 2 * a[j] + 2 * (1 - t) * t * c[j] + t * t * b[j]), dd = (u, v, w) => (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]);
    const segsW = runs.flatMap(r => r.slice(1).map((p, k) => [r[k], p]));
    for (const l of lines) { if (l.group < 3 || l.group > 11) continue; for (let i = 0; i < l.segments.length; i++) { let prev = bz(l.points[2 * i], l.points[2 * i + 1], l.points[2 * i + 2], 0);
      for (let q = 1; q <= 8; q++) { const cur = bz(l.points[2 * i], l.points[2 * i + 1], l.points[2 * i + 2], q / 8);
        for (const [a, b] of segsW) if (dd(prev, cur, a) * dd(prev, cur, b) < 0 && dd(a, b, prev) * dd(a, b, cur) < 0) cuts.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
        prev = cur; } } } }
  const cut = (x, y) => cuts.some(c => Math.hypot(c[0] - x, c[1] - y) < 15);
  const parts = []; for (const run of runs) { let cur = []; for (const p of run) { if (covered(p[0], p[1]) || cut(p[0], p[1])) { if (cur.length >= 3) parts.push(cur); cur = []; } else cur.push(p); } if (cur.length >= 3) parts.push(cur); }
  for (let k = parts.length - 1; k >= 0; k--) { const r = parts[k]; let l = 0; for (let j = 1; j < r.length; j++) l += Math.hypot(r[j][0] - r[j - 1][0], r[j][1] - r[j - 1][1]); if (l < 100) parts.splice(k, 1); }
  const inSec = (sec, x, y) => { const t = pl => pl[0] * x + pl[1] * y + pl[3] >= -2, b = sec.bounds; return t(sec.start) && t(sec.end) && x >= b[0] - 30 && x <= b[2] + 30 && y >= b[1] - 30 && y <= b[3] + 30; };
  let segs = 0, len = 0;
  for (const run of parts) {
    const n = run.length, R = [], L = [];
    for (let k = 0; k < n; k++) { const a = run[Math.max(0, k - 1)], b = run[Math.min(n - 1, k + 1)], tx = b[0] - a[0], ty = b[1] - a[1], m = Math.hypot(tx, ty) || 1, rx = ty / m, ry = -tx / m;
      const i = nearest(run[k][0], run[k][1]), z = N.Z[i] + N.SL[i] * run[k][2];
      R.push([run[k][0] + rx * 0.5, run[k][1] + ry * 0.5, z]); L.push([run[k][0] - rx * 0.5, run[k][1] - ry * 0.5, z]); len += k ? Math.hypot(run[k][0] - run[k - 1][0], run[k][1] - run[k - 1][1]) : 0; }
    const V = [...R.slice().reverse(), ...L];                     // the loop: back along the right face, across, along the left face, across
    const top = V.map(v => { P.push([v[0], v[1], v[2] + 3.3]); return P.length - 1; }), bot = V.map(v => { P.push([v[0], v[1], v[2] - 0.5]); return P.length - 1; });
    const m = V.length, place = [];
    for (let j = 0; j < m; j++) { const a = V[j], b = V[(j + 1) % m], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1, nx = -dy / l, ny = dx / l;
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2; let secs = C.sections.map((s, si) => inSec(s, mx, my) ? si : -1).filter(si => si >= 0);
      if (!secs.length) { let bi = 0, bd = Infinity; C.sections.forEach((s, si) => { const cx = (s.bounds[0] + s.bounds[2]) / 2, cy = (s.bounds[1] + s.bounds[3]) / 2, d = (cx - mx) ** 2 + (cy - my) ** 2; if (d < bd) { bd = d; bi = si; } }); secs = [bi]; }
      const w = { top: [top[j], top[(j + 1) % m]], bottom: [bot[j], bot[(j + 1) % m]], plane: [nx, ny, 0, -(nx * mx + ny * my)], topZ: Math.max(a[2], b[2]) + 3.3, kind: 10, z20: 0, a: 0, c: 0 };
      const at = secs.map(si => { const sec = C.sections[si]; sec.walls.other ??= []; sec.walls.other.push(w); return [si, sec.walls.other.length - 1]; });
      place.push({ w, at }); segs++; }
    // links (to each segment's first copy; the copies share one object)
    for (let j = 0; j < m; j++) { const prev = place[(j - 1 + m) % m].at[0], next = place[(j + 1) % m].at[0]; place[j].w.z20 = (prev[0] << 16 | prev[1]) >>> 0; place[j].w.c = next[0]; place[j].w.a = next[1]; }
  }
  // copies are separate records in the file (idx / sec written per copy): clone the shared objects
  for (const sec of C.sections) if (sec.walls.other) sec.walls.other = sec.walls.other.map(w => ({ ...w }));
  if (segs) log(`pit wall: ${parts.length} run${parts.length > 1 ? "s" : ""}, ${len.toFixed(0)} ft (${segs} wall segments)`);
}

// ---------------------------------------------------------------- the mapping
// remap: the base's lap fraction -> the new layout's. Plainly the same; with the new track's pit road (layout.pitLane,
// nr2003-track.mjs from track.ini) piecewise linear through (0, 0) and the two ends of pit road, the base's (its pit
// lanes, line group 11) to the new one's: the base's pit road, stalls, stall paths, pit lanes and pit in / out lines
// land where the new track has its pits (Lowe's 0.864..0.109 -> Milwaukee 0.849..0.108, Wilkesboro 0.599..0.138).
// The starting grid comes along stretched: it is set from the track's own (layout.grid) after.
function makeMapper(B, N) {
  const remap = { f: s => s };
  const locate = (x, y) => {                           // -> { s, d } on the base centre
    let best = -1, bd = Infinity; const gx = Math.floor(x / B.cell), gy = Math.floor(y / B.cell);
    for (let r = 0; r < 40 && (best < 0 || r < 2 + Math.ceil(Math.sqrt(bd) / B.cell)); r++) for (let ix = gx - r; ix <= gx + r; ix++) for (let iy = gy - r; iy <= gy + r; iy++) {
      if (Math.max(Math.abs(ix - gx), Math.abs(iy - gy)) !== r) continue;
      for (const i of B.grid.get(ix * 100003 + iy) ?? []) { const d2 = (B.X[i] - x) ** 2 + (B.Y[i] - y) ** 2; if (d2 < bd) { bd = d2; best = i; } } }
    if (best < 0) for (let i = 0; i < B.n; i++) { const d2 = (B.X[i] - x) ** 2 + (B.Y[i] - y) ** 2; if (d2 < bd) { bd = d2; best = i; } }   // far away: every sample
    let s = best, bd2 = Infinity, d = 0;
    for (const j of [best - 1, best]) { const a = (j + B.n) % B.n, b = (a + 1) % B.n, ex = B.X[b] - B.X[a], ey = B.Y[b] - B.Y[a], l2 = ex * ex + ey * ey || 1;
      const t = Math.max(0, Math.min(1, ((x - B.X[a]) * ex + (y - B.Y[a]) * ey) / l2)), dd = (x - B.X[a] - ex * t) ** 2 + (y - B.Y[a] - ey * t) ** 2; if (dd < bd2) { bd2 = dd; s = a + t; } }
    const sf = s / B.n, tx = at(B, "TX", sf), ty = at(B, "TY", sf); d = (x - at(B, "X", sf)) * ty - (y - at(B, "Y", sf)) * tx;   // right positive
    return { s: sf, d };
  };
  const comp = (x, lim) => x < 0.6 * lim ? x : 0.6 * lim + 0.4 * lim * Math.tanh((x - 0.6 * lim) / (0.4 * lim));
  const map = (x, y, z) => {
    const { s: s0, d: d0 } = locate(x, y), sN = remap.f(s0), s = s0, ein = at(B, "EIN", s), eout = at(B, "EOUT", s), clampB = Math.max(ein, Math.min(eout, d0));
    const rel = z - (at(B, "Z", s) + at(B, "SL", s) * clampB);
    // sideways: with the model's widths, the base's racing-surface edges go to the model's road edges (the outside one
    // to its outside wall when it has one: the base's outside wall stands at its edge), its inside wall to the model's
    // inside wall; between them linearly, beyond them shifted
    let d = d0, nin = ein, nout = eout, keep = 0;
    if (N.widths.length) { const has = k => N.widths.includes(k), win = at(B, "WIN", s);
      nin = has("EIN") ? at(N, "EIN", sN) : ein; nout = has("WOUT") ? at(N, "WOUT", sN) : has("EOUT") ? at(N, "EOUT", sN) : eout;
      const nwin = has("WIN") ? Math.min(at(N, "WIN", sN), nin - 1) : nin + (win - ein);
      if (d0 >= eout) d = nout + (d0 - eout); else if (d0 >= ein) d = nin + (d0 - ein) * (nout - nin) / ((eout - ein) || 1);
      else if (d0 >= win && ein - win > 1) d = nwin + (d0 - win) * (nin - nwin) / (ein - win);
      else { d = nwin + (d0 - win);
        // the base's pit road (past its pit wall) to the model's pit road
        const pb = at(B, "PFARX", s), wb = at(B, "PFW", s); if (N.PITN && Number.isFinite(pb) && pb < win - 1) { const e = N.PITN[Math.round(((sN % 1) + 1) % 1 * N.n) % N.n];
          const pn0 = e === null ? null : typeof e === "number" ? e : lerp(e.from, nwin + (pb - win), e.f), pn = pn0 === null ? null : lerp(nwin + (pb - win), pn0, wb);
          if (pn !== null && pn < nwin - 1) { d = d0 >= pb ? nwin + (d0 - win) * (pn - nwin) / (pb - win) : pn + (d0 - pb); keep = Math.max(keep, -pn); } } } }
    const clampN = Math.max(nin, Math.min(nout, d));
    // sideways offsets beyond the track keep inside the room the new layout has on that side (half the way across
    // the infield, and short of the centre of curvature in turns): scaled from the base's room, then squeezed
    const k = at(N, "K", sN), side = d < 0 ? "ROOML" : "ROOMR"; let dd = d;
    { let rn = at(N, side, sN); if (d < 0 && k > 1e-5) rn = Math.min(rn, 0.92 / k); else if (d > 0 && k < -1e-5) rn = Math.min(rn, 0.92 / -k);
      const rb = Math.max(at(B, side, s), 1), a = Math.max(Math.min(150, 0.4 * rn), Math.min(keep + 10, 0.8 * rn)); let ad = Math.abs(d);
      if (ad > a && rb > rn) ad = a + (ad - a) * (rn - a) / (rb - a);
      ad = comp(ad, 0.97 * rn); dd = Math.sign(d) * ad; }
    const tx = at(N, "TX", sN), ty = at(N, "TY", sN), px = at(N, "X", sN) + ty * dd, py = at(N, "Y", sN) - tx * dd; let pz = at(N, "Z", sN) + at(N, "SL", sN) * clampN + rel;
    // off the model's road on the inside (apron, pit road, infield; the outside past a modelled outside wall is out of
    // reach, and its ground would pull the road's edge triangles down): the model's own ground (any mesh but walls);
    // what stood above the base's ground stands as high above it
    // (from half a foot past the road's edge, blended in over the next 3 ft: points at the edge itself, which the
    // racing surface's wide triangles share, stay on the road)
    const off = Math.max(nin - d, N.widths.includes("WOUT") ? 0 : d - nout);
    // (a ground grid from the track's own height profile, nr2003-track.mjs, is exact at the edge: it takes over at once,
    // else the base's apron shape (Lowe's drops off its banking) left a dip along the inside edge where cars spun)
    const g0 = N.groundGrid ? 0.05 : 0.5, gw = N.groundGrid ? 0.5 : 3;
    if (N.groundAt && off > g0) { const zb = B.zAt?.(x, y);
      if (zb !== null && zb !== undefined) { const gF = pz - (z - zb), gs = N.groundAt(px, py); let best = null;
        // the highest model surface within 8 ft of where the base's ground would go (not a roof, not a ground plane
        // far below a road the model leaves floating: then the base's shape stays)
        for (const g of gs) if (Math.abs(g - gF) <= 8 && (best === null || g > best)) best = g;
        if (best !== null) pz = lerp(pz, best + (z - zb), Math.min(1, (off - g0) / gw)); } }
    return { p: [px, py, pz], rot: headingAt(N, sN) - headingAt(B, s), s: sN, sBase: s, d: d0 };
  };
  return { map, locate, remap };
}
const rot2 = (v, a) => [v[0] * Math.cos(a) - v[1] * Math.sin(a), v[0] * Math.sin(a) + v[1] * Math.cos(a), v[2] ?? 0];
const unitPlane = (a, b, c, up = true) => { const e1 = [0, 1, 2].map(k => b[k] - a[k]), e2 = [0, 1, 2].map(k => c[k] - a[k]); let n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
  const l = Math.hypot(...n) || 1; n = n.map(v => v / l); if (up && n[2] < 0) n = n.map(v => -v); return [n[0], n[1], n[2], -(n[0] * a[0] + n[1] * a[1] + n[2] * a[2])]; };
const num = v => typeof v === "number" ? v : 0;


// conforming refinement: every edge longer than maxLen (or, given a test (a, b, length) -> bool instead, every edge
// it picks) is cut at its middle in all the triangles that share it (no T-junctions: the game links triangles by
// shared edges at load, 0xD59D0)
function refine(tris, edgeLen, midOf, maxLen) {
  const cut = typeof maxLen === "function" ? maxLen : (a, b, l) => l > maxLen;
  // always the longest edge first: it is then the longest edge of every triangle that has it (longest-edge
  // bisection, which converges), and both sides of the edge are cut at the same point
  const key = (a, b) => a < b ? a * 1e7 + b : b * 1e7 + a, live = tris.map(t => ({ v: t.v, p: t })), byEdge = new Map(), heap = [];
  const push = (e, l) => { heap.push([l, e]); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] >= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] > heap[m][0]) m = l; if (r < heap.length && heap[r][0] > heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
  // a flat (zero-area) triangle never asks for cuts itself: bisecting one does not shorten its edges (it cycles)
  const flat = t => { const l = [0, 1, 2].map(k => edgeLen(t.v[k], t.v[(k + 1) % 3])), m = Math.max(...l), s2 = l[0] + l[1] + l[2] - 2 * m; return s2 < 1e-3 * m; };
  const add = t => { const fl = flat(t); for (let k = 0; k < 3; k++) { const a = t.v[k], b = t.v[(k + 1) % 3], e = key(a, b); if (!byEdge.has(e)) { byEdge.set(e, new Set()); const l = edgeLen(a, b); if (!fl && cut(a, b, l)) push(e, l); } byEdge.get(e).add(t); } };
  const del = t => { for (let k = 0; k < 3; k++) byEdge.get(key(t.v[k], t.v[(k + 1) % 3]))?.delete(t); t.dead = true; };
  live.forEach(add); let guard = 0;
  while (heap.length && guard++ < 2e6) { const [, e] = pop(), set = byEdge.get(e); if (!set || !set.size) continue; const a = Math.floor(e / 1e7), b = e % 1e7, m = midOf(a, b);
    for (const t of [...set]) { const k = [0, 1, 2].find(j => key(t.v[j], t.v[(j + 1) % 3]) === e), x = t.v[k], y = t.v[(k + 1) % 3], z = t.v[(k + 2) % 3];
      del(t); const t1 = { v: [x, m, z], p: t.p }, t2 = { v: [m, y, z], p: t.p }; add(t1); add(t2); live.push(t1, t2); }
    byEdge.delete(e); }
  return live.filter(t => !t.dead).map(t => ({ ...t.p, v: t.v }));
}

// ---------------------------------------------------------------- physics
function warpPhys(doc, M, N, B) {
  const C = doc.collision, V0 = C.vertices.map(v => { const pl = v.plane.map(num); return [v.x, v.y, pl[2] ? -(pl[3] + pl[0] * v.x + pl[1] * v.y) / pl[2] : 0]; });
  // cut long edges (in the base track) so they can follow the new curves; midpoints are shared between triangles
  const verts = V0.map(p => [...p]), mid = new Map();
  const midOf = (a, b) => { const k = a < b ? a * 1e6 + b : b * 1e6 + a; if (!mid.has(k)) { mid.set(k, verts.length); verts.push([0, 1, 2].map(j => (verts[a][j] + verts[b][j]) / 2)); } return mid.get(k); };
  const len = (a, b) => Math.hypot(verts[a][0] - verts[b][0], verts[a][1] - verts[b][1]);
  const all = []; C.sections.forEach((sec, si) => { for (const k of ["surface", "B", "apron"]) sec[k].forEach((t, j) => all.push({ ...t, _s: si, _k: k, _j: j })); });
  // only where the warp bends an edge: cut while the moved middle is more than TOL off the middle of the moved ends
  // (always under 6 ft, always past 400 ft). The game's collision set-up is quadratic per section (0xD6C20 tests
  // every racing-surface triangle against every apron one; 0xD64F0 every triangle against every wall): cutting
  // everything to 24 ft made ten times the triangles and ran the race loading past the step limit (the walls near
  // each triangle then never got worked out: cars went through walls)
  // a size field: the warp's offset over a 24 ft probe at the edge's middle (along the edge) sets the longest edge
  // that keeps the offset under TOL there (a bend's offset grows with the square of the length); 0.3 ft within 120 ft
  // of the base centre (racing surface, apron, pit road), looser farther out; never under 12 ft (24 ft out there),
  // always under 400. Depending only on where an edge is, longest-edge-first cutting converges.
  // A layout with a ground grid (an NR2003 track: banking that ramps in and out, heights that vary) probes at a quarter,
  // half and three quarters: with the middle probe only, triangles there stood up to 1.6 ft off the road (4400 points
  // past 0.3 ft at Milwaukee; the field spun at the turn entries); with three, 89 points (63k triangles, under the
  // 16-bit id limit) and 42 of 43 cars past 0.9 laps in 60 s.
  const TOL0 = +(process.env.NT04_WARP_TOL ?? 0.3); let PROBES = (process.env.NT04_WARP_PROBES ?? (N.groundGrid ? "0.25,0.5,0.75" : "0.5")).split(",").map(Number);
  const bends = (a, b, l) => { if (l > 400) return true; const A = verts[a], Bv = verts[b], qa = M.map(...A), qb = M.map(...Bv), far = Math.min(Math.abs(qa.d), Math.abs(qb.d));
    if (l < (far < 120 ? 12 : 24)) return false; const tol = (far < 120 ? TOL0 : TOL0 + (far - 120) * 0.03);
    // the probe at the edge's middle (NT04_WARP_PROBES: more points along it; those also catch the kinks at the sideways
    // map's knots and cut every edge crossing them down to 12 ft: two and a half times the triangles)
    const u = [0, 1, 2].map(j => (Bv[j] - A[j]) / l * 12); let dev = 0;
    for (const f of PROBES) { const m = [0, 1, 2].map(j => A[j] + (Bv[j] - A[j]) * f), p0 = M.map(...m.map((v, j) => v - u[j])).p, p1 = M.map(...m.map((v, j) => v + u[j])).p, pm = M.map(...m).p;
      dev = Math.max(dev, Math.hypot(pm[0] - (p0[0] + p1[0]) / 2, pm[1] - (p0[1] + p1[1]) / 2, pm[2] - (p0[2] + p1[2]) / 2)); }
    return dev > 1e-6 && l > 24 * Math.sqrt(tol / dev); };
  let fine = refine(all, len, midOf, MAX_EDGE > 0 ? MAX_EDGE : bends);
  if (fine.length > 65000 && PROBES.length > 1 && !(MAX_EDGE > 0)) { PROBES = [0.5]; fine = refine(all, len, midOf, bends); }   // (triangle ids are 16-bit)
  const sections = C.sections.map(sec => ({ ...sec, surface: [], B: [], apron: [], walls: {} }));
  fine.sort((x, y) => x._j - y._j); for (const t of fine) { const { _s, _k, _j, ...tri } = t; sections[_s][_k].push(tri); }
  // move every vertex
  const moved = verts.map(p => M.map(p[0], p[1], p[2]));
  const vplane = new Array(verts.length).fill(null);
  for (const s of sections) for (const k of ["surface", "B", "apron"]) s[k] = s[k].map(t => { const P = t.v.map(i => moved[i].p), pl = unitPlane(P[0], P[1], P[2]);
      const cx = (verts[t.v[0]][0] + verts[t.v[1]][0] + verts[t.v[2]][0]) / 3, cy = (verts[t.v[0]][1] + verts[t.v[1]][1] + verts[t.v[2]][1]) / 3, r = M.map(cx, cy, 0).rot;
      for (const i of t.v) { const a = vplane[i] ??= [0, 0, 0]; a[0] += pl[0]; a[1] += pl[1]; a[2] += pl[2]; } return { ...t, plane: pl, dir: rot2(t.dir.map(num), r) }; });
  // vertex planes: the average normal of the triangles using the vertex (as in the game's files), through the vertex
  const vertices = moved.map((m, i) => { const a = vplane[i] ?? [0, 0, 1], l = Math.hypot(...a) || 1, n = a.map(v => v / l); return { x: m.p[0], y: m.p[1], plane: [n[0], n[1], n[2], -(n[0] * m.p[0] + n[1] * m.p[1] + n[2] * m.p[2])] }; });
  // walls: cut long panels, move their corner points
  const pts = C.points.map(p => [...p]), panelCut = new Map();
  const cutPanel = w => { const key = `${w.top}|${w.bottom}`; if (panelCut.has(key)) return panelCut.get(key);
    const [t0, t1, b0, b1] = [w.top[0], w.top[1], w.bottom[0], w.bottom[1]], L = Math.hypot(pts[b1][0] - pts[b0][0], pts[b1][1] - pts[b0][1]);
    // walls: every 24 ft. (Cut by a size field like the triangles', from 12 to 150 ft, the race never started at the
    // test oval, the field sat on the grid; the cause was not pinned down. Walls are few, so they stay at 24 ft.)
    const n = Math.max(1, Math.ceil(L / (MAX_EDGE || 24)));
    const tops = [t0], bots = [b0]; for (let k = 1; k < n; k++) { const f = k / n; tops.push(pts.push([0, 1, 2].map(j => lerp(pts[t0][j], pts[t1][j], f))) - 1); bots.push(pts.push([0, 1, 2].map(j => lerp(pts[b0][j], pts[b1][j], f))) - 1); }
    tops.push(t1); bots.push(b1); const pieces = []; for (let k = 0; k < n; k++) pieces.push({ top: [tops[k], tops[k + 1]], bottom: [bots[k], bots[k + 1]] }); panelCut.set(key, pieces); return pieces; };
  for (let i = 0; i < sections.length; i++) for (const [k, list] of Object.entries(C.sections[i].walls)) sections[i].walls[k] = list.flatMap(w => cutPanel(w).map(pc => ({ ...w, ...pc })));
  // the walls' neighbour links (+0x20 / +0x22 previous wall: index in its section's list of the same kind, section;
  // +0x24 / +0x26 next; -1 none; read by the wall contact code 0x4FA80 through 0xD9AE0 / 0xD9B20) point at list
  // positions: re-aimed at the pieces (the first piece's previous is the previous wall's last piece, and so on).
  // Copied as they were, they pointed at other walls or past the lists: the race stopped at the first wall contact.
  { const start = new Map(), key = (si, k, j) => si * 1e6 + (k === "inner" ? 0 : k === "outer" ? 1 : 2) * 1e5 + j;
    for (let i = 0; i < sections.length; i++) for (const [k, list] of Object.entries(C.sections[i].walls)) { let at = 0; list.forEach((w, j) => { const n = cutPanel(w).length; start.set(key(i, k, j), [at, n]); at += n; }); }
    const s16 = v => (v << 16) >> 16, link = (si, k, j, last) => { if (si < 0 || j < 0) return [-1, -1]; const e = start.get(key(si, k, j)); return e ? [e[0] + (last ? e[1] - 1 : 0), si] : [-1, -1]; };
    for (let i = 0; i < sections.length; i++) for (const [k, list] of Object.entries(C.sections[i].walls)) list.forEach((w, j) => { const [at, n] = start.get(key(i, k, j));
      const prev = link(s16(w.z20 >>> 16), k, s16(w.z20 & 0xffff), true), next = link(s16(w.c), k, s16(w.a), false);
      for (let q = 0; q < n; q++) { const pc = sections[i].walls[k][at + q], pv = q > 0 ? [at + q - 1, i] : prev, nx = q < n - 1 ? [at + q + 1, i] : next;
        pc.z20 = ((pv[0] & 0xffff) | ((pv[1] & 0xffff) << 16)) >>> 0; pc.a = nx[0] & 0xffff; pc.c = nx[1] & 0xffff; } }); }
  const pMoved = pts.map(p => M.map(p[0], p[1], p[2]));
  for (const s of sections) for (const list of Object.values(s.walls)) for (const w of list) {
    const [t0, t1, b0, b1] = [w.top[0], w.top[1], w.bottom[0], w.bottom[1]].map(i => pMoved[i].p), pl = unitPlane(b0, b1, t0, false), r = pMoved[w.bottom[0]].rot, ref = rot2(w.plane.map(num), r);
    const n = pl[0] * ref[0] + pl[1] * ref[1] < 0 ? pl.map(v => -v) : pl; w.plane = n; w.topZ = (t0[2] + t1[2]) / 2; }
  // sections: boundaries at the same lap fractions, perpendicular to the new centreline; bounds from the contents
  // a boundary's lap fraction: where its plane crosses the base centre, nearest to the section's own contents
  const centreOf = sec => { let x = 0, y = 0, n = 0; for (const k of ["surface", "B", "apron"]) for (const t of sec[k]) for (const v of t.v) { x += V0[v][0]; y += V0[v][1]; n++; } return n ? [x / n, y / n] : [(sec.bounds[0] + sec.bounds[2]) / 2, (sec.bounds[1] + sec.bounds[3]) / 2]; };
  const crossing = (plane, near) => { const pl = plane.map(num); let best = null, bd = Infinity;
    for (let i = 0; i < B.n; i++) { const j = (i + 1) % B.n, a = pl[0] * B.X[i] + pl[1] * B.Y[i] + pl[3], b = pl[0] * B.X[j] + pl[1] * B.Y[j] + pl[3]; if ((a <= 0) === (b <= 0)) continue;
      const t = a / (a - b), x = lerp(B.X[i], B.X[j], t), y = lerp(B.Y[i], B.Y[j], t), dd = (x - near[0]) ** 2 + (y - near[1]) ** 2; if (dd < bd) { bd = dd; best = { s: (i + t) / B.n, sign: Math.sign(pl[0] * B.TX[i] + pl[1] * B.TY[i]) || 1 }; } }
    return best ?? { s: 0, sign: 1 }; };
  const planeAt = (s0, sign) => { const s = M.remap.f(s0), tx = at(N, "TX", s) * sign, ty = at(N, "TY", s) * sign, x = at(N, "X", s), y = at(N, "Y", s); return [tx, ty, 0, -(tx * x + ty * y)]; };
  // a boundary plane: the base boundary line carried through the mapper (two points on it, either side of the base
  // centre, mapped; the plane goes through them, facing into the section), so it follows the lateral stretching;
  // square to the new centreline at the boundary's lap fraction when the mapped points are unusable
  const carryPlane = (plane, c) => { const pl = plane.map(num), cr = crossing(pl, c), x0 = at(B, "X", cr.s), y0 = at(B, "Y", cr.s);
    const lx = -pl[1], ly = pl[0], q = h => M.map(x0 + lx * h, y0 + ly * h, at(B, "Z", cr.s)).p, a = q(-25), b = q(25);
    let ex = b[0] - a[0], ey = b[1] - a[1]; const l = Math.hypot(ex, ey); if (!(l > 1)) return planeAt(cr.s, cr.sign);
    let nx = -ey / l, ny = ex / l; const ref = planeAt(cr.s, cr.sign); if (nx * ref[0] + ny * ref[1] < 0) { nx = -nx; ny = -ny; }
    if (nx * ref[0] + ny * ref[1] < 0.7) return ref;
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2; return [nx, ny, 0, -(nx * mx + ny * my)]; };
  sections.forEach((s, i) => { const o = C.sections[i], c = centreOf(o);
    if (process.env.NT04_SQUARE_PLANES) { const a = crossing(o.start.map(num), c), b = crossing(o.end.map(num), c); s.start = planeAt(a.s, a.sign); s.end = planeAt(b.s, b.sign); } else { s.start = carryPlane(o.start, c); s.end = carryPlane(o.end, c); }
    let mn = [Infinity, Infinity], mx = [-Infinity, -Infinity]; const grow = p => { mn = [Math.min(mn[0], p[0]), Math.min(mn[1], p[1])]; mx = [Math.max(mx[0], p[0]), Math.max(mx[1], p[1])]; };
    for (const k of ["surface", "B", "apron"]) for (const t of s[k]) for (const v of t.v) grow(moved[v].p); for (const list of Object.values(s.walls)) for (const w of list) for (const q of [...w.top, ...w.bottom]) grow(pMoved[q].p);
    s.bounds = mn[0] === Infinity ? o.bounds : [mn[0], mn[1], mx[0], mx[1]]; });
  const collision = { vertices, points: pMoved.map(m => m.p), sections };
  // lines: end points moved, the middle control point fitted through the moved curve middle; lengths, cubic and
  // lap fractions recomputed; profiles (sideways distances), node values and segment data kept
  // A layout with a racing line of its own (N.RL): the racing line (group 0) is put on it, each point at the lap
  // position its warped point would have (so the AI speeds, per sample along the line, stay where they were)
  const onRL = q => { const s = q.s, d = at(N, "RL", s), tx = at(N, "TX", s), ty = at(N, "TY", s); return [at(N, "X", s) + ty * d, at(N, "Y", s) - tx * d, at(N, "Z", s) + at(N, "SL", s) * d]; };
  const lines = doc.lines.lines.map(l => { const P = l.points, out = [], mp = N.hasRL && l.group === 0 ? (...v) => onRL(M.map(...v)) : (...v) => M.map(...v).p;
    for (let i = 0; i < l.segments.length; i++) { const p0 = mp(...P[2 * i]), p1 = mp(...P[2 * i + 2]), m = mp(...bez(P[2 * i], P[2 * i + 1], P[2 * i + 2], 0.5));
      if (i === 0) out.push(p0); out.push([0, 1, 2].map(k => 2 * m[k] - (p0[k] + p1[k]) / 2), p1); }
    while (out.length < P.length) out.push(M.map(...P[out.length]).p);
    return { ...l, points: out, nodes: l.nodes.map(list => list.map(n => ({ ...n, pos: M.map(...n.pos).p }))) }; });
  if (N.lanesOnRL) lanesOnRaceline(lines, N, M);
  if (Array.isArray(N.pitWall) && N.pitWall.length) addPitWall(collision, N.pitWall, N, lines, m => (N.notes ??= []).push(m));
  const arcs = (p0, c, p1, n = 48) => { const S = [0]; let prev = bez(p0, c, p1, 0), s = 0; for (let i = 1; i <= n; i++) { const p = bez(p0, c, p1, i / n); s += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]); S.push(s); prev = p; } return S; };
  const fit = S => { const n = S.length - 1, L = S[n]; let m11 = 0, m12 = 0, m22 = 0, r1 = 0, r2 = 0; for (let i = 0; i <= n; i++) { const x = i / n, u = x ** 3 - x, v = x * x - x, y = S[i] - L * x; m11 += u * u; m12 += u * v; m22 += v * v; r1 += u * y; r2 += v * y; } const det = m11 * m22 - m12 * m12 || 1, a = (r1 * m22 - r2 * m12) / det, b = (m11 * r2 - m12 * r1) / det; return [a, b, L - a - b]; };
  for (const l of lines) { let cum = 0; l.segments = l.segments.map((sg, i) => { const S = arcs(l.points[2 * i], l.points[2 * i + 1], l.points[2 * i + 2]); cum += S.at(-1); return { ...sg, length: S.at(-1), end: cum, poly: fit(S) }; }); }
  // lap fractions on the new racing line
  const R = lines.find(l => l.group === 0), samp = [], total = R.segments.at(-1).end;
  R.segments.forEach((sg, i) => { const S = arcs(R.points[2 * i], R.points[2 * i + 1], R.points[2 * i + 2], 24); for (let k = 0; k < 24; k++) samp.push({ p: bez(R.points[2 * i], R.points[2 * i + 1], R.points[2 * i + 2], k / 24), d: (i ? R.segments[i - 1].end : 0) + S[k] }); });
  const fracOf = p => { let best = Infinity, d = 0; for (const q of samp) { const dd = (q.p[0] - p[0]) ** 2 + (q.p[1] - p[1]) ** 2; if (dd < best) { best = dd; d = q.d; } } return (d / total) % 1; };
  for (const l of lines) { l.segments.forEach((sg, i) => { sg.frac = l === R ? (i ? R.segments[i - 1].end : 0) / total : fracOf(l.points[2 * i]); });
    const closed = l.fracEnd === doc.lines.lines[lines.indexOf(l)].segments[0].frac; l.fracEnd = closed ? l.segments[0].frac : fracOf(l.points.at(-1)); }
  // spots, camera positions, light positions, crowd areas
  const spots = doc.spots.map(t => t.map(sp => { const m = M.map(...sp.pos), ax = sp.axes.map(num), f = rot2(ax.slice(0, 3), m.rot), r = rot2(ax.slice(3, 6), m.rot); return { ...sp, pos: m.p, axes: [...f, ...r, ...ax.slice(6, 9)] }; }));
  const raw = { ...doc.raw }, hexMap = (hex, stride, offs, start = 0) => { const b = Buffer.from(hex, "hex"); for (let o = start; o + stride <= b.length; o += stride) for (const p of offs) { const q = M.map(b.readFloatLE(o + p), b.readFloatLE(o + p + 4), b.readFloatLE(o + p + 8)).p; q.forEach((v, k) => b.writeFloatLE(v, o + p + k * 4)); } return b.toString("hex"); };
  raw.t20 = hexMap(raw.t20, 0x20, [4]); raw.k12 = hexMap(raw.k12, 12, [0], 4); raw.quads = hexMap(raw.quads, 48, [0, 12, 24, 36]);
  // 0x78 records: cameras (grid / pre-race / replay shots): position +0x40, a far aim point +0x28, two yaw angles
  // (degrees) +0x4C / +0x50; the ones attached to a car have position 0. 0x68 records: positioned objects, position
  // +0x50, heading (degrees) +0x64. Positions move, aims and angles turn with the track there.
  const deg = 180 / Math.PI;
  if (raw.r78) { const b = Buffer.from(raw.r78, "hex"); for (let o = 0; o + 0x78 <= b.length; o += 0x78) { const P = [0, 4, 8].map(k => b.readFloatLE(o + 0x40 + k)); if (!P.some(v => v !== 0) || !P.every(Number.isFinite)) continue;
      const q = M.map(...P), A = [0, 4, 8].map(k => b.readFloatLE(o + 0x28 + k)), dv = rot2([A[0] - P[0], A[1] - P[1]], q.rot);
      [q.p[0], q.p[1], q.p[2]].forEach((v, k) => b.writeFloatLE(v, o + 0x40 + k * 4));
      if (A.every(Number.isFinite)) { b.writeFloatLE(q.p[0] + dv[0], o + 0x28); b.writeFloatLE(q.p[1] + dv[1], o + 0x2C); b.writeFloatLE(A[2] + (q.p[2] - P[2]), o + 0x30); }
      for (const k of [0x4C, 0x50]) { const a = b.readFloatLE(o + k); if (Number.isFinite(a) && a !== 0) b.writeFloatLE(a + q.rot * deg, o + k); } }
    raw.r78 = b.toString("hex"); }
  if (raw.r68) { const b = Buffer.from(raw.r68, "hex"); for (let o = 0; o + 0x68 <= b.length; o += 0x68) { const P = [0, 4, 8].map(k => b.readFloatLE(o + 0x50 + k)); if (!P.some(v => v !== 0) || !P.every(Number.isFinite)) continue;
      const q = M.map(...P); [q.p[0], q.p[1], q.p[2]].forEach((v, k) => b.writeFloatLE(v, o + 0x50 + k * 4)); const h = b.readFloatLE(o + 0x64); if (Number.isFinite(h)) b.writeFloatLE(h + q.rot * deg, o + 0x64); }
    raw.r68 = b.toString("hex"); }
  // A track with its own scenery and height profile (nr2003-track.mjs) has none of the base's light towers or scoring
  // pylon: their night glows (k12) and positioned objects (0x68 records) go 10,000 ft under the ground
  if (N.groundGrid && N.hideBase !== false) {
    const sink = (hex, stride, off, start = 0) => { const b = Buffer.from(hex, "hex"); for (let o = start; o + stride <= b.length; o += stride) b.writeFloatLE(-10000, o + off + 8); return b.toString("hex"); };
    if (raw.k12) raw.k12 = sink(raw.k12, 12, 0, 4); if (raw.r68) raw.r68 = sink(raw.r68, 0x68, 0x50); }
  return { ...doc, collision, lines: { ...doc.lines, lines }, spots, raw };
}

// AI speeds (AI_SPDS, aispeeds.mjs). Lines with per-sample speeds (mph, 31 samples a segment: group 1 the three race
// lanes, groups 3 / 6 the ways onto and off pit road) get a speed profile worked out on the new line itself:
//   target = min(vtop, cornering limit sqrt(g R (mu + tan b) / (1 - mu tan b))), R the line's own radius (its bend
//   averaged over a segment's length either side), b the banking there; then braking (backwards, decel BD) and
//   acceleration (forwards, A0 (1 - (v / vtop)^2)) passes, around twice on a closed line.
// mu, BD, A0 and vtop are fitted to the base track: the same model run on the base's own lane against its stored
// speeds (Lowe's: mu ~1.1, apexes 166-174 mph, 198 at the line). Samples the base holds at its pit road speed (within
// 1 mph) take the new pit road speed. (The previous scaling by sqrt(limit ratio) at the same lap fraction kept the
// base's straightaway speeds, Lowe's 198 mph, on a one-mile flat track.)
// Node speeds (one value from a line position on): groups 5 and 8 (pit road; at Talladega 70 mph, the "70 mph Speed
// Limit" the pit menu shows) and 11 (the stall paths, read by the pit code at 0x2AFB1 / 0x2B573...: 60 there) take the
// new pit road speed in proportion; group 4 (pit entry, stepping down) too; group 0 (40-75 mph, at or a little over
// the pit speed at every stock track: taken as the pace car's) the track's pace speed when it gives one; groups 2
// and 7 scale with the mean race speed.
const MPH = 1.46667, GRAV = 32.17;
function lineSamples(line, nbytes, sAt) {
  const P = line.points, n = line.segments.length, out = []; let hint = null;
  for (let j = 0; j < nbytes; j++) { const seg = Math.min(n - 1, Math.floor(j / SAMPLES)), t = Math.min(1, (j - seg * SAMPLES) / SAMPLES), a = P[2 * seg], c = P[2 * seg + 1], b = P[2 * seg + 2];
    const p = bez(a, c, b, t), sp = Math.hypot(...bezD(a, c, b, t)) || 1e-6, r = sAt(p, hint); hint = r.hint;
    // the line's bend from the centreline's (smooth) at its distance to the side: R + d (d right +, turns to the left
    // positive); the warped lanes' own bends are kinked
    const K = r.K, den = 1 + K * r.d; out.push({ p, k: Math.abs(den) < 0.05 ? K / 0.05 : K / den, ds: sp / SAMPLES, s: r.s, tb: r.tb }); }
  return out;
}
function speedProfile(S, closed, { mu, bd, a0, vtop }, fixed = null) {
  const n = S.length, lim = x => { const R = Math.min(5000, 1 / Math.max(Math.abs(x.k), 1 / 5000)); return Math.sqrt(GRAV * R * (mu + x.tb) / Math.max(0.2, 1 - mu * x.tb)); };
  const top = vtop * MPH, v = S.map((x, j) => fixed?.[j] != null ? fixed[j] * MPH : Math.min(top, lim(x)));
  const laps = closed ? 2 : 1;
  for (let r = 0; r < laps; r++) for (let j = n - 2 + (closed ? 1 : 0); j >= 0; j--) { const nx = closed ? (j + 1) % n : j + 1; v[j] = Math.min(v[j], Math.sqrt(v[nx] ** 2 + 2 * bd * S[j].ds)); }
  for (let r = 0; r < laps; r++) for (let j = closed ? 0 : 1; j < n; j++) { const pv = closed ? (j - 1 + n) % n : j - 1, a = Math.max(0.5, a0 * (1 - (v[pv] / top) ** 2)); v[j] = Math.min(v[j], Math.sqrt(v[pv] ** 2 + 2 * a * S[pv].ds)); }
  return v.map(x => x / MPH);
}
function fitSpeedModel(S, bytes, closed) {
  const vmax = Math.max(...bytes); let best = null;
  for (const vtop of [vmax, vmax * 1.03, vmax * 1.08]) for (let mu = 0.7; mu <= 1.5001; mu += 0.05) for (const bd of [15, 20, 25, 30, 40, 55, 70]) for (const a0 of [8, 12, 16, 22, 30, 40, 55]) {
    const pr = speedProfile(S, closed, { mu, bd, a0, vtop }); let e = 0; for (let j = 0; j < S.length; j++) e += Math.abs(pr[j] - bytes[j]); e /= S.length;
    if (!best || e < best.err) best = { mu, bd, a0, vtop, err: e }; }
  return best;
}
function warpAI(groups, baseLines, newLines, B, N, M, { pitSpeed = null, paceSpeed = null, recordLap = null, baseRecordLap = null, log = () => {} } = {}) {
  const byGroup = []; for (let g = 0; g < 19; g++) byGroup.push([]); newLines.forEach((l, i) => byGroup[l.group].push(i));
  // the centreline's bend averaged over +-100 ft (the frames' own K is over 12 ft: the base's, from its racing line, wiggles)
  const Ksm = (F, s) => { let a = 0; for (let q = -10; q <= 10; q++) a += at(F, "K", s + q * 10 / F.len); return a / 21; };
  const sBase = p => { const q = M.locate(p[0], p[1]); return { s: q.s, d: q.d, tb: at(B, "SL", q.s), K: Ksm(B, q.s), hint: null }; };
  const sNew = (p, hint) => { let bi = 0, bd = Infinity; const n = N.n, w = hint === null ? n : 400;
    for (let q = -w; q <= w; q++) { const i = hint === null ? q + w : ((hint + q) % n + n) % n; if (i >= n) break; const d = (N.X[i] - p[0]) ** 2 + (N.Y[i] - p[1]) ** 2; if (d < bd) { bd = d; bi = i; } }
    const d = (p[0] - N.X[bi]) * N.TY[bi] - (p[1] - N.Y[bi]) * N.TX[bi];
    return { s: bi / n, d, tb: at(N, "SL", bi / n), K: Ksm(N, bi / n), hint: bi }; };
  const closedOf = l => Math.hypot(l.points[0][0] - l.points.at(-1)[0], l.points[0][1] - l.points.at(-1)[1]) < 5;
  // the base's pit road speed (group 11's first node) and the fit on the base's first race lane
  const pitBase = groups[11]?.[0]?.nodes?.[0]?.speed ?? groups[5]?.[0]?.nodes?.[0]?.speed ?? null, pitNew = pitSpeed ?? pitBase;
  const lane = groups[1]?.findIndex(l => l.bytes); if (lane === undefined || lane < 0) return groups;
  const kb = byGroup[1][lane], bl = baseLines[kb], SB = lineSamples(bl, groups[1][lane].bytes.length, sBase), fit = fitSpeedModel(SB, groups[1][lane].bytes, closedOf(bl));
  if (process.env.NT04_AI_DEBUG) for (let j = 0; j < SB.length; j += 31) console.log(j, groups[1][lane].bytes[j], (1 / SB[j].k).toFixed(0), (Math.atan(SB[j].tb) * 57.3).toFixed(1), speedProfile(SB, closedOf(bl), fit)[j].toFixed(0));
  log(`AI speeds: fitted to the base lane: mu ${fit.mu.toFixed(2)}, braking ${fit.bd} ft/s2, accel ${fit.a0} ft/s2, top ${fit.vtop.toFixed(0)} mph (mean error ${fit.err.toFixed(1)} mph); pit road ${pitBase} -> ${pitNew} mph`);
  // A lap time to run to: the track's record lap (track.ini) at the base's own pace against its record (the stock AI
  // lanes lap within 1-2 % of TRCK.TQRT: Lowe's 29.3 s vs 28.96, Phoenix 26.6 vs 26.83). The speeds' shape along the
  // lap: the track's own AI speeds (raceline.lp: N.AIV) when it has them, else the model above.
  const lapOf = (S, v) => S.reduce((a, x, j) => a + x.ds / Math.max(1, v[j] * MPH), 0);
  const baseLap = lapOf(SB, groups[1][lane].bytes), pace = baseRecordLap ? baseLap / baseRecordLap : 1, target = recordLap ? recordLap * pace : null;
  let shape = null;                                   // s -> mph on the race lanes
  if (target) { const nl0 = newLines[byGroup[1][lane]], S0 = lineSamples(nl0, groups[1][lane].bytes.length, sNew);
    const rel = N.hasAIV ? S0.map(x => at(N, "AIV", x.s)) : speedProfile(S0, closedOf(nl0), fit), U = lapOf(S0, rel) / target;
    shape = s => (N.hasAIV ? at(N, "AIV", s) : null);
    if (N.hasAIV) shape = s => at(N, "AIV", s) * U; else { const tbl = S0.map((x, j) => [x.s, rel[j] * U]).sort((a, b) => a[0] - b[0]); shape = s => { let lo = 0, hi = tbl.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tbl[m][0] <= s) lo = m; else hi = m; } return tbl[lo][1]; }; }
    log(`AI speeds: record lap ${recordLap} s x base pace ${pace.toFixed(3)} (its AI ${baseLap.toFixed(2)} s vs record ${baseRecordLap ?? "?"} s) = ${target.toFixed(2)} s; shape from ${N.hasAIV ? "the track's raceline.lp" : "the cornering model"}`); }
  let sumB = 0, sumN = 0, cnt = 0;
  const out = groups.map((lines, g) => lines.map((line, i) => {
    if (!line.bytes) return line; const k = byGroup[g][i], nl = newLines[k], blk = baseLines[k];
    // (a line rebuilt with another number of segments (linegen.mjs): 31 samples a segment + 1 of its own; the base's
    // pit road samples looked up at the same fraction along the line)
    const nb = nl.segments.length * SAMPLES + 1, src = line.bytes, rs = nb === src.length ? src : Array.from({ length: nb }, (_, j) => src[Math.round(j / (nb - 1) * (src.length - 1))]);
    const SN = lineSamples(nl, nb, sNew), pitAt = rs.map(b => pitBase !== null && b <= pitBase + 1);
    let pr;
    if (shape && g === 1) pr = SN.map(x => shape(x.s));
    else if (shape) pr = speedProfile(SN, closedOf(nl), { ...fit, vtop: 255 }, SN.map((x, j) => pitAt[j] ? pitNew : Math.min(255, shape(x.s))));
    else pr = speedProfile(SN, closedOf(nl), fit, pitAt.map(f => f ? pitNew : null));
    pr = pr.map(v => Math.max(1, Math.min(255, Math.round(v))));
    if (g === 1) { sumB += line.bytes.reduce((a, b) => a + b, 0); sumN += pr.reduce((a, b) => a + b, 0); cnt += pr.length; }
    return { ...line, bytes: pr }; }));
  const ratio = sumB ? sumN / sumB : 1;
  for (let g = 0; g < out.length; g++) for (const line of out[g]) { if (!line.nodes) continue;
    for (const nd of line.nodes) { if (nd.speed <= 1 || nd.speed >= 500) continue;
      if ([5, 8, 11].includes(g) && pitBase) nd.speed = Math.round(pitNew * nd.speed / pitBase);
      else if (g === 4 && pitBase) nd.speed = Math.round(pitNew * nd.speed / pitBase);
      else if (g === 0) nd.speed = Math.round(paceSpeed ?? (pitBase ? pitNew * nd.speed / pitBase : nd.speed));
      else if (g === 2 || g === 7) nd.speed = Math.round(nd.speed * ratio); } }
  log(`AI speeds: race lanes ${Math.min(...out[1].flatMap(l => l.bytes ?? [255]))}-${Math.max(...out[1].flatMap(l => l.bytes ?? [0]))} mph (mean ${(ratio * 100).toFixed(0)} % of the base's)`);
  return out;
}

// ---------------------------------------------------------------- render model
function warpRend(a, M, zAt = null) {
  const m = parseTMdl(a), f = o => a.readFloatLE(o), toP = (x, y, z) => [x / FT, -z / FT, y / FT], toR = p => [p[0] * FT, p[2] * FT, -p[1] * FT];
  const ry = (v, ang) => [v[0] * Math.cos(ang) + v[2] * Math.sin(ang), v[1], -v[0] * Math.sin(ang) + v[2] * Math.cos(ang)];
  const placed = new Map(); for (const p of m.placements) { if (!placed.has(p.draw)) placed.set(p.draw, []); placed.get(p.draw).push(p.node); }
  // the base model's render groups (Swap: 8 groups, each a run of a list of instance = draw indices): ground, grass,
  // markings and road are drawn in that order, so the warped pieces keep their draw's group
  const groupOfDraw = new Map(); { const c = m.chunks?.Swap; if (c) { const n = a.readUInt32LE(c.off), pF = a.readUInt32LE(c.off + 8), pL = a.readUInt32LE(c.off + 12);
    for (let g = 0; g < Math.min(n, 8); g++) { const st = a.readUInt16LE(pF + g * 20 + 16), cnt = a.readUInt16LE(pF + g * 20 + 18); for (let k = 0; k < cnt; k++) groupOfDraw.set(a.readUInt16LE(pL + (st + k) * 2), g); } } }
  const pieces = [];
  for (const d of m.draws) {
    const vb = m.vbs[d.vb]; if (!vb || vb.stride < 32) continue; const tris = drawTriangles(m, d); if (!tris.length) continue;
    const V = [], N = [], C = [], U = []; for (let k = 0; k < vb.count; k++) { const o = vb.data + k * vb.stride; V.push([f(o), f(o + 4), f(o + 8)]); N.push([f(o + 12), f(o + 16), f(o + 20)]); C.push([a[o + 26], a[o + 25], a[o + 24], a[o + 27]]); U.push([f(o + 28), f(o + 32)]); }
    let nodes = placed.get(d.index) ?? [0];
    // a piece placed once is part of the scenery under a group node (Lowe's road, grass and shadow layers hang under
    // "Lowes_base_LODP", 4 ft up): its node's transform goes into the vertices and it bends like the rest; only
    // pieces placed several times (poles, signs, ...) move as rigid objects
    if (nodes.length === 1 && nodes[0]) { const Mx = nodeMatrix(m.nodes[nodes[0]]), ap = v => [0, 1, 2].map(j => Mx[j][0] * v[0] + Mx[j][1] * v[1] + Mx[j][2] * v[2] + Mx[j][3]);
      for (let k = 0; k < V.length; k++) { V[k] = ap(V[k]); const n3 = [0, 1, 2].map(j => Mx[j][0] * N[k][0] + Mx[j][1] * N[k][1] + Mx[j][2] * N[k][2]), l = Math.hypot(...n3) || 1; N[k] = n3.map(x => x / l); }
      nodes = [0]; }
    const world = nodes.every(n => !n);
    if (!world) {                                      // a repeated object: its places move, the object itself does not bend
      const placements = nodes.map(nd => { if (!nd) return { t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }; const node = m.nodes[nd], Mx = nodeMatrix(node), mv = M.map(...toP(...node.t));
        const R = [[Math.cos(mv.rot), 0, Math.sin(mv.rot)], [0, 1, 0], [-Math.sin(mv.rot), 0, Math.cos(mv.rot)]], M2 = [0, 1, 2].map(i => [0, 1, 2].map(j => R[i][0] * Mx[0][j] + R[i][1] * Mx[1][j] + R[i][2] * Mx[2][j]));
        return decomposeRS(M2, toR(mv.p)); });
      pieces.push({ name: d.name, material: d.material, group: groupOfDraw.get(d.index), positions: V, normals: N, colors: C, uvs: U, triangles: tris, placements }); continue; }
    // world geometry: cut long edges, then move every vertex
    const P = V.map(v => [...v]), Nn = N.map(v => [...v]), Cc = C.map(v => [...v]), Uu = U.map(v => [...v]), mid = new Map(), maxCm = REND_EDGE * FT;
    const midOf = (x, y) => { const k = x < y ? x * 1e6 + y : y * 1e6 + x; if (!mid.has(k)) { mid.set(k, P.length); P.push(P[x].map((v, j) => (v + P[y][j]) / 2)); Nn.push(Nn[x].map((v, j) => (v + Nn[y][j]) / 2)); Cc.push(Cc[x].map((v, j) => Math.round((v + Cc[y][j]) / 2))); Uu.push(Uu[x].map((v, j) => (v + Uu[y][j]) / 2)); } return mid.get(k); };
    // far from the track the bend matters less: allowed edge length grows with the distance from the base centre, up to
    // 4 x (a long flat triangle would not follow the new shape: one infield ground triangle crossing the whole track
    // ended up above the road)
    const far = P.map(p => { const q = toP(...p); return Math.abs(M.locate(q[0], q[1]).d); });
    const midOf2 = (x, y) => { const i = midOf(x, y); far[i] ??= (far[x] + far[y]) / 2; return i; };
    const L = (x, y) => Math.hypot(P[x][0] - P[y][0], P[x][2] - P[y][2]) / Math.max(1, Math.min(4, (Math.min(far[x], far[y]) / 120) ** 1.5)), base = []; for (let i = 0; i < tris.length; i += 3) base.push({ v: [tris[i], tris[i + 1], tris[i + 2]] });
    const out = refine(base, L, midOf2, maxCm).flatMap(t => t.v);
    const mv = P.map(p => M.map(...toP(...p)));
    // a layer under the driving surface (the base's ground sheet, inches below road, grass and markings): its larger
    // triangles bend a little differently from the finer ones above and would show through, so it goes 1 ft lower
    if (zAt) { let under = 0, inside = 0; for (let i = 0; i < V.length; i++) { const q = toP(...V[i]), z = zAt(q[0], q[1]); if (z === null) continue; inside++; if (q[2] < z - 0.05) under++; }
      if (inside >= 8 && under > 0.7 * inside) for (const q of mv) q.p[2] -= 1; }
    const positions = mv.map(q => toR(q.p)), normals = Nn.map((nv, i) => ry(nv, mv[i].rot));
    // pieces stay below the 16-bit vertex limit
    if (positions.length <= 60000) pieces.push({ name: d.name, material: d.material, group: groupOfDraw.get(d.index), positions, normals, colors: Cc, uvs: Uu, triangles: out });
    else for (let s0 = 0; s0 < out.length; s0 += 60000) { const sub = out.slice(s0, s0 + 60000), remap = new Map(), pos = [], nor = [], col = [], uv = [], tr = [];
      for (const v of sub) { if (!remap.has(v)) { remap.set(v, pos.length); pos.push(positions[v]); nor.push(normals[v]); col.push(Cc[v]); uv.push(Uu[v]); } tr.push(remap.get(v)); }
      pieces.push({ name: d.name, material: d.material, group: groupOfDraw.get(d.index), positions: pos, normals: nor, colors: col, uvs: uv, triangles: tr }); }
  }
  const texUsed = new Map(), textures = [];
  const texIndex = ti => { if (!texUsed.has(ti)) { const t = m.textures[ti], img = textureRGBA(m, t); texUsed.set(ti, textures.length); textures.push({ name: t.name.replace(/^\d+/, ""), width: img.width, height: img.height, rgba: img.rgba, offset: t.uvOffset, scale: t.uvScale }); } return texUsed.get(ti); };
  const materials = m.materials.map(mt => ({ name: mt.name.replace(/^\d+/, ""), shader: mt.shader, textures: mt.textures.filter(ti => ti >= 0).map(texIndex) }));
  return buildTMdl({ name: m.name, pieces, materials, textures }, a);
}
function decomposeRS(Mx, t) {                          // 3x3 (rotation x scale) + translation -> { t, r (deg; Rz Ry Rx), s }
  const s = [0, 1, 2].map(j => Math.hypot(Mx[0][j], Mx[1][j], Mx[2][j]) || 1), R = Mx.map(r => r.map((v, j) => v / s[j]));
  const ry = Math.asin(Math.max(-1, Math.min(1, -R[2][0]))); let rx, rz; if (Math.cos(ry) > 1e-6) { rx = Math.atan2(R[2][1], R[2][2]); rz = Math.atan2(R[1][0], R[0][0]); } else { rz = 0; rx = Math.atan2(-R[1][2], R[1][1]); }
  return { t, r: [rx, ry, rz].map(v => v * 180 / Math.PI), s };
}

// ---------------------------------------------------------------- all together
// a layout's own ground as a lateral height grid along it (layout.ground = { d0, step, z: [[ft, ...] per point] }:
// heights at d0, d0 + step, ... to the right of each point; nr2003-track.mjs writes it): triangles, then groundAt
export function groundFromGrid(L) {
  const P = L.points, n = P.length, G = L.ground, tris = [], pt = (i, j) => { const a = P[(i - 1 + n) % n], b = P[(i + 1) % n], tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1, d = G.d0 + G.step * j;
    return [P[i][0] + ty / l * d, P[i][1] - tx / l * d, G.z[i][j]]; };
  for (let i = 0; i < n; i++) { const k = (i + 1) % n, m = Math.min(G.z[i].length, G.z[k].length);
    for (let j = 0; j + 1 < m; j++) { const a = pt(i, j), b = pt(i, j + 1), c = pt(k, j), d = pt(k, j + 1); if ([a, b, c, d].some(q => !q.every(Number.isFinite))) continue; tris.push([a, b, d], [a, d, c]); } }
  return triHeightsField(tris);
}

// ---------------------------------------------------------------- the collision layer from the track's own physics file
// A layout read from glTF (gltf-layout.mjs: layout.geom) builds the driving surface, apron, pit road, grass and the
// walls straight from that file instead of bending the base track's. The base still gives the number of sections and
// roughly where they fall along the lap (other parts of the file, not decoded yet, refer to sections by number).
//   rows: one per layout point, square to the centre line; on each, 14 points across (left to right): the inner
//   limit, ground, pit far side, stall line, pit near side, ground, road edge, road (3), road edge, ground, outer limit
//   (zones of no width where the track has none: their triangles are left out); quads between rows, two triangles.
//   heights: the road from the road mesh, the rest from the ground grid (gltf-layout); type of each triangle: the
//   file's surface there (stalls 3, pit road 1, road 0, grass 7, other ground 6). Racing surface and apron (0, 6) go
//   in the sections' "surface" lists, pit road, stalls and grass in "apron", as in the stock files.
//   sections: as many as the base has, each a run of rows: boundary planes through a row's line, square to the
//   centre line there, so every row lies in one section.
//   walls: per row, the nearest wall face beyond each road edge (the physics file's walls, pit walls apart): panels
//   between rows where both have one less than 6 ft apart; the outer wall (kind 8) runs with the lap, the inner
//   (kind 12) against it, so the track is on each panel's left; linked into chains (previous / next: list index and
//   section; -1 at a chain's ends). The pit wall is built as before (addPitWall: free-standing, open where the pit
//   lines cross it).
// Formations: the spot tables other than the grid (0, its pace car 6) and the pit crews (+0x34 = 1): the cars'
// places in the pre-race and caution line-ups, two wide and single file, and the pace car ahead of each (Lowe's
// tables 2 and 3 back from the line, 4 and 5 down the back stretch, 8-11 the pace car for each). Each table is put
// on the track's own middle line (group 0) as it lies on the base's: its first spot at the same fraction of the lap,
// the rest at the same distances in feet behind it and the same distance across, heading with the line there,
// on the road (bent along with the lap they shrank or stretched with it: on a short track the cars of a line-up overlapped)
function lineSampler(l) {
  const S = []; let s = 0;
  l.segments.forEach((sg, i) => { const [a, c, b] = [l.points[2 * i], l.points[2 * i + 1], l.points[2 * i + 2]];
    for (let k = 0; k < 40; k++) { const t = k / 40, p = [0, 1, 2].map(j => (1 - t) ** 2 * a[j] + 2 * (1 - t) * t * c[j] + t * t * b[j]), d = [0, 1].map(j => 2 * (1 - t) * (c[j] - a[j]) + 2 * t * (b[j] - c[j]));
      if (S.length) s += Math.hypot(p[0] - S.at(-1).p[0], p[1] - S.at(-1).p[1]); S.push({ p, s, h: Math.atan2(d[1], d[0]) }); } });
  const last = l.points.at(-1), len = s + Math.hypot(last[0] - S.at(-1).p[0], last[1] - S.at(-1).p[1]);
  const project = (x, y) => { let bi = 0, bd = Infinity; S.forEach((q, i) => { const d = (q.p[0] - x) ** 2 + (q.p[1] - y) ** 2; if (d < bd) { bd = d; bi = i; } }); const q = S[bi]; return { s: q.s, d: (x - q.p[0]) * Math.sin(q.h) - (y - q.p[1]) * Math.cos(q.h), q }; };
  const at = s0 => { const s = ((s0 % len) + len) % len; let lo = 0, hi = S.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (S[m].s <= s) lo = m; else hi = m - 1; } const a = S[lo], b = S[lo + 1] ?? S[0], f = b === S[0] ? (s - a.s) / Math.max(1e-6, len - a.s) : (s - a.s) / Math.max(1e-6, b.s - a.s);
    const dh = Math.atan2(Math.sin(b.h - a.h), Math.cos(b.h - a.h)); return { p: [0, 1, 2].map(j => a.p[j] + (b.p[j] - a.p[j]) * f), h: a.h + dh * f }; };
  return { len, project, at };
}
function placeFormations(spots, base, lines, roadZ = null, clockwise = false) {
  // (the base's line-ups across its line: mirrored when the base and this track run opposite ways round, so the
  // inside line stays the inside one)
  const ms = !!clockwise !== baseFlipped(base.lines.lines) ? -1 : 1;
  const B = base.lines.lines.find(l => l.group === 0), N = lines.find(l => l.group === 0); if (!B || !N) return null;
  const sb = lineSampler(B), sn = lineSampler(N); let moved = 0, tables = 0;
  spots.forEach((t, ti) => { if (ti === 0 || ti === 6 || ti === 1 || ti === 7 || !t.length || base.spots[ti].some(sp => sp.a === 1)) return;
    const P = base.spots[ti].map(sp => { const q = sb.project(sp.pos[0], sp.pos[1]); return { ...q, d: q.d * ms }; }), s0 = P[0].s;
    // (distances behind the first spot, unwrapped; a line-up longer than 90 % of this lap is pressed to fit)
    const back = P.map(q => { let d = s0 - q.s; if (d < -sb.len / 2) d += sb.len; if (d > sb.len / 2) d -= sb.len; return d; }), span = Math.max(1, ...back.map(Math.abs)), k = Math.min(1, 0.9 * sn.len / span);
    const n0 = s0 / sb.len * sn.len;
    t.forEach((sp, i) => { const o = base.spots[ti][i], q = P[i], m = sn.at(n0 - back[i] * k), r = m.h - q.q.h, ax = o.axes.map(Number);
      const pos = [m.p[0] + q.d * Math.sin(m.h), m.p[1] - q.d * Math.cos(m.h), 0]; pos[2] = roadZ?.(pos[0], pos[1]) ?? m.p[2];   // (on the road, as the stock ones are)
      t[i] = { ...sp, pos, axes: [...rot2(ax.slice(0, 3), r), ...rot2(ax.slice(3, 6), r), ...ax.slice(6, 9)] }; moved++; });
    tables++; });
  return `formations: ${moved} spots in ${tables} tables placed along the track's own middle line`;
}
function generateCollision(layout, baseSections, N, lines, log = () => {}, { pitWall = true } = {}) {
  const G = layout.geom, P = layout.points, n = P.length, Z = layout.z, nr = G.normals, ft = v => Number.isFinite(v);
  const T = P.map((_, i) => { const a = P[(i - 1 + n) % n], b = P[(i + 1) % n], tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1; return [tx / l, ty / l]; });
  const ground = (i, d) => { const g = layout.ground; if (!g?.z?.[i]) return Z[i] + Math.tan((layout.bank?.[i] ?? 0) * Math.PI / 180) * d; const row = g.z[i], f = Math.max(0, Math.min(row.length - 1, (d - g.d0) / g.step)), j = Math.min(row.length - 2, Math.floor(f)); return row[j] + (row[j + 1] - row[j]) * (f - j); };
  const xy = (i, d) => [P[i][0] + nr[i][0] * d, P[i][1] + nr[i][1] * d];
  const fill = a => { const k = a.map((v, i) => ft(v) ? i : -1).filter(i => i >= 0); if (!k.length) return a.map(() => null); return a.map((v, i) => ft(v) ? v : a[k.reduce((b, j) => Math.min(Math.abs(j - i), n - Math.abs(j - i)) < Math.min(Math.abs(b - i), n - Math.abs(b - i)) ? j : b, k[0])]); };
  const ein = fill(layout.edges.in), eout = fill(layout.edges.out);
  // walls beyond each edge (nearest face running along the track), with the top height there
  const along = (segs, i) => segs.filter(([a, b]) => { const ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey) || 1; return Math.abs(ex * T[i][0] + ey * T[i][1]) / l > 0.7; });
  // (the pit wall may stand in the walls mesh too (an NR2003 conversion writes every wall there): those faces are left
  // to addPitWall, which leaves openings where the pit lines cross; built here they shut the pit exit)
  const pw = G.pitWallSegs ?? [], onPitWall = (a, b) => { const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; return pw.some(([p, q]) => { const ex = q[0] - p[0], ey = q[1] - p[1], l2 = ex * ex + ey * ey || 1, t = Math.max(0, Math.min(1, ((m[0] - p[0]) * ex + (m[1] - p[1]) * ey) / l2)); return Math.hypot(p[0] + ex * t - m[0], p[1] + ey * t - m[1]) < 2; }); };
  G.wallSegs = G.wallSegs.filter(([a, b]) => !onPitWall(a, b));
  const grid = new Map(), cell = 80; G.wallSegs.forEach((sg, k) => { const x0 = Math.floor(Math.min(sg[0][0], sg[1][0]) / cell), x1 = Math.floor(Math.max(sg[0][0], sg[1][0]) / cell), y0 = Math.floor(Math.min(sg[0][1], sg[1][1]) / cell), y1 = Math.floor(Math.max(sg[0][1], sg[1][1]) / cell); for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const kk = x * 100003 + y; if (!grid.has(kk)) grid.set(kk, []); grid.get(kk).push(k); } });
  const wallHit = (i, sg, from) => { const o = P[i], dx = sg * nr[i][0], dy = sg * nr[i][1], cand = new Set();
    for (let t = 0; t <= 400; t += cell / 2) { const x = Math.floor((o[0] + dx * t) / cell), y = Math.floor((o[1] + dy * t) / cell); for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (const k of grid.get((x + a) * 100003 + y + b) ?? []) cand.add(k); }
    let best = null, top = -Infinity;
    for (const [p1, p2] of along([...cand].map(k => G.wallSegs[k]), i)) { const ex = p2[0] - p1[0], ey = p2[1] - p1[1], den = dx * ey - dy * ex; if (Math.abs(den) < 1e-9) continue;
      const t = ((p1[0] - o[0]) * ey - (p1[1] - o[1]) * ex) / den, u = ((p1[0] - o[0]) * dy - (p1[1] - o[1]) * dx) / den; if (u < -0.02 || u > 1.02 || t < from - 2 || t > 400) continue;
      const z = p1[2] + (p2[2] - p1[2]) * Math.max(0, Math.min(1, u));
      if (best === null || t < best - 0.3) { best = t; top = z; } else if (Math.abs(t - best) <= 0.3) top = Math.max(top, z); }
    return best === null ? null : { d: sg * best, top }; };
  const WO = P.map((_, i) => wallHit(i, 1, eout[i])), WI = P.map((_, i) => wallHit(i, -1, -ein[i]));
  // (how far in the stalls are along each row (the nearest stall within 300 ft): where a plain wall stands between
  // the track and the stalls (Iowa), the ground on the track's side of it is no pit road)
  const stallDepth = P.map(() => null); { const SP = layout.stallSpots ?? [], rowLen = Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]) || 10, reach = Math.round(300 / rowLen);
    const at = SP.map(q => { let bi = 0, bd = Infinity; P.forEach((p, i) => { const e = (p[0] - q.x) ** 2 + (p[1] - q.y) ** 2; if (e < bd) { bd = e; bi = i; } }); return { i: bi, d: (q.x - P[bi][0]) * nr[bi][0] + (q.y - P[bi][1]) * nr[bi][1] }; });
    for (let i = 0; i < n; i++) { let best = null, bk = Infinity; for (const q of at) { const k = Math.min(Math.abs(q.i - i), n - Math.abs(q.i - i)); if (k < bk && k <= reach) { bk = k; best = q.d; } } stallDepth[i] = best; } }
  if (process.env.NT04_DEBUG_PIT) for (let i = 0; i < n; i += 20) log(`row ${i} wi ${WI[i]?.d?.toFixed(1)} stall ${stallDepth[i]?.toFixed(1)} ein ${ein[i]?.toFixed(1)}`);
  // the infield's reach on the left: short of where the rows from across the infield come (half the way across) and
  // of the turn's centre (0.8 of the radius)
  const head = T.map(t => Math.atan2(t[1], t[0])), cl = P.map((p, i) => [p, P[(i + 1) % n], i]);
  const reach = P.map((_, i) => { let best = 400; const o = P[i], dx = -nr[i][0], dy = -nr[i][1];
    for (const [p1, p2, j] of cl) { if (Math.min(Math.abs(j - i), n - Math.abs(j - i)) < 6) continue; const ex = p2[0] - p1[0], ey = p2[1] - p1[1], den = dx * ey - dy * ex; if (Math.abs(den) < 1e-9) continue;
      const t = ((p1[0] - o[0]) * ey - (p1[1] - o[1]) * ex) / den, u = ((p1[0] - o[0]) * dy - (p1[1] - o[1]) * dx) / den; if (u >= 0 && u <= 1 && t > 0) best = Math.min(best, t / 2); }
    const k = 4, dh = ((head[(i + k) % n] - head[(i - k + n) % n] + 3 * Math.PI) % (2 * Math.PI)) - Math.PI, ds = Math.hypot(P[(i + k) % n][0] - P[(i - k + n) % n][0], P[(i + k) % n][1] - P[(i - k + n) % n][1]);
    if (dh > 1e-4) best = Math.min(best, 0.8 * ds / dh); return best; });
  const gReach = layout.ground ? -layout.ground.d0 : 120;
  const pitReach = P.map((_, i) => { let m = 0; const w = Math.round(400 / (Math.hypot(P[1][0] - P[0][0], P[1][1] - P[0][1]) || 10)); for (let q = -w; q <= w; q++) { const f = layout.pit?.far?.[(i + q + n) % n]; if (ft(f)) m = Math.max(m, -f + 25); } return m; });
  // the points across each row
  const K = 14, rows = P.map((_, i) => {
    const eIn = ein[i], eOut = eout[i], pn = layout.pit?.near?.[i], pf = layout.pit?.far?.[i], wi = WI[i]?.d ?? null;
    // (out past pit road's far side wherever it is within 400 ft along the lap: the pit lanes ease off and on beyond
    // pit_area's ends, and a car there had no ground under it at Wilkesboro's pit exit)
    let lim = -Math.min(reach[i], gReach, Math.max(90, wi !== null ? -wi + 12 : 0, pitReach[i])); lim = Math.min(lim, eIn - 6);
    if (ft(pf)) lim = Math.min(lim, pf - 6);   // (at least past pit road's far side: Iowa's ground stops at the wall pit road lies behind)
    let far, stall, near;
    if (ft(pn) && ft(pf) && pf > lim + 2 && pn < eIn) { far = pf; near = pn; let sb = far; for (let d = far; d <= near; d += 0.5) { const q = xy(i, d); if (G.typeAt(q[0], q[1]) === 3) sb = d; else if (sb !== far) break; } stall = sb; }
    else { far = stall = near = (lim + eIn) / 2; }
    if (wi !== null && ft(pn) && wi < near - 1 && wi > far + 1 && stallDepth[i] !== null && stallDepth[i] < wi - 4) { near = wi - 0.5; stall = Math.min(stall, near); }
    if (process.env.NT04_DEBUG_PIT && i % 20 === 0) log(`rowpit ${i} pn ${pn} pf ${pf} lim ${lim.toFixed(1)} far ${far?.toFixed(1)} stall ${stall?.toFixed(1)} near ${near?.toFixed(1)} wi ${wi}`);   // (a plain wall between the track and the stalls (Iowa): pit road starts behind it)
    const outer = WO[i] ? WO[i].d + 1.5 : eOut + 40;
    const d = [lim, lim + (far - lim) / 3, lim + 2 * (far - lim) / 3, far, stall, near, (near + eIn) / 2, eIn, eIn + (eOut - eIn) / 4, eIn + (eOut - eIn) / 2, eIn + 3 * (eOut - eIn) / 4, eOut, (eOut + outer) / 2, outer];
    for (let k = 1; k < K; k++) if (d[k] < d[k - 1]) d[k] = d[k - 1];
    return d.map((dd, k) => { const q = xy(i, dd), road = k >= 7 && k <= 11, rz = road ? G.roadZ(...xy(i, dd + (k === 7 ? 0.02 : k === 11 ? -0.02 : 0))) : null; return { d: dd, p: [q[0], q[1], rz ?? ground(i, dd)], road }; }); });
  // sections: the track's own, even lengths along the lap from row 0 (stock tracks have 33 to 106, 44 to 141 ft
  // long, 110 typical: about 110 ft each here, 33 to 106 of them; NT04_SECTION_FT sets the length). With
  // NT04_BASE_SECTIONS=1 the base's count, boundaries at rows near where the base's (bent) ones fall, as before.
  const segLen = P.map((p, i) => Math.hypot(P[(i + 1) % n][0] - p[0], P[(i + 1) % n][1] - p[1])), lap = segLen.reduce((a, b) => a + b, 0);
  let rowSec, nS;
  if (process.env.NT04_BASE_SECTIONS) {
    nS = baseSections.length; const inSec = (s, x, y) => { const t = pl => pl[0] * x + pl[1] * y + pl[3] >= -1; return t(s.start.map(Number)) && t(s.end.map(Number)); };
    rowSec = P.map((p, i) => { let best = -1, bd = Infinity; baseSections.forEach((s, k) => { if (!inSec(s, p[0], p[1])) return; const b = s.bounds.map(Number), dd = ((b[0] + b[2]) / 2 - p[0]) ** 2 + ((b[1] + b[3]) / 2 - p[1]) ** 2; if (dd < bd) { bd = dd; best = k; } }); return best; });
    // (runs: each section a contiguous run of rows in ring order; rows that fell in none take their neighbour's)
    for (let it = 0; it < n && rowSec.some(v => v < 0); it++) for (let i = 0; i < n; i++) if (rowSec[i] < 0) rowSec[i] = rowSec[(i - 1 + n) % n] >= 0 ? rowSec[(i - 1 + n) % n] : rowSec[(i + 1) % n];
    if (rowSec.every(v => v < 0)) rowSec.fill(0);
    for (let i = 0; i < n; i++) { const a = rowSec[(i - 1 + n) % n], b = rowSec[(i + 1) % n]; if (a === b && rowSec[i] !== a) rowSec[i] = a; }   // (single stray rows)
  } else {
    nS = Math.max(33, Math.min(106, Math.round(lap / +(process.env.NT04_SECTION_FT ?? 110)), n));
    let at = 0; rowSec = P.map((_, i) => { const k = Math.min(nS - 1, Math.floor((at + segLen[i] / 2) / lap * nS)); at += segLen[i]; return k; });
  }
  const vertices = [], vIdx = rows.map(r => r.map(q => { vertices.push(q.p); return vertices.length - 1; })), vsum = vertices.map(() => [0, 0, 0]);
  const sections = Array.from({ length: nS }, (_, k) => ({ bounds: [0, 0, 0, 0], extra: [0, 0], start: null, end: null, surface: [], B: [], apron: [], walls: { inner: [], outer: [], other: [] }, raw: baseSections[k % baseSections.length].raw, _rows: [] }));
  for (let i = 0; i < n; i++) sections[rowSec[i]]._rows.push(i);
  const area2 = (a, b, c) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  let cnt = { 0: 0, 1: 0, 3: 0, 6: 0, 7: 0 };
  const rowTris = P.map(() => []), rowWalls = P.map(() => []);
  for (let i = 0; i < n; i++) { const j = (i + 1) % n, sec = sections[rowSec[i]], dir = [T[i][0], T[i][1], 0];
    for (let k = 0; k + 1 < K; k++) { const quad = [vIdx[i][k], vIdx[j][k], vIdx[j][k + 1], vIdx[i][k + 1]];
      // (counter-clockwise seen from above, as every stock triangle is: the game's inside-the-triangle test goes by
      // the winding, and clockwise ones (the rows run the other way round) are not found under a car: at Wilkesboro
      // the field bounced off the ground's edges in turn 1)
      for (let t of [[quad[0], quad[1], quad[2]], [quad[0], quad[2], quad[3]]]) { let A = vertices[t[0]], B = vertices[t[1]], C = vertices[t[2]]; if (area2(A, B, C) < 0.5) continue;
        if ((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]) < 0) { t = [t[0], t[2], t[1]]; [B, C] = [C, B]; }
        const c = [0, 1, 2].map(m => (A[m] + B[m] + C[m]) / 3); let ty = rows[i][k].road && rows[i][k + 1].road ? 0 : G.typeAt(c[0], c[1], c[2]);
        if (ty === null || (ty === 0 && !(rows[i][k].road && rows[i][k + 1].road))) ty = Math.abs(rows[i][k].d) < Math.max(Math.abs(ein[i]), eout[i]) + 30 ? 6 : 7;
        // (the whole of pit road is type 3 in the stock files (Lowe's: from 155 ft before the pit lanes start to their end,
        // lanes and stalls alike); the game's pit flag (race table +9, 0xB9840) is "the car is on type 3", and a car in
        // pit-in (state 5) that drives off it is handed back (0x2A440): the generated pit_area as 1 let the bot's car go
        // after 0.5 s. Type 1 at Lowe's is the paved infield around the track. NT04_PIT_TYPE1=1: pit_area as 1, as before)
        if (ty === 1 && !process.env.NT04_PIT_TYPE1) ty = 3;
        if ((ty === 1 || ty === 3) && WI[i] && stallDepth[i] !== null && stallDepth[i] < WI[i].d - 4 && (rows[i][k].d + rows[i][k + 1].d) / 2 > WI[i].d) ty = 6;
        const pl = unitPlane(A, B, C); for (const v of t) { vsum[v][0] += pl[0]; vsum[v][1] += pl[1]; vsum[v][2] += pl[2]; }
        const tri = { v: t, pad: 0, dir, plane: pl, type: ty, rt: 0 }, list = ty === 0 || ty === 6 ? "surface" : "apron"; sec[list].push(tri); rowTris[i].push([list, tri]); cnt[ty] = (cnt[ty] ?? 0) + 1; } } }
  const verts = vertices.map((p, i) => { const a = vsum[i], l = Math.hypot(...a) || 1, m = l > 1e-9 ? a.map(v => v / l) : [0, 0, 1]; return { x: p[0], y: p[1], plane: [m[0], m[1], m[2], -(m[0] * p[0] + m[1] * p[1] + m[2] * p[2])] }; });
  // walls
  const points = [], walls = { outer: [], inner: [] };
  const panel = (kind, ia, ib, wa, wb) => { const za = ground(ia, wa.d), zb = ground(ib, wb.d), pa = xy(ia, wa.d), pb = xy(ib, wb.d), ta = Math.max(wa.top, za + 2.5), tb = Math.max(wb.top, zb + 2.5);
    const b0 = [pa[0], pa[1], za - 0.5], b1 = [pb[0], pb[1], zb - 0.5], t0 = [pa[0], pa[1], ta], t1 = [pb[0], pb[1], tb]; let pl = unitPlane(b0, b1, t0, false);
    const m = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2], c = P[ia]; if (pl[0] * c[0] + pl[1] * c[1] + pl[3] < 0) pl = pl.map(v => -v);   // (facing the track)
    points.push(t0, t1, b0, b1); const k = points.length; return { top: [k - 4, k - 3], bottom: [k - 2, k - 1], plane: pl, topZ: Math.max(ta, tb), kind, z20: 0, a: 0, c: 0, _sec: rowSec[ia], _m: m }; };
  for (let i = 0; i < n; i++) { const j = (i + 1) % n;
    // (the track on each panel's left: counter-clockwise the outer wall runs with the lap and the inner against it;
    // clockwise (the outer wall on the left) the other way round)
    const cwl = !!layout.flipped;
    if (WO[i] && WO[j] && Math.abs(WO[i].d - WO[j].d) < 6) walls.outer.push({ ...(cwl ? panel(8, j, i, WO[j], WO[i]) : panel(8, i, j, WO[i], WO[j])), _i: i, _sec: rowSec[i] });
    if (WI[i] && WI[j] && Math.abs(WI[i].d - WI[j].d) < 6) walls.inner.push({ ...(cwl ? panel(12, i, j, WI[i], WI[j]) : panel(12, j, i, WI[j], WI[i])), _i: i, _sec: rowSec[i] });
  }
  // into their sections' lists, then the chain links (previous / next panel along the wall; -1 at the ends)
  for (const [k, list] of Object.entries(walls)) for (const w of list) { const s = sections[w._sec]; w._at = [w._sec, s.walls[k].length]; s.walls[k].push(w); }
  const none = 0xffff, packed = at => at ? ((at[1] & 0xffff) | ((at[0] & 0xffff) << 16)) >>> 0 : (none | none << 16) >>> 0;
  for (const [k, list] of Object.entries(walls)) { const byRow = new Map(list.map(w => [w._i, w]));
    for (const w of list) { const fw = (k === "outer") !== !!layout.flipped, nextRow = fw ? (w._i + 1) % n : (w._i - 1 + n) % n, prevRow = fw ? (w._i - 1 + n) % n : (w._i + 1) % n, nx = byRow.get(nextRow), pv = byRow.get(prevRow);
      w.z20 = packed(pv?._at); w.a = nx ? nx._at[1] : none; w.c = nx ? nx._at[0] : none; } }
  for (const s of sections) for (const [k, list] of Object.entries(s.walls)) for (let q = 0; q < list.length; q++) { const { _sec, _m, _i, _at, ...w } = list[q]; list[q] = w; rowWalls[_i].push([k, w]); }
  // (sections overlap, as the stock ones do (Lowe's: a quarter of the triangles and half the wall panels lie past
  // their section's planes): each also holds the rows up to OVERLAP ft beyond either end, the same triangles and
  // panels again (a panel's links still name the first copy). Without it a car across a boundary has part of its
  // ground and walls in the other section: at Wilkesboro (sections 43 ft long) cars bounced back off nothing at
  // the boundaries in turn 1 and the field stopped there)
  const OVERLAP = +(process.env.NT04_SECTION_OVERLAP ?? 60), rowLen = segLen;
  if (OVERLAP > 0) sections.forEach(s => { if (!s._rows.length) return; const own = new Set(s._rows), R = [...own].sort((a, b) => a - b);
    let gap = -1; for (let q = 1; q < R.length; q++) if (R[q] !== R[q - 1] + 1) gap = q; const run = gap < 0 ? R : [...R.slice(gap), ...R.slice(0, gap)];
    const extra = []; for (let d = 0, i = (run[0] - 1 + n) % n; d < OVERLAP && !own.has(i); d += rowLen[i], i = (i - 1 + n) % n) extra.push(i);
    for (let d = 0, i = (run.at(-1) + 1) % n; d < OVERLAP && !own.has(i); d += rowLen[i], i = (i + 1) % n) extra.push(i);
    for (const i of extra) { for (const [list, t] of rowTris[i]) s[list].push(t); for (const [k, w] of rowWalls[i]) s.walls[k].push({ ...w }); } });
  // section planes and bounds
  sections.forEach((s, k) => { const R = s._rows.sort((a, b) => a - b); let r0, r1;
    if (!R.length) { const prev = sections.slice(0, k).reverse().find(x => x._rows.length); r0 = r1 = prev ? (Math.max(...prev._rows) + 1) % n : 0; }
    else { // (a run that wraps past row 0)
      let gap = -1; for (let q = 1; q < R.length; q++) if (R[q] !== R[q - 1] + 1) gap = q; const run = gap < 0 ? R : [...R.slice(gap), ...R.slice(0, gap)]; r0 = run[0]; r1 = (run.at(-1) + 1) % n; }
    const pl = (i, sg) => { const tx = sg * T[i][0], ty = sg * T[i][1]; return [tx, ty, 0, -(tx * P[i][0] + ty * P[i][1])]; };
    s.start = pl(r0, 1); s.end = pl(r1, -1);
    let mn = [Infinity, Infinity], mx = [-Infinity, -Infinity]; const grow = p => { mn = [Math.min(mn[0], p[0]), Math.min(mn[1], p[1])]; mx = [Math.max(mx[0], p[0]), Math.max(mx[1], p[1])]; };
    for (const t of [...s.surface, ...s.apron]) for (const v of t.v) grow(vertices[v]); for (const list of Object.values(s.walls)) for (const w of list) for (const q of [...w.top, ...w.bottom]) grow(points[q]);
    s.bounds = mn[0] === Infinity ? [P[r0][0], P[r0][1], P[r0][0], P[r0][1]] : [mn[0], mn[1], mx[0], mx[1]]; delete s._rows; });
  const C = { vertices: verts, points, sections };
  if (pitWall && Array.isArray(layout.pitWall) && layout.pitWall.length) addPitWall(C, layout.pitWall, N, lines, log);
  log(`collision from the physics file: ${verts.length} points, ${cnt[0]} road, ${cnt[6]} apron, ${cnt[1]} pit road, ${cnt[3]} stall, ${cnt[7]} grass triangles; walls ${walls.outer.length} outer, ${walls.inner.length} inner panels; ${nS} sections`);
  if (verts.length > 65535 || points.length > 65535) throw new Error("the physics file makes too many collision points (over 65535)");
  // what the lines' profiles measure, per row (centre-line frame, feet, right +): racing surface edges (the outer one
  // no farther than the outer wall), the inner edge of the paved apron, the inner limit (the nearest of the inner
  // wall, the pit wall and the stall boxes) and the outer wall
  const pwSegs = (layout.pitWall ?? []).flatMap(r => r.slice(1).map((q, k) => [r[k], q]));
  const feat = P.map((_, i) => { const e1 = ein[i], e6 = WO[i]?.d ?? eout[i], e2 = Math.min(eout[i], e6);
    let e3 = e1; for (let d = e1 - 0.5; d > e1 - 300; d -= 1) { const q = xy(i, d), ty = G.typeAt(q[0], q[1]); if (ty !== 0 && ty !== 6) break; e3 = d; }
    let e5 = WI[i]?.d ?? -Infinity; for (const [a, b] of pwSegs) { const dx = -nr[i][0], dy = -nr[i][1], ex = b[0] - a[0], ey = b[1] - a[1], den = dx * ey - dy * ex; if (Math.abs(den) < 1e-9) continue;
      const t = ((a[0] - P[i][0]) * ey - (a[1] - P[i][1]) * ex) / den, u = ((a[0] - P[i][0]) * dy - (a[1] - P[i][1]) * dx) / den; if (u >= 0 && u <= 1 && t > -e1 - 2 && t < 400) e5 = Math.max(e5, -t); }
    for (let d = e1; d > Math.max(e5, e1 - 400); d -= 1) { const q = xy(i, d); if (G.typeAt(q[0], q[1]) === 3) { e5 = Math.max(e5, d); break; } }
    if (!Number.isFinite(e5)) e5 = e3 - 60; return { e1, e2, e3, e5, e6 }; });
  return { collision: C, rowSec, rows, feat };
}

// The lines' profiles (tkphys: 7 arrays of s16 inches, 7 samples a segment + 1, at t = k / 7): worked out from the track
// (generateCollision's per-row features), in the racing line's frame, as the stock files hold them (read off Lowe's):
//   0  the line's own sideways place from the racing line (group 0; left negative)
//   1 / 3 / 5  the distance in to the racing surface's inner edge / the paved edge / the inner limit, negative
//   2 / 6  the distance out to the racing surface's outer edge / the outer wall, positive; 4: 2 at the segment's start
// (Bent along from the base, they were the base track's own distances: Lowe's 42 ft racing surface and inner walls
// 100-190 ft in.)
function profilesFromTrack(lines, layout, feat) {
  const P = layout.points, n = P.length, nr = layout.geom.normals, cell = 60, grid = new Map();
  P.forEach((p, i) => { const k = Math.floor(p[0] / cell) * 100003 + Math.floor(p[1] / cell); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
  const near = (x, y) => { let bi = -1, bd = Infinity; const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    for (let r = 1; r <= 8 && bi < 0; r++) for (let a = gx - r; a <= gx + r; a++) for (let b = gy - r; b <= gy + r; b++) for (const i of grid.get(a * 100003 + b) ?? []) { const d = (P[i][0] - x) ** 2 + (P[i][1] - y) ** 2; if (d < bd) { bd = d; bi = i; } }
    if (bi < 0) P.forEach((p, i) => { const d = (p[0] - x) ** 2 + (p[1] - y) ** 2; if (d < bd) { bd = d; bi = i; } }); return bi; };
  const lat = (x, y) => { const i = near(x, y); return { i, d: (x - P[i][0]) * nr[i][0] + (y - P[i][1]) * nr[i][1] }; };
  // the racing line's sideways place per row
  const R = lines.find(l => l.group === 0), rl = Array(n).fill(null);
  R.segments.forEach((sg, s) => { for (let k = 0; k < 40; k++) { const p = bez(R.points[2 * s], R.points[2 * s + 1], R.points[2 * s + 2], k / 40), q = lat(p[0], p[1]); rl[q.i] = q.d; } });
  { const known = rl.map((v, i) => v === null ? -1 : i).filter(i => i >= 0); for (let i = 0; i < n; i++) if (rl[i] === null) { let b = known[0]; for (const k of known) if (Math.min(Math.abs(k - i), n - Math.abs(k - i)) < Math.min(Math.abs(b - i), n - Math.abs(b - i))) b = k; rl[i] = rl[b]; } }
  const inch = v => Math.max(-32767, Math.min(32767, Math.round(v * 12)));
  for (const l of lines) { const ns = l.segments.length, prof = [0, 1, 2, 3, 4, 5, 6].map(() => []);
    for (let s = 0; s < ns; s++) { let e2start = null;
      for (let k = 0; k < (s === ns - 1 ? 8 : 7); k++) { const p = bez(l.points[2 * s], l.points[2 * s + 1], l.points[2 * s + 2], k / 7), q = lat(p[0], p[1]), f = feat[q.i], r = rl[q.i], p0 = q.d - r;
        const e = { 1: f.e1 - r, 2: f.e2 - r, 3: f.e3 - r, 5: f.e5 - r, 6: f.e6 - r }; if (k === 0) e2start = e[2];
        // (the profiles are left / right of the line (Watkins Glen, clockwise: p1 / p3 / p5 on its left = outside);
        // e1 / e3 / e5 here are on the infield side: the left counter-clockwise, the right clockwise)
        if (!layout.flipped) { prof[0].push(inch(p0)); prof[1].push(inch(-Math.abs(e[1] - p0))); prof[2].push(inch(Math.abs(e[2] - p0))); prof[3].push(inch(-Math.abs(e[3] - p0)));
          prof[4].push(inch(Math.abs(e2start - p0))); prof[5].push(inch(-Math.abs(e[5] - p0))); prof[6].push(inch(Math.abs(e[6] - p0))); }
        else { if (k === 0) e2start = e[1]; prof[0].push(inch(-p0)); prof[1].push(inch(-Math.abs(e[2] - p0))); prof[2].push(inch(Math.abs(e[1] - p0))); prof[3].push(inch(-Math.abs(e[2] - p0)));
          prof[4].push(inch(Math.abs(e2start - p0))); prof[5].push(inch(-Math.abs(e[6] - p0))); prof[6].push(inch(Math.abs(e[5] - p0))); } } }
    if (prof[0].length === l.profile[0].length) l.profile = prof; }
}

// AI speed nodes (positions: segment + t, as the lines' own nodes) moved with lines rebuilt by linegen.mjs
function mapAINodes(groups, lines, map) {
  if (!map) return groups; const byG = []; for (let g = 0; g < 19; g++) byG.push([]); lines.forEach((l, i) => byG[l.group].push(i));
  return groups.map((ls, g) => ls.map((line, i) => line.nodes ? { ...line, nodes: line.nodes.map(nd => ({ ...nd, at: map(byG[g][i], nd.at) })) } : line));
}

// lap fractions of every line's segments, measured on the racing line (group 0), as warpPhys works them out (after lines
// from two warps are put together)
function refrac(lines, orig) {
  const R = lines.find(l => l.group === 0), samp = [], total = R.segments.at(-1).end;
  R.segments.forEach((sg, i) => { for (let k = 0; k < 24; k++) samp.push({ p: bez(R.points[2 * i], R.points[2 * i + 1], R.points[2 * i + 2], k / 24), d: (i ? R.segments[i - 1].end : 0) + sg.length * k / 24 }); });
  const fracOf = p => { let best = Infinity, d = 0; for (const q of samp) { const dd = (q.p[0] - p[0]) ** 2 + (q.p[1] - p[1]) ** 2; if (dd < best) { best = dd; d = q.d; } } return (d / total) % 1; };
  R.segments.forEach((sg, i) => { sg.frac = (i ? R.segments[i - 1].end : 0) / total; }); R.fracEnd = R.segments[0].frac;
  lines.forEach((l, li) => { if (l === R) return; l.segments.forEach((sg, i) => { sg.frac = fracOf(l.points[2 * i]); });
    const closed = Math.hypot(l.points[0][0] - l.points.at(-1)[0], l.points[0][1] - l.points.at(-1)[1]) < 5; l.fracEnd = closed ? l.segments[0].frac : fracOf(l.points.at(-1)); });
}

export function warpTrack({ data, baseRend, basePhys, layout }) {
  if (layout.ground?.z && !layout.groundAt) Object.defineProperty(layout, "groundAt", { value: groundFromGrid(layout), enumerable: false });
  const pb = readTerfEntry(nodeFs, join(data, "TK_PHYS.DAT"), basePhys), doc = physDocument(pb), zAt = heightField(doc.collision);
  const B = baseFrame(doc, zAt), N = layoutFrame(layout, B), M = makeMapper(B, N), warpLog = [];
  // the base's pit road (line group 11, its pit lanes: start and end located on its centre) to the track's
  // (layout.pitLane: lap fractions where pit road begins and ends, track.ini pit_lane_start / end_dlong)
  // a layout read from glTF builds its collision and lines from the track's own files (generateCollision, linegen.mjs);
  // the base track then only gives the file's structure, its cameras and formations, carried along without a lap remap
  const own = !!(layout.geom && !process.env.NT04_WARP_COLLISION && !process.env.NT04_BENT_LINES);
  const g11 = own ? [] : doc.lines.lines.filter(l => l.group === 11); let pitMoved = !(Array.isArray(layout.pitLane) && layout.pitLane.length === 2), pitStretch = 1;
  if (Array.isArray(layout.pitLane) && layout.pitLane.length === 2 && g11.length) {
    const st = g11.map(l => M.locate(l.points[0][0], l.points[0][1]).s), en = g11.map(l => M.locate(l.points.at(-1)[0], l.points.at(-1)[1]).s);
    const b0 = st.reduce((a, v) => a + v, 0) / st.length, b1 = en.reduce((a, v) => a + v, 0) / en.length, [n0, n1] = layout.pitLane.map(v => ((v % 1) + 1) % 1);
    const wb = b0 > b1, wn = n0 > n1;
    const K = [[0, 0], [b0, n0], [b1, n1]].sort((x, y) => x[0] - y[0]); K.push([1, 1]);
    const stretch = Math.max(...K.slice(1).map((k, i) => { const r = (k[1] - K[i][1]) / ((k[0] - K[i][0]) || 1e-9); return Math.max(r, 1 / r); }));
    // (not past 2.5 times longer or shorter anywhere: Wilkesboro's pit road starts in turn 3, 0.599, Lowe's 0.904; the
    // base's front stretch drawn out 4.2 times, with the track's grid on it, left 32 of 43 cars past 0.9 laps in 120 s
    // against 42 without the move)
    if (wb === wn && (stretch <= 2.5 || (layout.geom && process.env.NT04_SPLIT_PIT))) {
      M.remap.f = s => { const u = ((s % 1) + 1) % 1; for (let i = 0; i + 1 < K.length; i++) if (u <= K[i + 1][0]) { const [x0, y0] = K[i], [x1, y1] = K[i + 1]; return y0 + (y1 - y0) * (u - x0) / ((x1 - x0) || 1); } return u; };
      warpLog.push(`pit road: the base's ${b0.toFixed(3)}..${b1.toFixed(3)} of the lap -> the track's ${n0.toFixed(3)}..${n1.toFixed(3)}${stretch > 2.5 ? ` (pit lines only: x${stretch.toFixed(1)})` : ""}`); pitMoved = true; pitStretch = stretch; }
    else warpLog.push(`pit road: the track's (${n0.toFixed(3)}..${n1.toFixed(3)}) ${wb !== wn ? "and the base's are not on the same side of the line" : `is too far from the base's (${b0.toFixed(3)}..${b1.toFixed(3)}: x${stretch.toFixed(1)})`}; left at the base's place`); }
  // With a physics file of the track's own (its collision built from it, below), only the pit lines and the spots on
  // pit road follow the moved pit road (M); the rest of the lap is carried along as it is (Mn: no lap remap), so the
  // racing lines, grid and cameras are not stretched when pit road sits far from the base's (Wilkesboro: pit road
  // from turn 3, the base's front stretch x4.2).
  const split = !!(layout.geom && pitMoved && pitStretch > 2.5 && process.env.NT04_SPLIT_PIT && Array.isArray(layout.pitLane));   // (trial: NT04_SPLIT_PIT=1; Wilkesboro 25 of 43 against 40 bent, see the notes)
  const Mn = split ? makeMapper(B, N) : M;
  const nd = warpPhys(doc, Mn, N, B); let lineMap = null;
  if (split) { const np = warpPhys(doc, M, N, B), PIT = l => l.group >= 3 && l.group <= 11;
    nd.lines.lines = nd.lines.lines.map((l, i) => PIT(l) ? np.lines.lines[i] : l); refrac(nd.lines.lines, doc.lines.lines);
    // spots within 30 ft of a base stall's stop (the end of its group 9 path): pit crew and box places (not the
    // formations before the line, which at the base lie beside its pit road)
    const stops = doc.lines.lines.filter(l => l.group === 9).map(l => l.points.at(-1)), onPit = p => stops.some(q => Math.hypot(q[0] - p[0], q[1] - p[1]) < 30);
    let moved = 0; nd.spots = nd.spots.map((t, ti) => t.map((sp, k) => { if (ti !== 0 && onPit(doc.spots[ti][k].pos)) { moved++; return np.spots[ti][k]; } return sp; }));
    warpLog.push(`pit lines and ${moved} pit spots moved to the track's pit road; the rest of the lap as it is`); }
  // a physics file of the track's own (gltf-layout.mjs): its collision layer built from it, not bent from the base's
  // (only while the base's pit lines land on the track's pit road: where they could not be moved there (Wilkesboro's
  // pit road starts in turn 3) they would cross the track's own walls, so the collision stays bent along with them:
  // 29 of 43 cars past 0.9 laps in 120 s against 40)
  if (own) {
    const g = generateCollision(layout, nd.collision.sections, N, nd.lines.lines, m => warpLog.push(m), { pitWall: false }); nd.collision = g.collision;
    const base9 = doc.lines.lines.filter(l => l.group === 9);
    const L = generateLines(nd.lines.lines, doc.lines.lines, layout, g, m => warpLog.push(m)); nd.lines.lines = L.lines; refrac(nd.lines.lines, doc.lines.lines); lineMap = L.nodeMap;
    if (Array.isArray(layout.pitWall) && layout.pitWall.length) addPitWall(nd.collision, layout.pitWall, N, nd.lines.lines, m => warpLog.push(m));
    if (!process.env.NT04_KEEP_PROFILES) profilesFromTrack(nd.lines.lines, layout, g.feat);
    // pit crew / box places (spots with +0x34 = 1: Lowe's table 1, two rows of 22 behind the stalls, and table 7), each
    // put at the same place beside the track's stall as beside the base stall nearest it (the stall path's end and heading)
    const baseCW = baseFlipped(doc.lines.lines);
    const new9 = nd.lines.lines.filter(l => l.group === 9), end = l => { const p = l.points, a = p.at(-2), b = p.at(-1); return { p: b, h: Math.atan2(b[1] - a[1], b[0] - a[0]) }; };
    if (base9.length && new9.length === base9.length) { const B9 = base9.map(end), N9 = new9.map(end); let moved = 0;
      nd.spots = nd.spots.map((t, ti) => ti === 0 ? t : t.map((sp, k) => { const o = doc.spots[ti][k].pos; if (doc.spots[ti][k].a !== 1 && ti !== 1 && ti !== 7) return sp; /* (tables 1 and 7 are the crews' at every stock track: Watkins Glen's have +0x34 = 0) */ let bi = -1, bd = Infinity; B9.forEach((q, j) => { const d = Math.hypot(q.p[0] - o[0], q.p[1] - o[1]); if (d < bd) { bd = d; bi = j; } }); if (bi < 0) return sp;
        // (in the base stall's frame (forward along its path's end, left), into the track's stall's; mirrored when the base
        // and this track run opposite ways round (pit road on the other side))
        const b = B9[bi], q = N9[bi], ms = !!layout.flipped !== baseCW ? -1 : 1, ax = sp.axes.map(Number);
        const loc = v => [v[0] * Math.cos(b.h) + v[1] * Math.sin(b.h), ms * (-v[0] * Math.sin(b.h) + v[1] * Math.cos(b.h))], put = l => [l[0] * Math.cos(q.h) - l[1] * Math.sin(q.h), l[0] * Math.sin(q.h) + l[1] * Math.cos(q.h)];
        const dl = put(loc([o[0] - b.p[0], o[1] - b.p[1]])), A0 = doc.spots[ti][k].axes.map(Number), f = [...put(loc(A0.slice(0, 2))), A0[2]], rt = [...put(loc(A0.slice(3, 5))), A0[5]];
        moved++; return { ...sp, pos: [q.p[0] + dl[0], q.p[1] + dl[1], q.p[2] + (o[2] - b.p[2])], axes: [...f, ...rt, ...ax.slice(6, 9)] }; }));
      warpLog.push(`pit spots: ${moved} placed beside the track's stalls`); }
    if (!process.env.NT04_BENT_FORMATIONS) { const r = placeFormations(nd.spots, doc, nd.lines.lines, layout.geom?.roadZ, layout.flipped); if (r) warpLog.push(r); }
    const near = (x, y) => { let bi = 0, bd = Infinity; layout.points.forEach((p, i) => { const d = (p[0] - x) ** 2 + (p[1] - y) ** 2; if (d < bd) { bd = d; bi = i; } }); return bi; };
    nd.spots = nd.spots.map(t => t.map(sp => ({ ...sp, section: g.rowSec[near(sp.pos[0], sp.pos[1])] })));
  }
  if (!own && layout.geom && !pitMoved) warpLog.push("collision: bent from the base track (its pit lines could not be moved to this pit road)");
  if (!own && layout.geom && pitMoved && !process.env.NT04_WARP_COLLISION) { const g = generateCollision(layout, nd.collision.sections, N, nd.lines.lines, m => warpLog.push(m)); nd.collision = g.collision; if (!process.env.NT04_KEEP_PROFILES) { profilesFromTrack(nd.lines.lines, layout, g.feat); warpLog.push("line profiles: worked out from the track"); }
    // (spots and lines keep their sections: each spot the section of the row nearest it)
    const near = (x, y) => { let bi = 0, bd = Infinity; layout.points.forEach((p, i) => { const d = (p[0] - x) ** 2 + (p[1] - y) ** 2; if (d < bd) { bd = d; bi = i; } }); return bi; };
    nd.spots = nd.spots.map(t => t.map(sp => ({ ...sp, section: g.rowSec[near(sp.pos[0], sp.pos[1])] }))); }
  if (layout.grid?.cars?.length) setGrid(nd, layout.grid, warpLog); const phys = physFromDocument(nd);
  // the base track's record lap (TRCK.TQRT of the row using this physics entry), the yardstick for the AI's pace
  let baseRecordLap = null; try { const db = parseDb(nodeFs.readFileSync(join(data, "NASCAR.DB"))), row = db.tables.get("TRCK").rows.find(r => r.TPID === basePhys); if (row?.TQRT > 0) baseRecordLap = row.TQRT; } catch {}
  const aiLog = []; const ai = writeAISpeeds(mapAINodes(warpAI(parseAISpeeds(readTerfEntry(nodeFs, join(data, "AI_SPDS.DAT"), basePhys)), doc.lines.lines, nd.lines.lines, B, N, M, { pitSpeed: layout.pitSpeed ?? null, paceSpeed: layout.paceSpeed ?? null, recordLap: layout.recordLap ?? null, baseRecordLap, log: m => aiLog.push(m) }), nd.lines.lines, lineMap));
  const rend = baseRend === null || baseRend === undefined ? null : warpRend(readTerfEntry(nodeFs, join(data, "TK_REND.DAT"), baseRend), M, zAt);
  const R = nd.lines.lines.find(l => l.group === 0);
  return { phys, ai, rend, info: { baseLength: B.len, newLength: N.len, racingLine: R.segments.at(-1).end, miles: N.len / 5280, ai: [...warpLog, ...(N.notes ?? []), ...aiLog] }, frames: { B, N }, doc: nd, base: doc, mapper: M };
}

export async function centrelineFromGLTF(file, opts = {}) {
  const { readGLTF } = await import("./gltf-read.mjs"), G = readGLTF(file), J = G.json;
  const use = G.uses.find(u => /cent(er|re)[ _-]?line/i.test(J.meshes[u.mesh].name ?? "") || /cent(er|re)[ _-]?line/i.test(u.name ?? "")); if (!use) throw new Error("no mesh named \"centerline\" in the model");
  const pts = [], edges = [];
  for (const p of J.meshes[use.mesh].primitives) { const mode = p.mode ?? 4, A = G.accessor(p.attributes.POSITION), base = pts.length;
    for (let k = 0; k < A.count; k++) { const v = [A.data[k * 3], A.data[k * 3 + 1], A.data[k * 3 + 2], 1], w = [0, 1, 2].map(i => use.matrix[i][0] * v[0] + use.matrix[i][1] * v[1] + use.matrix[i][2] * v[2] + use.matrix[i][3]); pts.push([w[0] / 0.3048, -w[2] / 0.3048, w[1] / 0.3048]); }
    const idx = p.indices !== undefined ? G.accessor(p.indices).data : [...Array(A.count).keys()];
    if (mode === 1) for (let i = 0; i + 1 < idx.length; i += 2) edges.push([base + idx[i], base + idx[i + 1]]);
    else if (mode === 2 || mode === 3) { for (let i = 0; i + 1 < idx.length; i++) edges.push([base + idx[i], base + idx[i + 1]]); if (mode === 2) edges.push([base + idx.at(-1), base + idx[0]]); }
    else if (mode === 4) for (let i = 0; i + 2 < idx.length; i += 3) for (let k = 0; k < 3; k++) edges.push([base + idx[i + k], base + idx[i + (k + 1) % 3]]); }
  // merge duplicate positions, walk the loop
  const key = p => p.map(v => Math.round(v * 10)).join(","), id = new Map(), uniq = [], map = pts.map(p => { const k = key(p); if (!id.has(k)) { id.set(k, uniq.length); uniq.push(p); } return id.get(k); });
  const adj = uniq.map(() => new Set()); for (const [a, b] of edges) { const x = map[a], y = map[b]; if (x !== y) { adj[x].add(y); adj[y].add(x); } }
  if (adj.some(s => s.size !== 2)) throw new Error("the centerline must be one closed loop of edges (every vertex joined to exactly two others)");
  let order = [0], prev = -1, cur = 0; while (true) { const next = [...adj[cur]].find(v => v !== prev); if (next === 0) break; if (order.length > uniq.length) throw new Error("the centerline is not a single loop"); order.push(next); prev = cur; cur = next; }
  if (order.length !== uniq.length) throw new Error("the centerline has more than one loop");
  let P = order.map(i => uniq[i]); let area = 0; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; area += a[0] * b[1] - b[0] * a[1]; }
  // (the loop's own order is the driving direction (nr2003-gltf writes it so): ovals run counter-clockwise, road
  // courses (Montreal, the game's own Watkins Glen and Sears Point) clockwise. Everything sideways is measured on
  // the outward normal (the right one counter-clockwise, the left one clockwise), so "in" (negative) is always the
  // infield side, where pit road is at all of these. NT04_CCW=1: turned counter-clockwise, as before)
  const clockwise = area < 0 && !process.env.NT04_CCW; if (area < 0 && !clockwise) P = [P[0], ...P.slice(1).reverse()];
  // (sideways: negative is pit road's side. Pit road is on the infield at the ovals and the game's own road courses,
  // but Montreal's is on the outside of its clockwise lap: the side the model's pit meshes lie on, else the infield)
  let flip = clockwise; { const pt = opts.pit === false ? [] : roadTrianglesFromGLTF(G, /pit/i);
    if (pt.length) { const pAt = triHeightField(pt), m = P.length; let L = 0, R = 0;
      for (let i = 0; i < m; i += 2) { const a = P[(i - 1 + m) % m], b = P[(i + 1) % m], tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1, rx = ty / l, ry = -tx / l;
        for (let dd = 10; dd <= 400; dd += 10) { if (pAt(P[i][0] + rx * dd, P[i][1] + ry * dd) !== null) { R++; break; } if (pAt(P[i][0] - rx * dd, P[i][1] - ry * dd) !== null) { L++; break; } } }
      if (L + R) flip = R > L; } }
  const sgn = flip ? -1 : 1;
  // (an object named "start": an empty is not a mesh use, so the node list is searched; its own translation)
  const sn = (J.nodes ?? []).find(n => /^start/i.test(n.name ?? "")), st = sn && (sn.translation ?? (sn.matrix ? [sn.matrix[12], sn.matrix[13], sn.matrix[14]] : null));
  if (st) { const sx = st[0] / 0.3048, sy = -st[2] / 0.3048; let bi = 0, bd = Infinity; P.forEach((p, i) => { const d = (p[0] - sx) ** 2 + (p[1] - sy) ** 2; if (d < bd) { bd = d; bi = i; } }); P = [...P.slice(bi), ...P.slice(0, bi)]; }
  const out = { points: P.map(p => [p[0], p[1]]), z: P.map(p => p[2]), ...opts };
  Object.defineProperty(out, "clockwise", { value: clockwise, enumerable: false }); Object.defineProperty(out, "flipped", { value: flip, enumerable: false });   // (flipped: sideways on the left normal)
  // the road surface: meshes (or their materials) named like road / track / surface / asphalt give the height at
  // the centreline and the banking (heights 20 ft either side), so the physics follows the model's own road
  if (opts.surface !== false) { const tris = roadTrianglesFromGLTF(G), hw = opts.surfaceHalfWidth ?? 20;
    if (tris.length) { const zAt = triHeightField(tris), n = P.length, z = [], bank = []; let hit = 0;
      for (let i = 0; i < n; i++) { const a = P[(i - 1 + n) % n], b = P[(i + 1) % n], tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1, nx = sgn * ty / l, ny = -sgn * tx / l;   // right normal
        const zc = zAt(P[i][0], P[i][1]), zr = zAt(P[i][0] + nx * hw, P[i][1] + ny * hw), zl = zAt(P[i][0] - nx * hw, P[i][1] - ny * hw);
        z.push(zc ?? P[i][2]); bank.push(zr !== null && zl !== null ? Math.atan((zr - zl) / (2 * hw)) * 180 / Math.PI : null); if (zc !== null) hit++; }
      if (hit > n / 2) { out.z = z; const known = bank.map((v, i) => v === null ? null : i).filter(v => v !== null);
        if (known.length && opts.bank === undefined) out.bank = bank.map((v, i) => v ?? bank[known.reduce((bi, k) => Math.abs(k - i) < Math.abs(bi - i) ? k : bi, known[0])]);
        out.surface = { triangles: tris.length, covered: hit / n };
        // widths: the road's edges (stepping out until the road ends) and the nearest wall beyond each edge
        if (opts.widths !== false) { const walls = roadTrianglesFromGLTF(G, /wall|barrier|safer/i), segs = [];
          for (const t of walls) for (let k = 0; k < 3; k++) { const a = t[k], b = t[(k + 1) % 3]; if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.5) segs.push([a, b]); }
          const ein = [], eout = [], win = [], wout = [];
          for (let i = 0; i < n; i++) { const a = P[(i - 1 + n) % n], b = P[(i + 1) % n], tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1, nx = sgn * ty / l, ny = -sgn * tx / l;
            const edge = sg => { let last = null; for (let dd = 0.5; dd <= 300; dd += 0.5) { if (zAt(P[i][0] + sg * nx * dd, P[i][1] + sg * ny * dd) === null) break; last = dd; } return last; };
            const wall = (sg, from) => { let best = null; const ox = P[i][0], oy = P[i][1], dx = sg * nx, dy = sg * ny;
              for (const [p1, p2] of segs) { const ex = p2[0] - p1[0], ey = p2[1] - p1[1], den = dx * ey - dy * ex; if (Math.abs(den) < 1e-9) continue;
                const t = ((p1[0] - ox) * ey - (p1[1] - oy) * ex) / den, u = ((p1[0] - ox) * dy - (p1[1] - oy) * dx) / den;
                if (u >= 0 && u <= 1 && t >= from - 2 && t < 400 && (best === null || t < best)) best = t; } return best; };
            const eo = edge(1), ei = edge(-1); eout.push(eo); ein.push(ei === null ? null : -ei);
            wout.push(segs.length && eo !== null ? wall(1, eo) : null); const wi = segs.length && ei !== null ? wall(-1, ei) : null; win.push(wi === null ? null : -wi); }
          if (eout.some(v => v !== null)) out.edges = { in: ein, out: eout };
          if (wout.some(v => v !== null) || win.some(v => v !== null)) out.walls = { in: win, out: wout }; } } } }
  // the model's ground (every mesh but walls and the centreline) for heights off the road, and its pit road (a mesh
  // named like "pit": pit road / pit lane / pit stalls) for where the pit road goes
  if (opts.surface !== false) { const gt = opts.ground === false ? [] : roadTrianglesFromGLTF(G, /./); if (gt.length) Object.defineProperty(out, "groundAt", { value: triHeightsField(gt), enumerable: false });
    const pt = opts.pit === false ? [] : roadTrianglesFromGLTF(G, /pit/i);
    if (pt.length) { const pAt = triHeightField(pt), n = P.length, far = [], near = []; let hit = 0;
      for (let i = 0; i < n; i++) { const a = P[(i - 1 + n) % n], b = P[(i + 1) % n], tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1, nx = sgn * ty / l, ny = -sgn * tx / l;
        let f = null, nr = null; for (let dd = 2; dd <= 500; dd += 1) { const on = pAt(P[i][0] - nx * dd, P[i][1] - ny * dd) !== null; if (on) { if (nr === null) nr = dd; f = dd; } else if (nr !== null) break; }
        far.push(f === null ? null : -f); near.push(nr === null ? null : -nr); if (f !== null) hit++; }
      if (hit) out.pit = { near, far, triangles: pt.length }; } }
  return out;
}
function triHeightsField(tris, cell = 40) {          // [[x, y, z] x 3] -> (x, y) => every z there
  const grid = new Map();
  tris.forEach((t, i) => { const xs = t.map(p => p[0]), ys = t.map(p => p[1]);
    for (let gx = Math.floor(Math.min(...xs) / cell); gx <= Math.floor(Math.max(...xs) / cell); gx++) for (let gy = Math.floor(Math.min(...ys) / cell); gy <= Math.floor(Math.max(...ys) / cell); gy++) { const k = gx * 100003 + gy; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); } });
  return (x, y) => { const out = [];
    for (const i of grid.get(Math.floor(x / cell) * 100003 + Math.floor(y / cell)) ?? []) { const [a, b, c] = tris[i], den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]); if (Math.abs(den) < 1e-9) continue;
      const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / den, l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / den, l3 = 1 - l1 - l2;
      if (l1 >= -1e-6 && l2 >= -1e-6 && l3 >= -1e-6) out.push(l1 * a[2] + l2 * b[2] + l3 * c[2]); }
    return out; };
}
function roadTrianglesFromGLTF(G, RE = /road|track|surface|asphalt|tarmac/i) {
  const J = G.json, CL = /cent(er|re)[ _-]?line/i, tris = [];
  for (const u of G.uses) { const mesh = J.meshes[u.mesh]; if (CL.test(mesh.name ?? "") || CL.test(u.name ?? "")) continue;
    const WALL = /wall|barrier|safer|fence/i; if (!WALL.test(RE.source) && (WALL.test(mesh.name ?? "") || WALL.test(u.name ?? ""))) continue;   // a "track wall" is no road
    const byName = RE.test(mesh.name ?? "") || RE.test(u.name ?? "");
    for (const p of mesh.primitives) { if ((p.mode ?? 4) !== 4) continue; const mat = J.materials?.[p.material]; if (!byName && !RE.test(mat?.name ?? "")) continue;
      if (!WALL.test(RE.source) && WALL.test(mat?.name ?? "")) continue;
      const A = G.accessor(p.attributes.POSITION), V = []; for (let k = 0; k < A.count; k++) { const v = [A.data[k * 3], A.data[k * 3 + 1], A.data[k * 3 + 2]], w = [0, 1, 2].map(i => u.matrix[i][0] * v[0] + u.matrix[i][1] * v[1] + u.matrix[i][2] * v[2] + u.matrix[i][3]); V.push([w[0] / 0.3048, -w[2] / 0.3048, w[1] / 0.3048]); }
      const idx = p.indices !== undefined ? G.accessor(p.indices).data : [...Array(A.count).keys()];
      for (let i = 0; i + 2 < idx.length; i += 3) tris.push([V[idx[i]], V[idx[i + 1]], V[idx[i + 2]]]); } }
  return tris;
}
function triHeightField(tris, cell = 40) {           // [[x, y, z] x 3] -> (x, y) => highest z there, or null
  const grid = new Map();
  tris.forEach((t, i) => { const xs = t.map(p => p[0]), ys = t.map(p => p[1]);
    for (let gx = Math.floor(Math.min(...xs) / cell); gx <= Math.floor(Math.max(...xs) / cell); gx++) for (let gy = Math.floor(Math.min(...ys) / cell); gy <= Math.floor(Math.max(...ys) / cell); gy++) { const k = gx * 100003 + gy; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); } });
  return (x, y) => { let best = null;
    for (const i of grid.get(Math.floor(x / cell) * 100003 + Math.floor(y / cell)) ?? []) { const [a, b, c] = tris[i], den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]); if (Math.abs(den) < 1e-9) continue;
      const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / den, l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / den, l3 = 1 - l1 - l2;
      if (l1 >= -1e-6 && l2 >= -1e-6 && l3 >= -1e-6) { const z = l1 * a[2] + l2 * b[2] + l3 * c[2]; if (best === null || z > best) best = z; } }
    return best; };
}

export function layoutSVG(res) {
  const { B, N } = res.frames, all = [...B.X.map((x, i) => [x, B.Y[i]]), ...N.X.map((x, i) => [x, N.Y[i]])], xs = all.map(p => p[0]), ys = all.map(p => p[1]);
  const x0 = Math.min(...xs) - 50, y1 = Math.max(...ys) + 50, W = Math.max(...xs) + 50 - x0, H = y1 - (Math.min(...ys) - 50), sc = 900 / W, P = (x, y) => `${((x - x0) * sc).toFixed(1)},${((y1 - y) * sc).toFixed(1)}`;
  const poly = (F, c) => `<polygon fill="none" stroke="${c}" stroke-width="2" points="${F.X.filter((_, i) => i % 4 === 0).map((x, i) => P(x, F.Y[i * 4])).join(" ")}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${Math.ceil(H * sc)}" style="background:#fff">${poly(B, "#aaa")}${poly(N, "#d33")}<circle cx="${P(N.X[0], N.Y[0]).split(",")[0]}" cy="${P(N.X[0], N.Y[0]).split(",")[1]}" r="5" fill="#d33"/></svg>`;
}

if (process.argv[1] && basename(process.argv[1]) === "trackwarp.mjs") {
  const [data, rendE, physE, layoutFile, out] = process.argv.slice(2);
  const t0 = Date.now(), res = warpTrack({ data, baseRend: rendE === "-" ? null : +rendE, basePhys: +physE, layout: JSON.parse(readFileSync(layoutFile, "utf8")) });
  mkdirSync(out, { recursive: true }); writeFileSync(join(out, "tk_phys.bin"), res.phys); writeFileSync(join(out, "ai_spds.bin"), res.ai); if (res.rend) writeFileSync(join(out, "tk_rend.bin"), res.rend); writeFileSync(join(out, "layout.svg"), layoutSVG(res));
  console.log(`base centre ${res.info.baseLength.toFixed(0)} ft, new ${res.info.newLength.toFixed(0)} ft (${res.info.miles.toFixed(3)} mi), racing line ${res.info.racingLine.toFixed(0)} ft; ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
export const _internals = { baseFrame, layoutFrame, makeMapper, heightField, at, roadTrianglesFromGLTF, triHeightField, triHeightsField };   // (tests and diagnostics)
