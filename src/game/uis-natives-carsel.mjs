// uis-natives-carsel.mjs — the car / driver selection screens 0/8, 0/9, 0/10 (per-screen handler 0x8DFE0, ids 1..21).
//
// Game state the handler keeps (addresses in the original):
//   per player p (0..3; the profile slot is found from the port by 0x14710, falling back to p):
//   cursor over the player's unlocked cars      0x2B903C + 0x14p   (count 0x2B9038 + 0x14p; row set through +4)
//   rows per class (Cup, Busch-type 0, type 3, type 4, created cars)   u16[5] at 0x2B8FFC + 10p
//   selected car id (CRID)                      0x2B9028 + 4p
//   current class shown                         u8 0x2B9024 + p
//   preview car: skin id (CTID), loaded id, model, type   0x2B9088 + 0x18p
//   readiness per player (0 none, 1 cancelled, 2 car chosen)   0x28A4C0 + 4p
//   one cursor over the created-car table CCAR (0x2B90EC, count 0x2B90E8)
// Cars belong to a player through CARS.PLID (-2 = free). The unlocked list per profile is table ULDR.

const SQL = {
  carsUnassign: "update 'SRAC' set 'DILP' = \x82",   // 0x1e5590
  customCursor: "declare \x8a cursor for select 'DIRC' from 'RACC' order by 'MUNC' and 'MANL' and 'MANF'",   // 0x1f3820
  driverCursor: "declare \x8a cursor for select 'SRAC'.'DIRD' and 'SRAC'.'DIRC' and 'SRAC'.'LDMC' and 'SRAC'.'LESC' and 'SRAC'.'PYTC' from 'RDLU' inner join 'SRAC' on 'RDLU'.'DIRC' = 'SRAC'.'DIRC' inner join 'RVRD' on 'SRAC'.'DIRD' = 'RVRD'.'DIRD' where 'RDLU'.'DIRP' = \x83 and ('SRAC'.'PYTC' = \x82 or 'SRAC'.'PYTC' = \x82 or 'SRAC'.'PYTC' = \x82 or 'SRAC'.'PYTC' = \x82 or 'SRAC'.'PYTC' = \x82 or 'SRAC'.'PYTC' = \x82) order by 'SRAC'.'LESC' and 'SRAC'.'MUNC' and 'RVRD'.'MANL' and 'RVRD'.'MANF'",   // 0x1f3650
  cntCup: "select count(*) into \x81 from 'RDLU' inner join 'SRAC' on 'RDLU'.'DIRC' = 'SRAC'.'DIRC' inner join 'RVRD' on 'SRAC'.'DIRD' = 'RVRD'.'DIRD' where 'RDLU'.'DIRP' = \x83 and ('SRAC'.'PYTC' = \x82 or 'SRAC'.'PYTC' = \x82)",   // 0x1f3580
  cntType: "select count(*) into \x81 from 'RDLU' inner join 'SRAC' on 'RDLU'.'DIRC' = 'SRAC'.'DIRC' inner join 'RVRD' on 'SRAC'.'DIRD' = 'RVRD'.'DIRD' where 'RDLU'.'DIRP' = \x83 and ('SRAC'.'PYTC' = \x82)",   // 0x1f34c0
  cntType1: "select count(*) into \x81 from 'RDLU' inner join 'SRAC' on 'RDLU'.'DIRC' = 'SRAC'.'DIRC' inner join 'RVRD' on 'SRAC'.'DIRD' = 'RVRD'.'DIRD' where 'RDLU'.'DIRP' = \x83 and 'SRAC'.'PYTC' = \x82",   // 0x1f3408
  prefCar: "select 'DIRC' into \x82 and 'DICD' into \x82 from 'ERPP' where 'DIRP' = \x83",   // 0x1f33c0
  carByCrid: "select 'DIRD' into \x82 and 'PYTC' into \x82 from 'SRAC' where ('DILP' < 0 or 'DILP' = \x82) and 'DIRC' = \x82",   // 0x1f3358
  firstCup: "select 'SRAC'.'DIRD' into \x82 from 'SRAC' inner join 'RDLU' on 'SRAC'.'DIRC' = 'RDLU'.'DIRC' where 'RDLU'.'DIRP' = \x83 and ('SRAC'.'DILP' < 0 or 'SRAC'.'DILP' = \x82) and ('SRAC'.'PYTC' = \x82 or 'SRAC'.'PYTC' = \x82 or 'SRAC'.'PYTC' = \x82)",   // 0x1f3270
  fetchDrid: "fetch from \x8a 'SRAC'.'DIRD' into \x82",   // 0x1f3248
  fetchRow: "fetch from \x8a 'SRAC'.'DIRD' into \x82 and 'SRAC'.'PYTC' into \x82 and 'SRAC'.'DMNC' into \x88",   // 0x1f31f0
  drvName: "select 'MANF' into \x88 and 'MANL' into \x88 from 'RVRD' where 'DIRD' = \x82",   // 0x1e26f0
  carPlid: "select 'DILP' into \x82 from 'SRAC' where 'DIRD' = \x82",   // 0x1d3b60
  fetchCrid: "fetch from \x8a 'DIRC' into \x82",   // 0x1d4308
  customRow: "select 'MANF' into \x88 and 'MANL' into \x88 and 'DMNC' into \x88 from 'RACC' where 'DIRC' = \x82",   // 0x1f3198
  fetchCridType: "fetch from \x8a 'SRAC'.'DIRC' into \x82 and 'SRAC'.'PYTC' into \x80",   // 0x1f2f04
  carByPlid: "select 'DIRD' into \x82 and 'NTSC' into \x82 and 'LDMC' into \x83 from 'SRAC' where 'DILP' = \x82",   // 0x1f2e38
  plidOfCrid: "select 'DILP' into \x82 from 'SRAC' where 'DIRC' = \x82",   // 0x1d3f6c
  clearPlid: "update 'SRAC' set 'DILP' = \x82 where 'DILP' = \x80",   // 0x1d3f3c
  setPlid: "update 'SRAC' set 'DILP' = \x80 and 'NTSC' = \x82 where 'DIRC' = \x82",   // 0x1d3efc
  prefSetCar: "update 'ERPP' set 'DIRC' = \x82 where 'DIRP' = \x83",   // 0x1d3ecc
  carType: "select 'PYTC' into \x80 from 'SRAC' where 'DIRC' = \x82",   // 0x1d3e98
  prefSetDrv: "update 'ERPP' set 'DICD' = \x82 where 'DIRP' = \x83",   // 0x1d3e68
  prefSave: "update 'ERPP' set 'DICD' = \x82 and 'DIRC' = \x82 where 'DIRP' = \x83",   // 0x1f2ec4
  cridByPlid: "select 'DIRC' into \x82 from 'SRAC' where 'DILP' = \x82",   // 0x1d3fa0
  uldrDelete: "delete from 'RDLU'",   // 0x1de1fc
  uldrCars: "declare \x8a cursor for select 'DIRC' from 'SRAC' where 'PYTC' != \x82 and 'PYTC' != \x82 and 'PYTC' != \x82 and 'PYTC' != \x82",   // 0x1de188
  uldrInsert: "insert into 'RDLU' set 'DIRP' = \x82 and 'DIRC' = \x82",   // 0x1de154
  uldrHas: "select count(*) into \x82 from 'RDLU' where 'DIRC' = \x82 and 'DIRP' = \x83",   // 0x1de110
  fetchDridType: "fetch from \x8a 'SRAC'.'DIRD' into \x82 and 'SRAC'.'PYTC' into \x82",   // 0x1f3158
  skinCount: "select count(*) into \x82 from 'SRAC' inner join 'KSRC' on 'KSRC'.'DIRC' = 'SRAC'.'DIRC' where 'SRAC'.'DIRD' = \x82",   // 0x1f30e8
  carInfo: "select 'NTSC' into \x82 and 'LDMC' into \x83 and 'DIRC' into \x82 and 'MEUC' into \x82 from 'SRAC' where 'DIRD' = \x82",   // 0x1f3078
  skinOf: "select 'DITC' into \x82 from 'KSRC' where 'DIRC' = \x82 and 'NXTC' = \x82",   // 0x1f12c0
  customModel: "select 'LDMC' into \x83 from 'RACC' where 'DIRC' = \x82",   // 0x1f3044
};

// CARS.CTYP -> list class (0x8D66C / 0x8D868)
const CLASS_OF_TYPE = { 0: 1, 1: 0, 2: 0, 3: 2, 4: 3, 6: 4 };
export const CUSTOM_DRIVER_BASE = 1000;     // 0x6C870 adds [0x21FD0C] to a created car's id (value set at run time)

export function createCarSelect({ sql, state, setStr, numPlayers }) {
  const P = [0, 1, 2, 3].map(() => ({ cursor: null, count: 0, counts: [0, 0, 0, 0, 0], sel: -1, cls: 0,
                                      preview: { ctid: -1, loaded: -1, shown: -1, model: 0, type: 0 } }));
  let custom = { cursor: null, count: 0 };
  state.ready ??= [0, 0, 0, 0];
  const slotOf = p => p & 3;                                         // 0x14710: profile slot of a port (4 -> port)
  const one = (key, params, i = 0) => { const r = sql(SQL[key], params); return r?.outputs?.[i]; };
  const fetchRow = (cur, row, key, nOut) => { if (!cur) return []; cur.pos = row; const p = [cur, ...new Array(nOut).fill(null)];
    const r = sql(SQL[key], p); return r ? r.outputs.slice(1) : []; };

  // 0x11D30: give player p the car crid (or none) and remember it in the profile
  function assign(p, crid, scheme = 0) {
    sql(SQL.clearPlid, [-2, p]);
    if (crid < 0) { if (state.ready[p] === 2) state.ready[p] = 1; else if (state.ready[p] === 1) state.ready[p] = 0; return; }
    sql(SQL.setPlid, [p, scheme, crid]); state.ready[p] = 2;
    sql(SQL.prefSetCar, [crid, slotOf(p)]);
    if (one("carType", [null, crid]) !== 6) sql(SQL.prefSetDrv, [crid, slotOf(p)]);
  }
  const findRow = (p, drid) => { const s = P[slotOf(p)]; for (let r = 0; r < s.count; r++) if (fetchRow(s.cursor, r, "fetchDrid", 1)[0] === drid) return r; return -1; };

  return {
    // 1: open the lists (0x8D120)
    0x80000001: () => {
      sql(SQL.carsUnassign, [-2]);
      custom.cursor = sql(SQL.customCursor, [null])?.cursor ?? null; custom.count = custom.cursor?.ctxs.length ?? 0;
      for (let p = 0; p < 4; p++) {
        const s = P[p]; Object.assign(s, { sel: -1, cls: 0 }); s.preview = { ctid: -1, loaded: -1, shown: -1, model: 0, type: 0 };
        s.cursor = sql(SQL.driverCursor, [null, p, 0, 3, 3, 4, 1, 2])?.cursor ?? null; s.count = s.cursor?.ctxs.length ?? 0;
        s.counts = [one("cntCup", [null, p, 1, 2]), one("cntType", [null, p, 0]), one("cntCup", [null, p, 3, 3]), one("cntType1", [null, p, 4]), custom.count].map(v => v | 0);
      }
      return 0;
    },
    0x80000002: () => 0,                                                             // close cursors, free previews
    // 3: choose the car in row a1 for player a0 (0x8DC90); a2 = paint scheme
    0x80000003: ({ args }) => {
      const [p, row, scheme] = args.map(a => a | 0), s = P[slotOf(p)];
      if (row < s.count) { const [crid] = fetchRow(s.cursor, row, "fetchCridType", 2); s.sel = crid; assign(p, crid, scheme); }
      else { const [crid] = fetchRow(custom.cursor, row - s.count, "fetchCrid", 1); s.sel = crid; assign(p, crid, scheme); }
      return 1;
    },
    // 4: rows in the list and the row to start on (0x8D310 / 0x8D350): the profile's last car, its driver's car,
    // else the first free Cup car
    0x80000004: ({ args, vm }) => {
      const [p, pCount, pIndex] = args, slot = slotOf(p | 0), s = P[slot];
      if (pCount) vm.mem.w32(pCount, s.count + custom.count);
      const r = sql(SQL.prefCar, [null, null, slot]), [crid, dcid] = [r?.outputs[0], r?.outputs[1]];
      let drid;
      for (const c of [crid, dcid]) { if (c === undefined) continue; const x = sql(SQL.carByCrid, [null, null, p | 0, c]); if (x?.rows.length) { drid = x.outputs[0]; break; } }
      if (drid === undefined) drid = one("firstCup", [null, slot, p | 0, 1, 2, 2]);
      const row = drid === undefined ? -1 : findRow(p, drid);
      if (pIndex && row >= 0) vm.mem.w32(pIndex, row);
      return 0;
    },
    // 5: one list row: name, number, driver id, class, taken-by-another-player status (0x8D4E0)
    0x80000005: ({ args, vm, ...c }) => {
      const [p, row, nameRec, pDrid, pType, pStatus, numRec] = args, s = P[slotOf(p | 0)];
      let first = "", last = "", num = "", drid = -1, type = 0, status = 0;
      if ((row | 0) < s.count) {
        const [d, ctyp, cnmd] = fetchRow(s.cursor, row | 0, "fetchRow", 3);
        drid = d; type = CLASS_OF_TYPE[ctyp] ?? ctyp; num = String(cnmd ?? "");
        const n = sql(SQL.drvName, [null, null, drid]); first = n?.outputs[0] ?? ""; last = n?.outputs[1] ?? "";
        const plid = one("carPlid", [null, drid]); status = plid === (p | 0) || plid === -2 ? 0 : 2;
      } else {
        const [crid] = fetchRow(custom.cursor, (row | 0) - s.count, "fetchCrid", 1);
        const n = sql(SQL.customRow, [null, null, null, crid]); [first, last, num] = (n?.outputs ?? []).map(v => v ?? "");
        drid = CUSTOM_DRIVER_BASE + crid; type = 4;
      }
      if (pDrid) vm.mem.w32(pDrid, drid); if (pType) vm.mem.w32(pType, type); if (pStatus) vm.mem.w32(pStatus, status);
      setStr({ vm }, nameRec, `${first} ${last}`); setStr({ vm }, numRec, num);
      return 0;
    },
    // 6: preview data for row a1 (0x8D680): driver, skin count, scheme, class
    0x80000006: ({ args, vm }) => {
      const [p, row, pDrid, pCustom, pClass, pSkins, pScheme] = args.map(a => a >>> 0), s = P[slotOf(p)];
      let cls, ctyp;
      if ((row | 0) < s.count) {
        const [drid, t] = fetchRow(s.cursor, row | 0, "fetchDridType", 2); ctyp = t;
        if (pDrid) vm.mem.w32(pDrid, drid);
        if (pSkins) vm.mem.w32(pSkins, one("skinCount", [null, drid]) | 0);
        const car = sql(SQL.carInfo, [null, null, null, null, drid])?.outputs ?? [];
        if (pScheme) vm.mem.w32(pScheme, car[0] | 0);
        const ctid = one("skinOf", [null, car[2], car[0]]);
        s.preview = { ...s.preview, ctid: ctid ?? -1, model: car[1] | 0, type: ctyp };
        if (pCustom) vm.mem.w32(pCustom, 0);
      } else {
        const [crid] = fetchRow(custom.cursor, (row | 0) - s.count, "fetchCrid", 1); ctyp = 6;
        if (pDrid) vm.mem.w32(pDrid, CUSTOM_DRIVER_BASE + crid); if (pCustom) vm.mem.w32(pCustom, 1);
        if (pScheme) vm.mem.w32(pScheme, 0); if (pSkins) vm.mem.w32(pSkins, 0);
        s.preview = { ...s.preview, ctid: -2, model: one("customModel", [null, crid]) | 0, type: 6 };
      }
      cls = CLASS_OF_TYPE[ctyp]; if (cls !== undefined) { s.cls = cls; if (pClass) vm.mem.w32(pClass, cls); }
      return 0;
    },
    0x80000007: () => 0,                                                             // paint / number textures for the preview (0x8D890)
    0x80000008: ({ args }) => { const s = P[slotOf(args[0] | 0)]; s.preview.loaded = s.preview.ctid === -1 ? 0 : s.preview.ctid; return 0; }, // start loading the car (0x8D9D0); here it is ready at once
    0x80000009: ({ args }) => P[slotOf(args[0] | 0)].preview.loaded !== -1 ? 1 : 0, // car loaded? (0x8DB60)
    0x8000000a: ({ args, vm }) => { for (const r of args.slice(0, 3)) setStr({ vm }, r, " "); return 0; },   // 0x8DDF0
    0x8000000b: ({ args }) => { const p = args[0] | 0, s = P[slotOf(p)]; s.preview.shown = s.preview.loaded; return s.preview.loaded < 0 ? p + 5 : p; }, // show in viewport (0x8DB80)
    0x8000000c: ({ args }) => {                                                     // remember row a1 as the profile's car (0x8DED0)
      const [p, row] = args.map(a => a | 0), s = P[slotOf(p)];
      if (row < s.count) { const [crid] = fetchRow(s.cursor, row, "fetchCridType", 2); sql(SQL.prefSave, [crid, crid, slotOf(p)]); }
      return 0;
    },
    0x8000000d: ({ args }) => { const p = args[0] | 0; assign(p, -1); P[slotOf(p)].sel = -1; return 0; }, // drop the choice (0x8DE10)
    // 14: step the class shown by a1, skipping empty ones; a2 <- first row of that class, a3 <- changed (0x8DD50)
    0x8000000e: ({ args, vm }) => {
      const [p, delta, pStart, pChanged] = args, s = P[slotOf(p | 0)], old = s.cls;
      let c = old; for (let i = 0; i < 6; i++) { c += delta | 0; if (c >= 5) c = 0; else if (c < 0) c = 4; if (s.counts[c]) break; }
      s.cls = c;
      const start = c === 4 ? s.count : s.counts.slice(0, c).reduce((a, b) => a + b, 0);
      if (pStart) vm.mem.w32(pStart, start); if (pChanged) vm.mem.w32(pChanged, c !== old ? 1 : 0);
      return 0;
    },
    0x8000000f: ({ args }) => (args[0] | 0) < (state.numPads ?? 1) ? 1 : 0,        // controller on port a0 present (0x6AFF0)
    0x80000010: ({ args }) => { const p = args[0] | 0, s = P[slotOf(p)]; s.preview.shown = s.preview.loaded; return s.preview.loaded < 0 ? p + 5 : p; }, // 0x8DE30
    0x80000012: ({ args, vm }) => {                                                 // car of player a0 (0x8DF90)
      const r = sql(SQL.carByPlid, [null, null, null, args[0] | 0]);
      if (r?.rows.length) { if (args[1]) vm.mem.w32(args[1], r.outputs[0]); if (args[2]) vm.mem.w32(args[2], r.outputs[1]); }
      else { if (args[1]) vm.mem.w32(args[1], -1); if (args[2]) vm.mem.w32(args[2], 0); }
      return 0;
    },
    0x80000013: () => { for (let i = 0; i < numPlayers(); i++) if (!sql(SQL.cridByPlid, [null, i])?.rows.length) return 0; return 1; }, // all players have a car (0x11CE0)
    0x80000014: () => state.ready.some(r => r === 0) ? 1 : 0,                       // 0x11E60
    0x80000015: ({ args }) => Math.max(0, findRow(args[0] | 0, args[1] | 0)),        // row of driver a1 (0x8D470)
  };
}

// Game start-up default (0x16840, run when the profile system initialises at 0x146B0): every profile gets every car
// except types 6, 8, 9 and -1 in its unlocked list. The unlock-card pass that follows (0x15DD0 for card types
// 0..7 via the handler table 0x21DC14) is not ported yet.
export function resetUnlockedCars(sql) {
  sql(SQL.uldrDelete, []);
  const cur = sql(SQL.uldrCars, [null, 6, 8, 9, -1])?.cursor; if (!cur) return 0;
  let n = 0;
  for (let i = 0; i < cur.ctxs.length; i++) { const [crid] = sql(SQL.fetchCrid, [cur, null]).outputs.slice(1);
    for (let prid = 0; prid < 4; prid++) { sql(SQL.uldrInsert, [prid, crid]); n++; } }
  return n;
}
