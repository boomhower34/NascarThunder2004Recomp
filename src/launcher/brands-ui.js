// brands-ui.js — the Sponsors tab's "Sponsor list" (page side; server side sponsors-server.mjs /api/sponsors/brand):
// sponsors added to the game's own list, the one Create-A-Car and the career's Sign Sponsors offer for your car. Each
// needs a name and a logo; the car decals are made from the logo (or from a separate decal picture). Loaded after
// sponsors-ui.js: its card goes at the top of <section id="sponsors">.
(() => {
  const root = document.getElementById("sponsors"); if (!root) return;
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const api = async (path, opts = {}) => { const r = await fetch(path, opts); const j = r.headers.get("content-type")?.includes("json") ? await r.json() : null; if (!r.ok) throw new Error(j?.error || r.status); return j; };
  const post = (path, data) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  const box = document.createElement("div"); box.id = "brandBox"; root.prepend(box);
  const $ = sel => box.querySelector(sel);
  let D = null, cur = null, pending = {};

  box.innerHTML = `<div class="card"><h2>Sponsor list</h2>
    <p class="hint" style="margin-top:0">Sponsors added to the game's own list: they show up in Create-A-Car and in a career's Sign Sponsors, for every one of the five decal spots on your car, with the game's own sponsors. Each needs a name and a logo. The menus show the logo as it is; on the car the game draws decals in the car's two decal colours, so the decals are made from the logo's light and dark parts (or from a separate decal picture, if you want a simpler one there).</p>
    <div class="row"><button class="btn primary" id="bAdd">Add a sponsor</button><span class="pill" id="bState"></span></div>
    <div id="bList" class="slist"></div></div>
    <div class="card" id="bEdit" style="display:none"></div>`;
  const style = document.createElement("style");
  style.textContent = `#brandBox .bcard img,#brandBox .bcard .ph{width:64px;height:64px;object-fit:contain;background:#0003;border-radius:6px} #brandBox .bpics{display:flex;gap:18px;flex-wrap:wrap}
  #brandBox .bpic img{width:160px;height:160px;object-fit:contain;background:#0003;border-radius:6px;display:block;margin:6px 0} #brandBox .bprev{max-width:100%;image-rendering:pixelated;background:#0003;border-radius:6px;display:block;margin-top:6px}`;
  document.head.appendChild(style);

  async function load(selId) {
    D = await api("/api/sponsors");
    $("#bList").innerHTML = D.brands.length ? D.brands.map(b => `<div class="scard bcard" data-id="${b.id}">${b.files.logo ? `<img src="/api/sponsors/brand/image?id=${b.id}&kind=logo&t=${Date.now()}">` : `<div class="ph"></div>`}<div><b>${esc(b.name)}</b><small>level ${esc(D.levels[b.level])}${b.files.logo ? "" : " · no logo yet (not in the game)"}</small></div></div>`).join("")
      : `<p class="hint">No sponsors added yet.</p>`;
    box.querySelectorAll(".bcard").forEach(c => c.onclick = () => edit(D.brands.find(b => b.id === +c.dataset.id)));
    $("#bAdd").disabled = D.brands.length >= D.maxBrands;
    if (selId) edit(D.brands.find(b => b.id === selId));
  }
  const st = (t, k = "") => { const s = $("#bState2"); if (s) { s.textContent = t; s.className = "pill " + k; } };
  function edit(b) {
    const fresh = !b; cur = structuredClone(b ?? { name: "", level: 1, files: {} }); pending = {};
    const e = $("#bEdit"); e.style.display = "";
    e.innerHTML = `<h2>${fresh ? "New sponsor" : esc(cur.name)}</h2>
      <div class="sgrid">
        <label>Name <input id="bName" maxlength="28" value="${esc(cur.name)}"></label>
        <label>Level <select id="bLevel">${D.levels.map((l, i) => `<option value="${i}"${i === cur.level ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
      </div>
      <p class="hint">Level: like the game's own sponsors, bigger sponsors pay more and are offered once your career earns them (level 0–1 from the start).</p>
      <div class="bpics">${[["logo", "Logo", "Menus (shown up to 128 x 128) and, unless you add a decal picture, the car decals. A PNG with a transparent background works best; a picture on a plain background has that colour cut away."],
        ["decal", "Decal picture (optional)", "Used for the car decals instead of the logo, e.g. a simpler one-colour version. Light parts take the car's first decal colour, dark parts its second."]].map(([k, l, h]) =>
        `<div class="bpic"><b>${l}</b><p class="hint" style="max-width:300px">${h}</p><img id="bi_${k}" alt=""><div class="row"><button class="btn" id="bp_${k}">Choose picture…</button><button class="btn danger" id="bx_${k}">Remove</button></div><input type="file" id="bf_${k}" accept="image/png,image/*" hidden></div>`).join("")}</div>
      <h3>Car decals</h3><p class="hint">How the decals come out, in the game's decal shapes (shown in white and dark grey; on the car they take its decal colours). Save to update.</p>
      <img id="bPrev" class="bprev" alt="">
      <div class="row" style="margin-top:14px"><button class="btn primary" id="bSave">${fresh ? "Add sponsor" : "Save"}</button>${fresh ? "" : `<button class="btn danger" id="bDel">Remove sponsor</button>`}<button class="btn" id="bClose">Close</button><span class="pill" id="bState2"></span></div>`;
    for (const k of ["logo", "decal"]) {
      $(`#bi_${k}`).src = cur.files?.[k] ? `/api/sponsors/brand/image?id=${cur.id}&kind=${k}&t=${Date.now()}` : "";
      $(`#bp_${k}`).onclick = () => $(`#bf_${k}`).click();
      $(`#bf_${k}`).onchange = async ev => { const f = ev.target.files[0]; if (!f) return; try { pending[k] = await toPng(f); $(`#bi_${k}`).src = URL.createObjectURL(pending[k]); st("not saved"); } catch (x) { st(String(x.message || x), "err"); } };
      $(`#bx_${k}`).onclick = () => { pending[k] = "delete"; $(`#bi_${k}`).src = ""; st("not saved"); };
    }
    $("#bPrev").src = cur.files?.logo || cur.files?.decal ? `/api/sponsors/brand/preview?id=${cur.id}&t=${Date.now()}` : "";
    $("#bSave").onclick = () => save().catch(x => st(String(x.message || x), "err"));
    $("#bClose").onclick = () => { e.style.display = "none"; cur = null; };
    if (!fresh) $("#bDel").onclick = async () => { if (!confirm(`Remove ${cur.name} from the sponsor list? Careers that signed it keep the money already paid, but it drops off the car.`)) return; await post("/api/sponsors/brand/delete", { id: cur.id }); e.style.display = "none"; load(); };
    e.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  // any picture the browser reads -> PNG (at most 1024 px on the long side)
  function toPng(file) {
    return new Promise((ok, bad) => { const im = new Image(); im.onload = () => {
      const s = Math.min(1, 1024 / Math.max(im.width, im.height)), cv = document.createElement("canvas"); cv.width = Math.max(1, Math.round(im.width * s)); cv.height = Math.max(1, Math.round(im.height * s));
      const x = cv.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(im, 0, 0, cv.width, cv.height);
      cv.toBlob(b => b ? ok(b) : bad(new Error("could not convert the picture")), "image/png"); URL.revokeObjectURL(im.src); };
      im.onerror = () => bad(new Error("that file is not a picture the browser can read")); im.src = URL.createObjectURL(file); });
  }
  async function save() {
    const name = $("#bName").value.trim(); if (!name) throw new Error("the sponsor needs a name");
    if (!cur.id && D.stockNames.some(n => n.toLowerCase() === name.toLowerCase()) && !confirm(`The game already has a sponsor called "${name}". Add another one?`)) return;
    if (!cur.id && !(pending.logo instanceof Blob)) throw new Error("choose a logo first");
    st("saving…", "run");
    const saved = await post("/api/sponsors/brand", { id: cur.id, name, level: +$("#bLevel").value });
    for (const k of ["logo", "decal"]) {
      if (pending[k] instanceof Blob) { const r = await fetch(`/api/sponsors/brand/image?id=${saved.id}&kind=${k}`, { method: "PUT", headers: { "content-type": "image/png" }, body: pending[k] }); if (!r.ok) throw new Error((await r.json()).error); }
      else if (pending[k] === "delete") await fetch(`/api/sponsors/brand/image?id=${saved.id}&kind=${k}`, { method: "DELETE" });
    }
    await load(saved.id); st("saved — restart the game to use it", "ok");
  }
  $("#bAdd").onclick = () => edit(null);
  load().catch(x => { $("#bList").textContent = `Could not load the sponsor list: ${x.message}`; });
})();
