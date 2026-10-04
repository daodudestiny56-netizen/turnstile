/**
 * Pre-flight Check: before a withdrawal from the shielded pool, would it give the user away?
 *
 * Everything here runs against the downloaded snapshot on the user's device. The answer uses the
 * matcher's own standard (docs/methodology.md, section 6), the one that singled out 100% of
 * identifiable planted round trips and never blamed the wrong deposit.
 */
import { parseAddress } from "./address.js";
import { formatZat } from "./amount.js";
import type { AddressSet } from "./integrity.js";
import {
  DEFAULT_MATCH_PARAMS,
  ShieldIndex,
  expectedChanceMatches,
  historyNeededSec,
  listCandidates,
  scoreExit,
  type Candidate,
  type ExitQuery,
  type MatchParams,
} from "./matcher.js";
import { bestCommonAmount, measureDenominations } from "./denominations.js";
import { zecDecimals } from "./meter.js";
import type { SnapshotData } from "./snapshot.js";

const DAY = 86_400;

/**
 * An exit is "in a crowd" when at least this many other parties could equally have funded it: an
 * observer's best guess is then right at most one time in ten.
 */
export const CROWD_TARGET = 10;

/** Warn when the planned withdrawal is more than this long after the data ends. */
export const STALE_AFTER_SEC = 2 * DAY;

export type Verdict = "red" | "amber" | "green";

export type ReasonCode =
  | "exact-round-trip"
  | "unique-match"
  | "address-reuse"
  | "thin-crowd"
  | "best-guess"
  | "precise-amount"
  | "stale-data"
  | "crowd"
  | "no-match";

export interface Reason {
  code: ReasonCode;
  severity: Verdict;
  message: string;
}

/** Everything a check needs, built once per loaded snapshot. */
export interface PreflightContext {
  data: SnapshotData;
  index: ShieldIndex;
  services: ReadonlySet<number>;
  addresses?: AddressSet;
  params: MatchParams;
}

export function createPreflightContext(
  data: SnapshotData,
  addresses?: AddressSet,
  params: MatchParams = DEFAULT_MATCH_PARAMS,
): PreflightContext {
  return {
    data,
    index: new ShieldIndex(data.shields),
    services: new Set(data.services),
    ...(addresses ? { addresses } : {}),
    params,
  };
}

export interface PlannedExit {
  /** Zatoshi the destination will receive. */
  amount: number;
  /** Unix seconds. */
  time: number;
  /** Transparent address the withdrawal goes to, if known. Only ever hashed locally. */
  destination?: string;
}

/** The user's own deposit into the pool, if they want it checked against. */
export interface OwnDeposit {
  /** Zatoshi taken from the transparent side, including the deposit's fee. */
  amount: number;
  /** Unix seconds. */
  time: number;
}

export interface PreflightResult {
  verdict: Verdict;
  reasons: Reason[];
  /** Other parties that could equally have funded this withdrawal (excluding the user). */
  crowd: number;
  /** Parties that used this exact amount in the two weeks before the search window. */
  expectedChance: number;
  /** The single deposit an observer would link the withdrawal to, when there is one. */
  matchedDeposit?: { time: number; amount: number; service: boolean };
  /** A common amount to withdraw instead, when the amount is precise and the check isn't green. */
  suggestedAmount?: number;
  data: {
    /** Unix seconds, end of the snapshot (exclusive). */
    dataTo: number;
    /** How far the withdrawal is past the end of the data, in seconds (0 if within). */
    staleness: number;
    /** When the crowd was measured: the withdrawal time, or the end of the data if later. */
    crowdMeasuredAt: number;
  };
}

const RANK: Record<Verdict, number> = { green: 0, amber: 1, red: 2 };
const date = (t: number): string =>
  `${new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const zec = (zat: number): string => `${formatZat(zat)} ZEC`;

/** Round down to 0.01 ZEC (or 0.001 ZEC for amounts under 0.01), the precision crowds form at. */
export function roundDownAmount(zat: number): number {
  const step = zat >= 1_000_000 ? 1_000_000 : 100_000;
  return Math.floor(zat / step) * step;
}

export class PreflightRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreflightRangeError";
  }
}

/**
 * Would an observer's single best guess, the matching deposit with the most weight by amount and
 * timing, be the user's own? Rivals are the other entities' fee-shaped candidates, weighed at the
 * same reference time as the user's deposit.
 */
function ownIsBestGuess(
  rivals: readonly Candidate[],
  own: OwnDeposit,
  at: number,
  p: MatchParams,
): boolean {
  const byEntity = new Map<number, number>();
  for (const c of rivals) {
    if (c.feeShaped) byEntity.set(c.entity, (byEntity.get(c.entity) ?? 0) + c.weight);
  }
  const ownWeight = 1 / (1 + (at - own.time) / p.tauSec);
  return [...byEntity.values()].every((w) => ownWeight > w);
}

export async function preflight(
  ctx: PreflightContext,
  exit: PlannedExit,
  own?: OwnDeposit,
): Promise<PreflightResult> {
  const p = ctx.params;
  const { dataFrom, dataTo } = ctx.data;
  if (!Number.isSafeInteger(exit.amount) || exit.amount <= 0) {
    throw new PreflightRangeError("withdrawal amount must be a positive number of zatoshi");
  }
  if (exit.time - historyNeededSec(p) < dataFrom) {
    throw new PreflightRangeError(
      `the data starts ${date(dataFrom)}; a withdrawal needs ${historyNeededSec(p) / DAY} days of history before it`,
    );
  }

  // The crowd is measured over the last full week of data when the withdrawal is later than that:
  // deposits made after the data ends are unknown, so the crowd may be larger than shown, not smaller.
  const crowdMeasuredAt = Math.min(exit.time, dataTo);
  const measured: ExitQuery = { time: crowdMeasuredAt, amount: exit.amount };
  const staleness = Math.max(0, exit.time - dataTo);
  const reasons: Reason[] = [];
  const add = (code: ReasonCode, severity: Verdict, message: string): void => {
    reasons.push({ code, severity, message });
  };

  // If the user's deposit is already in the data, it is them, not a rival.
  const ownEntities = new Set<number>();
  if (own) {
    ctx.index.forEachInAmountRange(own.amount, own.amount, (s) => {
      if (Math.abs(s.time - own.time) <= 3_600) ownEntities.add(s.entity);
    });
  }
  const candidates = listCandidates(ctx.index, measured, p).filter(
    (c) => !ownEntities.has(c.entity),
  );
  const rivals = new Set(candidates.filter((c) => c.feeShaped).map((c) => c.entity));
  const expectedChance = expectedChanceMatches(ctx.index, measured, p);
  const crowd = rivals.size;
  let matchedDeposit: PreflightResult["matchedDeposit"];

  const diff = own ? own.amount - exit.amount : -1;
  const ownDt = own ? exit.time - own.time : -1;
  const ownMatches =
    own !== undefined &&
    diff >= 0 &&
    diff <= p.feeMaxZat &&
    diff % p.feeUnitZat === 0 &&
    ownDt > 0 &&
    ownDt <= p.windowSec;

  if (own) {
    if (!ownMatches) {
      add(
        "no-match",
        "green",
        `Your deposit of ${zec(own.amount)} on ${date(own.time)} doesn't match this withdrawal by ` +
          `amount and timing, so an observer can't connect them this way.`,
      );
    } else if (crowd === 0 && expectedChance <= p.maxExpectedChance) {
      add(
        "exact-round-trip",
        "red",
        `This withdrawal is your deposit of ${zec(own.amount)} on ${date(own.time)} minus fees, and ` +
          `nobody else deposited that amount recently. An observer would link the two.`,
      );
    } else if (crowd < CROWD_TARGET) {
      add(
        "thin-crowd",
        "amber",
        `Your deposit matches this withdrawal, and only ${crowd} other ${crowd === 1 ? "party" : "parties"} ` +
          `deposited the same amount in the week before. You'd be one of ${crowd + 1}.`,
      );
    } else {
      add(
        "crowd",
        "green",
        `Your deposit matches, but so do deposits by ${crowd} other parties. You'd be one of ${crowd + 1}.`,
      );
    }
    if (
      ownMatches &&
      crowd > 0 &&
      ownIsBestGuess(candidates, own, own.time < measured.time ? measured.time : exit.time, p)
    ) {
      add(
        "best-guess",
        "amber",
        "Of the deposits that match, yours is the closest in time, so an observer who picks the " +
          "most likely one would pick yours. Waiting longer lets timing stop pointing at you.",
      );
    }
  } else {
    const score = scoreExit(ctx.index, measured, p);
    if (score.linkable) {
      const top = candidates.find((c) => c.entity === score.topEntity && c.feeShaped);
      if (top) {
        matchedDeposit = {
          time: top.time,
          amount: top.amount,
          service: ctx.services.has(top.entity),
        };
      }
      add(
        "unique-match",
        "red",
        `An observer would link this withdrawal to one deposit${top ? ` of ${zec(top.amount)} on ${date(top.time)}` : ""}. ` +
          `If that deposit is yours, you'd be traced; if not, you'd be wrongly tied to someone else.`,
      );
    } else if (crowd === 0) {
      add(
        "no-match",
        "green",
        "No recent deposit matches this amount by amount and timing. If you deposited this amount plus " +
          "fees in the last week, enter your deposit to check against it.",
      );
    } else if (crowd < CROWD_TARGET) {
      add(
        "thin-crowd",
        "amber",
        `Only ${crowd} ${crowd === 1 ? "party" : "parties"} deposited an amount that matches this withdrawal in the week before.`,
      );
    } else {
      add("crowd", "green", `${crowd} parties deposited amounts that match this withdrawal.`);
    }
  }

  let suggestedAmount: number | undefined;
  const worstSoFar = Math.max(...reasons.map((r) => RANK[r.severity]));
  if (zecDecimals(exit.amount) >= 3 && worstSoFar > 0) {
    const common = bestCommonAmount(
      measureDenominations(ctx.data, ctx.index, p),
      exit.amount,
      CROWD_TARGET,
    );
    const rounded = roundDownAmount(exit.amount);
    suggestedAmount =
      common?.amount ?? (rounded > 0 && rounded < exit.amount ? rounded : undefined);
    add(
      "precise-amount",
      "amber",
      `${zec(exit.amount)} is a precise amount, which is what makes withdrawals easy to match. ` +
        (common
          ? `${zec(common.amount)} was deposited by ${common.crowd} parties in the last week of data and ` +
            `blends in; the Exit Planner can split the whole amount into legs like that.`
          : suggestedAmount !== undefined
            ? `Withdrawing ${zec(suggestedAmount)} and keeping the rest shielded blends in better.`
            : "Consider keeping it shielded."),
    );
  }

  if (exit.destination !== undefined && exit.destination.trim() !== "") {
    const parsed = await parseAddress(exit.destination);
    if (!parsed.transparent) throw new PreflightRangeError(parsed.problem ?? "Invalid address");
    // A tex1 address receives at its t1 form, so that is what must not have deposited.
    if (ctx.addresses && (await ctx.addresses.has(parsed.transparent))) {
      add(
        "address-reuse",
        "red",
        (parsed.kind === "tex"
          ? `This TEX address is the same account as ${parsed.transparent}, which `
          : "This destination address ") +
          "funded a deposit into the shielded pool. Withdrawing back to it links the two directly, " +
          "whatever the amount. Use an address that has never deposited.",
      );
    }
  }

  if (staleness > STALE_AFTER_SEC) {
    add(
      "stale-data",
      "amber",
      `The data ends ${date(dataTo)}, ${(staleness / DAY).toFixed(1)} days before this withdrawal. ` +
        `Deposits made since then aren't counted, so this check may be out of date.`,
    );
  }

  const verdict = reasons.reduce<Verdict>(
    (v, r) => (RANK[r.severity] > RANK[v] ? r.severity : v),
    "green",
  );
  const order = (r: Reason): number => -RANK[r.severity];
  return {
    verdict,
    reasons: [...reasons].sort((a, b) => order(a) - order(b)),
    crowd,
    expectedChance,
    ...(matchedDeposit ? { matchedDeposit } : {}),
    ...(suggestedAmount !== undefined ? { suggestedAmount } : {}),
    data: { dataTo, staleness, crowdMeasuredAt },
  };
}
