import { describe, expect, it } from "vitest";
import { blockchairDumpUrl } from "./blockchair.js";

describe("blockchairDumpUrl", () => {
  it("builds the dump URL for a table and day", () => {
    expect(blockchairDumpUrl("transactions", "2026-09-28")).toBe(
      "https://gz.blockchair.com/zcash/transactions/blockchair_zcash_transactions_20260928.tsv.gz",
    );
    expect(blockchairDumpUrl("outputs", "2026-06-01")).toBe(
      "https://gz.blockchair.com/zcash/outputs/blockchair_zcash_outputs_20260601.tsv.gz",
    );
  });

  it("rejects malformed days", () => {
    expect(() => blockchairDumpUrl("inputs", "20260928")).toThrow(RangeError);
  });
});
