import { expect, test } from "@playwright/test";
import { fixtures, waitForData } from "./fixtures";

const pct = (r: number): string => `${(100 * r).toFixed(1)}%`;

test.beforeEach(async ({ page }) => {
  await page.goto("#/meter");
  await waitForData(page);
});

test("the headline numbers are the published statistics", async ({ page }) => {
  const { stats } = await fixtures();
  const precise = stats.services.byPrecision["6-8 decimals"]!;
  await expect(page.locator(".big-number").first()).toHaveText(pct(precise.observed.rate));
  await expect(page.locator(".big-number").nth(2)).toHaveText(
    stats.evaluated.toLocaleString("en-US"),
  );
  const people =
    stats.people.excess > 0.001 ? `+${(100 * stats.people.excess).toFixed(1)} pts` : "None";
  await expect(page.locator(".big-number.word")).toHaveText(people);
});

test("every bar can be read by keyboard and screen reader", async ({ page }) => {
  const { stats } = await fixtures();
  const bars = page.locator(".bullet-hit");
  await expect(bars.first()).toBeVisible();
  const n = await bars.count();
  expect(n).toBeGreaterThanOrEqual(8 + 6); // 2 bullet charts x 4 rows, plus 6 crowd rows
  await bars.first().focus();
  await expect(bars.first()).toBeFocused();
  await expect(bars.first()).toHaveAttribute(
    "aria-label",
    new RegExp(pct(stats.services.observed.rate)),
  );
});

test("the table view shows the same numbers, and switches back", async ({ page }) => {
  const { stats } = await fixtures();
  await page.getByRole("button", { name: "Show as table" }).click();
  const table = page.getByRole("table");
  await expect(table).toBeVisible();
  await expect(table.getByRole("row")).toHaveCount(1 + 3 * 4);
  await expect(table).toContainText(pct(stats.people.observed.rate));
  await page.getByRole("button", { name: "Show as charts" }).click();
  await expect(page.getByRole("table")).toHaveCount(0);
});
