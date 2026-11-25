// soft-renderer.mjs — a software implementation of the renderer interface (renderer.mjs): it turns the game's
// draw calls into pixels without a GPU, for headless frame captures (PNG) and as the reference the WebGL backend
// is checked against. It reads everything the GPU would read straight from game memory at draw time:
//
//   vertices   vertex buffers (resource Data = physical address) laid out by the vertex shader declaration
//              (D3DVSD tokens: STREAM, REG(type), SKIP, CONSTMEM, END), or pointers for the *UP draws;
//   shading    the NV2A vertex shader program (nv2a-vsh.mjs), with constants from d3d-hle (vsConst); fixed-
//              function (FVF) vertices are transformed with world/view/projection;
//   textures   texture resources (Format: dimension, colour format, mip count, log2 size; Size for linear
//              surfaces) decoded with mmap-tex.mjs (swizzled, linear, DXT, P8 with the palette set for the stage);
//   pixels     NV2A register combiners from the pixel shader definition (D3DPIXELSHADERDEF) or, without one, the
//              texture stage states (COLOROP/ALPHAOP...); then alpha test, depth test, blending, colour mask, from
//              the NV2A methods set through SetRenderState_Simple.
//
// Capturing is per frame: capture(n) renders the next n frames; other frames only count (like NullRenderer).
// Images are kept per render target surface; frame(rt) returns { width, height, rgba }.

import { NullRenderer } from "./renderer.mjs";
import { compileVsh, readVsh, constantsRead } from "../xbox/nv2a-vsh.mjs";
import { decodePixels, encodePNG } from "../game/mmap-tex.mjs";

// NV2A (Kelvin) methods the D3D "simple" render states write
const NV = { ALPHA_TEST_ENABLE: 0x300, BLEND_ENABLE: 0x304, CULL_FACE_ENABLE: 0x308, DEPTH_TEST_ENABLE: 0x30c, ALPHA_FUNC: 0x33c,
  ALPHA_REF: 0x340, BLEND_SFACTOR: 0x344, BLEND_DFACTOR: 0x348, BLEND_COLOR: 0x34c, BLEND_EQUATION: 0x350, DEPTH_FUNC: 0x354,
  COLOR_MASK: 0x358, DEPTH_MASK: 0x35c, CULL_FACE: 0x39c, FRONT_FACE: 0x3a0 };
// D3D texture stage state indices in D3D_g_DeferredTextureState (Xbox order)
const TSS = { ADDRESSU: 0, ADDRESSV: 1, ADDRESSW: 2, MAGFILTER: 3, MINFILTER: 4, MIPFILTER: 5, COLOROP: 12, COLORARG0: 13, COLORARG1: 14,
  COLORARG2: 15, ALPHAOP: 16, ALPHAARG0: 17, ALPHAARG1: 18, ALPHAARG2: 19, RESULTARG: 20, TEXCOORDINDEX: 22 };
const PRIM_TRIS = new Set(["triangles", "triangleStrip", "triangleFan", "quads", "quadStrip", "polygon"]);
const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;

export class SoftRenderer extends NullRenderer {
  constructor(game, opts = {}) {
    super(); this.g = game; this.m = game.mem; this.capturing = 0; this.targets = new Map(); this.vshCache = new Map();
    this.texCache = new Map(); this.skipped = {}; this.drawn = 0; this.pixels = 0;
    this.opts = opts;
    this.countsPixels = true;   // visibility tests get real pixel counts while capturing
  }
  get d3d() { return this.g.d3d; }
  get wantsState() { return this.capturing > 0 || !!this.detailed; }
  capture(n = 1) { this.capturing = n; this.texCache.clear(); }
  init(info) { super.init(info); this.width = info.width; this.height = info.height; }
  target(surface) {
    let t = this.targets.get(surface);
    if (!t) {
      const m = this.m, size = surface ? m.r32(surface + 16) : 0;
      const w = size ? (size & 0xfff) + 1 : this.width ?? 640, h = size ? ((size >> 12) & 0xfff) + 1 : this.height ?? 480;
      t = { width: w, height: h, rgba: new Uint8ClampedArray(w * h * 4), depth: new Float32Array(w * h).fill(1), surface };
      this.targets.set(surface, t);
    }
    return t;
  }
  frame(rt) { return this.target(rt ?? this.d3d.backBuffer); }
  png(rt) { const t = this.frame(rt); return encodePNG(t.width, t.height, new Uint8Array(t.rgba.buffer)); }

  clear(c) {
    super.clear(c); if (!this.capturing) return;
    const d3d = this.d3d, t = this.target(d3d.renderTarget), col = c.color >>> 0;
    // (Clear without rects clears the viewport's rectangle)
    const vp = d3d.viewport, W = t.width, H = t.height, full = !(vp && vp.w > 0 && vp.h > 0);
    const x0 = full ? 0 : Math.max(0, vp.x | 0), y0 = full ? 0 : Math.max(0, vp.y | 0), x1 = full ? W : Math.min(W, Math.ceil(vp.x + vp.w)), y1 = full ? H : Math.min(H, Math.ceil(vp.y + vp.h));
    if (c.flags & 0xf0) { const r = (col >> 16) & 255, g = (col >> 8) & 255, b = col & 255, a = col >>> 24;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * W + x) * 4; t.rgba[i] = r; t.rgba[i + 1] = g; t.rgba[i + 2] = b; t.rgba[i + 3] = a; } }
    if (c.flags & 1) for (let y = y0; y < y1; y++) t.depth.fill(c.z, y * W + x0, y * W + x1);
    if (x0 <= 0 && y0 <= 0 && x1 >= W && y1 >= H) t.insets = null;
  }
  present(stats) { super.present(stats); if (this.capturing) { this.capturing--; this.captured = (this.captured ?? 0) + 1; this.onFrame?.(this); } }

  draw(cmd) {
    super.draw(cmd); if (!this.capturing) return;
    if (!PRIM_TRIS.has(cmd.prim)) { this.skip(`prim ${cmd.prim}`); return; }
    try { this.raster(cmd); this.drawn++; } catch (e) { this.skip(`error ${e.message.slice(0, 80)}`); }
  }
  skip(k) { this.skipped[k] = (this.skipped[k] ?? 0) + 1; }

  // ------------------------------------------------------------------ vertices
  shader(handle) {
    let s = this.vshCache.get(handle); if (s) return s;
    const def = this.d3d.shaders.get(handle & ~1)?.def; if (!def) return null;
    const prog = def.fn ? readVsh(this.m, def.fn) : null;
    s = { decl: this.parseDecl(def.decl), fn: prog ? compileVsh(prog.words) : null, screen: prog ? constantsRead(prog.words).has(-37) : false };
    this.vshCache.set(handle, s); return s;
  }
  parseDecl(p) {
    const m = this.m, regs = [], consts = []; let stream = 0, offset = 0;
    for (let i = 0; i < 64; i++, p += 4) {
      const t = m.r32(p), kind = t >>> 29;
      if (t === 0xffffffff || kind === 7) break;
      if (kind === 1) { stream = t & 0xf; offset = 0; }
      else if (kind === 2) {
        if (t & 0x10000000) offset += (t & 0x08000000) ? (t >> 16) & 0xff : ((t >> 16) & 0xf) * 4;
        else { const type = (t >> 16) & 0xff, reg = t & 0x1f; regs.push({ stream, offset, reg, type }); offset += typeSize(type); }
      } else if (kind === 4) { const n = (t >> 25) & 0xf, a = t & 0xff; for (let k = 0; k < n * 4; k++) consts.push([a * 4 + k, m.rf(p + 4 + k * 4)]); p += n * 16; i += n * 4; }
    }
    return { regs, consts };
  }
  // fetch input registers V for vertex index `vi`
  fetch(decl, streams, vi, V, up) {
    const m = this.m; V.fill(0); for (let r = 0; r < 16; r++) V[r * 4 + 3] = 1;
    for (const { stream, offset, reg, type } of decl.regs) {
      let base, stride;
      if (up) { base = up.data; stride = up.stride; }
      else { const s = streams[stream]; if (!s?.vb) continue; base = (m.r32(s.vb + 4) | 0x80000000) >>> 0; stride = s.stride; }
      readType(m, (base + vi * stride + offset) >>> 0, type, V, reg * 4);
    }
  }
  vertices(cmd, idx) {
    const d3d = this.d3d, st = cmd.state, C = Float32Array.from(d3d.vsConst), out = new Map();
    const vsHandle = st.vertexShader >>> 0;
    if (!(vsHandle & 1)) return this.ffVertices(cmd, idx);
    const sh = this.shader(vsHandle); if (!sh?.fn) { this.skip("no shader program"); return null; }
    for (const [i, v] of sh.decl.consts) C[i] = v;
    const V = new Float32Array(64), up = cmd.kind.endsWith("-up") ? { data: cmd.data, stride: cmd.stride } : null;
    const vp = st.viewport;
    for (const vi of idx) {
      if (out.has(vi)) continue;
      const O = new Float32Array(13 * 4); O[3 * 4] = O[3 * 4 + 1] = O[3 * 4 + 2] = O[3 * 4 + 3] = 1;
      this.fetch(sh.decl, st.streams, vi, V, up); sh.fn(V, C, O);
      let sx = O[0], sy = O[1], sz = O[2], w = O[3];
      if (!sh.screen) {                    // clip-space output: divide and map to the viewport here
        const iw = 1 / w; sx = (sx * iw * 0.5 + 0.5) * vp.w + vp.x; sy = (0.5 - sy * iw * 0.5) * vp.h + vp.y; sz = sz * iw * this.zScale();
      }
      out.set(vi, { sx, sy, sz, w, o: O });
    }
    return out;
  }
  zScale() { const ds = this.d3d.depthSurface, f = ds ? (this.m.r32(ds + 12) >> 8) & 0xff : 0x2a; return f === 0x2c || f === 0x30 || f === 0x2d || f === 0x31 ? 65535 : 16777215; }
  ffVertices(cmd, idx) {                   // fixed function (FVF code instead of a shader handle)
    const m = this.m, d3d = this.d3d, fvf = cmd.state.vertexShader >>> 0, vp = cmd.state.viewport, out = new Map();
    const pos = fvf & 0xe, hasN = fvf & 0x10, hasD = fvf & 0x40, hasS = fvf & 0x80, ntex = (fvf >> 8) & 0xf;
    let stride = 0; const off = {};
    off.pos = 0; stride += pos === 4 ? 16 : pos === 2 ? 12 : pos >= 6 ? 12 + (pos - 4) / 2 * 4 : 12;
    if (hasN) { off.n = stride; stride += 12; } if (fvf & 0x20) stride += 4;
    if (hasD) { off.d = stride; stride += 4; } if (hasS) { off.s = stride; stride += 4; }
    off.t = []; for (let i = 0; i < ntex; i++) { off.t.push(stride); const f = (fvf >> (16 + i * 2)) & 3; stride += [8, 12, 16, 4][f]; }
    const s0 = cmd.state.streams[0], up = cmd.kind.endsWith("-up");
    const base = up ? cmd.data : (m.r32(s0?.vb + 4) | 0x80000000) >>> 0, str = up ? cmd.stride : s0?.stride ?? stride;
    const mat = k => { const b = d3d.transforms.get(k); if (!b) return ident(); const a = new Float32Array(16); for (let i = 0; i < 16; i++) a[i] = b.readFloatLE(i * 4); return a; };
    const wvp = mul(mul(mat(6), mat(0)), mat(1)), zs = this.zScale();
    for (const vi of idx) {
      if (out.has(vi)) continue;
      const a = (base + vi * str) >>> 0, O = new Float32Array(13 * 4);
      const x = m.rf(a), y = m.rf(a + 4), z = m.rf(a + 8);
      const col = (o, r) => { const c = m.r32(a + o); O[r * 4] = ((c >> 16) & 255) / 255; O[r * 4 + 1] = ((c >> 8) & 255) / 255; O[r * 4 + 2] = (c & 255) / 255; O[r * 4 + 3] = (c >>> 24) / 255; };
      if (hasD) col(off.d, 3); else O.fill(1, 12, 16);
      if (hasS) col(off.s, 4);
      off.t.forEach((o, i) => { O[(9 + i) * 4] = m.rf(a + o); O[(9 + i) * 4 + 1] = m.rf(a + o + 4); O[(9 + i) * 4 + 3] = 1; });
      let sx, sy, sz, w;
      if (pos === 4) { const rhw = m.rf(a + 12); sx = x; sy = y; sz = z * zs; w = rhw ? 1 / rhw : 1; }
      else { const cx = x * wvp[0] + y * wvp[4] + z * wvp[8] + wvp[12], cy = x * wvp[1] + y * wvp[5] + z * wvp[9] + wvp[13],
          cz = x * wvp[2] + y * wvp[6] + z * wvp[10] + wvp[14]; w = x * wvp[3] + y * wvp[7] + z * wvp[11] + wvp[15];
        const iw = 1 / w; sx = (cx * iw * 0.5 + 0.5) * vp.w + vp.x; sy = (0.5 - cy * iw * 0.5) * vp.h + vp.y; sz = cz * iw * zs; }
      out.set(vi, { sx, sy, sz, w, o: O });
    }
    return out;
  }

  // ------------------------------------------------------------------ textures
  texture(stage, res) {
    if (!res) return null;
    const m = this.m, fmtWord = m.r32(res + 12), size = m.r32(res + 16), data = m.r32(res + 4);
    // a surface we rendered into (render-to-texture, back-buffer copies): sample our image, not stale memory
    for (const [s, t] of this.targets) if (s && ((m.r32(s + 4) ^ data) & 0x7fffffff) === 0)
      return { w: t.width, h: t.height, rgba: Uint8Array.from(t.rgba), fmt: (fmtWord >> 8) & 0xff, target: true, linear: !!size };
    const pal = this.d3d.palettes[stage], palData = pal ? m.r32(pal + 4) : 0;
    const key = `${data}:${fmtWord}:${size}:${palData}`;
    let t = this.texCache.get(key); if (t !== undefined) return t;
    const fmt = (fmtWord >> 8) & 0xff; let w, h, pitch = 0;
    if (size) { w = (size & 0xfff) + 1; h = ((size >> 12) & 0xfff) + 1; pitch = (((size >> 24) & 0xff) + 1) * 64; }
    else { w = 1 << ((fmtWord >> 20) & 0xf); h = 1 << ((fmtWord >> 24) & 0xf); }
    const addr = (data | 0x80000000) >>> 0, bytes = Math.max(pitch * h, w * h * 4);
    let rgba = null;
    try {
      const r = m.region(addr), src = r.buf, off = addr - r.base;
      const palBuf = palData ? m.readBytes((palData | 0x80000000) >>> 0, 1024) : null;
      if (fmt === 0x0b && !palBuf) rgba = null; else rgba = decodePixels(fmt, src, off, w, h, palBuf, pitch);
    } catch { rgba = null; }
    if (!rgba) this.skip(`texture format 0x${fmt.toString(16)}`);
    // linear textures take texel (unnormalized) coordinates
    t = rgba ? { w, h, rgba, fmt, linear: !!size } : null; this.texCache.set(key, t); return t;
  }
  sample(t, s, tt, addrU, addrV, linear, out, o) {
    const W = t.w, H = t.h, d = t.rgba;
    const wrap = (c, n, mode) => mode === 1 ? ((c % n) + n) % n : mode === 2 ? (() => { const p = ((c % (2 * n)) + 2 * n) % (2 * n); return p < n ? p : 2 * n - 1 - p; })() : c < 0 ? 0 : c >= n ? n - 1 : c;
    if (!linear) {
      const x = wrap(Math.floor(s * W), W, addrU), y = wrap(Math.floor(tt * H), H, addrV), i = (y * W + x) * 4;
      out[o] = d[i] / 255; out[o + 1] = d[i + 1] / 255; out[o + 2] = d[i + 2] / 255; out[o + 3] = d[i + 3] / 255; return;
    }
    const fx = s * W - 0.5, fy = tt * H - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
    const xa = wrap(x0, W, addrU), xb = wrap(x0 + 1, W, addrU), ya = wrap(y0, H, addrV), yb = wrap(y0 + 1, H, addrV);
    const i00 = (ya * W + xa) * 4, i10 = (ya * W + xb) * 4, i01 = (yb * W + xa) * 4, i11 = (yb * W + xb) * 4;
    for (let k = 0; k < 4; k++) out[o + k] = ((d[i00 + k] * (1 - ax) + d[i10 + k] * ax) * (1 - ay) + (d[i01 + k] * (1 - ax) + d[i11 + k] * ax) * ay) / 255;
  }

  // ------------------------------------------------------------------ pixel pipeline setup
  pixelSetup(st) {
    const d3d = this.d3d, m = this.m, simple = new Map(); for (const [k, v] of Object.entries(st.simple)) simple.set(+k & 0x1ffc, v >>> 0);
    const S = (k, dflt) => simple.has(NV[k]) ? simple.get(NV[k]) : dflt;
    const ts = [0, 1, 2, 3].map(s => Array.from({ length: 32 }, (_, i) => d3d.deferredTextureState(s, i)));
    const tex = [0, 1, 2, 3].map(s => this.texture(s, st.textures[s]));
    let ps = null;
    if (st.pixelShader) { const def = d3d.shaders.get(st.pixelShader)?.def?.def; if (def) ps = parsePS(def); }
    return {
      tex, ts, ps, psConst: d3d.psConst,
      alphaTest: S("ALPHA_TEST_ENABLE", 0), alphaFunc: S("ALPHA_FUNC", 0x207), alphaRef: S("ALPHA_REF", 0) / 255,
      blend: S("BLEND_ENABLE", 0), sf: S("BLEND_SFACTOR", 1), df: S("BLEND_DFACTOR", 0), beq: S("BLEND_EQUATION", 0x8006), bcol: S("BLEND_COLOR", 0),
      depthTest: st.depth && (st.rs.ZEnable ?? 1) && S("DEPTH_TEST_ENABLE", 1), depthFunc: S("DEPTH_FUNC", 0x203), depthMask: S("DEPTH_MASK", 1),
      colorMask: S("COLOR_MASK", 0x01010101), cull: process.env.SOFT_NOCULL ? 0 : st.rs.CullMode ?? 0x901, tfactor: st.rs.TextureFactor ?? 0xffffffff,
      fogColor: st.rs.FogColor ?? 0,
    };
  }

  // ------------------------------------------------------------------ rasterization
  raster(cmd) {
    this.zRemap = !!cmd.zRemap;
    const m = this.m, st = cmd.state;
    // index list
    let idx = [];
    if (cmd.kind === "indexed" || cmd.kind === "indexed-up") for (let i = 0; i < cmd.count; i++) idx.push(m.r16(cmd.indices + i * 2));
    else if (cmd.kind === "immediate") { this.skip("immediate"); return; }
    else { const s = cmd.start ?? 0; for (let i = 0; i < cmd.count; i++) idx.push(s + i); }
    const verts = this.vertices(cmd, new Set(idx)); if (!verts) return;
    const tris = [];
    const P = cmd.prim, n = idx.length;
    if (P === "triangles") for (let i = 0; i + 2 < n; i += 3) tris.push([idx[i], idx[i + 1], idx[i + 2]]);
    else if (P === "triangleStrip") for (let i = 0; i + 2 < n; i++) tris.push(i & 1 ? [idx[i + 1], idx[i], idx[i + 2]] : [idx[i], idx[i + 1], idx[i + 2]]);
    else if (P === "triangleFan" || P === "polygon") for (let i = 1; i + 1 < n; i++) tris.push([idx[0], idx[i], idx[i + 1]]);
    else if (P === "quads") for (let i = 0; i + 3 < n; i += 4) tris.push([idx[i], idx[i + 1], idx[i + 2]], [idx[i], idx[i + 2], idx[i + 3]]);
    else if (P === "quadStrip") for (let i = 0; i + 3 < n; i += 2) tris.push([idx[i], idx[i + 1], idx[i + 3]], [idx[i], idx[i + 3], idx[i + 2]]);
    const t = this.target(st.renderTarget), px = this.pixelSetup(st), zs = this.zScale();
    px.vp = st.viewport;                                   // pixels outside the viewport are not drawn (the rear-view mirror)
    // an inset viewport keeps its rectangle from the full-view draws of the frame (as the page's stencil mask)
    { const v = px.vp, full = !(v && v.w > 0 && v.h > 0) || (v.x <= 0 && v.y <= 0 && v.w >= t.width && v.h >= t.height);
      if (!full) { (t.insets ??= []).some(r => r.x === v.x && r.y === v.y && r.w === v.w && r.h === v.h) || t.insets.push({ ...v }); px.insets = null; }
      else px.insets = t.insets?.length ? t.insets : null; }
    for (const [a, b, c] of tris) {
      const va = verts.get(a), vb = verts.get(b), vc = verts.get(c);
      if (va.sx === vb.sx && va.sy === vb.sy || vb.sx === vc.sx && vb.sy === vc.sy) continue;   // degenerate (strip joins)
      for (const tri of clipTri([va, vb, vc], zs, this.zRemap)) this.triangle(t, tri, px);
    }
  }
  triangle(t, [A, B, C], px) {
    const area = (B.sx - A.sx) * (C.sy - A.sy) - (C.sx - A.sx) * (B.sy - A.sy);
    this.tris = (this.tris ?? 0) + 1; if (!area || !isFinite(area)) return;
    if (px.cull === 0x901 && area < 0) return;           // D3DCULL_CCW
    if (px.cull === 0x900 && area > 0) return;           // D3DCULL_CW
    const W = t.width, H = t.height, zs = this.zScale();
    let minX = Math.max(0, Math.floor(Math.min(A.sx, B.sx, C.sx))), maxX = Math.min(W - 1, Math.ceil(Math.max(A.sx, B.sx, C.sx)));
    let minY = Math.max(0, Math.floor(Math.min(A.sy, B.sy, C.sy))), maxY = Math.min(H - 1, Math.ceil(Math.max(A.sy, B.sy, C.sy)));
    const vp = px.vp; if (vp && vp.w > 0 && vp.h > 0) {
      minX = Math.max(minX, Math.floor(vp.x)); maxX = Math.min(maxX, Math.ceil(vp.x + vp.w) - 1);
      minY = Math.max(minY, Math.floor(vp.y)); maxY = Math.min(maxY, Math.ceil(vp.y + vp.h) - 1); }
    if (minX > maxX || minY > maxY) return;
    const iwA = 1 / A.w, iwB = 1 / B.w, iwC = 1 / C.w;
    const NV_ = 13 * 4, out = new Float32Array(NV_), col = new Float32Array(4), texv = new Float32Array(16);
    const used = [3, 4, 9, 10, 11, 12, 5];
    // edge functions e_k(x) = ax*x + c for a fixed row; covered span = intersection of e_k >= 0 (scaled by sign(area))
    const sg = area > 0 ? 1 : -1, E = [[B, C], [C, A], [A, B]], d3dv = this.d3d;
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5; let xl = minX, xr = maxX;
      for (const [P, Q] of E) {
        // e(x) = (P.sx - x)*(Q.sy - py) - (Q.sx - x)*(P.sy - py) = x*(P.sy - Q.sy) + (P.sx*(Q.sy-py) - Q.sx*(P.sy-py))
        const ax = (P.sy - Q.sy) * sg, c = (P.sx * (Q.sy - py) - Q.sx * (P.sy - py)) * sg;
        if (ax === 0) { if (c < 0) { xl = 1; xr = 0; } continue; }
        const x0 = -c / ax - 0.5;                       // pixel centre x + 0.5 where the edge crosses
        if (ax > 0) xl = Math.max(xl, Math.ceil(x0)); else xr = Math.min(xr, Math.floor(x0));
      }
      const ins = px.insets?.filter(r => y >= r.y && y < r.y + r.h);
      for (let x = xl; x <= xr; x++) {
        if (ins?.length && ins.some(r => x >= r.x && x < r.x + r.w)) continue;
        const pxx = x + 0.5;
        let w0 = (B.sx - pxx) * (C.sy - py) - (C.sx - pxx) * (B.sy - py), w1 = (C.sx - pxx) * (A.sy - py) - (A.sx - pxx) * (C.sy - py);
        w0 /= area; w1 /= area; const w2 = 1 - w0 - w1;
        if (w0 < -1e-7 || w1 < -1e-7 || w2 < -1e-7) continue;
        let z = (w0 * A.sz + w1 * B.sz + w2 * C.sz) / zs; const i = y * W + x; if (this.zRemap) z = z / 128 + 0.5; if (ZCLAMP) z = z < 0 ? 0 : z > 1 ? 1 : z;
        if (px.depthTest && !cmp(px.depthFunc, z, t.depth[i])) { this.dfail = (this.dfail ?? 0) + 1; continue; }
        const p0 = w0 * iwA, p1 = w1 * iwB, p2 = w2 * iwC, ps = 1 / (p0 + p1 + p2);
        for (const r of used) for (let k = 0; k < 4; k++) { const j = r * 4 + k; out[j] = (A.o[j] * p0 + B.o[j] * p1 + C.o[j] * p2) * ps; }
        this.pixels++; if (d3dv.visActive) d3dv.visPixels++;
        if (!this.shade(out, px, col, texv)) continue;
        if (px.depthTest && px.depthMask) t.depth[i] = z;
        this.blend(t, i * 4, col, px);
      }
    }
  }
  shade(v, px, col, texv) {
    // texture fetches
    const modes = px.ps ? px.ps.texModes : null;
    for (let s = 0; s < 4; s++) {
      const tx = px.tex[s], o = s * 4, mode = modes ? modes[s] : (tx ? 1 : 0);
      if (mode === 4) { for (let k = 0; k < 4; k++) texv[o + k] = clamp01(v[(9 + s) * 4 + k]); continue; }
      // no texture: the stage reads as 0 (NV2A with the stage's texture mode off); the fixed-function path uses 1
      if (!tx || !mode) { const v0 = px.ps ? 0 : 1; texv[o] = texv[o + 1] = texv[o + 2] = texv[o + 3] = v0; continue; }
      let q = v[(9 + s) * 4 + 3]; if (mode !== 2 || !q) q = 1;
      const ts = px.ts[s];
      const nx = tx.linear ? tx.w : 1, ny = tx.linear ? tx.h : 1;
      this.sample(tx, v[(9 + s) * 4] / q / nx, v[(9 + s) * 4 + 1] / q / ny, ts[TSS.ADDRESSU] || 1, ts[TSS.ADDRESSV] || 1, ts[TSS.MAGFILTER] >= 2, texv, o);
    }
    if (px.ps) combiners(px.ps, v, texv, px.psConst, col, px.fogColor);
    else fixedStages(px, v, texv, col);
    if (px.alphaTest && !cmp(px.alphaFunc, col[3], px.alphaRef + 1e-6 * 0)) return false;
    return true;
  }
  blend(t, i, col, px) {
    const d = t.rgba, mask = px.colorMask;
    let r = col[0], g = col[1], b = col[2], a = col[3];
    if (px.blend) {
      const dr = d[i] / 255, dg = d[i + 1] / 255, db = d[i + 2] / 255, da = d[i + 3] / 255;
      const bc = [((px.bcol >> 16) & 255) / 255, ((px.bcol >> 8) & 255) / 255, (px.bcol & 255) / 255, (px.bcol >>> 24) / 255];
      const f = (fac, k, src) => blendFactor(fac, k, [r, g, b, a], [dr, dg, db, da], bc);
      const sr = [r, g, b, a], dd = [dr, dg, db, da], res = [0, 0, 0, 0];
      for (let k = 0; k < 4; k++) {
        const s = sr[k] * f(px.sf, k), de = dd[k] * f(px.df, k);
        res[k] = px.beq === 0x800a ? s - de : px.beq === 0x800b ? de - s : px.beq === 0x8007 ? Math.min(sr[k], dd[k]) : px.beq === 0x8008 ? Math.max(sr[k], dd[k]) : s + de;
      }
      [r, g, b, a] = res;
    }
    if (mask & 0x00010000) d[i] = clamp01(r) * 255;
    if (mask & 0x00000100) d[i + 1] = clamp01(g) * 255;
    if (mask & 0x00000001) d[i + 2] = clamp01(b) * 255;
    if (mask & 0x01000000) d[i + 3] = clamp01(a) * 255;
  }
}

// ---------------------------------------------------------------------- helpers
function typeSize(type) {
  if (type === 0x02) return 0; if (type === 0x40) return 4; if (type === 0x16) return 4; if (type === 0x72) return 12;
  const kind = type & 0xf, n = type >> 4;
  return kind === 2 ? n * 4 : kind === 5 || kind === 1 ? n * 2 : kind === 4 ? n : n * 4;
}
function readType(m, a, type, V, o) {
  if (type === 0x02) return;
  if (type === 0x40) { const c = m.r32(a); V[o] = ((c >> 16) & 255) / 255; V[o + 1] = ((c >> 8) & 255) / 255; V[o + 2] = (c & 255) / 255; V[o + 3] = (c >>> 24) / 255; return; }
  if (type === 0x16) { const v = m.r32(a), s = (x, bits) => ((x << (32 - bits)) >> (32 - bits)) / ((1 << (bits - 1)) - 1);
    V[o] = s(v & 0x7ff, 11); V[o + 1] = s((v >> 11) & 0x7ff, 11); V[o + 2] = s((v >> 22) & 0x3ff, 10); V[o + 3] = 1; return; }
  if (type === 0x72) { V[o] = m.rf(a); V[o + 1] = m.rf(a + 4); V[o + 2] = 0; V[o + 3] = m.rf(a + 8); return; }
  const kind = type & 0xf, n = type >> 4;
  for (let k = 0; k < n && k < 4; k++) {
    if (kind === 2) V[o + k] = m.rf(a + k * 4);
    else if (kind === 5) V[o + k] = (m.r16(a + k * 2) << 16) >> 16;
    else if (kind === 1) V[o + k] = Math.max(-1, ((m.r16(a + k * 2) << 16) >> 16) / 32767);
    else if (kind === 4) V[o + k] = m.r8(a + k) / 255;
  }
}
// NV2A depth clamp: no near / far clipping, depth clamped to [0, 1] per pixel (the front-end car preview's projection
// is a 20-unit slab, near 569 / far 589, and the car only shows like this); SOFT_ZCLIP=1: clip at the near plane instead
const ZCLAMP = !process.env.SOFT_ZCLIP;
const ident = () => Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function mul(a, b) { const r = new Float32Array(16); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += a[i * 4 + k] * b[k * 4 + j]; r[i * 4 + j] = s; } return r; }

// clip a triangle in homogeneous screen space (h = (sx*w, sy*w, sz*w, w) is linear in clip space) against
// w > epsilon and the near plane (z >= 0); returns a fan of triangles
function clipTri(tri, zs, clamp) {   // clamp: the car preview's draws (depth clamped, no near clip), like the page
  const E = 1e-5, planes = ZCLAMP ? [v => v.w - E] : [v => v.w - E, v => v.sz * v.w];   // no far clip: the sky sits at z ~1.0
  const inside = v => planes.every(f => f(v) >= 0);
  if (tri.every(inside)) return [tri];
  let poly = tri;
  for (const f of planes) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], fa = f(a), fb = f(b);
      if (fa >= 0) out.push(a);
      if ((fa >= 0) !== (fb >= 0)) {
        const t = fa / (fa - fb), w = a.w + (b.w - a.w) * t, o = new Float32Array(a.o.length);
        for (let k = 0; k < o.length; k++) o[k] = a.o[k] + (b.o[k] - a.o[k]) * t;
        const L = (pa, pb) => (pa * a.w + (pb * b.w - pa * a.w) * t) / w;
        out.push({ sx: L(a.sx, b.sx), sy: L(a.sy, b.sy), sz: L(a.sz, b.sz), w, o });
      }
    }
    poly = out; if (poly.length < 3) return [];
  }
  const res = []; for (let i = 1; i + 1 < poly.length; i++) res.push([poly[0], poly[i], poly[i + 1]]);
  return res;
}
function cmp(f, a, b) {          // GL compare functions (NV2A)
  switch (f & 0xf) { case 0: return false; case 1: return a < b; case 2: return a === b; case 3: return a <= b; case 4: return a > b; case 5: return a !== b; case 6: return a >= b; default: return true; }
}
function blendFactor(f, k, s, d, c) {
  switch (f) {
    case 0: return 0; case 1: return 1;
    case 0x300: return s[k]; case 0x301: return 1 - s[k]; case 0x302: return s[3]; case 0x303: return 1 - s[3];
    case 0x304: return d[3]; case 0x305: return 1 - d[3]; case 0x306: return d[k]; case 0x307: return 1 - d[k];
    case 0x308: return k === 3 ? 1 : Math.min(s[3], 1 - d[3]);
    case 0x8001: return c[k]; case 0x8002: return 1 - c[k]; case 0x8003: return c[3]; case 0x8004: return 1 - c[3];
    default: return 1;
  }
}

// D3D texture stage pipeline (no pixel shader): COLOROP/ALPHAOP with args (DIFFUSE 0, CURRENT 1, TEXTURE 2, TFACTOR 3, SPECULAR 4, TEMP 5)
function fixedStages(px, v, texv, col) {
  const cur = [v[12], v[13], v[14], v[15]], temp = [0, 0, 0, 0];
  const tf = [((px.tfactor >> 16) & 255) / 255, ((px.tfactor >> 8) & 255) / 255, (px.tfactor & 255) / 255, (px.tfactor >>> 24) / 255];
  for (let s = 0; s < 4; s++) {
    const ts = px.ts[s], cop = ts[TSS.COLOROP];
    if (cop <= 1 && s > 0) break;
    const arg = (a, k) => { const sel = a & 0xf; let x = sel === 0 ? v[12 + k] : sel === 1 ? cur[k] : sel === 2 ? texv[s * 4 + k] : sel === 3 ? tf[k] : sel === 4 ? v[16 + k] : temp[k];
      if (a & 0x20) x = sel === 2 ? texv[s * 4 + 3] : x; if (a & 0x10) x = 1 - x; return x; };
    const op = (o, a1, a2, k) => { switch (o) {
      case 2: return a1; case 3: return a2; case 4: return a1 * a2; case 5: return a1 * a2 * 2; case 6: return a1 * a2 * 4; case 7: return a1 + a2;
      case 8: return a1 + a2 - 0.5; case 9: return (a1 + a2 - 0.5) * 2; case 10: return a1 - a2; case 11: return a1 + a2 - a1 * a2;
      default: return a1; } };
    const res = [0, 0, 0, 0];
    // op 1 (DISABLE, set by the game) passes the current colour on even with a texture bound (the race sky with the
    // rear-view mirror on keeps the mirror pass's last texture); op 0 (never set) modulates a bound texture
    const aop = ts[TSS.ALPHAOP], effC = cop === 1 ? 3 : cop === 0 ? (px.tex[s] ? 4 : 3) : cop, effA = aop === 1 ? 3 : aop === 0 ? (px.tex[s] ? 4 : 3) : aop;
    const c1 = cop <= 1 ? 2 : ts[TSS.COLORARG1], c2 = cop <= 1 ? 1 : ts[TSS.COLORARG2], a1 = ts[TSS.ALPHAOP] <= 1 ? 2 : ts[TSS.ALPHAARG1], a2 = ts[TSS.ALPHAOP] <= 1 ? 1 : ts[TSS.ALPHAARG2];
    for (let k = 0; k < 3; k++) res[k] = op(effC, arg(c1, k), arg(c2, k), k);
    res[3] = op(effA, arg(a1, 3), arg(a2, 3), 3);
    for (let k = 0; k < 4; k++) cur[k] = clamp01(res[k]);
  }
  col[0] = cur[0]; col[1] = cur[1]; col[2] = cur[2]; col[3] = cur[3];
}

// ---------------------------------------------------------------------- NV2A register combiners
export function parsePS(def) {
  const u = o => def.readUInt32LE(o), arr = (o, n) => Array.from({ length: n }, (_, i) => u(o + i * 4));
  const tm = u(0xd8);
  return { alphaIn: arr(0x00, 8), finalABCD: u(0x20), finalEFG: u(0x24), c0: arr(0x28, 8), c1: arr(0x48, 8), alphaOut: arr(0x68, 8),
    rgbIn: arr(0x88, 8), fc0: u(0xac), fc1: u(0xb0), rgbOut: arr(0xb4, 8), count: u(0xd4) & 0xff, countFlags: u(0xd4),
    texModes: [tm & 31, (tm >> 5) & 31, (tm >> 10) & 31, (tm >> 15) & 31], c0Map: u(0xe4), c1Map: u(0xe8), finalConsts: u(0xec) };
}
const argb = x => [((x >> 16) & 255) / 255, ((x >> 8) & 255) / 255, (x & 255) / 255, (x >>> 24) / 255];
function mapIn(x, map) {
  switch (map) {
    case 0: return Math.max(0, x); case 1: return 1 - clamp01(x); case 2: return 2 * Math.max(0, x) - 1; case 3: return -2 * Math.max(0, x) + 1;
    case 4: return Math.max(0, x) - 0.5; case 5: return -Math.max(0, x) + 0.5; case 6: return x; default: return -x;
  }
}
// register file (4 floats each): 0 zero, 1 c0, 2 c1, 3 fog, 4 v0, 5 v1, 8-11 t0-t3, 12 r0, 13 r1, 14 v1+r0, 15 e*f
const REG = new Float32Array(16 * 4), IN = new Float32Array(4 * 4), AB = new Float32Array(3), CD = new Float32Array(3), SUM = new Float32Array(3);
function setARGB(r, x) { REG[r * 4] = ((x >> 16) & 255) / 255; REG[r * 4 + 1] = ((x >> 8) & 255) / 255; REG[r * 4 + 2] = (x & 255) / 255; REG[r * 4 + 3] = (x >>> 24) / 255; }
// input mapping of register `code` (8-bit combiner input) into IN[slot]: rgb (alpha=false) or one scalar
function input(code, alpha, slot) {
  const r = (code & 0xf) * 4, ch = (code >> 4) & 1, map = (code >> 5) & 7, o = slot * 4;
  if (alpha) { IN[o] = mapIn(ch ? REG[r + 3] : REG[r + 2], map); return; }
  if (ch) { const x = mapIn(REG[r + 3], map); IN[o] = IN[o + 1] = IN[o + 2] = x; }
  else { IN[o] = mapIn(REG[r], map); IN[o + 1] = mapIn(REG[r + 1], map); IN[o + 2] = mapIn(REG[r + 2], map); }
}
const outScale = (x, m) => { switch (m) { case 1: return x - 0.5; case 2: return x * 2; case 3: return (x - 0.5) * 2; case 4: return x * 4; case 6: return x / 2; default: return x; } };
const cl1 = x => x < -1 ? -1 : x > 1 ? 1 : x;
function combiners(ps, v, texv, psConst, col, fogColor) {
  REG.fill(0);
  setARGB(3, fogColor); REG[15] = clamp01(v[20] ?? 0);
  for (let k = 0; k < 4; k++) { REG[16 + k] = clamp01(v[12 + k]); REG[20 + k] = clamp01(v[16 + k]); }
  for (let k = 0; k < 16; k++) REG[32 + k] = texv[k];
  REG[51] = REG[35];                                   // r0.a starts as t0.a
  const n = Math.max(1, Math.min(8, ps.count));
  for (let i = 0; i < n; i++) {
    setARGB(1, ps.c0[ps.countFlags & 0x1000 ? i : 0]); setARGB(2, ps.c1[ps.countFlags & 0x10000 ? i : 0]);
    const muxSel = REG[51] >= 0.5;
    // RGB portion (computed from the registers before this stage's writes)
    const w = ps.rgbIn[i]; input(w >>> 24, false, 0); input((w >> 16) & 255, false, 1); input((w >> 8) & 255, false, 2); input(w & 255, false, 3);
    const o = ps.rgbOut[i], fl = o >>> 12, m = (fl >> 3) & 7;
    if (fl & 2) AB[0] = AB[1] = AB[2] = IN[0] * IN[4] + IN[1] * IN[5] + IN[2] * IN[6]; else for (let k = 0; k < 3; k++) AB[k] = IN[k] * IN[4 + k];
    if (fl & 1) CD[0] = CD[1] = CD[2] = IN[8] * IN[12] + IN[9] * IN[13] + IN[10] * IN[14]; else for (let k = 0; k < 3; k++) CD[k] = IN[8 + k] * IN[12 + k];
    for (let k = 0; k < 3; k++) SUM[k] = fl & 4 ? (muxSel ? CD[k] : AB[k]) : AB[k] + CD[k];
    // alpha portion
    const wa = ps.alphaIn[i]; input(wa >>> 24, true, 0); input((wa >> 16) & 255, true, 1); input((wa >> 8) & 255, true, 2); input(wa & 255, true, 3);
    const oa = ps.alphaOut[i], fa = oa >>> 12, ma = (fa >> 3) & 7;
    const aab = IN[0] * IN[4], acd = IN[8] * IN[12], asum = fa & 4 ? (muxSel ? acd : aab) : aab + acd;
    // writes
    const wr = (r, src, b2a) => { if (!r) return; for (let k = 0; k < 3; k++) REG[r * 4 + k] = cl1(outScale(src[k], m)); if (b2a) REG[r * 4 + 3] = REG[r * 4 + 2]; };
    wr((o >> 4) & 15, AB, fl & 0x80); wr(o & 15, CD, fl & 0x40); wr((o >> 8) & 15, SUM, 0);
    const wa_ = (r, x) => { if (r) REG[r * 4 + 3] = cl1(outScale(x, ma)); };
    wa_((oa >> 4) & 15, aab); wa_(oa & 15, acd); wa_((oa >> 8) & 15, asum);
  }
  // final combiner: rgb = A*B + (1-A)*C + D, alpha = G; special inputs v1+r0 (14) and E*F (15)
  if (!ps.finalABCD && !ps.finalEFG) { for (let k = 0; k < 4; k++) col[k] = clamp01(REG[48 + k]); return; }
  setARGB(1, ps.fc0); setARGB(2, ps.fc1);
  const fl = ps.finalEFG & 0xff;
  for (let k = 0; k < 4; k++) { const v1 = fl & 0x40 ? 1 - clamp01(REG[20 + k]) : clamp01(REG[20 + k]), r0 = fl & 0x20 ? 1 - clamp01(REG[48 + k]) : clamp01(REG[48 + k]); const sm = v1 + r0; REG[56 + k] = fl & 0x80 ? clamp01(sm) : sm; }
  const fin = (code, alpha, slot) => {           // final combiner inputs: unsigned identity or invert, clamped
    const r = (code & 0xf) * 4, ch = (code >> 4) & 1, inv = (code >> 5) & 1, o = slot * 4, f = x => inv ? 1 - clamp01(x) : clamp01(x);
    if (alpha) { IN[o] = f(ch ? REG[r + 3] : REG[r + 2]); return; }
    if (ch) IN[o] = IN[o + 1] = IN[o + 2] = f(REG[r + 3]); else { IN[o] = f(REG[r]); IN[o + 1] = f(REG[r + 1]); IN[o + 2] = f(REG[r + 2]); }
  };
  fin(ps.finalEFG >>> 24, false, 0); fin((ps.finalEFG >> 16) & 255, false, 1);
  for (let k = 0; k < 3; k++) REG[60 + k] = IN[k] * IN[4 + k];
  fin(ps.finalABCD >>> 24, false, 0); fin((ps.finalABCD >> 16) & 255, false, 1); fin((ps.finalABCD >> 8) & 255, false, 2); fin(ps.finalABCD & 255, false, 3);
  for (let k = 0; k < 3; k++) col[k] = clamp01(IN[k] * IN[4 + k] + (1 - IN[k]) * IN[8 + k] + IN[12 + k]);
  fin((ps.finalEFG >> 8) & 255, true, 0); col[3] = IN[0];
}
