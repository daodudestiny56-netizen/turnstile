/**
 * Personal Audit: which of my past withdrawals could an observer trace back to my deposits?
 *
 * The audit index maps each transparent address (as an 8-byte hash, the same one the reuse check
 * uses) to the deposits it funded and the withdrawals it received, by position in the snapshot.
 * Every visitor downloads the same index; the addresses a user enters are hashed and looked up on
 * their device.
 *
 * What it reveals is deliberately limited. Full details are given only for links between the
 * addresses the user entered. For anything else it says that a link exists, never where it leads,
 * so the audit can't be pointed at a stranger's address to follow their money.
 */
import { parseAddress } from "./address.js";
import { formatZat } from "./amount.js";
import {
  ADDRESS_HASH_BYTES,
  SnapshotIntegrityError,
  compareBytes,
  hashAddress,
  verifyGzipped,
  type Manifest,
} from "./integrity.js";
import {
  feeShapedEntities,
  historyNeededSec,
  listCandidates,
  scoreExit,
  type ExitQuery,
  type ExitScore,
  type ShieldPoint,
} from "./matcher.js";
import { CROWD_TARGET, type PreflightContext, type Verdict } from "./preflight.js";
import { Reader, SnapshotFormatError, Writer, type SnapshotData } from "./snapshot.js";

export const AUDIT_VERSION = 1;
const MAGIC = [0x54, 0x41, 0x55, 0x44]; // "TAUD"

/** Most addresses one audit accepts. */
export const AUDIT_MAX_ADDRESSES = 50;
/** Most deposits and withdrawals one audit scores (the most recent are kept). */
export const AUDIT_MAX_EVENTS = 300;

export interface AuditRefs {
  /** Positions in SnapshotData.shields, ascending. */
  shields: number[];
  /** Positions in SnapshotData.exits, ascending. */
  exits: number[];
}

const sortedUnique = (xs: Iterable<number>): number[] => [...new Set(xs)].sort((a, b) => a - b);

/**
 * Serialize the audit index. Layout (version 1), integers as unsigned varints:
 *
 *   "TAUD" | version (1 byte) | count | hashes (8 bytes each, strictly ascending)
 *   then per address: shield count | shield position deltas | exit count | exit position deltas
 *
 * Canonical: the same addresses and events always give the same bytes.
 */
export async function encodeAudit(byAddress: ReadonlyMap<string, AuditRefs>): Promise<Uint8Array> {
  const entries = await Promise.all(
    [...byAddress].map(async ([address, refs]) => ({ hash: await hashAddress(address), refs })),
  );
  entries.sort((a, b) => compareBytes(a.hash, 0, b.hash, 0));
  // Two addresses sharing a 64-bit hash prefix is practically impossible; merge rather than fail.
  const merged: { hash: Uint8Array; shields: number[]; exits: number[] }[] = [];
  for (const e of entries) {
    const last = merged[merged.length - 1];
    if (last && compareBytes(last.hash, 0, e.hash, 0) === 0) {
      last.shields = sortedUnique([...last.shields, ...e.refs.shields]);
      last.exits = sortedUnique([...last.exits, ...e.refs.exits]);
    } else {
      merged.push({
        hash: e.hash,
        shields: sortedUnique(e.refs.shields),
        exits: sortedUnique(e.refs.exits),
      });
    }
  }
  const w = new Writer();
  for (const b of MAGIC) w.byte(b);
  w.byte(AUDIT_VERSION);
  w.uint(merged.length);
  for (const m of merged) w.raw(m.hash);
  const list = (xs: number[]): void => {
    w.uint(xs.length);
    let prev = 0;
    xs.forEach((x, i) => {
      w.uint(i === 0 ? x : x - prev);
      prev = x;
    });
  };
  for (const m of merged) {
    list(m.shields);
    list(m.exits);
  }
  return w.bytes();
}

/** The decoded audit index: address hash -> deposits funded and withdrawals received. */
export class AuditIndex {
  private constructor(
    readonly size: number,
    private readonly hashes: Uint8Array,
    private readonly shieldStart: Uint32Array,
    private readonly exitStart: Uint32Array,
    private readonly shieldRefs: Uint32Array,
    private readonly exitRefs: Uint32Array,
  ) {}

  /** Parse and check an index against the snapshot it belongs to. */
  static decode(bytes: Uint8Array, data: Pick<SnapshotData, "shields" | "exits">): AuditIndex {
    const r = new Reader(bytes);
    for (const b of MAGIC) {
      if (r.byte() !== b) throw new SnapshotFormatError("not a Turnstile audit index");
    }
    const version = r.byte();
    if (version !== AUDIT_VERSION) {
      throw new SnapshotFormatError(`unsupported audit index version ${version}`);
    }
    const n = r.count("address");
    const hashes = r.raw(n * ADDRESS_HASH_BYTES);
    for (let i = 1; i < n; i++) {
      if (compareBytes(hashes, (i - 1) * ADDRESS_HASH_BYTES, hashes, i * ADDRESS_HASH_BYTES) >= 0) {
        throw new SnapshotFormatError("audit index addresses are not strictly sorted");
      }
    }
    const shieldStart = new Uint32Array(n + 1);
    const exitStart = new Uint32Array(n + 1);
    const shieldRefs: number[] = [];
    const exitRefs: number[] = [];
    const list = (out: number[], limit: number, what: string): void => {
      const k = r.count(what);
      let x = 0;
      for (let j = 0; j < k; j++) {
        const d = r.uint();
        if (j > 0 && d === 0) throw new SnapshotFormatError(`audit index ${what} list repeats`);
        x = j === 0 ? d : x + d;
        if (x >= limit) throw new SnapshotFormatError(`audit index points past the ${what}s`);
        out.push(x);
      }
    };
    for (let i = 0; i < n; i++) {
      list(shieldRefs, data.shields.length, "deposit");
      shieldStart[i + 1] = shieldRefs.length;
      list(exitRefs, data.exits.length, "withdrawal");
      exitStart[i + 1] = exitRefs.length;
    }
    if (!r.done) throw new SnapshotFormatError("trailing bytes after audit index");
    return new AuditIndex(
      n,
      hashes,
      shieldStart,
      exitStart,
      Uint32Array.from(shieldRefs),
      Uint32Array.from(exitRefs),
    );
  }

  /** Deposits and withdrawals of one transparent address; empty when it never crossed. */
  async lookup(address: string): Promise<AuditRefs> {
    const h = await hashAddress(address.trim());
    let lo = 0;
    let hi = this.size - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const c = compareBytes(this.hashes, mid * ADDRESS_HASH_BYTES, h, 0);
      if (c === 0) {
        return {
          shields: Array.from(
            this.shieldRefs.subarray(this.shieldStart[mid], this.shieldStart[mid + 1]),
          ),
          exits: Array.from(this.exitRefs.subarray(this.exitStart[mid], this.exitStart[mid + 1])),
        };
      }
      if (c < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return { shields: [], exits: [] };
  }
}

/** Verify the published audit file against the manifest, then decode it. */
export async function loadAudit(
  manifest: Manifest,
  bytes: Uint8Array,
  data: Pick<SnapshotData, "shields" | "exits">,
): Promise<AuditIndex> {
  const raw = await verifyGzipped("audit.bin.gz", bytes, manifest.files["audit.bin.gz"]);
  const index = AuditIndex.decode(raw, data);
  if (index.size !== manifest.counts.auditAddresses) {
    throw new SnapshotIntegrityError("audit index count does not match the manifest");
  }
  return index;
}

/* ----- The audit ----- */

export type AuditCode =
  /** Linked to a deposit from the user's own addresses (or ones spent together with them). */
  | "traced"
  /** The receiving address also funded a deposit into the pool. */
  | "address-reuse"
  /** Linked to one deposit that isn't from the addresses entered. */
  | "singled-out"
  | "thin-crowd"
  /** Not linkable, but the user's deposit is an observer's single best guess. */
  | "best-guess"
  | "crowd"
  | "no-match"
  /** Not enough history before it in the data to judge. */
  | "too-early"
  /** Deposit: a withdrawal to an address the user entered was linked to it. */
  | "followed-to-yours"
  /** Deposit: a withdrawal to some other address was linked to it (where is not shown). */
  | "followed-elsewhere"
  /** Deposit: no withdrawal in the following week was linked to it. */
  | "not-followed"
  /** Deposit: the week after it isn't fully in the data. */
  | "partial";

export interface AuditFinding {
  code: AuditCode;
  severity: Verdict;
  message: string;
}

export interface AuditedWithdrawal {
  time: number;
  amount: number;
  /** Which of the entered addresses received it. */
  addresses: string[];
  /** Worst finding; undefined when it couldn't be judged. */
  verdict?: Verdict;
  findings: AuditFinding[];
  /** Other parties that could equally have funded it (excluding the user). */
  crowd: number;
  /** Only for "traced": the user's own deposit it was linked to. */
  linkedDeposit?: { time: number; amount: number; fromEnteredAddress: boolean };
}

export interface AuditedDeposit {
  time: number;
  amount: number;
  /** Which of the entered addresses funded it. */
  addresses: string[];
  verdict: Verdict;
  findings: AuditFinding[];
  /** Withdrawals to the entered addresses linked to this deposit. */
  linkedToYours: number;
  /** Withdrawals elsewhere linked to this deposit: a count, never which. */
  linkedElsewhere: number;
}

export interface AuditedAddress {
  input: string;
  /** The transparent address checked (a tex1 address becomes its t1 form). */
  address?: string;
  problem?: string;
  deposits: number;
  withdrawals: number;
}

export interface AuditResult {
  verdict: Verdict;
  addresses: AuditedAddress[];
  /** Newest first. */
  withdrawals: AuditedWithdrawal[];
  /** Newest first. */
  deposits: AuditedDeposit[];
  summary: {
    withdrawals: number;
    /** Withdrawals that could be judged. */
    judged: number;
    /** Traced to the user's deposits, or sent to an address that also deposited. */
    traced: number;
    singledOut: number;
    deposits: number;
    /** Deposits linked to at least one withdrawal anywhere. */
    followed: number;
  };
  /** Some deposits or withdrawals were left out (more than AUDIT_MAX_EVENTS). */
  truncated: boolean;
  data: { dataFrom: number; dataTo: number };
}

const RANK: Record<Verdict, number> = { green: 0, amber: 1, red: 2 };
const worst = (findings: AuditFinding[]): Verdict | undefined =>
  findings.reduce<Verdict | undefined>(
    (v, f) => (v === undefined || RANK[f.severity] > RANK[v] ? f.severity : v),
    undefined,
  );
const zec = (zat: number): string => `${formatZat(zat)} ZEC`;
const date = (t: number): string =>
  `${new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const sameShield = (a: ShieldPoint, b: ShieldPoint): boolean =>
  a.time === b.time && a.amount === b.amount && a.entity === b.entity;

/** Split pasted text into addresses: any mix of spaces, commas, semicolons and new lines. */
export function splitAddresses(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).filter((s) => s !== ""))];
}

export class AuditInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditInputError";
  }
}

/**
 * The deposit an observer would pick for a linkable exit: the heaviest fee-shaped candidate of the
 * top entity, the same rule the Pre-flight Check uses.
 */
function matchedShield(
  ctx: PreflightContext,
  exit: ExitQuery,
  topEntity: number,
): ShieldPoint | undefined {
  return listCandidates(ctx.index, exit, ctx.params).find(
    (c) => c.entity === topEntity && c.feeShaped,
  );
}

export async function auditAddresses(
  ctx: PreflightContext,
  index: AuditIndex,
  inputs: readonly string[],
): Promise<AuditResult> {
  const p = ctx.params;
  const { dataFrom, dataTo, shields, exits } = ctx.data;
  const unique = [...new Set(inputs.map((s) => s.trim()).filter((s) => s !== ""))];
  if (unique.length === 0) throw new AuditInputError("Enter at least one transparent address.");
  if (unique.length > AUDIT_MAX_ADDRESSES) {
    throw new AuditInputError(`Enter at most ${AUDIT_MAX_ADDRESSES} addresses at a time.`);
  }

  const addresses: AuditedAddress[] = [];
  const shieldOwners = new Map<number, string[]>();
  const exitOwners = new Map<number, string[]>();
  const depositingAddresses = new Set<string>();
  for (const input of unique) {
    const parsed = await parseAddress(input);
    if (!parsed.transparent) {
      addresses.push({
        input,
        problem:
          parsed.problem ??
          "Only transparent addresses cross the pool's boundary in public; enter a t1, t3 or tex1 address.",
        deposits: 0,
        withdrawals: 0,
      });
      continue;
    }
    const address = parsed.transparent;
    const refs = await index.lookup(address);
    addresses.push({
      input,
      address,
      deposits: refs.shields.length,
      withdrawals: refs.exits.length,
    });
    if (refs.shields.length > 0) depositingAddresses.add(address);
    for (const i of refs.shields) {
      const owners = shieldOwners.get(i) ?? [];
      if (!owners.includes(address)) owners.push(address);
      shieldOwners.set(i, owners);
    }
    for (const i of refs.exits) {
      const owners = exitOwners.get(i) ?? [];
      if (!owners.includes(address)) owners.push(address);
      exitOwners.set(i, owners);
    }
  }
  // Two inputs for the same account (a tex1 and its t1) are one address.
  const seen = new Set<string>();
  for (const a of addresses) {
    if (a.address && seen.has(a.address)) {
      a.problem = `Same account as an address above (${a.address}).`;
      a.deposits = 0;
      a.withdrawals = 0;
    } else if (a.address) {
      seen.add(a.address);
    }
  }

  const myEntities = new Set([...shieldOwners.keys()].map((i) => shields[i]!.entity));
  const newestFirst = (m: Map<number, string[]>): number[] => [...m.keys()].sort((a, b) => b - a);
  const shieldIdx = newestFirst(shieldOwners);
  const exitIdx = newestFirst(exitOwners);
  const truncated = shieldIdx.length > AUDIT_MAX_EVENTS || exitIdx.length > AUDIT_MAX_EVENTS;
  const scoredFrom = dataFrom + historyNeededSec(p);
  // Deposits close in time share their candidate withdrawals; score each withdrawal once.
  const scores = new Map<number, ExitScore>();
  const scoreOf = (j: number): ExitScore => {
    let score = scores.get(j);
    if (!score) scores.set(j, (score = scoreExit(ctx.index, exits[j]!, p)));
    return score;
  };
  const matches = new Map<number, ShieldPoint | undefined>();
  const matchOf = (j: number, topEntity: number): ShieldPoint | undefined => {
    if (!matches.has(j)) matches.set(j, matchedShield(ctx, exits[j]!, topEntity));
    return matches.get(j);
  };

  /* Withdrawals to the entered addresses. */
  const withdrawals: AuditedWithdrawal[] = [];
  for (const i of exitIdx.slice(0, AUDIT_MAX_EVENTS)) {
    const exit = exits[i]!;
    const owners = exitOwners.get(i)!;
    const findings: AuditFinding[] = [];
    let crowd = 0;
    let linkedDeposit: AuditedWithdrawal["linkedDeposit"];
    const reused = owners.filter((a) => depositingAddresses.has(a));
    if (reused.length > 0) {
      findings.push({
        code: "address-reuse",
        severity: "red",
        message:
          `${reused.join(", ")} received this withdrawal and also funded a deposit into the pool. ` +
          "The address alone links the two, whatever the amounts.",
      });
    }
    if (exit.time < scoredFrom) {
      findings.push({
        code: "too-early",
        severity: "green",
        message:
          `Too early in the data to judge by amount and timing: that needs ` +
          `${historyNeededSec(p) / 86_400} days of deposits before it.`,
      });
    } else {
      const score = scoreOf(i);
      const rivals = feeShapedEntities(ctx.index, exit, p);
      for (const e of myEntities) rivals.delete(e);
      crowd = rivals.size;
      if (score.linkable && myEntities.has(score.topEntity)) {
        const s = matchOf(i, score.topEntity);
        const fromEnteredAddress =
          s !== undefined && shieldIdx.some((j) => sameShield(shields[j]!, s));
        if (s) linkedDeposit = { time: s.time, amount: s.amount, fromEnteredAddress };
        findings.push({
          code: "traced",
          severity: "red",
          message:
            (s
              ? `Linked to ${fromEnteredAddress ? "your" : "a"} deposit of ${zec(s.amount)} on ${date(s.time)}` +
                (fromEnteredAddress
                  ? ". "
                  : ", made from an address spent together with yours (the same owner, as far as the chain shows). ")
              : "Linked to one of your deposits. ") +
            "Amount and timing single it out; nobody else deposited an amount like it.",
        });
      } else if (score.linkable) {
        findings.push({
          code: "singled-out",
          severity: "amber",
          message:
            "An observer would tie this withdrawal to one deposit, not from the addresses you entered. " +
            "If that deposit was yours, made from another address, add that address to see it; if not, " +
            "you'd be wrongly tied to someone else.",
        });
      } else {
        const mineIsTop = score.topFeeShaped && myEntities.has(score.topEntity);
        if (crowd >= CROWD_TARGET) {
          findings.push({
            code: "crowd",
            severity: "green",
            message: `Hidden in a crowd: ${crowd} other parties made deposits that match it.`,
          });
        } else if (crowd > 0) {
          findings.push({
            code: "thin-crowd",
            severity: "amber",
            message: `Only ${crowd} other ${crowd === 1 ? "party" : "parties"} made a deposit that matches it.`,
          });
        } else if (!mineIsTop) {
          findings.push({
            code: "no-match",
            severity: "green",
            message: "No deposit in the week before it matches by amount and timing.",
          });
        }
        if (mineIsTop) {
          findings.push({
            code: "best-guess",
            severity: "amber",
            message:
              crowd > 0
                ? "Of the deposits that match, yours is the closest in time, so an observer who picks " +
                  "the most likely one would pick yours."
                : "Yours is the only deposit that matches it in the week before. Others often use this " +
                  "amount, so it isn't proof, but an observer's best guess is you.",
          });
        }
      }
    }
    const judged = findings.filter((f) => f.code !== "too-early");
    const verdict = worst(judged);
    withdrawals.push({
      time: exit.time,
      amount: exit.amount,
      addresses: owners,
      ...(verdict ? { verdict } : {}),
      findings,
      crowd,
      ...(linkedDeposit ? { linkedDeposit } : {}),
    });
  }

  /* Deposits from the entered addresses: was any withdrawal in the following week linked to them? */
  const firstExitAfter = (t: number): number => {
    let lo = 0;
    let hi = exits.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (exits[mid]!.time <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const deposits: AuditedDeposit[] = [];
  for (const i of shieldIdx.slice(0, AUDIT_MAX_EVENTS)) {
    const s = shields[i]!;
    let linkedToYours = 0;
    let linkedElsewhere = 0;
    for (let j = firstExitAfter(s.time); j < exits.length; j++) {
      const exit = exits[j]!;
      if (exit.time - s.time > p.windowSec) break;
      const diff = s.amount - exit.amount;
      if (diff < 0 || diff > p.feeMaxZat || diff % p.feeUnitZat !== 0) continue;
      if (exit.time < scoredFrom) continue;
      const score = scoreOf(j);
      if (!score.linkable || score.topEntity !== s.entity) continue;
      const m = matchOf(j, score.topEntity);
      if (!m || !sameShield(m, s)) continue;
      if (exitOwners.has(j)) linkedToYours++;
      else linkedElsewhere++;
    }
    const findings: AuditFinding[] = [];
    if (linkedToYours > 0) {
      findings.push({
        code: "followed-to-yours",
        severity: "red",
        message: `${linkedToYours === 1 ? "A withdrawal" : `${linkedToYours} withdrawals`} to your addresses can be traced back to this deposit (listed above).`,
      });
    }
    if (linkedElsewhere > 0) {
      findings.push({
        code: "followed-elsewhere",
        severity: "amber",
        message:
          `${linkedElsewhere === 1 ? "A withdrawal" : `${linkedElsewhere} withdrawals`} to an address you didn't enter ` +
          `${linkedElsewhere === 1 ? "is" : "are"} linked to this deposit. If you made it, add that address to see the ` +
          "details; Turnstile doesn't show where other people's money went.",
      });
    }
    if (linkedToYours === 0 && linkedElsewhere === 0) {
      findings.push({
        code: "not-followed",
        severity: "green",
        message: "No withdrawal in the week after it is linked to it.",
      });
    }
    if (s.time + p.windowSec > dataTo) {
      findings.push({
        code: "partial",
        severity: "green",
        message: `The data ends ${date(dataTo)}, before the week after this deposit was over.`,
      });
    } else if (s.time < scoredFrom) {
      findings.push({
        code: "partial",
        severity: "green",
        message: "Early in the data: withdrawals right after it can't all be judged.",
      });
    }
    deposits.push({
      time: s.time,
      amount: s.amount,
      addresses: shieldOwners.get(i)!,
      verdict: worst(findings)!,
      findings,
      linkedToYours,
      linkedElsewhere,
    });
  }

  const traced = withdrawals.filter((w) =>
    w.findings.some((f) => f.code === "traced" || f.code === "address-reuse"),
  ).length;
  const verdicts = [...withdrawals.map((w) => w.verdict), ...deposits.map((d) => d.verdict)];
  const verdict = verdicts.reduce<Verdict>(
    (v, x) => (x !== undefined && RANK[x] > RANK[v] ? x : v),
    "green",
  );
  return {
    verdict,
    addresses,
    withdrawals,
    deposits,
    summary: {
      withdrawals: withdrawals.length,
      judged: withdrawals.filter((w) => w.verdict !== undefined).length,
      traced,
      singledOut: withdrawals.filter((w) => w.findings.some((f) => f.code === "singled-out"))
        .length,
      deposits: deposits.length,
      followed: deposits.filter((d) => d.linkedToYours + d.linkedElsewhere > 0).length,
    },
    truncated,
    data: { dataFrom, dataTo },
  };
}
