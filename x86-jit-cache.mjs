// x86-jit-cache.mjs — compiled blocks kept on disk between runs (x86-jit.mjs).
//
// Compiling a block costs decode + translate + V8's own compile of the generated JavaScript (~0.3-0.6 ms each; a
// race weekend load compiles ~15,000). The generated source depends only on the game code bytes, the compiler
// itself and its options, so it is saved and reused: later runs load it instead of compiling.
//
// Layout: <dir>/<key>/ where key = hash(x86-jit.mjs source, the game image, compile options). index.json maps a
// block's start address to [chunk, slot, instruction count, guest instruction addresses]; chunk_N.js.gz holds the
// block functions of one save (a script returning an array of functions), chunk_N.bin V8's code cache for it
// (bytecode: no parsing or compiling when it is valid; written the first time a chunk is loaded; left uncompressed,
// inflating it cost more than it saved). Caches of other compiler versions / game images are removed on open.
//
// A cached block is used only if none of its instruction addresses has a hook now (blocks never run into hooked
// addresses; hooks can be added during a session). Verify mode does not use the cache.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, rmSync, statSync, promises as fsp } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { gzipSync, gunzipSync, gunzip } from "node:zlib";
import { promisify } from "node:util";
const gunzipAsync = promisify(gunzip);

const PARAMS = ["FL", "F32", "U32", "F64", "U64", "XU", "XF", "MU", "PG", "PARITY", "LB", "LDV", "LOK"];
const SAVE_EVERY = 400;                          // new blocks per chunk written during a run (the rest at exit)

// One store per cache directory, shared by every game instance in the process and saved at exit. It holds only
// plain data (index, sources not yet written), never a game's memory, so a dropped game can be collected.
const stores = new Map();
function storeFor(dir, root, log) {
  let st = stores.get(dir); if (st) return st;
  // caches of other versions go, but only once unused for 10 minutes: two processes with different compile options
  // (tests, A/B runs) otherwise deleted each other's chunks while running, leaving indexes that point at missing files
  try { for (const d of readdirSync(root)) if (/^[0-9a-f]{16}$/.test(d) && join(root, d) !== dir) {
    const idx = join(root, d, "index.json"), age = Date.now() - (existsSync(idx) ? statSync(idx).mtimeMs : 0);
    if (age > 10 * 60 * 1000) rmSync(join(root, d), { recursive: true, force: true }); } } catch {}
  st = { index: new Map(), pending: [], nextChunk: 0, log };
  try {
    if (existsSync(join(dir, "index.json"))) {
      const j = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
      for (const [k, v] of Object.entries(j.blocks)) st.index.set(+k, v);
      st.nextChunk = j.nextChunk ?? 0;
    }
  } catch (e) { log(`jit cache: index unreadable, starting empty (${e.message})`); st.index.clear(); st.nextChunk = 0; }
  if (!stores.size) process.once("exit", () => { for (const [d, x] of stores) saveStore(d, x); });
  stores.set(dir, st);
  return st;
}
function saveStore(dir, st) {
  if (!st.pending.length && !st.dirtyIndex) return;
  try {
    mkdirSync(dir, { recursive: true });
    // unique names: two game processes sharing the cache never overwrite each other's chunks (the index is
    // last-writer-wins; a lost entry is only a miss)
    const list = st.pending; st.pending = []; st.dirtyIndex = false;
    const chunk = list.length ? `${st.nextChunk++}_${process.pid.toString(36)}${Date.now().toString(36)}` : null;
    // one block per line (line i + 1 = slot i): ATS bound per block, the function expression as compiled
    const lines = list.map(b => `(() => { const ATS = ${JSON.stringify(b.ats)}; return ${b.fnExpr.replace(/\n/g, " ")}; })(),`);
    if (chunk) writeFileSync(join(dir, `chunk_${chunk}.js.gz`), gzipSync(`(function (${PARAMS.join(", ")}) { "use strict"; return [\n${lines.join("\n")}\n]; })`, { level: 3 }));
    list.forEach((b, i) => st.index.set(b.start, [chunk, i, b.n, b.ats]));
    const tmp = join(dir, `index.json.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify({ nextChunk: st.nextChunk, blocks: Object.fromEntries(st.index) }));
    renameSync(tmp, join(dir, "index.json"));
  } catch (e) { st.log(`jit cache: save failed (${e.message})`); }
}

export class JitCache {
  // parts: strings/buffers that identify everything the generated code depends on
  // lo..hi: the address range whose bytes the key covers (the game image); blocks with code elsewhere are not kept
  constructor(dir, parts, log = () => {}, lo = 0, hi = 0xffffffff) {
    this.lo = lo; this.hi = hi;
    const h = createHash("sha256"); for (const p of parts) h.update(p); h.update("\0");
    this.dir = join(dir, h.digest("hex").slice(0, 16)); this.log = log;
    this.store = storeFor(this.dir, dir, log); this.chunks = new Map(); this.srcs = new Map();     // chunks: this game's loaded block functions
    this.stats = { hits: 0, misses: 0, rejected: 0, chunksLoaded: 0, codeCacheHits: 0 };
  }
  get index() { return this.store.index; }
  // a cached block function for `start`, or null; jit supplies the free variables and the hook test
  get(start, jit) {
    const e = this.index.get(start);
    if (!e) { this.stats.misses++; return null; }
    const [chunk, slot, n, ats] = e;
    for (const a of ats) if (jit.c.hooks.has(a)) { this.stats.rejected++; return null; }
    let fns = this.chunks.get(chunk);
    // a chunk not loaded yet: loading it here (read, inflate, compile thousands of functions) took up to ~65 ms in
    // the middle of a frame. Once the game is running (lazyLoad), compile just this block instead (the caller does,
    // on null) and move the chunk to the front of the idle-time prefetch (prefetch()).
    if (fns === undefined && this.lazyLoad && !process.env.NT04_JIT_SYNC_CHUNKS) {
      this.stats.deferred = (this.stats.deferred ?? 0) + 1;
      if (!this.prefetchList) this.prefetch(jit);
      const k = this.prefetchList.indexOf(chunk); if (k > 0) { this.prefetchList.splice(k, 1); this.prefetchList.unshift(chunk); }
      return null;
    }
    if (fns === undefined) { fns = this.load(chunk, jit); this.chunks.set(chunk, fns); }
    const fn = fns?.[slot];
    if (typeof fn !== "function") {
      // unusable chunk (file missing or broken): forget the entry, so the block is compiled and saved again (add()
      // skips addresses the index already has; a dangling entry used to mean a recompile in every run, for good)
      if (fns === null) { this.index.delete(start); this.store.dirtyIndex = true; this.stats.dropped = (this.stats.dropped ?? 0) + 1; }
      this.stats.misses++; return null;
    }
    fn.n = n; fn.start = start; fn.src = this.srcs.get(chunk)?.[slot + 1]; this.stats.hits++;   // same properties, same order as a fresh compile: one hidden class for every block function
    return fn;
  }
  // load the cached chunks nobody asked for yet, in idle time (the live loop calls this while it is ahead of real
  // time), so the burst of new code at e.g. the title's START press does not load chunks synchronously mid-frame.
  // Reading and inflating a chunk happen in the background; a call only compiles a chunk whose bytes are ready (fast
  // with V8's code cache). Returns false when every chunk is loaded.
  prefetch(jit) {
    if (!this.prefetchList) { const set = new Set(); for (const e of this.index.values()) set.add(e[0]); this.prefetchList = [...set]; }
    const p = this.prefetching;
    if (p) {
      if (!p.ready) return true;                                         // still reading / inflating
      this.prefetching = null;
      if (!this.chunks.has(p.chunk) && p.src) { this.chunks.set(p.chunk, this.compile(p.chunk, p.src, p.cachedData, jit)); this.stats.prefetched = (this.stats.prefetched ?? 0) + 1; }
      return true;
    }
    while (this.prefetchList.length) {
      const chunk = this.prefetchList.shift(); if (this.chunks.has(chunk)) continue;
      const job = this.prefetching = { chunk, ready: false };
      const file = join(this.dir, `chunk_${chunk}.js.gz`), bin = join(this.dir, `chunk_${chunk}.bin`);
      Promise.all([fsp.readFile(file).then(b => gunzipAsync(b)), fsp.readFile(bin).catch(() => undefined)])
        .then(([src, cachedData]) => { job.src = src.toString("utf8"); job.cachedData = cachedData; }, () => {}).finally(() => { job.ready = true; });
      return true;
    }
    return false;
  }
  load(chunk, jit) {
    const file = join(this.dir, `chunk_${chunk}.js.gz`), bin = join(this.dir, `chunk_${chunk}.bin`);
    let src, cachedData;
    try { src = gunzipSync(readFileSync(file)).toString("utf8"); cachedData = existsSync(bin) ? readFileSync(bin) : undefined; }
    catch (e) { this.log(`jit cache: chunk ${chunk} unusable (${e.message})`); return null; }
    return this.compile(chunk, src, cachedData, jit);
  }
  compile(chunk, src, cachedData, jit) {
    const file = join(this.dir, `chunk_${chunk}.js.gz`), bin = join(this.dir, `chunk_${chunk}.bin`);
    try {
      const script = new vm.Script(src, { filename: file, cachedData });
      const fns = script.runInThisContext()(...jit.cacheArgs());
      this.stats.chunksLoaded++;
      if (cachedData && !script.cachedDataRejected) this.stats.codeCacheHits++;
      else { try { writeFileSync(bin, script.createCachedData()); } catch {} }
      this.srcs.set(chunk, src.split("\n"));                    // per-block source for tools (fn.src, set in get)
      return fns;
    } catch (e) { this.log(`jit cache: chunk ${chunk} unusable (${e.message})`); return null; }
  }
  // a block just compiled: fnExpr is its "(function blk_..(c, r, m) {...})" source, ats its guest addresses
  add(start, fnExpr, ats, n) {
    if (this.store.index.has(start)) return;
    for (const a of ats) if (a < this.lo || a >= this.hi) return;
    this.store.pending.push({ start, fnExpr, ats, n });
    if (this.store.pending.length >= SAVE_EVERY) this.save();
  }
  save() { saveStore(this.dir, this.store); }
}
export { PARAMS as JIT_CACHE_PARAMS };
