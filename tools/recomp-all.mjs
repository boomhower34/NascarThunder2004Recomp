// recomp-all.mjs — every function of the game image for a full static build -> recomp-all.json
// Start: the known function lists (recomp-functions.json, recomp-executed.json, recomp-extra.json); add every
// 16-aligned address that follows int3 padding (MSVC function alignment) and every direct call target, until nothing
// new turns up. A candidate is kept when its code decodes: no unsupported/undecodable instruction in the first
// few, and the walk stays inside the code section.
import fs from "node:fs";
import { loadImage, decode } from "../src/cpu/recomp.mjs";
const im = loadImage(), rd = f => fs.existsSync(new URL(f, import.meta.url)) ? JSON.parse(fs.readFileSync(new URL(f, import.meta.url))) : [];
const known = new Set([...rd("../src/cpu/recomp-functions.json"), ...rd("../src/cpu/recomp-executed.json"), ...rd("../src/cpu/recomp-extra.json")].filter(a => im.isCode(a)));
let lo = Infinity, hi = 0; for (let a = 0x10000; a < 0x400000; a += 0x1000) if (im.isCode(a)) { lo = Math.min(lo, a); hi = Math.max(hi, a + 0x1000); }
// walk a function: instruction addresses, direct call targets, whether its start looks like code
function walk(s, limit = 40000) {
  const seen = new Set(), calls = new Set(), work = [s]; let bad = 0, first = 0;
  while (work.length && seen.size < limit) { let a = work.pop();
    while (im.isCode(a) && !seen.has(a)) { let d; try { d = decode(im, a); } catch { d = null; }
      if (!d || !d.len) { if (seen.size < 8) bad++; break; }
      if (d.kind === "unsupported") { if (seen.size < 8 && /opcode|0f /.test(d.why)) bad++; seen.add(a); a += d.len; continue; }
      seen.add(a); if (a === s) first = 1;
      if (d.kind === "call" && im.isCode(d.target)) calls.add(d.target);
      if (d.kind === "jcc") { work.push(d.target); a += d.len; continue; }
      if (d.kind === "jmp") { work.push(d.target); break; }
      if (d.kind === "table") { for (let i = 0; i < 1024; i++) { const t = im.r32(d.base + i * 4); if (!im.isCode(t)) break; work.push(t); } break; }
      if (d.kind === "ret" || d.kind === "jmpind") break; a += d.len; } }
  return { seen, calls, ok: first && bad === 0 && seen.size > 0 };
}
const cand = new Set(known);
for (let a = lo; a < hi; a += 16) if (im.isCode(a) && im.r8(a - 1) === 0xcc && im.r8(a) !== 0xcc) cand.add(a);
const all = new Set(), rejected = []; let queue = [...cand];
while (queue.length) { const next = [];
  for (const a of queue) { if (all.has(a)) continue; const w = walk(a);
    if (!w.ok && !known.has(a)) { rejected.push(a); continue; } all.add(a);
    for (const t of w.calls) if (!all.has(t) && !cand.has(t)) { cand.add(t); next.push(t); } }
  queue = next; }
// instruction coverage
const cov = new Set(); for (const a of all) for (const x of walk(a).seen) cov.add(x);
const list = [...all].sort((x, y) => x - y);
fs.writeFileSync(new URL("../src/cpu/recomp-all.json", import.meta.url), JSON.stringify(list));
console.log(`known ${known.size}, padding starts ${cand.size - known.size}, functions ${list.length}, rejected ${rejected.length}; instructions reached ${cov.size}`);
