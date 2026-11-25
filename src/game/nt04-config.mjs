// nt04-config.mjs — game configuration overlay: edits applied to the game database (NASCAR.DB) every time it is
// loaded, so the game's own code sees them (season schedules, races, drivers, cars, teams, table capacities...).
//
// The file is JSON (default: nt04.config.json next to the Data folder; env NT04_CONFIG or the uis-run "config"
// option point elsewhere). All parts are optional and applied in this order:
//
//   {
//     "seasonRaces": 50,                               // room for seasons up to this many races (default 39, and
//                                                      //   always at least the longest schedule; scales DRRS, SCMD,
//                                                      //   AWKY, RSTT, QUAL capacities)
//     "fieldSize": 30,                                 // cars per race, 1..43 (43 is a hard limit of the game code:
//                                                      //   more overflows its per-car arrays); applied by gamecode.mjs
//     "qualifying": { "entrants": 55 },               // more cars try to qualify than start (qualifying.mjs): the
//                                                      //   fastest fieldSize start, the grid follows qualifying,
//                                                      //   the rest DNQ; options playerMustQualify, entryList
//                                                      //   (CRIDs), seed, wSkill, wSpeed, scoreRange, noise
//     "capacity":  { "DRRS": 3000 },                  // raise a table's row limit (the original engine's hard limit)
//     "schedules": { "0": [62, 0, 1, 2, 34, 61, 60] }, // season schedule SCID -> RAIDs in race order (RORD = index)
//     "races":     [ { "RAID": 0, "RLAP": 250 } ],     // field updates by key; same for "drivers" (DRID), "cars"
//     "drivers":   [ { "DRID": 3, "FNAM": "Ann" } ],   //   (CRID), "teams" (TMID), "tracks" (TRID)
//     "tables":    [                                   // generic edits, any table:
//       { "table": "DRVR", "where": { "DRID": 3 }, "set": { "LNAM": "Smith" } },
//       { "table": "PNTS", "delete": { "PLAC": 42 } },  // "delete": {} removes every row
//       { "table": "TEAM", "add": [ { "TMID": 90, "TMNM": "My Team" } ] }   // missing fields get 0 / ""
//     ],
//     "roster": { "drivers": [ ... ] },               // drivers added in the launcher's Roster tab (roster/roster.json
//                                                      //   beside the Data folder is merged in here); see applyRoster
//     "cautionLaps": { "3": 1, "5": 2 },              // laps run under each caution, by race length % (default: 1 at
//                                                      //   3 %, 2 at 5 %, the game's 3 from 10 % up; stock 3/5 % had 0)
//     "sillySeason": { "enabled": true, ... }          // the career off-season (silly-season.mjs DEFAULTS; the
//   }                                                 //   launcher's Career tab: roster/career.json, withCareer)
//
// IDs of added drivers/cars/teams/races must be unused (base data: DRID <= 190, CRID <= 202, TMID <= 190,
// RAID <= 79; the game also creates cars in the 183-202 range), e.g. start new ones at 250.
// "where" matches rows whose fields equal all the given values. Unknown tables or fields are errors (reported, the
// rest still applies). Saved games carry their own copies of the tables listed in STAB, so loading a save brings
// back the saved data for those tables.

import { MAX_BRANDS, BRAND_SPID, brandSplg, LEVEL_PAY } from "./sponsor-decals.mjs";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { packState } from "../tracks/track-pack.mjs";
import { repairGenerated, ensureTables, NEWS_TYPE, applyPoolRemoved, snapshotSkills } from "./silly-season.mjs";

const KEYED = { races: ["RACE", "RAID"], drivers: ["DRVR", "DRID"], cars: ["CARS", "CRID"], teams: ["TEAM", "TMID"], tracks: ["TRCK", "TRID"] };

export function findConfig(dataDir, explicit) {
  const p = explicit ?? process.env.NT04_CONFIG ?? (dataDir ? join(dataDir, "..", "nt04.config.json") : null);
  return p && existsSync(p) ? p : null;
}

export function loadConfig(pathOrObject) {
  if (!pathOrObject) return null;
  return typeof pathOrObject === "string" ? JSON.parse(readFileSync(pathOrObject, "utf8")) : pathOrObject;
}

// Applies the configuration to a database ({ tables: Map }); returns a list of problems (empty when all applied).
export function applyConfig(db, cfg) {
  const problems = [];
  if (!db) return problems;
  cfg ??= {};                                   // (no configuration: the defaults below still apply)
  cfg = Object.fromEntries(Object.entries(cfg).filter(([k]) => !k.startsWith("_") && k !== "rosterDir" && k !== "entryOverrides"));     // "_comment" etc.
  const table = name => { const t = db.tables.get(name); if (!t) throw new Error(`no table ${name}`); return t; };
  const blank = (t, r) => { for (const k of Object.keys(r)) if (!t.fields.some(f => f.name === k)) throw new Error(`${t.name} has no field ${k}`);
    return Object.fromEntries(t.fields.map(f => [f.name, r[f.name] ?? (f.type === 0 || f.type === 13 ? "" : 0)])); };
  const matches = (row, where) => Object.entries(where ?? {}).every(([k, v]) => row[k] === v);
  // a table that grew keeps its original headroom (the game inserts into some of them, e.g. SCHD for generated schedules)
  const fit = (t, before) => { const grown = t.rows.length - before; if (grown > 0) t.capacity = Math.min(0xffff, t.capacity + grown); };
  const step = (what, fn) => { try { fn(); } catch (e) { problems.push(`${what}: ${e.message}`); } };
  // tracks added by track packs first: schedules may name their races
  if (cfg.addedTracks) step("addedTracks", () => problems.push(...applyTracks(db, cfg.addedTracks)));

  for (const [name, n] of Object.entries(cfg.capacity ?? {}))
    step(`capacity ${name}`, () => { const t = table(name); t.capacity = Math.min(0xffff, Math.max(t.rows.length, n | 0)); });

  for (let [scid, raids] of Object.entries(cfg.schedules ?? {}))
    step(`schedule ${scid}`, () => {
      const t = table("SCHD"), before = t.rows.length, known = new Set(table("RACE").rows.map(r => r.RAID));
      const missing = raids.filter(r => !known.has(r)); if (missing.length) problems.push(`schedule ${scid}: no race RAID ${missing.join(", ")} (left out)`);   // (e.g. a track pack switched off)
      raids = raids.filter(r => known.has(r)); if (!raids.length) throw new Error("no races");
      t.rows = t.rows.filter(r => r.SCID !== +scid).concat(raids.map((RAID, RORD) => blank(t, { RAID, SCID: +scid, RORD })));
      fit(t, before);
      // the game rebuilds schedule 3 from the chosen one when a season starts (delete + insert): room for the longest
      const longest = Math.max(...Object.values(Object.groupBy(t.rows, r => r.SCID)).map(g => g.length));
      t.capacity = Math.min(0xffff, Math.max(t.capacity, t.rows.length + longest));
    });

  // careerSchedules: careers use their own schedules 4 / 5 / 6 (gamecode moves a career's 0 / 1 / 2 choice up by 4);
  // one not configured starts as a copy of the season's
  if (cfg.careerSchedules) step("career schedules", () => { const t = table("SCHD"), before = t.rows.length;
    for (let k = 0; k < 3; k++) if (!t.rows.some(r => r.SCID === k + 4)) t.rows.push(...t.rows.filter(r => r.SCID === k).map(r => ({ ...r, SCID: k + 4 })));
    fit(t, before); });

  // per-race tables are sized for 39 schedule entries (DRRS 1677 = 39 x 43 cars, SCMD 39, AWKY 234 = 6 awards x 39,
  // RSTT 40): grow them for seasonRaces or the longest schedule (exhibition races count, they get rows too)
  step("season size", () => {
    const sched = Object.values(Object.groupBy(table("SCHD").rows, r => r.SCID)).map(g => g.length);
    const n = Math.max(cfg.seasonRaces | 0, ...sched);
    if (n <= 39) return;
    const want = { DRRS: 43 * n, SCMD: n, AWKY: 6 * n, RSTT: n + 1, QUAL: n + 11 };
    for (const [name, c] of Object.entries(want)) { const t = table(name); t.capacity = Math.min(0xffff, Math.max(t.capacity, c)); }
  });

  for (const [part, [name, key]] of Object.entries(KEYED))
    for (const upd of cfg[part] ?? [])
      step(`${part} ${key}=${upd[key]}`, () => {
        const t = table(name), row = t.rows.find(r => r[key] === upd[key]);
        if (!row) throw new Error(`no row with ${key} ${upd[key]}`);
        Object.assign(row, blank(t, { ...row, ...upd }));
      });

  for (const [i, e] of (cfg.tables ?? []).entries())
    step(`tables[${i}] ${e.table}`, () => {
      const t = table(e.table);
      if (e.delete) t.rows = t.rows.filter(r => !matches(r, e.delete));
      if (e.set) { const hit = t.rows.filter(r => matches(r, e.where)); if (!hit.length) throw new Error("no row matches"); for (const r of hit) Object.assign(r, blank(t, { ...r, ...e.set })); }
      const key = Object.values(KEYED).find(([n]) => n === e.table)?.[1];
      if (e.add && key) for (const r of e.add) if (t.rows.some(x => x[key] === r[key])) throw new Error(`${key} ${r[key]} is already used`);
      if (e.add) { const before = t.rows.length; t.rows.push(...e.add.map(r => blank(t, r))); fit(t, before); }
    });
  if (cfg.roster) step("roster", () => problems.push(...applyRoster(db, cfg.roster)));
  if (cfg.sponsors?.length) step("sponsors", () => problems.push(...applySponsorStarts(db, cfg.sponsors)));
  if (cfg.brands?.length) step("sponsor list", () => problems.push(...applyBrands(db, cfg.brands)));
  if (cfg.poolRemoved?.length) step("rookie pool", () => applyPoolRemoved(db, cfg.poolRemoved));   // (the Career tab: game's pool drivers left out)
  // caution laps: under a caution the game runs RACE.NCL3 / NCL5 / NC10 / NC25 / NC50 / N100 laps (by the race
  // length setting, 0xAE310) behind the pace car, counted on every car (0xABB27). The stock data has 3 for 10 % and
  // longer races but 0 for 3 % and 5 %, so at the short lengths a caution counted no laps at all: the race went
  // green again on the lap it came out. Those two get 1 and 2 unless "cautionLaps" says otherwise; "cautionLaps":
  // { "3": 0, "5": 0 } is the stock game, { "10": 4 } changes one length for every race.
  step("caution laps", () => {
    const field = { 3: "NCL3", 5: "NCL5", 10: "NC10", 25: "NC25", 50: "NC50", 100: "N100" }, want = { 3: 1, 5: 2, ...(cfg.cautionLaps ?? {}) };
    for (const r of table("RACE").rows) for (const [pct, n] of Object.entries(want)) {
      const f = field[pct]; if (!f) throw new Error(`no race length ${pct} % (3, 5, 10, 25, 50, 100)`);
      if (cfg.cautionLaps?.[pct] !== undefined || !r[f]) r[f] = Math.max(0, Math.min(50, n | 0));
    }
  });
  // silly season (silly-season.mjs): the news category of its moves, and generated prospects' track skills
  if (cfg.sillySeason?.enabled) step("silly season", () => {
    const e = db.tables.get("ECNT");
    if (e && cfg.sillySeason.news !== false && !e.rows.some(r => r.EVAL === NEWS_TYPE)) { if (e.rows.length >= e.capacity) e.capacity = e.rows.length + 1; e.rows.push({ EVAL: NEWS_TYPE, EDIS: "Silly Season" }); }
    repairGenerated(db);
    if (cfg.sillySeason.contracts?.enabled || cfg.sillySeason.sponsors?.enabled) ensureTables(db);   // contracts, team prestige and sponsor deals, kept in career saves
  });
  db.invalidate?.();                            // rows were edited in place: drop the database's equality indexes
  snapshotSkills(db);                          // (the track skills rating changes start from: silly-season.mjs)
  return problems;
}

// ---------------------------------------------------------------- roster (launcher: Roster tab, roster/roster.json)
// Each added driver is a copy of an existing car and its driver ("template": the car's CRID), with the user's changes:
//   { id (DRID), first, last, city, state, born: { year, month, day }, rookieYear,
//     ratings: { speed, control, defense, aggression, durability },        // DRVR DSPD DCTL DDEF DAGR DDUR
//     trackSkills: { "0": short, "1": speedway, "2": superspeedway, "3": road },   // DSKL per track type (ETRT)
//     template: CRID, poid (portrait entry, roster/textures/uis_drpo|uis_drps/<poid>.png) or 0,
//     car: { crid, number, team: TMID | { id, name } (a new team), make: CMDL (ECAR 0 Chevy 1 Dodge 2 Ford 3 Pontiac),
//            class: CTYP (1 primary, 2 secondary) },
//     paint: "copy" (the template car's schemes) | "custom" (roster/paint/<crid>.png: CARDATA entry PAINT_BASE + slot),
//     numberArt: uis_drnm entry of a number picture in roster/textures (used when no existing car has the number, or
//       always with numberPic: "custom", the user's own picture),
//     schemeName, schemes: [{ name }] (more paint schemes, pictures roster/paint/<crid>_<k>.png),
//     crew: "copy" | "made" | "custom" (pit crew uniforms: CHARTEX entry CREW_BASE + slot, CRSK PTEX),
//   roster.removed: [car id] — the game's own cars left out of car select and every field
//     pitSign: "copy" | "made" | "custom" (roster/textures/pitsign/<crid>.png: TK_PBNR entry BANNER_BASE + slot),
//     colors: { primary, secondary } "#rrggbb" (pit box and crew: CRSK IPRD.. / ISRD..) }
// a roster car's spotter / announcer number speech (CARS SSID; 999: none)
const spotterId = (cars, num, src) => num === src.CNUM ? src.SSID
  : cars.rows.find(x => x.CNUM === num && x.CNMD === String(num) && x.SSID !== 999 && x.SSID != null && x.CRID !== src.CRID)?.SSID ?? 999;
// Rows copied from the template: DRVR, DSKL, AIRP (driver); CARS, CRSK (paint schemes: CTID = CARDATA texture),
// CHAC, SCAR (per-track car setups). Season and career saves carry their own DRVR / CARS / CRSK / TEAM, so drivers
// added later appear in new seasons and careers.
export const PAINT_BASE = 0x400;
// custom paints in slot order: [{ crid, scheme, file, name, template, make, slot, entry }]; scheme 0 = the driver's
// paint (d.paint "custom": roster/paint/<crid>.png), 1.. = more schemes (d.schemes[k - 1]: <crid>_<k>.png)
export function rosterPaints(roster) {
  const list = [];
  for (const d of roster?.drivers ?? []) { if (d.car?.crid === undefined) continue; const c = d.car.crid, base = { crid: c, template: d.template, make: d.car.make };
    if (d.paint === "custom") list.push({ ...base, scheme: 0, file: `${c}.png`, name: d.schemeName });
    (d.schemes ?? []).forEach((s, i) => list.push({ ...base, scheme: i + 1, file: `${c}_${i + 1}.png`, name: s?.name })); }
  // the game's own cars' added schemes (roster.carSchemes, removeSchemes): pictures carx_<CRID>_<k>.png
  for (const [k, xs] of Object.entries(roster?.carSchemes ?? {})) { const c = +k; if (!(c < 250) || !Array.isArray(xs)) continue;
    xs.forEach((x, i) => list.push({ crid: c, template: c, make: undefined, scheme: i + 1, file: `carx_${c}_${i + 1}.png`, name: x?.name, game: true })); }
  return list.map((p, slot) => ({ ...p, slot, entry: PAINT_BASE + slot }));
}
// Pit signs (the banner over each pit stall: sponsor + number, TK_PBNR.DAT 128 x 32, entry = CRSK PBNR + 3, read by
// 0xD5410 / 0xD55C0 into the race's per-car table 0x2DD200) of added drivers who made or chose their own:
// TK_PBNR entry BANNER_BASE + slot, made by gamecode withRosterBanners from roster/textures/pitsign/<crid>.png.
export const BANNER_BASE = 0x200;
// Pit crew uniforms (CHARTEX.DAT entry CRSK PTEX; loaded for the player's car, whose crew does the stop on screen) of
// added drivers with crew "made" (plain suits in their colours) or "custom" (roster/textures/crew/<crid>.png, a
// uniform sheet: crew-tex.mjs): CHARTEX entry CREW_BASE + slot, made by gamecode withRosterCrews.
export const CREW_BASE = 0x100;
// Pit crew and pit cart pictures (the game's PITBOX sheet: TK_PBNR entry 0, 256 x 128, faces / suits / ears / gloves /
// the tool cart and tyre, one image tinted per car by palette): roster/textures/pitbox/<crid>.png, any 2 : 1 size, shown
// by the renderer in place of the tinted sheet for that car (gl-remote pitBoxTexture)
// Paints of the game's own cars replaced (the Roster tab's "Paint schemes of the game's cars"): roster.carPaints
// { "<CTID>": { crid, layout } }, pictures roster/paint/stock_<CTID>.png (stock_<CTID>.src.png: as given). The archive
// entries themselves are replaced (gamecode withRosterPaints: CARDATA / CARRESFE entry CTID, and in CARDATA the
// scheme's rookie-stripe copy 0x192 + RTOF), with no database change: every mode and every saved season or career
// shows them, and taking one out brings the game's paint back.
export const ROOKIE_STRIPE_BASE = 0x192;
export function rosterCarPaints(roster) {
  return Object.entries(roster?.carPaints ?? {}).map(([k, v]) => ({ ctid: +k, crid: v?.crid, file: `stock_${+k}.png` }))
    .filter(p => Number.isInteger(p.ctid) && p.ctid >= 0 && p.ctid < ROOKIE_STRIPE_BASE);
}
// the game's own drivers edited in the Roster tab (roster.gameDrivers, applyGameDrivers): in the picture lists like
// added drivers, their own car as the template
const withGame = roster => [...(roster?.drivers ?? []), ...(roster?.gameDrivers ?? []).map(g => ({ ...g, template: g.crid }))];
export function rosterPitBoxes(roster) {
  return withGame(roster).filter(d => d.pitBox === "custom" && d.car?.crid !== undefined).map(d => ({ crid: d.car.crid }));
}
export function rosterCrews(roster) {
  return withGame(roster).filter(d => (d.crew === "made" || d.crew === "custom") && d.car?.crid !== undefined)
    .map((d, slot) => ({ crid: d.car.crid, template: d.template, mode: d.crew, colors: d.colors, slot, entry: CREW_BASE + slot }));
}
export function rosterBanners(roster) {
  return withGame(roster).filter(d => (d.pitSign === "made" || d.pitSign === "custom") && d.car?.crid !== undefined)
    .map((d, slot) => ({ crid: d.car.crid, template: d.template, slot, entry: BANNER_BASE + slot }));
}
const rgb = h => /^#[0-9a-f]{6}$/i.test(h ?? "") ? [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)) : null;
export function applyRoster(db, roster, { fresh = true } = {}) {
  const problems = [], T = n => { const t = db.tables.get(n); if (!t) throw new Error(`no table ${n}`); return t; };
  const grow = (t, n) => { if (t.rows.length + n > t.capacity) t.capacity = Math.min(0xffff, t.rows.length + n); };
  // teams (the Roster tab's Teams): roster.teams [{ id (TMID 200..255), name, prestige }] added, roster.teamNames
  // { TMID: name } renaming the game's own; roster.carTeams { CRID: TMID } moves the game's cars to another team, on
  // nascar.db loads only (a career save keeps the teams its silly season gave its cars)
  try {
    const team = T("TEAM");
    for (const t of roster?.teams ?? []) { if (!Number.isInteger(t?.id)) continue; const name = String(t.name ?? "Team").slice(0, 28), r = team.rows.find(x => x.TMID === t.id);
      if (r) r.TMNM = name; else { grow(team, 1); team.rows.push({ TMID: t.id, TMNM: name }); } }
    for (const [id, name] of Object.entries(roster?.teamNames ?? {})) { const r = team.rows.find(x => x.TMID === +id); if (r && name) r.TMNM = String(name).slice(0, 28); }
    if (fresh) for (const [crid, tmid] of Object.entries(roster?.carTeams ?? {})) { const c = T("CARS").rows.find(x => x.CRID === +crid);
      if (c && team.rows.some(x => x.TMID === +tmid)) c.TMID = +tmid; else problems.push(`car ${crid}: no team ${tmid}`); }
  } catch (e) { problems.push(`teams: ${e.message}`); }
  const copyRows = (name, key, from, set) => { const t = T(name), src = t.rows.filter(r => r[key] === from).map(r => ({ ...r, ...set(r) })); grow(t, src.length); t.rows.push(...src); return src; };
  const paintList = rosterPaints(roster), banners = new Map(rosterBanners(roster).map(b => [b.crid, b.entry])), crews = new Map(rosterCrews(roster).map(c => [c.crid, c.entry]));
  for (const d of roster?.drivers ?? []) {
    try {
      const cars = T("CARS"), drvr = T("DRVR"), car = d.car ?? {};
      // Applied again over tables that already have him (a save made with this roster loaded again; 0x148510 reloading
      // some of the tables from nascar.db and the overlay going on again): all of him there -> left as it is; part of
      // him there (a save made before he was added brings back its own CARS / DRVR / CRSK / TEAM while the other
      // tables kept his rows) -> his rows taken out everywhere and added again. A row is his when the driver row has
      // his id and name, or the car row his car id and driver id; an id the game's own driver / car uses is an error.
      const dRow = drvr.rows.find(r => r.DRID === d.id), cRow = car.crid !== undefined ? cars.rows.find(r => r.CRID === car.crid) : undefined;
      const clean = v => String(v ?? "").trim(), hisD = dRow && clean(dRow.FNAM) === clean(d.first?.slice(0, 13)) && clean(dRow.LNAM) === clean(d.last?.slice(0, 13)), hisC = cRow && cRow.DRID === d.id;
      if ((dRow && !hisD) ) throw new Error(`driver id ${d.id} is already used`);
      // (a career save where the silly season moved him: his own car went to someone else; all left as saved)
      if (hisD && cRow && !hisC && T("CARS").rows.some(x => x.CRID === car.crid && x.OWNR === d.id)) continue;
      if (cRow && !hisC) throw new Error(`car id ${car.crid} is already used`);
      const teamId = car.team && typeof car.team === "object" ? car.team.id : null, all = dRow && cRow && (db.tables.get("CRSK")?.rows.some(r => r.CRID === car.crid) ?? true)
        && (teamId === null || T("TEAM").rows.some(r => r.TMID === teamId)) && (db.tables.get("DSKL")?.rows.some(r => r.DRID === d.id) ?? true);
      if (all) {                                   // (a save from before the spotter-number fix: his car still had the template's number id / speech)
        const src0 = cars.rows.find(r => r.CRID === d.template);
        if (src0 && cRow.CNUM !== src0.CNUM && cRow.SSID === src0.SSID) cRow.SSID = spotterId(cars, cRow.CNUM, src0);
        if (src0 && cRow.CNUM !== src0.CNUM && cRow.NSID === src0.NSID) cRow.NSID = numberArt(db, cRow.CNUM)?.nsid ?? (cRow.CNUM > 99 ? cRow.NSID : cRow.CNUM);
        continue;
      }
      if (dRow || cRow || db.tables.get("DSKL")?.rows.some(r => r.DRID === d.id))
        for (const [n, k, v] of [["DRVR", "DRID", d.id], ["DSKL", "DRID", d.id], ["AIRP", "DRID", d.id], ["CARS", "CRID", car.crid], ["CRSK", "CRID", car.crid], ["CHAC", "CRID", car.crid], ["SCAR", "CRID", car.crid]]) {
          const t = db.tables.get(n); if (t && v !== undefined) t.rows = t.rows.filter(r => r[k] !== v); }
      const src = cars.rows.find(r => r.CRID === d.template); if (!src) throw new Error(`template car ${d.template} not found`);
      const sdrv = drvr.rows.find(r => r.DRID === src.DRID); if (!sdrv) throw new Error(`template car ${d.template} has no driver`);
      const n = v => Number.isFinite(+v) ? +v : undefined, clip = (v, lo, hi) => v === undefined ? undefined : Math.max(lo, Math.min(hi, Math.round(v)));
      const def = (o, k, v) => { if (v !== undefined && v !== "") o[k] = v; };
      // team
      let tmid = src.TMID;
      if (typeof car.team === "number") tmid = car.team;
      else if (car.team && typeof car.team === "object") {
        const team = T("TEAM"); tmid = car.team.id;
        if (!team.rows.some(r => r.TMID === tmid)) { grow(team, 1); team.rows.push({ TMID: tmid, TMNM: String(car.team.name ?? "Team").slice(0, 28) }); }
      }
      // driver
      // (car class 4: the rookie pool — a fill-in driver (DSTT -1) in a pool car (CTYP 4, CCRC 1), as the game's own
      // fantasy drivers; the career silly season (0xB0260 / silly-season.mjs) picks its new drivers from them)
      const pool = +car.class === 4;
      const r = { ...sdrv, DRID: d.id, POID: clip(n(d.poid), 0, 255) ?? 0, DSTT: pool ? -1 : 0, RETY: 0 };
      def(r, "FNAM", d.first?.slice(0, 13)); def(r, "LNAM", d.last?.slice(0, 13)); def(r, "CITY", d.city?.slice(0, 18)); def(r, "STAT", d.state?.slice(0, 2));
      def(r, "BYER", clip(n(d.born?.year), 1900, 2100)); def(r, "BMON", clip(n(d.born?.month), 1, 12)); def(r, "BDAT", clip(n(d.born?.day), 1, 31));
      def(r, "RKYR", clip(n(d.rookieYear), 1900, 2100));
      const R = d.ratings ?? {};
      for (const [k, f] of [["speed", "DSPD"], ["control", "DCTL"], ["defense", "DDEF"], ["aggression", "DAGR"], ["durability", "DDUR"]]) def(r, f, clip(n(R[k]), 0, 100));
      grow(drvr, 1); drvr.rows.push(r);
      copyRows("DSKL", "DRID", sdrv.DRID, x => ({ DRID: d.id, DSKL: clip(n(d.trackSkills?.[x.TTYP]), 0, 100) ?? x.DSKL }));
      if (db.tables.has("AIRP")) copyRows("AIRP", "DRID", sdrv.DRID, () => ({ DRID: d.id }));
      // car
      const num = clip(n(car.number), 0, 999) ?? src.CNUM;
      // number art: the template's when the number is the same; else another car's with that number (CRSK CNID:
      // uis_drnm picture; CARS NSID); else the picture the launcher made (d.numberArt: uis_drnm entry in roster/textures)
      const art = num === src.CNUM ? null : numberArt(db, num);
      // (d.numberPic "custom": the user's own picture, whatever the number)
      const own = d.numberPic === "custom" && Number.isInteger(d.numberArt);
      const cnid = own ? d.numberArt : art?.cnid ?? (num !== src.CNUM && Number.isInteger(d.numberArt) ? d.numberArt : undefined);
      // NSID: the number the race and the spotter know the car by (car record +0x36; the spotter's "<n> car" line is
      // speech entry 340 + NSID where the bank has that number, a line without a number where not). Another car's with
      // the same number, else the number itself, as the game's Create-A-Car rows have it (#63: NSID 63); the template's
      // NSID made a #77 copied from the #2 "the 2 car". SSID (the car record's +0x34) likewise only from a car with
      // the same number.
      const ssid = spotterId(cars, num, src);
      const c = { ...src, CRID: car.crid, DRID: d.id, OWNR: d.id, PLID: -2, CSEL: 0, CNUM: num, CNMD: String(num), NSID: art?.nsid ?? (num === src.CNUM || num > 99 ? src.NSID : num), SSID: ssid, TMID: tmid };
      def(c, "CMDL", clip(n(car.make), 0, 3)); def(c, "CTYP", [1, 2, 3, 4].includes(+car.class) ? +car.class : undefined);
      if (pool || +car.class === 3) c.CCRC = 1;      // (3: a Busch car, running in careers as the game's 15)
      grow(cars, 1); cars.rows.push(c);
      const mineP = paintList.filter(p => p.crid === car.crid), custom = mineP.find(p => p.scheme === 0)?.entry, extra = mineP.filter(p => p.scheme > 0);
      // pit sign (CRSK PBNR: TK_PBNR entry - 3) and pit box / crew colours (IPRD IPGN IPBL primary, ISRD ISGN ISBL secondary)
      const banner = banners.get(car.crid), crew = crews.get(car.crid), pri = rgb(d.colors?.primary), sec = rgb(d.colors?.secondary);
      const skins = copyRows("CRSK", "CRID", src.CRID, () => ({ CRID: car.crid, ...(cnid !== undefined ? { CNID: cnid } : {}), ...(banner !== undefined ? { PBNR: banner - 3 } : {}), ...(crew !== undefined ? { PTEX: crew } : {}),
        ...(pri ? { IPRD: pri[0], IPGN: pri[1], IPBL: pri[2] } : {}), ...(sec ? { ISRD: sec[0], ISGN: sec[1], ISBL: sec[2] } : {}) }));
      if (custom !== undefined) {                 // one scheme: the user's paint (the car's current scheme row)
        const crsk = T("CRSK"), mine = skins.find(x => x.CTXN === src.CSTN) ?? skins[0];
        crsk.rows = crsk.rows.filter(x => x.CRID !== car.crid || x === mine);
        if (mine) { mine.CTID = custom; mine.RTOF = -1; mine.CNAM = (mineP.find(p => p.scheme === 0)?.name || `${r.FNAM} ${r.LNAM}`).slice(0, 38); }   // RTOF: no rookie-stripe copy (CARDATA 0x192 + RTOF, 0x50770)
      }
      if (extra.length) {                         // more schemes: rows like the car's current one, CTXN after the last
        const crsk = T("CRSK"), rows = crsk.rows.filter(x => x.CRID === car.crid), like = rows.find(x => x.CTXN === src.CSTN) ?? rows[0];
        let ctxn = Math.max(...rows.map(x => x.CTXN)) + 1; grow(crsk, extra.length);
        if (like) for (const p of extra) crsk.rows.push({ ...like, CTXN: ctxn++, CTID: p.entry, RTOF: -1, CNAM: (p.name || `Scheme ${p.scheme + 1}`).slice(0, 38) });
      }
      for (const t of ["CHAC", "SCAR"]) if (db.tables.has(t)) copyRows(t, "CRID", src.CRID, () => ({ CRID: car.crid }));   // (GMODEDB.DAT)
    } catch (e) { problems.push(`roster driver ${d.first ?? ""} ${d.last ?? ""} (${d.id}): ${e.message}`); }
  }
  // the game's own cars taken out (roster.removed: car ids): CTYP 9, a type the car select (CTYP 0..4), the season
  // field (0x139B0: types 1..4 by popularity) and the profile car list (not 6, 8, 9) all leave out; the field fills
  // from the next cars instead. (After the added drivers, so one can still start from a removed car.)
  const gone = new Set((roster?.removed ?? []).map(Number));
  if (gone.size) for (const r of T("CARS").rows) if (gone.has(r.CRID) && [0, 1, 2, 3, 4].includes(r.CTYP)) r.CTYP = 9;
  try { removeSchemes(db, roster, { fresh }); } catch (e) { problems.push(`paint schemes taken out: ${e.message}`); }
  problems.push(...applyGameDrivers(db, roster, { fresh }));
  problems.push(...applyRookies(db, roster));
  return problems;
}
// The game's own drivers edited (the Roster tab's "The game's drivers" -> Edit): roster.gameDrivers [{ crid, drid,
// first, last, city, state, born, rookieYear, ratings, trackSkills, car: { number, class }, numberPic, numberArt,
// poid / portrait (his own portrait: POID moved to a free entry, roster/textures/uis_drpo|drps/<poid>.png), pitSign,
// crew, pitBox, colors, orig: the game's values }], changed in place (same DRID / CRID, so his records, history and
// speech stay his). Name, hometown, birth date, rookie year, portrait, number and the car's looks: every load,
// saves included. Ratings, track skills and the driver list (CTYP): new seasons and careers and Race Now only
// (fresh loads), so a career's own progression and silly season are left alone. The team is roster.carTeams.
// Rows a career's sponsor deal has dressed (CTID from SPONSOR_START_BASE) keep the sponsor's colours and crew.
export function applyGameDrivers(db, roster, { fresh = true } = {}) {
  const problems = [], list = roster?.gameDrivers ?? []; if (!list.length) return problems;
  const T = n => db.tables.get(n)?.rows ?? [], banners = new Map(rosterBanners(roster).map(b => [b.crid, b.entry])), crews = new Map(rosterCrews(roster).map(c => [c.crid, c.entry]));
  const n = v => Number.isFinite(+v) ? +v : undefined, clip = (v, lo, hi) => v === undefined ? undefined : Math.max(lo, Math.min(hi, Math.round(v)));
  const set = (o, k, v) => { if (v !== undefined && v !== "" && v !== null) o[k] = v; };
  for (const g of list) {
    try {
      const o = g.orig ?? {}, d = T("DRVR").find(r => r.DRID === g.drid), c = T("CARS").find(r => r.CRID === g.crid);
      if (d) {
        set(d, "FNAM", g.first?.slice(0, 13)); set(d, "LNAM", g.last?.slice(0, 13)); set(d, "CITY", g.city?.slice(0, 18)); set(d, "STAT", g.state?.slice(0, 2));
        set(d, "BYER", clip(n(g.born?.year), 1900, 2100)); set(d, "BMON", clip(n(g.born?.month), 1, 12)); set(d, "BDAT", clip(n(g.born?.day), 1, 31)); set(d, "RKYR", clip(n(g.rookieYear), 1900, 2100));
        if (g.portrait && Number.isInteger(g.poid)) d.POID = g.poid; else if (Number.isInteger(o.poid) && d.POID === g.poid) d.POID = o.poid;
        if (fresh) {
          const R = g.ratings ?? {}; for (const [k, f] of [["speed", "DSPD"], ["control", "DCTL"], ["defense", "DDEF"], ["aggression", "DAGR"], ["durability", "DDUR"]]) set(d, f, clip(n(R[k]), 0, 100));
          for (const r of T("DSKL")) if (r.DRID === g.drid) set(r, "DSKL", clip(n(g.trackSkills?.[r.TTYP]), 0, 100));
        }
      }
      if (c) {
        const num = clip(n(g.car?.number), 0, 999) ?? c.CNUM;
        if (num !== c.CNUM) {
          if (num === o.number) { set(c, "NSID", o.nsid); set(c, "SSID", o.ssid); }
          else { const other = T("CARS").find(x => x.CNUM === num && x.CRID !== g.crid && x.CRID < 250); c.SSID = spotterId(db.tables.get("CARS"), num, c); c.NSID = other?.NSID ?? (num > 99 ? c.NSID : num); }
          c.CNUM = num; c.CNMD = String(num);
        }
        if (fresh && [1, 2, 3, 4].includes(+g.car?.class) && c.CTYP !== 9 && +g.car.class !== c.CTYP) {
          c.CTYP = +g.car.class; if (c.CTYP >= 3) c.CCRC = 1;
          if (d) { if (c.CTYP === 4 && d.DSTT === 0) d.DSTT = -1; else if (c.CTYP !== 4 && d.DSTT === -1) d.DSTT = 0; }
        }
        // the number picture: his own; another car's with the new number; the one made for it; the game's
        const other = num === o.number ? null : (() => { for (const x of T("CARS")) if (x.CNUM === num && x.CRID !== g.crid && x.CRID < 250) { const k = T("CRSK").find(r => r.CRID === x.CRID && r.CTXN === x.CSTN) ?? T("CRSK").find(r => r.CRID === x.CRID); if (k) return k.CNID; } return undefined; })();
        const cnid = g.numberPic === "custom" && Number.isInteger(g.numberArt) ? g.numberArt : num === o.number ? o.cnid : other ?? g.numberArt;
        const pri = rgb(g.colors?.primary), sec = rgb(g.colors?.secondary), banner = banners.get(g.crid), crew = crews.get(g.crid);
        for (const r of T("CRSK")) {
          if (r.CRID !== g.crid) continue; const dressed = r.CTID >= SPONSOR_START_BASE, was = o.rows?.[r.CTID] ?? [o.pbnr, o.ptex, o.cnid];   // (each scheme's own sign / crew / number picture)
          set(r, "CNID", num === o.number && g.numberPic !== "custom" ? was[2] : cnid);
          set(r, "PBNR", banner !== undefined ? banner - 3 : was[0]);
          if (!dressed) { set(r, "PTEX", crew !== undefined ? crew : was[1]);
            if (pri) { r.IPRD = pri[0]; r.IPGN = pri[1]; r.IPBL = pri[2]; } if (sec) { r.ISRD = sec[0]; r.ISGN = sec[1]; r.ISBL = sec[2]; } }
        }
      }
    } catch (e) { problems.push(`edited driver ${g.first ?? ""} ${g.last ?? ""} (car ${g.crid}): ${e.message}`); }
  }
  db.invalidate?.();
  return problems;
}

// Paint schemes of the game's own cars taken out and added (the Roster tab's "Paint schemes of the game's cars"):
// roster.removedSchemes { "<CRID>": [CTID, ...] } and roster.carSchemes { "<CRID>": [{ name, layout }] } (pictures
// roster/paint/carx_<CRID>_<k>.png, CARDATA / CARRESFE entry PAINT_BASE + slot, rosterPaints). The game reads a car's
// schemes by index: count(*) of its CRSK rows, then the row with CTXN = k (the paint scheme menu), and CARS.CSTN is
// the raced row's CTXN (a career sets it from the main scheme of the season's year: CSTP 0, CSKY). So, on every load
// (saves carry their own CRSK / CARS): the added rows from before (CTID in the PAINT_BASE range) and the taken-out
// rows go, the rest are renumbered 0.. in their old order, the added schemes follow (alternates like the car's raced
// row, CSTP 1), and CSTN follows its row (an added one by its number; its row gone: the newest main scheme left, else
// the first). A row a career's sponsor deal has dressed (another CTID) stays. At least one main scheme (CSTP 0) stays.
// The schemes' locks follow them: a locked alternate is a CARD row of type 3 (CRDT 3) for the car (CPRM = CRID) and the
// scheme's index (UORD = CTXN; 74 of them, every one a real (CRID, CTXN)), which the paint scheme menu reads ("select
// DROU from CARD where CPRM = ? and CRDT = ? and CLVL >= 0", 0x774DE) to show "Locked" and a black car until its
// Thunder Plate is earned (DCLU, by card number). So UORD is moved with the renumbered row, and a taken-out scheme's
// card gets CLVL -1 (left out of the menu and of the plates). Without this the added schemes sat at the indexes of
// the taken-out locked ones and showed as locked, and a locked alternate's lock went to another scheme. The scenario
// cars (SCAR CRID / CTXN) likewise. Both tables come from the game's files, so their own values (_u0 / _l0 / _x0) are
// kept on the rows and the indexes are worked out from the game's CTXN of each scheme (stockCtxn, from the first
// fresh load), whether the car's rows are the game's or a save's already renumbered.
const stockCtxn = new Map();                     // "CRID:CTID" -> the game's CTXN
const keep0 = (r, k, f) => { if (!(k in r)) Object.defineProperty(r, k, { value: r[f], enumerable: false, writable: true }); return r[k]; };
export function removeSchemes(db, roster, { fresh = true } = {}) {
  const out = roster?.removedSchemes ?? {}, add = roster?.carSchemes ?? {}, crids = new Set([...Object.keys(out), ...Object.keys(add)].map(Number));
  if (!crids.size) return;
  const crsk = db.tables.get("CRSK"), cars = db.tables.get("CARS"); if (!crsk || !cars) return;
  if (fresh) for (const r of crsk.rows) if (r.CRID < 250 && r.CTID < PAINT_BASE && !stockCtxn.has(`${r.CRID}:${r.CTID}`)) stockCtxn.set(`${r.CRID}:${r.CTID}`, r.CTXN);
  const entries = new Map(rosterPaints(roster).filter(p => p.game).map(p => [`${p.crid}:${p.scheme}`, p.entry]));
  const ours = r => r.CTID >= PAINT_BASE && r.CTID < PAINT_BASE + 0x200;
  for (const crid of crids) {
    if (!(crid < 250)) continue;
    const gone = new Set((Array.isArray(out[crid]) ? out[crid] : []).map(Number)), extra = Array.isArray(add[crid]) ? add[crid] : [];
    const mine = crsk.rows.filter(r => r.CRID === crid); if (!mine.length) continue;
    const base = mine.filter(r => !ours(r)), keep = base.filter(r => !gone.has(r.CTID)).length && base.some(r => r.CSTP === 0 && !gone.has(r.CTID)) ? base.filter(r => !gone.has(r.CTID)) : base;
    const car = cars.rows.find(r => r.CRID === crid), raced = car ? mine.find(r => r.CTXN === car.CSTN) : undefined;
    const racedAdded = raced && ours(raced) ? [...entries].find(([k, e]) => e === raced.CTID && k.startsWith(`${crid}:`))?.[0] : undefined;
    keep.sort((a, b) => a.CTXN - b.CTXN).forEach((r, i) => { r.CTXN = i; });
    const like = (raced && keep.includes(raced) ? raced : null) ?? keep.find(r => r.CSTP === 0) ?? keep[0], added = [];
    extra.forEach((x, i) => { const e = entries.get(`${crid}:${i + 1}`); if (e === undefined || !like) return;
      added.push({ ...like, CTXN: keep.length + added.length, CTID: e, RTOF: -1, CSTP: 1, CNAM: String(x?.name || `Scheme ${i + 1}`).slice(0, 38) }); });
    crsk.rows = crsk.rows.filter(r => r.CRID !== crid || keep.includes(r));
    if (added.length) { if (crsk.rows.length + added.length > crsk.capacity) crsk.capacity = Math.min(0xffff, crsk.rows.length + added.length); crsk.rows.push(...added); }
    let main = keep.filter(r => r.CSTP === 0).sort((a, b) => (b.CSKY ?? 0) - (a.CSKY ?? 0))[0] ?? keep[0];
    if (car) {
      let to = raced && keep.includes(raced) ? raced : racedAdded ? added.find(r => r.CTID === entries.get(racedAdded)) : undefined;
      to ??= main; if (to) car.CSTN = to.CTXN;
    }
    // the locks and scenario cars by the game's index of each scheme -> its index now
    const now = new Map(); for (const r of keep) { const x = stockCtxn.get(`${crid}:${r.CTID}`); if (x !== undefined) now.set(x, r.CTXN); }
    if (now.size) {
      for (const c of db.tables.get("CARD")?.rows ?? []) { if (c.CRDT !== 3 || c.CPRM !== crid) continue;
        const u0 = keep0(c, "_u0", "UORD"), l0 = keep0(c, "_l0", "CLVL"), to = now.get(u0);
        if (to === undefined) { c.UORD = 255; c.CLVL = -1; } else { c.UORD = to; c.CLVL = l0; } }   // (255 / -1: as the game's unused cards; the lock look-up by (CPRM, UORD) has no CLVL test)
      for (const r of db.tables.get("SCAR")?.rows ?? []) { if (r.CRID !== crid) continue; const x0 = keep0(r, "_x0", "CTXN"); r.CTXN = now.get(x0) ?? main?.CTXN ?? 0; }
    }
  }
  db.invalidate?.();
}

// Rookie prospects (roster.rookies, the launcher's Rookies tab): drivers without a car, waiting in the pool of fill-in
// drivers (DSTT -1) for the career silly season (silly-season.mjs) to give them a ride. Each is a DRVR row like the
// game's own fantasy drivers' (copied from one) and his track skills (DSKL); portrait = roster/textures/uis_drpo|drps/
// <poid>.png, else POID 0 (the generic face); DSID 999 (no spoken name). In a career save the row is kept as saved
// (he may have a ride, or have retired).
export function applyRookies(db, roster) {
  const problems = [], drvr = db.tables.get("DRVR"), dskl = db.tables.get("DSKL"); if (!drvr) return problems;
  const tpl = drvr.rows.find(d => d.DSTT === -1 && d.DSID !== 999 && d.RKYR > 0) ?? drvr.rows.find(d => d.DSTT === -1);
  const skil = new Map(); for (const s of dskl?.rows ?? []) if (!skil.has(s.TTYP)) skil.set(s.TTYP, s.SKIL);
  const clean = v => String(v ?? "").trim();
  for (const k of roster?.rookies ?? []) {
    try {
      const row = drvr.rows.find(r => r.DRID === k.id);
      if (row && !(clean(row.FNAM) === clean(k.first?.slice(0, 13)) && clean(row.LNAM) === clean(k.last?.slice(0, 13)))) throw new Error(`driver id ${k.id} is already used`);
      const r = k.ratings ?? {}, n = (v, d) => Number.isFinite(+v) ? Math.max(0, Math.min(100, Math.round(+v))) : d;
      if (!row) {
        if (!tpl) throw new Error("no fill-in driver to copy");
        if (drvr.rows.length >= drvr.capacity) drvr.capacity = Math.min(0xffff, drvr.rows.length + 8);
        drvr.rows.push({ ...tpl, DRID: k.id, POID: k.poid && k.portrait ? k.poid : 0, DSID: 999, FNAM: String(k.first ?? "").slice(0, 13), LNAM: String(k.last ?? "Rookie").slice(0, 13),
          CITY: String(k.city ?? "").slice(0, 18), STAT: String(k.state ?? "").slice(0, 2), BYER: k.born?.year ?? 1985, BMON: k.born?.month ?? 1, BDAT: k.born?.day ?? 1,
          DSPD: n(r.speed, 70), DCTL: n(r.control, 70), DDEF: n(r.defense, 70), DAGR: n(r.aggression, 70), DDUR: n(r.durability, 70), POTN: n(k.potential, 80), DPOP: 6, DPCQ: 0,
          DSTT: -1, RETY: 0, RKYR: 0, GNDR: 0 });
      }
      else row.POID = k.poid && k.portrait ? k.poid : 0;   // (a portrait added after the save was made)
      if (dskl && !dskl.rows.some(s => s.DRID === k.id)) {
        const types = [...skil.keys()].sort((a, b) => a - b); if (dskl.rows.length + types.length > dskl.capacity) dskl.capacity = Math.min(0xffff, dskl.rows.length + types.length);
        for (const t of types) dskl.rows.push({ DRID: k.id, SKIL: skil.get(t), DSKL: n(k.trackSkills?.[t], 70), TTYP: t });
      }
    } catch (e) { problems.push(`rookie ${k.first ?? ""} ${k.last ?? ""} (${k.id}): ${e.message}`); }
  }
  db.invalidate?.();
  return problems;
}

// the number picture of an existing car with this number: { cnid (uis_drnm entry), nsid } or null
export function numberArt(db, num) {
  const cars = db.tables.get("CARS")?.rows ?? [], crsk = db.tables.get("CRSK")?.rows ?? [];
  for (const c of cars) { if (c.CNUM !== num || c.CRID >= 250) continue; const k = crsk.find(r => r.CRID === c.CRID && r.CTXN === c.CSTN) ?? crsk.find(r => r.CRID === c.CRID); if (k) return { cnid: k.CNID, nsid: c.NSID }; }
  return null;
}

// After a saved game's tables were loaded (gamecode 0x147780: a career / season save holds CARS, DRVR, CRSK, TEAM):
// the roster's drivers it does not have are put back (a save made before they were added), the ones it has are left
// as saved, and the removed cars taken out again. Only when the image brought CARS or DRVR.
export function reapplyRoster(db, cfg, loaded) {
  if (!cfg?.roster || !(loaded?.has?.("CARS") || loaded?.has?.("DRVR"))) return [];
  return applyRoster(db, cfg.roster, { fresh: false });
}

// The folder the user's own files are in (roster/, save/): beside the Data folder, or the launcher's preset folder
// (NT04_USER, launcher.mjs presets).
export const userRoot = dataDir => process.env.NT04_USER || join(dataDir, "..");
// roster/roster.json beside the Data folder (written by the launcher), merged into the configuration
export function withRoster(cfg, dataDir) {
  const p = process.env.NT04_ROSTER ?? (dataDir ? join(userRoot(dataDir), "roster", "roster.json") : null);
  if (!p || !existsSync(p) || cfg?.roster) return cfg;
  try { const roster = JSON.parse(readFileSync(p, "utf8")); if (!roster?.drivers?.length && !roster?.removed?.length && !roster?.rookies?.length && !roster?.teams?.length && !Object.keys(roster?.teamNames ?? {}).length && !Object.keys(roster?.carTeams ?? {}).length && !Object.keys(roster?.carPaints ?? {}).length && !Object.keys(roster?.removedSchemes ?? {}).length && !Object.keys(roster?.carSchemes ?? {}).length && !roster?.gameDrivers?.length) return cfg; return { ...(cfg ?? {}), roster, rosterDir: dirname(p) }; }
  catch (e) { console.log(`roster: ${p}: ${e.message}`); return cfg; }
}

// Track packs (roster/tracks/<id>/, see track-pack.mjs): every enabled pack with a current build replaces its slots'
// TK_REND entries, or adds a track (cfg.addedTracks, applied by applyTracks). Entries named in the config's own
// entryOverrides win.
export function withTracks(cfg, dataDir) {
  const dir = process.env.NT04_TRACKS ?? (dataDir ? join(userRoot(dataDir), "roster", "tracks") : null);
  if (!dir || !existsSync(dir)) return cfg;
  try { const { overrides: o, tracks } = packState(dir, m => console.log(m)); if (!Object.keys(o).length) return cfg;
    const mine = cfg?.entryOverrides ?? {}, merged = { ...o }; for (const [arc, e] of Object.entries(mine)) merged[arc] = { ...(merged[arc] ?? {}), ...e };
    for (const [s, f] of Object.entries(o["tk_rend.dat"] ?? {})) console.log(`track pack: TK_REND entry ${s} <- ${f}`);
    return { ...(cfg ?? {}), entryOverrides: merged, ...(tracks.length ? { addedTracks: [...(cfg?.addedTracks ?? []), ...tracks] } : {}) }; }
  catch (e) { console.log(`track packs: ${e.message}`); return cfg; }
}

// ---------------------------------------------------------------- added tracks
// A track added by a pack is a copy of an existing track and race (base: { trid, raid, slot }) under new ids:
//   TRCK row (TRID; TPHD: the "home track" id that groups a track's day / night rows and their races in track
//   select and keys pole times, setups, AI tables, records; listed in track select: TIPP 1, FRSZ 0, sorted last;
//   names / city / state from the pack; TPID (physics) the pack's own when it has a layout of its own (else the base track's), TLEN its length; TAID (photo), TLID stay the base track's), RACE row (RAID,
//   TRID, RTID = the pack's TK_REND entry; race name, laps), and the base's rows of every per-track table
//   (TRID: AICA LCON PTRK RSPR TAUD THLD TKSH TKSK ZBIA; TPHD: AIBL DCST ERBO EREB ERLA ERLB ERLC ERXB PTSF QGEN),
//   per-race table (RAID: AIFW AITW AIWS PTRF) and per-model table (RTID: TFOG). Tables the game fills per home
//   track (BLTM CCST SBLT SVCS: sized 48 or 4 x 48, saved in profiles) get room for one more that saves leave out.
const PER = { TRID: ["AICA", "LCON", "PTRK", "RSPR", "TAUD", "THLD", "TKSH", "TKSK", "ZBIA"], TPHD: ["AIBL", "DCST", "ERBO", "EREB", "ERLA", "ERLB", "ERLC", "ERXB", "PTSF", "QGEN"], RAID: ["AIFW", "AITW", "AIWS", "PTRF"], RTID: ["TFOG"] };
const PER_HOME_FILLED = ["BLTM", "CCST", "SBLT", "SVCS"];
export function applyTracks(db, tracks) {
  const problems = [], grow = (t, n) => { if (t.rows.length + n > t.capacity) t.capacity = Math.min(0xffff, t.rows.length + n); };
  const txt = (v, n) => String(v ?? "").replace(/[^\x20-\x7e]/g, "").trim().slice(0, n);
  for (const tk of tracks ?? []) {
    try {
      const T = db.tables.get("TRCK"), R = db.tables.get("RACE"), { trid, raid, rtid, tphd } = tk.ids, b = tk.base, x = tk.track ?? {};
      if (T.rows.some(r => r.TRID === trid)) throw new Error(`track id ${trid} is already used`);
      if (R.rows.some(r => r.RAID === raid)) throw new Error(`race id ${raid} is already used`);
      if (T.rows.some(r => r.TPHD === tphd)) throw new Error(`home track id ${tphd} is already used`);
      const st = T.rows.find(r => r.TRID === b.trid), sr = R.rows.find(r => r.RAID === b.raid); if (!st || !sr) throw new Error(`base track ${b.trid} / race ${b.raid} not found`);
      const t = { ...st, TRID: trid, TPHD: tphd, ...(Number.isInteger(tk.ids.tpid) ? { TPID: tk.ids.tpid } : {}), ...(x.miles ? { TLEN: Math.round(x.miles * 1000) / 1000 } : {}), TIPP: 1, FRSZ: 0, TSOR: Math.max(...T.rows.map(r => r.TSOR ?? 0)) + 1 }, def = (o, k, v, n) => { const s = txt(v, n); if (s) o[k] = s; };
      def(t, "TRNM", x.name, 38); def(t, "TSNM", x.short || x.name, 21); def(t, "CITY", x.city, 18); def(t, "STAT", x.state, 2);
      grow(T, 1); T.rows.push(t);
      const r = { ...sr, RAID: raid, TRID: trid, RTID: rtid, RSEL: 1, RSOR: Math.max(...R.rows.map(q => q.RSOR ?? 0)) + 1 }; def(r, "RNAM", x.race, 34);
      if (Number.isInteger(+x.laps) && +x.laps > 0) r.RLAP = Math.min(9999, +x.laps);
      grow(R, 1); R.rows.push(r);
      // (tk.home: the stock home track to take setups / AI tables / pole times from, track-pack similarHomeTrack)
      const homeFrom = Number.isInteger(tk.home) && T.rows.some(q => q.TPHD === tk.home && q.TRID !== trid) ? tk.home : st.TPHD;
      const from = { TRID: b.trid, TPHD: homeFrom, RAID: b.raid, RTID: b.slot }, to = { TRID: trid, TPHD: tphd, RAID: raid, RTID: rtid };
      // (the game checks a profile's saved size: their capacity stays, an added track's rows go past it and are left
      // out of saves, nascar-db overflow / savedRows)
      for (const n of PER_HOME_FILLED) { const tb = db.tables.get(n); if (!tb || !db.overflow) continue; const o = (db.overflow[n] ??= { extra: 0, field: "TPHD", values: new Set() });
        if (!o.values.has(tphd)) { o.values.add(tphd); o.extra += Math.max(1, Math.round(tb.capacity / 48)); } }
      for (const [key, names] of Object.entries(PER)) for (const n of names) { const tb = db.tables.get(n); if (!tb) continue;
        const rows = tb.rows.filter(q => q[key] === from[key]).map(q => ({ ...q, [key]: to[key] })); grow(tb, rows.length); tb.rows.push(...rows); }
      // tk.setup: default setup fields of the track's own (DCST: GRAT gear set, SPOI, WEDG, TIPR, springs CSFF / CSRS ...)
      if (tk.setup && typeof tk.setup === "object") { const ds = db.tables.get("DCST")?.rows.find(q => q.TPHD === tphd); if (ds) for (const [k, v] of Object.entries(tk.setup)) if (k in ds && typeof v === typeof ds[k]) ds[k] = v; }
      // the track record (TRCK.TQRT seconds, TQRS mph) when the pack gives one (an NR2003 track.ini's)
      if (Number.isInteger(tk.ids.idtm)) t.IDTM = tk.ids.idtm;     // its own HUD track map (TMAPDAT entries, track-pack writeTrackMap)
      if (+x.record > 0) { t.TQRT = +x.record; if (t.TLEN) t.TQRS = Math.round(t.TLEN * 3600 / x.record * 1000) / 1000; }
      // day or night (x.night true / false; else the base race's). Stock day rows: TRCK.TNIT 0, RACE.RNIT 0, TKSK sky
      // -2 / -2, TFOG colour 110,98,75; night rows: 1, 1, -1 / -1, black fog. An NR2003 track under Lowe's (a night
      // race) is a day race by default (track-pack: tracks with scenery of their own).
      if (typeof x.night === "boolean" && !!st.TNIT !== x.night) {
        const like = T.rows.find(q => !!q.TNIT === x.night && q.TRID !== trid && R.rows.some(rr => rr.TRID === q.TRID && db.tables.get("TFOG")?.rows.some(f => f.RTID === rr.RTID)));
        const likeR = like && R.rows.find(rr => rr.TRID === like.TRID && db.tables.get("TFOG")?.rows.some(f => f.RTID === rr.RTID));
        t.TNIT = x.night ? 1 : 0; r.RNIT = x.night ? 1 : 0;
        const sk = db.tables.get("TKSK")?.rows.find(q => q.TRID === trid), skL = like && db.tables.get("TKSK")?.rows.find(q => q.TRID === like.TRID); if (sk && skL) { sk.SKY0 = skL.SKY0; sk.SKY1 = skL.SKY1; }
        const fg = db.tables.get("TFOG")?.rows.find(q => q.RTID === rtid), fgL = likeR && db.tables.get("TFOG").rows.find(q => q.RTID === likeR.RTID); if (fg && fgL) for (const k of Object.keys(fgL)) if (k !== "RTID") fg[k] = fgL[k];
      }
    } catch (e) { problems.push(`added track ${tk.id}: ${e.message}`); }
  }
  return problems;
}

// ---------------------------------------------------------------- schedules (launcher: Schedules tab, roster/schedules.json)
// { "schedules": { "0": [RAID...], "1": [...], "2": [...], "4": [...], "5": [...], "6": [...] }, "careerSchedules": true }
//   0 / 1 / 2: the three schedule choices of the season settings (12 / 24 / 36 races in the game); careers choose
//   from the same three unless careerSchedules is on: then from 4 / 5 / 6. 3 is the game's working copy of the
//   chosen season schedule (rebuilt at season start). The config file's own "schedules" entries win.
// roster/career.json beside the Data folder (the launcher's Career tab): { sillySeason: {...} }
export function withCareer(cfg, dataDir) {
  const p = process.env.NT04_CAREER ?? (dataDir ? join(userRoot(dataDir), "roster", "career.json") : null);
  if (!p || !existsSync(p) || cfg?.sillySeason) return cfg;
  try { const c = JSON.parse(readFileSync(p, "utf8")); return c?.sillySeason || c?.poolRemoved?.length ? { ...(cfg ?? {}), ...(c.sillySeason ? { sillySeason: c.sillySeason } : {}), ...(c.poolRemoved?.length ? { poolRemoved: c.poolRemoved } : {}) } : cfg; }
  catch (e) { console.log(`career: ${p}: ${e.message}`); return cfg; }
}

// Sponsor paint schemes (the launcher's Sponsors tab, sponsors-server.mjs): roster/sponsors.json + roster/sponsors/<id>/
// paint_<make>.png (no numbers: gamecode draws the car's number with number-paint.mjs) and crew.png. cfg.sponsors =
// the schemes with at least one paint, cfg.sponsorDir their folder.
export function withSponsors(cfg, dataDir) {
  const p = process.env.NT04_SPONSORS ?? (dataDir ? join(userRoot(dataDir), "roster", "sponsors.json") : null);
  if (!p || !existsSync(p) || cfg?.sponsors || cfg?.brands) return cfg;
  try {
    const dir = join(dirname(p), "sponsors"), r = JSON.parse(readFileSync(p, "utf8"));
    const schemes = (r.schemes ?? []).filter(x => Number.isInteger(x?.id) && [0, 1, 2, 3].some(m => existsSync(join(dir, String(x.id), `paint_${m}.png`))))
      .map(x => ({ ...x, paints: [0, 1, 2, 3].filter(m => existsSync(join(dir, String(x.id), `paint_${m}.png`))), crew: !!x.crew && existsSync(join(dir, String(x.id), "crew.png")) }));
    // the sponsors added to the game's own list (Create-A-Car, career Sign Sponsors): those with a logo
    const brands = (r.brands ?? []).filter(b => Number.isInteger(b?.id) && b.id >= 1 && b.id <= MAX_BRANDS && existsSync(join(dir, `brand_${b.id}`, "logo.png")))
      .map(b => ({ ...b, logo: join(dir, `brand_${b.id}`, "logo.png"), decal: existsSync(join(dir, `brand_${b.id}`, "decal.png")) ? join(dir, `brand_${b.id}`, "decal.png") : null }));
    if (!schemes.length && !brands.length) return cfg;
    return { ...(cfg ?? {}), ...(schemes.length ? { sponsors: schemes } : {}), ...(brands.length ? { brands } : {}), sponsorDir: dir };
  } catch (e) { console.log(`sponsors: ${p}: ${e.message}`); return cfg; }
}
// Sponsors added to the game's own list (sponsor-decals.mjs): SPIN rows SPID BRAND_SPID + id (no speech: SSID 999;
// logo BRAND_SPLG(id)) and SPON rows for the five associate spots (STYP 0..4) at the brand's level, available. Done on
// every nascar.db load (the career reset reloads SPON from it) and, for a career save made before a brand was added,
// SPON rows it lacks (reapplyBrands). Rows of a brand removed later stay in old saves but drop out of the game's
// lists (they join SPIN).
export function applyBrands(db, brands) {
  const problems = [], spin = db.tables.get("SPIN"), spon = db.tables.get("SPON");
  if (!spin || !spon) return ["sponsor list: no SPIN / SPON table"];
  const ids = new Set(brands.map(b => BRAND_SPID + b.id));
  spin.rows = spin.rows.filter(r => !ids.has(r.SPID)); spon.rows = spon.rows.filter(r => !ids.has(r.SPID));
  for (const b of brands) {
    spin.rows.push({ SPID: BRAND_SPID + b.id, SSID: 999, SPLG: brandSplg(b.id), CSBI: -1, SNAM: String(b.name ?? "Sponsor").slice(0, 28), SPCT: -1 });
    const lv = Math.max(0, Math.min(4, b.level | 0));
    for (let t = 0; t < 5; t++) spon.rows.push({ IAVA: 1, SPID: BRAND_SPID + b.id, CSPP: Math.fround(LEVEL_PAY[lv]), STYP: t, TTAV: 0, SPLV: lv });
  }
  spin.capacity = Math.max(spin.capacity, spin.rows.length); spon.capacity = Math.max(spon.capacity, spon.rows.length);
  return problems;
}
export function reapplyBrands(db, cfg, loaded) {
  if (!cfg?.brands?.length || !loaded?.has?.("SPON")) return [];
  const spon = db.tables.get("SPON"); if (!spon) return [];
  for (const b of cfg.brands) {
    const lv = Math.max(0, Math.min(4, b.level | 0));
    for (let t = 0; t < 5; t++) if (!spon.rows.some(r => r.SPID === BRAND_SPID + b.id && r.STYP === t)) spon.rows.push({ IAVA: 1, SPID: BRAND_SPID + b.id, CSPP: Math.fround(LEVEL_PAY[lv]), STYP: t, TTAV: 0, SPLV: lv });
  }
  spon.capacity = Math.max(spon.capacity, spon.rows.length); db.invalidate?.();
  return [];
}
// Their entries: CARDATA / CARRESFE SPONSOR_START_BASE + i for the schemes' "starts on" cars (sponsorStarts order),
// SPONSOR_DEAL_BASE + slot for career deals (silly-season.mjs table SSSP); CHARTEX SPONSOR_CREW_BASE + scheme id.
export const SPONSOR_START_BASE = 0x600, SPONSOR_DEAL_BASE = 0x700, SPONSOR_DEAL_SLOTS = 256, SPONSOR_CREW_BASE = 0x180;
export const sponsorStarts = schemes => (schemes ?? []).filter(x => Number.isInteger(x.startOn)).sort((a, b) => a.id - b.id).map((x, i) => ({ scheme: x.id, crid: x.startOn, entry: SPONSOR_START_BASE + i }));
// a car's current paint row (CRSK of its CSTN) dressed in a scheme: paint entry, name, colours, crew
export function dressCar(db, crid, scheme, entry) {
  const car = db.tables.get("CARS")?.rows.find(r => r.CRID === crid), crsk = db.tables.get("CRSK")?.rows ?? [];
  const row = crsk.find(r => r.CRID === crid && r.CTXN === car?.CSTN) ?? crsk.find(r => r.CRID === crid); if (!car || !row) return null;
  const was = { CTID: row.CTID, RTOF: row.RTOF, PTEX: row.PTEX, CNAM: row.CNAM, IPRD: row.IPRD, IPGN: row.IPGN, IPBL: row.IPBL, ISRD: row.ISRD, ISGN: row.ISGN, ISBL: row.ISBL };
  const c1 = rgb(scheme.colors?.primary), c2 = rgb(scheme.colors?.secondary);
  Object.assign(row, { CTID: entry, RTOF: -1, CNAM: String(scheme.name ?? "").slice(0, 38) });
  if (c1) [row.IPRD, row.IPGN, row.IPBL] = c1; if (c2) [row.ISRD, row.ISGN, row.ISBL] = c2;
  if (scheme.crew) row.PTEX = SPONSOR_CREW_BASE + scheme.id;
  return was;
}
export function undressCar(db, crid, was) {
  const car = db.tables.get("CARS")?.rows.find(r => r.CRID === crid), crsk = db.tables.get("CRSK")?.rows ?? [];
  const row = crsk.find(r => r.CRID === crid && r.CTXN === car?.CSTN) ?? crsk.find(r => r.CRID === crid); if (row && was) Object.assign(row, was);
}
// the cars the schemes start on (every mode): their paint, name and colours, if the scheme has a paint of the car's make
export const sponsorOriginal = new Map();          // crid -> the car's own paint entry (a scheme removed later: back to it)
export function applySponsorStarts(db, schemes) {
  const problems = [], byId = new Map(schemes.map(x => [x.id, x]));
  for (const s of sponsorStarts(schemes)) {
    const x = byId.get(s.scheme), car = db.tables.get("CARS")?.rows.find(r => r.CRID === s.crid);
    if (!car) { problems.push(`sponsor ${x.name}: no car ${s.crid}`); continue; }
    if (!x.paints.includes(car.CMDL)) { problems.push(`sponsor ${x.name}: no paint for the make of car ${s.crid}`); continue; }
    const crsk = db.tables.get("CRSK")?.rows ?? [], row = crsk.find(r => r.CRID === s.crid && r.CTXN === car.CSTN) ?? crsk.find(r => r.CRID === s.crid);
    if (row && row.CTID < SPONSOR_START_BASE) sponsorOriginal.set(s.crid, row.CTID);
    dressCar(db, s.crid, x, s.entry);
  }
  return problems;
}

export function withSchedules(cfg, dataDir) {
  const p = process.env.NT04_SCHEDULES ?? (dataDir ? join(userRoot(dataDir), "roster", "schedules.json") : null);
  if (!p || !existsSync(p)) return cfg;
  try { const s = JSON.parse(readFileSync(p, "utf8")), sch = { ...(s.schedules ?? {}), ...(cfg?.schedules ?? {}) };
    const out = { ...(cfg ?? {}) }; if (Object.keys(sch).length) out.schedules = sch;
    if (s.careerSchedules && out.careerSchedules === undefined) out.careerSchedules = true;
    return out; }
  catch (e) { console.log(`schedules: ${p}: ${e.message}`); return cfg; }
}
