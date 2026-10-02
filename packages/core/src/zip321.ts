import { formatZat } from "./amount.js";

/**
 * A ZIP 321 payment request for a single payment: `zcash:<address>?amount=<ZEC>`. Wallets such as
 * ZODL (Zashi) open these from a link or a QR code, so Turnstile never handles keys or signing.
 * https://zips.z.cash/zip-0321
 */
export function paymentUri(address: string, amountZat: number): string {
  if (!/^[A-Za-z0-9]+$/.test(address)) throw new RangeError("Invalid payment address");
  if (!Number.isSafeInteger(amountZat) || amountZat <= 0) {
    throw new RangeError("Payment amount must be a positive number of zatoshi");
  }
  return `zcash:${address}?amount=${formatZat(amountZat)}`;
}
