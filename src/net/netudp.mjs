// netudp.mjs — direct UDP links between players behind home routers (NAT hole punching), for netplay.mjs.
//
// Both players' games learn each other's public address from the relay (relay.mjs, which then carries nothing but
// these few signalling packets) and send each other "punch" packets at the same time: each router sees its own
// player's packet go out to the other's address first and lets the answer in. Works for most home routers
// ("cone" NATs); two strict ("symmetric") NATs cannot meet this way, and the game falls back to the relay.
//
// One UdpEndpoint = one UDP socket, used both to talk to the relay and for every link, so the router's mapping the
// relay sees is the one the other player reaches. A UdpLink looks like a WebSocket to netplay.mjs (open, buffered,
// send, close): text messages are reliable and in order (resent until acknowledged), binary ones (car states, the AI
// field) are sent once (a lost one is replaced by the next ~33 ms later); both are cut into 1,100-byte fragments.
//
// Packets (u8 type first):
//   1 punch    u32 nonce                          2 punch answer  u32 nonce
//   3 reliable u32 message, u16 part, u16 parts, u8 1 text / 2 binary, data
//   4 ack      u32 message, u16 part              5 unreliable    u32 message, u16 part, u16 parts, data
//   6 keepalive (every second)                    7 close
//   9 signal   JSON, to / from the relay ({t: reg | p2p | peer | nop2p})

import { createSocket } from "node:dgram";
import { randomInt } from "node:crypto";

const MTU = 1100, RESEND_MS = 200, MAX_TRIES = 50, KEEPALIVE_MS = 1000, TIMEOUT_MS = 10000, PUNCH_MS = 100;
const key = (a, p) => `${a}:${p}`;

export class UdpEndpoint {
  constructor({ onLink = null, onSignal = null, log = () => {} } = {}) {
    this.links = new Map(); this.punches = new Map(); this.onLink = onLink; this.onSignal = onSignal; this.log = log;
  }
  bind(port = 0) {
    return new Promise((resolve, reject) => {
      const s = this.sock = createSocket("udp4");
      s.on("error", e => { this.log(`udp: ${e.message}`); reject(e); });
      s.on("message", (msg, rinfo) => this.packet(msg, rinfo));
      s.bind(port, () => { this.port = s.address().port; this.timer = setInterval(() => this.service(), 100); this.timer.unref?.(); resolve(this.port); });
    });
  }
  close() { clearInterval(this.timer); for (const l of [...this.links.values()]) l.close(); try { this.sock?.close(); } catch {} this.sock = null; }
  raw(buf, addr, port) { if (this.sendHook) { this.sendHook(buf, addr, port); return; } try { this.sock?.send(buf, port, addr); } catch {} }   // (sendHook: tests put a simulated router in between)
  signal(obj, addr, port) { const j = Buffer.from(JSON.stringify(obj)); const b = Buffer.alloc(1 + j.length); b[0] = 9; j.copy(b, 1); this.raw(b, addr, port); }

  // punch through to addr:port (both sides do this at the same time); resolves the link, or null after `ms`
  punch(addr, port, nonce, ms = 5000) {
    if (process.env.NT04_UDP_DEBUG) this.log(`udp: punching ${addr}:${port} nonce ${nonce} from port ${this.port}`);
    const k = key(addr, port);
    const live = this.links.get(k); if (live?.open) return Promise.resolve(live);
    return new Promise(resolve => {
      const p = { addr, port, nonce, until: Date.now() + ms, resolve, done: false };
      this.punches.set(k, p); this.sendPunch(p);
    });
  }
  sendPunch(p) { const b = Buffer.alloc(5); b[0] = 1; b.writeUInt32LE(p.nonce >>> 0, 1); this.raw(b, p.addr, p.port); }
  established(addr, port, nonce) {
    const k = key(addr, port); let l = this.links.get(k);
    if (!l) { l = new UdpLink(this, addr, port); this.links.set(k, l); const p = this.punches.get(k); this.punches.delete(k); if (p && !p.done) { p.done = true; p.resolve(l); } else this.onLink?.(l); }
    return l;
  }

  packet(msg, { address, port }) {
    if (!msg.length) return;
    const t = msg[0], k = key(address, port);
    if (t === 9) { let o; try { o = JSON.parse(msg.subarray(1).toString("utf8")); } catch { return; } this.onSignal?.(o, address, port); return; }
    if (t === 1 || t === 2) {
      if (msg.length < 5) return;
      const nonce = msg.readUInt32LE(1), p = this.punches.get(k);
      if (process.env.NT04_UDP_DEBUG) this.log(`udp: punch ${t} from ${k} nonce ${nonce}, expecting ${p ? p.nonce : "-"}, link ${this.links.has(k)}`);
      // a punch from someone we are not expecting (and no link): ignore, the relay introduces every pair
      if (!p && !this.links.has(k)) return;
      if (p && p.nonce >>> 0 !== nonce) return;
      if (t === 1) { const b = Buffer.alloc(5); b[0] = 2; b.writeUInt32LE(nonce, 1); this.raw(b, address, port); }
      this.established(address, port, nonce).touch();
      return;
    }
    const l = this.links.get(k); if (!l) return;
    l.touch(); l.packet(t, msg);
  }
  service() {
    const now = Date.now();
    for (const [k, p] of this.punches) { if (now > p.until) { this.punches.delete(k); if (!p.done) { p.done = true; p.resolve(null); } } else this.sendPunch(p); }
    for (const l of [...this.links.values()]) l.service(now);
  }
}

export class UdpLink {
  constructor(ep, addr, port) {
    this.ep = ep; this.addr = addr; this.port = port; this.open = true; this.last = Date.now(); this.lastSent = 0;
    this.nextOut = 1; this.pending = new Map(); this.nextIn = 1; this.inParts = new Map(); this.done = new Map(); this.unrel = new Map(); this.unrelId = 1;
    this.onMessage = null; this.onClose = null; this.stats = { resent: 0, lost: 0 };
  }
  get buffered() { return this.pending.size * MTU; }
  get remote() { return key(this.addr, this.port); }
  touch() { this.last = Date.now(); }
  out(b) { this.ep.raw(b, this.addr, this.port); this.lastSent = Date.now(); }
  send(data) {
    if (!this.open) return;
    const text = typeof data === "string", body = text ? Buffer.from(data) : Buffer.from(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length);
    const parts = Math.max(1, Math.ceil(body.length / MTU));
    if (text) {
      const id = this.nextOut++;
      for (let i = 0; i < parts; i++) {
        const chunk = body.subarray(i * MTU, (i + 1) * MTU), b = Buffer.alloc(10 + chunk.length);
        b[0] = 3; b.writeUInt32LE(id, 1); b.writeUInt16LE(i, 5); b.writeUInt16LE(parts, 7); b[9] = 1; chunk.copy(b, 10);
        this.pending.set(`${id}:${i}`, { b, at: Date.now(), tries: 1 }); this.out(b);
      }
    } else {
      const id = this.unrelId++ >>> 0;
      for (let i = 0; i < parts; i++) {
        const chunk = body.subarray(i * MTU, (i + 1) * MTU), b = Buffer.alloc(9 + chunk.length);
        b[0] = 5; b.writeUInt32LE(id, 1); b.writeUInt16LE(i, 5); b.writeUInt16LE(parts, 7); chunk.copy(b, 9); this.out(b);
      }
    }
  }
  packet(t, msg) {
    if (t === 7) { this.shut(); return; }
    if (t === 6) return;
    if (t === 4 && msg.length >= 7) { this.pending.delete(`${msg.readUInt32LE(1)}:${msg.readUInt16LE(5)}`); return; }
    if (t === 3 && msg.length >= 10) {
      const id = msg.readUInt32LE(1), i = msg.readUInt16LE(5), n = msg.readUInt16LE(7);
      const ack = Buffer.alloc(7); ack[0] = 4; ack.writeUInt32LE(id, 1); ack.writeUInt16LE(i, 5); this.out(ack);
      if (id < this.nextIn || this.done.has(id)) return;   // a repeat
      let m = this.inParts.get(id); if (!m) this.inParts.set(id, m = { n, parts: new Array(n), got: 0, kind: msg[9] });
      if (!m.parts[i]) { m.parts[i] = Buffer.from(msg.subarray(10)); m.got++; }
      if (m.got === m.n) { this.inParts.delete(id); const all = Buffer.concat(m.parts); this.done.set(id, m.kind === 1 ? all.toString("utf8") : all); }
      while (this.done.has(this.nextIn)) { const v = this.done.get(this.nextIn); this.done.delete(this.nextIn); this.nextIn++; this.onMessage?.(v); }
      return;
    }
    if (t === 5 && msg.length >= 9) {
      const id = msg.readUInt32LE(1), i = msg.readUInt16LE(5), n = msg.readUInt16LE(7);
      if (n === 1) { this.onMessage?.(Buffer.from(msg.subarray(9))); return; }
      let m = this.unrel.get(id); if (!m) this.unrel.set(id, m = { n, parts: new Array(n), got: 0, at: Date.now() });
      if (!m.parts[i]) { m.parts[i] = Buffer.from(msg.subarray(9)); m.got++; }
      if (m.got === m.n) { this.unrel.delete(id); this.onMessage?.(Buffer.concat(m.parts)); }
    }
  }
  service(now) {
    if (!this.open) return;
    if (now - this.last > TIMEOUT_MS) { this.ep.log(`udp: ${this.remote} timed out`); this.shut(); return; }
    for (const [k, p] of this.pending) {
      if (now - p.at < RESEND_MS) continue;
      if (++p.tries > MAX_TRIES) { this.ep.log(`udp: ${this.remote} stopped answering`); this.shut(); return; }
      p.at = now; this.stats.resent++; this.out(p.b);
    }
    for (const [id, m] of this.unrel) if (now - m.at > 1000) { this.unrel.delete(id); this.stats.lost++; }
    if (now - this.lastSent > KEEPALIVE_MS) this.out(Buffer.from([6]));
  }
  close() { if (!this.open) return; this.out(Buffer.from([7])); this.shut(); }
  shut() { if (!this.open) return; this.open = false; this.ep.links.delete(this.remote); this.onClose?.(); }
}

export const newNonce = () => randomInt(1, 0x7fffffff);
