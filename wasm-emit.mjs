// Minimal WebAssembly binary writer: one module, imported memory + functions, exported functions.
const uleb = (n, out) => { n >>>= 0; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); };
const sleb = (n, out) => { n |= 0; for (;;) { const b = n & 0x7f; n >>= 7; if ((n === 0 && !(b & 0x40)) || (n === -1 && (b & 0x40))) { out.push(b); return; } out.push(b | 0x80); } };
const str = (s, out) => { const b = Buffer.from(s); uleb(b.length, out); out.push(...b); };
const append = (out, a) => { for (let i = 0; i < a.length; i++) out.push(a[i]); };   // (push(...a) throws for large arrays)
const section = (id, body, out) => { out.push(id); uleb(body.length, out); append(out, body); };
export const I32 = 0x7f, F64 = 0x7c, F32 = 0x7d;

// function body builder: emits opcodes into a byte array
export class Code {
  constructor() { this.b = []; }
  op(...x) { this.b.push(...x); return this; }
  i32(n) { this.b.push(0x41); sleb(n | 0, this.b); return this; }
  get(i) { this.b.push(0x20); uleb(i, this.b); return this; }
  set(i) { this.b.push(0x21); uleb(i, this.b); return this; }
  tee(i) { this.b.push(0x22); uleb(i, this.b); return this; }
  call(i) { this.b.push(0x10); uleb(i, this.b); return this; }
  callIndirect(type) { this.b.push(0x11); uleb(type, this.b); this.b.push(0x00); return this; }
  loop() { this.b.push(0x03, 0x40); return this; }
  load(off = 0) { this.b.push(0x28, 2); uleb(off, this.b); return this; }       // i32.load align 4
  store(off = 0) { this.b.push(0x36, 2); uleb(off, this.b); return this; }
  load8u() { this.b.push(0x2d, 0, 0); return this; }
  load16u() { this.b.push(0x2f, 1, 0); return this; }
  load8s() { this.b.push(0x2c, 0, 0); return this; }
  load16s() { this.b.push(0x2e, 1, 0); return this; }
  store8() { this.b.push(0x3a, 0, 0); return this; }
  loadF32(off = 0) { this.b.push(0x2a, 2); uleb(off, this.b); return this; }
  loadF64(off = 0) { this.b.push(0x2b, 3); uleb(off, this.b); return this; }
  storeF32(off = 0) { this.b.push(0x38, 2); uleb(off, this.b); return this; }
  storeF64(off = 0) { this.b.push(0x39, 3); uleb(off, this.b); return this; }
  storeI16(off = 0) { this.b.push(0x3b, 1); uleb(off, this.b); return this; }
  f64(v) { const t = new DataView(new ArrayBuffer(8)); t.setFloat64(0, v, true); this.b.push(0x44); for (let i = 0; i < 8; i++) this.b.push(t.getUint8(i)); return this; }
  store16() { this.b.push(0x3b, 1, 0); return this; }
  if_(t = 0x40) { this.b.push(0x04, t); return this; }
  else_() { this.b.push(0x05); return this; }
  end() { this.b.push(0x0b); return this; }
  block() { this.b.push(0x02, 0x40); return this; }
  br(d) { this.b.push(0x0c); uleb(d, this.b); return this; }
  brIf(d) { this.b.push(0x0d); uleb(d, this.b); return this; }
  ret() { this.b.push(0x0f); return this; }
}
export const OP = { add: 0x6a, sub: 0x6b, mul: 0x6c, and: 0x71, or: 0x72, xor: 0x73, shl: 0x74, shrS: 0x75, shrU: 0x76,
  eqz: 0x45, eq: 0x46, ne: 0x47, ltS: 0x48, ltU: 0x49, gtS: 0x4a, gtU: 0x4b, leS: 0x4c, leU: 0x4d, geS: 0x4e, geU: 0x4f, select: 0x1b, drop: 0x1a,
  popcnt: 0x69,
  // f64
  fadd: 0xa0, fsub: 0xa1, fmul: 0xa2, fdiv: 0xa3, fneg: 0x9a, fabs: 0x99, fsqrt: 0x9f, fnearest: 0x9e, ffloor: 0x9c, fceil: 0x9b, ftrunc: 0x9d,
  feq: 0x61, fne: 0x62, flt: 0x63, fgt: 0x64, fle: 0x65, fge: 0x66,
  promote: 0xbb, demote: 0xb6, fromI32: 0xb7, truncI32: 0xaa };

// module: imports = [{ mod, name, params, results }], funcs = [{ name, params, results, locals, code: Code }]
export function buildModule({ imports, funcs, memPages, table = false, extraTypes = [] }) {
  const types = [], typeIdx = sig => { const k = JSON.stringify(sig); let i = types.findIndex(t => t.k === k); if (i < 0) { types.push({ k, sig }); i = types.length - 1; } return i; };
  const imp = imports.map(f => ({ ...f, t: typeIdx([f.params, f.results]) }));
  for (const t of extraTypes) typeIdx(t);                         // types used by call_indirect, in order
  const fns = funcs.map(f => ({ ...f, t: typeIdx([f.params, f.results]) }));
  const out = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  let b = []; uleb(types.length, b); for (const { sig: [p, r] } of types) { b.push(0x60); uleb(p.length, b); b.push(...p); uleb(r.length, b); b.push(...r); } section(1, b, out);
  b = []; uleb(imp.length + 1 + (table ? 1 : 0), b);
  str("env", b); str("mem", b); b.push(0x02, 0x00); uleb(memPages, b);           // memory import, min pages
  if (table) { str("env", b); str("tbl", b); b.push(0x01, 0x70, 0x00); uleb(table, b); }   // funcref table import, min size
  for (const f of imp) { str(f.mod, b); str(f.name, b); b.push(0x00); uleb(f.t, b); }
  section(2, b, out);
  b = []; uleb(fns.length, b); for (const f of fns) uleb(f.t, b); section(3, b, out);
  b = []; uleb(fns.length, b); fns.forEach((f, i) => { str(f.name, b); b.push(0x00); uleb(imp.length + i, b); }); section(7, b, out);
  b = []; uleb(fns.length, b);
  for (const f of fns) {
    const body = []; const groups = []; if (f.locals) groups.push([f.locals, I32]); if (f.flocals) groups.push([f.flocals, F64]);
    uleb(groups.length, body); for (const [n, t] of groups) { uleb(n, body); body.push(t); }
    append(body, f.code.b); body.push(0x0b);
    uleb(body.length, b); append(b, body);
  }
  section(10, b, out);
  return new Uint8Array(out);
}
