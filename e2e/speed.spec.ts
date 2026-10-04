import { chromium, expect, firefox, test, webkit, type Page } from "@playwright/test";
import { fixtures, waitForData } from "./fixtures";

/**
 * The app's own response times, measured inside the page (no automation overhead): from pressing
 * the button to the result being on screen. Each tool must answer within a second in every browser
 * once the data has loaded (median of three). Browsers run one at a time, after every other test,
 * so nothing else competes for the CPU.
 */
async function timeSubmit(page: Page, fields: Record<string, string>): Promise<number> {
  return page.evaluate(async (values) => {
    const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const areaSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    for (const [id, v] of Object.entries(values)) {
      const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
      (el instanceof HTMLTextAreaElement ? areaSetter : inputSetter).call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await new Promise((r) => setTimeout(r, 50));
    const heading = (): string | undefined =>
      document.querySelector("section[aria-live] h2")?.textContent ?? undefined;
    const before = heading();
    const started = performance.now();
    document.querySelector<HTMLButtonElement>("form button[type=submit]")!.click();
    await new Promise<void>((resolve) => {
      const poll = (): void => {
        const h = heading();
        if (h && h !== before) resolve();
        else requestAnimationFrame(poll);
      };
      poll();
    });
    return performance.now() - started;
  }, fields);
}

// Valid addresses that never crossed: the ZIP 320 test vector and the reuse test address.
const EXTRA = ["t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC", "t1Nsc8vCso3csJVoyX9YwvfwTuDHbCkZcjJ"];

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

test("every tool answers within a second in every browser, measured in the page", async ({
  baseURL,
}) => {
  const { dataTo, traced } = await fixtures();
  const at = new Date((dataTo - 3_600) * 1000).toISOString().slice(0, 16);
  const tools: [string, string, Record<string, string>[]][] = [
    [
      "entry",
      "#/enter",
      ["3.17423456", "12.3456789", "0.73"].map((a) => ({ "enter-amount": a, "enter-when": at })),
    ],
    ["check", "#/check", ["3.1742", "0.5", "7.123456"].map((a) => ({ amount: a, when: at }))],
    ["plan", "#/plan", ["3.5", "12.34", "0.9"].map((t) => ({ total: t, start: at }))],
    [
      "audit",
      "#/audit",
      // One, two, then three addresses, so each result has a new heading.
      [1, 2, 3].map((n) => ({
        "audit-addresses": [traced.address, ...EXTRA].slice(0, n).join(" "),
      })),
    ],
  ];
  const report: string[] = [];
  const slow: string[] = [];
  for (const [name, type] of [
    ["chromium", chromium],
    ["firefox", firefox],
    ["webkit", webkit],
  ] as const) {
    const browser = await type.launch();
    const page = await browser.newPage({ baseURL: baseURL!, timezoneId: "UTC" });
    const times: string[] = [];
    for (const [tool, route, inputs] of tools) {
      await page.goto(route);
      await waitForData(page);
      if (tool === "audit") {
        await expect(page.getByRole("button", { name: "Audit addresses" })).toBeEnabled({
          timeout: 60_000,
        });
      }
      const runs: number[] = [];
      for (const fields of inputs) {
        // Change a field between runs so each submit produces a new result heading.
        runs.push(await timeSubmit(page, fields));
      }
      const m = median(runs);
      times.push(`${tool} ${Math.round(m)}`);
      if (m >= 1_000) slow.push(`${name} ${tool}: ${Math.round(m)} ms`);
    }
    report.push(`${name}: ${times.join(", ")} ms`);
    await browser.close();
  }
  console.log(`in-page response times (median of 3)\n  ${report.join("\n  ")}`);
  expect(slow).toEqual([]);
});
