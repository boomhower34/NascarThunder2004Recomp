// roster-server.mjs — the launcher's Roster tab, server side: added drivers (roster/roster.json beside the Data
// folder, applied to the game database by nt04-config.mjs applyRoster) and their pictures:
//   roster/textures/uis_drpo/<poid>.png   portrait (menus)        roster/textures/uis_drps/<poid>.png   close-up
//   roster/textures/uis_drnm/<id>.png     car number picture      roster/textures/uis_smnm/<id>.png     its race badge
//   roster/paint/<car id>.png             car paint (scheme 0); <car id>_<k>.png: more paint schemes (d.schemes[k - 1])
//   roster/textures/pitsign/<car id>.png  pit sign (the banner over the pit stall; TK_PBNR, 128 x 32 in the game)
//   roster/textures/crew/<car id>.png     pit crew uniform sheet (crew-tex.mjs: 256 x 256 or a multiple)
//   roster/textures/pitbox/<car id>.png   pit crew and tool cart sheet (the game's PITBOX, 256 x 128 or a multiple, 2 : 1)
// The page (roster-ui.js) edits a driver as a copy of an existing car ("template") and uploads pictures as PNG
// (it converts and sizes them in the browser).
//
// API (JSON unless noted):
//   GET  /api/roster                      { drivers, base: { cars, teams, makes, classes }, limits, teams, teamNames, carTeams }
//   POST /api/roster/team  { id?, name, prestige }   add or change one of your teams (roster.teams, TMID 200..255;
//                                         prestige 0..100 or null: a career's starting team prestige), or rename one
//                                         of the game's (roster.teamNames)
//   POST /api/roster/team/delete { id }   remove one of your teams (only with no drivers or cars on it)
//   POST /api/roster/carteam { crid, team }   put one of the game's cars on another team (roster.carTeams)
//   POST /api/roster/driver  {driver}     add (no id) or update one driver; returns the saved driver (ids filled in)
//   POST /api/roster/delete  { id }       remove a driver and its pictures
//   POST /api/roster/removed   { crids: [car id] } the game's own cars to leave out
//   POST /api/roster/rookie  {rookie}     add (no id) or update a rookie prospect (no car: a fill-in driver waiting for a
//                                         ride from the career silly season; nt04-config applyRookies); rookies: 500..699
//   POST /api/roster/rookie/delete { id }  (pictures: kind=portrait|closeup with the rookie's id)
//   PUT  /api/roster/image?kind=portrait|closeup|number|numberSmall|paint|pitSign|crew|pitBox&id=<driver id>   body: PNG
//        (paint: &scheme=<k> for scheme k. The picture is kept as given (<file>.src.png) and the game's paint made from
//        it by the driver's paintLayout / schemes[k - 1].layout: "game" as is, "ea1252" rearranged onto this game's
//        layout (paint-layout.mjs) with the alpha of a stock paint of the driver's make; made again on save when the
//        layout or the make changes)
//   DELETE /api/roster/image?kind=...&id=...
//   GET  /api/roster/image?kind=...&id=...                                    PNG (roster picture)
//   GET  /api/roster/carpaints?crid=<car id>   one of the game's cars and its paint schemes { crid, number, driver, make,
//        schemes: [{ ctid, name, kind, current, rookie, shared, custom, layout }] }; with no crid: { cars: [car ids with
//        a replaced paint] }
//   PUT  /api/roster/carpaint?ctid=<CTID>&crid=<car id>&layout=game|ea1252   body: PNG — replace that scheme's paint
//        (roster.carPaints; roster/paint/stock_<CTID>.png, made from stock_<CTID>.src.png as for drivers' paints)
//   POST /api/roster/schemes { crid, removed: [CTID] }   the game car's paint schemes taken out (roster.removedSchemes;
//        nt04-config removeSchemes); at least one main scheme stays
//   PUT  /api/roster/carscheme?crid=<car id>&k=<n>|new&name=&layout=   body: PNG — a paint scheme added to one of the
//        game's cars (roster.carSchemes[crid][k - 1], roster/paint/carx_<crid>_<k>.png; nt04-config removeSchemes)
//   POST /api/roster/gamedriver {driver: crid + the added-driver fields}   edit one of the game's drivers in place
//        (roster.gameDrivers, nt04-config applyGameDrivers); pictures: /api/roster/image?...&game=<car id>
//   POST /api/roster/gamedriver/reset { crid }   back to the game's (his pictures removed, his team back)
//   POST /api/roster/carscheme?crid=&k= { name?, layout? }   DELETE /api/roster/carscheme?crid=&k=   GET ...[&src=1]
//   POST /api/roster/carpaint/layout { ctid, layout }   the replaced paint made again with another template layout
//   DELETE /api/roster/carpaint?ctid=<CTID>   back to the game's paint
//   GET  /api/roster/carpaint?ctid=<CTID>[&src=1]   the replaced paint (src: the picture as given)
//   GET  /api/roster/base?kind=portrait|closeup|number|paint|pitSign|crew|pitBox&n=<entry or car id>   PNG from the game's files (crew: the car's uniform sheet at 4x; pitBox: the pit box sheet at 3x)
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { openDatabases } from "../game/nascar-db.mjs";
import { parseTerf } from "../game/terf.mjs";
import { decodeMMAP, encodePNG } from "../game/mmap-tex.mjs";
import { decodePNG } from "../game/png-read.mjs";
import { numberArt, ROOKIE_STRIPE_BASE } from "../game/nt04-config.mjs";
import { convertLayout, LAYOUTS } from "../game/paint-layout.mjs";
import { decodeCrew, crewSheet } from "../game/crew-tex.mjs";
import { paintSize } from "../game/paint-mmap.mjs";

const hex = (...c) => "#" + c.map(v => (v & 255).toString(16).padStart(2, "0")).join("");
const MAKES = { 0: "Chevrolet", 1: "Dodge", 2: "Ford", 3: "Pontiac" };
const IDS = { driver: 250, car: 250, team: 200, poid: 100, number: 300, rookie: 500 };   // first ids handed out (all above the game's)
const ROOKIE_MAX = 699;                                                           // (700..: the silly season's made-up prospects)
const LIMITS = { poid: 255, team: 254 };                                         // 8-bit fields in the database (TMID 255: a free agent in silly-season.mjs SSCT)

export function createRoster({ here, data, user = here }) {   // (user: the preset's folder, launcher.mjs)
  const root = join(user, "roster"), file = join(root, "roster.json");
  const P = {
    portrait: d => join(root, "textures", "uis_drpo", `${d.poid}.png`),
    closeup: d => join(root, "textures", "uis_drps", `${d.poid}.png`),
    number: d => join(root, "textures", "uis_drnm", `${d.numberArt}.png`),
    numberSmall: d => join(root, "textures", "uis_smnm", `${d.numberArt}.png`),     // race number badges (same entry)
    paint: d => join(root, "paint", `${d.car.crid}.png`),
    pitSign: d => join(root, "textures", "pitsign", `${d.car.crid}.png`),
    crew: d => join(root, "textures", "crew", `${d.car.crid}.png`),
    pitBox: d => join(root, "textures", "pitbox", `${d.car.crid}.png`),
  };
  let db = null, terfs = new Map();
  const base = () => db ??= openDatabases(["NASCAR.DB", "GMODEDB.DAT"].map(f => join(data, f)).filter(existsSync));
  const terf = name => { if (!terfs.has(name)) terfs.set(name, parseTerf(readFileSync(join(data, name)))); return terfs.get(name); };
  const load = () => { let r; try { r = JSON.parse(readFileSync(file, "utf8")); r = Array.isArray(r.drivers) ? { removed: [], ...r } : { version: 1, drivers: [], removed: [] }; } catch { r = { version: 1, drivers: [], removed: [] }; } return teamsOf(r); };
  const save = r => { mkdirSync(root, { recursive: true }); writeFileSync(file + ".tmp", JSON.stringify(r, null, 2)); renameSync(file + ".tmp", file); };

  // teams: roster.teams [{ id, name, prestige }]; a driver's car.team is a TMID (the game's or one of these). Rosters
  // from before kept a new team inside the driver (car.team { id, name }): moved into roster.teams.
  function teamsOf(r) {
    r.teams ??= []; r.teamNames ??= {}; r.carTeams ??= {};
    for (const d of r.drivers ?? []) { const t = d.car?.team; if (t && typeof t === "object" && Number.isInteger(t.id)) {
      if (!r.teams.some(x => x.id === t.id)) r.teams.push({ id: t.id, name: String(t.name ?? "Team").slice(0, 28), prestige: null }); d.car.team = t.id; } }
    return r;
  }
  const gameTeam = id => base().tables.get("TEAM").rows.find(r => r.TMID === id);
  function baseInfo() {
    const T = n => base().tables.get(n)?.rows ?? [];
    const drv = new Map(T("DRVR").map(r => [r.DRID, r])), teams = new Map(T("TEAM").map(r => [r.TMID, r.TMNM])), crsk = T("CRSK");
    const skills = new Map(); for (const s of T("DSKL")) { if (!skills.has(s.DRID)) skills.set(s.DRID, {}); skills.get(s.DRID)[s.TTYP] = s.DSKL; }
    const cars = T("CARS").filter(c => [1, 2, 3, 4].includes(c.CTYP) && drv.has(c.DRID) && c.DRID >= 0).map(c => {
      const d = drv.get(c.DRID), sk = crsk.find(k => k.CRID === c.CRID && k.CTXN === c.CSTN) ?? crsk.find(k => k.CRID === c.CRID);
      return { crid: c.CRID, number: c.CNUM, numberText: c.CNMD || String(c.CNUM), driver: `${d.FNAM} ${d.LNAM}`.trim(), team: c.TMID, teamName: teams.get(c.TMID) ?? "", make: c.CMDL, class: c.CTYP,
        scheme: sk?.CNAM ?? "", ctid: sk?.CTID, cnid: sk?.CNID, poid: d.POID, pbnr: sk?.PBNR, ptex: sk?.PTEX,
        colors: sk ? { primary: hex(sk.IPRD, sk.IPGN, sk.IPBL), secondary: hex(sk.ISRD, sk.ISGN, sk.ISBL) } : null,
        ratings: { speed: d.DSPD, control: d.DCTL, defense: d.DDEF, aggression: d.DAGR, durability: d.DDUR }, trackSkills: skills.get(d.DRID) ?? {},
        city: d.CITY, state: d.STAT, drid: d.DRID, first: String(d.FNAM ?? "").trim(), last: String(d.LNAM ?? "").trim(),
        born: { year: d.BYER, month: d.BMON, day: d.BDAT }, rookieYear: d.RKYR, nsid: c.NSID, ssid: c.SSID };
    }).sort((a, b) => a.number - b.number || a.driver.localeCompare(b.driver));
    return { cars, teams: [...teams].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)), makes: MAKES,
      classes: { 1: "Primary", 2: "Secondary", 3: "Busch", 4: "Fill-in (rookie pool)" }, numbers: [...new Set(T("CARS").map(c => c.CNUM))].filter(n => numberArt(base(), n)) };
  }

  // a driver as the page sends it -> checked and with ids
  function clean(input, roster) {
    const cars = base().tables.get("CARS").rows, s = (v, n) => String(v ?? "").replace(/[^\x20-\x7e]/g, "").trim().slice(0, n);
    const int = (v, lo, hi, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def; };
    const tpl = cars.find(c => c.CRID === int(input.template, 0, 1e6, -1)); if (!tpl) throw new Error("choose the car to start from");
    const old = roster.drivers.find(d => d.id === input.id);
    const used = k => new Set([...roster.drivers.filter(d => d !== old), ...(roster.rookies ?? []), ...(roster.gameDrivers ?? [])].map(k));
    const next = (start, taken, max = 1e6) => { let i = start; while (taken.has(i)) i++; if (i > max) throw new Error("no free id left"); return i; };
    const allDr = new Set(base().tables.get("DRVR").rows.map(r => r.DRID)), allCar = new Set(cars.map(r => r.CRID));
    const d = {
      id: old?.id ?? next(IDS.driver, new Set([...allDr, ...used(x => x.id)])),
      first: s(input.first, 13), last: s(input.last, 13) || "Driver", city: s(input.city, 18), state: s(input.state, 2).toUpperCase(),
      born: { year: int(input.born?.year, 1900, 2100, 1980), month: int(input.born?.month, 1, 12, 1), day: int(input.born?.day, 1, 31, 1) },
      rookieYear: int(input.rookieYear, 1900, 2100, 2000),
      ratings: Object.fromEntries(["speed", "control", "defense", "aggression", "durability"].map(k => [k, int(input.ratings?.[k], 0, 100, 80)])),
      trackSkills: Object.fromEntries([0, 1, 2, 3].map(k => [k, int(input.trackSkills?.[k], 0, 100, 80)])),
      template: tpl.CRID,
      poid: old?.poid ?? next(IDS.poid, used(x => x.poid), LIMITS.poid),
      car: { crid: old?.car?.crid ?? next(IDS.car, new Set([...allCar, ...used(x => x.car?.crid)])), number: int(input.car?.number, 0, 999, tpl.CNUM),
             team: null, make: int(input.car?.make, 0, 3, tpl.CMDL), class: [1, 2, 3, 4].includes(+input.car?.class) ? +input.car.class : 1 },   // 3: Busch, 4: the rookie pool (careers' silly season)
      paint: input.paint === "custom" ? "custom" : "copy", schemeName: s(input.schemeName, 38), paintLayout: LAYOUTS[input.paintLayout] ? input.paintLayout : "game",
      schemes: (Array.isArray(input.schemes) ? input.schemes : []).slice(0, 8).map((x, i) => ({ name: s(x?.name, 38) || `Scheme ${i + 2}`, layout: LAYOUTS[x?.layout] ? x.layout : "game" })),   // more paint schemes: roster/paint/<crid>_<k>.png
      numberArt: old?.numberArt ?? next(IDS.number, used(x => x.numberArt)),
      numberPic: input.numberPic === "custom" ? "custom" : "auto",                 // custom: the user's own number picture
      pitSign: ["made", "custom"].includes(input.pitSign) ? input.pitSign : "copy", pitText: s(input.pitText, 24),
      crew: ["made", "custom"].includes(input.crew) ? input.crew : "copy",                   // pit crew uniforms
      pitBox: input.pitBox === "custom" ? "custom" : "colors",                               // the crews at the stall and the tool cart: tinted by the colours, or the user's picture
      colors: Object.fromEntries(["primary", "secondary"].map(k => [k, /^#[0-9a-f]{6}$/i.test(input.colors?.[k] ?? "") ? input.colors[k].toLowerCase() : null])),
      numberStyle: { font: ["sans", "serif", "block", "script"].includes(input.numberStyle?.font) ? input.numberStyle.font : "sans",
        fill: /^#[0-9a-f]{6}$/i.test(input.numberStyle?.fill ?? "") ? input.numberStyle.fill : "#ffffff",
        outline: /^#[0-9a-f]{6}$/i.test(input.numberStyle?.outline ?? "") ? input.numberStyle.outline : "#c00000",
        italic: input.numberStyle?.italic !== false },
    };
    if (d.paint === "copy") d.car.make = tpl.CMDL;                 // the copied paint fits only its own body
    const t = input.car?.team;
    if (t && typeof t === "object") {                             // a new team by name (one of yours with that name: that one)
      const name = s(t.name, 28) || "My Team", mine = roster.teams.find(x => x.name.toLowerCase() === name.toLowerCase());
      if (mine) d.car.team = mine.id;
      else { const id = next(IDS.team, new Set([...base().tables.get("TEAM").rows.map(r => r.TMID), ...roster.teams.map(x => x.id)]), LIMITS.team); roster.teams.push({ id, name, prestige: null }); d.car.team = id; }
    } else d.car.team = gameTeam(+t) || roster.teams.some(x => x.id === +t) ? +t : tpl.TMID;
    return d;
  }
  const schemeFile = (d, k) => k ? join(root, "paint", `${d.car.crid}_${k}.png`) : P.paint(d), srcOf = f => f.replace(/\.png$/, ".src.png");
  // the game's paint for scheme k from the picture as given: rearranged when its layout is another game's
  const derive = (d, k) => {
    const f = schemeFile(d, k), src = existsSync(srcOf(f)) ? srcOf(f) : existsSync(f) ? f : null; if (!src) return;
    if (src === f) renameSync(f, srcOf(f));                         // (a paint saved before pictures were kept as given)
    const buf = readFileSync(srcOf(f)), layout = k ? d.schemes?.[k - 1]?.layout : d.paintLayout;
    if (!layout || layout === "game") { writeFileSync(f, buf); return; }
    const img = decodePNG(buf), r = convertLayout(img, makePaint(d.car.make, d.template), layout, paintSize(img.width, img.height));
    writeFileSync(f, encodePNG(r.width, r.height, r.rgba));
  };
  // the game's paints replaced: the picture as given -> the paint (rearranged onto this game's layout with the alpha of
  // the scheme's own paint when it is another game's template)
  const stockFile = ctid => join(root, "paint", `stock_${ctid}.png`);
  const deriveStock = (ctid, layout) => {
    const f = stockFile(ctid), buf = readFileSync(srcOf(f));
    if (!layout || layout === "game") { writeFileSync(f, buf); return; }
    const img = decodePNG(buf), r = convertLayout(img, decodeMMAP(terf("CARDATA.DAT").entry(ctid)), layout, paintSize(img.width, img.height));
    writeFileSync(f, encodePNG(r.width, r.height, r.rgba));
  };
  // added schemes of the game's cars: rearranged (1252 layout) with the car's raced paint as the template
  const extraFile = (crid, k) => join(root, "paint", `carx_${crid}_${k}.png`);
  const deriveExtra = (crid, k, layout) => {
    const f = extraFile(crid, k), buf = readFileSync(srcOf(f));
    if (!layout || layout === "game") { writeFileSync(f, buf); return; }
    const T = n => base().tables.get(n).rows, c = T("CARS").find(r => r.CRID === crid), row = T("CRSK").find(r => r.CRID === crid && r.CTXN === c?.CSTN) ?? T("CRSK").find(r => r.CRID === crid);
    const img = decodePNG(buf), r = convertLayout(img, decodeMMAP(terf("CARDATA.DAT").entry(row.CTID)), layout, paintSize(img.width, img.height));
    writeFileSync(f, encodePNG(r.width, r.height, r.rgba));
  };
  // one of the game's drivers edited, as the page sends it -> checked (nt04-config applyGameDrivers). Ids only when
  // needed: a portrait entry (poid) when he gets his own portrait, a number picture entry when his number has no
  // picture in the game or he has his own; orig: the game's values to go back to.
  function cleanGame(input, roster) {
    const s = (v, n) => String(v ?? "").replace(/[^\x20-\x7e]/g, "").trim().slice(0, n);
    const int = (v, lo, hi, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def; };
    const c = baseInfo().cars.find(x => x.crid === int(input.crid, 0, 1e6, -1)); if (!c) throw new Error("no such car");
    const list = roster.gameDrivers ??= [], old = list.find(x => x.crid === c.crid);
    const taken = k => new Set([...roster.drivers, ...(roster.rookies ?? []), ...list.filter(x => x !== old)].map(k).filter(v => v !== null && v !== undefined));
    const next = (start, set, max = 1e6) => { let i = start; while (set.has(i)) i++; if (i > max) throw new Error("no free id left"); return i; };
    const T = n => base().tables.get(n).rows, rows = Object.fromEntries(T("CRSK").filter(r => r.CRID === c.crid).map(r => [r.CTID, [r.PBNR, r.PTEX, r.CNID]]));
    const number = int(input.car?.number, 0, 999, c.number), numberPic = input.numberPic === "custom" ? "custom" : "auto";
    const needArt = numberPic === "custom" || (number !== c.number && !numberArt(base(), number));
    const hex = v => /^#[0-9a-f]{6}$/i.test(v ?? "") ? v.toLowerCase() : null, col = k => { const v = hex(input.colors?.[k]); return v && v !== c.colors?.[k] ? v : null; };
    const d = {
      crid: c.crid, drid: c.drid, id: c.drid,
      first: s(input.first, 13), last: s(input.last, 13) || c.last, city: s(input.city, 18), state: s(input.state, 2).toUpperCase(),
      born: { year: int(input.born?.year, 1900, 2100, c.born?.year), month: int(input.born?.month, 1, 12, c.born?.month), day: int(input.born?.day, 1, 31, c.born?.day) },
      rookieYear: int(input.rookieYear, 1900, 2100, c.rookieYear),
      ratings: Object.fromEntries(["speed", "control", "defense", "aggression", "durability"].map(k => [k, int(input.ratings?.[k], 0, 100, c.ratings[k])])),
      trackSkills: Object.fromEntries([0, 1, 2, 3].map(k => [k, int(input.trackSkills?.[k], 0, 100, c.trackSkills[k] ?? 80)])),
      template: c.crid, car: { crid: c.crid, number, make: c.make, class: [1, 2, 3, 4].includes(+input.car?.class) ? +input.car.class : c.class },
      poid: old?.poid ?? (input.ownPortrait ? next(IDS.poid, taken(x => x.poid), LIMITS.poid) : null), portrait: !!old?.portrait,
      numberArt: old?.numberArt ?? (needArt ? next(IDS.number, taken(x => x.numberArt)) : null), numberPic,
      numberStyle: { font: ["sans", "serif", "block", "script"].includes(input.numberStyle?.font) ? input.numberStyle.font : "sans", fill: hex(input.numberStyle?.fill) ?? "#ffffff", outline: hex(input.numberStyle?.outline) ?? "#c00000", italic: true },
      pitSign: ["made", "custom"].includes(input.pitSign) ? input.pitSign : "copy", pitText: s(input.pitText, 24),
      crew: ["made", "custom"].includes(input.crew) ? input.crew : "copy", pitBox: input.pitBox === "custom" ? "custom" : "colors",
      colors: { primary: col("primary"), secondary: col("secondary") }, paint: "copy",
      orig: { number: c.number, cnid: c.cnid, nsid: c.nsid, ssid: c.ssid, pbnr: c.pbnr, ptex: c.ptex, poid: c.poid, rows },
    };
    // (crew "made" and the made pit sign need colours: the car's when not changed)
    if ((d.crew === "made" || d.pitSign === "made") && !d.colors.primary) d.colors = { primary: hex(input.colors?.primary) ?? c.colors?.primary ?? null, secondary: hex(input.colors?.secondary) ?? c.colors?.secondary ?? null };
    // the team: one of the game's or yours (roster.carTeams), or a new one
    const t = input.car?.team; let team = c.team;
    if (t && typeof t === "object") { const name = s(t.name, 28) || "My Team", mine = roster.teams.find(x => x.name.toLowerCase() === name.toLowerCase());
      if (mine) team = mine.id; else { team = next(IDS.team, new Set([...T("TEAM").map(r => r.TMID), ...roster.teams.map(x => x.id)]), LIMITS.team); roster.teams.push({ id: team, name, prestige: null }); } }
    else if (gameTeam(+t) || roster.teams.some(x => x.id === +t)) team = +t;
    if (team === c.team) delete roster.carTeams[c.crid]; else roster.carTeams[c.crid] = team;
    return d;
  }
  // a rookie prospect as the page sends it -> checked and with ids
  function cleanRookie(input, roster) {
    const s = (v, n) => String(v ?? "").replace(/[^\x20-\x7e]/g, "").trim().slice(0, n);
    const int = (v, lo, hi, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def; };
    const rookies = roster.rookies ??= [], old = rookies.find(r => r.id === input.id);
    const taken = new Set([...base().tables.get("DRVR").rows.map(r => r.DRID), ...roster.drivers.map(d => d.id), ...rookies.filter(r => r !== old).map(r => r.id)]);
    const poids = new Set([...roster.drivers.map(d => d.poid), ...rookies.filter(r => r !== old).map(r => r.poid)]);
    const next = (start, set, max) => { let i = start; while (set.has(i)) i++; if (i > max) throw new Error("no free id left"); return i; };
    return {
      id: old?.id ?? next(IDS.rookie, taken, ROOKIE_MAX), poid: old?.poid ?? next(IDS.poid, poids, LIMITS.poid), portrait: !!old?.portrait,
      first: s(input.first, 13), last: s(input.last, 13) || "Rookie", city: s(input.city, 18), state: s(input.state, 2).toUpperCase(),
      born: { year: int(input.born?.year, 1900, 2100, 1985), month: int(input.born?.month, 1, 12, 1), day: int(input.born?.day, 1, 31, 1) },
      ratings: Object.fromEntries(["speed", "control", "defense", "aggression", "durability"].map(k => [k, int(input.ratings?.[k], 0, 100, 70)])),
      trackSkills: Object.fromEntries([0, 1, 2, 3].map(k => [k, int(input.trackSkills?.[k], 0, 100, 70)])),
    };
  }
  const rookieFiles = r => ({ ...r, files: { portrait: existsSync(P.portrait(r)), closeup: existsSync(P.closeup(r)) } });
  const withFiles = d => ({ ...d, files: { ...Object.fromEntries(Object.entries(P).map(([k, f]) => [k, existsSync(f(d))])), schemes: (d.schemes ?? []).map((_, i) => existsSync(schemeFile(d, i + 1))) } });
  // a stock paint of a make (the start car's when it is that make): the alpha and size a rearranged sheet takes
  const makePaint = (make, prefer) => { const cars = baseInfo().cars, c = cars.find(x => x.crid === prefer && x.make === make) ?? cars.find(x => x.make === make && x.ctid !== undefined); if (!c) throw new Error("no stock paint of that make"); return decodeMMAP(terf("CARDATA.DAT").entry(c.ctid)); };

  return async function handle(req, res, url, { json, body }) {
    const p = url.pathname; if (!p.startsWith("/api/roster")) return false;
    const roster = load(), q = k => url.searchParams.get(k);
    const find = () => { if (q("game") !== null) { const g = (roster.gameDrivers ?? []).find(x => x.crid === Number(q("game"))); if (!g) throw new Error("save the driver first"); return g; }
      const d = roster.drivers.find(x => x.id === Number(q("id"))) ?? (["portrait", "closeup"].includes(q("kind")) ? roster.rookies?.find(x => x.id === Number(q("id"))) : null); if (!d) throw new Error("no such driver"); return d; };
    const rookieMark = d => { if (roster.rookies?.includes(d) || roster.gameDrivers?.includes(d)) { d.portrait = d.poid !== null && d.poid !== undefined && existsSync(P.portrait(d)); save(roster); } };   // (applyRookies: POID only with a portrait)
    const png = (buf) => { res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" }); res.end(buf); };
    if (req.method === "GET" && p === "/api/roster") { json(res, 200, { gameDrivers: (roster.gameDrivers ?? []).map(withFiles), drivers: roster.drivers.map(withFiles), rookies: (roster.rookies ?? []).map(rookieFiles), removed: roster.removed ?? [], base: baseInfo(), limits: LIMITS, teams: roster.teams, teamNames: roster.teamNames, carTeams: roster.carTeams }); return true; }
    if (req.method === "POST" && p === "/api/roster/team") {
      const input = await body(req), name = String(input.name ?? "").replace(/[^\x20-\x7e]/g, "").trim().slice(0, 28), id = Number.isInteger(input.id) ? input.id : null;
      const pr = input.prestige === null || input.prestige === "" || input.prestige === undefined ? null : Math.max(0, Math.min(100, Math.round(+input.prestige)));
      if (id !== null && gameTeam(id)) {                              // one of the game's: a new name (empty: its own back)
        if (!name || name === String(gameTeam(id).TMNM).trim()) delete roster.teamNames[id]; else roster.teamNames[id] = name;
        save(roster); json(res, 200, { id, name: name || gameTeam(id).TMNM, game: true }); return true;
      }
      if (!name) throw new Error("the team needs a name");
      const all = [...base().tables.get("TEAM").rows.map(r => ({ id: r.TMID, name: roster.teamNames[r.TMID] ?? String(r.TMNM).trim() })), ...roster.teams];
      if (all.some(x => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) throw new Error(`there is already a team called "${name}"`);
      let t = roster.teams.find(x => x.id === id);
      if (!t) { if (id !== null) throw new Error("no such team"); const nid = (() => { const taken = new Set(all.map(x => x.id)); let i = IDS.team; while (taken.has(i)) i++; if (i > LIMITS.team) throw new Error("no free team id left (55 teams at most)"); return i; })();
        t = { id: nid, name, prestige: pr }; roster.teams.push(t); }
      else Object.assign(t, { name, prestige: pr });
      save(roster); json(res, 200, t); return true;
    }
    if (req.method === "POST" && p === "/api/roster/team/delete") {
      const { id } = await body(req), t = roster.teams.find(x => x.id === id); if (!t) throw new Error("no such team (the game's own teams cannot be removed)");
      const users = roster.drivers.filter(d => d.car?.team === id).map(d => `${d.first} ${d.last}`.trim()), cars = Object.entries(roster.carTeams).filter(([, v]) => v === id).length;
      if (users.length || cars) throw new Error(`move its cars to another team first (${[...users, ...(cars ? [`${cars} of the game's cars`] : [])].join(", ")})`);
      roster.teams = roster.teams.filter(x => x !== t); save(roster); json(res, 200, { ok: true }); return true;
    }
    if (req.method === "POST" && p === "/api/roster/carteam") {
      const { crid, team } = await body(req), car = base().tables.get("CARS").rows.find(c => c.CRID === +crid); if (!car) throw new Error("no such car");
      if (!gameTeam(+team) && !roster.teams.some(x => x.id === +team)) throw new Error("no such team");
      if (+team === car.TMID) delete roster.carTeams[car.CRID]; else roster.carTeams[car.CRID] = +team;
      save(roster); json(res, 200, { carTeams: roster.carTeams }); return true;
    }
    if (req.method === "POST" && p === "/api/roster/rookie") {
      const r = cleanRookie(await body(req), roster), i = roster.rookies.findIndex(x => x.id === r.id);
      if (i >= 0) roster.rookies[i] = r; else roster.rookies.push(r);
      save(roster); json(res, 200, rookieFiles(r)); return true;
    }
    if (req.method === "POST" && p === "/api/roster/rookie/delete") {
      const { id } = await body(req), r = (roster.rookies ?? []).find(x => x.id === id); if (!r) throw new Error("no such rookie");
      for (const k of ["portrait", "closeup"]) rmSync(P[k](r), { force: true });
      roster.rookies = roster.rookies.filter(x => x !== r); save(roster); json(res, 200, { ok: true }); return true;
    }
    if (req.method === "POST" && p === "/api/roster/removed") {      // { crids: [...] } the game's cars left out (nt04-config applyRoster)
      const { crids } = await body(req), known = new Set(baseInfo().cars.map(c => c.crid));
      roster.removed = [...new Set((Array.isArray(crids) ? crids : []).map(Number).filter(c => known.has(c)))].sort((a, b) => a - b);
      save(roster); json(res, 200, { removed: roster.removed }); return true;
    }
    if (req.method === "POST" && p === "/api/roster/gamedriver") {   // one of the game's drivers edited (roster.gameDrivers)
      const d = cleanGame(await body(req), roster), list = roster.gameDrivers, i = list.findIndex(x => x.crid === d.crid);
      if (i >= 0) list[i] = d; else list.push(d);
      save(roster); json(res, 200, withFiles(d)); return true;
    }
    if (req.method === "POST" && p === "/api/roster/gamedriver/reset") {   // { crid } back to the game's
      const { crid } = await body(req), list = roster.gameDrivers ?? [], d = list.find(x => x.crid === crid); if (!d) throw new Error("that driver has no changes");
      for (const [k, f] of Object.entries(P)) if (k !== "paint") { const path = f(d); if (!/[\\/](null|undefined)\.png$/.test(path)) rmSync(path, { force: true }); }
      roster.gameDrivers = list.filter(x => x !== d); delete roster.carTeams?.[crid]; save(roster); json(res, 200, { ok: true }); return true;
    }
    if (req.method === "POST" && p === "/api/roster/driver") {
      const input = await body(req), d = clean(input, roster), i = roster.drivers.findIndex(x => x.id === d.id);
      // paint schemes kept, removed or reordered: each input scheme may say which one it was (from: its old number)
      if (i >= 0) { const old = roster.drivers[i], moves = (input.schemes ?? []).slice(0, d.schemes.length).map((x, k) => [Number(x?.from), k + 1]);
        const keep = moves.filter(([a]) => Number.isInteger(a) && a >= 1 && a <= (old.schemes ?? []).length), tmp = [];
        for (const [a, b] of keep) for (const f of [schemeFile(old, a), srcOf(schemeFile(old, a))]) if (existsSync(f)) { renameSync(f, f + ".tmp"); tmp.push([f + ".tmp", f === schemeFile(old, a) ? schemeFile(d, b) : srcOf(schemeFile(d, b))]); }
        for (let k = 1; k <= Math.max(8, (old.schemes ?? []).length); k++) for (const f of [schemeFile(old, k), srcOf(schemeFile(old, k))]) rmSync(f, { force: true });
        for (const [t, f] of tmp) renameSync(t, f);
        // layout or make changed: the game's paints made again from the pictures as given
        if (d.paintLayout !== (old.paintLayout ?? "game") || d.car.make !== old.car?.make) derive(d, 0);
        d.schemes.forEach((x, k) => { const was = keep.find(([, b]) => b === k + 1); if (was && (x.layout !== old.schemes[was[0] - 1]?.layout || d.car.make !== old.car?.make)) derive(d, k + 1); }); }
      if (i >= 0) roster.drivers[i] = d; else roster.drivers.push(d);
      save(roster); json(res, 200, withFiles(d)); return true;
    }
    if (req.method === "POST" && p === "/api/roster/delete") {
      const { id } = await body(req), d = roster.drivers.find(x => x.id === id); if (!d) throw new Error("no such driver");
      for (const f of Object.values(P)) rmSync(f(d), { force: true }); for (let k = 0; k <= 8; k++) for (const f of [schemeFile(d, k), srcOf(schemeFile(d, k))]) rmSync(f, { force: true });
      roster.drivers = roster.drivers.filter(x => x !== d); save(roster); json(res, 200, { ok: true }); return true;
    }
    if (p === "/api/roster/image") {
      const kind = q("kind"); if (!P[kind]) throw new Error("bad picture kind"); const d = find(), sk = kind === "paint" ? Number(q("scheme") ?? 0) : 0;
      if (q("game") !== null && (kind === "paint" || (["portrait", "closeup"].includes(kind) && !Number.isInteger(d.poid)) || (["number", "numberSmall"].includes(kind) && !Number.isInteger(d.numberArt)))) {
        if (req.method === "GET" || req.method === "DELETE") { json(res, req.method === "GET" ? 404 : 200, { ok: true }); return true; } throw new Error(`no ${kind} picture for this driver (save him first)`); }
      if (sk && !(Number.isInteger(sk) && sk >= 1 && sk <= (d.schemes ?? []).length)) throw new Error("no such paint scheme");
      const f = sk ? schemeFile(d, sk) : P[kind](d);
      if (req.method === "GET") { if (!existsSync(f)) { json(res, 404, { error: "none" }); return true; } png(readFileSync(f)); return true; }
      if (req.method === "DELETE") { rmSync(f, { force: true }); if (kind === "paint") rmSync(srcOf(f), { force: true }); rookieMark(d); json(res, 200, { ok: true }); return true; }
      if (req.method === "PUT") {
        const chunks = []; let n = 0;
        for await (const c of req) { n += c.length; if (n > 16e6) throw new Error("picture too large"); chunks.push(c); }
        const buf = Buffer.concat(chunks), img = decodePNG(buf);    // throws when it is not a PNG we can read
        if (img.width > 4096 || img.height > 4096) throw new Error("picture too large (4096 px at most)");
        mkdirSync(join(f, ".."), { recursive: true });
        if (kind === "paint") { writeFileSync(srcOf(f), buf); derive(d, sk); }   // (kept as given; the game's paint made from it)
        else writeFileSync(f, buf);
        rookieMark(d);
        json(res, 200, { ok: true, width: img.width, height: img.height }); return true;
      }
    }
    // ---- the game's own cars' paint schemes replaced (nt04-config rosterCarPaints)
    if (p === "/api/roster/carpaints" && req.method === "GET") {
      const cp = roster.carPaints ?? {};
      if (q("crid") === null) { json(res, 200, { cars: [...new Set(Object.values(cp).map(v => v.crid))], trimmed: [...Object.keys(roster.removedSchemes ?? {}), ...Object.keys(roster.carSchemes ?? {})].map(Number) }); return true; }
      const crid = Number(q("crid")), T = n => base().tables.get(n)?.rows ?? [], c = T("CARS").find(x => x.CRID === crid); if (!c) throw new Error("no such car");
      const d = T("DRVR").find(x => x.DRID === c.DRID), uses = new Map(); for (const r of T("CRSK")) uses.set(r.CTID, (uses.get(r.CTID) ?? 0) + 1);
      const KIND = { 0: "main", 1: "alternate", 2: "special", 3: "test car" }, yr = r => r.CSKY > 1900 ? ` ${r.CSKY}` : "", n = terf("CARDATA.DAT").count;
      const schemes = T("CRSK").filter(r => r.CRID === crid && r.CTID >= 0 && r.CTID < Math.min(n, ROOKIE_STRIPE_BASE)).sort((a, b) => a.CTXN - b.CTXN).map(r => ({
        ctid: r.CTID, name: r.CNAM, kind: (KIND[r.CSTP] ?? `type ${r.CSTP}`) + yr(r), current: r.CTXN === c.CSTN, rookie: r.RTOF >= 0, shared: (uses.get(r.CTID) ?? 0) > 1,
        custom: !!cp[r.CTID] && existsSync(stockFile(r.CTID)), layout: cp[r.CTID]?.layout ?? "game", main: r.CSTP === 0,
        removed: (roster.removedSchemes?.[crid] ?? []).includes(r.CTID) }));
      const added = (roster.carSchemes?.[crid] ?? []).map((x, i) => ({ k: i + 1, name: x.name, layout: x.layout ?? "game", has: existsSync(extraFile(crid, i + 1)) }));
      json(res, 200, { crid, number: c.CNMD || String(c.CNUM), driver: d ? `${d.FNAM} ${d.LNAM}`.trim() : "", make: c.CMDL, schemes, added }); return true;
    }
    // added schemes of a game car (roster.carSchemes[crid], pictures carx_<crid>_<k>.png)
    if (p === "/api/roster/carscheme") {
      const crid = Number(q("crid")), list = (roster.carSchemes ??= {})[crid] ?? [], k = q("k") === "new" ? list.length + 1 : Number(q("k"));
      if (!(crid < 250) || !base().tables.get("CRSK").rows.some(r => r.CRID === crid)) throw new Error("no such car");
      if (!(Number.isInteger(k) && k >= 1 && k <= list.length + (req.method === "PUT" ? 1 : 0))) throw new Error("no such scheme");
      const f = extraFile(crid, k), s = v => String(v ?? "").replace(/[^\x20-\x7e]/g, "").trim().slice(0, 38);
      if (req.method === "GET") { const g = q("src") ? srcOf(f) : f; if (!existsSync(g)) { json(res, 404, { error: "none" }); return true; } png(readFileSync(g)); return true; }
      if (req.method === "PUT") {                                   // a picture: a new scheme (k=new) or a new picture for one
        if (k > 12) throw new Error("12 added schemes at most");
        const chunks = []; let n = 0; for await (const c of req) { n += c.length; if (n > 16e6) throw new Error("picture too large"); chunks.push(c); }
        const buf = Buffer.concat(chunks), img = decodePNG(buf); if (img.width > 4096 || img.height > 4096) throw new Error("picture too large (4096 px at most)");
        const x = list[k - 1] ?? { name: "", layout: "game" }; if (q("name") !== null) x.name = s(q("name")); if (q("layout") !== null) x.layout = LAYOUTS[q("layout")] ? q("layout") : "game";
        if (!x.name) x.name = `Scheme ${k}`;
        mkdirSync(join(root, "paint"), { recursive: true }); writeFileSync(srcOf(f), buf); deriveExtra(crid, k, x.layout);
        list[k - 1] = x; roster.carSchemes[crid] = list; save(roster); json(res, 200, { ok: true, k, width: img.width, height: img.height }); return true;
      }
      if (req.method === "POST") {                                  // { name?, layout? }
        const inp = await body(req), x = list[k - 1];
        if (inp.name !== undefined) x.name = s(inp.name) || `Scheme ${k}`;
        if (inp.layout !== undefined && inp.layout !== x.layout) { x.layout = LAYOUTS[inp.layout] ? inp.layout : "game"; if (existsSync(srcOf(f))) deriveExtra(crid, k, x.layout); }
        save(roster); json(res, 200, { ok: true }); return true;
      }
      if (req.method === "DELETE") {                                // the later ones move up a number
        for (const g of [f, srcOf(f)]) rmSync(g, { force: true });
        for (let j = k + 1; j <= list.length; j++) for (const [a, b] of [[extraFile(crid, j), extraFile(crid, j - 1)], [srcOf(extraFile(crid, j)), srcOf(extraFile(crid, j - 1))]]) if (existsSync(a)) renameSync(a, b);
        list.splice(k - 1, 1); if (list.length) roster.carSchemes[crid] = list; else delete roster.carSchemes[crid];
        save(roster); json(res, 200, { ok: true }); return true;
      }
    }
    if (p === "/api/roster/schemes" && req.method === "POST") {      // { crid, removed: [CTID] } the car's schemes taken out
      const { crid, removed } = await body(req), rows = base().tables.get("CRSK").rows.filter(r => r.CRID === crid);
      if (!rows.length || !(crid < 250)) throw new Error("no such car");
      const out = [...new Set((Array.isArray(removed) ? removed : []).map(Number))].filter(c => rows.some(r => r.CTID === c));
      if (!rows.some(r => r.CSTP === 0 && !out.includes(r.CTID))) throw new Error("keep at least one main scheme");
      roster.removedSchemes ??= {}; if (out.length) roster.removedSchemes[crid] = out; else delete roster.removedSchemes[crid];
      save(roster); json(res, 200, { ok: true, removed: out }); return true;
    }
    if (p === "/api/roster/carpaint/layout" && req.method === "POST") {
      const { ctid, layout } = await body(req), cp = roster.carPaints ?? {}; if (!cp[ctid]) throw new Error("that scheme has no paint of yours");
      cp[ctid].layout = LAYOUTS[layout] ? layout : "game"; deriveStock(ctid, cp[ctid].layout); save(roster); json(res, 200, { ok: true }); return true;
    }
    if (p === "/api/roster/carpaint") {
      const ctid = Number(q("ctid")); if (!(Number.isInteger(ctid) && ctid >= 0 && ctid < Math.min(terf("CARDATA.DAT").count, ROOKIE_STRIPE_BASE))) throw new Error("no such paint scheme");
      const f = stockFile(ctid);
      if (req.method === "GET") { const g = q("src") ? srcOf(f) : f; if (!existsSync(g)) { json(res, 404, { error: "none" }); return true; } png(readFileSync(g)); return true; }
      if (req.method === "DELETE") { rmSync(f, { force: true }); rmSync(srcOf(f), { force: true }); if (roster.carPaints) delete roster.carPaints[ctid]; save(roster); json(res, 200, { ok: true }); return true; }
      if (req.method === "PUT") {
        const crid = Number(q("crid")); if (!base().tables.get("CRSK").rows.some(r => r.CRID === crid && r.CTID === ctid)) throw new Error("that scheme is not that car's");
        const chunks = []; let k = 0; for await (const c of req) { k += c.length; if (k > 16e6) throw new Error("picture too large"); chunks.push(c); }
        const buf = Buffer.concat(chunks), img = decodePNG(buf); if (img.width > 4096 || img.height > 4096) throw new Error("picture too large (4096 px at most)");
        const layout = LAYOUTS[q("layout")] ? q("layout") : "game";
        mkdirSync(join(root, "paint"), { recursive: true }); writeFileSync(srcOf(f), buf); deriveStock(ctid, layout);
        (roster.carPaints ??= {})[ctid] = { crid, layout }; save(roster); json(res, 200, { ok: true, width: img.width, height: img.height }); return true;
      }
    }
    if (req.method === "GET" && p === "/api/roster/base" && q("kind") === "scheme") {   // one paint scheme of the game's (CARDATA entry CTID)
      const n = Number(q("n")), t = terf("CARDATA.DAT"); if (!(Number.isInteger(n) && n >= 0 && n < Math.min(t.count, ROOKIE_STRIPE_BASE))) { json(res, 404, { error: "none" }); return true; }
      const m = decodeMMAP(t.entry(n)); png(encodePNG(m.width, m.height, m.rgba)); return true;
    }
    if (req.method === "GET" && p === "/api/roster/base") {
      const kind = q("kind"), n = Number(q("n"));
      if (kind === "paint") {                                       // the car's paint (CARDATA.DAT, entry CRSK CTID)
        const car = baseInfo().cars.find(c => c.crid === n); if (!car || car.ctid === undefined) throw new Error("no such car");
        const t = decodeMMAP(terf("CARDATA.DAT").entry(car.ctid)); png(encodePNG(t.width, t.height, t.rgba)); return true;
      }
      if (kind === "crew") {                                        // the car's pit crew uniforms (CHARTEX.DAT entry CRSK PTEX) as a sheet
        const car = baseInfo().cars.find(c => c.crid === n), t = terf("CHARTEX.DAT"), e = car?.ptex ?? -1;
        if (!(e >= 0 && e < Math.min(80, t.count))) { json(res, 404, { error: "none" }); return true; }
        const sh = crewSheet(decodeCrew(t.entry(e)), 4); png(encodePNG(sh.width, sh.height, sh.rgba)); return true;
      }
      if (kind === "pitBox") {                                      // the pit box sheet (TK_PBNR entry 0, the game's grey before it is tinted) at 3x: the template
        const p = decodeMMAP(terf("TK_PBNR.DAT").entry(0)), S = 3, W = p.width * S, H = p.height * S, o = new Uint8Array(W * H * 4);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const s = ((y / S | 0) * p.width + (x / S | 0)) * 4, d = (y * W + x) * 4; o[d] = p.rgba[s]; o[d + 1] = p.rgba[s + 1]; o[d + 2] = p.rgba[s + 2]; o[d + 3] = p.rgba[s + 3]; }
        png(encodePNG(W, H, o)); return true;
      }
      if (kind === "pitSign") {                                     // the car's pit sign (TK_PBNR.DAT, entry CRSK PBNR + 3)
        const car = baseInfo().cars.find(c => c.crid === n), t = terf("TK_PBNR.DAT"), e = car?.pbnr !== undefined ? car.pbnr + 3 : -1;
        if (!(e >= 2 && e < t.count)) { json(res, 404, { error: "none" }); return true; }
        const m = decodeMMAP(t.entry(e)); png(encodePNG(m.width, m.height, m.rgba)); return true;
      }
      const bundle = { portrait: "UIS_DRPO.DAT", closeup: "UIS_DRPS.DAT", number: "UIS_DRNM.DAT" }[kind]; if (!bundle) throw new Error("bad picture kind");
      const t = terf(bundle); if (!(n >= 0 && n < t.count)) { json(res, 404, { error: "none" }); return true; }
      const m = decodeMMAP(t.entry(n)); png(encodePNG(m.width, m.height, m.rgba)); return true;
    }
    json(res, 404, { error: "not found" }); return true;
  };
}
