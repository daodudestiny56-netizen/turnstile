import { Command } from "commander";
import { VERSION, formatZat, zecToZat } from "@turnstile/core";
import { countsCommand, ingestCommand } from "./ingest.js";

const DEFAULT_DB = "data/turnstile.sqlite";
const DEFAULT_CACHE = "data/cache/blockchair";

function yesterdayUtc(): string {
  return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
}

export function buildProgram(): Command {
  const program = new Command()
    .name("turnstile")
    .description("Measure and avoid Zcash shielded-pool boundary leaks.")
    .version(VERSION);

  program
    .command("zat")
    .description("Convert a ZEC amount to zatoshi (sanity check for the toolchain).")
    .argument("<zec>", "amount in ZEC, e.g. 3.1742")
    .action((zec: string) => {
      const zat = zecToZat(zec);
      console.log(`${formatZat(zat)} ZEC = ${zat} zat`);
    });

  program
    .command("ingest")
    .description("Download Blockchair daily dumps (cached) and load them into the local database.")
    .option("--from <day>", "first UTC day, YYYY-MM-DD")
    .option("--to <day>", "last UTC day, YYYY-MM-DD (default: yesterday)", yesterdayUtc())
    .option("--days <n>", "number of days ending at --to (alternative to --from)")
    .option("--db <path>", "SQLite database path", DEFAULT_DB)
    .option("--cache <dir>", "download cache directory", DEFAULT_CACHE)
    .option("--force", "re-ingest days even if unchanged")
    .action(ingestCommand);

  program
    .command("counts")
    .description("Show per-day row counts in the local database.")
    .option("--db <path>", "SQLite database path", DEFAULT_DB)
    .action(countsCommand);

  return program;
}

export async function run(argv: readonly string[]): Promise<void> {
  await buildProgram().parseAsync([...argv], { from: "user" });
}
