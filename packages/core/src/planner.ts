/**
 * Exit Planner: split a withdrawal into legs that each blend into a crowd, at times that look like
 * ordinary network activity. Deterministic for a given seed.
 */
import { formatZat } from "./amount.js";
import { measureDenominations as measure, type Denomination } from "./denominations.js";
import {
  CROWD_TARGET,
  preflight,
  type OwnDeposit,
  type PreflightContext,
  type PreflightResult,
  type Verdict,
} from "./preflight.js";
import { seededRandom } from "./random.js";

const HOUR = 3_600;
const DAY = 86_400;

export interface PlanOptions {
  /** Total zatoshi the user wants to take out. */
  total: number;
  /** Unix seconds; no leg before start + 1 hour. */
  start: number;
  /** Legs are spread over this many hours. */
  horizonHours: number;
  /** Target number of other parties each leg should hide among. */
  crowdTarget?: number;
  maxLegs?: number;
  seed: number;
  own?: OwnDeposit;
}

export interface PlannedLeg {
  time: number;
  amount: number;
  /** Other parties that deposited an amount matching this leg in the latest week of data. */
  crowd: number;
  check: PreflightResult;
}

export interface ExitPlan {
  options: Required<Omit<PlanOptions, "own">> & { own?: OwnDeposit };
  legs: PlannedLeg[];
  /** Zatoshi withdrawn across all legs. */
  withdrawn: number;
  /** Zatoshi left in the shielded pool: not enough for another leg that blends in. */
  remainder: number;
  /** The same total withdrawn at once, for comparison. */
  singleExit: PreflightResult;
  /** Smallest crowd among the legs. */
  weakestLegCrowd: number;
  /** False when no amount reaches the crowd target; legs then use the best available. */
  targetMet: boolean;
  /** Denominations considered, with their measured crowds. */
  denominations: Denomination[];
  advice: string[];
}

/** Candidate leg amounts with the crowd each would hide in (see denominations.ts). */
export function measureDenominations(ctx: PreflightContext): Denomination[] {
  return measure(ctx.data, ctx.index, ctx.params);
}

/** Relative withdrawal activity per UTC hour over the last 30 days of data (sums to 1). */
export function hourlyActivity(ctx: PreflightContext): number[] {
  const since = ctx.data.dataTo - 30 * DAY;
  const bins = new Array<number>(24).fill(1); // add-one smoothing: no hour is impossible
  for (const e of ctx.data.exits) {
    if (e.time >= since) bins[new Date(e.time * 1000).getUTCHours()]!++;
  }
  const total = bins.reduce((a, b) => a + b, 0);
  return bins.map((b) => b / total);
}

function legTimes(
  count: number,
  start: number,
  horizonSec: number,
  activity: number[],
  rand: () => number,
): number[] {
  const from = start + HOUR;
  const span = Math.max(HOUR, horizonSec - HOUR);
  const minGap = Math.max(HOUR, span / (2 * count));
  const peak = Math.max(...activity);
  const times: number[] = [];
  for (let attempt = 0; times.length < count && attempt < 10_000; attempt++) {
    const t = Math.floor(from + rand() * span);
    // Weight by how busy that hour usually is, so legs land when others are withdrawing too.
    if (rand() > activity[new Date(t * 1000).getUTCHours()]! / peak) continue;
    if (times.some((u) => Math.abs(u - t) < minGap)) continue;
    times.push(t);
  }
  // With an impossible spacing request, fall back to even spacing rather than fewer legs.
  while (times.length < count) times.push(Math.floor(from + (span * (times.length + 0.5)) / count));
  return times.sort((a, b) => a - b);
}

export async function planExit(ctx: PreflightContext, options: PlanOptions): Promise<ExitPlan> {
  const opts = {
    crowdTarget: CROWD_TARGET,
    maxLegs: 4,
    ...options,
  };
  if (!Number.isSafeInteger(opts.total) || opts.total <= 0) {
    throw new RangeError("total must be a positive number of zatoshi");
  }
  const rand = seededRandom(opts.seed);
  const denominations = measureDenominations(ctx);
  const smallest = Math.min(...denominations.map((d) => d.amount));
  let eligible = denominations.filter((d) => d.crowd >= opts.crowdTarget && d.amount <= opts.total);
  const targetMet = eligible.length > 0;
  if (!targetMet) {
    const affordable = denominations.filter((d) => d.amount <= opts.total);
    const best = Math.max(0, ...affordable.map((d) => d.crowd));
    eligible = affordable.filter((d) => d.crowd === best && best > 0);
  }

  // Greedy: largest amount that still fits, repeated, up to maxLegs.
  const amounts: number[] = [];
  let remaining = opts.total;
  for (const d of eligible) {
    while (d.amount <= remaining && amounts.length < opts.maxLegs) {
      amounts.push(d.amount);
      remaining -= d.amount;
    }
  }
  const crowdOf = new Map(denominations.map((d) => [d.amount, d.crowd]));
  // Shuffle leg order so the largest isn't always first.
  for (let i = amounts.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [amounts[i], amounts[j]] = [amounts[j]!, amounts[i]!];
  }
  const times = legTimes(
    amounts.length,
    opts.start,
    opts.horizonHours * HOUR,
    hourlyActivity(ctx),
    rand,
  );
  const legs: PlannedLeg[] = [];
  for (let i = 0; i < amounts.length; i++) {
    const exit = { amount: amounts[i]!, time: times[i]! };
    legs.push({
      ...exit,
      crowd: crowdOf.get(exit.amount) ?? 0,
      check: await preflight(ctx, exit, opts.own),
    });
  }
  const withdrawn = amounts.reduce((a, b) => a + b, 0);
  const singleExit = await preflight(
    ctx,
    { amount: opts.total, time: opts.start + HOUR },
    opts.own,
  );

  const advice = [
    "Send each leg to a different, fresh address that has never deposited into the shielded pool.",
    "If the legs end up at the same address on another chain, they are linked again there.",
    `Keep the remainder of ${formatZat(opts.total - withdrawn)} ZEC shielded; it's too small to leave without standing out.`,
  ];
  if (!targetMet) {
    advice.unshift(
      `No amount you can afford is used by ${opts.crowdTarget} or more other parties right now; the plan uses the best available.`,
    );
  }
  if (amounts.length === 0) {
    advice.unshift(
      `The total is below the smallest amount that blends in (${formatZat(smallest)} ZEC). Consider keeping it shielded.`,
    );
  }

  const { own, ...rest } = opts;
  return {
    options: { ...rest, ...(own ? { own } : {}) },
    legs,
    withdrawn,
    remainder: opts.total - withdrawn,
    singleExit,
    weakestLegCrowd: legs.length ? Math.min(...legs.map((l) => l.crowd)) : 0,
    targetMet,
    denominations,
    advice,
  };
}

/** The worst verdict among a plan's legs. */
export function planVerdict(plan: ExitPlan): Verdict {
  const rank = { green: 0, amber: 1, red: 2 } as const;
  return plan.legs.reduce<Verdict>(
    (v, l) => (rank[l.check.verdict] > rank[v] ? l.check.verdict : v),
    "green",
  );
}

const icsTime = (t: number): string =>
  new Date(t * 1000)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/**
 * Calendar reminders for a plan (RFC 5545), for the user's own calendar app. Generated locally;
 * nothing is scheduled on any server.
 */
export function planToIcs(plan: ExitPlan): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Turnstile//Exit Planner//EN",
    "CALSCALE:GREGORIAN",
  ];
  plan.legs.forEach((leg, i) => {
    lines.push(
      "BEGIN:VEVENT",
      `UID:turnstile-${plan.options.seed}-${i + 1}@turnstile.invalid`,
      `DTSTAMP:${icsTime(plan.options.start)}`,
      `DTSTART:${icsTime(leg.time)}`,
      `DTEND:${icsTime(leg.time + 15 * 60)}`,
      `SUMMARY:Withdraw ${formatZat(leg.amount)} ZEC (leg ${i + 1} of ${plan.legs.length})`,
      `DESCRIPTION:Turnstile exit plan. Send to a fresh address that has never deposited into the shielded pool.`,
      "END:VEVENT",
    );
  });
  lines.push("END:VCALENDAR");
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}

/** RFC 5545 section 3.1: a line longer than 75 octets continues on the next line after a space. */
export function foldIcsLine(line: string): string {
  const parts = [line.slice(0, 75)];
  for (let i = 75; i < line.length; i += 74) parts.push(line.slice(i, i + 74));
  return parts.join("\r\n ");
}
