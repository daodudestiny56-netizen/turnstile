import { expect, test, type Page } from "@playwright/test";
import { fixtures, waitForData } from "./fixtures";

/**
 * Seeded random user: hostile input into every form, repeated submits, random navigation, theme
 * changes and resizing. After every action the page must still be whole: no page errors, no
 * console errors (CSP violations included), a heading on screen, and no sideways scrolling.
 */

function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOSTILE = [
  "",
  " ",
  "0",
  "-1",
  "1e9",
  "NaN",
  "Infinity",
  "0.000000001",
  "21000001",
  "1,5",
  ".",
  "١٢٣",
  "１２",
  "\u200b1",
  "<img src=x onerror=alert(1)>",
  '"><script>alert(1)</script>',
  "' OR 1=1 --",
  "9".repeat(500),
  "t1" + "z".repeat(5_000),
  "zs1mrhc9y7jdh5r9ece8u5khgvj9kg0zgkxzdduyv0whkg7lkcrkx5xqem3e48avjq9wn2rukydkwn",
  "t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC",
  "tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte",
  "3.1742",
  "1",
  "0.5",
  "12.34567891",
  "\u202eRTL\u202c",
  "\u{1F642}",
];

const ROUTES = ["", "#/enter", "#/check", "#/plan", "#/audit", "#/meter", "#/nowhere", "#/CHECK/"];

async function healthy(page: Page, problems: string[], step: string): Promise<void> {
  expect(problems, `after ${step}`).toEqual([]);
  await expect(page.locator("h1").first(), `heading after ${step}`).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, `sideways scroll after ${step}`).toBeLessThanOrEqual(0);
}

for (const seed of [1, 2]) {
  test(`a random user can't break the site (seed ${seed})`, async ({ page, browserName }) => {
    // Driving WebKit on Windows costs about a second per action, so it takes fewer, longer steps.
    const steps = browserName === "webkit" ? 15 : 40;
    test.setTimeout(browserName === "webkit" ? 480_000 : 240_000);
    const { traced, dataTo } = await fixtures();
    const rand = seeded(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`console: ${m.text()}`);
    });
    page.on("dialog", (d) => {
      problems.push(`dialog: ${d.message()}`);
      void d.dismiss();
    });

    await page.goto("#/check");
    await waitForData(page);
    const date = (): string => {
      const choices = [
        "",
        "1970-01-01T00:00",
        "2099-12-31T23:59",
        new Date((dataTo - 3_600) * 1000).toISOString().slice(0, 16),
        new Date((dataTo - 30 * 86_400) * 1000).toISOString().slice(0, 16),
      ];
      return pick(choices);
    };

    for (let step = 0; step < steps; step++) {
      const action = rand();
      let label: string;
      if (action < 0.2) {
        const route = pick(ROUTES);
        await page.goto(route);
        label = `goto ${route || "landing"}`;
      } else if (action < 0.3) {
        const width = pick([320, 375, 768, 1280]);
        await page.setViewportSize({ width, height: 800 });
        label = `resize ${width}`;
      } else if (action < 0.35) {
        await page
          .getByRole("button", { name: /Switch to (light|dark) theme/ })
          .click({ timeout: 5_000 })
          .catch(() => undefined);
        label = "theme";
      } else {
        // Fill whatever form is on the page with hostile input and submit, sometimes twice.
        const inputs = page.locator("main input:not([type=hidden]), main textarea, main select");
        const n = await inputs.count();
        for (let i = 0; i < n; i++) {
          const el = inputs.nth(i);
          if (!(await el.isVisible()) || !(await el.isEnabled())) continue;
          const tag = await el.evaluate((e) => e.tagName.toLowerCase());
          const type = await el.getAttribute("type");
          if (tag === "select") {
            const options = await el.locator("option").allTextContents();
            if (options.length)
              await el.selectOption({ index: Math.floor(rand() * options.length) });
          } else if (type === "datetime-local") {
            await el.fill(date());
          } else if (tag === "textarea") {
            await el.fill(
              rand() < 0.3
                ? traced.address
                : Array.from({ length: Math.floor(rand() * 60) }, () => pick(HOSTILE)).join("\n"),
            );
          } else {
            await el.fill(pick(HOSTILE));
          }
        }
        const submit = page.locator("main form button[type=submit]").first();
        if ((await submit.count()) && (await submit.isEnabled())) {
          await submit.click();
          if (rand() < 0.3) await submit.click({ force: true }).catch(() => undefined);
        }
        // Let the engine answer before judging the page.
        await page.waitForTimeout(300);
        label = `form on ${new URL(page.url()).hash || "landing"}`;
      }
      await healthy(page, problems, `step ${step}: ${label}`);
    }
    // Nothing a user typed was put into the address bar.
    expect(page.url()).not.toContain("script");
  });
}
