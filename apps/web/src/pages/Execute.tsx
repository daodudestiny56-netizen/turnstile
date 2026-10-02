import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { parseRefundAddress, paymentUri } from "@turnstile/core";
import {
  DESTINATIONS,
  FINAL_STATUSES,
  OneClickClient,
  destination,
  legQuoteRequest,
  recipientProblem,
  refundKindProblem,
  type QuoteResponse,
  type SwapStatus,
} from "@turnstile/intents";
import type { PlannedLeg } from "@turnstile/core";
import { Tag } from "../components";
import { dateTime, nowSec, zec } from "../format";
import { Alert, Check, Download, Lock, Refresh } from "../icons";
import { QrCode } from "../qr";

/** How often to ask NEAR Intents for the swap's status once a deposit address exists. */
const POLL_MS = 15_000;

const STATUS_COPY: Record<SwapStatus, string> = {
  PENDING_DEPOSIT: "Waiting for your deposit",
  KNOWN_DEPOSIT_TX: "Deposit seen; waiting for it to confirm",
  INCOMPLETE_DEPOSIT: "The deposit was less than requested; it will be refunded",
  PROCESSING: "Swapping",
  SUCCESS: "Done",
  REFUNDED: "Refunded to your refund address",
  FAILED: "The swap failed; see NEAR Intents for details",
};

type Step =
  { kind: "form" } | { kind: "dry"; quote: QuoteResponse } | { kind: "live"; quote: QuoteResponse };

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

export function ExecutePanel({
  leg,
  index,
  count,
  onClose,
}: {
  leg: PlannedLeg;
  index: number;
  count: number;
  onClose: () => void;
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
  const headingRef = useRef<HTMLHeadingElement>(null);
  const asset = destination(assetKey);
  const early = leg.time - nowSec() > 30 * 60;

  useEffect(() => headingRef.current?.focus(), []);

  const validate = async (): Promise<boolean> => {
    const next: typeof errors = {};
    const r = recipientProblem(asset, recipient);
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
    if (!(await validate())) return;
    setBusy(true);
    try {
      const quote = await client.quote(
        legQuoteRequest({
          amountZat: leg.amount,
          destination: asset,
          recipient,
          refundTo: refund,
          dry,
        }),
      );
      if (!dry && !quote.quote.depositAddress)
        throw new Error("NEAR Intents returned no deposit address.");
      setStep({ kind: dry ? "dry" : "live", quote });
    } catch (err) {
      setErrors({ api: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const depositAddress = step.kind === "live" ? step.quote.quote.depositAddress! : undefined;

  const pollStatus = async (): Promise<void> => {
    if (!depositAddress) return;
    try {
      const s = await client.status(depositAddress);
      setStatus({ status: s.status, amountOut: s.swapDetails?.amountOutFormatted ?? null });
    } catch (err) {
      setErrors({ api: (err as Error).message });
    }
  };

  // Poll until the swap reaches a final state; the ref avoids side effects inside setState.
  const statusRef = useRef(status);
  statusRef.current = status;
  useEffect(() => {
    if (!depositAddress) return;
    void pollStatus();
    const timer = setInterval(() => {
      const s = statusRef.current;
      if (!s || !FINAL_STATUSES.has(s.status)) void pollStatus();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [depositAddress]);

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    void requestQuote(step.kind === "form");
  };

  const uri = depositAddress ? paymentUri(depositAddress, leg.amount) : undefined;
  const copy = async (): Promise<void> => {
    if (!depositAddress) return;
    try {
      await navigator.clipboard.writeText(depositAddress);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="card execute" aria-labelledby="execute-title">
      <div className="execute-head">
        <h3 id="execute-title" ref={headingRef} tabIndex={-1}>
          Execute withdrawal {index + 1} of {count}: {zec(leg.amount)}
        </h3>
        <button type="button" className="link-button" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="disclosure">
        <Lock size={18} />
        <p>
          This step contacts <strong>NEAR Intents</strong>, which swaps your ZEC. Their service will
          see this withdrawal's amount ({zec(leg.amount)}), the address you receive at, your refund
          address, and your IP address. Nothing else leaves this device. Without an API key, NEAR
          Intents adds a 0.25% fee; Turnstile adds nothing and never holds your funds or keys.
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
      {leg.check.verdict === "red" && (
        <p className="status-banner error" role="alert">
          <Alert size={18} />
          <span className="status-text">
            The Pre-flight Check flags this withdrawal as red. Re-plan before sending it.
          </span>
        </p>
      )}

      {step.kind !== "live" && (
        <form className="form-card" onSubmit={onSubmit} noValidate>
          <div className="field">
            <label htmlFor="exec-asset">Receive</label>
            <select
              id="exec-asset"
              className="input"
              value={assetKey}
              onChange={(e) => {
                setAssetKey(e.target.value);
                setStep({ kind: "form" });
              }}
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
              onChange={(e) => {
                setRecipient(e.target.value);
                setStep({ kind: "form" });
              }}
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
              onChange={(e) => {
                setRefund(e.target.value);
                setStep({ kind: "form" });
              }}
              aria-invalid={errors.refund ? true : undefined}
              aria-describedby={errors.refund ? "exec-refund-error" : "exec-refund-hint"}
            />
            <span id="exec-refund-hint" className="hint">
              If the swap can't complete, your ZEC goes back here. A fresh unified address (u1) from
              your wallet keeps refunds shielded.
            </span>
            {errors.refund && (
              <span id="exec-refund-error" className="error-text">
                {errors.refund}
              </span>
            )}
          </div>
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
              <p>
                You'd receive about{" "}
                <strong>
                  {step.quote.quote.amountOutFormatted} {asset.symbol}
                </strong>{" "}
                (at least {Number(step.quote.quote.minAmountOut) / 10 ** asset.decimals}), about{" "}
                {Math.max(1, Math.round(step.quote.quote.timeEstimate / 60))} minutes after your
                deposit confirms.
              </p>
              <p className="hint">This was only a price. No deposit address exists yet.</p>
            </div>
          )}

          <div className="actions">
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy
                ? "Asking NEAR Intents..."
                : step.kind === "form"
                  ? "Get a price"
                  : "Get the deposit address"}
            </button>
          </div>
        </form>
      )}

      {step.kind === "live" && depositAddress && uri && (
        <div className="live">
          <div className="pay-grid">
            <QrCode text={uri} label={`Payment request: ${zec(leg.amount)} to ${depositAddress}`} />
            <div className="pay-details">
              <p>
                From your shielded wallet, send exactly <strong>{zec(leg.amount)}</strong> to this
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
                Pay it once. After{" "}
                {step.quote.quote.deadline
                  ? dateTime(Date.parse(step.quote.quote.deadline) / 1000)
                  : "the deadline"}{" "}
                the address stops working and funds sent to it may be lost.
              </p>
            </div>
          </div>
          <div className="swap-status" role="status" aria-live="polite">
            <span>Status:</span>
            <strong>{status ? STATUS_COPY[status.status] : "Checking..."}</strong>
            {status?.status === "SUCCESS" && status.amountOut && (
              <span>
                {status.amountOut} {asset.symbol} received
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
            <button
              type="button"
              className="btn btn-ghost btn-small"
              onClick={() => downloadJson(`turnstile-quote-${depositAddress}.json`, step.quote)}
            >
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
