import { describe, expect, it, vi } from "vitest";
import {
  DESTINATIONS,
  destination,
  recipientProblem,
  refundKindProblem,
  ZEC_ASSET_ID,
} from "./assets.js";
import { IntentsError, OneClickClient, legQuoteRequest } from "./client.js";

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
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test/v0/status?depositAddress=t1%20a%26b",
      undefined,
    );
  });
});

describe("destinations", () => {
  it("has unique keys and asset ids", () => {
    expect(new Set(DESTINATIONS.map((d) => d.key)).size).toBe(DESTINATIONS.length);
    expect(new Set(DESTINATIONS.map((d) => d.assetId)).size).toBe(DESTINATIONS.length);
    expect(() => destination("doge-moon")).toThrow(/Unknown destination/);
  });

  it("checks recipient formats per chain", () => {
    const ok: [string, string][] = [
      ["usdc-base", "0x2527D02599Ba641c19FEa793cD0F167589a0f10D"],
      ["usdc-sol", "13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK"],
      ["btc-btc", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"],
      ["usdc-near", "turnstile.near"],
    ];
    for (const [key, addr] of ok)
      expect(recipientProblem(destination(key), addr), key).toBeUndefined();
    expect(recipientProblem(USDC_BASE, "0x123")).toMatch(/starting with 0x and 40 hex/);
    expect(
      recipientProblem(destination("usdc-sol"), "0x2527D02599Ba641c19FEa793cD0F167589a0f10D"),
    ).toMatch(/Solana/);
    expect(recipientProblem(destination("btc-btc"), "t1VmmGiyjVNeCjxDZzg7vZmd99WyzVby9yC")).toMatch(
      /Bitcoin/,
    );
  });
});

describe("refund address kinds", () => {
  it("refuses Sapling, which NEAR Intents rejects, and allows the rest", () => {
    expect(refundKindProblem("sapling")).toMatch(/Use a unified address/);
    for (const k of ["unified", "t1", "t3", "tex"]) expect(refundKindProblem(k)).toBeUndefined();
  });
});
