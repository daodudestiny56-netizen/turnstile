import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import { parsePositiveZec, planVerdict, type OwnDeposit } from "@turnstile/core";
import { DataStatus, ReasonList, Tag, VerdictBanner, type Route } from "../components";
import { useEngine } from "../engine";
import { dateTime, fromLocalInput, nowSec, toLocalInput, zec } from "../format";
import { Download, Refresh, Route as RouteIcon } from "../icons";
import type { PlanResult } from "../protocol";

/** A fresh random seed per plan, so different people's schedules never line up. */
function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! % 2 ** 31;
}

function amountOrError(value: string): { zat?: number; error?: string } {
  try {
    return { zat: parsePositiveZec(value) };
  } catch (e) {
    return { error: (e as Error).message.replace(/^Invalid ZEC amount "[^"]*": /, "") };
  }
}

export function PlanPage({ route }: { route: Route }): ReactNode {
  const { state, engine } = useEngine();
  const [total, setTotal] = useState(route.params.get("total") ?? "");
  const [start, setStart] = useState(() => toLocalInput(nowSec()));
  const [hours, setHours] = useState("48");
  const [legs, setLegs] = useState("4");
  const [deposit, setDeposit] = useState(route.params.get("deposit") ?? "");
  const [depositWhen, setDepositWhen] = useState(() => {
    const at = Date.parse(route.params.get("depositAt") ?? "");
    return Number.isNaN(at) ? "" : toLocalInput(Math.floor(at / 1000));
  });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PlanResult>();
  const headingRef = useRef<HTMLHeadingElement>(null);

  const run = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault();
    const t = amountOrError(total);
    const startSec = fromLocalInput(start);
    let own: OwnDeposit | undefined;
    if (t.error) return setError(`Total: ${t.error}`);
    if (startSec === undefined) return setError("Choose when to start.");
    if (deposit.trim() || depositWhen) {
      const d = amountOrError(deposit);
      const dt = fromLocalInput(depositWhen);
      if (d.error) return setError(`Deposit: ${d.error}`);
      if (dt === undefined) return setError("When did you make your deposit?");
      own = { amount: d.zat!, time: dt };
    }
    setError(undefined);
    setBusy(true);
    try {
      setResult(
        await engine.plan({
          total: t.zat!,
          start: startSec,
          horizonHours: Number(hours),
          maxLegs: Number(legs),
          seed: randomSeed(),
          ...(own ? { own } : {}),
        }),
      );
    } catch (err) {
      setError((err as Error).message);
      setResult(undefined);
    } finally {
      setBusy(false);
    }
  };

  const autoRan = useRef(false);
  useEffect(() => {
    if (state.status === "ready" && route.params.get("total") && !autoRan.current) {
      autoRan.current = true;
      void run();
    }
  }, [state.status]);

  useEffect(() => {
    if (result) headingRef.current?.focus();
  }, [result]);

  const ready = state.status === "ready";
  return (
    <div className="page">
      <div className="container">
        <header className="page-head">
          <span className="eyebrow">Exit Planner</span>
          <h1>Split a withdrawal so each part blends in</h1>
          <p className="lead">
            The planner picks amounts that many other people also withdraw, spreads them over
            ordinary hours, and keeps what wouldn't blend in shielded.
          </p>
          <DataStatus />
        </header>

        <div className="tool-grid">
          <form className="card form-card" onSubmit={run} noValidate>
            <div className="field">
              <label htmlFor="total">Total to take out (ZEC)</label>
              <input
                id="total"
                className="input"
                inputMode="decimal"
                autoComplete="off"
                placeholder="e.g. 12.75"
                value={total}
                onChange={(e) => setTotal(e.target.value)}
              />
            </div>
            <div className="row-2">
              <div className="field">
                <label htmlFor="start">Start</label>
                <input
                  id="start"
                  className="input"
                  type="datetime-local"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="hours">Spread over</label>
                <select
                  id="hours"
                  className="input"
                  value={hours}
                  onChange={(e) => setHours(e.target.value)}
                >
                  <option value="24">1 day</option>
                  <option value="48">2 days</option>
                  <option value="72">3 days</option>
                  <option value="120">5 days</option>
                </select>
              </div>
            </div>
            <div className="field">
              <label htmlFor="legs">Most withdrawals</label>
              <select
                id="legs"
                className="input"
                value={legs}
                onChange={(e) => setLegs(e.target.value)}
              >
                {[2, 3, 4, 6, 8].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
            <fieldset className="fieldset highlight">
              <legend>Your deposit into the pool (recommended)</legend>
              <div className="row-2">
                <div className="field">
                  <label htmlFor="plan-deposit">Amount (ZEC)</label>
                  <input
                    id="plan-deposit"
                    className="input"
                    inputMode="decimal"
                    autoComplete="off"
                    value={deposit}
                    onChange={(e) => setDeposit(e.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="plan-deposit-when">When</label>
                  <input
                    id="plan-deposit-when"
                    className="input"
                    type="datetime-local"
                    value={depositWhen}
                    onChange={(e) => setDepositWhen(e.target.value)}
                  />
                </div>
              </div>
            </fieldset>
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
            <button className="btn btn-primary" type="submit" disabled={!ready || busy}>
              {busy ? "Planning..." : "Make a plan"}
            </button>
          </form>

          <section aria-live="polite" aria-label="Plan">
            {result ? (
              <PlanView result={result} headingRef={headingRef} onReshuffle={() => void run()} />
            ) : (
              <div className="card placeholder">
                <RouteIcon size={36} />
                <p>Your plan appears here.</p>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function PlanView({
  result,
  headingRef,
  onReshuffle,
}: {
  result: PlanResult;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onReshuffle: () => void;
}): ReactNode {
  const { plan, ics } = result;
  const verdict = plan.legs.length ? planVerdict(plan) : "amber";
  const download = (): void => {
    const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "turnstile-exit-plan.ics";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="result-stack">
      <h2 ref={headingRef} tabIndex={-1} className="visually-hidden">
        Exit plan for {zec(plan.options.total)}
      </h2>
      <div className="compare">
        <div className="card">
          <p className="hint">All at once</p>
          <p className="leg-amount">{zec(plan.options.total)}</p>
          <div style={{ marginTop: 10 }}>
            <Tag verdict={plan.singleExit.verdict} />
          </div>
        </div>
        <div className="card">
          <p className="hint">With this plan</p>
          <p className="leg-amount">
            {plan.legs.length} withdrawal{plan.legs.length === 1 ? "" : "s"}, {zec(plan.withdrawn)}
          </p>
          <div style={{ marginTop: 10 }}>
            <Tag verdict={verdict} />
          </div>
        </div>
      </div>

      {plan.legs.length > 0 && (
        <div className="card">
          <h3 style={{ fontSize: 18, marginBottom: 14 }}>The plan</h3>
          <ol className="legs">
            {plan.legs.map((leg, i) => (
              <li key={i} className="leg">
                <span className="leg-index" aria-hidden="true">
                  {i + 1}
                </span>
                <div>
                  <div className="leg-amount">{zec(leg.amount)}</div>
                  <div className="leg-meta">
                    {dateTime(leg.time)} · hides among {leg.crowd} others
                  </div>
                </div>
                <Tag verdict={leg.check.verdict} />
              </li>
            ))}
          </ol>
        </div>
      )}

      {plan.legs.some((l) => l.check.verdict !== "green") && (
        <details className="card">
          <summary>Why some withdrawals aren't green</summary>
          <div style={{ marginTop: 12 }}>
            <ReasonList
              reasons={plan.legs
                .flatMap((l) => l.check.reasons)
                .filter(
                  (r, i, all) =>
                    r.severity !== "green" && all.findIndex((x) => x.code === r.code) === i,
                )}
            />
          </div>
        </details>
      )}

      {plan.singleExit.verdict === "red" && plan.legs.length > 0 && verdict === "green" && (
        <VerdictBanner
          verdict="green"
          headingLevel={3}
          title="The plan turns a red withdrawal green"
          body="Each part uses an amount many others withdraw, at an ordinary time."
        />
      )}

      <div className="card">
        <h3 style={{ fontSize: 18, marginBottom: 10 }}>Before you go</h3>
        <ul className="advice">
          {plan.advice.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      </div>

      <div className="actions">
        {plan.legs.length > 0 && (
          <button className="btn btn-primary" type="button" onClick={download}>
            <Download size={18} /> Calendar reminders (.ics)
          </button>
        )}
        <button className="btn btn-ghost" type="button" onClick={onReshuffle}>
          <Refresh size={18} /> New random schedule
        </button>
      </div>
      <p className="data-note">
        Times are random for each plan so that people using Turnstile don't all withdraw at the same
        moments. Executing each withdrawal through NEAR Intents arrives in the next release.
      </p>
    </div>
  );
}
