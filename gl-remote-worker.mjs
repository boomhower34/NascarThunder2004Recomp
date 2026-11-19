// gl-remote-worker.mjs — runs gl-remote.mjs FramePacker on its own thread: receives captured frames from the emulator
// thread (transferred, not copied), sends back the finished client message (transferred).
import { parentPort } from "node:worker_threads";
import { FramePacker } from "./gl-remote.mjs";

const packer = new FramePacker();
let out_ = parentPort;                           // results go to the port the emulator thread gives (it can read it synchronously)
parentPort.on("message", msg => {
  if (msg.port) { out_ = msg.port; return; }
  if (msg.reset) { packer.reset(); return; }
  const out = packer.pack(msg);
  const ab = out.byteOffset === 0 && out.byteLength === out.buffer.byteLength ? out.buffer : out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
  out_.postMessage({ ab, epoch: msg.epoch }, [ab]);
});
