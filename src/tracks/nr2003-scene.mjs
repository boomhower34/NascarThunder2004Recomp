// nr2003-scene.mjs — an NR2003 track's scenery (nr2003-gltf.mjs writes it as <id>_scenery.glb).
//
// NR2003 builds the racing surface itself from the .ptf and places everything else as track-side objects:
//   - surfaces: per segment, the F sections across the track (asphalt, paint lines, apron, grass, ...), each from its
//     dlat to the next one's, the last out to the outermost height knot (or 10 m), heights from the X section knots
//     (the same knots the layout uses, so the drawn road sits on the physics road), textured in metres (8 m tiles
//     across; a strip under 1.5 m wide, a painted line, takes the texture once across);
//   - walls: per W section a vertical face (both sides) of its height on the ground at its dlat (armco, concrete,
//     catch fence);
//   - track-side objects (.ptf TSOReferenceDescriptor): a .3do from the track's archive at x, y, z, heading. Objects
//     the archive does not have (NR2003's shared objects: lights, cones) are left out.
// Frames: NR2003 metres (x, y, z up) -> glTF metres (x, z, -y), which track-pack / trackwarp read as feet
// (x / 0.3048, -z / 0.3048) = the layout's points (nr2003-track.mjs layoutFromPTF), so model and physics line up.
//
// usage: import { buildNR2003Scene } from "./nr2003-scene.mjs"; buildNR2003Scene(readNR2003(dir), { roadTone, log })
//        -> { bucket (baked surfaces / walls per material), meshes (.3do models), nodes (placements), mats }

import { writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { readMip, pngOf } from "./nr2003-mip.mjs";
import { read3do } from "./nr2003-3do.mjs";

const TYPE_TEX = { 1: "asphalt.mip", 2: "concrete.mip", 3: "paint.mip", 4: "grass.mip", 5: "sand.mip" };

function pointAt(seg, t) {
  if (!seg.dh) return [seg.x0 + (seg.x1 - seg.x0) * t, seg.y0 + (seg.y1 - seg.y0) * t, seg.h0];
  const R = seg.radius, cx = seg.x0 - Math.sin(seg.h0) * R, cy = seg.y0 + Math.cos(seg.h0) * R, h = seg.h0 + seg.dh * t;
  return [cx + Math.sin(h) * R, cy - Math.cos(h) * R, h];
}
const hermite = (a, b, ma, mb, t) => { const t2 = t * t, t3 = t2 * t; return (2 * t3 - 3 * t2 + 1) * a + (t3 - 2 * t2 + t) * ma + (-2 * t3 + 3 * t2) * b + (t3 - t2) * mb; };

export function buildNR2003Scene(T, { step = 4, log = () => {}, roadTone = 135 } = {}) {
  const { ptf, dat } = T, mats = new Map(), meshes = [], nodes = [];
  // ---- textures / materials by .mip name
  const texInfo = new Map();
  // road: NR2003 draws the racing surface darker than its texture (Milwaukee's Asphalt.mip averages 224 of 255, nearly
  // white as it is; Wilkesboro's 162, which looks right): a road texture brighter than 180 is scaled to roadTone (mean brightness; false
  // keeps it as it is)
  const texture = (name, road = false) => {
    const key = (name ?? "").toLowerCase() + (road ? "|road" : ""); if (texInfo.has(key)) return texInfo.get(key);
    let info = null; const buf = name && dat ? dat.get(name.replace(/^.*\\/, "")) ?? dat.get(name) : null;
    if (buf) try { const m = readMip(buf); let nm = basename(name.replace(/\\/g, "/")).replace(/\.mip$/i, "");
      if (road && roadTone) { const n = m.width * m.height; let L = 0; for (let i = 0; i < n; i++) L += 0.3 * m.rgba[i * 4] + 0.59 * m.rgba[i * 4 + 1] + 0.11 * m.rgba[i * 4 + 2]; L /= n;
        if (L > 180) { const k = roadTone / L, rgba = Uint8Array.from(m.rgba); for (let i = 0; i < n * 4; i++) if ((i & 3) !== 3) rgba[i] = Math.round(rgba[i] * k); m.rgba = rgba; nm += "_road"; log(`road texture ${name}: brightness ${L.toFixed(0)} -> ${roadTone}`); } }
      info = { name: nm, png: pngOf(m), w: m.width, h: m.height, alpha: m.hasAlpha }; } catch (e) { log(`texture ${name}: ${e.message}`); }
    texInfo.set(key, info); return info;
  };
  const material = (name, road) => { const t = texture(name, road), key = t ? t.name.toLowerCase() : "(none)"; if (!mats.has(key)) mats.set(key, { tex: t, index: mats.size }); return mats.get(key); };
  // ---- geometry buckets (per material) for the baked part
  const bucket = new Map(), add = (mat, quadPts, uvs) => {
    if (!bucket.has(mat.index)) bucket.set(mat.index, { mat, pos: [], uv: [], idx: [] }); const B = bucket.get(mat.index), b0 = B.pos.length / 3;
    for (const p of quadPts) B.pos.push(p[0], p[2], -p[1]); for (const u of uvs) B.uv.push(u[0], u[1]);
    B.idx.push(b0, b0 + 1, b0 + 2, b0, b0 + 2, b0 + 3);
  };
  // ---- surfaces and walls along each segment
  let s0 = 0, lastTex = {}, nQuads = 0;
  for (const seg of ptf.segments) {
    const n = Math.max(1, Math.ceil(seg.length / step)), outer = Math.max(...seg.lines.flatMap(l => l.dlat), -Infinity);
    const sample = t => { const [x, y, h] = pointAt(seg, t), at = v => v[0] + (v[1] - v[0]) * t;
      const K = seg.lines.map(l => ({ d: at(l.dlat), z: hermite(l.z[0], l.z[1], l.dz[0] * seg.length, l.dz[1] * seg.length, t) })).sort((a, b) => a.d - b.d);
      const zAt = d => { if (!K.length) return 0; if (d <= K[0].d) return K[0].z; for (let j = 1; j < K.length; j++) if (d <= K[j].d) return K[j - 1].z + (K[j].z - K[j - 1].z) * (d - K[j - 1].d) / ((K[j].d - K[j - 1].d) || 1); return K.at(-1).z; };
      const nx = -Math.sin(h), ny = Math.cos(h), P = d => [x + nx * d, y + ny * d, zAt(d)];
      return { at, K, P, zAt, s: s0 + seg.length * t };
    };
    const S = []; for (let k = 0; k <= n; k++) S.push(sample(k / n));
    const F = seg.surfaceInfo.map(f => ({ ...f, tex: f.texture ?? lastTex[f.type] ?? TYPE_TEX[f.type] ?? null }));
    F.forEach(f => { if (f.texture) lastTex[f.type] = f.texture; });
    F.forEach((f, i) => {
      const mat = material(f.tex, (f.type === 1 || f.type === 2) && /asph/i.test(f.tex ?? "")), tw = 8, th = mat.tex ? 8 * mat.tex.h / mat.tex.w : 8;
      for (let k = 0; k < n; k++) {
        const A = S[k], B = S[k + 1], dA = [A.at(f.dlat), i + 1 < F.length ? A.at(F[i + 1].dlat) : Math.max(A.at(f.dlat) + 10, Number.isFinite(outer) ? outer : 0)], dB = [B.at(f.dlat), i + 1 < F.length ? B.at(F[i + 1].dlat) : Math.max(B.at(f.dlat) + 10, Number.isFinite(outer) ? outer : 0)];
        if (dA[1] - dA[0] < 0.01 && dB[1] - dB[0] < 0.01) continue;
        // cut across at the height knots inside the strip (the profile is piecewise linear between them)
        const cuts = [0, ...A.K.map(q => q.d).filter(d => d > dA[0] + 0.05 && d < dA[1] - 0.05).map(d => (d - dA[0]) / (dA[1] - dA[0])), 1];
        const narrow = dA[1] - dA[0] < 1.5;
        for (let c = 0; c + 1 < cuts.length; c++) {
          const u0 = cuts[c], u1 = cuts[c + 1], dd = (D, u) => D[0] + (D[1] - D[0]) * u;
          const p = [A.P(dd(dA, u0)), A.P(dd(dA, u1)), B.P(dd(dB, u1)), B.P(dd(dB, u0))];
          const uu = (D, u) => narrow ? u : dd(D, u) / tw;
          add(mat, p, [[uu(dA, u0), A.s / th], [uu(dA, u1), A.s / th], [uu(dB, u1), B.s / th], [uu(dB, u0), B.s / th]]); nQuads++;
        }
      }
    });
    for (const w of seg.wallInfo) {
      const mat = material(w.texture ?? "wall.mip"), hgt = t => w.height[0] + (w.height[1] - w.height[0]) * t;
      for (let k = 0; k < n; k++) {
        const A = S[k], B = S[k + 1], ta = k / n, tb = (k + 1) / n, a = A.P(A.at(w.dlat)), b = B.P(B.at(w.dlat)), ha = hgt(ta), hb = hgt(tb); if (ha <= 0 && hb <= 0) continue;
        const aw = mat.tex ? mat.tex.w / mat.tex.h : 4, ua = A.s / (Math.max(ha, 0.2) * aw), ub = B.s / (Math.max(hb, 0.2) * aw);
        const q = [[a[0], a[1], a[2] + ha], [b[0], b[1], b[2] + hb], [b[0], b[1], b[2]], [a[0], a[1], a[2]]];
        add(mat, q, [[ua, 0], [ub, 0], [ub, 1], [ua, 1]]); add(mat, [q[1], q[0], q[3], q[2]], [[ub, 0], [ua, 0], [ua, 1], [ub, 1]]); nQuads += 2;
      }
    }
    s0 += seg.length;
  }
  // ---- track-side objects: one glTF mesh per .3do (a primitive per texture), a node per placement
  const models = new Map(); let missing = new Set(), unread = new Set(), placed = 0;
  for (const o of T.tsos ?? []) {
    if (!models.has(o.model.toLowerCase())) {
      const buf = dat?.get(o.model); let mesh = null;
      if (buf) { let parts = []; try { parts = read3do(buf).filter(m => m.indices.length); } catch {} if (parts.length) mesh = { name: o.model.replace(/\.3do$/i, ""), parts: parts.map(p => ({ ...p, mat: material(p.texture) })) }; else unread.add(o.model); }
      if (mesh) { meshes.push(mesh); mesh.index = meshes.length - 1; }
      models.set(o.model.toLowerCase(), mesh);
    }
    const m = models.get(o.model.toLowerCase()); if (!m) { if (!unread.has(o.model)) missing.add(o.model); continue; }
    nodes.push({ mesh: m.index, name: m.name, translation: [o.x, o.z, -o.y], rotation: [0, Math.sin(o.heading / 2), 0, Math.cos(o.heading / 2)] }); placed++;
  }
  log(`surfaces and walls: ${nQuads} quads; objects: ${placed} placed (${meshes.length} models)${missing.size ? `; not in the archive (left out): ${[...missing].join(", ")}` : ""}${unread.size ? `; no geometry read from: ${[...unread].join(", ")}` : ""}`);
  return { bucket, meshes, nodes, mats, missing: [...missing] };
}
