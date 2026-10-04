// Independent check for PRD S8 (F8 Personal Audit) on the real snapshot bundle and event store.
//   1. the audit file is pinned: altering one byte is refused
//   2. completeness: for sampled real deposits and withdrawals in the store, looking up their
//      address finds them, at the right time and amount
//   3. natural labels (a withdrawal to an address that deposited in the week before): whenever the
//      matcher links the withdrawal to that deposit's entity, auditing the address reports it traced
//   4. an address that only deposited never yields a withdrawal's amount, time or address
//   5. p95 time to audit one address < 500 ms
//
//   node scripts/verify-audit.mjs [dir=data/snapshot] [db=data/turnstile.sqlite]
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const [dir = "data/snapshot", dbPath = "data/turnstile.sqlite"] = process.argv.slice(2);
const core = await import(pathToFileURL(resolve("packages/core/dist/index.js")).href);
const read = (n) => new Uint8Array(readFileSync(join(dir, n)));
const manifest = core.parseManifest(readFileSync(join(dir, "manifest.json"), "utf8"));
const bundle = await core.loadSnapshot(manifest, {
  snapshot: read("snapshot.bin.gz"),
  addresses: read("addresses.bin"),
  stats: read("stats.json"),
});
const auditBytes = read("audit.bin.gz");
const audit = await core.loadAudit(manifest, auditBytes, bundle.data);
const ctx = core.createPreflightContext(bundle.data, bundle.addresses);
const { shields, exits, dataFrom, dataTo } = bundle.data;
const P = ctx.params;
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};
const rand = core.seededRandom(2026);
const sample = (xs, n) => {
  const copy = [...xs];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
};

// 1. Tampering.
const tampered = Uint8Array.from(auditBytes);
tampered[tampered.length >> 1] ^= 1;
let refused = false;
try {
  await core.loadAudit(manifest, tampered, bundle.data);
} catch {
  refused = true;
}
check(
  refused,
  `audit.bin.gz (${(auditBytes.length / 1024).toFixed(0)} KB, ${audit.size} addresses) altered by one byte is refused`,
);

// Events from the store over the snapshot's days.
const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db
  .prepare("SELECT time, kind, amount, addresses, tags FROM events WHERE day >= ? AND day <= ?")
  .all(manifest.fromDay, manifest.toDay)
  .map((r) => ({ ...r, addresses: JSON.parse(r.addresses) }));
const storeShields = rows.filter((r) => r.kind === "SHIELD");
const storeExits = rows.filter((r) => r.kind === "DESHIELD" && !r.tags.includes("batch"));

// 2. Completeness.
let found = 0;
let tried = 0;
for (const [events, list, kind] of [
  [storeShields, shields, "shields"],
  [storeExits, exits, "exits"],
]) {
  for (const e of sample(events, 500)) {
    const a = e.addresses[0];
    const refs = await audit.lookup(a);
    tried++;
    if (refs[kind].some((k) => list[k].time === e.time && list[k].amount === e.amount)) found++;
  }
}
check(
  found === tried,
  `completeness: ${found} of ${tried} sampled deposits and withdrawals found from their address`,
);

// 3. Natural labels.
const scoredFrom = dataFrom + core.historyNeededSec(P);
const shieldsByAddress = new Map();
for (const s of storeShields) {
  for (const a of s.addresses)
    (shieldsByAddress.get(a) ?? shieldsByAddress.set(a, []).get(a)).push(s);
}
const labels = [];
for (const e of storeExits) {
  if (e.time < scoredFrom) continue;
  for (const a of e.addresses) {
    const before = (shieldsByAddress.get(a) ?? []).filter(
      (s) => s.time < e.time && e.time - s.time <= P.windowSec,
    );
    if (before.length) {
      labels.push({ exit: e, address: a });
      break;
    }
  }
}
// Score every label (cheap), then audit all the ones the matcher links plus a random 300 others.
const scored = [];
for (const l of labels) {
  const refs = await audit.lookup(l.address);
  if (refs.shields.length > core.AUDIT_MAX_EVENTS || refs.exits.length > core.AUDIT_MAX_EVENTS)
    continue;
  const label = refs.shields
    .map((k) => shields[k])
    .filter((x) => x.time < l.exit.time && l.exit.time - x.time <= P.windowSec)
    .sort((x, y) => y.time - x.time)[0];
  const score = core.scoreExit(ctx.index, l.exit, P);
  scored.push({ ...l, isRight: score.linkable && score.topEntity === label.entity });
}
const chosen = [
  ...scored.filter((l) => l.isRight),
  ...sample(
    scored.filter((l) => !l.isRight),
    300,
  ),
];
let right = 0;
let rightTraced = 0;
let otherTraced = 0;
const times = [];
for (const { exit, address, isRight } of chosen) {
  const started = performance.now();
  const r = await core.auditAddresses(ctx, audit, [address]);
  times.push(performance.now() - started);
  const w = r.withdrawals.find((x) => x.time === exit.time && x.amount === exit.amount);
  const traced = w?.findings.some((f) => f.code === "traced") ?? false;
  if (isRight) {
    right++;
    if (traced) rightTraced++;
  } else if (traced) otherTraced++;
}
check(
  right > 0 && rightTraced === right,
  `natural labels: ${rightTraced} of ${right} withdrawals the matcher links to the address's own deposit are reported traced ` +
    `(of ${labels.length} labels, ${labels.length - scored.length} skipped for more activity than one audit covers; ` +
    `${otherTraced} of 300 others traced through another deposit of the same owner)`,
);

// 4. Nothing about other people's withdrawals.
const depositOnly = [];
for (const s of sample(storeShields, 3000)) {
  const a = s.addresses[0];
  const refs = await audit.lookup(a);
  if (refs.exits.length === 0 && refs.shields.length <= 20) depositOnly.push(a);
  if (depositOnly.length === 200) break;
}
const exitFacts = new Set(exits.flatMap((e) => [String(e.amount), String(e.time)]));
let leaks = 0;
let followedElsewhere = 0;
const allowedDepositKeys = "addresses,amount,findings,linkedElsewhere,linkedToYours,time,verdict";
for (const a of depositOnly) {
  const r = await core.auditAddresses(ctx, audit, [a]);
  followedElsewhere += r.deposits.filter((d) => d.linkedElsewhere > 0).length;
  const keysOk = r.deposits.every((d) => Object.keys(d).sort().join(",") === allowedDepositKeys);
  const ownFacts = new Set(r.deposits.flatMap((d) => [String(d.amount), String(d.time)]));
  const numbers = JSON.stringify(r).match(/\d{6,}/g) ?? [];
  const foreign = numbers.filter(
    (n) => exitFacts.has(n) && !ownFacts.has(n) && n !== String(dataFrom) && n !== String(dataTo),
  );
  if (r.withdrawals.length > 0 || !keysOk || foreign.length > 0) leaks++;
}
check(
  depositOnly.length === 200 && leaks === 0,
  `${depositOnly.length} deposit-only addresses: no withdrawal amount, time or address in any result ` +
    `(${followedElsewhere} of their deposits are followed elsewhere, reported as a count only)`,
);

// 5. Speed.
times.sort((x, y) => x - y);
const p95 = times[Math.floor(times.length * 0.95)] ?? Infinity;
check(
  p95 < 500,
  `speed: p95 ${p95.toFixed(1)} ms to audit one address (max ${times.at(-1)?.toFixed(1)} ms)`,
);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
