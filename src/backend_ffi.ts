/**
 * The Deno FFI backend: the only implementation of {@linkcode Backend} today.
 *
 * Everything that holds a pointer lives here. Values are copied out of
 * SQLite's memory before they are handed upward, because a `sqlite3_value*`
 * dies when the callback returns.
 */
import type {
  Attachment,
  Backend,
  BackendHandlers,
  RawPreUpdate,
} from "./backend.ts";
import { SQLITE_DELETE, SQLITE_INSERT } from "./backend.ts";
import type { Capabilities, EventOptions, RowValue } from "./hooks.ts";
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

type CoreLib = Deno.DynamicLibrary<typeof SYMBOLS>;
type PreSymbols = Deno.DynamicLibrary<typeof PREUPDATE_SYMBOLS>["symbols"];

/** SQLITE_NULL etc., as returned by sqlite3_value_type. */
const VALUE_INTEGER = 1, VALUE_FLOAT = 2, VALUE_TEXT = 3, VALUE_BLOB = 4;

type Opened = {
  lib: CoreLib;
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
 * Open `libPath` and bind it to one connection. `handle` may be null when the
 * caller only wants {@linkcode Backend.capabilities} and will never attach.
 */
export function openFfiBackend(
  libPath: string,
  handle: Deno.PointerValue,
  want: NonNullable<EventOptions["preupdate"]>,
): Backend {
  const { lib, pre, capabilities } = openLibrary(libPath, want);
  const version = readC(lib.symbols.sqlite3_libversion());

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

  const readRow = (
    p: PreSymbols,
    dbh: Deno.PointerValue,
    opcode: number,
    zDb: Deno.PointerValue,
    zTable: Deno.PointerValue,
    iKey1: bigint,
    iKey2: bigint,
  ): RawPreUpdate => {
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
      db: readC(zDb),
      table: readC(zTable),
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
    close: () => lib.close(),
    attach(handlers: BackendHandlers): Attachment {
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
          (_ctx, dbh, opcode, zDb, zTable, iKey1, iKey2) => {
            try {
              handlers.preupdate(
                readRow(pre, dbh, opcode, zDb, zTable, iKey1, iKey2),
              );
            } catch (error) {
              handlers.fail(error);
            }
          },
        )
        : null;

      const update = new Deno.UnsafeCallback(
        {
          parameters: ["pointer", "i32", "pointer", "pointer", "i64"],
          result: "void",
        } as const,
        (_arg, opcode, zDb, zTable, rowid) => {
          try {
            handlers.update({
              opcode,
              db: readC(zDb),
              table: readC(zTable),
              rowid,
            });
          } catch (error) {
            handlers.fail(error);
          }
        },
      );

      const commit = new Deno.UnsafeCallback(
        { parameters: ["pointer"], result: "i32" } as const,
        // Non-zero converts the COMMIT into a ROLLBACK; a failure below the
        // seam vetoes too, for the same reason the caller's does.
        () => {
          try {
            return handlers.commit() ? 1 : 0;
          } catch (error) {
            handlers.fail(error);
            return 1;
          }
        },
      );

      const rollback = new Deno.UnsafeCallback(
        { parameters: ["pointer"], result: "void" } as const,
        () => {
          try {
            handlers.rollback();
          } catch (error) {
            handlers.fail(error);
          }
        },
      );

      // A forgotten dispose() should not wedge the process open at exit; these
      // are only ever called synchronously from FFI on this thread.
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

      return {
        detach(live: boolean) {
          // Order matters: unregister while the connection is still alive, so
          // SQLite can never call a callback we are about to free.
          if (live) {
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
        },
      };
    },
  };
}
