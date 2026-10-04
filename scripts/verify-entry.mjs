// Independent check for PRD S8 (F5 Entry Planner) on the real snapshot bundle.
//
// Planted users deposit a precise amount taken from real person-scale deposits, at a random time in
// the data, into the real mainnet background, and later withdraw:
//   as-is:        deposit the whole balance, withdraw it all minus fees
//   common:       deposit planEntry's common amount instead (computed at that moment), withdraw it
//                 all minus fees
//   exit planner: deposit the whole balance, withdraw with planExit's legs (starting at the delay)
// For each delay it reports how often the matcher links a withdrawal to the planted deposit, and
// how often an observer's single best guess (the heaviest candidate by amount and timing, ignoring
// the matcher's caution) is the planted deposit.
//
// Acceptance: as-is, at least 99% of identifiable exact round trips are linked (the S3 standard);
// with either kind of advice, at most 1% of withdrawals are linked at any delay; after three days,
// the observer's best guess is right at most one time in CROWD_TARGET; every common amount hides
// among at least CROWD_TARGET parties and fits the balance with its fee.
//
//   node scripts/verify-entry.mjs [n=1000] [seed=2026] [dir=data/snapshot]
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [nArg = "600", seedArg = "2026", dir = "data/snapshot"] = process.argv.slice(2);
const N = Number(nArg);
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
const P = ctx.params;
const FEE = core.SHIELD_FEE_ZAT;
const H = 3600;
const rand = core.seededRandom(Number(seedArg));
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};
const pct = (a, b) => `${((100 * a) / Math.max(1, b)).toFixed(1)}%`;

// Amounts people actually deposit: person-scale entities, precise (3+ decimals), at least 0.1 ZEC.
const amounts = bundle.data.shields
  .filter(
    (s) => !ctx.services.has(s.entity) && core.zecDecimals(s.amount) >= 3 && s.amount >= 10_000_000,
  )
  .map((s) => s.amount);
const DELAYS = [1, 24, 72];
const lo = bundle.data.dataFrom + core.historyNeededSec(P) + H;
const hi = bundle.data.dataTo - (Math.max(...DELAYS) + 1) * H;
let nextEntity = Math.max(...bundle.data.shields.map((s) => s.entity)) + 1;

/** Plant one deposit and score its withdrawal: { linked, guessed }. */
function trip(depositAmount, t, exitAmount, delayH) {
  const shield = { time: t, amount: depositAmount, entity: nextEntity++ };
  const exit = { time: t + delayH * H, amount: exitAmount };
  const s = core.scoreExit(ctx.index, exit, P, "forward", [shield]);
  return {
    linked: s.linkable && s.topEntity === shield.entity,
    guessed: s.topEntity === shield.entity,
  };
}

const kinds = ["as-is", "common", "exit planner"];
const tally = Object.fromEntries(
  kinds.flatMap((k) => DELAYS.map((d) => [`${k} ${d}h`, { n: 0, linked: 0, guessed: 0 }])),
);
const add = (key, r) => {
  const k = tally[key];
  k.n++;
  k.linked += r.linked;
  k.guessed += r.guessed;
};
const identifiable = { n: 0, linked: 0 };
let changed = 0;
let noCommonAmount = 0;
let badAdvice = 0;
let movedCommon = 0;
let movedPlanner = 0;
let movedBalance = 0;
for (let i = 0; i < N; i++) {
  const balance = amounts[Math.floor(rand() * amounts.length)];
  const t = Math.floor(lo + rand() * (hi - lo));
  const advice = core.planEntry(ctx, { balance, time: t });
  for (const d of DELAYS) {
    const exitAmount = balance - 2 * FEE;
    const r = trip(balance, t, exitAmount, d);
    add(`as-is ${d}h`, r);
    if (d === 1) {
      const exit = { time: t + H, amount: exitAmount };
      if (
        core.feeShapedEntities(ctx.index, exit, P).size === 0 &&
        core.expectedChanceMatches(ctx.index, exit, P) === 0
      ) {
        identifiable.n++;
        identifiable.linked += r.linked;
      }
    }
  }
  if (advice.verdict === "green") continue; // already common: nothing to change
  changed++;
  // Exit Planner path: deposit everything, withdraw in legs starting after the delay.
  const pooled = balance - FEE;
  for (const d of DELAYS) {
    const plan = await core.planExit(ctx, {
      total: pooled - FEE,
      start: t + d * H,
      horizonHours: 72,
      maxLegs: 4,
      seed: i + 1,
      own: { amount: balance, time: t },
    });
    const shield = { time: t, amount: balance, entity: nextEntity++ };
    for (const leg of plan.legs) {
      const s = core.scoreExit(ctx.index, leg, P, "forward", [shield]);
      add(`exit planner ${d}h`, {
        linked: s.linkable && s.topEntity === shield.entity,
        guessed: s.topEntity === shield.entity,
      });
    }
    if (d === DELAYS[0]) {
      movedPlanner += plan.withdrawn;
      movedBalance += balance;
    }
  }
  if (!advice.common) {
    noCommonAmount++;
    continue;
  }
  const c = advice.common;
  movedCommon += c.amount;
  if (
    c.crowd < core.CROWD_TARGET ||
    c.amount + FEE + c.keepTransparent !== balance ||
    c.keepTransparent < 0
  )
    badAdvice++;
  for (const d of DELAYS) add(`common ${d}h`, trip(c.amount + FEE, t, c.amount - FEE, d));
}

console.log(`Planted ${N} deposits of precise amounts (seed ${seedArg}) into the real background.`);
console.log(
  `Advice applied to ${changed}; ${noCommonAmount} of those had no common amount that fits; the rest were already common.`,
);
console.log(`Share of those balances withdrawn: common amount ${pct(movedCommon, movedBalance)}, Exit Planner (4 legs) ${pct(movedPlanner, movedBalance)}.
`);
console.log(
  "                       withdrawals   linked by the matcher   observer's best guess right",
);
for (const [name, k] of Object.entries(tally)) {
  console.log(
    `  ${name.padEnd(20)}${String(k.n).padStart(12)}${pct(k.linked, k.n).padStart(24)}${pct(k.guessed, k.n).padStart(30)}`,
  );
}
console.log();
check(
  identifiable.linked / identifiable.n >= 0.99,
  `as-is: identifiable exact round trips linked after 1 hour: ${pct(identifiable.linked, identifiable.n)} of ${identifiable.n} (all precise: ${pct(tally["as-is 1h"].linked, tally["as-is 1h"].n)})`,
);
for (const k of ["common", "exit planner"]) {
  for (const d of DELAYS) {
    const x = tally[`${k} ${d}h`];
    check(x.linked / x.n <= 0.01, `${k}, ${d}h: at most 1% linked (${pct(x.linked, x.n)})`);
  }
  const late = tally[`${k} 72h`];
  check(
    late.guessed / late.n <= 1 / core.CROWD_TARGET,
    `${k}, 72h: best guess right at most 1 in ${core.CROWD_TARGET} (${pct(late.guessed, late.n)})`,
  );
}
check(
  badAdvice === 0,
  `every common amount hides among ${core.CROWD_TARGET}+ parties and adds up to the balance (${badAdvice} bad)`,
);
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
