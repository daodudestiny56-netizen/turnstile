// Independent check for PRD S2: sample derived events and verify each against a Zcash node's own
// view of the transaction (getrawtransaction, verbose). The node reports every shielded pool's value
// balance directly, so it is ground truth for direction and amount.
//
//   node scripts/verify-events.mjs [perKind=10] [seed=2026]
//
// Uses TURNSTILE_RPC_URL (default: Tatum's free public Zcash endpoint, 5 requests/minute). Only
// public transaction ids are sent.
import { DatabaseSync } from "node:sqlite";

const [perKind = "10", seed = "2026"] = process.argv.slice(2);
const RPC_URL = process.env.TURNSTILE_RPC_URL ?? "https://zcash-mainnet.gateway.tatum.io";
const RPC_SPACING_MS = 13_000;
/** A fee above this would be implausible; it means the derived amount is wrong. */
const MAX_FEE_ZAT = 1_000_000;

const db = new DatabaseSync("data/turnstile.sqlite", { readOnly: true });

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sample(kind, n, rand) {
  const ids = db
    .prepare("SELECT txid FROM events WHERE kind = ? ORDER BY txid")
    .all(kind)
    .map((r) => r.txid);
  const picked = new Set();
  while (picked.size < Math.min(n, ids.length)) picked.add(ids[Math.floor(rand() * ids.length)]);
  return [...picked];
}

async function rpcTx(txid) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getrawtransaction", params: [txid, 1] }),
  });
  const body = await res.json();
  if (!body.result) throw new Error(`RPC error for ${txid}: ${JSON.stringify(body).slice(0, 200)}`);
  return body.result;
}

const rand = mulberry32(Number(seed));
const txids = [
  ...sample("SHIELD", Number(perKind), rand),
  ...sample("DESHIELD", Number(perKind), rand),
];
const getEvent = db.prepare("SELECT * FROM events WHERE txid = ?");
const getRaw = db.prepare("SELECT input_total, output_total FROM raw_transactions WHERE hash = ?");

let pass = 0;
for (const [i, txid] of txids.entries()) {
  if (i > 0) await new Promise((r) => setTimeout(r, RPC_SPACING_MS));
  const e = getEvent.get(txid);
  const raw = getRaw.get(txid);
  const r = await rpcTx(txid);

  // Protocol convention: a pool's valueBalance is positive when value leaves that pool.
  const sprout = (r.vjoinsplit ?? []).reduce(
    (s, js) => s + (js.vpub_newZat ?? 0) - (js.vpub_oldZat ?? 0),
    0,
  );
  const pools = {
    sapling: r.valueBalanceZat ?? 0,
    orchard: r.orchard?.valueBalanceZat ?? 0,
    ironwood: r.ironwood?.valueBalanceZat ?? 0,
    sprout,
  };
  const outOfPools = pools.sapling + pools.orchard + pools.ironwood + pools.sprout;
  const nodeOutputTotal = r.vout.reduce((s, o) => s + o.valueZat, 0);
  const nodeOutAddrs = [...new Set(r.vout.flatMap((o) => o.scriptPubKey?.addresses ?? []))].sort();

  const problems = [];
  if (r.vin.length !== e.input_count) problems.push(`vin ${r.vin.length} != ${e.input_count}`);
  if (nodeOutputTotal !== raw.output_total)
    problems.push(`vout total ${nodeOutputTotal} != ${raw.output_total}`);
  let fee;
  if (e.kind === "SHIELD") {
    // Our amount = transparent in - transparent out = value into pools + fee.
    fee = e.amount + outOfPools;
    if (outOfPools >= 0) problems.push("node shows no value entering a pool");
  } else {
    // Our amount = transparent out - transparent in = value out of pools - fee.
    fee = outOfPools - e.amount;
    if (outOfPools <= 0) problems.push("node shows no value leaving a pool");
    if (JSON.stringify(nodeOutAddrs) !== e.addresses)
      problems.push(`addresses ${JSON.stringify(nodeOutAddrs)} != ${e.addresses}`);
  }
  if (fee < 0 || fee > MAX_FEE_ZAT) problems.push(`implied fee ${fee} out of range`);

  const active = Object.entries(pools)
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const ok = problems.length === 0;
  if (ok) pass++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${e.kind.padEnd(8)} v${e.version} ${txid.slice(0, 16)}  amount=${e.amount}  ` +
      `node: ${active || "no pool movement"}  implied fee=${fee}` +
      (ok ? "" : `  -- ${problems.join("; ")}`),
  );
}
console.log(`\n${pass}/${txids.length} events confirmed by the node`);
process.exitCode = pass === txids.length ? 0 : 1;
