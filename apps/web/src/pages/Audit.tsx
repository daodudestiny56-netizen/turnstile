import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from "react";
import {
  AUDIT_MAX_ADDRESSES,
  AUDIT_MAX_EVENTS,
  splitAddresses,
  type AuditCode,
  type AuditFinding,
  type AuditResult,
} from "@turnstile/core";
import { DataStatus, href, Tag, VerdictBanner } from "../components";
import { useEngine, useLatest } from "../engine";
import { dateTime, day, zec } from "../format";
import { Alert, ArrowRight, Eye, ShieldCheck } from "../icons";

const TITLES: Record<AuditCode, string> = {
  traced: "Traced to your deposit",
  "address-reuse": "Address reuse",
  "singled-out": "Matches one deposit",
  "thin-crowd": "Thin crowd",
  "best-guess": "Closest in time",
  crowd: "Hidden in a crowd",
  "no-match": "No matching deposit",
  "too-early": "Too early to judge",
  "followed-to-yours": "Followed to your address",
  "followed-elsewhere": "Followed elsewhere",
  "not-followed": "Not followed",
  partial: "Partly covered",
};

const VERDICTS = {
  red: {
    title: "Red: some of your activity can be traced",
    body: "An observer could connect at least one of your withdrawals to your deposits.",
  },
  amber: {
    title: "Amber: some of it stands out",
    body: "Nothing is linked outright, but part of your activity is easy to single out.",
  },
  green: {
    title: "Green: nothing here traces back to you",
    body: "By amount, timing and address, none of this activity points at your deposits.",
  },
};

type AuditState = "waiting" | "loading" | "ready" | "error";

function useAuditIndex(): { status: AuditState; error?: string; retry: () => void } {
  const { state, engine } = useEngine();
  const [status, setStatus] = useState<AuditState>("waiting");
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (state.status !== "ready") return;
    let live = true;
    setStatus("loading");
    engine.auditReady().then(
      () => live && setStatus("ready"),
      (e: Error) => {
        if (!live) return;
        setError(e.message);
        setStatus("error");
      },
    );
    return () => {
      live = false;
    };
  }, [state.status, engine, attempt]);
  return { status, ...(error ? { error } : {}), retry: () => setAttempt((a) => a + 1) };
}

function Findings({ findings }: { findings: AuditFinding[] }): ReactNode {
  return (
    <ul className="reasons compact">
      {findings.map((f) => (
        <li key={f.code}>
          <div>
            <Tag verdict={f.severity}>{TITLES[f.code]}</Tag>
          </div>
          <p>{f.message}</p>
        </li>
      ))}
    </ul>
  );
}

export function AuditPage(): ReactNode {
  const { state, engine } = useEngine();
  const index = useAuditIndex();
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [audited, setAudited] = useState<{ result: AuditResult; inputs: string }>();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const latest = useLatest();

  const run = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const addresses = splitAddresses(text);
    if (addresses.length === 0) return setError("Enter at least one transparent address.");
    if (addresses.length > AUDIT_MAX_ADDRESSES) {
      return setError(`Enter at most ${AUDIT_MAX_ADDRESSES} addresses at a time.`);
    }
    setError(undefined);
    setBusy(true);
    try {
      const { current, value } = await latest(engine.audit(addresses));
      if (current) setAudited({ result: value, inputs: text });
    } catch (err) {
      setError((err as Error).message);
      setAudited(undefined);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (audited) headingRef.current?.focus();
  }, [audited]);

  const canRun = state.status === "ready" && index.status === "ready" && !busy;
  return (
    <div className="page">
      <div className="container">
        <header className="page-head">
          <span className="eyebrow">Personal Audit</span>
          <h1>Did your past withdrawals give you away?</h1>
          <p className="lead">
            Enter the transparent addresses you've deposited from and withdrawn to. Turnstile
            replays what an observer would see and tells you which crossings point back at you.
          </p>
          <DataStatus />
          {state.status === "ready" && index.status === "loading" && (
            <div className="status-banner" role="status">
              <span className="spinner" aria-hidden="true" />
              Downloading and verifying the audit index. Every visitor downloads it, so it says
              nothing about who runs an audit.
            </div>
          )}
          {index.status === "error" && (
            <div className="status-banner error" role="alert">
              <Alert size={18} />
              <span className="status-text">
                The audit index couldn't be loaded or failed verification. {index.error}
              </span>
              <button type="button" className="btn btn-ghost btn-small" onClick={index.retry}>
                Try again
              </button>
            </div>
          )}
        </header>

        <div className="tool-grid">
          <form className="card form-card" onSubmit={run} noValidate aria-describedby="audit-note">
            <div className="field">
              <label htmlFor="audit-addresses">Your transparent addresses</label>
              <textarea
                id="audit-addresses"
                className="input textarea"
                rows={6}
                autoComplete="off"
                spellCheck={false}
                placeholder={"t1...\nt1...\ntex1..."}
                value={text}
                onChange={(e) => setText(e.target.value)}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "audit-error audit-hint" : "audit-hint"}
              />
              <span id="audit-hint" className="hint">
                One per line, or separated by spaces or commas; up to {AUDIT_MAX_ADDRESSES}. Include
                the addresses your swaps paid into.
              </span>
              {error && (
                <span id="audit-error" className="error-text" role="alert">
                  {error}
                </span>
              )}
            </div>
            <button className="btn btn-primary" type="submit" disabled={!canRun}>
              {busy ? "Auditing..." : "Audit addresses"}
            </button>
            <p id="audit-note" className="data-note">
              <ShieldCheck size={16} />
              Addresses are hashed and looked up on this device. Nothing you enter is sent.
            </p>
          </form>

          <section aria-live="polite" aria-label="Result">
            {audited ? (
              <AuditView
                result={audited.result}
                outdated={audited.inputs !== text}
                headingRef={headingRef}
              />
            ) : (
              <div className="card placeholder">
                <Eye size={36} />
                <p>Your audit appears here.</p>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function AuditView({
  result,
  outdated,
  headingRef,
}: {
  result: AuditResult;
  outdated: boolean;
  headingRef: RefObject<HTMLHeadingElement | null>;
}): ReactNode {
  const s = result.summary;
  const copy = VERDICTS[result.verdict];
  const checked = result.addresses.filter((a) => !a.problem);
  const nothing = checked.length > 0 && s.withdrawals === 0 && s.deposits === 0;
  return (
    <div className="result-stack">
      <h2 ref={headingRef} tabIndex={-1} className="visually-hidden">
        Audit of {result.addresses.length} address{result.addresses.length === 1 ? "" : "es"}
      </h2>
      {outdated && (
        <p className="status-banner warning" role="status">
          You've changed the addresses since this audit. Audit again to update it.
        </p>
      )}
      {nothing ? (
        <div className="card">
          <h3 className="card-title">No crossings found</h3>
          <p>
            None of these addresses deposited into or withdrew from the shielded pool between{" "}
            {day(result.data.dataFrom)} and {day(result.data.dataTo - 1)}. Older activity isn't
            covered.
          </p>
        </div>
      ) : (
        checked.length > 0 && (
          <>
            <VerdictBanner verdict={result.verdict} title={copy.title} body={copy.body} />
            <dl className="facts">
              <div>
                <dt>Withdrawals traceable to you</dt>
                <dd>
                  {s.traced} of {s.withdrawals}
                </dd>
              </div>
              <div>
                <dt>Withdrawals tied to a deposit you didn't enter</dt>
                <dd>{s.singledOut}</dd>
              </div>
              <div>
                <dt>Deposits followed out of the pool</dt>
                <dd>
                  {s.followed} of {s.deposits}
                </dd>
              </div>
            </dl>
          </>
        )
      )}
      {result.truncated && (
        <p className="status-banner warning" role="status">
          These addresses have more activity than one audit covers: the {AUDIT_MAX_EVENTS} most
          recent deposits and withdrawals are audited.
        </p>
      )}

      <div className="card">
        <h3 className="card-title">Addresses</h3>
        <ul className="address-list">
          {result.addresses.map((a) => (
            <li key={a.input}>
              <code className="mono">{a.input}</code>
              {a.problem ? (
                <span className="error-text">{a.problem}</span>
              ) : (
                <span className="hint">
                  {a.address !== a.input ? `Checked as ${a.address}. ` : ""}
                  {a.deposits} deposit{a.deposits === 1 ? "" : "s"}, {a.withdrawals} withdrawal
                  {a.withdrawals === 1 ? "" : "s"}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>

      {result.withdrawals.length > 0 && (
        <div className="card">
          <h3 className="card-title">Withdrawals to your addresses</h3>
          <ol className="events">
            {result.withdrawals.map((w, i) => (
              <li key={i} className="event">
                <div className="event-head">
                  <div>
                    <div className="leg-amount">{zec(w.amount)}</div>
                    <div className="leg-meta">{dateTime(w.time)}</div>
                  </div>
                  {w.verdict ? (
                    <Tag verdict={w.verdict} />
                  ) : (
                    <span className="tag tag-neutral">Not judged</span>
                  )}
                </div>
                <Findings findings={w.findings} />
              </li>
            ))}
          </ol>
        </div>
      )}

      {result.deposits.length > 0 && (
        <div className="card">
          <h3 className="card-title">Deposits from your addresses</h3>
          <ol className="events">
            {result.deposits.map((d, i) => (
              <li key={i} className="event">
                <div className="event-head">
                  <div>
                    <div className="leg-amount">{zec(d.amount)}</div>
                    <div className="leg-meta">{dateTime(d.time)}</div>
                  </div>
                  <Tag verdict={d.verdict} />
                </div>
                <Findings findings={d.findings} />
              </li>
            ))}
          </ol>
        </div>
      )}

      {s.traced > 0 && (
        <div className="actions">
          <a className="btn btn-primary" href={href("/enter")}>
            Plan your next deposit <ArrowRight size={18} />
          </a>
          <a className="btn btn-ghost" href={href("/plan")}>
            Plan your next exit
          </a>
        </div>
      )}
      <p className="data-note">
        Covers {day(result.data.dataFrom)} to {day(result.data.dataTo - 1)}. For addresses you
        didn't enter, Turnstile says only that a link exists, never where it leads, so an audit
        can't be used to follow someone else's money.
      </p>
    </div>
  );
}
