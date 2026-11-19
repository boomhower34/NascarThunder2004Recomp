#!/usr/bin/env node
// uis-screen.mjs — parser and script disassembler for EA ll_api "UIStudio" screens (uis_*.dat).
//
// Containers: uis_<group>.dat is a TERF bundle; uis_all.dat is a TERF of 17 group TERFs. Each group entry is one
// screen (all entries LZH1-compressed). uis_gscr.dat holds the global screen (code/data shared by all screens;
// script addresses with bit 31 set point into it).
//
// Screen layout (offsets relative to the screen start; relocated at load by 0x139F70):
//   0x00 u32 stateCount     0x04 u32 statesOffset (= 0x30)
//   0x08 u32 stringCount    0x0C u32 stringsOffset     string = { u32 type(1), u32 capacity, u32 ptr -> char[] }
//   0x10 u32 strRefCount    0x14 u32 strRefsOffset     u32 offsets of fields holding a string index (-> string ptr)
//   0x18 u32 objCount       0x1C u32 objsOffset        screen-level objects { u16 type, u16 0, u32 ptr -> u32 dataOff }
//   0x20.. (screen-level object table, usually type 3 = string table, type 1 = sound)
//   state (0x14 bytes) = { u32 hdr, u32 childCount, u32 childPtrs, u32 eventCount, u32 events }
//     event (8 bytes)  = { u16 flags, s16 id, u32 code }  flags 0x8000 system event (id < 0) / message (id >= 0),
//                         0x4000 controller input (id = button), 0xC000 id -1 = child-state link, low bits = custom
//     child            = { u32 hdr, u32 itemCount, u32 items } item = { s16 type, u16 0, u32 ptr -> u32 dataOff }
//                         type -1 = nested state (ptr = state index), else an object type
// Object types (registered at 0x756B4 via 0x13A2D0): 0 0x13FC20, 1 0x9AC40 sound, 2 0x9A900 game hook,
//   3 0x9A990 localized string table, 4 0x9AB70 audio/EA Trax, 6 0x141130, 7 0x13F630, 8 0x142200 (5 unused).
// Script VM: 0x13CAB0, stack machine, opcode table at 0x13E324 (126 entries), see OPS below.
//
// usage:
//   node uis-screen.mjs list <uis_xxx.dat | uis_all.dat>             screens and their sizes/strings
//   node uis-screen.mjs dump <file> [--group G] [--screen S] [--code] structure (+ disassembly with --code)

import { readFileSync } from "node:fs";
import { parseTerf, isTerf } from "./terf.mjs";

export const ObjectTypes = { 0: "element", 1: "sound", 2: "gamehook", 3: "strtable", 4: "audio", 6: "obj6", 7: "obj7", 8: "obj8" };
export const PostKinds = { 0: "open", 1: "close", 2: "broadcast", 3: "activate", 4: "activate2", 5: "enable", 6: "disable",
                           7: "send", 8: "post8", 9: "post9" };

// [mnemonic, operand bytes]. Operand forms: 1 = u8, 4 = imm32, 6 = { i32 offset, s16 stackSlot (word index from sp) }, 7 = 6 + u8.
export const OPS = {
  0x01: ["nop", 0], 0x02: ["open_screen", 1], 0x03: ["close_screen", 0], 0x04: ["end", 0], 0x05: ["end", 0],
  0x06: ["rate_start", 0], 0x07: ["rate_stop", 0], 0x08: ["activate_screen", 0], 0x09: ["end", 0],
  0x0a: ["obj_call", 0], 0x0b: ["native_call", 0], 0x0c: ["send_event", 0], 0x0d: ["push_base", 0], 0x0e: ["strcpy", 0],
  0x0f: ["push", 4], 0x10: ["push", 4], 0x11: ["pushf", 4], 0x12: ["ftoi", 0], 0x13: ["itof", 0], 0x14: ["ftoi2", 0],
  0x15: ["itof2", 0], 0x16: ["end", 0], 0x17: ["end", 0], 0x18: ["load", 0], 0x19: ["store", 0], 0x1a: ["load_sp", 0],
  0x1b: ["store_sp", 0], 0x1c: ["and", 0], 0x1d: ["or", 0], 0x1e: ["not", 0], 0x1f: ["land", 0], 0x20: ["lor", 0],
  0x21: ["lnot", 0], 0x22: ["abs", 0], 0x23: ["fabs", 0], 0x24: ["neg", 0], 0x25: ["add", 0], 0x26: ["sub", 0],
  0x27: ["mul", 0], 0x28: ["div", 0], 0x29: ["fneg", 0], 0x2a: ["fadd", 0], 0x2b: ["fsub", 0], 0x2c: ["fmul", 0],
  0x2d: ["fdiv", 0], 0x2e: ["inc", 0], 0x2f: ["dec", 0], 0x30: ["finc", 0], 0x31: ["fdec", 0], 0x32: ["ge", 0],
  0x33: ["le", 0], 0x34: ["gt", 0], 0x35: ["lt", 0], 0x36: ["eq", 0], 0x37: ["ne", 0], 0x38: ["fge", 0], 0x39: ["fle", 0],
  0x3a: ["fgt", 0], 0x3b: ["flt", 0], 0x3c: ["feq", 0], 0x3d: ["fne", 0], 0x3e: ["jnz", 0], 0x3f: ["jz", 0],
  0x40: ["jmp", 0], 0x41: ["dup", 0], 0x42: ["pop", 0], 0x43: ["call", 4], 0x44: ["ret", 0], 0x45: ["open_close_var", 1],
  0x46: ["disable_state", 0], 0x47: ["enable_state_idx", 0], 0x48: ["activate_prev", 0], 0x49: ["strlen", 0],
  0x4a: ["strgetc", 0], 0x4b: ["strsetc", 0], 0x4c: ["sprintf", 0], 0x4d: ["post2", 0], 0x4e: ["skip4", 4],
  0x4f: ["clear_flags", 0], 0x50: ["set_flags", 0], 0x51: ["open_screen_wait", 1], 0x52: ["swap", 0], 0x53: ["end", 0],
  0x54: ["enable_state", 0], 0x55: ["ldind", 6], 0x56: ["stind", 6], 0x57: ["lea", 6], 0x58: ["tween", 1], 0x59: ["preload", 7],
  0x5a: ["mod", 0], 0x5b: ["aload_sp", 0], 0x5c: ["astore_sp", 0], 0x5d: ["aload_ptr", 0], 0x5e: ["astore_ptr", 0],
  0x5f: ["aload", 6], 0x60: ["astore", 6], 0x61: ["aload_spptr", 0], 0x62: ["astore_spptr", 0], 0x63: ["dupn", 4],
  0x64: ["popn", 4], 0x65: ["copyn", 4], 0x66: ["afill_sp", 0], 0x67: ["afill_ptr", 0], 0x68: ["afill", 6],
  0x69: ["addr_sp", 0], 0x6a: ["nop", 0], 0x6b: ["leaind", 6], 0x6c: ["aaddr_sp", 0], 0x6d: ["aaddr_ptr", 0],
  0x6e: ["aaddr", 6], 0x6f: ["strref", 0], 0x70: ["open_screen_wait", 1], 0x71: ["open_screen", 1], 0x72: ["post8", 0],
  0x73: ["rate_exists", 0], 0x74: ["flag_set", 0], 0x75: ["flag_test", 0], 0x76: ["post9", 0], 0x77: ["is_screen", 0],
  0x78: ["cur_screen", 0], 0x79: ["strcap", 0], 0x7a: ["strupper", 0], 0x7b: ["strlower", 0], 0x7c: ["strreplace", 0],
  0x7d: ["host_print", 0], 0x7e: ["enable_state", 0],
};
const ENDS = new Set([0x04, 0x05, 0x09, 0x16, 0x17, 0x53]);

export function parseScreen(b) {
  const u = o => b.readUInt32LE(o), cstr = o => { let e = o; while (e < b.length && b[e]) e++; return b.toString("latin1", o, e); };
  if (b.length < 0x30 || u(4) !== 0x30) throw new Error("not a UIStudio screen");
  const strings = [];
  for (let i = 0; i < u(8); i++) { const e = u(12) + i * 12; strings.push({ index: i, type: u(e), capacity: u(e + 4), offset: u(e + 8), text: cstr(u(e + 8)) }); }
  const objects = [];
  for (let i = 0; i < u(0x18); i++) { const e = u(0x1c) + i * 8; objects.push({ type: b.readUInt16LE(e), ref: u(e + 4), data: u(e + 4) ? u(u(e + 4)) : 0 }); }
  const states = [];
  for (let i = 0; i < u(0); i++) {
    const r = u(4) + i * 20;
    const events = [];
    for (let j = 0; j < u(r + 12); j++) { const e = u(r + 16) + j * 8; events.push({ flags: b.readUInt16LE(e), id: b.readInt16LE(e + 2), code: u(e + 4) }); }
    const children = [];
    for (let j = 0; j < u(r + 4); j++) {
      const c = u(u(r + 8) + j * 4), items = [];
      for (let q = 0; q < u(c + 4); q++) { const e = u(c + 8) + q * 8, t = b.readInt16LE(e);
        items.push(t === -1 ? { type: -1, state: u(e + 4) } : { type: t, ref: u(e + 4), data: u(u(e + 4)) }); }
      children.push({ offset: c, items });
    }
    states.push({ index: i, header: u(r), events, children });
  }
  return { size: b.length, strings, objects, states };
}

// Disassemble everything reachable from the event entry points (jump targets come from the preceding push).
export function disassemble(b, entries) {
  const insns = new Map(), work = [...entries], labels = new Set(entries);
  while (work.length) {
    let pc = work.pop(), last = null;
    while (pc < b.length && !insns.has(pc)) {
      const op = b[pc], def = OPS[op];
      if (!def) throw new Error(`bad opcode 0x${op.toString(16)} at 0x${pc.toString(16)}`);
      const [name, n] = def, at = pc; pc += 1 + n;
      let arg = null;
      if (n === 1) arg = b[at + 1];
      else if (n === 4) arg = op === 0x11 ? b.readFloatLE(at + 1) : b.readInt32LE(at + 1);
      else if (n >= 6) arg = { offset: b.readInt32LE(at + 1), slot: b.readInt16LE(at + 5), ...(n === 7 ? { mode: b[at + 7] } : {}) };
      const ins = { at, op, name, arg, size: 1 + n };
      if (op === 0x3e || op === 0x3f || op === 0x40) {
        if (last === null) throw new Error(`computed jump at 0x${at.toString(16)}`);
        ins.target = pc + last; labels.add(ins.target); work.push(ins.target);
      }
      if (op === 0x43 && !(arg & 0x80000000)) { labels.add(arg >>> 0); work.push(arg >>> 0); }
      insns.set(at, ins);
      if (ENDS.has(op) || op === 0x44 || op === 0x40) break;
      last = (op === 0x0f || op === 0x10) ? arg : null;
    }
  }
  return { insns: [...insns.values()].sort((a, c) => a.at - c.at), labels };
}

export function formatInsn(ins, strings) {
  const h = v => (v < 0 ? "-0x" + (-v).toString(16) : "0x" + v.toString(16));
  let s = ins.name;
  if (ins.target !== undefined) s += ` L_${ins.target.toString(16)}`;
  else if (ins.op === 0x43) s += (ins.arg & 0x80000000) ? ` global:0x${(ins.arg & 0x7fffffff).toString(16)}` : ` L_${(ins.arg >>> 0).toString(16)}`;
  else if (typeof ins.arg === "number") s += " " + (ins.op === 0x11 ? ins.arg.toPrecision(6) : h(ins.arg));
  else if (ins.arg) s += ` [sp${ins.arg.slot ? ins.arg.slot : ""}]+${h(ins.arg.offset)}` + (ins.arg.mode !== undefined ? ` ${ins.arg.mode}` : "");
  return s;
}

// Screens in a file: a raw screen, a group TERF, or uis_all.dat (TERF of group TERFs).
export function screensIn(buf) {
  if (!isTerf(buf)) return [{ group: 0, screen: 0, buf }];
  const t = parseTerf(buf), out = [];
  for (const e of t.entries) {
    const b = t.entry(e.index);
    if (isTerf(b)) { const g = parseTerf(b); for (const s of g.entries) out.push({ group: e.index, screen: s.index, buf: g.entry(s.index) }); }
    else if (b.length >= 0x30) out.push({ group: 0, screen: e.index, buf: b });
  }
  return out;
}

const evName = e => (e.flags === 0xc000 && e.id === -1) ? "child-link"
  : e.flags & 0x8000 ? (e.id < 0 ? `system${e.id}` : `message ${e.id}`)
  : e.flags & 0x4000 ? `input ${e.id}` : `custom 0x${e.flags.toString(16)}:${e.id}`;

function main() {
  const [cmd, file, ...rest] = process.argv.slice(2);
  if (!cmd || !file) { console.error("usage: node uis-screen.mjs list|dump <file> [--group G] [--screen S] [--code]"); process.exit(1); }
  const opt = k => { const i = rest.indexOf(k); return i >= 0 ? Number(rest[i + 1]) : null; };
  const g = opt("--group"), sc = opt("--screen"), code = rest.includes("--code");
  const screens = screensIn(readFileSync(file)).filter(s => (g === null || s.group === g) && (sc === null || s.screen === sc));
  for (const s of screens) {
    const p = parseScreen(s.buf);
    const ev = p.states.reduce((n, st) => n + st.events.length, 0), items = p.states.reduce((n, st) => n + st.children.reduce((m, c) => m + c.items.length, 0), 0);
    const title = p.strings.find(x => /[A-Za-z]{3}/.test(x.text))?.text ?? "";
    console.log(`group ${s.group} screen ${s.screen}: ${p.size} bytes, ${p.states.length} states, ${ev} events, ${items} items, ${p.strings.length} strings  "${title.slice(0, 50)}"`);
    if (cmd !== "dump") continue;
    console.log("  screen objects: " + p.objects.map(o => `${ObjectTypes[o.type] ?? o.type}@0x${o.data.toString(16)}`).join(", "));
    for (const st of p.states) {
      console.log(`  state ${st.index}`);
      for (const e of st.events) console.log(`    on ${evName(e)} -> ${e.code === 0xffffffff || (e.flags === 0xc000) ? "state " + e.code : "L_" + e.code.toString(16)}`);
      for (const c of st.children) console.log("    child: " + c.items.map(i => i.type === -1 ? `state ${i.state}` : `${ObjectTypes[i.type] ?? i.type}@0x${i.data.toString(16)}`).join(", "));
    }
    p.strings.forEach(x => x.text && console.log(`  str ${x.index} [${x.capacity}] ${JSON.stringify(x.text)}`));
    if (code) {
      const entries = p.states.flatMap(st => st.events.filter(e => e.flags !== 0xc000).map(e => e.code));
      const { insns, labels } = disassemble(s.buf, entries);
      for (const ins of insns) {
        if (labels.has(ins.at)) console.log(`L_${ins.at.toString(16)}:`);
        console.log(`    ${ins.at.toString(16).padStart(6)}  ${formatInsn(ins)}`);
      }
    }
  }
}

if (process.argv[1]?.endsWith("uis-screen.mjs")) main();
