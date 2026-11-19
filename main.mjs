#!/usr/bin/env node
// main.mjs — play NASCAR Thunder 2004 (Node port) in a browser window.
//
// Boots the game (the game's own flow: title, menus, race weekend, race), runs it as close to real time as the
// emulator manages, and serves a live page on localhost: the game's 3D frames are drawn by the browser's GPU
// (WebGL2, play-client.js; the emulator records the draw calls, gl-remote.mjs), the menus / HUD (UI VM) are drawn
// here and laid over them. Keyboard and gamepads in the page drive the virtual Xbox controller (xinput-hle.mjs);
// the key mapping is editable in the page.
//
// usage: node main.mjs [Data folder] [--port 8854] [--boot flow|menu|title] [--net-host | --net-join address-or-race-id] [--net-relay relay[:port]] [--net-name n] [--net-port 27104]
//   Data folder defaults to ./Data next to this script.
// Default keys (page): arrows / WASD = throttle, brake, steering (and menu up/down/left/right), Enter/Space = A,
//   Esc/Backspace = B, X, Y, Q = white, E = black, P = START, Tab = BACK, IJKL = d-pad, numpad = right stick,
//   F2 = hide/show the UI layer, M = mute (volume slider under the picture). Controllers: the first gamepad is
//   player 1 together with the keyboard, further ones players 2-4 (play-client.js); the game's rumble is sent back. Sound: the game's DirectSound output is mixed here (audio-mix.mjs) and streamed as PCM;
//   the page plays it with Web Audio (it starts after the first key press or click: browsers block autoplay).
// Terminal: arrows / Enter / Esc / S = menu presses, P = screenshot of the UI layer, Q / Ctrl+C = quit.

import "./v8-tuning.mjs";                       // first: V8 tier-up settings before any game code runs
import { Worker } from "node:worker_threads";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openScreen } from "./uis-run.mjs";
import { formatSession } from "./qualifying.mjs";
import { formatReport } from "./silly-season.mjs";
import { Canvas, renderScreen, W, H } from "./uis-render.mjs";
import { RemoteRenderer } from "./gl-remote.mjs";
import os from "node:os";
import { UIRecorder } from "./ui-remote.mjs";
import { toInt16 } from "./audio-mix.mjs";
import { BUTTON } from "./xinput-hle.mjs";
import { RaceBot } from "./race-bot.mjs";
import { createRaceHud } from "./race-hud.mjs";
import { readTerfEntry } from "./terf.mjs";
import * as fsMod from "node:fs";
import { createHash } from "node:crypto";
import { NetPlay, NET_DEFAULT_PORT } from "./netplay.mjs";
// the page script's version: a page that reconnects after the server restarted with a newer play-client.js reloads itself
const clientVersion = () => createHash("sha1").update(readFileSync(join(here, "play-client.js"))).digest("hex").slice(0, 12);

const PAD = { A: 0, UP: 2, DOWN: 3, LEFT: 4, RIGHT: 5, B: 6, START: 7, X: 8, Y: 9, BLACK: 10, WHITE: 11 };
const TERM_KEYS = { "\x1b[A": PAD.UP, "\x1b[B": PAD.DOWN, "\x1b[D": PAD.LEFT, "\x1b[C": PAD.RIGHT, "\r": PAD.A, "\n": PAD.A,
  "\x1b": PAD.B, "\x7f": PAD.B, "\b": PAD.B, x: PAD.X, y: PAD.Y, w: PAD.WHITE, k: PAD.BLACK, s: PAD.START, " ": PAD.START };

// ---------------------------------------------------------------- options
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const here = dirname(fileURLToPath(import.meta.url));
const dataDir = resolve(argv.find((a, i) => !a.startsWith("--") && !["--port", "--boot", "--net-host", "--net-join", "--net-name", "--net-port", "--net-relay"].includes(argv[i - 1])) ?? join(here, "Data"));
const port = Number(opt("--port", 8854)), bootAsked = opt("--boot", "flow");
// "title" / "menu" run the game flow too (the screens' JS stand-ins of a direct boot cannot start a race: picking a
// track there ended the frontend), skipping the intro movies, and for "menu" pressing START at the title screen
const boot = process.env.NT04_DIRECT_BOOT ? bootAsked : "flow", skipTo = boot === "flow" && bootAsked !== "flow" ? bootAsked : null;
if (!existsSync(join(dataDir, "UIS_ALL.DAT"))) { console.error(`No game data in ${dataDir} (expected UIS_ALL.DAT). Pass the Data folder.`); process.exit(1); }

// ---------------------------------------------------------------- boot
// the game flow runs the game's own screen code (the JS stand-ins for some screens end the frontend before a race)
if (boot === "flow" && process.env.NT04_NO_JS_SCREENS === undefined) process.env.NT04_NO_JS_SCREENS = "1";
const [group, screen, args] = boot === "flow" ? ["flow", 0, []] : boot === "title" ? [0, 2, []] : [0, 5, [101]];
// the game's random numbers (intro clip, ...) seeded from the clock like the console's rdtsc; NT04_SEED=n repeats a run
const seed = process.env.NT04_SEED ? Number(process.env.NT04_SEED) >>> 0 : (Date.now() ^ (Math.random() * 2 ** 32)) >>> 0;
const game = openScreen(dataDir, group, screen, { args, time: 0, seed });
const vm = game.vm, g = game.game?.game ?? null;
// online racing (netplay.mjs): --net-host (listen on --net-port, default 27104) or --net-join <address[:port]>,
// --net-name <name>; the same from NT04_NET_HOST=1 / NT04_NET_JOIN / NT04_NET_NAME / NT04_NET_PORT
const netPort = Number(opt("--net-port", process.env.NT04_NET_PORT ?? NET_DEFAULT_PORT)), netJoin = opt("--net-join", process.env.NT04_NET_JOIN);
const netRelay = opt("--net-relay", process.env.NT04_NET_RELAY);   // through a relay (relay.mjs): no port forwarding; --net-join then takes the race id
const netHost = argv.includes("--net-host") || process.env.NT04_NET_HOST === "1", netName = opt("--net-name", process.env.NT04_NET_NAME ?? os.userInfo().username ?? "Player");
let online = null;
if (g && (netHost || netJoin)) {
  online = new NetPlay(g, { name: netName, vm });
  if (netHost && netRelay) {
    const tryHost = (k = 0) => online.hostVia(netRelay).then(id => console.log(`online: hosting race ${id} on the relay ${netRelay}; others pick it from the relay's list`))
      .catch(e => { if (k % 10 === 0) console.log(`online: ${e.message}; retrying`); setTimeout(() => tryHost(k + 1), 3000); });
    online.onDisconnect = () => { console.log("online: lost the relay; reconnecting (joiners rejoin the new race id)"); online.players.clear(); online.players.set(0, online.player(0, online.name)); online.clients.clear(); setTimeout(() => tryHost(1), 3000); };
    tryHost();
  } else if (netHost) online.host({ port: netPort }).then(p => console.log(`online: hosting a race on port ${p}; others join with this computer's address`)).catch(e => console.log(`online: could not host on port ${netPort}: ${e.message}`));
  else {
    // keep trying while the host starts up (it may still be booting), then on every drop
    const tryJoin = (k = 0) => online.join(netJoin, { port: netPort, relay: netRelay }).then(id => console.log(`online: joined ${netJoin} as player ${id}`))
      .catch(e => { if (/full|version/.test(e.message)) { console.log(`online: ${e.message}`); return; } if (k % 10 === 0) console.log(`online: ${e.message}; retrying`); setTimeout(() => tryJoin(k + 1), 3000); });
    online.onDisconnect = () => { console.log("online: lost the host; reconnecting"); setTimeout(() => tryJoin(1), 3000); };
    tryJoin();
  }
}
if (g) g.onSillySeason = r => console.log(`silly season ${r.year}: ${r.events.length} change(s); see /silly-season`);
if (g) g.onQualifying = s => console.log(`qualifying: ${s.entrants} entrants, ${s.starters.length} start; DNQ: ${s.results.filter(r => r.dnq).map(r => r.name).join(", ") || "none"}`);
// the 3D stream's packing runs on its own thread when there are cores to spare (on a 2-core machine the extra thread
// competes with the emulator and was slower); NT04_GL_WORKER=1 / 0 forces it
const glWorker = process.env.NT04_GL_WORKER ? process.env.NT04_GL_WORKER === "1" : os.availableParallelism() >= 4;
const remote = g ? new RemoteRenderer(g, { worker: glWorker }) : null;
if (g && remote) { if (g.d3d?.width) remote.init({ width: g.d3d.width, height: g.d3d.height }); g.renderer = remote; if (g.d3d) g.d3d.r = remote; }
console.log(`NASCAR Thunder 2004 (Node) — booted ${group === "flow" ? "the game flow" : `screen ${group}/${screen}`} from ${dataDir}`);
{ const W = g?.cpu?.wasm, R = W?.recomp;   // which build of the game's code runs (recomp-native-*.node, recomp.wasm, or the interpreter alone)
  console.log(`game code: ${R?.native ? `native build (recomp-native-${process.platform}-${process.arch}.node), ${R.man.functions.length} functions` : R ? `WebAssembly (recomp.wasm), ${R.man.functions.length} functions` : "interpreter only (no recompiled code loaded)"}${W?.nativeError ? `; native build not used: ${W.nativeError}` : ""}`); }

// ---------------------------------------------------------------- real-time loop
// One UI frame (1/60 s of game time, with the game's own frame inside) per step; steps run back to back while
// behind (the emulator is slower than real time in races) and wait while ahead. Between steps the event loop
// serves the page (frames out, input in).
const pending = [];
let next = performance.now(), frames = 0, emuFps = 0, fpsT = next, uiCount = 0, stepMax = 0;
// NT04_AUTORACE=1 (testing): the race-weekend menu presses of the scripted tests, in game time, then the race bot
// drives; the page shows the race as a player would see it (live frame rate, sound)
function* autoRace() {
  const neutral = { buttons: 0, analog: [0, 0, 0, 0, 0, 0, 0, 0] }, A = { buttons: 0, analog: [255, 0, 0, 0, 0, 0, 0, 0] };
  const wait = function* (ms) { for (let i = Math.ceil(ms / vm.frameMs); i > 0; i--) yield; };
  const tap = function* (st, after = 2350) { g.pads.set(0, st); yield* wait(150); g.pads.set(0, neutral); yield* wait(after); };
  if (process.env.NT04_AUTORACE === "lightning") {    // (Lightning Challenge test: the first challenge, a forced win, back to the list)
    const at = (gr, sc) => vm.screens.some(x => x.group === gr && x.screen === sc), D = { buttons: BUTTON.DOWN }, U = { buttons: BUTTON.UP };
    for (let k = 0; k < 240 && !at(0, 0); k++) { yield* wait(1000); if (at(6, 0) && !at(0, 0)) yield* tap(A, 3000); }
    console.log("autorace: main menu");
    for (const st of [D, A, D, A, A, A, A]) yield* tap(st, 3000);
    g.hooks.set(0x9c6c0, () => 1); const bot = new RaceBot(g, { speed: 330 }); console.log("autorace: lightning, win forced");
    for (let k = 0; k < 600 * 60 && !at(3, 16); k++) { bot.drive(); yield; }
    yield* wait(3000); for (const st of [A, U, A]) yield* tap(st, 4000);
    for (let k = 0; k < 60 && !at(13, 0); k++) yield* wait(1000);
    yield* wait(3000); console.log("autorace: CHRS", JSON.stringify(g.db.tables.get("CHRS")?.rows)); return;
  }
  if (process.env.NT04_PIT_SETTING !== undefined) for (const r of g.db.tables.get("SGPP")?.rows ?? []) r.SPIT = +process.env.NT04_PIT_SETTING;   // (testing: tires and fuel used)
  for (const st of [{ buttons: BUTTON.START }, A, A, A, { buttons: BUTTON.DOWN }, A, A, A]) yield* tap(st);
  yield* wait(20000); yield* tap({ buttons: BUTTON.START }, 3000); yield* tap(A, 3000); yield* tap(A, 3000);
  for (let k = 0; k < 20 && !vm.screens.some(x => x.group === 3 && x.screen === 10); k++) yield* wait(500);
  yield* wait(4000); g.pads.set(0, A); yield* wait(150); g.pads.set(0, neutral);
  const bot = new RaceBot(g, { speed: 330 }); console.log("autorace: bot driving");
  if (process.env.NT04_AUTORACE === "burn") {          // (smoke test: past the pace laps, then a spin and a burnout)
    for (let i = Math.ceil(30000 / vm.frameMs); i > 0; i--) { bot.drive(); yield; }
    console.log("autorace: spin"); for (let i = Math.ceil(2500 / vm.frameMs); i > 0; i--) { g.pads.set(0, { buttons: 0, analog: [0, 0, 0, 0, 0, 0, 0, 255], lx: 32767, ly: 0 }); yield; }
    console.log("autorace: burnout"); for (;;) { g.pads.set(0, { buttons: 0, analog: [0, 0, 0, 0, 0, 0, 255, 255], lx: 0, ly: 0 }); yield; }
  }
  // (NT04_LOG_FUEL=1, testing: player 0's fuel every 5 s - the HUD's 0x70A80 shows (1 - [[rec+0x18]+0x2C]) * [[rec+8]+0x44] gallons)
  const F = a => new Float32Array(new Uint32Array([g.mem.r32(a)]).buffer)[0];
  for (let f = 0; ; f++) { bot.drive(); if (process.env.NT04_LOG_FUEL && f % 300 === 0) { const R = 0x2951e0, u = g.mem.r32(R + 0x18), cap = g.mem.r32(R + 8), st = bot.state(); console.log(`fuel used ${u ? F(u + 0x2c).toFixed(4) : '-'} of ${cap ? F(cap + 0x44).toFixed(1) : '-'} gal, speed ${st.speed.toFixed(1)} laps ${st.laps} state ${st.raceState}`); }; yield; }
}
// NT04_AUTOPREVIEW=1 (testing): the presses to the driver select screen (Race Now), in game time, then nothing
function* autoPreview() {
  const neutral = { buttons: 0, analog: [0, 0, 0, 0, 0, 0, 0, 0] }, A = { buttons: 0, analog: [255, 0, 0, 0, 0, 0, 0, 0] };
  const wait = function* (ms) { for (let i = Math.ceil(ms / vm.frameMs); i > 0; i--) yield; };
  for (const st of [{ buttons: BUTTON.START }, A, A, A, { buttons: BUTTON.DOWN }, A]) { g.pads.set(0, st); yield* wait(150); g.pads.set(0, neutral); yield* wait(2350); }
  console.log("autopreview: at driver select");
}
// NT04_AUTOKEYS=START,A,DOWN,A,... (testing): those presses 2.5 s apart in game time, then nothing
function* autoKeys(list) {
  const neutral = { buttons: 0, analog: [0, 0, 0, 0, 0, 0, 0, 0] }, wait = function* (ms) { for (let i = Math.ceil(ms / vm.frameMs); i > 0; i--) yield; };
  const pad = k => k in BUTTON ? { buttons: BUTTON[k], analog: [0, 0, 0, 0, 0, 0, 0, 0] } : { buttons: 0, analog: [0, 1, 2, 3].map(i => "ABXY"[i] === k ? 255 : 0).concat([0, 0, 0, 0]) };
  for (const k of list) { g.pads.set(0, pad(k)); yield* wait(150); g.pads.set(0, neutral); yield* wait(2350); }
  console.log("autokeys: done");
}
// NT04_AUTOPRESS=7,0,3,... (testing): UI messages (0 A, 2 up, 3 down, 6 B, 7 START) straight to the UI VM, 2.5 s apart
// --boot title / menu: the intro movies are skipped; "menu" presses START once the title screen (0/2) is up
let skipping = !!skipTo;
function* skipIntro() {
  const neutral = { buttons: 0, analog: [0, 0, 0, 0, 0, 0, 0, 0] }, wait = function* (ms) { for (let i = Math.ceil(ms / vm.frameMs); i > 0; i--) yield; };
  for (let k = 0; k < 120 * 60 && !vm.screens.some(x => x.group === 0 && x.screen === 2); k++) yield;
  skipping = false; if (skipTo !== "menu" || !g?.pads) return;
  yield* wait(1500); g.pads.set(0, { buttons: BUTTON.START, analog: [0, 0, 0, 0, 0, 0, 0, 0] }); yield* wait(150); g.pads.set(0, neutral);
  console.log("boot: skipped to the main menu");
}
function* autoPress(list) { for (const k of list) { vm.press(k, 0); for (let i = Math.ceil(2500 / vm.frameMs); i > 0; i--) yield; } console.log("autopress: done"); }
const auto = process.env.NT04_AUTOPRESS ? autoPress(process.env.NT04_AUTOPRESS.split(",").map(Number)) : process.env.NT04_AUTORACE && g?.pads ? autoRace() : process.env.NT04_AUTOPREVIEW && g?.pads ? autoPreview() : process.env.NT04_AUTOKEYS && g?.pads ? autoKeys(process.env.NT04_AUTOKEYS.split(",")) : null;
const skipper = skipTo ? skipIntro() : null;
// Movies (gamecode movieQueue, filled by PlayMovie): the game waits while the page plays the queued clips; nothing is
// played (and the game does not wait) when no page is connected after one has been, or with NT04_NO_MOVIES=1. Before
// the first page connects the boot movies wait for it.
let movie = null, everConnected = false;
function movieGate() {
  const q = g?.movieQueue; if (!q?.length) return false;
  if (process.env.NT04_NO_MOVIES || skipping || (!client && everConnected)) { q.length = 0; movie = null; return false; }
  if (!client) return true;                                             // boot: wait for the page
  if (!movie) { movie = { ...q[0], id: (movieId = (movieId + 1) | 0), sent: performance.now() }; client.send(JSON.stringify({ t: "movie", ...movie })); }
  else if (performance.now() - movie.sent > 15 * 60_000) movieEnded(movie.id, 0);   // never hang on a page that did not answer
  return true;
}
let movieId = 0;
function movieEnded(id, reason) {
  if (!movie || movie.id !== id || !g) return;
  g.movieResult = reason; g.movieQueue.shift(); movie = null;
  if (reason === 2) g.movieQueue.length = 0;                            // backed out of a run of clips
}
function movieEntry(file, index) {
  const path = g?.findFile?.(file); if (!path) return null;
  try { return readTerfEntry(fsMod, path, index); } catch { return null; }
}
function step() {
  if (movieGate()) return;
  if (g) { g.liveClock = !!client; g.liveMark = performance.now() + 33; g.stepNo = (g.stepNo ?? 0) + 1; remote?.stepBegin(); }   // (game time through long calls: gamecode liveClock)
  while (pending.length) { const { m, value } = pending.shift(); vm.press(m, 0, { value }); }
  auto?.next(); skipper?.next();
  // a frame takes as many 60 Hz periods as the vertical blanks the game waited for in the one before (Swap +
  // BlockUntilVerticalBlank: the demo race, victory lane and the race weekend's menus wait for two, i.e. run at 30 fps
  // on the Xbox; run at 60 they played at double speed); game time moves on by the same
  // The replay screen (3/3) is one of those, but it plays the race back by the clock, not by frames, so it runs at 60:
  // its second wait passes without a vblank (d3d oneWait). Measured on a replay reel: the cars move in the same share
  // of frames (548 / 600) and as far per second at either rate, so 60 fps is twice the pictures at the same speed.
  // NT04_REPLAY60=0 keeps the original 30 fps.
  if (g?.d3d) g.d3d.oneWait = process.env.NT04_REPLAY60 !== "0" && vm.screens.some(x => x.group === 3 && x.screen === 3);
  const w = g?.d3d ? g.d3d.waits - (step.waits0 ?? g.d3d.waits) : 1; step.periods = Math.min(4, Math.max(1, w)); if (g?.d3d) step.waits0 = g.d3d.waits;
  vm.frame(step.periods * vm.frameMs); frames += step.periods;   // (the status line's game fps: 60 = real time)
  if (g?.dsound) audioParts.push(g.dsound.drainAudio());
  if (client && (++uiCount % 2 === 0 || step.periods > 1)) sendUI();   // (every frame at 30 fps)
  if (client) sendAudio();   // sound every frame (~17 ms of it): the page's player can keep a shorter buffer
  if (client && g?.pads) sendRumble();
  if (client && hud && frames % 2 === 0) sendRace();   // (line crossings timed to 33 ms; a message goes out every ~450 ms)
  else if (!client && audioParts.length > 4) audioParts.length = 0;
}
// controller rumble the game set (XInputSetState, kept per pad by xinput-hle.mjs) -> the page's gamepads
const rumbleSent = ["0,0", "0,0", "0,0", "0,0"];
function sendRumble() {
  g.pads.pads.forEach((p, port) => { const k = `${p.rumble.left},${p.rumble.right}`; if (k !== rumbleSent[port]) { rumbleSent[port] = k; client.send(JSON.stringify({ t: "rumble", port, left: p.rumble.left, right: p.rumble.right })); } });
}
// mixed game audio since the last send: u32 "IAUD", u32 rate, u32 game speed x1000 (informational: the page's player
// stretches the sound in time by its own buffer fill when the emulator runs behind real time), u32 frames, then
// 16-bit stereo PCM
const audioParts = [];
function sendAudio() {
  if (!audioParts.length) return;
  const n = audioParts.reduce((k, p) => k + p.length, 0), f = new Float32Array(n); let k = 0; for (const p of audioParts) { f.set(p, k); k += p.length; }
  audioParts.length = 0; if (!n) return;
  const pcm = toInt16(f), out = Buffer.alloc(16 + pcm.byteLength);
  out.writeUInt32LE(0x44554149, 0); out.writeUInt32LE(g.dsound.audio.rate ?? 48000, 4); out.writeUInt32LE(Math.round(Math.min(1, Math.max(0.3, emuFps / 60 || 1)) * 1000), 8);
  out.writeUInt32LE(n / 2, 12); Buffer.from(pcm.buffer).copy(out, 16); client.send(out);
}
function loop() {
  const now = performance.now();
  if (now >= next) {
    // behind real time: run frames back to back to catch up (menu frames are cheap, and the game's sound stays
    // continuous); only a lag of over a second (slow races, long loads) is given up
    const s0 = performance.now(); step(); const sd = performance.now() - s0; if (sd > stepMax) stepMax = sd; next += (step.periods ?? 1) * vm.frameMs; if (now - next > 1000) next = now; prefetched = false;   // (a frame may queue new code)
    // a long frame in live play already moved game time on with real time (gamecode liveClock): no catching up after
    // it (the frames after a race load ran back to back at ~90 fps and reached the page in bursts)
    if (g?.liveClock && sd > 50) next = performance.now() + vm.frameMs;
    if (now - fpsT >= 1000) { emuFps = Math.round(frames * 1000 / (now - fpsT)); frames = 0; fpsT = now; sendInfo(); }
    setImmediate(loop);
  } else if (!prefetched && g?.prefetchCode && next - now > 2) {
    // ahead of real time (menus need ~2 ms of the 16.7): load a chunk of the compiled-code cache and translate queued
    // WebAssembly blocks now rather than in the middle of a frame later (pressing START on the title reaches a lot
    // of new code at once)
    prefetched = !g.prefetchCode(Math.min(4, next - now - 1)); setImmediate(loop);
  } else setTimeout(loop, Math.max(0, next - now - 1));
}
let prefetched = false;
setImmediate(loop);

// ---------------------------------------------------------------- UI layer (menus, HUD) over the 3D picture
const ui = new UIRecorder();
function uiCanvas(transparent) {
  const canvas = new Canvas(W, H, { transparent });
  for (const sc of vm.screens) if (!vm.drawn || vm.drawn(sc)) renderScreen(sc.data, game.assets, canvas, { layout: sc.layout, mem: vm.mem, base: sc.base, video: vm.video });
  return canvas;
}
if (remote) remote.beforeUrgent = () => { if (client) sendUI(); };
// the game's sound during a long call (a race loading), sent every 50 ms as it is mixed: it used to arrive as one
// block of up to 2 s when the call ended, which the page's player then had to squeeze in
if (g) g.onLiveTick = () => { if (!client || !g.dsound) return; audioParts.push(g.dsound.drainAudio()); sendAudio(); };
// the live leaderboard / points standings (race-hud.mjs) on game time (frames x frame length), so gaps stay right when
// the emulator runs behind real time
const hud = g?.mem && g?.db ? createRaceHud(g) : null;
function sendRace() { let m = null; try { m = hud.sample(g.stepNo * vm.frameMs); } catch (e) { if (!sendRace.warned) { sendRace.warned = true; console.log("race hud:", e.message); } } if (m) client.send(JSON.stringify(m)); }
function sendUI() { const msg = ui.frame(vm, game.assets); if (msg) client.send(msg); }
function sendInfo() {
  if (!client) return;
  // diagnostics: frames sent / not captured because the page had not acknowledged earlier ones, acknowledgement time,
  // the slowest emulator frame of the second
  const q = remote?.takeDiag?.(), dg = q ? `  |  sent ${q.sent} skipped ${q.noCredit}  |  ack ${q.ackN ? (q.ackSum / q.ackN).toFixed(0) : "-"}/${q.ackMax.toFixed(0)} ms  |  emu max ${stepMax.toFixed(0)} ms` : ""; stepMax = 0;
  const ni = online?.info(), nt = ni ? `  |  online ${ni.role}: ${ni.players.map(p => `${p.name} ${p.car}${p.id === ni.id ? " (you)" : `${p.rtt != null ? ` ${p.rtt} ms` : ""}${p.receiving ? "" : ` (${p.phase})`}`}`).join(", ")}${ni.waiting ? `  |  start waits for ${ni.waiting}` : ""}${ni.warnings.length ? `  |  ${ni.warnings[ni.warnings.length - 1]}` : ""}` : "";
  const text = (vm.screens.length ? `game ${emuFps} fps (60 = real time)  |  screens ${vm.screens.map(s => s.group + "/" + s.screen).join(" ")}` : "no screens") + dg;
  client.send(JSON.stringify({ t: "info", text: text + nt }));
}

// ---------------------------------------------------------------- page, client script, live connection
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>NASCAR Thunder 2004</title>
<style>html,body{margin:0;height:100%;background:#000;color:#aaa;font:13px system-ui,sans-serif}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px}
#view{width:min(100vw,calc((100vh - 60px)*${W}/${H}));aspect-ratio:${W}/${H};background:#111}
details{max-width:900px;width:100%} textarea{width:100%;height:220px;background:#111;color:#ccc;font:12px monospace}
#bar{display:flex;gap:16px;flex-wrap:wrap;justify-content:center}</style></head><body>
<canvas id="view" width="${W * 2}" height="${H * 2}"></canvas>
<div id="bar"><span>Arrows/WASD: drive &amp; menus | Enter: A | Esc: B | P: START | F2: UI layer | F3: 4:3 stretched / wide | F4: leaderboard (F6: points / season) | M: mute</span>
<label>Volume <input id="volume" type="range" min="0" max="100" value="70"></label><span id="status">connecting…</span></div>
<div id="pads" style="font-size:12px;color:#888">no controller (press a button on it to connect)</div>
<details id="gfx"><summary>Graphics (saved in this browser)</summary>
<p><label>Antialiasing <select id="gfxAA"><option value="0">Off</option><option value="2">MSAA 2x</option><option value="4">MSAA 4x</option><option value="8">MSAA 8x</option></select></label>
<label>Render scale <select id="gfxScale"><option value="1">1x (640 x 480)</option><option value="2">2x (1280 x 960)</option><option value="3">3x (1920 x 1440)</option><option value="4">4x (2560 x 1920)</option></select></label>
<label>Texture filtering <select id="gfxAF"><option value="0">Off (as before)</option><option value="1">Trilinear</option><option value="2">Anisotropic 2x</option><option value="4">Anisotropic 4x</option><option value="8">Anisotropic 8x</option><option value="16">Anisotropic 16x</option></select></label></p>
<p id="gfxNote" style="font-size:12px;color:#888"></p></details>
<details id="wheel"><summary>Steering wheel (saved in this browser)</summary>
<p><select id="wheelDev"></select> <label><input id="wheelOn" type="checkbox"> use as a wheel</label> <button id="wheelForget">forget</button></p>
<p>Set up: <button id="wheelSteer">steering</button> <button id="wheelThrottle">throttle</button> <button id="wheelBrake">brake</button> <button id="wheelHat">d-pad hat</button>
<label><input id="wheelInv" type="checkbox"> invert steering</label></p>
<p>Buttons: <span id="wheelBtns"></span></p>
<p><label>Full lock at <input id="wheelLock" type="range" min="10" max="100" value="50"> <span id="wheelLockV">50%</span> of the wheel's rotation</label>
<label>curve <input id="wheelGamma" type="number" min="0.5" max="3" step="0.1" value="1" style="width:50px"></label>
<label>centre dead zone % <input id="wheelDz" type="number" min="0" max="20" step="0.5" value="1" style="width:50px"></label></p>
<p id="wheelNote" style="color:#cc8"></p><p id="wheelMap" style="font-size:12px"></p><pre id="wheelLive" style="font-size:11px;color:#888;white-space:pre-wrap"></pre></details>
<details><summary>Controls (key -> pad inputs, saved in this browser)</summary>
<p>Pad inputs: <span id="controls"></span>. Keys are KeyboardEvent.code names.</p>
<textarea id="keys" spellcheck="false"></textarea><button id="keysSave">Save</button> <button id="keysReset">Defaults</button></details>
<script src="/play-client.js"></script></body></html>`;

// The HTTP server and the page's WebSocket live on a thread of their own (net-worker.mjs): a long game call (a race
// loading in one frame) can then still get its frames to the page as they are made. Requests come here to be answered.
let client = null;
// Capture viewer (/replay): the files F9 saved (play-client.js ?capture=1, net-worker.mjs POST /capture) replayed
// with the page's own drawing code, frame by frame. Frames carry incremental state, so going to a frame replays the
// capture from its start up to it.
const CAPTURES = join(here, "captures");
const REPLAY_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>NT04 capture viewer</title>
<style>html,body{margin:0;background:#000;color:#aaa;font:13px system-ui,sans-serif}body{display:flex;flex-direction:column;align-items:center;gap:8px;padding:8px}
#view{width:min(96vw,calc((100vh - 120px)*4/3));aspect-ratio:4/3;background:#111}#ctl{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:center}
#frame{width:420px}.hide{display:none}</style></head><body>
<div id="ctl"><select id="file"></select><button id="first">|&lt;</button><button id="prev">&lt; frame</button><button id="play">play</button><button id="next">frame &gt;</button>
<input id="frame" type="range" min="1" max="1" value="1"><span id="pos">-</span><button id="save">save PNG</button></div>
<canvas id="view" width="1280" height="960"></canvas>
<div id="dbg" style="max-width:96vw;width:1100px;font-size:12px">Click a spot on the picture to list the draws that touched that pixel in this frame.
<label style="margin-left:12px">skip draw <input id="skip" type="number" min="0" style="width:70px"></label> <button id="copy">copy list</button>
<pre id="log" style="white-space:pre-wrap;background:#111;color:#ccc;padding:6px;max-height:40vh;overflow:auto"></pre></div>
<div class="hide"><input id="volume" type="range" min="0" max="100" value="0"><span id="status"></span><div id="pads"></div><span id="controls"></span><textarea id="keys"></textarea><button id="keysSave"></button><button id="keysReset"></button></div>
<script>
let fakeWS = null;
window.WebSocket = class { constructor() { fakeWS = this; this.readyState = 1; setTimeout(() => this.onopen && this.onopen(), 0); } send() {} close() {} };
</script>
<script src="/play-client.js"></script>
<script>
const $ = id => document.getElementById(id), q = new URLSearchParams(location.search);
// captures made before the camera-plane fix (nv2a-vsh.mjs, w ~ 0) carry the old vertex programs: give them the fix
// too (?oldvs=1 shows them as recorded)
if (q.get("oldvs") !== "1") { const r0 = resource; window.resource = function (r, blob) {
  if (r.op === "vs" && !r.src.includes("< 1e-3 ? -1e-3")) r.src = r.src.replace("gl_Position = vec4(nd * w, w);", "gl_Position = vec4(nd * w, abs(w) < 1e-3 ? -1e-3 : w);")
    .replace("O[0].z * 2.0 - O[0].w, O[0].w);", "O[0].z * 2.0 - O[0].w, abs(O[0].w) < 1e-3 ? -1e-3 : O[0].w);");
  return r0(r, blob); }; }
let msgs = [], cur = 0, timer = null;
async function load() {
  const list = await (await fetch("/captures")).json();
  $("file").innerHTML = list.map(n => '<option>' + n + '</option>').join("") || "<option>(no captures)</option>";
  const name = q.get("file") || list[0]; if (!name) return; $("file").value = name;
  const buf = await (await fetch("/captures/" + encodeURIComponent(name))).arrayBuffer(), dv = new DataView(buf);
  const n = dv.getUint32(6, true); let o = 10; for (let i = 0; i < n; i++) { const l = dv.getUint32(o, true); msgs.push(buf.slice(o + 4, o + 4 + l)); o += 4 + l; }
  $("frame").max = n - 1; const target = Math.min(n - 1, Math.max(1, +(q.get("frame") || 1)));
  await new Promise(r => setTimeout(r, 50));
  fakeWS.onmessage({ data: msgs[0] }); cur = 0;
  const tr = q.get("trace"), sk = +(q.get("skip") || 0); $("skip").value = sk || "";
  if (!tr && !sk) { step(target); return; }
  step(target - 1);
  // the target frame drawn draw by draw: each draw into a 640 x 480 target that changes the traced pixel is listed;
  // "skip" leaves one draw out
  const [tx, ty] = (tr || "-1,-1").split(",").map(Number), lines = [];
  const d0 = draw, s0 = drawSame; let dn = 0, last = "";
  window.drawSame = d => window.draw(d);   // (repeated-state draws through the full path, so each one is counted and traced)
  window.draw = function (d) { dn++; if (dn === sk) return;
    const r = d0(d); if (!tr) return r;
    const t = targets.get(d.rtId); if (!t || t.w !== 640) return r;
    const px = new Uint8Array(4); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.fbo); gl.readPixels(tx, t.h - 1 - ty, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const v = px.join(",");
    if (v !== last) { last = v; lines.push("draw " + dn + "  vs " + d.vs + " ps " + d.ps + " prim " + d.mode + " count " + d.count + " ib " + d.ib + " screen " + d.screen +
      "  tex " + [0, 1, 2, 3].map(k => d.tKind[k] ? d.tKind[k] + ":" + d.tId[k] + ":" + d.tW[k] + "x" + d.tH[k] : "-").join(" ") +
      "  blend " + d.blend + " " + d.b0.toString(16) + "/" + d.b1.toString(16) + " zt " + d.ztest + " zw " + d.zwrite + "  vb " + d.attrs[1] + "  ->  " + v); }
    return r; };
  step(target); window.draw = d0; window.drawSame = s0;
  $("log").textContent = tr ? "frame " + target + ", pixel " + tx + "," + ty + (sk ? ", skipping draw " + sk : "") + "\\n" + (lines.join("\\n") || "(no draw changed it)") : "frame " + target + ", skipping draw " + sk;
}
$("view").addEventListener("click", e => { const b = $("view").getBoundingClientRect(), x = Math.floor((e.clientX - b.left) / b.width * 640), y = Math.floor((e.clientY - b.top) / b.height * 480);
  location.search = "?pace=0&file=" + encodeURIComponent($("file").value) + "&frame=" + cur + "&trace=" + x + "," + y + ($("skip").value ? "&skip=" + $("skip").value : ""); });
$("skip").addEventListener("change", e => { const t = q.get("trace"); location.search = "?pace=0&file=" + encodeURIComponent($("file").value) + "&frame=" + cur + (t ? "&trace=" + t : "") + (e.target.value ? "&skip=" + e.target.value : ""); });
$("copy").onclick = () => navigator.clipboard?.writeText($("log").textContent);
function step(to) { while (cur < to) { cur++; fakeWS.onmessage({ data: msgs[cur] }); } $("frame").value = cur; $("pos").textContent = "frame " + cur + " / " + (msgs.length - 1); }
function go(f) { f = Math.min(msgs.length - 1, Math.max(1, f)); if (f > cur) step(f); else if (f !== cur) location.search = "?pace=0&file=" + encodeURIComponent($("file").value) + "&frame=" + f + (q.get("oldvs") ? "&oldvs=1" : ""); }
$("next").onclick = () => go(cur + 1); $("prev").onclick = () => go(cur - 1); $("first").onclick = () => go(1);
$("frame").onchange = e => go(+e.target.value);
$("file").onchange = e => { location.search = "?pace=0&file=" + encodeURIComponent(e.target.value); };
$("play").onclick = () => { if (timer) { clearInterval(timer); timer = null; $("play").textContent = "play"; return; }
  $("play").textContent = "pause"; timer = setInterval(() => { if (cur >= msgs.length - 1) { $("play").onclick(); return; } go(cur + 1); }, 1000 / 30); };
$("save").onclick = () => { show(); const a = document.createElement("a"); a.href = $("view").toDataURL("image/png"); a.download = "capture-frame-" + cur + ".png"; a.click(); };   // (show() redraws the frame: the canvas keeps no copy)
addEventListener("keydown", e => { if (e.code === "ArrowRight") { e.preventDefault(); go(cur + 1); } else if (e.code === "ArrowLeft") { e.preventDefault(); go(cur - 1); } }, true);
if (!/pace=0/.test(location.search)) location.search = "?pace=0" + (location.search ? "&" + location.search.slice(1) : ""); else load();
</script></body></html>`;
function answer(url) {
  if (url.pathname === "/") return [200, { "content-type": "text/html" }, PAGE];
  if (url.pathname === "/replay") return [200, { "content-type": "text/html" }, REPLAY_PAGE];
  if (url.pathname === "/captures") { let l = []; try { l = fsMod.readdirSync(CAPTURES).filter(n => n.endsWith(".bin")).sort().reverse(); } catch {} return [200, { "content-type": "application/json" }, JSON.stringify(l)]; }
  if (url.pathname.startsWith("/captures/")) { const n = decodeURIComponent(url.pathname.slice(10)); if (!/^[\w.-]+\.bin$/.test(n)) return [404, {}, null];
    try { return [200, { "content-type": "application/octet-stream", "cache-control": "no-store" }, readFileSync(join(CAPTURES, n))]; } catch { return [404, {}, null]; } }
  if (url.pathname === "/play-client.js") { const src = readFileSync(join(here, "play-client.js")); return [200, { "content-type": "text/javascript", "cache-control": "no-store" }, Buffer.concat([src, Buffer.from(`\nconst CLIENT_VERSION = "${createHash("sha1").update(src).digest("hex").slice(0, 12)}";\n`)])]; }
  if (url.pathname === "/ea-mad.mjs") return [200, { "content-type": "text/javascript", "cache-control": "no-store" }, readFileSync(join(here, "ea-mad.mjs"))];
  if (url.pathname === "/movie") { const e = movieEntry(url.searchParams.get("file") ?? "", +(url.searchParams.get("index") ?? 0));
    return e ? [200, { "content-type": "application/octet-stream", "cache-control": "no-store" }, e] : [404, {}, null]; }
  if (url.pathname === "/net") return [200, { "content-type": "application/json", "cache-control": "no-store" }, JSON.stringify(online?.info() ?? { role: null })];
  if (url.pathname === "/qualifying") return [200, { "content-type": "text/plain; charset=utf-8" }, formatSession(g?.qualifying ?? null)];
  if (url.pathname === "/silly-season") return [200, { "content-type": "text/plain; charset=utf-8" }, formatReport(g?.sillySeason ?? null)];
  if (url.pathname === "/ui.png") return [200, { "content-type": "image/png", "cache-control": "no-store" }, uiCanvas(false).png()];
  return [404, {}, null];
}
const net = new Worker(new URL("./net-worker.mjs", import.meta.url), { workerData: { port, host: "127.0.0.1" } });
// a message to the page: bytes that own their whole buffer are moved to the network thread, others copied
const post = data => {
  if (typeof data === "string") { net.postMessage({ t: "send", data }); return; }
  const u = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (u.byteOffset === 0 && u.byteLength === u.buffer.byteLength && !(u.buffer instanceof SharedArrayBuffer) && u.byteLength > 4096) net.postMessage({ t: "send", data: u }, [u.buffer]);
  else net.postMessage({ t: "send", data: u });
};
const pageLink = { send: post, close() { net.postMessage({ t: "close" }); } };
net.on("message", m => {
  if (m.t === "http") {
    let r; try { r = answer(new URL(m.url, "http://localhost")); } catch (e) { r = [500, {}, String(e?.message ?? e)]; }
    const [status, headers, body] = r; net.postMessage({ t: "httpres", id: m.id, status, headers, body });
  } else if (m.t === "open") {
    try { post(JSON.stringify({ t: "version", v: clientVersion() })); } catch {}
    client = pageLink; everConnected = true; movie = null; if (remote) remote.sink = msg => post(msg);
  } else if (m.t === "closed") { client = null; if (remote) remote.sink = null; }
  else if (m.t === "msg") {
    let msg; try { msg = JSON.parse(typeof m.data === "string" ? m.data : Buffer.from(m.data).toString()); } catch { return; }
    if (msg.t === "hello") { remote?.reset(); ui.reset(); }
    else if (msg.t === "ack") remote?.ready();
    else if (msg.t === "pad" && g?.pads) g.pads.set(msg.port ?? 0, msg);
    else if (msg.t === "movieEnd") movieEnded(msg.id, msg.reason | 0);
  } else if (m.t === "listening") console.log(`Open http://localhost:${port} to play.`);
});
net.on("error", e => console.log(`network thread: ${e.message}`));

// ---------------------------------------------------------------- terminal keys
let shots = 0;
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true); process.stdin.setEncoding("utf8");
  process.stdin.on("data", k => {
    if (k === "\x03" || k === "q" || k === "Q") process.exit(0);
    if (k === "p" || k === "P") { const f = `shot-${++shots}.png`; writeFileSync(f, uiCanvas(false).png()); console.log(`saved ${f}`); return; }
    const m = TERM_KEYS[k] ?? TERM_KEYS[k.toLowerCase()];
    if (m !== undefined) pending.push({ m, value: 1 }, { m, value: 0 });
  });
  console.log("Terminal: arrows, Enter = A, Esc = B, S = START, P = screenshot, Q = quit (play in the browser page)");
}
