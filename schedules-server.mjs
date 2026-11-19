// schedules-server.mjs — the launcher's Schedules tab, server side: season and career schedules saved to
// roster/schedules.json (applied by nt04-config.mjs withSchedules; see there for the schedule ids).
//
// API (JSON):
//   GET  /api/schedules      { races, game: { scid: [RAID] }, saved: { scid: [RAID] }, careerSchedules }
//   POST /api/schedules      { schedules: { scid: [RAID] | null }, careerSchedules }   null = back to the game's
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabases } from "./nascar-db.mjs";

const IDS = [0, 1, 2, 4, 5, 6];                               // season short / medium / long, career short / medium / long
const EXHIBITION = new Set([1, 2, 4]);                        // RACE.ASTY: All-Star, Shootout, All-Star Open

export function createSchedules({ here, data, user = here }) {   // (user: the preset's folder, launcher.mjs)
  const file = join(user, "roster", "schedules.json"), tracksDir = join(user, "roster", "tracks");
  let db = null; const base = () => db ??= openDatabases(["NASCAR.DB", "GMODEDB.DAT"].map(f => join(data, f)).filter(existsSync));
  const txt = s => String(s ?? "").replace(/[^\x20-\x7e]/g, "").trim();
  const load = () => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return {}; } };
  const races = () => {
    const T = new Map(base().tables.get("TRCK").rows.map(r => [r.TRID, r]));
    const out = base().tables.get("RACE").rows.map(r => ({ raid: r.RAID, name: txt(r.RNAM), track: txt(T.get(r.TRID)?.TSNM), trid: r.TRID, laps: r.RLAP, exhibition: EXHIBITION.has(r.ASTY) }));
    // tracks added by track packs (their races exist in the game only while the pack is switched on and built)
    if (existsSync(tracksDir)) for (const id of readdirSync(tracksDir).sort()) { try { const m = JSON.parse(readFileSync(join(tracksDir, id, "track.json"), "utf8"));
      if (m.mode === "add" && m.ids) out.push({ raid: m.ids.raid, name: txt(m.track?.race), track: txt(m.track?.short || m.track?.name), trid: m.ids.trid, laps: m.track?.laps, exhibition: false, pack: id, packOn: !!m.enabled }); } catch {} }
    return out.sort((a, b) => a.raid - b.raid);
  };
  const game = () => { const S = base().tables.get("SCHD").rows, g = {};
    for (const k of IDS) { const src = k >= 4 ? k - 4 : k; g[k] = S.filter(r => r.SCID === src).sort((a, b) => a.RORD - b.RORD).map(r => r.RAID); } return g; };

  return async function handle(req, res, url, { json, body }) {
    const p = url.pathname; if (!p.startsWith("/api/schedules")) return false;
    if (req.method === "GET" && p === "/api/schedules") { const s = load(); json(res, 200, { races: races(), game: game(), saved: s.schedules ?? {}, careerSchedules: !!s.careerSchedules }); return true; }
    if (req.method === "POST" && p === "/api/schedules") {
      const b = await body(req), s = load(), known = new Set(races().map(r => r.raid)); s.schedules ??= {};
      for (const [k, v] of Object.entries(b.schedules ?? {})) { const id = Number(k); if (!IDS.includes(id)) throw new Error(`unknown schedule ${k}`);
        if (v === null) { delete s.schedules[id]; continue; }
        if (!Array.isArray(v) || !v.length) throw new Error("a schedule needs at least one race"); if (v.length > 200) throw new Error("200 races at most");
        const list = v.map(Number); const bad = list.filter(r => !known.has(r)); if (bad.length) throw new Error(`unknown race ${bad.join(", ")}`);
        s.schedules[id] = list; }
      if (b.careerSchedules !== undefined) s.careerSchedules = !!b.careerSchedules;
      mkdirSync(join(user, "roster"), { recursive: true }); writeFileSync(file, JSON.stringify(s, null, 2));
      json(res, 200, { ok: true, saved: s.schedules, careerSchedules: !!s.careerSchedules }); return true;
    }
    return false;
  };
}
