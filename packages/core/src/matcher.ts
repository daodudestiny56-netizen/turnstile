/**
 * The adversary's view: given an exit from the shielded pool, which entries could have funded it?
 *
 * Amounts are transparent-side values (see docs/methodology.md): a shield's amount includes its fee
 * and an exit's excludes it, so a round trip has shield − exit = the fees paid along the way.
 */

export interface ShieldPoint {
  /** Unix seconds. */
  time: number;
  /** Zatoshi, transparent side (includes the shield's fee). */
  amount: number;
  /** Entity id (see clusterEntities); candidates from one entity count once. */
  entity: number;
}

export interface ExitQuery {
  /** Unix seconds. */
  time: number;
  /** Zatoshi received on the transparent side. */
  amount: number;
}

export interface MatchParams {
  /** How far apart entry and exit may be. */
  windowSec: number;
  /** Largest shield − exit difference still explained by fees. */
  feeMaxZat: number;
  /** Recency scale of the time weight 1 / (1 + Δt / tau). */
  tauSec: number;
  /** ZIP-317 fee unit; differences that are multiples of it look like fees. */
  feeUnitZat: number;
  /** Relative weight of a candidate whose difference is not a fee multiple. */
  offUnitWeight: number;
  /** An exit is linkable if one entity holds at least this share of the weight. */
  linkableShare: number;
}

/** Calibrated on 8,572 same-address round trips, Jul–Sep 2026 (docs/methodology.md). */
export const DEFAULT_MATCH_PARAMS: MatchParams = {
  windowSec: 7 * 86_400,
  feeMaxZat: 200_000,
  tauSec: 3_600,
  feeUnitZat: 5_000,
  // Likelihood ratio from the labels: a real funder differs by a fee multiple 91.8% of the time (over
  // ~41 fee values); a chance match is uniform over ~200,000 values. Per candidate that is ~4,500x vs
  // ~0.08x, so an off-unit candidate carries ~2e-5 of a fee-shaped one. See docs/methodology.md.
  offUnitWeight: 0.00002,
  linkableShare: 0.9,
};

/**
 * "forward": entries before the exit (the real question).
 * "reverse": entries after the exit, which cannot have funded it — the coincidence baseline.
 */
export type Direction = "forward" | "reverse";

export interface ExitScore {
  /** Candidate shields. */
  candidates: number;
  /** Distinct entities among them. */
  entities: number;
  /** Effective number of entities, exp(entropy of their weight shares); 0 when none. */
  kEff: number;
  /** Entity holding the most weight, or -1. */
  topEntity: number;
  /** That entity's share of the weight (0 when none). */
  topShare: number;
  /** The top entity has a candidate whose difference is an exact fee multiple. */
  topFeeShaped: boolean;
  /**
   * The top entity has a fee-shaped candidate and is either the only candidate entity or holds at
   * least linkableShare of the weight.
   */
  linkable: boolean;
}

/** Shields sorted by amount for range lookups. Immutable after construction. */
export class ShieldIndex {
  readonly size: number;
  private readonly amount: Float64Array;
  private readonly time: Float64Array;
  private readonly entity: Int32Array;

  constructor(shields: readonly ShieldPoint[]) {
    const order = shields.map((_, i) => i).sort((a, b) => shields[a]!.amount - shields[b]!.amount);
    this.size = shields.length;
    this.amount = new Float64Array(this.size);
    this.time = new Float64Array(this.size);
    this.entity = new Int32Array(this.size);
    order.forEach((src, dst) => {
      const s = shields[src]!;
      this.amount[dst] = s.amount;
      this.time[dst] = s.time;
      this.entity[dst] = s.entity;
    });
  }

  /** Call fn for every shield with amount in [lo, hi]. */
  forEachInAmountRange(lo: number, hi: number, fn: (s: ShieldPoint) => void): void {
    let left = 0;
    let right = this.size;
    while (left < right) {
      const mid = (left + right) >>> 1;
      if (this.amount[mid]! < lo) left = mid + 1;
      else right = mid;
    }
    for (let i = left; i < this.size && this.amount[i]! <= hi; i++) {
      fn({ time: this.time[i]!, amount: this.amount[i]!, entity: this.entity[i]! });
    }
  }
}

function candidateWeight(
  shield: ShieldPoint,
  exit: ExitQuery,
  p: MatchParams,
  dir: Direction,
): number {
  const dt = dir === "forward" ? exit.time - shield.time : shield.time - exit.time;
  if (dir === "forward" ? dt <= 0 : dt < 0) return 0;
  if (dt > p.windowSec) return 0;
  const diff = shield.amount - exit.amount;
  if (diff < 0 || diff > p.feeMaxZat) return 0;
  const amountWeight = diff % p.feeUnitZat === 0 ? 1 : p.offUnitWeight;
  return amountWeight / (1 + dt / p.tauSec);
}

/**
 * Score one exit against the index. `extra` shields are considered alongside the index (used to
 * plant synthetic trips without rebuilding it).
 */
export function scoreExit(
  index: ShieldIndex,
  exit: ExitQuery,
  params: MatchParams = DEFAULT_MATCH_PARAMS,
  direction: Direction = "forward",
  extra: readonly ShieldPoint[] = [],
): ExitScore {
  const byEntity = new Map<number, number>();
  const feeShaped = new Set<number>();
  let candidates = 0;
  const consider = (s: ShieldPoint): void => {
    const w = candidateWeight(s, exit, params, direction);
    if (w > 0) {
      candidates++;
      byEntity.set(s.entity, (byEntity.get(s.entity) ?? 0) + w);
      if ((s.amount - exit.amount) % params.feeUnitZat === 0) feeShaped.add(s.entity);
    }
  };
  index.forEachInAmountRange(exit.amount, exit.amount + params.feeMaxZat, consider);
  for (const s of extra) consider(s);

  if (candidates === 0) {
    return {
      candidates: 0,
      entities: 0,
      kEff: 0,
      topEntity: -1,
      topShare: 0,
      topFeeShaped: false,
      linkable: false,
    };
  }
  let total = 0;
  let topEntity = -1;
  let topWeight = 0;
  for (const [entity, w] of byEntity) {
    total += w;
    if (w > topWeight || (w === topWeight && entity < topEntity)) {
      topWeight = w;
      topEntity = entity;
    }
  }
  let entropy = 0;
  for (const w of byEntity.values()) {
    const share = w / total;
    entropy -= share * Math.log(share);
  }
  const topShare = topWeight / total;
  return {
    candidates,
    entities: byEntity.size,
    kEff: Math.exp(entropy),
    topEntity,
    topShare,
    topFeeShaped: feeShaped.has(topEntity),
    // A coincidental match rarely differs by an exact fee multiple (1 in 5,000); a real round trip
    // usually does (91.8% of same-address trips). Requiring it makes the verdict a lower bound.
    linkable: feeShaped.has(topEntity) && (byEntity.size === 1 || topShare >= params.linkableShare),
  };
}
