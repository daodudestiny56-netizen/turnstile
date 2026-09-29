import { describe, expect, it } from "vitest";
import { dayRange, daysBefore, parseDay } from "./days.js";

describe("days", () => {
  it("builds inclusive ranges across month boundaries", () => {
    expect(dayRange("2026-06-29", "2026-07-02")).toEqual([
      "2026-06-29",
      "2026-06-30",
      "2026-07-01",
      "2026-07-02",
    ]);
    expect(dayRange("2026-09-28", "2026-09-28")).toEqual(["2026-09-28"]);
  });

  it("computes the start of an N-day window", () => {
    expect(daysBefore("2026-09-28", 90)).toBe("2026-07-01");
    expect(dayRange(daysBefore("2026-09-28", 90), "2026-09-28")).toHaveLength(90);
  });

  it("rejects invalid days and reversed ranges", () => {
    expect(() => parseDay("2026-02-30")).toThrow(RangeError);
    expect(() => parseDay("20260928")).toThrow(RangeError);
    expect(() => dayRange("2026-09-28", "2026-09-27")).toThrow(RangeError);
    expect(() => daysBefore("2026-09-28", 0)).toThrow(RangeError);
  });
});
