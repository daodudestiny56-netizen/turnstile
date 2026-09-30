import { expect, test } from "@playwright/test";
import { waitForData } from "./fixtures";

test.describe("loading the data snapshot", () => {
  test("verifies when the host decompresses it in transit (Content-Encoding: gzip)", async ({
    page,
  }) => {
    await page.goto("#/check");
    await waitForData(page);
    await expect(page.getByRole("button", { name: "Check withdrawal" })).toBeEnabled();
  });

  test("verifies when served exactly as stored", async ({ page }) => {
    await page.goto("plain/#/check");
    await waitForData(page);
  });

  test("shows progress on a slow connection, then works", async ({ page }) => {
    await page.goto("slow/#/check");
    await expect(
      page.getByText("Downloading and verifying the public data snapshot"),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Check withdrawal" })).toBeDisabled();
    await waitForData(page);
    await expect(page.getByRole("button", { name: "Check withdrawal" })).toBeEnabled();
  });

  test("a missing snapshot gives a clear error and a way to retry", async ({ page }) => {
    await page.goto("missing/#/check");
    const alert = page.getByRole("alert");
    await expect(alert).toContainText("couldn't be loaded");
    await expect(alert).toContainText("missing");
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Check withdrawal" })).toBeDisabled();
  });

  test("a tampered snapshot is refused, never used", async ({ page }) => {
    await page.goto("tampered/#/check");
    await expect(page.getByRole("alert")).toContainText("matches neither");
    await expect(page.getByRole("button", { name: "Check withdrawal" })).toBeDisabled();
  });

  test("a broken analysis engine fails visibly instead of hanging", async ({ page }) => {
    await page.goto("noworker/#/check");
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  test("Try again recovers after a failed download", async ({ page }, info) => {
    await page.goto(`flaky/${info.project.name}-${Date.now()}/#/check`);
    await expect(page.getByRole("alert")).toBeVisible();
    await page.getByRole("button", { name: "Try again" }).click();
    await waitForData(page);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("the landing page works before the data arrives", async ({ page }) => {
    await page.goto("slow/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Leave the shielded pool");
    await expect(page.getByLabel("Amount to withdraw, in ZEC")).toBeEditable();
  });
});
