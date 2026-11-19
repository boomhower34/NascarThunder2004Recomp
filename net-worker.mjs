// net-worker.mjs — the live server's network side on a thread of its own: the HTTP server and the page's WebSocket.
//
// Why a thread: the emulator thread sometimes runs for seconds inside one game call (a race loads in one frame) and
// still has frames to show meanwhile (the loading screen's fade and bar, gl-remote "urgent" frames). Written from that
// thread, a socket only gets its first chunk out: Node sends the next write when the previous one's completion has
// been seen by the event loop, which on Windows (completion ports) means after the long call. Messages posted to this
// thread are written by it at once, whatever the emulator thread is doing.
//
// Protocol with main.mjs (parentPort):
//   in:  { t: "send", data }            a WebSocket message to the page (string or bytes)
//        { t: "httpres", id, status, headers, body }
//        { t: "close" }                 close the page's connection
//   out: { t: "http", id, url }         a request to answer (main.mjs makes the page, scripts, movie data...)
//        { t: "open" } / { t: "closed" } / { t: "msg", data }   the page's WebSocket
//        { t: "listening", port }
import { parentPort, workerData } from "node:worker_threads";
import { createServer } from "node:http";
import { acceptWebSocket } from "./ws-lite.mjs";
import { mkdirSync, createWriteStream } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pending = new Map(); let nextId = 1, ws = null;
// POST /capture (play-client.js ?capture=1, F9): the capture is written here, to captures/ beside this file,
// rather than through the browser's downloads (which a page pane may not offer)
const captureDir = join(dirname(fileURLToPath(import.meta.url)), "captures");
const server = createServer((req, res) => {
  if (req.method === "POST" && new URL(req.url, "http://localhost").pathname === "/capture") {
    mkdirSync(captureDir, { recursive: true });
    const name = `nt04-capture-${new Date().toISOString().replace(/[:.]/g, "-")}.bin`, file = join(captureDir, name), out = createWriteStream(file);
    req.pipe(out);
    out.on("finish", () => { res.writeHead(200, { "content-type": "text/plain" }); res.end(file); });
    out.on("error", e => { res.writeHead(500); res.end(String(e?.message ?? e)); });
    return;
  }
  const id = nextId++; pending.set(id, res);
  parentPort.postMessage({ t: "http", id, url: req.url });
});
server.on("upgrade", (req, socket) => {
  if (new URL(req.url, "http://localhost").pathname !== "/ws") { socket.destroy(); return; }
  // one page at a time: the one already connected is told it was replaced (it stops reconnecting; two open tabs
  // used to take the connection from each other every second)
  if (ws) { const old = ws; ws = null; old.send(JSON.stringify({ t: "replaced" })); old.close(); parentPort.postMessage({ t: "closed" }); }
  const c = acceptWebSocket(req, socket, msg => { if (ws === c) parentPort.postMessage({ t: "msg", data: msg }); },
    () => { if (ws === c) { ws = null; parentPort.postMessage({ t: "closed" }); } });
  if (!c) return;
  ws = c; parentPort.postMessage({ t: "open" });
});
parentPort.on("message", m => {
  if (m.t === "send") { if (ws) ws.send(typeof m.data === "string" ? m.data : Buffer.from(m.data.buffer ?? m.data, m.data.byteOffset ?? 0, m.data.byteLength)); }
  else if (m.t === "httpres") {
    const res = pending.get(m.id); if (!res) return; pending.delete(m.id);
    res.writeHead(m.status, m.headers ?? {}); res.end(m.body == null ? undefined : typeof m.body === "string" ? m.body : Buffer.from(m.body.buffer ?? m.body, m.body.byteOffset ?? 0, m.body.byteLength));
  }
  else if (m.t === "close") { if (ws) { const c = ws; ws = null; c.close(); } }
});
server.listen(workerData.port, workerData.host ?? "127.0.0.1", () => parentPort.postMessage({ t: "listening", port: workerData.port }));
