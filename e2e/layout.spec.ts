import { expect, test } from "@playwright/test";
import { fillCheck, fixtures, waitForData } from "./fixtures";

const WIDTHS = [320, 375, 768, 1024, 1440];
const ROUTES = ["", "#/enter", "#/check", "#/plan", "#/audit", "#/meter"];

for (const width of WIDTHS) {
  test(`no page scrolls sideways at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ROUTES) {
      await page.goto(route);
      if (route) await waitForData(page);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, `${route || "landing"} at ${width}px`).toBeLessThanOrEqual(0);
    }
  });
}

test("a red result fits on the smallest phones (320px)", async ({ page }) => {
  const { deposit } = await fixtures();
  await page.setViewportSize({ width: 320, height: 800 });
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
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
});

test("the header shows a menu button on phones and links on desktop", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("");
  const menu = page.getByRole("button", { name: "Menu" });
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await menu.click();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await page.locator("#mobile-menu").getByRole("link", { name: "Exit Planner" }).click();
  await expect(page).toHaveURL(/#\/plan$/);
  await expect(page.locator("#mobile-menu")).toHaveCount(0);

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("button", { name: "Menu" })).toBeHidden();
  await expect(page.locator(".nav-links")).toBeVisible();
});

test("form fields are wide enough to show their values", async ({ page }) => {
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("#/check");
    const box = await page.locator("#deposit").boundingBox();
    expect(box!.width, `deposit field at ${width}px`).toBeGreaterThan(150);
  }
});
