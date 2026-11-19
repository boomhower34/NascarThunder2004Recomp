// nr2003-3do.mjs — Papyrus NR2003 .3do models -> triangle meshes (metres, z up, as the .ptf).
//
// A .3do is the same object stream as the .ptf: per object u32 object id (rising through the file), u32 class id,
// and the first time a class appears u32 name length + its name. Objects nest in file order (a tree written
// depth first). Container nodes end with their child list, u32 byte count (4 per child) followed by the children:
//   StateSwitchDescriptor  (name, the state variable "Population" / "Weekend", thresholds, children: one per state)
//   LodSwitchDescriptor    (distances, children: most detailed first; the last is often an EmptyDescriptor)
//   GroupDescriptor, TransformDescriptor / AnimatedTransformDescriptor (only the animated flagmen use these)
// Leaves:
//   ShapeDescriptor        name, then its AppearanceDescriptor (-> TextureDescriptor: u32 1, u32 0, u32 1, the .mip
//                          name as u32 length + text, then material colours) and its GeometryDescriptor (->
//                          PlainVertexListDescriptor + TriListDescriptor or TriStripDescriptor)
//   PlainVertexListDescriptor  u32 1, 0, 1, 1, vertex count N, then lists of N doubles, each led by its byte count
//                          (8N): x, y, z; a u32; nx, ny, nz; a u32; u, v
//   TriListDescriptor      u32 1, 0, 1, 0, 1, index count n, byte count 4n, n u32 indices (triangles; both sides
//                          are written out where a face is two sided)
//   TriStripDescriptor     the same with one strip
// Only the first child of each switch is kept (the most detailed level, the first state).
//
// usage: import { read3do } from "./nr2003-3do.mjs"; read3do(buf) -> [{ texture, positions: [[x,y,z]], uvs: [[u,v]], indices }]
//        node nr2003-3do.mjs <file.3do>    (a summary)

import { readFileSync } from "node:fs";
import { basename } from "node:path";

const CONTAINERS = new Set(["StateSwitchDescriptor", "LodSwitchDescriptor", "GroupDescriptor", "TransformDescriptor", "AnimatedTransformDescriptor"]);
const SWITCHES = new Set(["StateSwitchDescriptor", "LodSwitchDescriptor"]);

// every object header in file order: { oid, cls, at (header start), body (first byte after the header) }
export function objectHeaders(b) {
  const names = new Map(), heads = []; let last = 0, p = 0;
  while (p + 8 <= b.length) {
    let found = -1;
    for (let q = p; q + 8 <= b.length; q++) {
      const oid = b.readUInt32LE(q); if (oid <= last || oid > last + 16) continue;
      const cid = b.readUInt32LE(q + 4); if (cid === 0 || cid > 4096) continue;
      if (names.has(cid)) { found = q; break; }
      const n = q + 12 <= b.length ? b.readUInt32LE(q + 8) : 0;
      if (n > 4 && n < 64 && q + 12 + n <= b.length && b[q + 11 + n] === 0 && /^[A-Z]\w+Descriptor$/.test(b.toString("latin1", q + 12, q + 11 + n))) { names.set(cid, b.toString("latin1", q + 12, q + 11 + n)); found = q; break; }
    }
    if (found < 0) break;
    const oid = b.readUInt32LE(found), cid = b.readUInt32LE(found + 4), named = heads.every(h => h.cid !== cid);
    const body = found + 8 + (named ? 4 + b.readUInt32LE(found + 8) : 0);
    const cls = names.get(cid); heads.push({ oid, cid, cls, at: found, body }); last = oid; p = body;
    p = skipPayload(b, cls, body);                   // (index and vertex data can look like headers)
  }
  return heads;
}

function skipPayload(b, cls, p) {
  try {
    if (cls === "PlainVertexListDescriptor") { const n = b.readUInt32LE(p + 16); let q = p + 20, lists = 0;
      for (let k = 0; k < 16 && q + 4 <= b.length; k++) { if (b.readUInt32LE(q) === 8 * n && n) { q += 4 + 8 * n; lists++; } else if (lists >= 8) break; else q += 4; }
      return q; }
    if (cls === "TriListDescriptor" || cls === "TriStripDescriptor") { for (let q = p; q < p + 64; q += 4) { const n = b.readUInt32LE(q); if (n && b.readUInt32LE(q + 4) === 4 * n) return q + 8 + 4 * n; } }
  } catch {}
  return p;
}
function doubleLists(b, from, to, n) {           // the runs "u32 8n, n doubles" between two offsets
  const lists = []; let p = from;
  while (p + 4 <= to) { if (n > 0 && b.readUInt32LE(p) === 8 * n && p + 4 + 8 * n <= to) { const l = []; for (let k = 0; k < n; k++) l.push(b.readDoubleLE(p + 4 + 8 * k)); lists.push(l); p += 4 + 8 * n; } else p += 4; }
  return lists;
}
function indexList(b, from, to) {                 // "u32 n, u32 4n, n u32"
  for (let p = from; p + 8 <= to; p++) { const n = b.readUInt32LE(p); if (n > 0 && n < 1e6 && b.readUInt32LE(p + 4) === 4 * n && p + 8 + 4 * n <= to) { const ix = []; for (let k = 0; k < n; k++) ix.push(b.readUInt32LE(p + 8 + 4 * k)); return ix; } }
  return [];
}
function textureName(b, from, to) {
  for (let p = from; p + 4 <= to; p++) { const n = b.readUInt32LE(p); if (n > 4 && n < 64 && p + 4 + n <= to && b[p + 3 + n] === 0) { const s = b.toString("latin1", p + 4, p + 3 + n); if (/^[\w\\. -]+\.mip$/i.test(s)) return s; } }
  return null;
}

export function read3do(b) {
  const H = objectHeaders(b), end = i => i + 1 < H.length ? H[i + 1].at : b.length, meshes = [];
  // preorder walk: returns the index after the subtree at i; keep = whether its geometry is used
  const walk = (i, keep) => {
    const h = H[i]; if (!h) return i + 1;
    if (CONTAINERS.has(h.cls)) {
      if (i + 1 >= H.length) return i + 1;
      const bc = b.readUInt32LE(H[i + 1].at - 4), n = bc % 4 === 0 && bc >= 4 && bc <= 4 * 256 ? bc / 4 : 1;
      let j = i + 1; for (let c = 0; c < n && j < H.length; c++) j = walk(j, keep && (c === 0 || !SWITCHES.has(h.cls)));
      return j;
    }
    if (h.cls === "ShapeDescriptor") {                 // Appearance, Texture..., Geometry, vertex list, primitive(s)
      let j = i + 1, tex = null, verts = null; const tris = [];
      for (; j < H.length; j++) {
        const c = H[j].cls;
        if (c === "TextureDescriptor") tex = textureName(b, H[j].body, end(j)) ?? tex;
        else if (c === "PlainVertexListDescriptor") { const n = b.readUInt32LE(H[j].body + 16); verts = { n, lists: doubleLists(b, H[j].body + 20, end(j), n) }; }
        else if (c === "TriListDescriptor") tris.push(...indexList(b, H[j].body, end(j)));
        else if (c === "TriStripDescriptor") { const idx = indexList(b, H[j].body, end(j));   // (a strip may only wrap the next primitive: no indices of its own)
          for (let k = 2; k < idx.length; k++) { const t = k % 2 ? [idx[k - 1], idx[k - 2], idx[k]] : [idx[k - 2], idx[k - 1], idx[k]]; if (t[0] !== t[1] && t[1] !== t[2] && t[0] !== t[2]) tris.push(...t); } }
        else if (c !== "AppearanceDescriptor" && c !== "GeometryDescriptor") break;
      }
      if (keep && verts && tris.length && verts.lists.length >= 3) {
        const L = verts.lists, positions = [], uvs = [];
        for (let k = 0; k < verts.n; k++) { positions.push([L[0][k], L[1][k], L[2][k]]); uvs.push(L.length >= 8 ? [L[6][k], L[7][k]] : [0, 0]); }
        const indices = tris.slice(0, tris.length - (tris.length % 3));
        if (indices.every(v => v < verts.n)) meshes.push({ texture: tex, positions, uvs, indices });
      }
      return j;
    }
    return i + 1;                                      // Empty, or anything unknown
  };
  for (let i = 0; i < H.length;) i = walk(i, true);
  return meshes;
}

if (process.argv[1] && basename(process.argv[1]) === "nr2003-3do.mjs") {
  const f = process.argv[2]; if (!f) { console.log("usage: node nr2003-3do.mjs <file.3do>"); process.exit(1); }
  const b = readFileSync(f), H = objectHeaders(b), M = read3do(b);
  console.log(`${H.length} objects (${[...new Set(H.map(h => h.cls))].join(", ")}); ${M.length} meshes kept`);
  for (const m of M) { const lo = [0, 1, 2].map(a => Math.min(...m.positions.map(p => p[a])).toFixed(1)), hi = [0, 1, 2].map(a => Math.max(...m.positions.map(p => p[a])).toFixed(1));
    console.log(`  ${m.texture ?? "(no texture)"}: ${m.positions.length} verts, ${m.indices.length / 3} tris, box [${lo}]..[${hi}]`); }
}
