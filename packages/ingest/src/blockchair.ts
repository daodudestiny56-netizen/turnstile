/** Tables published in Blockchair's free daily Zcash dumps. */
export type BlockchairTable = "transactions" | "inputs" | "outputs";

export const BLOCKCHAIR_DUMP_BASE = "https://gz.blockchair.com/zcash";

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** URL of one day's dump, e.g. ("transactions", "2026-09-28") -> .../blockchair_zcash_transactions_20260928.tsv.gz */
export function blockchairDumpUrl(table: BlockchairTable, day: string): string {
  const match = DAY_PATTERN.exec(day);
  if (!match) {
    throw new RangeError(`Day must be YYYY-MM-DD, got "${day}"`);
  }
  const [, y, m, d] = match;
  return `${BLOCKCHAIR_DUMP_BASE}/${table}/blockchair_zcash_${table}_${y}${m}${d}.tsv.gz`;
}
