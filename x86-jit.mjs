import { readFileSync } from "node:fs";
// x86-jit.mjs — a block compiler for x86emu.mjs: straight-line runs of the game's x86 code are translated once
// into JavaScript functions, which V8 then compiles to machine code. Run time per guest instruction drops by
// skipping decode (prefixes, ModRM, operand dispatch) and by not computing flags that are overwritten before use.
//
// A block starts at an address the dispatcher reaches and runs until the first control transfer (jmp, jcc, call,
// ret, indirect jumps) or MAX_INSNS instructions, and never runs into an address that has a hook. Instructions the
// compiler does not translate are executed in place by the interpreter (c.eip = at; c.step()), so coverage grows
// one instruction family at a time and everything always runs. Control transfers are translated (they end the
// block); unknown ones end the block before them and the interpreter runs them.
//
// Flags: a backward pass marks, per instruction, whether its flags can be read before being overwritten (within
// the block; everything is assumed live at the block's end and before an interpreted instruction). Only those
// instructions compute flags, with the same results as the interpreter (CF ZF SF OF PF; AF is not modelled).
//
// Interface: new Jit(cpu); jit.block(eip) -> compiled function or null (not compilable: run one interpreted
// step). Each function updates c.eip and c.steps. jit.flush() drops compiled code (after code is modified).
// verify mode (jit.verify = true) runs every block twice — interpreter, undo, compiled — and reports differences.

const MAX_INSNS = +(process.env.NT04_JIT_MAX ?? 64);
const LOW_SIZE = 0x10000000;
// what generated code depends on besides the game bytes (x86-jit-cache.mjs key): this file and the options
export const JIT_ID = () => readFileSync(new URL(import.meta.url), "utf8") + JSON.stringify({ MAX_INSNS, NOLOOP, DEBUG, CALLSTACK });                     // uis-vm.mjs Memory low window
const NOLOOP = !!process.env.NT04_JIT_NOLOOP, DEBUG = !!process.env.NT04_JIT_DEBUG;
// compiled calls record the shadow call stack (x86emu noteCall) only on request: it is for error reports, which
// otherwise rebuild the stack by scanning it for return addresses (x86emu callStack)
const CALLSTACK = !!process.env.NT04_JIT_CALLSTACK, NOTE = (at, tgt) => CALLSTACK ? ` c.noteCall(${at}, ${tgt}, r[4]);` : "";   // DEBUG: guest addresses as comments in block source
const THRESHOLD = Math.max(1, +(process.env.NT04_JIT_THRESHOLD ?? 2));   // visits before a block is compiled
const F_CF = 1, F_PF = 4, F_ZF = 0x40, F_SF = 0x80, F_OF = 0x800;
const F32 = new Float32Array(1), U32 = new Uint32Array(F32.buffer), F64 = new Float64Array(1), U64 = new Uint32Array(F64.buffer);
export const PARITY = new Uint8Array(256).map((_, i) => { let p = 1; for (let b = i; b; b >>= 1) p ^= b & 1; return p; });

// ---------------------------------------------------------------- flag helpers (match x86emu.mjs alu/szp)
const MASK = [], SIGN = []; MASK[8] = 0xff; MASK[16] = 0xffff; MASK[32] = 0xffffffff; SIGN[8] = 0x80; SIGN[16] = 0x8000; SIGN[32] = 0x80000000;
function szp(fl, r, sz) { fl &= ~(F_ZF | F_SF | F_PF); if (!r) fl |= F_ZF; if (r & SIGN[sz]) fl |= F_SF; if (PARITY[r & 0xff]) fl |= F_PF; return fl; }
export const FL = {          // each takes the current EFLAGS value and returns the new one
  add(f, a, b, r, sz) { const m = MASK[sz]; a &= m; b &= m; r &= m; f = szp(f, r >>> 0, sz) & ~(F_CF | F_OF);
    if ((sz === 32 ? (a >>> 0) + (b >>> 0) : a + b) > m) f |= F_CF; if (~(a ^ b) & (a ^ r) & SIGN[sz]) f |= F_OF; return f; },
  adc(f, a, b, cin, r, sz) { const m = MASK[sz]; a &= m; b &= m; r &= m; f = szp(f, r >>> 0, sz) & ~(F_CF | F_OF);
    if ((sz === 32 ? (a >>> 0) + (b >>> 0) + cin : a + b + cin) > m) f |= F_CF; if (~(a ^ b) & (a ^ r) & SIGN[sz]) f |= F_OF; return f; },
  sub(f, a, b, r, sz) { const m = MASK[sz]; a = (a & m) >>> 0; b = (b & m) >>> 0; r &= m; f = szp(f, r >>> 0, sz) & ~(F_CF | F_OF);
    if (a < b) f |= F_CF; if ((a ^ b) & (a ^ r) & SIGN[sz]) f |= F_OF; return f; },
  sbb(f, a, b, cin, r, sz) { const m = MASK[sz]; a = (a & m) >>> 0; b = (b & m) >>> 0; r &= m; f = szp(f, r >>> 0, sz) & ~(F_CF | F_OF);
    if (a - b - cin < 0) f |= F_CF; if ((a ^ b) & (a ^ r) & SIGN[sz]) f |= F_OF; return f; },
  // shl / shr / sar of a 32-bit value by a constant 1..31 (x86emu.mjs shift(): CF = last bit out, OF only for a
  // count of 1 on shl/shr, cleared otherwise)
  sh(f, kind, v, res, n) { f = szp(f, res, 32) & ~(F_CF | F_OF);
    const cf = kind === 4 || kind === 6 ? (v >>> (32 - n)) & 1 : kind === 5 ? (v >>> (n - 1)) & 1 : ((v | 0) >> (n - 1)) & 1; if (cf) f |= F_CF;
    if (n === 1 && ((kind === 4 && ((res & 0x80000000) !== 0) !== !!cf) || (kind === 5 && (v & 0x80000000)))) f |= F_OF; return f; },
  logic(f, r, sz) { return szp(f, (r & MASK[sz]) >>> 0, sz) & ~(F_CF | F_OF); },
  incdec(f, a, r, sz, dec) { const m = MASK[sz], cf = f & F_CF; a &= m; r &= m; f = szp(f, r >>> 0, sz) & ~(F_CF | F_OF);
    if (dec ? ((a ^ 1) & (a ^ r) & SIGN[sz]) : (~(a ^ 1) & (a ^ r) & SIGN[sz])) f |= F_OF; return f | cf; },
};

// ---------------------------------------------------------------- code generation helpers
const R8 = i => i < 4 ? `(r[${i}] & 0xff)` : `((r[${i - 4}] >>> 8) & 0xff)`;
const W8 = (i, v) => i < 4 ? `r[${i}] = (r[${i}] & 0xffffff00) | ((${v}) & 0xff);` : `r[${i - 4}] = (r[${i - 4}] & 0xffff00ff) | (((${v}) & 0xff) << 8);`;
const RR = (i, sz) => sz === 32 ? `r[${i}]` : sz === 16 ? `(r[${i}] & 0xffff)` : R8(i);
const WR = (i, sz, v) => sz === 32 ? `r[${i}] = ${v};` : sz === 16 ? `r[${i}] = (r[${i}] & 0xffff0000) | ((${v}) & 0xffff);` : W8(i, v);
const RM = (a, sz) => sz === 32 ? `m.r32(${a})` : sz === 16 ? `m.r16(${a})` : `m.r8(${a})`;
const WM = (a, sz, v) => sz === 32 ? `m.w32(${a}, ${v});` : sz === 16 ? `m.w16(${a}, ${v});` : `m.w8(${a}, ${v});`;
const COND = [
  "(F & 0x800)", "!(F & 0x800)", "(F & 1)", "!(F & 1)", "(F & 0x40)", "!(F & 0x40)",
  "(F & 0x41)", "!(F & 0x41)", "(F & 0x80)", "!(F & 0x80)", "(F & 4)", "!(F & 4)",
  "(!(F & 0x80) !== !(F & 0x800))", "(!(F & 0x80) === !(F & 0x800))",
  "((F & 0x40) || !(F & 0x80) !== !(F & 0x800))", "(!(F & 0x40) && !(F & 0x80) === !(F & 0x800))",
];

export class Jit {
  constructor(cpu) {
    this.c = cpu; this.m = cpu.m; this.fns = new Array(1024).fill(null); this.stats = { blocks: 0, compiled: 0, interpreted: 0, fallbackOps: {} };
    this.verify = false; this.mismatches = 0;
    this.xu = new Uint32Array(cpu.xmmBuf); this.xf = new Float32Array(cpu.xmmBuf); this.mu = new Uint32Array(cpu.mmBuf);   // XMM registers as lanes
  }
  flush() { if (!this.dirty) return; this.dirty = false; this.fns = new Array(1024).fill(null); }
  // fns: two-level table over the image range (4 KB pages of block slots; a flat 4M-entry array would be a slow
  // dictionary in V8). Slot values: undefined = never reached, 1..THRESHOLD-1 = visits so far (interpreted), 0 = not compilable, else
  // the block function.
  page(eip) { const t = this.fns, k = eip >>> 12; return t[k] ?? (t[k] = new Array(4096).fill(undefined)); }
  // run one compiled block; in verify mode first run the same instructions in the interpreter, undo them, run the
  // block and compare registers, flags, FPU/SIMD state and every memory write
  run(f) {
    const c = this.c;
    if (!this.verify) { f(c, c.r, c.m); return; }
    // verify: run the compiled block (journaling memory writes), undo it, run the interpreter for the same number
    // of instructions, and compare registers, flags, FPU and memory
    const m = c.m, before = c.saveCtx(), steps = c.steps, R = ["r8", "r16", "r32"], W = ["w8", "w16", "w32"], orig = W.map(k => m[k]);
    const journaled = journal => W.forEach((k, j) => { m[k] = (a, v) => { journal.push([a >>> 0, j, m[R[j]](a)]); return orig[j].call(m, a, v); }; });
    const restore = () => W.forEach((k, j) => { m[k] = orig[j]; });
    const jj = []; journaled(jj); let count = 0, jitErr = null;
    try { count = f(c, c.r, c.m); } catch (e) { jitErr = e; count = c.steps - steps; }
    restore();
    const jit = c.saveCtx(), jitStepsDone = c.steps, jitVals = new Map(jj.map(([a, j]) => [`${a}:${j}`, m[R[j]](a)]));
    for (let k = jj.length - 1; k >= 0; k--) { const [a, j, old] = jj[k]; orig[j].call(m, a, old); }
    c.loadCtx(before); c.steps = steps;
    const ij = []; journaled(ij); let refErr = null;
    try { for (let k = 0; k < count; k++) c.step(); } catch (e) { refErr = e; }
    restore();
    const diffs = [];
    if (!jitErr && jitStepsDone - steps !== count) diffs.push(`steps: compiled code counted ${jitStepsDone - steps}, returned ${count}`);
    if (!!refErr === !!jitErr && c.steps !== jitStepsDone) diffs.push(`steps ${c.steps - steps} vs ${jitStepsDone - steps}`);
    if (!!refErr !== !!jitErr) diffs.push(`error: interpreter ${refErr?.message?.slice(0, 80)} / compiled ${jitErr?.message?.slice(0, 80)}`);
    if (!refErr && !jitErr) {
      for (let k = 0; k < 8; k++) if (jit.r[k] !== c.r[k]) diffs.push(`r${k} ${c.r[k].toString(16)} vs ${jit.r[k].toString(16)}`);
      if (jit.eip !== c.eip) diffs.push(`eip ${c.eip.toString(16)} vs ${jit.eip.toString(16)}`);
      if ((jit.flags & 0x8c5) !== (c.flags & 0x8c5)) diffs.push(`flags ${c.flags.toString(16)} vs ${jit.flags.toString(16)}`);
      if (jit.ftop !== c.ftop || jit.fpu.some((v, k) => !Object.is(v, c.fpu[k]) && !(Number.isNaN(v) && Number.isNaN(c.fpu[k])))) diffs.push("fpu");
      if (new Uint8Array(jit.simd.xmm).some((v, k) => v !== new Uint8Array(c.xmmBuf)[k])) diffs.push("xmm");
      const seen = new Set();
      for (const [a, j, old] of ij) { const key = `${a}:${j}`; if (seen.has(key)) continue; seen.add(key);
        const want = m[R[j]](a), got = jitVals.has(key) ? jitVals.get(key) : old; if (want !== got) diffs.push(`mem ${a.toString(16)} ${want.toString(16)} vs ${got.toString(16)}`); }
      for (const [key, v] of jitVals) if (!seen.has(key)) { const [a, j] = key.split(":").map(Number); if (m[R[j]](a) !== v) diffs.push(`mem ${a.toString(16)} written only by compiled code`); }
    }
    if (diffs.length) { this.mismatches++; if (this.mismatches <= 20) this.c.log(`jit verify: block ${f.start.toString(16)} (${count} insns): ${diffs.slice(0, 6).join("; ")}\n${f.src}`); }
    if (refErr) throw refErr;
  }
  // the dispatcher's lookup: compiled block at eip, or null (run one interpreted step). Code runs interpreted
  // until its THRESHOLD-th visit: half the blocks a race load reaches run only a few times, and compiling them
  // (decode, new Function, V8's own compile) cost more than interpreting them.
  block(eip) {
    if (this.off) return null;          // static mode (gamecode): no block compiling; the interpreter runs what recomp.wasm does not cover
    const pg = this.fns[eip >>> 12] ?? this.page(eip), o = eip & 4095; let f = pg[o];
    if (typeof f === "function") return f;
    if (f === 0) return null;
    const n = (f ?? 0) + 1;
    if (n < THRESHOLD) { pg[o] = n; return null; }
    f = this.compile(eip); pg[o] = f ?? 0; return f;
  }

  // ---------------------------------------------------------------- decoding (compile time)
  compile(start) {
    if (this.cache && !this.verify) { const f = this.cache.get(start, this); if (f) { this.stats.cached = (this.stats.cached ?? 0) + 1; this.dirty = true; return f; } }
    const m = this.m, hooks = this.c.hooks;
    let pc = start;
    const b8 = () => m.r8(pc++), b16 = () => { const v = m.r16(pc); pc += 2; return v; }, b32 = () => { const v = m.r32(pc); pc += 4; return v; };
    const s8 = () => (b8() << 24) >> 24;
    const insns = [], visited = new Set();
    let inl = [], ctxStack = [];
    let ctx = 0, nextCtx = 1;                                     // inline context (which inlined call an instruction runs in)
    let seg = 0;
    // ModRM at compile time: { reg, rm, mem: address expression | null }
    const modrm = () => {
      const b = b8(), mod = b >> 6, reg = (b >> 3) & 7, rm = b & 7;
      if (mod === 3) return { reg, rm, mod, mem: null };
      const parts = []; let disp = 0;
      if (rm === 4) {
        const sib = b8(), sc = sib >> 6, idx = (sib >> 3) & 7, base = sib & 7;
        if (idx !== 4) parts.push(sc ? `(r[${idx}] << ${sc})` : `r[${idx}]`);
        if (base === 5 && mod === 0) disp += b32() | 0; else parts.push(`r[${base}]`);
      } else if (rm === 5 && mod === 0) disp += b32() | 0;
      else parts.push(`r[${rm}]`);
      if (mod === 1) disp += s8(); else if (mod === 2) disp += b32() | 0;
      if (disp) parts.push(String(disp));
      if (seg === 4) parts.push("c.fsBase");
      return { reg, rm, mod, mem: `((${parts.join(" + ") || "0"}) >>> 0)` };
    };
    const rd = (o, sz) => o.mem ? RM(o.mem, sz) : RR(o.rm, sz);
    const wr = (o, sz, v) => o.mem ? WM(o.mem, sz, v) : WR(o.rm, sz, v);
    // A block is a region: segments of straight-line code. The first starts at `start`; taken conditional branches
    // queue their targets, which become further segments (same inline context), so if/else arms and loop bodies
    // compile into the same function and branches between them stay inside it.
    const queue = [{ pc: start, inl: [], ctxStack: [], ctx: 0 }];
    while (queue.length && insns.length < MAX_INSNS) {
      const q = queue.shift();
      if (insns.length && (visited.has(q.pc) || hooks.has(q.pc))) continue;
      pc = q.pc; inl = q.inl.slice(); ctxStack = q.ctxStack.slice(); ctx = q.ctx;
      const segStart = insns.length;
      for (let n = 0; insns.length < MAX_INSNS; n++) {
        if (n > 0 && hooks.has(pc)) break;                      // never run into a hooked address
        if (n > 0 && visited.has(pc)) break;                    // ran into code already in the block: continue there
        const at = pc; seg = 0;
        let opsz = 32, rep = 0, op = b8();
        for (;;) { if (op === 0x66) opsz = 16; else if (op === 0xf3) rep = 1; else if (op === 0xf2) rep = 2; else if (op === 0x64) seg = 4;
          else if (op === 0x2e || op === 0x3e || op === 0x26 || op === 0x36 || op === 0x65) {} else break; op = b8(); }
        const sz = opsz;
        let ins;
        try { ins = this.translate(op, sz, rep, at, { b8, b16, b32, s8, modrm, rd, wr, get pc() { return pc; }, seg }); }
        catch (e) { ins = null; }
        if (ins === null) {                                       // not translated: interpret it in place
          pc = at; const len = this.length(at); if (len === null) break;
          const k = this.opKey(at); this.stats.fallbackOps[k] = (this.stats.fallbackOps[k] ?? 0) + 1;
          insns.push({ at, code: `c.steps += @I - $k; c.eip = ${at}; c.step(); c.steps -= @I1 - $k;`, readsF: true, writesF: true, fallback: true, ctx }); pc = at + len;   // c.steps exact during the step (rdtsc)
          continue;
        }
        if (ins === "stop") { pc = at; break; }                   // control transfer we do not translate
        if (ins.pre) { const len = this.length(at); if (len === null) { pc = at; break; } pc = at + len;
          const k = this.opKey(at); this.stats.preOps ??= {}; this.stats.preOps[k] = (this.stats.preOps[k] ?? 0) + 1; }
        ins.at = at; ins.next = pc; ins.ctx = ctx; insns.push(ins); visited.add(at);
        const room = insns.length < MAX_INSNS;
        // conditional branches: side exit (or a jump to the target's segment) and the segment goes on with the
        // fall-through path; unconditional jumps are followed (once per address)
        if (ins.jcc && room && !hooks.has(ins.fall)) { ins.side = true; ins.end = false;
          if (!hooks.has(ins.tgt) && !visited.has(ins.tgt)) queue.push({ pc: ins.tgt, inl: inl.slice(), ctxStack: ctxStack.slice(), ctx }); }
        if (ins.jmp && room && !hooks.has(ins.tgt) && !visited.has(ins.tgt)) { ins.end = false; ins.code = ""; pc = ins.tgt; }
        // direct calls are followed into the callee (up to 3 deep); its ret checks that it returns to the expected
        // address (else the block exits there) and the block goes on after the call
        if (ins.call && inl.length < 3 && room && !hooks.has(ins.tgt) && !visited.has(ins.tgt)) { ins.end = false; ins.code = ins.inlineCode; inl.push(ins.retAddr); pc = ins.tgt; ctxStack.push(ctx); ctx = nextCtx++; }
        else if (ins.ret === true && inl.length && room && !hooks.has(inl.at(-1))) { const want = inl.pop(); ins.end = false; ins.retTo = want; pc = want; ctx = ctxStack.pop(); }
        if (ins.end) break;
      }
      // the segment's last instruction either transfers control itself (end) or continues at pc
      if (insns.length > segStart) { const x = insns[insns.length - 1]; x.last = true; if (!x.end) x.segEnd = pc; }
    }
    if (!insns.length) return null;
    return this.emit(start, insns, pc);
  }
  opKey(at) { const m = this.m; let p = at, op = m.r8(p); while ([0x66, 0xf2, 0xf3, 0x64, 0x2e, 0x3e, 0x26, 0x36, 0x65].includes(op)) op = m.r8(++p);
    return op === 0x0f ? `0f ${m.r8(p + 1).toString(16)}` : (op >= 0xd8 && op <= 0xdf) ? `x87 ${op.toString(16)}/${(m.r8(p + 1) >> 3) & 7}` : op.toString(16); }
  // instruction length, by decoding with the interpreter on a scratch CPU state (no side effects: decode only)
  length(at) {
    const c = this.c, save = { eip: c.eip }; this.lenProbe ??= new LengthProbe(this.m);
    try { return this.lenProbe.len(at); } finally { c.eip = save.eip; }
  }

  // ---------------------------------------------------------------- translation of one instruction
  // returns { code, readsF, writesF, flagCode?, end? } | null (interpret) | "stop" (end the block before it)
  translate(op, sz, rep, at, d) {
    const { b8, b16, b32, s8, modrm, rd, wr } = d;
    const imm = s => s === 8 ? b8() : s === 16 ? b16() : b32();
    // x87: run the interpreter's handler with the operand already decoded (no fetch/decode/allocation per run)
    if (op >= 0xd8 && op <= 0xdf) { const o = modrm(); return this.x87(op, o) ?? this.pre(`c.x87(${op});`, o, d); }
    const alu = (k, a, b, s, dst) => {          // returns { code, flag } computing into `t`
      const m = MASK[s];
      switch (k) {
        case 0: return { code: `const t = ((${a}) + (${b})) ${s === 32 ? ">>> 0" : `& ${m}`};`, flag: `F = FL.add(F, A, B, t, ${s});`, ab: true };
        case 1: return { code: `const t = ((${a}) | (${b})) ${s === 32 ? ">>> 0" : `& ${m}`};`, flag: `F = FL.logic(F, t, ${s});` };
        case 2: return { code: `const cin = F & 1, t = ((${a}) + (${b}) + cin) ${s === 32 ? ">>> 0" : `& ${m}`};`, flag: `F = FL.adc(F, A, B, cin, t, ${s});`, ab: true, readsF: true };
        case 3: return { code: `const cin = F & 1, t = ((${a}) - (${b}) - cin) ${s === 32 ? ">>> 0" : `& ${m}`};`, flag: `F = FL.sbb(F, A, B, cin, t, ${s});`, ab: true, readsF: true };
        case 4: return { code: `const t = ((${a}) & (${b})) ${s === 32 ? ">>> 0" : `& ${m}`};`, flag: `F = FL.logic(F, t, ${s});` };
        case 5: case 7: return { code: `const t = ((${a}) - (${b})) ${s === 32 ? ">>> 0" : `& ${m}`};`, flag: `F = FL.sub(F, A, B, t, ${s});`, ab: true };
        case 6: return { code: `const t = ((${a}) ^ (${b})) ${s === 32 ? ">>> 0" : `& ${m}`};`, flag: `F = FL.logic(F, t, ${s});` };
      }
    };
    // build an ALU instruction: operands are evaluated once into A and B
    const aluIns = (k, aExpr, bExpr, s, store) => {
      const x = alu(k, "A", "B", s);
      return { code: `{ const A = ${aExpr}, B = ${bExpr}; ${x.code} ${k !== 7 ? store("t") : ""} @F }`, flagCode: x.flag, writesF: true, readsF: !!x.readsF,
        fk: k === 2 || k === 3 ? undefined : { k, s } };
    };
    if (op < 0x40 && (op & 7) < 6) {
      const k = op >> 3, form = op & 7;
      if (form === 4) { const i = b8(); return aluIns(k, R8(0), String(i), 8, v => W8(0, v)); }
      if (form === 5) { const i = imm(sz) >>> 0; return aluIns(k, RR(0, sz), String(i), sz, v => WR(0, sz, v)); }
      const s = form & 1 ? sz : 8, o = modrm();
      if (form < 2) return aluIns(k, rd(o, s), RR(o.reg, s), s, v => wr(o, s, v));
      return aluIns(k, RR(o.reg, s), rd(o, s), s, v => WR(o.reg, s, v));
    }
    if (op >= 0x40 && op < 0x50) { const i = op & 7, dec = op >= 0x48, m = MASK[sz];
      return { code: `{ const A = ${RR(i, sz)}, t = (A ${dec ? "-" : "+"} 1) ${sz === 32 ? ">>> 0" : `& ${m}`}; ${WR(i, sz, "t")} @F }`, flagCode: `F = FL.incdec(F, A, t, ${sz}, ${dec});`, writesF: true, readsF: true, fk: { k: dec ? "dec" : "inc", s: sz } }; }
    if (op >= 0x50 && op < 0x58) { if (sz !== 32) return null; return { code: `{ const v = r[${op & 7}]; r[4] = (r[4] - 4) >>> 0; m.w32(r[4], v); }` }; }
    if (op >= 0x58 && op < 0x60) { if (sz !== 32) return null; const i = op & 7; return { code: i === 4 ? `r[4] = m.r32(r[4]);` : `r[${i}] = m.r32(r[4]); r[4] = (r[4] + 4) >>> 0;` }; }
    if (op >= 0x70 && op < 0x80) { const dd = s8(), tgt = (d.pc + dd) >>> 0; return { cond: COND[op & 15], cc: op & 15, tgt, fall: d.pc, readsF: true, end: true, jcc: true }; }
    if (op >= 0xb0 && op < 0xb8) { const v = b8(); return { code: W8(op & 7, v) }; }
    if (op >= 0xb8 && op < 0xc0) { const v = imm(sz) >>> 0; return { code: WR(op & 7, sz, v) }; }
    if (op === 0x90 && !rep) return { code: "" };
    switch (op) {
      case 0x0f: return this.translate0f(b8(), sz, rep, at, d);
      case 0x68: { const v = b32() >>> 0; return sz === 32 ? { code: `r[4] = (r[4] - 4) >>> 0; m.w32(r[4], ${v});` } : null; }
      case 0x6a: { const v = s8() >>> 0; return sz === 32 ? { code: `r[4] = (r[4] - 4) >>> 0; m.w32(r[4], ${v});` } : null; }
      case 0x80: case 0x81: case 0x83: { const s = op & 1 ? sz : 8, o = modrm();
        const v = op === 0x81 ? imm(sz) >>> 0 : op === 0x83 ? ((s8() >>> 0) & MASK[s]) >>> 0 : b8();
        return aluIns(o.reg, rd(o, s), String(v), s, x => wr(o, s, x)); }
      case 0x84: case 0x85: { const s = op & 1 ? sz : 8, o = modrm(); return aluIns(4, rd(o, s), RR(o.reg, s), s, () => ""); }
      case 0x88: case 0x89: { const s = op & 1 ? sz : 8, o = modrm(); return { code: wr(o, s, RR(o.reg, s)) }; }
      case 0x8a: case 0x8b: { const s = op & 1 ? sz : 8, o = modrm(); return { code: WR(o.reg, s, rd(o, s)) }; }
      case 0x8d: { const o = modrm(); if (!o.mem) return null; const a = d.seg === 4 ? `((${o.mem} - c.fsBase) >>> 0)` : o.mem; return { code: WR(o.reg, sz, a) }; }
      case 0x98: return { code: sz === 16 ? WR(0, 16, `((r[0] << 24) >> 24)`) : `r[0] = (r[0] << 16) >> 16;` };
      case 0x99: return { code: sz === 16 ? WR(2, 16, `(r[0] & 0x8000 ? 0xffff : 0)`) : `r[2] = r[0] & 0x80000000 ? 0xffffffff : 0;` };
      case 0xa1: { if (d.seg) return null; const a = b32() >>> 0; return { code: WR(0, sz, RM(a, sz)) }; }
      case 0xa3: { if (d.seg) return null; const a = b32() >>> 0; return { code: WM(a, sz, RR(0, sz)) }; }
      case 0xa0: { if (d.seg) return null; const a = b32() >>> 0; return { code: W8(0, `m.r8(${a})`) }; }
      case 0xa2: { if (d.seg) return null; const a = b32() >>> 0; return { code: `m.w8(${a}, r[0] & 0xff);` }; }
      case 0xa8: { const i = b8(); return aluIns(4, R8(0), String(i), 8, () => ""); }
      case 0xa9: { const i = imm(sz) >>> 0; return aluIns(4, RR(0, sz), String(i), sz, () => ""); }
      case 0x69: case 0x6b: { if (sz !== 32) return null; const o = modrm(), B = op === 0x6b ? s8() : b32() | 0;   // imul r32, r/m32, imm
        return { code: `{ const A = ${rd(o, 32)} | 0, t = Math.imul(A, ${B}); r[${o.reg}] = t >>> 0; @F }`,
          flagCode: `{ const ovf = t !== A * ${B}; F = (F & ~0x801) | (ovf ? 0x801 : 0); }`, writesF: true, partialF: true }; }
      case 0x9b: return { code: "" };                                                                   // fwait
      case 0x9e: return { code: "{ @F }", flagCode: "F = (F & ~0xd5) | ((r[0] >>> 8) & 0xd5);", writesF: true, partialF: true };   // sahf
      case 0xd7: if (d.seg) return null; return { code: W8(0, `m.r8((r[3] + (r[0] & 0xff)) >>> 0)`) };   // xlat
      case 0xc6: { const o = modrm(); const v = b8(); return { code: wr(o, 8, v) }; }
      case 0xc7: { const o = modrm(); const v = imm(sz) >>> 0; return { code: wr(o, sz, v) }; }
      case 0xc0: case 0xc1: case 0xd0: case 0xd1: case 0xd2: case 0xd3: {
        const s = op & 1 ? sz : 8, o = modrm(); const n = op < 0xd0 ? String(b8()) : op < 0xd2 ? "1" : R8(1);
        const k = op < 0xd2 ? +n & 31 : -1;
        if (k === 0) return { code: "" };                                                   // count 0: no change at all
        if (s === 32 && k > 0 && (o.reg === 4 || o.reg === 5 || o.reg === 7 || o.reg === 6)) {   // constant shl / shr / sar inline
          const kind = o.reg, e = kind === 4 || kind === 6 ? `(A << ${k}) >>> 0` : kind === 5 ? `A >>> ${k}` : `(A >> ${k}) >>> 0`;
          return { code: `{ const A = ${rd(o, 32)}, t = ${e}; ${wr(o, 32, "t")} @F }`, flagCode: `F = FL.sh(F, ${kind}, A, t, ${k});`, writesF: true }; }
        // the interpreter's shift helper (exact flags; it leaves flags alone for a zero count)
        return { code: `{ ${wr(o, s, `c.shift(${o.reg}, ${rd(o, s)}, (${n}) & 31, ${s})`)} }`, readsF: true, writesF: true, flagsOpaque: true }; }
      case 0xc2: { const n = b16(); return { code: `c.eip = m.r32(r[4]); r[4] = (r[4] + ${4 + n}) >>> 0;`, end: true, ret: true, pop: 4 + n }; }
      case 0xc3: return { code: `c.eip = m.r32(r[4]); r[4] = (r[4] + 4) >>> 0;`, end: true, ret: true, pop: 4 };
      case 0xc9: return { code: `r[4] = r[5]; r[5] = m.r32(r[4]); r[4] = (r[4] + 4) >>> 0;` };
      case 0xe8: { const dd = b32() | 0, ret = d.pc, tgt = (ret + dd) >>> 0;
        return { code: `r[4] = (r[4] - 4) >>> 0; m.w32(r[4], ${ret}); c.eip = ${tgt};${NOTE(at, tgt)}`, end: true, call: true, tgt, retAddr: ret,
          inlineCode: `r[4] = (r[4] - 4) >>> 0; m.w32(r[4], ${ret});${NOTE(at, tgt)}` }; }
      case 0xe9: { const dd = b32() | 0, tgt = (d.pc + dd) >>> 0; return { code: `c.eip = ${tgt};`, end: true, jmp: true, tgt }; }
      case 0xeb: { const dd = s8(), tgt = (d.pc + dd) >>> 0; return { code: `c.eip = ${tgt};`, end: true, jmp: true, tgt }; }
      case 0xf6: case 0xf7: { const s = op & 1 ? sz : 8, o = modrm();
        if (o.reg === 0 || o.reg === 1) { const v = imm(s) >>> 0; return aluIns(4, rd(o, s), String(v), s, () => ""); }
        if (o.reg === 2) return { code: wr(o, s, `(~${rd(o, s)}) ${s === 32 ? ">>> 0" : `& ${MASK[s]}`}`) };
        return null; }
      case 0xfe: case 0xff: { const s = op === 0xfe ? 8 : sz, o = modrm();
        if (o.reg === 0 || o.reg === 1) { const dec = o.reg === 1, m = MASK[s];
          return { code: `{ const A = ${rd(o, s)}, t = (A ${dec ? "-" : "+"} 1) ${s === 32 ? ">>> 0" : `& ${m}`}; ${wr(o, s, "t")} @F }`, flagCode: `F = FL.incdec(F, A, t, ${s}, ${dec});`, writesF: true, readsF: true, fk: { k: dec ? "dec" : "inc", s } }; }
        if (op === 0xff && o.reg === 2) { const ret = d.pc; return { code: `{ const t = ${rd(o, 32)}; r[4] = (r[4] - 4) >>> 0; m.w32(r[4], ${ret}); c.eip = t;${NOTE(at, "t")} }`, end: true }; }
        if (op === 0xff && o.reg === 4) return { code: `c.eip = ${rd(o, 32)};`, end: true };
        if (op === 0xff && o.reg === 6) return { code: `{ const v = ${rd(o, 32)}; r[4] = (r[4] - 4) >>> 0; m.w32(r[4], v); }` };
        return "stop"; }
      // control transfers the compiler does not translate: let the interpreter run them
      case 0xca: case 0xcb: case 0xcc: case 0xcd: case 0xce: case 0xcf: case 0xe0: case 0xe1: case 0xe2: case 0xe3: case 0xea: case 0xf4: case 0x9a:
        return "stop";
    }
    return null;
  }
  translate0f(op, sz, rep, at, d) {
    const { b8, b32, modrm, rd, wr } = d;
    if (op >= 0x80 && op < 0x90) { const dd = b32() | 0, tgt = (d.pc + dd) >>> 0; return { cond: COND[op & 15], cc: op & 15, tgt, fall: d.pc, readsF: true, end: true, jcc: true }; }
    if (op >= 0x90 && op < 0xa0) { const o = modrm(); return { code: wr(o, 8, `(${COND[op & 15]} ? 1 : 0)`), readsF: true }; }
    if (op >= 0x40 && op < 0x50) { const o = modrm(); return { code: `{ const v = ${rd(o, sz)}; if (${COND[op & 15]}) ${WR(o.reg, sz, "v")} }`, readsF: true }; }
    switch (op) {
      case 0xb6: case 0xb7: { const o = modrm(); return { code: WR(o.reg, sz, rd(o, op === 0xb6 ? 8 : 16)) }; }
      case 0xbe: { const o = modrm(); return { code: WR(o.reg, sz, `((${rd(o, 8)} << 24) >> 24)${sz === 32 ? " >>> 0" : ""}`) }; }
      case 0xbf: { const o = modrm(); return { code: WR(o.reg, sz, `((${rd(o, 16)} << 16) >> 16)${sz === 32 ? " >>> 0" : ""}`) }; }
      case 0xaf: { if (sz !== 32) return null; const o = modrm();
        return { code: `{ const A = r[${o.reg}] | 0, B = ${rd(o, 32)} | 0, t = Math.imul(A, B); r[${o.reg}] = t >>> 0; @F }`,
          flagCode: `{ const ovf = t !== A * B; F = (F & ~0x801) | (ovf ? 0x801 : 0); }`, writesF: true, partialF: true }; }
      case 0x18: case 0x1f: modrm(); return { code: "" };
      case 0x77: return { code: "" };                                                 // emms (MMX and x87 are kept apart)
      case 0x31: case 0xa2: case 0x08: case 0x09: case 0x0b: return null;   // no ModRM: plain fallback
    }
    if (sz === 32 && rep !== 2) { const x = this.sse(op, rep, d, at); if (x) return x; }
    if (op >= 0xc8 && op < 0xd0) return null;
    // everything else in the 0F map (MMX/SSE, bit ops, shld/shrd, xadd, cmpxchg...): interpreter handler, operand
    // pre-decoded (immediates are still read from the instruction stream)
    const o = modrm(); return this.pre(`c.exec0f(${op}, ${sz}, ${at}, ${rep});`, o, d);
  }
  // x87 forms the game uses most, translated with the interpreter's exact arithmetic (x86emu.mjs x87/farith/fcmp);
  // the rest go through the interpreter handler. None of these touch EFLAGS.
  x87(op, o) {
    const ST = i => `c.fpu[(c.ftop + ${i}) & 7]`, PUSH = v => `{ const v = ${v}; c.ftop = (c.ftop - 1) & 7; c.fpu[c.ftop] = v; }`, POP = "c.ftop = (c.ftop + 1) & 7;";
    const AR = (k, a, b) => ({ 0: `${a} + ${b}`, 1: `${a} * ${b}`, 4: `${a} - ${b}`, 5: `${b} - ${a}`, 6: `${a} / ${b}`, 7: `${b} / ${a}` })[k];
    const F32R = a => `(U32[0] = m.r32(${a}), F32[0])`, F64R = a => `(U64[0] = m.r32(${a}), U64[1] = m.r32((${a} + 4) >>> 0), F64[0])`;
    const reg = o.reg;
    if (o.mem) {
      const a = o.mem;
      const arith = v => (reg === 2 || reg === 3) ? { code: `{ const v = ${v}; c.fcmp(${ST(0)}, v); ${reg === 3 ? POP : ""} }` } : { code: `{ const v = ${v}, s = ${ST(0)}; ${ST(0)} = ${AR(reg, "s", "v")}; }` };
      switch (op) {
        case 0xd8: return arith(F32R(a));
        case 0xdc: return arith(F64R(a));
        case 0xda: return arith(`(m.r32(${a}) | 0)`);
        case 0xde: return arith(`((m.r16(${a}) << 16) >> 16)`);
        case 0xd9:
          if (reg === 0) return { code: PUSH(F32R(a)) };
          if (reg === 2 || reg === 3) return { code: `{ F32[0] = ${ST(0)}; m.w32(${a}, U32[0]); ${reg === 3 ? POP : ""} }` };
          if (reg === 5) return { code: `c.fcw = m.r16(${a});` };
          if (reg === 7) return { code: `m.w16(${a}, c.fcw);` };
          return null;
        case 0xdd:
          if (reg === 0) return { code: PUSH(F64R(a)) };
          if (reg === 2 || reg === 3) return { code: `{ const A = ${a}; F64[0] = ${ST(0)}; m.w32(A, U64[0]); m.w32((A + 4) >>> 0, U64[1]); ${reg === 3 ? POP : ""} }` };
          if (reg === 7) return { code: `m.w16(${a}, c.fsw | (c.ftop << 11));` };          // fnstsw m16
          return null;
        case 0xdb: if (reg === 0) return { code: PUSH(`(m.r32(${a}) | 0)`) }; return null;
        case 0xdf: if (reg === 0) return { code: PUSH(`((m.r16(${a}) << 16) >> 16)`) }; return null;
      }
      return null;
    }
    const i = o.rm;
    switch (op) {
      case 0xd8: if (reg === 2 || reg === 3) return { code: `c.fcmp(${ST(0)}, ${ST(i)}); ${reg === 3 ? POP : ""}` };
        return { code: `{ const s = ${ST(0)}, v = ${ST(i)}; ${ST(0)} = ${AR(reg, "s", "v")}; }` };
      case 0xdc: if (reg >= 4) return { code: `{ const s = ${ST(i)}, v = ${ST(0)}; ${ST(i)} = ${AR(reg ^ 1, "s", "v")}; }` };
        if (reg < 2) return { code: `{ const s = ${ST(i)}, v = ${ST(0)}; ${ST(i)} = ${AR(reg, "s", "v")}; }` }; return null;
      case 0xda: if (reg === 5 && i === 1) return { code: `c.fcmp(${ST(0)}, ${ST(1)}); ${POP} ${POP}` }; return null;   // fucompp
      case 0xde: if (reg === 3 && i === 1) return { code: `c.fcmp(${ST(0)}, ${ST(1)}); ${POP} ${POP}` };
        if (reg === 2 || reg === 3) return null;
        return { code: `{ const s = ${ST(i)}, v = ${ST(0)}; ${ST(i)} = ${AR(reg >= 4 ? reg ^ 1 : reg, "s", "v")}; ${POP} }` };
      case 0xdd: if (reg === 0) return { code: "" }; if (reg === 2) return { code: `${ST(i)} = ${ST(0)};` }; if (reg === 3) return { code: `${ST(i)} = ${ST(0)}; ${POP}` }; return null;
      case 0xdf: if (reg === 4 && i === 0) return { code: `r[0] = (r[0] & 0xffff0000) | ((c.fsw | (c.ftop << 11)) & 0xffff);` }; return null;
      case 0xd9:
        if (reg === 0) return { code: PUSH(ST(i)) };
        if (reg === 1) return { code: `{ const t = ${ST(0)}; ${ST(0)} = ${ST(i)}; ${ST(i)} = t; }` };
        if (reg === 4 && i === 0) return { code: `${ST(0)} = -${ST(0)};` };
        if (reg === 4 && i === 1) return { code: `${ST(0)} = Math.abs(${ST(0)});` };
        if (reg === 5 && i !== 7) return { code: PUSH(String([1, Math.log2(10), Math.LOG2E, Math.PI, Math.log10(2), Math.LN2, 0][i])) };
        if (reg === 7 && i === 2) return { code: `${ST(0)} = Math.sqrt(${ST(0)});` };
        return null;
    }
    return null;
  }
  // common SSE forms on Uint32/Float32 views of the XMM file (c.xu / c.xf), same lane arithmetic as x86-simd.mjs
  sse(op, rep, d, at) {
    const ARITH = { 0x58: (a, b) => `${a} + ${b}`, 0x59: (a, b) => `${a} * ${b}`, 0x5c: (a, b) => `${a} - ${b}`, 0x5e: (a, b) => `${a} / ${b}`,
      0x51: (a, b) => `Math.sqrt(${b})`, 0x52: (a, b) => `1 / Math.sqrt(${b})`, 0x53: (a, b) => `1 / ${b}`,
      0x5d: (a, b) => `(${a} < ${b} ? ${a} : ${b})`, 0x5f: (a, b) => `(${a} > ${b} ? ${a} : ${b})` };
    const BITS = { 0x54: (a, b) => `${a} & ${b}`, 0x55: (a, b) => `~${a} & ${b}`, 0x56: (a, b) => `${a} | ${b}`, 0x57: (a, b) => `${a} ^ ${b}` };
    const known = op in ARITH || (op in BITS && !rep) || op === 0x28 || op === 0x29 || op === 0x10 || op === 0x11 || (op === 0xc6 && !rep) || op === 0xc2 ||
      (op === 0x50 && !rep) || ((op === 0x6f || op === 0x7f) && !rep) || op === 0x2a || ((op === 0x2c || op === 0x2d) && rep === 1);
    if (!known) return null;
    const o = d.modrm(), D = o.reg * 4, S = o.rm * 4;
    const srcF = k => o.mem ? `(U32[0] = m.r32((A + ${k * 4}) >>> 0), F32[0])` : `XF[${S + k}]`;
    const srcU = k => o.mem ? `m.r32((A + ${k * 4}) >>> 0)` : `XU[${S + k}]`;
    const pre = o.mem ? `const A = ${o.mem}; ` : "";
    const lanes = (n, f) => Array.from({ length: n }, (_, k) => f(k)).join(" ");
    let code;
    if (op in ARITH) { const n = rep === 1 ? 1 : 4; code = `{ ${pre}${lanes(n, k => `{ const b = ${srcF(k)}; XF[${D + k}] = ${ARITH[op](`XF[${D + k}]`, "b")}; }`)} }`; }
    else if (op in BITS) { code = `{ ${pre}${lanes(4, k => `XU[${D + k}] = (${BITS[op](`XU[${D + k}]`, srcU(k))}) >>> 0;`)} }`; }
    else if (op === 0x28 || (op === 0x10 && !rep)) code = `{ ${pre}${o.mem ? lanes(4, k => `XU[${D + k}] = ${srcU(k)};`) : `const t0 = XU[${S}], t1 = XU[${S + 1}], t2 = XU[${S + 2}], t3 = XU[${S + 3}]; XU[${D}] = t0; XU[${D + 1}] = t1; XU[${D + 2}] = t2; XU[${D + 3}] = t3;`} }`;
    else if (op === 0x29 || (op === 0x11 && !rep)) code = o.mem ? `{ ${pre}${lanes(4, k => `m.w32((A + ${k * 4}) >>> 0, XU[${D + k}]);`)} }` : `{ ${lanes(4, k => `XU[${S + k}] = XU[${D + k}];`)} }`;
    else if (op === 0x10) code = o.mem ? `{ XU[${D}] = m.r32(${o.mem}); XU[${D + 1}] = 0; XU[${D + 2}] = 0; XU[${D + 3}] = 0; }` : `XU[${D}] = XU[${S}];`;
    else if (op === 0x11) code = o.mem ? `m.w32(${o.mem}, XU[${D}]);` : `XU[${S}] = XU[${D}];`;
    else if (op === 0xc2) {                       // cmpps / cmpss: all-ones lanes where the predicate holds
      const imm = d.b8() & 7, P = ["a === b", "a < b", "a <= b", "un", "!(a === b)", "!(a < b)", "!(a <= b)", "!un"][imm], uses = imm === 3 || imm === 7;
      code = `{ ${pre}${lanes(rep === 1 ? 1 : 4, k => `{ const a = XF[${D + k}], b = ${srcF(k)}${uses ? ", un = a !== a || b !== b" : ""}; XU[${D + k}] = (${P}) ? 0xffffffff : 0; }`)} }`; }
    else if (op === 0x50) { if (o.mem) return null; code = `r[${o.reg}] = (XU[${S}] >>> 31) | ((XU[${S + 1}] >>> 31) << 1) | ((XU[${S + 2}] >>> 31) << 2) | ((XU[${S + 3}] >>> 31) << 3);`; }   // movmskps
    else if (op === 0x6f) { const Dm = o.reg * 2;    // movq mm, mm/m64
      code = o.mem ? `{ const A = ${o.mem}; MU[${Dm}] = m.r32(A); MU[${Dm + 1}] = m.r32((A + 4) >>> 0); }` : `{ const t0 = MU[${o.rm * 2}], t1 = MU[${o.rm * 2 + 1}]; MU[${Dm}] = t0; MU[${Dm + 1}] = t1; }`; }
    else if (op === 0x7f) { const Sm = o.reg * 2;    // movq mm/m64, mm
      code = o.mem ? `{ const A = ${o.mem}; m.w32(A, MU[${Sm}]); m.w32((A + 4) >>> 0, MU[${Sm + 1}]); }` : `{ const t0 = MU[${Sm}], t1 = MU[${Sm + 1}]; MU[${o.rm * 2}] = t0; MU[${o.rm * 2 + 1}] = t1; }`; }
    else if (op === 0x2a) {                       // F3: cvtsi2ss xmm, r/m32; else cvtpi2ps xmm, mm/m64
      if (rep === 1) code = `XF[${D}] = ${o.mem ? `m.r32(${o.mem})` : `r[${o.rm}]`} | 0;`;
      else code = o.mem ? `{ const A = ${o.mem}; XF[${D}] = m.r32(A) | 0; XF[${D + 1}] = m.r32((A + 4) >>> 0) | 0; }` : `{ const t0 = MU[${o.rm * 2}] | 0, t1 = MU[${o.rm * 2 + 1}] | 0; XF[${D}] = t0; XF[${D + 1}] = t1; }`; }
    else if (op === 0x2c || op === 0x2d) {        // F3: cvttss2si / cvtss2si r32, xmm/m32 (MXCSR rounding)
      const v = o.mem ? `(U32[0] = m.r32(${o.mem}), F32[0])` : `XF[${S}]`;
      code = `{ const v = ${op === 0x2c ? `Math.trunc(${v})` : `c.mxRound(${v})`}; r[${o.reg}] = (Number.isFinite(v) && v >= -2147483648 && v <= 2147483647 ? v | 0 : -2147483648) >>> 0; }`; }
    else if (op === 0xc6) { const imm = d.b8();
      code = `{ ${pre}const v0 = XU[${D + (imm & 3)}], v1 = XU[${D + ((imm >> 2) & 3)}], v2 = ${srcU((imm >> 4) & 3)}, v3 = ${srcU((imm >> 6) & 3)}; XU[${D}] = v0; XU[${D + 1}] = v1; XU[${D + 2}] = v2; XU[${D + 3}] = v3; }`; }
    return code ? { code } : null;
  }
  pre(call, o, d) {
    const lit = o.mem ? `{ reg: ${o.reg}, mod: ${o.mod}, rm: ${o.rm}, addr: ${o.mem} }` : `{ reg: ${o.reg}, mod: 3, rm: ${o.rm} }`;
    return { code: `c.seg = ${d.seg}; c.pm = ${lit}; c.eip = ${d.pc}; ${call}`, readsF: true, writesF: true, pre: true };
  }

  // ---------------------------------------------------------------- code emission
  emit(start, insns, endPc) {
    const n = insns.length;
    // internal jumps: a branch to an instruction of this same block (same inline context, address decoded once)
    // continues inside the function instead of returning to the dispatcher; backward ones only while the
    // remaining step budget (c.lim, set by the dispatcher) covers another pass to the end of the block
    const seen = new Map(); insns.forEach((x, i) => seen.set(x.at, seen.has(x.at) ? -1 : i));
    const inner = (x, tgt) => { const t = seen.get(tgt); return t !== undefined && t >= 0 && insns[t].ctx === x.ctx ? t : -1; };
    const targets = new Set();
    if (!NOLOOP) insns.forEach((x, i) => { if ((x.jcc || (x.jmp && x.end)) && x.tgt !== undefined) { const t = inner(x, x.tgt); if (t >= 0) { x.inner = t; targets.add(t); } }
      if (x.segEnd !== undefined) { const t = inner(x, x.segEnd); if (t >= 0) { x.segInner = t; targets.add(t); } } });
    // compare + branch fusion: a conditional branch right after the instruction that sets its flags (cmp, test, sub,
    // and, add, inc, dec...) tests the operands directly ($fa, $fb, $ft) and, when taken, computes EFLAGS then
    // (they may be read at the target); on the fall-through path the flags are computed only if something reads them
    insns.forEach((x, i) => { const y = insns[i + 1];
      if (x.fk && !x.last && y && y.jcc && y.side && !targets.has(i + 1)) { y.fused = x.fk; x.fuse = true; } });
    // flag liveness, backwards: flags are live at the end of every segment and before interpreted instructions
    let live = true;
    for (let i = insns.length - 1; i >= 0; i--) {
      const x = insns[i];
      if (x.last) live = true;
      if (x.fused) continue;                                     // tests operands; the taken path computes EFLAGS itself
      if (x.writesF && !x.partialF) { x.needF = live; live = !!x.readsF; }
      else { if (x.writesF) x.needF = true; if (x.readsF) live = true; }
    }
    // registers and EFLAGS live in locals ($r0..$r7, F); c.r / c.flags are written back at every exit and around
    // instructions run by the interpreter (fallbacks, pre-decoded handlers), which read and write them directly
    const regAssign = /(?<![\w.$])r\[([0-7])\] = (?!=)/g, regRef = /(?<![\w.$])r\[([0-7])\]/g;
    const localize = code => {
      let out = "", pos = 0, mt; regAssign.lastIndex = 0;
      while ((mt = regAssign.exec(code)) !== null) {
        let j = regAssign.lastIndex, depth = 0;
        for (; j < code.length; j++) { const ch = code[j]; if (ch === "(" || ch === "[" || ch === "{") depth++; else if (ch === ")" || ch === "]" || ch === "}") depth--; else if (ch === ";" && depth === 0) break; }
        out += code.slice(pos, mt.index) + `$r${mt[1]} = (${code.slice(regAssign.lastIndex, j)}) >>> 0`; pos = j; regAssign.lastIndex = j;
      }
      return (out + code.slice(pos)).replace(regRef, "$$r$1");
    };
    // memory access inline (the page table lookup of uis-vm.mjs Memory, then the region's DataView / Buffer):
    // m.r32(a) -> ($a = a >>> 0, ($p = PG[$a >>> 16] ?? m.region($a)).dv.getUint32($a - $p.base, true)), same
    // semantics as the methods. Writes stay method calls in verify mode, which journals them through m.w8/16/32.
    const inlineW = !this.verify && !process.env.NT04_JIT_NO_INLINE_W, low = this.m.low !== null && this.m.low !== undefined;
    const inlineMem = code => {
      for (let at = code.lastIndexOf("m."); at >= 0; at = at > 0 ? code.lastIndexOf("m.", at - 1) : -1) {
        if (at > 0 && /[\w.$]/.test(code[at - 1])) continue;
        const mt = /^m\.(r8|r16|r32|w8|w16|w32)\(/.exec(code.slice(at, at + 6)); if (!mt) continue;
        const kind = mt[1], open = at + mt[0].length; let depth = 0, j = open, comma = -1;
        for (; j < code.length; j++) { const ch = code[j]; if (ch === "(" || ch === "[" || ch === "{") depth++; else if (ch === ")" || ch === "]" || ch === "}") { if (depth === 0) break; depth--; } else if (ch === "," && depth === 0 && comma < 0) comma = j; }
        const isW = kind[0] === "w"; if (isW && !inlineW) continue;
        const A = isW ? code.slice(open, comma) : code.slice(open, j), V = isW ? code.slice(comma + 1, j) : "";
        const P = "($p = PG[$a >>> 16] ?? m.region($a))";
        let rep;
        if (low) {                                // flat low window (uis-vm.mjs Memory.enableLow); else the method
          const LA = `($a = (${A}) >>> 0) < ${LOW_SIZE} && LOK[$a >>> 16] === 1`;
          switch (kind) {
            case "r8": rep = `(${LA} ? LB[$a] : m.r8($a))`; break;
            case "r16": rep = `(${LA} && ($a & 0xffff) <= 0xfffe ? LDV.getUint16($a, true) : m.r16($a))`; break;
            case "r32": rep = `(${LA} && ($a & 0xffff) <= 0xfffc ? LDV.getUint32($a, true) : m.r32($a))`; break;
            case "w8": rep = `($v = ${V}, ${LA} ? LB[$a] = $v & 0xff : m.w8($a, $v))`; break;
            case "w16": rep = `($v = ${V}, ${LA} && ($a & 0xffff) <= 0xfffe ? LDV.setUint16($a, $v, true) : m.w16($a, $v))`; break;
            case "w32": rep = `($v = ${V}, ${LA} && ($a & 0xffff) <= 0xfffc ? LDV.setUint32($a, $v, true) : m.w32($a, $v))`; break;
          }
          code = code.slice(0, at) + rep + code.slice(j + 1); continue;
        }
        switch (kind) {
          case "r8": rep = `($a = (${A}) >>> 0, ${P}.buf[$a - $p.base])`; break;
          case "r16": rep = `($a = (${A}) >>> 0, ${P}.dv.getUint16($a - $p.base, true))`; break;
          case "r32": rep = `($a = (${A}) >>> 0, ${P}.dv.getUint32($a - $p.base, true))`; break;
          case "w8": rep = `($v = ${V}, $a = (${A}) >>> 0, ${P}.buf[$a - $p.base] = $v & 0xff)`; break;
          case "w16": rep = `($v = ${V}, $a = (${A}) >>> 0, ${P}.dv.setUint16($a - $p.base, $v, true))`; break;
          case "w32": rep = `($v = ${V}, $a = (${A}) >>> 0, ${P}.dv.setUint32($a - $p.base, $v, true))`; break;
        }
        code = code.slice(0, at) + rep + code.slice(j + 1);
      }
      return code;
    };
    const codes = insns.map((x, i) => {
      let code = x.code ?? "";
      if (x.fallback) code = code.replace("@I1", String(i + 1)).replace("@I", String(i));
      const keep = x.fuse ? (x.fk.k === "inc" || x.fk.k === "dec" ? "$fa = A; $ft = t; " : "$fa = A; $fb = B; $ft = t; ") : "";
      code = code.replace("@F", keep + (x.writesF && x.needF ? (x.flagCode ?? "") : ""));
      return code;
    });
    const used = new Set(), written = new Set();
    insns.forEach((x, i) => { if (x.fallback || x.pre) return; const c2 = localize(codes[i] + (x.cond ?? "")); for (const mt of c2.matchAll(/\$r([0-7])( = )?/g)) { used.add(+mt[1]); if (mt[2]) written.add(+mt[1]); } });
    if (insns.some(x => x.retTo !== undefined || x.call)) { used.add(4); written.add(4); }
    const x87 = insns.some(x => !x.fallback && !x.pre && (x.code ?? "").includes("c.ftop"));     // x87 stack top in a local too
    const WB = [...written].map(k => `r[${k}] = $r${k};`).join(" ") + " c.flags = F;" + (x87 ? " c.ftop = $top;" : "");
    const RL = [...used].map(k => `$r${k} = r[${k}];`).join(" ") + " F = c.flags;" + (x87 ? " $top = c.ftop;" : "");
    const EXIT = (i, eip) => `{ $e = ${eip}; $n = ${i + 1}; break X; }`;     // to the shared epilogue (write-back, eip, steps)
    const JUMP = (i, t) => t > i ? `{ c.steps += ${i + 1} - $k; $k = ${t}; $P = ${t}; continue L; }`
      : `{ const s = c.steps + ${i + 1} - $k; if (s + ${n - t} <= c.lim) { c.steps = s; $k = ${t}; $P = ${t}; continue L; } }`;
    // EFLAGS bits of a fused producer as expressions over its saved operands (formulas of FL above)
    const fusedFlags = fk => {
      const S = SIGN[fk.s], M = MASK[fk.s], sgn = `(($ft & ${S}) !== 0)`, Z = "($ft === 0)", P = "(PARITY[$ft & 0xff] === 1)";
      let C, O, mat;
      if (fk.k === 5 || fk.k === 7) { C = "($fa < $fb)"; O = `((($fa ^ $fb) & ($fa ^ $ft) & ${S}) !== 0)`; mat = `F = FL.sub(F, $fa, $fb, $ft, ${fk.s});`; }
      else if (fk.k === 0) { C = `($fa + $fb > ${M})`; O = `((~($fa ^ $fb) & ($fa ^ $ft) & ${S}) !== 0)`; mat = `F = FL.add(F, $fa, $fb, $ft, ${fk.s});`; }
      else if (fk.k === "inc" || fk.k === "dec") { C = "((F & 1) !== 0)"; O = fk.k === "dec" ? `((($fa ^ 1) & ($fa ^ $ft) & ${S}) !== 0)` : `((~($fa ^ 1) & ($fa ^ $ft) & ${S}) !== 0)`;
        mat = `F = FL.incdec(F, $fa, $ft, ${fk.s}, ${fk.k === "dec"});`; }
      else { C = "false"; O = "false"; mat = `F = FL.logic(F, $ft, ${fk.s});`; }
      const T = [O, `!${O}`, C, `!${C}`, Z, `!${Z}`, `(${C} || ${Z})`, `!(${C} || ${Z})`, sgn, `!${sgn}`, P, `!${P}`,
        `(${sgn} !== ${O})`, `(${sgn} === ${O})`, `(${Z} || ${sgn} !== ${O})`, `(!${Z} && ${sgn} === ${O})`];
      return { cond: cc => T[cc], mat };
    };
    const body = [], ats = [];
    insns.forEach((x, i) => {
      ats.push(x.at);
      let code = codes[i];
      if (x.fallback || x.pre) code = `${WB} $s = 1; ${code} $s = 0; ${RL}`;
      else {
        if (x.retTo !== undefined) code = `{ const t = m.r32(r[4]); r[4] = (r[4] + ${x.pop}) >>> 0; if (t !== ${x.retTo}) ${EXIT(i, "t")} }`;
        if (x.jcc && x.fused) { const f = fusedFlags(x.fused); code = `if (${f.cond(x.cc)}) { ${f.mat} ${x.inner !== undefined ? JUMP(i, x.inner) : ""} ${EXIT(i, x.tgt)} }`; }
        else if (x.jcc) code = x.side ? `if (${x.cond}) { ${x.inner !== undefined ? JUMP(i, x.inner) : ""} ${EXIT(i, x.tgt)} }`
          : x.inner !== undefined ? `if (${x.cond}) ${JUMP(i, x.inner)} c.eip = ${x.cond} ? ${x.tgt} : ${x.fall};` : `c.eip = ${x.cond} ? ${x.tgt} : ${x.fall};`;
        else if (x.jmp && x.end && x.inner !== undefined) code = `${JUMP(i, x.inner)} ${code}`;
        code = inlineMem(localize(code));
        if (x87) code = code.replaceAll("c.ftop", "$top").replaceAll("c.fpu", "$fpu");
        if (x.flagsOpaque) code = `c.flags = F; ${code} F = c.flags;`;
      }
      // end of a segment: never fall into the next one
      if (x.last) code += x.end ? ` { $e = -1; $n = ${i + 1}; break X; }`
        : ` ${x.segInner !== undefined ? JUMP(i, x.segInner) : ""} ${EXIT(i, x.segEnd)}`;
      body.push(`${targets.has(i) ? `case ${i}:\n` : ""}${DEBUG ? `/* ${x.at.toString(16)} */ ` : ""}i = ${i}; { ${code} }`);
    });
    const loop = targets.size > 0;
    // a fault counts the faulting instruction, like the interpreter (step() counts before executing); an x86 error
    // comes from an interpreted fallback, whose step() already left c.steps exact. $s: c.r / c.flags hold the state
    // (an interpreted instruction was running), else the locals do and are written back.
    const src = `"use strict";
return (function blk_${start.toString(16)}(c, r, m) {
  let i = 0, $k = 0, $P = 0, $s = 0, $e = -1, $n = ${n}, $a = 0, $v = 0, $p = null, $fa = 0, $fb = 0, $ft = 0${x87 ? ", $top = c.ftop, $fpu = c.fpu" : ""}, F = c.flags${[...used].map(k => `, $r${k} = r[${k}]`).join("")};
  const $s0 = c.steps;
  try { X: {
${loop ? "L: for (;;) { switch ($P) { case 0:\n" : ""}${body.join("\n")}
${loop ? "} break; }\n" : ""}  } } catch (e) { c.pm = null; if (!$s) { ${WB} } if (!e.x86) { c.steps += i + 1 - $k; c.eip = ATS[i]; e.message = "x86 at 0x" + ATS[i].toString(16) + " (compiled): " + e.message + "; call stack " + c.callStack(); e.x86 = true; e.at = ATS[i]; } throw e; }
  ${WB} if ($e >= 0) c.eip = $e;
  c.steps += $n - $k; return c.steps - $s0;
});`;
    let fn;
    try { fn = new Function("FL", "ATS", "F32", "U32", "F64", "U64", "XU", "XF", "MU", "PG", "PARITY", "LB", "LDV", "LOK", src)(FL, ats, F32, U32, F64, U64, this.xu, this.xf, this.mu, this.m.pages, PARITY, this.m.low, this.m.lowDV, this.m.lowOK); }
    catch (e) { this.stats.compileErrors = (this.stats.compileErrors ?? 0) + 1; this.lastError = { start, e: e.message, src }; return null; }
    fn.n = n; fn.start = start; fn.src = src; this.dirty = true;
    this.stats.compiled++;
    if (this.cache && !this.verify) this.cache.add(start, src.slice(src.indexOf("return ") + 7, src.lastIndexOf(";")), ats, n);
    return fn;
  }
  // free variables of block code, in x86-jit-cache.mjs PARAMS order (cached chunks bind them on load)
  cacheArgs() { return [FL, F32, U32, F64, U64, this.xu, this.xf, this.mu, this.m.pages, PARITY, this.m.low, this.m.lowDV, this.m.lowOK]; }
}

// Instruction lengths for interpreted fallbacks: decode with a throwaway interpreter whose memory reads go to the
// real memory and whose writes are discarded, executing nothing (we only need where the next instruction starts).
class LengthProbe {
  constructor(mem) { this.m = mem; }
  len(at) {
    const m = this.m; let p = at, op = m.r8(p);
    while ([0x66, 0xf2, 0xf3, 0x64, 0x2e, 0x3e, 0x26, 0x36, 0x65].includes(op)) op = m.r8(++p);
    const opsz16 = (() => { for (let q = at; q < p; q++) if (m.r8(q) === 0x66) return true; return false; })();
    p++;
    const modrmLen = () => { const b = m.r8(p++), mod = b >> 6, rm = b & 7; if (mod === 3) return;
      if (rm === 4) { const sib = m.r8(p++); if ((sib & 7) === 5 && mod === 0) p += 4; } else if (rm === 5 && mod === 0) p += 4;
      if (mod === 1) p += 1; else if (mod === 2) p += 4; };
    const iv = opsz16 ? 2 : 4;
    if (op === 0x0f) {
      const o2 = m.r8(p++);
      if (o2 >= 0x80 && o2 < 0x90) return p + 4 - at;
      if ([0x31, 0xa2, 0x08, 0x09, 0x77, 0x0b].includes(o2) || (o2 >= 0xc8 && o2 < 0xd0)) return p - at;
      modrmLen();
      if ([0xa4, 0xac, 0xba, 0x70, 0x71, 0x72, 0x73, 0xc2, 0xc4, 0xc5, 0xc6].includes(o2)) p += 1;
      return p - at;
    }
    if (op >= 0xd8 && op <= 0xdf) { modrmLen(); return p - at; }
    if (op < 0x40 && (op & 7) < 6) { const f = op & 7; if (f === 4) p += 1; else if (f === 5) p += iv; else modrmLen(); return p - at; }
    if (op >= 0x40 && op < 0x62) return p - at;
    if (op >= 0x70 && op < 0x80) return p + 1 - at;
    if (op >= 0x90 && op < 0xa0) return p - at;
    if (op >= 0xb0 && op < 0xb8) return p + 1 - at;
    if (op >= 0xb8 && op < 0xc0) return p + iv - at;
    switch (op) {
      case 0x68: return p + 4 - at; case 0x6a: return p + 1 - at;
      case 0x69: modrmLen(); return p + iv - at; case 0x6b: modrmLen(); return p + 1 - at;
      case 0x80: case 0x82: case 0x83: case 0xc0: case 0xc1: case 0xc6: modrmLen(); return p + 1 - at;
      case 0x81: case 0xc7: modrmLen(); return p + iv - at;
      case 0xa0: case 0xa1: case 0xa2: case 0xa3: return p + 4 - at;
      case 0xa8: return p + 1 - at; case 0xa9: return p + iv - at;
      case 0xc2: return p + 2 - at; case 0xc8: return p + 3 - at;
      case 0xe8: case 0xe9: return p + 4 - at; case 0xeb: return p + 1 - at;
      case 0xf6: case 0xf7: { const reg = (m.r8(p) >> 3) & 7; modrmLen(); if (reg < 2) p += op === 0xf6 ? 1 : iv; return p - at; }
      case 0x84: case 0x85: case 0x86: case 0x87: case 0x88: case 0x89: case 0x8a: case 0x8b: case 0x8c: case 0x8d: case 0x8e: case 0x8f:
      case 0xd0: case 0xd1: case 0xd2: case 0xd3: case 0xfe: case 0xff: modrmLen(); return p - at;
      case 0xa4: case 0xa5: case 0xa6: case 0xa7: case 0xaa: case 0xab: case 0xac: case 0xad: case 0xae: case 0xaf:
      case 0xc3: case 0xc9: case 0x98: case 0x99: case 0x9b: case 0x9c: case 0x9d: case 0x9e: case 0x9f: case 0xd7:
      case 0xf5: case 0xf8: case 0xf9: case 0xfa: case 0xfb: case 0xfc: case 0xfd: case 0x60: case 0x61: return p - at;
    }
    return null;
  }
}
