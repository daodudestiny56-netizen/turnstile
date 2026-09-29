/** Zatoshi per ZEC. All amounts inside Turnstile are integer zatoshi. */
export const ZAT_PER_ZEC = 100_000_000;

/** Largest possible amount: the 21M ZEC supply cap, safely below Number.MAX_SAFE_INTEGER. */
export const MAX_ZAT = 21_000_000 * ZAT_PER_ZEC;

const ZEC_PATTERN = /^(\d+)(?:\.(\d{1,8}))?$/;

/**
 * Parse a decimal ZEC string ("3.1742") into integer zatoshi without floating-point error.
 * Throws on anything that isn't a plain non-negative decimal with at most 8 fractional digits.
 */
export function zecToZat(zec: string): number {
  const match = ZEC_PATTERN.exec(zec.trim());
  if (!match) {
    throw new RangeError(`Invalid ZEC amount: "${zec}"`);
  }
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(8, "0"));
  const zat = whole * ZAT_PER_ZEC + fraction;
  if (zat > MAX_ZAT) {
    throw new RangeError(`ZEC amount exceeds total supply: "${zec}"`);
  }
  return zat;
}

/** Format integer zatoshi as a ZEC string with trailing zeros removed ("317420000" -> "3.1742"). */
export function formatZat(zat: number): string {
  if (!Number.isSafeInteger(zat) || zat < 0) {
    throw new RangeError(`Invalid zatoshi amount: ${zat}`);
  }
  const whole = Math.floor(zat / ZAT_PER_ZEC);
  const fraction = String(zat % ZAT_PER_ZEC)
    .padStart(8, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}
