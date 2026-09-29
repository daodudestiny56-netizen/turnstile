#!/usr/bin/env node
import { run } from "./index.js";

run(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
