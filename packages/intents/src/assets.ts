/**
 * Destinations Turnstile offers, with NEAR Intents asset ids. Built in rather than fetched, so the
 * app makes no request to NEAR Intents until the user clicks Execute. `scripts/verify-intents.mjs`
 * checks every entry against the live /v0/tokens list.
 */

/** ZEC on Zcash: the origin of every Turnstile swap. */
export const ZEC_ASSET_ID = "nep141:zec.omft.near";

export type AddressFormat = "evm" | "solana" | "bitcoin" | "near";

export interface DestinationAsset {
  /** Stable key for forms and the CLI, e.g. "usdc-base". */
  key: string;
  assetId: string;
  symbol: string;
  chain: string;
  decimals: number;
  addressFormat: AddressFormat;
}

export const DESTINATIONS: readonly DestinationAsset[] = [
  {
    key: "usdc-base",
    assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    symbol: "USDC",
    chain: "Base",
    decimals: 6,
    addressFormat: "evm",
  },
  {
    key: "usdc-eth",
    assetId: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
    symbol: "USDC",
    chain: "Ethereum",
    decimals: 6,
    addressFormat: "evm",
  },
  {
    key: "usdc-arb",
    assetId: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    symbol: "USDC",
    chain: "Arbitrum",
    decimals: 6,
    addressFormat: "evm",
  },
  {
    key: "usdc-sol",
    assetId: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    symbol: "USDC",
    chain: "Solana",
    decimals: 6,
    addressFormat: "solana",
  },
  {
    key: "usdt-eth",
    assetId: "nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near",
    symbol: "USDT",
    chain: "Ethereum",
    decimals: 6,
    addressFormat: "evm",
  },
  {
    key: "eth-eth",
    assetId: "nep141:eth.omft.near",
    symbol: "ETH",
    chain: "Ethereum",
    decimals: 18,
    addressFormat: "evm",
  },
  {
    key: "btc-btc",
    assetId: "nep141:btc.omft.near",
    symbol: "BTC",
    chain: "Bitcoin",
    decimals: 8,
    addressFormat: "bitcoin",
  },
  {
    key: "usdc-near",
    assetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    symbol: "USDC",
    chain: "NEAR",
    decimals: 6,
    addressFormat: "near",
  },
];

export function destination(key: string): DestinationAsset {
  const d = DESTINATIONS.find((x) => x.key === key);
  if (!d) {
    throw new RangeError(
      `Unknown destination "${key}". Choose one of: ${DESTINATIONS.map((x) => x.key).join(", ")}`,
    );
  }
  return d;
}

const FORMATS: Record<AddressFormat, { pattern: RegExp; hint: string }> = {
  evm: {
    pattern: /^0x[0-9a-fA-F]{40}$/,
    hint: "an address starting with 0x and 40 hex characters",
  },
  solana: {
    pattern: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
    hint: "a Solana address (32 to 44 characters)",
  },
  bitcoin: {
    pattern: /^(bc1[02-9ac-hj-np-z]{11,71}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/,
    hint: "a Bitcoin address starting with bc1, 1 or 3",
  },
  near: {
    pattern: /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$|^[0-9a-f]{64}$/,
    hint: "a NEAR account such as name.near",
  },
};

/**
 * A quick format check of a recipient before anything is sent, so obvious mistakes never reach
 * NEAR Intents. NEAR Intents validates the address fully when quoting.
 */
export function recipientProblem(asset: DestinationAsset, recipient: string): string | undefined {
  const f = FORMATS[asset.addressFormat];
  return f.pattern.test(recipient.trim())
    ? undefined
    : `A ${asset.symbol} on ${asset.chain} recipient should be ${f.hint}.`;
}

/**
 * Zcash refund address kinds NEAR Intents accepts. Verified live (scripts/verify-intents.mjs):
 * unified, t1, t3 and tex1 are accepted; Sapling (zs) is rejected with "refundTo is not valid".
 */
export function refundKindProblem(kind: string): string | undefined {
  return kind === "sapling"
    ? "NEAR Intents doesn't accept Sapling (zs) refund addresses. Use a unified address (u1) from your wallet: refunds still stay shielded."
    : undefined;
}
