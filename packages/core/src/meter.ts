import {
  DEFAULT_MATCH_PARAMS,
  historyNeededSec,
  scoreExit,
  type ExitQuery,
  type ExitScore,
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

/**
 * Move an exit amount by 5-50 hundredths of a ZEC (deterministic per exit). Multiples of 0.01 ZEC
 * keep the amount's decimal precision and its remainder modulo the fee unit, so chance fee-shaped
 * matches stay as likely as before while the true funder no longer matches.
 */
export function shiftedExit(exit: ExitQuery, i: number): ExitQuery {
  const steps = 5 + ((Math.imul(i + 1, 2654435761) >>> 0) % 46);
  const delta = steps * 1_000_000;
  const amount = i % 2 === 0 || exit.amount <= delta ? exit.amount + delta : exit.amount - delta;
  return { time: exit.time, amount };
}

export interface Rate {
  linkable: number;
  total: number;
  /** linkable / total, 0 when total is 0. */
  rate: number;
}

/** One measurement against both coincidence baselines. */
export interface Comparison {
  /** Real question: an entry before the exit singles out one entity. */
  observed: Rate;
  /**
   * Entries after the exit, which cannot have funded it. Also catches parties that exit and later
   * re-enter the same amount, which is real behavior, so it overstates chance.
   */
  reversed: Rate;
  /** The exit amount moved by 0.05-0.5 ZEC: same precision and timing, no true match. */
  shifted: Rate;
  /** observed minus the larger baseline: a conservative share linkable beyond coincidence. */
  excess: number;
}

export interface Breakdown extends Comparison {
  byPrecision: Record<string, Comparison>;
  byMonth: Record<string, Comparison>;
}

export interface MeterStats {
  params: MatchParams;
  /** Exits scored (both windows fully inside the data). */
  evaluated: number;
  /** Entities treated as services (see serviceEntities). */
  serviceEntities: number;
  /** Every linkable verdict, whoever it points at. */
  all: Breakdown;
  /** Verdicts that point at a person-scale entity: the headline. */
  people: Breakdown;
  /** Verdicts that point at a service: its own flows are traceable. */
  services: Breakdown;
  /** Exits by number of distinct candidate entities (forward). */
  crowd: Record<CrowdBucket, number>;
}

class Tally {
  n = 0;
  obs = 0;
  rev = 0;
  sh = 0;
  add(obs: boolean, rev: boolean, sh: boolean): void {
    this.n++;
    if (obs) this.obs++;
    if (rev) this.rev++;
    if (sh) this.sh++;
  }
  comparison(): Comparison {
    const r = (k: number): Rate => ({ linkable: k, total: this.n, rate: this.n ? k / this.n : 0 });
    const observed = r(this.obs);
    const reversed = r(this.rev);
    const shifted = r(this.sh);
    return {
      observed,
      reversed,
      shifted,
      excess: observed.rate - Math.max(reversed.rate, shifted.rate),
    };
  }
}

class BreakdownTally {
  readonly total = new Tally();
  readonly precision = new Map<string, Tally>();
  readonly month = new Map<string, Tally>();
  add(exit: ExitQuery, obs: boolean, rev: boolean, sh: boolean): void {
    this.total.add(obs, rev, sh);
    const get = (m: Map<string, Tally>, k: string): Tally => {
      let t = m.get(k);
      if (!t) m.set(k, (t = new Tally()));
      return t;
    };
    get(this.precision, precisionBand(exit.amount)).add(obs, rev, sh);
    get(this.month, new Date(exit.time * 1000).toISOString().slice(0, 7)).add(obs, rev, sh);
  }
  result(): Breakdown {
    const map = (m: Map<string, Tally>): Record<string, Comparison> =>
      Object.fromEntries(
        [...m].sort(([a], [b]) => a.localeCompare(b)).map(([k, t]) => [k, t.comparison()]),
      );
    return {
      ...this.total.comparison(),
      byPrecision: map(this.precision),
      byMonth: map(this.month),
    };
  }
}

/**
 * Leak Meter: score every exit whose search and background windows, before and after it, lie inside
 * [dataFrom, dataTo],
 * against both baselines, and split verdicts by whether they point at a person or a service.
 */
export function meterStats(
  index: ShieldIndex,
  exits: readonly ExitQuery[],
  dataFrom: number,
  dataTo: number,
  params: MatchParams = DEFAULT_MATCH_PARAMS,
  services: ReadonlySet<number> = new Set(),
): MeterStats {
  const crowd = Object.fromEntries(CROWD_BUCKETS.map((b) => [b, 0])) as Record<CrowdBucket, number>;
  const all = new BreakdownTally();
  const people = new BreakdownTally();
  const serv = new BreakdownTally();
  const isService = (s: ExitScore): boolean => s.linkable && services.has(s.topEntity);
  const isPerson = (s: ExitScore): boolean => s.linkable && !services.has(s.topEntity);

  let evaluated = 0;
  for (const exit of exits) {
    const need = historyNeededSec(params);
    if (exit.time - need < dataFrom || exit.time + need > dataTo) continue;
    const fwd = scoreExit(index, exit, params, "forward");
    const rev = scoreExit(index, exit, params, "reverse");
    const sh = scoreExit(index, shiftedExit(exit, evaluated), params, "forward");
    evaluated++;
    crowd[crowdBucket(fwd.entities)]++;
    all.add(exit, fwd.linkable, rev.linkable, sh.linkable);
    people.add(exit, isPerson(fwd), isPerson(rev), isPerson(sh));
    serv.add(exit, isService(fwd), isService(rev), isService(sh));
  }

  return {
    params,
    evaluated,
    serviceEntities: services.size,
    all: all.result(),
    people: people.result(),
    services: serv.result(),
    crowd,
  };
}
