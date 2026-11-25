#!/usr/bin/env node
// launcher.mjs — the launch window: a page on localhost to start the game and run the texture tools
// (read_textures.py, upscale_textures.py) with their options, for players who never open a terminal.
//
// usage: node launcher.mjs [--port 8800] [--data <Data folder>] [--no-open]
//   Opens http://localhost:8800 in the default browser. From there:
//     Play      start / stop the game server (main.mjs) and open the game page; its console output is shown
//     Roster    add drivers: name, ratings, car number (or their own number picture), team, portrait, paint, pit sign
//               and pit box colours (roster-server.mjs, roster-ui.js)
//     Schedules season and career schedules (schedules-server.mjs, schedules-ui.js)
//     Career    the silly season after each career year (career-server.mjs, career-ui.js; silly-season.mjs)
//     Rookies   rookie prospects without a car for careers (rookies-ui.js; roster-server.mjs /api/roster/rookie)
//     Sponsors  sponsors added to the game's list (brands-ui.js; sponsor-decals.mjs), paint schemes without numbers +
//               crew uniforms (sponsors-server.mjs, sponsors-ui.js; number-paint.mjs)
//     Tracks    track packs: new tracks or replacement track models from glTF (scenery, physics, racing lines); NR2003
//               tracks converted to glTF to edit first; an object library of track-side objects as .glb
//               (tracks-server.mjs, tracks-ui.js, track-pack.mjs, nr2003-gltf.mjs, gltf-layout.mjs, objects-export.mjs)
//     Textures  export pictures to PNG, upscale them into the override folder (textures/), clear overrides
//     Setup     which Python was found and which packages it has; install the basic ones
//   Settings are kept in launcher-settings.json beside this file.
//
// Only listens on 127.0.0.1. Tools run as child processes without a shell, with their options checked here.

import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, mkdirSync, cpSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createRoster } from "./src/launcher/roster-server.mjs";
import { createTracks } from "./src/launcher/tracks-server.mjs";
import { createSchedules } from "./src/launcher/schedules-server.mjs";
import { createCareer } from "./src/launcher/career-server.mjs";
import { createSponsors } from "./src/launcher/sponsors-server.mjs";
import { findClang } from "./src/cpu/recomp.mjs";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(opt("--port", 8800));
const DATA = resolve(opt("--data", join(here, "Data"))), TEXTURES = join(here, "textures"), MODELS = join(here, "models"), EXPORTS = join(here, "exports");
const SETTINGS = join(here, "launcher-settings.json");
// ---------------------------------------------------------------- presets
// A preset is a separate copy of everything the player makes or plays: roster/ (drivers, teams, sponsors, tracks,
// schedules, career settings, pictures) and save/ (the game's saves, profiles and EA SPORTS Bio), plus "Unlock
// everything". "default" is the folders beside the launcher as they always were; the others live in
// presets/<id>/ { preset.json, roster/, save/ }. The game gets the active one as NT04_USER (nt04-config userRoot,
// gamecode save folder, uis-render roster textures). Shared by all: the game's Data, upscaled pictures (textures/),
// models, exports, captures and the launcher's other settings.
const PRESETS = join(here, "presets");
const presetDir = id => id === "default" ? here : join(PRESETS, id);
const presetMeta = id => { if (id === "default") return { name: settings.preset.defaultName || "Main", unlockAll: !!settings.game.unlockAll };
  try { return { unlockAll: false, ...JSON.parse(readFileSync(join(PRESETS, id, "preset.json"), "utf8")) }; } catch { return null; } };
const writeMeta = (id, m) => { if (id === "default") { settings.preset.defaultName = m.name; settings.game.unlockAll = !!m.unlockAll; saveSettings(); return; }
  mkdirSync(join(PRESETS, id), { recursive: true }); writeFileSync(join(PRESETS, id, "preset.json"), JSON.stringify(m, null, 2)); };
const presetIds = () => ["default", ...(existsSync(PRESETS) ? readdirSync(PRESETS).filter(d => existsSync(join(PRESETS, d, "preset.json"))).sort() : [])];
const active = () => presetIds().includes(settings.preset.active) ? settings.preset.active : "default";
const dirSize = d => { let n = 0, f = 0; const walk = p => { for (const e of readdirSync(p, { withFileTypes: true })) { const q = join(p, e.name); if (e.isDirectory()) walk(q); else { n += statSync(q).size; f++; } } }; try { if (existsSync(d)) walk(d); } catch {} return { bytes: n, files: f }; };
const presetInfo = id => { const m = presetMeta(id), d = presetDir(id); let drivers = 0; try { drivers = JSON.parse(readFileSync(join(d, "roster", "roster.json"), "utf8")).drivers?.length ?? 0; } catch {}
  return { id, name: m?.name ?? id, created: m?.created ?? null, unlockAll: !!m?.unlockAll, drivers, roster: dirSize(join(d, "roster")), save: dirSize(join(d, "save")) }; };
// the Roster / Tracks / Schedules / Career / Sponsors servers of each preset (made when first used)
const servers = new Map();
const srv = () => { const id = active(); if (!servers.has(id)) { const user = presetDir(id);
  servers.set(id, { roster: createRoster({ here, data: DATA, user }), tracks: createTracks({ here, data: DATA, user }), schedules: createSchedules({ here, data: DATA, user }), career: createCareer({ here, data: DATA, user }), sponsors: createSponsors({ here, data: DATA, user }) }); }
  return servers.get(id); };

// ---------------------------------------------------------------- settings
const DEFAULTS = {
  game: { port: 8854, boot: "flow", net: "off", netName: "", netAddress: "", netPort: 27104, netRelay: "", unlockAll: false, fadeScale: 1 },
  upscale: { bundles: ["uis_drpo", "uis_drps"], model: "", pre: "", scale: 2, soften: 0, overwrite: false, tile: 512, fp16: false, device: "" },
  export: { bundles: ["uis_drpo"] },
  preset: { active: "default", defaultName: "Main" },
};
let settings = structuredClone(DEFAULTS);
try { const s = JSON.parse(readFileSync(SETTINGS, "utf8")); for (const k of Object.keys(DEFAULTS)) settings[k] = { ...DEFAULTS[k], ...(s[k] ?? {}) }; } catch {}
const saveSettings = () => { try { writeFileSync(SETTINGS, JSON.stringify(settings, null, 2)); } catch {} };

// ---------------------------------------------------------------- python
let python = null;                     // { cmd: [exe, ...args], version, packages: { numpy, PIL, torch, spandrel, cuda } }
function findPython() {
  const cands = process.platform === "win32" ? [["py", "-3"], ["python"], ["python3"]] : [["python3"], ["python"]];
  for (const c of cands) {
    const r = spawnSync(c[0], [...c.slice(1), "--version"], { encoding: "utf8", timeout: 10000 });
    if (r.status === 0) { python = { cmd: c, version: (r.stdout || r.stderr).trim(), packages: {} }; break; }
  }
  if (!python) return;
  const probe = `import importlib.util as u, json
p = {m: u.find_spec(m) is not None for m in ("numpy", "PIL", "torch", "spandrel")}
if p["torch"]:
    try:
        import torch; p["cuda"] = bool(torch.cuda.is_available()); p["gpu"] = torch.cuda.get_device_name(0) if p["cuda"] else ""
    except Exception as e: p["cuda"] = False; p["gpu"] = ""
print(json.dumps(p))`;
  const r = spawnSync(python.cmd[0], [...python.cmd.slice(1), "-c", probe], { encoding: "utf8", timeout: 60000 });
  try { python.packages = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { python.packages = {}; }
}

// ---------------------------------------------------------------- jobs (one tool at a time) and the game process
let job = null, nextJob = 1;
const MAX_LINES = 4000;
function newLog() { return { lines: [], base: 0, push(s) { for (const l of String(s).split(/\r?\n/)) if (l.length) this.lines.push(l); if (this.lines.length > MAX_LINES) { const n = this.lines.length - MAX_LINES; this.lines.splice(0, n); this.base += n; } } }; }
function runJob(kind, exe, args, total) {
  if (job?.running) throw new Error("a tool is already running");
  const log = newLog(); log.push(`> ${[exe, ...args].join(" ")}`);
  const p = spawn(exe, args, { cwd: here, windowsHide: true, env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" } });
  job = { id: nextJob++, kind, running: true, code: null, log, total, step: 0, done: 0, proc: p, started: Date.now() };
  const j = job, onData = d => { const s = d.toString(); j.log.push(s); j.done += (s.match(/^(?:uis_\w+\s+\d+\s+\d+x\d+ ->|wrote )/gm) ?? []).length;
    for (const m of s.matchAll(/^\[(\d+)\/(\d+)\]/gm)) { j.step = +m[1]; j.total = +m[2]; } };
  p.stdout.on("data", onData); p.stderr.on("data", onData);
  p.on("error", e => { j.log.push(`could not start: ${e.message}`); j.running = false; j.code = -1; });
  p.on("close", code => { j.running = false; j.code = code; j.log.push(code === 0 ? "finished" : `stopped (exit code ${code})`); });
  return j;
}

// recomp.wasm: there, and built for this default.exe? (recomp.json "image" = the first 16 hex digits of the exe's
// SHA-256, as wasm-jit.mjs checks it). Kept until a file changes (the status is polled every 0.8 s).
let recompCache = null;
function recompStatus() {
  const exe = join(here, "default.exe"), man = join(here, "recomp.json"), wr = join(here, "recomp.wasm"), wz = wr + ".gz";
  const mt = f => existsSync(f) ? statSync(f).mtimeMs : 0, key = [exe, man, wr, wz].map(mt).join(",");
  if (recompCache?.key !== key) {
    let state = "missing", image = null;
    if (mt(man) && (mt(wr) || mt(wz))) {
      const head = readFileSync(man, { encoding: "latin1" }).slice(0, 300); image = /"image":"([0-9a-f]+)"/.exec(head)?.[1] ?? null;
      state = mt(exe) && image === createHash("sha256").update(readFileSync(exe)).digest("hex").slice(0, 16) ? "ready" : "other";
    }
    recompCache = { key, exe: !!mt(exe), state };
  }
  const c = findClang();
  return { exe: recompCache.exe, state: recompCache.state, compiler: c.ok ? { ok: true, clang: c.clang, version: c.version } : { ok: false, why: c.why } };
}

let game = null;
function startGame() {
  if (game?.running) return game;
  const log = newLog(), port = settings.game.port | 0, boot = settings.game.boot;
  const s = settings.game, netArgs = s.net === "host" ? ["--net-host"] : s.net === "join" && s.netAddress ? ["--net-join", s.netAddress] : [];
  if (netArgs.length) netArgs.push("--net-port", String(s.netPort | 0 || 27104), ...(s.netName ? ["--net-name", s.netName] : []), ...(s.netRelay ? ["--net-relay", s.netRelay] : []));
  const p = spawn(process.execPath, [join(here, "src/main.mjs"), DATA, "--port", String(port), "--boot", boot, ...netArgs], { cwd: here, windowsHide: true,
    env: { ...process.env, ...(presetMeta(active())?.unlockAll ? { NT04_UNLOCK_ALL: "1" } : {}), ...(+s.fadeScale > 0 && +s.fadeScale !== 1 ? { NT04_FADE_SCALE: String(s.fadeScale) } : {}), ...(active() !== "default" ? { NT04_USER: presetDir(active()) } : {}) } });   // (gamecode unlockAllHook; presets)
  game = { running: true, port, log, proc: p, ready: false, code: null };
  const g = game, onData = d => { const s = d.toString(); g.log.push(s); if (/Open http:\/\/localhost/.test(s)) g.ready = true; };
  p.stdout.on("data", onData); p.stderr.on("data", onData);
  p.on("error", e => { g.log.push(`could not start: ${e.message}`); g.running = false; });
  p.on("close", code => { g.running = false; g.ready = false; g.code = code; g.log.push(`game server stopped (exit code ${code})`); });
  return game;
}

// ---------------------------------------------------------------- what is on disk
const BUNDLE_INFO = {
  uis_drpo: "Driver portraits (menus)", uis_drps: "Driver portraits (small, HUD)", uis_drnm: "Driver name plates",
  uis_cars: "Car pictures", uis_trlg: "Track logos", uis_trpc: "Track pictures", uis_logo: "Logos", uis_spon: "Sponsors",
  uis_smnm: "Car numbers", uis_comn: "Common menu parts", uis_fe: "Front-end menus", uis_ig: "In-race HUD", uis_icon: "Icons",
  uis_text: "Text graphics", uis_font: "Fonts", uis_back: "Backgrounds", uis_gene: "General", uis_pltl: "Paint schemes (large)",
  uis_plts: "Paint schemes (small)", uis_race: "Race screens", uis_shop: "Shop", uis_smap: "Track maps", uis_trop: "Trophies",
  uis_awar: "Awards", uis_crew: "Crew", uis_cont: "Controller", uis_over: "Overlays", uis_spdl: "Speedometer", uis_anma: "Animations",
  uis_modl: "Models", uis_gscr: "Screen data",
};
const SKIP = new Set(["uis_all", "uis_vide", "uis_fmvs"]);
function bundles() {
  let files = []; try { files = readdirSync(DATA).filter(f => /^UIS_[A-Z0-9]+\.DAT$/i.test(f)); } catch {}
  return files.map(f => f.slice(0, -4).toLowerCase()).filter(b => !SKIP.has(b) && !b.startsWith("uis_cvd")).sort()
    .map(b => ({ name: b, label: BUNDLE_INFO[b] ?? b.slice(4).toUpperCase(), overrides: countPngs(join(TEXTURES, b)), exported: countPngs(join(EXPORTS, b)) }));
}
function countPngs(d) { try { return readdirSync(d).filter(f => f.toLowerCase().endsWith(".png")).length; } catch { return 0; } }
function models() { try { return readdirSync(MODELS).filter(f => /\.(pth|safetensors|ckpt|pt)$/i.test(f)).sort(); } catch { return []; } }

// ---------------------------------------------------------------- tool command lines (options checked)
const BUNDLE_RE = /^uis_[a-z0-9]+$/;
function upscaleArgs(o) {
  const b = (o.bundles ?? []).filter(x => x === "ui" || BUNDLE_RE.test(x)); if (!b.length) throw new Error("choose at least one picture set");
  const m = models(), a = [join(here, "python/upscale_textures.py"), "--data", DATA, "--out", TEXTURES, "--bundles", ...b];
  if (o.model) { if (!m.includes(o.model)) throw new Error(`model ${o.model} is not in the models folder`); a.push("--model", o.model); }
  if (o.pre) { if (!m.includes(o.pre)) throw new Error(`model ${o.pre} is not in the models folder`); a.push("--pre", o.pre); }
  const scale = Number(o.scale); if (!(scale >= 1 && scale <= 8)) throw new Error("scale must be 1-8"); a.push("--scale", String(scale));
  const soften = Number(o.soften); if (soften > 0) { if (!(soften <= 3)) throw new Error("soften must be 0-3"); a.push("--soften", String(soften)); }
  const tile = Number(o.tile); if (Number.isInteger(tile) && tile >= 0 && tile <= 4096) a.push("--tile", String(tile));
  if (o.fp16) a.push("--fp16");
  if (o.device === "cuda" || o.device === "cpu") a.push("--device", o.device);
  if (o.overwrite) a.push("--overwrite");
  return a;
}

// ---------------------------------------------------------------- http
const json = (res, code, v) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(v)); };
const body = req => new Promise((ok, bad) => { let s = ""; req.on("data", d => { s += d; if (s.length > 1e6) req.destroy(); }); req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } }); });
const logView = (log, since) => { const from = Math.max(0, (since | 0) - log.base); return { lines: log.lines.slice(from), next: log.base + log.lines.length }; };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost"), p = url.pathname;
  try {
    if (req.method === "GET" && p === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return res.end(PAGE); }
    if (req.method === "GET" && p === "/api/status") return json(res, 200, {
      preset: (() => { const m = presetMeta(active()); return { active: active(), name: m?.name, unlockAll: !!m?.unlockAll }; })(),
      settings, python: python && { version: python.version, cmd: python.cmd.join(" "), packages: python.packages },
      bundles: bundles(), models: models(), recomp: recompStatus(), dataFound: existsSync(DATA), xbeFound: existsSync(join(dirname(DATA), "default.xbe")), dataDir: DATA, textures: TEXTURES, exports: EXPORTS, modelsDir: MODELS,
      game: game && { running: game.running, ready: game.ready, port: game.port, code: game.code },
      job: job && { id: job.id, kind: job.kind, running: job.running, code: job.code, done: job.done, step: job.step, total: job.total, started: job.started },
    });
    if (req.method === "GET" && p === "/api/log") {
      const which = url.searchParams.get("which"), since = url.searchParams.get("since");
      const log = which === "game" ? game?.log : job?.log; return json(res, 200, log ? logView(log, since) : { lines: [], next: 0 });
    }
    if (req.method === "POST" && p === "/api/settings") { const b = await body(req); for (const k of Object.keys(DEFAULTS)) if (b[k]) settings[k] = { ...settings[k], ...b[k] }; saveSettings(); return json(res, 200, { ok: true }); }
    if (p === "/api/presets") {
      if (req.method === "GET") return json(res, 200, { active: active(), presets: presetIds().map(presetInfo), running: !!game?.running });
      const b = await body(req), busy = () => { if (game?.running) throw new Error("stop the game first"); };
      const clean = v => String(v ?? "").replace(/[^\x20-\x7e]/g, "").trim().slice(0, 40);
      if (b.action === "create") {
        const name = clean(b.name); if (!name) throw new Error("the preset needs a name");
        if (presetIds().some(id => presetMeta(id)?.name.toLowerCase() === name.toLowerCase())) throw new Error(`there is already a preset called "${name}"`);
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "preset"; let id = slug, k = 2; while (id === "default" || existsSync(join(PRESETS, id))) id = `${slug}-${k++}`;
        const from = b.from && presetIds().includes(b.from) ? b.from : null; mkdirSync(join(PRESETS, id), { recursive: true });
        if (from) { for (const [part, want] of [["roster", true], ["save", !!b.copySaves]]) { const src = join(presetDir(from), part); if (want && existsSync(src)) cpSync(src, join(PRESETS, id, part), { recursive: true }); } }
        writeMeta(id, { name, created: new Date().toISOString(), unlockAll: from ? !!presetMeta(from)?.unlockAll : false, from });
        if (b.switch) { busy(); settings.preset.active = id; saveSettings(); }
        return json(res, 200, { id });
      }
      const id = presetIds().includes(b.id) ? b.id : null; if (!id) throw new Error("no such preset");
      if (b.action === "switch") { busy(); settings.preset.active = id; saveSettings(); return json(res, 200, { active: id }); }
      if (b.action === "rename") { const name = clean(b.name); if (!name) throw new Error("the preset needs a name");
        if (presetIds().some(x => x !== id && presetMeta(x)?.name.toLowerCase() === name.toLowerCase())) throw new Error(`there is already a preset called "${name}"`);
        writeMeta(id, { ...presetMeta(id), name }); return json(res, 200, { ok: true }); }
      if (b.action === "delete") { if (id === "default") throw new Error("the main preset cannot be removed");
        if (id === active()) throw new Error("switch to another preset first"); servers.delete(id);
        rmSync(join(PRESETS, id), { recursive: true, force: true }); return json(res, 200, { ok: true }); }
      throw new Error("unknown preset action");
    }
    if (req.method === "POST" && p === "/api/game/start") { const b = await body(req);
      if (b.port) { const n = Number(b.port); if (!(n >= 1024 && n < 65536)) throw new Error("port must be 1024-65535"); settings.game.port = n; }
      if (["flow", "menu", "title"].includes(b.boot)) settings.game.boot = b.boot;
      if ([1, 1.5, 2, 3, 4].includes(+b.fadeScale)) settings.game.fadeScale = +b.fadeScale;   // (track detail fade distances: gamecode withFadeScale)
      if (typeof b.unlockAll === "boolean") writeMeta(active(), { ...presetMeta(active()), unlockAll: b.unlockAll });   // (each preset its own)
      if (["off", "host", "join"].includes(b.net)) settings.game.net = b.net;
      if (typeof b.netName === "string") settings.game.netName = b.netName.trim().slice(0, 24);
      if (typeof b.netAddress === "string") { const a = b.netAddress.trim(); if (a && !/^[\w.\-:\[\]]+$/.test(a)) throw new Error("the host address may only hold letters, digits, dots, dashes and a :port"); settings.game.netAddress = a; }
      if (typeof b.netRelay === "string") { const a = b.netRelay.trim(); if (a && !/^[\w.\-:\[\]]+$/.test(a)) throw new Error("the relay address may only hold letters, digits, dots, dashes and a :port"); settings.game.netRelay = a; }
      if (b.netPort) { const n = Number(b.netPort); if (!(n >= 1024 && n < 65536)) throw new Error("online port must be 1024-65535"); settings.game.netPort = n; }
      if (settings.game.net === "join" && !settings.game.netAddress) throw new Error(settings.game.netRelay ? "pick a race from the relay's list" : "enter the host's address to join a race");
      saveSettings();
      const g = startGame(); return json(res, 200, { port: g.port }); }
    // online race status: the running game's /net (players, ping), plus this computer's addresses to give to others
    // a relay's list of open races (fetched here: the page may not reach other hosts itself)
    if (req.method === "GET" && p === "/api/net/races") {
      const relay = (new URL(req.url, "http://x").searchParams.get("relay") ?? "").trim();
      if (!/^[\w.\-\[\]]+(:\d+)?$/.test(relay)) return json(res, 400, { error: "relay address?" });
      try { const r = await fetch(`http://${relay.includes(":") && !relay.startsWith("[") ? relay : `${relay}:27105`}/races`, { signal: AbortSignal.timeout(5000) }); return json(res, 200, await r.json()); }
      catch (e) { return json(res, 200, { error: `could not reach the relay ${relay}: ${e.message}` }); }
    }
    if (req.method === "GET" && p === "/api/net") {
      const addrs = Object.values(os.networkInterfaces()).flat().filter(a => a && !a.internal && a.family === "IPv4").map(a => a.address);
      let info = null; if (game?.running && game.ready) { try { const r = await fetch(`http://127.0.0.1:${game.port}/net`); info = await r.json(); } catch {} }
      return json(res, 200, { addresses: addrs, info });
    }
    if (req.method === "POST" && p === "/api/game/stop") { if (game?.running) game.proc.kill(); return json(res, 200, { ok: true }); }
    if (req.method === "POST" && p === "/api/upscale") {
      if (!python) throw new Error("Python was not found"); const b = await body(req);
      settings.upscale = { ...settings.upscale, ...b }; saveSettings();
      const j = runJob("upscale", python.cmd[0], [...python.cmd.slice(1), ...upscaleArgs(settings.upscale)], 0); return json(res, 200, { id: j.id }); }
    if (req.method === "POST" && p === "/api/export") {
      if (!python) throw new Error("Python was not found"); const b = await body(req);
      const list = (b.bundles ?? []).filter(x => BUNDLE_RE.test(x)); if (!list.length) throw new Error("choose at least one picture set");
      settings.export = { bundles: list }; saveSettings(); mkdirSync(EXPORTS, { recursive: true });
      // one Python run for all of them: a tiny driver around read_textures.main
      const code = `import sys; sys.path.insert(0, ${JSON.stringify(join(here, "python"))}); import read_textures as r
bl = ${JSON.stringify(list)}
for k, b in enumerate(bl):
    print(f"[{k + 1}/{len(bl)}] {b}", flush=True)
    r.main(["convert", ${JSON.stringify(DATA)} + "/" + b.upper() + ".DAT", ${JSON.stringify(EXPORTS)} + "/" + b])`;
      const j = runJob("export", python.cmd[0], [...python.cmd.slice(1), "-c", code], 0); return json(res, 200, { id: j.id }); }
    if (req.method === "POST" && p === "/api/install") {
      if (!python) throw new Error("Python was not found"); const b = await body(req);
      const pk = b.ai ? ["numpy", "pillow", "spandrel"] : ["numpy", "pillow"];
      const j = runJob("install", python.cmd[0], [...python.cmd.slice(1), "-m", "pip", "install", "--upgrade", ...pk], 0);
      j.proc.on("close", () => findPython()); return json(res, 200, { id: j.id }); }
    if (req.method === "POST" && p === "/api/recomp") {   // build recomp.wasm for this default.exe (recomp.mjs, clang)
      if (game?.running) throw new Error("stop the game first"); const b = await body(req);
      if (b.check) { recompCache = null; findClang({ fresh: true }); return json(res, 200, recompStatus()); }
      const r = recompStatus(); if (!r.exe) throw new Error("default.exe is missing: set up the game files first (Setup -> Game files)");
      if (!r.compiler.ok) throw new Error(r.compiler.why);
      const j = runJob("recomp", process.execPath, [join(here, "src/cpu/recomp.mjs"), "--calls", "369", "--executed", "--all"], 0);
      j.proc.on("close", () => { recompCache = null; }); return json(res, 200, { id: j.id }); }
    if (req.method === "POST" && p === "/api/iso") {   // the game's files from the user's disc image (xiso.mjs)
      if (game?.running) throw new Error("stop the game first"); const b = await body(req);
      const iso = String(b.path ?? "").trim().replace(/^["']|["']$/g, ""); if (!iso) throw new Error("enter the path of the disc image");
      if (!existsSync(iso) || !statSync(iso).isFile()) throw new Error(`there is no file at ${iso}`);
      if (basename(DATA).toLowerCase() !== "data") throw new Error(`the launcher's game folder (${DATA}) is not named Data: extract with xiso.mjs by hand`);
      const j = runJob("extract", process.execPath, [join(here, "src/setup/xiso.mjs"), "extract", iso, dirname(DATA), ...(b.force ? ["--force"] : [])], 100);
      return json(res, 200, { id: j.id }); }
    if (req.method === "POST" && p === "/api/cancel") { if (job?.running) job.proc.kill(); return json(res, 200, { ok: true }); }
    if (req.method === "POST" && p === "/api/clear") { const b = await body(req);
      if (!BUNDLE_RE.test(b.bundle ?? "")) throw new Error("bad picture set name");
      const d = join(TEXTURES, b.bundle); let n = 0;
      if (existsSync(d)) for (const f of readdirSync(d)) if (f.toLowerCase().endsWith(".png")) { rmSync(join(d, f)); n++; }
      return json(res, 200, { removed: n }); }
    if (req.method === "POST" && p === "/api/recheck") { findPython(); return json(res, 200, { ok: true }); }
    if (req.method === "GET" && p === "/roster.js") { res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }); return res.end(readFileSync(join(here, "src/launcher/roster-ui.js"))); }
    if (req.method === "GET" && p === "/schedules.js") { res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }); return res.end(readFileSync(join(here, "src/launcher/schedules-ui.js"))); }
    if (req.method === "GET" && p === "/brands.js") { res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }); return res.end(readFileSync(join(here, "src/launcher/brands-ui.js"))); }
    if (req.method === "GET" && p === "/sponsors.js") { res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }); return res.end(readFileSync(join(here, "src/launcher/sponsors-ui.js"))); }
    if (req.method === "GET" && p === "/rookies.js") { res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }); return res.end(readFileSync(join(here, "src/launcher/rookies-ui.js"))); }
    if (req.method === "GET" && p === "/career.js") { res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }); return res.end(readFileSync(join(here, "src/launcher/career-ui.js"))); }
    // the silly season report page (the same page as the game's /silly-season), from the active preset's save folder,
    // so it opens without the game running (<save>/silly-season.json, written after each career off-season)
    if (req.method === "GET" && p === "/silly-season") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return res.end(readFileSync(join(here, "src/render/silly-season.html"))); }
    if (req.method === "GET" && p === "/silly-season.json") { const dir = active() === "default" ? join(dirname(DATA), "save") : join(presetDir(active()), "save");
      let a = []; try { a = JSON.parse(readFileSync(join(dir, "silly-season.json"), "utf8")); } catch {}
      return json(res, 200, Array.isArray(a) ? a : []); }
    if (req.method === "GET" && p === "/help.js") { res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }); return res.end(readFileSync(join(here, "src/launcher/help-ui.js"))); }
    if (req.method === "GET" && p === "/tracks.js") { res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }); return res.end(readFileSync(join(here, "src/launcher/tracks-ui.js"))); }
    const S = srv();
    if (await S.roster(req, res, url, { json, body })) return;
    if (await S.tracks(req, res, url, { json, body })) return;
    if (await S.schedules(req, res, url, { json, body })) return;
    if (await S.career(req, res, url, { json, body })) return;
    if (await S.sponsors(req, res, url, { json, body })) return;
    json(res, 404, { error: "not found" });
  } catch (e) { json(res, 400, { error: String(e?.message ?? e) }); }
});

// ---------------------------------------------------------------- page
const PAGE = String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NASCAR Thunder 2004 — Launcher</title>
<style>
:root{--bg:#0e1116;--panel:#161b22;--line:#262d36;--text:#e6e8eb;--dim:#8b949e;--accent:#e8b923;--accent2:#d64b2a;--ok:#3fb950;--bad:#f85149}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
header{display:flex;align-items:center;gap:14px;padding:18px 24px;border-bottom:1px solid var(--line);background:linear-gradient(90deg,#1a1205,#0e1116 60%)}
header h1{margin:0;font-size:20px;letter-spacing:.5px}header h1 b{color:var(--accent)}header .sub{color:var(--dim);font-size:13px}
header .pbar{margin-left:auto;display:flex;gap:10px;align-items:center} header .pbar select{min-width:160px}
.plist{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px} .pcard{border:1px solid var(--line);border-radius:9px;padding:12px;background:#0b0e13} .pcard.on{border-color:var(--accent)} .pcard h3{margin:0 0 4px;font-size:14px} .pcard .row{gap:6px;margin-top:8px}
nav{display:flex;gap:4px;padding:0 24px;border-bottom:1px solid var(--line)}
nav button{background:none;border:0;color:var(--dim);padding:12px 14px;font:inherit;cursor:pointer;border-bottom:2px solid transparent}
nav button.on{color:var(--text);border-bottom-color:var(--accent)}
main{max-width:1100px;margin:0 auto;padding:20px 24px 40px}
section{display:none}section.on{display:block}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px;margin-bottom:16px}
.card h2{margin:0 0 12px;font-size:15px}.row{display:flex;gap:14px;align-items:center;flex-wrap:wrap}
label{color:var(--dim);font-size:13px}input,select{background:#0b0e13;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:6px 8px;font:inherit}
input[type=number]{width:90px}button.btn,a.btn{background:#222a33;color:var(--text);border:1px solid var(--line);border-radius:7px;padding:8px 14px;font:inherit;cursor:pointer}a.btn{display:inline-block;text-decoration:none}
button.btn:hover,a.btn:hover{border-color:#3b4652}button.primary{background:var(--accent);color:#1a1205;border-color:var(--accent);font-weight:600}
button.danger{color:var(--bad)}button:disabled{opacity:.5;cursor:default}
.big{font-size:16px;padding:12px 22px}.pill{display:inline-block;padding:2px 9px;border-radius:99px;font-size:12px;border:1px solid var(--line);color:var(--dim)}
.pill.ok{color:var(--ok);border-color:#235a2e}.pill.bad{color:var(--bad);border-color:#6b2522}.pill.run{color:var(--accent);border-color:#6b5512}
pre.log{background:#07090c;border:1px solid var(--line);border-radius:8px;padding:10px;height:260px;overflow:auto;font:12px/1.4 ui-monospace,Consolas,monospace;color:#c9d1d9;white-space:pre-wrap;margin:10px 0 0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:6px 14px;margin-top:8px}
.grid label{display:flex;gap:8px;align-items:center;color:var(--text);font-size:13px;padding:3px 0}
.grid small{color:var(--dim)}.hint{color:var(--dim);font-size:12.5px;margin:6px 0 0}
.bar{height:6px;background:#0b0e13;border-radius:4px;overflow:hidden;margin-top:10px}.bar i{display:block;height:100%;width:0;background:var(--accent);transition:width .3s}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left}th{color:var(--dim);font-weight:500}
a{color:var(--accent)}code{background:#0b0e13;padding:1px 5px;border-radius:4px}
@media (max-width:600px){header,nav,main{padding-left:16px;padding-right:16px}}
</style></head><body>
<header><div><h1>NASCAR <b>Thunder</b> 2004</h1><div class="sub">Launcher</div></div><div class="pbar"><label>Preset <select id="psel"></select></label><a href="#" id="pmanage">manage</a></div></header>
<nav><button data-tab="play" class="on">Play</button><button data-tab="roster">Roster</button><button data-tab="tracks">Tracks</button><button data-tab="sched">Schedules</button><button data-tab="career">Career</button><button data-tab="rookies">Rookies</button><button data-tab="sponsors">Sponsors</button><button data-tab="tex">Textures</button><button data-tab="ovr">Overrides</button><button data-tab="presets">Presets</button><button data-tab="setup">Setup</button><button data-tab="help">Help</button></nav>
<main>
<section id="play" class="on">
  <div class="card"><h2>Game</h2>
    <div class="row"><button class="btn primary big" id="start">Start game</button><button class="btn" id="stop" disabled>Stop</button>
      <span id="gstate" class="pill">stopped</span><a id="gopen" href="#" target="_blank" style="display:none">Open the game page</a><a class="btn" href="/silly-season" target="_blank">Silly season report</a></div>
    <div class="row" style="margin-top:12px"><label>Port <input type="number" id="gport" min="1024" max="65535"></label>
      <label>Start at <select id="gboot"><option value="flow">Intro (normal)</option><option value="title">Title screen (skips the intro movies)</option><option value="menu">Main menu (skips the intro and title)</option></select></label>
      <label title="How far away the catch fence and other fading track details are drawn (the game fades them out ahead of you)">Catch fence distance <select id="gfade"><option value="1">1x (the game's)</option><option value="1.5">1.5x</option><option value="2">2x</option><option value="3">3x</option><option value="4">4x</option></select></label>
      <label style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="gunlock"> Unlock everything</label></div>
    <p class="hint" id="gunlockhint" style="display:none;margin:6px 0 0">Every Thunder Plate goes to all four profiles when the game starts: all cars and drivers, the locked races and tracks (night, infield, fantasy, All-Star, Shootout), Create-A-Car templates and paints, every sponsor level and the extras. A profile saved while this is on keeps them after you turn it off.</p>
    <div class="row" style="margin-top:12px"><label>Online <select id="gnet"><option value="off">Off (single player)</option><option value="host">Host a race</option><option value="join">Join a race</option></select></label>
      <label>Your name <input id="gnetname" maxlength="24" placeholder="Player"></label>
      <label class="neton">Relay server <input id="gnetrelay" placeholder="none: direct connection"></label>
      <label class="netjoin">Host address or race <input id="gnetaddr" placeholder="192.168.1.20"></label>
      <label>Online port <input type="number" id="gnetport" min="1024" max="65535"></label></div>
    <div id="gnetraces" class="hint"></div>
    <div id="gnetinfo" class="hint"></div>
    <p class="hint">The game opens in a new tab once it has started. Captures (F9 with <code>?capture=1</code>) can be viewed at <a id="greplay" href="#" target="_blank">/replay</a> while the game runs.</p>
    <p class="hint" id="gnodata" style="display:none;color:var(--bad)">The game's files are not set up yet: see <a href="#" id="gtosetup">Setup → Game files</a>.</p>
    <pre class="log" id="glog"></pre></div>
</section>
<section id="roster"></section>
<section id="tracks"></section>
<section id="sched"></section>
<section id="career"></section>
<section id="rookies"></section>
<section id="sponsors"></section>
<section id="tex">
  <div class="card"><h2>Upscale pictures</h2>
    <div class="row"><button class="btn" data-sel="port">Portraits</button><button class="btn" data-sel="photo">Photos</button><button class="btn" data-sel="flat">Menus, HUD &amp; fonts</button><button class="btn" data-sel="all">All</button><button class="btn" data-sel="none">None</button></div>
    <div class="grid" id="ubundles"></div>
    <div class="row" style="margin-top:14px">
      <label>Model <select id="umodel"></select></label>
      <label>Clean-up model <select id="upre"></select></label>
      <label>Size <select id="uscale"><option value="1.5">1.5×</option><option value="2">2×</option><option value="3">3×</option><option value="4">4×</option></select></label>
      <label>Soften first <input type="range" id="usoften" min="0" max="1.5" step="0.1" style="vertical-align:middle"> <span id="usoftenv"></span></label>
      <label><input type="checkbox" id="uover"> Replace existing</label></div>
    <details style="margin-top:10px"><summary style="cursor:pointer;color:var(--dim)">Advanced</summary>
      <div class="row" style="margin-top:8px"><label>Tile size <input type="number" id="utile" min="0" max="4096" step="64"></label>
      <label>Device <select id="udevice"><option value="">automatic</option><option value="cuda">graphics card (CUDA)</option><option value="cpu">CPU</option></select></label>
      <label><input type="checkbox" id="ufp16"> Half precision (faster on the graphics card)</label></div></details>
    <p class="hint">Without a model the pictures are resized smoothly (fast, softer). Put model files (.pth / .safetensors, e.g. from openmodeldb.info) in <code id="mdir"></code>. Photos: a realistic model with a little softening; menus and fonts: an anime / cartoon model or plain resize. Restart the game to see new pictures.</p>
    <div class="row" style="margin-top:12px"><button class="btn primary" id="urun">Upscale</button><button class="btn danger" id="ucancel" disabled>Cancel</button><span id="ustate" class="pill">idle</span></div>
    <div class="bar"><i id="ubar"></i></div><pre class="log" id="ulog"></pre></div>
  <div class="card"><h2>Export pictures to PNG</h2>
    <p class="hint" style="margin-top:0">Saves the original pictures of the sets ticked above to <code id="edir"></code>, to look at or edit by hand. Edited files go in the override folder under the same names.</p>
    <div class="row" style="margin-top:10px"><button class="btn" id="erun">Export ticked sets</button></div></div>
</section>
<section id="ovr">
  <div class="card"><h2>Pictures in use</h2>
    <p class="hint" style="margin-top:0">Replacement pictures in <code id="tdir"></code>. The game uses them in place of the originals from its next start.</p>
    <table><thead><tr><th>Set</th><th>Folder</th><th>Replacements</th><th></th></tr></thead><tbody id="otable"></tbody></table></div>
</section>
<section id="presets">
  <div class="card"><h2>Presets</h2>
    <p class="hint" style="margin-top:0">A preset is a separate copy of your game: its own drivers, teams, sponsors, tracks, schedules and career settings (everything in the Roster, Tracks, Schedules, Career, Rookies and Sponsors tabs), its own saves (seasons, careers, profiles, EA SPORTS Bio) and its own "Unlock everything". Switching presets never changes or removes anything in another one. Shared by all presets: the game itself, upscaled pictures, models and the other launcher settings. Stop the game before switching.</p>
    <div id="plist" class="plist"></div></div>
  <div class="card"><h2>New preset</h2>
    <div class="row"><label>Name <input id="pname" maxlength="40" placeholder="e.g. 1990s season"></label>
      <label>Start from <select id="pfrom"><option value="">Nothing: the plain game</option></select></label>
      <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="pcopysaves"> also copy its saves</label>
      <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="pswitch" checked> switch to it</label>
      <button class="btn primary" id="pcreate">Create preset</button></div>
    <p class="hint">"Start from" copies that preset's drivers, teams, sponsors, tracks, schedules and settings, so you can change them without touching the original. Saves are only copied when ticked (otherwise the new preset starts with no saves: new profiles, seasons and careers).</p></div>
</section>
<section id="help"></section>
<section id="setup">
  <div class="card"><h2>Game files</h2><div id="isoinfo"></div>
    <p class="hint">The launcher needs the game's files from your own copy of NASCAR Thunder 2004: <code>default.xbe</code> and the <code>Data</code> folder. Take them straight out of a disc image of your game (an <code>.iso</code> / <code>.xiso</code>: XDVDFS images and full Redump images both work). In Windows, Shift + right-click the image and choose "Copy as path", then paste it here.</p>
    <div class="row" style="margin-top:10px"><input id="isopath" placeholder="C:\Games\NASCAR Thunder 2004 (USA).iso" style="flex:1;min-width:280px">
      <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="isoforce"> Replace files already there</label>
      <button class="btn primary" id="isorun">Extract</button><span id="isostate" class="pill">idle</span></div>
    <div class="bar"><i id="isobar"></i></div><pre class="log" id="isolog" style="height:140px"></pre></div>
  <div class="card"><h2>Game code</h2><div id="rcinfo"></div>
    <p class="hint">The game's own code, recompiled for your computer from <code>default.exe</code> (<code>recomp.wasm</code>). Without it the game still runs, but the first races stutter (pauses of up to a second while it warms up a cache) and after that the game code takes about twice the processor time. The download includes the compiler this needs (clang, in <code>tools/llvm</code>). If it is missing or blocked, install LLVM yourself (on Windows the <code>LLVM-…-win64.exe</code> installer from <a href="https://github.com/llvm/llvm-project/releases" target="_blank">the LLVM releases</a>), then press "Check again". It takes about 5–10 minutes and uses every processor core.</p>
    <div class="row" style="margin-top:10px"><button class="btn primary" id="rcrun">Build game code</button><button class="btn" id="rccheck">Check again</button><span id="rcstate" class="pill">idle</span></div>
    <div class="bar"><i id="rcbar"></i></div><pre class="log" id="rclog" style="height:140px"></pre></div>
  <div class="card"><h2>Python</h2><div id="pyinfo"></div>
    <div class="row" style="margin-top:12px"><button class="btn" id="inst">Install basics (numpy, pillow)</button><button class="btn" id="instai">Install AI loader (spandrel)</button><button class="btn" id="recheck">Check again</button></div>
    <p class="hint">AI upscaling also needs PyTorch. For an NVIDIA graphics card install the CUDA build from <a href="https://pytorch.org/get-started/locally/" target="_blank">pytorch.org</a> (pick pip, your Python and CUDA), then press "Check again". Without it the models run on the CPU, slowly.</p></div>
</section>
</main>
<script>
const $ = id => document.getElementById(id);
let st = null, glogNext = 0, ulogNext = 0, ujob = 0;
const api = async (path, data) => { const r = await fetch(path, data === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; };
const say = e => alert(e.message || e);
document.querySelectorAll("nav button").forEach(b => b.onclick = () => { document.querySelectorAll("nav button, section").forEach(x => x.classList.remove("on")); b.classList.add("on"); $(b.dataset.tab).classList.add("on"); });
const SETS = { port: ["uis_drpo", "uis_drps"], photo: ["uis_drpo", "uis_drps", "uis_cars", "uis_pltl", "uis_plts", "uis_trpc", "uis_crew", "uis_back"],
  flat: ["uis_comn", "uis_fe", "uis_ig", "uis_icon", "uis_text", "uis_font", "uis_logo", "uis_trlg", "uis_spon", "uis_smnm", "uis_drnm", "uis_gene", "uis_race", "uis_shop", "uis_smap", "uis_trop", "uis_awar", "uis_cont", "uis_over", "uis_spdl"] };
function ticked() { return [...document.querySelectorAll("#ubundles input:checked")].map(i => i.value); }
document.querySelectorAll("[data-sel]").forEach(b => b.onclick = () => { const s = b.dataset.sel; document.querySelectorAll("#ubundles input").forEach(i => i.checked = s === "all" ? true : s === "none" ? false : SETS[s].includes(i.value)); });
function fillSelect(sel, list, cur, none) { sel.innerHTML = '<option value="">' + none + '</option>' + list.map(m => '<option>' + m.replace(/&/g, "&amp;").replace(/</g, "&lt;") + '</option>').join(""); sel.value = list.includes(cur) ? cur : ""; }
// ---- presets
const pesc = v => String(v ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const psize = b => b.bytes > 1e9 ? (b.bytes / 1e9).toFixed(1) + " GB" : b.bytes > 1e6 ? (b.bytes / 1e6).toFixed(1) + " MB" : Math.round(b.bytes / 1e3) + " KB";
async function presets() {
  const P = await api("/api/presets");
  $("psel").innerHTML = P.presets.map(x => '<option value="' + x.id + '"' + (x.id === P.active ? " selected" : "") + '>' + pesc(x.name) + '</option>').join("");
  $("pfrom").innerHTML = '<option value="">Nothing: the plain game</option>' + P.presets.map(x => '<option value="' + x.id + '"' + (x.id === P.active ? " selected" : "") + '>' + pesc(x.name) + '</option>').join("");
  $("plist").innerHTML = P.presets.map(x => '<div class="pcard' + (x.id === P.active ? " on" : "") + '" data-id="' + x.id + '"><h3>' + pesc(x.name) + (x.id === P.active ? ' <span class="pill ok">in use</span>' : "") + '</h3>'
    + '<div class="hint" style="margin:0">' + x.drivers + ' added driver' + (x.drivers === 1 ? "" : "s") + ' · ' + x.roster.files + ' files (' + psize(x.roster) + ') · saves ' + psize(x.save) + (x.unlockAll ? " · everything unlocked" : "") + (x.id === "default" ? " · the launcher's own folders" : "") + '</div>'
    + '<div class="row">' + (x.id === P.active ? "" : '<button class="btn primary" data-a="switch">Switch to it</button>') + '<button class="btn" data-a="rename">Rename</button><button class="btn" data-a="copy">Copy…</button>' + (x.id === "default" || x.id === P.active ? "" : '<button class="btn danger" data-a="delete">Remove</button>') + '</div></div>').join("");
  $("plist").querySelectorAll("button[data-a]").forEach(b => b.onclick = async () => { const id = b.closest(".pcard").dataset.id, x = P.presets.find(y => y.id === id);
    try {
      if (b.dataset.a === "switch") { await api("/api/presets", { action: "switch", id }); location.reload(); }
      if (b.dataset.a === "rename") { const n = prompt("New name for " + x.name, x.name); if (n) { await api("/api/presets", { action: "rename", id, name: n }); presets(); } }
      if (b.dataset.a === "copy") { $("pfrom").value = id; $("pname").value = x.name + " copy"; $("pname").focus(); }
      if (b.dataset.a === "delete" && confirm("Remove the preset " + x.name + "? Its drivers, pictures, tracks and saves (" + psize(x.save) + ") are deleted for good.")) { await api("/api/presets", { action: "delete", id }); presets(); }
    } catch (e) { say(e); } });
  return P;
}
$("psel").onchange = async () => { try { await api("/api/presets", { action: "switch", id: $("psel").value }); location.reload(); } catch (e) { say(e); presets(); } };
$("pmanage").onclick = e => { e.preventDefault(); document.querySelector('nav button[data-tab="presets"]').click(); };
$("pcreate").onclick = async () => { try { const r = await api("/api/presets", { action: "create", name: $("pname").value, from: $("pfrom").value || null, copySaves: $("pcopysaves").checked, switch: $("pswitch").checked }); if ($("pswitch").checked) location.reload(); else { $("pname").value = ""; presets(); } } catch (e) { say(e); } };
presets().catch(() => {});
async function load() {
  st = await api("/api/status"); const u = st.settings.upscale;
  $("ubundles").innerHTML = st.bundles.map(b => '<label><input type="checkbox" value="' + b.name + '"' + (u.bundles.includes(b.name) || u.bundles.includes("ui") ? " checked" : "") + '> ' + b.label + ' <small>' + b.name + '</small></label>').join("");
  fillSelect($("umodel"), st.models, u.model, "none: smooth resize"); fillSelect($("upre"), st.models, u.pre, "none");
  $("uscale").value = String(u.scale); $("usoften").value = u.soften; $("usoftenv").textContent = Number(u.soften).toFixed(1); $("uover").checked = !!u.overwrite;
  $("utile").value = u.tile; $("udevice").value = u.device || ""; $("ufp16").checked = !!u.fp16;
  $("gport").value = st.settings.game.port; $("gboot").value = st.settings.game.boot; $("gfade").value = String(st.settings.game.fadeScale ?? 1); $("gunlock").checked = !!st.preset.unlockAll; $("gunlockhint").style.display = $("gunlock").checked ? "" : "none";
  $("gnetrelay").value = st.settings.game.netRelay || ""; $("gnet").value = st.settings.game.net || "off"; $("gnetname").value = st.settings.game.netName || ""; $("gnetaddr").value = st.settings.game.netAddress || ""; $("gnetport").value = st.settings.game.netPort || 27104; netShow();
  $("mdir").textContent = st.modelsDir; $("edir").textContent = st.exports; $("tdir").textContent = st.textures;
  renderOverrides(); renderPython(); renderGameFiles(); renderRecomp(); tick();
}
$("usoften").oninput = () => $("usoftenv").textContent = Number($("usoften").value).toFixed(1);
function renderOverrides() {
  $("otable").innerHTML = st.bundles.filter(b => b.overrides).map(b => '<tr><td>' + b.label + '</td><td><code>' + b.name + '</code></td><td>' + b.overrides + '</td><td><button class="btn danger" data-clear="' + b.name + '">Remove</button></td></tr>').join("") || '<tr><td colspan="4" style="color:var(--dim)">None yet. Upscale some pictures in the Textures tab.</td></tr>';
  document.querySelectorAll("[data-clear]").forEach(b => b.onclick = async () => { if (!confirm("Remove the replacement pictures of " + b.dataset.clear + "? The originals are used again.")) return; try { await api("/api/clear", { bundle: b.dataset.clear }); load(); } catch (e) { say(e); } });
}
function renderPython() {
  const p = st.python, pill = (ok, t) => '<span class="pill ' + (ok ? "ok" : "bad") + '">' + t + '</span> ';
  if (!p) { $("pyinfo").innerHTML = pill(false, "Python not found") + '<p class="hint">Install Python 3 from <a href="https://www.python.org/downloads/" target="_blank">python.org</a> (tick "Add python.exe to PATH"), then press "Check again".</p>'; return; }
  const k = p.packages || {};
  $("pyinfo").innerHTML = '<p style="margin:0 0 8px">' + p.version + ' <small style="color:var(--dim)">(' + p.cmd + ')</small></p>' + pill(k.numpy, "numpy") + pill(k.PIL, "pillow") + pill(k.spandrel, "spandrel") + pill(k.torch, "PyTorch") + (k.torch ? pill(k.cuda, k.cuda ? "GPU: " + (k.gpu || "CUDA") : "no CUDA (CPU only)") : "");
}
function appendLog(el, lines) { if (!lines.length) return; const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 20; el.textContent += lines.join("\n") + "\n"; if (atEnd) el.scrollTop = el.scrollHeight; }
async function tick() {
  try {
    const s = await api("/api/status"); st.game = s.game; st.job = s.job;
    const g = s.game, running = g && g.running;
    $("start").disabled = !!running; $("stop").disabled = !running;
    $("gstate").className = "pill " + (running ? (g.ready ? "ok" : "run") : ""); $("gstate").textContent = running ? (g.ready ? "running on port " + g.port : "starting…") : "stopped";
    const link = "http://localhost:" + (g ? g.port : $("gport").value); $("gopen").href = link; $("gopen").style.display = running && g.ready ? "" : "none"; $("greplay").href = link + "/replay";
    if (running && g.ready && !window.__opened) { window.__opened = true; window.open(link, "_blank"); }
    if (!running) window.__opened = false;
    const gl = await api("/api/log?which=game&since=" + glogNext); appendLog($("glog"), gl.lines); glogNext = gl.next;
    const j = s.job;
    if (j) {
      if (j.id !== ujob) { ujob = j.id; ulogNext = 0; $("ulog").textContent = ""; }
      const ul = await api("/api/log?which=job&since=" + ulogNext); appendLog($("ulog"), ul.lines); ulogNext = ul.next;
      if (j.kind === "recomp") { if (window.__rcJob !== j.id) { window.__rcJob = j.id; $("rclog").textContent = ""; } appendLog($("rclog"), ul.lines);
        $("rcstate").className = "pill " + (j.running ? "run" : j.code === 0 ? "ok" : "bad"); $("rcstate").textContent = j.running ? (j.total ? "compiling " + j.step + " of " + j.total : "preparing…") : j.code === 0 ? "built" : "stopped";
        $("rcbar").style.width = (j.running ? (j.total ? Math.round(100 * j.step / j.total) : 3) : j.code === 0 ? 100 : 0) + "%"; $("rcrun").disabled = j.running;
        if (!j.running && window.__rcDone !== j.id) { window.__rcDone = j.id; const s4 = await api("/api/status"); st.recomp = s4.recomp; renderRecomp(); } }
      if (j.kind === "extract") { if (window.__isoJob !== j.id) { window.__isoJob = j.id; $("isolog").textContent = ""; } appendLog($("isolog"), ul.lines);
        $("isostate").className = "pill " + (j.running ? "run" : j.code === 0 ? "ok" : "bad"); $("isostate").textContent = j.running ? "extracting… " + j.step + "%" : j.code === 0 ? "done" : "stopped";
        $("isobar").style.width = (j.running ? j.step : j.code === 0 ? 100 : 0) + "%"; $("isorun").disabled = j.running;
        if (!j.running && window.__isoDone !== j.id) { window.__isoDone = j.id; const s3 = await api("/api/status"); Object.assign(st, { dataFound: s3.dataFound, xbeFound: s3.xbeFound, bundles: s3.bundles }); renderGameFiles(); renderOverrides(); } }
      $("ustate").className = "pill " + (j.running ? "run" : j.code === 0 ? "ok" : "bad");
      $("ustate").textContent = j.running ? j.kind + " running… " + (j.total ? "set " + j.step + " of " + j.total + ", " : "") + j.done + " pictures" : j.kind + (j.code === 0 ? " finished: " + j.done + " pictures written" : " stopped");
      $("urun").disabled = $("erun").disabled = $("inst").disabled = $("instai").disabled = j.running; $("ucancel").disabled = !j.running;
      $("ubar").style.width = j.running ? (j.total ? Math.round(100 * Math.max(0, j.step - 0.5) / j.total) + "%" : "5%") : j.code === 0 ? "100%" : "0";
      if (!j.running && window.__jobDone !== j.id) { window.__jobDone = j.id; const s2 = await api("/api/status"); st.bundles = s2.bundles; st.python = s2.python; renderOverrides(); renderPython(); }
    }
  } catch {}
  setTimeout(tick, 800);
}
function renderRecomp() {
  const r = st.recomp; if (!r) return;
  const S = { ready: ["ok", "built for this default.exe"], missing: ["bad", "not built"], other: ["bad", "built for another default.exe: build again"] }[r.state];
  $("rcinfo").innerHTML = '<span class="pill ' + S[0] + '">' + S[1] + '</span> <span class="hint">compiler: ' + (r.compiler.ok ? esc(r.compiler.version) + ' <code>' + esc(r.compiler.clang) + '</code>' : esc(r.compiler.why)) + '</span>';
  $("rcrun").disabled = !r.compiler.ok || !r.exe;
}
$("rcrun").onclick = async () => { try { await api("/api/recomp", {}); $("rcstate").textContent = "starting…"; } catch (e) { say(e); } };
$("rccheck").onclick = async () => { try { st.recomp = await api("/api/recomp", { check: true }); renderRecomp(); } catch (e) { say(e); } };
function renderGameFiles() {
  const ok = st.dataFound && st.xbeFound;
  $("isoinfo").innerHTML = '<span class="pill ' + (ok ? "ok" : "bad") + '">' + (ok ? "found" : "missing") + '</span> <span class="hint">' + (st.xbeFound ? "default.xbe ✓" : "default.xbe missing") + " · " + (st.dataFound ? "Data folder ✓" : "Data folder missing") + ' — in <code>' + esc(st.dataDir.replace(/[\\/]Data$/i, "")) + '</code></span>';
  $("gnodata").style.display = ok ? "none" : "";
}
$("gtosetup").onclick = e => { e.preventDefault(); document.querySelector('nav button[data-tab="setup"]').click(); };
$("isorun").onclick = async () => { try { await api("/api/iso", { path: $("isopath").value, force: $("isoforce").checked }); $("isostate").textContent = "starting…"; } catch (e) { say(e); } };
$("gunlock").onchange = () => { $("gunlockhint").style.display = $("gunlock").checked ? "" : "none"; };
$("start").onclick = async () => { try { glogNext = 0; $("glog").textContent = ""; await api("/api/game/start", { port: Number($("gport").value), boot: $("gboot").value, fadeScale: Number($("gfade").value), unlockAll: $("gunlock").checked, net: $("gnet").value, netName: $("gnetname").value, netAddress: $("gnetaddr").value, netPort: Number($("gnetport").value), netRelay: $("gnetrelay").value }); } catch (e) { say(e); } };
// online: what to fill in, and while the game runs who is connected
const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
function netShow() { const m = $("gnet").value; document.querySelectorAll(".netjoin").forEach(e => e.style.display = m === "join" ? "" : "none"); document.querySelectorAll(".neton").forEach(e => e.style.display = m === "off" ? "none" : ""); $("gnetport").parentElement.style.display = m === "off" || $("gnetrelay").value.trim() ? "none" : ""; $("gnetname").parentElement.style.display = m === "off" ? "none" : ""; netInfo(); }
$("gnet").onchange = netShow;
async function netInfo() {
  const m = $("gnet").value, box = $("gnetinfo"); if (m === "off") { box.innerHTML = ""; return; }
  let r = null; try { r = await api("/api/net"); } catch {}
  const relay = $("gnetrelay").value.trim();
  netRaces(m === "join" && relay ? relay : null);
  const how = relay ? (m === "host" ? "Your race is listed on the relay " + esc(relay) + " once the game starts; nobody needs to forward a port. Joiners connect straight to you when the routers allow it (the relay only introduces you), through the relay when not. " : "Pick a race from the relay's list (it fills in the race), then Start. ")
    : m === "host"
    ? "The game asks your router to open the port (UPnP) and shows the address to give out below once it has. If the router will not, others on your network join with this computer's address" + (r?.addresses?.length ? " (" + r.addresses.map(esc).join(", ") + " on your network)" : "") + " and online port " + esc($("gnetport").value) + ". Over the internet, forward that port (TCP) on your router to this computer and give them your public address."
    : "Enter the address the host gave you. ";
  const i = r?.info; let live = "";
  const PH = { menu: "in the menus", pre: "on the pre-race screen", grid: "on the grid", race: "racing" };
  if (i && i.role) live = "<br><b>" + esc(i.status || "") + "</b>" + (i.race ? " · race: " + esc(i.race) : "") + (i.players?.length ? "<br>" + i.players.map(p => esc(p.name) + " — " + esc(p.car) + (p.id === i.id ? " (you)" : ", " + (PH[p.phase] || p.phase) + (p.rtt != null ? ", " + p.rtt + " ms" : ""))).join("<br>") : "")
    + (i.waiting ? "<br>The start waits for: " + esc(i.waiting) : "") + (i.warnings?.length ? "<br><span style='color:#f0a040'>" + i.warnings.map(esc).join("<br>") + "</span>" : "");
  box.innerHTML = how + " How a race goes: everyone opens Race Now and picks a driver (each a different one); the host then picks the track and starts; the others pick any track and get the host's race, settings and grid. The pre-race screen and the green flag wait for the host's A; cautions, restarts, laps and the finishing order come from the host." + live;
}
setInterval(() => { if ($("gnet").value !== "off" && document.querySelector("#play.on")) netInfo(); }, 3000);
$("gnetrelay").onchange = netShow;
async function netRaces(relay) {
  const box = $("gnetraces"); if (!relay) { box.innerHTML = ""; return; }
  let r; try { r = await api("/api/net/races?relay=" + encodeURIComponent(relay)); } catch (e) { r = { error: String(e.message || e) }; }
  if (r.error) { box.innerHTML = "<span style='color:#f0a040'>" + esc(r.error) + "</span>"; return; }
  const PH = { menu: "in the menus", pre: "on the pre-race screen", grid: "on the grid", race: "racing" };
  box.innerHTML = r.races?.length ? "<b>Races on " + esc(relay) + "</b> (click one to join it)<br>" + r.races.map(x => "<a href='#' data-race='" + esc(x.id) + "' style='" + ($("gnetaddr").value === x.id ? "font-weight:bold" : "") + "'>" + esc(x.name) + "'s race</a> — " + esc(x.race || "no track yet") + ", " + x.players.length + " driver" + (x.players.length === 1 ? "" : "s") + ", " + (PH[x.phase] || x.phase) + (x.p2p ? ", direct link possible" : "") + (x.full ? " (full)" : "")).join("<br>") : "No open races on " + esc(relay) + " yet.";
  box.querySelectorAll("a[data-race]").forEach(a => a.onclick = e => { e.preventDefault(); $("gnetaddr").value = a.dataset.race; netRaces(relay); });
}
$("stop").onclick = () => api("/api/game/stop", {}).catch(say);
$("urun").onclick = async () => { try { await api("/api/upscale", { bundles: ticked(), model: $("umodel").value, pre: $("upre").value, scale: Number($("uscale").value), soften: Number($("usoften").value), overwrite: $("uover").checked, tile: Number($("utile").value), fp16: $("ufp16").checked, device: $("udevice").value }); } catch (e) { say(e); } };
$("ucancel").onclick = () => api("/api/cancel", {}).catch(say);
$("erun").onclick = async () => { try { await api("/api/export", { bundles: ticked() }); document.querySelector('[data-tab=tex]').click(); } catch (e) { say(e); } };
$("inst").onclick = () => api("/api/install", {}).then(() => document.querySelector('[data-tab=tex]').click()).catch(say);
$("instai").onclick = () => api("/api/install", { ai: true }).then(() => document.querySelector('[data-tab=tex]').click()).catch(say);
$("recheck").onclick = async () => { try { await api("/api/recheck", {}); load(); } catch (e) { say(e); } };
load().catch(say);
</script><script src="/roster.js"></script><script src="/tracks.js"></script><script src="/schedules.js"></script><script src="/career.js"></script><script src="/rookies.js"></script><script src="/sponsors.js"></script><script src="/brands.js"></script><script src="/help.js"></script></body></html>`;

// ---------------------------------------------------------------- start
findPython();
server.listen(PORT, "127.0.0.1", () => {
  const url = `http://localhost:${PORT}`;
  console.log(`NASCAR Thunder 2004 launcher: ${url}` + (python ? `  (${python.version})` : "  (Python not found: texture tools unavailable)"));
  if (!argv.includes("--no-open")) {
    const [c, a] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    try { spawn(c, a, { stdio: "ignore", detached: true, windowsHide: true }).unref(); } catch {}
  }
});
const shutdown = () => { try { game?.proc.kill(); job?.proc.kill(); } catch {} process.exit(0); };
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
