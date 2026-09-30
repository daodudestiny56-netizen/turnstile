// Independent check for PRD S4 on a built snapshot bundle:
//   1. loads and verifies in Node, timed
//   2. real-data round trip: re-encoding the decoded snapshot reproduces the exact bytes
//   3. address hashes answer correctly for real addresses from the database
//   4. a single altered byte in any file is rejected
//   5. loads and verifies in headless Chromium, timed, fetching only the bundle's own files
//
//   node scripts/verify-snapshot.mjs [dir=data/snapshot] [db=data/turnstile.sqlite]
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const [dir = "data/snapshot", dbPath = "data/turnstile.sqlite"] = process.argv.slice(2);
const root = resolve(".");
const core = await import(pathToFileURL(join(root, "packages/core/dist/index.js")).href);
const read = (name) => new Uint8Array(readFileSync(join(dir, name)));
const files = () => ({
  snapshot: read("snapshot.bin.gz"),
  addresses: read("addresses.bin"),
  stats: read("stats.json"),
});
const manifest = core.parseManifest(readFileSync(join(dir, "manifest.json"), "utf8"));
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

// 1. Node load
let t0 = performance.now();
const snap = await core.loadSnapshot(manifest, files());
const nodeMs = performance.now() - t0;
t0 = performance.now();
new core.ShieldIndex(snap.data.shields);
const indexMs = performance.now() - t0;
check(
  nodeMs + indexMs < 3000,
  `Node: verified and decoded in ${nodeMs.toFixed(0)} ms, index built in ${indexMs.toFixed(0)} ms`,
);

// 2. Real-data round trip
const raw = await core.gunzip(files().snapshot);
const again = core.encodeSnapshot(snap.data);
check(
  again.length === raw.length && again.every((b, i) => b === raw[i]),
  `round trip: decode then encode reproduces all ${raw.length} bytes of the real snapshot`,
);

// 3. Address membership against the database
const db = new DatabaseSync(dbPath, { readOnly: true });
const shieldAddrs = new Set(
  db
    .prepare("SELECT addresses FROM events WHERE kind = 'SHIELD'")
    .all()
    .flatMap((r) => JSON.parse(r.addresses)),
);
const exitOnly = db
  .prepare("SELECT addresses FROM events WHERE kind = 'DESHIELD' LIMIT 5000")
  .all()
  .flatMap((r) => JSON.parse(r.addresses))
  .filter((a) => !shieldAddrs.has(a))
  .slice(0, 200);
const members = [...shieldAddrs].slice(0, 200);
const hits = (await Promise.all(members.map((a) => snap.addresses.has(a)))).filter(Boolean).length;
const falseHits = (await Promise.all(exitOnly.map((a) => snap.addresses.has(a)))).filter(
  Boolean,
).length;
check(
  hits === members.length && falseHits === 0 && snap.addresses.size === shieldAddrs.size,
  `addresses: ${hits}/${members.length} shielding addresses found, ${falseHits}/${exitOnly.length} ` +
    `non-shielding addresses wrongly found, ${snap.addresses.size} hashes for ${shieldAddrs.size} addresses`,
);

// 4. Tampering: flip one byte in the middle of each file
for (const name of ["snapshot", "addresses", "stats"]) {
  const f = files();
  f[name][f[name].length >> 1] ^= 1;
  let rejected = false;
  try {
    await core.loadSnapshot(manifest, f);
  } catch (e) {
    rejected = e instanceof core.SnapshotIntegrityError;
  }
  check(rejected, `tampering: one flipped byte in ${name} is rejected`);
}

// 5. Headless Chromium
const types = { ".js": "text/javascript", ".json": "application/json", ".html": "text/html" };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path === "/") {
    res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>probe</title>");
    return;
  }
  const file = normalize(join(root, path));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    res
      .writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" })
      .end(readFileSync(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.goto(base + "/");
  const snapDir = "/" + dir.replaceAll("\\", "/");
  const result = await page.evaluate(async (snapDir) => {
    const t0 = performance.now();
    const core = await import("/packages/core/dist/index.js");
    const get = async (n) => new Uint8Array(await (await fetch(`${snapDir}/${n}`)).arrayBuffer());
    const manifest = core.parseManifest(await (await fetch(`${snapDir}/manifest.json`)).text());
    const [snapshot, addresses, stats] = await Promise.all(
      ["snapshot.bin.gz", "addresses.bin", "stats.json"].map(get),
    );
    const s = await core.loadSnapshot(manifest, { snapshot, addresses, stats });
    new core.ShieldIndex(s.data.shields);
    return {
      ms: performance.now() - t0,
      shields: s.data.shields.length,
      exits: s.data.exits.length,
    };
  }, snapDir);
  const external = requests.filter((u) => !u.startsWith(base));
  check(
    result.ms < 3000 && result.shields === manifest.counts.shields,
    `Chromium: fetched, verified, decoded and indexed ${result.shields} shields and ${result.exits} ` +
      `exits in ${result.ms.toFixed(0)} ms`,
  );
  check(
    external.length === 0,
    `Chromium: ${requests.length} requests, all to the local server (${external.length} elsewhere)`,
  );
} finally {
  await browser.close();
  server.close();
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
