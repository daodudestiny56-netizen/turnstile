import { expect, test } from "@playwright/test";
import { fillCheck, fixtures, formatZat, waitForData } from "./fixtures";

test("after the snapshot loads, a full journey makes no network requests at all", async ({
  page,
  baseURL,
}) => {
  const { deposit, reusedTex, traced } = await fixtures();
  const requests: { phase: string; url: string }[] = [];
  const problems: string[] = [];
  let phase = "loading";
  page.on("request", (r) => {
    if (/^https?:/.test(r.url())) requests.push({ phase, url: r.url() });
  });
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(m.text());
  });
  page.on("pageerror", (e) => problems.push(String(e)));

  await page.goto("#/audit");
  await waitForData(page);
  // The audit index follows in the background for every visitor; wait for it too.
  await expect(page.getByRole("button", { name: "Audit addresses" })).toBeEnabled({
    timeout: 45_000,
  });
  await page.waitForLoadState("networkidle");
  phase = "using";

  await page.locator("#audit-addresses").fill(traced.address);
  await page.getByRole("button", { name: "Audit addresses" }).click();
  await expect(page.locator(".verdict-red")).toBeVisible();
  await page.getByRole("link", { name: "Entry Planner" }).first().click();
  await page.locator("#enter-amount").fill("3.17423456");
  await page.getByRole("button", { name: "Check deposit" }).click();
  await expect(page.locator(".verdict")).toBeVisible();
  await page.getByRole("link", { name: "Pre-flight Check" }).first().click();

  await fillCheck(page, {
    amount: formatZat(deposit.amount - 30_000),
    when: deposit.time + 3_600,
    deposit: formatZat(deposit.amount),
    depositAt: deposit.time,
    to: reusedTex,
  });
  await page.getByRole("button", { name: "Check withdrawal" }).click();
  await expect(page.locator(".verdict-red")).toBeVisible();
  await page.getByRole("link", { name: /Plan a safer exit/ }).click();
  await expect(page.getByRole("heading", { name: "The plan", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Leak Meter" }).first().click();
  await page.getByRole("button", { name: "Show as table" }).click();
  await page.getByRole("button", { name: /Switch to (light|dark) theme/ }).click();
  await page.getByRole("link", { name: "Turnstile" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  const after = requests.filter((r) => r.phase === "using").map((r) => r.url);
  expect(after, "requests after the snapshot loaded").toEqual([]);
  expect(requests.filter((r) => !r.url.startsWith(baseURL!))).toEqual([]);
  expect(problems, "console errors, CSP violations, page errors").toEqual([]);
});

test("nothing but the theme is stored in the browser", async ({ page }) => {
  const { dataTo } = await fixtures();
  await page.goto("#/check");
  await waitForData(page);
  await fillCheck(page, {
    amount: "1.2345",
    when: dataTo - 3_600,
    deposit: "1.2348",
    depositAt: dataTo - 7_200,
  });
  await page.getByRole("button", { name: "Check withdrawal" }).click();
  await expect(page.locator(".verdict")).toBeVisible();
  const stored = await page.evaluate(() => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
    cookies: document.cookie,
  }));
  expect(stored.local.filter((k) => k !== "turnstile-theme")).toEqual([]);
  expect(stored.session).toEqual([]);
  expect(stored.cookies).toBe("");
});

test("amounts passed between pages don't stay in the address bar", async ({ page }) => {
  const { deposit } = await fixtures();
  await page.goto("#/check");
  await waitForData(page);
  await fillCheck(page, {
    amount: formatZat(deposit.amount - 30_000),
    when: deposit.time + 3_600,
    deposit: formatZat(deposit.amount),
    depositAt: deposit.time,
  });
  await page.getByRole("button", { name: "Check withdrawal" }).click();
  await page.getByRole("link", { name: /Plan a safer exit/ }).click();
  await expect(page.locator("#total")).toHaveValue(formatZat(deposit.amount - 30_000));
  await expect(page).toHaveURL(/#\/plan$/);
});

test("the page carries a strict Content Security Policy and no referrer", async ({ page }) => {
  await page.goto("");
  const csp = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute("content");
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("connect-src 'self' https://1click.chaindefuser.com");
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute("content", "no-referrer");
});
