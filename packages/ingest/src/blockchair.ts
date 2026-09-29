import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { createGunzip } from "node:zlib";
import { parseDay } from "./days.js";
import {
  boolField,
  intField,
  nullableIntField,
  parseTsv,
  stringField,
  timeField,
  totalField,
  type TsvRow,
} from "./tsv.js";
import type {
  DataSource,
  DayTable,
  InputRecord,
  OutputRecord,
  TableName,
  TableRecord,
  TxRecord,
} from "./types.js";

/** Tables published in Blockchair's free daily Zcash dumps. */
export type BlockchairTable = TableName;

export const BLOCKCHAIR_DUMP_BASE = "https://gz.blockchair.com/zcash";

export function blockchairFileName(table: BlockchairTable, day: string): string {
  parseDay(day);
  return `blockchair_zcash_${table}_${day.replaceAll("-", "")}.tsv.gz`;
}

/** URL of one day's dump, e.g. ("transactions", "2026-09-28") -> .../blockchair_zcash_transactions_20260928.tsv.gz */
export function blockchairDumpUrl(table: BlockchairTable, day: string): string {
  return `${BLOCKCHAIR_DUMP_BASE}/${table}/${blockchairFileName(table, day)}`;
}

/** Thrown when Blockchair hasn't published a day yet (or never will). Not retried. */
export class DumpNotFoundError extends Error {
  constructor(readonly url: string) {
    super(`Blockchair has no dump at ${url} (not published yet?)`);
    this.name = "DumpNotFoundError";
  }
}

export interface BlockchairOptions {
  /** Directory holding downloaded .tsv.gz files, laid out as <cacheDir>/<table>/<file>. */
  cacheDir: string;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
  /** Download attempts before giving up on transient errors. */
  attempts?: number;
  /** Base delay between retries; doubles each attempt. */
  retryDelayMs?: number;
  /** Called when a file is actually downloaded (not served from cache). */
  onDownload?: (url: string, bytes: number) => void;
}

/**
 * Statuses Blockchair uses when the free tier is busy. 402 is returned when another download from
 * the same IP is already in progress (observed 2026-09-29); both are retried with backoff.
 */
const BUSY_STATUSES = new Set([402, 429]);

const REQUIRED: { [K in TableName]: readonly string[] } = {
  transactions: [
    "block_id",
    "hash",
    "time",
    "version",
    "is_coinbase",
    "input_count",
    "output_count",
    "input_total",
    "output_total",
    "fee",
    "shielded_value_delta",
  ],
  inputs: ["spending_transaction_hash", "spending_index", "recipient", "value", "is_from_coinbase"],
  outputs: ["transaction_hash", "index", "recipient", "value", "is_from_coinbase"],
};

const MAPPERS: { [K in TableName]: (row: TsvRow) => TableRecord[K] } = {
  transactions: (row): TxRecord => ({
    hash: stringField(row, "hash"),
    blockHeight: intField(row, "block_id"),
    time: timeField(row, "time"),
    version: intField(row, "version"),
    isCoinbase: boolField(row, "is_coinbase"),
    inputCount: intField(row, "input_count"),
    outputCount: intField(row, "output_count"),
    inputTotal: totalField(row, "input_total", "input_count"),
    outputTotal: totalField(row, "output_total", "output_count"),
    fee: intField(row, "fee"),
    shieldedValueDelta: nullableIntField(row, "shielded_value_delta"),
  }),
  inputs: (row): InputRecord => ({
    spendingTxHash: stringField(row, "spending_transaction_hash"),
    spendingIndex: intField(row, "spending_index"),
    recipient: row["recipient"] || null,
    value: intField(row, "value"),
    isFromCoinbase: boolField(row, "is_from_coinbase"),
  }),
  outputs: (row): OutputRecord => ({
    txHash: stringField(row, "transaction_hash"),
    index: intField(row, "index"),
    recipient: row["recipient"] || null,
    value: intField(row, "value"),
    isFromCoinbase: boolField(row, "is_from_coinbase"),
  }),
};

/** Blockchair's free daily dumps, downloaded once into a local cache and parsed from disk. */
export class BlockchairDumpSource implements DataSource {
  readonly name = "blockchair";
  private readonly fetchImpl: typeof fetch;
  private readonly attempts: number;
  private readonly retryDelayMs: number;

  constructor(private readonly options: BlockchairOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    // Busy slots can last a minute or more; 6 attempts at 5s doubling waits ~2.5 min in total.
    this.attempts = options.attempts ?? 6;
    this.retryDelayMs = options.retryDelayMs ?? 5000;
  }

  /** Path of a day's file in the cache, downloading it first if missing. */
  async ensureFile(table: TableName, day: string): Promise<string> {
    const dir = join(this.options.cacheDir, table);
    const path = join(dir, blockchairFileName(table, day));
    if (await nonEmptyFile(path)) {
      return path;
    }
    await mkdir(dir, { recursive: true });
    const url = blockchairDumpUrl(table, day);
    const part = `${path}.part`;
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await this.fetchImpl(url);
        if (res.status === 404) {
          throw new DumpNotFoundError(url);
        }
        if (BUSY_STATUSES.has(res.status)) {
          throw new Error(
            `HTTP ${res.status} for ${url}: Blockchair allows one free download at a time per IP — ` +
              `is another download running?`,
          );
        }
        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status} for ${url}`);
        }
        await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part));
        const expected = Number(res.headers.get("content-length"));
        const actual = (await stat(part)).size;
        if (expected > 0 && actual !== expected) {
          throw new Error(`Truncated download of ${url}: ${actual} of ${expected} bytes`);
        }
        await rename(part, path);
        this.options.onDownload?.(url, (await stat(path)).size);
        return path;
      } catch (err) {
        await rm(part, { force: true });
        if (err instanceof DumpNotFoundError || attempt >= this.attempts) {
          throw err;
        }
        await sleep(this.retryDelayMs * 2 ** (attempt - 1));
      }
    }
  }

  async open<K extends TableName>(table: K, day: string): Promise<DayTable<TableRecord[K]>> {
    const path = await this.ensureFile(table, day);
    const fingerprint = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    return { fingerprint, records: readRecords(path, table) };
  }
}

async function* readRecords<K extends TableName>(
  path: string,
  table: K,
): AsyncGenerator<TableRecord[K]> {
  const lines = createInterface({
    input: createReadStream(path).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  const map = MAPPERS[table];
  let dataLine = 1;
  try {
    for await (const row of parseTsv(lines, REQUIRED[table])) {
      dataLine++;
      try {
        yield map(row);
      } catch (err) {
        throw new Error(`${path} line ${dataLine}: ${(err as Error).message}`, { cause: err });
      }
    }
  } finally {
    lines.close();
  }
}

async function nonEmptyFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).size > 0;
  } catch {
    return false;
  }
}
