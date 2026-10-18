import { formatZat } from "@turnstile/core";

export const zec = (zat: number): string => `${formatZat(zat)} ZEC`;

export const percent = (rate: number, digits = 1): string => `${(100 * rate).toFixed(digits)}%`;

// The data covers whole UTC days, so its dates are shown in UTC: in Lagos (UTC+1) the last second of
// Oct 16 UTC is already Oct 17 local time.
const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });
const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** Unix seconds -> "Sep 29, 2026" in the viewer's locale, as a UTC day. */
export const day = (t: number): string => dateFmt.format(new Date(t * 1000));

/** Unix seconds -> "Sep 29, 2026, 2:00 PM" in the viewer's time zone. */
export const dateTime = (t: number): string => dateTimeFmt.format(new Date(t * 1000));

/** Value for <input type="datetime-local"> in the viewer's time zone. */
export function toLocalInput(t: number): string {
  const d = new Date(t * 1000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** <input type="datetime-local"> value -> unix seconds, or undefined if empty/invalid. */
export function fromLocalInput(value: string): number | undefined {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

export const nowSec = (): number => Math.floor(Date.now() / 1000);
