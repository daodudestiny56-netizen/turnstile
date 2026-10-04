/**
 * NEAR Intents 1Click adapter. This is the only package allowed to talk to a third-party service
 * (PRD P5), and only when the user executes a leg.
 */
export {
  DESTINATIONS,
  ZEC_ASSET_ID,
  destination,
  recipientProblem,
  refundKindProblem,
} from "./assets.js";
export type { AddressFormat, DestinationAsset } from "./assets.js";
export {
  FINAL_STATUSES,
  IntentsError,
  ONECLICK_BASE_URL,
  OneClickClient,
  formatUnits,
  legQuoteRequest,
  quoteFeeBps,
  quoteMismatch,
} from "./client.js";
export { verifyQuote } from "./verify.js";
export type {
  AppFee,
  ClientOptions,
  LegQuoteInput,
  Quote,
  QuoteRequest,
  QuoteResponse,
  StatusResponse,
  SwapStatus,
} from "./client.js";
