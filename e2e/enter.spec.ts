import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { fixtures, formatZat, utcInput, waitForData } from "./fixtures";

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function checkDeposit(page: Page, zec: string): Promise<void> {
  const { dataTo } = await fixtures();
  await page.goto("#/enter");
  await waitForData(page);
  await page.locator("#enter-amount").fill(zec);
  await page.locator("#enter-when").fill(utcInput(dataTo - 3_600));
  await page.getByRole("button", { name: "Check deposit" }).click();
}

test("a precise amount is a fingerprint; the page offers both ways out and says to wait", async ({
  page,
}) => {
  const { entry } = await fixtures();
  const expected = entry("3.17423456");
  expect(expected.verdict).toBe("red");
  await checkDeposit(page, "3.17423456");
  await expect(page.locator(".verdict-red")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: /Result for a deposit of 3\.17423456 ZEC/ }),
  ).toBeFocused();
  await expect(
    page.getByText(/deposit all 3\.17423456 ZEC, and later withdraw with the Exit Planner/),
  ).toBeVisible();
  if (expected.common) {
    await expect(
      page.getByText(
        new RegExp(`deposit ${escape(formatZat(expected.common.amount))} ZEC instead`),
      ),
    ).toBeVisible();
  }
  await expect(page.getByText(/Wait at least a day before withdrawing/)).toBeVisible();
  await expect(page.getByRole("link", { name: /Open the Exit Planner/ })).toBeVisible();
});

test("a common amount is green", async ({ page }) => {
  const { entry } = await fixtures();
  expect(entry("1").verdict).toBe("green");
  await checkDeposit(page, "1");
  await expect(page.locator(".verdict-green")).toBeVisible();
  await expect(page.getByText(/1 ZEC is a common amount/)).toBeVisible();
});

test("bad amounts are explained and nothing is computed", async ({ page }) => {
  await page.goto("#/enter");
  await waitForData(page);
  for (const input of ["", "abc", "0", "-1"]) {
    await page.locator("#enter-amount").fill(input);
    await page.getByRole("button", { name: "Check deposit" }).click();
    await expect(page.locator("#enter-amount-error")).not.toBeEmpty();
    await expect(page.locator("#enter-amount")).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator(".verdict")).toHaveCount(0);
  }
  // Too small to pay a deposit's fee: the engine's own explanation.
  await page.locator("#enter-amount").fill("0.0001");
  await page.getByRole("button", { name: "Check deposit" }).click();
  await expect(page.getByRole("alert")).toContainText("network fee");
});

test("changing the amount after a result marks it out of date", async ({ page }) => {
  await checkDeposit(page, "1");
  await expect(page.locator(".verdict-green")).toBeVisible();
  await page.locator("#enter-amount").fill("2");
  await expect(page.getByText("You've changed the inputs since this result")).toBeVisible();
});

test("an Entry Planner result has no serious accessibility issues", async ({ page }) => {
  await checkDeposit(page, "3.17423456");
  await expect(page.locator(".verdict-red")).toBeVisible();
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
});
