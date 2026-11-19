// recomp-scan.mjs — static recompilation, step 1: how much of the code the game runs can be found statically?
// Recursive descent over default.exe (direct calls, conditional / direct jumps, jump tables) from the entry point,
// from code addresses found in the data sections, and from the block starts the game has run (the JavaScript and
// WebAssembly block caches in jit-cache/), compared with the instruction addresses those caches record and, if
// recomp-samples.json exists (recomp-sample.mjs), with where race time goes. Usage: node recomp-scan.mjs
import fs from "node:fs"; import zlib from "node:zlib"; import { dirname } from "node:path"; import { fileURLToPath } from "node:url";
const OUT = dirname(fileURLToPath(import.meta.url));
const b = fs.readFileSync(`${OUT}/default.exe`);
const pe = b.readUInt32LE(0x3c), nsec = b.readUInt16LE(pe + 6), opt = pe + 24, optsz = b.readUInt16LE(pe + 20);
const BASE = b.readUInt32LE(opt + 28), ENTRY = BASE + b.readUInt32LE(opt + 16);
const secs = []; for (let i = 0; i < nsec; i++) { const o = opt + optsz + i * 40; secs.push({ name: b.toString("latin1", o, o + 8).replace(/\0+$/, ""), va: BASE + b.readUInt32LE(o + 12), vs: b.readUInt32LE(o + 8), raw: b.readUInt32LE(o + 20), rs: b.readUInt32LE(o + 16), ch: b.readUInt32LE(o + 36) }); }
const SIZE = Math.max(...secs.map(s => s.va + s.vs)) - BASE, img = new Uint8Array(SIZE);
for (const s of secs) img.set(b.subarray(s.raw, s.raw + Math.min(s.rs, s.vs)), s.va - BASE);
const CODE = [".text", "D3D", "D3DX", "XGRPH", "DSOUND", "WMADEC", "XPP"].map(n => secs.find(s => s.name === n));
const isCode = a => CODE.some(s => a >= s.va && a < s.va + s.vs);
const r8 = a => img[a - BASE], r32 = a => (img[a - BASE] | img[a - BASE + 1] << 8 | img[a - BASE + 2] << 16 | img[a - BASE + 3] << 24) >>> 0, s8 = a => (r8(a) << 24) >> 24;
const PRE = new Set([0x66, 0xf2, 0xf3, 0x64, 0x2e, 0x3e, 0x26, 0x36, 0x65, 0xf0]);
// length (x86-jit LengthProbe rules, plus loop/jecxz, int, a few more)
function len(at) {
  let p = at, op = r8(p), o16 = false; while (PRE.has(op)) { if (op === 0x66) o16 = true; op = r8(++p); } p++;
  const modrm = () => { const x = r8(p++), mod = x >> 6, rm = x & 7; if (mod === 3) return; if (rm === 4) { const sib = r8(p++); if ((sib & 7) === 5 && mod === 0) p += 4; } else if (rm === 5 && mod === 0) p += 4; if (mod === 1) p += 1; else if (mod === 2) p += 4; };
  const iv = o16 ? 2 : 4;
  if (op === 0x0f) { const o2 = r8(p++); if (o2 >= 0x80 && o2 < 0x90) return p + 4 - at; if ([0x31, 0xa2, 0x08, 0x09, 0x77, 0x0b, 0x05, 0x06, 0x30, 0x32].includes(o2) || (o2 >= 0xc8 && o2 < 0xd0)) return p - at;
    modrm(); if ([0xa4, 0xac, 0xba, 0x70, 0x71, 0x72, 0x73, 0xc2, 0xc4, 0xc5, 0xc6].includes(o2)) p += 1; return p - at; }
  if (op >= 0xd8 && op <= 0xdf) { modrm(); return p - at; }
  if (op < 0x40 && (op & 7) < 6) { const f = op & 7; if (f === 4) p += 1; else if (f === 5) p += iv; else modrm(); return p - at; }
  if (op < 0x40) return p - at;                                         // push/pop seg, daa...
  if (op >= 0x40 && op < 0x62) return p - at;
  if (op >= 0x70 && op < 0x80) return p + 1 - at;
  if (op >= 0x90 && op < 0xa0) return op === 0x9a ? p + 6 - at : p - at;
  if (op >= 0xb0 && op < 0xb8) return p + 1 - at;
  if (op >= 0xb8 && op < 0xc0) return p + iv - at;
  if (op >= 0xe0 && op <= 0xe3) return p + 1 - at;
  if (op >= 0xe4 && op <= 0xe7) return p + 1 - at;
  if (op >= 0xec && op <= 0xef) return p - at;
  switch (op) {
    case 0x68: return p + iv - at; case 0x6a: return p + 1 - at; case 0x69: modrm(); return p + iv - at; case 0x6b: modrm(); return p + 1 - at;
    case 0x80: case 0x82: case 0x83: case 0xc0: case 0xc1: case 0xc6: modrm(); return p + 1 - at;
    case 0x81: case 0xc7: modrm(); return p + iv - at;
    case 0xa0: case 0xa1: case 0xa2: case 0xa3: return p + 4 - at; case 0xa8: return p + 1 - at; case 0xa9: return p + iv - at;
    case 0xc2: case 0xca: return p + 2 - at; case 0xc8: return p + 3 - at; case 0xcd: return p + 1 - at;
    case 0xe8: case 0xe9: return p + 4 - at; case 0xeb: return p + 1 - at; case 0xea: return p + 6 - at;
    case 0xf6: case 0xf7: { const reg = (r8(p) >> 3) & 7; modrm(); if (reg < 2) p += op === 0xf6 ? 1 : iv; return p - at; }
    case 0x62: case 0x63: case 0x84: case 0x85: case 0x86: case 0x87: case 0x88: case 0x89: case 0x8a: case 0x8b: case 0x8c: case 0x8d: case 0x8e: case 0x8f:
    case 0xc4: case 0xc5: case 0xd0: case 0xd1: case 0xd2: case 0xd3: case 0xfe: case 0xff: modrm(); return p - at;
    case 0xa4: case 0xa5: case 0xa6: case 0xa7: case 0xaa: case 0xab: case 0xac: case 0xad: case 0xae: case 0xaf: case 0xc3: case 0xcb: case 0xc9: case 0xcc: case 0xce: case 0xcf:
    case 0xd7: case 0xf4: case 0xf5: case 0xf8: case 0xf9: case 0xfa: case 0xfb: case 0xfc: case 0xfd: case 0x60: case 0x61: case 0x6c: case 0x6d: case 0x6e: case 0x6f: case 0xd4: case 0xd5: case 0xf1: return p - at;
  }
  return null;
}
// control flow of one instruction
function flow(at, n) {
  let p = at, op = r8(p); while (PRE.has(op)) op = r8(++p);
  const end = at + n;
  if (op >= 0x70 && op < 0x80 || op >= 0xe0 && op <= 0xe3) return { k: "jcc", t: (end + s8(end - 1)) >>> 0 };
  if (op === 0x0f && r8(p + 1) >= 0x80 && r8(p + 1) < 0x90) return { k: "jcc", t: (end + r32(end - 4)) >>> 0 };
  if (op === 0xeb) return { k: "jmp", t: (end + s8(end - 1)) >>> 0 };
  if (op === 0xe9) return { k: "jmp", t: (end + r32(end - 4)) >>> 0 };
  if (op === 0xe8) return { k: "call", t: (end + r32(end - 4)) >>> 0 };
  if (op === 0xc3 || op === 0xc2 || op === 0xcb || op === 0xca || op === 0xcf) return { k: "ret" };
  if (op === 0xcc || op === 0xf4 || op === 0xea || op === 0x9a) return { k: "stop" };
  if (op === 0xff) { const reg = (r8(p + 1) >> 3) & 7;
    if (reg === 2) return { k: "callind" };
    if (reg === 4) { const mr = r8(p + 1); if ((mr >> 6) === 0 && (mr & 7) === 4) { const sib = r8(p + 2); if ((sib >> 6) === 2 && (sib & 7) === 5) return { k: "table", table: r32(p + 3), idx: (sib >> 3) & 7 }; } return { k: "jmpind" }; }
    if (reg === 3 || reg === 5) return { k: "stop" }; }
  return { k: "seq" };
}
// recursive descent from seeds
function descend(seeds, tables = true) {
  const insn = new Map(), funcs = new Set(), work = [...seeds], st = { unknown: 0, callind: 0, jmpind: 0, tables: 0, tableEntries: 0, unknownOps: new Map() };
  for (const s of seeds) funcs.add(s);
  while (work.length) {
    let a = work.pop();
    while (true) {
      if (!isCode(a) || insn.has(a)) break;
      const n = len(a); if (n === null) { st.unknown++; const k = r8(a).toString(16); st.unknownOps.set(k, (st.unknownOps.get(k) ?? 0) + 1); break; }
      insn.set(a, n); const f = flow(a, n);
      if (f.k === "jcc") { work.push(f.t); a += n; continue; }
      if (f.k === "jmp") { work.push(f.t); break; }
      if (f.k === "call") { if (isCode(f.t)) { funcs.add(f.t); work.push(f.t); } a += n; continue; }
      if (f.k === "callind") { st.callind++; a += n; continue; }
      if (f.k === "table") { st.tables++; if (tables) { for (let i = 0; i < 1024; i++) { const t = r32(f.table + i * 4); if (!isCode(t) || f.table + i * 4 - BASE >= SIZE) break; st.tableEntries++; work.push(t); } } break; }
      if (f.k === "jmpind") { st.jmpind++; break; }
      if (f.k === "ret" || f.k === "stop") break;
      a += n;
    }
  }
  return { insn, funcs, st };
}
// executed instruction addresses (both block caches: JS index, WebAssembly sidecars)
const dyn = new Set(), dynStarts = new Set();
for (const d of fs.readdirSync(`${OUT}/jit-cache`)) {
  const dir = `${OUT}/jit-cache/${d}`;
  if (/^[0-9a-f]{16}$/.test(d)) { const ix = JSON.parse(fs.readFileSync(`${dir}/index.json`)); for (const [s, e] of Object.entries(ix.blocks)) { dynStarts.add(+s); for (const a of e[3]) dyn.add(a); } }
  else if (/^w[0-9a-f]{15}$/.test(d)) for (const f of fs.readdirSync(dir)) if (f.endsWith(".jz")) for (const bl of JSON.parse(zlib.gunzipSync(fs.readFileSync(`${dir}/${f}`)))) { dynStarts.add(bl.start); for (const a of bl.ats) dyn.add(a); }
}
const dynCode = [...dyn].filter(isCode), dynStartsCode = [...dynStarts].filter(isCode);
// data words that point at code (vtables, callback tables): accepted when they decode to a plausible instruction
const dataPtrs = new Set();
for (const s of secs) if (!CODE.includes(s) && s.name !== "DOLBY") for (let a = s.va; a + 4 <= s.va + Math.min(s.vs, s.rs); a += 4) { const t = r32(a); if (isCode(t) && len(t) !== null) dataPtrs.add(t); }
// code words that are immediates pointing at code (push offset callback / mov reg, offset)
const cov = (r) => { let c = 0; for (const a of dynCode) if (r.insn.has(a)) c++; return c / dynCode.length; };
const report = (name, r) => console.log(`${name.padEnd(46)} instructions ${r.insn.size.toString().padStart(7)}  functions ${r.funcs.size.toString().padStart(6)}  covers ${(100 * cov(r)).toFixed(1)}% of executed  | indirect calls ${r.st.callind}, indirect jumps ${r.st.jmpind}, jump tables ${r.st.tables} (${r.st.tableEntries} entries), undecodable ${r.st.unknown}`);
console.log(`image ${BASE.toString(16)}+${SIZE.toString(16)}, entry ${ENTRY.toString(16)}; executed instruction addresses known: ${dynCode.length} (block starts ${dynStartsCode.length}); data words pointing into code: ${dataPtrs.size}`);
const A = descend([ENTRY]); report("entry + direct calls + jump tables", A);
const B = descend([ENTRY, ...dataPtrs]); report("+ code pointers found in data", B);
const C = descend([ENTRY, ...dataPtrs, ...dynStartsCode]); report("+ every block start the game has run", C);
if (process.argv.includes("--save")) { fs.writeFileSync(`${OUT}/recomp-functions.json`, JSON.stringify([...B.funcs].sort((x, y) => x - y))); console.log(`saved ${B.funcs.size} function entries -> recomp-functions.json`); }
const missing = dynCode.filter(a => !C.insn.has(a)); console.log("executed but still not found:", missing.length, missing.slice(0, 10).map(a => a.toString(16)).join(" "));
console.log("undecodable opcodes (with data seeds):", [...B.st.unknownOps].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k}:${v}`).join(" "));

// time-weighted: samples of the running instruction during a race (recomp-sample.mjs)
if (fs.existsSync(`${OUT}/recomp-samples.json`)) {
  const S = JSON.parse(fs.readFileSync(`${OUT}/recomp-samples.json`)); let inImg = 0, inB = 0, inC = 0;
  for (const a of S) { if (isCode(a)) { inImg++; if (B.insn.has(a)) inB++; if (C.insn.has(a)) inC++; } }
  console.log(`race samples ${S.length}: in game code ${(100 * inImg / S.length).toFixed(1)}%; of those found statically (data pointers) ${(100 * inB / inImg).toFixed(1)}%, with run block starts ${(100 * inC / inImg).toFixed(1)}%`);
  const fl = [...B.funcs].sort((x, y) => x - y), fnOf = a => { let lo = 0, hi = fl.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (fl[m] <= a) { r = fl[m]; lo = m + 1; } else hi = m - 1; } return r; };
  const per = new Map(); for (const a of S) if (isCode(a)) { const f = fnOf(a); per.set(f, (per.get(f) ?? 0) + 1); }
  const top = [...per].sort((x, y) => y[1] - x[1]); let acc = 0; const marks = [10, 50, 100, 300, 1000];
  top.forEach(([f, n], i) => { acc += n; if (marks.includes(i + 1)) console.log(`  top ${i + 1} functions: ${(100 * acc / inImg).toFixed(1)}% of game-code time`); });
  console.log("  functions with any sample:", top.length, "| hottest:", top.slice(0, 8).map(([f, n]) => `${f.toString(16)} ${(100 * n / inImg).toFixed(1)}%`).join(", "));
}
