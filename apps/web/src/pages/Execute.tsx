import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { formatZat, parseRefundAddress, paymentUri } from "@turnstile/core";
import {
  DESTINATIONS,
  FINAL_STATUSES,
  OneClickClient,
  destination,
  formatUnits,
  legQuoteRequest,
  quoteFeeBps,
  recipientProblem,
  refundKindProblem,
  verifyQuote,
  type QuoteResponse,
  type SwapStatus,
} from "@turnstile/intents";
import type { PlannedLeg } from "@turnstile/core";
import { Tag } from "../components";
import { dateTime, nowSec, zec } from "../format";
import { Alert, Check, Download, Lock, Refresh } from "../icons";
import { QrCode } from "../qr";

/** How often to ask NEAR Intents for the swap's status; doubled after each error, up to MAX. */
const POLL_MS = 15_000;
const MAX_POLL_MS = 120_000;
/** A deposit address is only created within this long of the leg's planned time. */
const LIVE_WINDOW_SEC = 24 * 3_600;
/** Warn when the quote's value out is this much below the value in. */
const LOSS_WARNING = 0.05;

const STATUS_COPY: Record<SwapStatus, string> = {
  PENDING_DEPOSIT: "Waiting for your deposit",
  KNOWN_DEPOSIT_TX: "Deposit seen; waiting for it to confirm",
  INCOMPLETE_DEPOSIT:
    "The deposit was less than requested. It will be refunded, minus the refund fee, after the deadline",
  PROCESSING: "Swapping",
  SUCCESS: "Done",
  REFUNDED: "Refunded to your refund address",
  FAILED: "The swap failed; see NEAR Intents for details",
};

type Step =
  | { kind: "form" }
  | { kind: "dry"; quote: QuoteResponse }
  | { kind: "live"; quote: QuoteResponse; recipient: string; refund: string; assetKey: string };

function downloadJson(name: string, data: unknown): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const usd = (v: string | undefined): number | undefined => {
  const n = Number(v);
  return v !== undefined && Number.isFinite(n) && n > 0 ? n : undefined;
};

export function ExecutePanel({
  leg,
  index,
  count,
  onClose,
  onLiveChange,
}: {
  leg: PlannedLeg;
  index: number;
  count: number;
  onClose: () => void;
  /** Told when a live deposit address exists, so the plan isn't changed underneath it. */
  onLiveChange: (live: boolean) => void;
}): ReactNode {
  const [client] = useState(() => new OneClickClient());
  const [assetKey, setAssetKey] = useState(DESTINATIONS[0]!.key);
  const [recipient, setRecipient] = useState("");
  const [refund, setRefund] = useState("");
  const [errors, setErrors] = useState<{ recipient?: string; refund?: string; api?: string }>({});
  const [refundNote, setRefundNote] = useState<string>();
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ status: SwapStatus; amountOut?: string | null }>();
  const [copied, setCopied] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [now, setNow] = useState(nowSec);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Guards that must hold synchronously: a double click must not create two quotes, and a
  // response for inputs the user has since changed must be dropped.
  const busyRef = useRef(false);
  const requestId = useRef(0);
  const asset = destination(assetKey);
  const untilLeg = leg.time - now;
  const early = untilLeg > 30 * 60;
  const tooEarlyForLive = untilLeg > LIVE_WINDOW_SEC;
  const red = leg.check.verdict === "red";

  useEffect(() => headingRef.current?.focus(), []);
  useEffect(() => {
    const t = setInterval(() => setNow(nowSec()), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    onLiveChange(step.kind === "live");
  }, [step.kind]);
  useEffect(() => () => onLiveChange(false), []);

  const edit =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      requestId.current++;
      setStep({ kind: "form" });
    };

  const validate = async (): Promise<boolean> => {
    const next: typeof errors = {};
    const r = await recipientProblem(asset, recipient);
    if (r) next.recipient = r;
    const parsed = await parseRefundAddress(refund);
    if ("problem" in parsed) next.refund = parsed.problem;
    else {
      const unsupported = refundKindProblem(parsed.kind);
      if (unsupported) next.refund = unsupported;
      setRefundNote(
        parsed.shielded
          ? undefined
          : "Refunds would land on a transparent address, where anyone can see them. A unified address (u1) from your wallet keeps them shielded.",
      );
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const requestQuote = async (dry: boolean): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const mine = ++requestId.current;
    try {
      if (!(await validate()) || mine !== requestId.current) return;
      const request = legQuoteRequest({
        amountZat: leg.amount,
        destination: asset,
        recipient,
        refundTo: refund,
        dry,
      });
      const quote = await client.quote(request);
      if (mine !== requestId.current) return; // the inputs changed while waiting
      const wrong = await verifyQuote(request, quote);
      if (wrong) throw new Error(wrong);
      setStep(
        dry
          ? { kind: "dry", quote }
          : {
              kind: "live",
              quote,
              recipient: request.recipient,
              refund: request.refundTo,
              assetKey,
            },
      );
    } catch (err) {
      if (mine === requestId.current) setErrors({ api: (err as Error).message });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const live = step.kind === "live" ? step : undefined;
  const depositAddress = live?.quote.quote.depositAddress;
  const deadline = live?.quote.quote.deadline
    ? Date.parse(live.quote.quote.deadline) / 1000
    : undefined;
  const expired = deadline !== undefined && now > deadline;

  // Poll until a final status, backing off after errors; stop once an unpaid quote has expired.
  const statusRef = useRef(status);
  statusRef.current = status;
  const pollStatus = async (): Promise<boolean> => {
    if (!depositAddress) return true;
    try {
      const s = await client.status(depositAddress);
      setStatus({ status: s.status, amountOut: s.swapDetails?.amountOutFormatted ?? null });
      setErrors((e) => (e.api ? { ...e, api: undefined } : e));
      return true;
    } catch (err) {
      setErrors({ api: (err as Error).message });
      return false;
    }
  };
  useEffect(() => {
    if (!depositAddress) return;
    let stopped = false;
    let delay = POLL_MS;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async (): Promise<void> => {
      const ok = await pollStatus();
      if (stopped) return;
      const s = statusRef.current?.status;
      const unpaidAndExpired =
        deadline !== undefined && nowSec() > deadline && (!s || s === "PENDING_DEPOSIT");
      if ((s && FINAL_STATUSES.has(s)) || unpaidAndExpired) return;
      delay = ok ? POLL_MS : Math.min(MAX_POLL_MS, delay * 2);
      timer = setTimeout(() => void tick(), delay);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [depositAddress]);

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    void requestQuote(step.kind === "form");
  };

  // The payment request is built from the verified quote's own amount (equal to the leg's).
  const amountIn = live ? Number(live.quote.quote.amountIn) : undefined;
  const uri = depositAddress && amountIn ? paymentUri(depositAddress, amountIn) : undefined;
  const copy = async (): Promise<void> => {
    if (!depositAddress) return;
    try {
      await navigator.clipboard.writeText(depositAddress);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  const saveQuote = (): void => {
    if (live && depositAddress) downloadJson(`turnstile-quote-${depositAddress}.json`, live.quote);
  };
  const close = (): void => {
    const finished = status && FINAL_STATUSES.has(status.status);
    if (live && !finished && !expired && !confirmClose) setConfirmClose(true);
    else onClose();
  };

  const quote = step.kind === "form" ? undefined : step.quote;
  const quoteAsset = live ? destination(live.assetKey) : asset;
  const inUsd = usd(quote?.quote.amountInUsd);
  const outUsd = usd(quote?.quote.amountOutUsd);
  const loss = inUsd && outUsd ? 1 - outUsd / inUsd : undefined;
  const terms = quote && (
    <>
      <p>
        You'd receive about{" "}
        <strong>
          {quote.quote.amountOutFormatted} {quoteAsset.symbol}
        </strong>{" "}
        (at least {formatUnits(quote.quote.minAmountOut, quoteAsset.decimals)}), about{" "}
        {Math.max(1, Math.round(quote.quote.timeEstimate / 60))} minutes after your deposit
        confirms.
      </p>
      <p className="hint">
        {inUsd && outUsd
          ? `Value in about $${inUsd.toFixed(2)}, out about $${outUsd.toFixed(2)}. `
          : ""}
        NEAR Intents' fee: {(quoteFeeBps(quote) / 100).toFixed(2)}%.
        {quote.quote.refundFee
          ? ` A refund would cost ${zec(Number(quote.quote.refundFee))}.`
          : ""}{" "}
        Turnstile adds nothing.
      </p>
      {loss !== undefined && loss > LOSS_WARNING && (
        <p className="status-banner warning" role="status">
          <Alert size={18} />
          <span className="status-text">
            This swap loses about {(loss * 100).toFixed(0)}% of its value to fees and price impact,
            usually because the amount is small. A larger withdrawal loses less.
          </span>
        </p>
      )}
    </>
  );

  return (
    <section className="card execute" aria-labelledby="execute-title">
      <div className="execute-head">
        <h3 id="execute-title" ref={headingRef} tabIndex={-1}>
          Execute withdrawal {index + 1} of {count}: {zec(leg.amount)}
        </h3>
        <button type="button" className="link-button" onClick={close}>
          Close
        </button>
      </div>

      {confirmClose && (
        <div className="status-banner warning" role="alert">
          <Alert size={18} />
          <span className="status-text">
            A deposit address is open for this withdrawal. If you close it, this page stops tracking
            the swap. Save the signed quote first so you can still follow it up.
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-small"
            onClick={() => {
              saveQuote();
              onClose();
            }}
          >
            Save and close
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-small"
            onClick={() => setConfirmClose(false)}
          >
            Keep it open
          </button>
        </div>
      )}

      <div className="disclosure">
        <Lock size={18} />
        <p>
          This step contacts <strong>NEAR Intents</strong>, which swaps your ZEC. Their service will
          see this withdrawal's amount ({zec(leg.amount)}), the address you receive at, your refund
          address, and your IP address. Nothing else leaves this device. Without an API key, NEAR
          Intents adds a small fee, shown with the price; Turnstile adds nothing and never holds
          your funds or keys.
        </p>
      </div>

      {early && (
        <p className="status-banner warning" role="status">
          <Alert size={18} />
          <span className="status-text">
            This withdrawal is planned for {dateTime(leg.time)}. Sending it earlier changes the
            timing the plan relies on to blend in; consider waiting until then.
          </span>
        </p>
      )}
      {red && (
        <p className="status-banner error" role="alert">
          <Alert size={18} />
          <span className="status-text">
            The Pre-flight Check flags this withdrawal as red. Re-plan before sending it; you can
            still see a price.
          </span>
        </p>
      )}

      {!live && (
        <form className="form-card" onSubmit={onSubmit} noValidate>
          <fieldset className="plain-fieldset" disabled={busy}>
            <div className="field">
              <label htmlFor="exec-asset">Receive</label>
              <select
                id="exec-asset"
                className="input"
                value={assetKey}
                onChange={(e) => edit(setAssetKey)(e.target.value)}
              >
                {DESTINATIONS.map((d) => (
                  <option key={d.key} value={d.key}>
                    {d.symbol} on {d.chain}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="exec-recipient">Your {asset.chain} address</label>
              <input
                id="exec-recipient"
                className="input"
                autoComplete="off"
                spellCheck={false}
                value={recipient}
                onChange={(e) => edit(setRecipient)(e.target.value)}
                aria-invalid={errors.recipient ? true : undefined}
                aria-describedby={errors.recipient ? "exec-recipient-error" : "exec-recipient-hint"}
              />
              <span id="exec-recipient-hint" className="hint">
                Use a different address for each withdrawal: legs that end at one address are linked
                again there.
              </span>
              {errors.recipient && (
                <span id="exec-recipient-error" className="error-text">
                  {errors.recipient}
                </span>
              )}
            </div>
            <div className="field">
              <label htmlFor="exec-refund">Refund address (Zcash)</label>
              <input
                id="exec-refund"
                className="input"
                autoComplete="off"
                spellCheck={false}
                placeholder="u1..."
                value={refund}
                onChange={(e) => edit(setRefund)(e.target.value)}
                aria-invalid={errors.refund ? true : undefined}
                aria-describedby={errors.refund ? "exec-refund-error" : "exec-refund-hint"}
              />
              <span id="exec-refund-hint" className="hint">
                If the swap can't complete, your ZEC goes back here. A fresh unified address (u1)
                from your wallet keeps refunds shielded.
              </span>
              {errors.refund && (
                <span id="exec-refund-error" className="error-text">
                  {errors.refund}
                </span>
              )}
            </div>
          </fieldset>
          {refundNote && !errors.refund && (
            <p className="status-banner warning" role="status">
              {refundNote}
            </p>
          )}
          {errors.api && (
            <p className="error-text" role="alert">
              NEAR Intents: {errors.api}
            </p>
          )}

          {step.kind === "dry" && (
            <div className="quote-box" role="status">
              {terms}
              <p className="hint">This was only a price. No deposit address exists yet.</p>
            </div>
          )}
          {step.kind === "dry" && tooEarlyForLive && (
            <p className="hint">
              The deposit address can be created from {dateTime(leg.time - LIVE_WINDOW_SEC)}, a day
              before this withdrawal is planned. An address created earlier could expire before you
              pay it.
            </p>
          )}

          <div className="actions">
            <button
              className="btn btn-primary"
              type="submit"
              disabled={busy || (step.kind === "dry" && (tooEarlyForLive || red))}
            >
              {busy
                ? "Asking NEAR Intents..."
                : step.kind === "form"
                  ? "Get a price"
                  : "Get the deposit address"}
            </button>
          </div>
        </form>
      )}

      {live && depositAddress && uri && (
        <div className="live">
          <div className="quote-box">{terms}</div>
          <dl className="facts">
            <div>
              <dt>Receiving</dt>
              <dd>
                {quoteAsset.symbol} on {quoteAsset.chain}
              </dd>
            </div>
            <div>
              <dt>At</dt>
              <dd className="mono">{live.recipient}</dd>
            </div>
            <div>
              <dt>Refunds to</dt>
              <dd className="mono">{live.refund}</dd>
            </div>
          </dl>
          {expired ? (
            <p className="status-banner error" role="alert">
              <Alert size={18} />
              <span className="status-text">
                This deposit address expired on {dateTime(deadline!)}. Don't pay it: get a new one
                instead.
              </span>
            </p>
          ) : (
            <div className="pay-grid">
              <QrCode
                text={uri}
                label={`Payment request: ${formatZat(amountIn!)} ZEC to ${depositAddress}`}
              />
              <div className="pay-details">
                <p>
                  From your shielded wallet, send exactly <strong>{zec(amountIn!)}</strong> to this
                  one-time address:
                </p>
                <code className="address">{depositAddress}</code>
                <div className="actions">
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    onClick={() => void copy()}
                  >
                    {copied ? <Check size={16} /> : null}
                    {copied ? "Copied" : "Copy address"}
                  </button>
                  <a className="btn btn-primary btn-small" href={uri}>
                    Open in wallet
                  </a>
                </div>
                <p className="hint">
                  Pay it once. After {deadline ? dateTime(deadline) : "the deadline"} the address
                  stops working and funds sent to it may be lost.
                </p>
              </div>
            </div>
          )}
          <div className="swap-status" role="status" aria-live="polite">
            <span>Status:</span>
            <strong>{status ? STATUS_COPY[status.status] : "Checking..."}</strong>
            {status?.status === "SUCCESS" && status.amountOut && (
              <span>
                {status.amountOut} {quoteAsset.symbol} received
              </span>
            )}
            {status && (
              <Tag
                verdict={
                  status.status === "SUCCESS"
                    ? "green"
                    : status.status === "FAILED" || status.status === "REFUNDED"
                      ? "red"
                      : "amber"
                }
              >
                {status.status.replace(/_/g, " ").toLowerCase()}
              </Tag>
            )}
          </div>
          {errors.api && (
            <p className="error-text" role="alert">
              NEAR Intents: {errors.api}
            </p>
          )}
          <div className="actions">
            <button
              type="button"
              className="btn btn-ghost btn-small"
              onClick={() => void pollStatus()}
            >
              <Refresh size={16} /> Check status now
            </button>
            <button type="button" className="btn btn-ghost btn-small" onClick={saveQuote}>
              <Download size={16} /> Save signed quote
            </button>
          </div>
          <p className="hint">
            NEAR Intents signs every quote. Keep the saved copy until the swap is done; it settles
            any dispute. Status is checked every 15 seconds while this page is open.
          </p>
        </div>
      )}
    </section>
  );
}
