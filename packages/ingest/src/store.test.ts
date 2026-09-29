import { describe, expect, it, vi } from "vitest";
import { BlockchairDumpSource } from "./blockchair.js";
import { TX_DESHIELD, TX_SHIELD, tempDir, tsv, writeDump } from "./fixtures.test-util.js";
import { ConflictingRowError, RawStore } from "./store.js";
import type { DataSource, TableName, TableRecord } from "./types.js";

function sourceWithDay(day: string): { source: BlockchairDumpSource; cacheDir: string } {
  const cacheDir = tempDir();
  writeDump(cacheDir, "transactions", day, tsv("transactions", [TX_SHIELD, TX_DESHIELD]));
  writeDump(
    cacheDir,
    "inputs",
    day,
    tsv("inputs", [
      { spending_transaction_hash: TX_SHIELD.hash, spending_index: "0", value: "1" },
      { spending_transaction_hash: TX_SHIELD.hash, spending_index: "1", value: "2" },
    ]),
  );
  writeDump(
    cacheDir,
    "outputs",
    day,
    tsv("outputs", [{ transaction_hash: TX_DESHIELD.hash, index: "0", value: "3" }]),
  );
  return { source: new BlockchairDumpSource({ cacheDir, fetch: vi.fn() }), cacheDir };
}

function dump(store: RawStore): unknown[] {
  return ["raw_transactions", "raw_inputs", "raw_outputs"].flatMap((t) =>
    store.db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2, 3`).all(),
  );
}

describe("RawStore", () => {
  it("stores every row of every table for a day", async () => {
    const { source } = sourceWithDay("2026-09-28");
    const store = new RawStore(":memory:");
    const results = await store.ingestDay(source, "2026-09-28");
    expect(results.map((r) => [r.table, r.rows, r.skipped])).toEqual([
      ["transactions", 2, false],
      ["inputs", 2, false],
      ["outputs", 1, false],
    ]);
    expect(store.dayCounts()).toEqual([
      { day: "2026-09-28", transactions: 2, inputs: 2, outputs: 1 },
    ]);
    const deshield = store.db
      .prepare("SELECT input_total, output_total FROM raw_transactions WHERE hash = ?")
      .get(TX_DESHIELD.hash);
    expect(deshield).toEqual({ input_total: 0, output_total: 2_100_000_000_000_000 });
  });

  it("is idempotent: re-running skips unchanged days and changes nothing", async () => {
    const { source } = sourceWithDay("2026-09-28");
    const store = new RawStore(":memory:");
    await store.ingestDay(source, "2026-09-28");
    const before = dump(store);
    const again = await store.ingestDay(source, "2026-09-28");
    expect(again.every((r) => r.skipped)).toBe(true);
    expect(dump(store)).toEqual(before);
    const forced = await store.ingestDay(source, "2026-09-28", true);
    expect(forced.every((r) => !r.skipped)).toBe(true);
    expect(dump(store)).toEqual(before);
  });

  it("replaces a day when the source file changes", async () => {
    const { source, cacheDir } = sourceWithDay("2026-09-28");
    const store = new RawStore(":memory:");
    await store.ingestDay(source, "2026-09-28");
    writeDump(cacheDir, "transactions", "2026-09-28", tsv("transactions", [TX_SHIELD]));
    const [tx] = await store.ingestDay(source, "2026-09-28");
    expect(tx).toMatchObject({ rows: 1, skipped: false });
    expect(store.dayCounts()[0]?.transactions).toBe(1);
  });

  it("rolls back a day that fails midway, keeping the previous data", async () => {
    const { source } = sourceWithDay("2026-09-28");
    const store = new RawStore(":memory:");
    await store.ingestDay(source, "2026-09-28");
    const before = dump(store);

    const failing: DataSource = {
      name: "failing",
      async open<K extends TableName>(table: K) {
        async function* records(): AsyncGenerator<TableRecord[K]> {
          for await (const r of (await source.open(table, "2026-09-28")).records) {
            yield r;
            throw new Error("disk on fire");
          }
        }
        return { fingerprint: "different", records: records() };
      },
    };
    await expect(store.ingestTable(failing, "transactions", "2026-09-28")).rejects.toThrow(
      "disk on fire",
    );
    expect(dump(store)).toEqual(before);
  });

  it("drops verbatim duplicate lines and counts them", async () => {
    const cacheDir = tempDir();
    const output = { transaction_hash: TX_DESHIELD.hash, index: "0", value: "3" };
    writeDump(
      cacheDir,
      "outputs",
      "2026-09-28",
      tsv("outputs", [output, output, { ...output, index: "1" }, output]),
    );
    const source = new BlockchairDumpSource({ cacheDir, fetch: vi.fn() });
    const store = new RawStore(":memory:");
    const result = await store.ingestTable(source, "outputs", "2026-09-28");
    expect(result).toMatchObject({ rows: 2, duplicates: 2, skipped: false });
    expect(store.dayCounts()[0]?.outputs).toBe(2);
    const again = await store.ingestTable(source, "outputs", "2026-09-28");
    expect(again).toMatchObject({ rows: 2, duplicates: 2, skipped: true });
  });

  it("rejects two different rows with the same key", async () => {
    const cacheDir = tempDir();
    writeDump(
      cacheDir,
      "transactions",
      "2026-09-28",
      tsv("transactions", [TX_SHIELD, { ...TX_SHIELD, fee: "20000" }]),
    );
    const source = new BlockchairDumpSource({ cacheDir, fetch: vi.fn() });
    const store = new RawStore(":memory:");
    await expect(store.ingestTable(source, "transactions", "2026-09-28")).rejects.toThrow(
      ConflictingRowError,
    );
    expect(store.dayCounts()).toEqual([]);
  });
});
