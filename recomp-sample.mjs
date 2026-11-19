// recomp-sample.mjs — where race time goes: the running instruction address at every scheduler tick (every 250 k
// instructions) over 30 s of a bot-driven race -> recomp-samples.json (read by recomp-scan.mjs).
// Usage: node recomp-sample.mjs [Data folder]
process.env.NT04_NO_JS_SCREENS = "1";
const here = new URL(".", import.meta.url).pathname;
const { openScreen } = await import("./uis-run.mjs");
const { BUTTON } = await import("./xinput-hle.mjs");
const { RaceBot } = await import("./race-bot.mjs");
const fs = await import("node:fs");
const r = openScreen(process.argv[2] ?? `${here}Data`, "flow", 0, { time: 0 });
const vm = r.vm, g = r.game.game, P = g.pads, c = g.cpu;
const step = () => { vm.frame(); g.dsound.drainAudio(); };
const neutral = { buttons: 0, analog: [0, 0, 0, 0, 0, 0, 0, 0] }, A = { buttons: 0, analog: [255, 0, 0, 0, 0, 0, 0, 0] };
const run = ms => { for (let i = Math.ceil(ms / vm.frameMs); i > 0; i--) step(); };
const scr = () => vm.screens.map(x => x.group + "/" + x.screen).join(" ");
const tap = (s, after = 2350) => { P.set(0, s); run(150); P.set(0, neutral); run(after); };
for (const s of [{ buttons: BUTTON.START }, A, A, A, { buttons: BUTTON.DOWN }, A, A, A]) tap(s);
run(20000); tap({ buttons: BUTTON.START }, 3000); tap(A, 3000); tap(A, 3000);
for (let k = 0; k < 20 && !scr().includes("3/10"); k++) run(500);
run(4000); P.set(0, A); run(150); P.set(0, neutral);
const bot = new RaceBot(g, { speed: 330 }); for (let i = 0; i < 300; i++) { bot.drive(); step(); }
const samples = []; const tick0 = c.onTick; c.tickInterval = 250_000; c.nextTick = c.steps + 250_000;   // (more samples; scheduling changes don't matter here)
c.onTick = (...a) => { samples.push(c.eip >>> 0); return tick0.apply(c, a); };
for (let i = 0; i < 1800; i++) { bot.drive(); step(); }
fs.writeFileSync(`${here}recomp-samples.json`, JSON.stringify(samples)); console.log("samples", samples.length); process.exit(0);
