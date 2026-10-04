import { defineConfig, devices } from "@playwright/test";

const PORT = 4174;

/**
 * End-to-end tests of the production build in Chromium, Firefox and WebKit.
 * Build first (`pnpm build`); `pnpm e2e` runs everything.
 */
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: true,
  // Three browsers in parallel on one machine starved WebKit and crashed Firefox's compositor.
  workers: 2,
  retries: 0,
  reporter: [["list"]],
  outputDir: "../data/e2e-results",
  use: {
    baseURL: `http://127.0.0.1:${PORT}/`,
    timezoneId: "UTC",
    locale: "en-US",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node e2e/serve.mjs ${PORT}`,
    cwd: "..",
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: /speed.spec.ts/ },
    { name: "firefox", use: { ...devices["Desktop Firefox"] }, testIgnore: /speed.spec.ts/ },
    // Driving WebKit on Windows is several times slower than the page itself (a click can take
    // seconds of automation overhead while the app answers in under 300 ms), so its tests get more
    // time. speed.spec.ts measures the app's own response times inside the page in every browser.
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      testIgnore: /speed.spec.ts/,
      timeout: 150_000,
    },
    // Response times are measured last, one browser at a time, so other tests don't compete for CPU.
    {
      name: "speed",
      testMatch: /speed.spec.ts/,
      dependencies: ["chromium", "firefox", "webkit"],
      timeout: 300_000,
    },
  ],
});
