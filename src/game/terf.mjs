// terf.mjs — in-memory reader for EA "TERF" bundles, including compressed ones (COMP chunk).
//
// Layout (little-endian):
//   0x00 "TERF"  u32 alignment  u8 ? u8 ?  u16 ?  u16 alignment  u16 entryCount
//   chunks follow, each starting on an alignment boundary, each { char tag[4], u32 chunkSize (incl. this header) }:
//   "DIR1"  entryCount x { u32 offset (relative to the DATA chunk), u32 storedSize }
//   "COMP"  (optional) entryCount x { u32 method, u32 uncompressedSize }   method: 0 NONE, 5 LZH1 (see ea-lzh1.mjs)
//   "HSH1"  (optional, e.g. CARDATA.DAT) name hash table, skipped
//   "DATA"  entry bytes
// Read path in the game: resource open 0x118A70 -> read entry 0x11A390 -> 0x1194F0 -> codec dispatcher 0x122280.

import { decompress, Methods } from "./ea-lzh1.mjs";

// The first chunk starts at the u32 at 0x04. Later chunks follow the previous one, padded either to the
// small alignment at 0x0C (e.g. 4, nested UI bundles) or to the u32 at 0x04 (e.g. 0x800, MOVIES.DAT).
const TAGS = new Set(["DIR1", "COMP", "DATA", "HSH1"]);
function nextChunk(buf, pos, size, align) {
  const end = pos + Math.max(size, 8), small = buf.readUInt16LE(12) || 1;
  for (const a of [small, align]) {
    const p = Math.ceil(end / a) * a;
    if (p + 8 <= buf.length && TAGS.has(buf.toString("latin1", p, p + 4))) return p;
  }
  return Math.ceil(end / align) * align;
}

export function isTerf(buf) { return buf.length >= 16 && buf.toString("latin1", 0, 4) === "TERF"; }

export function parseTerf(buf) {
  if (!isTerf(buf)) throw new Error("not a TERF bundle");
  const align = buf.readUInt32LE(4), count = buf.readUInt16LE(14);
  let pos = align, dir = -1, comp = -1, data = -1, hash = -1;
  while (pos + 8 <= buf.length && data < 0) {
    const tag = buf.toString("latin1", pos, pos + 4), size = buf.readUInt32LE(pos + 4);
    if (tag === "DIR1") dir = pos;
    else if (tag === "COMP") comp = pos;
    else if (tag === "DATA") { data = pos; break; }
    else if (tag === "HSH1") hash = pos;                  // name hashes (lookup by name; not needed for index access)
    else throw new Error(`unexpected TERF chunk "${tag}" at 0x${pos.toString(16)}`);
    pos = nextChunk(buf, pos, size, align);
  }
  if (dir < 0 || data < 0) throw new Error("TERF: DIR1/DATA chunk not found");
  const entries = [];
  for (let i = 0; i < count; i++) {
    const offset = data + buf.readUInt32LE(dir + 8 + 8 * i), storedSize = buf.readUInt32LE(dir + 12 + 8 * i);
    const method = comp >= 0 ? buf.readUInt32LE(comp + 8 + 8 * i) : 0;
    const size = comp >= 0 ? buf.readUInt32LE(comp + 12 + 8 * i) : storedSize;
    if (offset + storedSize > buf.length) throw new Error(`TERF: entry ${i} runs past end of file`);
    entries.push({ index: i, offset, storedSize, method, methodName: Methods[method] ?? `#${method}`, size });
  }
  let cache = new Map();
  const entry = i => {
    if (!cache.has(i)) {
      const e = entries[i];
      cache.set(i, decompress(e.method, buf.subarray(e.offset, e.offset + e.storedSize), e.size));
    }
    return cache.get(i);
  };
  return { align, count, compressed: comp >= 0, entries, entry, buf };
}

// One entry of a TERF bundle on disk without reading the whole file (the video bundles are 100-300 MB): the header
// chunks are read from the start of the file, the entry itself with one positioned read. Headers are cached per path.
const fileHeads = new Map();
export function readTerfEntry(fs, path, index) {
  let head = fileHeads.get(path);
  if (!head) {
    const fd = fs.openSync(path, "r");
    try {
      const size = fs.fstatSync(fd).size;
      for (let n = 0x10000; ; n *= 4) {
        const buf = Buffer.alloc(Math.min(n, size)); fs.readSync(fd, buf, 0, buf.length, 0);
        head = terfHead(buf);
        if (head || buf.length >= size) break;
      }
    } finally { fs.closeSync(fd); }
    if (!head) throw new Error(`TERF: no header in ${path}`);
    fileHeads.set(path, head);
  }
  const e = head.entries[index]; if (!e) return null;
  const fd = fs.openSync(path, "r");
  try { const b = Buffer.alloc(e.storedSize); fs.readSync(fd, b, 0, b.length, e.offset); return e.method ? decompress(e.method, b, e.size) : b; }
  finally { fs.closeSync(fd); }
}
function terfHead(buf) {
  if (!isTerf(buf)) throw new Error("not a TERF bundle");
  const align = buf.readUInt32LE(4), count = buf.readUInt16LE(14);
  let pos = align, dir = -1, comp = -1, data = -1;
  while (pos + 8 <= buf.length) {
    const tag = buf.toString("latin1", pos, pos + 4), size = buf.readUInt32LE(pos + 4);
    if (tag === "DIR1") dir = pos; else if (tag === "COMP") comp = pos; else if (tag === "DATA") { data = pos; break; }
    else if (tag !== "HSH1") throw new Error(`unexpected TERF chunk "${tag}"`);
    if (pos + size > buf.length) return null;
    pos = nextChunk(buf, pos, size, align);
  }
  if (dir < 0 || data < 0 || dir + 8 + 8 * count > buf.length) return null;
  const entries = [];
  for (let i = 0; i < count; i++) entries.push({ offset: data + buf.readUInt32LE(dir + 8 + 8 * i), storedSize: buf.readUInt32LE(dir + 12 + 8 * i),
    method: comp >= 0 ? buf.readUInt32LE(comp + 8 + 8 * i) : 0, size: comp >= 0 ? buf.readUInt32LE(comp + 12 + 8 * i) : buf.readUInt32LE(dir + 12 + 8 * i) });
  return { count, entries };
}
