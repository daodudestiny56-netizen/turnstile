import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { expect, type Page } from "@playwright/test";
import * as core from "../packages/core/dist/index.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const snapDir = join(root, "apps/web/dist/snapshot");
const read = (n: string): Uint8Array => new Uint8Array(readFileSync(join(snapDir, n)));

export interface Fixtures {
  manifest: core.Manifest;
  stats: core.MeterStats;
  dataTo: number;
  /** A real deposit nobody else matched in the three weeks before a withdrawal an hour later. */
  deposit: { amount: number; time: number };
  /** A real t1 address that funded a deposit in the snapshot's window, and its TEX form. */
  reusedT1: string;
  reusedTex: string;
  /** A real transparent address that received a withdrawal but never deposited. */
  freshAddress: string;
  /**
   * A real address whose own deposit an observer links to a later withdrawal to the same address,
   * with that deposit's and withdrawal's amounts (the audit reports it traced).
   */
  traced: { address: string; deposit: number; withdrawal: number };
  /** Entry Planner advice computed independently from the same snapshot, at dataTo - 1 hour. */
  entry: (zec: string) => core.EntryAdvice;
}

let cached: Promise<Fixtures> | undefined;

async function build(): Promise<Fixtures> {
  const manifest = core.parseManifest(readFileSync(join(snapDir, "manifest.json"), "utf8"));
  const v = await core.loadSnapshot(manifest, {
    snapshot: read("snapshot.bin.gz"),
    addresses: read("addresses.bin"),
    stats: read("stats.json"),
  });
  const ctx = core.createPreflightContext(v.data, v.addresses);
  const { dataTo } = v.data;
  const deposit = v.data.shields.find((s) => {
    if (s.time < dataTo - 5 * 86_400 || s.time > dataTo - 3 * 3_600) return false;
    if (core.zecDecimals(s.amount) < 6 || ctx.services.has(s.entity)) return false;
    const exit = { time: s.time + 3_600, amount: s.amount - 30_000 };
    const rivals = core.feeShapedEntities(ctx.index, exit);
    rivals.delete(s.entity);
    return rivals.size === 0 && core.expectedChanceMatches(ctx.index, exit) === 0;
  });
  if (!deposit) throw new Error("no identifiable deposit in the snapshot");

  const db = new DatabaseSync(join(root, "data/turnstile.sqlite"), { readOnly: true });
  const range = [manifest.fromDay, manifest.toDay];
  const shielders = new Set(
    (
      db
        .prepare("SELECT addresses FROM events WHERE kind = 'SHIELD' AND day BETWEEN ? AND ?")
        .all(...range) as { addresses: string }[]
    ).flatMap((r) => JSON.parse(r.addresses) as string[]),
  );
  const reusedT1 = [...shielders].find((a) => a.startsWith("t1"))!;
  const freshAddress = (
    db
      .prepare("SELECT addresses FROM events WHERE kind = 'DESHIELD' AND day BETWEEN ? AND ?")
      .all(...range) as { addresses: string }[]
  )
    .flatMap((r) => JSON.parse(r.addresses) as string[])
    .find((a) => a.startsWith("t1") && !shielders.has(a))!;

  // A same-address round trip the matcher links, on an address with little other activity.
  const audit = await core.loadAudit(manifest, read("audit.bin.gz"), v.data);
  const scoredFrom = v.data.dataFrom + core.historyNeededSec();
  let traced: Fixtures["traced"] | undefined;
  const exitRows = db
    .prepare(
      "SELECT time, amount, addresses FROM events WHERE kind = 'DESHIELD' AND tags NOT LIKE '%batch%' AND day BETWEEN ? AND ? ORDER BY time DESC",
    )
    .all(...range) as { time: number; amount: number; addresses: string }[];
  for (const e of exitRows) {
    if (e.time < scoredFrom) break;
    const address = (JSON.parse(e.addresses) as string[])[0]!;
    if (!shielders.has(address)) continue;
    const refs = await audit.lookup(address);
    if (refs.shields.length + refs.exits.length > 20) continue;
    const r = await core.auditAddresses(ctx, audit, [address]);
    const w = r.withdrawals.find(
      (x) => x.time === e.time && x.findings.some((f) => f.code === "traced"),
    );
    if (w?.linkedDeposit) {
      traced = { address, deposit: w.linkedDeposit.amount, withdrawal: w.amount };
      break;
    }
  }
  if (!traced) throw new Error("no traced round trip in the snapshot");
  db.close();

  return {
    manifest,
    stats: v.stats as core.MeterStats,
    dataTo,
    deposit: { amount: deposit.amount, time: deposit.time },
    reusedT1,
    reusedTex: (await core.toTex(reusedT1))!,
    freshAddress,
    traced,
    entry: (zec: string) =>
      core.planEntry(ctx, { balance: core.zecToZat(zec), time: dataTo - 3_600 }),
  };
}

export function fixtures(): Promise<Fixtures> {
  return (cached ??= build());
}

export const formatZat = core.formatZat;

/** Value for a datetime-local input; tests run with timezoneId UTC. */
export const utcInput = (t: number): string => new Date(t * 1000).toISOString().slice(0, 16);

export async function waitForData(page: Page): Promise<void> {
  // Generous: several browsers may be downloading and verifying the snapshot at once.
  await expect(page.getByText("verified on this device").first()).toBeVisible({ timeout: 45_000 });
}

/** Fill the check form. */
export async function fillCheck(
  page: Page,
  input: { amount: string; when: number; deposit?: string; depositAt?: number; to?: string },
): Promise<void> {
  await page.locator("#amount").fill(input.amount);
  await page.locator("#when").fill(utcInput(input.when));
  if (input.deposit !== undefined) await page.locator("#deposit").fill(input.deposit);
  if (input.depositAt !== undefined)
    await page.locator("#deposit-when").fill(utcInput(input.depositAt));
  if (input.to !== undefined) await page.locator("#destination").fill(input.to);
}
