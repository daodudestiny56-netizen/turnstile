import { describe, expect, it } from "vitest";
import {
  BECH32M_CONST,
  bech32Decode,
  bech32mDecode,
  bech32mEncode,
  parseAddress,
  parseRefundAddress,
  toTex,
} from "./address.js";
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
