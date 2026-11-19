// uis-natives.mjs — Node implementations of the game functions the UI scripts call (native_call, opcode 0x0B).
//
// Dispatch in the game: 0x7A6A0 first offers the call to the per-screen handlers (0x78820: group -> screen ->
// handler, e.g. main menu 0/0 = 0x8E4E0, F_Main 0/5 = 0x8E240), then switches over global ids 0..0xF7
// (index table 0x7B020 -> jump table 0x7AE9C). Global ids are listed below with the game helper each one uses.
// Many are single database queries; they run here through nascar-db.mjs with the executable's own query strings
// (names byte-reversed, typed placeholders). State the game keeps in globals lives in `state` with documented
// defaults. Anything not implemented returns 0 and is counted in `missing`.

import { existsSync } from "node:fs";
import { parseQuery } from "./nascar-db.mjs";
import { GameCode } from "./gamecode.mjs";
import { createCarSelect, resetUnlockedCars } from "./uis-natives-carsel.mjs";
import { createTrackSelect } from "./uis-natives-tracksel.mjs";

const f2u = new DataView(new ArrayBuffer(4));
const asF = u => (f2u.setUint32(0, u >>> 0, true), f2u.getFloat32(0, true));
const asU = f => (f2u.setFloat32(0, f, true), f2u.getUint32(0, true));

// Query strings exactly as in the executable (address noted), names reversed as stored there.
const Q = {
  numPlayers:   ["0x1ede00", "select 'LPMN' into \x85 from 'FNIG'"],
  numLocalPl:   ["0x1edddc", "select 'LLPN' into \x85 from 'FNIG'"],
  driverPOID:   ["0x1edda8", "select 'DIOP' into \x82 from 'RVRD' where 'DIRD' = \x82"],
  raceTrack:    ["0x1ded7c", "select 'DIRT' into \x82 from 'ECAR' where 'DIAR' = \x82"],
  trackLogo:    ["0x1edd74", "select 'DILT' into \x82 from 'KCRT' where 'DIRT' = \x82"],
  raceRLID:     ["0x1edd40", "select 'DILR' into \x82 from 'ECAR' where 'DIAR' = \x82"],
  trackTA:      ["0x1edcf8", "select 'DIAT' into \x82 and 'TINT' into \x80 from 'KCRT' where 'DIRT' = \x82"],
  driverBio:    ["0x1edeb8", "select 'YTIC' into \x88 and 'TATS' into \x88 and 'TADB' into \x83 and 'NOMB' into \x83 and 'REYB' into \x84 from 'RVRD' where 'DIRD' = \x82"],
  driverTeam:   ["0x1ede28", "select 'MAET'.'MNMT' into \x88 from 'SRAC' inner join 'MAET' on 'SRAC'.'DIMT' = 'MAET'.'DIMT' where 'SRAC'.'DIRD' = \x82"],
  driverName:   ["0x1e26f0", "select 'MANF' into \x88 and 'MANL' into \x88 from 'RVRD' where 'DIRD' = \x82"],
  carOf:        ["0x1edc58", "select 'SRAC'.'PYTC' into \x82 and 'SRAC'.'DIRC' into \x82 and 'SRAC'.'NTSC' into \x82 from 'SRAC' where 'SRAC'.'DIRD' = \x82"],
  sysAutosave:  ["0x1eb694", "select 'VASA' into \x83 from 'SYSC'"],
  gameScid:     ["0x1ee814", "select 'DICS' into \x82 from 'FNIG'"],
  // Race Now settings screen 0/13 (handler 0x8C580)
  profDiff:     ["0x1f28e4", "select 'FFID' into \x82 from 'PPGS' where 'DIRP' = \x83"],
  profLen:      ["0x1f28b0", "select 'NLRS' into \x82 from 'PPGS' where 'DIRP' = \x83"],
  diffName:     ["0x1f287c", "select 'SIDE' into \x88 from 'FIDE' where 'LAVE' = \x82"],
  diffSettings: ["0x1f2800", "select 'FIDS' into \x83 and 'MADS' into \x83 and 'TIPS' into \x83 and 'HTAS' into \x83 and 'LEYS' into \x83 from 'FFID' where 'FFID' = \x82"],
  skillName:    ["0x1f27cc", "select 'SIDE' into \x88 from 'LKSE' where 'LAVE' = \x83"],
  setProfDiff:  ["0x1f2744", "update 'PPGS' set 'FFID' = \x82 where 'DIRP' = \x83"],
  setProfLen:   ["0x1f2714", "update 'PPGS' set 'NLRS' = \x82 where 'DIRP' = \x83"],
};

// With the game's code present these globals run there instead of their JS versions, because other game code
// reads the state they keep: busy counter 0x2F3424 (0xCF/0xCE; blocks quick save), input lock 0x2B7936 (0xE9),
// message texts for the memory-unit dialogs (0x2E, 0x79A90), the autosave checks: unsaved changes of a save type
// (0x29, 0x79450) and profiles in use (0xD9, 0xE6790); the controller port of a player (0x33, 0x6ACA0: table 0x2B7008,
// stride 0x10): the race HUD's pit screens 10/1 / 10/2 keep it and drop presses from any other port (the JS stub's
// -1 matched no port, so Left / Right on pit road did nothing).
// The number of cars in the session (0x5B: 0x79800 -> 0x13680, byte 0x28A553) too: the post-race results screen 3/6
// sizes its "Official Results" list with it, and the JS stand-in (the number of controllers) gave it one row.
// And the queued unlock notices (0x35 -> 0x16A80, count 0x2F2DA8): the game queues one per Thunder Plate it awards
// (0x159E0 -> 0x158D0); the JS stand-in always said 0, so "You've unlocked N new Thunder Plates" (2/3) never opened.
// And 0x92 (0x7A220: a0 = string record <- the active profile's name, *a1 = the active profile slot 0x21DB74 via
// 0x146F0): the button bar 2/1 asks it for the slot and passes that to 0x91 for the "Y <profile>" label; the JS
// stand-in wrote 0 into a0 and left *a1 alone, so the label stayed on slot 0's name after a profile change.
const GAME_FIRST = [0xcf, 0xe9, 0x2e, 0xe8, 0xc8, 0x01, 0x29, 0xd9, 0x33, 0x5b, 0x35, 0x92];
export function createNatives({ db = null, assets = null, log = () => {}, game = null } = {}) {
  const missing = new Map(), actions = [], perScreenHits = new Map();
  const state = {
    profile: 0,              // 0x21DB74 active profile slot (helper 0x146F0)
    unlocks: [],             // 0x2F2DA0 queue of newly unlocked items (push 0x158D0, pop 0x15920); count 0x2F2DA8 = native 0x35
    uiReady: 1,              // 0x2186D8 streaming/texture system idle (native 0x41)
    numPads: 1,              // 0x28A553 connected controllers (helper 0x13680)
    flag21fe24: 0,           // 0x21FE24 (native 0xF5)
    inputLock: 1,            // 0x2B7936 (native 0xE9 sets)
    busy: 0,                 // 0x2F30FC busy counter (native 0x51)
    settings: new Array(256).fill(0),   // 0x21DB78 option values (natives 0x2D get, 0xC1 set)
    counter2f3424: 0,        // native 0xCF
    audio: {},               // volumes / positions set by natives 0x06 0x08 0x31 0x7A 0x7B 0x7F 0x81
  };
  // the audio natives (music player / volumes, 0xEDxxx-0xF0xxx) run the game's own code when it is there, so the
  // menu music and the sound options take effect; without the game they only store their arguments
  const gameAudio = (id, args) => { if (!game) return 0; try { const r = game.global(id, args); return r.handled ? r.value : 0; } catch (e) { log(`audio native 0x${id.toString(16)}: ${e.message.slice(0, 160)}`); return 0; } };
  const q = (key, params) => {
    if (!db) return null;
    try { return db.exec(parseQuery(Q[key][1], { reversedNames: true }), params, { reversedNames: true }); }
    catch (e) { log(`query ${key} failed: ${e.message}`); return null; }
  };
  // Any query string from the executable (names reversed, typed placeholders); parsed once.
  const parsed = new Map();
  const sql = (text, params = []) => {
    if (!db) return null;
    try { let ast = parsed.get(text); if (!ast) parsed.set(text, ast = parseQuery(text, { reversedNames: true }));
          return db.exec(ast, params, { reversedNames: true }); }
    catch (e) { log(`sql failed: ${e.message}: ${text.slice(0, 80)}`); return null; }
  };
  // Profile system start-up (0x146B0) resets every profile's unlocked-car list when no save exists.
  if (db && !db.tables.get("ULDR")?.rows.length) resetUnlockedCars(sql);
  const out = (r, i, def = 0) => (r && r.outputs[i] !== undefined && r.outputs[i] !== null) ? r.outputs[i] : def;
  const str = ({ vm }, rec) => rec ? vm.mem.cstr(vm.mem.r32(rec + 8)) : "";
  const setStr = ({ vm }, rec, s) => { if (rec) vm.mem.wstr(vm.mem.r32(rec + 8), s, vm.mem.r32(rec + 4)); };
  const textWidth = (s, fontGroup = 0, fontEntry = 0) => {          // 0x1425A0 measure with the UI font cache
    const f = assets?.font(fontGroup, fontEntry); if (!f) return s.length * 10;
    let w = 0, prev = -1; for (const ch of s) { const c = ch.charCodeAt(0), g = f.glyphs.get(c) ?? f.glyphs.get(0xb5); if (!g) continue;
      if (prev >= 0) w += f.kern.get(prev << 16 | c) ?? 0; w += g.adv; prev = c; }
    return w;
  };

  const N = {
    0x00: () => out(q("numPlayers", [null]), 0, 1),                           // 0x797D0 GINF.NMPL (default 1)
    0x01: () => 0,                                                             // 0x79F60 car/number swap for driver (needs game state)
    0x02: ({ args }) => out(q("driverPOID", [null, args[0] | 0]), 0),          // 0x79840 DRVR.POID
    0x03: () => 0,                                                             // 0x175E0 float setting == 0x204DC0
    0x04: ({ args, ...c }) => { const r = q("driverTeam", [null, args[0] | 0]); setStr(c, args[1], String(out(r, 0, ""))); return 0; }, // 0x795C0
    0x05: () => 0,                                                             // shared "return 0" case
    0x06: ({ args }) => { state.audio.x2e107c = args[0] & 0xff; return gameAudio(0x06, args); },  // 0xF0240
    0x08: ({ args }) => { state.audio.f0270 = args.slice(); return gameAudio(0x08, args); },       // 0x79D40 -> 0xF0270
    // 0x798F0: track picture of race a0 (uis_trpc entries: 1..35 day photos, +36 night photos, +72 night lights overlay).
    // Returns TAID (+36 when the track's TNIT = 1) and writes the overlay entry to *a1 (-1 = none: the screen hides it).
    // (It used to return a field picked by a1 and never wrote *a1, so the overlay element kept entry 0, the PLACEHOLDER
    // picture, and covered the photo on track select.)
    0x09: ({ args, vm }) => {
      const r = q("raceTrack", [null, args[0] | 0]), t = q("trackTA", [null, null, out(r, 0)]), taid = out(t, 0) | 0, night = (out(t, 1) | 0) === 1;
      if (args[1]) vm.mem.w32(args[1] >>> 0, night ? taid + 0x48 : 0xffffffff);
      return night ? taid + 0x24 : taid;
    },
    0x0a: ({ args }) => { const r = q("raceTrack", [null, args[0] | 0]); return out(q("trackLogo", [null, out(r, 0)]), 0); },  // 0x79870
    0x0b: () => state.numPads,                                                 // 0x79960 connected, ready controllers (port table 0x2B700C: bit0 present, +4 state 1)
    0x0d: ({ args, ...c }) => textWidth(str(c, args[0]), 0, args[1] | 0),       // 0x79DB0 -> 0x77330 -> 0x1425A0: width of a string in UI font entry a1
    0x10: ({ args }) => { const a = asF(args[0]), b = asF(args[1]); return asU(a + Math.random() * (b - a)); }, // 0x79D80 random float
    0x11: ({ args, ...c }) => {                                                // 0x795E0 (edi 0) driver name fit to a width
      // args: driver id, string record, UI font entry, width (unsigned). "First Last"; wider than the width ->
      // "F. Last"; still wider -> "Last" (empty first / last name -> the other one). Args 1..3 were taken as width,
      // record, style, so the name went nowhere (9/15 kept its "---------1---------2---------3-" placeholder title).
      const r = q("driverName", [null, null, args[0] | 0]), first = String(out(r, 0, "")), last = String(out(r, 1, ""));
      const font = args[2] | 0, width = args[3] >>> 0;
      const fits = s => (assets?.font(0, font) ? textWidth(s, 0, font) : 0) <= width;
      let s;
      if (!first) s = last; else if (!last) s = first;
      else { s = `${first} ${last}`; if (!fits(s)) { s = `${first[0]}. ${last}`; if (!fits(s)) s = last; } }
      setStr(c, args[1], s); return 0;
    },
    0x17: () => 0,
    0x18: () => 1,                                                             // 0x7A2C0 table 'CGPL' SPTS (default 1)
    0x1e: ({ args, ...c }) => {                                                // 0x79530 hometown "%s, %s" and birthday "%02d/%02d/%02d"
      const r = q("driverBio", [null, null, null, null, null, args[0] | 0]);
      setStr(c, args[1], `${out(r, 0, "")}, ${out(r, 1, "")}`);
      setStr(c, args[2], `${String(out(r, 3)).padStart(2, "0")}/${String(out(r, 2)).padStart(2, "0")}/${String(out(r, 4) % 100).padStart(2, "0")}`);
      return 0;
    },
    0x21: ({ args, ...c }) => str(c, args[0]).length,                          // 0x925E0 strlen
    0x26: () => out(q("sysAutosave", [null]), 0),                              // 0x79480 -> 0x5EFF0 CSYS.ASAV
    0x29: () => 0,                                                             // 0x79450 profile flags
    0x2d: ({ args }) => state.settings[args[0] & 0xff],                        // 0x14740 option get
    0x2e: () => 0,                                                             // 0x79A90 profile name/bio
    0x31: ({ args }) => { state.audio.ef1d0 = args.slice(); return gameAudio(0x31, args); },
    0x33: () => 0xffffffff,                                                    // 0x6ACA0 slot of id (not found)
    0x35: () => state.unlocks.length,                                          // 0x16A80 count of queued unlock notices
    0x40: ({ args, ...c }) => { setStr(c, args[0], `${str(c, args[1])}Press START${str(c, args[2])}`); return 0; }, // 0x7A150 sprintf(a0, "%s%s%s", a1, "Press START", a2)
    0x41: () => { const v = state.video?.(); return v ? (v.ended ? 1 : 0) : state.uiReady; },   // 0x1406C0: the UI video ended / none playing
    0x48: () => 1,                                                             // constant 1 in the retail build (debug UI off)
    0x4d: () => 0,                                                             // 0x79B20 start/stop ambient
    0x51: ({ args }) => { if ((args[0] | 0) === 0) state.busy++; else if (state.busy) state.busy--; return 0; }, // 0x79D00
    0x52: () => 0,
    0x58: () => out(q("numLocalPl", [null]), 0, 1),                            // 0x79810 GINF.NPLL (default 1)
    0x5b: () => state.numPads,                                                 // 0x79800 -> 0x13680
    0x5d: ({ args }) => out(q("raceRLID", [null, args[0] | 0]), 0),            // 0x798C0 RACE.RLID
    0x78: () => 0,                                                             // 0x126CF0 always 0
    0x7a: ({ args }) => { state.audio.ef210 = args[0]; return gameAudio(0x7a, args); },
    0x7b: ({ args }) => { state.audio.ef250 = args.slice(); return gameAudio(0x7b, args); },
    0x7f: ({ args }) => { state.audio.edd30 = args.slice(); return gameAudio(0x7f, args); },
    0x81: () => 0,
    // 0x82 runs in game code: 0x79A40 opens 5/0 (memory unit / profile select) in UI context 6 with 4 args
    // 0x91 (player, string) runs in game code: 0x7A290 -> 0x14750 copies PRFL.PFLN of PRID = player into the string's
    // buffer (the player's profile name: the race weekend's "<name> has a new best lap: ..." box after a session; with
    // the old stub here the text began with a space, which 2/5 takes for no text, and the box came up empty)
    0x92: ({ args, vm }) => { if (args[0]) vm.mem.w32(args[0], 0); return 0; },// 0x7A220
    0xc1: ({ args }) => { state.settings[args[0] & 0xff] = args[1]; return 0; }, // 0x14880 option set
    0xc8: () => 1,                                                             // 0x79E00 online/LAN state machine (idle)
    0xcf: () => { state.counter2f3424++; return 0; },                          // 0xE66F0
    0xd9: () => 0,                                                             // 0xE6790 -> 0x5EC60 count of profiles in use
    0xda: () => 0,                                                             // 0x79DC0 on-screen keyboard result (none)
    0xe8: () => 0,                                                             // 0x79490 profile name
    0xe9: ({ args }) => { state.inputLock = args[0] & 0xff; return 0; },       // 0x79D30 -> 0x76580
    0xf5: () => state.flag21fe24,                                              // 0x79390
  };

  // Ids whose case in the global switch is the shared exit (0x7AE94): no game action, result cell untouched (0).
  if (game) for (const id of GAME_FIRST) delete N[id];
  for (const id of [0x13, 0x14, 0x15, 0x16, 0x1c, 0x28, 0x36, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3f, 0x54, 0x79, 0x85, 0x90, 0xee]) N[id] ??= () => 0;

  // Per-screen handlers (0x78820). Main menu 0/0 (0x8E4E0) and F_Main 0/5 (0x8E240) are game actions that
  // return "handled"; they are logged so a flow driver can act on them.
  const RACE_LENGTHS = [3, 5, 10, 25, 50, 100];                        // percent; index <-> SRLN (0x8C240 / 0x8C500)
  const carSelect = createCarSelect({ sql, state, setStr: (c, rec, v) => setStr(c, rec, v), numPlayers: () => out(q("numPlayers", [null]), 0, 1) });
  const PerScreen = {
    "0/8": carSelect, "0/9": carSelect, "0/10": carSelect,                          // car / driver select (0x8DFE0)
    "0/3": createTrackSelect({ sql, state, setStr }),                                // track / race select (0x8F4E0)
    // Race Now settings (0x8C580). Profile slot = 0x21DB74 (helper 0x146F0).
    "0/13": {
      0x80000002: () => { state.x14920 = 0; return 0; },                              // 0x14920(0)
      0x80000003: ({ args, vm }) => { const r = q("profDiff", [null, state.profile]); if (args[0] && r) vm.mem.w32(args[0], out(r, 0)); return 0; },
      0x80000004: ({ args }) => (args[0] | 0) === 4 ? 1 : 0,                            // difficulty 4 = CUSTOM
      0x80000006: ({ args, ...c }) => {                                                 // 0x8C340: summary of a difficulty
        const diff = args[0] | 0, d = q("diffSettings", [null, null, null, null, null, diff]);
        const [sdif, sdam, spit, sath, syel] = [0, 1, 2, 3, 4].map(i => out(d, i));
        setStr(c, args[1], String(out(q("diffName", [null, diff]), 0, "")));
        setStr(c, args[3], String(out(q("skillName", [null, sdif]), 0, "")).toUpperCase());
        setStr(c, args[2], sath === 2 ? "FULL" : sath === 0 ? "OFF" : "LIMITED");          // driving aids
        setStr(c, args[4], sdam === 1 ? "NORMAL" : sdam === 2 ? "VISUAL ONLY" : "QUICK REPAIR");
        setStr(c, args[5], spit ? "OFF" : "ON");                                       // unlimited tires and fuel
        setStr(c, args[6], syel ? "ON" : "OFF");                                       // yellow flags
        return 0;
      },
      0x80000007: ({ args }) => { q("setProfDiff", [args[0] | 0, state.profile]); return 0; },
      0x80000009: ({ args }) => { const v = RACE_LENGTHS[args[0] | 0]; if (v !== undefined) q("setProfLen", [v, state.profile]); return 0; },
      0x8000000a: ({ args, vm }) => { const i = RACE_LENGTHS.indexOf(out(q("profLen", [null, state.profile]), 0)); if (args[0] && i >= 0) vm.mem.w32(args[0], i); return 0; },
    },
  };

  // Natives with a JavaScript port run here; everything else runs the game's own handler code through the x86
  // interpreter (gamecode.mjs). A screen is either fully ported (its per-screen ids share JS state) or fully run
  // from the game code.
  const gameErrors = new Map();
  const runGame = (what, f) => {
    if (!game) return 0;
    try { const r = f(); return r.handled ? r.value : null; }
    catch (e) { const k = `${what}: ${e.message.split("; call stack")[0]}`; if (!gameErrors.has(k)) log(`game code ${what}: ${e.message}${process.env.NT04_JS_STACKS ? " | " + (e.stack ?? "").split("\n").slice(1, 6).join(" <- ") : ""}`); gameErrors.set(k, (gameErrors.get(k) || 0) + 1); return 0; }
  };
  function call(ctx) {
    const id = ctx.id >>> 0, key = `${ctx.sc.group}/${ctx.sc.screen}`, args = ctx.args.map(a => a >>> 0);
    if (id & 0x80000000) {
      actions.push({ screen: key, id: "0x" + id.toString(16), args });
      const js = process.env.NT04_NO_JS_SCREENS && game ? null : PerScreen[key];
      if (js) { const h = js[id]; return h ? h(ctx) : 0; }
      const v = runGame(`${key} 0x${id.toString(16)}`, () => game.perScreen(ctx.sc.group, ctx.sc.screen, id, args));
      if (!game) missing.set(id, (missing.get(id) || 0) + 1);
      return v ?? 0;
    }
    // like 0x7A6A0: the screen's own handler table (0x78820) gets every id first, the global switch after it (the
    // in-game HUD 10/0 reads position, lap, speed... this way through ids 0x13-0x16, 0x1C, 0x54, 0x85)
    if (game && !process.env.NT04_GLOBAL_ONLY && !(process.env.NT04_NO_JS_SCREENS ? null : PerScreen[key])) {
      const v = runGame(`${key} 0x${id.toString(16)}`, () => game.perScreen(ctx.sc.group, ctx.sc.screen, id, args));
      if (v !== null) { perScreenHits.set(`${key} 0x${id.toString(16)}`, (perScreenHits.get(`${key} 0x${id.toString(16)}`) || 0) + 1); return v; }
    }
    const f = N[id];
    if (f) return f(ctx) ?? 0;
    const v = runGame(`native 0x${id.toString(16)}`, () => game.global(id, args));
    if (!game) missing.set(id, (missing.get(id) || 0) + 1);
    return v ?? 0;
  }
  // What the frontend handed over when it closes its last screen: the race in GINF and each player's car.
  function raceSetup() {
    if (!db) return null;
    const g = sql("select 'DIAR' into \x82 and 'DIRT' into \x82 and 'DOMG' into \x82 from 'FNIG'", [null, null, null])?.outputs ?? [];
    const race = sql("select 'MANR' into \x88 and 'PALR' into \x84 and 'YTSA' into \x80 from 'ECAR' where 'DIAR' = \x82", [null, null, null, g[0]])?.outputs ?? [];
    const track = sql("select 'MNRT' into \x88 from 'KCRT' where 'DIRT' = \x82", [null, g[1]])?.outputs[0];
    const pct = sql("select 'NLRS' into \x82 from \x8c", [null, "LPGC"])?.outputs[0] ?? 100;
    const players = [];
    for (let p = 0; p < 4; p++) {
      const c = sql("select 'DIRC' into \x82 and 'DIRD' into \x82 and 'DMNC' into \x88 from 'SRAC' where 'DILP' = \x82", [null, null, null, p]);
      if (!c?.rows.length) continue;
      const [crid, drid, num] = c.outputs, n = sql(Q.driverName[1], [null, null, drid])?.outputs ?? [];
      players.push({ player: p, car: crid, driver: drid, number: num, name: `${n[0] ?? ""} ${n[1] ?? ""}`.trim() });
    }
    return { raceId: g[0], trackId: g[1], gameMode: g[2], race: race[0], track, laps: race[1], lengthPct: pct, players };
  }
  return { call, state, missing, actions, raceSetup, gameErrors, game, perScreenHits };
}

// Attach to a VM: every native id routes through `call`.
export function installNatives(vm, opts = {}) {
  const log = opts.log ?? (s => vm.log(s));
  // Bridge from the game's UI-manager calls to the VM (the game code believes it talks to its own UI system).
  const at = () => vm.focus ?? vm.screens.at(-1) ?? null;
  const ui = {
    // 0x13C1C0: delivered at once when the UI is idle (the game passes pointers to strings on its stack, e.g. the
    // grid intro 3/10's qualifying times), queued when called from inside a script or dispatch. Messages still
    // queued are run first: the game opens a screen and notifies it at once (after the race: open replay 3/3, activate,
    // event 30 = first reel's info, whose handler unlocks the screen's input); delivered before the queued open, the
    // event found no 3/3 and the replay screen ignored the pad until the next reel's event 30. So the queue is run
    // first (args stay valid: they can point into the caller's stack)
    notify: (ev, args, ctx = 0) => { if (!vm.idle) return vm.post(9, at(), { event: (ev << 16) >> 16, ctx }, args); if (vm.queue.length) vm.pump(); return vm.notify((ev << 16) >> 16, args, ctx); },
    open: (id, args, ctx = 0) => vm.post(0, at(), { screen: id, ctx }, args),
    close: id => vm.post(1, at(), { screen: id, result: 0 }),
    activate: id => vm.post(3, at(), { screen: id }),
    closeContext: ctx => { for (const sc of [...vm.screens]) if ((sc.ctx ?? 0) === ctx) vm.post(1, at(), { screen: (sc.group | (sc.screen << 16)) >>> 0, result: 0 }); },
    focus: () => vm.focus ? (vm.focus.group | (vm.focus.screen << 16)) >>> 0 : 0xffffffff,
    textWidth: (s, entry) => { const f = opts.assets?.font(0, entry); if (!f) return s.length * 10; let w = 0; for (const ch of s) w += (f.glyphs.get(ch.charCodeAt(0)) ?? f.glyphs.get(0xb5))?.adv ?? 0; return w; },
  };
  const game = opts.exePath && existsSync(opts.exePath) ? new GameCode(vm.mem, { exePath: opts.exePath, db: opts.db, log, ui, dataDir: opts.dataDir, saveDir: opts.saveDir, config: opts.config, flow: !!opts.flow, seed: opts.seed ?? null }) : null;
  const n = createNatives({ ...opts, log, game });
  vm.nativeHandler = n.call; n.state.video = () => vm.video;
  if (game) {
    // sound objects (type 1: method 0 plays the UI sound id in args[0], 0x9AC30 -> 0xCC240) and audio objects
    // (type 4: music / EA Trax tracks 2..0x33 and 0x34, loaded on -1, started on -2 = screen open, stopped on -3 =
    // close) run the game's own handlers
    vm.handlers[1] = (v, sc, obj, msg, args) => game.uiObject(0x9ac40, obj, msg, args);
    vm.handlers[4] = (v, sc, obj, msg, args) => game.uiObject(0x9ab70, obj, msg, args);
    // front-end car preview (default; NT04_PREVIEW=0: off): car objects (type 2, UISCarObj: the 3D car preview on the car / driver screens) run
    // the game's handler 0x9A900; gamecode sends them the per-frame render message -2 inside the front-end frame
    if (game?.preview) {
      vm.handlers[2] = (v, sc, obj, msg, args) => game.uiObject(0x9a900, obj, msg, args);
      // the visible car objects with the chain of state headers above them (root first), walked as the UI manager's
      // render 0x1398C0 does: a state counts when header+0 is set, a child group when the word it points at is set
      game.previewObjects = () => {
        const out = [], m = game.mem, ptr = (sc, v) => (v >>> 0) < sc.base ? sc.base + v : v >>> 0;
        for (const sc of vm.screens) {
          const walk = (idx, chain, depth) => {
            const st = sc.layout.states[idx]; if (!st || depth > 32) return;
            const h = sc.base + st.header; if (!m.r32(h)) return;
            const ch = [...chain, h];
            for (const c of st.children) {
              if (!m.r32(ptr(sc, m.r32(sc.base + c.offset)))) continue;
              for (const it of c.items) {
                if (it.type === -1) walk(it.state, ch, depth + 1);
                else if (it.type === 2) out.push({ obj: sc.base + it.data, chain: ch, handler: 0x9a900 });
                // 3D objects of type 4 ({ u16 7, u16 id }: 1 the US map's flag, 2..0x33 the EA Trax jukebox model,
                // 0x34 another model; 0 = none): drawn by 0x9AB70 on -2 like the car objects
                else if (it.type === 4) { const o = sc.base + it.data, id = m.r16(o + 2); if (m.r16(o) === 7 && id >= 1 && id <= 0x34) out.push({ obj: o, chain: ch, handler: 0x9ab70 }); }
              }
            }
          };
          walk(0, [], 0);
        }
        return out;
      };
    }
    vm.lifecycleTypes = new Set([4]);
    // -2 is the UI manager's per-frame render message (0x13AA60 -> 0x1398C0), not a one-time "open": with the preview
    // on, gamecode sends it to the 3D objects every frame (previewObjects); the open-time one would draw outside the frame
    if (game?.preview) vm.lifecycleSkip = (type, msg) => type === 4 && msg === -2;
  }
  if (game) { installHelp(vm, game); let frame = 0;
    vm.onFrame = dt => { game.tick(dt); frame++;
      // pad changes -> UI messages for the screens (xinput-hle.mjs Pads.uiEvents); presses from code (vm.press) as before
      if (game.pads) for (const [msg, port, value] of game.pads.uiEvents(frame, game.mem)) {
        const t = game.uiInputTarget?.();
        if (t?.all) vm.press(msg, port, { value, all: true, ctx: t.ctx }); else vm.press(msg, port, { value }); } }; }
  return n;
}

// X = help (input loop 0x75F89, UI contexts 0/1/6/8): pressing X (value 1.0) while help is allowed ([0x2B7934], set
// by frontend init 0x75960 and cleared by the help screen while it is up) finds the focused screen's string table
// (0x13AB90: first type-3 screen object), leaves it in 0x2B7930 for the help screen (read via 0x76150), opens 2/0
// with the controller as argument, activates it and sets 0x2B7935. While 0x2B7935 is set only message 8 reaches
// the screens; help 2/0 closes on the X release (value 0.0) from the same controller.
const HELP_ALLOWED = 0x2B7934, HELP_UP = 0x2B7935, HELP_TABLE = 0x2B7930;
function installHelp(vm, game) {
  const m = vm.mem; m.w8(HELP_ALLOWED, 1);
  const press = vm.press.bind(vm);
  vm.press = (msg, controller = 0, o = {}) => {
    const value = o.value ?? 1;
    // message 11 (quick save on the help bar 2/1) goes to every screen of the focused context first, unless the
    // busy counter 0x2F3424 is up (0x7607F; 0xE6720)
    if (msg === 11 && !m.r8(HELP_UP)) { if (!m.r8(0x2f3424)) press(msg, controller, { ...o, all: true, ctx: vm.focus?.ctx ?? 0 }); return; }
    if (msg === 8) {
      const f = vm.focus;
      if (value === 1 && m.r8(HELP_ALLOWED) && f && vm.active(f, 0)) {
        const table = screenObject(vm, f, 3);
        m.w32(HELP_TABLE, table);
        if (table) {
          const id = 2;                                 // group 2, screen 0
          vm.post(0, f, { screen: id }, [controller]); vm.post(3, f, { screen: id }); vm.pump();
          m.w8(HELP_UP, 1);
        }
      } else m.w8(HELP_UP, 0);
    } else if (m.r8(HELP_UP)) return;
    press(msg, controller, o);
  };
}
// 0x13AB90(mgr, group, screen, type): address of the screen's first screen-level object of `type`
function screenObject(vm, sc, type) {
  const d = sc.data, n = d.readUInt32LE(24), tab = d.readUInt32LE(28) - sc.base;
  for (let i = 0; i < n; i++) {
    const e = tab + i * 8;
    if (d.readUInt16LE(e) === type) { const p = d.readUInt32LE(e + 4); return p ? (sc.base + vm.mem.r32(p)) >>> 0 : 0; }
  }
  return 0;
}
