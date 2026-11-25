// relay.mjs — lobby and relay for online races (netplay.mjs). Anyone can run one on a machine the players can all
// reach (a small VPS, or a home PC with this one port forwarded). Hosts and joiners both connect OUT to it, so no
// player forwards a port; the relay lists the open races and passes each joiner's traffic to its host over the
// host's single connection.
//
// usage: node relay.mjs [--port 27105] [--bind 0.0.0.0] [--max-races 50]
//
//   GET  /races             open races: [{ id, name, race, phase, players, full, age }]
//   WS   /host?name=&v=     a host registers; gets {t: race, id}; then binary link frames (see netplay.mjs hostVia)
//   WS   /join/<id>         a joiner; its messages go to the host unchanged and the host's to it
//   UDP  same port          introduces a joiner and a host for a direct link (hole punching, netudp.mjs); after
//                           that their race traffic does not pass through the relay
//
// Link frames, relay -> host: u8 kind (1 text, 2 binary, 3 joiner connected, 4 joiner gone), u16 connection,
// payload. Host -> relay: u8 kind (1 text, 2 binary, 5 close that joiner, 6 to all joiners but one: u16 skip, u8 1
// text / 2 binary, payload), u16 connection, payload; host text frames = race info for the list.
// Limits: 8 joiners a race, 256 KB a message, races without a host vanish at once, and joiners are dropped with it.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { acceptWebSocket } from "./ws-lite.mjs";

const argv = process.argv.slice(2), opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const PORT = +opt("--port", process.env.NT04_RELAY_PORT ?? 27105), BIND = opt("--bind", "0.0.0.0"), MAX_RACES = +opt("--max-races", 50);
const MAX_JOINERS = 8, MAX_MSG = 256 * 1024;
const races = new Map();   // id -> { id, host, info, joiners: Map conn -> ws, next, created }
const log = s => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);

const newId = () => { let id; do id = randomBytes(3).toString("hex").toUpperCase(); while (races.has(id)); return id; };
const frame = (kind, conn, payload) => { const p = typeof payload === "string" ? Buffer.from(payload) : payload ?? Buffer.alloc(0); const b = Buffer.alloc(3 + p.length); b[0] = kind; b.writeUInt16LE(conn, 1); p.copy(b, 3); return b; };

const srv = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/races") {
    const list = [...races.values()].map(r => ({ id: r.id, name: r.info.name ?? "?", race: r.info.race ?? null, phase: r.info.phase ?? "menu", players: r.info.players ?? [], full: !!r.info.full || r.joiners.size >= MAX_JOINERS, direct: r.info.direct ?? null, p2p: !!r.udp && Date.now() - r.udp.at < 15000, age: Math.round((Date.now() - r.created) / 1000) }));
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" }); res.end(JSON.stringify({ relay: "nt04", races: list }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" }); res.end(`NASCAR Thunder 2004 online relay: ${races.size} race(s). GET /races for the list.\n`);
});

srv.on("upgrade", (req, socket) => {
  const u = new URL(req.url, "http://x");
  socket.on("error", () => {});
  if (u.pathname === "/host") {
    if (races.size >= MAX_RACES) { socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n"); return; }
    const r = { id: newId(), info: { name: (u.searchParams.get("name") ?? "Host").slice(0, 24) }, joiners: new Map(), next: 1, created: Date.now() };
    r.host = acceptWebSocket(req, socket, msg => {
      if (typeof msg === "string") { if (msg.length < 8192) try { const o = JSON.parse(msg); if (o.t === "info") r.info = { ...o, name: String(o.name ?? r.info.name).slice(0, 24) }; } catch {} return; }
      if (msg.length < 3 || msg.length > MAX_MSG) return;
      const kind = msg[0], conn = msg.readUInt16LE(1);
      if (kind === 1 || kind === 2) { const j = r.joiners.get(conn); if (j?.open) j.send(kind === 1 ? msg.subarray(3).toString("utf8") : msg.subarray(3)); }
      else if (kind === 5) { const j = r.joiners.get(conn); r.joiners.delete(conn); j?.close(); }
      else if (kind === 6 && msg.length >= 4) {   // to all but one (conn = the one to skip)
        const text = msg[3] === 1, body = text ? msg.subarray(4).toString("utf8") : msg.subarray(4);
        for (const [c, j] of r.joiners) if (c !== conn && j.open && j.buffered < 4 * 1024 * 1024) j.send(body);
      }
    }, () => { races.delete(r.id); for (const j of r.joiners.values()) { try { j.send(JSON.stringify({ t: "bye", why: "the host left" })); } catch {} j.close(); } log(`race ${r.id} (${r.info.name}) closed`); });
    r.key = randomBytes(8).toString("hex");
    races.set(r.id, r); r.host.send(JSON.stringify({ t: "race", id: r.id, key: r.key, udp: PORT })); log(`race ${r.id} opened by ${r.info.name}`);
    return;
  }
  const m = /^\/join\/([0-9A-Fa-f]{6})$/.exec(u.pathname);
  const r = m && races.get(m[1].toUpperCase());
  if (!r) { socket.end("HTTP/1.1 404 Not Found\r\n\r\nno such race\n"); return; }
  if (r.joiners.size >= MAX_JOINERS) { socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\nthe race is full\n"); return; }
  const conn = (r.next++ % 0xfffe) + 1;
  const j = acceptWebSocket(req, socket, msg => {
    if (!r.host.open || (msg.length ?? 0) > MAX_MSG) return;
    r.host.send(frame(typeof msg === "string" ? 1 : 2, conn, msg));
  }, () => { if (r.joiners.delete(conn) && r.host.open) r.host.send(frame(4, conn)); });
  r.joiners.set(conn, j); r.host.send(frame(3, conn)); log(`race ${r.id}: joiner ${conn} connected (${r.joiners.size})`);
});

// Direct links (netudp.mjs): the relay only introduces the two players. UDP on the same port number:
//   host  -> {t: reg, race, key}   every few seconds: its public UDP address as the relay sees it
//   joiner-> {t: p2p, race, nonce} : the relay answers {t: peer, addr, port, nonce} to the joiner (the host's address)
//            and sends the host {t: peer, addr, port, nonce} (the joiner's); both then punch. {t: nop2p} when the
//            host has no fresh UDP registration (the joiner uses the relayed WebSocket instead).
const udp = createSocket("udp4");
const sig = (o, addr, port) => { const j = Buffer.from(JSON.stringify(o)), b = Buffer.alloc(1 + j.length); b[0] = 9; j.copy(b, 1); udp.send(b, port, addr); };
udp.on("message", (msg, { address, port }) => {
  if (msg[0] !== 9 || msg.length > 512) return;
  let o; try { o = JSON.parse(msg.subarray(1).toString("utf8")); } catch { return; }
  const r = races.get(String(o.race ?? "").toUpperCase());
  if (o.t === "reg") { if (r && o.key === r.key) { r.udp = { addr: address, port, at: Date.now(), alt: o.alt && typeof o.alt.addr === "string" && /^[\d.]+$/.test(o.alt.addr) && Number.isInteger(o.alt.port) ? { addr: o.alt.addr, port: o.alt.port } : null }; sig({ t: "regok", addr: address, port }, address, port); } return; }
  if (o.t === "p2p") {
    if (!r || !r.udp || Date.now() - r.udp.at > 15000 || !Number.isInteger(o.nonce)) { sig({ t: "nop2p", nonce: o.nonce }, address, port); return; }
    sig({ t: "peer", addr: r.udp.addr, port: r.udp.port, alt: r.udp.alt, nonce: o.nonce }, address, port);
    sig({ t: "peer", addr: address, port, nonce: o.nonce }, r.udp.addr, r.udp.port);
    log(`race ${r.id}: introduced ${address}:${port} to the host ${r.udp.addr}:${r.udp.port}`);
  }
});
udp.on("error", e => console.error(`relay udp: ${e.message}`));
udp.bind(PORT, BIND);

srv.on("error", e => { console.error(`relay: ${e.message}`); process.exit(1); });
srv.listen(PORT, BIND, () => log(`NASCAR Thunder 2004 relay on port ${PORT}`));
