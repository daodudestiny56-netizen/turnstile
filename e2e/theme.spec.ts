import { expect, test } from "@playwright/test";

test("dark by default; the choice of light survives a reload", async ({ page }) => {
  await page.goto("");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("button", { name: "Switch to dark theme" })).toBeVisible();
});

test("the light theme actually changes the colors", async ({ page }) => {
  await page.goto("");
  const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(light).not.toEqual(dark);
});

test("works when the browser blocks storage", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("storage blocked");
      },
    });
  });
  await page.goto("");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});
