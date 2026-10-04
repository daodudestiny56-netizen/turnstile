import { expect, test } from "@playwright/test";
import { fillCheck, fixtures, formatZat, utcInput, waitForData } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await page.goto("#/check");
  await waitForData(page);
});

const submit = (page: import("@playwright/test").Page) =>
  page.getByRole("button", { name: "Check withdrawal" }).click();

test.describe("Pre-flight Check verdicts", () => {
  test("a real round trip on an amount nobody else used is red", async ({ page }) => {
    const { deposit } = await fixtures();
    await fillCheck(page, {
      amount: formatZat(deposit.amount - 30_000),
      when: deposit.time + 3_600,
      deposit: formatZat(deposit.amount),
      depositAt: deposit.time,
    });
    await submit(page);
    await expect(
      page.getByRole("heading", { name: /Red: this would give you away/ }),
    ).toBeVisible();
    await expect(page.getByText("Exact round trip")).toBeVisible();
    await expect(page.getByRole("link", { name: /Plan a safer exit/ })).toBeVisible();
  });

  test("without the deposit, it still names the deposit an observer would pick", async ({
    page,
  }) => {
    const { deposit } = await fixtures();
    await fillCheck(page, {
      amount: formatZat(deposit.amount - 30_000),
      when: deposit.time + 3_600,
    });
    await submit(page);
    await expect(page.getByText("Matches one deposit")).toBeVisible();
    await expect(page.getByText(formatZat(deposit.amount) + " ZEC").first()).toBeVisible();
  });

  test("a deposit that doesn't match the withdrawal is green", async ({ page }) => {
    const { deposit } = await fixtures();
    await fillCheck(page, {
      amount: "1",
      when: deposit.time + 3_600,
      deposit: formatZat(deposit.amount),
      depositAt: deposit.time,
    });
    await submit(page);
    await expect(page.getByText("No matching deposit")).toBeVisible();
  });

  test("a withdrawal long after the data ends warns that the data may be out of date", async ({
    page,
  }) => {
    const { dataTo } = await fixtures();
    await fillCheck(page, { amount: "1", when: dataTo + 10 * 86_400 });
    await submit(page);
    await expect(page.getByText("Data may be out of date")).toBeVisible();
  });

  test("the suggested common amount can be checked in one click", async ({ page }) => {
    const { deposit } = await fixtures();
    await fillCheck(page, {
      amount: formatZat(deposit.amount - 30_000),
      when: deposit.time + 3_600,
      deposit: formatZat(deposit.amount),
      depositAt: deposit.time,
    });
    await submit(page);
    await expect(page.locator(".verdict")).toBeVisible();
    const suggestion = page.getByRole("link", { name: /^Check .* ZEC instead$/ });
    if ((await suggestion.count()) === 0) test.skip(true, "no common amount below this deposit");
    await suggestion.click();
    await expect(
      page.getByRole("heading", { name: /: this|blends in|proceed/i }).first(),
    ).toBeVisible();
  });
});

test.describe("Pre-flight Check destination addresses", () => {
  test("a destination that deposited is red: address reuse", async ({ page }) => {
    const { reusedT1, dataTo } = await fixtures();
    await fillCheck(page, { amount: "1", when: dataTo - 3_600, to: reusedT1 });
    await submit(page);
    await expect(page.getByText("Address reuse")).toBeVisible();
  });

  test("a TEX address is seen through to the t1 account it pays", async ({ page }) => {
    const { reusedT1, reusedTex, dataTo } = await fixtures();
    await fillCheck(page, { amount: "1", when: dataTo - 3_600, to: reusedTex });
    await submit(page);
    await expect(page.getByText("Address reuse")).toBeVisible();
    await expect(page.getByText(reusedT1)).toBeVisible();
  });

  test("a fresh destination isn't flagged", async ({ page }) => {
    const { freshAddress, dataTo } = await fixtures();
    await fillCheck(page, { amount: "1", when: dataTo - 3_600, to: freshAddress });
    await submit(page);
    await expect(page.getByRole("heading", { name: /: / }).first()).toBeVisible();
    await expect(page.getByText("Address reuse")).toHaveCount(0);
  });

  for (const [label, address, message] of [
    ["a typo (checksum)", "t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yD", "checksum"],
    [
      "a shielded address",
      "zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9sly",
      "keeps the funds shielded",
    ],
    ["a testnet address", "tmBsTi2xWTjUdEXnuTceL7fecEQKeWaPDJd", "testnet"],
    ["something else", "hello", "start with t1, t3 or tex1"],
  ] as const) {
    test(`explains ${label}`, async ({ page }) => {
      const { dataTo } = await fixtures();
      await fillCheck(page, { amount: "1", when: dataTo - 3_600, to: address });
      await submit(page);
      await expect(page.locator("#destination-error")).toContainText(message);
      await expect(page.locator("#destination")).toHaveAttribute("aria-invalid", "true");
    });
  }
});

test.describe("Pre-flight Check input errors", () => {
  for (const [input, message] of [
    ["", "such as 2.5"],
    ["0", "more than 0"],
    ["-1", "can't be negative"],
    ["1,5", "use a dot for decimals"],
    ["1.123456789", "at most 8 decimal places"],
    ["30000000", "exceeds total supply"],
    ["abc", "such as 2.5"],
  ] as const) {
    test(`amount "${input}" is explained`, async ({ page }) => {
      await page.locator("#amount").fill(input);
      await submit(page);
      await expect(page.locator("#amount-error")).toContainText(message);
      await expect(page.locator("#amount")).toHaveAttribute("aria-invalid", "true");
      await expect(page.getByText("Your result appears here.")).toBeVisible();
    });
  }

  test("a deposit after the withdrawal is caught", async ({ page }) => {
    const { dataTo } = await fixtures();
    await fillCheck(page, {
      amount: "1",
      when: dataTo - 7_200,
      deposit: "1.0003",
      depositAt: dataTo - 3_600,
    });
    await submit(page);
    await expect(page.locator("#deposit-when-error")).toContainText(
      "has to be before the withdrawal",
    );
  });

  test("half a deposit (no time) is caught", async ({ page }) => {
    const { dataTo } = await fixtures();
    await fillCheck(page, { amount: "1", when: dataTo, deposit: "1.0003" });
    await submit(page);
    await expect(page.locator("#deposit-when-error")).toBeVisible();
  });

  test("a withdrawal before the data covers is explained", async ({ page }) => {
    const { manifest } = await fixtures();
    await page.locator("#amount").fill("1");
    await page.locator("#when").fill(`${manifest.fromDay}T12:00`);
    await submit(page);
    await expect(page.getByRole("alert")).toContainText("days of history");
  });
});

test.describe("Pre-flight Check behavior", () => {
  test("editing inputs after a result says the result is out of date", async ({ page }) => {
    const { dataTo } = await fixtures();
    await fillCheck(page, { amount: "1", when: dataTo - 3_600 });
    await submit(page);
    await expect(page.getByRole("heading", { name: /: / }).first()).toBeVisible();
    await page.locator("#amount").fill("2");
    await expect(page.getByText("You've changed the inputs since this result")).toBeVisible();
    await submit(page);
    await expect(page.getByText("You've changed the inputs since this result")).toHaveCount(0);
  });

  test("rapid repeated submits end in one consistent result", async ({ page }) => {
    const { dataTo } = await fixtures();
    await fillCheck(page, { amount: "1", when: dataTo - 3_600 });
    const button = page.getByRole("button", { name: /Check withdrawal|Checking/ });
    await Promise.all([
      button.click(),
      button.click({ force: true }),
      button.click({ force: true }),
    ]);
    // Wait until every request has answered, then count: a late response must not add a result.
    await expect(page.getByRole("button", { name: "Check withdrawal" })).toBeEnabled();
    await page.waitForTimeout(1_000);
    await expect(page.locator(".verdict")).toHaveCount(1);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("the landing page's amount is checked straight away, then dropped from the URL", async ({
    page,
  }) => {
    await page.goto("");
    await page.getByLabel("Amount to withdraw, in ZEC").fill("2.5");
    await page.getByRole("button", { name: /Check it/ }).click();
    await expect(page.locator(".verdict")).toBeVisible();
    await expect(page.locator("#amount")).toHaveValue("2.5");
    expect(page.url()).not.toContain("2.5");
  });

  test("the result is announced and receives focus", async ({ page }) => {
    const { dataTo } = await fixtures();
    await fillCheck(page, { amount: "1", when: dataTo - 3_600 });
    await submit(page);
    await expect(page.getByRole("heading", { name: /Result for 1 ZEC/ })).toBeFocused();
    await expect(page.locator("section[aria-live='polite']")).toContainText(": ");
  });

  test("datetime inputs accept the value the tests use", async ({ page }) => {
    const { dataTo } = await fixtures();
    await page.locator("#when").fill(utcInput(dataTo));
    await expect(page.locator("#when")).toHaveValue(utcInput(dataTo));
  });
});
