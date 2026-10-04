import type { ExitQuery, ShieldPoint } from "./matcher.js";

/**
 * The public snapshot every client downloads (PRD section 7.4). Everyone gets the same bytes, and all
 * checks run locally against it, so a user's planned amounts never leave their device.
 *
 * Binary layout (version 1), every integer an unsigned LEB128 varint:
 *
 *   "TSNP" | version (1 byte) | dataFrom | dataTo
 *   shields: count | time deltas | amounts | entities      (sorted by time, amount, entity)
 *   services: count | entity id deltas                     (sorted)
 *   exits: count | time deltas | amounts                   (sorted by time, amount)
 *
 * Columns are stored one after another so gzip sees similar values together. The encoding is
 * canonical: entities are numbered by first appearance in shield order, so the same events always
 * produce the same bytes.
 */

export const SNAPSHOT_VERSION = 1;
const MAGIC = [0x54, 0x53, 0x4e, 0x50]; // "TSNP"

export interface SnapshotData {
  /** Unix seconds; the data covers [dataFrom, dataTo). */
  dataFrom: number;
  dataTo: number;
  shields: ShieldPoint[];
  /** Entity ids treated as services (see serviceEntities). */
  services: number[];
  /** Exits that are not batch payouts. */
  exits: ExitQuery[];
}

export class SnapshotFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotFormatError";
  }
}

const byShield = (a: ShieldPoint, b: ShieldPoint): number =>
  a.time - b.time || a.amount - b.amount || a.entity - b.entity;
const byExit = (a: ExitQuery, b: ExitQuery): number => a.time - b.time || a.amount - b.amount;

/** Canonical snapshot data plus, for each canonical position, the input index it came from. */
export interface CanonicalSnapshot {
  data: SnapshotData;
  /** shieldFrom[k] = index in the input's shields of canonical shield k. */
  shieldFrom: number[];
  /** exitFrom[k] = index in the input's exits of canonical exit k. */
  exitFrom: number[];
}

/**
 * Sort everything and renumber entities 0..n-1 by first appearance. Two snapshots of the same events
 * are byte-identical after this, whatever order or entity numbering they arrived with. Also reports
 * where each event moved, so files that refer to events by position can follow them.
 */
export function canonicalizeSnapshotWithOrder(data: SnapshotData): CanonicalSnapshot {
  const S = data.shields;
  const first = S.map((_, i) => i).sort((a, b) => byShield(S[a]!, S[b]!));
  // Renumbering can reorder shields that share time and amount, so sort, renumber, sort again.
  const renumber = new Map<number, number>();
  for (const i of first) if (!renumber.has(S[i]!.entity)) renumber.set(S[i]!.entity, renumber.size);
  const point = (i: number): ShieldPoint => ({
    time: S[i]!.time,
    amount: S[i]!.amount,
    entity: renumber.get(S[i]!.entity)!,
  });
  const shieldFrom = first.sort((a, b) => byShield(point(a), point(b)));
  const shields = shieldFrom.map(point);
  const services = [
    ...new Set(data.services.filter((e) => renumber.has(e)).map((e) => renumber.get(e)!)),
  ].sort((a, b) => a - b);
  const E = data.exits;
  const exitFrom = E.map((_, i) => i).sort((a, b) => byExit(E[a]!, E[b]!));
  const exits = exitFrom.map((i) => ({ time: E[i]!.time, amount: E[i]!.amount }));
  return {
    data: { dataFrom: data.dataFrom, dataTo: data.dataTo, shields, services, exits },
    shieldFrom,
    exitFrom,
  };
}

export function canonicalizeSnapshot(data: SnapshotData): SnapshotData {
  return canonicalizeSnapshotWithOrder(data).data;
}

/** Varint writer shared by the snapshot and audit formats. */
export class Writer {
  private buf = new Uint8Array(1 << 16);
  private len = 0;

  byte(b: number): void {
    if (this.len === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    this.buf[this.len++] = b;
  }

  /** Unsigned varint for any safe integer (arithmetic, not bit ops, so values above 2^32 work). */
  uint(n: number): void {
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new SnapshotFormatError(`cannot encode ${n}: not a non-negative safe integer`);
    }
    while (n >= 0x80) {
      this.byte((n % 0x80) | 0x80);
      n = Math.floor(n / 0x80);
    }
    this.byte(n);
  }

  raw(bytes: Uint8Array): void {
    for (const b of bytes) this.byte(b);
  }

  bytes(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

export class Reader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  byte(): number {
    if (this.pos >= this.buf.length) throw new SnapshotFormatError("snapshot is truncated");
    return this.buf[this.pos++]!;
  }

  uint(): number {
    let n = 0;
    let scale = 1;
    for (;;) {
      const b = this.byte();
      n += (b & 0x7f) * scale;
      if (b < 0x80) break;
      scale *= 0x80;
      if (scale > Number.MAX_SAFE_INTEGER) throw new SnapshotFormatError("varint too long");
    }
    return n;
  }

  raw(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new SnapshotFormatError("snapshot is truncated");
    const out = this.buf.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  count(what: string): number {
    const n = this.uint();
    if (n > this.buf.length) throw new SnapshotFormatError(`implausible ${what} count ${n}`);
    return n;
  }

  get done(): boolean {
    return this.pos === this.buf.length;
  }
}

function assertCanonical(data: SnapshotData): void {
  const c = canonicalizeSnapshot(data);
  const same =
    c.shields.length === data.shields.length &&
    c.shields.every((s, i) => byShield(s, data.shields[i]!) === 0) &&
    c.services.length === data.services.length &&
    c.services.every((e, i) => e === data.services[i]) &&
    c.exits.length === data.exits.length &&
    c.exits.every((e, i) => byExit(e, data.exits[i]!) === 0);
  if (!same) throw new SnapshotFormatError("snapshot data is not canonical; canonicalize first");
}

/** Serialize canonical snapshot data (see canonicalizeSnapshot). */
export function encodeSnapshot(data: SnapshotData): Uint8Array {
  assertCanonical(data);
  const w = new Writer();
  for (const b of MAGIC) w.byte(b);
  w.byte(SNAPSHOT_VERSION);
  w.uint(data.dataFrom);
  w.uint(data.dataTo);

  w.uint(data.shields.length);
  let prev = data.dataFrom;
  for (const s of data.shields) {
    w.uint(s.time - prev);
    prev = s.time;
  }
  for (const s of data.shields) w.uint(s.amount);
  for (const s of data.shields) w.uint(s.entity);

  w.uint(data.services.length);
  let prevEntity = 0;
  for (const e of data.services) {
    w.uint(e - prevEntity);
    prevEntity = e;
  }

  w.uint(data.exits.length);
  prev = data.dataFrom;
  for (const e of data.exits) {
    w.uint(e.time - prev);
    prev = e.time;
  }
  for (const e of data.exits) w.uint(e.amount);
  return w.bytes();
}

/** Parse a snapshot; throws SnapshotFormatError on anything malformed. */
export function decodeSnapshot(bytes: Uint8Array): SnapshotData {
  const r = new Reader(bytes);
  for (const b of MAGIC) {
    if (r.byte() !== b) throw new SnapshotFormatError("not a Turnstile snapshot");
  }
  const version = r.byte();
  if (version !== SNAPSHOT_VERSION) {
    throw new SnapshotFormatError(`unsupported snapshot version ${version}`);
  }
  const dataFrom = r.uint();
  const dataTo = r.uint();

  const nShields = r.count("shield");
  const times: number[] = new Array(nShields);
  let t = dataFrom;
  for (let i = 0; i < nShields; i++) times[i] = t += r.uint();
  const amounts: number[] = new Array(nShields);
  for (let i = 0; i < nShields; i++) amounts[i] = r.uint();
  const shields: ShieldPoint[] = new Array(nShields);
  for (let i = 0; i < nShields; i++) {
    shields[i] = { time: times[i]!, amount: amounts[i]!, entity: r.uint() };
  }

  const nServices = r.count("service");
  const services: number[] = new Array(nServices);
  let e = 0;
  for (let i = 0; i < nServices; i++) services[i] = e += r.uint();

  const nExits = r.count("exit");
  const exitTimes: number[] = new Array(nExits);
  t = dataFrom;
  for (let i = 0; i < nExits; i++) exitTimes[i] = t += r.uint();
  const exits: ExitQuery[] = new Array(nExits);
  for (let i = 0; i < nExits; i++) exits[i] = { time: exitTimes[i]!, amount: r.uint() };

  if (!r.done) throw new SnapshotFormatError("trailing bytes after snapshot");
  const MAX_ZAT = 21_000_000 * 100_000_000;
  const inRange = (t: number): boolean => t >= dataFrom && t < dataTo;
  if (dataTo <= dataFrom) throw new SnapshotFormatError("snapshot covers no time");
  for (const s of shields) {
    if (!inRange(s.time) || s.amount > MAX_ZAT || s.entity > 0x7fffffff) {
      throw new SnapshotFormatError("snapshot holds a deposit outside its own range");
    }
  }
  for (const e of exits) {
    if (!inRange(e.time) || e.amount > MAX_ZAT) {
      throw new SnapshotFormatError("snapshot holds a withdrawal outside its own range");
    }
  }
  return { dataFrom, dataTo, shields, services, exits };
}
