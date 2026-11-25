// tracks-server.mjs — the launcher's Tracks tab, server side: track packs in roster/tracks/<id>/ (see track-pack.mjs
// for the pack format and what a slot is). Builds run as a separate process (node track-pack.mjs build) so the
// launcher stays responsive.
//
// API (JSON unless noted):
//   GET  /api/tracks                          { packs: [{ id, dir, meta, files, state }], slots, conflicts }
//   POST /api/tracks/new   { name, slot, from: "game" | "empty", mode: "add" | "replace", track }   new pack ("game":
//                                             starter pack exported from the slot's own model, to edit; "empty":
//                                             upload a model afterwards). "add": a new track based on the slot's track
//                                             and race, with ids of its own (track-pack.mjs); "replace": the slot itself
//   POST /api/tracks/save  { id, meta }       name, author, slots (replace), track (add), enabled, model; add: layout,
//                                             physics, lines (glTF files in the pack: gltf-layout.mjs), layoutOptions
//   PUT  /api/tracks/file?id=&name=<relative path>   body: the file (model .glb / .gltf / .bin / .png)
//   POST /api/tracks/build { id }             builds; returns { ok, log }
//   GET  /api/tracks/layout.svg?id=          the built layout (new red over the base grey)
//   POST /api/tracks/delete { id }
//   POST /api/tracks/nr2003-gltf { folder, objects?: [folder], out? }   an NR2003 track folder on this computer -> three
//                                             .glb files (scenery, physics, racing lines: nr2003-gltf.mjs) in out
//                                             (default roster/converted/<name>/) to edit in Blender; { out, files, track, log }
//   GET  /api/tracks/converted                { root, items: [{ dir, name, files, track }] } (roster/converted/*)
//   POST /api/tracks/new { ..., from: "converted", converted: <dir> }   a pack with a converted track's three files
//   POST /api/tracks/objects { source: "game", slot } | { source: "nr2003", folders: [folder] }   an object library
//                                             (objects-export.mjs) in roster/objects/; { dir, count, objects }
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { spawn } from "node:child_process";
import { trackSlots, exportStarter, buildState, readPack, FIRST_RTID } from "../tracks/track-pack.mjs";
import { openDatabases } from "../game/nascar-db.mjs";
import { nr2003ToGLTF } from "../tracks/nr2003-gltf.mjs";
import { exportGameObjects, exportNR2003Objects } from "../tracks/objects-export.mjs";
import { copyFileSync } from "node:fs";

const FILE_RE = /^[\w .()+-]+(\/[\w .()+-]+)*\.(glb|gltf|bin|png|json)$/i;

export function createTracks({ here, data, user = here }) {   // (user: the preset's folder, launcher.mjs)
  const root = join(user, "roster", "tracks"), convRoot = join(user, "roster", "converted"), objRoot = join(user, "roster", "objects"); let slots = null, building = new Set(), db = null;
  const converted = () => !existsSync(convRoot) ? [] : readdirSync(convRoot).filter(d => statSync(join(convRoot, d)).isDirectory()).sort().flatMap(d => { const t = readdirSync(join(convRoot, d)).find(f => /_track\.json$/i.test(f)); if (!t) return [];
    try { const j = JSON.parse(readFileSync(join(convRoot, d, t), "utf8")); return [{ dir: d, path: join(convRoot, d), name: j.track?.name ?? d, files: j.files ?? {}, track: j.track ?? {} }]; } catch { return []; } });
  const base = () => db ??= openDatabases(["NASCAR.DB", "GMODEDB.DAT"].map(f => join(data, f)).filter(existsSync));
  const txt = (v, n) => String(v ?? "").replace(/[^\x20-\x7e]/g, "").trim().slice(0, n);
  const trackInfo = t => ({ name: txt(t?.name, 38), short: txt(t?.short, 21), city: txt(t?.city, 18), state: txt(t?.state, 2).toUpperCase(), race: txt(t?.race, 34), laps: Math.max(0, Math.min(9999, Math.round(+t?.laps || 0))) || undefined });
  // ids for an added track: the next free ones after the game's and every other pack's (the game's tables and
  // arrays are sized for its own counts, so the ids stay as low as they can)
  const newIds = () => { const T = base().tables.get("TRCK").rows, used = { trid: new Set(T.map(r => r.TRID)), tphd: new Set(T.map(r => r.TPHD)), tpid: new Set(T.map(r => r.TPID)), raid: new Set(base().tables.get("RACE").rows.map(r => r.RAID)), rtid: new Set([...getSlots().map(s => s.slot), ...Array.from({ length: FIRST_RTID }, (_, i) => i)]) };
    for (const p of list()) if (p.meta?.ids) for (const k of Object.keys(used)) if (Number.isInteger(p.meta.ids[k])) used[k].add(p.meta.ids[k]);
    const next = k => { let i = Math.max(...used[k]) + 1; for (const p of list()) if (p.meta?.ids?.[k] >= i) i = p.meta.ids[k] + 1; if (i > 250) throw new Error("too many added tracks"); return i; };
    return { trid: next("trid"), tphd: next("tphd"), tpid: next("tpid"), raid: next("raid"), rtid: next("rtid") }; };
  const getSlots = () => slots ??= trackSlots(data, root);
  const dirOf = id => { if (!/^[\w-]{1,48}$/.test(id ?? "")) throw new Error("bad pack id"); const d = join(root, id); if (!existsSync(join(d, "track.json"))) throw new Error("no such track pack"); return d; };
  // packs made before model ids started at FIRST_RTID (76 / 77 are tk_score.dat entries of the game's own): new id
  const migrate = () => { if (!existsSync(root)) return; for (const id of readdirSync(root)) { const f = join(root, id, "track.json"); if (!existsSync(f)) continue;
    try { const m = JSON.parse(readFileSync(f, "utf8")); if (m.mode === "add" && m.ids && m.ids.rtid < FIRST_RTID) { m.ids = { ...m.ids, rtid: undefined }; writeFileSync(f, JSON.stringify(m, null, 2)); m.ids.rtid = newIds().rtid; writeFileSync(f, JSON.stringify(m, null, 2)); } } catch {} } };
  let migrated = false;
  const list = () => {
    if (!migrated) { migrated = true; migrate(); }
    if (!existsSync(root)) return [];
    return readdirSync(root).filter(id => existsSync(join(root, id, "track.json"))).sort().map(id => {
      const dir = join(root, id), st = buildState(dir), files = [];
      const walk = d => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { if (!(d === dir && n === "build")) walk(p); } else files.push(relative(dir, p).split(sep).join("/")); } }; walk(dir);
      return { id, dir, meta: st.meta ?? null, files: files.filter(f => !/\.png$/i.test(f) || !f.includes("/")).concat(files.some(f => /\/.*\.png$/i.test(f)) ? [`(${files.filter(f => /\/.*\.png$/i.test(f)).length} pictures in folders)`] : []),
        state: st.error ? { error: st.error } : { built: st.built, fresh: !!st.fresh, building: building.has(id), info: st.build ?? null } };
    });
  };
  const conflicts = packs => { const by = new Map(); for (const p of packs) if (p.meta?.enabled && p.meta.mode !== "add") for (const s of p.meta.slots) { if (!by.has(s)) by.set(s, []); by.get(s).push(p.id); }
    return [...by].filter(([, ids]) => ids.length > 1).map(([slot, ids]) => ({ slot, ids, used: ids.at(-1) })); };
  const newId = name => { const base = (String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "track").slice(0, 40); let id = base, n = 2; while (existsSync(join(root, id))) id = `${base}-${n++}`; return id; };

  return async function handle(req, res, url, { json, body }) {
    const p = url.pathname; if (!p.startsWith("/api/tracks")) return false;
    const q = k => url.searchParams.get(k);
    if (req.method === "GET" && p === "/api/tracks") { const packs = list(); json(res, 200, { root, packs, slots: getSlots(), conflicts: conflicts(packs) }); return true; }
    if (req.method === "POST" && p === "/api/tracks/new") {
      const b = await body(req), slot = Number(b.slot), s = getSlots().find(x => x.slot === slot); if (!s) throw new Error("pick a track");
      const add = b.mode !== "replace", track = trackInfo(b.track ?? {});
      const name = txt(b.name, 60) || track.name || (add ? `New track (from ${s.track})` : `${s.track} (custom)`), id = newId(name), dir = join(root, id);
      let extra = { mode: "replace" };
      if (add) { const race = base().tables.get("RACE").rows.filter(r => r.RTID === slot).sort((x, y) => x.RAID - y.RAID)[0]; if (!race) throw new Error("that track model is not used by any race");
        const tr = base().tables.get("TRCK").rows.find(r => r.TRID === race.TRID);
        extra = { mode: "add", base: { slot, trid: race.TRID, raid: race.RAID, tpid: tr?.TPID }, ids: newIds(),
          track: { ...trackInfo({ name: tr?.TRNM, short: tr?.TSNM, city: tr?.CITY, state: tr?.STAT, race: race.RNAM, laps: race.RLAP }), ...Object.fromEntries(Object.entries(track).filter(([, v]) => v)) } };
        if (!track.name) extra.track.name = name; if (!track.short) extra.track.short = txt(name, 21); if (!track.race) extra.track.race = txt(`${name} 400`, 34); }
      mkdirSync(dir, { recursive: true });
      try {
        if (b.from === "game") exportStarter(data, slot, dir, { name });
        let files = {}; if (b.from === "converted") { if (!add) throw new Error("a converted track is added as a new track");
          const c = converted().find(x => x.dir === b.converted); if (!c) throw new Error("no such converted track");
          for (const k of ["scenery", "physics", "lines"]) if (c.files[k] && existsSync(join(c.path, c.files[k]))) { copyFileSync(join(c.path, c.files[k]), join(dir, c.files[k])); files[k] = c.files[k]; }
          if (!files.physics) throw new Error("the converted track has no physics file");
          extra.ids = { ...extra.ids, tpid: extra.ids.tpid ?? newIds().tpid }; for (const k of ["city", "state"]) if (!track[k] && c.track[k]) extra.track[k] = txt(c.track[k], k === "state" ? 2 : 18); if (!b.track?.laps && c.track.laps) extra.track.laps = c.track.laps; }
        writeFileSync(join(dir, "track.json"), JSON.stringify({ name, author: "", model: b.from === "game" ? "model.gltf" : files.scenery ?? "", ...(files.physics ? { physics: files.physics } : {}), ...(files.lines ? { lines: files.lines } : {}), slots: [slot], enabled: false, ...extra }, null, 2));
      } catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
      json(res, 200, { id }); return true;
    }
    if (req.method === "POST" && p === "/api/tracks/save") {
      const b = await body(req), dir = dirOf(b.id), old = readPack(dir), m = b.meta ?? {}, all = new Set(getSlots().map(s => s.slot));
      const meta = { ...old, name: txt(m.name ?? old.name, 60), author: txt(m.author ?? old.author, 60), model: m.model !== undefined ? String(m.model) : old.model, enabled: m.enabled !== undefined ? !!m.enabled : !!old.enabled };
      if (old.mode !== "add" && Array.isArray(m.slots)) meta.slots = [...new Set(m.slots.map(Number))].filter(s => all.has(s));
      if (old.mode === "add" && m.track) meta.track = { ...old.track, ...trackInfo({ ...old.track, ...m.track }) };
      if (old.mode === "add" && m.layout !== undefined) { if (m.layout && (!FILE_RE.test(m.layout + "") && !/\.json$/i.test(m.layout))) throw new Error("bad layout file"); meta.layout = m.layout || undefined;
        if (!meta.ids.tpid && meta.layout) meta.ids = { ...meta.ids, tpid: newIds().tpid }; if (!meta.base.tpid) { const r = base().tables.get("TRCK").rows.find(x => x.TRID === meta.base.trid); meta.base = { ...meta.base, tpid: r?.TPID }; } }
      for (const k of ["physics", "lines"]) if (old.mode === "add" && m[k] !== undefined) { const f = String(m[k] ?? ""); if (f && (!FILE_RE.test(f) || !/\.(glb|gltf)$/i.test(f) || !existsSync(join(dir, f)))) throw new Error(`the ${k} file must be a .glb or .gltf file in the pack`); meta[k] = f || undefined; }
      if (old.mode === "add" && meta.physics && !meta.ids.tpid) meta.ids = { ...meta.ids, tpid: newIds().tpid };
      if (old.mode === "add" && meta.physics && !meta.base.tpid) { const r = base().tables.get("TRCK").rows.find(x => x.TRID === meta.base.trid); meta.base = { ...meta.base, tpid: r?.TPID }; }
      if (old.mode === "add" && m.layoutOptions) { const o = m.layoutOptions, num = (v, lo, hi) => v === "" || v === undefined || v === null || !Number.isFinite(+v) ? undefined : Math.max(lo, Math.min(hi, +v));
        meta.layoutOptions = { bankStraight: num(o.bankStraight, -10, 45), bankTurn: num(o.bankTurn, -10, 45) }; }
      if (meta.model && (!FILE_RE.test(meta.model) || !/\.(glb|gltf)$/i.test(meta.model))) throw new Error("the model must be a .glb or .gltf file in the pack");
      writeFileSync(join(dir, "track.json"), JSON.stringify(meta, null, 2)); json(res, 200, { ok: true, meta }); return true;
    }
    if (req.method === "PUT" && p === "/api/tracks/file") {
      const dir = dirOf(q("id")), name = String(q("name") ?? "").replace(/\\/g, "/"); if (!FILE_RE.test(name) || name.split("/").includes("..") || name.startsWith("build/") || name === "track.json") throw new Error("only .glb, .gltf, .bin, .png and layout .json files can be added");
      const f = resolve(dir, name); if (!f.startsWith(resolve(dir) + sep)) throw new Error("bad file name");
      const chunks = []; let n = 0; for await (const c of req) { n += c.length; if (n > 512e6) throw new Error("file too large"); chunks.push(c); }
      mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, Buffer.concat(chunks));
      if (/\.(glb|gltf)$/i.test(name)) { const meta = readPack(dir); if (!meta.model || !existsSync(join(dir, meta.model))) { meta.model = name; writeFileSync(join(dir, "track.json"), JSON.stringify(meta, null, 2)); } }
      json(res, 200, { ok: true, bytes: n }); return true;
    }
    if (req.method === "POST" && p === "/api/tracks/build") {
      const { id } = await body(req), dir = dirOf(id); if (building.has(id)) throw new Error("already building");
      building.add(id); let log = "";
      const code = await new Promise(ok => { const pr = spawn(process.execPath, [join(here, "src", "tracks", "track-pack.mjs"), "build", dir, data], { cwd: here });
        pr.stdout.on("data", d => log += d); pr.stderr.on("data", d => log += d); pr.on("close", ok); pr.on("error", e => { log += e.message; ok(1); }); });
      building.delete(id);
      const err = code ? (log.match(/Error: (.*)/)?.[1] ?? `build failed (${code})`) : null;
      json(res, 200, { ok: !code, error: err, log: log.trim().split("\n").filter(l => !/^\s+at /.test(l)).slice(-30).join("\n") }); return true;
    }
    if (req.method === "GET" && p === "/api/tracks/layout.svg") { const f = join(dirOf(q("id")), "build", "layout.svg"); if (!existsSync(f)) { json(res, 404, { error: "not built" }); return true; } res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" }); res.end(readFileSync(f)); return true; }
    if (req.method === "POST" && p === "/api/tracks/nr2003-gltf") {
      const b = await body(req), clean = v => String(v ?? "").trim().replace(/^"|"$/g, ""), folder = clean(b.folder), objects = (Array.isArray(b.objects) ? b.objects : [b.objects]).map(clean).filter(Boolean);
      if (!folder || !existsSync(folder) || !statSync(folder).isDirectory()) throw new Error("folder not found");
      if (!readdirSync(folder).some(f => /\.(dat|ptf)$/i.test(f))) throw new Error("no NR2003 track there (a .dat / .ptf file)");
      let out = clean(b.out); if (!out) { const base = (folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "track").slice(0, 40); out = join(convRoot, base); }
      const log = [], r = nr2003ToGLTF(folder, out, { objects, log: m => log.push(m) });
      json(res, 200, { out, files: r.files, track: r.info, log }); return true;
    }
    if (req.method === "GET" && p === "/api/tracks/converted") { json(res, 200, { root: convRoot, objects: objRoot, items: converted() }); return true; }
    if (req.method === "POST" && p === "/api/tracks/objects") {
      const b = await body(req), log = []; let objects;
      if (b.source === "nr2003") { const folders = (Array.isArray(b.folders) ? b.folders : [b.folders]).map(v => String(v ?? "").trim().replace(/^"|"$/g, "")).filter(f => f && existsSync(f)); if (!folders.length) throw new Error("folder not found");
        objects = await exportNR2003Objects(folders, objRoot, { log: m => log.push(m) }); }
      else { const slot = Number(b.slot); if (!getSlots().some(x => x.slot === slot)) throw new Error("pick a track"); objects = exportGameObjects(data, slot, objRoot, { log: m => log.push(m), repeatedOnly: !!b.repeatedOnly }); }
      json(res, 200, { dir: objRoot, count: objects.length, objects: objects.slice(0, 400), log }); return true;
    }
    if (req.method === "POST" && p === "/api/tracks/delete") { const { id } = await body(req), dir = dirOf(id); rmSync(dir, { recursive: true, force: true }); json(res, 200, { ok: true }); return true; }
    return false;
  };
}
