import { randomInt } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPreflightContext,
  formatZat,
  loadSnapshot,
  parsePositiveZec,
  parseManifest,
  planExit,
  planToIcs,
  preflight,
  type OwnDeposit,
  type PreflightContext,
  type PreflightResult,
  type VerifiedSnapshot,
} from "@turnstile/core";

export async function loadBundle(dir: string): Promise<VerifiedSnapshot> {
  const read = (name: string): Uint8Array => new Uint8Array(readFileSync(join(dir, name)));
  return loadSnapshot(parseManifest(readFileSync(join(dir, "manifest.json"), "utf8")), {
    snapshot: read("snapshot.bin.gz"),
    addresses: read("addresses.bin"),
    stats: read("stats.json"),
  });
}

/** "now", or an ISO date-time such as 2026-09-30T14:00Z (UTC when no zone is given). */
export function parseTime(value: string | undefined): number {
  if (value === undefined || value === "now") return Math.floor(Date.now() / 1000);
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms))
    throw new RangeError(`Invalid time "${value}"; use ISO, e.g. 2026-09-30T14:00Z`);
  return Math.floor(ms / 1000);
}

function ownDeposit(opts: { deposit?: string; depositAt?: string }): OwnDeposit | undefined {
  if (opts.deposit === undefined) return undefined;
  if (opts.depositAt === undefined) throw new RangeError("--deposit needs --deposit-at");
  return { amount: parsePositiveZec(opts.deposit), time: parseTime(opts.depositAt) };
}

const day = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);
const when = (t: number): string => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
const LABEL = { red: "RED", amber: "AMBER", green: "GREEN" } as const;

function wrap(text: string, indent: string, width = 96): string {
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width - indent.length) {
      lines.push(line.trim());
      line = w;
    } else line += " " + w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.map((l, i) => (i === 0 ? l : indent + l)).join("\n");
}

function printData(ctx: PreflightContext, time: number): void {
  const ahead = (time - ctx.data.dataTo) / 86_400;
  console.log(
    `Data: ${day(ctx.data.dataFrom)} to ${day(ctx.data.dataTo - 1)}` +
      (ahead > 0 ? ` (ends ${ahead.toFixed(1)} days before this withdrawal)` : ""),
  );
}

function printResult(r: PreflightResult): void {
  console.log(`\n  ${LABEL[r.verdict]}`);
  for (const reason of r.reasons) {
    console.log(`  - [${reason.severity}] ${wrap(reason.message, "    ")}`);
  }
}

export interface CheckOptions {
  at?: string;
  to?: string;
  deposit?: string;
  depositAt?: string;
  snapshot: string;
}

export async function checkCommand(zec: string, opts: CheckOptions): Promise<void> {
  // Validate input before loading or printing anything.
  const amount = parsePositiveZec(zec);
  const bundle = await loadBundle(opts.snapshot);
  const ctx = createPreflightContext(bundle.data, bundle.addresses);
  const time = parseTime(opts.at);
  const own = ownDeposit(opts);
  printData(ctx, time);
  console.log(
    `Checking a withdrawal of ${formatZat(amount)} ZEC at ${when(time)} UTC` +
      (opts.to ? ` to ${opts.to}` : "") +
      (own
        ? `, against your deposit of ${formatZat(own.amount)} ZEC at ${when(own.time)} UTC`
        : ""),
  );
  const result = await preflight(
    ctx,
    { amount, time, ...(opts.to ? { destination: opts.to } : {}) },
    own,
  );
  printResult(result);
  console.log(
    "\n  Checked on this device against the downloaded snapshot; nothing was sent anywhere.",
  );
}

export interface PlanCommandOptions {
  start?: string;
  hours: string;
  legs: string;
  crowd: string;
  seed?: string;
  deposit?: string;
  depositAt?: string;
  ics?: string;
  snapshot: string;
}

export async function planCommand(zec: string, opts: PlanCommandOptions): Promise<void> {
  const total = parsePositiveZec(zec);
  const bundle = await loadBundle(opts.snapshot);
  const ctx = createPreflightContext(bundle.data, bundle.addresses);
  const start = parseTime(opts.start);
  const own = ownDeposit(opts);
  // A fresh random seed by default: if everyone used the same seed, everyone's legs would land at
  // the same times, which would itself be a fingerprint.
  const seed = opts.seed !== undefined ? Number(opts.seed) : randomInt(1, 2 ** 31);
  const plan = await planExit(ctx, {
    total,
    start,
    horizonHours: Number(opts.hours),
    maxLegs: Number(opts.legs),
    crowdTarget: Number(opts.crowd),
    seed,
    ...(own ? { own } : {}),
  });
  printData(ctx, start);
  console.log(
    `Exit plan for ${formatZat(plan.options.total)} ZEC over ${opts.hours} hours from ${when(start)} UTC (seed ${seed})`,
  );
  console.log(`\nWithdrawn all at once:`);
  printResult(plan.singleExit);
  console.log(`\nThe plan:`);
  plan.legs.forEach((leg, i) => {
    console.log(
      `  ${i + 1}. ${when(leg.time)} UTC   ${formatZat(leg.amount).padStart(8)} ZEC   ` +
        `hides among ${leg.crowd}   ${LABEL[leg.check.verdict]}` +
        (leg.check.verdict === "green"
          ? ""
          : `  (${leg.check.reasons
              .filter((r) => r.severity !== "green")
              .map((r) => r.code)
              .join(", ")})`),
    );
  });
  console.log(
    `\n  Withdrawn ${formatZat(plan.withdrawn)} ZEC in ${plan.legs.length} legs; ` +
      `${formatZat(plan.remainder)} ZEC stays shielded.`,
  );
  for (const a of plan.advice) console.log(`  - ${wrap(a, "    ")}`);
  if (opts.ics) {
    writeFileSync(opts.ics, planToIcs(plan));
    console.log(`\n  Wrote calendar reminders to ${opts.ics} (import into your own calendar app).`);
  }
}
