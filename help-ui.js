// help-ui.js — the launcher's Help tab: how to use everything the launcher and the game page offer. Plain page-side
// content (no server routes); a topic list on the left, a search box that filters the topics.
(() => {
  const root = document.getElementById("help"); if (!root) return;
  const NAMES = { sched: "Schedules", tex: "Textures", ovr: "Overrides" };
  const go = tab => `<a href="#" data-go="${tab}">${NAMES[tab] ?? tab[0].toUpperCase() + tab.slice(1)} tab</a>`;
  const k = s => `<kbd>${s}</kbd>`;
  const T = [
    { id: "start", title: "Getting started", tags: "play start game port intro title menu", body: `
      <p>The launcher runs the game in your browser. Everything you set up here (drivers, teams, sponsors, tracks, schedules, career rules) is applied to the game when it starts. The game's own files are never changed, so you can always get the plain game back.</p>
      <ol>
        <li>First time only: on the ${go("setup")}, under <b>Game files</b>, paste the path of your NASCAR Thunder 2004 disc image (<code>.iso</code> / <code>.xiso</code>) and press <b>Extract</b>. This takes <code>default.xbe</code> and the <code>Data</code> folder out of it (about 3.2 GB). Running it again only replaces missing or incomplete files. It also makes <code>default.exe</code> from the XBE.</li>
        <li>First time only: under <b>Game code</b> on the same tab, press <b>Build game code</b>. This recompiles the game's code for your computer (5–10 minutes). The compiler it needs comes with the download (in <code>tools/llvm</code>); the card says if it can't be found or started. Without it the game still runs, but the first races stutter while it warms up a cache, and after that the game code takes about twice the processor time.</li>
        <li>Pick a <b>preset</b> at the top right (or keep "Main"). See <a href="#" data-topic="presets">Presets</a>.</li>
        <li>Change whatever you like in the other tabs and save each card.</li>
        <li>On the ${go("play")}, press <b>Start game</b>. The game opens in a new tab once it is running.</li>
      </ol>
      <p><b>Changes need a restart:</b> stop the game and start it again after saving anything in the launcher.</p>
      <h4>Play tab options</h4>
      <ul>
        <li><b>Port</b>: the local web port the game page uses. Change it only if another program already uses it.</li>
        <li><b>Start at</b>: Intro (normal), Title screen (skips the intro movies) or Main menu (skips the intro and title).</li>
        <li><b>Unlock everything</b>: see <a href="#" data-topic="unlock">Unlock everything</a>.</li>
        <li><b>Online</b>: see <a href="#" data-topic="online">Online races</a>.</li>
        <li>The log box under the buttons shows what the game is doing. It's useful if something goes wrong.</li>
      </ul>` },
    { id: "controls", title: "Controls and game page keys", tags: "keyboard keys controller gamepad pad wheel f2 f3 f4 f6 f9 mute", body: `
      <h4>Keyboard (default)</h4>
      <table><tbody>
        <tr><td>${k("↑")} / ${k("W")}</td><td>Throttle; up in menus (left stick)</td></tr>
        <tr><td>${k("↓")} / ${k("S")}</td><td>Brake; down in menus</td></tr>
        <tr><td>${k("←")} ${k("→")} / ${k("A")} ${k("D")}</td><td>Steer</td></tr>
        <tr><td>${k("Enter")} / ${k("Space")}</td><td>A (select)</td></tr>
        <tr><td>${k("Esc")} / ${k("Backspace")}</td><td>B (back)</td></tr>
        <tr><td>${k("X")} ${k("Y")}</td><td>X and Y</td></tr>
        <tr><td>${k("Q")} / ${k("E")}</td><td>White / Black buttons</td></tr>
        <tr><td>${k("P")}</td><td>Start (pause)</td></tr>
        <tr><td>${k("Tab")}</td><td>Back button</td></tr>
        <tr><td>${k("I")} ${k("J")} ${k("K")} ${k("L")}</td><td>D-pad</td></tr>
        <tr><td>Numpad ${k("4")} ${k("6")} ${k("8")} ${k("2")}</td><td>Look left / right / up / down</td></tr>
      </tbody></table>
      <p>You can change every key in the game page's <b>Controls</b> panel; it's saved in that browser.</p>
      <h4>Game page keys</h4>
      <table><tbody>
        <tr><td>${k("F2")}</td><td>Show or hide the page's panels</td></tr>
        <tr><td>${k("F3")}</td><td>Switch between widescreen and stretched 4:3</td></tr>
        <tr><td>${k("F4")}</td><td>Show or hide the live leaderboard during races</td></tr>
        <tr><td>${k("F6")}</td><td>Leaderboard: running order → race points → season standings</td></tr>
        <tr><td>${k("M")}</td><td>Mute or unmute</td></tr>
        <tr><td>${k("F9")}</td><td>Save a capture (only with <code>?capture=1</code> in the address)</td></tr>
        <tr><td>${k("Enter")} / ${k("Esc")}</td><td>Skip a movie</td></tr>
      </tbody></table>
      <h4>Controllers</h4>
      <p>Every connected gamepad works as an Xbox controller. The first one shares player 1 with the keyboard; more pads become players 2–4. Xbox, PlayStation and most other pads map by button position: LB = White, RB = Black, Menu/Options = Start, View/Share = Back.</p>
      <h4>Steering wheels</h4>
      <p>Open the game page's <b>Steering wheel</b> panel, pick your wheel, and move each control (steering, throttle, brake, buttons) when asked. You can set the full lock angle, the centre dead zone and the pedal curve. Each wheel's set-up is saved in that browser.</p>` },
    { id: "gfx", title: "Graphics, sound and display", tags: "graphics antialiasing render scale texture filtering anisotropic volume sharp", body: `
      <p>The game page's <b>Graphics</b> panel (saved in that browser):</p>
      <ul>
        <li><b>Antialiasing</b>: smooths jagged edges (off, 2×, 4×, 8×, up to what your graphics card supports).</li>
        <li><b>Render scale</b>: draws the game at 1–4 times its original 640 × 480 for a sharper picture on big screens. Higher is slower.</li>
        <li><b>Texture filtering</b>: off (original look), trilinear, or anisotropic 2–16× for sharper road and walls at an angle.</li>
      </ul>
      <p><b>Volume</b> is on the game page too; ${k("M")} mutes. For sharper menus, portraits and fonts, see <a href="#" data-topic="textures">Upscaled pictures</a>.</p>` },
    { id: "unlock", title: "Unlock everything", tags: "unlock thunder plates cheat all cars tracks", body: `
      <p>Tick <b>Unlock everything</b> on the ${go("play")} and every Thunder Plate goes to all four profiles when the game starts. That covers every car and driver; the locked races and tracks (night, infield, fantasy, All-Star, Shootout); Create-A-Car templates and paints; every sponsor level; and the extras.</p>
      <p>This is set per preset. A profile saved while it's on keeps the unlocks after you turn it off, so make a separate preset if you want to keep a profile that earns them the normal way.</p>` },
    { id: "presets", title: "Presets", tags: "preset copy container separate saves switch", body: `
      <p>A preset is a separate copy of your game set-up. Each preset has its own:</p>
      <ul><li>drivers, teams, sponsors, tracks, schedules and career settings (the Roster, Tracks, Schedules, Career, Rookies and Sponsors tabs);</li>
        <li>saves (profiles, seasons, careers, EA SPORTS Bio, system settings);</li>
        <li>"Unlock everything" setting.</li></ul>
      <p>Shared by all presets: the game itself, upscaled pictures, upscaling models and the other launcher settings.</p>
      <ul>
        <li><b>Switch</b> with the menu at the top right or on the ${go("presets")}. Stop the game first.</li>
        <li><b>New preset</b>: "Start from" copies another preset's set-up so you can change it without touching the original. Tick "also copy its saves" to bring its saves along; otherwise the new preset starts with fresh profiles, seasons and careers.</li>
        <li><b>Main</b> is the launcher's own folders (what you had before presets existed). It can't be removed.</li>
        <li><b>Remove</b> deletes a preset's drivers, pictures, tracks and saves for good.</li>
      </ul>
      <p>The first time a new preset starts, the game asks whether to turn on autosave. After you answer, it saves its system settings and won't ask again.</p>` },
    { id: "drivers", title: "Roster: adding drivers", tags: "roster driver add portrait ratings number paint scheme pit sign crew uniform busch fill-in", body: `
      <p>On the ${go("roster")}, <b>Drivers you added</b> creates new drivers. Each one gets their own car, copied from a car in the game ("Start from").</p>
      <ul>
        <li><b>Details</b>: name, hometown, birth date, rookie year, number, team and make.</li>
        <li><b>Driver list</b>: <i>Primary</i> drivers race every week. <i>Secondary</i>, <i>Busch</i> and <i>fill-in</i> drivers come in when a field is short (in that order). In a career, Busch drivers move up when a Cup seat opens, and fill-in drivers can be given rides in the silly season.</li>
        <li><b>Ratings</b> and track skills.</li>
        <li><b>Pictures</b>: a portrait for the menus and a head shot for races.</li>
        <li><b>Car number</b>: font, fill and outline colours, or your own number picture.</li>
        <li><b>Paint scheme</b>: a picture painted on the make's template (the game's layout or a 1252 modder template). It's kept as you chose it and rearranged if you change the layout or make. <b>More paint schemes</b> adds extra schemes to pick from in the game's paint menu.</li>
        <li><b>Pit sign and pit box</b>: the sign over the pit stall and the tool cart's colours.</li>
        <li><b>Pit crew uniforms</b>: a uniform sheet so the crew doesn't wear another driver's suits.</li>
      </ul>
      <p>New drivers race in Race Now, and in seasons and careers <b>started after</b> you add them. Saved seasons keep their own field.</p>` },
    { id: "gamedrivers", title: "Roster: removing the game's drivers", tags: "remove untick driver field 43", body: `
      <p>Under <b>The game's drivers</b>, untick a driver to take them out: they no longer show in car select and never race. The field stays at 43; the next drivers by popularity fill in (from the secondary list, then the Busch and fill-in drivers).</p>
      <p>Their cars can still be used under "Start from" for a driver you add. To keep a game rookie out of careers only, use <a href="#" data-topic="pool">the rookie pool</a> instead.</p>` },
    { id: "teams", title: "Roster: teams", tags: "team add rename prestige cars", body: `
      <p>The <b>Teams</b> card on the ${go("roster")} adds your own teams, renames the game's (empty the name to get the original back) and chooses which cars run for which team. The team name shows on car select, results and driver screens.</p>
      <p>In a career, the team is who hires the drivers. With "Team prestige and driver contracts" on in the ${go("career")}, a team's <b>prestige</b> (0–100) decides which drivers it signs. Leave a new team's prestige empty and it's worked out from its drivers in the first off-season.</p>` },
    { id: "rookies", title: "Rookies", tags: "rookie prospect young driver career", body: `
      <p>The ${go("rookies")} adds <b>rookie prospects</b>: young drivers without a car of their own. When a seat opens in a career's off-season, the silly season can sign one, and he drives that team's car.</p>
      <p>They need a name and ratings. A portrait is optional; without one they show the game's generic face. For comparison, the game's fill-in drivers are mostly rated 60–80 and its Cup regulars 75–95.</p>` },
    { id: "career", title: "Career: the silly season", tags: "career silly season retire retirement fold contracts market callups busch news fixes", body: `
      <p>The ${go("career")} sets how drivers, teams and sponsors move between seasons. Turn on <b>Use these settings</b> at the top; otherwise the game's own silly season runs.</p>
      <ul>
        <li><b>Fix the game's mistakes</b> and <b>Career news</b> (a list of the off-season's moves).</li>
        <li><b>Retirements</b>: retirement age, how poor results or a title count, and how many drivers retire a year.</li>
        <li><b>Teams</b>: the chance a retiring driver's team folds, and whether folded teams come back.</li>
        <li><b>Team prestige and contracts</b>: teams sign drivers close to their prestige, for contracts of a set length. Prestige follows results.</li>
        <li><b>Driver market</b>: veterans swap teams. Optionally the driver keeps his number, paint and sponsor.</li>
        <li><b>Busch call-ups</b>: strong Busch drivers get Cup offers over weak Cup drivers.</li>
        <li><b>Sponsors change teams</b>: free sponsors sign deals with teams and deals get renewed. This works with the paint schemes from the Sponsors tab.</li>
        <li><b>Rookies</b>: your rookie prospects first, and new prospects made up when the pool runs low.</li>
        <li><b>Driver ratings change with age</b>: see <a href="#" data-topic="progression">Rating changes</a>.</li>
      </ul>
      <p>Changes apply from the next season end of any career, including careers saved before. Restart the game after saving.</p>` },
    { id: "progression", title: "Career: rating changes", tags: "progression ratings age improve decline", body: `
      <p>With <b>Driver ratings change with age</b> on, young drivers improve each off-season until the age you set, and veterans decline from another age. "Ups and downs" adds randomness, and "Results count" lets a good or bad season push ratings. "Human players' drivers too" applies it to your own driver as well.</p>
      <p>The changes are kept with the career. Starting a new career begins from the drivers' original ratings.</p>` },
    { id: "pool", title: "Career: rookie pool and Busch drivers", tags: "rookie pool remove busch stay promote coy gibbs", body: `
      <p><b>The game's rookie pool</b>: the game's own fill-in drivers that a career's silly season picks rookies from. Untick a driver to keep him out of careers; he still races in quick races and seasons. Drivers already promoted in a saved career stay where they are.</p>
      <p><b>Busch drivers who stay in Busch</b>: untick a Busch driver and he's never moved up to Cup, but still races and retires as usual. This needs "Use these settings" on.</p>
      <p>Order when a Cup seat opens: Busch drivers move up first. Rookies from the pool fill what's left.</p>` },
    { id: "sponsors", title: "Sponsors", tags: "sponsor paint scheme no numbers logo decal create-a-car sign sponsors uniform", body: `
      <p>The ${go("sponsors")} has two parts.</p>
      <h4>Sponsor list (your own sponsors in the game)</h4>
      <p>Adds sponsors to the game's own list. They show up in <b>Create-A-Car</b> and in a career's <b>Sign Sponsors</b>, for all five decal spots on your car, next to the game's sponsors.</p>
      <ul><li>Each needs a <b>name</b> and a <b>logo</b>. A PNG with a transparent background works best; a picture on a plain background has that colour cut away.</li>
        <li>On the car the game draws decals in the car's two decal colours, so the decals are made from the logo's light and dark parts. Add a simpler <b>decal picture</b> if the logo doesn't come out well. The preview shows the result.</li>
        <li><b>Level</b>: bigger sponsors pay more and are offered once your career earns them (levels 0–1 from the start).</li>
        <li>Up to 32 added sponsors.</li></ul>
      <h4>Sponsor paint schemes (for career teams)</h4>
      <p>Paint schemes <b>without car numbers</b>. The game draws the number of whichever car carries the scheme, in the font and colours you pick. A paint fits only its own body, so add one picture per make. Drag the yellow boxes to set where the number goes. Optionally add pit crew uniforms.</p>
      <p>With "Sponsors change teams" on in the Career tab, these sponsors sign with teams in the off-season. Big sponsors go to prestigious teams.</p>` },
    { id: "tracks", title: "Tracks and track packs", tags: "track pack nr2003 gltf blender glb object library new layout physics", body: `
      <p>The ${go("tracks")}:</p>
      <ul>
        <li><b>Track packs</b>: a 3D model of a track (glTF / .glb). It can replace a track's scenery or be a whole new track with its own name, laps, physics and racing lines. "Start from the game's model" exports a track from your copy of the game to edit in Blender.</li>
        <li><b>NR2003 track to glTF</b>: converts a NASCAR Racing 2003 track folder (with the optional shared objects folder) into a track pack, including pit road, racing lines and the scoring pylon.</li>
        <li><b>Object library</b>: track-side objects (pit carts, towers, signs, lights, buildings…) as separate .glb files to place in a track's scenery.</li>
      </ul>
      <p>When a pack <b>replaces</b> a track, Ctrl-click to pick more than one: day and night versions are separate. Added tracks can be put in schedules on the ${go("sched")}.</p>` },
    { id: "schedules", title: "Schedules", tags: "schedule season races 12 24 36 add remove reorder", body: `
      <p>The game's Season and Career settings offer three schedules ("12 / 24 / 36 Races"). On the ${go("sched")} you can edit them: add any race (including the fantasy tracks and tracks added by track packs), remove races and reorder them. The Shootout and All-Star races are exhibitions and don't give points.</p>
      <p>Changes apply to seasons and careers started afterwards.</p>` },
    { id: "textures", title: "Upscaled pictures and overrides", tags: "upscale textures ai model esrgan portraits photos fonts export png override python pytorch", body: `
      <ul>
        <li><b>Textures tab</b>: upscale the game's pictures (portraits, photos, menus, HUD and fonts). Without a model they're resized smoothly. With an AI model (.pth or .safetensors files, e.g. from openmodeldb.info, in the models folder) they come out sharper. Export the originals to PNG to edit them by hand.</li>
        <li><b>Overrides tab</b>: shows the replacement pictures in use. A PNG with the same name in the override folder replaces the original from the next game start.</li>
        <li><b>Setup tab</b>: installs the Python parts upscaling needs. AI upscaling also needs PyTorch: the CUDA build for an NVIDIA card, otherwise it runs slowly on the CPU.</li>
      </ul>` },
    { id: "online", title: "Online races", tags: "online host join relay multiplayer network", body: `
      <p>On the ${go("play")}, set <b>Online</b> to "Host a race" or "Join a race" and enter your name.</p>
      <ul><li><b>Host</b>: others join using your address and the online port. Without a relay server they need to reach your computer directly (same network, or the port forwarded on your router).</li>
        <li><b>Join</b>: enter the host's address (or pick a listed race) and the online port.</li>
        <li><b>Relay server</b> (optional): connect through a relay when a direct connection isn't possible.</li></ul>` },
    { id: "saves", title: "Saves and where files live", tags: "save folder files backup udata roster presets location", body: `
      <ul>
        <li><b>Main</b> preset: saves in <code>save/</code> and your set-up in <code>roster/</code>, inside the game folder.</li>
        <li>Other presets: <code>presets/&lt;name&gt;/save/</code> and <code>presets/&lt;name&gt;/roster/</code>.</li>
        <li>To back up a preset, copy its folder while the game is stopped.</li>
        <li>Saves work like the Xbox's: profiles, seasons, careers and system settings each sit in their own folder under <code>save/E/UDATA</code>.</li>
        <li>If the game can't save, it writes the reason to <code>fs.log</code> in that preset's save folder.</li>
      </ul>` },
    { id: "trouble", title: "Troubleshooting", tags: "problem error slow stuck unable to save crash help fix", body: `
      <ul>
        <li><b>A change doesn't show in the game</b>: stop and start the game again. Roster and schedule changes only reach seasons and careers started after them.</li>
        <li><b>"Unable to save … to hard disk"</b>: check <code>fs.log</code> in the preset's save folder. The game folder must be writable (not inside a protected folder like Program Files).</li>
        <li><b>The game asks to enable autosave every time</b>: answer it once with the latest version; it then saves its system settings.</li>
        <li><b>Slow or choppy</b>: lower the render scale and antialiasing in the game page's Graphics panel.</li>
        <li><b>A controller doesn't respond</b>: press a button on it once with the game tab focused (browsers only show pads after a press).</li>
        <li><b>The game stopped by itself</b>: the log box on the Play tab shows the last messages.</li>
        <li><b>Can't switch preset</b>: stop the game first.</li>
      </ul>` },
  ];

  root.innerHTML = `<div class="card"><h2>Help</h2>
    <div class="row"><input id="hq" placeholder="Search help (e.g. sponsor, unlock, wheel)" style="flex:1;min-width:220px"></div>
    <div class="hwrap"><nav class="htoc" id="htoc"></nav><div id="hbody"></div></div></div>`;
  const css = document.createElement("style");
  css.textContent = `#help .hwrap{display:grid;grid-template-columns:220px 1fr;gap:20px;margin-top:14px}
  #help .htoc{display:flex;flex-direction:column;gap:2px;padding:0;border:0;position:sticky;top:10px;align-self:start}
  #help .htoc a{color:var(--dim);text-decoration:none;padding:5px 8px;border-radius:6px}#help .htoc a:hover,#help .htoc a.on{color:var(--text);background:#0b0e13}
  #help .htopic{border-top:1px solid var(--line);padding:6px 0 10px}#help .htopic:first-child{border-top:0}
  #help .htopic h3{font-size:15px;margin:10px 0 6px;color:var(--accent)}#help h4{margin:12px 0 4px;font-size:13.5px}
  #help p,#help li{color:#c9d1d9}#help ul,#help ol{padding-left:20px;margin:6px 0}#help li{margin:3px 0}
  #help table{max-width:520px;margin:4px 0}#help kbd{background:#0b0e13;border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;padding:0 5px;font:12px ui-monospace,Consolas,monospace}
  @media (max-width:700px){#help .hwrap{grid-template-columns:1fr}#help .htoc{position:static;flex-direction:row;flex-wrap:wrap}}`;
  document.head.appendChild(css);
  const toc = root.querySelector("#htoc"), body = root.querySelector("#hbody");
  toc.innerHTML = T.map(t => `<a href="#" data-topic="${t.id}">${t.title}</a>`).join("");
  body.innerHTML = T.map(t => `<div class="htopic" id="h_${t.id}"><h3>${t.title}</h3>${t.body}</div>`).join("");
  const text = new Map(T.map(t => [t.id, (t.title + " " + t.tags + " " + root.querySelector("#h_" + t.id).textContent).toLowerCase()]));
  root.querySelector("#hq").oninput = e => { const q = e.target.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    for (const t of T) { const hit = q.every(w => text.get(t.id).includes(w)); root.querySelector("#h_" + t.id).style.display = hit ? "" : "none"; toc.querySelector(`[data-topic="${t.id}"]`).style.display = hit ? "" : "none"; } };
  root.addEventListener("click", e => {
    const a = e.target.closest("a[data-topic], a[data-go]"); if (!a) return; e.preventDefault();
    if (a.dataset.go) { document.querySelector(`nav button[data-tab="${a.dataset.go}"]`)?.click(); window.scrollTo(0, 0); return; }
    root.querySelector("#hq").value = ""; root.querySelector("#hq").oninput({ target: { value: "" } });
    toc.querySelectorAll("a").forEach(x => x.classList.toggle("on", x === toc.querySelector(`[data-topic="${a.dataset.topic}"]`)));
    root.querySelector("#h_" + a.dataset.topic)?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
})();
