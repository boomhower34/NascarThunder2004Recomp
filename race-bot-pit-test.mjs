// race-bot-pit-test.mjs — AFTER script for a test-race runner (G = { vm, g, P, run, tap, scr, A, fs }): starts the race, has
// the RaceBot drive the player car and make a pit stop; logs race state / pit word every half second.
// env: WAIT ms braking at the start (the field passes), T ms, LANE, SPEED, PITLAP, PITFROM seg,toGo[,minToGo] or
// PITBEFORE ft (approach from that far before the start line, found on the first lap), PITLANE, PITSPEED,
// PITAFTER s (the approach only that far into the lap: Milwaukee's turns 2 and 4 read the same segment),
// SHOTAT s,s (soft-rendered screenshots, SHOTPRE prefix), OUT (json log), STOPAFTERPIT.
const { vm, g, P, run, tap, scr, A } = G;
const { RaceBot } = await import(new URL("./race-bot.mjs", import.meta.url).href);
run(0); tap({ buttons: 0x10 }, 3000); tap(A, 3000); tap(A, 3000);
for (let k = 0; k < 160 && !scr().includes("3/10"); k++) run(500);
run(4000);
const bot = new RaceBot(g, { target: +(process.env.LANE ?? 0), speed: +(process.env.SPEED ?? 95), pitOnLap: +(process.env.PITLAP ?? 0), pitLane: +(process.env.PITLANE ?? -115), pitSpeed: +(process.env.PITSPEED ?? 85), pitFrom: (process.env.PITFROM ?? "3,800").split(",").map(Number) });
P.set(0, A); run(150);
const F = a => new Float32Array(new Uint32Array([g.mem.r32(a)]).buffer)[0], pos = () => [F(0x2951e0 + 0x4c), F(0x2951e0 + 0x50)].map(v => Math.round(v));
const WAIT = +(process.env.WAIT ?? 0);
for (let t = 0; t < WAIT; t += 1000) { P.set(0, { buttons: 0, analog: [0, 0, 0, 0, 0, 0, 200, 0], lx: 0, ly: 0 }); for (let f = 0; f < 60; f++) vm.frame(); if (t % 5000 === 0) console.log(`wait ${t / 1000} pos ${pos()} st ${JSON.stringify(bot.state())}`); }
const T = +(process.env.T ?? 120000), out = [], shots = (process.env.SHOTAT ?? "").split(",").filter(Boolean).map(Number);
const shot = async name => { const { SoftRenderer } = await import(new URL("./soft-renderer.mjs", import.meta.url).href); const keep = g.renderer, keepR = g.d3d.r;
  const sr = new SoftRenderer(g); sr.init({ width: g.d3d.width, height: g.d3d.height }); sr.frames = keep.frames; g.renderer = sr; g.d3d.r = sr;
  const t1 = Date.now(); sr.capture(2); while (sr.capturing && Date.now() - t1 < 600000) { bot.drive(); vm.frame(); } G.fs.writeFileSync(name, sr.png()); g.renderer = keep; g.d3d.r = keepR; console.log("shot", name); };
for (let t = 0; t < T; t += 500) {
  for (let f = 0; f < 30; f++) { if (process.env.PITBEFORE) { const s0 = bot.state(); if (bot.lastLaps !== undefined && s0.laps > bot.lastLaps && !bot.line) { bot.line = [s0.segment, s0.toGo]; bot.pitFrom = [s0.segment, s0.toGo + +process.env.PITBEFORE, s0.toGo + 50]; console.log("start line at", JSON.stringify(bot.line), "pit approach from", JSON.stringify(bot.pitFrom)); } bot.lastLaps = s0.laps; }
    if (process.env.PITAFTER) { const s1 = bot.state(); bot.pitOnLap = s1.lapTime > +process.env.PITAFTER && s1.lapTime < 9000 ? +(process.env.PITLAP ?? 0) : -1; }
    bot.drive(); vm.frame(); }
  if (shots.includes(t / 1000)) await shot(`${process.env.SHOTPRE ?? "/tmp/shot"}_${t / 1000}.png`);
  const s = bot.last ?? bot.state(); out.push({ t, pos: pos(), ...s, pit: bot.pit, pitword: g.mem.r32(0x2b9e84), scr: scr() });
  if (t % 2000 === 0 || bot.pit !== "none") console.log(`t ${t / 1000} pos ${pos()} seg ${s.segment} toGo ${s.toGo?.toFixed(0)} lane ${s.lane?.toFixed(1)} v ${s.speed?.toFixed(0)} st ${s.raceState} lap ${s.laps} pit ${bot.pit}/${bot.pits} pitword ${g.mem.r32(0x2b9e84)} ${scr()}`);
  if (bot.pits >= 1 && process.env.STOPAFTERPIT) { for (let f = 0; f < 300; f++) { bot.drive(); vm.frame(); } console.log("after pit:", pos(), JSON.stringify(bot.state())); break; }
}
if (process.env.OUT) G.fs.writeFileSync(process.env.OUT, JSON.stringify(out));
