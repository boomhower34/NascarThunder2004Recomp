// tmdl-build.mjs — writes a TMdl track model from scratch (pieces of geometry, materials, textures), the format
// the game reads from TK_REND.DAT (see tmdl.mjs for the layout). A few blocks the game needs but that carry no
// geometry is taken from a template model of the game (Lite: lighting).
//
//   buildTMdl({ name, pieces, materials, textures }, template) -> Buffer
//     pieces:    [{ name, material, positions: [x,y,z]..., normals, colors: [r,g,b,a] 0..255, uvs: [u,v],
//                   strip: [indices] (one triangle strip) | triangles: [indices],
//                   placements?: [{ name?, t: [x,y,z], r: [x,y,z] degrees (rotated x, then y, then z), s: [x,y,z] }] }]
//                (centimetres, y up; a piece with placements is drawn once per placement, e.g. fence posts)
//     materials: [{ name, shader?, textures: [texture index], group? }]
//                the game's material types (shader names): "1P_BT" one texture (default), "MP_BT" base + a second
//                layer (fences: chain link + posts), "MP_DBT" detail layers over a base (track: grime, cracks,
//                stretch, colour), "MP_EBT", "FL_BT", "1P_LBT"; textures in the order the type expects (as the game's
//                own materials list them), each with its own uv offset / scale
//     textures:  [{ name, width, height, rgba, offset?: [u, v], scale?: [u, v] }]      (power-of-two sizes)
//
// What the game does with the generated organising blocks (worked out from 0xF2350 / 0xF2240 / 0xF21D0):
//   Inst  instances, each a range of "subs" (16 bytes: runtime words, per-view visibility bytes at +4, draw index
//         at +12); every frame all subs are hidden, then the Rint walk shows the ones it reaches.
//   Rint  render nodes (0x40 bytes: bbox min/max, four LOD lists by distance: count +0x20, list +0x30 of
//         (u16 instance, u16 sub within it)) and a tree of cells (bbox, count, entries (child cell, 0xFFFF) or
//         (1, node)); here: one node per piece, one cell holding them all.
//   Swap  texture-swap sets (pit banners): none. Fade: one u32 per instance, zero.
import { encodePNG } from "./mmap-tex.mjs";
import { nodeMatrix } from "./tmdl.mjs";

const swizzleTables = (w, h) => { const xs = new Uint32Array(w), ys = new Uint32Array(h); let bit = 1, xb = 1, yb = 1;
  while (xb < w || yb < h) { if (xb < w) { for (let x = 0; x < w; x++) if (x & xb) xs[x] |= bit; bit <<= 1; xb <<= 1; } if (yb < h) { for (let y = 0; y < h; y++) if (y & yb) ys[y] |= bit; bit <<= 1; yb <<= 1; } }
  return { xs, ys }; };
const half = (rgba, w, h) => { const W = Math.max(1, w >> 1), H = Math.max(1, h >> 1), o = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 4; c++) { let s = 0, n = 0; for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) { const sx = Math.min(w - 1, x * 2 + dx), sy = Math.min(h - 1, y * 2 + dy); s += rgba[(sy * w + sx) * 4 + c]; n++; } o[(y * W + x) * 4 + c] = Math.round(s / n); }
  return { rgba: o, width: W, height: H }; };

// The Text chunk: an MMAP (version 2) of A8R8G8B8 swizzled textures with mip chains, no palettes.
function buildTextMMAP(textures) {
  const imgs = []; const tex = textures.map(t => { const first = imgs.length; let cur = { rgba: t.rgba, width: t.width, height: t.height }; let n = 0;
    while (true) { imgs.push(cur); n++; if ((cur.width <= 4 && cur.height <= 4) || n >= 8) break; cur = half(cur.rgba, cur.width, cur.height); } return { first, mips: n }; });
  // laid out like the game's files (TK_SHAD entries): header, image table, image data, then the names (16 bytes
  // each) and right after them the texture table; texture entries start with 1. (An earlier layout with the texture
  // table and names before the data left the materials naming two of three textures without a texture.)
  const nT = textures.length, nI = imgs.length;
  let dataStart = (0x28 + nI * 16 + 0x7f) & ~0x7f; const offs = []; let p = dataStart;
  for (const im of imgs) { offs.push(p); p += im.width * im.height * 4; p = (p + 0x7f) & ~0x7f; }
  const names = (p + 15) & ~15, texTab = names + nT * 16; p = (texTab + nT * 12 + 0x7f) & ~0x7f;
  const b = Buffer.alloc(p);
  b.write("MMAP", 0, "latin1"); b.writeUInt32LE(2, 4); b.set([0, 1, 2, 3], 8); b.writeUInt16LE(nT, 0x0c); b.writeUInt16LE(nI, 0x0e); b.writeUInt32LE(0, 0x10);   // (no palettes)
  b.writeUInt32LE(texTab, 0x14); b.writeUInt32LE(0x28, 0x18); b.writeUInt32LE(0, 0x1c); b.writeUInt32LE(names, 0x20);
  imgs.forEach((im, k) => { const h = 0x28 + k * 16; b.writeUInt16LE(im.width, h); b.writeUInt16LE(im.height, h + 2); b.writeUInt32LE(0x06, h + 4); b.writeUInt32LE(im.width * im.height * 4, h + 8); b.writeUInt32LE(offs[k] - 0x80, h + 12);
    const { xs, ys } = swizzleTables(im.width, im.height); for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) { const s = (y * im.width + x) * 4, d = offs[k] + (xs[x] | ys[y]) * 4; b[d] = im.rgba[s + 2]; b[d + 1] = im.rgba[s + 1]; b[d + 2] = im.rgba[s]; b[d + 3] = im.rgba[s + 3]; } });
  tex.forEach((t, k) => { const d = texTab + k * 12; b.writeUInt16LE(1, d); b.writeUInt16LE(t.mips, d + 2); b.writeUInt16LE(t.first, d + 4); b.writeUInt16LE(0, d + 8);
    b.write(textures[k].fullName.slice(0, 15), names + k * 16, "latin1"); });
  return b;
}

// Blocks with labels and pointer fixups, laid out in order.
class Asm {
  constructor() { this.blocks = []; this.labels = new Map(); }
  block(label, bytes, align = 4, ptrs = []) { this.blocks.push({ label, bytes, align, ptrs }); return label; }
  layout(start) { let p = start; for (const b of this.blocks) { p = Math.ceil(p / b.align) * b.align; this.labels.set(b.label, p); b.off = p; p += b.bytes.length; } return p; }
  write(out) { for (const b of this.blocks) { b.bytes.copy(out, b.off); for (const [at, target, add = 0] of b.ptrs) out.writeUInt32LE(target === null ? 0 : this.labels.get(target) + add, b.off + at); } }
}

// The game draws a piece's strip with a 16-bit index count: a strip of more than 65535 indices wraps (only the rest
// past 65536 is drawn, as a garbage strip). Pieces are cut into parts of at most MAX_TRIS triangles (a strip of at
// most 6 indices per triangle with the degenerate joins), each with the vertices it uses.
const MAX_TRIS = 10000;
function splitLongPieces(pieces) {
  const out = [];
  for (const pc of pieces) {
    let tris = pc.triangles; if (!tris && pc.strip) { tris = []; const st = pc.strip; for (let k = 0; k + 2 < st.length; k++) { const t = k & 1 ? [st[k + 1], st[k], st[k + 2]] : [st[k], st[k + 1], st[k + 2]]; if (t[0] !== t[1] && t[1] !== t[2] && t[0] !== t[2]) tris.push(...t); } }
    if (!tris || tris.length / 3 <= MAX_TRIS) { out.push(pc); continue; }
    for (let s0 = 0; s0 < tris.length; s0 += MAX_TRIS * 3) { const sub = tris.slice(s0, s0 + MAX_TRIS * 3), remap = new Map(), part = { ...pc, strip: undefined, positions: [], normals: [], colors: [], uvs: [], triangles: [] };
      for (const v of sub) { if (!remap.has(v)) { remap.set(v, part.positions.length); part.positions.push(pc.positions[v]); part.normals.push(pc.normals?.[v] ?? [0, 1, 0]); part.colors.push(pc.colors?.[v] ?? [255, 255, 255, 255]); part.uvs.push(pc.uvs?.[v] ?? [0, 0]); } part.triangles.push(remap.get(v)); }
      out.push(part); }
  }
  return out;
}

export function buildTMdl(scene, template) {
  const A = new Asm(), u32 = (o, b = template) => b.readUInt32LE(o);
  const tch = {}; for (let k = 0; k < 32; k++) { const o = 0x10 + k * 16, tag = template.toString("latin1", o, o + 4); if (!/^[A-Za-z]{4}$/.test(tag)) break; tch[tag] = { off: u32(o + 4), size: u32(o + 8) }; }
  const pieces = splitLongPieces(scene.pieces), nP = pieces.length;
  // ---- names (strings) live in their own blocks
  const str = (label, s) => { const b = Buffer.alloc(s.length + 1); b.write(s, 0, "latin1"); return A.block(label, b, 1); };
  // texture names must differ without their index prefix, and none may begin another: materials name their
  // textures and the game's lookup missed two of three textures called "colour" (and "colour" / "colourb" still
  // clashed)
  { const names = scene.textures.map(t => (String(t.name || "tex").replace(/^\d+/, "").replace(/[^\w.-]/g, "_").slice(0, 10) || "tex"));
    const clash = (a, i) => names.some((b, j) => j !== i && (b.toLowerCase().startsWith(a.toLowerCase()) || a.toLowerCase().startsWith(b.toLowerCase())));
    for (let pass = 0; pass < 4; pass++) names.forEach((nm, i) => { if (clash(nm, i)) names[i] = nm.slice(0, 7) + "_" + i.toString(36).padStart(2, "0"); });
    scene.textures.forEach((t, k) => { t.fullName = (String(k) + names[k]).slice(0, 15); }); }
  // ---- Info
  const info = Buffer.alloc(16); info.write((scene.name ?? "TRACK.ea3").slice(0, 15), 0, "latin1"); A.block("Info", info, 16);
  // ---- Swap: 8 "render groups" partitioning the instances (the game draws by group; at Lowe's: 0 track and
  // ground, 2 walls, 3 buildings and stands, 5 scaffolds and banners, 6 fences and crowd quads). A material's
  // group comes from the piece's own group, else materials[i].group, else 6 when its texture has transparency, else 0.
  const groupOf = pieces.map(pc => { const m = scene.materials[pc.material] ?? {}; if (Number.isInteger(pc.group)) return Math.max(0, Math.min(7, pc.group)); if (Number.isInteger(m.group)) return Math.max(0, Math.min(7, m.group));
    const t = scene.textures[m.textures?.[0]]; if (t) { if (t.hasAlpha === undefined) { t.hasAlpha = false; for (let k = 3; k < t.rgba.length; k += 4) if (t.rgba[k] < 250) { t.hasAlpha = true; break; } } if (t.hasAlpha) return 6; } return 0; });
  const order = []; for (let g = 0; g < 8; g++) pieces.forEach((_, i) => { if (groupOf[i] === g) order.push(i); });
  const sw = Buffer.alloc(16); sw.writeUInt32LE(8, 0); A.block("Swap", sw, 16, [[4, "swE"], [8, "swF"], [0xc, "swL"]]);
  const swL = Buffer.alloc(nP * 2 + 2); order.forEach((p, k) => swL.writeUInt16LE(p, k * 2)); A.block("swL", swL, 4);
  const swF = Buffer.alloc(8 * 20), swE = Buffer.alloc(8 * 20); let st = 0;
  for (let g = 0; g < 8; g++) { const n = groupOf.filter(x => x === g).length; swF.write("render group", g * 20, "latin1"); swF.writeUInt16LE(st, g * 20 + 16); swF.writeUInt16LE(n, g * 20 + 18); st += n;
    swE.write(String(g), g * 20, "latin1"); swE.writeUInt16LE(g, g * 20 + 16); swE[g * 20 + 18] = 1; }
  A.block("swF", swF, 4); A.block("swE", swE, 4);
  // ---- Geom: header, draws, vertex buffer table, then vertex data and strips
  const gh = Buffer.alloc(0x20); gh.writeUInt32LE(nP, 4); gh.writeUInt32LE(nP, 12);
  A.block("Geom", gh, 16, [[0, "draws"], [8, "vbtab"]]);
  const draws = Buffer.alloc(nP * 20), dptrs = [], vbtab = Buffer.alloc(nP * 12), vptrs = [];
  const bbox = [];
  pieces.forEach((pc, i) => {
    const r = i * 20; dptrs.push([r, `X${i}`], [r + 4, `Y${i}`]);
    draws.writeUInt16LE(pc.material, r + 8); draws.writeUInt16LE(0xffff, r + 10); draws[r + 12] = 0xff; draws[r + 13] = 0; draws.writeUInt16LE(i, r + 14); draws[r + 16] = 1; draws[r + 17] = 2; draws[r + 18] = 0xff; draws[r + 19] = 0;
    const n = pc.positions.length; vbtab.writeUInt16LE(n, i * 12 + 4); vbtab.writeUInt16LE(40, i * 12 + 6); vbtab.writeUInt32LE(0x152, i * 12 + 8); vptrs.push([i * 12, `VB${i}`]);
  });
  A.block("draws", draws, 4, dptrs); A.block("vbtab", vbtab, 4, vptrs);
  pieces.forEach((pc, i) => {
    const n = pc.positions.length, vb = Buffer.alloc(12 + n * 40); vb.writeUInt32LE(0x01000001, 0);
    const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < n; k++) { const o = 12 + k * 40, p = pc.positions[k], nr = pc.normals?.[k] ?? [0, 1, 0], c = pc.colors?.[k] ?? [255, 255, 255, 255], t = pc.uvs?.[k] ?? [0, 0];
      for (let j = 0; j < 3; j++) { vb.writeFloatLE(p[j], o + j * 4); vb.writeFloatLE(nr[j], o + 12 + j * 4); mn[j] = Math.min(mn[j], p[j]); mx[j] = Math.max(mx[j], p[j]); }
      vb[o + 24] = c[2]; vb[o + 25] = c[1]; vb[o + 26] = c[0]; vb[o + 27] = c[3]; vb.writeFloatLE(t[0], o + 28); vb.writeFloatLE(t[1], o + 32); }
    bbox.push([mn, mx]); A.block(`VB${i}`, vb, 0x80);
    // one triangle strip (triangle lists become strips with degenerate joins)
    let strip = pc.strip; if (!strip) { strip = []; const t = pc.triangles; for (let k = 0; k < t.length; k += 3) { if (strip.length) { strip.push(strip.at(-1), t[k]); if (strip.length & 1) strip.push(t[k]); } strip.push(t[k], t[k + 1], t[k + 2]); } }
    const P = Buffer.alloc(16 + strip.length * 2 + 2); P.writeUInt32LE(strip.length - 2, 0); strip.forEach((v, k) => P.writeUInt16LE(v, 16 + k * 2));
    const X = Buffer.alloc(8); X.writeUInt32LE(1, 0); A.block(`X${i}`, X, 4, [[4, `P${i}`]]); A.block(`P${i}`, P, 16);
    const Y = Buffer.alloc(16); Y.writeUInt32LE(1, 0); Y.writeUInt32LE(0, 8); Y.writeUInt32LE(1, 12); A.block(`Y${i}`, Y, 4, [[4, `Y${i}`, 8]]);
  });
  // ---- Lite (template copy; its two pointers point into itself)
  const lite = Buffer.from(template.subarray(tch.Lite.off, tch.Lite.off + tch.Lite.size));
  A.block("Lite", lite, 16, [[4, "Lite", u32(tch.Lite.off + 4) - tch.Lite.off], [0xc, "Lite", u32(tch.Lite.off + 0xc) - tch.Lite.off]]);
  // ---- Matl
  // count, then the offsets of the (contiguous) records as the game's files have them (only the first is used)
  const ml = Buffer.alloc(4 + scene.materials.length * 4); ml.writeUInt32LE(scene.materials.length, 0);
  A.block("Matl", ml, 16, scene.materials.map((_, i) => [4 + i * 4, "matrecs", i * 0x30]));
  const mr = Buffer.alloc(scene.materials.length * 0x30), mp = [];
  const shaders = [...new Set(scene.materials.map(m => m.shader || "1P_BT"))];
  scene.materials.forEach((m, i) => { const r = i * 0x30; mp.push([r, `mn${i}`], [r + 4, `sh${shaders.indexOf(m.shader || "1P_BT")}`]); mr.writeUInt16LE(Math.min(8, m.textures.length), r + 8); m.textures.slice(0, 8).forEach((t, j) => mp.push([r + 0xc + j * 4, `tn${t}`])); });
  A.block("matrecs", mr, 4, mp); shaders.forEach((sh, k) => str(`sh${k}`, sh.slice(0, 15)));
  scene.materials.forEach((m, i) => str(`mn${i}`, (String(i) + m.name).slice(0, 31)));
  // ---- Txfm (texture names shared with materials)
  const tx = Buffer.alloc(4 + scene.textures.length * 24), tp = []; tx.writeUInt32LE(scene.textures.length, 0);
  scene.textures.forEach((t, k) => { const r = 4 + k * 24; tp.push([r, `tn${k}`]); const o = t.offset ?? [0, 0], s = t.scale ?? [1, 1]; tx.writeFloatLE(o[0], r + 4); tx.writeFloatLE(o[1], r + 8); tx.writeFloatLE(s[0], r + 12); tx.writeFloatLE(s[1], r + 16); tx.writeUInt32LE(0xf400, r + 20); });
  A.block("Txfm", tx, 16, tp); scene.textures.forEach((t, k) => str(`tn${k}`, t.fullName));
  // ---- Inst: one instance per piece, one sub per placement (scene-graph node; node 0 = no transform); C empty
  const placements = pieces.map(pc => pc.placements?.length ? pc.placements : [null]);
  const nodes = [{ name: "", t: [0, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }], subList = [];
  pieces.forEach((pc, i) => placements[i].forEach((pl, k) => { let node = 0; if (pl) { node = nodes.length; nodes.push({ name: (pl.name ?? `${pc.name || "piece"}_${k}`).slice(0, 15), t: pl.t ?? [0, 0, 0], r: pl.r ?? [0, 0, 0], s: pl.s ?? [1, 1, 1] }); } subList.push({ piece: i, k, node }); }));
  const nS = subList.length, ih = Buffer.alloc(0x30); ih.writeUInt32LE(nP, 0);
  const rng = Buffer.alloc(nP * 4), subs = Buffer.alloc(nS * 16); let s0 = 0;
  pieces.forEach((_, i) => { rng.writeUInt16LE(s0, i * 4); s0 += placements[i].length; rng.writeUInt16LE(s0, i * 4 + 2); });
  subList.forEach((sb, j) => { subs.writeUInt32LE(sb.node, j * 16 + 8); subs.writeUInt32LE(sb.piece, j * 16 + 12); });
  A.block("Inst", ih, 16, [[4, "irng"], [8, "isubs"], [0xc, "iC"], [0x10, "H"]]);
  A.block("irng", rng, 4); A.block("isubs", subs, 16); const C = Buffer.alloc(8); A.block("iC", C, 4, [[4, "iC", 8]]);
  // scene graph: count, names (16 B), translations (4 floats), rotations (3 x s16, 32768 = 180 degrees), scales (3 floats)
  const nN = nodes.length, hh = Buffer.alloc(0x20); hh.writeUInt32LE(nN, 0);
  const hn = Buffer.alloc(nN * 16), ht = Buffer.alloc(nN * 16), hr = Buffer.alloc(nN * 6 + 2), hs = Buffer.alloc(nN * 12);
  nodes.forEach((n, i) => { hn.write(n.name, i * 16, "latin1"); for (let j = 0; j < 3; j++) { ht.writeFloatLE(n.t[j], i * 16 + j * 4); hr.writeInt16LE(Math.round((((n.r[j] % 360) + 540) % 360 - 180) * 32768 / 180) | 0, i * 6 + j * 2); hs.writeFloatLE(n.s[j], i * 12 + j * 4); } });
  A.block("H", hh, 16, [[4, "Hn"], [8, "Ht"], [0xc, "Hr"], [0x10, "Hs"]]); A.block("Hn", hn, 16); A.block("Ht", ht, 16); A.block("Hr", hr, 4); A.block("Hs", hs, 4);
  // ---- Rint: one node per sub (its placed bounding box), one cell with every node
  const rh = Buffer.alloc(0x10); rh.writeUInt32LE(nS, 0); rh.writeUInt32LE(1, 8); A.block("Rint", rh, 16, [[4, "rnodes"], [0xc, "rcell"]]);
  const rn = Buffer.alloc(nS * 0x40), rp = [], rl = Buffer.alloc(nS * 4), gmn = [Infinity, Infinity, Infinity], gmx = [-Infinity, -Infinity, -Infinity];
  subList.forEach((sb, i) => { const r = i * 0x40, [bmn, bmx] = bbox[sb.piece], M = sb.node ? nodeMatrix(nodes[sb.node]) : null, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 8; c++) { const p = [c & 1 ? bmx[0] : bmn[0], c & 2 ? bmx[1] : bmn[1], c & 4 ? bmx[2] : bmn[2]], q = M ? [0, 1, 2].map(j => M[j][0] * p[0] + M[j][1] * p[1] + M[j][2] * p[2] + M[j][3]) : p; for (let j = 0; j < 3; j++) { mn[j] = Math.min(mn[j], q[j]); mx[j] = Math.max(mx[j], q[j]); } }
    for (let j = 0; j < 3; j++) { rn.writeFloatLE(mn[j], r + j * 4); rn.writeFloatLE(mx[j], r + 16 + j * 4); gmn[j] = Math.min(gmn[j], mn[j]); gmx[j] = Math.max(gmx[j], mx[j]); }
    rn.writeFloatLE(1, r + 12); rn.writeFloatLE(1, r + 28); rn.writeUInt32LE(1, r + 0x20); rp.push([r + 0x30, "rlists", i * 4]); rl.writeUInt16LE(sb.piece, i * 4); rl.writeUInt16LE(sb.k, i * 4 + 2); });
  A.block("rnodes", rn, 16, rp); A.block("rlists", rl, 4);
  const cell = Buffer.alloc(36 + nS * 4); for (let j = 0; j < 3; j++) { cell.writeFloatLE(gmn[j], j * 4); cell.writeFloatLE(gmx[j], 16 + j * 4); } cell.writeFloatLE(1, 12); cell.writeFloatLE(1, 28); cell.writeUInt32LE(nS, 32);
  for (let i = 0; i < nS; i++) { cell.writeUInt16LE(1, 36 + i * 4); cell.writeUInt16LE(i, 38 + i * 4); } A.block("rcell", cell, 16);
  // ---- Text, Fade
  A.block("Text", buildTextMMAP(scene.textures), 0x80); A.block("Fade", Buffer.alloc(nP * 4), 16);
  // ---- header + chunk table
  const tags = ["Info", "Swap", "Geom", "Lite", "Matl", "Txfm", "Inst", "Rint", "Text", "Fade"];
  const start = 0x10 + tags.length * 16, end = A.layout((start + 0x7f) & ~0x7f), out = Buffer.alloc((end + 15) & ~15);
  out.write("TMdl", 0, "latin1"); out.writeUInt32LE(out.length, 4); out.writeUInt16LE(tags.length, 8); out.writeUInt16LE(0x10, 10); out.writeUInt32LE(0x71010, 12);
  const endOf = tag => { const i = A.blocks.findIndex(b => b.label === tag); const next = A.blocks.slice(i + 1).find(b => tags.includes(b.label)); return next ? next.off : end; };
  tags.forEach((tag, k) => { const o = 0x10 + k * 16; out.write(tag, o, "latin1"); out.writeUInt32LE(A.labels.get(tag), o + 4); out.writeUInt32LE(endOf(tag) - A.labels.get(tag), o + 8);
    out.writeUInt32LE({ Info: 1, Geom: 2, Matl: 1, Txfm: 1, Inst: 1, Rint: 1 }[tag] ?? 0, o + 12); });
  A.write(out);
  return out;
}
