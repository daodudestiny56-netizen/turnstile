import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { MAX_ZAT } from "./amount.js";
import {
  AddressSet,
  MANIFEST_FORMAT,
  SnapshotIntegrityError,
  buildAddressSet,
  gunzip,
  loadSnapshot,
  parseManifest,
  sha256Hex,
  type Manifest,
} from "./integrity.js";
import {
  SnapshotFormatError,
  canonicalizeSnapshot,
  decodeSnapshot,
  encodeSnapshot,
  type SnapshotData,
} from "./snapshot.js";

const T0 = 1_782_864_000; // 2026-07-01

function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sample(seed: number, n = 2_000): SnapshotData {
  const r = rng(seed);
  const shields = Array.from({ length: n }, () => ({
    time: T0 + Math.floor(r() * 90 * 86_400),
    amount: 1 + Math.floor(r() * 5_000_000_000),
    entity: 1000 + Math.floor(r() * 300),
  }));
  shields.push({ time: T0, amount: MAX_ZAT, entity: 5 }, { time: T0, amount: MAX_ZAT, entity: 5 });
  const exits = Array.from({ length: n }, () => ({
    time: T0 + Math.floor(r() * 90 * 86_400),
    amount: 1 + Math.floor(r() * 5_000_000_000),
  }));
  return { dataFrom: T0, dataTo: T0 + 90 * 86_400, shields, services: [1003, 1007, 5], exits };
}

describe("snapshot codec", () => {
  it("round-trips canonical data exactly", () => {
    const data = canonicalizeSnapshot(sample(1));
    expect(decodeSnapshot(encodeSnapshot(data))).toEqual(data);
  });

  it("produces identical bytes whatever the input order or entity numbering", () => {
    const a = sample(2);
    const shuffled: SnapshotData = {
      ...a,
      shields: [...a.shields].reverse().map((s) => ({ ...s, entity: s.entity * 7 + 3 })),
      services: a.services.map((e) => e * 7 + 3).reverse(),
      exits: [...a.exits].reverse(),
    };
    expect(encodeSnapshot(canonicalizeSnapshot(shuffled))).toEqual(
      encodeSnapshot(canonicalizeSnapshot(a)),
    );
  });

  it("numbers entities by first appearance and keeps services attached to the right entity", () => {
    const c = canonicalizeSnapshot({
      dataFrom: T0,
      dataTo: T0 + 100,
      shields: [
        { time: T0 + 5, amount: 10, entity: 42 },
        { time: T0 + 1, amount: 10, entity: 99 },
      ],
      services: [42, 12345],
      exits: [],
    });
    expect(c.shields).toEqual([
      { time: T0 + 1, amount: 10, entity: 0 },
      { time: T0 + 5, amount: 10, entity: 1 },
    ]);
    expect(c.services).toEqual([1]); // 42 -> 1; an entity with no shields is dropped
  });

  it("refuses to encode data that isn't canonical", () => {
    expect(() => encodeSnapshot(sample(3))).toThrow(SnapshotFormatError);
  });

  it("rejects malformed input", () => {
    const good = encodeSnapshot(canonicalizeSnapshot(sample(4, 50)));
    const badMagic = good.slice();
    badMagic[0] = 0;
    const badVersion = good.slice();
    badVersion[4] = 99;
    expect(() => decodeSnapshot(badMagic)).toThrow(/not a Turnstile snapshot/);
    expect(() => decodeSnapshot(badVersion)).toThrow(/unsupported snapshot version 99/);
    expect(() => decodeSnapshot(good.slice(0, good.length - 3))).toThrow(SnapshotFormatError);
    expect(() => decodeSnapshot(new Uint8Array([...good, 0]))).toThrow(/trailing bytes/);
  });
});

describe("address set", () => {
  it("answers membership on hashed addresses", async () => {
    const set = new AddressSet(await buildAddressSet(["t1aaa", "t1bbb", "t1aaa", "t3ccc"]));
    expect(set.size).toBe(3);
    expect(await set.has("t1bbb")).toBe(true);
    expect(await set.has(" t3ccc ")).toBe(true);
    expect(await set.has("t1zzz")).toBe(false);
  });

  it("rejects a malformed set", async () => {
    const bytes = await buildAddressSet(["t1aaa", "t1bbb"]);
    expect(() => new AddressSet(bytes.slice(0, 12))).toThrow(SnapshotIntegrityError);
    const unsorted = new Uint8Array([...bytes.slice(8, 16), ...bytes.slice(0, 8)]);
    expect(() => new AddressSet(unsorted)).toThrow(/not strictly sorted/);
  });
});

async function bundle(): Promise<{
  manifest: Manifest;
  files: { snapshot: Uint8Array; addresses: Uint8Array; stats: Uint8Array };
}> {
  const data = canonicalizeSnapshot(sample(5, 500));
  const raw = encodeSnapshot(data);
  const snapshot = new Uint8Array(gzipSync(raw));
  const addresses = await buildAddressSet(["t1aaa", "t1bbb"]);
  const stats = new TextEncoder().encode('{"evaluated":0}\n');
  const manifest: Manifest = {
    format: MANIFEST_FORMAT,
    version: 1,
    source: "test",
    fromDay: "2026-07-01",
    toDay: "2026-09-28",
    counts: {
      shields: data.shields.length,
      entities: new Set(data.shields.map((s) => s.entity)).size,
      services: data.services.length,
      exits: data.exits.length,
      addresses: 2,
      auditAddresses: 0,
    },
    files: {
      "snapshot.bin.gz": {
        bytes: snapshot.length,
        sha256: await sha256Hex(snapshot),
        contentSha256: await sha256Hex(raw),
      },
      "addresses.bin": { bytes: addresses.length, sha256: await sha256Hex(addresses) },
      "stats.json": { bytes: stats.length, sha256: await sha256Hex(stats) },
      "audit.bin.gz": { bytes: 0, sha256: "0".repeat(64), contentSha256: "0".repeat(64) },
    },
  };
  return { manifest, files: { snapshot, addresses, stats } };
}

describe("loadSnapshot", () => {
  it("loads a verified bundle", async () => {
    const { manifest, files } = await bundle();
    const v = await loadSnapshot(parseManifest(JSON.stringify(manifest)), files);
    expect(v.data.shields).toHaveLength(manifest.counts.shields);
    expect(await v.addresses.has("t1aaa")).toBe(true);
    expect(v.stats).toEqual({ evaluated: 0 });
  });

  it("accepts a snapshot the host already decompressed (Content-Encoding: gzip)", async () => {
    const { manifest, files } = await bundle();
    const raw = await gunzip(files.snapshot);
    const v = await loadSnapshot(manifest, { ...files, snapshot: raw });
    expect(v.data.shields).toHaveLength(manifest.counts.shields);
  });

  it("rejects decompressed bytes that were altered", async () => {
    const { manifest, files } = await bundle();
    const raw = await gunzip(files.snapshot);
    raw[raw.length >> 1]! ^= 1;
    await expect(loadSnapshot(manifest, { ...files, snapshot: raw })).rejects.toThrow(
      /matches neither/,
    );
  });

  it("uses the platform gunzip compatibly with Node's zlib", async () => {
    const raw = new TextEncoder().encode("hello snapshot");
    expect(await gunzip(new Uint8Array(gzipSync(raw)))).toEqual(raw);
  });

  it("rejects a snapshot altered by even one byte", async () => {
    const { manifest, files } = await bundle();
    const snapshot = files.snapshot.slice();
    snapshot[snapshot.length >> 1]! ^= 1;
    await expect(loadSnapshot(manifest, { ...files, snapshot })).rejects.toThrow(
      /snapshot.bin.gz: SHA-256/,
    );
  });

  it("rejects altered content even if the attacker also updates the file hash", async () => {
    const { manifest, files } = await bundle();
    const raw = await gunzip(files.snapshot);
    raw[raw.length - 1]! ^= 1;
    const snapshot = new Uint8Array(gzipSync(raw));
    const forged: Manifest = {
      ...manifest,
      files: {
        ...manifest.files,
        "snapshot.bin.gz": {
          ...manifest.files["snapshot.bin.gz"],
          sha256: await sha256Hex(snapshot),
        },
      },
    };
    await expect(loadSnapshot(forged, { ...files, snapshot })).rejects.toThrow(
      /snapshot.bin.gz content: SHA-256/,
    );
  });

  it("rejects altered addresses or statistics", async () => {
    const { manifest, files } = await bundle();
    const addresses = files.addresses.slice();
    addresses[0]! ^= 1;
    await expect(loadSnapshot(manifest, { ...files, addresses })).rejects.toThrow(
      SnapshotIntegrityError,
    );
    const stats = new TextEncoder().encode('{"evaluated":1}\n');
    await expect(loadSnapshot(manifest, { ...files, stats })).rejects.toThrow(/stats.json/);
  });

  it("rejects a manifest whose counts don't match the data", async () => {
    const { manifest, files } = await bundle();
    const wrong = { ...manifest, counts: { ...manifest.counts, exits: manifest.counts.exits + 1 } };
    await expect(loadSnapshot(wrong, files)).rejects.toThrow(/counts do not match/);
  });

  it("rejects something that isn't a manifest", () => {
    expect(() => parseManifest('{"format":"other"}')).toThrow(SnapshotIntegrityError);
  });
});
