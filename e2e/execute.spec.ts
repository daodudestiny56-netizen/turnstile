import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { fixtures, utcInput, waitForData } from "./fixtures";

const API = "https://1click.chaindefuser.com";
const RECIPIENT = "0x2527D02599Ba641c19FEa793cD0F167589a0f10D";
// Official zcash-test-vectors: an Orchard-only unified address, and a Sapling address.
const UA =
  "u1ay3aawlldjrmxqnjf5medr5ma6p3acnet464ht8lmwplq5cd3ugytcmlf96rrmtgwldc75x94qn4n8pgen36y8tywlq6yjk7lkf3fa8wzjrav8z2xpxqnrnmjxh8tmz6jhfh425t7f3vy6p4pd3zmqayq49efl2c4xydc0gszg660q9p";
const SAPLING = "zs1mrhc9y7jdh5r9ece8u5khgvj9kg0zgkxzdduyv0whkg7lkcrkx5xqem3e48avjq9wn2rukydkwn";
// A real one-time deposit address NEAR Intents issued during development (never funded).
const DEPOSIT = "t1TDVLNjs5kq1WBWsGmUuCtfq9R3qD2FNip";

interface Mock {
  calls: { path: string; body?: Record<string, unknown> }[];
  status: string;
}

/** Stand in for NEAR Intents, recording every call the page makes to it. */
async function mockIntents(page: Page, overrides: { quoteError?: string } = {}): Promise<Mock> {
  const mock: Mock = { calls: [], status: "PENDING_DEPOSIT" };
  await page.route(`${API}/**`, async (route: Route) => {
    const url = new URL(route.request().url());
    const body = route.request().postData();
    mock.calls.push({ path: url.pathname, ...(body ? { body: JSON.parse(body) } : {}) });
    if (url.pathname === "/v0/quote") {
      if (overrides.quoteError) {
        return route.fulfill({ status: 400, json: { message: overrides.quoteError } });
      }
      const req = JSON.parse(body!);
      const amountOut = String(Math.round(Number(req.amount) * 13.8));
      return route.fulfill({
        status: 201,
        json: {
          correlationId: "test",
          timestamp: new Date().toISOString(),
          signature: "ed25519:test",
          quoteRequest: req,
          quote: {
            ...(req.dry ? {} : { depositAddress: DEPOSIT, deadline: "2026-10-05T12:00:00.000Z" }),
            amountIn: req.amount,
            amountInFormatted: String(Number(req.amount) / 1e8),
            amountOut,
            amountOutFormatted: (Number(amountOut) / 1e6).toFixed(6),
            amountOutUsd: "0",
            minAmountOut: String(Math.round(Number(amountOut) * 0.99)),
            timeEstimate: 457,
          },
        },
      });
    }
    if (url.pathname === "/v0/status") {
      return route.fulfill({
        json: {
          status: mock.status,
          updatedAt: new Date().toISOString(),
          swapDetails: { amountOutFormatted: mock.status === "SUCCESS" ? "13.8" : null },
        },
      });
    }
    return route.fulfill({ status: 404, json: { message: "not mocked" } });
  });
  return mock;
}

/** Make a plan and open Execute on its first leg; returns that leg's amount in zatoshi. */
async function openExecute(page: Page, start?: number): Promise<number> {
  const { dataTo } = await fixtures();
  await page.goto("#/plan");
  await waitForData(page);
  await page.locator("#total").fill("3.5");
  await page.locator("#start").fill(utcInput(start ?? dataTo - 12 * 3_600));
  await page.getByRole("button", { name: "Make a plan" }).click();
  await expect(page.getByRole("heading", { name: "The plan", exact: true })).toBeVisible();
  const first = page.locator(".legs .leg").first();
  const amount = Math.round(
    Number((await first.locator(".leg-amount").textContent())!.replace(" ZEC", "")) * 1e8,
  );
  await first.getByRole("button", { name: /^Execute withdrawal 1/ }).click();
  await expect(page.getByRole("heading", { name: /Execute withdrawal 1 of/ })).toBeFocused();
  return amount;
}

async function fill(page: Page, refund = UA, recipient = RECIPIENT): Promise<void> {
  await page.locator("#exec-recipient").fill(recipient);
  await page.locator("#exec-refund").fill(refund);
}

test.describe("Execute through NEAR Intents (mocked)", () => {
  test("nothing reaches NEAR Intents until the user asks for a price", async ({ page }) => {
    const mock = await mockIntents(page);
    const amount = await openExecute(page);
    await expect(page.getByText(/This step contacts/)).toBeVisible();
    await fill(page);
    expect(mock.calls, "requests before asking for a price").toEqual([]);
    await page.getByRole("button", { name: "Get a price" }).click();
    await expect(page.getByText(/You'd receive about/)).toBeVisible();
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]!.path).toBe("/v0/quote");
    expect(mock.calls[0]!.body).toMatchObject({
      dry: true,
      swapType: "EXACT_INPUT",
      originAsset: "nep141:zec.omft.near",
      amount: String(amount),
      recipient: RECIPIENT,
      refundTo: UA,
    });
    await expect(page.getByText("No deposit address exists yet")).toBeVisible();
  });

  test("price, then deposit address with QR, payment link and live status", async ({ page }) => {
    const mock = await mockIntents(page);
    const amount = await openExecute(page);
    await fill(page);
    await page.getByRole("button", { name: "Get a price" }).click();
    await page.getByRole("button", { name: "Get the deposit address" }).click();

    await expect(page.locator("code.address")).toHaveText(DEPOSIT);
    const uri = `zcash:${DEPOSIT}?amount=${amount / 1e8}`;
    await expect(page.getByRole("link", { name: "Open in wallet" })).toHaveAttribute("href", uri);
    const qr = page.getByRole("img", { name: new RegExp(`Payment request: .* to ${DEPOSIT}`) });
    await expect(qr).toBeVisible();
    expect(((await qr.locator("path").getAttribute("d")) ?? "").length).toBeGreaterThan(500);
    await expect(page.getByText("Waiting for your deposit")).toBeVisible();
    expect(mock.calls.filter((c) => c.path === "/v0/quote" && c.body?.dry === false)).toHaveLength(
      1,
    );

    mock.status = "SUCCESS";
    await page.getByRole("button", { name: "Check status now" }).click();
    await expect(page.locator(".swap-status")).toContainText("Done");
    await expect(page.locator(".swap-status")).toContainText("13.8 USDC received");
  });

  test("a Sapling refund address is refused before anything is sent", async ({ page }) => {
    const mock = await mockIntents(page);
    await openExecute(page);
    await fill(page, SAPLING);
    await page.getByRole("button", { name: "Get a price" }).click();
    await expect(page.locator("#exec-refund-error")).toContainText("Use a unified address");
    expect(mock.calls).toEqual([]);
  });

  test("a recipient in the wrong format is caught before anything is sent", async ({ page }) => {
    const mock = await mockIntents(page);
    await openExecute(page);
    await page.locator("#exec-asset").selectOption("usdc-sol");
    await fill(page, UA, RECIPIENT);
    await page.getByRole("button", { name: "Get a price" }).click();
    await expect(page.locator("#exec-recipient-error")).toContainText("Solana");
    expect(mock.calls).toEqual([]);
  });

  test("a transparent refund address is allowed, with a privacy note", async ({ page }) => {
    await mockIntents(page);
    await openExecute(page);
    await fill(page, "t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC");
    await page.getByRole("button", { name: "Get a price" }).click();
    await expect(page.getByText(/Refunds would land on a transparent address/)).toBeVisible();
    await expect(page.getByText(/You'd receive about/)).toBeVisible();
  });

  test("NEAR Intents' own error is shown", async ({ page }) => {
    await mockIntents(page, { quoteError: "recipient is not valid" });
    await openExecute(page);
    await fill(page);
    await page.getByRole("button", { name: "Get a price" }).click();
    await expect(page.getByRole("alert")).toContainText("NEAR Intents: recipient is not valid");
  });

  test("executing before a leg's planned time warns about timing", async ({ page }) => {
    await mockIntents(page);
    await openExecute(page, Math.floor(Date.now() / 1000) + 86_400);
    await expect(page.getByText(/This withdrawal is planned for/)).toBeVisible();
  });

  test("the payment step has no serious accessibility issues", async ({ page }) => {
    await mockIntents(page);
    await openExecute(page);
    await fill(page);
    await page.getByRole("button", { name: "Get a price" }).click();
    await page.getByRole("button", { name: "Get the deposit address" }).click();
    await expect(page.locator("code.address")).toBeVisible();
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual([]);
  });
});

test.describe("Execute against the real NEAR Intents API", () => {
  test.skip(!process.env.LIVE_INTENTS, "set LIVE_INTENTS=1 to call the real API (no funds move)");

  test("a real dry quote works from the page: CORS and the CSP allow it", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await openExecute(page);
    await fill(page);
    await page.getByRole("button", { name: "Get a price" }).click();
    await expect(page.getByText(/You'd receive about/)).toBeVisible();
    expect(errors).toEqual([]);
  });
});
