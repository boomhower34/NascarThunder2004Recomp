// silly-season.mjs — the career off-season (retirements and ride changes), configurable from the launcher's Career
// tab (configuration "sillySeason", nt04-config.mjs withCareer).
//
// The game's own routine is 0xB0260, run once after the last race of a career season (0x9569A, before 0xAFCE0 starts
// the next year; also 0x7B775). It works only through database queries:
//   - candidates (a list of at most 10, highest score first; a driver found twice adds his scores):
//       the season's champion when it is his 8th title (CWIN rows): 100, i.e. certain;
//       drivers older than 48 who started a race this season and are more than 4 years past their rookie year:
//         rand(10) + 10 x (age - 48), at most 99;
//       drivers more than 4 years past their rookie year outside the top 33 in points this season (the best-placed
//         rookie excepted): rand(10) + 10 x (seasons since the last top-33 one; all of them outside: their count);
//     human players' drivers never; nothing at all when fewer than 50 cars have CCRC 1.
//   - how many go: all of them when 2 or fewer, else 2 + rand(2) (2 or 3).
//   - each retiree: DSTT 1, RETY = year; his DDRV twin (the same person's Busch-series record) DSTT 1 and that car
//     parked (CCRC 0); his APRP rows deleted; (DRID, old CRID) kept at 0x2BAB90 (3 slots) for the off-season report.
//   - his car, each a 50 % chance: the team folds (CCRC 0, the car's sponsor available again, SPON IAVA 1), or the ride
//     is filled by car type (CARS CTYP; 1 and 2 are the two Cup lists, 3 Busch, 4 the fantasy / fill-in pool):
//       Cup: the best-placed Busch driver of the season (else a random Busch driver, whose Busch seat then goes to a
//         pool driver; no Busch driver at all: a random pool driver); a promoted ranked Busch driver's car is parked;
//       Busch: the best-placed pool driver (else a random one), whose pool car the retiree gets, parked;
//       pool: the car is parked; other types (0, the classic legends): nothing.
//     Every driver who moves gets DSTT 3 and RETY = year. Pool / Busch picks need DSTT != 1 and RETY 0 (so a driver
//     moved once is never picked again).
//   - The off-season report (natives 0x95D20 / 0x95DE0, 0x95BB0) lists DSTT 1 and 3 drivers with RETY = year, then
//     0x95E50 turns DSTT 3 into 0 (had races before) or 2 (rookie); 0xB0C40 next season makes pool drivers in cars
//     rookies. Ratings (DRVR DSPD.., DSKL) are never changed by anything (here: the "progression" option).
//
// With "enabled" this module runs instead of 0xB0260: the same steps in JS (the same queries on the same engine and
// the game's own random numbers, so with the default numbers the result is the game's), every number configurable,
// and optional parts:
//   market    veterans change teams: a driver who finished well below his talent swaps rides with one who finished
//             well above his (talent = 0.7 x mean DSKL + 0.3 x DSPD, as qualifying.mjs); carFollowsDriver: the two
//             swap teams instead, so each keeps his car (number, paint, sponsor are painted on; they cannot move alone)
//   callups   a Busch driver clearly more talented than a Cup driver who finished near the back takes his ride; the
//             Cup driver gets the Busch car
//   rookies   new fictional prospects join the pool when it runs low (carless pool drivers, DSTT -1, DRID 700..);
//             customFirst: drivers added in the Roster tab's rookie pool are picked first
//   contracts team prestige + driver contracts (contractOffSeason; tables SSCT / SSTP in career saves) instead of the
//             game's ride filling, the market and the call-ups
//   news      the moves as career news (CNWS NTYP 4 "Silly Season", formatted by the hook on 0x3ED80)
// Generated prospects' track skills (DSKL, not kept in saves) are rebuilt from their DRVR row on every load
// (repairGenerated, from nt04-config.mjs applyConfig and gamecode's save load).

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dressCar, undressCar, SPONSOR_START_BASE, SPONSOR_DEAL_BASE, SPONSOR_DEAL_SLOTS } from "./nt04-config.mjs";

export const DEFAULTS = {
  enabled: false,
  minActiveCars: 50, retireAge: 48, agePoints: 10, veteranYears: 4, rankCutoff: 33, strugglePoints: 10,
  championTitles: 8, maxCandidates: 10, retireMin: 2, retireMax: 3, foldChance: 50,
  market: { enabled: false, moves: 2, gap: 8, chance: 60, carFollowsDriver: false },
  callups: { enabled: false, max: 2, rank: 30, margin: 5, chance: 50 },
  revival: { enabled: false, max: 2, chance: 50, cupCars: 40, buschCars: 15 },
  sponsors: { enabled: false, moves: 2, chance: 60, minYears: 2, maxYears: 4, renew: 50 },
  contracts: { enabled: false, minYears: 1, maxYears: 4, tolerance: 10, resign: 85, prestigeSpeed: 25, foldByPrestige: true, sitOut: 2 },
  rookies: { generate: false, poolMinimum: 12, perYear: 4, ratingMin: 55, ratingMax: 80, ageMin: 18, ageMax: 25, customFirst: false },
  news: true,
  fixes: false,
  noPromote: [],
  progression: { enabled: false, growUntil: 27, declineFrom: 36, growth: 3, decline: 1, randomness: 2, results: true, players: false },
};
export const GEN_BASE = 700;                     // generated prospects' DRIDs (roster drivers use 250..)
export const NEWS_TYPE = 4;
export const NEWS_MAX = 56;                      // characters of a news line (the stock ones run to ~45)                      // CNWS NTYP of silly season news (ECNT 4 "Silly Season")
const KIND = { sponsor: 11, sponsorLeaves: 10, retired: 9, folded: 8, revived: 7, promoted: 6, moved: 5, rookie: 4, lostRide: 3, prospect: 2, released: 1 };
// the Sponsors tab's schemes by id (names for the news; set by installSillySeason from the game's configuration)
export const sponsorNames = new Map();

const num = (v, d, lo, hi) => { const x = Number(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, Math.round(x))) : d; };
export function options(o = {}) {
  const D = DEFAULTS, m = o.market ?? {}, c = o.callups ?? {}, r = o.rookies ?? {};
  const out = {
    enabled: !!o.enabled,
    minActiveCars: num(o.minActiveCars, D.minActiveCars, 0, 999), retireAge: num(o.retireAge, D.retireAge, 20, 99),
    agePoints: num(o.agePoints, D.agePoints, 0, 100), veteranYears: num(o.veteranYears, D.veteranYears, 0, 50),
    rankCutoff: num(o.rankCutoff, D.rankCutoff, 1, 99), strugglePoints: num(o.strugglePoints, D.strugglePoints, 0, 100),
    championTitles: num(o.championTitles, D.championTitles, 0, 99), maxCandidates: num(o.maxCandidates, D.maxCandidates, 1, 40),
    retireMin: num(o.retireMin, D.retireMin, 0, 40), retireMax: num(o.retireMax, D.retireMax, 0, 40), foldChance: num(o.foldChance, D.foldChance, 0, 100),
    market: { enabled: !!m.enabled, moves: num(m.moves, D.market.moves, 0, 20), gap: num(m.gap, D.market.gap, 1, 40), chance: num(m.chance, D.market.chance, 0, 100), carFollowsDriver: !!m.carFollowsDriver },
    sponsors: { enabled: !!o.sponsors?.enabled, moves: num(o.sponsors?.moves, D.sponsors.moves, 0, 20), chance: num(o.sponsors?.chance, D.sponsors.chance, 0, 100),
      minYears: num(o.sponsors?.minYears, D.sponsors.minYears, 1, 10), maxYears: num(o.sponsors?.maxYears, D.sponsors.maxYears, 1, 10), renew: num(o.sponsors?.renew, D.sponsors.renew, 0, 100) },
    revival: { enabled: !!o.revival?.enabled, max: num(o.revival?.max, D.revival.max, 0, 10), chance: num(o.revival?.chance, D.revival.chance, 0, 100),
      cupCars: num(o.revival?.cupCars, D.revival.cupCars, 0, 80), buschCars: num(o.revival?.buschCars, D.revival.buschCars, 0, 80) },
    contracts: { enabled: !!o.contracts?.enabled, minYears: num(o.contracts?.minYears, D.contracts.minYears, 1, 10), maxYears: num(o.contracts?.maxYears, D.contracts.maxYears, 1, 10),
      tolerance: num(o.contracts?.tolerance, D.contracts.tolerance, 0, 100), resign: num(o.contracts?.resign, D.contracts.resign, 0, 100),
      prestigeSpeed: num(o.contracts?.prestigeSpeed, D.contracts.prestigeSpeed, 0, 100), foldByPrestige: o.contracts?.foldByPrestige !== false,
      sitOut: num(o.contracts?.sitOut, D.contracts.sitOut, 0, 10) },
    callups: { enabled: !!c.enabled, max: num(c.max, D.callups.max, 0, 10), rank: num(c.rank, D.callups.rank, 1, 99), margin: num(c.margin, D.callups.margin, 0, 50), chance: num(c.chance, D.callups.chance, 0, 100) },
    rookies: { generate: !!r.generate, poolMinimum: num(r.poolMinimum, D.rookies.poolMinimum, 0, 60), perYear: num(r.perYear, D.rookies.perYear, 0, 20),
      ratingMin: num(r.ratingMin, D.rookies.ratingMin, 20, 100), ratingMax: num(r.ratingMax, D.rookies.ratingMax, 20, 100),
      ageMin: num(r.ageMin, D.rookies.ageMin, 15, 40), ageMax: num(r.ageMax, D.rookies.ageMax, 15, 45), customFirst: !!r.customFirst },
    news: o.news !== false,
    fixes: !!o.fixes,
    teamPrestige: Object.fromEntries(Object.entries(o.teamPrestige ?? {}).map(([k, v]) => [+k, Math.round(+v)]).filter(([k, v]) => Number.isInteger(k) && v >= 0 && v <= 100)),
    progression: { enabled: !!o.progression?.enabled, growUntil: num(o.progression?.growUntil, D.progression.growUntil, 16, 45), declineFrom: num(o.progression?.declineFrom, D.progression.declineFrom, 20, 60),
      growth: num(o.progression?.growth, D.progression.growth, 0, 10), decline: num(o.progression?.decline, D.progression.decline, 0, 10), randomness: num(o.progression?.randomness, D.progression.randomness, 0, 10),
      results: o.progression?.results !== false, players: !!o.progression?.players },
    noPromote: [...new Set((Array.isArray(o.noPromote) ? o.noPromote : []).map(Number).filter(Number.isInteger))].slice(0, 200),   // Busch drivers never moved up to Cup
  };
  out.retireMax = Math.max(out.retireMax, out.retireMin);
  if (out.rookies.ratingMax < out.rookies.ratingMin) out.rookies.ratingMax = out.rookies.ratingMin;
  if (out.contracts.maxYears < out.contracts.minYears) out.contracts.maxYears = out.contracts.minYears;
  if (out.rookies.ageMax < out.rookies.ageMin) out.rookies.ageMax = out.rookies.ageMin;
  return out;
}

// ------------------------------------------------------------------------------------------------ the off-season
// db: the game's database (nascar-db.mjs Database); rand(n): 0..n-1 (the game's generator in the game).
export function runSillySeason(db, opts, rand, library = []) {
  const o = options({ ...opts, enabled: true });
  const T = n => db.tables.get(n)?.rows ?? [];
  const q = (sql, ...p) => db.exec(sql, p);
  const rows = (sql, ...p) => q(sql, ...p).rows;
  const first = (sql, ...p) => q(sql, ...p).rows[0];
  const R = n => (n > 0 ? rand(n) : 0);
  const year = T("GINF")[0]?.YEAR ?? 0;
  const res = { year, events: [], retired: [], oldCar: new Map(), changed: false };
  const ev = (kind, a = 0, b = 0, c = 0, text = "") => res.events.push({ kind, a, b, c, text });
  const name = id => { const d = T("DRVR").find(r => r.DRID === id); return d ? `${String(d.FNAM).trim()} ${String(d.LNAM).trim()}`.trim() : `driver ${id}`; };

  // the game marks every driver it moves with RETY = year for good, and only picks drivers with RETY 0: a pool driver
  // moved up to a Busch car could never move up again. With any of the extra parts on, last years' marks go.
  const recent = new Set(T("DRVR").filter(d => d.DSTT !== 1 && d.RETY === year - 1).map(d => d.DRID));   // moved last off-season
  if (o.fixes || o.market.enabled || o.callups.enabled || o.rookies.generate || o.rookies.customFirst || o.revival.enabled || o.contracts.enabled)
    for (const d of T("DRVR")) if (d.DSTT !== 1 && d.RETY > POOL_OUT && d.RETY < year) d.RETY = 0;   // (POOL_OUT: left out of the pool)
  const players = rows("select 'DRID' from 'CARS' where 'PLID' > ?", -1).map(r => r[0]).slice(0, 4);
  while (players.length < 4) players.push(-1);
  const P4 = players, notP = "'DRVR'.'DRID' != ? and 'DRVR'.'DRID' != ? and 'DRVR'.'DRID' != ? and 'DRVR'.'DRID' != ?";
  if (o.progression.enabled) res.progression = progressRatings(db, o.progression, R, P4, year);   // (every off-season, also one the game skips)
  if ((first("select count('CCRC') from 'CARS' where 'CCRC' == 1")?.[0] ?? 0) <= o.minActiveCars - 1) return res;

  // fixes: a DDRV twin (DDRD: the Busch-series record of a Cup driver) is the same person; the game let the record
  // retire on its own (parking the person's Cup car with it) and promoted it into a second Cup car
  const busch2 = new Set(o.fixes ? T("DDRV").map(r => r.DDRD) : []);
  // candidates: at most maxCandidates, highest score first (0xB0180)
  const list = [];
  const add = (id, score) => {
    if (score < 0 || busch2.has(id)) return;
    const i = list.findIndex(e => e.id === id); if (i >= 0) { score += list[i].score; list.splice(i, 1); }
    let at = list.findIndex(e => e.score < score); if (at < 0) { if (list.length >= o.maxCandidates) return; at = list.length; }
    list.splice(at, 0, { id, score }); if (list.length > o.maxCandidates) list.length = o.maxCandidates;
  };
  const cap = v => Math.min(99, v);
  // the champion on his Nth title
  const champ = first("select 'DRID' from 'DRST' where 'CWIN' = 1 and 'YEAR' = ? and 'DRID' != ? and 'DRID' != ? and 'DRID' != ? and 'DRID' != ?", year, ...P4);
  if (champ && o.championTitles > 0) { const n = first("select count('CWIN') from 'DRST' where 'CWIN' = 1 and 'DRID' = ?", champ[0])?.[0] ?? 0; if (n === o.championTitles) add(champ[0], 100); }
  // age
  for (const [id, born] of rows(`select 'DRVR'.'DRID' and 'DRVR'.'BYER' from 'DRVR' inner join 'DRST' on 'DRVR'.'DRID' = 'DRST'.'DRID' where 'DRVR'.'DSTT' != ? and 'DRVR'.'DSTT' != ? and 'DRVR'.'BYER' < ? and 'DRVR'.'RKYR' < ? and 'DRST'.'RSTR' > 0 and 'DRST'.'YEAR' = ? and ${notP} order by 'DRVR'.'BYER' asc`,
    1, 4, year - o.retireAge, year - o.veteranYears, year, ...P4)) {
    const r = R(10); add(id, cap(r + o.agePoints * (year - born - o.retireAge)));
  }
  // seasons outside the top N
  const strugglers = rows(`select 'DRVR'.'DRID' from 'DRVR' inner join 'DRST' on 'DRVR'.'DRID' = 'DRST'.'DRID' where 'DRVR'.'RKYR' < ? and 'DRST'.'YEAR' = ? and 'DRST'.'CRNK' > ? and ${notP}`, year - o.veteranYears, year, o.rankCutoff, ...P4);
  const bestRookieRank = first("select min('DRST'.'CRNK') from 'DRST' inner join 'DRVR' on 'DRST'.'DRID' = 'DRVR'.'DRID' where 'DRST'.'YEAR' = ? and 'DRVR'.'DSTT' = ?", year, 2)?.[0];
  const bestRookie = bestRookieRank !== undefined && bestRookieRank !== null ? first("select 'DRID' from 'DRST' where 'YEAR' = ? and 'CRNK' = ?", year, bestRookieRank)?.[0] : undefined;
  for (const [id] of strugglers) {
    if (bestRookie !== undefined && id === bestRookie) continue;
    const good = rows("select 'YEAR' from 'DRST' where 'DRID' = ? and 'CRNK' <= ? order by 'YEAR' desc", id, o.rankCutoff);
    const seasons = good.length ? year - good[0][0] : (first("select count('YEAR') from 'DRST' where 'DRID' = ? and 'CRNK' > ?", id, o.rankCutoff)?.[0] ?? 0);
    const r = R(10); add(id, cap(r + o.strugglePoints * seasons));
  }
  // how many go
  let n = list.length;
  if (n > o.retireMin) { const k = Math.min(n, o.retireMax); n = o.retireMin + R(k - o.retireMin + 1); }
  const retirees = list.slice(0, n).map(e => e.id);
  const carOf = id => T("CARS").find(c => c.DRID === id);
  const drv = id => T("DRVR").find(d => d.DRID === id);
  const setD = (id, f) => { const d = drv(id); if (d) Object.assign(d, f); };
  const setC = (crid, f) => { for (const c of T("CARS")) if (c.CRID === crid) Object.assign(c, f); };
  const team = c => String(T("TEAM").find(t => t.TMID === c?.TMID)?.TMNM ?? "").trim();
  const seasonsOf = id => T("DRST").filter(r => r.DRID === id).length;

  const twinCars = [];                               // (fixes) the retiree's Busch car: filled from the pool, not parked
  for (const id of retirees) {
    db.tables.get("APRP") && (db.tables.get("APRP").rows = T("APRP").filter(r => r.DRID !== id));
    const c = carOf(id); res.oldCar.set(id, c ? c.CRID : -1);
    setD(id, { DSTT: 1, RETY: year });
    const tw = T("DDRV").find(r => r.DDRD === id)?.DRID ?? T("DDRV").find(r => r.DRID === id)?.DDRD;
    if (tw !== undefined) { setD(tw, { DSTT: 1, RETY: 0 });
      for (const x of T("CARS")) if (x.DRID === tw) { if (o.fixes && x.CCRC === 1 && x.CTYP === 3) twinCars.push(x.CRID); else x.CCRC = 0; } }
    res.retired.push(id);
    ev(KIND.retired, id, seasonsOf(id), T("DRST").filter(r => r.DRID === id && r.CWIN === 1).length, `${name(id)} retires after ${seasonsOf(id)} season${seasonsOf(id) === 1 ? "" : "s"}`);
  }
  db.invalidate?.();

  // the pool: the game's own picks, or (custom pool options) talent with the Roster tab's pool drivers first
  const skills = new Map(); for (const s of T("DSKL")) { const a = skills.get(s.DRID) ?? []; a.push(s.DSKL); skills.set(s.DRID, a); }
  const talent = id => { const d = drv(id), s = skills.get(id); const sk = s?.length ? s.reduce((a, b) => a + b, 0) / s.length : 70; return 0.7 * sk + 0.3 * (d?.DSPD ?? 70); };
  const customPool = o.rookies.generate || o.rookies.customFirst;
  const poolDrivers = () => {                        // carless pool drivers: generated prospects and Roster pool drivers without a car
    const inCar = new Set(T("CARS").map(c => c.DRID));
    return T("DRVR").filter(d => d.DSTT === -1 && d.RETY === 0 && !inCar.has(d.DRID) && d.DRID >= 250).map(d => d.DRID);
  };
  const nb = r => r.filter(([d]) => !busch2.has(d));
  const noUp = new Set(o.noPromote), up = r => r.filter(([d]) => !noUp.has(d));   // (the Career tab's Busch drivers who stay in Busch)
  const ranked = (ctyp, extra = "", ...ep) => nb(rows(`select 'CARS'.'DRID' and 'CARS'.'CRID' from 'CARS' inner join 'DRST' on 'CARS'.'DRID' = 'DRST'.'DRID' inner join 'DRVR' on 'DRVR'.'DRID' = 'DRST'.'DRID' where 'CARS'.'CCRC' = 1 and 'DRVR'.'DSTT' != ? and 'DRVR'.'RETY' = ? and 'CARS'.'CTYP' = ? and 'DRST'.'YEAR' = ?${extra} and ${notP} order by 'DRST'.'CRNK'`, 1, 0, ctyp, year, ...ep, ...P4));
  const unranked = (ctyp, extra = "", ...ep) => nb(rows(`select 'CARS'.'DRID' and 'CARS'.'CRID' from 'CARS' inner join 'DRVR' on 'DRVR'.'DRID' = 'CARS'.'DRID' where 'CARS'.'CCRC' = 1 and 'DRVR'.'DSTT' != ? and 'DRVR'.'RETY' = ? and 'CARS'.'CTYP' = ?${extra} and ${notP}`, 1, 0, ctyp, ...ep, ...P4));
  // a pool pick: [DRID, CRID or -1]
  const pickPool = () => {
    if (customPool) {
      const young = ([d]) => year - (drv(d)?.BYER ?? year) < o.retireAge;     // (the game's pool has its broadcasters in it)
      const cand = [...unranked(4, " and 'CARS'.'DRID' != ?", -1).map(([d, c]) => [d, c]), ...poolDrivers().map(d => [d, -1])].filter(young);
      if (!cand.length) return null;
      const roster = d => d >= 250 && d < GEN_BASE;
      const score = ([d]) => (o.rookies.customFirst && roster(d) ? 1000 : 0) + talent(d) + R(10);
      return cand.map(x => [x, score(x)]).sort((a, b) => b[1] - a[1])[0][0];
    }
    const a = ranked(4, " and 'CARS'.'DRID' != ?", -1); if (a.length) return a[0];
    const b = unranked(4, " and 'CARS'.'DRID' != ?", -1); if (b.length) return b[R(b.length)];
    return null;
  };
  const moved = new Set();
  const markMoved = id => { setD(id, { DSTT: 3, RETY: year }); moved.add(id); };


  // ---------------------------------------------------------------- team prestige and driver contracts
  // (contracts.enabled: instead of the game's ride filling, the call-ups and the market) Every AI driver in a running
  // Cup / Busch car holds a contract (table SSCT: DRID, TMID, YEND last season, LENG; kept in career saves) and every
  // team a prestige 0..100 (SSTP: TMID, PRES), moved each year toward its best Cup result. A driver's standing 0..100
  // = talent percentile (with results of the last two seasons, half and half; a driver without results at 80 %). A
  // Cup seat asks standing >= the team's prestige - tolerance (keeping a driver: 2 x tolerance); only retirements, folds,
  // comebacks and expiring contracts open seats; drivers under contract stay, except Busch and pool drivers, whom any
  // Cup / Busch team may sign up. Expiring: worthy drivers re-sign (resign %), the others become free agents; seats
  // are filled best team first with the best eligible driver (nobody eligible: the best there is). A free agent left
  // without a ride sitOut years retires.
  function contractOffSeason() {
    const K = o.contracts; ensureTables(db);
    const mean = a => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    const CT = db.tables.get(CONTRACTS), PT = db.tables.get(PRESTIGE);
    const twinsAll = new Set(T("DDRV").flatMap(r => [r.DRID, r.DDRD]));
    const ai = id => id >= 0 && !P4.includes(id) && !twinsAll.has(id);
    const running = c => c.CCRC === 1 && c.PLID < 0 && [1, 2, 3].includes(c.CTYP);
    const age = id => year - (drv(id)?.BYER ?? year);
    const resScore = id => { let w = 0, s = 0; for (const r of T("DRST")) if (r.DRID === id && (r.YEAR === year || r.YEAR === year - 1)) { const k = r.YEAR === year ? 2 : 1; w += k; s += k * Math.max(0, 100 - (r.CRNK - 1) * 2.4); } return w ? s / w : null; };
    const tal = T("DRVR").filter(d => d.DRID >= 0 && d.DSTT !== 1).map(d => talent(d.DRID)).sort((a, b) => a - b);
    const tPct = id => { const t = talent(id); let n = 0; for (const v of tal) if (v < t) n++; return 100 * n / Math.max(1, tal.length - 1); };
    const stCache = new Map();
    const standing = id => { if (!stCache.has(id)) { const r = resScore(id), t = tPct(id); stCache.set(id, r === null ? 0.8 * t : 0.5 * t + 0.5 * r); } return stCache.get(id); };
    // prestige
    const pres = new Map(PT.rows.map(r => [r.TMID, r.PRES])), pres0 = new Map(pres);   // (pres0: last year's, for the report)
    const teams = [...new Set(T("CARS").filter(c => [1, 2, 3].includes(c.CTYP) && c.PLID < 0).map(c => c.TMID))];
    for (const tm of teams) {
      const cars = T("CARS").filter(c => c.TMID === tm && running(c)), cupC = cars.filter(c => c.CTYP !== 3);
      if (!pres.has(tm) && Number.isInteger(o.teamPrestige?.[tm])) { pres.set(tm, o.teamPrestige[tm]); continue; }   // (a Roster tab team's starting prestige)
      if (!pres.has(tm)) {                       // first off-season of this career: from the drivers it has
        pres.set(tm, cupC.length ? mean(cupC.map(c => standing(c.DRID) + (c.CTYP === 1 ? 5 : 0))) : cars.length ? 0.45 * mean(cars.map(c => standing(c.DRID))) : 20);
        continue;
      }
      const rs = cupC.map(c => { const r = T("DRST").find(x => x.DRID === c.DRID && x.YEAR === year); return r ? Math.max(0, 100 - (r.CRNK - 1) * 2.4) + (r.CWIN ? 10 : 0) : 0.5 * standing(c.DRID); });
      const score = rs.length ? mean(rs) : cars.length ? 0.45 * mean(cars.map(c => standing(c.DRID))) : 15;
      pres.set(tm, pres.get(tm) * (1 - K.prestigeSpeed / 100) + score * K.prestigeSpeed / 100);
    }
    for (const [k, v] of pres) pres.set(k, Math.max(5, Math.min(99, Math.round(v))));
    // what a seat asks: a Cup seat the team's prestige; Busch seats nothing (the game rates its Busch drivers below
    // its fill-in drivers, so they would never qualify), they are only filled in prestige order
    const level = c => ([1, 2].includes(c.CTYP) ? pres.get(c.TMID) ?? 20 : 0);
    const order = c => ([1, 2].includes(c.CTYP) ? 100 : 0) + (pres.get(c.TMID) ?? 20);
    const len = id => { const n = K.minYears + R(K.maxYears - K.minYears + 1); return age(id) >= o.retireAge - 3 ? Math.min(n, 2) : n; };
    // contracts: everyone driving gets one (the first year: 1..maxYears seasons left, so they end at different times)
    const con = new Map(CT.rows.map(r => [r.DRID, { ...r }]));
    const sign = (id, tm, n) => con.set(id, { DRID: id, TMID: tm, YEND: year + n, LENG: n });
    for (const c of T("CARS")) if (running(c) && ai(c.DRID) && !res.retired.includes(c.DRID)) {
      const k = con.get(c.DRID);
      if (!k || k.TMID === 255) { const n = 1 + R(K.maxYears); con.set(c.DRID, { DRID: c.DRID, TMID: c.TMID, YEND: year + n, LENG: n }); }
      else if (k.TMID !== c.TMID) sign(c.DRID, c.TMID, len(c.DRID));
    }
    for (const id of res.retired) con.delete(id);
    const seats = [], fa = new Set(), out = { resigned: 0, signed: 0, released: 0 };
    const released = new Map();                  // driver -> { team, event index }
    const open = c => { seats.push(c.CRID); c.DRID = -1; };
    const foldedNow = new Set();                 // (not brought back in the same off-season)
    // retirees' cars: fold (less likely for prestigious teams) or an open seat
    for (const id of retirees) {
      const c = carOf(id); if (!c) continue;
      if (c.CTYP === 4 || c.CTYP === 0) { for (const x of T("CARS")) if (x.DRID === id) x.CCRC = 0; continue; }
      const P = pres.get(c.TMID) ?? 50, chance = K.foldByPrestige ? o.foldChance * Math.max(0, Math.min(2, (100 - P) / 50)) : o.foldChance;
      if (R(100) < chance) { for (const x of T("CARS")) if (x.DRID === id) { x.CCRC = 0; foldedNow.add(x.CRID); } for (const s of T("SPON")) if (s.SPID === c.SPID) s.IAVA = 1; ev(KIND.folded, c.CRID, c.TMID, 0); continue; }
      open(c);
    }
    for (const crid of twinCars) { const c = T("CARS").find(x => x.CRID === crid); if (c) open(c); }
    // expiring contracts
    for (const c of T("CARS")) {
      if (!running(c) || !ai(c.DRID) || res.retired.includes(c.DRID)) continue;
      const k = con.get(c.DRID); if (!k || k.YEND > year) continue;
      const id = c.DRID, worthy = standing(id) >= level(c) - 2 * K.tolerance;   // keeping a driver: twice the slack
      if (worthy && R(100) < K.resign) { sign(id, c.TMID, len(id)); out.resigned++; continue; }
      released.set(id, { tm: c.TMID, ev: res.events.length }); ev(KIND.released, id, c.CRID, 0);
      con.set(id, { DRID: id, TMID: 255, YEND: year, LENG: 0 }); fa.add(id); open(c); out.released++;
    }
    // last years' free agents still around
    for (const k of con.values()) if (k.TMID === 255 && ai(k.DRID) && [0, 2, 3].includes(drv(k.DRID)?.DSTT) && !T("CARS").some(c => running(c) && c.DRID === k.DRID)) fa.add(k.DRID);
    // folded teams come back: parked cars as seats
    if (o.revival.enabled) {
      let done = 0;
      const runningN = types => T("CARS").filter(c => types.includes(c.CTYP) && c.CCRC === 1 && c.PLID < 0).length;
      for (const [types, target] of [[[1, 2], o.revival.cupCars], [[3], o.revival.buschCars]])
        for (const c of T("CARS").filter(c => types.includes(c.CTYP) && c.CCRC === 0 && c.PLID < 0 && !foldedNow.has(c.CRID) && !(c.CRID >= 183 && c.CRID <= 202) && !(c.DRID >= 0 && drv(c.DRID) && drv(c.DRID).DSTT !== 1))) {
          if (done >= o.revival.max || runningN(types) >= target) break;
          if (R(100) >= o.revival.chance) continue;
          c.DRID = -1; c.revive = true; seats.push(c.CRID); done++;
          for (const s of T("SPON")) if (s.SPID === c.SPID) s.IAVA = 0;
          if (!pres.has(c.TMID)) pres.set(c.TMID, 25);
        }
    }
    // fill the seats, best team first
    const young = d => age(d) < o.retireAge;
    const roster = d => d >= 250 && d < GEN_BASE;
    for (let guard = 0; seats.length && guard < 400; guard++) {
      seats.sort((a, b) => order(T("CARS").find(x => x.CRID === b)) - order(T("CARS").find(x => x.CRID === a)));
      const crid = seats.shift(), seat = T("CARS").find(x => x.CRID === crid), cupSeat = seat.CTYP !== 3;
      const cand = [];                            // [driver, his car or -1, kind]
      for (const d of fa) cand.push([d, -1, KIND.moved]);
      if (cupSeat) for (const c of T("CARS")) if (running(c) && c.CTYP === 3 && ai(c.DRID) && !noUp.has(c.DRID) && !moved.has(c.DRID) && !res.retired.includes(c.DRID)) cand.push([c.DRID, c.CRID, KIND.promoted]);
      for (const c of T("CARS")) if (c.CCRC === 1 && c.CTYP === 4 && c.PLID < 0 && ai(c.DRID) && drv(c.DRID)?.DSTT === -1 && drv(c.DRID)?.RETY !== POOL_OUT && young(c.DRID)) cand.push([c.DRID, c.CRID, KIND.rookie]);
      for (const d of poolDrivers()) if (young(d)) cand.push([d, -1, KIND.rookie]);
      if (!cand.length) { seat.CCRC = 0; delete seat.revive; ev(KIND.folded, seat.CRID, seat.TMID, 0); continue; }
      const need = level(seat) - K.tolerance;
      const score = ([d]) => standing(d) + R(6) + (o.rookies.customFirst && roster(d) ? 15 : 0);
      const scored = cand.map(x => [x, score(x)]).sort((a, b) => b[1] - a[1]);
      const [d, from, kind] = (scored.find(([x]) => standing(x[0]) >= need) ?? scored[0])[0];
      if (from >= 0) { const fc = T("CARS").find(x => x.CRID === from); if (fc.CTYP === 3) open(fc); else { fc.DRID = -1; fc.CCRC = 0; } }
      fa.delete(d);
      const revived = !!seat.revive; delete seat.revive;
      seat.DRID = d; seat.CCRC = 1;
      const n = kind === KIND.rookie ? Math.min(2, K.maxYears) : len(d);
      const rel = released.get(d);
      if (rel && rel.tm === seat.TMID) { res.events[rel.ev] = null; sign(d, seat.TMID, n); out.resigned++; out.released--; continue; }   // back where he was: a new deal
      if (rel) res.events[rel.ev] = null;          // "leaves A" + "signs with B": only the second
      sign(d, seat.TMID, n); markMoved(d); out.signed++;
      if (revived) ev(KIND.revived, seat.CRID, d, 0);
      else ev(kind, d, seat.CRID, n);
    }
    // free agents nobody signed: out of a ride; after sitOut seasons without one, retired
    for (const d of fa) {
      const k = con.get(d);
      if (year - k.YEND >= K.sitOut) { setD(d, { DSTT: 1, RETY: year }); con.delete(d); res.retired.push(d); ev(KIND.retired, d, seasonsOf(d), 0); }
    }
    // a contract for a car that left (folded) goes with it
    for (const [d, k] of con) if (k.TMID !== 255 && !T("CARS").some(c => c.DRID === d && c.CCRC === 1)) { con.set(d, { DRID: d, TMID: 255, YEND: year, LENG: 0 }); }
    res.events = res.events.filter(Boolean);
    CT.rows = [...con.values()].map(({ DRID, TMID, YEND, LENG }) => ({ DRID, TMID, YEND, LENG })); if (CT.rows.length > CT.capacity) CT.capacity = Math.min(0xffff, CT.rows.length + 32);
    PT.rows = [...pres].map(([TMID, PRES]) => ({ TMID, PRES, PAD_: 0 })); if (PT.rows.length > PT.capacity) PT.capacity = Math.min(0xffff, PT.rows.length + 16);
    res.contracts = out;
    res.prestige = [...pres].map(([tm, p]) => ({ tmid: tm, team: String(T("TEAM").find(t => t.TMID === tm)?.TMNM ?? tm).trim(), before: pres0.get(tm) ?? null, after: p })).sort((a, b) => b.after - a.after);
    db.invalidate?.();
    return out;
  }

  const C = o.contracts.enabled ? contractOffSeason() : null;
  if (!C) for (const id of retirees) {
    if (R(100) < o.foldChance) {
      const c = carOf(id);
      for (const x of T("CARS")) if (x.DRID === id) x.CCRC = 0;
      if (c) { for (const s of T("SPON")) if (s.SPID === c.SPID) s.IAVA = 1; ev(KIND.folded, c.CRID, c.TMID, 0, `${team(c) || "A team"} shuts down the #${String(c.CNMD).trim()}`); }
      continue;
    }
    const c = carOf(id); if (!c) continue;
    const crid = c.CRID;
    if (c.CTYP === 1 || c.CTYP === 2) {
      let pick = null, refill = false;
      const a = up(ranked(3));
      if (a.length) { pick = a[0]; refill = o.fixes; }   // (the game parks a promoted ranked Busch driver's car; fixes: filled)
      else { const b = up(unranked(3)); if (b.length) { refill = true; pick = b[R(b.length)]; }
        else if (customPool) pick = pickPool();
        else { const u = unranked(4); if (u.length) pick = u[R(u.length)]; } }
      if (!pick) continue;
      const [nd, ncar] = pick;
      if (ncar >= 0) setC(ncar, { DRID: -1, CCRC: refill ? 1 : 0 });
      setC(crid, { DRID: nd }); markMoved(nd);
      ev(ncar >= 0 && T("CARS").find(x => x.CRID === ncar)?.CTYP === 3 ? KIND.promoted : KIND.rookie, nd, crid, 0);
      if (refill && ncar >= 0) {
        const p = pickPool(); if (p) { const [pd, pc] = p; if (pc >= 0) setC(pc, { DRID: id, CCRC: 0 }); setC(ncar, { DRID: pd }); markMoved(pd); ev(KIND.rookie, pd, ncar, 0); }
      }
    } else if (c.CTYP === 3) {
      const p = pickPool(); if (!p) continue;
      const [pd, pc] = p; if (pc >= 0) setC(pc, { DRID: id, CCRC: 0 }); setC(crid, { DRID: pd }); markMoved(pd); ev(KIND.rookie, pd, crid, 0);
    } else if (c.CTYP === 4) {
      for (const x of T("CARS")) if (x.DRID === id) x.CCRC = 0;
    }
  }
  if (!C) for (const crid of twinCars) {
    const p = pickPool(); if (!p) { setC(crid, { CCRC: 0 }); continue; }
    const [pd, pc] = p; if (pc >= 0) setC(pc, { DRID: -1, CCRC: 0 }); setC(crid, { DRID: pd }); markMoved(pd); ev(KIND.rookie, pd, crid, 0);
  }
  db.invalidate?.();

  // ---------------------------------------------------------------- the extra parts
  const rankOf = id => T("DRST").find(r => r.DRID === id && r.YEAR === year)?.CRNK ?? 99;
  const twins = new Set(T("DDRV").flatMap(r => [r.DRID, r.DDRD]));
  const free = id => id >= 0 && !P4.includes(id) && !moved.has(id) && !res.retired.includes(id) && [0, 2].includes(drv(id)?.DSTT);
  const cup = () => T("CARS").filter(c => (c.CTYP === 1 || c.CTYP === 2) && c.CCRC === 1 && free(c.DRID) && !twins.has(c.DRID));

  // Busch call-ups: a clearly more talented Busch driver takes a back-marker's Cup ride; the Cup driver gets the Busch car
  if (o.callups.enabled && !C) {
    let done = 0;
    const backs = cup().filter(c => rankOf(c.DRID) > o.callups.rank).sort((a, b) => rankOf(b.DRID) - rankOf(a.DRID));
    for (const c of backs) {
      if (done >= o.callups.max) break;
      const busch = T("CARS").filter(x => x.CTYP === 3 && x.CCRC === 1 && free(x.DRID) && !twins.has(x.DRID) && !noUp.has(x.DRID)).sort((a, b) => talent(b.DRID) - talent(a.DRID));
      const b = busch.find(x => talent(x.DRID) >= talent(c.DRID) + o.callups.margin); if (!b) continue;
      if (R(100) >= o.callups.chance) continue;
      const up = b.DRID, down = c.DRID; c.DRID = up; b.DRID = down; markMoved(up); markMoved(down); done++;
      ev(KIND.promoted, up, c.CRID, 0); ev(KIND.lostRide, down, b.CRID, c.CRID);
    }
    db.invalidate?.();
  }

  // the driver market: under-performers in weak rides swap with over-performers in strong ones
  if (o.market.enabled && !C) {
    const cars = cup(), ids = cars.map(c => c.DRID);
    const byTalent = [...ids].sort((a, b) => talent(b) - talent(a)), byRank = [...ids].sort((a, b) => rankOf(a) - rankOf(b));
    const tr = new Map(byTalent.map((d, i) => [d, i + 1])), ar = new Map(byRank.map((d, i) => [d, i + 1]));
    const resid = d => tr.get(d) - ar.get(d);           // > 0: finished better than his talent (a strong ride)
    const movers = ids.filter(d => resid(d) <= -o.market.gap && tr.get(d) <= Math.max(10, Math.round(ids.length * 0.6))).sort((a, b) => resid(a) - resid(b));
    const used = new Set(); let done = 0;
    for (const m of movers) {
      if (done >= o.market.moves) break;
      if (used.has(m) || recent.has(m)) continue;
      const t = ids.filter(d => d !== m && !used.has(d) && !recent.has(d) && resid(d) >= o.market.gap && talent(d) < talent(m)).sort((a, b) => resid(b) - resid(a))[0];
      if (t === undefined || R(100) >= o.market.chance) continue;
      const cm = cars.find(c => c.DRID === m), ct = cars.find(c => c.DRID === t);
      if (o.market.carFollowsDriver) {                   // each keeps his car: the cars change teams
        for (const f of ["TMID", "OWNR"]) [cm[f], ct[f]] = [ct[f], cm[f]];
        [cm.CTYP, ct.CTYP] = [ct.CTYP, cm.CTYP];
        ev(KIND.moved, m, cm.CRID, 0); ev(KIND.moved, t, ct.CRID, 0);
      } else {
        cm.DRID = t; ct.DRID = m;
        ev(KIND.moved, m, ct.CRID, 0); ev(KIND.moved, t, cm.CRID, 0);
      }
      markMoved(m); markMoved(t); used.add(m); used.add(t); done++;
    }
    db.invalidate?.();
  }

  // folded teams return: parked Cup / Busch cars back with a Busch driver (Cup) or a pool driver, while there are fewer
  // running than cupCars / buschCars
  if (o.revival.enabled && !C) {
    let done = 0;
    const running = types => T("CARS").filter(c => types.includes(c.CTYP) && c.CCRC === 1 && c.PLID < 0).length;
    const parked = types => T("CARS").filter(c => types.includes(c.CTYP) && c.CCRC === 0 && c.PLID < 0 && !(c.CRID >= 183 && c.CRID <= 202)   // (183..202: Create-A-Car)
      && !(c.DRID >= 0 && drv(c.DRID) && drv(c.DRID).DSTT !== 1));
    for (const [types, target] of [[[1, 2], o.revival.cupCars], [[3], o.revival.buschCars]]) {
      for (const c of parked(types)) {
        if (done >= o.revival.max || running(types) >= target) break;
        if (R(100) >= o.revival.chance) continue;
        let p = null;
        if (types[0] === 1) { const b = T("CARS").filter(x => x.CTYP === 3 && x.CCRC === 1 && free(x.DRID) && !twins.has(x.DRID) && !noUp.has(x.DRID)).sort((a, b) => talent(b.DRID) - talent(a.DRID))[0]; if (b) p = [b.DRID, b.CRID]; }
        p ??= pickPool(); if (!p) break;
        const [pd, pc] = p;
        if (pc >= 0) { const old = T("CARS").find(x => x.CRID === pc); setC(pc, old?.CTYP === 3 ? { DRID: -1 } : { DRID: -1, CCRC: 0 }); }
        setC(c.CRID, { DRID: pd, CCRC: 1 }); for (const s of T("SPON")) if (s.SPID === c.SPID) s.IAVA = 0;
        markMoved(pd); done++; ev(KIND.revived, c.CRID, pd, 0);
        // a Busch driver moved up leaves his Busch seat to the pool
        if (pc >= 0 && T("CARS").find(x => x.CRID === pc)?.CTYP === 3) { const q2 = pickPool(); if (q2) { const [qd, qc] = q2; if (qc >= 0) setC(qc, { DRID: -1, CCRC: 0 }); setC(pc, { DRID: qd }); markMoved(qd); ev(KIND.rookie, qd, pc, 0); } else setC(pc, { CCRC: 0 }); }
      }
    }
    db.invalidate?.();
  }

  // sponsors change teams (the Sponsors tab's schemes, number-free paints the game draws each car's number on): deals
  // in table SSSP (SLOT: the paint entry SPONSOR_DEAL_BASE + SLOT, SCHM scheme id, CRID car, YEND last season, the car's
  // own paint row values to go back to: OCTI, OPTX, ONAM, OPR..OSB). A deal ends when its last season is over (renewed
  // with renew %), its car stops running or the scheme lost its paint for that make; then free schemes sign with
  // running AI cars of a make they have a paint for, big sponsors (tier) with prestigious teams.
  if (o.sponsors.enabled && library.length) {
    ensureTables(db);
    const D = db.tables.get(SPONSOR_DEALS), lib = new Map(library.map(x => [x.id, x])), carById = id => T("CARS").find(c => c.CRID === id);
    const len = () => o.sponsors.minYears + R(Math.max(0, o.sponsors.maxYears - o.sponsors.minYears) + 1);
    const back = d => undressCar(db, d.CRID, { CTID: d.OCTI, RTOF: d.ORTO ?? -1, PTEX: d.OPTX, CNAM: d.ONAM, IPRD: d.OPRD, IPGN: d.OPGN, IPBL: d.OPBL, ISRD: d.OSRD, ISGN: d.OSGN, ISBL: d.OSBL });
    for (const d of [...D.rows]) {
      const car = carById(d.CRID), x = lib.get(d.SCHM), ok = x && car && car.CCRC === 1 && x.paints.includes(car.CMDL) && !P4.includes(car.DRID);
      if (ok && d.YEND > year) continue;
      if (ok && R(100) < o.sponsors.renew) { d.YEND = year + len(); continue; }
      back(d); D.rows = D.rows.filter(r => r !== d); ev(KIND.sponsorLeaves, d.SCHM, d.CRID, 0);
    }
    const ctidOf = c => { const k = T("CRSK").find(r => r.CRID === c.CRID && r.CTXN === c.CSTN) ?? T("CRSK").find(r => r.CRID === c.CRID); return k?.CTID ?? -1; };
    const sponsored = c => ctidOf(c) >= SPONSOR_START_BASE;
    const inUse = new Set(D.rows.map(d => d.SCHM));
    for (const c of T("CARS")) { const e = ctidOf(c); if (e >= SPONSOR_START_BASE && e < SPONSOR_DEAL_BASE) for (const x of library) if (x.startOn === c.CRID) inUse.add(x.id); }
    const pres = new Map((db.tables.get(PRESTIGE)?.rows ?? []).map(r => [r.TMID, r.PRES]));
    const free = library.filter(x => !inUse.has(x.id)).map(x => [x, x.tier * 10 + R(10)]).sort((a, b) => b[1] - a[1]).map(([x]) => x);
    let done = 0;
    for (const x of free) {
      if (done >= o.sponsors.moves) break;
      if (R(100) >= o.sponsors.chance) continue;
      const cars = T("CARS").filter(c => c.CCRC === 1 && [1, 2, 3].includes(c.CTYP) && c.PLID < 0 && c.DRID >= 0 && !P4.includes(c.DRID) && x.paints.includes(c.CMDL) && !sponsored(c));
      if (!cars.length) continue;
      // how well a car suits the sponsor: team prestige (when the contracts keep one) or car list, against the tier
      const want = x.tier * 20, fit = c => -Math.abs((pres.get(c.TMID) ?? (c.CTYP === 1 ? 75 : c.CTYP === 2 ? 50 : 25)) - want) + R(15);
      const car = cars.map(c => [c, fit(c)]).sort((a, b) => b[1] - a[1])[0][0];
      const used = new Set(D.rows.map(d => d.SLOT)); let slot = 0; while (used.has(slot)) slot++; if (slot >= SPONSOR_DEAL_SLOTS) break;
      const was = dressCar(db, car.CRID, x, SPONSOR_DEAL_BASE + slot); if (!was) continue;
      const n = len();
      if (D.rows.length >= D.capacity) D.capacity = Math.min(0xffff, D.rows.length + 16);
      D.rows.push({ SLOT: slot, SCHM: x.id, CRID: car.CRID, YEND: year + n, OCTI: was.CTID, OPTX: was.PTEX >>> 0, ONAM: String(was.CNAM ?? "").slice(0, 38),
        ORTO: was.RTOF ?? -1, OPRD: was.IPRD, OPGN: was.IPGN, OPBL: was.IPBL, OSRD: was.ISRD, OSGN: was.ISGN, OSBL: was.ISBL });
      inUse.add(x.id); done++; ev(KIND.sponsor, x.id, car.CRID, n);
    }
    db.invalidate?.();
  }

  // new prospects for the pool
  if (o.rookies.generate) {
    const pool = () => unranked(4, " and 'CARS'.'DRID' != ?", -1).length + poolDrivers().length;
    let k = 0;
    while (k < o.rookies.perYear && pool() < o.rookies.poolMinimum) { const id = generateProspect(db, o.rookies, year + 1, rand); if (id === null) break; k++; ev(KIND.prospect, id, 0, 0); }
  }

  // texts (the news ticker formats them again from the database at display time)
  for (const e of res.events) if (!e.text) e.text = newsText(db, e.kind, e.a, e.b, e.c);
  if (o.news && res.events.length) {
    const t = db.tables.get("CNWS");
    if (t) {
      t.rows = t.rows.filter(r => r.NTYP !== NEWS_TYPE);
      const add = res.events.map(e => ({ DAT1: Math.fround(e.a), DAT2: Math.fround(e.b), DAT3: Math.fround(e.c), SNTP: e.kind, NTYP: NEWS_TYPE }));
      t.rows.push(...add); if (t.rows.length > t.capacity) t.capacity = Math.min(0xffff, t.rows.length + 8);
    }
  }
  res.changed = true;
  db.invalidate?.();
  return res;
}

// The news line for a silly season CNWS row (kind = SNTP, a/b/c = DAT1..3), from the database as it is now.
export function newsText(db, kind, a, b, c) {
  const T = n => db.tables.get(n)?.rows ?? [];
  const nm = id => { const d = T("DRVR").find(r => r.DRID === id); return d ? `${String(d.FNAM).trim()} ${String(d.LNAM).trim()}`.trim() : "A driver"; };
  const car = crid => T("CARS").find(x => x.CRID === crid);
  const no = x => x ? `#${String(x.CNMD ?? x.CNUM).trim()}` : "";
  const tm = x => String(T("TEAM").find(t => t.TMID === x?.TMID)?.TMNM ?? "").trim();
  const bu = x => (x?.CTYP === 3 ? " (Busch)" : "");
  const ride = x => [no(x), tm(x)].filter(Boolean).join(" ") + bu(x);
  let v;                                         // longest first; the first that fits is used
  switch (kind) {
    case KIND.retired: v = c > 0 ? [`${nm(a)} retires, a ${c}-time champion`, `${nm(a)} retires`] : b > 0 ? [`${nm(a)} retires after ${b} season${b === 1 ? "" : "s"}`, `${nm(a)} retires`] : [`${nm(a)} retires`]; break;
    case KIND.folded: { const x = car(a), team = String(T("TEAM").find(t => t.TMID === b)?.TMNM ?? "").trim(); v = [`${team || "A team"} shuts down the ${no(x) || "car"}${bu(x)}`, `The ${no(x) || "car"}${bu(x)} shuts down`]; break; }
    case KIND.sponsor: { const x = car(b), nmS = sponsorNames.get(a) ?? "A new sponsor"; v = [`${nmS} sponsors the ${ride(x)} (${c} yr${c === 1 ? "" : "s"})`, `${nmS} sponsors the ${no(x)}`, `${nmS} joins the ${no(x)}`]; break; }
    case KIND.sponsorLeaves: { const x = car(b), nmS = sponsorNames.get(a) ?? "A sponsor"; v = [`${nmS} leaves the ${ride(x)}`, `${nmS} leaves the ${no(x)}`]; break; }
    case KIND.revived: { const x = car(a); v = [`${tm(x) || "A team"} brings back the ${no(x)} for ${nm(b)}`, `The ${no(x)} returns with ${nm(b)}`]; break; }
    case KIND.promoted: v = [`${nm(a)} moves up to the ${ride(car(b))}`, `${nm(a)} moves up to the ${no(car(b))}`]; break;
    case KIND.moved: if (c > 0) { v = [`${nm(a)} signs a ${c}-year deal with ${tm(car(b)) || "a new team"}`, `${nm(a)} signs with ${tm(car(b)) || "a new team"}`, `${nm(a)} gets the ${no(car(b))}`]; break; }
      v = [`${nm(a)} joins ${tm(car(b)) || "a new team"}${car(b) ? ` (${no(car(b))})` : ""}`, `${nm(a)} joins ${tm(car(b)) || "a new team"}`, `${nm(a)} moves to the ${no(car(b))}`]; break;
    case KIND.rookie: v = [`Rookie ${nm(a)} gets the ${ride(car(b)) || "ride"}`, `Rookie ${nm(a)} gets the ${no(car(b))}${bu(car(b))}`]; break;
    case KIND.lostRide: v = [`${nm(a)} drops to the ${ride(car(b)) || "Busch series"}`, `${nm(a)} drops to the ${no(car(b))}${bu(car(b))}`]; break;
    case KIND.released: v = [`${nm(a)} leaves ${tm(car(b)) || "his team"}`, `${nm(a)} is a free agent`]; break;
    case KIND.prospect: v = [`Prospect ${nm(a)} joins the rookie ranks`, `New prospect: ${nm(a)}`]; break;
    default: v = [""];
  }
  return (v.find(x => x.length <= NEWS_MAX) ?? v[v.length - 1]).slice(0, NEWS_MAX);
}

// ------------------------------------------------------------------------------------------------ prospects
const FIRST = ["Aaron", "Austin", "Blake", "Brandon", "Bryce", "Caleb", "Carson", "Chase", "Cody", "Colby", "Colton", "Dalton", "Derek", "Dillon", "Drew", "Dylan", "Garrett", "Grady", "Hunter", "Jace",
  "Jared", "Jesse", "Jordan", "Justin", "Kade", "Kyle", "Landon", "Logan", "Luke", "Mason", "Nolan", "Parker", "Reid", "Riley", "Ryder", "Shane", "Tanner", "Travis", "Tucker", "Wade", "Wyatt", "Zane"];
const LAST = ["Abbott", "Ashford", "Barlow", "Beckett", "Bramlett", "Calder", "Carver", "Colby", "Crandall", "Dawes", "Denning", "Easley", "Fenwick", "Garrison", "Hadley", "Harlow", "Haskins", "Holloway",
  "Kettering", "Lambert", "Langston", "Lockhart", "Maddox", "Mercer", "Merritt", "Noland", "Oakley", "Pardue", "Prescott", "Radford", "Ramsey", "Rowland", "Sawyer", "Shelton", "Stroud", "Talbot", "Thorne",
  "Upshaw", "Vance", "Waddell", "Whitlock", "Yates"];
const TOWNS = [["Hickory", "NC"], ["Concord", "NC"], ["Mooresville", "NC"], ["Spartanburg", "SC"], ["Florence", "SC"], ["Dalton", "GA"], ["Valdosta", "GA"], ["Ocala", "FL"], ["Pensacola", "FL"], ["Mobile", "AL"],
  ["Tupelo", "MS"], ["Bristol", "TN"], ["Knoxville", "TN"], ["Bowling Green", "KY"], ["Lynchburg", "VA"], ["Roanoke", "VA"], ["Kokomo", "IN"], ["Toledo", "OH"], ["Dubuque", "IA"], ["Tulsa", "OK"],
  ["Abilene", "TX"], ["Fresno", "CA"], ["Medford", "OR"], ["Bangor", "ME"]];

// a hash in [0, 1) from integers (track skills of a prospect from his id, the same on every load)
const hash = (...v) => { let h = 0x811c9dc5; for (const x of v) { h ^= x & 0xffff; h = Math.imul(h, 0x01000193); h ^= x >>> 16; h = Math.imul(h, 0x01000193); } h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15; return (h >>> 0) / 4294967296; };

export function generateProspect(db, r, season, rand) {
  const T = n => db.tables.get(n);
  const drvr = T("DRVR"); if (!drvr) return null;
  const tpl = drvr.rows.find(d => d.DSTT === -1 && d.DSID !== 999 && d.RKYR > 0) ?? drvr.rows.find(d => d.DSTT === -1) ?? drvr.rows[0];
  if (!tpl) return null;
  let id = GEN_BASE; const used = new Set(drvr.rows.map(d => d.DRID)); while (used.has(id)) id++;
  const names = new Set(drvr.rows.map(d => `${String(d.FNAM).trim()} ${String(d.LNAM).trim()}`));
  let fn, ln; for (let i = 0; i < 50; i++) { fn = FIRST[rand(FIRST.length)]; ln = LAST[rand(LAST.length)]; if (!names.has(`${fn} ${ln}`)) break; }
  const span = Math.max(0, r.ratingMax - r.ratingMin), rate = () => r.ratingMin + rand(span + 1);
  const [city, st] = TOWNS[rand(TOWNS.length)], age = r.ageMin + rand(Math.max(0, r.ageMax - r.ageMin) + 1);
  const row = { ...tpl, DRID: id, POID: 0, DSID: 999, FNAM: fn.slice(0, 13), LNAM: ln.slice(0, 13), CITY: city.slice(0, 18), STAT: st, BYER: season - age, BMON: 1 + rand(12), BDAT: 1 + rand(28),
    DSPD: rate(), DCTL: rate(), DDEF: rate(), DAGR: rate(), DDUR: rate(), POTN: Math.min(100, rate() + 10), DPOP: 6, DPCQ: 0, DSTT: -1, RETY: 0, RKYR: 0, GNDR: 0 };
  if (drvr.rows.length >= drvr.capacity) drvr.capacity = Math.min(0xffff, drvr.rows.length + 8);
  drvr.rows.push(row);
  repairGenerated(db);
  return id;
}

// Track skills (DSKL) of generated prospects: not in saves, so made again from the DRVR row (ratings + id) on every load.
export function repairGenerated(db) {
  const drvr = db.tables.get("DRVR"), dskl = db.tables.get("DSKL"); if (!drvr || !dskl) return 0;
  const have = new Set(dskl.rows.map(s => s.DRID)), types = [...new Set(dskl.rows.map(s => s.TTYP))].sort((a, b) => a - b);
  const skilOf = new Map(); for (const s of dskl.rows) if (!skilOf.has(s.TTYP)) skilOf.set(s.TTYP, s.SKIL);
  let n = 0;
  for (const d of drvr.rows) {
    if (d.DRID < GEN_BASE || have.has(d.DRID)) continue;
    const base = (d.DSPD + d.DCTL + d.DDEF) / 3;
    for (const t of types) {
      const v = Math.max(30, Math.min(99, Math.round(base + (hash(d.DRID, t) - 0.5) * 20)));
      if (dskl.rows.length >= dskl.capacity) dskl.capacity = Math.min(0xffff, dskl.rows.length + 16);
      dskl.rows.push({ DRID: d.DRID, SKIL: skilOf.get(t) ?? 1, DSKL: v, TTYP: t }); n++;
    }
  }
  if (n) db.invalidate?.();
  return n;
}

// ------------------------------------------------------------------------------------------------ ratings
// Ratings that change with age (the "progression" option; the game never changes a rating). Each off-season, for every
// driver not retired (human players' drivers only with "players"), age = next season - birth year:
//   - up to growUntil: each rating grows by about "growth" points a year (x 0.5..1.5), slowing as it nears the
//     driver's potential: a fixed number per driver (hash of DRID, 60..99, at least his mean + 3), so the same in
//     every career;
//   - between: only the random part;
//   - from declineFrom: falls by about "decline" a year, a little faster every year (+10 % a year past it); speed and
//     durability fully, aggression half, car control and defense a third (experience);
//   - "results" (Cup and Busch): finished 8+ places above his talent (strong year) +1, 8+ below -1 (not when declining);
//   - "randomness": +- up to that, a half step at a time. Ratings stay whole numbers within 20..99.
// Track skills (DSKL, not in career saves) follow the mean of speed / control / defense: base skill (as loaded from
// nascar.db, snapshotSkills) + the drift of that mean since then; restoreSkills makes them again from the saved
// ratings on every career load and reset (so a career loaded later, or the next career, gets its own).
const RATINGS = ["DSPD", "DCTL", "DDEF", "DAGR", "DDUR"], DECLINE_W = { DSPD: 1, DDUR: 1, DAGR: 0.5, DCTL: 0.33, DDEF: 0.33 };
const mean3 = d => (d.DSPD + d.DCTL + d.DDEF) / 3;
export const potential = d => Math.max(Math.min(99, RATINGS.reduce((a, k) => a + d[k], 0) / 5 + 3), 60 + Math.round(hash(d.DRID, 99) * 39));
let skillBase = null;                                   // Map DRID -> { mean, skills: Map TTYP -> DSKL } at the last nascar.db load
export function snapshotSkills(db) {
  const dr = db.tables.get("DRVR")?.rows ?? [], sk = db.tables.get("DSKL")?.rows ?? []; skillBase = new Map();
  for (const d of dr) skillBase.set(d.DRID, { mean: mean3(d), skills: new Map() });
  for (const s of sk) skillBase.get(s.DRID)?.skills.set(s.TTYP, s.DSKL);
}
export function restoreSkills(db) {
  if (!skillBase) return 0;
  const dr = new Map((db.tables.get("DRVR")?.rows ?? []).map(d => [d.DRID, d])); let n = 0;
  for (const s of db.tables.get("DSKL")?.rows ?? []) {
    const b = skillBase.get(s.DRID), d = dr.get(s.DRID), v = b?.skills.get(s.TTYP); if (v === undefined || !d) continue;
    const want = Math.max(20, Math.min(99, Math.round(v + mean3(d) - b.mean)));
    if (s.DSKL !== want) { s.DSKL = want; n++; }
  }
  if (n) db.invalidate?.();
  return n;
}
export function progressRatings(db, p, R, players, year) {
  const T = n => db.tables.get(n)?.rows ?? [], age0 = year + 1, out = [];
  const ride = new Map(); for (const c of T("CARS")) if (c.DRID >= 0 && c.CCRC === 1) ride.set(c.DRID, c.CTYP);
  const skills = new Map(); for (const s of T("DSKL")) { const a = skills.get(s.DRID) ?? []; a.push(s); skills.set(s.DRID, a); }
  const talent = d => { const s = skills.get(d.DRID); return 0.7 * (s?.length ? s.reduce((a, x) => a + x.DSKL, 0) / s.length : 70) + 0.3 * d.DSPD; };
  // results: points position against talent position, per series
  const resid = new Map();
  if (p.results) for (const types of [[1, 2], [3]]) {
    const ds = T("DRVR").filter(d => types.includes(ride.get(d.DRID))), rk = new Map(T("DRST").filter(r => r.YEAR === year).map(r => [r.DRID, r.CRNK]));
    const ranked = ds.filter(d => rk.has(d.DRID)).sort((a, b) => rk.get(a.DRID) - rk.get(b.DRID)), byT = [...ranked].sort((a, b) => talent(b) - talent(a));
    const tp = new Map(byT.map((d, i) => [d.DRID, i])); ranked.forEach((d, i) => resid.set(d.DRID, tp.get(d.DRID) - i));
  }
  const f = () => 0.5 + R(101) / 100;                 // 0.5 .. 1.5
  for (const d of T("DRVR")) {
    if (d.DSTT === 1 || d.DRID < 0 || !(d.BYER > 1900) || /customcar/i.test(String(d.LNAM)) || (!p.players && players.includes(d.DRID))) continue;
    const age = age0 - d.BYER, pot = potential(d), before = RATINGS.reduce((a, k) => a + d[k], 0) / 5, m0 = mean3(d), r0 = Object.fromEntries(RATINGS.map(k => [k, d[k]]));
    const declining = age >= p.declineFrom, rs = resid.get(d.DRID) ?? 0, bonus = !declining && rs >= 8 ? 1 : !declining && rs <= -8 ? -1 : 0;
    for (const k of RATINGS) {
      let v = d[k];
      if (age <= p.growUntil) v += p.growth * Math.max(0, Math.min(1.5, (pot - v) / 15)) * f();
      else if (declining) v -= p.decline * (1 + 0.1 * (age - p.declineFrom)) * DECLINE_W[k] * f();
      v += bonus + (p.randomness ? (R(2 * p.randomness + 1) - p.randomness) / 2 : 0);
      d[k] = Math.max(20, Math.min(99, Math.floor(v + R(100) / 100)));   // (whole numbers as the game's; rounded at random so small steps add up)
    }
    // track skills follow (generated prospects / drivers loaded after the snapshot: by this year's change)
    const dm = Math.round(mean3(d) - m0);
    if (!skillBase?.has(d.DRID) && dm) for (const s of skills.get(d.DRID) ?? []) s.DSKL = Math.max(20, Math.min(99, s.DSKL + dm));
    const after = RATINGS.reduce((a, k) => a + d[k], 0) / 5;
    // (every driver with a ride, changed or not: the report page lists them all; r: each rating [before, after])
    if ([1, 2, 3].includes(ride.get(d.DRID))) out.push({ drid: d.DRID, name: `${String(d.FNAM).trim()} ${String(d.LNAM).trim()}`.trim(), age, before: Math.round(before * 10) / 10, after: Math.round(after * 10) / 10,
      r: Object.fromEntries(RATINGS.map(k => [k, [r0[k], d[k]]])) });
  }
  restoreSkills(db);
  db.invalidate?.();
  return out.sort((a, b) => (b.after - b.before) - (a.after - a.before));
}

// ------------------------------------------------------------------------------------------------ career tables
// The contract and prestige tables live in the game's database so a career save keeps them (STAB rows: career saves,
// UFIL 2). Empty at the start of a career (filled at its first off-season); emptied when a career's tables are reset
// (0x148510 reloading DRVR) and when a save without them is loaded (resetCareerTables, from gamecode).
export const CONTRACTS = "SSCT", PRESTIGE = "SSTP";
export const SPONSOR_DEALS = "SSSP";

// The game's own rookie pool drivers (CTYP 4 cars) the Career tab leaves out: RETY = POOL_OUT. The game's silly season
// (and this one) only picks drivers with RETY 0, and RETY is otherwise only compared with a season year (the report),
// so 1 keeps them out of every pick without touching anything else; they still race in quick races and seasons. Only
// drivers still in the pool (a pool car or none, not retired) are marked; a mark of a driver no longer listed is taken
// back. On every nascar.db load and career save load (a save keeps DRVR).
export const POOL_OUT = 1;
export function applyPoolRemoved(db, drids) {
  const out = new Set((drids ?? []).map(Number)), dr = db.tables.get("DRVR")?.rows ?? [], cars = db.tables.get("CARS")?.rows ?? [];
  const ride = new Map(); for (const c of cars) if (c.DRID >= 0 && c.CCRC !== 0) ride.set(c.DRID, c.CTYP);
  let n = 0;
  for (const d of dr) {
    const inPool = d.DSTT !== 1 && (!ride.has(d.DRID) || ride.get(d.DRID) === 4);
    if (out.has(d.DRID) && inPool) { if (d.RETY !== POOL_OUT) { d.RETY = POOL_OUT; n++; } }
    else if (d.RETY === POOL_OUT) d.RETY = 0;
  }
  db.invalidate?.();
  return n;
}
const SCHEMA = { [CONTRACTS]: [["DRID", 2, 32], ["TMID", 3, 8], ["YEND", 3, 16], ["LENG", 3, 8]], [PRESTIGE]: [["TMID", 3, 8], ["PRES", 3, 8], ["PAD_", 3, 16]],
  [SPONSOR_DEALS]: [["CRID", 2, 32], ["OCTI", 2, 32], ["OPTX", 3, 32], ["ONAM", 0, 312], ["YEND", 3, 16], ["SLOT", 3, 8], ["SCHM", 3, 8],
    ["OPRD", 3, 8], ["OPGN", 3, 8], ["OPBL", 3, 8], ["OSRD", 3, 8], ["OSGN", 3, 8], ["OSBL", 3, 8], ["ORTO", 2, 16]] };
export function ensureTables(db) {
  for (const [name, fs] of Object.entries(SCHEMA)) {
    if (db.tables.has(name)) continue;
    let off = 0; const fields = fs.map(([n, type, bits]) => { const f = { name: n, type, offset: off, bits }; off += bits; return f; });
    db.tables.set(name, { name, flags: 4, recSize: off >> 3, capacity: 256, indexCount: 0, fields, rows: [] });
  }
  const stab = db.tables.get("STAB");
  if (stab) for (const name of Object.keys(SCHEMA)) if (!stab.rows.some(r => r.TNAM === name && r.UFIL === 2)) { if (stab.rows.length >= stab.capacity) stab.capacity = stab.rows.length + 4; stab.rows.push({ ICRC: 1, UFIL: 2, TNAM: name }); }
  db.invalidate?.();
}
// (keep: the tables a loaded save brought; the others are emptied)
export function resetCareerTables(db, keep = null) { for (const n of Object.keys(SCHEMA)) { if (keep?.has?.(n)) continue; const t = db.tables.get(n); if (t) t.rows = []; } restoreSkills(db); }

// ------------------------------------------------------------------------------------------------ in the game
export function installSillySeason(game, opts = {}) {
  // (the Roster tab's teams: a starting prestige for careers)
  const tp = Object.fromEntries((game.config?.roster?.teams ?? []).filter(t => Number.isInteger(t?.prestige)).map(t => [t.id, t.prestige]));
  const o = options({ ...opts, teamPrestige: { ...tp, ...(opts.teamPrestige ?? {}) } }), m = game.mem;
  for (const x of game.config?.sponsors ?? []) sponsorNames.set(x.id, x.name);
  game.sillySeason = null; game.state.sillySeason ??= [];
  if (!o.enabled) return o;
  const rand = n => (n > 0 ? (game.nested(0x14a10, [], { eax: n }) >>> 0) % n : 0);
  let oldCar = new Map();
  // the off-season routine itself
  game.hooks.set(0xb0260, () => {
    let r;
    try { r = runSillySeason(game.db, o, rand, game.config?.sponsors ?? []); }
    catch (e) { game.log(`silly season: ${e.message}`); return 0; }
    oldCar = r.oldCar;
    // the report's table of retirees' old cars (0x2BAB90: 3 x {DRID, CRID}), as the game keeps it
    for (let i = 0; i < 3; i++) { m.w32(0x2bab90 + i * 8, -1); m.w32(0x2bab94 + i * 8, -1); }
    [...oldCar].slice(0, 3).forEach(([d, c], i) => { m.w32(0x2bab90 + i * 8, d); m.w32(0x2bab94 + i * 8, c); });
    const report = { year: r.year, time: new Date().toISOString(), events: r.events.map(e => e.text), contracts: r.contracts ?? null, prestige: r.prestige ?? null,
      progression: r.progression ? rideInfo(game.db, r.progression) : null, options: { contracts: o.contracts.enabled, progression: o.progression.enabled } };
    game.sillySeason = report; game.state.sillySeason.push(report);
    game.log(`silly season ${r.year}: ${report.events.join("; ") || "no changes"}`);
    if (game.saveDir) try { mkdirSync(game.saveDir, { recursive: true }); appendFileSync(join(game.saveDir, "silly-season.log"), formatReport(report) + "\n"); } catch {}
    if (game.saveDir) saveReport(game.saveDir, report);
    game.onSillySeason?.(report);
    return Math.min(255, r.retired.length);
  });
  // the report's old car of a retiree (ecx = DRID): every retiree, not only the first three
  game.hooks.set(0x95bb0, (c, ret) => {
    const d = c.r[1] | 0; if (oldCar.has(d)) return oldCar.get(d) >>> 0;
    c.push(ret); c.passThrough = 0x95bb0; c.hookReturn = 0x95bb0; return undefined;
  });
  // news line formatter 0x3ED80 (ecx = NTYP, [esp+4] = SNTP, DAT1..3 floats, esi = text out): NTYP 4 is ours
  if (o.news) {
    const F = new Float32Array(1), U = new Uint32Array(F.buffer), f = v => { U[0] = v >>> 0; return F[0]; };
    game.hooks.set(0x3ed80, (c, ret) => {
      if ((c.r[1] | 0) !== NEWS_TYPE) { c.push(ret); c.passThrough = 0x3ed80; c.hookReturn = 0x3ed80; return undefined; }
      const out = c.r[6] >>> 0, s = newsText(game.db, c.arg(0) << 24 >> 24, Math.round(f(c.arg(1))), Math.round(f(c.arg(2))), Math.round(f(c.arg(3))));
      if (out) m.wstr(out, s, s.length);
      return 0;
    });
  }
  return o;
}

export function formatReport(r) {
  if (!r) return "no silly season yet";
  return [`Silly season after ${r.year}:`, ...(r.events.length ? r.events.map(e => `  ${e}`) : ["  no changes"]),
    ...(r.contracts ? ["", `Contracts: ${r.contracts.resigned} re-signed, ${r.contracts.signed} new, ${r.contracts.released} became free agents`] : []),
    ...(r.prestige ? ["", "Team prestige:", ...r.prestige.map(x => Array.isArray(x) ? { team: x[0], after: x[1], before: null } : x).map(x => `  ${String(x.after).padStart(3)}  ${x.before === null ? "new" : (x.after - x.before >= 0 ? "+" : "") + (x.after - x.before)}`.padEnd(12) + x.team)] : []),
    ...(r.progression?.length ? ["", `Ratings: ${r.progression.filter(x => x.after > x.before).length} drivers better, ${r.progression.filter(x => x.after < x.before).length} worse. Biggest changes:`,
      ...[...r.progression.filter(x => x.after !== x.before).slice(0, 5), ...r.progression.filter(x => x.after !== x.before).slice(-5).reverse()].filter((x, i, a) => a.indexOf(x) === i).map(x => `  ${(x.after - x.before >= 0 ? "+" : "") + (x.after - x.before).toFixed(1)}  ${x.name} (${x.age}): ${x.before} -> ${x.after}`)] : [])].join("\n");
}

// ------------------------------------------------------------------------------------------------ report history
// The report page (/silly-season on the game's page) reads these: <save>/silly-season.json keeps the last 40
// off-seasons (newest first), so they are there after the game was restarted.
export const REPORT_FILE = "silly-season.json";
// each rated driver's ride after the off-season (series, car number, team)
function rideInfo(db, prog) {
  const T = n => db.tables.get(n)?.rows ?? [], teams = new Map(T("TEAM").map(t => [t.TMID, String(t.TMNM).trim()]));
  const car = new Map(); for (const c of T("CARS")) if (c.DRID >= 0 && c.CCRC === 1 && [1, 2, 3].includes(c.CTYP) && !car.has(c.DRID)) car.set(c.DRID, c);
  const dstt = new Map(T("DRVR").map(d => [d.DRID, d.DSTT]));
  return prog.map(x => { const c = car.get(x.drid); return { ...x, series: c ? (c.CTYP === 3 ? "Busch" : "Cup") : dstt.get(x.drid) === 1 ? "Retired" : "No ride", car: c ? String(c.CNMD ?? c.CNUM ?? "").trim() : "", team: c ? teams.get(c.TMID) ?? "" : "" }; });
}
export function loadReports(dir) {
  try { const a = JSON.parse(readFileSync(join(dir, REPORT_FILE), "utf8")); return Array.isArray(a) ? a : []; } catch { return []; }
}
function saveReport(dir, report) {
  try { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, REPORT_FILE), JSON.stringify([report, ...loadReports(dir)].slice(0, 40))); } catch {}
}
