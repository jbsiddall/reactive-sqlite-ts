/**
 * Prepared statements: binding, stepping, and reading rows back out.
 *
 * Vendored from the Deno SQLite3 driver
 * (https://github.com/denodrivers/sqlite3), Copyright 2022 DjDeveloperr,
 * licensed under the Apache License, Version 2.0. MODIFIED by the
 * reactive-sqlite-ts authors: restyled to this project's conventions and
 * reduced to the surface this library uses — the nine `sqlite3_stmt_status`
 * counters, the per-statement `int64`/`parseJson` toggles, and the
 * `bindParameterName`/`bindParameterCount`/`readonly` accessors are gone,
 * because nothing in this project or its published API reaches them.
 *
 * @module
 */
import type { Database } from "./database.ts";
import { readCstr, toCString, unwrap } from "./util.ts";
import { shaped } from "./shape.ts";
import ffi from "./ffi.ts";
import {
  SQLITE3_DONE,
  SQLITE3_ROW,
  SQLITE_BLOB,
  SQLITE_FLOAT,
  SQLITE_INTEGER,
  SQLITE_TEXT,
} from "./constants.ts";

const {
  sqlite3_prepare_v2,
  sqlite3_reset,
  sqlite3_clear_bindings,
  sqlite3_step,
  sqlite3_column_count,
  sqlite3_column_type,
  sqlite3_column_value,
  sqlite3_value_subtype,
  sqlite3_column_text,
  sqlite3_finalize,
  sqlite3_column_int64,
  sqlite3_column_double,
  sqlite3_column_blob,
  sqlite3_column_bytes,
  sqlite3_column_name,
  sqlite3_expanded_sql,
  sqlite3_bind_parameter_count,
  sqlite3_bind_int,
  sqlite3_bind_int64,
  sqlite3_bind_text,
  sqlite3_bind_blob,
  sqlite3_bind_double,
  sqlite3_bind_parameter_index,
  sqlite3_sql,
  sqlite3_changes,
  sqlite3_column_int,
} = ffi;

/** A JavaScript value the driver knows how to bind. */
export type BindValue =
  | number
  | string
  | symbol
  | bigint
  | boolean
  | null
  | undefined
  | Date
  | Uint8Array
  | BindValue[]
  | { [key: string]: BindValue };

/** Positional or named parameters for one execution. */
export type BindParameters = BindValue[] | Record<string, BindValue>;

/** What the `...args` of `run`/`get`/`all`/`values`/`value` accept. */
export type RestBindParameters = BindValue[] | [BindParameters];

/**
 * Every live `sqlite3_stmt*` and the connection it belongs to.
 *
 * It is what makes closing a Database able to finalize the statements still
 * open on it, and what tells `finalize()` whether this statement is already
 * gone.
 */
export const STATEMENTS_TO_DB: Map<Deno.PointerValue, Deno.PointerValue> =
  new Map();

/**
 * Bound in place of a zero-length buffer.
 *
 * Deno's FFI passes an empty `Uint8Array` as a NULL pointer, and
 * `sqlite3_bind_text` given NULL binds SQL NULL rather than an empty string.
 * Binding one byte and declaring a length of zero says empty without saying
 * absent.
 */
const emptyStringBuffer = new Uint8Array(1);

const statementFinalizer = new FinalizationRegistry(
  (ptr: Deno.PointerValue) => {
    if (STATEMENTS_TO_DB.has(ptr)) {
      sqlite3_finalize(ptr);
      STATEMENTS_TO_DB.delete(ptr);
    }
  },
);

/**
 * The subtype SQLite's JSON functions stamp on a TEXT result.
 *
 * @see https://github.com/sqlite/sqlite/blob/195611d8e6fc0bba559a49e91e6ceb42e4bdd6ba/src/json.c#L125-L126
 */
const JSON_SUBTYPE = 74;

const BIG_MAX = BigInt(Number.MAX_SAFE_INTEGER);

/** Reads column `i` of the current row as a JavaScript value. */
function getColumn(
  handle: Deno.PointerValue,
  i: number,
  int64: boolean,
  parseJson: boolean,
): unknown {
  const ty = sqlite3_column_type(handle, i);

  if (ty === SQLITE_INTEGER && !int64) return sqlite3_column_int(handle, i);

  switch (ty) {
    case SQLITE_TEXT: {
      const ptr = sqlite3_column_text(handle, i);
      if (ptr === null) return null;
      const text = readCstr(ptr, 0);
      const value = sqlite3_column_value(handle, i);
      if (sqlite3_value_subtype(value) === JSON_SUBTYPE && parseJson) {
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }
      return text;
    }

    case SQLITE_INTEGER: {
      const val = sqlite3_column_int64(handle, i);
      return val < -BIG_MAX || val > BIG_MAX ? val : Number(val);
    }

    case SQLITE_FLOAT:
      return sqlite3_column_double(handle, i);

    case SQLITE_BLOB: {
      const ptr = sqlite3_column_blob(handle, i);
      if (ptr === null) return new Uint8Array();
      const bytes = sqlite3_column_bytes(handle, i);
      return new Uint8Array(
        Deno.UnsafePointerView.getArrayBuffer(ptr, bytes).slice(0),
      );
    }

    default:
      return null;
  }
}

/** Reads one row. `handle` must be sitting on a row. */
type RowReader = (
  handle: Deno.PointerValue,
  int64: boolean,
  parseJson: boolean,
) => unknown;

/**
 * A reader producing one array per row.
 *
 * Upstream generated this with `new Function`, unrolling the per-column calls
 * for a column list that is constant for the life of a statement. It is a
 * plain loop here: the package then contains no `eval`, which is what lets it
 * run under a CSP or `--deny-eval`, and closing over the count keeps the
 * per-row work the same shape.
 */
function arrayReader(columnCount: number): RowReader {
  return (handle, int64, parseJson) => {
    const row = new Array<unknown>(columnCount);
    for (let i = 0; i < columnCount; i++) {
      row[i] = getColumn(handle, i, int64, parseJson);
    }
    return row;
  };
}

/** A reader producing one column-name object per row. */
function objectReader(columnNames: readonly string[]): RowReader {
  return (handle, int64, parseJson) => {
    const row: Record<string, unknown> = {};
    for (let i = 0; i < columnNames.length; i++) {
      row[columnNames[i] ?? ""] = getColumn(handle, i, int64, parseJson);
    }
    return row;
  };
}

/**
 * A prepared statement. See {@linkcode Database.prepare}.
 *
 * The no-argument forms of `run`/`get`/`all`/`values`/`value` are installed as
 * OWN properties in the constructor when the statement takes no parameters,
 * shadowing the prototype methods. `src/hooks.ts` patches around that: it is
 * not an implementation detail it can ignore.
 */
export class Statement<TStatement extends object = Record<string, unknown>> {
  #handle: Deno.PointerValue;
  #finalizerToken: { handle: Deno.PointerValue };
  #bound = false;
  #hasNoArgs = false;
  #unsafeConcurrency: boolean;
  #bindParameterCount: number;
  #bindRefs: Set<unknown> = new Set();
  #rowReader: RowReader | undefined;
  #columnNames: string[] | undefined;
  #rowObject: Record<string, unknown> = {};

  /** Per-statement override of the connection's `int64` setting. */
  int64?: boolean;
  /** Per-statement override of the connection's `parseJson` setting. */
  parseJson?: boolean;

  constructor(public db: Database, sql: string) {
    const pHandle = new BigUint64Array(1);
    const cString = toCString(sql);
    unwrap(
      sqlite3_prepare_v2(
        db.unsafeHandle,
        cString,
        cString.byteLength,
        pHandle,
        null,
      ),
      db.unsafeHandle,
    );
    this.#handle = Deno.UnsafePointer.create(pHandle[0] ?? 0n);
    STATEMENTS_TO_DB.set(this.#handle, db.unsafeHandle);
    this.#unsafeConcurrency = db.unsafeConcurrency;
    this.#finalizerToken = { handle: this.#handle };
    statementFinalizer.register(this, this.#handle, this.#finalizerToken);

    this.#bindParameterCount = sqlite3_bind_parameter_count(this.#handle);
    if (this.#bindParameterCount === 0) {
      this.#hasNoArgs = true;
      this.all = this.#allNoArgs;
      this.values = this.#valuesNoArgs;
      this.run = this.#runNoArgs;
      this.value = this.#valueNoArgs;
      this.get = this.#getNoArgs;
    }
  }

  /** The raw `sqlite3_stmt*`. */
  get unsafeHandle(): Deno.PointerValue {
    return this.#handle;
  }

  /** The SQL this statement was prepared from. */
  get sql(): string {
    const ptr = sqlite3_sql(this.#handle);
    return ptr === null ? "" : readCstr(ptr);
  }

  /** The SQL with the current bindings substituted in. */
  get expandedSql(): string {
    const ptr = sqlite3_expanded_sql(this.#handle);
    return ptr === null ? "" : readCstr(ptr);
  }

  /** The index of a named parameter, or 0 when there is no such parameter. */
  bindParameterIndex(name: string): number {
    const prefixed = name[0] !== ":" && name[0] !== "@" && name[0] !== "$"
      ? ":" + name
      : name;
    return sqlite3_bind_parameter_index(this.#handle, toCString(prefixed));
  }

  /** Runs the statement, discarding any rows. Returns `db.changes`. */
  run(...args: RestBindParameters): number {
    return this.#runWithArgs(...args);
  }

  /** Runs the statement and returns every row as an array of columns. */
  values<T extends unknown[] = unknown[]>(...args: RestBindParameters): T[] {
    return this.#valuesWithArgs(...args);
  }

  /** Runs the statement and returns every row as a column-name object. */
  all<T extends object = TStatement>(...args: RestBindParameters): T[] {
    return this.#allWithArgs(...args);
  }

  /**
   * Binds parameters once, for every later execution.
   *
   * An optimisation, and a one-way door: a bound statement cannot be rebound.
   */
  bind(...params: RestBindParameters): this {
    this.#bindAll(params);
    this.#bound = true;
    return this;
  }

  #begin(): void {
    sqlite3_reset(this.#handle);
    if (!this.#bound && !this.#hasNoArgs) {
      sqlite3_clear_bindings(this.#handle);
      this.#bindRefs.clear();
    }
  }

  #bind(i: number, param: BindValue): void {
    switch (typeof param) {
      case "number": {
        if (Number.isInteger(param)) {
          if (
            Number.isSafeInteger(param) && param >= -(2 ** 31) &&
            param < 2 ** 31
          ) {
            // FIXED HERE, NOT UPSTREAM: `-0` is an integer and is in range, so
            // it reaches sqlite3_bind_int, and Deno's FFI rejects it with
            // "Invalid FFI i32 type, expected integer". SQLite stores 0 for it
            // either way, so normalise. See DRIVER_DEFECTS.md.
            unwrap(
              sqlite3_bind_int(
                this.#handle,
                i + 1,
                Object.is(param, -0) ? 0 : param,
              ),
            );
          } else {
            unwrap(sqlite3_bind_int64(this.#handle, i + 1, BigInt(param)));
          }
        } else {
          unwrap(sqlite3_bind_double(this.#handle, i + 1, param));
        }
        break;
      }
      case "string": {
        if (param === "") {
          unwrap(
            sqlite3_bind_text(this.#handle, i + 1, emptyStringBuffer, 0, null),
          );
        } else {
          const str = new TextEncoder().encode(param);
          this.#bindRefs.add(str);
          unwrap(
            sqlite3_bind_text(this.#handle, i + 1, str, str.byteLength, null),
          );
        }
        break;
      }
      case "object": {
        if (param === null) break;
        if (param instanceof Uint8Array) {
          this.#bindRefs.add(param);
          unwrap(
            sqlite3_bind_blob(
              this.#handle,
              i + 1,
              param.byteLength === 0 ? emptyStringBuffer : param,
              param.byteLength,
              null,
            ),
          );
          break;
        }
        const text = param instanceof Date
          ? param.toISOString()
          : JSON.stringify(param);
        const cstring = toCString(text);
        this.#bindRefs.add(cstring);
        unwrap(sqlite3_bind_text(this.#handle, i + 1, cstring, -1, null));
        break;
      }
      case "bigint":
        unwrap(sqlite3_bind_int64(this.#handle, i + 1, param));
        break;
      case "boolean":
        unwrap(sqlite3_bind_int(this.#handle, i + 1, param ? 1 : 0));
        break;
      case "undefined":
        break;
      default:
        throw new Error(`Value of unsupported type: ${Deno.inspect(param)}`);
    }
  }

  #bindAll(params: RestBindParameters | BindParameters): void {
    if (this.#bound) throw new Error("Statement already bound to values");
    const first = Array.isArray(params) ? params[0] : undefined;
    const unwrapped: BindParameters =
      typeof first === "object" && first !== null &&
        !(first instanceof Uint8Array) && !(first instanceof Date)
        ? first
        : params;
    if (Array.isArray(unwrapped)) {
      for (let i = 0; i < unwrapped.length; i++) {
        this.#bind(i, unwrapped[i]);
      }
      return;
    }
    for (const [name, param] of Object.entries(unwrapped)) {
      const i = this.bindParameterIndex(name);
      if (i === 0) throw new Error(`No such parameter "${name}"`);
      this.#bind(i - 1, param);
    }
  }

  #runNoArgs(): number {
    const handle = this.#handle;
    this.#begin();
    const status = sqlite3_step(handle);
    if (status !== SQLITE3_ROW && status !== SQLITE3_DONE) {
      unwrap(status, this.db.unsafeHandle);
    }
    sqlite3_reset(handle);
    return sqlite3_changes(this.db.unsafeHandle);
  }

  #runWithArgs(...params: RestBindParameters): number {
    const handle = this.#handle;
    this.#begin();
    this.#bindAll(params);
    const status = sqlite3_step(handle);
    if (!this.#hasNoArgs && !this.#bound && params.length) {
      this.#bindRefs.clear();
    }
    if (status !== SQLITE3_ROW && status !== SQLITE3_DONE) {
      unwrap(status, this.db.unsafeHandle);
    }
    sqlite3_reset(handle);
    return sqlite3_changes(this.db.unsafeHandle);
  }

  /**
   * Steps to exhaustion, collecting rows.
   *
   * Returns the terminating status rather than throwing on it, because the
   * callers must release their bound-value references BEFORE the error
   * surfaces — dropping that ordering would leak a reference on every failed
   * statement.
   */
  #stepAll<T>(reader: RowReader): { rows: T[]; status: number } {
    const handle = this.#handle;
    const int64 = this.int64 ?? this.db.int64;
    const parseJson = this.parseJson ?? this.db.parseJson;
    const rows: T[] = [];
    let status = sqlite3_step(handle);
    while (status === SQLITE3_ROW) {
      rows.push(shaped<T>(reader(handle, int64, parseJson)));
      status = sqlite3_step(handle);
    }
    return { rows, status };
  }

  #valuesNoArgs<T extends unknown[]>(): T[] {
    this.#begin();
    const reader = arrayReader(sqlite3_column_count(this.#handle));
    const { rows, status } = this.#stepAll<T>(reader);
    if (status !== SQLITE3_DONE) unwrap(status, this.db.unsafeHandle);
    sqlite3_reset(this.#handle);
    return rows;
  }

  #valuesWithArgs<T extends unknown[]>(...params: RestBindParameters): T[] {
    this.#begin();
    this.#bindAll(params);
    const reader = arrayReader(sqlite3_column_count(this.#handle));
    const { rows, status } = this.#stepAll<T>(reader);
    if (!this.#hasNoArgs && !this.#bound && params.length) {
      this.#bindRefs.clear();
    }
    if (status !== SQLITE3_DONE) unwrap(status, this.db.unsafeHandle);
    sqlite3_reset(this.#handle);
    return rows;
  }

  /**
   * The compiled object reader for this statement's columns.
   *
   * Recompiled every call unless `unsafeConcurrency` is on, because another
   * connection may have changed the schema under a statement that then
   * re-prepared itself with a different column list.
   */
  getRowObject(): RowReader {
    const cached = this.#rowReader;
    if (cached !== undefined && this.#unsafeConcurrency) return cached;
    const reader = objectReader(this.columnNames());
    this.#rowReader = reader;
    return reader;
  }

  #allNoArgs<T extends object>(): T[] {
    this.#begin();
    const reader = this.getRowObject();
    const { rows, status } = this.#stepAll<T>(reader);
    if (status !== SQLITE3_DONE) unwrap(status, this.db.unsafeHandle);
    sqlite3_reset(this.#handle);
    return rows;
  }

  #allWithArgs<T extends object>(...params: RestBindParameters): T[] {
    this.#begin();
    this.#bindAll(params);
    const reader = this.getRowObject();
    const { rows, status } = this.#stepAll<T>(reader);
    if (!this.#hasNoArgs && !this.#bound && params.length) {
      this.#bindRefs.clear();
    }
    if (status !== SQLITE3_DONE) unwrap(status, this.db.unsafeHandle);
    sqlite3_reset(this.#handle);
    return rows;
  }

  /** The first row as an array of columns, if there is one. */
  value<T extends unknown[]>(...params: RestBindParameters): T | undefined {
    const handle = this.#handle;
    const int64 = this.int64 ?? this.db.int64;
    const parseJson = this.parseJson ?? this.db.parseJson;
    const arr = new Array<unknown>(sqlite3_column_count(handle));
    sqlite3_reset(handle);
    if (!this.#hasNoArgs && !this.#bound) {
      sqlite3_clear_bindings(handle);
      this.#bindRefs.clear();
      if (params.length) this.#bindAll(params);
    }

    const status = sqlite3_step(handle);

    if (!this.#hasNoArgs && !this.#bound && params.length) {
      this.#bindRefs.clear();
    }

    if (status === SQLITE3_ROW) {
      for (let i = 0; i < arr.length; i++) {
        arr[i] = getColumn(handle, i, int64, parseJson);
      }
      sqlite3_reset(handle);
      return shaped<T>(arr);
    }
    if (status === SQLITE3_DONE) return undefined;
    unwrap(status, this.db.unsafeHandle);
    return undefined;
  }

  #valueNoArgs<T extends unknown[]>(): T | undefined {
    const handle = this.#handle;
    const int64 = this.int64 ?? this.db.int64;
    const parseJson = this.parseJson ?? this.db.parseJson;
    const cc = sqlite3_column_count(handle);
    const arr = new Array<unknown>(cc);
    sqlite3_reset(handle);
    const status = sqlite3_step(handle);
    if (status === SQLITE3_ROW) {
      for (let i = 0; i < cc; i++) {
        arr[i] = getColumn(handle, i, int64, parseJson);
      }
      sqlite3_reset(handle);
      return shaped<T>(arr);
    }
    if (status === SQLITE3_DONE) return undefined;
    unwrap(status, this.db.unsafeHandle);
    return undefined;
  }

  /** The column names of the result set, in order. */
  columnNames(): string[] {
    const cached = this.#columnNames;
    if (cached !== undefined && this.#unsafeConcurrency) return cached;
    const columnCount = sqlite3_column_count(this.#handle);
    const columnNames: string[] = [];
    for (let i = 0; i < columnCount; i++) {
      const ptr = sqlite3_column_name(this.#handle, i);
      columnNames.push(ptr === null ? "" : readCstr(ptr));
    }
    this.#columnNames = columnNames;
    this.#rowObject = {};
    for (const name of columnNames) this.#rowObject[name] = undefined;
    return columnNames;
  }

  /** The first row as a column-name object, if there is one. */
  get<T extends object = TStatement>(
    ...params: RestBindParameters
  ): T | undefined {
    const handle = this.#handle;
    const int64 = this.int64 ?? this.db.int64;
    const parseJson = this.parseJson ?? this.db.parseJson;
    const columnNames = this.columnNames();

    const row: Record<string, unknown> = {};
    sqlite3_reset(handle);
    if (!this.#hasNoArgs && !this.#bound) {
      sqlite3_clear_bindings(handle);
      this.#bindRefs.clear();
      if (params.length) this.#bindAll(params);
    }

    const status = sqlite3_step(handle);

    if (!this.#hasNoArgs && !this.#bound && params.length) {
      this.#bindRefs.clear();
    }

    if (status === SQLITE3_ROW) {
      for (let i = 0; i < columnNames.length; i++) {
        row[columnNames[i] ?? ""] = getColumn(handle, i, int64, parseJson);
      }
      sqlite3_reset(handle);
      return shaped<T>(row);
    }
    if (status === SQLITE3_DONE) return undefined;
    unwrap(status, this.db.unsafeHandle);
    return undefined;
  }

  #getNoArgs<T extends object>(): T | undefined {
    const handle = this.#handle;
    const int64 = this.int64 ?? this.db.int64;
    const parseJson = this.parseJson ?? this.db.parseJson;
    const columnNames = this.columnNames();
    const row: Record<string, unknown> = this.#rowObject;
    sqlite3_reset(handle);
    const status = sqlite3_step(handle);
    if (status === SQLITE3_ROW) {
      for (let i = 0; i < columnNames.length; i++) {
        row[columnNames[i] ?? ""] = getColumn(handle, i, int64, parseJson);
      }
      sqlite3_reset(handle);
      return shaped<T>(row);
    }
    if (status === SQLITE3_DONE) return undefined;
    unwrap(status, this.db.unsafeHandle);
    return undefined;
  }

  /**
   * Releases the statement.
   *
   * CARRIED DEFECT, OURS SINCE VENDORING: `sqlite3_finalize` returns the last
   * error the statement produced while running, not an error from finalizing,
   * and this passes that code through `unwrap`. A statement whose last use
   * failed therefore throws from its own cleanup. See DRIVER_DEFECTS.md.
   */
  finalize(): void {
    if (!STATEMENTS_TO_DB.has(this.#handle)) return;
    this.#bindRefs.clear();
    statementFinalizer.unregister(this.#finalizerToken);
    STATEMENTS_TO_DB.delete(this.#handle);
    unwrap(sqlite3_finalize(this.#handle));
  }

  /** The statement as a string is its expanded SQL. */
  toString(): string {
    return this.expandedSql;
  }

  /** Steps the statement, yielding one column-name object per row. */
  *iter(...params: RestBindParameters): IterableIterator<unknown> {
    this.#begin();
    this.#bindAll(params);
    const reader = this.getRowObject();
    const int64 = this.int64 ?? this.db.int64;
    const parseJson = this.parseJson ?? this.db.parseJson;
    let status = sqlite3_step(this.#handle);
    while (status === SQLITE3_ROW) {
      yield reader(this.#handle, int64, parseJson);
      status = sqlite3_step(this.#handle);
    }
    if (status !== SQLITE3_DONE) unwrap(status, this.db.unsafeHandle);
    sqlite3_reset(this.#handle);
  }

  [Symbol.iterator](): IterableIterator<unknown> {
    return this.iter();
  }

  [Symbol.dispose](): void {
    this.finalize();
  }

  [Symbol.for("Deno.customInspect")](): string {
    return `Statement { ${this.expandedSql} }`;
  }
}
