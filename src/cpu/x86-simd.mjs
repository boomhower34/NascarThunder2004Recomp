// x86-simd.mjs — MMX and SSE (the Pentium III set the Xbox CPU has; no SSE2) for x86emu.mjs.
//
// The game's race code, its Direct3D library and its audio decoder use them: vector math (movaps/movups, mulps,
// addps, shufps, unpck*, movlhps/movhlps, cmpps, movmskps, minps/maxps, rcpps...), scalar float (movss, addss...,
// cvtss2si, comiss) and MMX integer work (movq/movd, punpck*, pack*, padd*/psub* with saturation, shifts, pmaddwd,
// pmullw/pmulhw, pshufw, pextrw...), plus streaming stores (movntps/movntq), prefetches, sfence and the MXCSR.
//
// State: eight 128-bit XMM registers and eight 64-bit MMX registers (kept apart from the x87 stack, which they
// alias on the real CPU; code switches with emms, so nothing reads one as the other), and MXCSR. Single-precision
// results are rounded to float32 by storing through a DataView. Denormal and exception flags are not modelled.

const sat = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function installSimd(X86) {
  const P = X86.prototype;

  P.simdInit = function () {
    this.xmmBuf = new ArrayBuffer(128); this.xmmOff = 0; this.xmm = new DataView(this.xmmBuf);
    this.mmBuf = new ArrayBuffer(64); this.mmOff = 0; this.mm = new DataView(this.mmBuf);
    this.mxcsr = 0x1f80;
    this.tmp = new DataView(new ArrayBuffer(16));
  };
  // move the register files into another buffer at the given offsets (wasm-jit.mjs: the WebAssembly state page)
  P.simdRebind = function (buf, xoff, moff) {
    new Uint8Array(buf, xoff, 128).set(new Uint8Array(this.xmmBuf, this.xmmOff, 128)); new Uint8Array(buf, moff, 64).set(new Uint8Array(this.mmBuf, this.mmOff, 64));
    this.xmmBuf = buf; this.xmmOff = xoff; this.xmm = new DataView(buf, xoff, 128); this.xmmViews = null;
    this.mmBuf = buf; this.mmOff = moff; this.mm = new DataView(buf, moff, 64); this.mmViews = null;
  };
  P.simdSave = function () { return { xmm: this.xmmBuf.slice(this.xmmOff, this.xmmOff + 128), mm: this.mmBuf.slice(this.mmOff, this.mmOff + 64), mxcsr: this.mxcsr }; };
  P.simdLoad = function (s) {
    if (!s) return;
    new Uint8Array(this.xmmBuf, this.xmmOff, 128).set(new Uint8Array(s.xmm)); new Uint8Array(this.mmBuf, this.mmOff, 64).set(new Uint8Array(s.mm)); this.mxcsr = s.mxcsr;
  };

  // ---------------------------------------------------------------- operand access
  // 16-byte values travel as DataViews (a register's slice of the file, or a temporary filled from memory)
  // register views are made once; memory operands go through a small ring of temporaries (no allocation per use)
  P.xr = function (i) { const v = this.xmmViews ??= Array.from({ length: 8 }, (_, k) => new DataView(this.xmmBuf, this.xmmOff + k * 16, 16)); return v[i]; };
  P.xsrc = function (o, bytes = 16) {
    if (o.addr === undefined) return this.xr(o.rm);
    const ring = this.xtmp ??= Array.from({ length: 4 }, () => new DataView(new ArrayBuffer(16)));
    const t = ring[this.xtmpI = ((this.xtmpI ?? 0) + 1) & 3];
    for (let k = bytes; k < 16; k += 4) t.setUint32(k, 0, true);
    for (let k = 0; k < bytes; k += 4) t.setUint32(k, this.m.r32((o.addr + k) >>> 0), true);
    return t;
  };
  P.xstore = function (addr, v, bytes = 16) { for (let k = 0; k < bytes; k += 4) this.m.w32((addr + k) >>> 0, v.getUint32(k, true)); };
  P.xcopy = function (dst, src, bytes = 16, dOff = 0, sOff = 0) { for (let k = 0; k < bytes; k += 4) dst.setUint32(dOff + k, src.getUint32(sOff + k, true), true); };
  P.mr = function (i) { const v = this.mmViews ??= Array.from({ length: 8 }, (_, k) => new DataView(this.mmBuf, this.mmOff + k * 8, 8)); return v[i]; };
  P.msrc = function (o) {
    if (o.addr === undefined) return this.mr(o.rm);
    const t = new DataView(new ArrayBuffer(8)); t.setUint32(0, this.m.r32(o.addr), true); t.setUint32(4, this.m.r32((o.addr + 4) >>> 0), true); return t;
  };
  P.mxRound = function (v) {                       // MXCSR rounding (bits 13-14) for cvtss2si / cvtps2pi
    switch ((this.mxcsr >> 13) & 3) {
      case 0: { const r = Math.round(v); return (Math.abs(v % 1) === 0.5 && r % 2) ? r - Math.sign(v) : r; }
      case 1: return Math.floor(v); case 2: return Math.ceil(v); default: return Math.trunc(v);
    }
  };
  const toI32 = v => (Number.isFinite(v) && v >= -2147483648 && v <= 2147483647 ? v | 0 : 0x80000000 | 0);

  // ---------------------------------------------------------------- MMX lanes
  // read/write all lanes of a 64-bit value: size 1/2/4 bytes, signed or not
  const get = (v, size, signed, i) => size === 1 ? (signed ? v.getInt8(i) : v.getUint8(i)) : size === 2 ? (signed ? v.getInt16(i * 2, true) : v.getUint16(i * 2, true)) : (signed ? v.getInt32(i * 4, true) : v.getUint32(i * 4, true));
  const set = (v, size, i, x) => { if (size === 1) v.setUint8(i, x & 0xff); else if (size === 2) v.setUint16(i * 2, x & 0xffff, true); else v.setUint32(i * 4, x >>> 0, true); };
  const lanewise = (d, s, size, signed, fn) => { const n = 8 / size, out = new Array(n); for (let i = 0; i < n; i++) out[i] = fn(get(d, size, signed, i), get(s, size, signed, i)); for (let i = 0; i < n; i++) set(d, size, i, out[i]); };
  const rd64 = v => (BigInt(v.getUint32(4, true)) << 32n) | BigInt(v.getUint32(0, true));
  const wr64 = (v, x) => { x = BigInt.asUintN(64, x); v.setUint32(0, Number(x & 0xffffffffn), true); v.setUint32(4, Number(x >> 32n), true); };
  const shift = (d, size, kind, n) => {            // kind 2 logical right, 4 arithmetic right, 6 left
    const bits = size * 8;
    if (size === 8) { const x = rd64(d); wr64(d, n >= 64 ? 0n : kind === 2 ? x >> BigInt(n) : x << BigInt(n)); return; }
    for (let i = 0; i < 8 / size; i++) {
      const u = get(d, size, false, i), s = get(d, size, true, i);
      set(d, size, i, kind === 2 ? (n >= bits ? 0 : u >>> n) : kind === 4 ? s >> Math.min(n, bits - 1) : (n >= bits ? 0 : u << n));
    }
  };
  const unpack = (d, s, size, high) => {           // punpckl*/punpckh*: interleave the low (or high) halves
    const n = 4 / size, out = [];
    for (let i = 0; i < n; i++) { const k = high ? i + n : i; out.push(get(d, size, false, k), get(s, size, false, k)); }
    out.forEach((x, i) => set(d, size, i, x));
  };
  const pack = (d, s, size, signed) => {           // packsswb (2->1 signed), packuswb (2->1 unsigned sat), packssdw (4->2)
    const n = 8 / size, lo = signed ? -(2 ** (size * 4 - 1)) : 0, hi = signed ? 2 ** (size * 4 - 1) - 1 : 2 ** (size * 4) - 1, out = [];
    for (let i = 0; i < n; i++) out.push(sat(get(d, size, true, i), lo, hi));
    for (let i = 0; i < n; i++) out.push(sat(get(s, size, true, i), lo, hi));
    out.forEach((x, i) => set(d, size / 2, i, x));
  };

  // ---------------------------------------------------------------- dispatch
  // op: second opcode byte (after 0F); rep: 1 = F3, 2 = F2 prefix; sz 16 = 66 prefix. Returns false if not SIMD.
  P.execSimd = function (op, sz, rep) {
    const X = this.xmm, m = this.m;
    const ps = (fn, scalar) => {                   // packed (or scalar with F3) single-precision arithmetic
      const o = this.modrm(), d = this.xr(o.reg), s = this.xsrc(o, scalar ? 4 : 16), n = scalar ? 1 : 4;
      for (let i = 0; i < n; i++) d.setFloat32(i * 4, fn(d.getFloat32(i * 4, true), s.getFloat32(i * 4, true)), true);
    };
    const bits = fn => { const o = this.modrm(), d = this.xr(o.reg), s = this.xsrc(o); for (let i = 0; i < 16; i += 4) d.setUint32(i, fn(d.getUint32(i, true), s.getUint32(i, true)) >>> 0, true); };
    const mmx = (size, signed, fn) => { const o = this.modrm(); lanewise(this.mr(o.reg), this.msrc(o), size, signed, fn); };
    if (sz === 16 && op !== 0x1f) throw new Error(`SSE2 instruction 66 0f ${op.toString(16)} (not on the Xbox CPU)`);

    switch (op) {
      // ------------------------------------------------ SSE moves
      case 0x10: case 0x11: {                      // movups / movss (F3)
        const o = this.modrm(), x = this.xr(o.reg);
        if (rep === 1) {
          if (op === 0x10) { if (o.addr === undefined) x.setUint32(0, this.xr(o.rm).getUint32(0, true), true); else { x.setUint32(0, m.r32(o.addr), true); x.setUint32(4, 0); x.setUint32(8, 0); x.setUint32(12, 0); } }
          else if (o.addr === undefined) this.xr(o.rm).setUint32(0, x.getUint32(0, true), true); else m.w32(o.addr, x.getUint32(0, true));
          return true;
        }
        if (op === 0x10) this.xcopy(x, this.xsrc(o)); else if (o.addr === undefined) this.xcopy(this.xr(o.rm), x); else this.xstore(o.addr, x);
        return true;
      }
      case 0x28: case 0x29: case 0x2b: {           // movaps load/store, movntps store
        const o = this.modrm(), x = this.xr(o.reg);
        if (op === 0x28) this.xcopy(x, this.xsrc(o)); else if (o.addr === undefined) this.xcopy(this.xr(o.rm), x); else this.xstore(o.addr, x);
        return true;
      }
      case 0x12: case 0x13: case 0x16: case 0x17: {  // movlps/movhlps, movlps store, movhps/movlhps, movhps store
        const o = this.modrm(), x = this.xr(o.reg), hi = op >= 0x16;
        if (op === 0x13 || op === 0x17) { this.xstore(o.addr, new DataView(this.xmmBuf, this.xmmOff + o.reg * 16 + (hi ? 8 : 0), 8), 8); return true; }
        if (o.addr === undefined) { const s = this.xr(o.rm); if (hi) this.xcopy(x, s, 8, 8, 0); else this.xcopy(x, s, 8, 0, 8); }   // movlhps / movhlps
        else { x.setUint32(hi ? 8 : 0, m.r32(o.addr), true); x.setUint32(hi ? 12 : 4, m.r32((o.addr + 4) >>> 0), true); }
        return true;
      }
      case 0x14: case 0x15: {                      // unpcklps / unpckhps
        const o = this.modrm(), d = this.xr(o.reg), s = this.xsrc(o), k = op === 0x14 ? 0 : 8;
        const a0 = d.getUint32(k, true), a1 = d.getUint32(k + 4, true), b0 = s.getUint32(k, true), b1 = s.getUint32(k + 4, true);
        d.setUint32(0, a0, true); d.setUint32(4, b0, true); d.setUint32(8, a1, true); d.setUint32(12, b1, true);
        return true;
      }
      case 0xc6: {                                 // shufps imm: two lanes from dest, two from source
        const o = this.modrm(), d = this.xr(o.reg), s = this.xsrc(o), imm = this.f8();
        const v = [d.getUint32((imm & 3) * 4, true), d.getUint32(((imm >> 2) & 3) * 4, true), s.getUint32(((imm >> 4) & 3) * 4, true), s.getUint32(((imm >> 6) & 3) * 4, true)];
        v.forEach((x, i) => d.setUint32(i * 4, x, true));
        return true;
      }
      case 0x50: { const o = this.modrm(), s = this.xr(o.rm); let k = 0; for (let i = 0; i < 4; i++) k |= (s.getUint32(i * 4, true) >>> 31) << i; this.r[o.reg] = k; return true; }  // movmskps
      // ------------------------------------------------ SSE arithmetic (ps, or ss with F3)
      case 0x51: ps((a, b) => Math.sqrt(b), rep === 1); return true;
      case 0x52: ps((a, b) => 1 / Math.sqrt(b), rep === 1); return true;   // rsqrt (exact; the CPU's is a 12-bit estimate)
      case 0x53: ps((a, b) => 1 / b, rep === 1); return true;              // rcp (same)
      case 0x58: ps((a, b) => a + b, rep === 1); return true;
      case 0x59: ps((a, b) => a * b, rep === 1); return true;
      case 0x5c: ps((a, b) => a - b, rep === 1); return true;
      case 0x5d: ps((a, b) => (a < b ? a : b), rep === 1); return true;      // min/max: the source when unordered or equal
      case 0x5e: ps((a, b) => a / b, rep === 1); return true;
      case 0x5f: ps((a, b) => (a > b ? a : b), rep === 1); return true;
      case 0x54: bits((a, b) => a & b); return true;                         // andps
      case 0x55: bits((a, b) => ~a & b); return true;                        // andnps
      case 0x56: bits((a, b) => a | b); return true;                         // orps
      case 0x57: bits((a, b) => a ^ b); return true;                         // xorps
      case 0xc2: {                                 // cmpps / cmpss imm: all-ones lanes where true
        const o = this.modrm(), d = this.xr(o.reg), scalar = rep === 1, s = this.xsrc(o, scalar ? 4 : 16), imm = this.f8() & 7;
        for (let i = 0; i < (scalar ? 1 : 4); i++) {
          const a = d.getFloat32(i * 4, true), b = s.getFloat32(i * 4, true), un = Number.isNaN(a) || Number.isNaN(b);
          const t = [a === b, a < b, a <= b, un, !(a === b), !(a < b), !(a <= b), !un][imm];
          d.setUint32(i * 4, t ? 0xffffffff : 0, true);
        }
        return true;
      }
      case 0x2e: case 0x2f: {                      // ucomiss / comiss -> ZF PF CF
        const o = this.modrm(), a = this.xr(o.reg).getFloat32(0, true), b = this.xsrc(o, 4).getFloat32(0, true);
        let f = this.flags & ~(0x40 | 4 | 1 | 0x800 | 0x80 | 0x10);
        if (Number.isNaN(a) || Number.isNaN(b)) f |= 0x40 | 4 | 1; else if (a < b) f |= 1; else if (a === b) f |= 0x40;
        this.flags = f; return true;
      }
      // ------------------------------------------------ conversions
      case 0x2a: {                                 // cvtpi2ps xmm, mm/m64 | F3 cvtsi2ss xmm, r/m32
        const o = this.modrm(), d = this.xr(o.reg);
        if (rep === 1) { d.setFloat32(0, this.rd(o, 32) | 0, true); return true; }
        const s = this.msrc(o); d.setFloat32(0, s.getInt32(0, true), true); d.setFloat32(4, s.getInt32(4, true), true); return true;
      }
      case 0x2c: case 0x2d: {                      // cvttps2pi/cvtps2pi mm, xmm/m64 | F3 cvttss2si/cvtss2si r32, xmm/m32
        const o = this.modrm(), cv = op === 0x2c ? Math.trunc : v => this.mxRound(v);
        if (rep === 1) { this.r[o.reg] = toI32(cv(this.xsrc(o, 4).getFloat32(0, true))) >>> 0; return true; }
        const s = this.xsrc(o, 8), d = this.mr(o.reg);
        d.setInt32(0, toI32(cv(s.getFloat32(0, true))), true); d.setInt32(4, toI32(cv(s.getFloat32(4, true))), true); return true;
      }
      // ------------------------------------------------ state, cache control
      case 0xae: {
        const o = this.modrm();
        if (o.addr === undefined) return true;                               // sfence / lfence / mfence
        switch (o.reg) {
          case 2: this.mxcsr = m.r32(o.addr) & 0xffff; return true;          // ldmxcsr
          case 3: m.w32(o.addr, this.mxcsr); return true;                    // stmxcsr
          case 0: for (let k = 0; k < 512; k += 4) m.w32((o.addr + k) >>> 0, 0); m.w16(o.addr, this.fcw); m.w32((o.addr + 24) >>> 0, this.mxcsr); return true;  // fxsave (control words only)
          case 1: this.fcw = m.r16(o.addr); this.mxcsr = m.r32((o.addr + 24) >>> 0) & 0xffff; return true;                                           // fxrstor
          case 7: return true;                                               // clflush
        }
        break;
      }
      case 0x0d: this.modrm(); return true;                                  // prefetch (3DNow form)
      // ------------------------------------------------ MMX moves
      case 0x77: return true;                                                // emms
      case 0x6e: { const o = this.modrm(), d = this.mr(o.reg); d.setUint32(0, this.rd(o, 32), true); d.setUint32(4, 0); return true; }   // movd mm, r/m32
      case 0x7e: { const o = this.modrm(); this.wr(o, 32, this.mr(o.reg).getUint32(0, true)); return true; }                             // movd r/m32, mm
      case 0x6f: { const o = this.modrm(), d = this.mr(o.reg), s = this.msrc(o); d.setUint32(0, s.getUint32(0, true), true); d.setUint32(4, s.getUint32(4, true), true); return true; }
      case 0x7f: case 0xe7: {                      // movq mm/m64, mm; movntq m64, mm
        const o = this.modrm(), s = this.mr(o.reg);
        if (o.addr === undefined) { const d = this.mr(o.rm); d.setUint32(0, s.getUint32(0, true), true); d.setUint32(4, s.getUint32(4, true), true); }
        else { m.w32(o.addr, s.getUint32(0, true)); m.w32((o.addr + 4) >>> 0, s.getUint32(4, true)); }
        return true;
      }
      // ------------------------------------------------ MMX arithmetic and logic
      case 0xfc: mmx(1, false, (a, b) => a + b); return true;               // paddb
      case 0xfd: mmx(2, false, (a, b) => a + b); return true;               // paddw
      case 0xfe: mmx(4, false, (a, b) => a + b); return true;               // paddd
      case 0xf8: mmx(1, false, (a, b) => a - b); return true;               // psubb
      case 0xf9: mmx(2, false, (a, b) => a - b); return true;               // psubw
      case 0xfa: mmx(4, false, (a, b) => a - b); return true;               // psubd
      case 0xec: mmx(1, true, (a, b) => sat(a + b, -128, 127)); return true;          // paddsb
      case 0xed: mmx(2, true, (a, b) => sat(a + b, -32768, 32767)); return true;      // paddsw
      case 0xe8: mmx(1, true, (a, b) => sat(a - b, -128, 127)); return true;          // psubsb
      case 0xe9: mmx(2, true, (a, b) => sat(a - b, -32768, 32767)); return true;      // psubsw
      case 0xdc: mmx(1, false, (a, b) => sat(a + b, 0, 255)); return true;            // paddusb
      case 0xdd: mmx(2, false, (a, b) => sat(a + b, 0, 65535)); return true;          // paddusw
      case 0xd8: mmx(1, false, (a, b) => sat(a - b, 0, 255)); return true;            // psubusb
      case 0xd9: mmx(2, false, (a, b) => sat(a - b, 0, 65535)); return true;          // psubusw
      case 0xd5: mmx(2, true, (a, b) => Math.imul(a, b)); return true;                // pmullw
      case 0xe5: mmx(2, true, (a, b) => Math.imul(a, b) >> 16); return true;          // pmulhw
      case 0xe4: mmx(2, false, (a, b) => Math.floor(a * b / 65536)); return true;                // pmulhuw
      case 0xe0: mmx(1, false, (a, b) => (a + b + 1) >> 1); return true;              // pavgb
      case 0xe3: mmx(2, false, (a, b) => (a + b + 1) >> 1); return true;              // pavgw
      case 0xda: mmx(1, false, Math.min); return true;                                // pminub
      case 0xde: mmx(1, false, Math.max); return true;                                // pmaxub
      case 0xea: mmx(2, true, Math.min); return true;                                 // pminsw
      case 0xee: mmx(2, true, Math.max); return true;                                 // pmaxsw
      case 0x74: mmx(1, false, (a, b) => (a === b ? -1 : 0)); return true;            // pcmpeqb
      case 0x75: mmx(2, false, (a, b) => (a === b ? -1 : 0)); return true;            // pcmpeqw
      case 0x76: mmx(4, false, (a, b) => (a === b ? -1 : 0)); return true;            // pcmpeqd
      case 0x64: mmx(1, true, (a, b) => (a > b ? -1 : 0)); return true;               // pcmpgtb
      case 0x65: mmx(2, true, (a, b) => (a > b ? -1 : 0)); return true;               // pcmpgtw
      case 0x66: mmx(4, true, (a, b) => (a > b ? -1 : 0)); return true;               // pcmpgtd
      case 0xdb: mmx(4, false, (a, b) => a & b); return true;                         // pand
      case 0xdf: mmx(4, false, (a, b) => ~a & b); return true;                        // pandn
      case 0xeb: mmx(4, false, (a, b) => a | b); return true;                         // por
      case 0xef: mmx(4, false, (a, b) => a ^ b); return true;                         // pxor
      case 0xf5: {                                 // pmaddwd
        const o = this.modrm(), d = this.mr(o.reg), s = this.msrc(o), w = i => d.getInt16(i * 2, true) * s.getInt16(i * 2, true);
        const lo = (w(0) + w(1)) | 0, hi = (w(2) + w(3)) | 0; d.setInt32(0, lo, true); d.setInt32(4, hi, true); return true;
      }
      case 0xf6: {                                 // psadbw
        const o = this.modrm(), d = this.mr(o.reg), s = this.msrc(o); let t = 0;
        for (let i = 0; i < 8; i++) t += Math.abs(d.getUint8(i) - s.getUint8(i)); d.setUint32(0, t, true); d.setUint32(4, 0); return true;
      }
      case 0x60: case 0x61: case 0x62: case 0x68: case 0x69: case 0x6a: {   // punpckl/h bw wd dq
        const o = this.modrm(); unpack(this.mr(o.reg), this.msrc(o), 1 << ((op & 7) & 3), op >= 0x68); return true;
      }
      case 0x63: { const o = this.modrm(); pack(this.mr(o.reg), this.msrc(o), 2, true); return true; }   // packsswb
      case 0x67: { const o = this.modrm(); pack(this.mr(o.reg), this.msrc(o), 2, false); return true; }  // packuswb
      case 0x6b: { const o = this.modrm(); pack(this.mr(o.reg), this.msrc(o), 4, true); return true; }   // packssdw
      case 0x70: {                                 // pshufw imm
        const o = this.modrm(), d = this.mr(o.reg), s = this.msrc(o), imm = this.f8(), w = [0, 1, 2, 3].map(i => s.getUint16(((imm >> (i * 2)) & 3) * 2, true));
        w.forEach((x, i) => d.setUint16(i * 2, x, true)); return true;
      }
      case 0xc5: { const o = this.modrm(), imm = this.f8(); this.r[o.reg] = this.mr(o.rm).getUint16((imm & 3) * 2, true); return true; }   // pextrw
      case 0xc4: { const o = this.modrm(), imm = this.f8(); this.mr(o.reg).setUint16((imm & 3) * 2, this.rd(o, 16), true); return true; }   // pinsrw
      case 0xd7: { const o = this.modrm(), s = this.mr(o.rm); let k = 0; for (let i = 0; i < 8; i++) k |= (s.getUint8(i) >> 7) << i; this.r[o.reg] = k; return true; } // pmovmskb
      case 0x71: case 0x72: case 0x73: {           // shift by immediate: /2 right logical, /4 right arithmetic, /6 left
        const o = this.modrm(), n = this.f8(); shift(this.mr(o.rm), op === 0x71 ? 2 : op === 0x72 ? 4 : 8, o.reg, n); return true;
      }
      case 0xd1: case 0xd2: case 0xd3: case 0xe1: case 0xe2: case 0xf1: case 0xf2: case 0xf3: {   // shift by mm/m64 count
        const o = this.modrm(), c = this.msrc(o), n = c.getUint32(4, true) ? 64 : c.getUint32(0, true);
        const size = [2, 4, 8][(op & 3) - 1], kind = op >= 0xf0 ? 6 : op >= 0xe0 ? 4 : 2;
        shift(this.mr(o.reg), size, kind, Math.min(n, 64)); return true;
      }
    }
    return false;
  };
}
