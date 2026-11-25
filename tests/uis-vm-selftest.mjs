#!/usr/bin/env node
// uis-vm-selftest.mjs — regression test for uis-vm.mjs: opens every screen in uis_all.dat in the VM with stubbed game
// functions, runs 1 simulated second, and checks that no script aborts; then checks known title-screen behaviour and
// drives the main menu with simulated controller input.
//
// usage: node uis-vm-selftest.mjs <Data folder>

import { readFileSync, mkdtempSync, rmSync, existsSync, readdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openScreen } from "../src/game/uis-run.mjs";
import { screensIn } from "../src/game/uis-screen.mjs";

const dataDir = process.argv[2];
if (!dataDir) { console.error("usage: node uis-vm-selftest.mjs <Data folder>"); process.exit(1); }
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };

const list = screensIn(readFileSync(join(dataDir, "UIS_ALL.DAT")));
let aborted = 0, scripts = 0, insns = 0; const natives = new Set(), bad = [];
for (const s of list) {
  try {
    const r = openScreen(dataDir, s.group, s.screen, { time: 1000 });
    scripts += r.vm.stats.scripts; insns += r.vm.stats.insns;
    const a = r.logs.filter(l => l.includes("aborted"));
    if (a.length) { aborted++; bad.push(`${s.group}/${s.screen}: ${a[0]}`); }
    for (const id of r.vm.nativeCalls.keys()) natives.add(id >>> 0);
  } catch (e) { aborted++; bad.push(`${s.group}/${s.screen}: ${e.message}`); }
}
check(list.length === 196, `screens found: ${list.length}`);
check(aborted === 0, `screens run without aborts: ${list.length - aborted}/${list.length} (${scripts} scripts, ${insns} instructions)`);
bad.slice(0, 5).forEach(b => console.log("     " + b));
console.log(`     game functions called: ${natives.size}`);

// Title screen: scripts replace the authored "Press START Button to Begin" with string 0 and start the pulse tween.
const t = openScreen(dataDir, 0, 2, { time: 500 });
const textRef = t.sc.layout.states[2].children[0].items[0];
const rec = t.vm.mem.r32(t.sc.base + textRef.data + 0x20), text = t.vm.mem.cstr(t.vm.mem.r32(rec + 8));
check(text === "Press START button", `title prompt text = "${text}"`);
check(t.vm.timers.some(x => x.prop === 0x16), "title prompt scale tween running");
const scale = t.vm.mem.rf(t.vm.stateHdr(t.sc, 2) + 0x2c);       // state 2 pulses from 1.0 towards 0.9
check(scale > 0.9 && scale < 1.0, `title prompt scale animating (${scale.toFixed(3)})`);

// Frontend boot (F_Main 0/5 with arg 101) and controller navigation of the main menu 0/0.
// Menu item states: 71 RACE NOW, 83 RACE MODES, 95 FEATURES (state 10 holds the list; root+0x104 = submenu level).
// Autosave (CSYS.ASAV, on in nascar.db) saves changed profiles / seasons by itself when menus open, which would
// interleave its "Saving..." boxes with the button presses below: these checks run with it off (the flow ones answer
// No at the boot prompt) and the autosave check at the end turns it on.
const NOAUTO = { tables: [{ table: "CSYS", where: {}, set: { ASAV: 0 } }] };
const menu = (presses, time = 2000, gap = 600) => {
  const r = openScreen(dataDir, 0, 5, { args: [101], time, presses, gap, config: NOAUTO });
  const sc = r.vm.screens.find(x => x.group === 0 && x.screen === 0);
  return { r, sc, active: i => sc && r.vm.active(sc, i), root: sc ? r.vm.stateHdr(sc, 0) : 0 };
};
const boot = menu([]);
check(boot.r.vm.screens.map(x => `${x.group}/${x.screen}`).join(" ") === "0/5 0/1 0/0 2/1", `frontend screens: ${boot.r.vm.screens.map(x => `${x.group}/${x.screen}`).join(" ")}`);
check(boot.active(71) && !boot.active(83), "main menu starts on RACE NOW");
check(boot.r.game.missing.size === 0, `no unimplemented game functions on boot (${[...boot.r.game.missing.keys()].map(k => k.toString(16))})`);
const down2 = menu([3, 3]);
check(down2.active(95) && !down2.active(71), "down, down highlights FEATURES");
const modes = menu([3, 0], 2000, 2500);
check(modes.r.vm.mem.r32(modes.root + 0x104) === 1 && modes.r.vm.mem.r32(modes.r.vm.stateHdr(modes.sc, 10)) === 1, "down, A opens the RACE MODES submenu");

// Race Now: A on RACE NOW -> F_QuickRace 0/6 opens the settings screen 0/13, filled from the profile's gameplay
// settings (SGPP) and the difficulty table; right, right on Difficulty changes it and the summary follows.
const textOf = (r, sc, off) => { const m = r.vm.mem, rec = m.r32(sc.base + off + 0x20); return rec ? m.cstr(m.r32(rec + 8)).trim() : ""; };
const rn = openScreen(dataDir, 0, 5, { args: [101], time: 2000, config: NOAUTO, presses: [0], gap: 3000 });
const rs = rn.vm.screens.find(x => x.group === 0 && x.screen === 13);
check(rs && rn.vm.focus === rs, `Race Now settings screen open and focused (screens ${rn.vm.screens.map(x => `${x.group}/${x.screen}`).join(" ")})`);
check(rs && textOf(rn, rs, 0x4780) === "FULL" && textOf(rn, rs, 0x47c0) === "ROOKIE", `summary for EASY: aids ${rs && textOf(rn, rs, 0x4780)}, AI ${rs && textOf(rn, rs, 0x47c0)}`);
const vx = rs ? (rn.vm.mem.r16(rs.base + 0x4780 + 6) << 16) >> 16 : 0;
check(vx > 100, `summary values laid out right of their labels (x ${vx}; label widths via relayout)`);
const hard = openScreen(dataDir, 0, 5, { args: [101], time: 2000, config: NOAUTO, presses: [0, 5, 5], gap: 1500 });
const hs = hard.vm.screens.find(x => x.group === 0 && x.screen === 13);
check(hs && textOf(hard, hs, 0x4800) === "QUICK REPAIR" && textOf(hard, hs, 0x47c0) === "VETERAN", `right, right -> HARD: damage ${hs && textOf(hard, hs, 0x4800)}, AI ${hs && textOf(hard, hs, 0x47c0)}`);
const drv = openScreen(dataDir, 0, 5, { args: [101], time: 2000, config: NOAUTO, presses: [0, 0], gap: 3000 });
check(drv.vm.focus && drv.vm.focus.group === 0 && drv.vm.focus.screen === 8, `A on the settings continues to driver select (focus ${drv.vm.focus && drv.vm.focus.group + "/" + drv.vm.focus.screen})`);

// Driver select lists the profile's unlocked cars from the DB; down + A picks a car, then the track screen;
// A on a track hands the race to the game and the frontend closes.
const ds = drv.vm.screens.find(x => x.group === 0 && x.screen === 8);
const names = ds ? ds.layout.states.flatMap(st => st.children.flatMap(c => c.items)).filter(it => it.type === 6)
  .map(it => textOf(drv, ds, it.data)) : [];
check(names.includes("Tony Stewart") && names.includes("Ricky Rudd"), `driver list rows from the DB (${names.filter(n => / /.test(n)).slice(0, 5).join(", ")})`);
const fin = openScreen(dataDir, 0, 5, { args: [101], time: 2000, config: NOAUTO, presses: [0, 0, 3, 0, 0], gap: 3000 });
const setup = fin.game.raceSetup();
check(fin.vm.screens.length === 0 && setup.raceId === 18 && setup.players[0]?.name === "Ricky Rudd",
      `race handed over: ${setup.race} at ${setup.track}, P1 #${setup.players[0]?.number} ${setup.players[0]?.name}`);

// X (message 8, value 1) opens the help popup 2/0 with the focused screen's string table; it closes on release.
const hp = openScreen(dataDir, 0, 5, { args: [101], time: 2000, config: NOAUTO });
hp.vm.press(8, 0, { value: 1 }); hp.vm.runFor(1000);
const helpUp = hp.vm.focus?.group === 2 && hp.vm.focus?.screen === 0;
hp.vm.press(8, 0, { value: 0 }); hp.vm.runFor(1000);
check(helpUp && !hp.vm.screens.some(x => x.group === 2 && x.screen === 0) && hp.vm.focus?.screen === 0, "X held opens main-menu help (2/0), release closes it");

// Career > Load: memory-unit dialogs (UI context 6, process 6) list the hard disk, then its save slots from the save
// folder (a fresh temporary one here); B, B returns to the Race Modes menu.
const saveDir = mkdtempSync(join(tmpdir(), "nt04-save-"));
const ld = openScreen(dataDir, 0, 5, { args: [101], time: 2000, config: NOAUTO, presses: [3, 0, 3, 3, 3, 3, 0, 3, 0, 0], gap: 2500, saveDir });
const slots = ld.vm.screens.find(x => x.group === 5 && x.screen === 1);
check(slots && ld.vm.focus === slots && slots.ctx === 6, `Career > Load > hard disk shows the load screen 5/1 in context 6 (screens ${ld.vm.screens.map(x => `${x.group}/${x.screen}`).join(" ")})`);
ld.vm.press(6, 0); ld.vm.runFor(2500); ld.vm.press(6, 0); ld.vm.runFor(2500);
check(ld.vm.focus?.group === 0 && ld.vm.focus?.screen === 0 && !ld.vm.screens.some(x => x.group === 5), `B, B leaves the memory-unit dialogs back to the menu (focus ${ld.vm.focus?.group}/${ld.vm.focus?.screen})`);
check(ld.game.gameErrors.size === 0, `no game-code errors on the way (${[...ld.game.gameErrors.keys()].join("; ").slice(0, 300)})`);
// Quick save (message 11 on the help bar), "All" (nothing has changed yet), first row: settings save on the hard disk -> save folder gets the save directory
// with SaveMeta.xbx, the data file (a DB image of the STAB-listed tables behind a header) and saveimage.xbx.
const qs = openScreen(dataDir, 0, 5, { args: [101], time: 2000, config: NOAUTO, presses: [3, 11, 5, 0, 0, 0, 0, 0], gap: 2500, saveDir });
const udata = join(saveDir, "E", "UDATA", "45410031"), dirs = existsSync(udata) ? readdirSync(udata) : [];
const files = dirs.length ? readdirSync(join(udata, dirs[0])) : [];
check(files.includes("SaveMeta.xbx") && files.includes("saveimage.xbx") && files.length === 3 && qs.vm.focus?.group === 0 && qs.vm.focus?.screen === 0,
  `quick save writes a save (${dirs[0]}: ${files.join(", ")}) and returns to the menu (focus ${qs.vm.focus?.group}/${qs.vm.focus?.screen})`);
rmSync(saveDir, { recursive: true, force: true });

// Season round trip: a new season with Ricky Rudd (down at driver select), quick save with "All" -> the season row;
// a fresh run loads it from Season > Load and gets the player's car back from the save.
const rtDir = mkdtempSync(join(tmpdir(), "nt04-save-"));
const playerCar = r => { const db = r.game.game.db, c = db.tables.get("CARS").rows.find(x => x.PLID === 0);
  const d = c && db.tables.get("DRVR").rows.find(x => x.DRID === c.DRID); return c ? `#${c.CNMD} ${d?.FNAM} ${d?.LNAM}` : "none"; };
const sv = openScreen(dataDir, 0, 5, { args: [101], time: 2000, config: NOAUTO, presses: [3, 0, 3, 3, 3, 0, 0, 0, 3, 0, 11, 5, 3, 3, 3, 3, 3, 0, 0, 0, 0, 0, 0], gap: 2500, saveDir: rtDir });
const savedCar = playerCar(sv);
const ld2 = openScreen(dataDir, 0, 5, { args: [101], time: 2000, config: NOAUTO, saveDir: rtDir });
const freshCar = playerCar(ld2);
for (const p of [3, 0, 3, 3, 3, 0, 3, 0, 0, 0]) { ld2.vm.press(p, 0); ld2.vm.runFor(2500); }
ld2.vm.runFor(3000); ld2.vm.press(0, 0); ld2.vm.runFor(2500);                // OK on "Load successful."
const loadedCar = playerCar(ld2), seasonMenu = ld2.vm.screens.some(x => x.group === 4 && x.screen === 6);
check(savedCar === "#21 Ricky Rudd" && freshCar === "none" && loadedCar === savedCar && seasonMenu,
  `season save/load round trip: saved ${savedCar}, fresh run ${freshCar}, after Season > Load ${loadedCar}, season menu ${seasonMenu ? "open" : "missing"}`);
rmSync(rtDir, { recursive: true, force: true });

// Career: New -> settings -> Create-A-Car (template, keep changes) -> team (quick sign) -> sponsors (all five
// locations) -> Done reaches the Career main menu; quick save "All" -> Career row -> keyboard Done; a fresh run's
// Career > Load brings back the career (player car = the created car 187, sponsor EasyCare signed).
const crDir = mkdtempSync(join(tmpdir(), "nt04-save-"));
// (after the team is signed its icon is disabled and focus skips it to Sign Sponsors: no Right press there)
const CAREER = [3, 0, 3, 3, 3, 3, 0, 0, 0, 0, 0, 0, 6, 0, 5, 0, 0, 9, 2, 0, 6, 0, 0, 0, 0, 2, 0, 5, 0, 0, 2, 0, 5, 0, 0, 2, 0, 5, 0, 0, 2, 0, 5, 0, 0, 2, 0, 6, 5, 0];
const career = r => { const db = r.game.game.db, c = db.tables.get("CARS").rows.find(x => x.PLID === 0), sp = db.tables.get("SSTA").rows.filter(x => x.CSCS === 1).length;
  return c ? `car ${c.CRID}, ${sp} sponsors` : "none"; };
const cs = openScreen(dataDir, 0, 5, { args: [101], time: 2000, config: NOAUTO, presses: [...CAREER, 11, 5, 3, 3, 3, 3, 3, 0, 0, 0, 0, 0, 0], gap: 2500, saveDir: crDir });
const hub = cs.vm.screens.some(x => x.group === 9 && x.screen === 0), savedCareer = career(cs);
const cl = openScreen(dataDir, 0, 5, { args: [101], time: 2000, config: NOAUTO, saveDir: crDir });
const freshCareer = career(cl);
for (const p of [3, 0, 3, 3, 3, 3, 0, 3, 0, 0, 0]) { cl.vm.press(p, 0); cl.vm.runFor(3000); }
cl.vm.runFor(3000); cl.vm.press(0, 0); cl.vm.runFor(3000);
const loadedCareer = career(cl), hub2 = cl.vm.screens.some(x => x.group === 9 && x.screen === 0);
check(hub && hub2 && savedCareer === "car 187, 5 sponsors" && freshCareer === "none" && loadedCareer === savedCareer,
  `career setup, save and load: saved ${savedCareer} (hub ${hub}), fresh ${freshCareer}, loaded ${loadedCareer} (hub ${hub2})`);
rmSync(crDir, { recursive: true, force: true });

// Game flow (the Interface process boots the title screen): START -> main menu -> Race Modes > Season > new season ->
// season hub; Race Weekend > Simulate runs Interface 16 -> 17 (Race process 2 at 0x33, the race simulator) -> 18 ->
// 6 and shows Post Race Stats with fresh results (DRRS: one row per car); B -> the hub is on race 2.
const fl = openScreen(dataDir, "flow", 0, { time: 3000, presses: [7, 3, 0, 3, 0, 3, 3, 3, 0, 0, 0, 3, 0, 0, 3, 0], gap: 2500, saveDir: mkdtempSync(join(tmpdir(), "nt04-save-")) });
const fg = fl.game.game, drrs = fg.db.tables.get("DRRS").rows.length, postRace = fl.vm.focus?.group === 4 && fl.vm.focus?.screen === 8;
fl.vm.press(6, 0); fl.vm.runFor(2500);
const nextRace = fg.db.tables.get("GINF").rows[0]?.RORD;
check(drrs === 43 && postRace && fg.processState(1) === 6 && nextRace === 2 && fl.vm.focus?.screen === 6,
  `season race simulated through the game flow: ${drrs} results, post-race stats ${postRace}, Interface back at ${fg.processState(1)}, next race ${nextRace}`);
// Race Now through the game's own screens hands off to the race: Interface 7 (Loading In-game) and on to 9 (Race
// Weekend) / 10 (In-game) once the race data loads, Quick Race process 3.
process.env.NT04_NO_JS_SCREENS = "1";
const rh = openScreen(dataDir, "flow", 0, { time: 3000, presses: [7, 3, 0, 0, 0, 3, 0, 0], gap: 2500, saveDir: mkdtempSync(join(tmpdir(), "nt04-save-")) });
delete process.env.NT04_NO_JS_SCREENS;
check([7, 9, 10].includes(rh.game.game.processState(1)) && rh.game.game.processState(3) >= 0, `Race Now hands off to the race (Interface ${rh.game.game.processState(1)}, Quick Race process ${rh.game.game.processState(3).toString(16)})`);

// Configuration overlay (nt04-config.mjs): a schedule of 46 races + the Shootout, longer than the game's 39-entry tables, 24 cars per race and
// an added driver/car and a qualifying session; one simulated race uses all of them (GINF.NRAC counts the schedule's entries, Shootout included).
const ex = JSON.parse(readFileSync(new URL("../nt04.config.example.json", import.meta.url), "utf8"));
const cf = openScreen(dataDir, "flow", 0, { time: 3000, config: { ...ex, fieldSize: 24, qualifying: { entrants: 30, seed: 3 } }, presses: [7, 3, 0, 3, 0, 3, 3, 3, 0, 0, 0, 3, 0, 0, 3, 0], gap: 2500, saveDir: mkdtempSync(join(tmpdir(), "nt04-save-")) });
const cdb = cf.game.game.db, cres = cdb.tables.get("DRRS").rows, added = cres.find(x => x.DRID === 250);
const nrac = cdb.tables.get("GINF").rows[0]?.NRAC, cprob = cf.logs.filter(l => l.startsWith("config:") || /is full/.test(l));
check(cres.length === 24 && nrac === ex.schedules["0"].length && !cprob.length,
  `configured season: ${cres.length} cars, ${nrac} schedule entries${cprob.length ? `, problems: ${cprob.join("; ")}` : ""}`);
// qualifying: 30 entrants (the added driver among them, rated to make it) for 24 places; the grid is the qualifying order
const qsess = cf.game.game.qualifying, grid = cres.slice().sort((a, b) => a.SPOS - b.SPOS).map(x => x.DRID);
check(qsess?.entrants === 30 && qsess.results.filter(r => r.dnq).length === 6 && JSON.stringify(grid) === JSON.stringify(qsess.starters.map(r => r.DRID)) && added,
  `qualifying: ${qsess?.entrants} entrants, ${qsess?.results.filter(r => r.dnq).length} DNQ, grid follows qualifying ${JSON.stringify(grid) === JSON.stringify(qsess?.starters.map(r => r.DRID))}, added driver ${added ? `started ${added.SPOS + 1}, finished ${added.EPOS + 1}` : "not in the race"}`);

// Autosave (Yes at the boot prompt, fresh save folder): the main menu saves the four changed User Profiles by itself
// (0/0 entry: native 0x26 autosave on and 0xD9 changed slots -> 0x82, the save dialogs in context 6); a new season is
// saved when its menu 4/6 opens, and again after a simulated race (the slot checksum 0x147830 changed).
const asDir = mkdtempSync(join(tmpdir(), "nt04-save-"));
const saves = () => { const u = join(asDir, "E", "UDATA", "45410031"); return existsSync(u) ? readdirSync(u).flatMap(d => readdirSync(join(u, d)).filter(f => !/\.xbx$/.test(f)).map(f => ({ f, t: statSync(join(u, d, f)).mtimeMs }))) : []; };
const au = openScreen(dataDir, "flow", 0, { time: 3000, presses: [7, 0], gap: 3000, saveDir: asDir });
au.vm.runFor(16000);
const profiles = saves().filter(x => /^User Profile/.test(x.f)).length;
for (const p of [3, 0, 3, 3, 3, 0, 0, 0, 0]) { au.vm.press(p, 0); au.vm.runFor(2500); }
au.vm.runFor(8000);
const s1 = saves().find(x => x.f === "Season 1");
for (const p of [0, 3, 0]) { au.vm.press(p, 0); au.vm.runFor(2500); }
au.vm.press(6, 0); au.vm.runFor(8000);
const s2 = saves().find(x => x.f === "Season 1"), raced = au.game.game.db.tables.get("GINF").rows[0]?.RORD;
check(profiles === 4 && s1 && s2 && s2.t > s1.t && raced === 2 && au.vm.focus?.group === 4 && au.vm.focus?.screen === 6,
  `autosave: ${profiles} profiles at the main menu, season saved on its menu ${!!s1}, again after the race ${!!(s1 && s2 && s2.t > s1.t)} (next race ${raced}, focus ${au.vm.focus?.group}/${au.vm.focus?.screen})`);
// The profiles come back in their slots newest save first: a later save of User Profile 3 (its file rewritten in
// place) makes it the active profile 0 at the next boot; the save directory's time follows its files (xbox-fs.mjs).
const order = () => { const b = openScreen(dataDir, "flow", 0, { time: 3000, presses: [7], gap: 6000, saveDir: asDir }); return b.game.game.db.tables.get("PRFL").rows.map(r => r.PFLN).join(","); };
const o1 = order(); { const u = join(asDir, "E", "UDATA", "45410031"); for (const d of readdirSync(u)) { const f = join(u, d, "User Profile 3"); if (existsSync(f)) { const t = new Date(Date.now() + 60_000); utimesSync(f, t, t); } } }
const o2 = order();
check(new Set(o1.split(",")).size === 4 && o2.startsWith("Profile3,"), `profiles reload into their slots (${o1}), newest save first (${o2})`);
rmSync(asDir, { recursive: true, force: true });

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
