// audio-mix.mjs — software mixer behind the DirectSound layer (dsound-hle.mjs): turns the game's sound buffers and
// streams into 48 kHz stereo PCM, platform-independent. The browser (play-client.js) only plays the mixed PCM through
// Web Audio; a WAV writer is here for offline checks.
//
// Voices read the game's memory live at their play position, so both one-shot samples and ring buffers that the
// game keeps writing ahead of the play cursor (EA's 6-channel software-mix buffer) play correctly. Formats seen:
//   tag 1    PCM, 8 / 16 bit, 1-6 channels (6 = FL FR C LFE SL SR, folded down to stereo)
//   tag 0x69 Xbox ADPCM (IMA ADPCM, 36-byte blocks per channel = 4-byte header + 64 nibbles -> 64 samples)
// Volume is DirectSound's hundredths of a dB (0 .. -10000); frequency is the voice's playback rate in Hz (the engine
// sounds change it every frame). Positions advance by mixing, and DSound asks the mixer for them (position(id)), so
// what the game sees as the play cursor is what is actually being played.

const RATE = 48000;
const IMA_STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
  130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411,
  1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487,
  12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];
const IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8];

// one Xbox ADPCM block (mono, 36 bytes at `p`) -> 64 samples into out[o..]
function adpcmBlock(m, p, out, o) {
  let pred = (m.r16(p) << 16) >> 16, idx = Math.min(88, m.r8(p + 2));
  for (let i = 0; i < 32; i++) {
    const byte = m.r8(p + 4 + i);
    for (let k = 0; k < 2; k++) {
      const n = k ? byte >> 4 : byte & 15, step = IMA_STEP[idx];
      let d = step >> 3; if (n & 1) d += step >> 2; if (n & 2) d += step >> 1; if (n & 4) d += step;
      pred += n & 8 ? -d : d; pred = pred < -32768 ? -32768 : pred > 32767 ? 32767 : pred;
      idx += IMA_INDEX[n]; idx = idx < 0 ? 0 : idx > 88 ? 88 : idx;
      out[o + i * 2 + k] = pred / 32768;
    }
  }
}

export const dbToGain = v => (v <= -10000 ? 0 : Math.pow(10, (v | 0) / 2000));

export class Mixer {
  constructor(mem, { rate = RATE } = {}) {
    this.m = mem; this.rate = rate; this.voices = new Map(); this.streams = new Map(); this.adpcmCache = new Map();
    this.master = 0.8; this.samples = 0;           // headroom: the race mix peaks slightly above full scale at 1.0
  }
  createBuffer({ id, fmt, bytes }) { this.voices.set(id, { id, fmt, bytes, data: 0, dataBytes: 0, playing: false, pos: 0, freq: fmt?.rate ?? RATE, gain: 1, loop: false }); }
  voice(id) { let v = this.voices.get(id); if (!v) { this.createBuffer({ id, fmt: null, bytes: 0 }); v = this.voices.get(id); } return v; }
  // frames in the voice's data (sample frames, all channels)
  frames(v) {
    const f = v.fmt; if (!f) return 0; const bytes = v.dataBytes || v.bytes;
    if (f.tag === 0x69) return Math.floor(bytes / (36 * f.channels)) * 64;
    return Math.floor(bytes / Math.max(1, f.align || (f.channels * f.bits / 8)));
  }
  play(id, { looping, data, bytes, fmt }) {
    const v = this.voice(id); v.fmt = fmt ?? v.fmt; v.data = data; v.dataBytes = bytes; v.loop = !!looping; v.playing = true; v.dec = null;
    if (v.pos >= this.frames(v)) v.pos = 0;
  }
  stop(id) { const v = this.voices.get(id); if (v) v.playing = false; }
  release(id) { this.voices.delete(id); }
  setVolume(id, vol) { this.voice(id).gain = dbToGain(vol); }
  setFrequency(id, hz) { this.voice(id).freq = hz; }
  setLoopRegion(id, start, length) { const v = this.voice(id), bpf = this.bytesPerFrame(v); v.loopStart = bpf ? start / bpf : 0; v.loopLen = bpf ? length / bpf : 0; }
  setPosition(id, bytes) { const v = this.voice(id), bpf = this.bytesPerFrame(v); v.pos = bpf ? bytes / bpf : 0; }
  bytesPerFrame(v) { const f = v.fmt; if (!f) return 0; return f.tag === 0x69 ? 36 * f.channels / 64 : (f.align || f.channels * f.bits / 8); }
  // play cursor in bytes (for GetCurrentPosition)
  position(id) { const v = this.voices.get(id); if (!v) return 0; const bpf = this.bytesPerFrame(v); return Math.floor(v.pos) * bpf | 0; }
  isPlaying(id) { return !!this.voices.get(id)?.playing; }

  // stream packets: copied at Process time and played in order at the stream's own rate
  packet(stream, ptr, size, fmt, token) {
    let s = this.streams.get(stream); if (!s) { s = { queue: [], pos: 0, gain: 1, paused: false, fmt }; this.streams.set(stream, s); }
    s.fmt = fmt ?? s.fmt; if (!ptr || !size || !s.fmt) { s.queue.push({ pcm: new Float32Array(0), ch: 1, token }); return; }
    const f = s.fmt, ch = f.channels, n = Math.floor(size / (f.bits / 8) / ch), pcm = new Float32Array(n * ch);
    if (f.bits === 16) for (let i = 0; i < n * ch; i++) pcm[i] = ((this.m.r16(ptr + i * 2) << 16) >> 16) / 32768;
    else for (let i = 0; i < n * ch; i++) pcm[i] = (this.m.r8(ptr + i) - 128) / 128;
    s.queue.push({ pcm, ch, token });
  }
  setStreamVolume(stream, vol) { const s = this.streams.get(stream); if (s) s.gain = dbToGain(vol); }
  pauseStream(stream, paused) { const s = this.streams.get(stream); if (s) s.paused = paused; }
  // tokens of packets fully played since the last call
  donePackets() { const d = this.done ?? []; this.done = []; return d; }

  // a mono/stereo sample pair of voice v at integer frame i
  frameAt(v, i, out) {
    const f = v.fmt, m = this.m;
    if (f.tag === 0x69) {
      if (!v.dec) v.dec = this.decodeAdpcm(v);
      const ch = f.channels, s = v.dec;
      if (ch === 1) { out[0] = out[1] = s[i] ?? 0; } else { out[0] = s[i * ch] ?? 0; out[1] = s[i * ch + 1] ?? 0; }
      return;
    }
    const ch = f.channels, bpf = f.align || ch * f.bits / 8, p = v.data + i * bpf;
    const rd = c => f.bits === 16 ? ((m.r16(p + c * 2) << 16) >> 16) / 32768 : (m.r8(p + c) - 128) / 128;
    if (ch === 1) out[0] = out[1] = rd(0);
    else if (ch === 2) { out[0] = rd(0); out[1] = rd(1); }
    else if (ch >= 6) { const c = rd(2) * 0.707; out[0] = rd(0) + c + rd(4) * 0.707; out[1] = rd(1) + c + rd(5) * 0.707; }
    else { out[0] = rd(0); out[1] = rd(1); }
  }
  // ADPCM samples are decoded once per buffer contents (cache keyed by address, size and a checksum of the data)
  decodeAdpcm(v) {
    const f = v.fmt, ch = f.channels, blocks = Math.floor((v.dataBytes || v.bytes) / (36 * ch)), m = this.m;
    let sum = 0; for (let i = 0; i < Math.min(64, blocks); i++) sum = (sum * 31 + m.r32(v.data + i * 36 * ch + 4)) | 0;
    const key = `${v.data}:${blocks}:${ch}:${sum}`; let s = this.adpcmCache.get(key); if (s) return s;
    s = new Float32Array(blocks * 64 * ch); const tmp = new Float32Array(64);
    for (let b = 0; b < blocks; b++) for (let c = 0; c < ch; c++) {
      // multichannel Xbox ADPCM interleaves 4-byte words per channel; mono is the common case here
      if (ch === 1) adpcmBlock(m, v.data + b * 36, s, b * 64);
      else { adpcmBlock(m, v.data + b * 36 * ch + c * 36, tmp, 0); for (let k = 0; k < 64; k++) s[(b * 64 + k) * ch + c] = tmp[k]; }
    }
    if (this.adpcmCache.size > 512) this.adpcmCache.clear();
    this.adpcmCache.set(key, s); return s;
  }

  // mix n output frames -> Float32Array stereo interleaved
  mix(n) {
    const out = new Float32Array(n * 2), pair = [0, 0], pair2 = [0, 0];
    for (const v of this.voices.values()) {
      if (MIX_ONLY && v.fmt && MIX_ONLY !== (v.fmt.channels === 6 ? "ring" : v.fmt.tag === 0x69 ? "adpcm" : "pcm")) { if (v.playing && v.data) this.advance(v, n); continue; }
      if (!v.playing || !v.fmt || !v.data || v.gain === 0) { if (v.playing && v.fmt && v.data) this.advance(v, n); continue; }
      const total = this.frames(v); if (!total) { v.playing = false; continue; }
      const step = (v.freq || v.fmt.rate) / this.rate, gt = v.gain * this.master;
      const ls = v.loopLen ? v.loopStart : 0, le = v.loopLen ? Math.min(total, v.loopStart + v.loopLen) : total;
      let pos = v.pos, g = v.g ?? gt;
      for (let i = 0; i < n; i++) {
        g += (gt - g) * GAIN_GLIDE;
        if (pos >= le) { if (v.loop) pos = ls + ((pos - ls) % Math.max(1, le - ls)); else { v.playing = false; break; } }
        // linear interpolation between the two nearest frames (the engine sounds play at a rate that changes every
        // frame; picking the nearest frame aliased into a harsh, crackling tone at high revs)
        const i0 = pos | 0, fr = pos - i0; let i1 = i0 + 1; if (i1 >= le) i1 = v.loop ? ls : i0;
        this.frameAt(v, i0, pair);
        if (fr > 0 && i1 !== i0) { this.frameAt(v, i1, pair2); pair[0] += (pair2[0] - pair[0]) * fr; pair[1] += (pair2[1] - pair[1]) * fr; }
        out[i * 2] += pair[0] * g; out[i * 2 + 1] += pair[1] * g;
        pos += step;
      }
      v.pos = pos; v.g = g;
    }
    for (const [id, s] of this.streams) {
      if (s.paused || !s.fmt) continue;
      const step = s.fmt.rate / this.rate, gt = s.gain * this.master; let g = s.g ?? gt;
      for (let i = 0; i < n && s.queue.length; i++) {
        g += (gt - g) * GAIN_GLIDE;
        const q = s.queue[0], frames = q.pcm.length / q.ch;
        if (s.pos >= frames) { s.queue.shift(); s.pos -= frames; (this.done ??= []).push(q.token); i--; continue; }
        const i0 = s.pos | 0, fr = s.pos - i0, k = i0 * q.ch, r = q.ch > 1 ? 1 : 0;
        // next frame: in this packet, else the first of the next one (packets are a continuous stream)
        const nq = i0 + 1 < frames ? q : s.queue[1], k1 = i0 + 1 < frames ? k + q.ch : 0;
        let l = q.pcm[k], rr = q.pcm[k + r];
        if (fr > 0 && nq && nq.pcm.length) { l += (nq.pcm[k1] - l) * fr; rr += (nq.pcm[k1 + (nq.ch > 1 ? 1 : 0)] - rr) * fr; }
        out[i * 2] += l * g; out[i * 2 + 1] += rr * g;
        s.pos += step;
      }
      s.g = g;
    }
    this.samples += n;
    return out;
  }
  advance(v, n) {                                // muted voice: keep time
    const total = this.frames(v); if (!total) return; v.pos += (v.freq || v.fmt.rate) / this.rate * n;
    const ls = v.loopLen ? v.loopStart : 0, le = v.loopLen ? Math.min(total, v.loopStart + v.loopLen) : total;
    if (v.pos >= le) { if (v.loop) v.pos = ls + ((v.pos - ls) % Math.max(1, le - ls)); else v.playing = false; }
  }
}

// Float32 stereo -> Int16, with a soft knee above 0.9 so the rare peaks of a busy race mix round off instead of
// clipping hard
// Volume changes glide (one pole, ~3 ms) instead of stepping at the sample where the mixer catches up with them: the
// game sets every engine's volume each frame (revs, distance), and the steps were clicks at fixed places in every
// frame - the race "crackling" (a 60 fps race: ~24 clicks a second in the mix, none in EA's own software-mix ring).
const MIX_ONLY = process.env.NT04_MIX_ONLY;   // (debugging: ring / adpcm / pcm voices only)
const GAIN_GLIDE = 1 - Math.exp(-1 / (0.003 * 48000));
export function toInt16(f) {
  const o = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    let x = f[i]; const a = Math.abs(x);
    if (a > 0.9) x = Math.sign(x) * (0.9 + 0.1 * Math.tanh((a - 0.9) / 0.1));
    o[i] = Math.round(x * 32767);
  }
  return o;
}

export function wav(int16, rate = RATE, channels = 2) {
  const b = Buffer.alloc(44 + int16.byteLength);
  b.write("RIFF", 0); b.writeUInt32LE(36 + int16.byteLength, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * channels * 2, 28);
  b.writeUInt16LE(channels * 2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(int16.byteLength, 40);
  Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength).copy(b, 44); return b;
}
