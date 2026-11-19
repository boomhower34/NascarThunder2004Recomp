#!/usr/bin/env node
// terf-extract.mjs — list / extract entries from EA "TERF" bundles (e.g. MOVIES.DAT, PRMOVIES.DAT)
// and optionally convert EA MAD movies to MP4 or WebM with FFmpeg.
//
// Layout (little-endian), as found in MOVIES.DAT:
//   0x0000  "TERF"  u32 alignment (0x800)  u8 ? u8 ?  u16 ?  u16 alignment  u16 entryCount
//   then chunks, each starting on an alignment boundary:
//   "DIR1"  u32 chunkSize, then entryCount x { u32 offset, u32 size }   (offset is relative to the DATA chunk)
//   "COMP"  optional: entryCount x { u32 method, u32 uncompressedSize }  (0 NONE, 5 LZH1 — see ea-lzh1.mjs)
//   "DATA"  u32 chunkSize, entry bytes follow (entry 0 usually starts at DATA + alignment)
// The movie with index N in the game's PlayMovie(bundle, N, ...) is directory entry N.
//
// Usage:
//   node terf-extract.mjs list    <bundle.dat>
//   node terf-extract.mjs extract <bundle.dat> <outDir> [--index N]
//   node terf-extract.mjs convert <bundle.dat> <outDir> [--index N] [--format mp4|webm]
//
// "convert" needs ffmpeg on PATH (it decodes EA Madcow video + EA ADPCM audio).

import { openSync, readSync, closeSync, mkdirSync, writeFileSync, fstatSync, unlinkSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { spawnSync } from "node:child_process";
import { decompress, Methods } from "./ea-lzh1.mjs";

function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  const n = readSync(fd, buf, 0, len, pos);
  if (n !== len) throw new Error(`short read at 0x${pos.toString(16)}`);
  return buf;
}

export function readTerf(path) {
  const fd = openSync(path, "r");
  const fileSize = fstatSync(fd).size;
  const hdr = readAt(fd, 0, 16);
  if (hdr.toString("latin1", 0, 4) !== "TERF") throw new Error(`${path}: not a TERF bundle`);
  const align = hdr.readUInt32LE(4);
  const count = hdr.readUInt16LE(14);

  // Walk chunks from the first alignment boundary.
  // Chunks: first at the u32 at 0x04; later ones padded to the u16 at 0x0C or to the u32 at 0x04.
  const small = hdr.readUInt16LE(12) || 1;
  const tagAt = p => p + 8 <= fileSize ? readAt(fd, p, 4).toString("latin1") : "";
  let pos = align, dirChunk = null, compChunk = null, dataStart = null;
  while (pos + 8 <= fileSize && dataStart === null) {
    const ch = readAt(fd, pos, 8);
    const tag = ch.toString("latin1", 0, 4);
    const size = ch.readUInt32LE(4);
    if (tag === "DIR1") dirChunk = pos;
    else if (tag === "COMP") compChunk = pos;
    else if (tag === "DATA") { dataStart = pos; break; }
    else throw new Error(`unexpected chunk "${tag}" at 0x${pos.toString(16)}`);
    const end = pos + Math.max(size, 8), a = Math.ceil(end / small) * small;
    pos = ["DIR1", "COMP", "DATA"].includes(tagAt(a)) ? a : Math.ceil(end / align) * align;
  }
  if (dirChunk === null || dataStart === null) throw new Error("DIR1/DATA chunk not found");

  const dir = readAt(fd, dirChunk + 8, count * 8);
  const comp = compChunk === null ? null : readAt(fd, compChunk + 8, count * 8);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const offset = dataStart + dir.readUInt32LE(i * 8);
    const size = dir.readUInt32LE(i * 8 + 4);
    if (offset + size > fileSize) throw new Error(`entry ${i} runs past end of file`);
    const magic = readAt(fd, offset, Math.min(4, size)).toString("latin1");
    const method = comp ? comp.readUInt32LE(i * 8) : 0;
    const rawSize = comp ? comp.readUInt32LE(i * 8 + 4) : size;
    entries.push({ index: i, offset, size, magic, method, rawSize });
  }
  return { fd, align, count, dataStart, entries };
}

function parseArgs(argv) {
  const opts = { index: null, format: "mp4" };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--index") opts.index = Number(argv[++i]);
    else if (argv[i] === "--format") opts.format = argv[++i];
    else pos.push(argv[i]);
  }
  return { pos, opts };
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opts } = parseArgs(rest);
  const [bundle, outDir] = pos;
  if (!cmd || !bundle || (cmd !== "list" && !outDir)) {
    console.error("usage: node terf-extract.mjs list|extract|convert <bundle.dat> [outDir] [--index N] [--format mp4|webm]");
    process.exit(1);
  }
  const t = readTerf(bundle);
  const stem = basename(bundle, extname(bundle)).toLowerCase();
  const pick = opts.index === null ? t.entries : t.entries.filter(e => e.index === opts.index);
  if (opts.index !== null && pick.length === 0) throw new Error(`no entry ${opts.index} (bundle has ${t.count})`);

  if (cmd === "list") {
    console.log(`${bundle}: ${t.count} entries, alignment 0x${t.align.toString(16)}, DATA at 0x${t.dataStart.toString(16)}`);
    for (const e of pick)
      console.log(`${String(e.index).padStart(3)}  offset 0x${e.offset.toString(16).padStart(8, "0")}  size ${String(e.size).padStart(10)}` +
                  (e.method ? `  ${Methods[e.method] ?? "#" + e.method} -> ${e.rawSize}` : `  ${e.magic}`));
  } else if (cmd === "extract" || cmd === "convert") {
    mkdirSync(outDir, { recursive: true });
    for (const e of pick) {
      const name = `${stem}_${String(e.index).padStart(2, "0")}`;
      const raw = join(outDir, `${name}.mad`);
      const bytes = decompress(e.method, readAt(t.fd, e.offset, e.size), e.rawSize);
      if (cmd === "extract") {
        const m = bytes.toString("latin1", 0, 4), ext = /^[A-Z0-9]{4}$/.test(m) ? m.toLowerCase() : "bin";
        const p = join(outDir, `${name}.${ext}`);
        writeFileSync(p, bytes); console.log(`wrote ${p}`); continue;
      }
      writeFileSync(raw, bytes);
      const out = join(outDir, `${name}.${opts.format}`);
      const codec = opts.format === "webm"
        ? ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32", "-c:a", "libopus"]
        : ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-c:a", "aac", "-movflags", "+faststart"];
      const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "ea", "-i", raw, ...codec, out], { stdio: "inherit" });
      if (r.error) throw new Error(`could not run ffmpeg: ${r.error.message}`);
      if (r.status !== 0) { console.error(`ffmpeg failed for entry ${e.index}`); continue; }
      unlinkSync(raw);
      console.log(`wrote ${out}`);
    }
  } else {
    throw new Error(`unknown command "${cmd}"`);
  }
  closeSync(t.fd);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("terf-extract.mjs")) main();
