// objects-export.mjs — a library of track-side objects as .glb files, to place in a track's scenery in Blender
// (File > Import > glTF 2.0, then move / duplicate it; Alt+D duplicates are drawn as one repeated object):
//
//   game:   the named objects of one of the game's track models (TK_REND: light poles, pit tower and pit banners,
//           grandstands, signs, buildings ...), each in its own file, standing on its own origin (centred, its
//           lowest point at 0), metres, Y up, with its colour texture. Exported on this computer from the user's
//           own copy of the game: nothing of it is shipped.
//   nr2003: NR2003 objects (.3do with their .mip textures) from folders on this computer: a track folder (its .dat
//           archive), NR2003's shared objects folders, or loose files. NR2003 draws pit stalls, stall boxes and some
//           trackside props from shared files, so these are the ones a converted track misses.
//
// usage: import { exportGameObjects, exportNR2003Objects } from "./objects-export.mjs";
//        exportGameObjects(dataDir, slot, outDir, { log, repeatedOnly }) -> [{ name, file, triangles, placements }]
//        exportNR2003Objects([folder...], outDir, { log }) -> [{ name, file, triangles }]
// CLI:   node objects-export.mjs game <Data> <slot> <outDir> | nr2003 <outDir> <folder>...

import { writeFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { parseTMdl, drawTriangles, textureRGBA } from "./tmdl.mjs";
import { rendEntry } from "./track-pack.mjs";
import { encodePNG } from "./mmap-tex.mjs";
import { GLB } from "./gltf-write.mjs";

const safe = s => String(s).replace(/Shape$/i, "").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "object";
// shift a flat [x, y, z] list (glTF metres, Y up) so it stands on the origin
function standOnOrigin(lists) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const P of lists) for (let i = 0; i < P.length; i++) { lo[i % 3] = Math.min(lo[i % 3], P[i]); hi[i % 3] = Math.max(hi[i % 3], P[i]); }
  const o = [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2];
  for (const P of lists) for (let i = 0; i < P.length; i++) P[i] -= o[i % 3];
  return { size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], origin: o };
}

export function exportGameObjects(data, slot, outDir, { log = () => {}, repeatedOnly = false } = {}) {
  const a = rendEntry(data, slot); if (!a) throw new Error(`no track model ${slot}`);
  const m = parseTMdl(a), f = o => a.readFloatLE(o), track = safe(m.name.replace(/\.(e(a3?)?)?$/i, "")), dir = join(outDir, track);
  mkdirSync(dir, { recursive: true });
  const placements = new Map(); for (const p of m.placements) placements.set(p.draw, (placements.get(p.draw) ?? 0) + 1);
  // objects by name: the artist's names are "<object>Shape<n>" with "_<material>" for each further material part and
  // "_1", "_2" ... for copies placed elsewhere (16 x "PitBanner_S2Shape"): one file per object, its first copy, all its
  // parts; generic names (polySurface, pCube ...) and the track's own surface pieces (Lowes_base_..._LOD) left out
  const JUNK = /^(polySurface|pCube|pPlane|pCylinder|pSphere|nurbs|Blendstrip|transform|loftedSurface)|_base_.*(Surface|Trim)|Surface_LOD/i;
  const groups = new Map(), copies = new Map();
  for (const d of m.draws) { if (!d.name || JUNK.test(d.name)) continue; const copy = +(d.name.match(/_(\d+)$/)?.[1] ?? 0), stem = d.name.replace(/(_\d+)+$/, ""), key = stem.match(/^(.*?Shape\d*)(?=_|$)/)?.[1] ?? stem;
    copies.set(key, Math.max(copies.get(key) ?? 0, copy + 1)); if (copy) continue; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(d); }
  const texCache = new Map(), png = ti => { if (!texCache.has(ti)) { let r = null; try { const img = textureRGBA(m, m.textures[ti]); if (img) { let alpha = false; for (let i = 3; i < img.rgba.length && !alpha; i += 4) alpha = img.rgba[i] < 250; r = { png: encodePNG(img.width, img.height, img.rgba), alpha }; } } catch {} texCache.set(ti, r); } return texCache.get(ti); };
  const out = [], used = new Set();
  for (const [name, draws] of groups) {
    const places = Math.max(copies.get(name) ?? 1, ...draws.map(d => placements.get(d.index) ?? 0)); if (repeatedOnly && places < 2) continue;
    const G = new GLB(`objects-export.mjs (${m.name})`), prims = [];
    for (const d of draws) { const vb = m.vbs[d.vb]; if (!vb || vb.stride < 32) continue; const tris = drawTriangles(m, d); if (!tris.length) continue;
      const map = new Map(), P = [], U = [], C = [], I = [];
      for (const i of tris) { if (!map.has(i)) { map.set(i, map.size); const o = vb.data + i * vb.stride; P.push(f(o) / 100, f(o + 4) / 100, f(o + 8) / 100); U.push(f(o + 28), f(o + 32)); C.push(a[o + 26] / 255, a[o + 25] / 255, a[o + 24] / 255, a[o + 27] / 255); } I.push(map.get(i)); }
      const mt = m.materials[d.material], layers = (mt?.textures ?? []).map((ti, j) => ti >= 0 ? { ti, n: mt.textureNames[j] } : null).filter(Boolean);
      const main = layers.find(x => /color|colour/i.test(x.n)) ?? layers.find(x => !/grime|crack|dynstretch|detail/i.test(x.n)) ?? layers[0], t = main && png(main.ti);
      // (the material keeps the game's name: PITBANNER_nnn marks a pit banner, a stall's sign)
      prims.push({ positions: P, uvs: U, colors: C, indices: I, material: G.material(mt ? mt.name.replace(/^\d+/, "") : "material", t ? { png: t.png, alpha: t.alpha } : { color: [0.7, 0.7, 0.7, 1] }) }); }
    if (!prims.length) continue;
    const box = standOnOrigin(prims.map(p => p.positions)), mesh = G.mesh(name, prims); G.node({ name: safe(name), mesh });
    G.extras = { source: { game: m.name, object: name, placements: places, size: box.size.map(v => +v.toFixed(2)) } };
    let file = safe(name); while (used.has(file.toLowerCase())) file += "_"; used.add(file.toLowerCase());
    writeFileSync(join(dir, `${file}.glb`), G.glb());
    out.push({ name, file: `${track}/${file}.glb`, triangles: prims.reduce((s, p) => s + p.indices.length / 3, 0), placements: places, size: box.size.map(v => +v.toFixed(1)) });
  }
  writeFileSync(join(dir, "index.json"), JSON.stringify({ source: m.name, slot, objects: out }, null, 2));
  log(`${m.name}: ${out.length} objects -> ${dir}`);
  return out;
}

export async function exportNR2003Objects(folders, outDir, { log = () => {} } = {}) {
  const { read3do } = await import("./nr2003-3do.mjs"), { readMip, pngOf } = await import("./nr2003-mip.mjs"), { assetSource } = await import("./nr2003-track.mjs"), { readDat } = await import("./nr2003-dat.mjs");
  const src = assetSource(null, folders), models = new Map();
  // every .3do: loose files and the archives' entries
  const walk = (d, depth) => { let ents = []; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) { const p = join(d, e.name); if (e.isDirectory()) { if (depth < 4) walk(p, depth + 1); }
      else if (/\.3do$/i.test(e.name)) models.set(e.name.toLowerCase(), e.name);
      else if (/\.dat$/i.test(e.name)) try { for (const x of readDat(readFileSync(p)).entries) if (/\.3do$/i.test(x.name)) models.set(x.name.replace(/^.*[\\/]/, "").toLowerCase(), x.name); } catch {} } };
  for (const d of folders) walk(d, 0);
  const dir = join(outDir, "nr2003"); mkdirSync(dir, { recursive: true }); const out = [], texCache = new Map();
  const tex = n => { const k = (n ?? "").toLowerCase(); if (!texCache.has(k)) { let r = null; const b = n ? src.get(n.replace(/^.*\\/, "")) ?? src.get(n) : null; if (b) try { const mp = readMip(b); r = { png: pngOf(mp), alpha: mp.hasAlpha }; } catch {} texCache.set(k, r); } return texCache.get(k); };
  for (const [, name] of [...models].sort()) {
    const buf = src.get(name); if (!buf) continue; let parts = []; try { parts = read3do(buf).filter(p => p.indices.length); } catch { continue; } if (!parts.length) continue;
    const G = new GLB("objects-export.mjs (NR2003)"), prims = parts.map(p => { const t = tex(p.texture); return { positions: p.positions.flatMap(v => [v[0], v[2], -v[1]]), uvs: p.uvs.flat(), indices: p.indices, material: G.material(basename(String(p.texture ?? "untextured").replace(/\\/g, "/")).replace(/\.mip$/i, ""), t ?? { color: [0.7, 0.7, 0.7, 1] }) }; });
    const box = standOnOrigin(prims.map(p => p.positions)), file = safe(name.replace(/^.*[\\/]/, "").replace(/\.3do$/i, ""));
    G.node({ name: file, mesh: G.mesh(file, prims) }); G.extras = { source: { nr2003: name, size: box.size.map(v => +v.toFixed(2)) } };
    writeFileSync(join(dir, `${file}.glb`), G.glb()); out.push({ name, file: `nr2003/${file}.glb`, triangles: prims.reduce((s, p) => s + p.indices.length / 3, 0), size: box.size.map(v => +v.toFixed(1)) });
  }
  writeFileSync(join(dir, "index.json"), JSON.stringify({ folders, objects: out }, null, 2));
  log(`NR2003: ${out.length} objects -> ${dir}`);
  return out;
}

if (process.argv[1] && basename(process.argv[1]) === "objects-export.mjs") {
  const [cmd, ...a] = process.argv.slice(2);
  if (cmd === "game") exportGameObjects(a[0], +a[1], a[2], { log: console.log, repeatedOnly: a.includes("--repeated") });
  else if (cmd === "nr2003") await exportNR2003Objects(a.slice(1), a[0], { log: console.log });
  else console.log("usage: node objects-export.mjs game <Data folder> <track model slot> <output folder> [--repeated]\n       node objects-export.mjs nr2003 <output folder> <folder with .3do / .dat files>...");
}
