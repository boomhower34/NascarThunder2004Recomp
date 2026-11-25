// ea-lzh1.mjs — decompressor for EA ll_api compression method 5 "LZH1" (and method 0 "NONE"),
// as used by TERF bundles that carry a COMP chunk.
//
// Reconstructed from the game executable (codec table 0x206054; decompress init 0x124790,
// block reader 0x123690, symbol loop 0x123060). The format is a simplified DEFLATE:
//   * bit stream is read MSB-first, bytes in order
//   * block: 1 bit "last". If 1 -> end of stream (followed by 32 bits that the game reads and ignores).
//            If 0 -> 285 x 4-bit literal/length code lengths, then 30 x 4-bit distance code lengths,
//            then Huffman symbols until symbol 256 (end of block).
//   * code lengths become canonical Huffman codes exactly as in DEFLATE (RFC 1951 3.2.2)
//   * literal/length symbols: 0-255 literal, 256 end of block, 257-284 match length
//     (DEFLATE length table, except symbol 284 = length 227 with no extra bits)
//   * distance symbols: DEFLATE distance table (1..32768); window 32 KB
//
// usage (library): import { decompress } from "./ea-lzh1.mjs"; decompress(method, buf, expectedSize)

const LEN_EXTRA = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,0];
const LEN_BASE  = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227];
const DIST_EXTRA = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
const DIST_BASE  = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,
                    4097,6145,8193,12289,16385,24577];

export const Methods = { 0: "NONE", 1: "RLE1", 2: "HUFF", 3: "LZM1", 5: "LZH1" };

class BitReader {
  constructor(buf) { this.buf = buf; this.pos = 0; this.bit = 0; }
  read(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (this.pos >= this.buf.length) throw new Error("LZH1: unexpected end of compressed data");
      v = (v << 1) | ((this.buf[this.pos] >> (7 - this.bit)) & 1);
      if (++this.bit === 8) { this.bit = 0; this.pos++; }
    }
    return v >>> 0;
  }
}

// Canonical Huffman decoder: returns a function (BitReader) -> symbol.
function buildDecoder(lengths) {
  const count = new Array(16).fill(0);
  for (const l of lengths) count[l]++;
  count[0] = 0;
  // first code / first index for each length, symbols sorted by (length, symbol)
  const offs = new Array(16).fill(0);
  for (let l = 1; l < 16; l++) offs[l] = offs[l - 1] + count[l - 1];
  const sorted = [];
  for (let l = 1; l < 16; l++) for (let s = 0; s < lengths.length; s++) if (lengths[s] === l) sorted.push(s);
  return br => {
    let code = 0, first = 0, index = 0;
    for (let l = 1; l < 16; l++) {
      code |= br.read(1);
      const c = count[l];
      if (code - first < c) return sorted[index + code - first];
      index += c; first = (first + c) << 1; code <<= 1;
    }
    throw new Error("LZH1: invalid Huffman code");
  };
}

export function lzh1Decompress(src, expectedSize) {
  const br = new BitReader(src);
  const out = Buffer.alloc(expectedSize ?? src.length * 8);
  let op = 0;
  for (;;) {
    if (br.read(1)) break;                       // last-block flag: end of stream
    const litLens = Array.from({ length: 285 }, () => br.read(4));
    const distLens = Array.from({ length: 30 }, () => br.read(4));
    const lit = buildDecoder(litLens), dist = buildDecoder(distLens);
    for (;;) {
      const sym = lit(br);
      if (sym < 256) { out[op++] = sym; continue; }
      if (sym === 256) break;
      const l = sym - 257;
      const len = LEN_BASE[l] + (LEN_EXTRA[l] ? br.read(LEN_EXTRA[l]) : 0);
      const d = dist(br);
      const distance = DIST_BASE[d] + (DIST_EXTRA[d] ? br.read(DIST_EXTRA[d]) : 0);
      if (distance > op) throw new Error(`LZH1: distance ${distance} before start of output (at ${op})`);
      for (let i = 0; i < len; i++, op++) out[op] = out[op - distance];
    }
    if (expectedSize !== undefined && op >= expectedSize) break;
  }
  if (expectedSize !== undefined && op !== expectedSize)
    throw new Error(`LZH1: decompressed ${op} bytes, expected ${expectedSize}`);
  return out.subarray(0, op);
}

export function decompress(method, src, expectedSize) {
  if (method === 0) return src.subarray(0, expectedSize ?? src.length);
  if (method === 5) return lzh1Decompress(src, expectedSize);
  throw new Error(`compression method ${method} (${Methods[method] ?? "unknown"}) not supported`);
}
