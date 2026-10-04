import { Command } from "commander";
import { VERSION, formatZat, zecToZat } from "@turnstile/core";
import { deriveCommand, eventsCommand } from "./events.js";
import { countsCommand, ingestCommand } from "./ingest.js";
import { meterCommand, validateCommand } from "./meter.js";
import { snapshotCommand } from "./snapshot.js";
import { checkCommand, planCommand } from "./preflight.js";
import { auditCommand, enterCommand } from "./personal.js";
import { destinationsHelp, quoteCommand, statusCommand } from "./intents.js";

const DEFAULT_SNAPSHOT = "data/snapshot";

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

  for (const [name, description, action] of [
    ["derive", "Derive shield/deshield events from the ingested raw data.", deriveCommand],
    [
      "events",
      "Report derived events and compare them with Blockchair's own figures.",
      eventsCommand,
    ],
  ] as const) {
    program
      .command(name)
      .description(description)
      .option("--from <day>", "first UTC day, YYYY-MM-DD")
      .option("--to <day>", "last UTC day, YYYY-MM-DD (default: yesterday)", yesterdayUtc())
      .option("--days <n>", "number of days ending at --to (alternative to --from)")
      .option("--db <path>", "SQLite database path", DEFAULT_DB)
      .action(action);
  }

  const withRange = (cmd: Command): Command =>
    cmd
      .option("--from <day>", "first UTC day, YYYY-MM-DD")
      .option("--to <day>", "last UTC day, YYYY-MM-DD (default: yesterday)", yesterdayUtc())
      .option("--days <n>", "number of days ending at --to (alternative to --from)")
      .option("--db <path>", "SQLite database path", DEFAULT_DB)
      .option("--max-chance <n>", "override the chance-match threshold (calibration only)");

  withRange(program.command("meter"))
    .description(
      "Leak Meter: how many exits can be linked to their entry, against a coincidence baseline.",
    )
    .option("--out <file>", "also write the statistics as JSON")
    .action(meterCommand);

  withRange(program.command("validate"))
    .description("Check the matcher on planted round trips and on natural same-address labels.")
    .option("--trips <n>", "planted trips per scenario", "200")
    .option("--seed <n>", "random seed", "2026")
    .action(validateCommand);

  withRange(program.command("snapshot"))
    .description("Build the public snapshot bundle (snapshot, address hashes, stats, manifest).")
    .option("--out-dir <dir>", "output directory", "data/snapshot")
    .action(snapshotCommand);

  program
    .command("enter")
    .description("Entry Planner: deposit into the shielded pool without creating a fingerprint")
    .argument("<zec>", "amount you're about to deposit (fees included), e.g. 3.1742")
    .option("--at <time>", "when you plan to deposit: now, or ISO e.g. 2026-09-30T14:00Z", "now")
    .option("--snapshot <dir>", "verified snapshot bundle", DEFAULT_SNAPSHOT)
    .action(enterCommand);

  program
    .command("audit")
    .description("Personal Audit: which of your past withdrawals could be traced to your deposits?")
    .argument(
      "<addresses...>",
      "your transparent addresses (t1, t3 or tex1); hashed locally, never sent",
    )
    .option("--snapshot <dir>", "verified snapshot bundle", DEFAULT_SNAPSHOT)
    .action(auditCommand);

  program
    .command("check")
    .description("Pre-flight Check: would this withdrawal from the shielded pool give you away?")
    .argument("<zec>", "amount to withdraw, e.g. 3.1742")
    .option("--at <time>", "when you plan to withdraw: now, or ISO e.g. 2026-09-30T14:00Z", "now")
    .option("--to <address>", "destination transparent address (hashed locally, never sent)")
    .option("--deposit <zec>", "your deposit into the pool, to check against")
    .option("--deposit-at <time>", "when you made that deposit (ISO)")
    .option("--snapshot <dir>", "verified snapshot bundle", DEFAULT_SNAPSHOT)
    .action(checkCommand);

  program
    .command("plan")
    .description("Exit Planner: split a withdrawal into legs that each blend into a crowd.")
    .argument("<zec>", "total amount to take out")
    .option("--start <time>", "earliest start: now, or ISO", "now")
    .option("--hours <n>", "spread legs over this many hours", "72")
    .option("--legs <n>", "maximum number of legs", "4")
    .option("--crowd <n>", "other parties each leg should hide among", "10")
    .option("--seed <n>", "fix the random seed (default: a fresh random one)")
    .option("--deposit <zec>", "your deposit into the pool")
    .option("--deposit-at <time>", "when you made that deposit (ISO)")
    .option("--ics <file>", "write calendar reminders for the legs")
    .option("--snapshot <dir>", "verified snapshot bundle", DEFAULT_SNAPSHOT)
    .action(planCommand);

  program
    .command("quote")
    .description(
      "Quote one leg through NEAR Intents (dry by default; --live creates a deposit address).",
    )
    .argument("<zec>", "ZEC to swap, e.g. 1")
    .requiredOption("--to <destination>", `what to receive: ${destinationsHelp()}`)
    .requiredOption("--recipient <address>", "where the destination asset goes")
    .requiredOption(
      "--refund <zcash-address>",
      "where ZEC goes back if the swap fails (u1/zs recommended)",
    )
    .option("--live", "create a real one-time deposit address (nothing is paid until you send ZEC)")
    .option("--slippage <bps>", "slippage tolerance in basis points", "100")
    .option("--save <file>", "save the signed quote (keep it in case of a dispute)")
    .action(quoteCommand);

  program
    .command("status")
    .description("Track a NEAR Intents swap by its deposit address.")
    .argument("<deposit-address>")
    .action(statusCommand);

  return program;
}

export async function run(argv: readonly string[]): Promise<void> {
  await buildProgram().parseAsync([...argv], { from: "user" });
}
