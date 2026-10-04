import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { fixtures, formatZat, utcInput, waitForData } from "./fixtures";

async function makePlan(
  page: Page,
  input: { total: string; start: number; deposit?: string; depositAt?: number; legs?: string },
): Promise<void> {
  await page.locator("#total").fill(input.total);
  await page.locator("#start").fill(utcInput(input.start));
  if (input.legs) await page.locator("#legs").selectOption(input.legs);
  if (input.deposit !== undefined) await page.locator("#plan-deposit").fill(input.deposit);
  if (input.depositAt !== undefined)
    await page.locator("#plan-deposit-when").fill(utcInput(input.depositAt));
  await page.getByRole("button", { name: "Make a plan" }).click();
  // Wait for the plan, or for the form to report a problem.
  await expect(page.locator(".compare, [role=alert], .error-text").first()).toBeVisible();
}

const legAmounts = async (page: Page): Promise<number[]> =>
  (await page.locator(".legs .leg-amount").allTextContents()).map((t) =>
    Math.round(Number(t.replace(" ZEC", "")) * 1e8),
  );

test.beforeEach(async ({ page }) => {
  await page.goto("#/plan");
  await waitForData(page);
});

test("a red round trip becomes a plan of green legs", async ({ page }) => {
  const { deposit } = await fixtures();
  await makePlan(page, {
    total: formatZat(deposit.amount - 30_000),
    start: deposit.time + 3_600,
    deposit: formatZat(deposit.amount),
    depositAt: deposit.time,
  });
  await expect(page.getByRole("heading", { name: "The plan", exact: true })).toBeVisible();
  await expect(page.locator(".compare .tag").first()).toContainText("red");
  expect((await legAmounts(page)).length).toBeGreaterThan(0);
});

test("legs never add up to the deposit minus fees", async ({ page }) => {
  const { dataTo } = await fixtures();
  // 4 ZEC deposited plus fees: four 1 ZEC legs would add up to it exactly.
  await makePlan(page, {
    total: "4",
    start: dataTo - 12 * 3_600,
    deposit: "4.0003",
    depositAt: dataTo - 13 * 3_600,
  });
  await expect(page.getByRole("heading", { name: "The plan", exact: true })).toBeVisible();
  const legs = await legAmounts(page);
  for (let mask = 3; mask < 1 << legs.length; mask++) {
    if ((mask & (mask - 1)) === 0) continue;
    const sum = legs.reduce((s, l, i) => (mask & (1 << i) ? s + l : s), 0);
    const gap = 400_030_000 - sum;
    expect(gap >= 0 && gap <= 200_000 && gap % 5_000 === 0, `legs ${legs} subset ${sum}`).toBe(
      false,
    );
  }
  await expect(
    page.getByText(/stays shielded so that no group of these withdrawals/),
  ).toBeVisible();
});

test("a total too small to blend in is kept shielded, with a reason", async ({ page }) => {
  const { dataTo } = await fixtures();
  await makePlan(page, { total: "0.001", start: dataTo - 3_600 });
  await expect(page.getByText("0 withdrawals")).toBeVisible();
  await expect(page.getByText(/below the smallest amount that blends in/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Calendar reminders/ })).toHaveCount(0);
});

test("a very large total explains the leg limit and how many withdrawals it would take", async ({
  page,
}) => {
  const { dataTo } = await fixtures();
  await makePlan(page, { total: "20000", start: dataTo - 3_600 });
  await expect(page.getByText(/because the plan is limited to 4 legs/)).toBeVisible();
  await expect(page.getByText(/would need about \d+ withdrawals/)).toBeVisible();
});

test("calendar reminders are valid iCalendar, one event per leg", async ({ page }) => {
  const { dataTo } = await fixtures();
  await makePlan(page, { total: "3.5", start: dataTo - 12 * 3_600 });
  const legs = await page.locator(".leg").count();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: /Calendar reminders/ }).click();
  const file = await (await download).path();
  const ics = readFileSync(file!, "utf8");
  expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
  expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(legs);
  for (const line of ics.split("\r\n")) expect(line.length).toBeLessThanOrEqual(75);
});

test("a new random schedule changes the times, not the amounts", async ({ page }) => {
  const { dataTo } = await fixtures();
  await makePlan(page, { total: "3.5", start: dataTo - 12 * 3_600 });
  const before = await page.locator(".leg-meta").allTextContents();
  const amounts = (await legAmounts(page)).sort();
  await page.getByRole("button", { name: /New random schedule/ }).click();
  await expect.poll(() => page.locator(".leg-meta").allTextContents()).not.toEqual(before);
  expect((await legAmounts(page)).sort()).toEqual(amounts);
});

test("a deposit after the plan starts is caught", async ({ page }) => {
  const { dataTo } = await fixtures();
  await makePlan(page, {
    total: "3",
    start: dataTo - 7_200,
    deposit: "3.0003",
    depositAt: dataTo - 3_600,
  });
  await expect(page.locator("#plan-deposit-when-error")).toContainText("before the plan starts");
  await expect(page.locator("#plan-deposit-when")).toHaveAttribute("aria-invalid", "true");
});

test("a bad total is explained under the field", async ({ page }) => {
  await page.locator("#total").fill("1,5");
  await page.getByRole("button", { name: "Make a plan" }).click();
  await expect(page.locator("#total-error")).toContainText("use a dot for decimals");
  await expect(page.locator("#total")).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator("#total")).toHaveAttribute("aria-describedby", "total-error");
});
