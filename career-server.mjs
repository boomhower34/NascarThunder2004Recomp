// career-server.mjs — the launcher's Career tab, server side: silly season settings saved to roster/career.json
// ({ sillySeason: {...} }, merged into the game's configuration by nt04-config.mjs withCareer; silly-season.mjs).
//
// API (JSON):
//   GET  /api/career      { sillySeason (as saved, defaults filled in), defaults }
//   POST /api/career      { sillySeason }   saved after checking (numbers clamped to their ranges)
//   GET  /api/career/pool { drivers: the game's own rookie pool (drivers of its CTYP 4 cars), removed: [DRID],
//                           busch: the Busch drivers (CTYP 3, not the Busch records of Cup drivers: DDRV) for sillySeason.noPromote }
//   POST /api/career/pool { drids }   the pool drivers careers never pick (career.json poolRemoved; silly-season.mjs
//                                      applyPoolRemoved), with the game's own silly season or this one
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { options, DEFAULTS } from "./silly-season.mjs";
import { openDatabases } from "./nascar-db.mjs";

export function createCareer({ here, data, user = here }) {   // (user: the preset's folder, launcher.mjs)
  let db = null;
  const base = () => db ??= openDatabases(["NASCAR.DB", "GMODEDB.DAT"].map(f => join(data ?? "", f)).filter(existsSync));
  // the game's rookie pool: its CTYP 4 cars' drivers (not ones the Roster tab added: DRID 250 and up)
  const pool = () => {
    const T = n => base().tables.get(n)?.rows ?? [], drv = new Map(T("DRVR").map(r => [r.DRID, r]));
    return T("CARS").filter(c => c.CTYP === 4 && c.DRID >= 0 && c.DRID < 250 && drv.has(c.DRID)).map(c => {
      const d = drv.get(c.DRID), name = `${String(d.FNAM).trim()} ${String(d.LNAM).trim()}`.trim();
      const kind = /^SZ /.test(name) ? "tutorial" : /EA SPORTS/i.test(name) ? "promo" : null;
      return { drid: d.DRID, crid: c.CRID, name, number: String(c.CNMD || c.CNUM).trim(), born: d.BYER, rating: Math.round((d.DSPD + d.DCTL + d.DDEF + d.DAGR + d.DDUR) / 5), kind };
    }).sort((a, b) => a.name.localeCompare(b.name));
  };
  const busch = () => {
    const T = n => base().tables.get(n)?.rows ?? [], drv = new Map(T("DRVR").map(r => [r.DRID, r])), twins = new Set(T("DDRV").map(r => r.DDRD)), teams = new Map(T("TEAM").map(r => [r.TMID, r.TMNM]));
    return T("CARS").filter(c => c.CTYP === 3 && c.DRID >= 0 && drv.has(c.DRID) && !twins.has(c.DRID)).map(c => {
      const d = drv.get(c.DRID);
      return { drid: d.DRID, name: `${String(d.FNAM).trim()} ${String(d.LNAM).trim()}`.trim(), number: String(c.CNMD || c.CNUM).trim(), born: d.BYER, team: teams.get(c.TMID) ?? "", rating: Math.round((d.DSPD + d.DCTL + d.DDEF + d.DAGR + d.DDUR) / 5) };
    }).concat(rosterBusch()).sort((a, b) => (+a.number || 999) - (+b.number || 999));
  };
  // Busch drivers added in the Roster tab (roster/roster.json: car class 3; DRID = the driver's id)
  const rosterBusch = () => {
    try {
      const r = JSON.parse(readFileSync(join(user, "roster", "roster.json"), "utf8"));
      return (r.drivers ?? []).filter(d => +d.car?.class === 3 && Number.isInteger(d.id)).map(d => ({ drid: d.id, name: `${d.first ?? ""} ${d.last ?? ""}`.trim(), number: String(d.car?.number ?? ""), born: d.born?.year ?? "?",
        team: typeof d.car?.team === "object" ? d.car.team?.name ?? "" : (base().tables.get("TEAM")?.rows.find(t => t.TMID === +d.car?.team)?.TMNM ?? ""), rating: d.ratings ? Math.round(["speed", "control", "defense", "aggression", "durability"].reduce((a, k) => a + (+d.ratings[k] || 0), 0) / 5) : "?", added: true }));
    } catch { return []; }
  };
  const file = join(user, "roster", "career.json");
  const load = () => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } };
  return async function handle(req, res, url, { json, body }) {
    const p = url.pathname;
    if (p === "/api/career/pool") {
      if (req.method === "GET") { json(res, 200, { drivers: pool(), removed: load().poolRemoved ?? [], busch: busch() }); return true; }
      if (req.method === "POST") {
        const { drids } = await body(req), known = new Set(pool().map(d => d.drid)), s = load();
        s.poolRemoved = [...new Set((Array.isArray(drids) ? drids : []).map(Number).filter(d => known.has(d)))].sort((a, b) => a - b);
        mkdirSync(join(user, "roster"), { recursive: true }); writeFileSync(file, JSON.stringify(s, null, 2));
        json(res, 200, { removed: s.poolRemoved }); return true;
      }
    }
    if (p !== "/api/career") return false;
    if (req.method === "GET") { json(res, 200, { sillySeason: options(load().sillySeason ?? {}), defaults: options(DEFAULTS), saved: existsSync(file) }); return true; }
    if (req.method === "POST") {
      const b = await body(req), s = load();
      s.sillySeason = options(b.sillySeason ?? {});
      mkdirSync(join(user, "roster"), { recursive: true }); writeFileSync(file, JSON.stringify(s, null, 2));
      json(res, 200, { ok: true, sillySeason: s.sillySeason }); return true;
    }
    return false;
  };
}
