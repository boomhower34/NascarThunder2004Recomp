// Prototype: x86 block -> WebAssembly function, for measuring against the JavaScript blocks (x86-jit.mjs).
// Subset: 32-bit integer forms (mov, lea, ALU incl. cmp/test with flags, inc/dec, push/pop, shifts by imm8,
// movzx/movsx, jcc as side exits, jmp/call followed (calls inlined with a return-address check), ret).
// Anything else ends the block before it. Guest memory = the WebAssembly memory (index = guest address); lowOK at
// LOW_SIZE (64 KB of entries, 0 above the window); state page at CTX: r0..r7 (+0..28), EFLAGS (+32), count (+36).
import { Code, OP, I32, buildModule } from "../src/cpu/wasm-emit.mjs";
const LOW = 0x10000000, OKB = LOW, CTX = LOW + 0x10000;
const R = i => i, LF = 8, FA = 9, FB = 10, FT = 11, LA = 12, LV = 13, LT = 14, LA2 = 15, NLOC = 16;
const IMP = { r8: 0, r16: 1, r32: 2, w8: 3, w16: 4, w32: 5 };
const F_CF = 1, F_PF = 4, F_ZF = 0x40, F_SF = 0x80, F_OF = 0x800;

export function translate(m, start, maxInsns = 64) {
  const c = new Code(); let pc = start, n = 0;
  const b8 = () => m.r8(pc++), s8 = () => (b8() << 24) >> 24, b32 = () => { const v = m.r32(pc); pc += 4; return v | 0; };
  let pend = null;                                      // pending flags: { k: "add"|"sub"|"logic"|"inc"|"dec" } in FA/FB/FT
  const inl = [];                                       // expected return addresses of inlined calls
  // prologue: registers and EFLAGS into locals
  for (let i = 0; i < 8; i++) c.i32(CTX + i * 4).load().set(i);
  c.i32(CTX + 32).load().set(LF);
  // --- helpers emitting code
  const okCond = (lim) => { c.get(LA).i32(16).op(OP.shrU).op(0x2d, 0, ...leb(OKB)).get(LA).i32(0xffff).op(OP.and).i32(lim).op(OP.leU).op(OP.and); };   // stack: ok?
  const rd32 = () => { okCond(0xfffc); c.if_(I32).get(LA).load().else_().get(LA).call(IMP.r32).end(); };   // addr in LA -> value
  const rd16 = () => { okCond(0xfffe); c.if_(I32).get(LA).load16u().else_().get(LA).call(IMP.r16).end(); };
  const rd8 = () => { okCond(0xffff); c.if_(I32).get(LA).load8u().else_().get(LA).call(IMP.r8).end(); };
  const wr32 = () => { okCond(0xfffc); c.if_().get(LA).get(LV).store().else_().get(LA).get(LV).call(IMP.w32).end(); };   // LA, LV
  // operand decoding: returns { reg, mem } (mem true: address computed into LA)
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
  const rdRM = o => { if (o.mem) rd32(); else c.get(o.rm); };          // value of r/m32 on the stack
  const wrRM = (o) => { if (o.mem) { c.set(LV); wr32(); } else c.set(o.rm); };   // value on the stack -> r/m32
  // flags
  const condOf = (cc) => {                                           // pushes 0/1 for condition cc
    const base = cc >> 1, neg = cc & 1;
    const P = () => { c.get(FT).i32(0xff).op(OP.and).op(OP.popcnt).i32(1).op(OP.and).op(OP.eqz); };
    if (pend) {
      const k = pend.k;
      const CF = () => { if (k === "sub") c.get(FA).get(FB).op(OP.ltU); else if (k === "add") c.get(FT).get(FA).op(OP.ltU); else if (k === "logic") c.i32(0); else c.get(LF).i32(1).op(OP.and); };
      const ZF = () => { c.get(FT).op(OP.eqz); };
      const SF = () => { c.get(FT).i32(0).op(OP.ltS); };
      const OF = () => { if (k === "sub") c.get(FA).get(FB).op(OP.xor).get(FA).get(FT).op(OP.xor).op(OP.and).i32(0).op(OP.ltS);
        else if (k === "add") c.get(FA).get(FB).op(OP.xor).i32(-1).op(OP.xor).get(FA).get(FT).op(OP.xor).op(OP.and).i32(0).op(OP.ltS);
        else if (k === "logic") c.i32(0); else if (k === "inc") c.get(FT).i32(0x80000000 | 0).op(OP.eq); else c.get(FT).i32(0x7fffffff).op(OP.eq); };
      [() => OF(), () => CF(), () => ZF(), () => { CF(); ZF(); c.op(OP.or); }, () => SF(), () => P(), () => { SF(); OF(); c.op(OP.ne); }, () => { ZF(); SF(); OF(); c.op(OP.ne); c.op(OP.or); }][base]();
    } else {
      const bit = v => { c.get(LF).i32(v).op(OP.and).i32(0).op(OP.ne); };
      [() => bit(F_OF), () => bit(F_CF), () => bit(F_ZF), () => { c.get(LF).i32(F_CF | F_ZF).op(OP.and).i32(0).op(OP.ne); }, () => bit(F_SF), () => bit(F_PF),
       () => { bit(F_SF); bit(F_OF); c.op(OP.ne); }, () => { bit(F_ZF); bit(F_SF); bit(F_OF); c.op(OP.ne); c.op(OP.or); }][base]();
    }
    if (neg) c.op(OP.eqz);
  };
  const materialize = () => {                                        // pending -> F (in LF)
    if (!pend) return;
    c.get(LF).i32(~(F_CF | F_PF | F_ZF | F_SF | F_OF)).op(OP.and);
    condOf(2); c.op(OP.or);                                           // CF -> bit 0
    condOf(10); c.i32(2).op(OP.shl).op(OP.or);                        // PF -> bit 2
    condOf(4); c.i32(6).op(OP.shl).op(OP.or);
    condOf(8); c.i32(7).op(OP.shl).op(OP.or);
    condOf(0); c.i32(11).op(OP.shl).op(OP.or);
    c.set(LF); pend = null;
  };
  // exit: (flags on this path) registers, EFLAGS, count -> CTX, return eip (on the stack: pushEip())
  const exit = (pushEip, count) => {
    const saved = pend; materialize(); pend = saved;
    for (let i = 0; i < 8; i++) c.i32(CTX + i * 4).get(i).store();
    c.i32(CTX + 32).get(LF).store(); c.i32(CTX + 36).i32(count).store();
    pushEip(); c.ret();
  };
  const setPend = (k, a, b, t) => { pend = { k }; };
  const visited = new Set();
  for (; n < maxInsns; ) {
    if (visited.has(pc)) break; visited.add(pc);
    const at = pc; let op = b8();
    if (op === 0x0f) {
      const op2 = b8();
      if (op2 >= 0x80 && op2 <= 0x8f) { const d = b32(), tgt = (pc + d) >>> 0; n++; condOf(op2 & 15); c.if_(); exit(() => c.i32(tgt), n); c.end(); continue; }
      if (op2 === 0xb6 || op2 === 0xb7 || op2 === 0xbe || op2 === 0xbf) {
        const o = modrm(), w = op2 & 1, sx = op2 >= 0xbe;
        if (o.mem) { if (w) rd16(); else rd8(); }
        else if (w) c.get(o.rm).i32(0xffff).op(OP.and);
        else if (o.rm < 4) c.get(o.rm).i32(0xff).op(OP.and); else c.get(o.rm - 4).i32(8).op(OP.shrU).i32(0xff).op(OP.and);
        if (sx) c.i32(w ? 16 : 24).op(OP.shl).i32(w ? 16 : 24).op(OP.shrS);
        c.set(o.reg); n++; continue;
      }
      pc = at; break;
    }
    if (op === 0x66 || op === 0xf2 || op === 0xf3 || op === 0x64 || (op >= 0xd8 && op <= 0xdf)) { pc = at; break; }
    // ALU r/m32,r32 / r32,r/m32 / eax,imm32 / 81 / 83
    const aluK = op < 0x40 && ((op & 7) === 1 || (op & 7) === 3 || (op & 7) === 5) ? op >> 3 : (op === 0x81 || op === 0x83) ? -1 : -2;
    if (aluK !== -2) {
      let k, o = null, imm = null, toReg = false;
      if (aluK === -1) { o = modrm(); k = o.reg; imm = op === 0x81 ? b32() : s8(); }
      else { k = aluK; if ((op & 7) === 5) imm = b32(); else { o = modrm(); toReg = (op & 7) === 3; } }
      if (k === 2 || k === 3) { pc = at; break; }                    // adc / sbb: not in the prototype
      // A, B
      if ((op & 7) === 5 && aluK >= 0) c.get(0); else if (toReg) c.get(o.reg); else rdRM(o);
      c.set(FA);
      if (imm !== null) c.i32(imm); else if (toReg) rdRM(o); else c.get(o.reg);
      c.set(FB);
      c.get(FA).get(FB).op([OP.add, OP.or, 0, 0, OP.and, OP.sub, OP.xor, OP.sub][k]).set(FT);
      if (k !== 7) { c.get(FT); if ((op & 7) === 5 && aluK >= 0) c.set(0); else if (toReg) c.set(o.reg); else wrRM(o); }
      pend = { k: k === 0 ? "add" : k === 5 || k === 7 ? "sub" : "logic" }; n++; continue;
    }
    if (op === 0x85 || op === 0xa9 || (op === 0xf7 && ((m.r8(pc) >> 3) & 7) === 0)) {           // test
      if (op === 0xa9) { c.get(0).i32(b32()); }
      else if (op === 0x85) { const o = modrm(); rdRM(o); c.get(o.reg); }
      else { const o = modrm(); rdRM(o); c.i32(b32()); }
      c.op(OP.and).set(FT); pend = { k: "logic" }; n++; continue;
    }
    if (op >= 0x40 && op < 0x50) { const i = op & 7, dec = op >= 0x48; materialize();
      c.get(i).set(FA).get(i).i32(1).op(dec ? OP.sub : OP.add).tee(FT).set(i); pend = { k: dec ? "dec" : "inc" }; n++; continue; }
    if (op >= 0x50 && op < 0x58) { const i = op & 7; c.get(i).set(LV).get(4).i32(4).op(OP.sub).tee(4).set(LA); wr32(); n++; continue; }
    if (op >= 0x58 && op < 0x60) { const i = op & 7; c.get(4).set(LA); rd32(); c.set(LT); c.get(4).i32(4).op(OP.add).set(4); c.get(LT).set(i); n++; continue; }
    if (op === 0x68 || op === 0x6a) { const v = op === 0x68 ? b32() : s8(); c.i32(v).set(LV).get(4).i32(4).op(OP.sub).tee(4).set(LA); wr32(); n++; continue; }
    if (op >= 0xb8 && op < 0xc0) { c.i32(b32()).set(op & 7); n++; continue; }
    if (op === 0x8b) { const o = modrm(); rdRM(o); c.set(o.reg); n++; continue; }
    if (op === 0x89) { const o = modrm(); c.get(o.reg); wrRM(o); n++; continue; }
    if (op === 0xc7 && ((m.r8(pc) >> 3) & 7) === 0) { const o = modrm(); const v = b32(); c.i32(v); wrRM(o); n++; continue; }
    if (op === 0x8d) { const o = modrm(); if (!o.mem) { pc = at; break; } c.get(LA).set(o.reg); n++; continue; }
    if (op === 0xc1) { const o = modrm(); const kind = o.reg, cnt = b8() & 31; if (kind !== 4 && kind !== 5 && kind !== 7) { pc = at; break; }
      if (!cnt) { n++; continue; }
      materialize();
      rdRM(o); c.set(LT);                                            // v
      c.get(LT).i32(cnt).op(kind === 4 ? OP.shl : kind === 5 ? OP.shrU : OP.shrS).set(FT);     // res
      // flags: ZF SF PF of res, CF last bit out, OF for count 1 (shl: res sign != CF, shr: v sign)
      c.get(LF).i32(~(F_CF | F_PF | F_ZF | F_SF | F_OF)).op(OP.and);
      c.get(FT).op(OP.eqz).i32(6).op(OP.shl).op(OP.or);
      c.get(FT).i32(31).op(OP.shrU).i32(7).op(OP.shl).op(OP.or);
      c.get(FT).i32(0xff).op(OP.and).op(OP.popcnt).i32(1).op(OP.and).op(OP.eqz).i32(2).op(OP.shl).op(OP.or);
      if (kind === 4) c.get(LT).i32(32 - cnt).op(OP.shrU).i32(1).op(OP.and); else c.get(LT).i32(cnt - 1).op(kind === 5 ? OP.shrU : OP.shrS).i32(1).op(OP.and);
      c.tee(LA2).op(OP.or);
      if (cnt === 1 && kind === 4) c.get(FT).i32(31).op(OP.shrU).get(LA2).op(OP.ne).i32(11).op(OP.shl).op(OP.or);
      if (cnt === 1 && kind === 5) c.get(LT).i32(31).op(OP.shrU).i32(11).op(OP.shl).op(OP.or);
      c.set(LF);
      c.get(FT); wrRM(o); n++; continue;
    }
    if (op >= 0x70 && op < 0x80) { const d = s8(), tgt = (pc + d) >>> 0; n++; condOf(op & 15); c.if_(); exit(() => c.i32(tgt), n); c.end(); continue; }
    if (op === 0xeb || op === 0xe9) { const d = op === 0xeb ? s8() : b32(); n++; pc = (pc + d) >>> 0; continue; }       // followed
    if (op === 0xe8) { const d = b32(), ret = pc, tgt = (pc + d) >>> 0; n++;
      c.i32(ret).set(LV).get(4).i32(4).op(OP.sub).tee(4).set(LA); wr32();
      if (inl.length < 3) { inl.push(ret); pc = tgt; continue; }
      exit(() => c.i32(tgt), n); return done(c, start, n, pc);
    }
    if (op === 0xc3) { n++; c.get(4).set(LA); rd32(); c.set(LT); c.get(4).i32(4).op(OP.add).set(4);
      if (inl.length) { const want = inl.pop(); c.get(LT).i32(want).op(OP.ne).if_(); exit(() => c.get(LT), n); c.end(); pc = want; continue; }
      exit(() => c.get(LT), n); return done(c, start, n, pc);
    }
    pc = at; break;
  }
  if (!n) return null;
  exit(() => c.i32(pc), n);
  return done(c, start, n, pc);
}
function leb(n) { const out = []; n >>>= 0; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; }
function done(c, start, n, pc) { c.i32(0); return { code: c, start, n }; }      // unreachable tail value (function needs a result)

// instantiate translated blocks; returns a function per block: run() -> exit eip (CTX holds the state)
export function instantiate(m, blocks) {
  const mem = m.wasmMemory;
  const imports = [["r8", [I32], [I32]], ["r16", [I32], [I32]], ["r32", [I32], [I32]], ["w8", [I32, I32], []], ["w16", [I32, I32], []], ["w32", [I32, I32], []]]
    .map(([name, params, results]) => ({ mod: "env", name, params, results }));
  const bytes = buildModule({ imports, memPages: (LOW >>> 16) + 2, funcs: blocks.map(b => ({ name: `b${b.start.toString(16)}`, params: [], results: [I32], locals: NLOC - 0, code: b.code })) });
  const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { env: { mem, r8: a => m.r8(a), r16: a => m.r16(a), r32: a => m.r32(a) | 0, w8: (a, v) => m.w8(a, v), w16: (a, v) => m.w16(a, v), w32: (a, v) => m.w32(a, v >>> 0) } });
  return blocks.map(b => inst.exports[`b${b.start.toString(16)}`]);
}
export const WASM_CTX = CTX;
