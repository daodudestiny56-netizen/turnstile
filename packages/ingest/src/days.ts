const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** Validate a YYYY-MM-DD UTC day and return its midnight timestamp in ms. */
export function parseDay(day: string): number {
  const match = DAY_PATTERN.exec(day);
  const ms = match ? Date.parse(`${day}T00:00:00Z`) : NaN;
  if (!match || Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== day) {
    throw new RangeError(`Day must be a valid YYYY-MM-DD date, got "${day}"`);
  }
  return ms;
}

/** Inclusive list of days from `from` to `to`. */
export function dayRange(from: string, to: string): string[] {
  const start = parseDay(from);
  const end = parseDay(to);
  if (end < start) {
    throw new RangeError(`--to (${to}) is before --from (${from})`);
  }
  const days: string[] = [];
  for (let ms = start; ms <= end; ms += DAY_MS) {
    days.push(new Date(ms).toISOString().slice(0, 10));
  }
  return days;
}

/** The day `n - 1` days before `to`, so that dayRange(daysBefore(to, n), to) has n days. */
export function daysBefore(to: string, n: number): string {
  if (!Number.isInteger(n) || n < 1) {
    throw new RangeError(`Number of days must be a positive integer, got ${n}`);
  }
  return new Date(parseDay(to) - (n - 1) * DAY_MS).toISOString().slice(0, 10);
}
