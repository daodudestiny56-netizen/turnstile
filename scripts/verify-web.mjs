/* global document, window -- used inside page.evaluate(), which runs in the browser */
// Independent check for PRD S6 on the production build (apps/web/dist):
//   1. full journey in Chromium: load, check a real round trip, plan it, open the Leak Meter,
//      switch view and theme; ZERO network requests after the snapshot has loaded (P1)
//   2. no CSP violations, console errors or page errors
//   3. build output references no external origin outside a short allowlist (P3)
//   4. axe accessibility audit: no serious or critical violations, every page, both themes
//   5. no horizontal scrolling at 375px; screenshots for review in data/screenshots
//
//   pnpm --filter @turnstile/web build && node scripts/verify-web.mjs
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const dist = resolve("apps/web/dist");
const shots = resolve("data/screenshots");
mkdirSync(shots, { recursive: true });
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

// A real identifiable deposit from the snapshot, so the journey exercises a genuine red verdict.
const core = await import(pathToFileURL(resolve("packages/core/dist/index.js")).href);
const snapDir = join(dist, "snapshot");
const rb = (n) => new Uint8Array(readFileSync(join(snapDir, n)));
const bundle = await core.loadSnapshot(
  core.parseManifest(readFileSync(join(snapDir, "manifest.json"), "utf8")),
  { snapshot: rb("snapshot.bin.gz"), addresses: rb("addresses.bin"), stats: rb("stats.json") },
);
const ctx = core.createPreflightContext(bundle.data, bundle.addresses);
const { dataTo } = bundle.data;
const deposit = bundle.data.shields.find((s) => {
  if (s.time < dataTo - 5 * 86400 || s.time > dataTo - 3 * 3600) return false;
  if (core.zecDecimals(s.amount) < 6 || ctx.services.has(s.entity)) return false;
  const exit = { time: s.time + 3600, amount: s.amount - 30_000 };
  const rivals = core.feeShapedEntities(ctx.index, exit);
  rivals.delete(s.entity);
  return rivals.size === 0 && core.expectedChanceMatches(ctx.index, exit) === 0;
});
if (!deposit) throw new Error("no identifiable deposit found in the snapshot");
const utcInput = (t) => new Date(t * 1000).toISOString().slice(0, 16);

// Static server for the production build.
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};
const server = createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(join(dist, path));
  if (!file.startsWith(dist)) return res.writeHead(403).end();
  try {
    res
      .writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" })
      .end(readFileSync(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();

try {
  // 1-2. The journey
  const context = await browser.newContext({ timezoneId: "UTC", acceptDownloads: true });
  const page = await context.newPage();
  const requests = [];
  const problems = [];
  let phase = "loading";
  page.on("request", (r) => {
    if (/^https?:/.test(r.url())) requests.push({ phase, url: r.url() });
  });
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  page.on("pageerror", (e) => problems.push(String(e)));

  await page.goto(base + "#/check");
  await page.getByText("verified on this device").waitFor({ timeout: 15000 });
  await page.waitForLoadState("networkidle");
  const loadRequests = requests.length;
  phase = "interacting";

  const amount = core.formatZat(deposit.amount - 30_000);
  await page.getByLabel("Amount to withdraw (ZEC)").fill(amount);
  await page
    .getByLabel("When", { exact: true })
    .first()
    .fill(utcInput(deposit.time + 3600));
  await page.locator("#deposit").fill(core.formatZat(deposit.amount));
  await page.locator("#deposit-when").fill(utcInput(deposit.time));
  await page.getByRole("button", { name: "Check withdrawal" }).click();
  await page.getByRole("heading", { name: /Red: this would give you away/ }).waitFor();
  const redShown = await page.getByText("Exact round trip").isVisible();
  await page.screenshot({ path: join(shots, "check-red-dark.png"), fullPage: true });

  await page.getByRole("link", { name: /Plan a safer exit/ }).click();
  await page.getByRole("heading", { name: "The plan", exact: true }).waitFor({ timeout: 15000 });
  const legs = await page.locator(".leg").count();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: /Calendar reminders/ }).click();
  const ics = await (await download).path();
  const icsOk = ics ? readFileSync(ics, "utf8").startsWith("BEGIN:VCALENDAR") : false;
  await page.screenshot({ path: join(shots, "plan-dark.png"), fullPage: true });

  await page.getByRole("link", { name: "Leak Meter" }).first().click();
  await page.getByRole("heading", { name: /Traced to a service/ }).waitFor();
  await page.getByRole("button", { name: "Show as table" }).click();
  await page.getByRole("table").waitFor();
  await page.getByRole("button", { name: "Show as charts" }).click();
  await page.getByRole("button", { name: /Switch to light theme/ }).click();
  await page.screenshot({ path: join(shots, "meter-light.png"), fullPage: true });
  await page.getByRole("link", { name: "Turnstile" }).click();
  await page.getByRole("heading", { name: /Leave the shielded pool/ }).waitFor();
  await page.waitForTimeout(300);

  const after = requests.filter((r) => r.phase === "interacting");
  check(
    redShown && legs > 0 && icsOk,
    `journey: real round trip red, plan with ${legs} legs, calendar file downloaded, meter table and light theme`,
  );
  check(
    after.length === 0,
    `privacy: ${loadRequests} requests while loading, ${after.length} after the snapshot loaded` +
      (after.length ? `: ${after.map((r) => r.url).join(", ")}` : ""),
  );
  const external = requests.filter((r) => !r.url.startsWith(base));
  check(external.length === 0, `privacy: ${external.length} requests to any other origin`);
  check(
    problems.length === 0,
    `no console errors, CSP violations or page errors (${problems.length})`,
  );
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute("content");
  check(
    Boolean(csp?.includes("default-src 'none'")),
    "strict Content Security Policy is in the page",
  );
  await context.close();

  // 3. Build output scan
  const allowed = new Map([
    ["https://1click.chaindefuser.com", "NEAR Intents API, contacted only on Execute (S7)"],
    ["https://github.com", "links to the source code"],
    ["http://www.w3.org", "SVG/XML namespace identifiers, never fetched"],
    ["https://react.dev", "React error-message text, never fetched"],
  ]);
  const found = new Set();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|css|html)$/.test(e.name)) {
        for (const m of readFileSync(p, "utf8").matchAll(/https?:\/\/[a-z0-9.-]+/gi))
          found.add(m[0]);
      }
    }
  };
  walk(dist);
  const unexpected = [...found].filter((o) => !allowed.has(o));
  check(
    unexpected.length === 0,
    `build output: origins found ${[...found].join(", ")}` +
      (unexpected.length ? `; NOT ALLOWED: ${unexpected.join(", ")}` : "; all allowlisted"),
  );

  // 4-5. Accessibility, both themes, and phone width
  for (const theme of ["dark", "light"]) {
    for (const [name, viewport] of [
      ["desktop", { width: 1280, height: 900 }],
      ["phone", { width: 375, height: 812 }],
    ]) {
      const c = await browser.newContext({ viewport, timezoneId: "UTC" });
      await c.addInitScript((t) => localStorage.setItem("turnstile-theme", t), theme);
      const p = await c.newPage();
      for (const route of ["", "#/check", "#/plan", "#/meter"]) {
        await p.goto(base + route);
        await p.waitForLoadState("networkidle");
        if (route) await p.getByText("verified on this device").waitFor({ timeout: 15000 });
        const label = `${theme}/${name}/${route || "landing"}`;
        const axe = await new AxeBuilder({ page: p }).analyze();
        const bad = axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
        const wide = await p.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        check(
          bad.length === 0 && wide <= 0,
          `${label}: accessibility ${bad.length ? bad.map((v) => `${v.id} (${v.nodes.length})`).join(", ") : "clean"}` +
            `, horizontal overflow ${wide}px`,
        );
        if (route === "" || name === "phone") {
          await p.screenshot({
            path: join(shots, `${(route || "landing").replace("#/", "")}-${theme}-${name}.png`),
            fullPage: true,
          });
        }
      }
      await c.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
