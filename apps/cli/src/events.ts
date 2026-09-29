import { formatZat } from "@turnstile/core";
import { EventStore, RawStore, dayRange, daysBefore } from "@turnstile/ingest";

export interface DayRangeOptions {
  from?: string;
  to: string;
  days?: string;
  db: string;
}

function resolveDays(opts: DayRangeOptions): string[] {
  const from = opts.from ?? (opts.days ? daysBefore(opts.to, Number(opts.days)) : opts.to);
  return dayRange(from, opts.to);
}

function pct(part: number, whole: number): string {
  return whole === 0 ? "0.0%" : `${((100 * part) / whole).toFixed(1)}%`;
}

export function deriveCommand(opts: DayRangeOptions): void {
  const days = resolveDays(opts);
  const raw = new RawStore(opts.db);
  try {
    const store = new EventStore(raw.db);
    const started = performance.now();
    let shields = 0;
    let deshields = 0;
    for (const day of days) {
      const r = store.deriveDay(day);
      shields += r.shields;
      deshields += r.deshields;
      console.log(
        `${day}  shields=${r.shields} deshields=${r.deshields} transparent=${r.transparent} ` +
          `shielded-only=${r.shieldedOnly} coinbase=${r.coinbase} incomplete=${r.incomplete}`,
      );
    }
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.log(`\n${days.length} day(s): ${shields} shields, ${deshields} deshields, ${seconds}s`);
  } finally {
    raw.close();
  }
}

export function eventsCommand(opts: DayRangeOptions): void {
  const days = resolveDays(opts);
  const raw = new RawStore(opts.db);
  try {
    const { perDay, source, nonEvents } = new EventStore(raw.db).summary(days);
    console.log(
      "day         shields  deshields  coinbase-shields  batch-deshields  ZEC in    ZEC out",
    );
    const total = { shields: 0, deshields: 0, coinbase: 0, batch: 0, inZat: 0, outZat: 0 };
    for (const d of perDay) {
      console.log(
        `${d.day}  ${String(d.shields).padStart(7)}  ${String(d.deshields).padStart(9)}  ` +
          `${String(d.coinbase_shields).padStart(16)}  ${String(d.batch_deshields).padStart(15)}  ` +
          `${formatZat(d.shield_zat).padStart(8)}  ${formatZat(d.deshield_zat).padStart(8)}`,
      );
      total.shields += d.shields;
      total.deshields += d.deshields;
      total.coinbase += d.coinbase_shields;
      total.batch += d.batch_deshields;
      total.inZat += d.shield_zat;
      total.outZat += d.deshield_zat;
    }
    const events = total.shields + total.deshields;
    console.log(`\nTotals over ${days.length} day(s)`);
    console.log(`  shields            ${total.shields}  (${formatZat(total.inZat)} ZEC)`);
    console.log(`  deshields          ${total.deshields}  (${formatZat(total.outZat)} ZEC)`);
    console.log(
      `  coinbase-funded    ${total.coinbase} of shields (${pct(total.coinbase, total.shields)})`,
    );
    console.log(
      `  batch payouts      ${total.batch} of deshields (${pct(total.batch, total.deshields)})`,
    );
    console.log(
      `  not crossings      transparent=${nonEvents.transparent} shielded-only=${nonEvents.shielded_only} ` +
        `coinbase=${nonEvents.coinbase} incomplete=${nonEvents.incomplete}`,
    );
    console.log(`\nBlockchair shielded_value_delta vs our derivation (${events} crossings)`);
    console.log(`  agrees on direction        ${source.agree}  (${pct(source.agree, events)})`);
    console.log(`  reports no movement        ${source.missed}  (${pct(source.missed, events)})`);
    for (const [v, n] of Object.entries(source.missedByVersion)) {
      console.log(`    of which v${v}              ${n}`);
    }
    console.log(`  reports opposite direction ${source.opposite}`);
    console.log(`  reports movement we don't  ${source.sourceOnly ?? 0}`);
  } finally {
    raw.close();
  }
}
