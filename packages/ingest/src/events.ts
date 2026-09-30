import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_DERIVE_CONFIG,
  classifyTx,
  sourceImpliedKind,
  toEvent,
  type BoundaryEvent,
  type DeriveConfig,
  type EventTag,
  type TxContext,
} from "./derive.js";
import type { TxRecord } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  day          TEXT    NOT NULL,
  txid         TEXT    NOT NULL PRIMARY KEY,
  height       INTEGER NOT NULL,
  time         INTEGER NOT NULL,
  kind         TEXT    NOT NULL CHECK (kind IN ('SHIELD', 'DESHIELD')),
  amount       INTEGER NOT NULL CHECK (amount > 0),
  addresses    TEXT    NOT NULL,
  tags         TEXT    NOT NULL,
  version      INTEGER NOT NULL,
  input_count  INTEGER NOT NULL,
  output_count INTEGER NOT NULL,
  source_delta INTEGER
);
CREATE INDEX IF NOT EXISTS events_day ON events(day);
CREATE INDEX IF NOT EXISTS events_kind_time ON events(kind, time);

CREATE TABLE IF NOT EXISTS derive_days (
  day           TEXT    NOT NULL PRIMARY KEY,
  config        TEXT    NOT NULL,
  shields       INTEGER NOT NULL,
  deshields     INTEGER NOT NULL,
  transparent   INTEGER NOT NULL,
  shielded_only INTEGER NOT NULL,
  coinbase      INTEGER NOT NULL,
  incomplete    INTEGER NOT NULL,
  derived_at    INTEGER NOT NULL
);
`;

export interface DeriveResult {
  day: string;
  shields: number;
  deshields: number;
  transparent: number;
  shieldedOnly: number;
  coinbase: number;
  incomplete: number;
}

interface TxRow {
  hash: string;
  block_height: number;
  time: number;
  version: number;
  is_coinbase: number;
  input_count: number;
  output_count: number;
  input_total: number;
  output_total: number;
  fee: number;
  size: number;
  shielded_value_delta: number | null;
}

function toTxRecord(r: TxRow): TxRecord {
  return {
    hash: r.hash,
    blockHeight: r.block_height,
    time: r.time,
    version: r.version,
    isCoinbase: r.is_coinbase === 1,
    inputCount: r.input_count,
    outputCount: r.output_count,
    inputTotal: r.input_total,
    outputTotal: r.output_total,
    fee: r.fee,
    size: r.size,
    shieldedValueDelta: r.shielded_value_delta,
  };
}

interface MutableContext {
  inputAddresses: string[];
  spendsCoinbase: boolean;
  outputAddresses: string[];
  inputScriptBytes: number[];
  outputScriptBytes: number[];
}

function emptyContext(): MutableContext {
  return {
    inputAddresses: [],
    spendsCoinbase: false,
    outputAddresses: [],
    inputScriptBytes: [],
    outputScriptBytes: [],
  };
}

/** Derives boundary events from the raw tables into `events`, one day at a time. */
export class EventStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(SCHEMA);
  }

  /** Rebuild one day's events from the raw tables. Deterministic and idempotent. */
  deriveDay(day: string, config: DeriveConfig = DEFAULT_DERIVE_CONFIG): DeriveResult {
    const contexts = new Map<string, MutableContext>();
    const ctx = (hash: string): MutableContext => {
      let c = contexts.get(hash);
      if (!c) contexts.set(hash, (c = emptyContext()));
      return c;
    };
    const inputs = this.db
      .prepare(
        "SELECT spending_tx_hash, recipient, is_from_coinbase, script_bytes FROM raw_inputs WHERE day = ?",
      )
      .all(day) as {
      spending_tx_hash: string;
      recipient: string | null;
      is_from_coinbase: number;
      script_bytes: number;
    }[];
    for (const r of inputs) {
      const c = ctx(r.spending_tx_hash);
      c.inputScriptBytes.push(r.script_bytes);
      if (r.recipient) c.inputAddresses.push(r.recipient);
      if (r.is_from_coinbase === 1) c.spendsCoinbase = true;
    }
    const outputs = this.db
      .prepare("SELECT tx_hash, recipient, script_bytes FROM raw_outputs WHERE day = ?")
      .all(day) as { tx_hash: string; recipient: string | null; script_bytes: number }[];
    for (const r of outputs) {
      const c = ctx(r.tx_hash);
      c.outputScriptBytes.push(r.script_bytes);
      if (r.recipient) c.outputAddresses.push(r.recipient);
    }

    const result: DeriveResult = {
      day,
      shields: 0,
      deshields: 0,
      transparent: 0,
      shieldedOnly: 0,
      coinbase: 0,
      incomplete: 0,
    };
    const txs = this.db
      .prepare("SELECT * FROM raw_transactions WHERE day = ? ORDER BY hash")
      .all(day) as unknown as TxRow[];
    const insert = this.db.prepare("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM events WHERE day = ?").run(day);
      for (const row of txs) {
        const tx = toTxRecord(row);
        const context: TxContext = contexts.get(tx.hash) ?? emptyContext();
        const c = classifyTx(tx, context, config);
        switch (c.kind) {
          case "SHIELD":
          case "DESHIELD": {
            const e: BoundaryEvent = toEvent(tx, context, c, config);
            insert.run(
              day,
              e.txid,
              e.height,
              e.time,
              e.kind,
              e.amount,
              JSON.stringify(e.addresses),
              e.tags.join(","),
              e.version,
              e.inputCount,
              e.outputCount,
              e.sourceShieldedDelta,
            );
            if (c.kind === "SHIELD") result.shields++;
            else result.deshields++;
            break;
          }
          case "TRANSPARENT":
            result.transparent++;
            break;
          case "SHIELDED_ONLY":
            result.shieldedOnly++;
            break;
          case "COINBASE":
            result.coinbase++;
            break;
          case "INCOMPLETE":
            result.incomplete++;
            break;
        }
      }
      this.db
        .prepare("INSERT OR REPLACE INTO derive_days VALUES (?,?,?,?,?,?,?,?,?)")
        .run(
          day,
          JSON.stringify(config),
          result.shields,
          result.deshields,
          result.transparent,
          result.shieldedOnly,
          result.coinbase,
          result.incomplete,
          Math.floor(Date.now() / 1000),
        );
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return result;
  }

  /** All derived events on the given days, oldest first, with addresses and tags parsed. */
  load(days: readonly string[]): StoredEvent[] {
    const rows = this.db
      .prepare(
        `SELECT txid, time, kind, amount, addresses, tags FROM events
         WHERE day IN (${days.map(() => "?").join(",")}) ORDER BY time, txid`,
      )
      .all(...days) as {
      txid: string;
      time: number;
      kind: "SHIELD" | "DESHIELD";
      amount: number;
      addresses: string;
      tags: string;
    }[];
    return rows.map((r) => ({
      txid: r.txid,
      time: r.time,
      kind: r.kind,
      amount: r.amount,
      addresses: JSON.parse(r.addresses) as string[],
      tags: r.tags === "" ? [] : (r.tags.split(",") as EventTag[]),
    }));
  }

  /** Aggregate report over a set of days (PRD S2 acceptance). */
  summary(days: readonly string[]): EventSummary {
    const inDays = `day IN (${days.map(() => "?").join(",")})`;
    const perDay = this.db
      .prepare(
        `SELECT day,
                SUM(kind = 'SHIELD') AS shields,
                SUM(kind = 'DESHIELD') AS deshields,
                SUM(kind = 'SHIELD' AND tags LIKE '%coinbase%') AS coinbase_shields,
                SUM(kind = 'DESHIELD' AND tags LIKE '%batch%') AS batch_deshields,
                SUM(CASE WHEN kind = 'SHIELD' THEN amount ELSE 0 END) AS shield_zat,
                SUM(CASE WHEN kind = 'DESHIELD' THEN amount ELSE 0 END) AS deshield_zat
         FROM events WHERE ${inDays} GROUP BY day ORDER BY day`,
      )
      .all(...days) as unknown as DaySummary[];

    const events = this.db
      .prepare(`SELECT kind, version, source_delta FROM events WHERE ${inDays}`)
      .all(...days) as {
      kind: "SHIELD" | "DESHIELD";
      version: number;
      source_delta: number | null;
    }[];
    const source: SourceComparison = { agree: 0, missed: 0, opposite: 0, missedByVersion: {} };
    for (const e of events) {
      const implied = sourceImpliedKind(e.source_delta);
      if (implied === e.kind) source.agree++;
      else if (implied === null) {
        source.missed++;
        source.missedByVersion[e.version] = (source.missedByVersion[e.version] ?? 0) + 1;
      } else source.opposite++;
    }
    const extra = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM raw_transactions t
         WHERE t.${inDays} AND t.is_coinbase = 0 AND t.shielded_value_delta <> 0
           AND NOT EXISTS (SELECT 1 FROM events e WHERE e.txid = t.hash)`,
      )
      .get(...days) as { n: number };
    source.sourceOnly = extra.n;

    const totals = this.db
      .prepare(
        `SELECT SUM(transparent) AS transparent, SUM(shielded_only) AS shielded_only,
                SUM(coinbase) AS coinbase, SUM(incomplete) AS incomplete
         FROM derive_days WHERE ${inDays}`,
      )
      .get(...days) as {
      transparent: number;
      shielded_only: number;
      coinbase: number;
      incomplete: number;
    };
    return { perDay, source, nonEvents: totals };
  }
}

export interface DaySummary {
  day: string;
  shields: number;
  deshields: number;
  coinbase_shields: number;
  batch_deshields: number;
  shield_zat: number;
  deshield_zat: number;
}

export interface SourceComparison {
  /** Our event and the source's shielded delta imply the same direction. */
  agree: number;
  /** We found a crossing; the source's delta says nothing moved. */
  missed: number;
  /** The source's delta implies the opposite direction. */
  opposite: number;
  missedByVersion: Record<number, number>;
  /** The source reports shielded movement on a tx we did not classify as a crossing. */
  sourceOnly?: number;
}

export interface EventSummary {
  perDay: DaySummary[];
  source: SourceComparison;
  nonEvents: { transparent: number; shielded_only: number; coinbase: number; incomplete: number };
}

export interface StoredEvent {
  txid: string;
  time: number;
  kind: "SHIELD" | "DESHIELD";
  amount: number;
  addresses: string[];
  tags: EventTag[];
}
