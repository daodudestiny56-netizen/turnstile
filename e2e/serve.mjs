// Static server for the production build, with fault injection for the end-to-end tests.
//
//   /             normal site; .gz files sent with Content-Encoding: gzip, as many hosts do
//   /plain/       .gz files sent as stored (no Content-Encoding)
//   /missing/     every snapshot file returns 404
//   /tampered/    snapshot.bin.gz has one byte flipped
//   /tampered-audit/  audit.bin.gz has one byte flipped (the other files are intact)
//   /slow/        snapshot files are delayed by 3 seconds
//   /noworker/    the analysis worker script returns 404
//   /flaky/<id>/  the first manifest request for each <id> fails with 500; later ones succeed
//
//   node e2e/serve.mjs [port=4174]
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const dist = resolve("apps/web/dist");
const port = Number(process.argv[2] ?? 4174);
const MODES = ["plain", "missing", "tampered-audit", "tampered", "slow", "noworker"];
const flakyFailed = new Set();
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const flaky = /^\/flaky\/([\w-]+)(\/.*)?$/.exec(path);
  if (flaky) {
    path = flaky[2] || "/";
    if (path.startsWith("/snapshot/manifest.json") && !flakyFailed.has(flaky[1])) {
      flakyFailed.add(flaky[1]);
      return res.writeHead(500).end();
    }
  }
  const mode = MODES.find((m) => path.startsWith(`/${m}/`) || path === `/${m}`);
  if (mode) path = path.slice(mode.length + 1) || "/";
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(join(dist, path));
  if (!file.startsWith(dist)) return res.writeHead(403).end();
  const isSnapshot = path.startsWith("/snapshot/");

  if (mode === "missing" && isSnapshot) return res.writeHead(404).end();
  if (mode === "noworker" && /\/assets\/worker-.*\.js$/.test(path)) return res.writeHead(404).end();
  if (mode === "slow" && isSnapshot) await new Promise((r) => setTimeout(r, 3000));

  let body;
  try {
    body = readFileSync(file);
  } catch {
    return res.writeHead(404).end();
  }
  if (
    (mode === "tampered" && path.endsWith("snapshot.bin.gz")) ||
    (mode === "tampered-audit" && path.endsWith("audit.bin.gz"))
  ) {
    body = Buffer.from(body);
    body[body.length >> 1] ^= 1;
  }
  const headers = {
    "content-type": types[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
  };
  if (mode !== "plain" && !mode?.startsWith("tampered") && file.endsWith(".gz")) {
    headers["content-encoding"] = "gzip";
  }
  res.writeHead(200, headers).end(body);
}).listen(port, "127.0.0.1", () => console.log(`e2e server on http://127.0.0.1:${port}/`));
