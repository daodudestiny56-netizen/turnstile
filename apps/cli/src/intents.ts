import { writeFileSync } from "node:fs";
import { formatZat, parsePositiveZec, parseRefundAddress, paymentUri } from "@turnstile/core";
import {
  DESTINATIONS,
  OneClickClient,
  destination,
  formatUnits,
  legQuoteRequest,
  quoteFeeBps,
  recipientProblem,
  refundKindProblem,
  verifyQuote,
} from "@turnstile/intents";

export interface QuoteOptions {
  to: string;
  recipient: string;
  refund: string;
  live?: boolean;
  slippage: string;
  save?: string;
}

export async function quoteCommand(zec: string, opts: QuoteOptions): Promise<void> {
  const amountZat = parsePositiveZec(zec);
  const asset = destination(opts.to);
  const problem = await recipientProblem(asset, opts.recipient);
  if (problem) throw new RangeError(problem);
  const slippageBps = Number(opts.slippage);
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 500) {
    throw new RangeError(
      "--slippage must be a whole number of basis points from 0 to 500 (100 = 1%)",
    );
  }
  const refund = await parseRefundAddress(opts.refund);
  if ("problem" in refund) throw new RangeError(`Refund address: ${refund.problem}`);
  const unsupported = refundKindProblem(refund.kind);
  if (unsupported) throw new RangeError(`Refund address: ${unsupported}`);

  const client = new OneClickClient();
  const request = legQuoteRequest({
    amountZat,
    destination: asset,
    recipient: opts.recipient,
    refundTo: opts.refund,
    slippageBps,
    dry: !opts.live,
  });
  const res = await client.quote(request);
  const wrong = await verifyQuote(request, res);
  if (wrong) throw new Error(`Refusing this quote: ${wrong}`);
  const q = res.quote;
  console.log(
    `${opts.live ? "Live" : "Dry"} quote: ${formatZat(amountZat)} ZEC -> ${q.amountOutFormatted} ${asset.symbol} on ${asset.chain}`,
  );
  console.log(
    `  at least ${formatUnits(q.minAmountOut, asset.decimals)} ${asset.symbol} after slippage; about ${Math.max(1, Math.round(q.timeEstimate / 60))} min after the deposit confirms`,
  );
  if (q.amountInUsd && q.amountOutUsd) {
    console.log(
      `  value in about $${Number(q.amountInUsd).toFixed(2)}, out about $${Number(q.amountOutUsd).toFixed(2)}`,
    );
  }
  console.log(
    `  NEAR Intents' fee on this quote: ${(quoteFeeBps(res) / 100).toFixed(2)}%` +
      (q.refundFee ? `; a refund would cost ${formatZat(Number(q.refundFee))} ZEC` : "") +
      ". Turnstile adds nothing.",
  );
  if (!refund.shielded) {
    console.log(
      "  Note: refunds would go to a transparent address. A shielded (u1 or zs) refund address keeps them private.",
    );
  }
  if (!opts.live) {
    console.log("\n  No deposit address was created. Add --live to get one.");
    return;
  }
  const address = q.depositAddress!;
  console.log(`\n  Pay exactly ${formatZat(amountZat)} ZEC to the one-time deposit address`);
  console.log(`    ${address}`);
  console.log(`  Payment request for your wallet (ZIP 321):`);
  console.log(`    ${paymentUri(address, amountZat)}`);
  console.log(`  Deadline: ${q.deadline} (after this the address is inactive)`);
  console.log(`  Track it: turnstile status ${address}`);
  // A live quote's signature is what settles a dispute, so it is always kept.
  const file = opts.save ?? `turnstile-quote-${address}.json`;
  writeFileSync(file, JSON.stringify(res, null, 2) + "\n");
  console.log(`  Saved the signed quote to ${file}; keep it until the swap is done.`);
}

export async function statusCommand(depositAddress: string): Promise<void> {
  const s = await new OneClickClient().status(depositAddress);
  console.log(`${s.status} (updated ${s.updatedAt})`);
  const d = s.swapDetails;
  if (d?.amountOutFormatted) console.log(`  received: ${d.amountOutFormatted}`);
  if (d?.refundedAmountFormatted && d.refundedAmountFormatted !== "0") {
    console.log(
      `  refunded: ${d.refundedAmountFormatted} ZEC${d.refundReason ? ` (${d.refundReason})` : ""}`,
    );
  }
}

export function destinationsHelp(): string {
  return DESTINATIONS.map((d) => `${d.key} (${d.symbol} on ${d.chain})`).join(", ");
}
