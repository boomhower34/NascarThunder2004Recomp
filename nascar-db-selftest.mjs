#!/usr/bin/env node
// nascar-db-selftest.mjs — regression test for nascar-db.mjs.
// Loads NASCAR.DB + GMODEDB.DAT, checks every pooled string decodes, parses all 833 game queries from
// db_queries.json and executes each one (on a fresh copy, with every parameter = 1), then checks a few known values.
//
// usage: node nascar-db-selftest.mjs <Data folder> [db_queries.json]

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabases, parseQuery } from "./nascar-db.mjs";

const dataDir = process.argv[2];
const queriesFile = process.argv[3] || new URL("./db_queries.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
if (!dataDir) { console.error("usage: node nascar-db-selftest.mjs <Data folder> [db_queries.json]"); process.exit(1); }
const files = [join(dataDir, "NASCAR.DB"), join(dataDir, "GMODEDB.DAT")];
const load = () => openDatabases(files);

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures++; };

const db = load();
let rows = 0, strings = 0;
for (const t of db.tables.values()) {
  rows += t.rows.length;
  for (const r of t.rows) for (const f of t.fields) if (f.type === 13) strings++;
}
check(db.tables.size === 261, `tables loaded: ${db.tables.size} (expected 261)`);
console.log(`     ${rows} rows, ${strings} pooled strings`);

const queries = Object.values(JSON.parse(readFileSync(queriesFile, "utf8"))).map(v => v.query);
let parsed = 0, ran = 0, capacity = 0; const errors = [];
for (const q of queries) {
  let ast;
  try { ast = parseQuery(q); parsed++; } catch (e) { errors.push(`parse: ${e.message}`); continue; }
  try { load().exec(ast, new Array(ast.paramCount).fill(1)); ran++; }
  catch (e) { if (/is full/.test(e.message)) capacity++; else errors.push(`run: ${e.message} | ${q.slice(0, 100)}`); }
}
check(parsed === queries.length, `queries parsed: ${parsed}/${queries.length}`);
check(ran + capacity === queries.length && errors.length === 0,
      `queries executed: ${ran}, table-full with dummy params: ${capacity}, other errors: ${errors.length}`);
errors.slice(0, 10).forEach(e => console.log("     " + e));

const year = db.exec("select 'YEAR' into ? from 'GINF'", [null]).outputs[0];
check(year === 2003, `GINF.YEAR = ${year}`);
const top = db.exec("select 'DRVR'.'LNAM' and 'DRST'.'CPNT' from 'DRVR' inner join 'DRST' on 'DRVR'.'DRID' = 'DRST'.'DRID' " +
                    "where 'DRST'.'YEAR' = ? order by 'DRST'.'CPNT' desc", [2002]).rows[0];
check(top && top[0] === "Stewart" && top[1] === 4800, `2002 points leader: ${top}`);
const ach = db.table("ACMP").rows[0].DESC;
check(ach === "Earned Top 5 finish in Race Now", `Huffman string ACMP[0].DESC = "${ach}"`);
const raw = "select 'MANL' into \x82 from 'RVRD' where 'DIRD' = \x82"; // byte-reversed names, as in the executable
check(db.exec(raw, [null, 1], { reversedNames: true }).outputs[0] !== undefined, "raw executable-style query (reversed names, typed placeholders)");

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
