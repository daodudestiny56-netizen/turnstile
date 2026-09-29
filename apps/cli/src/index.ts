import { Command } from "commander";
import { VERSION, formatZat, zecToZat } from "@turnstile/core";

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

  return program;
}

export async function run(argv: readonly string[]): Promise<void> {
  await buildProgram().parseAsync([...argv], { from: "user" });
}
