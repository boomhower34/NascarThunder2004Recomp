// ws-lite.mjs — a minimal WebSocket server endpoint (RFC 6455) for the live view: upgrade an HTTP request, send
// binary/text messages, receive (masked) client messages. No extensions, no fragmentation on send; incoming
// fragmented messages are reassembled. Enough for one local browser page.

import { createHash } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function acceptWebSocket(req, socket, onMessage, onClose) {
  const key = req.headers["sec-websocket-key"];
  if (!key || (req.headers.upgrade ?? "").toLowerCase() !== "websocket") { socket.destroy(); return null; }
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.setNoDelay(true);
  let buf = Buffer.alloc(0), parts = [], partOp = 0, open = true;
  const ws = {
    get open() { return open; },
    get buffered() { return socket.writableLength; },          // bytes queued and not yet written (back pressure)
    send(data) {
      if (!open) return;
      const bin = typeof data !== "string", payload = bin ? Buffer.from(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length) : Buffer.from(data);
      const n = payload.length, head = n < 126 ? Buffer.from([bin ? 0x82 : 0x81, n]) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
      if (n >= 126 && n < 65536) { head[0] = bin ? 0x82 : 0x81; head[1] = 126; head.writeUInt16BE(n, 2); }
      else if (n >= 65536) { head[0] = bin ? 0x82 : 0x81; head[1] = 127; head.writeUInt32BE(Math.floor(n / 2 ** 32), 2); head.writeUInt32BE(n >>> 0, 6); }
      socket.write(head); socket.write(payload);
    },
    close() { if (open) { open = false; try { socket.end(Buffer.from([0x88, 0])); } catch {} } },
  };
  socket.on("data", chunk => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80; let n = buf[1] & 0x7f, p = 2;
      if (n === 126) { if (buf.length < 4) return; n = buf.readUInt16BE(2); p = 4; }
      else if (n === 127) { if (buf.length < 10) return; n = buf.readUInt32BE(2) * 2 ** 32 + buf.readUInt32BE(6); p = 10; }
      const mask = masked ? buf.subarray(p, p + 4) : null; if (masked) p += 4;
      if (buf.length < p + n) return;
      const data = Buffer.from(buf.subarray(p, p + n)); buf = buf.subarray(p + n);
      if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      if (op === 8) { ws.close(); return; }
      if (op === 9) { socket.write(Buffer.concat([Buffer.from([0x8a, data.length]), data])); continue; }   // ping -> pong
      if (op === 10) continue;
      if (op !== 0) { partOp = op; parts = []; }
      parts.push(data);
      if (fin) { const msg = Buffer.concat(parts); parts = []; onMessage?.(partOp === 1 ? msg.toString("utf8") : msg); }
    }
  });
  socket.on("close", () => { open = false; onClose?.(); });
  socket.on("error", () => { open = false; });
  return ws;
}

// Client side (netplay.mjs joins a host with it): connect to ws://host:port/path. Same message interface as the
// server endpoint ({ open, buffered, send, close }); frames we send are masked as RFC 6455 requires of clients.
// onOpen(ws) once the handshake is done; onClose() when the connection ends or fails (err set when it never opened).
export async function connectWebSocket(url, { onOpen, onMessage, onClose, timeout = 8000 } = {}) {
  const { connect } = await import("node:net");
  const { randomBytes } = await import("node:crypto");
  const u = new URL(url), key = randomBytes(16).toString("base64"), expect = createHash("sha1").update(key + GUID).digest("base64");
  const socket = connect({ host: u.hostname, port: +(u.port || 80) });
  socket.setNoDelay(true); socket.setTimeout(timeout);
  let buf = Buffer.alloc(0), parts = [], partOp = 0, open = false, done = false;
  const finish = err => { if (done) return; done = true; open = false; try { socket.destroy(); } catch {} onClose?.(err); };
  const frame = (op, payload) => {
    const n = payload.length, mask = randomBytes(4), head = n < 126 ? Buffer.from([0x80 | op, 0x80 | n]) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    if (n >= 126 && n < 65536) { head[0] = 0x80 | op; head[1] = 0x80 | 126; head.writeUInt16BE(n, 2); }
    else if (n >= 65536) { head[0] = 0x80 | op; head[1] = 0x80 | 127; head.writeUInt32BE(Math.floor(n / 2 ** 32), 2); head.writeUInt32BE(n >>> 0, 6); }
    const body = Buffer.alloc(n); for (let i = 0; i < n; i++) body[i] = payload[i] ^ mask[i & 3];
    socket.write(Buffer.concat([head, mask, body]));
  };
  const ws = {
    get open() { return open; },
    get buffered() { return socket.writableLength; },
    send(data) { if (!open) return; const bin = typeof data !== "string"; frame(bin ? 2 : 1, bin ? Buffer.from(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length) : Buffer.from(data)); },
    close() { if (open) { try { frame(8, Buffer.alloc(0)); socket.end(); } catch {} } finish(); },
  };
  let handshake = true;
  socket.on("connect", () => {
    socket.write(`GET ${u.pathname || "/"}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  });
  socket.on("timeout", () => { if (!open) finish(new Error(`no answer from ${u.host}`)); });
  socket.on("data", chunk => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    if (handshake) {
      const end = buf.indexOf("\r\n\r\n"); if (end < 0) return;
      const head = buf.subarray(0, end).toString("latin1"); buf = buf.subarray(end + 4);
      if (!/^HTTP\/1\.1 101/.test(head) || !head.includes(expect)) { finish(new Error(`${u.host} is not a netplay host (${head.split("\r\n")[0]})`)); return; }
      handshake = false; open = true; socket.setTimeout(0); onOpen?.(ws);
    }
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f; let n = buf[1] & 0x7f, p = 2;
      if (n === 126) { if (buf.length < 4) return; n = buf.readUInt16BE(2); p = 4; }
      else if (n === 127) { if (buf.length < 10) return; n = buf.readUInt32BE(2) * 2 ** 32 + buf.readUInt32BE(6); p = 10; }
      if (buf.length < p + n) return;
      const data = Buffer.from(buf.subarray(p, p + n)); buf = buf.subarray(p + n);
      if (op === 8) { finish(); return; }
      if (op === 9) { frame(10, data); continue; }
      if (op === 10) continue;
      if (op !== 0) { partOp = op; parts = []; }
      parts.push(data);
      if (fin) { const msg = Buffer.concat(parts); parts = []; onMessage?.(partOp === 1 ? msg.toString("utf8") : msg); }
    }
  });
  socket.on("close", () => finish(open ? undefined : new Error(`could not connect to ${u.host}`)));
  socket.on("error", e => finish(e));
  return ws;
}
