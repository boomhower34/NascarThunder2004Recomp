// ea-mad.mjs — EA multimedia streams as used by the game's movies (MOVIES.DAT, PRMOVIES.DAT, UIS_VIDE.DAT, UIS_CVD*.DAT,
// WHATSNEW.DAT entries): EA "Madcow" video (MADk intra / MADm inter / MADe inter, not kept as reference) and EA ADPCM
// audio (R1 in the movies, R2 in the interviews), in plain JavaScript so the page can decode them itself.
//
// Stream: chunks { char tag[4], u32 size (LE, header included) }: SCHl audio header ("PT" patch), SCCl count, SCDl
// audio data, MADk/MADm/MADe video frames, SCEl end.
// Video frame: tag, u32 size, 6 bytes, u16 frame duration (ms), u16 width, u16 height, u8 ?, u8 quantiser, u16 ?,
// then the bitstream as 16-bit little-endian words read MSB first. Macroblocks 16x16 (4 Y + U + V 8x8 blocks, 4:2:0);
// intra blocks: DC = (128 + s8) * q[0], AC with the MPEG-1 coefficient VLCs (escape: s10 level, 6-bit run - 1),
// dequantised (level * q[j]) >> 4 then made odd, and EA's own 8x8 IDCT; inter macroblocks copy an 8x8 block from the
// previous kept frame at a whole-pixel motion vector and add a constant. (Format as FFmpeg's eamad / adpcm_ea_r*;
// the coefficient tables are MPEG-1's.)

const ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14,
  21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];
const AAN = [4096, 2953, 3135, 3483, 4096, 5213, 7568, 14846, 2953, 2129, 2260, 2511, 2953, 3759, 5457, 10703, 3135, 2260,
  2399, 2666, 3135, 3990, 5793, 11363, 3483, 2511, 2666, 2962, 3483, 4433, 6436, 12625, 4096, 2953, 3135, 3483, 4096, 5213,
  7568, 14846, 5213, 3759, 3990, 4433, 5213, 6635, 9633, 18895, 7568, 5457, 5793, 6436, 7568, 9633, 13985, 27432, 14846,
  10703, 11363, 12625, 14846, 18895, 27432, 53809];
const INTRA = [8, 16, 19, 22, 26, 27, 29, 34, 16, 16, 22, 24, 27, 29, 34, 37, 19, 22, 26, 27, 29, 34, 34, 38, 22, 22, 26, 27,
  29, 34, 37, 40, 22, 26, 27, 29, 32, 35, 40, 48, 26, 27, 29, 32, 35, 40, 48, 58, 26, 27, 29, 34, 38, 46, 56, 69, 27, 29,
  35, 38, 46, 56, 69, 83];
// MPEG-1 DCT coefficient VLCs: [code, length]; index 111 = escape, 112 = end of block
const VLC = [[3, 2], [4, 4], [5, 5], [6, 7], [38, 8], [33, 8], [10, 10], [29, 12], [24, 12], [19, 12], [16, 12], [26, 13], [25, 13], [24, 13], [23, 13], [31, 14], [30, 14], [29, 14], [28, 14], [27, 14], [26, 14], [25, 14], [24, 14], [23, 14], [22, 14], [21, 14], [20, 14], [19, 14], [18, 14], [17, 14], [16, 14], [24, 15], [23, 15], [22, 15], [21, 15], [20, 15], [19, 15], [18, 15], [17, 15], [16, 15], [3, 3], [6, 6], [37, 8], [12, 10], [27, 12], [22, 13], [21, 13], [31, 15], [30, 15], [29, 15], [28, 15], [27, 15], [26, 15], [25, 15], [19, 16], [18, 16], [17, 16], [16, 16], [5, 4], [4, 7], [11, 10], [20, 12], [20, 13], [7, 5], [36, 8], [28, 12], [19, 13], [6, 5], [15, 10], [18, 12], [7, 6], [9, 10], [18, 13], [5, 6], [30, 12], [20, 16], [4, 6], [21, 12], [7, 7], [17, 12], [5, 7], [17, 13], [39, 8], [16, 13], [35, 8], [26, 16], [34, 8], [25, 16], [32, 8], [24, 16], [14, 10], [23, 16], [13, 10], [22, 16], [8, 10], [21, 16], [31, 12], [26, 12], [25, 12], [23, 12], [22, 12], [31, 13], [30, 13], [29, 13], [28, 13], [27, 13], [31, 16], [30, 16], [29, 16], [28, 16], [27, 16], [1, 6], [2, 2]];
const LEVEL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 1, 2, 3, 4, 5, 1, 2, 3, 4, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
const RUN = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15, 16, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31];

// 16-bit lookup: entry = symbol << 5 | length (length 0: no code)
const LUT = (() => { const t = new Uint16Array(65536); VLC.forEach(([code, len], sym) => { const base = code << (16 - len), n = 1 << (16 - len); for (let i = 0; i < n; i++) t[base + i] = sym << 5 | len; }); return t; })();

class Bits {
  constructor(u8, off, end) { this.b = u8; this.p = off; this.end = end; this.acc = 0; this.n = 0; }
  fill() { while (this.n <= 16) { const p = this.p; const w = p + 1 < this.end ? (this.b[p + 1] << 8 | this.b[p]) : 0; this.p += 2; this.acc = (this.acc << 16 | w) >>> 0; this.n += 16; } }
  peek(k) { if (this.n < k) this.fill(); return (this.acc >>> (this.n - k)) & ((1 << k) - 1); }   // k <= 16
  skip(k) { this.n -= k; this.acc &= this.n >= 32 ? 0xffffffff : ((1 << this.n) - 1) >>> 0; }
  get(k) { const v = this.peek(k); this.skip(k); return v; }
  sget(k) { const v = this.get(k); return v >= 1 << (k - 1) ? v - (1 << k) : v; }
}

const clamp8 = v => v < 0 ? 0 : v > 255 ? 255 : v;
// EA IDCT (FFmpeg eaidct.c)
const ASQRT = 181, A4 = 669, A2 = 277, A5 = 196;
function idct1(s, so, st, d, dof, dst, final) {
  const s0 = s[so], s1 = s[so + st], s2 = s[so + 2 * st], s3 = s[so + 3 * st], s4 = s[so + 4 * st], s5 = s[so + 5 * st], s6 = s[so + 6 * st], s7 = s[so + 7 * st];
  const a1 = s1 + s7, a7 = s1 - s7, a5 = s5 + s3, a3 = s5 - s3, a2 = s2 + s6, a6 = (ASQRT * (s2 - s6)) >> 8, a0 = s0 + s4, a4 = s0 - s4;
  const b0 = (((A4 - A5) * a7 - A5 * a3) >> 9) + a1 + a5;
  const b1 = (((A4 - A5) * a7 - A5 * a3) >> 9) + ((ASQRT * (a1 - a5)) >> 8);
  const b2 = (((A2 + A5) * a3 + A5 * a7) >> 9) + ((ASQRT * (a1 - a5)) >> 8);
  const b3 = ((A2 + A5) * a3 + A5 * a7) >> 9;
  const v = [a0 + a2 + a6 + b0, a4 + a6 + b1, a4 - a6 + b2, a0 - a2 - a6 + b3, a0 - a2 - a6 - b3, a4 - a6 - b2, a4 + a6 - b1, a0 + a2 + a6 - b0];
  for (let k = 0; k < 8; k++) d[dof + k * dst] = final ? clamp8(v[k] >> 4) : (v[k] << 16 >> 16);
}
const tmp = new Int32Array(64);
function idctPut(block, out, off, stride) {
  block[0] += 4;
  // columns (block column i -> tmp column i), then rows (tmp row i -> output row i, >> 4 and clamp)
  for (let i = 0; i < 8; i++) {
    if (!(block[8 + i] | block[16 + i] | block[24 + i] | block[32 + i] | block[40 + i] | block[48 + i] | block[56 + i])) { const v = block[i] << 16 >> 16; for (let k = 0; k < 8; k++) tmp[i + 8 * k] = v; continue; }
    idct1(block, i, 8, tmp, i, 8, false);
  }
  for (let i = 0; i < 8; i++) idct1(tmp, i * 8, 1, out, off + i * stride, 1, true);
}

export class MadDecoder {
  constructor() { this.w = 0; this.h = 0; this.cur = null; this.last = null; this.q = new Int32Array(64); this.block = new Int32Array(64); this.qscale = -1; }
  alloc(w, h) {
    this.w = w; this.h = h; const mw = (w + 15) & ~15, mh = (h + 15) & ~15;
    const planes = () => ({ y: new Uint8Array(mw * mh), u: new Uint8Array(mw * mh / 4), v: new Uint8Array(mw * mh / 4), ys: mw, cs: mw / 2 });
    this.cur = planes(); this.last = planes(); this.spare = planes(); this.hasLast = false;
  }
  quant(qs) { if (qs === this.qscale) return; this.qscale = qs; this.q[0] = (AAN[0] * INTRA[0]) >> 11; for (let i = 1; i < 64; i++) this.q[i] = (AAN[i] * INTRA[i] * qs + 32) >> 10; }
  // one frame chunk (from its tag on); returns { y, u, v, ys, cs, w, h, ms } (planes are reused by the next call)
  decode(u8, off = 0, len = u8.length - off) {
    const dv = new DataView(u8.buffer, u8.byteOffset + off, len), tag = String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
    const inter = tag === "MADm" || tag === "MADe", ms = dv.getUint16(14, true), w = dv.getUint16(16, true), h = dv.getUint16(18, true);
    if (w !== this.w || h !== this.h) this.alloc(w, h);
    this.quant(u8[off + 21]);
    const f = this.cur, L = this.last, g = new Bits(u8, off + 24, off + len), blk = this.block, q = this.q;
    const mbw = (w + 15) >> 4, mbh = (h + 15) >> 4;
    const motion = () => { if (!g.get(1)) return 0; let v = g.get(1) ? -17 : 0; return v + g.get(4) + 1; };
    for (let my = 0; my < mbh; my++) for (let mx = 0; mx < mbw; mx++) {
      let map = 0, mvx = 0, mvy = 0;
      if (inter) { const v = g.get(1) ? 0 : 2 - g.get(1); if (v < 2) { map = v ? g.get(6) : 63; mvx = motion(); mvy = motion(); } }
      for (let j = 0; j < 6; j++) {
        if (map & (1 << j)) {
          const add = 2 * motion(); if (!this.hasLast) continue;
          if (j < 4) {
            const dy = my * 16 + ((j & 2) << 2), dx = mx * 16 + ((j & 1) << 3), sy = dy + mvy, sx = dx + mvx, st = f.ys;
            if (sy < 0 || sx < 0 || sy * st + sx >= (h - 7) * st - 7) continue;
            for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) f.y[(dy + r) * st + dx + c] = clamp8(L.y[(sy + r) * st + sx + c] + add);
          } else {
            const P = j === 4 ? "u" : "v", st = f.cs, dy = my * 8, dx = mx * 8, sy = dy + ((mvy / 2) | 0), sx = dx + ((mvx / 2) | 0);
            if (sy < 0 || sx < 0 || sy * st + sx >= ((h >> 1) - 7) * st - 7) continue;
            const D = f[P], S = L[P]; for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) D[(dy + r) * st + dx + c] = clamp8(S[(sy + r) * st + sx + c] + add);
          }
          continue;
        }
        blk.fill(0);
        blk[0] = (128 + g.sget(8)) * q[0];
        for (let i = 0; ;) {
          const e = LUT[g.peek(16)], sym = e >> 5, l = e & 31;
          if (!l) throw new Error("bad coefficient code");
          g.skip(l);
          let level, run;
          if (sym === 112) break;
          if (sym === 111) { level = g.sget(10); run = g.get(6) + 1; i += run; if (i > 63) throw new Error("coefficient past the block");
            const k = ZIGZAG[i]; if (level < 0) { level = -(((-level * q[k]) >> 4) - 1 | 1); } else { level = ((level * q[k]) >> 4) - 1 | 1; } blk[k] = level; continue; }
          run = RUN[sym] + 1; i += run; if (i > 63) throw new Error("coefficient past the block");
          const k = ZIGZAG[i]; level = ((LEVEL[sym] * q[k]) >> 4) - 1 | 1; if (g.get(1)) level = -level; blk[k] = level;
        }
        if (j < 4) idctPut(blk, f.y, (my * 16 + ((j & 2) << 2)) * f.ys + mx * 16 + ((j & 1) << 3), f.ys);
        else idctPut(blk, j === 4 ? f.u : f.v, my * 8 * f.cs + mx * 8, f.cs);
      }
    }
    const out = { ...f, w, h, ms };
    if (tag !== "MADe") { const t = this.last; this.last = f; this.cur = t; this.hasLast = true; }   // MADe frames are not references
    else { const t = this.spare; this.spare = f; this.cur = t; }
    return out;
  }
}

// YUV 4:2:0 (BT.601, full range as MPEG-1 decoders output it) to RGBA
export function yuvToRgba(fr, out = new Uint8ClampedArray(fr.w * fr.h * 4)) {
  const { y, u, v, ys, cs, w, h } = fr;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const Y = 1.164 * (y[r * ys + c] - 16), U = u[(r >> 1) * cs + (c >> 1)] - 128, V = v[(r >> 1) * cs + (c >> 1)] - 128, o = (r * w + c) * 4;
    out[o] = Y + 1.596 * V; out[o + 1] = Y - 0.392 * U - 0.813 * V; out[o + 2] = Y + 2.017 * U; out[o + 3] = 255;
  }
  return out;
}

// EA ADPCM (R1 per packet predictor; R2 / R3 carry it across packets; 0xEE = 28 raw samples)
const EA_TABLE = [0, 240, 460, 392, 0, 0, -208, -220, 0, 1, 3, 4, 7, 8, 10, 11, 0, -1, -3, -4];
export class EaAdpcm {
  constructor(channels, rev = 1) { this.ch = channels; this.rev = rev; this.cur = new Int32Array(channels); this.prev = new Int32Array(channels); }
  // SCDl chunk payload (after the 8-byte header): u32 samples, per channel u32 offset, data -> Float32Array per channel
  decode(u8, off, len) {
    const dv = new DataView(u8.buffer, u8.byteOffset + off, len), be = this.rev === 3, n = dv.getUint32(0, true), out = [];
    for (let c = 0; c < this.ch; c++) {
      let p = 4 + (be ? dv.getUint32(4 + c * 4) : dv.getUint32(4 + c * 4, true)) + (this.ch + 1) * 4 - 4;
      const s = new Float32Array(n); let k = 0, cur, prev;
      if (this.rev === 1) { cur = dv.getInt16(p, true); prev = dv.getInt16(p + 2, true); p += 4; } else { cur = this.cur[c]; prev = this.prev[c]; }
      for (let blk = 0; blk < Math.floor(n / 28) && p < len; blk++) {
        let byte = dv.getUint8(p++);
        if (byte === 0xee) { cur = dv.getInt16(p); prev = dv.getInt16(p + 2); p += 4; for (let i = 0; i < 28; i++, p += 2) s[k++] = dv.getInt16(p) / 32768; continue; }
        const c1 = EA_TABLE[byte >> 4], c2 = EA_TABLE[(byte >> 4) + 4], shift = 20 - (byte & 15);
        for (let i = 0; i < 28; i++) {
          let nib;
          if (i & 1) nib = (byte & 15) << 28 >> 28; else { byte = dv.getUint8(p++); nib = (byte >> 4) << 28 >> 28; }
          let ns = (nib << shift) + cur * c1 + prev * c2; ns >>= 8; ns = ns < -32768 ? -32768 : ns > 32767 ? 32767 : ns;
          prev = cur; cur = ns; s[k++] = cur / 32768;
        }
      }
      this.cur[c] = cur; this.prev[c] = prev; out.push(s);
    }
    return out;
  }
}

// chunks of one stream entry: { tag, off, len } (off = chunk start)
export function eaChunks(u8) {
  const out = [], dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  for (let p = 0; p + 8 <= u8.length;) { const tag = String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]), sz = dv.getUint32(p + 4, true); if (sz < 8) break; out.push({ tag, off: p, len: Math.min(sz, u8.length - p) }); p += sz; }
  return out;
}
// audio header SCHl "PT" patch: tag bytes with big-endian values of a given length; returns { channels, rate, codec }
export function eaAudioHeader(u8, off, len) {
  const r = { channels: 1, rate: 22050, compression: -1, revision: 0 };
  let p = off + 8; if (String.fromCharCode(u8[p], u8[p + 1]) !== "PT") return r; p += 4;
  const val = () => { const n = u8[p++]; let v = 0; for (let i = 0; i < n; i++) v = v * 256 + u8[p++]; return v; };
  while (p < off + len) {
    const t = u8[p++];
    if (t === 0xff) break;
    if (t === 0xfc || t === 0xfd || t === 0xfe) continue;           // subheader markers
    if (t === 0x8a) { val(); continue; }
    const v = val();
    if (t === 0x82) r.channels = v; else if (t === 0x83) r.compression = v; else if (t === 0x84) r.rate = v; else if (t === 0x80) r.revision = v; else if (t === 0xa0) r.revision2 = v;
  }
  return r;
}
