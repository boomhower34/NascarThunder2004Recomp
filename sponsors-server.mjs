// sponsors-server.mjs — the launcher's Sponsors tab, server side: a library of paint schemes WITHOUT numbers (the game
// draws each car's own number on them: number-paint.mjs) and their pit crew uniforms, for careers' teams (silly-season
// sponsor moves) and, optionally, a car each starts on. roster/sponsors.json beside the Data folder:
//   { schemes: [{ id (1..63), name, tier 1..5, makes: { "<CMDL>": { layout } }, style: { font, fill, outline, outline2 },
//                 spots: { "<CMDL>": [ { name, x, y, w, h, rot } ] }, colors: { primary, secondary }, crew, startOn }] }
//   roster/sponsors/<id>/paint_<make>.src.png  the picture as given     paint_<make>.png  in this game's layout
//   roster/sponsors/<id>/crew.png              pit crew uniform sheet (crew-tex.mjs)
//
// API (JSON unless noted):
//   GET  /api/sponsors                               { schemes, fonts, defaults (number spots by make), makes, cars }
//   POST /api/sponsors/scheme   {scheme}             add (no id) or update
//   POST /api/sponsors/delete   { id }
//   PUT  /api/sponsors/image?id=&kind=paint&make=m&layout=game|ea1252   body: PNG     (kind=crew: the uniform sheet)
//   DELETE /api/sponsors/image?id=&kind=...          GET the same: PNG (paint: this game's layout)
//   POST /api/sponsors/preview  { scheme, make, number }   PNG: the paint with the number drawn (unsaved edits too)
//
// The sponsor list: sponsors added to the game's own list (Create-A-Car decals, career Sign Sponsors; sponsor-decals.mjs),
// brands: [{ id (1..32), name, level 0..4 }] in the same file; roster/sponsors/brand_<id>/logo.png (menus; also the
// decals unless decal.png is there) and the menu logo as the uis_spon texture override roster/textures/uis_spon/<SPLG>.png.
//   POST /api/sponsors/brand   {brand}   add (no id) or update        POST /api/sponsors/brand/delete  { id }
//   PUT / GET / DELETE /api/sponsors/brand/image?id=&kind=logo|decal   body: PNG
//   GET  /api/sponsors/brand/preview?id=   PNG: the car decals made from it (light parts white, dark parts dark grey)
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { openDatabases } from "./nascar-db.mjs";
import { parseTerf } from "./terf.mjs";
import { decodeMMAP, encodePNG } from "./mmap-tex.mjs";
import { decodePNG } from "./png-read.mjs";
import { convertLayout, LAYOUTS } from "./paint-layout.mjs";
import { paintSize } from "./paint-mmap.mjs";
import { loadFonts, drawNumber, DEFAULT_SPOTS, FONT_NAMES, spotsFor } from "./number-paint.mjs";
import { MAX_BRANDS, brandSplg, DECAL_SETS, decalBoxes, prepareLogo, makeDecal, previewDecal } from "./sponsor-decals.mjs";
import { resize } from "./paint-mmap.mjs";

const MAKES = { 0: "Chevrolet", 1: "Dodge", 2: "Ford", 3: "Pontiac" };
const LEVELS = ["0 · local", "1 · small", "2 · mid", "3 · big", "4 · major"];
export const MAX_SCHEMES = 63;

export function cleanScheme(input, old, taken) {
  const s = (v, n) => String(v ?? "").replace(/[^\x20-\x7e]/g, "").trim().slice(0, n);
  const int = (v, lo, hi, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def; };
  const col = (v, d) => /^#[0-9a-f]{6}$/i.test(v ?? "") ? v.toLowerCase() : d;
  let id = old?.id; if (!id) { id = 1; while (taken.has(id)) id++; if (id > MAX_SCHEMES) throw new Error(`at most ${MAX_SCHEMES} paint schemes`); }
  const spots = {};
  for (const m of [0, 1, 2, 3]) {
    const list = input.spots?.[m]; if (!Array.isArray(list) || !list.length) continue;
    spots[m] = list.slice(0, 8).map(p => ({ name: s(p.name, 16), x: Math.max(0, Math.min(1, +p.x || 0)), y: Math.max(0, Math.min(1, +p.y || 0)), w: Math.max(0.005, Math.min(1, +p.w || 0.1)), h: Math.max(0.005, Math.min(1, +p.h || 0.1)), rot: [0, 90, 180, 270].includes(+p.rot) ? +p.rot : 0 }));
  }
  return {
    id, name: s(input.name, 38) || "Sponsor", tier: int(input.tier, 1, 5, 3),
    makes: Object.fromEntries(Object.entries(old?.makes ?? {}).map(([m, v]) => [m, { layout: LAYOUTS[input.makes?.[m]?.layout] ? input.makes[m].layout : v.layout ?? "game" }])),
    style: { font: int(input.style?.font, 0, 14, 2), fill: col(input.style?.fill, "#ffffff"), outline: col(input.style?.outline, "#000000"), outline2: input.style?.outline2 ? col(input.style.outline2, null) : null },
    spots, colors: { primary: col(input.colors?.primary, "#c00000"), secondary: col(input.colors?.secondary, "#ffffff") },
    crew: !!old?.crew, startOn: Number.isInteger(+input.startOn) && +input.startOn >= 0 && input.startOn !== "" && input.startOn !== null ? +input.startOn : null,
  };
}

export function createSponsors({ here, data, user = here }) {   // (user: the preset's folder, launcher.mjs)
  const root = join(user, "roster"), file = join(root, "sponsors.json"), dirOf = id => join(root, "sponsors", String(id));
  const paintFile = (id, m) => join(dirOf(id), `paint_${m}.png`), srcOf = f => f.replace(/\.png$/, ".src.png"), crewFile = id => join(dirOf(id), "crew.png");
  let db = null, fonts = null; const terfs = new Map();
  const base = () => db ??= openDatabases(["NASCAR.DB", "GMODEDB.DAT"].map(f => join(data, f)).filter(existsSync));
  const terf = name => { if (!terfs.has(name)) terfs.set(name, parseTerf(readFileSync(join(data, name)))); return terfs.get(name); };
  const font = () => fonts ??= loadFonts(terf("CARPARTS.DAT"), decodeMMAP);
  const load = () => { try { const r = JSON.parse(readFileSync(file, "utf8")); return { schemes: Array.isArray(r.schemes) ? r.schemes : [], brands: Array.isArray(r.brands) ? r.brands : [] }; } catch { return { schemes: [], brands: [] }; } };
  const save = r => { mkdirSync(root, { recursive: true }); writeFileSync(file + ".tmp", JSON.stringify(r, null, 2)); renameSync(file + ".tmp", file); };
  const withFiles = x => ({ ...x, files: { paints: Object.fromEntries([0, 1, 2, 3].map(m => [m, existsSync(paintFile(x.id, m))])), crew: existsSync(crewFile(x.id)) } });
  const cars = () => {
    const T = n => base().tables.get(n)?.rows ?? [], drv = new Map(T("DRVR").map(r => [r.DRID, r])), teams = new Map(T("TEAM").map(r => [r.TMID, r.TMNM]));
    return T("CARS").filter(c => [1, 2, 3, 4].includes(c.CTYP) && c.DRID >= 0 && drv.has(c.DRID)).map(c => ({ crid: c.CRID, number: String(c.CNMD ?? c.CNUM).trim(), make: c.CMDL, class: c.CTYP,
      driver: `${drv.get(c.DRID).FNAM} ${drv.get(c.DRID).LNAM}`.trim(), team: teams.get(c.TMID) ?? "" })).sort((a, b) => (+a.number || 999) - (+b.number || 999));
  };
  // a stock paint of a make: the alpha and size a rearranged sheet takes
  const makePaint = make => { const T = n => base().tables.get(n).rows, c = T("CARS").find(r => r.CMDL === make && [1, 2].includes(r.CTYP)), k = T("CRSK").find(r => r.CRID === c.CRID && r.CTXN === c.CSTN); return decodeMMAP(terf("CARDATA.DAT").entry(k.CTID)); };
  const derive = (id, m, layout) => {
    const f = paintFile(id, m); if (!existsSync(srcOf(f))) return;
    const buf = readFileSync(srcOf(f));
    if (!layout || layout === "game") { writeFileSync(f, buf); return; }
    const img = decodePNG(buf), r = convertLayout(img, makePaint(m), layout, paintSize(img.width, img.height));
    writeFileSync(f, encodePNG(r.width, r.height, r.rgba));
  };

  // ---------------------------------------------------------------- the sponsor list (sponsors added to the game's list)
  const brandDir = id => join(root, "sponsors", `brand_${id}`), brandFile = (id, k) => join(brandDir(id), `${k}.png`);
  const uiLogo = id => join(root, "textures", "uis_spon", `${brandSplg(id)}.png`);
  const stockNames = () => (base().tables.get("SPIN")?.rows ?? []).filter(r => r.SPID >= 0).map(r => r.SNAM);
  let boxes = null;
  const decals = id => { const t = terf("CARPARTS.DAT"), logo = prepareLogo(decodePNG(readFileSync(existsSync(brandFile(id, "decal")) ? brandFile(id, "decal") : brandFile(id, "logo"))));
    boxes ??= decalBoxes(t); return DECAL_SETS.map(s => previewDecal(makeDecal(t.entry(s.base), logo, s, boxes.get(s.base)))); };
  // the menu logo: the picture fitted in a square (the menus show 128 x 128), 256 px for sharpness
  const writeUiLogo = id => { const img = decodePNG(readFileSync(brandFile(id, "logo"))), N = 256, s = Math.min(N / img.width, N / img.height), w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
    const px = resize(img.rgba, img.width, img.height, w, h), out = new Uint8Array(N * N * 4), ox = (N - w) >> 1, oy = (N - h) >> 1;
    for (let y = 0; y < h; y++) out.set(px.subarray(y * w * 4, (y + 1) * w * 4), ((oy + y) * N + ox) * 4);
    mkdirSync(join(root, "textures", "uis_spon"), { recursive: true }); writeFileSync(uiLogo(id), encodePNG(N, N, out)); };
  async function brandRoute(req, res, url, lib, { json, body }) {
    const p = url.pathname, find = id => { const b = lib.brands.find(x => x.id === Number(id)); if (!b) throw new Error("no such sponsor"); return b; };
    if (req.method === "POST" && p === "/api/sponsors/brand") {
      const input = await body(req), old = lib.brands.find(b => b.id === input.id && input.id), name = String(input.name ?? "").replace(/[^\x20-\x7e]/g, "").trim().slice(0, 28);
      if (!name) throw new Error("the sponsor needs a name");
      if (lib.brands.some(b => b !== old && b.name.toLowerCase() === name.toLowerCase())) throw new Error(`there is already a sponsor called "${name}"`);
      let id = old?.id; if (!id) { id = 1; while (lib.brands.some(b => b.id === id)) id++; if (id > MAX_BRANDS) throw new Error(`at most ${MAX_BRANDS} sponsors`); }
      const b = { id, name, level: Math.max(0, Math.min(4, Math.round(+input.level || 0))) };
      if (old) Object.assign(old, b); else lib.brands.push(b);
      save(lib); json(res, 200, { ...b, files: { logo: existsSync(brandFile(id, "logo")), decal: existsSync(brandFile(id, "decal")) } }); return true;
    }
    if (req.method === "POST" && p === "/api/sponsors/brand/delete") {
      const b = find((await body(req)).id); rmSync(brandDir(b.id), { recursive: true, force: true }); rmSync(uiLogo(b.id), { force: true });
      lib.brands = lib.brands.filter(x => x !== b); save(lib); json(res, 200, { ok: true }); return true;
    }
    if (p === "/api/sponsors/brand/image") {
      const b = find(url.searchParams.get("id")), kind = url.searchParams.get("kind"); if (!["logo", "decal"].includes(kind)) throw new Error("bad picture kind");
      const f = brandFile(b.id, kind);
      if (req.method === "GET") { if (!existsSync(f)) { json(res, 404, { error: "none" }); return true; } res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" }); res.end(readFileSync(f)); return true; }
      if (req.method === "DELETE") { rmSync(f, { force: true }); if (kind === "logo") rmSync(uiLogo(b.id), { force: true }); json(res, 200, { ok: true }); return true; }
      if (req.method === "PUT") {
        const chunks = []; let n = 0; for await (const c of req) { n += c.length; if (n > 16e6) throw new Error("picture too large"); chunks.push(c); }
        const buf = Buffer.concat(chunks), img = decodePNG(buf); if (img.width > 4096 || img.height > 4096) throw new Error("picture too large (4096 px at most)");
        prepareLogo(img);                                       // (refuses an empty picture)
        mkdirSync(brandDir(b.id), { recursive: true }); writeFileSync(f, buf); if (kind === "logo") writeUiLogo(b.id);
        json(res, 200, { ok: true, width: img.width, height: img.height }); return true;
      }
    }
    if (req.method === "GET" && p === "/api/sponsors/brand/preview") {
      const b = find(url.searchParams.get("id")); if (!existsSync(brandFile(b.id, "logo")) && !existsSync(brandFile(b.id, "decal"))) { json(res, 404, { error: "no logo yet" }); return true; }
      const ims = decals(b.id), gap = 6, W = ims.reduce((a, m) => a + m.width + gap, -gap), H = Math.max(...ims.map(m => m.height)), out = new Uint8Array(W * H * 4);
      for (let i = 0; i < out.length; i += 4) { out[i] = 70; out[i + 1] = 92; out[i + 2] = 140; out[i + 3] = 255; }
      let ox = 0; for (const m of ims) { for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) { const s = (y * m.width + x) * 4; if (m.rgba[s + 3]) out.set(m.rgba.subarray(s, s + 4), (y * W + ox + x) * 4); } ox += m.width + gap; }
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" }); res.end(encodePNG(W, H, out)); return true;
    }
    return false;
  }

  return async function handle(req, res, url, { json, body }) {
    const p = url.pathname; if (!p.startsWith("/api/sponsors")) return false;
    const lib = load(), q = k => url.searchParams.get(k);
    const find = id => { const x = lib.schemes.find(s => s.id === Number(id)); if (!x) throw new Error("no such paint scheme"); return x; };
    if (req.method === "GET" && p === "/api/sponsors") { json(res, 200, { schemes: lib.schemes.map(withFiles), fonts: FONT_NAMES, defaults: DEFAULT_SPOTS, makes: MAKES, cars: cars(),
      brands: lib.brands.map(b => ({ ...b, files: { logo: existsSync(brandFile(b.id, "logo")), decal: existsSync(brandFile(b.id, "decal")) } })), levels: LEVELS, maxBrands: MAX_BRANDS, stockNames: stockNames() }); return true; }
    if (p.startsWith("/api/sponsors/brand")) return brandRoute(req, res, url, lib, { json, body });
    if (req.method === "POST" && p === "/api/sponsors/scheme") {
      const input = await body(req), old = lib.schemes.find(s => s.id === input.id), x = cleanScheme(input, old, new Set(lib.schemes.filter(s => s !== old).map(s => s.id)));
      if (x.startOn !== null) { const c = cars().find(c => c.crid === x.startOn); if (!c) throw new Error("no such car to start on");
        if (!existsSync(paintFile(x.id, c.make)) && !(input.pendingMakes ?? []).includes(c.make)) throw new Error(`the car it starts on is a ${MAKES[c.make]}: add a ${MAKES[c.make]} paint first`);
        const other = lib.schemes.find(s => s !== old && s.startOn === x.startOn); if (other) throw new Error(`"${other.name}" already starts on that car`); }
      if (old) { for (const m of Object.keys(x.makes)) if (x.makes[m].layout !== old.makes?.[m]?.layout) derive(x.id, m, x.makes[m].layout); Object.assign(old, x); } else lib.schemes.push(x);
      save(lib); json(res, 200, withFiles(x)); return true;
    }
    if (req.method === "POST" && p === "/api/sponsors/delete") {
      const { id } = await body(req), x = find(id); rmSync(dirOf(x.id), { recursive: true, force: true });
      lib.schemes = lib.schemes.filter(s => s !== x); save(lib); json(res, 200, { ok: true }); return true;
    }
    if (p === "/api/sponsors/image") {
      const x = find(q("id")), kind = q("kind"), m = Number(q("make"));
      if (!["paint", "crew"].includes(kind) || (kind === "paint" && ![0, 1, 2, 3].includes(m))) throw new Error("bad picture kind");
      const f = kind === "paint" ? paintFile(x.id, m) : crewFile(x.id);
      if (req.method === "GET") { if (!existsSync(f)) { json(res, 404, { error: "none" }); return true; } res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" }); res.end(readFileSync(f)); return true; }
      if (req.method === "DELETE") { rmSync(f, { force: true }); rmSync(srcOf(f), { force: true });
        if (kind === "paint") delete x.makes[m]; else x.crew = false; save(lib); json(res, 200, { ok: true }); return true; }
      if (req.method === "PUT") {
        const chunks = []; let n = 0; for await (const c of req) { n += c.length; if (n > 24e6) throw new Error("picture too large"); chunks.push(c); }
        const buf = Buffer.concat(chunks), img = decodePNG(buf); if (img.width > 4096 || img.height > 4096) throw new Error("picture too large (4096 px at most)");
        mkdirSync(dirOf(x.id), { recursive: true });
        if (kind === "crew") { writeFileSync(f, buf); x.crew = true; }
        else { const layout = LAYOUTS[q("layout")] ? q("layout") : "game"; writeFileSync(srcOf(f), buf); x.makes[m] = { layout }; derive(x.id, m, layout); }
        save(lib); json(res, 200, { ok: true, width: img.width, height: img.height }); return true;
      }
    }
    if (req.method === "POST" && p === "/api/sponsors/preview") {
      const { scheme, make, number } = await body(req), x = cleanScheme(scheme ?? {}, lib.schemes.find(s => s.id === scheme?.id) ?? { id: 99 }, new Set()), m = [0, 1, 2, 3].includes(+make) ? +make : 0;
      const f = paintFile(scheme?.id, m), img = existsSync(f) ? decodePNG(readFileSync(f)) : (() => { const t = makePaint(m); return { width: t.width, height: t.height, rgba: new Uint8Array(t.rgba.length).fill(200) }; })();
      const rgba = Uint8Array.from(img.rgba); drawNumber(rgba, img.width, img.height, String(number ?? "88"), spotsFor(x, m), x.style, font());
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" }); res.end(encodePNG(img.width, img.height, rgba)); return true;
    }
    return false;
  };
}
