import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { DataSource, TableName, TableRecord } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS raw_transactions (
  day                  TEXT    NOT NULL,
  hash                 TEXT    NOT NULL PRIMARY KEY,
  block_height         INTEGER NOT NULL,
  time                 INTEGER NOT NULL,
  version              INTEGER NOT NULL,
  is_coinbase          INTEGER NOT NULL,
  input_count          INTEGER NOT NULL,
  output_count         INTEGER NOT NULL,
  input_total          INTEGER NOT NULL,
  output_total         INTEGER NOT NULL,
  fee                  INTEGER NOT NULL,
  shielded_value_delta INTEGER
);
CREATE INDEX IF NOT EXISTS raw_transactions_day ON raw_transactions(day);

CREATE TABLE IF NOT EXISTS raw_inputs (
  day              TEXT    NOT NULL,
  spending_tx_hash TEXT    NOT NULL,
  spending_index   INTEGER NOT NULL,
  recipient        TEXT,
  value            INTEGER NOT NULL,
  is_from_coinbase INTEGER NOT NULL,
  PRIMARY KEY (spending_tx_hash, spending_index)
);
CREATE INDEX IF NOT EXISTS raw_inputs_day ON raw_inputs(day);

CREATE TABLE IF NOT EXISTS raw_outputs (
  day              TEXT    NOT NULL,
  tx_hash          TEXT    NOT NULL,
  idx              INTEGER NOT NULL,
  recipient        TEXT,
  value            INTEGER NOT NULL,
  is_from_coinbase INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, idx)
);
CREATE INDEX IF NOT EXISTS raw_outputs_day ON raw_outputs(day);

CREATE TABLE IF NOT EXISTS ingest_days (
  source      TEXT    NOT NULL,
  tbl         TEXT    NOT NULL,
  day         TEXT    NOT NULL,
  fingerprint TEXT    NOT NULL,
  rows        INTEGER NOT NULL,
  duplicates  INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL,
  PRIMARY KEY (tbl, day)
);
`;

const RAW_TABLE: { [K in TableName]: string } = {
  transactions: "raw_transactions",
  inputs: "raw_inputs",
  outputs: "raw_outputs",
};

const INSERT_SQL: { [K in TableName]: string } = {
  transactions: `INSERT INTO raw_transactions VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
  inputs: `INSERT INTO raw_inputs VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
  outputs: `INSERT INTO raw_outputs VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
};

/** Looks up the stored row with the same primary key; PK columns are positions 1..n of the row. */
const SELECT_BY_KEY: { [K in TableName]: { sql: string; keyColumns: number } } = {
  transactions: { sql: `SELECT * FROM raw_transactions WHERE hash = ?`, keyColumns: 1 },
  inputs: {
    sql: `SELECT * FROM raw_inputs WHERE spending_tx_hash = ? AND spending_index = ?`,
    keyColumns: 2,
  },
  outputs: { sql: `SELECT * FROM raw_outputs WHERE tx_hash = ? AND idx = ?`, keyColumns: 2 },
};

type SqlValue = string | number | null;

const TO_ROW: { [K in TableName]: (day: string, r: TableRecord[K]) => SqlValue[] } = {
  transactions: (day, r) => [
    day,
    r.hash,
    r.blockHeight,
    r.time,
    r.version,
    r.isCoinbase ? 1 : 0,
    r.inputCount,
    r.outputCount,
    r.inputTotal,
    r.outputTotal,
    r.fee,
    r.shieldedValueDelta,
  ],
  inputs: (day, r) => [
    day,
    r.spendingTxHash,
    r.spendingIndex,
    r.recipient,
    r.value,
    r.isFromCoinbase ? 1 : 0,
  ],
  outputs: (day, r) => [day, r.txHash, r.index, r.recipient, r.value, r.isFromCoinbase ? 1 : 0],
};

export const TABLES: readonly TableName[] = ["transactions", "inputs", "outputs"];

export interface IngestResult {
  table: TableName;
  day: string;
  rows: number;
  /**
   * Exact duplicate lines dropped. Blockchair's outputs dumps repeat some lines verbatim (786 of
   * 9,602 on 2026-07-01; dedup'd outputs sum exactly to each tx's output_total).
   */
  duplicates: number;
  /** True when the stored data already matched the source fingerprint and nothing was written. */
  skipped: boolean;
}

export class ConflictingRowError extends Error {
  constructor(table: TableName, key: SqlValue[]) {
    super(`${table}: two different rows share the key ${JSON.stringify(key)}`);
    this.name = "ConflictingRowError";
  }
}

export interface DayCounts {
  day: string;
  transactions: number;
  inputs: number;
  outputs: number;
}

/** SQLite store for raw chain data. Each (table, day) is replaced atomically, so re-runs are safe. */
export class RawStore {
  readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Ingest one table for one day. Skips if already stored with the same fingerprint (unless force). */
  async ingestTable(
    source: DataSource,
    table: TableName,
    day: string,
    force = false,
  ): Promise<IngestResult> {
    const dayTable = await source.open(table, day);
    const existing = this.db
      .prepare("SELECT fingerprint, rows, duplicates FROM ingest_days WHERE tbl = ? AND day = ?")
      .get(table, day) as { fingerprint: string; rows: number; duplicates: number } | undefined;
    if (!force && existing?.fingerprint === dayTable.fingerprint) {
      return { table, day, rows: existing.rows, duplicates: existing.duplicates, skipped: true };
    }

    const insert = this.statement(INSERT_SQL[table]);
    const { sql, keyColumns } = SELECT_BY_KEY[table];
    const selectByKey = this.statement(sql);
    const toRow = TO_ROW[table] as (day: string, r: TableRecord[typeof table]) => SqlValue[];
    let rows = 0;
    let duplicates = 0;
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`DELETE FROM ${RAW_TABLE[table]} WHERE day = ?`).run(day);
      for await (const record of dayTable.records) {
        const values = toRow(day, record);
        if (insert.run(...values).changes === 1) {
          rows++;
          continue;
        }
        // Primary key already present: accept only a verbatim repeat of the same row.
        const key = values.slice(1, 1 + keyColumns);
        const stored = Object.values(selectByKey.get(...key) ?? {});
        if (stored.length !== values.length || stored.some((v, i) => v !== values[i])) {
          throw new ConflictingRowError(table, key);
        }
        duplicates++;
      }
      this.db
        .prepare(
          `INSERT OR REPLACE INTO ingest_days
             (source, tbl, day, fingerprint, rows, duplicates, ingested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          source.name,
          table,
          day,
          dayTable.fingerprint,
          rows,
          duplicates,
          Math.floor(Date.now() / 1000),
        );
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { table, day, rows, duplicates, skipped: false };
  }

  /** Ingest all tables for one day. */
  async ingestDay(source: DataSource, day: string, force = false): Promise<IngestResult[]> {
    const results: IngestResult[] = [];
    for (const table of TABLES) {
      results.push(await this.ingestTable(source, table, day, force));
    }
    return results;
  }

  /** Actual row counts in the raw tables, per day. */
  dayCounts(days?: readonly string[]): DayCounts[] {
    const counts = new Map<string, DayCounts>();
    for (const table of TABLES) {
      const rows = this.db
        .prepare(`SELECT day, COUNT(*) AS n FROM ${RAW_TABLE[table]} GROUP BY day`)
        .all() as { day: string; n: number }[];
      for (const { day, n } of rows) {
        const entry = counts.get(day) ?? { day, transactions: 0, inputs: 0, outputs: 0 };
        entry[table] = n;
        counts.set(day, entry);
      }
    }
    const all = [...counts.values()].sort((a, b) => a.day.localeCompare(b.day));
    return days ? all.filter((c) => days.includes(c.day)) : all;
  }

  private statement(sql: string): StatementSync {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }
}
