// dsound-hle.mjs — the game's DirectSound (Xbox XDK 5455, linked into default.exe) re-implemented at its API, so
// sound goes to an audio backend of ours (silent for now; Web Audio later) instead of the Xbox APU.
//
// Boundary: the game's sound layer (EA's, around 0x157000-0x160000; init 0x15C700) calls 26 DirectSound C
// entry points (all identified in xbe_symbols.json): DirectSoundCreate, DirectSoundCreateBuffer,
// DirectSoundCreateStream, DirectSoundDoWork, IDirectSound_{Release, DownloadEffectsImage, SetMixBinHeadroom,
// CreateSoundBuffer, SetI3DL2Listener}, IDirectSoundBuffer_{Release, SetVolume, SetFilter, SetMixBinVolumes_8,
// Play, Stop, SetLoopRegion, GetStatus, GetCurrentPosition, SetCurrentPosition, SetFrequency, SetMixBins,
// SetBufferData}, IDirectSoundStream_{SetVolume, SetEG, Pause, FlushEx}. Streams are also driven through their
// XMediaObject vtable (Process / GetStatus ...), so stream objects get a vtable of JS stubs.
//
// Buffers keep their format and data pointer and play in game time: GetStatus reports "playing" until a one-shot
// sound's length has elapsed, GetCurrentPosition moves with time. Stream packets complete at once (status 0,
// completed size = packet size, completion event set, the stream callback called from DirectSoundDoWork).
// The backend interface: createBuffer(info), play(id, opts), stop(id), setVolume(id, v), packet(stream, bytes).
// The default backend is the software mixer (audio-mix.mjs): it is caught up to the audio clock on every DirectSound
// call (sync), the play cursor and "playing" status come from it, and stream packets complete when they have been
// played. The mixed 48 kHz stereo PCM collects in this.out until the host drains it (drainAudio).

import { sym } from "./d3d-hle.mjs";
import { Mixer } from "./audio-mix.mjs";

const DSBSTATUS_PLAYING = 1, DSBSTATUS_LOOPING = 4, DSBPLAY_LOOPING = 1;

// GetCurrentPosition's write cursor runs ahead of the play cursor (as on the hardware), for looping buffers by one
// 60 Hz frame. EA's sound thread refills its 50 ms software-mix ring (6 channels: music, crowd, effects) from the write
// cursor to ~20 ms past it, once per wake; with write = play it wrote too little, and whenever the thread woke a frame
// late the mixer read past the refilled part into the previous turn of the ring: clicks at the refill boundaries
// (~24 a second in a race, the "crackling"; EA's own data was clean). NT04_WRITE_LEAD=ms overrides.
const WRITE_LEAD_MS = process.env.NT04_WRITE_LEAD !== undefined ? +process.env.NT04_WRITE_LEAD : 17;
export class SilentAudio {                 // backend that only keeps counts
  constructor() { this.plays = 0; this.packets = 0; }
  createBuffer() {} play() { this.plays++; } stop() {} setVolume() {} packet() { this.packets++; }
}

export class DSound {
  constructor(game, backend = new Mixer(game.mem)) {
    this.g = game; this.m = game.mem; this.audio = backend; this.out = []; this.outFrames = 0; this.clock = 0;
    this.buffers = new Map(); this.streams = new Map(); this.pending = [];
    this.install();
  }
  hook(name, fn) {
    const s = sym(name); if (!s) throw new Error(`no symbol ${name}`);
    this.g.hooks.set(s.addr, c => { this.sync(); const v = fn(c); c.r[4] += s.stackBytes ?? 0; return v ?? 0; });
  }
  // game time plus CPU time inside the current tick (a 733 MHz CPU runs ~733k instructions per ms): code that waits
  // for a sound to finish inside one long call (loading) still sees time pass
  now() { return (this.g.ms ?? 0) + this.g.cpu.steps / 733_000; }
  // audio clock (ms): the game clock plus the CPU time since its last tick, never going backwards
  audioMs() {
    const ms = this.g.ms ?? 0, steps = this.g.cpu.steps;
    if (ms !== this.tickMs) { this.tickMs = ms; this.tickSteps = steps; }
    this.clock = Math.max(this.clock, ms + (steps - this.tickSteps) / 733_000); return this.clock;
  }
  get mixing() { return typeof this.audio.mix === "function"; }
  // run the mixer up to the audio clock; output is kept for the host (at most ~2 s when nobody drains it)
  sync() {
    if (!this.mixing) return;
    const a = this.audio, target = Math.floor(this.audioMs() * a.rate / 1000);
    let n = target - a.samples; if (n <= 0) return; if (n > a.rate) { a.samples = target - a.rate; n = a.rate; }
    const f = a.mix(n); this.out.push(f); this.outFrames += n;
    while (this.outFrames > a.rate * 2 && this.out.length > 1) this.outFrames -= this.out.shift().length / 2;
    for (const t of a.donePackets()) if (t) t.played = true;
  }
  // mixed audio since the last call (Float32 stereo interleaved)
  drainAudio() {
    this.sync(); const parts = this.out; this.out = []; this.outFrames = 0;
    const n = parts.reduce((k, p) => k + p.length, 0), o = new Float32Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; }
    return o;
  }
  object(kind, extra = {}) {
    const p = this.g.alloc(0x40); this.m.w32(p, this.vtable ?? 0); this.m.w32(p + 4, 1);
    const o = { p, kind, refs: 1, ...extra }; (kind === "stream" ? this.streams : this.buffers).set(p, o); return o;
  }
  // WAVEFORMATEX { u16 tag, u16 channels, u32 rate, u32 bytes/s, u16 align, u16 bits }
  format(p) { const m = this.m; return p ? { tag: m.r16(p), channels: m.r16(p + 2), rate: m.r32(p + 4), bytesPerSec: m.r32(p + 8), align: m.r16(p + 12), bits: m.r16(p + 14) } : null; }
  bufferFromDesc(desc) {                   // DSBUFFERDESC { dwSize, dwFlags, dwBufferBytes, lpwfxFormat, lpMixBins, dwInputMixBin }
    const m = this.m, fmt = this.format(m.r32(desc + 12));
    const b = this.object("buffer", { flags: m.r32(desc + 4), bytes: m.r32(desc + 8), fmt, data: 0, playing: false, started: 0, position: 0, freq: fmt?.rate ?? 48000 });
    this.audio.createBuffer({ id: b.p, fmt, bytes: b.bytes });
    return b;
  }
  elapsedBytes(b) {                        // bytes played since Play, at the buffer's frequency
    const bps = b.fmt?.bytesPerSec ? b.fmt.bytesPerSec * (b.freq / (b.fmt.rate || b.freq)) : 0;
    return bps ? Math.floor((this.now() - b.started) / 1000 * bps) : 0;
  }
  status(b) {
    if (this.mixing && b.p !== undefined && b.playing) { b.playing = this.audio.isPlaying(b.p); return b.playing ? DSBSTATUS_PLAYING | (b.looping ? DSBSTATUS_LOOPING : 0) : 0; }
    if (!b.playing) return 0;
    if (b.looping) return DSBSTATUS_PLAYING | DSBSTATUS_LOOPING;
    const len = b.loopLength || b.dataBytes || b.bytes;
    if (!len || this.elapsedBytes(b) >= len) { b.playing = false; return 0; }
    return DSBSTATUS_PLAYING;
  }

  install() {
    const m = this.m, g = this.g, H = (n, f) => this.hook(n, f);
    // XMediaObject vtable for streams (and harmless for buffers): AddRef, Release, GetInfo, GetStatus, Process,
    // Discontinuity, Flush — stdcall with `this`
    const stubs = [[4, c => ++this.get(c.arg(0)).refs], [4, c => Math.max(0, --this.get(c.arg(0)).refs)],
      [8, c => { if (c.arg(1)) for (let i = 0; i < 12; i += 4) m.w32(c.arg(1) + i, 0); return 0; }],
      [8, c => { if (c.arg(1)) m.w32(c.arg(1), 1); return 0; }],              // XMO_STATUSF_ACCEPT_INPUT_DATA
      [12, c => this.process(c.arg(0), c.arg(1))], [4, () => 0], [4, () => 0]];
    const vt = g.alloc(stubs.length * 4), code = 0x7ff0c000;
    stubs.forEach(([pop, fn], i) => { const a = code + i * 4; m.w32(vt + i * 4, a); g.hooks.set(a, c => { const v = fn(c); c.r[4] += pop; return v ?? 0; }); });
    this.vtable = vt;

    H("DirectSoundCreate", c => { const ds = this.object("device"); if (c.arg(1)) m.w32(c.arg(1), ds.p); g.log("dsound: device created"); return 0; });
    H("IDirectSound_Release", () => 0);
    H("IDirectSound_DownloadEffectsImage", c => {     // DSEFFECTIMAGEDESC { count, scratch size, maps[] }: no DSP effects
      const d = g.alloc(0x100); if (c.arg(4)) m.w32(c.arg(4), d); if (c.arg(3)) m.w32(c.arg(3), 0); return 0; });
    H("IDirectSound_SetMixBinHeadroom", () => 0); H("IDirectSound_SetI3DL2Listener", () => 0);
    H("IDirectSound_CreateSoundBuffer", c => { const b = this.bufferFromDesc(c.arg(1)); if (c.arg(2)) m.w32(c.arg(2), b.p); return 0; });
    H("DirectSoundCreateBuffer", c => { const b = this.bufferFromDesc(c.arg(0)); if (c.arg(1)) m.w32(c.arg(1), b.p); return 0; });
    H("DirectSoundCreateStream", c => {      // DSSTREAMDESC { dwFlags, dwMaxAttachedPackets, lpwfxFormat, lpfnCallback, lpvContext, lpMixBins }
      const d = c.arg(0), s = this.object("stream", { fmt: this.format(m.r32(d + 8)), callback: m.r32(d + 12), context: m.r32(d + 16), paused: false });
      if (c.arg(1)) m.w32(c.arg(1), s.p); return 0;
    });
    H("DirectSoundDoWork", () => this.work());
    const B = c => this.buffers.get(c.arg(0)) ?? {};
    H("IDirectSoundBuffer_Release", c => { const b = B(c); b.refs = Math.max(0, (b.refs ?? 1) - 1); if (!b.refs) { this.audio.stop(c.arg(0)); this.audio.release?.(c.arg(0)); this.buffers.delete(c.arg(0)); } return b.refs ?? 0; });
    H("IDirectSoundBuffer_SetBufferData", c => { const b = B(c); b.data = c.arg(1); b.dataBytes = c.arg(2); return 0; });
    H("IDirectSoundBuffer_Play", c => { const b = B(c); b.playing = true; b.looping = !!(c.arg(3) & DSBPLAY_LOOPING); b.started = this.now() - (b.position / Math.max(1, b.fmt?.bytesPerSec ?? 1)) * 1000;
      this.audio.play(c.arg(0), { looping: b.looping, data: b.data, bytes: b.dataBytes || b.bytes, fmt: b.fmt }); return 0; });
    H("IDirectSoundBuffer_Stop", c => { const b = B(c); b.playing = false; this.audio.stop(c.arg(0)); return 0; });
    H("IDirectSoundBuffer_GetStatus", c => { if (c.arg(1)) m.w32(c.arg(1), this.status(B(c))); return 0; });
    H("IDirectSoundBuffer_GetCurrentPosition", c => { const b = B(c), len = b.dataBytes || b.bytes || 1;
      const pos = this.mixing ? this.audio.position(c.arg(0)) % len : b.playing ? (b.position + this.elapsedBytes(b)) % len : b.position ?? 0;
      if (c.arg(1)) m.w32(c.arg(1), pos); if (c.arg(2)) m.w32(c.arg(2), b.looping ? (pos + Math.round(WRITE_LEAD_MS * (b.fmt?.bytesPerSec ?? 0) / 1000 / (b.fmt?.align || 1)) * (b.fmt?.align || 1)) % len : pos); return 0; });
    H("IDirectSoundBuffer_SetCurrentPosition", c => { const b = B(c); b.position = c.arg(1); b.started = this.now(); this.audio.setPosition?.(c.arg(0), c.arg(1)); return 0; });
    H("IDirectSoundBuffer_SetLoopRegion", c => { const b = B(c); b.loopStart = c.arg(1); b.loopLength = c.arg(2); this.audio.setLoopRegion?.(c.arg(0), c.arg(1), c.arg(2)); return 0; });
    H("IDirectSoundBuffer_SetFrequency", c => { const b = B(c); b.freq = c.arg(1) || b.fmt?.rate || 48000; this.audio.setFrequency?.(c.arg(0), b.freq); return 0; });
    H("IDirectSoundBuffer_SetVolume", c => { B(c).volume = c.arg(1) | 0; this.audio.setVolume(c.arg(0), c.arg(1) | 0); return 0; });
    for (const n of ["IDirectSoundBuffer_SetFilter", "IDirectSoundBuffer_SetMixBinVolumes_8", "IDirectSoundBuffer_SetMixBins"]) H(n, () => 0);
    const S = c => this.streams.get(c.arg(0)) ?? {};
    H("IDirectSoundStream_SetVolume", c => { S(c).volume = c.arg(1) | 0; this.audio.setStreamVolume?.(c.arg(0), c.arg(1) | 0); return 0; });
    H("IDirectSoundStream_SetEG", () => 0);
    H("IDirectSoundStream_Pause", c => { S(c).paused = !!c.arg(1); this.audio.pauseStream?.(c.arg(0), !!c.arg(1)); return 0; });
    H("IDirectSoundStream_FlushEx", () => 0);
  }
  get(p) { return this.buffers.get(p) ?? this.streams.get(p) ?? { refs: 1 }; }
  // XMEDIAPACKET { pvBuffer, dwMaxSize, pdwCompletedSize, pdwStatus, hCompletionEvent | pContext, prtTimestamp }
  process(stream, pkt) {
    const m = this.m, s = this.streams.get(stream); if (!pkt) return 0;
    this.sync();
    const ptr = m.r32(pkt), size = m.r32(pkt + 4), done = m.r32(pkt + 8), status = m.r32(pkt + 12), ctx = m.r32(pkt + 16);
    if (done) m.w32(done, size); if (status) m.w32(status, 1);              // XMEDIAPACKET_STATUS_PENDING until DoWork
    const entry = { s, status, ctx, played: !this.mixing };
    if (this.mixing) this.audio.packet(stream, ptr, size, s?.fmt, entry); else this.audio.packet(stream, size);
    this.pending.push(entry);
    return 0;
  }
  work() {
    // packets complete in order once played (immediately on a backend without mixing)
    let k = 0; while (k < this.pending.length && this.pending[k].played) k++;
    const list = this.pending.slice(0, k); this.pending = this.pending.slice(k);
    for (const { s, status, ctx } of list) {
      if (status) this.m.w32(status, 0);                                      // XMEDIAPACKET_STATUS_SUCCESS
      if (s?.callback) try { this.g.nested(s.callback, [s.context, ctx, 0]); } catch (e) { this.g.log(`dsound: stream callback: ${e.message.slice(0, 160)}`); }
      else if (ctx && this.g.threads) { const h = this.g.threads.header(ctx); if (this.g.threads.handles.has(ctx >>> 0)) this.g.threads.set(h, 1); }
    }
    return 0;
  }
}
