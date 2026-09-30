import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { parsePositiveZec, type OwnDeposit, type PreflightResult } from "@turnstile/core";
import { DataStatus, href, ReasonList, VerdictBanner, type Route } from "../components";
import { useEngine } from "../engine";
import { dateTime, fromLocalInput, nowSec, toLocalInput, zec } from "../format";
import { ArrowRight, ShieldCheck } from "../icons";

interface Errors {
  amount?: string;
  when?: string;
  deposit?: string;
  depositWhen?: string;
  form?: string;
}

interface Checked {
  result: PreflightResult;
  amount: number;
  time: number;
  own?: OwnDeposit;
}

function parseAmount(value: string): { zat?: number; error?: string } {
  try {
    return { zat: parsePositiveZec(value) };
  } catch (e) {
    return { error: (e as Error).message.replace(/^Invalid ZEC amount "[^"]*": /, "") };
  }
}

export function CheckPage({ route }: { route: Route }): ReactNode {
  const { state, engine } = useEngine();
  const [amount, setAmount] = useState(route.params.get("amount") ?? "");
  const [when, setWhen] = useState(() => toLocalInput(nowSec()));
  const [deposit, setDeposit] = useState(route.params.get("deposit") ?? "");
  const [depositWhen, setDepositWhen] = useState(() => {
    const at = Date.parse(route.params.get("depositAt") ?? "");
    return Number.isNaN(at) ? "" : toLocalInput(Math.floor(at / 1000));
  });
  const [destination, setDestination] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [checked, setChecked] = useState<Checked>();
  const resultRef = useRef<HTMLHeadingElement>(null);

  const run = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault();
    const next: Errors = {};
    const a = parseAmount(amount);
    if (a.error) next.amount = a.error;
    const time = fromLocalInput(when);
    if (time === undefined) next.when = "Choose when you plan to withdraw.";
    let own: OwnDeposit | undefined;
    if (deposit.trim() || depositWhen) {
      const d = parseAmount(deposit);
      const t = fromLocalInput(depositWhen);
      if (d.error) next.deposit = d.error;
      if (t === undefined) next.depositWhen = "When did you make this deposit?";
      if (d.zat !== undefined && t !== undefined) own = { amount: d.zat, time: t };
    }
    setErrors(next);
    if (Object.keys(next).length || a.zat === undefined || time === undefined) return;
    setBusy(true);
    try {
      const result = await engine.check(
        { amount: a.zat, time, ...(destination.trim() ? { destination: destination.trim() } : {}) },
        own,
      );
      setChecked({ result, amount: a.zat, time, ...(own ? { own } : {}) });
    } catch (err) {
      setErrors({ form: (err as Error).message });
      setChecked(undefined);
    } finally {
      setBusy(false);
    }
  };

  // Arriving from the landing page with an amount: check it straight away once data is ready.
  const autoRan = useRef(false);
  useEffect(() => {
    if (state.status === "ready" && route.params.get("amount") && !autoRan.current) {
      autoRan.current = true;
      void run();
    }
  }, [state.status]);

  useEffect(() => {
    if (checked) resultRef.current?.focus();
  }, [checked]);

  const ready = state.status === "ready";
  return (
    <div className="page">
      <div className="container">
        <header className="page-head">
          <span className="eyebrow">Pre-flight Check</span>
          <h1>Would this withdrawal give you away?</h1>
          <p className="lead">
            Enter what you plan to withdraw and what you deposited. Turnstile checks whether amount
            and timing would let an observer connect the two.
          </p>
          <DataStatus />
        </header>

        <div className="tool-grid">
          <form
            className="card form-card"
            onSubmit={run}
            noValidate
            aria-describedby="privacy-note"
          >
            <fieldset className="fieldset">
              <legend>Your withdrawal</legend>
              <div className="field">
                <label htmlFor="amount">Amount to withdraw (ZEC)</label>
                <input
                  id="amount"
                  className="input"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="e.g. 2.5"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  aria-invalid={errors.amount ? true : undefined}
                  aria-describedby={errors.amount ? "amount-error" : undefined}
                />
                {errors.amount && (
                  <span id="amount-error" className="error-text">
                    {errors.amount}
                  </span>
                )}
              </div>
              <div className="field">
                <label htmlFor="when">When</label>
                <input
                  id="when"
                  className="input"
                  type="datetime-local"
                  value={when}
                  onChange={(e) => setWhen(e.target.value)}
                  aria-invalid={errors.when ? true : undefined}
                  aria-describedby={errors.when ? "when-error" : "when-hint"}
                />
                <span id="when-hint" className="hint">
                  In your local time. Defaults to now.
                </span>
                {errors.when && (
                  <span id="when-error" className="error-text">
                    {errors.when}
                  </span>
                )}
              </div>
            </fieldset>

            <fieldset className="fieldset highlight">
              <legend>Your deposit into the pool</legend>
              <p className="hint" id="deposit-why">
                This is what catches the real risk: a withdrawal that is your deposit minus fees.
                Leave it empty to see what an observer would conclude without it.
              </p>
              <div className="row-2">
                <div className="field">
                  <label htmlFor="deposit">Amount (ZEC)</label>
                  <input
                    id="deposit"
                    className="input"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="e.g. 2.5003"
                    value={deposit}
                    onChange={(e) => setDeposit(e.target.value)}
                    aria-invalid={errors.deposit ? true : undefined}
                    aria-describedby={errors.deposit ? "deposit-error" : "deposit-why"}
                  />
                  {errors.deposit && (
                    <span id="deposit-error" className="error-text">
                      {errors.deposit}
                    </span>
                  )}
                </div>
                <div className="field">
                  <label htmlFor="deposit-when">When</label>
                  <input
                    id="deposit-when"
                    className="input"
                    type="datetime-local"
                    value={depositWhen}
                    onChange={(e) => setDepositWhen(e.target.value)}
                    aria-invalid={errors.depositWhen ? true : undefined}
                    aria-describedby={errors.depositWhen ? "deposit-when-error" : undefined}
                  />
                  {errors.depositWhen && (
                    <span id="deposit-when-error" className="error-text">
                      {errors.depositWhen}
                    </span>
                  )}
                </div>
              </div>
            </fieldset>

            <div className="field">
              <label htmlFor="destination">Destination address (optional)</label>
              <input
                id="destination"
                className="input"
                autoComplete="off"
                spellCheck={false}
                placeholder="t1..."
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                aria-describedby="destination-hint"
              />
              <span id="destination-hint" className="hint">
                Hashed on this device and compared locally. It is never sent anywhere.
              </span>
            </div>

            {errors.form && (
              <p className="error-text" role="alert">
                {errors.form}
              </p>
            )}
            <button className="btn btn-primary" type="submit" disabled={!ready || busy}>
              {busy ? "Checking..." : "Check withdrawal"}
            </button>
            <p id="privacy-note" className="data-note">
              <ShieldCheck size={16} />
              Runs on this device against the downloaded snapshot. Nothing you enter is sent.
            </p>
          </form>

          <section aria-live="polite" aria-label="Result">
            {checked ? (
              <Result checked={checked} headingRef={resultRef} />
            ) : (
              <div className="card placeholder">
                <ShieldCheck size={36} />
                <p>Your result appears here.</p>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function Result({
  checked,
  headingRef,
}: {
  checked: Checked;
  headingRef: RefObject<HTMLHeadingElement | null>;
}): ReactNode {
  const { result, amount, time, own } = checked;
  const planHref = href("/plan", {
    total: zec(amount).replace(" ZEC", ""),
    deposit: own ? zec(own.amount).replace(" ZEC", "") : undefined,
    depositAt: own ? new Date(own.time * 1000).toISOString() : undefined,
  });
  return (
    <div className="result-stack">
      <h2 ref={headingRef} tabIndex={-1} className="visually-hidden">
        Result for {zec(amount)} at {dateTime(time)}
      </h2>
      <VerdictBanner verdict={result.verdict} />
      <ReasonList reasons={result.reasons} />
      <dl className="facts">
        <div>
          <dt>Others who could have funded it</dt>
          <dd>{result.crowd}</dd>
        </div>
        {result.matchedDeposit && (
          <div>
            <dt>Deposit an observer would pick</dt>
            <dd>{zec(result.matchedDeposit.amount)}</dd>
          </div>
        )}
        <div>
          <dt>Withdrawal</dt>
          <dd>{zec(amount)}</dd>
        </div>
      </dl>
      {result.verdict !== "green" && (
        <div className="actions">
          <a className="btn btn-primary" href={planHref}>
            Plan a safer exit <ArrowRight size={18} />
          </a>
          {result.suggestedAmount !== undefined && (
            <a
              className="btn btn-ghost"
              href={href("/check", { amount: zec(result.suggestedAmount).replace(" ZEC", "") })}
            >
              Check {zec(result.suggestedAmount)} instead
            </a>
          )}
        </div>
      )}
    </div>
  );
}
