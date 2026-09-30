import { describe, expect, it } from "vitest";
import { bech32mDecode, bech32mEncode, parseAddress, toTex } from "./address.js";

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
