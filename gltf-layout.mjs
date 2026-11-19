// gltf-layout.mjs — a track's layout (what trackwarp.mjs builds the physics and AI lines from) read from glTF files:
// a physics file and, optionally, a racing-lines file (made by nr2003-gltf.mjs, or modelled from scratch in Blender
// with the same names). The names are what count; matching ignores case, and a mesh counts by its object (node) name
// or its mesh name.
//
// physics:  centerline   closed line along the track at road height, its points in the driving direction (ovals
//                        counter-clockwise seen from above, road courses usually clockwise; pit road on the infield side)
//           start        an empty (or any object) at the start / finish line: where the lap begins
//           road         the racing surface (mesh or material named road / track / asphalt / surface): heights,
//                        banking (from the heights at its two edges) and width along the centerline
//           wall*, barrier*, safer*   the walls (vertical faces; where they stand on the ground counts)
//           pit_wall     the wall between the track and pit road (also a wall); pit road needs one at most tracks
//           pit*         pit road and the stalls: where the game's pit road goes (on the left of the track)
//           ground       the ground across: apron, infield and pit road heights (else the road and pit meshes)
// lines:    raceline     closed line: the racing line (the AI's lanes are laid around it); per-vertex attribute
//                        _AISPEED or extras.aiSpeed: relative speed along it (else fitted from the corners)
//           pit_lane     line from the pit entry to the pit exit (only its two ends count: where pit road begins / ends)
//           pit_stall_*  empties: one per stall (where along the lap)
//           grid_01..    empties: the starting grid, in order, facing forward (+X of the empty); grid_pace: the pace car
//           scene / root node extras.track: { recordLap (s), pitSpeed (mph), paceSpeed (mph) }
//
// usage: import { layoutFromGLTF } from "./gltf-layout.mjs";
//        const layout = await layoutFromGLTF({ physics: "x_physics.glb", lines: "x_lines.glb" }, layoutOptions)

import { readGLTF, mat4 } from "./gltf-read.mjs";
import { centrelineFromGLTF, _internals } from "./trackwarp.mjs";
import { easeWallJumps } from "./nr2003-track.mjs";

const M = 0.3048;
const toFt = v => [v[0] / M, -v[2] / M, v[1] / M];                // glTF metres (Y up) -> layout feet (x, y, z up)

// every node with its world matrix (meshes or not)
function allNodes(G) {
  const J = G.json, out = [], walk = (ni, P, depth = 0) => { if (depth > 64) return; const n = J.nodes[ni], W = mat4.mul(P, mat4.fromNode(n)); out.push({ i: ni, name: n.name ?? "", mesh: n.mesh, matrix: W, extras: n.extras }); for (const c of n.children ?? []) walk(c, W, depth + 1); };
  for (const r of J.scenes?.[J.scene ?? 0]?.nodes ?? J.nodes.map((_, i) => i)) walk(r, mat4.identity());
  return out;
}
const named = (G, nodes, re) => nodes.filter(n => n.mesh !== undefined && (re.test(n.name) || re.test(G.json.meshes[n.mesh]?.name ?? "")));
const xf = (m, v) => [0, 1, 2].map(i => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2] + m[i][3]);
// a mesh's lines as ordered polylines (Blender writes edges as LINES in any order): [{ pts: [[x, y, z] ft], vals: {attr: [..]}, closed }]
function polylines(G, use, attrs = []) {
  const J = G.json, out = [];
  for (const p of J.meshes[use.mesh].primitives) { const mode = p.mode ?? 4; if (mode === 0 || mode === 4 || mode === 5 || mode === 6) continue;
    const A = G.accessor(p.attributes.POSITION), V = []; for (let k = 0; k < A.count; k++) V.push(toFt(xf(use.matrix, [A.data[k * 3], A.data[k * 3 + 1], A.data[k * 3 + 2]])));
    const vals = Object.fromEntries(attrs.filter(a => p.attributes[a] !== undefined).map(a => [a, G.accessor(p.attributes[a]).data]));
    const idx = p.indices !== undefined ? G.accessor(p.indices).data : [...Array(A.count).keys()], E = [];
    if (mode === 1) for (let i = 0; i + 1 < idx.length; i += 2) E.push([idx[i], idx[i + 1]]); else { for (let i = 0; i + 1 < idx.length; i++) E.push([idx[i], idx[i + 1]]); if (mode === 2) E.push([idx.at(-1), idx[0]]); }
    // merge duplicates (0.01 ft), walk each chain
    const key = q => q.map(v => Math.round(v * 100)).join(","), id = new Map(), rep = V.map((q, i) => { const k = key(q); if (!id.has(k)) id.set(k, i); return id.get(k); });
    const adj = new Map(); for (const [a0, b0] of E) { const a = rep[a0], b = rep[b0]; if (a === b) continue; if (!adj.has(a)) adj.set(a, new Set()); if (!adj.has(b)) adj.set(b, new Set()); adj.get(a).add(b); adj.get(b).add(a); }
    const seen = new Set(), starts = [...adj.keys()].sort((a, b) => (adj.get(a).size === 1 ? -1 : 0) - (adj.get(b).size === 1 ? -1 : 0) || a - b);
    for (const s of starts) { if (seen.has(s)) continue; const ch = [s]; seen.add(s); let prev = -1, cur = s, closed = false;
      for (;;) { const nx = [...adj.get(cur)].find(v => v !== prev && !seen.has(v)); if (nx === undefined) { closed = ch.length > 2 && adj.get(cur).has(s); break; } ch.push(nx); seen.add(nx); prev = cur; cur = nx; }
      out.push({ pts: ch.map(i => V[i]), vals: Object.fromEntries(Object.entries(vals).map(([k, d]) => [k, ch.map(i => d[i])])), closed }); } }
  return out;
}
// 2-D segments of a mesh's triangles' horizontal edges (a wall's foot and top), feet
function footSegments(G, uses) {
  const segs = [];
  for (const u of uses) for (const p of G.json.meshes[u.mesh].primitives) { if ((p.mode ?? 4) !== 4) continue; const A = G.accessor(p.attributes.POSITION), V = [];
    for (let k = 0; k < A.count; k++) V.push(toFt(xf(u.matrix, [A.data[k * 3], A.data[k * 3 + 1], A.data[k * 3 + 2]])));
    const idx = p.indices !== undefined ? G.accessor(p.indices).data : [...Array(A.count).keys()];
    for (let i = 0; i + 2 < idx.length; i += 3) for (let k = 0; k < 3; k++) { const a = V[idx[i + k]], b = V[idx[i + (k + 1) % 3]]; if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.5) segs.push([a, b]); } }
  return segs;
}
// where the line from o along (dx, dy) crosses a 2-D segment list: the signed distance nearest 0 within max
function cross(segs, o, dx, dy, max = 200) {
  let best = null, bt = null;
  for (const [p1, p2] of segs) { const ex = p2[0] - p1[0], ey = p2[1] - p1[1], den = dx * ey - dy * ex; if (Math.abs(den) < 1e-9) continue;
    const t = ((p1[0] - o[0]) * ey - (p1[1] - o[1]) * ex) / den, u = ((p1[0] - o[0]) * dy - (p1[1] - o[1]) * dx) / den;
    if (u >= -0.02 && u <= 1.02 && Math.abs(t) <= max && (best === null || Math.abs(t) < Math.abs(best))) { best = t; bt = u; } }
  return best === null ? null : { t: best, u: bt };
}

export async function layoutFromGLTF({ physics, lines = null }, opts = {}) {
  const out = await centrelineFromGLTF(physics, { ...opts, widths: true }), notes = [];
  const G = readGLTF(physics), P = out.points, n = P.length, nodes = allNodes(G);
  const nr = P.map((_, i) => { const a = P[(i - 1 + n) % n], b = P[(i + 1) % n], tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1; const sg = out.flipped ? -1 : 1; return [sg * ty / l, -sg * tx / l]; });   // (sideways: negative on pit road's side, the right normal unless pit road is on the right)
  const S = [0]; for (let i = 1; i <= n; i++) S.push(S[i - 1] + Math.hypot(P[i % n][0] - P[i - 1][0], P[i % n][1] - P[i - 1][1])); const lap = S[n];
  const { roadTrianglesFromGLTF, triHeightField } = _internals;
  // the road's edges to 0.01 ft (trackwarp steps out in 0.5 ft)
  const roadZ = triHeightField(roadTrianglesFromGLTF(G));
  if (out.edges) for (const k of ["in", "out"]) for (let i = 0; i < n; i++) { const e = out.edges[k][i]; if (e === null) continue; const sg = Math.sign(e) || (k === "in" ? -1 : 1);
    let lo = Math.abs(e), hi = lo + 0.5; for (let it = 0; it < 6; it++) { const m = (lo + hi) / 2; if (roadZ(P[i][0] + nr[i][0] * sg * m, P[i][1] + nr[i][1] * sg * m) !== null) lo = m; else hi = m; } out.edges[k][i] = sg * lo; }
  // heights and banking from the road's two edges (the plane through them, as NR2003 and the game take it)
  if (out.edges) for (let i = 0; i < n; i++) { const ei = out.edges.in[i], eo = out.edges.out[i]; if (ei === null || eo === null) continue;
    const zi = roadZ(P[i][0] + nr[i][0] * ei, P[i][1] + nr[i][1] * ei), zo = roadZ(P[i][0] + nr[i][0] * eo, P[i][1] + nr[i][1] * eo); if (zi === null || zo === null || eo - ei < 1) continue;
    out.z[i] = zi + (zo - zi) * (0 - ei) / (eo - ei); if (opts.bank === undefined) (out.bank ??= Array(n).fill(0))[i] = Math.atan((zo - zi) / (eo - ei)) * 180 / Math.PI; }
  // the walls beyond each road edge: the nearest wall face running along the track (within 45 degrees of it; a wall
  // across the ray, an end or a corner of another wall, is not the track's wall there)
  { const WALL = /wall|barrier|safer/i, ws = footSegments(G, nodes.filter(x => x.mesh !== undefined && (WALL.test(x.name) || WALL.test(G.json.meshes[x.mesh]?.name ?? ""))));
    if (ws.length && out.edges) { const win = [], wout = [];
      for (let i = 0; i < n; i++) { const tx = -nr[i][1], ty = nr[i][0], along = ws.filter(([a, b]) => { const ex = b[0] - a[0], ey = b[1] - a[1], l = Math.hypot(ex, ey) || 1; return Math.abs(ex * tx + ey * ty) / l > 0.7; });
        const hit = (sg, from) => { let best = null; for (const [p1, p2] of along) { const c = cross([[p1, p2]], P[i], sg * nr[i][0], sg * nr[i][1], 400); if (c && c.t >= from - 2 && (best === null || c.t < best)) best = c.t; } return best; };
        const eo = out.edges.out[i], ei = out.edges.in[i]; const wo = eo === null ? null : hit(1, eo), wi = ei === null ? null : hit(-1, -ei); wout.push(wo); win.push(wi === null ? null : -wi); }
      out.walls = { in: win, out: wout }; } }
  if (out.walls?.in) easeWallJumps(out.walls.in, lap);
  // pit road's near and far side to 0.01 ft (trackwarp steps 1 ft)
  if (out.pit) { const pAt = triHeightField(roadTrianglesFromGLTF(G, /pit/i)), on = (i, d) => pAt(P[i][0] + nr[i][0] * d, P[i][1] + nr[i][1] * d) !== null;
    for (let i = 0; i < n; i++) { const a = out.pit.near[i], b = out.pit.far[i]; if (a === null || b === null) continue;
      let lo = a + 1, hi = a; for (let it = 0; it < 7; it++) { const m = (lo + hi) / 2; if (on(i, m)) hi = m; else lo = m; } out.pit.near[i] = +hi.toFixed(2);
      lo = b, hi = b - 1; for (let it = 0; it < 7; it++) { const m = (lo + hi) / 2; if (on(i, m)) lo = m; else hi = m; } out.pit.far[i] = +lo.toFixed(2); } }
  // the ground across, on a 4 ft grid (trackwarp: apron, pit road, infield heights; also marks the scenery as the track's own)
  { const gu = named(G, nodes, /^ground|terrain/i), gt = gu.length ? roadTrianglesFromGLTF({ ...G, uses: gu }, /./) : roadTrianglesFromGLTF(G, /./), gAt = triHeightField(gt), gAll = _internals.triHeightsField(gt);
    const far = Math.max(40, ...[out.edges?.in, out.edges?.out, out.walls?.in, out.walls?.out, out.pit?.far].flatMap(a => (a ?? []).filter(v => v !== null).map(Math.abs)));
    // (out to where the ground mesh ends, measured on 24 rows, at most 360 ft; at least 30 ft past the walls / pits)
    let reach = far + 30; if (gu.length) for (let r = 0; r < 24; r++) { const i = Math.floor(r * n / 24); for (const sg of [-1, 1]) { let last = 0, miss = 0; for (let d = 4; d <= 360 && miss < 12; d += 4) { if (gAt(P[i][0] + nr[i][0] * sg * d, P[i][1] + nr[i][1] * sg * d) === null) miss++; else { miss = 0; last = d; } } reach = Math.max(reach, last); } }
    const step = 4, d0 = -Math.ceil(reach / step) * step, cols = Math.round(-2 * d0 / step) + 1, z = [];
    // (outward from the road, each height the one nearest the last where the ground overlaps itself: across an infield
    // the far side of the track lies under the same line)
    for (let i = 0; i < n; i++) { const row = Array(cols).fill(null), j0 = Math.round(-d0 / step);
      for (const sg of [1, -1]) { let last = out.z[i]; for (let j = j0; j >= 0 && j < cols; j += sg) { const d = d0 + step * j, zs = gAll(P[i][0] + nr[i][0] * d, P[i][1] + nr[i][1] * d);
        if (zs.length) { const z = zs.reduce((b, v) => Math.abs(v - last) < Math.abs(b - last) ? v : b, zs[0]); row[j] = z; last = z; } } }
      const known = row.map((v, j) => v === null ? null : j).filter(j => j !== null);
      z.push(row.map((v, j) => +(v ?? (known.length ? row[known.reduce((b, k) => Math.abs(k - j) < Math.abs(b - j) ? k : b, known[0])] : out.z[i])).toFixed(2))); }
    out.ground = { d0, step, z }; }
  // the pit wall: runs of [x, y, d] where a pit_wall stands beside the track
  { const pw = footSegments(G, named(G, nodes, /pit[ _-]?wall/i));
    if (pw.length) { const runs = []; let run = null, firstAt0 = false;
      for (let i = 0; i < n; i++) { const c = cross(pw, P[i], nr[i][0], nr[i][1], 150);
        if (c) { if (!run) { run = []; if (i === 0) firstAt0 = true; } run.push([+(P[i][0] + nr[i][0] * c.t).toFixed(2), +(P[i][1] + nr[i][1] * c.t).toFixed(2), +c.t.toFixed(2)]); }
        else if (run) { if (run.length >= 3) runs.push(run); else if (!runs.length) firstAt0 = false; run = null; } }
      if (run) { if (firstAt0 && runs.length) runs[0] = [...run, ...runs[0]]; else if (run.length >= 3) runs.push(run); }
      if (runs.length) out.pitWall = runs; } }
  // lap fraction of a point (projected onto the centerline)
  const frac = q => { let bi = 0, bd = Infinity; for (let i = 0; i < n; i++) { const e = (P[i][0] - q[0]) ** 2 + (P[i][1] - q[1]) ** 2; if (e < bd) { bd = e; bi = i; } }
    const b = P[(bi + 1) % n], tx = b[0] - P[bi][0], ty = b[1] - P[bi][1], l2 = tx * tx + ty * ty || 1, t = ((q[0] - P[bi][0]) * tx + (q[1] - P[bi][1]) * ty) / l2;
    return ((((S[bi] + t * Math.sqrt(l2)) / lap) % 1) + 1) % 1; };
  // ---- the lines file
  if (lines) { const L = readGLTF(lines), ln = allNodes(L), ex = L.json.scenes?.[L.json.scene ?? 0]?.extras?.track ?? ln.find(x => x.extras?.track)?.extras.track;
    if (ex) for (const k of ["recordLap", "pitSpeed", "paceSpeed"]) if (+ex[k] > 0) out[k] = +ex[k];
    const rl = named(L, ln, /^race[ _-]?line/i)[0];
    if (rl) { const pl = polylines(L, rl, ["_AISPEED"]).sort((a, b) => b.pts.length - a.pts.length)[0];
      if (pl && pl.pts.length > 10) { const pts = pl.pts, m = pts.length, segs = pts.map((p, k) => [p, pts[(k + 1) % m], k]).slice(0, pl.closed ? m : m - 1);
        let spd = pl.vals._AISPEED; const ext = L.json.nodes[rl.i].extras?.aiSpeed; if (!spd && Array.isArray(ext) && ext.length === m) spd = ext;
        const off = [], v = []; for (let i = 0; i < n; i++) { let best = null; for (const [p1, p2, k] of segs) { const c = cross([[p1, p2]], P[i], nr[i][0], nr[i][1], 150); if (c && (best === null || Math.abs(c.t) < Math.abs(best.t))) best = { ...c, k }; }
          off.push(best ? +best.t.toFixed(2) : null); v.push(best && spd ? spd[best.k] + (spd[(best.k + 1) % m] - spd[best.k]) * best.u : null); }
        const fill = a => { const known = a.map((x, i) => x === null ? null : i).filter(i => i !== null); if (!known.length) return null; return a.map((x, i) => x ?? a[known.reduce((b, k) => Math.min(Math.abs(k - i), n - Math.abs(k - i)) < Math.min(Math.abs(b - i), n - Math.abs(b - i)) ? k : b, known[0])]); };
        const miss = off.filter(x => x === null).length; if (miss) notes.push(`racing line: ${miss} of ${n} points off it (filled from their neighbours)`);
        out.raceline = fill(off); if (spd) out.aiSpeed = fill(v).map(x => +x.toFixed(4)); } }
    const lane = named(L, ln, /^pit[ _-]?lane/i)[0], lp = lane && polylines(L, lane).sort((a, b) => b.pts.length - a.pts.length)[0];
    if (lp && lp.pts.length >= 2) { let a = lp.pts[0], b = lp.pts.at(-1);
      // (Blender may write the line backwards: the entry is the end the cars reach first, nearer after the start of pit road)
      const fa = frac(a), fb = frac(b), fm = frac(lp.pts[Math.floor(lp.pts.length / 2)]), span = (x, y) => (((y - x) % 1) + 1) % 1;
      if (span(fa, fm) > span(fa, fb)) [a, b] = [b, a]; out.pitLane = [frac(a), frac(b)].map(x => +x.toFixed(5)); }
    const st = ln.filter(x => /^pit[ _-]?stall/i.test(x.name)).sort((a, b) => (parseInt(a.name.match(/\d+/)?.[0] ?? 0)) - (parseInt(b.name.match(/\d+/)?.[0] ?? 0)));
    if (st.length > 3) { out.pitStalls = st.map(x => +frac(toFt([x.matrix[0][3], x.matrix[1][3], x.matrix[2][3]])).toFixed(5));
      // (the stalls themselves, in their own order (pit_stall_00 first: the one nearest the pit exit, as track.ini numbers
      // them and as the game's stall paths run): place and the way the car faces)
      Object.defineProperty(out, "stallSpots", { enumerable: false, value: st.map(x => { const p = toFt([x.matrix[0][3], x.matrix[1][3], x.matrix[2][3]]); return { x: p[0], y: p[1], z: p[2], h: Math.atan2(-x.matrix[2][0], x.matrix[0][0]) }; }) }); }
    const head = x => Math.atan2(-x.matrix[2][0], x.matrix[0][0]), pos = x => toFt([x.matrix[0][3], x.matrix[1][3], x.matrix[2][3]]);
    const gr = ln.filter(x => /^grid[ _-]?\d+/i.test(x.name)).sort((a, b) => parseInt(a.name.match(/\d+/)[0]) - parseInt(b.name.match(/\d+/)[0])), pace = ln.find(x => /^grid[ _-]?pace/i.test(x.name));
    if (gr.length > 3) out.grid = { from: "grid_*", cars: gr.map(x => { const p = pos(x); return [+p[0].toFixed(2), +p[1].toFixed(2), +head(x).toFixed(5)]; }), pace: pace ? (p => [+p[0].toFixed(2), +p[1].toFixed(2), +head(pace).toFixed(5)])(pos(pace)) : null }; }
  Object.defineProperty(out, "notes", { value: notes, enumerable: false });
  // the physics file's geometry, for building the collision layer from it (physgen.mjs): heights and the game's
  // surface type at a point, and the walls (pit walls apart)
  { const WALL = /wall|barrier|safer|fence/i, field = re => { const t = roadTrianglesFromGLTF(G, re); return t.length ? _internals.triHeightsField(t) : null; };
    const cats = [[3, field(/stall/i)], [1, field(/pit/i)], [0, field(/road|track|surface|asphalt|tarmac/i)], [7, field(/grass|dirt|sand|turf/i)], [6, field(/./)]].filter(c => c[1]);
    // (type: the first kind of surface there, within 2 ft of the height asked about when one is given)
    const typeAt = (x, y, z = null) => { for (const [ty, f] of cats) { const zs = f(x, y); if (zs.length && (z === null || zs.some(v => Math.abs(v - z) < 2))) return ty; } return null; };
    const isPitWall = x => /pit[ _-]?wall/i.test(x.name) || /pit[ _-]?wall/i.test(G.json.meshes[x.mesh]?.name ?? "");
    const wallNodes = nodes.filter(x => x.mesh !== undefined && (WALL.test(x.name) || WALL.test(G.json.meshes[x.mesh]?.name ?? "")));
    Object.defineProperty(out, "geom", { enumerable: false, value: { typeAt, roadZ, wallSegs: footSegments(G, wallNodes.filter(x => !isPitWall(x))), pitWallSegs: footSegments(G, wallNodes.filter(isPitWall)), normals: nr } }); }
  return out;
}
