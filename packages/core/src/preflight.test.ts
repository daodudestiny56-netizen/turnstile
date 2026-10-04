import { describe, expect, it } from "vitest";
import { AddressSet, buildAddressSet } from "./integrity.js";
import { DEFAULT_MATCH_PARAMS } from "./matcher.js";
import { chooseLegs, linkedSums, planExit, planToIcs, planVerdict } from "./planner.js";
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
// Real mainnet addresses (valid checksums): one that deposited, one that didn't.
const REUSED = "t1SEgZvXCu3ceE42qrq5pCeSq7HbLjX8NJv";
const FRESH = "t1Nsc8vCso3csJVoyX9YwvfwTuDHbCkZcjJ";

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
  return createPreflightContext(snapshot(), new AddressSet(await buildAddressSet([REUSED])));
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

  it("recognises the user's deposit even when its time is typed hours off", async () => {
    // The real deposit is 2 hours before the withdrawal; the user types it 3 hours earlier still
    // (a time-zone slip). It must not count as somebody else's deposit.
    const r = await preflight(
      await context(),
      { amount: 317_420_000, time: DATA_TO - H },
      { amount: 317_450_000, time: DATA_TO - 5 * H },
    );
    expect(r.crowd).toBe(0);
    expect(r.verdict).toBe("red");
    expect(r.reasons[0]?.code).toBe("exact-round-trip");
  });

  it("refuses times that aren't times", async () => {
    const ctx = await context();
    for (const time of [NaN, -1, 1.5, Infinity]) {
      await expect(preflight(ctx, { amount: 100_000_000, time })).rejects.toThrow(
        PreflightRangeError,
      );
    }
    await expect(
      preflight(ctx, { amount: 100_000_000, time: DATA_TO }, { amount: NaN, time: DATA_TO - H }),
    ).rejects.toThrow(PreflightRangeError);
  });

  it("warns when the user's own deposit is the closest match in time", async () => {
    // 1 ZEC deposited an hour before withdrawing 1 ZEC: 15 others match, but theirs are 12+ hours old.
    const soon = await preflight(
      await context(),
      { amount: 100_000_000, time: DATA_TO - H },
      { amount: 100_030_000, time: DATA_TO - 2 * H },
    );
    expect(soon.verdict).toBe("amber");
    expect(soon.reasons.map((x) => x.code)).toEqual(["best-guess", "crowd"]);
    // Deposited five days before: older than most rivals, so timing doesn't point at it.
    const later = await preflight(
      await context(),
      { amount: 100_000_000, time: DATA_TO - H },
      { amount: 100_030_000, time: DATA_TO - 5 * DAY },
    );
    expect(later.verdict).toBe("green");
    expect(later.reasons.map((x) => x.code)).toEqual(["crowd"]);
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
      destination: REUSED,
    });
    expect(reused.verdict).toBe("red");
    expect(reused.reasons[0]?.code).toBe("address-reuse");
    const fresh = await preflight(ctx, {
      amount: 100_000_000,
      time: DATA_TO - H,
      destination: FRESH,
    });
    expect(fresh.reasons.map((x) => x.code)).not.toContain("address-reuse");
  });

  it("sees through a TEX address to the t1 account it pays", async () => {
    const t1 = "t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC";
    const tex = "tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte"; // ZIP 320 test vector for t1
    const ctx = createPreflightContext(snapshot(), new AddressSet(await buildAddressSet([t1])));
    const r = await preflight(ctx, { amount: 100_000_000, time: DATA_TO - H, destination: tex });
    expect(r.reasons[0]).toMatchObject({ code: "address-reuse", severity: "red" });
    expect(r.reasons[0]?.message).toContain(t1);
  });

  it("rejects an invalid or shielded destination with a reason", async () => {
    const ctx = await context();
    const at = { amount: 100_000_000, time: DATA_TO - H };
    await expect(
      preflight(ctx, { ...at, destination: "t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yD" }),
    ).rejects.toThrow(/checksum/);
    await expect(preflight(ctx, { ...at, destination: "zs1abcdef" })).rejects.toThrow(/shielded/);
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

  it("never lets legs add up to the user's deposit minus fees", async () => {
    // 4 ZEC deposited (plus two 15,000 zat fees); 1 ZEC is the only amount that blends in.
    // Four 1 ZEC legs would sum to exactly the deposit minus fees, so the plan stops at three.
    const plan = await planExit(await context(), {
      total: 400_000_000,
      start,
      horizonHours: 36,
      seed: 1,
      own: { amount: 400_030_000, time: DATA_TO - 2 * H },
    });
    expect(plan.legs.map((l) => l.amount)).toEqual([100_000_000, 100_000_000, 100_000_000]);
    expect(plan.advice.join(" ")).toMatch(/1 ZEC more stays shielded so that no group/);
    expect(
      linkedSums(
        plan.legs.map((l) => l.amount),
        plan.options.total,
        own,
        DEFAULT_MATCH_PARAMS,
      ),
    ).toEqual([]);
  });

  it("without a deposit, assumes it was the total plus fees", async () => {
    const plan = await planExit(await context(), {
      total: 400_000_000,
      start,
      horizonHours: 36,
      seed: 1,
    });
    expect(plan.withdrawn).toBe(300_000_000);
  });

  it("finds sums within fees of the deposit, and ignores single legs and distant sums", () => {
    const p = DEFAULT_MATCH_PARAMS;
    const legs = [500_000_000, 500_000_000, 200_000_000];
    const own = { amount: 1_000_030_000, time: 0 }; // 10 ZEC + fees
    expect(linkedSums(legs, 0, own, p)).toEqual([1_000_000_000]); // the two 5 ZEC legs
    expect(linkedSums([1_000_000_000], 0, own, p)).toEqual([]); // a single leg is preflight's job
    expect(linkedSums(legs, 0, { amount: 1_000_030_001, time: 0 }, p)).toEqual([]); // not fee-shaped
    expect(linkedSums(legs, 1_200_000_000, undefined, p)).toEqual([1_200_000_000]); // all three = total
  });

  it("chooses the most withdrawn, preferring mixed amounts on ties, under any rule", () => {
    const pool = [500_000_000, 200_000_000, 100_000_000];
    expect(chooseLegs(pool, 2_000_000_000, 4, () => true)).toEqual(Array(4).fill(500_000_000));
    // 10 ZEC with 2 legs: 5+5 and nothing else reaches 10, so the tie-break can't apply.
    expect(chooseLegs(pool, 1_000_000_000, 2, () => true)).toEqual([500_000_000, 500_000_000]);
    // 4 ZEC with 3 legs: 2+2 and 2+1+1 both reach 4 and both repeat an amount twice, so the
    // fewer legs win: 2+2.
    expect(chooseLegs(pool, 400_000_000, 3, () => true)).toEqual([200_000_000, 200_000_000]);
    // 7 ZEC with 3 legs: 5+2 (mixed, 2 legs) beats nothing else reaching 7.
    expect(chooseLegs(pool, 700_000_000, 3, () => true)).toEqual([500_000_000, 200_000_000]);
    // A rule forbidding any sum of exactly 7 ZEC forces 5+1 (6 ZEC).
    const not7 = (xs: readonly number[]): boolean => xs.reduce((a, b) => a + b, 0) !== 700_000_000;
    expect(chooseLegs(pool, 700_000_000, 3, not7)).toEqual([500_000_000, 100_000_000]);
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

describe("planExit input limits", () => {
  it("keeps every leg inside a short horizon", async () => {
    const ctx = await context();
    for (const horizonHours of [1, 2, 3]) {
      const plan = await planExit(ctx, {
        total: 300_000_000,
        start: DATA_TO,
        horizonHours,
        maxLegs: 4,
        seed: 7,
      });
      for (const leg of plan.legs) {
        expect(leg.time).toBeGreaterThan(DATA_TO);
        expect(leg.time).toBeLessThanOrEqual(DATA_TO + horizonHours * H);
      }
    }
  });

  it("refuses options that would hang or produce nonsense", async () => {
    const ctx = await context();
    const base = { total: 300_000_000, start: DATA_TO, horizonHours: 48, maxLegs: 4, seed: 7 };
    for (const bad of [
      { maxLegs: 40 },
      { maxLegs: 0 },
      { maxLegs: 2.5 },
      { horizonHours: NaN },
      { horizonHours: 0 },
      { start: NaN },
      { seed: NaN },
      { crowdTarget: 0 },
    ]) {
      await expect(planExit(ctx, { ...base, ...bad }), JSON.stringify(bad)).rejects.toThrow(
        RangeError,
      );
    }
  });
});
