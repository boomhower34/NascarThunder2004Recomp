// qualifying.mjs — more cars attempt to qualify than start: a qualifying session in front of the game's own field
// selection, for configurations with "qualifying": { "entrants": N } (nt04-config.mjs).
//
// How the game builds a race (found in the code):
//  - 0x139B0 fills the field: cars with CCRC = 1 and a driver, CTYP 1, then 2, 3..., each by DRVR.DPOP desc,
//    until the field size (0x21DB2C - 1 = 43) is reached; field cars get PLID -1 (humans keep PLID >= 0).
//  - 0xB1D20 (human qualifying) clears QUAL and inserts the human players' times; in a simulated race the time
//    comes from the track's base lap time [0x2DD4DC] (0 here: no track physics) plus noise.
//  - 0x4D6A0 builds the grid: each field car's slot is its driver's rank in QUAL ordered by LAPT (ms); a car not
//    in QUAL takes the next free counter value instead (which collides with ranks when QUAL is partial).
//  - The race code keeps 43 cars in fixed arrays (0x2951E0, 0x5C0 bytes per car), so the field stays <= 43.
//
// What this adds: before 0x139B0 runs, the N entrants (the first N cars in the game's own fill order, or an
// explicit entry list) post qualifying times; the fastest fill the field (humans always start unless
// playerMustQualify is set), every other car is kept out of the fill by clearing CCRC for the call (restored
// after); after 0xB1D20, QUAL is rewritten with the starters' times so the grid follows qualifying. Results are
// kept in game.qualifying (and the game.state.qualifying list), DNQs included.
//
// Lap time model (tunable): base = QGEN.PTIM (pole time, s) for the track's TPHD, spread = QGEN.SPRD (s, pole to
// last of a normal field); score = wSkill * DSKL(track type TRCK.TTYP) + wSpeed * DRVR.DSPD (0..100);
// time = base + spread * ((100 - score) / scoreRange + noise * N(0, 1)).

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ORDER_TYPES = [1, 2, 3, 4];          // the fill's type table 0x21DB3C: 0 (Quick Race only), 1, 2, 3, 4

function rng(seed) {                      // mulberry32
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const gauss = () => { let u = 0, v = 0; while (!u) u = next(); while (!v) v = next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  return { next, gauss };
}

export function installQualifying(game, opts) {
  const o = { entrants: 43, playerMustQualify: false, wSkill: 0.7, wSpeed: 0.3, scoreRange: 40, noise: 0.15, entryList: null, seed: null, ...opts };
  const db = () => game.db, T = n => db().tables.get(n)?.rows ?? [];
  const random = rng(o.seed ?? (Date.now() & 0x7fffffff));
  let pending = null;
  game.qualifying = null; game.state.qualifying ??= [];

  const session = () => {
    const ginf = T("GINF")[0] ?? {}, race = T("RACE").find(r => r.RAID === ginf.RAID) ?? {};
    const track = T("TRCK").find(t => t.TRID === race.TRID) ?? {}, q = T("QGEN").find(x => x.TPHD === track.TPHD) ?? {};
    const base = q.PTIM || 30, spread = q.SPRD || 0.5, ttyp = track.TTYP ?? 1;
    const fieldSize = Math.max(1, game.mem.r8(0x21db2c) - 1);
    const cars = T("CARS"), drivers = new Map(T("DRVR").map(d => [d.DRID, d]));
    const humans = cars.filter(c => c.PLID >= 0);
    let pool;
    if (o.entryList) pool = o.entryList.map(id => cars.find(c => c.CRID === id)).filter(c => c && c.PLID < 0 && c.DRID >= 0);
    else pool = ORDER_TYPES.flatMap(t => cars.filter(c => c.CTYP === t && c.CCRC === 1 && c.DRID >= 0 && c.PLID < 0)
      .sort((a, b) => (drivers.get(b.DRID)?.DPOP ?? 0) - (drivers.get(a.DRID)?.DPOP ?? 0)));
    // one car per driver, and never both of a duplicate pair: DDRV (DRID <-> DDRD) and DCAR (CRID <-> DCRD) list the
    // same person / car entered twice (another series' record); the game's fill marks the twin SELC = 1 and skips it
    const twinD = new Map(), twinC = new Map();
    for (const r of T("DDRV")) { twinD.set(r.DRID, r.DDRD); twinD.set(r.DDRD, r.DRID); }
    for (const r of T("DCAR")) { twinC.set(r.CRID, r.DCRD); twinC.set(r.DCRD, r.CRID); }
    const takenD = new Set(), takenC = new Set();
    const take = c => { if (takenD.has(c.DRID) || takenC.has(c.CRID)) return false;
      takenD.add(c.DRID); takenC.add(c.CRID); if (twinD.has(c.DRID)) takenD.add(twinD.get(c.DRID)); if (twinC.has(c.CRID)) takenC.add(twinC.get(c.CRID)); return true; };
    humans.forEach(take);
    pool = pool.filter(take);
    const entrants = [...humans, ...pool.slice(0, Math.max(0, o.entrants - humans.length))];
    const skill = d => T("DSKL").find(s => s.DRID === d && s.TTYP === ttyp)?.DSKL ?? 70;
    const runs = entrants.map(c => {
      const d = drivers.get(c.DRID) ?? {}, score = o.wSkill * skill(c.DRID) + o.wSpeed * (d.DSPD ?? 70);
      const time = base + spread * ((100 - score) / o.scoreRange + o.noise * random.gauss());
      return { CRID: c.CRID, DRID: c.DRID, name: `${d.FNAM ?? "?"} ${d.LNAM ?? ""}`.trim(), human: c.PLID >= 0, time: Math.round(time * 1000) };
    }).sort((a, b) => a.time - b.time);
    // starters: the fastest; humans are guaranteed a spot unless playerMustQualify (a provisional when slower)
    const humanRuns = runs.filter(r => r.human);
    const starters = o.playerMustQualify ? runs.slice(0, fieldSize)
      : [...runs.filter(r => !r.human).slice(0, Math.max(0, fieldSize - humanRuns.length)), ...humanRuns].sort((a, b) => a.time - b.time);
    const start = new Set(starters.map(r => r.CRID));
    runs.forEach((r, i) => { r.qualified = i + 1; r.dnq = !start.has(r.CRID); r.provisional = !r.dnq && !runs.slice(0, fieldSize).includes(r); });
    return { year: ginf.YEAR, round: ginf.RORD, RAID: ginf.RAID, race: race.RNAM, track: track.TRNM, base, spread, fieldSize, entrants: runs.length, results: runs, starters };
  };

  // field fill: only the starters (and humans) may be picked
  game.hooks.set(0x139b0, c => {
    let s = null;
    try { s = session(); } catch (e) { game.log(`qualifying: ${e.message}`); }
    const cars = T("CARS"), saved = cars.map(x => x.CCRC);
    if (s) { const start = new Set(s.starters.map(r => r.CRID)); for (const x of cars) if (x.PLID < 0 && !start.has(x.CRID)) x.CCRC = 0; else if (start.has(x.CRID)) x.CCRC = 1; }
    db()?.invalidate?.();                       // (rows edited in place: the database's equality indexes are rebuilt)
    try { c.passThrough = 0x139b0; game.nested(0x139b0); }
    finally { T("CARS").forEach((x, i) => { if (saved[i] !== undefined) x.CCRC = saved[i]; }); db()?.invalidate?.(); }
    if (s) {
      const placed = new Set(T("CARS").filter(x => x.PLID >= -1).map(x => x.CRID));
      s.starters = s.starters.filter(r => placed.has(r.CRID));
      pending = s; game.qualifying = s; game.state.qualifying.push(s);
      game.onQualifying?.(s);
      if (game.saveDir) try { mkdirSync(game.saveDir, { recursive: true }); appendFileSync(join(game.saveDir, "qualifying.log"), formatSession(s) + "\n"); } catch {}
      game.log(`qualifying: ${s.race} ${s.year} — ${s.entrants} entrants, ${s.starters.length} start, DNQ: ${s.results.filter(r => r.dnq).map(r => r.name).join(", ") || "none"}`);
    }
    return 0;
  });
  // human qualifying clears QUAL and inserts the humans' times: replace with the session's times for the starters
  game.hooks.set(0xb1d20, c => {
    c.passThrough = 0xb1d20; game.nested(0xb1d20);
    if (pending) {
      const t = db().tables.get("QUAL");
      t.rows = pending.starters.map(r => ({ DRID: r.DRID, LAPT: r.time }));
      if (t.rows.length > t.capacity) t.capacity = t.rows.length;
      pending = null;
    }
    return 0;
  });
}

// A qualifying sheet as text (main.mjs serves it at /qualifying; also appended to <save folder>/qualifying.log).
export function formatSession(s) {
  if (!s) return "no qualifying session yet";
  const clean = t => String(t ?? "").replace(/[\u0080-\u00ff]/g, "").trim();
  const lines = [`${clean(s.race)} — ${clean(s.track)} — ${s.year}, round ${s.round}: ${s.entrants} entrants for ${s.fieldSize} places`];
  for (const r of s.results) lines.push(`${String(r.qualified).padStart(3)}  ${r.name.padEnd(24)} ${(r.time / 1000).toFixed(3).padStart(8)}s${r.human ? "  (you)" : ""}${r.dnq ? "  DNQ" : r.provisional ? "  provisional" : ""}`);
  return lines.join("\n");
}
