// nr2003-dat.mjs — Papyrus NR2003 .dat archives (track / car packs) and PKWARE DCL "implode" decompression.
//
// Archive: u16 (0xFEF9 / 0xFF1D seen: not a fixed magic), u32 directory size, u16 0; then the directory, one entry per file:
//   u8 5, u8 method (0 stored, 2 imploded), u32 size, u32 stored size, u32 offset (from the file start), u8 name
//   length, the name, a NUL. Names may carry a folder ("trackmat\asphalt.mip").
// Imploded data: PKWARE Data Compression Library (byte 0: 0 binary literals / 1 coded ASCII literals; byte 1:
// dictionary size 4..6 = 1K..4K), decoded as zlib's contrib/blast does.
//
// usage: import { readDat } from "./nr2003-dat.mjs"; const dat = readDat(buffer); dat.names(); dat.get("aa.3do")
//        node nr2003-dat.mjs list <file.dat> | extract <file.dat> <outDir>

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";

export function readDat(buf) {
  const end = 8 + buf.readUInt32LE(2), entries = [];
  if (end > buf.length || buf[10] !== 5) throw new Error("not an NR2003 .dat archive");
  for (let p = 8; p < end;) {
    if (buf[p] !== 5) { p++; continue; }               // (2 bytes of padding before the first entry)
    const method = buf[p + 1], size = buf.readUInt32LE(p + 2), stored = buf.readUInt32LE(p + 6), offset = buf.readUInt32LE(p + 10), n = buf[p + 14];
    const name = buf.subarray(p + 15, p + 15 + n).toString("latin1").replace(/\0.*$/, "");
    entries.push({ name, method, size, stored, offset }); p += 16 + n;
  }
  const byName = new Map(entries.map(e => [e.name.toLowerCase(), e]));
  const data = e => { const raw = buf.subarray(e.offset, e.offset + e.stored); if (e.method === 0) return Buffer.from(raw);
    if (e.method === 2) { const out = explode(raw); if (out.length !== e.size) throw new Error(`${e.name}: ${out.length} bytes, expected ${e.size}`); return out; }
    throw new Error(`${e.name}: unknown method ${e.method}`); };
  return { entries, names: () => entries.map(e => e.name), has: n => byName.has(n.toLowerCase()),
    get: n => { const e = byName.get(n.toLowerCase()) ?? entries.find(x => basename(x.name.replace(/\\/g, "/")).toLowerCase() === n.toLowerCase()); return e ? data(e) : null; } };
}

// ---- PKWARE DCL explode (after zlib contrib/blast/blast.c, Mark Adler)
const LITLEN = [11, 124, 8, 7, 28, 7, 188, 13, 76, 4, 10, 8, 12, 10, 12, 10, 8, 23, 8, 9, 7, 6, 7, 8, 7, 6, 55, 8, 23, 24, 12, 11, 7, 9, 11, 12, 6, 7, 22, 5, 7, 24, 6, 11, 9, 6, 7, 22, 7, 11, 38, 7, 9, 8, 25, 11, 8, 11, 9, 12, 8, 12, 5, 38, 5, 38, 5, 11, 7, 5, 6, 21, 6, 10, 53, 8, 7, 24, 10, 27, 44, 253, 253, 253, 252, 252, 252, 13, 12, 45, 12, 45, 12, 61, 12, 45, 44, 173];
const LENLEN = [2, 35, 36, 53, 38, 23], DISTLEN = [2, 20, 53, 230, 247, 151, 248];
const BASE = [3, 2, 4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 40, 72, 136, 264], EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8];
function construct(rep) {                             // compact run-length code lengths -> canonical Huffman tables
  const length = []; for (const r of rep) { const len = r & 15; let n = (r >> 4) + 1; while (n--) length.push(len); }
  const count = new Array(14).fill(0); for (const l of length) count[l]++;
  const offs = [0, 0]; for (let l = 1; l < 13; l++) offs[l + 1] = offs[l] + count[l];
  const symbol = new Array(length.length); for (let s = 0; s < length.length; s++) if (length[s]) symbol[offs[length[s]]++] = s;
  return { count, symbol };
}
const LIT = construct(LITLEN), LEN = construct(LENLEN), DIST = construct(DISTLEN);
export function explode(src) {
  let pos = 0, bitbuf = 0, bitcnt = 0;
  const bits = need => { let v = bitbuf; while (bitcnt < need) { if (pos >= src.length) throw new Error("explode: input ends early"); v |= src[pos++] << bitcnt; bitcnt += 8; } bitbuf = v >> need; bitcnt -= need; return v & ((1 << need) - 1); };
  const decode = h => {                               // codes are stored bit-reversed
    let code = 0, first = 0, index = 0;
    for (let len = 1; len <= 13; len++) { code |= bits(1) ^ 1; const count = h.count[len]; if (code < first + count) return h.symbol[index + (code - first)]; index += count; first += count; first <<= 1; code <<= 1; }
    throw new Error("explode: bad code");
  };
  const lit = bits(8); if (lit > 1) throw new Error("explode: bad literal flag"); const dict = bits(8); if (dict < 4 || dict > 6) throw new Error("explode: bad dictionary size");
  const out = [];
  for (;;) {
    if (bits(1)) {
      const symbol = decode(LEN), len = BASE[symbol] + bits(EXTRA[symbol]); if (len === 519) break;
      const sym2 = len === 2 ? 2 : dict, dist = (decode(DIST) << sym2) + bits(sym2) + 1;
      if (dist > out.length) throw new Error("explode: distance too far back");
      for (let k = 0; k < len; k++) out.push(out[out.length - dist]);
    } else out.push(lit ? decode(LIT) : bits(8));
  }
  return Buffer.from(out);
}

if (process.argv[1] && basename(process.argv[1]) === "nr2003-dat.mjs") {
  const [cmd, file, outDir] = process.argv.slice(2), dat = readDat(readFileSync(file));
  if (cmd === "list") for (const e of dat.entries) console.log(`${String(e.size).padStart(9)} ${e.method ? "imploded" : "stored  "} ${e.name}`);
  else if (cmd === "extract") { for (const e of dat.entries) { const f = join(outDir, ...e.name.split("\\")); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, dat.get(e.name)); } console.log(`${dat.entries.length} files -> ${outDir}`); }
  else console.log("usage: node nr2003-dat.mjs list <file.dat> | extract <file.dat> <outDir>");
}
