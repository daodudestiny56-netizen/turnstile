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
  db.close();

  return {
    manifest,
    stats: v.stats as core.MeterStats,
    dataTo,
    deposit: { amount: deposit.amount, time: deposit.time },
    reusedT1,
    reusedTex: (await core.toTex(reusedT1))!,
    freshAddress,
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
