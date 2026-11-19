#!/usr/bin/env node
// tkphys.mjs — reader for the game's track physics files (TK_PHYS.DAT, one entry per TRCK row): the driving
// surface the cars collide with, the track sections, the car spots (grid, pit stalls...) and the AI / pit lines.
// Exports OBJ (collision mesh), JSON (everything decoded) and an SVG overview.
//
// LAYOUT (worked out from the game's loader 0xD9CB0, which turns the header counts into pointers; little-endian;
// coordinates: feet, z up — the render model (TK_REND) uses y up)
//   0x000 u32 counts[12]       spot tables, 0x3C bytes each: position 3f, 3x3 orientation (forward, right, up),
//                              +0x30 section index; Atlanta: 44 44 44 129 43 43 1 1 1 1 1 1
//   0x030 u32                  0x20-byte records (5 at Atlanta: camera / blimp anchors?)
//   0x034 u32 sections         0x64 bytes: bounds (xmin ymin xmax ymax), two boundary lines, u16 counts at
//                              +0x38 surface triangles, +0x3A (unused so far), +0x3C apron/infield triangles,
//                              +0x3E/+0x40/+0x42 edge records; linked into a ring (+0x5C prev, +0x60 next)
//   0x038 u32, 0x03C u32       0x78 and 0x68-byte records (after the vertices)
//   0x044 u16 vertices, u16    vertex count; 12-byte points count
//   0x048 u32 lineGroups[19]   0x90-byte line records per group: u16 segments, u16 points (= 2*segments + 1),
//                              11 u32 node counts...; points are quadratic-curve control points
//   data from 0x190: spot tables, 0x20 records, sections, triangles (40 bytes: u16 a, b, c, pad, tangent 3f,
//   plane normal 3f, plane d, u32 flags), line records, per-line arrays, nodes (0x1C), edge records (0x2C),
//   line points (12 bytes), per-segment data (64 bytes), vertices: xy (8 bytes) + plane (16 bytes: normal, d;
//   z = -(d + nx x + ny y) / nz), 12-byte points, 0x78 / 0x68 records, then a tail read by 0xD9C10.
// Line groups seen at Atlanta: 0 racing line, 1 six lanes across the track, 2 inside line, 3/4/5 pit entry,
//   6/7/8 pit exit, 9 and 10 per-stall paths (88 each), 11 pit road lanes, 14 a straight line across, 15 infield
//   loop, 16 large circles around the track (blimp / helicopter?).
//
// usage: node tkphys.mjs info <TK_PHYS.DAT|entry.bin> [entry]
//        node tkphys.mjs export <TK_PHYS.DAT|entry.bin> [entry] <outDir>
//        node tkphys.mjs roundtrip <TK_PHYS.DAT> [entry] <out.bin>     (rebuild the entry from its parts)
//        node tkphys.mjs collision <TK_PHYS.DAT> [entry] [out.gltf]     (decode / rebuild the collision layer; glTF overlay)
//        node tkphys.mjs doc <TK_PHYS.DAT> [entry] <out.json>           (the whole entry as an editable JSON document)
//        node tkphys.mjs fromdoc <in.json> <out.bin>                    (and back: an entry the game loads)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { parseTerf, isTerf } from "./terf.mjs";

export function physLayout(b) {
  const u32 = o => b.readUInt32LE(o), u16 = o => b.readUInt16LE(o);
  const L = {}; let p = 0x190;
  L.spotTables = []; for (let k = 0; k < 12; k++) { L.spotTables.push({ off: p, count: u32(k * 4) }); p += u32(k * 4) * 0x3c; }
  L.t20 = { off: p, count: u32(0x30) }; p += u32(0x30) * 0x20;
  const nSec = u32(0x34); L.sections = { off: p, count: nSec }; const S = p; p += nSec * 0x64;
  const sum = f => { let s = 0; for (let i = 0; i < nSec; i++) s += u16(S + i * 0x64 + f); return s; };
  L.surface = { off: p, count: sum(0x38) }; p += sum(0x38) * 40;
  L.secB = { off: p, count: sum(0x3a) }; p += sum(0x3a) * 40;
  L.apron = { off: p, count: sum(0x3c) }; p += sum(0x3c) * 40;
  L.groups = []; const G = p; let N = 0;
  for (let k = 0; k < 19; k++) { const n = u32(0x48 + k * 4); L.groups.push({ off: G + N * 0x90, count: n }); N += n; }
  p = G + N * 0x90; L.lineRecs = { off: G, count: N };
  let A = 0; for (let i = 0; i < N; i++) A += u16(G + i * 0x90);
  L.p128 = p; p += 4 * A; L.p12c = p; p += 4 * A; L.p130 = p; p += 12 * A; L.p134 = p; p += 4 * (A + N);
  const B = (7 * A + N) * 2; L.p138 = p; p += 7 * B; while (p & 3) p++;
  let C = 0; for (let i = 0; i < N; i++) for (let j = 1; j <= 11; j++) C += u32(G + i * 0x90 + j * 4);
  L.nodes = { off: p, count: C }; p += C * 0x1c;
  L.edges = { off: p, count: sum(0x40) + sum(0x42) + sum(0x3e) }; p += L.edges.count * 0x2c;
  let E = 0; for (let i = 0; i < N; i++) E += u16(G + i * 0x90 + 2);
  L.linePoints = { off: p, count: E }; p += 12 * E;
  L.segData = { off: p, count: A }; p += 64 * A;
  const nV = u16(0x44), n46 = u16(0x46);
  L.vertXY = { off: p, count: nV }; p += 8 * nV; L.vertPlane = { off: p, count: nV }; p += 16 * nV;
  L.points12 = { off: p, count: n46 }; p += 12 * n46;
  L.r78 = { off: p, count: u32(0x38) }; p += 0x78 * u32(0x38); L.r68 = { off: p, count: u32(0x3c) }; p += 0x68 * u32(0x3c);
  L.k12 = { off: p + 4, count: u32(p) }; p += 4 + 12 * u32(p);
  L.quads = { off: p, count: u32(0x40) }; p += 48 * u32(0x40);              // 4 corners each (grandstand / crowd areas)
  L.tail = { off: p, size: b.length - p, struct: u32(0x18c) };              // pointer-linked block, read by 0xD9C10
  return L;
}

// The file as an ordered list of byte ranges (header counts are kept in the 0x190-byte header; the pointer slots
// 0x94..0x188 are filled by the game at load). writePhys(parts) puts them back together; the tail's stored pointers
// (header +0x18C and the tail struct's fields) are moved with it.
export function physParts(b) {
  const L = physLayout(b), parts = [{ name: "header", bytes: Buffer.from(b.subarray(0, 0x190)) }];
  const order = [...L.spotTables.map((t, k) => ["spots" + k, t.off]), ["t20", L.t20.off], ["sections", L.sections.off], ["surface", L.surface.off], ["secB", L.secB.off], ["apron", L.apron.off],
    ["lineRecs", L.lineRecs.off], ["lineArrays", L.p128], ["nodes", L.nodes.off], ["edges", L.edges.off], ["linePoints", L.linePoints.off], ["segData", L.segData.off],
    ["vertXY", L.vertXY.off], ["vertPlane", L.vertPlane.off], ["points12", L.points12.off], ["r78", L.r78.off], ["r68", L.r68.off], ["k12", L.k12.off - 4], ["quads", L.quads.off], ["tail", L.tail.off]];
  for (let i = 0; i < order.length; i++) parts.push({ name: order[i][0], bytes: Buffer.from(b.subarray(order[i][1], i + 1 < order.length ? order[i + 1][1] : b.length)) });
  parts.tailBase = L.tail.off; parts.tailStruct = L.tail.struct;
  return parts;
}
export function writePhys(parts) {
  const out = Buffer.concat(parts.map(p => p.bytes)), tailOff = out.length - parts.at(-1).bytes.length, delta = tailOff - parts.tailBase;
  out.fill(0, 0x94, 0x18c);
  if (parts.tailStruct) {
    const s = parts.tailStruct + delta; out.writeUInt32LE(s, 0x18c);
    const fields = [4, 8, 0xc, 0x10, 0x14, 0x1c]; if (out[s + 2]) fields.push(0x18);
    if (out[s]) for (const f of fields) { const v = out.readUInt32LE(s + f); if (v) out.writeUInt32LE(v + delta, s + f); } else { const v = out.readUInt32LE(s + 0x1c); if (v) out.writeUInt32LE(v + delta, s + 0x1c); if (out[s + 2]) { const w = out.readUInt32LE(s + 0x18); if (w) out.writeUInt32LE(w + delta, s + 0x18); } }
  }
  return out;
  return L;
}

export function parsePhys(b) {
  const L = physLayout(b), f = o => b.readFloatLE(o), u16 = o => b.readUInt16LE(o), u32 = o => b.readUInt32LE(o);
  const verts = []; for (let i = 0; i < L.vertXY.count; i++) { const x = f(L.vertXY.off + i * 8), y = f(L.vertXY.off + i * 8 + 4), o = L.vertPlane.off + i * 16, nx = f(o), ny = f(o + 4), nz = f(o + 8), d = f(o + 12); verts.push([x, y, nz ? -(d + nx * x + ny * y) / nz : 0]); }
  const sections = [], surface = [], apron = []; let a = L.surface.off, c = L.apron.off;
  for (let s = 0; s < L.sections.count; s++) {
    const o = L.sections.off + s * 0x64, sec = { index: s, bounds: [f(o), f(o + 4), f(o + 8), f(o + 12)], surface: [], apron: [] };
    for (let i = 0; i < u16(o + 0x38); i++, a += 40) { const t = { v: [u16(a), u16(a + 2), u16(a + 4)], normal: [f(a + 20), f(a + 24), f(a + 28)], flags: u32(a + 36) }; surface.push(t); sec.surface.push(surface.length - 1); }
    for (let i = 0; i < u16(o + 0x3c); i++, c += 40) { const t = { v: [u16(c), u16(c + 2), u16(c + 4)], normal: [f(c + 20), f(c + 24), f(c + 28)], flags: u32(c + 36) }; apron.push(t); sec.apron.push(apron.length - 1); }
    sections.push(sec);
  }
  const spots = L.spotTables.map((t, k) => ({ table: k, spots: [...Array(t.count)].map((_, i) => { const o = t.off + i * 0x3c; return { pos: [f(o), f(o + 4), f(o + 8)], forward: [f(o + 12), f(o + 16), f(o + 20)], section: u32(o + 0x30) }; }) }));
  const lines = []; let rec = L.lineRecs.off, cum = 0;
  L.groups.forEach((g, gi) => { for (let r = 0; r < g.count; r++, rec += 0x90) { const n = u16(rec + 2), pts = []; for (let i = 0; i < n; i++) { const o = L.linePoints.off + (cum + i) * 12; pts.push([f(o), f(o + 4), f(o + 8)]); } cum += n; lines.push({ group: gi, index: r, segments: u16(rec), points: pts }); } });
  return { layout: L, verts, sections, surface, apron, spots, lines };
}

// floats in the documents: numbers, or "nan:<bits>" for the NaNs a few files hold (kept bit for bit)
const rf = (b, o) => { const v = b.readFloatLE(o); return Number.isNaN(v) ? "nan:" + b.readUInt32LE(o).toString(16) : v; };
const wf = (b, v, o) => typeof v === "string" && v.startsWith("nan:") ? b.writeUInt32LE(parseInt(v.slice(4), 16), o) : b.writeFloatLE(+v, o);
// ---------------------------------------------------------------- the collision layer, decoded
// (from the loader 0xD9CB0, the per-section setup 0xD6F50 -> 0xD59D0 / 0xD64F0 / 0xD67C0 / 0xD6CD0 and the location
// lookup 0xD7380 / 0xD71C0; checked by rebuilding every entry byte for byte)
//   vertex      xy (8 bytes) + its plane (16 bytes: nx ny nz d; z = -(d + nx x + ny y) / nz)
//   section     0x64 bytes: +0x00 bounds xmin ymin xmax ymax, +0x10 two floats (0 at the tracks looked at),
//               +0x18 start plane, +0x28 end plane (nx ny nz d, vertical; a point is in the section when it is on
//               the positive side of both), +0x38 u16 counts: surface, "B" (unused), apron triangles, walls of
//               kinds 4 / 6 / 5 (+0x3E / +0x40 / +0x42); +0x44.. runtime pointers (lists, prev / next: a ring)
//   triangle    40 bytes: u16 a b c (vertices), u16 0, +0x08 direction along the track (3f), +0x14 plane (4f),
//               +0x24 u8 surface type (0 racing surface, 6 apron, 7 grass, 1 pit road / concrete, 3 pit stalls),
//               +0x25.. runtime (flags, adjacency id); "surface" triangles are the racing area, "apron" the rest
//   wall        0x2C bytes: u16 top point a, b, u16 bottom point a, b (wall point table: 12 bytes x y z), +0x08 plane
//               (4f), +0x18 top z, +0x1C u32 kind (8 outer wall, 12 inner / pit wall), +0x20 / +0x22 i16 previous wall
//               (index in its section's list of the same kind, section; -1 none), +0x24 / +0x26 next wall, +0x28 u16 index in the section's list, +0x2A u16 section; a wall
//               crossing several sections is listed in each. Lists in the file: every section's kind-6 walls, then
//               every section's kind-5 walls, then kind-4.
//   The neighbours of each triangle, its "lower than the apron" / "not flat" flags and the walls near it are
//   worked out by the game at load (0x2DD4B0: 10 bytes per triangle), so they are not stored.
const WALL_KINDS = [["inner", 0x40], ["outer", 0x42], ["other", 0x3e]];      // (file order of the lists)
export function parseCollision(b) {
  const L = physLayout(b), f = o => rf(b, o), u16 = o => b.readUInt16LE(o), u32 = o => b.readUInt32LE(o), f4 = o => [f(o), f(o + 4), f(o + 8), f(o + 12)];
  const vertices = []; for (let i = 0; i < L.vertXY.count; i++) vertices.push({ x: f(L.vertXY.off + i * 8), y: f(L.vertXY.off + i * 8 + 4), plane: f4(L.vertPlane.off + i * 16) });
  const points = []; for (let i = 0; i < L.points12.count; i++) points.push([f(L.points12.off + i * 12), f(L.points12.off + i * 12 + 4), f(L.points12.off + i * 12 + 8)]);
  const tri = o => ({ v: [u16(o), u16(o + 2), u16(o + 4)], pad: u16(o + 6), dir: [f(o + 8), f(o + 12), f(o + 16)], plane: f4(o + 0x14), type: b[o + 0x24], rt: b.readUIntLE(o + 0x25, 3) });
  const wall = o => ({ top: [u16(o), u16(o + 2)], bottom: [u16(o + 4), u16(o + 6)], plane: f4(o + 8), topZ: f(o + 0x18), kind: u32(o + 0x1c), z20: u32(o + 0x20), a: u16(o + 0x24), c: u16(o + 0x26), idx: u16(o + 0x28), sec: u16(o + 0x2a) });
  const sections = [], cur = { surface: L.surface.off, B: L.secB.off, apron: L.apron.off }; const S = L.sections.off;
  let wo = L.edges.off; const wallAt = {}; for (const [k, fo] of WALL_KINDS) { wallAt[k] = wo; for (let i = 0; i < L.sections.count; i++) wo += u16(S + i * 0x64 + fo) * 0x2c; }
  for (let i = 0; i < L.sections.count; i++) {
    const o = S + i * 0x64, sec = { bounds: f4(o), extra: [f(o + 0x10), f(o + 0x14)], start: f4(o + 0x18), end: f4(o + 0x28), surface: [], B: [], apron: [], walls: {}, raw: b.subarray(o + 0x44, o + 0x64).toString("hex") };
    for (const [k, fo] of [["surface", 0x38], ["B", 0x3a], ["apron", 0x3c]]) for (let t = 0; t < u16(o + fo); t++, cur[k] += 40) sec[k].push(tri(cur[k]));
    for (const [k, fo] of WALL_KINDS) { sec.walls[k] = []; for (let t = 0; t < u16(o + fo); t++, wallAt[k] += 0x2c) sec.walls[k].push(wall(wallAt[k])); }
    sections.push(sec);
  }
  return { vertices, points, sections };
}
// The collision layer back to its byte ranges (physParts names): sections, surface, secB, apron, edges, vertXY,
// vertPlane, points12; header counts at +0x34 (sections), +0x44 (vertices), +0x46 (wall points).
export function collisionParts(C) {
  const n = C.sections.length, sec = Buffer.alloc(n * 0x64), lists = { surface: [], B: [], apron: [] }, walls = { inner: [], outer: [], other: [] };
  const w4 = (buf, o, a) => a.forEach((v, k) => wf(buf, v, o + k * 4));
  C.sections.forEach((s, i) => { const o = i * 0x64; w4(sec, o, s.bounds); w4(sec, o + 0x10, s.extra ?? [0, 0]); w4(sec, o + 0x18, s.start); w4(sec, o + 0x28, s.end);
    sec.writeUInt16LE(s.surface.length, o + 0x38); sec.writeUInt16LE(s.B?.length ?? 0, o + 0x3a); sec.writeUInt16LE(s.apron.length, o + 0x3c);
    sec.writeUInt16LE(s.walls?.other?.length ?? 0, o + 0x3e); sec.writeUInt16LE(s.walls?.inner?.length ?? 0, o + 0x40); sec.writeUInt16LE(s.walls?.outer?.length ?? 0, o + 0x42);
    if (s.raw) Buffer.from(s.raw, "hex").copy(sec, o + 0x44);
    for (const k of Object.keys(lists)) lists[k].push(...(s[k] ?? []));
    for (const k of Object.keys(walls)) (s.walls?.[k] ?? []).forEach((w, j) => walls[k].push({ ...w, idx: j, sec: i })); });
  const triBuf = list => { const b = Buffer.alloc(list.length * 40); list.forEach((t, i) => { const o = i * 40; t.v.forEach((v, k) => b.writeUInt16LE(v, o + k * 2)); b.writeUInt16LE(t.pad ?? 0, o + 6); w4(b, o + 8, t.dir); w4(b, o + 0x14, t.plane); b[o + 0x24] = t.type ?? 0; b.writeUIntLE(t.rt ?? 0, o + 0x25, 3); }); return b; };
  const all = [...walls.inner, ...walls.outer, ...walls.other], wb = Buffer.alloc(all.length * 0x2c);
  all.forEach((w, i) => { const o = i * 0x2c; wb.writeUInt16LE(w.top[0], o); wb.writeUInt16LE(w.top[1], o + 2); wb.writeUInt16LE(w.bottom[0], o + 4); wb.writeUInt16LE(w.bottom[1], o + 6); w4(wb, o + 8, w.plane);
    wf(wb, w.topZ, o + 0x18); wb.writeUInt32LE(w.kind, o + 0x1c); wb.writeUInt32LE(w.z20 ?? 0, o + 0x20); wb.writeUInt16LE(w.a ?? 0, o + 0x24); wb.writeUInt16LE(w.c ?? 0, o + 0x26); wb.writeUInt16LE(w.idx, o + 0x28); wb.writeUInt16LE(w.sec, o + 0x2a); });
  const xy = Buffer.alloc(C.vertices.length * 8), vp = Buffer.alloc(C.vertices.length * 16); C.vertices.forEach((v, i) => { wf(xy, v.x, i * 8); wf(xy, v.y, i * 8 + 4); w4(vp, i * 16, v.plane); });
  const pts = Buffer.alloc(C.points.length * 12); C.points.forEach((p, i) => w4(pts, i * 12, p));
  return { sections: sec, surface: triBuf(lists.surface), secB: triBuf(lists.B), apron: triBuf(lists.apron), edges: wb, vertXY: xy, vertPlane: vp, points12: pts };
}
// a TK_PHYS entry with its collision layer replaced (everything else kept)
export function withCollision(b, C) {
  const parts = physParts(b), rep = collisionParts(C);
  for (const p of parts) if (rep[p.name]) p.bytes = rep[p.name];
  const h = parts[0].bytes; h.writeUInt32LE(C.sections.length, 0x34); h.writeUInt16LE(C.vertices.length, 0x44); h.writeUInt16LE(C.points.length, 0x46);
  return writePhys(parts);
}

// The collision layer as a glTF in the render model's frame (metres, y up: render = (x, z, -y) x 30.48 cm), for
// lining a model up in Blender: racing surface, apron, grass, pit road and stalls as separate coloured meshes, walls
// as quads. Not used by the build.
export function exportCollisionGLTF(b, file) {
  const C = parseCollision(b), M = 0.3048, P = (x, y, z) => [x * M, z * M, -y * M];
  const zAt = (pl, x, y) => -(pl[3] + pl[0] * x + pl[1] * y) / pl[2];
  const TYPES = { 0: ["racing surface", [0.25, 0.25, 0.25, 0.8]], 6: ["apron", [0.45, 0.45, 0.8, 0.8]], 7: ["grass", [0.25, 0.6, 0.25, 0.8]], 1: ["pit road", [0.8, 0.7, 0.35, 0.8]], 3: ["pit stalls", [0.8, 0.35, 0.35, 0.8]] };
  const groups = new Map(), add = (name, color, tris) => { if (!groups.has(name)) groups.set(name, { color, pos: [] }); groups.get(name).pos.push(...tris); };
  for (const s of C.sections) for (const t of [...s.surface, ...s.B, ...s.apron]) { if (t.plane.some(x => typeof x !== "number")) continue; const [nm, col] = TYPES[t.type] ?? [`type ${t.type}`, [0.8, 0.2, 0.8, 0.8]];
    add(nm, col, t.v.flatMap(i => { const v = C.vertices[i]; return P(v.x, v.y, zAt(t.plane, v.x, v.y) + 0.05); })); }
  const seen = new Set();
  for (const s of C.sections) for (const [k, list] of Object.entries(s.walls)) for (const w of list) { const key = `${w.top}|${w.bottom}`; if (seen.has(key)) continue; seen.add(key);
    const [a, bb, c, d] = [w.top[0], w.top[1], w.bottom[0], w.bottom[1]].map(i => P(...C.points[i]));
    add(w.kind === 8 ? "outer wall" : w.kind === 12 ? "inner wall" : `wall ${w.kind}`, w.kind === 8 ? [0.9, 0.15, 0.15, 0.7] : [1, 0.55, 0.1, 0.7], [...a, ...bb, ...c, ...bb, ...d, ...c]); }
  const bins = [], views = [], accessors = [], meshes = [], materials = [], nodes = []; let off = 0;
  for (const [name, g] of groups) {
    const buf = Buffer.from(new Float32Array(g.pos).buffer); views.push({ buffer: 0, byteOffset: off, byteLength: buf.length, target: 34962 }); bins.push(buf); off += buf.length;
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < g.pos.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], g.pos[i + k]); mx[k] = Math.max(mx[k], g.pos[i + k]); }
    accessors.push({ bufferView: views.length - 1, componentType: 5126, count: g.pos.length / 3, type: "VEC3", min: mn, max: mx });
    materials.push({ name, pbrMetallicRoughness: { baseColorFactor: g.color, metallicFactor: 0, roughnessFactor: 1 }, alphaMode: "BLEND", doubleSided: true });
    meshes.push({ name, primitives: [{ attributes: { POSITION: accessors.length - 1 }, material: materials.length - 1 }] }); nodes.push({ name: `physics: ${name}`, mesh: meshes.length - 1 });
  }
  const bin = Buffer.concat(bins);
  writeFileSync(file, JSON.stringify({ asset: { version: "2.0", generator: "nt04 tkphys.mjs" }, scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }], nodes, meshes, materials, accessors, bufferViews: views,
    buffers: [{ byteLength: bin.length, uri: "data:application/octet-stream;base64," + bin.toString("base64") }] }));
  return { groups: [...groups.keys()], sections: C.sections.length };
}

// ---------------------------------------------------------------- lines, decoded (AI / pit paths; accessors 0xD7830..0xD8D10)
//   line record 0x90: u16 segments, u16 points (2 x segments + 1), 11 u32 node counts (one per node list), the rest
//               runtime pointers. Points: quadratic Bezier control points (start, middle, end per segment; feet).
//   per segment: length (arc length), cumulative length at its end, a cubic t -> distance (a t^3 + b t^2 + c t,
//               a least-squares fit, value at 1 = length: 0xD79D0), 64 bytes (4 x 4 floats; used by the camera code
//               0x35690 and the car tracking 0x1D460: not decoded); per segment + 1: the lap fraction measured on
//               the racing line at the segment start (equal first and last: a closed line, 0xD7920).
//   profile:    7 arrays of s16 inches, 7 samples per segment + 1 (0xD7E50 interpolates them, x 1/12 -> feet): the
//               lateral distances from the line, 0 = the line's own offset, 1 / 2 inside / outside edge of the racing
//               surface, 3 / 4 edge of the paved area, 5 / 6 walls (inside negative).
//   node lists (11 per line): 0x1C records {x, y, z, position along the line (segment index + t), s32 value, 2
//               runtime pointers}, ordered: a value holds from its position on (0xD7CA0 / 0xD7D00 / 0xD7D60). Seen:
//               list 0 speed (mph: pit entry 150 -> 120 -> 60), 2 and 4 corner / zone numbers, 5 and 6 corner kinds
//               for the AI (0xC9190), 8 / 9 TV camera numbers, 10 (lane lines) 1..3.
export function parseLines(b) {
  const L = physLayout(b), f = o => rf(b, o), u16 = o => b.readUInt16LE(o), u32 = o => b.readUInt32LE(o);
  const N = L.lineRecs.count; let A = 0; for (let i = 0; i < N; i++) A += u16(L.lineRecs.off + i * 0x90);
  const B = (7 * A + N) * 2, lines = []; let a = 0, e = 0, c = 0, li = 0;
  L.groups.forEach((g, gi) => { for (let j = 0; j < g.count; j++, li++) {
    const r = L.lineRecs.off + li * 0x90, n = u16(r), np = u16(r + 2), counts = [...Array(11)].map((_, k) => u32(r + 4 + k * 4));
    const line = { group: gi, points: [], segments: [], fracEnd: f(L.p134 + (a + li + n) * 4), profile: [], nodes: [], rest: b.subarray(r + 0x30, r + 0x90).toString("hex"), pointCount: np };
    for (let k = 0; k < np; k++) { const o = L.linePoints.off + (e + k) * 12; line.points.push([f(o), f(o + 4), f(o + 8)]); }
    for (let s = 0; s < n; s++) { const k = a + s; line.segments.push({ length: f(L.p128 + k * 4), end: f(L.p12c + k * 4), poly: [f(L.p130 + k * 12), f(L.p130 + k * 12 + 4), f(L.p130 + k * 12 + 8)], frac: f(L.p134 + (k + li) * 4),
      data: [...Array(16)].map((_, q) => f(L.segData.off + k * 64 + q * 4)) }); }
    for (let p = 0; p < 7; p++) { const arr = []; for (let k = 0; k <= 7 * n; k++) arr.push(b.readInt16LE(L.p138 + p * B + (7 * a + li + k) * 2)); line.profile.push(arr); }
    for (let k = 0; k < 11; k++) { const list = []; for (let q = 0; q < counts[k]; q++, c++) { const o = L.nodes.off + c * 0x1c; list.push({ pos: [f(o), f(o + 4), f(o + 8)], at: f(o + 12), value: b.readInt32LE(o + 16), rt: b.subarray(o + 20, o + 28).toString("hex") }); } line.nodes.push(list); }
    a += n; e += np; lines.push(line); } });
  return { lines, pad: b.subarray(L.p138 + 7 * B, L.nodes.off).toString("hex") };
}
// lines back to bytes: lineRecs, lineArrays (p128 .. the 7 profile arrays, 4-byte padded), nodes, linePoints, segData;
// header group counts at +0x48 (19 u32)
export function linesParts(P) {
  const lines = P.lines, N = lines.length, A = lines.reduce((s, l) => s + l.segments.length, 0), B = (7 * A + N) * 2;
  const rec = Buffer.alloc(N * 0x90), p128 = Buffer.alloc(4 * A), p12c = Buffer.alloc(4 * A), p130 = Buffer.alloc(12 * A), p134 = Buffer.alloc(4 * (A + N)), prof = Buffer.alloc(7 * B);
  const nodes = [], pts = [], seg = Buffer.alloc(64 * A); let a = 0;
  lines.forEach((l, li) => { const r = li * 0x90, n = l.segments.length; rec.writeUInt16LE(n, r); rec.writeUInt16LE(l.pointCount ?? l.points.length, r + 2); l.nodes.forEach((list, k) => rec.writeUInt32LE(list.length, r + 4 + k * 4)); if (l.rest) Buffer.from(l.rest, "hex").copy(rec, r + 0x30);
    l.segments.forEach((s, j) => { const k = a + j; wf(p128, s.length, k * 4); wf(p12c, s.end, k * 4); s.poly.forEach((v, q) => wf(p130, v, k * 12 + q * 4)); wf(p134, s.frac, (k + li) * 4); s.data.forEach((v, q) => wf(seg, v, k * 64 + q * 4)); });
    wf(p134, l.fracEnd, (a + li + n) * 4);
    l.profile.forEach((arr, p) => arr.forEach((v, k) => prof.writeInt16LE(v, p * B + (7 * a + li + k) * 2)));
    for (const list of l.nodes) for (const nd of list) { const o = Buffer.alloc(0x1c); nd.pos.forEach((v, q) => wf(o, v, q * 4)); wf(o, nd.at, 12); o.writeInt32LE(nd.value, 16); if (nd.rt) Buffer.from(nd.rt, "hex").copy(o, 20); nodes.push(o); }
    for (const p of l.points) { const o = Buffer.alloc(12); p.forEach((v, q) => wf(o, v, q * 4)); pts.push(o); }
    a += n; });
  let arrays = Buffer.concat([p128, p12c, p130, p134, prof]); const padTo = Math.ceil(arrays.length / 4) * 4; arrays = Buffer.concat([arrays, P.pad && Buffer.from(P.pad, "hex").length === padTo - arrays.length ? Buffer.from(P.pad, "hex") : Buffer.alloc(padTo - arrays.length)]);
  return { lineRecs: rec, lineArrays: arrays, nodes: Buffer.concat(nodes), linePoints: Buffer.concat(pts), segData: seg };
}
// spot tables (12; 0x3C bytes: position, 3 x 3 orientation (forward, right, up), section index, two u32 (a line /
// segment reference?)): 0 starting grid (44, two wide), 1-5 other formations (44 / 44 / 129 / 43 / 43), 6-11 single
// spots; and the small tables kept as they are for now (0x20 records: TV camera positions, 0x78 / 0x68 records,
// k12: light positions (night glows), crowd quads, tail)
export function parseSpots(b) {
  const L = physLayout(b), f = o => rf(b, o);
  return L.spotTables.map(t => [...Array(t.count)].map((_, i) => { const o = t.off + i * 0x3c; return { pos: [f(o), f(o + 4), f(o + 8)], axes: [...Array(9)].map((_, k) => f(o + 12 + k * 4)), section: b.readUInt32LE(o + 0x30), a: b.readUInt32LE(o + 0x34), b: b.readUInt32LE(o + 0x38) }; }));
}
export function spotsParts(tables) {
  const out = {}; tables.forEach((t, k) => { const buf = Buffer.alloc(t.length * 0x3c); t.forEach((s, i) => { const o = i * 0x3c; s.pos.forEach((v, q) => wf(buf, v, o + q * 4)); s.axes.forEach((v, q) => wf(buf, v, o + 12 + q * 4)); buf.writeUInt32LE(s.section, o + 0x30); buf.writeUInt32LE(s.a, o + 0x34); buf.writeUInt32LE(s.b, o + 0x38); }); out["spots" + k] = buf; });
  return out;
}
// The whole entry as a JSON-able document (collision, lines, spots decoded; the rest as hex) and back.
export function physDocument(b) {
  const parts = physParts(b), raw = {}; for (const p of parts) if (["header", "t20", "r78", "r68", "k12", "quads", "tail"].includes(p.name)) raw[p.name] = p.bytes.toString("hex");
  return { format: "nt04-phys 1", collision: parseCollision(b), lines: parseLines(b), spots: parseSpots(b), raw, tailBase: parts.tailBase, tailStruct: parts.tailStruct };
}
// JSON text keeps negative zero (stored floats have it) as "-0"
export const physToJSON = D => JSON.stringify(D, (k, v) => Object.is(v, -0) ? "-0" : v);
export const physFromJSON = s => JSON.parse(s, (k, v) => v === "-0" ? -0 : v);
export function physFromDocument(D) {
  const rep = { ...collisionParts(D.collision), ...linesParts(D.lines), ...spotsParts(D.spots) };
  const order = ["header", ...D.spots.map((_, k) => "spots" + k), "t20", "sections", "surface", "secB", "apron", "lineRecs", "lineArrays", "nodes", "edges", "linePoints", "segData", "vertXY", "vertPlane", "points12", "r78", "r68", "k12", "quads", "tail"];
  const parts = order.map(name => ({ name, bytes: rep[name] ?? Buffer.from(D.raw[name] ?? "", "hex") })); parts.tailBase = D.tailBase; parts.tailStruct = D.tailStruct;
  const h = parts[0].bytes = Buffer.from(parts[0].bytes); D.spots.forEach((t, k) => h.writeUInt32LE(t.length, k * 4)); h.writeUInt32LE(D.collision.sections.length, 0x34);
  h.writeUInt16LE(D.collision.vertices.length, 0x44); h.writeUInt16LE(D.collision.points.length, 0x46);
  const byG = Array(19).fill(0); for (const l of D.lines.lines) byG[l.group]++; byG.forEach((n, k) => h.writeUInt32LE(n, 0x48 + k * 4));
  return writePhys(parts);                       // (moves the tail's stored pointers with it)
}

const LINE_NAMES = { 0: "racing line", 1: "lanes", 2: "inside line", 3: "pit entry", 4: "pit entry", 5: "pit entry", 6: "pit exit", 7: "pit exit", 8: "pit exit", 9: "pit stall paths", 10: "pit stall paths", 11: "pit road lanes", 15: "infield loop", 16: "outer circles" };

export function exportPhys(P, outDir, name = "track") {
  mkdirSync(outDir, { recursive: true });
  let s = `# ${name}: collision mesh from TK_PHYS (feet; exported y up)\n`;
  for (const v of P.verts) s += `v ${v[0].toFixed(3)} ${v[2].toFixed(3)} ${(-v[1]).toFixed(3)}\n`;
  s += "g surface\n"; for (const t of P.surface) s += `f ${t.v[0] + 1} ${t.v[1] + 1} ${t.v[2] + 1}\n`;
  s += "g apron\n"; for (const t of P.apron) s += `f ${t.v[0] + 1} ${t.v[1] + 1} ${t.v[2] + 1}\n`;
  writeFileSync(join(outDir, `${name}_collision.obj`), s);
  writeFileSync(join(outDir, `${name}_phys.json`), JSON.stringify({ sections: P.sections.map(x => ({ index: x.index, bounds: x.bounds })), spots: P.spots, lines: P.lines.map(l => ({ ...l, name: LINE_NAMES[l.group] ?? `group ${l.group}` })) }));
  // SVG overview
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity; for (const v of P.verts) { xmin = Math.min(xmin, v[0]); xmax = Math.max(xmax, v[0]); ymin = Math.min(ymin, v[1]); ymax = Math.max(ymax, v[1]); }
  const W = 1600, sc = W / (xmax - xmin + 200), H = Math.ceil((ymax - ymin + 200) * sc), X = x => ((x - xmin + 100) * sc).toFixed(1), Y = y => ((ymax - y + 100) * sc).toFixed(1);
  const poly = (t, fill) => `<polygon points="${t.v.map(i => X(P.verts[i][0]) + "," + Y(P.verts[i][1])).join(" ")}" fill="${fill}" stroke="${fill}" stroke-width="0.4"/>`;
  const colors = ["#e41a1c", "#377eb8", "#4daf4a", "#984ea3", "#ff7f00", "#a65628", "#f781bf", "#999", "#66c2a5", "#fc8d62", "#8da0cb", "#e78ac3", "#a6d854", "#ffd92f", "#555", "#1b9e77", "#d95f02", "#7570b3", "#e7298a"];
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="background:#fff">`;
  for (const t of P.apron) svg += poly(t, "#f3e3e3"); for (const t of P.surface) svg += poly(t, "#cfcfcf");
  for (const l of P.lines) { if (l.points.length < 2 || l.group === 16 || l.group === 14) continue; svg += `<polyline fill="none" stroke="${colors[l.group % colors.length]}" stroke-width="1.2" points="${l.points.map(p => X(p[0]) + "," + Y(p[1])).join(" ")}"/>`; }
  P.spots.forEach((t, k) => { for (const sp of t.spots) svg += `<circle cx="${X(sp.pos[0])}" cy="${Y(sp.pos[1])}" r="2" fill="${colors[(k + 5) % colors.length]}"/>`; });
  svg += `<text x="10" y="20" font-family="sans-serif" font-size="14">${name}: ${P.surface.length} surface + ${P.apron.length} apron triangles, ${P.sections.length} sections, ${P.lines.length} lines</text></svg>`;
  writeFileSync(join(outDir, `${name}_overview.svg`), svg);
}

function load(file, entry) { const b = readFileSync(file); return isTerf(b) ? parseTerf(b).entry(+(entry ?? 0)) : b; }
if (process.argv[1] && basename(process.argv[1]) === "tkphys.mjs") {
  const [cmd, file, ...rest] = process.argv.slice(2);
  if (!cmd || !file) { console.log("usage: node tkphys.mjs info|export <TK_PHYS.DAT|file> [entry] [outDir]"); process.exit(1); }
  const entry = /^\d+$/.test(rest[0] ?? "") ? rest.shift() : undefined, P = ["info", "export"].includes(cmd) ? parsePhys(load(file, entry)) : null;
  if (cmd === "info") {
    const L = P.layout; console.log(`vertices ${P.verts.length}, surface ${P.surface.length}, apron ${P.apron.length}, sections ${P.sections.length}, lines ${P.lines.length}, spots ${P.spots.map(t => t.spots.length).join(" ")}, tail ${L.tail.size} bytes`);
    const byG = new Map(); for (const l of P.lines) byG.set(l.group, (byG.get(l.group) ?? 0) + 1); console.log("line groups:", [...byG].map(([g, n]) => `${g}${LINE_NAMES[g] ? " " + LINE_NAMES[g] : ""}: ${n}`).join(", "));
  } else if (cmd === "roundtrip") { const b = load(file, entry), w = writePhys(physParts(b)); writeFileSync(rest[0] ?? "phys_rt.bin", w); console.log(`rebuilt ${w.length} bytes, ${w.equals(b) ? "identical to" : "DIFFERENT from"} the original`);
  } else if (cmd === "doc") { const b = load(file, entry), out = rest[0] ?? "phys.json", j = physToJSON(physDocument(b)); writeFileSync(out, j); const w = physFromDocument(physFromJSON(j)); console.log(`wrote ${out} (${(j.length / 1e6).toFixed(1)} MB); rebuilt from it: ${w.equals(b) ? "identical" : "DIFFERENT"}`);
  } else if (cmd === "fromdoc") { const w = physFromDocument(physFromJSON(readFileSync(file, "utf8"))); writeFileSync(rest[0] ?? "phys.bin", w); console.log(`wrote ${rest[0] ?? "phys.bin"}: ${w.length} bytes`);
  } else if (cmd === "collision") { const b = load(file, entry), C = parseCollision(b), w = withCollision(b, C); console.log(`collision layer: ${C.sections.length} sections, ${C.vertices.length} vertices, ${C.points.length} wall points; rebuilt from the decoded objects: ${w.equals(b) ? "identical" : "DIFFERENT"}`);
    if (rest[0]) console.log(exportCollisionGLTF(b, rest[0]));
  } else if (cmd === "export") { const out = rest[0] ?? "phys_out", name = `phys${entry ?? ""}`; exportPhys(P, out, name); console.log(`wrote ${out}/${name}_collision.obj, _phys.json, _overview.svg`); }
}
