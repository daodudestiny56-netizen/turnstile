import { describe, expect, it } from "vitest";
import { clusterEntities } from "./entities.js";
import { DEFAULT_MATCH_PARAMS, ShieldIndex, scoreExit, type ShieldPoint } from "./matcher.js";
import { crowdBucket, meterStats, precisionBand, shiftedExit, zecDecimals } from "./meter.js";

const H = 3_600;
const DAY = 86_400;
const T0 = 1_780_000_000;

/** Deterministic PRNG so synthetic chains are reproducible. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random background: shields with arbitrary 8-decimal amounts, one entity each. */
function background(n: number, days: number, seed: number): ShieldPoint[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => ({
    time: T0 + Math.floor(r() * days * DAY),
    amount: 1_000_000 + Math.floor(r() * 2_000_000_000),
    entity: i,
  }));
}

describe("clusterEntities", () => {
  it("merges shields that share any funding address, transitively", () => {
    const ids = clusterEntities([["a"], ["b"], ["a", "c"], ["c", "d"], [], ["e"], []]);
    expect(ids[0]).toBe(ids[2]);
    expect(ids[2]).toBe(ids[3]);
    expect(new Set(ids).size).toBe(5); // {a,c,d}, {b}, {}, {e}, {}
    expect(ids[4]).not.toBe(ids[6]); // address-less shields stay separate
  });
});

describe("scoreExit", () => {
  const shield = { time: T0, amount: 317_450_000, entity: 7 };

  it("links an exact round trip (shield minus two 15,000 fees)", () => {
    const index = new ShieldIndex([shield]);
    const s = scoreExit(index, { time: T0 + H, amount: 317_420_000 });
    expect(s).toMatchObject({ candidates: 1, entities: 1, topEntity: 7, linkable: true });
  });

  it("ignores entries after the exit, outside the window, or off by more than fees", () => {
    const index = new ShieldIndex([shield]);
    expect(scoreExit(index, { time: T0 - 1, amount: 317_420_000 }).candidates).toBe(0);
    expect(scoreExit(index, { time: T0 + 8 * DAY, amount: 317_420_000 }).candidates).toBe(0);
    expect(scoreExit(index, { time: T0 + H, amount: 317_450_001 }).candidates).toBe(0); // took out more
    expect(scoreExit(index, { time: T0 + H, amount: 317_000_000 }).candidates).toBe(0); // partial exit
  });

  it("reverse direction only looks at entries after the exit", () => {
    const index = new ShieldIndex([shield]);
    expect(
      scoreExit(index, { time: T0 - H, amount: 317_420_000 }, undefined, "reverse"),
    ).toMatchObject({ candidates: 1, linkable: true });
    expect(
      scoreExit(index, { time: T0 + H, amount: 317_420_000 }, undefined, "reverse").candidates,
    ).toBe(0);
  });

  it("counts a busy entity once: many shields from one service are one member of the crowd", () => {
    const service = Array.from({ length: 50 }, (_, i) => ({
      time: T0 + i * 60,
      amount: 100_030_000,
      entity: 1,
    }));
    const s = scoreExit(new ShieldIndex(service), { time: T0 + DAY, amount: 100_000_000 });
    expect(s).toMatchObject({ candidates: 50, entities: 1, linkable: true });
  });

  it("does not link a round amount hidden among many independent entities", () => {
    const crowd = Array.from({ length: 40 }, (_, i) => ({
      time: T0 + i * 600,
      amount: 100_030_000,
      entity: i,
    }));
    const s = scoreExit(new ShieldIndex(crowd), { time: T0 + DAY, amount: 100_000_000 });
    expect(s.entities).toBe(40);
    expect(s.linkable).toBe(false);
    expect(s.kEff).toBeGreaterThan(20);
  });

  it("prefers recent, fee-shaped candidates when weighing", () => {
    const shields = [
      { time: T0 + DAY - H, amount: 100_030_000, entity: 1 }, // 1h before, fee-shaped difference
      { time: T0, amount: 100_031_234, entity: 2 }, // a day before, odd difference
    ];
    const s = scoreExit(new ShieldIndex(shields), { time: T0 + DAY, amount: 100_000_000 });
    expect(s.topEntity).toBe(1);
    expect(s.topShare).toBeGreaterThan(DEFAULT_MATCH_PARAMS.linkableShare);
    expect(s.linkable).toBe(true);
  });

  it("uses extra shields alongside the index", () => {
    const s = scoreExit(
      new ShieldIndex([]),
      { time: T0 + H, amount: 317_420_000 },
      undefined,
      "forward",
      [shield],
    );
    expect(s.topEntity).toBe(7);
  });
});

describe("synthetic chain", () => {
  const days = 30;
  const noise = background(20_000, days, 1);
  const r = rng(99);
  const planted: { shield: ShieldPoint; exitTime: number; exitAmount: number }[] = [];
  for (let i = 0; i < 200; i++) {
    const time = T0 + 8 * DAY + Math.floor(r() * 14 * DAY);
    const amount = 5_000_000 + Math.floor(r() * 1_000_000_000);
    planted.push({
      shield: { time, amount, entity: 1_000_000 + i },
      exitTime: time + H,
      exitAmount: amount - 30_000,
    });
  }
  const index = new ShieldIndex([...noise, ...planted.map((p) => p.shield)]);

  it("finds planted exact round trips", () => {
    const found = planted.filter((p) => {
      const s = scoreExit(index, { time: p.exitTime, amount: p.exitAmount });
      return s.linkable && s.topEntity === p.shield.entity;
    }).length;
    expect(found / planted.length).toBeGreaterThanOrEqual(0.95);
  });

  it("does not link random exits that have no round trip", () => {
    const exits = background(2_000, days, 7).map((e) => ({ time: e.time, amount: e.amount }));
    const linked = exits.filter((e) => scoreExit(index, e).linkable).length;
    expect(linked / exits.length).toBeLessThan(0.02);
  });

  it("meter: observed equals baseline when there are no real trips, and exceeds it when there are", () => {
    const exits = background(3_000, days, 11).map((e) => ({ time: e.time, amount: e.amount }));
    const from = T0;
    const to = T0 + days * DAY;
    const noTrips = meterStats(new ShieldIndex(noise), exits, from, to);
    expect(Math.abs(noTrips.excess)).toBeLessThan(0.01);

    const withTrips = meterStats(
      index,
      [...exits, ...planted.map((p) => ({ time: p.exitTime, amount: p.exitAmount }))],
      from,
      to,
    );
    expect(withTrips.observed.linkable - withTrips.baseline.linkable).toBeGreaterThanOrEqual(190);
    expect(withTrips.excess).toBeGreaterThan(0.05);
  });
});

describe("meter helpers", () => {
  it("shifts exit amounts by 0.05-0.5 ZEC, keeping precision and the fee-unit remainder", () => {
    for (let i = 0; i < 500; i++) {
      const exit = { time: T0, amount: 317_420_381 + i * 7 };
      const moved = shiftedExit(exit, i);
      const delta = Math.abs(moved.amount - exit.amount);
      expect(delta % 1_000_000).toBe(0);
      expect(delta).toBeGreaterThanOrEqual(5_000_000);
      expect(delta).toBeLessThanOrEqual(50_000_000);
      expect(moved.amount).toBeGreaterThan(0);
      expect(precisionBand(moved.amount)).toBe(precisionBand(exit.amount));
      expect(moved.amount % 5_000).toBe(exit.amount % 5_000);
    }
    expect(shiftedExit({ time: T0, amount: 1_000_000 }, 1).amount).toBeGreaterThan(1_000_000);
  });

  it("counts significant ZEC decimals", () => {
    expect(zecDecimals(100_000_000)).toBe(0);
    expect(zecDecimals(150_000_000)).toBe(1);
    expect(zecDecimals(317_420_000)).toBe(4);
    expect(zecDecimals(1)).toBe(8);
    expect(precisionBand(250_000_000)).toBe("round (0-2 decimals)");
    expect(precisionBand(317_420_000)).toBe("3-5 decimals");
    expect(precisionBand(317_420_381)).toBe("6-8 decimals");
  });

  it("buckets crowd sizes", () => {
    expect([0, 1, 2, 5, 6, 20, 21, 100, 101].map(crowdBucket)).toEqual([
      "0",
      "1",
      "2-5",
      "2-5",
      "6-20",
      "6-20",
      "21-100",
      "21-100",
      "101+",
    ]);
  });
});
