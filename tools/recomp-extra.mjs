// usage: node recomp-extra.mjs [DataDir]  (with NT04_JIT_CACHE pointing at the block caches of a played session)
// functions holding executed blocks (JIT caches) that no recompiled function contains -> recomp-extra.json (merged)
process.env.NT04_NO_JS_SCREENS = "1";
const fs = await import("node:fs");
const { openScreen } = await import("../src/game/uis-run.mjs");
const { loadImage, decode } = await import("../src/cpu/recomp.mjs");
const r = openScreen(process.argv[2] ?? new URL("../Data", import.meta.url).pathname, "flow", 0, { time: 0 }); const g = r.game.game;
const starts = new Set([...(g.cpu.wasm?.cache?.index?.keys() ?? []), ...(g.cpu.jit?.cache?.index?.keys() ?? [])]);
console.log("executed block starts", starts.size);
const im = loadImage(), man = JSON.parse(fs.readFileSync(new URL("../recomp.json", import.meta.url)));
const have = new Set(man.functions.map(f => f.entry)), ats = new Set(); for (const f of man.functions) for (const a of f.ats) ats.add(a);
function reach(s, limit = 30000) { const seen = new Set(), work = [s]; while (work.length && seen.size < limit) { let a = work.pop();
  while (im.isCode(a) && !seen.has(a)) { let d; try { d = decode(im, a); } catch { break; } if (!d.len) break; seen.add(a);
    if (d.kind === "jcc") { work.push(d.target); a += d.len; continue; } if (d.kind === "jmp") { work.push(d.target); break; }
    if (d.kind === "table") { for (let i = 0; i < 256; i++) { const t = im.r32(d.base + i * 4); if (!im.isCode(t)) break; work.push(t); } break; }
    if (d.kind === "ret" || d.kind === "jmpind") break; a += d.len; } } return seen; }
const extra = new Set(JSON.parse(fs.readFileSync(new URL("../src/cpu/recomp-extra.json", import.meta.url)))), cache = new Map(); let nores = 0, bad = 0;
for (const t of starts) { if (ats.has(t) || !im.isCode(t)) continue;
  let a = t; while (a > t - 0x10000 && !(im.r8(a - 1) === 0xcc && im.r8(a) !== 0xcc)) a--;
  if (im.r8(a - 1) !== 0xcc || a % 16) { nores++; continue; }
  if (have.has(a) || extra.has(a)) continue;
  let R = cache.get(a); if (!R) cache.set(a, R = reach(a)); if (!R.has(t)) { bad++; continue; }
  extra.add(a); }
console.log("no start", nores, "not reached", bad, "extra now", extra.size);
fs.writeFileSync(new URL("../src/cpu/recomp-extra.json", import.meta.url), JSON.stringify([...extra]));
process.exit(0);
