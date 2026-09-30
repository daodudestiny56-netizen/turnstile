import { feeShapedEntities, type ShieldIndex, type MatchParams } from "./matcher.js";
import { zecDecimals } from "./meter.js";
import type { SnapshotData } from "./snapshot.js";

const DAY = 86_400;

/** Round amounts people commonly withdraw, in zatoshi (0.01 to 100 ZEC). */
export const STANDARD_DENOMINATIONS = [
  1_000_000, 2_000_000, 5_000_000, 10_000_000, 20_000_000, 25_000_000, 50_000_000, 100_000_000,
  200_000_000, 250_000_000, 500_000_000, 1_000_000_000, 2_000_000_000, 5_000_000_000,
  10_000_000_000,
];

export interface Denomination {
  amount: number;
  /** Parties that deposited an amount matching this one in the last week of data. */
  crowd: number;
}

const cache = new WeakMap<SnapshotData, Denomination[]>();

/**
 * Candidate withdrawal amounts: standard round amounts plus round amounts (at most 2 decimals)
 * withdrawn at least 3 times in the last 30 days of data, each with the crowd it would hide in.
 * Sorted largest first; computed once per snapshot.
 */
export function measureDenominations(
  data: SnapshotData,
  index: ShieldIndex,
  params: MatchParams,
): Denomination[] {
  const cached = cache.get(data);
  if (cached) return cached;
  const since = data.dataTo - 30 * DAY;
  const counts = new Map<number, number>();
  for (const e of data.exits) {
    if (e.time >= since && zecDecimals(e.amount) <= 2) {
      counts.set(e.amount, (counts.get(e.amount) ?? 0) + 1);
    }
  }
  const amounts = new Set(STANDARD_DENOMINATIONS);
  for (const [amount, n] of counts) if (n >= 3) amounts.add(amount);
  const result = [...amounts]
    .map((amount) => ({
      amount,
      crowd: feeShapedEntities(index, { time: data.dataTo, amount }, params).size,
    }))
    .sort((a, b) => b.amount - a.amount);
  cache.set(data, result);
  return result;
}

/** The largest amount no bigger than `max` that hides among at least `crowdTarget` others. */
export function bestCommonAmount(
  denominations: readonly Denomination[],
  max: number,
  crowdTarget: number,
): Denomination | undefined {
  return denominations.find((d) => d.amount <= max && d.crowd >= crowdTarget);
}
