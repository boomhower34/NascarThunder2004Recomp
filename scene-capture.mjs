#!/usr/bin/env node
// scene-capture.mjs — boot the game, press a sequence of buttons, then draw the next frames of the game's 3D
// scene in software (soft-renderer.mjs) and save them as PNG.
//
// usage: node scene-capture.mjs <Data folder> [keys] [out.png] [frames]
//   keys: comma-separated buttons pressed 2.5 s apart (UI VM button codes). Defaults reach the Season race weekend:
//         7,0,0,0,3,0,0      race weekend menu over the 3D track view (~80 s)
//         7,0,0,0,3,0,0,0,0,0  in the race (~3 min)
//   frames: frames to draw (default 2; the second one has the sun-glare visibility test of the first)
import { writeFileSync } from "node:fs";
import { openScreen } from "./uis-run.mjs";
import { SoftRenderer } from "./soft-renderer.mjs";

const [data, keyArg = "7,0,0,0,3,0,0", out = "scene.png", frames = "2"] = process.argv.slice(2);
if (!data) { console.error("usage: node scene-capture.mjs <Data folder> [keys] [out.png] [frames]"); process.exit(1); }
const r = openScreen(data, "flow", 0, { time: 3000 }), g = r.game.game, vm = r.vm;
const t0 = Date.now();
for (const k of keyArg.split(",").filter(Boolean).map(Number)) { vm.press(k, 0); vm.runFor(2500); }
console.log(`at ${vm.screens.map(s => s.group + "/" + s.screen).join(" ")} after ${((Date.now() - t0) / 1000) | 0}s`);
if (!g.d3d?.width) { console.error("the game has not created its 3D device"); process.exit(1); }
const sr = new SoftRenderer(g); sr.init({ width: g.d3d.width, height: g.d3d.height }); sr.frames = g.renderer.frames;
g.renderer = sr; g.d3d.r = sr;
const t1 = Date.now(); sr.capture(+frames);
while (sr.capturing && Date.now() - t1 < 600000) vm.runFor(20);
writeFileSync(out, sr.png());
console.log(`${out}: ${sr.drawn} draw calls in ${((Date.now() - t1) / 1000).toFixed(1)}s; skipped ${JSON.stringify(sr.skipped)}`);
