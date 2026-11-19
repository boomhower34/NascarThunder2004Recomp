// xbox-fs.mjs — the Xbox kernel's file calls (Nt*File, symbolic links) on host folders, for gamecode.mjs.
//
// Object names are ANSI strings ({u16 length, u16 maximum, char* buffer}); OBJECT_ATTRIBUTES is {HANDLE root,
// ANSI_STRING* name, u32 attributes}. Devices map to host folders:
//   \Device\CdRom0\...                   -> the disc root (the folder holding Data\)
//   \Device\Harddisk0\Partition1\...     -> <save folder>\E\...   (UDATA\<title id>\ = saved games, TDATA = title data)
//   \Device\Harddisk0\Partition<n>\...   -> <save folder>\P<n>\... (cache partitions)
//   \??\X:\...                           -> through the symbolic links the game created (IoCreateSymbolicLink),
//                                           else the dashboard defaults D: disc, T:/U: title/user data, Z: cache
// Look-ups ignore case (FATX does); new names keep the case they were given.

import { readdirSync, statSync, openSync, closeSync, readSync, writeSync, ftruncateSync, mkdirSync, existsSync,
  unlinkSync, rmdirSync, renameSync, fstatSync, appendFileSync } from "node:fs";
import { join, dirname, basename, sep } from "node:path";

export const STATUS = {
  SUCCESS: 0, NO_MORE_FILES: 0x80000006, END_OF_FILE: 0xc0000011, NO_SUCH_FILE: 0xc000000f, INVALID_HANDLE: 0xc0000008,
  NAME_NOT_FOUND: 0xc0000034, PATH_NOT_FOUND: 0xc000003a, NAME_COLLISION: 0xc0000035, IS_A_DIRECTORY: 0xc00000ba,
  NOT_A_DIRECTORY: 0xc0000103, INVALID_PARAMETER: 0xc000000d, NOT_IMPLEMENTED: 0xc0000002, DIRECTORY_NOT_EMPTY: 0xc0000101,
  ACCESS_DENIED: 0xc0000022,
};
const DOS = { 0: 0, [STATUS.NAME_NOT_FOUND]: 2, [STATUS.NO_SUCH_FILE]: 2, [STATUS.PATH_NOT_FOUND]: 3, [STATUS.NAME_COLLISION]: 183,
  [STATUS.NO_MORE_FILES]: 18, [STATUS.END_OF_FILE]: 38, [STATUS.INVALID_HANDLE]: 6, [STATUS.IS_A_DIRECTORY]: 5,
  [STATUS.NOT_A_DIRECTORY]: 267, [STATUS.INVALID_PARAMETER]: 87, [STATUS.DIRECTORY_NOT_EMPTY]: 145, [STATUS.ACCESS_DENIED]: 5 };
export const dosError = s => DOS[s >>> 0] ?? 317;

const FILETIME = ms => BigInt(Math.round(ms)) * 10000n + 116444736000000000n;

export class XboxFs {
  constructor(mem, { discRoot, saveRoot, titleId = 0x45410031, log = () => {} }) {
    this.m = mem; this.discRoot = discRoot; this.saveRoot = saveRoot; this.log = log;
    const t = titleId.toString(16).padStart(8, "0");
    this.links = new Map(Object.entries({ D: "\\Device\\CdRom0", T: `\\Device\\Harddisk0\\Partition1\\TDATA\\${t}`,
      U: `\\Device\\Harddisk0\\Partition1\\UDATA\\${t}`, Z: "\\Device\\Harddisk0\\Partition5" }));
    // the title's data folders exist from the first launch (the dashboard creates them)
    for (const d of [`E/UDATA/${t}`, `E/TDATA/${t}`, "P5"]) mkdirSync(join(saveRoot, d), { recursive: true });
    this.handles = new Map(); this.next = 0x5000; this.trace = !!process.env.NT04_FSTRACE;
    // a save folder left empty (a save cut off right after its folder was made) made every later save of that kind
    // fail ("The maximum number of saved games already exist": the game's id for it is taken): empty ones go
    try { const u = join(saveRoot, "E", "UDATA", t); for (const d of readdirSync(u)) { const p = join(u, d); try { if (statSync(p).isDirectory() && !readdirSync(p).length) { rmdirSync(p); log(`fs: removed the empty save folder ${d}`); } } catch {} } } catch {}
    // a host error (a file in use, no permission, ...) is the call's failure, logged, not an exception through the
    // game's code (which left a save's "Please wait" box up for good)
    for (const k of ["create", "open", "close", "read", "write", "queryInfo", "setInfo", "fullAttributes", "queryDirectory", "remove"]) {
      const f = this[k].bind(this);
      this[k] = (...a) => { try { return f(...a); } catch (e) { this.log(`fs: ${k} failed: ${e.message}`); this.note(`${k} failed: ${e.stack?.split("\n").slice(0, 4).join(" | ")}`); this.dirty(); return STATUS.ACCESS_DENIED; } };
    }
  }
  // the save folder's own log (fs.log beside E\ and P5\): failures and, for a while after one, what the game did on the
  // hard disk, for a problem that only shows on one computer
  note(line) { try { appendFileSync(join(this.saveRoot, "fs.log"), `${new Date().toISOString()} ${line}\n`); } catch {} }
  // ---------------------------------------------------------------- names
  ansi(p) { if (!p) return ""; const m = this.m, n = m.r16(p), b = m.r32(p + 4); let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(m.r8(b + i)); return s; }
  objName(oa) { const m = this.m, root = m.r32(oa), name = this.ansi(m.r32(oa + 4));
    const r = root ? this.handles.get(root) : null; return r ? `${r.xpath}\\${name}` : name; }
  // Xbox path -> host path (existing components matched without case); null when the device is unknown
  host(xpath) {
    let p = xpath.replace(/\//g, "\\");
    if (/^[A-Za-z]:/.test(p)) p = "\\??\\" + p;                       // "U:\..." as XAPI passes drive paths
    for (let i = 0; i < 8; i++) { const d = p.match(/^\\\?\?\\([A-Za-z]):(.*)$/); if (!d) break; const t = this.links.get(d[1].toUpperCase()); if (!t) return null; p = t + d[2]; }
    let base, rest;
    let mm;
    if ((mm = p.match(/^\\Device\\CdRom0(.*)$/i))) { base = this.discRoot; rest = mm[1]; }
    else if ((mm = p.match(/^\\Device\\Harddisk0\\Partition(\d+)(.*)$/i))) { base = join(this.saveRoot, mm[1] === "1" ? "E" : `P${mm[1]}`); rest = mm[2]; }
    else return null;
    let dir = base; const disc = base === this.discRoot;
    for (const part of rest.split("\\").filter(x => x && x !== ".")) {
      let hit = null; try { hit = this.list(dir, disc).get(part.toLowerCase()); } catch {}
      dir = join(dir, hit ?? part);
    }
    return dir;
  }
  // Folder listings and file stats, read once: each open looked through every folder of its path again and stat'ed
  // every file of a folder it opened (the cache partition Z:\data: 37 times on the way to the menu, over 2 s on
  // Windows). The disc (the Data folder) never changes while the game runs; the hard disk's are forgotten whenever
  // this module changes anything there (create, write, set information, delete: dirty()).
  list(dir, disc = this.isDisc(dir)) { const c = disc ? (this.discDirs ??= new Map()) : (this.saveDirs ??= new Map()); let l = c.get(dir);
    if (!l) { l = new Map(readdirSync(dir).map(f => [f.toLowerCase(), f])); c.set(dir, l); } return l; }
  dirty() { this.saveDirs?.clear(); this.saveStats?.clear(); }
  // (the disc root is the game's folder, which can hold the save folders too: save/, presets/<name>/save/ -- those
  // are the hard disk, never the disc)
  isDisc(path) { const under = (p, r) => !!r && (p === r || p.startsWith(r.endsWith(sep) ? r : r + sep));
    return under(path, this.discRoot) && !under(path, this.saveRoot); }
  // A directory's last-write / change time is the newest of its own and its entries'. On the Xbox a save's date is
  // the time it was last written (XFindFirstSaveGame gives it for the save directory), while here rewriting the files
  // of an existing save in place leaves the host directory's time alone. The game loads the user profiles into their
  // slots newest save first (the profile in use, saved last, comes back as the active profile 0); with the directory
  // times frozen at creation a profile saved later came back in another slot (Lightning Challenge progress "lost":
  // it was in profile 4 while profile 1's empty data was active).
  stat(path) {
    const c = this.isDisc(path) ? (this.discStats ??= new Map()) : (this.saveStats ??= new Map());
    if (c.has(path)) return c.get(path); const st = this.stat0(path); c.set(path, st); return st;
  }
  stat0(path) { let st; try { st = statSync(path); } catch { return null; }
    if (st.isDirectory()) { let t = st.mtimeMs; try { for (const n of readdirSync(path)) { const c = statSync(join(path, n)); if (c.mtimeMs > t) t = c.mtimeMs; } } catch {}
      if (t > st.mtimeMs) { st.mtimeMs = t; if (t > st.ctimeMs) st.ctimeMs = t; } }
    return st; }
  // ---------------------------------------------------------------- helpers
  io(isb, status, info = 0) { if (isb) { this.m.w32(isb, status); this.m.w32(isb + 4, info); } return status; }
  w64(a, v) { v = BigInt(v); this.m.w32(a, Number(v & 0xffffffffn)); this.m.w32(a + 4, Number((v >> 32n) & 0xffffffffn)); }
  r64(a) { return this.m.r32(a) + this.m.r32(a + 4) * 2 ** 32; }
  newHandle(h) { const id = this.next; this.next += 4; this.handles.set(id, h); return id; }
  netOpenInfo(a, st) { // FILE_NETWORK_OPEN_INFORMATION (56 bytes)
    for (const [o, t] of [[0, st.birthtimeMs], [8, st.atimeMs], [16, st.mtimeMs], [24, st.ctimeMs]]) this.w64(a + o, FILETIME(t));
    // FATX: a directory takes one 16 KB cluster (XFindFirstSaveGame counts it in the save's size: a save is
    // ceil((data + 3 clusters) / 16 KB) blocks with the directory, SaveMeta.xbx and the icon)
    const size = st.isDirectory() ? 0 : st.size; this.w64(a + 32, st.isDirectory() ? 16384 : Math.ceil(size / 16384) * 16384); this.w64(a + 40, size);
    this.m.w32(a + 48, st.isDirectory() ? 0x10 : 0x80); this.m.w32(a + 52, 0);
  }
  // ---------------------------------------------------------------- calls (arguments as the kernel takes them)
  // NtCreateFile(FileHandle*, Access, ObjAttr*, IoStatus*, AllocationSize*, FileAttributes, Share, Disposition, Options)
  create(a) {
    const [ph, access, oa, isb, , , , disp, opts] = a, xpath = this.objName(oa), path = this.host(xpath);
    if (this.trace) this.log(`fs: create ${xpath} -> ${path} disposition ${disp} options 0x${(opts >>> 0).toString(16)}`);
    if (!path) { this.log(`fs: ${xpath}: unknown device`); return this.io(isb, STATUS.PATH_NOT_FOUND); }
    const st = this.stat(path), wantDir = (opts & 1) !== 0;
    if (!this.stat(dirname(path))) { this.log(`fs: ${xpath}: path not found`); return this.io(isb, STATUS.PATH_NOT_FOUND); }
    let info = 1;
    if (st) {
      if (disp === 2) return this.io(isb, STATUS.NAME_COLLISION);
      if (wantDir && !st.isDirectory()) return this.io(isb, STATUS.NOT_A_DIRECTORY);
      if ((opts & 0x40) && st.isDirectory()) return this.io(isb, STATUS.IS_A_DIRECTORY);
      if (!st.isDirectory() && (disp === 0 || disp === 4 || disp === 5)) { closeSync(openSync(path, "w")); this.dirty(); info = disp === 0 ? 0 : 3; }
    } else {
      if (disp === 1 || disp === 4) return this.io(isb, STATUS.NAME_NOT_FOUND);
      if (wantDir) mkdirSync(path); else closeSync(openSync(path, "w"));
      this.dirty(); info = 2;
    }
    const st2 = this.stat(path); if (!st2) { this.dirty(); return this.io(isb, STATUS.NAME_NOT_FOUND); }
    const isDir = st2.isDirectory();
    const h = isDir ? { dir: true, path, xpath } : { fd: openSync(path, "r+"), path, xpath, pos: 0 };
    this.m.w32(ph, this.newHandle(h));
    return this.io(isb, STATUS.SUCCESS, info);
  }
  // NtOpenFile(FileHandle*, Access, ObjAttr*, IoStatus*, Share, Options)
  open(a) { const [ph, access, oa, isb, share, opts] = a; return this.create([ph, access, oa, isb, 0, 0, share, 1, opts]); }
  close(h) { const f = this.handles.get(h); if (!f) return STATUS.INVALID_HANDLE; if (f.fd !== undefined) closeSync(f.fd); this.handles.delete(h); return 0; }
  // NtReadFile / NtWriteFile(h, Event, Apc, ApcContext, IoStatus*, Buffer, Length, ByteOffset*)
  read(a) {
    const [h, , , , isb, buf, len, off] = a, f = this.handles.get(h);
    if (!f || f.fd === undefined) return this.io(isb, STATUS.INVALID_HANDLE);
    if (off && this.m.r32(off + 4) !== 0xffffffff) f.pos = this.r64(off);                 // high -1: FILE_USE_FILE_POINTER_POSITION / end
    if (this.trace) this.log(`fs: read ${f.xpath} at ${f.pos} len ${len}${off ? ` off ${this.m.r32(off + 4).toString(16)}:${this.m.r32(off).toString(16)}` : ""}`);
    const size = fstatSync(f.fd).size; if (f.pos >= size && len) return this.io(isb, STATUS.END_OF_FILE);
    const b = Buffer.alloc(Math.min(len, size - f.pos)); const n = readSync(f.fd, b, 0, b.length, f.pos);
    this.m.writeBytes(buf, b.subarray(0, n)); f.pos += n; return this.io(isb, STATUS.SUCCESS, n);
  }
  write(a) {
    const [h, , , , isb, buf, len, off] = a, f = this.handles.get(h);
    if (!f || f.fd === undefined) return this.io(isb, STATUS.INVALID_HANDLE);
    if (off && !(this.m.r32(off) === 0xffffffff && this.m.r32(off + 4) === 0xffffffff)) f.pos = this.r64(off);
    const n = writeSync(f.fd, this.m.readBytes(buf, len), 0, len, f.pos); f.pos += n; this.dirty(); return this.io(isb, STATUS.SUCCESS, n);
  }
  // NtQueryInformationFile(h, IoStatus*, Info*, Length, Class)
  queryInfo(a) {
    const [h, isb, p, len, cls] = a, f = this.handles.get(h); if (!f) return this.io(isb, STATUS.INVALID_HANDLE);
    const st = this.stat(f.path), m = this.m; if (!st) return this.io(isb, STATUS.NAME_NOT_FOUND);
    switch (cls) {
      case 4: this.netOpenInfo(SCR, st); for (let i = 0; i < 32; i++) m.w8(p + i, m.r8(SCR + i)); m.w32(p + 32, m.r32(SCR + 48)); return this.io(isb, 0, 36); // basic
      case 5: { const size = st.isDirectory() ? 0 : st.size; this.w64(p, st.isDirectory() ? 16384 : Math.ceil(size / 16384) * 16384); this.w64(p + 8, size); m.w32(p + 16, 1); m.w8(p + 20, 0); m.w8(p + 21, st.isDirectory() ? 1 : 0); return this.io(isb, 0, 24); }
      case 6: this.w64(p, Number(st.ino ?? 0) % 2 ** 52); return this.io(isb, 0, 8);           // internal (file index)
      case 14: this.w64(p, f.pos ?? 0); return this.io(isb, 0, 8);
      case 34: this.netOpenInfo(p, st); return this.io(isb, 0, 56);
    }
    this.log(`fs: NtQueryInformationFile class ${cls}`); return this.io(isb, STATUS.INVALID_PARAMETER);
  }
  // NtSetInformationFile(h, IoStatus*, Info*, Length, Class)
  setInfo(a) {
    this.dirty();
    const [h, isb, p, len, cls] = a, f = this.handles.get(h), m = this.m; if (!f) return this.io(isb, STATUS.INVALID_HANDLE);
    switch (cls) {
      case 4: return this.io(isb, 0);                                                      // basic (times, attributes)
      case 13: f.deleteOnClose = m.r8(p) !== 0; if (f.deleteOnClose) this.remove(f); return this.io(isb, 0);   // disposition
      case 14: f.pos = this.r64(p); return this.io(isb, 0);                                // position
      case 19: return this.io(isb, 0);                                                     // allocation
      case 20: if (f.fd !== undefined) ftruncateSync(f.fd, this.r64(p)); return this.io(isb, 0);   // end of file
      case 10: {                                                                           // rename {u8 replace, root, ANSI name}
        const root = m.r32(p + 4), name = this.ansi(p + 8), r = root ? this.handles.get(root) : null;
        const to = this.host(r ? `${r.xpath}\\${name}` : name.startsWith("\\") ? name : `${f.xpath.replace(/\\[^\\]*$/, "")}\\${name}`);
        if (!to) return this.io(isb, STATUS.PATH_NOT_FOUND);
        if (this.stat(to) && !m.r8(p)) return this.io(isb, STATUS.NAME_COLLISION);
        renameSync(f.path, to); f.path = to; return this.io(isb, 0);
      }
    }
    this.log(`fs: NtSetInformationFile class ${cls}`); return this.io(isb, STATUS.INVALID_PARAMETER);
  }
  remove(f) {
    this.dirty();
    try { if (f.fd !== undefined) { closeSync(f.fd); f.fd = undefined; unlinkSync(f.path); } else rmdirSync(f.path); }
    catch (e) { this.log(`fs: delete ${f.xpath}: ${e.message}`); }
  }
  // NtQueryFullAttributesFile(ObjAttr*, FILE_NETWORK_OPEN_INFORMATION*)
  fullAttributes(a) { const path = this.host(this.objName(a[0])), st = path && this.stat(path); if (!st) return STATUS.NAME_NOT_FOUND; this.netOpenInfo(a[1], st); return 0; }
  // NtQueryDirectoryFile(h, Event, Apc, ApcContext, IoStatus*, Info*, Length, Class, Mask (ANSI_STRING*), Restart):
  // one FILE_DIRECTORY_INFORMATION per call (Xbox names are ANSI)
  queryDirectory(a) {
    const [h, , , , isb, p, len, cls, maskp, restart] = a, f = this.handles.get(h), m = this.m;
    if (this.trace) this.log(`fs: query directory ${f?.xpath} restart ${restart} mask ${maskp ? this.ansi(maskp) : "-"} idx ${f?.idx}`);
    if (!f || !f.dir) return this.io(isb, STATUS.INVALID_HANDLE);
    if ((restart & 0xff) || !f.list) {                                         // RestartScan is a BOOLEAN (low byte)
      const mask = maskp ? this.ansi(maskp) : "*";
      const re = new RegExp("^" + mask.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
      let names = []; try { names = readdirSync(f.path); } catch {}
      f.list = names.filter(n => re.test(n)); f.idx = 0;
      if (!f.list.length) return this.io(isb, STATUS.NO_SUCH_FILE);
    }
    if (f.idx >= f.list.length) return this.io(isb, STATUS.NO_MORE_FILES);
    const name = f.list[f.idx], st = this.stat(join(f.path, name));
    if (64 + name.length > len) return this.io(isb, 0x80000005);                          // buffer overflow
    f.idx++;
    m.w32(p, 0); m.w32(p + 4, f.idx - 1);
    // FILE_DIRECTORY_INFORMATION: 4 times at +8, EndOfFile +0x28, AllocationSize +0x30, attributes +0x38
    this.netOpenInfo(SCR, st); for (let i = 0; i < 32; i++) m.w8(p + 8 + i, m.r8(SCR + i));
    for (let i = 0; i < 8; i++) { m.w8(p + 0x28 + i, m.r8(SCR + 40 + i)); m.w8(p + 0x30 + i, m.r8(SCR + 32 + i)); }
    m.w32(p + 56, m.r32(SCR + 48)); m.w32(p + 60, name.length);
    for (let i = 0; i < name.length; i++) m.w8(p + 64 + i, name.charCodeAt(i));
    return this.io(isb, 0, 64 + name.length);
  }
  // NtQueryVolumeInformationFile(h, IoStatus*, Info*, Length, Class)
  queryVolume(a) {
    const [h, isb, p, len, cls] = a, m = this.m;
    if (cls === 3) { this.w64(p, 0x80000); this.w64(p + 8, 0x40000); m.w32(p + 16, 32); m.w32(p + 20, 512); return this.io(isb, 0, 24); } // size: 16 KB clusters
    if (cls === 1) { for (let i = 0; i < 18; i++) m.w8(p + i, 0); return this.io(isb, 0, 18); }
    this.log(`fs: NtQueryVolumeInformationFile class ${cls}`); return this.io(isb, STATUS.INVALID_PARAMETER);
  }
  // IoCreateSymbolicLink(ANSI link, ANSI target) / IoDeleteSymbolicLink(ANSI link)
  createLink(a) { const l = this.ansi(a[0]).match(/^\\\?\?\\([A-Za-z]):$/); if (l) this.links.set(l[1].toUpperCase(), this.ansi(a[1])); return 0; }
  deleteLink(a) { const l = this.ansi(a[0]).match(/^\\\?\?\\([A-Za-z]):$/); if (l) this.links.delete(l[1].toUpperCase()); return 0; }
  // NtOpenSymbolicLinkObject(LinkHandle*, ObjAttr*) / NtQuerySymbolicLinkObject(h, ANSI target*, ReturnedLength*)
  openLink(a) { const n = this.objName(a[1]).match(/^\\\?\?\\([A-Za-z]):$/), t = n && this.links.get(n[1].toUpperCase());
    if (!t) return STATUS.NAME_NOT_FOUND; this.m.w32(a[0], this.newHandle({ link: t, xpath: t })); return 0; }
  queryLink(a) { const f = this.handles.get(a[0]); if (!f?.link) return STATUS.INVALID_HANDLE; const m = this.m, s = a[1], cap = m.r16(s + 2), b = m.r32(s + 4);
    const n = Math.min(cap, f.link.length); for (let i = 0; i < n; i++) m.w8(b + i, f.link.charCodeAt(i)); m.w16(s, n); if (a[2]) m.w32(a[2], f.link.length); return 0; }
}
let SCR = 0;     // 64-byte scratch for building records, set by the owner
export function setScratch(a) { SCR = a; }
