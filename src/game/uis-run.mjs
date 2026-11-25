#!/usr/bin/env node
// uis-run.mjs — open a UIStudio screen in the Node VM (global screen + target screen), run its init scripts with
// stubbed game functions, then draw the resulting state to a PNG and report what the scripts asked of the game.
//
// openScreen(dataDir, "flow") boots through the game's Interface process instead of opening a screen.
// usage: node uis-run.mjs <Data dir> <group> <screen> <out.png> [--args a,b,c] [--press m1,m2..] [--gap ms] [--time ms (default 3000)] [--width N] [--trace]

import { findConfig, loadConfig, applyConfig, withRoster, withTracks, withSchedules, withCareer, withSponsors } from "./nt04-config.mjs";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseTerf } from "./terf.mjs";
import { convertXbe } from "../setup/xbe2pe.mjs";
import { decodeMMAP } from "./mmap-tex.mjs";
import { screensIn } from "./uis-screen.mjs";
import { UIVM } from "./uis-vm.mjs";
import { Assets, Canvas, renderScreen, W } from "./uis-render.mjs";
import { openDatabases } from "./nascar-db.mjs";
import { installNatives } from "./uis-natives.mjs";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));

export function openScreen(dataDir, group, screen, { trace = false, natives = {}, time = 3000, args = [], stubs = false, presses = [], gap = 600, onPress = null, saveDir, config, seed = null } = {}) {
  const assets = new Assets(dataDir), logs = [];
  const vm = new UIVM({ assets, log: s => { logs.push(s); if (trace) console.log("  " + s); } });
  Object.assign(vm.natives, natives);
  vm.videoDuration = (g, e) => assets.videoDuration(g, e);
  // Game functions: database from NASCAR.DB + GMODEDB.DAT when present.
  const dbs = ["NASCAR.DB", "GMODEDB.DAT"].map(f => join(dataDir, f)).filter(existsSync);
  const db = stubs || !dbs.length ? null : openDatabases(dbs);        // fresh per run: the game writes to it (profiles, car owners)
  // configuration overlay (nt04-config.mjs): applied now and again whenever the game reloads NASCAR.DB
  const cfg = stubs ? null : withSponsors(withCareer(withSchedules(withTracks(withRoster(loadConfig(typeof config === "object" ? config : findConfig(dataDir, config)), dataDir), dataDir), dataDir), dataDir), dataDir);
  if (db && !stubs) for (const p of applyConfig(db, cfg ?? {})) logs.push(`config: ${p}`);   // (defaults such as caution laps apply without a configuration too)
  // season settings: the schedule choices are fixed texts ("12 Races" / "24 Races" / "36 Races" = SCHD 0 / 1 / 2);
  // they show the points races each schedule really has (exhibitions: RACE.ASTY 1 All-Star, 2 Shootout, 4 Open)
  if (db) vm.textPatch = (group, screen, strings) => { const out = [], live = r => r ?? db;
    strings.forEach((s, i) => { const m = /^(12|24|36) Races$/.exec(s.text); if (!m) return; const d = live(gameDb?.()), scid = { 12: 0, 24: 1, 36: 2 }[m[1]] + (cfg?.careerSchedules && d.tables.get("GINF")?.rows[0]?.GMOD === 2 ? 4 : 0);
      const ex = new Set(d.tables.get("RACE").rows.filter(r => [1, 2, 4].includes(r.ASTY)).map(r => r.RAID));
      const n = d.tables.get("SCHD").rows.filter(r => r.SCID === scid && !ex.has(r.RAID)).length; if (n && String(n) !== m[1]) out.push([i, `${n} Race${n === 1 ? "" : "s"}`]); });
    return out; };
  let gameDb = null;
  // The game's executable (for natives run from its own code): next to the Data folder, else next to this file.
  // (made from default.xbe the first time: xbe2pe.mjs; the game set up from a disc image has only the XBE)
  for (const d of [join(dataDir, ".."), join(here, "..", "..")]) if (!existsSync(join(d, "default.exe")) && existsSync(join(d, "default.xbe"))) {
    try { convertXbe(join(d, "default.xbe"), join(d, "default.exe")); console.log(`made ${join(d, "default.exe")} from default.xbe`); } catch (e) { console.log(`could not make default.exe from default.xbe: ${e.message}`); } }
  const exePath = [join(dataDir, "..", "default.exe"), join(here, "../../default.exe")].find(existsSync);
  const game = stubs ? null : installNatives(vm, { db, assets, exePath, dataDir, saveDir: saveDir ?? process.env.NT04_SAVE, config: cfg, flow: group === "flow", seed });
  gameDb = () => game?.game?.db;                // (the game reloads NASCAR.DB: labels read its live copy)
  // screens of a UI context the game is not drawing now are not drawn (gamecode uiContextDrawn: the race HUD)
  if (game?.game) vm.drawn = sc => game.game.uiContextDrawn(sc.ctx);
  if (game?.game?.texGroups) assets.groupOverride = game.game.texGroups;   // texture group ids as the game registered them
  // uis_smnm 89-93 are empty 32 x 32 slots: the game draws a player's own Create-A-Car number into the loaded slot
  // (0xF8BE0 / 0xF4C50 -> 0x6DF60: cache entry 0x59 + player, then the digits copied into its pixels; the car record's
  // number style +0xC0 is 0x59 + player for a CTYP 6 car, 0x4EDB4). Those entries are read from the game's copy.
  if (game?.game?.uiCacheBlock) {
    const dyn = new Map();
    assets.dynamic = (group, entry) => {
      if (assets.groupName(group) !== "uis_smnm" || entry < 0x59 || entry > 0x5d) return undefined;
      // (no block: the race weekend's cache entries are freed on the way back to the hub, so the last picture the game
      // drew there is kept for the hub's screens)
      const blk = game.game.uiCacheBlock(group, entry); if (!blk?.data) return dyn.get(entry)?.tex ?? undefined;
      const d = Buffer.from(blk.data), mem = vm.mem, desc = d.readUInt32LE(0x18), ph = d.readUInt32LE(0x1c);
      const w = d.readUInt16LE(desc), h = d.readUInt16LE(desc + 2), pix = 0x80 + d.readUInt32LE(desc + 0xc);
      const ranges = [[pix, w * h]]; if (ph) ranges.push([0x80 + d.readUInt32LE(ph + 8), 1024]);
      for (const [o, n] of ranges) for (let i = 0; i < n && o + i < d.length; i++) d[o + i] = mem.r8(blk.b + o + i);
      const sig = ranges.map(([o, n]) => d.toString("base64", o, Math.min(d.length, o + n))).join(":");
      const prev = dyn.get(entry); if (prev?.sig === sig) return prev.tex;
      let tex = null; try { tex = decodeMMAP(d); } catch {}
      dyn.set(entry, { sig, tex }); return tex;
    };
  }
  const g = parseTerf(readFileSync(join(dataDir, "UIS_GSCR.DAT")));
  vm.loadScreen(g.entry(0), 18, 0, { isGlobal: true });
  const all = screensIn(readFileSync(join(dataDir, "UIS_ALL.DAT")));
  vm.source = (g, s) => all.find(x => x.group === g && x.screen === s)?.buf ?? null;
  let s = null;
  if (group === "flow") {
    // the game's own boot: the Interface process starts in Main Loading and opens the frontend itself
    if (!game?.game) throw new Error("flow boot needs default.exe (game code)");
    game.game.startInterface();
  } else {
    const sc = all.find(x => x.group === group && x.screen === screen);
    if (!sc) throw new Error(`no screen ${group}/${screen}`);
    s = vm.loadScreen(sc.buf, group, screen);
    vm.open(s, args);
  }
  vm.runFor(time);
  // Simulated controller: each entry is a message id (0 A, 2 up, 3 down, 6 X, 7 START, 9 back) sent from pad 0.
  presses.forEach((msg, i) => { vm.press(msg, 0); vm.runFor(gap); onPress?.(i, msg, vm); });
  return { vm, sc: s, assets, logs, game };
}

// Draw every open screen in stack order (0x13AA60 draws screens in the order they were added).
export function drawScreen(r, outW = W) {
  const canvas = new Canvas(), stats = { elements: 0, texts: 0, states: 0, skipped: 0, screens: [] };
  for (const sc of r.vm.screens) {
    if (r.vm.drawn && !r.vm.drawn(sc)) continue;          // as the live page (main.mjs) draws
    const st = renderScreen(sc.data, r.assets, canvas, { layout: sc.layout, mem: r.vm.mem, base: sc.base, video: r.vm.video });
    for (const k of ["elements", "texts", "states", "skipped"]) stats[k] += st[k];
    stats.screens.push(`${sc.group}/${sc.screen}`);
  }
  return { png: canvas.png(outW), stats };
}

function main() {
  const args = process.argv.slice(2), trace = args.includes("--trace");
  const opt = k => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : null; };
  const outW = opt("--width") ?? W, time = opt("--time") ?? 3000;
  const list = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1].split(",").map(Number) : []; };
  const sargs = list("--args"), presses = list("--press"), gap = opt("--gap") ?? 600;
  const [dataDir, g, s, out] = args.filter((a, i) => !a.startsWith("--") && !["--width", "--time", "--args", "--press", "--gap"].includes(args[i - 1]));
  if (!out) { console.error("usage: node uis-run.mjs <Data dir> <group> <screen> <out.png> [--width N] [--trace]"); process.exit(1); }
  const r = openScreen(dataDir, Number(g), Number(s), { trace, time, args: sargs, presses, gap });
  const { png, stats } = drawScreen(r, outW);
  writeFileSync(out, png);
  const active = r.sc.layout.states.filter((_, i) => r.vm.active(r.sc, i)).length;
  console.log(`${out}: t=${Math.round(r.vm.time)}ms, ${r.vm.timers.length} timers live, ${r.vm.stats.scripts} scripts, ${r.vm.stats.insns} instructions, ${r.vm.stats.tweens} tweens, ` +
              `${active}/${r.sc.layout.states.length} states active; screens ${stats.screens.join(" ")}; drew ${stats.elements} elements, ${stats.texts} texts`);
  const nat = [...r.vm.nativeCalls].sort((a, b) => a[0] - b[0]).map(([id, n]) => `${(id >>> 0).toString(16)}${n > 1 ? "x" + n : ""}`);
  if (nat.length) console.log(`native calls: ${nat.join(" ")}`);
  if (r.game?.missing.size) console.log(`not implemented (returned 0): ${[...r.game.missing.keys()].map(k => k.toString(16)).join(" ")}`);
  if (r.game?.actions.length) console.log(`game actions: ${r.game.actions.map(a => a.screen + ":" + a.id.replace("0x8000", "")).join(" ")}`);
  console.log(`focus ${r.vm.focus ? r.vm.focus.group + "/" + r.vm.focus.screen : "-"}`);
  if (!r.vm.screens.length && r.game) console.log(`frontend finished; race set up: ${JSON.stringify(r.game.raceSetup())}`);
  if (r.logs.length) console.log(`${r.logs.length} log lines, first: ${r.logs.slice(0, 5).join(" | ")}`);
}

if (process.argv[1]?.endsWith("uis-run.mjs")) main();
