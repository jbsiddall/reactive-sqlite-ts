/**
 * The Deno FFI backend: the only implementation of {@linkcode Backend} today.
 *
 * Everything that holds a pointer lives here. Values are copied out of
 * SQLite's memory before they are handed upward, because a `sqlite3_value*`
 * dies when the callback returns.
 */
import type {
  Attachment,
  AttachOptions,
  Backend,
  BackendHandlers,
  RawPreUpdate,
  RawTrace,
  TraceSql,
} from "./backend.ts";
import { SQLITE_DELETE, SQLITE_INSERT } from "./backend.ts";
import type { Capabilities, EventOptions, RowValue } from "./hooks.ts";
// A runtime cycle with hooks.ts, safe because neither reference is evaluated
// at module-evaluation time. If a third module ever appears, this class moves
// into it; it is not worth a module of its own.
import { SqliteHooksError } from "./hooks.ts";

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

/**
 * WAL. Absent only from a build made with SQLITE_OMIT_WAL, but opened
 * separately for the same reason preupdate is: a missing optional feature must
 * not read as "your libsqlite3 is unusable".
 */
const WAL_SYMBOLS = {
  sqlite3_wal_hook: {
    parameters: ["pointer", "function", "pointer"],
    result: "pointer",
  },
  /** (db, zDb, mode, out nLog, out nCkpt) -> rc. Mode 0 is PASSIVE. */
  sqlite3_wal_checkpoint_v2: {
    parameters: ["pointer", "pointer", "i32", "pointer", "pointer"],
    result: "i32",
  },
} as const;

/**
 * Tracing. Opened separately so a build without it is a missing capability
 * rather than an unusable library.
 */
const TRACE_SYMBOLS = {
  sqlite3_trace_v2: {
    parameters: ["pointer", "u32", "function", "pointer"],
    result: "i32",
  },
  sqlite3_sql: { parameters: ["pointer"], result: "pointer" },
  /** Inlines bound parameter VALUES. Its result is malloc'd and must be freed. */
  sqlite3_expanded_sql: { parameters: ["pointer"], result: "pointer" },
  sqlite3_free: { parameters: ["pointer"], result: "void" },
} as const;

/** Absent only from a build made with SQLITE_OMIT_PROGRESS_CALLBACK. */
const PROGRESS_SYMBOLS = {
  sqlite3_progress_handler: {
    parameters: ["pointer", "i32", "function", "pointer"],
    result: "void",
  },
} as const;

/** Needs SQLITE_ENABLE_NORMALIZE, which stock distribution builds do not set. */
const NORMALIZE_SYMBOLS = {
  sqlite3_normalized_sql: { parameters: ["pointer"], result: "pointer" },
} as const;

const TRACE_STMT = 0x01, TRACE_PROFILE = 0x02, TRACE_ROW = 0x04;

/** PASSIVE: what sqlite3_wal_checkpoint(), and so SQLite's own hook, uses. */
const CHECKPOINT_PASSIVE = 0;

type CoreLib = Deno.DynamicLibrary<typeof SYMBOLS>;
type WalLib = Deno.DynamicLibrary<typeof WAL_SYMBOLS>;
type TraceLib = Deno.DynamicLibrary<typeof TRACE_SYMBOLS>;
type NormalizeLib = Deno.DynamicLibrary<typeof NORMALIZE_SYMBOLS>;
type ProgressLib = Deno.DynamicLibrary<typeof PROGRESS_SYMBOLS>;
type PreSymbols = Deno.DynamicLibrary<typeof PREUPDATE_SYMBOLS>["symbols"];

/** SQLITE_NULL etc., as returned by sqlite3_value_type. */
const VALUE_INTEGER = 1, VALUE_FLOAT = 2, VALUE_TEXT = 3, VALUE_BLOB = 4;

type Opened = {
  lib: CoreLib;
  pre: PreSymbols | null;
  wal: WalLib | null;
  trace: TraceLib | null;
  normalize: NormalizeLib | null;
  progress: ProgressLib | null;
  unavailable: string;
};

/** Null when the build lacks the group. Its own handle, so its absence is isolated. */
function openOptional<T extends Deno.ForeignLibraryInterface>(
  libPath: string,
  symbols: T,
): Deno.DynamicLibrary<T> | null {
  try {
    return Deno.dlopen(libPath, symbols);
  } catch {
    return null;
  }
}

/**
 * Capabilities are DERIVED from `pre`, never carried beside it: two fields
 * saying the same thing can disagree, and a disagreement here would deliver
 * preupdate events the caller believes it does not have.
 */
const capabilitiesOf = (opened: Opened): Capabilities =>
  opened.pre !== null
    ? {
      hooks: true,
      preupdate: true,
      wal: opened.wal !== null,
      trace: opened.trace !== null,
      normalizedSql: opened.normalize !== null,
      progress: opened.progress !== null,
    }
    : {
      hooks: true,
      preupdate: false,
      preupdateUnavailable: opened.unavailable,
      wal: opened.wal !== null,
      trace: opened.trace !== null,
      normalizedSql: opened.normalize !== null,
      progress: opened.progress !== null,
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
): Opened {
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
        wal: openOptional(libPath, WAL_SYMBOLS),
        trace: openOptional(libPath, TRACE_SYMBOLS),
        normalize: openOptional(libPath, NORMALIZE_SYMBOLS),
        progress: openOptional(libPath, PROGRESS_SYMBOLS),
        unavailable: "",
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
    wal: openOptional(libPath, WAL_SYMBOLS),
    trace: openOptional(libPath, TRACE_SYMBOLS),
    normalize: openOptional(libPath, NORMALIZE_SYMBOLS),
    progress: openOptional(libPath, PROGRESS_SYMBOLS),
    unavailable,
  };
}

/**
 * What `libPath` supports. Opens, reads and closes; it never yields a Backend,
 * so there is no such thing as a backend with nothing to attach to.
 */
export function probeFfi(libPath: string): Capabilities {
  const opened = openLibrary(libPath, "auto");
  try {
    return capabilitiesOf(opened);
  } finally {
    opened.lib.close();
    opened.wal?.close();
    opened.trace?.close();
    opened.normalize?.close();
    opened.progress?.close();
  }
}

/** Open `libPath` and bind it to one live connection. */
export function openFfiBackend(
  libPath: string,
  handle: Deno.PointerObject,
  want: NonNullable<EventOptions["preupdate"]>,
): Backend {
  const opened = openLibrary(libPath, want);
  const { lib, pre, wal, trace, normalize, progress } = opened;
  const capabilities = capabilitiesOf(opened);
  const version = readC(lib.symbols.sqlite3_libversion());

  // close() and detach() both end here. One flag, because closing a library or
  // a callback twice aborts the process, and "close only if you never
  // attached" is a rule that would otherwise live in a doc comment.
  let released = false;
  const release = (body: () => void) => {
    if (released) return;
    released = true;
    body();
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
    p: PreSymbols,
    dbh: Deno.PointerValue,
    i: number,
    side: "old" | "new",
  ): RowValue | undefined => {
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

  /** The last line of defence: a handler that throws must not reach SQLite. */
  const safely = (handlers: BackendHandlers, body: () => void): void => {
    try {
      body();
    } catch (error) {
      try {
        handlers.fail(error);
      } catch { /* `fail` threw too; there is nowhere left to report it. */ }
    }
  };

  /**
   * The SQL text for a traced statement. `"statement"` protects BOUND
   * PARAMETERS only — a literal written into the SQL string is returned
   * verbatim — so it is the safe default, not the private one.
   */
  const sqlText = (
    t: TraceLib,
    stmt: Deno.PointerValue,
    mode: TraceSql,
  ): string => {
    if (mode === "with-parameter-values") {
      const p = t.symbols.sqlite3_expanded_sql(stmt);
      const text = readC(p);
      t.symbols.sqlite3_free(p); // malloc'd by SQLite, unlike the others
      return text;
    }
    if (mode === "normalized" && normalize !== null) {
      return readC(normalize.symbols.sqlite3_normalized_sql(stmt));
    }
    return readC(t.symbols.sqlite3_sql(stmt));
  };

  const readTrace = (
    t: TraceLib,
    kind: number,
    stmt: Deno.PointerValue,
    x: Deno.PointerValue,
    mode: TraceSql,
  ): RawTrace => {
    if (kind === TRACE_PROFILE) {
      const nanos = x === null
        ? 0n
        : new Deno.UnsafePointerView(x).getBigInt64();
      return {
        kind: "profile",
        sql: sqlText(t, stmt, mode),
        trigger: false,
        nanos,
      };
    }
    if (kind === TRACE_ROW) {
      return {
        kind: "row",
        sql: sqlText(t, stmt, mode),
        trigger: false,
        nanos: null,
      };
    }
    // STMT: X is the unexpanded text, or an SQL comment for a trigger
    // subprogram — and for a trigger the comment is the only description
    // there is, so it is reported as-is whatever the mode.
    const text = readC(x);
    const trigger = text.startsWith("--");
    return {
      kind: "statement",
      sql: trigger ? text : sqlText(t, stmt, mode),
      trigger,
      nanos: null,
    };
  };

  const readRow = (
    p: PreSymbols,
    dbh: Deno.PointerValue,
    opcode: number,
    zDb: Deno.PointerValue,
    zTable: Deno.PointerValue,
    iKey1: bigint,
    iKey2: bigint,
  ): RawPreUpdate => {
    const db = readC(zDb);
    const table = readC(zTable);
    const count = p.sqlite3_preupdate_count(dbh);
    const blobwrite = p.sqlite3_preupdate_blobwrite(dbh);
    const side = (which: "old" | "new"): RowValue[] | null => {
      const out: RowValue[] = [];
      for (let i = 0; i < count; i++) {
        const v = readValue(p, dbh, i, which);
        if (v === undefined) return null;
        out.push(v);
      }
      return out;
    };
    // Branch on the opcode rather than trusting the accessor: _old on an
    // INSERT and _new on a DELETE return a non-zero rc, not a row.
    const oldValues = opcode === SQLITE_INSERT ? null : side("old");
    const newValues = opcode === SQLITE_DELETE ? null : side("new");
    return {
      opcode,
      db,
      table,
      oldRowid: iKey1,
      newRowid: iKey2,
      columnCount: count,
      blobWriteColumn: blobwrite < 0 ? null : blobwrite,
      depth: p.sqlite3_preupdate_depth(dbh),
      oldValues,
      newValues,
    };
  };

  return {
    capabilities,
    version,
    close: () =>
      release(() => {
        lib.close();
        wal?.close();
        trace?.close();
        normalize?.close();
        progress?.close();
      }),
    attach(handlers: BackendHandlers, options: AttachOptions): Attachment {
      const preupdateCb = pre
        ? new Deno.UnsafeCallback(
          {
            // Note the second pointer: the preupdate callback is handed the
            // sqlite3* that update_hook's callback is not, and the accessors
            // need it.
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
            safely(handlers, () =>
              handlers.preupdate(() =>
                readRow(pre, dbh, opcode, zDb, zTable, iKey1, iKey2)
              )),
        )
        : null;

      const update = new Deno.UnsafeCallback(
        {
          parameters: ["pointer", "i32", "pointer", "pointer", "i64"],
          result: "void",
        } as const,
        (_arg, opcode, zDb, zTable, rowid) =>
          safely(handlers, () =>
            handlers.update(() => ({
              opcode,
              db: readC(zDb),
              table: readC(zTable),
              rowid,
            }))),
      );

      const commit = new Deno.UnsafeCallback(
        { parameters: ["pointer"], result: "i32" } as const,
        // Non-zero converts the COMMIT into a ROLLBACK; a failure below the
        // seam vetoes too, for the same reason the caller's does.
        () => {
          try {
            return handlers.commit() ? 1 : 0;
          } catch (error) {
            safely(handlers, () => {
              throw error;
            });
            return 1;
          }
        },
      );

      const traceMask = trace
        ? options.trace.reduce(
          (m, k) =>
            m |
            (k === "statement"
              ? TRACE_STMT
              : k === "profile"
              ? TRACE_PROFILE
              : TRACE_ROW),
          0,
        )
        : 0;
      const traceCb = trace && traceMask !== 0
        ? new Deno.UnsafeCallback(
          {
            parameters: ["u32", "pointer", "pointer", "pointer"],
            result: "i32",
          } as const,
          (kind, _ctx, p, x) => {
            safely(handlers, () => {
              handlers.trace(() =>
                readTrace(trace, kind, p, x, options.traceSql)
              );
            });
            // SQLite ignores this today and asks for zero so it can start
            // using it later; a listener has no say in it either way.
            return 0;
          },
        )
        : null;

      const progressCb = progress && options.progressOps !== null
        ? new Deno.UnsafeCallback(
          { parameters: ["pointer"], result: "i32" } as const,
          () => {
            let interrupt = false;
            safely(handlers, () => {
              interrupt = handlers.progress();
            });
            // A failure below the seam leaves `interrupt` false: an internal
            // error must not discard a caller's transaction.
            return interrupt ? 1 : 0;
          },
        )
        : null;

      const threshold = options.walCheckpointThreshold;
      const walCb = wal
        ? new Deno.UnsafeCallback(
          {
            parameters: ["pointer", "pointer", "pointer", "i32"],
            result: "i32",
          } as const,
          (_arg, dbh, zDb, frames) => {
            safely(handlers, () => {
              // Checkpoint FIRST, exactly as sqlite3WalDefaultHook did before
              // our hook displaced it, so a slow or throwing listener cannot
              // cost the database a checkpoint. Its result is discarded for
              // the same reason SQLite discards it.
              if (threshold !== null && frames >= threshold) {
                wal.symbols.sqlite3_wal_checkpoint_v2(
                  dbh,
                  zDb,
                  CHECKPOINT_PASSIVE,
                  null,
                  null,
                );
              }
              handlers.wal(() => ({ db: readC(zDb), frames }));
            });
            // Always SQLITE_OK: a non-OK return makes the statement that
            // provoked an already-completed commit report an error, and the
            // listener has no say in that.
            return 0;
          },
        )
        : null;

      const rollback = new Deno.UnsafeCallback(
        { parameters: ["pointer"], result: "void" } as const,
        () => safely(handlers, () => handlers.rollback()),
      );

      // A forgotten dispose() should not wedge the process open at exit; these
      // are only ever called synchronously from FFI on this thread.
      update.unref();
      commit.unref();
      rollback.unref();
      preupdateCb?.unref();
      walCb?.unref();
      traceCb?.unref();
      progressCb?.unref();

      if (pre && preupdateCb) {
        pre.sqlite3_preupdate_hook(handle, preupdateCb.pointer, null);
      }
      lib.symbols.sqlite3_update_hook(handle, update.pointer, null);
      lib.symbols.sqlite3_commit_hook(handle, commit.pointer, null);
      lib.symbols.sqlite3_rollback_hook(handle, rollback.pointer, null);
      if (wal && walCb) {
        wal.symbols.sqlite3_wal_hook(handle, walCb.pointer, null);
      }
      if (trace && traceCb) {
        trace.symbols.sqlite3_trace_v2(
          handle,
          traceMask,
          traceCb.pointer,
          null,
        );
      }
      if (progress && progressCb && options.progressOps !== null) {
        progress.symbols.sqlite3_progress_handler(
          handle,
          options.progressOps,
          progressCb.pointer,
          null,
        );
      }

      return {
        detach: (live: boolean) =>
          release(() => {
            // Order matters: unregister while the connection is still alive,
            // so SQLite can never call a callback we are about to free.
            if (live) {
              lib.symbols.sqlite3_update_hook(handle, null, null);
              lib.symbols.sqlite3_commit_hook(handle, null, null);
              lib.symbols.sqlite3_rollback_hook(handle, null, null);
              pre?.sqlite3_preupdate_hook(handle, null, null);
              if (walCb) wal?.symbols.sqlite3_wal_hook(handle, null, null);
              // Unregistered while the connection is alive, which is also why
              // SQLITE_TRACE_CLOSE is not offered: it only fires if we are
              // still registered when sqlite3_close runs.
              if (traceCb) {
                trace?.symbols.sqlite3_trace_v2(handle, 0, null, null);
              }
              if (progressCb) {
                progress?.symbols.sqlite3_progress_handler(
                  handle,
                  0,
                  null,
                  null,
                );
              }
            }
            update.close();
            commit.close();
            rollback.close();
            preupdateCb?.close();
            walCb?.close();
            traceCb?.close();
            progressCb?.close();
            lib.close();
            wal?.close();
            trace?.close();
            normalize?.close();
            progress?.close();
          }),
      };
    },
  };
}
