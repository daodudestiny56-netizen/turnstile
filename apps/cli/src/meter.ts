import { writeFileSync } from "node:fs";
import {
  DEFAULT_MATCH_PARAMS,
  ShieldIndex,
  clusterEntities,
  meterStats,
  precisionBand,
  scoreExit,
  type MeterStats,
  type Rate,
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
}

interface MatchData {
  shieldEvents: StoredEvent[];
  shields: ShieldPoint[];
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
    exits,
    index: new ShieldIndex(shields),
    dataFrom: parseDay(from) / 1000,
    dataTo: parseDay(opts.to) / 1000 + 86_400,
  };
}

const pct = (r: number): string => `${(100 * r).toFixed(2)}%`;
const rateLine = (r: Rate): string => `${pct(r.rate)}  (${r.linkable} of ${r.total})`;

export function meterCommand(opts: MeterOptions): void {
  const started = performance.now();
  const data = loadMatchData(opts);
  const entityCount = new Set(data.shields.map((s) => s.entity)).size;
  const stats: MeterStats = meterStats(data.index, data.exits, data.dataFrom, data.dataTo);
  const seconds = ((performance.now() - started) / 1000).toFixed(1);

  console.log("Turnstile Leak Meter");
  console.log(
    `  data: ${data.shieldEvents.length} shields from ${entityCount} entities, ${data.exits.length} exits`,
  );
  console.log(
    `  scored: ${stats.evaluated} exits with a full ${stats.params.windowSec / 86_400}-day window on both sides\n`,
  );
  console.log(`  linkable to their entry        ${rateLine(stats.observed)}`);
  console.log(`  coincidence, reversed time     ${rateLine(stats.baseline)}`);
  console.log(`  coincidence, shifted amount    ${rateLine(stats.shiftedBaseline)}`);
  console.log(
    `  linkable beyond coincidence    at least ${pct(stats.excess)} (observed minus the larger baseline)
`,
  );
  console.log("  by amount precision                observed  reversed   shifted");
  for (const [band, r] of Object.entries(stats.byPrecision)) {
    console.log(
      `    ${band.padEnd(30)}  ${pct(r.observed.rate).padStart(8)}  ${pct(r.baseline.rate).padStart(8)}  ${pct(r.shiftedBaseline.rate).padStart(8)}   (${r.observed.total} exits)`,
    );
  }
  console.log("  by month");
  for (const [month, r] of Object.entries(stats.byMonth)) {
    console.log(
      `    ${month.padEnd(30)}  ${pct(r.observed.rate).padStart(8)}  ${pct(r.baseline.rate).padStart(8)}  ${pct(r.shiftedBaseline.rate).padStart(8)}   (${r.observed.total} exits)`,
    );
  }
  console.log("  entities that could have funded each exit");
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

export function validateCommand(opts: MeterOptions & { trips: string; seed: string }): void {
  const data = loadMatchData(opts);
  const params = DEFAULT_MATCH_PARAMS;
  const rand = rng(Number(opts.seed));
  const n = Number(opts.trips);
  const userAmounts = data.shieldEvents
    .filter((e) => !e.tags.includes("coinbase"))
    .map((e) => e.amount);
  const pickAmount = (min = 0): number => {
    for (;;) {
      const x = userAmounts[Math.floor(rand() * userAmounts.length)]!;
      if (x >= min) return x;
    }
  };
  const lo = data.dataFrom + params.windowSec;
  const hi = data.dataTo - params.windowSec - 2 * 86_400;
  const pickTime = (): number => Math.floor(lo + rand() * (hi - lo));
  let nextEntity = Math.max(-1, ...data.shields.map((s) => s.entity)) + 1;

  const scenarios: Record<string, () => PlantedTrip> = {
    "(a) exact amount out after 1 hour": () => {
      const t = pickTime();
      const x = pickAmount();
      return {
        shield: { time: t, amount: x, entity: nextEntity++ },
        exits: [{ time: t + HOUR, amount: x - 2 * FEE }],
      };
    },
    "(b) exact amount out after 24 hours": () => {
      const t = pickTime();
      const x = pickAmount();
      return {
        shield: { time: t, amount: x, entity: nextEntity++ },
        exits: [{ time: t + 24 * HOUR, amount: x - 2 * FEE }],
      };
    },
    "(c) round amount out after 3 hours": () => {
      const t = pickTime();
      const r = ROUND_ZEC[Math.floor(rand() * ROUND_ZEC.length)]!;
      return {
        shield: { time: t, amount: r + 2 * FEE, entity: nextEntity++ },
        exits: [{ time: t + 3 * HOUR, amount: r }],
      };
    },
    "(d) split into 2 legs": () => {
      const t = pickTime();
      // At least 0.1 ZEC, so both legs are real withdrawals.
      const x = pickAmount(10_000_000);
      const leg1 = Math.floor((x * 0.6) / 1_000_000) * 1_000_000;
      return {
        shield: { time: t, amount: x, entity: nextEntity++ },
        exits: [
          { time: t + 6 * HOUR, amount: leg1 },
          { time: t + 30 * HOUR, amount: x - 3 * FEE - leg1 },
        ],
      };
    },
  };

  console.log(
    `Planted trips: ${n} per scenario, seed ${opts.seed}, into real mainnet background\n`,
  );
  for (const [name, make] of Object.entries(scenarios)) {
    let legs = 0;
    let linked = 0;
    const bands = new Map<string, { legs: number; linked: number }>();
    for (let i = 0; i < n; i++) {
      const trip = make();
      for (const exit of trip.exits) {
        legs++;
        const s = scoreExit(data.index, exit, params, "forward", [trip.shield]);
        const hit = s.linkable && s.topEntity === trip.shield.entity;
        if (hit) linked++;
        const band = bands.get(precisionBand(exit.amount)) ?? { legs: 0, linked: 0 };
        band.legs++;
        if (hit) band.linked++;
        bands.set(precisionBand(exit.amount), band);
      }
    }
    console.log(
      `  ${name.padEnd(38)} linked ${pct(linked / legs).padStart(8)}  (${linked} of ${legs} exits)`,
    );
    for (const [band, b] of [...bands].sort(([a], [c]) => a.localeCompare(c))) {
      console.log(
        `      ${band.padEnd(34)} ${pct(b.linked / b.legs).padStart(8)}  (${b.linked} of ${b.legs})`,
      );
    }
  }

  // Natural labels: exits paid to an address that shielded within the window. The matcher never
  // sees addresses; the label only says which entry was truly the funder.
  const entityOf = new Map<StoredEvent, number>();
  data.shieldEvents.forEach((e, i) => entityOf.set(e, data.shields[i]!.entity));
  const byAddress = new Map<string, StoredEvent[]>();
  for (const s of data.shieldEvents)
    for (const a of s.addresses) (byAddress.get(a) ?? byAddress.set(a, []).get(a)!).push(s);

  const labels: { exit: StoredEvent; shield: StoredEvent; address: string }[] = [];
  for (const exit of data.exits) {
    if (exit.time - params.windowSec < data.dataFrom) continue;
    let best: { shield: StoredEvent; address: string } | undefined;
    for (const a of exit.addresses)
      for (const s of byAddress.get(a) ?? [])
        if (
          s.time < exit.time &&
          exit.time - s.time <= params.windowSec &&
          (!best || s.time > best.shield.time)
        )
          best = { shield: s, address: a };
    if (best) labels.push({ exit, ...best });
  }
  const perAddress = new Map<string, number>();
  for (const l of labels) perAddress.set(l.address, (perAddress.get(l.address) ?? 0) + 1);
  const busy = new Set([...perAddress].filter(([, c]) => c > 100).map(([a]) => a));

  const evaluate = (set: typeof labels): string => {
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
    const byBand = [...bands]
      .sort(([a], [c]) => a.localeCompare(c))
      .map(
        ([band, b]) => `
        ${band.padEnd(28)} recall ${pct(b.correct / b.exact).padStart(8)}  (${b.correct} of ${b.exact})`,
      )
      .join("");
    return (
      `${set.length} labelled exits, ${exact} exact round trips (${pct(exact / set.length)})\n` +
      `      recall on exact trips  ${pct(correct / Math.max(1, exact))}  (${correct} of ${exact} linked to the right entity)\n` +
      `      precision              ${pct(correct / Math.max(1, flagged))}  (${correct} of ${flagged} linkable verdicts correct)` +
      byBand
    );
  };
  console.log(`\nNatural labels (same-address round trips; addresses hidden from the matcher)`);
  console.log(`  all:                    ${evaluate(labels)}`);
  console.log(
    `  excluding ${busy.size} busy addresses (>100 labels each):\n                          ${evaluate(labels.filter((l) => !busy.has(l.address)))}`,
  );
}
