// make-release.mjs — the packages people download: the framework only (no game files, nothing built from the game's
// code), with Node itself inside so nobody has to install it. One package per platform in release/:
//   NT04-Recomp-<version>-win-x64.zip, -macos-arm64.zip, -macos-x64.zip, -linux-x64.tar.gz (others with --platforms)
// each holding NT04-Recomp/ with only a start file for that system (Launch.bat / Launch.command / launch.sh) and
// README.txt at the top, and everything else in NT04-Recomp/app/: the launcher and the code it runs, runtime/node(.exe)
// + Node's licence, the compiler in tools/llvm (the launcher runs from app/, so the game files, saves, presets and the
// built game code a player makes go there too). The player then gets the game files from their own disc image and builds the game code on their machine (launcher Setup tab: Game files, Game code).
//
// What goes in: everything the launcher can reach (imports, workers, scripts it starts, files read beside a module),
// found by following the code from launcher.mjs, plus a short list of files read in ways the search does not see.
// What never goes in, checked at the end: the game (default.xbe / default.exe / Data), anything built from its code
// (recomp.json, recomp.wasm, recomp-native-*.node), and the player's own folders (save, roster, presets, textures...).
//
// Node: the official build of the same version as the Node running this script (or --node vX.Y.Z), downloaded from
// nodejs.org and checked against its SHASUMS256.txt; kept in release/cache. --node-cache DIR: archives already
// downloaded (same file names as nodejs.org). Without network, the package for this computer's own platform can be
// made from the Node that runs this script (--local-node).
//
// The C compiler (for the launcher's "Build game code"): clang and wasm-ld from wasi-sdk (the WebAssembly project's
// own LLVM build, Apache-2.0 WITH LLVM-exception) for each platform, in tools/llvm/bin with their licence files, so a
// player needs nothing else. Downloaded from github.com/WebAssembly/wasi-sdk releases into the same cache; the first
// download's SHA-256 is pinned in release/cache/pins.json and a later different file is refused. --no-clang leaves it
// out (smaller packages; the player installs LLVM instead). --clang-archive plat=FILE uses an archive already on disk.
//
//   node make-release.mjs [--version 2026.11.18] [--platforms win-x64,macos-arm64,...] [--node v22.12.0]
//                         [--node-cache DIR] [--local-node] [--out release] [--wasi-sdk 25] [--no-clang]
import fs from "node:fs";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { join, dirname, basename, posix } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2), opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const today = new Date().toISOString().slice(0, 10).replace(/-/g, ".");
const VERSION = opt("--version", today), NODE = opt("--node", process.version), OUT = join(HERE, opt("--out", "release"));
const PLATFORMS = opt("--platforms", "win-x64,macos-arm64,macos-x64,linux-x64").split(",");
const CACHE = opt("--node-cache", join(OUT, "cache")), LOCAL = args.includes("--local-node");
const NAME = "NT04-Recomp", APP = `${NAME}/app`;
const WASI = opt("--wasi-sdk", "25"), CLANG = !args.includes("--no-clang");
const CLANG_ARCHIVES = new Map(args.flatMap((a, i) => a === "--clang-archive" ? [args[i + 1].split("=")] : []));
// platform -> wasi-sdk's build (Windows on ARM runs the x64 build)
const WASI_PLAT = { "win-x64": "x86_64-windows", "win-arm64": "x86_64-windows", "macos-arm64": "arm64-macos", "macos-x64": "x86_64-macos", "linux-x64": "x86_64-linux", "linux-arm64": "arm64-linux" };

// platform -> Node's archive, the binary inside it, the start file
const PLAT = {
  "win-x64": { node: "win-x64", ext: "zip", bin: "node.exe", sys: "win32-x64" }, "win-arm64": { node: "win-arm64", ext: "zip", bin: "node.exe", sys: "win32-arm64" },
  "macos-arm64": { node: "darwin-arm64", ext: "tar.gz", bin: "bin/node", sys: "darwin-arm64" }, "macos-x64": { node: "darwin-x64", ext: "tar.gz", bin: "bin/node", sys: "darwin-x64" },
  "linux-x64": { node: "linux-x64", ext: "tar.gz", bin: "bin/node", sys: "linux-x64" }, "linux-arm64": { node: "linux-arm64", ext: "tar.gz", bin: "bin/node", sys: "linux-arm64" },
};

// ---------------------------------------------------------------- the files
// read in ways the search below does not follow (a path built from the module's folder, a Python import, tools)
const EXTRA = ["src/cpu/v8-tuning.mjs", "src/cpu/x86_callee_pops.json", "src/xbox/kernel_imports.csv", "src/xbox/xbe_symbols.json", "src/cpu/recomp-native.c", "src/net/relay.mjs", "python/read_textures.py", "nt04.config.example.json"];
// never shipped: the game, what is built from its code, the player's own data, development leftovers
const DENY = [/^default\.(xbe|exe)$/i, /^recomp(-native)?\.json$/i, /\.wasm(\.gz)?$/i, /\.node(\.gz)?$/i, /\.(dat|qkl|db|iso|xiso|bin|pth|safetensors)$/i,
  /^launcher-settings\.json$/i, /^(Data|save|roster|presets|textures|models|captures|drivers|jit-cache|exports|nr2003tracks|_to_delete|_profiles_from_the_bug|__pycache__)\//i];
// files the code creates at run time (the player's settings and data, the game code built on their machine): the
// search finds them because the code names them, but they are never shipped
const CREATED = new Set(["track.json", "index.json", "sponsors.json", "roster.json", "recomp.json", "recomp-native.json", "launcher-settings.json"]);
function collect() {
  const seen = new Set(), todo = ["launcher.mjs", ...EXTRA], missing = [];
  // (paths are relative to the file they are in: "./x.mjs", "../cpu/x.mjs", join(here, "render/play-client.js"))
  const pats = [/(?:import|export)[^"'`;]*?from\s*["'](\.{1,2}\/[^"']+)["']/g, /import\s+["'](\.{1,2}\/[^"']+)["']/g, /import\(\s*["'](\.{1,2}\/[^"']+)["']/g,
    /new URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url/g,
    /join\(\s*(?:here|HERE|dirname\(fileURLToPath\(import\.meta\.url\)\))\s*,\s*["']([^"'${}]+\.(?:mjs|js|json|py|csv|c))["']\s*\)/g,
    /^from (\w+) import/gm];
  while (todo.length) {
    let f = todo.pop();
    if (seen.has(f) || CREATED.has(posix.basename(f))) continue; if (!fs.existsSync(join(HERE, f))) { if (!/\.py$/.test(f)) missing.push(f); continue; }
    seen.add(f); if (!/\.(mjs|js|py)$/.test(f)) continue;
    const s = fs.readFileSync(join(HERE, f), "utf8");
    for (const p of pats) for (const m of s.matchAll(p)) if (/\.py$/.test(f) === (p.source.startsWith("^from")))
      todo.push(posix.normalize(posix.join(posix.dirname(f), /^\w+$/.test(m[1]) ? m[1] + ".py" : m[1])));   // (Python "from x import": x.py beside it, if ours)
  }
  return { files: [...seen].sort(), missing };
}

// ---------------------------------------------------------------- start files and README
const LAUNCH = {
  win: `@echo off\r\nrem Double-click to open the NASCAR Thunder 2004 launcher in your browser.\r\ncd /d "%~dp0app"\r\n"%~dp0app\\runtime\\node.exe" launcher.mjs %*\r\nif errorlevel 1 pause\r\n`,
  mac: `#!/bin/sh\n# Double-click to open the NASCAR Thunder 2004 launcher in your browser.\ncd "$(dirname "$0")/app" || exit 1\nexec ./runtime/node launcher.mjs "$@"\n`,
  linux: `#!/bin/sh\n# Run (or double-click) to open the NASCAR Thunder 2004 launcher in your browser.\ncd "$(dirname "$0")/app" || exit 1\nexec ./runtime/node launcher.mjs "$@"\n`,
};
const README = (plat, start, clangNote) => `NASCAR Thunder 2004 recompiled — ${VERSION} (${plat})

This is a framework that runs YOUR OWN copy of EA's NASCAR Thunder 2004 (original Xbox) on this computer. It contains
no game files and none of the game's code. You need a disc image of the game (.iso / .xiso) made from a copy you own.

Getting started
  1. Start the launcher: ${start}. It opens in your web browser.
  2. Setup tab -> "Game files": paste the path of your disc image and press Extract (about 3.2 GB is copied).
  3. Setup tab -> "Game code": press "Build game code" (5-15 minutes, once; it uses every processor core).
${clangNote}     If you skip this step the game still runs, but the first races stutter while it warms up a cache, and after that
     the game code takes about twice the processor time.
  4. Play tab -> Start game.
  The Help tab in the launcher explains everything else (drivers, teams, sponsors, tracks, careers, presets, keys).

Where things are: only ${start.replace(/^(double-click|run) /, "")} and this file are in this folder. Everything else is in app/,
including what the launcher makes for you (your game files, saves, presets and the built game code), so keep that
folder. To update, extract a newer version over this folder: your files in app/ are kept.

Optional: picture upscaling (Textures tab) needs Python 3 with numpy and pillow (the Setup tab can install them).
${plat.startsWith("macos") ? "\nmacOS: the first time, right-click Launch.command and choose Open (it is not from the App Store). If \"Build game code\"\nsays the compiler could not be started, allow it under System Settings -> Privacy & Security and build again.\n" : ""}
Included: Node.js ${NODE} (app/runtime/, licence in app/runtime/LICENSE)${clangNote.startsWith("     The compiler") ? `, and clang + wasm-ld from wasi-sdk ${WASI}
(app/tools/llvm/, licences there)` : ""}. NASCAR Thunder 2004 is a trademark of its owners;
this project is not affiliated with or endorsed by EA, NASCAR or Microsoft.
`;

// ---------------------------------------------------------------- Node runtime
async function nodeArchive(p) {
  const file = `node-${NODE}-${p.node}.${p.ext}`, local = join(CACHE, file);
  if (fs.existsSync(local)) return local;
  fs.mkdirSync(CACHE, { recursive: true });
  const base = `https://nodejs.org/dist/${NODE}/`; console.log(`downloading ${base}${file}`);
  const get = async u => { const r = await fetch(u); if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return Buffer.from(await r.arrayBuffer()); };
  const [buf, sums] = await Promise.all([get(base + file), get(base + "SHASUMS256.txt").then(b => b.toString())]);
  const want = sums.split("\n").find(l => l.trim().endsWith(" " + file))?.split(/\s+/)[0], have = createHash("sha256").update(buf).digest("hex");
  if (!want || want !== have) throw new Error(`${file}: checksum does not match nodejs.org's SHASUMS256.txt`);
  fs.writeFileSync(local, buf); return local;
}
// the binary and LICENSE out of Node's archive
function fromNodeArchive(path, p) {
  const want = name => name.endsWith("/" + p.bin) ? "bin" : /^[^/]+\/LICENSE$/.test(name) ? "license" : null, out = {};
  if (p.ext === "zip") for (const e of readZip(fs.readFileSync(path))) { const k = want(e.name); if (k) out[k] = e.data(); }
  else for (const e of readTar(zlib.gunzipSync(fs.readFileSync(path)))) { const k = e.type === "file" && want(e.name); if (k) out[k] = e.data; }
  if (!out.bin) throw new Error(`${basename(path)}: no ${p.bin} inside`);
  return out;
}

// ---------------------------------------------------------------- C compiler (wasi-sdk)
async function clangArchive(plat) {
  if (CLANG_ARCHIVES.has(plat)) return CLANG_ARCHIVES.get(plat);
  const file = `wasi-sdk-${WASI}.0-${WASI_PLAT[plat]}.tar.gz`, local = join(CACHE, file), pins = join(CACHE, "pins.json");
  const pin = (() => { try { return JSON.parse(fs.readFileSync(pins, "utf8")); } catch { return {}; } })();
  let buf;
  if (fs.existsSync(local)) buf = fs.readFileSync(local);
  else {
    const url = `https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI}/${file}`; console.log(`downloading ${url}`);
    const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); buf = Buffer.from(await r.arrayBuffer());
  }
  const sha = createHash("sha256").update(buf).digest("hex");
  if (pin[file] && pin[file] !== sha) throw new Error(`${file}: its SHA-256 changed since it was first downloaded (${pin[file].slice(0, 16)}… -> ${sha.slice(0, 16)}…): delete it from pins.json only if you trust the new file`);
  if (!pin[file]) { fs.mkdirSync(CACHE, { recursive: true }); pin[file] = sha; fs.writeFileSync(pins, JSON.stringify(pin, null, 2)); console.log(`${file}: SHA-256 ${sha} (pinned)`); }
  if (!fs.existsSync(local)) { fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(local, buf); }
  return local;
}
// A .tar.gz read as a stream (wasi-sdk's Windows archive is 520 MB, over 2 GB unpacked): every entry's name, type and
// link, and the data only of those keep(name) asks for.
async function scanTarGz(path, keep) {
  const out = []; let buf = Buffer.alloc(0), cur = null, longName = null, done = false;
  for await (const chunk of fs.createReadStream(path).pipe(zlib.createGunzip())) {
    if (done) continue;
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk; let p = 0;
    for (;;) {
      if (!cur) {
        if (buf.length - p < 512) break;
        const h = buf.subarray(p, p + 512); p += 512; if (!h[0]) { done = true; break; }
        const str = (o, n) => h.toString("utf8", o, o + n).replace(/\0.*$/s, ""), size = parseInt(str(124, 12).trim() || "0", 8), t = String.fromCharCode(h[156] || 48);
        const name = (longName ?? ((str(257, 6).startsWith("ustar") && str(345, 155) ? str(345, 155) + "/" : "") + str(0, 100))).replace(/^\.\//, ""); longName = null;
        const type = t === "0" || t === "\0" ? "file" : t === "1" ? "hard" : t === "2" ? "sym" : t === "L" || t === "x" ? t : "other";
        cur = { name, type, link: str(157, 100).replace(/^\.\//, ""), size, left: Math.ceil(size / 512) * 512, parts: type === "L" || type === "x" || (type === "file" && keep(name)) ? [] : null };
      }
      const n = Math.min(buf.length - p, cur.left); if (n <= 0 && cur.left) break;
      if (cur.parts) { const consumed = Math.ceil(cur.size / 512) * 512 - cur.left, take = Math.max(0, Math.min(n, cur.size - consumed)); if (take) cur.parts.push(Buffer.from(buf.subarray(p, p + take))); }
      p += n; cur.left -= n;
      if (cur.left) break;
      const data = cur.parts ? Buffer.concat(cur.parts) : null;
      if (cur.type === "L") longName = data.toString("utf8").replace(/\0.*$/s, "");
      else if (cur.type === "x") { const m = /\d+ path=([^\n]*)\n/.exec(data.toString("utf8")); if (m) longName = m[1]; }
      else out.push({ name: cur.name, type: cur.type, link: cur.link, data });
      cur = null;
    }
    buf = Buffer.from(buf.subarray(p));
  }
  return out;
}
// LLVM's licence texts for the version a wasi-sdk build was made from (wasi-sdk's archives carry none): llvm, clang
// and lld from the LLVM sources at that release tag, kept and pinned in the cache like the archives
async function llvmLicences(version) {
  const pins = join(CACHE, "pins.json"), pin = (() => { try { return JSON.parse(fs.readFileSync(pins, "utf8")); } catch { return {}; } })(), out = [];
  for (const part of ["llvm", "clang", "lld"]) {
    const file = `llvm-${version}-${part}-LICENSE.TXT`, local = join(CACHE, file);
    let buf = fs.existsSync(local) ? fs.readFileSync(local) : null;
    if (!buf) {
      const url = `https://raw.githubusercontent.com/llvm/llvm-project/llvmorg-${version}/${part}/LICENSE.TXT`; console.log(`downloading ${url}`);
      const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status} (or put that file in ${CACHE} as ${file})`); buf = Buffer.from(await r.arrayBuffer());
    }
    if (!/Apache License/.test(buf.toString("utf8"))) throw new Error(`${file} does not look like LLVM's licence`);
    const sha = createHash("sha256").update(buf).digest("hex");
    if (pin[file] && pin[file] !== sha) throw new Error(`${file}: changed since it was first downloaded`);
    if (!pin[file]) { pin[file] = sha; fs.mkdirSync(CACHE, { recursive: true }); fs.writeFileSync(pins, JSON.stringify(pin, null, 2)); }
    if (!fs.existsSync(local)) fs.writeFileSync(local, buf);
    out.push({ name: `LICENSE-${part}.txt`, data: buf });
  }
  return out;
}
// The shared libraries a program asks for: ELF (Linux) DT_NEEDED names, Mach-O (macOS) LC_LOAD_DYLIB names; [] for
// anything else (Windows: wasi-sdk's .exe files are self-contained; a .dll beside them is shipped as found)
function libNeeds(b) {
  const out = [];
  if (b.length > 64 && b.readUInt32BE(0) === 0x7f454c46 && b[4] === 2 && b[5] === 1) {          // ELF, 64-bit, little-endian
    const phoff = Number(b.readBigUInt64LE(32)), phsz = b.readUInt16LE(54), phn = b.readUInt16LE(56), loads = []; let dyn = null;
    for (let i = 0; i < phn; i++) { const o = phoff + i * phsz, type = b.readUInt32LE(o), off = Number(b.readBigUInt64LE(o + 8)), va = Number(b.readBigUInt64LE(o + 16)), fsz = Number(b.readBigUInt64LE(o + 32));
      if (type === 1) loads.push({ off, va, fsz }); if (type === 2) dyn = { off, fsz }; }
    if (!dyn) return out;
    const toOff = va => { const l = loads.find(l => va >= l.va && va < l.va + l.fsz); return l ? l.off + va - l.va : -1; };
    let strtab = -1; const needed = [];
    for (let o = dyn.off; o + 16 <= dyn.off + dyn.fsz; o += 16) { const tag = Number(b.readBigInt64LE(o)), val = Number(b.readBigUInt64LE(o + 8)); if (tag === 0) break; if (tag === 5) strtab = toOff(val); if (tag === 1) needed.push(val); }
    if (strtab >= 0) for (const n of needed) { const st = strtab + n, e = b.indexOf(0, st); out.push(b.toString("latin1", st, e)); }
  } else if (b.length > 32 && b.readUInt32LE(0) === 0xfeedfacf) {                                // Mach-O 64-bit (thin)
    let o = 32; const n = b.readUInt32LE(16);
    for (let i = 0; i < n && o + 8 <= b.length; i++) { const cmd = b.readUInt32LE(o), size = b.readUInt32LE(o + 4);
      if (cmd === 0xc || cmd === 0x80000018 || cmd === 0x8000001f) { const st = o + b.readUInt32LE(o + 8), e = b.indexOf(0, st); out.push(b.toString("utf8", st, e)); }
      o += size; }
  } else if (b.length > 8 && b.readUInt32BE(0) === 0xcafebabe) {                                 // Mach-O universal: the first slice
    const off = b.readUInt32BE(12), size = b.readUInt32BE(16); return libNeeds(b.subarray(off, off + size));
  }
  return out;
}
// clang and wasm-ld (the files they are, through any links), the libraries they load (from the archive's lib/,
// shipped under the names they are asked for: a zip holds no links), and the licence files
async function fromClangArchive(path, win) {
  const x = win ? "\\.exe" : "";
  const want = n => new RegExp(`(^|/)bin/(clang(-\\d+)?|wasm-ld|lld)${x}$`).test(n) || /(^|\/)bin\/[^/]+\.dll$/i.test(n) || /(^|\/)lib\/[^/]+\.(so([.-][^/]*)?|dylib)$/.test(n)
    || /^[^/]+\/(VERSION|[^/]*(LICENSE|NOTICE|COPYRIGHT)[^/]*)$/i.test(n) || /\/share\/(doc|licenses)\/.*(LICENSE|NOTICE|COPYING)[^/]*$/i.test(n);
  let all = await scanTarGz(path, want); const by = new Map(all.map(e => [e.name, e]));
  const target = (name, depth = 0) => { const e = by.get(name); if (!e || depth > 8) return null; if (e.type === "file") return name;
    const t = e.type === "hard" ? e.link : (e.link.startsWith("/") ? null : join(dirname(name), e.link).replace(/\\/g, "/"));
    return t ? target(t, depth + 1) : null; };
  const ex = win ? ".exe" : "", bin = [...by.keys()].find(n => new RegExp(`(^|/)bin/clang${x}$`).test(n));
  if (!bin) throw new Error(`${basename(path)}: no bin/clang${ex} inside`);
  const root = bin.slice(0, bin.length - `bin/clang${ex}`.length), tClang = target(bin), tLd = target(`${root}bin/wasm-ld${ex}`) ?? target(`${root}bin/lld${ex}`);
  if (!tClang || !tLd) throw new Error(`${basename(path)}: clang or wasm-ld missing`);
  // (a link to a file the first pass did not keep: read the archive again for exactly those)
  const miss = new Set([tClang, tLd].filter(t => !by.get(t).data));
  if (miss.size) for (const e of await scanTarGz(path, n => miss.has(n))) if (e.data) by.set(e.name, e);
  const files = [{ name: `bin/clang${ex}`, data: by.get(tClang).data, mode: 0o755 }, { name: `bin/wasm-ld${ex}`, data: by.get(tLd).data, mode: 0o755 }];
  let version = null;
  for (const [n, e] of by) { const rel = n.slice(root.length); if (!n.startsWith(root) || e.type !== "file" || !e.data) continue;
    if (/^bin\/[^/]+\.dll$/i.test(rel)) files.push({ name: rel, data: e.data, mode: 0o755 });
    else if (rel === "VERSION") version = /llvm-version:\s*([\d.]+)/.exec(e.data.toString("utf8"))?.[1] ?? null;
    else if (/^[^/]*(LICENSE|NOTICE|COPYRIGHT)[^/]*$/i.test(rel) || /^share\/(doc|licenses)\/.*(LICENSE|NOTICE|COPYING)[^/]*$/i.test(rel)) files.push({ name: rel.replace(/^share\/(doc|licenses)\//, "licenses/"), data: e.data }); }
  // the libraries clang and wasm-ld load, and the ones those load (system libraries are not in the archive: left out)
  const libs = new Map(), todo = [files[0].data, files[1].data];
  while (todo.length) for (const need of libNeeds(todo.pop())) {
    if (/^\/(usr|System)\//.test(need)) continue;
    const base = need.replace(/^@(rpath|loader_path|executable_path)\/(\.\.\/lib\/)?/, "").split("/").pop();
    if (libs.has(base)) continue;
    const t = target(`${root}lib/${base}`); if (!t || !by.get(t)?.data) continue;
    libs.set(base, by.get(t).data); todo.push(by.get(t).data);
  }
  for (const [base, data] of libs) files.push({ name: `lib/${base}`, data, mode: 0o755 });
  if (!files.some(f => /LICENSE/i.test(f.name))) {
    if (!version) throw new Error(`${basename(path)}: no licence file and no VERSION file saying which LLVM it is (the licence must ship with the compiler)`);
    files.push(...await llvmLicences(version));
  }
  return { files, llvm: version };
}

// ---------------------------------------------------------------- archives (no packages: zip and tar by hand)
const crc32 = zlib.crc32 ?? (() => { const T = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  return b => { let c = -1; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }; })();
function dosTime(d = new Date()) { return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() }; }
function writeZip(entries) {   // entries: { name, data, mode }
  const parts = [], central = [], { time, date } = dosTime(); let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8"), raw = e.data, comp = zlib.deflateRawSync(raw, { level: 9 }), crc = crc32(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(8, 8); lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(((0o100000 | (e.mode ?? 0o644)) << 16) >>> 0, 38); ch.writeUInt32LE(off, 42);
    parts.push(lh, name, comp); central.push(ch, name); off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
function readZip(b) {
  let e = b.length - 22; while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--; if (e < 0) throw new Error("not a zip file");
  const n = b.readUInt16LE(e + 10), out = []; let p = b.readUInt32LE(e + 16);
  for (let i = 0; i < n; i++) {
    const method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20), nl = b.readUInt16LE(p + 28), xl = b.readUInt16LE(p + 30), cl = b.readUInt16LE(p + 32), lo = b.readUInt32LE(p + 42);
    const name = b.toString("utf8", p + 46, p + 46 + nl); p += 46 + nl + xl + cl;
    out.push({ name, data: () => { const s = lo + 30 + b.readUInt16LE(lo + 26) + b.readUInt16LE(lo + 28), c = b.subarray(s, s + csize); return method === 8 ? zlib.inflateRawSync(c) : Buffer.from(c); } });
  }
  return out;
}
function readTar(b) {
  const out = []; let p = 0, longName = null;
  while (p + 512 <= b.length && b[p]) {
    const str = (o, n) => b.toString("utf8", p + o, p + o + n).replace(/\0.*$/s, ""), size = parseInt(str(124, 12).trim() || "0", 8), type = String.fromCharCode(b[p + 156] || 48);
    let name = longName ?? ((str(257, 6).startsWith("ustar") && str(345, 155) ? str(345, 155) + "/" : "") + str(0, 100)); longName = null;
    const data = b.subarray(p + 512, p + 512 + size);
    if (type === "L") longName = data.toString("utf8").replace(/\0.*$/s, "");
    else if (type === "x") { const m = /\d+ path=([^\n]*)\n/.exec(data.toString("utf8")); if (m) longName = m[1]; }
    else if (type === "0" || type === "\0") out.push({ name, type: "file", data, mode: parseInt(str(100, 8).trim() || "644", 8) });
    else if (type === "1" || type === "2") out.push({ name, type: type === "1" ? "hard" : "sym", link: str(157, 100), data });
    p += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}
function writeTar(entries) {   // entries: { name, data, mode }  (names under 100 bytes, or split into the ustar prefix)
  const blocks = [], now = Math.floor(Date.now() / 1000);
  for (const e of entries) {
    const h = Buffer.alloc(512); let name = e.name, prefix = "";
    if (Buffer.byteLength(name) > 100) { const i = name.lastIndexOf("/", 155); prefix = name.slice(0, i); name = name.slice(i + 1); }
    if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`path too long for tar: ${e.name}`);
    const oct = (v, n) => v.toString(8).padStart(n - 1, "0") + "\0";
    h.write(name, 0); h.write(oct(e.mode ?? 0o644, 8), 100); h.write(oct(0, 8), 108); h.write(oct(0, 8), 116); h.write(oct(e.data.length, 12), 124); h.write(oct(now, 12), 136);
    h.write("        ", 148); h.write("0", 156); h.write("ustar\0", 257); h.write("00", 263); h.write(prefix, 345);
    let sum = 0; for (const x of h) sum += x; h.write(oct(sum, 7) + " ", 148);
    blocks.push(h, e.data, Buffer.alloc((512 - (e.data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks), { level: 9 });
}

// ---------------------------------------------------------------- build
const { files, missing } = collect();
const bad = files.filter(f => DENY.some(r => r.test(f)));
if (bad.length) throw new Error(`refusing to package: ${bad.join(", ")}`);
if (missing.length) console.log(`note: referenced but not found (left out): ${missing.join(", ")}`);
const big = files.filter(f => fs.statSync(join(HERE, f)).size > 4 << 20);
if (big.length) throw new Error(`unexpectedly large files (game data?): ${big.join(", ")}`);
const total = files.reduce((n, f) => n + fs.statSync(join(HERE, f)).size, 0);
console.log(`${files.length} framework files, ${(total / 2 ** 20).toFixed(1)} MB; Node ${NODE}; version ${VERSION}`);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(join(OUT, `${NAME}-${VERSION}-files.txt`), files.join("\n") + "\n");

let failed = 0;
const here = `${process.platform === "win32" ? "win" : process.platform === "darwin" ? "darwin" : "linux"}-${process.arch}`;
for (const plat of PLATFORMS) {
  const p = PLAT[plat]; if (!p) { console.log(`${plat}: unknown platform (${Object.keys(PLAT).join(", ")})`); continue; }
  let rt;
  try { rt = fromNodeArchive(await nodeArchive(p), p); }
  catch (e) {
    if (!(LOCAL && here === p.sys.replace("win32", "win"))) { console.log(`${plat}: skipped (${e.message})${here === p.sys.replace("win32", "win") ? "; --local-node packs the Node running this script" : ""}`); continue; }
    console.log(`${plat}: ${e.message}; using the Node that runs this script (${process.execPath})`);
    const lic = [join(dirname(process.execPath), "..", "LICENSE"), join(dirname(process.execPath), "LICENSE")].find(f => fs.existsSync(f));
    rt = { bin: fs.readFileSync(process.execPath), license: lic ? fs.readFileSync(lic) : null };
  }
  const win = plat.startsWith("win"), mac = plat.startsWith("macos"), start = win ? "Launch.bat" : mac ? "Launch.command" : "launch.sh";
  const entries = files.map(f => ({ name: `${APP}/${f}`, data: fs.readFileSync(join(HERE, f)) }));
  let clangNote = `     It needs LLVM (clang) installed:\n       Windows: the LLVM-...-win64.exe installer from https://github.com/llvm/llvm-project/releases\n       macOS:   brew install llvm        Linux: your distribution's clang and lld packages\n`;
  if (CLANG) {
    try {
      const src = await clangArchive(plat), { files: tc, llvm } = await fromClangArchive(src, win);
      for (const f of tc) entries.push({ name: `${APP}/tools/llvm/${f.name}`, data: f.data, mode: f.mode });
      entries.push({ name: `${APP}/tools/llvm/SOURCE.txt`, data: Buffer.from(`clang and wasm-ld from ${basename(src)} (wasi-sdk ${WASI}, https://github.com/WebAssembly/wasi-sdk)\nSHA-256 of that archive: ${createHash("sha256").update(fs.readFileSync(src)).digest("hex")}\n${llvm ? `LLVM ${llvm}\n` : ""}Licence: Apache License 2.0 with LLVM Exceptions (files in this folder).\n`) });
      clangNote = `     The compiler it needs (clang, from LLVM) is included (app/tools/llvm): nothing to install.\n`;
      console.log(`${plat}: compiler ${tc.filter(f => /^bin\/(clang|wasm-ld)/.test(f.name)).map(f => basename(f.name)).join(" + ")}, ${(tc.reduce((n, f) => n + f.data.length, 0) / 2 ** 20).toFixed(0)} MB${tc.length > 2 ? ` (${tc.length} files with libraries and licences)` : ""}`);
    } catch (e) { console.log(`${plat}: NOT MADE: the compiler could not be included (${e.message}). Fix that, or pass --no-clang for packages without it.`); failed++; continue; }
  }
  entries.push({ name: `${APP}/runtime/${win ? "node.exe" : "node"}`, data: rt.bin, mode: 0o755 });
  if (rt.license) entries.push({ name: `${APP}/runtime/LICENSE`, data: rt.license });
  entries.push({ name: `${NAME}/${start}`, data: Buffer.from(win ? LAUNCH.win : mac ? LAUNCH.mac : LAUNCH.linux), mode: 0o755 });
  entries.push({ name: `${NAME}/README.txt`, data: Buffer.from(README(plat, win ? "double-click Launch.bat" : mac ? "double-click Launch.command" : "run ./launch.sh", clangNote).replace(/\n/g, win ? "\r\n" : "\n")) });
  const file = join(OUT, `${NAME}-${VERSION}-${plat}.${win || mac ? "zip" : "tar.gz"}`);
  fs.writeFileSync(file, win || mac ? writeZip(entries) : writeTar(entries));
  console.log(`${plat}: ${basename(file)} (${(fs.statSync(file).size / 2 ** 20).toFixed(1)} MB)`);
}
if (failed) { console.log(`${failed} package(s) not made`); process.exitCode = 1; }
