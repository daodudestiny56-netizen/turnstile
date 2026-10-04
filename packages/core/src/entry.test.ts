import { describe, expect, it } from "vitest";
import { SHIELD_FEE_ZAT, planEntry } from "./entry.js";
import { CROWD_TARGET, PreflightRangeError, createPreflightContext } from "./preflight.js";
import type { SnapshotData } from "./snapshot.js";

const H = 3_600;
const DAY = 86_400;
const T0 = 1_782_864_000;
const DATA_TO = T0 + 60 * DAY;

/** 15 parties deposited 1 ZEC and 3 deposited 0.5 ZEC (fees included) in the last week. */
function context(): ReturnType<typeof createPreflightContext> {
  const shields = [
    ...Array.from({ length: 15 }, (_, i) => ({
      time: DATA_TO - (i + 2) * 6 * H,
      amount: 100_000_000 + SHIELD_FEE_ZAT,
      entity: i,
    })),
    ...Array.from({ length: 3 }, (_, i) => ({
      time: DATA_TO - (i + 2) * 10 * H,
      amount: 50_000_000 + SHIELD_FEE_ZAT,
      entity: 100 + i,
    })),
  ];
  const data: SnapshotData = { dataFrom: T0, dataTo: DATA_TO, shields, services: [], exits: [] };
  return createPreflightContext(data);
}

describe("planEntry", () => {
  it("is green when the balance is already a common amount", () => {
    const r = planEntry(context(), { balance: 100_000_000 + SHIELD_FEE_ZAT });
    expect(r.verdict).toBe("green");
    expect(r.asIs.crowd).toBe(15);
    expect(r.common).toBeUndefined();
    expect(r.reasons.map((x) => x.code)).toEqual(["common-entry"]);
    // Timing and address advice apply to every deposit.
    expect(r.advice.join(" ")).toMatch(/Wait at least a day/);
    expect(r.advice.join(" ")).toMatch(/Never withdraw back to the address/);
  });

  it("is red for a precise amount nobody else used, and offers both ways out", () => {
    const balance = 312_345_678;
    const r = planEntry(context(), { balance });
    expect(r.verdict).toBe("red");
    expect(r.asIs).toEqual({ crowd: 0, expectedChance: 0 });
    expect(r.reasons[0]!.code).toBe("unique-entry");
    expect(r.common).toEqual({
      amount: 100_000_000,
      crowd: 15,
      keepTransparent: balance - 100_000_000 - SHIELD_FEE_ZAT,
    });
    expect(r.common!.crowd).toBeGreaterThanOrEqual(CROWD_TARGET);
    expect(r.advice[0]).toMatch(
      /deposit all 3.12345678 ZEC, and later withdraw with the Exit Planner/,
    );
    expect(r.advice[1]).toMatch(/deposit 1 ZEC instead/);
  });

  it("never suggests more than the balance can pay for, fee included", () => {
    const r = planEntry(context(), { balance: 100_000_000 + SHIELD_FEE_ZAT - 1 });
    expect(r.common).toBeUndefined();
    expect(r.reasons.map((x) => x.code)).toContain("no-common-amount");
    const exact = planEntry(context(), { balance: 100_000_000 + SHIELD_FEE_ZAT + 7 });
    expect(exact.common).toEqual({ amount: 100_000_000, crowd: 15, keepTransparent: 7 });
  });

  it("is amber for a thin crowd, and says when nothing common fits", () => {
    const r = planEntry(context(), { balance: 50_000_000 + SHIELD_FEE_ZAT });
    expect(r.verdict).toBe("amber");
    expect(r.asIs.crowd).toBe(3);
    expect(r.common).toBeUndefined();
    expect(r.reasons.map((x) => x.code)).toEqual(["thin-entry", "no-common-amount"]);
  });

  it("measures at the end of the data, and warns, when the deposit is later", () => {
    const r = planEntry(context(), { balance: 312_345_678, time: DATA_TO + 3 * DAY });
    expect(r.data.measuredAt).toBe(DATA_TO);
    expect(r.reasons.map((x) => x.code)).toContain("stale-data");
    const fresh = planEntry(context(), { balance: 312_345_678, time: DATA_TO + DAY });
    expect(fresh.reasons.map((x) => x.code)).not.toContain("stale-data");
  });

  it("refuses amounts that can't pay a fee, and times the data can't judge", () => {
    expect(() => planEntry(context(), { balance: 0 })).toThrow(PreflightRangeError);
    expect(() => planEntry(context(), { balance: 1.5 })).toThrow(PreflightRangeError);
    expect(() => planEntry(context(), { balance: SHIELD_FEE_ZAT })).toThrow(/network fee/);
    expect(() => planEntry(context(), { balance: 100_000_000, time: T0 + DAY })).toThrow(
      /doesn't reach far enough back/,
    );
  });
});
