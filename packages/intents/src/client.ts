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

/** NEAR Intents' fee on a quote, in basis points of the input. */
export interface AppFee {
  recipient: string;
  fee: number;
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
  /** Zatoshi kept from a refund. */
  refundFee?: string;
  amountInUsd?: string;
  minAmountIn?: string;
}

export interface QuoteResponse {
  correlationId: string;
  timestamp: string;
  /** NEAR Intents' signature over the quote; keep it with the quote to resolve disputes. */
  signature: string;
  quoteRequest: QuoteRequest & { appFees?: AppFee[] };
  quote: Quote;
}

/** Total fee NEAR Intents reports for a quote, in basis points (0.20% is 20). */
export function quoteFeeBps(response: QuoteResponse): number {
  return (response.quoteRequest.appFees ?? []).reduce((s, f) => s + (Number(f.fee) || 0), 0);
}

/**
 * Check that a quote answers the request that was sent: same amount in, recipient, refund address,
 * origin asset and dry/live mode, and a positive amount out. A quote that doesn't match is never
 * shown as something to pay. (The destination asset id is not compared: the API may return it in
 * another notation.)
 */
export function quoteMismatch(sent: QuoteRequest, got: QuoteResponse): string | undefined {
  const r = got?.quoteRequest;
  const q = got?.quote;
  if (!r || !q) return "NEAR Intents returned an incomplete quote.";
  if (q.amountIn !== sent.amount || r.amount !== sent.amount) {
    return `NEAR Intents quoted ${q.amountIn} zatoshi instead of the ${sent.amount} requested.`;
  }
  if (r.recipient !== sent.recipient) return "The quote is for a different recipient.";
  if (r.refundTo !== sent.refundTo) return "The quote is for a different refund address.";
  if (r.originAsset !== sent.originAsset) return "The quote is for a different asset.";
  if (r.dry !== sent.dry) return "The quote is not the kind that was requested.";
  if (
    !/^\d+$/.test(q.amountOut ?? "") ||
    !/^\d+$/.test(q.minAmountOut ?? "") ||
    BigInt(q.amountOut) <= 0n
  ) {
    return "NEAR Intents returned no amount out.";
  }
  return undefined;
}

/** Format an integer number of base units (a decimal string) with `decimals` places, exactly. */
export function formatUnits(value: string, decimals: number): string {
  if (!/^\d+$/.test(value)) return value;
  const padded = value.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/, "");
  const frac = decimals ? padded.slice(padded.length - decimals).replace(/0+$/, "") : "";
  return frac ? `${whole}.${frac}` : whole;
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
  /** Give up on a request after this long (default 20 s). */
  timeoutMs?: number;
}

/**
 * NEAR Intents 1Click API. No API key: a static site can't keep one secret. Without one NEAR
 * Intents adds a fee, which each quote reports (quoteFeeBps) and the UI shows with the price.
 */
export class OneClickClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? ONECLICK_BASE_URL;
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    let text: string;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: controller.signal });
      text = await res.text();
    } catch (cause) {
      throw new IntentsError(
        controller.signal.aborted
          ? "NEAR Intents didn't answer in time. Try again."
          : "Couldn't reach NEAR Intents. Check your connection and try again.",
        undefined,
        { cause },
      );
    } finally {
      clearTimeout(timer);
    }
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
