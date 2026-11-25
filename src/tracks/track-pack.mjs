// track-pack.mjs — track packs: a 3D model (glTF / GLB, e.g. from Blender) that replaces the render model of one or
// more of the game's track slots (TK_REND.DAT entries), built into the game's TMdl format by tmdl-build.mjs.
//
// A pack is a folder roster/tracks/<id>/ (beside the Data folder) holding:
//   track.json   { "name": "My Lowe's", "author": "...", "model": "model.glb", "enabled": true, and either
//                  "mode": "replace", "slots": [28]          replaces those TK_REND entries, or
//                  "mode": "add", "slots": [28],             a new track next to the game's: a copy of slot 28's track
//                  "base": { "slot": 28, "trid": 11, "raid": 18 },   and race (its TRCK / RACE rows and every
//                  "ids": { "trid": 65, "tphd": 48, "raid": 80, "rtid": 76 },  per-track row) with its own ids, this model as
//                  "track": { "name", "short", "city", "state", "race", "laps" }   TK_REND entry rtid, and these names
//                  "layout": "layout.json" | "model.glb"     optional: a layout of its own (trackwarp.mjs): a centreline
//                  (JSON points, or a mesh named "centerline" in a model file); the base track's physics, AI speeds
//                  and (with no model) scenery are carried along it; "layoutOptions": { bank, bankStraight,
//                  bankTurn, z }; ids.tpid: its TK_PHYS / AI_SPDS entry
//                  "physics": "x_physics.glb", "lines": "x_lines.glb"   instead of "layout": the layout read from glTF
//                  files (gltf-layout.mjs: centerline, road, walls, pit road, ground; racing line, pit lane, stalls,
//                  grid), as nr2003-gltf.mjs writes them or modelled in Blender with the same names
//   the model    .glb, or .gltf with its .bin and PNG textures
//   build/       written by the build: tk_rend_<slot>.bin + build.json (rebuilt when anything in the pack changes)
// The game then loads the built model in place of each slot's entry (config entryOverrides, see packOverrides).
//
// What a slot is: TK_REND has one model per race dressing (76: day / night, sponsor signage), the race picks it
// with RACE.RTID. Physics, AI lines, pit stalls, shadows, sky and pit banners stay the slot's own (TK_PHYS etc.),
// so for now a pack must keep the slot's racing surface where it is: re-dressed scenery, stands, signage, textures,
// a remodelled track on the same layout. (New layouts need generated TK_PHYS data: not done yet.)
//
// Model conventions (what the importer expects):
//   - glTF units (metres), y up; positioned to line up with the slot's track (export a starter pack to see where).
//   - A mesh used by several nodes (Blender: linked duplicates, Alt+D) becomes one piece the game draws at each
//     node (fence posts, light poles). Other meshes are baked into world space and cut into ~60 m tiles so the
//     game can skip what the camera cannot see.
//   - Materials: base colour texture (PNG; sizes are rounded to powers of two, at most 1024), KHR_texture_transform
//     offset / scale, vertex colours COLOR_0 (the game's baked lighting; when absent NO_LIGHT, a mid grey like the base
//     tracks' own lit surfaces: full white left the game's sun no headroom and washed out in daylight), alpha mode MASK /
//     BLEND for see-through textures (otherwise alpha is ignored).
//   - The game's layered materials (track surface detail, chain-link fences) come through as custom properties on
//     the material (glTF "extras", kept by Blender's importer / exporter when "Custom Properties" is ticked):
//       nt04: { shader: "MP_DBT", group?: 0..7, layers: [{ image: "textures/tex_003.png", offset: [u, v], scale: [u, v] }] }
//     Starter packs exported from the game's own tracks carry these.
//
// Nothing from the game is shipped in a pack: a starter pack is exported on the user's machine from their own copy.
//
// CLI:  node track-pack.mjs slots  <Data>                    list the track slots
//       node track-pack.mjs export <Data> <slot> <outDir>    starter pack from one of the game's track models
//       node track-pack.mjs build  <packDir> <Data>          build a pack
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, basename, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { readTerfEntry } from "../game/terf.mjs";
import { parseTMdl, drawTriangles, textureRGBA, nodeMatrix } from "./tmdl.mjs";
import { buildTMdl } from "./tmdl-build.mjs";
import { exportCollisionGLTF, parseLines } from "./tkphys.mjs";
import { readGLTF, mat4 } from "./gltf-read.mjs";
import { encodePNG } from "../game/mmap-tex.mjs";
import { resize } from "../game/paint-mmap.mjs";
import { openDatabases } from "../game/nascar-db.mjs";
import { parseAISpeeds } from "./aispeeds.mjs";
import { buildTrackMap } from "./trackmap.mjs";

const BUILDER = "track-pack 8";

// The stock home track (TRCK.TPHD: setups DCST, AI tables AIBL / ER**, pit timing PTSF, pole times QGEN ...) an added
// track takes those from: the listed track whose AI lanes top out nearest the new track's, and close in length (the same
// kind of track: gearing, springs, spoiler; Wilkesboro gets a short track's instead of Lowe's 1.5-mile setup geared
// for 198 mph). track.json "home": a TPHD of your choice; "setup": DCST fields to override (GRAT gear set 0-9 = PGER
// rows, SPOI, WEDG, TIPR, CSFF / CSRS springs ...).
export function similarHomeTrack(data, aiBuf, { miles = null, baseTrid = null } = {}, fixed = null, log = () => {}) {
  try {
    const top = buf => Math.max(...(parseAISpeeds(buf)[1] ?? []).flatMap(l => l.bytes ?? [0]));
    const newTop = top(aiBuf), db = openDatabases(["NASCAR.DB", "GMODEDB.DAT"].map(f => join(data, f)).filter(existsSync)), T = db.tables.get("TRCK").rows, D = db.tables.get("DCST").rows, seen = new Set(), cand = [];
    // (the same kind of track as the base: a road course (its lap clockwise: Watkins Glen, Sears Point) gets a road
    // course's setups and AI tables, not Talladega's for its top speed)
    const cwOf = tpid => { try { const g0 = parseLines(readTerfEntry(nodeFs, join(data, "TK_PHYS.DAT"), tpid)).lines.find(l => l.group === 0); let a = 0; for (let i = 0; i + 1 < g0.points.length; i++) a += g0.points[i][0] * g0.points[i + 1][1] - g0.points[i + 1][0] * g0.points[i][1]; return a < 0; } catch { return null; } };
    const bt = baseTrid != null ? T.find(r => r.TRID === baseTrid) : null, baseCW = bt ? cwOf(bt.TPID) : null, sameKind = r => baseCW === null || cwOf(r.TPID) === baseCW;
    for (const r of T) { if (r.TIPP !== 1 || r.FRSZ || seen.has(r.TPHD) || !D.some(d => d.TPHD === r.TPHD) || !sameKind(r)) continue; seen.add(r.TPHD);
      try { cand.push({ tphd: r.TPHD, name: String(r.TRNM).replace(/[^\x20-\x7e]/g, "").trim(), miles: r.TLEN, top: top(readTerfEntry(nodeFs, join(data, "AI_SPDS.DAT"), r.TPID)) }); } catch {} }
    let pick = fixed !== null && fixed !== undefined ? cand.find(c => c.tphd === fixed) : null;
    if (!pick) pick = cand.reduce((a, c) => { const sc = Math.abs(c.top - newTop) + 20 * Math.abs(Math.log((c.miles || 1) / (miles || c.miles || 1))); return !a || sc < a.sc ? { ...c, sc } : a; }, null);
    if (pick) log(`home track (setups, AI tables, pole times): ${pick.name} (its AI tops out at ${pick.top} mph, this track's ${newTop})${fixed != null ? " (track.json)" : ""}`);
    return pick ? { tphd: pick.tphd, name: pick.name, top: pick.top, newTop } : null;
  } catch (e) { log(`home track: ${e.message}`); return null; }
}

// Pit road check: the warped pit lines (groups 3-11: in / out lines, stall paths, pit lanes) against the walls' top
// edges (stock Lowe's: none crosses). Before the pit wall fix Milwaukee's three pit lanes crossed the inside wall at the
// pit exit and a car on pit road stopped against it.
export function pitLinesThroughWalls(doc) {
  const C = doc.collision, P = C.points ?? C.vertices, xy = p => [p.x ?? p[0], p.y ?? p[1]], walls = [];
  for (const s of C.sections) for (const side of Object.keys(s.walls ?? {})) for (const w of s.walls[side]) { const a = P[w.top[0]], b = P[w.top[1]]; if (a && b) walls.push([xy(a), xy(b)]); }
  const d = (u, v, w) => (v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]), cross = (p, q, a, b) => d(p, q, a) * d(p, q, b) < 0 && d(a, b, p) * d(a, b, q) < 0;
  const count = {};
  for (const l of doc.lines.lines) { if (l.group < 3 || l.group > 11) continue; let hit = false;
    for (let i = 0; i < l.segments.length && !hit; i++) { const [a, c, b] = [l.points[2 * i], l.points[2 * i + 1], l.points[2 * i + 2]], pts = [];
      for (let q = 0; q <= 8; q++) { const t = q / 8; pts.push([0, 1].map(j => (1 - t) ** 2 * a[j] + 2 * (1 - t) * t * c[j] + t * t * b[j])); }
      for (let k = 0; k + 1 < pts.length && !hit; k++) for (const w of walls) if (cross(pts[k], pts[k + 1], w[0], w[1])) { hit = true; break; } }
    if (hit) count[l.group] = (count[l.group] ?? 0) + 1; }
  return Object.entries(count).map(([g, n]) => `${n} line${n > 1 ? "s" : ""} of group ${g}`);
}

// The HUD track map of an added track with a layout (trackmap.mjs): drawn from the layout into copies of the base
// track's map textures (TRCK.IDTM of the base row: same sizes and palette format), written as build/tmap_*.
// Its TMAPDAT entries: 141 (past the game's 141) + 4 per added track id (TRID from 65).
export const mapIndex = ids => Number.isInteger(ids?.trid) && ids.trid >= 65 ? 141 + 4 * (ids.trid - 65) : null;
function writeTrackMap(dir, data, layout, meta, log) {
  const db = openDatabases(["NASCAR.DB", "GMODEDB.DAT"].map(f => join(data, f)).filter(existsSync)), row = db.tables.get("TRCK").rows.find(r => r.TRID === meta.base?.trid);
  const idtm = row?.IDTM ?? 41, f = join(data, "TMAPDAT.DAT"), M = buildTrackMap(layout, { small: readTerfEntry(nodeFs, f, idtm), large: readTerfEntry(nodeFs, f, idtm + 2) });
  writeFileSync(join(dir, "build", "tmap_small.bin"), M.small); writeFileSync(join(dir, "build", "tmap_small.pos"), M.smallPos);
  writeFileSync(join(dir, "build", "tmap_large.bin"), M.large); writeFileSync(join(dir, "build", "tmap_large.pos"), M.largePos);
  writeFileSync(join(dir, "build", "track-map.png"), encodePNG(256, 256, M.images.large)); log(`track map: drawn from the layout (track-map.png)`);
  return true;
}

export const rendEntry = (data, slot) => readTerfEntry(nodeFs, join(data, "TK_REND.DAT"), slot);
const infoName = e => { for (let k = 0; k < 32; k++) { const o = 0x10 + k * 16; if (e.toString("latin1", o, o + 4) === "Info") { const p = e.readUInt32LE(o + 4); return e.toString("latin1", p, p + 16).replace(/\0.*/s, ""); } } return ""; };

// ---------------------------------------------------------------- slots
// [{ slot, model (Info name), races: [race name], track }], cached in roster/tracks/slots.json
export function trackSlots(data, cacheDir) {
  const cache = cacheDir && join(cacheDir, "slots.json");
  if (cache && existsSync(cache)) try { const c = JSON.parse(readFileSync(cache, "utf8")); if (c.version === 1) return c.slots; } catch {}
  const slots = [];
  for (let i = 0; ; i++) { let e; try { e = rendEntry(data, i); } catch { e = null; } if (!e) break; slots.push({ slot: i, model: infoName(e).replace(/\.(e(a3?)?)?$/i, ""), races: [], track: "" }); }
  try { const db = openDatabases(["NASCAR.DB", "GMODEDB.DAT"].map(f => join(data, f)).filter(existsSync)); const T = db.tables.get("TRCK"), R = db.tables.get("RACE");
    const trk = new Map(T.rows.map(r => [r.TRID, String(r.TSNM ?? r.TRNM ?? "").replace(/[^\x20-\x7e]/g, "").trim()]));
    for (const r of R.rows) { const s = slots[r.RTID]; if (!s) continue; s.races.push(String(r.RNAM).replace(/[^\x20-\x7e]/g, "").trim()); s.track ||= trk.get(r.TRID) ?? ""; } } catch {}
  if (cache) { mkdirSync(cacheDir, { recursive: true }); writeFileSync(cache, JSON.stringify({ version: 1, slots })); }
  return slots;
}

// ---------------------------------------------------------------- starter pack (export)
// One mesh per piece, one node per placement (repeated objects share their mesh), every material layer as a PNG
// with the nt04 extras; root node scales the game's centimetres to metres.
export function exportStarter(data, slot, outDir, { name } = {}) {
  const a = rendEntry(data, slot); if (!a) throw new Error(`no track slot ${slot}`);
  const m = parseTMdl(a), f = o => a.readFloatLE(o);
  mkdirSync(join(outDir, "textures"), { recursive: true });
  const bins = [], views = [], accessors = []; let off = 0;
  const push = (arr, type, comp, target, minmax) => { const buf = comp === 5126 ? Buffer.from(new Float32Array(arr).buffer) : Buffer.from(new Uint32Array(arr).buffer);
    views.push({ buffer: 0, byteOffset: off, byteLength: buf.length, target }); bins.push(buf); off += buf.length; const pad = (4 - off % 4) % 4; if (pad) { bins.push(Buffer.alloc(pad)); off += pad; }
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type], acc = { bufferView: views.length - 1, componentType: comp, count: arr.length / n, type };
    if (minmax) { const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < arr.length; i += 3) for (let c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], arr[i + c]); mx[c] = Math.max(mx[c], arr[i + c]); } acc.min = mn; acc.max = mx; }
    accessors.push(acc); return accessors.length - 1; };
  const images = [], textures = [], texOf = new Map();
  const tex = ti => { if (texOf.has(ti)) return texOf.get(ti); const t = m.textures[ti]; let r = null;
    try { const img = textureRGBA(m, t); if (img) { const file = `textures/tex_${String(ti).padStart(3, "0")}.png`; writeFileSync(join(outDir, file), encodePNG(img.width, img.height, img.rgba)); images.push({ uri: file, name: t.name }); textures.push({ source: images.length - 1, sampler: 0 }); r = { file, tex: textures.length - 1, t }; } } catch {}
    texOf.set(ti, r); return r; };
  const materials = m.materials.map(mt => {
    const layers = mt.textures.map((ti, j) => ti >= 0 ? { ti, n: mt.textureNames[j] } : null).filter(Boolean);
    const main = layers.find(x => /color|colour/i.test(x.n)) ?? layers.find(x => !/grime|crack|dynstretch|detail/i.test(x.n)) ?? layers[0];
    const L = layers.map(x => ({ x, r: tex(x.ti) })).filter(y => y.r);
    const mat = { name: mt.name.replace(/^\d+/, ""), pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.9 }, doubleSided: true,
      extras: { nt04: { shader: mt.shader, layers: L.map(({ r }) => ({ image: r.file, offset: r.t.uvOffset ?? [0, 0], scale: r.t.uvScale ?? [1, 1] })) } } };
    const mr = main && tex(main.ti);
    // see-through: the main layer's alpha (crowds, signs, glows, shadow decals); plain glTF readers then keep it
    if (mr) { const img = textureRGBA(m, mr.t); let lo = false; for (let i = 3; i < img.rgba.length && !lo; i += 4) lo = img.rgba[i] < 250; if (lo) mat.alphaMode = "BLEND"; }
    if (mr) { mat.pbrMetallicRoughness.baseColorTexture = { index: mr.tex }; const t = mr.t; if (t.uvScale && (t.uvScale[0] !== 1 || t.uvScale[1] !== 1 || t.uvOffset[0] || t.uvOffset[1])) mat.pbrMetallicRoughness.baseColorTexture.extensions = { KHR_texture_transform: { offset: t.uvOffset, scale: t.uvScale } }; }
    return mat; });
  const meshes = [], nodes = [], meshOf = new Map();
  for (const d of m.draws) {
    const vb = m.vbs[d.vb]; if (!vb || vb.stride < 32) continue; const tris = drawTriangles(m, d); if (!tris.length) continue;
    const used = new Map(), P = [], N = [], C = [], U = [], I = [];
    for (const i of tris) { if (!used.has(i)) { used.set(i, used.size); const o = vb.data + i * vb.stride; P.push(f(o), f(o + 4), f(o + 8)); N.push(f(o + 12), f(o + 16), f(o + 20)); C.push(a[o + 26] / 255, a[o + 25] / 255, a[o + 24] / 255, a[o + 27] / 255); U.push(f(o + 28), f(o + 32)); } I.push(used.get(i)); }
    meshes.push({ name: d.name || `piece_${d.index}`, primitives: [{ attributes: { POSITION: push(P, "VEC3", 5126, 34962, true), NORMAL: push(N, "VEC3", 5126, 34962), TEXCOORD_0: push(U, "VEC2", 5126, 34962), COLOR_0: push(C, "VEC4", 5126, 34962) }, indices: push(I, "SCALAR", 5125, 34963), material: d.material < materials.length ? d.material : undefined }] });
    meshOf.set(d.index, meshes.length - 1);
  }
  const placed = new Map(); for (const p of m.placements) { if (!placed.has(p.draw)) placed.set(p.draw, []); placed.get(p.draw).push(p.node); }
  for (const [di, mi] of meshOf) for (const nd of placed.get(di) ?? [0]) {
    const node = { name: nd ? m.nodes[nd].name : meshes[mi].name, mesh: mi };
    if (nd) { const M = nodeMatrix(m.nodes[nd]); node.matrix = [M[0][0], M[1][0], M[2][0], 0, M[0][1], M[1][1], M[2][1], 0, M[0][2], M[1][2], M[2][2], 0, M[0][3], M[1][3], M[2][3], 1]; }
    nodes.push(node); }
  const bin = Buffer.concat(bins); writeFileSync(join(outDir, "model.bin"), bin);
  const gltf = { asset: { version: "2.0", generator: BUILDER }, extensionsUsed: ["KHR_texture_transform"], scene: 0, scenes: [{ nodes: [nodes.length] }],
    nodes: [...nodes, { name: m.name || "track", children: nodes.map((_, i) => i), scale: [0.01, 0.01, 0.01] }],
    meshes, materials, textures, images, samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }], accessors, bufferViews: views, buffers: [{ uri: "model.bin", byteLength: bin.length }] };
  writeFileSync(join(outDir, "model.gltf"), JSON.stringify(gltf));
  // physics-reference.gltf: the slot's collision layer (racing surface, apron, grass, pit road, walls) in the same
  // frame, to line a model up in Blender (the build ignores it)
  let physics = null;
  try { const db = openDatabases(["NASCAR.DB", "GMODEDB.DAT"].map(f => join(data, f)).filter(existsSync)), race = db.tables.get("RACE").rows.filter(r => r.RTID === slot).sort((x, y) => x.RAID - y.RAID)[0];
    const tpid = race && db.tables.get("TRCK").rows.find(r => r.TRID === race.TRID)?.TPID;
    if (tpid !== undefined) { const pb = readTerfEntry(nodeFs, join(data, "TK_PHYS.DAT"), tpid); if (pb) { exportCollisionGLTF(pb, join(outDir, "physics-reference.gltf")); physics = tpid; } } } catch {}
  const meta = { name: name ?? `${m.name.replace(/\.(e(a3?)?)?$/i, "")} (edited)`, author: "", model: "model.gltf", slots: [slot], enabled: false };
  if (!existsSync(join(outDir, "track.json"))) writeFileSync(join(outDir, "track.json"), JSON.stringify(meta, null, 2));
  return { meshes: meshes.length, nodes: nodes.length, materials: materials.length, textures: images.length, physics };
}

// ---------------------------------------------------------------- import (glTF -> builder scene)
const pow2 = v => { let p = 4; while (p < v && p < 1024) p *= 2; if (p > v && p > 4 && (v - p / 2) < (p - v)) p /= 2; return Math.min(1024, p); };
const sameish = (a, b) => Math.abs(a - b) <= 1e-4 * Math.max(1, Math.abs(a), Math.abs(b));

// 3x4 matrix -> { t, r (degrees; R = Rz Ry Rx), s } or null when it has shear
export function decompose(M) {
  const col = j => [M[0][j], M[1][j], M[2][j]], s = [0, 1, 2].map(j => Math.hypot(...col(j)));
  if (s.some(x => x < 1e-9)) return null;
  const det = M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
  if (det < 0) s[0] = -s[0];
  const R = [0, 1, 2].map(i => [0, 1, 2].map(j => M[i][j] / s[j]));
  const sy = Math.max(-1, Math.min(1, -R[2][0])), ry = Math.asin(sy); let rx, rz;
  if (Math.cos(ry) > 1e-6) { rx = Math.atan2(R[2][1], R[2][2]); rz = Math.atan2(R[1][0], R[0][0]); } else { rz = 0; rx = Math.atan2(-R[1][2], R[1][1]); }
  const out = { t: [M[0][3], M[1][3], M[2][3]], r: [rx, ry, rz].map(x => x * 180 / Math.PI), s };
  const B = nodeMatrix(out); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (Math.abs(B[i][j] - M[i][j]) > 1e-3 * Math.max(1, ...s.map(Math.abs))) return null;
  return out;
}

const NO_LIGHT = [150, 150, 150, 255];
export function sceneFromGLTF(file, { tile = 6000, maxVerts = 16000, log = () => {} } = {}) {
  const G = readGLTF(file), J = G.json, UNIT = 100;      // metres -> centimetres
  const U = [[UNIT, 0, 0, 0], [0, UNIT, 0, 0], [0, 0, UNIT, 0], [0, 0, 0, 1]];
  // textures (deduplicated by image + uv transform)
  const textures = [], texKey = new Map();
  const addTex = (key, name, load, offset = [0, 0], scale = [1, 1], keepAlpha = true, factor = null) => {
    const k = `${key}|${offset}|${scale}|${keepAlpha}|${factor}`; if (texKey.has(k)) return texKey.get(k);
    let img = load(); const W = pow2(img.width), H = pow2(img.height); let rgba = img.rgba;
    if (W !== img.width || H !== img.height) rgba = resize(rgba, img.width, img.height, W, H); else rgba = new Uint8Array(rgba);
    if (factor && factor.some(x => x !== 1)) for (let i = 0; i < rgba.length; i += 4) for (let c = 0; c < 4; c++) rgba[i + c] = Math.round(rgba[i + c] * factor[c]);
    if (!keepAlpha) for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    textures.push({ name: String(name).replace(/\.[a-z]+$/i, "").replace(/[^\w-]/g, "_").slice(0, 12) || "tex", width: W, height: H, rgba, offset, scale }); texKey.set(k, textures.length - 1); return textures.length - 1; };
  const materials = (J.materials ?? []).map((mt, mi) => {
    const nt = mt.extras?.nt04, name = (mt.name ?? `mat${mi}`).replace(/[^\x20-\x7e]/g, "").slice(0, 28), pbr = mt.pbrMetallicRoughness ?? {};
    const see = mt.alphaMode === "MASK" || mt.alphaMode === "BLEND";
    if (nt?.layers?.length) {
      const tex = nt.layers.map(l => addTex(`f:${l.image}`, basename(l.image), () => G.imageFile(l.image), l.offset ?? [0, 0], l.scale ?? [1, 1], true));
      return { name, shader: nt.shader || "1P_BT", textures: tex, ...(Number.isInteger(nt.group) ? { group: nt.group } : {}) };
    }
    const f = pbr.baseColorFactor ?? [1, 1, 1, 1], bt = pbr.baseColorTexture;
    let ti;
    if (bt && J.textures?.[bt.index]?.source !== undefined) { const src = J.textures[bt.index].source, tt = bt.extensions?.KHR_texture_transform;
      ti = addTex(`i:${src}`, J.images[src].name ?? J.images[src].uri ?? `img${src}`, () => G.image(src), tt?.offset ?? [0, 0], tt?.scale ?? [1, 1], see, f); }
    else { const c = f.map(x => Math.round(Math.max(0, Math.min(1, x)) * 255)); ti = addTex(`c:${c}`, "colour", () => ({ width: 4, height: 4, rgba: new Uint8Array(64).map((_, i) => c[i & 3]) }), [0, 0], [1, 1], see); }
    return { name, shader: (nt?.shader) || "1P_BT", textures: [ti], ...(Number.isInteger(nt?.group) ? { group: nt.group } : see ? { group: 6 } : {}) };
  });
  let defMat = -1; const matOf = m => { if (m !== undefined && materials[m]) return m; if (defMat < 0) { materials.push({ name: "default", textures: [addTex("c:grey", "grey", () => ({ width: 4, height: 4, rgba: new Uint8Array(64).fill(200) }))] }); defMat = materials.length - 1; } return defMat; };
  // primitives as triangle lists
  const prims = (mi) => (J.meshes[mi].primitives ?? []).map(p => {
    const mode = p.mode ?? 4; if (![4, 5, 6].includes(mode) || p.attributes?.POSITION === undefined) return null;
    const P = G.accessor(p.attributes.POSITION), n = P.count, N = p.attributes.NORMAL !== undefined ? G.accessor(p.attributes.NORMAL) : null;
    const T = p.attributes.TEXCOORD_0 !== undefined ? G.accessor(p.attributes.TEXCOORD_0) : null, C = p.attributes.COLOR_0 !== undefined ? G.accessor(p.attributes.COLOR_0) : null;
    let idx = p.indices !== undefined ? G.accessor(p.indices).data : [...Array(n).keys()], tri = [];
    if (mode === 4) tri = idx; else if (mode === 5) { for (let i = 2; i < idx.length; i++) tri.push(...(i & 1 ? [idx[i - 1], idx[i - 2], idx[i]] : [idx[i - 2], idx[i - 1], idx[i]])); } else for (let i = 2; i < idx.length; i++) tri.push(idx[0], idx[i - 1], idx[i]);
    const pos = [], nrm = N ? [] : null, uv = [], col = [];
    for (let k = 0; k < n; k++) { pos.push([P.data[k * 3], P.data[k * 3 + 1], P.data[k * 3 + 2]]); if (N) nrm.push([N.data[k * 3], N.data[k * 3 + 1], N.data[k * 3 + 2]]); uv.push(T ? [T.data[k * 2], T.data[k * 2 + 1]] : [0, 0]);
      col.push(C ? [0, 1, 2, 3].map(c => c < C.n ? Math.round(Math.max(0, Math.min(1, C.data[k * C.n + c])) * 255) : 255) : NO_LIGHT); }
    if (!nrm) { const acc = pos.map(() => [0, 0, 0]); for (let i = 0; i + 2 < tri.length; i += 3) { const [a, b, c] = [pos[tri[i]], pos[tri[i + 1]], pos[tri[i + 2]]], e1 = [0, 1, 2].map(j => b[j] - a[j]), e2 = [0, 1, 2].map(j => c[j] - a[j]), cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]; for (const v of [tri[i], tri[i + 1], tri[i + 2]]) for (let j = 0; j < 3; j++) acc[v][j] += cr[j]; }
      return { material: matOf(p.material), pos, nrm: acc.map(v => { const l = Math.hypot(...v) || 1; return v.map(x => x / l); }), uv, col, tri }; }
    return { material: matOf(p.material), pos, nrm, uv, col, tri };
  }).filter(Boolean);
  // cut a triangle set into pieces of at most maxVerts vertices
  const pieces = [];
  const emit = (name, material, src, triList, placements = null) => {
    let map = new Map(), cur = null;
    const flush = () => { if (cur?.triangles.length) pieces.push(cur); cur = { name, material, positions: [], normals: [], colors: [], uvs: [], triangles: [], placements }; map = new Map(); };
    flush();
    for (let i = 0; i + 2 < triList.length; i += 3) { if (cur.positions.length + 3 > maxVerts) flush();
      for (let j = 0; j < 3; j++) { const v = triList[i + j]; let o = map.get(v); if (o === undefined) { o = cur.positions.length; map.set(v, o); cur.positions.push(src.pos[v]); cur.normals.push(src.nrm[v]); cur.colors.push(src.col[v]); cur.uvs.push(src.uv[v]); } cur.triangles.push(o); } }
    flush(); };
  const byMesh = new Map(); for (const u of G.uses) { if (!byMesh.has(u.mesh)) byMesh.set(u.mesh, []); byMesh.get(u.mesh).push(u); }
  const baked = new Map();       // material -> { pos, nrm, uv, col, tri } in centimetres, world space
  let nInst = 0, nPl = 0;
  for (const [mi, uses] of byMesh) {
    const ps = prims(mi), mats = uses.map(u => mat4.mul(U, u.matrix)), dec = uses.length > 1 ? mats.map(decompose) : null;
    if (dec && dec.every(Boolean)) {          // repeated object: one piece, drawn at every node
      const g0 = Math.cbrt(Math.abs(dec[0].s[0] * dec[0].s[1] * dec[0].s[2])) || 1, pl = dec.map((d, k) => ({ name: (uses[k].name ?? "").replace(/[^\x20-\x7e]/g, "").slice(0, 15), t: d.t, r: d.r, s: d.s.map(x => x / g0) }));
      for (const p of ps) { const src = { ...p, pos: p.pos.map(v => v.map(x => x * g0)) }; emit((J.meshes[mi].name ?? `mesh${mi}`).slice(0, 40), p.material, src, p.tri, pl); }
      nInst++; nPl += pl.length; continue;
    }
    for (const M of mats) {
      const A3 = [0, 1, 2].map(i => [0, 1, 2].map(j => M[i][j])), det = A3[0][0] * (A3[1][1] * A3[2][2] - A3[1][2] * A3[2][1]) - A3[0][1] * (A3[1][0] * A3[2][2] - A3[1][2] * A3[2][0]) + A3[0][2] * (A3[1][0] * A3[2][1] - A3[1][1] * A3[2][0]);
      const inv = [[A3[1][1] * A3[2][2] - A3[1][2] * A3[2][1], A3[0][2] * A3[2][1] - A3[0][1] * A3[2][2], A3[0][1] * A3[1][2] - A3[0][2] * A3[1][1]], [A3[1][2] * A3[2][0] - A3[1][0] * A3[2][2], A3[0][0] * A3[2][2] - A3[0][2] * A3[2][0], A3[0][2] * A3[1][0] - A3[0][0] * A3[1][2]], [A3[1][0] * A3[2][1] - A3[1][1] * A3[2][0], A3[0][1] * A3[2][0] - A3[0][0] * A3[2][1], A3[0][0] * A3[1][1] - A3[0][1] * A3[1][0]]].map(r => r.map(x => x / (det || 1)));
      for (const p of ps) { if (!baked.has(p.material)) baked.set(p.material, { pos: [], nrm: [], uv: [], col: [], tri: [] }); const B = baked.get(p.material), base = B.pos.length;
        for (let k = 0; k < p.pos.length; k++) { const v = p.pos[k], nv = p.nrm[k]; B.pos.push([0, 1, 2].map(i => M[i][0] * v[0] + M[i][1] * v[1] + M[i][2] * v[2] + M[i][3]));
          const w = [0, 1, 2].map(i => inv[0][i] * nv[0] + inv[1][i] * nv[1] + inv[2][i] * nv[2]), l = Math.hypot(...w) || 1; B.nrm.push(w.map(x => x / l)); B.uv.push(p.uv[k]); B.col.push(p.col[k]); }
        for (let i = 0; i + 2 < p.tri.length; i += 3) { if (det < 0) B.tri.push(base + p.tri[i], base + p.tri[i + 2], base + p.tri[i + 1]); else B.tri.push(base + p.tri[i], base + p.tri[i + 1], base + p.tri[i + 2]); } }
    }
  }
  for (const [mat, B] of baked) {          // tiles of tile x tile cm (x, z) per material
    const tiles = new Map();
    for (let i = 0; i + 2 < B.tri.length; i += 3) { const c = [0, 2].map(j => (B.pos[B.tri[i]][j] + B.pos[B.tri[i + 1]][j] + B.pos[B.tri[i + 2]][j]) / 3), key = `${Math.floor(c[0] / tile)},${Math.floor(c[1] / tile)}`;
      if (!tiles.has(key)) tiles.set(key, []); tiles.get(key).push(B.tri[i], B.tri[i + 1], B.tri[i + 2]); }
    for (const [key, tl] of tiles) emit(`${materials[mat].name}_${key}`.slice(0, 40), mat, B, tl);
  }
  log(`model: ${G.uses.length} mesh uses, ${pieces.length} pieces (${nInst} repeated objects at ${nPl} places), ${materials.length} materials, ${textures.length} textures`);
  return { pieces, materials, textures };
}

// ---------------------------------------------------------------- build
const packFiles = dir => { const out = []; const walk = d => { for (const n of readdirSync(d)) { if ((n === "build" || n === "track.json" || n === "physics-reference.gltf") && d === dir) continue; const p = join(d, n), s = statSync(p); if (s.isDirectory()) walk(p); else out.push(`${relative(dir, p)}:${s.size}:${Math.round(s.mtimeMs)}`); } }; walk(dir); return out.sort(); };
export function readPack(dir) { const meta = JSON.parse(readFileSync(join(dir, "track.json"), "utf8")); meta.slots = (meta.slots ?? []).map(Number).filter(Number.isInteger); return meta; }
// (track.json counts only for what changes the build: the model file and the slots; name / enabled do not)
export function packKey(dir) { const m = readPack(dir); return createHash("sha1").update(BUILDER + "\n" + JSON.stringify([m.model, m.slots, m.layout ?? null, m.layoutOptions ?? null, m.physics ?? null, m.lines ?? null]) + "\n" + packFiles(dir).join("\n")).digest("hex"); }
export function buildState(dir) {
  try { const meta = readPack(dir), bj = join(dir, "build", "build.json"); if (!existsSync(bj)) return { meta, built: false };
    const b = JSON.parse(readFileSync(bj, "utf8")), fresh = b.key === packKey(dir) && meta.slots.every(s => existsSync(join(dir, "build", `tk_rend_${s}.bin`)));
    return { meta, built: true, fresh, build: b }; } catch (e) { return { error: e.message }; }
}
export async function buildPack(dir, data, { log = console.log } = {}) {
  const meta = readPack(dir), t0 = Date.now();
  if (!meta.slots.length) throw new Error("track.json: no slots");
  mkdirSync(join(dir, "build"), { recursive: true }); rmSync(join(dir, "build", "tk_score.bin"), { force: true }); const out = {}; let warp = null, home = null, trackMap = false;
  // a layout of its own (added tracks): the base track's physics, AI speeds and model carried along the new centreline
  if (meta.mode === "add" && (meta.layout || meta.physics)) {
    const { warpTrack, centrelineFromGLTF, layoutSVG } = await import("./trackwarp.mjs");
    let layout; if (meta.physics) { const f = n => { const p = join(dir, n); if (!existsSync(p)) throw new Error(`"${n}" not found in the pack`); return p; };
      log(`reading the layout from ${meta.physics}${meta.lines ? ` and the racing lines from ${meta.lines}` : " (no racing-lines file: the base track's lines, carried along)"}`);
      const { layoutFromGLTF } = await import("./gltf-layout.mjs"); layout = await layoutFromGLTF({ physics: f(meta.physics), lines: meta.lines ? f(meta.lines) : null }, meta.layoutOptions ?? {});
      for (const m of layout.notes ?? []) log(m);
      log(`layout: ${layout.points.length} points${layout.edges ? ", road edges" : " (no road mesh: banking from the options)"}${layout.walls ? ", walls" : ""}${layout.pit ? ", pit road" : ""}${layout.pitWall ? ", pit wall" : ""}${layout.raceline ? ", racing line" : ""}${layout.aiSpeed ? " with speeds" : ""}${layout.pitLane ? ", pit lane ends" : ""}${layout.pitStalls ? `, ${layout.pitStalls.length} stalls` : ""}${layout.grid ? `, ${layout.grid.cars.length} grid places` : ""}`); }
    else if (/\.(glb|gltf)$/i.test(meta.layout)) { log(`reading the centreline from ${meta.layout}`); layout = await centrelineFromGLTF(join(dir, meta.layout), meta.layoutOptions ?? {}); }
    else { const f = join(dir, meta.layout); if (!existsSync(f)) throw new Error(`layout file "${meta.layout}" not found in the pack`); layout = { ...JSON.parse(readFileSync(f, "utf8")), ...(meta.layoutOptions ?? {}) }; }
    if (!Array.isArray(layout.points) || layout.points.length < 4) throw new Error("the layout needs a closed centreline of at least 4 points");
    const tpid = meta.base?.tpid ?? baseTPID(data, meta.slots[0]); log(`new layout from the base track (physics entry ${tpid}, model ${meta.slots[0]})`);
    warp = warpTrack({ data, baseRend: meta.slots[0], basePhys: tpid, layout });
    writeFileSync(join(dir, "build", "tk_phys.bin"), warp.phys); writeFileSync(join(dir, "build", "ai_spds.bin"), warp.ai); writeFileSync(join(dir, "build", "layout.svg"), layoutSVG(warp));
    exportCollisionGLTF(warp.phys, join(dir, "physics-reference.gltf"));
    home = similarHomeTrack(data, warp.ai, { miles: warp.info.miles, baseTrid: meta.base?.trid ?? null }, meta.home, log);
    { const bad = pitLinesThroughWalls(warp.doc); if (bad.length) log(`pit road check: ${bad.join("; ")} (AI cars following them run into the wall)`); else log("pit road check: no pit line crosses a wall"); }
    if (meta.mode === "add") try { trackMap = writeTrackMap(dir, data, layout, meta, log); } catch (e) { log(`track map: ${e.message}`); }
    // the base's scoring pylon digits (TK_SCORE, indexed by the model id like TK_REND): the game draws them at the base
    // track's pylon, which a track with its own scenery doesn't have, so they hang in the sky there. Same model with
    // every vertex at one point (nothing drawn); layout "hideBaseObjects": false keeps them.
    if (layout.ground?.z && layout.hideBaseObjects !== false) try { writeFileSync(join(dir, "build", "tk_score.bin"), hiddenScore(readTerfEntry(nodeFs, join(data, "TK_SCORE.DAT"), meta.slots[0]))); log("scoring pylon digits: hidden (the base track's pylon isn't in this scenery)"); } catch (e) { log(`scoring pylon: ${e.message}`); }
    for (const m of warp.info.ai ?? []) log(m);
    log(`layout: ${warp.info.miles.toFixed(3)} miles (base track ${(warp.info.baseLength / 5280).toFixed(3)}); physics-reference.gltf updated`);
  }
  let scene = null;
  if (meta.model) { const model = join(dir, meta.model); if (!existsSync(model)) throw new Error(`track.json: model file "${meta.model}" not found in the pack`);
    log(`reading ${meta.model}`); scene = sceneFromGLTF(model, { log, ...(process.env.NT04_TILE ? { tile: +process.env.NT04_TILE } : {}) }); if (!scene.pieces.length) throw new Error("the model has no triangles"); }
  else if (!warp) throw new Error("the pack has no model (add one, or give it a layout of its own to use the base track's scenery)");
  for (const s of meta.slots) {
    const f = join(dir, "build", `tk_rend_${s}.bin`);
    if (!scene) { log(`model: the base track's scenery along the new layout`); writeFileSync(f, warp.rend); out[s] = warp.rend.length; continue; }
    const tpl = rendEntry(data, s); if (!tpl) throw new Error(`no track slot ${s}`);
    log(`building slot ${s} (${infoName(tpl)})`);
    const b = buildTMdl({ ...scene, name: infoName(tpl) || "TRACK.ea3" }, tpl); writeFileSync(f, b); out[s] = b.length;
    const check = parseTMdl(b); if (check.errors.length) throw new Error(`built model does not read back: ${check.errors.join("; ")}`);
  }
  const P = scene?.pieces ?? [], info = { key: packKey(dir), builder: BUILDER, built: new Date().toISOString(), pieces: P.length, materials: scene?.materials.length ?? 0, textures: scene?.textures.length ?? 0,
    triangles: P.reduce((a, p) => a + p.triangles.length / 3, 0), drawn: P.reduce((a, p) => a + p.triangles.length / 3 * (p.placements?.length || 1), 0), sizes: out, ms: Date.now() - t0, ...(warp ? { miles: warp.info.miles, layout: true, home, trackMap } : {}) };
  writeFileSync(join(dir, "build", "build.json"), JSON.stringify(info, null, 2)); log(`done in ${(info.ms / 1000).toFixed(1)} s${scene ? `: ${info.pieces} pieces, ${info.drawn} triangles drawn` : ""}`);
  return info;
}
export function hiddenScore(b) {
  if (!b) throw new Error("no scoring entry"); const m = parseTMdl(b), out = Buffer.from(b); let n = 0;
  for (const vb of m.vbs ?? []) for (let i = 0; i < vb.count; i++) { out.fill(0, vb.data + i * vb.stride, vb.data + i * vb.stride + 12); n++; }
  if (!n) throw new Error("no vertices in the scoring model"); return out;
}
export function baseTPID(data, slot) {
  const db = openDatabases(["NASCAR.DB", "GMODEDB.DAT"].map(f => join(data, f)).filter(existsSync)), race = db.tables.get("RACE").rows.filter(r => r.RTID === slot).sort((x, y) => x.RAID - y.RAID)[0];
  const tp = race && db.tables.get("TRCK").rows.find(r => r.TRID === race.TRID)?.TPID; if (tp === undefined) throw new Error(`no physics entry for track slot ${slot}`); return tp;
}

// Every enabled pack with a current build:
//   overrides  entryOverrides { "tk_rend.dat": { entry: file } } (replace: the pack's slots; add: its new entry)
//   tracks     added tracks for the database overlay (nt04-config applyTracks): [{ id, base, ids, track }]
export function packOverrides(tracksDir, warn = () => {}) { return packState(tracksDir, warn).overrides; }
// Model ids (RACE.RTID) of added tracks start here: TK_REND.DAT has 76 entries, but TK_SCORE.DAT (also indexed by
// RTID) has 78 and the game loads its entry 77 in every race.
export const FIRST_RTID = 78;
export function packState(tracksDir, warn = () => {}) {
  const overrides = {}, tracks = []; if (!tracksDir || !existsSync(tracksDir)) return { overrides, tracks };
  for (const id of readdirSync(tracksDir).sort()) { const dir = join(tracksDir, id); if (!existsSync(join(dir, "track.json"))) continue;
    const st = buildState(dir); if (st.error || !st.meta.enabled) continue;
    if (!st.built || !st.fresh) { warn(`track pack ${id}: not built since its last change (build it in the launcher's Tracks tab)`); continue; }
    const m = st.meta, R = (overrides["tk_rend.dat"] ??= {});
    if (m.mode === "add") { if (!m.ids || !m.base) { warn(`track pack ${id}: no ids`); continue; }
      if (m.ids.rtid < FIRST_RTID) { warn(`track pack ${id}: model id ${m.ids.rtid} is used by the game (open the launcher's Tracks tab once to renumber it)`); continue; }
      R[m.ids.rtid] = resolve(dir, "build", `tk_rend_${m.slots[0]}.bin`);
      { const sc = resolve(dir, "build", "tk_score.bin"); (overrides["tk_score.dat"] ??= {})[m.ids.rtid] = st.build?.layout && existsSync(sc) ? sc : `@${m.base.slot}`; }   // the scoring data: indexed by model id too
      const lay = (m.layout || m.physics) && st.build?.layout && m.ids.tpid !== undefined;
      if (lay) { (overrides["tk_phys.dat"] ??= {})[m.ids.tpid] = resolve(dir, "build", "tk_phys.bin"); (overrides["ai_spds.dat"] ??= {})[m.ids.tpid] = resolve(dir, "build", "ai_spds.bin"); }
      const idtm = lay && st.build?.trackMap ? mapIndex(m.ids) : null;          // the HUD track map: TMAPDAT IDTM + 0..3
      if (idtm !== null) { const T = (overrides["tmapdat.dat"] ??= {}); ["tmap_small.bin", "tmap_small.pos", "tmap_large.bin", "tmap_large.pos"].forEach((f, k) => { T[idtm + k] = resolve(dir, "build", f); }); }
      tracks.push({ id, base: m.base, home: m.home ?? st.build?.home?.tphd, setup: m.setup, ids: { ...(lay ? m.ids : { ...m.ids, tpid: undefined }), ...(idtm !== null ? { idtm } : {}) }, track: { ...(m.model && lay ? { night: false } : {}), ...(m.track ?? {}), ...(lay ? { miles: st.build.miles } : {}) } }); }   // (own scenery: a day race unless track.json says "night": true)
    else for (const s of m.slots) R[s] = resolve(dir, "build", `tk_rend_${s}.bin`); }
  return { overrides, tracks };
}

if (process.argv[1] && basename(process.argv[1]) === "track-pack.mjs") {
  const [cmd, a1, a2, a3] = process.argv.slice(2);
  if (cmd === "slots") for (const s of trackSlots(a1)) console.log(`${String(s.slot).padStart(2)}  ${s.model.padEnd(18)} ${s.track.padEnd(14)} ${s.races.join(" / ")}`);
  else if (cmd === "export") console.log(exportStarter(a1, +a2, a3));
  else if (cmd === "build") await buildPack(a1, a2);
  else console.log("usage: node track-pack.mjs slots <Data> | export <Data> <slot> <outDir> | build <packDir> <Data>");
}
