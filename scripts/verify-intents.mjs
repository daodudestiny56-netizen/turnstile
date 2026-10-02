// Independent check for PRD S7 against the live NEAR Intents 1Click API. Costs nothing: quotes are
// requests for prices and a deposit address; no ZEC is ever sent.
//   1. every built-in destination exists in /v0/tokens with the same decimals
//   2. a dry quote succeeds for every destination, and creates no deposit address
//   3. refund addresses: shielded unified, t1, t3 and tex1 accepted; Sapling (zs) rejected, as
//      Turnstile tells users up front
//   4. a live quote returns a one-time deposit address that is a valid t1 (checksum verified)
//   5. its status is PENDING_DEPOSIT, and the ZIP 321 payment request is well formed
//
//   pnpm build && node scripts/verify-intents.mjs
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const load = (p) => import(pathToFileURL(resolve(p)).href);
const core = await load("packages/core/dist/index.js");
const intents = await load("packages/intents/dist/index.js");

// Placeholders only: nothing is ever paid. The recipient is the example address from NEAR Intents'
// own API documentation; the refund addresses come from official Zcash test vectors.
const RECIPIENTS = {
  evm: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D",
  solana: "13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK",
  bitcoin: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
  near: "turnstile.near",
};
const REFUNDS = {
  "shielded unified (Orchard only)":
    "u1ay3aawlldjrmxqnjf5medr5ma6p3acnet464ht8lmwplq5cd3ugytcmlf96rrmtgwldc75x94qn4n8pgen36y8tywlq6yjk7lkf3fa8wzjrav8z2xpxqnrnmjxh8tmz6jhfh425t7f3vy6p4pd3zmqayq49efl2c4xydc0gszg660q9p",
  Sapling: "zs1mrhc9y7jdh5r9ece8u5khgvj9kg0zgkxzdduyv0whkg7lkcrkx5xqem3e48avjq9wn2rukydkwn",
  t1: "t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC",
  t3: "t3cFfPt1Bcvgez9ZbMBFWeZsskxTkPzGCow",
  tex1: "tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte",
};
const SHIELDED_REFUND = REFUNDS["shielded unified (Orchard only)"];

const client = new intents.OneClickClient();
const pause = () => new Promise((r) => setTimeout(r, 1500));
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};
const quote = (destinationKey, refundTo, dry, amountZat = 100_000_000) => {
  const destination = intents.destination(destinationKey);
  return client.quote(
    intents.legQuoteRequest({
      amountZat,
      destination,
      recipient: RECIPIENTS[destination.addressFormat],
      refundTo,
      dry,
    }),
  );
};

// 1
const tokens = await client.tokens();
const zec = tokens.find((t) => t.assetId === intents.ZEC_ASSET_ID);
const missing = intents.DESTINATIONS.filter(
  (d) => !tokens.some((t) => t.assetId === d.assetId && t.decimals === d.decimals),
);
check(
  zec?.decimals === 8 && missing.length === 0,
  `assets: ZEC and all ${intents.DESTINATIONS.length} destinations listed with matching decimals` +
    (missing.length ? `; missing: ${missing.map((d) => d.key).join(", ")}` : ""),
);

// 2
for (const d of intents.DESTINATIONS) {
  try {
    const res = await quote(d.key, SHIELDED_REFUND, true);
    check(
      Number(res.quote.amountOut) > 0 && res.quote.depositAddress === undefined,
      `dry quote 1 ZEC -> ${res.quote.amountOutFormatted} ${d.symbol} on ${d.chain}, no deposit address`,
    );
  } catch (e) {
    check(false, `dry quote to ${d.key}: ${e.message}`);
  }
  await pause();
}

// 3
for (const [label, address] of Object.entries(REFUNDS)) {
  const expectRejected = label === "Sapling";
  try {
    await quote("usdc-base", address, true);
    check(!expectRejected, `refund to a ${label} address accepted`);
  } catch (e) {
    check(
      expectRejected && /refundTo is not valid/.test(e.message),
      `refund to a ${label} address rejected by NEAR Intents: ${e.message}`,
    );
  }
  await pause();
}
const parsedSapling = await core.parseRefundAddress(REFUNDS.Sapling);
check(
  Boolean(intents.refundKindProblem(parsedSapling.kind)),
  "Turnstile refuses a Sapling refund address before contacting NEAR Intents",
);

// 4-5
const live = await quote("usdc-base", SHIELDED_REFUND, false, 10_000_000);
const deposit = live.quote.depositAddress;
const parsed = deposit ? await core.parseAddress(deposit) : { kind: "none" };
check(
  parsed.kind === "t1",
  `live quote: one-time deposit address ${deposit} is a valid transparent t1 address (checksum verified)`,
);
check(
  Boolean(live.signature) && Date.parse(live.quote.deadline) > Date.now() + 3600e3,
  `live quote is signed by NEAR Intents; deadline ${live.quote.deadline}`,
);
await pause();
const status = await client.status(deposit);
check(status.status === "PENDING_DEPOSIT", `status of the new deposit address: ${status.status}`);
const uri = core.paymentUri(deposit, 10_000_000);
check(uri === `zcash:${deposit}?amount=0.1`, `payment request: ${uri}`);

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
