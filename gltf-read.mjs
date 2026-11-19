// gltf-read.mjs — a small glTF 2.0 reader (.gltf with external or data: buffers, or binary .glb) for track packs:
// node tree with world matrices, mesh primitives as flat arrays, materials and PNG images.
//   readGLTF(path) -> { json, dir, accessor(i) -> { data: number[], n: components, count },
//                       image(i) -> { width, height, rgba }, scenes: [{ mesh, matrix (4x4 row-major) }] }
// Images: PNG only (Blender: Export > Images "PNG" or "Automatic" with PNG sources).
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { decodePNG } from "./png-read.mjs";

const COMP = { 5120: [1, "readInt8", 127], 5121: [1, "readUInt8", 255], 5122: [2, "readInt16LE", 32767], 5123: [2, "readUInt16LE", 65535], 5125: [4, "readUInt32LE", 0], 5126: [4, "readFloatLE", 0] };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

export const mat4 = {
  identity: () => [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]],
  mul: (A, B) => A.map(r => [0, 1, 2, 3].map(j => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j] + r[3] * B[3][j])),
  // glTF node: matrix (column-major) or translation * rotation (quaternion x y z w) * scale
  fromNode(n) {
    if (n.matrix) { const m = n.matrix; return [0, 1, 2, 3].map(i => [m[i], m[4 + i], m[8 + i], m[12 + i]]); }
    const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1], [sx, sy, sz] = n.scale ?? [1, 1, 1], [tx, ty, tz] = n.translation ?? [0, 0, 0];
    const R = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]];
    return [[R[0][0] * sx, R[0][1] * sy, R[0][2] * sz, tx], [R[1][0] * sx, R[1][1] * sy, R[1][2] * sz, ty], [R[2][0] * sx, R[2][1] * sy, R[2][2] * sz, tz], [0, 0, 0, 1]];
  },
};

export function readGLTF(path) {
  const raw = readFileSync(path), dir = dirname(path); let json, glbBin = null;
  if (raw.readUInt32LE(0) === 0x46546c67) {          // "glTF" binary
    let p = 12; while (p + 8 <= raw.length) { const len = raw.readUInt32LE(p), type = raw.readUInt32LE(p + 4), d = raw.subarray(p + 8, p + 8 + len);
      if (type === 0x4e4f534a) json = JSON.parse(d.toString("utf8")); else if (type === 0x004e4942) glbBin = d; p += 8 + len; }
  } else json = JSON.parse(raw.toString("utf8"));
  if (!json?.asset || !String(json.asset.version).startsWith("2")) throw new Error("not a glTF 2.0 file");
  const uri = u => { if (u.startsWith("data:")) return Buffer.from(u.slice(u.indexOf(",") + 1), "base64"); const f = join(dir, decodeURIComponent(u)); if (!existsSync(f)) throw new Error(`missing file ${u}`); return readFileSync(f); };
  const buffers = (json.buffers ?? []).map((b, i) => b.uri ? uri(b.uri) : (i === 0 && glbBin) ? glbBin : Buffer.alloc(b.byteLength));
  const view = i => { const v = json.bufferViews[i]; return { buf: buffers[v.buffer], off: v.byteOffset ?? 0, len: v.byteLength, stride: v.byteStride ?? 0 }; };
  const accessor = i => {
    const a = json.accessors[i], n = NCOMP[a.type], [size, rd, norm] = COMP[a.componentType], data = new Array(a.count * n).fill(0);
    if (a.bufferView !== undefined) { const v = view(a.bufferView), stride = v.stride || size * n, base = v.off + (a.byteOffset ?? 0);
      for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) { let x = v.buf[rd](base + k * stride + c * size); if (a.normalized && norm) x = Math.max(-1, x / norm); data[k * n + c] = x; } }
    if (a.sparse) { const s = a.sparse, iv = view(s.indices.bufferView), vv = view(s.values.bufferView), [isz, ird] = COMP[s.indices.componentType];
      for (let k = 0; k < s.count; k++) { const at = iv.buf[ird](iv.off + (s.indices.byteOffset ?? 0) + k * isz); for (let c = 0; c < n; c++) { let x = vv.buf[rd](vv.off + (s.values.byteOffset ?? 0) + (k * n + c) * size); if (a.normalized && norm) x = Math.max(-1, x / norm); data[at * n + c] = x; } } }
    return { data, n, count: a.count };
  };
  const imgCache = new Map();
  const image = i => { if (imgCache.has(i)) return imgCache.get(i); const im = json.images[i]; let bytes;
    if (im.bufferView !== undefined) { const v = view(im.bufferView); bytes = v.buf.subarray(v.off, v.off + v.len); } else bytes = uri(im.uri);
    if (bytes.readUInt32BE(0) !== 0x89504e47) throw new Error(`image ${im.name ?? im.uri ?? i}: only PNG images are supported (export the textures as PNG)`);
    const r = decodePNG(bytes); imgCache.set(i, r); return r; };
  const imageFile = rel => decodePNG(uri(rel));
  // every mesh use in the scene with its world matrix
  const uses = [], walk = (ni, M, depth = 0) => { if (depth > 64) return; const n = json.nodes[ni], W = mat4.mul(M, mat4.fromNode(n)); if (n.mesh !== undefined) uses.push({ mesh: n.mesh, node: ni, name: n.name, matrix: W }); for (const c of n.children ?? []) walk(c, W, depth + 1); };
  const sc = json.scenes?.[json.scene ?? 0]; for (const ni of sc ? sc.nodes ?? [] : (json.nodes ?? []).map((_, i) => i)) walk(ni, mat4.identity());
  return { json, dir, accessor, image, imageFile, uses };
}
