#!/usr/bin/env node
// x86-simd-selftest.mjs — checks the MMX/SSE instructions in x86-simd.mjs on hand-assembled code.
// usage: node x86-simd-selftest.mjs
import { X86 } from "../src/cpu/x86emu.mjs";

class Mem {
  constructor(n) { this.b = Buffer.alloc(n); }
  r8(a) { return this.b[a]; } r16(a) { return this.b.readUInt16LE(a); } r32(a) { return this.b.readUInt32LE(a); }
  w8(a, v) { this.b[a] = v & 0xff; } w16(a, v) { this.b.writeUInt16LE(v & 0xffff, a); } w32(a, v) { this.b.writeUInt32LE(v >>> 0, a); }
}
const CODE = 0x1000, SRC = 0x2000, DST = 0x3000, STACK = 0x8000;
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };
// run one instruction sequence (array of byte arrays) with the given memory setup; returns the cpu
function run(insns, setup = () => {}) {
  const m = new Mem(0x10000), c = new X86(m);
  setup(m, c);
  const bytes = [...insns.flat(), 0xc3]; bytes.forEach((b, i) => m.w8(CODE + i, b));
  c.r[4] = STACK; c.r[6] = SRC; c.r[7] = DST;
  c.call(CODE);
  return { c, m };
}
const f32s = (m, a, v) => v.forEach((x, i) => { const d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, x, true); m.w32(a + i * 4, d.getUint32(0, true)); });
const rf32 = (m, a, n) => Array.from({ length: n }, (_, i) => { const d = new DataView(new ArrayBuffer(4)); d.setUint32(0, m.r32(a + i * 4), true); return d.getFloat32(0, true); });
const xf = (c, i) => [0, 1, 2, 3].map(k => c.xr(i).getFloat32(k * 4, true));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// vector math: (a * b + a), reversed with shufps, stored
{
  const { m } = run([[0x0f, 0x10, 0x06], [0x0f, 0x28, 0xc8], [0x0f, 0x59, 0x4e, 0x10], [0x0f, 0x58, 0xc8], [0x0f, 0xc6, 0xc9, 0x1b], [0x0f, 0x11, 0x0f]],
    m => { f32s(m, SRC, [1, 2, 3, 4]); f32s(m, SRC + 16, [10, 20, 30, 40]); });
  const out = rf32(m, DST, 4); check(eq(out, [164, 93, 42, 11]), `movups/movaps/mulps/addps/shufps: ${out}`);
}
// scalar: movss load (zeroes the rest), mulss, cvtss2si (round to nearest even), cvttss2si, comiss flags
{
  const { c } = run([[0xf3, 0x0f, 0x10, 0x16], [0xf3, 0x0f, 0x59, 0x56, 0x04], [0xf3, 0x0f, 0x2d, 0xc2], [0xf3, 0x0f, 0x2c, 0xda], [0x0f, 0x2f, 0x56, 0x08]],
    m => f32s(m, SRC, [2.5, 1, 3]));
  check(c.r[0] === 2 && c.r[3] === 2 && eq(xf(c, 2), [2.5, 0, 0, 0]) && (c.flags & 1) === 1 && !(c.flags & 0x40), `movss/mulss/cvtss2si/cvttss2si/comiss: eax ${c.r[0]} ebx ${c.r[3]} xmm2 ${xf(c, 2)} flags ${c.flags.toString(16)}`);
}
// cmpltps + movmskps, andps/xorps, minps/maxps, unpcklps, movlhps/movhlps, rcpps
{
  const { c } = run([[0x0f, 0x10, 0x1e], [0x0f, 0x10, 0x66, 0x10], [0x0f, 0x28, 0xeb], [0x0f, 0xc2, 0xdc, 0x01], [0x0f, 0x50, 0xc3],
    [0x0f, 0x28, 0xf5], [0x0f, 0x5d, 0xf4], [0x0f, 0x28, 0xfd], [0x0f, 0x5f, 0xfc], [0x0f, 0x28, 0xc5], [0x0f, 0x14, 0xc4], [0x0f, 0x28, 0xcd], [0x0f, 0x16, 0xcc], [0x0f, 0x12, 0xcc]],
    m => { f32s(m, SRC, [1, 5, -2, 8]); f32s(m, SRC + 16, [3, 4, -1, 9]); });
  check(c.r[0] === 0b1101, `cmpltps/movmskps: mask ${c.r[0].toString(2)}`);
  check(eq(xf(c, 6), [1, 4, -2, 8]) && eq(xf(c, 7), [3, 5, -1, 9]), `minps/maxps: ${xf(c, 6)} | ${xf(c, 7)}`);
  check(eq(xf(c, 0), [1, 3, 5, 4]), `unpcklps: ${xf(c, 0)}`);
  check(eq(xf(c, 1), [-1, 9, 3, 4]), `movlhps then movhlps: ${xf(c, 1)}`);
}
// movlps/movhps memory forms, ldmxcsr round-down then cvtss2si, xorps zeroing
{
  const { c, m } = run([[0x0f, 0x57, 0xc0], [0x0f, 0x12, 0x06], [0x0f, 0x16, 0x46, 0x08], [0x0f, 0x13, 0x47, 0x00], [0x0f, 0xae, 0x56, 0x10], [0xf3, 0x0f, 0x2d, 0xc0], [0x0f, 0xae, 0x5f, 0x20], [0x0f, 0xae, 0xf8]],
    m => { f32s(m, SRC, [-1.5, 2, 3, 4]); m.w32(SRC + 16, 0x1f80 | (1 << 13)); });
  check(eq(xf(c, 0), [-1.5, 2, 3, 4]) && eq(rf32(m, DST, 2), [-1.5, 2]) && (c.r[0] | 0) === -2 && m.r32(DST + 0x20) === (0x1f80 | 0x2000), `movlps/movhps/ldmxcsr/stmxcsr/sfence: ${xf(c, 0)} eax ${c.r[0] | 0}`);
}
// MMX: movq, paddusb (saturating), punpcklbw, pmaddwd, psrlq, packuswb, movd, pshufw, pextrw, emms
{
  const { c, m } = run([[0x0f, 0x6f, 0x06], [0x0f, 0xdc, 0x46, 0x08], [0x0f, 0x7f, 0x07], [0x0f, 0xef, 0xd2], [0x0f, 0x6f, 0x0e], [0x0f, 0x60, 0xca],
    [0x0f, 0x6f, 0x5e, 0x10], [0x0f, 0xf5, 0x5e, 0x18], [0x0f, 0x6f, 0x26], [0x0f, 0x73, 0xd4, 0x08], [0x0f, 0x7e, 0xe0], [0x0f, 0x6f, 0x6e, 0x20], [0x0f, 0x67, 0xed],
    [0x0f, 0x70, 0xf3, 0x1b], [0x0f, 0xc5, 0xde, 0x01], [0x0f, 0x77]],
    m => { [0x10, 0xf0, 3, 4, 5, 6, 7, 0xff].forEach((b, i) => m.w8(SRC + i, b)); [0x20, 0x20, 1, 1, 1, 1, 1, 1].forEach((b, i) => m.w8(SRC + 8 + i, b));
      [1, 2, 3, 4].forEach((w, i) => m.w16(SRC + 0x10 + i * 2, w)); [10, 20, 30, 40].forEach((w, i) => m.w16(SRC + 0x18 + i * 2, w)); [300, -5, 100, 255].forEach((w, i) => m.w16(SRC + 0x20 + i * 2, w)); });
  check(eq([...Array(8)].map((_, i) => m.r8(DST + i)), [0x30, 0xff, 4, 5, 6, 7, 8, 0xff]), `movq/paddusb: ${[...Array(8)].map((_, i) => m.r8(DST + i).toString(16))}`);
  check(c.mr(1).getUint16(0, true) === 0x10 && c.mr(1).getUint16(2, true) === 0xf0, `punpcklbw: ${c.mr(1).getUint32(0, true).toString(16)}`);
  check(c.mr(3).getInt32(0, true) === 50 && c.mr(3).getInt32(4, true) === 250, `pmaddwd: ${c.mr(3).getInt32(0, true)}, ${c.mr(3).getInt32(4, true)}`);
  check(c.r[0] === 0x050403f0, `psrlq/movd: eax ${c.r[0].toString(16)}`);
  check(c.mr(5).getUint32(0, true) === 0xff6400ff, `packuswb: ${c.mr(5).getUint32(0, true).toString(16)}`);
  check(c.mr(6).getUint16(0, true) === 0 && c.mr(6).getUint16(2, true) === 250 && c.r[3] === 250, `pshufw/pextrw: ${c.mr(6).getUint16(0, true)} ebx ${c.r[3]}`);
}
// thread contexts carry the SIMD registers
{
  const m = new Mem(0x10000), c = new X86(m); c.xr(3).setFloat32(0, 7, true); const s = c.saveCtx(); c.xr(3).setFloat32(0, 0, true); c.loadCtx(s);
  check(c.xr(3).getFloat32(0, true) === 7, "saveCtx/loadCtx keep XMM state");
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
