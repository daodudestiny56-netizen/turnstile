import {
  DEFAULT_MATCH_PARAMS,
  scoreExit,
  type ExitQuery,
  type MatchParams,
  type ShieldIndex,
} from "./matcher.js";

/** Number of significant decimal places of a zatoshi amount in ZEC: 1.5 ZEC -> 1, 3.1742 -> 4. */
export function zecDecimals(zat: number): number {
  let frac = zat % 100_000_000;
  if (frac === 0) return 0;
  let digits = 8;
  while (frac % 10 === 0) {
    frac /= 10;
    digits--;
  }
  return digits;
}

export type PrecisionBand = "round (0-2 decimals)" | "3-5 decimals" | "6-8 decimals";

export function precisionBand(zat: number): PrecisionBand {
  const d = zecDecimals(zat);
  return d <= 2 ? "round (0-2 decimals)" : d <= 5 ? "3-5 decimals" : "6-8 decimals";
}

/** Buckets for the number of distinct entities that could have funded an exit. */
export const CROWD_BUCKETS = ["0", "1", "2-5", "6-20", "21-100", "101+"] as const;
export type CrowdBucket = (typeof CROWD_BUCKETS)[number];

export function crowdBucket(entities: number): CrowdBucket {
  if (entities <= 1) return entities === 0 ? "0" : "1";
  if (entities <= 5) return "2-5";
  if (entities <= 20) return "6-20";
  if (entities <= 100) return "21-100";
  return "101+";
}

export interface Rate {
  linkable: number;
  total: number;
  /** linkable / total, 0 when total is 0. */
  rate: number;
}

export interface Split {
  observed: Rate;
  baseline: Rate;
  shiftedBaseline: Rate;
}

export interface MeterStats {
  params: MatchParams;
  /** Exits scored (both windows fully inside the data). */
  evaluated: number;
  /** Real question: an entry before the exit singles out one entity. */
  observed: Rate;
  /**
   * Coincidence, measured two ways. "Reversed": the same test against entries after the exit, which
   * cannot have funded it (this also catches services that exit and later re-enter the same amount,
   * so it overstates chance). "Shifted": the exit amount moved by 0.05-0.5 ZEC, keeping its roundness
   * and timing but removing any true match.
   */
  baseline: Rate;
  shiftedBaseline: Rate;
  /** observed.rate minus the larger baseline: a conservative share linkable beyond coincidence. */
  excess: number;
  /** Exits by number of distinct candidate entities (forward). */
  crowd: Record<CrowdBucket, number>;
  byPrecision: Record<PrecisionBand, Split>;
  byMonth: Record<string, Split>;
}

/**
 * Move an exit amount by 5-50 hundredths of a ZEC (deterministic per exit). Multiples of 0.01 ZEC keep
 * the amount's decimal precision and its remainder modulo the fee unit, so chance fee-shaped matches
 * stay as likely as before while the true funder no longer matches.
 */
export function shiftedExit(exit: ExitQuery, i: number): ExitQuery {
  const steps = 5 + ((Math.imul(i + 1, 2654435761) >>> 0) % 46);
  const delta = steps * 1_000_000;
  const amount = i % 2 === 0 || exit.amount <= delta ? exit.amount + delta : exit.amount - delta;
  return { time: exit.time, amount };
}

function rate(linkable: number, total: number): Rate {
  return { linkable, total, rate: total === 0 ? 0 : linkable / total };
}

/**
 * Leak Meter: score every exit whose forward and reverse windows both lie inside [dataFrom, dataTo].
 */
export function meterStats(
  index: ShieldIndex,
  exits: readonly ExitQuery[],
  dataFrom: number,
  dataTo: number,
  params: MatchParams = DEFAULT_MATCH_PARAMS,
): MeterStats {
  const crowd = Object.fromEntries(CROWD_BUCKETS.map((b) => [b, 0])) as Record<CrowdBucket, number>;
  const tally = new Map<string, { obs: number; base: number; sh: number; n: number }>();
  const bump = (key: string, obs: boolean, base: boolean, sh: boolean): void => {
    const t = tally.get(key) ?? { obs: 0, base: 0, sh: 0, n: 0 };
    t.n++;
    if (obs) t.obs++;
    if (base) t.base++;
    if (sh) t.sh++;
    tally.set(key, t);
  };

  let evaluated = 0;
  let observed = 0;
  let baseline = 0;
  let shifted = 0;
  for (const exit of exits) {
    if (exit.time - params.windowSec < dataFrom || exit.time + params.windowSec > dataTo) continue;
    const fwd = scoreExit(index, exit, params, "forward");
    const rev = scoreExit(index, exit, params, "reverse");
    const sh = scoreExit(index, shiftedExit(exit, evaluated), params, "forward");
    evaluated++;
    if (fwd.linkable) observed++;
    if (rev.linkable) baseline++;
    if (sh.linkable) shifted++;
    crowd[crowdBucket(fwd.entities)]++;
    bump(`p:${precisionBand(exit.amount)}`, fwd.linkable, rev.linkable, sh.linkable);
    bump(
      `m:${new Date(exit.time * 1000).toISOString().slice(0, 7)}`,
      fwd.linkable,
      rev.linkable,
      sh.linkable,
    );
  }

  const split = (prefix: string): Record<string, Split> =>
    Object.fromEntries(
      [...tally]
        .filter(([k]) => k.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, t]) => [
          k.slice(2),
          {
            observed: rate(t.obs, t.n),
            baseline: rate(t.base, t.n),
            shiftedBaseline: rate(t.sh, t.n),
          },
        ]),
    );
  const obs = rate(observed, evaluated);
  const base = rate(baseline, evaluated);
  const shiftedBase = rate(shifted, evaluated);
  return {
    params,
    evaluated,
    observed: obs,
    baseline: base,
    shiftedBaseline: shiftedBase,
    excess: obs.rate - Math.max(base.rate, shiftedBase.rate),
    crowd,
    byPrecision: split("p:") as MeterStats["byPrecision"],
    byMonth: split("m:"),
  };
}
