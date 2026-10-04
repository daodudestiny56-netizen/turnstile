import { describe, expect, it, vi } from "vitest";
import {
  DESTINATIONS,
  destination,
  recipientProblem,
  refundKindProblem,
  ZEC_ASSET_ID,
} from "./assets.js";
import {
  IntentsError,
  OneClickClient,
  formatUnits,
  legQuoteRequest,
  quoteFeeBps,
  type QuoteRequest,
  type QuoteResponse,
} from "./client.js";
import { verifyQuote } from "./verify.js";

const USDC_BASE = destination("usdc-base");
const NOW = Date.UTC(2026, 9, 2, 12);

describe("legQuoteRequest", () => {
  it("asks for exactly the leg amount of ZEC in, to the chosen asset", () => {
    expect(
      legQuoteRequest({
        amountZat: 100_000_000,
        destination: USDC_BASE,
        recipient: " 0x2527D02599Ba641c19FEa793cD0F167589a0f10D ",
        refundTo: " u1abc ",
        dry: true,
        now: NOW,
      }),
    ).toEqual({
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: ZEC_ASSET_ID,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: USDC_BASE.assetId,
      amount: "100000000",
      refundTo: "u1abc",
      refundType: "ORIGIN_CHAIN",
      recipient: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D",
      recipientType: "DESTINATION_CHAIN",
      deadline: new Date(NOW + 3 * 3_600_000).toISOString(),
    });
  });

  it("rejects a non-positive amount", () => {
    expect(() =>
      legQuoteRequest({
        amountZat: 0,
        destination: USDC_BASE,
        recipient: "x",
        refundTo: "y",
        dry: true,
      }),
    ).toThrow(RangeError);
  });
});

describe("OneClickClient", () => {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("posts the quote request as JSON to /v0/quote", async () => {
    const fetch = vi.fn(async () => json({ quote: { amountOutFormatted: "138.1" } }, 201));
    const client = new OneClickClient({ fetch, baseUrl: "https://api.test" });
    const req = legQuoteRequest({
      amountZat: 10_000_000,
      destination: USDC_BASE,
      recipient: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D",
      refundTo: "u1abc",
      dry: true,
      now: NOW,
    });
    const res = await client.quote(req);
    expect(res.quote.amountOutFormatted).toBe("138.1");
    expect(fetch).toHaveBeenCalledWith("https://api.test/v0/quote", {
      signal: expect.any(AbortSignal),
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
  });

  it("reports NEAR Intents' own error message", async () => {
    const client = new OneClickClient({
      fetch: async () => json({ message: "recipient is not valid" }, 400),
    });
    await expect(client.status("t1x")).rejects.toThrow(
      new IntentsError("recipient is not valid", 400),
    );
  });

  it("explains a network failure or an unreadable reply", async () => {
    const offline = new OneClickClient({
      fetch: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    await expect(offline.status("t1x")).rejects.toThrow(/Couldn't reach NEAR Intents/);
    const garbage = new OneClickClient({
      fetch: async () => new Response("<html>", { status: 502 }),
    });
    await expect(garbage.status("t1x")).rejects.toThrow("NEAR Intents returned HTTP 502.");
  });

  it("asks for status by deposit address, encoded", async () => {
    const fetch = vi.fn(async () => json({ status: "PENDING_DEPOSIT", updatedAt: "now" }));
    const client = new OneClickClient({ fetch, baseUrl: "https://api.test" });
    expect((await client.status("t1 a&b")).status).toBe("PENDING_DEPOSIT");
    expect(fetch).toHaveBeenCalledWith("https://api.test/v0/status?depositAddress=t1%20a%26b", {
      signal: expect.any(AbortSignal),
    });
  });
});

describe("destinations", () => {
  it("has unique keys and asset ids", () => {
    expect(new Set(DESTINATIONS.map((d) => d.key)).size).toBe(DESTINATIONS.length);
    expect(new Set(DESTINATIONS.map((d) => d.assetId)).size).toBe(DESTINATIONS.length);
    expect(() => destination("doge-moon")).toThrow(/Unknown destination/);
  });

  it("checks recipient formats per chain", async () => {
    const ok: [string, string][] = [
      ["usdc-base", "0x2527D02599Ba641c19FEa793cD0F167589a0f10D"],
      ["usdc-sol", "13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK"],
      ["btc-btc", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"],
      ["usdc-near", "turnstile.near"],
    ];
    for (const [key, addr] of ok)
      expect(await recipientProblem(destination(key), addr), key).toBeUndefined();
    expect(await recipientProblem(USDC_BASE, "0x123")).toMatch(/starting with 0x and 40 hex/);
    expect(
      await recipientProblem(destination("usdc-sol"), "0x2527D02599Ba641c19FEa793cD0F167589a0f10D"),
    ).toMatch(/Solana/);
    expect(
      await recipientProblem(destination("btc-btc"), "t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC"),
    ).toMatch(/Bitcoin/);
  });

  it("catches a mistyped character through each chain's checksum", async () => {
    // One letter's case changed: EIP-55 catches it.
    expect(await recipientProblem(USDC_BASE, "0x2527D02599Ba641c19FEa793cD0F167589a0f10d")).toMatch(
      /checksum/,
    );
    // All-lowercase carries no checksum and is accepted.
    expect(
      await recipientProblem(USDC_BASE, "0x2527d02599ba641c19fea793cd0f167589a0f10d"),
    ).toBeUndefined();
    // One character changed in a Bech32 Bitcoin address.
    expect(
      await recipientProblem(destination("btc-btc"), "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdr"),
    ).toMatch(/checksum/);
    // NEAR names have length limits.
    expect(await recipientProblem(destination("usdc-near"), "a")).toMatch(/NEAR/);
    expect(await recipientProblem(destination("usdc-near"), "x".repeat(200))).toMatch(/NEAR/);
  });
});

describe("refund address kinds", () => {
  it("refuses Sapling, which NEAR Intents rejects, and allows the rest", () => {
    expect(refundKindProblem("sapling")).toMatch(/Use a unified address/);
    for (const k of ["unified", "t1", "t3", "tex"]) expect(refundKindProblem(k)).toBeUndefined();
  });
});

describe("checking a quote before it is shown", () => {
  const sent = legQuoteRequest({
    amountZat: 100_000_000,
    destination: USDC_BASE,
    recipient: "0x2527D02599Ba641c19FEa793cD0F167589a0f10D",
    refundTo: "t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC",
    dry: false,
    now: 0,
  });
  const response = (
    over: Partial<QuoteResponse["quote"]> = {},
    req: Partial<QuoteRequest> = {},
  ): QuoteResponse => ({
    correlationId: "x",
    timestamp: "2026-10-04T00:00:00Z",
    signature: "ed25519:x",
    quoteRequest: { ...sent, ...req, appFees: [{ recipient: "r", fee: 20 }] },
    quote: {
      depositAddress: "t1TDVLNjs5kq1WBWsGmUuCtfq9R3qD2FNip",
      amountIn: "100000000",
      amountInFormatted: "1",
      amountOut: "1327240852",
      amountOutFormatted: "1327.240852",
      amountOutUsd: "1327.2",
      minAmountOut: "1313968443",
      timeEstimate: 459,
      deadline: "2026-10-07T00:00:00Z",
      ...over,
    },
  });

  it("accepts a quote that answers the request", async () => {
    expect(await verifyQuote(sent, response())).toBeUndefined();
    expect(quoteFeeBps(response())).toBe(20);
  });

  it("refuses a quote for another amount, recipient or refund address", async () => {
    expect(await verifyQuote(sent, response({ amountIn: "10000000" }))).toMatch(/instead of/);
    expect(await verifyQuote(sent, response({}, { recipient: "0xabc" }))).toMatch(/recipient/);
    expect(await verifyQuote(sent, response({}, { refundTo: "t1other" }))).toMatch(/refund/);
    expect(await verifyQuote(sent, response({}, { dry: true }))).toMatch(/kind/);
    expect(await verifyQuote(sent, response({ amountOut: "0" }))).toMatch(/no amount out/);
  });

  it("refuses a deposit address that isn't a valid transparent Zcash address", async () => {
    expect(await verifyQuote(sent, response({ depositAddress: undefined }))).toMatch(/no deposit/);
    expect(
      await verifyQuote(sent, response({ depositAddress: "t1TDVLNjs5kq1WBWsGmUuCtfq9R3qD2FNiq" })),
    ).toMatch(/Don't pay it/);
    expect(await verifyQuote(sent, response({ depositAddress: "0xdeadbeef" }))).toMatch(
      /Don't pay it/,
    );
  });

  it("formats base units exactly, without exponents", () => {
    expect(formatUnits("1313968443", 6)).toBe("1313.968443");
    expect(formatUnits("50", 8)).toBe("0.0000005");
    expect(formatUnits("123456789012345678901234567890", 18)).toBe(
      "123456789012.34567890123456789",
    );
    expect(formatUnits("1000000", 6)).toBe("1");
    expect(formatUnits("0", 6)).toBe("0");
  });

  it("gives up on a request that never answers", async () => {
    const hang = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    );
    const client = new OneClickClient({ fetch: hang as unknown as typeof fetch, timeoutMs: 50 });
    await expect(client.status("t1x")).rejects.toThrow(/didn't answer in time/);
  });
});
