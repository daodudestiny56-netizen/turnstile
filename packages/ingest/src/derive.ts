import type { TxRecord } from "./types.js";

/**
 * Boundary-event derivation (PRD §7.2).
 *
 * No source's shielded-value field is trusted: Blockchair's `shielded_value_delta` reads 0 for
 * Orchard and Ironwood crossings. Instead each transaction is classified in two independent steps:
 *
 * 1. Structure — does the tx carry shielded components at all? The transparent part of a tx has an
 *    exact serialized size, computable from its script lengths. Whatever the tx has beyond that and
 *    its fixed header is shielded data (a single Sapling output is ~1 KB; an Orchard bundle is
 *    several KB). A tx without shielded data cannot cross the boundary, whatever its fee.
 *
 * 2. Direction and amount — from the transparent side, which every source reports:
 *      gap = transparent inputs − transparent outputs
 *    With shielded data present, gap > 0 means value entered a pool (plus the fee), and gap < 0 or
 *    outputs with no inputs means value left one.
 *
 * Amounts are transparent-side values: a SHIELD's amount includes its fee, a DESHIELD's excludes
 * it. A round trip therefore shows shield amount ≥ deshield amount; the difference is the fees paid
 * along the way, which the matcher allows for.
 */

export type EventKind = "SHIELD" | "DESHIELD";

export type EventTag =
  /** SHIELD funded (at least partly) by coinbase outputs: a miner or pool shielding rewards. */
  | "coinbase"
  /** DESHIELD paying many transparent addresses at once, e.g. a mining-pool payout. */
  | "batch"
  /** DESHIELD that also spent transparent inputs. */
  | "mixed";

export interface DeriveConfig {
  /** Bytes beyond the transparent part and header above which a tx has shielded components. */
  shieldedResidualMin: number;
  /**
   * With shielded components present, a positive gap at or below this is a fee paid from
   * transparent funds, not a shield.
   */
  shieldMinZat: number;
  /** DESHIELDs with at least this many transparent outputs are tagged "batch". */
  batchMinOutputs: number;
}

export const DEFAULT_DERIVE_CONFIG: DeriveConfig = {
  shieldedResidualMin: 200,
  shieldMinZat: 20_000,
  batchMinOutputs: 3,
};

export type Classification =
  | { kind: EventKind; amount: number }
  /** Coinbase txs mint new coins; they are not boundary crossings by a user. */
  | { kind: "COINBASE" }
  /** No shielded components: a transparent-only tx. Its gap is its fee. */
  | { kind: "TRANSPARENT"; gap: number }
  /** Shielded components but no transparent value crossing (fully shielded, or fee-only). */
  | { kind: "SHIELDED_ONLY" }
  /** Some transparent inputs are missing from the data, so structure can't be computed. */
  | { kind: "INCOMPLETE" };

/** Bitcoin-style CompactSize length prefix. */
export function compactSizeBytes(n: number): number {
  if (n < 0xfd) return 1;
  if (n <= 0xffff) return 3;
  if (n <= 0xffffffff) return 5;
  return 9;
}

/**
 * Exact serialized size of a tx's transparent inputs and outputs, including their count prefixes.
 * Input: prevout txid (32) + index (4) + scriptSig + sequence (4). Output: value (8) + script.
 */
export function transparentBytes(
  inputScriptBytes: readonly number[],
  outputScriptBytes: readonly number[],
): number {
  let total =
    compactSizeBytes(inputScriptBytes.length) + compactSizeBytes(outputScriptBytes.length);
  for (const s of inputScriptBytes) total += 40 + compactSizeBytes(s) + s;
  for (const s of outputScriptBytes) total += 8 + compactSizeBytes(s) + s;
  return total;
}

export interface TxContext {
  /** Addresses that funded the tx (from its transparent inputs). */
  inputAddresses: readonly string[];
  /** Whether any transparent input spent a coinbase output. */
  spendsCoinbase: boolean;
  /** Addresses paid by the tx (its transparent outputs). */
  outputAddresses: readonly string[];
  /** scriptSig length of each transparent input found in the data. */
  inputScriptBytes: readonly number[];
  /** Script length of each transparent output found in the data. */
  outputScriptBytes: readonly number[];
}

export type ClassifiableTx = Pick<
  TxRecord,
  "isCoinbase" | "inputCount" | "outputCount" | "inputTotal" | "outputTotal" | "size"
>;

/** Bytes of the tx not accounted for by its transparent inputs and outputs. */
export function residualBytes(tx: ClassifiableTx, context: TxContext): number {
  return tx.size - transparentBytes(context.inputScriptBytes, context.outputScriptBytes);
}

/** Classify one transaction. Pure; no I/O. */
export function classifyTx(
  tx: ClassifiableTx,
  context: TxContext,
  config: DeriveConfig = DEFAULT_DERIVE_CONFIG,
): Classification {
  if (tx.isCoinbase) {
    return { kind: "COINBASE" };
  }
  if (
    context.inputScriptBytes.length !== tx.inputCount ||
    context.outputScriptBytes.length !== tx.outputCount
  ) {
    return { kind: "INCOMPLETE" };
  }
  const gap = tx.inputTotal - tx.outputTotal;
  if (residualBytes(tx, context) <= config.shieldedResidualMin) {
    return { kind: "TRANSPARENT", gap };
  }
  if (tx.inputCount === 0) {
    return tx.outputCount === 0
      ? { kind: "SHIELDED_ONLY" }
      : { kind: "DESHIELD", amount: tx.outputTotal };
  }
  if (gap < 0) {
    return { kind: "DESHIELD", amount: -gap };
  }
  if (gap > config.shieldMinZat) {
    return { kind: "SHIELD", amount: gap };
  }
  return { kind: "SHIELDED_ONLY" };
}

export interface BoundaryEvent {
  txid: string;
  height: number;
  time: number;
  kind: EventKind;
  amount: number;
  /** SHIELD: the funding addresses. DESHIELD: the receiving addresses. Sorted, unique. */
  addresses: string[];
  tags: EventTag[];
  version: number;
  inputCount: number;
  outputCount: number;
  /** The source's own shielded-value claim, kept only to measure how often it is wrong. */
  sourceShieldedDelta: number | null;
}

/** Turn a classified crossing into a boundary event. */
export function toEvent(
  tx: TxRecord,
  context: TxContext,
  crossing: { kind: EventKind; amount: number },
  config: DeriveConfig = DEFAULT_DERIVE_CONFIG,
): BoundaryEvent {
  const { kind, amount } = crossing;
  const tags: EventTag[] = [];
  if (kind === "SHIELD" && context.spendsCoinbase) tags.push("coinbase");
  if (kind === "DESHIELD" && tx.outputCount >= config.batchMinOutputs) tags.push("batch");
  if (kind === "DESHIELD" && tx.inputCount > 0) tags.push("mixed");
  const addresses = kind === "SHIELD" ? context.inputAddresses : context.outputAddresses;
  return {
    txid: tx.hash,
    height: tx.blockHeight,
    time: tx.time,
    kind,
    amount,
    addresses: [...new Set(addresses)].sort(),
    tags,
    version: tx.version,
    inputCount: tx.inputCount,
    outputCount: tx.outputCount,
    sourceShieldedDelta: tx.shieldedValueDelta,
  };
}

/**
 * What the source's shielded-value field implies about the tx, for comparison with ours.
 * Blockchair's sign is the opposite of the protocol's valueBalance: positive = into the pool.
 */
export function sourceImpliedKind(delta: number | null): EventKind | null {
  if (delta === null || delta === 0) return null;
  return delta > 0 ? "SHIELD" : "DESHIELD";
}
