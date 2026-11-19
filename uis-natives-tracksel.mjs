// uis-natives-tracksel.mjs — the track / race selection screen 0/3 (per-screen handler 0x8F4E0, ids 1..11).
//
// Game state (original addresses): a cursor over the selectable tracks (TRCK where TIPP = 1 and FRSZ = 0, by TSOR;
// 0x2B9100, count u16 0x2B9118) and a table of {track photo id TPHD, chosen race row} per track (0x2B9114).
// A track can host several races (RACE rows); the race list per track is a cursor ordered by RSEL desc, RSOR.

const SQL = {
  prefSetRace: "update 'ERPP' set 'DIAR' = \x82 where 'DIRP' = \x83",   // 0x1f4254
  raceTrack: "select 'DIRT' into \x82 from 'ECAR' where 'DIAR' = \x82",   // 0x1ded7c
  ginfSetRace: "update 'FNIG' set 'DIAR' = \x82 and 'DIRT' = \x82",   // 0x1f4224
  trackCursor: "declare \x8a cursor for select 'DHPT' and 'DIRT' and 'MNST' and 'YFIT' from 'KCRT' where 'PPIT' = 1 and 'ZSRF' = 0 order by 'ROST'",   // 0x1f41a0
  prefRace: "select 'DIAR' into \x82 from 'ERPP' where 'DIRP' = \x83",   // 0x1f416c
  raceTphd: "select 'KCRT'.'DHPT' into \x82 from 'ECAR' inner join 'KCRT' on 'ECAR'.'DIRT' = 'KCRT'.'DIRT' where 'ECAR'.'DIAR' = \x82",   // 0x1f40f8
  fetchTphd: "fetch from \x8a 'DHPT' into \x82",   // 0x1f2550
  raceCursorIds: "declare \x8a cursor for select 'ECAR'.'DIAR' from 'KCRT' inner join 'ECAR' on 'ECAR'.'DIRT' = 'KCRT'.'DIRT' where 'KCRT'.'DHPT' = \x82 and 'ECAR'.'DIAR' != \x82 order by 'ECAR'.'LESR' desc and 'ECAR'.'ROSR'",   // 0x1f4030
  fetchRaid: "fetch from \x8a 'ECAR'.'DIAR' into \x82",   // 0x1f400c
  fetchTrack: "fetch from \x8a 'DHPT' into \x82 and 'MNST' into \x88 and 'LEST' into \x82 and 'YFIT' into \x83",   // 0x1f3fb8
  raceCount: "select count(*) into \x82 from 'KCRT' inner join 'ECAR' on 'KCRT'.'DIRT' = 'ECAR'.'DIRT' where 'KCRT'.'DHPT' = \x82 and 'ECAR'.'DIAR' != \x82",   // 0x1f3f30
  raceCursor: "declare \x8a cursor for select 'ECAR'.'MANR' and 'ECAR'.'DIAR' and 'ECAR'.'LESR' from 'KCRT' inner join 'ECAR' on 'ECAR'.'DIRT' = 'KCRT'.'DIRT' where 'KCRT'.'DHPT' = \x82 and 'ECAR'.'DIAR' != \x82 order by 'ECAR'.'LESR' desc and 'ECAR'.'ROSR'",   // 0x1f3e40
  fetchRace: "fetch from \x8a 'ECAR'.'DIAR' into \x82 and 'ECAR'.'MANR' into \x88 and 'ECAR'.'LESR' into \x82",   // 0x1f3de8
  trackInfo: "select 'KCRT'.'YTIC' into \x88 and 'KCRT'.'TATS' into \x88 and 'KCRT'.'NELT' into \x86 and 'KCRT'.'PYTT' into \x83 and 'KCRT'.'KNBT' into \x88 and 'KCRT'.'DIRT' into \x82 and 'KCRT'.'DIRD' into \x82 from 'KCRT' inner join 'ECAR' on 'KCRT'.'DIRT' = 'ECAR'.'DIRT' where 'ECAR'.'DIAR' = \x82",   // 0x1f3cd8
  trackName: "select 'MNRT' into \x88 from 'KCRT' where 'DIRT' = \x82",   // 0x1f180c
  lenPct: "select 'NLRS' into \x82 from \x8c",   // 0x1f3ca4
  raceInfo: "select 'ECAR'.'TINR' into \x83 and 'ECAR'.'PALR' into \x84 and 'ECAR'.'TTAR' into \x82 and 'ECAR'.'YTSA' into \x80 and 'KCRT'.'TRQT' into \x86 and 'KCRT'.'DIRD' into \x82 from 'KCRT' inner join 'ECAR' on 'KCRT'.'DIRT' = 'ECAR'.'DIRT' where 'ECAR'.'DIAR' = \x82",   // 0x1f3bb0
  gameMode: "select 'DOMG' into \x82 from 'FNIG'",   // 0x1f3b74
  bestLap: "select 'TPAL' into \x82 from 'MTLB' where 'DHPT' = \x83 and 'DIRP' = \x83",   // 0x1f3b30
};
const NO_RACE = 0x3d;                         // race id 61 is excluded from every list
const DEFAULT_TPHD = 0xd;                     // track picked when the profile's race is not in the list

// 0x769F0: lap / qualifying time
export function formatTime(sec) {
  if (!(sec >= 0)) return "--:--.---";
  const ms = Math.round(sec * 1000), m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, f = ms % 1000;
  if (m >= 100) return "--:--.---";
  if (m === 0) return s < 10 ? `${s}.${String(f).padStart(3, "0")}` : `${String(s).padStart(2, "0")}.${String(f).padStart(3, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}.${String(f).padStart(3, "0")}`;
}
// 0x8F0C0: laps actually run for a race-length percentage; race style (ASTY) 1 and 2 have minimums
export function lapsFor(laps, pct, style) {
  if (style === 1 && [3, 5, 10].includes(pct)) pct = 25;
  else if (style === 2 && [3, 5].includes(pct)) pct = 10;
  return Math.trunc(laps * pct / 100);
}

export function createTrackSelect({ sql, state, setStr }) {
  let tracks = { cursor: null, count: 0, table: [] };
  const one = (key, params, i = 0) => sql(SQL[key], params)?.outputs?.[i];
  const at = (cur, row, key, n) => { if (!cur) return []; cur.pos = row; return sql(SQL[key], [cur, ...new Array(n).fill(null)])?.outputs.slice(1) ?? []; };
  const races = tphd => sql(SQL.raceCursor, [null, tphd, NO_RACE])?.cursor ?? null;
  const w32 = (vm, p, v) => { if (p) vm.mem.w32(p >>> 0, v >>> 0); };

  return {
    // 1: track row a0 -> short name a1, photo id a2, TSEL a3, TIFY a4 (0x8EDB0)
    0x80000001: ({ args, vm }) => {
      const [tphd, name, tsel, tify] = at(tracks.cursor, args[0] | 0, "fetchTrack", 4);
      setStr({ vm }, args[1], String(name ?? "")); w32(vm, args[2], tphd ?? 0); w32(vm, args[3], tsel ?? 0); w32(vm, args[4], tify ?? 0);
      return 0;
    },
    // 2: races at track a0 -> count a1, remembered race row a2 (0x8EE20)
    0x80000002: ({ args, vm }) => {
      w32(vm, args[1], one("raceCount", [null, args[0] | 0, NO_RACE]) | 0);
      const e = tracks.table.find(t => t.tphd === (args[0] | 0)) ?? tracks.table.at(-1); w32(vm, args[2], e?.row ?? 0);
      return 0;
    },
    // 3: details of race a1: track name a2, "city, state" a3, track type a4, length a5, banking a6, a7 <- road course (0x8EF20)
    0x80000003: ({ args, vm }) => {
      const r = sql(SQL.trackInfo, [null, null, null, null, null, null, null, args[1] | 0])?.outputs ?? [];
      const [city, st, len, ttyp, bank, trid] = r;
      setStr({ vm }, args[3], `${city ?? ""}, ${st ?? ""}`);
      setStr({ vm }, args[2], String(one("trackName", [null, trid]) ?? ""));
      let l = (len ?? 0).toFixed(5).replace(/0+$/, ""); if (l.endsWith(".")) l += "0";
      setStr({ vm }, args[5], `${l} Mile `);
      setStr({ vm }, args[4], String(sql("select 'SIDE' into \x88 from 'TRTE' where 'LAVE' = \x82", [null, ttyp])?.outputs[0] ?? "")); // enum text (0x5F150 'ETRT')
      w32(vm, args[7], ttyp === 3 ? 1 : 0);
      setStr({ vm }, args[6], String(bank ?? ""));
      return 0;
    },
    // 4: race row a1 at track a0 -> name a2, race id a3, a4 <- locked (RSEL = 0); remembers the row (0x8EE70)
    0x80000004: ({ args, vm }) => {
      const cur = races(args[0] | 0), [raid, rnam, rsel] = at(cur, args[1] | 0, "fetchRace", 3);
      w32(vm, args[3], raid ?? 0); setStr({ vm }, args[2], String(rnam ?? "")); w32(vm, args[4], rsel ? 0 : 1);
      const e = tracks.table.find(t => t.tphd === (args[0] | 0)); if (e) e.row = args[1] | 0;
      return 0;
    },
    // 5: pick race a0: profile, game info (0x8EB90)
    0x80000005: ({ args }) => {
      const raid = args[0] | 0; sql(SQL.prefSetRace, [raid, state.profile]);
      sql(SQL.ginfSetRace, [raid, one("raceTrack", [null, raid]) | 0]); return 0;
    },
    // 6: open the track list -> count a0, start row a1 (the profile's race's track), its race row a2 (0x8EBE0)
    0x80000006: ({ args, vm }) => {
      tracks.cursor = sql(SQL.trackCursor, [null])?.cursor ?? null; tracks.count = tracks.cursor?.ctxs.length ?? 0;
      w32(vm, args[0], tracks.count);
      const raid = one("prefRace", [null, state.profile]), tphd = raid === undefined ? undefined : one("raceTphd", [null, raid]);
      const ids = []; for (let i = 0; i < tracks.count; i++) ids.push(at(tracks.cursor, i, "fetchTphd", 1)[0]);
      let row = ids.indexOf(tphd), useTphd = tphd, useRaid = raid;
      if (row < 0) { row = Math.max(0, ids.indexOf(DEFAULT_TPHD)); useTphd = DEFAULT_TPHD; useRaid = 0x12; }
      w32(vm, args[1], row);
      const rc = sql(SQL.raceCursorIds, [null, useTphd, NO_RACE])?.cursor; let rrow = 0;
      if (rc) for (let i = 0; i < rc.ctxs.length; i++) if (at(rc, i, "fetchRaid", 1)[0] === useRaid) { rrow = i; break; }
      w32(vm, args[2], rrow);
      tracks.table = ids.map(t => ({ tphd: t, row: t === useTphd ? rrow : 0 }));
      return 0;
    },
    0x80000007: () => 0,                                                             // close (0x8EB40)
    0x80000008: () => 0,
    // 9: race a0 facts: record time / holder a3, best lap a4, laps a5, time of day a6 (0x8F0C0)
    0x80000009: ({ args, vm }) => {
      const pct = one("lenPct", [null, "LPGC"]) ?? 100;
      const [night, laps, , style, rec, holder] = sql(SQL.raceInfo, [null, null, null, null, null, null, args[1] | 0])?.outputs ?? [];
      let s = formatTime(rec);
      if (holder !== undefined && holder !== -1) { const n = sql("select 'MANF' into \x88 and 'MANL' into \x88 from 'RVRD' where 'DIRD' = \x82", [null, null, holder])?.outputs ?? []; s += ` / ${n[0] ?? ""} ${n[1] ?? ""}`; }
      setStr({ vm }, args[3], s);
      setStr({ vm }, args[6], night ? "Nighttime" : "Daytime");
      setStr({ vm }, args[5], `${lapsFor(laps | 0, pct, style)} Laps`);
      setStr({ vm }, args[4], " ");                                                    // best lap per profile (table TBLM) not in this database
      return 0;
    },
    // 11: race length index of the current mode's settings (0x8F3F0)
    0x8000000b: ({ args, vm }) => { const i = [3, 5, 10, 25, 50, 100].indexOf(one("lenPct", [null, "LPGC"])); if (i >= 0) w32(vm, args[0], i); return 0; },
  };
}
