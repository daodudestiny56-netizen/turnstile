import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { fillCheck, fixtures, waitForData } from "./fixtures";

const ROUTES = [
  ["landing", ""],
  ["enter", "#/enter"],
  ["check", "#/check"],
  ["audit", "#/audit"],
  ["plan", "#/plan"],
  ["meter", "#/meter"],
] as const;

for (const theme of ["dark", "light"] as const) {
  for (const [name, route] of ROUTES) {
    test(`${name} in the ${theme} theme has no serious accessibility issues`, async ({ page }) => {
      await page.addInitScript((t) => localStorage.setItem("turnstile-theme", t), theme);
      await page.goto(route);
      if (route) await waitForData(page);
      const { violations } = await new AxeBuilder({ page }).analyze();
      const serious = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(serious.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
    });
  }
}

test("a result page (red verdict) has no serious accessibility issues", async ({ page }) => {
  const { deposit } = await fixtures();
  await page.goto("#/check");
  await waitForData(page);
  await fillCheck(page, {
    amount: String((deposit.amount - 30_000) / 1e8),
    when: deposit.time + 3_600,
    deposit: String(deposit.amount / 1e8),
    depositAt: deposit.time,
  });
  await page.getByRole("button", { name: "Check withdrawal" }).click();
  await expect(page.locator(".verdict-red")).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
});

test("the whole check can be done with the keyboard alone", async ({ page, browserName }) => {
  const { dataTo } = await fixtures();
  await page.goto("#/check");
  await waitForData(page);
  // Skip link: the first Tab stop, and it moves focus to the content.
  await page.keyboard.press("Tab");
  if (browserName !== "webkit") {
    // Safari doesn't Tab to links unless the user enables it; the skip link is still reachable.
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main")).toBeFocused();
  }
  await page.locator("#amount").focus();
  await page.keyboard.type("1");
  await page.locator("#when").fill(new Date((dataTo - 3_600) * 1000).toISOString().slice(0, 16));
  await page.locator("#amount").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: /Result for 1 ZEC/ })).toBeFocused();
});

test("every page has its own title", async ({ page }) => {
  for (const [route, title] of [
    ["", /^Turnstile: leave the shielded pool/],
    ["#/enter", /^Entry Planner \| Turnstile$/],
    ["#/check", /^Pre-flight Check \| Turnstile$/],
    ["#/audit", /^Personal Audit \| Turnstile$/],
    ["#/plan", /^Exit Planner \| Turnstile$/],
    ["#/meter", /^Leak Meter \| Turnstile$/],
  ] as const) {
    await page.goto(route);
    await expect(page).toHaveTitle(title);
  }
});

test("navigating moves focus to the new page's content", async ({ page }) => {
  await page.goto("");
  await page.getByRole("link", { name: "Leak Meter" }).first().click();
  await expect(page.locator("#main")).toBeFocused();
});
