/**
 * Loading and verifying a published snapshot. Uses only Web APIs present in browsers and Node 20+
 * (crypto.subtle, DecompressionStream, Blob, Response), so the same code runs in both.
 */
import { decodeSnapshot, type SnapshotData } from "./snapshot.js";

/** Minimal typings for the Web APIs used here; core deliberately compiles without DOM types. */
interface WebPlatform {
  crypto: { subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> } };
  DecompressionStream: new (format: "gzip") => unknown;
  Blob: new (parts: Uint8Array[]) => { stream(): { pipeThrough(t: unknown): unknown } };
  Response: new (body: unknown) => { arrayBuffer(): Promise<ArrayBuffer> };
  TextEncoder: new () => { encode(s: string): Uint8Array };
  TextDecoder: new () => { decode(b: Uint8Array): string };
}
const web = globalThis as unknown as WebPlatform;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await web.crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new web.Blob([bytes]).stream().pipeThrough(new web.DecompressionStream("gzip"));
  return new Uint8Array(await new web.Response(stream).arrayBuffer());
}

export const MANIFEST_FORMAT = "turnstile-snapshot";

export interface ManifestFile {
  /** Published file size in bytes. */
  bytes: number;
  /** SHA-256 of the published file (checks the download). */
  sha256: string;
  /**
   * For compressed files: SHA-256 of the uncompressed content. This is the reproducible fingerprint:
   * gzip output can differ between zlib builds, the content never does.
   */
  contentSha256?: string;
}

export interface Manifest {
  format: typeof MANIFEST_FORMAT;
  version: number;
  source: string;
  /** First and last UTC day covered, YYYY-MM-DD. */
  fromDay: string;
  toDay: string;
  counts: {
    shields: number;
    entities: number;
    services: number;
    exits: number;
    addresses: number;
    /** Addresses in the audit index (every address that funded a deposit or received a withdrawal). */
    auditAddresses: number;
  };
  files: {
    "snapshot.bin.gz": ManifestFile;
    "addresses.bin": ManifestFile;
    "stats.json": ManifestFile;
    "audit.bin.gz": ManifestFile;
  };
}

export class SnapshotIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotIntegrityError";
  }
}

async function expectHash(name: string, bytes: Uint8Array, expected: string): Promise<void> {
  const actual = await sha256Hex(bytes);
  if (actual !== expected) {
    throw new SnapshotIntegrityError(
      `${name}: SHA-256 ${actual} does not match manifest ${expected}`,
    );
  }
}

export function parseManifest(json: string): Manifest {
  const m = JSON.parse(json) as Manifest;
  if (m.format !== MANIFEST_FORMAT) throw new SnapshotIntegrityError("not a Turnstile manifest");
  for (const name of ["snapshot.bin.gz", "addresses.bin", "stats.json", "audit.bin.gz"] as const) {
    if (!m.files?.[name]?.sha256) throw new SnapshotIntegrityError(`manifest lacks ${name}`);
  }
  return m;
}

export interface VerifiedSnapshot {
  manifest: Manifest;
  data: SnapshotData;
  addresses: AddressSet;
  /** The published Leak Meter statistics (MeterStats as JSON). */
  stats: unknown;
}

/**
 * Verify every file against the manifest, then decode. Any mismatch, including a file that is
 * well-formed but altered, throws SnapshotIntegrityError before anything is used.
 *
 * The snapshot may arrive in either form. Many static hosts serve a `.gz` file with
 * `Content-Encoding: gzip`, and the browser then hands over the already-decompressed bytes. Both
 * forms are pinned by the manifest: compressed bytes must match the file hash and then the content
 * hash; decompressed bytes must match the content hash directly.
 */
export async function loadSnapshot(
  manifest: Manifest,
  files: { snapshot: Uint8Array; addresses: Uint8Array; stats: Uint8Array },
): Promise<VerifiedSnapshot> {
  const f = manifest.files;
  const raw = await verifyGzipped("snapshot.bin.gz", files.snapshot, f["snapshot.bin.gz"]);
  await expectHash("addresses.bin", files.addresses, f["addresses.bin"].sha256);
  await expectHash("stats.json", files.stats, f["stats.json"].sha256);

  const data = decodeSnapshot(raw);
  const addresses = new AddressSet(files.addresses);
  const c = manifest.counts;
  if (
    data.shields.length !== c.shields ||
    data.exits.length !== c.exits ||
    data.services.length !== c.services ||
    addresses.size !== c.addresses
  ) {
    throw new SnapshotIntegrityError("decoded counts do not match the manifest");
  }
  return {
    manifest,
    data,
    addresses,
    stats: JSON.parse(new web.TextDecoder().decode(files.stats)) as unknown,
  };
}

/**
 * Check a gzipped file against its manifest entry and return its content. It may arrive compressed
 * (must match the file hash, then the content hash) or decompressed in transit by a host that serves
 * `.gz` with `Content-Encoding: gzip` (must match the content hash).
 */
export async function verifyGzipped(
  name: string,
  bytes: Uint8Array,
  entry: ManifestFile,
): Promise<Uint8Array> {
  const contentHash = entry.contentSha256;
  if (!contentHash) throw new SnapshotIntegrityError(`manifest lacks the ${name} content hash`);
  const received = await sha256Hex(bytes);
  if (received === entry.sha256) {
    let raw: Uint8Array;
    try {
      raw = await gunzip(bytes);
    } catch {
      throw new SnapshotIntegrityError(`${name} does not decompress`);
    }
    await expectHash(`${name} content`, raw, contentHash);
    return raw;
  }
  if (received === contentHash) return bytes;
  throw new SnapshotIntegrityError(
    `${name}: SHA-256 ${received} matches neither the manifest's file hash ` +
      `${entry.sha256} nor its content hash ${contentHash}`,
  );
}

/** Bytes kept from each address hash: 64 bits, so ~10^5 addresses have no realistic collision. */
export const ADDRESS_HASH_BYTES = 8;
const ADDRESS_DOMAIN = "turnstile/address/v1:";

/** Truncated SHA-256 of a transparent address, domain-separated. */
export async function hashAddress(address: string): Promise<Uint8Array> {
  const digest = new Uint8Array(
    await web.crypto.subtle.digest(
      "SHA-256",
      new web.TextEncoder().encode(ADDRESS_DOMAIN + address),
    ),
  );
  return digest.slice(0, ADDRESS_HASH_BYTES);
}

export function compareBytes(a: Uint8Array, aOff: number, b: Uint8Array, bOff: number): number {
  for (let i = 0; i < ADDRESS_HASH_BYTES; i++) {
    const d = a[aOff + i]! - b[bOff + i]!;
    if (d !== 0) return d;
  }
  return 0;
}

/** Build the addresses.bin payload: sorted, de-duplicated 8-byte hashes, concatenated. */
export async function buildAddressSet(addresses: Iterable<string>): Promise<Uint8Array> {
  const hashes = await Promise.all([...new Set(addresses)].map(hashAddress));
  hashes.sort((a, b) => compareBytes(a, 0, b, 0));
  const out = new Uint8Array(hashes.length * ADDRESS_HASH_BYTES);
  let n = 0;
  for (const h of hashes) {
    if (n > 0 && compareBytes(out, (n - 1) * ADDRESS_HASH_BYTES, h, 0) === 0) continue;
    out.set(h, n++ * ADDRESS_HASH_BYTES);
  }
  return out.slice(0, n * ADDRESS_HASH_BYTES);
}

/**
 * The set of transparent addresses that funded a shield, as hashes. Membership is tested on the
 * user's device: the address they type is hashed locally and never sent anywhere.
 */
export class AddressSet {
  readonly size: number;

  constructor(private readonly hashes: Uint8Array) {
    if (hashes.length % ADDRESS_HASH_BYTES !== 0) {
      throw new SnapshotIntegrityError("addresses.bin length is not a multiple of 8");
    }
    this.size = hashes.length / ADDRESS_HASH_BYTES;
    for (let i = 1; i < this.size; i++) {
      if (compareBytes(hashes, (i - 1) * ADDRESS_HASH_BYTES, hashes, i * ADDRESS_HASH_BYTES) >= 0) {
        throw new SnapshotIntegrityError("addresses.bin is not strictly sorted");
      }
    }
  }

  async has(address: string): Promise<boolean> {
    const h = await hashAddress(address.trim());
    let lo = 0;
    let hi = this.size - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const c = compareBytes(this.hashes, mid * ADDRESS_HASH_BYTES, h, 0);
      if (c === 0) return true;
      if (c < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  }
}
