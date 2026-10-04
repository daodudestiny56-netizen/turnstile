import { parseAddress } from "@turnstile/core";
import { quoteMismatch, type QuoteRequest, type QuoteResponse } from "./client.js";

/**
 * Everything that must hold before a quote is shown, and above all before a deposit address is
 * shown as something to pay: the quote answers the request that was sent (quoteMismatch), and a
 * live quote's deposit address is a valid, checksummed transparent Zcash address.
 */
export async function verifyQuote(
  sent: QuoteRequest,
  got: QuoteResponse,
): Promise<string | undefined> {
  const mismatch = quoteMismatch(sent, got);
  if (mismatch) return mismatch;
  if (sent.dry) return undefined;
  const address = got.quote.depositAddress;
  if (!address) return "NEAR Intents returned no deposit address.";
  const parsed = await parseAddress(address);
  if (parsed.kind !== "t1" && parsed.kind !== "t3") {
    return "NEAR Intents returned a deposit address that isn't a valid transparent Zcash address. Don't pay it.";
  }
  if (got.quote.deadline !== undefined && Number.isNaN(Date.parse(got.quote.deadline))) {
    return "NEAR Intents returned a quote without a valid deadline.";
  }
  return undefined;
}
