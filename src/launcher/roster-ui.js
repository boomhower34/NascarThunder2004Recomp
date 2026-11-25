// roster-ui.js — the launcher's Roster tab (page side; server side roster-server.mjs). Builds into <section id="roster">.
// A driver is edited as a copy of an existing car: picking "Start from" fills the ratings, team, make and number
// from that car, then everything can be changed. Pictures are converted to PNG at the game's sizes here.
(() => {
  const root = document.getElementById("roster"); if (!root) return;
  const $ = (sel, el = root) => el.querySelector(sel);
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const api = async (path, opts = {}) => { const r = await fetch(path, opts); const j = r.headers.get("content-type")?.includes("json") ? await r.json() : null; if (!r.ok) throw new Error(j?.error || r.status); return j; };
  const post = (path, data) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  const SIZES = { portrait: [512, 512], closeup: [256, 256], number: [512, 256], paint: [512, 512], pitSign: [512, 128] };   // (pit sign: 128 x 32 in the game)
  const TRACKS = [["0", "Short tracks"], ["1", "Speedways"], ["2", "Superspeedways"], ["3", "Road courses"]];
  const RATINGS = [["speed", "Speed"], ["control", "Car control"], ["defense", "Defense"], ["aggression", "Aggression"], ["durability", "Durability"]];
  const FONTS = { sans: "900 italic 210px Impact, 'Arial Black', sans-serif", serif: "900 italic 210px Georgia, 'Times New Roman', serif", block: "900 220px 'Arial Black', Impact, sans-serif", script: "italic 700 210px 'Brush Script MT', 'Segoe Script', cursive" };
  let data = null, cur = null, pending = {};            // pending: kind -> Blob waiting for Save

  root.innerHTML = `
  <div class="card"><h2>Drivers you added</h2>
    <p class="hint" style="margin-top:0">Each driver gets their own car, copied from a car in the game: pick it under "Start from", then change the name, number, team and ratings, and add a portrait and a paint scheme. New drivers race in Race Now and in seasons and careers started after you add them (saved seasons keep their own field). Restart the game to see changes.</p>
    <div class="row" id="rList" style="gap:10px;margin-top:10px"></div>
  </div>
  <div class="card" id="rEdit" style="display:none"></div>
  <div class="card" id="tCard"><h2>Teams</h2>
    <p class="hint" style="margin-top:0">Add your own teams, rename the game's, and choose which cars run for which team. A team is a name the game shows with its cars (car select, results, driver screens); in a career it is also who hires the drivers (with "Team prestige and driver contracts" in the Career tab, its prestige decides who it can sign). Your drivers pick their team in their own editor; the game's cars can be moved here. Seasons and careers started before keep their own teams.</p>
    <div class="row"><button class="btn primary" id="tAdd">Add a team</button><input id="tFind" placeholder="find a team" style="flex:1;min-width:160px"><span class="tag" id="tCount"></span></div>
    <div id="tList" class="tlist"></div>
    <div id="tEdit" style="display:none;margin-top:14px;border-top:1px solid var(--line);padding-top:12px"></div>
  </div>
  <div class="card"><h2>The game's drivers</h2>
    <p class="hint" style="margin-top:0">Untick a driver to take them out of the game: they no longer show in car select and never race. The field stays 43: the next drivers by popularity fill in (from the secondary list, then the Busch and fill-in ones). Their cars can still be used under "Start from" for a driver you add. Seasons and careers started before keep their own field.</p>
    <div class="row" style="gap:10px;align-items:center"><select id="gClass"></select><input id="gFind" placeholder="find a driver or number" style="flex:1;min-width:160px"><span class="tag" id="gCount"></span><button class="btn" id="gAll">Tick all shown</button><button class="btn primary" id="gSave">Save</button><span class="pill" id="gState"></span></div>
    <div id="gList" style="columns:3 240px;margin-top:10px"></div>
  </div>
  <div class="card" id="cpCard"><h2>Paint schemes of the game's cars</h2>
    <p class="hint" style="margin-top:0">Repaint any of the game's own cars without adding a new driver: pick the car, then replace one of its paint schemes with your own picture (download the scheme as the template, paint over it, choose it here), untick "In the game" to take a scheme out of the paint scheme menu (each car keeps at least one main scheme), or add schemes of your own to the menu. The car keeps its driver, number, team and scheme name; only the paint changes, in every mode and in seasons and careers you already have. "Back to the game's" brings the original back.</p>
    <div class="row" id="cpSelRow" style="gap:10px;align-items:center"><select id="cpCar" style="flex:1;min-width:240px"></select><input id="cpFind" placeholder="find a driver or number" style="min-width:160px"><span class="pill" id="cpState"></span></div>
    <p class="hint" id="cpAway" style="display:none"></p>
    <div id="cpList" class="rpics" style="margin-top:12px"></div><input type="file" id="cpFile" accept="image/*" hidden>
  </div>`;
  const style = document.createElement("style");
  style.textContent = `
  .rcard{display:flex;gap:10px;align-items:center;background:#0b0e13;border:1px solid var(--line);border-radius:9px;padding:8px 12px 8px 8px;cursor:pointer;min-width:200px}
  .rcard:hover,.rcard.on{border-color:var(--accent)} .rcard img,.rcard .ph{width:44px;height:44px;border-radius:6px;object-fit:cover;background:#1c232c}
  .rcard b{display:block} .rcard small{color:var(--dim)} .radd{justify-content:center;color:var(--accent);font-weight:600}
  .rgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px 18px}
  .rgrid label{display:flex;flex-direction:column;gap:4px} .rgrid input,.rgrid select{width:100%}
  .rsl{display:grid;grid-template-columns:130px 1fr 36px;align-items:center;gap:8px;margin:4px 0}
  .rsl span{color:var(--dim);font-size:13px} .rsl output{text-align:right;font-variant-numeric:tabular-nums}
  .rpics{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px}
  .rpic{background:#0b0e13;border:1px solid var(--line);border-radius:9px;padding:10px}
  .rpic .img{height:150px;display:flex;align-items:center;justify-content:center;background:repeating-conic-gradient(#151a21 0 25%,#10141a 0 50%) 0/16px 16px;border-radius:6px;margin:8px 0;overflow:hidden}
  .rpic .img img,.rpic .img canvas{max-width:100%;max-height:100%}
  .rpic h3{margin:0;font-size:13.5px}.rpic .row{gap:6px}
  .rsec{margin-top:18px} .rsec>h3{font-size:14px;margin:0 0 8px}
  .tlist{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:6px;margin-top:10px} .tcard{padding:6px 10px;border:1px solid var(--line);border-radius:8px;cursor:pointer;background:#0b0e13} .tcard:hover,.tcard.on{border-color:var(--accent)} .tcard small{color:var(--dim);display:block}
  .tcars{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:6px 18px;margin-top:8px} .tcars label{display:flex;gap:8px;align-items:center} .tcars select{max-width:190px}
  .pill:empty{display:none} .tag{font-size:11.5px;padding:1px 7px;border-radius:99px;border:1px solid var(--line);color:var(--dim)}`;
  document.head.appendChild(style);

  // ---------------------------------------------------------------- teams
  let tSel = null;
  const teamOfCar = c => data.carTeams?.[c.crid] ?? c.team;                   // a game car's team (moved or its own)
  const ts = (t, k = "") => { const x = $("#tState"); if (x) { x.textContent = t; x.className = "pill " + k; } };
  function drawTeams(listOnly) {
    const f = $("#tFind").value.trim().toLowerCase(), n = id => data.base.cars.filter(c => [1, 2, 3, 4].includes(c.class) && teamOfCar(c) === id).length + data.drivers.filter(d => d.car?.team === id).length;
    const list = data.base.teams.filter(t => !f || t.name.toLowerCase().includes(f)).sort((a, b) => (b.mine ? 1 : 0) - (a.mine ? 1 : 0) || a.name.localeCompare(b.name));
    $("#tList").innerHTML = list.map(t => `<div class="tcard${t.id === tSel ? " on" : ""}" data-t="${t.id}"><b>${esc(t.name)}</b><small>${t.mine ? "your team" : t.name !== t.own ? `the game's (${esc(t.own)})` : "the game's"} · ${n(t.id)} car${n(t.id) === 1 ? "" : "s"}</small></div>`).join("");
    $("#tList").querySelectorAll(".tcard").forEach(c => c.onclick = () => editTeam(+c.dataset.t));
    $("#tCount").textContent = `${data.teams?.length ?? 0} of yours, ${data.gameTeams.length} of the game's`;
    if (!listOnly && tSel !== null && data.base.teams.some(t => t.id === tSel)) editTeam(tSel, true);
  }
  function editTeam(id, keep) {
    const t = id === null ? null : data.base.teams.find(x => x.id === id), e = $("#tEdit"); tSel = id; e.style.display = "";
    $("#tList").querySelectorAll(".tcard").forEach(c => c.classList.toggle("on", +c.dataset.t === id));
    const opts = sel => data.base.teams.map(x => `<option value="${x.id}"${x.id === sel ? " selected" : ""}>${esc(x.name)}</option>`).join("");
    const mineCars = t ? data.base.cars.filter(c => [1, 2, 3, 4].includes(c.class) && teamOfCar(c) === t.id) : [], myDrivers = t ? data.drivers.filter(d => d.car?.team === t.id) : [];
    const others = t ? data.base.cars.filter(c => [1, 2, 3].includes(c.class) && teamOfCar(c) !== t.id).sort((a, b) => (+a.numberText || 999) - (+b.numberText || 999)) : [];
    const cls = { 1: "primary", 2: "secondary", 3: "Busch", 4: "fill-in" };
    e.innerHTML = `<h3 style="margin-top:0">${t ? esc(t.name) : "New team"}</h3>
      <div class="rgrid"><label>Name <input id="tName" maxlength="28" value="${esc(t?.name ?? "")}"></label>
        ${!t || t.mine ? `<label>Career starting prestige (0–100) <input id="tPres" type="number" min="0" max="100" placeholder="from its drivers" value="${t?.prestige ?? ""}"></label>` : ""}</div>
      ${!t || t.mine ? `<p class="hint">Prestige is used with "Team prestige and driver contracts" in the Career tab: a team only hires drivers whose standing is close to it. Empty: worked out from its drivers in the first off-season, as for the game's teams.</p>` : `<p class="hint">The game's team: you can rename it (empty the name for its own back).</p>`}
      ${t ? `<h3>Cars on this team</h3>${mineCars.length || myDrivers.length ? `<div class="tcars">${mineCars.map(c => `<label><span style="flex:1"><b>#${esc(c.numberText)}</b> ${esc(c.driver)} <small style="color:var(--dim)">${cls[c.class]}</small></span><select data-move="${c.crid}"><option value="">move to…</option>${opts(-1)}</select></label>`).join("")}
        ${myDrivers.map(d => `<label><span style="flex:1"><b>#${esc(d.car.number)}</b> ${esc(d.first)} ${esc(d.last)} <small style="color:var(--dim)">yours: change in his editor</small></span></label>`).join("")}</div>` : `<p class="hint">No cars yet.</p>`}
        <div class="row" style="margin-top:8px"><select id="tTake" style="flex:1;min-width:220px"><option value="">Bring one of the game's cars to this team…</option>${others.map(c => `<option value="${c.crid}">#${esc(c.numberText)} ${esc(c.driver)} (${esc(data.base.teams.find(x => x.id === teamOfCar(c))?.name ?? "")}, ${cls[c.class]})</option>`).join("")}</select></div>` : ""}
      <div class="row" style="margin-top:12px"><button class="btn primary" id="tSave">${t ? "Save" : "Add team"}</button>${t?.mine ? `<button class="btn danger" id="tDel">Remove team</button>` : ""}<button class="btn" id="tClose">Close</button><span class="pill" id="tState"></span></div>`;
    $("#tSave").onclick = async () => { try { const pv = $("#tPres")?.value ?? ""; const r = await post("/api/roster/team", { id: t?.id ?? null, name: $("#tName").value, prestige: pv === "" ? null : +pv }); tSel = r.id; await load(); ts("saved — restart the game to use it", "ok"); } catch (x) { ts(String(x.message || x), "err"); } };
    $("#tClose").onclick = () => { e.style.display = "none"; tSel = null; drawTeams(); };
    if (t?.mine) $("#tDel").onclick = async () => { if (!confirm(`Remove the team ${t.name}?`)) return; try { await post("/api/roster/team/delete", { id: t.id }); tSel = null; e.style.display = "none"; await load(); } catch (x) { ts(String(x.message || x), "err"); } };
    const move = async (crid, team) => { try { await post("/api/roster/carteam", { crid, team }); await load(); ts("saved — restart the game to use it", "ok"); } catch (x) { ts(String(x.message || x), "err"); } };
    e.querySelectorAll("select[data-move]").forEach(sel => sel.onchange = () => sel.value !== "" && move(+sel.dataset.move, +sel.value));
    $("#tTake") && ($("#tTake").onchange = () => $("#tTake").value && move(+$("#tTake").value, t.id));
    if (!keep) e.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  $("#tAdd").onclick = () => editTeam(null); $("#tFind").oninput = () => drawTeams(true);

  let removed = new Set();
  function drawGame() {
    const cls = $("#gClass").value, f = $("#gFind").value.trim().toLowerCase(), cars = data.base.cars.filter(c => String(c.class) === cls && (!f || `#${c.numberText} ${c.driver} ${c.teamName}`.toLowerCase().includes(f)));
    const ed = crid => data.gameDrivers?.find(g => g.crid === crid);
    $("#gList").innerHTML = cars.map(c => { const g = ed(c.crid); return `<label style="display:flex;gap:8px;align-items:center;break-inside:avoid;padding:3px 0"><input type="checkbox" data-crid="${c.crid}" ${removed.has(c.crid) ? "" : "checked"}><span style="flex:1"><b>#${esc(g ? g.car.number : c.numberText)}</b> ${esc(g ? `${g.first} ${g.last}`.trim() : c.driver)} <small style="color:var(--dim)">${esc(c.scheme || c.teamName)}</small>${g ? ' <span class="tag" style="color:var(--accent)">edited</span>' : ""}</span><button class="btn" data-edit="${c.crid}" style="padding:1px 8px;font-size:12px">Edit</button></label>`; }).join("");
    $("#gList").querySelectorAll("[data-edit]").forEach(b => b.onclick = ev => { ev.preventDefault(); editGame(+b.dataset.edit); });
    $("#gList").querySelectorAll("input[data-crid]").forEach(i => i.onchange = () => { if (i.checked) removed.delete(+i.dataset.crid); else removed.add(+i.dataset.crid); count(); });
    count();
  }
  function count() { const all = data.base.cars.filter(c => [1, 2].includes(c.class)), cup = all.filter(c => !removed.has(c.crid)).length; $("#gCount").textContent = `${cup} of ${all.length} primary + secondary in the game, ${removed.size} taken out`; }
  const gs = (t, k) => { const x = $("#gState"); x.textContent = t; x.className = "pill " + k; };
  async function loadGame() {
    removed = new Set(data.removed ?? []);
    const g = $("#gClass"); if (!g.options.length) { g.innerHTML = Object.entries(data.base.classes).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join(""); g.value = "1"; g.onchange = drawGame; $("#gFind").oninput = drawGame;
      $("#gAll").onclick = () => { $("#gList").querySelectorAll("input[data-crid]").forEach(i => { i.checked = true; removed.delete(+i.dataset.crid); }); count(); };
      $("#gSave").onclick = async () => { try { const r = await fetch("/api/roster/removed", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ crids: [...removed] }) }); if (!r.ok) throw new Error((await r.json()).error); data.removed = (await r.json()).removed; gs(`Saved: ${data.removed.length} taken out. Restart the game to see it.`, "ok"); } catch (e) { gs(e.message, "err"); } }; }
    drawGame();
  }
  async function load(selectId) {
    data = await api("/api/roster");
    // the team list everything uses: the game's (with your names) and yours
    data.gameTeams = data.base.teams.map(t => ({ ...t, own: String(t.name).trim(), name: data.teamNames?.[t.id] ?? String(t.name).trim() }));
    data.base.teams = [...data.gameTeams, ...(data.teams ?? []).map(t => ({ id: t.id, name: t.name, mine: true, prestige: t.prestige }))].sort((a, b) => a.name.localeCompare(b.name));
    loadGame(); drawTeams();
    const list = $("#rList");
    list.innerHTML = data.drivers.map(d => `<div class="rcard" data-id="${d.id}">${d.files.portrait ? `<img src="/api/roster/image?kind=portrait&id=${d.id}&t=${Date.now()}">` : `<div class="ph"></div>`}<div><b>#${d.car.number} ${esc(d.first)} ${esc(d.last)}</b><small>${esc(teamName(d.car.team))}</small></div></div>`).join("")
      + `<div class="rcard radd" id="rAdd">+ Add a driver</div>`;
    list.querySelectorAll(".rcard[data-id]").forEach(c => c.onclick = () => edit(data.drivers.find(d => d.id === +c.dataset.id)));
    $("#rAdd").onclick = () => edit(null);
    if (selectId !== undefined) edit(data.drivers.find(d => d.id === selectId) ?? null);
    else if (cur) list.querySelector(`.rcard[data-id="${cur.id}"]`)?.classList.add("on");
  }
  const teamName = t => t && typeof t === "object" ? t.name : data.base.teams.find(x => x.id === t)?.name ?? "";
  const carLabel = c => `#${c.numberText ?? c.number} ${c.driver} — ${c.scheme || c.teamName} (${data.base.makes[c.make] ?? "?"})`;

  // one of the game's drivers in the same editor (game mode: his own car is the start car; no paint here, the paint
  // schemes have their own section; saved to roster.gameDrivers)
  function editGame(crid, keepScroll) {
    const c = data.base.cars.find(x => x.crid === crid); if (!c) return;
    const g = data.gameDrivers?.find(x => x.crid === crid);
    const d = g ? structuredClone(g) : { first: c.first, last: c.last, city: c.city ?? "", state: c.state ?? "", born: { year: c.born?.year ?? 1970, month: c.born?.month ?? 1, day: c.born?.day ?? 1 }, rookieYear: c.rookieYear ?? 2000,
      ratings: { ...c.ratings }, trackSkills: { ...c.trackSkills }, template: crid, car: { number: c.number, team: c.team, make: c.make, class: c.class }, paint: "copy",
      numberStyle: { font: "sans", fill: "#ffffff", outline: "#c00000", italic: true }, numberPic: "auto", pitSign: "copy", pitText: "", crew: "copy", pitBox: "colors", colors: { ...(c.colors ?? {}) }, files: {} };
    d.car.team = data.carTeams?.[crid] ?? c.team; d.colors = { primary: d.colors?.primary ?? c.colors?.primary, secondary: d.colors?.secondary ?? c.colors?.secondary };
    d.game = crid; d.saved = !!g; d.keepScroll = !!keepScroll; edit(d);
  }
  function edit(d) {
    pending = {}; cpDock(null);
    const game = d?.game !== undefined, fresh = !d, tpl0 = data.base.cars.find(c => c.crid === d?.template) ?? data.base.cars.find(c => c.class === 1) ?? data.base.cars[0];
    cur = d ? structuredClone(d) : { first: "", last: "", city: tpl0.city ?? "", state: tpl0.state ?? "", born: { year: 1985, month: 1, day: 1 }, rookieYear: 2003,
      ratings: { ...tpl0.ratings }, trackSkills: { ...tpl0.trackSkills }, template: tpl0.crid,
      car: { number: tpl0.number, team: tpl0.team, make: tpl0.make, class: 1 }, paint: "copy", numberStyle: { font: "sans", fill: "#ffffff", outline: "#c00000", italic: true },
      numberPic: "auto", pitSign: "copy", pitText: "", colors: { ...(tpl0.colors ?? {}) }, files: {} };
    cur.colors ??= { ...(tpl0.colors ?? {}) }; cur.numberPic ??= "auto"; cur.pitSign ??= "copy";
    root.querySelectorAll(".rcard").forEach(c => c.classList.toggle("on", !!d && !game && +c.dataset.id === d.id));
    const e = $("#rEdit"); e.style.display = "";
    // the editor opens where it was asked for: under "The game's drivers" for one of theirs (with a close button),
    // under "Drivers you added" otherwise; scrolled to, so the click visibly does something
    const anchor = game ? $("#gList").closest(".card") : $("#rList").closest(".card");
    if (anchor.nextElementSibling !== e) anchor.after(e);
    const newTeam = cur.car.team && typeof cur.car.team === "object";
    e.innerHTML = `<h2>${fresh ? "New driver" : `Edit ${esc(cur.first)} ${esc(cur.last)}`}${game ? ' <span class="tag">the game\'s driver</span>' : ""}</h2>
      ${game ? `<p class="hint" style="margin-top:0">Changes this driver and his car in place: he keeps his records, history and speech. His name, hometown, birth date, number, portrait and the car's pictures and colours show everywhere, saved seasons and careers included; ratings, track skills and the driver list apply to Race Now and to seasons and careers started after the change (a career keeps its own). The paint is under "Paint schemes of the game's cars".</p>` : ""}
      <div class="rgrid">
        <label>Start from <select id="fTpl">${data.base.cars.map(c => `<option value="${c.crid}">${esc(carLabel(c))}</option>`).join("")}</select></label>
        <label>First name <input id="fFirst" maxlength="13"></label>
        <label>Last name <input id="fLast" maxlength="13"></label>
        <label>Hometown <input id="fCity" maxlength="18"></label>
        <label>State <input id="fState" maxlength="2" style="text-transform:uppercase"></label>
        <label>Born <input type="date" id="fBorn"></label>
        <label>Rookie year <input type="number" id="fRook" min="1950" max="2100"></label>
      </div>
      <div class="rsec"><h3>Car</h3><div class="rgrid">
        <label>Number <input type="number" id="fNum" min="0" max="999"></label>
        <label>Team <select id="fTeam"><option value="new">New team…</option>${data.base.teams.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select></label>
        <label id="fTeamNameL">New team name <input id="fTeamName" maxlength="28"></label>
        <label>Make <select id="fMake">${Object.entries(data.base.makes).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></label>
        <label>Driver list <select id="fClass"><option value="1">Primary drivers</option><option value="2">Secondary drivers</option><option value="3">Busch drivers</option><option value="4">Fill-in drivers (own car)</option></select></label>
      </div><p class="hint" id="fMakeHint"></p><p class="hint" id="fBuschHint" style="display:none">Busch driver: in races he fills in when a field is short (after the primary and secondary drivers), like the game's own Busch drivers. In a career he is one of the drivers who move up when a Cup seat opens (unless you untick him in the Career tab's "Busch drivers who stay in Busch"), and when he moves up or retires his Busch seat goes to a rookie.</p><p class="hint" id="fPoolHint" style="display:none">Fill-in driver: he races only when a field is short, and in a career the silly season can give him a ride like the game's own fill-in drivers. For a rookie without a car of his own, use the Rookies tab instead.</p></div>
      <div class="rsec"><h3>Ratings</h3><div class="rgrid" style="grid-template-columns:repeat(auto-fill,minmax(320px,1fr))"><div id="fRat"></div><div id="fTrk"></div></div></div>
      <div class="rsec"><h3>Pictures</h3><div class="rpics">
        ${pic("portrait", "Portrait", "Menus and driver select. Square works best; a transparent background looks like the game's.")}
        ${pic("closeup", "Close-up (optional)", "The small head shot in race screens. Without one the portrait's top half is used.")}
        <div class="rpic" id="pNumber"><h3>Car number</h3>
          <div class="row" style="margin-top:6px"><label><input type="radio" name="fNumPic" value="auto"> The game's / made here</label><label><input type="radio" name="fNumPic" value="custom"> My own picture</label></div>
          <p class="hint" id="nHint"></p><div class="img"><canvas id="nCanvas" width="512" height="256"></canvas></div>
          <div class="row" id="nOwn"><button class="btn" id="numberPick">Choose picture…</button></div><input type="file" id="numberFile" accept="image/*" hidden>
          <div id="nGen" class="row"><select id="nFont"><option value="sans">Italic</option><option value="block">Block</option><option value="serif">Serif</option><option value="script">Script</option></select>
          <label>Fill <input type="color" id="nFill"></label><label>Outline <input type="color" id="nOut"></label></div></div>
        <div class="rpic" id="pPaint"><h3>Paint scheme</h3>
          <div class="row" style="margin-top:6px"><label><input type="radio" name="fPaint" value="copy"> Copy the start car's</label><label><input type="radio" name="fPaint" value="custom"> My own</label></div>
          <div class="img"><img id="paintImg" alt=""></div>
          <div class="row" id="paintCtl"><button class="btn" id="paintTpl">Download template</button><button class="btn" id="paintPick">Choose PNG…</button><button class="btn danger" id="paintDel">Remove</button></div>
          <div class="row"><label style="flex:1">Template layout <select id="paintLayout"><option value="game">This game's</option><option value="ea1252">1252 modder (rearranged)</option></select></label></div>
          <p class="hint" style="margin-top:2px">Your picture is kept as you chose it: changing the layout (or the make) rearranges it again when you save.</p>
          <div class="row"><label style="flex:1">Scheme name <input id="schemeName" maxlength="38" placeholder="shown in the paint scheme menu"></label></div>
          <p class="hint" id="paintHint"></p><input type="file" id="paintFile" accept="image/*" hidden>
          <h3 style="margin-top:12px">More paint schemes</h3>
          <p class="hint" style="margin-top:0">Extra schemes to pick from in the game's paint scheme menu, painted on the same make's template (or the 1252 one).</p>
          <div id="schemes"></div><div class="row"><button class="btn" id="schemeAdd">Add a paint scheme</button></div><input type="file" id="schemeFile" accept="image/*" hidden></div>
        <div class="rpic" id="pSign"><h3>Pit sign and pit box</h3>
          <div class="row" style="margin-top:6px"><label><input type="radio" name="fSign" value="copy"> Start car's sign</label><label><input type="radio" name="fSign" value="made"> Made here</label><label><input type="radio" name="fSign" value="custom"> My own</label></div>
          <div class="img" style="height:90px"><canvas id="sCanvas" width="512" height="128"></canvas></div>
          <div class="row" id="sMade"><label style="flex:1">Sign text <input id="sText" maxlength="24" placeholder="sponsor or team"></label></div>
          <div class="row" id="sOwn"><button class="btn" id="pitSignPick">Choose picture…</button></div><input type="file" id="pitSignFile" accept="image/*" hidden>
          <div class="row" style="margin-top:6px"><label>Primary <input type="color" id="cPri"></label><label>Secondary <input type="color" id="cSec"></label></div>
          <p class="hint" id="sHint">The sign hangs over the car's pit stall (sponsor on the left, number on the right, 4 : 1). The colours paint the pit box (the tool cart).</p>
          <h3 style="margin-top:12px">Pit crew uniforms</h3>
          <div class="row" style="margin-top:6px"><label><input type="radio" name="fCrew" value="copy"> Start car's crew</label><label><input type="radio" name="fCrew" value="made"> Plain, my colours</label><label><input type="radio" name="fCrew" value="custom"> My own</label></div>
          <div class="img" id="crewBox"><img id="crewImg" alt=""></div>
          <div class="row" id="crewOwn"><button class="btn" id="crewTpl">Download template</button><button class="btn" id="crewPick">Choose PNG…</button></div><input type="file" id="crewFile" accept="image/*" hidden>
          <p class="hint" id="crewHint"></p>
          <h3 style="margin-top:12px">Pit box crew and tool cart</h3>
          <div class="row" style="margin-top:6px"><label><input type="radio" name="fPitBox" value="colors"> Tinted with my colours</label><label><input type="radio" name="fPitBox" value="custom"> My own picture</label></div>
          <div class="img" id="pbBox"><img id="pbImg" alt="" style="image-rendering:auto"></div>
          <div class="row" id="pbOwn"><button class="btn" id="pbTpl">Download template</button><button class="btn" id="pbPick">Choose PNG…</button></div><input type="file" id="pbFile" accept="image/*" hidden>
          <p class="hint" id="pbHint"></p></div>
      </div></div>
      <div class="row" style="margin-top:18px"><button class="btn primary" id="fSave">${fresh ? "Add driver" : "Save changes"}</button><button class="btn" id="fClose">Close</button>${fresh || (game && !cur.saved) ? "" : `<button class="btn danger" id="fDel">${game ? "Back to the game's" : "Remove driver"}</button>`}<span class="pill" id="fState2"></span></div>`;
    if (game) { $("#fTpl", e).closest("label").style.display = "none"; $("#pPaint", e).remove();
      $(".rpics", e).closest(".rsec").insertAdjacentHTML("afterend", `<div class="rsec" id="gpSec"><h3>Paint schemes</h3><p class="hint" style="margin-top:0">Replace any of his car's schemes with your own picture (Download template, paint over it, Choose PNG…), untick "In the game" to take one out of the paint scheme menu, or add new ones. These save as soon as you choose them (no need for Save changes); restart the game to see them.</p></div>`);
      cpDock(cur.game); }
    // fill
    const v = (id, val) => { const x = $(id, e); if (x) x.value = val ?? ""; };   // (game mode: no paint fields)
    v("#fTpl", cur.template); v("#fFirst", cur.first); v("#fLast", cur.last); v("#fCity", cur.city); v("#fState", cur.state);
    v("#fBorn", `${cur.born.year}-${String(cur.born.month).padStart(2, "0")}-${String(cur.born.day).padStart(2, "0")}`); v("#fRook", cur.rookieYear);
    v("#fNum", cur.car.number); v("#fTeam", newTeam ? "new" : cur.car.team); v("#fTeamName", newTeam ? cur.car.team.name : ""); v("#fMake", cur.car.make); v("#fClass", cur.car.class);
    { const ph = () => { $("#fPoolHint").style.display = $("#fClass").value === "4" ? "" : "none"; $("#fBuschHint").style.display = $("#fClass").value === "3" ? "" : "none"; }; $("#fClass").addEventListener("change", ph); ph(); }
    $("#fRat", e).innerHTML = RATINGS.map(([k, l]) => slider("r_" + k, l, cur.ratings[k])).join("");
    $("#fTrk", e).innerHTML = TRACKS.map(([k, l]) => slider("t_" + k, l, cur.trackSkills[k])).join("");
    e.querySelectorAll(".rsl input").forEach(i => i.oninput = () => i.nextElementSibling.value = i.value);
    e.querySelectorAll(`input[name=fPaint]`).forEach(r => r.checked = r.value === cur.paint);
    v("#schemeName", cur.schemeName ?? ""); v("#paintLayout", cur.paintLayout ?? "game");
    schemes = (cur.schemes ?? []).map((x, i) => ({ name: x.name, layout: x.layout ?? "game", from: i + 1, has: !!cur.files?.schemes?.[i], blob: null }));
    v("#nFont", cur.numberStyle.font); v("#nFill", cur.numberStyle.fill); v("#nOut", cur.numberStyle.outline);
    e.querySelectorAll(`input[name=fNumPic]`).forEach(r => r.checked = r.value === cur.numberPic);
    e.querySelectorAll(`input[name=fSign]`).forEach(r => r.checked = r.value === cur.pitSign);
    e.querySelectorAll(`input[name=fCrew]`).forEach(r => r.checked = r.value === (cur.crew ?? "copy"));
    e.querySelectorAll(`input[name=fPitBox]`).forEach(r => r.checked = r.value === (cur.pitBox ?? "colors"));
    v("#sText", cur.pitText); v("#cPri", cur.colors?.primary ?? "#c00000"); v("#cSec", cur.colors?.secondary ?? "#ffffff");
    // behaviour
    $("#fTpl", e).onchange = () => { const c = data.base.cars.find(x => x.crid === +$("#fTpl", e).value); if (!c) return;
      if (fresh || confirm("Take the ratings, team, make and number of this car too?")) {
        for (const [k] of RATINGS) { const i = $("#r_" + k, e); i.value = c.ratings[k]; i.nextElementSibling.value = c.ratings[k]; }
        for (const [k] of TRACKS) { const i = $("#t_" + k, e); i.value = c.trackSkills[k] ?? 80; i.nextElementSibling.value = i.value; }
        v("#fNum", c.number); v("#fTeam", c.team); v("#fMake", c.make); if (fresh) { v("#fCity", c.city); v("#fState", c.state); }
        if (c.colors) { v("#cPri", c.colors.primary); v("#cSec", c.colors.secondary); }
      }
      sync(); };
    ["#fTeam", "#fTeamName", "#fLast", "#fMake", "#fNum", "#nFont", "#nFill", "#nOut", "#sText", "#cPri", "#cSec"].forEach(id => $(id, e).addEventListener("input", sync));
    e.querySelectorAll(`input[name=fPaint],input[name=fNumPic],input[name=fSign],input[name=fCrew],input[name=fPitBox]`).forEach(r => r.onchange = sync);
    $("#pbTpl", e).onclick = () => { const a = document.createElement("a"); a.href = `/api/roster/base?kind=pitBox&n=0`; a.download = "pitbox-template.png"; a.click(); };
    $("#pbPick", e).onclick = () => $("#pbFile", e).click();
    // (kept at its own size, 2 : 1, from 256 x 128 up to 1536 x 768; the game's is 256 x 128)
    $("#pbFile", e).onchange = async ev => { const f = ev.target.files[0]; if (!f) return; ev.target.value = "";
      const w = await new Promise(ok => { const im = new Image(); im.onload = () => { ok(Math.max(256, Math.min(1536, Math.round(im.width / 2) * 2))); URL.revokeObjectURL(im.src); }; im.onerror = () => ok(768); im.src = URL.createObjectURL(f); });
      const r = await toPng(f, [w, w / 2], true); pending.pitBox = r.blob;
      if (Math.abs(r.srcW / r.srcH - 2) > 0.05) status(`The picture was ${r.srcW} × ${r.srcH}; it has been stretched to 2 : 1 (${w} × ${w / 2}).`, "warn");
      sync(); };
    $("#crewTpl", e).onclick = () => { const a = document.createElement("a"); a.href = `/api/roster/base?kind=crew&n=${$("#fTpl", e).value}`; a.download = `crew-template-car-${$("#fTpl", e).value}.png`; a.click(); };
    $("#crewPick", e).onclick = () => $("#crewFile", e).click();
    $("#crewFile", e).onchange = async ev => { const f = ev.target.files[0]; if (!f) return; ev.target.value = ""; const r = await toPng(f, [1024, 1024], true); pending.crew = r.blob; sync(); };
    for (const k of ["number", "pitSign"]) { $(`#${k}Pick`, e).onclick = () => $(`#${k}File`, e).click();
      $(`#${k}File`, e).onchange = async ev => { const f = ev.target.files[0]; if (!f) return; const r = await toPng(f, SIZES[k], false); pending[k] = r.blob; ev.target.value = ""; sync(); }; }
    for (const k of ["portrait", "closeup"]) {
      $(`#${k}Pick`, e).onclick = () => $(`#${k}File`, e).click();
      $(`#${k}File`, e).onchange = async ev => { const f = ev.target.files[0]; if (!f) return; await setPic(k, f); ev.target.value = ""; };
      $(`#${k}Del`, e).onclick = () => { pending[k] = "delete"; $(`#${k}Img`, e).removeAttribute("src"); };
      $(`#${k}Img`, e).src = cur.files?.[k] ? `/api/roster/image?kind=${k}&${game ? `game=${cur.game}` : `id=${cur.id}`}&t=${Date.now()}` : game ? `/api/roster/base?kind=${k}&n=${tpl0.poid}` : "";
    }
    if (!game) {
    $("#paintPick", e).onclick = () => $("#paintFile", e).click();
    $("#paintFile", e).onchange = async ev => { const f = ev.target.files[0]; if (!f) return; await setPic("paint", f); ev.target.value = ""; };
    $("#schemeAdd", e).onclick = () => { if (schemes.length >= 8) return status("8 more schemes at most", "run"); schemes.push({ name: `Scheme ${schemes.length + 2}`, from: null, has: false, blob: null }); drawSchemes(); };
    $("#schemeFile", e).onchange = async ev => { const f = ev.target.files[0], k = schemePick; if (!f || k === null) return; ev.target.value = "";
      const dims = await new Promise(ok => { const im = new Image(); im.onload = () => { const m = Math.min(2048, Math.max(512, im.width, im.height)); ok([m, m, im.width, im.height]); }; im.onerror = () => ok([512, 512, 512, 512]); im.src = URL.createObjectURL(f); });
      const r = await toPng(f, dims.slice(0, 2), true); schemes[k].blob = r.blob; schemes[k].layout = guessLayout(dims[2], dims[3]) ?? $("#paintLayout", e).value; drawSchemes(); };
    drawSchemes();
    $("#paintDel", e).onclick = () => { pending.paint = "delete"; $("#paintImg", e).removeAttribute("src"); };
    $("#paintTpl", e).onclick = () => { const a = document.createElement("a"); a.href = `/api/roster/base?kind=paint&n=${$("#fTpl", e).value}`; a.download = `paint-template-car-${$("#fTpl", e).value}.png`; a.click(); };
    }
    $("#fSave", e).onclick = () => saveDriver().catch(err => status(err.message, "bad"));
    if (game) { const b = $("#fDel", e); if (b) b.onclick = async () => { if (!confirm(`Put ${tpl0.driver} back as the game has him (his pictures and changes go)?`)) return; await post("/api/roster/gamedriver/reset", { crid: cur.game }); cpDock(null); cur = null; $("#rEdit").style.display = "none"; await load(); }; }
    else if (!fresh) $("#fDel", e).onclick = async () => { if (!confirm(`Remove ${cur.first} ${cur.last} from the roster?`)) return; await post("/api/roster/delete", { id: cur.id }); cur = null; $("#rEdit").style.display = "none"; load(); };
    $("#fClose", e).onclick = () => { cpDock(null); const back = cur?.game !== undefined ? $(`[data-edit="${cur.game}"]`) : null; cur = null; pending = {}; e.style.display = "none";
      root.querySelectorAll(".rcard.on").forEach(c => c.classList.remove("on")); (back ?? $("#rList")).scrollIntoView({ behavior: "smooth", block: "center" }); };
    sync();
    if (!d?.keepScroll) requestAnimationFrame(() => e.scrollIntoView({ behavior: "smooth", block: "start" }));
  }
  const slider = (id, label, val) => `<div class="rsl"><span>${label}</span><input type="range" id="${id}" min="0" max="100" value="${val ?? 80}"><output>${val ?? 80}</output></div>`;
  const pic = (k, title, hint) => `<div class="rpic"><h3>${title}</h3><p class="hint">${hint}</p><div class="img"><img id="${k}Img" alt=""></div>
    <div class="row"><button class="btn" id="${k}Pick">Choose picture…</button><button class="btn danger" id="${k}Del">Remove</button></div><input type="file" id="${k}File" accept="image/*" hidden></div>`;

  function sync() {
    const e = $("#rEdit"), tpl = data.base.cars.find(c => c.crid === +$("#fTpl", e).value), paint = e.querySelector("input[name=fPaint]:checked")?.value ?? "copy";
    $("#fTeamNameL", e).style.display = $("#fTeam", e).value === "new" ? "" : "none";
    const make = $("#fMake", e); make.disabled = paint === "copy"; if (paint === "copy") make.value = tpl.make;
    const game = cur.game !== undefined, iq = game ? `game=${cur.game}` : `id=${cur.id}`;
    $("#fMakeHint", e).textContent = paint === "copy" ? `The make follows the copied paint (${data.base.makes[tpl.make]}): a paint only fits its own body. Choose "My own" paint to pick another make.` : "Your paint must use the template layout of this make (download it from the start car of the same make).";
    if (game) $("#fMakeHint", e).textContent = "The make stays the car's: its paint schemes fit only its own body.";
    // paint panel
    const img = $("#paintImg", e), ctl = $("#paintCtl", e);
    if (img) { ctl.style.display = paint === "custom" ? "" : "none";
    if (paint === "copy") { img.src = `/api/roster/base?kind=paint&n=${tpl.crid}`; $("#paintHint", e).textContent = +$("#fNum", e).value !== tpl.number ? `The start car's paint shows its own number (${tpl.numberText ?? tpl.number}) on the car; menus will show #${$("#fNum", e).value}. Use your own paint to put the new number on the car.` : "The start car's paint, number included."; }
    else { if (pending.paint instanceof Blob) img.src = URL.createObjectURL(pending.paint); else if (pending.paint !== "delete" && cur.files?.paint) img.src = `/api/roster/image?kind=paint&id=${cur.id}&t=${Date.now()}`; else img.removeAttribute("src");
      $("#paintHint", e).textContent = "Download the template, paint over it in any image editor (keep it square and the parts where they are: any size up to 2048, e.g. a 1252 or 2048 modder template; over 724 px the game gets a high-resolution 1024 or 2048 texture), then choose the PNG. If your picture has no transparency, the template\'s is used."; } }
    // number picture
    const num = +$("#fNum", e).value, same = num === tpl.number, exists = same || data.base.numbers.includes(num);
    const cv = $("#nCanvas", e), gen = $("#nGen", e), own = e.querySelector("input[name=fNumPic]:checked")?.value === "custom";
    gen.style.display = exists || own ? "none" : ""; $("#nOwn", e).style.display = own ? "" : "none";
    if (own) {
      const x = cv.getContext("2d"); x.clearRect(0, 0, 512, 256);
      const src = pending.number instanceof Blob ? URL.createObjectURL(pending.number) : cur.files?.number && cur.numberPic === "custom" ? `/api/roster/image?kind=number&${iq}&t=${Date.now()}` : null;
      if (src) { const im = new Image(); im.onload = () => { x.clearRect(0, 0, 512, 256); x.drawImage(im, 0, 0, 512, 256); }; im.src = src; }
      $("#nHint", e).textContent = "Your picture for the number in menus and the race (the badges under the cars): 2 : 1, a transparent background looks like the game's.";
    } else if (exists) {
      const src = data.base.cars.find(c => c.number === num && c.cnid !== undefined) ?? tpl;
      const im = new Image(); im.onload = () => { const x = cv.getContext("2d"); x.clearRect(0, 0, 512, 256); x.drawImage(im, 0, 0, 512, 256); }; im.src = `/api/roster/base?kind=number&n=${(same ? tpl : src).cnid}`;
      $("#nHint", e).textContent = same ? (game ? "His car's number picture." : "The start car's number picture.") : `The game's picture for #${num}.`;
    } else { drawNumber(cv, num); $("#nHint", e).textContent = `The game has no picture for #${num}: this one is made for it. Pick a style and colours.`; }
    // pit crew
    const crew = e.querySelector("input[name=fCrew]:checked")?.value ?? "copy", ci = $("#crewImg", e);
    $("#crewOwn", e).style.display = crew === "custom" ? "" : "none"; $("#crewBox", e).style.display = crew === "made" ? "none" : "";
    if (crew === "copy") ci.src = `/api/roster/base?kind=crew&n=${tpl.crid}`;
    else if (crew === "custom") { if (pending.crew instanceof Blob) ci.src = URL.createObjectURL(pending.crew); else if (cur.files?.crew) ci.src = `/api/roster/image?kind=crew&${iq}&t=${Date.now()}`; else ci.removeAttribute("src"); }
    $("#crewHint", e).textContent = crew === "made" ? "Plain fire suits in the primary colour with the helmets in the secondary (no logos)." : crew === "custom" ? "Download the template (the start car's crew: sleeves and gloves, pants and shoes, the suit's front and back, the helmet; the face is not changed), paint over it and choose the PNG." : "The start car's crew uniforms.";
    // pit box crew and cart
    const pb = e.querySelector("input[name=fPitBox]:checked")?.value ?? "colors", pi = $("#pbImg", e);
    $("#pbOwn", e).style.display = pb === "custom" ? "" : "none"; $("#pbBox", e).style.display = pb === "custom" ? "" : "none";
    if (pb === "custom") { if (pending.pitBox instanceof Blob) pi.src = URL.createObjectURL(pending.pitBox); else if (cur.files?.pitBox) pi.src = `/api/roster/image?kind=pitBox&${iq}&t=${Date.now()}`; else pi.removeAttribute("src"); }
    $("#pbHint", e).textContent = pb === "custom" ? "One 2 : 1 sheet for the crew standing at the car's pit stall and its tool cart: faces, suits, ears, gloves and shoes on the left, the cart, tyre and tools on the right (the template is the game's sheet at 3x, 768 × 384). Any 2 : 1 size up to 1536 × 768." : "The game's crew and tool cart in the primary and secondary colours above.";
    // pit sign
    const sign = e.querySelector("input[name=fSign]:checked")?.value ?? "copy", sc = $("#sCanvas", e), sx = sc.getContext("2d");
    $("#sMade", e).style.display = sign === "made" ? "" : "none"; $("#sOwn", e).style.display = sign === "custom" ? "" : "none";
    if (sign === "made") drawSign(sc, num);
    else { const src = sign === "copy" ? `/api/roster/base?kind=pitSign&n=${tpl.crid}` : pending.pitSign instanceof Blob ? URL.createObjectURL(pending.pitSign) : cur.files?.pitSign && cur.pitSign === "custom" ? `/api/roster/image?kind=pitSign&${iq}&t=${Date.now()}` : null;
      sx.clearRect(0, 0, 512, 128); if (src) { const im = new Image(); im.onload = () => { sx.clearRect(0, 0, 512, 128); sx.drawImage(im, 0, 0, 512, 128); }; im.src = src; } }
  }
  function drawSign(cv, num) {                          // sponsor text on the primary colour, the number on the secondary
    const e = $("#rEdit"), x = cv.getContext("2d"), pri = $("#cPri", e).value, sec = $("#cSec", e).value;
    const team = $("#fTeam", e).value === "new" ? $("#fTeamName", e).value : data.base.teams.find(t => t.id === +$("#fTeam", e).value)?.name;
    const text = ($("#sText", e).value || team || $("#fLast", e).value || "").toUpperCase();
    x.clearRect(0, 0, 512, 128); x.fillStyle = pri; x.fillRect(0, 0, 512, 128); x.fillStyle = sec; x.fillRect(384, 0, 128, 128);
    x.save(); x.textAlign = "center"; x.textBaseline = "middle"; x.font = "900 italic 84px Impact, 'Arial Black', sans-serif";
    const w = x.measureText(text).width; x.translate(192, 68); x.scale(Math.min(1, 350 / Math.max(1, w)), 1);
    x.lineJoin = "round"; x.lineWidth = 8; x.strokeStyle = "#000"; x.strokeText(text, 0, 0); x.fillStyle = sec; x.fillText(text, 0, 0); x.restore();
    const n = document.createElement("canvas"); n.width = 512; n.height = 256; drawNumber(n, num); x.drawImage(n, 0, 0, 512, 256, 384, 32, 128, 64);
  }
  function drawNumber(cv, num) {
    const e = $("#rEdit"), x = cv.getContext("2d"), font = $("#nFont", e).value, fill = $("#nFill", e).value, out = $("#nOut", e).value;
    x.clearRect(0, 0, cv.width, cv.height); x.save(); x.textAlign = "center"; x.textBaseline = "middle";
    x.font = FONTS[font]; const text = String(num); let w = x.measureText(text).width; const sc = Math.min(1, 470 / w);
    x.translate(256, 132); x.scale(sc, 1); if (font !== "block") x.transform(1, 0, -0.12, 1, 0, 0);
    x.lineJoin = "round"; x.lineWidth = 26; x.strokeStyle = "#000"; x.strokeText(text, 0, 0);
    x.lineWidth = 14; x.strokeStyle = out; x.strokeText(text, 0, 0); x.fillStyle = fill; x.fillText(text, 0, 0); x.restore();
  }

  // any picture -> PNG blob at the game's size (fit inside, transparent margins; paints are stretched to the square)
  let schemes = [], schemePick = null;
  const guessLayout = (w, h) => w === h && w >= 1200 && w <= 1300 ? "ea1252" : null;   // (paint-layout.mjs)
  function drawSchemes() {
    const e = $("#rEdit"), box = $("#schemes", e); if (!box) return;
    box.innerHTML = schemes.map((x, k) => `<div class="row" style="align-items:center;gap:8px;margin:6px 0"><img data-k="${k}" style="width:64px;height:64px;background:#111;border-radius:6px" alt="">
      <input data-name="${k}" maxlength="38" value="${esc(x.name ?? "")}" style="flex:1"><select data-lay="${k}" title="Template layout"><option value="game">This game's</option><option value="ea1252">1252 modder</option></select>
      <button class="btn" data-pick="${k}">Choose PNG…</button><button class="btn danger" data-del="${k}">Remove</button></div>`).join("");
    box.querySelectorAll("select[data-lay]").forEach(sel => { sel.value = schemes[+sel.dataset.lay].layout ?? "game"; sel.onchange = () => schemes[+sel.dataset.lay].layout = sel.value; });
    box.querySelectorAll("img[data-k]").forEach(im => { const x = schemes[+im.dataset.k]; if (x.blob) im.src = URL.createObjectURL(x.blob); else if (x.has && x.from) im.src = `/api/roster/image?kind=paint&scheme=${x.from}&id=${cur.id}&t=${Date.now()}`; });
    box.querySelectorAll("input[data-name]").forEach(i => i.oninput = () => schemes[+i.dataset.name].name = i.value);
    box.querySelectorAll("[data-pick]").forEach(b => b.onclick = () => { schemePick = +b.dataset.pick; $("#schemeFile", e).click(); });
    box.querySelectorAll("[data-del]").forEach(b => b.onclick = () => { schemes.splice(+b.dataset.del, 1); drawSchemes(); });
  }
  function toPng(file, [w, h], stretch) {
    return new Promise((ok, bad) => { const im = new Image(); im.onload = () => {
      const cv = document.createElement("canvas"); cv.width = w; cv.height = h; const x = cv.getContext("2d"); x.imageSmoothingQuality = "high";
      if (stretch) x.drawImage(im, 0, 0, w, h); else { const s = Math.min(w / im.width, h / im.height), dw = im.width * s, dh = im.height * s; x.drawImage(im, (w - dw) / 2, (h - dh) / 2, dw, dh); }
      cv.toBlob(b => b ? ok({ blob: b, srcW: im.width, srcH: im.height }) : bad(new Error("could not convert the picture")), "image/png"); URL.revokeObjectURL(im.src); };
      im.onerror = () => bad(new Error("that file is not a picture the browser can read")); im.src = URL.createObjectURL(file); });
  }
  async function setPic(kind, file) {
    // (a paint keeps its own size, square, up to 2048: the game gets 512, 1024 or 2048, whichever is nearest)
    const dims = kind === "paint" ? await new Promise(ok => { const im = new Image(); im.onload = () => { const m = Math.min(2048, Math.max(512, im.width, im.height)); ok([m, m]); URL.revokeObjectURL(im.src); }; im.onerror = () => ok(SIZES.paint); im.src = URL.createObjectURL(file); }) : SIZES[kind];
    const e = $("#rEdit"), r = await toPng(file, dims, kind === "paint"), game = Math.max(r.srcW, r.srcH) > 1448 ? 2048 : Math.max(r.srcW, r.srcH) > 724 ? 1024 : 512;
    if (kind === "paint") { const g = guessLayout(r.srcW, r.srcH); if (g) $("#paintLayout", e).value = g;
      status(`${r.srcW !== r.srcH ? `The paint was ${r.srcW} × ${r.srcH}; it has been stretched square. ` : ""}In the game it is ${game} × ${game}${game > 512 ? " (high resolution)" : ""}.${g ? " It looks like a 1252 modder template: it will be rearranged onto this game's layout when you save (check the preview after)." : ""}`, "run"); }
    pending[kind] = r.blob; const img = kind === "paint" ? $("#paintImg", e) : $(`#${kind}Img`, e); img.src = URL.createObjectURL(r.blob);
  }
  function closeupFrom(blob) {                          // no close-up given: the top middle of the portrait
    return new Promise(ok => { const im = new Image(); im.onload = () => { const cv = document.createElement("canvas"); cv.width = cv.height = 256; cv.getContext("2d").drawImage(im, im.width * 0.2, 0, im.width * 0.6, im.width * 0.6, 0, 0, 256, 256); cv.toBlob(ok, "image/png"); }; im.src = URL.createObjectURL(blob); });
  }
  const status = (t, k = "") => { const s = $("#fState2"); if (s) { s.textContent = t; s.className = "pill " + k; } };

  async function saveDriver() {
    const e = $("#rEdit"), g = id => $(id, e)?.value ?? "", [by, bm, bd] = (g("#fBorn") || "1985-01-01").split("-").map(Number);
    const paint = e.querySelector("input[name=fPaint]:checked")?.value ?? "copy";
    if (!g("#fLast").trim()) throw new Error("the driver needs a last name");
    if (paint === "custom" && !(pending.paint instanceof Blob) && !(cur.files?.paint && pending.paint !== "delete")) throw new Error("choose your paint picture, or copy the start car's");
    if (schemes.some(x => !x.blob && !x.has)) throw new Error("each extra paint scheme needs its picture (or remove it)");
    const out = { id: cur.id, template: +g("#fTpl"), first: g("#fFirst"), last: g("#fLast"), city: g("#fCity"), state: g("#fState"), born: { year: by, month: bm, day: bd }, rookieYear: +g("#fRook"),
      ratings: Object.fromEntries(RATINGS.map(([k]) => [k, +g("#r_" + k)])), trackSkills: Object.fromEntries(TRACKS.map(([k]) => [k, +g("#t_" + k)])),
      car: { number: +g("#fNum"), team: g("#fTeam") === "new" ? { name: g("#fTeamName") || `${g("#fLast")} Racing`, id: cur.car?.team?.id } : +g("#fTeam"), make: +g("#fMake"), class: +g("#fClass") },
      paint, numberStyle: { font: g("#nFont"), fill: g("#nFill"), outline: g("#nOut"), italic: true },
      schemeName: g("#schemeName"), paintLayout: g("#paintLayout"), schemes: schemes.map(x => ({ name: x.name, layout: x.layout ?? "game", from: x.blob ? null : x.from })),
      numberPic: e.querySelector("input[name=fNumPic]:checked")?.value ?? "auto", pitSign: e.querySelector("input[name=fSign]:checked")?.value ?? "copy", pitText: g("#sText"),
      colors: { primary: g("#cPri"), secondary: g("#cSec") }, crew: e.querySelector("input[name=fCrew]:checked")?.value ?? "copy", pitBox: e.querySelector("input[name=fPitBox]:checked")?.value ?? "colors" };
    if (out.numberPic === "custom" && !(pending.number instanceof Blob) && !(cur.files?.number && cur.numberPic === "custom")) throw new Error("choose your number picture, or use the game's");
    if (out.pitBox === "custom" && !(pending.pitBox instanceof Blob) && !(cur.files?.pitBox && cur.pitBox === "custom")) throw new Error("choose your pit box crew and cart picture, or use your colours");
    if (out.crew === "custom" && !(pending.crew instanceof Blob) && !(cur.files?.crew && cur.crew === "custom")) throw new Error("choose your crew uniform picture, or use another crew option");
    if (out.pitSign === "custom" && !(pending.pitSign instanceof Blob) && !(cur.files?.pitSign && cur.pitSign === "custom")) throw new Error("choose your pit sign picture, or make one here");
    status("saving…", "run");
    const game = cur.game !== undefined;
    if (game) { out.crid = cur.game; out.ownPortrait = pending.portrait instanceof Blob || (!!cur.files?.portrait && pending.portrait !== "delete"); }
    const saved = await post(game ? "/api/roster/gamedriver" : "/api/roster/driver", out), iq = game ? `game=${saved.crid}` : `id=${saved.id}`;
    const put = (kind, blob, extra = "") => fetch(`/api/roster/image?kind=${kind}&${iq}${extra}`, { method: "PUT", headers: { "content-type": "image/png" }, body: blob }).then(async r => { if (!r.ok) throw new Error((await r.json()).error); });
    const del = kind => fetch(`/api/roster/image?kind=${kind}&${iq}`, { method: "DELETE" });
    // (paints: the server keeps the picture as given and makes the game's paint from it by the saved template layout)
    for (const k of game ? ["portrait", "closeup"] : ["portrait", "closeup", "paint"]) { if (pending[k] instanceof Blob) await put(k, pending[k]); else if (pending[k] === "delete") await del(k); }
    for (const [k, x] of schemes.entries()) if (x.blob) await put("paint", x.blob, `&scheme=${k + 1}`);
    if (pending.portrait instanceof Blob && !(pending.closeup instanceof Blob) && !cur.files?.closeup) await put("closeup", await closeupFrom(pending.portrait));
    if (!game && paint === "copy" && saved.files.paint) await del("paint");
    // the number picture: made here when the game has none for this number
    const tpl = data.base.cars.find(c => c.crid === saved.template), num = saved.car.number;
    const small = blob => new Promise(ok => { const im = new Image(); im.onload = () => { const c = document.createElement("canvas"); c.width = 64; c.height = 32; const x = c.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(im, 0, 0, 64, 32); c.toBlob(ok, "image/png"); }; im.src = URL.createObjectURL(blob); });
    if (saved.numberPic === "custom") { if (pending.number instanceof Blob) { await put("number", pending.number); await put("numberSmall", await small(pending.number)); } }
    else if (num !== tpl.number && !data.base.numbers.includes(num)) {
      const cv = $("#nCanvas", e), sm = document.createElement("canvas"); sm.width = 64; sm.height = 32; const x = sm.getContext("2d"); x.imageSmoothingQuality = "high"; x.drawImage(cv, 0, 0, 64, 32);
      await put("number", await new Promise(ok => cv.toBlob(ok, "image/png"))); await put("numberSmall", await new Promise(ok => sm.toBlob(ok, "image/png")));
    } else { if (saved.files.number) await del("number"); if (saved.files.numberSmall) await del("numberSmall"); }
    // the pit sign
    if (saved.pitSign === "made") await put("pitSign", await new Promise(ok => $("#sCanvas", e).toBlob(ok, "image/png")));
    else if (saved.pitSign === "custom") { if (pending.pitSign instanceof Blob) await put("pitSign", pending.pitSign); }
    else if (saved.files.pitSign) await del("pitSign");
    if (saved.crew === "custom") { if (pending.crew instanceof Blob) await put("crew", pending.crew); } else if (saved.files.crew) await del("crew");
    if (saved.pitBox === "custom") { if (pending.pitBox instanceof Blob) await put("pitBox", pending.pitBox); } else if (saved.files.pitBox) await del("pitBox");
    pending = {};
    if (game) { await load(); editGame(saved.crid, true); status("saved: restart the game to see it", "ok"); return; }
    status("saved", "ok"); await load(saved.id);
  }

  // ---------------------------------------------------------------- the game's cars' paint schemes (roster.carPaints)
  let cpMine = new Set(), cpPick = null, cpInfo = null;
  const cps = (t, k = "") => { const x = $("#cpState"); x.textContent = t; x.className = "pill " + k; };
  // Editing one of the game's drivers shows his car's paint schemes inside the editor: the scheme tiles (and their
  // status) move into its "Paint schemes" section and back to this card when the editor closes or edits someone else
  let cpDocked = null;
  function cpDock(crid) {
    const list = $("#cpList"), st = $("#cpState"), sec = crid !== null ? $("#gpSec") : null;
    if (sec) {
      sec.append(st, list); cpDocked = crid; $("#cpSelRow").style.display = "none";
      const c = data.base.cars.find(x => x.crid === crid), away = $("#cpAway"); away.style.display = ""; away.textContent = `#${c?.numberText ?? ""} ${c?.driver ?? ""}'s paint schemes are open in the driver editor above.`;
      $("#cpFind").value = ""; cpInfo = null; cpCars(); $("#cpCar").value = String(crid); cpShow().catch(err => cps(err.message, "bad"));
    } else if (cpDocked !== null) {
      $("#cpSelRow").append(st); $("#cpSelRow").after($("#cpAway")); $("#cpAway").after(list); cpDocked = null;
      $("#cpSelRow").style.display = ""; $("#cpAway").style.display = "none";
    }
  }
  function cpCars() {
    const f = $("#cpFind").value.trim().toLowerCase(), sel = $("#cpCar"), was = +sel.value;
    const cars = data.base.cars.filter(c => !f || `#${c.numberText} ${c.driver} ${c.teamName}`.toLowerCase().includes(f));
    sel.innerHTML = cars.map(c => `<option value="${c.crid}">#${esc(c.numberText)} ${esc(c.driver)} (${esc(data.base.classes[c.class] ?? "")})${cpMine.has(c.crid) ? " — changed" : ""}</option>`).join("");
    if (cars.some(c => c.crid === was)) sel.value = String(was);
    if (+sel.value !== cpInfo?.crid) cpShow();
  }
  async function cpShow() {
    const crid = +$("#cpCar").value, box = $("#cpList"); if (!Number.isFinite(crid) || !$("#cpCar").value) { box.innerHTML = ""; cpInfo = null; return; }
    const info = await api(`/api/roster/carpaints?crid=${crid}`); if (info.crid !== +$("#cpCar").value) return;   // (an answer for a car no longer chosen)
    cpInfo = info;
    const t = Date.now();
    box.innerHTML = cpInfo.schemes.map(x => `<div class="rpic"${x.removed ? ' style="opacity:.45"' : ""}><label style="display:flex;gap:6px;align-items:center;margin-bottom:6px"><input type="checkbox" data-keep="${x.ctid}"${x.removed ? "" : " checked"}> In the game</label><h3>${esc(x.name)} <span class="tag">${esc(x.kind)}${x.current ? ", raced" : ""}</span>${x.custom ? ' <span class="tag" style="color:var(--accent)">yours</span>' : ""}</h3>
      <div class="img"><img src="${x.custom ? `/api/roster/carpaint?ctid=${x.ctid}&t=${t}` : `/api/roster/base?kind=scheme&n=${x.ctid}`}" alt=""></div>
      <div class="row"><button class="btn" data-tpl="${x.ctid}">Download template</button><button class="btn" data-pick="${x.ctid}">Choose PNG…</button>${x.custom ? `<button class="btn danger" data-del="${x.ctid}">Back to the game's</button>` : ""}</div>
      <div class="row"><label style="flex:1">Template layout <select data-lay="${x.ctid}"><option value="game">This game's</option><option value="ea1252">1252 modder (rearranged)</option></select></label></div>
      ${x.shared ? '<p class="hint">Another car uses this same paint: it changes there too.</p>' : ""}${x.rookie && x.custom ? '<p class="hint">Also used in the driver\'s rookie season (the game\'s copy with the rookie stripe is replaced by yours, without the stripe).</p>' : ""}</div>`).join("")
      + cpInfo.added.map(x => `<div class="rpic"><h3><span class="tag" style="color:var(--accent)">added</span></h3>
      <div class="row" style="margin-top:6px"><label style="flex:1">Scheme name <input data-xname="${x.k}" maxlength="38" value="${esc(x.name)}"></label></div>
      <div class="img"><img src="/api/roster/carscheme?crid=${cpInfo.crid}&k=${x.k}&t=${t}" alt=""></div>
      <div class="row"><button class="btn" data-xpick="${x.k}">Choose PNG…</button><button class="btn danger" data-xdel="${x.k}">Remove</button></div>
      <div class="row"><label style="flex:1">Template layout <select data-xlay="${x.k}"><option value="game">This game's</option><option value="ea1252">1252 modder (rearranged)</option></select></label></div></div>`).join("")
      + `<div class="rpic" style="display:flex;flex-direction:column;justify-content:center;align-items:center;gap:8px;min-height:180px"><button class="btn primary" id="cpAdd"${cpInfo.added.length >= 12 ? " disabled" : ""}>Add a paint scheme</button><p class="hint" style="text-align:center">A new scheme for this car's paint scheme menu: paint over one of its schemes (Download template) and choose the picture.</p></div>`;
    box.querySelectorAll("select[data-xlay]").forEach(sel => { const x = cpInfo.added.find(a => a.k === +sel.dataset.xlay); sel.value = x.layout;
      sel.onchange = async () => { try { cps("making the paint again…", "run"); await post(`/api/roster/carscheme?crid=${cpInfo.crid}&k=${x.k}`, { layout: sel.value }); cps("saved", "ok"); cpShow(); } catch (err) { cps(err.message, "bad"); } }; });
    box.querySelectorAll("input[data-xname]").forEach(i => i.onchange = async () => { try { await post(`/api/roster/carscheme?crid=${cpInfo.crid}&k=${i.dataset.xname}`, { name: i.value }); cps("name saved", "ok"); } catch (err) { cps(err.message, "bad"); } });
    box.querySelectorAll("[data-xpick]").forEach(b => b.onclick = () => { cpPick = { k: +b.dataset.xpick }; $("#cpFile").click(); });
    box.querySelectorAll("[data-xdel]").forEach(b => b.onclick = async () => { try { await api(`/api/roster/carscheme?crid=${cpInfo.crid}&k=${b.dataset.xdel}`, { method: "DELETE" }); await cpRefresh(); cps("scheme removed", "ok"); } catch (err) { cps(err.message, "bad"); } });
    $("#cpAdd").onclick = () => { cpPick = { k: "new" }; $("#cpFile").click(); };
    box.querySelectorAll("select[data-lay]").forEach(sel => { const x = cpInfo.schemes.find(s => s.ctid === +sel.dataset.lay); sel.value = x.layout;
      sel.onchange = async () => { if (!x.custom) return; try { cps("making the paint again…", "run"); await post("/api/roster/carpaint/layout", { ctid: x.ctid, layout: sel.value }); cps("saved", "ok"); cpShow(); } catch (err) { cps(err.message, "bad"); } }; });
    box.querySelectorAll("input[data-keep]").forEach(i => i.onchange = async () => {
      const removed = [...box.querySelectorAll("input[data-keep]")].filter(c => !c.checked).map(c => +c.dataset.keep);
      try { await post("/api/roster/schemes", { crid: cpInfo.crid, removed }); await cpRefresh(); cps(i.checked ? "scheme back in the game" : "scheme taken out (restart the game)", "ok"); }
      catch (err) { i.checked = true; cps(err.message, "bad"); }
    });
    box.querySelectorAll("[data-tpl]").forEach(b => b.onclick = () => { const a = document.createElement("a"); a.href = `/api/roster/base?kind=scheme&n=${b.dataset.tpl}`; a.download = `paint-car-${cpInfo.number}-scheme-${b.dataset.tpl}.png`; a.click(); });
    box.querySelectorAll("[data-pick]").forEach(b => b.onclick = () => { cpPick = +b.dataset.pick; $("#cpFile").click(); });
    box.querySelectorAll("[data-del]").forEach(b => b.onclick = async () => { try { await api(`/api/roster/carpaint?ctid=${b.dataset.del}`, { method: "DELETE" }); await cpRefresh(); cps("back to the game's paint", "ok"); } catch (err) { cps(err.message, "bad"); } });
  }
  async function cpRefresh() { const r = await api("/api/roster/carpaints"); cpMine = new Set([...r.cars, ...(r.trimmed ?? [])]); cpInfo = null; cpCars(); }
  $("#cpFind").oninput = cpCars; $("#cpCar").onchange = () => cpShow().catch(err => cps(err.message, "bad"));
  $("#cpFile").onchange = async ev => {
    const f = ev.target.files[0]; ev.target.value = ""; if (!f || cpPick === null) return;
    try {
      // (kept at its own size, square, up to 2048, as a driver's paint; a 1252-size picture is taken as that template)
      const side = await new Promise(ok => { const im = new Image(); im.onload = () => { ok(Math.min(2048, Math.max(512, im.width, im.height))); URL.revokeObjectURL(im.src); }; im.onerror = () => ok(512); im.src = URL.createObjectURL(f); });
      const extra = typeof cpPick === "object", r = await toPng(f, [side, side], true);
      const lay = guessLayout(r.srcW, r.srcH) ?? (extra ? $(`select[data-xlay="${cpPick.k}"]`)?.value : $(`select[data-lay="${cpPick}"]`)?.value) ?? "game";
      cps("saving…", "run");
      const url = extra ? `/api/roster/carscheme?crid=${cpInfo.crid}&k=${cpPick.k}&layout=${lay}${cpPick.k === "new" ? `&name=${encodeURIComponent(f.name.replace(/\.[^.]*$/, "").slice(0, 38))}` : ""}`
        : `/api/roster/carpaint?ctid=${cpPick}&crid=${cpInfo.crid}&layout=${lay}`;
      await api(url, { method: "PUT", headers: { "content-type": "image/png" }, body: r.blob });
      await cpRefresh(); const game = Math.max(r.srcW, r.srcH) > 1448 ? 2048 : Math.max(r.srcW, r.srcH) > 724 ? 1024 : 512;
      cps(`saved: ${game} × ${game} in the game${lay === "ea1252" ? ", rearranged from the 1252 layout" : ""}${r.srcW !== r.srcH ? " (stretched square)" : ""}. Restart the game to see it.`, "ok");
    } catch (err) { cps(err.message, "bad"); }
  };
  const loadCp = () => cpRefresh().catch(err => cps(err.message, "bad"));

  load().then(loadCp).catch(err => { root.innerHTML = `<div class="card"><h2>Roster</h2><p class="hint">Could not read the game's database: ${esc(err.message)}</p></div>`; });
})();
