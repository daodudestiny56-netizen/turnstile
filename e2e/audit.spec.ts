import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { fixtures, formatZat, waitForData } from "./fixtures";

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function audit(page: Page, text: string): Promise<void> {
  await page.goto("#/audit");
  await waitForData(page);
  const button = page.getByRole("button", { name: "Audit addresses" });
  await expect(button).toBeEnabled({ timeout: 45_000 });
  await page.locator("#audit-addresses").fill(text);
  await button.click();
}

test("a real round trip on one address is reported traced, with the deposit it came from", async ({
  page,
}) => {
  const { traced } = await fixtures();
  await audit(page, traced.address);
  await expect(page.locator(".verdict-red")).toBeVisible();
  await expect(page.getByRole("heading", { name: /Audit of 1 address/ })).toBeFocused();
  await expect(page.getByText("Traced to your deposit").first()).toBeVisible();
  await expect(
    page
      .getByText(new RegExp(`Linked to your deposit of ${escape(formatZat(traced.deposit))} ZEC`))
      .first(),
  ).toBeVisible();
  await expect(page.getByText(`${formatZat(traced.withdrawal)} ZEC`).first()).toBeVisible();
});

test("inputs that can't be checked are explained one by one", async ({ page }) => {
  const { traced } = await fixtures();
  await audit(
    page,
    [
      traced.address,
      "zs1mrhc9y7jdh5r9ece8u5khgvj9kg0zgkxzdduyv0whkg7lkcrkx5xqem3e48avjq9wn2rukydkwn",
      "t1NotARealAddress",
    ].join("\n"),
  );
  const items = page.locator(".address-list li");
  await expect(items).toHaveCount(3);
  await expect(items.nth(0).locator(".error-text")).toHaveCount(0);
  await expect(items.nth(1).locator(".error-text")).toBeVisible();
  await expect(items.nth(2).locator(".error-text")).toBeVisible();
});

test("an address that never crossed says so", async ({ page }) => {
  // The ZIP 320 test-vector address: valid, and not in the data.
  await audit(page, "t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC");
  await expect(page.getByRole("heading", { name: "No crossings found" })).toBeVisible();
  await expect(page.locator(".verdict")).toHaveCount(0);
});

test("an empty list is refused before anything runs", async ({ page }) => {
  await audit(page, "   ");
  await expect(page.locator("#audit-error")).toHaveText("Enter at least one transparent address.");
  await expect(page.locator(".verdict")).toHaveCount(0);
});

test("an altered audit file is refused; the other tools keep working", async ({ page }) => {
  await page.goto("/tampered-audit/#/audit");
  await waitForData(page);
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("audit index couldn't be loaded", { timeout: 45_000 });
  await expect(alert).toContainText("matches neither");
  await expect(page.getByRole("button", { name: "Audit addresses" })).toBeDisabled();
  await page.getByRole("link", { name: "Pre-flight Check" }).first().click();
  await page.locator("#amount").fill("1");
  await page.getByRole("button", { name: "Check withdrawal" }).click();
  await expect(page.locator(".verdict")).toBeVisible();
});

test("auditing sends nothing: zero requests after the data has loaded", async ({ page }) => {
  const { traced } = await fixtures();
  await page.goto("#/audit");
  await waitForData(page);
  await expect(page.getByRole("button", { name: "Audit addresses" })).toBeEnabled({
    timeout: 45_000,
  });
  await page.waitForLoadState("networkidle");
  const requests: string[] = [];
  page.on("request", (r) => {
    if (/^https?:/.test(r.url())) requests.push(r.url());
  });
  await page.locator("#audit-addresses").fill(traced.address);
  await page.getByRole("button", { name: "Audit addresses" }).click();
  await expect(page.locator(".verdict-red")).toBeVisible();
  expect(requests).toEqual([]);
  expect(page.url()).not.toContain(traced.address);
});

test("an audit result has no serious accessibility issues", async ({ page }) => {
  const { traced } = await fixtures();
  await audit(page, traced.address);
  await expect(page.locator(".verdict-red")).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
});

test("an audit result fits on the smallest phones (320px)", async ({ page }) => {
  const { traced } = await fixtures();
  await page.setViewportSize({ width: 320, height: 800 });
  await audit(page, traced.address);
  await expect(page.locator(".verdict-red")).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
});
