// uis-vm.mjs — Node implementation of the EA ll_api UIStudio runtime: screen loading/relocation, the script VM
// (0x13CAB0), the statechart event rules (0x139B20 / 0x13AC10), the message queue (0x13C430) and the generic object
// methods (element 0x13FC20, text 0x141130, string table 0x9A990). Game functions (native_call) are stubs that can
// be overridden: vm.natives[id] = (ctx) => value.
//
// Memory model: a flat 32-bit space of regions. The global screen is loaded at 0x10000000, screens at 0x20000000+,
// the script stack lives at 0x60000000. Screens are relocated exactly like 0x139F70, so pointers inside screen data
// are real addresses and object data is reached through base + offset, as in the game.

import { parseScreen } from "./uis-screen.mjs";

const f2u = new DataView(new ArrayBuffer(4));
const asF = u => (f2u.setUint32(0, u >>> 0, true), f2u.getFloat32(0, true));
const asU = f => (f2u.setFloat32(0, f, true), f2u.getUint32(0, true));
const s32 = v => v | 0;
const NO_SCREEN = 0xffffffff;
const FOCUS_CAP = 8;                // capacity of the modal focus stack (manager +0x5C; value not yet read)
const ALWAYS = new Set([-10, -9, -2, -3, -8, -4, -5, -11]);   // events delivered to inactive states too (0x139B20)

const ZERO_PAGE = Buffer.alloc(0x10000);
export const LOW_SIZE = 0x10000000;            // flat window for the game's low memory (image, heap, stacks)
export class Memory {
  // pages: one entry per 64 KB of the 4 GB space, the region that covers the whole page (null when unmapped or
  // shared by several small regions: those go through region())
  //
  // low window (enableLow, used by the game): regions below LOW_SIZE live inside one flat buffer at their own
  // addresses, with lowOK marking the 64 KB pages a region covers completely. Accesses there are one bounds-checked
  // load from a single DataView (x86-jit.mjs emits that inline); everything else goes through the region lookup.
  constructor() { this.regions = []; this.last = null; this.pages = new Array(65536).fill(null); this.low = null; this.lowDV = null; this.lowOK = null; }
  enableLow() {
    if (this.low) return;
    // backed by a WebAssembly memory: the window, then one 64 KB page whose first 4 KB is lowOK (the rest stays 0, so
    // a lookup with any address's upper 16 bits is in bounds and "not OK" above the window), then a page for compiled
    // WebAssembly code's own state (wasm-jit): compiled WebAssembly reads the same bytes JavaScript does
    // (+ 2 pages: lowOK, state; + 4 + 256: wasm-jit's per-block instruction counts and block-number table over the
    // image; wasm-jit.mjs MEM_PAGES must match)
    this.wasmMemory = new WebAssembly.Memory({ initial: (LOW_SIZE >>> 16) + 262 + 64, maximum: (LOW_SIZE >>> 16) + 262 + 64 });   // (+64 pages: recomp.wasm data / stack, wasm-jit.mjs MEM_PAGES)
    const ab = this.wasmMemory.buffer;
    this.low = Buffer.from(ab, 0, LOW_SIZE); this.lowDV = new DataView(ab, 0, LOW_SIZE); this.lowOK = new Uint8Array(ab, LOW_SIZE, LOW_SIZE >>> 16);
    for (const r of this.regions) if (r.end <= LOW_SIZE) { const v = this.low.subarray(r.base, r.end); v.set(r.buf); this.place(r, v); }
  }
  place(r, buf) {                              // (re)point a region at its buffer; low regions mark their full pages
    r.buf = buf; r.dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
    for (let pg = Math.ceil(r.base / 65536); (pg + 1) * 65536 <= r.end && pg < 65536; pg++) { this.pages[pg] = r; if (this.low && r.end <= LOW_SIZE) this.lowOK[pg] = 1; }
  }
  mapZero(base, size) {                        // a zero-filled region (no copy into the low window)
    if (this.low && base + size <= LOW_SIZE) { const r = { base, end: base + size, buf: null, dv: null }; this.regions.push(r); this.place(r, this.low.subarray(base, base + size)); return r; }
    return this.map(base, Buffer.alloc(size));
  }
  map(base, buf) {
    const r = { base, end: base + buf.length, buf: null, dv: null }; this.regions.push(r);
    if (this.low && r.end <= LOW_SIZE) { const v = this.low.subarray(base, r.end); v.set(buf); buf = v; }
    this.place(r, buf);
    return r;
  }
  region(a) {
    a >>>= 0;
    if (this.last && a >= this.last.base && a < this.last.end) return this.last;
    for (const r of this.regions) if (a >= r.base && a < r.end) return (this.last = r);
    throw new Error(`bad address 0x${a.toString(16)}`);
  }
  r8(a) { a >>>= 0; if (a < LOW_SIZE && this.lowOK !== null && this.lowOK[a >>> 16] === 1) return this.low[a]; const r = this.pages[a >>> 16] ?? this.region(a); return r.buf[a - r.base]; }
  w8(a, v) { a >>>= 0; if (a < LOW_SIZE && this.lowOK !== null && this.lowOK[a >>> 16] === 1) { this.low[a] = v & 0xff; return; } const r = this.pages[a >>> 16] ?? this.region(a); r.buf[a - r.base] = v & 0xff; }
  // 16/32-bit accesses through a DataView (cheaper than Buffer's checked read/write methods); a value straddling the
  // end of a region throws like a bad address
  r16(a) { a >>>= 0; if (a < LOW_SIZE && this.lowOK !== null && this.lowOK[a >>> 16] === 1 && (a & 0xffff) <= 0xfffe) return this.lowDV.getUint16(a, true); const r = this.pages[a >>> 16] ?? this.region(a); return r.dv.getUint16(a - r.base, true); }
  w16(a, v) { a >>>= 0; if (a < LOW_SIZE && this.lowOK !== null && this.lowOK[a >>> 16] === 1 && (a & 0xffff) <= 0xfffe) { this.lowDV.setUint16(a, v, true); return; } const r = this.pages[a >>> 16] ?? this.region(a); r.dv.setUint16(a - r.base, v, true); }
  r32(a) { a >>>= 0; if (a < LOW_SIZE && this.lowOK !== null && this.lowOK[a >>> 16] === 1 && (a & 0xffff) <= 0xfffc) return this.lowDV.getUint32(a, true); const r = this.pages[a >>> 16] ?? this.region(a); return r.dv.getUint32(a - r.base, true); }
  w32(a, v) { a >>>= 0; if (a < LOW_SIZE && this.lowOK !== null && this.lowOK[a >>> 16] === 1 && (a & 0xffff) <= 0xfffc) { this.lowDV.setUint32(a, v, true); return; } const r = this.pages[a >>> 16] ?? this.region(a); r.dv.setUint32(a - r.base, v, true); }
  rf(a) { return asF(this.r32(a)); }
  wf(a, f) { this.w32(a, asU(f)); }
  cstr(a) { if (!a) return ""; const r = this.region(a); let o = (a >>> 0) - r.base, e = o; while (e < r.buf.length && r.buf[e]) e++; return r.buf.toString("latin1", o, e); }
  writeBytes(a, src) { const r = this.region(a); if ((a >>> 0) + src.length > r.end) throw new Error(`bad address 0x${(r.end >>> 0).toString(16)}`); src.copy ? src.copy(r.buf, (a >>> 0) - r.base) : r.buf.set(src, (a >>> 0) - r.base); }
  readBytes(a, n) { const r = this.region(a); return Buffer.from(r.buf.subarray((a >>> 0) - r.base, (a >>> 0) - r.base + n)); }
  wstr(a, s, cap) { const n = Math.min(s.length, cap); for (let i = 0; i < n; i++) this.w8(a + i, s.charCodeAt(i)); this.w8(a + n, 0); }
}

// Screen relocation (0x139F70).
function relocate(buf, base) {
  const u = o => buf.readUInt32LE(o), w = (o, v) => buf.writeUInt32LE(v >>> 0, o), add = o => w(o, u(o) + base);
  const [nStates, pStates] = [u(0), u(4)];
  for (let i = 0; i < nStates; i++) {
    const r = pStates + i * 20; add(r); add(r + 8); add(r + 16);
    for (let c = 0; c < u(r + 4); c++) {
      const cp = u(r + 8) - base + c * 4; add(cp);
      const child = u(cp) - base; add(child); add(child + 8);
      for (let q = 0; q < u(child + 4); q++) { const it = u(child + 8) - base + q * 8; if (buf.readInt16LE(it) !== -1) { add(it + 4); buf.writeUInt16LE(0, it + 2); } }
    }
    for (let e = 0; e < u(r + 12); e++) { const ev = u(r + 16) - base + e * 8; if (buf.readInt16LE(ev + 2) !== -1) add(ev + 4); }
  }
  add(12); for (let i = 0; i < u(8); i++) add(u(12) - base + i * 12 + 8);
  add(20); for (let i = 0; i < u(16); i++) { const at = u(u(20) - base + i * 4), idx = u(at); w(at, idx < u(8) ? u(12) + idx * 12 : 0); }
  add(28); for (let i = 0; i < u(24); i++) { const e = u(28) - base + i * 8 + 4, p = u(e); if (p) w(e, u(p) ? p + base : 0); }
}

export class UIVM {
  constructor({ assets = null, log = () => {} } = {}) {
    this.mem = new Memory(); this.assets = assets; this.log = log;
    this.stack = this.mem.map(0x60000000, Buffer.alloc(0x40000));   // sp0 leaves zero cells below for missing args
    this.zero = this.mem.map(0, Buffer.alloc(0x10000));                 // null page: stubbed games return 0 pointers
    this.sp0 = 0x60000400; this.stackBase = 0x60000000; this.focusStack = []; this.nextBase = 0x20000000; this.global = null; this.screens = [];
    this.queue = []; this.natives = {}; this.nativeHandler = null; this.nativeCalls = new Map(); this.stats = { insns: 0, scripts: 0, tweens: 0, posts: {} };
    this.handlers = { 0: elementHandler, 3: strtableHandler, 6: textHandler, 8: fanHandler };
    this.timers = []; this.frameMs = 1000 / 60; this.time = 0;
    // UI video playback (texture groups of kind 5: uis_vide, uis_cvd1-4): one clip at a time, as the game's library
    // (0x1406D0 start / 0x140710 stop, busy flag 0x27DC6E, "ended" byte 0x2186D8 that scripts poll through 0x1406C0).
    // this.video = { o (element), group, entry, t0, dur, seq, ended }; videoDuration(group, entry) -> ms (set by the host).
    this.video = null; this.videoSeq = 0; this.videoDuration = null;
  }
  setVideoEnded(v) { try { this.mem.w8(0x2186d8, v ? 1 : 0); } catch {} }

  // ------------------------------------------------------------ frame loop: 0x13AB30 (queue + event -10) and the
  // rate-function / tween table update 0x139D40 (entries keyed by (this, id), state 0 new, 2 running, 1 finished)
  frame(dt = this.frameMs) {
    this.onFrame?.(dt);                 // the game's own per-frame work (process manager tick), see gamecode.mjs
    this.pump();
    for (const sc of this.screens) this.dispatch(sc, 0, -10, [asU(dt)]);
    this.tickTimers(dt);
    this.time += dt;
    const v = this.video; if (v && !v.ended && this.time - v.t0 >= v.dur) { v.ended = true; this.setVideoEnded(1); }
  }
  runFor(ms) { const n = Math.ceil(ms / this.frameMs); for (let i = 0; i < n; i++) this.frame(); }
  findTimer(key, id) { return this.timers.find(t => t.key === (key >>> 0) && t.id === (id >>> 0) && t.state !== 1); }
  addTimer(fields) {
    let t = this.findTimer(fields.key, fields.id);
    if (!t) { t = {}; this.timers.push(t); }
    Object.assign(t, { elapsed: 0, last: 0, state: 0, code: 0, prop: 0, target: 0, step: 0, done: 0, base: 0 }, fields);
    return t;
  }
  tickTimers(dt) {
    this.timers = this.timers.filter(t => t.state !== 1);
    for (const t of this.timers) if (t.state === 0) t.state = 2;
    for (const t of [...this.timers]) {
      if (t.state !== 2 || !t.period) continue;
      t.elapsed += dt; let diff = t.elapsed - t.last;
      while (t.period <= diff) {
        diff -= t.period; t.last += t.period;
        let speed = 1;
        if (t.code) {
          if (t.state !== 2) break;
          const ret = this.run(t.sc, t.code, t.key, t.prop ? [t.id, t.last] : [t.id, t.last, t.period], { ret: asU(1) });
          if (t.prop) speed = asF(ret) || 1;
        }
        if (t.prop) {
          const a = propAddr(t.prop, t.base), v = this.mem.rf(a) + t.step * speed;
          if ((t.step > 0 && v < t.target) || (t.step < 0 && v > t.target)) this.mem.wf(a, v);
          else {
            this.mem.wf(a, t.target); t.state = 1;
            const cb = t.done || this.findEvent(t.sc, 0, x => (x.flags & 0x8000) && x.id === -14 && x.flags !== 0xc000);
            if (cb) this.run(t.sc, cb, t.key, [t.id]);
            break;
          }
        }
      }
    }
    this.timers = this.timers.filter(t => t.state !== 1);
  }

  loadScreen(buf, group, screen, { isGlobal = false, ctx = 0 } = {}) {
    const base = isGlobal ? 0x10000000 : this.nextBase;
    if (!isGlobal) this.nextBase += Math.ceil((buf.length + 0x1000) / 0x100000) * 0x100000;
    const data = Buffer.from(buf), layout = parseScreen(buf);
    // textPatch(group, screen, strings) -> [[string index, text]]: the screen's own texts changed before it runs
    // (e.g. the season settings' "12 Races" labels follow the configured schedules); a text must fit its capacity
    if (this.textPatch) for (const [i, t] of this.textPatch(group, screen, layout.strings) ?? []) { const s = layout.strings[i];
      if (!s || !s.offset || t.length + 1 > Math.max(s.capacity, s.text.length + 1)) continue; data.fill(0, s.offset, s.offset + s.text.length + 1); data.write(t, s.offset, "latin1"); s.text = t; }
    relocate(data, base); this.mem.map(base, data);
    const sc = { group, screen, base, data, layout, flags: 0, parent: NO_SCREEN, unloading: 0, ctx };
    if (isGlobal) { this.global = sc; return sc; }
    this.screens.push(sc);
    // 0x139470(.., -1): load screen-level objects, then every object below state 0
    for (let i = 0; i < data.readUInt32LE(24); i++) {
      const e = data.readUInt32LE(28) - base + i * 8, type = data.readUInt16LE(e), p = data.readUInt32LE(e + 4);
      if (!data.readUInt16LE(e + 2)) { this.callObject(sc, type, p ? base + this.mem.r32(p) : 0, -1, []); data.writeUInt16LE(1, e + 2); }
    }
    this.loadObjects(sc, 0, new Set());
    this.mem.w32(this.stateHdr(sc, 0) + 4, 1);
    this.dispatch(sc, 0, -9, []);
    return sc;
  }
  // object lifecycle messages (-2 when the screen opens: 0x1398C0 at 0x13AAF1; -3 when it closes: 0x139470 at
  // 0x13A5D0) to the screen-level objects and those of every state, for the object types that act on them
  lifecycle(sc, msg) {
    const types = new Set([...(this.lifecycleTypes ?? [])].filter(t => !this.lifecycleSkip?.(t, msg))); if (!types.size) return;
    const data = sc.data, base = sc.base;
    for (let i = 0; i < data.readUInt32LE(24); i++) {
      const e = data.readUInt32LE(28) - base + i * 8, type = data.readUInt16LE(e), p = data.readUInt32LE(e + 4);
      if (types.has(type) && p) this.callObject(sc, type, base + this.mem.r32(p), msg, []);
    }
    for (const st of sc.layout.states) for (const c of st.children) for (const it of c.items) if (it.type !== -1 && types.has(it.type)) this.callObject(sc, it.type, sc.base + it.data, msg, []);
  }
  loadObjects(sc, idx, seen) {
    if (seen.has(idx)) return; seen.add(idx);
    for (const c of sc.layout.states[idx].children) for (const it of c.items) {
      if (it.type === -1) this.loadObjects(sc, it.state, seen);
      else this.callObject(sc, it.type, sc.base + it.data, -1, []);
    }
  }
  // open = AddScreen (event -2 "OnMoveForward", or -3 "OnMoveBackward" when returning), then activate (0x13B230:
  // event -4 "OnScreenActivate")
  open(sc, args = [], { back = false } = {}) {
    this.lifecycle(sc, -2);
    this.dispatch(sc, 0, back ? -3 : -2, args); this.pump();
    this.activate(sc);
  }

  // ------------------------------------------------------------ screen stack (message kinds 0, 1, 3)
  // Screen ids are group | screen << 16 (group = uis_all entry). this.source(group, screen) supplies screen data.
  findScreen(id) { return this.screens.find(x => x.group === (id & 0xffff) && x.screen === (id >>> 16)); }
  // open (0x13AF10): the screen record keeps its opener (+8/+0xA) as `parent` for activate_parent and for focus on close
  // ctx: the UI context (game manager 0x2B7C38[ctx]) the screen belongs to; notifications stay inside a context
  openById(id, args = [], parent = NO_SCREEN, ctx = 0) {
    const group = id & 0xffff, screen = id >>> 16;
    let sc = this.findScreen(id);
    if (sc) { this.dispatch(sc, 0, -2, args); return sc; }               // already open: 0x13A330 re-sends -2
    const buf = this.source?.(group, screen);
    if (!buf) { this.log(`open ${group}/${screen}: no such screen`); return null; }
    sc = this.loadScreen(buf, group, screen, { ctx });
    sc.parent = parent >>> 0;
    this.dispatch(sc, 0, -2, args);
    return sc;
  }
  // close (0x13A4C0 + 0x13A3B0): remove the screen; if it is on the modal focus stack, pop it, give focus back to
  // the screen that opened it and resume the script that waited on it with `result`. Closing the focused screen
  // otherwise activates the top screen (kind 3).
  closeById(id, result = 0) {
    const sc = this.findScreen(id); if (!sc) return;
    id = (sc.group | (sc.screen << 16)) >>> 0;
    // 0x13A3B0: a screen on the modal focus stack gives focus back to its caller and resumes the waiting script
    const fi = this.focusStack.findLastIndex(e => e.id === id);
    if (fi >= 0) {
      const [e] = this.focusStack.splice(fi, 1);
      // focus goes back to the caller; if the caller has closed meanwhile, a screen activated while the modal was up
      // keeps the focus
      this.focus = this.screens.includes(e.caller) ? e.caller : (this.focus !== sc && this.screens.includes(this.focus) ? this.focus : null);
      if (e.resume && this.screens.includes(e.resume.sc)) { e.resume.result = result; this.run(e.resume.sc, 0, e.resume.thisHdr, [], { resume: e.resume }); }
    }
    const wasFocus = this.focus === sc;
    for (const x of this.screens) if (x.parent === id) x.parent = sc.parent;   // children inherit the closing screen's opener
    this.dispatch(sc, 0, -3, []);                                              // OnMoveBackward to the closing screen
    this.lifecycle(sc, -3);
    this.timers = this.timers.filter(t => t.sc !== sc);
    this.screens = this.screens.filter(x => x !== sc);
    if (this.video && this.video.o >= sc.base && this.video.o < sc.base + sc.data.length) { this.video = null; this.setVideoEnded(1); }   // its element went with the screen
    if (wasFocus) {                                                            // focus -> opener, else the top screen; then activate it
      this.focus = null;
      const next = this.findScreen(sc.parent) ?? this.screens.at(-1);
      if (next) this.post(3, next, { screen: (next.group | (next.screen << 16)) >>> 0 });
    }
  }
  // Event to the focused screen only (0x13A9D0 with all = 0: range [focus, focus + 1)), or to all screens.
  sendEvent(ev, args = [], { all = false, target = 0 } = {}) {
    const f = this.inputFocus();
    const list = all ? [...this.screens] : f && this.screens.includes(f) ? [f] : [];
    for (const sc of list) if (this.screens.includes(sc)) this.dispatch(sc, 0, ev, args, target);
  }
  // Screen that receives input: the top of the modal focus stack when there is one (0x13A890 recomputes it), else
  // the focused screen.
  inputFocus() {
    const top = this.focusStack.at(-1);
    return top ? (this.findScreen(top.id) ?? null) : this.focus;
  }
  // activate (0x13B230, kind 3) / deactivate (kind 4): with no modal screen, -5 goes to the old focus; activating
  // then sets state 0 active, moves focus and sends -4 to the new focus.
  activate(sc, on = true) {
    if (!this.focusStack.length) this.sendEvent(-5);
    if (!on || !sc) return;
    this.mem.w32(this.stateHdr(sc, 0) + 4, 1);
    this.focus = sc;
    this.dispatch(sc, 0, -4, []);           // to the activated screen itself, also while a modal screen has the input
    this.pump();
  }

  // ------------------------------------------------------------ structure helpers (layout offsets are unrelocated)
  stateHdr(sc, i) { return sc.base + sc.layout.states[i].header; }
  stateByHdr(sc, hdr) { return sc.layout.states.findIndex(s => sc.base + s.header === (hdr >>> 0)); }
  active(sc, i) { return this.mem.r32(this.stateHdr(sc, i) + 4) !== 0; }
  parentOf(sc, child) { return sc.layout.states.findIndex(s => s.events.some(e => e.flags === 0xc000 && e.id === -1 && e.code === child)); }
  findEvent(sc, i, pred) { const e = sc.layout.states[i].events.find(pred); return e ? sc.base + e.code : 0; }

  // ------------------------------------------------------------ events (0x139B20)
  dispatch(sc, idx, ev, args, target = 0) {
    this.depth = (this.depth || 0) + 1;
    try { return this.dispatchInner(sc, idx, ev, args, target); } finally { this.depth--; }
  }
  dispatchInner(sc, idx, ev, args, target) {
    const st = sc.layout.states[idx]; if (!st) return 0;
    const hdr = this.stateHdr(sc, idx);
    if ((this.mem.r32(hdr + 4) && this.mem.r32(hdr + 0x60)) || ALWAYS.has(ev)) {
      for (const e of st.events) if (e.id === -1 && e.flags === 0xc000) {
        const childActive = this.dispatch(sc, e.code, ev, args, target);
        if (childActive === 1) {
          const h = this.findEvent(sc, idx, x => !(x.flags & 0xc000) && x.id === ev && (x.flags & 0x2fff) === e.code);
          if (h) this.run(sc, h, hdr, args);
        }
      }
      this.pump();                      // 0x13C7A0(mgr, 1): children's posts (state switches) land before this state's own handler
      const h = this.findEvent(sc, idx, x => (x.flags & 0x8000) && x.id === ev && x.flags !== 0xc000);
      if (h && ((ev !== -6 && ev !== -7) || hdr === target)) this.run(sc, h, hdr, args);
    }
    return this.mem.r8(hdr + 4);
  }
  // enable/disable a state (0x13AC10); enabling deactivates the active sibling (0x13BE60)
  // The -6 / -7 handlers (and the parent's handler for that child) get two arguments, as 0x13AC10 passes them to
  // 0x13B480: the enabling op's key (op 0x47: the signed direction it was given, e.g. -1 / 1 for up / down; 0
  // otherwise) and the target's index in the op's state table (-1 without one). Menus use the direction to pass the
  // highlight on past an unavailable item (Career Build Car 9/13: Engine / Body before a chassis is chosen). (One
  // argument, the index, was passed before, so the direction read as 0 and the highlight stopped on such items.)
  setState(sc, hdr, on, args = [0, -1]) {
    const idx = this.stateByHdr(sc, hdr); if (idx < 0) return;
    const parent = this.parentOf(sc, idx);
    if (on && parent >= 0) for (const e of sc.layout.states[parent].events)
      if (e.flags === 0xc000 && e.id === -1 && e.code !== idx && this.active(sc, e.code)) { this.setState(sc, this.stateHdr(sc, e.code), false); break; }
    const ev = on ? -6 : -7, h = this.findEvent(sc, idx, x => (x.flags & 0x8000) && x.id === ev && x.flags !== 0xc000);
    this.mem.w32(hdr + 4, on ? 1 : 0);
    if (h) this.run(sc, h, hdr, args);
    if (parent >= 0) { const ph = this.findEvent(sc, parent, x => !(x.flags & 0xc000) && x.id === ev && (x.flags & 0x2fff) === idx); if (ph) this.run(sc, ph, this.stateHdr(sc, parent), args); }
  }
  // a screen id whose low half is -1 means "the calling screen"
  screenId(sc, id) { id >>>= 0; return (id & 0xffff) === 0xffff ? (sc.group | (sc.screen << 16)) : id; }
  post(kind, sc, data, args = []) { this.stats.posts[kind] = (this.stats.posts[kind] || 0) + 1; this.queue.push({ kind, sc, data, args }); }
  pump(limit = 10000) {
    if (this.pumping) return;           // 0x13C7A0 is guarded by manager flag bit 0: nested pumps return at once
    this.pumping = true;
    try { this.pumpInner(limit); } finally { this.pumping = false; }
  }
  pumpInner(limit) {
    while (this.queue.length && limit-- > 0) {
      const m = this.queue.shift();
      switch (m.kind) {
        case 5: this.setState(m.sc, m.data.target, true, m.args.length ? m.args : [0, -1]); break;
        case 6: this.setState(m.sc, m.data.target, false, m.args.length ? m.args : [0, -1]); break;
        case 2: { const ctx = m.data.ctx ?? m.sc?.ctx ?? 0; for (const sc of [...this.screens]) if (sc.ctx === ctx) this.dispatch(sc, 0, m.data.event, m.args); break; }
        case 7: this.sendEvent(m.data.event, m.args); break;           // 0x13A9D0: the focused screen
        case 0: this.openById(this.screenId(m.sc, m.data.screen), m.args, m.sc ? m.sc.group | (m.sc.screen << 16) : NO_SCREEN, m.data.ctx ?? m.sc?.ctx ?? 0); break;
        case 1: this.closeById(this.screenId(m.sc, m.data.screen), m.data.result ?? 0); break;
        case 3: case 4: { const sc = this.findScreen(this.screenId(m.sc, m.data.screen)); if (sc || m.kind === 4) this.activate(sc, m.kind === 3); else this.log(`activate ${m.data.screen.toString(16)}: not open`); break; }
        case 9: this.notify(m.data.event, m.args, m.data.ctx ?? m.sc?.ctx ?? 0); break;
        case 8: {                       // 0x13BEB0: move a screen b places in the stack (draw order; +1 = towards the top)
          const sc = this.findScreen(this.screenId(m.sc, m.data.a)); if (!sc) break;
          let i = this.screens.indexOf(sc), n = Math.abs(m.data.b | 0); const d = (m.data.b | 0) < 0 ? -1 : 1;
          while (n-- > 0 && i + d >= 0 && i + d < this.screens.length) { [this.screens[i], this.screens[i + d]] = [this.screens[i + d], this.screens[i]]; i += d; }
          break;
        }
        default: this.log(`post ${m.kind} ${JSON.stringify(m.data)} (not modelled)`);
      }
    }
  }

  // ------------------------------------------------------------ game notifications (kind 9, 0x13C130 -> 0x13C080):
  // every open screen, every state reached through child links (active or not), handler flagged 0x4000 with the id
  notify(ev, args = [], ctx = 0) {
    for (const sc of [...this.screens]) {
      if (sc.ctx !== ctx) continue;
      const walk = (idx, seen) => {
        if (seen.has(idx)) return; seen.add(idx);
        const st = sc.layout.states[idx]; if (!st) return;
        for (const e of st.events) if (e.flags === 0xc000 && e.id === -1) walk(e.code, seen);
        const h = this.findEvent(sc, idx, x => (x.flags & 0x4000) && !(x.flags & 0x8000) && x.id === (ev << 16 >> 16));
        if (h) this.run(sc, h, this.stateHdr(sc, idx), args);
      };
      walk(0, new Set());
    }
  }
  // ------------------------------------------------------------ controller input (0x13A890): message id = button
  // (0 A, 2 up, 3 down, 4 left, 5 right, 6 X, 7 START, 9 back; see analysis_notes). Delivered to the input focus
  // (top of the modal focus stack, else the focused screen) unless its input mask (ops 0x4F/0x50/0x74) has the
  // controller's bit set.
  press(msg, controller = 0, { all = false, value = 1, ctx = 0 } = {}) {   // value: button pressure, 1.0 = pressed
    const f = this.inputFocus(), bit = (1 << controller) >>> 0;
    for (const sc of all ? this.screens.filter(x => x.ctx === ctx) : f ? [f] : []) {
      const m = (sc.flags & bit) >>> 0;
      if (m === 0 || (m === 1 && msg < 0)) this.dispatch(sc, 0, msg, [asU(value)]);
    }
    this.pump();
  }

  // ------------------------------------------------------------ objects
  callObject(sc, type, obj, msg, args) {
    const h = this.handlers[type];
    return h ? (h(this, sc, obj, msg, args) ?? 0) : 0;
  }

  // ------------------------------------------------------------ script VM (0x13B480 + 0x13CAB0)
  // scripts share one stack (sp0), so nothing may start a script while one runs: `running` is what the game's
  // manager busy flags (byte +4 & 6) report to 0x13C1C0
  run(sc, code, thisHdr, args, opts) { this.running = (this.running || 0) + 1; try { return this.run0(sc, code, thisHdr, args, opts); } finally { this.running--; } }
  get idle() { return !this.running && !this.depth && !this.pumping; }
  run0(sc, code, thisHdr, args = [], { maxSteps = 2_000_000, ret = 0, resume = null } = {}) {
    const m = this.mem; let sp = this.sp0, steps = 0, suspended = false;
    const push = v => { m.w32(sp, v); sp += 4; }, pop = () => { sp -= 4; return m.r32(sp); };
    const cell = k => sp + k * 4;                          // puVar24[k]
    const resolve = a => (a & 0x80000000) ? ((this.global?.base ?? 0) + (a & 0x7fffffff)) >>> 0 : (sc.base + a) >>> 0;
    const retSlot = sp;
    let pc = code >>> 0; this.stats.scripts++; this.callTrace = [];
    if (resume) { resume.stack.copy(this.stack.buf, 0); sp = resume.sp; pc = resume.pc; m.w32(sp - 4, resume.result >>> 0); }
    else { push(ret); for (const a of args) push(a >>> 0); push(thisHdr); push(0); }
    const gs = () => sc.group | (sc.screen << 16);
    // operand / stack helpers (made once per script, not per instruction: they see pc and sp through the closure)
    const imm32 = () => { const v = m.r32(pc); pc += 4; return v; };
    const imm6 = () => { const off = m.r32(pc), slot = (m.r16(pc + 4) << 16) >> 16; pc += 6; return (m.r32(cell(slot)) + off) >>> 0; };
    const top = () => m.r32(sp - 4), setTop = v => m.w32(sp - 4, v >>> 0), sec = () => m.r32(sp - 8), setSec = v => m.w32(sp - 8, v >>> 0);
    const bin = f => { const b = pop(); setTop(f(top(), b)); };
    const fbin = f => { const b = asF(pop()); setTop(asU(f(asF(top()), b))); };
    const EPS = 1.1920929e-07;
    try { while (pc) {
      if (++steps > maxSteps) { this.log(`script at 0x${code.toString(16)} exceeded ${maxSteps} steps`); break; }
      const op = m.r8(pc++); this.stats.insns++;
      switch (op) {
        case 0x01: case 0x6a: break;
        case 0x02: case 0x71: { const n = m.r8(pc++); const argv = []; for (let i = n; i > 0; i--) argv.push(m.r32(cell(-i))); sp -= n * 4; const id = pop();
          this.post(0, sc, { screen: id }, argv); break; }
        case 0x03: { const result = pop(), id = pop(); this.post(1, sc, { screen: id, result }); break; }   // close_screen id, result
        case 0x06: { const key = pop(), period = s32(pop()), code = resolve(pop()), id = pop();   // rate_start (0x13C940)
          this.addTimer({ sc, key, id, code, period: Math.max(1, period) }); break; }
        case 0x07: { const key = pop(), id = pop(); const t = this.findTimer(key, id); if (t) t.state = 1; break; }
        case 0x08: this.post(3, sc, { screen: pop() }); break;
        case 0x0a: {                                                      // obj_call
          const argc = s32(pop()), type = pop(), method = pop(), ref = pop();
          const argBase = sp - argc * 4, argv = []; for (let i = 0; i < argc; i++) argv.push(m.r32(argBase + i * 4));
          const obj = ref ? (sc.base + m.r32(ref)) >>> 0 : 0;
          const ret = this.callObject(sc, type, obj, s32(method), argv);
          m.w32(argBase - 4, ret); break;
        }
        case 0x0b: {                                                      // native_call
          // stack: [ret][fnId][a1..aN][argc]; the VM drops 2 cells and reads fnId N cells below (0x13CD58)
          const argc = s32(top()); sp -= 8;
          const fnAddr = sp - argc * 4, id = m.r32(fnAddr), argv = []; for (let i = 0; i < argc; i++) argv.push(m.r32(fnAddr + 4 + i * 4));
          this.nativeCalls.set(id, (this.nativeCalls.get(id) || 0) + 1);
          const fn = this.natives[id], ctx = { vm: this, sc, id, args: argv };
          const ret = fn ? fn(ctx) : this.nativeHandler ? this.nativeHandler(ctx) : 0;
          m.w32(fnAddr - 4, (ret ?? 0) >>> 0); break;
        }
        case 0x0c: { const argc = s32(pop()); const ev = pop(); pop(); const argBase = sp - argc * 4, argv = [];
          for (let i = 0; i < argc; i++) argv.push(m.r32(argBase + i * 4)); this.post(7, sc, { event: s32(ev) }, argv); break; }
        case 0x0d: push(sc.base); break;
        case 0x0e: { const dst = pop(), src = pop(); if (dst && src) { const n = Math.min(m.r32(dst + 4), m.r32(src + 4)); m.wstr(m.r32(dst + 8), m.cstr(m.r32(src + 8)).slice(0, n), n); } break; }
        case 0x0f: case 0x10: case 0x11: push(imm32()); break;
        case 0x12: setTop(Math.trunc(asF(top()))); break;
        case 0x13: setTop(asU(s32(top()))); break;
        case 0x14: setSec(Math.trunc(asF(sec()))); break;
        case 0x15: setSec(asU(s32(sec()))); break;
        case 0x18: setTop(m.r32(top())); break;
        case 0x19: { const a = pop(), v = pop(); m.w32(a, v); break; }
        case 0x1a: setTop(m.r32(cell(s32(top()) - 1))); break;
        case 0x1b: { const k = s32(top()); m.w32(cell(k - 1), sec()); sp -= 8; break; }
        case 0x1c: bin((a, b) => a & b); break;
        case 0x1d: bin((a, b) => a | b); break;
        case 0x1e: setTop(~top()); break;
        case 0x1f: bin((a, b) => (a && b) ? 1 : 0); break;
        case 0x20: bin((a, b) => (a || b) ? 1 : 0); break;
        case 0x21: setTop(top() ? 0 : 1); break;
        case 0x22: setTop(Math.abs(s32(top()))); break;
        case 0x23: setTop(asU(Math.abs(asF(top())))); break;
        case 0x24: setTop(-s32(top())); break;
        case 0x25: bin((a, b) => s32(a) + s32(b)); break;
        case 0x26: bin((a, b) => s32(a) - s32(b)); break;
        case 0x27: bin((a, b) => Math.imul(a, b)); break;
        case 0x28: bin((a, b) => s32(b) ? Math.trunc(s32(a) / s32(b)) : 0); break;
        case 0x29: setTop(asU(-asF(top()))); break;
        case 0x2a: fbin((a, b) => a + b); break;
        case 0x2b: fbin((a, b) => a - b); break;
        case 0x2c: fbin((a, b) => a * b); break;
        case 0x2d: fbin((a, b) => b ? a / b : 0); break;
        case 0x2e: setTop(s32(top()) + 1); break;
        case 0x2f: setTop(s32(top()) - 1); break;
        case 0x30: setTop(asU(asF(top()) + 1)); break;
        case 0x31: setTop(asU(asF(top()) - 1)); break;
        case 0x32: bin((a, b) => s32(a) >= s32(b) ? 1 : 0); break;
        case 0x33: bin((a, b) => s32(a) <= s32(b) ? 1 : 0); break;
        case 0x34: bin((a, b) => s32(a) > s32(b) ? 1 : 0); break;
        case 0x35: bin((a, b) => s32(a) < s32(b) ? 1 : 0); break;
        case 0x36: bin((a, b) => (a >>> 0) === (b >>> 0) ? 1 : 0); break;
        case 0x37: bin((a, b) => (a >>> 0) !== (b >>> 0) ? 1 : 0); break;
        case 0x38: { const b = asF(pop()), a = asF(top()); setTop(b <= a + EPS ? 1 : 0); break; }
        case 0x39: { const b = asF(pop()), a = asF(top()); setTop(a - EPS <= b ? 1 : 0); break; }
        case 0x3a: { const b = asF(pop()), a = asF(top()); setTop(a - EPS <= b ? 0 : 1); break; }
        case 0x3b: { const b = asF(pop()), a = asF(top()); setTop(b <= a + EPS ? 0 : 1); break; }
        case 0x3c: { const b = asF(pop()), a = asF(top()); setTop(Math.abs(b - a) < EPS ? 1 : 0); break; }
        case 0x3d: { const b = asF(pop()), a = asF(top()); setTop(Math.abs(b - a) <= EPS ? 0 : 1); break; }
        case 0x3e: { const off = s32(pop()), c = pop(); if (c) pc = (pc + off) >>> 0; break; }
        case 0x3f: { const off = s32(pop()), c = pop(); if (!c) pc = (pc + off) >>> 0; break; }
        case 0x40: { const off = s32(pop()); pc = (pc + off) >>> 0; break; }
        case 0x41: push(top()); break;
        case 0x42: sp -= 4; break;
        case 0x43: { const t = imm32(); push(pc); pc = resolve(t); if (this.traceCalls) this.callTrace.push(pc - sc.base); if (this.onCall) this.onCall(sc, pc, sp); break; }
        case 0x44: pc = pop(); break;
        case 0x45: { const n = m.r8(pc++); const ref = pop(); const v = m.r32(sc.base + m.r32(ref));
          if (v !== 0xffffffff) { const argv = []; for (let i = n; i > 0; i--) argv.push(m.r32(cell(-i))); this.post(0, sc, { screen: v }, argv); this.post(3, sc, { screen: v }); sp -= n * 4; } break; }
        case 0x46: this.post(6, sc, { target: pop() }); break;
        case 0x47: { const key = pop(), tbl = pop(), index = s32(pop()); const t = sc.base + m.r32(tbl);
          if (index < s32(m.r32(t))) { const target = (m.r32(t + 8 + index * 4) + sc.base) >>> 0;
            if (target !== thisHdr || !m.r32(target + 4)) this.post(5, sc, { target, key: key & 0xffff }, [(key << 16) >> 16, index]); } break; }
        case 0x48: this.post(3, sc, { screen: sc.parent }); break;        // activate the screen that opened this one (0x13D5A3)
        case 0x49: { const r = pop(); setTop(r ? m.cstr(m.r32(r + 8)).length : 0); break; }   // pops, result replaces the cell below
        case 0x4a: { const i = pop(), r = pop(); setTop(r && i < m.r32(r + 4) ? (m.r8(m.r32(r + 8) + i) << 24) >> 24 : 0); break; }
        case 0x4b: { const v = pop(), i = pop(), r = pop(); if (r && i < m.r32(r + 4)) m.w8(m.r32(r + 8) + i, v); break; }
        case 0x4c: { const n = s32(pop()); const argv = new Array(n); for (let i = n - 1; i >= 0; i--) argv[i] = pop();
          const fmt = pop(), dst = pop(); if (dst && fmt) m.wstr(m.r32(dst + 8), sprintf(m, m.cstr(m.r32(fmt + 8)), argv), m.r32(dst + 4)); break; }
        case 0x4d: { const a = pop(), ev = pop(); this.post(2, sc, { event: s32(ev) }, [a]); break; }
        case 0x4e: pc += 4; break;
        // (traceFlags: optional debug hook, who changes a screen's input mask)
        case 0x4f: sc.flags = 0; this.traceFlags?.(sc, pc, code); break;
        case 0x50: sc.flags = 0xffffffff; this.traceFlags?.(sc, pc, code); break;
        case 0x51: case 0x70: {                                          // open_screen_wait (0x13D7A2)
          const n = m.r8(pc++); const argv = []; for (let i = n; i > 0; i--) argv.push(m.r32(cell(-i))); sp -= n * 4; const id = pop();
          if (this.focusStack.length >= FOCUS_CAP) break;               // stack full: the game drops the request
          const target = this.screenId(sc, id);
          this.post(0, sc, { screen: target, wait: true }, argv);
          // suspend: the script resumes when that screen closes, with the close result in the cell the id used
          this.focusStack.push({ id: target, caller: sc, resume: { sc, pc, thisHdr, sp, stack: Buffer.from(this.stack.buf.subarray(0, sp - this.stackBase)) } });
          suspended = true; pc = 0; break;
        }
        case 0x52: { const a = top(), b = sec(); setTop(b); setSec(a); break; }
        case 0x54: case 0x7e: this.post(5, sc, { target: pop() }); break;
        case 0x55: case 0x6b: { const a = imm6(); push(op === 0x6b ? a : m.r32(a)); break; }
        case 0x56: { const a = imm6(); if (WATCH !== null && a === WATCH) this.log(`watch: ${sc.group}/${sc.screen} pc 0x${(pc - 7 - sc.base).toString(16)} writes ${top() | 0}`); m.w32(a, top()); sp -= 4; break; }
        case 0x57: push(imm6()); break;
        case 0x58: {                                                      // tween (0x13C860)
          const n = m.r8(pc++); const key = pop(), base = pop(); let cbB = 0, cbA = 0;
          if (n > 5) { const v = pop(); cbB = v ? resolve(v) : 0; } if (n > 4) { const v = pop(); cbA = v ? resolve(v) : 0; }
          const duration = s32(pop()), target = asF(pop()), prop = s32(pop()), id = pop();
          const addr = propAddr(prop, base);
          if (addr) { const steps = duration / this.frameMs, step = steps > 0 ? (target - m.rf(addr)) / steps : (target - m.rf(addr));
            this.addTimer({ sc, key, id, code: cbB, period: this.frameMs, prop, target, step, done: cbA, base }); }
          this.stats.tweens++; break;
        }
        case 0x59: { pc += 7; sp -= 4; break; }                            // preload/unload subtree resources
        case 0x5a: bin((a, b) => s32(b) ? s32(a) % s32(b) : 0); break;
        case 0x5b: case 0x5d: case 0x5f: case 0x61: case 0x6c: case 0x6d: case 0x6e: {
          let arr, extra = 1;
          if (op === 0x5b || op === 0x6c) arr = cell(s32(top()) - 1);
          else if (op === 0x5d || op === 0x6d) arr = top();
          else if (op === 0x5f || op === 0x6e) { arr = imm6(); extra = 0; }
          else arr = m.r32(cell(s32(top()) - 1));
          const n = s32(m.r32(arr)); let off = 0, stride = 1, ip = sp - (extra * 4 + 4);
          for (let k = 1; k <= n; k++, ip -= 4) { const dim = s32(m.r32(arr + k * 4)); let i = s32(m.r32(ip)); if (i >= dim || i < 0) i = dim - 1; off += i * stride; stride *= dim; }
          const ea = arr + (n + 1 + off) * 4, res = (op === 0x6c || op === 0x6d || op === 0x6e) ? ea : m.r32(ea);
          m.w32(sp - (extra + n) * 4, res); sp = sp - (extra + n) * 4 + 4; break;
        }
        case 0x5c: case 0x5e: case 0x60: case 0x62: {
          let arr, extra = 1;
          if (op === 0x5c) arr = cell(s32(top()) - 1); else if (op === 0x5e) arr = top();
          else if (op === 0x60) { arr = imm6(); extra = 0; } else arr = m.r32(cell(s32(top()) - 1));
          const n = s32(m.r32(arr)); let off = 0, stride = 1, ip = sp - (extra * 4 + 8);
          for (let k = 1; k <= n; k++, ip -= 4) { const dim = s32(m.r32(arr + k * 4)); let i = s32(m.r32(ip)); if (i >= dim || i < 0) i = dim - 1; off += i * stride; stride *= dim; }
          m.w32(arr + (off + n + 1) * 4, m.r32(sp - (extra * 4 + 4))); sp -= (n + extra) * 4 + 4; break;
        }
        case 0x63: { const n = s32(imm32()), v = top(); for (let i = 0; i < n; i++) push(v); break; }
        case 0x64: sp -= s32(imm32()) * 4; break;
        case 0x65: { const n = s32(imm32()); for (let i = 0; i < n; i++) m.w32(sp + i * 4, m.r32(sp - n * 4 + i * 4)); sp += n * 4; break; }
        case 0x66: case 0x67: case 0x68: {
          let arr, extra = 1;
          if (op === 0x66) arr = cell(s32(top()) - 1); else if (op === 0x67) arr = top(); else { arr = imm6(); extra = 0; }
          const n = s32(m.r32(arr)); let count = 1; for (let k = 1; k <= n; k++) count *= s32(m.r32(arr + k * 4));
          const v = m.r32(sp - (extra * 4 + 4)); for (let i = 0; i < count; i++) m.w32(arr + (n + 1 + i) * 4, v);
          sp -= extra * 4 + 4; break;
        }
        case 0x69: setTop(cell(s32(top()) - 1)); break;
        case 0x6f: { const i = top(); setTop(i < sc.data.readUInt32LE(8) ? sc.data.readUInt32LE(12) + i * 12 : 0); break; }
        case 0x72: { const b = pop(), a = pop(); this.post(8, sc, { a, b }); break; }
        case 0x73: { const key = pop(), id = pop(); push(this.findTimer(key, id) ? 1 : 0); break; }
        case 0x74: { const v = pop(), bit = s32(pop()); const mask = bit < 0 ? 0xffffffff : (1 << (bit & 31)) >>> 0;
          sc.flags = (v === 0 ? (sc.flags | mask) : (sc.flags & ~mask)) >>> 0; this.traceFlags?.(sc, pc, code); break; }
        case 0x75: setTop(((1 << (top() & 31)) & sc.flags) === 0 ? 1 : 0); break;
        case 0x76: { const argc = s32(pop()); sp -= 4; const base = sp - argc * 4, ev = m.r32(base), argv = []; for (let i = 1; i <= argc; i++) argv.push(m.r32(base + i * 4));   // [ev][a1..aN][argc]
          this.post(9, sc, { event: s32(ev) }, argv); break; }
        case 0x77: { const v = pop(); setTop((v & 0xffff) === sc.group ? 1 : 0); break; }
        case 0x78: setTop(sc.group | (sc.screen << 16)); break;
        case 0x79: { const r = pop(); setTop(r ? m.r32(r + 4) : 0); break; }
        case 0x7a: case 0x7b: { const r = pop(); if (r) { const p = m.r32(r + 8), s = m.cstr(p); m.wstr(p, op === 0x7a ? s.toUpperCase() : s.toLowerCase(), s.length); } break; }
        case 0x7c: { const rep = pop(), find = pop(), r = pop(); if (r && find && rep) { const p = m.r32(r + 8); m.wstr(p, m.cstr(p).split(m.cstr(m.r32(find + 8))).join(m.cstr(m.r32(rep + 8))), m.r32(r + 4)); } break; }
        case 0x7d: { const r = pop(); if (r) this.log(`script print: ${m.cstr(m.r32(r + 8))}`); break; }
        default: pc = 0; break;                                            // 4, 5, 9, 0x16, 0x17, 0x53: end
      }
      void gs;
    } } catch (e) { this.log(`script 0x${code.toString(16)} (this 0x${(thisHdr >>> 0).toString(16)}, args ${args.map(a => (a >>> 0).toString(16))}) aborted at pc 0x${(pc - 1).toString(16)}: ${e.message}` + (this.traceCalls ? ` calls ${this.callTrace.map(x => x.toString(16))}` : "")); this.stats.aborts = (this.stats.aborts || 0) + 1; }
    // memcmp against a zero page (a per-byte scan of 64 KB ran on every script call)
    if (!this.zero.buf.equals(ZERO_PAGE)) { this.stats.nullWrites = (this.stats.nullWrites || 0) + 1; this.zero.buf.fill(0); }
    const result = m.r32(retSlot);
    this.stack.buf.fill(0, 0, 0x400);
    if (!this.depth) this.pump();          // nested runs (inside dispatch) leave posts queued, as the game's per-frame queue does
    return result;
  }
}

// property id -> field of a state header (0x13B570)
function propAddr(id, base) {
  const off = { 0x10: 0x20, 0x11: 0x24, 0x12: 0x28, 0x13: 8, 0x14: 0xc, 0x15: 0x10, 0x16: 0x2c, 0x17: 0x30, 0x18: 0x34,
                0x19: 0x14, 0x1a: 0x18, 0x1b: 0x1c, 0x20: 0x58, 0x21: 0x4c, 0x22: 0x50, 0x23: 0x54, 0x25: 0x3c, 0x26: 0x40, 0x27: 0x44 }[id] ?? 0x48;
  return base ? (base + off) >>> 0 : 0;
}

// printf subset used by 0x13BAE0: %d %i %u %x %X %p %c %s %f with flags '-', '0' and width
function sprintf(m, fmt, args) {
  let ai = 0;
  return fmt.replace(/%(-?)(0?)(\d*)(?:\.(\d+))?([diuxXpcsf%])/g, (all, left, zero, width, prec, t) => {
    if (t === "%") return "%";
    const a = args[ai++] ?? 0; let s;
    switch (t) {
      case "d": case "i": s = String(a | 0); break;
      case "u": s = String(a >>> 0); break;
      case "x": case "p": s = (a >>> 0).toString(16); break;
      case "X": s = (a >>> 0).toString(16).toUpperCase(); break;
      case "c": s = String.fromCharCode(a & 0xff); break;
      case "s": s = a ? m.cstr(m.r32(a + 8)) : ""; break;
      case "f": s = asF(a).toFixed(prec !== undefined ? +prec : 6); break;
    }
    const w = +width || 0; if (s.length < w) s = left ? s.padEnd(w) : s.padStart(w, zero ? "0" : " ");
    return s;
  });
}

const VIDEO_GROUPS = new Set([14, 32, 33, 34, 35]);   // texture groups registered with kind 5 (video)
const WATCH = process.env.NT04_VM_WATCH ? parseInt(process.env.NT04_VM_WATCH, 16) : null;   // debug: log script stores to this address

// ---------------------------------------------------------------- object handlers
// Type 8 (0x142200): the immediate-mode ellipse / pie (drawn by uis-render drawFan). Methods store their arguments
// (unless byte +1 bit 7 is set): 0 → +0x3C/+0x40 centre, 1 → +0x24/+0x28, 2 → +0x2C/+0x30 radii, 3 → +0x34 start,
// 4 → +0x38 end angle, 5 → +0x1C/+0x20, 6 / 7 → colours +0x14 / +0x18 (four bytes), 8 → u16 +0x10 segments,
// 11 → u16 +8 / +0xA, 12 / 13 → first byte of +0x14 / +0x18. (9 / 10 change its texture through the texture cache:
// no screen uses a textured one.)
function fanHandler(vm, sc, o, msg, a) {
  const m = vm.mem; if (!o || (m.r8(o + 1) & 0x80)) return 0;
  const two = off => { m.w32(o + off, a[0] >>> 0); m.w32(o + off + 4, a[1] >>> 0); };
  switch (msg) {
    case 0: two(0x3c); break; case 1: two(0x24); break; case 2: two(0x2c); break; case 5: two(0x1c); break;
    case 3: m.w32(o + 0x34, a[0] >>> 0); break; case 4: m.w32(o + 0x38, a[0] >>> 0); break;
    case 6: case 7: for (let i = 0; i < 4; i++) m.w8(o + (msg === 6 ? 0x14 : 0x18) + i, a[i] & 0xff); break;
    case 8: m.w16(o + 0x10, a[0] & 0xffff); break;
    case 11: if ((a[0] >>> 16) !== 0xffff && (a[0] & 0xffff) !== 0xffff) { m.w16(o + 8, a[0] & 0xffff); m.w16(o + 0xa, a[0] >>> 16); } break;
    case 12: m.w8(o + 0x14, a[0] & 0xff); break; case 13: m.w8(o + 0x18, a[0] & 0xff); break;
  }
  return 0;
}
function elementHandler(vm, sc, o, msg, a) {
  const m = vm.mem; if (!o) return 0;
  const vtx = i => (i === 0xffffffff || i === -1) ? [0, 1, 2, 3] : [i & 3];
  switch (msg) {
    // -1 (load, 0x140127 -> 0x13FA10 -> 0x142C80): a textured element whose flag bit 0 is clear gets bit 0 set and
    // the RGB of its four vertex colours set to ff (alpha kept): only elements authored with bit 0 keep their colours.
    // (The race HUD's / results' manufacturer logo is two copies of the logo: the larger one behind, authored 990000
    // with bit 0 clear, so white on the console; the front one's colour is set by the script. Drawn with the authored
    // red, every logo had a red rim. The magenta / ff3333 elements once special-cased in uis-render are all bit 0 clear.)
    case -1: { const f = m.r8(o); if ((f & 2) && !(f & 1)) { m.w8(o, f | 1); for (let i = 0; i < 4; i++) { m.w8(o + 0x14 + i * 4, 0xff); m.w8(o + 0x15 + i * 4, 0xff); m.w8(o + 0x16 + i * 4, 0xff); } }
      m.w8(o + 1, m.r8(o + 1) | 0x40); break; }
    case 0: for (const i of vtx(a[0])) { m.w16(o + 0x34 + i * 6, Math.trunc(asF(a[1]) * 16)); m.w16(o + 0x36 + i * 6, Math.trunc(asF(a[2]) * 16)); m.w16(o + 0x38 + i * 6, Math.trunc(asF(a[3]) * 16)); } break;
    case 1: for (const i of vtx(a[0])) { m.w16(o + 0x24 + i * 4, Math.trunc(asF(a[1]) * 256)); m.w16(o + 0x26 + i * 4, Math.trunc(asF(a[2]) * 256)); } break;
    case 2: for (const i of vtx(a[0])) { m.w8(o + 0x14 + i * 4, a[1]); m.w8(o + 0x15 + i * 4, a[2]); m.w8(o + 0x16 + i * 4, a[3]); } break;
    case 3: for (const i of vtx(a[0])) m.w8(o + 0x17 + i * 4, a[1]); break;
    case 5: { let group = a[0] >>> 16; if (!group || group === 0xffff) group = m.r16(o + 6); m.w16(o + 4, a[0] & 0xffff); m.w16(o + 6, group); break; }
    case 7: if ((a[0] & 0xffff) !== 0xffff && (a[0] >>> 16) !== 0xffff) { m.w16(o + 8, a[0] & 0xffff); m.w16(o + 0xa, a[0] >>> 16); } break;
    case 8: {                                                           // 0x1406D0: play the element's video texture
      const group = (m.r16(o + 6) << 16) >> 16, entry = (m.r16(o + 4) << 16) >> 16;
      if (VIDEO_GROUPS.has(group) && !vm.video) {
        vm.video = { o, group, entry, t0: vm.time, dur: vm.videoDuration?.(group, entry) ?? 0, seq: ++vm.videoSeq, ended: false };
        vm.setVideoEnded(0);
      }
      break; }
    case 9: if (vm.video) { vm.video = null; vm.setVideoEnded(1); } break;   // 0x140710: stop it
    case 10: for (const i of vtx(a[0])) m.w8(o + 0x14 + i * 4, a[1]); break;
    case 11: return 1;
  }
  return 0;
}

// 0x130800: width of one line in a UI font (glyph advances, kerning pairs unless disabled; missing glyphs use 0xB5)
function measureLine(f, str, kern = true) {
  let w = 0, prev = -1;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i), g = f.glyphs.get(c) ?? (c === 13 ? null : f.glyphs.get(0xb5)); if (!g) continue;
    if (kern && prev >= 0) w += f.kern.get(prev << 16 | c) ?? 0; w += g.adv; prev = c; }
  return w;
}

function textHandler(vm, sc, o, msg, a) {
  const m = vm.mem; if (!o) return 0;
  const rec = () => m.r32(o + 0x20);
  const setStr = src => { const d = rec(); if (!d || !src) return; const cap = m.r32(d + 4); m.wstr(m.r32(d + 8), m.cstr(m.r32(src + 8)).slice(0, cap), cap); };
  switch (msg) {
    case -1: m.w32(o + 0x20, m.r32(o + 0x20) + o); break;               // string record offset -> pointer
    case 0: for (let i = 0; i < 4; i++) m.w8(o + 0x18 + i, a[i]); break;
    case 1: for (let i = 0; i < 4; i++) m.w8(o + 0x1c + i, a[i]); break;
    case 2: for (let i = 0; i < 3; i++) m.w8(o + 0xc + i, Math.trunc(asF(a[i]))); break;
    case 3: case 4: setStr(a[0]); break;
    case 5: { const f = m.r16(o) & ~3; const v = s32(a[0]); if (v >= 0) m.w16(o, f | (v === 0 ? 1 : 2)); else m.w16(o, f); break; }
    case 6: m.w16(o + 6, Math.trunc(asF(a[0]))); m.w16(o + 8, Math.trunc(asF(a[1]))); m.w16(o + 0xa, 0); break;
    case 7: m.w8(o + 2, a[0] & 0xff); m.w8(o + 3, a[0] >>> 16); break;
    case 8: m.w8(o + 4, a[0] & 0xff); m.w8(o + 5, a[0] >>> 16); break;
    case 9: m.w8(o + 2, a[0] & 0xff); m.w8(o + 3, (a[0] >>> 16) & 0xff); break;
    case 10: m.w8(o + 0x18, a[0]); break;
    case 11: m.w8(o + 0x1c, a[0]); break;
    case 12: case 13: {                                                 // 0x141030: x / y of character a[0] in this text's string
      const str = m.cstr(m.r32(rec() + 8)), f = vm.assets?.font((m.r8(o + 3) << 24) >> 24, (m.r8(o + 2) << 24) >> 24);
      let idx = a[0] >>> 0; if (idx >= str.length && idx !== 0) idx = str.length - 1;
      const lines = []; let st = 0;                                      // line table (0x140750); explicit breaks only
      for (let i = 0; i <= str.length; i++) if (i === str.length || str[i] === "\n" || str[i] === "\r") { lines.push([st, i]); st = i + 1; }
      let li = lines.length - 1; while (li > 0 && lines[li][0] > idx) li--;
      if (msg === 13) return asU(f ? (li - m.r8(o + 0x10)) * f.lineHeight : 0);
      let x = 0; const [s0, e0] = lines[li];
      for (let i = s0; i < e0 && i < idx; i++) { const c = str.charCodeAt(i), g = f?.glyphs.get(c) ?? (c === 13 ? null : f?.glyphs.get(0xb5)); if (g) x += g.adv; }
      return asU(x);
    }
    case 14: return m.r8(o + 0xf);
    case 16: m.w8(o + 0x10, a[0]); break;
    case 17: return m.r8(o + 0x10);
    case 18: if (m.r16(o) & 0x100) m.w16(o + 0x14, a[0]); break;
    case 19: if (m.r16(o) & 0x200) m.w16(o + 0x16, a[0]); break;
    case 20: {                                                          // box width; unboxed text: widest line (relayout 0x1407A0)
      const flags = m.r16(o); if (flags & 0x100) return (m.r16(o + 0x14) << 16) >> 16;
      const f = vm.assets?.font((m.r8(o + 3) << 24) >> 24, (m.r8(o + 2) << 24) >> 24); if (!f) return 0;
      let w = 0; for (const line of m.cstr(m.r32(rec() + 8)).split("\n")) w = Math.max(w, measureLine(f, line, !(flags & 4)));
      m.w16(o + 0x14, w); return w;
    }
    case 21: return (m.r16(o + 0x16) << 16) >> 16;
    case 22: return (m.r8(o + 2) << 24 >> 24) & 0xffff | (m.r8(o + 3) << 24 >> 24) << 16;
    case 23: return asU((m.r16(o + 6) << 16) >> 16);
    case 24: return asU((m.r16(o + 8) << 16) >> 16);
  }
  return 0;
}

function strtableHandler(vm, sc, o, msg, a) {
  const m = vm.mem; if (!o) return 0;
  const groups = () => m.r32(o + 0x10), entries = () => m.r32(o + 0xc), strs = () => m.r32(o + 0x14);
  const copy = (dst, srcIdx) => { const s = m.r32(strs() + srcIdx * 4); if (dst && s) m.wstr(m.r32(dst + 8), m.cstr(m.r32(s + 8)), m.r32(dst + 4)); };
  switch (msg) {
    case -1: if (m.r8(o) === 0) { for (const k of [8, 0xc, 0x10, 0x14]) m.w32(o + k, m.r32(o + k) + o);
      for (let i = m.r8(o + 1); i > 0; i--) m.w32(strs() + (i - 1) * 4, m.r32(strs() + (i - 1) * 4) + o); m.w8(o, 1); m.w16(o + 6, 0); } break;
    case 0: return m.r16(groups() + a[0] * 4);
    case 1: return a[1] === 2 ? m.r8(entries() + a[0] * 4 + 2) : m.r8(entries() + a[0] * 4 + a[1]);
    case 2: if (a[0] < m.r8(o + 3) && a[1] < m.r16(groups() + a[0] * 4)) copy(a[2], m.r8(entries() + a[1] * 4 + 3)); break;
    case 3: if (a[0] < m.r8(o + 3)) { const n = m.r16(groups() + a[0] * 4), first = m.r16(groups() + a[0] * 4 + 2);
      for (let i = 0; i < n; i++) if (m.r8(entries() + (first + i) * 4) === a[1]) { copy(a[2], m.r8(entries() + (first + i) * 4 + 3)); break; } } break;
    case 4: if (a[0] < m.r16(o + 4)) m.w16(o + 6, a[0]); break;
  }
  return 0;
}
