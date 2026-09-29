import { expect, it } from "vitest";
import { INTENTS_ADAPTER } from "./index.js";

it("exports the adapter id", () => {
  expect(INTENTS_ADAPTER).toBe("near-intents-1click");
});
