// Stress and fuzz test of @turnstile/core against the real snapshot. Every public function gets
// thousands of random and hostile inputs; each call must either return a result that satisfies the
// function's invariants or throw one of its documented errors, within a time limit. Nothing may
// crash with an unexpected error, hang, or return NaN.
//
//   node scripts/stress-core.mjs [iterations=2000] [seed=7] [dir=data/snapshot] [db=data/turnstile.sqlite]
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const [itArg = "2000", seedArg = "7", dir = "data/snapshot", dbPath = "data/turnstile.sqlite"] =
  process.argv.slice(2);
const N = Number(itArg);
const core = await import(pathToFileURL(resolve("packages/core/dist/index.js")).href);
const read = (n) => new Uint8Array(readFileSync(join(dir, n)));
const manifest = core.parseManifest(readFileSync(join(dir, "manifest.json"), "utf8"));
const bundle = await core.loadSnapshot(manifest, {
  snapshot: read("snapshot.bin.gz"),
  addresses: read("addresses.bin"),
  stats: read("stats.json"),
});
const audit = await core.loadAudit(manifest, read("audit.bin.gz"), bundle.data);
const ctx = core.createPreflightContext(bundle.data, bundle.addresses);
const { dataFrom, dataTo } = bundle.data;
const rand = core.seededRandom(Number(seedArg));
const pick = (xs) => xs[Math.floor(rand() * xs.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const db = new DatabaseSync(dbPath, { readOnly: true });
const realAddresses = [
  ...new Set(
    db
      .prepare("SELECT addresses FROM events WHERE day >= ? AND day <= ? LIMIT 20000")
      .all(manifest.fromDay, manifest.toDay)
      .flatMap((r) => JSON.parse(r.addresses)),
  ),
];
db.close();

const failures = [];
let calls = 0;
const slowest = {};
const VERDICTS = new Set(["red", "amber", "green"]);

/** Run fn; it must return (checked by `ok`) or throw an error whose name is in `allowed`. */
async function probe(name, input, fn, ok, allowed = [], limitMs = 2000) {
  calls++;
  const started = performance.now();
  let result;
  try {
    result = await fn();
  } catch (e) {
    const ms = performance.now() - started;
    slowest[name] = Math.max(slowest[name] ?? 0, ms);
    if (!allowed.includes(e?.name))
      failures.push(`${name}(${JSON.stringify(input)}): unexpected ${e?.name}: ${e?.message}`);
    // The message may echo the input back; only the rest of it must be clear.
    else if (!e.message || /undefined|NaN|\[object/.test(e.message.split(String(input)).join("")))
      failures.push(`${name}(${JSON.stringify(input)}): unclear message "${e.message}"`);
    return;
  }
  const ms = performance.now() - started;
  slowest[name] = Math.max(slowest[name] ?? 0, ms);
  if (ms > limitMs) failures.push(`${name}(${JSON.stringify(input)}): took ${ms.toFixed(0)} ms`);
  const problem = ok(result);
  if (problem) failures.push(`${name}(${JSON.stringify(input)}): ${problem}`);
  if (problem && process.env.STRESS_DEBUG) console.log("DEBUG", withoutAddresses(result));
  // Real addresses can contain "NaN" or long digit runs; scan everything but them.
  const text = withoutAddresses(result);
  if (
    /NaN|undefined ZEC|Infinity/.test(text) ||
    /:null[,}]/.test(text.replace(/"(amountOut|matchedDeposit)":null/g, ""))
  )
    failures.push(`${name}(${JSON.stringify(input)}): NaN/undefined/Infinity in result`);
}

/** The result as JSON, without fields that hold addresses (typed or real). */
function withoutAddresses(result) {
  return JSON.stringify(result ?? null, (k, v) =>
    k === "input" || k === "address" || k === "addresses" || k === "transparent" ? undefined : v,
  );
}

/* ----- Hostile strings ----- */
const UNICODE = [
  "\u00a0",
  "\u200b",
  "١",
  "１",
  "−",
  "\ufeff",
  "e",
  "E",
  "+",
  "-",
  ",",
  ".",
  "..",
  " ",
  "\t",
  "\n",
  "0x",
  "Infinity",
  "NaN",
  "1e3",
  "١٢",
  "𝟏",
];
function hostileAmount() {
  const r = rand();
  if (r < 0.25)
    return pick([
      "",
      " ",
      ".",
      "0",
      "00",
      "-0",
      "0.000000001",
      "21000001",
      "20999999.99999999",
      "1e2",
      "1,5",
      "1.5.5",
      "Infinity",
      "NaN",
      "0x10",
      "  2.5  ",
      ".5",
      "2.",
      "9".repeat(400),
      "1" + "0".repeat(30),
      "0." + "0".repeat(300) + "1",
    ]);
  if (r < 0.5)
    return Array.from({ length: int(1, 12) }, () =>
      pick(UNICODE.concat(["1", "2", "9", "0"])),
    ).join("");
  if (r < 0.8) return (rand() * 10 ** int(-8, 8)).toFixed(int(0, 10));
  return String(int(1, 2_100_000_000_000_000) / 1e8);
}
function hostileAddress() {
  const r = rand();
  if (r < 0.3) {
    const a = pick(realAddresses);
    if (rand() < 0.5) return a;
    const i = int(0, a.length - 1);
    return a.slice(0, i) + pick(["1", "x", "0", "O", "l", "", "\u200b", " "]) + a.slice(i + 1);
  }
  if (r < 0.5)
    return pick([
      "",
      " ",
      "t1",
      "t3",
      "tex1",
      "u1",
      "zs1",
      "t1" + "1".repeat(200),
      "TEX1ABC",
      "t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC",
      "tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte",
      "<script>alert(1)</script>",
      "../../etc/passwd",
      "t1\u0000",
    ]);
  return Array.from({ length: int(0, 120) }, () => String.fromCharCode(int(32, 0x2fff))).join("");
}

/* ----- 1. Amount parsing ----- */
for (let i = 0; i < N; i++) {
  const s = hostileAmount();
  await probe(
    "zecToZat",
    s,
    () => core.zecToZat(s),
    (z) => (Number.isSafeInteger(z) && z >= 0 && z <= core.MAX_ZAT ? undefined : `returned ${z}`),
    ["RangeError", "Error", "TypeError"].filter((n) => n !== "TypeError"),
  );
}

/* ----- 2. Address parsing ----- */
for (let i = 0; i < N; i++) {
  const s = hostileAddress();
  await probe(
    "parseAddress",
    s,
    () => core.parseAddress(s),
    (p) => {
      if (!p || typeof p !== "object") return "no result";
      if (p.transparent && !/^t[13][1-9A-HJ-NP-Za-km-z]{33}$/.test(p.transparent))
        return `bad transparent ${p.transparent}`;
      if (!p.transparent && p.kind !== "unified" && p.kind !== "sapling" && !p.problem)
        return "invalid without a problem";
      return undefined;
    },
  );
  await probe(
    "parseRefundAddress",
    s,
    () => core.parseRefundAddress(s),
    (p) => (p && typeof p === "object" ? undefined : "no result"),
  );
}

/* ----- 3. Pre-flight Check ----- */
const T_LO = dataFrom - 10 * 86_400;
const T_HI = dataTo + 30 * 86_400;
for (let i = 0; i < N; i++) {
  const amount = pick([
    1,
    5_000,
    int(1, 1e6),
    int(1e6, 1e10),
    int(1e10, 2.1e15),
    100_000_000,
    2_100_000_000_000_000,
  ]);
  const time = int(T_LO, T_HI);
  const own =
    rand() < 0.5
      ? {
          amount: amount + pick([0, 10_000, 15_000, 30_000, int(0, 300_000)]),
          time: time - int(-3600, 14 * 86400),
        }
      : undefined;
  const destination = rand() < 0.3 ? hostileAddress() : undefined;
  const input = { amount, time, own, destination };
  await probe(
    "preflight",
    input,
    () =>
      core.preflight(
        ctx,
        { amount, time, ...(destination !== undefined ? { destination } : {}) },
        own,
      ),
    (r) => {
      if (!VERDICTS.has(r.verdict)) return `verdict ${r.verdict}`;
      if (!r.reasons.length) return "no reasons";
      if (!Number.isInteger(r.crowd) || r.crowd < 0) return `crowd ${r.crowd}`;
      if (r.suggestedAmount !== undefined && !(r.suggestedAmount > 0 && r.suggestedAmount < amount))
        return `suggested ${r.suggestedAmount} for ${amount}`;
      const worst = r.reasons.some((x) => x.severity === "red")
        ? "red"
        : r.reasons.some((x) => x.severity === "amber")
          ? "amber"
          : "green";
      return worst === r.verdict ? undefined : `verdict ${r.verdict} but worst reason ${worst}`;
    },
    ["PreflightRangeError"],
  );
}
// Invalid amounts are refused, not computed.
for (const amount of [0, -1, 1.5, NaN, Infinity, 2 ** 60]) {
  await probe(
    "preflight-bad",
    amount,
    () => core.preflight(ctx, { amount, time: dataTo - 3600 }),
    () => "accepted a bad amount",
    ["PreflightRangeError"],
  );
}

/* ----- 4. Exit Planner ----- */
for (let i = 0; i < Math.ceil(N / 4); i++) {
  const total = pick([1, int(1, 1e7), int(1e7, 1e10), int(1e10, 1e13), 2_100_000_000_000_000]);
  const opts = {
    total,
    start: int(dataTo - 10 * 86400, dataTo + 5 * 86400),
    horizonHours: pick([1, 24, 48, 72, 120, 720]),
    maxLegs: pick([1, 2, 4, 8]),
    seed: int(1, 2 ** 31 - 1),
    ...(rand() < 0.5
      ? { own: { amount: total + 30_000, time: dataTo - int(3600, 6 * 86400) } }
      : {}),
  };
  await probe(
    "planExit",
    opts,
    () => core.planExit(ctx, opts),
    (p) => {
      const sum = p.legs.reduce((s, l) => s + l.amount, 0);
      if (sum !== p.withdrawn) return "legs don't sum to withdrawn";
      if (p.withdrawn + p.remainder !== total) return "withdrawn + remainder != total";
      if (p.legs.length > opts.maxLegs) return "too many legs";
      if (p.legs.some((l) => l.time < opts.start || l.time > opts.start + opts.horizonHours * 3600))
        return "leg outside the horizon";
      if (
        core.linkedSums(
          p.legs.map((l) => l.amount),
          total,
          opts.own,
          ctx.params,
        ).length
      )
        return "legs sum to the deposit";
      const ics = core.planToIcs(p);
      if (ics.split("\r\n").some((line) => new TextEncoder().encode(line).length > 75))
        return "ics line over 75 octets";
      return undefined;
    },
    ["RangeError", "PreflightRangeError"],
    5000,
  );
}

/* ----- 5. Entry Planner ----- */
for (let i = 0; i < N; i++) {
  const balance = pick([1, 15_000, 15_001, int(1, 1e6), int(1e6, 1e10), int(1e10, 2.1e15)]);
  const time = int(T_LO, T_HI);
  await probe(
    "planEntry",
    { balance, time },
    () => core.planEntry(ctx, { balance, time }),
    (a) => {
      if (!VERDICTS.has(a.verdict)) return `verdict ${a.verdict}`;
      if (
        a.common &&
        (a.common.amount + core.SHIELD_FEE_ZAT + a.common.keepTransparent !== balance ||
          a.common.keepTransparent < 0)
      )
        return "common amount doesn't add up";
      if (a.common && a.common.crowd < core.CROWD_TARGET)
        return "common amount below the crowd target";
      if (!a.advice.length) return "no advice";
      return undefined;
    },
    ["PreflightRangeError"],
  );
}

/* ----- 6. Personal Audit ----- */
const exitFacts = new Set(bundle.data.exits.flatMap((e) => [String(e.amount), String(e.time)]));
for (let i = 0; i < Math.ceil(N / 4); i++) {
  const inputs = Array.from({ length: int(0, 12) }, () =>
    rand() < 0.7 ? pick(realAddresses) : hostileAddress(),
  );
  await probe(
    "auditAddresses",
    inputs.length,
    () => core.auditAddresses(ctx, audit, inputs),
    (r) => {
      if (!VERDICTS.has(r.verdict)) return `verdict ${r.verdict}`;
      if (r.withdrawals.length > core.AUDIT_MAX_EVENTS || r.deposits.length > core.AUDIT_MAX_EVENTS)
        return "over the event cap";
      // Privacy: any withdrawal time or amount in the result must belong to a withdrawal to an entered
      // address, or to the linked deposit of one.
      const own = new Set([
        ...r.withdrawals.flatMap((w) => [
          String(w.amount),
          String(w.time),
          ...(w.linkedDeposit
            ? [String(w.linkedDeposit.amount), String(w.linkedDeposit.time)]
            : []),
        ]),
        ...r.deposits.flatMap((d) => [String(d.amount), String(d.time)]),
        String(dataFrom),
        String(dataTo),
      ]);
      // Numeric fields: every withdrawal fact must be the user's own.
      const numbers = [];
      JSON.parse(JSON.stringify(r), (k, v) => {
        if (typeof v === "number" && v >= 100_000) numbers.push(String(v));
        return v;
      });
      const leaked = numbers.filter((n) => exitFacts.has(n) && !own.has(n));
      // Messages: every "X ZEC" they quote must be one of the user's own amounts.
      const quoted = [...JSON.stringify(r).matchAll(/(\d+(?:\.\d+)?) ZEC/g)].map((m) =>
        String(core.zecToZat(m[1])),
      );
      const foreign = quoted.filter((z) => !own.has(z));
      if (foreign.length) return `message quotes an amount that isn't the user's: ${foreign[0]}`;
      return leaked.length ? `possible leak of ${leaked.slice(0, 3).join(",")}` : undefined;
    },
    ["AuditInputError"],
    5000,
  );
}
await probe(
  "audit-too-many",
  51,
  () => core.auditAddresses(ctx, audit, realAddresses.slice(0, 51)),
  () => "accepted 51 addresses",
  ["AuditInputError"],
);

/* ----- 7. Hostile data files ----- */
const snapRaw = await core.gunzip(read("snapshot.bin.gz"));
const auditRaw = await core.gunzip(read("audit.bin.gz"));
function mutate(bytes) {
  const b = Uint8Array.from(bytes);
  const r = rand();
  if (r < 0.3) return b.slice(0, int(0, b.length));
  if (r < 0.6) {
    for (let k = 0; k < int(1, 8); k++) b[int(0, b.length - 1)] = int(0, 255);
    return b;
  }
  if (r < 0.8)
    return Uint8Array.from([
      ...b.slice(0, 5),
      ...Array.from({ length: int(0, 64) }, () => 255),
      ...b.slice(5, 200),
    ]);
  return Uint8Array.from({ length: int(0, 512) }, () => int(0, 255));
}
for (let i = 0; i < Math.ceil(N / 10); i++) {
  const s = mutate(snapRaw);
  await probe(
    "decodeSnapshot",
    s.length,
    () => core.decodeSnapshot(s),
    () => undefined,
    ["SnapshotFormatError"],
    3000,
  );
  const a = mutate(auditRaw);
  await probe(
    "AuditIndex.decode",
    a.length,
    () => core.AuditIndex.decode(a, bundle.data),
    () => undefined,
    ["SnapshotFormatError"],
    3000,
  );
}

const worst = Object.entries(slowest)
  .sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k} ${v.toFixed(0)} ms`)
  .join(", ");
console.log(`${calls} calls, seed ${seedArg}. Slowest single call per function: ${worst}`);
if (failures.length) {
  console.log(`\n${failures.length} problem(s):`);
  for (const f of failures.slice(0, 40)) console.log("  " + f.slice(0, 300));
  process.exit(1);
}
console.log("No crashes, hangs, NaN results or broken invariants.");
