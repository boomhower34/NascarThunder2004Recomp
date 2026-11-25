// sponsors-ui.js — the launcher's Sponsors tab (page side; server side sponsors-server.mjs). Paint schemes without
// numbers: the game draws each car's own number on them, in the font, colours and spots set here. Builds into
// <section id="sponsors">.
(() => {
  const root = document.getElementById("sponsors"); if (!root) return;
  const $ = (sel, el = root) => el.querySelector(sel);
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const api = async (path, opts = {}) => { const r = await fetch(path, opts); const j = r.headers.get("content-type")?.includes("json") ? await r.json() : null; if (!r.ok) throw new Error(j?.error || r.status); return j; };
  const post = (path, data) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  const TIERS = { 1: "1 · small", 2: "2", 3: "3 · mid", 4: "4", 5: "5 · major" };
  let D = null, cur = null, pending = {}, make = 0, sel = -1;

  root.innerHTML = `<div class="card"><h2>Sponsor paint schemes</h2>
    <p class="hint" style="margin-top:0">Paint schemes without car numbers. The game draws the number of whichever car carries the scheme, on the doors, roof, headlight and rear, in the font and colours you pick. A paint fits only its own body, so add one picture per make you have it for (the layout of the game's paints; a 1252 modder template is rearranged for you). In a career the silly season can sign these sponsors to teams (Career tab, "Sponsors change teams"); a scheme can also start on one car in every mode.</p>
    <div class="row"><button class="btn primary" id="sAdd">Add a paint scheme</button><span class="pill" id="sState"></span></div>
    <div id="sList" class="slist"></div></div>
    <div class="card" id="sEdit" style="display:none"></div>`;
  const style = document.createElement("style");
  style.textContent = `.slist{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px;margin-top:12px}
  .scard{display:flex;gap:10px;align-items:center;padding:8px;border:1px solid var(--line,#333);border-radius:8px;cursor:pointer} .scard img,.scard .ph{width:64px;height:64px;border-radius:6px;object-fit:cover;background:#0003}
  .scard small{display:block;color:var(--dim)} .sgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px 18px} .sgrid label{display:grid;gap:4px}
  .smakes{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px} .smake img{width:180px;height:180px;object-fit:contain;background:#0003;border-radius:6px;display:block;margin:6px 0}
  .sprev{position:relative;width:512px;max-width:100%;aspect-ratio:1;background:#0003;border-radius:6px;user-select:none;touch-action:none} .sprev img{width:100%;height:100%;display:block}
  .spot{position:absolute;border:1.5px dashed #ffd400;box-sizing:border-box;cursor:move} .spot.sel{border-style:solid;border-color:#3fd0ff;background:#3fd0ff22}
  .spot b{position:absolute;top:-17px;left:0;font:11px sans-serif;color:#ffd400;white-space:nowrap} .spot i{position:absolute;right:-6px;bottom:-6px;width:10px;height:10px;background:#3fd0ff;cursor:nwse-resize}
  .sside{display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start} #sponsors img[src=""],#sponsors img:not([src]){visibility:hidden}`;
  document.head.appendChild(style);

  async function load(selId) {
    D = await api("/api/sponsors");
    $("#sList").innerHTML = D.schemes.length ? D.schemes.map(s => { const m = [0, 1, 2, 3].find(k => s.files.paints[k]);
      return `<div class="scard" data-id="${s.id}">${m !== undefined ? `<img src="/api/sponsors/image?id=${s.id}&kind=paint&make=${m}&t=${Date.now()}">` : `<div class="ph"></div>`}<div><b>${esc(s.name)}</b><small>tier ${s.tier} · ${[0, 1, 2, 3].filter(k => s.files.paints[k]).map(k => D.makes[k]).join(", ") || "no paint yet"}${s.crew ? " · crew" : ""}${s.startOn !== null ? ` · starts on #${esc(D.cars.find(c => c.crid === s.startOn)?.number ?? "?")}` : ""}</small></div></div>`; }).join("") : `<p class="hint">No paint schemes yet.</p>`;
    root.querySelectorAll(".scard").forEach(c => c.onclick = () => edit(D.schemes.find(s => s.id === +c.dataset.id)));
    if (selId) edit(D.schemes.find(s => s.id === selId));
  }
  const spotsOf = m => cur.spots?.[m]?.length ? cur.spots[m] : D.defaults[m];
  function edit(s) {
    const fresh = !s;
    cur = structuredClone(s ?? { name: "", tier: 3, makes: {}, style: { font: 2, fill: "#ffffff", outline: "#000000", outline2: null }, spots: {}, colors: { primary: "#c00000", secondary: "#ffffff" }, crew: false, startOn: null, files: { paints: {}, crew: false } });
    pending = {}; sel = -1; make = [0, 1, 2, 3].find(k => cur.files.paints[k]) ?? 0;
    const e = $("#sEdit"); e.style.display = "";
    e.innerHTML = `<h2>${fresh ? "New paint scheme" : esc(cur.name)}</h2>
      <div class="sgrid">
        <label>Sponsor / scheme name <input id="eName" maxlength="38" value="${esc(cur.name)}"></label>
        <label>Size of the sponsor <select id="eTier">${Object.entries(TIERS).map(([k, v]) => `<option value="${k}"${+k === cur.tier ? " selected" : ""}>${v}</option>`).join("")}</select></label>
        <label>Primary colour <input type="color" id="eP" value="${cur.colors.primary}"></label>
        <label>Secondary colour <input type="color" id="eS" value="${cur.colors.secondary}"></label>
        <label>Starts on (every mode) <select id="eStart"><option value="">— no car —</option>${D.cars.map(c => `<option value="${c.crid}"${c.crid === cur.startOn ? " selected" : ""}>#${esc(c.number)} ${esc(c.driver)} (${D.makes[c.make]})</option>`).join("")}</select></label>
      </div>
      <p class="hint">Size: in careers with team prestige on, big sponsors go to prestigious teams. The colours are used where the game shows a car's colours (menus, the pit sign stays the car's own).</p>
      <h3>Paints (no numbers)</h3>
      <div class="smakes">${[0, 1, 2, 3].map(m => `<div class="smake"><b>${D.makes[m]}</b><img id="pi_${m}" alt="">
        <div class="row"><button class="btn" id="pp_${m}">Choose…</button><button class="btn danger" id="px_${m}">Remove</button></div>
        <label class="hint">Layout <select id="pl_${m}">${[["game", "this game's"], ["ea1252", "1252 modder template"]].map(([k, v]) => `<option value="${k}"${(cur.makes[m]?.layout ?? "game") === k ? " selected" : ""}>${v}</option>`).join("")}</select></label>
        <a class="hint" href="/api/roster/base?kind=paint&n=${D.cars.find(c => c.make === m && c.class <= 2)?.crid}" download="template_${D.makes[m]}.png">Stock ${D.makes[m]} paint (layout guide)</a>
        <input type="file" id="pf_${m}" accept="image/*" hidden></div>`).join("")}</div>
      <h3>Car number</h3>
      <div class="sgrid">
        <label>Font <select id="eFont">${D.fonts.map((n, i) => `<option value="${i}"${i === cur.style.font ? " selected" : ""}>${n}</option>`).join("")}</select></label>
        <label>Fill <input type="color" id="eFill" value="${cur.style.fill}"></label>
        <label>Outline <input type="color" id="eOut" value="${cur.style.outline}"></label>
        <label>Second outline <span class="row"><input type="checkbox" id="eO2on"${cur.style.outline2 ? " checked" : ""}><input type="color" id="eO2" value="${cur.style.outline2 ?? "#ffffff"}"></span></label>
      </div>
      <div class="sside" style="margin-top:10px"><div>
        <div class="row"><label>Preview on <select id="eMake">${[0, 1, 2, 3].map(m => `<option value="${m}"${m === make ? " selected" : ""}>${D.makes[m]}</option>`).join("")}</select></label>
          <label>number <input id="eNum" value="24" maxlength="3" size="3"></label></div>
        <div class="sprev" id="ePrev"><img id="ePrevImg" alt=""></div></div>
        <div style="max-width:320px"><p class="hint">Yellow boxes are where the number goes on this make. Drag a box to move it, its corner to resize; the number is fitted inside, keeping the font's shape. The top door is drawn upside down (that is how the layout has it).</p>
          <div class="row"><button class="btn" id="eRot">Turn selected box</button><button class="btn" id="eReset">Back to the defaults</button></div>
          <h3>Pit crew uniforms (optional)</h3>
          <p class="hint">A uniform sheet like the Roster tab's. Pit crews show on screen for the car you drive.</p>
          <img id="ci" alt="" style="width:160px;height:160px;object-fit:contain;background:#0003;border-radius:6px;display:block">
          <div class="row"><button class="btn" id="cp">Choose…</button><button class="btn danger" id="cx">Remove</button><input type="file" id="cf" accept="image/*" hidden></div>
          <a class="hint" href="/api/roster/base?kind=crew&n=${D.cars.find(c => c.class <= 2)?.crid}" download="crew_template.png">Stock uniform sheet (layout guide)</a></div></div>
      <div class="row" style="margin-top:14px"><button class="btn primary" id="eSave">${fresh ? "Add paint scheme" : "Save"}</button>${fresh ? "" : `<button class="btn danger" id="eDel">Remove</button>`}<button class="btn" id="eClose">Close</button><span class="pill" id="eState"></span></div>`;
    for (const m of [0, 1, 2, 3]) {
      $(`#pi_${m}`, e).src = cur.files.paints[m] ? `/api/sponsors/image?id=${cur.id}&kind=paint&make=${m}&t=${Date.now()}` : "";
      $(`#pp_${m}`, e).onclick = () => $(`#pf_${m}`, e).click();
      $(`#pf_${m}`, e).onchange = ev => { const f = ev.target.files[0]; if (!f) return; pending["p" + m] = f; $(`#pi_${m}`, e).src = URL.createObjectURL(f);
        const im = new Image(); im.onload = () => { if (im.width === im.height && im.width >= 1200 && im.width <= 1300) $(`#pl_${m}`, e).value = "ea1252"; }; im.src = URL.createObjectURL(f); };
      $(`#px_${m}`, e).onclick = () => { pending["p" + m] = "delete"; $(`#pi_${m}`, e).src = ""; };
    }
    $("#ci", e).src = cur.files.crew ? `/api/sponsors/image?id=${cur.id}&kind=crew&t=${Date.now()}` : "";
    $("#cp", e).onclick = () => $("#cf", e).click();
    $("#cf", e).onchange = ev => { const f = ev.target.files[0]; if (!f) return; pending.crew = f; $("#ci", e).src = URL.createObjectURL(f); };
    $("#cx", e).onclick = () => { pending.crew = "delete"; $("#ci", e).src = ""; };
    e.querySelectorAll("#eFont,#eFill,#eOut,#eO2on,#eO2,#eNum").forEach(i => i.addEventListener("input", preview));
    $("#eMake", e).onchange = () => { make = +$("#eMake", e).value; sel = -1; drawSpots(); preview(); };
    $("#eRot", e).onclick = () => { if (sel < 0) return; own(); cur.spots[make][sel].rot = (cur.spots[make][sel].rot + 90) % 360; drawSpots(); preview(); };
    $("#eReset", e).onclick = () => { delete cur.spots[make]; sel = -1; drawSpots(); preview(); };
    $("#eSave", e).onclick = () => save().catch(x => st(String(x.message || x), "err"));
    $("#eClose", e).onclick = () => { e.style.display = "none"; cur = null; };
    if (!fresh) $("#eDel", e).onclick = async () => { if (!confirm(`Remove "${cur.name}"? Careers where a team carries it go back to that car's own paint.`)) return; await post("/api/sponsors/delete", { id: cur.id }); e.style.display = "none"; load(); };
    drawSpots(); preview(); e.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  const own = () => { cur.spots ??= {}; if (!cur.spots[make]?.length) cur.spots[make] = structuredClone(D.defaults[make]); };
  function drawSpots() {
    const box = $("#ePrev"); box.querySelectorAll(".spot").forEach(x => x.remove());
    spotsOf(make).forEach((p, i) => {
      const d = document.createElement("div"); d.className = "spot" + (i === sel ? " sel" : ""); Object.assign(d.style, { left: p.x * 100 + "%", top: p.y * 100 + "%", width: p.w * 100 + "%", height: p.h * 100 + "%" });
      d.innerHTML = `<b>${esc(p.name || "spot")}${p.rot ? ` ${p.rot}°` : ""}</b><i></i>`; box.appendChild(d);
      d.onpointerdown = ev => {
        ev.preventDefault(); own(); sel = i; const sp = cur.spots[make][i], r = box.getBoundingClientRect(), sx = ev.clientX, sy = ev.clientY, o = { ...sp }, resize = ev.target.tagName === "I";
        root.querySelectorAll(".spot").forEach((x, k) => x.classList.toggle("sel", k === i));
        const mv = e2 => { const dx = (e2.clientX - sx) / r.width, dy = (e2.clientY - sy) / r.height;
          if (resize) { sp.w = Math.max(0.01, o.w + dx); sp.h = Math.max(0.01, o.h + dy); } else { sp.x = Math.min(1 - sp.w, Math.max(0, o.x + dx)); sp.y = Math.min(1 - sp.h, Math.max(0, o.y + dy)); }
          Object.assign(d.style, { left: sp.x * 100 + "%", top: sp.y * 100 + "%", width: sp.w * 100 + "%", height: sp.h * 100 + "%" }); };
        const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); preview(); };
        addEventListener("pointermove", mv); addEventListener("pointerup", up);
      };
    });
  }
  const gather = () => { const e = $("#sEdit"), g = id => $(id, e).value;
    return { id: cur.id, name: g("#eName"), tier: +g("#eTier"), makes: Object.fromEntries([0, 1, 2, 3].map(m => [m, { layout: g(`#pl_${m}`) }])),
      style: { font: +g("#eFont"), fill: g("#eFill"), outline: g("#eOut"), outline2: $("#eO2on", e).checked ? g("#eO2") : null }, spots: cur.spots ?? {},
      colors: { primary: g("#eP"), secondary: g("#eS") }, startOn: g("#eStart") === "" ? null : +g("#eStart") }; };
  let pv = 0;
  async function preview() {
    const n = ++pv, img = $("#ePrevImg"); if (!img) return;
    const f = pending["p" + make];
    try {
      if (f instanceof File) {                  // a picture not uploaded yet: drawn here on a canvas under the server's number layer
        img.src = URL.createObjectURL(f); return;
      }
      const r = await fetch("/api/sponsors/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scheme: gather(), make, number: $("#eNum").value || "24" }) });
      if (n !== pv || !r.ok) return; img.src = URL.createObjectURL(await r.blob());
    } catch {}
  }
  const st = (t, k = "") => { const s = $("#eState"); if (s) { s.textContent = t; s.className = "pill " + k; } };
  async function save() {
    const out = gather(); if (!out.name.trim()) throw new Error("give the scheme a name");
    out.pendingMakes = [0, 1, 2, 3].filter(m => pending["p" + m] instanceof File);
    st("saving…", "run");
    const saved = await post("/api/sponsors/scheme", out);
    const put = async (q, f) => { const r = await fetch(`/api/sponsors/image?id=${saved.id}&${q}`, { method: "PUT", headers: { "content-type": "image/png" }, body: await toPng(f) }); if (!r.ok) throw new Error((await r.json()).error); };
    for (const m of [0, 1, 2, 3]) { const f = pending["p" + m]; if (f instanceof File) await put(`kind=paint&make=${m}&layout=${out.makes[m].layout}`, f); else if (f === "delete") await fetch(`/api/sponsors/image?id=${saved.id}&kind=paint&make=${m}`, { method: "DELETE" }); }
    if (pending.crew instanceof File) await put("kind=crew", pending.crew); else if (pending.crew === "delete") await fetch(`/api/sponsors/image?id=${saved.id}&kind=crew`, { method: "DELETE" });
    await load(saved.id); st("saved — restart the game to use it", "ok");
  }
  // any picture -> PNG at its own size (square paints stay square; the server rearranges a modder template)
  const toPng = file => new Promise((ok, bad) => { const im = new Image(); im.onload = () => { const cv = document.createElement("canvas"); cv.width = im.width; cv.height = im.height; cv.getContext("2d").drawImage(im, 0, 0); cv.toBlob(b => b ? ok(b) : bad(new Error("could not convert the picture")), "image/png"); }; im.onerror = () => bad(new Error("that file is not a picture the browser can read")); im.src = URL.createObjectURL(file); });
  $("#sAdd").onclick = () => edit(null);
  load().catch(x => { $("#sList").textContent = `Could not load the paint schemes: ${x.message}`; });
})();
