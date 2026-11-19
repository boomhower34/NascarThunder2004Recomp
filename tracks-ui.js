// tracks-ui.js — the launcher's Tracks tab (page side; server side tracks-server.mjs). Builds into <section id="tracks">.
// A track pack is a 3D model that replaces one or more of the game's track models ("slots"); see track-pack.mjs.
(() => {
  const root = document.getElementById("tracks"); if (!root) return;
  const $ = (sel, el = root) => el.querySelector(sel);
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const api = async (path, opts = {}) => { const r = await fetch(path, opts); const j = r.headers.get("content-type")?.includes("json") ? await r.json() : null; if (!r.ok) throw new Error(j?.error || r.status); return j; };
  const post = (path, data) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  let D = null, open = null; const lastLog = new Map();   // (a pack's last build log: the editor is redrawn after a build)
  const slotName = s => { const x = D?.slots.find(y => y.slot === s); return x ? `${x.track || x.model} — ${x.races[0] ?? x.model}` : `slot ${s}`; };
  const slotOptions = sel => { const g = new Map(); for (const s of D.slots) { const k = s.track || "Other"; if (!g.has(k)) g.set(k, []); g.get(k).push(s); }
    return [...g].map(([t, ss]) => `<optgroup label="${esc(t)}">${ss.map(s => `<option value="${s.slot}"${sel?.includes(s.slot) ? " selected" : ""}>${esc(s.races.join(" / ") || s.model)} (${esc(s.model)})</option>`).join("")}</optgroup>`).join(""); };

  root.innerHTML = `
  <div class="card"><h2>Track packs</h2>
    <p class="hint" style="margin-top:0">A track pack is a 3D model of a track: new scenery, grandstands, signs, textures, or a whole remodelled track. It can be <b>added as a new track</b> (the game's tracks stay; the new one is listed at the end of the track list with its own name and race) or <b>replace</b> one of the game's track models. Either way it is based on one of the game's tracks: physics, the AI's racing lines and the pits come from that track, so the racing surface has to stay where that one is. Packs live in <code id="tRoot"></code>; nothing from the game is put in them except what you export yourself.</p>
    <div id="tList" style="margin-top:12px"></div>
    <div id="tWarn" class="hint" style="color:#e8a33d"></div>
  </div>
  <div class="card" id="tEdit" style="display:none"></div>
  <div class="card"><h2>NR2003 track to glTF</h2>
    <p class="hint" style="margin-top:0">Converts a NASCAR Racing 2003 track folder from your computer (the folder with its <code>.dat</code>, <code>.ptf</code> and <code>track.ini</code>) into three glTF files to open in Blender (File › Import › glTF 2.0), change as you like, and add to a track pack: <b>scenery</b> (what is drawn: the track's surfaces, walls and objects, plus painted pit stall boxes), <b>physics</b> (what the cars drive on) and <b>racing lines</b> (the AI's line, pit lane, stalls and starting grid). Objects the track borrows from NR2003's shared folders are left out unless you give those folders too (or export them below as objects to place yourself).</p>
    <div class="row"><label>Track folder <input id="tiFolder" placeholder="C:\\Papyrus\\NASCAR Racing 2003 Season\\tracks\\milwaukee" style="width:420px"></label></div>
    <div class="row" style="margin-top:8px"><label>Shared objects folder (optional) <input id="tiObjects" placeholder="C:\\Papyrus\\NASCAR Racing 2003 Season\\tracks\\_shared" style="width:360px"></label></div>
    <div class="row" style="margin-top:8px"><label>Save the files in (optional) <input id="tiOut" placeholder="(the launcher's roster\\converted folder)" style="width:360px"></label></div>
    <div class="row" style="margin-top:10px"><button class="btn primary" id="tiGo">Convert</button><span id="tiState" class="pill"></span></div>
    <pre id="tiLog" class="hint" style="white-space:pre-wrap;display:none"></pre>
    <div id="tConv" style="margin-top:10px"></div>
    <details style="margin-top:8px"><summary style="cursor:pointer;color:var(--dim)">What the physics and racing-lines files hold (for editing them, or making your own)</summary>
      <ul class="hint" style="margin:6px 0 0 18px;padding:0">
        <li>Object names are what count (an object's or its mesh's name, any case). Metres, Y up.</li>
        <li><b>Physics:</b> <code>centerline</code> a closed line along the track at road height, driven counter-clockwise from <code>start</code> (an empty at the start / finish line); <code>road</code> the racing surface (its heights give the banking, its two edges the width); <code>walls</code> / <code>wall…</code> / <code>barrier…</code> vertical faces where the walls stand; <code>pit_wall</code> the wall between the track and pit road; <code>pit_area</code> pit road and its stalls (on the inside of the track); <code>ground</code> the ground across (apron, infield, pit road heights).</li>
        <li><b>Racing lines:</b> <code>raceline</code> a closed line the AI races on (its <code>_AISPEED</code> attribute: relative speed per point; without it the speeds are worked out from the corners); <code>pit_lane</code> a line from the pit entry to the exit; <code>pit_stall_01</code>… empties at the stalls; <code>grid_01</code>… empties for the starting grid facing forward (+X), <code>grid_pace</code> the pace car. The scene's custom properties hold the record lap and the pit and pace speed limits.</li>
        <li>Without a racing-lines file the AI's lines are the base track's, bent along the new track.</li>
      </ul></details>
  </div>
  <div class="card"><h2>New track pack</h2>
    <div class="row"><label><input type="radio" name="tnMode" value="add" checked> Add as a new track</label><label><input type="radio" name="tnMode" value="replace"> Replace one of the game's tracks</label></div>
    <div class="row" style="margin-top:8px"><label>Name <input id="tnName" placeholder="Purple Motor Speedway" style="width:240px"></label>
      <label><span id="tnSlotL">Based on</span> <select id="tnSlot" style="max-width:420px"></select></label></div>
    <div class="row" id="tnTrack" style="margin-top:8px"><label>Short name <input id="tnShort" maxlength="21" placeholder="Purple" style="width:130px"></label>
      <label>City <input id="tnCity" maxlength="18" style="width:130px"></label><label>State <input id="tnState2" maxlength="2" style="width:50px"></label>
      <label>Race <input id="tnRace" maxlength="34" placeholder="Purple 500" style="width:190px"></label><label>Laps <input type="number" id="tnLaps" min="1" max="9999" style="width:80px"></label></div>
    <div class="row" id="tnFiles" style="margin-top:10px"><label>Scenery <input type="file" id="tnScenery" accept=".glb,.gltf"></label><label>Physics <input type="file" id="tnPhysics" accept=".glb,.gltf"></label><label>Racing lines <input type="file" id="tnLines" accept=".glb,.gltf"></label>
      <button class="btn primary" id="tnGltf">Create from these files</button></div>
    <div class="row" style="margin-top:10px">
      <button class="btn primary" id="tnGame">Start from the game's model</button>
      <button class="btn" id="tnEmpty">Start empty (upload a model)</button><span id="tnState" class="pill"></span></div>
    <p class="hint">"Start from the game's model" exports that track from your copy of the game as <code>model.gltf</code> with its textures, ready to open in Blender (File › Import › glTF), plus <code>physics-reference.gltf</code>: where the game's racing surface, apron, grass, pit road and walls are (import it too to line your model up; it is not built). Edit it, export it again as glTF over the same file (tick Include › Custom Properties to keep the game's layered materials), then press Build.</p>
    <details style="margin-top:8px"><summary style="cursor:pointer;color:var(--dim)">Making a model from scratch</summary>
      <ul class="hint" style="margin:6px 0 0 18px;padding:0">
        <li>Metres, Y up (glTF's own convention; Blender's exporter converts). Line it up with the original: export a starter pack of the same track and model on top of it.</li>
        <li>Textures: PNG, any size (rounded to a power of two, at most 1024). See-through textures need the material's blend mode set to Alpha Clip or Alpha Blend.</li>
        <li>Vertex colours (a "Color" attribute) are the lighting the game shows; without them everything is fully lit.</li>
        <li>Objects repeated many times (fence posts, light poles) are cheapest as linked duplicates (Alt+D): the game draws one copy at each place.</li>
      </ul></details>
  </div>
  <div class="card"><h2>Object library</h2>
    <p class="hint" style="margin-top:0">Track-side objects as separate .glb files, each standing on its own origin, to import into a track's scenery in Blender and place: pit carts, pit towers, pit banners, tyre stacks, caution lights, light poles, signs, buildings… from one of the game's tracks (taken from your copy of the game), or NR2003 objects (.3do) from a track folder or NR2003's shared objects folders, which a converted track leaves out. Saved in <code id="oRoot"></code>.</p>
    <div class="row"><label>From the game's track <select id="oSlot" style="max-width:380px"></select></label><label><input type="checkbox" id="oRep"> only objects used more than once</label><button class="btn" id="oGame">Export</button></div>
    <div class="row" style="margin-top:8px"><label>NR2003 folder <input id="oNr" placeholder="C:\\Papyrus\\NASCAR Racing 2003 Season\\tracks\\_shared" style="width:380px"></label><button class="btn" id="oNrGo">Export</button></div>
    <div class="row" style="margin-top:6px"><span id="oState" class="pill"></span></div>
  </div>`;
  const style = document.createElement("style");
  style.textContent = `
  .tpack{display:grid;grid-template-columns:1fr auto;gap:6px 14px;align-items:center;background:#0b0e13;border:1px solid var(--line);border-radius:9px;padding:10px 12px;margin-bottom:8px}
  .tpack.on{border-color:var(--accent)} .tpack b{font-size:14px} .tpack small{color:var(--dim)} .tpack .row{gap:6px;justify-content:flex-end}
  .tstate{font-size:11.5px;padding:1px 8px;border-radius:99px;border:1px solid var(--line);color:var(--dim);margin-left:6px}
  .tkind{font-size:11.5px;padding:1px 8px;border-radius:99px;background:#1c232c;color:var(--dim);margin-left:6px}
  .tstate.ok{color:#7fd17f;border-color:#2e5a2e}.tstate.old{color:#e8a33d;border-color:#6a4a16}.tstate.err{color:#ff8a80;border-color:#6a2a2a}
  #tEdit select[multiple]{width:100%;min-height:160px} #tEdit pre{max-height:220px}`;
  document.head.appendChild(style);

  const stateTag = p => { const s = p.state; if (s.error) return `<span class="tstate err">${esc(s.error)}</span>`; if (s.building) return `<span class="tstate">building…</span>`;
    if (!p.meta?.model && !(p.meta?.mode === "add" && (p.meta?.layout || p.meta?.physics))) return `<span class="tstate old">no model yet</span>`; if (!s.built) return `<span class="tstate old">not built</span>`; if (!s.fresh) return `<span class="tstate old">changed since the last build</span>`;
    return `<span class="tstate ok">built</span>`; };

  async function load() {
    D = await api("/api/tracks"); $("#tRoot").textContent = D.root;
    if (!$("#tnSlot").options.length) $("#tnSlot").innerHTML = slotOptions([28]);
    if (!$("#oSlot").options.length) { $("#oSlot").innerHTML = slotOptions([28]); loadConverted(); }
    $("#tList").innerHTML = D.packs.length ? D.packs.map(p => `<div class="tpack${open === p.id ? " on" : ""}" data-id="${esc(p.id)}">
      <div><b>${esc(p.meta?.name || p.id)}</b><span class="tkind">${p.meta?.mode === "add" ? "new track" : "replaces"}</span>${stateTag(p)}<br><small>${!p.meta ? "" : p.meta.mode === "add" ? `${esc(p.meta.track?.name ?? "")} · ${esc(p.meta.track?.race ?? "")} · based on ${esc(slotName(p.meta.base?.slot))}` : p.meta.slots.map(s => esc(slotName(s))).join(" · ") || "no slot chosen"}</small></div>
      <div class="row"><label style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-act="enable"${p.meta?.enabled ? " checked" : ""}> In the game</label>
        <button class="btn" data-act="build">Build</button><button class="btn" data-act="edit">Edit</button></div></div>`).join("") : `<p class="hint">No track packs yet.</p>`;
    $("#tWarn").innerHTML = D.conflicts.map(c => `${esc(slotName(c.slot))}: ${c.ids.map(esc).join(", ")} all replace it; the game uses ${esc(c.used)}.`).join("<br>");
    root.querySelectorAll(".tpack[data-id]").forEach(el => { const id = el.dataset.id;
      el.querySelector("[data-act=enable]").onchange = e => post("/api/tracks/save", { id, meta: { enabled: e.target.checked } }).then(load).catch(alert);
      el.querySelector("[data-act=build]").onclick = () => build(id);
      el.querySelector("[data-act=edit]").onclick = () => { open = open === id ? null : id; load(); }; });
    edit();
  }
  async function build(id, logEl) {
    const p = D.packs.find(x => x.id === id); p.state.building = true; await load().catch(() => {});
    try { const r = await post("/api/tracks/build", { id }); lastLog.set(id, r.log); if (logEl ?? $("#tLog")) (logEl ?? $("#tLog")).textContent = r.log; else if (!r.ok) alert(r.error);
      if (!r.ok && !open) alert(`Build failed: ${r.error}`); } catch (e) { alert(e.message); }
    await load();
  }
  function edit() {
    const box = $("#tEdit"), p = open && D.packs.find(x => x.id === open); if (!p) { box.style.display = "none"; return; }
    box.style.display = ""; const m = p.meta ?? { name: "", slots: [], model: "" };
    const models = p.files.filter(f => /\.(glb|gltf)$/i.test(f) && !/^physics-reference/i.test(f));   // (the physics reference is not a model to build)
    const gl = p.files.filter(f => /\.(glb|gltf)$/i.test(f) && !/^physics-reference/i.test(f));
    box.innerHTML = `<h2>${esc(m.name || p.id)}</h2>
      <div class="row"><label>Name <input id="teName" value="${esc(m.name)}" style="width:220px"></label><label>Author <input id="teAuthor" value="${esc(m.author)}" style="width:180px"></label>
        <label>Model <select id="teModel">${m.mode === "add" ? `<option value=""${!m.model ? " selected" : ""}>none: the base track's scenery (along the layout)</option>` : ""}${models.length ? models.map(f => `<option${f === m.model ? " selected" : ""}>${esc(f)}</option>`).join("") : m.mode === "add" ? "" : `<option value="">(upload one)</option>`}</select></label></div>
      ${m.mode === "add" ? `<div class="row" style="margin-top:10px"><label>Track name <input id="teTName" maxlength="38" value="${esc(m.track?.name)}" style="width:220px"></label><label>Short name <input id="teTShort" maxlength="21" value="${esc(m.track?.short)}" style="width:130px"></label>
        <label>City <input id="teTCity" maxlength="18" value="${esc(m.track?.city)}" style="width:130px"></label><label>State <input id="teTState" maxlength="2" value="${esc(m.track?.state)}" style="width:50px"></label>
        <label>Race <input id="teTRace" maxlength="34" value="${esc(m.track?.race)}" style="width:190px"></label><label>Laps <input type="number" id="teTLaps" min="1" max="9999" value="${esc(m.track?.laps ?? "")}" style="width:80px"></label></div>
        <div class="row" style="margin-top:10px"><label>Physics <select id="tePhys"><option value="">none</option>${gl.map(f => `<option${f === m.physics ? " selected" : ""}>${esc(f)}</option>`).join("")}</select></label><input type="file" id="tePhysUp" accept=".glb,.gltf" title="add a physics file">
          <label>Racing lines <select id="teLines"><option value="">the base track's (bent along)</option>${gl.map(f => `<option${f === m.lines ? " selected" : ""}>${esc(f)}</option>`).join("")}</select></label><input type="file" id="teLinesUp" accept=".glb,.gltf" title="add a racing-lines file"></div>
        <div class="row" style="margin-top:10px"${m.physics ? ' title="not used while a physics file is chosen"' : ""}><label>${m.physics ? "<s>Layout</s>" : "Layout"} <select id="teLayout"><option value="">the base track's</option>${p.files.filter(f => /\.json$/i.test(f) && f !== "track.json").map(f => `<option${f === m.layout ? " selected" : ""}>${esc(f)}</option>`).join("")}${p.files.filter(f => /\.(glb|gltf)$/i.test(f) && !/^physics-reference/i.test(f)).map(f => `<option value="${esc(f)}"${f === m.layout ? " selected" : ""}>centerline in ${esc(f)}</option>`).join("")}</select></label>
          <label>Banking: straights <input type="number" id="teBankS" value="${esc(m.layoutOptions?.bankStraight ?? "")}" placeholder="5" style="width:60px">°</label><label>turns <input type="number" id="teBankT" value="${esc(m.layoutOptions?.bankTurn ?? "")}" placeholder="20" style="width:60px">°</label></div>
        <p class="hint">New track based on ${esc(slotName(m.base?.slot))}. <b>Physics</b> and <b>racing lines</b>: glTF files as the NR2003 converter writes them, or your own with the same names (see "What the physics and racing-lines files hold" below); the base track's physics and AI lines are reshaped to them. Otherwise, with its base track's layout it uses that track's physics, AI lines and pits as they are. With a layout of its own (a centerline: a JSON file of points, or an edge loop named "centerline" in a model; driven counter-clockwise from its first point or an object named "start"; in a model, a mesh or material named "road" / "track" / "asphalt" sets the heights, banking and width along it, so the cars drive on the modelled road, and the banking boxes are then not used; meshes named "wall" / "barrier" / "safer" set where the walls stand; a mesh named "pit" (pit road / pit lane) sets where the pit road and stalls go, along the stretch where the base track has its pits (usually the front stretch); every other mesh is ground for the apron, pit road and infield heights) the base track's physics, AI lines, pit road, grid and AI speeds are carried along the new shape, and without a model of its own so is its scenery. Build writes <code>physics-reference.gltf</code> for modelling around it. Listed last in the track list. Ids: track ${m.ids?.trid}, race ${m.ids?.raid}, model ${m.ids?.rtid}${m.ids?.tpid ? `, physics ${m.ids.tpid}` : ""}.</p>
        ${p.state.info?.layout ? `<div style="background:#fff;border-radius:8px;padding:6px;display:inline-block"><img src="/api/tracks/layout.svg?id=${encodeURIComponent(p.id)}&t=${Date.now()}" style="max-width:420px;display:block"></div><p class="hint">${p.state.info.miles.toFixed(3)} miles; red: the new layout, grey: the base track.</p>` : ""}`
      : `<label style="display:block;margin-top:10px">Replaces (Ctrl-click for more than one: day and night versions are separate)<select id="teSlots" multiple>${slotOptions(m.slots)}</select></label>`}
      <div class="row" style="margin-top:10px"><label>Add files <input type="file" id="teFiles" multiple accept=".glb,.gltf,.bin,.png,.json"></label>
        <label>or a folder <input type="file" id="teDir" webkitdirectory></label><span id="teUp" class="pill"></span></div>
      <p class="hint">Folder: <code>${esc(p.dir)}</code> — files: ${p.files.map(esc).join(", ") || "none"}.${p.state.info ? ` Last build: ${p.state.info.pieces} pieces, ${(p.state.info.drawn ?? p.state.info.triangles).toLocaleString()} triangles, ${p.state.info.textures} textures, ${new Date(p.state.info.built).toLocaleString()}.` : ""}</p>
      <div class="row" style="margin-top:10px"><button class="btn primary" id="teSave">Save</button><button class="btn" id="teBuild">Save and build</button>
        <button class="btn danger" id="teDel" style="margin-left:auto">Delete pack</button></div>
      <pre class="log" id="tLog" style="height:auto;min-height:40px">${esc(lastLog.get(p.id) ?? "")}</pre>`;
    const save = () => post("/api/tracks/save", { id: p.id, meta: { name: $("#teName").value, author: $("#teAuthor").value, model: m.mode === "add" ? $("#teModel").value : ($("#teModel").value || undefined),
      ...(m.mode === "add" ? { track: { name: $("#teTName").value, short: $("#teTShort").value, city: $("#teTCity").value, state: $("#teTState").value, race: $("#teTRace").value, laps: $("#teTLaps").value }, layout: $("#teLayout").value, physics: $("#tePhys").value, lines: $("#teLines").value, layoutOptions: { bankStraight: $("#teBankS").value, bankTurn: $("#teBankT").value } }
        : { slots: [...$("#teSlots").selectedOptions].map(o => +o.value) }) } });
    $("#teSave").onclick = () => save().then(load).catch(e => alert(e.message));
    $("#teBuild").onclick = () => save().then(() => build(p.id, $("#tLog"))).catch(e => alert(e.message));
    $("#teDel").onclick = () => { if (confirm(`Delete the track pack "${m.name || p.id}" and its files?`)) post("/api/tracks/delete", { id: p.id }).then(() => { open = null; load(); }).catch(e => alert(e.message)); };
    const upload = async files => { const st = $("#teUp"); let k = 0;
      for (const f of files) { const rel = (f.webkitRelativePath ? f.webkitRelativePath.split("/").slice(1).join("/") : f.name); if (!/\.(glb|gltf|bin|png|json)$/i.test(rel)) continue;
        st.textContent = `uploading ${++k}: ${rel}`; await api(`/api/tracks/file?id=${encodeURIComponent(p.id)}&name=${encodeURIComponent(rel)}`, { method: "PUT", body: f }); }
      st.textContent = k ? `${k} file(s) added` : "nothing to add (.glb, .gltf, .bin, .png, .json)"; await load(); };
    $("#teFiles").onchange = e => upload([...e.target.files]).catch(err => alert(err.message));
    // a physics / racing-lines file: added to the pack and chosen
    for (const [inp, sel] of [["#tePhysUp", "#tePhys"], ["#teLinesUp", "#teLines"]]) { const el = $(inp); if (!el) continue;
      el.onchange = async e => { const f = e.target.files[0]; if (!f) return; try { $("#teUp").textContent = `uploading ${f.name}`; await api(`/api/tracks/file?id=${encodeURIComponent(p.id)}&name=${encodeURIComponent(f.name)}`, { method: "PUT", body: f });
        const keep = { physics: $("#tePhys").value, lines: $("#teLines").value }; keep[sel === "#tePhys" ? "physics" : "lines"] = f.name; await post("/api/tracks/save", { id: p.id, meta: keep }); $("#teUp").textContent = `${f.name} added`; await load(); } catch (err) { alert(err.message); } }; }
    $("#teDir").onchange = e => upload([...e.target.files]).catch(err => alert(err.message));
  }
  const create = from => async () => { const st = $("#tnState"); st.textContent = from === "game" ? "exporting the game's model…" : "creating…";
    const mode = root.querySelector("[name=tnMode]:checked").value;
    try { const r = await post("/api/tracks/new", { name: $("#tnName").value, slot: +$("#tnSlot").value, from, mode,
        track: mode === "add" ? { name: $("#tnName").value, short: $("#tnShort").value, city: $("#tnCity").value, state: $("#tnState2").value, race: $("#tnRace").value, laps: $("#tnLaps").value } : undefined }); open = r.id; st.textContent = ""; await load(); $("#tEdit").scrollIntoView({ behavior: "smooth" }); }
    catch (e) { st.textContent = e.message; } };
  root.querySelectorAll("[name=tnMode]").forEach(r => r.onchange = () => { const add = root.querySelector("[name=tnMode]:checked").value === "add"; $("#tnTrack").style.display = add ? "" : "none"; $("#tnSlotL").textContent = add ? "Based on" : "Replaces"; });
  $("#tnGame").onclick = create("game"); $("#tnEmpty").onclick = create("empty");
  const trackFields = () => ({ name: $("#tnName").value, short: $("#tnShort").value, city: $("#tnCity").value, state: $("#tnState2").value, race: $("#tnRace").value, laps: $("#tnLaps").value });
  async function loadConverted() { try { const C = await api("/api/tracks/converted"); $("#oRoot").textContent = C.objects;
      $("#tConv").innerHTML = C.items.length ? `<p class="hint" style="margin:0 0 6px">Converted tracks in <code>${esc(C.root)}</code>:</p>` + C.items.map(c => `<div class="tpack tconv" data-conv="${esc(c.dir)}"><div><b>${esc(c.name)}</b><br><small>${esc(Object.values(c.files).join(" · "))} — in <code>${esc(c.path)}</code></small></div>
        <div class="row"><input class="convName" value="${esc(c.name)}" style="width:180px" title="the track's name in the game"><button class="btn" data-act="pack">Make a track pack</button></div></div>`).join("") : "";
      $("#tConv").querySelectorAll("[data-conv]").forEach(el => el.querySelector("[data-act=pack]").onclick = async () => { const c = C.items.find(x => x.dir === el.dataset.conv), nm = el.querySelector(".convName").value || c.name;
        try { const r = await post("/api/tracks/new", { name: nm, slot: +$("#tnSlot").value || 28, from: "converted", converted: c.dir, mode: "add", track: { name: nm, short: nm.split(" ")[0], race: `${nm.split(" ")[0]} ${c.track.laps ?? 200}`, laps: c.track.laps } });
          open = r.id; await load(); $("#tEdit").scrollIntoView({ behavior: "smooth" }); } catch (e) { alert(e.message); } }); }
    catch (e) { $("#tConv").textContent = e.message; } }
  $("#tiGo").onclick = async () => { const st = $("#tiState"), lg = $("#tiLog"); st.textContent = "converting…"; lg.style.display = "none";
    try { const r = await post("/api/tracks/nr2003-gltf", { folder: $("#tiFolder").value, objects: $("#tiObjects").value ? [$("#tiObjects").value] : [], out: $("#tiOut").value });
      st.textContent = `written to ${r.out}`; lg.textContent = r.log.join("\n"); lg.style.display = r.log.length ? "" : "none"; await loadConverted(); }
    catch (e) { st.textContent = e.message; } };
  $("#tnGltf").onclick = async () => { const st = $("#tnState"), F = { model: $("#tnScenery").files[0], physics: $("#tnPhysics").files[0], lines: $("#tnLines").files[0] };
    if (!F.model && !F.physics) { st.textContent = "choose a scenery and / or a physics file"; return; }
    if (root.querySelector("[name=tnMode]:checked").value !== "add") { st.textContent = "physics and racing lines are for a new track (Add as a new track)"; if (F.physics || F.lines) return; }
    try { st.textContent = "creating…"; const mode = root.querySelector("[name=tnMode]:checked").value, r = await post("/api/tracks/new", { name: $("#tnName").value || (F.model ?? F.physics).name.replace(/(_scenery|_physics)?\.(glb|gltf)$/i, ""), slot: +$("#tnSlot").value, from: "empty", mode, track: mode === "add" ? trackFields() : undefined });
      const meta = {}; for (const [k, f] of Object.entries(F)) if (f) { st.textContent = `uploading ${f.name}`; await api(`/api/tracks/file?id=${encodeURIComponent(r.id)}&name=${encodeURIComponent(f.name)}`, { method: "PUT", body: f }); meta[k] = f.name; }
      await post("/api/tracks/save", { id: r.id, meta }); open = r.id; st.textContent = ""; await load(); $("#tEdit").scrollIntoView({ behavior: "smooth" }); }
    catch (e) { st.textContent = e.message; } };
  const objDone = r => { $("#oState").textContent = `${r.count} objects saved in ${r.dir}`; };
  $("#oGame").onclick = async () => { $("#oState").textContent = "exporting…"; try { objDone(await post("/api/tracks/objects", { source: "game", slot: +$("#oSlot").value, repeatedOnly: $("#oRep").checked })); } catch (e) { $("#oState").textContent = e.message; } };
  $("#oNrGo").onclick = async () => { $("#oState").textContent = "exporting…"; try { objDone(await post("/api/tracks/objects", { source: "nr2003", folders: [$("#oNr").value] })); } catch (e) { $("#oState").textContent = e.message; } };
  document.querySelector('nav [data-tab="tracks"]')?.addEventListener("click", () => load().catch(e => $("#tList").textContent = e.message));
  $("#tList").textContent = "loading…";        // (first visit: the track list is read from TK_REND.DAT once, ~15 s)
})();
