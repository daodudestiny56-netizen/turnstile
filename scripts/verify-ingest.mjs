// Independent check for PRD S1: for every cached Blockchair file, count data lines and distinct
// lines straight from the gzip (no Turnstile parser involved) and compare with the SQLite database.
//
//   node scripts/verify-ingest.mjs [db=data/turnstile.sqlite] [cache=data/cache/blockchair]
import { createReadStream, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { createGunzip } from "node:zlib";

const [dbPath = "data/turnstile.sqlite", cacheDir = "data/cache/blockchair"] =
  process.argv.slice(2);
const RAW = { transactions: "raw_transactions", inputs: "raw_inputs", outputs: "raw_outputs" };
const db = new DatabaseSync(dbPath, { readOnly: true });

let checked = 0;
let failures = 0;
let totalDups = 0;
for (const table of Object.keys(RAW)) {
  const files = readdirSync(join(cacheDir, table)).filter((f) => f.endsWith(".tsv.gz"));
  for (const file of files.sort()) {
    const m = /_(\d{4})(\d{2})(\d{2})\.tsv\.gz$/.exec(file);
    const day = `${m[1]}-${m[2]}-${m[3]}`;
    const meta = db
      .prepare("SELECT rows, duplicates FROM ingest_days WHERE tbl = ? AND day = ?")
      .get(table, day);
    if (!meta) continue; // cached but not ingested (outside the requested range)

    let dataLines = 0;
    const distinct = new Set();
    let first = true;
    const lines = createInterface({
      input: createReadStream(join(cacheDir, table, file)).pipe(createGunzip()),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      if (first) {
        first = false;
        continue;
      }
      if (line === "") continue;
      dataLines++;
      distinct.add(line);
    }
    const dbRows = db.prepare(`SELECT COUNT(*) AS n FROM ${RAW[table]} WHERE day = ?`).get(day).n;
    const ok =
      dbRows === distinct.size && meta.rows === dbRows && meta.rows + meta.duplicates === dataLines;
    checked++;
    totalDups += meta.duplicates;
    if (!ok) {
      failures++;
      console.log(
        `MISMATCH ${table} ${day}: file lines=${dataLines} distinct=${distinct.size} db rows=${dbRows} ` +
          `recorded rows=${meta.rows} dups=${meta.duplicates}`,
      );
    }
  }
}
console.log(
  `${checked} table-days checked, ${failures} mismatches, ${totalDups} verbatim duplicate lines dropped`,
);
process.exitCode = failures === 0 && checked > 0 ? 0 : 1;
