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
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
