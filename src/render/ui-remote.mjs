// ui-remote.mjs — the UI layer (menus, HUD: the screens the UI VM runs, uis-render.mjs) sent to the browser as
// textured quads instead of pixels: renderScreen draws into a recording canvas, the client (play-client.js) draws
// the quads with WebGL over the game's 3D picture. Textures (screen art, fonts) cross once.
//
// Message: u32 0x55495549 ("IUIU"), u32 json length, json { w, h, tex: [{ id, w, h, blob }], batches: [[tex id or 0,
// additive, first vertex, vertex count]], split (NT04_PREVIEW: batches drawn before the 3D picture), blobs }, padding, blobs (blob 0 = vertices: x, y, u, v, r, g, b, a floats).

import { renderScreen, W, H } from "../game/uis-render.mjs";

const PREVIEW = process.env.NT04_PREVIEW !== "0";

class RecordCanvas {
  constructor(rec) { this.rec = rec; this.w = W; this.h = H; this.v = []; this.batches = []; }
  quad(q, tex, additive) {
    const id = tex ? this.rec.texId(tex) : 0, add = additive ? 1 : 0, b = this.batches.at(-1), first = this.v.length / 8;
    for (const i of [0, 1, 2, 0, 2, 3]) { const p = q[i]; this.v.push(p.x, p.y, p.u ?? 0, p.v ?? 0, p.r ?? 1, p.g ?? 1, p.b ?? 1, p.a ?? 1); }
    if (b && b[0] === id && b[1] === add && !this.cut) b[3] += 6; else this.batches.push([id, add, first, 6]);
    this.cut = false;
  }
  // NT04_PREVIEW: the first 3D car object in draw order; the batches before it go under the 3D picture
  mark3d() { if (PREVIEW && this.split === undefined) { this.split = this.batches.length; this.cut = true; } }
  tri(t, tex, additive) { this.quad([t[0], t[1], t[2], t[2]], tex, additive); }
}

export class UIRecorder {
  constructor() { this.ids = new WeakMap(); this.next = 1; this.sent = new Set(); this.newTex = []; this.last = 0; }
  reset() { this.sent.clear(); this.last = 0; }
  texId(tex) {
    let id = this.ids.get(tex); if (!id) { id = this.next++; this.ids.set(tex, id); }
    if (!this.sent.has(id)) { this.sent.add(id); this.newTex.push({ id, tex }); }
    return id;
  }
  // a message for the screens' current state, or null when nothing changed since the last one
  frame(vm, assets) {
    const c = new RecordCanvas(this);
    for (const sc of vm.screens) if (!vm.drawn || vm.drawn(sc)) renderScreen(sc.data, assets, c, { layout: sc.layout, mem: vm.mem, base: sc.base, video: vm.video });
    const verts = Float32Array.from(c.v);
    let h = 0x811c9dc5 ^ verts.length; const u = new Uint32Array(verts.buffer);
    for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 16777619);
    for (const b of c.batches) h = Math.imul(h ^ (b[0] * 7 + b[1]), 16777619);
    h = Math.imul(h ^ (c.split ?? -1), 16777619);
    if (h === this.last && !this.newTex.length) return null;
    this.last = h;
    const blobs = [new Uint8Array(verts.buffer)], tex = [];
    for (const { id, tex: t } of this.newTex) { if (t.video) { tex.push({ id, w: t.width, h: t.height, video: t.video }); continue; } tex.push({ id, w: t.width, h: t.height, blob: blobs.length }); blobs.push(t.rgba instanceof Uint8Array ? t.rgba : new Uint8Array(t.rgba.buffer, t.rgba.byteOffset, t.rgba.byteLength)); }
    this.newTex = [];
    const table = []; let off = 0;
    for (const b of blobs) { off = (off + 3) & ~3; table.push([off, b.byteLength]); off += b.byteLength; }
    const json = Buffer.from(JSON.stringify({ w: W, h: H, tex, batches: c.batches, split: c.split, blobs: table }));
    const head = (8 + json.length + 3) & ~3, out = Buffer.alloc(head + off);
    out.writeUInt32LE(0x55495549, 0); out.writeUInt32LE(json.length, 4); json.copy(out, 8);
    blobs.forEach((b, i) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).copy(out, head + table[i][0]));
    return out;
  }
}
