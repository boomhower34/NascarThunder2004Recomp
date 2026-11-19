// d3d-hle.mjs — the game's Direct3D 8 (Xbox XDK 5455, linked into default.exe) re-implemented at its API, so
// drawing goes to a renderer of our own (renderer.mjs) instead of the Xbox GPU.
//
// Boundary (found with XbSymbolDatabase, xbe_symbols.json): the game calls 104 D3D functions (101 identified by
// signature) and writes D3D's deferred state arrays inline (texture stage states at D3D_g_DeferredTextureState
// with dirty flags at 0x19CB68, render states at D3D_g_RenderState / D3D_g_DeferredRenderState). It never
// touches the device structure or the push buffer itself. So:
//  - functions that talk to the GPU (device creation, render targets, clear/present, state setting, shaders,
//    streams, textures, draws, fences, visibility tests) are replaced here;
//  - resource bookkeeping (CreateTexture2, CreateVertexBuffer2, CreatePalette2, Register, GetDesc, LockRect,
//    GetSurfaceLevel2, Release) runs the original code, which only computes headers and allocates contiguous
//    memory — its waits for the GPU (block on resource / fence / push-buffer space) are no-ops here, the GPU is
//    always idle because drawing happens synchronously;
//  - draw calls snapshot the state (including the inline-written deferred arrays) into commands for the renderer.
//
// Memory: resources keep physical addresses in Data (virtual | 0x80000000 on the Xbox). The heap (0x01000000,
// below 0x10000000 like Xbox RAM) is mirrored at 0x81000000 so both forms work; MmGetPhysicalAddress strips bit 31.
//
// Xbox D3D structures used: resource { Common (refcount 0-15, type 16-18: 0 vertex buffer, 1 index buffer,
// 2 push buffer, 3 palette, 4 texture, 5 surface, 6 fixup), Data, Lock }; pixel container + { Format, Size }
// (Format: dimension 4-7, color format 8-15, mip levels 16-19, log2 width 20-23, height 24-27, depth 28-31;
// Size for linear surfaces: width-1 0-11, height-1 12-23, pitch/64-1 24-31); surface + { Parent }.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SYMBOLS = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "xbe_symbols.json"), "utf8")).symbols;
export const sym = name => SYMBOLS[name];

// D3D internals (no signatures in the database) that wait for the GPU: no-ops in HLE
const GPU_WAITS = {
  0x192040: "D3D BlockOnResource", 0x1920c0: "D3D BlockOnNonSurfaceResource", 0x191d00: "D3D BlockOnTime (fence)",
  0x191fc0: "D3D push buffer: make space / kick off", 0x191e40: "D3D push buffer: wait",
};
const FF = new Float32Array(1), FU = new Uint32Array(FF.buffer);
const PRIM = ["", "points", "lines", "lineLoop", "lineStrip", "triangles", "triangleStrip", "triangleFan", "quads", "quadStrip", "polygon"];

// a Map that counts its changes (state() snapshots are rebuilt only after one)
class GenMap extends Map {
  constructor() { super(); this.gen = 0; }
  set(k, v) { if (super.get(k) !== v || !super.has(k)) this.gen++; return super.set(k, v); }
  delete(k) { if (super.has(k)) this.gen++; return super.delete(k); }
  clear() { this.gen++; return super.clear(); }
}

const COUNT_CALLS = !!process.env.NT04_D3D_COUNTS;
// D3D setters with a native version in the recompiled code (recomp.mjs nhook ids)
const NATIVE_SETTERS = { SetStreamSource: 1, SetPalette: 2, SetVertexShaderConstant4: 3, SetVertexShaderConstant1: 4, SetVertexShaderConstant1Fast: 4,
  SetVertexShaderConstantNotInline: 5, SetVertexShaderConstantNotInlineFast: 5, SetPixelShaderConstant: 6 };
export class D3D {
  constructor(game, renderer) {
    this.g = game; this.m = game.mem; this.r = renderer;
    this.rs = new GenMap();               // render states set through SetRenderState_* (name -> value)
    this.simple = new GenMap();           // SetRenderState_Simple: NV2A method -> value
    this.ts = Array.from({ length: 4 }, () => new Map());   // texture stage states set through SetTextureState_*
    this.textures = [0, 0, 0, 0]; this.palettes = [0, 0, 0, 0];
    this.streams = [];                    // { vb, stride }
    this.vsConst = new Float32Array(192 * 4); this.psConst = new Float32Array(32 * 4);
    this.vsDirtyLo = 0; this.vsDirtyHi = 192;          // vertex shader constant registers written since a renderer last looked
    this.transforms = new Map(); this.viewport = { x: 0, y: 0, w: 640, h: 480, minZ: 0, maxZ: 1 };
    this.vertexShader = 0; this.pixelShader = 0; this.shaders = new Map(); this.nextShader = 0;
    this.immediate = null; this.fence = 0; this.pushOffset = 0; this.frame = 0; this.stats = { draws: 0, prims: 0, frames: 0 };
    this.vblankCallback = 0; this.swapCallback = 0; this.vblanks = 0; this.waits = 0; this.calls = {};
    this.install();
  }
  // ---------------------------------------------------------------- shared state
  // Stream sources, palettes and shader constants move into the recompiled module's state block (recomp.mjs NST, at
  // `base` in guest memory `buf`), so its native setters and these hooks write the same place: streams become 16
  // objects reading the block, palettes / constants typed-array views of it, the vertex dirty range two words of it.
  shareState(buf, base) {
    if (this.shared) return; const u = new Uint32Array(buf, base, 1024), i32 = new Int32Array(buf, base, 1024);
    const old = this.streams; this.streams = Array.from({ length: 16 }, (_, i) => ({ get vb() { return u[2 * i]; }, get stride() { return u[2 * i + 1]; } }));
    old.forEach((x, i) => { if (x) this.setStream(i, x.vb, x.stride); });
    const pal = new Uint32Array(buf, base + 32 * 4, 4); pal.set(this.palettes); this.palettes = pal;
    const vs = new Float32Array(buf, base + 64 * 4, 768); vs.set(this.vsConst); this.vsConst = vs;
    const ps = new Float32Array(buf, base + 832 * 4, 128); ps.set(this.psConst); this.psConst = ps;
    i32[36] = this.vsDirtyLo; i32[37] = this.vsDirtyHi;
    Object.defineProperty(this, "vsDirtyLo", { get: () => i32[36], set: v => { i32[36] = v; }, configurable: true });
    Object.defineProperty(this, "vsDirtyHi", { get: () => i32[37], set: v => { i32[37] = v; }, configurable: true });
    this.sharedU32 = u; this.sharedI32 = i32; this.shared = true;   // (gl-remote reads the dirty range straight from i32[36], i32[37])
  }
  setStream(i, vb, stride) {
    if (this.shared && i < 16) { this.sharedU32[2 * i] = vb; this.sharedU32[2 * i + 1] = stride; return; }
    this.streams[i] = { vb, stride };
  }
  // ---------------------------------------------------------------- helpers
  hook(name, fn) {
    const s = sym(name); if (!s) throw new Error(`no symbol ${name}`);
    const pop = s.stackBytes ?? 0;
    // per-name call counts only when asked for (NT04_D3D_COUNTS=1): a race frame makes thousands of D3D calls, and
    // counting them by name in a ~200-key object was a visible part of the frame
    if (COUNT_CALLS) this.g.hooks.set(s.addr, c => { this.calls[name] = (this.calls[name] ?? 0) + 1; const v = fn(c); c.r[4] += pop; return v ?? 0; });
    else {
      const h = c => { const v = fn(c); c.r[4] += pop; return v ?? 0; };
      // setters the recompiled code can run itself (recomp.mjs nhook) once the state lives in its memory (shareState)
      const id = NATIVE_SETTERS[name.replace(/^D3DDevice_/, "")]; if (id) h.recompNative = { id, pop, d3d: this };
      this.g.hooks.set(s.addr, h);
    }
  }
  f(u) { FU[0] = u >>> 0; return FF[0]; }
  surface(w, h, format, bpp) {             // a linear surface the game can lock (back buffer, depth buffer)
    const m = this.m, s = this.g.alloc(0x18), pitch = Math.ceil(w * bpp / 64) * 64, data = this.g.alloc(pitch * h);
    m.w32(s, 0x00050001 | 0x01000000);     // surface, refcount 1, created by D3D
    m.w32(s + 4, data & 0x7fffffff); m.w32(s + 8, 0);
    m.w32(s + 12, 0x00000001 | 0x20 | (format << 8));        // DMA channel A, 2D, format
    m.w32(s + 16, (w - 1) | ((h - 1) << 12) | ((pitch / 64 - 1) << 24)); m.w32(s + 20, 0);
    return s;
  }
  addRef(p) { if (p) this.m.w32(p, (this.m.r32(p) & 0xffff0000) | ((this.m.r32(p) + 1) & 0xffff)); return p; }
  // deferred states the game writes inline (read at draw time)
  deferredTextureState(stage, i) { return this.m.r32((this.dtsAddr ??= sym("D3D_g_DeferredTextureState").addr) + (stage * 32 + i) * 4); }
  // the render-state maps become plain objects only when they changed since the last snapshot (a race frame has
  // ~900 draws; rebuilding them per draw was a visible part of the frame time with the browser renderer)
  state() {
    if (this.rsSnapGen !== this.rs.gen) { this.rsSnap = Object.fromEntries(this.rs); this.rsSnapGen = this.rs.gen; }
    if (this.simpleSnapGen !== this.simple.gen) { this.simpleSnap = Object.fromEntries(this.simple); this.simpleSnapGen = this.simple.gen; }
    return {
      rs: this.rsSnap, simple: this.simpleSnap, textures: [...this.textures],
      streams: this.streams.map(s => s && { ...s }), vertexShader: this.vertexShader, pixelShader: this.pixelShader,
      viewport: { ...this.viewport }, renderTarget: this.renderTarget, depth: this.depthSurface,
    };
  }
  draw(cmd) {
    this.stats.draws++; this.stats.prims += cmd.count;
    // the state snapshot is only built for renderers that draw (NullRenderer only counts)
    // (cmd is the hook's own new object: filled in rather than copied)
    cmd.prim = PRIM[cmd.primitive] ?? cmd.primitive; cmd.zRemap = this.zRemap; cmd.state = this.r.wantsState === false ? null : this.state();
    this.r.draw(cmd);
  }

  install() {
    const m = this.m, g = this.g, H = (n, f) => this.hook(n, f);
    // mirror the heap at its "virtual contiguous" address (physical | 0x80000000)
    m.map((0x80000000 | g.heap.base) >>> 0, g.heap.buf);
    for (const [a, what] of Object.entries(GPU_WAITS)) g.hooks.set(+a, c => { g.note(+a, what); c.r[4] += POPS[a] ?? 0; return 0; });

    // ------------------------------------------------ device
    H("D3D_SetPushBufferSize", () => 0);
    H("Direct3D_CreateDevice", c => {
      const pp = c.arg(4), out = c.arg(5), w = m.r32(pp) || 640, h = m.r32(pp + 4) || 480;
      const dev = g.alloc(0x2000); m.w32(sym("D3D_g_pDevice").addr, dev);
      this.width = w; this.height = h;
      this.backBuffer = this.surface(w, h, 0x1e, 4);          // LIN_X8R8G8B8
      this.depthSurface = this.surface(w, h, 0x2e, 4);        // LIN_D24S8
      this.renderTarget = this.backBuffer;
      if (out) m.w32(out, dev);
      this.viewport = { x: 0, y: 0, w, h, minZ: 0, maxZ: 1 }; this.viewportConstants();
      this.r.init?.({ width: w, height: h });
      g.log(`d3d: device ${w}x${h}`);
      return 0;
    });
    H("D3DDevice_Release", () => 0);
    H("D3DDevice_GetBackBuffer2", () => this.addRef(this.backBuffer));
    H("D3DDevice_GetRenderTarget2", () => this.addRef(this.renderTarget));
    H("D3DDevice_GetDepthStencilSurface2", () => this.addRef(this.depthSurface));
    // like D3D8, setting a render target resets the viewport to the whole surface
    H("D3DDevice_SetRenderTarget", c => { if (c.arg(0)) this.renderTarget = c.arg(0); this.depthSurface = c.arg(1);
      const sz = m.r32(this.renderTarget + 16), w = sz ? (sz & 0xfff) + 1 : this.width, h = sz ? ((sz >> 12) & 0xfff) + 1 : this.height;
      this.viewport = { x: 0, y: 0, w, h, minZ: 0, maxZ: 1 }; this.viewportConstants();
      this.r.setRenderTarget?.(this.renderTarget, this.depthSurface); });
    H("D3DDevice_Clear", c => { this.r.clear({ flags: c.arg(2), color: c.arg(3), z: this.f(c.arg(4)), stencil: c.arg(5), rects: c.arg(0) }); });
    H("D3DDevice_Swap", () => {
      this.stats.frames++; this.frame++; this.r.present(this.stats); this.stats.draws = 0; this.stats.prims = 0;
      this.waits++; this.vblank(); return 0;
    });
    // (waits: the vertical blanks the game waited for, Swap and BlockUntilVerticalBlank; main.mjs paces live play by
    // them: a frame that waits for two takes two 60 Hz periods, as on the Xbox)
    // (oneWait: the host runs a 30 fps scene at 60 by letting its extra wait pass without a vertical blank, so the
    // frame takes one period and the game's vblank delta says 1; main.mjs sets it for the replay screens)
    H("D3DDevice_BlockUntilVerticalBlank", () => { if (this.oneWait) return; this.waits++; this.vblank(); });
    H("D3DDevice_SetVerticalBlankCallback", c => { this.vblankCallback = c.arg(0); });
    H("D3DDevice_SetFlickerFilter", () => 0); H("D3DDevice_SetGammaRamp", () => 0);
    H("D3DDevice_InsertFence", () => ++this.fence); H("D3DDevice_BlockOnFence", () => 0);
    H("D3DDevice_GetPushBufferOffset", c => { if (c.arg(0)) m.w32(c.arg(0), this.pushOffset += 0x100); });
    // visibility (occlusion) tests: everything visible
    // visibility tests (the sun glare uses one to see how much of the sun is unoccluded): pixels that pass the depth
    // test between Begin and End, counted by renderers that draw (renderer.countsPixels); 0 otherwise
    this.visResults = new Map();
    H("D3DDevice_BeginVisibilityTest", () => { this.visPixels = 0; this.visActive = true; });
    H("D3DDevice_EndVisibilityTest", c => { this.visActive = false; this.visResults.set(c.arg(0), this.r.countsPixels ? this.visPixels : 0); });
    H("D3DDevice_GetVisibilityTestResult", c => { if (c.arg(1)) m.w32(c.arg(1), this.visResults.get(c.arg(0)) ?? 0); if (c.arg(2)) { m.w32(c.arg(2), this.frame); m.w32(c.arg(2) + 4, 0); } return 0; });

    // ------------------------------------------------ viewport, transforms, render and texture states
    H("D3DDevice_SetViewport", c => { const p = c.arg(0); this.viewport = { x: m.r32(p), y: m.r32(p + 4), w: m.r32(p + 8), h: m.r32(p + 12), minZ: m.rf(p + 16), maxZ: m.rf(p + 20) }; this.viewportConstants(); });
    H("D3DDevice_GetViewport", c => { const p = c.arg(0), v = this.viewport; m.w32(p, v.x); m.w32(p + 4, v.y); m.w32(p + 8, v.w); m.w32(p + 12, v.h); m.wf(p + 16, v.minZ); m.wf(p + 20, v.maxZ); });
    H("D3DDevice_SetTransform", c => { this.transforms.set(c.arg(0), m.readBytes(c.arg(1), 64)); });
    H("D3DDevice_GetTransform", c => { const t = this.transforms.get(c.arg(0)); if (t) m.writeBytes(c.arg(1), t); else for (let i = 0; i < 16; i++) m.wf(c.arg(1) + i * 4, i % 5 === 0 ? 1 : 0); });
    H("D3DDevice_SetScissors", c => { this.scissors = { count: c.arg(0), exclusive: c.arg(1), rects: c.arg(2) }; });
    H("D3DDevice_LightEnable", c => { this.rs.set(`light${c.arg(0)}`, c.arg(1)); });
    H("D3DDevice_SetRenderState_Simple", c => { this.simple.set(c.r[1], c.r[2]); });
    for (const [name, s] of Object.entries(SYMBOLS)) {
      let k = name.match(/^D3DDevice_SetRenderState_(\w+)$/);
      if (k && k[1] !== "Simple") {
        const key = k[1], v = SYMBOLS[`D3DRS_${key}`];
        H(name, c => { this.rs.set(key, c.arg(0)); if (v) m.w32(v.addr, c.arg(0)); });   // keep D3D's own copy for code that reads it
      }
      k = name.match(/^D3DDevice_SetTextureState_(\w+)$/);
      if (k) { const key = k[1]; H(name, c => { this.ts[c.arg(0) & 3].set(key, s.stackBytes > 8 ? [c.arg(1), c.arg(2)] : c.arg(1)); }); }
    }
    H("D3DDevice_SetRenderStateNotInline", c => { this.rs.set(`#${c.arg(0)}`, c.arg(1)); });

    // ------------------------------------------------ shaders and constants
    const newShader = (kind, def) => { const h = g.alloc(0x20); this.shaders.set(h, { kind, def }); return h; };
    H("D3DDevice_CreateVertexShader", c => {
      const decl = c.arg(0), fn = c.arg(1), h = newShader("vertex", { decl, fn, usage: c.arg(3) }) | 1;   // shader handles are odd (FVF codes are even)
      if (c.arg(2)) m.w32(c.arg(2), h); return 0;
    });
    H("D3DDevice_DeleteVertexShader", () => 0);
    H("D3DDevice_GetVertexShaderSize", c => { if (c.arg(1)) m.w32(c.arg(1), 0); return 0; });
    H("D3DDevice_LoadVertexShader", c => { this.vsLoaded = { handle: c.arg(0), address: c.arg(1) }; });
    H("D3DDevice_SelectVertexShader", c => { this.vertexShader = c.arg(0) || this.vertexShader; this.vsAddress = c.arg(1); });
    H("D3DDevice_SetVertexShader", c => { this.vertexShader = c.arg(0); });
    H("D3DDevice_SetShaderConstantMode", c => { this.constantMode = c.arg(0); });
    // The register passed in ecx is already the hardware index (0-191 = API -96..95; the inline wrappers add 96),
    // the NotInline count is in dwords. D3D also keeps a shadow copy at 0x19BF50 (16 bytes per register).
    // fast path: source and D3D's shadow copy as views of game memory (one bulk copy each, no per-dword calls)
    const view = (a, n) => { try { const r = m.region(a), o = (a >>> 0) - r.base; return o + n <= r.buf.length ? r.buf.subarray(o, o + n) : null; } catch { return null; } };
    const vsc = (reg, p, dwords) => {
      const n = this.vsConst.length, j0 = ((reg * 4) % n + n) % n;
      const src = j0 + dwords <= n ? view(p, dwords * 4) : null, dst = src ? view(0x19bf50 + j0 * 4, dwords * 4) : null;
      if (src && dst && (src.byteOffset & 3) === 0) {
        this.vsConst.set(new Float32Array(src.buffer, src.byteOffset, dwords), j0); dst.set(src);
        this.vsDirtyLo = Math.min(this.vsDirtyLo, j0 >> 2); this.vsDirtyHi = Math.max(this.vsDirtyHi, ((j0 + dwords - 1) >> 2) + 1);
        return;
      }
      for (let i = 0; i < dwords; i++) { const v = m.r32(p + i * 4), j = (reg * 4 + i) % n;
        this.vsConst[j] = this.f(v); m.w32(0x19bf50 + j * 4, v); this.vsDirtyLo = Math.min(this.vsDirtyLo, j >> 2); this.vsDirtyHi = Math.max(this.vsDirtyHi, (j >> 2) + 1); } };
    H("D3DDevice_SetVertexShaderConstant1", c => vsc(c.r[1] | 0, c.r[2], 4));
    H("D3DDevice_SetVertexShaderConstant1Fast", c => vsc(c.r[1] | 0, c.r[2], 4));
    H("D3DDevice_SetVertexShaderConstant4", c => vsc(c.r[1] | 0, c.r[2], 16));
    H("D3DDevice_SetVertexShaderConstantNotInline", c => vsc(c.r[1] | 0, c.r[2], c.arg(0)));
    H("D3DDevice_SetVertexShaderConstantNotInlineFast", c => vsc(c.r[1] | 0, c.r[2], c.arg(0)));
    H("D3DDevice_CreatePixelShader", c => { const h = newShader("pixel", { def: m.readBytes(c.arg(0), 0x2f0) }); if (c.arg(1)) m.w32(c.arg(1), h); return 0; });
    H("D3DDevice_DeletePixelShader", () => 0);
    H("D3DDevice_SetPixelShader", c => { this.pixelShader = c.arg(0); });
    H("D3DDevice_SetPixelShaderConstant", c => { for (let i = 0; i < c.arg(2) * 4; i++) this.psConst[(c.arg(0) * 4 + i) % this.psConst.length] = m.rf(c.arg(1) + i * 4); });

    // ------------------------------------------------ streams, textures, palettes
    H("D3DDevice_SetStreamSource", c => { this.setStream(c.arg(0), c.arg(1), c.arg(2)); });
    H("D3DDevice_SetTexture", c => { this.textures[c.arg(0) & 3] = c.arg(1); });
    // SwitchTexture(method, data, format): a fast texture change written straight into the push buffer
    // (NV097_SET_TEXTURE_OFFSET(stage) = 0x1B00 + stage * 0x40, then the format word). It is turned into a small
    // stand-in texture resource for that stage, so drawing sees the new texture.
    H("D3DDevice_SwitchTexture", c => {
      const stage = (((c.r[1] & 0x1ffc) - 0x1b00) / 0x40) | 0; if (stage < 0 || stage > 3) return;
      this.switchRes ??= [0, 1, 2, 3].map(() => g.alloc(0x20)); const r = this.switchRes[stage];
      m.w32(r, 0x00040001); m.w32(r + 4, c.r[2]); m.w32(r + 12, c.arg(0)); m.w32(r + 16, 0);
      this.textures[stage] = r; });
    H("D3DDevice_SetPalette", c => { this.palettes[c.arg(0) & 3] = c.arg(1); });

    // ------------------------------------------------ drawing
    H("D3DDevice_DrawVertices", c => this.draw({ kind: "vertices", primitive: c.arg(0), start: c.arg(1), count: c.arg(2) }));
    H("D3DDevice_DrawIndexedVertices", c => this.draw({ kind: "indexed", primitive: c.arg(0), count: c.arg(1), indices: c.arg(2) }));
    H("D3DDevice_DrawVerticesUP", c => this.draw({ kind: "vertices-up", primitive: c.arg(0), count: c.arg(1), data: c.arg(2), stride: c.arg(3) }));
    H("D3DDevice_DrawIndexedVerticesUP", c => this.draw({ kind: "indexed-up", primitive: c.arg(0), count: c.arg(1), indices: c.arg(2), data: c.arg(3), stride: c.arg(4) }));
    // immediate mode: Begin, SetVertexData* per register (the last register written, 0 = position, closes a vertex), End
    H("D3DDevice_Begin", c => { this.immediate = { primitive: c.arg(0), vertices: [], cur: {} }; });
    const vdata = (reg, v) => { const im = this.immediate; if (!im) return; im.cur[reg] = v; if (reg === 0) { im.vertices.push(im.cur); im.cur = { ...im.cur }; delete im.cur[0]; } };
    H("D3DDevice_SetVertexData2f", c => vdata(c.arg(0), [this.f(c.arg(1)), this.f(c.arg(2)), 0, 1]));
    H("D3DDevice_SetVertexData4f", c => vdata(c.arg(0), [this.f(c.arg(1)), this.f(c.arg(2)), this.f(c.arg(3)), this.f(c.arg(4))]));
    H("D3DDevice_SetVertexData4ub", c => vdata(c.arg(0), [c.arg(1) & 0xff, c.arg(2) & 0xff, c.arg(3) & 0xff, c.arg(4) & 0xff].map(x => x / 255)));
    H("D3DDevice_End", () => { const im = this.immediate; this.immediate = null; if (im) this.draw({ kind: "immediate", primitive: im.primitive, count: im.vertices.length, vertices: im.vertices }); });
  }
  // Xbox D3D keeps the viewport transform in vertex shader constants c-38 (scale) and c-37 (offset); the shader
  // assembler appends code using them, so shaders output screen-space positions. z is in depth-buffer units.
  viewportConstants() {
    const v = this.viewport, ds = this.depthSurface, f = ds ? (this.m.r32(ds + 12) >> 8) & 0xff : 0x2a;
    const zs = f === 0x2c || f === 0x30 || f === 0x2d || f === 0x31 ? 65535 : 16777215, C = this.vsConst;
    C.set([v.w * 0.5, -v.h * 0.5, (v.maxZ - v.minZ) * zs, 0], 58 * 4);
    C.set([v.w * 0.5 + v.x + 0.53125, v.h * 0.5 + v.y + 0.53125, v.minZ * zs, 0], 59 * 4);
    this.vsDirtyLo = Math.min(this.vsDirtyLo, 58); this.vsDirtyHi = Math.max(this.vsDirtyHi, 60);
  }
  vblank() {
    this.vblanks++; this.g.lastVblankSteps = this.g.cpu?.steps ?? 0;                         // D3DVBLANKDATA { VBlank count, Swap count, Flags }
    if (!this.vblankCallback) return;
    const d = this.g.alloc(16); this.m.w32(d, this.vblanks); this.m.w32(d + 4, this.stats.frames); this.m.w32(d + 8, 0);
    try { this.g.interrupt(this.vblankCallback, [d]); } catch (e) { this.g.log(`d3d: vblank callback: ${e.message.slice(0, 160)}`); }
    this.g.free(d);
  }
}

// bytes the GPU-wait internals pop (stdcall); taken from their ret instructions
const POPS = { 0x192040: 4, 0x1920c0: 4, 0x191d00: 8, 0x191fc0: 0, 0x191e40: 8 };
