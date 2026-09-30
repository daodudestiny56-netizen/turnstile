import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_FILES = ["manifest.json", "snapshot.bin.gz", "addresses.bin", "stats.json"];

/** Copy the verified snapshot bundle (built by `turnstile snapshot`) into the site. */
function snapshotBundle(): Plugin {
  return {
    name: "turnstile-snapshot",
    buildStart() {
      const from = process.env.TURNSTILE_SNAPSHOT ?? resolve(here, "../../data/snapshot");
      const to = resolve(here, "public/snapshot");
      if (!existsSync(join(from, "manifest.json"))) {
        this.warn(
          `no snapshot at ${from}; run \`turnstile snapshot\` first. The app will show an error.`,
        );
        return;
      }
      rmSync(to, { recursive: true, force: true });
      mkdirSync(to, { recursive: true });
      for (const f of SNAPSHOT_FILES) copyFileSync(join(from, f), join(to, f));
    },
  };
}

/**
 * Production Content Security Policy: nothing may load from another origin, except the NEAR Intents
 * 1Click API (PRD P3), which is only contacted when the user executes a leg.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "worker-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https://1click.chaindefuser.com",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join("; ");

function contentSecurityPolicy(): Plugin {
  return {
    name: "turnstile-csp",
    apply: "build",
    transformIndexHtml: (html) =>
      html.replace(
        "<head>",
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      ),
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), snapshotBundle(), contentSecurityPolicy()],
  worker: { format: "es" },
  build: {
    target: "es2022",
    // Keep fonts and images as files: data: URIs would widen the CSP.
    assetsInlineLimit: 0,
  },
});
