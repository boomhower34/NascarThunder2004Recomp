// xiso.mjs — read an original Xbox disc image (XDVDFS) and take out the game's files: the launcher's first-run set-up
// gets the game from the user's own disc image instead of a folder copied by hand.
//
// Images: "xiso" (the game partition alone, as extract-xiso / XDVDFS tools make it) and full Redump images (a video
// partition first; the game partition starts at a fixed offset per disc generation). XDVDFS: 2048-byte sectors; the
// volume descriptor at sector 32 of the partition ("MICROSOFT*XBOX*MEDIA" at +0, root directory sector u32 +0x14 and
// size u32 +0x18, the magic again at +0x7EC). A directory is a table of entries in a binary tree: u16 left, u16 right
// (offsets in dwords from the table start, 0 = none), u32 start sector, u32 size, u8 attributes (0x10 directory), u8
// name length, the name; entries are dword-aligned and never cross a sector (the rest of a sector is 0xFF).
//
// For this game: the disc holds default.xbe and a Data folder at its root, which is the layout the launcher wants
// (<out>/default.xbe beside <out>/Data: gamecode.mjs looks for the XBE beside the Data folder), so the disc's paths
// are kept as they are. $SystemUpdate (a dashboard update) is left out.
//
//   node xiso.mjs list <image>
//   node xiso.mjs extract <image> [out folder (default: here)] [--force]
import { openSync, readSync, closeSync, fstatSync, mkdirSync, writeSync, existsSync, statSync, renameSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { convertXbe } from "./xbe2pe.mjs";

const SECTOR = 2048, MAGIC = "MICROSOFT*XBOX*MEDIA";
// where the game partition starts: xiso, Redump XGD1 / XGD2 / XGD2 (newer) / XGD3
const PARTITIONS = [0, 0x18300000, 0xfd90000, 0x89d80000, 0x2080000];

export class XIso {
  constructor(path) {
    this.path = path; this.fd = openSync(path, "r"); this.size = fstatSync(this.fd).size;
    this.base = PARTITIONS.find(b => b + 0x10000 + SECTOR <= this.size && this.read(b + 0x10000, 20).toString("latin1") === MAGIC);
    if (this.base === undefined) { closeSync(this.fd); throw new Error(`${path} is not an Xbox disc image (no XDVDFS volume found)`); }
    const vd = this.read(this.base + 0x10000, SECTOR);
    if (vd.toString("latin1", 0x7ec, 0x7ec + 20) !== MAGIC) { closeSync(this.fd); throw new Error("the disc image's volume descriptor is damaged"); }
    this.root = { sector: vd.readUInt32LE(0x14), size: vd.readUInt32LE(0x18) };
  }
  read(pos, n) { const b = Buffer.alloc(n); const got = readSync(this.fd, b, 0, n, pos); return got === n ? b : b.subarray(0, got); }
  close() { closeSync(this.fd); }
  // the entries of a directory, in name order: { name, dir, sector, size, path }
  dir({ sector, size }, prefix = "") {
    if (!size) return [];
    const t = this.read(this.base + sector * SECTOR, size), out = [], seen = new Set();
    const walk = off => {
      if (off + 14 > t.length || seen.has(off)) return; seen.add(off);
      const left = t.readUInt16LE(off), right = t.readUInt16LE(off + 2);
      if (left === 0xffff) return;                                      // padding at a sector end
      const e = { sector: t.readUInt32LE(off + 4), size: t.readUInt32LE(off + 8), dir: (t[off + 12] & 0x10) !== 0, name: t.toString("latin1", off + 14, off + 14 + t[off + 13]) };
      e.path = prefix ? `${prefix}/${e.name}` : e.name;
      if (left) walk(left * 4);
      out.push(e);
      if (right) walk(right * 4);
    };
    walk(0);
    return out;
  }
  // every file under a directory (depth first): { path, sector, size }
  *files(d = this.root, prefix = "") {
    for (const e of this.dir(d, prefix)) { if (e.dir) yield* this.files(e, e.path); else yield e; }
  }
  // copy one file out in 4 MB pieces
  copy(e, dest, onBytes) {
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = dest + ".part", fd = openSync(tmp, "w"), buf = Buffer.alloc(4 << 20);
    try {
      for (let done = 0; done < e.size;) {
        const n = readSync(this.fd, buf, 0, Math.min(buf.length, e.size - done), this.base + e.sector * SECTOR + done);
        if (n <= 0) throw new Error(`${e.path}: the disc image ends early (incomplete or damaged image)`);
        writeSync(fd, buf, 0, n); done += n; onBytes?.(n);
      }
    } finally { closeSync(fd); }
    renameSync(tmp, dest);
  }
}

// Take the game's files out of an image. out: the folder that gets Data/ and default.xbe. Existing files of the same
// size are kept unless force. progress({ file, done, total }) after each file.
export function extractGame(image, out, { force = false, progress } = {}) {
  const iso = new XIso(image);
  try {
    const all = [...iso.files()].filter(e => !/^\$SystemUpdate\//i.test(e.path));
    const xbe = all.find(e => e.path.toLowerCase() === "default.xbe");
    if (!xbe) throw new Error("the disc image has no default.xbe (not a game disc?)");
    if (!all.some(e => /^Data\//i.test(e.path))) throw new Error("the disc image has no Data folder (is it NASCAR Thunder 2004?)");
    const plan = all.map(e => ({ e, dest: join(out, ...e.path.split("/")) }));
    const total = plan.reduce((n, p) => n + p.e.size, 0); let done = 0, copied = 0, kept = 0, xbeCopied = false;
    for (const { e, dest } of plan) {
      if (!force && existsSync(dest) && statSync(dest).size === e.size) { done += e.size; kept++; }
      else { iso.copy(e, dest, n => { done += n; }); copied++; if (e === xbe) xbeCopied = true; }
      progress?.({ file: e.path, done, total });
    }
    // default.exe (the PE image the game code runs from) from the XBE: again whenever the XBE was copied
    const xbePath = join(out, "default.xbe"), exe = join(out, "default.exe"); let made = false;
    if (force || xbeCopied || !existsSync(exe)) { convertXbe(xbePath, exe); made = true; }
    return { files: plan.length, copied, kept, bytes: total, partition: iso.base, xbe: xbePath, exe, exeMade: made, data: join(out, "Data") };
  } finally { iso.close(); }
}

// ---------------------------------------------------------------- command line
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, image, ...rest] = process.argv.slice(2), force = rest.includes("--force"), args = rest.filter(a => !a.startsWith("--"));
  if (!["list", "extract"].includes(cmd) || !image) { console.log("usage: node xiso.mjs list <image>\n       node xiso.mjs extract <image> [out folder] [--force]"); process.exit(1); }
  try {
    if (cmd === "list") {
      const iso = new XIso(image); let n = 0, b = 0;
      console.log(`game partition at 0x${iso.base.toString(16)}`);
      for (const e of iso.files()) { console.log(`${String(e.size).padStart(11)}  ${e.path}`); n++; b += e.size; }
      console.log(`${n} files, ${(b / 2 ** 20).toFixed(1)} MB`); iso.close();
    } else {
      const out = resolve(args[0] ?? dirname(fileURLToPath(import.meta.url))); let last = 0;
      const r = extractGame(image, out, { force, progress: p => { const pc = Math.floor(p.done / p.total * 100); if (pc >= last + 2 || p.done === p.total) { last = pc; console.log(`[${pc}/100] ${p.file}`); } } });   // ([n/100]: the launcher's progress bar)
      console.log(`done: ${r.files} files (${r.copied} copied, ${r.kept} already there), ${(r.bytes / 2 ** 20).toFixed(1)} MB -> ${r.data} and ${r.xbe}`);
      console.log(r.exeMade ? `made ${r.exe} from default.xbe` : `${r.exe} already there`);
    }
  } catch (e) { console.error(e.message); process.exit(1); }
}
