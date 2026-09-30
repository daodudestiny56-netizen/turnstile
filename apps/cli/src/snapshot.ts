import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
  DEFAULT_MATCH_PARAMS,
  MANIFEST_FORMAT,
  SNAPSHOT_VERSION,
  buildAddressSet,
  canonicalizeSnapshot,
  encodeSnapshot,
  meterStats,
  sha256Hex,
  type Manifest,
} from "@turnstile/core";
import { dayRange, daysBefore } from "@turnstile/ingest";
import { loadMatchData, type MeterOptions } from "./meter.js";

const kb = (n: number): string => `${(n / 1024).toFixed(0)} KB`;

/**
 * Build the public snapshot bundle: snapshot.bin.gz, addresses.bin, stats.json and manifest.json.
 * Everything is deterministic: the same ingested days always give the same content hashes.
 */
export async function snapshotCommand(opts: MeterOptions & { outDir: string }): Promise<void> {
  const started = performance.now();
  const data = loadMatchData(opts);
  const from = opts.from ?? (opts.days ? daysBefore(opts.to, Number(opts.days)) : opts.to);
  const days = dayRange(from, opts.to);

  const snapshot = canonicalizeSnapshot({
    dataFrom: data.dataFrom,
    dataTo: data.dataTo,
    shields: data.shields,
    services: [...data.services],
    exits: data.exits.map((e) => ({ time: e.time, amount: e.amount })),
  });
  const raw = encodeSnapshot(snapshot);
  const gz = new Uint8Array(gzipSync(raw, { level: 9 }));
  const addresses = await buildAddressSet(data.shieldEvents.flatMap((e) => e.addresses));
  const stats = new TextEncoder().encode(
    JSON.stringify(
      meterStats(
        data.index,
        data.exits,
        data.dataFrom,
        data.dataTo,
        DEFAULT_MATCH_PARAMS,
        data.services,
      ),
      null,
      2,
    ) + "\n",
  );

  const manifest: Manifest = {
    format: MANIFEST_FORMAT,
    version: SNAPSHOT_VERSION,
    source: "Blockchair daily dumps (https://gz.blockchair.com/zcash/), derived by Turnstile",
    fromDay: days[0]!,
    toDay: days[days.length - 1]!,
    counts: {
      shields: snapshot.shields.length,
      entities: new Set(snapshot.shields.map((s) => s.entity)).size,
      services: snapshot.services.length,
      exits: snapshot.exits.length,
      addresses: addresses.length / 8,
    },
    files: {
      "snapshot.bin.gz": {
        bytes: gz.length,
        sha256: await sha256Hex(gz),
        contentSha256: await sha256Hex(raw),
      },
      "addresses.bin": { bytes: addresses.length, sha256: await sha256Hex(addresses) },
      "stats.json": { bytes: stats.length, sha256: await sha256Hex(stats) },
    },
  };

  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(join(opts.outDir, "snapshot.bin.gz"), gz);
  writeFileSync(join(opts.outDir, "addresses.bin"), addresses);
  writeFileSync(join(opts.outDir, "stats.json"), stats);
  writeFileSync(join(opts.outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const c = manifest.counts;
  const f = manifest.files;
  const total = gz.length + addresses.length + stats.length;
  console.log(`Snapshot ${manifest.fromDay} .. ${manifest.toDay} -> ${opts.outDir}`);
  console.log(
    `  ${c.shields} shields, ${c.entities} entities (${c.services} services), ${c.exits} exits, ${c.addresses} addresses`,
  );
  console.log(`  snapshot.bin.gz  ${kb(gz.length).padStart(8)}  (${kb(raw.length)} uncompressed)`);
  console.log(`  addresses.bin    ${kb(addresses.length).padStart(8)}`);
  console.log(`  stats.json       ${kb(stats.length).padStart(8)}`);
  console.log(`  total download   ${kb(total).padStart(8)}`);
  console.log(`  content sha256   ${f["snapshot.bin.gz"].contentSha256}`);
  console.log(`  ${seconds}s`);
}
