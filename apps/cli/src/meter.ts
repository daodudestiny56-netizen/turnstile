import { writeFileSync } from "node:fs";
import {
  DEFAULT_MATCH_PARAMS,
  ShieldIndex,
  clusterEntities,
  expectedChanceMatches,
  feeShapedEntities,
  historyNeededSec,
  meterStats,
  precisionBand,
  scoreExit,
  serviceEntities,
  type Breakdown,
  type Comparison,
  type MatchParams,
  type ShieldPoint,
} from "@turnstile/core";
import {
  EventStore,
  RawStore,
  dayRange,
  daysBefore,
  parseDay,
  type StoredEvent,
} from "@turnstile/ingest";

export interface MeterOptions {
  from?: string;
  to: string;
  days?: string;
  db: string;
  out?: string;
  /** Override maxExpectedChance, for calibration. */
  maxChance?: string;
}

function paramsFrom(opts: MeterOptions): MatchParams {
  return opts.maxChance === undefined
    ? DEFAULT_MATCH_PARAMS
    : { ...DEFAULT_MATCH_PARAMS, maxExpectedChance: Number(opts.maxChance) };
}

interface MatchData {
  shieldEvents: StoredEvent[];
  shields: ShieldPoint[];
  services: Set<number>;
  exits: StoredEvent[];
  index: ShieldIndex;
  dataFrom: number;
  dataTo: number;
}

function loadMatchData(opts: MeterOptions): MatchData {
  const from = opts.from ?? (opts.days ? daysBefore(opts.to, Number(opts.days)) : opts.to);
  const days = dayRange(from, opts.to);
  const raw = new RawStore(opts.db);
  let events: StoredEvent[];
  try {
    events = new EventStore(raw.db).load(days);
  } finally {
    raw.close();
  }
  const shieldEvents = events.filter((e) => e.kind === "SHIELD");
  const entities = clusterEntities(shieldEvents.map((e) => e.addresses));
  const shields = shieldEvents.map((e, i) => ({
    time: e.time,
    amount: e.amount,
    entity: entities[i]!,
  }));
  // Batch payouts pay many people at once; they are not a person's exit.
  const exits = events.filter((e) => e.kind === "DESHIELD" && !e.tags.includes("batch"));
  return {
    shieldEvents,
    shields,
    services: serviceEntities(entities),
    exits,
    index: new ShieldIndex(shields),
    dataFrom: parseDay(from) / 1000,
    dataTo: parseDay(opts.to) / 1000 + 86_400,
  };
}

const pct = (r: number): string => `${(100 * r).toFixed(2)}%`;

function row(label: string, c: Comparison): string {
  return (
    `    ${label.padEnd(24)}${pct(c.observed.rate).padStart(9)}${pct(c.reversed.rate).padStart(10)}` +
    `${pct(c.shifted.rate).padStart(10)}${pct(c.excess).padStart(11)}   (${c.observed.total} exits)`
  );
}

function printBreakdown(title: string, b: Breakdown): void {
  console.log(`\n  ${title}`);
  console.log("                             linked  reversed   shifted  beyond chance");
  console.log(row("all exits", b));
  for (const [band, c] of Object.entries(b.byPrecision)) console.log(row(band, c));
  for (const [month, c] of Object.entries(b.byMonth)) console.log(row(month, c));
}

export function meterCommand(opts: MeterOptions): void {
  const started = performance.now();
  const data = loadMatchData(opts);
  const entityCount = new Set(data.shields.map((s) => s.entity)).size;
  const serviceShields = data.shields.filter((s) => data.services.has(s.entity)).length;
  const stats = meterStats(
    data.index,
    data.exits,
    data.dataFrom,
    data.dataTo,
    paramsFrom(opts),
    data.services,
  );
  const seconds = ((performance.now() - started) / 1000).toFixed(1);

  const p = stats.people;
  console.log("Turnstile Leak Meter");
  console.log(
    `  data: ${data.shieldEvents.length} shields from ${entityCount} entities ` +
      `(${stats.serviceEntities} services made ${serviceShields} of them), ${data.exits.length} exits`,
  );
  console.log(
    `  scored: ${stats.evaluated} exits with ${historyNeededSec(stats.params) / 86_400} days of data on both sides ` +
      `(${stats.params.windowSec / 86_400}-day search window, ${stats.params.backgroundSec / 86_400}-day background)\n`,
  );
  console.log(`  Exits traced to a person-scale entity`);
  console.log(
    `    linked to their entry          ${pct(p.observed.rate)}  (${p.observed.linkable})`,
  );
  console.log(
    `    by chance, reversed time       ${pct(p.reversed.rate)}  (${p.reversed.linkable})`,
  );
  console.log(`    by chance, shifted amount      ${pct(p.shifted.rate)}  (${p.shifted.linkable})`);
  console.log(`    beyond chance                  at least ${pct(p.excess)}`);

  printBreakdown("People (headline)", stats.people);
  printBreakdown("Services (entities with more than 100 shields)", stats.services);
  printBreakdown("Everyone", stats.all);

  console.log("\n  entities that could have funded each exit");
  for (const [bucket, n] of Object.entries(stats.crowd)) {
    console.log(`    ${bucket.padEnd(8)} ${String(n).padStart(7)}  ${pct(n / stats.evaluated)}`);
  }
  console.log(`\n  ${seconds}s`);
  if (opts.out) {
    writeFileSync(opts.out, JSON.stringify(stats, null, 2) + "\n");
    console.log(`  wrote ${opts.out}`);
  }
}

/** Deterministic PRNG (mulberry32) so validation runs are reproducible. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOUR = 3_600;
const ROUND_ZEC = [10_000_000, 50_000_000, 100_000_000, 200_000_000, 500_000_000, 1_000_000_000];
/** Typical ZIP-317 fee for one shield or deshield, as seen in the node-verified sample. */
const FEE = 15_000;

interface PlantedTrip {
  shield: ShieldPoint;
  exits: { time: number; amount: number }[];
}

/** How the matcher treated one planted exit. */
type Outcome = "right" | "wrong" | "hidden";

class OutcomeTally {
  identifiable = { n: 0, right: 0, wrong: 0 };
  crowded = { n: 0, right: 0, wrong: 0 };
  add(identifiable: boolean, outcome: Outcome): void {
    const t = identifiable ? this.identifiable : this.crowded;
    t.n++;
    if (outcome === "right") t.right++;
    if (outcome === "wrong") t.wrong++;
  }
  get n(): number {
    return this.identifiable.n + this.crowded.n;
  }
  get right(): number {
    return this.identifiable.right + this.crowded.right;
  }
  get wrong(): number {
    return this.identifiable.wrong + this.crowded.wrong;
  }
}

export function validateCommand(opts: MeterOptions & { trips: string; seed: string }): void {
  const data = loadMatchData(opts);
  const params = paramsFrom(opts);
  const rand = rng(Number(opts.seed));
  const n = Number(opts.trips);
  // Planted trips stand for people, so their amounts come from ordinary users' shields.
  const userAmounts = data.shieldEvents
    .filter((e, i) => !e.tags.includes("coinbase") && !data.services.has(data.shields[i]!.entity))
    .map((e) => e.amount);
  const pickAmount = (min = 0): number => {
    for (;;) {
      const x = userAmounts[Math.floor(rand() * userAmounts.length)]!;
      if (x >= min) return x;
    }
  };
  const lo = data.dataFrom + historyNeededSec(params);
  const hi = data.dataTo - 2 * 86_400;
  const pickTime = (): number => Math.floor(lo + rand() * (hi - lo));
  let nextEntity = Math.max(-1, ...data.shields.map((s) => s.entity)) + 1;
  const trip = (t: number, amount: number, exits: PlantedTrip["exits"]): PlantedTrip => ({
    shield: { time: t, amount, entity: nextEntity++ },
    exits,
  });

  const scenarios: Record<string, () => PlantedTrip> = {
    "(a) exact amount out after 1 hour": () => {
      const t = pickTime();
      const x = pickAmount();
      return trip(t, x, [{ time: t + HOUR, amount: x - 2 * FEE }]);
    },
    "(b) exact amount out after 24 hours": () => {
      const t = pickTime();
      const x = pickAmount();
      return trip(t, x, [{ time: t + 24 * HOUR, amount: x - 2 * FEE }]);
    },
    "(c) round amount out after 3 hours": () => {
      const t = pickTime();
      const r = ROUND_ZEC[Math.floor(rand() * ROUND_ZEC.length)]!;
      return trip(t, r + 2 * FEE, [{ time: t + 3 * HOUR, amount: r }]);
    },
    "(d) split into 2 legs": () => {
      const t = pickTime();
      // At least 0.1 ZEC, so both legs are real withdrawals.
      const x = pickAmount(10_000_000);
      const leg1 = Math.floor((x * 0.6) / 1_000_000) * 1_000_000;
      return trip(t, x, [
        { time: t + 6 * HOUR, amount: leg1 },
        { time: t + 30 * HOUR, amount: x - 3 * FEE - leg1 },
      ]);
    },
  };

  console.log(
    `Planted trips: ${n} per scenario, seed ${opts.seed}, amounts from ordinary users' shields,\n` +
      `placed into the real mainnet background.\n` +
      `"Identifiable": nobody else shielded this amount (plus fees) in the 3 weeks before the exit,\n` +
      `so amount and timing single out the entry. "Crowded": someone else did.\n`,
  );
  console.log(
    "                                        exits   linked right   linked WRONG   identifiable -> linked   crowded -> hidden",
  );
  for (const [name, make] of Object.entries(scenarios)) {
    const t = new OutcomeTally();
    for (let i = 0; i < n; i++) {
      const planted = make();
      for (const exit of planted.exits) {
        const s = scoreExit(data.index, exit, params, "forward", [planted.shield]);
        // Identifiable by the matcher's own standard: nobody else used this amount (plus fees) in
        // the search window or the background before it.
        const identifiable =
          feeShapedEntities(data.index, exit, params, "forward").size === 0 &&
          expectedChanceMatches(data.index, exit, params, "forward") === 0;
        const outcome: Outcome = !s.linkable
          ? "hidden"
          : s.topEntity === planted.shield.entity
            ? "right"
            : "wrong";
        t.add(identifiable, outcome);
      }
    }
    const idLinked = t.identifiable.n ? t.identifiable.right / t.identifiable.n : NaN;
    const crowdHidden = t.crowded.n
      ? (t.crowded.n - t.crowded.right - t.crowded.wrong) / t.crowded.n
      : NaN;
    console.log(
      `  ${name.padEnd(38)}${String(t.n).padStart(5)}${pct(t.right / t.n).padStart(15)}` +
        `${`${t.wrong} (${pct(t.wrong / t.n)})`.padStart(15)}` +
        `${`${pct(idLinked)} of ${t.identifiable.n}`.padStart(25)}` +
        `${`${pct(crowdHidden)} of ${t.crowded.n}`.padStart(20)}`,
    );
  }

  // Natural labels: exits paid to an address that shielded within the window. The matcher never
  // sees addresses; the label only says which entry was truly the funder.
  const entityOf = new Map<StoredEvent, number>();
  data.shieldEvents.forEach((e, i) => entityOf.set(e, data.shields[i]!.entity));
  const byAddress = new Map<string, StoredEvent[]>();
  for (const s of data.shieldEvents)
    for (const a of s.addresses) (byAddress.get(a) ?? byAddress.set(a, []).get(a)!).push(s);

  const labels: { exit: StoredEvent; shield: StoredEvent }[] = [];
  for (const exit of data.exits) {
    if (exit.time - historyNeededSec(params) < data.dataFrom) continue;
    let best: StoredEvent | undefined;
    for (const a of exit.addresses)
      for (const s of byAddress.get(a) ?? [])
        if (
          s.time < exit.time &&
          exit.time - s.time <= params.windowSec &&
          (!best || s.time > best.time)
        )
          best = s;
    if (best) labels.push({ exit, shield: best });
  }

  const evaluate = (set: typeof labels): void => {
    let exact = 0;
    let flagged = 0;
    let correct = 0;
    const bands = new Map<string, { exact: number; correct: number }>();
    for (const l of set) {
      const diff = l.shield.amount - l.exit.amount;
      const isExact = diff >= 0 && diff <= params.feeMaxZat;
      if (isExact) exact++;
      const s = scoreExit(data.index, { time: l.exit.time, amount: l.exit.amount }, params);
      const right = s.linkable && s.topEntity === entityOf.get(l.shield);
      if (s.linkable) {
        flagged++;
        if (right) correct++;
      }
      if (isExact) {
        const b = bands.get(precisionBand(l.exit.amount)) ?? { exact: 0, correct: 0 };
        b.exact++;
        if (right) b.correct++;
        bands.set(precisionBand(l.exit.amount), b);
      }
    }
    console.log(
      `    ${set.length} labelled exits, ${exact} exact round trips (${pct(exact / Math.max(1, set.length))})`,
    );
    console.log(
      `    recall on exact trips  ${pct(correct / Math.max(1, exact))}  (${correct} of ${exact} linked to the right entity)`,
    );
    console.log(
      `    precision              ${pct(correct / Math.max(1, flagged))}  (${correct} of ${flagged} linkable verdicts correct)`,
    );
    for (const [band, b] of [...bands].sort(([a], [c]) => a.localeCompare(c))) {
      console.log(
        `      ${band.padEnd(26)} recall ${pct(b.correct / b.exact).padStart(8)}  (${b.correct} of ${b.exact})`,
      );
    }
  };
  const isPersonLabel = (l: (typeof labels)[number]): boolean =>
    !data.services.has(entityOf.get(l.shield)!);
  console.log(`\nNatural labels (same-address round trips; addresses hidden from the matcher)`);
  console.log(`  all labels:`);
  evaluate(labels);
  console.log(`  labels whose funder is a person-scale entity:`);
  evaluate(labels.filter(isPersonLabel));
}
