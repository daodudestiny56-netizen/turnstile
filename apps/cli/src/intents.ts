import { writeFileSync } from "node:fs";
import { formatZat, parsePositiveZec, parseRefundAddress, paymentUri } from "@turnstile/core";
import {
  DESTINATIONS,
  OneClickClient,
  destination,
  legQuoteRequest,
  recipientProblem,
  refundKindProblem,
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
  const problem = recipientProblem(asset, opts.recipient);
  if (problem) throw new RangeError(problem);
  const refund = await parseRefundAddress(opts.refund);
  if ("problem" in refund) throw new RangeError(`Refund address: ${refund.problem}`);
  const unsupported = refundKindProblem(refund.kind);
  if (unsupported) throw new RangeError(`Refund address: ${unsupported}`);

  const client = new OneClickClient();
  const res = await client.quote(
    legQuoteRequest({
      amountZat,
      destination: asset,
      recipient: opts.recipient,
      refundTo: opts.refund,
      slippageBps: Number(opts.slippage),
      dry: !opts.live,
    }),
  );
  const q = res.quote;
  console.log(
    `${opts.live ? "Live" : "Dry"} quote: ${formatZat(amountZat)} ZEC -> ${q.amountOutFormatted} ${asset.symbol} on ${asset.chain}`,
  );
  console.log(
    `  at least ${(Number(q.minAmountOut) / 10 ** asset.decimals).toString()} ${asset.symbol} after slippage; about ${Math.round(q.timeEstimate / 60)} min after the deposit confirms`,
  );
  console.log("  NEAR Intents adds 0.25% for requests without an API key; Turnstile adds nothing.");
  if (!refund.shielded) {
    console.log(
      "  Note: refunds would go to a transparent address. A shielded (u1 or zs) refund address keeps them private.",
    );
  }
  if (!opts.live) {
    console.log("\n  No deposit address was created. Add --live to get one.");
    return;
  }
  const address = q.depositAddress;
  if (!address) throw new Error("NEAR Intents returned no deposit address.");
  console.log(`\n  Pay exactly ${formatZat(amountZat)} ZEC to the one-time deposit address`);
  console.log(`    ${address}`);
  console.log(`  Payment request for your wallet (ZIP 321):`);
  console.log(`    ${paymentUri(address, amountZat)}`);
  console.log(`  Deadline: ${q.deadline} (after this the address is inactive)`);
  console.log(`  Track it: turnstile status ${address}`);
  if (opts.save) {
    writeFileSync(opts.save, JSON.stringify(res, null, 2) + "\n");
    console.log(`  Saved the signed quote to ${opts.save}; keep it in case of a dispute.`);
  }
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
