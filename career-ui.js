// career-ui.js — the launcher's Career tab (page side; server side career-server.mjs). Builds into <section id="career">:
// the silly season (the off-season after each career year) — the game's own rules, or these with every number
// adjustable and the extra parts (silly-season.mjs).
(() => {
  const root = document.getElementById("career"); if (!root) return;
  const $ = (sel, el = root) => el.querySelector(sel);
  const api = async (path, opts = {}) => { const r = await fetch(path, opts); const j = r.headers.get("content-type")?.includes("json") ? await r.json() : null; if (!r.ok) throw new Error(j?.error || r.status); return j; };
  const post = (path, data) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

  // [path, label, hint, min, max] — a number; [path, label, hint] with no range — a switch
  const GROUPS = [
    { title: "Silly season", text: "After the last race of each career year the game retires a few drivers and fills their rides. Off: the game's own code, exactly as on the Xbox. On: the same rules run here, with the numbers below (the defaults are the game's) and the extra parts you switch on.", fields: [
      ["enabled", "Use these settings", "off: the game's own silly season"],
      ["fixes", "Fix the game's mistakes", "a Cup driver's Busch-series record is the same person: it no longer retires on its own (parking his Cup car) or gets promoted into a second Cup car; a promoted Busch driver's seat is filled instead of parked; a driver moved once can move again"],
      ["news", "Career news", "each move as a line in the career news ticker (\"Silly Season\")"] ] },
    { title: "Retirements", text: "Drivers collect points toward retiring; the highest go. Human players' drivers never retire.", fields: [
      ["retireAge", "Retirement age", "older drivers score points every year past it", 20, 99],
      ["agePoints", "Points a year past it", "score = this × years over + 0..9 (100 = certain)", 0, 100],
      ["rankCutoff", "Points position cut-off", "finishing the year below this position counts as a bad season", 1, 99],
      ["strugglePoints", "Points a bad season", "× seasons since the last good one", 0, 100],
      ["veteranYears", "Safe years after the rookie year", "neither rule applies before this", 0, 50],
      ["championTitles", "Champion retires on title number", "0: never", 0, 99],
      ["retireMin", "Retirements a year: at least", "when that many have points", 0, 40],
      ["retireMax", "… at most", "", 0, 40],
      ["maxCandidates", "Candidates considered", "", 1, 40],
      ["minActiveCars", "Only with this many active cars", "", 0, 999] ] },
    { title: "Teams", text: "When a driver retires his team either folds or finds a new driver.", fields: [
      ["foldChance", "Chance a retiree's team folds (%)", "its sponsor becomes free", 0, 100],
      ["revival.enabled", "Folded teams come back", "a parked car returns with a Busch driver or a prospect while the series is short of cars"],
      ["revival.max", "Comebacks a year", "", 0, 10],
      ["revival.chance", "Chance for each parked car (%)", "", 0, 100],
      ["revival.cupCars", "Cup cars to aim for", "the game starts with 40", 0, 80],
      ["revival.buschCars", "Busch cars to aim for", "the game starts with 15", 0, 80] ] },
    { title: "Team prestige and contracts", text: "Every team has a prestige (0–100) that follows its results, and every driver a standing (talent and the last two seasons' results). Drivers sign contracts and stay until they end; a Cup team only hires drivers whose standing is close to its prestige. Seats open only through retirements, folds, comebacks and contracts running out, so drivers move far less. Replaces the game's way of filling rides, the driver market and the call-ups below. The contracts and prestige are kept in your career save.", fields: [
      ["contracts.enabled", "Team prestige and driver contracts", ""],
      ["contracts.minYears", "Contract length from", "seasons (drivers near the retirement age: 2 at most; rookies: 2)", 1, 10],
      ["contracts.maxYears", "… to", "", 1, 10],
      ["contracts.tolerance", "How far below the team's prestige a driver may be", "to be hired; to keep his seat when his contract ends: twice this", 0, 100],
      ["contracts.resign", "Chance a driver still good enough re-signs (%)", "otherwise he tests the market and may go elsewhere", 0, 100],
      ["contracts.prestigeSpeed", "How fast prestige follows results (%)", "of the gap to this season's results each year", 0, 100],
      ["contracts.foldByPrestige", "Prestigious teams rarely fold", "the fold chance above is for a team of prestige 50; 90: a fifth of it, 20: 1.6 times"],
      ["contracts.sitOut", "A driver with no ride retires after", "seasons", 0, 10] ] },
    { title: "Driver market", text: "A driver who finished well below his talent swaps rides with one who finished well above his (a strong car). Talent = track skills and speed.", fields: [
      ["market.enabled", "Veterans change teams", ""],
      ["market.moves", "Swaps a year", "", 0, 20],
      ["market.gap", "How far off his talent", "places in the points, both ways", 1, 40],
      ["market.chance", "Chance a swap happens (%)", "", 0, 100],
      ["market.carFollowsDriver", "Driver keeps his number, paint and sponsor", "the two cars change teams instead of the drivers changing cars (number and sponsor are painted on the car, so they move only with the whole car)"] ] },
    { title: "Busch call-ups", text: "A Busch driver clearly more talented than a Cup driver near the back of the points takes his ride; the Cup driver gets the Busch car.", fields: [
      ["callups.enabled", "Busch drivers get Cup offers", ""],
      ["callups.max", "Call-ups a year", "", 0, 10],
      ["callups.rank", "Cup drivers below this position", "", 1, 99],
      ["callups.margin", "Talent advantage needed", "", 0, 50],
      ["callups.chance", "Chance (%)", "", 0, 100] ] },
    { title: "Sponsors change teams", text: "The paint schemes of the Sponsors tab (no number on them: the game draws each car's own) sign with career teams. Big sponsors (tier 4–5) look for prestigious teams. When a deal ends without renewal the car goes back to its own paint. Deals are kept in your career save. Human players' cars and cars a scheme starts on are left alone.", fields: [
      ["sponsors.enabled", "Sponsors change teams", "needs at least one scheme with a paint in the Sponsors tab"],
      ["sponsors.moves", "New deals a year, at most", "", 0, 20],
      ["sponsors.chance", "Chance a free sponsor signs (%)", "each year, for each scheme without a car", 0, 100],
      ["sponsors.minYears", "Deal length from", "seasons", 1, 10],
      ["sponsors.maxYears", "… to", "", 1, 10],
      ["sponsors.renew", "Chance a deal is renewed (%)", "when it ends", 0, 100] ] },
    { title: "Rookies", text: "New drivers come from the pool of fill-in drivers (the game's fantasy drivers, and drivers you add in the Roster tab under \"Rookie pool\").", fields: [
      ["rookies.customFirst", "Your rookie pool drivers first", "otherwise the game's pick: the best-placed pool driver, else a random one"],
      ["rookies.generate", "New prospects when the pool runs low", "made-up drivers with no car, waiting for a ride (generic portrait)"],
      ["rookies.poolMinimum", "Keep the pool at", "drivers", 0, 60],
      ["rookies.perYear", "New prospects a year, at most", "", 0, 20],
      ["rookies.ratingMin", "Prospect ratings from", "", 20, 100],
      ["rookies.ratingMax", "… to", "", 20, 100],
      ["rookies.ageMin", "Prospect age from", "", 15, 40],
      ["rookies.ageMax", "… to", "", 15, 45] ] },
    { title: "Driver ratings change with age", text: "In the game ratings never change. On: after each season young drivers improve toward a potential of their own (the same in every career), drivers in their prime stay about where they are, and older drivers slowly lose speed and durability (car control and defense hold up longer: experience). Track skills follow. The changes are kept in your career save. The last off-season's biggest changes are at /silly-season on the game's page.", fields: [
      ["progression.enabled", "Ratings change", ""],
      ["progression.growUntil", "Young drivers improve until age", "", 16, 45],
      ["progression.declineFrom", "Decline starts at age", "a little faster every year after", 20, 60],
      ["progression.growth", "Improvement a year", "rating points, less as a driver nears his potential", 0, 10],
      ["progression.decline", "Decline a year", "rating points (speed, durability; aggression half, control and defense a third)", 0, 10],
      ["progression.randomness", "Ups and downs", "a year's change varies by up to this, either way", 0, 10],
      ["progression.results", "Results count", "a season 8+ places better than his talent: +1 to every rating, 8+ worse: -1 (not for declining drivers)"],
      ["progression.players", "Human players' drivers too", "off: only the AI drivers change"] ] },
  ];
  const STOCK = new Set(["retireAge", "agePoints", "rankCutoff", "strugglePoints", "veteranYears", "championTitles", "retireMin", "retireMax", "maxCandidates", "minActiveCars", "foldChance"]);
  const word = p => STOCK.has(p) ? "game" : "default";
  const get = (o, p) => p.split(".").reduce((a, k) => a?.[k], o);
  const set = (o, p, v) => { const k = p.split("."); let a = o; for (const x of k.slice(0, -1)) a = a[x] ??= {}; a[k.at(-1)] = v; };
  let D = null;

  root.innerHTML = `<div id="cGroups"></div>
  <div class="card"><div class="row"><button class="btn primary" id="cSave">Save</button><button class="btn" id="cReset">Back to the defaults</button><span class="pill" id="cState"></span></div>
    <p class="hint">Applies from the next season end of any career (also careers saved before). Restart the game after saving. While the game runs, the last off-season's moves are at <code>/silly-season</code> on the game's page.</p></div>
  <div class="card" id="cPool"><h2>The game's rookie pool</h2>
    <p class="hint" style="margin-top:0">The game's own fill-in drivers, from which a career's silly season picks its rookies (with the game's own rules or the settings above). Untick a driver to keep him out of careers: he is never given a ride, but still races in quick races and seasons as before. Drivers already promoted in a saved career keep their ride. The pool also holds the game's tutorial cars (\"SZ\") and an EA SPORTS promo car. Your own rookies are in the Rookies tab.</p>
    <div class="row"><button class="btn" id="pAll">Tick all</button><button class="btn" id="pJunk">Untick the tutorial and promo cars</button><button class="btn primary" id="pSave">Save</button><span class="pill" id="pState"></span></div>
    <div id="pList" class="cgrid"></div></div>
  <div class="card" id="cBusch"><h2>Busch drivers who stay in Busch</h2>
    <p class="hint" style="margin-top:0">When a Cup seat opens, a Busch driver usually moves up to it. Untick a Busch driver to keep him in the Busch series: he is never moved up to Cup (by the game's rule, the call-ups, the folded teams that come back or the contracts), but still races and retires as usual. The Busch cars of Cup drivers (Earnhardt Jr., Harvick, Waltrip, Burton) are not listed: "Fix the game's mistakes" already keeps them from being moved up.</p>
    <p class="hint" id="bOff" style="display:none;color:var(--warn,#e0a040)">Only works with "Use these settings" on (at the top): the game's own silly season has no way to skip a Busch driver without also stopping him from ever retiring.</p>
    <div class="row"><button class="btn" id="buAll">Tick all</button><button class="btn primary" id="buSave">Save</button><span class="pill" id="buState"></span></div>
    <div id="buList" class="cgrid"></div></div>`;
  const style = document.createElement("style");
  style.textContent = `.cgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px 18px;margin-top:10px}
  .cgrid label{display:grid;grid-template-columns:1fr auto;gap:2px 10px;align-items:center;color:var(--text)} .cgrid label small{grid-column:1/-1;color:var(--dim);font-size:12px}
  .cgrid label.sw{grid-template-columns:auto 1fr} .cgroup.off .cgrid{opacity:.45} #cBusch.off .cgrid{opacity:.45}`;
  document.head.appendChild(style);

  function render() {
    const s = D.sillySeason;
    $("#cGroups").innerHTML = GROUPS.map((g, gi) => `<div class="card cgroup" data-g="${gi}"><h2>${g.title}</h2><p class="hint" style="margin-top:0">${g.text}</p><div class="cgrid">${g.fields.map(([p, label, hint, lo, hi]) =>
      lo === undefined ? `<label class="sw"><input type="checkbox" data-p="${p}"${get(s, p) ? " checked" : ""}><span>${label}</span>${hint ? `<small>${hint}</small>` : ""}</label>`
        : `<label><span>${label}</span><input type="number" data-p="${p}" min="${lo}" max="${hi}" value="${get(s, p)}">${hint ? `<small>${hint} (${word(p)}: ${get(D.defaults, p)})</small>` : `<small>${word(p)}: ${get(D.defaults, p)}</small>`}</label>`).join("")}</div></div>`).join("");
    root.querySelectorAll("[data-p]").forEach(el => el.onchange = () => { set(D.sillySeason, el.dataset.p, el.type === "checkbox" ? el.checked : Number(el.value)); dim(); $("#cState").textContent = "not saved"; });
    dim();
  }
  function dim() {
    const on = D.sillySeason.enabled, k = D.sillySeason.contracts?.enabled;
    root.querySelectorAll(".cgroup").forEach((c, i) => { const t = GROUPS[i].title; c.classList.toggle("off", (i > 0 && !on) || (k && (t === "Driver market" || t === "Busch call-ups"))); });
  }
  async function load() { D = await api("/api/career"); render(); $("#cState").textContent = D.saved ? "saved" : "game's rules"; }
  $("#cSave").onclick = async () => { try { const r = await post("/api/career", { sillySeason: D.sillySeason }); D.sillySeason = r.sillySeason; render(); $("#cState").textContent = "saved"; } catch (e) { $("#cState").textContent = String(e.message || e); } };
  $("#cReset").onclick = () => { const on = D.sillySeason.enabled, keep = D.sillySeason.noPromote; D.sillySeason = structuredClone(D.defaults); D.sillySeason.enabled = on; D.sillySeason.noPromote = keep ?? []; render(); $("#cState").textContent = "not saved"; };
  load().catch(e => { root.innerHTML = `<div class="card">Career settings could not be loaded: ${e.message}</div>`; });

  // the game's rookie pool: drivers careers never pick (career-server /api/career/pool)
  let P = null, out = new Set();
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const pst = (t, k = "") => { $("#pState").textContent = t; $("#pState").className = "pill " + k; };
  function pcount() { const n = P.drivers.length - P.drivers.filter(d => out.has(d.drid)).length; pst(`${n} of ${P.drivers.length} eligible, ${out.size} left out`); }
  function prender() {
    $("#pList").innerHTML = P.drivers.map(d => `<label class="sw"><input type="checkbox" data-drid="${d.drid}"${out.has(d.drid) ? "" : " checked"}><span><b>${esc(d.name)}</b> <small style="display:inline;color:var(--dim)">#${esc(d.number)} · born ${d.born} · rating ${d.rating}${d.kind ? ` · ${d.kind} car` : ""}</small></span></label>`).join("");
    $("#pList").querySelectorAll("input[data-drid]").forEach(i => i.onchange = () => { if (i.checked) out.delete(+i.dataset.drid); else out.add(+i.dataset.drid); pcount(); $("#pState").textContent += " · not saved"; });
    pcount();
  }
  async function pload() { P = await api("/api/career/pool"); out = new Set(P.removed); prender(); }
  $("#pAll").onclick = () => { out.clear(); prender(); $("#pState").textContent += " · not saved"; };
  $("#pJunk").onclick = () => { for (const d of P.drivers) if (d.kind) out.add(d.drid); prender(); $("#pState").textContent += " · not saved"; };
  $("#pSave").onclick = async () => { try { const r = await post("/api/career/pool", { drids: [...out] }); out = new Set(r.removed); prender(); pst(`Saved: ${out.size} left out. Restart the game to use it.`, "ok"); } catch (e) { pst(String(e.message || e), "err"); } };
  pload().catch(e => { $("#pList").textContent = `The game's rookie pool could not be loaded: ${e.message}`; });

  // Busch drivers never moved up to Cup: sillySeason.noPromote (silly-season.mjs), saved with the other settings
  const bst = (t, k = "") => { $("#buState").textContent = t; $("#buState").className = "pill " + k; };
  const stay = () => new Set(D?.sillySeason?.noPromote ?? []);
  function brender() {
    if (!P || !D) return;
    const st = stay();
    $("#buList").innerHTML = P.busch.map(d => `<label class="sw"><input type="checkbox" data-bu="${d.drid}"${st.has(d.drid) ? "" : " checked"}><span><b>${esc(d.name)}</b> <small style="display:inline;color:var(--dim)">#${esc(d.number)}${d.team ? ` · ${esc(d.team)}` : ""} · born ${d.born} · rating ${d.rating}</small></span></label>`).join("");
    $("#buList").querySelectorAll("input[data-bu]").forEach(i => i.onchange = () => { const s = stay(); if (i.checked) s.delete(+i.dataset.bu); else s.add(+i.dataset.bu); D.sillySeason.noPromote = [...s]; bcount(" · not saved"); });
    bcount("");
  }
  function bcount(x) { const n = P.busch.filter(d => stay().has(d.drid)).length; bst(`${n ? `${n} stay in Busch` : "all can move up"}${x}`); $("#bOff").style.display = D.sillySeason.enabled ? "none" : ""; $("#cBusch").classList.toggle("off", !D.sillySeason.enabled); }
  $("#buAll").onclick = () => { D.sillySeason.noPromote = []; brender(); bcount(" · not saved"); };
  $("#buSave").onclick = async () => { try { const r = await post("/api/career", { sillySeason: D.sillySeason }); D.sillySeason = r.sillySeason; brender(); bst(`Saved. Restart the game to use it.`, "ok"); $("#cState").textContent = "saved"; } catch (e) { bst(String(e.message || e), "err"); } };
  (async () => { for (let i = 0; i < 50 && !(P && D); i++) await new Promise(r => setTimeout(r, 100)); brender(); })();
  // (drivers added in the Roster tab meanwhile)
  document.querySelector('nav button[data-tab="career"]')?.addEventListener("click", () => pload().then(brender).catch(() => {}));
  root.addEventListener("change", e => { if (e.target.dataset?.p === "enabled" && P) bcount($("#buState").textContent.includes("not saved") ? " · not saved" : ""); });
})();
