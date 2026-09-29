import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { BlockchairDumpSource, DumpNotFoundError, blockchairDumpUrl } from "./blockchair.js";
import { TX_DESHIELD, TX_SHIELD, line, tempDir, tsv, writeDump } from "./fixtures.test-util.js";
import type { TableName, TableRecord } from "./types.js";

async function records<K extends TableName>(
  source: BlockchairDumpSource,
  table: K,
  day: string,
): Promise<TableRecord[K][]> {
  const out: TableRecord[K][] = [];
  for await (const r of (await source.open(table, day)).records) out.push(r);
  return out;
}

describe("blockchairDumpUrl", () => {
  it("builds the dump URL for a table and day", () => {
    expect(blockchairDumpUrl("transactions", "2026-09-28")).toBe(
      "https://gz.blockchair.com/zcash/transactions/blockchair_zcash_transactions_20260928.tsv.gz",
    );
    expect(blockchairDumpUrl("outputs", "2026-06-01")).toBe(
      "https://gz.blockchair.com/zcash/outputs/blockchair_zcash_outputs_20260601.tsv.gz",
    );
  });

  it("rejects malformed days", () => {
    expect(() => blockchairDumpUrl("inputs", "20260928")).toThrow(RangeError);
  });
});

describe("BlockchairDumpSource parsing", () => {
  it("maps transactions, including nulls, huge values and negative deltas", async () => {
    const cacheDir = tempDir();
    writeDump(
      cacheDir,
      "transactions",
      "2026-09-28",
      tsv("transactions", [TX_SHIELD, TX_DESHIELD]),
    );
    const source = new BlockchairDumpSource({ cacheDir, fetch: vi.fn() });
    const [shield, deshield] = await records(source, "transactions", "2026-09-28");
    expect(shield).toEqual({
      hash: "aa".repeat(32),
      blockHeight: 3498560,
      time: Date.UTC(2026, 8, 28, 0, 1, 32) / 1000,
      version: 5,
      isCoinbase: false,
      inputCount: 2,
      outputCount: 0,
      inputTotal: 77703475,
      outputTotal: 0,
      fee: 10000,
      size: 5230,
      shieldedValueDelta: -77693475,
    });
    expect(deshield?.inputTotal).toBe(0);
    expect(deshield?.outputTotal).toBe(2_100_000_000_000_000);
  });

  it("maps inputs and outputs", async () => {
    const cacheDir = tempDir();
    writeDump(
      cacheDir,
      "inputs",
      "2026-09-28",
      tsv("inputs", [
        {
          spending_transaction_hash: "aa".repeat(32),
          spending_index: "1",
          recipient: "t1PArj5x9tKg8S9okQTdpq5y2EEEFVmaqgQ",
          value: "74551526",
          spending_signature_hex: "00ab",
        },
      ]),
    );
    writeDump(
      cacheDir,
      "outputs",
      "2026-09-28",
      tsv("outputs", [
        {
          transaction_hash: "bb".repeat(32),
          index: "0",
          recipient: "",
          value: "5000000",
          script_hex: "76a914" + "11".repeat(20) + "88ac",
        },
      ]),
    );
    const source = new BlockchairDumpSource({ cacheDir, fetch: vi.fn() });
    expect(await records(source, "inputs", "2026-09-28")).toEqual([
      {
        spendingTxHash: "aa".repeat(32),
        spendingIndex: 1,
        recipient: "t1PArj5x9tKg8S9okQTdpq5y2EEEFVmaqgQ",
        value: 74551526,
        isFromCoinbase: false,
        scriptBytes: 2,
      },
    ]);
    expect(await records(source, "outputs", "2026-09-28")).toEqual([
      {
        txHash: "bb".repeat(32),
        index: 0,
        recipient: null,
        value: 5000000,
        isFromCoinbase: false,
        scriptBytes: 25,
      },
    ]);
  });

  it("reports the file and line of a malformed value", async () => {
    const cacheDir = tempDir();
    writeDump(
      cacheDir,
      "transactions",
      "2026-09-28",
      tsv("transactions", [TX_SHIELD, { ...TX_DESHIELD, fee: "1.5" }]),
    );
    const source = new BlockchairDumpSource({ cacheDir, fetch: vi.fn() });
    await expect(records(source, "transactions", "2026-09-28")).rejects.toThrow(
      /line 3: column fee: expected integer/,
    );
  });

  it("gives the same fingerprint for the same file", async () => {
    const cacheDir = tempDir();
    writeDump(cacheDir, "transactions", "2026-09-28", tsv("transactions", [TX_SHIELD]));
    const source = new BlockchairDumpSource({ cacheDir, fetch: vi.fn() });
    const a = await source.open("transactions", "2026-09-28");
    const b = await source.open("transactions", "2026-09-28");
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(a.fingerprint).toBe(b.fingerprint);
  });
});

describe("BlockchairDumpSource downloading", () => {
  const body = gzipSync(tsv("outputs", []) + line("outputs", { index: "0" }) + "\n");

  it("downloads a missing file once, then serves it from cache", async () => {
    const cacheDir = tempDir();
    const fetch = vi.fn(async () => new Response(body));
    const onDownload = vi.fn();
    const source = new BlockchairDumpSource({ cacheDir, fetch, onDownload });
    await records(source, "outputs", "2026-09-28");
    await records(source, "outputs", "2026-09-28");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(blockchairDumpUrl("outputs", "2026-09-28"));
    expect(onDownload).toHaveBeenCalledWith(expect.any(String), body.length);
  });

  it("retries transient failures", async () => {
    const cacheDir = tempDir();
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response(body));
    const source = new BlockchairDumpSource({ cacheDir, fetch, retryDelayMs: 1 });
    expect(await records(source, "outputs", "2026-09-28")).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("waits out Blockchair's one-download-at-a-time 402 and explains it if it persists", async () => {
    const cacheDir = tempDir();
    const busyThenOk = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 402 }))
      .mockResolvedValueOnce(new Response(body));
    const ok = new BlockchairDumpSource({ cacheDir, fetch: busyThenOk, retryDelayMs: 1 });
    expect(await records(ok, "outputs", "2026-09-28")).toHaveLength(1);

    const alwaysBusy = vi.fn(async () => new Response("", { status: 402 }));
    const busy = new BlockchairDumpSource({
      cacheDir: tempDir(),
      fetch: alwaysBusy,
      attempts: 2,
      retryDelayMs: 1,
    });
    await expect(busy.open("outputs", "2026-09-28")).rejects.toThrow(/one free download at a time/);
  });

  it("rejects a truncated download", async () => {
    const cacheDir = tempDir();
    const fetch = vi.fn(
      async () => new Response(body, { headers: { "content-length": String(body.length + 10) } }),
    );
    const source = new BlockchairDumpSource({ cacheDir, fetch, attempts: 1 });
    await expect(source.open("outputs", "2026-09-28")).rejects.toThrow(/Truncated download/);
    expect(readdirSync(join(cacheDir, "outputs"))).toEqual([]);
  });

  it("does not retry a 404 and leaves no partial file behind", async () => {
    const cacheDir = tempDir();
    const fetch = vi.fn(async () => new Response("nope", { status: 404 }));
    const source = new BlockchairDumpSource({ cacheDir, fetch, retryDelayMs: 1 });
    await expect(source.open("outputs", "2026-09-30")).rejects.toThrow(DumpNotFoundError);
    expect(fetch).toHaveBeenCalledTimes(1);
    const dir = join(cacheDir, "outputs");
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it("gives up after the configured attempts", async () => {
    const cacheDir = tempDir();
    const fetch = vi.fn(async () => new Response("err", { status: 500 }));
    const source = new BlockchairDumpSource({ cacheDir, fetch, attempts: 3, retryDelayMs: 1 });
    await expect(source.open("outputs", "2026-09-28")).rejects.toThrow(/HTTP 500/);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
