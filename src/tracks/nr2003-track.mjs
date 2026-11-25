// nr2003-track.mjs — NR2003 track folders -> a layout for trackwarp (track-pack "layout": "layout.json").
//
// An NR2003 track folder: <name>.dat (an archive, nr2003-dat.mjs: the scenery .3do models and .mip textures, often
// the track's .ptf too), <name>.ptf (when not in the archive), track.ini (names, laps, pit stalls and grid as dlong /
// dlat), *.lp (AI lines as dlat per 3 m of dlong), <name>.cam (TV cameras).
//
// The .ptf is Papyrus' object stream (as the .3do): per object u32 object id, u32 class id, and the first time a
// class appears u32 name length + its name ("SegmentDescriptor"); then the class's fields (u32 version 1, ...);
// lists are u32 byte count (4 per entry) + the objects; some fields are single bytes, so nothing is aligned.
// The track is a list of SegmentDescriptor (Sandbox's track segments, metres, radians):
//   - its X_SectionDescriptor list: the lines running along the segment (track edges, apron, grass, walls' feet):
//     u32 1, u32 0, u32 format, then the line at the segment's start and end: format 2: 3 doubles each (dlat, z,
//     dz/dlong), format 3: f32 dlat, double z, f32 dz/dlong; then a byte. dlat is metres to the left of the
//     reference line (the segment's own path), z absolute height.
//     These are the height knots across the track (z between them linear).
//   - F_SectionDescriptor: the surfaces across, right to left, each from its dlat to the next one's (u32 1, u32 0,
//     u32 format, then dlat at the segment's start and end: format 4 two doubles, format 5 two f32; then its
//     appearance / texture: asphalt, paint (the white lines), concrete, grass, ...).
//   - W_SectionDescriptor: the walls (u32 1, u32 0, u32 7, f32 dlat at start and end, ...: outside wall, catch fence,
//     pit / inside walls).
//   - at its end: start x, y, heading and end x, y, heading (doubles; a 7th double follows in later versions), then
//     two bytes. Straight when the headings agree, else a circular arc (radius = length / heading change).
// The segments run from dlong 0 (the start / finish line) counter-clockwise for an oval (heading increasing).
//
// layoutFromNR2003(dir) -> { layout (feet, trackwarp's frame: right of travel positive), info (track.ini) }
// CLI: node nr2003-track.mjs info <track folder>   (converting: nr2003-gltf.mjs)

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { readDat } from "./nr2003-dat.mjs";

const FT = 3.28084;                                   // feet per metre

// ---- the object stream: class ids by name, and where each object of a class starts
export function classIndex(b) {
  const classes = new Map();
  for (let p = 12; p < b.length - 4; p++) {
    const n = b.readUInt32LE(p - 4); if (n < 4 || n > 64 || p + n > b.length || b[p + n - 1] !== 0) continue;
    const name = b.subarray(p, p + n - 1).toString("latin1"); if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    const cid = b.readUInt32LE(p - 8), oid = b.readUInt32LE(p - 12); if (!classes.has(name) && cid === oid + 1) classes.set(name, { cid, first: p - 12, firstOid: oid });
  }
  return classes;
}
export function objectsOf(b, c) {                            // offsets of every object of class c: u32 oid (>= the first), u32 cid
  const out = [];
  for (let p = c.first; p < b.length - 8; p++) if (b.readUInt32LE(p + 4) === c.cid) { const oid = b.readUInt32LE(p); if (oid >= c.firstOid && oid < c.firstOid + 1e6) out.push({ at: p, oid }); }
  return out.filter((o, i, a) => !i || o.oid > a[i - 1].oid);   // object ids only grow
}
export const bodyAt = (b, o, name) => o.at + 8 + (o.at === name.first ? 4 + b.readUInt32LE(o.at + 8) : 0);

export function readPTF(b) {
  const C = classIndex(b), S = C.get("SegmentDescriptor"), X = C.get("X_SectionDescriptor"), F = C.get("F_SectionDescriptor"), W = C.get("W_SectionDescriptor");
  if (!S) throw new Error("no track segments in the .ptf");
  const segs = objectsOf(b, S), xs = X ? objectsOf(b, X) : [], fs = F ? objectsOf(b, F) : [], ws = W ? objectsOf(b, W) : [];
  // textures by object id (a texture or an appearance written again later is only a reference: its id and class 0)
  const T = C.get("TextureDescriptor"), A = C.get("AppearanceDescriptor"), texOf = new Map();
  if (T) for (const o of objectsOf(b, T)) { const p = bodyAt(b, o, T); for (let q = p; q < p + 24; q++) { const n = b.readUInt32LE(q); if (n > 4 && n < 80 && b[q + 3 + n] === 0) { const t = b.toString("latin1", q + 4, q + 3 + n); if (/\.mip$/i.test(t)) { texOf.set(o.oid, t); break; } } } }
  if (A) for (const o of objectsOf(b, A)) { const p = bodyAt(b, o, A), t = texOf.get(b.readUInt32LE(p + 12)); if (t) texOf.set(o.oid, t); }
  const appearanceTexture = (from, to) => { for (let q = from; q + 8 <= Math.min(to, b.length); q++) { const oid = b.readUInt32LE(q), cid = b.readUInt32LE(q + 4); if ((cid === A?.cid || cid === 0) && texOf.has(oid)) return texOf.get(oid); } return null; };
  // (headings are angles: within one turn either way; Iowa's first segment otherwise matched one double too early)
  const ok = v => v.every(Number.isFinite) && Math.abs(v[2]) <= 2 * Math.PI + 0.01 && Math.abs(v[5]) <= 2 * Math.PI + 0.01 && v.every(x => Math.abs(x) < 1e5);
  const segments = []; let prevEnd = null;
  for (let i = 0; i < segs.length; i++) {
    const next = i + 1 < segs.length ? segs[i + 1].at : null; let tail = null;
    if (next !== null) for (const back of [50, 58, 66]) { const v = [0, 1, 2, 3, 4, 5].map(k => b.readDoubleLE(next - back + 8 * k)); if (ok(v) && (!prevEnd || Math.hypot(v[0] - prevEnd[0], v[1] - prevEnd[1]) < 0.05)) { tail = v; break; } }
    else if (prevEnd) { const key = Buffer.alloc(8); key.writeDoubleLE(prevEnd[0]); for (let p = b.indexOf(key, segs[i].at); p >= 0; p = b.indexOf(key, p + 1)) { const v = [0, 1, 2, 3, 4, 5].map(k => b.readDoubleLE(p + 8 * k)); if (ok(v) && Math.abs(v[1] - prevEnd[1]) < 0.05) { tail = v; break; } } }
    if (!tail) throw new Error(`segment ${i}: start / end not found`);
    const lines = [];
    for (const o of xs) { if (o.at < segs[i].at || (next !== null && o.at > next)) continue; const p = bodyAt(b, o, X), fmt = b.readUInt32LE(p + 8);
      if (fmt === 2) { const v = [0, 1, 2, 3, 4, 5].map(k => b.readDoubleLE(p + 12 + 8 * k)); lines.push({ dlat: [v[0], v[3]], z: [v[1], v[4]], dz: [v[2], v[5]] }); }
      else if (fmt === 3) { const q = p + 12; lines.push({ dlat: [b.readFloatLE(q), b.readFloatLE(q + 16)], z: [b.readDoubleLE(q + 4), b.readDoubleLE(q + 20)], dz: [b.readFloatLE(q + 12), b.readFloatLE(q + 28)] }); } }
    const inSeg = o => o.at > segs[i].at && (next === null || o.at < next), fine = v => v.every(x => Number.isFinite(x) && Math.abs(x) < 1000);
    // surfaces: dlat at start / end, the surface type (1 asphalt, 2 concrete / apron, 3 paint, 4 grass, ...) and texture
    const surfaceInfo = fs.filter(inSeg).map(o => { const p = bodyAt(b, o, F), fmt = b.readUInt32LE(p + 8), q = p + (fmt === 4 ? 28 : 20);
      return { dlat: fmt === 4 ? [b.readDoubleLE(p + 12), b.readDoubleLE(p + 20)] : [b.readFloatLE(p + 12), b.readFloatLE(p + 16)], type: b.readUInt32LE(q + 5), texture: appearanceTexture(q, q + 48) }; }).filter(f => fine(f.dlat));
    // walls: dlat at start / end, height at start / end (m), texture
    const wallInfo = ws.filter(inSeg).map(o => { const p = bodyAt(b, o, W); return { dlat: [b.readFloatLE(p + 12), b.readFloatLE(p + 16)], height: [b.readDoubleLE(p + 25), b.readDoubleLE(p + 33)], texture: appearanceTexture(p + 41, p + 200) }; }).filter(w => fine(w.dlat));
    const surfaces = surfaceInfo.map(f => f.dlat), walls = wallInfo.map(w => w.dlat);
    const [x0, y0, h0, x1, y1, h1] = tail, chord = Math.hypot(x1 - x0, y1 - y0); let dh = h1 - h0; while (dh > Math.PI) dh -= 2 * Math.PI; while (dh < -Math.PI) dh += 2 * Math.PI;
    if (Math.abs(dh) < 1e-4) dh = 0;
    const length = !dh ? chord : Math.abs(dh) * chord / (2 * Math.sin(Math.abs(dh) / 2));
    segments.push({ x0, y0, h0, x1, y1, h1, dh, length, radius: !dh ? Infinity : length / dh, lines, surfaces, walls, surfaceInfo, wallInfo }); prevEnd = [x1, y1];
  }
  return { segments, length: segments.reduce((a, s) => a + s.length, 0), classes: [...C.keys()] };
}

// track-side objects: per TSOReferenceDescriptor u32 1, 0, 1, then x, y, z (m), heading (radians, counter-clockwise
// about z), two more angles (pitch / roll: always 0 seen) as doubles, then its TSODescriptor: u32 1, 0, 3, the .3do
// file name (or, when that object was written before, just its id and class 0)
export function readTSOs(b) {
  const C = classIndex(b), R = C.get("TSOReferenceDescriptor"), D = C.get("TSODescriptor"); if (!R || !D) return [];
  const names = new Map(), out = [];
  for (const o of objectsOf(b, D)) { const p = bodyAt(b, o, D); for (let q = p; q < p + 24; q++) { const n = b.readUInt32LE(q); if (n > 4 && n < 80 && b[q + 3 + n] === 0) { const t = b.toString("latin1", q + 4, q + 3 + n); if (/\.3do$/i.test(t)) { names.set(o.oid, t); break; } } } }
  for (const o of objectsOf(b, R)) { const p = bodyAt(b, o, R), v = [0, 1, 2, 3, 4, 5].map(k => b.readDoubleLE(p + 12 + 8 * k)), q = p + 60;
    const name = names.get(b.readUInt32LE(q)); if (name && v.every(Number.isFinite)) out.push({ model: name, x: v[0], y: v[1], z: v[2], heading: v[3], pitch: v[4], roll: v[5] }); }
  return out;
}

// .lp (AI lines): u32 0x10003, u32 count, count x 24 bytes: f32 a speed-like value, f32, f32 dlat (m, left +),
// f32, f32 dlong step (3), f32 0; one record per 3 m of dlong from the start line
export function readLP(b) {
  if (!b || b.length < 8 || b.readUInt32LE(0) !== 0x10003) return null; const n = b.readUInt32LE(4); if (8 + 24 * n > b.length) return null;
  const recs = []; for (let i = 0; i < n; i++) { const o = 8 + 24 * i; recs.push({ v: b.readFloatLE(o), dlat: b.readFloatLE(o + 8), step: b.readFloatLE(o + 16) }); }
  return { step: recs[0]?.step || 3, recs };
}

export function readIni(text) {
  const out = {}; let sec = "";
  for (const raw of text.split(/\r?\n/)) { const line = raw.replace(/;.*$/, "").trim(); if (!line) continue; const m = line.match(/^\[\s*(.+?)\s*\]$/); if (m) { sec = m[1].toLowerCase(); out[sec] ??= {}; continue; }
    const kv = line.match(/^([^=]+?)\s*=?\s+(.*)$|^([^=]+?)\s*=\s*(.*)$/); if (!kv) continue; const k = (kv[1] ?? kv[3]).trim().toLowerCase(), v = (kv[2] ?? kv[4]).trim(); (out[sec] ??= {})[k] = v; }
  return out;
}

// ---- a point on the reference line at dlong s (metres from the start line): x, y, heading
export function pointAt(seg, t) {
  if (!seg.dh) return [seg.x0 + (seg.x1 - seg.x0) * t, seg.y0 + (seg.y1 - seg.y0) * t, seg.h0];
  const R = seg.radius, cx = seg.x0 - Math.sin(seg.h0) * R, cy = seg.y0 + Math.cos(seg.h0) * R, h = seg.h0 + seg.dh * t;
  return [cx + Math.sin(h) * R, cy - Math.cos(h) * R, h];
}
const hermite = (a, b, ma, mb, t) => { const t2 = t * t, t3 = t2 * t; return (2 * t3 - 3 * t2 + 1) * a + (t3 - 2 * t2 + t) * ma + (-2 * t3 + 3 * t2) * b + (t3 - t2) * mb; };

// the track across at dlong (metres from the line, wrapped): reference point x, y, heading h, the height at a dlat
// (metres, left +) and the segment; nr2003-gltf places walls, stalls and stall boxes with it
export function sectionAt(ptf, dlong) {
  const L = ptf.length, s = ((dlong % L) + L) % L; let acc = 0, seg = ptf.segments.at(-1), t = 1;
  for (const sg of ptf.segments) { if (s <= acc + sg.length) { seg = sg; t = (s - acc) / sg.length; break; } acc += sg.length; }
  const [x, y, h] = pointAt(seg, t), at = v => v[0] + (v[1] - v[0]) * t;
  const K = seg.lines.map(l => ({ d: at(l.dlat), z: hermite(l.z[0], l.z[1], l.dz[0] * seg.length, l.dz[1] * seg.length, t) })).sort((a, b) => a.d - b.d);
  const zAt = d => { if (!K.length) return 0; if (d <= K[0].d) return K[0].z; for (let j = 1; j < K.length; j++) if (d <= K[j].d) return K[j - 1].z + (K[j].z - K[j - 1].z) * (d - K[j - 1].d) / ((K[j].d - K[j - 1].d) || 1); return K.at(-1).z; };
  // the surface at a dlat: the F section it falls in (each from its dlat to the next one's, left +): 1 asphalt,
  // 2 concrete, 3 paint, 4 grass, 5 sand; past the last one its type, before the first null
  const F = (seg.surfaceInfo ?? []).map(f => ({ d: at(f.dlat), type: f.type })).sort((a, b) => a.d - b.d);
  const surfaceAt = d => { let r = null; for (const f of F) if (f.d <= d + 1e-6) r = f.type; return r; };
  return { x, y, h, t, seg, at, zAt, surfaceAt, point: d => [x - Math.sin(h) * d, y + Math.cos(h) * d, zAt(d)] };
}

// a wall line (feet per layout point) with each jump of 8 ft or more eased over 300 ft on its far side (see above)
export function easeWallJumps(WIN, lapFt) {
  const n = WIN.length, R = Math.max(2, Math.round(300 / (lapFt / n))), w = WIN.slice();
  for (let i = 0; i < n; i++) { const j = (i + 1) % n, a = w[i], b = w[j]; if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) < 8) continue;
    const fwd = Math.abs(b) > Math.abs(a), near = fwd ? a : b, from = fwd ? j : i;   // ease the farther side, away from the jump
    for (let k = 0; k < R; k++) { const q = fwd ? (from + k) % n : (from - k + n) % n; if (!Number.isFinite(w[q]) || Math.abs(w[q]) < Math.abs(near)) break;
      const t = (k + 1) / (R + 1), e = t * t * (3 - 2 * t); WIN[q] = near + (w[q] - near) * e; } }
  return WIN;
}

export function layoutFromPTF(ptf, { step = 3, ini = null, lp = null } = {}) {
  const P = [], Z = [], BANK = [], EIN = [], EOUT = [], WIN = [], WOUT = [], DL = [], GZ = [], LW = [];
  // the ground across (the knots' heights) on a lateral grid, for the apron, pit road and infield (trackwarp ground)
  const span = Math.max(...ptf.segments.flatMap(sg => sg.lines.flatMap(l => l.dlat.map(Math.abs))), 20) * FT, gstep = 4, g0 = -Math.ceil(span / gstep) * gstep, gn = Math.round(-2 * g0 / gstep) + 1;
  let s0 = 0;
  for (const seg of ptf.segments) {
    const n = Math.max(1, Math.round(seg.length / step));
    for (let k = 0; k < n; k++) { const t = k / n, [x, y] = pointAt(seg, t);
      const at = v => v[0] + (v[1] - v[0]) * t;
      // heights across: the knot lines, z linear between them (flat past the outermost)
      const K = seg.lines.map(l => ({ dlat: at(l.dlat), z: hermite(l.z[0], l.z[1], l.dz[0] * seg.length, l.dz[1] * seg.length, t) })).sort((a, b) => a.dlat - b.dlat);
      const zAt = d => { if (!K.length) return 0; if (d <= K[0].dlat) return K[0].z; for (let j = 1; j < K.length; j++) if (d <= K[j].dlat) return K[j - 1].z + (K[j].z - K[j - 1].z) * (d - K[j - 1].dlat) / ((K[j].dlat - K[j - 1].dlat) || 1); return K.at(-1).z; };
      // walls: the nearest either side of the reference line (the outside wall; the inside / pit wall)
      const wd = seg.walls.map(at), wr = Math.max(...wd.filter(d => d < 0), -Infinity), wl = Math.min(...wd.filter(d => d > 0), Infinity);
      // the racing surface: out to the outside wall on the right; on the left to the last surface boundary at least
      // 1 m short of the inside wall (the white line / apron start), else the first boundary past 8 m
      const fb = seg.surfaces.map(at).sort((a, b) => a - b), rightEdge = Number.isFinite(wr) ? wr : Math.max(...fb.filter(d => d < 0), -12);
      // The inside edge: the first height knot more than 5 m left of the reference line (where the banked surface
      // meets the apron: Milwaukee 12.1 m, the white line; Wilkesboro 7.7-10.5 m, its inside line), short of an inside
      // wall. (Taking the last surface boundary short of the inside wall counted Wilkesboro's flat infield apron and pit
      // area, out to 85 ft, as racing surface: the inside AI lane ran there and the field piled into the pit wall.)
      const kn = seg.lines.map(l => at(l.dlat)).filter(d => d > 5).sort((a, b) => a - b);
      let leftEdge = kn.length ? kn[0] : -Infinity;
      if (Number.isFinite(leftEdge) && Number.isFinite(wl)) leftEdge = Math.min(leftEdge, wl - 0.3);
      if (!Number.isFinite(leftEdge)) leftEdge = Number.isFinite(wl) ? Math.max(...fb.filter(d => d > 0 && d < wl - 1), -Infinity) : -Infinity;
      if (!Number.isFinite(leftEdge)) leftEdge = fb.find(d => d > 8) ?? 12;
      const zl = zAt(leftEdge), zr = zAt(rightEdge), sl = (zr - zl) / (leftEdge - rightEdge), z = zl + (zr - zl) * leftEdge / (leftEdge - rightEdge);
      P.push([x * FT, y * FT]); Z.push(z * FT); BANK.push(Math.atan(sl) * 180 / Math.PI); DL.push(s0 + seg.length * t);
      { const row = []; for (let j = 0; j < gn; j++) row.push(+(zAt(-(g0 + gstep * j) / FT) * FT).toFixed(2)); GZ.push(row); }
      EIN.push(-leftEdge * FT); EOUT.push(-rightEdge * FT); WOUT.push(Number.isFinite(wr) ? -wr * FT : null); WIN.push(Number.isFinite(wl) ? -wl * FT : null); LW.push(wd.filter(d => d > 0)); }
    s0 += seg.length;
  }
  const layout = { points: P, z: Z, bank: BANK, edges: { in: EIN, out: EOUT }, walls: { in: WIN, out: WOUT }, ground: { d0: g0, step: gstep, z: GZ } };
  // pit road from track.ini: stalls (dlong, dlat, m) over the pit lane's dlong range; its far side 4 m past the stalls
  const pl = ini?.pit_lane_0, stalls = Object.entries(pl ?? {}).filter(([k]) => /^stall_\d+$/.test(k)).map(([, v]) => v.split(/\s+/).map(Number));
  if (stalls.length) {
    const total = ptf.length, a = +pl.pit_lane_start_dlong, b = +pl.pit_lane_end_dlong, inLane = s => Number.isFinite(a) && Number.isFinite(b) ? (a <= b ? s >= a && s <= b : s >= a || s <= b) : true;
    const side = Math.sign(stalls[0][1]) || 1, far = Math.max(...stalls.map(v => Math.abs(v[1]))) + 4, near = Math.min(...stalls.map(v => Math.abs(v[1]))) - 8;
    // (the far side: the wall behind the stalls (within 12 m: Milwaukee's armco at 30.3 m, stalls at 27.5), else 2.5 m
    // past the stalls (the base's stops sit ~8 ft short of its wall): trackwarp maps the base's wall behind its stalls onto it)
    const stallMax = far - 4, farAt = i => { const back = LW[i].filter(d => d > stallMax + 0.5 && d < stallMax + 12); return back.length ? Math.min(...back) - 0.3 : stallMax + 2.5; };
    if (side > 0) { layout.pit = { near: DL.map(s => inLane(s % total) ? -near * FT : null), far: DL.map((s, i) => inLane(s % total) ? -farAt(i) * FT : null) };
      // the pit wall: a wall between the racing surface and the stalls along pit road (Milwaukee's at 12.2 m), as runs of
      // [x, y, d] (feet; d sideways, right +). The base track has none there (Lowe's: grass), so trackwarp builds it as a
      // free-standing wall of its own: without it cars drove through the track's pit wall.
      const n = P.length, runs = []; let run = null, firstAt0 = false;
      for (let i = 0; i < n; i++) { const sL = DL[i] % total, span = 30, near2 = inLane(sL) || inLane((sL + span) % total) || inLane((sL - span + total) % total);
        const edge = -EIN[i] / FT, w = near2 ? LW[i].filter(d => d > edge - 0.5 && d < near - 1) : [];
        if (w.length) { const d = -Math.min(...w) * FT, a = P[(i - 1 + n) % n], b = P[(i + 1) % n], tx = b[0] - a[0], ty = b[1] - a[1], m = Math.hypot(tx, ty) || 1;
          if (!run) { run = []; if (i === 0) firstAt0 = true; } run.push([+(P[i][0] + ty / m * d).toFixed(2), +(P[i][1] - tx / m * d).toFixed(2), +d.toFixed(2)]); }
        else if (run) { if (run.length >= 3) runs.push(run); else if (!runs.length) firstAt0 = false; run = null; } }
      if (run) { if (firstAt0 && runs.length) runs[0] = [...run, ...runs[0]]; else if (run.length >= 3) runs.push(run); }   // (a run through the line: joined)
      if (runs.length) layout.pitWall = runs;
    }
  }
  // The inside wall jumps where a wall ends (Milwaukee's pit wall at 12.2 m ends with pit road and the next one is the
  // armco 30 m in): trackwarp maps the base's inside wall onto it point by point, and across a jump that tore the
  // base's pit exit apart (zigzag walls from 50 to 110 ft in, the pit lanes through them; a car leaving the pits
  // stopped there). Each jump is eased over 300 ft on its far side (beyond the end of the nearer wall), so the
  // nearer wall keeps its place. (Pointing the base's inside wall at the wall past the stalls instead put the game's
  // pit road 20-50 ft inside the track's own, out on the grass, with the stalls behind the armco.)
  easeWallJumps(WIN, ptf.length * FT);
  // the racing line (raceline.lp): sideways distance per layout point, right + (feet), from the record at its dlong
  if (lp?.recs?.length > 10) { const R = lp.recs, st = lp.step, L = R.length;
    layout.raceline = DL.map(s => { const f = (s % ptf.length) / st, i = Math.floor(f), t = f - i; return +(-(R[i % L].dlat + (R[(i + 1) % L].dlat - R[i % L].dlat) * t) * FT).toFixed(2); }); }
  // the AI's speed along the lap: raceline.lp's speed column (relative: the scale differs per track) per layout point,
  // and the cup record lap (track.ini [cup] record_lap_time) it is scaled to (trackwarp warpAI)
  if (lp?.recs?.length > 10) { const R = lp.recs, st = lp.step, L = R.length; layout.aiSpeed = DL.map(s => { const f = (s % ptf.length) / st, i = Math.floor(f), t = f - i; return +(R[i % L].v + (R[(i + 1) % L].v - R[i % L].v) * t).toFixed(4); }); }
  const rec = parseFloat(ini?.cup?.record_lap_time ?? Object.values(ini ?? {}).find(sec => sec?.record_lap_time)?.record_lap_time); if (rec > 0) layout.recordLap = rec;
  // pit stalls (track.ini [pit_lane_0] stall_N = dlong dlat heading) as lap fractions: trackwarp lines the base's pit
  // road up with them along the lap
  const sd = stalls.map(v => v[0]).filter(Number.isFinite);
  if (sd.length > 3) layout.pitStalls = sd.map(d => +((((d / ptf.length) % 1) + 1) % 1).toFixed(5));
  const ps = parseFloat(pl?.pit_lane_start_dlong), pe = parseFloat(pl?.pit_lane_end_dlong);
  if (Number.isFinite(ps) && Number.isFinite(pe)) layout.pitLane = [ps, pe].map(d => +((((d / ptf.length) % 1) + 1) % 1).toFixed(5));
  // the starting grid (track.ini [starting_grid_N] stall_K / stall_pace = dlong dlat): feet, in the layout's frame. Of
  // the track's grids the first whose places lie on the racing surface (Milwaukee's grid 0 lines up on the apron / pit
  // road, 17-22 m in; its grid 1 is on the track)
  const gp = v => { const [dl, da] = String(v).trim().split(/\s+/).map(parseFloat); if (!Number.isFinite(dl) || !Number.isFinite(da)) return null;
    const L = ptf.length, s = ((dl % L) + L) % L; let acc = 0; for (const seg of ptf.segments) { if (s <= acc + seg.length) { const t = (s - acc) / seg.length, [x, y, h] = pointAt(seg, t); return { p: [+((x - Math.sin(h) * da) * FT).toFixed(2), +((y + Math.cos(h) * da) * FT).toFixed(2), +h.toFixed(5)], s, da }; } acc += seg.length; } return null; };
  const onSurface = g => { let k = 0; for (const c of g) { let bi = 0, bd = Infinity; DL.forEach((d, i) => { const e = Math.abs(d - c.s); if (e < bd) { bd = e; bi = i; } }); const d = -c.da * FT; if (d >= layout.edges.in[bi] - 1 && d <= layout.edges.out[bi] + 1) k++; } return k / (g.length || 1); };
  for (const name of Object.keys(ini ?? {}).filter(k => /^starting_grid_\d+$/.test(k)).sort()) { const sg = ini[name];
    const cars = Object.entries(sg).filter(([k]) => /^stall_\d+$/.test(k)).sort((a, b) => parseInt(a[0].slice(6)) - parseInt(b[0].slice(6))).map(([, v]) => gp(v)).filter(Boolean);
    if (cars.length > 3 && onSurface(cars) > 0.8) { const pace = sg.stall_pace ? gp(sg.stall_pace) : null; layout.grid = { from: name, cars: cars.map(c => c.p), pace: pace?.p ?? null }; break; } }
  // pit road and pace car speed limits (mph) from track.ini (any section): AI_SPDS pit groups (trackwarp warpAI)
  const iniVal = key => { for (const sec of Object.values(ini ?? {})) if (sec?.[key] !== undefined) { const v = parseFloat(sec[key]); if (Number.isFinite(v) && v > 0) return v; } return null; };
  const pitMph = ini?.pit_lane_0?.speed_limit_mph ? parseFloat(ini.pit_lane_0.speed_limit_mph) : iniVal("speed_limit_mph"), paceMph = iniVal("pace_speed_limit_mph");
  if (pitMph > 0) layout.pitSpeed = Math.round(pitMph); if (paceMph > 0) layout.paceSpeed = Math.round(paceMph);
  return { layout, dlong: DL };
}

// Shared objects: NR2003 tracks also place objects kept outside their own archive (lights, cones, trucks shared
// between tracks). objects: folders to look in after the track's archive: loose .3do / .mip files (any depth) and
// the .dat archives found there.
export function assetSource(dat, objects = []) {
  const loose = new Map(), dats = [];
  const walk = (d, depth) => { let ents = []; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) { const f = join(d, e.name); if (e.isDirectory()) { if (depth < 4) walk(f, depth + 1); }
      else if (/\.(3do|mip)$/i.test(e.name)) { if (!loose.has(e.name.toLowerCase())) loose.set(e.name.toLowerCase(), f); }
      else if (/\.dat$/i.test(e.name)) { try { dats.push(readDat(readFileSync(f))); } catch {} } } };
  for (const d of objects) walk(d, 0);
  const key = n => n.replace(/^.*[\\/]/, "").toLowerCase();
  return { get: n => dat?.get(n) ?? (loose.has(key(n)) ? readFileSync(loose.get(key(n))) : null) ?? dats.reduce((b, a) => b ?? a.get(n), null),
    has: n => !!(dat?.has(n) || loose.has(key(n)) || dats.some(a => a.has(n))), shared: loose.size + dats.length };
}

export function readNR2003(dir, { objects = [] } = {}) {
  const files = readdirSync(dir), find = re => files.find(f => re.test(f)), datFile = find(/\.dat$/i), dat0 = datFile ? readDat(readFileSync(join(dir, datFile))) : null, dat = assetSource(dat0, dat0 ? objects : [dir, ...objects]);   // (no archive: the track's own folder holds its loose .3do / .mip files, as Montreal_2007's)
  // the .ptf: beside the archive and / or inside it; with several, the one whose scenery objects the archive has
  const cands = [...files.filter(f => /\.ptf$/i.test(f)).map(f => ({ name: f, buf: readFileSync(join(dir, f)) })), ...(dat0 ? dat0.entries.filter(x => /\.ptf$/i.test(x.name)).map(x => ({ name: x.name, buf: dat0.get(x.name) })) : [])];
  if (!cands.length) throw new Error(`no .ptf track file in ${dir}`);
  for (const c of cands) c.missing = dat ? readTSOs(c.buf).filter(t => !dat.has(t.model)).length : 0;
  const best = cands.reduce((a, c) => c.missing < a.missing ? c : a), ptfName = best.name, ptfBuf = best.buf;
  const iniFile = find(/^track\.ini$/i), ini = iniFile ? readIni(readFileSync(join(dir, iniFile), "latin1")) : {};
  const lpFile = find(/^raceline\.lp$/i) ?? find(/^race\.lp$/i), lp = lpFile ? readLP(readFileSync(join(dir, lpFile))) : null;
  return { dat, datFile, ptfName, ptf: readPTF(ptfBuf), tsos: readTSOs(ptfBuf), ini, lp, lpFile };
}

// (Tracks are no longer imported straight into a pack: nr2003-gltf.mjs writes glTF files to edit and add in the
// launcher, which reads them with gltf-layout.mjs.)

if (process.argv[1] && basename(process.argv[1]) === "nr2003-track.mjs") {
  const [cmd, dir, out] = process.argv.slice(2);
  if (cmd === "info") { const T = readNR2003(dir); console.log(`${T.ptfName}: ${T.ptf.segments.length} segments, ${T.ptf.length.toFixed(1)} m (${(T.ptf.length / 1609.344).toFixed(3)} mi); classes ${T.ptf.classes.join(" ")}`);
    T.ptf.segments.forEach((s, i) => console.log(`${String(i).padStart(3)} ${s.dh ? `arc R ${s.radius.toFixed(1)}` : "straight  "} ${s.length.toFixed(2).padStart(8)} m  knots ${s.lines.map(l => `${l.dlat[0].toFixed(1)}:${l.z[0].toFixed(2)}`).join(" ")} | surfaces ${s.surfaces.map(v => v[0].toFixed(1)).join(" ")} | walls ${s.walls.map(v => v[0].toFixed(1)).join(" ")}`)); }
  else console.log("usage: node nr2003-track.mjs info <track folder>   (to convert a track: node nr2003-gltf.mjs)");
}
