import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { blockchairFileName } from "./blockchair.js";
import type { TableName } from "./types.js";

/** Real Blockchair headers (copied from the 2026-09-28 dumps). */
export const HEADERS: Record<TableName, string[]> = {
  transactions:
    "block_id hash time size is_overwintered version version_group_id expiry_height lock_time is_coinbase input_count output_count input_total input_total_usd output_total output_total_usd fee fee_usd fee_per_kb fee_per_kb_usd cdd_total shielded_value_delta join_split_raw shielded_input_raw shielded_output_raw binding_signature".split(
      " ",
    ),
  inputs:
    "block_id transaction_hash index time value value_usd recipient type script_hex is_from_coinbase is_spendable spending_block_id spending_transaction_hash spending_index spending_time spending_value_usd spending_sequence spending_signature_hex lifespan cdd".split(
      " ",
    ),
  outputs:
    "block_id transaction_hash index time value value_usd recipient type script_hex is_from_coinbase is_spendable".split(
      " ",
    ),
};

/** Build one TSV line from a partial column map; unspecified columns get "0". */
export function line(table: TableName, values: Record<string, string>): string {
  return HEADERS[table].map((col) => values[col] ?? "0").join("\t");
}

export function tsv(table: TableName, rows: Record<string, string>[]): string {
  return [HEADERS[table].join("\t"), ...rows.map((r) => line(table, r))].join("\n") + "\n";
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "turnstile-test-"));
}

/** Write a gzipped dump into a cache dir exactly where BlockchairDumpSource looks for it. */
export function writeDump(cacheDir: string, table: TableName, day: string, content: string): void {
  mkdirSync(join(cacheDir, table), { recursive: true });
  writeFileSync(join(cacheDir, table, blockchairFileName(table, day)), gzipSync(content));
}

export const TX_SHIELD = {
  block_id: "3498560",
  hash: "aa".repeat(32),
  time: "2026-09-28 00:01:32",
  version: "5",
  is_coinbase: "0",
  input_count: "2",
  output_count: "0",
  input_total: "77703475",
  output_total: "0",
  fee: "10000",
  shielded_value_delta: "-77693475",
};

export const TX_DESHIELD = {
  block_id: "3498561",
  hash: "bb".repeat(32),
  time: "2026-09-28 00:03:00",
  version: "6",
  is_coinbase: "0",
  input_count: "0",
  output_count: "1",
  input_total: "\\N",
  output_total: "2100000000000000",
  fee: "0",
  shielded_value_delta: "0",
};
