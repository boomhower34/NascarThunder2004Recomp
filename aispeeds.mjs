// aispeeds.mjs — the AI speed tables (AI_SPDS.DAT, one entry per TRCK.TPID, like TK_PHYS), read by the AISpeeds
// race component (loader 0x20290, relocation 0x20140, lookup 0x20340 -> 0x201C0 / 0x20240).
//
// Layout (offsets from the entry start, relocated at load):
//   +0x00  19 x { u32 line count, u32 offset } — one per TK_PHYS line group, the same lines in the same order
//   per group: count x { u32 node ring offset, u32 speed bytes offset } (0 = none)
//   node ring: 12-byte nodes { f32 position along the line (segment + t), s32 speed (mph), u32 next node offset },
//              the last pointing back to the first; a speed holds from its position on (0x20240)
//   speed bytes: 31 samples per segment + 1, mph, interpolated between samples (0x201C0); used when present
//   Lookups for the pit stall paths (groups 9 and 10) use group 11's first line (0x20340).
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

export const SAMPLES = 31;
export function parseAISpeeds(b) {
  const u32 = o => b.readUInt32LE(o), groups = [];
  for (let g = 0; g < 19; g++) {
    const n = u32(g * 8), off = u32(g * 8 + 4), lines = [];
    for (let i = 0; i < n; i++) {
      const no = u32(off + i * 8), bo = u32(off + i * 8 + 4), line = { nodes: null, bytes: null, _b: bo };
      if (no) { line.nodes = []; let p = no; do { line.nodes.push({ at: b.readFloatLE(p), speed: b.readInt32LE(p + 4) }); p = u32(p + 8); } while (p !== no && line.nodes.length < 10000); }
      lines.push(line);
    }
    groups.push(lines);
  }
  // byte arrays: each runs to the next array's start (or the end): the sizes follow the line's segments
  const starts = groups.flat().map(l => l._b).filter(Boolean).sort((a, c) => a - c);
  for (const l of groups.flat()) { if (l._b) { const end = starts.find(s => s > l._b) ?? b.length; l.bytes = [...b.subarray(l._b, end)]; } delete l._b; }
  return groups;
}
export function writeAISpeeds(groups) {
  const head = Buffer.alloc(19 * 8), tables = [], rings = [], arrays = []; let off = head.length;
  const tblOff = []; for (let g = 0; g < 19; g++) { head.writeUInt32LE(groups[g].length, g * 8); tblOff.push(off); off += groups[g].length * 8; }
  for (let g = 0; g < 19; g++) head.writeUInt32LE(groups[g].length ? tblOff[g] : off, g * 8 + 4);
  const ringAt = new Map(); for (const l of groups.flat()) if (l.nodes?.length) { ringAt.set(l, off); off += l.nodes.length * 12; }
  const bytesAt = new Map(); for (const l of groups.flat()) if (l.bytes?.length) { bytesAt.set(l, off); off += l.bytes.length; }
  const out = Buffer.alloc(off); head.copy(out, 0);
  groups.forEach((lines, g) => lines.forEach((l, i) => { const t = tblOff[g] + i * 8; out.writeUInt32LE(ringAt.get(l) ?? 0, t); out.writeUInt32LE(bytesAt.get(l) ?? 0, t + 4); }));
  for (const [l, p] of ringAt) l.nodes.forEach((n, k) => { const o = p + k * 12; out.writeFloatLE(n.at, o); out.writeInt32LE(n.speed, o + 4); out.writeUInt32LE(k + 1 < l.nodes.length ? o + 12 : p, o + 8); });
  for (const [l, p] of bytesAt) Buffer.from(l.bytes.map(v => Math.max(0, Math.min(255, Math.round(v))))).copy(out, p);
  return out;
}

if (process.argv[1] && basename(process.argv[1]) === "aispeeds.mjs") {
  const [cmd, file, entry] = process.argv.slice(2);
  const { parseTerf } = await import("./terf.mjs");
  const t = parseTerf(readFileSync(file)), list = entry !== undefined ? [+entry] : [...Array(t.count).keys()];
  if (cmd === "info") for (const i of list) { const g = parseAISpeeds(t.entry(i)); console.log(i, g.map((ls, k) => ls.length ? `${k}:${ls.map(l => (l.nodes ? `n${l.nodes.length}` : "") + (l.bytes ? `b${l.bytes.length}` : "")).join(",")}` : "").filter(Boolean).join(" ")); }
  else if (cmd === "roundtrip") { let same = 0; for (const i of list) { const b = t.entry(i), w = writeAISpeeds(parseAISpeeds(b)); const g1 = JSON.stringify(parseAISpeeds(b)), g2 = JSON.stringify(parseAISpeeds(w)); if (g1 === g2) same++; } console.log(`decoded content identical after rewriting: ${same} of ${list.length}`); }
}
