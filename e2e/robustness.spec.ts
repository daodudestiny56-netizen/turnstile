import { expect, test } from "@playwright/test";
import { fixtures, waitForData } from "./fixtures";

test("an unknown page says so, and links to the real ones", async ({ page }) => {
  await page.goto("#/nowhere");
  await expect(page.getByRole("heading", { name: "There's no page here" })).toBeVisible();
  await expect(page).toHaveTitle("Page not found | Turnstile");
  await page.getByRole("main").getByRole("link", { name: "Pre-flight Check" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Would this withdrawal/);
});

test("a route with different case or a trailing slash still opens its page", async ({ page }) => {
  for (const route of ["#/Check", "#/check/", "#/AUDIT/"]) {
    await page.goto(route);
    await expect(page.getByRole("heading", { name: "There's no page here" })).toHaveCount(0);
  }
});

test("the phone menu closes on Back and on Escape, and scrolls when the screen is short", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto("#/check");
  await page.goto("#/plan");
  const menu = page.getByRole("button", { name: "Menu" });
  await menu.click();
  await expect(page.locator("#mobile-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#mobile-menu")).toHaveCount(0);
  await menu.click();
  await page.goBack();
  await expect(page).toHaveURL(/#\/check$/);
  await expect(page.locator("#mobile-menu")).toHaveCount(0);

  // 320 x 256 is a 1280 x 1024 screen at 400% zoom: every link must still be reachable.
  await page.setViewportSize({ width: 320, height: 256 });
  await menu.click();
  const last = page.locator("#mobile-menu").getByRole("link", { name: "Leak Meter" });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
});

test("an absurdly long pasted address is refused at once, without freezing the page", async ({
  page,
}) => {
  const { dataTo } = await fixtures();
  await page.goto("#/check");
  await waitForData(page);
  await page.locator("#amount").fill("1");
  await page.locator("#when").fill(new Date((dataTo - 3_600) * 1000).toISOString().slice(0, 16));
  await page.locator("#destination").fill("t1" + "z".repeat(50_000));
  const started = Date.now();
  await page.getByRole("button", { name: "Check withdrawal" }).click();
  await expect(page.locator("#destination-error")).toBeVisible();
  expect(Date.now() - started).toBeLessThan(5_000);
});

test("the stale-data banner shows only once the data is more than two days old", async ({
  page,
}) => {
  const { dataTo } = await fixtures();
  await page.clock.setFixedTime(new Date((dataTo + 86_400) * 1000));
  await page.goto("#/check");
  await waitForData(page);
  await expect(page.getByText(/This data ended \d+ days ago/)).toHaveCount(0);

  await page.clock.setFixedTime(new Date((dataTo + 3 * 86_400) * 1000));
  await page.goto("#/plan");
  await page.reload();
  await waitForData(page);
  await expect(page.getByText(/This data ended \d+ days ago/)).toBeVisible();
});
