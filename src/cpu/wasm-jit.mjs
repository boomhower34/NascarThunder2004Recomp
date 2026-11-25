// wasm-jit.mjs — the game's x86 code as WebAssembly, run by a dispatcher inside WebAssembly (opt-in: NT04_WASM=1).
//
// Why: the JavaScript blocks (x86-jit.mjs) are near what V8 gives for that code shape (~6 ns per guest
// instruction on the dev VM), and a third of a race frame is the hop between blocks. A measurement prototype showed
// WebAssembly ~35% faster per instruction on straight code but ~30-40 ns per call from JavaScript, so blocks have
// to call each other inside WebAssembly: run(eip, budget) looks the next block up and calls it through a shared
// function table, and comes back to JavaScript only at an address without a block (untranslated instruction, hook,
// beyond the image) or when the next block would cross the step budget (ticks land on the same instruction as in
// the interpreter).
//
// Memory (uis-vm.mjs enableLow): guest RAM is the WebAssembly memory, index = guest address. After the 256 MB
// window: OKB (64 KB of page flags by address >> 16: 1 = window page, 2 = mirror of a window page at | 0x80000000,
// 0 = elsewhere), CTX (registers +0..28, EFLAGS +32, count of the last block +36, steps of the last run +40,
// x87 top +44, status word +48, control word +52, the eight x87 registers as f64 at +64; the CPU's r and fpu arrays
// are views of this page, so nothing is copied for them),
// NTAB (instruction count per block number, 256 KB), MAP (block number per image address, u32, 16 MB).
//
// Blocks: 32-bit integer subset (mov, lea, ALU incl. cmp/test, inc/dec, push/pop, shifts by imm8, movzx/movsx,
// jcc as side exits, jmp followed, calls inlined 3 deep with a return-address check, ret). Anything else ends the
// block before it. Flags are kept as operands until read (like the JavaScript fusion) and computed at exits.
import { Code, OP, I32, F64, F32, buildModule } from "./wasm-emit.mjs";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, statSync, renameSync, promises as fsp } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { gzipSync, gunzipSync, gunzip } from "node:zlib";

export const LOW = 0x10000000, OKB = LOW, CTX = LOW + 0x10000, NTAB = LOW + 0x20000, MAP = LOW + 0x60000, SPAN = 0x400000;
export const MEM_PAGES = (LOW >>> 16) + 2 + 4 + 256 + 64;     // uis-vm.mjs allocates exactly this (the last 64 pages: recomp.wasm, recomp.mjs RC_BASE)
const MAX_BLOCKS = 262143, BATCH = 256, MAX_INSNS = 64;
const LF = 8, FA = 9, FB = 10, FT = 11, LA = 12, LV = 13, LT = 14, LA2 = 15, LOK = 16, LB2 = 17, LTOP = 18, LFSW = 19, LFCW = 20, LX = 21, LFC = 22, LXB = 23, X0 = 24, X1 = 25, X2 = 26, X3 = 27, NLOC = 28;
const FV = NLOC, FW = NLOC + 1, NFLOC = 2;                 // f64 locals
const FPU = CTX + 64, XMMB = CTX + 0x100, MMXB = CTX + 0x180;   // x87, XMM (8 x 16 bytes), MMX (8 x 8 bytes)
const IMP = { r8: 0, r16: 1, r32: 2, w8: 3, w16: 4, w32: 5, rf32: 6, rf64: 7, wf32: 8, wf64: 9 };
const FDV = new DataView(new ArrayBuffer(8));
const F_CF = 1, F_PF = 4, F_ZF = 0x40, F_SF = 0x80, F_OF = 0x800;
const leb = n => { const out = []; n >>>= 0; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };

export class WasmJit {
  constructor(cpu, mem) {
    this.c = cpu; this.m = mem;
    const buf = mem.wasmMemory.buffer;
    this.ctx = new Int32Array(buf, CTX, 16); this.map = new Uint32Array(buf, MAP, SPAN); this.ntab = new Uint8Array(buf, NTAB, MAX_BLOCKS + 1);
    this.ok = new Uint8Array(buf, OKB, 65536);
    // the CPU's registers and x87 registers live in the state page (blocks read and write them there directly)
    { const rv = new Uint32Array(buf, CTX, 8); rv.set(cpu.r); cpu.r = rv; const fv = new Float64Array(buf, FPU, 8); fv.set(cpu.fpu); cpu.fpu = fv; }
    // XMM / MMX too (x86-simd simdRebind); the JavaScript blocks' lane views follow (x86-jit xu / xf / mu)
    cpu.simdRebind(buf, XMMB, MMXB);
    if (cpu.jit) { cpu.jit.xu = new Uint32Array(buf, XMMB, 32); cpu.jit.xf = new Float32Array(buf, XMMB, 32); cpu.jit.mu = new Uint32Array(buf, MMXB, 16); }
    this.tried = new Uint8Array(SPAN);                    // 1: queued or translated, 2: not translatable
    this.queue = []; this.next = 1;
    this.table = new WebAssembly.Table({ element: "anyfunc", initial: MAX_BLOCKS + 1 });
    this.stats = { blocks: 0, failed: 0, batches: 0, runs: 0, insns: 0, compileMs: 0 };
    this.dirty = false;
    this.run = this.dispatcher();
  }
  // mirror pages: a region above 0x80000000 that is a view of the window at (address & 0x7fffffff)
  mirrors() {
    const m = this.m, low = m.low;
    for (let q = 0x8000; q < 0x10000; q++) {
      const r = m.pages[q]; if (!r || !r.buf || r.buf.buffer !== low.buffer) continue;
      if (r.buf.byteOffset - (r.base >>> 0) === -0x80000000 || r.buf.byteOffset === (r.base >>> 0) - 0x80000000) this.ok[q] = 2;
    }
  }
  // hooks changed (x86-jit flush): no block may run through a newly hooked address
  flush() { this.flushes = (this.flushes ?? 0) + 1; if (!this.dirty) return; this.dirty = false; this.gen = (this.gen ?? 0) + 1; this.tlist = []; this.map.fill(0); this.tried.fill(0); this.queue.length = 0; this.next = 1; if (this.recomp) this.recomp.registered = false; }   // (block numbers reused)
  // statically recompiled functions (recomp.mjs: recomp.wasm + recomp.json beside the game executable): each entry
  // (resume point) goes into the block table with NTAB 64 (its longest block); it then runs until the dispatcher's
  // remaining step budget (CTX+0x1C0) would be crossed. A function is enabled only when none of its instruction addresses is hooked; checked again after every
  // hook change (flush). NT04_RECOMP=0 turns it off.
  loadRecomp(dir, exe, log = () => {}) {
    if (this.loadNative(dir, exe, log)) return;
    try {
      // recomp.wasm, or recomp.wasm.gz (the full build is ~39 MB raw); a raw file wins when both exist
      const jp = join(dir, "recomp.json"), wr = join(dir, "recomp.wasm"), wz = wr + ".gz", wp = existsSync(wr) ? wr : wz; if (!existsSync(jp) || !existsSync(wp)) return;
      const man = JSON.parse(readFileSync(jp, "utf8"));
      if (man.image !== createHash("sha256").update(exe).digest("hex").slice(0, 16)) { log("recomp: recomp.wasm was built for another game executable; not used"); return; }
      const env = this.recompImports();
      const inst = new WebAssembly.Instance(new WebAssembly.Module(wp === wz ? gunzipSync(readFileSync(wp)) : readFileSync(wp)), { env });
      // the module's data and stack (up to __heap_base) must stay below the hook tables at EN - 0x20000
      const hb = inst.exports.__heap_base?.value; if (hb !== undefined && hb > man.en - 0x20000) { log(`recomp: data ends at 0x${hb.toString(16)}, over the hook tables; not used`); return; }
      this.recomp = { man, inst, en: new Uint8Array(this.m.wasmMemory.buffer, man.en, man.functions.length), registered: false, enabled: 0 };
      log(`recomp: ${man.functions.length} recompiled functions`);
    } catch (e) { log(`recomp: not loaded (${e.message})`); this.recomp = null; }
  }
  // the imports of the recompiled code (WebAssembly module or native add-on)
  recompImports() {
    return { ...this.importObject().env, memory: this.m.wasmMemory, divzero: pc => { const v = new Uint32Array(this.m.wasmMemory.buffer, CTX + 0x1c0, 3); throw new Error(`divide by zero at ${(pc >>> 0).toString(16)} (rem ${v[0]} lim ${v[1]} cnt ${v[2]})`); }, note: (k, t) => this.recompNote?.(k, t >>> 0), hook: (t, cnt) => this.recompHook(t >>> 0, cnt),
        // x87 ops computed exactly as x86emu does (fprem, fpatan, fptan, fsin/fcos/fsincos, f2xm1, fyl2x, fscale, fyl2xp1)
        fm: (k, a, b) => { switch (k) { case 0: return a % b; case 1: return Math.atan2(a, b); case 2: return Math.tan(a); case 3: return Math.sin(a); case 4: return Math.cos(a);
          case 5: return 2 ** a - 1; case 6: return a * Math.log2(b); case 7: return a * 2 ** Math.trunc(b); default: return a * Math.log2(b + 1); } },
        // cvtss2si: MXCSR rounding (x86-simd mxRound), out of range -> 0x80000000
        cvt: v => { const r = this.c.mxRound(v); return Number.isFinite(r) && r >= -2147483648 && r <= 2147483647 ? r | 0 : 0x80000000 | 0; } };
  }
  // The native build (recomp.mjs --native: recomp-native-<platform>-<arch>.node + recomp-native.json beside the
  // executable): the same recompiled C compiled for this machine, run by the add-on's own dispatcher loop (run) on the
  // same memory. Used before recomp.wasm when present; NT04_NATIVE=0 keeps the WebAssembly build.
  loadNative(dir, exe, log) {
    if (process.env.NT04_NATIVE === "0") return false;
    const np = join(dir, `recomp-native-${process.platform}-${process.arch}.node`), jp = join(dir, "recomp-native.json");
    if (!existsSync(np) || !existsSync(jp)) return false;
    try {
      const man = JSON.parse(readFileSync(jp, "utf8"));
      if (man.image !== createHash("sha256").update(exe).digest("hex").slice(0, 16)) { this.nativeError = "made for another game executable"; log("recomp: the native build was made for another game executable; not used"); return false; }
      const nat = createRequire(import.meta.url)(np);
      let imps = this.recompImports();
      if (process.env.NT04_COUNT_IMPORTS) { const n = this.importCounts = {}; imps = Object.fromEntries(Object.entries(imps).map(([k, f]) => [k, typeof f === "function" ? (...a) => { n[k] = (n[k] ?? 0) + 1; if (k === "r32" || k === "w32") { const pg = ((a[0] >>> 0) >>> 16).toString(16); n[k + "@" + pg] = (n[k + "@" + pg] ?? 0) + 1; } return f(...a); } : f])); }
      nat.init(this.m.wasmMemory.buffer, imps, { map: MAP, ntab: NTAB, span: SPAN, ctx: CTX, slots: MAX_BLOCKS + 1 });
      this.recomp = { man, native: nat, en: new Uint8Array(this.m.wasmMemory.buffer, man.en, man.functions.length), registered: false, enabled: 0 };
      // (the dispatcher's first checks in JavaScript: an address without a recompiled entry, or whose first block does
      // not fit the budget, returns at once. Called that way from the interpreter's loop at every instruction of code
      // it runs (a thread resumed inside a function: the loading screen's fade, 0xEC870), each call crossing into the
      // add-on cost more than the instruction: race loads took 5-7 s instead of ~0.5 s.)
      const map = this.map, ntab = this.ntab, ctx = this.ctx;
      this.run = (eip, rem) => { const i = eip >>> 0 < SPAN ? map[eip] : 0; if (!i || ntab[i] > rem >>> 0) { ctx[10] = 0; return eip; } return nat.run(eip, rem); };
      log(`recomp: native build, ${man.functions.length} recompiled functions (${np.split(/[\\/]/).pop()})`);
      return true;
    } catch (e) { this.nativeError = e.message; log(`recomp: native build not loaded (${e.message}); WebAssembly instead`); this.recomp = null; this.run = this.dispatcher(); return false; }
  }
  // a call from recompiled code to a hooked address: the hook runs here (as x86emu's run loops would run it) and the
  // C code continues at the return address (1); 0: not a hook now (the C code leaves to the dispatcher at the
  // target); 2: the hook changed the course (other return address, yield, game code run inside the hook, hooks
  // changed) -> the C code leaves at CTX+60 and the dispatcher stops, so the run loop takes over
  recompHook(t, cnt) {
    const c = this.c, h = c.hooks.get(t); if (!h || c.passThrough === t) return 0;
    const ctx = this.ctx, add = ctx[10] + cnt, fl0 = this.flushes, nt0 = c.nextTick, lim0 = c.stepLimit, ti0 = c.tickInterval;
    c.flags = ctx[8] >>> 0; c.ftop = ctx[11]; c.fsw = ctx[12]; c.fcw = ctx[13];
    c.steps += add; const s0 = c.steps; c.eip = t;
    const ret = c.pop(), v = h(c, ret); if (v !== undefined) c.r[0] = v >>> 0;
    const next = c.hookReturn ?? ret; c.hookReturn = null; c.eip = next;
    const nested = c.steps !== s0; c.steps -= add;
    ctx[8] = c.flags; ctx[11] = c.ftop; ctx[12] = c.fsw; ctx[13] = c.fcw;
    this.stats.hooks = (this.stats.hooks ?? 0) + 1;
    if (next === ret && !c.yieldNow && !nested && this.flushes === fl0 && c.nextTick === nt0 && c.stepLimit === lim0 && c.tickInterval === ti0) return 1;   // (a changed tick / step limit changes the run's budget)
    this.stats.hookStops = (this.stats.hookStops ?? 0) + 1;
    if (c.yieldNow) this.hookYield = true;           // (x86emu runSlice returns "yield" after this run, as after a hook of its own)
    ctx[15] = next; ctx[14] = 1; return 2;
  }
  registerRecomp() {
    const R = this.recomp; R.registered = true; const hooks = this.c.hooks; let n = 0;
    // the heap's mirror at 0x8xxxxxxx as direct pages (OKB 2) for the recompiled code too: they were only marked when
    // the block compiler translated (translate below), which static mode never does, so every access of code running
    // there (the framebuffer: the loading screen's fade, 0xEC870, ~600k accesses a pass) went through the r32 / w32
    // imports; cheap from WebAssembly, but each a call into JavaScript from the native build (race loads of 5-7 s)
    this.mirrors();
    // entry wrappers by number: slot ENTRY_FN[k] of the module's exported function table (recomp.mjs entry_table)
    if (R.native) R.efn = null;
    else if (!R.efn) { const tb = R.inst.exports.__indirect_function_table, et = R.inst.exports.entry_table, u = et && new Uint32Array(this.m.wasmMemory.buffer);
      R.efn = k => tb.get(u[(et() >>> 2) + k]); }
    // a call to an address hooked now but not when recomp.wasm was built (recomp.json hooked) may run a JavaScript hook
    // in place while the caller's callers still hold registers outside the context: such callers stay disabled
    const known = R.known ??= new Set(R.man.hooked ?? []), late = R.man.hooked ? new Set([...hooks.keys()].filter(a => !known.has(a))) : new Set();
    R.lateHooks = late.size;
    for (const f of R.man.functions) {
      const ok = !f.ats.some(a => hooks.has(a)) && !(late.size && f.calls?.some(t => late.has(t))); R.en[f.index] = ok ? 1 : 0; if (!ok) continue; n++;
      for (const [addr, name, first] of f.entries) {
        if (this.next >= MAX_BLOCKS) break;
        // NTAB: the entry's first block (recomp.json; 64 = the longest block for older builds). Recompiled code checks
        // the budget before every block, so only the first must fit: later ones exit there with progress made.
        const idx = this.next++; if (R.native) R.native.setEntry(idx, name); else this.table.set(idx, typeof name === "number" ? R.efn(name) : R.inst.exports[name]); this.ntab[idx] = +(process.env.NT04_RECOMP_NTAB ?? first ?? 64); this.map[addr] = idx; this.tried[addr] = 1;
      }
    }
    // natively run hooks (recomp.mjs NATIVE): only while the hook installed is the function the C code reproduces
    new Uint8Array(this.m.wasmMemory.buffer, R.man.en - 512, 1)[0] = !process.env.NT04_RECOMP_NO_NATIVE && hooks.get(0x1803a8)?.recompNative === "ftol" ? 1 : 0;
    // hooked call targets of the recompiled code (recomp.json ext: index -> address)
    const HT = new Uint8Array(this.m.wasmMemory.buffer, R.man.en - 0x20000, 0x10000);
    (R.man.ext ?? []).forEach((t, k) => { HT[k] = !process.env.NT04_RECOMP_NO_HOOKS && hooks.has(t) ? 1 : 0; });
    // D3D setters run natively (recomp.mjs nhook): the hook's state moves into the module's block first (d3d shareState)
    const NHT = new Uint16Array(this.m.wasmMemory.buffer, R.man.en - 0x10000, 0x7f00), ns = R.native ? R.native.nstate : R.inst.exports.nstate;
    (R.man.ext ?? []).forEach((t, k) => { const rn = hooks.get(t)?.recompNative; let v = 0;
      if (ns && rn?.id && rn.d3d && !process.env.NT04_RECOMP_NO_NATIVE && !process.env.NT04_RECOMP_NO_D3D_NATIVE) { rn.d3d.shareState(this.m.wasmMemory.buffer, ns()); v = rn.id | (rn.pop << 8); }
      NHT[k] = v; });
    R.enabled = n; this.dirty = true;
  }
  // the JavaScript dispatcher saw a block start here: translate it with the next batch
  want(eip) { if (this.recomp && !this.recomp.registered) { this.registerRecomp(); if (this.map[eip]) return; }
    if (this.noJit) return;             // static mode: only recompiled code here, nothing is translated at run time
    if (this.tried[eip] === 0 && this.next < MAX_BLOCKS) { if (this.cache && this.fromCache(eip)) return; this.tried[eip] = 1; this.queue.push(eip); if (this.queue.length >= (this.deferBatches ? 8 * BATCH : BATCH)) { try { this.compileBatch(); } catch (e) { this.stats.errors = (this.stats.errors ?? 0) + 1; this.lastError = e.stack; if (process.env.NT04_WASM_DEBUG) console.log('WASM batch error', e.stack); this.queue.length = 0; } } } }   // never let an error escape into the game
  // imports of every block module (memory, slow paths for accesses outside the window)
  importObject() {
    if (this.imports) return this.imports;
    const m = this.m;
    return (this.imports = { env: { mem: m.wasmMemory,
      r8: a => m.r8(a), r16: a => m.r16(a), r32: a => m.r32(a) | 0, w8: (a, v) => m.w8(a, v), w16: (a, v) => m.w16(a, v), w32: (a, v) => m.w32(a, v >>> 0),
      rf32: a => { FDV.setUint32(0, m.r32(a), true); return FDV.getFloat32(0, true); },
      rf64: a => { FDV.setUint32(0, m.r32(a), true); FDV.setUint32(4, m.r32(a + 4), true); return FDV.getFloat64(0, true); },
      wf32: (a, v) => { FDV.setFloat32(0, v, true); m.w32(a, FDV.getUint32(0, true)); },
      wf64: (a, v) => { FDV.setFloat64(0, v, true); m.w32(a, FDV.getUint32(0, true)); m.w32(a + 4, FDV.getUint32(4, true)); } } });
  }
  // a block from the disk cache: load (or reuse) its module and register every block of it that is still valid
  fromCache(eip) {
    const cc = this.cache; if (!cc) return false;
    const e = cc.index.get(eip); if (!e) return false;
    let inst;
    try { inst = cc.instance(e.mod, this); } catch { inst = null; }
    if (!inst) { cc.index.delete(eip); return false; }
    const hooks = this.c.hooks;
    for (const b of cc.mods.get(e.mod).blocks) {
      if (this.map[b.start] || this.tried[b.start] === 2 || this.next >= MAX_BLOCKS) continue;
      if (b.ats.some(a => hooks.has(a) && a !== b.start) || hooks.has(b.start)) continue;   // runs through an address hooked now
      const idx = this.next++; this.table.set(idx, inst.exports[`b${b.fn}`]); this.ntab[idx] = b.n; this.map[b.start] = idx; this.tried[b.start] = 1;
    }
    this.dirty = true; this.stats.cached = (this.stats.cached ?? 0) + 1;
    return this.map[eip] !== 0;
  }
  // instantiate a compiled batch and register its blocks; after a flush (gen changed) only blocks that still don't
  // run through a hooked address and have no block yet
  installBatch(mod, bytes, list, gen) {
    let inst; try { inst = new WebAssembly.Instance(mod, this.importObject()); }   // floats outside the window: the interpreter's conversions
    catch (e) { this.stats.linkErrors = (this.stats.linkErrors ?? 0) + 1; for (const b of list) this.tried[b.start] = 2; return; }
    const hooks = this.c.hooks, stale = gen !== (this.gen ?? 0); let n = 0;
    list.forEach((b, i) => {
      if (this.map[b.start] || this.next >= MAX_BLOCKS) return;
      if (stale && (hooks.has(b.start) || b.ats.some(a => hooks.has(a)))) return;
      const idx = this.next++; this.table.set(idx, inst.exports[`b${i}`]); this.ntab[idx] = b.n; this.map[b.start] = idx; this.tried[b.start] = 1; if (this.keepAts) (this.ats ??= [])[idx] = b.ats; n++;
    });
    this.dirty = true; this.cache?.add(bytes, list.map((b, i) => ({ start: b.start, fn: i, n: b.n, ats: b.ats })));
    this.stats.blocks += n;
  }
  // translate queued blocks (until `deadline`, performance.now() ms), then build and compile them as one module once
  // the queue is done or BATCH translations are ready. With deferBatches (the live loop) this runs from idleWork in
  // the time a frame leaves over, a few ms at a time, instead of ~100 ms in the middle of the frame that filled the queue.
  compileBatch(deadline = Infinity) {
    if (!this.queue.length && !this.tlist?.length) return false;
    const t0 = performance.now(), hooks = this.c.hooks, list = (this.tlist ??= []); this.dirty = true; this.mirrors();   // (the mirror is mapped after boot)
    let k = 0;
    for (; k < this.queue.length && list.length < BATCH; k++) {
      if (k && performance.now() >= deadline) break;
      const eip = this.queue[k];
      if (this.map[eip] || this.fromCache(eip)) continue;          // (a cached module may have brought it in)
      let t = null; try { t = translate(this.m, eip, hooks); } catch { t = null; }
      if (t && t.n >= 1 && this.next + list.length < MAX_BLOCKS) list.push(t); else { this.tried[eip] = 2; if (!t) this.stats.failed++; }   // never past the table
    }
    this.queue.splice(0, k);
    if (this.queue.length && list.length < BATCH) { this.stats.compileMs += performance.now() - t0; return true; }   // more to translate first
    this.tlist = [];
    if (list.length) {
      const imports = [["r8", [I32], [I32]], ["r16", [I32], [I32]], ["r32", [I32], [I32]], ["w8", [I32, I32], []], ["w16", [I32, I32], []], ["w32", [I32, I32], []],
        ["rf32", [I32], [F32]], ["rf64", [I32], [F64]], ["wf32", [I32, F32], []], ["wf64", [I32, F64], []]]
        .map(([name, params, results]) => ({ mod: "env", name, params, results }));
      let bytes; try { bytes = buildModule({ imports, memPages: MEM_PAGES, funcs: list.map((b, i) => ({ name: `b${i}`, params: [], results: [I32], locals: NLOC, flocals: NFLOC, code: b.code })) }); }
      catch (e) { this.stats.buildErrors = (this.stats.buildErrors ?? 0) + 1; this.lastError = e.message; for (const b of list) this.tried[b.start] = 2; return; }   // never let an error escape into the game
      // compiled off the main thread (WebAssembly.compile) in the live loop, unless NT04_WASM_SYNC / syncCompile: a batch of 256 blocks
      // took 100-180 ms here, in the middle of a frame. Until it is installed these addresses keep running as JS blocks
      // (same results); the blocks are installed from the event loop, between frames.
      if (this.deferBatches && !this.syncCompile && !process.env.NT04_WASM_SYNC) {   // (only with the live loop's idle work: a caller that never yields would never install them)
        const gen = this.gen ?? 0; this.stats.pending = (this.stats.pending ?? 0) + 1;
        WebAssembly.compile(bytes).then(mod => this.installBatch(mod, bytes, list, gen), e => { this.stats.compileErrors = (this.stats.compileErrors ?? 0) + 1; this.lastError = e.message; for (const b of list) this.tried[b.start] = 2; })
          .finally(() => { this.stats.pending--; });
      } else {
        let mod; try { mod = new WebAssembly.Module(bytes); } catch (e) { this.stats.compileErrors = (this.stats.compileErrors ?? 0) + 1; this.lastError = e.message; for (const b of list) this.tried[b.start] = 2; return; }
        this.installBatch(mod, bytes, list, this.gen ?? 0);
      }
    }
    this.stats.batches++; this.stats.compileMs += performance.now() - t0;
    return this.queue.length > 0;
  }
  // live loop idle time: translate for at most `ms`; true while blocks are still queued
  idleWork(ms) { this.deferBatches = true; return this.compileBatch(performance.now() + ms) || false; }
  // run(eip, budget) -> exit eip; executed instruction count in ctx[10]
  dispatcher() {
    const c = new Code(), EIP = 0, REM = 1, IDX = 2, TOT = 3;
    // CTX+40: steps of this run so far (written before each block, so a hook called from recompiled code sees the
    // right step count); CTX+56: stop flag (recompiled code sets it when a hook changed the course: run returns)
    c.i32(CTX + 56).i32(0).store();
    c.block().loop()
      .get(EIP).i32(SPAN).op(OP.geU).brIf(1)
      .get(EIP).i32(2).op(OP.shl).load(MAP).tee(IDX).op(OP.eqz).brIf(1)                          // i32.load MAP
      .get(IDX).op(0x2d, 0, ...leb(NTAB)).get(REM).op(OP.gtU).brIf(1)                            // i32.load8_u NTAB
      .i32(CTX + 40).get(TOT).store().i32(CTX + 0x1c0).get(REM).store()   // (+0x1C0: steps left, for recompiled entries)
      .get(IDX).callIndirect(0).set(EIP)
      .i32(CTX + 36).load().tee(IDX).get(TOT).op(OP.add).set(TOT)
      .get(REM).get(IDX).op(OP.sub).set(REM)
      .i32(CTX + 56).load().brIf(1)
      .br(0).end().end()
      .i32(CTX + 40).get(TOT).store().get(EIP);
    const bytes = buildModule({ imports: [], memPages: MEM_PAGES, table: MAX_BLOCKS + 1, extraTypes: [[[], [I32]]],
      funcs: [{ name: "run", params: [I32, I32], results: [I32], locals: 2, code: c }] });
    const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { mem: this.m.wasmMemory, tbl: this.table } });
    return inst.exports.run;
  }
}

// ---------------------------------------------------------------------- translation of one block
const MASKS = { 8: 0xff, 16: 0xffff, 32: -1 };
export function translate(m, start, hooks, maxInsns = MAX_INSNS) {
  const c = new Code(); let pc = start, n = 0;
  const b8 = () => m.r8(pc++), s8 = () => (b8() << 24) >> 24, b32 = () => { const v = m.r32(pc); pc += 4; return v | 0; };
  let pend = null;                                       // pending flags { k, s } with operands in FA / FB / FT (masked)
  const inl = [];
  for (let i = 0; i < 8; i++) c.i32(CTX + i * 4).load().set(i);
  c.i32(CTX + 32).load().set(LF);
  c.i32(CTX + 44).load().set(LTOP); c.i32(CTX + 48).load().set(LFSW); c.i32(CTX + 52).load().set(LFCW);
  let fpuTouched = false;
  // memory: flag of the page; 1 = window (index = address), 2 = mirror (address ^ 0x80000000); else imported call
  const access = (lim, fast, slow) => {
    c.get(LA).i32(16).op(OP.shrU).op(0x2d, 0, ...leb(OKB)).tee(LOK)
      .i32(0).op(OP.ne).get(LA).i32(0xffff).op(OP.and).i32(lim).op(OP.leU).op(OP.and);
    c.if_(fast.result ?? 0x40);
    c.get(LA).get(LOK).i32(2).op(OP.and).i32(30).op(OP.shl).op(OP.xor); fast(); c.else_(); slow(); c.end();
  };
  const rd32 = () => { const f = () => c.load(); f.result = I32; access(0xfffc, f, () => c.get(LA).call(IMP.r32)); };
  const rd16 = () => { const f = () => c.load16u(); f.result = I32; access(0xfffe, f, () => c.get(LA).call(IMP.r16)); };
  const rd8 = () => { const f = () => c.load8u(); f.result = I32; access(0xffff, f, () => c.get(LA).call(IMP.r8)); };
  const wr32 = () => access(0xfffc, () => c.get(LV).store(), () => c.get(LA).get(LV).call(IMP.w32));
  const wr8 = () => access(0xffff, () => c.get(LV).store8(), () => c.get(LA).get(LV).call(IMP.w8));
  const wr16 = () => access(0xfffe, () => c.get(LV).storeI16(), () => c.get(LA).get(LV).call(IMP.w16));
  const rdF32 = () => { const f = () => c.loadF32().op(OP.promote); f.result = F64; access(0xfffc, f, () => c.get(LA).call(IMP.rf32).op(OP.promote)); };   // -> f64
  const rdF64 = () => { const f = () => c.loadF64(); f.result = F64; access(0xfff8, f, () => c.get(LA).call(IMP.rf64)); };
  const wrF32 = () => access(0xfffc, () => c.get(FW).op(OP.demote).storeF32(), () => c.get(LA).get(FW).op(OP.demote).call(IMP.wf32));   // value in FW
  const wrF64 = () => access(0xfff8, () => c.get(FW).storeF64(), () => c.get(LA).get(FW).call(IMP.wf64));
  const modrm = () => {
    const b = b8(), mod = b >> 6, reg = (b >> 3) & 7, rm = b & 7;
    if (mod === 3) return { reg, rm, mem: false };
    let disp = 0, parts = 0;
    if (rm === 4) { const sib = b8(), sc = sib >> 6, idx = (sib >> 3) & 7, base = sib & 7;
      if (base === 5 && mod === 0) disp = b32(); else { c.get(base); parts++; }
      if (idx !== 4) { c.get(idx); if (sc) c.i32(sc).op(OP.shl); if (parts++) c.op(OP.add); } }
    else if (rm === 5 && mod === 0) disp = b32();
    else { c.get(rm); parts++; }
    if (mod === 1) disp += s8(); else if (mod === 2) disp += b32();
    if (!parts) c.i32(disp); else if (disp) c.i32(disp).op(OP.add);
    c.set(LA); return { reg, rm, mem: true };
  };
  const rdRM = o => { if (o.mem) rd32(); else c.get(o.rm); };
  const wrRM = o => { if (o.mem) { c.set(LV); wr32(); } else c.set(o.rm); };
  // 8-bit registers: 0-3 = low bytes of eax..ebx, 4-7 = their second bytes (ah..bh)
  const rdR8 = i => { if (i < 4) c.get(i).i32(0xff).op(OP.and); else c.get(i - 4).i32(8).op(OP.shrU).i32(0xff).op(OP.and); };
  const wrR8 = i => {                                    // value (0..255) on the stack
    c.set(LT);
    if (i < 4) c.get(i).i32(~0xff).op(OP.and).get(LT).op(OP.or).set(i);
    else c.get(i - 4).i32(~0xff00).op(OP.and).get(LT).i32(8).op(OP.shl).op(OP.or).set(i - 4);
  };
  const rdRM8 = o => { if (o.mem) rd8(); else rdR8(o.rm); };
  const wrRM8 = o => { if (o.mem) { c.set(LV); wr8(); } else wrR8(o.rm); };
  const condOf = cc => {
    const base = cc >> 1, neg = cc & 1;
    const P = () => { c.get(FT).i32(0xff).op(OP.and).op(OP.popcnt).i32(1).op(OP.and).op(OP.eqz); };
    if (pend) {
      const k = pend.k, sh = pend.s - 1;
      const CF = () => { if (k === "sub") c.get(FA).get(FB).op(OP.ltU); else if (k === "add") c.get(FT).get(FA).op(OP.ltU); else if (k === "logic") c.i32(0);
        else if (k === "adc") c.get(FT).get(FA).op(OP.ltU).get(LFC).get(FT).get(FA).op(OP.eq).op(OP.and).op(OP.or);
        else if (k === "sbb") c.get(FA).get(FB).op(OP.ltU).get(LFC).get(FA).get(FB).op(OP.eq).op(OP.and).op(OP.or);
        else c.get(LF).i32(1).op(OP.and); };
      const ZF = () => { c.get(FT).op(OP.eqz); };
      const SF = () => { c.get(FT).i32(sh).op(OP.shrU).i32(1).op(OP.and); };
      const OF = () => { if (k === "sub" || k === "sbb") c.get(FA).get(FB).op(OP.xor).get(FA).get(FT).op(OP.xor).op(OP.and).i32(sh).op(OP.shrU).i32(1).op(OP.and);
        else if (k === "add" || k === "adc") c.get(FA).get(FB).op(OP.xor).i32(-1).op(OP.xor).get(FA).get(FT).op(OP.xor).op(OP.and).i32(sh).op(OP.shrU).i32(1).op(OP.and);
        else if (k === "logic") c.i32(0); else if (k === "inc") c.get(FT).i32((1 << sh) | 0).op(OP.eq); else c.get(FT).i32(((1 << sh) - 1) | 0).op(OP.eq); };
      [() => OF(), () => CF(), () => ZF(), () => { CF(); ZF(); c.op(OP.or); }, () => SF(), () => P(), () => { SF(); OF(); c.op(OP.ne); }, () => { ZF(); SF(); OF(); c.op(OP.ne); c.op(OP.or); }][base]();
    } else {
      const bit = v => { c.get(LF).i32(v).op(OP.and).i32(0).op(OP.ne); };
      [() => bit(F_OF), () => bit(F_CF), () => bit(F_ZF), () => { c.get(LF).i32(F_CF | F_ZF).op(OP.and).i32(0).op(OP.ne); }, () => bit(F_SF), () => bit(F_PF),
       () => { bit(F_SF); bit(F_OF); c.op(OP.ne); }, () => { bit(F_ZF); bit(F_SF); bit(F_OF); c.op(OP.ne); c.op(OP.or); }][base]();
    }
    if (neg) c.op(OP.eqz);
  };
  const materialize = () => {
    if (!pend) return;
    c.get(LF).i32(~(F_CF | F_PF | F_ZF | F_SF | F_OF)).op(OP.and);
    condOf(2); c.op(OP.or); condOf(10); c.i32(2).op(OP.shl).op(OP.or); condOf(4); c.i32(6).op(OP.shl).op(OP.or);
    condOf(8); c.i32(7).op(OP.shl).op(OP.or); condOf(0); c.i32(11).op(OP.shl).op(OP.or);
    c.set(LF); pend = null;
  };
  // CF / OF from a 0/1 on the stack (both set or both clear; other flags unchanged): imul / mul
  const setCfOf = () => { c.i32(F_CF | F_OF).op(OP.mul).get(LF).i32(~(F_CF | F_OF)).op(OP.and).op(OP.or).set(LF); };
  const exit = (pushEip, count) => {
    const saved = pend; materialize(); pend = saved;
    for (let i = 0; i < 8; i++) c.i32(CTX + i * 4).get(i).store();
    c.i32(CTX + 32).get(LF).store(); c.i32(CTX + 36).i32(count).store();
    if (fpuTouched) { c.i32(CTX + 44).get(LTOP).store(); c.i32(CTX + 48).get(LFSW).store(); c.i32(CTX + 52).get(LFCW).store(); }
    pushEip(); c.ret();
  };
  const push = () => { c.set(LV).get(4).i32(4).op(OP.sub).tee(4).set(LA); wr32(); };   // value on the stack
  // ALU k (0 add, 1 or, 4 and, 5 sub, 6 xor, 7 cmp) of size s: A and B pushed by a(), b(); result stored by st()
  const ALU_OP = [OP.add, OP.or, 0, 0, OP.and, OP.sub, OP.xor, OP.sub];
  const alu = (k, sz, a, b, st) => {
    const mk = MASKS[sz];
    if (k === 2 || k === 3) { condOf(2); c.set(LFC); }               // adc / sbb: the incoming carry
    a(); if (sz !== 32) c.i32(mk).op(OP.and); c.set(FA);
    b(); if (sz !== 32) c.i32(mk).op(OP.and); c.set(FB);
    if (k === 2) c.get(FA).get(FB).op(OP.add).get(LFC).op(OP.add); else if (k === 3) c.get(FA).get(FB).op(OP.sub).get(LFC).op(OP.sub); else c.get(FA).get(FB).op(ALU_OP[k]);
    if (sz !== 32) c.i32(mk).op(OP.and); c.set(FT);
    if (k !== 7) { c.get(FT); st(); }
    pend = { k: k === 0 ? "add" : k === 2 ? "adc" : k === 3 ? "sbb" : k === 5 || k === 7 ? "sub" : "logic", s: sz };
  };
  // shift of r/m32 by a count (cnt: number, or null = cl at run time)
  const shift = (o, kind, cnt) => {
    materialize();
    if (cnt === null) { c.get(1).i32(31).op(OP.and).set(LB2); c.get(LB2).i32(0).op(OP.ne).if_(); }
    else c.i32(cnt).set(LB2);
    rdRM(o); c.set(LT);
    c.get(LT).get(LB2).op(kind === 4 ? OP.shl : kind === 5 ? OP.shrU : OP.shrS).set(FT);
    c.get(LF).i32(~(F_CF | F_PF | F_ZF | F_SF | F_OF)).op(OP.and);
    c.get(FT).op(OP.eqz).i32(6).op(OP.shl).op(OP.or);
    c.get(FT).i32(31).op(OP.shrU).i32(7).op(OP.shl).op(OP.or);
    c.get(FT).i32(0xff).op(OP.and).op(OP.popcnt).i32(1).op(OP.and).op(OP.eqz).i32(2).op(OP.shl).op(OP.or);
    if (kind === 4) c.get(LT).i32(32).get(LB2).op(OP.sub).op(OP.shrU).i32(1).op(OP.and);
    else c.get(LT).get(LB2).i32(1).op(OP.sub).op(kind === 5 ? OP.shrU : OP.shrS).i32(1).op(OP.and);
    c.tee(LA2).op(OP.or);
    if (kind === 4) c.get(FT).i32(31).op(OP.shrU).get(LA2).op(OP.ne).get(LB2).i32(1).op(OP.eq).op(OP.and).i32(11).op(OP.shl).op(OP.or);
    if (kind === 5) c.get(LT).i32(31).op(OP.shrU).get(LB2).i32(1).op(OP.eq).op(OP.and).i32(11).op(OP.shl).op(OP.or);
    c.set(LF);
    c.get(FT); wrRM(o);
    if (cnt === null) c.end();
  };
  // ---- x87: registers at FPU + ((top + i) & 7) * 8 (f64), top / status / control word in locals
  const stAt = i => { c.get(LTOP); if (i) c.i32(i).op(OP.add); c.i32(7).op(OP.and).i32(3).op(OP.shl); };
  const ld = i => { stAt(i); c.loadF64(FPU); };
  const stv = (i, val) => { val(); c.set(FW); stAt(i); c.get(FW).storeF64(FPU); };      // st(i) = val()
  const fpush = val => { val(); c.set(FW); c.get(LTOP).i32(1).op(OP.sub).i32(7).op(OP.and).set(LTOP); stAt(0); c.get(FW).storeF64(FPU); };
  const fpop = () => { c.get(LTOP).i32(1).op(OP.add).i32(7).op(OP.and).set(LTOP); };
  const farith = (r, a, b) => {                          // the interpreter's farith(op, a, b)
    if (r === 5 || r === 7) { b(); a(); } else { a(); b(); }
    c.op([OP.fadd, OP.fmul, 0, 0, OP.fsub, OP.fsub, OP.fdiv, OP.fdiv][r]);
  };
  const isNan2 = () => { c.get(FV).get(FV).op(OP.fne).get(FW).get(FW).op(OP.fne).op(OP.or); };
  // compare FV with FW: status word C3 C2 C0 (x86emu fcmp)
  const fcmpSW = () => {                                  // fsw = (fsw & ~0x4700) | c
    c.i32(0x4500);
    c.i32(0x100).i32(0x4000).i32(0).get(FV).get(FW).op(OP.feq).op(OP.select).get(FV).get(FW).op(OP.flt).op(OP.select);
    isNan2(); c.op(OP.select);
    c.get(LFSW).i32(~0x4700).op(OP.and).op(OP.or).set(LFSW);
  };
  const fcomiFlags = () => {                              // x86emu fcomi: EFLAGS ZF PF CF
    materialize();
    c.i32(0x45);
    c.i32(1).i32(0x40).i32(0).get(FV).get(FW).op(OP.feq).op(OP.select).get(FV).get(FW).op(OP.flt).op(OP.select);
    isNan2(); c.op(OP.select);
    c.get(LF).i32(~(F_ZF | F_PF | F_CF | F_OF | F_SF)).op(OP.and).op(OP.or).set(LF);
  };
  const fround = () => {                                  // FV rounded by the control word's RC (x86emu fround)
    c.get(LFCW).i32(10).op(OP.shrU).i32(3).op(OP.and).set(LX);
    c.get(LX).op(OP.eqz).if_(F64).get(FV).op(OP.fnearest).else_()
      .get(LX).i32(1).op(OP.eq).if_(F64).get(FV).op(OP.ffloor).else_()
      .get(LX).i32(2).op(OP.eq).if_(F64).get(FV).op(OP.fceil).else_().get(FV).op(OP.ftrunc).end().end().end();
  };
  const toI32 = () => {                                   // FV -> i32, 0x80000000 when out of range or NaN
    c.get(FV).f64(2147483648).op(OP.fge).get(FV).f64(-2147483648).op(OP.flt).op(OP.or).get(FV).get(FV).op(OP.fne).op(OP.or)
      .if_(I32).i32(0x80000000 | 0).else_().get(FV).op(OP.truncI32).end();
  };
  const x87 = (op, at) => {
    const mb = m.r8(pc), memForm = (mb >> 6) !== 3, reg = (mb >> 3) & 7;
    if (memForm) {
      const o = modrm();
      const loadM = () => { if (op === 0xd8) rdF32(); else if (op === 0xdc) rdF64(); else if (op === 0xda) { rd32(); c.op(OP.fromI32); } else return false; return true; };
      if (op === 0xd8 || op === 0xdc || op === 0xda) {
        if (!loadM()) return false; c.set(FW); ld(0); c.set(FV);
        if (reg === 2 || reg === 3) { fcmpSW(); if (reg === 3) fpop(); return true; }
        stv(0, () => farith(reg, () => c.get(FV), () => c.get(FW))); return true;
      }
      if (op === 0xd9) {
        if (reg === 0) { fpush(() => rdF32()); return true; }
        if (reg === 2 || reg === 3) { ld(0); c.set(FW); wrF32(); if (reg === 3) fpop(); return true; }
        if (reg === 5) { rd16(); c.set(LFCW); return true; }
        if (reg === 7) { c.get(LFCW).set(LV); wr16(); return true; }
        return false;
      }
      if (op === 0xdd) {
        if (reg === 0) { fpush(() => rdF64()); return true; }
        if (reg === 2 || reg === 3) { ld(0); c.set(FW); wrF64(); if (reg === 3) fpop(); return true; }
        if (reg === 7) { c.get(LFSW).get(LTOP).i32(11).op(OP.shl).op(OP.or).set(LV); wr16(); return true; }
        return false;
      }
      if (op === 0xdb) {
        if (reg === 0) { fpush(() => { rd32(); c.op(OP.fromI32); }); return true; }
        if (reg >= 1 && reg <= 3) { ld(0); c.set(FV); if (reg === 1) c.get(FV).op(OP.ftrunc).set(FV); else { fround(); c.set(FV); }
          toI32(); c.set(LV); wr32(); if (reg !== 2) fpop(); return true; }
        return false;
      }
      if (op === 0xdf && reg === 0) { fpush(() => { rd16(); c.i32(16).op(OP.shl).i32(16).op(OP.shrS).op(OP.fromI32); }); return true; }
      return false;
    }
    pc++; const i = mb & 7;
    if (op === 0xd8) { ld(i); c.set(FW); ld(0); c.set(FV);
      if (reg === 2 || reg === 3) { fcmpSW(); if (reg === 3) fpop(); return true; }
      stv(0, () => farith(reg, () => c.get(FV), () => c.get(FW))); return true; }
    if (op === 0xdc) { if (reg === 2 || reg === 3) return false; ld(0); c.set(FW); ld(i); c.set(FV);
      stv(i, () => farith(reg >= 4 ? reg ^ 1 : reg, () => c.get(FV), () => c.get(FW))); return true; }
    if (op === 0xde) {
      if (reg === 3 && i === 1) { ld(1); c.set(FW); ld(0); c.set(FV); fcmpSW(); fpop(); fpop(); return true; }
      if (reg === 2 || reg === 3) return false;
      ld(0); c.set(FW); ld(i); c.set(FV); stv(i, () => farith(reg >= 4 ? reg ^ 1 : reg, () => c.get(FV), () => c.get(FW))); fpop(); return true; }
    if (op === 0xda && reg === 5 && i === 1) { ld(1); c.set(FW); ld(0); c.set(FV); fcmpSW(); fpop(); fpop(); return true; }
    if (op === 0xdd) {
      if (reg === 0) return true;
      if (reg === 2 || reg === 3) { stv(i, () => ld(0)); if (reg === 3) fpop(); return true; }
      if (reg === 4 || reg === 5) { ld(i); c.set(FW); ld(0); c.set(FV); fcmpSW(); if (reg === 5) fpop(); return true; }
      return false;
    }
    if (op === 0xdb && (reg === 5 || reg === 6)) { ld(i); c.set(FW); ld(0); c.set(FV); fcomiFlags(); return true; }
    if (op === 0xdf) {
      if (reg === 4 && i === 0) { c.get(0).i32(~0xffff).op(OP.and).get(LFSW).get(LTOP).i32(11).op(OP.shl).op(OP.or).i32(0xffff).op(OP.and).op(OP.or).set(0); return true; }
      if (reg === 5 || reg === 6) { ld(i); c.set(FW); ld(0); c.set(FV); fcomiFlags(); fpop(); return true; }
      return false;
    }
    if (op === 0xd9) {
      if (reg === 0) { fpush(() => ld(i)); return true; }
      if (reg === 1) { ld(0); c.set(FV); ld(i); c.set(FW); stAt(0); c.get(FW).storeF64(FPU); stAt(i); c.get(FV).storeF64(FPU); return true; }
      if (reg === 2 && i === 0) return true;
      if (reg === 4) {
        if (i === 0) { stv(0, () => { ld(0); c.op(OP.fneg); }); return true; }
        if (i === 1) { stv(0, () => { ld(0); c.op(OP.fabs); }); return true; }
        if (i === 4) { ld(0); c.set(FV); c.f64(0).set(FW); fcmpSW(); return true; }
        return false;
      }
      if (reg === 5 && i <= 6) { const k = [1, Math.log2(10), Math.LOG2E, Math.PI, Math.log10(2), Math.LN2, 0][i]; fpush(() => c.f64(k)); return true; }
      if (reg === 6 && i === 6) { c.get(LTOP).i32(1).op(OP.sub).i32(7).op(OP.and).set(LTOP); return true; }
      if (reg === 6 && i === 7) { fpop(); return true; }
      if (reg === 7 && i === 2) { stv(0, () => { ld(0); c.op(OP.fsqrt); }); return true; }
      if (reg === 7 && i === 4) { ld(0); c.set(FV); stv(0, () => fround()); return true; }
      return false;
    }
    return false;
  };
  // ---- SSE / MMX (x86-simd.mjs semantics): registers at XMMB + reg * 16, MMX at MMXB + reg * 8; float arithmetic in
  // f64 with one rounding to f32 at the end, exactly as the interpreter (getFloat32 -> double -> setFloat32)
  const xa = (r, k) => XMMB + r * 16 + k * 4;
  const memBase = () => c.get(LA).set(LXB);                // after modrm(): the operand's address
  const memLane = k => { c.get(LXB); if (k) c.i32(k * 4).op(OP.add); c.set(LA); };
  const srcLane = (o, k) => { if (o.mem) { memLane(k); rd32(); } else c.i32(xa(o.rm, k)).load(); };           // i32 bits of lane k
  const srcF = (o, k) => { srcLane(o, k); c.op(0xbe).op(OP.promote); };                                        // lane k as f64
  const dstF = (r, k) => { c.i32(xa(r, k)).loadF32().op(OP.promote); };
  const putF = (r, k, val) => { c.i32(xa(r, k)); val(); c.op(OP.demote).storeF32(); };                        // f64 value -> lane
  const putI = (r, k, val) => { c.i32(xa(r, k)); val(); c.store(); };
  const toI32T = () => {                                   // FV (already truncated / rounded) -> i32 like x86-simd toI32
    c.get(FV).get(FV).op(OP.fne).get(FV).f64(-2147483648).op(OP.flt).op(OP.or).get(FV).f64(2147483647).op(OP.fgt).op(OP.or)
      .get(FV).op(OP.fabs).f64(Infinity).op(OP.feq).op(OP.or)
      .if_(I32).i32(0x80000000 | 0).else_().get(FV).op(OP.truncI32).end();
  };
  const sse = (op2, rep) => {
    const sc = rep === 1;
    if (op2 === 0x10 || op2 === 0x28) {                    // movups / movaps load, movss (F3)
      if (sc && op2 !== 0x10) return false;
      const o = modrm(); if (o.mem) memBase();
      if (sc) { if (o.mem) { memLane(0); rd32(); c.set(X0); putI(o.reg, 0, () => c.get(X0)); for (let k = 1; k < 4; k++) putI(o.reg, k, () => c.i32(0)); }
                else putI(o.reg, 0, () => c.i32(xa(o.rm, 0)).load()); return true; }
      if (op2 === 0x10 && rep) return false;
      for (let k = 0; k < 4; k++) { srcLane(o, k); c.set([X0, X1, X2, X3][k]); }
      for (let k = 0; k < 4; k++) putI(o.reg, k, () => c.get([X0, X1, X2, X3][k])); return true;
    }
    if (op2 === 0x11 || op2 === 0x29 || op2 === 0x2b) {     // stores
      if (op2 !== 0x11 && rep) return false;
      const o = modrm(), n = sc ? 1 : 4;
      if (o.mem) { memBase(); for (let k = 0; k < n; k++) { memLane(k); c.i32(xa(o.reg, k)).load().set(LV); wr32(); } }
      else for (let k = 0; k < n; k++) putI(o.rm, k, () => c.i32(xa(o.reg, k)).load());
      return true;
    }
    if (rep) {                                              // F3 scalar forms
      if ([0x51, 0x52, 0x53, 0x58, 0x59, 0x5c, 0x5d, 0x5e, 0x5f].includes(op2)) { const o = modrm(); if (o.mem) memBase(); arithLane(op2, o, 0); return true; }
      if (op2 === 0x2a) { const o = modrm(); rdRM(o); c.set(X0); putI(o.reg, 0, () => c.get(X0).op(0xb2).op(0xbc)); return true; }   // cvtsi2ss (f32.convert_i32_s)
      if (op2 === 0x2c) { const o = modrm(); if (o.mem) memBase(); srcF(o, 0); c.op(OP.ftrunc).set(FV); toI32T(); c.set(o.reg); return true; }   // cvttss2si
      if (op2 === 0xc2) { const o = modrm(); if (o.mem) memBase(); const imm = b8() & 7; cmpLane(o, 0, imm); return true; }
      return false;
    }
    if (op2 === 0x12 || op2 === 0x16) {                    // movlps / movhps load; movhlps / movlhps
      const o = modrm(), hi = op2 === 0x16;
      if (o.mem) { memBase(); memLane(0); rd32(); c.set(X0); memLane(1); rd32(); c.set(X1); putI(o.reg, hi ? 2 : 0, () => c.get(X0)); putI(o.reg, hi ? 3 : 1, () => c.get(X1)); }
      else if (hi) { c.i32(xa(o.rm, 0)).load().set(X0); c.i32(xa(o.rm, 1)).load().set(X1); putI(o.reg, 2, () => c.get(X0)); putI(o.reg, 3, () => c.get(X1)); }
      else { c.i32(xa(o.rm, 2)).load().set(X0); c.i32(xa(o.rm, 3)).load().set(X1); putI(o.reg, 0, () => c.get(X0)); putI(o.reg, 1, () => c.get(X1)); }
      return true;
    }
    if (op2 === 0x13 || op2 === 0x17) { const o = modrm(); if (!o.mem) return false; memBase(); const b = op2 === 0x17 ? 2 : 0;
      for (let k = 0; k < 2; k++) { memLane(k); c.i32(xa(o.reg, b + k)).load().set(LV); wr32(); } return true; }
    if (op2 === 0x14 || op2 === 0x15) { const o = modrm(); if (o.mem) memBase(); const k0 = op2 === 0x14 ? 0 : 2;
      c.i32(xa(o.reg, k0)).load().set(X0); c.i32(xa(o.reg, k0 + 1)).load().set(X1); srcLane(o, k0); c.set(X2); srcLane(o, k0 + 1); c.set(X3);
      putI(o.reg, 0, () => c.get(X0)); putI(o.reg, 1, () => c.get(X2)); putI(o.reg, 2, () => c.get(X1)); putI(o.reg, 3, () => c.get(X3)); return true; }
    if (op2 === 0xc6) { const o = modrm(); if (o.mem) memBase(); const imm = b8();
      c.i32(xa(o.reg, imm & 3)).load().set(X0); c.i32(xa(o.reg, (imm >> 2) & 3)).load().set(X1); srcLane(o, (imm >> 4) & 3); c.set(X2); srcLane(o, (imm >> 6) & 3); c.set(X3);
      for (let k = 0; k < 4; k++) putI(o.reg, k, () => c.get([X0, X1, X2, X3][k])); return true; }
    if (op2 >= 0x54 && op2 <= 0x57) { const o = modrm(); if (o.mem) memBase();
      for (let k = 0; k < 4; k++) { putI(o.reg, k, () => { c.i32(xa(o.reg, k)).load(); if (op2 === 0x55) c.i32(-1).op(OP.xor); srcLane(o, k); c.op([OP.and, OP.and, OP.or, OP.xor][op2 - 0x54]); }); } return true; }
    if ([0x51, 0x52, 0x53, 0x58, 0x59, 0x5c, 0x5d, 0x5e, 0x5f].includes(op2)) { const o = modrm(); if (o.mem) memBase(); for (let k = 0; k < 4; k++) arithLane(op2, o, k); return true; }
    if (op2 === 0xc2) { const o = modrm(); if (o.mem) memBase(); const imm = b8() & 7; for (let k = 0; k < 4; k++) cmpLane(o, k, imm); return true; }
    if (op2 === 0x2e || op2 === 0x2f) { const o = modrm(); if (o.mem) memBase(); materialize();                              // (u)comiss
      dstF(o.reg, 0); c.set(FV); srcF(o, 0); c.set(FW);
      c.i32(0x45); c.i32(1).i32(0x40).i32(0).get(FV).get(FW).op(OP.feq).op(OP.select).get(FV).get(FW).op(OP.flt).op(OP.select);
      c.get(FV).get(FV).op(OP.fne).get(FW).get(FW).op(OP.fne).op(OP.or).op(OP.select);
      c.get(LF).i32(~(0x40 | 4 | 1 | 0x800 | 0x80 | 0x10)).op(OP.and).op(OP.or).set(LF); return true; }
    if (op2 === 0x50) { const o = modrm(); if (o.mem) return false;                                                            // movmskps
      c.i32(0); for (let k = 0; k < 4; k++) { c.i32(xa(o.rm, k)).load().i32(31).op(OP.shrU); if (k) c.i32(k).op(OP.shl); c.op(OP.or); } c.set(o.reg); return true; }
    // MMX moves
    if (op2 === 0x77) return true;                          // emms
    if (op2 === 0x6e) { const o = modrm(); rdRM(o); c.set(X0); c.i32(MMXB + o.reg * 8).get(X0).store(); c.i32(MMXB + o.reg * 8 + 4).i32(0).store(); return true; }
    if (op2 === 0x7e) { const o = modrm(); c.i32(MMXB + o.reg * 8).load(); wrRM(o); return true; }
    if (op2 === 0x6f) { const o = modrm();
      if (o.mem) { memBase(); memLane(0); rd32(); c.set(X0); memLane(1); rd32(); c.set(X1); }
      else { c.i32(MMXB + o.rm * 8).load().set(X0); c.i32(MMXB + o.rm * 8 + 4).load().set(X1); }
      c.i32(MMXB + o.reg * 8).get(X0).store(); c.i32(MMXB + o.reg * 8 + 4).get(X1).store(); return true; }
    if (op2 === 0x7f || op2 === 0xe7) { const o = modrm();
      if (o.mem) { memBase(); for (let k = 0; k < 2; k++) { memLane(k); c.i32(MMXB + o.reg * 8 + k * 4).load().set(LV); wr32(); } }
      else for (let k = 0; k < 2; k++) c.i32(MMXB + o.rm * 8 + k * 4).i32(MMXB + o.reg * 8 + k * 4).load().store();
      return true; }
    return false;
  };
  function arithLane(op2, o, k) {
    putF(o.reg, k, () => {
      if (op2 === 0x51) { srcF(o, k); c.op(OP.fsqrt); return; }
      if (op2 === 0x52) { c.f64(1); srcF(o, k); c.op(OP.fsqrt).op(OP.fdiv); return; }
      if (op2 === 0x53) { c.f64(1); srcF(o, k); c.op(OP.fdiv); return; }
      dstF(o.reg, k); c.set(FV); srcF(o, k); c.set(FW);
      if (op2 === 0x5d) { c.get(FV).get(FW).get(FV).get(FW).op(OP.flt).op(OP.select); return; }
      if (op2 === 0x5f) { c.get(FV).get(FW).get(FV).get(FW).op(OP.fgt).op(OP.select); return; }
      c.get(FV).get(FW).op({ 0x58: OP.fadd, 0x59: OP.fmul, 0x5c: OP.fsub, 0x5e: OP.fdiv }[op2]);
    });
  }
  function cmpLane(o, k, imm) {                          // cmpps / cmpss: all ones where true
    dstF(o.reg, k); c.set(FV); srcF(o, k); c.set(FW);
    const un = () => { c.get(FV).get(FV).op(OP.fne).get(FW).get(FW).op(OP.fne).op(OP.or); };
    const t = [() => c.get(FV).get(FW).op(OP.feq), () => c.get(FV).get(FW).op(OP.flt), () => c.get(FV).get(FW).op(OP.fle), un,
      () => { c.get(FV).get(FW).op(OP.feq).op(OP.eqz); }, () => { c.get(FV).get(FW).op(OP.flt).op(OP.eqz); }, () => { c.get(FV).get(FW).op(OP.fle).op(OP.eqz); }, () => { un(); c.op(OP.eqz); }][imm];
    putI(o.reg, k, () => { c.i32(0); t(); c.op(OP.sub); });    // 0 - (0 | 1)
  }
  const visited = new Set(), ats = [];                   // ats: instruction addresses in the order translated
  let ended = false;
  for (; n < maxInsns; ) {
    if (visited.has(pc) || (n > 0 && hooks.has(pc))) break;
    visited.add(pc);
    const at = pc; let op = b8(); ats.push(at);
    const peekReg = () => (m.r8(pc) >> 3) & 7;
    if (op === 0x0f) {
      const op2 = b8();
      if (op2 >= 0x80 && op2 <= 0x8f) { const d = b32(), tgt = (pc + d) >>> 0; n++; condOf(op2 & 15); c.if_(); exit(() => c.i32(tgt), n); c.end(); continue; }
      if (op2 === 0xb6 || op2 === 0xb7 || op2 === 0xbe || op2 === 0xbf) {
        const o = modrm(), w = op2 & 1, sx = op2 >= 0xbe;
        if (o.mem) { if (w) rd16(); else rd8(); }
        else if (w) c.get(o.rm).i32(0xffff).op(OP.and); else rdR8(o.rm);
        if (sx) c.i32(w ? 16 : 24).op(OP.shl).i32(w ? 16 : 24).op(OP.shrS);
        c.set(o.reg); n++; continue;
      }
      if (op2 >= 0x90 && op2 <= 0x9f) { const o = modrm(); condOf(op2 & 15); wrRM8(o); n++; continue; }                     // setcc
      if (op2 >= 0x40 && op2 <= 0x4f) { const o = modrm(); rdRM(o); c.set(LT); condOf(op2 & 15); c.if_().get(LT).set(o.reg).end(); n++; continue; }   // cmovcc
      if (op2 === 0xaf) { const o = modrm(); materialize(); rdRM(o); c.set(FB); c.get(o.reg).set(FA); imul3(); c.set(o.reg); n++; continue; }
      { const save = c.b.length, savePend = pend; let okx = false; try { okx = sse(op2, 0); } catch { okx = false; }
        if (okx) { n++; continue; } c.b.length = save; pend = savePend; }
      pc = at; break;
    }
    if (op >= 0xd8 && op <= 0xdf) {
      const save = { b: c.b.length };                    // (an unsupported form leaves no code behind)
      let okx = false; try { okx = x87(op, at); } catch { okx = false; }
      if (!okx) { c.b.length = save.b; pc = at; break; }
      fpuTouched = true; n++; continue;
    }
    if (op === 0x9b) { n++; continue; }                                                                                         // fwait
    if (op === 0xc9) { c.get(5).set(4); c.get(4).set(LA); rd32(); c.set(5); c.get(4).i32(4).op(OP.add).set(4); n++; continue; }   // leave
    if (op === 0xfe && (m.r8(pc) >> 3 & 7) < 2) { const o = modrm(), dec = o.reg === 1; materialize();                          // inc / dec r/m8
      rdRM8(o); c.tee(FA).i32(1).op(dec ? OP.sub : OP.add).i32(0xff).op(OP.and).tee(FT); wrRM8(o); pend = { k: dec ? "dec" : "inc", s: 8 }; n++; continue; }
    if (op === 0x66) {                                                                                                           // 16-bit moves
      const op2 = m.r8(pc);
      const setLow16 = i => { c.i32(0xffff).op(OP.and).set(LT); c.get(i).i32(~0xffff).op(OP.and).get(LT).op(OP.or).set(i); };   // value on the stack
      if (op2 === 0x8b) { pc++; const o = modrm(); if (o.mem) rd16(); else c.get(o.rm); setLow16(o.reg); n++; continue; }
      if (op2 === 0x89) { pc++; const o = modrm(); c.get(o.reg); if (o.mem) { c.i32(0xffff).op(OP.and).set(LV); wr16(); } else setLow16(o.rm); n++; continue; }
      if (op2 === 0xc7 && ((m.r8(pc + 1) >> 3) & 7) === 0) { pc++; const o = modrm(); const v = m.r16(pc); pc += 2; c.i32(v); if (o.mem) { c.set(LV); wr16(); } else setLow16(o.rm); n++; continue; }
      if (op2 === 0x0f && m.r8(pc + 1) === 0xb6) { pc += 2; const o = modrm(); rdRM8(o); setLow16(o.reg); n++; continue; }
      pc = at; break;
    }
    if (op === 0x9e) { materialize(); c.get(LF).i32(~0xd5).op(OP.and).get(0).i32(8).op(OP.shrU).i32(0xd5).op(OP.and).op(OP.or).set(LF); n++; continue; }   // sahf
    if (op === 0xf3 && m.r8(pc) === 0x0f) {                                                                                   // F3 0F: scalar SSE
      pc++; const op2 = b8(), save = c.b.length, savePend = pend; let okx = false; try { okx = sse(op2, 1); } catch { okx = false; }
      if (okx) { n++; continue; } c.b.length = save; pend = savePend; pc = at; break;
    }
    if (op === 0x66 || op === 0xf2 || op === 0xf3 || op === 0x64 || op === 0x2e || op === 0x3e || op === 0x26 || op === 0x36 || op === 0x65) { pc = at; break; }
    // ALU forms: 32-bit (op & 7 = 1, 3, 5), 8-bit (0, 2, 4), 80/82 (imm8 to r/m8), 81/83
    if (op < 0x40 && (op & 7) < 6) {
      const k = op >> 3, form = op & 7, sz = form & 1 ? 32 : 8;
      if (form === 4) { const v = b8(); alu(k, 8, () => rdR8(0), () => c.i32(v), () => wrR8(0)); n++; continue; }
      if (form === 5) { const v = b32(); alu(k, 32, () => c.get(0), () => c.i32(v), () => c.set(0)); n++; continue; }
      const o = modrm(), toReg = form >= 2;
      if (sz === 32) alu(k, 32, toReg ? () => c.get(o.reg) : () => rdRM(o), toReg ? () => rdRM(o) : () => c.get(o.reg), toReg ? () => c.set(o.reg) : () => wrRM(o));
      else alu(k, 8, toReg ? () => rdR8(o.reg) : () => rdRM8(o), toReg ? () => rdRM8(o) : () => rdR8(o.reg), toReg ? () => wrR8(o.reg) : () => wrRM8(o));
      n++; continue;
    }
    if (op === 0x81 || op === 0x83 || op === 0x80 || op === 0x82) {
      const o = modrm(), k = o.reg;
      if (op === 0x81 || op === 0x83) { const v = op === 0x81 ? b32() : s8(); alu(k, 32, () => rdRM(o), () => c.i32(v), () => wrRM(o)); }
      else { const v = b8(); alu(k, 8, () => rdRM8(o), () => c.i32(v), () => wrRM8(o)); }
      n++; continue;
    }
    if (op === 0x85 || op === 0xa9 || (op === 0xf7 && peekReg() === 0)) {
      if (op === 0xa9) c.get(0).i32(b32());
      else if (op === 0x85) { const o = modrm(); rdRM(o); c.get(o.reg); }
      else { const o = modrm(); rdRM(o); c.i32(b32()); }
      c.op(OP.and).set(FT); pend = { k: "logic", s: 32 }; n++; continue;
    }
    if (op === 0x84 || op === 0xa8 || (op === 0xf6 && peekReg() === 0)) {                                                    // test 8-bit
      if (op === 0xa8) { rdR8(0); c.i32(b8()); }
      else if (op === 0x84) { const o = modrm(); rdRM8(o); rdR8(o.reg); }
      else { const o = modrm(); rdRM8(o); c.i32(b8()); }
      c.op(OP.and).set(FT); pend = { k: "logic", s: 8 }; n++; continue;
    }
    if (op === 0xf7 && (peekReg() === 2 || peekReg() === 3)) { const o = modrm();
      if (o.reg === 2) { rdRM(o); c.i32(-1).op(OP.xor); wrRM(o); }
      else { rdRM(o); c.set(FB); c.i32(0).set(FA); c.get(FA).get(FB).op(OP.sub).tee(FT); wrRM(o); pend = { k: "sub", s: 32 }; }
      n++; continue; }
    if (op === 0xf7 && peekReg() === 4) { const o = modrm(); materialize();                                                     // mul: edx:eax = eax * r/m
      rdRM(o); c.set(LT);
      c.get(0).op(0xad).get(LT).op(0xad).op(0x7e).op(0x42, 32).op(0x88).op(0xa7).set(2);                                        // edx = high
      c.get(0).get(LT).op(OP.mul).set(0);
      c.get(2).i32(0).op(OP.ne); setCfOf(); n++; continue; }
    if (op >= 0x40 && op < 0x50) { const i = op & 7, dec = op >= 0x48; materialize();
      c.get(i).set(FA).get(i).i32(1).op(dec ? OP.sub : OP.add).tee(FT).set(i); pend = { k: dec ? "dec" : "inc", s: 32 }; n++; continue; }
    if (op === 0xff) {
      const r = peekReg();
      if (r === 0 || r === 1) { const o = modrm(); materialize(); rdRM(o); c.tee(FA).i32(1).op(r ? OP.sub : OP.add).tee(FT); wrRM(o); pend = { k: r ? "dec" : "inc", s: 32 }; n++; continue; }
      if (r === 2) { const o = modrm(), ret = pc; n++; rdRM(o); c.set(LA2); c.i32(ret); push(); exit(() => c.get(LA2), n); ended = true; break; }     // call [r/m]
      if (r === 4) { const o = modrm(); n++; rdRM(o); c.set(LA2); exit(() => c.get(LA2), n); ended = true; break; }                            // jmp [r/m]
      if (r === 6) { const o = modrm(); rdRM(o); push(); n++; continue; }                                                                        // push r/m
      pc = at; break;
    }
    if (op >= 0x50 && op < 0x58) { c.get(op & 7); push(); n++; continue; }
    if (op >= 0x58 && op < 0x60) { const i = op & 7; c.get(4).set(LA); rd32(); c.set(LT); c.get(4).i32(4).op(OP.add).set(4); c.get(LT).set(i); n++; continue; }
    if (op === 0x68 || op === 0x6a) { const v = op === 0x68 ? b32() : s8(); c.i32(v); push(); n++; continue; }
    if (op >= 0xb8 && op < 0xc0) { c.i32(b32()).set(op & 7); n++; continue; }
    if (op >= 0xb0 && op < 0xb8) { c.i32(b8()); wrR8(op & 7); n++; continue; }
    if (op === 0x8b) { const o = modrm(); rdRM(o); c.set(o.reg); n++; continue; }
    if (op === 0x89) { const o = modrm(); c.get(o.reg); wrRM(o); n++; continue; }
    if (op === 0x8a) { const o = modrm(); rdRM8(o); wrR8(o.reg); n++; continue; }
    if (op === 0x88) { const o = modrm(); rdR8(o.reg); wrRM8(o); n++; continue; }
    if (op === 0xc7 && peekReg() === 0) { const o = modrm(); const v = b32(); c.i32(v); wrRM(o); n++; continue; }
    if (op === 0xc6 && peekReg() === 0) { const o = modrm(); const v = b8(); c.i32(v); wrRM8(o); n++; continue; }
    if (op === 0xa1) { c.i32(b32()).set(LA); rd32(); c.set(0); n++; continue; }                                                 // mov eax, [moffs]
    if (op === 0xa3) { c.i32(b32()).set(LA); c.get(0).set(LV); wr32(); n++; continue; }
    if (op === 0xa0) { c.i32(b32()).set(LA); rd8(); wrR8(0); n++; continue; }
    if (op === 0xa2) { c.i32(b32()).set(LA); rdR8(0); c.set(LV); wr8(); n++; continue; }
    if (op === 0x8d) { const o = modrm(); if (!o.mem) { pc = at; break; } c.get(LA).set(o.reg); n++; continue; }
    if (op === 0x69 || op === 0x6b) { const o = modrm(); materialize(); rdRM(o); c.set(FA); c.i32(op === 0x69 ? b32() : s8()).set(FB); imul3(); c.set(o.reg); n++; continue; }
    if (op === 0x87) { const o = modrm(); rdRM(o); c.set(LA2); c.get(o.reg); wrRM(o); c.get(LA2).set(o.reg); n++; continue; }   // xchg r/m32, r32
    if (op > 0x90 && op < 0x98) { const i = op & 7; c.get(0).set(LT).get(i).set(0).get(LT).set(i); n++; continue; }
    if (op === 0x90) { n++; continue; }
    if (op === 0x99) { c.get(0).i32(31).op(OP.shrS).set(2); n++; continue; }                                                  // cdq
    if (op === 0x98) { c.get(0).i32(16).op(OP.shl).i32(16).op(OP.shrS).set(0); n++; continue; }                               // cwde
    if (op === 0xc1 || op === 0xd1 || op === 0xd3) { const o = modrm(); const kind = o.reg; if (kind !== 4 && kind !== 5 && kind !== 7) { pc = at; break; }
      const cnt = op === 0xc1 ? b8() & 31 : op === 0xd1 ? 1 : null;
      if (cnt === 0) { n++; continue; }
      shift(o, kind, cnt); n++; continue;
    }
    if (op >= 0x70 && op < 0x80) { const d = s8(), tgt = (pc + d) >>> 0; n++; condOf(op & 15); c.if_(); exit(() => c.i32(tgt), n); c.end(); continue; }
    if (op === 0xeb || op === 0xe9) { const d = op === 0xeb ? s8() : b32(); n++; pc = (pc + d) >>> 0; continue; }
    if (op === 0xe8) { const d = b32(), ret = pc, tgt = (pc + d) >>> 0; n++;
      c.i32(ret); push();
      if (inl.length < 3 && !hooks.has(tgt) && !visited.has(tgt)) { inl.push(ret); pc = tgt; continue; }
      exit(() => c.i32(tgt), n); ended = true; break;
    }
    if (op === 0xc3 || op === 0xc2) { const extra = op === 0xc2 ? m.r16(pc) : 0; if (op === 0xc2) pc += 2; n++;
      c.get(4).set(LA); rd32(); c.set(LT); c.get(4).i32(4 + extra).op(OP.add).set(4);
      if (inl.length && !hooks.has(inl.at(-1))) { const want = inl.pop(); c.get(LT).i32(want).op(OP.ne).if_(); exit(() => c.get(LT), n); c.end(); pc = want; continue; }
      exit(() => c.get(LT), n); ended = true; break;
    }
    pc = at; break;
  }
  if (!n) return null;
  if (!ended) exit(() => c.i32(pc), n);
  c.i32(0);                                              // unreachable: the function's result type
  return { code: c, start, n, ats: ats.slice(0, n) };
  // imul: FA * FB (signed) -> result on the stack; CF = OF = the product does not fit in 32 bits
  function imul3() {
    c.get(FA).get(FB).op(OP.mul);
    c.get(FA).op(0xac).get(FB).op(0xac).op(0x7e).get(FA).get(FB).op(OP.mul).op(0xac).op(0x52); setCfOf();
  }
}

// ---------------------------------------------------------------------- translated modules on disk
// <dir>/w<key>/: m<N>.wz (one batch module, as compiled, gzip: ~25x smaller) + m<N>.jz (its blocks as gzip JSON:
// start, function, instruction count, instruction addresses). key = hash(wasm-jit.mjs + wasm-emit.mjs sources, the game image, the memory layout).
// A cached block is used only when none of its instruction addresses is hooked now (like x86-jit-cache.mjs).
// Modules are compiled in the background (WebAssembly.compile) while the live loop is ahead of real time
// (prefetch), else synchronously on first use.
export class WasmCache {
  // lo..hi: the address range whose bytes the key covers (the game image); blocks with code elsewhere are not listed
  constructor(dir, parts, log = () => {}, lo = 0, hi = 0xffffffff) {
    this.lo = lo; this.hi = hi;
    const h = createHash("sha256");
    for (const f of ["wasm-jit.mjs", "wasm-emit.mjs"]) h.update(readFileSync(new URL(`./${f}`, import.meta.url)));
    for (const p of parts) h.update(p); h.update(`layout:${LOW}:${MEM_PAGES}:${MAX_BLOCKS}`);
    this.dir = join(dir, "w" + h.digest("hex").slice(0, 15)); this.log = log;
    this.index = new Map(); this.mods = new Map(); this.next = 0; this.pending = []; this.prefetchList = null;
    const t0 = performance.now();
    try { for (const d of readdirSync(dir)) if (/^w[0-9a-f]{15}$/.test(d) && join(dir, d) !== this.dir) {   // other versions, unused for 10 minutes
      const age = Date.now() - statSync(join(dir, d)).mtimeMs; if (age > 10 * 60 * 1000) rmSync(join(dir, d), { recursive: true, force: true }); } } catch {}
    try {
      if (existsSync(this.dir)) for (const f of readdirSync(this.dir)) {
        const mt = /^m(\d+)\.jz$/.exec(f); if (!mt) continue;
        const id = +mt[1]; let blocks;
        try { blocks = JSON.parse(gunzipSync(readFileSync(join(this.dir, f))).toString()); } catch { continue; }
        if (!existsSync(join(this.dir, `m${id}.wz`))) continue;
        this.mods.set(id, { blocks, module: null, inst: null, job: null });
        for (const b of blocks) if (!this.index.has(b.start)) this.index.set(b.start, { mod: id });
        this.next = Math.max(this.next, id + 1);
      }
    } catch (e) { log(`wasm cache: unreadable (${e.message})`); }
    this.stats = { modules: this.mods.size, blocks: this.index.size, loaded: 0, prefetched: 0, saved: 0, indexMs: Math.round(performance.now() - t0) };
  }
  // an instance of module id (compiled in the background if that finished, else now)
  instance(id, wj) {
    const md = this.mods.get(id); if (!md) return null;
    if (md.inst) return md.inst;
    if (!md.module) md.module = new WebAssembly.Module(gunzipSync(readFileSync(join(this.dir, `m${id}.wz`))));
    md.inst = new WebAssembly.Instance(md.module, wj.importObject()); this.stats.loaded++;
    return md.inst;
  }
  // background compilation: one module at a time; returns false when nothing is left
  prefetch() {
    this.prefetchList ??= [...this.mods.keys()];
    if (this.job && !this.job.done) return true;
    while (this.prefetchList.length) {
      const id = this.prefetchList.shift(), md = this.mods.get(id); if (!md || md.module) continue;
      const job = this.job = { done: false };
      fsp.readFile(join(this.dir, `m${id}.wz`)).then(b => new Promise((ok, no) => gunzip(b, (e, r) => e ? no(e) : ok(r)))).then(b => WebAssembly.compile(b)).then(mod => { if (!md.module) md.module = mod; this.stats.prefetched++; }, () => {}).finally(() => { job.done = true; });
      return true;
    }
    return false;
  }
  // a module just compiled from translations
  add(bytes, blocks) {
    blocks = blocks.filter(b => b.ats.every(a => a >= this.lo && a < this.hi)); if (!blocks.length) return;
    const id = this.next++;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, `m${id}.wz`), gzipSync(bytes, { level: 1 }));
      const tmp = join(this.dir, `m${id}.jz.tmp`); writeFileSync(tmp, gzipSync(JSON.stringify(blocks), { level: 1 })); renameSync(tmp, join(this.dir, `m${id}.jz`));   // the list last: a module without its list is ignored
      this.stats.saved++;
    } catch (e) { this.log(`wasm cache: save failed (${e.message})`); }
  }
}
