// xbox-threads.mjs — kernel dispatcher objects and threads for gamecode.mjs, run cooperatively on the one CPU.
//
// Objects live in emulated memory as DISPATCHER_HEADERs (+0 u8 type, +4 i32 signal state), so both handle calls
// (NtSetEvent...) and pointer calls (KeSetEvent, KeWaitForSingleObject on a KEVENT the game owns) see the same
// state. Handles map to header addresses. Types used: 0 notification event, 1 synchronization event, 2 mutant,
// 5 semaphore, 6 thread.
//
// Threads (PsCreateSystemThreadEx) get their own CPU context, stack and fs block. They run when the UI frame
// gives them time (runAll, once per frame) and whenever the main context waits for something only a thread can
// signal. A thread runs until it waits on an object that is not signalled (it yields at that point and its wait
// completes when the object is signalled or the time-out passes), sleeps, ends, or uses up its step budget.
// There is no preemption inside a slice, which is what the cooperative model needs: shared data is only
// switched at waits or slice ends.

export const WAIT = { OBJECT_0: 0, TIMEOUT: 0x102, ABANDONED: 0x80 };
const T_NOTIFY = 0, T_SYNC = 1, T_MUTANT = 2, T_SEMAPHORE = 5, T_THREAD = 6;
const STACK_SIZE = 0x40000, EXIT = 0xdead1000;

export class Threads {
  constructor(game) {
    this.g = game; this.m = game.mem; this.cpu = game.cpu;
    this.handles = new Map();            // handle -> header address
    this.extra = new Map();              // header -> { limit, owner, recursion }
    this.list = []; this.current = null; this.nextHandle = 0x9000;
    this.stackBase = 0x0f200000; this.fsArea = 0x7f001000;   // thread stacks in the low window (gamecode.mjs layout)
    this.m.mapZero(this.stackBase, STACK_SIZE * 16);
    this.m.map(this.fsArea, Buffer.alloc(0x1000 * 16));
  }
  get now() { return this.g.ms ?? 0; }
  // ---------------------------------------------------------------- objects
  create(type, signal, extra = {}) {
    const h = this.g.alloc(0x20); this.m.w8(h, type); this.m.w32(h + 4, signal | 0); this.extra.set(h, extra);
    const handle = (this.nextHandle += 4); this.handles.set(handle, h); return { handle, header: h };
  }
  header(x) { return this.handles.get(x >>> 0) ?? (x >>> 0); }           // a handle, or already a header pointer
  signalled(h) {
    const t = this.m.r8(h), s = this.m.r32(h + 4) | 0;
    if (t === T_MUTANT) { const e = this.extra.get(h) ?? {}; return s > 0 || e.owner === this.current; }
    return s > 0;
  }
  acquire(h) {                                                            // a satisfied wait's side effects
    const t = this.m.r8(h), s = this.m.r32(h + 4) | 0;
    if (t === T_SYNC) this.m.w32(h + 4, 0);
    else if (t === T_SEMAPHORE) this.m.w32(h + 4, s - 1);
    else if (t === T_MUTANT) { const e = this.extra.get(h) ?? {}; this.extra.set(h, e);
      if (e.owner === this.current) e.recursion = (e.recursion ?? 0) + 1; else { e.owner = this.current; e.recursion = 1; this.m.w32(h + 4, 0); } }
  }
  set(h, v = 1) { const prev = this.m.r32(h + 4) | 0; this.m.w32(h + 4, v); return prev; }
  pulse(h) { this.set(h, 1); this.runAll(); this.set(h, 0); }
  releaseMutant(h) { const e = this.extra.get(h) ?? {}; if (e.recursion > 1) { e.recursion--; return 0; } e.owner = undefined; e.recursion = 0; this.m.w32(h + 4, 1); return 0; }
  releaseSemaphore(h, n) { const prev = this.m.r32(h + 4) | 0, lim = this.extra.get(h)?.limit ?? 0x7fffffff; this.m.w32(h + 4, Math.min(lim, prev + n)); return prev; }
  // ---------------------------------------------------------------- waits
  // returns a wait status now (main context) or yields the current thread (thread context; status on resume)
  // headers: objects; all: wait for all; timeout: ms or Infinity; c: cpu (to yield from a hook)
  wait(headers, all, timeout, c) {
    const ready = () => all ? headers.every(h => this.signalled(h)) : headers.findIndex(h => this.signalled(h));
    const take = () => { if (all) { headers.forEach(h => this.acquire(h)); return WAIT.OBJECT_0; } const i = ready(); this.acquire(headers[i]); return WAIT.OBJECT_0 + i; };
    const ok = () => (all ? ready() : ready() >= 0);
    if (ok()) return take();
    if (timeout === 0) return WAIT.TIMEOUT;
    if (this.current) {                                                  // a thread: park it, resume when satisfied
      const t = this.current; t.wait = { headers, all, until: this.now + timeout }; c.yieldNow = true; return WAIT.TIMEOUT;
    }
    // the main context cannot block: give the threads time until the wait is satisfied (or no thread can run)
    for (let round = 0; round < 64 && !ok(); round++) if (!this.runAll()) break;
    return ok() ? take() : (timeout === Infinity ? WAIT.OBJECT_0 : WAIT.TIMEOUT);   // never deadlock the UI
  }
  sleep(ms, c) { if (this.current) { this.current.wait = { headers: [], all: true, until: this.now + ms }; c.yieldNow = true; } return 0; }
  // ---------------------------------------------------------------- threads
  createThread({ start, ctx1, ctx2, suspended }) {
    const { handle, header } = this.create(T_THREAD, 0), i = this.list.length;
    // stack and fs block: the lowest of the 16 slots no live thread holds. (Slot = list index ran past the 16 mapped
    // slots once the 17th thread was created: every race creates threads, so the 5th race in one session faulted
    // while loading — the race process's state change failed and was retried, unloading and reloading the modules
    // each time, and the database module's reload put back nascar.db's empty CHRS: the Lightning Challenge flags.)
    const used = new Set(this.list.filter(t => !t.done).map(t => t.slot)); let slot = 0; while (used.has(slot)) slot++;
    if (slot >= 16) throw new Error(`thread 0x${start.toString(16)}: all 16 thread stacks are in use`);
    const top = this.stackBase + STACK_SIZE * (slot + 1) - 0x100, fs = this.fsArea + 0x1000 * slot;
    this.m.writeBytes?.(fs, Buffer.alloc(0x1000));
    const main = this.cpu.saveCtx(), ctx = { ...main, r: new Uint32Array(8), frames: [], fsBase: fs, eip: start, flags: 2 };
    this.m.w32(top - 4, ctx2); this.m.w32(top - 8, ctx1); this.m.w32(top - 12, EXIT);
    ctx.r[4] = top - 12;
    const t = { id: i + 1, slot, handle, header, ctx, start, suspended: !!suspended, done: false, wait: null, steps: 0 };
    this.list.push(t); this.g.note?.(0x7ff0ffff, `thread created 0x${start.toString(16)}(${ctx1.toString(16)}, ${ctx2.toString(16)})`);
    return t;
  }
  terminate(t, code = 0) { t.done = true; t.exitCode = code; this.set(t.header, 1); }
  // run every runnable thread for one slice; returns whether any thread made progress
  runAll(budget = 200_000) {
    if (this.current) return false;                                       // only from the main context
    let progress = false;
    for (const t of this.list) {
      if (t.done || t.suspended) continue;
      if (t.wait) {
        const w = t.wait, ok = w.headers.length ? (w.all ? w.headers.every(h => this.signalled(h)) : w.headers.some(h => this.signalled(h))) : false;
        if (!ok && this.now < w.until) continue;
        t.wait = null; this.current = t;
        if (ok && w.headers.length) { if (w.all) { w.headers.forEach(h => this.acquire(h)); t.ctx.r[0] = 0; } else { const i = w.headers.findIndex(h => this.signalled(h)); this.acquire(w.headers[i]); t.ctx.r[0] = i; } }
        else t.ctx.r[0] = w.headers.length ? WAIT.TIMEOUT : 0;
        this.current = null;
      }
      progress = this.slice(t, budget) || progress;
    }
    return progress;
  }
  slice(t, budget) {
    const cpu = this.cpu, main = cpu.saveCtx(), before = cpu.steps;
    cpu.loadCtx(t.ctx); this.current = t;
    let why;
    try { why = cpu.runSlice(EXIT, budget); }
    catch (e) { why = "error"; this.g.log(`thread ${t.id} (0x${t.start.toString(16)}): ${e.message.slice(0, 300)}`); }
    t.ctx = cpu.saveCtx(); this.current = null; cpu.loadCtx(main);
    t.steps += cpu.steps - before;
    if (why === "exit" || why === "error" || t.exitRequested) this.terminate(t, t.ctx.r[0]);
    return why !== "yield" || cpu.steps - before > 50;
  }
}
