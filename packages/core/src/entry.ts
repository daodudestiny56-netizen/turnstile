/**
 * Entry Planner: half of every round-trip leak is created on the way in. A deposit of a precise
 * amount nobody else uses is a fingerprint, and a later withdrawal of about that amount points
 * straight back at it.
 *
 * Two things undo the fingerprint, and the planner offers both:
 * - deposit a common amount, so even withdrawing everything at once blends in; or
 * - deposit everything and leave through the Exit Planner, whose withdrawals never add up to the
 *   deposit.
 * Neither helps against timing: measured on mainnet (scripts/verify-entry.mjs), a withdrawal soon
 * after a deposit points at it even when the amount is common. So the advice always says to wait.
 *
 * "Common" is measured exactly as for withdrawals: how many parties deposited about this amount in
 * the week before, by the matcher's fee rules.
 */
import { formatZat } from "./amount.js";
import { measureDenominations } from "./denominations.js";
import { expectedChanceMatches, feeShapedEntities } from "./matcher.js";
import {
  CROWD_TARGET,
  PreflightRangeError,
  STALE_AFTER_SEC,
  type PreflightContext,
  type Verdict,
} from "./preflight.js";

/**
 * Network fee allowed for one shielding transaction: ZIP-317 charges 5,000 zatoshi per logical
 * action, and a typical shield from one or two transparent inputs has two or three.
 */
export const SHIELD_FEE_ZAT = 15_000;

export type EntryCode =
  "unique-entry" | "thin-entry" | "common-entry" | "no-common-amount" | "stale-data";

export interface EntryReason {
  code: EntryCode;
  severity: Verdict;
  message: string;
}

export interface EntryAdvice {
  /** Verdict on depositing the whole balance as it is. */
  verdict: Verdict;
  balance: number;
  asIs: { crowd: number; expectedChance: number };
  /**
   * The largest common amount the balance can deposit in one go, fee included, when the balance
   * itself isn't common. The rest stays on the transparent side, where it already is.
   */
  common?: { amount: number; crowd: number; keepTransparent: number };
  reasons: EntryReason[];
  /** What to do, in order. */
  advice: string[];
  data: { dataTo: number; staleness: number; measuredAt: number };
}

const zec = (zat: number): string => `${formatZat(zat)} ZEC`;

export interface EntryOptions {
  /** Zatoshi on the transparent side, available to deposit (fees included). */
  balance: number;
  /** Unix seconds; defaults to the end of the data. */
  time?: number;
}

export function planEntry(ctx: PreflightContext, opts: EntryOptions): EntryAdvice {
  const p = ctx.params;
  const { dataFrom, dataTo } = ctx.data;
  const { balance } = opts;
  if (!Number.isSafeInteger(balance) || balance <= 0) {
    throw new PreflightRangeError("the amount must be a positive number of zatoshi");
  }
  if (balance <= SHIELD_FEE_ZAT) {
    throw new PreflightRangeError(
      `${zec(balance)} doesn't cover the network fee of a deposit (about ${zec(SHIELD_FEE_ZAT)})`,
    );
  }
  const time = opts.time ?? dataTo;
  if (time - p.windowSec - p.backgroundSec < dataFrom) {
    throw new PreflightRangeError("the data doesn't reach far enough back before that time");
  }
  // Deposits after the data ends are unknown; measure over the last full week instead.
  const measuredAt = Math.min(time, dataTo);
  const staleness = Math.max(0, time - dataTo);

  // A deposit of d (fee included) puts d - fee into the pool; withdrawals of about that amount are
  // what it would be confused with, so that is the amount the crowd is measured for.
  const crowdFor = (pooled: number): number =>
    feeShapedEntities(ctx.index, { time: measuredAt, amount: pooled }, p).size;
  const asIsPooled = balance - SHIELD_FEE_ZAT;
  const asIs = {
    crowd: crowdFor(asIsPooled),
    expectedChance: expectedChanceMatches(ctx.index, { time: measuredAt, amount: asIsPooled }, p),
  };

  const reasons: EntryReason[] = [];
  let verdict: Verdict;
  if (asIs.crowd >= CROWD_TARGET) {
    verdict = "green";
    reasons.push({
      code: "common-entry",
      severity: "green",
      message:
        `${zec(balance)} is a common amount: ${asIs.crowd} parties deposited about the same in the ` +
        "week before. Depositing it as it is blends in.",
    });
  } else if (asIs.crowd === 0 && asIs.expectedChance <= p.maxExpectedChance) {
    verdict = "red";
    reasons.push({
      code: "unique-entry",
      severity: "red",
      message:
        `Nobody else deposited about ${zec(balance)} in the week before. This deposit would be a ` +
        "fingerprint: a later withdrawal of about this amount points straight back at it.",
    });
  } else {
    verdict = "amber";
    reasons.push({
      code: "thin-entry",
      severity: "amber",
      message:
        `Only ${asIs.crowd} ${asIs.crowd === 1 ? "party" : "parties"} deposited about ${zec(balance)} ` +
        "in the week before, so a later withdrawal of this amount would have few others to hide among.",
    });
  }

  let common: EntryAdvice["common"];
  const advice: string[] = [];
  if (verdict !== "green") {
    // Largest standard or often-withdrawn round amount that fits with its fee and blends in.
    for (const { amount } of measureDenominations(ctx.data, ctx.index, p)) {
      if (amount + SHIELD_FEE_ZAT > balance) continue;
      const crowd = crowdFor(amount);
      if (crowd >= CROWD_TARGET) {
        common = { amount, crowd, keepTransparent: balance - amount - SHIELD_FEE_ZAT };
        break;
      }
    }
    advice.push(
      `To keep everything shielded: deposit all ${zec(balance)}, and later withdraw with the Exit ` +
        "Planner. Its withdrawals use common amounts and never add up to your deposit, so the " +
        "deposit's amount can't be matched.",
    );
    if (common) {
      advice.push(
        `If you'll withdraw it all in one go, deposit ${zec(common.amount)} instead (${common.crowd} ` +
          `parties deposited about that in the week before). The other ${zec(common.keepTransparent)} ` +
          "stays transparent, where it already is; add it to a later deposit rather than depositing " +
          "it on its own.",
      );
    } else {
      reasons.push({
        code: "no-common-amount",
        severity: "amber",
        message:
          `No amount up to ${zec(balance)} is common enough to blend in, so withdrawing it all in one ` +
          "go would stand out whatever you deposit. Use the Exit Planner when you withdraw.",
      });
    }
  }
  advice.push(
    "Wait at least a day before withdrawing, longer if you can. A withdrawal soon after a deposit " +
      "points at it by timing alone, even when the amount is common.",
    "Never withdraw back to the address you deposit from: the address alone links the two.",
  );

  if (staleness > STALE_AFTER_SEC) {
    reasons.push({
      code: "stale-data",
      severity: "amber",
      message:
        `The data ends ${(staleness / 86_400).toFixed(1)} days before this deposit, so recent ` +
        "deposits by others aren't counted.",
    });
  }

  return {
    verdict,
    balance,
    asIs,
    ...(common ? { common } : {}),
    reasons,
    advice,
    data: { dataTo, staleness, measuredAt },
  };
}
