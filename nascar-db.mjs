#!/usr/bin/env node
// nascar-db.mjs — reader + query engine for the game's EA "DB" databases (NASCAR.DB, the DBs inside GMODEDB.DAT).
//
// FILE FORMAT (little-endian)
//   0x00  "DB" 00 08
//   0x04  u32 0
//   0x08  u32 file size
//   0x0C  u32 0
//   0x10  u32 table count
//   0x14  u32 checksum
//   0x18  table directory: count x { char name[4], u32 offset }   (offset is from the end of the directory)
//
//   Table (at directory end + offset):
//   0x00  u32 crc            0x04 u32 flags (0x20 = has string pool, 0x40 = pool is Huffman-coded)
//   0x08  u32 record size    0x0C u32 record bits - 1
//   0x10  u32 string-pool size
//   0x14  u16 capacity       0x16 u16 record count
//   0x18  u16 ?              0x1A u16 0xFFFF
//   0x1C  u8  field count    0x1D u8  index count     0x1E..0x23 ?    0x24 u32 crc
//   0x28  fields: count x { u32 type, u32 bit offset, char name[4], u32 bits }
//         then records (capacity x record size), then the string pool, then index blocks (16 bytes each).
//
//   Field types: 0 = inline string (bits/8 bytes, NUL-padded), 2 = signed int, 3 = unsigned int, 4 = float32,
//                13 = pooled string (32-bit offset into the string pool; bits/8 = max length).
//   Bits are packed LSB-first: value = (record as little-endian integer >> bitOffset) & mask.
//   Pooled strings without flag 0x40: u8 length + characters.
//   Pooled strings with flag 0x40: the pool starts with a Huffman tree (2-byte entries; entry = 00 cc is a leaf for character cc,
//   otherwise it is a child node index; node n has children at entries 2n and 2n+1). Each string is
//   u8 length + bitstream, read MSB-first, starting at node 0, taking entry 2*node + bit.
//
// QUERY LANGUAGE (as used by the game, 833 query strings)
//   select F [into P] and F [into P] ... from T [inner join | left outer join T2 on A = B ...]
//          [where COND] [order by F [asc|desc] and F [asc|desc] ...]
//   update T set F = V and F = V ... [where COND]
//   insert into T set F = V and F = V ...
//   insert into T * select * from S [where COND]
//   delete from T [where COND]
//   COND: comparisons (= != < > <= >=) combined with and / or / parentheses.
//   Names are 4-character codes in quotes, optionally qualified 'TABLE'.'FIELD'. In the game's query strings the codes
//   are byte-reversed ('TSRD' = DRST); pass { reversedNames: true } to exec() for raw strings from the executable.
//   Parameters: ?, or the game's typed placeholders 0x80 int8, 0x81 int16, 0x82 int32, 0x83 uint8, 0x84 uint16,
//   0x85 uint32, 0x86 float, 0x88 string, 0x8A cursor handle, 0x8C table/field name, 0x8E sort direction
//   (non-zero / "desc" = descending) (lexer 0x1493D3: token = byte - 0x80). Aggregates count/max/min/sum/avg.
//   Cursors: "create ? cursor for select ..." then repeated "fetch from ? 'COL' into ? and ..." (one row per fetch).
//   (the type is the size/signedness of the C variable bound to it). Parameters are taken in order of appearance,
//   so "into" outputs and inputs share one list, as in the game's varargs call 0x1471D0(0, query, ...).
//
// CLI
//   node nascar-db.mjs tables NASCAR.DB GMODEDB.DAT              (any number of DB files / TERF bundles of DBs)
//   node nascar-db.mjs dump   NASCAR.DB outDir            (one JSON file per table)
//   node nascar-db.mjs query  NASCAR.DB "select 'FNAM' and 'LNAM' from 'DRVR' where 'DRID' < ?" 5

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const FieldType = { STRING: 0, INT: 2, UINT: 3, FLOAT: 4, POOLED_STRING: 13 };
export const ParamType = { 0x80: "int8", 0x81: "int16", 0x82: "int32", 0x83: "uint8", 0x84: "uint16", 0x85: "uint32",
                           0x86: "float", 0x88: "string", 0x8a: "cursor", 0x8c: "name", 0x8e: "order" };

// ---------------------------------------------------------------------------------------------- reading

function readBits(buf, start, bitOff, bits) {
  // LSB-first extraction of up to 32 bits from a record starting at byte `start`.
  let value = 0n;
  const firstByte = start + (bitOff >> 3), lastByte = start + ((bitOff + bits - 1) >> 3);
  for (let i = lastByte; i >= firstByte; i--) value = (value << 8n) | BigInt(buf[i]);
  value >>= BigInt(bitOff & 7);
  return Number(value & ((1n << BigInt(bits)) - 1n));
}

function writeBits(buf, start, bitOff, bits, v) {
  const firstByte = start + (bitOff >> 3), lastByte = start + ((bitOff + bits - 1) >> 3);
  let word = 0n;
  for (let i = lastByte; i >= firstByte; i--) word = (word << 8n) | BigInt(buf[i]);
  const shift = BigInt(bitOff & 7), mask = ((1n << BigInt(bits)) - 1n) << shift;
  word = (word & ~mask) | ((BigInt(v >>> 0) << shift) & mask);
  for (let i = firstByte; i <= lastByte; i++) { buf[i] = Number(word & 0xFFn); word >>= 8n; }
}

function huffmanString(buf, pool, treeLen, off) {
  const n = buf[pool + off];
  let bit = 0, out = "";
  const data = pool + off + 1;
  for (let c = 0; c < n; c++) {
    let node = 0;
    for (;;) {
      const b = (buf[data + (bit >> 3)] >> (7 - (bit & 7))) & 1;
      bit++;
      const e = pool + 2 * (2 * node + b);
      if (e + 1 >= pool + treeLen) throw new Error("bad Huffman data");
      if (buf[e] === 0) { out += String.fromCharCode(buf[e + 1]); break; }
      node = buf[e];
    }
  }
  return out;
}

export function parseDb(buf) {
  if (buf.toString("latin1", 0, 2) !== "DB") throw new Error("not an EA DB file");
  const count = buf.readUInt32LE(0x10);
  const dirEnd = 0x18 + 8 * count;
  const tables = new Map();
  for (let i = 0; i < count; i++) {
    const name = buf.toString("latin1", 0x18 + 8 * i, 0x18 + 8 * i + 4);
    const p = dirEnd + buf.readUInt32LE(0x18 + 8 * i + 4);
    const flags = buf.readUInt32LE(p + 4), recSize = buf.readUInt32LE(p + 8), poolSize = buf.readUInt32LE(p + 0x10);
    const capacity = buf.readUInt16LE(p + 0x14), recCount = buf.readUInt16LE(p + 0x16);
    const nf = buf[p + 0x1c], ni = buf[p + 0x1d];
    const fields = [];
    for (let k = 0; k < nf; k++) {
      const q = p + 0x28 + 16 * k;
      fields.push({ name: buf.toString("latin1", q + 8, q + 12), type: buf.readUInt32LE(q),
                    offset: buf.readUInt32LE(q + 4), bits: buf.readUInt32LE(q + 12) });
    }
    const recStart = p + 0x28 + 16 * nf, pool = recStart + capacity * recSize;
    const pooled = fields.filter(f => f.type === FieldType.POOLED_STRING);
    const huffman = (flags & 0x40) !== 0;
    let treeLen = 0;
    if (huffman && pooled.length && recCount) {
      treeLen = Infinity;
      for (let r = 0; r < recCount; r++)
        for (const f of pooled) treeLen = Math.min(treeLen, readBits(buf, recStart + r * recSize, f.offset, 32));
    }
    const rows = [];
    for (let r = 0; r < recCount; r++) {
      const rs = recStart + r * recSize, row = {};
      for (const f of fields) {
        switch (f.type) {
          case FieldType.STRING: {
            const s = rs + (f.offset >> 3), e = s + (f.bits >> 3);
            let z = s; while (z < e && buf[z] !== 0) z++;
            row[f.name] = buf.toString("latin1", s, z); break;
          }
          case FieldType.POOLED_STRING: {
            const off = readBits(buf, rs, f.offset, 32);
            row[f.name] = huffman ? huffmanString(buf, pool, treeLen, off)
                                  : buf.toString("latin1", pool + off + 1, pool + off + 1 + buf[pool + off]);
            break;
          }
          case FieldType.FLOAT: {
            const t = Buffer.alloc(4); t.writeUInt32LE(readBits(buf, rs, f.offset, 32) >>> 0);
            row[f.name] = t.readFloatLE(0); break;
          }
          case FieldType.INT: {
            const v = readBits(buf, rs, f.offset, f.bits);
            row[f.name] = f.bits < 32 && v >= 2 ** (f.bits - 1) ? v - 2 ** f.bits : (f.bits === 32 ? v | 0 : v); break;
          }
          default: row[f.name] = readBits(buf, rs, f.offset, f.bits);
        }
      }
      rows.push(row);
    }
    tables.set(name, { name, flags, recSize, capacity, indexCount: ni, fields, rows });
  }
  return new Database(tables);
}

// ---------------------------------------------------------------------------------------------- writing
// writeDb(tables): a DB image of the given tables (Map or array of { name, flags, recSize, capacity, fields, rows })
// in the file format above, readable by parseDb. Pools are written plain (no Huffman coding, flag 0x40 cleared),
// index blocks are left out (index count 0), CRCs and the checksum are 0.
export function writeDb(tables) {
  const list = [...(tables instanceof Map ? tables.values() : tables)];
  const parts = [];
  for (const t of list) {
    const pooled = t.fields.filter(f => f.type === FieldType.POOLED_STRING);
    const capacity = Math.max(t.capacity, t.rows.length), recSize = t.recSize;
    const poolParts = [], poolOf = new Map(); let poolSize = 0;
    const poolOffset = str => { str = String(str ?? ""); if (poolOf.has(str)) return poolOf.get(str);
      const b = Buffer.alloc(1 + Math.min(255, str.length)); b[0] = b.length - 1; b.write(str.slice(0, 255), 1, "latin1");
      poolOf.set(str, poolSize); poolParts.push(b); poolSize += b.length; return poolOf.get(str); };
    const head = Buffer.alloc(0x28 + 16 * t.fields.length), recs = Buffer.alloc(capacity * recSize);
    t.rows.forEach((row, r) => {
      const rs = r * recSize;
      for (const f of t.fields) {
        const v = row[f.name];
        switch (f.type) {
          case FieldType.STRING: { const s = rs + (f.offset >> 3); recs.fill(0, s, s + (f.bits >> 3)); recs.write(String(v ?? "").slice(0, f.bits >> 3), s, "latin1"); break; }
          case FieldType.POOLED_STRING: writeBits(recs, rs, f.offset, 32, poolOffset(v)); break;
          case FieldType.FLOAT: { const b = Buffer.alloc(4); b.writeFloatLE(Number(v) || 0); writeBits(recs, rs, f.offset, 32, b.readUInt32LE(0)); break; }
          default: writeBits(recs, rs, f.offset, f.bits, Number(v) || 0);
        }
      }
    });
    const pool = Buffer.concat(poolParts);
    head.writeUInt32LE(0, 0); head.writeUInt32LE((t.flags & ~0x40) | (pooled.length ? 0x20 : 0), 4);
    head.writeUInt32LE(recSize, 8); head.writeUInt32LE(recSize * 8 - 1, 0xc); head.writeUInt32LE(pool.length, 0x10);
    head.writeUInt16LE(capacity, 0x14); head.writeUInt16LE(t.rows.length, 0x16); head.writeUInt16LE(0xffff, 0x1a);
    head[0x1c] = t.fields.length; head[0x1d] = 0;
    t.fields.forEach((f, k) => { const q = 0x28 + 16 * k; head.writeUInt32LE(f.type, q); head.writeUInt32LE(f.offset, q + 4);
      head.write(f.name, q + 8, 4, "latin1"); head.writeUInt32LE(f.bits, q + 12); });
    const body = Buffer.concat([head, recs, pool]);
    parts.push({ name: t.name, body: Buffer.concat([body, Buffer.alloc((4 - body.length % 4) % 4)]) });
  }
  const dir = Buffer.alloc(0x18 + 8 * parts.length);
  dir.write("DB", 0, "latin1"); dir[2] = 0; dir[3] = 8; dir.writeUInt32LE(parts.length, 0x10);
  let off = 0;
  parts.forEach((p, i) => { dir.write(p.name, 0x18 + 8 * i, 4, "latin1"); dir.writeUInt32LE(off, 0x1c + 8 * i); off += p.body.length; });
  const out = Buffer.concat([dir, ...parts.map(p => p.body)]);
  out.writeUInt32LE(out.length, 8);
  return out;
}

// ---------------------------------------------------------------------------------------------- query engine

function tokenize(q, reversed) {
  const toks = [];
  let i = 0;
  while (i < q.length) {
    const c = q[i], code = q.charCodeAt(i);
    if (/\s/.test(c)) { i++; continue; }
    if (c === "'") {
      const j = q.indexOf("'", i + 1);
      let name = q.slice(i + 1, j);
      if (reversed) name = [...name].reverse().join("");
      toks.push({ t: "name", v: name }); i = j + 1; continue;
    }
    if (c === "?" || (code >= 0x80 && code <= 0x8e)) { toks.push({ t: "param", v: ParamType[code] || "any" }); i++; continue; }
    const two = q.slice(i, i + 2);
    if (["!=", "<=", ">=", "<>", "=="].includes(two)) { toks.push({ t: "op", v: two === "<>" ? "!=" : two === "==" ? "=" : two }); i += 2; continue; }
    if ("=<>".includes(c)) { toks.push({ t: "op", v: c }); i++; continue; }
    if ("().*,".includes(c)) { toks.push({ t: c }); i++; continue; }
    const m = /^-?\d+(\.\d+)?f?/.exec(q.slice(i));   // C-style float suffix ("0.0f") appears in a few queries
    if (m) { toks.push({ t: "num", v: parseFloat(m[0]) }); i += m[0].length; continue; }
    const w = /^[A-Za-z_]+/.exec(q.slice(i));
    if (w) { toks.push({ t: "kw", v: w[0].toLowerCase() }); i += w[0].length; continue; }
    throw new Error(`unexpected character ${JSON.stringify(c)} at ${i} in query: ${q}`);
  }
  return toks;
}

class Parser {
  constructor(toks) { this.toks = toks; this.i = 0; this.paramIndex = 0; }
  peek(o = 0) { return this.toks[this.i + o]; }
  isKw(v, o = 0) { const t = this.peek(o); return t && t.t === "kw" && t.v === v; }
  next() { return this.toks[this.i++]; }
  expectKw(v) { const t = this.next(); if (!t || t.t !== "kw" || t.v !== v) throw new Error(`expected "${v}"`); }
  column() {
    for (const fn of ["count", "max", "min", "sum", "avg"]) if (this.isKw(fn) && this.peek(1)?.t === "(") {
      this.next(); this.next(); let arg = null;
      if (this.peek().t === "*") this.next(); else arg = this.column();
      if (this.next()?.t !== ")") throw new Error(`bad ${fn}()`);
      return { agg: fn, arg };
    }
    if (this.peek() && this.peek().t === "param") {
      this.next(); const a = { tableParam: this.paramIndex++ };
      if (this.peek()?.t === "." && this.peek(1)?.t === "param") { this.next(); this.next(); return { table: a, field: { tableParam: this.paramIndex++ } }; }
      return { table: null, field: a };
    }
    const a = this.next();
    if (!a || a.t !== "name") throw new Error("expected a quoted name");
    if (this.peek() && this.peek().t === ".") { this.next(); const b = this.next(); return { table: a.v, field: b.v }; }
    return { table: null, field: a.v };
  }
  operand() {
    const t = this.peek();
    // a name parameter (0x8C) is a column whose name comes from the caller: "where \x8c = \x82" (the career parts
    // lists' type / selected-chassis lookups by the list's ID column) compared the name itself with the value, found
    // nothing, and the game printed what was left in its uninitialised output (Short Track / Generic flipping)
    if (t.t === "param" && t.v === "name") return { col: this.column() };
    if (t.t === "param") { this.next(); return { param: this.paramIndex++, ptype: t.v }; }
    if (t.t === "num") { this.next(); return { num: t.v }; }
    return { col: this.column() };
  }
  cond() { // or-level
    let left = this.condAnd();
    while (this.isKw("or")) { this.next(); left = { or: [left, this.condAnd()] }; }
    return left;
  }
  condAnd() {
    let left = this.condAtom();
    while (this.isKw("and")) { this.next(); left = { and: [left, this.condAtom()] }; }
    return left;
  }
  condAtom() {
    if (this.peek().t === "(") { this.next(); const c = this.cond(); if (this.next().t !== ")") throw new Error("expected )"); return c; }
    if (this.isKw("not")) { this.next(); return { not: this.condAtom() }; }
    const a = this.operand(), op = this.next();
    if (!op || op.t !== "op") throw new Error("expected comparison operator");
    return { cmp: op.v, a, b: this.operand() };
  }
  parse() {
    const t = this.next();
    if (t.t !== "kw") throw new Error("query must start with a keyword");
    if (t.v === "select") return this.select();
    if (t.v === "create" || t.v === "declare") {           // create/declare ? cursor for select ...
      const c = this.next(); if (!c || c.t !== "param") throw new Error("expected cursor parameter");
      const cursorParam = this.paramIndex++; this.expectKw("cursor"); this.expectKw("for"); this.expectKw("select");
      return { kind: "createCursor", cursorParam, select: this.select() };
    }
    if (t.v === "fetch") {                                    // fetch from ? 'COL' into ? and ...
      this.expectKw("from"); const c = this.next(); if (!c || c.t !== "param") throw new Error("expected cursor parameter");
      const cursorParam = this.paramIndex++, cols = [];
      do { const col = this.column(); this.expectKw("into"); const p = this.next(); cols.push({ col, into: { param: this.paramIndex++, ptype: p.v } }); }
      while (this.isKw("and") && this.next());
      return { kind: "fetch", cursorParam, cols };
    }
    if (t.v === "update") {
      const table = this.column().field; this.expectKw("set");
      const sets = this.assignments();
      const where = this.isKw("where") ? (this.next(), this.cond()) : null;
      return { kind: "update", table, sets, where };
    }
    if (t.v === "delete") {
      this.expectKw("from"); const table = this.column().field;
      const where = this.isKw("where") ? (this.next(), this.cond()) : null;
      return { kind: "delete", table, where };
    }
    if (t.v === "insert") {
      this.expectKw("into"); const table = this.column().field;
      if (this.peek().t === "*") { this.next(); this.expectKw("select"); return { kind: "insertSelect", table, select: this.select() }; }
      this.expectKw("set");
      return { kind: "insert", table, sets: this.assignments() };
    }
    throw new Error(`unsupported statement "${t.v}"`);
  }
  assignments() {
    const sets = [];
    do {
      const col = this.column(); const op = this.next();
      if (op.t !== "op" || op.v !== "=") throw new Error("expected = in assignment");
      sets.push({ col, value: this.operand() });
    } while (this.isKw("and") && this.next());
    return sets;
  }
  select() {
    const cols = [];
    if (this.peek().t === "*") { this.next(); cols.push({ star: true }); }
    else do {
      const col = this.column(); const item = { col };
      if (this.isKw("into")) { this.next(); const p = this.next(); item.into = { param: this.paramIndex++, ptype: p.v }; }
      cols.push(item);
    } while (this.isKw("and") && this.next());
    this.expectKw("from");
    const from = this.column().field, joins = [];
    while (this.isKw("inner") || this.isKw("left") || this.isKw("join")) {
      let type = "inner";
      if (this.isKw("left")) { this.next(); if (this.isKw("outer")) this.next(); type = "left"; }
      else if (this.isKw("inner")) this.next();
      this.expectKw("join");
      const table = this.column().field; this.expectKw("on");
      joins.push({ type, table, on: this.cond() });
    }
    const where = this.isKw("where") ? (this.next(), this.cond()) : null;
    const order = [];
    if (this.isKw("order")) {
      this.next(); this.expectKw("by");
      do {
        const col = this.column(); let desc = false, descParam;
        if (this.isKw("desc")) { this.next(); desc = true; } else if (this.isKw("asc")) this.next();
        else if (this.peek()?.t === "param") { this.next(); descParam = this.paramIndex++; }
        order.push({ col, desc, descParam });
      } while ((this.isKw("and") && this.next()) || this.peek()?.t === "name");   // one game query omits the "and"
    }
    return { kind: "select", cols, from, joins, where, order };
  }
}

export function parseQuery(q, { reversedNames = false } = {}) {
  const p = new Parser(tokenize(q, reversedNames));
  const ast = p.parse();
  if (p.i !== p.toks.length) throw new Error(`unparsed trailing tokens in: ${q}`);
  ast.paramCount = p.paramIndex;
  return ast;
}

// hash key matching the queries' loose "=" (a == b): numbers and numeric strings meet as numbers; null / undefined
// never match
const keyOf = v => { if (v === null || v === undefined) return undefined; if (typeof v !== "string") return v; const t = v.trim(); return t === "" ? 0 : isNaN(t) ? v : Number(t); };
const PRED_CACHE = new WeakMap(), COLS_CACHE = new WeakMap();
export class Database {
  constructor(tables) { this.tables = tables; }
  // room past a table's capacity for rows that are never saved (nt04-config: added tracks' rows in the per-home-track
  // tables of a profile, whose saved size the game checks): { [table]: { extra, field, values: Set } }
  overflow = {};
  #cap(t) { return t.capacity + (this.overflow[t.name]?.extra ?? 0); }
  // the rows of a table as a save image keeps them (without the overflow rows)
  savedRows(t) { const o = this.overflow[t.name]; return o ? t.rows.filter(r => !o.values.has(r[o.field])) : t.rows; }
  table(name, params = [], opts = {}) {
    if (name && typeof name === "object") { name = String(params[name.tableParam] ?? ""); if (opts.reversedNames) name = [...name].reverse().join(""); }
    const t = this.tables.get(name); if (!t) throw new Error(`no table ${name}`); return t;
  }

  // Run a query. params: array in order of appearance (outputs included, value ignored).
  // Returns { rows, columns, outputs, changed }. For "select ... into", outputs[i] holds the first row's value for
  // the i-th parameter slot (undefined if no row), matching the game's write-back through pointer arguments.
  exec(q, params = [], opts = {}) {
    const ast = typeof q === "string" ? parseQuery(q, opts) : q;
    this.opts = opts; this.params = params;
    switch (ast.kind) {
      case "select": return this.#select(ast, params);
      case "createCursor": {
        const r = this.#select(ast.select, params, "ctx"), cursor = { ctxs: r.ctxs, base: r.base, pos: 0 };
        const outputs = []; outputs[ast.cursorParam] = cursor; return { outputs, cursor, rows: [] };
      }
      case "fetch": {
        const cur = params[ast.cursorParam], outputs = [];
        if (!cur || cur.pos >= cur.ctxs.length) return { outputs, rows: [], done: true };
        const ctx = cur.ctxs[cur.pos++];
        for (const c of ast.cols) outputs[c.into.param] = this.#lookup(c.col, ctx, cur.base);
        return { outputs, rows: [ast.cols.map(c => outputs[c.into.param])], done: false };
      }
      case "update": {
        const t = this.table(ast.table, params, this.opts); let changed = 0;
        const pred = ast.where ? this.#rowPred(ast.where, t.name) : null, cand = pred ? this.#candidates(t, ast.where, params) : null;
        for (const row of (cand ? [...cand] : t.rows)) if (!ast.where || (pred ? pred(row, params) : this.#eval(ast.where, { [t.name]: row }, t.name, params))) {
          for (const s of ast.sets) { const f = this.#fieldName(s.col.field, params); row[f] = this.#coerce(t, f, this.#value(s.value, { [t.name]: row }, t.name, params)); }
          changed++;
        }
        if (changed) { const e = this.#idx.get(t); if (e) for (const st of ast.sets) e.by.delete(this.#fieldName(st.col.field, params)); }   // only the indexes of the fields it set
        return { changed };
      }
      case "delete": {
        const t = this.table(ast.table, params, this.opts), before = t.rows.length;
        const pred = ast.where ? this.#rowPred(ast.where, t.name) : null, cand = pred ? this.#candidates(t, ast.where, params) : null;
        if (cand) { const del = new Set(cand.filter(row => pred(row, params))); if (del.size) t.rows = t.rows.filter(row => !del.has(row)); }
        else t.rows = t.rows.filter(row => !(ast.where ? (pred ? pred(row, params) : this.#eval(ast.where, { [t.name]: row }, t.name, params)) : true));
        t.ver = (t.ver | 0) + 1;
        return { changed: before - t.rows.length };
      }
      case "insert": {
        const t = this.table(ast.table, params, this.opts);
        if (t.rows.length >= this.#cap(t)) throw new Error(`table ${t.name} is full (${t.capacity})`);
        const row = Object.fromEntries(t.fields.map(f => [f.name, f.type === 0 || f.type === 13 ? "" : 0]));
        for (const s of ast.sets) { const f = this.#fieldName(s.col.field, params); row[f] = this.#coerce(t, f, this.#value(s.value, {}, t.name, params)); }
        t.rows.push(row); t.ver = (t.ver | 0) + 1;
        return { changed: 1 };
      }
      case "insertSelect": {
        const t = this.table(ast.table, params, this.opts), src = this.#select(ast.select, params, true);
        for (const r of src.rawRows) {
          if (t.rows.length >= this.#cap(t)) throw new Error(`table ${t.name} is full (${t.capacity})`);
          const row = Object.fromEntries(t.fields.map(f => [f.name, r[f.name] ?? (f.type === 0 || f.type === 13 ? "" : 0)]));
          t.rows.push(row);
        }
        t.ver = (t.ver | 0) + 1;
        return { changed: src.rawRows.length };
      }
    }
  }

  // a field given by a name parameter ({tableParam}) holds the 4-char name in query order (reversed when the
  // queries use reversed names)
  #fieldName(f, params) {
    if (f && typeof f === "object") { let n = String(params[f.tableParam] ?? ""); if (this.opts?.reversedNames) n = [...n].reverse().join(""); return n; }
    return f;
  }
  #coerce(t, field, v) {
    const f = t.fields.find(x => x.name === field);
    if (!f) throw new Error(`no field ${field} in ${t.name}`);
    if (f.type === FieldType.FLOAT) return Math.fround(Number(v));
    if (f.type === FieldType.INT) { const m = 2 ** f.bits; let x = Math.trunc(Number(v)) % m; if (x >= m / 2) x -= m; if (x < -m / 2) x += m; return x; }
    if (f.type === FieldType.UINT) { const m = 2 ** f.bits; return ((Math.trunc(Number(v)) % m) + m) % m; }
    return String(v);
  }

  #name(n) { if (n && typeof n === "object") { let v = String(this.params?.[n.tableParam] ?? ""); if (this.opts?.reversedNames) v = [...v].reverse().join(""); return v; } return n; }
  #lookup(col, ctx, defTable) {
    if (typeof col.table === "object" || typeof col.field === "object") col = { table: this.#name(col.table), field: this.#name(col.field) };
    if (col.table) { const r = ctx[col.table]; return r ? r[col.field] : null; }
    if (ctx[defTable] && col.field in ctx[defTable]) return ctx[defTable][col.field];
    for (const k in ctx) if (ctx[k] && col.field in ctx[k]) return ctx[k][col.field];
    return null;
  }
  #value(o, ctx, defTable, params) {
    if ("param" in o) return params[o.param];
    if ("num" in o) return o.num;
    return this.#lookup(o.col, ctx, defTable);
  }
  #eval(c, ctx, defTable, params) {
    if (c.and) return this.#eval(c.and[0], ctx, defTable, params) && this.#eval(c.and[1], ctx, defTable, params);
    if (c.or) return this.#eval(c.or[0], ctx, defTable, params) || this.#eval(c.or[1], ctx, defTable, params);
    if (c.not) return !this.#eval(c.not, ctx, defTable, params);
    const a = this.#value(c.a, ctx, defTable, params), b = this.#value(c.b, ctx, defTable, params);
    if (a === null || b === null || a === undefined || b === undefined) return false;
    switch (c.cmp) {
      case "=": return a == b; case "!=": return a != b;
      case "<": return a < b; case ">": return a > b; case "<=": return a <= b; case ">=": return a >= b;
    }
  }
  // { field, other } when cond is (or ANDs in) col(joined table).field = value-not-from-the-joined-table
  #joinKey(c, jname, defTable) {
    if (!c) return null;
    if (c.and) return this.#joinKey(c.and[0], jname, defTable) ?? this.#joinKey(c.and[1], jname, defTable);
    if (c.cmp !== "=") return null;
    const own = o => o.col && this.#name(o.col.table) === jname && typeof o.col.field === "string" ? o.col.field : null;
    const outside = o => "param" in o || "num" in o || (o.col && o.col.table && this.#name(o.col.table) !== jname);
    if (own(c.a) && outside(c.b)) return { field: own(c.a), other: c.b };
    if (own(c.b) && outside(c.a)) return { field: own(c.b), other: c.a };
    return null;
  }
  // A WHERE condition on one table compiled to a row predicate (cached per condition node and table): the same
  // semantics as #eval over the context { [table]: row } — qualified columns of another table are null, an
  // unqualified column is the row's field when it has it, null / undefined never compare true, "=" is loose.
  // null when a name comes from a parameter ({tableParam}). Season-hub queries scanned CARS / CRSK / DRVR at
  // ~3 µs a row through #eval (8-12 ms a query).
  #rowPred(c, tname) {
    let per = PRED_CACHE.get(c); if (!per) PRED_CACHE.set(c, per = new Map());
    const k = tname + (this.opts?.reversedNames ? "/r" : ""); if (per.has(k)) return per.get(k);
    const value = o => {
      if ("param" in o) { const i = o.param; return (row, P) => P[i]; }
      if ("num" in o) { const v = o.num; return () => v; }
      const col = o.col; if ((col.table && typeof col.table === "object") || typeof col.field !== "string" || col.agg) throw 0;
      const f = col.field;
      if (col.table) return col.table === tname ? row => row[f] : () => null;
      return row => (f in row ? row[f] : null);
    };
    const build = c => {
      if (c.and) { const a = build(c.and[0]), b = build(c.and[1]); return (r, P) => a(r, P) && b(r, P); }
      if (c.or) { const a = build(c.or[0]), b = build(c.or[1]); return (r, P) => a(r, P) || b(r, P); }
      if (c.not) { const a = build(c.not); return (r, P) => !a(r, P); }
      const A = value(c.a), B = value(c.b), ok = v => v !== null && v !== undefined;
      switch (c.cmp) {
        case "=": return (r, P) => { const a = A(r, P), b = B(r, P); return ok(a) && ok(b) && a == b; };
        case "!=": return (r, P) => { const a = A(r, P), b = B(r, P); return ok(a) && ok(b) && a != b; };
        case "<": return (r, P) => { const a = A(r, P), b = B(r, P); return ok(a) && ok(b) && a < b; };
        case ">": return (r, P) => { const a = A(r, P), b = B(r, P); return ok(a) && ok(b) && a > b; };
        case "<=": return (r, P) => { const a = A(r, P), b = B(r, P); return ok(a) && ok(b) && a <= b; };
        case ">=": return (r, P) => { const a = A(r, P), b = B(r, P); return ok(a) && ok(b) && a >= b; };
      }
      throw 0;
    };
    let fn = null; try { fn = build(c); } catch { fn = null; }
    per.set(k, fn); return fn;
  }
  // Equality indexes for single-table WHERE conditions: an "=" in the condition's AND chain between a column of the
  // table and a parameter / number picks the candidate rows from a per-field index (value → rows in table order);
  // the whole condition is still evaluated on them. An index is rebuilt when the table's rows array, its length or
  // its write counter (bumped by every insert / delete through exec) changes — an update drops the indexes of the
  // fields it sets; invalidate() drops them all
  // (nt04-config edits rows in place). The season hub ran ~600 small queries in two frames (~150 ms).
  invalidate() { this.#idx = new WeakMap(); }
  #idx = new WeakMap();
  #eqTerm(c, t) {
    if (!c) return null;
    if (c.and) return this.#eqTerm(c.and[0], t) ?? this.#eqTerm(c.and[1], t);
    if (c.cmp !== "=") return null;
    const field = o => { const col = o.col; if (!col || (col.table && typeof col.table === "object") || typeof col.field !== "string") return null;
      if (col.table && col.table !== t.name) return null; return t.fields.some(f => f.name === col.field) ? col.field : null; };
    const lit = o => "param" in o || "num" in o;
    if (field(c.a) && lit(c.b)) return { field: field(c.a), other: c.b };
    if (field(c.b) && lit(c.a)) return { field: field(c.b), other: c.a };
    return null;
  }
  #candidates(t, where, params) {
    const eq = this.#eqTerm(where, t); if (!eq) return null;
    let e = this.#idx.get(t);
    if (!e || e.rows !== t.rows || e.len !== t.rows.length || e.ver !== (t.ver | 0)) this.#idx.set(t, e = { rows: t.rows, len: t.rows.length, ver: t.ver | 0, by: new Map() });
    let m = e.by.get(eq.field);
    if (!m) { m = new Map(); for (const r of t.rows) { const k = keyOf(r[eq.field]); if (k === undefined) continue; const l = m.get(k); if (l) l.push(r); else m.set(k, [r]); } e.by.set(eq.field, m); }
    const v = "param" in eq.other ? params[eq.other.param] : eq.other.num;
    return m.get(keyOf(v)) ?? [];
  }
  // column getters for a one-table select (cached per AST and table), null when a column is an aggregate or a
  // parameter name; values as #lookup gives them over { [table]: row }
  #plainCols(ast, base) {
    let per = COLS_CACHE.get(ast); if (!per) COLS_CACHE.set(ast, per = new Map());
    if (per.has(base)) return per.get(base);
    let out = null;
    if (ast.cols.length === 1 && ast.cols[0].star) out = { star: true, names: base.fields.map(f => f.name) };
    else if (ast.cols.every(c => c.col && !c.col.agg && !(c.col.table && typeof c.col.table === "object") && typeof c.col.field === "string")) {
      out = { star: false, names: ast.cols.map(c => (c.col.table ? c.col.table + "." : "") + c.col.field),
        get: ast.cols.map(c => { const f = c.col.field; return c.col.table ? (c.col.table === base.name ? r => r[f] : () => null) : r => (f in r ? r[f] : null); }) };
    }
    per.set(base, out); return out;
  }
  #select(ast, params, wantRaw = false) {
    const base = this.table(ast.from, params, this.opts);
    const pred = !ast.joins.length && ast.where ? this.#rowPred(ast.where, base.name) : null;
    // fast path: one table, plain columns, no order / aggregate — rows straight from the matching table rows
    if (!wantRaw && !ast.joins.length && !ast.order.length && (pred || !ast.where)) {
      const cols = this.#plainCols(ast, base);
      if (cols) {
        const cand = pred ? this.#candidates(base, ast.where, params) : null;
        const hit = pred ? (cand ?? base.rows).filter(r => pred(r, params)) : base.rows;
        const rows = cols.star ? hit.map(r => base.fields.map(f => r[f.name])) : hit.map(r => cols.get.map(g => g(r)));
        const outputs = []; if (!cols.star) ast.cols.forEach((c, i) => { if (c.into) outputs[c.into.param] = rows.length ? rows[0][i] : undefined; });
        return { columns: cols.names, rows, outputs };
      }
    }
    const cand = pred ? this.#candidates(base, ast.where, params) : null;
    let ctxs = (pred ? (cand ?? base.rows).filter(r => pred(r, params)) : base.rows).map(r => ({ [base.name]: r }));
    // A WHERE term on a left-joined table is part of that join: the left row stays (with the joined table null) when no
    // joined row passes it. The game's one left join (qualifying order 0xB1930: CARS left outer join DRST, where
    // DRST.YEAR = this season, order by DRST.CRNK) expects every car back when the season has no standings rows yet;
    // with the terms applied after the join the first race of a season / career got no cars, QUAL stayed empty and
    // the race weekend's Qualifying Order showed one car (driver 0, #43) in every slot.
    let whereTerms = null;
    const termsOf = c => (c?.and ? [...termsOf(c.and[0]), ...termsOf(c.and[1])] : c ? [c] : []);
    const refers = (c, t) => { if (!c) return false; if (c.and) return refers(c.and[0], t) || refers(c.and[1], t);
      if (c.or) return refers(c.or[0], t) || refers(c.or[1], t); if (c.not) return refers(c.not, t);
      return [c.a, c.b].some(o => o?.col && (typeof o.col.table === "object" ? this.#name(o.col.table) : o.col.table) === t); };
    for (const j of ast.joins) {
      const jt = this.table(j.table, params, this.opts), out = [];
      let on = j.on;
      if (j.type === "left" && ast.where) {
        whereTerms ??= termsOf(ast.where);
        const mine = whereTerms.filter(c => refers(c, jt.name));
        if (mine.length) { whereTerms = whereTerms.filter(c => !mine.includes(c)); on = mine.reduce((a, c) => ({ and: [a, c] }), on); }
      }
      // hash join: an equality in the ON condition between a column of the joined table and a value known before it
      // (another table's column, a parameter, a number) picks the candidate rows; the whole condition is still
      // evaluated on them, so the result (rows and order) is the nested loop's. The nested loop made a context
      // object for every row pair (driver select: ~300 ms of queries on CARS / ULDR / CRSK in one frame).
      const eq = this.#joinKey(j.on, jt.name, base.name);
      let index = null;
      if (eq) { index = new Map(); jt.rows.forEach(r => { const k = keyOf(r[eq.field]); if (k === undefined) return; const l = index.get(k); if (l) l.push(r); else index.set(k, [r]); }); }
      for (const ctx of ctxs) {
        let hit = false;
        const rows = index ? (index.get(keyOf(this.#value(eq.other, ctx, base.name, params))) ?? []) : jt.rows;
        for (const r of rows) {
          const c2 = { ...ctx, [jt.name]: r };
          if (this.#eval(on, c2, base.name, params)) { out.push(c2); hit = true; }
        }
        if (!hit && j.type === "left") out.push({ ...ctx, [jt.name]: null });
      }
      ctxs = out;
    }
    const where = whereTerms ? (whereTerms.length ? whereTerms.reduce((a, c) => ({ and: [a, c] })) : null) : ast.where;
    if (where && !pred) ctxs = ctxs.filter(ctx => this.#eval(where, ctx, base.name, params));
    if (ast.order.length) {
      ctxs.sort((x, y) => {
        for (const o of ast.order) {
          const a = this.#lookup(o.col, x, base.name), b = this.#lookup(o.col, y, base.name);
          if (a === b) continue;
          if (a === null) return 1; if (b === null) return -1;
          const desc = o.descParam !== undefined ? (params[o.descParam] === "desc" || (typeof params[o.descParam] === "number" && params[o.descParam] !== 0)) : o.desc;
          return (a < b ? -1 : 1) * (desc ? -1 : 1);
        }
        return 0;
      });
    }
    if (wantRaw === "ctx") return { ctxs, base: base.name };
    if (wantRaw) return { rawRows: ctxs.map(c => c[base.name]) };
    if (ast.cols.some(c => c.col?.agg)) {                     // aggregates: count(*) / count(c) / max / min / sum / avg
      const vals = c => ctxs.map(ctx => this.#lookup(c.col.arg, ctx, base.name)).filter(v => v !== null && v !== undefined);
      const row = ast.cols.map(c => {
        const a = c.col.agg; if (!a) return ctxs.length ? this.#lookup(c.col, ctxs[0], base.name) : null;
        if (a === "count") return c.col.arg ? vals(c).length : ctxs.length;
        const v = vals(c); if (!v.length) return null;
        return a === "max" ? Math.max(...v) : a === "min" ? Math.min(...v) : a === "sum" ? v.reduce((x, y) => x + y, 0) : v.reduce((x, y) => x + y, 0) / v.length;
      });
      const outputs = []; ast.cols.forEach((c, i) => { if (c.into) outputs[c.into.param] = row[i]; });
      return { columns: ast.cols.map(c => c.col.agg ?? c.col.field), rows: [row], outputs };
    }
    const star = ast.cols.length === 1 && ast.cols[0].star;
    const columns = star ? base.fields.map(f => f.name) : ast.cols.map(c => (c.col.table ? c.col.table + "." : "") + c.col.field);
    const rows = ctxs.map(ctx => star ? base.fields.map(f => ctx[base.name][f.name])
                                      : ast.cols.map(c => this.#lookup(c.col, ctx, base.name)));
    const outputs = [];
    ast.cols.forEach((c, i) => { if (c.into) outputs[c.into.param] = rows.length ? rows[0][i] : undefined; });
    return { columns, rows, outputs };
  }

  toJSON() {
    return Object.fromEntries([...this.tables].map(([k, t]) => [k, { capacity: t.capacity, fields: t.fields, rows: t.rows }]));
  }
}

// Load one or more files into a single Database. Accepts plain DB files and TERF bundles of DB files
// (GMODEDB.DAT). Later files do not replace tables already loaded (the game keeps them as separate databases,
// but table names do not collide, so one namespace works for queries).
export function openDatabases(paths) {
  const tables = new Map();
  for (const path of paths) {
    const buf = readFileSync(path);
    const parts = [];
    if (buf.toString("latin1", 0, 4) === "TERF") {
      const align = buf.readUInt32LE(4), count = buf.readUInt16LE(14);
      let pos = align, dir = -1, data = -1;
      while (pos + 8 <= buf.length && data < 0) {
        const tag = buf.toString("latin1", pos, pos + 4), size = buf.readUInt32LE(pos + 4);
        if (tag === "DIR1") dir = pos; else if (tag === "DATA") data = pos; else throw new Error(`${path}: chunk ${tag}`);
        if (data < 0) pos += Math.ceil(Math.max(size, 8) / align) * align;
      }
      for (let i = 0; i < count; i++) {
        const off = data + buf.readUInt32LE(dir + 8 + 8 * i), size = buf.readUInt32LE(dir + 12 + 8 * i);
        if (buf.toString("latin1", off, off + 2) === "DB") parts.push(buf.subarray(off, off + size));
      }
    } else parts.push(buf);
    for (const part of parts)
      for (const [name, t] of parseDb(part).tables) if (!tables.has(name)) tables.set(name, t);
  }
  return new Database(tables);
}

// ---------------------------------------------------------------------------------------------- CLI

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const files = [];
  while (args.length && /\.(db|dat)$/i.test(args[0])) files.push(args.shift());
  const rest = args;
  if (!cmd || !files.length) {
    console.error("usage: node nascar-db.mjs tables|dump|query <file.db|GMODEDB.DAT>... [outDir | query params...]");
    process.exit(1);
  }
  const db = openDatabases(files);
  if (cmd === "tables") {
    for (const t of db.tables.values())
      console.log(`${t.name}  rows ${String(t.rows.length).padStart(5)}/${String(t.capacity).padEnd(5)}  fields: ${t.fields.map(f => f.name).join(" ")}`);
  } else if (cmd === "dump") {
    const out = rest[0]; mkdirSync(out, { recursive: true });
    for (const t of db.tables.values())
      writeFileSync(join(out, `${t.name.trim() || "_"}.json`), JSON.stringify({ name: t.name, capacity: t.capacity, fields: t.fields, rows: t.rows }, null, 1));
    console.log(`wrote ${db.tables.size} tables to ${out}`);
  } else if (cmd === "query") {
    const [q, ...params] = rest;
    const r = db.exec(q, params.map(p => (isNaN(p) ? p : Number(p))));
    console.log(JSON.stringify(r, null, 1));
  } else throw new Error(`unknown command ${cmd}`);
}

if (process.argv[1] && process.argv[1].endsWith("nascar-db.mjs")) main();
