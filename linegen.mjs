// linegen.mjs — the AI and pit lines (TK_PHYS line groups) built from the track's own files instead of bent from a
// stock track's. The stock file still gives each group's number of lines and the values along them (speed steps,
// zones, corner kinds, TV camera numbers: node lists, kept at the same fraction along each line); every point is
// the new track's:
//   0, 2    the middle line and the inside line: where the stock ones sit across the racing surface (fraction of its width)
//   1       race lanes: the first on the racing-lines file's raceline, the others at the stock lanes' distance from it
//   11      pit road lanes (3): along pit road between the pit lane's ends, across it at 0.2 / 0.5 / 0.8 of the way
//           from its near side to the stall boxes' front
//   9, 10   stall paths (2 per stall: in from the middle / deep lane, out to the near / middle lane), ending / starting
//           exactly on each stall (the racing-lines file's pit_stall_NN; a stall more than the track has: the next
//           place past its last)
//   3-5     pit entry: from the inside of the racing surface ahead of pit road onto the pit lanes
//   6-8     pit exit: from the pit lanes out onto the inside of the racing surface
//   others  (infield loop, outer circles: cameras, blimp) as bent from the stock file
// Each line is sampled as a path in the track's frame (lap distance along the centre line, sideways distance) and
// cut into quadratic segments (end points on the path, middle control point through its middle).
//
// usage: import { generateLines } from "./linegen.mjs";
//        generateLines(lines (bent, to be replaced), baseLines (the stock file's), layout, gen (generateCollision), log)
//        -> { lines, nodeMap(groupIndex, lineIndex, at) -> at }  (for the AI speed nodes, which use the same positions)

const lerp = (a, b, t) => a + (b - a) * t;
const smooth = t => { const u = Math.max(0, Math.min(1, t)); return u * u * (3 - 2 * u); };
const bez = (p0, c, p1, t) => [0, 1, 2].map(k => (1 - t) ** 2 * p0[k] + 2 * (1 - t) * t * c[k] + t * t * p1[k]);

// a stock track's pit road side: true when it is on the right of the lap (Watkins Glen, Sears Point): its sideways
// frame on the left normal, as a flipped layout's
export function baseFlipped(lines) {
  const g0 = lines.find(l => l.group === 0), g11 = lines.find(l => l.group === 11); if (!g0) return false;
  if (!g11) { let a = 0; for (let i = 0; i + 1 < g0.points.length; i++) a += g0.points[i][0] * g0.points[i + 1][1] - g0.points[i + 1][0] * g0.points[i][1]; return a < 0; }
  const q = g11.points[Math.floor(g11.points.length / 2)]; let bi = 0, bd = Infinity; g0.points.forEach((p, k) => { const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2; if (d < bd) { bd = d; bi = k; } });
  const a = g0.points[Math.max(0, bi - 1)], c = g0.points[Math.min(g0.points.length - 1, bi + 1)]; return (c[0] - a[0]) * (q[1] - a[1]) - (c[1] - a[1]) * (q[0] - a[0]) < 0;
}

export function generateLines(lines, baseLines, layout, gen, log = () => {}) {
  const P = layout.points, n = P.length, nr = layout.geom.normals, feat = gen.feat, rows = gen.rows;
  const S = [0]; for (let i = 1; i <= n; i++) S.push(S[i - 1] + Math.hypot(P[i % n][0] - P[i - 1][0], P[i % n][1] - P[i - 1][1])); const LAP = S[n];
  const wrap = s => ((s % LAP) + LAP) % LAP;
  const rowAt = s => { const u = wrap(s); let lo = 0, hi = n; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= u) lo = m; else hi = m; } return { i: lo, t: (u - S[lo]) / ((S[lo + 1] - S[lo]) || 1) }; };
  const zRow = (i, d) => { const r = rows[i]; if (d <= r[0].d) return r[0].p[2]; for (let k = 1; k < r.length; k++) if (d <= r[k].d) { const a = r[k - 1], b = r[k], f = (d - a.d) / ((b.d - a.d) || 1); return lerp(a.p[2], b.p[2], f); } return r.at(-1).p[2]; };
  const at = (s, d) => { const { i, t } = rowAt(s), j = (i + 1) % n, x = lerp(P[i][0] + nr[i][0] * d, P[j][0] + nr[j][0] * d, t), y = lerp(P[i][1] + nr[i][1] * d, P[j][1] + nr[j][1] * d, t); return [x, y, lerp(zRow(i, d), zRow(j, d), t)]; };
  const fAt = (s, key) => { const { i, t } = rowAt(s); return lerp(feat[i][key], feat[(i + 1) % n][key], t); };
  // a path: lap distance range and sideways place d(s) (or points given) -> quadratic segments
  const sample = (s0, s1, dOf, step = 4) => { const len = s1 - s0, m = Math.max(2, Math.ceil(len / step)), out = []; for (let q = 0; q <= m; q++) { const s = s0 + len * q / m; out.push(at(s, dOf(s, q / m))); } return out; };
  const toLine = (pts, nSeg, closed) => {
    const L = [0]; for (let k = 1; k < pts.length; k++) L.push(L[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1], pts[k][2] - pts[k - 1][2]));
    const tot = L.at(-1), ptAt = u => { let lo = 0, hi = L.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (L[m] <= u) lo = m; else hi = m; } const f = (u - L[lo]) / ((L[hi] - L[lo]) || 1); return [0, 1, 2].map(k => lerp(pts[lo][k], pts[hi][k], f)); };
    const out = [ptAt(0)]; for (let k = 0; k < nSeg; k++) { const a = ptAt(tot * k / nSeg), b = k === nSeg - 1 && closed ? out[0] : ptAt(tot * (k + 1) / nSeg), m = ptAt(tot * (k + 0.5) / nSeg); out.push([0, 1, 2].map(j => 2 * m[j] - (a[j] + b[j]) / 2), b); }
    return out; };
  // segment lengths, cumulative, the cubic t -> distance (as warpPhys works them out)
  const arcs = (p0, c, p1, m = 48) => { const A = [0]; let prev = bez(p0, c, p1, 0), s = 0; for (let i = 1; i <= m; i++) { const p = bez(p0, c, p1, i / m); s += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]); A.push(s); prev = p; } return A; };
  const fit = A => { const m = A.length - 1, Lt = A[m]; let m11 = 0, m12 = 0, m22 = 0, r1 = 0, r2 = 0; for (let i = 0; i <= m; i++) { const x = i / m, u = x ** 3 - x, v = x * x - x, y = A[i] - Lt * x; m11 += u * u; m12 += u * v; m22 += v * v; r1 += u * y; r2 += v * y; } const det = m11 * m22 - m12 * m12 || 1, a = (r1 * m22 - r2 * m12) / det, b = (r2 * m11 - r1 * m12) / det; return [a, b, Lt - a - b]; };
  // a line from the stock one: its record kept (node lists, runtime fields), new points and segments
  const rebuild = (base, pts, nodeFrac) => { const nSeg = (pts.length - 1) / 2; let cum = 0; const segs = [];
    for (let i = 0; i < nSeg; i++) { const A = arcs(pts[2 * i], pts[2 * i + 1], pts[2 * i + 2]); cum += A.at(-1); segs.push({ length: A.at(-1), end: cum, poly: fit(A), frac: 0, data: Array(16).fill(0) }); }
    const total = cum, atOf = q => { const u = Math.max(0, Math.min(1, q)) * total; let i = segs.findIndex(sg => sg.end >= u - 1e-6); if (i < 0) i = nSeg - 1; const a0 = i ? segs[i - 1].end : 0; return Math.min(nSeg - 1e-4, i + (u - a0) / (segs[i].length || 1)); };
    const ptOfAt = a => { const i = Math.min(nSeg - 1, Math.floor(a)); return bez(pts[2 * i], pts[2 * i + 1], pts[2 * i + 2], a - i); };
    const nodes = base.nodes.map(list => list.map(nd => { const a = atOf(nodeFrac(nd.at)); return { ...nd, at: a, pos: ptOfAt(a) }; }));
    return { ...base, points: pts, pointCount: pts.length, segments: segs, profile: base.profile.map(() => Array(7 * nSeg + 1).fill(0)), nodes, fracEnd: 0, _atOf: atOf, _nf: nodeFrac }; };
  // a stock line's fraction along itself at a node position (segment + t)
  const fracOfAt = base => { const ends = base.segments.map(sg => +sg.end), tot = ends.at(-1) || 1; return a => { const i = Math.max(0, Math.min(base.segments.length - 1, Math.floor(a))), a0 = i ? ends[i - 1] : 0; return (a0 + (a - i) * (+base.segments[i].length)) / tot; }; };
  const segsFor = (len, base) => Math.max(base.segments.length, Math.ceil(len / 220));
  const out = lines.map(l => l), byG = g => out.map((l, i) => l.group === g ? i : -1).filter(i => i >= 0);
  const replace = (i, pts, warp = null) => { const b = baseLines[i], f0 = fracOfAt(b), f = warp ? a => warp(f0(a)) : f0; out[i] = rebuild(b, pts, f); };
  // The track lines' node lists (group 0: 2 / 4 zones, 5 / 6 corner kinds: 0 turn in, 3 middle, 1 way out, 4 straight
  // (the game's segment of a car, +0x3C, and its distance to the next node, +0x40, come from list 6); 8 / 9 TV
  // cameras) belong to the stock track's turns: they are put at the same place in this track's turns. Turns are
  // where the line bends (heading change over +-150 ft above a third of the most); the lap fraction maps piecewise
  // between the turns' starts, middles and ends, matched in order from the line (fraction kept when the counts differ)
  const turnsOf = (pts, lap) => { const m = pts.length, H = pts.map((p, i) => { const q = pts[(i + 1) % m]; return Math.atan2(q.y - p.y, q.x - p.x); });
    const step = lap / m, w = Math.max(2, Math.round(150 / step)), k = H.map((_, i) => { let d = 0; for (let j = -w; j < w; j++) { const a = H[(i + j + m) % m], b = H[(i + j + 1 + m) % m]; d += Math.atan2(Math.sin(b - a), Math.cos(b - a)); } return Math.abs(d); });
    const mx = Math.max(...k), on = k.map(v => v > mx / 3); if (on.every(Boolean) || !on.some(Boolean)) return [];
    let i0 = on.findIndex(v => !v); const T = []; for (let c = 0, i = i0; c < m; c++, i = (i + 1) % m) { if (on[i] && !on[(i - 1 + m) % m]) T.push({ a: i }); if (on[i] && !on[(i + 1) % m]) T.at(-1).b = i; }
    const gap = Math.round(150 / step); for (let j = T.length - 1; j > 0; j--) if (T[j].a - T[j - 1].b < gap) { T[j - 1].b = T[j].b; T.splice(j, 1); }
    const C = [0]; for (let i = 1; i <= m; i++) C.push(C[i - 1] + Math.hypot(pts[i % m].x - pts[i - 1].x, pts[i % m].y - pts[i - 1].y));
    const fr = i => i < m ? C[i] / C[m] : 1 + C[i - m] / C[m];   // (arc fraction of point i, past the end for a turn across the line)
    // (each turn's whole heading change; the small bends (a dogleg, a kink: under a third of the largest turn's) dropped)
    const R = T.map(t => { const b = t.b < t.a ? t.b + m : t.b; let ang = 0; for (let i = t.a; i < b; i++) { const a0 = H[i % m], a1 = H[(i + 1) % m]; ang += Math.atan2(Math.sin(a1 - a0), Math.cos(a1 - a0)); } return { a: t.a, b, ang: Math.abs(ang) }; });
    const big = Math.max(...R.map(r => r.ang));
    return R.filter(r => r.ang >= big / 3).map(r => { const fa = fr(r.a), fb = fr(r.b), t = [fa, (fa + fb) / 2, fb]; t.ang = r.ang; return t; }); };
  const bez1 = (p0, c, p1, t) => [0, 1].map(j => (1 - t) ** 2 * p0[j] + 2 * (1 - t) * t * c[j] + t * t * p1[j]);
  const lineTurns = l => { const Q = []; l.segments.forEach((_, i) => { for (let k = 0; k < 8; k++) { const p = bez1(l.points[2 * i], l.points[2 * i + 1], l.points[2 * i + 2], k / 8); Q.push({ x: p[0], y: p[1] }); } }); return turnsOf(Q, +l.segments.at(-1).end || LAP); };
  const g0base = baseLines.find(l => l.group === 0), bt = g0base ? lineTurns(g0base) : [], nt = turnsOf(P.map(p => ({ x: p[0], y: p[1] })), LAP);
  let lapWarp = null;
  // (more turns here than at the stock track (a tri-oval's bend, Walt Disney World's turn 3 kink): the stock track's
  // count of the largest, in lap order)
  if (bt.length && nt.length > bt.length) { const keep = new Set([...nt].sort((a, b) => b.ang - a.ang).slice(0, bt.length)); nt.splice(0, nt.length, ...nt.filter(t => keep.has(t))); }
  if (bt.length && bt.length === nt.length) { const A = [[0, 0]]; bt.forEach((t, j) => t.forEach((f, q) => A.push([f, nt[j][q]]))); A.push([1, 1]);
    const ok = A.every((v, j) => !j || (v[0] > A[j - 1][0] && v[1] > A[j - 1][1]));
    if (ok) lapWarp = f => { const x = ((f % 1) + 1) % 1; for (let j = 1; j < A.length; j++) if (x <= A[j][0]) { const [a0, b0] = A[j - 1], [a1, b1] = A[j]; return b0 + (b1 - b0) * (x - a0) / ((a1 - a0) || 1); } return x; }; }
  log(`turns: ${bt.length} at the stock track (${bt.map(t => t.map(v => v.toFixed(2)).join("-")).join(", ")}), ${nt.length} here (${nt.map(t => t.map(v => v.toFixed(2)).join("-")).join(", ")})${lapWarp ? " (node lists follow them)" : " (node lists kept at their lap fraction)"}`);
  // ---- track lines (closed): where the stock line sits across its racing surface, by lap fraction
  // (the stock lines' profiles are left / right of each line: pit road's side is the left at the ovals, the right at
  // Watkins Glen and Sears Point; here sideways is negative on pit road's side)
  const baseCW = baseFlipped(baseLines), bs = baseCW ? -1 : 1;
  const across0 = (b, q) => { const k = Math.min(b.profile[0].length - 1, Math.round(q * (b.profile[0].length - 1))), p1 = b.profile[1][k] / 12, p2 = b.profile[2][k] / 12; return p2 - p1 > 1 ? -p1 / (p2 - p1) : 0.5; }, across = (b, q) => baseCW ? 1 - across0(b, q) : across0(b, q);
  const rl = layout.raceline ?? null, rlAt = s => { const { i, t } = rowAt(s); return lerp(rl[i], rl[(i + 1) % n], t); };
  let made = { track: 0, pit: 0 };
  // (group 0 runs down the middle of the racing surface at the stock tracks (Lowe's: 0.43-0.55 of the way across),
  // group 2 near the inside (0.06-0.15); group 1's first lane is the racing groove (wide on the straights, low in the
  // turns): the track's racing line when the racing-lines file has one, the other two keep their distance from it
  // (the stock lanes', averaged over 300 ft either way), as lanesOnRaceline did with bent lanes)
  const lanesG1 = byG(1), lane0 = lanesG1[0], offOf = new Map();
  if (rl && lanesG1.length > 1) { const p0 = k => baseLines[k].profile[0], m = 400, base0 = Array.from({ length: m }, (_, j) => { const a = p0(lane0); return a[Math.round(j / (m - 1) * (a.length - 1))] / 12; });
    const w = Math.max(1, Math.round(300 / LAP * m));
    for (const k of lanesG1.slice(1)) { const a = p0(k), raw = Array.from({ length: m }, (_, j) => a[Math.round(j / (m - 1) * (a.length - 1))] / 12 - base0[j]);
      const sm = raw.map((_, j) => { let t = 0; for (let q = -w; q <= w; q++) t += raw[(j + q + m) % m]; return bs * t / (2 * w + 1); }); offOf.set(k, q => sm[Math.min(m - 1, Math.round(q * (m - 1)))]); } }
  for (const g of [0, 1, 2]) for (const i of byG(g)) { const b = baseLines[i]; if (Math.hypot(b.points[0][0] - b.points.at(-1)[0], b.points[0][1] - b.points.at(-1)[1]) > 5) continue;
    const dOf = (s, q) => { const e1 = fAt(s, "e1"), e2 = fAt(s, "e2"), cl = d => Math.max(e1 + 4, Math.min(e2 - 4, d));
      if (g === 1 && rl && i === lane0) return cl(rlAt(s)); if (g === 1 && rl && offOf.has(i)) return cl(rlAt(s) + offOf.get(i)(q));
      const f = across(b, q); return Math.max(e1 + 3, Math.min(e2 - 3, e1 + f * (e2 - e1))); };
    const pts = sample(0, LAP, dOf, 6); replace(i, toLine(pts, segsFor(LAP, b), true), lapWarp); made.track++; }
  // ---- pit road
  const pl = layout.pitLane, stalls = layout.stallSpots ?? [];
  if (Array.isArray(pl) && pl.length === 2 && layout.pit && stalls.length > 3) {
    let sa = pl[0] * LAP, sb = pl[1] * LAP; if (sb < sa) sb += LAP;
    const loc = (x, y) => { let bi = 0, bd = Infinity; for (let i = 0; i < n; i++) { const e = (P[i][0] - x) ** 2 + (P[i][1] - y) ** 2; if (e < bd) { bd = e; bi = i; } } let s = S[bi]; if (s < sa - 200) s += LAP; return { s, d: (x - P[bi][0]) * nr[bi][0] + (y - P[bi][1]) * nr[bi][1] }; };
    const st = stalls.map(p => ({ ...loc(p.x, p.y), p })), stallD = st.reduce((a, q) => a + q.d, 0) / st.length;
    // pit road's near side along the lap (where pit_area has none: the nearest that has), the stall front 7.5 ft short of the stalls
    const nearK = layout.pit.near.map((v, i) => v === null ? -1 : i).filter(i => i >= 0), nearAt = s => { const { i } = rowAt(s); if (layout.pit.near[i] !== null) return layout.pit.near[i]; let b = nearK[0]; for (const k of nearK) if (Math.min(Math.abs(k - i), n - Math.abs(k - i)) < Math.min(Math.abs(b - i), n - Math.abs(b - i))) b = k; return layout.pit.near[b]; };
    // (the stall front along pit road: the stalls' own distance in at each point (interpolated between stalls, the
    // end stalls' beyond them), 7.5 ft short: on a bent pit road (Iowa's D) the stalls' distance from the centre line
    // runs from 95 to 230 ft, and one mean put the lanes on the wrong side of the wall)
    const stS = [...st].sort((a, b) => a.s - b.s), frontAt = s => { if (s <= stS[0].s) return stS[0].d + 7.5; for (let j = 1; j < stS.length; j++) if (s <= stS[j].s) { const a = stS[j - 1], b = stS[j], f = (s - a.s) / ((b.s - a.s) || 1); return a.d + (b.d - a.d) * f + 7.5; } return stS.at(-1).d + 7.5; };
    const front = stallD + 7.5, laneD = (s, k) => { const nn = nearEff(s), fr = frontAt(s); return nn + (fr - nn) * [0.85, 0.6, 0.35][k]; };   // lane 0 the deepest, as the stock file's; lane 2 well inside pit road (type 3: the game hands back a car that leaves it)
    const inner = s => fAt(s, "e1") + 6;                     // the inside of the racing surface (entry / exit lines' track end)
    const blend = (s, s0, s1, d0, d1) => lerp(d0, d1, smooth((s - s0) / ((s1 - s0) || 1)));
    // The stock lines form one network (Lowe's, to the foot): entry k of group 3 ends where pit lane k (group 11)
    // starts, 4 ends at lane 0's start, 5 at lane 1's; exit k of group 6 starts where lane k ends, 7 at lane 0's end,
    // 8 at lane 1's. The lanes themselves run on past the stalls into the funnels at either end (Lowe's: from 136 ft
    // in at the entry, out to 42-61 ft at the exit), so every stall path starts and ends on them. Here the lanes run
    // EXT ft past pit road's ends, kept clear of the track's inner wall there (no nearer than 6 / 11 / 16 ft for lanes
    // 0 / 1 / 2), and the entries and exits join them end to end.
    const EXT = 150, ga = sa - EXT, gb = sb + EXT, WS = layout.geom.wallSegs ?? [];
    const wallD = s => { const { i } = rowAt(s), o = P[i], v = [-nr[i][0], -nr[i][1]]; let best = null;   // the inner wall's d across row i (the first wall inside the track)
      for (const [p, q] of WS) { const ex = q[0] - p[0], ey = q[1] - p[1], den = v[0] * ey - v[1] * ex; if (Math.abs(den) < 1e-9) continue;
        const t = ((p[0] - o[0]) * ey - (p[1] - o[1]) * ex) / den, u = ((p[0] - o[0]) * v[1] - (p[1] - o[1]) * v[0]) / den; if (t > 5 && t < 400 && u >= 0 && u <= 1 && (best === null || t < best)) best = t; }
      return best === null ? null : -best; };
    // (a wall standing between the track and the stalls along pit road (Iowa: the wall down pit road's track side is
    // in the physics file as a plain wall): pit road's near side is taken 4 ft beyond it, so the lanes and the stall
    // paths run on the stalls' side, not through it)
    const nearEff = s => { const nn = nearAt(s); if (s < sa || s > sb) return nn; const w = wallD(s); const fr = frontAt(s); return w !== null && w > fr + 4 && w < nn + 40 ? Math.min(nn, w - 4) : nn; };
    if (process.env.NT04_DEBUG_PIT) for (let s = ga; s <= gb; s += 100) log(`pit debug s ${s.toFixed(0)} near ${nearAt(s).toFixed(1)} wall ${wallD(s)?.toFixed(1)} front ${frontAt(s).toFixed(1)} eff ${nearEff(s).toFixed(1)}`);
    const clear = (s, d, c) => { if (s >= sa && s <= sb) return d; const w = wallD(s); return w === null ? d : Math.max(d, w + c); };
    const laneAt = (s, k) => clear(s, laneD(s, k), [6, 11, 16][k]);
    // 11: pit lanes
    byG(11).forEach((i, k) => { const kk = Math.min(2, k); replace(i, toLine(sample(ga, gb, s => laneAt(s, kk)), segsFor(gb - ga, baseLines[i]), false)); made.pit++; });
    // 9 / 10: stall paths; stall k of the stock file -> the track's stall k (past the last: one more stall spacing on,
    // no nearer the entry than 50 ft before pit road); in-paths from lane 1 (the first half) or 0, out-paths onto 2 or 1
    const sp = st.length > 1 ? (st.at(-1).s - st.at(-2).s) : -30, stallOf = k => { if (k < st.length) return st[k];
      // (past the track's own stalls (the game has 44 places, Walt Disney World 32 stalls): one more stall spacing
      // on while that stays on pit road, then halfway between two of the track's stalls, from the exit end)
      const x = st.at(-1).s + sp * (k - st.length + 1); if (x >= sa + 20 && x <= sb) return { s: x, d: st.at(-1).d };
      const j = (k - st.length) % Math.max(1, st.length - 1), a = st[j], b = st[j + 1] ?? st[j]; return { s: (a.s + b.s) / 2, d: (a.d + b.d) / 2 }; };
    const g9 = byG(9), g10 = byG(10), half = Math.max(1, Math.round(g9.length / 2));
    g9.forEach((i, j) => { const k = j % half, lane = j < half ? 1 : 0, q = stallOf(k), len = Math.min(j < half ? 90 : 70, q.s - ga - 5), s0 = q.s - len;
      replace(i, toLine(sample(s0, q.s, s => blend(s, s0 + len * 0.3, q.s, laneAt(s, lane), q.d), 3), Math.max(3, baseLines[i].segments.length), false)); made.pit++; });
    g10.forEach((i, j) => { const k = j % half, lane = j < half ? 2 : 1, q = stallOf(k), len = Math.max(40, Math.min(250, gb - q.s - 5));
      replace(i, toLine(sample(q.s, q.s + len, s => blend(s, q.s, q.s + Math.min(120, len * 0.7), q.d, laneAt(s, lane)), 3), Math.max(3, baseLines[i].segments.length), false)); made.pit++; });
    // 3-5: entries, from the inside of the track onto the lanes' starts (3: lane k, from 850 ft out; 4: lane 0, 365 ft;
    // 5: lane 1, 490 ft), easing over the last 300 ft; 6-8: exits from the lanes' ends easing onto the track over 250 ft
    // (6: lane k, 1500 ft on; 7: lane 0, 236 ft; 8: lane 1, 2100 ft). All kept clear of the inner wall as the lanes are.
    const entry = (i, kk, len) => { const s0 = ga - len, e = laneAt(ga, kk); replace(i, toLine(sample(s0, ga, s => clear(s, blend(s, ga - 300, ga, inner(s), e), [6, 11, 16][kk])), segsFor(len, baseLines[i]), false)); made.pit++; };
    byG(3).forEach((i, k) => entry(i, Math.min(2, k), 850));
    byG(4).forEach(i => entry(i, 0, 365));
    byG(5).forEach(i => entry(i, 1, 490));
    const exitLine = (i, kk, len) => { const e = laneAt(gb, kk); replace(i, toLine(sample(gb, gb + len, s => clear(s, blend(s, gb, gb + Math.min(250, len * 0.8), e, inner(s)), [6, 11, 16][kk])), segsFor(len, baseLines[i]), false)); made.pit++; };
    byG(6).forEach((i, k) => exitLine(i, Math.min(2, k), 1500));
    byG(7).forEach(i => exitLine(i, 0, 236));
    byG(8).forEach(i => exitLine(i, 1, 2100));
    log(`lines from the track: racing line and lanes (${made.track}), pit road (${made.pit} lines: lanes, ${g9.length + g10.length} stall paths onto ${st.length} stalls, entries, exits)`);
  } else log(`lines from the track: racing line and lanes (${made.track}); pit lines bent from the base (the racing-lines file has no pit lane / stalls)`);
  // node position mapping for the AI speed tables (same lines, same positions): stock at -> new at
  const nodeMap = (li, a) => out[li]._atOf ? out[li]._atOf(out[li]._nf(a)) : a;
  return { lines: out.map(l => { if (!l._atOf) return l; const { _atOf, _nf, ...r } = l; return r; }), nodeMap, stallsUsed: stalls.length };
}
