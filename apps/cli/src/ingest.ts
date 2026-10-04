import { BlockchairDumpSource, RawStore, resolveDayRange } from "@turnstile/ingest";

export interface IngestOptions {
  from?: string;
  to: string;
  days?: string;
  db: string;
  cache: string;
  force?: boolean;
}

export async function ingestCommand(opts: IngestOptions): Promise<void> {
  const days = resolveDayRange(opts);
  const source = new BlockchairDumpSource({
    cacheDir: opts.cache,
    onDownload: (url, bytes) =>
      console.log(`  downloaded ${url} (${(bytes / 1024).toFixed(0)} KB)`),
  });
  const store = new RawStore(opts.db);
  const started = performance.now();
  let written = 0;
  let skipped = 0;
  try {
    for (const day of days) {
      const results = await store.ingestDay(source, day, opts.force);
      const summary = results
        .map(
          (r) =>
            `${r.table}=${r.rows}${r.duplicates ? ` (+${r.duplicates} dup)` : ""}${r.skipped ? " (unchanged)" : ""}`,
        )
        .join("  ");
      console.log(`${day}  ${summary}`);
      for (const r of results) {
        if (r.skipped) skipped++;
        else written++;
      }
    }
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.log(
      `\n${days.length} day(s), ${written} table-day(s) written, ${skipped} unchanged, ${seconds}s`,
    );
  } finally {
    store.close();
  }
}

export function countsCommand(opts: { db: string }): void {
  const store = new RawStore(opts.db, { create: false });
  try {
    const counts = store.dayCounts();
    console.log("day         transactions  inputs  outputs");
    for (const c of counts) {
      console.log(
        `${c.day}  ${String(c.transactions).padStart(12)}  ${String(c.inputs).padStart(6)}  ${String(c.outputs).padStart(7)}`,
      );
    }
    const total = counts.reduce(
      (t, c) => ({
        transactions: t.transactions + c.transactions,
        inputs: t.inputs + c.inputs,
        outputs: t.outputs + c.outputs,
      }),
      { transactions: 0, inputs: 0, outputs: 0 },
    );
    console.log(
      `total (${counts.length} days)  transactions=${total.transactions} inputs=${total.inputs} outputs=${total.outputs}`,
    );
  } finally {
    store.close();
  }
}
