#!/usr/bin/env node
// uis-audit.mjs — opens every frontend screen (all groups except 3, the in-race HUD) with the game functions
// wired (JS ports + the game's own code through the x86 interpreter), runs it for a second and presses a few
// buttons, then reports what failed: x86 errors (unknown opcodes, calls into unported systems), queries the
// database layer could not run, stubbed system calls, and natives nobody implements.
//
// usage: node uis-audit.mjs <Data folder> [--group G] [--screen S] [--json out.json]

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openScreen } from "./uis-run.mjs";
import { screensIn } from "./uis-screen.mjs";

const argv = process.argv.slice(2), opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const dataDir = argv[0];
const list = screensIn(readFileSync(join(dataDir, "UIS_ALL.DAT")))
  .filter(s => s.group !== 3 && (opt("--group") === undefined || s.group === +opt("--group")) && (opt("--screen") === undefined || s.screen === +opt("--screen")));
const issues = new Map(); const add = (k, where) => { const e = issues.get(k) ?? { n: 0, where: new Set() }; e.n++; e.where.add(where); issues.set(k, e); };
for (const s of list) {
  const where = `${s.group}/${s.screen}`;
  try {
    const r = openScreen(dataDir, s.group, s.screen, { time: 800, presses: [3, 0, 9], gap: 400 });
    for (const l of r.logs) if (!/post 9 .*not modelled|^open .*no such screen/.test(l)) add(l.replace(/0x[0-9a-f]{7,8}/g, "@").slice(0, 220), where);
    for (const [id, n] of r.game?.missing ?? []) add(`no implementation: native 0x${id.toString(16)}`, where);
    for (const [k] of r.game?.game?.unknown ?? []) add(`stubbed: ${k}`, where);
  } catch (e) { add(`crash: ${e.message.slice(0, 200)}`, where); }
}
const rows = [...issues].sort((a, b) => b[1].where.size - a[1].where.size);
for (const [k, e] of rows) console.log(`${String(e.where.size).padStart(3)} screens  ${k}   [${[...e.where].slice(0, 8).join(" ")}${e.where.size > 8 ? " ..." : ""}]`);
console.log(`\n${list.length} screens audited, ${rows.length} distinct issues`);
if (opt("--json")) writeFileSync(opt("--json"), JSON.stringify(rows.map(([k, e]) => ({ issue: k, screens: [...e.where] })), null, 1));
