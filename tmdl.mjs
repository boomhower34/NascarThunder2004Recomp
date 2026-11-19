#!/usr/bin/env node
// tmdl.mjs — reader for the game's "TMdl" models (tracks in TK_REND.DAT; also TK_SHAD / TK_SKY / TK_SCORE, cars in
// CARDATA.DAT) and an exporter to glTF 2.0 (.gltf + .bin + PNG textures) for Blender and other tools.
//
// FILE LAYOUT (little-endian; every offset is from the start of the TMdl, the game turns them into pointers)
//   0x00 "TMdl", u32 size, u16 chunk count, ...
//   0x10 chunk table, 16 bytes each: tag, u32 offset, u32 size, u32 count. Tags (model field set by 0x135500):
//        Info (+0: model name, e.g. "ATL_ATLANTA.ea3"), Swap, Geom (+8), Lite, Matl (+0x18), Txfm (+0x20), Inst (+0x24),
//        Rint (+0x28), Text (textures), Fade (+0x30), DInf (+0x2C: piece names), Extn, Clst, Skel, MAnm.
//   Geom: u32 drawsOffset, u32 drawCount, u32 vbOffset, u32 vbCount
//     draw (20 bytes): u32 strips -> { u32 n (1), u32 P }  with P -> { u32 primitive count, 12 bytes } and the u16
//                      indices right after (a triangle strip of count + 2 indices; NV2A primitive 6);
//                      u32 ?, u16 material, u16 ffff, u8 ff, u8 0, u16 vertex buffer, u8 1, u8 2, u8 ff, u8 0
//     vertex buffer (12 bytes): u32 offset (-> 12-byte D3D resource header, then the vertices), u16 count,
//                      u16 stride (40), u32 FVF 0x152: position 3f, normal 3f, colour BGRA, uv 2f (+4 unused)
//   Matl: u32 count, u32 offsets -> { name, shader name ("MP_DBT"...), u32 n, n texture-name pointers } (48 bytes)
//   Txfm: u32 count, 24 bytes each: { name pointer, u offset, v offset, u scale, v scale, flags } — one per texture
//   Text: an MMAP (version 2) with many textures: +0x0C u16 texture count, +0x14 texture table (12 bytes:
//         u16 1, u16 mip count, u16 first image, u16 0, u16 palette, u16 0), +0x18 images (16 bytes: u16 w, h,
//         u32 D3D format, u32 bytes, u32 offset from 0x80), +0x1C palettes (12 bytes: u16, u16, u32 0x400,
//         u32 offset from 0x80), +0x20 names (16 bytes each; texture k's name = Txfm k's name).
//   DInf: u32 16, u32 piece count, ..., then NUL-terminated piece names each followed by u32 ffffffff.
//   Positions: tracks in centimetres, car models in feet; y up.
//
// usage: node tmdl.mjs info   <TK_REND.DAT|file.tmdl> [entry]
//        node tmdl.mjs gltf   <TK_REND.DAT|file.tmdl> [entry] <outDir> [--all-lods]
//        node tmdl.mjs relayout <TK_REND.DAT|file.tmdl> [entry] <out.tmdl>   (writer test: chunks moved, pointers fixed)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { decodePixels, encodePNG } from "./mmap-tex.mjs";
import { parseTerf, isTerf } from "./terf.mjs";

export function parseTMdl(b) {
  if (b.toString("latin1", 0, 4) !== "TMdl") throw new Error("not a TMdl model");
  const u32 = o => b.readUInt32LE(o), u16 = o => b.readUInt16LE(o), f32 = o => b.readFloatLE(o);
  const cstr = (o, max = 256) => { let e = o; while (e < b.length && b[e] && e < o + max) e++; return b.toString("latin1", o, e); };
  const chunks = {};
  for (let k = 0; k < 32; k++) { const o = 0x10 + k * 16, tag = b.toString("latin1", o, o + 4); if (!/^[A-Za-z]{4}$/.test(tag)) break; chunks[tag] = { off: u32(o + 4), size: u32(o + 8), count: u32(o + 12) }; }
  const model = { name: chunks.Info ? cstr(chunks.Info.off) : "", chunks, buf: b, errors: [] };
  const part = (what, fn) => { try { fn(); } catch (e) { model.errors.push(`${what}: ${e.message}`); } };   // (car models: other layouts)

  // textures (Text MMAP) and their uv transforms (Txfm)
  model.textures = [];
  part("Text", () => { if (chunks.Text) {
    const M = chunks.Text.off, mu32 = o => u32(M + o), mu16 = o => u16(M + o);
    const n = mu16(0x0c), tt = mu32(0x14), it = mu32(0x18), pt = mu32(0x1c), nt = mu32(0x20);
    for (let k = 0; k < n; k++) {
      const d = tt + k * 12, img = mu16(d + 4), pal = mu16(d + 8), mips = mu16(d + 2), ih = it + img * 16;
      model.textures.push({ index: k, name: nt ? cstr(M + nt + k * 16, 16) : `tex${k}`, image: img, mips, palette: mu16(d) ? pal : -1,
        width: mu16(ih), height: mu16(ih + 2), format: mu32(ih + 4) & 0xff, pixels: M + 0x80 + mu32(ih + 12), paletteData: mu16(d) ? M + 0x80 + mu32(pt + pal * 12 + 8) : 0 });
    }
  } });
  part("Txfm", () => { if (chunks.Txfm) {
    const T = chunks.Txfm.off, n = u32(T);
    for (let k = 0; k < n; k++) { const r = T + 4 + k * 24, t = model.textures[k]; const x = { name: cstr(u32(r), 16), offset: [f32(r + 4), f32(r + 8)], scale: [f32(r + 12), f32(r + 16)], flags: u32(r + 20) };
      if (t) Object.assign(t, { uvOffset: x.offset, uvScale: x.scale, flags: x.flags }); else model.textures.push({ index: k, ...x }); }
  } });
  const byName = new Map(model.textures.map(t => [t.name, t.index]));
  // materials
  model.materials = [];
  part("Matl", () => { if (chunks.Matl) {
    const L = chunks.Matl.off, n = u32(L);
    for (let k = 0; k < n; k++) { const m = u32(L + 4) + k * 0x30, cnt = u16(m + 8), names = [];   // (records are contiguous: the game relocates only the first offset)
      for (let j = 0; j < cnt && j < 8; j++) names.push(cstr(u32(m + 12 + j * 4), 16));
      model.materials.push({ index: k, name: cstr(u32(m), 32), shader: cstr(u32(m + 4), 16), textures: names.map(nm => byName.get(nm) ?? -1), textureNames: names }); }
  } });
  // piece names (DInf)
  model.pieceNames = [];
  // (u32 0x10, u32 count, u32 size, u32 ?, then per draw a 36-byte record: the name in 32 bytes, zero-padded, and a u32,
  // 0xFFFFFFFF in the base tracks)
  part("DInf", () => { if (chunks.DInf) { const D = chunks.DInf.off, n = u32(D + 4), rec = n ? Math.floor((chunks.DInf.size - 16) / n) : 36;
    if (rec >= 33) for (let k = 0; k < n; k++) model.pieceNames.push(cstr(D + 16 + rec * k, Math.min(32, rec - 4)));
    else { let o = D + 16; for (let k = 0; k < n && o < D + chunks.DInf.size; k++) { const s = cstr(o, 200); model.pieceNames.push(s); o += s.length + 1; if (u32(o) === 0xffffffff) o += 4; } } } });
  // geometry
  model.draws = []; model.vbs = [];
  part("Geom", () => { if (chunks.Geom) {
    const G = chunks.Geom.off, dOff = u32(G), dN = u32(G + 4), vOff = u32(G + 8), vN = u32(G + 12);
    for (let k = 0; k < vN; k++) { const v = vOff + k * 12; model.vbs.push({ data: u32(v) + 12, count: u16(v + 4), stride: u16(v + 6), fvf: u32(v + 8) }); }
    for (let k = 0; k < dN; k++) {
      const r = dOff + k * 20, A = u32(r), strips = [];
      const ns = u32(A); for (let s = 0; s < Math.max(1, Math.min(ns, 1)); s++) { const P = u32(A + 4); const prims = u32(P); strips.push({ indices: P + 16, count: prims + 2 }); }
      model.draws.push({ index: k, strips, material: u16(r + 8), vb: u16(r + 14), name: model.pieceNames[k] ?? "" });
    }
  } });
  // instances and placements (Inst): instance -> range of subs; a sub draws one piece at a scene-graph node's
  // transform (the catch-fence posts, light poles... are one piece drawn at hundreds of nodes)
  model.nodes = []; model.placements = [];
  part("Inst", () => { if (chunks.Inst) {
    const I = chunks.Inst.off, nI = u32(I), rng = u32(I + 4), subs = u32(I + 8), H = u32(I + 0x10);
    if (H) { const n = u32(H), nm = u32(H + 4), tr = u32(H + 8), ro = u32(H + 12), sc = u32(H + 16);
      for (let i = 0; i < n; i++) model.nodes.push({ name: cstr(nm + i * 16, 16), t: [f32(tr + i * 16), f32(tr + i * 16 + 4), f32(tr + i * 16 + 8)],
        r: [0, 2, 4].map(k => b.readInt16LE(ro + i * 6 + k) * 180 / 32768), s: sc ? [f32(sc + i * 12), f32(sc + i * 12 + 4), f32(sc + i * 12 + 8)] : [1, 1, 1] }); }
    const seen = new Set();
    for (let i = 0; i < nI; i++) for (let s = u16(rng + i * 4); s < u16(rng + i * 4 + 2); s++) { const draw = u32(subs + s * 16 + 12), node = u32(subs + s * 16 + 8), key = draw * 65536 + node;
      if (seen.has(key) || draw >= model.draws.length) continue; seen.add(key); model.placements.push({ instance: i, sub: s, draw, node }); }
  } });
  return model;
}

export function textureRGBA(model, t) {
  if (!t || !t.width || !t.pixels) return null;
  const b = model.buf, pal = t.paletteData ? b.subarray(t.paletteData, t.paletteData + 1024) : null;
  return { width: t.width, height: t.height, rgba: decodePixels(t.format, b, t.pixels, t.width, t.height, pal) };
}

// triangles of a draw (strip -> list, degenerate triangles dropped, winding alternates)
export function drawTriangles(model, d) {
  const b = model.buf, out = [];
  for (const s of d.strips) { const ix = []; for (let i = 0; i < s.count; i++) ix.push(b.readUInt16LE(s.indices + i * 2));
    for (let i = 2; i < ix.length; i++) { const a = ix[i - 2], c = ix[i - 1], e = ix[i]; if (a === c || c === e || a === e) continue; if (i & 1) out.push(c, a, e); else out.push(a, c, e); } }
  return out;
}

// a scene-graph node's transform as a 3x4 matrix: translation * Rz * Ry * Rx * scale (Maya's xyz rotate order;
// angles are s16 with 32768 = 180 degrees)
export function nodeMatrix(n) {
  if (!n) return null; const [rx, ry, rz] = n.r.map(d => d * Math.PI / 180), [sx, sy, sz] = n.s;
  const cx = Math.cos(rx), sxn = Math.sin(rx), cy = Math.cos(ry), syn = Math.sin(ry), cz = Math.cos(rz), szn = Math.sin(rz);
  const R = [[cy * cz, cz * syn * sxn - szn * cx, cz * syn * cx + szn * sxn], [cy * szn, szn * syn * sxn + cz * cx, szn * syn * cx - cz * sxn], [-syn, cy * sxn, cy * cx]];
  return [0, 1, 2].map(i => [R[i][0] * sx, R[i][1] * sy, R[i][2] * sz, n.t[i]]);
}

// glTF export: one mesh per material, LOD 0 pieces only unless allLods
export function exportGLTF(model, outDir, { allLods = false, name = "track" } = {}) {
  mkdirSync(outDir, { recursive: true });
  const b = model.buf, groups = new Map();
  // every placement of every piece (pieces no instance places: once, untransformed)
  const placed = model.placements?.length ? model.placements : model.draws.map(d => ({ draw: d.index, node: 0 }));
  for (const pl of placed) { const d = model.draws[pl.draw], M = pl.node ? nodeMatrix(model.nodes[pl.node]) : null;
    const xf = (x, y, z) => M ? [0, 1, 2].map(i => M[i][0] * x + M[i][1] * y + M[i][2] * z + M[i][3]) : [x, y, z];
    const xn = (x, y, z) => { if (!M) return [x, y, z]; const v = [0, 1, 2].map(i => M[i][0] * x + M[i][1] * y + M[i][2] * z), l = Math.hypot(...v) || 1; return v.map(c => c / l); };
    if (allLods === false && d.lod > 0) continue;   // (piece names say "LOD_<section>": the section, not a level)
    const vb = model.vbs[d.vb]; if (!vb || vb.stride < 32) continue;
    const tris = drawTriangles(model, d); if (!tris.length) continue;
    if (!groups.has(d.material)) groups.set(d.material, { pos: [], nrm: [], uv: [], col: [], idx: [] });
    const g = groups.get(d.material), base = g.pos.length / 3, used = new Map();
    for (const i of tris) {
      if (!used.has(i)) { used.set(i, base + used.size); const o = vb.data + i * vb.stride;
        g.pos.push(...xf(b.readFloatLE(o), b.readFloatLE(o + 4), b.readFloatLE(o + 8))); g.nrm.push(...xn(b.readFloatLE(o + 12), b.readFloatLE(o + 16), b.readFloatLE(o + 20)));
        g.col.push(b[o + 26] / 255, b[o + 25] / 255, b[o + 24] / 255, b[o + 27] / 255); g.uv.push(b.readFloatLE(o + 28), b.readFloatLE(o + 32)); }
      g.idx.push(used.get(i));
    }
  }
  const bins = [], views = [], accessors = [], meshes = [], nodes = [], materials = [], textures = [], images = [], samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }];
  let off = 0; const push = (arr, type, comp, target, minmax) => { const buf = comp === 5126 ? Buffer.from(new Float32Array(arr).buffer) : Buffer.from(new Uint32Array(arr).buffer);
    views.push({ buffer: 0, byteOffset: off, byteLength: buf.length, target }); bins.push(buf); off += buf.length; const pad = (4 - off % 4) % 4; if (pad) { bins.push(Buffer.alloc(pad)); off += pad; }
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type], acc = { bufferView: views.length - 1, componentType: comp, count: arr.length / n, type };
    if (minmax) { const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < arr.length; i += 3) for (let c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], arr[i + c]); mx[c] = Math.max(mx[c], arr[i + c]); } acc.min = mn; acc.max = mx; }
    accessors.push(acc); return accessors.length - 1; };
  const texDone = new Map();
  const texFor = ti => { if (texDone.has(ti)) return texDone.get(ti); const t = model.textures[ti]; let r = -1;
    try { const img = textureRGBA(model, t); if (img) { const file = `tex_${String(ti).padStart(3, "0")}.png`; writeFileSync(join(outDir, file), encodePNG(img.width, img.height, img.rgba)); images.push({ uri: file, name: t.name }); textures.push({ source: images.length - 1, sampler: 0 }); r = textures.length - 1; } } catch {}
    texDone.set(ti, r); return r; };
  for (const [mi, g] of groups) {
    const m = model.materials[mi]; let main = -1;
    if (m) { const cand = m.textures.map((ti, j) => ({ ti, n: m.textureNames[j] })).filter(x => x.ti >= 0); main = (cand.find(x => /color|colour/i.test(x.n)) ?? cand.find(x => !/grime|crack|dynstretch|detail/i.test(x.n)) ?? cand[0])?.ti ?? -1; }
    const tex = main >= 0 ? texFor(main) : -1, tf = main >= 0 ? model.textures[main] : null;
    const mat = { name: m?.name ?? `mat${mi}`, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.9 }, doubleSided: true, extras: { shader: m?.shader, textures: m?.textureNames } };
    if (tex >= 0) { mat.pbrMetallicRoughness.baseColorTexture = { index: tex }; if (tf?.uvScale && (tf.uvScale[0] !== 1 || tf.uvScale[1] !== 1 || tf.uvOffset[0] || tf.uvOffset[1])) mat.pbrMetallicRoughness.baseColorTexture.extensions = { KHR_texture_transform: { offset: tf.uvOffset, scale: tf.uvScale } }; }
    if (/alpha|fence|chain|tree|glass/i.test(m?.name ?? "")) mat.alphaMode = "MASK";
    materials.push(mat);
    const attrs = { POSITION: push(g.pos, "VEC3", 5126, 34962, true), NORMAL: push(g.nrm, "VEC3", 5126, 34962), TEXCOORD_0: push(g.uv, "VEC2", 5126, 34962), COLOR_0: push(g.col, "VEC4", 5126, 34962) };
    meshes.push({ name: mat.name, primitives: [{ attributes: attrs, indices: push(g.idx, "SCALAR", 5125, 34963), material: materials.length - 1 }] });
    nodes.push({ name: mat.name, mesh: meshes.length - 1 });
  }
  // units: track models are in centimetres (Atlanta's oval: ~97,000 across = 3,180 ft, the same as its TK_PHYS
  // surface in feet); car models are in feet (~16.5 long). Big models are taken as cm, small ones as feet.
  let ext = 0; for (const a of accessors) if (a.max) ext = Math.max(ext, ...a.max.map(Math.abs), ...a.min.map(Math.abs));
  const unit = ext > 5000 ? 0.01 : 0.3048;
  const bin = Buffer.concat(bins), binName = `${name}.bin`; writeFileSync(join(outDir, binName), bin);
  const gltf = { asset: { version: "2.0", generator: "nt04 tmdl.mjs" }, extensionsUsed: ["KHR_texture_transform"], scene: 0,
    scenes: [{ nodes: [nodes.length] }], nodes: [...nodes, { name: model.name || name, children: nodes.map((_, i) => i), scale: [unit, unit, unit] }],
    meshes, materials, textures, images, samplers, accessors, bufferViews: views, buffers: [{ uri: binName, byteLength: bin.length }] };
  writeFileSync(join(outDir, `${name}.gltf`), JSON.stringify(gltf));
  return { meshes: meshes.length, triangles: meshes.reduce((a, m) => a + accessors[m.primitives[0].indices].count / 3, 0), textures: images.length };
}


// ---------------------------------------------------------------- writing
// Every stored pointer of a TMdl (offsets from the model start), following the game's chunk relocators: chunk table
// (0x135500), Swap 0x136630 (+4 +8 +0xC), Geom 0x137800 (+0 +8 +0x10; per draw with flag 0x200: the strip and
// second blocks and their pointer lists; per vertex buffer), Matl 0x136080 (list; name, shader, +0x2C, texture
// names), Txfm 0x137440 (names), Inst 0x1370B0 / 0x138FB0, Rint 0x137180 (node child pointers where the matching
// count is non-zero; cell list), Lite 0x1391A0. Null pointers stay null. Checked against Lowe's model as the game
// leaves it in memory: the same 9,870 fields.
export function tmdlPointers(a) {
  const u32 = o => a.readUInt32LE(o), u16 = o => a.readUInt16LE(o), s16 = o => a.readInt16LE(o), P = new Set(), add = o => { if (u32(o)) P.add(o); return u32(o); };   // (null pointers stay null)
  const ch = {}; for (let k = 0; k < 32; k++) { const o = 0x10 + k * 16, tag = a.toString("latin1", o, o + 4); if (!/^[A-Za-z]{4}$/.test(tag)) break; ch[tag] = u32(o + 4); add(o + 4); }
  if (ch.Swap !== undefined) { const S = ch.Swap; add(S + 4); add(S + 8); add(S + 0xc); }
  if (ch.Geom !== undefined) { const G = ch.Geom, d = add(G), v = add(G + 8); add(G + 0x10);
    for (let i = 0; i < u32(G + 4); i++) { const r = d + i * 20; if (!(a[r + 0x11] & 2)) continue; const x = add(r); for (let j = 0; j < u32(x); j++) add(x + 4 + j * 4); const y = add(r + 4); for (let j = 0; j < u32(y); j++) add(y + 4 + j * 4); }
    for (let i = 0; i < u32(G + 0xc); i++) add(v + i * 12); }
  if (ch.Matl !== undefined) { const M = ch.Matl, l = add(M + 4); for (let i = 0; i < u32(M); i++) { const r = l + i * 0x30; add(r); add(r + 4); add(r + 0x2c); for (let j = 0; j < s16(r + 8); j++) add(r + 0xc + j * 4); } }
  if (ch.Txfm !== undefined) { const T = ch.Txfm; for (let i = 0; i < u32(T); i++) add(T + 4 + i * 24); }
  if (ch.Inst !== undefined) { const I = ch.Inst; add(I + 8); add(I + 4); const c = add(I + 0xc); add(c + 4); const H = add(I + 0x10); add(H + 4); add(H + 8); add(H + 0xc); if (u32(H + 0x10)) add(H + 0x10); }
  if (ch.Rint !== undefined) { const R = ch.Rint, l = add(R + 4); for (let i = 0; i < u32(R); i++) { const r = l + i * 0x40; for (let k = 0; k < 4; k++) if (u32(r + 0x20 + k * 4)) add(r + 0x30 + k * 4); } for (let i = 0; i < u32(R + 8); i++) add(R + 0xc + i * 4); }
  if (ch.Lite !== undefined) { const Li = ch.Lite; add(Li + 4); add(Li + 0xc); }
  return P;
}

// Moves the chunks apart (each keeps its alignment within 4 KB) and fixes every pointer: the core of the writer.
export function relayoutTMdl(a, gap = 0x1000) {
  const ptrs = tmdlPointers(a), ch = [];
  for (let k = 0; k < 32; k++) { const o = 0x10 + k * 16, tag = a.toString("latin1", o, o + 4); if (!/^[A-Za-z]{4}$/.test(tag)) break; ch.push({ k, tag, off: a.readUInt32LE(o + 4), size: a.readUInt32LE(o + 8) }); }
  const sorted = [...ch].sort((x, y) => x.off - y.off); let p = sorted[0].off;
  for (const c of sorted) { p += gap; p = p - (p & 0xfff) + (c.off & 0xfff) + ((p & 0xfff) > (c.off & 0xfff) ? 0x1000 : 0); c.noff = p; p += c.size; }
  const total = (p + 15) & ~15, b = Buffer.alloc(total); a.copy(b, 0, 0, sorted[0].off);
  for (const c of sorted) a.copy(b, c.noff, c.off, c.off + c.size);
  b.writeUInt32LE(total, 4);
  const map = o => { const c = ch.find(c => o >= c.off && o < c.off + c.size) ?? ch.find(c => o === c.off + c.size); return c ? o - c.off + c.noff : o; };
  for (const o of ptrs) b.writeUInt32LE(map(a.readUInt32LE(o)), map(o));
  return b;
}

function load(file, entry) { const b = readFileSync(file); if (isTerf(b)) { const t = parseTerf(b); return t.entry(+(entry ?? 0)); } return b; }

if (process.argv[1] && basename(process.argv[1]) === "tmdl.mjs") {
  const [cmd, file, ...rest] = process.argv.slice(2);
  if (!cmd || !file) { console.log("usage: node tmdl.mjs info <TK_REND.DAT|file> [entry]\n       node tmdl.mjs gltf <TK_REND.DAT|file> [entry] <outDir> [--all-lods]"); process.exit(1); }
  const args = rest.filter(a => !a.startsWith("--")), entry = /^\d+$/.test(args[0] ?? "") ? args.shift() : undefined;
  const m = parseTMdl(load(file, entry));
  if (cmd === "info") {
    console.log(`${m.name}: chunks ${Object.keys(m.chunks).join(" ")}; ${m.draws.length} draws, ${m.vbs.length} vertex buffers, ${m.materials.length} materials, ${m.textures.length} textures, ${m.pieceNames.length} piece names`);
    const kinds = new Map(); for (const n of m.pieceNames) { const k = n.replace(/_LOD_.*$/, "").replace(/^[A-Za-z]+_/, "").replace(/\d+$/, ""); kinds.set(k, (kinds.get(k) ?? 0) + 1); }
    console.log("pieces:", [...kinds].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, n]) => `${k} ${n}`).join(", "));
  } else if (cmd === "relayout") { const src = load(file, entry), out = relayoutTMdl(src); writeFileSync(args[0] ?? "relaid.tmdl", out); console.log(`wrote ${args[0] ?? "relaid.tmdl"}: ${src.length} -> ${out.length} bytes, ${tmdlPointers(src).size} pointers moved`);
  } else if (cmd === "gltf") {
    const out = args[0] ?? "track_gltf"; const r = exportGLTF(m, out, { allLods: rest.includes("--all-lods"), name: (m.name || "track").replace(/\.ea3$/i, "").replace(/[^\w-]/g, "_") });
    console.log(`wrote ${out}: ${r.meshes} meshes, ${r.triangles} triangles, ${r.textures} textures`);
  }
}
