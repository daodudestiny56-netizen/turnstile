/** One transaction, normalized from any data source. Amounts are integer zatoshi. */
export interface TxRecord {
  hash: string;
  blockHeight: number;
  /** Block time, unix seconds (UTC). */
  time: number;
  version: number;
  isCoinbase: boolean;
  inputCount: number;
  outputCount: number;
  /** Sum of transparent inputs (0 when there are none). */
  inputTotal: number;
  /** Sum of transparent outputs (0 when there are none). */
  outputTotal: number;
  /** Fee as reported by the source (unreliable for some tx versions — see PRD §2). */
  fee: number;
  /** Serialized size in bytes; used to detect shielded components (see derive.ts). */
  size: number;
  /** Source-reported net shielded flow; kept for comparison only, never trusted. */
  shieldedValueDelta: number | null;
}

/** A transparent input: the previous output being spent, and the tx spending it. */
export interface InputRecord {
  spendingTxHash: string;
  spendingIndex: number;
  /** Address that owned the spent output; null for non-standard scripts. */
  recipient: string | null;
  value: number;
  isFromCoinbase: boolean;
  /** Length of the spending scriptSig in bytes. */
  scriptBytes: number;
}

/** A transparent output. */
export interface OutputRecord {
  txHash: string;
  index: number;
  /** Receiving address; null for non-standard scripts. */
  recipient: string | null;
  value: number;
  isFromCoinbase: boolean;
  /** Length of the output script (scriptPubKey) in bytes. */
  scriptBytes: number;
}

export type TableName = "transactions" | "inputs" | "outputs";

export interface TableRecord {
  transactions: TxRecord;
  inputs: InputRecord;
  outputs: OutputRecord;
}

/** One UTC day of one table from a source. */
export interface DayTable<T> {
  /** Stable content fingerprint (e.g. sha256 of the source file); unchanged data => same fingerprint. */
  fingerprint: string;
  records: AsyncIterable<T>;
}

/**
 * Where chain data comes from. Blockchair dumps today; a Zebra RPC source can implement the same
 * interface later without touching anything downstream.
 */
export interface DataSource {
  readonly name: string;
  open<K extends TableName>(table: K, day: string): Promise<DayTable<TableRecord[K]>>;
}
