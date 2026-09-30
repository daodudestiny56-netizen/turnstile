/** Zatoshi per ZEC. All amounts inside Turnstile are integer zatoshi. */
export const ZAT_PER_ZEC = 100_000_000;

/** Largest possible amount: the 21M ZEC supply cap, safely below Number.MAX_SAFE_INTEGER. */
export const MAX_ZAT = 21_000_000 * ZAT_PER_ZEC;

/** Whole part, fractional part, or both: "2", "2.5", "2.", ".5". */
const ZEC_PATTERN = /^(\d*)(?:\.(\d*))?$/;

/** Why an amount string was rejected, in words a person can act on. */
function invalidAmount(zec: string): RangeError {
  const s = zec.trim();
  let hint = "expected a number of ZEC such as 2.5";
  if (/^\d*,\d+$/.test(s)) hint = `use a dot for decimals, e.g. ${s.replace(",", ".")}`;
  else if (/^\d*\.\d{9,}$/.test(s)) hint = "ZEC has at most 8 decimal places";
  else if (s.startsWith("-")) hint = "the amount can't be negative";
  return new RangeError(`Invalid ZEC amount "${zec}": ${hint}`);
}

/**
 * Parse a decimal ZEC string ("3.1742", ".5", "2.") into integer zatoshi without floating-point
 * error. Throws on anything that isn't a plain non-negative decimal with at most 8 fractional digits.
 */
export function zecToZat(zec: string): number {
  const match = ZEC_PATTERN.exec(zec.trim());
  const wholePart = match?.[1] ?? "";
  const fractionPart = match?.[2] ?? "";
  if (!match || (wholePart === "" && fractionPart === "") || fractionPart.length > 8) {
    throw invalidAmount(zec);
  }
  const whole = Number(wholePart || "0");
  const fraction = Number(fractionPart.padEnd(8, "0"));
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

/** zecToZat for an amount someone wants to move: it must be more than zero. */
export function parsePositiveZec(zec: string): number {
  const zat = zecToZat(zec);
  if (zat === 0)
    throw new RangeError(`Invalid ZEC amount "${zec}": the amount must be more than 0`);
  return zat;
}
