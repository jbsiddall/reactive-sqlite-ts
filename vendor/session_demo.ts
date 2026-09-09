/**
 * Proof that the SESSION extension genuinely works in the vendored build.
 *
 * Symbol presence (probe.ts) says a function exists. It does not say the
 * feature works: `sqlite3session_create` links fine in a library where the
 * preupdate hook was compiled out, and then records nothing. This drives the
 * whole round trip end to end and checks the data, not the return codes:
 *
 *   1. record a session over a table in database A
 *   2. INSERT / UPDATE / DELETE
 *   3. produce a changeset (and a patchset, for the size comparison)
 *   4. apply the changeset to an untouched database B
 *   5. assert B now equals A, row for row
 *   6. invert the changeset and apply the inverse to B
 *   7. assert B is back to its starting state -- i.e. a working undo
 *
 * Everything here is raw FFI so the demo depends on nothing but the library
 * under test. Nothing is mocked; a failure at any step exits non-zero.
 *
 *   deno task vendor:session-demo             # the vendored build
 *   deno task vendor:session-demo /path/to/libsqlite3.so
 *
 * Needs `--unstable-ffi --allow-ffi --allow-env --allow-read`.
 */

import { vendoredLibraryPath } from "../src/vendored.ts";

// SQLite result codes we care about.
const SQLITE_OK = 0;
const SQLITE_ROW = 100;
const SQLITE_OPEN_READWRITE = 0x00000002;
const SQLITE_OPEN_CREATE = 0x00000004;
/** Returned from the conflict handler: give up and roll the whole thing back. */
const SQLITE_CHANGESET_ABORT = 2;

const SIGNATURES = {
  sqlite3_libversion: { parameters: [], result: "pointer" },
  sqlite3_open_v2: {
    parameters: ["buffer", "buffer", "i32", "pointer"],
    result: "i32",
  },
  sqlite3_close_v2: { parameters: ["pointer"], result: "i32" },
  sqlite3_exec: {
    parameters: ["pointer", "buffer", "pointer", "pointer", "pointer"],
    result: "i32",
  },
  sqlite3_errmsg: { parameters: ["pointer"], result: "pointer" },
  sqlite3_free: { parameters: ["pointer"], result: "void" },
  sqlite3_prepare_v2: {
    parameters: ["pointer", "buffer", "i32", "buffer", "pointer"],
    result: "i32",
  },
  sqlite3_step: { parameters: ["pointer"], result: "i32" },
  sqlite3_finalize: { parameters: ["pointer"], result: "i32" },
  sqlite3_column_count: { parameters: ["pointer"], result: "i32" },
  sqlite3_column_text: { parameters: ["pointer", "i32"], result: "pointer" },

  sqlite3session_create: {
    parameters: ["pointer", "buffer", "buffer"],
    result: "i32",
  },
  sqlite3session_attach: { parameters: ["pointer", "buffer"], result: "i32" },
  sqlite3session_delete: { parameters: ["pointer"], result: "void" },
  sqlite3session_changeset: {
    parameters: ["pointer", "buffer", "buffer"],
    result: "i32",
  },
  sqlite3session_patchset: {
    parameters: ["pointer", "buffer", "buffer"],
    result: "i32",
  },
  sqlite3changeset_apply: {
    parameters: ["pointer", "i32", "buffer", "pointer", "pointer", "pointer"],
    result: "i32",
  },
  sqlite3changeset_invert: {
    parameters: ["i32", "buffer", "buffer", "buffer"],
    result: "i32",
  },
} as const;

type Sqlite = Deno.DynamicLibrary<typeof SIGNATURES>["symbols"];

const enc = new TextEncoder();
/** A NUL-terminated C string as a buffer Deno FFI can pass. */
const cstr = (s: string) => enc.encode(s + "\0");

/** Read a `char *` the library owns. */
function readCString(ptr: Deno.PointerValue): string {
  return ptr === null ? "" : new Deno.UnsafePointerView(ptr).getCString();
}

class SqliteError extends Error {
  override readonly name = "SqliteError";
}

/** One 8-byte output slot for an `sqlite3 **` / `void **` / `int *` argument. */
function outSlot() {
  // The ArrayBuffer is created explicitly rather than taken from a typed
  // array's `.buffer`, which is typed `ArrayBufferLike` and so could be a
  // SharedArrayBuffer as far as the compiler knows. Deno FFI's `buffer`
  // parameter wants `Uint8Array<ArrayBuffer>` specifically, and starting from
  // the ArrayBuffer is what makes that true without asserting it.
  const storage = new ArrayBuffer(8);
  const buf = new BigUint64Array(storage);
  return {
    buf: new Uint8Array(storage),
    pointer(): Deno.PointerValue {
      return Deno.UnsafePointer.create(buf[0]!);
    },
    int32(): number {
      return new Int32Array(storage)[0]!;
    },
  };
}

function check(
  sql: Sqlite,
  code: number,
  db: Deno.PointerValue,
  what: string,
): void {
  if (code !== SQLITE_OK) {
    throw new SqliteError(
      `${what} failed (${code}): ${readCString(sql.sqlite3_errmsg(db))}`,
    );
  }
}

function open(sql: Sqlite, name: string): Deno.PointerValue {
  const out = outSlot();
  const rc = sql.sqlite3_open_v2(
    cstr(name),
    out.buf,
    SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE,
    null,
  );
  const db = out.pointer();
  if (rc !== SQLITE_OK) throw new SqliteError(`could not open ${name} (${rc})`);
  return db;
}

function exec(sql: Sqlite, db: Deno.PointerValue, statements: string): void {
  const rc = sql.sqlite3_exec(db, cstr(statements), null, null, null);
  check(sql, rc, db, `exec ${JSON.stringify(statements.trim().slice(0, 60))}`);
}

/** Every row of `query`, each row as its column values rendered as text. */
function query(
  sql: Sqlite,
  db: Deno.PointerValue,
  statement: string,
): string[][] {
  const out = outSlot();
  const rc = sql.sqlite3_prepare_v2(db, cstr(statement), -1, out.buf, null);
  check(sql, rc, db, `prepare ${JSON.stringify(statement)}`);
  const stmt = out.pointer();
  const rows: string[][] = [];
  try {
    const columns = sql.sqlite3_column_count(stmt);
    while (sql.sqlite3_step(stmt) === SQLITE_ROW) {
      const row: string[] = [];
      for (let i = 0; i < columns; i++) {
        row.push(readCString(sql.sqlite3_column_text(stmt, i)));
      }
      rows.push(row);
    }
  } finally {
    sql.sqlite3_finalize(stmt);
  }
  return rows;
}

/**
 * A changeset or patchset: the bytes, copied out before SQLite frees them.
 *
 * `Uint8Array<ArrayBuffer>`, not a bare `Uint8Array`: the default type
 * parameter is `ArrayBufferLike`, which admits a SharedArrayBuffer and so is
 * rejected by Deno FFI's `buffer` parameter. Pinning it here means every
 * producer below is checked at its source rather than at each call.
 */
interface Blob {
  bytes: Uint8Array<ArrayBuffer>;
}

function captureSet(
  sql: Sqlite,
  session: Deno.PointerValue,
  kind: "changeset" | "patchset",
): Blob {
  const size = outSlot();
  const data = outSlot();
  const rc = kind === "changeset"
    ? sql.sqlite3session_changeset(session, size.buf, data.buf)
    : sql.sqlite3session_patchset(session, size.buf, data.buf);
  if (rc !== SQLITE_OK) {
    throw new SqliteError(`sqlite3session_${kind} failed (${rc})`);
  }
  const n = size.int32();
  const ptr = data.pointer();
  if (n === 0 || ptr === null) return { bytes: new Uint8Array(0) };
  // Copy: the buffer belongs to SQLite and is freed on the next line.
  const bytes = new Uint8Array(
    Deno.UnsafePointerView.getArrayBuffer(ptr, n).slice(0),
  );
  sql.sqlite3_free(ptr);
  return { bytes };
}

function invert(sql: Sqlite, changeset: Blob): Blob {
  const size = outSlot();
  const data = outSlot();
  const rc = sql.sqlite3changeset_invert(
    changeset.bytes.byteLength,
    changeset.bytes,
    size.buf,
    data.buf,
  );
  if (rc !== SQLITE_OK) {
    throw new SqliteError(`sqlite3changeset_invert failed (${rc})`);
  }
  const ptr = data.pointer();
  const n = size.int32();
  if (ptr === null) {
    throw new SqliteError("sqlite3changeset_invert returned no data");
  }
  const bytes = new Uint8Array(
    Deno.UnsafePointerView.getArrayBuffer(ptr, n).slice(0),
  );
  sql.sqlite3_free(ptr);
  return { bytes };
}

/**
 * Apply `changeset` to `db`.
 *
 * The conflict handler is mandatory -- `sqlite3changeset_apply` rejects a NULL
 * xConflict -- and this one aborts. That is the right choice for a proof: a
 * silently-omitted conflicting row would let the demo "pass" while dropping
 * data, which is precisely the sort of thing this exercise is meant to catch.
 */
function apply(sql: Sqlite, db: Deno.PointerValue, changeset: Blob): number {
  let conflicts = 0;
  const onConflict = new Deno.UnsafeCallback(
    { parameters: ["pointer", "i32", "pointer"], result: "i32" } as const,
    () => {
      conflicts++;
      return SQLITE_CHANGESET_ABORT;
    },
  );
  try {
    const rc = sql.sqlite3changeset_apply(
      db,
      changeset.bytes.byteLength,
      changeset.bytes,
      null,
      onConflict.pointer,
      null,
    );
    if (rc !== SQLITE_OK) {
      throw new SqliteError(
        `sqlite3changeset_apply failed (${rc}), ${conflicts} conflict(s): ` +
          readCString(sql.sqlite3_errmsg(db)),
      );
    }
  } finally {
    // close() after the call has returned, never from inside the callback:
    // freeing an UnsafeCallback while it is on the stack segfaults.
    onConflict.close();
  }
  return conflicts;
}

const SCHEMA = `
  CREATE TABLE todo (
    id    INTEGER PRIMARY KEY,   -- session ignores tables with no PRIMARY KEY
    title TEXT NOT NULL,
    done  INTEGER NOT NULL DEFAULT 0
  );
`;

function dump(sql: Sqlite, db: Deno.PointerValue): string {
  return JSON.stringify(
    query(sql, db, "SELECT id, title, done FROM todo ORDER BY id"),
  );
}

let failures = 0;
function assertEqual(label: string, actual: string, expected: string): void {
  if (actual === expected) {
    console.log(`  PASS  ${label}`);
    console.log(`          ${actual}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}`);
    console.log(`          expected ${expected}`);
    console.log(`          actual   ${actual}`);
  }
}

function main(libPath: string): void {
  console.log(`SESSION extension end-to-end demo`);
  console.log(`  library: ${libPath}\n`);

  let lib: Deno.DynamicLibrary<typeof SIGNATURES>;
  try {
    lib = Deno.dlopen(libPath, SIGNATURES);
  } catch (error) {
    console.error(
      `Could not open ${libPath} with the SESSION symbols.\n` +
        `This library was almost certainly built without SQLITE_ENABLE_SESSION.\n` +
        `Run the probe to see exactly what it has:\n` +
        `  deno task vendor:probe ${libPath}\n\n${error}`,
    );
    Deno.exit(1);
  }
  const sql = lib.symbols;
  console.log(`  SQLite ${readCString(sql.sqlite3_libversion())}\n`);

  const a = open(sql, ":memory:");
  const b = open(sql, ":memory:");
  try {
    // Both databases start identical and empty. B is the "replica".
    exec(sql, a, SCHEMA);
    exec(sql, b, SCHEMA);
    const initial = dump(sql, b);

    // 1. Start recording.
    const sessionOut = outSlot();
    check(
      sql,
      sql.sqlite3session_create(a, cstr("main"), sessionOut.buf),
      a,
      "sqlite3session_create",
    );
    const session = sessionOut.pointer();
    // NULL would attach every table; naming it proves per-table attachment.
    check(
      sql,
      sql.sqlite3session_attach(session, cstr("todo")),
      a,
      "sqlite3session_attach",
    );

    // 2. Change A: an insert, an update, and a delete, so the changeset has
    //    all three operation types rather than the easy one.
    exec(
      sql,
      a,
      `
      INSERT INTO todo (id, title, done) VALUES (1, 'vendor sqlite', 0);
      INSERT INTO todo (id, title, done) VALUES (2, 'probe symbols', 0);
      INSERT INTO todo (id, title, done) VALUES (3, 'delete me', 0);
      UPDATE todo SET done = 1 WHERE id = 1;
      DELETE FROM todo WHERE id = 3;
    `,
    );
    const afterChanges = dump(sql, a);

    // 3. Capture. The patchset is captured only to show the size difference.
    const changeset = captureSet(sql, session, "changeset");
    const patchset = captureSet(sql, session, "patchset");
    sql.sqlite3session_delete(session);

    console.log(`  changeset: ${changeset.bytes.byteLength} bytes`);
    // Do not claim the patchset is smaller: on rows this narrow the two come
    // out the same size, and saying otherwise would be a demo that lies.
    console.log(
      `  patchset:  ${patchset.bytes.byteLength} bytes  (new values only: it cannot be` +
        ` inverted, and only pays off on wide rows)`,
    );
    if (changeset.bytes.byteLength === 0) {
      failures++;
      console.log(
        `  FAIL  the changeset is EMPTY. The symbols resolved but nothing was\n` +
          `        recorded, which is what a library without a working preupdate\n` +
          `        hook looks like.`,
      );
    }
    console.log();

    // 4-5. Apply to B and compare.
    const conflicts = apply(sql, b, changeset);
    console.log(`  applied changeset to database B (${conflicts} conflicts)`);
    assertEqual(
      "B matches A after applying the changeset",
      dump(sql, b),
      afterChanges,
    );

    // 6-7. Undo.
    const inverse = invert(sql, changeset);
    console.log(`\n  inverted changeset: ${inverse.bytes.byteLength} bytes`);
    const undoConflicts = apply(sql, b, inverse);
    console.log(
      `  applied the inverse to database B (${undoConflicts} conflicts)`,
    );
    assertEqual(
      "B is back to its starting state (undo works)",
      dump(sql, b),
      initial,
    );

    // A is untouched by any of this: the changeset moved, the source did not.
    assertEqual(
      "A was not modified by any of the above",
      dump(sql, a),
      afterChanges,
    );
  } finally {
    sql.sqlite3_close_v2(a);
    sql.sqlite3_close_v2(b);
    lib.close();
  }

  console.log();
  if (failures > 0) {
    console.error(`${failures} assertion(s) failed.`);
    Deno.exit(1);
  }
  console.log(
    "SESSION extension works: changeset produced, applied, and inverted.",
  );
}

if (import.meta.main) {
  const explicit = Deno.args[0];
  main(explicit ?? (Deno.env.get("DENO_SQLITE_PATH") || vendoredLibraryPath()));
}
