// gamecode.mjs — runs the game's own native-handler code (x86, from default.exe) for UI game functions.
//
// The executable is mapped flat at its load address 0x10000 (file offset + 0x10000, .bss included since the
// converted image keeps it zero-filled) into the same Memory the UI VM uses, so pointers passed from scripts
// (string records, stack cells) are valid for the x86 code. A heap and an x86 stack are mapped beside it.
//
// The boundary to the rest of the machine is replaced by hooks:
//   C runtime   0x1803A8 ftol, 0x18035A cookie check, 0x180100 _chkstk, 0x170C90 sprintf
//   memory      0x110640 alloc, 0x110660 free
//   database    0x1471D0 query (status*, text, params...) -> nascar-db.mjs; 0x144B80 cursor close
//   others      anything listed in STUBS (models, textures, 3D preview, movies) returns 0
//   processes   the game-process manager (0x2F3990) is created at startup and ticked once per UI frame
// Calls outside the code that is understood are reported with their address so they can be hooked or ported.

import { dataBytes } from "./file-bytes.mjs";
import "../cpu/v8-tuning.mjs";        // same V8 flags for every entry point (V8 rejects a code cache made under other flags)
import { applyConfig, reapplyRoster, reapplyBrands, rosterPaints, rosterCarPaints, ROOKIE_STRIPE_BASE, PAINT_BASE, rosterBanners, BANNER_BASE, rosterCrews, CREW_BASE, rosterPitBoxes,
  sponsorStarts, sponsorOriginal, SPONSOR_START_BASE, SPONSOR_DEAL_BASE, SPONSOR_DEAL_SLOTS, SPONSOR_CREW_BASE } from "./nt04-config.mjs";
import { loadFonts, drawNumber, spotsFor } from "./number-paint.mjs";
import { decodeMMAP } from "./mmap-tex.mjs";
import { encodeCrew, madeCrew } from "./crew-tex.mjs";
import { encodePaint, encodePaintHD, paintSize } from "./paint-mmap.mjs";
import { decodePNG } from "./png-read.mjs";
import { installQualifying } from "./qualifying.mjs";
import { BRAND_STEP, brandSplg, brandEntry, decalBoxes, prepareLogo, makeDecal } from "./sponsor-decals.mjs";
import { installSillySeason, repairGenerated, resetCareerTables, CONTRACTS, SPONSOR_DEALS, applyPoolRemoved } from "./silly-season.mjs";
import { D3D } from "../xbox/d3d-hle.mjs";
import { WasmJit, WasmCache } from "../cpu/wasm-jit.mjs";
import { NullRenderer } from "../render/renderer.mjs";
import { DSound } from "../xbox/dsound-hle.mjs";
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, statSync, renameSync, rmSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { X86 } from "../cpu/x86emu.mjs";
import { Jit, JIT_ID } from "../cpu/x86-jit.mjs";
import { JitCache } from "../cpu/x86-jit-cache.mjs";
import { Pads } from "../xbox/xinput-hle.mjs";
import { createHash, createHmac } from "node:crypto";
import { parseQuery, parseDb, writeDb } from "./nascar-db.mjs";
import { parseTerf, isTerf } from "./terf.mjs";
import { XboxFs, dosError, setScratch } from "../xbox/xbox-fs.mjs";
import { Threads } from "../xbox/xbox-threads.mjs";

// bytes a callee pops on return (stdcall/thiscall "ret N"), for stubbed functions; generated from the code
const POPS = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../cpu/x86_callee_pops.json"), "utf8"));
export const UI_MGR = 0x7e000000, PROCESSES = 0x2f3990;
const terfCache = new Map(), fileCache = new Map();   // file path -> parsed TERF bundle (shared by all opens)
// all of the game's own memory sits below 0x10000000 (uis-vm.mjs Memory low window: flat, fast access)
export const IMAGE_BASE = 0x10000, HEAP_BASE = 0x01000000, HEAP_SIZE = 0x0e000000, STACK_TOP = 0x0f100000, SCRATCH = 0x0f100000, UI_STACK = 0x0f180000;

// Functions the frontend natives call for side effects outside the UI (sound, music, models, textures,
// controllers' rumble...). They return 0 unless noted.
// texture-group tables registered by the Loads of UI modules that are not loaded (moduleFilter)
const UI_TEX_TABLES = { UISCommon: [0x226a48], UISFrontEnd: [0x226af0] };
const STUBS = {
  0x6c590: "car model: release",
  0xef1f0: "preview viewport: set", 0xef200: "preview viewport: clear", 0xef050: "preview: attach model", 0xef030: "preview: set car",
  0x6dd60: "car paint texture: compose", 0xee580: "preview: init", 0xef130: "preview: attach car", 0xef660: "flag object: init", 0xee7d0: "preview: release",
  0x127cf0: "graphics: flush", 0x733b0: "movie: stop",
};

// Rows of the constants block's id-keyed tables (0x5E0E0): one per track (TRID), race (RAID) or home track (TPHD) of
// the shipped game. The game indexes them by id at fixed offsets; added tracks' ids are mapped to their base's
// (CNST_ID_MAP, set by gamecode from config.addedTracks).
export const CNST_ID_ROWS = { AICA: 65, ZBIA: 65, AIFW: 80, AITW: 80, AIWS: 80, PTRF: 80, PTSF: 48 };

export class GameCode {
  constructor(mem, { exePath, db, log = () => {}, state = {}, ui = null, dataDir = null, saveDir = null, config = null, flow = false, seed = null }) {
    // front-end car preview: the game flow only (it needs the car object module loaded with the interface's modules,
    // after Glib and Sort); NT04_PREVIEW=0 turns it off. The real car model loader comes with it (NT04_REAL_CAR_MODELS=0 / 1
    // overrides).
    this.preview = !!flow && process.env.NT04_PREVIEW !== "0";
    this.realCarModels = process.env.NT04_REAL_CAR_MODELS ? process.env.NT04_REAL_CAR_MODELS !== "0" : this.preview;
    this.mem = mem; this.db = db; this.config = config; this.log = log; this.state = state; this.ui = ui;
    mem.enableLow();
    this.dataDir = dataDir ?? join(dirname(exePath), "Data"); this.saveDir = saveDir ?? (process.env.NT04_SAVE || (process.env.NT04_USER ? join(process.env.NT04_USER, "save") : join(dirname(exePath), "save")));   // (NT04_USER: a launcher preset)
    const exe = readFileSync(exePath);
    const image = Buffer.alloc(0x30a000 - IMAGE_BASE); exe.copy(image, 0, 0, Math.min(exe.length, image.length));
    // The XBE header (certificate at [0x10118], title id, signature keys...) sits at the image base in the real
    // game; the converted .exe has its PE header there instead, so the XBE's header bytes are copied over it.
    const xbe = [join(dirname(this.dataDir), "default.xbe"), join(dirname(exePath), "default.xbe")].find(existsSync);
    if (xbe) { const x = readFileSync(xbe), hdr = x.readUInt32LE(0x108) || 0x1000; x.copy(image, 0, 0, Math.min(hdr, 0x1000, x.length)); }
    else log("default.xbe not found: XBE header (certificate) missing");
    mem.map(IMAGE_BASE, image);
    // one heap for everything the game allocates, placed where Xbox physical memory is (below 0x10000000: D3D keeps
    // physical addresses masked to 28 bits and reads them back at | 0x80000000, mirrored in d3d-hle.mjs); (the Xbox has 64 MB; the race loads whole archives' entries): a
    // 16-byte header before each block holds its size, freed blocks go to per-size free lists and are reused
    this.heap = mem.mapZero(HEAP_BASE, HEAP_SIZE); this.heapTop = HEAP_BASE + 0x10; this.freeLists = new Map(); this.heapLive = 0;
    mem.mapZero(STACK_TOP - 0x100000, 0x100000);
    mem.mapZero(SCRATCH, 0x10000);
    mem.mapZero(UI_STACK - 0x40000, 0x40000);                 // own stack for UI natives (isolated)
    mem.map(0x7f000000, Buffer.alloc(0x1000));               // fs: segment (SEH chain head)
    this.cursors = new Map(); this.parsed = new Map(); this.unknown = new Map();
    const hooks = new Map(); this.hooks = hooks;
    this.cpu = new X86(mem, { hooks, log });
    // block compiler (x86-jit.mjs): on unless NT04_NO_JIT; NT04_JIT_VERIFY=1 checks every block against the interpreter
    if (!process.env.NT04_NO_JIT) { this.cpu.jit = new Jit(this.cpu); this.cpu.jit.verify = !!process.env.NT04_JIT_VERIFY; }
    // WebAssembly blocks with their own dispatcher (wasm-jit.mjs): on by default (same results as the JavaScript
    // blocks, checked by the determinism test; ~20-25% less CPU per race frame), NT04_WASM=0 turns it off
    if (process.env.NT04_WASM !== "0" && this.cpu.jit && !this.cpu.jit.verify && mem.wasmMemory) this.cpu.wasm = new WasmJit(this.cpu, mem);
    // statically recompiled functions (recomp.mjs), when recomp.wasm is beside the executable; NT04_RECOMP=0: off
    if (this.cpu.wasm && process.env.NT04_RECOMP !== "0") this.cpu.wasm.loadRecomp(dirname(exePath), exe, log);
    // static mode: with recomp.wasm loaded, nothing is compiled at run time (no JavaScript or WebAssembly blocks, no
    // block caches on disk); the few instructions recomp.wasm does not cover run in the interpreter (well under 0.1%
    // in menus and races). NT04_STATIC=0 keeps the block compilers.
    this.staticMode = !!this.cpu.wasm?.recomp && process.env.NT04_STATIC !== "0";
    if (this.staticMode) { this.cpu.jit.off = true; this.cpu.wasm.noJit = true; log("static mode: recompiled code + interpreter, no block compilers"); }
    // compiled blocks are kept on disk (x86-jit-cache.mjs): <exe folder>/jit-cache, or NT04_JIT_CACHE=<dir>; =0 off
    if (this.cpu.jit && !this.cpu.jit.verify && process.env.NT04_JIT_CACHE !== "0" && !this.staticMode) {
      const dir = process.env.NT04_JIT_CACHE || join(dirname(exePath), "jit-cache"), jit = this.cpu.jit;
      // the key covers everything that changes the generated code: compiler source, game image, low window and the
      // write-inlining switch (NT04_JIT_NO_INLINE_W debugging runs once filled the shared cache with blocks whose
      // memory writes all went through method calls, which later runs then reused)
      jit.cache = new JitCache(dir, [JIT_ID(), image, `low:${!!mem.low}`, `inlineW:${!process.env.NT04_JIT_NO_INLINE_W}`], log, IMAGE_BASE, IMAGE_BASE + image.length);
      // translated WebAssembly modules too (wasm-jit.mjs WasmCache: folder w<key> beside the JavaScript cache's)
      if (this.cpu.wasm) this.cpu.wasm.cache = new WasmCache(dir, [image], log, IMAGE_BASE, IMAGE_BASE + image.length);
    }
    this.cpu.stepLimit = +(process.env.NT04_STEP_LIMIT || 20_000_000_000);   // loading a race runs long loops (track geometry set-up: hundreds of millions of instructions at a stock track, a few billion at a generated one; past the limit the module load is abandoned half done)
    this.cpu.fsBase = 0x7f000000;
    const cpu = this.cpu;
    // (recomp.mjs runs this one natively when it is this function: recompNative names it)
    hooks.set(0x1803a8, Object.assign(c => { const v = c.fpop(); if (!Number.isFinite(v) || Math.abs(v) >= 2 ** 63) { c.r[2] = 0x80000000; return 0; }
      const t = BigInt(Math.trunc(v)); c.r[2] = Number(BigInt.asUintN(32, t >> 32n)); return Number(BigInt.asUintN(32, t)); }, { recompNative: "ftol" }));
    hooks.set(0x18035a, () => undefined);
    hooks.set(0x180100, (c, ret) => { c.r[4] -= c.r[0]; c.hookReturn = ret; return undefined; });
    hooks.set(0x170c90, c => { const dst = c.arg(0), fmt = mem.cstr(c.arg(1)); const s = this.sprintf(fmt, c.r[4] + 8); mem.wstr(dst, s, s.length); return s.length; });
    // game clock 0x10ED50: a timer (0x22E320, created by the timer system 0x10F010 at system start-up, not run here)
    // read in 1/60 s; here it follows the UI clock
    hooks.set(0x10ed50, () => Math.floor((this.ms ?? 0) * 60 / 1000));
    hooks.set(0x185b67, () => 0); hooks.set(0x185ab5, () => 0);   // CRT _lock / _unlock (one thread; lock table never set up)
    hooks.set(0x110640, c => this.alloc(c.arg(0)));
    // the game's own heaps (0x10FF20 alloc(heap, size, tag), 0x110100 free(heap, p)) are never set up here
    hooks.set(0x10ff20, c => this.alloc(c.arg(1))); hooks.set(0x110100, c => { this.free(c.arg(1)); return 0; });
    // ... and their free-space query (0x10FEC0 heap) read 0: the particle emitters' start (0x16F0B0) checks it before taking
    // its particles from heap [0x282C1C], so no emitter ever started (no tire smoke, no burnout smoke)
    if (!process.env.NT04_STOCK_HEAPFREE) hooks.set(0x10fec0, () => 0x4000000);
    // XAPI process heap (never created here): RtlAllocateHeap 0x10CE9A(heap, flags, size), RtlFreeHeap 0x10D615,
    // RtlSizeHeap 0x10C4F8, RtlReAllocateHeap 0x10D809(heap, flags, p, size); memory comes from the bump heap
    const sizes = this.sizes = new Map(), pop = (c, n) => { c.r[4] += n; };
    hooks.set(0x10ce9a, c => { const n = c.arg(2), a = this.alloc(n); sizes.set(a, n); pop(c, 12); return a; });
    hooks.set(0x10d615, c => { sizes.delete(c.arg(2)); this.free(c.arg(2)); pop(c, 12); return 1; });
    hooks.set(0x10c4f8, c => { const v = sizes.get(c.arg(2)) ?? 0xffffffff; pop(c, 12); return v; });
    hooks.set(0x10d809, c => { const p = c.arg(2), n = c.arg(3), a = this.alloc(n), old = sizes.get(p) ?? 0;
      if (p && old) mem.writeBytes(a, mem.readBytes(p, Math.min(old, n))); sizes.delete(p); if (p) this.free(p); sizes.set(a, n); pop(c, 16); return a; });
    hooks.set(0x110660, c => { this.free(c.arg(0)); return 0; });
    hooks.set(0x1471d0, (c, ret) => { const r = this.query(c); if ((ret >>> 0) === 0x132b9) this.cnstRaceId(); return r; });
    this.cnstIdHooks(); this.wallIdHooks(); this.collisionSetupHooks(); this.curveNearestHook(); this.textureGuardHook();
    // Nearest palette colour 0x777A0(ecx = colour (4 bytes), palette*, count): the entry with the smallest sum of
    // squared byte differences (first one wins), remembered in [0x2B8558] (reused while [0x2B855C] is 0 and the colour
    // equals it); returns the index. Called per pixel by the quantiser 0x778A0 (Create-A-Car paint textures: the
    // career player car), it ran ~1e9 x86 steps inside one module load, hit the step limit and left the car / race
    // manager modules half loaded: Race from a career race weekend never started the race.
    hooks.set(0x777a0, c => {
      const col = c.r[1], pal = c.arg(0), n = c.arg(1) & 0xffff, cached = mem.r32(0x2b8558);
      if (!mem.r8(0x2b855c) && mem.r32(col) === mem.r32(cached)) return ((cached - pal) | 0) >> 2;
      mem.w8(0x2b855c, 0);
      const c0 = mem.r8(col), c1 = mem.r8(col + 1), c2 = mem.r8(col + 2), c3 = mem.r8(col + 3);
      let best = pal, bd = 1000000;
      for (let i = 0, p = pal; i < n; i++, p += 4) {
        const d0 = c0 - mem.r8(p), d1 = c1 - mem.r8(p + 1), d2 = c2 - mem.r8(p + 2), d3 = c3 - mem.r8(p + 3);
        const d = d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3; if (d < bd) { bd = d; best = p; }
      }
      mem.w32(0x2b8558, best); return ((best - pal) | 0) >> 2;
    });
    hooks.set(0x144b80, c => { this.cursors.delete(c.arg(0)); return 0; });
    // Structured fetch 0x1481C0(handle, mode, n, fields*) on a cursor from the query bridge: mode 0 = n rows on from the
    // current one, 1 = row n, 2 = n back from the last; fields = 16-byte entries (+0 value out, +4 table, +8 field, +0xC
    // field index out) up to field -1; the value goes in the entry itself (4 bytes; a float field as a float). Used by
    // the career Build Car parts lists (0x7F4B0: chassis / engine / body #, condition, grip, wear...): not bridged,
    // every handle was unknown (0x11) and the rows showed 0. 0x148170(handle) closes.
    hooks.set(0x1481c0, c => {
      const m = mem, tname = v => String.fromCharCode(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24);
      const h = this.cursorIds?.get(c.arg(0)); if (!h) return 0x11;
      const mode = c.arg(1), n = c.arg(2) | 0, len = h.cur.ctxs.length;
      const pos = mode === 1 ? n : mode === 2 ? len - 1 + n : h.pos + n;
      if (pos < 0 || pos >= len) return pos < 0 ? 0x14 : 0x15;
      h.pos = pos; const ctx = h.cur.ctxs[pos];
      for (let e = c.arg(3); e && m.r32(e + 8) !== 0xffffffff; e += 16) {
        const tn = m.r32(e + 4), fname = tname(m.r32(e + 8));
        const tab = tn && tn !== 0xffffffff ? tname(tn) : (ctx[h.cur.base] && fname in ctx[h.cur.base] ? h.cur.base : Object.keys(ctx).find(k => ctx[k] && fname in ctx[k]));
        const row = tab && ctx[tab], t = tab && this.db?.tables.get(tab), fi = t ? t.fields.findIndex(f => f.name === fname) : -1;
        if (!row || fi < 0) return 9;
        m.w8(e + 12, fi); const f = t.fields[fi], v = row[fname];
        if (f.type === 4) m.wf(e, v ?? 0);
        else if (f.type === 2 || f.type === 3) m.w32(e, (v ?? 0) >>> 0);
        else if (m.r32(e)) { const s = String(v ?? ""); m.wstr(m.r32(e), s, s.length); }
      }
      return 0;
    });
    hooks.set(0x148170, c => { this.cursorIds?.delete(c.arg(0)); return 0; });
    // NT04_UNSTUB=0xef030,0xef050,... leaves those stubs out (experiments: let the game's own code run)
    const unstub = new Set((process.env.NT04_UNSTUB ?? "").split(",").filter(Boolean).map(x => +x));
    if (this.preview) for (const a of [0xef1f0, 0xef200, 0xef050, 0xef030, 0x6dd60, 0xee580, 0xef130, 0xef660, 0xee7d0, 0x6c590]) unstub.add(a);
    for (const [a, what] of Object.entries(STUBS)) if (!unstub.has(+a)) this.stub(+a, what);
    // controllers: XInput on virtual pads (xinput-hle.mjs); NT04_PADS = number connected (ports 0..), default 1
    this.pads = new Pads(Math.max(0, Math.min(4, +(process.env.NT04_PADS ?? 1)))); this.pads.install(this);
    // Cars per race: 0x12AB1 takes the field size + 1 from the byte table 0x21DB28 indexed by the number of players
    // ([0x21DB2C] = 44 for one player -> 43 cars); the field-filling loop 0x139B0 stops there. Above 43 the race
    // code's per-car arrays overflow, so the configuration can only lower it.
    if (config?.fieldSize) {
      const n = config.fieldSize | 0;
      if (n >= 1 && n <= 43) mem.w8(0x21db2c, n + 1); else log(`config: fieldSize ${n} out of range (1..43)`);
    }
    // Direct3D: the game's D3D API re-implemented on a renderer of ours (d3d-hle.mjs; renderer.mjs NullRenderer
    // until a front end gives a real one)
    this.renderer = new NullRenderer(); this.d3d = new D3D(this, this.renderer);
    this.dsound = new DSound(this);                              // DirectSound on a silent backend (dsound-hle.mjs)
    // The Xbox runs its threads preemptively and raises a vertical-blank interrupt 60 times a second; game code that
    // waits in a loop for another thread (the loading screen's progress) or for a vblank needs both to happen while
    // it spins. Every 2M instructions the CPU gives the other threads a slice, and every ~12M (1/60 s of a 733 MHz
    // CPU) delivers a vertical blank.
    this.cpu.tickInterval = 2_000_000; this.cpu.nextTick = 2_000_000; this.lastVblankSteps = 0;
    // Live play (main.mjs, a page connected: liveClock): game time also runs during one long call (liveMark = 33 ms
    // into the frame), as it does on the Xbox while a race loads. The loading screen's background thread sleeps 16 ms
    // between steps of its bar; with game time standing still for the whole load the bar never moved, and was then
    // filled at once (0x72B70 below). Offline (tests, determinism) game time stays one frame per frame.
    // A stretch of the load spent outside game code (our own loaders, texture and model work in JavaScript) ran no
    // instructions, so no tick: game time then jumped by all of it at once. The game's sound thread refills EA's 50 ms
    // software-mix ring ahead of the play cursor; across a jump the mixer played that ring over and over (a buzzing
    // loop over the loading-screen music). Long jumps are now taken in 8 ms steps with the threads run after each, as
    // the sound thread would have run during that time on the Xbox.
    this.liveTime = () => { const now = performance.now(); if (now > this.liveMark) {
      const tick = this.mem.r32(0x1cc94c);
      if (now - this.liveMark > 12 && this.threads && !this.threads.current)
        for (let t = this.liveMark + 8; t < now; t += 8) { this.ms = (this.ms ?? 0) + 8; this.liveMark = t; this.mem.w32(tick, Math.floor(this.ms)); this.threads.runAll(100_000); }
      this.ms = (this.ms ?? 0) + (now - this.liveMark); this.liveMark = now; this.mem.w32(tick, Math.floor(this.ms));
      if (now - (this.liveTickAt ?? 0) >= 50) { this.liveTickAt = now; try { this.onLiveTick?.(); } catch (e) { this.log(`live tick: ${e.message}`); } } } };
    this.cpu.onTick = () => {
      if (this.liveClock) this.liveTime();
      if (this.threads && !this.threads.current) this.threads.runAll(400_000);
      // (counted from the last vertical blank of any kind: before, the count ran on through the game's own Swap /
      // BlockUntilVerticalBlank, so every ~4.7th race frame (2.6 M instructions each) got a second vblank and a frame
      // delta (0x20614C) of 2 / 60 s for a 1 / 60 s frame)
      if (this.cpu.steps - (this.lastVblankSteps ?? 0) >= 12_200_000) this.d3d.vblank();
    };
    // Music fade wait (race start): 0x73660 sets 0x2F3053 ("finish the fade fast") and spins on 0x72B70 until the
    // fade level [0x2B7878] reaches 0x20000. The level is advanced by 0x73580, which the background thread 0xEC800
    // calls every 16 ms; on the Xbox it preempts the spinning main thread and the fade ends in ~1/4 s. Here the spin
    // hit the step limit first (the thread's 16 ms sleep never ends while game time stands still), so the race-start
    // process tick was cut off. The predicate now runs the fade steps itself until the fade is done.
    // In live play the background thread finishes the bar in real time (about a quarter of a second, see liveClock);
    // the predicate only steps in if that has not happened within 3 s.
    this.hooks.set(0x72b70, () => {
      if (this.liveClock && (mem.r32(0x2b7878) | 0) < 0x20000) {
        const now = performance.now(); if (!(this.barWaitFrom > now - 10_000)) this.barWaitFrom = now;
        if (now - this.barWaitFrom < 3000) {             // (the spinning main thread gives the bar's thread its turns)
          Atomics.wait(this.spinCell ??= new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
          this.liveTime(); if (this.threads && !this.threads.current) this.threads.runAll(400_000);
          return 0;
        }
      }
      this.barWaitFrom = 0;
      for (let i = 0; i < 64 && (mem.r32(0x2b7878) | 0) < 0x20000; i++) { try { this.nested(0x73580, []); } catch (e) { this.log(`music fade step: ${e.message.slice(0, 160)}`); break; } }
      return (mem.r32(0x2b7878) | 0) >= 0x20000 ? 1 : 0;
    });
    // The second music wait of the same kind (during the race, under 0x9F360): 0x737E0 sets 0x2F3053 and spins on
    // 0x72B60 until the level [0x2B7904] reaches 0x26E8F0; 0x73780 (same background thread) adds the step to it.
    // Run the steps here; if a step stops making progress, finish the level directly so the caller can go on.
    this.hooks.set(0x72b60, () => {
      const done = () => (mem.r32(0x2b7904) | 0) >= 0x26e8f0;
      for (let i = 0; i < 4096 && !done(); i++) {
        const before = mem.r32(0x2b7904);
        try { this.nested(0x73780, []); } catch (e) { this.log(`music level step: ${e.message.slice(0, 160)}`); break; }
        if (mem.r32(0x2b7904) === before) break;
      }
      if (!done()) { mem.w32(0x2b7904, 0x26e8f0); mem.w8(0x2b783b, 0xff); }
      return 1;
    });
    // The loading bar: the loading screen's thread (0xEC800, every 16 ms) copies the bar image (unswizzled at
    // [0x2F34A8], pitch [0x2E073C] pixels) into the locked front buffer, up to the current right edge of the bar's
    // quad [0x2F34AC] (x0 +0, y0 +4, y1 +20, right edge +24, set by 0x73580). The front buffer's memory is shown by
    // nothing here: the renderer draws the same part of the image into the picture on screen instead.
    this.hooks.set(0xec6d0, c => {
      const r = this.renderer; if (!r.frontBlit) { c.passThrough = 0xec6d0; return this.nested(0xec6d0, []); }   // (offline: the copy as the game does it)
      const B = mem.r32(0x2f34ac), x = mem.r32(B) | 0, y = mem.r32(B + 4) | 0, w = (mem.r32(B + 24) | 0) - x, h = (mem.r32(B + 20) | 0) - y;
      const src = mem.r32(0x2f34a8), sw = mem.r32(0x2e073c) | 0;
      if (!B || !src || w <= 0 || h <= 0 || h > 256 || sw <= 0 || sw > 2048 || w > sw) return 0;
      r.frontBlit({ key: src, sw, sh: h, x, y, w, h, read: () => {
        const px = new Uint8Array(sw * h * 4);
        for (let i = 0; i < sw * h; i++) { const v = mem.r32(src + i * 4); px[i * 4] = (v >>> 16) & 255; px[i * 4 + 1] = (v >>> 8) & 255; px[i * 4 + 2] = v & 255; px[i * 4 + 3] = 255; }
        return px;
      } });
      return 0;
    });
    // MMAP/CMMP texture archive relocation 0x155910(block): turns the block's offsets into pointers once (flag bit 0 at
    // +6). Runs as is; blocks that are not in memory (the fake car model handles below) are skipped.
    this.hooks.set(0x155910, c => { const p = c.arg(0); if (p < HEAP_BASE || p >= this.heapTop) { if (process.env.NT04_TRACE_MMAP) this.log(`155910 skip ${p.toString(16)}`); return 0; } c.passThrough = 0x155910; return this.nested(0x155910, [p]); });
    // Starting a speech/sample stream (0x12D660(stream, a, b) -> voice) can fault in the sound layer's sample-memory
    // pool (0x15D620 gets a corrupt block table, see analysis notes). A fault there used to abort the whole Race
    // process tick before the frame was drawn; now that one sound is skipped (returns 0 = no voice) and the sound
    // lock 0x280606 taken inside is given back.
    this.hooks.set(0x12d660, c => {
      const args = [c.arg(0), c.arg(1), c.arg(2)], lock = this.mem.r8(0x280606);
      try { c.passThrough = 0x12d660; return this.nested(0x12d660, args); }
      catch (e) { c.passThrough = null; this.soundFaults = (this.soundFaults ?? 0) + 1;
        if (this.soundFaults === 1) this.log(`sound: stream start failed, skipped (${e.message.slice(0, 120)})`);
        for (let i = 0; i < 8 && this.mem.r8(0x280606) > lock; i++) try { this.nested(0x157ce0, []); } catch { break; }
        return 0; }
    });
    // more entrants than starters: a qualifying session in front of the field fill (qualifying.mjs)
    if (config?.qualifying) installQualifying(this, config.qualifying);
    // the career off-season (silly-season.mjs): the launcher's Career tab settings instead of the game's 0xB0260
    if (config?.sillySeason?.enabled) installSillySeason(this, config.sillySeason);
    this.unlockAllHook();
    this.settingsSaveHook();
    // Car model load 0x6C5D0(car, kind, done) [ebx = model class]: the real one refcounts the model, loads it through
    // the resource module and calls done(class name, car, handle, 0) when it is in. Could it run natively now that async
    // resource reads complete? Not yet: with it the season hub waits forever (driver select's "model ready"), so by
    // default a fake handle is handed out and reported loaded at once. NT04_REAL_CAR_MODELS=0: fake handles (the real loader is the default; the front-end car preview needs it).
    if (!this.realCarModels) this.hooks.set(0x6c5d0, c => {
      const car = c.arg(0), done = c.arg(2), handle = (0x7c000000 | (c.r[3] & 0xff) << 16 | car & 0xffff) >>> 0;
      if (done) try { this.nested(done, [0, car, handle, 0]); } catch (e) { this.log(`car model callback 0x${done.toString(16)}: ${e.message.slice(0, 200)}`); }
      return handle;
    });
    this.kernel();
    this.fileSystem();
    this.databaseEngine();
    // The memory-unit library (0x110000-0x114100): each operation sets its status byte 0x22E840 to -1 and either
    // finishes at once (status 1) or queues a job with 0x110DF0(proc, param) for its worker thread (event
    // 0x22EC60), whose proc sets status 1 when done; 0x114060 polls it. There is no worker thread here: the job
    // runs to completion when it is queued. Its file work goes through XAPI to the kernel file calls (save folder).
    hooks.set(0x110df0, c => { const proc = c.arg(0), param = c.arg(1);
      mem.w32(0x22ec68, proc); mem.w32(0x22ec6c, param); mem.w8(0x22e840, 0);
      if (!proc) return 0;                                    // proc 0 = stop the worker (0x1111E0, shutdown)
      try { this.nested(proc, [param]); } catch (e) { this.log(`memory unit job 0x${proc.toString(16)}: ${e.message}`); mem.w8(0x22e840, 1); }
      return 0; });
    // Full-screen movies (0x73840: ecx = file name, edx = mode): recorded, playback is not emulated
    // PlayMovie 0x73840 (ecx = bundle name, edx = entry, al = skippable) blocks until the clip ends. Here it queues the
    // request (this.movieQueue) and returns at once; the live server (main.mjs) holds the game while the page plays the
    // queued clips (decoded there by ea-mad.mjs) — the boot sequence's two calls, and the movie theatre's loop of 53
    // (0x73850 case 0x5A), which asks 0x103B90 how the last one ended: 2 = back out (the server then drops the rest).
    this.movieQueue = [];
    this.stub(0x73840, "movie: play", c => { const file = mem.cstr(c.r[1]); this.state.movies ??= []; this.state.movies.push(file);
      if (this.movieQueue.length < 64) this.movieQueue.push({ file, index: c.r[2] >>> 0, skippable: (c.r[0] & 0xff) !== 0 }); return 0; });
    this.hooks.set(0x103b90, () => this.movieResult ?? 0);
    // The game's random generator ([0x2F2D84], 0x14A10 = random below n: the boot movie's driver clip, ...) is seeded
    // once at boot by 0xA3B10 from rdtsc (0x120CB0 -> 0x149A0(eax = seed)). Here rdtsc counts emulated instructions,
    // so every boot drew the same numbers (the same intro clip every time). The live server passes a seed from the
    // clock; the tests pass none and keep the instruction-count seed (deterministic runs).
    // Loading a save (0xE5D70: the read of name + signature + DB image + signature into the buffer 0xE5C40 made):
    // the game sizes buffer and read from the image size of the tables as they are NOW (0x5E950 writes the save type's
    // tables to a counting sink), not from the file. With the roster or track packs the tables (CARS, DRVR, CRSK, TEAM
    // in a career / season save) are bigger or smaller than when the save was made, so fread came up short (job
    // status -100) or stopped early and every such save read "Unable to load Career from hard disk". Here the file is
    // read whole (up to 4 MB more than expected) into a new buffer and the image size taken from the file, checked
    // against its DB header, so the signature check (0xE63F0) and the load (0x147780) see the save as it was written.
    // NT04_STRICT_SAVE_SIZE=1 keeps the game's own read.
    if (!process.env.NT04_STRICT_SAVE_SIZE) this.hooks.set(0xe5d70, c => {
      const m = this.mem, file = c.arg(0), sig = m.r32(0x2de75c), want = (m.r32(0x2de754) + sig + m.r32(0x2de758)) >>> 0;
      const cap = want + 0x400000, nb = this.alloc(cap + sig + 16) >>> 0;
      const done = (status, result) => { m.w32(0x22e830, file); m.w32(0x22e834, 0x13); m.w32(0x22e844, file); m.w32(0x22e838, status >>> 0); m.w32(0x22e83c, result >>> 0); m.w8(0x22e840, 1); return 0; };
      const got = nb ? this.nested(0x18134b, [nb, 1, cap, file]) >>> 0 : 0, head = 0x21;
      const img = got - head - sig, okHead = got >= head + sig + 12 && m.r8(nb + head) === 0x44 && m.r8(nb + head + 1) === 0x42 && m.r32(nb + head + 8) === img;
      if (!okHead) { if (nb) this.free(nb); if (got !== want) this.log(`save read: ${got} bytes, expected ${want}, not a whole save image`); return done(got === want ? 0 : -100, got); }
      if (img !== m.r32(0x2de758)) this.log(`save read: image ${img} bytes (the tables now make ${m.r32(0x2de758)}): read as saved`);
      const old = m.r32(0x2de750); if (old) this.free(old);
      m.w32(0x2de750, nb); m.w32(0x2de758, img);
      return done(0, got);
    });
    // The save list's "damaged" check (0x105630, per listed save) also compares the save's size in 16 KB blocks with
    // ceil((0x105550 = the save type's tables as they are NOW, 0x5E950, + 0xC000) / 16 KB). With the roster (drivers,
    // paint schemes added or taken out, edited drivers) a career / season save made before a change is a block or more
    // off, so it listed as damaged and could not be loaded, though the load reads it as saved (0xE5D70 above) and checks
    // its signature (0xE63F0). 0x105550 is only called there: it answers the listed save's own size (entry ebp,
    // [ebp+0x14] +0x10), so the size test always passes and the name signature and the load's own checks (whole image
    // read, DB header, image signature) decide; a broken file then fails at "Load" instead of being listed damaged. NT04_STRICT_SAVE_SIZE=1 keeps the game's test.
    if (!process.env.NT04_STRICT_SAVE_SIZE) this.hooks.set(0x105550, c => {
      const m = this.mem, now = (this.nested(0x5e950, [], { esi: c.r[6] }) + 0xc000) >>> 0, ent = c.r[5] >>> 0;
      let have = 0; try { const info = m.r32(ent + 0x14); if (info) have = m.r32(info + 0x10) >>> 0; } catch {}
      const blocks = v => Math.ceil(v / 0x4000); if (process.env.NT04_DBG_SAVE) console.log("save size check", (ent>>>0).toString(16), have, now);
      if (!have || blocks(have) === blocks(now)) return now;
      if (process.env.NT04_DBG_SAVE) console.log("save list hook", have, now);
      if (process.env.NT04_TRACE_SAVESIZE) this.log(`save list: ${blocks(have)} blocks, the tables now make ${blocks(now)}: size accepted`);
      return have;
    });
    if (process.env.NT04_TRACE_SAVESIZE) this.hooks.set(0xe6500, c => { const m = this.mem, idx = (c.r[2] << 24) >> 24, ent = m.r32(0x2de6cc + idx * 4), arg3 = c.r[1], arg4 = m.r32(0x2de764);
      const r = this.nested(0x105630, [ent, 0x2de768, arg3, arg4]); (process.env.NT04_DBG_SAVE ? console.log : this.log)(`save check hdr ${Buffer.from(m.readBytes(0x2de768, 33)).toString("hex")} name@ent ${Buffer.from(m.readBytes(m.r32(ent + 0x14) + 0x20, 40)).toString("latin1").replace(/\0/g, ".")} idx ${idx} entry ${ent.toString(16)} arg3 ${arg3} arg4 ${arg4.toString(16)} -> damaged ${m.r8(ent + 1)}`); return r; });
    // Memory-card check at boot (screen 6/0, game code 0x104xxx): after the settings load it walks devices 0-8 (hard
    // disk, then controllers 1-4 slots A / B) looking for Create-A-Car and profile saves; 0x91090(ecx = step) moves to the
    // next device and starts its check (state 0x74). Each check reopens the "Please wait" box with its sound, and empty
    // slots answer at once, so the eight slot messages flicked past in half a second with the sounds piling up (user
    // report). Devices that are not present (mask 0x22E810, bit 0x111210(dev): only the hard disk here) are skipped.
    // NT04_MU_CHECK_ALL=1 keeps the game's walk over every slot.
    if (!process.env.NT04_MU_CHECK_ALL) this.hooks.set(0x91090, c => {
      const m = this.mem, step = c.r[1] | 0; let dev = m.r32(0x2f2d4c) | 0;
      if (step) {
        do dev += step; while (dev >= 1 && dev <= 8 && !(this.nested(0x111210, [dev]) & m.r32(0x22e810)));
        if (dev < 0 || dev > 8) return 0;
        m.w32(0x2f2d4c, dev);
      }
      this.nested(0x175030, [6, 0x74], { ecx: 0x2f3990 });
      return 1; });
    if (process.env.NT04_TRACE_DEV) this.hooks.set(0x104290, (c, ret) => { this.mem.w32(0x2f2d4c, c.r[0]); console.error(`set device ${c.r[0] | 0} from ${(ret >>> 0).toString(16)}`); return c.r[0]; });
    if (process.env.NT04_TRACE_SAVESIZE) this.hooks.set(0x114060, c => { const m = this.mem, st = (m.r8(0x22e840) << 24) >> 24;
      if (st === 1) { if (m.r32(0x22e838)) m.w32(0x22e83c, m.r32(0x22e838)); this.log(`save job done: status ${m.r32(0x22e838) | 0} result ${m.r32(0x22e83c) | 0}`); m.w32(0x22e834, -1); m.w32(0x22e838, 0xffffff9d); m.w8(0x22e840, 0xff); }
      m.w32(c.arg(0), m.r32(0x22e83c)); return st & 0xff; });
    if (process.env.NT04_TRACE_SAVESIZE) {
      this.hooks.set(0xe5d70, c => { const m = this.mem, buf = m.r32(0x2de750), n = (m.r32(0x2de754) + m.r32(0x2de75c) + m.r32(0x2de758)) >>> 0;
        const r = this.nested(0x1139e0, [c.arg(0), buf, n]); this.log(`save read 0x1139E0(${m.cstr(c.arg(0))}, ${buf.toString(16)}, ${n} = ${m.r32(0x2de754)}+${m.r32(0x2de75c)}+${m.r32(0x2de758)}) -> ${r}`); return r; });
      this.hooks.set(0xe5d10, c => { const r = this.nested(0x5ead0, [], { eax: 0x205fc8, ecx: 0x2de750 }); this.log(`save apply 0x5EAD0 -> ${r}`); return r ? 0 : 1; });
    }
    if (process.env.NT04_TRACE_SAVESIZE) this.hooks.set(0xe6590, c => { const a = [c.arg(0), c.arg(1), c.arg(2), c.arg(3), c.r[2], c.r[1], c.r[0]];
      const r = this.nested(0x105cb0, a); this.log(`save load 0x105CB0(${a.map(x => (x >>> 0).toString(16)).join(",")}) -> ${r}`); return r; });
    if (process.env.NT04_TRACE_SAVESIZE) this.hooks.set(0xe6570, c => { const r = this.nested(0x1139e0, [c.r[0], 0x2de768, 0x21]); this.log(`save load 0x1139E0(${c.r[0].toString(16)}) -> ${r}`); return r; });
    if (process.env.NT04_TRACE_SAVESIZE) this.hooks.set(0x105550, c => { const v = (this.nested(0x5e950) + 0xc000) >>> 0; this.log(`save size check: type size + 0xC000 = ${v}, save ${this.mem.r32(this.mem.r32(c.r[5] + 0x14) + 0x10)} name ${this.mem.cstr(this.mem.r32(c.r[5] + 0x14) + 0x20)}`); return v; });
    if (seed !== null) this.hooks.set(0x149a0, c => { const h = this.nested(0x120c20, [0, seed >>> 0]) >>> 0; this.mem.w32(0x2f2d84, h); this.note(0x149a0, `random seed ${seed >>> 0}`); return h; });
    // The UI system itself is the JavaScript VM: the game's UI context table (0x2B7C38, 32-byte entries, index in
    // 0x2B791C) points at a stand-in manager, and the manager API the game code calls is bridged to the VM.
    this.textureGroupHooks(); this.uiCacheHooks(); this.cautionFinishHook();
    if (process.env.NT04_PROBE) { this.probe = {}; for (const a of process.env.NT04_PROBE.split(",").map(x => parseInt(x, 16))) { const f = this.hooks.get(a), k = a.toString(16);
      this.hooks.set(a, f ? (c, r) => { this.probe[k] = (this.probe[k] ?? 0) + 1; return f(c, r); } : (c, ret) => { this.probe[k] = (this.probe[k] ?? 0) + 1; if (process.env.NT04_PROBE_ARG?.split(",").includes(k)) { const p = c.arg(0) >>> 0, b = []; if (process.env.NT04_PROBE_N === "v") b.push(p.toString(16), (c.arg(1) >>> 0).toString(16)); else for (let i = 0; i < +(process.env.NT04_PROBE_N ?? 12); i++) b.push(this.mem.r8(p + i)); const st = [ret.toString(16)]; for (let i = 0; i < 48 && st.length < (+process.env.NT04_PROBE_N ? 1 : 7); i++) { const v = this.mem.r32(c.r[4] + 4 * i) >>> 0; if (v >= 0x11000 && v < 0x18bd80) st.push(v.toString(16)); } const h = (this.probeArgs ??= {}); const key = b.join(".") + " " + st.join(">"); h[key] = (h[key] ?? 0) + 1; } c.push(ret); c.passThrough = a; c.hookReturn = a; return undefined; }); } }
    this.startup();
    // One stand-in manager per context (0 frontend, 6 memory unit/profile dialogs, ...): UI_MGR + ctx * 0x100.
    mem.map(UI_MGR, Buffer.alloc(0x1000)); for (let i = 0; i < 16; i++) mem.w32(0x2b7c38 + i * 32, UI_MGR + i * 0x100);
    // A manager the game made itself (the race weekend's, the race's: not a stand-in) gets a VM context of its own,
    // 16 and up. ((mgr - UI_MGR) >>> 8 & 15 gave them whatever their address bits said: the career race weekend's
    // manager came out as context 0, the front end's.)
    const foreign = this.uiForeignCtx = new Map();
    const ctxOf = mgr => { mgr >>>= 0; if (mgr >= UI_MGR && mgr < UI_MGR + 0x1000) return (mgr - UI_MGR) >>> 8;
      let k = foreign.get(mgr); if (k === undefined) foreign.set(mgr, k = 16 + foreign.size); return k; };
    // The race puts managers of its own in some entries of the context table (the HUD's in entry 2): the VM context of
    // a screen (ctxOf, from the manager pointer) is then not the entry's index. uiCtxIndex maps it back, for the
    // contexts the game draws only at times (uiContextDrawn).
    this.uiCtxIndex = new Map();
    // Pad -> UI target as 0x75F20 picks it: the input context [0x2B791C], its manager [0x2B7C38 + ctx * 32]; byte +0x1C
    // set = the message goes to every screen of that manager (0x13A890's last argument), else to its focus screen. Only
    // the race HUD context (entry 2) has it set: the pit-road options 10/1 and "Pit Under Caution?" 10/2 open beside
    // the HUD screen 10/0, which keeps the focus.
    this.uiInputTarget = () => { const k = mem.r32(0x2b791c); if (k >= 16) return null; const b = 0x2b7c38 + k * 32, mgr = mem.r32(b);
      return mgr ? { ctx: ctxOf(mgr), all: !!mem.r8(b + 0x1c) } : null; };
    const noteCtx = mgr => { const k = ctxOf(mgr); if (this.uiCtxIndex.has(k)) return; for (let i = 0; i < 16; i++) if (mem.r32(0x2b7c38 + i * 32) === mgr) { this.uiCtxIndex.set(k, i); break; } };
    const id = (g, sc) => ((g & 0xffff) | ((sc & 0xffff) << 16)) >>> 0;
    const ints = (n, p) => Array.from({ length: n }, (_, i) => mem.r32(p + i * 4));
    hooks.set(0x13c1c0, c => { noteCtx(c.arg(0)); this.ui?.notify(c.arg(1), ints(c.arg(2) & 0xff, c.arg(3)), ctxOf(c.arg(0))); return 0; });   // (mgr, event, argc, argv)
    hooks.set(0x13a790, c => { this.ui?.close(id(c.arg(1), c.arg(2))); return 0; });                              // (mgr, group, screen, wait)
    // UI context teardown (0x759A0 -> 0x13AEB0(mgr)): the game closes every screen in the manager's own list with
    // 0x13A790 and clears the manager. The VM keeps the screens, not that list, so nothing was closed: after the attract
    // demo the race's results 3/8 (opened by the demo screen 3/5 in the race's context) stayed open over the front end
    // and every later demo (user: "Unofficial Results" with empty rows and "Demo Mode" on screen after leaving the
    // game running). The screens of a race context close here; the front end's context 0 is left as it was.
    // (a race's context going away also puts alpha testing back off, through the game's own render state cache 0x131B60
    // (state 60 = D3DRS_ALPHATESTENABLE, NV2A 0x300): races turn it on (GREATER, ref 0) and never off, and nothing in
    // the front end sets it, so after the attract demo or a race the driver select's preview car (its vertex alpha comes
    // from c-86.w, 0 here) was discarded whole and the cars did not show)
    hooks.set(0x13aeb0, c => { const mgr = c.arg(0), k = ctxOf(mgr); if (k !== 0) { this.ui?.closeContext?.(k); try { this.nested(0x131b60, [60, 0]); } catch (e) { this.log(`alpha test reset: ${e.message}`); } }
      mem.w32(mgr, 0); mem.w32(mgr + 0xbc, 0); return 0; });
    hooks.set(0x13a7f0, c => { this.ui?.activate(id(c.arg(1), c.arg(2))); return 0; });                           // (mgr, group, screen)
    hooks.set(0x13b1b0, c => { noteCtx(c.arg(0)); this.ui?.open(id(c.arg(1), c.arg(2)), ints(c.arg(3) & 0xff, c.arg(4)), ctxOf(c.arg(0))); return 1; }); // (mgr, group, screen, argc, argv)
    hooks.set(0x13a840, c => { const f = this.ui?.focus() ?? 0xffffffff; if (c.arg(1)) mem.w16(c.arg(1), f & 0xffff); if (c.arg(2)) mem.w16(c.arg(2), f >>> 16); return 0; });
    hooks.set(0x1425a0, c => this.ui?.textWidth(mem.cstr(c.arg(3)), (c.arg(2) << 16) >> 16) ?? 0);               // (font cache, group, entry, text)
    this.hooks = hooks;
  }
  // UI texture groups: the UI modules register their tables of { id, ?, ?, name, ... } (0x1C bytes, id -1 ends) with
  // 0x76600 (eax 1 = texture cache; e.g. in-game 0x226E20) and drop them with 0x759B0 (edi = the texture table).
  // The live id -> bundle mapping goes to the renderer (uis-run: assets.groupOverride).
  textureGroupHooks() {
    const m = this.mem, live = this.texGroups = new Map(), kinds = this.texGroupKinds = new Map(), tables = new Map();
    // (+0x10: the group's kind, as the cache's post-load step 0x13E7E0 reads it: 4 texture (MMAP made into a texture
    // object), 8 font, 2 video, 1 raw data (uis_modl / uis_anma models, uis_text texture sets: the caller parses them)).
    // Only the low 4 bits: the game sets state bits above them in its tables (the in-game table 0x226E20 reads 0x24 /
    // 0x34 / 0x44 when it is registered again for a career's second race), and a uis_smnm kind of 0x24 left the race's
    // badge entries unrelocated and without texture objects: the ally / rival markers and the badges of the cars behind
    // drew as white boxes, and the player's Create-A-Car number (drawn into its slot through the block's own
    // pointers) was missing from the results.)
    const read = t => { const out = []; for (let i = 0; i < 64; i++) { const r = t + i * 0x1c, id = m.r32(r) | 0; if (id < 0) break;
      const name = m.cstr(m.r32(r + 12)).replace(/\.dat$/i, "").toLowerCase(); if (name) out.push([id, name, m.r32(r + 16) & 0x0f]); } return out; };
    const add = t => { const list = read(t); tables.set(t, list); for (const [id, n, k] of list) { live.set(id, n); kinds.set(id, k); } };
    const drop = t => { const list = tables.get(t); if (!list) return; tables.delete(t); for (const [id] of list) { live.delete(id); kinds.delete(id); }
      for (const l of tables.values()) for (const [id, n, k] of l) { live.set(id, n); kinds.set(id, k); } };
    // the UI modules the VM replaces (not loaded, see moduleFilter) register theirs in Load: UISCommon 0xA1260
    // (common 0x226A48), UISFrontEnd 0xA1570 (frontend 0x226AF0); moduleFilter adds / drops them in their place
    this.texTableAdd = add; this.texTableDrop = drop;
    this.hooks.set(0x76600, (c, ret) => { try { if ((c.r[0] | 0) === 1) add(c.arg(1) >>> 0); } catch {}
      c.push(ret); c.passThrough = 0x76600; c.hookReturn = 0x76600; return undefined; });   // (then the original runs, registers untouched)
    this.hooks.set(0x759b0, (c, ret) => { try { drop(c.r[7] >>> 0); } catch {}
      c.push(ret); c.passThrough = 0x759b0; c.hookReturn = 0x759b0; return undefined; });
  }
  // The UI resource caches. The UI system is the JavaScript VM, so the game's own UI resource caches (made by 0xA1260 at
  // interface init: 0x13E560 + 0x13E740 into the table 0x27D50C; 0x13E750(n) gets cache n, 1 = textures / models) are
  // never made. Game code outside the UI borrows from them: the race's car-number badges (0xED090: per car uis_smnm
  // entry = car number, backgrounds 125-127), the driver-list numbers (0xA0EA0), the EA Trax jukebox model (screen
  // 0/12, object type 4 ids 2..51: uis_modl model + uis_text texture set), the US map's waving flag (15/0, type 4 id
  // 1: uis_modl 1, uis_text 1, uis_anma 0, loaded once by UISFlagObj 0xEF660). Read through a null cache they got
  // nothing (the badges drew as white boxes, the 3D objects had no model).
  // Bridged here, as the real cache does it (records of 0x24 bytes per group at [cache+0xC], entries {u16 refs, ...}):
  //   fetch 0x13ECD0(cache, group, entry) loads the entry (the group's bundle from the live texture-group table) once,
  //     counts a reference and returns the loaded data; texture groups (kind 4) also get the texture object the
  //     cache's 0x142600 makes (below) — what get 0x13E660 (= 0x1426F0) returns.
  //   release 0x13EE30(cache, group, entry) drops a reference and frees the entry at 0, as 0x118E50 unloads it;
  //     entry -1 drops one reference from every entry of the group, -2 frees them all.
  //   loading? 0x13E920 -> 0 (loads complete at once); register 0x13EC50 / archive 0x13E5D0 / per-frame 0x13E8B0 /
  //     flush 0x13EFA0 / archive handle 0x13E700: nothing to do (they wrote through the null cache's record table).
  // Finish under caution at the short race lengths. When the pits close under a caution (Race stage 0x24, 0xACA16)
  // the game ends the race under yellow (stage 0x28 QC Finish) if laps run + the caution's laps left >= the race's
  // laps, but not at the 3 % / 5 % lengths (0x13760() == 3 / 5): stock RACE rows give those no caution laps, so the
  // field always restarted at once. With caution laps there (nt04-config: NCL3 1, NCL5 2) a late caution then
  // restarted on the last lap and the race ended at the green (user: caution on lap 11 of 13, restart at 13 / 13,
  // the line ended the race). The length is reported as 10 % to those two checks (return addresses 0xACA45 / 0xACA50)
  // while the race has caution laps ([0x2BA7C8], 0xAE310 at race start).
  cautionFinishHook() {
    const m = this.mem;
    this.hooks.set(0x13760, (c, ret) => {
      if ((ret === 0xaca45 || ret === 0xaca50) && !process.env.NT04_STOCK_CAUTION_FINISH) { let n = 0; try { n = m.r16(0x2ba7c8); } catch {} if (n > 0) return 10; }
      c.push(ret); c.passThrough = 0x13760; c.hookReturn = 0x13760; return undefined; });
  }

  uiCacheHooks() {
    // Entries are per cache (the cache's handle, arg 0): leaving a career race weekend for the hub, the race's cache
    // releases its uis_smnm entries one by one and another cache then frees all of its group 10 (-2); with one shared
    // table that freed every group 10 entry, among them the career number the game drew into its block (results
    // without the player's number) and what the next race's badges came from (white boxes for allies / rivals and
    // the cars behind).
    const m = this.mem, all = new Map(), caches = new Map(), latest = new Map();
    const key = (g, e) => ((g & 0xffff) << 16 | (e & 0xffff)) >>> 0;
    const of = c => { c >>>= 0; let t = all.get(c); if (!t) all.set(c, t = new Map()); return t; };
    this.hooks.set(0x13e750, c => { const n = c.arg(0) | 0; let p = caches.get(n); if (!p) { p = this.alloc(0x40); caches.set(n, p); } return p; });
    const load1 = (blocks, g, e) => {
      const k = key(g, e); let r = blocks.get(k);
      if (r) { r.refs++; return r.b; }
      let b = 0, fileData = null, tex = 0; const owned = [];
      try {
        const name = this.texGroups?.get(g); const path = name && this.findFile(`${name}.dat`);
        if (path) {
          let t = terfCache.get(path); if (!t) { t = parseTerf(dataBytes(path)); terfCache.set(path, t); }
          const extra = e >= t.count ? this.rosterUiEntry(name, t, e) : null;   // a roster driver's number picture
          if (e >= 0 && (e < t.count || extra)) { const data = extra ?? t.entry(e); fileData = data;
            if (data.length) { b = this.alloc(data.length + 32); owned.push(b); m.writeBytes(b, data);
              // texture groups: relocated and made into a texture object; raw groups go to their caller as loaded
              if ((this.texGroupKinds?.get(g) ?? 4) === 4 && data.toString("latin1", 0, 4) === "MMAP") { this.nested(0x155910, [b]); tex = fill(b, data, owned); } } }
        }
      } catch (err) { this.log(`UI resource ${g}/${e}: ${err.message}`); b = 0; }
      if (b) { r = { b, refs: 1, owned, data: fileData, tex }; blocks.set(k, r); latest.set(k, r); } return b;
    };
    const drop = (blocks, k, whole) => { const r = blocks.get(k); if (!r) return; r.refs = whole ? 0 : r.refs - 1; if (r.refs > 0) return; blocks.delete(k);
      if (latest.get(k) === r) { latest.delete(k); for (const t of all.values()) { const o = t.get(k); if (o) { latest.set(k, o); break; } } }
      for (const p of r.owned) this.free(p); };
    // what the cache's loader makes of an MMAP block: +0x14 -> its D3D texture header (at the MMAP's +0x14 offset:
    // common, data = the pixels, lock, format word, size 0 = swizzled), +0x1C -> its palette header (common, data).
    // Pixels and the description (u16 w, h, u32 D3D format, ..., +0xC pixel offset) are at 0x80 + offsets, the
    // description at the +0x18 offset, the palette's data offset at palette header +8 (as mmap-tex.mjs reads them).
    const fill = (b, d, owned) => {
      const desc = d.readUInt32LE(0x18), palOff = d.readUInt32LE(0x1c);
      const w = d.readUInt16LE(desc), h = d.readUInt16LE(desc + 2), fmt = d.readUInt32LE(desc + 4) & 0xff, pix = 0x80 + d.readUInt32LE(desc + 0xc);
      const lg = v => 31 - Math.clz32(Math.max(1, v));
      // (the material call 0x133620 takes these as handles: the texture is read through them, so +0x14 / +0x1C
      // point at a cell holding the header's address)
      const T = this.alloc(0x40), cells = this.alloc(8); owned.push(T, cells);
      m.w32(T, 0x00040001); m.w32(T + 4, b + pix); m.w32(T + 8, 0);
      m.w32(T + 12, (0x29 | (fmt << 8) | (1 << 16) | (lg(w) << 20) | (lg(h) << 24)) >>> 0); m.w32(T + 16, 0);
      // the texture object is a copy of the relocated header with those two fields as handles; the MMAP block keeps
      // its own pointers (the fetch 0x13ECD0 returns it, and 0x70030 draws a player's car number into it through them:
      // [+0x18] image description, [+0x1C] palette header; with the handles written over them the number's palette
      // went to a stray address and the slot stayed black)
      const X = this.alloc(0x40); owned.push(X); for (let i = 0; i < 0x40; i += 4) m.w32(X + i, m.r32(b + i));
      m.w32(cells, T); m.w32(X + 0x14, cells);
      if (palOff) { const P = this.alloc(0x10); owned.push(P); m.w32(P, 0x00030001); m.w32(P + 4, b + 0x80 + d.readUInt32LE(palOff + 8)); m.w32(P + 8, 0); m.w32(cells + 4, P); m.w32(X + 0x1c, cells + 4); }
      else { m.w32(cells + 4, 0); m.w32(X + 0x1c, 0); }
      return X;
    };
    const entries = g => { const name = this.texGroups?.get(g), path = name && this.findFile(`${name}.dat`); if (!path) return 0;
      let t = terfCache.get(path); if (!t) { t = parseTerf(dataBytes(path)); terfCache.set(path, t); } return t.count; };
    this.hooks.set(0x13ecd0, c => { const g = c.arg(1) << 16 >> 16, e = c.arg(2) << 16 >> 16;
      const blocks = of(c.arg(0));
      if (e !== -1) return load1(blocks, g, e); let last = 0; for (let i = 0, n = entries(g); i < n; i++) last = load1(blocks, g, i) || last; return last; });
    this.hooks.set(0x13e660, c => { const r = of(c.arg(0)).get(key(c.arg(1), c.arg(2))); return r ? (r.tex || r.b) : 0; });
    // the loaded block of a cache entry (address in game memory, the file's entry bytes) for the UI renderer: entries
    // the game draws into after loading (uis_smnm 89-93, the players' own car numbers) are read from here
    this.uiCacheBlock = (g, e) => { const r = latest.get(key(g, e)); return r ? { b: r.b, data: r.data } : null; };
    this.hooks.set(0x13ee30, c => { const g = c.arg(1) << 16 >> 16, e = c.arg(2) | 0;
      const blocks = of(c.arg(0));
      if (e >= 0) drop(blocks, key(g, e), false); else for (const k of [...blocks.keys()]) if ((k >>> 16) === (g & 0xffff)) drop(blocks, k, e === -2);
      return 0; });
    this.hooks.set(0x13e920, () => 0);
    for (const a of [0x13ec50, 0x13e5d0, 0x13e8b0, 0x13efa0, 0x13e700]) this.hooks.set(a, () => 0);
  }
  // Whether the game draws a UI context this frame. The race frame (0xEBC8C..) draws contexts 5, 1, 6, 8, 3 and 4 every
  // frame; the HUD's context 2 is updated and drawn by 0x708A0 only while [0x2F304A] is set (from the start of the
  // race proper: not under the pre-race presentation 3/18, where the HUD 10/0 is already open).
  uiContextDrawn(vmCtx) {
    // the front end's manager (context 0) is drawn by the Frontend state's render only: from the race load on
    // (Interface 7 loading in-game, 9 race weekend, 10 in-game, 11 paused) the screens are the race managers'. The
    // career's garage background 0/1 stays open into the race (no career screen closes it, unlike Race Now 0/6 and
    // Season 4/9) and was drawn over the race, and over the loading screen (Grudges & Alliances tips, then Press START).
    if (vmCtx === 0) { const st = this.processState(1); if (st === 7 || st === 9 || st === 10 || st === 11) return false; }
    const i = this.uiCtxIndex?.get(vmCtx) ?? vmCtx;
    if (i === 2 && this.mem.r32(0x2b7c38 + 2 * 32) !== UI_MGR + 0x200) return !!this.mem.r8(0x2f304a);
    return true;
  }
  // Resource module (0x118000-0x11C000: TERF bundles opened by name, entries loaded on demand, pooled memory and
  // async reads; set up by 0x1189B0) on terf.mjs. A handle is a block the game reads directly: +0x14 u16 entry
  // count, +0x74 entry-buffer pointers, +0x78 per-entry flags (bit 1 loaded). API: open 0x118A70(name, flags),
  // entry size 0x119000(h, i), load entry 0x11A390(h, i, flag) -> buffer, loaded? 0x119140(h, i), unload entry
  // 0x118E50(h, i), unload all 0x118F30(h), close 0x11A020(h). Other entry points are reported when reached.
  // Custom paints of roster drivers (nt04-config.mjs applyRoster / rosterPaints): CARDATA.DAT and CARRESFE.DAT get entries
  // PAINT_BASE + slot, made from roster/paint/<car id>.png in the template car's paint format (paint-mmap.mjs).
  // The cars' CRSK rows point there (CTID). Entries between the archive's own and PAINT_BASE are never asked for.
  // UI pictures past a bundle's end that the game's own code loads through the UI cache (the race's number badges:
  // uis_smnm entry = CRSK CNID): roster/textures/<bundle>/<entry>.png in the format of the bundle's first paletted
  // entry. The UI screens themselves read these PNGs through uis-render's overrides.
  rosterUiEntry(bundle, t, e) {
    const dir = this.config?.rosterDir; if (!dir || !bundle) return null;
    this.rosterUi ??= new Map(); const k = `${bundle}/${e}`; if (this.rosterUi.has(k)) return this.rosterUi.get(k);
    let out = null; const path = join(dir, "textures", bundle.toLowerCase(), `${e}.png`);
    if (existsSync(path)) try {
      let tpl = null; for (let i = 0; i < t.count && !tpl; i++) { const b = t.entry(i); if (b.toString("latin1", 0, 4) === "MMAP" && b.readUInt32LE(0x2c) === 0x0b) tpl = b; }
      if (tpl) { const png = decodePNG(readFileSync(path)); out = encodePaint(tpl, png.rgba, png.width, png.height); }
    } catch (err) { this.log(`roster picture ${k}: ${err.message}`); }
    this.rosterUi.set(k, out); return out;
  }
  // Replacement / added archive entries (track packs, tests): config.entryOverrides { "tk_rend.dat": { "0": file } }
  // and NT04_ENTRY_OVERRIDE="tk_rend.dat:0=C:/x/atl.tmdl;tk_phys.dat:65=..." (an index past the end adds entries; the
  // gap, if any, repeats entry 0; "@N" instead of a file copies the archive's own entry N). Files are read when the
  // entry is first loaded.
  // Fade distances of the track models (TK_REND.DAT TMdl, chunk "Fade": one u32 per instance, two u16 distances in feet,
  // where the instance starts to fade and where it is gone; 0 = always drawn). The catch fence is drawn this way
  // (Talladega: 51 instances fading 900 -> 1400 ft), so it popped in ahead of the car. NT04_FADE_SCALE (or the
  // configuration's "fadeScale", 1 = the game's) multiplies both distances (at most 65535 ft).
  withFadeScale(t) {
    const k = +(process.env.NT04_FADE_SCALE ?? this.config?.fadeScale ?? 1);
    if (!(k > 0) || k === 1) return t;
    const cache = new Map();
    const scaled = i => {
      if (cache.has(i)) return cache.get(i);
      let b = t.entry(i);
      try {
        if (b && b.toString("latin1", 0, 4) === "TMdl") {
          for (let c = 0; c < 32; c++) { const o = 0x10 + c * 16, tag = b.toString("latin1", o, o + 4); if (!/^[A-Za-z]{4}$/.test(tag)) break;
            if (tag !== "Fade") continue;
            const off = b.readUInt32LE(o + 4), size = b.readUInt32LE(o + 8); b = Buffer.from(b); let n = 0;
            for (let q = off; q + 4 <= off + size && q + 4 <= b.length; q += 4) { const lo = b.readUInt16LE(q), hi = b.readUInt16LE(q + 2); if (!lo && !hi) continue;
              b.writeUInt16LE(Math.min(65535, Math.round(lo * k)), q); b.writeUInt16LE(Math.min(65535, Math.round(hi * k)), q + 2); n++; }
            if (n && !this._fadeLogged?.has(i)) { (this._fadeLogged ??= new Set()).add(i); this.log(`track model ${i}: ${n} fade distances x${k}`); }
          }
        }
      } catch (e) { this.log(`fade scale, track model ${i}: ${e.message}`); b = t.entry(i); }
      cache.set(i, b); return b;
    };
    return { ...t, entry: scaled };
  }
  withEntryOverrides(name, t) {
    const map = new Map();
    for (const [arc, entries] of Object.entries(this.config?.entryOverrides ?? {})) if (arc.toLowerCase() === name.toLowerCase()) for (const [i, f] of Object.entries(entries)) map.set(+i, f);
    for (const part of (process.env.NT04_ENTRY_OVERRIDE ?? "").split(";")) { const m = /^([^:]+):(\d+)=(.+)$/.exec(part.trim()); if (m && m[1].toLowerCase() === name.toLowerCase()) map.set(+m[2], m[3]); }
    if (!map.size) return t;
    const cache = new Map(), n = Math.max(t.count, ...[...map.keys()].map(i => i + 1));
    const data = i => { if (!map.has(i)) return i < t.count ? t.entry(i) : t.entry(0); const f = String(map.get(i)), src = /^@(\d+)$/.exec(f);
      if (src) return t.entry(Math.min(+src[1], t.count - 1));     // "@N": a copy of the archive's own entry N
      if (!cache.has(i)) { cache.set(i, readFileSync(f)); this.log(`${name} entry ${i}: ${f}`); } return cache.get(i); };
    const entries = []; for (let i = 0; i < n; i++) entries.push(map.has(i) || i >= t.count ? { get size() { return data(i).length; } } : t.entries[i]);
    return { ...t, count: n, entries, entry: data };
  }
  // Sponsor paint schemes (nt04-config withSponsors; the Sponsors tab): entries SPONSOR_START_BASE + i for the cars the
  // schemes start on, SPONSOR_DEAL_BASE + slot for career deals (silly-season.mjs table SSSP: SLOT, SCHM, CRID, OCTI):
  // the scheme's paint for the car's make with the car's own number drawn on (number-paint.mjs, the game's
  // Create-A-Car number fonts from CARPARTS.DAT), in the format of a stock paint of that make. Made when first loaded,
  // again when the car's number or make is another; a missing scheme / paint gives the car's own paint back.
  numberFonts() { if (!this.fonts) { const f = this.findFile("CARPARTS.DAT"); this.fonts = f ? loadFonts(parseTerf(readFileSync(f)), decodeMMAP) : []; } return this.fonts; }
  sponsorPaint(t, i, made, fe = false) {
    const sp = this.config?.sponsors ?? [], n = t.count, T = name => this.db?.tables.get(name)?.rows ?? [];
    let r = null;
    if (i < SPONSOR_DEAL_BASE) { const s = sponsorStarts(sp)[i - SPONSOR_START_BASE]; if (s) r = { scheme: s.scheme, crid: s.crid, orig: sponsorOriginal.get(s.crid) }; }
    else { const d = T(SPONSOR_DEALS).find(x => x.SLOT === i - SPONSOR_DEAL_BASE); if (d) r = { scheme: d.SCHM, crid: d.CRID, orig: d.OCTI }; }
    const car = r && T("CARS").find(c => c.CRID === r.crid), x = r && sp.find(s => s.id === r.scheme), num = car ? String(car.CNMD ?? car.CNUM).trim() : "";
    const key = `s${i}:${r?.scheme}:${r?.crid}:${num}:${car?.CMDL}`; if (made.has(key)) return made.get(key);
    const stock = make => { const crsk = T("CRSK"), c = T("CARS").find(q => q.CMDL === make && q.CRID < 250 && crsk.some(k => k.CRID === q.CRID && k.CTID < n)); return (crsk.find(k => k.CRID === c?.CRID && k.CTXN === c?.CSTN) ?? crsk.find(k => k.CRID === c?.CRID && k.CTID < n))?.CTID ?? 0; };
    let data;
    try {
      if (!x || !car) throw new Error("no scheme or car for it");
      if (!x.paints.includes(car.CMDL)) throw new Error(`${x.name} has no paint for this car's make`);
      const png = decodePNG(readFileSync(join(this.config.sponsorDir, String(x.id), `paint_${car.CMDL}.png`))), rgba = Uint8Array.from(png.rgba);
      drawNumber(rgba, png.width, png.height, num, spotsFor(x, car.CMDL), x.style, this.numberFonts());
      const tpl = t.entry(stock(car.CMDL)), size = Math.min(paintSize(png.width, png.height), this.paintCap(fe));
      data = size > 512 ? encodePaintHD(tpl, rgba, png.width, png.height, size) : encodePaint(tpl, rgba, png.width, png.height);
    } catch (e) { if (r) this.log(`sponsor paint ${i}: ${e.message}`); data = t.entry(r?.orig !== undefined && r.orig >= 0 && r.orig < n ? r.orig : stock(car?.CMDL ?? 0)); }
    made.set(key, data); return data;
  }
  // Sponsors added to the game's own list (nt04-config applyBrands, sponsor-decals.mjs): CARPARTS entries base + SPLG
  // for the decal kinds, SPLG = BRAND_SPLG(id): made from the brand's logo (or its own decal picture) in the stock
  // decal of that kind, the logo where the stock ones sit; a broken picture gives an empty decal.
  withBrandDecals(t) {
    const brands = this.config?.brands ?? []; if (!brands.length || t.count < 600) return t;
    const top = Math.max(...brands.map(b => brandSplg(b.id))) + BRAND_STEP, made = new Map(), n = t.count;
    let boxes = null, logos = new Map();
    const make = e => {
      if (made.has(e)) return made.get(e);
      const r = brandEntry(e), b = r && brands.find(x => x.id === r.id); let data;
      try {
        if (!b) throw new Error("no such sponsor");
        boxes ??= decalBoxes(t);
        if (!logos.has(b.id)) logos.set(b.id, prepareLogo(decodePNG(readFileSync(b.decal ?? b.logo))));
        data = makeDecal(t.entry(r.set.base), logos.get(b.id), r.set, boxes.get(r.set.base));
      } catch (err) { this.log(`sponsor decal ${e}: ${err.message}`); data = Buffer.from(t.entry(r?.set.base ?? 226)); const o = 0x80 + data.readUInt32LE(0x34); data.fill(0, o); }
      made.set(e, data); return data;
    };
    const entries = new Array(top); for (let i = 0; i < top; i++) entries[i] = i < n ? t.entries[i] : brandEntry(i) ? { get size() { return make(i).length; } } : { size: 0 };
    return { ...t, count: top, entries, entry: i => i < n ? t.entry(i) : brandEntry(i) ? make(i) : t.entry(0) };
  }
  // (the front end's copies, CARRESFE, stay 512 paletted like the game's: the car select preview keeps them in a
  // small fixed memory pool, and 1024 / 2048 DXT5 sheets (1.4 / 5.5 MB) there stopped the preview from changing
  // after a few schemes; the race's CARDATA gets the high-resolution ones)
  paintCap(fe) { return fe ? 512 : +(process.env.NT04_PAINT_MAX ?? 2048); }
  // A roster paint made into the game's format, kept: in memory for the run, and on disk beside the picture
  // (roster/paint/.cache/<picture>.<key>.<fe|race>.bin, the key from the picture's path, time and size, the cap and the
  // template's bytes). Making one is ~0.25 s for the front end's 512 copy and ~0.8 s for a 2048 race sheet, and the
  // front end's archive is opened again for each screen, so a scheme of one's own paused the car select each time it
  // came up. An older copy of the same picture and kind is removed when a new one is written.
  paintFromFile(tpl, file, fe) {
    const st = statSync(file), kind = fe ? "fe" : "race", cap = this.paintCap(fe);
    const key = createHash("sha1").update(`${file}|${st.mtimeMs}|${st.size}|${cap}|`).update(tpl).digest("hex").slice(0, 20);
    const mem = GameCode.paintMem ??= new Map(); let b = mem.get(key); if (b) { mem.delete(key); mem.set(key, b); return b; }   // (most recent last)
    const dir = join(dirname(file), ".cache"), name = `${basename(file)}.${key}.${kind}.bin`, path = join(dir, name);
    try { if (existsSync(path)) b = readFileSync(path); } catch {}
    if (!b) {
      const png = decodePNG(readFileSync(file)), size = Math.min(paintSize(png.width, png.height), cap);
      b = size > 512 ? encodePaintHD(tpl, png.rgba, png.width, png.height, size) : encodePaint(tpl, png.rgba, png.width, png.height);
      try { mkdirSync(dir, { recursive: true });
        for (const f of readdirSync(dir)) if (f.startsWith(`${basename(file)}.`) && f.endsWith(`.${kind}.bin`) && f !== name) try { rmSync(join(dir, f)); } catch {}
        writeFileSync(path + ".tmp", b); renameSync(path + ".tmp", path); } catch {}
    }
    mem.set(key, b); let total = 0; for (const v of mem.values()) total += v.length;
    for (const [k, v] of mem) { if (total <= 256e6) break; total -= v.length; mem.delete(k); }
    return b;
  }
  withRosterPaints(t, fe = false) {
    const paints = rosterPaints(this.config?.roster), dir = this.config?.rosterDir, sponsors = !!this.config?.sponsors?.length;
    const stock = dir ? rosterCarPaints(this.config?.roster) : [];
    if ((!paints.length || !dir) && !sponsors && !stock.length) return t;
    if (!paints.length && !sponsors) return this.withCarPaints(t, stock, dir, fe);
    const made = new Map(), n = t.count, mine = dir ? paints.length : 0, count = Math.max(PAINT_BASE + mine, sponsors ? SPONSOR_DEAL_BASE + SPONSOR_DEAL_SLOTS : 0);
    const sp = i => sponsors && i >= SPONSOR_START_BASE;
    const make = p => {
      if (made.has(p.slot)) return made.get(p.slot);
      let data = null;
      try {
        // the template: a stock paint of the car's make (the start car's when it is that make: a paint fits only its body)
        const crsk = this.db?.tables.get("CRSK")?.rows ?? [], cars = this.db?.tables.get("CARS")?.rows ?? [];
        const car = cars.find(r => r.CRID === p.template && (p.make === undefined || r.CMDL === p.make)) ?? cars.find(r => r.CMDL === p.make && r.CRID < 250 && crsk.some(k => k.CRID === r.CRID && k.CTID < n)) ?? cars.find(r => r.CRID === p.template);
        const tid = (crsk.find(r => r.CRID === car?.CRID && r.CTXN === car?.CSTN && r.CTID < n) ?? crsk.find(r => r.CRID === car?.CRID && r.CTID < n))?.CTID;   // (a game car's raced row may be one of the added schemes)
        // (a picture over 724 px: 1024 or 2048 square in DXT5, full colour: paint-mmap.mjs encodePaintHD; NT04_PAINT_MAX caps it)
        data = this.paintFromFile(t.entry(tid !== undefined && tid < n ? tid : 0), join(dir, "paint", p.file ?? `${p.crid}.png`), fe);
      } catch (e) { this.log(`roster paint for car ${p.crid}: ${e.message}`); data = t.entry(0); }
      made.set(p.slot, data); return data;
    };
    const self = this, entries = new Array(count), mineAt = i => i >= PAINT_BASE && i < PAINT_BASE + mine;
    for (let i = 0; i < count; i++) entries[i] = i < n ? t.entries[i] : sp(i) ? { get size() { return self.sponsorPaint(t, i, made, fe).length; } } : mineAt(i) ? { get size() { return make(paints[i - PAINT_BASE]).length; } } : { size: 0 };
    return this.withCarPaints({ ...t, count, entries, entry: i => i < n ? t.entry(i) : sp(i) ? this.sponsorPaint(t, i, made, fe) : mineAt(i) ? make(paints[i - PAINT_BASE]) : t.entry(0) }, stock, dir, fe);
  }
  // The game's own paints replaced (nt04-config rosterCarPaints): entry CTID made from roster/paint/stock_<CTID>.png in
  // that entry's own format (its own size, or the high-resolution DXT5 one for a picture over 724 px), and the
  // scheme's rookie-stripe copy (CARDATA 0x192 + RTOF of the game's CRSK row with that CTID) the same.
  withCarPaints(t, stock, dir, fe = false) {
    if (!stock.length || !dir) return t;
    const n = t.count, byCtid = new Map(stock.map(p => [p.ctid, p])), made = new Map(); let rookie = null;
    const rookieOf = () => {                     // stripe entry -> the scheme's picture (from the game's own rows: a save's may be dressed by a sponsor)
      if (rookie) return rookie; const rows = this.db?.tables.get("CRSK")?.rows; if (!rows?.length) return null;
      rookie = new Map(); for (const r of rows) if (r.RTOF >= 0 && byCtid.has(r.CTID) && r.CRID < 250) rookie.set(ROOKIE_STRIPE_BASE + r.RTOF, byCtid.get(r.CTID));
      return rookie;
    };
    const pick = i => i < n ? byCtid.get(i) ?? (i >= ROOKIE_STRIPE_BASE ? rookieOf()?.get(i) : undefined) : undefined;
    const make = (p, i) => {
      if (made.has(i)) return made.get(i);
      let data;
      try {
        data = this.paintFromFile(t.entry(i), join(dir, "paint", p.file), fe);
      } catch (e) { this.log(`paint for scheme ${p.ctid} (car ${p.crid}): ${e.message}`); data = t.entry(i); }
      made.set(i, data); return data;
    };
    const entries = t.entries.map((e, i) => i >= n ? e : Object.create(e, { size: { get: () => { const p = pick(i); return p ? make(p, i).length : e.size; }, enumerable: true } }));
    return { ...t, entries, entry: i => { const p = pick(i); return p ? make(p, i) : t.entry(i); } };
  }
  // Pit signs of added drivers: TK_PBNR entries BANNER_BASE + slot, made from roster/textures/pitsign/<crid>.png in the
  // format of the start car's sign (128 x 32 paletted MMAP; entry = its CRSK PBNR + 3; paint-mmap.mjs encodePaint).
  withRosterBanners(t) {
    const list = rosterBanners(this.config?.roster), dir = this.config?.rosterDir;
    if (!list.length || !dir) return t;
    const made = new Map(), n = t.count, count = BANNER_BASE + list.length;
    const make = b => {
      if (made.has(b.slot)) return made.get(b.slot);
      let data = null;
      try {
        const crsk = this.db?.tables.get("CRSK")?.rows ?? [], car = this.db?.tables.get("CARS")?.rows.find(r => r.CRID === b.template);
        const pb = (crsk.find(r => r.CRID === b.template && r.CTXN === car?.CSTN) ?? crsk.find(r => r.CRID === b.template))?.PBNR, e = pb !== undefined && pb + 3 >= 2 && pb + 3 < n ? pb + 3 : 2;
        const png = decodePNG(readFileSync(join(dir, "textures", "pitsign", `${b.crid}.png`)));
        data = encodePaint(t.entry(e), png.rgba, png.width, png.height);
      } catch (err) { this.log(`roster pit sign for car ${b.crid}: ${err.message}`); data = t.entry(2); }
      made.set(b.slot, data); return data;
    };
    const entries = new Array(count);
    for (let i = 0; i < count; i++) entries[i] = i < n ? t.entries[i] : i >= BANNER_BASE ? { get size() { return make(list[i - BANNER_BASE]).length; } } : { size: 0 };
    return { ...t, count, entries, entry: i => i < n ? t.entry(i) : i >= BANNER_BASE ? make(list[i - BANNER_BASE]) : t.entry(2) };
  }
  // The pit box sheet (TK_PBNR entry 0 "PITBOX": the crews standing at every stall and the tool cart, one 256 x 128 P8
  // image with 43 palettes the race fills with each car's colours, palette k for the car in 0x2DD200 entry k). Where
  // its image and palettes sit inside the entry, so the renderer can tell it in memory (gl-remote pitBoxTexture).
  notePitBox(t) {
    try { const b = t.entry(0); if (b.toString("latin1", 0, 4) !== "MMAP") return; const ph = b.readUInt32LE(0x1c);
      this.pitBox = { w: b.readUInt16LE(0x28), h: b.readUInt16LE(0x2a), fmt: b.readUInt32LE(0x2c), img: 0x80 + b.readUInt32LE(0x34), pal0: 0x80 + b.readUInt32LE(ph + 8),
        palStep: b.readUInt32LE(0x10) > 1 ? b.readUInt32LE(ph + 20) - b.readUInt32LE(ph + 8) : 0, palCount: b.readUInt32LE(0x10), sig: Buffer.from(b.subarray(0x80 + b.readUInt32LE(0x34), 0x80 + b.readUInt32LE(0x34) + 64)) };
    } catch (err) { this.log(`pit box sheet: ${err.message}`); }
  }
  // an added driver's own pit crew / cart picture (roster/textures/pitbox/<crid>.png), decoded once; null for the rest
  pitBoxSheet(crid) {
    const dir = this.config?.rosterDir; if (!dir) return null;
    if (!this.pitBoxSheets) this.pitBoxSheets = new Map(rosterPitBoxes(this.config?.roster).map(x => [x.crid, undefined]));
    if (!this.pitBoxSheets.has(crid)) return null;
    let s = this.pitBoxSheets.get(crid);
    if (s === undefined) { try { s = decodePNG(readFileSync(join(dir, "textures", "pitbox", `${crid}.png`))); } catch (err) { this.log(`roster pit box for car ${crid}: ${err.message}`); s = null; } this.pitBoxSheets.set(crid, s); }
    return s;
  }
  // Pit crew uniforms of added drivers: CHARTEX entries CREW_BASE + slot (crew-tex.mjs), in the start car's crew set
  // (its CRSK PTEX): "made" plain suits in the driver's colours (shading from CHARTEX 0, a light suit), "custom" from
  // roster/textures/crew/<crid>.png (a uniform sheet).
  withRosterCrews(t) {
    const list = dir0 => dir0 ? rosterCrews(this.config?.roster) : [], dir = this.config?.rosterDir, mine = list(dir), crews = (this.config?.sponsors ?? []).filter(x => x.crew);
    if (!mine.length && !crews.length) return t;
    const made = new Map(), n = t.count, count = Math.max(CREW_BASE + mine.length, crews.length ? SPONSOR_CREW_BASE + 64 : 0);
    // (sponsor schemes' uniforms: SPONSOR_CREW_BASE + scheme id, from roster/sponsors/<id>/crew.png)
    const sponsorCrew = i => { const k = `s${i}`; if (made.has(k)) return made.get(k); let data;
      try { const x = crews.find(s => s.id === i - SPONSOR_CREW_BASE); if (!x) throw new Error("no such scheme"); data = encodeCrew(t.entry(Math.min(3, n - 1)), decodePNG(readFileSync(join(this.config.sponsorDir, String(x.id), "crew.png")))); }
      catch (err) { this.log(`sponsor crew ${i}: ${err.message}`); data = t.entry(0); }
      made.set(k, data); return data; };
    const make = c => {
      if (made.has(c.slot)) return made.get(c.slot);
      let data = null;
      try {
        const crsk = this.db?.tables.get("CRSK")?.rows ?? [], car = this.db?.tables.get("CARS")?.rows.find(r => r.CRID === c.template);
        const pt = (crsk.find(r => r.CRID === c.template && r.CTXN === car?.CSTN) ?? crsk.find(r => r.CRID === c.template))?.PTEX, tpl = t.entry(pt >= 0 && pt < Math.min(n, 80) ? pt : 0);
        if (c.mode === "custom") { const png = decodePNG(readFileSync(join(dir, "textures", "crew", `${c.crid}.png`))); data = encodeCrew(tpl, png); }
        else data = madeCrew(tpl, c.colors, t.entry(0));
      } catch (err) { this.log(`roster crew for car ${c.crid}: ${err.message}`); data = t.entry(0); }
      made.set(c.slot, data); return data;
    };
    const entries = new Array(count), mineAt = i => i >= CREW_BASE && i < CREW_BASE + mine.length, spAt = i => crews.length && i >= SPONSOR_CREW_BASE;
    for (let i = 0; i < count; i++) entries[i] = i < n ? t.entries[i] : spAt(i) ? { get size() { return sponsorCrew(i).length; } } : mineAt(i) ? { get size() { return make(mine[i - CREW_BASE]).length; } } : { size: 0 };
    return { ...t, count, entries, entry: i => i < n ? t.entry(i) : spAt(i) ? sponsorCrew(i) : mineAt(i) ? make(mine[i - CREW_BASE]) : t.entry(0) };
  }
  resourceModule() {
    const m = this.mem, H = (a, f) => this.hooks.set(a, f), res = this.resources = new Map(), terfFiles = new Map();
    H(0x1189b0, () => { m.w8(0x22ee60, 1); return 0; });
    H(0x118a70, c => {
      const name = m.cstr(c.arg(0)), path = this.findFile(name);
      if (!path) { this.note(0x118a70, `resource open ${name} (not found)`); return 0; }
      // archives are parsed once and kept (the race weekend reopens 100-200 MB bundles; reading them again took
      // most of the loading time)
      let t = terfCache.get(path); if (!t) { try { t = parseTerf(dataBytes(path)); terfCache.set(path, t); } catch (e) { this.log(`resource ${name}: ${e.message}`); return 0; } }
      if (/^(cardata|carresfe)\.dat$/i.test(name)) t = this.withRosterPaints(t, /^carresfe/i.test(name));
      if (/^tk_pbnr\.dat$/i.test(name)) { this.notePitBox(t); t = this.withRosterBanners(t); }
      if (/^chartex\.dat$/i.test(name)) t = this.withRosterCrews(t);   // (CARRESFE: the front end's copies, same CTIDs)
      if (/^carparts\.dat$/i.test(name)) t = this.withBrandDecals(t);
      t = this.withEntryOverrides(name, t);
      if (/^tk_rend\.dat$/i.test(name)) t = this.withFadeScale(t);
      const h = newHandle(name, t, 1); this.note(0x118a70, `resource open ${name}`); return h;
    });
    // handle block: +0x04 name, +0x14 u16 entry count, +0x16 u16 kind (1 file, 2 resident memory, 3 sub-archive),
    // +0x74 entry buffers, +0x78 entry flags
    const newHandle = (name, t, kind) => {
      const h = this.alloc(0x100), n = t.count, np = this.alloc(name.length + 1);
      m.writeBytes(np, Buffer.from(name + "\0", "latin1")); m.w32(h + 4, np);
      m.w16(h + 0x14, n); m.w16(h + 0x16, kind); m.w32(h + 0x74, this.alloc(n * 4)); m.w32(h + 0x78, this.alloc(n + 4));
      res.set(h, { name, t }); return h;
    };
    const entry = (h, i) => { const r = res.get(h); return r && i < r.t.count ? r : null; };
    H(0x119000, c => entry(c.arg(0), c.arg(1)) ? res.get(c.arg(0)).t.entries[c.arg(1)].size : 0);
    // a synchronous load of an entry that is still loading asynchronously waits for it (here: completes it now),
    // instead of loading a second copy (the first copy is the one the load callback fixes up)
    const settle = (h, i) => { const k = (this.resPending ?? []).findIndex(j => j.h === h && j.i === i); if (k < 0) return;
      const [job] = this.resPending.splice(k, 1); this.completeResourceLoads([job]); };
    H(0x11a390, c => { const h = c.arg(0), i = c.arg(1), r = entry(h, i); if (!r) { if (process.env.NT04_TRACE_MMAP) this.log(`11a390 miss h=${(h >>> 0).toString(16)} ${res.get(h)?.name ?? "?"} i=${i} count=${res.get(h)?.t.count}`); return 0; } settle(h, i);
      const flags = m.r32(h + 0x78), ptrs = m.r32(h + 0x74);
      if (process.env.NT04_TRACE_ENTRIES && new RegExp(process.env.NT04_TRACE_ENTRIES, "i").test(r.name ?? "")) this.log(`entry load ${r.name} ${i}`);   // (NT04_TRACE_ENTRIES=<archive name regex>)
      if (m.r8(flags + i) & 2) return m.r32(ptrs + i * 4);
      const data = r.t.entry(i), b = this.alloc(data.length + 16); m.writeBytes(b, data);
      m.w32(ptrs + i * 4, b); m.w8(flags + i, m.r8(flags + i) | 7); return b; });
    H(0x119140, c => { const h = c.arg(0), i = c.arg(1); return entry(h, i) && (m.r8(m.r32(h + 0x78) + i) & 2) ? 1 : 0; });
    // unload: as the real one, the entry's block is freed when the module allocated it (flags: 2 loaded, 1 our block;
    // not 0x40 / 0x20 / 8) — dropping it without the free leaked ~260 KB per driver change at driver select
    const unload = (h, i) => { const fp = m.r32(h + 0x78) + i, fl = m.r8(fp), pp = m.r32(h + 0x74) + i * 4;
      if ((fl & 2) && !(fl & 0x40)) { if ((fl & 1) && !(fl & 0x28)) this.free(m.r32(pp)); m.w8(fp, 0); m.w32(pp, 0); } };
    H(0x118e50, c => { const h = c.arg(0), i = c.arg(1); if (entry(h, i)) unload(h, i); return 0; });
    H(0x118f30, c => { const h = c.arg(0), r = res.get(h); if (r) for (let i = 0; i < r.t.count; i++) unload(h, i); return 0; });
    H(0x11a020, c => { res.delete(c.arg(0)); return 0; });
    // asynchronous read 0x11A670(archive, entry, priority, buffer, kind, callback, context): queues the read and
    // calls callback(archive, entry, data, status, context) when it is in (0x119B90 queue; status 0xF0007 when the
    // entry was already loaded). Here the entry is read at once and the callback runs before returning; the data
    // goes to the caller's buffer, or a new block that becomes the archive's copy of the entry when none is given.
    H(0x11a670, c => {
      const [h, i, , buf, , cb, ctx] = [0, 1, 2, 3, 4, 5, 6].map(k => c.arg(k)), r = entry(h, i); if (!r) return 0; settle(h, i);
      const flags = m.r32(h + 0x78), ptrs = m.r32(h + 0x74); let dest = buf, status = 0;
      if (m.r8(flags + i) & 2) { dest = m.r32(ptrs + i * 4); status = 0xf0007; }
      else { const data = r.t.entry(i); if (!dest) { dest = this.alloc(data.length + 16); m.w32(ptrs + i * 4, dest); m.w8(flags + i, m.r8(flags + i) | 7); } m.writeBytes(dest, data); }
      if (cb) this.nested(cb, [h, i, dest, status, ctx]);
      return dest;
    });
    // async load with allocation 0x11A490(h, i, alloc kind, priority, callback, context) -> buffer: the data is in
    // at once, but like the real module the entry stays "loading" (flag 0x10) and the callback runs later (start of
    // the next frame, see tick), after the caller has stored the returned buffer (the car model loader 0x6C5D0 needs
    // that order). Already loaded: callback now, as the real one does.
    this.resPending = [];
    H(0x11a490, c => {
      const [h, i, , , cb, ctx] = [0, 1, 2, 3, 4, 5].map(k => c.arg(k)), r = entry(h, i); if (!r) return 0;
      const flags = m.r32(h + 0x78), ptrs = m.r32(h + 0x74);
      if (m.r8(flags + i) & 2) { const d = m.r32(ptrs + i * 4); if (cb) this.nested(cb, [h, i, d, 0, ctx]); return d; }
      if (m.r8(flags + i) & 0x10) { const job = this.resPending.find(j => j.h === h && j.i === i); if (job && cb) job.cbs.push([cb, ctx]); return job?.dest ?? 0; }
      const data = r.t.entry(i), dest = this.alloc(data.length + 16); m.writeBytes(dest, data);
      m.w32(ptrs + i * 4, dest);
      m.w8(flags + i, m.r8(flags + i) | 0x11);
      this.resPending.push({ h, i, dest, cbs: cb ? [[cb, ctx]] : [] }); return dest;
    });
    H(0x1191b0, c => { const r = entry(c.arg(0), c.arg(1)); return r && (m.r8(m.r32(c.arg(0) + 0x78) + c.arg(1)) & 0x10) ? 1 : 0; });   // loading?
    H(0x11a770, c => this.hooks.get(0x11a670)(c));                       // async read into a given buffer: same here
    H(0x1190a0, c => c.arg(0) ? m.r16(c.arg(0) + 0x14) : 0);               // entry count
    H(0x1190f0, c => c.arg(0) ? m.r16(c.arg(0) + 0x16) : 0);               // archive kind
    // load entry into the caller's buffer (or a new block) and make it the archive's copy: 0x11A5C0(h, i, buf)
    H(0x11a5c0, c => { const h = c.arg(0), i = c.arg(1), r = entry(h, i); if (!r) return 0; settle(h, i);
      const flags = m.r32(h + 0x78), ptrs = m.r32(h + 0x74);
      if (process.env.NT04_TRACE_ENTRIES && new RegExp(process.env.NT04_TRACE_ENTRIES, "i").test(r.name ?? "")) this.log(`entry load ${r.name} ${i}`);   // (NT04_TRACE_ENTRIES=<archive name regex>)
      if (m.r8(flags + i) & 2) return m.r32(ptrs + i * 4);
      const data = r.t.entry(i), b = c.arg(2) || this.alloc(data.length + 16); m.writeBytes(b, data);
      m.w32(ptrs + i * 4, b); m.w8(flags + i, m.r8(flags + i) | 6); return b; });
    // copy entry into a buffer: 0x11A870(h, i, dest) -> status
    H(0x11a870, c => { const r = entry(c.arg(0), c.arg(1)); if (!r) return 0xf0006; m.writeBytes(c.arg(2), r.t.entry(c.arg(1))); return 0; });
    // open an entry that is itself a TERF archive: 0x11AF60(h, i, flag, kind) -> handle (named archive name + index)
    const subs = new Map();
    H(0x11af60, c => { const h = c.arg(0), i = c.arg(1), r = entry(h, i); if (!r) return 0;
      const key = `${r.name}${i}`; if (subs.has(key) && res.has(subs.get(key))) return subs.get(key);
      let t; try { t = parseTerf(r.t.entry(i)); } catch (e) { this.log(`resource ${key}: ${e.message}`); return 0; }
      const sh = newHandle(key, t, c.arg(3) === 1 ? 2 : 3); subs.set(key, sh); return sh; });
    // open an archive that is already in memory (resident): 0x118BD0(block, size, name or 0 = "Resident") -> handle;
    // CarResource opens carparts.dat this way (the car paint templates and decals of Create-A-Car / the car preview)
    H(0x118bd0, c => { const p = c.arg(0), n = c.arg(1), name = c.arg(2) ? m.cstr(c.arg(2)) : "Resident";
      // the block is read by the file module's whole-file read 0x1295B0, not ported: a "RESI<file>" archive that is
      // not in memory is read from <file>.dat in the data folder (CarResource: RESIcarparts = carparts.dat)
      let bytes = n ? Buffer.from(m.readBytes(p, n)) : Buffer.from(m.readBytes(p, 16));
      if (!isTerf(bytes) && /^RESI/i.test(name)) { const path = this.findFile(name.slice(4) + ".dat"); if (path) bytes = terfFiles.get(path) ?? terfFiles.set(path, readFileSync(path)).get(path); }
      let t; try { t = parseTerf(bytes); } catch (e) { this.log(`resource ${name} (resident): ${e.message}`); return 0; }
      if (/carparts/i.test(name)) t = this.withBrandDecals(t);         // sponsors added to the game's list: their decals
      const h = newHandle(name, t, 2); this.note(0x118bd0, `resource open ${name} (resident)`); return h; });
    H(0x119220, c => { const n = m.cstr(c.arg(0)).toLowerCase(); for (const r of res.values()) if (r.name.toLowerCase() === n) return 1; return 0; });
    H(0x11b950, () => 0);                                                   // debug label output
    H(0x11b480, () => 0); H(0x11b4b0, () => 1); H(0x11b520, () => 1);      // pre-opened stream files list: not needed here
    // entry's size, file offset and file handle, to stream it straight from the file: 0x119260(h, i, &size, &offset,
    // &file) (EA's stream player 0x16C682 uses it for the music, speech and long samples in nmusic.dat / nspchdat.dat /
    // nsound.dat and then reads through the file module). The archive is already in memory here, so the file handle
    // is one of the file module's (fileSystem) backed by that buffer; compressed entries cannot be streamed this way.
    H(0x119260, c => { const h = c.arg(0), i = c.arg(1), r = entry(h, i); if (!r) return 0xf0006;
      const e = r.t.entries[i]; if (e.method !== 0 || !r.t.buf || !this.fileFromBuffer) return 0xf000e;
      r.file ??= this.fileFromBuffer(r.name, r.t.buf);
      if (c.arg(2)) m.w32(c.arg(2), e.size); if (c.arg(3)) m.w32(c.arg(3), e.offset); if (c.arg(4)) m.w32(c.arg(4), r.file);
      return 0; });
    for (const a of [0x118d20, 0x11a960, 0x11ae40, 0x11b710])
      this.stub(a, `resource module 0x${a.toString(16)} (not ported)`);
  }
  // Call game code from inside a hook (registers and the shadow call stack are restored afterwards)
  // "Unlock everything" (launcher setting -> NT04_UNLOCK_ALL=1, or config.unlockAll): every Thunder Plate (table CARD,
  // CRDN >= 0, at its highest level: sponsors have 3) in ULCD for the four profiles (PRID 0..3; ULCD's 868 rows = 217
  // cards x 4), before the game's own unlock pass 0x16840 runs (ULDR reset to every normal car, then 0x15DD0 per card
  // type through the handler table 0x21DC14: locked drivers / races / Create-A-Car templates / paints / sponsor
  // levels). The same again after a profile save is loaded (it brings its own ULCD / ULDR). No notices are queued (the
  // award path 0x16B10 -> 0x158D0 is not used). Profiles saved meanwhile keep the plates.
  unlockAllHook() {
    if (!(process.env.NT04_UNLOCK_ALL === "1" || this.config?.unlockAll)) return;
    const fill = this.unlockFill = () => {
      const card = this.db?.tables.get("CARD"), ul = this.db?.tables.get("ULCD"); if (!card || !ul) return 0;
      const top = new Map(); for (const r of card.rows) if (r.CRDN >= 0 && r.CLVL >= 0) top.set(r.CRDN, Math.max(top.get(r.CRDN) ?? -1, r.CLVL));
      let n = 0;
      for (let prid = 0; prid < 4; prid++) for (const [crdn, lv] of top) {
        const r = ul.rows.find(x => x.PRID === prid && x.CRDN === crdn);
        if (!r) { ul.rows.push({ PRID: prid, CRDN: crdn, CLVL: lv, CRDE: 1 }); n++; } else if (r.CLVL < lv) { r.CLVL = lv; n++; }
      }
      if (ul.rows.length > ul.capacity) ul.capacity = ul.rows.length;
      if (n) { this.db.invalidate?.(); this.log(`unlock everything: ${n} Thunder Plate rows added`); }
      return n;
    };
    this.hooks.set(0x16840, (c, ret) => { fill(); c.push(ret); c.passThrough = 0x16840; c.hookReturn = 0x16840; return undefined; });
  }
  // The boot question "enable Autosave?" comes whenever there is no System Settings save, and nothing ever made one:
  // the settings save slot (record 0 of the slot table 0x21F2C8, type 0) has no device yet (+0 / +4 = -1) and, as
  // its Yes stores CSYS.ASAV = 1 (nascar.db's own value), it never looks changed, so the autosave (0xD9 -> 0x5EC60
  // counts the changed slots, then the memory-unit dialogs save them) skips it; the question came back on every boot of
  // a new preset or a fresh save folder until a setting was changed by hand. While that slot has no device, it is
  // marked changed (+0xD clear, the baseline checksum +0x14 moved) before the count: with Autosave on, the main
  // menu's autosave then writes "System Settings 1" with the profiles (it takes the hard disk, +0 = 0), and the next
  // boot loads it instead of asking. With Autosave off nothing is saved, as before. NT04_SETTINGS_SAVE=0: off.
  settingsSaveHook() {
    if (process.env.NT04_SETTINGS_SAVE === "0") return;
    const m = this.mem, SLOT = 0x21f2c8;
    this.hooks.set(0x5ec60, (c, ret) => {
      if (m.r32(SLOT) === 0xffffffff && m.r32(SLOT + 8) === 0 && m.r8(SLOT + 0x10)) { m.w8(SLOT + 0xd, 0); m.w32(SLOT + 0x14, (m.r32(SLOT + 0x14) ^ 1) >>> 0); }
      c.push(ret); c.passThrough = 0x5ec60; c.hookReturn = 0x5ec60; return undefined;
    });
  }
  nested(addr, args = [], regs = {}) {
    const c = this.cpu, saved = Uint32Array.from(c.r), frames = c.frames.slice(0, c.fn), eip = c.eip, flags = c.flags;
    try { return c.call(addr, args, regs); } finally { c.r.set(saved); c.frames.set(frames); c.fn = frames.length; c.eip = eip; c.flags = flags; }
  }
  // An interrupt (the vertical-blank callback) can land between any two instructions of the interrupted code, so the
  // whole CPU state comes back afterwards: registers, EFLAGS, x87 and SSE state. (nested() used to restore only the
  // registers: a vblank between `cmp eax,ebx` and `jne` in the visibility walk 0xF2310 changed ZF, the loop ran on
  // past 0 and zeroed every 16th byte through the track's mesh table and visibility tree.)
  interrupt(addr, args = []) {
    const c = this.cpu, ctx = c.saveCtx();
    try { return c.call(addr, args); } finally { c.loadCtx(ctx); }
  }
  // The game's database engine (0x144000-0x152000) is nascar-db.mjs: queries are bridged at 0x1471D0. Loading a
  // database file or image (0x147780(db name, source, mode, file ops)) reads the bytes through the given file-ops
  // table (ops[0] open(handle*, 0, source, 1), ops[2] read(handle*, buf, n, &got), ops[1] close(handle*)) and
  // puts its tables into the JS database, replacing tables of the same name (the game reloads nascar.db when the
  // database process 5 starts, and loads saved-game images the same way). Engine setup/teardown calls are no-ops.
  databaseEngine() {
    const m = this.mem;
    this.hooks.set(0x147780, c => {
      const ops = c.arg(3), src = c.arg(1), h = SCRATCH + 0x800, buf = SCRATCH + 0x1000, got = SCRATCH + 0x810, N = 0x8000;
      m.w32(h, 0); m.w32(h + 4, 0); m.w32(h + 8, 0); m.w32(h + 12, 0);
      const label = m.cstr(src).match(/^[\x20-\x7e]{3,}$/) ? m.cstr(src) : `0x${src.toString(16)}`;
      let r = this.nested(m.r32(ops), [h, 0, src, 1]);
      if (r) { this.log(`database load ${label}: open failed (${r})`); return r; }
      const chunks = [];
      // read in chunks; once the DB header is in, ask for exactly what is left (memory readers fail on over-reads)
      let have = 0, total = Infinity;
      for (;;) { const want = have < 12 ? 12 - have : Math.min(N, total - have); if (want <= 0) break;   // the 12-byte header first: a memory reader refuses a read past its end
        m.w32(got, 0); r = this.nested(m.r32(ops + 8), [h, buf, want, got]); const n = m.r32(got);
        if (n) { chunks.push(m.readBytes(buf, n)); have += n; }
        if (total === Infinity && have >= 12) { const b = Buffer.concat(chunks); if (b.toString("latin1", 0, 2) === "DB") total = b.readUInt32LE(8); }
        if (r || n < want) break;
        if (total === Infinity && have >= 12) total = have + N * 4096; }   // not an EA DB: read on in chunks until the source ends
      this.nested(m.r32(ops + 4), [h]);
      const bytes = Buffer.concat(chunks);
      try {
        const tables = parseDb(bytes).tables; let n = 0;
        if (this.db) for (const [name, t] of tables) { this.db.tables.set(name, t); n++; }
        // the game database itself (not a save image): the configuration overlay goes on top again
        if (this.db && /nascar\.db$/i.test(label)) for (const p of applyConfig(this.db, this.config ?? {})) this.log(`config: ${p}`);
        // a saved game: the roster's drivers it was made without go back in (nt04-config reapplyRoster)
        else if (this.db && this.config?.roster) for (const p of reapplyRoster(this.db, this.config, tables)) this.log(`config: ${p}`);
        if (this.db && !/nascar\.db$/i.test(label)) reapplyBrands(this.db, this.config, tables);   // (a save made before a sponsor was added)
        if (this.db && !/nascar\.db$/i.test(label) && tables.has("DRVR")) applyPoolRemoved(this.db, this.config?.poolRemoved);   // (the Career tab's list as it is now)
        if (this.unlockFill && !/nascar\.db$/i.test(label) && (tables.has("ULCD") || tables.has("ULDR"))) { this.unlockFill(); this.nested(0x16840); }   // (a profile save: everything unlocked again)
        // a saved career's generated prospects: their track skills (DSKL is not in saves) made again
        if (this.db && this.config?.sillySeason?.enabled && !/nascar\.db$/i.test(label)) repairGenerated(this.db);
        // a saved game without the silly season's contract / prestige tables (made before they were on, or a season):
        // none from another career stay behind
        if (this.db && !/nascar\.db$/i.test(label)) resetCareerTables(this.db, tables);   // (only the ones the save lacks)
        this.state.dbLoads ??= []; this.state.dbLoads.push({ source: label, mode: c.arg(2), bytes: bytes.length, tables: n });
        this.note(0x147780, `database load ${label}`);
        return 0;
      } catch (e) { this.log(`database load ${label}: ${e.message}`); return 5; }
    });
    // Physics / AI constants block (0x5E0E0, pointer [0x2F2F60], 0x561C bytes): the game lists the constant tables
    // in CNST ('TNAM' table, 'ORDB' sort column, cursor query sorted by name) and copies every row of each (sorted by
    // its column) through the engine's structured API (0x147D70 field list, 0x1480E0 open, 0x1481C0 fetch, 0x148170
    // close; not bridged, so it found no tables and left the block zero: no tire friction, gear ratios, torque curve,
    // surface grip... and a player's car with no grip). Here the block is filled the same way from the JS database:
    // per table, per row, the int / uint / float fields (types 2, 3, 4) except the sort column, 4 bytes each. The
    // tables add up to exactly 0x561C bytes.
    this.hooks.set(0x5e0e0, () => {
      let p = m.r32(0x2f2f60);
      if (!p) { p = this.nested(0x110640, [0x561c, 0]) >>> 0; m.w32(0x2f2f60, p); }
      if (!p || !this.db) return 0;
      const cn = this.db.tables.get("CNST"); if (!cn) { this.log("physics constants: no CNST table"); return 0; }
      const list = [...cn.rows].sort((a, b) => (a.TNAM < b.TNAM ? -1 : a.TNAM > b.TNAM ? 1 : 0));
      let o = 0; const end = p + 0x561c, missing = [];
      for (const row of list) {
        const t = this.db.tables.get(row.TNAM); if (!t) { missing.push(row.TNAM); continue; }
        // fields in the loader's order: 0x5E070 qsorts the field list by name (0x5F480 compares the 4-char codes as
        // bytes, i.e. alphabetically) after the sort column was taken out (0x5DFE0)
        const ord = row.ORDB, fields = t.fields.filter(f => f.name !== ord && (f.type === 2 || f.type === 3 || f.type === 4))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        // id-keyed tables keep the game's own rows only: the game reads row N at a fixed offset, so rows added for
        // added tracks / races (nt04-config applyTracks) would shift every table after them (see CNST_ID_ROWS)
        let rows = ord ? [...t.rows].sort((a, b) => (a[ord] ?? 0) - (b[ord] ?? 0)) : t.rows;
        const lim = CNST_ID_ROWS[row.TNAM]; if (lim !== undefined && ord) rows = rows.filter(r => (r[ord] ?? 0) < lim);
        for (const r of rows) for (const f of fields) {
          if (p + o + 4 > end) break;
          const v = r[f.name] ?? 0;
          if (f.type === 4) m.wf(p + o, v); else m.w32(p + o, v >>> 0);
          o += 4;
        }
      }
      if (missing.length || o !== 0x561c) this.log(`physics constants: ${o} of 0x561c bytes${missing.length ? `, missing tables ${missing.join(" ")}` : ""}`);
      return 0;
    });
    // Enum text 0x5F150 (eax = enum table name as a 4-char int, edx = char* out, [esp+4] = value): the 'EDIS' text of
    // the row whose 'EVAL' is the value, through the engine's structured query 0x148210 (not bridged), so here
    this.hooks.set(0x5f150, c => {
      const out = c.r[2], t = this.db?.tables.get(tname(c.r[0])), v = c.arg(0) | 0;
      if (out) m.w8(out, 0);
      const row = t?.rows.find(r => (r.EVAL | 0) === v);
      if (row && out) { const s = String(row.EDIS ?? ""); m.wstr(out, s, s.length); return 0; }
      return 0x17;
    });
    // Saving: each table has a "save" flag (bit 1 of its flags; 0x147E30 get(db, name, u8*), 0x147E70 set(db, name,
    // on)); 0x147CA0(db, names*, count*) lists table names (the 4-char name as an int in memory order); 0x1477D0(db,
    // destination, file ops) writes the flagged tables as a DB image through ops[0] open(h*, size, dest, 0),
    // ops[3] write(h*, buf, n, &written), ops[1] close(h*). Which tables go into a save comes from table STAB.
    const tname = v => String.fromCharCode(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24);
    const tint = n => (n.charCodeAt(0) | n.charCodeAt(1) << 8 | n.charCodeAt(2) << 16 | n.charCodeAt(3) << 24) >>> 0;
    const flagged = t => t.save ?? ((t.flags & 2) !== 0);
    this.hooks.set(0x147ca0, c => { const names = c.arg(1), cnt = c.arg(2); if (!cnt || !this.db) return 3;
      let cap = m.r32(cnt), i = 0; if (!names) cap = 0;
      for (const k of this.db.tables.keys()) { if (i >= cap) break; m.w32(names + i * 4, tint(k)); i++; }
      m.w32(cnt, names ? i : this.db.tables.size); return 0; });
    this.hooks.set(0x147e30, c => { const t = this.db?.tables.get(tname(c.arg(1))); if (!t) return 5; if (c.arg(2)) m.w8(c.arg(2), flagged(t) ? 1 : 0); return 0; });
    // 0x148510(db, table list, file name, mode, file ops): reload the listed tables (u32 tags up to -1) from a database
    // file, replacing their rows. 0x5F320 uses it to reset the career tables (CDRS rows with DELT 1: DRVR, CARS,
    // SPON, ...) to nascar.db's after deleting their rows, e.g. when the attract demo sets up its race; without it the
    // driver and car tables stayed empty and the menus showed blank names afterwards.
    this.hooks.set(0x148510, c => {
      if (!this.db) return 5;
      const list = c.arg(1), name = m.cstr(c.arg(2)), path = this.findFile(name); if (!path) { this.log(`database reload: ${name} not found`); return 5; }
      let fresh; try { fresh = parseDb(readFileSync(path)).tables; } catch (e) { this.log(`database reload ${name}: ${e.message}`); return 5; }
      const names = []; for (let i = 0; i < 512; i++) { const v = m.r32(list + i * 4); if (v === 0xffffffff) break; names.push(tname(v)); }
      for (const n of names) { const t = fresh.get(n); if (!t) continue; const old = this.db.tables.get(n); if (old?.save !== undefined) t.save = old.save; this.db.tables.set(n, t); }
      if (/nascar\.db$/i.test(name)) for (const p of applyConfig(this.db, this.config ?? {})) this.log(`config: ${p}`);
      if (names.includes("DRVR")) resetCareerTables(this.db);   // a new career: no contracts / prestige from the last one
      this.note(0x148510, `database reload ${name}: ${names.length} tables`); return 0;
    });
    // 0x1479E0(db, table): drop a table (0x5F320: CDRS rows with DELT 2, the game-mode tables gmodedb.dat brings in)
    this.hooks.set(0x1479e0, c => { if (!this.db) return 5; const n = tname(c.arg(1)); if (!this.db.tables.delete(n)) return 7; this.note(0x1479e0, `database drop ${n}`); return 0; });
    // 0x147D50(db, table): 0 when the table is loaded, 7 when not (5: no database). The game's own lookup 0x1472C0 walks
    // its table list 0x27F6E4, empty here, so it answered 7 for everything: the Lightning Challenge result 0x15D70
    // checks CHAL that way before writing "beaten" (CHBC / CHBL) and so never marked a won challenge completed.
    // Lightning Challenge result (0x8b070, message 0x80000006 of 0x8b1d0, sent when the results screen is left): with the
    // success flag (0x9c6c0: [[0x2f31e4]+0x56]) set it adds the CHRS (CLID, PRID) row the challenge list draws its checkered flag from,
    // and the profile save keeps it as SCHR. One line to the console per challenge, so a missing flag can be traced
    this.hooks.set(0x8b070, (c, ret) => { const ok = this.nested(0x9c6c0, []) & 0xff;
      console.log(`lightning: challenge ${(c.arg(0) >>> 0).toString(16)} finished, success ${ok}, completed rows ${this.db?.tables.get("CHRS")?.rows.length ?? "-"}`);
      c.push(ret); c.passThrough = 0x8b070; c.hookReturn = 0x8b070; return undefined; });
    if (!process.env.NT04_STOCK_TABLECHECK) this.hooks.set(0x147d50, c => { if (!this.db) return 5; return this.db.tables.has(tname(c.arg(1))) ? 0 : 7; });
    this.hooks.set(0x147e70, c => { const t = this.db?.tables.get(tname(c.arg(1))); if (!t) return 5; t.save = (c.arg(2) & 0xff) === 1; return 0; });
    // 0x147830(db, names*, count, crc*): checksum of the save-flagged tables' rows (all of them when names is 0, else
    // only the listed ones), started at -1. The save slots keep it (0x5EAE0: +0xD "unchanged" = crc == +0x14), and
    // the autosave checks read that flag (natives 0x29 / 0xD9). The game's own engine walks its table list 0x27F6E4,
    // which is empty here, so every checksum came out 0 and nothing ever looked changed: autosave never ran.
    // (NT04_NO_SAVE_CRC=1: the old all-zero checksum, nothing ever looks changed)
    if (!process.env.NT04_NO_SAVE_CRC) this.hooks.set(0x147830, c => {
      if (!this.db) return 5;
      const names = c.arg(1), cnt = c.arg(2), out = c.arg(3), want = names ? new Set() : null;
      if (want) for (let i = 0; i < Math.min(cnt, 512); i++) want.add(tname(m.r32(names + i * 4)));
      let h = 0x811c9dc5;
      for (const [n, t] of this.db.tables) {
        if ((want && !want.has(n)) || !flagged(t)) continue;
        const s = n + JSON.stringify(this.db.savedRows?.(t) ?? t.rows);
        for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
      }
      if (out) m.w32(out, (h ^ 0xffffffff) >>> 0);
      return 0;
    });
    this.hooks.set(0x1477d0, c => {
      if (!this.db) return 5;
      const tables = [...this.db.tables.values()].filter(flagged).map(t => { const rows = this.db.savedRows?.(t) ?? t.rows; return rows === t.rows ? t : { ...t, rows }; }), image = writeDb(tables);
      const ops = c.arg(2), dest = c.arg(1), h = SCRATCH + 0x800, buf = SCRATCH + 0x1000, done = SCRATCH + 0x810, N = 0x8000;
      for (let i = 0; i < 16; i += 4) m.w32(h + i, 0);
      let r = this.nested(m.r32(ops), [h, image.length, dest, 0]);
      if (r) { this.log(`database save: open failed (${r})`); return r; }
      for (let o = 0; o < image.length && !r; o += N) { const part = image.subarray(o, o + N); m.writeBytes(buf, part); m.w32(done, 0); r = this.nested(m.r32(ops + 12), [h, buf, part.length, done]); }
      this.nested(m.r32(ops + 4), [h]);
      this.note(0x1477d0, `database save: ${tables.length} tables, ${image.length} bytes`);
      this.state.dbSaves ??= []; this.state.dbSaves.push({ tables: tables.map(t => t.name), bytes: image.length, status: r });
      return r;
    });
    // 0x5F4D0(part): load database part `part` of the TERF bundle gmodedb.dat (through the resource module
    // 0x118A70.., not ported) with file ops 0x205F90
    this.hooks.set(0x5f4d0, c => {
      const part = c.arg(0) & 0xff, path = this.findFile("gmodedb.dat");
      try {
        const t = parseTerf(dataBytes(path)), tables = parseDb(t.entry(part)).tables;
        if (this.db) for (const [name, tb] of tables) this.db.tables.set(name, tb);
        this.note(0x5f4d0, `database load gmodedb.dat part ${part}`);
      } catch (e) { this.log(`gmodedb.dat part ${part}: ${e.message}`); }
      return 0;
    });
    // resource module (TERF archives, 0x118000-0x11C000) is not ported: releasing the resource list is a no-op
    if (!process.env.NT04_GAME_RES) this.resourceModule();          // NT04_GAME_RES=1: run the game's own (experiment)
    // releasing the resource module's lists when it was never set up (0x22EE60 = 0) would follow null pools
    for (const a of [0x11b6c0, 0x11aea0]) this.hooks.set(a, (c, ret) => { if (!m.r8(0x22ee60) || !m.r32(0x22ee90)) return 0; c.push(ret); c.passThrough = a; c.hookReturn = a; return undefined; });
    for (const a of [0x147340, 0x11ea30, 0x147390, 0x144890, 0x147590, 0x147920, 0x1476c0, 0x144aa0, 0x1484a0, 0x11ea70])
      this.stub(a, `database engine 0x${a.toString(16)}`);
  }
  // Startup as the game's entry does it, minus the hardware: the CRT/C/C++ initializers (atexit 0x17F8E2 and
  // _onexit 0x17F8AA are no-ops here), then the game-process manager at 0x2F3990
  // (0x174F60 creates the 11 processes from its vtable 0x1F9580; main loop 0x14400). The main loop would start
  // process 0 (system) and 1 (game flow); here the frontend is the UI VM, so only processes the UI code starts
  // itself run (e.g. 6 = memory unit, started by 0x104140 from the 5/x screens), ticked by tick() each frame.
  startup() {
    const m = this.mem; this.hooks.set(0x17f8e2, () => 0); this.hooks.set(0x17f8aa, () => 0);
    // XAPI start-up 0x1097F0: 0x10AEF9 runs 0x204F80..0x204F8C (CRT thread data 0x183652, stdio table 0x185BB0), then
    // 0x10AEA1 calls [0x21C568] (FPU set-up 0x180393), the C initializers 0x205294..0x2052A8 (atexit table, stdio
    // streams, locale, ...) and the C++ ones 0x204F90..0x205290.
    const run = (f, args = []) => { if (!f || f === 0xffffffff) return; this.reset();
      try { this.cpu.call(f, args); } catch (e) { this.log(`initializer 0x${f.toString(16)}: ${e.message}`); } };
    for (let a = 0x204f80; a < 0x204f8c; a += 4) run(m.r32(a));
    run(m.r32(0x21c568), [1]);
    for (let a = 0x205294; a < 0x2052a8; a += 4) run(m.r32(a));
    for (let a = 0x204f90; a < 0x205290; a += 4) run(m.r32(a));
    // memory allocator types (0x11CA40: the pool kinds the resource and file modules allocate through, 0x2F8D00 table);
    // part of the game's system init 0x144F0, which runs before the process manager in main 0x14400
    { this.reset(); try { this.cpu.call(0x11ca40); } catch (e) { this.log(`allocator init: ${e.message}`); } }
    // in-game camera/HUD action table 0x2F3078 (0x74CD0, pure data). Normally set by the UIStudio module's Load
    // (0x757B0, not loaded: the VM is the UI); the race update 0x9F360 -> 0x74DF0 calls through it
    { this.reset(); try { this.cpu.call(0x74cd0); } catch (e) { this.log(`hud table init: ${e.message}`); } }
    this.reset();
    try { this.cpu.call(0x174f60, [], { ecx: PROCESSES }); this.cpu.call(0x1750b0, [0], { ecx: PROCESSES }); }
    catch (e) { this.log(`process manager init: ${e.message}`); }
    this.moduleFilter();
    if (!this.noFrontendModules) this.loadFrontendModules();
  }
  // Game modules: objects with a reference count (+8) and Load/Unload methods (vtable +0x14/+0x18), loaded per
  // process state through the manager (0x175100 load with dependencies, 0x175150 unload; state lists from the
  // process vtable +0x14). The Interface process's Frontend state (6) list is 0x1D7D00. Its modules that are
  // game state rather than hardware or the UI system itself are loaded at startup, as entering the Frontend does:
  // car resources, memory card, user profiles/files, EA SPORTS Bio, the memory-card UI glue, the car and flag
  // objects (created-car id range 0x21FD0C, car model slots; their 3D preview parts are stubs).
  moduleName(p) {
    const m = this.mem, vt = m.r32(p);
    for (let i = 0; i < 12; i++) { const f = m.r32(vt + i * 4);
      if (f > IMAGE_BASE && f < 0x200000 && m.r8(f) === 0xb8 && m.r8(f + 5) === 0xc3) { const s = m.r32(f + 1);
        const t = s > 0x1d0000 && s < 0x230000 ? m.cstr(s) : ""; if (/^[A-Za-z][\w .\-]{2,}$/.test(t)) return t; } }
    return null;
  }
  // Modules that stand for hardware, audio or the game's own UI system (the VM replaces it) are not loaded: the
  // manager's per-module load 0x175670 / unload 0x1756A0 count them as loaded/unloaded without calling them.
  // Unnamed ones are graphics (0x2F4194) and a resource streamer (0x2F4174).
  moduleFilter() {
    const DENY = new Set([...(process.env.NT04_NO_GLIB ? ["Glib", "GlibRender", "VRAMHeapFE", "Viewport", "Font"] : []), "QuickloadFrontend", ...(process.env.NT04_NO_SOUND ? ["Speech", "Sound", "Music"] : []), "UIStudio", "UISCommon",
      "UISDebug", "UISChat", ...(process.env.NT04_TRY_FE_SOUND ? [] : ["UISEATrax"]), "UISFrontEnd", "UISController", "USB Keyboard", "Oscilloscope", "FileCacheProcess",
      "Loading...Coldboot"]);
    const DENY_AT = new Set([...(process.env.NT04_NO_GLIB ? [0x2f4194] : []), ...(process.env.NT04_TRY_FE_SOUND ? [] : [0x2f4174])]), m = this.mem;
    this.skippedModules = new Set();
    const skip = p => { if (DENY_AT.has(p)) return true; const n = this.moduleName(p); return n ? DENY.has(n) : false; };
    // Other modules load normally; one whose Load fails in emulation (it reaches hardware we do not have) is
    // reported once and counted as loaded, so the flow goes on.
    this.failedModules = new Map();
    const traceMod = process.env.NT04_TRACE_MODULES;
    this.hooks.set(0x175670, (c, ret) => { const p = c.r[1];                         // thiscall: ecx = module
      const name = this.moduleName(p) ?? `0x${p.toString(16)}`; c.r[4] += 4;
      if (traceMod) console.log(`module load ${name} refs ${m.r32(p + 8) | 0} loaded ${m.r8(p + 0xc)} from ${c.callStack?.() ?? ""}`.slice(0, 300));
      if (!skip(p) && !this.failedModules.has(p)) {
        try { c.passThrough = 0x175670; const ok = this.nested(0x175670, [p], { ecx: p }) & 0xff; if (traceMod && !ok) console.log(`module load ${name} returned 0`); return ok; }
        catch (e) { c.passThrough = null; this.failedModules.set(p, name); this.log(`module ${name}: load failed in emulation, counted as loaded (${e.message.slice(0, 400)})`); }
      }
      this.skippedModules.add(name); m.w8(p + 0xc, 1); for (const t of UI_TEX_TABLES[name] ?? []) this.texTableAdd?.(t); return 1; });
    if (traceMod) this.hooks.set(0x175580, c => { const p = c.r[1], st = c.arg(0); c.passThrough = 0x175580; const ok = this.nested(0x175580, [st], { ecx: p }) & 0xff; console.log(`process enter obj 0x${(p >>> 0).toString(16)} vt 0x${(m.r32(p) >>> 0).toString(16)} state ${st | 0} -> ${ok}`); c.r[4] += 4; return ok; });
    if (traceMod) this.hooks.set(0x175240, (c, ret) => { const a = [c.arg(0), c.arg(1), c.arg(2)]; console.log(`process state change ${a[0] | 0} ${a[1] | 0} ${a[2] | 0}`); c.passThrough = 0x175240; let v; try { v = this.nested(0x175240, a, { ecx: c.r[1], ebx: c.r[3] }) & 0xff; } catch (e) { console.log(`process state change threw: ${e.message.slice(0, 300)}`); throw e; } console.log(`process state change ${a[1] | 0} -> ${a[2] | 0} returned ${v}`); c.r[4] += 12; return v; });
    if (traceMod) this.hooks.set(0x1751a0, (c, ret) => { const l = c.arg(0); c.passThrough = 0x1751a0; const v = this.nested(0x1751a0, [l], { ecx: c.r[1] }) & 0xff; if (!v) console.log(`module list 0x${(l >>> 0).toString(16)} load returned 0`); c.r[4] += 4; return v; });
    if (traceMod) this.hooks.set(0x175100, (c, ret) => { const p = c.arg(0); c.passThrough = 0x175100; const v = this.nested(0x175100, [p], { ecx: c.r[1] }) & 0xff; if (!v) console.log(`module ${this.moduleName(p) ?? (p >>> 0).toString(16)} load (with dependencies) returned 0`); c.r[4] += 4; return v; });
    this.hooks.set(0x1756a0, (c, ret) => { const p = c.r[1];
      if (traceMod) console.log(`module unload ${this.moduleName(p) ?? `0x${p.toString(16)}`} refs ${m.r32(p + 8) | 0} loaded ${m.r8(p + 0xc)} from ${c.callStack?.() ?? ""}`.slice(0, 300));
      if (!skip(p) && !this.failedModules.has(p)) { c.push(ret); c.passThrough = 0x1756a0; c.hookReturn = 0x1756a0; return undefined; }
      const n = (m.r32(p + 8) - 1) | 0; m.w32(p + 8, n); if (n === 0) { m.w8(p + 0xc, 0); for (const t of UI_TEX_TABLES[this.moduleName(p)] ?? []) this.texTableDrop?.(t); } c.r[4] += 4; return 1; });
  }
  // The game flow: the Interface process (slot 1) goes Branding (4) -> Main Loading (5); its update asks for Frontend (6),
  // and the change 5 -> 6 opens F_Main 0/5 with (1, 2) = boot to the title screen (0x9DFB0). Its Frontend update
  // runs the UI managers (0x75500 -> 0x13AB30: the VM does that), the UI listener, renders and presents (stubs).
  startInterface() {
    this.flow = true;
    this.stub(0x13ab30, "UI manager frame (VM)"); this.stub(0x76240, "UI frame rate"); if (this.preview) this.previewHooks(); else if (!process.env.NT04_FE_RENDER) this.stub(0x154c10, "render frame");
    this.reset();
    // as main 0x14400 does: Main (0) and Interface (1) in their default states (Interface: 4 Branding, whose module
    // list 0x1D7C88 brings in Glib — the graphics library that creates the D3D device — then 5 Main Loading)
    const start = process.env.NT04_BOOT_STATE ? [[1, +process.env.NT04_BOOT_STATE]] : [[0, -1], [1, -1]];
    for (const [p, st] of start) { this.reset(); try { this.cpu.call(0x1752c0, [p, st >>> 0], { ecx: PROCESSES }); } catch (e) { this.log(`process ${p} start: ${e.message}`); } }
  }
  // Front-end car preview (default; NT04_PREVIEW=0 turns it off): the front-end frame 0x154C10 runs; before its first frame, UI layer 0 (camera, full-screen
  // view, sprite layer whose draw callback 0x75410 -> 0xEDB20 renders the UI manager) is built by 0x75520 as the
  // interface module does; the UI manager's render 0x13AA60 is replaced by the per-frame render message -2 to the
  // car objects of the screens the UI VM shows (uis-natives previewObjects), which draw the 3D car preview
  previewHooks() {
    const m0 = this.mem;
    this.hooks.set(0x154c10, (c, ret) => {
      if (!this.feLayer) { this.feLayer = true;
        try { this.buildLayer0(); this.note(0x75520, "UI layer 0 built"); }
        catch (e) { this.log(`UI layer 0: ${e.message.slice(0, 200)}`); } }
      c.push(ret); c.passThrough = 0x154c10; c.hookReturn = 0x154c10; return undefined; });
    // each car object is rendered inside its states' transforms, as the UI manager does: state enter 0x140350
    // (eax = header + 8: push the view's matrix, translate / rotate / scale by the state's position, pivot, angles,
    // scale) and leave 0x140420 (pop)
    const render = () => { for (const { obj, chain, handler = 0x9a900 } of this.previewObjects?.() ?? []) {
      for (const h of chain) this.nested(0x140350, [], { eax: h + 8 });
      // the UI layer's projection is a thin slab (depth ~579-589 maps to 0..1) and the car is ~75 units deep: its depth
      // runs from about -6 to +7; d3d.zRemap has the renderers squeeze depth -64..64 into their depth range instead of
      // clamping, which kept the car's parts in order (clamped, the near half all got depth 0 and later parts painted over it)
      const d3d = this.d3d; if (d3d) d3d.zRemap = true;
      try { this.uiObject(handler, obj, 0xfffffffe, []); } finally { if (d3d) d3d.zRemap = false; for (let i = chain.length; i > 0; i--) this.nested(0x140420); }
      this.note(handler, handler === 0x9a900 ? "car object render" : "3D object render"); } };
    this.hooks.set(0x13aa60, () => { render(); return 0; });
    // (the sprite layer's callback was not reached: the car objects also get -2 when layer 0's view finishes drawing)
    this.hooks.set(0x154930, (c, ret) => { if (m0.r32(c.r[4]) === m0.r32(0x2b7c3c)) render(); c.push(ret); c.passThrough = 0x154930; c.hookReturn = 0x154930; return undefined; });
  }
  // the 3D part of 0x75520 for layer 0 (globals at 0x2B7C38: +0 UI manager (left 0: the UI VM runs the screens and the
  // input), +4 view, +8 camera, +0xC sprite layer, +0x10 its item, +0x14/+0x18 screen offsets), same calls and values
  buildLayer0() {
    const m = this.mem, c = this.cpu, L = 0x2b7c38, f32 = v => { const b = Buffer.alloc(4); b.writeFloatLE(v); return b.readUInt32LE(0); };
    const h = this.nested(0x127d20) & 0xffff, w = this.nested(0x127d30) & 0xffff;
    this.nested(0x175e0); const fov = c.fpop();
    m.w32(L + 0x14, 0x440e4000); m.w32(L + 0x18, 0x44134000);
    const cam = this.nested(0x1214c0, [0, 0]); m.w32(L + 8, cam);
    this.nested(0x121950, [cam, 0x800000, 0, 0]);
    this.nested(0x1207a0, [0x100000]); const q = c.fpop(), k = Math.fround(m.rf ? m.rf(0x204afc) : 240) / q;   // fdivr [0x204AFC]
    this.nested(0x121900, [cam, 0x43d58000, 0x43700000, f32(-k)]);
    this.nested(0x1217d0, [cam, 0x3f800000]);
    m.w32(cam + 0x20, 0x42340000);
    const d = SCRATCH + 0x200; for (let i = 0; i < 0x14; i += 4) m.w32(d + i, 0);
    m.w16(d, 5); m.w8(d + 2, 0); m.w8(d + 3, 2); m.w16(d + 0x10, w); m.w16(d + 0x12, h);
    const view = this.nested(0x154750, [d]); m.w32(L + 4, view); m.w32(view + 0x1c, m.r32(view + 0x1c) & ~1);
    this.nested(0x154990, [view, 0, 0, 0]);
    this.nested(0x761a0, [f32(fov)], { eax: 0 });
    this.nested(0x1217f0, [view, cam]);
    const layer = this.nested(0x1278c0, [1, 0x100, 0, 0, 0, 4, 0, 0xffffffff]); m.w32(L + 0xc, layer);
    this.nested(0x127970, [layer, 10, 3, 0x75410]);
    this.nested(0x154a90, [view, layer, 3]);
    m.w32(L + 0x10, this.nested(0x127a70, [layer, 10, 0, 0]));
    this.nested(0x9a8f0, [], { eax: 0xeeed0 });   // (0x75520's last call: the car objects' draw callback 0xEEED0 -> preview draw 0xEEB00)
    this.log(`UI layer 0: view 0x${view.toString(16)} camera 0x${cam.toString(16)} sprite layer 0x${layer.toString(16)} ${w}x${h}`);
  }
  loadFrontendModules() {
    // UISCarObj Load 0xA1110 / Unload 0xA11B0: only the created-car id range (0x6C810 / 0x6C860); the rest builds
    // 3D car previews and number/paint textures (0x6D5D0, 0xEF130...), which have no use without a renderer
    if (!process.env.NT04_CAROBJ && !this.preview) this.hooks.set(0xa1110, () => { this.nested(0x6c810); return 1; });   // NT04_CAROBJ=1: the game's own (experiment)
    this.hooks.set(0xa11b0, () => { this.nested(0x6c860); return 1; });
    const m = this.mem, KEEP = new Set(["CarResource", "MemoryCard", "User Profiles", "User Files", "EASportsBIO", "UISMemoryCard", "UISCarObj", "UISFlagObj"]);
    // NT04_PREVIEW: the car / flag objects' Loads build 3D models, which needs Glib (model chunk handlers 0x1356D0)
    // and Sort (0x120F10) loaded first: they load with the interface's module lists instead of ahead of everything
    if (this.preview) { KEEP.delete("UISCarObj"); KEEP.delete("UISFlagObj"); }
    this.modules = [];
    for (let i = 0; i < 64; i++) {
      const p = m.r32(0x1d7d00 + i * 4); if (!p) break;
      const name = this.moduleName(p); if (!KEEP.has(name)) continue;
      this.reset();
      try { const ok = this.cpu.call(0x175100, [p], { ecx: PROCESSES }) & 0xff; this.modules.push({ name, ok }); if (!ok) this.log(`module ${name}: load failed`); }
      catch (e) { this.log(`module ${name}: ${e.message}`); this.modules.push({ name, error: e.message }); }
    }
  }
  // emulated time in milliseconds: the game clock plus the CPU time spent since (733 MHz)
  // ExQueryNonVolatileSetting (EEPROM user settings). Only the time zone is answered: XQueryValue(0xFF) reads the
  // whole 0x100-byte user block for XapiGetTimeZoneInformation (0x106FBF), which the local clock 0xE7830 uses
  // (time() - bias * 60). Answering "not found" left that block as stack garbage, so local time was off by decades
  // and EA SPORTS Bio's play timer (0x175B40: now - last sample) added ~77 years at once (Level 534, 28320 days).
  // The bias is the host's current UTC offset with daylight saving folded in (MiscFlags bit 1: no DST rules).
  // Other indices stay "not found" (language, video and region come from the game's own defaults as before).
  nonVolatileSetting(index, typeP, valueP, len, resultP) {
    const m = this.mem, bias = new Date().getTimezoneOffset(), dwords = { 0: bias, 3: 0, 6: 0, 0x10: 2 };
    if (index === 0xff) {
      const b = Buffer.alloc(0x100);
      b.writeInt32LE(bias, 0x04); b.write("UTC", 0x08, "latin1"); b.write("UTC", 0x0c, "latin1");
      b.writeUInt32LE(1, 0x30);               // language: English
      b.writeUInt32LE(2, 0x58);               // misc flags: bit 1 = daylight saving off
      b.writeUInt32LE(1, 0x5c);               // DVD region 1
      if (valueP) for (let i = 0; i < Math.min(len, 0x100); i += 4) m.w32(valueP + i, b.readUInt32LE(i));
      if (typeP) m.w32(typeP, 3); if (resultP) m.w32(resultP, 0x100); return 0;
    }
    if (index in dwords && len >= 4) { if (valueP) m.w32(valueP, dwords[index] >>> 0); if (typeP) m.w32(typeP, 4); if (resultP) m.w32(resultP, 4); return 0; }
    return 0xc0000034;
  }
  emuMs() { return (this.ms ?? 0) + this.cpu.steps / 733_000; }
  // finish async loads started by 0x11A490 in an earlier frame: mark the entries loaded and call their callbacks
  completeResourceLoads(only) {
    let jobs; if (only) jobs = only; else { jobs = this.resPending ?? []; if (!jobs.length) return; this.resPending = []; }
    for (const { h, i, dest, cbs } of jobs) {
      const f = this.mem.r32(h + 0x78) + i; this.mem.w8(f, (this.mem.r8(f) & ~0x10) | 7);
      for (const [cb, ctx] of cbs) {
        try { if (only) this.nested(cb, [h, i, dest, 0, ctx]); else { this.reset(); this.cpu.call(cb, [h, i, dest, 0, ctx]); } }
        catch (e) { this.log(`resource load callback 0x${cb.toString(16)}: ${e.message.slice(0, 200)}`); }
      }
    }
  }
  // idle time: load one more chunk of the compiled-code cache ahead of use (x86-jit-cache.mjs prefetch); false when done
  // (from the first idle call on, a missing JS chunk is no longer loaded mid-frame: x86-jit-cache.mjs lazyLoad)
  // Also translates queued WebAssembly blocks for up to `ms` (wasm-jit.mjs idleWork; from then on batches wait for
  // idle time instead of compiling in the frame that queued them).
  prefetchCode(ms = 2) { const j = this.cpu.jit, W = this.cpu.wasm, w = W?.cache; if (j?.cache) j.cache.lazyLoad = true;
    const b = W ? W.idleWork(ms) : false;
    const a = j?.cache ? j.cache.prefetch(j) : false; return (w ? w.prefetch() : false) || a || b; }
  // completion callbacks of asynchronous file reads (0x1293C0) issued during the last frame
  completeFileReads() {
    const list = this.ioDone ?? []; if (!list.length) return; this.ioDone = [];
    for (const { cb, count, ctx } of list) { this.reset(); try { this.cpu.call(cb, [count, 0, ctx]); } catch (e) { this.log(`file read callback 0x${cb.toString(16)}: ${e.message.slice(0, 160)}`); } }
  }
  // One frame of the process manager (0x175370: apply queued state requests, then update running processes).
  tick(dt = 1000 / 60) {
    // KeTickCount (data export; GetTickCount 0x107069 reads it) follows the UI clock, in milliseconds.
    // A frame of the 30 fps scenes (results, race weekend, demo race, victory lane) spans two 60 Hz periods; the game
    // threads get a slice in each period, not once a frame: EA's sound thread fills its 50 ms software-mix ring only
    // ~20 ms past the write cursor per wake, so at one wake per 33 ms half the music played was the ring's stale
    // contents from 50 ms before (measured: 49.7% of samples repeated at 2 periods a frame, 0% at 1), which sounded
    // like the music running at half speed.
    const periods = Math.max(1, Math.round(dt / (1000 / 60)));
    for (let i = 1; i < periods; i++) {
      this.ms = (this.ms ?? 0) + dt / periods; this.mem.w32(this.mem.r32(0x1cc94c), Math.floor(this.ms));
      if (this.threads) { this.reset(); this.threads.runAll(); }
    }
    this.ms = (this.ms ?? 0) + dt / periods; this.mem.w32(this.mem.r32(0x1cc94c), Math.floor(this.ms));
    // the Interface process's Frontend update also runs the UI listener (0x751E0: results of blocking/async UI
    // tasks -> notifications 88/89/90 for the "UIListener" screen 2/9)
    this.reset();
    if (!this.flow) try { this.cpu.call(0x751e0, []); }
    catch (e) { const k = `UI listener: ${e.message.slice(0, 200)}`; this.tickErrors ??= new Map(); if (!this.tickErrors.has(k)) this.log(k); this.tickErrors.set(k, (this.tickErrors.get(k) || 0) + 1); }
    this.completeResourceLoads();
    this.completeFileReads();
    this.reset();
    try { this.cpu.call(0x175370, [], { ecx: PROCESSES }); }
    catch (e) { const k = e.message.slice(0, 700); this.tickErrors ??= new Map(); if (!this.tickErrors.has(k)) this.log(`process tick: ${k}` + (process.env.NT04_TICK_EIP ? ` eip ${(this.cpu.eip >>> 0).toString(16)} stack ${(() => { const r = []; for (let i = 0; i < 64 && r.length < 10; i++) { try { const v = this.mem.r32(this.cpu.r[4] + i * 4) >>> 0; if (v > 0x11000 && v < 0x1c0000) r.push(v.toString(16)); } catch {} } return r.join(" "); })()}` : "")); this.tickErrors.set(k, (this.tickErrors.get(k) || 0) + 1); }
    // game threads get their time slice each frame
    if (this.threads) { this.reset(); this.threads.runAll(); }
    // netplay.mjs: remote cars are written into their car slots after each tick (and our car's state is sent)
    if (this.afterTick) try { this.afterTick(); } catch (e) { this.log(`netplay: ${e.message.slice(0, 200)}`); }
  }
  // State of process `slot` (-1 when it is not running), 0x175020 / 0x1754A0
  processState(slot) { const p = this.mem.r32(PROCESSES + 0x14 + slot * 4); if (!p || !this.mem.r8(p + 5)) return -1; return this.mem.r8(p + 0x20) ? this.mem.r32(p + 0x1c) | 0 : this.mem.r32(p + 8) | 0; }

  // The game's file module (0x128000-0x129800: file table 0x271D10 of 40-byte entries, async requests served by
  // worker threads, errors 0xA000x via 0x10EDB0) is replaced at its API by host files. Game paths are looked up
  // case-insensitively in the Data folder (the disc's Data directory), drive and leading "data\\" stripped.
  fileSystem() {
    const m = this.mem, files = this.files = new Map(); let next = 0;
    // the Data folder's listings, read once (every open looked through the folder again: ~70 entries, 1-2 s of a boot
    // to the menu on Windows)
    const dirs = new Map(), listDir = dir => { let l = dirs.get(dir); if (!l) { l = new Map(readdirSync(dir).map(f => [f.toLowerCase(), f])); dirs.set(dir, l); } return l; };
    const find = this.findFile = name => {
      let parts = name.replace(/^[a-z]:[\\/]?/i, "").split(/[\\/]+/).filter(Boolean);
      if (parts[0]?.toLowerCase() === "data") parts = parts.slice(1);
      let dir = this.dataDir;
      for (const part of parts) {
        let hit; try { hit = listDir(dir).get(part.toLowerCase()); } catch { return null; }
        if (!hit) return null; dir = join(dir, hit);
      }
      return dir;
    };
    const lastError = v => { m.w32(0x271d04 + 0, m.r32(0x271d04)); this.fsError = v; return v; };
    const H = (a, f) => this.hooks.set(a, f);
    H(0x129070, c => {                                         // open(name, device) -> handle or -1
      const name = m.cstr(c.arg(0)), path = find(name);
      this.note(0x129070, `file open ${name}${path ? "" : " (not found)"}`);
      if (!path) { lastError(0xa0003); return 0xffffffff; }
      // read-only game data: one copy per file, shared by every open
      let data = fileCache.get(path); if (!data) fileCache.set(path, data = dataBytes(path));   // (big ones read on demand: file-bytes.mjs)
      const h = next++; files.set(h, { name, path, data, pos: 0 }); return h;
    });
    H(0x129130, c => { if (!files.get(c.arg(0))?.shared) files.delete(c.arg(0)); return 0; });  // close(h)
    // a file handle on bytes already in memory (an archive the resource module holds): see 0x119260
    this.fileFromBuffer = (name, data) => { const h = next++; files.set(h, { name, path: name, data, pos: 0, shared: true }); return h; };
    H(0x129210, c => (find(m.cstr(c.arg(0))) ? 0 : 0xa0003));                                 // exists(name, device)
    H(0x129160, c => { const f = files.get(c.arg(0)); if (!f) return 0xa0004;                   // seek(h, offset, whence)
      const off = c.arg(1) | 0, w = c.arg(2); let p = w === 0 ? off : w === 1 ? f.pos + off : f.data.length - off;
      let r = 0; if (p < 0) { p = 0; r = 0xa0004; } if (p > f.data.length) { p = f.data.length; r = 0xa0004; } f.pos = p; return r; });
    H(0x129260, c => { const f = files.get(c.arg(0)); if (!f) return 0xffffffff;               // read(h, buf, n, done callback)
      const n = Math.min(c.arg(2), f.data.length - f.pos); m.writeBytes(c.arg(1), f.data.subarray(f.pos, f.pos + n)); f.pos += n;
      if (c.arg(3)) this.note(0x129260, "file read with callback (not called)"); return n; });
    // asynchronous read 0x1293C0(h, buf, n, priority, callback, ctx, ?) -> request id: done at once here (the bytes are
    // in memory); the completion callback cb(count, error, ctx) runs at the start of the next tick, as from the file
    // module's worker thread (EA's stream player reads music / speech this way, 8 KB at a time)
    let ioId = 1; this.ioDone = [];
    H(0x1293c0, c => { const f = files.get(c.arg(0)); if (!f) { lastError(0xa0004); return 0; }
      const n = Math.min(c.arg(2), Math.max(0, f.data.length - f.pos)); if (n > 0) m.writeBytes(c.arg(1), f.data.subarray(f.pos, f.pos + n)); f.pos += n;
      if (c.arg(4)) this.ioDone.push({ cb: c.arg(4), count: n, ctx: c.arg(5) });
      return ioId++; });
    H(0x129540, c => files.get(c.arg(0))?.data.length ?? 0);                                 // size(h)
    H(0x129560, c => files.get(c.arg(0))?.pos ?? 0);                                         // tell(h)
    H(0x128550, () => 0);                                                                     // wait for pending requests on h
    // 0x1280F0 is not the file module's: it reads 0x271AE0, the graphics library's "device created" flag (set by
    // 0x128070, cleared by 0x1280B0). Begin-scene 0x127F50 tests it before BeginScene + Clear(z, stencil, and colour
    // when 0x206150 is set); it runs as is so the frame's depth buffer is cleared.
    // (0x128010-0x1280B0 just before the file module are the graphics library's: resource release, scissors, init
    // 0x128070 -> device creation 0x127DD0, shutdown; they run as is on d3d-hle.mjs)
    H(0x1286d0, () => 0);                                                                     // "reads pending?" (the loading-screen thread 0xEC800 spins on it): never
    for (const a of [0x128490, 0x1285e0, 0x128600, 0x128630, 0x1286b0,
      0x128f50, 0x129310, 0x129440, 0x1294c0, 0x1295b0])
      this.stub(a, `file module 0x${a.toString(16)} (not ported)`, 0xffffffff);
    H(0x129580, () => 0); H(0x1295a0, () => 0);                                               // search path / default device
  }

  // Xbox kernel imports: each thunk slot (kernel_imports.csv) gets a stand-in address; functions are stdcall and
  // pop their argument bytes. Data exports point at zeroed blocks. A few functions do real work (memory, time);
  // file calls go to xbox-fs.mjs (disc folder, save folder); waits succeed at once.
  kernel() {
    const csv = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../xbox/kernel_imports.csv"), "utf8").trim().split(/\r?\n/).slice(1);
    const m = this.mem, area = m.map(0x7ff00000, Buffer.alloc(0x10000)); let next = 0x7ff00000, data = 0x7ff08000;
    setScratch(SCRATCH + 0x700);
    const fs = this.fs = new XboxFs(m, { discRoot: dirname(this.dataDir), saveRoot: this.saveDir, log: this.log });
    const args = (c, n) => Array.from({ length: n }, (_, i) => c.arg(i));
    const th = () => this.threads ??= new Threads(this);
    // LARGE_INTEGER* time-out: null = forever, negative = relative 100 ns units, positive (absolute) = now
    const timeout = p => { if (!p) return Infinity; const lo = m.r32(p), hi = m.r32(p + 4) | 0; const v = hi * 4294967296 + lo; return v < 0 ? -v / 10000 : 0; };
    const sha = new Map();
    const impl = {
      MmAllocateContiguousMemory: c => this.alloc(c.arg(0)), MmAllocateContiguousMemoryEx: c => this.alloc(c.arg(0)),
      ExAllocatePoolWithTag: c => this.alloc(c.arg(0)), MmQueryAllocationSize: () => 0x1000,
      MmGetPhysicalAddress: c => c.arg(0) & 0x7fffffff, MmFreeContiguousMemory: c => { this.free(c.arg(0) & 0x7fffffff); return 0; },
      MmPersistContiguousMemory: () => 0, MmSetAddressProtect: () => 0, AvSetDisplayMode: () => 0, AvGetSavedDataAddress: () => 0,
      NtAllocateVirtualMemory: c => { const a = this.alloc(m.r32(c.arg(2))); m.w32(c.arg(0), a); return 0; },
      // time runs with the emulated machine (game clock + CPU time at 733 MHz), not the host's clock: code that waits
      // for an amount of time then takes the same number of instructions however fast the emulator runs
      KeQuerySystemTime: c => { const t = BigInt(Math.floor((this.bootDate ??= (process.env.NT04_BOOT_DATE ? Date.parse(process.env.NT04_BOOT_DATE) : Date.now())) + this.emuMs())) * 10000n + 116444736000000000n; m.w32(c.arg(0), Number(t & 0xffffffffn)); m.w32(c.arg(0) + 4, Number(t >> 32n)); return 0; },
      KeQueryInterruptTime: () => Math.floor(this.emuMs() * 10000) >>> 0,
      KeRaiseIrqlToDpcLevel: () => 0, KfRaiseIrql: () => 0, ExQueryNonVolatileSetting: c => this.nonVolatileSetting(c.arg(0) >>> 0, c.arg(1), c.arg(2), c.arg(3) >>> 0, c.arg(4)),
      // files and symbolic links: xbox-fs.mjs on the disc folder and the save folder
      NtCreateFile: c => fs.create(args(c, 9)), NtOpenFile: c => fs.open(args(c, 6)), NtClose: c => fs.handles.has(c.arg(0)) ? fs.close(c.arg(0)) : 0,
      NtReadFile: c => fs.read(args(c, 8)), NtWriteFile: c => fs.write(args(c, 8)),
      NtQueryInformationFile: c => fs.queryInfo(args(c, 5)), NtSetInformationFile: c => fs.setInfo(args(c, 5)),
      NtQueryFullAttributesFile: c => fs.fullAttributes(args(c, 2)), NtQueryDirectoryFile: c => fs.queryDirectory(args(c, 10)),
      NtQueryVolumeInformationFile: c => fs.queryVolume(args(c, 5)), NtFlushBuffersFile: c => fs.io(c.arg(1), 0),
      IoCreateSymbolicLink: c => fs.createLink(args(c, 2)), IoDeleteSymbolicLink: c => fs.deleteLink(args(c, 1)),
      NtOpenSymbolicLinkObject: c => fs.openLink(args(c, 2)), NtQuerySymbolicLinkObject: c => fs.queryLink(args(c, 3)),
      RtlInitAnsiString: c => { const d = c.arg(0), src = c.arg(1), n = src ? m.cstr(src).length : 0; m.w16(d, n); m.w16(d + 2, src ? n + 1 : 0); m.w32(d + 4, src); return 0; },
      RtlNtStatusToDosError: c => dosError(c.arg(0)),
      // TIME_FIELDS {u16 year, month, day, hour, minute, second, milliseconds, weekday} <-> 100 ns since 1601
      RtlTimeToTimeFields: c => { const t = (BigInt(m.r32(c.arg(0) + 4)) << 32n) | BigInt(m.r32(c.arg(0)));
        const d = new Date(Number((t - 116444736000000000n) / 10000n)), f = c.arg(1);
        [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds(), d.getUTCDay()]
          .forEach((v, i) => m.w16(f + i * 2, v)); return 0; },
      RtlTimeFieldsToTime: c => { const f = c.arg(0), g = i => m.r16(f + i * 2);
        const ms = Date.UTC(g(0), g(1) - 1, g(2), g(3), g(4), g(5), g(6)); if (Number.isNaN(ms)) return 0;
        const t = BigInt(ms) * 10000n + 116444736000000000n; m.w32(c.arg(1), Number(t & 0xffffffffn)); m.w32(c.arg(1) + 4, Number(t >> 32n)); return 1; },
      // SHA-1 / HMAC-SHA1 (save signatures: XCalculateSignature*). The signature keys (XboxSignatureKey, the
      // certificate's keys) are the zero/stand-in values here, so signatures match our own saves only.
      XcSHAInit: c => { if (process.env.NT04_TRACE_SIG) console.error(`SHAInit ${c.arg(0).toString(16)}`); sha.set(c.arg(0), []); return 0; },
      XcSHAUpdate: c => { if (process.env.NT04_TRACE_SIG) console.error(`SHAUpdate ${c.arg(0).toString(16)} ${c.arg(2)} known ${sha.has(c.arg(0))} ${process.env.NT04_TRACE_SIG === "2" ? Buffer.from(m.readBytes(c.arg(1), c.arg(2))).toString("hex") : ""}`); (sha.get(c.arg(0)) ?? sha.set(c.arg(0), []).get(c.arg(0))).push(m.readBytes(c.arg(1), c.arg(2))); return 0; },
      XcSHAFinal: c => { const h = createHash("sha1"); for (const b of sha.get(c.arg(0)) ?? []) h.update(b); if (process.env.NT04_TRACE_SIG) this.log(`XcSHAFinal parts ${(sha.get(c.arg(0)) ?? []).map(b => b.length).join("+")}`); sha.delete(c.arg(0)); const dg = h.digest(); if (process.env.NT04_TRACE_SIG) console.error(`SHAFinal ${c.arg(0).toString(16)} ${dg.toString("hex")}`); m.writeBytes(c.arg(1), dg); return 0; },
      XcHMAC: c => { if (process.env.NT04_TRACE_SIG) this.log(`XcHMAC key ${Buffer.from(m.readBytes(c.arg(0), c.arg(1))).toString("hex")} d1 ${c.arg(3)} ${Buffer.from(m.readBytes(c.arg(2), Math.min(c.arg(3), 24))).toString("hex")} d2 ${c.arg(5)}`); const h = createHmac("sha1", m.readBytes(c.arg(0), c.arg(1)));
        if (c.arg(2)) h.update(m.readBytes(c.arg(2), c.arg(3))); if (c.arg(4)) h.update(m.readBytes(c.arg(4), c.arg(5))); m.writeBytes(c.arg(6), h.digest()); return 0; },
      // dispatcher objects and threads: xbox-threads.mjs (cooperative threads on the one CPU)
      NtCreateEvent: c => { const o = th().create(c.arg(2) ? 1 : 0, c.arg(3) & 0xff ? 1 : 0); if (c.arg(0)) m.w32(c.arg(0), o.handle); return 0; },
      NtSetEvent: c => { const p = th().set(th().header(c.arg(0)), 1); if (c.arg(1)) m.w32(c.arg(1), p); return 0; },
      NtPulseEvent: c => { th().pulse(th().header(c.arg(0))); return 0; },
      KeSetEvent: c => th().set(c.arg(0), 1),
      NtCreateSemaphore: c => { const o = th().create(5, c.arg(2) | 0, { limit: c.arg(3) | 0 }); if (c.arg(0)) m.w32(c.arg(0), o.handle); return 0; },
      NtReleaseSemaphore: c => { const p = th().releaseSemaphore(th().header(c.arg(0)), c.arg(1) | 0); if (c.arg(2)) m.w32(c.arg(2), p); return 0; },
      NtCreateMutant: c => { const own = c.arg(2) & 0xff, o = th().create(2, own ? 0 : 1, own ? { owner: th().current, recursion: 1 } : {}); if (c.arg(0)) m.w32(c.arg(0), o.handle); return 0; },
      NtReleaseMutant: c => { th().releaseMutant(th().header(c.arg(0))); if (c.arg(1)) m.w32(c.arg(1), 0); return 0; },
      NtWaitForSingleObject: c => th().wait([th().header(c.arg(0))], true, timeout(c.arg(2)), c),
      NtWaitForSingleObjectEx: c => th().wait([th().header(c.arg(0))], true, timeout(c.arg(3)), c),
      KeWaitForSingleObject: c => th().wait([c.arg(0)], true, timeout(c.arg(4)), c),
      KeWaitForMultipleObjects: c => { const n = c.arg(0), a = c.arg(1), objs = Array.from({ length: n }, (_, i) => m.r32(a + i * 4));
        return th().wait(objs, c.arg(2) === 0, timeout(c.arg(6)), c); },
      KeDelayExecutionThread: c => th().sleep(timeout(c.arg(2)), c),
      PsCreateSystemThreadEx: c => { const t = th().createThread({ start: c.arg(9), ctx1: c.arg(5), ctx2: c.arg(6), suspended: c.arg(7) & 0xff });
        if (c.arg(0)) m.w32(c.arg(0), t.handle); if (c.arg(4)) m.w32(c.arg(4), t.id); return 0; },
      PsTerminateSystemThread: c => { const t = th().current; if (t) { t.exitRequested = true; c.yieldNow = true; } return 0; },
      NtSuspendThread: c => { const t = th().list.find(x => x.handle === c.arg(0)); if (t) t.suspended = true; if (c.arg(1)) m.w32(c.arg(1), 0); return 0; },
      NtResumeThread: c => { const t = th().list.find(x => x.handle === c.arg(0)); if (t) t.suspended = false; if (c.arg(1)) m.w32(c.arg(1), 1); return 0; },
      ObReferenceObjectByHandle: c => { if (c.arg(2)) m.w32(c.arg(2), th().header(c.arg(0))); return 0; },
    };
    for (const line of csv) {
      const [thunk, ord, name, bytes, kind] = line.split(","), slot = parseInt(thunk, 16), clean = name.replace(/^@/, "");
      if (kind !== "function") { m.w32(slot, data); data += 0x100; continue; }
      const a = next; next += 4; m.w32(slot, a);
      const pops = +bytes || 0, f = impl[clean];
      this.hooks.set(a, c => { this.note(a, `kernel ${clean}`); const v = f ? f(c) : 0; if (this.traceKernel) this.log(`kernel ${clean} -> 0x${((v ?? 0) >>> 0).toString(16)}`); c.r[4] += name.startsWith("@") ? 0 : pops; return v; });
    }
  }
  // Replace a function: returns `value`, pops the callee's stack arguments like the original.
  stub(a, what, value = 0) { const n = POPS["0x" + a.toString(16)] ?? 0;
    this.hooks.set(a, c => { this.note(a, what); const v = typeof value === "function" ? value(c) : value; c.r[4] += n; return v; }); }
  note(a, what) { const k = `0x${a.toString(16)} ${what}`; this.unknown.set(k, (this.unknown.get(k) || 0) + 1); }
  // heap blocks: header at p-16 = { u32 class size, u32 magic }; sizes round to 16 bytes (to 4 KB above 64 KB)
  alloc(n) {
    n >>>= 0; const size = n <= 0x10000 ? (n + 15) & ~15 || 16 : (n + 0xfff) & ~0xfff, list = this.freeLists.get(size);
    let a;
    if (list?.length) a = list.pop();
    else { a = this.heapTop + 16; if (a + size > HEAP_BASE + HEAP_SIZE) throw new Error(`heap full (0x${(this.heapLive >>> 0).toString(16)} bytes live, asking 0x${n.toString(16)}); call stack ${this.cpu.callStack()}`);
      this.heapTop = a + size; this.mem.w32(a - 16, size); this.mem.w32(a - 12, 0x48454150); }
    this.mem.w32(a - 8, 1); this.heapLive += size; this.heap.buf.fill(0, a - HEAP_BASE, a - HEAP_BASE + size); return a;
  }
  free(p) {
    if (process.env.NT04_NO_FREE) return;
    p >>>= 0; if (p < HEAP_BASE + 16 || p >= this.heapTop || this.mem.r32(p - 12) !== 0x48454150 || this.mem.r32(p - 8) !== 1) return;   // not ours, or already free
    const size = this.mem.r32(p - 16); this.mem.w32(p - 8, 0); this.heapLive -= size;
    let list = this.freeLists.get(size); if (!list) this.freeLists.set(size, list = []); list.push(p);
  }

  // printf-style formatting with cdecl varargs starting at stack address `ap`
  sprintf(fmt, ap) {
    const m = this.mem;
    return fmt.replace(/%([-+ 0#]*)(\d*)(?:\.(\d+))?(h|l|ll|I64)?([diuxXcsfeEgGp%])/g, (all, flags, width, prec, len, t) => {
      if (t === "%") return "%";
      let s;
      if ("feEgG".includes(t)) { const lo = m.r32(ap), hi = m.r32(ap + 4); ap += 8;
        const dv = new DataView(new ArrayBuffer(8)); dv.setUint32(0, lo, true); dv.setUint32(4, hi, true); const v = dv.getFloat64(0, true);
        const p = prec !== undefined ? +prec : 6; s = t === "f" ? v.toFixed(p) : "eE".includes(t) ? v.toExponential(p) : String(+v.toPrecision(p || 1)); }
      else { const a = m.r32(ap); ap += 4;
        switch (t) { case "d": case "i": s = String(a | 0); if (flags.includes("+") && (a | 0) >= 0) s = "+" + s; break; case "u": s = String(a >>> 0); break;
          case "x": case "p": s = (a >>> 0).toString(16); break; case "X": s = (a >>> 0).toString(16).toUpperCase(); break;
          case "c": s = String.fromCharCode(a & 0xff); break; case "s": s = a ? m.cstr(a) : "(null)"; if (prec !== undefined) s = s.slice(0, +prec); break; }
        if (prec !== undefined && "diuxX".includes(t)) s = s.padStart(+prec, "0"); }
      const w = +width || 0; if (s.length < w) s = flags.includes("-") ? s.padEnd(w) : s.padStart(w, flags.includes("0") && !"sc".includes(t) ? "0" : " ");
      return s;
    });
  }

  // ---------------------------------------------------------------- 0x1471D0: run a query
  // Parameters are the placeholders in order: "into" ones are pointers that receive values; others are values
  // (int-promoted; a float input is a double = 8 bytes); a cursor is a pointer to the game's cursor struct whose
  // u16 at +4 is the row the next fetch reads. Returns 0, or 0x17 when a select or cursor finds no row (0x15 at the
  // end of a cursor). The status
  // struct (first argument, may be 0) receives the row count in its first u16.
  // Added tracks (config.addedTracks) in the constants block (0x5E0E0): its per-track (AICA, ZBIA), per-home-track
  // (PTSF) and per-race (AIFW, AITW, AIWS, PTRF) tables have rows for the game's own ids only (CNST_ID_ROWS) and are
  // read at fixed offsets, so an added track's id would read past its table. The sites that index them get the base
  // track's id instead: they take it from the getters 0xDA7A0 (track, [0x2DD4B8]) / 0xDA7B0 (home track, [0x2DD4B9])
  // just before (told apart by return address; every other caller gets the real id), and the AI set-up 0x12B60 reads
  // the race id from [0x28A56C], filled by "select RAID from GINF" at 0x132B4 (its getter 0x13750 serves the block
  // read at 0x1ED20 and two others, which keep the real id).
  cnstIdMap() {
    const sig = JSON.stringify(this.config?.addedTracks ?? []); if (this._cnstMap?.sig === sig) return this._cnstMap;
    const map = { sig, trid: new Map(), tphd: new Map(), raid: new Map() }, T = this.db?.tables.get("TRCK")?.rows ?? [];
    for (const tk of this.config?.addedTracks ?? []) { const b = tk.base ?? {}, i = tk.ids ?? {}, bt = T.find(r => r.TRID === b.trid);
      if (Number.isInteger(i.trid) && Number.isInteger(b.trid)) map.trid.set(i.trid, b.trid);
      if (Number.isInteger(i.tphd) && bt) map.tphd.set(i.tphd, bt.TPHD);
      if (Number.isInteger(i.raid) && Number.isInteger(b.raid)) map.raid.set(i.raid, b.raid); }
    if (T.length) this._cnstMap = map; return map;
  }
  // Walls near a collision triangle (built at load, 0xD64F0: up to 7 u8 ids per triangle in the 10-byte records at
  // [0x2DD4B0]) count across the section's three wall lists: kind-6 walls (+0x40 / list +0x50), then kind-5 (+0x42 /
  // +0x54), then kind-4 (+0x3E / +0x58). The ids are worked out against one section, but a triangle listed in two
  // neighbouring sections (the files repeat the triangles at section overlaps) can be looked up through the other one
  // (0xD71C0: 0xD7180 id -> wall, 0xD6470 id -> kind / index); an id past that section's walls then reads past its
  // lists and the car's wall tracker gets a garbage plane (a car pushed out of a "wall" thousands of feet away). That
  // stays harmless at the stock tracks (their ids happen to stay in range); an added layout with other distances to the
  // walls (the nearest wall on the far side) hits it. Out-of-range ids are taken as the section's last wall, the same
  // wall 0xD64F0 itself falls back to when none is near.
  // The collision set-up at race load (0xD6F50, per section) is quadratic: 0xD6C20 runs 0xD67C0 for every racing-
  // surface triangle against the section's whole apron list and back (6 point-in-triangle + 9 edge-crossing tests a
  // pair; the result is two flag bits in the triangle's +0x25), and 0xD64F0 runs 0xD6220 for every triangle against
  // every wall of the section. Fine at the stock tracks (~60 triangles a section); a generated layout has a few
  // hundred, which ran ~5-50 billion instructions (past the step limit: the set-up stopped after section 0 and the
  // walls near each triangle were never worked out). Only overlapping pairs can pass those tests, so: 0xD67C0 gets the
  // other list cut down to the triangles whose box meets this one's (0.5 ft slack; copied to a scratch list; the bits
  // are OR-ed, so order does not matter), and 0xD6220 answers "no" at once for a wall more than 9 ft outside the
  // triangle's box (it takes walls crossing the triangle, within 8 ft of an edge (0xD61B0), or crossing once moved
  // 8 ft toward the triangle's middle). Short lists (the stock tracks) go through untouched.
  // 0xE9A50: the point of a section's quadratic curve nearest a point (the fallback of 0xE9F70 when its Newton steps,
  // 0xE9C50, do not settle): it narrows [lo, hi] around the nearer of B(mid -+ step), step = max(0.1 (hi - lo),
  // 0.001), and stops only once B(mid + step) and B(mid - step) are within the tolerance (1/24 ft from 0xE9F70). With
  // the 0.001 floor that needs a curve shorter than ~21 ft, so on a longer one it never stops. The stock tracks never
  // reach it with such a curve; added layouts did (race loading, from 0xDB870 via 0xE9F70: the step limit cut the
  // loading tick and the race started half set up). Same search here, but it also stops after 64 rounds.
  // Registers: edx the curve (3 points, x y z f32, stride 12), edi the point (x, y), ecx where B(t) goes (x y z, 0);
  // args: tolerance (f32), &t. Leaves the signed sideways distance ((p - B) x dir) on the x87 stack.
  // 0x132EA0(stage, pass state, pass textures): one pass of a material (0x133470 walks the shader's passes, [shader+0x20],
  // over the instance's records at [instance+0x10]). At added tracks a 4-pass material sometimes had records of
  // 0xFF000000 (memory left over, by the look of it: an opaque black colour), and 0x131A10 read the sampler states
  // through them ("bad address 0xff000004", the race loading cut short). Whether it happened moved with the pack model's
  // size, its tiling and the physics: heap layout; the material is not the pack's (those are single pass). A record in
  // the hardware range (0xF0000000 up: GPU registers, flash) is passed as none, which the function skips.
  textureGuardHook() {
    if (!this.config?.addedTracks?.length || process.env.NT04_NO_TEX_GUARD) return;
    const m = this.mem; let n = 0;
    this.hooks.set(0x132ea0, (c, ret) => { c.push(ret); const sp = c.r[4] >>> 0;
      for (const o of [8, 12]) { const v = m.r32(sp + o) >>> 0; if (v >= 0xf0000000) { m.w32(sp + o, 0); if (n++ < 3) this.log?.(`material pass ${m.r32(sp + 4)}: record 0x${v.toString(16)} in the hardware range, skipped`); } }
      c.passThrough = 0x132ea0; c.hookReturn = 0x132ea0; return undefined; });
  }
  curveNearestHook() {
    if (!this.config?.addedTracks?.length || process.env.NT04_NO_CURVE_FIX) return;
    const m = this.mem, F = new Float32Array(1), U = new Uint32Array(F.buffer), f = a => { U[0] = m.r32(a); return F[0]; }, wf = (a, v) => { F[0] = v; m.w32(a, U[0]); };
    this.hooks.set(0xe9a50, c => {
      const cv = c.r[2] >>> 0, pt = c.r[7] >>> 0, out = c.r[1] >>> 0; U[0] = c.arg(0); const tol = F[0], tol2 = tol * tol, tOut = c.arg(1) >>> 0;
      const P = [0, 1, 2].map(k => [f(cv + 12 * k), f(cv + 12 * k + 4), f(cv + 12 * k + 8)]), px = f(pt), py = f(pt + 4);
      const B = t => { const u = 1 - t, a = u * u, b = 2 * t * u, d = t * t; return [0, 1, 2].map(j => a * P[0][j] + b * P[1][j] + d * P[2][j]); };
      let lo = 0, hi = 1, b1, b2, mid;
      for (let i = 0; ; i++) {
        mid = (hi + lo) * 0.5; const step = Math.max((hi - lo) * 0.1, 0.001); b1 = B(mid - step); b2 = B(mid + step);
        if (i > 6 && ((b2[0] - b1[0]) ** 2 + (b2[1] - b1[1]) ** 2 <= tol2 || i >= 64)) break;
        if ((px - b1[0]) ** 2 + (py - b1[1]) ** 2 < (px - b2[0]) ** 2 + (py - b2[1]) ** 2) hi = mid; else lo = mid;
      }
      const t = Math.min(1, Math.max(0, mid)), q = B(t); wf(tOut, t); wf(out, q[0]); wf(out + 4, q[1]); wf(out + 8, q[2]); m.w32(out + 12, 0);
      const dx = b2[0] - b1[0], dy = b2[1] - b1[1], inv = 1 / (Math.hypot(dx, dy) || 1);
      c.fpush(((px - q[0]) * dy - (py - q[1]) * dx) * inv);
    });
  }
  collisionSetupHooks() {
    if (!this.config?.addedTracks?.length || process.env.NT04_NO_COLL_CULL) return;
    const m = this.mem, F = new Float32Array(1), U = new Uint32Array(F.buffer), f = a => { U[0] = m.r32(a); return F[0]; }, E = 0.5;
    const vtab = () => m.r32(m.r32(0x2f33a4) + 0x160) >>> 0, vx = (vt, i) => f(vt + i * 8), vy = (vt, i) => f(vt + i * 8 + 4);
    const box = (vt, t) => { const a = m.r16(t), b = m.r16(t + 2), c = m.r16(t + 4), xs = [vx(vt, a), vx(vt, b), vx(vt, c)], ys = [vy(vt, a), vy(vt, b), vy(vt, c)];
      return [Math.min(...xs) - E, Math.min(...ys) - E, Math.max(...xs) + E, Math.max(...ys) + E]; };
    const boxes = new Map(); let scratch = 0, cap = 0;
    const o67 = this.hooks.get(0xd67c0);
    this.hooks.set(0xd67c0, (c, ret) => { const n = c.r[1] | 0, list = c.arg(1) >>> 0;
      if (n > 48) { const vt = vtab(); let B = boxes.get(list); if (!B || B.n !== n) { B = { n, b: [] }; for (let i = 0; i < n; i++) B.b.push(box(vt, list + i * 0x28)); boxes.set(list, B); }
        const me = box(vt, c.arg(0) >>> 0), keep = [];
        for (let i = 0; i < n; i++) { const q = B.b[i]; if (q[0] <= me[2] && q[2] >= me[0] && q[1] <= me[3] && q[3] >= me[1]) keep.push(i); }
        if (keep.length > cap) { cap = Math.max(keep.length, 256) * 2; scratch = this.alloc(cap * 0x28); }
        keep.forEach((i, k) => m.writeBytes(scratch + k * 0x28, m.readBytes(list + i * 0x28, 0x28)));
        m.w32(c.r[4] + 4, scratch); c.r[1] = keep.length; }
      if (o67) return o67(c, ret); c.push(ret); c.passThrough = 0xd67c0; c.hookReturn = 0xd67c0; return undefined; });
    // 0xD64F0(ecx = triangle list, count; ebx = section): the walls near each triangle, as the game does it (kind-4,
    // kind-6, kind-5 lists in order; up to 7 kept, as section-wide ids (0xD64C0); none near: the last wall looked at;
    // more than 7: none kept) but with 0xD6220 asked only for walls within 9 ft of the triangle's box
    const ptab = () => m.r32(m.r32(0x2f33a4) + 0x168) >>> 0, wallBoxes = new Map();
    const o64 = this.hooks.get(0xd64f0);
    this.hooks.set(0xd64f0, (c, ret) => { const list = c.r[1] >>> 0, n = c.arg(0) | 0, sec = c.r[3] >>> 0;
      const lists = [[4, m.r16(sec + 0x3e), m.r32(sec + 0x58) >>> 0], [6, m.r16(sec + 0x40), m.r32(sec + 0x50) >>> 0], [5, m.r16(sec + 0x42), m.r32(sec + 0x54) >>> 0]];
      if (n <= 48 && lists.reduce((a, l) => a + l[1], 0) <= 48) { if (o64) return o64(c, ret); c.push(ret); c.passThrough = 0xd64f0; c.hookReturn = 0xd64f0; return undefined; }
      const vt = vtab(), pt = ptab(), tab = m.r32(0x2dd4b0) >>> 0, n6 = m.r8(sec + 0x40), n5 = m.r8(sec + 0x42);
      let WB = wallBoxes.get(sec); if (!WB) { WB = lists.map(([, cnt, lp]) => { const b = []; for (let i = 0; i < cnt; i++) { const w = lp + i * 0x2c, i0 = m.r16(w + 4), i1 = m.r16(w + 6), x0 = f(pt + i0 * 12), y0 = f(pt + i0 * 12 + 4), x1 = f(pt + i1 * 12), y1 = f(pt + i1 * 12 + 4);
        b.push([Math.min(x0, x1) - 9, Math.min(y0, y1) - 9, Math.max(x0, x1) + 9, Math.max(y0, y1) + 9]); } return b; }); wallBoxes.set(sec, WB); }
      const id = (type, i) => (type === 6 ? i : type === 5 ? n6 + i : type === 4 ? m.r8(sec + 0x42) + n6 + i : 0xff) & 0xff;
      for (let t = 0; t < n; t++) { const tri = list + t * 0x28, me = box(vt, tri), found = []; let last = null;
        lists.forEach(([type, cnt, lp], li) => { if (!cnt) return; last = [type, cnt - 1];
          for (let i = 0; i < cnt; i++) { const q = WB[li][i]; if (q[0] > me[2] || q[2] < me[0] || q[1] > me[3] || q[3] < me[1]) continue;
            if (this.nested(0xd6220, [tri], { edx: lp + i * 0x2c }) & 0xff) found.push([type, i]); } });
        if (!found.length && last) found.push(last);
        const e = tab + m.r16(tri + 0x26) * 10; m.w8(e + 2, 0); for (let k = 3; k < 10; k++) m.w8(e + k, 0xff);
        const cnt = found.length & 0xff; if (cnt >= 1 && cnt <= 7) { found.forEach(([type, i], k) => m.w8(e + 3 + k, id(type, i))); m.w8(e + 2, cnt); } }
      return 0; });
    const o62 = this.hooks.get(0xd6220);
    this.hooks.set(0xd6220, (c, ret) => { const t = c.arg(0) >>> 0, w = c.r[2] >>> 0, vt = vtab(), pt = ptab(), me = box(vt, t), i0 = m.r16(w + 4), i1 = m.r16(w + 6);
      const x0 = f(pt + i0 * 12), y0 = f(pt + i0 * 12 + 4), x1 = f(pt + i1 * 12), y1 = f(pt + i1 * 12 + 4);
      if (Math.max(x0, x1) < me[0] - 9 || Math.min(x0, x1) > me[2] + 9 || Math.max(y0, y1) < me[1] - 9 || Math.min(y0, y1) > me[3] + 9) return 0;
      if (o62) return o62(c, ret); c.push(ret); c.passThrough = 0xd6220; c.hookReturn = 0xd6220; return undefined; });
  }
  wallIdHooks() {
    if (!this.config?.addedTracks?.length || process.env.NT04_NO_WALLCLAMP) return;
    const m = this.mem, total = s => m.r16(s + 0x3e) + m.r16(s + 0x40) + m.r16(s + 0x42);
    const clamp = (s, id) => { const n = total(s); if (id < n || n === 0) return id; this.wallIdClamped = (this.wallIdClamped ?? 0) + 1; return n - 1; };
    this.hooks.set(0xd7180, c => { const s = c.r[2] >>> 0, id = clamp(s, c.r[0] >>> 0), n6 = m.r16(s + 0x40), n5 = m.r16(s + 0x42);
      if (id < n6) return (m.r32(s + 0x50) + id * 0x2c) >>> 0; if (id < n6 + n5) return (m.r32(s + 0x54) + (id - n6) * 0x2c) >>> 0; return (m.r32(s + 0x58) + (id - n6 - n5) * 0x2c) >>> 0; });
    this.hooks.set(0xd6470, c => { const s = c.r[1] >>> 0, id = clamp(s, c.r[0] & 0xff), n6 = m.r16(s + 0x40), n5 = m.r16(s + 0x42), out = c.r[7] >>> 0, idx = c.r[6] >>> 0;
      const [kind, i] = id < n6 ? [6, id] : id < n6 + n5 ? [5, id - n6] : [4, id - n6 - n5]; m.w32(out, kind); m.w8(idx, i & 0xff); return (c.r[0] & ~0xff | (i & 0xff)) >>> 0; });
  }
  cnstIdHooks() {
    const m = this.mem, TRID_SITES = new Set([0x1f50e, 0x27ffa, 0x28013, 0x28068, 0x318cf, 0xab83b, 0xad670, 0xad6ff, 0xae0c6, 0xae1cd, 0xb9077, 0xba0ec, 0xba113, 0xba185, 0xbcc03, 0xd1947, 0xefe60]),
      TPHD_SITES = new Set([0x30454, 0x511ca, 0x513b5, 0x53511]);
    if (!this.config?.addedTracks?.length) return;
    this.hooks.set(0xda7a0, (c, ret) => { const v = m.r8(0x2dd4b8); return TRID_SITES.has(ret >>> 0) ? this.cnstIdMap().trid.get(v) ?? v : v; });
    this.hooks.set(0xda7b0, (c, ret) => { const v = m.r8(0x2dd4b9); return TPHD_SITES.has(ret >>> 0) ? this.cnstIdMap().tphd.get(v) ?? v : v; });
    this.hooks.set(0x13750, (c, ret) => { const v = m.r16(0x28a56c); return (ret >>> 0) === 0x1ed25 ? v : this._cnstRealRaid ?? v; });
  }
  cnstRaceId() {
    if (!this.config?.addedTracks?.length) return; const v = this.mem.r16(0x28a56c), b = this.cnstIdMap().raid.get(v);
    this._cnstRealRaid = v; if (b !== undefined) this.mem.w16(0x28a56c, b);
  }
  query(c) {
    const m = this.mem, status = c.arg(0), text = m.cstr(c.arg(1));
    let info = this.parsed.get(text);
    if (!info) {
      const params = []; let prev = "";
      for (let i = 0; i < text.length; i++) { const ch = text.charCodeAt(i);
        if (ch >= 0x80 && ch <= 0x8e) { params.push({ type: ch, out: /into\s*$/.test(prev) && !/insert\s+into\s*$/.test(prev) }); prev = ""; } else prev += text[i]; }
      let ast = null; try { ast = parseQuery(text, { reversedNames: true }); } catch (e) { this.log(`query parse failed: ${e.message}`); }
      info = { params, ast }; this.parsed.set(text, info);
    }
    if (!info.ast || !this.db) return 0x17;
    let ap = c.r[4] + 8; const vals = [], outs = [];
    for (const p of info.params) {
      if (p.type === 0x86 && !p.out) { const dv = new DataView(new ArrayBuffer(8)); dv.setUint32(0, m.r32(ap), true); dv.setUint32(4, m.r32(ap + 4), true); vals.push(dv.getFloat64(0, true)); ap += 8; continue; }
      const v = m.r32(ap); ap += 4;
      if (p.out) { vals.push(null); outs.push({ ptr: v, type: p.type, i: vals.length - 1 }); continue; }
      switch (p.type) {
        case 0x80: vals.push((v << 24) >> 24); break; case 0x81: vals.push((v << 16) >> 16); break; case 0x82: vals.push(v | 0); break;
        case 0x83: vals.push(v & 0xff); break; case 0x84: vals.push(v & 0xffff); break; case 0x85: vals.push(v >>> 0); break;
        case 0x88: vals.push(m.cstr(v)); break;
        case 0x8a: vals.push(v); break;                                     // cursor struct address (resolved below)
        // a name parameter is a 4-char code in memory order holding the real table name; the engine expects names
        // reversed as in the query text, so it is passed reversed
        case 0x8c: vals.push(String.fromCharCode(v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff).replace(/^\0+/, "")); break;
        case 0x8e: vals.push(v); break;
        default: vals.push(v | 0);
      }
    }
    const ast = info.ast; let res, count = 0, found = true;
    try {
      if (ast.kind === "createCursor") {
        const at = vals[ast.cursorParam]; vals[ast.cursorParam] = null;
        res = this.db.exec(ast, vals, { reversedNames: true });
        this.cursors.set(at, res.cursor); m.w16(at + 4, 0); count = res.cursor.ctxs.length;
        // the engine also puts a cursor handle (1..255, its open-cursor list) in the struct's first word, which the
        // structured fetch 0x1481C0 takes (below)
        const id = this.cursorIdNext = (this.cursorIdNext ?? 0) % 0xffff + 1;
        (this.cursorIds ??= new Map()).set(id, { cur: res.cursor, pos: 0 }); m.w32(at, id);
        // an empty cursor is "no row" (0x17) like an empty select: 0xD4760 (a driver's track highlight for the race
        // intro speech) only fetches when the declare succeeded; with 0 here it fetched from the empty cursor, kept its
        // uninitialised HLID and the announcer talked about another driver (HLID 0 = Johnny Benson's)
        found = count > 0;
      } else if (ast.kind === "fetch") {
        const at = vals[ast.cursorParam];
        // a copy of the cursor struct (the off-season report 0x95DE0 hands its cursor to 0x95BD0 by value) is found by
        // the handle in its first word; it keeps its own row position at +4
        let cur = this.cursors.get(at);
        if (!cur) { const h = this.cursorIds?.get(m.r32(at)); if (h) { cur = h.cur; this.cursors.set(at, cur); } }
        if (!cur) { this.log(`fetch from unknown cursor 0x${(at >>> 0).toString(16)}`); return 0x17; }
        cur.pos = m.r16(at + 4); vals[ast.cursorParam] = cur;
        res = this.db.exec(ast, vals, { reversedNames: true }); m.w16(at + 4, cur.pos);
        found = !res.done; count = found ? 1 : 0; if (!found) return 0x15;   // end of cursor
      } else {
        // config careerSchedules: a career's schedule choice (12 / 24 / 36 races: SCHD 0 / 1 / 2, shared with seasons)
        // goes to the career's own schedules 4 / 5 / 6. The settings screens write the choice with "update GINF set
        // SCID = ? ..."; in career mode (GINF.GMOD 2) the value is moved up by 4, and everything after reads GINF.SCID.
        if (this.config?.careerSchedules && ast.kind === "update" && /^update 'FNIG' set 'DICS' = [\x80-\x8e]/.test(text) && vals[0] >= 0 && vals[0] <= 2 && this.db.tables.get("GINF")?.rows[0]?.GMOD === 2) vals[0] += 4;
        res = this.db.exec(ast, vals, { reversedNames: true });
        if (ast.kind === "select") { count = res.rows.length; found = count > 0 || ast.cols?.some(c => c.col.agg); }
        else count = res.changed ?? 0;
      }
    } catch (e) { const k = `${e.message}: ${text.slice(0, 100)}`; this.failed ??= new Map();
      if (!this.failed.has(k)) this.log(`query failed: ${k} (values ${JSON.stringify(vals.map(v => typeof v === "object" ? null : v))})`);
      this.failed.set(k, (this.failed.get(k) || 0) + 1); return 0x17; }
    if (found) for (const o of outs) this.writeOut(o, res.outputs?.[o.i]);
    if (status) { m.w16(status, count); m.w16(status + 2, 0); m.w32(status + 4, 0); m.w32(status + 8, 0); }
    return found ? 0 : 0x17;
  }
  writeOut({ ptr, type }, v) {
    const m = this.mem; if (!ptr || v === undefined || v === null) return;
    switch (type) {
      case 0x80: case 0x83: m.w8(ptr, v); break;
      case 0x81: case 0x84: m.w16(ptr, v); break;
      case 0x86: m.wf(ptr, v); break;
      case 0x88: { const s = String(v); m.wstr(ptr, s, s.length); break; }
      default: m.w32(ptr, typeof v === "number" ? v : Number(v) || 0);
    }
  }

  // ---------------------------------------------------------------- entry points
  reset() { this.cpu.r.fill(0); this.cpu.esp = STACK_TOP - 0x4000; this.cpu.ftop = 0; }
  // Per-screen handler (0x78820: cx = group, ax = screen, edx = result*, stack id, -, args*). Returns
  // { handled, value }.
  // UI natives can run while a game thread is stopped mid-function (preempted between frames) with its registers
  // and x87 stack still in the CPU: the whole CPU state is saved around the call and put back after it.
  isolated(f) { const c = this.cpu, ctx = c.saveCtx(), fl = c.flags; try { this.reset(); c.esp = UI_STACK - 0x10; return f(); } finally { c.loadCtx(ctx); c.flags = fl; } }
  perScreen(group, screen, id, args) { return this.isolated(() => this.perScreen0(group, screen, id, args)); }
  // a UI screen object's handler from the game (UIStudio object types, registered at 0x756B4): cdecl
  // handler(obj, msg, argc, args*, ret*), used for the sound (1, 0x9AC40) and audio / music (4, 0x9AB70) objects
  uiObject(addr, obj, msg, args = []) {
    return this.isolated(() => {
      const m = this.mem, argp = SCRATCH + 0x100, resp = SCRATCH;
      args.forEach((a, i) => m.w32(argp + i * 4, a)); m.w32(resp, 0);
      try { this.cpu.call(addr, [obj, msg >>> 0, args.length, argp, resp]); } catch (e) { this.log(`UI object 0x${addr.toString(16)} msg ${msg}: ${e.message.slice(0, 160)}`); }
      return m.r32(resp);
    });
  }
  global(id, args) { return this.isolated(() => this.global0(id, args)); }
  perScreen0(group, screen, id, args) {
    const m = this.mem;
    const argp = SCRATCH + 0x100, resp = SCRATCH;
    args.forEach((a, i) => m.w32(argp + i * 4, a)); m.w32(resp, 0);
    const al = this.cpu.call(0x78820, [id, 0, argp], { ecx: group, eax: screen, edx: resp }) & 0xff;
    return { handled: al !== 0, value: m.r32(resp) };
  }
  // Global switch of 0x7A6A0 for ids 0..0xF7: esi = id, ebp = args*, edi = result*; the cases end with
  // pop edi/esi/ebp/ebx, add esp,0x18, ret — so the frame is built as 0x7A6A0 leaves it.
  global0(id, args) {
    const m = this.mem, c = this.cpu;
    if (id > 0xf7) return { handled: false, value: 0 };
    const argp = SCRATCH + 0x100, resp = SCRATCH;
    args.forEach((a, i) => m.w32(argp + i * 4, a)); m.w32(resp, 0);
    const RET = 0xdead0000;
    c.push(RET); c.esp -= 0x18; c.push(0); c.push(argp); c.push(id); c.push(resp);
    c.r[6] = id; c.r[5] = argp; c.r[7] = resp; c.r[3] = 0;
    const target = m.r32(0x7ae9c + m.r8(0x7b020 + id) * 4);
    if (target === 0x7ae94) return { handled: false, value: 0 };
    c.eip = target; c.runUntil(RET);
    return { handled: true, value: m.r32(resp) };
  }
}
