// usage: node recomp-hooks.mjs [DataDir] -> recomp-hooks.json: addresses with a JavaScript hook once a race runs.
// recomp.mjs uses it to know which calls may run a hook in place (those need every register in the context);
// wasm-jit.mjs disables recompiled functions that call an address hooked later that is not in this list.
process.env.NT04_NO_JS_SCREENS = "1";
const fs = await import("node:fs");
const { openScreen } = await import("./uis-run.mjs");
const { BUTTON } = await import("./xinput-hle.mjs");
const r = openScreen(process.argv[2] ?? new URL("./Data", import.meta.url).pathname, "flow", 0, { time: 0 });
const vm = r.vm, g = r.game.game, P = g.pads;
const neutral = { buttons: 0, analog: [0, 0, 0, 0, 0, 0, 0, 0] }, A = { buttons: 0, analog: [255, 0, 0, 0, 0, 0, 0, 0] };
const run = ms => { for (let i = Math.ceil(ms / vm.frameMs); i > 0; i--) { vm.frame(); g.dsound.drainAudio(); } };
const scr = () => vm.screens.map(x => x.group + "/" + x.screen).join(" ");
const tap = (s, after = 2350) => { P.set(0, s); run(150); P.set(0, neutral); run(after); };
const seen = new Set(g.cpu.hooks.keys());
for (const s of [{ buttons: BUTTON.START }, A, A, A, { buttons: BUTTON.DOWN }, A, A, A]) tap(s);
run(20000); tap({ buttons: BUTTON.START }, 3000); tap(A, 3000); tap(A, 3000);
for (let k = 0; k < 20 && !scr().includes("3/10"); k++) run(500);
run(4000); P.set(0, A); run(150); P.set(0, neutral); run(5000);
for (const k of g.cpu.hooks.keys()) seen.add(k);
const list = [...seen].sort((a, b) => a - b);
fs.writeFileSync(new URL("./recomp-hooks.json", import.meta.url), JSON.stringify(list));
console.log("hooked addresses", list.length);
process.exit(0);
