// gltf-write.mjs — a small binary glTF (.glb) writer: one file with its buffers and PNG textures inside, which is
// what the launcher takes and what Blender opens (File > Import > glTF 2.0).
//
//   const G = new GLB("generator name");
//   const m = G.material("asphalt", { png, alpha, color: [r, g, b, a], extras });
//   const mesh = G.mesh("road", [{ positions: [x, y, z, ...], uvs: [u, v, ...], indices: [...], material: m, mode: 4 }]);
//   G.node({ name: "road", mesh, translation, rotation, scale, extras });  (root node; G.node(n, parent) for a child)
//   G.extras = { ... };  writeFileSync("x.glb", G.glb());
// Lines: mode 1 (pairs), 2 (loop), 3 (strip); points only need positions. Empties: a node with no mesh.

export class GLB {
  constructor(generator = "nt04") { this.j = { asset: { version: "2.0", generator }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [], textures: [], images: [], samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }], accessors: [], bufferViews: [], buffers: [] }; this.bin = []; this.off = 0; this.matByName = new Map(); }
  view(buf, target) { const pad = (4 - (buf.length % 4)) % 4; this.bin.push(buf); if (pad) this.bin.push(Buffer.alloc(pad)); this.j.bufferViews.push({ buffer: 0, byteOffset: this.off, byteLength: buf.length, ...(target ? { target } : {}) }); this.off += buf.length + pad; return this.j.bufferViews.length - 1; }
  acc(arr, type, comp, target) {
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type], buf = comp === 5126 ? Buffer.from(new Float32Array(arr).buffer) : Buffer.from(new Uint32Array(arr).buffer);
    const a = { bufferView: this.view(buf, target), componentType: comp, count: arr.length / n, type };
    if (type === "VEC3") { const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < arr.length; i++) { lo[i % 3] = Math.min(lo[i % 3], arr[i]); hi[i % 3] = Math.max(hi[i % 3], arr[i]); } if (arr.length) { a.min = lo; a.max = hi; } }
    this.j.accessors.push(a); return this.j.accessors.length - 1;
  }
  material(name, { png = null, alpha = false, color = null, doubleSided = true, extras = null, emissive = null } = {}) {
    if (this.matByName.has(name)) return this.matByName.get(name);
    const mt = { name, pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 1 }, doubleSided };
    if (png) { this.j.images.push({ name, mimeType: "image/png", bufferView: this.view(png) }); this.j.textures.push({ source: this.j.images.length - 1, sampler: 0 }); mt.pbrMetallicRoughness.baseColorTexture = { index: this.j.textures.length - 1 }; if (alpha) { mt.alphaMode = "MASK"; mt.alphaCutoff = 0.5; } }
    if (color) mt.pbrMetallicRoughness.baseColorFactor = color; if (emissive) mt.emissiveFactor = emissive; if (extras) mt.extras = extras;
    this.j.materials.push(mt); this.matByName.set(name, this.j.materials.length - 1); return this.j.materials.length - 1;
  }
  mesh(name, prims) {
    const P = [];
    for (const p of prims) { if (!p.positions?.length) continue; const at = { POSITION: this.acc(p.positions, "VEC3", 5126, 34962) };
      if (p.uvs?.length) at.TEXCOORD_0 = this.acc(p.uvs, "VEC2", 5126, 34962); if (p.colors?.length) at.COLOR_0 = this.acc(p.colors, "VEC4", 5126, 34962);
      for (const [k, v] of Object.entries(p.attrs ?? {})) at[k] = this.acc(v, "SCALAR", 5126, 34962);   // (custom attributes: names starting with _)
      const q = { attributes: at, mode: p.mode ?? 4 }; if (p.indices) q.indices = this.acc(p.indices, "SCALAR", 5125, 34963); if (p.material !== undefined && p.material !== null) q.material = p.material; P.push(q); }
    if (!P.length) return null; this.j.meshes.push({ name, primitives: P }); return this.j.meshes.length - 1;
  }
  node(n, parent = null) {
    const o = { name: n.name }; if (n.mesh !== undefined && n.mesh !== null) o.mesh = n.mesh; for (const k of ["translation", "rotation", "scale", "extras"]) if (n[k]) o[k] = n[k];
    this.j.nodes.push(o); const i = this.j.nodes.length - 1;
    if (parent === null) this.j.scenes[0].nodes.push(i); else (this.j.nodes[parent].children ??= []).push(i);
    return i;
  }
  glb() {
    const data = Buffer.concat(this.bin); this.j.buffers = [{ byteLength: data.length }];
    if (this.extras) this.j.scenes[0].extras = this.extras;
    for (const k of ["materials", "textures", "images", "meshes"]) if (!this.j[k].length) delete this.j[k]; if (!this.j.textures) delete this.j.samplers;
    let js = Buffer.from(JSON.stringify(this.j), "utf8"); js = Buffer.concat([js, Buffer.alloc((4 - js.length % 4) % 4, 0x20)]);
    const h = Buffer.alloc(12); h.writeUInt32LE(0x46546c67, 0); h.writeUInt32LE(2, 4); h.writeUInt32LE(12 + 8 + js.length + 8 + data.length, 8);
    const c = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.writeUInt32LE(type, 4); return b; };
    return Buffer.concat([h, c(js.length, 0x4e4f534a), js, c(data.length, 0x004e4942), data]);
  }
}
// a rotation about the vertical axis (glTF +Y) that turns +X to the heading h of the layout frame (x, y = -z)
export const yaw = h => [0, Math.sin(h / 2), 0, Math.cos(h / 2)];
export const yawOf = q => 2 * Math.atan2(q?.[1] ?? 0, q?.[3] ?? 1);
