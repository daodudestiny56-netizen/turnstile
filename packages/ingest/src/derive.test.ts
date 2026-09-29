import { describe, expect, it } from "vitest";
import {
  DEFAULT_DERIVE_CONFIG,
  classifyTx,
  compactSizeBytes,
  residualBytes,
  sourceImpliedKind,
  toEvent,
  transparentBytes,
  type TxContext,
} from "./derive.js";
import type { TxRecord } from "./types.js";

/**
 * Real mainnet transactions (Blockchair dumps, Jul–Sep 2026), reduced to the fields derivation
 * uses. Where noted, the classification was confirmed against a Zcash node's getrawtransaction.
 */
interface Fixture {
  tx: TxRecord;
  context: TxContext;
}

function fixture(
  t: Omit<TxRecord, "blockHeight" | "time" | "fee"> & { fee?: number },
  inS: number[],
  outS: number[],
  extra: Partial<TxContext> = {},
): Fixture {
  return {
    tx: { blockHeight: 3_489_377, time: 1_789_862_648, fee: 0, ...t },
    context: {
      inputAddresses: [],
      outputAddresses: [],
      spendsCoinbase: false,
      inputScriptBytes: inS,
      outputScriptBytes: outS,
      ...extra,
    },
  };
}

const base = { isCoinbase: false, shieldedValueDelta: 0 };

const REAL = {
  /** 988c4f21…: block reward. */
  coinbase: fixture(
    {
      ...base,
      hash: "988c4f21",
      version: 6,
      isCoinbase: true,
      inputCount: 1,
      outputCount: 2,
      inputTotal: 0,
      outputTotal: 138_859_375,
      size: 142,
    },
    [],
    [25, 23],
  ),
  /** 57871268…: plain transparent payment; residual is exactly the v5 header (23 bytes). */
  transparentV5: fixture(
    {
      ...base,
      hash: "57871268",
      version: 5,
      inputCount: 1,
      outputCount: 2,
      inputTotal: 189_937_300,
      outputTotal: 189_927_300,
      size: 384,
    },
    [252],
    [25, 23],
  ),
  /**
   * 0000fb33…: transparent-only but pays a 130,000 zat fee — an amount-only rule calls it a shield.
   * Node: no shielded components at all.
   */
  bigFeeTransparentV4: fixture(
    {
      ...base,
      hash: "0000fb33",
      version: 4,
      inputCount: 9,
      outputCount: 2,
      inputTotal: 89_052_256_456,
      outputTotal: 89_052_126_456,
      size: 1423,
    },
    [107, 106, 106, 107, 106, 106, 106, 107, 106],
    [25, 25],
  ),
  /** fa67322a…: Sapling shield funded by coinbase outputs (a miner shielding rewards). */
  shieldV5Sapling: fixture(
    {
      ...base,
      hash: "fa67322a",
      version: 5,
      inputCount: 4,
      outputCount: 0,
      inputTotal: 502_473_700,
      outputTotal: 0,
      size: 2584,
      shieldedValueDelta: 502_443_700,
    },
    [106, 107, 107, 107],
    [],
    { inputAddresses: ["t1SEgZvXCu3ceE42qrq5pCeSq7HbLjX8NJv"], spendsCoinbase: true },
  ),
  /** 001265ae…: Orchard shield. Node: orchard valueBalance −16,151,699 (+15,000 fee). Blockchair delta: 0. */
  orchardShieldV5: fixture(
    {
      ...base,
      hash: "001265ae",
      version: 5,
      inputCount: 1,
      outputCount: 0,
      inputTotal: 16_166_699,
      outputTotal: 0,
      size: 9312,
    },
    [106],
    [],
    { inputAddresses: ["t1eGzxCMMnQmGutKSdCbNLL1vXZDNG98uA8"] },
  ),
  /** 40a09bb1…: Ironwood (v6) deshield to one address. Blockchair delta: 0. */
  deshieldV6: fixture(
    {
      ...base,
      hash: "40a09bb1",
      version: 6,
      inputCount: 0,
      outputCount: 1,
      inputTotal: 0,
      outputTotal: 69_470_000,
      size: 12_356,
    },
    [],
    [25],
    { outputAddresses: ["t1Nsc8vCso3csJVoyX9YwvfwTuDHbCkZcjJ"] },
  ),
  /** e1718973…: deshield that also spends a transparent input. */
  mixedDeshield: fixture(
    {
      ...base,
      hash: "e1718973",
      version: 6,
      inputCount: 1,
      outputCount: 1,
      inputTotal: 970_000,
      outputTotal: 84_955_000,
      size: 9347,
    },
    [106],
    [25],
    { outputAddresses: ["t1NjDG5xR4p7QQUZSX83zTPV45e9pqYFy3n"] },
  ),
  /** 0927b422…: one shielded tx paying 22 transparent addresses — a payout. */
  batchDeshield: fixture(
    {
      ...base,
      hash: "0927b422",
      version: 6,
      inputCount: 0,
      outputCount: 22,
      inputTotal: 0,
      outputTotal: 2_190_403_533,
      size: 13_066,
    },
    [],
    [25, 25, 25, 23, 25, 23, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25],
  ),
  /** 52befb1d…: fully shielded; nothing visible at the boundary. */
  shieldedOnly: fixture(
    {
      ...base,
      hash: "52befb1d",
      version: 6,
      inputCount: 0,
      outputCount: 0,
      inputTotal: 0,
      outputTotal: 0,
      size: 9166,
    },
    [],
    [],
  ),
};

describe("transparent size accounting", () => {
  it("uses CompactSize prefixes", () => {
    expect(compactSizeBytes(0)).toBe(1);
    expect(compactSizeBytes(252)).toBe(1);
    expect(compactSizeBytes(253)).toBe(3);
    expect(compactSizeBytes(0x10000)).toBe(5);
  });

  it("leaves exactly the fixed header for transparent-only txs (27 v4, 23 v5)", () => {
    // These residuals are what the whole 90-day dataset clusters on, with nothing between 31 and 200.
    expect(residualBytes(REAL.transparentV5.tx, REAL.transparentV5.context)).toBe(23);
    expect(residualBytes(REAL.bigFeeTransparentV4.tx, REAL.bigFeeTransparentV4.context)).toBe(27);
    expect(transparentBytes([], [])).toBe(2);
  });

  it("leaves kilobytes for txs with shielded components", () => {
    expect(residualBytes(REAL.orchardShieldV5.tx, REAL.orchardShieldV5.context)).toBeGreaterThan(
      5000,
    );
  });
});

describe("classifyTx on real transactions", () => {
  it.each([
    ["coinbase", { kind: "COINBASE" }],
    ["transparentV5", { kind: "TRANSPARENT", gap: 10_000 }],
    ["bigFeeTransparentV4", { kind: "TRANSPARENT", gap: 130_000 }],
    ["shieldV5Sapling", { kind: "SHIELD", amount: 502_473_700 }],
    ["orchardShieldV5", { kind: "SHIELD", amount: 16_166_699 }],
    ["deshieldV6", { kind: "DESHIELD", amount: 69_470_000 }],
    ["mixedDeshield", { kind: "DESHIELD", amount: 83_985_000 }],
    ["batchDeshield", { kind: "DESHIELD", amount: 2_190_403_533 }],
    ["shieldedOnly", { kind: "SHIELDED_ONLY" }],
  ] as const)("%s", (name, expected) => {
    const { tx, context } = REAL[name];
    expect(classifyTx(tx, context)).toEqual(expected);
  });

  it("treats a shielded tx whose transparent input only pays the fee as no crossing", () => {
    const { tx, context } = REAL.orchardShieldV5;
    const feeOnly = { ...tx, inputTotal: 15_000 };
    expect(classifyTx(feeOnly, context)).toEqual({ kind: "SHIELDED_ONLY" });
    expect(
      classifyTx({ ...tx, inputTotal: DEFAULT_DERIVE_CONFIG.shieldMinZat + 1 }, context),
    ).toEqual({ kind: "SHIELD", amount: DEFAULT_DERIVE_CONFIG.shieldMinZat + 1 });
  });

  it("refuses to classify when input or output rows are missing", () => {
    const { tx, context } = REAL.mixedDeshield;
    expect(classifyTx(tx, { ...context, inputScriptBytes: [] })).toEqual({ kind: "INCOMPLETE" });
    expect(classifyTx(tx, { ...context, outputScriptBytes: [] })).toEqual({ kind: "INCOMPLETE" });
  });
});

describe("toEvent", () => {
  it("tags coinbase-funded shields and records funding addresses", () => {
    const { tx, context } = REAL.shieldV5Sapling;
    const e = toEvent(tx, context, { kind: "SHIELD", amount: 502_473_700 });
    expect(e.tags).toEqual(["coinbase"]);
    expect(e.addresses).toEqual(["t1SEgZvXCu3ceE42qrq5pCeSq7HbLjX8NJv"]);
    expect(e.sourceShieldedDelta).toBe(502_443_700);
  });

  it("tags batch and mixed deshields and dedupes/sorts addresses", () => {
    const batch = REAL.batchDeshield;
    expect(toEvent(batch.tx, batch.context, { kind: "DESHIELD", amount: 1 }).tags).toEqual([
      "batch",
    ]);
    const mixed = REAL.mixedDeshield;
    const e = toEvent(
      mixed.tx,
      { ...mixed.context, outputAddresses: ["t1b", "t1a", "t1b"] },
      { kind: "DESHIELD", amount: 83_985_000 },
    );
    expect(e.tags).toEqual(["mixed"]);
    expect(e.addresses).toEqual(["t1a", "t1b"]);
  });
});

describe("sourceImpliedKind", () => {
  it("reads Blockchair's sign convention (positive = into the pool)", () => {
    expect(sourceImpliedKind(502_443_700)).toBe("SHIELD");
    expect(sourceImpliedKind(-5)).toBe("DESHIELD");
    expect(sourceImpliedKind(0)).toBeNull();
    expect(sourceImpliedKind(null)).toBeNull();
  });
});
