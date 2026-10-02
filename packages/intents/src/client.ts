import { ZEC_ASSET_ID, type DestinationAsset } from "./assets.js";

export const ONECLICK_BASE_URL = "https://1click.chaindefuser.com";

/** The subset of the 1Click quote request Turnstile uses (OpenAPI v0). */
export interface QuoteRequest {
  dry: boolean;
  swapType: "EXACT_INPUT";
  slippageTolerance: number;
  originAsset: string;
  depositType: "ORIGIN_CHAIN";
  destinationAsset: string;
  amount: string;
  refundTo: string;
  refundType: "ORIGIN_CHAIN";
  recipient: string;
  recipientType: "DESTINATION_CHAIN";
  deadline: string;
}

export interface Quote {
  /** Present on live quotes only: a one-time transparent ZEC address. */
  depositAddress?: string;
  amountIn: string;
  amountInFormatted: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd: string;
  minAmountOut: string;
  /** Seconds after the deposit confirms. */
  timeEstimate: number;
  /** Live quotes: after this, the deposit address is inactive and funds may be lost. */
  deadline?: string;
  refundFee?: string;
}

export interface QuoteResponse {
  correlationId: string;
  timestamp: string;
  /** NEAR Intents' signature over the quote; keep it with the quote to resolve disputes. */
  signature: string;
  quoteRequest: QuoteRequest;
  quote: Quote;
}

export type SwapStatus =
  | "PENDING_DEPOSIT"
  | "KNOWN_DEPOSIT_TX"
  | "INCOMPLETE_DEPOSIT"
  | "PROCESSING"
  | "SUCCESS"
  | "REFUNDED"
  | "FAILED";

export const FINAL_STATUSES: ReadonlySet<SwapStatus> = new Set(["SUCCESS", "REFUNDED", "FAILED"]);

export interface StatusResponse {
  status: SwapStatus;
  updatedAt: string;
  swapDetails?: {
    amountOutFormatted?: string | null;
    refundedAmountFormatted?: string | null;
    refundReason?: string | null;
    destinationChainTxHashes?: { hash: string; explorerUrl?: string }[];
  };
}

export class IntentsError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "IntentsError";
  }
}

export interface LegQuoteInput {
  amountZat: number;
  destination: DestinationAsset;
  recipient: string;
  /** Where ZEC goes back if the swap can't complete; a shielded address keeps refunds private. */
  refundTo: string;
  /** Slippage tolerance in basis points (100 = 1%). */
  slippageBps?: number;
  /** When refunds begin if the swap hasn't completed. ZEC deposits need time to confirm. */
  deadlineMs?: number;
  dry: boolean;
  now?: number;
}

/** Build the quote request for one leg: exactly `amountZat` of ZEC in, the destination asset out. */
export function legQuoteRequest(input: LegQuoteInput): QuoteRequest {
  if (!Number.isSafeInteger(input.amountZat) || input.amountZat <= 0) {
    throw new RangeError("Leg amount must be a positive number of zatoshi");
  }
  const now = input.now ?? Date.now();
  return {
    dry: input.dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: input.slippageBps ?? 100,
    originAsset: ZEC_ASSET_ID,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: input.destination.assetId,
    amount: String(input.amountZat),
    refundTo: input.refundTo.trim(),
    refundType: "ORIGIN_CHAIN",
    recipient: input.recipient.trim(),
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(now + (input.deadlineMs ?? 3 * 3_600_000)).toISOString(),
  };
}

export interface ClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * NEAR Intents 1Click API. No API key: a static site can't keep one secret, and without one NEAR
 * Intents adds a 0.25% fee, which the UI discloses.
 */
export class OneClickClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? ONECLICK_BASE_URL;
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (cause) {
      throw new IntentsError(
        "Couldn't reach NEAR Intents. Check your connection and try again.",
        undefined,
        { cause },
      );
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const message =
        (body as { message?: string } | undefined)?.message ??
        `NEAR Intents returned HTTP ${res.status}.`;
      throw new IntentsError(message, res.status);
    }
    return body as T;
  }

  quote(request: QuoteRequest): Promise<QuoteResponse> {
    return this.request<QuoteResponse>("/v0/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  }

  status(depositAddress: string): Promise<StatusResponse> {
    return this.request<StatusResponse>(
      `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`,
    );
  }

  tokens(): Promise<{ assetId: string; symbol: string; blockchain: string; decimals: number }[]> {
    return this.request("/v0/tokens");
  }
}
