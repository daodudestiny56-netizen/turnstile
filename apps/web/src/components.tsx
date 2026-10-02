import { useEffect, useState, type ReactNode } from "react";
import type { Reason, Verdict } from "@turnstile/core";
import { useEngine } from "./engine";
import { day, nowSec } from "./format";
import { Alert, Clock, ShieldCheck, Stop } from "./icons";

/* ----- Routing: hash-based, so any static host serves every page ----- */

export interface Route {
  path: string;
  params: URLSearchParams;
}

function readRoute(): Route {
  const hash = window.location.hash.replace(/^#/, "") || "/";
  const [path = "/", query = ""] = hash.split("?");
  return { path, params: new URLSearchParams(query) };
}

/**
 * The current hash route, plus a counter that changes on every real navigation (pages are keyed by
 * it, so following a link remounts them). Quietly removing parameters from the URL (useForgetParams)
 * is not a navigation and doesn't count.
 */
export function useRoute(): Route & { nav: number } {
  const [state, setState] = useState(() => ({ route: readRoute(), nav: 0 }));
  useEffect(() => {
    const onChange = (): void => {
      setState((s) => ({ route: readRoute(), nav: s.nav + 1 }));
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    // A navigation between the first render and this subscription would otherwise be missed.
    setState((s) =>
      readRoute().path === s.route.path ? s : { route: readRoute(), nav: s.nav + 1 },
    );
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return { ...state.route, nav: state.nav };
}

export function href(path: string, params?: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v) q.set(k, v);
  const s = q.toString();
  return `#${path}${s ? `?${s}` : ""}`;
}

/* ----- Theme ----- */

type Theme = "dark" | "light";

function storedTheme(): Theme {
  try {
    return localStorage.getItem("turnstile-theme") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(storedTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("turnstile-theme", theme);
    } catch {
      // Private mode or blocked storage: the theme just won't persist.
    }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}

/* ----- Verdicts ----- */

const VERDICT_COPY: Record<Verdict, { title: string; body: string }> = {
  red: {
    title: "Red: this would give you away",
    body: "An observer could link this withdrawal to a specific deposit.",
  },
  amber: {
    title: "Amber: proceed with care",
    body: "Not linked outright, but the crowd around it is thin or the data is dated.",
  },
  green: {
    title: "Green: this blends in",
    body: "Amount and timing don't single you out.",
  },
};

export function VerdictIcon({
  verdict,
  size = 26,
}: {
  verdict: Verdict;
  size?: number;
}): ReactNode {
  if (verdict === "red") return <Stop size={size} />;
  if (verdict === "amber") return <Alert size={size} />;
  return <ShieldCheck size={size} />;
}

export function VerdictBanner({
  verdict,
  title,
  body,
  headingLevel = 2,
}: {
  verdict: Verdict;
  title?: string;
  body?: string;
  headingLevel?: 2 | 3;
}): ReactNode {
  const copy = VERDICT_COPY[verdict];
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <div className={`verdict verdict-${verdict}`}>
      <span className="verdict-icon">
        <VerdictIcon verdict={verdict} />
      </span>
      <div>
        <Heading>{title ?? copy.title}</Heading>
        <p>{body ?? copy.body}</p>
      </div>
    </div>
  );
}

export function Tag({ verdict, children }: { verdict: Verdict; children?: ReactNode }): ReactNode {
  return (
    <span className={`tag tag-${verdict}`}>
      <VerdictIcon verdict={verdict} size={14} />
      {children ?? verdict}
    </span>
  );
}

const REASON_TITLES: Record<Reason["code"], string> = {
  "exact-round-trip": "Exact round trip",
  "unique-match": "Matches one deposit",
  "address-reuse": "Address reuse",
  "thin-crowd": "Thin crowd",
  "precise-amount": "Precise amount",
  "stale-data": "Data may be out of date",
  crowd: "Hidden in a crowd",
  "no-match": "No matching deposit",
};

export function ReasonList({ reasons }: { reasons: Reason[] }): ReactNode {
  return (
    <ul className="reasons">
      {reasons.map((r) => (
        <li key={r.code}>
          <div>
            <Tag verdict={r.severity}>{REASON_TITLES[r.code]}</Tag>
          </div>
          <p>{r.message}</p>
        </li>
      ))}
    </ul>
  );
}

/* ----- Data status ----- */

/** Data older than this (relative to the viewer's clock) is flagged on every tool page. */
const STALE_DATA_SEC = 2 * 86_400;

export function DataStatus(): ReactNode {
  const { state, retry } = useEngine();
  if (state.status === "loading") {
    return (
      <div className="status-banner" role="status">
        <span className="spinner" aria-hidden="true" />
        Downloading and verifying the public data snapshot. It's the same file for everyone, and
        nothing you type is ever sent.
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="status-banner error" role="alert">
        <Alert size={18} />
        <span className="status-text">
          The data snapshot couldn't be loaded or failed verification. {state.message}
        </span>
        <button type="button" className="btn btn-ghost btn-small" onClick={retry}>
          Try again
        </button>
      </div>
    );
  }
  const { info } = state;
  const age = nowSec() - info.dataTo;
  return (
    <>
      <p className="data-note">
        <Clock size={16} />
        <span>
          Data: {day(info.dataFrom)} to {day(info.dataTo - 1)} (
          {info.manifest.counts.shields.toLocaleString()} deposits,{" "}
          {info.manifest.counts.exits.toLocaleString()} withdrawals), verified on this device.
          Checks warn you when your withdrawal is more than two days after the data ends.
        </span>
      </p>
      {age > STALE_DATA_SEC && (
        <div className="status-banner warning" role="status">
          <Alert size={18} />
          <span className="status-text">
            This data ended {Math.floor(age / 86_400)} days ago, so deposits made since then aren't
            counted. Results for withdrawals made today may be out of date.
          </span>
        </div>
      )}
    </>
  );
}
