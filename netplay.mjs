// netplay.mjs — online racing: one player hosts, the others join by address; every machine runs its own race and
// shows the other players' cars in place of AI cars.
//
// Step 2: the host's race is everyone's race, and the starts are shared.
//  - Before the host starts, each client picks its driver (Race Now driver select) and reports the car (CRID). The
//    host's field fill (0x139B0: CTYP order, then DRVR.DPOP) is made to take those cars: for the call their CTYP is 1
//    and their drivers' DPOP 1000 (restored after). So each remote player's own car is an AI car in the host's race.
//  - After the host's qualifying (0xB1D20 fills QUAL; the grid follows QUAL by LAPT) the host sends the race card:
//    GINF RAID/TRID, the shared settings of its Race Now profile (SGPP: difficulty, yellows, damage, race length,
//    pit / fuel...; not ASSI, the driving aids), the field (CRIDs of the 43 cars) and QUAL (driver, lap time).
//  - A client then picks any track: at its own 0x139B0 the card's race and settings are put in GINF / SGPP, and only
//    the card's cars keep CCRC = 1 (restored after), so its field is the host's (its own car human, the host's car
//    AI); after its 0xB1D20 its QUAL becomes the card's, so the grid is the same everywhere. Its SGPP comes back
//    when the race ends.
//  - Starts: the race waits for A at the pre-race screen (3/18; A starts the pace laps) and at the grid intro (3/10;
//    A hands the car over and the race goes green ~3 s later). While others are connected, A / START there is held
//    back on every machine (Pads.filter); when the host presses it and everyone has been on that screen for 1.5 s
//    (or 2 minutes after the host pressed), the host sends "go" and every machine presses A at once (the host ~half the slowest ping
//    later, so the presses line up).
//  - Race control is the host's: its Race stage changes go out, and a client brings out the caution and gives the
//    start's and restarts' green when the host does (its own caution / green checks answer "no" otherwise); laps are
//    each car's owner's count, and the running positions (and so the results) are the host's.
//  - The AI field is the host's: from the pace laps on, the host sends the bodies of all its AI cars (by car number)
//    every 4th tick (~15 per second, 4.8 KB each), and clients drive their AI cars from them the same way as the
//    other players' cars. Each machine's own race logic (scoring, flags) runs on those positions.
//
// How a remote car is shown. Each car has a rigid body in the physics (car record [0x2951E0 + car * 0x5C0] -> 0x120
// bytes; player 0 is car 0). Body layout as far as needed here (floats):
//   +0x00  vec3 (momentum-like: moves with the car, ~1.8 x speed)     +0x10  vec3 angular rate
//   +0x20  vec3 centre of mass                                        +0x30  (+0x34 / +0x38 per-car constants: kept)
//   +0x40  4x4 matrix: rows +0x40 / +0x50 / +0x60 = orientation, +0x70 = position, +0x7C = 1
//   +0x80  a copy of the +0x40 matrix (both are written)
// AI cars use the same bodies, and what is written there sticks: the race tracker derives the car's track-relative
// race entry (segment, distance, lane, laps) from the body, and the AI does not pull the car back. So a remote car is
// the AI car with that player's number (car record +0x36 = CARS.NSID), whose body is overwritten after every game
// tick (gamecode tick -> afterTick) with the remote player's body, interpolated a little in the past (DELAY ms)
// between the snapshots received; the next tick's physics integrates from those values before the frame is drawn.
// Without a card (a client that started before the host) the cars do not line up: the client then trades places
// with car j (its player id) as in step 1, and the host is shown in slot j.
//
// Wire format (WebSocket, ws-lite.mjs): JSON text for control ({t: hello | welcome | players | me | card | want | go
// | ping | pong | rtt | bye}), binary for car states: u8 1, u8 player id, u8 race state, u8 0, f64 sender game time
// (ms), 28 f32 (body +0x00..+0x2C and +0x40..+0x7C), u16 laps = 126 bytes, ~30 per second while the sender's car races. The
// host forwards every client's states to the other clients.

import { createServer } from "node:http";
import { acceptWebSocket, connectWebSocket } from "./ws-lite.mjs";
import { UdpEndpoint, UdpLink, newNonce } from "./netudp.mjs";
import { upnpMap } from "./upnp.mjs";

export const NET_PROTOCOL = 3;
// how long the two sides keep punching: long enough to ride out a host busy loading for a few seconds
const PUNCH_FOR = 10000;
export const NET_DEFAULT_PORT = 27104, NET_RELAY_PORT = 27105;
const REC = 0x2951e0, REC_SIZE = 0x5c0, ENTRIES = 0x2f32d8, ENTRY_SIZE = 0x68, MAX_PLAYERS = 8, PROFILE_SLOT = 0x21db74;
const RACING = new Set([3, 4, 5]);              // human driving (3/4), pit road (5); the pit stall (6) once racing
const STATE_BYTES = 12 + 28 * 4 + 2, FIELD_CAR = 2 + 2 + 28 * 4;   // + u16 laps (race entry +0x5C)
const SHARED_SGPP = ["MAIC", "SCHE", "DIFF", "SDIF", "SYEL", "SDAM", "SRLN", "SCMP", "SPIT", "SSNS", "STPS"];
const RACE_PROC = 0x2f3990, CAUTION_CHECK = 0xad6b0, RESTART_CHECK = 0xb6c10, ST_START = 0x1c, ST_RACE = 0x1d, ST_CAUTION = 0x21, ST_RESTART = 0x27;
const SET_POSITION = 0xbafc0, FIELD_FILL = 0x139b0, QUALIFYING = 0xb1d20, GO_TIMEOUT = 120000, FIELD_EVERY = 4, SETTLE = 1500;

export class NetPlay {
  constructor(game, { vm = null, log = s => console.log(s), name = "Player", delay = +(process.env.NT04_NET_DELAY ?? 100), sendEvery = 2 } = {}) {
    this.g = game; this.m = game.mem; this.vm = vm; this.log = s => log(`netplay: ${s}`); this.name = String(name).slice(0, 24);
    this.delay = delay; this.sendEvery = sendEvery;
    this.role = null; this.id = -1; this.players = new Map();   // id -> { id, name, crid, ph, buf: [snapshots], off, last, rtt }
    this.ticks = 0; this.live = false; this.started = false; this.swapped = false; this.raceKey = 0; this.status = "off";
    this.card = null; this.applied = null; this.warnings = []; this.phase = "menu"; this.want = {}; this.inject = null; this.wantAt = {};
    this.stats = { sent: 0, recv: 0, applied: 0 };
    game.afterTick = () => this.tick();
    if (game.pads) game.pads.filter = (port, p) => this.padFilter(port, p);
    this.wrap(FIELD_FILL, () => this.beforeFill(), () => this.afterFill());
    this.wrap(QUALIFYING, null, () => this.afterQualifying());
    // race control on clients in the host's race: a caution comes out (0xAD6B0, asked in Race stage 0x1D) and the
    // field goes green again (0xB6C10, asked in stage 0x27 Restart) when the host's race does, not by itself
    this.wrap(CAUTION_CHECK, null, null, v => !this.ruled() ? v : this.take("caution"));
    // (0xB6C10 also gives the start's green in stage 0x1C, after the grid intro)
    // running positions: every write of a car's position (0xBAFC0: eax = race entry, dx = position) takes the host's
    // number for that car; positions follow a distance the game keeps itself, which did not match between machines
    // (an AI car 31st on the client and 12th on the host all race), and the results follow the positions
    { const g = this.g, prev = g.hooks.get(SET_POSITION);
      g.hooks.set(SET_POSITION, (c, ret) => {
        if (this.ruled() && this.hostPos) { const n = this.numberOfEntry(c.r[0] >>> 0), q = n == null ? undefined : this.hostPos.get(n); if (q != null) c.r[2] = ((c.r[2] & 0xffff0000) | q) >>> 0; }
        if (prev) return prev(c, ret); c.push(ret); c.passThrough = SET_POSITION; c.hookReturn = SET_POSITION; return undefined;
      }); }
    this.wrap(RESTART_CHECK, null, null, v => { if (!this.ruled()) return v; const st = this.raceStage(); return st === ST_START ? this.take("start") : st === ST_RESTART ? this.take("green") : v; });
  }
  // run `before` / `after` around a game function (no arguments), keeping a hook already there (qualifying.mjs)
  wrap(a, before, after, result) {
    const g = this.g, prev = g.hooks.get(a);
    g.hooks.set(a, (c, ret) => {
      try { before?.(); } catch (e) { this.log(`0x${a.toString(16)} (before): ${e.message}`); }
      // (a hook already there runs the function and returns its value; one that passes the call through instead would
      // run it after us: then `after` / `result` come too early, which none of the hooks wrapped here does)
      let v; if (prev) v = prev(c, ret); else { c.passThrough = a; v = g.nested(a, []); }
      if (v === undefined) return v;
      try { after?.(); } catch (e) { this.log(`0x${a.toString(16)} (after): ${e.message}`); }
      if (result) try { v = result(v); } catch (e) { this.log(`0x${a.toString(16)} (result): ${e.message}`); }
      return v;
    });
  }
  // the Race process's stage (group 2): 0x1D racing, 0x21 caution cooldown, 0x22 pace car, 0x23 wreck replay,
  // 0x24 pitting, 0x25 pacing after the pits, 0x27 restart, 0x28 finish under caution, 0x29 checkered (0x175020)
  raceStage() { const grp = this.m.r32(RACE_PROC + 0x14 + 2 * 4) >>> 0; if (!grp || !this.m.r32(ENTRIES)) return -1; return this.m.r8(grp + 0x20) ? this.m.r32(grp + 0x1c) : this.m.r32(grp + 8); }
  ruled() { return this.role === "client" && !!this.applied && !!this.ws; }
  take(what) { if (this.flagPending?.[what]) { this.flagPending[what] = false; this.log(`${what === "caution" ? "caution" : what === "start" ? "start" : "green flag"} from the host`); return 1; } return 0; }
  T(name) { return this.g.db?.tables.get(name)?.rows ?? []; }
  send(o) { const s = JSON.stringify(o); if (this.role === "host") this.broadcast(s); else this.ws?.send(s); }
  warn(s) { if (!this.warnings.includes(s)) { this.warnings.push(s); this.log(s); } if (this.warnings.length > 6) this.warnings.shift(); }

  // ------------------------------------------------------------------ sessions
  host({ port = NET_DEFAULT_PORT, bind = "0.0.0.0" } = {}) {
    this.role = "host"; this.id = 0; this.clients = new Map(); this.players.set(0, this.player(0, this.name));
    return new Promise((resolve, reject) => {
      const srv = this.server = createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(this.info())); });
      srv.on("upgrade", (req, socket) => {
        if (new URL(req.url, "http://x").pathname !== "/nt04") { socket.destroy(); return; }
        let c = null; const ws = acceptWebSocket(req, socket, msg => c.message(msg), () => c.close()); c = this.connection(ws);
      });
      srv.on("error", e => { this.status = `error: ${e.message}`; reject(e); });
      srv.listen(port, bind, () => {
        this.status = `hosting on port ${port}`; this.log(this.status); resolve(port);
        // ask the router to forward the port (UPnP), so others can join without port forwarding
        if (process.env.NT04_UPNP !== "0") upnpMap({ port, protocol: "TCP", log: s => this.log(s) }).then(m => {
          this.upnp = m;
          if (m.ok) { this.external = `${m.external}:${port}`; this.status = `hosting on port ${port}; others join with ${this.external} (the router opened the port)`; }
          else this.status = `hosting on port ${port}; the router did not open it (${m.reason}): others outside your network need it forwarded, or use a relay`;
          this.log(this.status);
        });
      });
    });
  }
  // Host through a relay (relay.mjs): the host connects out to the relay, which lists the race and passes the joiners'
  // connections to it over that one link, so nobody forwards a port. Link frames from the relay: text = relay control
  // ({t: race, id} once registered; {t: bye, why}); binary = u8 kind (1 text message, 2 binary message, 3 joiner
  // connected, 4 joiner gone), u16 connection, payload. To the relay: u8 kind (1 text, 2 binary, 5 close connection,
  // 6 to every connection but the one given), u16 connection, payload; text = race info for the lobby list.
  hostVia(relay) {
    this.role = "host"; this.id = 0; this.clients = new Map(); this.players.set(0, this.player(0, this.name)); this.viaRelay = true;
    const base = /^ws:\/\//.test(relay) ? relay : `ws://${relay.includes(":") ? relay : `${relay}:${NET_RELAY_PORT}`}`;
    const url = `${base.replace(/\/$/, "")}/host?name=${encodeURIComponent(this.name)}&v=${NET_PROTOCOL}`;
    const conns = new Map(); let registered = false;
    return new Promise((resolve, reject) => {
      this.status = `connecting to the relay ${base}`;
      const frame = (kind, conn, payload) => { const p = typeof payload === "string" ? Buffer.from(payload) : payload ?? Buffer.alloc(0); const b = Buffer.alloc(3 + p.length); b[0] = kind; b.writeUInt16LE(conn, 1); p.copy(b, 3); this.relayWs?.send(b); };
      this.relayFrame = frame;
      connectWebSocket(url, {
        onOpen: ws => { this.relayWs = ws; },
        onMessage: msg => {
          if (typeof msg === "string") {
            let o; try { o = JSON.parse(msg); } catch { return; }
            if (o.t === "race") { registered = true; this.raceId = o.id; this.startDirect(base, o).catch(e => this.log(`direct links: ${e.message}`)); this.status = `hosting race ${o.id} on the relay ${base}`; this.log(this.status); this.lobbyTimer = setInterval(() => this.relayWs?.send(JSON.stringify(this.lobbyInfo())), 3000); this.relayWs.send(JSON.stringify(this.lobbyInfo())); resolve(o.id); }
            else if (o.t === "bye") { this.status = `relay: ${o.why}`; this.log(this.status); reject(new Error(o.why)); }
            return;
          }
          if (msg.length < 3) return;
          const kind = msg[0], conn = msg.readUInt16LE(1), body = msg.subarray(3);
          if (kind === 3) {
            const vws = { conn, open: true, get buffered() { return this.link?.buffered ?? 0; }, link: this.relayWs,
              send: d => { if (vws.open) frame(typeof d === "string" ? 1 : 2, conn, typeof d === "string" ? d : Buffer.from(d.buffer ?? d, d.byteOffset ?? 0, d.byteLength ?? d.length)); },
              close: () => { if (vws.open) { vws.open = false; frame(5, conn); } } };
            conns.set(conn, { vws, c: this.connection(vws) });
          } else if (kind === 1 || kind === 2) conns.get(conn)?.c.message(kind === 1 ? body.toString("utf8") : Buffer.from(body));
          else if (kind === 4) { const e = conns.get(conn); if (e) { e.vws.open = false; conns.delete(conn); e.c.close(); } }
        },
        onClose: err => {
          clearInterval(this.lobbyTimer); this.relayWs = null;
          for (const e of conns.values()) { e.vws.open = false; e.c.close(); } conns.clear();
          this.status = err ? `relay: ${err.message}` : "lost the relay"; this.log(this.status); reject(err ?? new Error("lost the relay"));
          if (registered && this.role === "host") this.onDisconnect?.();
        },
      }).catch(reject);
    });
  }
  // host side of direct links: one UDP socket registered with the relay every 3 s; the relay sends "peer" when a
  // joiner wants in, and both punch. With UPnP the router also forwards that UDP port, which helps routers that
  // give each destination its own outside port (the joiner is then given that address too)
  async startDirect(base, race) {
    if (process.env.NT04_NET_P2P === "0" || !race.key) return;
    const u = new URL(base.replace(/^ws:/, "http:")), rhost = u.hostname, rport = +(race.udp || u.port || NET_RELAY_PORT);
    this.ep?.close(); clearInterval(this.regTimer);
    const ep = this.ep = new UdpEndpoint({ log: s => this.log(s), onSignal: o => {
      if (o.t !== "peer") return;
      ep.punch(o.addr, o.port, o.nonce, PUNCH_FOR).then(link => {
        if (!link) { this.log(`no direct link to ${o.addr}:${o.port} (it joins through the relay)`); return; }
        const c = this.connection(link); link.onMessage = m => c.message(m); link.onClose = () => c.close();
        this.log(`direct link from ${link.remote}`);
      });
    } });
    const uport = await ep.bind(0);
    let alt = null;
    if (process.env.NT04_UPNP !== "0") upnpMap({ port: uport, protocol: "UDP", log: s => this.log(s) }).then(m => { this.upnp = m; if (m.ok) alt = { addr: m.external, port: uport }; });
    const reg = () => ep.signal({ t: "reg", race: race.id, key: race.key, alt }, rhost, rport);
    reg(); this.regTimer = setInterval(reg, 3000); this.regTimer.unref?.();
  }
  lobbyInfo() { return { t: "info", name: this.name, race: this.card ? this.cardText(this.card) : null, phase: this.phase, players: [...this.players.values()].map(p => p.name), full: this.players.size >= MAX_PLAYERS }; }
  // to every joiner (but one): through the relay one frame, which it copies to each
  broadcast(data, except = -1) {
    if (this.viaRelay && this.relayWs) {
      const skip = except > 0 ? this.clients.get(except)?.conn ?? 0xffff : 0xffff, p = typeof data === "string" ? Buffer.from(data) : data;
      const b = Buffer.alloc(4 + p.length); b[0] = 6; b.writeUInt16LE(skip, 1); b[3] = typeof data === "string" ? 1 : 2; p.copy(b, 4); this.relayWs.send(b);
      for (const [id, ws] of this.clients) if (id !== except && ws instanceof UdpLink) ws.send(data);   // direct links
      return;
    }
    for (const [id, ws] of this.clients) if (id !== except) ws.send(data);
  }
  // one joiner's connection (direct WebSocket, or a joiner behind the relay)
  connection(ws) {
    let id = -1;
    return {
      message: msg => {
        if (typeof msg !== "string") { if (id > 0) this.onState(msg, id); return; }
        let o; try { o = JSON.parse(msg); } catch { return; }
        const p = this.players.get(id);
        if (o.t === "hello") {
          if (o.v !== NET_PROTOCOL) { ws.send(JSON.stringify({ t: "bye", why: `the host runs online version ${NET_PROTOCOL}, you have ${o.v}: update the game` })); ws.close(); return; }
          for (id = 1; this.players.has(id); id++);
          if (id >= MAX_PLAYERS) { ws.send(JSON.stringify({ t: "bye", why: "the race is full" })); ws.close(); id = -1; return; }
          this.players.set(id, this.player(id, o.name)); this.clients.set(id, ws);
          ws.send(JSON.stringify({ t: "welcome", id, v: NET_PROTOCOL, card: this.card }));
          this.log(`${o.name} joined as player ${id}`); this.broadcastPlayers();
        } else if (o.t === "me" && p) { if (p.ph !== o.ph) p.phAt = Date.now(); p.crid = o.crid ?? null; p.ph = o.ph ?? "menu"; this.broadcastPlayers(); }
        else if (o.t === "want" && p) p.want = o.ph;
        else if (o.t === "fin" && p) { p.fin = o.ms; p.finDone = false; }
        else if (o.t === "ping") ws.send(JSON.stringify({ t: "pong", s: o.s }));
        else if (o.t === "rtt" && p) p.rtt = o.ms;
      },
      close: () => { if (id > 0) { this.log(`${this.players.get(id)?.name} left`); this.players.delete(id); this.clients.delete(id); this.broadcastPlayers(); id = -1; } },
    };
  }
  // address: the host's address[:port], or with relay given, the race's id on that relay (relay.mjs lists them)
  join(address, { port = NET_DEFAULT_PORT, relay = null } = {}) {
    this.role = "client";
    const relayBase = relay && (/^ws:\/\//.test(relay) ? relay : `ws://${relay.includes(":") ? relay : `${relay}:${NET_RELAY_PORT}`}`).replace(/\/$/, "");
    const url = relay ? `${relayBase}/join/${encodeURIComponent(address)}` : /^ws:\/\//.test(address) ? address : `ws://${address.includes(":") ? address : `${address}:${port}`}/nt04`;
    return new Promise((resolve, reject) => {
      this.status = `connecting to ${url}`;
      const handlers = {
        onOpen: ws => { this.ws = ws; ws.send(JSON.stringify({ t: "hello", v: NET_PROTOCOL, name: this.name })); },
        onMessage: msg => {
          if (typeof msg !== "string") { this.onState(msg, -1); return; }
          let o; try { o = JSON.parse(msg); } catch { return; }
          if (o.t === "welcome") {
            this.id = o.id; this.card = o.card ?? null; this.status = `joined as player ${o.id}`; this.log(this.status); this.sentMe = null;
            this.pinger = setInterval(() => this.ws?.send(JSON.stringify({ t: "ping", s: performance.now() })), 2000); resolve(o.id);
          }
          else if (o.t === "players") this.setPlayers(o.list);
          else if (o.t === "card") { this.card = o.card; this.log(`the host's race: ${this.cardText(o.card)}`); }
          else if (o.t === "go") this.go(o.ph, 0);
          else if (o.t === "stage") this.hostStage(o);
          else if (o.t === "finish") this.hostFinish = o.order;
          else if (o.t === "pong") { this.rtt = performance.now() - o.s; this.ws?.send(JSON.stringify({ t: "rtt", ms: Math.round(this.rtt) })); }
          else if (o.t === "bye") { this.status = `refused: ${o.why}`; this.log(this.status); reject(new Error(o.why)); }
        },
        onClose: err => { clearInterval(this.pinger); const was = this.id >= 0; this.status = err ? `error: ${err.message}` : "disconnected"; this.log(this.status); this.ws = null; this.players.clear(); this.id = -1; this.ep?.close(); this.ep = null; reject(err ?? new Error("disconnected")); if (was && this.role === "client") this.onDisconnect?.(); },
      };
      // through a relay: a direct UDP link to the host first (hole punching), the relayed WebSocket if that fails
      const viaWs = () => connectWebSocket(url, handlers).catch(reject);
      if (!relay || process.env.NT04_NET_P2P === "0") { viaWs(); return; }
      this.directLink(relayBase, address).then(link => {
        if (!link) { this.log("no direct link to the host: racing through the relay"); viaWs(); return; }
        this.log(`direct link to the host ${link.remote}`); this.transport = "direct";
        link.onMessage = handlers.onMessage; link.onClose = () => handlers.onClose(); handlers.onOpen(link);
      }).catch(e => { this.log(`direct link: ${e.message}`); viaWs(); });
    });
  }
  // ask the relay (UDP, same port) to introduce us to the host of race `id`, then punch through to it
  async directLink(relayBase, id) {
    const u = new URL(relayBase.replace(/^ws:/, "http:")), rhost = u.hostname, rport = +(u.port || NET_RELAY_PORT);
    const nonce = newNonce(); let peer = null, answered = false;
    const ep = this.ep = new UdpEndpoint({ log: s => this.log(s), onSignal: o => { if (o.nonce !== nonce) return; answered = true; if (o.t === "peer") peer = o; } });
    await ep.bind(0);
    for (let i = 0; i < 48 && !answered; i++) { if (i % 8 === 0) ep.signal({ t: "p2p", race: id, nonce }, rhost, rport); await new Promise(r => setTimeout(r, 50)); }
    if (!peer) { ep.close(); this.ep = null; return null; }
    const tries = [ep.punch(peer.addr, peer.port, nonce, PUNCH_FOR)]; if (peer.alt) tries.push(ep.punch(peer.alt.addr, peer.alt.port, nonce, PUNCH_FOR));
    const link = await new Promise(res => { let left = tries.length; for (const t of tries) t.then(l => { if (l) res(l); else if (--left === 0) res(null); }); });
    if (!link) { ep.close(); this.ep = null; }
    return link;
  }
  leave() {
    clearInterval(this.pinger); const role = this.role; this.role = null;
    if (role === "host") { for (const ws of this.clients.values()) { ws.send(JSON.stringify({ t: "bye", why: "the host closed the race" })); ws.close(); } this.server?.close(); clearInterval(this.lobbyTimer); this.relayWs?.close(); this.viaRelay = false; }
    else this.ws?.close();
    this.ep?.close(); this.ep = null; this.upnp?.close(); this.upnp = null; clearInterval(this.regTimer);
    this.id = -1; this.players.clear(); this.status = "off"; this.live = false;
  }
  player(id, name) { return { id, name: String(name ?? `Player ${id}`).slice(0, 24), crid: null, ph: "menu", buf: [], off: null }; }
  broadcastPlayers() { const list = [...this.players.values()].map(p => ({ id: p.id, name: p.name, crid: p.crid, ph: p.ph })); this.broadcast(JSON.stringify({ t: "players", list })); }
  setPlayers(list) {
    const keep = new Set(list.map(p => p.id));
    for (const id of [...this.players.keys()]) if (!keep.has(id)) this.players.delete(id);
    for (const p of list) { const q = this.players.get(p.id) ?? this.players.set(p.id, this.player(p.id, p.name)).get(p.id); if (p.id !== this.id) { q.crid = p.crid; q.ph = p.ph; } }
  }
  carText(crid) {
    const c = this.T("CARS").find(r => r.CRID === crid); if (!c) return crid == null ? "no car picked yet" : `car ${crid} (not in this game's roster)`;
    const d = this.T("DRVR").find(r => r.DRID === c.DRID); return `#${c.CNMD ?? c.CNUM} ${d ? `${d.FNAM ?? ""} ${d.LNAM ?? ""}`.trim() : ""}`.trim();
  }
  cardText(card) {
    if (!card) return "none yet";
    const race = this.T("RACE").find(r => r.RAID === card.raid), track = this.T("TRCK").find(t => t.TRID === card.trid);
    return `${race?.RNAM ?? `race ${card.raid}`}${track?.TNAM ? ` at ${track.TNAM}` : ""}, ${card.field.length} cars`;
  }
  info() {
    const ms = this.g.ms ?? 0;
    return { game: "nt04", v: NET_PROTOCOL, role: this.role, id: this.id, status: this.status, live: this.live, phase: this.phase, stage: this.lastStage ?? -1,
      race: this.card ? this.cardText(this.card) : null, shared: !!this.applied || (this.role === "host" && !!this.card), warnings: this.warnings,
      waiting: this.waitingText(),
      players: [...this.players.values()].map(p => ({ id: p.id, name: p.name, car: this.carText(p.id === this.id ? this.myCar() : p.crid), phase: p.id === this.id ? this.phase : p.ph,
        slot: p.id === this.id ? 0 : this.slotOf(p), rtt: p.id === this.id ? null : this.role === "host" ? p.rtt ?? null : p.id === 0 ? Math.round(this.rtt ?? 0) || null : null,
        receiving: p.id !== this.id && p.last !== undefined && ms - p.lastLocal < 1000 })) };
  }
  // our human car (CARS.PLID 0)
  myCar() { return this.T("CARS").find(c => c.PLID === 0)?.CRID ?? null; }

  // ------------------------------------------------------------------ the race card (host) and its use (clients)
  beforeFill() {
    this.restore = []; const cars = this.T("CARS"), drivers = this.T("DRVR"), save = (row, k) => this.restore.push([row, k, row[k]]);
    if (this.role === "host") {
      // the clients' cars must be in the field: first in the fill order for this call
      const mine = this.myCar();
      for (const p of this.players.values()) {
        if (p.id === 0 || p.crid == null) continue;
        if (p.crid === mine) { this.warn(`${p.name} picked the same car as you (${this.carText(mine)}): they are not in your race; one of you picks another driver`); continue; }
        const c = cars.find(r => r.CRID === p.crid); if (!c) { this.warn(`${p.name}'s car ${p.crid} is not in your roster`); continue; }
        save(c, "CTYP"); save(c, "CCRC"); c.CTYP = 1; c.CCRC = 1;
        const d = drivers.find(r => r.DRID === c.DRID); if (d) { save(d, "DPOP"); d.DPOP = 1000; }
      }
      this.g.db.invalidate?.(); return;
    }
    if (this.role !== "client" || !this.card) { this.applied = null; if (this.role === "client") this.warn("the host has not started a race yet: this race is your own (the host starts first, then you)"); return; }
    const card = this.card, mine = this.myCar();
    if (mine === card.human) { this.warn(`you picked the host's car (${this.carText(mine)}): pick another driver; this race is not shared`); this.applied = null; return; }
    if (!card.field.includes(mine)) this.warn(`your car (${this.carText(mine)}) is not in the host's race (the host started before you picked it): the race is shared, but the others will not see you`);
    const ginf = this.T("GINF")[0]; if (ginf) { save(ginf, "RAID"); save(ginf, "TRID"); ginf.RAID = card.raid; ginf.TRID = card.trid; }
    const prid = this.m.r32(PROFILE_SLOT), sg = this.T("SGPP").find(r => r.PRID === prid) ?? this.T("SGPP")[0];
    this.sgppBack = sg ? Object.fromEntries(SHARED_SGPP.filter(k => k in sg).map(k => [k, sg[k]])) : null; this.sgppRow = sg;
    if (sg) for (const [k, v] of Object.entries(card.sgpp)) if (k in sg) sg[k] = v;
    const field = new Set(card.field), missing = card.field.filter(id => !cars.some(c => c.CRID === id));
    if (missing.length) this.warn(`${missing.length} of the host's cars are not in your roster (${missing.slice(0, 5).join(", ")}): your rosters differ`);
    for (const c of cars) { save(c, "CCRC"); c.CCRC = field.has(c.CRID) ? 1 : 0; }
    this.restore = this.restore.filter(([row, k]) => k === "CCRC");   // GINF / SGPP stay for the race (SGPP back after)
    this.applied = card; this.g.db.invalidate?.(); this.log(`racing the host's race: ${this.cardText(card)}`);
  }
  afterFill() { for (const [row, k, v] of (this.restore ?? []).reverse()) row[k] = v; this.restore = null; this.g.db.invalidate?.(); }
  afterQualifying() {
    if (this.role === "host") {
      const prid = this.m.r32(PROFILE_SLOT), sg = this.T("SGPP").find(r => r.PRID === prid) ?? this.T("SGPP")[0] ?? {}, ginf = this.T("GINF")[0] ?? {};
      const field = this.T("CARS").filter(c => c.PLID >= -1).map(c => c.CRID);
      this.card = { raid: ginf.RAID, trid: ginf.TRID, sgpp: Object.fromEntries(SHARED_SGPP.filter(k => k in sg).map(k => [k, sg[k]])), field, human: this.myCar(),
        qual: this.T("QUAL").map(q => [q.DRID, q.LAPT]), at: Date.now() };
      for (const p of this.players.values()) if (p.id && p.crid != null && !field.includes(p.crid)) this.warn(`${p.name}'s car did not make your field`);
      this.send({ t: "card", card: this.card }); this.log(`race card sent: ${this.cardText(this.card)}`);
    } else if (this.applied) {
      const q = this.g.db.tables.get("QUAL"); if (!q) return;
      q.rows = this.applied.qual.map(([DRID, LAPT]) => ({ DRID, LAPT })); if (q.rows.length > q.capacity) q.capacity = q.rows.length;
      this.g.db.invalidate?.();
    }
  }

  // the host's Race stage changed: a caution out (0x1D -> 0x21) or the restart's green (0x27 -> 0x1D) waits for the
  // client's own check at that point (its stage machine runs the steps in between by itself)
  hostStage(o) {
    this.hostSt = o.s; this.flagPending ??= {};
    if (o.s === ST_CAUTION && o.prev === ST_RACE) { this.flagPending.caution = true; this.flagPending.green = false; }
    if (o.s === ST_RACE && o.prev === ST_RESTART) this.flagPending.green = true;
    if (o.s === ST_RACE && o.prev === ST_START) this.flagPending.start = true;
  }

  // The finishing order is the host's. Every machine sees the others a little late (they are drawn DELAY ms in the
  // past, plus the trip over the network), so at a close finish two machines can disagree. The host orders the cars
  // by the time each took the checkered flag (car state 7 once the race stage is 0x29): its own car and the AI cars
  // by its clock; a client's car by the time the client itself saw it cross (the client sends it, "fin", in its
  // game ms), brought to the host's clock with the player's clock offset less half the ping, so the host's late view
  // of remote cars does not cost them places. The order goes out as car numbers when it changes. Client: after its
  // own checkered, every tick the running positions (race entry +0x5E u16, 0 = leader) become the host's finishers in
  // the host's order, then everyone else in this machine's order. Off (NT04_NET_FINISH=1 turns it on): the running
  // positions are the host's anyway (0xBAFC0 hook), and with them the results matched on both machines in a full test.
  finishOrder() {
    const m = this.m, t = m.r32(ENTRIES) >>> 0, rs = this.lastStage; if (!t || !(rs >= 0x29 && rs < 0x33)) return;
    const now = this.g.ms ?? 0, cars = [];
    for (let k = 0; k < 43; k++) { const idx = m.r32(REC + k * REC_SIZE + 0x0c); if (idx < 64) cars.push({ k, e: t + idx * ENTRY_SIZE, n: m.r16(REC + k * REC_SIZE + 0x36) }); }
    if (m.r32(cars[0]?.e) === 7 && !this.finSent && this.role === "client") { this.finSent = true; this.send({ t: "fin", ms: now }); }
    if (this.role === "host" && this.card) {
      this.finTimes ??= new Map(); let changed = false;
      for (const c of cars) if (m.r32(c.e) === 7 && !this.finTimes.has(c.n)) { this.finTimes.set(c.n, now); changed = true; }
      for (const p of this.players.values()) if (p.fin != null && !p.finDone) {
        const n = this.carNumber(p.crid); if (n == null) continue;
        this.finTimes.set(n, p.fin + (p.off ?? 0) - (p.rtt ?? 0) / 2); p.finDone = true; changed = true;
      }
      if (changed) { this.finish = [...this.finTimes].sort((a, b) => a[1] - b[1]).map(([n]) => n); this.send({ t: "finish", order: this.finish }); }
    } else if (this.ruled() && this.hostFinish?.length && process.env.NT04_NET_FINISH === "1") {   // experimental: see analysis_notes
      const host = this.hostFinish, rest = cars.filter(c => !host.includes(c.n)).sort((a, b) => m.r16(a.e + 0x5e) - m.r16(b.e + 0x5e));
      const order = [...host.map(n => cars.find(c => c.n === n)).filter(Boolean), ...rest];
      order.forEach((c, i) => m.w16(c.e + 0x5e, i));
    }
  }
  carNumber(crid) { return this.T("CARS").find(r => r.CRID === crid)?.NSID ?? null; }

  // ------------------------------------------------------------------ start gates (3/18 pre-race, 3/10 grid intro)
  screenPhase() {
    const sc = this.vm?.screens ?? [];
    if (sc.some(x => x.group === 3 && x.screen === 18)) return "pre";
    if (sc.some(x => x.group === 3 && x.screen === 10)) return "grid";
    return sc.some(x => x.group === 10 && x.screen === 0) ? "race" : "menu";
  }
  gating() { return !!this.role && this.players.size > 1 && (this.phase === "pre" || this.phase === "grid"); }
  padFilter(port, p) {
    if (port !== 0 || !this.gating()) return p;
    const ms = this.g.ms ?? 0, inj = this.inject;
    if (inj && inj.ph === this.phase && ms >= inj.from && ms < inj.until) { const a = Uint8Array.from(p.analog); a[0] = 255; return { ...p, analog: a, packet: (p.packet + 0x20000000) >>> 0 }; }
    if (p.analog[0] >= 0x40 || (p.buttons & 0x10)) this.pressed(this.phase);
    const a = Uint8Array.from(p.analog); a[0] = 0; return { ...p, analog: a, buttons: p.buttons & ~0x10, packet: (p.packet + 0x10000000) >>> 0 };
  }
  pressed(ph) {
    if (this.want[ph]) return; this.want[ph] = true; this.wantAt[ph] = this.g.ms ?? 0;
    if (this.role === "client") this.send({ t: "want", ph }); else this.log(`start (${ph}) asked; waiting for ${this.waitingText() || "nobody"}`);
  }
  waitingText() {
    if (!this.gating()) return "";
    return [...this.players.values()].filter(p => p.id !== this.id && (p.id === 0 ? false : p.ph !== this.phase)).map(p => p.name).join(", ");
  }
  go(ph, delay) { const ms = this.g.ms ?? 0; this.inject = { ph, from: ms + delay, until: ms + delay + 250, tries: 0 }; this.log(`go (${ph === "pre" ? "pace laps" : "green"})`); }
  hostGates() {
    const ph = this.phase; if (!this.gating() || !this.want[ph] || this.inject?.ph === ph) return;
    // everyone on this screen for SETTLE ms (a screen that has just opened does not take A yet)
    const ms = this.g.ms ?? 0, all = (ms - (this.phaseAt ?? ms)) >= SETTLE && [...this.players.values()].every(p => p.id === 0 || (p.ph === ph && Date.now() - (p.phAt ?? Date.now()) >= SETTLE)), late = (this.g.ms ?? 0) - this.wantAt[ph] > GO_TIMEOUT;
    if (!all && !late) return;
    if (!all) this.warn(`started without ${this.waitingText()} (not on the start screen after ${GO_TIMEOUT / 1000} s)`);
    this.send({ t: "go", ph });
    const slow = Math.max(0, ...[...this.players.values()].map(p => p.rtt ?? 0)); this.go(ph, slow / 2);
  }

  // ------------------------------------------------------------------ cars
  body(car) { return this.m.r32(REC + car * REC_SIZE) >>> 0; }
  // laps of a car (race entry +0x5C, low 16 bits). A car driven from the network takes its owner's count: written a
  // little behind where the physics carried it each tick, it can cross the line backwards, and the game then does not
  // count its next crossing (per-car flag 0x2BB197, 0xB4790), so cars lost laps (a 5-lap test: the host's car on 2,
  // one AI car on 0, and the client's own car "won" on lap 5 while the field was still racing on the host).
  entryOf(car) { const t = this.m.r32(ENTRIES) >>> 0, idx = this.m.r32(REC + car * REC_SIZE + 0x0c); return t && idx < 64 ? t + idx * ENTRY_SIZE : 0; }
  numberOfEntry(idx) {
    if (this.entKey !== this.raceKey) { this.entKey = this.raceKey; this.entNums = new Map(); for (let k = 0; k < 43; k++) this.entNums.set(this.m.r32(REC + k * REC_SIZE + 0x0c) >>> 0, this.m.r16(REC + k * REC_SIZE + 0x36)); }
    return this.entNums.get(idx);
  }
  laps(car) { const e = this.entryOf(car); return e ? this.m.r16(e + 0x5c) : 0; }
  setLaps(car, n) { const e = this.entryOf(car); if (e && n != null && n !== this.m.r16(e + 0x5c)) this.m.w16(e + 0x5c, n); }
  raceState(car) { const t = this.m.r32(ENTRIES) >>> 0; if (!t) return -1; const idx = this.m.r32(REC + car * REC_SIZE + 0x0c); return idx < 64 ? this.m.r32(t + idx * ENTRY_SIZE) : -1; }
  readBody(b, out = new Float32Array(28)) { const m = this.m; for (let k = 0; k < 12; k++) out[k] = m.rf(b + k * 4); for (let k = 0; k < 16; k++) out[12 + k] = m.rf(b + 0x40 + k * 4); return out; }
  writeBody(b, s) {
    const m = this.m;
    for (let k = 0; k < 12; k++) if ((k & 3) !== 3) m.wf(b + k * 4, s[k]);
    for (let k = 0; k < 16; k++) { m.wf(b + 0x40 + k * 4, s[12 + k]); m.wf(b + 0x80 + k * 4, s[12 + k]); }
  }
  // the car slot player p drives on this machine: the car with p's number in a shared race, else slot p (client j
  // shows the host in slot j)
  slotOf(p) {
    if (p.id === this.id) return 0;
    const shared = this.role === "host" ? !!this.card : !!this.applied;
    if (shared && p.crid != null) {
      if (p.slotKey === this.raceKey && p.slotCrid === p.crid) return p.slot;
      const c = this.T("CARS").find(r => r.CRID === p.crid); let slot = -1;
      if (c && this.m.r32(ENTRIES)) for (let k = 1; k < 43; k++) if (this.m.r16(REC + k * REC_SIZE + 0x36) === c.NSID) { slot = k; break; }
      p.slotKey = this.raceKey; p.slotCrid = p.crid; p.slot = slot; return slot;
    }
    return p.id === 0 ? this.id : p.id;
  }
  // a client without a card trades places with car j (step 1): its wheels move with it, or the suspension flings it
  swapIntoSlot(j) {
    const a = this.body(0), b = this.body(j); if (!a || !b) return false;
    const sa = this.readBody(a), sb = this.readBody(b); this.writeBody(a, sb); this.writeBody(b, sa);
    this.moveWheels(0, sa, sb);
    return true;
  }
  moveWheels(car, from, to) {
    const m = this.m, w = m.r32(REC + car * REC_SIZE + 0x10) >>> 0; if (!w) return;
    const R = s => [[s[12], s[13], s[14]], [s[16], s[17], s[18]], [s[20], s[21], s[22]]];
    const A = R(from), B = R(to);
    for (let k = 0; k < 4; k++) {
      const o = w + k * 0x60, p = [m.rf(o), m.rf(o + 4), m.rf(o + 8)].map((v, q) => v - from[24 + q]);
      const local = [0, 1, 2].map(i => A[i][0] * p[0] + A[i][1] * p[1] + A[i][2] * p[2]);
      const q2 = [0, 1, 2].map(c => B[0][c] * local[0] + B[1][c] * local[1] + B[2][c] * local[2] + to[24 + c]);
      const dz = q2[2] - m.rf(o + 8);
      m.wf(o, q2[0]); m.wf(o + 4, q2[1]); m.wf(o + 8, q2[2]); m.wf(o + 0x40, m.rf(o + 0x40) + dz); m.wf(o + 0x44, m.rf(o + 0x44) + dz);
    }
  }

  // the host's AI cars (type 2): u8 2, u8 0, u16 count, f64 host game time, then per car u16 number (NSID) + u16 laps + 28 f32
  onField(buf) {
    if (this.role !== "client" || buf.length < 12) return;
    const n = buf.readUInt16LE(2), t = buf.readDoubleLE(4), host = this.players.get(0); if (!host) return;
    const now = this.g.ms ?? 0, off = now - t; host.foff = host.foff == null || off < host.foff ? off : host.foff + (off - host.foff) * 0.02;
    this.field ??= new Map();
    for (let i = 0, o = 12; i < n && o + FIELD_CAR <= buf.length; i++, o += FIELD_CAR) {
      const nsid = buf.readUInt16LE(o), laps = buf.readUInt16LE(o + 2), s = new Float32Array(28); for (let k = 0; k < 28; k++) s[k] = buf.readFloatLE(o + 4 + k * 4);
      let f = this.field.get(nsid); if (!f) this.field.set(nsid, f = { buf: [], last: -Infinity });
      if (t <= f.last) continue; f.last = t; f.lastLocal = now; f.buf.push({ t, s, laps }); if (f.buf.length > 32) f.buf.splice(0, f.buf.length - 32);
    }
    const po = 12 + n * FIELD_CAR;
    if (buf.length > po) { const cnt = buf[po], pos = new Map(); for (let i = 0, o = po + 1; i < cnt && o + 4 <= buf.length; i++, o += 4) pos.set(buf.readUInt16LE(o), buf.readUInt16LE(o + 2)); this.hostPos = pos; }
    this.stats.field = (this.stats.field ?? 0) + 1;
  }
  // car number -> car slot on this machine (this race)
  slotByNumber(nsid) {
    if (this.numKey !== this.raceKey) { this.numKey = this.raceKey; this.numSlots = new Map(); if (this.m.r32(ENTRIES)) for (let k = 0; k < 43; k++) this.numSlots.set(this.m.r16(REC + k * REC_SIZE + 0x36), k); }
    return this.numSlots.get(nsid) ?? -1;
  }

  onState(buf, from) {
    if (buf[0] === 2) { this.onField(buf); return; }
    if (buf.length < STATE_BYTES || buf[0] !== 1) return;
    const id = buf[1], p = this.players.get(id); if (!p || id === this.id) return;
    if (this.role === "host") this.broadcast(buf, id);   // pass on to the other joiners
    const t = buf.readDoubleLE(4), s = new Float32Array(28); for (let k = 0; k < 28; k++) s[k] = buf.readFloatLE(12 + k * 4);
    const now = this.g.ms ?? 0, off = now - t;
    // clock offset (receiver game time - sender game time, plus the one-way delay): follow drops at once, rises slowly
    p.off = p.off === null || off < p.off ? off : p.off + (off - p.off) * 0.02;
    if (p.last !== undefined && t <= p.last) return;   // old or duplicate
    p.last = t; p.lastLocal = now; p.state = buf[2];
    p.buf.push({ t, s, laps: buf.readUInt16LE(12 + 28 * 4) }); if (p.buf.length > 64) p.buf.splice(0, p.buf.length - 64);
    this.stats.recv++;
  }

  // after every game tick
  tick() {
    if (!this.role) return;
    this.ticks++;
    const me = this.raceState(0), key = this.m.r32(ENTRIES) >>> 0;
    if (key !== this.raceKey) {
      if (!key) {   // race over: the client's own settings come back; the host's card is for that race only
        if (this.sgppRow && this.sgppBack) Object.assign(this.sgppRow, this.sgppBack); this.sgppRow = this.sgppBack = null;
        this.applied = null; if (this.role === "host" && this.card) { this.card = null; this.send({ t: "card", card: null }); }
      }
      this.raceKey = key; this.swapped = false; this.started = false; this.field = null; this.flagPending = {}; this.hostPos = null; this.finish = []; this.hostFinish = null; this.finTimes = null; this.finSent = false; for (const p of this.players.values()) { p.fin = null; p.finDone = false; } for (const p of this.players.values()) { p.buf = []; p.last = undefined; }
    }
    // where we are, and our car, to the host (clients) / everyone (host) when it changes
    const ph = this.screenPhase();
    if (ph !== this.phase) { this.phase = ph; this.want = {}; this.phaseAt = this.g.ms ?? 0; }
    // a "go" press the screen did not take (it was still opening): press again every second while still there
    const inj = this.inject; if (inj && inj.ph === ph && (this.g.ms ?? 0) > inj.until + 1000 && inj.tries < 5) { inj.from = (this.g.ms ?? 0); inj.until = inj.from + 250; inj.tries++; }
    if (this.ticks % 30 === 0 || this.sentMe?.ph !== ph) {
      const crid = this.myCar();
      if (this.sentMe?.ph !== ph || this.sentMe?.crid !== crid) {
        this.sentMe = { ph, crid };
        if (this.role === "client") this.send({ t: "me", crid, ph });
        else { const p = this.players.get(0); if (p) { p.crid = crid; p.ph = ph; this.broadcastPlayers(); } }
      }
    }
    if (this.role === "host") this.hostGates();
    this.finishOrder();
    const rs = this.raceStage();
    if (rs !== this.lastStage) {
      if (this.role === "host" && this.card && rs >= 0) this.send({ t: "stage", s: rs, prev: this.lastStage });
      if (rs >= 0 && this.lastStage >= 0) this.log(`race stage 0x${this.lastStage.toString(16)} -> 0x${rs.toString(16)}`);
      this.lastStage = rs;
    }
    // the host's caution, on a client still racing: 0xAD6B0 is only asked while a yellow is out here (flag 0x2BB104
    // = 1), which this machine may not have thrown, so the caution is brought out as the game's 0x1D step does:
    // 0x2BA9BC = 0, 0x2F3284 = 0, RequestStage(2, 0x21), 0xAAA40
    if (this.ruled() && this.flagPending?.caution && rs === ST_RACE) {
      this.flagPending.caution = false; const m = this.m;
      m.w8(0x2ba9bc, 0); m.w8(0x2f3284, 0); this.g.nested(0x175030, [2, ST_CAUTION], { ecx: RACE_PROC }); this.g.nested(0xaaa40, [], { ebx: 0 });
      this.log("caution from the host");
    }
    if (me === 3) this.started = true;
    const live = RACING.has(me) || (me === 6 && this.started);
    // a client in a race of its own (no card) trades places with car j as in step 1
    if (this.role === "client" && this.id > 0 && !this.applied && !this.swapped && (me === 1 || me === 10 || live)) { this.swapped = this.swapIntoSlot(this.id); if (this.swapped) this.log(`not the host's race: started from car ${this.id}'s place`); }
    if (live && !this.live) this.log(`racing (car state ${me})`);
    this.live = live;
    const now = this.g.ms ?? 0;
    // the host's AI field (pace laps on): every car but the humans (ours while we drive it, the clients' while they
    // send), every 4th tick; clients drive their AI cars from it, so the field is the same everywhere
    if (this.role === "host" && this.card && key && (ph === "race" || ph === "grid") && this.ticks % FIELD_EVERY === 0 && this.clients.size) {
      const skip = new Set(live ? [0] : []); for (const p of this.players.values()) if (p.id && p.lastLocal !== undefined && now - p.lastLocal < 1000) skip.add(this.slotOf(p));
      const cars = []; for (let k = 0; k < 43; k++) if (!skip.has(k) && this.body(k)) cars.push(k);
      // + the running positions of all cars (u8 count, then u16 number + u16 position each)
      const all = []; for (let k = 0; k < 43; k++) { const e = this.entryOf(k); if (e) all.push([this.m.r16(REC + k * REC_SIZE + 0x36), this.m.r16(e + 0x5e)]); }
      const out = Buffer.alloc(12 + cars.length * FIELD_CAR + 1 + all.length * 4); out[0] = 2; out.writeUInt16LE(cars.length, 2); out.writeDoubleLE(now, 4);
      { let o = 12 + cars.length * FIELD_CAR; out[o++] = all.length; for (const [n, q] of all) { out.writeUInt16LE(n, o); out.writeUInt16LE(q, o + 2); o += 4; } }
      cars.forEach((k, i) => { const o = 12 + i * FIELD_CAR, b = this.readBody(this.body(k)); out.writeUInt16LE(this.m.r16(REC + k * REC_SIZE + 0x36), o); out.writeUInt16LE(this.laps(k), o + 2); for (let q = 0; q < 28; q++) out.writeFloatLE(b[q], o + 4 + q * 4); });
      this.broadcast(out);
    }
    if (this.role === "client" && this.applied && this.field && key) {
      const host = this.players.get(0), mine = this.m.r16(REC + 0x36), sending = new Set();
      for (const p of this.players.values()) if (p.id !== this.id && p.lastLocal !== undefined && now - p.lastLocal < 1000) sending.add(this.slotOf(p));
      for (const [nsid, f] of this.field) {
        if (nsid === mine || !f.buf.length || now - f.lastLocal > 2000) continue;
        const slot = this.slotByNumber(nsid); if (slot <= 0 || sending.has(slot)) continue;
        const tt = now - host.foff - this.delay, st = sample(f.buf, tt); if (st) { this.writeBody(this.body(slot), st); this.setLaps(slot, lapsAt(f.buf, tt)); }
      }
    }
    if (!live) return;
    // send our car
    if (this.ticks % this.sendEvery === 0) {
      const out = Buffer.alloc(STATE_BYTES); out[0] = 1; out[1] = this.id; out[2] = me; out.writeDoubleLE(this.g.ms ?? 0, 4);
      const s = this.readBody(this.body(0)); for (let k = 0; k < 28; k++) out.writeFloatLE(s[k], 12 + k * 4); out.writeUInt16LE(this.laps(0), 12 + 28 * 4);
      if (this.role === "host") this.broadcast(out); else this.ws?.send(out);
      this.stats.sent++;
    }
    // show the others
    for (const p of this.players.values()) {
      if (p.id === this.id || !p.buf.length || now - p.lastLocal > 2000) continue;   // nothing (yet / any more): the AI drives the slot
      const slot = this.slotOf(p), b = slot > 0 && slot < 43 ? this.body(slot) : 0; if (!b) continue;
      const tt = now - p.off - this.delay, s = sample(p.buf, tt); if (s) { this.writeBody(b, s); this.setLaps(slot, lapsAt(p.buf, tt)); this.stats.applied++; }
    }
  }
}

// ------------------------------------------------------------------ interpolation
// body state at sender time t: between the two snapshots around t (position Hermite with velocities from the
// neighbours, orientation slerp), or extrapolated from the newest one by its velocity for up to 300 ms
function sample(buf, t) {
  const n = buf.length; if (!n) return null;
  if (t <= buf[0].t) return buf[0].s;
  let i = n - 1; while (i > 0 && buf[i - 1].t > t) i--;
  if (t >= buf[n - 1].t) {
    const a = buf[n - 1], dt = Math.min(t - a.t, 300) / 1000; if (n < 2) return a.s;
    const z = buf[n - 2], v = vel(z, a), s = Float32Array.from(a.s);
    for (const base of [8, 24]) for (let q = 0; q < 3; q++) s[base + q] += v[q] * dt;
    return s;
  }
  const a = buf[i - 1], b = buf[i], u = (t - a.t) / (b.t - a.t), h = (b.t - a.t) / 1000;
  const va = i >= 2 ? vel(buf[i - 2], b) : vel(a, b), vb = i + 1 < n ? vel(a, buf[i + 1]) : vel(a, b);
  const s = new Float32Array(28);
  for (let k = 0; k < 8; k++) s[k] = a.s[k] + (b.s[k] - a.s[k]) * u;                     // momentum, angular rate
  const u2 = u * u, u3 = u2 * u, h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  for (const base of [8, 24]) for (let q = 0; q < 3; q++) s[base + q] = h00 * a.s[base + q] + h10 * h * va[q] + h01 * b.s[base + q] + h11 * h * vb[q];
  s[11] = a.s[11]; s[27] = 1;
  const qa = quatOf(a.s), qb = quatOf(b.s); writeRot(s, slerp(qa, qb, u));
  return s;
}
// the owner's lap count at time t: the newest snapshot at or before t
const lapsAt = (buf, t) => { let l = buf[0]?.laps; for (const b of buf) { if (b.t > t) break; l = b.laps; } return l; };
const vel = (a, b) => { const dt = (b.t - a.t) / 1000 || 1; return [0, 1, 2].map(q => (b.s[24 + q] - a.s[24 + q]) / dt); };
// orientation rows at s[12..14], s[16..18], s[20..22]
function quatOf(s) {
  const m00 = s[12], m01 = s[13], m02 = s[14], m10 = s[16], m11 = s[17], m12 = s[18], m20 = s[20], m21 = s[21], m22 = s[22];
  const tr = m00 + m11 + m22; let w, x, y, z;
  if (tr > 0) { const k = Math.sqrt(tr + 1) * 2; w = k / 4; x = (m21 - m12) / k; y = (m02 - m20) / k; z = (m10 - m01) / k; }
  else if (m00 > m11 && m00 > m22) { const k = Math.sqrt(1 + m00 - m11 - m22) * 2; w = (m21 - m12) / k; x = k / 4; y = (m01 + m10) / k; z = (m02 + m20) / k; }
  else if (m11 > m22) { const k = Math.sqrt(1 + m11 - m00 - m22) * 2; w = (m02 - m20) / k; x = (m01 + m10) / k; y = k / 4; z = (m12 + m21) / k; }
  else { const k = Math.sqrt(1 + m22 - m00 - m11) * 2; w = (m10 - m01) / k; x = (m02 + m20) / k; y = (m12 + m21) / k; z = k / 4; }
  return [w, x, y, z];
}
function slerp(a, b, u) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]; if (d < 0) { b = b.map(v => -v); d = -d; }
  if (d > 0.9995) { const r = a.map((v, k) => v + (b[k] - v) * u), l = Math.hypot(...r); return r.map(v => v / l); }
  const th = Math.acos(d), sa = Math.sin((1 - u) * th) / Math.sin(th), sb = Math.sin(u * th) / Math.sin(th);
  return a.map((v, k) => v * sa + b[k] * sb);
}
function writeRot(s, [w, x, y, z]) {
  s[12] = 1 - 2 * (y * y + z * z); s[13] = 2 * (x * y - z * w); s[14] = 2 * (x * z + y * w); s[15] = 0;
  s[16] = 2 * (x * y + z * w); s[17] = 1 - 2 * (x * x + z * z); s[18] = 2 * (y * z - x * w); s[19] = 0;
  s[20] = 2 * (x * z - y * w); s[21] = 2 * (y * z + x * w); s[22] = 1 - 2 * (x * x + y * y); s[23] = 0;
}
export const _test = { sample, quatOf, writeRot, slerp };
