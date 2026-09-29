/** A parsed TSV row keyed by header name. Blockchair writes SQL NULL as `\N`; we map it to null. */
export type TsvRow = Record<string, string | null>;

export class TsvFormatError extends Error {
  constructor(
    message: string,
    readonly lineNumber: number,
  ) {
    super(`line ${lineNumber}: ${message}`);
    this.name = "TsvFormatError";
  }
}

const NULL = "\\N";

/**
 * Parse tab-separated lines with a header row. Every data line must have exactly as many fields
 * as the header, and the header must contain every column in `required`.
 */
export async function* parseTsv(
  lines: AsyncIterable<string>,
  required: readonly string[],
): AsyncGenerator<TsvRow> {
  let header: string[] | undefined;
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber++;
    if (header === undefined) {
      header = line.split("\t");
      const missing = required.filter((col) => !header!.includes(col));
      if (missing.length > 0) {
        throw new TsvFormatError(`missing columns: ${missing.join(", ")}`, lineNumber);
      }
      continue;
    }
    if (line === "") {
      continue;
    }
    const fields = line.split("\t");
    if (fields.length !== header.length) {
      throw new TsvFormatError(
        `expected ${header.length} fields, got ${fields.length}`,
        lineNumber,
      );
    }
    const row: TsvRow = {};
    for (let i = 0; i < header.length; i++) {
      const value = fields[i]!;
      row[header[i]!] = value === NULL ? null : value;
    }
    yield row;
  }
  if (header === undefined) {
    throw new TsvFormatError("empty file (no header)", 0);
  }
}

const INT_PATTERN = /^-?\d+$/;

/** Strict integer field: must be present, a plain integer, and a safe JS integer. */
export function intField(row: TsvRow, column: string): number {
  const value = row[column];
  if (value === null || value === undefined || !INT_PATTERN.test(value)) {
    throw new RangeError(`column ${column}: expected integer, got ${JSON.stringify(value)}`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`column ${column}: integer out of safe range: ${value}`);
  }
  return n;
}

/** Integer field that may be null (`\N`). */
export function nullableIntField(row: TsvRow, column: string): number | null {
  return row[column] === null ? null : intField(row, column);
}

/**
 * A transparent total whose count column says how many items it sums. Blockchair writes `\N` for
 * the total exactly when the count is 0 (verified over 222,404 txs, Jul–Sep 2026); that is
 * normalized to 0. A null total with a non-zero count is a data error.
 */
export function totalField(row: TsvRow, totalColumn: string, countColumn: string): number {
  if (row[totalColumn] !== null) {
    return intField(row, totalColumn);
  }
  if (intField(row, countColumn) !== 0) {
    throw new RangeError(`column ${totalColumn}: null but ${countColumn} is non-zero`);
  }
  return 0;
}

/** Required string field. */
export function stringField(row: TsvRow, column: string): string {
  const value = row[column];
  if (value === null || value === undefined || value === "") {
    throw new RangeError(`column ${column}: expected a value`);
  }
  return value;
}

/** Boolean stored as 0/1. */
export function boolField(row: TsvRow, column: string): boolean {
  const n = intField(row, column);
  if (n !== 0 && n !== 1) {
    throw new RangeError(`column ${column}: expected 0 or 1, got ${n}`);
  }
  return n === 1;
}

const TIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** "2026-09-28 00:01:32" (UTC) -> unix seconds. */
export function timeField(row: TsvRow, column: string): number {
  const value = row[column];
  if (value === null || value === undefined || !TIME_PATTERN.test(value)) {
    throw new RangeError(`column ${column}: expected "YYYY-MM-DD HH:MM:SS", got ${value}`);
  }
  return Date.parse(`${value.replace(" ", "T")}Z`) / 1000;
}
