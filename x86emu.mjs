// x86emu.mjs — an x86-32 interpreter that runs the game's own compiled code (default.exe, mapped flat at 0x10000).
//
// Used to run game functions the UI calls (native handlers) instead of hand-porting each one: the code is the
// original, and only the boundary to the rest of the machine is replaced by JavaScript "hooks" (C runtime helpers,
// the database layer, memory allocation, audio/graphics/streaming calls the frontend makes for effect).
//
// Coverage: the integer instruction set MSVC 7 emits (ALU, shifts, mul/div, string ops with rep, setcc, movzx/movsx,
// bt*, shld/shrd, bswap, cmov) with 8/16/32-bit operands, and the x87 subset it uses (loads/stores in all sizes,
// arithmetic, compares with fnstsw/fcomi, control word, transcendental helpers), and MMX/SSE (x86-simd.mjs). Unknown opcodes throw with the
// address so they can be added.

import { installSimd } from "./x86-simd.mjs";

const F_CF = 1, F_PF = 4, F_ZF = 0x40, F_SF = 0x80, F_DF = 0x400, F_OF = 0x800;
const PARITY = new Uint8Array(256).map((_, i) => { let p = 1; for (let b = i; b; b >>= 1) p ^= b & 1; return p; });
const f32b = new DataView(new ArrayBuffer(8));
const HOOK_SPAN = 0x400000;                       // the game image (code at 0x10000-0x3FFFFF)
let SLOW_DISPATCH = !!process.env.NT04_SLOW_DISPATCH;     // A/B switch for runUntil's inner block loop
export const setSlowDispatch = v => { SLOW_DISPATCH = !!v; };

export class X86 {
  constructor(mem, { hooks = new Map(), log = () => {}, trace = false } = {}) {
    this.m = mem; this.hooks = hooks; this.log = log; this.trace = trace;
    this.r = new Uint32Array(8);                 // eax ecx edx ebx esp ebp esi edi
    this.eip = 0; this.flags = 2;
    this.fpu = new Float64Array(8); this.ftop = 0; this.fsw = 0; this.fcw = 0x27f; this.ftag = 0xff;
    this.steps = 0; this.callDepth = 0; this.recent = []; this.frames = new Float64Array(1024); this.fn = 0; this.nextTick = Infinity;
    this.fsBase = 0;                              // fs:[0] (SEH chain) lives here
    this.pm = null;                               // a ModRM operand already decoded (x86-jit.mjs fallbacks)
    this.simdInit();                              // MMX / SSE registers (x86-simd.mjs)
    // hooked addresses in the image range as a bitmap (checked per block); setting or removing a hook keeps it in
    // step and drops compiled code (a block must not run through a newly hooked address)
    this.hookBits = new Uint8Array(HOOK_SPAN);
    for (const a of hooks.keys()) if (a < HOOK_SPAN) this.hookBits[a] = 1;
    const set = hooks.set.bind(hooks), del = hooks.delete.bind(hooks), cpu = this;
    hooks.set = (a, f) => { if (a < HOOK_SPAN) { if (!cpu.hookBits[a]) { cpu.jit?.flush(); cpu.wasm?.flush(); } cpu.hookBits[a] = 1; } return set(a, f); };
    hooks.delete = a => { if (a < HOOK_SPAN) cpu.hookBits[a] = 0; cpu.jit?.flush(); cpu.wasm?.flush(); return del(a); };
    // Every field the CPU ever gets is declared here, with the representation it will end up with, so the object's
    // hidden class never changes after construction. Compiled blocks (thousands of separate functions, x86-jit.mjs)
    // read c.steps / c.eip / c.flags constantly; a hidden-class change during boot left those property accesses
    // megamorphic for good (slow generic lookups in every block compiled before it).
    this.jit = undefined; this.wasm = undefined; this.stepLimit = undefined; this.tickInterval = undefined; this.onTick = null; this.watch = undefined;
    this.seg = 0; this.hookReturn = null; this.passThrough = null; this.yieldNow = false; this.inTick = false; this.lim = 0;
    this.xtmp = undefined; this.xtmpI = 0;
    for (const k of ["steps", "eip", "nextTick", "lim", "fsBase"]) { const v = this[k]; this[k] = 0.5; this[k] = v; }        // doubles (steps passes 2^31 within seconds)
    for (const k of ["hookReturn", "passThrough", "stepLimit", "tickInterval"]) { const v = this[k]; this[k] = 0.5; this[k] = {}; this[k] = v; }   // number or null/undefined
  }
  // ---------------------------------------------------------------- registers
  get eax() { return this.r[0]; } set eax(v) { this.r[0] = v; }
  get esp() { return this.r[4]; } set esp(v) { this.r[4] = v; }
  reg8(i) { return i < 4 ? this.r[i] & 0xff : (this.r[i - 4] >>> 8) & 0xff; }
  setReg8(i, v) { if (i < 4) this.r[i] = (this.r[i] & ~0xff) | (v & 0xff); else this.r[i - 4] = (this.r[i - 4] & ~0xff00) | ((v & 0xff) << 8); }
  reg16(i) { return this.r[i] & 0xffff; }
  setReg16(i, v) { this.r[i] = (this.r[i] & 0xffff0000) | (v & 0xffff); }
  push(v) { this.r[4] -= 4; this.m.w32(this.r[4], v); }
  pop() { const v = this.m.r32(this.r[4]); this.r[4] += 4; return v; }
  arg(i) { return this.m.r32(this.r[4] + i * 4); }              // cdecl argument i inside a hook (return address already popped)

  // a shadow call stack (frames whose return slot is still on the stack) for error reports
  // frames: [from, to, sp] triples in a fixed Float64Array, fn = entries used (no allocation per call)
  noteCall(from, to, sp = this.r[4]) {
    const f = this.frames; let n = this.fn; while (n && f[n - 1] <= sp) n -= 3;
    if (n > 1020) { f.copyWithin(0, 3, n); n -= 3; }
    f[n] = from; f[n + 1] = to; f[n + 2] = sp; this.fn = n + 3;
  }
  callStack() {
    const sp = this.r[4], f = this.frames, out = []; for (let i = 0; i < this.fn; i += 3) if (f[i + 2] >= sp) out.push(`${f[i].toString(16)}->${f[i + 1].toString(16)}`);
    // compiled code does not record calls: return addresses found on the stack (words pointing just past a call
    // instruction in the image), innermost first
    const scan = [];
    try { for (let a = sp >>> 0; a < (sp >>> 0) + 0x4000 && scan.length < 12; a += 4) { const v = this.m.r32(a);
      if (v < 0x10005 || v >= HOOK_SPAN) continue;
      const m = this.m; if (m.r8(v - 5) === 0xe8 || (m.r8(v - 2) === 0xff && ((m.r8(v - 1) >> 3) & 7) === 2) || (m.r8(v - 3) === 0xff && ((m.r8(v - 2) >> 3) & 7) === 2) || (m.r8(v - 6) === 0xff && ((m.r8(v - 5) >> 3) & 7) === 2)) scan.push(`<-${v.toString(16)}`); } } catch {}
    return out.join(" ") + (scan.length ? ` | stack ${scan.join(" ")}` : "");
  }

  // ---------------------------------------------------------------- fetch
  f8() { return this.m.r8(this.eip++); }
  f16() { const v = this.m.r16(this.eip); this.eip += 2; return v; }
  f32() { const v = this.m.r32(this.eip); this.eip += 4; return v; }
  s8() { return (this.f8() << 24) >> 24; }

  // ModRM: returns { reg, mod, rm, addr } (addr undefined for register operands)
  modrm() {
    if (this.pm !== null) { const o = this.pm; this.pm = null; return o; }   // pre-decoded by the block compiler
    const b = this.f8(), mod = b >> 6, reg = (b >> 3) & 7, rm = b & 7;
    if (mod === 3) return { reg, mod, rm };
    let addr;
    if (rm === 4) {
      const sib = this.f8(), sc = sib >> 6, idx = (sib >> 3) & 7, base = sib & 7;
      addr = idx === 4 ? 0 : this.r[idx] << sc;
      if (base === 5 && mod === 0) addr += this.f32(); else addr += this.r[base];
    } else if (rm === 5 && mod === 0) addr = this.f32();
    else addr = this.r[rm];
    if (mod === 1) addr += this.s8(); else if (mod === 2) addr += this.f32() | 0;
    if (this.seg === 4) addr += this.fsBase;
    return { reg, mod, rm, addr: addr >>> 0 };
  }
  rd(o, sz) { if (o.addr === undefined) return sz === 8 ? this.reg8(o.rm) : sz === 16 ? this.reg16(o.rm) : this.r[o.rm];
              return sz === 8 ? this.m.r8(o.addr) : sz === 16 ? this.m.r16(o.addr) : this.m.r32(o.addr); }
  wr(o, sz, v) { if (o.addr === undefined) { if (sz === 8) this.setReg8(o.rm, v); else if (sz === 16) this.setReg16(o.rm, v); else this.r[o.rm] = v >>> 0; return; }
                 if (sz === 8) this.m.w8(o.addr, v); else if (sz === 16) this.m.w16(o.addr, v); else this.m.w32(o.addr, v >>> 0); }
  rdReg(i, sz) { return sz === 8 ? this.reg8(i) : sz === 16 ? this.reg16(i) : this.r[i]; }
  wrReg(i, sz, v) { if (sz === 8) this.setReg8(i, v); else if (sz === 16) this.setReg16(i, v); else this.r[i] = v >>> 0; }

  // ---------------------------------------------------------------- flags
  szp(v, sz) { const mask = sz === 32 ? 0xffffffff : (1 << sz) - 1; v = (v & mask) >>> 0;
    let f = this.flags & ~(F_ZF | F_SF | F_PF); if (!v) f |= F_ZF; if (v & (1 << (sz - 1))) f |= F_SF; if (PARITY[v & 0xff]) f |= F_PF; this.flags = f; return v; }
  alu(op, a, b, sz) {                             // 0 add 1 or 2 adc 3 sbb 4 and 5 sub 6 xor 7 cmp
    const mask = sz === 32 ? 0xffffffff : (1 << sz) - 1, top = 2 ** sz, sign = 2 ** (sz - 1);
    let r, cf = 0, of = 0; const c = this.flags & F_CF ? 1 : 0;
    switch (op) {
      case 0: case 2: { const cin = op === 2 ? c : 0; r = a + b + cin; cf = r >= top ? 1 : 0; r %= top; of = (~(a ^ b) & (a ^ r) & sign) ? 1 : 0; break; }
      case 3: case 5: case 7: { const cin = op === 3 ? c : 0; r = a - b - cin; cf = r < 0 ? 1 : 0; r = (r + top) % top; of = ((a ^ b) & (a ^ r) & sign) ? 1 : 0; break; }
      case 1: r = (a | b) >>> 0; break;
      case 4: r = (a & b) >>> 0; break;
      case 6: r = (a ^ b) >>> 0; break;
    }
    r = (r & mask) >>> 0; this.szp(r, sz);
    this.flags = (this.flags & ~(F_CF | F_OF)) | (cf ? F_CF : 0) | (of ? F_OF : 0);
    return r;
  }
  cond(cc) {
    const f = this.flags, cf = f & F_CF, zf = f & F_ZF, sf = !!(f & F_SF), of = !!(f & F_OF), pf = f & F_PF;
    switch (cc) {
      case 0: return of; case 1: return !of; case 2: return !!cf; case 3: return !cf; case 4: return !!zf; case 5: return !zf;
      case 6: return !!(cf || zf); case 7: return !(cf || zf); case 8: return sf; case 9: return !sf; case 10: return !!pf; case 11: return !pf;
      case 12: return sf !== of; case 13: return sf === of; case 14: return !!zf || sf !== of; case 15: return !zf && sf === of;
    }
  }

  // ---------------------------------------------------------------- x87
  st(i) { return this.fpu[(this.ftop + i) & 7]; }
  setSt(i, v) { this.fpu[(this.ftop + i) & 7] = v; }
  fpush(v) { this.ftop = (this.ftop - 1) & 7; this.fpu[this.ftop] = v; }
  fpop() { const v = this.fpu[this.ftop]; this.ftop = (this.ftop + 1) & 7; return v; }
  fcmp(a, b) { let c = 0; if (Number.isNaN(a) || Number.isNaN(b)) c = 0x4500; else if (a < b) c = 0x100; else if (a === b) c = 0x4000;
    this.fsw = (this.fsw & ~0x4700) | c; }
  fcomi(a, b) { let f = this.flags & ~(F_ZF | F_PF | F_CF | F_OF | F_SF);
    if (Number.isNaN(a) || Number.isNaN(b)) f |= F_ZF | F_PF | F_CF; else if (a < b) f |= F_CF; else if (a === b) f |= F_ZF; this.flags = f; }
  rdF32(a) { f32b.setUint32(0, this.m.r32(a), true); return f32b.getFloat32(0, true); }
  rdF64(a) { f32b.setUint32(0, this.m.r32(a), true); f32b.setUint32(4, this.m.r32(a + 4), true); return f32b.getFloat64(0, true); }
  wrF32(a, v) { f32b.setFloat32(0, v, true); this.m.w32(a, f32b.getUint32(0, true)); }
  wrF64(a, v) { f32b.setFloat64(0, v, true); this.m.w32(a, f32b.getUint32(0, true)); this.m.w32(a + 4, f32b.getUint32(4, true)); }
  rdI64(a) { return this.m.r32(a) + this.m.r32(a + 4) * 4294967296 - ((this.m.r32(a + 4) & 0x80000000) ? 2 ** 64 : 0); }
  wrI64(a, v) { if (!Number.isFinite(v)) v = -(2 ** 63); const lo = Number(BigInt.asUintN(32, BigInt(Math.trunc(v)))), hi = Number(BigInt.asUintN(32, BigInt(Math.trunc(v)) >> 32n)); this.m.w32(a, lo); this.m.w32(a + 4, hi); }
  fround(v) { switch ((this.fcw >> 10) & 3) { case 0: { const r = Math.round(v); return (Math.abs(v % 1) === 0.5 && r % 2) ? r - Math.sign(v) : r; }
    case 1: return Math.floor(v); case 2: return Math.ceil(v); default: return Math.trunc(v); } }
  farith(op, a, b) { switch (op) { case 0: return a + b; case 1: return a * b; case 4: return a - b; case 5: return b - a; case 6: return a / b; case 7: return b / a; } }

  // ---------------------------------------------------------------- run
  // Call `addr` with cdecl stack args (and register values), run until it returns. Returns eax.
  call(addr, args = [], regs = {}) {
    const RET = 0xdead0000; this.fn = 0;
    for (let i = args.length - 1; i >= 0; i--) this.push(args[i] >>> 0);
    this.push(RET);
    for (const [k, v] of Object.entries(regs)) this.r[["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"].indexOf(k)] = v >>> 0;
    this.eip = addr >>> 0;
    this.runUntil(RET, this.stepLimit);
    return this.r[0];
  }
  // Thread support: a context is the whole CPU state a thread owns; runSlice runs until the thread returns to
  // stopAt ("exit"), a hook asks to yield (this.yieldNow, "yield"), or the step budget runs out ("budget").
  saveCtx() { return { r: Uint32Array.from(this.r), eip: this.eip, flags: this.flags, fpu: Float64Array.from(this.fpu), ftop: this.ftop,
    fsw: this.fsw, fcw: this.fcw, ftag: this.ftag, fsBase: this.fsBase, frames: this.frames.slice(0, this.fn), simd: this.simdSave() }; }
  loadCtx(c) { this.r.set(c.r); this.eip = c.eip; this.flags = c.flags; this.fpu.set(c.fpu); this.ftop = c.ftop; this.fsw = c.fsw;
    this.fcw = c.fcw; this.ftag = c.ftag; this.fsBase = c.fsBase; this.frames.set(c.frames); this.fn = c.frames.length; this.simdLoad(c.simd); }
  runSlice(stopAt, budget) {
    const start = this.steps; this.yieldNow = false;
    const jit = this.jit, r = this.r, m = this.m, bits = this.hookBits, W = this.wasm;
    while (this.eip !== stopAt) {
      if (jit !== undefined && !jit.verify) { const eip = this.eip;
        if (eip < HOOK_SPAN && bits[eip] === 0 && this.passThrough !== eip) {
          // WebAssembly blocks (wasm-jit.mjs), as in runUntil; the thread's exit address is outside the image
          if (W !== undefined) {
            const wi = W.map[eip];
            if (wi !== 0) {
              const rem = Math.min(start + budget + 1 - this.steps, 0x7fffffff);
              if (W.ntab[wi] <= rem) {
                const ctx = W.ctx;
                ctx[8] = this.flags; ctx[11] = this.ftop; ctx[12] = this.fsw; ctx[13] = this.fcw;
                const e = W.run(eip, rem) >>> 0;
                this.flags = ctx[8] >>> 0; this.ftop = ctx[11]; this.fsw = ctx[12]; this.fcw = ctx[13];
                this.steps += ctx[10]; this.eip = e;
                if (W.hookYield) { W.hookYield = false; this.yieldNow = false; return "yield"; }   // (after a hook run from recompiled code, as after a hook here)
                continue;
              }
            } else W.want(eip);   // (untranslated: the JavaScript block; single interpreter steps were slower for MMX loops)
          }
          const pg = jit.fns[eip >>> 12]; const f = pg === null ? undefined : pg[eip & 4095];   // not compiled yet: slow path (jit.block)
          if (typeof f === "function" && this.steps + f.n - start <= budget + 1) { this.lim = start + budget + 1; f(this, r, m); continue; } } }
      if (this.steps - start > budget) return "budget";
      const h = this.passThrough === this.eip ? (this.passThrough = null) : this.hooks.get(this.eip);
      if (h) { const ret = this.pop(); const v = h(this, ret); if (v !== undefined) this.r[0] = v >>> 0; this.eip = this.hookReturn ?? ret; this.hookReturn = null;
        if (this.yieldNow) { this.yieldNow = false; return "yield"; } continue; }
      if (this.jit) { const f = this.jit.block(this.eip); if (f && this.steps + f.n - start <= budget + 1) { this.lim = start + budget + 1; this.jit.run(f); continue; } }
      this.step();
    }
    return "exit";
  }
  runUntil(stopAt, maxSteps = this.stepLimit ?? 3_000_000) {
    const start = this.steps, jit = this.jit, r = this.r, m = this.m, bits = this.hookBits;
    const tight = jit !== undefined && !jit.verify && !SLOW_DISPATCH;
    while (this.eip !== stopAt) {
      // inner loop: compiled blocks back to back while nothing else is due (the step limit and the next tick do not
      // change while blocks run; hooks, watches and ticks are handled by the outer loop below)
      if (tight && this.watch === undefined) {
        const lim = Math.min(this.nextTick, start + maxSteps + 1), fns = jit.fns; this.lim = lim;
        let eip = this.eip;
        const W = this.wasm;
        while (eip !== stopAt && eip < HOOK_SPAN && bits[eip] === 0 && this.passThrough !== eip) {
          // WebAssembly blocks (wasm-jit.mjs, NT04_WASM=1): run there until an address without a block
          if (W !== undefined) {
            const wi = W.map[eip];
            if (wi !== 0) {
              const rem = Math.min(lim - this.steps, 0x7fffffff);
              if (W.ntab[wi] <= rem) {
                // registers and x87 registers are views of the state page (wasm-jit); EFLAGS and the x87 top /
                // status / control words are copied
                const ctx = W.ctx;
                ctx[8] = this.flags; ctx[11] = this.ftop; ctx[12] = this.fsw; ctx[13] = this.fcw;
                const e = W.run(eip, rem) >>> 0;
                this.flags = ctx[8] >>> 0; this.ftop = ctx[11]; this.fsw = ctx[12]; this.fcw = ctx[13];
                this.steps += ctx[10]; this.eip = eip = e; W.hookYield = false; continue;   // (hooks do not yield here)
              }
            } else W.want(eip);
          }
          const pg = fns[eip >>> 12]; if (pg === null) break;
          const f = pg[eip & 4095]; if (typeof f !== "function" || this.steps + f.n > lim) break;
          f(this, r, m); eip = this.eip;
        }
        if (eip === stopAt) break;
      }
      // fast path: a compiled block at an unhooked image address, with no tick due inside it
      if (jit !== undefined && !jit.verify) { const eip = this.eip;
        if (eip < HOOK_SPAN && bits[eip] === 0 && this.passThrough !== eip && this.watch === undefined) {
          const pg = jit.fns[eip >>> 12]; const f = pg === null ? undefined : pg[eip & 4095];   // not compiled yet: slow path (jit.block)
          if (typeof f === "function" && this.steps + f.n <= this.nextTick && this.steps + f.n - start <= maxSteps + 1) { this.lim = Math.min(this.nextTick, start + maxSteps + 1); f(this, r, m); continue; } } }
      if (this.steps - start > maxSteps) throw new Error(`x86: step limit at 0x${this.eip.toString(16)}; call stack ${this.callStack()}`);
      const h = this.passThrough === this.eip ? (this.passThrough = null) : this.hooks.get(this.eip);   // passThrough: run the original once
      if (h) { const ret = this.pop(); const v = h(this, ret); if (v !== undefined) this.r[0] = v >>> 0; this.eip = this.hookReturn ?? ret; this.hookReturn = null; continue; }
      if (this.watch) { const w = this.watch.get(this.eip); if (w) w(this); }   // debugging: observe without replacing
      if (this.steps >= this.nextTick) {        // periodic work while game code runs: interrupts (vertical blank) and other threads
        this.nextTick = this.steps + (this.tickInterval ?? 2_000_000);
        if (this.onTick && !this.inTick) { this.inTick = true; try { this.onTick(); } finally { this.inTick = false; } }
      }
      // compiled block (x86-jit.mjs), unless it would run past the next tick: then single steps, so ticks (thread
      // slices, vertical blanks) land on exactly the same instruction as in the interpreter
      if (this.jit) { const f = this.jit.block(this.eip); if (f && this.steps + f.n <= this.nextTick && this.steps + f.n - start <= maxSteps + 1) { this.lim = Math.min(this.nextTick, start + maxSteps + 1); this.jit.run(f); continue; } }
      this.step();
    }
  }

  step() {
    const at = this.eip; this.steps++;
    let opsz = 32, rep = 0; this.seg = 0; this.pm = null;
    let op = this.f8();
    for (;;) {
      if (op === 0x66) opsz = 16; else if (op === 0xf3) rep = 1; else if (op === 0xf2) rep = 2;
      else if (op === 0x64) this.seg = 4; else if (op === 0x2e || op === 0x3e || op === 0x26 || op === 0x36 || op === 0x65) { /* segment overrides: flat */ }
      else break;
      op = this.f8();
    }
    if (this.trace) this.log(`${at.toString(16)} op ${op.toString(16)}`);
    const sz = opsz;
    try { this.exec(op, sz, rep, at); }
    catch (e) { if (!e.x86) { e.message = `x86 at 0x${at.toString(16)} (op ${op.toString(16)}): ${e.message}; call stack ${this.callStack()}`; e.x86 = true; e.at = at; } throw e; }
  }

  exec(op, sz, rep, at) {
    const r = this.r, m = this.m;
    if (op < 0x40 && (op & 7) < 6) {                      // ALU forms
      const alu = op >> 3, form = op & 7;
      if (form === 4) { const v = this.alu(alu, this.reg8(0), this.f8(), 8); if (alu !== 7) this.setReg8(0, v); return; }
      if (form === 5) { const imm = sz === 16 ? this.f16() : this.f32(); const v = this.alu(alu, this.rdReg(0, sz), imm, sz); if (alu !== 7) this.wrReg(0, sz, v); return; }
      const s = form & 1 ? sz : 8, o = this.modrm();
      if (form < 2) { const v = this.alu(alu, this.rd(o, s), this.rdReg(o.reg, s), s); if (alu !== 7) this.wr(o, s, v); }
      else { const v = this.alu(alu, this.rdReg(o.reg, s), this.rd(o, s), s); if (alu !== 7) this.wrReg(o.reg, s, v); }
      return;
    }
    if (op >= 0x40 && op < 0x50) { const i = op & 7, cf = this.flags & F_CF, a = this.rdReg(i, sz);
      const v = this.alu(op < 0x48 ? 0 : 5, a, 1, sz); this.wrReg(i, sz, v); this.flags = (this.flags & ~F_CF) | cf; return; }
    if (op >= 0x50 && op < 0x58) { this.push(r[op & 7]); return; }
    if (op >= 0x58 && op < 0x60) { r[op & 7] = this.pop(); return; }
    if (op >= 0x70 && op < 0x80) { const d = this.s8(); if (this.cond(op & 15)) this.eip = (this.eip + d) >>> 0; return; }
    if (op >= 0x90 && op < 0x98) { if (op !== 0x90) { const i = op & 7, t = r[0]; if (sz === 16) { const a = this.reg16(0); this.setReg16(0, this.reg16(i)); this.setReg16(i, a); } else { r[0] = r[i]; r[i] = t; } } return; }
    if (op >= 0xb0 && op < 0xb8) { this.setReg8(op & 7, this.f8()); return; }
    if (op >= 0xb8 && op < 0xc0) { this.wrReg(op & 7, sz, sz === 16 ? this.f16() : this.f32()); return; }
    if (op >= 0xd8 && op <= 0xdf) { this.x87(op); return; }
    switch (op) {
      case 0x0f: return this.exec0f(this.f8(), sz, at, rep);
      case 0x60: { const t = r[4]; for (let i = 0; i < 8; i++) this.push(i === 4 ? t : r[i]); return; }
      case 0x61: { for (let i = 7; i >= 0; i--) { const v = this.pop(); if (i !== 4) r[i] = v; } return; }
      case 0x68: this.push(this.f32()); return;
      case 0x6a: this.push(this.s8()); return;
      case 0x69: case 0x6b: { const o = this.modrm(); const a = this.rd(o, sz) | 0; const b = op === 0x6b ? this.s8() : (sz === 16 ? (this.f16() << 16) >> 16 : this.f32() | 0);
        const sa = sz === 16 ? (a << 16) >> 16 : a; const full = BigInt(sa) * BigInt(b), res = Number(BigInt.asIntN(sz, full));
        this.wrReg(o.reg, sz, res); const ovf = BigInt(res) !== full; this.flags = (this.flags & ~(F_CF | F_OF)) | (ovf ? F_CF | F_OF : 0); return; }
      case 0x80: case 0x81: case 0x82: case 0x83: { const s = op & 1 ? sz : 8, o = this.modrm();
        const imm = op === 0x81 ? (sz === 16 ? this.f16() : this.f32()) : op === 0x83 ? (this.s8() >>> 0) & (s === 32 ? 0xffffffff : (1 << s) - 1) : this.f8();
        const v = this.alu(o.reg, this.rd(o, s), imm >>> 0, s); if (o.reg !== 7) this.wr(o, s, v); return; }
      case 0x84: case 0x85: { const s = op & 1 ? sz : 8, o = this.modrm(); this.alu(4, this.rd(o, s), this.rdReg(o.reg, s), s); return; }
      case 0x86: case 0x87: { const s = op & 1 ? sz : 8, o = this.modrm(); const a = this.rd(o, s), b = this.rdReg(o.reg, s); this.wr(o, s, b); this.wrReg(o.reg, s, a); return; }
      case 0x88: case 0x89: { const s = op & 1 ? sz : 8, o = this.modrm(); this.wr(o, s, this.rdReg(o.reg, s)); return; }
      case 0x8a: case 0x8b: { const s = op & 1 ? sz : 8, o = this.modrm(); this.wrReg(o.reg, s, this.rd(o, s)); return; }
      case 0x8c: { const o = this.modrm(); this.wr(o, 16, 0); return; }        // mov r/m, sreg
      case 0x8e: this.modrm(); return;                                         // mov sreg, r/m
      case 0x8d: { const o = this.modrm(); const a = this.seg === 4 ? o.addr - this.fsBase : o.addr; this.wrReg(o.reg, sz, a); return; }
      case 0x8f: { const v = this.pop(); const o = this.modrm(); this.wr(o, 32, v); return; }
      case 0x98: if (sz === 16) this.setReg16(0, (this.reg8(0) << 24) >> 24); else r[0] = (r[0] << 16) >> 16; return;
      case 0x99: if (sz === 16) this.setReg16(2, this.reg16(0) & 0x8000 ? 0xffff : 0); else r[2] = r[0] & 0x80000000 ? 0xffffffff : 0; return;
      case 0x9b: return;                                                       // fwait
      case 0x9c: this.push(this.flags); return;
      case 0x9d: this.flags = this.pop() | 2; return;
      case 0x9e: this.flags = (this.flags & ~0xd5) | (this.reg8(4) & 0xd5); return;   // sahf
      case 0x9f: this.setReg8(4, this.flags & 0xff); return;                           // lahf
      case 0xa0: this.setReg8(0, m.r8(this.f32() + (this.seg === 4 ? this.fsBase : 0))); return;
      case 0xa1: { const a = this.f32() + (this.seg === 4 ? this.fsBase : 0); this.wrReg(0, sz, sz === 16 ? m.r16(a) : m.r32(a)); return; }
      case 0xa2: m.w8(this.f32() + (this.seg === 4 ? this.fsBase : 0), this.reg8(0)); return;
      case 0xa3: { const a = this.f32() + (this.seg === 4 ? this.fsBase : 0); if (sz === 16) m.w16(a, this.reg16(0)); else m.w32(a, r[0]); return; }
      case 0xa4: case 0xa5: case 0xaa: case 0xab: case 0xac: case 0xad: case 0xa6: case 0xa7: case 0xae: case 0xaf: return this.strop(op, sz, rep);
      case 0xa8: this.alu(4, this.reg8(0), this.f8(), 8); return;
      case 0xd7: this.setReg8(0, m.r8((r[3] + this.reg8(0)) >>> 0)); return;   // xlat
      case 0xa9: this.alu(4, this.rdReg(0, sz), sz === 16 ? this.f16() : this.f32(), sz); return;
      case 0xc0: case 0xc1: case 0xd0: case 0xd1: case 0xd2: case 0xd3: {
        const s = op & 1 ? sz : 8, o = this.modrm(); const n = op < 0xd0 ? this.f8() : op < 0xd2 ? 1 : this.reg8(1);
        this.wr(o, s, this.shift(o.reg, this.rd(o, s), n & 31, s)); return; }
      case 0xc2: { const n = this.f16(); this.eip = this.pop(); r[4] += n; return; }
      case 0xc3: this.eip = this.pop(); return;
      case 0xc6: { const o = this.modrm(); this.wr(o, 8, this.f8()); return; }
      case 0xc7: { const o = this.modrm(); this.wr(o, sz, sz === 16 ? this.f16() : this.f32()); return; }
      case 0xc8: { const n = this.f16(); this.f8(); this.push(r[5]); r[5] = r[4]; r[4] -= n; return; }
      case 0xc9: r[4] = r[5]; r[5] = this.pop(); return;
      case 0xcc: throw new Error("int3 reached");
      case 0xe8: { const d = this.f32() | 0; this.push(this.eip); this.eip = (this.eip + d) >>> 0; this.noteCall(at, this.eip); return; }
      case 0xe9: { const d = this.f32() | 0; this.eip = (this.eip + d) >>> 0; return; }
      case 0xeb: { const d = this.s8(); this.eip = (this.eip + d) >>> 0; return; }
      case 0xf4: throw new Error("hlt");
      case 0xf5: this.flags ^= F_CF; return;
      case 0xf8: this.flags &= ~F_CF; return;
      case 0xf9: this.flags |= F_CF; return;
      case 0xfa: case 0xfb: return;
      case 0xfc: this.flags &= ~F_DF; return;
      case 0xfd: this.flags |= F_DF; return;
      case 0xf6: case 0xf7: return this.group3(op & 1 ? sz : 8);
      case 0xfe: case 0xff: {
        const s = op === 0xfe ? 8 : sz, o = this.modrm();
        switch (o.reg) {
          case 0: case 1: { const cf = this.flags & F_CF; this.wr(o, s, this.alu(o.reg === 0 ? 0 : 5, this.rd(o, s), 1, s)); this.flags = (this.flags & ~F_CF) | cf; return; }
          case 2: { const t = this.rd(o, 32); this.push(this.eip); this.eip = t; this.noteCall(at, t); return; }
          case 4: this.eip = this.rd(o, 32); return;
          case 6: this.push(this.rd(o, 32)); return;
        }
        break;
      }
    }
    throw new Error(`unknown opcode ${op.toString(16)}`);
  }

  shift(kind, v, n, s) {
    const mask = s === 32 ? 0xffffffff : (1 << s) - 1, top = 1 << (s - 1); if (!n) return v;
    let res, cf;
    switch (kind) {
      case 0: { n %= s; res = ((v << n) | (v >>> (s - n))) & mask; cf = res & 1; this.flags = (this.flags & ~F_CF) | (cf ? F_CF : 0); return res >>> 0; }   // rol
      case 1: { n %= s; res = ((v >>> n) | (v << (s - n))) & mask; cf = res & top; this.flags = (this.flags & ~F_CF) | (cf ? F_CF : 0); return res >>> 0; }   // ror
      case 4: case 6: cf = n <= s ? (v >>> (s - n)) & 1 : 0; res = n >= 32 ? 0 : (v << n) & mask; break;                // shl
      case 5: cf = (v >>> (n - 1)) & 1; res = n >= 32 ? 0 : (v >>> n) & mask; break;                                     // shr
      case 7: { const sv = s === 32 ? v | 0 : (v << (32 - s)) >> (32 - s); cf = (sv >> Math.min(n - 1, 31)) & 1; res = (sv >> Math.min(n, 31)) & mask; break; } // sar
      case 2: case 3: {                                                       // rcl / rcr (rare)
        let c = this.flags & F_CF ? 1 : 0; res = v;
        for (let i = 0; i < n; i++) { if (kind === 2) { const nc = (res & top) ? 1 : 0; res = ((res << 1) | c) & mask; c = nc; } else { const nc = res & 1; res = (res >>> 1) | (c ? top : 0); c = nc; } }
        this.flags = (this.flags & ~F_CF) | (c ? F_CF : 0); return res >>> 0; }
    }
    res >>>= 0; this.szp(res, s); this.flags = (this.flags & ~(F_CF | F_OF)) | (cf ? F_CF : 0);
    if (n === 1 && kind === 4 && (((res & top) !== 0) !== !!cf)) this.flags |= F_OF;
    if (n === 1 && kind === 5 && (v & top)) this.flags |= F_OF;
    return res;
  }

  group3(s) {
    const o = this.modrm(), r = this.r, mask = s === 32 ? 0xffffffff : (1 << s) - 1;
    switch (o.reg) {
      case 0: case 1: this.alu(4, this.rd(o, s), s === 8 ? this.f8() : s === 16 ? this.f16() : this.f32(), s); return;
      case 2: this.wr(o, s, ~this.rd(o, s) & mask); return;
      case 3: { const v = this.rd(o, s); const res = this.alu(5, 0, v, s); this.wr(o, s, res); this.flags = (this.flags & ~F_CF) | (v ? F_CF : 0); return; }
      case 4: case 5: {                                                       // mul / imul
        const v = this.rd(o, s); const signed = o.reg === 5;
        const sx = x => s === 32 ? x | 0 : (x << (32 - s)) >> (32 - s);
        const a = s === 8 ? this.reg8(0) : s === 16 ? this.reg16(0) : r[0];
        const p = signed ? BigInt(sx(a)) * BigInt(sx(v)) : BigInt(a >>> 0) * BigInt(v >>> 0);
        const lo = Number(BigInt.asUintN(s, p)), hi = Number(BigInt.asUintN(s, p >> BigInt(s)));
        if (s === 8) this.setReg16(0, (hi << 8) | lo); else if (s === 16) { this.setReg16(0, lo); this.setReg16(2, hi); } else { r[0] = lo; r[2] = hi; }
        const ovf = signed ? BigInt.asIntN(s, p) !== p : hi !== 0; this.flags = (this.flags & ~(F_CF | F_OF)) | (ovf ? F_CF | F_OF : 0); return; }
      case 6: case 7: {                                                       // div / idiv
        const v = this.rd(o, s), signed = o.reg === 7;
        if (s === 32) {
          const num = (BigInt(r[2]) << 32n) | BigInt(r[0]);
          const n = signed ? BigInt.asIntN(64, num) : num, d = signed ? BigInt(v | 0) : BigInt(v >>> 0);
          if (d === 0n) throw new Error("divide by zero");
          r[0] = Number(BigInt.asUintN(32, n / d)); r[2] = Number(BigInt.asUintN(32, n % d)); return;
        }
        const num = s === 16 ? (this.reg16(2) << 16) | this.reg16(0) : this.reg16(0);
        const sx = (x, b) => (x << (32 - b)) >> (32 - b);
        const n = signed ? sx(num, s * 2) : num >>> 0, d = signed ? sx(v, s) : v;
        if (!d) throw new Error("divide by zero");
        const q = Math.trunc(n / d), rem = n - q * d;
        if (s === 16) { this.setReg16(0, q); this.setReg16(2, rem); } else { this.setReg8(0, q); this.setReg8(4, rem); }
        return; }
    }
  }

  strop(op, sz, rep) {
    const r = this.r, m = this.m, s = op & 1 ? sz : 8, n = s >> 3, d = this.flags & F_DF ? -n : n;
    const rdS = a => s === 8 ? m.r8(a) : s === 16 ? m.r16(a) : m.r32(a), wrS = (a, v) => s === 8 ? m.w8(a, v) : s === 16 ? m.w16(a, v) : m.w32(a, v);
    const one = () => {
      switch (op & 0xfe) {
        case 0xa4: wrS(r[7], rdS(r[6])); r[6] += d; r[7] += d; return true;
        case 0xaa: wrS(r[7], this.rdReg(0, s)); r[7] += d; return true;
        case 0xac: this.wrReg(0, s, rdS(r[6])); r[6] += d; return true;
        case 0xa6: { this.alu(7, rdS(r[6]), rdS(r[7]), s); r[6] += d; r[7] += d; return null; }
        case 0xae: { this.alu(7, this.rdReg(0, s), rdS(r[7]), s); r[7] += d; return null; }
      }
    };
    if (!rep) { one(); return; }
    while (r[1]) {
      const res = one(); r[1]--;
      if (res === null) { const zf = !!(this.flags & F_ZF); if ((rep === 1 && !zf) || (rep === 2 && zf)) break; }
    }
  }

  exec0f(op, sz, at, rep = 0) {
    const r = this.r;
    if (op >= 0x80 && op < 0x90) { const d = this.f32() | 0; if (this.cond(op & 15)) this.eip = (this.eip + d) >>> 0; return; }
    if (op >= 0x90 && op < 0xa0) { const o = this.modrm(); this.wr(o, 8, this.cond(op & 15) ? 1 : 0); return; }
    if (op >= 0x40 && op < 0x50) { const o = this.modrm(); const v = this.rd(o, sz); if (this.cond(op & 15)) this.wrReg(o.reg, sz, v); return; }
    if (op >= 0xc8 && op < 0xd0) { const v = r[op & 7]; r[op & 7] = (((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | (v >>> 24)) >>> 0; return; }
    switch (op) {
      case 0xb6: case 0xb7: { const o = this.modrm(); this.wrReg(o.reg, sz, this.rd(o, op === 0xb6 ? 8 : 16)); return; }
      case 0xbe: case 0xbf: { const o = this.modrm(); const v = this.rd(o, op === 0xbe ? 8 : 16); this.wrReg(o.reg, sz, op === 0xbe ? (v << 24) >> 24 : (v << 16) >> 16); return; }
      case 0xaf: { const o = this.modrm(); const a = this.rdReg(o.reg, sz) | 0, b = this.rd(o, sz) | 0;
        const p = BigInt(sz === 16 ? (a << 16) >> 16 : a) * BigInt(sz === 16 ? (b << 16) >> 16 : b), res = Number(BigInt.asIntN(sz, p));
        this.wrReg(o.reg, sz, res); const ovf = BigInt(res) !== p; this.flags = (this.flags & ~(F_CF | F_OF)) | (ovf ? F_CF | F_OF : 0); return; }
      case 0xa3: case 0xab: case 0xb3: case 0xbb: case 0xba: {               // bt bts btr btc
        const o = this.modrm(); let bit, kind;
        if (op === 0xba) { kind = o.reg - 4; bit = this.f8(); } else { kind = { 0xa3: 0, 0xab: 1, 0xb3: 2, 0xbb: 3 }[op]; bit = this.rdReg(o.reg, sz); }
        let addr = o.addr, v;
        if (addr !== undefined && op !== 0xba) { addr = (addr + ((bit | 0) >> 3)) >>> 0; bit &= 7; v = this.m.r8(addr); }
        else { bit &= sz - 1; v = this.rd(o, sz); }
        const cf = (v >>> bit) & 1; this.flags = (this.flags & ~F_CF) | (cf ? F_CF : 0);
        if (kind) { const nv = kind === 1 ? v | (1 << bit) : kind === 2 ? v & ~(1 << bit) : v ^ (1 << bit);
          if (addr !== undefined && op !== 0xba) this.m.w8(addr, nv); else this.wr(o, sz, nv >>> 0); }
        return; }
      case 0xa4: case 0xa5: case 0xac: case 0xad: {                          // shld / shrd
        const o = this.modrm(); const n = (op & 1 ? this.reg8(1) : this.f8()) & 31; if (!n) return;
        const a = this.rd(o, sz), b = this.rdReg(o.reg, sz);
        const res = op < 0xac ? ((a << n) | (b >>> (sz - n))) >>> 0 : ((a >>> n) | (b << (sz - n))) >>> 0;
        const cf = op < 0xac ? (a >>> (sz - n)) & 1 : (a >>> (n - 1)) & 1;
        this.wr(o, sz, res); this.szp(res, sz); this.flags = (this.flags & ~F_CF) | (cf ? F_CF : 0); return; }
      case 0xa2: r[0] = 0; r[1] = 0; r[2] = 0; r[3] = 0; return;              // cpuid
      case 0x31: r[0] = this.steps >>> 0; r[2] = 0; return;                   // rdtsc
      case 0xbc: case 0xbd: { const o = this.modrm(); const v = this.rd(o, sz); if (!v) { this.flags |= F_ZF; return; }
        this.flags &= ~F_ZF; this.wrReg(o.reg, sz, op === 0xbc ? 31 - Math.clz32(v & -v) : 31 - Math.clz32(v)); return; }
      case 0xc0: case 0xc1: { const s = op & 1 ? sz : 8, o = this.modrm(); const a = this.rd(o, s), b = this.rdReg(o.reg, s);
        this.wrReg(o.reg, s, a); this.wr(o, s, this.alu(0, a, b, s)); return; }
      case 0xb1: { const o = this.modrm(); const a = this.rd(o, sz); this.alu(7, this.rdReg(0, sz), a, sz);
        if (this.flags & F_ZF) this.wr(o, sz, this.rdReg(o.reg, sz)); else this.wrReg(0, sz, a); return; }
      case 0x18: case 0x1f: this.modrm(); return;                            // prefetch / nop r/m
      case 0x08: case 0x09: return;                                          // invd / wbinvd (cache flush before GPU use)
    }
    if (this.execSimd(op, sz, rep)) return;
    throw new Error(`unknown opcode 0f ${op.toString(16)}`);
  }

  x87(op) {
    const b = this.m.r8(this.eip);
    const o = this.modrm(), reg = o.reg;
    if (o.addr !== undefined) {
      const a = o.addr;
      switch (op) {
        case 0xd8: case 0xdc: { const v = op === 0xd8 ? this.rdF32(a) : this.rdF64(a);
          if (reg === 2 || reg === 3) { this.fcmp(this.st(0), v); if (reg === 3) this.fpop(); return; }
          this.setSt(0, this.farith(reg, this.st(0), v)); return; }
        case 0xda: case 0xde: { const v = op === 0xda ? this.m.r32(a) | 0 : (this.m.r16(a) << 16) >> 16;
          if (reg === 2 || reg === 3) { this.fcmp(this.st(0), v); if (reg === 3) this.fpop(); return; }
          this.setSt(0, this.farith(reg, this.st(0), v)); return; }
        case 0xd9:
          switch (reg) {
            case 0: this.fpush(this.rdF32(a)); return;
            case 2: this.wrF32(a, this.st(0)); return;
            case 3: this.wrF32(a, this.fpop()); return;
            case 4: return;                                                   // fldenv
            case 5: this.fcw = this.m.r16(a); return;
            case 6: return;                                                   // fnstenv
            case 7: this.m.w16(a, this.fcw); return;
          }
          break;
        case 0xdb:
          switch (reg) {
            case 0: this.fpush(this.m.r32(a) | 0); return;
            case 1: case 2: case 3: { const v = reg === 1 ? Math.trunc(this.st(0)) : this.fround(this.st(0)); this.m.w32(a, (v >= 2147483648 || v < -2147483648 || Number.isNaN(v)) ? 0x80000000 : v | 0); if (reg !== 2) this.fpop(); return; }
            case 5: { const lo = this.m.r32(a), hi = this.m.r32(a + 4), ex = this.m.r16(a + 8);   // fld m80
              const sign = ex & 0x8000 ? -1 : 1, e = ex & 0x7fff; this.fpush(e === 0 && !lo && !hi ? 0 : sign * (hi * 4294967296 + lo) * 2 ** (e - 16383 - 63)); return; }
            case 7: { const v = this.fpop(); this.wrF64(a, v); this.m.w16(a + 8, 0); return; }   // fstp m80 (approximate)
          }
          break;
        case 0xdd:
          switch (reg) {
            case 0: this.fpush(this.rdF64(a)); return;
            case 1: this.wrI64(a, Math.trunc(this.fpop())); return;
            case 2: this.wrF64(a, this.st(0)); return;
            case 3: this.wrF64(a, this.fpop()); return;
            case 4: case 6: return;                                           // frstor / fnsave
            case 7: this.m.w16(a, this.fsw | (this.ftop << 11)); return;
          }
          break;
        case 0xdf:
          switch (reg) {
            case 0: this.fpush((this.m.r16(a) << 16) >> 16); return;
            case 1: case 2: case 3: { const v = reg === 1 ? Math.trunc(this.st(0)) : this.fround(this.st(0)); this.m.w16(a, v); if (reg !== 2) this.fpop(); return; }
            case 5: this.fpush(this.rdI64(a)); return;
            case 7: this.wrI64(a, this.fround(this.fpop())); return;
          }
          break;
      }
      throw new Error(`x87 ${op.toString(16)} /${reg} mem`);
    }
    const i = o.rm;
    switch (op) {
      case 0xd8: if (reg === 2 || reg === 3) { this.fcmp(this.st(0), this.st(i)); if (reg === 3) this.fpop(); return; }
                 this.setSt(0, this.farith(reg, this.st(0), this.st(i))); return;
      case 0xdc: if (reg >= 4) { this.setSt(i, this.farith(reg ^ 1, this.st(i), this.st(0))); return; }
                 if (reg < 2) { this.setSt(i, this.farith(reg, this.st(i), this.st(0))); return; } break;
      case 0xde: if (reg === 3 && i === 1) { this.fcmp(this.st(0), this.st(1)); this.fpop(); this.fpop(); return; }
                 { const v = reg >= 4 ? this.farith(reg ^ 1, this.st(i), this.st(0)) : this.farith(reg, this.st(i), this.st(0)); this.setSt(i, v); this.fpop(); return; }
      case 0xda: if (reg === 5 && i === 1) { this.fcmp(this.st(0), this.st(1)); this.fpop(); this.fpop(); return; } break;   // fucompp
      case 0xdd: switch (reg) { case 0: return; case 2: this.setSt(i, this.st(0)); return; case 3: this.setSt(i, this.st(0)); this.fpop(); return;
                   case 4: case 5: this.fcmp(this.st(0), this.st(i)); if (reg === 5) this.fpop(); return; } break;
      case 0xdb: if (reg === 4) { if (i === 2) { this.fsw &= 0x7f00; } return; }    // fnclex / fninit
                 if (reg === 5 || reg === 6) { this.fcomi(this.st(0), this.st(i)); return; } break;
      case 0xdf: if (reg === 4 && i === 0) { this.setReg16(0, this.fsw | (this.ftop << 11)); return; }
                 if (reg === 5 || reg === 6) { this.fcomi(this.st(0), this.st(i)); this.fpop(); return; } break;
      case 0xd9:
        switch (reg) {
          case 0: this.fpush(this.st(i)); return;
          case 1: { const t = this.st(0); this.setSt(0, this.st(i)); this.setSt(i, t); return; }
          case 2: return;                                                    // fnop
          case 4: switch (i) { case 0: this.setSt(0, -this.st(0)); return; case 1: this.setSt(0, Math.abs(this.st(0))); return;
                    case 4: this.fcmp(this.st(0), 0); return; case 5: { const v = this.st(0); this.fsw = (this.fsw & ~0x4700) | (Number.isNaN(v) ? 0x100 : v === 0 ? 0x4000 : !Number.isFinite(v) ? 0x500 : 0x400) | (v < 0 || Object.is(v, -0) ? 0x200 : 0); return; } } break;
          case 5: this.fpush([1, Math.log2(10), Math.LOG2E, Math.PI, Math.log10(2), Math.LN2, 0][i]); return;
          case 6: switch (i) { case 0: this.setSt(0, 2 ** this.st(0) - 1); return; case 1: this.setSt(1, this.st(1) * Math.log2(this.st(0))); this.fpop(); return;
                    case 2: this.setSt(0, Math.tan(this.st(0))); this.fpush(1); return; case 3: this.setSt(1, Math.atan2(this.st(1), this.st(0))); this.fpop(); return;
                    case 4: { const v = this.st(0), e = v === 0 ? 0 : Math.floor(Math.log2(Math.abs(v))); this.setSt(0, e); this.fpush(v / 2 ** e); return; }
                    case 5: case 0: break; case 6: this.ftop = (this.ftop - 1) & 7; return; case 7: this.ftop = (this.ftop + 1) & 7; return; } break;
          case 7: switch (i) { case 0: this.setSt(0, this.st(0) % this.st(1)); this.fsw &= ~0x400; return; case 2: this.setSt(0, Math.sqrt(this.st(0))); return;
                    case 3: { const v = this.st(0); this.setSt(0, Math.sin(v)); this.fpush(Math.cos(v)); return; } case 4: this.setSt(0, this.fround(this.st(0))); return;
                    case 5: this.setSt(0, this.st(0) * 2 ** Math.trunc(this.st(1))); return; case 6: this.setSt(0, Math.sin(this.st(0))); return; case 7: this.setSt(0, Math.cos(this.st(0))); return;
                    case 1: this.setSt(1, this.st(1) * Math.log2(this.st(0) + 1)); this.fpop(); return; } break;
        }
        break;
    }
    throw new Error(`x87 ${op.toString(16)} ${b.toString(16)}`);
  }
}

installSimd(X86);
