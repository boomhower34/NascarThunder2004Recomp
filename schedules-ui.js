// schedules-ui.js — the launcher's Schedules tab (page side; server side schedules-server.mjs). Builds into
// <section id="sched">. Six schedules: the season settings' three choices and, when careers have their own, the
// career settings' three.
(() => {
  const root = document.getElementById("sched"); if (!root) return;
  const $ = (sel, el = root) => el.querySelector(sel);
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const api = async (path, opts = {}) => { const r = await fetch(path, opts); const j = r.headers.get("content-type")?.includes("json") ? await r.json() : null; if (!r.ok) throw new Error(j?.error || r.status); return j; };
  const post = (path, data) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  const NAMES = { 0: "Season — short", 1: "Season — medium", 2: "Season — long", 4: "Career — short", 5: "Career — medium", 6: "Career — long" };
  const GAME_LABEL = { 0: "12 Races", 1: "24 Races", 2: "36 Races", 4: "12 Races", 5: "24 Races", 6: "36 Races" };
  let D = null, cur = 0, edit = {}, career = false, dirty = false, dragFrom = -1;
  const race = id => D.races.find(r => r.raid === id) ?? { raid: id, name: `race ${id}`, track: "?" };
  // what a schedule is now: edited here, else saved, else (career) the season one it starts from, else the game's
  const effective = k => edit[k] ?? D.saved[k] ?? (k >= 4 ? effective(k - 4) : D.game[k]);

  root.innerHTML = `
  <div class="card"><h2>Schedules</h2>
    <p class="hint" style="margin-top:0">The game's Season Settings and Career Settings offer three schedules ("12 / 24 / 36 Races"; the label in the game shows how many points races the schedule really has). Edit them here: add any race (also the game's fantasy tracks and tracks added by track packs), remove, reorder. Changes apply to seasons and careers started afterwards.</p>
    <label style="display:flex;gap:8px;align-items:center;margin-top:8px"><input type="checkbox" id="sCareer"> Careers have their own three schedules (otherwise they use the season ones)</label>
    <div class="row" id="sTabs" style="margin-top:12px;gap:6px"></div>
  </div>
  <div class="card" id="sEdit"></div>`;
  const style = document.createElement("style");
  style.textContent = `
  #sTabs button.on{border-color:var(--accent);color:var(--accent)} #sTabs button:disabled{opacity:.4}
  .srow{display:grid;grid-template-columns:44px 1fr 170px auto;gap:10px;align-items:center;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:#0b0e13;margin-bottom:5px;cursor:grab}
  .srow.ex{opacity:.75} .srow .n{color:var(--dim);font-variant-numeric:tabular-nums;text-align:right} .srow small{color:var(--dim)}
  .srow button{padding:3px 9px} .srow.drag{border-color:var(--accent)} .srow .warn{color:#e8a33d;font-size:12px}`;
  document.head.appendChild(style);

  async function load() { D = await api("/api/schedules"); career = D.careerSchedules; edit = {}; dirty = false; $("#sCareer").checked = career; render(); }
  function tabs() {
    $("#sTabs").innerHTML = Object.entries(NAMES).map(([k, n]) => `<button class="btn${+k === cur ? " on" : ""}" data-k="${k}"${+k >= 4 && !career ? " disabled" : ""}>${n} <small style="color:var(--dim)">(${points(effective(+k))})</small></button>`).join("");
    root.querySelectorAll("#sTabs button").forEach(b => b.onclick = () => { cur = +b.dataset.k; render(); });
  }
  const points = list => list.filter(id => !race(id).exhibition).length;
  function render() {
    if (!career && cur >= 4) cur -= 4; tabs();
    const list = effective(cur), box = $("#sEdit"); let n = 0;
    const groups = new Map(); for (const r of D.races) { const k = r.pack ? `Added tracks` : r.track || "Other"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    box.innerHTML = `<h2>${NAMES[cur]} <small style="color:var(--dim);font-weight:400">— in the game: "${GAME_LABEL[cur]}" choice</small></h2>
      <p class="hint" style="margin-top:0">${points(list)} points races${list.length > points(list) ? ` and ${list.length - points(list)} exhibition${list.length - points(list) > 1 ? "s" : ""} (Shootout, All-Star: no points)` : ""}. ${D.saved[cur] || edit[cur] ? "Changed from the game's." : cur >= 4 && !D.saved[cur] ? "Starts as a copy of the season one." : "The game's own."} Drag rows or use the arrows to reorder.</p>
      <div id="sList">${list.map((id, i) => { const r = race(id); if (!r.exhibition) n++;
        return `<div class="srow${r.exhibition ? " ex" : ""}" draggable="true" data-i="${i}"><span class="n">${r.exhibition ? "exh." : n}</span>
          <span><b>${esc(r.name)}</b>${r.pack && !r.packOn ? ` <span class="warn">track pack switched off: left out</span>` : ""}</span><small>${esc(r.track)}${r.laps ? ` · ${r.laps} laps` : ""}</small>
          <span><button class="btn" data-a="up">↑</button> <button class="btn" data-a="down">↓</button> <button class="btn" data-a="del">✕</button></span></div>`; }).join("")}</div>
      <div class="row" style="margin-top:10px"><select id="sAdd" style="max-width:420px">${[...groups].map(([g, rs]) => `<optgroup label="${esc(g)}">${rs.map(r => `<option value="${r.raid}">${esc(r.name)} (${esc(r.track)})${r.exhibition ? " — exhibition" : ""}</option>`).join("")}</optgroup>`).join("")}</select>
        <button class="btn" id="sAddB">Add race</button>
        <select id="sCopy"><option value="">Copy from…</option>${Object.entries(NAMES).filter(([k]) => +k !== cur && (career || +k < 4)).map(([k, nm]) => `<option value="${k}">${nm}</option>`).join("")}</select>
        <button class="btn" id="sReset">Back to the game's</button></div>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="sSave"${dirty ? "" : " disabled"}>Save</button><span id="sState" class="pill">${dirty ? "not saved" : ""}</span></div>`;
    const set = l => { edit[cur] = l; dirty = true; render(); };
    box.querySelectorAll(".srow").forEach(el => { const i = +el.dataset.i;
      el.querySelectorAll("button").forEach(b => b.onclick = () => { const l = [...list]; const a = b.dataset.a;
        if (a === "del") { if (l.length === 1) return alert("A schedule needs at least one race."); l.splice(i, 1); }
        else { const j = a === "up" ? i - 1 : i + 1; if (j < 0 || j >= l.length) return; [l[i], l[j]] = [l[j], l[i]]; } set(l); });
      el.ondragstart = () => { dragFrom = i; el.classList.add("drag"); }; el.ondragend = () => el.classList.remove("drag");
      el.ondragover = e => e.preventDefault();
      el.ondrop = e => { e.preventDefault(); if (dragFrom < 0 || dragFrom === i) return; const l = [...list]; const [x] = l.splice(dragFrom, 1); l.splice(i, 0, x); dragFrom = -1; set(l); }; });
    $("#sAddB").onclick = () => set([...list, +$("#sAdd").value]);
    $("#sCopy").onchange = e => { if (e.target.value !== "") set([...effective(+e.target.value)]); };
    $("#sReset").onclick = () => { edit[cur] = cur >= 4 ? [...effective(cur - 4)] : [...D.game[cur]]; edit[cur].reset = true; dirty = true; render(); };
    $("#sSave").onclick = save;
  }
  async function save() {
    const schedules = {}; for (const [k, l] of Object.entries(edit)) schedules[k] = l.reset ? null : l;
    try { const r = await post("/api/schedules", { schedules, careerSchedules: career }); D.saved = r.saved; edit = {}; dirty = false; render(); $("#sState").textContent = "saved"; }
    catch (e) { $("#sState").textContent = e.message; }
  }
  $("#sCareer").onchange = e => { career = e.target.checked; dirty = true; render(); };
  document.querySelector('nav [data-tab="sched"]')?.addEventListener("click", () => { if (!dirty) load().catch(e => $("#sEdit").textContent = e.message); });
})();
