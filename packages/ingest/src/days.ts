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

/** Most days one command may cover (about ten years). */
export const MAX_DAYS = 3_650;

/**
 * The days a command covers, from --from/--to or --days/--to (not both). --days must be a plain
 * whole number from 1 to MAX_DAYS.
 */
export function resolveDayRange(opts: { from?: string; to: string; days?: string }): string[] {
  if (opts.from !== undefined && opts.days !== undefined) {
    throw new RangeError("Use --from or --days, not both");
  }
  let from = opts.from ?? opts.to;
  if (opts.days !== undefined) {
    if (!/^\d+$/.test(opts.days) || Number(opts.days) < 1 || Number(opts.days) > MAX_DAYS) {
      throw new RangeError(
        `--days must be a whole number from 1 to ${MAX_DAYS}, got "${opts.days}"`,
      );
    }
    from = daysBefore(opts.to, Number(opts.days));
  }
  const days = dayRange(from, opts.to);
  if (days.length > MAX_DAYS) throw new RangeError(`A range can cover at most ${MAX_DAYS} days`);
  return days;
}
