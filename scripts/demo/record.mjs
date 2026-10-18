/* global document, window */ // used inside page.evaluate, which runs in the browser
// Record the demo video: drives the production build of the web app scene by scene, holding each
// scene for as long as its narration lasts (scripts/demo/speak.ps1), then writes the raw recording
// and the scene start times for scripts/demo/mix.mjs.
//
// The Execute scene asks NEAR Intents for a real price and a real one-time deposit address. Nothing
// is paid: the address is never funded and expires on its own.
//
//   pnpm build
//   powershell -NoProfile -File scripts/demo/speak.ps1 -OutDir data/demo/audio
//   node scripts/demo/record.mjs            # writes data/demo/raw.webm and data/demo/timeline.json
//   node scripts/demo/mix.mjs               # writes data/demo/turnstile-demo.mp4
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const PORT = 4188;
const OUT = "data/demo";
const readJson = (p) => {
  const text = readFileSync(p, "utf8");
  // PowerShell writes UTF-8 with a byte-order mark.
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
};
const lengths = readJson(join(OUT, "audio/lengths.json"));
const scenes = JSON.parse(readFileSync("scripts/demo/narration.json", "utf8"));
const caption = Object.fromEntries(scenes.map((s) => [s.id, s.caption]));

// Example inputs: Kemi's deposit from the README, not anyone's real transaction.
const DEPOSIT = "3.1742";
const WITHDRAWAL = "3.1739";
// A recipient used in the 1Click documentation, and the official test-vector unified address.
const RECIPIENT = "0x2527D02599Ba641c19FEa793cD0F167589a0f10D";
const REFUND =
  "u1ay3aawlldjrmxqnjf5medr5ma6p3acnet464ht8lmwplq5cd3ugytcmlf96rrmtgwldc75x94qn4n8pgen36y8tywlq6yjk7lkf3fa8wzjrav8z2xpxqnrnmjxh8tmz6jhfh425t7f3vy6p4pd3zmqayq49efl2c4xydc0gszg660q9p";

const server = spawn(process.execPath, ["e2e/serve.mjs", String(PORT)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1500));
rmSync(join(OUT, "video"), { recursive: true, force: true });
mkdirSync(join(OUT, "video"), { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  colorScheme: "dark",
  locale: "en-US",
  recordVideo: { dir: join(OUT, "video"), size: { width: 1280, height: 720 } },
});
const page = await context.newPage();
const t0 = Date.now();
const timeline = [];
const base = `http://127.0.0.1:${PORT}/`;

/** A caption bar along the bottom (built through the DOM, which the CSP allows). */
async function showCaption(text) {
  await page.evaluate((t) => {
    let el = document.getElementById("demo-caption");
    if (!el) {
      el = document.createElement("div");
      el.id = "demo-caption";
      Object.assign(el.style, {
        position: "fixed",
        left: "50%",
        bottom: "28px",
        transform: "translateX(-50%)",
        maxWidth: "1040px",
        padding: "14px 26px",
        borderRadius: "14px",
        background: "rgba(5, 12, 8, 0.88)",
        border: "1px solid rgba(80, 220, 130, 0.45)",
        color: "#ffffff",
        font: "600 22px/1.35 'Inter Variable', system-ui, sans-serif",
        textAlign: "center",
        zIndex: "2147483647",
        boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
        pointerEvents: "none",
      });
      document.body.appendChild(el);
    }
    el.textContent = t;
  }, text);
}

async function scrollTo(locator) {
  await locator.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
  await page.waitForTimeout(900);
}

async function scrollBy(y) {
  await page.evaluate((dy) => window.scrollBy({ top: dy, behavior: "smooth" }), y);
  await page.waitForTimeout(900);
}

/** Run one scene, then hold until its narration has finished. */
async function scene(id, run) {
  const start = Date.now() - t0;
  timeline.push({ id, startMs: start });
  await showCaption(caption[id]).catch(() => undefined);
  await run();
  await showCaption(caption[id]).catch(() => undefined);
  const end = start + lengths[id] + 900;
  const wait = end - (Date.now() - t0);
  if (wait > 0) await page.waitForTimeout(wait);
  console.log(
    `${id}: ${start} ms, ran ${Date.now() - t0 - start} ms (narration ${lengths[id]} ms)`,
  );
}

const local = (t) => {
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
// The landing page has no data line; its live statistics fill in once the data is verified.
const landingReady = () =>
  page.waitForFunction(
    () => {
      const v = document.querySelector(".stat-value");
      return v !== null && !v.textContent.includes("...");
    },
    null,
    { timeout: 60_000 },
  );
const dataReady = () =>
  page.getByText("verified on this device").first().waitFor({ timeout: 60_000 });

try {
  await page.goto(base);
  await landingReady();

  await scene("intro", async () => {
    await page.waitForTimeout(6000);
    await scrollBy(560);
    await page.waitForTimeout(4000);
    await scrollBy(-560);
  });

  await scene("meter", async () => {
    await page.getByRole("link", { name: "Leak Meter" }).first().click();
    await dataReady();
    await page.waitForTimeout(2500);
    await scrollTo(page.locator(".chart-card").first());
    await page.waitForTimeout(6000);
    await scrollBy(320);
  });

  await scene("check", async () => {
    await page.getByRole("link", { name: "Pre-flight Check" }).first().click();
    await dataReady();
    await page.locator("#amount").pressSequentially(WITHDRAWAL, { delay: 90 });
    await page.locator("#when").fill(local(Date.now()));
    await page.locator("#deposit").pressSequentially(DEPOSIT, { delay: 90 });
    await page.locator("#deposit-when").fill(local(Date.now() - 2 * 3_600_000));
    await page.waitForTimeout(600);
    await page.getByRole("button", { name: "Check withdrawal" }).click();
    await page.locator(".verdict-red").waitFor();
    await scrollTo(page.locator(".verdict-red"));
  });

  await scene("plan", async () => {
    await page.getByRole("link", { name: /Plan a safer exit/ }).click();
    await page.getByRole("heading", { name: "The plan", exact: true }).waitFor({ timeout: 30_000 });
    // Spread over one day, so every leg can be executed today.
    await page.locator("#hours").selectOption("24");
    await page.getByRole("button", { name: "Make a plan" }).click();
    await page.waitForTimeout(1500);
    await scrollTo(page.locator(".legs").first());
    await page.waitForTimeout(3000);
    await scrollBy(300);
  });

  await scene("execute", async () => {
    await scrollTo(page.locator(".legs").first());
    await page.getByRole("button", { name: /^Execute withdrawal 1/ }).click();
    await page.waitForTimeout(800);
    await page.locator("#exec-recipient").pressSequentially(RECIPIENT, { delay: 15 });
    await page.locator("#exec-refund").fill(REFUND);
    await page.getByRole("button", { name: "Get a price" }).click();
    await page.getByText(/You'd receive about/).waitFor({ timeout: 30_000 });
    await scrollTo(page.locator(".quote-box").first());
    await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "Get the deposit address" }).click();
    await page.locator("code.address").waitFor({ timeout: 30_000 });
    await scrollTo(page.locator(".pay-grid"));
  });

  await scene("entry-audit", async () => {
    // Leaving the page ends the payment panel; the unfunded address simply expires.
    await page.goto(`${base}#/enter`);
    await dataReady();
    await page.locator("#enter-amount").pressSequentially(DEPOSIT, { delay: 90 });
    await page.getByRole("button", { name: "Check deposit" }).click();
    await page.locator(".verdict").waitFor();
    await page.waitForTimeout(3500);
    await page.goto(`${base}#/audit`);
    await dataReady();
    await page.waitForTimeout(1500);
  });

  await scene("close", async () => {
    await page.goto(base);
    await landingReady();
    await scrollTo(page.getByRole("heading", { name: /A privacy tool that can't leak/ }));
  });
} finally {
  const video = page.video();
  await context.close();
  await browser.close();
  server.kill();
  const path = await video?.path();
  if (path) renameSync(path, join(OUT, "raw.webm"));
  writeFileSync(join(OUT, "timeline.json"), JSON.stringify(timeline, null, 2) + "\n");
  console.log(`wrote ${join(OUT, "raw.webm")} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}
