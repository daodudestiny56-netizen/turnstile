import "@fontsource-variable/inter";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { EngineProvider } from "./engine";

// Apply the saved theme before the first paint (no inline script: the CSP forbids those).
try {
  if (localStorage.getItem("turnstile-theme") === "light") {
    document.documentElement.dataset.theme = "light";
  }
} catch {
  // Storage unavailable: dark, the default.
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <EngineProvider>
      <App />
    </EngineProvider>
  </StrictMode>,
);
