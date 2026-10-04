import { useEffect, useRef, useState, type ReactNode } from "react";
import { href, useRoute, useTheme } from "./components";
import { LogoMark, Menu, Moon, Sun } from "./icons";
import { AuditPage } from "./pages/Audit";
import { CheckPage } from "./pages/Check";
import { EnterPage } from "./pages/Enter";
import { Landing } from "./pages/Landing";
import { MeterPage } from "./pages/Meter";
import { PlanPage } from "./pages/Plan";

const REPO = "https://github.com/daodudestiny56-netizen/turnstile";

const NAV = [
  { path: "/enter", label: "Entry Planner" },
  { path: "/check", label: "Pre-flight Check" },
  { path: "/plan", label: "Exit Planner" },
  { path: "/audit", label: "Audit" },
  { path: "/meter", label: "Leak Meter" },
];

function Header({ path }: { path: string }): ReactNode {
  const [theme, toggleTheme] = useTheme();
  const [open, setOpen] = useState(false);
  // Any navigation (links, back and forward) closes the menu, and so does Escape.
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <header className="site-header">
      <div className="container">
        <nav className="nav" aria-label="Main">
          <a className="brand" href={href("/")}>
            <LogoMark />
            Turnstile
          </a>
          <ul className="nav-links">
            {NAV.map((n) => (
              <li key={n.path}>
                <a href={href(n.path)} aria-current={path === n.path ? "page" : undefined}>
                  {n.label}
                </a>
              </li>
            ))}
          </ul>
          <div className="nav-actions">
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              onClick={toggleTheme}
              aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            >
              {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </button>
            <a className="btn btn-primary" href={href("/check")}>
              Check
            </a>
            <button
              type="button"
              className="btn btn-ghost btn-icon menu-toggle"
              aria-expanded={open}
              aria-controls="mobile-menu"
              aria-label="Menu"
              onClick={() => setOpen((o) => !o)}
            >
              <Menu size={18} />
            </button>
          </div>
        </nav>
        {open && (
          <ul id="mobile-menu" className="mobile-menu">
            {NAV.map((n) => (
              <li key={n.path}>
                <a
                  href={href(n.path)}
                  aria-current={path === n.path ? "page" : undefined}
                  onClick={() => setOpen(false)}
                >
                  {n.label}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </header>
  );
}

function Footer(): ReactNode {
  return (
    <footer className="site-footer">
      <div className="container footer-grid">
        <p>
          Turnstile, built for Zecathon. Open source under the MIT license. It never asks for keys
          and never sends what you type.
        </p>
        <ul className="footer-links">
          <li>
            <a href={REPO} rel="noreferrer">
              Source code
            </a>
          </li>
          <li>
            <a href={`${REPO}/blob/main/docs/methodology.md`} rel="noreferrer">
              Methodology
            </a>
          </li>
          <li>
            <a href={href("/meter")}>Leak Meter</a>
          </li>
        </ul>
      </div>
    </footer>
  );
}

function NotFound(): ReactNode {
  return (
    <div className="page">
      <div className="container">
        <header className="page-head">
          <span className="eyebrow">Not found</span>
          <h1>There's no page here</h1>
          <p className="lead">The link may be mistyped. These are the tools Turnstile has:</p>
        </header>
        <ul className="advice">
          {NAV.map((n) => (
            <li key={n.path}>
              <a href={href(n.path)}>{n.label}</a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const TITLES: Record<string, string> = {
  "/enter": "Entry Planner",
  "/audit": "Personal Audit",
  "/check": "Pre-flight Check",
  "/plan": "Exit Planner",
  "/meter": "Leak Meter",
};

export function App(): ReactNode {
  const route = useRoute();
  const firstRender = useRef(true);
  useEffect(() => {
    const title = TITLES[route.path];
    document.title = title
      ? `${title} | Turnstile`
      : route.path === "/" || route.path === ""
        ? "Turnstile: leave the shielded pool without a trail"
        : "Page not found | Turnstile";
    // After navigating, start keyboard and screen-reader users at the new page's content.
    if (firstRender.current) firstRender.current = false;
    else document.getElementById("main")?.focus({ preventScroll: true });
  }, [route.path]);
  const key = `${route.path}#${route.nav}`;
  let page: ReactNode;
  switch (route.path) {
    case "/check":
      page = <CheckPage key={key} route={route} />;
      break;
    case "/plan":
      page = <PlanPage key={key} route={route} />;
      break;
    case "/meter":
      page = <MeterPage />;
      break;
    case "/enter":
      page = <EnterPage key={key} />;
      break;
    case "/audit":
      page = <AuditPage key={key} />;
      break;
    case "/":
    case "":
      page = <Landing />;
      break;
    default:
      page = <NotFound />;
  }
  return (
    <>
      <div className="backdrop" aria-hidden="true" />
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main")?.focus();
        }}
      >
        Skip to content
      </a>
      <Header path={route.path} />
      <main id="main" tabIndex={-1}>
        {page}
      </main>
      <Footer />
    </>
  );
}
