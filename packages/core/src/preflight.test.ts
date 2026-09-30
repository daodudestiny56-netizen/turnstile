import { describe, expect, it } from "vitest";
import { AddressSet, buildAddressSet } from "./integrity.js";
import { planExit, planToIcs, planVerdict } from "./planner.js";
import {
  CROWD_TARGET,
  PreflightRangeError,
  createPreflightContext,
  preflight,
  roundDownAmount,
  type PreflightContext,
} from "./preflight.js";
import type { SnapshotData } from "./snapshot.js";

const H = 3_600;
const DAY = 86_400;
const T0 = 1_782_864_000;
const DATA_TO = T0 + 60 * DAY;

/**
 * A synthetic snapshot ending at DATA_TO with, in its last week:
 * - 15 parties each depositing 1 ZEC plus fees (a crowd),
 * - 3 parties depositing 0.5 ZEC plus fees (a thin crowd),
 * - one party depositing the precise 3.1745 ZEC (entity 500),
 * and exits of 1 ZEC spread over the last month for the planner's activity profile.
 */
function snapshot(): SnapshotData {
  const shields = [
    ...Array.from({ length: 15 }, (_, i) => ({
      time: DATA_TO - (i + 2) * 6 * H,
      amount: 100_030_000,
      entity: i,
    })),
    ...Array.from({ length: 3 }, (_, i) => ({
      time: DATA_TO - (i + 2) * 10 * H,
      amount: 50_030_000,
      entity: 100 + i,
    })),
    { time: DATA_TO - 2 * H, amount: 317_450_000, entity: 500 },
  ];
  const exits = Array.from({ length: 60 }, (_, i) => ({
    time: DATA_TO - 30 * DAY + i * 12 * H,
    amount: 100_000_000,
  }));
  return { dataFrom: T0, dataTo: DATA_TO, shields, services: [], exits };
}

async function context(): Promise<PreflightContext> {
  return createPreflightContext(
    snapshot(),
    new AddressSet(await buildAddressSet(["t1ReusedAddress"])),
  );
}

describe("preflight", () => {
  it("is green inside a crowd", async () => {
    const r = await preflight(await context(), { amount: 100_000_000, time: DATA_TO - H });
    expect(r.verdict).toBe("green");
    expect(r.crowd).toBe(15);
    expect(r.reasons.map((x) => x.code)).toEqual(["crowd"]);
  });

  it("is red when the withdrawal is the user's own deposit and nobody else matches", async () => {
    const r = await preflight(
      await context(),
      { amount: 317_420_000, time: DATA_TO - H },
      { amount: 317_450_000, time: DATA_TO - 2 * H },
    );
    expect(r.verdict).toBe("red");
    expect(r.crowd).toBe(0); // the user's deposit, found in the data, is not counted as a rival
    expect(r.reasons[0]?.code).toBe("exact-round-trip");
  });

  it("without the user's deposit, still reports the single deposit an observer would pick", async () => {
    const r = await preflight(await context(), { amount: 317_420_000, time: DATA_TO - H });
    expect(r.verdict).toBe("red");
    expect(r.reasons[0]?.code).toBe("unique-match");
    expect(r.matchedDeposit).toEqual({
      time: DATA_TO - 2 * H,
      amount: 317_450_000,
      service: false,
    });
  });

  it("suggests a common amount for a precise one", async () => {
    const r = await preflight(
      await context(),
      { amount: 317_420_000, time: DATA_TO - H },
      { amount: 317_450_000, time: DATA_TO - 2 * H },
    );
    expect(r.suggestedAmount).toBe(100_000_000); // 1 ZEC hides among 15 >= CROWD_TARGET
    expect(r.reasons.find((x) => x.code === "precise-amount")?.message).toMatch(/15 parties/);
  });

  it("is amber in a thin crowd, and doesn't count the user's own deposit as a rival", async () => {
    const ctx = await context();
    const exit = { amount: 50_000_000, time: DATA_TO - H };
    expect((await preflight(ctx, exit)).reasons[0]).toMatchObject({
      code: "thin-crowd",
      severity: "amber",
    });
    const mine = await preflight(ctx, exit, { amount: 50_030_000, time: DATA_TO - 20 * H });
    expect(mine.crowd).toBe(2);
    expect(mine.reasons[0]?.message).toMatch(/one of 3/);
  });

  it("is green when the user's deposit doesn't match the withdrawal", async () => {
    const r = await preflight(
      await context(),
      { amount: 100_000_000, time: DATA_TO - H },
      { amount: 317_450_000, time: DATA_TO - 2 * H },
    );
    expect(r.verdict).toBe("green");
    expect(r.reasons.map((x) => x.code)).toContain("no-match");
  });

  it("flags a destination that funded a deposit, checking the hash locally", async () => {
    const ctx = await context();
    const reused = await preflight(ctx, {
      amount: 100_000_000,
      time: DATA_TO - H,
      destination: "t1ReusedAddress",
    });
    expect(reused.verdict).toBe("red");
    expect(reused.reasons[0]?.code).toBe("address-reuse");
    const fresh = await preflight(ctx, {
      amount: 100_000_000,
      time: DATA_TO - H,
      destination: "t1FreshAddress",
    });
    expect(fresh.reasons.map((x) => x.code)).not.toContain("address-reuse");
  });

  it("warns when the data is more than two days old, measuring the crowd at the data's end", async () => {
    const r = await preflight(await context(), { amount: 100_000_000, time: DATA_TO + 3 * DAY });
    expect(r.verdict).toBe("amber");
    expect(r.reasons.map((x) => x.code)).toEqual(["stale-data", "crowd"]);
    expect(r.data).toEqual({ dataTo: DATA_TO, staleness: 3 * DAY, crowdMeasuredAt: DATA_TO });
    expect(r.crowd).toBe(15);
    const fresh = await preflight(await context(), { amount: 100_000_000, time: DATA_TO + DAY });
    expect(fresh.reasons.map((x) => x.code)).not.toContain("stale-data");
  });

  it("refuses withdrawals it has no history for, and nonsense amounts", async () => {
    const ctx = await context();
    await expect(preflight(ctx, { amount: 100_000_000, time: T0 + DAY })).rejects.toThrow(
      PreflightRangeError,
    );
    await expect(preflight(ctx, { amount: 0, time: DATA_TO })).rejects.toThrow(PreflightRangeError);
  });

  it("rounds down to where crowds form", () => {
    expect(roundDownAmount(317_420_000)).toBe(317_000_000);
    expect(roundDownAmount(512_345)).toBe(500_000);
  });
});

describe("planExit", () => {
  // After the user's deposit (DATA_TO - 2h), so the single exit is a round trip.
  const start = DATA_TO - H;
  const own = { amount: 317_450_000, time: DATA_TO - 2 * H };

  it("splits into legs that each reach the crowd target, keeping the rest shielded", async () => {
    const plan = await planExit(await context(), {
      total: 317_420_000,
      start,
      horizonHours: 72,
      seed: 1,
      own,
    });
    expect(plan.singleExit.verdict).toBe("red");
    expect(plan.targetMet).toBe(true);
    expect(plan.legs.map((l) => l.amount)).toEqual([100_000_000, 100_000_000, 100_000_000]);
    expect(plan.legs.every((l) => l.crowd >= CROWD_TARGET)).toBe(true);
    expect(plan.withdrawn + plan.remainder).toBe(317_420_000);
    expect(plan.remainder).toBe(17_420_000);
    expect(plan.weakestLegCrowd).toBe(15);
  });

  it("times legs inside the horizon, at least an hour apart, and is deterministic per seed", async () => {
    const ctx = await context();
    const options = { total: 317_420_000, start, horizonHours: 72, seed: 42 };
    const a = await planExit(ctx, options);
    const b = await planExit(ctx, options);
    const c = await planExit(ctx, { ...options, seed: 43 });
    expect(b).toEqual(a);
    expect(c.legs.map((l) => l.time)).not.toEqual(a.legs.map((l) => l.time));
    const times = a.legs.map((l) => l.time);
    expect(Math.min(...times)).toBeGreaterThanOrEqual(start + H);
    expect(Math.max(...times)).toBeLessThanOrEqual(start + 72 * H);
    for (let i = 1; i < times.length; i++)
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(H);
  });

  it("uses the best available amount when nothing reaches the target, and says so", async () => {
    const plan = await planExit(await context(), {
      total: 317_420_000,
      start,
      horizonHours: 48,
      seed: 1,
      crowdTarget: 100,
    });
    expect(plan.targetMet).toBe(false);
    expect(plan.legs.every((l) => l.amount === 100_000_000)).toBe(true);
    expect(plan.advice[0]).toMatch(/best available/);
  });

  it("keeps a total smaller than any common amount shielded", async () => {
    const plan = await planExit(await context(), {
      total: 50_000,
      start,
      horizonHours: 24,
      seed: 1,
    });
    expect(plan.legs).toEqual([]);
    expect(plan.remainder).toBe(50_000);
    expect(plan.advice.join(" ")).toMatch(/keeping it shielded/);
  });

  it("explains a large remainder left by the leg limit, with the withdrawals it would take", async () => {
    const plan = await planExit(await context(), {
      total: 5_000_000_000, // 50 ZEC; only 1 ZEC blends in
      start,
      horizonHours: 36,
      maxLegs: 2,
      seed: 1,
    });
    expect(plan.withdrawn).toBe(200_000_000);
    const advice = plan.advice.join(" ");
    expect(advice).toMatch(/48 ZEC stays shielded because the plan is limited to 2 legs/);
    expect(advice).toMatch(/about 50 withdrawals/);
    expect(advice).not.toMatch(/smaller than any amount/);
  });

  it("calls a small remainder too small to blend in", async () => {
    const plan = await planExit(await context(), {
      total: 317_420_000,
      start,
      horizonHours: 36,
      seed: 1,
    });
    expect(plan.advice.join(" ")).toMatch(
      /remaining 0.1742 ZEC shielded: it's smaller than any amount/,
    );
  });

  it("exports calendar reminders", async () => {
    // A 36-hour horizon keeps every leg within two days of the data, so none is flagged stale.
    const plan = await planExit(await context(), {
      total: 317_420_000,
      start,
      horizonHours: 36,
      seed: 1,
    });
    const ics = planToIcs(plan);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(3);
    expect(ics).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(ics).toMatch(/DTSTART:\d{8}T\d{6}Z\r\n/);
    expect(ics).toContain("SUMMARY:Withdraw 1 ZEC (leg 1 of 3)");
    expect(planVerdict(plan)).toBe("green");
    for (const line of ics.split("\r\n")) expect(line.length).toBeLessThanOrEqual(75);
    expect(ics.replace(/\r\n /g, "")).toContain("has never deposited into the shielded pool.");
  });
});
