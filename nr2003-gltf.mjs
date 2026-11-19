// nr2003-gltf.mjs — an NR2003 track folder -> three glTF files (.glb) to open in Blender, edit, and add to a track
// pack in the launcher (track-pack.mjs: "model", "physics", "lines"; gltf-layout.mjs reads the last two):
//
//   <id>_scenery.glb   what is drawn: the racing surface, apron, grass and walls built from the .ptf, the track's own
//                      objects (.3do) where the .ptf places them, and "pit_stall_boxes": painted boxes at the stalls of
//                      track.ini (NR2003 draws those itself, so they are not in its files).
//   <id>_physics.glb   what the cars drive on (not drawn; the names are what count):
//                        centerline   closed line along the track (driven counter-clockwise from "start"), at road height
//                        start        empty: the start / finish line
//                        road         the racing surface between its edges (heights, banking and width come from it)
//                        walls        the walls (any mesh named wall / barrier / safer), vertical faces
//                        pit_wall     the wall between the track and pit road (also a wall)
//                        pit_area     pit road (where the game's pit road goes); pit_stalls the stall boxes' strip
//                        ground       the ground across the track (materials "apron" paved, "grass" grass / sand)
//   <id>_lines.glb     the AI's lines and places:
//                        raceline     closed line: the racing line; relative AI speed per vertex as the attribute
//                                     _AISPEED and in the node's extras.aiSpeed (vertex order)
//                        pit_lane     line from the pit entry to the pit exit
//                        pit_stall_NN empties: the stalls (NN from the exit end, as track.ini numbers them)
//                        grid_NN      empties: the starting grid, facing forward; grid_pace: the pace car
//                        scene extras.track: { recordLap, pitSpeed, paceSpeed }
// Frame: glTF metres, Y up; NR2003 (x, y, z up) -> (x, z, -y), the frame the scenery has always used.
//
// usage: import { nr2003ToGLTF } from "./nr2003-gltf.mjs"; nr2003ToGLTF(trackFolder, outFolder, { objects, roadTone, log })
// CLI:   node nr2003-gltf.mjs <track folder> <output folder> [--objects <dir>]... [--road-tone <n|off>]

import { writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { readNR2003, layoutFromPTF, sectionAt } from "./nr2003-track.mjs";
import { buildNR2003Scene } from "./nr2003-scene.mjs";
import { GLB, yaw } from "./gltf-write.mjs";

const M = 0.3048, FT = 1 / M;
const G = (x, y, z) => [x * M, z * M, -y * M];                    // layout feet (x, y, z up) -> glTF metres
const N = (x, y, z) => [x, z, -y];                                // NR2003 metres -> glTF metres

// the layout's frame per point: right normal and the ground height at a sideways distance (feet, right +): the .ptf's
// own cross-section (its height knots) at that point, so the road's edges carry the exact heights NR2003 has there
function frame(L, ptf, DL) {
  const P = L.points, n = P.length, nr = P.map((_, i) => { const a = P[(i - 1 + n) % n], b = P[(i + 1) % n], tx = b[0] - a[0], ty = b[1] - a[1], l = Math.hypot(tx, ty) || 1; return [ty / l, -tx / l]; });
  const sec = DL.map(s => sectionAt(ptf, s)), gz = (i, d) => sec[i].zAt(-d * M) * FT;
  const at = (i, d, up = 0) => G(P[i][0] + nr[i][0] * d, P[i][1] + nr[i][1] * d, gz(i, d) + up);
  return { n, nr, gz, at };
}
// a strip mesh between two sideways distances per point (null: no strip there), cols columns across
function strip(F, from, to, cols = 6, closed = true) {
  const pos = [], idx = [], row = new Map();
  for (let i = 0; i < F.n; i++) { const a = from(i), b = to(i); if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    row.set(i, pos.length / 3); for (let c = 0; c <= cols; c++) pos.push(...F.at(i, a + (b - a) * c / cols)); }
  for (const [i, r0] of row) { const j = (i + 1) % F.n; if (!closed && j === 0) continue; const r1 = row.get(j); if (r1 === undefined) continue;
    for (let c = 0; c < cols; c++) idx.push(r0 + c, r1 + c, r0 + c + 1, r0 + c + 1, r1 + c, r1 + c + 1); }
  return { positions: pos, indices: idx };
}
const quad = (out, a, b, c, d) => { const k = out.positions.length / 3; out.positions.push(...a, ...b, ...c, ...d); out.indices.push(k, k + 1, k + 2, k, k + 2, k + 3); };

export function nr2003ToGLTF(dir, outDir, { objects = [], roadTone, log = () => {}, id = null } = {}) {
  const T = readNR2003(dir, { objects }), { layout: L, dlong: DL } = layoutFromPTF(T.ptf, { ini: T.ini, lp: T.lp }), ptf = T.ptf, F = frame(L, ptf, DL);
  const name = (id ?? T.ptfName?.replace(/\.ptf$/i, "") ?? basename(dir)).replace(/[^\w-]+/g, "_");
  mkdirSync(outDir, { recursive: true }); const files = {};
  const stalls = Object.entries(T.ini?.pit_lane_0 ?? {}).filter(([k]) => /^stall_\d+$/.test(k)).map(([k, v]) => ({ k: +k.slice(6), v: String(v).trim().split(/\s+/).map(Number) })).filter(s => s.v.length >= 2 && s.v.every(Number.isFinite)).sort((a, b) => a.k - b.k);

  // ---- scenery
  { const sc = buildNR2003Scene(T, { log, ...(roadTone !== undefined ? { roadTone } : {}) }), g = new GLB("nr2003-gltf.mjs scenery");
    const mat = new Map(); for (const [key, m] of [...sc.mats].sort((a, b) => a[1].index - b[1].index)) mat.set(m.index, g.material(key.slice(0, 28), m.tex ? { png: m.tex.png, alpha: m.tex.alpha } : { color: [0.6, 0.6, 0.6, 1] }));
    const track = g.mesh("track", [...sc.bucket.values()].map(B => ({ positions: B.pos, uvs: B.uv, indices: B.idx, material: mat.get(B.mat.index) }))); g.node({ name: "track", mesh: track });
    for (const m of sc.meshes) m.glb = g.mesh(m.name, m.parts.map(p => ({ positions: p.positions.flatMap(v => N(...v)), uvs: p.uvs.flat(), indices: p.indices, material: mat.get(p.mat.index) })));
    for (const nd of sc.nodes) g.node({ name: nd.name, mesh: sc.meshes[nd.mesh].glb, translation: nd.translation, rotation: nd.rotation });
    // stall boxes: NR2003 paints them itself at track.ini's stalls; here as white lines 0.15 m wide, a box 8.5 m along
    // (the stall spacing less a gap) and 4.4 m across around each stall's spot, 2 cm over the ground
    if (stalls.length) { const box = { positions: [], indices: [] }, w = 0.15, len = Math.min(8.5, Math.max(4, (Math.abs(stalls[0].v[0] - (stalls[1]?.v[0] ?? stalls[0].v[0] - 9.5)) || 9.5) - 1)), wid = 4.4;
      const P = (s, d) => { const S = sectionAt(ptf, s); return N(...S.point(d)).map((v, k) => k === 1 ? v + 0.02 : v); };
      const line = (s0, d0, s1, d1) => { const along = Math.abs(s1 - s0) > Math.abs(d1 - d0); if (along) quad(box, P(s0, d0 - w / 2), P(s1, d1 - w / 2), P(s1, d1 + w / 2), P(s0, d0 + w / 2)); else quad(box, P(s0 - w / 2, d0), P(s0 - w / 2, d1), P(s1 + w / 2, d1), P(s1 + w / 2, d0)); };
      for (const { v: [s, d] } of stalls) { const a = s - len / 2, b = s + len / 2, l = d - wid / 2, r = d + wid / 2; line(a, l, b, l); line(a, r, b, r); line(a, l, a, r); line(b, l, b, r); }
      g.node({ name: "pit_stall_boxes", mesh: g.mesh("pit_stall_boxes", [{ ...box, material: g.material("pit_stall_paint", { color: [0.95, 0.95, 0.95, 1] }) }]) }); }
    writeFileSync(join(outDir, files.scenery = `${name}_scenery.glb`), g.glb()); }

  // ---- physics
  { const g = new GLB("nr2003-gltf.mjs physics"), col = (r, gg, b, a = 1) => ({ color: [r, gg, b, a] });
    const cl = []; for (let i = 0; i < F.n; i++) cl.push(...G(L.points[i][0], L.points[i][1], L.z[i]));
    g.node({ name: "centerline", mesh: g.mesh("centerline", [{ positions: cl, mode: 2, material: g.material("centerline", col(1, 1, 0)) }]) });
    g.node({ name: "start", translation: G(L.points[0][0], L.points[0][1], L.z[0]), rotation: yaw(Math.atan2(L.points[1][1] - L.points[0][1], L.points[1][0] - L.points[0][0])) });
    g.node({ name: "road", mesh: g.mesh("road", [{ ...strip(F, i => L.edges.in[i], i => L.edges.out[i], 8), material: g.material("road", col(0.3, 0.3, 0.32)) }]) });
    // the walls of the .ptf as they stand (feet on the ground across, their own heights)
    const W = { positions: [], indices: [] };
    for (const seg of ptf.segments) { const s0 = DL[0] !== undefined ? ptf.segments.slice(0, ptf.segments.indexOf(seg)).reduce((a, x) => a + x.length, 0) : 0, k = Math.max(1, Math.ceil(seg.length / 3));
      for (const w of seg.wallInfo ?? []) for (let q = 0; q < k; q++) { const A = sectionAt(ptf, s0 + seg.length * q / k), B = sectionAt(ptf, s0 + seg.length * (q + 1) / k), ta = q / k, tb = (q + 1) / k;
        const da = w.dlat[0] + (w.dlat[1] - w.dlat[0]) * ta, db = w.dlat[0] + (w.dlat[1] - w.dlat[0]) * tb, ha = w.height[0] + (w.height[1] - w.height[0]) * ta, hb = w.height[0] + (w.height[1] - w.height[0]) * tb; if (ha <= 0 && hb <= 0) continue;
        const a = A.point(da), b = B.point(db); quad(W, N(...a), N(...b), N(b[0], b[1], b[2] + Math.max(hb, 0.3)), N(a[0], a[1], a[2] + Math.max(ha, 0.3))); } }
    g.node({ name: "walls", mesh: g.mesh("walls", [{ ...W, material: g.material("wall", col(0.8, 0.2, 0.2)) }]) });
    if (L.pitWall?.length) { const PW = { positions: [], indices: [] };
      for (const run of L.pitWall) for (let q = 0; q + 1 < run.length; q++) { const z = p => { let bi = 0, bd = Infinity; for (let i = 0; i < F.n; i++) { const e = (L.points[i][0] - p[0]) ** 2 + (L.points[i][1] - p[1]) ** 2; if (e < bd) { bd = e; bi = i; } } return F.gz(bi, p[2]); };
        const a = run[q], b = run[q + 1], za = z(a), zb = z(b); quad(PW, G(a[0], a[1], za), G(b[0], b[1], zb), G(b[0], b[1], zb + 3.3), G(a[0], a[1], za + 3.3)); }
      g.node({ name: "pit_wall", mesh: g.mesh("pit_wall", [{ ...PW, material: g.material("pit_wall", col(1, 0.5, 0)) }]) }); }
    // pit road: the lane, and the stall boxes' strip (2.2 m short of the stalls' line to the far side) as pit_stalls
    // (the game marks stall ground as a surface of its own)
    if (L.pit) { const sd = stalls.length ? Math.min(...stalls.map(x => Math.abs(x.v[1]))) : null, sf = i => L.pit.near[i] === null ? null : sd === null ? L.pit.far[i] : Math.max(L.pit.far[i], Math.min(L.pit.near[i], -(sd - 2.2) * FT));
      g.node({ name: "pit_area", mesh: g.mesh("pit_area", [{ ...strip(F, i => L.pit.near[i], sf, 2), material: g.material("pit_area", col(0.2, 0.4, 0.9)) }]) });
      if (sd !== null) g.node({ name: "pit_stalls", mesh: g.mesh("pit_stalls", [{ ...strip(F, sf, i => L.pit.far[i], 1), material: g.material("pit_stalls", col(0.4, 0.3, 0.9)) }]) }); }
    // the ground across, split by the .ptf's surfaces: grass / sand (material "grass") and paved (material "apron")
    if (L.ground?.z) { const cols = L.ground.z[0].length - 1, d0 = L.ground.d0, st = L.ground.step, sec = DL.map(s => sectionAt(ptf, s)), part = { grass: { positions: [], indices: [] }, apron: { positions: [], indices: [] } };
      for (let i = 0; i < F.n; i++) { const j1 = (i + 1) % F.n; for (let c = 0; c < cols; c++) { const da = d0 + st * c, db = da + st, ty = sec[i].surfaceAt(-(da + st / 2) * M), k = ty === 4 || ty === 5 ? "grass" : "apron";
        quad(part[k], F.at(i, da), F.at(j1, da), F.at(j1, db), F.at(i, db)); } }
      g.node({ name: "ground", mesh: g.mesh("ground", [{ ...part.apron, material: g.material("apron", col(0.55, 0.55, 0.5)) }, { ...part.grass, material: g.material("grass", col(0.3, 0.6, 0.3)) }]) }); }
    writeFileSync(join(outDir, files.physics = `${name}_physics.glb`), g.glb()); }

  // ---- lines
  { const g = new GLB("nr2003-gltf.mjs lines"), col = (r, gg, b) => ({ color: [r, gg, b, 1] });
    if (L.raceline) { const pos = []; for (let i = 0; i < F.n; i++) pos.push(...F.at(i, L.raceline[i], 0.3));
      g.node({ name: "raceline", mesh: g.mesh("raceline", [{ positions: pos, mode: 2, material: g.material("raceline", col(0, 1, 0)), ...(L.aiSpeed ? { attrs: { _AISPEED: L.aiSpeed } } : {}) }]), ...(L.aiSpeed ? { extras: { aiSpeed: L.aiSpeed } } : {}) }); }
    if (L.pitLane) { const idx = f => { const s = f * ptf.length; let bi = 0, bd = Infinity; DL.forEach((d, i) => { const e = Math.abs(d - s); if (e < bd) { bd = e; bi = i; } }); return bi; };
      const i0 = idx(L.pitLane[0]), i1 = idx(L.pitLane[1]), pos = []; let lastPit = null;
      for (let i = i0, k = 0; k <= F.n; i = (i + 1) % F.n, k++) { const near = L.pit?.near[i], far = L.pit?.far[i], d = near != null && far != null ? (near + far) / 2 : null;
        if (d !== null) lastPit = d; pos.push(...F.at(i, d ?? lastPit ?? (L.edges.in[i] - 15), 0.3)); if (i === i1) break; }
      g.node({ name: "pit_lane", mesh: g.mesh("pit_lane", [{ positions: pos, mode: 3, material: g.material("pit_lane", col(0, 0.6, 1)) }]) }); }
    for (const { k, v: [s, d] } of stalls) { const S = sectionAt(ptf, s); g.node({ name: `pit_stall_${String(k).padStart(2, "0")}`, translation: N(...S.point(d)), rotation: yaw(S.h) }); }
    if (L.grid?.cars?.length) { const place = (nm, c) => { let bi = 0, bd = Infinity; for (let i = 0; i < F.n; i++) { const e = (L.points[i][0] - c[0]) ** 2 + (L.points[i][1] - c[1]) ** 2; if (e < bd) { bd = e; bi = i; } }
        const d = (c[0] - L.points[bi][0]) * F.nr[bi][0] + (c[1] - L.points[bi][1]) * F.nr[bi][1]; g.node({ name: nm, translation: G(c[0], c[1], F.gz(bi, d)), rotation: yaw(c[2]) }); };
      L.grid.cars.forEach((c, i) => place(`grid_${String(i + 1).padStart(2, "0")}`, c)); if (L.grid.pace) place("grid_pace", L.grid.pace); }
    g.extras = { track: Object.fromEntries(Object.entries({ recordLap: L.recordLap, pitSpeed: L.pitSpeed, paceSpeed: L.paceSpeed }).filter(([, v]) => v !== undefined)) };
    writeFileSync(join(outDir, files.lines = `${name}_lines.glb`), g.glb()); }

  const t = T.ini?.track ?? {}, title = (t.track_name ?? basename(dir)).replace(/\s+/g, " ").trim();
  const info = { name: title.replace(/\w\S*/g, w => w[0] + w.slice(1).toLowerCase()), city: t.track_city, state: t.track_state, laps: +(T.ini?.cup?.race_laps ?? t.race_laps) || undefined,
    miles: L.points.length ? +(ptf.length / 1609.344).toFixed(3) : 0, stalls: stalls.length, grid: L.grid?.cars?.length ?? 0, raceline: !!L.raceline };
  writeFileSync(join(outDir, `${name}_track.json`), JSON.stringify({ track: info, files }, null, 2));
  log(`${info.name}: ${files.scenery}, ${files.physics}, ${files.lines} (${info.miles} mi, ${info.stalls} stalls, ${info.grid} grid places${info.raceline ? ", racing line" : ""})`);
  return { files, info, outDir };
}

if (process.argv[1] && basename(process.argv[1]) === "nr2003-gltf.mjs") {
  const a = process.argv.slice(2), objects = a.flatMap((v, i) => v === "--objects" && a[i + 1] ? [a[i + 1]] : []), rt = a.indexOf("--road-tone");
  if (a.length < 2) { console.log("usage: node nr2003-gltf.mjs <NR2003 track folder> <output folder> [--objects <shared objects folder>]... [--road-tone <0-255 | off>]"); process.exit(1); }
  nr2003ToGLTF(a[0], a[1], { objects, log: console.log, ...(rt >= 0 ? { roadTone: a[rt + 1] === "off" ? false : +a[rt + 1] } : {}) });
}
