import { useState, type FormEvent, type ReactNode } from "react";
import { href, Tag } from "../components";
import { useEngine } from "../engine";
import { day, percent } from "../format";
import { ArrowRight, Chart, Check, Code, Database, Eye, Lock, Route, ShieldCheck } from "../icons";

const REPO = "https://github.com/daodudestiny56-netizen/turnstile";

function HeroCards(): ReactNode {
  const { state } = useEngine();
  const services =
    state.status === "ready"
      ? state.info.stats.services.byPrecision["6-8 decimals"]?.observed.rate
      : undefined;
  return (
    <div className="hero-cards" aria-label="What Turnstile does">
      <article className="card feature-card">
        <span className="icon-tile">
          <ShieldCheck />
        </span>
        <h3>Pre-flight Check</h3>
        <p>Before you withdraw, see whether amount and timing would single out your deposit.</p>
        <div>
          <Tag verdict="red">Exact round trip</Tag>
        </div>
      </article>
      <article className="card feature-card">
        <span className="icon-tile">
          <Route />
        </span>
        <h3>Exit Planner</h3>
        <p>Split a withdrawal into common amounts at ordinary times, so each part blends in.</p>
        <div>
          <Tag verdict="green">4 legs, each in a crowd</Tag>
        </div>
      </article>
      <article className="card feature-card glow">
        <span className="icon-tile">
          <Chart />
        </span>
        <h3>Leak Meter</h3>
        <p>
          {services !== undefined
            ? `${percent(services)} of precise-amount withdrawals trace back to a service's deposit.`
            : "How often Zcash withdrawals trace back to their deposit, measured on mainnet."}
        </p>
      </article>
    </div>
  );
}

function Hero(): ReactNode {
  const [amount, setAmount] = useState("");
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    window.location.hash = href("/check", { amount: amount.trim() }).slice(1);
  };
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="container hero-grid">
        <div>
          <a className="pill" href={href("/meter")}>
            Measured on 90 days of Zcash mainnet <ArrowRight size={14} />
          </a>
          <h1 id="hero-title">Leave the shielded pool without leaving a trail.</h1>
          <p className="lead">
            Zcash hides you inside the shielded pool, but every deposit into it and withdrawal from
            it is public. Turnstile checks your withdrawal against real network activity, on your
            own device, before you make it.
          </p>
          <form className="hero-form" onSubmit={submit} role="search" aria-label="Quick check">
            <label htmlFor="hero-amount" className="visually-hidden">
              Amount to withdraw, in ZEC
            </label>
            <input
              id="hero-amount"
              className="input"
              inputMode="decimal"
              autoComplete="off"
              placeholder="Amount to withdraw, e.g. 2.5 ZEC"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <button className="btn btn-primary" type="submit">
              Check it <ArrowRight size={18} />
            </button>
          </form>
          <p className="hero-note">
            Nothing you type leaves this page. The check runs against a public data file every
            visitor downloads.
          </p>
        </div>
        <HeroCards />
      </div>
    </section>
  );
}

function Stats(): ReactNode {
  const { state } = useEngine();
  const ready = state.status === "ready" ? state.info : undefined;
  const services = ready?.stats.services.byPrecision["6-8 decimals"];
  return (
    <div className="container">
      <section className="stats-band" aria-labelledby="stats-title">
        <h2 id="stats-title">Where Zcash withdrawals get traced, and where they don't.</h2>
        <div className="stat">
          <span className="stat-value">
            {services ? percent(services.observed.rate, 0) : "..."}
          </span>
          <span className="stat-label">
            of precise-amount withdrawals trace back to a service's deposit
            {services
              ? `, against ${percent(Math.max(services.reversed.rate, services.shifted.rate))} by chance`
              : ""}
          </span>
        </div>
        <div className="stat">
          <span className="stat-value">100%</span>
          <span className="stat-label">
            of exact round trips on an unused amount caught, in 1,269 planted tests
          </span>
        </div>
        <div className="stat">
          <span className="stat-value">0</span>
          <span className="stat-label">requests sent while you check, plan or audit</span>
        </div>
      </section>
      {ready && (
        <p className="data-note" style={{ marginTop: 12 }}>
          Live figures from the snapshot covering {day(ready.dataFrom)} to {day(ready.dataTo - 1)}.
        </p>
      )}
    </div>
  );
}

function HowItWorks(): ReactNode {
  const steps = [
    {
      icon: <Database />,
      title: "Measure the doors",
      body: "Every deposit into and withdrawal from the shielded pool over 90 days, derived from public data and verified against a Zcash node.",
    },
    {
      icon: <ShieldCheck />,
      title: "Check your withdrawal",
      body: "Tell Turnstile what you plan to withdraw and, ideally, what you deposited. It says whether an observer could connect the two.",
    },
    {
      icon: <Route />,
      title: "Plan an exit that blends in",
      body: "If it's risky, the planner splits it into common amounts at ordinary times and keeps what wouldn't blend in shielded.",
    },
  ];
  return (
    <section className="section" id="how" aria-labelledby="how-title">
      <div className="container">
        <div className="section-head">
          <span className="eyebrow">How it works</span>
          <h2 id="how-title">Three steps, all on your device</h2>
          <p className="lead">
            The shielded pool can't be seen into. Turnstile only uses what anyone can see: the
            amounts and times at its edges.
          </p>
        </div>
        <div className="grid-3">
          {steps.map((s, i) => (
            <article key={s.title} className="card feature-card">
              <span className="icon-tile">{s.icon}</span>
              <span className="step-number">Step {i + 1}</span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function BeforeAndAfter(): ReactNode {
  return (
    <section className="section" aria-labelledby="both-ends-title">
      <div className="container">
        <div className="section-head">
          <span className="eyebrow">Both ends of the trip</span>
          <h2 id="both-ends-title">Plan the way in. Audit what's already happened.</h2>
          <p className="lead">
            A leak needs two matching crossings. Turnstile helps with the deposit before you make
            it, and shows which of your past crossings already line up.
          </p>
        </div>
        <div className="grid-2">
          <article className="card feature-card">
            <span className="icon-tile">
              <Database />
            </span>
            <h3>Entry Planner</h3>
            <p>
              A precise deposit nobody else makes is a fingerprint. See whether yours would be one,
              and how to deposit so that it isn't.
            </p>
            <a className="btn btn-ghost" href={href("/enter")}>
              Plan a deposit <ArrowRight size={18} />
            </a>
          </article>
          <article className="card feature-card">
            <span className="icon-tile">
              <Eye />
            </span>
            <h3>Personal Audit</h3>
            <p>
              Enter your transparent addresses and see which of your past withdrawals an observer
              could trace back to your deposits.
            </p>
            <a className="btn btn-ghost" href={href("/audit")}>
              Audit your addresses <ArrowRight size={18} />
            </a>
          </article>
        </div>
      </div>
    </section>
  );
}

function Finding(): ReactNode {
  return (
    <section className="section" aria-labelledby="finding-title">
      <div className="container grid-2">
        <div className="section-head" style={{ marginBottom: 0 }}>
          <span className="eyebrow">What the data shows</span>
          <h2 id="finding-title">The average looks safe. The individual may not be.</h2>
          <p className="lead">
            Across all users, withdrawals traced to people are no more common than coincidence. But
            withdraw exactly what you deposited, on an amount nobody else used recently, and you are
            found every time. Services leak too: their precise amounts trace straight back.
          </p>
          <div className="actions" style={{ marginTop: 8 }}>
            <a className="btn btn-primary" href={href("/check")}>
              Check a withdrawal <ArrowRight size={18} />
            </a>
            <a className="btn btn-ghost" href={href("/meter")}>
              See the Leak Meter
            </a>
          </div>
        </div>
        <div className="card feature-card">
          <h3>Why the check has to be personal</h3>
          <ul className="check-list">
            <li>
              <Check />
              <span>
                <strong>Round amounts hide.</strong> 1 ZEC is withdrawn by dozens of people a week;
                an observer can't tell which one you are.
              </span>
            </li>
            <li>
              <Check />
              <span>
                <strong>Precise amounts don't.</strong> 2.8374 in and 2.8371 out, a few hours apart,
                is one person, and it takes seconds to see.
              </span>
            </li>
            <li>
              <Check />
              <span>
                <strong>Reused addresses are worse.</strong> Withdrawing to the address you
                deposited from links the two whatever the amount.
              </span>
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}

function Privacy(): ReactNode {
  const items = [
    {
      icon: <Eye />,
      title: "Download everything, ask nothing",
      body: "Every visitor downloads the same public files, about 2 MB. Your amounts and addresses are compared on your device, so no server can learn them.",
    },
    {
      icon: <Lock />,
      title: "No keys, ever",
      body: "Turnstile never asks for a seed phrase and never signs anything. You pay from your own wallet.",
    },
    {
      icon: <ShieldCheck />,
      title: "Verified before use",
      body: "Every file is checked against published SHA-256 hashes. A single altered byte is rejected.",
    },
    {
      icon: <Code />,
      title: "Open and reproducible",
      body: "Anyone can rebuild the data from public sources and get the same bytes.",
    },
  ];
  return (
    <section className="section" aria-labelledby="privacy-title">
      <div className="container">
        <div className="section-head">
          <span className="eyebrow">Privacy by construction</span>
          <h2 id="privacy-title">A privacy tool that can't leak what you tell it</h2>
        </div>
        <div className="grid-2">
          {items.map((i) => (
            <article key={i.title} className="card feature-card">
              <span className="icon-tile">{i.icon}</span>
              <h3>{i.title}</h3>
              <p>{i.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function Cta(): ReactNode {
  return (
    <section className="section" aria-labelledby="cta-title">
      <div className="container">
        <div className="cta-band">
          <h2 id="cta-title">About to withdraw? Check it first. It takes ten seconds.</h2>
          <div className="actions">
            <a className="btn btn-primary" href={href("/check")}>
              Check a withdrawal <ArrowRight size={18} />
            </a>
            <a className="btn btn-ghost" href={REPO} rel="noreferrer">
              Read the code
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

export function Landing(): ReactNode {
  return (
    <>
      <Hero />
      <Stats />
      <HowItWorks />
      <BeforeAndAfter />
      <Finding />
      <Privacy />
      <Cta />
    </>
  );
}
