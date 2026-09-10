/**
 * The database connection: opening, executing, preparing, transactions,
 * user-defined functions and the backup API.
 *
 * Vendored from the Deno SQLite3 driver
 * (https://github.com/denodrivers/sqlite3), Copyright 2022 DjDeveloperr,
 * licensed under the Apache License, Version 2.0. MODIFIED by the
 * reactive-sqlite-ts authors: restyled to this project's conventions and
 * reduced to the surface this library uses.
 *
 * @module
 */
import { fromFileUrl } from "@std/path";
import ffi from "./ffi.ts";
import {
  SQLITE3_OPEN_CREATE,
  SQLITE3_OPEN_MEMORY,
  SQLITE3_OPEN_READONLY,
  SQLITE3_OPEN_READWRITE,
  SQLITE_BLOB,
  SQLITE_FLOAT,
  SQLITE_INTEGER,
  SQLITE_NULL,
  SQLITE_TEXT,
} from "./constants.ts";
import { readCstr, toCString, unwrap } from "./util.ts";
import { shaped } from "./shape.ts";
import {
  type RestBindParameters,
  Statement,
  STATEMENTS_TO_DB,
} from "./statement.ts";
import { type BlobOpenOptions, SQLBlob } from "./blob.ts";

/** How to open a connection. See {@linkcode Database}. */
export interface DatabaseOpenOptions {
  /** Open read-only. False by default. */
  readonly?: boolean;
  /** Create the file if it does not exist. True by default. */
  create?: boolean;
  /** Raw SQLite open flags. Specifying this ignores every other flag option. */
  flags?: number;
  /** Open an in-memory database. */
  memory?: boolean;
  /**
   * Return INTEGER columns as `bigint`. False by default, which means values
   * beyond 32 bits come back inaccurate.
   */
  int64?: boolean;
  /** Optimisations that are only safe without concurrent clients. */
  unsafeConcurrency?: boolean;
  /** Allow {@linkcode Database.loadExtension}. */
  enableLoadExtension?: boolean;
  /** Parse columns SQLite marks as JSON into JS values. True by default. */
  parseJson?: boolean;
}

/**
 * A function wrapped by {@linkcode Database.transaction}.
 *
 * The constraint is `never[]` rather than `unknown[]` so that a callback
 * taking concrete parameters still satisfies it; `Parameters<T>` then recovers
 * the real signature for the caller.
 */
export type Transaction<T extends (...args: never[]) => void> =
  & ((...args: Parameters<T>) => ReturnType<T>)
  & {
    /** BEGIN */
    default: Transaction<T>;
    /** BEGIN DEFERRED */
    deferred: Transaction<T>;
    /** BEGIN IMMEDIATE */
    immediate: Transaction<T>;
    /** BEGIN EXCLUSIVE */
    exclusive: Transaction<T>;
    database: Database;
  };

/**
 * Flags for a user-defined function.
 *
 * @see https://www.sqlite.org/c3ref/c_deterministic.html
 */
export interface FunctionOptions {
  /** Accept any number of arguments rather than the function's arity. */
  varargs?: boolean;
  deterministic?: boolean;
  directOnly?: boolean;
  innocuous?: boolean;
  subtype?: boolean;
}

/** A user-defined aggregate. See {@linkcode Database.aggregate}. */
export interface AggregateFunctionOptions extends FunctionOptions {
  /** The initial value, or a function called once per group to produce one. */
  start: unknown;
  /** Folds one row into the running value and returns the new one. */
  step: (aggregate: unknown, ...args: unknown[]) => unknown;
  /** Turns the final running value into the result. Identity by default. */
  final?: (aggregate: unknown) => unknown;
}

const {
  sqlite3_open_v2,
  sqlite3_close_v2,
  sqlite3_changes,
  sqlite3_get_autocommit,
  sqlite3_exec,
  sqlite3_free,
  sqlite3_libversion,
  sqlite3_finalize,
  sqlite3_result_blob,
  sqlite3_result_double,
  sqlite3_result_error,
  sqlite3_result_int64,
  sqlite3_result_null,
  sqlite3_result_text,
  sqlite3_value_blob,
  sqlite3_value_bytes,
  sqlite3_value_double,
  sqlite3_value_int64,
  sqlite3_value_text,
  sqlite3_value_type,
  sqlite3_create_function,
  sqlite3_result_int,
  sqlite3_aggregate_context,
  sqlite3_enable_load_extension,
  sqlite3_load_extension,
  sqlite3_backup_init,
  sqlite3_backup_step,
  sqlite3_backup_finish,
  sqlite3_errcode,
} = ffi;

/** The version string of the libsqlite3 this process opened. */
export const SQLITE_VERSION: string = ((): string => {
  const ptr = sqlite3_libversion();
  if (ptr === null) throw new Error("sqlite3_libversion() returned NULL");
  return readCstr(ptr);
})();

const BIG_MAX = BigInt(Number.MAX_SAFE_INTEGER);

/** Anything that can be closed, which is all a callback set needs to know. */
interface Closeable {
  close(): void;
}

/**
 * Reads the argument vector handed to a user-defined function.
 *
 * Shared by {@linkcode Database.function} and {@linkcode Database.aggregate},
 * which upstream carried as two identical copies.
 */
function readArgs(nArgs: number, pArgs: Deno.PointerValue): unknown[] {
  if (pArgs === null) {
    if (nArgs === 0) return [];
    throw new Error("SQLite passed a NULL argument vector");
  }
  const argptr = new Deno.UnsafePointerView(pArgs);
  const args: unknown[] = [];
  for (let i = 0; i < nArgs; i++) {
    const arg = Deno.UnsafePointer.create(argptr.getBigUint64(i * 8));
    const type = sqlite3_value_type(arg);
    switch (type) {
      case SQLITE_INTEGER: {
        const value = sqlite3_value_int64(arg);
        args.push(value < -BIG_MAX || value > BIG_MAX ? value : Number(value));
        break;
      }

      case SQLITE_FLOAT:
        args.push(sqlite3_value_double(arg));
        break;

      case SQLITE_TEXT: {
        const ptr = sqlite3_value_text(arg);
        if (ptr === null) throw new Error("sqlite3_value_text() returned NULL");
        args.push(
          new TextDecoder().decode(
            new Uint8Array(
              Deno.UnsafePointerView.getArrayBuffer(
                ptr,
                sqlite3_value_bytes(arg),
              ),
            ),
          ),
        );
        break;
      }

      case SQLITE_BLOB: {
        const ptr = sqlite3_value_blob(arg);
        if (ptr === null) throw new Error("sqlite3_value_blob() returned NULL");
        args.push(
          new Uint8Array(
            Deno.UnsafePointerView.getArrayBuffer(
              ptr,
              sqlite3_value_bytes(arg),
            ),
          ),
        );
        break;
      }

      case SQLITE_NULL:
        args.push(null);
        break;

      default:
        throw new Error(`Unknown type: ${type}`);
    }
  }
  return args;
}

/**
 * Hands a JS value back to SQLite as a function result.
 *
 * Shared by {@linkcode Database.function} and the aggregate's final callback,
 * which upstream carried as two identical copies.
 */
function setResult(ctx: Deno.PointerValue, result: unknown): void {
  if (result === undefined || result === null) {
    sqlite3_result_null(ctx);
  } else if (typeof result === "boolean") {
    sqlite3_result_int(ctx, result ? 1 : 0);
  } else if (typeof result === "number") {
    if (Number.isSafeInteger(result)) {
      sqlite3_result_int64(ctx, BigInt(result));
    } else sqlite3_result_double(ctx, result);
  } else if (typeof result === "bigint") {
    sqlite3_result_int64(ctx, result);
  } else if (typeof result === "string") {
    const buffer = new TextEncoder().encode(result);
    sqlite3_result_text(ctx, buffer, buffer.byteLength, 0n);
  } else if (result instanceof Uint8Array) {
    sqlite3_result_blob(ctx, result, result.length, -1n);
  } else {
    const buffer = new TextEncoder().encode(
      `Invalid return value: ${Deno.inspect(result)}`,
    );
    sqlite3_result_error(ctx, buffer, buffer.byteLength);
  }
}

/** Reports a thrown JS error to SQLite as the function's error result. */
function setError(ctx: Deno.PointerValue, err: unknown): void {
  const buf = new TextEncoder().encode(
    err instanceof Error ? err.message : String(err),
  );
  sqlite3_result_error(ctx, buf, buf.byteLength);
}

/**
 * Builds the `SQLITE_*` creation flags for a user-defined function.
 *
 * CARRIED UPSTREAM BEHAVIOUR: `innocuous` is declared in
 * {@linkcode FunctionOptions} but never reaches SQLite — upstream tests
 * `directOnly` twice, so `SQLITE_INNOCUOUS` (0x000200000) is unreachable.
 * Left as it was: this vendoring corrects two named defects and nothing else.
 */
function functionFlags(options: FunctionOptions | undefined): number {
  let flags = 1;
  if (options?.deterministic) flags |= 0x000000800;
  if (options?.directOnly) flags |= 0x000080000;
  if (options?.subtype) flags |= 0x000100000;
  if (options?.directOnly) flags |= 0x000200000;
  return flags;
}

/**
 * A SQLite database connection.
 *
 * ```ts
 * // From a file, created if it does not exist.
 * const db = new Database("myfile.db");
 *
 * // In memory.
 * const db = new Database(":memory:");
 *
 * // Read-only.
 * const db = new Database("myfile.db", { readonly: true });
 *
 * // From a file URL.
 * const db = new Database(new URL("./myfile.db", import.meta.url));
 * ```
 */
export class Database {
  #path: string;
  #handle: Deno.PointerValue;
  #open = true;
  #enableLoadExtension = false;
  #callbacks: Set<Closeable> = new Set();

  /** Return INTEGER columns as `bigint`. False by default. */
  int64: boolean;

  /** Parse columns SQLite marks as JSON into JS values. True by default. */
  parseJson: boolean;

  /** Optimisations that are only safe without concurrent clients. */
  unsafeConcurrency: boolean;

  /** Whether the connection is still open. */
  get open(): boolean {
    return this.#open;
  }

  /** The raw `sqlite3*`. */
  get unsafeHandle(): Deno.PointerValue {
    return this.#handle;
  }

  /** The path this connection was opened from. */
  get path(): string {
    return this.#path;
  }

  /** Rows changed by the last statement. */
  get changes(): number {
    this.#assertOpen();
    return sqlite3_changes(this.#handle);
  }

  /** Whether autocommit is on — off between BEGIN and COMMIT. */
  get autocommit(): boolean {
    this.#assertOpen();
    return sqlite3_get_autocommit(this.#handle) === 1;
  }

  /** Whether the connection is mid-transaction. */
  get inTransaction(): boolean {
    return this.#open && !this.autocommit;
  }

  /** Whether {@linkcode Database.loadExtension} is permitted. */
  get enableLoadExtension(): boolean {
    return this.#enableLoadExtension;
  }

  set enableLoadExtension(enabled: boolean) {
    this.#assertOpen();
    if (sqlite3_enable_load_extension === null) {
      throw new Error(
        "Extension loading is not supported by the shared library that was used.",
      );
    }
    const result = sqlite3_enable_load_extension(this.#handle, Number(enabled));
    unwrap(result, this.#handle);
    this.#enableLoadExtension = enabled;
  }

  /**
   * FIXED HERE, NOT UPSTREAM: refuses to touch a connection that has been
   * closed.
   *
   * Upstream `close()` frees the `sqlite3*` and leaves the object usable, so
   * the next call dereferences freed memory and the process dies of SIGSEGV
   * with no JavaScript error at all. Every method that reaches the handle
   * calls this first, and `close()` also nulls the handle, so a path missed
   * here reaches SQLite as NULL rather than as a dangling pointer. See
   * DRIVER_DEFECTS.md.
   */
  #assertOpen(): void {
    if (!this.#open) {
      throw new Error("Database connection is closed");
    }
  }

  constructor(path: string | URL, options: DatabaseOpenOptions = {}) {
    this.#path = path instanceof URL ? fromFileUrl(path) : path;
    let flags = 0;
    this.int64 = options.int64 ?? false;
    this.parseJson = options.parseJson ?? true;
    this.unsafeConcurrency = options.unsafeConcurrency ?? false;
    if (options.flags !== undefined) {
      flags = options.flags;
    } else {
      if (options.memory) flags |= SQLITE3_OPEN_MEMORY;

      if (options.readonly ?? false) {
        flags |= SQLITE3_OPEN_READONLY;
      } else {
        flags |= SQLITE3_OPEN_READWRITE;
      }

      if ((options.create ?? true) && !options.readonly) {
        flags |= SQLITE3_OPEN_CREATE;
      }
    }

    const pHandle = new BigUint64Array(1);
    const result = sqlite3_open_v2(toCString(this.#path), pHandle, flags, null);
    this.#handle = Deno.UnsafePointer.create(pHandle[0] ?? 0n);
    if (result !== 0) sqlite3_close_v2(this.#handle);
    unwrap(result);

    if (options.enableLoadExtension) {
      this.enableLoadExtension = options.enableLoadExtension;
    }
  }

  /**
   * Prepares a statement.
   *
   * ```ts
   * const stmt = db.prepare("SELECT * FROM mytable WHERE id = ?");
   * for (const row of stmt.all(1)) console.log(row);
   * ```
   *
   * Bind parameters go in either positionally or by name:
   *
   * ```ts
   * db.prepare("SELECT * FROM mytable WHERE id = ?").get(1);
   * db.prepare("SELECT * FROM mytable WHERE id = :id").get({ id: 1 });
   * ```
   *
   * Statements are finalized when the GC collects them; `finalize` does it
   * sooner.
   */
  prepare<T extends object = Record<string, unknown>>(
    sql: string,
  ): Statement<T> {
    this.#assertOpen();
    return new Statement<T>(this, sql);
  }

  /**
   * Opens a BLOB for incremental I/O.
   *
   * Close it when done, or it leaks.
   */
  openBlob(options: BlobOpenOptions): SQLBlob {
    this.#assertOpen();
    return new SQLBlob(this, options);
  }

  /**
   * Executes SQL — several statements separated by semicolons is fine — and
   * returns the number of rows the last one changed.
   *
   * ```ts
   * db.exec("create table users (id integer not null, username varchar(20) not null)");
   * db.exec("insert into users (id, username) values(?, ?)", id, username);
   * db.exec("insert into users (id, username) values(:id, :username)", { id, username });
   * db.exec("pragma journal_mode = WAL");
   * ```
   *
   * With no bind parameters this goes through `sqlite3_exec`; with them,
   * through a prepared statement.
   */
  exec(sql: string, ...params: RestBindParameters): number {
    this.#assertOpen();
    if (params.length === 0) {
      const pErr = new BigUint64Array(1);
      sqlite3_exec(
        this.#handle,
        toCString(sql),
        null,
        null,
        new Uint8Array(pErr.buffer),
      );
      const errPtr = Deno.UnsafePointer.create(pErr[0] ?? 0n);
      if (errPtr !== null) {
        const err = readCstr(errPtr);
        sqlite3_free(errPtr);
        throw new Error(err);
      }
      return sqlite3_changes(this.#handle);
    }

    const stmt = this.prepare(sql);
    stmt.run(...params);
    return sqlite3_changes(this.#handle);
  }

  /** Alias for {@linkcode Database.exec}. */
  run(sql: string, ...params: RestBindParameters): number {
    return this.exec(sql, ...params);
  }

  /** Runs SQL from a tagged template, binding each interpolation. */
  sql<T extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...parameters: RestBindParameters
  ): T[] {
    const sql = strings.join("?");
    const stmt = this.prepare<T>(sql);
    return stmt.all(...parameters);
  }

  /**
   * Wraps a callback in a transaction: BEGIN on entry, COMMIT on return,
   * ROLLBACK if it throws.
   *
   * ```ts
   * const stmt = db.prepare("insert into users (id, username) values(?, ?)");
   *
   * interface User {
   *   id: number;
   *   username: string;
   * }
   *
   * const insertUsers = db.transaction((data: User[]) => {
   *   for (const user of data) stmt.run(user);
   * });
   *
   * insertUsers([
   *   { id: 1, username: "alice" },
   *   { id: 2, username: "bob" },
   * ]);
   * ```
   *
   * `insertUsers.deferred`, `.immediate` and `.exclusive` are the same
   * function opening with BEGIN DEFERRED, BEGIN IMMEDIATE and BEGIN EXCLUSIVE.
   * Nested calls use SAVEPOINT rather than a second BEGIN.
   */
  transaction<T extends (this: Transaction<T>, ...args: never[]) => void>(
    fn: T,
  ): Transaction<T> {
    this.#assertOpen();
    // Based on https://github.com/WiseLibs/better-sqlite3/blob/master/lib/methods/transaction.js
    const controller = getController(this);

    // Each version of the transaction function has these same properties.
    const properties = {
      default: { value: wrapTransaction(fn, this, controller.default) },
      deferred: { value: wrapTransaction(fn, this, controller.deferred) },
      immediate: { value: wrapTransaction(fn, this, controller.immediate) },
      exclusive: { value: wrapTransaction(fn, this, controller.exclusive) },
      database: { value: this, enumerable: true },
    };

    Object.defineProperties(properties.default.value, properties);
    Object.defineProperties(properties.deferred.value, properties);
    Object.defineProperties(properties.immediate.value, properties);
    Object.defineProperties(properties.exclusive.value, properties);

    // The default version is the one returned; the rest hang off it.
    return shaped<Transaction<T>>(properties.default.value);
  }

  /**
   * Registers a scalar function callable from SQL.
   *
   * ```ts
   * db.function("add", (a: number, b: number) => a + b);
   * db.prepare("select add(1, 2)").value<[number]>(); // [3]
   * ```
   */
  function(
    name: string,
    fn: CallableFunction,
    options?: FunctionOptions,
  ): void {
    this.#assertOpen();
    if (sqlite3_create_function === null) {
      throw new Error(
        "User-defined functions are not supported by the shared library that was used.",
      );
    }

    const cb = new Deno.UnsafeCallback(
      {
        parameters: ["pointer", "i32", "pointer"],
        result: "void",
      } as const,
      (ctx, nArgs, pArgs) => {
        let result: unknown;
        try {
          result = fn(...readArgs(nArgs, pArgs));
        } catch (err) {
          setError(ctx, err);
          return;
        }
        setResult(ctx, result);
      },
    );

    const err = sqlite3_create_function(
      this.#handle,
      toCString(name),
      options?.varargs ? -1 : fn.length,
      functionFlags(options),
      null,
      cb.pointer,
      null,
      null,
    );

    unwrap(err, this.#handle);

    this.#callbacks.add(cb);
  }

  /**
   * Registers an aggregate function callable from SQL.
   *
   * `start` seeds one running value per group, `step` folds each row into it,
   * and `final` turns the last value into the result.
   */
  aggregate(name: string, options: AggregateFunctionOptions): void {
    this.#assertOpen();
    const aggregateContext = sqlite3_aggregate_context;
    if (aggregateContext === null || sqlite3_create_function === null) {
      throw new Error(
        "User-defined functions are not supported by the shared library that was used.",
      );
    }

    // Keyed by the address SQLite hands back for this group's scratch space.
    const contexts = new Map<number | bigint, unknown>();

    const cb = new Deno.UnsafeCallback(
      {
        parameters: ["pointer", "i32", "pointer"],
        result: "void",
      } as const,
      (ctx, nArgs, pArgs) => {
        const aggrPtr = Deno.UnsafePointer.value(aggregateContext(ctx, 8));
        let aggregate;
        if (contexts.has(aggrPtr)) {
          aggregate = contexts.get(aggrPtr);
        } else {
          aggregate = typeof options.start === "function"
            ? options.start()
            : options.start;
          contexts.set(aggrPtr, aggregate);
        }

        let result: unknown;
        try {
          result = options.step(aggregate, ...readArgs(nArgs, pArgs));
        } catch (err) {
          setError(ctx, err);
          return;
        }

        contexts.set(aggrPtr, result);
      },
    );

    const cbFinal = new Deno.UnsafeCallback(
      {
        parameters: ["pointer"],
        result: "void",
      } as const,
      (ctx) => {
        const aggrPtr = Deno.UnsafePointer.value(aggregateContext(ctx, 0));
        const aggregate = contexts.get(aggrPtr);
        contexts.delete(aggrPtr);
        let result: unknown;
        try {
          result = options.final ? options.final(aggregate) : aggregate;
        } catch (err) {
          setError(ctx, err);
          return;
        }
        setResult(ctx, result);
      },
    );

    const err = sqlite3_create_function(
      this.#handle,
      toCString(name),
      options?.varargs ? -1 : options.step.length - 1,
      functionFlags(options),
      null,
      null,
      cb.pointer,
      cbFinal.pointer,
    );

    unwrap(err, this.#handle);

    this.#callbacks.add(cb);
    this.#callbacks.add(cbFinal);
  }

  /** Loads an SQLite extension library from a file. */
  loadExtension(file: string, entryPoint?: string): void {
    this.#assertOpen();
    if (sqlite3_load_extension === null) {
      throw new Error(
        "Extension loading is not supported by the shared library that was used.",
      );
    }

    if (!this.enableLoadExtension) {
      throw new Error("Extension loading is not enabled");
    }

    const pzErrMsg = new BigUint64Array(1);

    const result = sqlite3_load_extension(
      this.#handle,
      toCString(file),
      entryPoint ? toCString(entryPoint) : null,
      pzErrMsg,
    );

    const pzErrPtr = Deno.UnsafePointer.create(pzErrMsg[0] ?? 0n);
    if (pzErrPtr !== null) {
      const pzErr = readCstr(pzErrPtr);
      sqlite3_free(pzErrPtr);
      throw new Error(pzErr);
    }

    unwrap(result, this.#handle);
  }

  /** Closes the connection. Calling it again is a no-op. */
  close(): void {
    if (!this.#open) return;
    for (const [stmt, db] of STATEMENTS_TO_DB) {
      if (db === this.#handle) {
        sqlite3_finalize(stmt);
        STATEMENTS_TO_DB.delete(stmt);
      }
    }
    for (const cb of this.#callbacks) {
      cb.close();
    }
    unwrap(sqlite3_close_v2(this.#handle));
    this.#open = false;
    this.#handle = null;
  }

  /**
   * Copies this database into another connection.
   *
   * @param dest The destination connection.
   * @param name The destination schema: "main", "temp", or the name an ATTACH
   * gave it.
   * @param pages How many pages to copy. Negative copies all of them.
   */
  backup(dest: Database, name = "main", pages = -1): void {
    this.#assertOpen();
    dest.#assertOpen();
    const backup = sqlite3_backup_init(
      dest.#handle,
      toCString(name),
      this.#handle,
      toCString("main"),
    );
    if (backup) {
      unwrap(sqlite3_backup_step(backup, pages));
      unwrap(sqlite3_backup_finish(backup));
    } else {
      unwrap(sqlite3_errcode(dest.#handle), dest.#handle);
    }
  }

  [Symbol.for("Deno.customInspect")](): string {
    return `SQLite3.Database { path: ${this.path} }`;
  }
}

/** The prepared statements one transaction variant opens and closes with. */
interface TransactionSteps {
  begin: Statement;
  commit: Statement;
  rollback: Statement;
  savepoint: Statement;
  release: Statement;
  rollbackTo: Statement;
}

/** One set of {@linkcode TransactionSteps} per BEGIN variant. */
interface TransactionController {
  default: TransactionSteps;
  deferred: TransactionSteps;
  immediate: TransactionSteps;
  exclusive: TransactionSteps;
}

const controllers = new WeakMap<Database, TransactionController>();

/** The connection's cached transaction statements, prepared on first use. */
function getController(db: Database): TransactionController {
  const cached = controllers.get(db);
  if (cached !== undefined) return cached;

  const shared = {
    commit: db.prepare("COMMIT"),
    rollback: db.prepare("ROLLBACK"),
    savepoint: db.prepare("SAVEPOINT `\t_bs3.\t`"),
    release: db.prepare("RELEASE `\t_bs3.\t`"),
    rollbackTo: db.prepare("ROLLBACK TO `\t_bs3.\t`"),
  };

  const controller: TransactionController = {
    default: { begin: db.prepare("BEGIN"), ...shared },
    deferred: { begin: db.prepare("BEGIN DEFERRED"), ...shared },
    immediate: { begin: db.prepare("BEGIN IMMEDIATE"), ...shared },
    exclusive: { begin: db.prepare("BEGIN EXCLUSIVE"), ...shared },
  };
  controllers.set(db, controller);
  return controller;
}

/**
 * Wraps `fn` so that it runs inside a transaction.
 *
 * Already inside one, it takes a SAVEPOINT instead, so nesting works.
 */
function wrapTransaction<T extends (...args: never[]) => void>(
  fn: T,
  db: Database,
  { begin, commit, rollback, savepoint, release, rollbackTo }: TransactionSteps,
): (...args: Parameters<T>) => ReturnType<T> {
  return function sqliteTransaction(
    this: unknown,
    ...args: Parameters<T>
  ): ReturnType<T> {
    let before, after, undo;
    if (db.inTransaction) {
      before = savepoint;
      after = release;
      undo = rollbackTo;
    } else {
      before = begin;
      after = commit;
      undo = rollback;
    }
    before.run();
    try {
      const result = shaped<ReturnType<T>>(Reflect.apply(fn, this, args));
      after.run();
      return result;
    } catch (ex) {
      if (!db.autocommit) {
        undo.run();
        if (undo !== rollback) after.run();
      }
      throw ex;
    }
  };
}
