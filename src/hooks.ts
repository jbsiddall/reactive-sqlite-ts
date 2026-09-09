/**
 * Row and commit-lifecycle events for a `@db/sqlite` {@linkcode Database}, over
 * Deno FFI, plus a JavaScript veto on the values a statement is about to write.
 *
 * ## Usage
 *
 * ```ts
 * // The driver picks its library at import time, so set this FIRST.
 * Deno.env.set("DENO_SQLITE_PATH", "/usr/lib/x86_64-linux-gnu/libsqlite3.so.0");
 * const { Database } = await import("jsr:@db/sqlite@0.13");
 * const { withEvents } = await import("./hooks.ts"); // or "../mod.ts"
 *
 * const db = new Database("app.db");
 * const sub = withEvents(db, (e) => {
 *   if (e.type === "postcommit") console.log(e.changes);
 * }, Deno.env.get("DENO_SQLITE_PATH")!);
 *
 * db.exec("INSERT INTO t VALUES (1)"); // -> change, precommit, postcommit
 * sub.dispose(); // or just db.close(), which disposes for you
 * ```
 *
 * Run with `--unstable-ffi --allow-ffi` (plus whatever the driver needs).
 * See the repository README for the full contract and its limits.
 *
 * ## How it works
 *
 * Registers sqlite3_update_hook / commit_hook / rollback_hook — and
 * sqlite3_preupdate_hook where the library has it — on the connection's own
 * `sqlite3*` ({@linkcode Database.unsafeHandle}), so you keep the driver's full
 * prepare/bind/step API and get events on that same connection.
 *
 * ## preupdate, and why it is optional
 *
 * sqlite3_preupdate_hook is a COMPILE-TIME option
 * (SQLITE_ENABLE_PREUPDATE_HOOK). It is the only hook that carries the actual
 * column values, and the only one that can see an incremental blob write, but
 * plenty of builds omit it. Its symbols are therefore dlopen'd separately: when
 * they are missing the module degrades to update_hook alone and says so in
 * {@linkcode Capabilities}, rather than failing to attach or promising events
 * that cannot arrive.
 *
 * The `sqlite3_value*` pointers it hands out die when the callback returns, so
 * every value is decoded into a plain JS value (blobs copied, text decoded by
 * byte length) before the event is dispatched. Keeping a pointer instead would
 * be a use-after-free; keeping the event is safe.
 *
 * ## Vetoing a write
 *
 * Neither preupdate_hook nor update_hook can refuse a row — both are `void` by
 * C definition. The commit hook can, so {@linkcode withValidation} remembers a
 * verdict from the row events and spends it at the next COMMIT, which becomes a
 * ROLLBACK. Read its doc comment: inside an explicit transaction that discards
 * the whole transaction, not just the offending row.
 *
 * SQLite has no post-commit hook. We synthesise one: commit_hook stashes the
 * batch, and because the connection is synchronous and single-threaded, the
 * commit has definitely landed by the time the SQL call that triggered it
 * returns to JS. So we drain the stash in a `finally` around the driver's own
 * methods. A commit that fails after the hook fires rollback_hook first, which
 * clears the stash, so a failed commit never emits `postcommit`.
 *
 * ## Why the library path is required
 *
 * The dlopen'd library MUST be the same file @db/sqlite loaded. If it is not,
 * we hand a `sqlite3*` allocated by one SQLite build to a different build and
 * the process dies of SIGSEGV with no message — verified, not theorised.
 *
 * By default @db/sqlite does not use a system SQLite at all: it downloads its
 * own prebuilt library from its GitHub releases into $DENO_DIR/plug/ under a
 * hashed filename. So callers MUST set DENO_SQLITE_PATH before importing the
 * driver and pass that same path here. `libPath` is deliberately required and
 * has no fallback, because a guessed default is exactly how you get the crash.
 *
 * ## Why the guards exist
 *
 * Everything reachable from this module runs against a raw pointer, so the
 * failure mode for a mistake is a silent SIGSEGV rather than an exception. The
 * rules below are enforced with thrown {@linkcode SqliteHooksError}s; each one
 * stands for a crash or a corruption that was reproduced first.
 *
 * - A listener must not touch the connection from `change`, `precommit` or
 *   `rollback`. SQLite documents that its hooks must not use the connection
 *   that invoked them ("sqlite3_prepare_v2() and sqlite3_step() both modify
 *   their database connections"). `postcommit` runs outside the hook and is
 *   unrestricted.
 * - A listener must not call `dispose()` or `db.close()`. Closing an
 *   `Deno.UnsafeCallback` while it is on the stack segfaults (exit 139,
 *   reproduced).
 * - An exception must never cross the FFI boundary: it abandons SQLite
 *   mid-statement and leaves the connection stuck inside a transaction.
 *   Listener errors are captured and re-thrown from JS instead.
 * - An empty batch does NOT mean nothing changed: sqlite3_update_hook reports
 *   neither DDL nor incremental blob writes (`openBlob().writeSync()`, verified
 *   — the commit hook fires, the update hook does not). Hence
 *   {@linkcode BatchCoverage}: branch on it rather than on `changes.length`.
 * - `db.close()` is intercepted so the hooks and callbacks are torn down while
 *   the connection is still alive, and so using the Database afterwards throws
 *   instead of dereferencing a freed `sqlite3*` (the driver itself does not
 *   check).
 */
import type { Database } from "@db/sqlite";

/** One row touched by a statement, as reported by sqlite3_update_hook. */
export type Change = {
  /**
   * SQLite documents only INSERT, UPDATE and DELETE, but the union is open at
   * the edge on purpose: an opcode we do not recognise arrives as `"unknown"`
   * rather than being dropped, because losing a change is the failure this
   * module exists to prevent. {@linkcode Change.opcode} carries what arrived.
   */
  op: "insert" | "update" | "delete" | "unknown";
  /** The opcode as SQLite gave it, undecoded. 18, 23 and 9 for the three above. */
  opcode: number;
  /** Schema name — "main", "temp", or an ATTACHed alias. */
  db: string;
  table: string;
  rowid: bigint;
};

/**
 * The opcode-to-`op` mapping the hooks apply, exposed because a consumer that
 * receives `"unknown"` sees the raw {@linkcode Change.opcode} and may want to
 * classify it the same way. Total: every number maps, none is rejected.
 */
export function opFor(opcode: number): Change["op"] {
  return OPS[opcode] ?? "unknown";
}

/**
 * One column value, decoded from a `sqlite3_value*` while it was still valid.
 *
 * The mapping is deliberately total and lossless:
 *
 * | SQLite type | here                                                   |
 * | ----------- | ------------------------------------------------------ |
 * | NULL        | `null`                                                 |
 * | INTEGER     | `bigint` — **always**, whatever the magnitude          |
 * | REAL        | `number`                                               |
 * | TEXT        | `string` — UTF-8 by byte length, so embedded NULs live |
 * | BLOB        | `Uint8Array` — a copy, never a view of SQLite's memory |
 *
 * INTEGER is a bigint even for small values, matching {@linkcode Change.rowid}.
 * The alternative — number under 2^53, bigint above — makes a column's JS type
 * depend on its data, so code written against a test fixture breaks the first
 * time a real id gets large. One rule, no cliff. `Number(v)` where you want a
 * number.
 */
export type RowValue = null | bigint | number | string | Uint8Array;

/**
 * A row's values, keyed by column name.
 *
 * Keys are the positional index as a string (`"0"`, `"1"`, …) in the one case
 * where the column names could not be resolved — see
 * {@linkcode PreUpdate.named}.
 */
export type Row = Readonly<Record<string, RowValue>>;

/**
 * One row, reported by sqlite3_preupdate_hook *before* it changes, with the
 * actual column values on both sides.
 *
 * Available only when {@linkcode Capabilities.preupdate} is true.
 *
 * All values are decoded eagerly, inside the callback, because the underlying
 * `sqlite3_value*` pointers are invalidated the moment it returns. Nothing in
 * this event aliases SQLite's memory, so retaining it is safe — that is the
 * whole reason the decode is eager.
 */
export type PreUpdate = {
  /** As SQLite reports it. An incremental blob write arrives as `"delete"`. */
  op: Change["op"];
  /** The opcode as SQLite gave it, undecoded. See {@linkcode Change.opcode}. */
  opcode: number;
  /** Schema name — "main", "temp", or an ATTACHed alias. */
  db: string;
  table: string;
  /**
   * `iKey1`: the rowid before the statement. Equal to `newRowid` except on an
   * UPDATE that moves the row. 0 for a WITHOUT ROWID table (verified: SQLite
   * reports both keys as 0 there).
   */
  oldRowid: bigint;
  /** `iKey2`: the rowid after the statement. */
  newRowid: bigint;
  /** True on the UPDATE that moves a row to a different rowid. */
  rowidChanged: boolean;
  /** Column names, in `cid` order, or `[]` when they could not be resolved. */
  columns: readonly string[];
  /** False when {@linkcode PreUpdate.columns} is empty and the rows are keyed by index. */
  named: boolean;
  /** Values before the statement; `null` on an INSERT, which has no old row. */
  old: Row | null;
  /** Values after the statement; `null` on a DELETE, which has no new row. */
  new: Row | null;
  /** The same values positionally, in `cid` order. `null` where the row is. */
  oldValues: readonly RowValue[] | null;
  newValues: readonly RowValue[] | null;
  /**
   * The column index an incremental blob write is targeting, or `null` for an
   * ordinary statement. Such a write is reported by SQLite as a DELETE of the
   * row (`old` holds the row as it is *now*, `new` is null) and is invisible
   * to sqlite3_update_hook entirely.
   */
  blobWriteColumn: number | null;
  /** 0 for a direct statement; deeper for rows written by triggers or FK actions. */
  depth: number;
};

/**
 * How much of what the transaction did is actually in `changes`.
 *
 * `changes` is never authoritative on its own, which is why this is a required
 * field rather than an optional `truncated` flag: an empty array is genuinely
 * ambiguous, and a consumer that reads it as "nothing happened" will serve
 * stale data. Switch on this instead.
 */
export type BatchCoverage =
  /** Every row the transaction touched is in `changes`. */
  | "complete"
  /** More rows changed than `maxChangesPerTransaction` retained. */
  | "truncated"
  /**
   * No row was observed at all — which does NOT mean nothing changed.
   * sqlite3_update_hook does not report DDL (writes to sqlite_schema) and does
   * not report incremental blob writes (`db.openBlob(...).writeSync()`),
   * verified: such a commit arrives here with an empty batch. Treat this as
   * "something may have changed, refresh everything".
   */
  | "unknown";

/** The rows of one transaction. */
export type Batch = {
  /**
   * The retained rows. Trustworthy only when
   * {@linkcode Batch.coverage} is `"complete"`.
   */
  changes: readonly Change[];
  /** Rows observed in the transaction, whether or not they were retained. */
  changeCount: number;
  coverage: BatchCoverage;
};

export type DbEvent =
  /**
   * Per row, mid-statement, BEFORE the row changes, carrying its old and new
   * column values. Cannot veto by itself — see {@linkcode withValidation} —
   * and must not touch the connection. Only ever delivered when
   * {@linkcode Capabilities.preupdate} is true.
   */
  | ({ type: "preupdate" } & PreUpdate)
  /** Per row, mid-transaction. Cannot veto. Must not touch the connection. */
  | { type: "change"; change: Change }
  /**
   * Before the commit finalises. Return false (or throw) to turn it into a
   * ROLLBACK. Must not touch the connection.
   */
  | ({ type: "precommit" } & Batch)
  /** After the commit has definitely landed. May use the connection freely. */
  | ({ type: "postcommit" } & Batch)
  /**
   * A transaction was discarded — explicit ROLLBACK, a failed statement, your
   * own veto, or a close with a transaction still open. Must not touch the
   * connection.
   */
  | ({ type: "rollback" } & Batch);

export type Listener = (e: DbEvent) => unknown;

export type EventOptions = {
  /**
   * Rows retained per transaction before the batch is reported as
   * `coverage: "truncated"`.
   * Bounds the memory a single huge transaction can pin. Default 100_000.
   */
  maxChangesPerTransaction?: number;
  /**
   * Where errors thrown by listeners go. Called once per error, from JS, after
   * the SQL call that produced it has returned. Without it the errors are
   * thrown instead (an AggregateError when more than one is pending).
   */
  onListenerError?: (error: unknown, event: DbEvent) => void;
  /**
   * What to do about sqlite3_preupdate_hook, which is a COMPILE-TIME option
   * (`SQLITE_ENABLE_PREUPDATE_HOOK`) and is absent from many builds — including
   * some macOS system libraries and, at the time of writing, @db/sqlite's own
   * downloaded prebuilt.
   *
   * - `"auto"` (default) — use it when the library exports it, and carry on
   *   without it when it does not. Read {@linkcode Subscription.capabilities}
   *   to find out which happened; `preupdate` events simply never arrive in the
   *   second case.
   * - `"required"` — throw a {@linkcode SqliteHooksError} at attach time rather
   *   than let a caller believe validation is running when it is not.
   * - `"off"` — do not even look for it. Also how the fallback path is tested.
   */
  preupdate?: "auto" | "required" | "off";
};

/** What the loaded libsqlite3 can actually do. */
export type Capabilities = {
  /** update_hook / commit_hook / rollback_hook. Always true: nothing works without them. */
  readonly hooks: true;
  /** sqlite3_preupdate_hook and friends: old/new row values, and blob-write visibility. */
  readonly preupdate: boolean;
  /** Why `preupdate` is false — a dlopen error, or the `preupdate: "off"` option. */
  readonly preupdateUnavailable?: string;
};

/** A single listener's registration. `dispose()` is idempotent. */
export type Subscription = {
  dispose: () => void;
  readonly disposed: boolean;
  /** What the connection's library supports. Shared by every listener on it. */
  readonly capabilities: Capabilities;
};

/** Every failure this module raises deliberately. */
export class SqliteHooksError extends Error {
  override readonly name = "SqliteHooksError";
}

const OPS: Record<number, "insert" | "update" | "delete"> = {
  18: "insert",
  9: "delete",
  23: "update",
};
const readC = (p: Deno.PointerValue) =>
  p === null ? "" : new Deno.UnsafePointerView(p).getCString();

const SYMBOLS = {
  sqlite3_update_hook: {
    parameters: ["pointer", "function", "pointer"],
    result: "pointer",
  },
  sqlite3_commit_hook: {
    parameters: ["pointer", "function", "pointer"],
    result: "pointer",
  },
  sqlite3_rollback_hook: {
    parameters: ["pointer", "function", "pointer"],
    result: "pointer",
  },
  sqlite3_libversion: { parameters: [], result: "pointer" },
} as const;

/**
 * The optional half. Every one of these is compiled out unless the library was
 * built with SQLITE_ENABLE_PREUPDATE_HOOK, so they are dlopen'd separately and
 * their absence is a capability, not an error.
 *
 * The preupdate callback takes an extra `sqlite3*` that update_hook's does not
 * — a real signature difference, not a copy-paste slip.
 */
const PREUPDATE_SYMBOLS = {
  sqlite3_preupdate_hook: {
    parameters: ["pointer", "function", "pointer"],
    result: "pointer",
  },
  /** (db, column, out sqlite3_value**) -> rc; non-zero on the wrong side of the op. */
  sqlite3_preupdate_old: {
    parameters: ["pointer", "i32", "pointer"],
    result: "i32",
  },
  sqlite3_preupdate_new: {
    parameters: ["pointer", "i32", "pointer"],
    result: "i32",
  },
  sqlite3_preupdate_count: { parameters: ["pointer"], result: "i32" },
  sqlite3_preupdate_depth: { parameters: ["pointer"], result: "i32" },
  /** The column index of an incremental blob write, or -1. */
  sqlite3_preupdate_blobwrite: { parameters: ["pointer"], result: "i32" },
  sqlite3_value_type: { parameters: ["pointer"], result: "i32" },
  sqlite3_value_int64: { parameters: ["pointer"], result: "i64" },
  sqlite3_value_double: { parameters: ["pointer"], result: "f64" },
  sqlite3_value_text: { parameters: ["pointer"], result: "pointer" },
  sqlite3_value_blob: { parameters: ["pointer"], result: "pointer" },
  sqlite3_value_bytes: { parameters: ["pointer"], result: "i32" },
} as const;

type CoreLib = Deno.DynamicLibrary<typeof SYMBOLS>;
type PreSymbols = Deno.DynamicLibrary<typeof PREUPDATE_SYMBOLS>["symbols"];

/** SQLITE_NULL etc., as returned by sqlite3_value_type. */
const VALUE_INTEGER = 1, VALUE_FLOAT = 2, VALUE_TEXT = 3, VALUE_BLOB = 4;

/** Methods that can drive a commit and return synchronously. `iter` is deliberately excluded. */
const DB_METHODS = ["exec", "run"] as const;
const STMT_METHODS = ["run", "get", "all", "values", "value"] as const;
/**
 * An incremental blob write commits without ever reaching update_hook, so the
 * blob API is instrumented purely so the resulting (empty, `coverage:
 * "unknown"`) commit event is drained promptly rather than at the next
 * unrelated call.
 */
const BLOB_METHODS = ["writeSync", "readSync", "close"] as const;
/** Properties `Database#transaction` hangs off the function it returns. */
const TX_VARIANTS = ["default", "deferred", "immediate", "exclusive"] as const;

const DEFAULT_MAX_CHANGES = 100_000;

type Registration = {
  libPath: string;
  lib: CoreLib;
  /** The preupdate API, when this library has it. */
  pre: PreSymbols | null;
  capabilities: Capabilities;
  handle: Deno.PointerValue;
  listeners: Set<Listener>;
  options: EventOptions;
  /** Inside one of the three FFI callbacks: the connection is off limits. */
  inHook: boolean;
  /** Inside any listener call: dispose()/close() are off limits. */
  inListener: boolean;
  /** The driver's close() has run; the sqlite3* is freed. */
  closed: boolean;
  /** All listeners gone: FFI torn down and the driver's methods restored. */
  detached: boolean;
  teardown: () => void;
  detach: () => void;
  flush: () => void;
  drain: () => void;
};

/**
 * One registration per Database. SQLite keeps a single hook of each kind per
 * connection, so a second `withEvents` must join the existing registration
 * rather than install its own and silently clobber the first.
 */
const REGISTRATIONS = new WeakMap<Database, Registration>();

function isDatabase(db: unknown): db is Database {
  if (db === null || typeof db !== "object") return false;
  return typeof Reflect.get(db, "prepare") === "function" &&
    typeof Reflect.get(db, "exec") === "function" &&
    typeof Reflect.get(db, "close") === "function" &&
    typeof Reflect.get(db, "transaction") === "function" &&
    "unsafeHandle" in db && "open" in db;
}

type OpenedLibrary = {
  lib: CoreLib;
  /** Null when the library has no preupdate API, or the caller turned it off. */
  pre: PreSymbols | null;
  capabilities: Capabilities;
};

/**
 * dlopen the library, taking the preupdate API if it is there.
 *
 * Two attempts, not one: a single dlopen of both symbol sets fails wholesale on
 * a library built without SQLITE_ENABLE_PREUPDATE_HOOK, which would turn a
 * missing *optional* feature into "your libsqlite3 is unusable".
 */
function openLibrary(
  libPath: string,
  want: NonNullable<EventOptions["preupdate"]>,
): OpenedLibrary {
  if (typeof libPath !== "string" || libPath === "") {
    throw new SqliteHooksError(
      "libPath must be the path of the libsqlite3 @db/sqlite loaded (the value of DENO_SQLITE_PATH). It has no default.",
    );
  }
  let unavailable = want === "off"
    ? 'disabled by the preupdate: "off" option'
    : "";
  if (want !== "off") {
    try {
      const full = Deno.dlopen(
        libPath,
        {
          ...SYMBOLS,
          ...PREUPDATE_SYMBOLS,
        } as const,
      );
      return {
        lib: full,
        pre: full.symbols,
        capabilities: { hooks: true, preupdate: true },
      };
    } catch (cause) {
      // Either the preupdate API is absent (the interesting case) or the whole
      // library is wrong — the core dlopen below tells those two apart.
      unavailable = `${libPath} does not export the sqlite3_preupdate_* API: ${
        cause instanceof Error ? cause.message : String(cause)
      }. It is a compile-time option (SQLITE_ENABLE_PREUPDATE_HOOK) and this build was made without it.`;
    }
  }
  let lib: CoreLib;
  try {
    lib = Deno.dlopen(libPath, SYMBOLS);
  } catch (cause) {
    const why = cause instanceof Error ? cause.message : String(cause);
    throw new SqliteHooksError(
      `Cannot use ${libPath} as libsqlite3: ${why}. It must be a shared library exporting the sqlite3_* hook API, and the same file @db/sqlite loaded.`,
      { cause },
    );
  }
  if (want === "required") {
    lib.close();
    throw new SqliteHooksError(
      `preupdate: "required" was asked for, but ${unavailable}`,
    );
  }
  return {
    lib,
    pre: null,
    capabilities: {
      hooks: true,
      preupdate: false,
      preupdateUnavailable: unavailable,
    },
  };
}

/**
 * What `libPath` supports, without attaching to anything. Cheap: it dlopens and
 * immediately closes.
 *
 * Use it to decide up front whether row values and {@linkcode withValidation}
 * are available on this machine, rather than discovering the events never come.
 */
export function probeCapabilities(libPath: string): Capabilities {
  const opened = openLibrary(libPath, "auto");
  opened.lib.close();
  return opened.capabilities;
}

/**
 * Attach commit-lifecycle events to `db`.
 *
 * Call it more than once to add more listeners: they share one set of SQLite
 * hooks and all receive every event. Each call returns its own
 * {@linkcode Subscription}; the FFI is torn down when the last one is disposed,
 * or when `db.close()` is called.
 *
 * @param libPath Path of the libsqlite3 the driver loaded — i.e. the exact
 *   value DENO_SQLITE_PATH held when `@db/sqlite` was imported.
 */
export function withEvents(
  db: Database,
  listener: Listener,
  libPath: string,
  options: EventOptions = {},
): Subscription {
  if (typeof listener !== "function") {
    throw new SqliteHooksError("listener must be a function");
  }
  if (!isDatabase(db)) {
    throw new SqliteHooksError(
      "first argument must be a @db/sqlite Database instance",
    );
  }
  if (!db.open) {
    throw new SqliteHooksError(
      "the Database is already closed; its sqlite3 handle has been freed",
    );
  }
  if (db.unsafeHandle === null) {
    throw new SqliteHooksError("the Database has no sqlite3 handle");
  }

  const existing = REGISTRATIONS.get(db);
  if (existing) return join(existing, db, listener, libPath, options);

  const opened = openLibrary(libPath, options.preupdate ?? "auto");
  const lib = opened.lib;

  // Cheap guard against the SIGSEGV above. Equal versions are not proof of the
  // same file, but they catch the realistic mistake — letting the driver fall
  // back to its downloaded library while we open a system one.
  const ours = readC(lib.symbols.sqlite3_libversion());
  let theirs: string | undefined;
  try {
    theirs = db.prepare("SELECT sqlite_version() AS v").get<{ v: string }>()?.v;
  } catch (cause) {
    lib.close();
    throw new SqliteHooksError(
      `Could not query the driver's SQLite version; the Database is not usable: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }
  if (ours !== theirs) {
    lib.close();
    throw new SqliteHooksError(
      `SQLite library mismatch: hooks opened ${libPath} (${ours}) but the driver is running ${theirs}. ` +
        `Set DENO_SQLITE_PATH to ${libPath} BEFORE importing @db/sqlite, or the process will segfault.`,
    );
  }

  const reg = attach(db, opened, libPath, options);
  reg.listeners.add(listener);
  REGISTRATIONS.set(db, reg);
  return subscription(db, reg, listener);
}

/** A second (or third) listener on a connection that already has hooks. */
function join(
  reg: Registration,
  db: Database,
  listener: Listener,
  libPath: string,
  options: EventOptions,
): Subscription {
  if (reg.closed || reg.detached) {
    throw new SqliteHooksError(
      "this Database's hooks have been disposed; call withEvents again on a live connection",
    );
  }
  if (libPath !== reg.libPath) {
    throw new SqliteHooksError(
      `this Database already has hooks from ${reg.libPath}; a second withEvents cannot open ${libPath} for the same connection`,
    );
  }
  // `preupdate` is a request about the library, not a per-listener setting, so
  // it is satisfied by what the connection already has rather than compared for
  // equality: "required" is happy with a registration that has the API, and
  // fails loudly with one that does not.
  const wanted = options.preupdate;
  if (wanted === "required" && !reg.capabilities.preupdate) {
    throw new SqliteHooksError(
      `preupdate: "required" was asked for, but ${reg.capabilities.preupdateUnavailable}`,
    );
  }
  if (wanted === "off" && reg.capabilities.preupdate) {
    throw new SqliteHooksError(
      "options are per connection, and this Database already has the preupdate hook installed",
    );
  }
  for (
    const key of ["maxChangesPerTransaction", "onListenerError"] as const
  ) {
    if (options[key] !== undefined && options[key] !== reg.options[key]) {
      throw new SqliteHooksError(
        `options are per connection, and ${key} was already set by the first withEvents call on this Database`,
      );
    }
  }
  if (reg.listeners.has(listener)) {
    throw new SqliteHooksError("this listener is already registered");
  }
  reg.listeners.add(listener);
  return subscription(db, reg, listener);
}

function subscription(
  db: Database,
  reg: Registration,
  listener: Listener,
): Subscription {
  let disposed = false;
  return {
    get disposed() {
      return disposed;
    },
    get capabilities() {
      return reg.capabilities;
    },
    dispose() {
      if (disposed) return; // idempotent by design
      if (reg.inListener) {
        throw new SqliteHooksError(
          "dispose() cannot be called from inside a listener — closing a callback that is on the stack segfaults. Defer it with queueMicrotask().",
        );
      }
      disposed = true;
      reg.listeners.delete(listener);
      if (reg.listeners.size === 0) {
        reg.teardown();
        if (!reg.closed) reg.detach();
        REGISTRATIONS.delete(db);
      }
    },
  };
}

/** Any callable, whatever its parameters: enough to wrap, never enough to call blindly. */
type Patchable = (...args: never[]) => unknown;

const isPatchable = (v: unknown): v is Patchable => typeof v === "function";

/** Cross-realm safe: a thenable need not be an `instanceof Promise`. */
function isThenable(v: unknown): v is PromiseLike<unknown> {
  if (v === null || (typeof v !== "object" && typeof v !== "function")) {
    return false;
  }
  return typeof Reflect.get(v, "then") === "function";
}

const nameOf = (fn: Listener): string =>
  fn.name === "" ? "an anonymous listener" : `listener ${fn.name}`;

/** One warning per listener, however many events it returns from. */
const WARNED = new WeakSet<Listener>();

function warnIgnoredReturn(l: Listener, type: DbEvent["type"]): void {
  if (WARNED.has(l)) return;
  WARNED.add(l);
  console.warn(
    `${
      nameOf(l)
    } returned a value from a "${type}" event, where the return value is ignored (only precommit reads one) — and if the listener is async it is never awaited, so its errors are swallowed and its work does not finish before the commit.`,
  );
}

function attach(
  db: Database,
  opened: OpenedLibrary,
  libPath: string,
  options: EventOptions,
): Registration {
  const { lib, pre, capabilities } = opened;
  const handle = db.unsafeHandle;
  /** Captured before anything is patched: schema lookups must not re-enter our own wrappers. */
  const rawPrepare = db.prepare.bind(db);
  const maxChanges = options.maxChangesPerTransaction ?? DEFAULT_MAX_CHANGES;
  if (!(maxChanges > 0)) {
    lib.close();
    throw new SqliteHooksError("maxChangesPerTransaction must be > 0");
  }

  let pending: Change[] = []; // rows since the last commit/rollback boundary
  let pendingCount = 0; // including any past the cap
  const committed: Batch[] = []; // batches whose commit is awaiting the drain
  let depth = 0; // re-entrancy guard: only drain at the outermost call
  const errors: Array<{ error: unknown; event: DbEvent }> = [];

  const reg: Registration = {
    libPath,
    lib,
    pre,
    capabilities,
    handle,
    listeners: new Set<Listener>(),
    options,
    inHook: false,
    inListener: false,
    closed: false,
    detached: false,
    teardown: () => {},
    detach: () => {},
    flush: () => {},
    drain: () => {},
  };

  /** Never throws: a listener error must not cross the FFI boundary. */
  const dispatch = (event: DbEvent): boolean => {
    let veto = false;
    const outer = reg.inListener;
    reg.inListener = true;
    try {
      for (const l of [...reg.listeners]) {
        try {
          const returned = l(event);
          if (event.type !== "precommit") {
            if (returned !== undefined) warnIgnoredReturn(l, event.type);
          } else if (isThenable(returned)) {
            // A pending Promise is not `false`, so an async veto would be read
            // as consent. Refuse the commit rather than fail open.
            throw new SqliteHooksError(
              `${
                nameOf(l)
              } returned a Promise from precommit, so its verdict cannot be read before the commit decision; the commit was refused. Make the listener synchronous.`,
            );
          } else if (returned === false) veto = true;
        } catch (error) {
          errors.push({ error, event });
          if (event.type === "precommit") veto = true;
        }
      }
    } finally {
      reg.inListener = outer;
    }
    return veto;
  };

  const coverage = (): BatchCoverage =>
    pendingCount === 0
      ? "unknown"
      : pendingCount > pending.length
      ? "truncated"
      : "complete";

  const batch = (): Batch => {
    const b: Batch = {
      changes: pending,
      changeCount: pendingCount,
      coverage: coverage(),
    };
    pending = [];
    pendingCount = 0;
    return b;
  };

  const drain = () => {
    while (committed.length) {
      dispatch({ type: "postcommit", ...committed.shift()! });
    }
  };

  const describe = (e: unknown) => e instanceof Error ? e.message : String(e);

  /**
   * Surface whatever listeners threw, from JS. `alongside` is the exception the
   * SQL call itself is already unwinding with, if any: both are reported, since
   * a guard error is usually the *cause* of the SQL failure ("constraint
   * failed" is all SQLite says when a precommit listener vetoes).
   */
  const flush = (alongside?: unknown) => {
    if (errors.length === 0) return;
    const taken = errors.splice(0, errors.length);
    const report = options.onListenerError;
    if (report) {
      for (const { error, event } of taken) report(error, event);
      return;
    }
    const messages = taken.map((t) => describe(t.error)).join("; ");
    if (alongside !== undefined) {
      throw new AggregateError(
        [alongside, ...taken.map((t) => t.error)],
        `SQLite call failed (${
          describe(alongside)
        }) and ${taken.length} listener error(s) were raised: ${messages}`,
      );
    }
    if (taken.length === 1) throw taken[0]!.error;
    throw new AggregateError(
      taken.map((t) => t.error),
      `${taken.length} listener errors during a SQLite event: ${messages}`,
    );
  };

  /**
   * Body of an FFI callback. Anything escaping here would unwind through
   * SQLite's own C frames, so nothing is allowed to.
   */
  /** Carried by an error report that has no row behind it; opcode -1 is no opcode. */
  const NO_ROW: Change = {
    op: "unknown",
    opcode: -1,
    db: "",
    table: "",
    rowid: 0n,
  };

  const inFfi = <T>(fallback: T, body: () => T): T => {
    if (reg.inHook) {
      // Re-entered through a path we do not instrument. Dispatching now would
      // recurse without bound, so drop the event and report it.
      errors.push({
        error: new SqliteHooksError(
          "a SQLite hook fired while another was running — the connection was used from inside a listener",
        ),
        event: {
          type: "change",
          change: NO_ROW,
        },
      });
      return fallback;
    }
    reg.inHook = true;
    try {
      return body();
    } catch (error) {
      errors.push({
        error,
        event: {
          type: "change",
          change: NO_ROW,
        },
      });
      return fallback;
    } finally {
      reg.inHook = false;
    }
  };

  // ------------------------------------------------------------- preupdate
  //
  // Column names are not available from the preupdate API at all — there is no
  // sqlite3_preupdate_name(), and sqlite3_column_*_name() describe a prepared
  // statement's result columns, which a hook does not have. The only source is
  // the schema itself (PRAGMA table_info), and querying it from inside the
  // callback is precisely what SQLite forbids. So the cache is filled from
  // OUTSIDE: once at attach, and at the next statement boundary whenever
  // something invalidated it. Names are matched to values by cid order, which
  // is the order preupdate_old/new use.
  const columnCache = new Map<string, readonly string[]>();
  /** Something was seen that the cache cannot explain; refill at the next boundary. */
  let schemaDirty = false;
  const DDL = /\b(create|alter|drop|attach|detach)\b/i;
  const key = (schema: string, table: string) =>
    `${schema.length}:${schema}:${table}`;

  /** Run one uninstrumented query and release the statement rather than waiting for GC. */
  const ask = <T extends Record<string, unknown>>(
    sql: string,
    ...params: string[]
  ): T[] => {
    const stmt = rawPrepare(sql);
    try {
      return stmt.all<T>(...params);
    } finally {
      stmt.finalize();
    }
  };

  const primeSchema = () => {
    if (!pre || reg.closed || reg.detached) return;
    schemaDirty = false;
    try {
      const schemas = ask<{ name: string }>("PRAGMA database_list")
        .map((r) => r.name);
      for (const schema of schemas) {
        const quoted = `"${schema.replaceAll('"', '""')}"`;
        const rows = ask<{ tbl: string; col: string }>(
          `SELECT m.name AS tbl, p.name AS col FROM ${quoted}.sqlite_schema m ` +
            `JOIN pragma_table_info(m.name, ?) p WHERE m.type = 'table' ` +
            `ORDER BY m.name, p.cid`,
          schema,
        );
        const grouped = new Map<string, string[]>();
        for (const { tbl, col } of rows) {
          const list = grouped.get(tbl);
          if (list) list.push(col);
          else grouped.set(tbl, [col]);
        }
        for (const [tbl, cols] of grouped) {
          columnCache.set(key(schema, tbl), Object.freeze(cols));
        }
      }
    } catch {
      // A schema we cannot read is not worth failing a write over: events keep
      // arriving, positionally, and we try again at the next boundary.
      schemaDirty = true;
    }
  };

  // One reusable out-param for the sqlite3_value** the accessors fill in.
  // Reused deliberately: it is only ever read back on the next line, on this
  // thread, inside the callback.
  const valueOut = new BigUint64Array(1);
  const valueOutPtr = Deno.UnsafePointer.of(valueOut);
  const decoder = new TextDecoder();

  /**
   * Decode one column, eagerly. ONLY valid inside the preupdate callback: the
   * `sqlite3_value*` dies when it returns, so nothing here may keep the
   * pointer, and every byte is copied out before we hand anything to JS.
   *
   * `undefined` means "this side of the row does not exist for this op" — the
   * accessor said so with a non-zero rc.
   */
  const readValue = (
    dbh: Deno.PointerValue,
    i: number,
    side: "old" | "new",
  ): RowValue | undefined => {
    const p = pre!;
    valueOut[0] = 0n;
    const rc = side === "old"
      ? p.sqlite3_preupdate_old(dbh, i, valueOutPtr)
      : p.sqlite3_preupdate_new(dbh, i, valueOutPtr);
    if (rc !== 0) return undefined;
    const v = Deno.UnsafePointer.create(valueOut[0]);
    if (v === null) return null;
    switch (p.sqlite3_value_type(v)) {
      case VALUE_INTEGER:
        return p.sqlite3_value_int64(v);
      case VALUE_FLOAT:
        return p.sqlite3_value_double(v);
      case VALUE_TEXT: {
        // By byte length, not as a C string: SQLite text may contain NUL.
        const n = p.sqlite3_value_bytes(v);
        const ptr = p.sqlite3_value_text(v);
        if (ptr === null || n <= 0) return "";
        const bytes = new Uint8Array(n);
        new Deno.UnsafePointerView(ptr).copyInto(bytes);
        return decoder.decode(bytes);
      }
      case VALUE_BLOB: {
        const n = p.sqlite3_value_bytes(v);
        const ptr = p.sqlite3_value_blob(v);
        if (ptr === null || n <= 0) return new Uint8Array(0);
        const bytes = new Uint8Array(n);
        new Deno.UnsafePointerView(ptr).copyInto(bytes);
        return bytes;
      }
      default:
        return null; // SQLITE_NULL
    }
  };

  const record = (change: Change) => {
    pendingCount++;
    if (pending.length < maxChanges) pending.push(change);
  };

  const preupdateCb = pre
    ? new Deno.UnsafeCallback(
      {
        // Note the second pointer: the preupdate callback is handed the
        // sqlite3* that update_hook's callback is not, and the accessors need
        // it.
        parameters: [
          "pointer",
          "pointer",
          "i32",
          "pointer",
          "pointer",
          "i64",
          "i64",
        ],
        result: "void",
      } as const,
      (_ctx, dbh, opcode, zDb, zTable, iKey1, iKey2) =>
        inFfi(undefined, () => {
          const op = opFor(opcode);
          const schema = readC(zDb);
          const table = readC(zTable);
          const count = pre.sqlite3_preupdate_count(dbh);
          const blobwrite = pre.sqlite3_preupdate_blobwrite(dbh);
          const cached = columnCache.get(key(schema, table));
          // A stale cache (a column added since) is as bad as a missing one:
          // names would be silently misaligned. Length is the cheap check.
          const named = cached !== undefined && cached.length === count;
          if (!named) schemaDirty = true;

          const values = (side: "old" | "new"): RowValue[] | null => {
            const out: RowValue[] = [];
            for (let i = 0; i < count; i++) {
              const v = readValue(dbh, i, side);
              if (v === undefined) return null;
              out.push(v);
            }
            return out;
          };
          // Branch on the op rather than trusting the accessor: _old on an
          // INSERT and _new on a DELETE return a non-zero rc, not a row.
          const oldValues = op === "insert" ? null : values("old");
          const newValues = op === "delete" ? null : values("new");
          const toRow = (vals: RowValue[] | null): Row | null =>
            vals === null ? null : Object.freeze(
              Object.fromEntries(
                vals.map((v, i) => [named ? cached![i]! : String(i), v]),
              ),
            );

          dispatch({
            type: "preupdate",
            op,
            opcode,
            db: schema,
            table,
            oldRowid: iKey1,
            newRowid: iKey2,
            rowidChanged: op === "update" && iKey1 !== iKey2,
            columns: named ? cached! : [],
            named,
            old: toRow(oldValues),
            new: toRow(newValues),
            oldValues: oldValues === null ? null : Object.freeze(oldValues),
            newValues: newValues === null ? null : Object.freeze(newValues),
            blobWriteColumn: blobwrite < 0 ? null : blobwrite,
            depth: pre.sqlite3_preupdate_depth(dbh),
          });

          // sqlite3_update_hook never sees an incremental blob write, so
          // without this the transaction would commit with an empty batch and
          // `coverage: "unknown"`. preupdate does see it — as a DELETE with a
          // blobwrite column — so report the row as the update it really is.
          if (blobwrite >= 0) {
            // `op` and `opcode` disagree here, and that disagreement is the
            // only signal that we synthesised this event: SQLite delivered a
            // DELETE opcode, and an incremental blob write really is an update.
            const change: Change = {
              op: "update",
              opcode,
              db: schema,
              table,
              rowid: iKey1,
            };
            record(change);
            dispatch({ type: "change", change });
          }
        }),
    )
    : null;

  const update = new Deno.UnsafeCallback(
    {
      parameters: ["pointer", "i32", "pointer", "pointer", "i64"],
      result: "void",
    } as const,
    (_arg, op, zDb, zTable, rowid) =>
      inFfi(undefined, () => {
        const change: Change = {
          op: opFor(op),
          opcode: op,
          db: readC(zDb),
          table: readC(zTable),
          rowid,
        };
        record(change);
        dispatch({ type: "change", change });
      }),
  );

  const commit = new Deno.UnsafeCallback(
    { parameters: ["pointer"], result: "i32" } as const,
    () =>
      inFfi(1, () => {
        const snapshot: Batch = {
          changes: pending,
          changeCount: pendingCount,
          coverage: coverage(),
        };
        // Non-zero converts the COMMIT into a ROLLBACK; rollback_hook fires
        // next and reports `pending`, so leave it in place on veto.
        if (dispatch({ type: "precommit", ...snapshot })) return 1;
        batch();
        committed.push(snapshot);
        return 0;
      }),
  );

  const rollback = new Deno.UnsafeCallback(
    { parameters: ["pointer"], result: "void" } as const,
    () =>
      inFfi(undefined, () => {
        // A commit that failed *after* our hook approved it rolls back; drop
        // that batch so it never surfaces as a postcommit.
        const b = committed.pop() ?? batch();
        pending = [];
        pendingCount = 0;
        // Emitted even when empty: an unobserved write (blob I/O, DDL) is
        // exactly as invisible here as it is on the commit path.
        dispatch({ type: "rollback", ...b });
      }),
  );

  // A forgotten dispose() should not wedge the process open at exit; these are
  // only ever called synchronously from FFI on this thread.
  update.unref();
  commit.unref();
  rollback.unref();
  preupdateCb?.unref();

  if (pre && preupdateCb) {
    pre.sqlite3_preupdate_hook(handle, preupdateCb.pointer, null);
  }
  lib.symbols.sqlite3_update_hook(handle, update.pointer, null);
  lib.symbols.sqlite3_commit_hook(handle, commit.pointer, null);
  lib.symbols.sqlite3_rollback_hook(handle, rollback.pointer, null);

  let torn = false;
  reg.teardown = () => {
    if (torn) return;
    torn = true;
    // Order matters: unregister while the connection is still alive, so SQLite
    // can never call a callback we are about to free.
    if (!reg.closed) {
      lib.symbols.sqlite3_update_hook(handle, null, null);
      lib.symbols.sqlite3_commit_hook(handle, null, null);
      lib.symbols.sqlite3_rollback_hook(handle, null, null);
      pre?.sqlite3_preupdate_hook(handle, null, null);
    }
    update.close();
    commit.close();
    rollback.close();
    preupdateCb?.close();
    lib.close();
  };
  reg.flush = flush;
  reg.drain = drain;

  // Wrap the driver's synchronous entry points so `postcommit` lands right
  // after the call that caused it, rather than at some later checkpoint, and
  // so every route into the C API is guarded.
  const undo: Array<() => void> = [];
  reg.detach = () => {
    if (reg.detached) return;
    reg.detached = true;
    for (const u of undo) u();
  };

  const guard = (what: string) => {
    if (reg.closed) {
      throw new SqliteHooksError(
        `${what} was called on a closed Database; its sqlite3 handle is freed and using it is undefined behaviour`,
      );
    }
    if (reg.inHook) {
      throw new SqliteHooksError(
        `${what} was called from inside a change/precommit/rollback listener. SQLite forbids using the connection from within its hooks. Do it from postcommit, or defer with queueMicrotask().`,
      );
    }
  };

  const instrument = (fn: Patchable, what: string): Patchable =>
    function (this: unknown, ...args: never[]) {
      guard(what);
      // Column names are refreshed here, between statements, because the hook
      // itself may not touch the connection. Ordering matters: refill first,
      // then mark dirty if this statement is the kind that changes the schema,
      // so the refill lands after it rather than before.
      if (depth === 0 && pre) {
        if (schemaDirty && !reg.closed && !reg.detached) primeSchema();
        const sql = args[0];
        if (typeof sql === "string" && DDL.test(sql)) schemaDirty = true;
      }
      depth++;
      try {
        const result = fn.apply(this, args);
        if (--depth === 0 && !reg.detached && !reg.closed) {
          drain();
          flush();
        }
        return result;
      } catch (sqlError) {
        if (depth > 0) depth--;
        if (depth === 0 && !reg.detached && !reg.closed) {
          drain();
          // Never swallow the caller's error, never lose the listener's.
          flush(sqlError);
        }
        throw sqlError;
      }
    };

  /**
   * Install `replacement` at `obj[name]`, recording how to put back exactly
   * what was there — including "nothing", when the method was inherited from
   * the prototype. Restoring a bound copy instead would leave the Database
   * permanently altered.
   */
  const patch = (
    obj: object,
    name: string,
    replacement: unknown,
    undoable = true,
  ) => {
    const own = Object.hasOwn(obj, name);
    const orig: unknown = Reflect.get(obj, name);
    Reflect.set(obj, name, replacement);
    if (!undoable) return;
    undo.push(() => {
      if (own) Reflect.set(obj, name, orig);
      else Reflect.deleteProperty(obj, name);
    });
  };

  /** Patch own+inherited callables in `names`, recording how to undo it. */
  const wrap = (
    obj: object,
    names: readonly string[],
    label: string,
    undoable = true,
  ) => {
    for (const name of names) {
      const orig: unknown = Reflect.get(obj, name);
      if (!isPatchable(orig)) continue;
      patch(obj, name, instrument(orig, `${label}${name}()`), undoable);
    }
  };

  wrap(db, DB_METHODS, "db.");

  const origOpenBlob: unknown = Reflect.get(db, "openBlob");
  if (isPatchable(origOpenBlob)) {
    patch(db, "openBlob", (...args: never[]) => {
      guard("db.openBlob()");
      const blob: unknown = origOpenBlob.apply(db, args);
      if (blob !== null && typeof blob === "object") {
        wrap(blob, BLOB_METHODS, "blob.", false);
      }
      return blob;
    });
  }

  // Statements: patch the ones created from here on. The driver installs
  // run/get/all/... as OWN properties on each Statement, shadowing the
  // prototype, so the prototype is not a useful place to patch.
  const origPrepare = db.prepare.bind(db);
  patch(db, "prepare", (sql: string) => {
    guard("db.prepare()");
    const stmt = origPrepare(sql);
    wrap(stmt, STMT_METHODS, "statement.", false);
    return stmt;
  });

  // db.transaction() returns a closure that BEGINs and COMMITs internally, and
  // carries .default/.deferred/.immediate/.exclusive versions of itself.
  const origTransaction = db.transaction.bind(db);
  patch(db, "transaction", (fn: (...args: unknown[]) => void) => {
    guard("db.transaction()");
    const tx = origTransaction(fn);
    const wrapped = instrument(tx, "transaction()");
    const props: PropertyDescriptorMap = {};
    for (const variant of TX_VARIANTS) {
      const v: unknown = Reflect.get(tx, variant);
      if (isPatchable(v)) {
        props[variant] = {
          value: instrument(v, `transaction().${variant}()`),
        };
      }
    }
    if (tx.database !== undefined) {
      props.database = { value: tx.database, enumerable: true };
    }
    Object.defineProperties(wrapped, props);
    return wrapped;
  });

  // Intercept close(): the callbacks must not outlive the connection, and the
  // driver does not guard use-after-close at all.
  const origClose = db.close.bind(db);
  patch(db, "close", () => {
    if (reg.closed) return; // the driver's close() is a no-op too
    if (reg.inListener) {
      throw new SqliteHooksError(
        "db.close() cannot be called from inside a listener. Defer it with queueMicrotask().",
      );
    }
    drain();
    // Closing with a transaction open discards it. Report that from JS rather
    // than from SQLite's own rollback hook, which we are about to unregister
    // (unregistering has to happen while the connection is still alive).
    let openTransaction = false;
    try {
      openTransaction = db.inTransaction;
    } catch {
      openTransaction = pendingCount > 0;
    }
    if (openTransaction) dispatch({ type: "rollback", ...batch() });
    reg.teardown();
    reg.closed = true;
    origClose();
    // The wrappers stay installed: from here they throw instead of handing a
    // freed pointer to the C API.
    REGISTRATIONS.delete(db);
    flush();
  });

  primeSchema();
  return reg;
}

// --------------------------------------------------------------- validation

/**
 * A verdict on one row about to be written.
 *
 * Return a string (or `false`) to REJECT it; return anything else — including
 * nothing — to accept. A validator that throws also rejects, with its own
 * message as the reason.
 */
export type Validator = (row: PreUpdate) => string | boolean | void;

/**
 * Reject writes from JavaScript: `validate` sees every row before it lands,
 * with its old and new column values, and can refuse it.
 *
 * ```ts
 * withValidation(db, (row) => {
 *   if (row.table !== "accounts" || row.new === null) return;
 *   if ((row.new.balance as bigint) < 0n) return "balance must not go negative";
 * }, LIB);
 * ```
 *
 * ## The semantics, which are surprising — read this
 *
 * SQLite has no way to veto a single row: both preupdate_hook and update_hook
 * are `void` by definition. The only veto SQLite offers is the commit hook, so
 * a rejection is *remembered* and spent at the next COMMIT, which becomes a
 * ROLLBACK. Therefore:
 *
 * - **A bare statement with no BEGIN** is its own implicit transaction, so
 *   rejecting its commit rejects exactly that statement. This is the case that
 *   behaves the way you expect.
 * - **Inside an explicit transaction, one rejected row rolls back the WHOLE
 *   transaction** — including every good row written before it, and any written
 *   after it, since the rows keep being validated until the COMMIT arrives. It
 *   is not a per-row skip. If you need one, use the trigger recipe in
 *   the README instead: a BEFORE trigger whose WHEN clause calls a
 *   `db.function()` and whose body is `SELECT RAISE(IGNORE)` drops just the
 *   offending row and lets the rest of the transaction commit.
 * - **The caller sees SQLite's generic "constraint failed"**, because that is
 *   all SQLite says about a vetoed commit. Your reason comes back alongside it
 *   in an `AggregateError` — unless `onListenerError` is set, in which case it
 *   goes there instead and the caller sees only SQLite's message.
 * - **The first rejection in a transaction wins**; later rows are still shown
 *   to the validator, but their verdicts are not collected.
 * - **Requires the preupdate API** (`options.preupdate` is forced to
 *   `"required"`): this throws at attach time rather than silently validate
 *   nothing.
 */
export function withValidation(
  db: Database,
  validate: Validator,
  libPath: string,
  options: EventOptions = {},
): Subscription {
  if (typeof validate !== "function") {
    throw new SqliteHooksError("validate must be a function");
  }
  if (options.preupdate === "off") {
    throw new SqliteHooksError(
      'withValidation cannot work with preupdate: "off" — the row values it validates come from the preupdate hook',
    );
  }
  let rejection: { reason: string; row: PreUpdate } | null = null;
  return withEvents(
    db,
    (event) => {
      switch (event.type) {
        case "preupdate": {
          if (rejection) return; // first rejection in a transaction wins
          let verdict: ReturnType<Validator>;
          try {
            verdict = validate(event);
          } catch (error) {
            // A validator that throws is refusing the row, not failing us.
            verdict = error instanceof Error ? error.message : String(error);
          }
          if (isThenable(verdict)) {
            verdict = "validator returned a Promise; make it synchronous";
          }
          if (verdict === false) verdict = "rejected by validation";
          if (typeof verdict === "string") {
            rejection = { reason: verdict, row: event };
          }
          return;
        }
        case "precommit": {
          const rejected = rejection;
          rejection = null;
          if (!rejected) return;
          // Throwing here vetoes the commit AND carries the reason back to the
          // caller through the module's own error path.
          throw new SqliteHooksError(
            `write rejected by validation: ${rejected.reason} (${rejected.row.op} ` +
              `${rejected.row.db}.${rejected.row.table} rowid ${rejected.row.newRowid})`,
          );
        }
        case "rollback":
          rejection = null;
          return;
      }
    },
    libPath,
    { ...options, preupdate: "required" },
  );
}
