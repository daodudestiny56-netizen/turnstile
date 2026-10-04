import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
  lazy,
  Suspense,
} from "react";
import { planVerdict, type OwnDeposit } from "@turnstile/core";
import { DataStatus, ReasonList, Tag, VerdictBanner, type Route } from "../components";
import { useEngine, useLatest } from "../engine";
import { dateTime, fromLocalInput, nowSec, toLocalInput, zec } from "../format";
import { Download, Refresh, Route as RouteIcon } from "../icons";
import { parseAmountInput, useForgetParams } from "../inputs";
import type { PlanResult } from "../protocol";
// Only someone executing a leg needs the swap client and the QR encoder: load them on demand.
const ExecutePanel = lazy(() => import("./Execute").then((m) => ({ default: m.ExecutePanel })));

/** A fresh random seed per plan, so different people's schedules never line up. */
function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! % 2 ** 31;
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
  const [errors, setErrors] = useState<{
    total?: string;
    start?: string;
    deposit?: string;
    depositWhen?: string;
    form?: string;
  }>({});
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PlanResult & { inputs: string; id: number }>();
  // While a deposit address is open for one of the legs, the plan must not change underneath it.
  const [liveOpen, setLiveOpen] = useState(false);
  const planCount = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const latest = useLatest();
  useForgetParams(route);
  const inputs = JSON.stringify([total, start, hours, legs, deposit, depositWhen]);

  const run = async (e?: FormEvent): Promise<void> => {
    e?.preventDefault();
    if (liveOpen) return;
    const next: typeof errors = {};
    const t = parseAmountInput(total);
    const startSec = fromLocalInput(start);
    let own: OwnDeposit | undefined;
    if (t.error) next.total = t.error;
    if (startSec === undefined) next.start = "Choose when to start.";
    if (deposit.trim() || depositWhen) {
      const d = parseAmountInput(deposit);
      const dt = fromLocalInput(depositWhen);
      if (d.error) next.deposit = d.error;
      if (dt === undefined) next.depositWhen = "When did you make your deposit?";
      else if (startSec !== undefined && dt >= startSec) {
        next.depositWhen = "Your deposit has to be before the plan starts.";
      }
      if (d.zat !== undefined && dt !== undefined) own = { amount: d.zat, time: dt };
    }
    setErrors(next);
    if (Object.keys(next).length || t.zat === undefined || startSec === undefined) return;
    setBusy(true);
    try {
      const { current, value } = await latest(
        engine.plan({
          total: t.zat,
          start: startSec,
          horizonHours: Number(hours),
          maxLegs: Number(legs),
          seed: randomSeed(),
          ...(own ? { own } : {}),
        }),
      );
      if (current) setResult({ ...value, inputs, id: ++planCount.current });
    } catch (err) {
      setErrors({ form: (err as Error).message });
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
                aria-invalid={errors.total ? true : undefined}
                aria-describedby={errors.total ? "total-error" : undefined}
              />
              {errors.total && (
                <span id="total-error" className="error-text">
                  {errors.total}
                </span>
              )}
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
                  aria-invalid={errors.start ? true : undefined}
                  aria-describedby={errors.start ? "start-error" : undefined}
                />
                {errors.start && (
                  <span id="start-error" className="error-text">
                    {errors.start}
                  </span>
                )}
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
                    aria-invalid={errors.deposit ? true : undefined}
                    aria-describedby={errors.deposit ? "plan-deposit-error" : undefined}
                  />
                  {errors.deposit && (
                    <span id="plan-deposit-error" className="error-text">
                      {errors.deposit}
                    </span>
                  )}
                </div>
                <div className="field">
                  <label htmlFor="plan-deposit-when">When</label>
                  <input
                    id="plan-deposit-when"
                    className="input"
                    type="datetime-local"
                    value={depositWhen}
                    onChange={(e) => setDepositWhen(e.target.value)}
                    aria-invalid={errors.depositWhen ? true : undefined}
                    aria-describedby={errors.depositWhen ? "plan-deposit-when-error" : undefined}
                  />
                  {errors.depositWhen && (
                    <span id="plan-deposit-when-error" className="error-text">
                      {errors.depositWhen}
                    </span>
                  )}
                </div>
              </div>
            </fieldset>
            {errors.form && (
              <p className="error-text" role="alert">
                {errors.form}
              </p>
            )}
            <button className="btn btn-primary" type="submit" disabled={!ready || busy || liveOpen}>
              {busy ? "Planning..." : "Make a plan"}
            </button>
            {liveOpen && (
              <p className="hint" role="status">
                A deposit address is open for one of the withdrawals. Close it before changing the
                plan.
              </p>
            )}
          </form>

          <section aria-live="polite" aria-label="Plan">
            {result ? (
              <PlanView
                key={result.id}
                result={result}
                headingRef={headingRef}
                outdated={result.inputs !== inputs}
                onReshuffle={() => void run()}
                liveOpen={liveOpen}
                onLiveChange={setLiveOpen}
              />
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
  outdated,
  onReshuffle,
  liveOpen,
  onLiveChange,
}: {
  result: PlanResult;
  headingRef: RefObject<HTMLHeadingElement | null>;
  outdated: boolean;
  onReshuffle: () => void;
  liveOpen: boolean;
  onLiveChange: (live: boolean) => void;
}): ReactNode {
  const { plan, ics } = result;
  const [executing, setExecuting] = useState<number>();
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
      {outdated && (
        <p className="status-banner warning" role="status">
          You've changed the inputs since this plan. Make a plan again to update it.
        </p>
      )}
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
                <div className="leg-actions">
                  <Tag verdict={leg.check.verdict} />
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    aria-label={`Execute withdrawal ${i + 1}: ${zec(leg.amount)}`}
                    aria-expanded={executing === i}
                    disabled={liveOpen && executing !== i}
                    onClick={() => setExecuting(executing === i ? undefined : i)}
                  >
                    Execute
                  </button>
                </div>
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
        <button className="btn btn-ghost" type="button" onClick={onReshuffle} disabled={liveOpen}>
          <Refresh size={18} /> New random schedule
        </button>
      </div>
      {executing !== undefined && plan.legs[executing] && (
        <Suspense
          fallback={
            <p className="status-banner" role="status">
              <span className="spinner" aria-hidden="true" />
              Loading...
            </p>
          }
        >
          <ExecutePanel
            key={executing}
            leg={plan.legs[executing]!}
            index={executing}
            count={plan.legs.length}
            onClose={() => setExecuting(undefined)}
            onLiveChange={onLiveChange}
          />
        </Suspense>
      )}
      <p className="data-note">
        Times are random for each plan so that people using Turnstile don't all withdraw at the same
        moments. Execute sends one withdrawal at a time through NEAR Intents: nothing is contacted
        until you ask for a price.
      </p>
    </div>
  );
}
