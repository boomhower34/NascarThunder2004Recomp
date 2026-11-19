// file-bytes.mjs — a large read-only game file used like a Buffer without reading it all into memory.
//
// The game opens its sound and speech banks (NSPCHDAT.DAT 448 MB, NMUSIC.DAT 290 MB, NSOUND.DAT 108 MB) and other big
// archives on the way to the main menu; reading each one whole (readFileSync) took 0.3-1.3 s apiece on a fast disk
// (several seconds on a slower one) and kept ~850 MB in memory, while the game only ever reads a few entries of them
// (one track of music, the speech lines of a race). FileBytes reads on demand: the few calls a Buffer gets from the
// TERF parser (terf.mjs: length, readUInt32LE / readUInt16LE, toString, subarray) and from the file module (length,
// subarray) are served from the file, small reads through a cache of 64 KB blocks.
import { openSync, readSync, fstatSync, statSync, readFileSync } from "node:fs";

const BLOCK = 0x10000, KEEP = 64;
export class FileBytes {
  constructor(path) { this.path = path; this.fd = openSync(path, "r"); this.length = fstatSync(this.fd).size; this.blocks = new Map(); }
  block(k) {
    let b = this.blocks.get(k);
    if (b) { this.blocks.delete(k); this.blocks.set(k, b); return b; }         // (most recently used last)
    b = Buffer.alloc(Math.min(BLOCK, this.length - k * BLOCK)); readSync(this.fd, b, 0, b.length, k * BLOCK);
    this.blocks.set(k, b); if (this.blocks.size > KEEP) this.blocks.delete(this.blocks.keys().next().value);
    return b;
  }
  subarray(a = 0, b = this.length) {
    a = Math.max(0, Math.min(this.length, a)); b = Math.max(a, Math.min(this.length, b)); const n = b - a;
    if (!n) return Buffer.alloc(0);
    const k = Math.floor(a / BLOCK); if (Math.floor((b - 1) / BLOCK) === k) return this.block(k).subarray(a - k * BLOCK, b - k * BLOCK);
    const out = Buffer.alloc(n); readSync(this.fd, out, 0, n, a); return out;
  }
  slice(a, b) { return this.subarray(a, b); }
  readUInt8(p) { return this.subarray(p, p + 1)[0]; }
  readUInt16LE(p) { return this.subarray(p, p + 2).readUInt16LE(0); }
  readUInt32LE(p) { return this.subarray(p, p + 4).readUInt32LE(0); }
  readInt32LE(p) { return this.subarray(p, p + 4).readInt32LE(0); }
  toString(enc = "utf8", a = 0, b = this.length) { return this.subarray(a, b).toString(enc); }
}
// a game data file: whole in memory when small (most of them), read on demand from BIG bytes up
export const BIG = 24 * 1024 * 1024;
export function dataBytes(path) { return statSync(path).size >= BIG ? new FileBytes(path) : readFileSync(path); }
