import { describe, expect, it } from "vitest";
import { MAX_ZAT, formatZat, parsePositiveZec, zecToZat } from "./amount.js";

describe("zecToZat", () => {
  it("parses whole and fractional amounts exactly", () => {
    expect(zecToZat("3.1742")).toBe(317_420_000);
    expect(zecToZat("0.00000001")).toBe(1);
    expect(zecToZat("1")).toBe(100_000_000);
    expect(zecToZat(" 0.1 ")).toBe(10_000_000);
  });

  it("avoids floating-point error", () => {
    // 0.1 + 0.2 style inputs must stay exact
    expect(zecToZat("0.3")).toBe(30_000_000);
    expect(zecToZat("1.13")).toBe(113_000_000);
  });

  it("rejects malformed or out-of-range input", () => {
    for (const bad of ["", ".", "-1", "1.123456789", "abc", "1e3", "1,5", "1.2.3"]) {
      expect(() => zecToZat(bad), bad).toThrow(RangeError);
    }
    expect(() => zecToZat("21000001")).toThrow(RangeError);
  });
});

describe("amount input as people type it", () => {
  it("accepts a leading or trailing dot", () => {
    expect(zecToZat(".5")).toBe(50_000_000);
    expect(zecToZat("2.")).toBe(200_000_000);
  });

  it("explains what's wrong", () => {
    expect(() => zecToZat("1,5")).toThrow(/use a dot for decimals, e.g. 1.5/);
    expect(() => zecToZat("1.123456789")).toThrow(/at most 8 decimal places/);
    expect(() => zecToZat("-1")).toThrow(/can't be negative/);
    expect(() => zecToZat("abc")).toThrow(/such as 2.5/);
  });

  it("requires more than zero for an amount to move", () => {
    expect(parsePositiveZec("0.00000001")).toBe(1);
    expect(() => parsePositiveZec("0")).toThrow(/more than 0/);
    expect(() => parsePositiveZec("0.000")).toThrow(/more than 0/);
  });
});

describe("formatZat", () => {
  it("formats without trailing zeros", () => {
    expect(formatZat(317_420_000)).toBe("3.1742");
    expect(formatZat(100_000_000)).toBe("1");
    expect(formatZat(1)).toBe("0.00000001");
    expect(formatZat(0)).toBe("0");
  });

  it("round-trips with zecToZat", () => {
    for (const zat of [0, 1, 99_999_999, 317_420_000, MAX_ZAT]) {
      expect(zecToZat(formatZat(zat))).toBe(zat);
    }
  });

  it("rejects non-integer or negative input", () => {
    expect(() => formatZat(-1)).toThrow(RangeError);
    expect(() => formatZat(1.5)).toThrow(RangeError);
  });
});
