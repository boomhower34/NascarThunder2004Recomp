// recomp.mjs — static recompilation of the game's x86 functions to C, compiled by clang into one WebAssembly module
// (recomp.wasm + recomp.json) that wasm-jit.mjs plugs into its dispatcher.
//
// Why: the block translators (x86-jit.mjs, wasm-jit.mjs) see one block at a time: registers go back to memory at
// every block end and flags are computed for every exit. Here a whole function is one C function: registers and
// XMM registers are local variables, flags a local whose dead computations the compiler removes, and clang -O2
// optimises across the function's blocks (SSE packed maths -> WebAssembly SIMD f32x4).
//
// Semantics are the interpreter's (x86emu.mjs / x86-simd.mjs), bit for bit: flags as alu / shift / group3, float
// results through the interpreter's conversions (NaNs keep sign and payload, as V8's DataView / Float64Array do;
// rsqrt / rcp exact in double), memory through the same page flags as wasm-jit (window / mirror / imported call).
//
// Contract with the dispatcher (wasm-jit.mjs run): an entry is a WebAssembly function () -> next eip, registered for
// an address in MAP with NTAB 64 (the longest block), and it stores the number of instructions it ran at CTX+36. It
// may run as many instructions as the dispatcher has left (CTX+0x1C0): every block starts with a budget check and
// leaves (registers written back) at its own address when it would cross it, so scheduler ticks land on exactly the
// same instruction as in the interpreter. Every block start is an entry (resume point). Anything not translated — an unsupported
// instruction, a call through a pointer, a call to a function that is not recompiled or not enabled, a jump outside
// the function — leaves to the dispatcher with eip at that point; the instruction after an unsupported one is a
// resume point. Direct calls between recompiled functions are C calls (registers written back before, read again
// after); a function returns the eip its ret popped, and the caller continues only when that is its return address.
// Each function has an enable byte (EN, written by wasm-jit.mjs): disabled when one of its instruction addresses is
// hooked; calls to a disabled function leave to the dispatcher.
//
// Usage: node recomp.mjs [--top N]   (functions from recomp-samples.json, hottest first; default all sampled)
import fs from "node:fs"; import os from "node:os"; import { execFileSync } from "node:child_process"; import { dirname, join } from "node:path"; import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
export const LOW = 0x10000000, CTX = LOW + 0x10000;
export const RC_BASE = LOW + 0x1060000, RC_PAGES = 64, EN_ADDR = RC_BASE + 0x3f0000;   // data / stack of recomp.wasm; enable bytes
const MAX_RUN = 255, MAX_BLOCK = 64;

// ---------------------------------------------------------------- image
export function loadImage(path = join(HERE, "default.exe")) {
  const b = fs.readFileSync(path);
  const pe = b.readUInt32LE(0x3c), nsec = b.readUInt16LE(pe + 6), opt = pe + 24, optsz = b.readUInt16LE(pe + 20);
  const BASE = b.readUInt32LE(opt + 28), ENTRY = BASE + b.readUInt32LE(opt + 16);
  const secs = []; for (let i = 0; i < nsec; i++) { const o = opt + optsz + i * 40; secs.push({ name: b.toString("latin1", o, o + 8).replace(/\0+$/, ""), va: BASE + b.readUInt32LE(o + 12), vs: b.readUInt32LE(o + 8), raw: b.readUInt32LE(o + 20), rs: b.readUInt32LE(o + 16) }); }
  const SIZE = Math.max(...secs.map(s => s.va + s.vs)) - BASE, img = new Uint8Array(SIZE);
  for (const s of secs) img.set(b.subarray(s.raw, s.raw + Math.min(s.rs, s.vs)), s.va - BASE);
  const code = [".text", "D3D", "D3DX", "XGRPH", "DSOUND", "WMADEC", "XPP"].map(n => secs.find(s => s.name === n));
  return { BASE, ENTRY, SIZE, img, secs, code, hash: createHash("sha256").update(b).digest("hex").slice(0, 16),
    isCode: a => code.some(s => a >= s.va && a < s.va + s.vs), r8: a => img[a - BASE], r16: a => img[a - BASE] | img[a - BASE + 1] << 8,
    r32: a => (img[a - BASE] | img[a - BASE + 1] << 8 | img[a - BASE + 2] << 16 | img[a - BASE + 3] << 24) >>> 0 };
}

// ---------------------------------------------------------------- C runtime (prelude)
// (no headers: the integer types from clang's own predefined macros, so the compiler bundled with a release needs no
// include files at all; the WebAssembly build compiles with -nostdinc)
const PRELUDE = `typedef __INT8_TYPE__ int8_t; typedef __INT16_TYPE__ int16_t; typedef __INT32_TYPE__ int32_t; typedef __INT64_TYPE__ int64_t;
typedef __UINT8_TYPE__ uint8_t; typedef __UINT16_TYPE__ uint16_t; typedef __UINT32_TYPE__ uint32_t; typedef __UINT64_TYPE__ uint64_t;
typedef __INTPTR_TYPE__ intptr_t; typedef __UINTPTR_TYPE__ uintptr_t;
typedef float f4 __attribute__((vector_size(16)));
typedef uint32_t u4 __attribute__((vector_size(16)));
typedef int32_t i4 __attribute__((vector_size(16)));
#define IMP(n) __attribute__((import_module("env"), import_name(#n)))
IMP(r8) uint32_t imp_r8(uint32_t); IMP(r16) uint32_t imp_r16(uint32_t); IMP(r32) uint32_t imp_r32(uint32_t);
IMP(divzero) void imp_divzero(uint32_t);
IMP(hook) uint32_t imp_hook(uint32_t, uint32_t);
/* x87 transcendental / remainder ops and cvtss2si (MXCSR rounding) in JavaScript, exactly as x86emu computes them */
IMP(fm) double imp_fm(uint32_t, double, double);
IMP(cvt) uint32_t imp_cvt(float);
#define HT ((volatile uint8_t*)(uintptr_t)(ENA - 0x20000))   /* hooked call targets (recomp.json ext; set by wasm-jit.mjs) */
#ifdef RC_NOTE
IMP(note) void imp_note(uint32_t, uint32_t);
#define NOTE(k, t) imp_note(k, t)
#else
#define NOTE(k, t)
#endif
IMP(w8) void imp_w8(uint32_t, uint32_t); IMP(w16) void imp_w16(uint32_t, uint32_t); IMP(w32) void imp_w32(uint32_t, uint32_t);
#define OKB ${LOW >>> 0}u
#define CTXA ${CTX >>> 0}u
#define XMMA ${(CTX + 0x100) >>> 0}u
#define ENA ${EN_ADDR >>> 0}u
#ifndef RC_CAP
#define RC_CAP 0u
#endif
extern uint32_t G_cnt, G_exit, G_nf, G_lim;   /* G_lim: steps this entry may run (the dispatcher's budget); defined in unit 0 */
#define NATIVE ((volatile uint8_t*)(uintptr_t)(ENA - 512))   /* [0]: 0x1803A8 is gamecode's _ftol hook (set by wasm-jit.mjs) */
#define STATS ((volatile double*)(uintptr_t)(ENA - 16))
#define WHYS ((volatile double*)(uintptr_t)(ENA - 256))   /* exits by reason (tests): 0 budget 1 unsupported 2 call via pointer 3 call to a function not recompiled 4 jmp via pointer 5 jump table miss 6 jump out of the function 7 other; [8] returns to the dispatcher; [9] a hook changed the course; [10] hooks run in place */
#define WHY(k) (WHYS[k] += 1)
#ifdef RC_COUNT
#define CC(k) (WHYS[k] += 1)   /* (tests) 13 direct calls between recompiled functions, 14 calls through call_any */
#else
#define CC(k)
#endif   /* instructions run in recompiled code, entries (read by tests) */
#define AI inline __attribute__((always_inline))   /* memory and flag helpers: inlined even in very large functions */
static u4 ld128_s(uint32_t a); static void st128_s(uint32_t a, u4 v);
#define FAST(a, lim, k) uint32_t k = *(const uint8_t*)(uintptr_t)(OKB + ((a) >> 16)); if (__builtin_expect(k != 0 && ((a) & 0xffff) <= (lim), 1))   /* not volatile: the page table changes only in JavaScript (inside an import call), so clang may reuse a check */
static AI uint32_t ld32(uint32_t a) { FAST(a, 0xfffc, k) { uint32_t v; __builtin_memcpy(&v, (void*)(uintptr_t)(a ^ ((k & 2u) << 30)), 4); return v; } return imp_r32(a); }
static AI uint32_t ld16(uint32_t a) { FAST(a, 0xfffe, k) { uint16_t v; __builtin_memcpy(&v, (void*)(uintptr_t)(a ^ ((k & 2u) << 30)), 2); return v; } return imp_r16(a); }
static AI uint32_t ld8(uint32_t a) { FAST(a, 0xffff, k) { return *(uint8_t*)(uintptr_t)(a ^ ((k & 2u) << 30)); } return imp_r8(a); }
static AI void st32(uint32_t a, uint32_t v) { FAST(a, 0xfffc, k) { __builtin_memcpy((void*)(uintptr_t)(a ^ ((k & 2u) << 30)), &v, 4); return; } imp_w32(a, v); }
static AI void st16(uint32_t a, uint32_t v) { FAST(a, 0xfffe, k) { uint16_t w = (uint16_t)v; __builtin_memcpy((void*)(uintptr_t)(a ^ ((k & 2u) << 30)), &w, 2); return; } imp_w16(a, v & 0xffff); }
static AI void st8(uint32_t a, uint32_t v) { FAST(a, 0xffff, k) { *(uint8_t*)(uintptr_t)(a ^ ((k & 2u) << 30)) = (uint8_t)v; return; } imp_w8(a, v & 0xff); }
static AI u4 ld128(uint32_t a) { FAST(a, 0xfff0, k) { u4 v; __builtin_memcpy(&v, (void*)(uintptr_t)(a ^ ((k & 2u) << 30)), 16); return v; } return ld128_s(a); }
static __attribute__((noinline)) u4 ld128_s(uint32_t a) { u4 v; v[0] = ld32(a); v[1] = ld32(a + 4); v[2] = ld32(a + 8); v[3] = ld32(a + 12); return v; }
static AI void st128(uint32_t a, u4 v) { FAST(a, 0xfff0, k) { __builtin_memcpy((void*)(uintptr_t)(a ^ ((k & 2u) << 30)), &v, 16); return; } st128_s(a, v); }
static __attribute__((noinline)) void st128_s(uint32_t a, u4 v) { st32(a, v[0]); st32(a + 4, v[1]); st32(a + 8, v[2]); st32(a + 12, v[3]); }
/* D3D state setters run natively at the call site (wasm-jit sets NHT[k] = id | stack bytes << 8 for a hooked call
   target whose JavaScript hook says it is one of these; d3d-hle.mjs shareState reads the same state block NST).
   0 = not handled here (unusual arguments): the JavaScript hook runs instead, so the result is always the hook's.
   NST words: 0-31 stream sources (vb, stride) x16, 32-35 palettes, 36/37 vertex constant dirty range, 64-831 vertex
   shader constants, 832-959 pixel shader constants (float bits). */
extern uint32_t NST[];
#define NHT ((volatile uint16_t*)(uintptr_t)(ENA - 0x10000))
static __attribute__((noinline)) uint32_t vsc_n(int32_t reg, uint32_t p, uint32_t dw) {
  if (dw == 0 || dw > 768 || (p & 3) || p > 0xffffffffu - dw * 4) return 0;
  int64_t j0 = (((int64_t)reg * 4) % 768 + 768) % 768; if (j0 + dw > 768) return 0;
  for (uint32_t a = p & ~0xffffu; a < p + dw * 4; a += 0x10000) { uint32_t k = *(const uint8_t*)(uintptr_t)(OKB + (a >> 16)); if (k != 1) return 0; if (a >= 0xffff0000u) break; }
  for (uint32_t i = 0; i < dw; i++) { uint32_t v = ld32(p + i * 4); NST[64 + j0 + i] = v; st32(0x19bf50u + (uint32_t)(j0 + i) * 4, v); }
  int32_t *D = (int32_t*)NST; int32_t lo = (int32_t)(j0 >> 2), hi = (int32_t)(((j0 + dw - 1) >> 2) + 1);
  if (lo < D[36]) D[36] = lo; if (hi > D[37]) D[37] = hi; return 1; }
static __attribute__((noinline)) uint32_t nhook(uint32_t v, uint32_t ecx, uint32_t edx, uint32_t esp) {
  switch (v & 0xff) {
    case 1: { uint32_t i = ld32(esp + 4); if (i >= 16) return 0; NST[2 * i] = ld32(esp + 8); NST[2 * i + 1] = ld32(esp + 12); return 1; }   /* SetStreamSource */
    case 2: NST[32 + (ld32(esp + 4) & 3)] = ld32(esp + 8); return 1;                                                                   /* SetPalette */
    case 3: return vsc_n((int32_t)ecx, edx, 16);                                                                                        /* SetVertexShaderConstant4 */
    case 4: return vsc_n((int32_t)ecx, edx, 4);                                                                                         /* SetVertexShaderConstant1(Fast) */
    case 5: return vsc_n((int32_t)ecx, edx, ld32(esp + 4));                                                                             /* SetVertexShaderConstantNotInline(Fast) */
    case 6: { uint32_t reg = ld32(esp + 4), p = ld32(esp + 8), n = ld32(esp + 12); if (n > 32 || p > 0xffffffffu - n * 16) return 0;     /* SetPixelShaderConstant */
      for (uint32_t i = 0; i < n * 4; i++) NST[832 + (uint32_t)(((uint64_t)reg * 4 + i) % 128)] = ld32(p + i * 4); return 1; }
  }
  return 0; }
// flags (x86emu alu / szp): CF 1, PF 4, ZF 0x40, SF 0x80, OF 0x800
#define FM 0x8c5u
static AI uint32_t szp(uint32_t f, uint32_t r, uint32_t s) { return (f & ~0xc4u) | (r ? 0 : 0x40u) | ((r & s) ? 0x80u : 0) | ((__builtin_popcount(r & 0xff) & 1) ? 0 : 4u); }
static AI uint32_t f_add(uint32_t f, uint32_t a, uint32_t b, uint32_t r, uint32_t m, uint32_t s) { a &= m; b &= m; r &= m; f = szp(f, r, s) & ~0x801u; if ((uint64_t)a + b > m) f |= 1; if (~(a ^ b) & (a ^ r) & s) f |= 0x800; return f; }
static AI uint32_t f_adc(uint32_t f, uint32_t a, uint32_t b, uint32_t c, uint32_t r, uint32_t m, uint32_t s) { a &= m; b &= m; r &= m; f = szp(f, r, s) & ~0x801u; if ((uint64_t)a + b + c > m) f |= 1; if (~(a ^ b) & (a ^ r) & s) f |= 0x800; return f; }
static AI uint32_t f_sub(uint32_t f, uint32_t a, uint32_t b, uint32_t r, uint32_t m, uint32_t s) { a &= m; b &= m; r &= m; f = szp(f, r, s) & ~0x801u; if (a < b) f |= 1; if ((a ^ b) & (a ^ r) & s) f |= 0x800; return f; }
static AI uint32_t f_sbb(uint32_t f, uint32_t a, uint32_t b, uint32_t c, uint32_t r, uint32_t m, uint32_t s) { a &= m; b &= m; r &= m; f = szp(f, r, s) & ~0x801u; if ((uint64_t)a < (uint64_t)b + c) f |= 1; if ((a ^ b) & (a ^ r) & s) f |= 0x800; return f; }
static AI uint32_t f_logic(uint32_t f, uint32_t r, uint32_t m, uint32_t s) { return szp(f, r & m, s) & ~0x801u; }
static AI uint32_t f_inc(uint32_t f, uint32_t a, uint32_t r, uint32_t m, uint32_t s) { uint32_t c = f & 1; a &= m; r &= m; f = szp(f, r, s) & ~0x801u; if (~(a ^ 1) & (a ^ r) & s) f |= 0x800; return f | c; }
static AI uint32_t f_dec(uint32_t f, uint32_t a, uint32_t r, uint32_t m, uint32_t s) { uint32_t c = f & 1; a &= m; r &= m; f = szp(f, r, s) & ~0x801u; if ((a ^ 1) & (a ^ r) & s) f |= 0x800; return f | c; }
// x86emu shift(kind, v, n, s) with n = count & 31, n != 0; *pf: flags
static inline uint32_t shiftop(uint32_t *pf, uint32_t kind, uint32_t v, uint32_t n, uint32_t s) {
  uint32_t mask = s == 32 ? 0xffffffffu : (1u << s) - 1, top = 1u << (s - 1), res, cf, f = *pf;
  switch (kind) {
    case 0: { uint32_t k = n % s; res = k ? ((v << k) | (v >> (s - k))) & mask : v; *pf = (f & ~1u) | (res & 1); return res; }
    case 1: { uint32_t k = n % s; res = k ? ((v >> k) | (v << (s - k))) & mask : v; *pf = (f & ~1u) | ((res & top) ? 1 : 0); return res; }
    case 4: case 6: cf = n <= s ? (v >> (s - n)) & 1 : 0; res = (v << n) & mask; break;
    case 5: cf = (v >> (n - 1)) & 1; res = (v >> n) & mask; break;
    default: { int32_t sv = s == 32 ? (int32_t)v : ((int32_t)(v << (32 - s))) >> (32 - s); cf = (uint32_t)(sv >> (n - 1)) & 1; res = (uint32_t)(sv >> n) & mask; break; }
  }
  f = szp(f, res, top) & ~0x801u; f |= cf;
  if (n == 1 && kind == 4 && (((res & top) != 0) != (cf != 0))) f |= 0x800;
  if (n == 1 && kind == 5 && (v & top)) f |= 0x800;
  *pf = f; return res;
}
// floats: plain bit casts. The interpreter's DataView / Float64Array paths keep a NaN's sign and payload (V8 uses the
// same SSE conversions as WebAssembly here), so nothing is normalised (a game table of 0xFFC00000 NaNs showed it)
// LLVM treats a NaN's sign as unspecified and moves negations across arithmetic (-(a / b) -> (-a) / b: 0/0 then
// gives the other NaN sign than the interpreter). Sign operations go through this barrier so they stay where they are.
#define BAR(x) __asm__ volatile("" : "+r"(x))
// (the same for a 128-bit vector, through memory: LLVM 19's WebAssembly backend aborts on a v128 "r" operand -
// "Do not know how to split this operator's operand" - where LLVM 18 accepted it)
#define VBAR(x) __asm__ volatile("" : "+m"(x))
// It also commutes adds and multiplies. When both operands are NaNs the operand order decides which NaN survives:
// WebAssembly keeps the first operand's for every operation, the interpreter (JavaScript: V8 swaps commutative
// operands) keeps the second operand's for + and * and the first one's for - and / (measured). So + and * are
// emitted with their operands swapped (the same value otherwise), - and / in order.
#define ORDOP(name, T, ins) static inline T name(T a, T b) { T r; __asm__("local.get %1\\n\\tlocal.get %2\\n\\t" ins "\\n\\tlocal.set %0" : "=r"(r) : "r"(a), "r"(b)); return r; }
#define SWOP(name, T, ins) static inline T name(T a, T b) { T r; __asm__("local.get %2\\n\\tlocal.get %1\\n\\t" ins "\\n\\tlocal.set %0" : "=r"(r) : "r"(a), "r"(b)); return r; }
SWOP(add_d, double, "f64.add") SWOP(mul_d, double, "f64.mul") SWOP(add_f, float, "f32.add") SWOP(mul_f, float, "f32.mul")
// The vector forms: one f32x4 instruction when the compiler takes a 128-bit inline-asm operand (RC_VASM, found by
// trying: LLVM 18 does), otherwise the same instruction lane by lane (LLVM 19's WebAssembly backend aborts on any
// v128 inline-asm operand: "Do not know how to split this operator's operand"); the result is the same either way.
#ifdef RC_VASM
SWOP(add_4, f4, "f32x4.add") SWOP(mul_4, f4, "f32x4.mul")
#else
static inline f4 add_4(f4 a, f4 b) { return (f4){ add_f(a[0], b[0]), add_f(a[1], b[1]), add_f(a[2], b[2]), add_f(a[3], b[3]) }; }
static inline f4 mul_4(f4 a, f4 b) { return (f4){ mul_f(a[0], b[0]), mul_f(a[1], b[1]), mul_f(a[2], b[2]), mul_f(a[3], b[3]) }; }
#endif
// and it folds arithmetic whose operands it can prove constant (stores forwarded to loads, often after inlining one
// recompiled function into another) with its own NaN rules (0/0 -> +NaN; the hardware gives -NaN). So every float
// operation that can create or pick a NaN is one of these opaque instructions.
ORDOP(sub_d, double, "f64.sub") ORDOP(div_d, double, "f64.div") ORDOP(sub_f, float, "f32.sub") ORDOP(div_f, float, "f32.div")
#ifdef RC_VASM
ORDOP(sub_4, f4, "f32x4.sub") ORDOP(div_4, f4, "f32x4.div")
#else
static inline f4 sub_4(f4 a, f4 b) { return (f4){ sub_f(a[0], b[0]), sub_f(a[1], b[1]), sub_f(a[2], b[2]), sub_f(a[3], b[3]) }; }
static inline f4 div_4(f4 a, f4 b) { return (f4){ div_f(a[0], b[0]), div_f(a[1], b[1]), div_f(a[2], b[2]), div_f(a[3], b[3]) }; }
#endif
#define ORDOP1(name, T, ins) static inline T name(T a) { T r; __asm__("local.get %1\\n\\t" ins "\\n\\tlocal.set %0" : "=r"(r) : "r"(a)); return r; }
ORDOP1(sqrt_d, double, "f64.sqrt") ORDOP1(sqrt_f, float, "f32.sqrt")

static AI uint32_t fbits(float x) { uint32_t u; __builtin_memcpy(&u, &x, 4); return u; }
static AI float ffl(uint32_t u) { float x; __builtin_memcpy(&x, &u, 4); return x; }
static AI u4 fcanon(f4 v) { return (u4)v; }
// x87 (x86emu.mjs x87 / st / fpush / fcmp / fround / rdI64 / wrI64): registers as f64 at CTX+64, top / status /
// control word in locals (CTX+44 / +48 / +52)
#define FPR ((double*)(uintptr_t)(CTXA + 64))
#define ST(i) FPR[(top + (i)) & 7]
#define FPUSH(v) do { double _v = (v); top = (top - 1) & 7; FPR[top] = _v; } while (0)
#define FPOP() (top = (top + 1) & 7)
static AI double dbits(uint64_t u) { double d; __builtin_memcpy(&d, &u, 8); return d; }
static AI double rdf32(uint32_t a) { return (double)ffl(ld32(a)); }
static AI double rdf64(uint32_t a) { uint64_t u = (uint64_t)ld32(a) | ((uint64_t)ld32(a + 4) << 32); return dbits(u); }
static AI void wrf32(uint32_t a, double v) { st32(a, fbits((float)v)); }
static AI void wrf64(uint32_t a, double v) { uint64_t u; __builtin_memcpy(&u, &v, 8); st32(a, (uint32_t)u); st32(a + 4, (uint32_t)(u >> 32)); }
static AI double rdi64(uint32_t a) { uint32_t lo = ld32(a), hi = ld32(a + 4); return (double)lo + (double)hi * 4294967296.0 - ((hi & 0x80000000u) ? 18446744073709551616.0 : 0.0); }
static inline uint64_t jsmod64(double t) {      /* integer-valued, finite t -> t mod 2^64 (two's complement) */
  if (__builtin_fabs(t) < 9223372036854775808.0) return (uint64_t)(int64_t)t;
  uint64_t b; __builtin_memcpy(&b, &t, 8); int e = (int)((b >> 52) & 0x7ff) - 1075; uint64_t mant = (b & ((1ull << 52) - 1)) | (1ull << 52);
  uint64_t lo = e >= 64 ? 0 : mant << e; return (b >> 63) ? 0 - lo : lo; }
static inline uint32_t jstoint32(double v) {   /* ECMAScript ToInt32 / ToUint32 */
  if (v != v || __builtin_isinf(v)) return 0; return (uint32_t)jsmod64(__builtin_trunc(v)); }
static inline void wri64(uint32_t a, double v) { if (v != v || __builtin_isinf(v)) v = -9223372036854775808.0; uint64_t u = jsmod64(__builtin_trunc(v)); st32(a, (uint32_t)u); st32(a + 4, (uint32_t)(u >> 32)); }
static inline double jround(double v) {        /* Math.round */
  if (v != v || v == 0 || __builtin_isinf(v)) return v; double f = __builtin_floor(v); if (v - f >= 0.5) f += 1.0; if (f == 0 && v < 0) return -0.0; return f; }
static inline double fround_(double v, uint32_t fcw) {
  switch ((fcw >> 10) & 3) {
    case 0: { double r = jround(v); double fr = v - __builtin_trunc(v); double m = r - 2.0 * __builtin_trunc(r / 2.0);
      if (__builtin_fabs(fr) == 0.5 && m != 0 && m == m) r = r - (v > 0 ? 1.0 : -1.0); return r; }
    case 1: return __builtin_floor(v); case 2: return __builtin_ceil(v); default: return __builtin_trunc(v); } }
static AI uint32_t fcmp_(uint32_t fsw, double a, double b) { uint32_t c = 0; if (a != a || b != b) c = 0x4500; else if (a < b) c = 0x100; else if (a == b) c = 0x4000; return (fsw & ~0x4700u) | c; }
static AI uint32_t fcomi_(uint32_t f, double a, double b) { f &= ~0x8c5u; if (a != a || b != b) f |= 0x45; else if (a < b) f |= 1; else if (a == b) f |= 0x40; return f; }
static AI uint32_t fist32(double v) { return (v >= 2147483648.0 || v < -2147483648.0 || v != v) ? 0x80000000u : (uint32_t)(int32_t)v; }
static inline double farith_(int op, double a, double b) { switch (op) { case 0: return add_d(a, b); case 1: return mul_d(a, b); case 4: return sub_d(a, b); case 5: return sub_d(b, a); case 6: return div_d(a, b); default: return div_d(b, a); } }
#define MMR(i) ((uint32_t*)(uintptr_t)(CTXA + 0x180 + (i) * 8))
static AI int32_t toi32(double v) { return (v == v && v >= -2147483648.0 && v <= 2147483647.0) ? (int32_t)v : (int32_t)0x80000000; }
`;

// ---------------------------------------------------------------- native build (recomp.mjs --native)
// The same C compiled for the machine itself (recomp-native.c: the Node add-on glue). Differences from the
// WebAssembly build, all in the text: memory is MB + address (MB: the emulator memory's bytes, set by the add-on)
// instead of the linear memory's own addressing; imports are function pointers the add-on fills in; the state block
// NST sits at a fixed address of that memory (JavaScript reads it there, d3d shareState); and the float operations
// whose NaN choice depends on operand order are SSE instructions in the same order as V8's WebAssembly code on x86-64
// (first operand's NaN wins), so results stay bit for bit the WebAssembly build's.
export const NSTA = RC_BASE + 0x1000;
const X86OP = { "f64.add": "addsd", "f64.mul": "mulsd", "f32.add": "addss", "f32.mul": "mulss", "f32x4.add": "addps", "f32x4.mul": "mulps",
  "f64.sub": "subsd", "f64.div": "divsd", "f32.sub": "subss", "f32.div": "divss", "f32x4.sub": "subps", "f32x4.div": "divps", "f64.sqrt": "sqrtsd", "f32.sqrt": "sqrtss" };
function nativePrelude(pre) {
  let t = pre.replace(/^#define IMP\(n\).*$/m, "")
    .replace(/IMP\((\w+)\) ([\w ]+?) (imp_\w+)\(([^)]*)\);/g, "extern $2 (*$3)($4);")
    .replace(/^#define BAR\(x\).*$/m, `#define BAR(x) __asm__ volatile("" : "+m"(x))`)
    .replace(/^#define ORDOP\(name, T, ins\).*$/m, `#define ORDOP(name, T, ins) static inline T name(T a, T b) { T r; __asm__(ins " %2, %0" : "=x"(r) : "0"(a), "x"(b)); return r; }`)
    .replace(/^#define SWOP\(name, T, ins\).*$/m, `#define SWOP(name, T, ins) static inline T name(T a, T b) { T r; __asm__(ins " %2, %0" : "=x"(r) : "0"(b), "x"(a)); return r; }`)
    .replace(/^#define ORDOP1\(name, T, ins\).*$/m, `#define ORDOP1(name, T, ins) static inline T name(T a) { T r; __asm__(ins " %1, %0" : "=x"(r) : "x"(a)); return r; }`)
    .replace(/"(f64|f32|f32x4)\.(add|mul|sub|div|sqrt)"/g, (m, a, b) => `"${X86OP[`${a}.${b}`]}"`)
    .replace(/^extern uint32_t NST\[\];$/m, `#define NSTA ${NSTA >>> 0}u\n#define NST ((uint32_t*)(MB + NSTA))`);
  return `#include <stdint.h>\n#define RC_VASM 1\nextern uintptr_t MB;\n` + t;
}
// (T*)(uintptr_t)X and (T*)CONST -> ((T*)(MB + (uintptr_t)(X))): every address the C code makes from a number
export function nativize(src) {
  const CONSTS = new Set(["ENA", "CTXA", "OKB", "XMMA"]);
  const re = /\(((?:const |volatile )*\w+ ?\*)\)(\(uintptr_t\))?/g; let out = "", last = 0, m;
  while ((m = re.exec(src))) {
    let p = m.index + m[0].length, op = null;
    if (src[p] === "(") { let d = 0, q = p; for (; q < src.length; q++) { if (src[q] === "(") d++; else if (src[q] === ")" && --d === 0) break; } op = src.slice(p, q + 1); }
    else { const t = /^[A-Za-z_0-9]+/.exec(src.slice(p)); if (t) op = t[0]; }
    if (!op || (!m[2] && !CONSTS.has(op))) continue;
    out += src.slice(last, m.index) + `((${m[1]})(MB + (uintptr_t)(${op})))`; last = p + op.length; re.lastIndex = last;
  }
  return out + src.slice(last);
}

// ---------------------------------------------------------------- decoding + C for one instruction
const REG = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"];
const MASK = { 8: "0xffu", 16: "0xffffu", 32: "0xffffffffu" }, SIGN = { 8: "0x80u", 16: "0x8000u", 32: "0x80000000u" };
const COND = [ "(fl & 0x800)", "!(fl & 0x800)", "(fl & 1)", "!(fl & 1)", "(fl & 0x40)", "!(fl & 0x40)", "(fl & 0x41)", "!(fl & 0x41)",
  "(fl & 0x80)", "!(fl & 0x80)", "(fl & 4)", "!(fl & 4)", "(!(fl & 0x80) != !(fl & 0x800))", "(!(fl & 0x80) == !(fl & 0x800))",
  "((fl & 0x40) || (!(fl & 0x80) != !(fl & 0x800)))", "(!(fl & 0x40) && (!(fl & 0x80) == !(fl & 0x800)))" ];
const hex = v => "0x" + (v >>> 0).toString(16) + "u";

// One instruction at `at`. Returns { len, c: [C lines], kind, target?, table?, fallthrough } or { len, kind: "unsupported", why }.
// kind: "seq" | "jcc" (cond, target) | "jmp" (target) | "call" (target, retaddr) | "callind" (C expr of target)
//       | "ret" (pop extra) | "jmpind" (expr) | "table" (base, idx expr) | "divcheck" (seq with a zero test)
export function decode(im, at) {
  let p = at, o16 = false, rep = 0, seg = false;
  for (;;) { const b = im.r8(p); if (b === 0x66) o16 = true; else if (b === 0xf3) rep = 1; else if (b === 0xf2) rep = 2; else if (b === 0x64 || b === 0x65) seg = true;
    else if (b === 0x2e || b === 0x3e || b === 0x26 || b === 0x36 || b === 0xf0) {} else break; p++; }
  const U = why => ({ len: null, kind: "unsupported", why });
  if (seg) return U("fs/gs segment");
  const op = im.r8(p++);
  const b8 = () => im.r8(p++), s8 = () => (im.r8(p++) << 24) >> 24, b16 = () => { const v = im.r16(p); p += 2; return v; }, b32 = () => { const v = im.r32(p); p += 4; return v; };
  const modrm = () => {
    const m = b8(), mod = m >> 6, reg = (m >> 3) & 7, rm = m & 7;
    if (mod === 3) return { reg, rm, mem: null };
    let base = null, idx = null, scale = 1, disp = 0;
    if (rm === 4) { const sib = b8(), ss = sib >> 6, ix = (sib >> 3) & 7, bs = sib & 7; if (ix !== 4) { idx = REG[ix]; scale = 1 << ss; } if (bs === 5 && mod === 0) disp = b32(); else base = REG[bs]; }
    else if (rm === 5 && mod === 0) disp = b32(); else base = REG[rm];
    if (mod === 1) disp = s8(); else if (mod === 2) disp = b32() | 0;
    const parts = []; if (base) parts.push(base); if (idx) parts.push(scale === 1 ? idx : `${idx} * ${scale}u`); if (disp || !parts.length) parts.push(hex(disp));
    return { reg, rm, mem: `(uint32_t)(${parts.join(" + ")})` };
  };
  const R = (i, s) => s === 32 ? REG[i] : s === 16 ? `(${REG[i]} & 0xffffu)` : i < 4 ? `(${REG[i]} & 0xffu)` : `((${REG[i - 4]} >> 8) & 0xffu)`;
  const W = (i, s, v) => s === 32 ? `${REG[i]} = ${v};` : s === 16 ? `${REG[i]} = (${REG[i]} & 0xffff0000u) | ((${v}) & 0xffffu);`
    : i < 4 ? `${REG[i]} = (${REG[i]} & 0xffffff00u) | ((${v}) & 0xffu);` : `${REG[i - 4]} = (${REG[i - 4]} & 0xffff00ffu) | (((${v}) & 0xffu) << 8);`;
  const LD = (a, s) => `ld${s}(${a})`, ST = (a, s, v) => `st${s}(${a}, ${v});`;
  const rd = (o, s) => o.mem ? LD("ea", s) : R(o.rm, s);
  const wr = (o, s, v) => o.mem ? ST("ea", s, v) : W(o.rm, s, v);
  const eaLine = o => o.mem ? [`ea = ${o.mem};`] : [];
  const done = (c, extra = {}) => ({ len: p - at, c, kind: "seq", ...extra });
  const sz = o16 ? 16 : 32;
  const alu = (k, dst, src, s, write) => {           // dst / src: C expressions (values); write(v): C line
    const M = MASK[s], S = SIGN[s], L = [`a = ${dst}; b = ${src};`];
    switch (k) {
      case 0: L.push(`t = (a + b) & ${M}; fl = f_add(fl, a, b, t, ${M}, ${S});`); break;
      case 1: L.push(`t = (a | b) & ${M}; fl = f_logic(fl, t, ${M}, ${S});`); break;
      case 2: L.push(`c = fl & 1; t = (a + b + c) & ${M}; fl = f_adc(fl, a, b, c, t, ${M}, ${S});`); break;
      case 3: L.push(`c = fl & 1; t = (a - b - c) & ${M}; fl = f_sbb(fl, a, b, c, t, ${M}, ${S});`); break;
      case 4: L.push(`t = (a & b) & ${M}; fl = f_logic(fl, t, ${M}, ${S});`); break;
      case 5: case 7: L.push(`t = (a - b) & ${M}; fl = f_sub(fl, a, b, t, ${M}, ${S});`); break;
      case 6: L.push(`t = (a ^ b) & ${M}; fl = f_logic(fl, t, ${M}, ${S});`); break;
    }
    if (k !== 7 && write) L.push(write("t"));
    return L;
  };

  // x87: C lines or null (x86emu x87(); anything it does not do, or does with transcendental functions, is left)
  function x87(op, o) {
    const reg = o.reg, i = o.rm, D = v => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, v, true); return `dbits(0x${b.getBigUint64(0, true).toString(16)}ull)`; };
    const arith = (k, a, b) => `farith_(${k}, ${a}, ${b})`;
    if (o.mem) switch (op) {
      case 0xd8: case 0xdc: case 0xda: case 0xde: {
        const v = op === 0xd8 ? "rdf32(ea)" : op === 0xdc ? "rdf64(ea)" : op === 0xda ? "(double)(int32_t)ld32(ea)" : "(double)(int16_t)ld16(ea)";
        if (reg === 2 || reg === 3) return [`fsw = fcmp_(fsw, ST(0), ${v});` + (reg === 3 ? " FPOP();" : "")];
        return [`ST(0) = ${arith(reg, "ST(0)", v)};`]; }
      case 0xd9: switch (reg) { case 0: return [`FPUSH(rdf32(ea));`]; case 2: return [`wrf32(ea, ST(0));`]; case 3: return [`wrf32(ea, ST(0)); FPOP();`];
        case 4: case 6: return []; case 5: return [`fcw = ld16(ea);`]; case 7: return [`st16(ea, fcw);`]; } return null;
      case 0xdb: switch (reg) { case 0: return [`FPUSH((double)(int32_t)ld32(ea));`];
        case 1: case 2: case 3: return [`st32(ea, fist32(${reg === 1 ? "__builtin_trunc(ST(0))" : "fround_(ST(0), fcw)"}));` + (reg !== 2 ? " FPOP();" : "")]; } return null;
      case 0xdd: switch (reg) { case 0: return [`FPUSH(rdf64(ea));`]; case 1: return [`{ double v = ST(0); FPOP(); wri64(ea, __builtin_trunc(v)); }`];
        case 2: return [`wrf64(ea, ST(0));`]; case 3: return [`wrf64(ea, ST(0)); FPOP();`]; case 4: case 6: return []; case 7: return [`st16(ea, fsw | (top << 11));`]; } return null;
      case 0xdf: switch (reg) { case 0: return [`FPUSH((double)(int16_t)ld16(ea));`];
        case 1: case 2: case 3: return [`st16(ea, jstoint32(${reg === 1 ? "__builtin_trunc(ST(0))" : "fround_(ST(0), fcw)"}) & 0xffffu);` + (reg !== 2 ? " FPOP();" : "")];
        case 5: return [`FPUSH(rdi64(ea));`]; case 7: return [`{ double v = ST(0); FPOP(); wri64(ea, fround_(v, fcw)); }`]; } return null;
      default: return null;
    }
    switch (op) {
      case 0xd8: if (reg === 2 || reg === 3) return [`fsw = fcmp_(fsw, ST(0), ST(${i}));` + (reg === 3 ? " FPOP();" : "")]; return [`ST(0) = ${arith(reg, "ST(0)", `ST(${i})`)};`];
      case 0xdc: if (reg >= 4) return [`ST(${i}) = ${arith(reg ^ 1, `ST(${i})`, "ST(0)")};`]; if (reg < 2) return [`ST(${i}) = ${arith(reg, `ST(${i})`, "ST(0)")};`]; return null;
      case 0xde: if (reg === 3 && i === 1) return [`fsw = fcmp_(fsw, ST(0), ST(1)); FPOP(); FPOP();`]; if (reg === 2 || reg === 3) return null;
        return [`ST(${i}) = ${arith(reg >= 4 ? reg ^ 1 : reg, `ST(${i})`, "ST(0)")}; FPOP();`];
      case 0xda: if (reg === 5 && i === 1) return [`fsw = fcmp_(fsw, ST(0), ST(1)); FPOP(); FPOP();`]; return null;
      case 0xdd: switch (reg) { case 0: return []; case 2: return [`ST(${i}) = ST(0);`]; case 3: return [`ST(${i}) = ST(0); FPOP();`];
        case 4: case 5: return [`fsw = fcmp_(fsw, ST(0), ST(${i}));` + (reg === 5 ? " FPOP();" : "")]; } return null;
      case 0xdb: if (reg === 4) return i === 2 ? [`fsw &= 0x7f00u;`] : []; if (reg === 5 || reg === 6) return [`fl = fcomi_(fl, ST(0), ST(${i}));`]; return null;
      case 0xdf: if (reg === 4 && i === 0) return [W(0, 16, "fsw | (top << 11)")]; if (reg === 5 || reg === 6) return [`fl = fcomi_(fl, ST(0), ST(${i})); FPOP();`]; return null;
      case 0xd9: switch (reg) {
        case 0: return [`FPUSH(ST(${i}));`]; case 1: return [`{ double t0 = ST(0); ST(0) = ST(${i}); ST(${i}) = t0; }`]; case 2: return [];
        case 4: switch (i) { case 0: return [`{ double v = ST(0); BAR(v); v = -v; BAR(v); ST(0) = v; }`]; case 1: return [`{ double v = ST(0); BAR(v); v = __builtin_fabs(v); BAR(v); ST(0) = v; }`]; case 4: return [`fsw = fcmp_(fsw, ST(0), 0.0);`];
          case 5: return [`{ double v = ST(0); uint64_t bv; __builtin_memcpy(&bv, &v, 8); fsw = (fsw & ~0x4700u) | (v != v ? 0x100u : v == 0 ? 0x4000u : __builtin_isinf(v) ? 0x500u : 0x400u) | ((v < 0 || (v == 0 && (bv >> 63))) ? 0x200u : 0); }`]; } return null;
        case 5: if (i === 7) return null; return [`FPUSH(${D([1, Math.log2(10), Math.LOG2E, Math.PI, Math.log10(2), Math.LN2, 0][i])});`];
        case 6: if (i === 6) return [`top = (top - 1) & 7;`]; if (i === 7) return [`top = (top + 1) & 7;`];
          if (i === 0) return [`ST(0) = imp_fm(5, ST(0), 0);`]; if (i === 1) return [`ST(1) = imp_fm(6, ST(1), ST(0)); FPOP();`];
          if (i === 2) return [`ST(0) = imp_fm(2, ST(0), 0); FPUSH(1.0);`]; if (i === 3) return [`ST(1) = imp_fm(1, ST(1), ST(0)); FPOP();`]; return null;
        case 7: if (i === 2) return [`ST(0) = sqrt_d(ST(0));`]; if (i === 4) return [`ST(0) = fround_(ST(0), fcw);`];
          if (i === 0) return [`ST(0) = imp_fm(0, ST(0), ST(1)); fsw &= ~0x400u;`]; if (i === 1) return [`ST(1) = imp_fm(8, ST(1), ST(0)); FPOP();`];
          if (i === 3) return [`{ double v = ST(0); ST(0) = imp_fm(3, v, 0); FPUSH(imp_fm(4, v, 0)); }`]; if (i === 5) return [`ST(0) = imp_fm(7, ST(0), ST(1));`];
          if (i === 6) return [`ST(0) = imp_fm(3, ST(0), 0);`]; if (i === 7) return [`ST(0) = imp_fm(4, ST(0), 0);`]; return null;
      } return null;
    }
    return null;
  }
  // string instructions (x86emu strop: the whole rep loop is one instruction; direction from DF)
  function strop(op, s, rep) {
    if (s === 16) return null;
    const n = s >> 3, d = `((fl & 0x400u) ? (uint32_t)-${n} : ${n}u)`, M = MASK[s], k = op & 0xfe;
    const one = { 0xa4: `st${s}(edi, ld${s}(esi)); esi += dd; edi += dd;`, 0xaa: `st${s}(edi, ${R(0, s)}); edi += dd;`, 0xac: `${W(0, s, `ld${s}(esi)`)} esi += dd;`,
      0xa6: `{ uint32_t a1 = ld${s}(esi), b1 = ld${s}(edi); t = (a1 - b1) & ${M}; fl = f_sub(fl, a1, b1, t, ${M}, ${SIGN[s]}); } esi += dd; edi += dd;`,
      0xae: `{ uint32_t a1 = ${R(0, s)}, b1 = ld${s}(edi); t = (a1 - b1) & ${M}; fl = f_sub(fl, a1, b1, t, ${M}, ${SIGN[s]}); } edi += dd;` }[k];
    if (!rep) return [`{ uint32_t dd = ${d}; ${one} }`];
    const cmp = k === 0xa6 || k === 0xae;
    return [`{ uint32_t dd = ${d}; while (ecx) { ${one} ecx--; ${cmp ? `if (${rep === 1 ? "!(fl & 0x40u)" : "(fl & 0x40u)"}) break; ` : ""}} }`];
  }

  // ---- one-byte opcodes
  if (op < 0x40 && (op & 7) < 6) {                  // ALU r/m, reg / reg, r/m / al|eax, imm
    const k = op >> 3, f = op & 7, s = f & 1 ? sz : 8;
    if (s === 16 && k !== 7 && k !== 4 && k !== 1 && k !== 6 && k !== 0 && k !== 5) return U("16-bit adc/sbb");
    if (f < 2) { const o = modrm(); return done([...eaLine(o), ...alu(k, rd(o, s), R(o.reg, s), s, v => wr(o, s, v))]); }
    if (f < 4) { const o = modrm(); return done([...eaLine(o), ...alu(k, R(o.reg, s), rd(o, s), s, v => W(o.reg, s, v))]); }
    const imm = s === 8 ? b8() : s === 16 ? b16() : b32();
    return done(alu(k, R(0, s), hex(imm), s, v => W(0, s, v)));
  }
  if (op >= 0x40 && op < 0x50) { const i = op & 7, dec = op >= 0x48;
    if (o16) return done([`a = ${REG[i]} & 0xffffu; t = (a ${dec ? "-" : "+"} 1u) & 0xffffu; fl = f_${dec ? "dec" : "inc"}(fl, a, t, 0xffffu, 0x8000u);`, W(i, 16, "t")]);
    return done([`a = ${REG[i]}; t = a ${dec ? "-" : "+"} 1u; fl = f_${dec ? "dec" : "inc"}(fl, a, t, 0xffffffffu, 0x80000000u); ${REG[i]} = t;`]); }
  if (op >= 0x50 && op < 0x58) { if (o16) return U("16-bit push"); return done([`t = ${REG[op & 7]}; esp -= 4; st32(esp, t);`]); }
  if (op >= 0x58 && op < 0x60) { if (o16) return U("16-bit pop"); const i = op & 7; return done(i === 4 ? [`esp = ld32(esp);`] : [`${REG[i]} = ld32(esp); esp += 4;`]); }
  if (op >= 0x70 && op < 0x80) { const d = s8(); return { len: p - at, c: [], kind: "jcc", cond: COND[op & 15], target: (p + d) >>> 0 }; }
  if (op >= 0x91 && op < 0x98) { if (o16) return U("16-bit xchg"); const i = op & 7; return done([`t = eax; eax = ${REG[i]}; ${REG[i]} = t;`]); }
  if (op >= 0xb0 && op < 0xb8) { const v = b8(); return done([W(op & 7, 8, hex(v))]); }
  if (op >= 0xb8 && op < 0xc0) { const v = o16 ? b16() : b32(); return done([W(op & 7, sz, hex(v))]); }
  if (op >= 0xd8 && op <= 0xdf) { const o = modrm(), r = x87(op, o); return r ? done([...eaLine(o), ...r], { fpu: true }) : U(`x87 ${op.toString(16)}/${o.reg}${o.mem ? " mem" : " " + o.rm}`); }
  if (op === 0x9b) return done([]);
  if ([0xa4, 0xa5, 0xaa, 0xab, 0xac, 0xad, 0xa6, 0xa7, 0xae, 0xaf].includes(op)) { const r = strop(op, op & 1 ? sz : 8, rep); return r ? done(r) : U(`string ${op.toString(16)}`); }
  switch (op) {
    case 0x90: return done([]);
    case 0x68: { if (o16) return U("push imm16"); const v = b32(); return done([`esp -= 4; st32(esp, ${hex(v)});`]); }
    case 0x6a: { if (o16) return U("push imm16"); const v = s8() >>> 0; return done([`esp -= 4; st32(esp, ${hex(v)});`]); }
    case 0x69: case 0x6b: { if (o16) return U("16-bit imul"); const o = modrm(), imm = op === 0x6b ? s8() : b32() | 0;
      return done([...eaLine(o), `{ int64_t pr = (int64_t)(int32_t)${rd(o, 32)} * (int64_t)${imm}; uint32_t lo = (uint32_t)pr; ${REG[o.reg]} = lo; fl = (fl & ~0x801u) | ((int64_t)(int32_t)lo != pr ? 0x801u : 0); }`]); }
    case 0x80: case 0x81: case 0x82: case 0x83: {
      const s = op & 1 ? sz : 8, o = modrm(); if (s === 16 && (o.reg === 2 || o.reg === 3)) return U("16-bit adc/sbb imm");
      const imm = op === 0x81 ? (s === 16 ? b16() : b32()) : op === 0x83 ? (s8() >>> 0) & (s === 32 ? 0xffffffff : (1 << s) - 1) : b8();
      return done([...eaLine(o), ...alu(o.reg, rd(o, s), hex(imm), s, v => wr(o, s, v))]); }
    case 0x84: case 0x85: { const s = op & 1 ? sz : 8, o = modrm(); return done([...eaLine(o), ...alu(4, rd(o, s), R(o.reg, s), s, null)]); }
    case 0xa8: { const v = b8(); return done(alu(4, R(0, 8), hex(v), 8, null)); }
    case 0xa9: { const v = o16 ? b16() : b32(); return done(alu(4, R(0, sz), hex(v), sz, null)); }
    case 0x86: case 0x87: { const s = op & 1 ? sz : 8; if (s === 16) return U("16-bit xchg"); const o = modrm();
      return done([...eaLine(o), `t = ${rd(o, s)}; a = ${R(o.reg, s)};`, wr(o, s, "a"), W(o.reg, s, "t")]); }
    case 0x88: case 0x89: { const s = op & 1 ? sz : 8, o = modrm(); return done([...eaLine(o), wr(o, s, R(o.reg, s))]); }
    case 0x8a: case 0x8b: { const s = op & 1 ? sz : 8, o = modrm(); return done([...eaLine(o), W(o.reg, s, rd(o, s))]); }
    case 0x8d: { const o = modrm(); if (!o.mem || o16) return U("lea form"); return done([`${REG[o.reg]} = ${o.mem};`]); }
    case 0x8f: { const o = modrm(); if (o.reg !== 0 || o16) return U("8f form"); if (o.mem && /esp/.test(o.mem)) return U("pop [esp+]");
      return done(o.mem ? [`t = ld32(esp); esp += 4; ea = ${o.mem}; st32(ea, t);`] : [`t = ld32(esp); esp += 4;`, W(o.rm, 32, "t")]); }
    case 0x98: if (o16) return U("cbw"); return done([`eax = (uint32_t)(int32_t)(int16_t)eax;`]);
    case 0x99: if (o16) return U("cwd"); return done([`edx = (eax & 0x80000000u) ? 0xffffffffu : 0;`]);
    case 0x60: if (o16) return U("pushaw"); return done([`t = esp; esp -= 32; st32(esp + 28, eax); st32(esp + 24, ecx); st32(esp + 20, edx); st32(esp + 16, ebx); st32(esp + 12, t); st32(esp + 8, ebp); st32(esp + 4, esi); st32(esp, edi);`]);   // pushad
    case 0x61: if (o16) return U("popaw"); return done([`edi = ld32(esp); esi = ld32(esp + 4); ebp = ld32(esp + 8); ebx = ld32(esp + 16); edx = ld32(esp + 20); ecx = ld32(esp + 24); eax = ld32(esp + 28); esp += 32;`]);   // popad
    case 0x9b: return done([]);                                                                   // fwait
    case 0x9e: return done([`fl = (fl & ~0xd5u) | ((eax >> 8) & 0xd5u);`]);                         // sahf
    case 0x9f: return done([`eax = (eax & 0xffff00ffu) | ((fl & 0xffu) << 8);`]);                    // lahf
    case 0xd7: return done([`eax = (eax & 0xffffff00u) | ld8(ebx + (eax & 0xffu));`]);              // xlat
    case 0xa0: case 0xa1: case 0xa2: case 0xa3: { const a = b32(), s = op & 1 ? sz : 8;
      return done(op < 0xa2 ? [W(0, s, LD(hex(a), s))] : [ST(hex(a), s, R(0, s))]); }
    case 0xc0: case 0xc1: case 0xd0: case 0xd1: case 0xd2: case 0xd3: {
      const s = op & 1 ? sz : 8, o = modrm(); if (o.reg === 2 || o.reg === 3) return U("rcl/rcr");
      const n = op < 0xd0 ? b8() & 31 : op < 0xd2 ? 1 : null;
      if (n === 0) return done([]);
      const cnt = n === null ? "(ecx & 31u)" : `${n}u`;
      const body = [`a = ${rd(o, s)}; t = shiftop(&fl, ${o.reg}u, a, n, ${s}u);`, wr(o, s, "t")];
      return done([...eaLine(o), `n = ${cnt};`, n === null ? `if (n) { ${body.join(" ")} }` : body.join(" ")]); }
    case 0xc2: { const n = b16(); return { len: p - at, c: [], kind: "ret", pop: n }; }
    case 0xc3: return { len: p - at, c: [], kind: "ret", pop: 0 };
    case 0xc6: { const o = modrm(); const v = b8(); return done([...eaLine(o), wr(o, 8, hex(v))]); }
    case 0xc7: { const o = modrm(); const v = o16 ? b16() : b32(); return done([...eaLine(o), wr(o, sz, hex(v))]); }
    case 0xc9: return done([`esp = ebp; ebp = ld32(esp); esp += 4;`]);
    case 0xe8: { const d = b32() | 0; return { len: p - at, c: [], kind: "call", target: (p + d) >>> 0, ret: p >>> 0 }; }
    case 0xe9: { const d = b32() | 0; return { len: p - at, c: [], kind: "jmp", target: (p + d) >>> 0 }; }
    case 0xeb: { const d = s8(); return { len: p - at, c: [], kind: "jmp", target: (p + d) >>> 0 }; }
    case 0xf5: return done([`fl ^= 1u;`]); case 0xf8: return done([`fl &= ~1u;`]); case 0xf9: return done([`fl |= 1u;`]);
    case 0xfc: return done([`fl &= ~0x400u;`]); case 0xfd: return done([`fl |= 0x400u;`]);
    case 0xf6: case 0xf7: {
      const s = op & 1 ? sz : 8, o = modrm(), M = MASK[s];
      switch (o.reg) {
        case 0: case 1: { const v = s === 8 ? b8() : s === 16 ? b16() : b32(); return done([...eaLine(o), ...alu(4, rd(o, s), hex(v), s, null)]); }
        case 2: return done([...eaLine(o), wr(o, s, `(~${rd(o, s)}) & ${M}`)]);
        case 3: return done([...eaLine(o), `b = ${rd(o, s)}; t = (0u - b) & ${M}; fl = f_sub(fl, 0, b, t, ${M}, ${SIGN[s]});`, wr(o, s, "t")]);
        case 4: case 5: { if (s !== 32) return U("8/16-bit mul");
          return done([...eaLine(o), o.reg === 4 ? `{ uint64_t pr = (uint64_t)eax * (uint64_t)${rd(o, 32)}; eax = (uint32_t)pr; edx = (uint32_t)(pr >> 32); fl = (fl & ~0x801u) | (edx ? 0x801u : 0); }`
            : `{ int64_t pr = (int64_t)(int32_t)eax * (int64_t)(int32_t)${rd(o, 32)}; eax = (uint32_t)pr; edx = (uint32_t)((uint64_t)pr >> 32); fl = (fl & ~0x801u) | ((int64_t)(int32_t)eax != pr ? 0x801u : 0); }`]); }
        case 6: case 7: { if (s !== 32) return U("8/16-bit div");
          return { len: p - at, kind: "divcheck", pre: [...eaLine(o), `b = ${rd(o, 32)};`], zero: "b == 0", c: [o.reg === 6
            ? `{ uint64_t nn = ((uint64_t)edx << 32) | eax; eax = (uint32_t)(nn / b); edx = (uint32_t)(nn % b); }`
            : `{ int64_t nn = (int64_t)(((uint64_t)edx << 32) | eax); int64_t dd = (int32_t)b; if (dd == -1) { eax = (uint32_t)(0u - (uint32_t)nn); edx = 0; } else { eax = (uint32_t)(nn / dd); edx = (uint32_t)(nn % dd); } }`] }; }
      }
      break;
    }
    case 0xfe: case 0xff: {
      const s = op === 0xfe ? 8 : sz, o = modrm();
      if (o.reg <= 1) { return done([...eaLine(o), `a = ${rd(o, s)}; t = (a ${o.reg ? "-" : "+"} 1u) & ${MASK[s]}; fl = f_${o.reg ? "dec" : "inc"}(fl, a, t, ${MASK[s]}, ${SIGN[s]});`, wr(o, s, "t")]); }
      if (op === 0xfe || o16) return U("fe/ff form");
      if (o.reg === 2) return { len: p - at, c: [...eaLine(o), `t = ${rd(o, 32)};`], kind: "callind", ret: p >>> 0 };
      if (o.reg === 4) {
        if (o.mem) { const m = /^\(uint32_t\)\((\w+) \* 4u \+ (0x[0-9a-f]+)u\)$/.exec(o.mem); if (m) return { len: p - at, c: [], kind: "table", idx: m[1], base: parseInt(m[2], 16) }; }
        return { len: p - at, c: [...eaLine(o), `t = ${rd(o, 32)};`], kind: "jmpind" };
      }
      if (o.reg === 6) { if (o.mem && /esp/.test(o.mem)) return done([`ea = ${o.mem}; t = ld32(ea); esp -= 4; st32(esp, t);`]); return done([...eaLine(o), `t = ${rd(o, 32)}; esp -= 4; st32(esp, t);`]); }
      return U("ff /" + o.reg);
    }
  }
  if (op !== 0x0f) return U(`opcode ${op.toString(16)}`);
  // ---- two-byte opcodes
  const o2 = b8();
  if (o2 >= 0x80 && o2 < 0x90) { const d = b32() | 0; return { len: p - at, c: [], kind: "jcc", cond: COND[o2 & 15], target: (p + d) >>> 0 }; }
  if (o2 >= 0x90 && o2 < 0xa0) { const o = modrm(); return done([...eaLine(o), wr(o, 8, `${COND[o2 & 15]} ? 1u : 0u`)]); }
  if (o2 >= 0x40 && o2 < 0x50) { if (o16) return U("16-bit cmov"); const o = modrm(); return done([...eaLine(o), `t = ${rd(o, 32)}; if (${COND[o2 & 15]}) ${REG[o.reg]} = t;`]); }
  switch (o2) {
    case 0x18: case 0x1f: { const o = modrm(); return done([]); }
    case 0xb6: case 0xb7: { if (o16) { const o = modrm(); return done([...eaLine(o), W(o.reg, 16, rd(o, o2 === 0xb6 ? 8 : 16))]); } const o = modrm(); return done([...eaLine(o), `${REG[o.reg]} = ${rd(o, o2 === 0xb6 ? 8 : 16)};`]); }
    case 0xbe: case 0xbf: { if (o16) { const o = modrm(); return done([...eaLine(o), W(o.reg, 16, o2 === 0xbe ? `(uint32_t)(int32_t)(int8_t)${rd(o, 8)}` : rd(o, 16))]); } const o = modrm(); return done([...eaLine(o), `${REG[o.reg]} = (uint32_t)(int32_t)(${o2 === 0xbe ? "int8_t" : "int16_t"})${rd(o, o2 === 0xbe ? 8 : 16)};`]); }
    case 0xa4: case 0xa5: case 0xac: case 0xad: { if (o16) return U("16-bit shld/shrd"); const o = modrm(), cnt = o2 & 1 ? "(ecx & 31u)" : `${b8() & 31}u`, left = o2 < 0xac;
      return done([...eaLine(o), `n = ${cnt}; if (n) { a = ${rd(o, 32)}; b = ${REG[o.reg]}; t = ${left ? "(a << n) | (b >> (32u - n))" : "(a >> n) | (b << (32u - n))"}; c = ${left ? "(a >> (32u - n)) & 1u" : "(a >> (n - 1u)) & 1u"};`, wr(o, 32, "t"), `fl = (szp(fl, t, 0x80000000u) & ~1u) | c; }`]); }
    case 0xaf: { if (o16) return U("16-bit imul"); const o = modrm();
      return done([...eaLine(o), `{ int64_t pr = (int64_t)(int32_t)${REG[o.reg]} * (int64_t)(int32_t)${rd(o, 32)}; uint32_t lo = (uint32_t)pr; ${REG[o.reg]} = lo; fl = (fl & ~0x801u) | ((int64_t)(int32_t)lo != pr ? 0x801u : 0); }`]); }
  }
  // ---- MMX moves (registers at CTX+0x180)
  if (!o16 && !rep && (o2 === 0x6f || o2 === 0x7f || o2 === 0x6e || o2 === 0x7e || o2 === 0x77)) {
    if (o2 === 0x77) return done([]);
    const o = modrm(), mr = `MMR(${o.reg})`;
    if (o2 === 0x6f) return done(o.mem ? [...eaLine(o), `${mr}[0] = ld32(ea); ${mr}[1] = ld32(ea + 4);`] : [`${mr}[0] = MMR(${o.rm})[0]; ${mr}[1] = MMR(${o.rm})[1];`]);
    if (o2 === 0x7f) return done(o.mem ? [...eaLine(o), `st32(ea, ${mr}[0]); st32(ea + 4, ${mr}[1]);`] : [`MMR(${o.rm})[0] = ${mr}[0]; MMR(${o.rm})[1] = ${mr}[1];`]);
    if (o2 === 0x6e) return done([...eaLine(o), `${mr}[0] = ${rd(o, 32)}; ${mr}[1] = 0;`]);
    return done([...eaLine(o), wr(o, 32, `${mr}[0]`)]);
  }
  // ---- SSE (single precision; no 66 prefix on this CPU)
  if (o16) return U(`66 0f ${o2.toString(16)}`);
  const X = i => `x${i}`;
  const xsrc = (o, n) => o.mem ? (n === 16 ? `ld128(ea)` : null) : X(o.rm);
  const lane0 = (o) => o.mem ? `ld32(ea)` : `${X(o.rm)}[0]`;
  const ps = (opc, scalar) => {                     // packed / scalar single arithmetic
    const o = modrm(), d = X(o.reg), L = [...eaLine(o)];
    const fn = { 0x51: (a, b) => `sqrt_f(${b})`, 0x52: (a, b) => `(float)div_d(1.0, sqrt_d((double)${b}))`, 0x53: (a, b) => `(float)div_d(1.0, (double)${b})`,
      0x58: (a, b) => scalar ? `add_f(${a}, ${b})` : `add_4(${a}, ${b})`, 0x59: (a, b) => scalar ? `mul_f(${a}, ${b})` : `mul_4(${a}, ${b})`, 0x5c: (a, b) => scalar ? `sub_f(${a}, ${b})` : `sub_4(${a}, ${b})`, 0x5e: (a, b) => scalar ? `div_f(${a}, ${b})` : `div_4(${a}, ${b})`,
      0x5d: (a, b) => `(${a} < ${b} ? ${a} : ${b})`, 0x5f: (a, b) => `(${a} > ${b} ? ${a} : ${b})` }[opc];
    if (scalar) { L.push(`{ float fa = ffl(${d}[0]), fb = ffl(${lane0(o)}); ${d}[0] = fbits(${fn("fa", "fb")}); }`); return L; }
    if (opc === 0x51 || opc === 0x52 || opc === 0x53 || opc === 0x5d || opc === 0x5f) {   // lane by lane (exact double / select forms)
      L.push(`{ u4 sv = ${xsrc(o, 16)}; for (int i = 0; i < 4; i++) { float fa = ffl(${d}[i]), fb = ffl(sv[i]); ${d}[i] = fbits(${fn("fa", "fb")}); } }`); return L; }
    L.push(`{ f4 va = (f4)${d}, vb = (f4)(${xsrc(o, 16)}); ${d} = fcanon(${fn("va", "vb")}); }`); return L;
  };
  switch (o2) {
    case 0x10: case 0x11: { const o = modrm(), x = X(o.reg);
      if (rep === 1) { if (o2 === 0x10) return done(o.mem ? [...eaLine(o), `${x} = (u4){ ld32(ea), 0, 0, 0 };`] : [`${x}[0] = ${X(o.rm)}[0];`]);
        return done(o.mem ? [...eaLine(o), `st32(ea, ${x}[0]);`] : [`${X(o.rm)}[0] = ${x}[0];`]); }
      if (rep) return U("f2 0f 10");
      if (o2 === 0x10) return done([...eaLine(o), `${x} = ${xsrc(o, 16)};`]);
      return done(o.mem ? [...eaLine(o), `st128(ea, ${x});`] : [`${X(o.rm)} = ${x};`]); }
    case 0x28: case 0x29: case 0x2b: { if (rep) return U("rep movaps"); const o = modrm(), x = X(o.reg);
      if (o2 === 0x28) return done([...eaLine(o), `${x} = ${xsrc(o, 16)};`]);
      return done(o.mem ? [...eaLine(o), `st128(ea, ${x});`] : [`${X(o.rm)} = ${x};`]); }
    case 0x12: case 0x13: case 0x16: case 0x17: { if (rep) return U("rep movlps"); const o = modrm(), x = X(o.reg), hi = o2 >= 0x16;
      if (o2 === 0x13 || o2 === 0x17) { if (!o.mem) return U("movlps store reg"); return done([...eaLine(o), `st32(ea, ${x}[${hi ? 2 : 0}]); st32(ea + 4, ${x}[${hi ? 3 : 1}]);`]); }
      if (!o.mem) return done(hi ? [`${x}[2] = ${X(o.rm)}[0]; ${x}[3] = ${X(o.rm)}[1];`] : [`${x}[0] = ${X(o.rm)}[2]; ${x}[1] = ${X(o.rm)}[3];`]);
      return done([...eaLine(o), `${x}[${hi ? 2 : 0}] = ld32(ea); ${x}[${hi ? 3 : 1}] = ld32(ea + 4);`]); }
    case 0x14: case 0x15: { if (rep) return U("rep unpck"); const o = modrm(), x = X(o.reg), k = o2 === 0x14 ? 0 : 2;
      return done([...eaLine(o), `{ u4 sv = ${xsrc(o, 16)}; ${x} = (u4){ ${x}[${k}], sv[${k}], ${x}[${k + 1}], sv[${k + 1}] }; }`]); }
    case 0xc6: { if (rep) return U("rep shufps"); const o = modrm(), x = X(o.reg); const imm = b8();
      return done([...eaLine(o), `{ u4 sv = ${xsrc(o, 16)}; ${x} = (u4){ ${x}[${imm & 3}], ${x}[${(imm >> 2) & 3}], sv[${(imm >> 4) & 3}], sv[${(imm >> 6) & 3}] }; }`]); }
    case 0x50: { if (rep) return U("rep movmskps"); const o = modrm(); if (o.mem) return U("movmskps mem"); const s = X(o.rm);
      return done([`${REG[o.reg]} = (${s}[0] >> 31) | ((${s}[1] >> 31) << 1) | ((${s}[2] >> 31) << 2) | ((${s}[3] >> 31) << 3);`]); }
    case 0x51: case 0x52: case 0x53: case 0x58: case 0x59: case 0x5c: case 0x5d: case 0x5e: case 0x5f:
      if (rep === 2) return U("f2 sse"); return done(ps(o2, rep === 1));
    case 0x54: case 0x55: case 0x56: case 0x57: { if (rep) return U("rep sse logic"); const o = modrm(), x = X(o.reg), s = xsrc(o, 16);
      return done([...eaLine(o), `VBAR(${x});`, o2 === 0x54 ? `${x} = ${x} & ${s};` : o2 === 0x55 ? `${x} = ~${x} & ${s};` : o2 === 0x56 ? `${x} = ${x} | ${s};` : `${x} = ${x} ^ ${s};`, `VBAR(${x});`]); }
    case 0xc2: { if (rep === 2) return U("f2 cmp"); const o = modrm(), x = X(o.reg), scalar = rep === 1; const imm = b8() & 7;
      const t = ["fa == fb", "fa < fb", "fa <= fb", "(fa != fa || fb != fb)", "!(fa == fb)", "!(fa < fb)", "!(fa <= fb)", "!(fa != fa || fb != fb)"][imm];
      if (scalar) return done([...eaLine(o), `{ float fa = ffl(${x}[0]), fb = ffl(${lane0(o)}); ${x}[0] = (${t}) ? 0xffffffffu : 0; }`]);
      return done([...eaLine(o), `{ u4 sv = ${xsrc(o, 16)}; for (int i = 0; i < 4; i++) { float fa = ffl(${x}[i]), fb = ffl(sv[i]); ${x}[i] = (${t}) ? 0xffffffffu : 0; } }`]); }
    case 0x2e: case 0x2f: { if (rep) return U("rep comiss"); const o = modrm();
      return done([...eaLine(o), `{ float fa = ffl(${X(o.reg)}[0]), fb = ffl(${lane0(o)}); fl &= ~0x8d5u; if (fa != fa || fb != fb) fl |= 0x45u; else if (fa < fb) fl |= 1u; else if (fa == fb) fl |= 0x40u; }`]); }
    case 0x2a: { const o = modrm();
      if (rep === 1) return done([...eaLine(o), `${X(o.reg)}[0] = fbits((float)(int32_t)${rd(o, 32)});`]);
      if (rep) return U("f2 cvt");   // cvtpi2ps xmm, mm/m64: two int32 -> the low two floats (round to nearest, as the interpreter)
      const lo = o.mem ? `ld32(ea)` : `MMR(${o.rm})[0]`, hi = o.mem ? `ld32(ea + 4)` : `MMR(${o.rm})[1]`;
      return done([...eaLine(o), `{ uint32_t l0 = ${lo}, l1 = ${hi}; ${X(o.reg)}[0] = fbits((float)(int32_t)l0); ${X(o.reg)}[1] = fbits((float)(int32_t)l1); }`]); }
    case 0x2d: { if (rep !== 1) return U("cvtps2pi"); const o = modrm(); return done([...eaLine(o), `${REG[o.reg]} = imp_cvt(ffl(${lane0(o)}));`]); }
    case 0x2c: { if (rep !== 1) return U("cvttps2pi"); const o = modrm(); return done([...eaLine(o), `{ float fv = ffl(${lane0(o)}); ${REG[o.reg]} = (uint32_t)toi32(__builtin_trunc((double)fv)); }`]); }
  }
  return U(`0f ${o2.toString(16)}`);
}

// register state kept in CTX between recompiled functions: general registers (CTX words 0-8), x87 top / status /
// control (11-13), XMM registers (XMMA)
const REGS = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi", "fl", "top", "fsw", "fcw", "x0", "x1", "x2", "x3", "x4", "x5", "x6", "x7"];
const SLOT = { eax: 0, ecx: 1, edx: 2, ebx: 3, esp: 4, ebp: 5, esi: 6, edi: 7, fl: 8, top: 11, fsw: 12, fcw: 13 };
const regLoad = rs => !rs.length ? "" : `{ uint32_t *R = (uint32_t*)(uintptr_t)CTXA; (void)R; ${rs.map(r => r[0] === "x" ? `__builtin_memcpy(&${r}, (void*)(uintptr_t)(XMMA + ${+r[1] * 16}), 16);` : `${r} = R[${SLOT[r]}];`).join(" ")} }`;
const regSave = rs => !rs.length ? "" : `{ uint32_t *R = (uint32_t*)(uintptr_t)CTXA; (void)R; ${rs.map(r => r[0] === "x" ? `__builtin_memcpy((void*)(uintptr_t)(XMMA + ${+r[1] * 16}), &${r}, 16);` : `R[${SLOT[r]}] = ${r};`).join(" ")} }`;

// ---------------------------------------------------------------- one function -> C
// Blocks found by following jumps from the entry (calls do not end the walk: the instruction after a call is a new
// block). Addresses that are entries of other recompiled functions are not entered (left to the dispatcher).
export function translateFunction(im, entry, ctx) {
  const blocks = new Map(), work = [entry], ats = new Set(), starts = new Set([entry]), unsupported = new Map();
  // pass 1: instruction walk, block starts
  const insn = new Map();
  while (work.length) {
    let a = work.pop();
    while (true) {
      if (!im.isCode(a) || insn.has(a)) break;
      if (a !== entry && ctx.funcEntries.has(a) && !starts.has(a)) break;       // another function: left to the dispatcher
      const d = decode(im, a); insn.set(a, d);
      if (d.kind === "unsupported") { unsupported.set(d.why, (unsupported.get(d.why) ?? 0) + 1); const n = lengthOf(im, a); if (n === null) break; d.len = n; const nx = a + n; starts.add(nx); work.push(nx); break; }
      ats.add(a);
      if (d.kind === "jcc") { if (canEnter(d.target)) { starts.add(d.target); work.push(d.target); } starts.add(a + d.len); a += d.len; continue; }
      if (d.kind === "jmp") { if (canEnter(d.target)) { starts.add(d.target); work.push(d.target); } break; }
      if (d.kind === "table") { d.targets = []; for (let i = 0; i < 1024; i++) { const t = im.r32(d.base + i * 4); if (!im.isCode(t)) break; d.targets.push(t); if (canEnter(t)) { starts.add(t); work.push(t); } } break; }
      if (d.kind === "call" || d.kind === "callind") { starts.add(a + d.len); a += d.len; continue; }
      if (d.kind === "divcheck") { a += d.len; continue; }
      if (d.kind === "ret" || d.kind === "jmpind") break;
      a += d.len;
    }
  }
  function canEnter(t) { return im.isCode(t) && (t === entry || !ctx.funcEntries.has(t)); }
  // pass 2: blocks (start -> instructions until the next start or a terminator)
  const order = [...starts].filter(s => insn.has(s)).sort((x, y) => x - y);
  for (const s of order) {
    const list = []; let a = s;
    while (insn.has(a)) {
      const d = insn.get(a);
      if (list.length && starts.has(a)) break;
      if (d.kind === "unsupported") { if (!list.length) list.push({ at: a, d }); break; }
      list.push({ at: a, d });
      if (d.kind !== "seq" && d.kind !== "divcheck") break;
      if (list.length >= MAX_BLOCK) { starts.add(a + d.len); break; }
      a += d.len;
    }
    blocks.set(s, list);
  }
  // blocks created by the MAX_BLOCK split (again at most MAX_BLOCK instructions: the dispatcher enters an entry only
  // when its longest block fits the remaining budget; a longer one made no progress near a tick)
  for (let more = true; more;) { more = false;
    for (const s of [...starts]) if (!blocks.has(s) && insn.has(s)) { const list = []; let a = s; more = true;
      while (insn.has(a)) { const d = insn.get(a); if (list.length && starts.has(a)) break; if (d.kind === "unsupported") { if (!list.length) list.push({ at: a, d }); break; } list.push({ at: a, d }); if (d.kind !== "seq" && d.kind !== "divcheck") break;
        if (list.length >= MAX_BLOCK) { starts.add(a + d.len); break; } a += d.len; }
      blocks.set(s, list); } }
  // C
  const name = `F_${entry.toString(16)}`, L = [], calls = new Set(); let anyInd = false;
  const lab = a => `L_${a.toString(16)}`, entries = [...blocks.keys()].filter(s => blocks.get(s).length && blocks.get(s)[0].d.kind !== "unsupported").sort((x, y) => x - y);
  const exitTo = (pc, extra = "") => `{ ${extra}pc = ${hex(pc)}; WHY(6); goto out_jump; }`;
  const go = t => blocks.has(t) && entries.includes(t) ? `goto ${lab(t)};` : exitTo(t);
  L.push(`__attribute__((visibility("hidden"))) uint32_t ${name}(uint32_t entry) {`);
  L.push(`  uint32_t eax, ecx, edx, ebx, esp, ebp, esi, edi, fl, top, fsw, fcw, cnt = G_cnt, lim = G_lim, pc, a, b, c, t, n, ea; u4 x0, x1, x2, x3, x4, x5, x6, x7; (void)a; (void)b; (void)c; (void)t; (void)n; (void)ea;`);
  L.push(`  LOADALL();`);
  L.push(`  switch (entry) {`); for (const s of entries) L.push(`    case ${hex(s)}: goto ${lab(s)};`); L.push(`    default: pc = entry; WHY(7); goto out_exit;`, `  }`);
  for (const s of entries) {
    const list = blocks.get(s), n = list.length;
    L.push(`${lab(s)}: if (cnt + ${n}u > lim) { pc = ${hex(s)}; WHY(0); goto out_exit; } cnt += ${n}u;`);
    for (let i = 0; i < n; i++) {
      const { at, d } = list[i], left = n - 1 - i, nextA = at + d.len;
      if (d.kind === "unsupported") { L.push(`  cnt -= ${left + 1}u; pc = ${hex(at)}; WHY(1); goto out_exit;`); break; }
      if (d.kind === "divcheck") { L.push(`  ${d.pre.join(" ")} if (${d.zero}) { cnt -= ${left + 1}u; pc = ${hex(at)}; if (!cnt) imp_divzero(pc); WHY(7); goto out_exit; } ${d.c.join(" ")}`); continue; }
      if (d.c.length) L.push(`  ${d.c.join(" ")}`);
      if (d.kind === "seq" && i === n - 1) L.push(`  ${go(nextA)}`);
      if (d.kind === "jcc") L.push(`  if (${d.cond}) ${go(d.target)} ${go(nextA)}`);
      if (d.kind === "jmp") L.push(`  ${go(d.target)}`);
      if (d.kind === "ret") L.push(`  pc = ld32(esp); esp += ${4 + d.pop}u; goto out_ret;`);
      if (d.kind === "jmpind") L.push(`  pc = t; WHY(4); NOTE(4, pc); goto out_jump;`);
      if (d.kind === "table") {
        L.push(`  t = ld32(${d.idx} * 4u + ${hex(d.base)}); switch (t) {`);
        for (const tg of new Set(d.targets)) if (entries.includes(tg)) L.push(`    case ${hex(tg)}: goto ${lab(tg)};`);
        L.push(`    default: pc = t; WHY(5); NOTE(5, pc); goto out_exit; }`);
      }
      if (d.kind === "callind") { ctx.anyCall = true; anyInd = true;
        L.push(`  esp -= 4; st32(esp, ${hex(d.ret)}); CC(14); SAVEALL(); G_cnt = cnt; G_nf = 0; pc = call_any(t); if (G_nf) { uint32_t hr = imp_hook(t, cnt); G_exit = 0; G_nf = 0; if (hr == 1) { WHYS[10] += 1; LOADALL(); ${go(d.ret)} } if (hr == 2) { LOADALL(); pc = ((volatile uint32_t*)(uintptr_t)CTXA)[15]; WHY(9); goto out_exit; } pc = t; WHY(2); NOTE(2, pc); goto out_exit; }`,
          `  if (G_exit || pc != ${hex(d.ret)}) return pc; LOADALL(); cnt = G_cnt; ${go(d.ret)}`); }
      if (d.kind === "call") {
        const fi = ctx.index.get(d.target); calls.add(d.target);
        if (d.target === 0x1803a8) L.push(`  if (NATIVE[0]) { st32(esp - 4, ${hex(d.ret)}); { double v = ST(0); FPOP(); if (v != v || !(__builtin_fabs(v) < 9223372036854775808.0)) { edx = 0x80000000u; eax = 0; } else { int64_t q = (int64_t)__builtin_trunc(v); eax = (uint32_t)q; edx = (uint32_t)((uint64_t)q >> 32); } } ${go(d.ret)} }`);
        // a hooked target (HT, by index): the JavaScript hook runs in place (imp_hook), see wasm-jit.mjs recompHook
        let k = ctx.ext.get(d.target); if (k === undefined) ctx.ext.set(d.target, k = ctx.ext.size);
        const viaHook = `if (HT[${k}]) { if (NHT[${k}] && nhook(NHT[${k}], ecx, edx, esp)) { eax = 0; esp += 4u + (NHT[${k}] >> 8); WHYS[15] += 1; ${go(d.ret)} } SAVEALL(); { uint32_t hr = imp_hook(${hex(d.target)}, cnt); G_exit = 0; G_nf = 0; LOADALL(); if (hr == 1) { WHYS[10] += 1; ${go(d.ret)} } if (hr == 2) { pc = ((volatile uint32_t*)(uintptr_t)CTXA)[15]; WHY(9); goto out_exit; } } } `;
        if (fi === undefined) L.push(`  esp -= 4; st32(esp, ${hex(d.ret)}); ${viaHook}pc = ${hex(d.target)}; WHY(3); NOTE(3, pc); goto out_exit;`);
        else { ctx.calls.add(d.target);
          L.push(`  esp -= 4; st32(esp, ${hex(d.ret)}); if (!((volatile uint8_t*)ENA)[${fi}]) { ${viaHook}pc = ${hex(d.target)}; WHY(3); NOTE(3, pc); goto out_exit; }`,
            `  CC(13); @@SC:${d.target}@@ G_cnt = cnt; pc = F_${d.target.toString(16)}(${hex(d.target)}); if (G_exit || pc != ${hex(d.ret)}) { @@SX:${d.target}@@ return pc; } @@LC:${d.target}@@ cnt = G_cnt; ${go(d.ret)}`); }
      }
    }
  }
  L.push(`out_jump: G_exit = 2; goto out_ret2;`, `out_exit: G_exit = 1;`, `out_ret: out_ret2: SAVEALL(); G_cnt = cnt; return pc;`, `}`);
  // registers loaded / saved at entries, calls, hooks and exits: only those this function mentions (U). The context
  // (CTX) holds the true value of every other register while it runs. Around a direct call to a recompiled function
  // G only U ∩ U*(G) moves (U*: G and everything it can call; build() fills the @@SC/@@LC/@@SX@@ placeholders), and
  // when G exits to the dispatcher this function saves the rest of its U (@@SX). Hooks run in place see a true context.
  let body = L.join("\n");
  const scan = body.replace(/^.*u4 x0, x1, x2, x3, x4, x5, x6, x7;.*$/m, "").replace(/@@[A-Z]+:\d+@@/g, "");
  const U = REGS.filter(r => new RegExp(`\\b${r}\\b`).test(scan) || (r === "top" && /\bST\(|FPUSH\(|FPOP\(/.test(scan)));
  body = body.replaceAll("LOADALL();", regLoad(U)).replaceAll("SAVEALL();", regSave(U));
  const xs = U.filter(r => r[0] === "x");
  return { name, U, calls, anyInd, c: body, entries, first: new Map(entries.map(e => [e, blocks.get(e).length])), ats: [...ats], unsupported, nInsn: insn.size, xmm: xs.length };
}
let lengthProbe = null;
function lengthOf(im, at) { lengthProbe ??= lenFn(im); return lengthProbe(at); }
// instruction length only (x86-jit LengthProbe rules, for unsupported instructions)
function lenFn(im) {
  const PRE = new Set([0x66, 0xf2, 0xf3, 0x64, 0x2e, 0x3e, 0x26, 0x36, 0x65, 0xf0]);
  return at => { const r8 = im.r8; let p = at, op = r8(p), o16 = false; while (PRE.has(op)) { if (op === 0x66) o16 = true; op = r8(++p); } p++;
    const modrm = () => { const x = r8(p++), mod = x >> 6, rm = x & 7; if (mod === 3) return; if (rm === 4) { const sib = r8(p++); if ((sib & 7) === 5 && mod === 0) p += 4; } else if (rm === 5 && mod === 0) p += 4; if (mod === 1) p += 1; else if (mod === 2) p += 4; };
    const iv = o16 ? 2 : 4;
    if (op === 0x0f) { const o2 = r8(p++); if (o2 >= 0x80 && o2 < 0x90) return p + 4 - at; if ([0x31, 0xa2, 0x08, 0x09, 0x77, 0x0b].includes(o2) || (o2 >= 0xc8 && o2 < 0xd0)) return p - at;
      modrm(); if ([0xa4, 0xac, 0xba, 0x70, 0x71, 0x72, 0x73, 0xc2, 0xc4, 0xc5, 0xc6].includes(o2)) p += 1; return p - at; }
    if (op >= 0xd8 && op <= 0xdf) { modrm(); return p - at; }
    if (op < 0x40 && (op & 7) < 6) { const f = op & 7; if (f === 4) p += 1; else if (f === 5) p += iv; else modrm(); return p - at; }
    if (op >= 0x40 && op < 0x62) return p - at;
    if (op >= 0x70 && op < 0x80) return p + 1 - at;
    if (op >= 0x90 && op < 0xa0) return p - at;
    if (op >= 0xb0 && op < 0xb8) return p + 1 - at;
    if (op >= 0xb8 && op < 0xc0) return p + iv - at;
    if (op >= 0xe0 && op <= 0xe3) return p + 1 - at;
    switch (op) {
      case 0x68: return p + iv - at; case 0x6a: return p + 1 - at; case 0x69: modrm(); return p + iv - at; case 0x6b: modrm(); return p + 1 - at;
      case 0x80: case 0x82: case 0x83: case 0xc0: case 0xc1: case 0xc6: modrm(); return p + 1 - at;
      case 0x81: case 0xc7: modrm(); return p + iv - at;
      case 0xa0: case 0xa1: case 0xa2: case 0xa3: return p + 4 - at; case 0xa8: return p + 1 - at; case 0xa9: return p + iv - at;
      case 0xc2: return p + 2 - at; case 0xc8: return p + 3 - at; case 0xcd: return p + 1 - at;
      case 0xe8: case 0xe9: return p + 4 - at; case 0xeb: return p + 1 - at;
      case 0xf6: case 0xf7: { const reg = (r8(p) >> 3) & 7; modrm(); if (reg < 2) p += op === 0xf6 ? 1 : iv; return p - at; }
      case 0x84: case 0x85: case 0x86: case 0x87: case 0x88: case 0x89: case 0x8a: case 0x8b: case 0x8c: case 0x8d: case 0x8e: case 0x8f:
      case 0xd0: case 0xd1: case 0xd2: case 0xd3: case 0xfe: case 0xff: modrm(); return p - at;
      case 0xa4: case 0xa5: case 0xa6: case 0xa7: case 0xaa: case 0xab: case 0xac: case 0xad: case 0xae: case 0xaf: case 0xc3: case 0xc9: case 0x98: case 0x99: case 0x9b: case 0x9c: case 0x9d: case 0x9e: case 0x9f: case 0xd7:
      case 0xf5: case 0xf8: case 0xf9: case 0xfa: case 0xfb: case 0xfc: case 0xfd: case 0x60: case 0x61: return p - at;
    }
    return null; };
}

// ---------------------------------------------------------------- whole module
export function build({ entries, out = HERE, log = console.log, native = false }) {
  const im = loadImage();
  const index = new Map(entries.map((e, i) => [e, i]));
  const ctx = { funcEntries: new Set(entries), index, calls: new Set(), ext: new Map() };
  const fns = entries.map(e => translateFunction(im, e, ctx));
  // U*: registers a call may touch. Everything when the function (or anything it calls) calls through a pointer or
  // calls an address that is hooked (recomp-hooks.json; a JavaScript hook may read or change any register).
  const hooked = new Set(fs.existsSync(join(HERE, "recomp-hooks.json")) ? JSON.parse(fs.readFileSync(join(HERE, "recomp-hooks.json"))) : []);
  const ALL = new Set(REGS), ustar = fns.map(f => (f.anyInd || !hooked.size || [...f.calls].some(t => hooked.has(t))) ? ALL : new Set(f.U));
  for (let changed = true; changed;) { changed = false;
    fns.forEach((f, i) => { if (ustar[i] === ALL) return; for (const t of f.calls) { const j = index.get(t); if (j === undefined) continue;
      const u = ustar[j]; if (u === ALL) { ustar[i] = ALL; changed = true; return; } for (const r of u) if (!ustar[i].has(r)) { ustar[i].add(r); changed = true; } } }); }
  let moved = 0, total = 0;
  fns.forEach((f, i) => { f.c = f.c.replace(/@@(SC|LC|SX):(\d+)@@/g, (_, k, t) => { const u = ustar[index.get(+t)], mine = f.U;
    const rs = k === "SX" ? mine.filter(r => !u.has(r)) : mine.filter(r => u.has(r)); if (k === "SC") { moved += rs.length; total += mine.length; }
    return k === "LC" ? regLoad(rs) : regSave(rs); }); });
  log(`recomp: call sites move ${moved} of ${total} registers (${(100 * moved / Math.max(1, total)).toFixed(0)}%); ${ustar.filter(u => u === ALL).length} of ${fns.length} functions need all`);
  // One header (runtime, register macros, every function's declaration) and many translation units (clang needs
  // ~6 GB for the whole program as one file), compiled in parallel and linked by wasm-ld.
  const header = [native ? nativePrelude(PRELUDE) : PRELUDE,
    `#define LOADALL() do { uint32_t *R = (uint32_t*)(uintptr_t)CTXA; eax = R[0]; ecx = R[1]; edx = R[2]; ebx = R[3]; esp = R[4]; ebp = R[5]; esi = R[6]; edi = R[7]; fl = R[8]; \\
  __builtin_memcpy(&x0, (void*)(uintptr_t)(XMMA), 16); __builtin_memcpy(&x1, (void*)(uintptr_t)(XMMA + 16), 16); __builtin_memcpy(&x2, (void*)(uintptr_t)(XMMA + 32), 16); __builtin_memcpy(&x3, (void*)(uintptr_t)(XMMA + 48), 16); \\
  __builtin_memcpy(&x4, (void*)(uintptr_t)(XMMA + 64), 16); __builtin_memcpy(&x5, (void*)(uintptr_t)(XMMA + 80), 16); __builtin_memcpy(&x6, (void*)(uintptr_t)(XMMA + 96), 16); __builtin_memcpy(&x7, (void*)(uintptr_t)(XMMA + 112), 16); } while (0)`,
    `#define SAVEALL() do { uint32_t *R = (uint32_t*)(uintptr_t)CTXA; R[0] = eax; R[1] = ecx; R[2] = edx; R[3] = ebx; R[4] = esp; R[5] = ebp; R[6] = esi; R[7] = edi; R[8] = fl; \\
  __builtin_memcpy((void*)(uintptr_t)(XMMA), &x0, 16); __builtin_memcpy((void*)(uintptr_t)(XMMA + 16), &x1, 16); __builtin_memcpy((void*)(uintptr_t)(XMMA + 32), &x2, 16); __builtin_memcpy((void*)(uintptr_t)(XMMA + 48), &x3, 16); \\
  __builtin_memcpy((void*)(uintptr_t)(XMMA + 64), &x4, 16); __builtin_memcpy((void*)(uintptr_t)(XMMA + 80), &x5, 16); __builtin_memcpy((void*)(uintptr_t)(XMMA + 96), &x6, 16); __builtin_memcpy((void*)(uintptr_t)(XMMA + 112), &x7, 16); } while (0)`,
    ...fns.map(f => `__attribute__((visibility("hidden"))) uint32_t ${f.name}(uint32_t entry);`), `__attribute__((visibility("hidden"))) uint32_t call_any(uint32_t t);`, `__attribute__((visibility("hidden"))) uint32_t chain(uint32_t pc);`].join("\n");
  const units = [[`#include "recomp.h"`, `uint32_t G_cnt, G_exit, G_nf, G_lim;`, ...(native ? [`uint32_t nstate(void) { return NSTA; }`]
    : [`uint32_t NST[1024] __attribute__((aligned(16)));`, `__attribute__((export_name("nstate"))) uint32_t nstate(void) { return (uint32_t)(uintptr_t)NST; }`]),
  ]];
  let cur = null, curLen = 0; const UNIT = 1_500_000, allEnts = [], entryNames = [];
  // entry wrappers: one per resume point (function, address), in the function's unit
  const manifest = { image: im.hash, base: RC_BASE, pages: RC_PAGES, en: EN_ADDR, hooked: [...hooked], functions: [] };
  fns.forEach((f, i) => {
    if (!cur || curLen > UNIT) { cur = [`#include "recomp.h"`]; units.push(cur); curLen = 0; }
    const C = cur; C.push(f.c); curLen += f.c.length;
    const ents = [];
    for (const s of f.entries) { const ex = `e_${s.toString(16)}_${i}`; C.push(`__attribute__((visibility("hidden"))) uint32_t ${ex}(void) { G_cnt = 0; G_exit = 0; G_lim = *(volatile uint32_t*)(uintptr_t)(CTXA + 0x1c0); if (RC_CAP && G_lim > RC_CAP) G_lim = RC_CAP; uint32_t lim0 = G_lim; uint32_t pc = chain(${f.name}(${hex(s)})); if (G_cnt > lim0 || G_cnt == 0) { *(volatile uint32_t*)(uintptr_t)(CTXA + 0x1c4) = lim0; *(volatile uint32_t*)(uintptr_t)(CTXA + 0x1c8) = G_cnt; imp_divzero(${hex(s)}); } *(volatile uint32_t*)(uintptr_t)(CTXA + 36) = G_cnt; STATS[0] += G_cnt; STATS[1]++; if (!G_exit) WHYS[8] += 1; return pc; }`); ents.push([s, entryNames.length, f.first.get(s)]); entryNames.push(ex); allEnts.push([s, i]); }
    manifest.functions.push({ entry: entries[i], index: i, entries: ents, ats: f.ats, insns: f.nInsn, calls: [...f.calls] });
  });
  // trampoline (unit 0): after a return (G_exit 0) or a jump out of a function (G_exit 2), continue at the new pc
  // when it is a resume point of an enabled recompiled function, without going back to the dispatcher. The step
  // budget carries over (G_cnt / G_lim); a budget exit or any other exit (G_exit 1) ends the chain, as does the
  // dispatcher's stop flag (CTX+56).
  // entry wrappers by number (recomp.json entries [address, number, first block]): V8 allows 100,000 exports per
  // module, so the wrappers are reached through the exported function table (ENTRY_FN holds their table slots)
  for (const n of entryNames) units[0].push(`__attribute__((visibility("hidden"))) uint32_t ${n}(void);`);
  units[0].push(`typedef uint32_t (*efn_t)(void);`, `static efn_t const ENTRY_FN[${entryNames.length}] = {${entryNames.join(",")}};`,
    ...(native ? [`uint32_t rc_entry_count(void) { return ${entryNames.length}u; }`, `efn_t rc_entry(uint32_t k) { return ENTRY_FN[k]; }`]
      : [`__attribute__((export_name("entry_table"))) uint32_t entry_table(void) { return (uint32_t)(uintptr_t)ENTRY_FN; }`]));
  allEnts.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  units[0].push(`static const uint32_t RA[${allEnts.length}] = {${allEnts.map(e => hex(e[0])).join(",")}};`,
    `static const uint16_t RI[${allEnts.length}] = {${allEnts.map(e => e[1]).join(",")}};`,
    `typedef uint32_t (*fn_t)(uint32_t);`, `static fn_t const FT[${fns.length}] = {${fns.map(f => f.name).join(",")}};`, ...hashTable("RH", allEnts), ...hashTable("CH", fns.map((f, i) => [entries[i], i])),
    // calls through pointers: a recompiled, enabled function's entry is called directly (G_nf is cleared after the
    // call: a miss inside the callee must not look like a miss of this call)
    `uint32_t call_any(uint32_t t) { uint32_t i = CH_find(t); if (i != 0xffffffffu && ((volatile uint8_t*)ENA)[i]) { uint32_t r = FT[i](t); G_nf = 0; return r; } G_nf = 1; return t; }`, 
    // a target with no enabled recompiled code may be hooked (tail jumps to _ftol, D3D setters, ...): the whole state
    // is in CTX here, so the hook runs in place and the trampoline continues at the return address it popped
    `static uint32_t chain_hook(uint32_t *ppc) { uint32_t pc = *ppc, *R = (uint32_t*)(uintptr_t)CTXA;`,
    `  if (pc == 0x1803a8u && NATIVE[0]) { double *F = (double*)(uintptr_t)(CTXA + 64); uint32_t tp = R[11] & 7; double v = F[tp]; R[11] = (tp + 1) & 7;`,
    `    if (v != v || !(__builtin_fabs(v) < 9223372036854775808.0)) { R[2] = 0x80000000u; R[0] = 0; } else { int64_t q = (int64_t)__builtin_trunc(v); R[0] = (uint32_t)q; R[2] = (uint32_t)((uint64_t)q >> 32); }`,
    `    *ppc = ld32(R[4]); R[4] += 4; WHYS[10] += 1; return 1; }`,
    `  uint32_t ra = ld32(R[4]), hr = imp_hook(pc, G_cnt); G_nf = 0;`,
    `  if (hr == 1) { *ppc = ra; WHYS[10] += 1; return 1; } if (hr == 2) { *ppc = R[15]; WHY(9); return 2; } return 0; }`,
    `uint32_t chain(uint32_t pc) {`,
    `  while (G_exit != 1) {`,
    `    if (*(volatile uint32_t*)(uintptr_t)(CTXA + 56)) break;`,
    `    uint32_t fi = RH_find(pc); if (fi == 0xffffffffu) { uint32_t h = chain_hook(&pc); if (h == 1) { G_exit = 0; continue; } if (h == 2) { G_exit = 1; break; } NOTE(G_exit ? 6 : 8, pc); break; }`,
    `    if (!((volatile uint8_t*)ENA)[fi]) { int lo = 0, hi = ${allEnts.length - 1}, k = -1; while (lo <= hi) { int m = (lo + hi) >> 1; if (RA[m] < pc) lo = m + 1; else { if (RA[m] == pc) k = m; hi = m - 1; } }`,
    `      while (k < ${allEnts.length} && RA[k] == pc && !((volatile uint8_t*)ENA)[RI[k]]) k++; if (k >= ${allEnts.length} || RA[k] != pc) { uint32_t h = chain_hook(&pc); if (h == 1) { G_exit = 0; continue; } if (h == 2) { G_exit = 1; break; } NOTE(G_exit ? 16 : 18, pc); break; } fi = RI[k]; }`,
    `    WHYS[G_exit ? 12 : 11] += 1; G_exit = 0; pc = FT[fi](pc);`,
    `  }`, `  return pc; }`);
  if (fns.length > 65535) throw new Error("chain: function index over 16 bits");
  // open-addressing hash table: address -> first function index (pairs sorted by address, so the lowest index wins)
  function hashTable(name, pairs) { const uniq = new Map(); for (const [a, i] of pairs) if (!uniq.has(a)) uniq.set(a, i);
    let bits = 1; while ((1 << bits) < uniq.size * 2) bits++; const N = 1 << bits, K = new Uint32Array(N), V = new Uint16Array(N);
    const h = a => (Math.imul(a, 0x9e3779b1) >>> 0) >>> (32 - bits);
    for (const [a, i] of uniq) { let j = h(a); while (K[j]) j = (j + 1) & (N - 1); K[j] = a; V[j] = i; }
    return [`static const uint32_t ${name}K[${N}] = {${Array.from(K).join(",")}};`, `static const uint16_t ${name}V[${N}] = {${Array.from(V).join(",")}};`,
      `static inline uint32_t ${name}_find(uint32_t a) { uint32_t j = (a * 0x9e3779b1u) >> ${32 - bits}; for (;;) { uint32_t k = ${name}K[j]; if (k == a) return ${name}V[j]; if (!k) return 0xffffffffu; j = (j + 1) & ${N - 1}u; } }`]; }
  const wPath = join(out, "recomp.wasm"), dir = fs.mkdtempSync(join(os.tmpdir(), "recomp-"));
  if (native) return buildNative({ header, units, dir, out, log, manifest, fns, ctx, entries: allEnts });
  fs.writeFileSync(join(dir, "recomp.h"), header);
  units.forEach((u, k) => fs.writeFileSync(join(dir, `u${k}.c`), u.join("\n")));
  const pages = (LOW >>> 16) + 262 + RC_PAGES;
  const t0 = performance.now();
  const cflags = ["--target=wasm32", process.env.RC_OPT ?? "-O2", "-msimd128", ...(vectorAsm() ? ["-DRC_VASM"] : []), ...(process.env.RC_NOTE ? ["-DRC_NOTE"] : []), ...(process.env.RC_COUNT ? ["-DRC_COUNT"] : []), ...(process.env.RC_CAP ? [`-DRC_CAP=${process.env.RC_CAP}u`] : []), "-nostdlib", "-nostdinc", "-fno-builtin", "-Wno-unused-label", "-Wno-unused-variable", "-Wno-unsupported-floating-point-opt", "-c"];
  compileAll(units.map((_, k) => ["clang", [...cflags, "-o", join(dir, `u${k}.o`), join(dir, `u${k}.c`)]]), Math.max(1, Math.min(os.availableParallelism(), 8)));
  execFileSync(findClang().clang, ["--target=wasm32", "-nostdlib", "-Wl,--no-entry", "-Wl,--import-memory", `-Wl,--global-base=${RC_BASE}`, "-Wl,-z,stack-size=262144", "-Wl,--export=__heap_base", "-Wl,--export-table", `-Wl,--initial-memory=${pages * 65536}`, `-Wl,--max-memory=${pages * 65536}`,
    "-o", wPath, ...units.map((_, k) => join(dir, `u${k}.o`))], { stdio: "inherit" });
  fs.rmSync(dir, { recursive: true, force: true });
  const un = new Map(); for (const f of fns) for (const [k, v] of f.unsupported) un.set(k, (un.get(k) ?? 0) + v);
  manifest.unsupported = [...un].sort((a, b) => b[1] - a[1]);
  manifest.ext = [...ctx.ext.keys()];
  fs.writeFileSync(join(out, "recomp.json"), JSON.stringify(manifest));
  log(`recomp: ${fns.length} functions, ${fns.reduce((n, f) => n + f.nInsn, 0)} instructions, ${fns.reduce((n, f) => n + f.entries.length, 0)} entries; clang ${((performance.now() - t0) / 1000).toFixed(1)} s; wasm ${fs.statSync(wPath).size} bytes`);
  log(`recomp: not translated (left to the dispatcher): ${manifest.unsupported.slice(0, 12).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  return manifest;
}

// Native: the add-on for this machine, or with RC_TARGET another (x86_64-pc-windows-msvc, x86_64-linux-gnu,
// x86_64-apple-darwin): recomp-native-<platform>-<arch>.node beside recomp.json. x86-64 only (the float operations
// above are SSE instructions).
export const nativeName = (platform = process.platform, arch = process.arch) => `recomp-native-${platform}-${arch}.node`;
function buildNative({ header, units, dir, out, log, manifest, fns, ctx }) {
  const target = process.env.RC_TARGET ?? "x86_64-linux-gnu", win = target.includes("windows"), mac = target.includes("apple");
  const plat = win ? "win32" : mac ? "darwin" : "linux";
  fs.writeFileSync(join(dir, "recomp.h"), nativize(header));
  units.forEach((u, k) => fs.writeFileSync(join(dir, `u${k}.c`), nativize(u.join("\n"))));
  // every address must have gone through MB: a cast from a number left over would point outside the emulator memory
  const left = [join(dir, "recomp.h"), ...units.map((_, k) => join(dir, `u${k}.c`))].map(f => fs.readFileSync(f, "utf8")).join("\n").split("\n").filter(l => /\(uintptr_t\)/.test(l.replace(/MB \+ \(uintptr_t\)/g, "")));
  if (left.length) throw new Error(`native: addresses not rebased:\n${left.slice(0, 5).join("\n")}`);
  fs.copyFileSync(join(HERE, "recomp-native.c"), join(dir, "glue.c"));
  const t0 = performance.now();
  const cflags = [`--target=${target}`, process.env.RC_OPT ?? "-O2", "-march=x86-64-v2", "-fno-builtin", "-ffreestanding", "-fno-stack-protector", "-fno-exceptions", "-fno-asynchronous-unwind-tables",
    ...(win ? [] : ["-fPIC", "-fvisibility=hidden"]), ...(process.env.RC_NOTE ? ["-DRC_NOTE"] : []), ...(process.env.RC_COUNT ? ["-DRC_COUNT"] : []), ...(process.env.RC_CAP ? [`-DRC_CAP=${process.env.RC_CAP}u`] : []),
    "-Wno-unused-label", "-Wno-unused-variable", "-Wno-unsupported-floating-point-opt", "-Wno-incompatible-library-redeclaration", "-c"];
  const srcs = [...units.map((_, k) => `u${k}`), "glue"];
  compileAll(srcs.map(n => ["clang", [...cflags, "-o", join(dir, `${n}.o`), join(dir, `${n}.c`)]]), Math.max(1, Math.min(os.availableParallelism(), 8)));
  const nPath = join(out, nativeName(plat, "x64")), objs = srcs.map(n => join(dir, `${n}.o`));
  if (win) {
    // a DLL with no C library: kernel32 (GetModuleHandleA / GetProcAddress) through an import library made here
    fs.writeFileSync(join(dir, "k32.def"), "LIBRARY kernel32.dll\nEXPORTS\nGetModuleHandleA\nGetProcAddress\n");
    execFileSync("llvm-dlltool", ["-m", "i386:x86-64", "-d", join(dir, "k32.def"), "-l", join(dir, "kernel32.lib")], { stdio: "inherit" });
    execFileSync("lld-link", ["/dll", "/noentry", "/nodefaultlib", "/machine:x64", `/out:${nPath}`, ...objs, join(dir, "kernel32.lib")], { stdio: "inherit" });
  } else if (mac) execFileSync(findClang().clang, [`--target=${target}`, "-shared", "-nostdlib", "-undefined", "dynamic_lookup", "-o", nPath, ...objs], { stdio: "inherit" });
  else execFileSync(findClang().clang, [`--target=${target}`, "-shared", "-nostdlib", "-fuse-ld=lld", "-o", nPath, ...objs], { stdio: "inherit" });
  fs.rmSync(dir, { recursive: true, force: true });
  const un = new Map(); for (const f of fns) for (const [k, v] of f.unsupported) un.set(k, (un.get(k) ?? 0) + v);
  manifest.unsupported = [...un].sort((a, b) => b[1] - a[1]); manifest.ext = [...ctx.ext.keys()]; manifest.nsta = NSTA;
  fs.writeFileSync(join(out, "recomp-native.json"), JSON.stringify(manifest));   // (its own manifest: entry numbers belong to this build)
  log(`recomp: native ${target}: ${fns.length} functions; clang ${((performance.now() - t0) / 1000).toFixed(1)} s; ${nPath} ${fs.statSync(nPath).size} bytes`);
  return manifest;
}

// run commands with at most `par` at once; waits for all, throws if any fails. (Was xargs + sh, which Windows does
// not have: now a small Node pool in a child process, so build() stays synchronous.) Prints "[done/total] compiled"
// as units finish (the launcher's progress bar). A command named "clang" runs the compiler findClang() found.
function compileAll(cmds, par) {
  const cc = findClang(); if (!cc.ok) throw new Error(cc.why);
  const list = cmds.map(([c, a]) => [c === "clang" ? cc.clang : c, a]);
  const pool = `const { spawn } = require("node:child_process"); const cmds = JSON.parse(require("node:fs").readFileSync(0, "utf8")), par = ${par | 0 || 1};
let next = 0, done = 0, failed = 0;
const one = () => { if (failed || next >= cmds.length) return; const [c, a] = cmds[next++];
  const p = spawn(c, a, { stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
  p.on("error", e => { console.error(c + ": " + e.message); failed = 1; process.exitCode = 1; });
  p.on("close", code => { if (code) { failed = 1; process.exitCode = 1; return; } done++; console.log("[" + done + "/" + cmds.length + "] compiled"); one(); }); };
for (let k = 0; k < par; k++) one();`;
  execFileSync(process.execPath, ["-e", pool], { input: JSON.stringify(list), stdio: ["pipe", "inherit", "inherit"] });
}

// Does the compiler take a 128-bit inline-asm operand for WebAssembly (LLVM 18 yes, LLVM 19 no: it aborts)? A tiny
// file is compiled once to find out; the build then uses the vector instructions or their lane-by-lane form.
let vasm = null;
export function vectorAsm() {
  if (vasm !== null) return vasm;
  const cc = findClang(); if (!cc.ok) return vasm = false;
  const dir = fs.mkdtempSync(join(os.tmpdir(), "recomp-probe-")), src = join(dir, "v.c");
  fs.writeFileSync(src, `typedef float f4 __attribute__((vector_size(16)));\nf4 f(f4 a, f4 b) { f4 r; __asm__("local.get %1\\n\\tlocal.get %2\\n\\tf32x4.add\\n\\tlocal.set %0" : "=r"(r) : "r"(a), "r"(b)); return r; }\n`);
  try { execFileSync(cc.clang, ["--target=wasm32", "-O2", "-msimd128", "-nostdlib", "-nostdinc", "-c", "-o", join(dir, "v.o"), src], { stdio: "ignore", windowsHide: true }); vasm = true; }
  catch { vasm = false; }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`recomp: ${cc.version}: ${vasm ? "vector inline assembly (f32x4)" : "no vector inline assembly: f32x4 operations lane by lane"}`);
  return vasm;
}

// The C compiler: clang with the WebAssembly target and its linker (wasm-ld) for recomp.wasm. Looked for in order:
// NT04_CLANG (a clang executable), tools/llvm/bin beside this file (an LLVM unpacked there), the PATH, then the usual
// install folders (Windows LLVM installer, Homebrew llvm). { ok, clang, wasmLd, version } or { ok: false, why }.
let clangFound = null;
export function findClang({ fresh = false } = {}) {
  if (clangFound && !fresh) return clangFound;
  const win = process.platform === "win32", exe = n => win ? n + ".exe" : n;
  const pathDirs = (process.env.PATH ?? "").split(win ? ";" : ":").filter(Boolean);
  const cands = [process.env.NT04_CLANG, join(HERE, "tools", "llvm", "bin", exe("clang")), ...pathDirs.map(d => join(d, exe("clang"))),
    ...(win ? [join(process.env.ProgramFiles ?? "C:\\Program Files", "LLVM", "bin", "clang.exe"), join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "LLVM", "bin", "clang.exe")]
      : ["/opt/homebrew/opt/llvm/bin/clang", "/usr/local/opt/llvm/bin/clang"])].filter(Boolean);
  let tried = 0, bundledErr = null; const bundled = join(HERE, "tools", "llvm", "bin", exe("clang"));
  for (const clang of cands) {
    if (!fs.existsSync(clang)) continue; tried++;
    let version = "", targets = "";
    try { version = execFileSync(clang, ["--version"], { encoding: "utf8", windowsHide: true }).split("\n")[0].trim(); targets = execFileSync(clang, ["-print-targets"], { encoding: "utf8", windowsHide: true }); }
    catch (e) { if (clang === bundled) bundledErr = e; continue; }
    if (!/\bwasm32\b/.test(targets)) continue;                                // (Apple's clang: no WebAssembly linker anyway)
    const ld = [join(dirname(clang), exe("wasm-ld")), ...pathDirs.map(d => join(d, exe("wasm-ld")))].find(f => fs.existsSync(f));
    if (!ld) continue;
    return clangFound = { ok: true, clang, wasmLd: ld, version };
  }
  if (bundledErr) return clangFound = { ok: false, why: `the compiler included in tools/llvm could not be started (${bundledErr.status != null ? `exit code ${bundledErr.status}` : String(bundledErr.code ?? bundledErr.signal ?? bundledErr.message).slice(0, 120)})` +
    (process.platform === "darwin" ? ". macOS may have blocked it because it came in a download: open System Settings -> Privacy & Security and allow it, or install LLVM with Homebrew (brew install llvm)" : process.platform === "win32" ? ". Your antivirus may have blocked or removed it; or install LLVM from llvm.org" : ". Install your distribution's clang and lld packages instead") };
  return clangFound = { ok: false, why: tried ? "clang was found but without the WebAssembly target or its linker (wasm-ld): install LLVM from llvm.org" : "no clang found: install LLVM from llvm.org (or unpack it into tools/llvm), or set NT04_CLANG to clang's path" };
}

// ---------------------------------------------------------------- command line: hottest functions from the race samples
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const im = loadImage(), top = +(process.argv[process.argv.indexOf("--top") + 1] || 0) || Infinity;
  const S = JSON.parse(fs.readFileSync(join(HERE, "recomp-samples.json")));
  const fe = JSON.parse(fs.readFileSync(join(HERE, "recomp-functions.json")));   // function entries (recomp-scan.mjs --save)
  const fl = fe.sort((x, y) => x - y), fnOf = a => { let lo = 0, hi = fl.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (fl[m] <= a) { r = fl[m]; lo = m + 1; } else hi = m - 1; } return r; };
  const per = new Map(); for (const a of S) if (im.isCode(a)) { const f = fnOf(a); if (f >= 0) per.set(f, (per.get(f) ?? 0) + 1); }
  const hot = [...per].sort((x, y) => y[1] - x[1]).map(x => x[0]).slice(0, top);
  // --calls N: also the N functions most often called from recompiled code while not recompiled (recomp-calls.json,
  // measured with an RC_NOTE build: calls that left to the dispatcher, most frequent first)
  const nc = +(process.argv[process.argv.indexOf("--calls") + 1] || 0) || 0;
  if (nc && fs.existsSync(join(HERE, "recomp-calls.json"))) { const have = new Set(hot); for (const t of JSON.parse(fs.readFileSync(join(HERE, "recomp-calls.json"))).slice(0, nc)) if (!have.has(t) && im.isCode(t)) { hot.push(t); have.add(t); } }
  // --executed: also every function that contains code the game has run (recomp-executed.json: function entries
  // holding a block start from the JavaScript / WebAssembly block caches)
  if (process.argv.includes("--executed") && fs.existsSync(join(HERE, "recomp-executed.json"))) { const have = new Set(hot); for (const t of JSON.parse(fs.readFileSync(join(HERE, "recomp-executed.json")))) if (!have.has(t) && im.isCode(t)) { hot.push(t); have.add(t); } }
  // recomp-extra.json (with --executed): functions missing from recomp-functions.json, found from exits of an RC_NOTE
  // build (returns / jumps to code no recompiled function contains; start = the 16-aligned address after int3 padding)
  if (process.argv.includes("--executed") && fs.existsSync(join(HERE, "recomp-extra.json"))) { const have = new Set(hot); for (const t of JSON.parse(fs.readFileSync(join(HERE, "recomp-extra.json")))) if (!have.has(t) && im.isCode(t)) { hot.push(t); have.add(t); } }
  // --all: every function of the image (recomp-all.json from recomp-all.mjs), for a full static build
  if (process.argv.includes("--all") && fs.existsSync(join(HERE, "recomp-all.json"))) { const have = new Set(hot); for (const t of JSON.parse(fs.readFileSync(join(HERE, "recomp-all.json")))) if (!have.has(t) && im.isCode(t)) { hot.push(t); have.add(t); } }
  const oi = process.argv.indexOf("--out");
  build({ entries: hot, ...(oi > 0 ? { out: process.argv[oi + 1] } : {}), native: process.argv.includes("--native") });
}
