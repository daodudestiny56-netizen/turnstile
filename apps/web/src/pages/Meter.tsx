import { useState, type ReactNode } from "react";
import { CROWD_BUCKETS, type Breakdown, type Comparison, type MeterStats } from "@turnstile/core";
import { DataStatus, href } from "../components";
import { useEngine } from "../engine";
import { day, percent } from "../format";
import { ArrowRight } from "../icons";

const BANDS: [key: string, label: string][] = [
  ["round (0-2 decimals)", "Round (0 to 2 decimals)"],
  ["3-5 decimals", "3 to 5 decimals"],
  ["6-8 decimals", "Precise (6 to 8 decimals)"],
];

const chance = (c: Comparison): number => Math.max(c.reversed.rate, c.shifted.rate);

const monthFmt = new Intl.DateTimeFormat(undefined, {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
/** "2026-07" -> "Jul 2026" */
const monthName = (key: string): string => monthFmt.format(new Date(`${key}-01T00:00:00Z`));

/** Round a maximum up to a readable scale end: 5%, 10%, 20%, 25%, 50%, 100%. */
function niceMax(v: number): number {
  for (const step of [0.05, 0.1, 0.2, 0.25, 0.5, 1]) if (v <= step) return step;
  return 1;
}

function beyond(c: Comparison): string {
  return c.excess > 0.001 ? `+${(100 * c.excess).toFixed(1)} points` : "none measurable";
}

function BulletRow({ label, c, max }: { label: string; c: Comparison; max: number }): ReactNode {
  const obs = c.observed.rate;
  const ref = chance(c);
  const summary =
    `${label}: ${percent(obs)} traced to their entry (${c.observed.linkable.toLocaleString()} of ` +
    `${c.observed.total.toLocaleString()}); ${percent(ref)} expected by chance; beyond chance ${beyond(c)}.`;
  return (
    <div className="bullet-row">
      <span className="bullet-label">{label}</span>
      <div className="bullet-track">
        <div className="bullet-plot">
          <div className="bullet-bar" style={{ width: `${(100 * obs) / max}%` }} />
          <div className="bullet-ref" style={{ left: `calc(${(100 * ref) / max}% - 1px)` }} />
          <div className="bullet-hit" tabIndex={0} role="img" aria-label={summary}>
            <div className="tooltip" aria-hidden="true">
              <strong>{label}</strong>
              <dl>
                <dt>Traced to entry</dt>
                <dd>{percent(obs)}</dd>
                <dt>Chance, reversed time</dt>
                <dd>{percent(c.reversed.rate)}</dd>
                <dt>Chance, shifted amount</dt>
                <dd>{percent(c.shifted.rate)}</dd>
                <dt>Beyond chance</dt>
                <dd>{beyond(c)}</dd>
                <dt>Withdrawals</dt>
                <dd>{c.observed.total.toLocaleString()}</dd>
              </dl>
            </div>
          </div>
        </div>
        <span className="bullet-value">{percent(obs)}</span>
      </div>
    </div>
  );
}

function BulletChart({
  title,
  subtitle,
  breakdown,
  max,
}: {
  title: string;
  subtitle: string;
  breakdown: Breakdown;
  max: number;
}): ReactNode {
  return (
    <div className="card chart-card">
      <div className="chart-head">
        <div>
          <h3>{title}</h3>
          <p className="hint">{subtitle}</p>
        </div>
        <div className="legend" aria-hidden="true">
          <span>
            <i className="swatch-bar" /> Traced to their entry
          </span>
          <span>
            <i className="swatch-ref" /> Expected by chance
          </span>
        </div>
      </div>
      <div className="bullet-rows">
        <BulletRow label="All withdrawals" c={breakdown} max={max} />
        {BANDS.map(([key, label]) => {
          const c = breakdown.byPrecision[key];
          return c ? <BulletRow key={key} label={label} c={c} max={max} /> : null;
        })}
      </div>
      <p className="hint">Scale 0 to {percent(max, 0)}. Hover or focus a bar for the numbers.</p>
    </div>
  );
}

function StatsTable({ stats }: { stats: MeterStats }): ReactNode {
  const rows: [string, string, Comparison | undefined][] = [];
  for (const [group, b] of [
    ["People", stats.people],
    ["Services", stats.services],
    ["Everyone", stats.all],
  ] as const) {
    rows.push([group, "All withdrawals", b]);
    for (const [key, label] of BANDS) rows.push([group, label, b.byPrecision[key]]);
  }
  return (
    <div className="card table-wrap">
      <table>
        <caption className="visually-hidden">
          Leak Meter results by group and amount precision
        </caption>
        <thead>
          <tr>
            <th scope="col">Traced to</th>
            <th scope="col">Withdrawal amount</th>
            <th scope="col">Traced</th>
            <th scope="col">Chance (reversed)</th>
            <th scope="col">Chance (shifted)</th>
            <th scope="col">Beyond chance</th>
            <th scope="col">Withdrawals</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([group, label, c]) =>
            c ? (
              <tr key={group + label}>
                <td>{group}</td>
                <td>{label}</td>
                <td>{percent(c.observed.rate)}</td>
                <td>{percent(c.reversed.rate)}</td>
                <td>{percent(c.shifted.rate)}</td>
                <td>{beyond(c)}</td>
                <td>{c.observed.total.toLocaleString()}</td>
              </tr>
            ) : null,
          )}
        </tbody>
      </table>
    </div>
  );
}

function CrowdChart({ stats }: { stats: MeterStats }): ReactNode {
  const max = Math.max(...CROWD_BUCKETS.map((b) => stats.crowd[b]));
  const labels: Record<string, string> = {
    "0": "No matching deposit",
    "1": "1 party",
    "2-5": "2 to 5 parties",
    "6-20": "6 to 20 parties",
    "21-100": "21 to 100 parties",
    "101+": "More than 100",
  };
  return (
    <div className="card chart-card">
      <div className="chart-head">
        <div>
          <h3>How many parties could have funded each withdrawal</h3>
          <p className="hint">The size of the crowd an observer would have to choose from.</p>
        </div>
      </div>
      <div className="bullet-rows">
        {CROWD_BUCKETS.map((b) => {
          const n = stats.crowd[b];
          const share = n / stats.evaluated;
          return (
            <div className="bullet-row" key={b}>
              <span className="bullet-label">{labels[b]}</span>
              <div className="bullet-track">
                <div className="bullet-plot">
                  <div className="bullet-bar" style={{ width: `${(100 * n) / max}%` }} />
                  <div
                    className="bullet-hit"
                    tabIndex={0}
                    role="img"
                    aria-label={`${labels[b]}: ${n.toLocaleString()} withdrawals, ${percent(share)}`}
                  >
                    <div className="tooltip" aria-hidden="true">
                      <strong>{labels[b]}</strong>
                      <dl>
                        <dt>Withdrawals</dt>
                        <dd>{n.toLocaleString()}</dd>
                        <dt>Share</dt>
                        <dd>{percent(share)}</dd>
                      </dl>
                    </div>
                  </div>
                </div>
                <span className="bullet-value">{percent(share, 0)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function MeterPage(): ReactNode {
  const { state } = useEngine();
  const [asTable, setAsTable] = useState(false);
  const info = state.status === "ready" ? state.info : undefined;
  const stats = info?.stats;
  const max = stats
    ? niceMax(
        Math.max(
          ...[stats.people, stats.services].flatMap((b) => [
            b.observed.rate,
            chance(b),
            ...Object.values(b.byPrecision).flatMap((c) => [c.observed.rate, chance(c)]),
          ]),
        ),
      )
    : 0.2;
  const servicesPrecise = stats?.services.byPrecision["6-8 decimals"];
  const months = stats ? Object.keys(stats.all.byMonth) : [];

  return (
    <div className="page">
      <div className="container">
        <header className="page-head">
          <span className="eyebrow">Leak Meter</span>
          <h1>How often withdrawals trace back to their deposit</h1>
          <p className="lead">
            Every withdrawal in the data, scored the way an observer would, and compared with two
            independent measures of how often that happens by pure chance.
          </p>
          <DataStatus />
        </header>

        {stats && info && (
          <div className="result-stack">
            <div className="headline-grid">
              <div className="card">
                <p className="hint">Precise-amount withdrawals traced to a service's deposit</p>
                <p className="big-number">
                  {servicesPrecise ? percent(servicesPrecise.observed.rate) : "n/a"}
                </p>
                <p className="hint">
                  {servicesPrecise ? `${percent(chance(servicesPrecise))} expected by chance` : ""}
                </p>
              </div>
              <div className="card">
                <p className="hint">Withdrawals traced to people, beyond chance</p>
                <p className="big-number word">
                  {stats.people.excess > 0.001
                    ? `+${(100 * stats.people.excess).toFixed(1)} pts`
                    : "None"}
                </p>
                <p className="hint">
                  {percent(stats.people.observed.rate)} traced, {percent(chance(stats.people))} by
                  chance
                </p>
              </div>
              <div className="card">
                <p className="hint">Withdrawals scored</p>
                <p className="big-number">{stats.evaluated.toLocaleString()}</p>
                <p className="hint">
                  {months.length
                    ? `${monthName(months[0]!)} to ${monthName(months[months.length - 1]!)}`
                    : ""}
                  , from data ending {day(info.dataTo - 1)}
                </p>
              </div>
            </div>

            <div className="actions" style={{ justifyContent: "flex-end" }}>
              <button
                type="button"
                className="link-button"
                aria-pressed={asTable}
                onClick={() => setAsTable((v) => !v)}
              >
                {asTable ? "Show as charts" : "Show as table"}
              </button>
            </div>

            {asTable ? (
              <StatsTable stats={stats} />
            ) : (
              <div className="grid-2">
                <BulletChart
                  title="Traced to a service"
                  subtitle={`${stats.serviceEntities} entities with more than 100 deposits in the window`}
                  breakdown={stats.services}
                  max={max}
                />
                <BulletChart
                  title="Traced to a person"
                  subtitle="Everyone else"
                  breakdown={stats.people}
                  max={max}
                />
              </div>
            )}

            <CrowdChart stats={stats} />

            <div className="card">
              <h2 style={{ fontSize: 22, marginBottom: 12 }}>What this means</h2>
              <ul className="advice">
                <li>
                  Services leak: when an exchange, bridge or payment service moves a precise amount
                  through the pool, the withdrawal often traces straight back to its deposit.
                </li>
                <li>
                  Across people as a whole, withdrawals are traced no more often than chance would
                  predict. Most people don't withdraw exactly what they deposited.
                </li>
                <li>
                  But the few who do, on an amount nobody else used recently, are found every time
                  in testing. That's a personal risk, so it needs a personal check.
                </li>
              </ul>
              <div className="actions" style={{ marginTop: 18 }}>
                <a className="btn btn-primary" href={href("/check")}>
                  Check your withdrawal <ArrowRight size={18} />
                </a>
                <a
                  className="btn btn-ghost"
                  href="https://github.com/daodudestiny56-netizen/turnstile/blob/main/docs/methodology.md"
                  rel="noreferrer"
                >
                  Read the methodology
                </a>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
