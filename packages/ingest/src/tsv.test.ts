import { describe, expect, it } from "vitest";
import { TsvFormatError, intField, parseTsv, timeField, totalField } from "./tsv.js";

async function* lines(...items: string[]): AsyncGenerator<string> {
  yield* items;
}

async function collect(it: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("parseTsv", () => {
  it("maps rows by header and turns \\N into null", async () => {
    const rows = await collect(parseTsv(lines("a\tb", "1\t\\N", "", "3\tx"), ["a", "b"]));
    expect(rows).toEqual([
      { a: "1", b: null },
      { a: "3", b: "x" },
    ]);
  });

  it("rejects a line with the wrong number of fields, naming the line", async () => {
    const run = collect(parseTsv(lines("a\tb", "1\t2", "3"), ["a"]));
    await expect(run).rejects.toThrow(TsvFormatError);
    await expect(collect(parseTsv(lines("a\tb", "1\t2", "3"), ["a"]))).rejects.toThrow(
      /line 3: expected 2 fields, got 1/,
    );
  });

  it("rejects a header missing required columns", async () => {
    await expect(collect(parseTsv(lines("a\tb"), ["a", "c"]))).rejects.toThrow(
      /missing columns: c/,
    );
  });

  it("rejects an empty file", async () => {
    await expect(collect(parseTsv(lines(), []))).rejects.toThrow(/empty file/);
  });
});

describe("field parsers", () => {
  it("accepts large and negative integers", () => {
    expect(intField({ v: "2100000000000000" }, "v")).toBe(2_100_000_000_000_000);
    expect(intField({ v: "-77693475" }, "v")).toBe(-77_693_475);
  });

  it("rejects non-integers, nulls and unsafe values", () => {
    for (const v of ["1.5", "", "abc", null, "99999999999999999999"]) {
      expect(() => intField({ v }, "v"), String(v)).toThrow(RangeError);
    }
  });

  it("normalizes a null total to 0 only when its count is 0", () => {
    expect(totalField({ t: null, c: "0" }, "t", "c")).toBe(0);
    expect(totalField({ t: "500", c: "2" }, "t", "c")).toBe(500);
    expect(() => totalField({ t: null, c: "1" }, "t", "c")).toThrow(/null but c is non-zero/);
  });

  it("parses Blockchair UTC timestamps", () => {
    expect(timeField({ t: "2026-09-28 00:01:32" }, "t")).toBe(
      Date.UTC(2026, 8, 28, 0, 1, 32) / 1000,
    );
    expect(() => timeField({ t: "2026-09-28T00:01:32" }, "t")).toThrow(RangeError);
  });
});
