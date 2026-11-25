// race-hud.mjs — the live race leaderboard and live points standings, read from the running game every half second
// and sent to the page (play-client.js draws them over the picture: F4 shows / hides, F6 switches leaderboard / points).
//
//   import { createRaceHud } from "./race-hud.mjs";
//   const hud = createRaceHud(g);          // g: the game (gamecode.mjs): g.mem, g.db
//   const msg = hud.sample(gameMs);         // { t: "race", ... } while a race runs, { t: "race", active: false } once
//                                           // when it ends, else null
//
// What the game keeps (analysis_notes.md, "Car race states"): the race table [0x2F32D8], 0x68 bytes per car slot
// (slot = car record +0x0C; car records at 0x2951E0, 0x5C0 apart):
//   +0x00 race state (2 AI racing, 3 the player racing, 5 pit-in, 6 in the stall, 7 past the checkered flag (then 5 / 6
//         again: the cars go down pit road after the race), 10 grid / caution
//         line-up), +0x30 speed (ft/s; sent as mph), +0x50 race distance in laps (float: laps + lap fraction; the live gaps), +0x54 time into the current lap (9999 before the line),
//   +0x5C low 16 bits laps started, +0x5E running position (0 = leader)
// Who is in which slot: the car record's +0x36 (u16) is the car's number (slot 0, the player's: 20 = CARS CRID 32,
// PLID 0); the field's cars (CRIDs) are listed at 0x2DD200, 16 bytes apart; the car with that number among them is
// the slot's, and its DRID the driver (mapSlots). Taken once per race.
// Laps led: the leader at the line when a lap is completed (NASCAR's rule); points: PNTS (place -> points) + 5 for
// leading a lap + 5 more for the most laps led (the game's rule: DRRS CPNT + BONU); season standings (Season / Career):
// the DRST rows of the season's year (CPNT) + the race's live points
// (CPNT). Gaps: the time between two cars crossing the line on the same lap, from game time.
// The cars in the session: byte [0x28A553] (0x13680 returns it; the race code loops over that many car slots). 43 in a
// full race, about 21 in each Gatorade 125 duel: only slots below it are in the session (the others keep whatever they
// held, and counting them put the player 39th of a 21-car duel). Points and season standings only in the race itself
// (session 3): a duel runs under the Daytona 500's race row, whose points it does not give.
// Practice, qualifying and happy hour (the session, GINF.RTYP, kept in memory at [0x2BB110] by 0xB8C40: 0 practice,
// 1 qualifying, 2 happy hour, 3 the race; the race-stage handler 0x9F360 treats 0 and 2 alike) are timed sessions:
// the board lists each car's best lap (then its last lap and laps run), fastest first, instead of a running order.
// A lap's time: the time into the lap (+0x54) at the previous sample + the game time since - the time into the new
// lap, so it is exact whatever the sampling interval.

const BINS = 400, RING = 2 * BINS + 8;
const RACE_TABLE = 0x2f32d8, STRIDE = 0x68, CARS = 43;

export function createRaceHud(g) {
  let race = null, lastSent = -1e9, wasActive = false;
  const T = n => g.db?.tables?.get(n)?.rows ?? [];
  const r16 = a => g.mem.r16(a), r32 = a => g.mem.r32(a), f32 = a => { const u = r32(a); return new Float32Array(new Uint32Array([u]).buffer)[0]; };

  function newRace(rt) {
    const ginf = T("GINF")[0] ?? {}, raid = ginf.RAID, rrow = T("RACE").find(r => r.RAID === raid);
    // race length (a first guess; sample() takes the game's own count, [0x28A556]): SRLN is the percentage itself (3/5/10/25/50/100: the settings screen's handler 0x8C240 switches on
    // SRLN - 3), of the profile in use (SGPP row PRID = [0x21DB74]; CGPL holds the same for the current game)
    let prof = 0; try { prof = r32(0x21db74); } catch {}
    const pct = T("SGPP").find(r => r.PRID === prof)?.SRLN ?? T("CGPL")[0]?.SRLN ?? 100;
    const laps = rrow?.RLAP ? Math.max(1, Math.round(rrow.RLAP * pct / 100)) : null;
    const track = T("TRCK").find(r => r.TRID === ginf.TRID);
    const drv = new Map(T("DRVR").map(r => [r.DRID, r])), car = new Map(); for (const c of T("CARS")) if (c.DRID != null && !car.has(c.DRID)) car.set(c.DRID, c);
    const year = ginf.YEAR, points = new Map(T("PNTS").map(r => [r.PLAC, r.PNTS]));
    // standings before the race: the season year's DRST rows (CPNT); drivers without one start on 0
    // (the simulator / race end adds the race's 43 rows for the year: CPNT = place points + BONU, CRNK the rank)
    const before = new Map(), wins = new Map(); for (const r of T("DRST")) if (r.YEAR === year) { before.set(r.DRID, r.CPNT ?? 0); wins.set(r.DRID, r.NWIN ?? 0); }
    const clean = s => String(s ?? "").replace(/[^\x20-\x7e]/g, "").trim();
    // a season (GINF.GMOD 1; Race Now is 0) or a career (2) keeps standings; RACE.ISPT 0 = no points (The Shootout,
    // All-Star, All-Star Open, SpeedZone)
    const season = ginf.GMOD === 1 || ginf.GMOD === 2 || before.size > 0, scoring = rrow?.ISPT !== 0;
    return { rt, raid, laps, season, scoring, wins, mode: ginf.GMOD, year, name: clean(rrow?.RNAM), track: clean(track?.TRNM), drv, car, points, before,
      slots: null, trail: Array.from({ length: CARS }, () => ({ bin: new Int32Array(RING).fill(-1), t: new Float64Array(RING), last: -1, lastD: 0 })), lapsSeen: new Array(CARS).fill(0), yellow: Array.from({ length: CARS }, () => []), cross: Array.from({ length: CARS }, () => []), led: new Map(), lastLeaderLap: 0, done: [], winnerAt: null, winner: null, clean,
      pit: Array.from({ length: CARS }, () => ({ stops: [], cur: null })), pst: new Array(CARS).fill(-1),
      prevT: new Array(CARS).fill(-1), prevMs: null, lastLap: new Array(CARS).fill(null), bestLap: new Array(CARS).fill(null), timedLaps: new Array(CARS).fill(0) };
  }
  // slot -> DRID. The game fills the slots from the field list (0x2DD200: CRIDs, 16 bytes apart) in order, with the
  // players' cars (CARS PLID 0, 1, ...) taken out and put first: slot 0 = player 1. Checked against the car numbers
  // (car record +0x36: the number, 200 + n for "0n"); when too few agree, each slot's own number picks its car.
  function mapSlots(N) {
    const field = []; for (let i = 0; i < 64; i++) { const c = r32(0x2dd200 + i * 16) | 0; if (c < 0 || c > 4095) break; field.push(c); }
    const cars = T("CARS"), byCrid = new Map(cars.map(c => [c.CRID, c])), inField = new Set(field);
    const players = cars.filter(c => c.PLID >= 0 && inField.has(c.CRID)).sort((a, b) => a.PLID - b.PLID).map(c => c.CRID);
    const order = [...players, ...field.filter(c => !players.includes(c))].slice(0, N);
    const numOf = k => r16(0x2951e0 + k * 0x5c0 + 0x36), code = c => { const t = String(c?.CNMD ?? c?.CNUM ?? ""); return /^0\d$/.test(t) ? 200 + +t : +t; };
    const agree = order.filter((c, k) => code(byCrid.get(c)) === numOf(k)).length;
    if (order.length === N && agree >= N - Math.min(8, Math.floor(N / 5))) return order.map(c => byCrid.get(c)?.DRID ?? null);
    const byNum = new Map(); for (const c of field.map(c => byCrid.get(c)).filter(Boolean)) { const n = code(c); byNum.set(n, byNum.has(n) ? null : c); }
    const viaNum = Array.from({ length: N }, (_, k) => byNum.get(numOf(k))?.DRID ?? null);
    return viaNum.some(d => d != null) ? viaNum : null;
  }

  function sample(ms) {
    let rt = 0; try { rt = r32(RACE_TABLE); } catch { rt = 0; }
    let N = CARS; try { const n = g.mem.r8(0x28a553); if (n >= 1 && n <= CARS) N = n; } catch {}
    let sess = 3; try { sess = r32(0x2bb110) | 0; } catch {}
    const states = rt ? Array.from({ length: N }, (_, k) => { try { return r32(rt + k * STRIDE); } catch { return -1; } }) : [];
    // only while the race process runs (game process 1 in state 10): the race table stays in memory afterwards, with
    // its cars in state 7, and kept the last race's board up over the menus
    let inRace = true; try { if (g.processState) inRace = g.processState(1) === 10; } catch { inRace = true; }
    const active = inRace && rt && states.filter(s => s >= 1 && s <= 11).length >= Math.max(1, N - 2);   // (11: the caution's cool-down / wreck replay)
    if (!active) { race = null; if (wasActive) { wasActive = false; return { t: "race", active: false }; } return null; }
    wasActive = true;
    if (!race || race.rt !== rt) race = newRace(rt);
    if (!race.slots) race.slots = mapSlots(N);
    // a caution: the field in the caution states (10 pace line, 11 cool-down / replay) after the green flag; its laps
    // are counted on every car at once (0xABB27), so their line times give no gaps
    const caution = race.started && states.filter(x => x === 10 || x === 11).length >= N / 2;
    // the race's own lap count (0x136F0 reads [0x28A556]; the finish and caution-finish checks use it), so a career's
    // or season's race length setting is right too; the DB estimate only if it is not set
    { let n = 0; try { n = r16(0x28a556); } catch {} if (n >= 1 && n <= 5000) race.laps = n; }
    const R = race, cars = [];
    for (let k = 0; k < N; k++) {
      const b = rt + k * STRIDE, w = r32(b + 0x5c), laps = w & 0xffff, pos = w >>> 16;
      // lap times: a lap just completed (one more lap started since the last sample) between two valid readings of the
      // time into the lap (9999 before the first line, e.g. leaving pit road at the start of a practice session)
      { const t54 = f32(b + 0x54), p = R.prevT[k];
        if (laps === R.lapsSeen[k] + 1 && R.prevMs != null && p >= 0 && p < 9000 && t54 >= 0 && t54 < 9000) {
          const lt = p + (ms - R.prevMs) / 1000 - t54; if (lt > 5 && lt < 3600) { R.lastLap[k] = lt; if (R.bestLap[k] == null || lt < R.bestLap[k]) R.bestLap[k] = lt; R.timedLaps[k]++; } }
        R.prevT[k] = t54; }
      // the line: laps started went up (lap 1 starts at the green); its time is kept per lap for the gaps
      if (laps > R.lapsSeen[k]) { for (let L = R.lapsSeen[k] + 1; L <= laps; L++) { R.cross[k][L] = ms; if (caution) R.yellow[k][L] = true; } R.lapsSeen[k] = laps; }
      // live timing: +0x50 (float) = the car's race distance in laps (laps + the lap fraction, 0xBAF00, every frame).
      // Each car leaves a trail of when it passed each 1/BINS of a lap (the last two laps), so a car's gap is now
      // minus the time the leader (or the car ahead) passed the spot where this car is now.
      let dist = f32(b + 0x50); if (!(dist >= 0 && dist < 1e5)) dist = null;
      if (dist != null) { const T = R.trail[k], bin = Math.floor(dist * BINS);
        if (bin > T.last) { const jump = T.last < 0 || dist - T.lastD > 0.2;     // (a caution's laps go on all at once: no trail over them)
          for (let x = jump ? bin : T.last + 1; x <= bin; x++) { const i = x % RING; T.bin[i] = x; T.t[i] = jump || bin === T.last ? ms : T.tLast + (ms - T.tLast) * (x - T.last) / (bin - T.last); }
          T.last = bin; }
        T.lastD = dist; T.tLast = ms; }
      // the checkered flag: a car is done when it takes it (state 7, or a lap past the race's); its gap / laps down are
      // kept as they were on the line from then on (the cars run on into the cool-down lap and pit road)
      if (R.laps && !R.done[k] && ((states[k] === 7 && laps >= R.laps) || laps > R.laps)) {   // (state 7 on an earlier lap: seen for the player in a caution's replay)
        if (R.winnerAt == null) { R.winnerAt = R.cross[k][laps] ?? ms; R.winner = k; }
        const down = Math.max(0, R.laps + 1 - laps);
        R.done[k] = { down, gap: k === R.winner ? null : down ? null : ((R.cross[k][laps] ?? ms) - R.winnerAt) / 1000 };
      }
      // pit stops: onto pit road (state 5), stopped in the stall (6), pulling away (6 -> 5), back on the track (racing
      // 2 / 3, or the pace line 10 under a caution). Only after the start and before the car has taken the flag (the
      // field drives down pit road after the race); a car that goes straight from racing to 6 has retired, not pitted
      { const s = states[k], ps = R.pst[k], P = R.pit[k];
        if (s !== ps && ps !== -1) {
          if (!R.started || R.done[k]) P.cur = null;
          else if (s === 5 && ps !== 5 && ps !== 6) P.cur = { lap: laps, in: ms, posIn: pos + 1, yellow: caution };
          else if (s === 6 && P.cur && P.cur.stall == null) P.cur.stall = ms;
          else if (s === 5 && ps === 6 && P.cur) P.cur.go = ms;
          else if (s !== 5 && s !== 6 && P.cur) {
            const c = P.cur; P.cur = null;
            if (s !== 7) P.stops.push({ lap: c.lap, road: Math.round((ms - c.in) / 100) / 10, stall: c.stall != null ? Math.round(((c.go ?? ms) - c.stall) / 100) / 10 : null,
              posIn: c.posIn, posOut: pos + 1, yellow: !!c.yellow });
          }
        }
        R.pst[k] = s; }
      cars.push({ k, laps, pos, dist, state: states[k], speed: f32(b + 0x30) });
    }
    R.prevMs = ms;
    cars.sort((a, b) => a.pos - b.pos);
    // finished under caution (Race stage 0x28 -> 0x29): the field takes the flag in the pace line, so every car is done
    // at once, laps down by race distance from the winner's (the lead-lap cars behind him have not crossed yet)
    if (R.winnerAt != null && caution && !R.qcDone) {
      R.qcDone = true; const w = cars.find(c => c.k === R.winner) ?? cars[0];
      for (const c of cars) if (c.k !== R.winner) { const d = w.dist != null && c.dist != null ? Math.max(0, Math.floor(w.dist - c.dist)) : (R.done[c.k]?.down ?? 0); R.done[c.k] = { down: d, gap: null }; }
    }
    if (!R.started && cars.some(c => c.laps >= 1) && !states.some(x => x === 10)) R.started = true;
    // laps led: when the leader starts lap L (L >= 2), lap L - 1 was led by him
    const lead = cars[0];
    if (lead.laps >= 2 && lead.laps > R.lastLeaderLap) { const d = R.slots?.[lead.k] ?? `slot${lead.k}`; for (let L = Math.max(2, R.lastLeaderLap + 1); L <= lead.laps; L++) R.led.set(d, (R.led.get(d) ?? 0) + 1); R.lastLeaderLap = lead.laps; }
    if (ms - lastSent < 450) return null; lastSent = ms;
    const who = k => { const d = R.slots?.[k]; const r = d != null ? R.drv.get(d) : null, c = d != null ? R.car.get(d) : null;
      return { driver: d ?? null, name: r ? `${R.clean(r.FNAM)} ${R.clean(r.LNAM)}`.trim() : `Car ${k + 1}`, short: r ? R.clean(r.LNAM) : `Car ${k + 1}`, num: c ? R.clean(c.CNMD ?? c.CNUM) : "" }; };
    // practice / qualifying / happy hour: lap times, fastest first (cars without a timed lap last, most laps first)
    if (sess >= 0 && sess <= 2) {
      const rows = cars.map(c => ({ c, best: R.bestLap[c.k], last: R.lastLap[c.k], n: R.timedLaps[c.k] }))
        .sort((a, b) => (a.best ?? Infinity) - (b.best ?? Infinity) || b.n - a.n || a.c.pos - b.c.pos);
      const fastest = rows[0]?.best ?? null; let prev = null;
      const board = rows.map((x, i) => { const w = who(x.c.k), gap = i && x.best != null && fastest != null ? x.best - fastest : null, interval = i && x.best != null && prev != null ? x.best - prev : null;
        if (x.best != null) prev = x.best;
        return { pos: i + 1, slot: x.c.k, ...w, best: x.best, last: x.last, laps: x.n, gap, interval, pit: x.c.state === 5 || x.c.state === 6, player: x.c.k === 0, speed: Math.round(x.c.speed * 3600 / 5280) }; });
      return { t: "race", active: true, timed: true, session: ["Practice", "Qualifying", "Happy Hour"][sess], name: R.name, track: R.track, board, points: null, standings: null, mapped: !!R.slots };
    }
    const mostLed = Math.max(0, ...R.led.values());
    // laps down and gaps on the line: a car that started lap L at t is behind the leader by t - (the leader's start of
    // lap L), and down by the laps the leader had started beyond L before t (so a lead-lap car the leader has just
    // led across the line is not shown a lap down until it really is). Gaps never drop below the car ahead's.
    // A car that stops (wrecked, parked) crosses no line: it is also counted down once the leader is a lap further
    // than it could be by now (its lap so far, at the leader's last lap time, counted as at most a whole lap).
    const XL = R.cross[lead.k], YL = R.yellow[lead.k], leadLap = !caution && lead.laps >= 2 && XL[lead.laps] != null && XL[lead.laps - 1] != null && !YL[lead.laps] && !YL[lead.laps - 1] ? XL[lead.laps] - XL[lead.laps - 1] : null;
    const downOf = c => { if (c.laps < 1) return 0; const t = R.cross[c.k][c.laps]; if (t == null) return lead.laps - c.laps;
      let d = 0; for (let L = c.laps + 1; L <= lead.laps; L++) if (XL[L] != null && XL[L] <= t) d = L - c.laps;
      if (leadLap > 0) { const dl = lead.laps + Math.min(0.999, (ms - XL[lead.laps]) / leadLap), dc = c.laps + Math.min(0.999, (ms - t) / leadLap); d = Math.max(d, Math.floor(dl - dc)); }
      return d; };
    // live timing when the distances are there (else the line times above): passed(k, d) = when car k passed distance d
    const live = lead.dist != null && cars.filter(c => c.dist != null).length >= Math.max(1, N - 2);
    const passed = (k, d) => { const T = R.trail[k], x = Math.floor(d * BINS), i = x % RING; return x >= 0 && T.bin[i] === x ? T.t[i] : null; };
    const refLap = leadLap ? leadLap / 1000 : null;   // (the leader's last green lap; +0x54 is the time into the current lap)
    let prevGap = 0, prevDown = 0; const over = R.winnerAt != null || (!!R.laps && lead.laps > R.laps);   // the leader has taken the checkered flag
    const board = cars.map((c, i) => {
      const w = who(c.k), done = R.done[c.k], fin = !!done;
      let gap = null, down = i ? downOf(c) : 0, interval = null;
      if (i > 0 && live) {
        // live: laps down from the distances, the gap from the leader's trail (or the distance at his lap time)
        const behind = lead.dist - c.dist; down = behind >= 1 ? Math.floor(behind) : 0;
        if (!down && c.laps >= 1) { const t = passed(lead.k, c.dist); gap = t != null ? (ms - t) / 1000 : refLap ? behind * refLap : null;
          const ahead = cars[i - 1], ta = prevDown === 0 && ahead.dist != null ? passed(ahead.k, c.dist) : null;
          interval = ta != null ? Math.max(0, (ms - ta) / 1000) : gap != null && prevDown === 0 ? Math.max(0, gap - prevGap) : null; }
      } else {
        if (i > 0 && down === 0 && c.laps >= 1 && !caution && !R.yellow[c.k][c.laps]) { const t0 = R.cross[lead.k][c.laps], t1 = R.cross[c.k][c.laps]; if (t0 != null && t1 != null) gap = Math.max(0, (t1 - t0) / 1000); }
        // more than a lap behind on the line (the leader's crossings stop after the checkered flag): laps down
        if (gap != null && leadLap > 0 && gap * 1000 >= leadLap) { down = Math.floor(gap * 1000 / leadLap); gap = null; }
        if (gap != null && prevDown === 0) gap = Math.max(gap, prevGap);
        interval = gap != null && i > 0 && prevDown === 0 ? gap - prevGap : null;
      }
      if (gap != null) gap = Math.max(0, gap);
      if (done) { down = i ? done.down : 0; gap = i ? done.gap : null; interval = gap != null && prevDown === 0 && i > 0 ? Math.max(0, gap - prevGap) : null; }
      if (gap != null) prevGap = gap; prevDown = down;
      const led = w.driver != null ? (R.led.get(w.driver) ?? 0) : 0;
      // pit stops so far, and the one under way (in: on pit road, stall: being serviced, out: pulling away; t: seconds since pit road)
      const P = R.pit[c.k], cur = P.cur, pitNow = cur && !over ? { phase: cur.go != null ? "out" : cur.stall != null ? "stall" : "in", t: Math.round((ms - cur.in) / 100) / 10, lap: cur.lap, posIn: cur.posIn,
        stall: cur.stall != null ? Math.round(((cur.go ?? ms) - cur.stall) / 100) / 10 : null } : null;
      return { pos: i + 1, slot: c.k, ...w, laps: c.laps, down, gap, interval, led, fin, pit: !over && (c.state === 5 || c.state === 6), player: c.k === 0, speed: Math.round(c.speed * 3600 / 5280), stops: P.stops, pitNow };
    });
    // live race points: the place it is running in now + the lap bonuses (none in a non-points race)
    const scoring = R.scoring && sess === 3, season = R.season && sess === 3;
    const pts = board.map(b => { const bonus = scoring ? (b.led > 0 ? 5 : 0) + (b.led > 0 && b.led === mostLed ? 5 : 0) : 0, race = scoring ? (R.points.get(b.pos - 1) ?? 34) + bonus : 0, before = b.driver != null ? (R.before.get(b.driver) ?? 0) : 0;
      return { driver: b.driver, name: b.name, short: b.short, num: b.num, before, race, total: before + race, running: b.pos, bonus, player: b.player }; });
    pts.forEach((p, i) => { p.rank = i + 1; p.behind = i ? pts[0].race - p.race : 0; });
    // live season standings: every driver with points this season (in the race or not) + what the race gives him now;
    // ties as the game breaks them: more wins first
    let standings = null;
    if (season) {
      const inRace = new Map(pts.filter(p => p.driver != null).map(p => [p.driver, p])), ids = new Set([...[...R.before.keys()].filter(d => R.drv.has(d)), ...inRace.keys()]);
      const rows = [...ids].map(d => { const p = inRace.get(d), r = R.drv.get(d), c = R.car.get(d), before = R.before.get(d) ?? 0, race = p?.race ?? 0;
        return { driver: d, name: p?.name ?? (r ? `${R.clean(r.FNAM)} ${R.clean(r.LNAM)}`.trim() : `Driver ${d}`), short: p?.short ?? (r ? R.clean(r.LNAM) : `Driver ${d}`), num: p?.num ?? (c ? R.clean(c.CNMD ?? c.CNUM) : ""),
          before, race, total: before + race, running: p?.running ?? null, player: !!p?.player, wins: R.wins.get(d) ?? 0 }; });
      const order = (a, b, k) => b[k] - a[k] || b.wins - a.wins || String(a.name).localeCompare(String(b.name));
      const was = new Map([...rows].sort((a, b) => order(a, b, "before")).map((x, i) => [x.driver, i + 1]));
      rows.sort((a, b) => order(a, b, "total")); rows.forEach((x, i) => { x.rank = i + 1; x.was = R.before.size ? was.get(x.driver) : null; x.behind = i ? rows[0].total - x.total : 0; });
      standings = rows;
    }
    return { t: "race", active: true, name: R.name, track: R.track, lap: R.laps ? Math.min(lead.laps, R.laps) : lead.laps, laps: R.laps, season, scoring, year: R.year, over, caution: caution && !over, board, points: pts, standings, mapped: !!R.slots };
  }
  return { sample };
}
