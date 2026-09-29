#!/usr/bin/env node
import { run } from "./index.js";

// node:sqlite prints an ExperimentalWarning on first use; hide that one, keep all others.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  if (warning.name === "ExperimentalWarning" && warning.message.includes("SQLite")) return;
  console.warn(`${warning.name}: ${warning.message}`);
});

run(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
