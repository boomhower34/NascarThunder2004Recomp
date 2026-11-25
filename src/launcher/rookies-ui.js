// rookies-ui.js — the launcher's Rookies tab (page side; server side roster-server.mjs /api/roster/rookie): rookie
// prospects. No car, number or paint: each waits with the game's fill-in drivers until a career's silly season
// (silly-season.mjs, the Career tab) gives him a ride, then drives that car. Builds into <section id="rookies">.
(() => {
  const root = document.getElementById("rookies"); if (!root) return;
  const $ = (sel, el = root) => el.querySelector(sel);
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const api = async (path, opts = {}) => { const r = await fetch(path, opts); const j = r.headers.get("content-type")?.includes("json") ? await r.json() : null; if (!r.ok) throw new Error(j?.error || r.status); return j; };
  const post = (path, data) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  const RATINGS = [["speed", "Speed"], ["control", "Car control"], ["defense", "Defense"], ["aggression", "Aggression"], ["durability", "Durability"]];
  const TRACKS = [["0", "Short tracks"], ["1", "Speedways"], ["2", "Superspeedways"], ["3", "Road courses"]];
  let rookies = [], cur = null, pending = {};

  root.innerHTML = `<div class="card"><h2>Rookie prospects</h2>
    <p class="hint" style="margin-top:0">Young drivers waiting for their first ride. They have no car of their own: when a seat opens in a career's off-season, the silly season can sign one, and he drives that team's car. All they need is a name and ratings; a portrait is optional (without one they show the game's generic face).</p>
    <p class="hint" id="kWarn" style="display:none"></p>
    <div class="row"><button class="btn primary" id="kAdd">Add a rookie</button><span class="pill" id="kState"></span></div>
    <div id="kList" class="klist"></div></div>
    <div class="card" id="kEdit" style="display:none"></div>`;
  const style = document.createElement("style");
  style.textContent = `.klist{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px;margin-top:12px}
  .kcard{display:flex;gap:10px;align-items:center;padding:8px;border:1px solid var(--line,#333);border-radius:8px;cursor:pointer}
  .kcard img,.kcard .ph{width:48px;height:48px;border-radius:6px;object-fit:cover;background:#0003} .kcard small{display:block;color:var(--dim)}
  .kgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px 18px} .kgrid label{display:grid;gap:4px}
  .ksl{display:grid;grid-template-columns:120px minmax(0,1fr) 32px;gap:8px;align-items:center} .ksl input{min-width:0;width:100%} .kgrid.sl{grid-template-columns:repeat(auto-fill,minmax(320px,1fr))} .kpics{display:flex;gap:18px;flex-wrap:wrap}
  .kpic img{width:160px;height:160px;object-fit:contain;background:#0003;border-radius:8px;display:block;margin:6px 0}`;
  document.head.appendChild(style);

  async function warn() {        // the Career tab settings the rookies depend on
    try {
      const c = (await api("/api/career")).sillySeason, w = $("#kWarn");
      const msg = !c.enabled ? "Rookie prospects only get rides with the Career tab's \"Use these settings\" on (the game's own silly season only picks fill-in drivers who have a car)."
        : !c.rookies?.customFirst ? "Tip: turn on \"Your rookie pool drivers first\" in the Career tab's Rookies section, or these rookies compete with the game's fill-in drivers for seats." : "";
      w.textContent = msg; w.style.display = msg ? "" : "none";
    } catch {}
  }
  async function load(sel) {
    rookies = (await api("/api/roster")).rookies ?? [];
    $("#kList").innerHTML = rookies.length ? rookies.map(r => `<div class="kcard" data-id="${r.id}">${r.files.portrait ? `<img src="/api/roster/image?kind=portrait&id=${r.id}&t=${Date.now()}">` : `<div class="ph"></div>`}<div><b>${esc(r.first)} ${esc(r.last)}</b><small>born ${r.born.year}${r.city ? ` · ${esc(r.city)}${r.state ? ", " + esc(r.state) : ""}` : ""}</small></div></div>`).join("") : `<p class="hint">No rookies yet.</p>`;
    root.querySelectorAll(".kcard").forEach(c => c.onclick = () => edit(rookies.find(r => r.id === +c.dataset.id)));
    if (sel) edit(rookies.find(r => r.id === sel));
    warn();
  }
  const slider = (id, label, v) => `<div class="ksl"><span>${label}</span><input type="range" id="${id}" min="0" max="100" value="${v}"><output>${v}</output></div>`;
  const pad = n => String(n).padStart(2, "0");
  function edit(r) {
    const fresh = !r; cur = r ?? { first: "", last: "", city: "", state: "", born: { year: 1985, month: 1, day: 1 }, ratings: Object.fromEntries(RATINGS.map(([k]) => [k, 70])), trackSkills: { 0: 70, 1: 70, 2: 70, 3: 70 }, files: {} };
    pending = {};
    const e = $("#kEdit"); e.style.display = "";
    e.innerHTML = `<h2>${fresh ? "New rookie" : `${esc(cur.first)} ${esc(cur.last)}`}</h2>
      <div class="kgrid">
        <label>First name <input id="kFirst" maxlength="13" value="${esc(cur.first)}"></label>
        <label>Last name <input id="kLast" maxlength="13" value="${esc(cur.last)}"></label>
        <label>Born <input id="kBorn" type="date" value="${cur.born.year}-${pad(cur.born.month)}-${pad(cur.born.day)}"></label>
        <label>Hometown <input id="kCity" maxlength="18" value="${esc(cur.city)}"></label>
        <label>State <input id="kStateIn" maxlength="2" value="${esc(cur.state)}"></label>
      </div>
      <h3>Ratings</h3><div class="kgrid sl">${RATINGS.map(([k, l]) => slider("kr_" + k, l, cur.ratings[k])).join("")}</div>
      <h3>Track skills</h3><div class="kgrid sl">${TRACKS.map(([k, l]) => slider("kt_" + k, l, cur.trackSkills[k])).join("")}</div>
      <p class="hint">For comparison, the game's fill-in drivers are mostly rated 60–80 and its Cup regulars 75–95. In a career with team prestige on, his ratings decide which teams will sign him.</p>
      <h3>Pictures (optional)</h3><div class="kpics">
        ${["portrait", "closeup"].map(k => `<div class="kpic"><b>${k === "portrait" ? "Portrait" : "Close-up"}</b><p class="hint">${k === "portrait" ? "Menus and driver screens. Square works best." : "The small head shot in races; without one the portrait's top is used."}</p>
          <img id="k_${k}" alt=""><div class="row"><button class="btn" id="kp_${k}">Choose picture…</button><button class="btn danger" id="kx_${k}">Remove</button></div><input type="file" id="kf_${k}" accept="image/*" hidden></div>`).join("")}
      </div>
      <div class="row" style="margin-top:14px"><button class="btn primary" id="kSave">${fresh ? "Add rookie" : "Save"}</button>${fresh ? "" : `<button class="btn danger" id="kDel">Remove rookie</button>`}<button class="btn" id="kClose">Close</button><span class="pill" id="kState2"></span></div>`;
    e.querySelectorAll("input[type=range]").forEach(i => i.oninput = () => { i.nextElementSibling.textContent = i.value; });
    for (const k of ["portrait", "closeup"]) {
      $(`#k_${k}`, e).src = cur.files?.[k] ? `/api/roster/image?kind=${k}&id=${cur.id}&t=${Date.now()}` : "";
      $(`#kp_${k}`, e).onclick = () => $(`#kf_${k}`, e).click();
      $(`#kf_${k}`, e).onchange = async ev => { const f = ev.target.files[0]; if (!f) return; try { pending[k] = await toPng(f, k === "portrait" ? 512 : 256); $(`#k_${k}`, e).src = URL.createObjectURL(pending[k]); } catch (x) { st(String(x.message || x), "err"); } };
      $(`#kx_${k}`, e).onclick = () => { pending[k] = "delete"; $(`#k_${k}`, e).src = ""; };
    }
    $("#kSave", e).onclick = () => save().catch(x => st(String(x.message || x), "err"));
    $("#kClose", e).onclick = () => { e.style.display = "none"; cur = null; };
    if (!fresh) $("#kDel", e).onclick = async () => { if (!confirm(`Remove ${cur.first} ${cur.last}? Careers he already drives in keep him.`)) return; await post("/api/roster/rookie/delete", { id: cur.id }); e.style.display = "none"; load(); };
    e.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  const st = (t, k = "") => { const s = $("#kState2"); if (s) { s.textContent = t; s.className = "pill " + k; } };
  function toPng(file, n) {
    return new Promise((ok, bad) => { const im = new Image(); im.onload = () => {
      const cv = document.createElement("canvas"); cv.width = cv.height = n; const x = cv.getContext("2d"); x.imageSmoothingQuality = "high";
      const s = Math.min(n / im.width, n / im.height), w = im.width * s, h = im.height * s; x.drawImage(im, (n - w) / 2, (n - h) / 2, w, h);
      cv.toBlob(b => b ? ok(b) : bad(new Error("could not convert the picture")), "image/png"); URL.revokeObjectURL(im.src); };
      im.onerror = () => bad(new Error("that file is not a picture the browser can read")); im.src = URL.createObjectURL(file); });
  }
  const closeupFrom = blob => new Promise(ok => { const im = new Image(); im.onload = () => { const cv = document.createElement("canvas"); cv.width = cv.height = 256; cv.getContext("2d").drawImage(im, im.width * 0.2, 0, im.width * 0.6, im.width * 0.6, 0, 0, 256, 256); cv.toBlob(ok, "image/png"); }; im.src = URL.createObjectURL(blob); });
  async function save() {
    const e = $("#kEdit"), g = id => $(id, e).value, [by, bm, bd] = (g("#kBorn") || "1985-01-01").split("-").map(Number);
    if (!g("#kLast").trim()) throw new Error("the rookie needs a last name");
    st("saving…", "run");
    const saved = await post("/api/roster/rookie", { id: cur.id, first: g("#kFirst"), last: g("#kLast"), city: g("#kCity"), state: g("#kStateIn"), born: { year: by, month: bm, day: bd },
      ratings: Object.fromEntries(RATINGS.map(([k]) => [k, +g("#kr_" + k)])), trackSkills: Object.fromEntries(TRACKS.map(([k]) => [k, +g("#kt_" + k)])) });
    const put = (kind, blob) => fetch(`/api/roster/image?kind=${kind}&id=${saved.id}`, { method: "PUT", headers: { "content-type": "image/png" }, body: blob }).then(async r => { if (!r.ok) throw new Error((await r.json()).error); });
    const del = kind => fetch(`/api/roster/image?kind=${kind}&id=${saved.id}`, { method: "DELETE" });
    for (const k of ["portrait", "closeup"]) { if (pending[k] instanceof Blob) await put(k, pending[k]); else if (pending[k] === "delete") await del(k); }
    if (pending.portrait instanceof Blob && !(pending.closeup instanceof Blob) && !saved.files.closeup) await put("closeup", await closeupFrom(pending.portrait));
    st("saved — restart the game to use it", "ok"); await load(saved.id); st("saved — restart the game to use it", "ok");
  }
  $("#kAdd").onclick = () => edit(null);
  // (the tab may be opened after Career settings change)
  document.querySelector('nav button[data-tab="rookies"]')?.addEventListener("click", warn);
  load().catch(x => { $("#kList").textContent = `Could not load the rookies: ${x.message}`; });
})();
