import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { toTex } from "./address.js";
import {
  AUDIT_MAX_ADDRESSES,
  AuditIndex,
  AuditInputError,
  auditAddresses,
  encodeAudit,
  loadAudit,
  splitAddresses,
  type AuditRefs,
} from "./audit.js";
import { SnapshotIntegrityError, sha256Hex, type Manifest } from "./integrity.js";
import { createPreflightContext } from "./preflight.js";
import { SnapshotFormatError, type SnapshotData } from "./snapshot.js";
import { gzipSync } from "node:zlib";

const H = 3_600;
const DAY = 86_400;
const T0 = 1_782_864_000;
const DATA_TO = T0 + 60 * DAY;

/** A valid mainnet t1 address for test number n (Base58Check, prefix 0x1CB8). */
function t1(n: number): string {
  const payload = Buffer.alloc(22);
  payload.writeUInt16BE(0x1cb8, 0);
  payload.writeUInt32BE(n, 18);
  const check = createHash("sha256")
    .update(createHash("sha256").update(payload).digest())
    .digest()
    .subarray(0, 4);
  let x = BigInt("0x" + Buffer.concat([payload, check]).toString("hex"));
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let out = "";
  while (x > 0n) {
    out = alphabet[Number(x % 58n)] + out;
    x /= 58n;
  }
  return out;
}

const MINE_IN = t1(1); // deposits 3.1745 ZEC
const MINE_OUT = t1(2); // receives 3.1742 ZEC an hour later: an exact round trip
const CROWD_OUT = t1(3); // receives 1 ZEC after all 15 parties deposited it
const REUSER = t1(4); // deposits, then receives a withdrawal itself
const STRANGER_IN = t1(5); // deposits 4.4445 ZEC
const STRANGER_OUT = t1(6); // receives 4.4442 ZEC two hours later
const EARLY_OUT = t1(7); // receives a withdrawal before the data can judge it
const NEVER = t1(8); // never crossed
const CO_SPENT = t1(9); // deposits 6.6665 ZEC as the same entity as MINE_IN
const MINE_OUT_2 = t1(10); // receives 6.6662 ZEC
const ROUND_IN = t1(11); // deposits 1 ZEC, a common amount
const ROUND_OUT = t1(12); // receives 1 ZEC two hours later: hidden by amount, not by timing

interface Fixture {
  data: SnapshotData;
  refs: Map<string, AuditRefs>;
}

function fixture(): Fixture {
  const shields: SnapshotData["shields"] = [];
  const exits: SnapshotData["exits"] = [];
  const refs = new Map<string, AuditRefs>();
  const ref = (address: string): AuditRefs => {
    const r = refs.get(address) ?? { shields: [], exits: [] };
    refs.set(address, r);
    return r;
  };
  const shield = (time: number, amount: number, entity: number, address?: string): void => {
    if (address) ref(address).shields.push(shields.length);
    shields.push({ time, amount, entity });
  };
  const exit = (time: number, amount: number, address?: string): void => {
    if (address) ref(address).exits.push(exits.length);
    exits.push({ time, amount });
  };
  for (let i = 0; i < 15; i++) shield(DATA_TO - (i + 2) * 6 * H, 100_030_000, i);
  shield(DATA_TO - 3 * DAY, 317_450_000, 500, MINE_IN);
  shield(DATA_TO - 10 * DAY, 222_250_000, 600, REUSER);
  shield(DATA_TO - 5 * DAY, 444_450_000, 700, STRANGER_IN);
  shield(DATA_TO - 4 * DAY, 666_650_000, 500, CO_SPENT);
  shield(DATA_TO - 3 * H, 100_030_000, 800, ROUND_IN);
  exits.length = 0;
  exit(T0 + 5 * DAY, 50_000_000, EARLY_OUT);
  exit(DATA_TO - 10 * DAY + 5 * H, 70_000_000, REUSER);
  exit(DATA_TO - 5 * DAY + 2 * H, 444_420_000, STRANGER_OUT);
  exit(DATA_TO - 4 * DAY + H, 666_620_000, MINE_OUT_2);
  exit(DATA_TO - 3 * DAY + H, 317_420_000, MINE_OUT);
  exit(DATA_TO - 2 * H, 100_000_000, CROWD_OUT);
  exit(DATA_TO - H, 100_000_000, ROUND_OUT);
  return { data: { dataFrom: T0, dataTo: DATA_TO, shields, services: [], exits }, refs };
}

async function setup(): Promise<{
  ctx: ReturnType<typeof createPreflightContext>;
  index: AuditIndex;
  bytes: Uint8Array;
}> {
  const { data, refs } = fixture();
  const bytes = await encodeAudit(refs);
  return { ctx: createPreflightContext(data), index: AuditIndex.decode(bytes, data), bytes };
}

describe("audit index", () => {
  it("round-trips and finds each address's deposits and withdrawals", async () => {
    const { index } = await setup();
    expect(index.size).toBe(11);
    expect(await index.lookup(MINE_IN)).toEqual({ shields: [15], exits: [] });
    expect(await index.lookup(REUSER)).toEqual({ shields: [16], exits: [1] });
    expect(await index.lookup(` ${MINE_OUT} `)).toEqual({ shields: [], exits: [4] });
    expect(await index.lookup(NEVER)).toEqual({ shields: [], exits: [] });
  });

  it("is canonical: insertion order doesn't change the bytes", async () => {
    const { refs } = fixture();
    const reversed = new Map([...refs].reverse());
    expect(await encodeAudit(reversed)).toEqual(await encodeAudit(refs));
  });

  it("rejects malformed files", async () => {
    const { data } = fixture();
    const { bytes } = await setup();
    const bad = (mutate: (b: Uint8Array) => Uint8Array): (() => AuditIndex) => {
      const copy = mutate(Uint8Array.from(bytes));
      return () => AuditIndex.decode(copy, data);
    };
    expect(bad((b) => ((b[0] = 0), b))).toThrow(SnapshotFormatError);
    expect(bad((b) => ((b[4] = 9), b))).toThrow(/version/);
    // Swap the first two hashes: no longer sorted.
    expect(
      bad((b) => {
        const first = b.slice(6, 14);
        b.copyWithin(6, 14, 22);
        b.set(first, 14);
        return b;
      }),
    ).toThrow(/sorted/);
    expect(bad((b) => b.slice(0, b.length - 1))).toThrow(SnapshotFormatError);
    expect(bad((b) => Uint8Array.from([...b, 0]))).toThrow(/trailing/);
    // An index for a bigger snapshot points past this one's withdrawals.
    expect(() =>
      AuditIndex.decode(bytes, { shields: data.shields, exits: data.exits.slice(0, 2) }),
    ).toThrow(/past the withdrawals/);
  });

  it("loads only when it matches the manifest, compressed or decompressed in transit", async () => {
    const { data } = fixture();
    const { bytes } = await setup();
    const gz = new Uint8Array(gzipSync(bytes));
    const manifest = {
      counts: { auditAddresses: 11 },
      files: {
        "audit.bin.gz": {
          bytes: gz.length,
          sha256: await sha256Hex(gz),
          contentSha256: await sha256Hex(bytes),
        },
      },
    } as unknown as Manifest;
    expect((await loadAudit(manifest, gz, data)).size).toBe(11);
    expect((await loadAudit(manifest, bytes, data)).size).toBe(11);
    const tampered = Uint8Array.from(gz);
    tampered[gz.length - 9]! ^= 1;
    await expect(loadAudit(manifest, tampered, data)).rejects.toThrow(/matches neither/);
    const wrongCount = { ...manifest, counts: { auditAddresses: 12 } } as Manifest;
    await expect(loadAudit(wrongCount, gz, data)).rejects.toThrow(SnapshotIntegrityError);
  });
});

describe("auditAddresses", () => {
  it("traces an exact round trip between the user's own addresses", async () => {
    const { ctx, index } = await setup();
    const r = await auditAddresses(ctx, index, [MINE_IN, MINE_OUT]);
    expect(r.verdict).toBe("red");
    expect(r.withdrawals).toHaveLength(1);
    const w = r.withdrawals[0]!;
    expect(w.findings.map((f) => f.code)).toEqual(["traced"]);
    expect(w.linkedDeposit).toEqual({
      time: DATA_TO - 3 * DAY,
      amount: 317_450_000,
      fromEnteredAddress: true,
    });
    // The deposit is in the data's last week, so the week after it isn't over.
    expect(r.deposits[0]!.findings.map((f) => f.code)).toEqual(["followed-to-yours", "partial"]);
    expect(r.deposits[0]!.linkedToYours).toBe(1);
    expect(r.summary).toMatchObject({ withdrawals: 1, judged: 1, traced: 1, followed: 1 });
  });

  it("traces through a deposit made by an address spent together with the user's", async () => {
    const { ctx, index } = await setup();
    // CO_SPENT is the same entity as MINE_IN; the user enters MINE_IN, not CO_SPENT.
    const r = await auditAddresses(ctx, index, [MINE_IN, MINE_OUT_2]);
    const w = r.withdrawals[0]!;
    expect(w.findings[0]!.code).toBe("traced");
    expect(w.linkedDeposit).toEqual({
      time: DATA_TO - 4 * DAY,
      amount: 666_650_000,
      fromEnteredAddress: false,
    });
    expect(w.findings[0]!.message).toMatch(/spent together with yours/);
  });

  it("says a withdrawal elsewhere is linked to a deposit, without saying which", async () => {
    const { ctx, index } = await setup();
    const r = await auditAddresses(ctx, index, [STRANGER_IN]);
    expect(r.withdrawals).toEqual([]);
    const d = r.deposits[0]!;
    expect(d.findings.map((f) => f.code)).toEqual(["followed-elsewhere", "partial"]);
    expect(d.linkedElsewhere).toBe(1);
    // Nothing in the result names the withdrawal's amount, time or address.
    const text = JSON.stringify(r);
    expect(text).not.toContain(STRANGER_OUT);
    expect(text).not.toContain("444420000");
    expect(text).not.toContain("4.4442");
    expect(text).not.toContain(String(DATA_TO - 5 * DAY + 2 * H));
  });

  it("says a withdrawal is singled out, without saying to which deposit", async () => {
    const { ctx, index } = await setup();
    const r = await auditAddresses(ctx, index, [STRANGER_OUT]);
    const w = r.withdrawals[0]!;
    expect(w.verdict).toBe("amber");
    expect(w.findings.map((f) => f.code)).toEqual(["singled-out"]);
    expect(w.linkedDeposit).toBeUndefined();
    const text = JSON.stringify(r);
    expect(text).not.toContain(STRANGER_IN);
    expect(text).not.toContain("444450000");
    expect(text).not.toContain(String(DATA_TO - 5 * DAY));
  });

  it("flags a withdrawal to an address that also deposited", async () => {
    const { ctx, index } = await setup();
    const r = await auditAddresses(ctx, index, [REUSER]);
    expect(r.withdrawals[0]!.findings[0]!.code).toBe("address-reuse");
    expect(r.withdrawals[0]!.verdict).toBe("red");
    expect(r.summary.traced).toBe(1);
  });

  it("is green inside a crowd", async () => {
    const { ctx, index } = await setup();
    const r = await auditAddresses(ctx, index, [CROWD_OUT]);
    expect(r.verdict).toBe("green");
    expect(r.withdrawals[0]!.findings.map((f) => f.code)).toEqual(["crowd"]);
    // 15 parties, plus ROUND_IN's deposit an hour before it.
    expect(r.withdrawals[0]!.crowd).toBe(16);
  });

  it("warns when the user's deposit is the closest match in time, even in a crowd", async () => {
    const { ctx, index } = await setup();
    const r = await auditAddresses(ctx, index, [ROUND_IN, ROUND_OUT]);
    const w = r.withdrawals[0]!;
    expect(w.verdict).toBe("amber");
    expect(w.findings.map((f) => f.code)).toEqual(["crowd", "best-guess"]);
    expect(w.linkedDeposit).toBeUndefined();
  });

  it("doesn't judge a withdrawal without enough history before it", async () => {
    const { ctx, index } = await setup();
    const r = await auditAddresses(ctx, index, [EARLY_OUT]);
    expect(r.withdrawals[0]!.verdict).toBeUndefined();
    expect(r.withdrawals[0]!.findings.map((f) => f.code)).toEqual(["too-early"]);
    expect(r.summary).toMatchObject({ withdrawals: 1, judged: 0, traced: 0 });
    expect(r.verdict).toBe("green");
  });

  it("explains inputs it can't check, and treats a tex1 address as its t1 account", async () => {
    const { ctx, index } = await setup();
    const tex = (await toTex(MINE_IN))!;
    const r = await auditAddresses(ctx, index, [
      MINE_IN,
      tex,
      NEVER,
      "zs1mrhc9y7jdh5r9ece8u5khgvj9kg0zgkxzdduyv0whkg7lkcrkx5xqem3e48avjq9wn2rukydkwn",
      "t1NotARealAddress",
    ]);
    expect(r.addresses.map((a) => [a.address ?? null, a.deposits, a.withdrawals])).toEqual([
      [MINE_IN, 1, 0],
      [MINE_IN, 0, 0],
      [NEVER, 0, 0],
      [null, 0, 0],
      [null, 0, 0],
    ]);
    expect(r.addresses[1]!.problem).toMatch(/Same account/);
    expect(r.addresses[3]!.problem).toBeTruthy();
    expect(r.addresses[4]!.problem).toBeTruthy();
    expect(r.deposits).toHaveLength(1);
  });

  it("refuses an empty list and too many addresses", async () => {
    const { ctx, index } = await setup();
    await expect(auditAddresses(ctx, index, [" ", ""])).rejects.toThrow(AuditInputError);
    const many = Array.from({ length: AUDIT_MAX_ADDRESSES + 1 }, (_, i) => t1(1000 + i));
    await expect(auditAddresses(ctx, index, many)).rejects.toThrow(/at most/);
  });

  it("splits pasted text on spaces, commas, semicolons and new lines", () => {
    expect(splitAddresses(` a,b;c\n\nd  a\r\ne\t`)).toEqual(["a", "b", "c", "d", "e"]);
  });
});
