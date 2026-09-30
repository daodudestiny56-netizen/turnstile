// Independent check for PRD S5 on the real snapshot bundle:
//   1. round trips on real, identifiable deposits are red ("exact-round-trip"), and without the
//      user's deposit the check names that exact deposit ("unique-match")
//   2. a real depositing address as destination is red ("address-reuse"); others are not flagged
//   3. planner: legs meet the crowd target, sum <= total, remainder reported, deterministic per seed
//   4. p95 time of a check on the full snapshot < 500 ms
//   5. freshness: stale-data appears more than two days after the data ends, not before
//
//   node scripts/verify-preflight.mjs [dir=data/snapshot] [db=data/turnstile.sqlite]
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const [dir = "data/snapshot", dbPath = "data/turnstile.sqlite"] = process.argv.slice(2);
const core = await import(pathToFileURL(resolve("packages/core/dist/index.js")).href);
const read = (n) => new Uint8Array(readFileSync(join(dir, n)));
const bundle = await core.loadSnapshot(
  core.parseManifest(readFileSync(join(dir, "manifest.json"), "utf8")),
  {
    snapshot: read("snapshot.bin.gz"),
    addresses: read("addresses.bin"),
    stats: read("stats.json"),
  },
);
const ctx = core.createPreflightContext(bundle.data, bundle.addresses);
const { dataTo } = bundle.data;
const P = ctx.params;
const H = 3600;
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

// 1. Real identifiable deposits from the last week of data (precise amount, person-scale entity,
//    and nobody else used the amount in the three weeks before the exit).
const recent = bundle.data.shields.filter(
  (s) =>
    s.time > dataTo - 6 * 86400 &&
    s.time < dataTo - 2 * H &&
    core.zecDecimals(s.amount) >= 6 &&
    s.amount > 1_000_000 &&
    !ctx.services.has(s.entity),
);
const identifiable = [];
for (const s of recent) {
  const exit = { time: s.time + H, amount: s.amount - 30_000 };
  const rivals = core.feeShapedEntities(ctx.index, exit, P);
  rivals.delete(s.entity);
  if (rivals.size === 0 && core.expectedChanceMatches(ctx.index, exit, P) === 0)
    identifiable.push({ s, exit });
  if (identifiable.length === 25) break;
}
let redOwn = 0;
let namedDeposit = 0;
for (const { s, exit } of identifiable) {
  const withOwn = await core.preflight(ctx, exit, { amount: s.amount, time: s.time });
  if (withOwn.verdict === "red" && withOwn.reasons[0].code === "exact-round-trip") redOwn++;
  const without = await core.preflight(ctx, exit);
  if (
    without.verdict === "red" &&
    without.reasons[0].code === "unique-match" &&
    without.matchedDeposit?.time === s.time &&
    without.matchedDeposit?.amount === s.amount
  )
    namedDeposit++;
}
check(
  identifiable.length >= 20 && redOwn === identifiable.length,
  `exact round trips on ${identifiable.length} real identifiable deposits: ${redOwn} red "exact-round-trip"`,
);
check(
  namedDeposit === identifiable.length,
  `without the user's deposit: ${namedDeposit}/${identifiable.length} red "unique-match" naming that exact deposit`,
);

// 2. Address reuse with real addresses
const db = new DatabaseSync(dbPath, { readOnly: true });
// Only the snapshot's own days: the database may hold more.
const { fromDay, toDay } = bundle.manifest;
const shieldAddrs = new Set(
  db
    .prepare(
      "SELECT addresses FROM events WHERE kind = 'SHIELD' AND day BETWEEN ? AND ? ORDER BY txid LIMIT 3000",
    )
    .all(fromDay, toDay)
    .flatMap((r) => JSON.parse(r.addresses)),
);
const allShieldAddrs = new Set(
  db
    .prepare("SELECT addresses FROM events WHERE kind = 'SHIELD' AND day BETWEEN ? AND ?")
    .all(fromDay, toDay)
    .flatMap((r) => JSON.parse(r.addresses)),
);
const exitOnly = db
  .prepare(
    "SELECT addresses FROM events WHERE kind = 'DESHIELD' AND day BETWEEN ? AND ? ORDER BY txid LIMIT 3000",
  )
  .all(fromDay, toDay)
  .flatMap((r) => JSON.parse(r.addresses))
  .filter((a) => !allShieldAddrs.has(a));
const reused = [...shieldAddrs].slice(0, 50);
const fresh = exitOnly.slice(0, 50);
const at = dataTo - H;
let flagged = 0;
let wronglyFlagged = 0;
for (const a of reused) {
  const r = await core.preflight(ctx, { amount: 100_000_000, time: at, destination: a });
  if (r.verdict === "red" && r.reasons[0].code === "address-reuse") flagged++;
}
for (const a of fresh) {
  const r = await core.preflight(ctx, { amount: 100_000_000, time: at, destination: a });
  if (r.reasons.some((x) => x.code === "address-reuse")) wronglyFlagged++;
}
check(
  flagged === reused.length && wronglyFlagged === 0,
  `address reuse: ${flagged}/${reused.length} depositing addresses red, ${wronglyFlagged}/${fresh.length} others flagged`,
);

// 3. Planner properties over several totals and seeds
let planOk = true;
let plans = 0;
for (const total of [31_742_000, 317_420_000, 1_234_567_890, 5_000_000_000]) {
  for (const seed of [1, 2, 3]) {
    const options = { total, start: dataTo - 12 * H, horizonHours: 48, seed };
    const a = await core.planExit(ctx, options);
    const b = await core.planExit(ctx, options);
    plans++;
    const target = a.options.crowdTarget;
    const ok =
      JSON.stringify(a) === JSON.stringify(b) &&
      a.withdrawn + a.remainder === total &&
      a.withdrawn <= total &&
      a.legs.length <= a.options.maxLegs &&
      (a.targetMet
        ? a.legs.every((l) => l.crowd >= target)
        : a.advice[0].includes("best available")) &&
      core.linkedSums(
        a.legs.map((l) => l.amount),
        total,
        undefined,
        P,
      ).length === 0;
    if (!ok) {
      planOk = false;
      console.log(`      plan failed: total ${total} seed ${seed}`);
    }
  }
}
const s1 = await core.planExit(ctx, {
  total: 317_420_000,
  start: dataTo - 12 * H,
  horizonHours: 48,
  seed: 1,
});
const s2 = await core.planExit(ctx, {
  total: 317_420_000,
  start: dataTo - 12 * H,
  horizonHours: 48,
  seed: 2,
});
check(
  planOk &&
    JSON.stringify(s1.legs.map((l) => l.time)) !== JSON.stringify(s2.legs.map((l) => l.time)),
  `planner: ${plans} plans meet the crowd target (or say why), sum to total with remainder, ` +
    `no group of legs adds up to the total within fees, ` +
    `repeat exactly per seed, and differ across seeds`,
);

// 4. Speed
const times = [];
let r = 0;
for (let i = 0; i < 1000; i++) {
  r = (r * 1103515245 + 12345) % 2 ** 31;
  const amount = 1_000_000 + (r % 2_000_000_000);
  const t0 = performance.now();
  await core.preflight(
    ctx,
    { amount, time: dataTo - (r % (6 * 86400)) },
    i % 2 ? { amount: amount + 30_000, time: dataTo - 7 * 86400 } : undefined,
  );
  times.push(performance.now() - t0);
}
times.sort((a, b) => a - b);
const p95 = times[Math.floor(0.95 * times.length)];
check(
  p95 < 500,
  `speed: p95 ${p95.toFixed(2)} ms per check over 1,000 checks (max ${times.at(-1).toFixed(1)} ms)`,
);

// 5. Freshness
const codes = async (time) =>
  (await core.preflight(ctx, { amount: 100_000_000, time })).reasons.map((x) => x.code);
const stale = await codes(dataTo + 3 * 86400);
const freshCodes = await codes(dataTo + 1 * 86400);
check(
  stale.includes("stale-data") && !freshCodes.includes("stale-data"),
  `freshness: warned 3 days after the data ends, not 1 day after`,
);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
