import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { EntryAdvice, EntryCode } from "@turnstile/core";
import { DataStatus, href, Tag, VerdictBanner } from "../components";
import { useEngine, useLatest } from "../engine";
import { fromLocalInput, nowSec, toLocalInput, zec } from "../format";
import { ArrowRight, Database, ShieldCheck } from "../icons";
import { parseAmountInput } from "../inputs";

const TITLES: Record<EntryCode, string> = {
  "unique-entry": "Unique amount",
  "thin-entry": "Thin crowd",
  "common-entry": "Common amount",
  "no-common-amount": "Nothing common fits",
  "stale-data": "Data may be out of date",
};

const VERDICTS = {
  red: {
    title: "Red: this deposit would be a fingerprint",
    body: "Nobody else deposits this amount, so it would point back at you later.",
  },
  amber: {
    title: "Amber: few others deposit this amount",
    body: "It wouldn't stand out completely, but the crowd around it is thin.",
  },
  green: {
    title: "Green: this amount blends in",
    body: "Many others deposit about the same. Timing still matters when you withdraw.",
  },
};

interface Planned {
  advice: EntryAdvice;
  inputs: string;
}

export function EnterPage(): ReactNode {
  const { state, engine } = useEngine();
  const [amount, setAmount] = useState("");
  const [when, setWhen] = useState(() => toLocalInput(nowSec()));
  const [errors, setErrors] = useState<{ amount?: string; when?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const [planned, setPlanned] = useState<Planned>();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const latest = useLatest();
  const inputs = JSON.stringify([amount, when]);

  const run = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const a = parseAmountInput(amount);
    const time = fromLocalInput(when);
    const next: typeof errors = {};
    if (a.error) next.amount = a.error;
    if (time === undefined) next.when = "Choose when you plan to deposit.";
    setErrors(next);
    if (a.zat === undefined || time === undefined) return;
    setBusy(true);
    try {
      const { current, value } = await latest(engine.entry(a.zat, time));
      if (current) setPlanned({ advice: value, inputs });
    } catch (err) {
      setErrors({ form: (err as Error).message });
      setPlanned(undefined);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (planned) headingRef.current?.focus();
  }, [planned]);

  const ready = state.status === "ready";
  return (
    <div className="page">
      <div className="container">
        <header className="page-head">
          <span className="eyebrow">Entry Planner</span>
          <h1>Deposit without leaving a fingerprint</h1>
          <p className="lead">
            Half of every round-trip leak is made on the way in. Before you move ZEC into the
            shielded pool, see whether the amount would single you out later, and what to do
            instead.
          </p>
          <DataStatus />
        </header>

        <div className="tool-grid">
          <form className="card form-card" onSubmit={run} noValidate aria-describedby="enter-note">
            <div className="field">
              <label htmlFor="enter-amount">Amount you're about to deposit (ZEC)</label>
              <input
                id="enter-amount"
                className="input"
                inputMode="decimal"
                autoComplete="off"
                placeholder="e.g. 3.1742"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-invalid={errors.amount ? true : undefined}
                aria-describedby={errors.amount ? "enter-amount-error" : "enter-amount-hint"}
              />
              <span id="enter-amount-hint" className="hint">
                What's on your transparent address or about to leave the exchange, fee included.
              </span>
              {errors.amount && (
                <span id="enter-amount-error" className="error-text">
                  {errors.amount}
                </span>
              )}
            </div>
            <div className="field">
              <label htmlFor="enter-when">When</label>
              <input
                id="enter-when"
                className="input"
                type="datetime-local"
                value={when}
                onChange={(e) => setWhen(e.target.value)}
                aria-invalid={errors.when ? true : undefined}
                aria-describedby={errors.when ? "enter-when-error" : "enter-when-hint"}
              />
              <span id="enter-when-hint" className="hint">
                In your local time. Defaults to now.
              </span>
              {errors.when && (
                <span id="enter-when-error" className="error-text">
                  {errors.when}
                </span>
              )}
            </div>
            {errors.form && (
              <p className="error-text" role="alert">
                {errors.form}
              </p>
            )}
            <button className="btn btn-primary" type="submit" disabled={!ready || busy}>
              {busy ? "Checking..." : "Check deposit"}
            </button>
            <p id="enter-note" className="data-note">
              <ShieldCheck size={16} />
              Runs on this device against the downloaded snapshot. Nothing you enter is sent.
            </p>
          </form>

          <section aria-live="polite" aria-label="Result">
            {planned ? (
              <div className="result-stack">
                <h2 ref={headingRef} tabIndex={-1} className="visually-hidden">
                  Result for a deposit of {zec(planned.advice.balance)}
                </h2>
                {planned.inputs !== inputs && (
                  <p className="status-banner warning" role="status">
                    You've changed the inputs since this result. Check again to update it.
                  </p>
                )}
                <EntryResult advice={planned.advice} />
              </div>
            ) : (
              <div className="card placeholder">
                <Database size={36} />
                <p>Your result appears here.</p>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function EntryResult({ advice }: { advice: EntryAdvice }): ReactNode {
  const copy = VERDICTS[advice.verdict];
  return (
    <>
      <VerdictBanner verdict={advice.verdict} title={copy.title} body={copy.body} />
      <ul className="reasons">
        {advice.reasons.map((r) => (
          <li key={r.code}>
            <div>
              <Tag verdict={r.severity}>{TITLES[r.code]}</Tag>
            </div>
            <p>{r.message}</p>
          </li>
        ))}
      </ul>
      <dl className="facts">
        <div>
          <dt>Others who deposited about this amount in the week before</dt>
          <dd>{advice.asIs.crowd}</dd>
        </div>
        {advice.common && (
          <div>
            <dt>Common amount that fits</dt>
            <dd>{zec(advice.common.amount)}</dd>
          </div>
        )}
      </dl>
      <div className="card">
        <h3 className="card-title">What to do</h3>
        <ol className="advice numbered">
          {advice.advice.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ol>
      </div>
      <div className="actions">
        <a className="btn btn-primary" href={href("/plan")}>
          Open the Exit Planner <ArrowRight size={18} />
        </a>
        <a className="btn btn-ghost" href={href("/audit")}>
          Audit past activity
        </a>
      </div>
    </>
  );
}
