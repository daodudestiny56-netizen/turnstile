import { describe, expect, it } from "vitest";
import {
  BECH32M_CONST,
  bech32Decode,
  bech32mDecode,
  bech32mEncode,
  evmAddressProblem,
  isBitcoinAddress,
  isNearAccount,
  isSolanaAddress,
  parseAddress,
  parseRefundAddress,
  toTex,
} from "./address.js";
import { keccak256 } from "./keccak.js";
import { paymentUri } from "./zip321.js";

// Official test vector from ZIP 320.
const T1 = "t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC";
const TEX = "tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte";

describe("TEX addresses (ZIP 320)", () => {
  it("converts the ZIP 320 test vector both ways", async () => {
    expect(await parseAddress(TEX)).toEqual({ kind: "tex", transparent: T1 });
    expect(await toTex(T1)).toBe(TEX);
  });

  it("accepts upper case and surrounding spaces, rejects a typo", async () => {
    expect((await parseAddress(`  ${TEX.toUpperCase()} `)).transparent).toBe(T1);
    const typo = TEX.slice(0, -1) + (TEX.endsWith("e") ? "f" : "e");
    expect((await parseAddress(typo)).kind).toBe("invalid");
  });

  it("round-trips arbitrary payloads through Bech32m", () => {
    const bytes = new Uint8Array(Array.from({ length: 20 }, (_, i) => (i * 37 + 11) & 255));
    const s = bech32mEncode("tex", bytes);
    expect(bech32mDecode(s)).toEqual({ hrp: "tex", bytes });
  });
});

describe("transparent addresses", () => {
  it("accepts a valid t1 and a real t3 from the chain", async () => {
    expect(await parseAddress(T1)).toEqual({ kind: "t1", transparent: T1 });
    const t3 = "t3cFfPt1Bcvgez9ZbMBFWeZsskxTkPzGCow"; // a coinbase output in the Sep 2026 data
    expect(await parseAddress(t3)).toEqual({ kind: "t3", transparent: t3 });
  });

  it("catches a mistyped character through the checksum", async () => {
    const typo = T1.slice(0, 10) + (T1[10] === "a" ? "b" : "a") + T1.slice(11);
    const r = await parseAddress(typo);
    expect(r.kind).toBe("invalid");
    expect(r.problem).toMatch(/checksum/);
  });

  it("explains shielded, testnet and unrecognised input", async () => {
    expect((await parseAddress("zs1abc")).kind).toBe("shielded");
    expect((await parseAddress("u1qqqq")).problem).toMatch(/keeps the funds shielded/);
    expect((await parseAddress("tmBsTi2xWTjUdEXnuTceL7fecEQKeWaPDJd")).kind).toBe("testnet");
    expect((await parseAddress("hello")).problem).toMatch(/start with t1, t3 or tex1/);
  });
});

describe("Bech32 and Bech32m against the BIP test vectors", () => {
  // Valid checksums from BIP 173 (Bech32) and BIP 350 (Bech32m).
  const BIP173 = [
    "A12UEL5L",
    "a12uel5l",
    "an83characterlonghumanreadablepartthatcontainsthenumber1andtheexcludedcharactersbio1tt5tgs",
    "abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw",
    "split1checkupstagehandshakeupstreamerranterredcaperred2y9e3w",
  ];
  const BIP350 = [
    "A1LQFN3A",
    "a1lqfn3a",
    "an83characterlonghumanreadablepartthatcontainsthetheexcludedcharactersbioandnumber11sg7hg6",
    "abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryx",
    "split1checkupstagehandshakeupstreamerranterredcaperredlc445v",
  ];

  it("accepts each with its own checksum and rejects it with the other", () => {
    for (const v of BIP173) {
      expect(bech32Decode(v, 1), v).toBeDefined();
      expect(bech32Decode(v, BECH32M_CONST), v).toBeUndefined();
    }
    for (const v of BIP350) {
      expect(bech32Decode(v, BECH32M_CONST), v).toBeDefined();
      expect(bech32Decode(v, 1), v).toBeUndefined();
    }
  });
});

describe("refund addresses", () => {
  // From the official zcash-test-vectors unified_address.json: one Orchard-only, one with a
  // transparent receiver.
  const UA_SHIELDED =
    "u1ay3aawlldjrmxqnjf5medr5ma6p3acnet464ht8lmwplq5cd3ugytcmlf96rrmtgwldc75x94qn4n8pgen36y8tywlq6yjk7lkf3fa8wzjrav8z2xpxqnrnmjxh8tmz6jhfh425t7f3vy6p4pd3zmqayq49efl2c4xydc0gszg660q9p";
  // The Sapling raw address from the same test vectors, Bech32-encoded with hrp "zs".
  const SAPLING = "zs1mrhc9y7jdh5r9ece8u5khgvj9kg0zgkxzdduyv0whkg7lkcrkx5xqem3e48avjq9wn2rukydkwn";

  it("accepts shielded refund addresses and marks them shielded", async () => {
    expect(await parseRefundAddress(UA_SHIELDED)).toEqual({ kind: "unified", shielded: true });
    expect(await parseRefundAddress(SAPLING)).toEqual({ kind: "sapling", shielded: true });
  });

  it("accepts transparent ones, marked not shielded", async () => {
    expect(await parseRefundAddress(T1)).toEqual({ kind: "t1", shielded: false });
    expect(await parseRefundAddress(TEX)).toEqual({ kind: "tex", shielded: false });
  });

  it("rejects typos and testnet addresses", async () => {
    expect(await parseRefundAddress(UA_SHIELDED.slice(0, -1) + "q")).toHaveProperty("problem");
    expect(await parseRefundAddress(SAPLING.slice(0, -1) + "q")).toHaveProperty("problem");
    expect(await parseRefundAddress("tmBsTi2xWTjUdEXnuTceL7fecEQKeWaPDJd")).toEqual({
      problem: "This is a testnet address; Turnstile checks mainnet.",
    });
  });
});

describe("ZIP 321 payment requests", () => {
  it("builds a single-payment URI with the amount in ZEC", () => {
    expect(paymentUri("t1SomavgTfca4NCk6HSgwdvwhUQxKMjKrNB", 10_000_000)).toBe(
      "zcash:t1SomavgTfca4NCk6HSgwdvwhUQxKMjKrNB?amount=0.1",
    );
    expect(paymentUri(T1, 123_456_789)).toBe(`zcash:${T1}?amount=1.23456789`);
  });

  it("refuses a bad address or amount", () => {
    expect(() => paymentUri("t1 bad", 1)).toThrow(RangeError);
    expect(() => paymentUri(T1, 0)).toThrow(RangeError);
  });
});

describe("hostile input", () => {
  it("rejects absurdly long input at once instead of decoding it", async () => {
    const started = performance.now();
    expect((await parseAddress("t1" + "z".repeat(50_000))).kind).toBe("invalid");
    expect((await parseAddress("u1" + "q".repeat(50_000))).kind).toBe("invalid");
    expect("problem" in (await parseRefundAddress("t1" + "z".repeat(50_000)))).toBe(true);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("ignores zero-width characters pasted with an address", async () => {
    const t1 = "t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC";
    expect((await parseAddress(`\u200b${t1}\u200d\ufeff`)).transparent).toBe(t1);
  });
});

describe("addresses on other chains", () => {
  it("computes Keccak-256 (Ethereum's padding, not SHA3)", () => {
    const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
    expect(hex(keccak256(new Uint8Array()))).toBe(
      "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
    expect(hex(keccak256(new TextEncoder().encode("abc")))).toBe(
      "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
    );
    // Longer than one 136-byte block.
    expect(hex(keccak256(new Uint8Array(200).fill(0x61)))).toHaveLength(64);
  });

  it("checks EIP-55 checksums on mixed-case EVM addresses (the EIP's own vectors)", () => {
    for (const a of [
      "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
      "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
      "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
      "0x52908400098527886e0f7030069857d2e4169ee7",
      "0x8617E340B3D01FA5F11F306F4090FD50E238070D",
    ]) {
      expect(evmAddressProblem(a), a).toBeUndefined();
    }
    // One character's case flipped.
    expect(evmAddressProblem("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD")).toBe("checksum");
    expect(evmAddressProblem("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAe")).toBe("format");
  });

  it("validates Bitcoin addresses with their checksums (BIP 173 and BIP 350 vectors)", async () => {
    for (const a of [
      "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4",
      "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3",
      "bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y",
      "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
      "bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs", // version 2, Bech32m
      "BC1SW50QGDZ25J", // version 16
      "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
      "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy",
    ]) {
      expect(await isBitcoinAddress(a), a).toBe(true);
    }
    for (const a of [
      "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5", // checksum
      "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd", // v1 with Bech32
      "BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P", // v0 with a 16-byte program
      "bc1zw508d6qejxtdg4y5r3zarvaryvg6kdaj", // version 2 with Bech32 (valid before BIP 350)
      "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3", // Base58Check checksum
      "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", // testnet
      "bc1Qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", // mixed case
    ]) {
      expect(await isBitcoinAddress(a), a).toBe(false);
    }
  });

  it("validates Solana and NEAR recipients", () => {
    expect(isSolanaAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(true);
    expect(isSolanaAddress("11111111111111111111111111111111")).toBe(true);
    // Solana has no checksum: only a wrong length or alphabet can be caught.
    expect(isSolanaAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4w")).toBe(false);
    expect(isSolanaAddress("0PjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(false);
    expect(isNearAccount("kemi.near")).toBe(true);
    expect(isNearAccount("a1")).toBe(true);
    expect(isNearAccount("a".repeat(64))).toBe(true);
    expect(isNearAccount("a")).toBe(false);
    expect(isNearAccount("a".repeat(65))).toBe(false);
    expect(isNearAccount("Name.near")).toBe(false);
    expect(isNearAccount("a..b")).toBe(false);
    expect(isNearAccount("0".repeat(64))).toBe(true);
  });
});
