import { afterEach, expect, it, vi } from "vitest";
import { run } from "./index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it("converts ZEC to zatoshi", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await run(["zat", "3.1742"]);
  expect(log).toHaveBeenCalledWith("3.1742 ZEC = 317420000 zat");
});

it("rejects an invalid amount", async () => {
  await expect(run(["zat", "abc"])).rejects.toThrow(RangeError);
});
