// gl-remote.mjs — a renderer (renderer.mjs interface) that records each frame's draw calls in a form a WebGL2
// client draws (play-client.js): the GPU does the work the NV2A did, the emulator only gathers what it reads.
//
// Two halves, so the expensive part can run on another thread:
//   capture (RemoteRenderer, on the emulator thread, inside the game's draw calls): only what needs the game's memory
//     at that moment. Per draw it writes plain numbers into a command buffer (no objects): primitive, index and
//     vertex blocks, changed vertex shader constants (only the registers written since the last draw: d3d-hle
//     vsDirtyLo/Hi), texture references, render target, viewport, render / texture-stage states. Vertex and index
//     blocks are hashed in place and copied only when their bytes changed; textures are probed once per frame and
//     their source bytes copied only when the probe changed. Ids of buffers, textures and vertex programs are given
//     here (the caches and their eviction live here).
//   packing (FramePacker): turns a captured frame into the message the client reads: decodes the copied texture
//     sources, interns pixel states (ids given there), builds the JSON and the blob area. With { worker: true } it
//     runs in gl-remote-worker.mjs (the captured frame is transferred, not copied) and the message comes back to
//     `sink`; otherwise in-thread (offline tools).
//
// Message (binary): u32 json length, json { frame, res: [...], cmds: [...] }, padding to 4, then the blobs the json
// refers to by index ([offset, length] in a table at the end of the json).
// Frames are only recorded while the client keeps up (ready() after it acknowledged the previous one).

import { NullRenderer } from "./renderer.mjs";
import { readVsh, constantsRead, vshToGLSL } from "../xbox/nv2a-vsh.mjs";
import { decodePixels, decodeIndices, Formats } from "../game/mmap-tex.mjs";
import { parsePS } from "./soft-renderer.mjs";

const NV = { ALPHA_TEST_ENABLE: 0x300, BLEND_ENABLE: 0x304, CULL_FACE_ENABLE: 0x308, DEPTH_TEST_ENABLE: 0x30c, ALPHA_FUNC: 0x33c,
  ALPHA_REF: 0x340, BLEND_SFACTOR: 0x344, BLEND_DFACTOR: 0x348, BLEND_COLOR: 0x34c, BLEND_EQUATION: 0x350, DEPTH_FUNC: 0x354,
  COLOR_MASK: 0x358, DEPTH_MASK: 0x35c };
const TSS = { ADDRESSU: 0, ADDRESSV: 1, MAGFILTER: 3, MINFILTER: 4, COLOROP: 12, COLORARG1: 14, COLORARG2: 15, ALPHAOP: 16, ALPHAARG1: 18, ALPHAARG2: 19 };
const STAGE_KEYS = [TSS.COLOROP, TSS.COLORARG1, TSS.COLORARG2, TSS.ALPHAOP, TSS.ALPHAARG1, TSS.ALPHAARG2];
// the texture stage words a draw's state is made of (record's st: address modes, magnification filter; pixelState: STAGE_KEYS)
const TSS_USED = Int32Array.from([0, 1, 2, 3].flatMap(s => [TSS.ADDRESSU, TSS.ADDRESSV, TSS.MAGFILTER, ...STAGE_KEYS].map(k => s * 32 + k)));
const EVICT_FRAMES = 600;           // cached blocks unused this long are freed on both sides
// primitive names as d3d-hle gives them (and the client draws them); quads / quad strips / polygons become triangles
const PRIMS = ["points", "lines", "lineStrip", "triangles", "triangleStrip", "triangleFan", "lineLoop"];
const PRIM_CODE = Object.fromEntries(PRIMS.map((p, i) => [p, i]));
const OP_DRAW = 1, OP_CLEAR = 2, OP_PRESENT = 3, OP_BLIT = 4, OP_DRAW_SAME = 5;
// OP_DRAW_SAME: a draw whose state (program, target, viewport, render states, pixel state, textures: the ST_WORDS
// words below) is the same as the draw before it in the frame, with nothing else between them: only prim, count,
// index buffer, attributes and the changed constants are sent, and the page keeps everything else as it was. (Most
// race draws repeat the previous draw's state: 89 % of the ~2,200 draws a frame on Indianapolis's front stretch.)
const ST_WORDS = 48;
const NO_QUICK = !!process.env.NT04_GL_NO_QUICK || !!process.env.NT04_GL_NO_SAME, NO_SAME = !!process.env.NT04_GL_NO_SAME;   // (NO_SAME: every draw in full, as before)   // (check: the stream must not change without the quick state check)
const IN_FLIGHT = Math.max(1, +(process.env.NT04_GL_IN_FLIGHT ?? 6));    // frames sent but not yet acknowledged   // (6: the capture-to-acknowledgement time spikes to 25-45 ms in heavy race frames; with 3 that skipped up to 8 frames a second)

// 32-bit FNV-style hash over a byte range: four independent lanes over aligned words (the multiplies overlap),
// tail bytes folded in
function hashBytes(b) {
  const n = b.length >> 2, len = b.length;
  let h0 = 0x811c9dc5 ^ len, h1 = 0x01000193, h2 = 0x5bd1e995, h3 = 0x27d4eb2f, i = 0;
  if ((b.byteOffset & 3) === 0) {
    const w = new Int32Array(b.buffer, b.byteOffset, n);
    for (; i + 3 < n; i += 4) { h0 = Math.imul(h0 ^ w[i], 16777619); h1 = Math.imul(h1 ^ w[i + 1], 16777619); h2 = Math.imul(h2 ^ w[i + 2], 16777619); h3 = Math.imul(h3 ^ w[i + 3], 16777619); }
    for (; i < n; i++) h0 = Math.imul(h0 ^ w[i], 16777619);
  } else {
    const dv = new DataView(b.buffer, b.byteOffset, len);
    for (; i < n; i++) h0 = Math.imul(h0 ^ dv.getInt32(i * 4, true), 16777619);
  }
  for (let k = n * 4; k < len; k++) h0 = Math.imul(h0 ^ b[k], 16777619);
  return (Math.imul(h0 ^ (h1 >>> 7), 0x9e3779b1) ^ Math.imul(h2 ^ (h3 >>> 11), 0x85ebca6b)) >>> 0;
}

// 64 words spread over a block (blocks of 512 bytes and more)
function probeBytes(b) {
  const n = b.length >> 2, step = Math.max(1, (n >> 6)); let h = 0x811c9dc5;
  if ((b.byteOffset & 3) === 0) { const w = new Int32Array(b.buffer, b.byteOffset, n); for (let i = 0; i < n; i += step) h = Math.imul(h ^ w[i], 16777619); }
  else for (let i = 0; i < b.length; i += step * 4) h = Math.imul(h ^ b[i], 16777619);
  return h >>> 0;
}
const STABLE = 60;                  // unchanged checks in a row before a block / texture is fully checked only every 4th frame

// byte chunks + a word command buffer for one frame (all transferable). Resource bytes go into 1 MB chunks (a bigger
// one for a bigger item): nothing is ever copied twice. (One growable buffer doubled and copied its contents as a
// heavy frame filled it — the race weekend's first frame carries ~21 MB of new textures — and with the worker every
// frame starts from a fresh arena.) A resource's bytes are addressed as chunk index * CHUNK_TAG + offset.
const CHUNK = 1 << 20, CHUNK_TAG = 2 ** 32;
class FrameArena {
  constructor() { this.chunks = [new Uint8Array(CHUNK)]; this.used = [0]; this.nb = 0; this.words = new Int32Array(1 << 16); this.f = new Float32Array(this.words.buffer); this.nw = 0; }
  put(src) {                                  // copy bytes in, 4-aligned; returns the address
    let i = this.chunks.length - 1, off = (this.used[i] + 3) & ~3;
    if (off + src.length > this.chunks[i].length) { this.chunks.push(new Uint8Array(Math.max(CHUNK, src.length))); this.used.push(0); i++; off = 0; }
    this.chunks[i].set(src, off); this.used[i] = off + src.length; this.nb += src.length; return i * CHUNK_TAG + off;
  }
  room(n) { if (this.nw + n > this.words.length) { const w = new Int32Array(Math.max(this.nw + n, this.words.length * 2)); w.set(this.words.subarray(0, this.nw)); this.words = w; this.f = new Float32Array(w.buffer); } }
  w(v) { this.words[this.nw++] = v | 0; }
  wf(v) { this.f[this.nw++] = v; }
  reset() { this.chunks.length = 1; this.used = [0]; this.nb = 0; this.nw = 0; }
}
// the bytes of a resource in a frame's chunks
const chunkBytes = (chunks, addr, len) => { const i = Math.floor(addr / CHUNK_TAG), o = addr - i * CHUNK_TAG; return new Uint8Array(chunks[i], o, len); };

export class RemoteRenderer extends NullRenderer {
  constructor(game, { worker = false } = {}) {
    super(); this.g = game; this.m = game.mem;
    this.recording = false; this.credits = 0; this.frameNo = 0; this.epoch = 0;
    this.vs = new Map(); this.bufs = new Map(); this.texs = new Map(); this.nextId = 1;
    this.constShadow = new Float32Array(192 * 4).fill(NaN); this.targets = new Map(); this.lastProg = null;
    this.blitTex = new Map(); this.frameTex = new Map(); this.frameBufs = new Map(); this.psDefs = new Map(); this.pendingPs = [];
    this.stats = { frames: 0, draws: 0, skipped: {} }; this.diag = { sent: 0, noCredit: 0, ackN: 0, ackSum: 0, ackMax: 0 }; this.sentT = [];
    this.newFrame();
    this.packer = new FramePacker();
    if (worker) this.startWorker();
  }
  async startWorker() {
    const { Worker, MessageChannel, receiveMessageOnPort } = await import("node:worker_threads");
    const w = this.worker = new Worker(new URL("./gl-remote-worker.mjs", import.meta.url));
    // packed frames come back on a port of their own: read as events normally, and synchronously (drain) while the
    // game is in the middle of a long call (see urgent)
    const ch = new MessageChannel(); w.postMessage({ port: ch.port2 }, [ch.port2]);
    this.port = ch.port1; this.receive = receiveMessageOnPort; this.waitCell = new Int32Array(new SharedArrayBuffer(4));
    this.port.on("message", m => this.packed(m)); this.port.unref();
    w.on("error", e => { this.g.log?.(`gl-remote worker: ${e.message}`); this.worker = null; });
    w.unref();
  }
  packed({ ab, epoch }) { this.inFlight--; if (epoch === this.epoch) this.sink?.(Buffer.from(ab)); }   // frames packed before a reset are dropped
  // wait for the worker to hand back every frame given to it, and send them (in order) now
  drain() {
    if (!this.worker || !this.port) return;
    for (let spins = 0; this.inFlight > 0 && spins < 2000; spins++) {
      const r = this.receive(this.port); if (r) { this.packed(r.message); continue; }
      Atomics.wait(this.waitCell, 0, 0, 1);
    }
  }
  // Long calls. The game sometimes runs for seconds inside one call while it keeps presenting: entering the race
  // loading screen fades the screen in (63 presents in a row), then loads the race while a background thread fills
  // the loading bar. No acknowledgement can arrive meanwhile, so these frames are taken without flow control, sent
  // as soon as they are made (the socket writes them at once), and marked to be shown one per screen refresh
  // ("hold"), where the page would otherwise draw a backlog down at once. main.mjs sets g.liveMark at the start of
  // every frame (+33 ms); past it, the frame is a long one.
  urgent() { return !!this.sink && performance.now() > (this.g.liveMark ?? Infinity); }
  newFrame() { this.arena = new FrameArena(); this.res = []; this.stValid = false; }
  get d3d() { return this.g.d3d; }
  // d3d-hle's state snapshot object is not needed: capture reads the device state directly
  get wantsState() { return false; }
  // flow control: the page acknowledges each frame it has drawn; up to IN_FLIGHT frames may be on their way, so the
  // next frame is captured while the page still draws the previous one (with one frame at a time, the capture,
  // transfer and drawing of every frame ran one after another: ~10-12 fps in races whatever the game's speed)
  ready() { this.credits = Math.min(this.credits + 1, IN_FLIGHT);
    // (diagnostics for the status line: time from capture to the page's acknowledgement)
    const t = this.sentT?.shift(); if (t !== undefined) { const d = performance.now() - t, q = this.diag; q.ackN++; q.ackSum += d; if (d > q.ackMax) q.ackMax = d; } }
  // per-second diagnostics (main.mjs sendInfo): frames sent, frames not captured for lack of credits, ack latency
  takeDiag() { const q = this.diag; this.diag = { sent: 0, noCredit: 0, ackN: 0, ackSum: 0, ackMax: 0 }; return q; }
  // the client is new (or reconnected): forget what it has, on both halves
  reset() {
    this.blitTex.clear(); this.frameTex.clear(); this.frameBufs.clear(); this.itab?.clear(); this.vtab?.clear(); this.ttab?.clear(); this.vs.clear(); this.bufs.clear(); this.texs.clear(); this.psDefs.clear(); this.psByHash?.clear(); this.pendingPs = []; this.psLast = undefined;
    this.constShadow.fill(NaN); this.lastProg = null; this.newFrame(); this.recording = false; this.credits = IN_FLIGHT;
    if (this.g.d3d) { this.g.d3d.vsDirtyLo = 0; this.g.d3d.vsDirtyHi = 192; }    // the client gets every constant again
    this.epoch++; this.packer.reset(); this.worker?.postMessage({ reset: true }); this.sentT = [];
  }
  skip(k) { this.stats.skipped[k] = (this.stats.skipped[k] ?? 0) + 1; }
  init(info) { super.init(info); this.width = info.width; this.height = info.height; }
  surfaceInfo(s) {
    const m = this.m; if (!s) return [0, this.width ?? 640, this.height ?? 480];
    const size = m.r32(s + 16), data = m.r32(s + 4) & 0x7fffffff;
    return [data, size ? (size & 0xfff) + 1 : this.width ?? 640, size ? ((size >> 12) & 0xfff) + 1 : this.height ?? 480];
  }
  zScale() { const ds = this.d3d.depthSurface, f = ds ? (this.m.r32(ds + 12) >> 8) & 0xff : 0x2a; return f === 0x2c || f === 0x30 || f === 0x2d || f === 0x31 ? 65535 : 16777215; }

  clear(c) {
    super.clear(c); if (!this.recording) return;
    const [id, w, h] = this.surfaceInfo(this.d3d.renderTarget); this.targets.set(id, [w, h]);
    // + the viewport: Clear without rects clears the viewport's rectangle (the rear-view mirror clears its 182 x 60
    // strip of the back buffer, not the whole picture)
    this.stValid = false;
    const vp = this.d3d.viewport, A = this.arena; A.room(11); A.w(OP_CLEAR); A.w(id); A.w(w); A.w(h); A.w(c.flags >>> 0); A.w(c.color >>> 0); A.wf(c.z ?? 1);
    A.wf(vp.x); A.wf(vp.y); A.wf(vp.w); A.wf(vp.h);
  }
  present(stats) {
    super.present(stats);
    if (this.recording) {
      const [id, w, h] = this.surfaceInfo(this.d3d.backBuffer), A = this.arena;
      A.room(4); A.w(OP_PRESENT); A.w(id); A.w(w); A.w(h); this.stValid = false;
      this.send(this.urgentFrame);
    }
    this.frameNo++; this.frameTex.clear(); this.frameBufs.clear();
    this.presentStep = this.g.stepNo; this.nextRecording();
  }
  // main.mjs, at the start of every frame: a frame taken without a credit because it followed a present in the same
  // frame (a burst, see nextRecording) is given back if the frame ended without another present and nothing was drawn
  stepBegin() {
    if (!this.urgentFrame || this.arena.nw > 0 || this.res.length) return;
    this.urgentFrame = false;
    if (this.credits > 0) this.credits--; else { this.recording = false; if (this.sink) this.diag.noCredit++; }
  }
  // whether the next frame is recorded: with a credit, or (taken without one) inside a long call
  nextRecording() {
    this.urgentFrame = false;
    if (!this.sink) { this.recording = false; return; }
    if (this.credits > 0) { this.recording = true; this.credits--; }
    // a long frame, or another present coming in the frame that just presented: the loading screen's fade-in is 63
    // presents in a row, all inside one frame and, on a fast computer, all within its first 33 ms (only the first,
    // darkest few got credits, and the bar was then drawn over a dim picture)
    else if (this.urgent() || (this.presentStep !== undefined && this.presentStep === this.g.stepNo)) { this.recording = true; this.urgentFrame = true; }
    else { this.recording = false; this.diag.noCredit++; }
  }
  // the captured frame out: to the worker (or packed here); an urgent one goes out on the socket at once, held
  send(urgent) {
    this.stats.frames++; this.diag.sent++; this.sentT.push(performance.now());
    this.evict();
    const A = this.arena, hold = urgent || this.urgent() || this.presentStep === this.g.stepNo ? 1 : 0;
    // the UI layer as the game left it before the long call (the menu closed for the loading screen): main.mjs
    // sends it every other frame, which a long call holds back, and the page would draw the old menu over these
    if (hold && this.uiStep !== this.g.stepNo) { this.uiStep = this.g.stepNo; this.drain(); this.beforeUrgent?.(); }
    // fit43: the race loading screen is up ([0x2F3052], set by its tip-screen set-up 0x72F30 / 0x73210, cleared when
    // its exit 0x73660 is done): its 2D picture is shown 4:3 by the page rather than stretched
    const fit43 = this.m.r8(0x2f3052) ? 1 : 0;
    const frame = { epoch: this.epoch, frame: this.frameNo, res: this.res, psDefs: this.pendingPs, words: A.words.buffer, nw: A.nw, chunks: A.chunks.map(c => c.buffer), hold, fit43 };
    this.pendingPs = [];
    if (this.worker) { this.inFlight = (this.inFlight ?? 0) + 1; this.worker.postMessage(frame, [frame.words, ...frame.chunks]); this.newFrame(); if (hold) this.drain(); }
    else { this.sink?.(this.packer.pack(frame)); A.reset(); this.res = []; this.stValid = false; }   // packed into a new message: the arena is free again
  }
  // The loading screen's background thread copies the loading bar straight into the front buffer (0xEC6D0, without a
  // present). Here it becomes a blit of the bar image into the picture last presented, sent at once.
  frontBlit(b) {
    if (!this.sink) return;
    if (!this.recording) { if (!this.urgent() && this.credits <= 0) return; if (this.credits > 0) this.credits--; this.recording = true; }
    const px = b.read(), hsh = hashBytes(px); let e = this.blitTex.get(b.key);
    if (!e) { e = { id: this.nextId++, hash: -1 }; this.blitTex.set(b.key, e); }
    if (e.hash !== hsh) { e.hash = hsh; const off = this.arena.put(px); this.res.push({ op: "rawtex", id: e.id, w: b.sw, h: b.sh, off, len: px.length }); }
    this.stValid = false; const A = this.arena; A.room(8); A.w(OP_BLIT); A.w(e.id); A.w(b.sw); A.w(b.sh); A.w(b.x); A.w(b.y); A.w(b.w); A.w(b.h);
    this.send(true); this.nextRecording();
  }
  evict() {
    if (this.frameNo % 30 !== 0) return;                   // freeing takes 600 unused frames: no need to look every frame
    for (const map of [this.bufs, this.texs]) for (const [k, e] of map) if (this.frameNo - e.used > EVICT_FRAMES) { map.delete(k); e.dead = true; this.res.push({ op: "free", id: e.id }); }
    if (this.frameNo % 600 === 0) { for (const [k, e] of this.itab ?? []) if (e.be.dead) this.itab.delete(k); for (const [k, e] of this.vtab ?? []) if (e.e.dead) this.vtab.delete(k); for (const [k, e] of this.ttab ?? []) if (e.e.dead) this.ttab.delete(k); }   // entries of freed blocks
  }
  // a block of game memory cached under `key` (hashed in place; copied into the frame only when its bytes changed)
  // A block whose bytes stayed the same for STABLE checks in a row is fully hashed only every 4th frame (its own
  // phase); in between a sample of 64 words of it is compared, so a rewrite still shows at once and an edit of a few
  // vertices within 3 frames. (Hashing every vertex block in full every frame was ~4 % of a race frame.)
  block(key, bytes, index) {
    let id = this.frameBufs.get(key); if (id !== undefined) return id;
    let e = this.bufs.get(key);
    if (!e) { e = { id: this.nextId++, hash: -1, same: 0, probe: 0 }; this.bufs.set(key, e); }
    this.blockE(e, bytes, index); this.frameBufs.set(key, e.id); return e.id;
  }
  // the change check and upload of a block's entry (block, and the vertex blocks' own table in record)
  blockE(e, bytes, index) {
    e.used = this.frameNo;
    if (e.same >= STABLE && ((this.frameNo + e.id) & 3) !== 0 && bytes.length >= 512 && probeBytes(bytes) === e.probe) return;
    const h = hashBytes(bytes);
    if (e.hash !== h) { e.hash = h; e.same = 0; const off = this.arena.put(bytes); this.res.push({ op: "buf", id: e.id, off, len: bytes.length, index: index || undefined }); }
    else if (++e.same === STABLE || e.same > STABLE) e.probe = bytes.length >= 512 ? probeBytes(bytes) : 0;
  }
  // a view of game memory (no copy), cut at the end of its region; null when unmapped
  view(a, n) { try { const r = this.m.region(a), o = (a >>> 0) - r.base; return r.buf.subarray(o, Math.min(r.buf.length, o + n)); } catch { return null; } }

  // ------------------------------------------------------------------ vertex programs
  program(handle) {
    let p = this.vs.get(handle); if (p !== undefined) return p;
    p = null;
    const def = this.d3d.shaders.get(handle & ~1)?.def;
    if (def) {
      const regs = parseDecl(this.m, def.decl), prog = def.fn ? readVsh(this.m, def.fn) : null;
      regs.regs = regs.regs.filter(r => r.type !== 0x02);              // no data: reads (0, 0, 0, 1)
      if (prog) {
        // Every NV2A program leaves oPos in screen space: the assembler appends the viewport transform (c-38 scale,
        // c-37 offset), and a "screenspace" program (no such epilogue: the loading screen's 2D quads, a plain
        // pass-through of pixel positions) writes pixels itself. Treating the latter as clip space put the loading
        // screen's picture far off screen (black fade-in).
        const screen = true, { src, writesC } = vshToGLSL(prog.words, regs.regs, screen);
        if (writesC) this.skip("vertex program writes constants (ignored)");
        p = { id: this.nextId++, regs: regs.regs, constRegs: new Map(regs.consts), screen };
        // 2D programs (oPos copied from an input, no constants: the HUD's pixel-position quads) and the input each
        // texture stage's coordinates are copied from, for the edge clamp in record()
        if ((src.match(/C\[/g) ?? []).length === 1) {
          const mov = o => new RegExp(`\\{ vec4 a = v(\\d+), b = v\\1, c = v\\1;\\s*m = a;\\s*O\\[${o}\\]\\.xyzw = m\\.xyzw;`).exec(src)?.[1];
          if (mov(0) !== undefined) p.uvReg = [9, 10, 11, 12].map(o => { const v = mov(o); return v === undefined ? -1 : +v; });
        }
        this.res.push({ op: "vs", id: p.id, src });
      }
    }
    this.vs.set(handle, p); return p;
  }

  // ------------------------------------------------------------------ draws
  draw(cmd) {
    super.draw(cmd); if (!this.recording) return;
    try { this.record(cmd); this.stats.draws++; } catch (e) { this.skip(`error ${e.message.slice(0, 80)}`); }
  }
  simpleMap() {                                // NV2A method -> value, rebuilt only when the states changed
    const s = this.d3d.simple;
    if (this.simpleGen !== s.gen || !this.simpleM) { const mp = this.simpleM = new Map(); for (const [k, v] of s) mp.set(+k & 0x1ffc, v >>> 0); this.simpleGen = s.gen; }
    return this.simpleM;
  }
  // the deferred texture stage states (4 stages x 32 words, written by the game inline) as a view of game memory
  tssWords() {
    let t = this.tss;
    if (!t || t.buffer !== this.tssBuf) {
      const v = this.view(this.d3d.dtsAddr ?? (this.d3d.deferredTextureState(0, 0), this.d3d.dtsAddr), 512);
      t = this.tss = v && v.length >= 512 && (v.byteOffset & 3) === 0 ? new Int32Array(v.buffer, v.byteOffset, 128) : null;
      this.tssBuf = t?.buffer;
    }
    return t;
  }
  tssv(stage, k) { const t = this.tss; return t ? t[stage * 32 + k] >>> 0 : this.d3d.deferredTextureState(stage, k); }
  record(cmd) {
    const m = this.m, d3d = this.d3d, A = this.arena; this.tssWords();
    if (cmd.kind === "immediate") { this.skip("immediate (Begin/End)"); return; }
    const vsh = d3d.vertexShader >>> 0;
    if (!(vsh & 1)) { this.skip("fixed-function vertices"); return; }
    const prog = this.program(vsh); if (!prog) { this.skip("no vertex program"); return; }
    // indices and the vertex range they use
    let idx = null, minV = 0, maxV = 0, count = cmd.count, ib = 0;
    let ptype = cmd.prim, prim = PRIM_CODE[ptype] ?? -1;
    const convert = ptype === "quads" || ptype === "quadStrip" || ptype === "polygon";
    if (cmd.kind === "indexed" || cmd.kind === "indexed-up") {
      if (!count) return;
      const raw = this.view(cmd.indices, count * 2);
      // fast path: the same index bytes at the same address as before (hash of the raw bytes) reuse the uploaded,
      // rebased buffer and its vertex range; no copy, scan or second hash
      const ikey = !convert && raw && raw.length >= count * 2 && count < 0x80000 && prim >= 0 ? -1 - ((cmd.indices >>> 1) + 2147483648 * (prim + 8 * count)) : null;
      if (ikey !== null) {
        // index blocks by a small-integer key checked against the entry (the double keys boxed a number per lookup);
        // an entry unchanged for STABLE checks is fully hashed every 4th frame, a 64-word sample in between
        const addr = cmd.indices >>> 0, ik = ((addr >>> 1) + Math.imul(count, 40503) + Math.imul(prim, 7919)) & 0x3fffffff, it = this.itab ??= new Map();
        const ie = it.get(ik), nb = count * 2;
        if (ie !== undefined && ie.addr === addr && ie.count === count && ie.prim === prim && !ie.be.dead) {
          let ok = ie.frame === this.frameNo;
          if (!ok) {
            const bytes = raw.subarray(0, nb);
            if (ie.same >= STABLE && nb >= 512 && ((this.frameNo + ie.id) & 3) !== 0) ok = probeBytes(bytes) === ie.probe;
            else if (hashBytes(bytes) === ie.h) { ok = true; if (++ie.same >= STABLE) ie.probe = nb >= 512 ? probeBytes(bytes) : 0; }
            if (ok) { ie.frame = this.frameNo; ie.be.used = this.frameNo; }
          }
          if (ok) { ib = ie.id; minV = ie.minV; maxV = ie.maxV; }
        }
        if (!ib) {
          const h = hashBytes(raw.subarray(0, nb));
          if (!this.idxScratch || this.idxScratch.length < count) this.idxScratch = new Uint16Array(Math.max(count, 65536));
          idx = this.idxScratch.subarray(0, count); new Uint8Array(idx.buffer, idx.byteOffset, nb).set(raw.subarray(0, nb));
          minV = 65535; maxV = 0; for (let i = 0; i < count; i++) { const v = idx[i]; if (v < minV) minV = v; if (v > maxV) maxV = v; }
          for (let i = 0; i < count; i++) idx[i] -= minV;
          this.frameBufs.delete(ikey); ib = this.block(ikey, new Uint8Array(idx.buffer, idx.byteOffset, nb), true);
          it.set(ik, { addr, count, prim, h, id: ib, minV, maxV, be: this.bufs.get(ikey), frame: this.frameNo, same: 0, probe: 0 });
        }
      } else {
        if (!this.idxScratch || this.idxScratch.length < count) this.idxScratch = new Uint16Array(Math.max(count, 65536));
        idx = this.idxScratch.subarray(0, count);
        if (raw && raw.length >= count * 2) new Uint8Array(idx.buffer, idx.byteOffset, count * 2).set(raw.subarray(0, count * 2)); else for (let i = 0; i < count; i++) idx[i] = m.r16(cmd.indices + i * 2);
        minV = 65535; for (let i = 0; i < count; i++) { const v = idx[i]; if (v < minV) minV = v; if (v > maxV) maxV = v; }
      }
    } else { minV = cmd.start ?? 0; maxV = minV + count - 1; }
    // primitives without a WebGL equivalent become indexed triangles
    if (convert) {
      const src = idx ?? Uint16Array.from({ length: count }, (_, i) => minV + i), out = [];
      if (ptype === "quads") for (let i = 0; i + 3 < count; i += 4) out.push(src[i], src[i + 1], src[i + 2], src[i], src[i + 2], src[i + 3]);
      else if (ptype === "quadStrip") for (let i = 0; i + 3 < count; i += 2) out.push(src[i], src[i + 1], src[i + 3], src[i], src[i + 3], src[i + 2]);
      else for (let i = 1; i + 1 < count; i++) out.push(src[0], src[i], src[i + 1]);
      idx = Uint16Array.from(out); count = idx.length; prim = PRIM_CODE.triangles;
    }
    if (prim < 0) { this.skip(`primitive ${ptype}`); return; }
    if (idx && !ib) {
      const key = count < 0x80000 ? -1 - ((cmd.indices >>> 1) + 2147483648 * (prim + 8 * count)) : `i:${cmd.indices >>> 0}:${count}:${minV}:${prim}`;
      ib = this.frameBufs.get(key) ?? 0;
      if (!ib) { for (let i = 0; i < idx.length; i++) idx[i] -= minV; ib = this.block(key, new Uint8Array(idx.buffer, idx.byteOffset, count * 2), true); }
    }
    // vertex data: per stream the bytes of the vertices used
    const up = cmd.kind.endsWith("-up"), sidStamp = this.sidStamp ??= new Int32Array(32), sidId = this.sidId ??= new Int32Array(32), sidStr = this.sidStr ??= new Int32Array(32);
    let attrs = this.attrScratch ??= new Int32Array(16 * 5), na = 0; const stamp = this.sidN = ((this.sidN ?? 0) + 1) | 0;
    for (const r of prog.regs) {
      const sk = r.stream & 31;
      if (sidStamp[sk] !== stamp) {
        let base, stride;
        if (up) { base = cmd.data >>> 0; stride = cmd.stride; }
        else { const ss = d3d.streams[r.stream]; if (!ss?.vb) continue; base = (m.r32(ss.vb + 4) | 0x80000000) >>> 0; stride = ss.stride; }
        const start = (base + minV * stride) >>> 0, len = (maxV - minV + 1) * stride;
        if (len <= 0 || len > 16 << 20) continue;
        // vertex blocks by a small-integer key (start, length) checked against the entry: a Map keyed by
        // start + length * 2^32 boxed a number per lookup (~6 % of a race frame in lookups and garbage)
        const vk = ((start >>> 2) + Math.imul(len, 40503)) & 0x3fffffff, vt = this.vtab ??= new Map(); let ve = vt.get(vk), id;
        if (ve !== undefined && ve.start === start && ve.len === len && !ve.e.dead) {
          if (ve.frame === this.frameNo) id = ve.e.id;
          else { const v = this.view(start, len + 4); if (!v || v.length < len) continue; this.blockE(ve.e, v); ve.frame = this.frameNo; id = ve.e.id; }
        } else {
          const key = len < 0x200000 ? start + len * 4294967296 : `v:${start}:${len}`; id = this.frameBufs.get(key);
          if (id === undefined) { const v = this.view(start, len + 4); if (!v || v.length < len) continue; id = this.block(key, v); }   // + 4: reads past the last stride
          if (ve === undefined || ve.e.dead) vt.set(vk, { start, len, e: this.bufs.get(key), frame: this.frameNo });
        }
        sidStamp[sk] = stamp; sidId[sk] = id; sidStr[sk] = stride;
      }
      if (na + 5 > attrs.length) { const a2 = new Int32Array(attrs.length * 2); a2.set(attrs); this.attrScratch = attrs = a2; }   // (more than 16 attributes)
      attrs[na++] = r.reg; attrs[na++] = sidId[sk]; attrs[na++] = r.offset; attrs[na++] = sidStr[sk]; attrs[na++] = r.type;
    }
    // HUD quads drawn by pixel position with texture coordinates inside 0..1 sample their textures clamped: the
    // game leaves the stages on wrap, and with the render scale above 1 the first column of samples inside such a
    // quad's left / top edge (at fractional positions: the track map's left edge is at x 425.6) filtered in the
    // texture's opposite edge, a thin line down the screen that 640 x 480 never shows (no pixel centre that close)
    let clampMask = 0;
    if (prog.uvReg && maxV - minV < 16) clampMask = this.hudClamp(prog, cmd, minV, maxV);
    // Quick check first: nothing that the state words come from changed since the previous draw (the device's state
    // handles and change counters, the textures' data words, the texture stage states in game memory) -> the same
    // state without working it out again (texture probes, pixel state, render state lookups: ~2 µs of a draw).
    {
      const q = this.qNow ??= new Float64Array(24), vp0 = d3d.viewport, tx0 = d3d.textures, pl = d3d.palettes;
      q[0] = d3d.vertexShader >>> 0; q[1] = d3d.pixelShader >>> 0; q[2] = d3d.renderTarget >>> 0; q[3] = d3d.depthSurface >>> 0; q[4] = d3d.simple.gen; q[5] = d3d.rs.gen;
      q[6] = cmd.zRemap ? 1 : 0; q[7] = this.frameNo;
      for (let s = 0; s < 4; s++) { const t = tx0[s] >>> 0; q[8 + s] = t; q[12 + s] = t ? m.r32(t + 4) >>> 0 : 0; q[16 + s] = t ? m.r32(t + 12) >>> 0 : 0; q[20 + s] = pl[s] >>> 0; }
      const T = this.tss; let same = this.stValid && this.qVp === vp0 && !!T && !NO_QUICK;
      const qp = this.qPrev ??= new Float64Array(24), tp = this.tssPrev ??= new Int32Array(128);
      if (same) for (let i = 0; i < 24; i++) if (q[i] !== qp[i]) { same = false; break; }
      if (same) for (let j = 0; j < TSS_USED.length; j++) { const i = TSS_USED[j]; if (T[i] !== tp[i]) { same = false; break; } }
      if (clampMask !== (this.qClamp ?? 0)) { same = false; this.qClamp = clampMask; }
      if (same) {
        A.room(5 + na); A.w(OP_DRAW_SAME); A.w(prim); A.w(count); A.w(ib);
        A.w(na / 5); for (let i = 0; i < na; i++) A.w(attrs[i]);
        this.constants(prog);
        return;
      }
      qp.set(q); this.qVp = vp0; if (T) tp.set(T); else this.qVp = null;
    }
    // the draw's state into st (ST_WORDS words), compared with the previous draw's
    let rtc = this.rtCache; const rtH0 = d3d.renderTarget;
    if (!rtc || rtc[0] !== rtH0 || rtc[4] !== this.frameNo) { const [i, w, h] = this.surfaceInfo(rtH0); this.targets.set(i, [w, h]); rtc = this.rtCache = [rtH0, i, w, h, this.frameNo]; }
    const rtId = rtc[1], rtW = rtc[2], rtH = rtc[3];
    const st = this.stNow ??= new Int32Array(ST_WORDS), stf = this.stNowF ??= new Float32Array(st.buffer), vp = d3d.viewport;
    st[0] = prog.id; st[1] = rtId; st[2] = rtW; st[3] = rtH; st[4] = prog.screen ? 1 : 0; st[5] = cmd.zRemap ? -this.zScale() : this.zScale();
    stf[6] = vp.x; stf[7] = vp.y; stf[8] = vp.w; stf[9] = vp.h; st[10] = d3d.depthSurface ? 1 : 0;
    // render states
    const S = this.simpleMap(), sv = (k, d) => S.get(k) ?? d, rs = d3d.rs;   // k: NV2A method numbers (NV)
    st[11] = sv(0x304, 0); st[12] = sv(0x344, 1); st[13] = sv(0x348, 0); st[14] = sv(0x350, 0x8006); st[15] = sv(0x34c, 0);
    st[16] = rs.get("ZEnable") ?? 1; st[17] = sv(0x30c, 1); st[18] = sv(0x354, 0x203); st[19] = sv(0x35c, 1); st[20] = sv(0x358, 0x01010101);
    st[21] = rs.get("CullMode") ?? 0x901;
    // depth bias (D3DRS_ZBIAS 0..16: SetRenderState_ZBias 0x18F8B0 sets NV2A polygon offset factor -0.25 v, units -v,
    // enabled for v != 0): the race's decals — grass edges along the pavement, writing on the walls — lie on the
    // surfaces under them and drew in and out of them without it
    st[22] = rs.get("ZBias") ?? 0;
    // textures and the pixel state
    const tex = this.texScratch ??= [null, null, null, null], tx = d3d.textures;
    for (let s = 0; s < 4; s++) tex[s] = this.texture(s, tx[s]);
    st[23] = this.pixelState(tex, sv, rs);
    for (let s = 0, o = 24; s < 4; s++, o += 6) {
      const t = tex[s];
      if (!t) { st[o] = 0; st[o + 1] = 0; st[o + 2] = 0; st[o + 3] = 0; st[o + 4] = 0; st[o + 5] = 0; }
      else { st[o] = t.rt ? 2 : 1; st[o + 1] = t.rt ? t.rt : t.id; st[o + 2] = t.w; st[o + 3] = t.h; st[o + 4] = t.linear ? 1 : 0;
        let au = this.tssv(s, TSS.ADDRESSU) || 1, av = this.tssv(s, TSS.ADDRESSV) || 1;
        if (clampMask & (1 << s)) { if (au === 1) au = 3; if (av === 1) av = 3; }
        st[o + 5] = au | (av << 8) | ((this.tssv(s, TSS.MAGFILTER) >= 2 ? 1 : 0) << 16); }
    }
    let same = this.stValid && !NO_SAME; const prev = this.stPrev ??= new Int32Array(ST_WORDS);
    if (same) for (let i = 0; i < ST_WORDS; i++) if (st[i] !== prev[i]) { same = false; break; }
    if (same) {
      A.room(5 + na); A.w(OP_DRAW_SAME); A.w(prim); A.w(count); A.w(ib);
      A.w(na / 5); for (let i = 0; i < na; i++) A.w(attrs[i]);
      this.constants(prog);
      return;
    }
    prev.set(st); this.stValid = true;
    A.room(32 + na);
    A.w(OP_DRAW); A.w(prim); A.w(count); A.w(ib); A.w(st[0]); A.w(st[1]); A.w(st[2]); A.w(st[3]); A.w(st[4]); A.w(st[5]);
    A.wf(stf[6]); A.wf(stf[7]); A.wf(stf[8]); A.wf(stf[9]); A.w(st[10]);
    A.w(na / 5); for (let i = 0; i < na; i++) A.w(attrs[i]);
    this.constants(prog);
    A.room(13 + 24); for (let i = 11; i < ST_WORDS; i++) A.w(st[i]);
  }
  // stages whose texture coordinates (copied straight from a float input by a 2D program) stay inside 0..1 for
  // every vertex of the draw
  hudClamp(prog, cmd, minV, maxV) {
    const m = this.m, up = cmd.kind.endsWith("-up"); let mask = 0;
    for (let s = 0; s < 4; s++) {
      const reg = prog.uvReg[s]; if (reg < 0 || !this.d3d.textures[s]) continue;
      const r = prog.regs.find(x => x.reg === reg); if (!r || (r.type & 0xf) !== 2 || (r.type >> 4) < 2) continue;
      let base, stride;
      if (up) { base = cmd.data >>> 0; stride = cmd.stride; }
      else { const ss = this.d3d.streams[r.stream]; if (!ss?.vb) continue; base = (m.r32(ss.vb + 4) | 0x80000000) >>> 0; stride = ss.stride; }
      let ok = true;
      for (let v = minV; v <= maxV && ok; v++) { const a = (base + v * stride + r.offset) >>> 0, u = m.rf(a), t = m.rf(a + 4);
        if (!(u >= -1e-4 && u <= 1.0001 && t >= -1e-4 && t <= 1.0001)) ok = false; }
      if (ok) mask |= 1 << s;
    }
    return mask;
  }
  // vertex shader constants that changed since the last draw: only registers written since then (d3d-hle tracks
  // them) and those of the declaration constants of this program and the previous one
  constants(prog) {
    const d3d = this.d3d, A = this.arena, C = d3d.vsConst, sh = this.constShadow, own = prog.constRegs, own0 = own.size === 0;
    const chg = this.chg ??= new Int32Array(192); let nc = 0;
    const visit = v => {                       // a register visited twice is unchanged the second time
      let diff = false;
      for (let k = 0; k < 4; k++) { const i = v * 4 + k, x = own0 || !own.has(i) ? C[i] : own.get(i); if (!Object.is(x, sh[i])) { diff = true; sh[i] = x; } }
      if (diff) chg[nc++] = v;
    };
    // the dirty range straight from the shared state block when there is one (d3d-hle's accessor properties cost
    // ~2 % of a race frame at ~2,000 draws)
    const I = d3d.sharedI32, lo = I ? I[36] : d3d.vsDirtyLo, hi = I ? I[37] : d3d.vsDirtyHi;
    if (own0 && this.lastProg === prog) {
      // compared as bits (the same as Object.is but for NaN payloads, which then only cost an upload)
      if (this.cI?.buffer !== C.buffer || this.cI.byteOffset !== C.byteOffset) this.cI = new Int32Array(C.buffer, C.byteOffset, C.length);
      const Ci = this.cI, shI = this.shI ??= new Int32Array(sh.buffer, sh.byteOffset, sh.length);
      for (let v = lo; v < hi; v++) { const b = v * 4;
        if (Ci[b] !== shI[b] || Ci[b + 1] !== shI[b + 1] || Ci[b + 2] !== shI[b + 2] || Ci[b + 3] !== shI[b + 3]) {
          shI[b] = Ci[b]; shI[b + 1] = Ci[b + 1]; shI[b + 2] = Ci[b + 2]; shI[b + 3] = Ci[b + 3]; chg[nc++] = v; } }
    } else for (let v = lo; v < hi; v++) visit(v);
    if (I) { I[36] = 192; I[37] = 0; } else { d3d.vsDirtyLo = 192; d3d.vsDirtyHi = 0; }
    if (this.lastProg !== prog) { if (this.lastProg) for (const i of this.lastProg.constRegs.keys()) visit(i >> 2); for (const i of own.keys()) visit(i >> 2); this.lastProg = prog; chg.subarray(0, nc).sort(); }
    // runs of consecutive registers
    let nr = 0; for (let j = 0; j < nc; j++) if (j === 0 || chg[j] !== chg[j - 1] + 1) nr++;
    A.room(1 + nr * 2 + nc * 4); A.w(nr);
    for (let j = 0; j < nc;) { let e = j + 1; while (e < nc && chg[e] === chg[e - 1] + 1) e++;
      const a = chg[j], n = e - j; A.w(a); A.w(n); for (let i = a * 4; i < (a + n) * 4; i++) A.wf(sh[i]); j = e; }
  }

  // ------------------------------------------------------------------ textures
  texture(stage, res) {
    if (!res) return null;
    const m = this.m, d3d = this.d3d, fmtWord = m.r32(res + 12), size = m.r32(res + 16), data = m.r32(res + 4) & 0x7fffffff;
    if (this.targets.has(data)) { const [w, h] = this.targets.get(data); return { rt: data, w, h, linear: !!size }; }
    const pal = d3d.palettes[stage], palData = pal ? m.r32(pal + 4) : 0;
    if (palData && !size && this.g.pitBox) { const pb = this.pitBoxTexture(fmtWord, data, palData); if (pb) return pb; }
    let list = this.frameTex.get(data), memo;             // per frame: data address -> [fmt, size, palette, result]...
    if (list) for (let i = 0; i < list.length; i += 4) if (list[i] === fmtWord && list[i + 1] === size && list[i + 2] === palData) { memo = list[i + 3]; break; }
    if (memo === undefined) {
      memo = this.texture0(null, fmtWord, size, data, palData);
      if (!list) this.frameTex.set(data, list = []);
      list.push(fmtWord, size, palData, memo);
    }
    return memo;
  }
  // The pit box sheet (gamecode notePitBox) drawn with the palette of a car that has its own picture (an added driver's
  // roster/textures/pitbox/<crid>.png): that picture instead, sent once as RGBA. Palette k is the car in 0x2DD200 entry
  // k. A picture without transparency takes the sheet's own (cut-outs around the gloves and the crew's outlines).
  pitBoxTexture(fmtWord, data, palData) {
    const PB = this.g.pitBox, m = this.m, fmt = (fmtWord >> 8) & 0xff, w = 1 << ((fmtWord >> 20) & 0xf), h = 1 << ((fmtWord >> 24) & 0xf);
    if (fmt !== 0x0b || w !== PB.w || h !== PB.h || !PB.palStep) return null;
    const known = this.pbData ??= new Map(); let ok = known.get(data);
    if (ok === undefined) {   // (the image at data is the sheet: its MMAP header in front of it and its first bytes the same)
      ok = false; try { const base = (data - PB.img) >>> 0; if (m.r32(((base | 0x80000000) >>> 0)) === 0x50414d4d) { ok = true; for (let i = 0; i < 64; i += 4) if (m.r32(((data | 0x80000000) >>> 0) + i) !== PB.sig.readUInt32LE(i)) { ok = false; break; } } } catch { ok = false; }
      known.set(data, ok);
    }
    if (!ok) return null;
    const rel = palData - ((data - PB.img + PB.pal0) >>> 0), k = rel / PB.palStep;
    if (!Number.isInteger(k) || k < 0 || k >= Math.min(43, PB.palCount)) return null;
    let crid; try { crid = m.r32(0x2dd200 + k * 16) | 0; } catch { return null; }
    const sheet = this.g.pitBoxSheet?.(crid); if (!sheet) return null;
    const key = `pb:${crid}`; let e = this.texs.get(key);
    if (!e || e.dead) {
      e = { id: this.nextId++, probe: null, same: 0, used: this.frameNo }; this.texs.set(key, e);
      const W = sheet.width, H = sheet.height, px = new Uint8Array(sheet.rgba);
      let opaque = true; for (let i = 3; i < px.length; i += 4) if (px[i] !== 255) { opaque = false; break; }
      if (opaque) try {
        const src = this.view((data | 0x80000000) >>> 0, w * h), idx = decodeIndices(src, 0, w, h);
        for (let y = 0; y < H; y++) { const sy = Math.min(h - 1, (y * h / H) | 0); for (let x = 0; x < W; x++) { const sx = Math.min(w - 1, (x * w / W) | 0); px[(y * W + x) * 4 + 3] = m.r8(((palData | 0x80000000) >>> 0) + idx[sy * w + sx] * 4 + 3); } }
      } catch {}
      this.res.push({ op: "rawtex", id: e.id, w: W, h: H, off: this.arena.put(px), len: px.length });
    }
    e.used = this.frameNo;
    return { id: e.id, w: sheet.width, h: sheet.height, linear: false };
  }
  texture0(key, fmtWord, size, data, palData) {
    const m = this.m;
    const fmt = (fmtWord >> 8) & 0xff; let w, h, pitch = 0;
    if (size) { w = (size & 0xfff) + 1; h = ((size >> 12) & 0xfff) + 1; pitch = (((size >> 24) & 0xff) + 1) * 64; }
    else { w = 1 << ((fmtWord >> 20) & 0xf); h = 1 << ((fmtWord >> 24) & 0xf); }
    if (fmt === 0x0b && !palData) { this.skip("texture format 0xb without palette"); return null; }
    // change check: a sample of the source words (source copied for decoding only when they differ)
    // the level-0 bytes the decoder reads: pitch × h (linear), w × h × bytes-per-pixel (swizzled), 4×4 blocks (DXT);
    // formats the table does not know keep the old bound (w × h × 4). (Every texture used to copy w × h × 4 bytes:
    // 8× too much for DXT1, 4× for P8 — the race weekend's first frame carried 78 MB.)
    const fi = Formats[fmt], packed = fi?.block ? Math.ceil(w / 4) * Math.ceil(h / 4) * fi.block : fi?.bpp ? w * h * fi.bpp : w * h * 4;
    const lvl0 = Math.max(pitch * h, pitch && !fi?.swz && !fi?.block ? 0 : packed);
    const addr = (data | 0x80000000) >>> 0, bytes = lvl0 >>> 0;
    // a texture unchanged for STABLE frames in a row is probed with 1/8 of the samples on 3 frames out of 4
    // the entry by a small-integer key checked against its fields (the string key is only built for a new one)
    const tk = ((data >>> 2) + Math.imul(fmtWord, 31) + Math.imul(size, 17) + Math.imul(palData, 13)) & 0x3fffffff, tt = this.ttab ??= new Map();
    let te = tt.get(tk), ent;
    if (te !== undefined && te.data === data && te.fmtWord === fmtWord && te.size === size && te.palData === palData && !te.e.dead) ent = te.e;
    else { key ??= `t:${data}:${fmtWord}:${size}:${palData}`; ent = this.texs.get(key); if (ent) tt.set(tk, te = { data, fmtWord, size, palData, e: ent }); }
    const light = ent && ent.same >= STABLE && ((this.frameNo + ent.id) & 3) !== 0;
    let probe = 0x811c9dc5; const step = Math.max(4, ((bytes >> (light ? 7 : 10)) & ~3)), lim = Math.min(bytes, 1 << 26);
    const sv = this.view(addr, lim);              // read straight from the memory region (no per-word memory calls)
    if (sv && sv.length >= lim && (sv.byteOffset & 3) === 0) {
      const w = new Int32Array(sv.buffer, sv.byteOffset, lim >> 2), ws = step >> 2;
      for (let i = 0; i < w.length; i += ws) probe = Math.imul(probe ^ w[i], 16777619);
    } else try { for (let o = 0; o < lim; o += step) probe = Math.imul(probe ^ m.r32(addr + o), 16777619); } catch { return null; }
    if (palData) for (let o = 0; o < 1024; o += 64) probe = Math.imul(probe ^ m.r32(((palData | 0x80000000) >>> 0) + o), 16777619);
    let e = ent;
    if (!e) { e = { id: this.nextId++, probe: null, same: 0, lightProbe: null }; key ??= `t:${data}:${fmtWord}:${size}:${palData}`; this.texs.set(key, e); tt.set(tk, { data, fmtWord, size, palData, e }); }
    e.used = this.frameNo;
    if (light) { if (probe === e.lightProbe) return { id: e.id, w, h, linear: !!size }; e.same = 0; return this.texture0(key, fmtWord, size, data, palData); }   // (changed: the full probe decides)
    if (e.probe === probe) { if (++e.same >= STABLE - 1) e.lightProbe = this.lightProbe(addr, bytes, palData); }
    else e.same = 0;
    if (e.probe !== probe) {
      const src = this.view(addr, Math.min(bytes, 1 << 26)); if (!src) return null;
      const pv = palData ? this.view((palData | 0x80000000) >>> 0, 1024) : null;
      e.probe = probe;
      this.res.push({ op: "texsrc", id: e.id, fmt, w, h, pitch, off: this.arena.put(src), len: src.length, palOff: pv ? this.arena.put(pv) : -1, palLen: pv ? pv.length : 0 });
    }
    return { id: e.id, w, h, linear: !!size };
  }

  // texture0's probe with 1/8 of the samples (stable textures, see texture0)
  lightProbe(addr, bytes, palData) {
    let probe = 0x811c9dc5; const step = Math.max(4, ((bytes >> 7) & ~3)), lim = Math.min(bytes, 1 << 26), m = this.m;
    const sv = this.view(addr, lim);
    if (sv && sv.length >= lim && (sv.byteOffset & 3) === 0) { const w = new Int32Array(sv.buffer, sv.byteOffset, lim >> 2), ws = step >> 2; for (let i = 0; i < w.length; i += ws) probe = Math.imul(probe ^ w[i], 16777619); }
    else try { for (let o = 0; o < lim; o += step) probe = Math.imul(probe ^ m.r32(addr + o), 16777619); } catch { return null; }
    if (palData) for (let o = 0; o < 1024; o += 64) probe = Math.imul(probe ^ m.r32(((palData | 0x80000000) >>> 0) + o), 16777619);
    return probe;
  }
  // ------------------------------------------------------------------ pixel pipeline: a key here, the state interned by the packer
  pixelState(tex, sv, rs) {
    // the inputs as numbers first (no allocation): most draws repeat the previous draw's state; a changed state is
    // looked up by a hash of its 31 numbers, and the string key is built only for a state not seen before
    const d3d = this.d3d, sig = this.psSig ??= new Float64Array(31);
    const ph = d3d.pixelShader, def = ph ? d3d.shaders.get(ph)?.def?.def ?? 0 : 0;
    const aEn = sv(0x300, 0) ? 1 : 0;
    let same = this.psLast !== undefined, v;
    const put = (i, x) => { if (sig[i] !== x) { same = false; sig[i] = x; } };
    put(0, typeof def === "number" ? def : (this.defIds ??= new Map()).get(def) ?? (this.defIds.set(def, -1 - this.defIds.size), -this.defIds.size));
    put(1, (tex[0] ? 1 : 0) | (tex[1] ? 2 : 0) | (tex[2] ? 4 : 0) | (tex[3] ? 8 : 0)); put(2, aEn); put(3, aEn ? sv(0x33c, 0x207) : 0); put(4, aEn ? sv(0x340, 0) : 0);
    put(5, (rs.get("TextureFactor") ?? 0xffffffff) >>> 0); put(6, (rs.get("FogColor") ?? 0) >>> 0);
    for (let s = 0, i = 7; s < 4; s++) for (let j = 0; j < 6; j++, i++) { v = this.tssv(s, STAGE_KEYS[j]); if (sig[i] !== v) { same = false; sig[i] = v; } }
    if (same) return this.psLast;
    let h = 0x811c9dc5; for (let i = 0; i < 31; i++) h = Math.imul(h ^ (sig[i] | 0), 16777619);
    const byHash = this.psByHash ??= new Map(); let list = byHash.get(h >>> 0);
    if (list) for (const e of list) { let eq = true; for (let i = 0; i < 31; i++) if (e.sig[i] !== sig[i]) { eq = false; break; } if (eq) return (this.psLast = e.k); }
    const stages = Array.from(sig.subarray(7, 31)), alpha = aEn ? [sig[3], sig[4]] : null, tfactor = sig[5], fog = sig[6];
    const key = `${typeof def === "number" ? def : sig[0]}|${stages.join(",")}|${tex.map(t => (t ? 1 : 0)).join("")}|${alpha ?? ""}|${tfactor}|${fog}`;
    let k = this.psDefs.get(key);
    if (k === undefined) {
      k = this.psDefs.size + 1; this.psDefs.set(key, k);
      const ps = def ? parsePS(def) : null;
      this.pendingPs.push({ key: k, state: { ps, stages: [0, 1, 2, 3].map(s => stages.slice(s * 6, s * 6 + 6)), present: tex.map(t => !!t),
        alpha: alpha ? [alpha[0], alpha[1] / 255] : null, tfactor, fog } });
    }
    if (!list) byHash.set(h >>> 0, list = []); list.push({ sig: Float64Array.from(sig), k });
    return (this.psLast = k);
  }
}

// ---------------------------------------------------------------------- packing (worker or in-thread)
export class FramePacker {
  constructor() { this.reset(); }
  reset() { this.ps = new Map(); this.psIds = new Map(); this.nextPs = 1; }
  pack(frame) {
    const words = new Int32Array(frame.words, 0, frame.nw), f = new Float32Array(frame.words, 0, frame.nw), at = (a, n) => chunkBytes(frame.chunks, a, n);
    const blobs = [], res = [], cmds = [];
    const blob = b => { blobs.push(b); return blobs.length - 1; };
    for (const r of frame.res) {
      if (r.op === "buf") res.push({ op: "buf", id: r.id, blob: blob(at(r.off, r.len)), index: r.index });
      else if (r.op === "rawtex") res.push({ op: "tex", id: r.id, w: r.w, h: r.h, blob: blob(at(r.off, r.len)) });   // RGBA as is
      else if (r.op === "texsrc" && r.fmt === 0x0b && r.palOff >= 0 && !r.pitch) {      // paletted: indices + the BGRA palette, expanded by the page
        let idx = null; try { idx = decodeIndices(at(r.off, r.len), 0, r.w, r.h); } catch { idx = null; }
        if (idx) res.push({ op: "texp8", id: r.id, w: r.w, h: r.h, blob: blob(idx), pal: blob(at(r.palOff, Math.min(1024, r.palLen))) });
      } else if (r.op === "texsrc") {
        let rgba = null;
        try { const src = at(r.off, r.len), pal = r.palOff >= 0 ? at(r.palOff, r.palLen) : null;
          rgba = decodePixels(r.fmt, Buffer.from(src.buffer, src.byteOffset, src.length), 0, r.w, r.h, pal ? Buffer.from(pal.buffer, pal.byteOffset, pal.length) : null, r.pitch); } catch { rgba = null; }
        if (rgba) res.push({ op: "tex", id: r.id, w: r.w, h: r.h, blob: blob(new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength)) });
      } else res.push(r);                                                  // vs, free
    }
    for (const d of frame.psDefs) {                                        // pixel states: one id per distinct state
      const j = JSON.stringify(d.state); let id = this.ps.get(j);
      if (id === undefined) { id = this.nextPs++; this.ps.set(j, id); res.push({ op: "ps", id, state: d.state }); }
      res.push({ op: "pskey", key: d.key, id });                          // the capture's key -> that state
    }
    // binary message ("IGL2"): the command words go out exactly as captured (the page walks them, gl-remote.mjs
    // OP_* layout); only the resource list is JSON. Before, every draw became a JSON object here (and was parsed
    // again in the page): ~6-8 ms per race frame on the server.
    const table = []; let off = 0;
    for (const b of blobs) { off = (off + 3) & ~3; table.push([off, b.byteLength]); off += b.byteLength; }
    const json = Buffer.from(JSON.stringify({ frame: frame.frame, res, blobs: table, hold: frame.hold || undefined, fit43: frame.fit43 || undefined }));
    const wOff = (8 + json.length + 3) & ~3, bOff = wOff + 4 + words.byteLength, out = Buffer.alloc(bOff + off);
    out.writeUInt32LE(0x324c4749, 0); out.writeUInt32LE(json.length, 4); json.copy(out, 8);
    out.writeUInt32LE(words.length, wOff); out.set(new Uint8Array(words.buffer, words.byteOffset, words.byteLength), wOff + 4);
    blobs.forEach((b, i) => out.set(b, bOff + table[i][0]));
    return out;
  }
}

// vertex shader declaration (D3DVSD tokens): inputs { stream, offset, reg, type } and CONSTMEM constants
export function parseDecl(m, p) {
  const regs = [], consts = []; let stream = 0, offset = 0;
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
function typeSize(type) {
  if (type === 0x02) return 0; if (type === 0x40) return 4; if (type === 0x16) return 4; if (type === 0x72) return 12;
  const kind = type & 0xf, n = type >> 4;
  return kind === 2 ? n * 4 : kind === 5 || kind === 1 ? n * 2 : kind === 4 ? n : n * 4;
}
