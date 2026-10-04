import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUDIT_MAX_EVENTS,
  auditAddresses,
  createPreflightContext,
  formatZat,
  loadAudit,
  parsePositiveZec,
  planEntry,
  splitAddresses,
  type AuditIndex,
  type VerifiedSnapshot,
} from "@turnstile/core";
import { LABEL, loadBundle, parseTime, printData, when, wrap } from "./preflight.js";

const zec = (zat: number): string => `${formatZat(zat)} ZEC`;

export async function loadBundleWithAudit(
  dir: string,
): Promise<VerifiedSnapshot & { audit: AuditIndex }> {
  const bundle = await loadBundle(dir);
  const audit = await loadAudit(
    bundle.manifest,
    new Uint8Array(readFileSync(join(dir, "audit.bin.gz"))),
    bundle.data,
  );
  return { ...bundle, audit };
}

export interface EnterOptions {
  at?: string;
  snapshot: string;
}

/** Entry Planner: how to deposit into the shielded pool without creating a fingerprint. */
export async function enterCommand(zecAmount: string, opts: EnterOptions): Promise<void> {
  const balance = parsePositiveZec(zecAmount);
  const bundle = await loadBundle(opts.snapshot);
  const ctx = createPreflightContext(bundle.data, bundle.addresses);
  const time = parseTime(opts.at);
  const advice = planEntry(ctx, { balance, time });
  printData(ctx, time);
  console.log(`Depositing ${zec(balance)} into the shielded pool at ${when(time)} UTC`);
  console.log(`\n  As it is: ${LABEL[advice.verdict]}`);
  for (const r of advice.reasons) console.log(`  - [${r.severity}] ${wrap(r.message, "    ")}`);
  console.log(`\n  What to do`);
  advice.advice.forEach((a, i) => console.log(`  ${i + 1}. ${wrap(a, "     ")}`));
  console.log(
    "\n  Computed on this device against the downloaded snapshot; nothing was sent anywhere.",
  );
}

export interface AuditOptions {
  snapshot: string;
}

/** Personal Audit: which of your past withdrawals could be traced back to your deposits? */
export async function auditCommand(inputs: string[], opts: AuditOptions): Promise<void> {
  const addresses = splitAddresses(inputs.join(" "));
  const bundle = await loadBundleWithAudit(opts.snapshot);
  const ctx = createPreflightContext(bundle.data, bundle.addresses);
  const r = await auditAddresses(ctx, bundle.audit, addresses);
  if (r.addresses.every((a) => a.problem)) {
    throw new RangeError(
      `None of these can be audited: ${r.addresses.map((a) => `${a.input} (${a.problem})`).join("; ")}`,
    );
  }
  printData(ctx, ctx.data.dataTo);
  console.log(`Auditing ${addresses.length} address${addresses.length === 1 ? "" : "es"}`);
  for (const a of r.addresses) {
    console.log(
      `  ${a.input}` +
        (a.problem
          ? `   skipped: ${a.problem}`
          : `${a.address !== a.input ? ` (${a.address})` : ""}   ${a.deposits} deposits, ${a.withdrawals} withdrawals`),
    );
  }
  const s = r.summary;
  console.log(`\n  ${LABEL[r.verdict]}`);
  if (r.truncated) {
    console.log(
      `  More activity than one audit covers: the ${AUDIT_MAX_EVENTS} most recent deposits and withdrawals are audited.`,
    );
  }
  console.log(
    `  ${s.traced} of ${s.withdrawals} withdrawals traceable to you` +
      (s.judged < s.withdrawals
        ? ` (${s.withdrawals - s.judged} too early in the data to judge)`
        : "") +
      `; ${s.singledOut} singled out to a deposit you didn't enter; ` +
      `${s.followed} of ${s.deposits} deposits followed out of the pool.`,
  );
  if (r.withdrawals.length > 0) console.log(`\n  Withdrawals to your addresses`);
  for (const w of r.withdrawals) {
    console.log(
      `  ${when(w.time)} UTC   ${zec(w.amount).padStart(16)}   ${w.verdict ? LABEL[w.verdict] : "NOT JUDGED"}`,
    );
    for (const f of w.findings) console.log(`    - ${wrap(f.message, "      ")}`);
  }
  if (r.deposits.length > 0) console.log(`\n  Deposits from your addresses`);
  for (const d of r.deposits) {
    console.log(`  ${when(d.time)} UTC   ${zec(d.amount).padStart(16)}   ${LABEL[d.verdict]}`);
    for (const f of d.findings) console.log(`    - ${wrap(f.message, "      ")}`);
  }
  console.log(
    "\n  Addresses were hashed and looked up on this device; nothing was sent anywhere. For " +
      "addresses you didn't enter, Turnstile says only that a link exists, never where it leads.",
  );
}
