/**
 * The crash matrix for ../src/hooks.ts: every way a caller can reach the FFI
 * wrongly.
 *
 * Each case runs in its own child process (see ./suite.ts), because the whole
 * point is that a mistake here used to take the process down with SIGSEGV
 * (exit 139) and would otherwise take the test run with it. A case passes when
 * the child exits with the code the case declares — 1 for "throws a useful
 * error", 0 for "is simply safe" — and its output matches `match`.
 *
 * Run one directly:
 *   deno run --unstable-ffi --allow-ffi --allow-env --allow-read --allow-write \
 *     --allow-net test/crash_cases.ts dispose-in-listener
 */
import { resolveLibPath } from "../src/lib_path.ts";
import { runHardProperty } from "./hard_properties.ts";

const LIB = resolveLibPath();
const { Database } = await import("@db/sqlite");
const { withEvents, withValidation } = await import("../src/hooks.ts");
type PreUpdate = import("../src/hooks.ts").PreUpdate;
type DbEvent = import("../src/hooks.ts").DbEvent;
type Listener = import("../src/hooks.ts").Listener;
type Db = InstanceType<typeof Database>;

/** Kept modest so the crash matrix stays quick; raise it for a soak run. */
const HARD_RUNS = Number(Deno.env.get("HARD_RUNS") ?? 150);

export type CrashCase = {
  /** What the child process must exit with. Never 139. */
  code: number;
  /** Must appear in the child's combined output. */
  match: string;
  /** Why this case exists. */
  why: string;
  run: () => void;
};

const fresh = (sql = "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)"): Db => {
  const db = new Database(":memory:");
  db.exec(sql);
  return db;
};

/** Attach with a listener that only reacts to one event type. */
const on = (db: Db, type: DbEvent["type"], fn: (e: DbEvent) => unknown) => {
  const listener: Listener = (e) => e.type === type ? fn(e) : undefined;
  return withEvents(db, listener, LIB);
};

const message = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/** A checked read: in a test a wrong storage class is a failure, not a cast. */
const bytes = (v: unknown): Uint8Array => {
  if (v instanceof Uint8Array) return v;
  throw new Error(`expected a blob, got ${Deno.inspect(v)}`);
};

export const CASES: Record<string, CrashCase> = {
  "dispose-in-listener": {
    code: 1,
    match: "dispose() cannot be called from inside a listener",
    why:
      "Closing an UnsafeCallback while it is on the stack: reproduced as exit 139.",
    run() {
      const db = fresh();
      const sub = on(db, "change", () => sub.dispose());
      db.exec("INSERT INTO t VALUES (1, 'a')");
    },
  },

  "close-in-listener": {
    code: 1,
    match: "db.close() cannot be called from inside a listener",
    why: "sqlite3_close_v2 from inside a commit hook is undefined behaviour.",
    run() {
      const db = fresh();
      on(db, "precommit", () => db.close());
      db.exec("INSERT INTO t VALUES (1, 'a')");
    },
  },

  "close-in-postcommit": {
    code: 1,
    match: "db.close() cannot be called from inside a listener",
    why:
      "postcommit is outside the FFI hook, but closing mid-drain still ends the connection under our own feet.",
    run() {
      const db = fresh();
      on(db, "postcommit", () => db.close());
      db.exec("INSERT INTO t VALUES (1, 'a')");
    },
  },

  "use-after-close": {
    code: 1,
    match: "closed Database",
    why:
      "The driver does not check: exec() after close() hands a freed sqlite3* to the C API.",
    run() {
      const db = fresh();
      withEvents(db, () => {}, LIB);
      db.close();
      db.exec("INSERT INTO t VALUES (1, 'a')");
    },
  },

  "prepare-after-close": {
    code: 1,
    match: "closed Database",
    why: "Same freed pointer, reached through prepare() instead.",
    run() {
      const db = fresh();
      withEvents(db, () => {}, LIB);
      db.close();
      db.prepare("SELECT 1").get();
    },
  },

  "statement-after-close": {
    code: 1,
    match: "closed Database",
    why:
      "A statement prepared before the close still points at the connection.",
    run() {
      const db = fresh();
      withEvents(db, () => {}, LIB);
      const stmt = db.prepare("INSERT INTO t VALUES (?, ?)");
      db.close();
      stmt.run(1, "a");
    },
  },

  "dispose-after-close": {
    code: 0,
    match: "ok",
    why:
      "dispose() must not unregister hooks on a connection the driver already freed.",
    run() {
      const db = fresh();
      const sub = withEvents(db, () => {}, LIB);
      db.close();
      // Churn the heap so a freed sqlite3* is likely to be reused memory.
      const junk: Uint8Array[] = [];
      for (let i = 0; i < 100_000; i++) {
        junk.push(new Uint8Array(64).fill(0xaa));
      }
      sub.dispose();
      console.log("ok", junk.length > 0);
    },
  },

  "dispose-twice": {
    code: 0,
    match: "ok",
    why: "The second close() of an UnsafeCallback threw BadResource.",
    run() {
      const db = fresh();
      const sub = withEvents(db, () => {}, LIB);
      sub.dispose();
      sub.dispose();
      console.log("ok", sub.disposed);
      db.close();
    },
  },

  "dispose-then-use": {
    code: 0,
    match: "ok 2",
    why: "After dispose the Database must still be a working Database.",
    run() {
      const db = fresh();
      const sub = withEvents(db, () => {}, LIB);
      db.exec("INSERT INTO t VALUES (1, 'a')");
      sub.dispose();
      db.exec("INSERT INTO t VALUES (2, 'b')");
      console.log(
        "ok",
        db.prepare("SELECT count(*) c FROM t").get<{ c: number }>()!.c,
      );
      db.close();
    },
  },

  "close-twice": {
    code: 0,
    match: "ok",
    why:
      "Our intercepted close() must stay a no-op the second time, like the driver's.",
    run() {
      const db = fresh();
      withEvents(db, () => {}, LIB);
      db.close();
      db.close();
      console.log("ok");
    },
  },

  "close-with-open-transaction": {
    code: 0,
    match: "rollback ok",
    why:
      "Closing mid-transaction used to run our rollback callback from inside sqlite3_close_v2.",
    run() {
      const db = fresh();
      let rolled = false;
      on(db, "rollback", () => {
        rolled = true;
      });
      db.exec("BEGIN");
      db.exec("INSERT INTO t VALUES (1, 'a')");
      db.close();
      console.log(rolled ? "rollback ok" : "NO ROLLBACK EVENT");
    },
  },

  "withevents-twice": {
    code: 0,
    match: "both ok",
    why:
      "SQLite keeps one commit hook per connection; a second registration used to clobber the first silently.",
    run() {
      const db = fresh();
      let a = 0, b = 0;
      // Braces matter: a bare `e.type === "postcommit" && a++` returns false
      // on the precommit event, which is a veto.
      withEvents(db, (e) => {
        if (e.type === "postcommit") a++;
      }, LIB);
      withEvents(db, (e) => {
        if (e.type === "postcommit") b++;
      }, LIB);
      db.exec("INSERT INTO t VALUES (1, 'a')");
      console.log(a === 1 && b === 1 ? "both ok" : `FAIL a=${a} b=${b}`);
      db.close();
    },
  },

  "withevents-twice-different-lib": {
    code: 1,
    match: "a second withEvents cannot open",
    why: "Two different libraries on one connection is the segfault recipe.",
    run() {
      const db = fresh();
      withEvents(db, () => {}, LIB);
      withEvents(db, () => {}, "/usr/lib/x86_64-linux-gnu/libz.so.1");
    },
  },

  "withevents-same-listener-twice": {
    code: 1,
    match: "already registered",
    why: "Otherwise one dispose() would leave the same listener half-attached.",
    run() {
      const db = fresh();
      const l = () => {};
      withEvents(db, l, LIB);
      withEvents(db, l, LIB);
    },
  },

  "withevents-conflicting-options": {
    code: 1,
    match: "options are per connection",
    why:
      "Options belong to the connection; a silent 'first one wins' is a trap.",
    run() {
      const db = fresh();
      withEvents(db, () => {}, LIB, { maxChangesPerTransaction: 10 });
      withEvents(db, () => {}, LIB, { maxChangesPerTransaction: 20 });
    },
  },

  "withevents-closed-db": {
    code: 1,
    match: "already closed",
    why: "Registering hooks on a freed sqlite3* is undefined behaviour.",
    run() {
      const db = fresh();
      db.close();
      withEvents(db, () => {}, LIB);
    },
  },

  "withevents-not-a-database": {
    code: 1,
    match: "must be a @db/sqlite Database",
    why: "A duck-typed pointer would be handed straight to dlopen'd C.",
    run() {
      // deno-lint-ignore project/no-type-assertion -- the point of the case is to hand withEvents what its types forbid, so the runtime guard is what gets tested.
      withEvents({ unsafeHandle: 1 } as never, () => {}, LIB);
    },
  },

  "withevents-not-a-listener": {
    code: 1,
    match: "listener must be a function",
    why: "The listener is called from inside an FFI callback.",
    run() {
      const db = fresh();
      // deno-lint-ignore project/no-type-assertion -- as above: the illegal argument IS the test.
      withEvents(db, "nope" as never, LIB);
    },
  },

  "libpath-empty": {
    code: 1,
    match: "It has no default",
    why: "A guessed default is exactly how the version mismatch happens.",
    run() {
      const db = fresh();
      withEvents(db, () => {}, "");
    },
  },

  "libpath-nonexistent": {
    code: 1,
    match: "Cannot use /nonexistent/nope.so as libsqlite3",
    why: "dlopen failure must be an Error, not a crash.",
    run() {
      const db = fresh();
      withEvents(db, () => {}, "/nonexistent/nope.so");
    },
  },

  "libpath-directory": {
    code: 1,
    match: "Cannot use /tmp as libsqlite3",
    why: "A directory reaches dlopen the same way a library does.",
    run() {
      const db = fresh();
      withEvents(db, () => {}, "/tmp");
    },
  },

  "libpath-not-a-library": {
    code: 1,
    match: "Cannot use",
    why: "A text file is 'too short' for the loader; the message must say so.",
    run() {
      const db = fresh();
      withEvents(db, () => {}, "/etc/hostname");
    },
  },

  "libpath-wrong-library": {
    code: 1,
    match: "undefined symbol: sqlite3_",
    why:
      "A real .so without the sqlite3 symbols must fail at dlopen, not at call time.",
    run() {
      const db = fresh();
      withEvents(db, () => {}, "/usr/lib/x86_64-linux-gnu/libz.so.1");
    },
  },

  "version-mismatch": {
    code: 1,
    match: "SQLite library mismatch",
    why:
      "The guard against dlopening a different build than the driver loaded — the documented SIGSEGV.",
    run() {
      const db = fresh();
      // Overriding the built-in makes the guard see a version that cannot match,
      // which is exactly what a driver on its own downloaded library looks like.
      db.function("sqlite_version", () => "0.0.0-not-your-build");
      withEvents(db, () => {}, LIB);
    },
  },

  "listener-throws-in-change": {
    code: 1,
    match: "boom in change",
    why:
      "An exception crossing the FFI boundary abandons SQLite mid-statement; it must surface from JS instead.",
    run() {
      const db = fresh();
      on(db, "change", () => {
        throw new Error("boom in change");
      });
      db.exec("INSERT INTO t VALUES (1, 'a')");
    },
  },

  "listener-throws-in-precommit": {
    code: 0,
    match: "vetoed, connection still usable",
    why:
      "A throw in precommit means veto; the connection must not be left inside a transaction.",
    run() {
      const db = fresh();
      let thrown = 0;
      withEvents(
        db,
        (e) => {
          if (e.type === "precommit" && thrown++ === 0) throw new Error("boom");
        },
        LIB,
        { onListenerError: () => {} },
      );
      try {
        db.exec("INSERT INTO t VALUES (1, 'a')");
      } catch {
        // the COMMIT was turned into a ROLLBACK
      }
      db.exec("BEGIN");
      db.exec("INSERT INTO t VALUES (2, 'b')");
      db.exec("COMMIT");
      const n = db.prepare("SELECT count(*) c FROM t").get<{ c: number }>()!.c;
      console.log(
        n === 1 ? "vetoed, connection still usable" : `FAIL rows=${n}`,
      );
      db.close();
    },
  },

  "listener-throws-in-postcommit": {
    code: 1,
    match: "boom in postcommit",
    why: "postcommit runs from JS, so its error must reach the caller.",
    run() {
      const db = fresh();
      on(db, "postcommit", () => {
        throw new Error("boom in postcommit");
      });
      db.exec("INSERT INTO t VALUES (1, 'a')");
    },
  },

  "listener-throws-in-rollback": {
    code: 1,
    match: "boom in rollback",
    why: "The rollback hook is FFI too.",
    run() {
      const db = fresh();
      on(db, "rollback", () => {
        throw new Error("boom in rollback");
      });
      db.exec("BEGIN");
      db.exec("INSERT INTO t VALUES (1, 'a')");
      db.exec("ROLLBACK");
      db.exec("SELECT 1"); // flush point
    },
  },

  "listener-errors-aggregate": {
    code: 1,
    match: "2 listener errors",
    why: "Two listeners failing must not lose one of the errors.",
    run() {
      const db = fresh();
      withEvents(db, (e) => {
        if (e.type === "postcommit") throw new Error("first");
      }, LIB);
      withEvents(db, (e) => {
        if (e.type === "postcommit") throw new Error("second");
      }, LIB);
      db.exec("INSERT INTO t VALUES (1, 'a')");
    },
  },

  "listener-error-handler": {
    code: 0,
    match: "handled 1",
    why: "onListenerError must swallow what would otherwise be thrown.",
    run() {
      const db = fresh();
      let handled = 0;
      withEvents(
        db,
        (e) => {
          if (e.type === "postcommit") throw new Error("nope");
        },
        LIB,
        {
          onListenerError: () => {
            handled++;
          },
        },
      );
      db.exec("INSERT INTO t VALUES (1, 'a')");
      console.log("handled", handled);
      db.close();
    },
  },

  "listener-writes-in-change": {
    code: 1,
    match: "from inside a hook listener",
    why:
      "A re-entrant write recurses into the same hook; SQLite forbids using the connection there.",
    run() {
      const db = fresh();
      on(db, "change", () => db.exec("INSERT INTO t VALUES (99, 'x')"));
      db.exec("INSERT INTO t VALUES (1, 'a')");
    },
  },

  "listener-reads-in-precommit": {
    code: 1,
    match: "from inside a hook listener",
    why:
      "sqlite3_prepare_v2/step 'modify their database connection' — reads are forbidden in hooks too.",
    run() {
      const db = fresh();
      on(db, "precommit", () => db.prepare("SELECT 1").get());
      db.exec("INSERT INTO t VALUES (1, 'a')");
    },
  },

  "listener-begins-transaction-in-change": {
    code: 1,
    match: "from inside a hook listener",
    why: "A nested BEGIN from inside a hook corrupts the transaction state.",
    run() {
      const db = fresh();
      on(db, "change", () => db.exec("BEGIN"));
      db.exec("INSERT INTO t VALUES (1, 'a')");
    },
  },

  "listener-reads-in-postcommit": {
    code: 0,
    match: "read 1",
    why: "postcommit is outside the hook, so the connection is usable there.",
    run() {
      const db = fresh();
      on(db, "postcommit", () => {
        console.log(
          "read",
          db.prepare("SELECT count(*) c FROM t").get<{ c: number }>()!.c,
        );
      });
      db.exec("INSERT INTO t VALUES (1, 'a')");
      db.close();
    },
  },

  "listener-writes-in-postcommit": {
    code: 0,
    match: "rows 3",
    why:
      "A write from postcommit re-enters our own wrapper and must not recurse without bound.",
    run() {
      const db = fresh();
      let n = 0;
      on(db, "postcommit", () => {
        if (n++ < 2) db.exec("INSERT INTO t VALUES (?, 'echo')", 100 + n);
      });
      db.exec("INSERT INTO t VALUES (1, 'a')");
      console.log(
        "rows",
        db.prepare("SELECT count(*) c FROM t").get<{ c: number }>()!.c,
      );
      db.close();
    },
  },

  "huge-batch": {
    code: 0,
    match: "truncated 200000 kept 1000",
    why: "One transaction must not be able to pin unbounded memory.",
    run() {
      const db = fresh();
      let line = "no postcommit";
      withEvents(
        db,
        (e) => {
          if (e.type === "postcommit" && e.changeCount > 1) {
            line = `${e.coverage} ${e.changeCount} kept ${e.changes.length}`;
          }
        },
        LIB,
        { maxChangesPerTransaction: 1000 },
      );
      const ins = db.prepare("INSERT INTO t VALUES (?, ?)");
      db.exec("BEGIN");
      for (let i = 0; i < 200_000; i++) ins.run(i, "x");
      db.exec("COMMIT");
      console.log(line);
      db.close();
    },
  },

  "rowid-i64-boundary": {
    code: 0,
    match: "9223372036854775807n -9223372036854775808n ok",
    why: "rowid is an i64: it must arrive as a bigint, not a lossy number.",
    run() {
      const db = fresh();
      const ids: bigint[] = [];
      on(db, "change", (e) => {
        if (e.type === "change") ids.push(e.change.rowid);
      });
      db.exec("INSERT INTO t VALUES (9223372036854775807, 'max')");
      db.exec("INSERT INTO t VALUES (-9223372036854775808, 'min')");
      console.log(
        ids[0],
        ids[1],
        ids.every((i) => typeof i === "bigint") ? "ok" : "FAIL not bigint",
      );
      db.close();
    },
  },

  "blob-write-autocommit": {
    code: 0,
    match: "coverage complete",
    why:
      "An incremental blob write never reaches update_hook. preupdate sees it, so the row is reported as an update instead of an empty 'unknown' batch.",
    run() {
      const db = new Database(":memory:");
      db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, b BLOB)");
      db.exec("INSERT INTO t VALUES (1, ?)", new Uint8Array(16));
      let seen = "no postcommit";
      on(db, "postcommit", (e) => {
        if (e.type === "postcommit") seen = `coverage ${e.coverage}`;
      });
      const blob = db.openBlob({
        table: "t",
        column: "b",
        row: 1,
        readonly: false,
      });
      blob.writeSync(0, new TextEncoder().encode("HELLO"));
      blob.close();
      console.log(seen);
      db.close();
    },
  },

  "blob-write-in-transaction": {
    code: 0,
    match: "coverage complete data HELLO",
    why: "Same write, batched behind an explicit COMMIT.",
    run() {
      const db = new Database(":memory:");
      db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, b BLOB)");
      db.exec("INSERT INTO t VALUES (1, ?)", new Uint8Array(16));
      let seen = "no postcommit";
      on(db, "postcommit", (e) => {
        if (e.type === "postcommit") seen = `coverage ${e.coverage}`;
      });
      db.exec("BEGIN");
      const blob = db.openBlob({
        table: "t",
        column: "b",
        row: 1,
        readonly: false,
      });
      blob.writeSync(0, new TextEncoder().encode("HELLO"));
      blob.close();
      db.exec("COMMIT");
      const data = new TextDecoder().decode(
        db.prepare("SELECT b FROM t WHERE id=1").value<[Uint8Array]>()!.at(0)!
          .slice(0, 5),
      );
      console.log(seen, "data", data);
      db.close();
    },
  },

  // ------------------------------------------------------------- preupdate

  "preupdate-values-outlive-the-callback": {
    code: 0,
    match: "retained ok",
    why:
      "THE use-after-free trap: a sqlite3_value* dies when the callback returns. Values are decoded eagerly into JS, so a listener that keeps the event and reads it much later — after churning the heap and running more statements — must see the same bytes, not freed memory.",
    run() {
      const db = new Database(":memory:");
      db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, s TEXT, b BLOB)");
      const kept: PreUpdate[] = [];
      withEvents(db, (e) => {
        if (e.type === "preupdate") kept.push(e); // deliberately retained
      }, LIB);
      db.exec(
        "INSERT INTO t VALUES (1, 'keep me', ?)",
        new Uint8Array([1, 2, 3, 4]),
      );
      // Everything that would reuse SQLite's freed memory if we had kept a
      // pointer: more statements, more rows, and a churned JS heap.
      const junk: Uint8Array[] = [];
      for (let i = 0; i < 50_000; i++) junk.push(new Uint8Array(64).fill(0xbb));
      const ins = db.prepare("INSERT INTO t VALUES (?, ?, ?)");
      for (let i = 2; i < 500; i++) {
        ins.run(i, `filler ${i}`, new Uint8Array(8));
      }
      db.exec("DELETE FROM t WHERE id > 1");
      db.exec("VACUUM");
      const first = kept[0]!;
      const s = first.new!.s;
      const b = bytes(first.new?.b);
      const ok = s === "keep me" && b instanceof Uint8Array &&
        [...b].join(",") === "1,2,3,4" && first.new!.id === 1n &&
        junk.length === 50_000;
      console.log(ok ? "retained ok" : `FAIL ${String(s)} ${b}`);
      db.close();
    },
  },

  "preupdate-blobwrite": {
    code: 0,
    match: "delete blobcol 1 old-len 8",
    why:
      "A blob write is reported as a DELETE carrying the row as it stands, flagged with the column being written.",
    run() {
      const db = new Database(":memory:");
      db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, b BLOB)");
      db.exec("INSERT INTO t VALUES (1, zeroblob(8))");
      let line = "no preupdate";
      withEvents(db, (e) => {
        if (e.type === "preupdate" && e.blobWriteColumn !== null) {
          line = `${e.op} blobcol ${e.blobWriteColumn} old-len ${
            bytes(e.old?.b).length
          }`;
        }
      }, LIB);
      const blob = db.openBlob({
        table: "t",
        column: "b",
        row: 1,
        readonly: false,
      });
      blob.writeSync(0, new TextEncoder().encode("HEY"));
      blob.close();
      console.log(line);
      db.close();
    },
  },

  "preupdate-i64-boundary": {
    code: 0,
    match: "9223372036854775807n -9223372036854775808n ok",
    why:
      "An INTEGER column is an i64 like the rowid, and arrives as a bigint whatever its magnitude.",
    run() {
      const db = new Database(":memory:");
      db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, n INTEGER)");
      const seen: unknown[] = [];
      withEvents(db, (e) => {
        if (e.type === "preupdate") seen.push(e.new!.n);
      }, LIB);
      db.exec("INSERT INTO t VALUES (1, 9223372036854775807)");
      db.exec("INSERT INTO t VALUES (2, -9223372036854775808)");
      db.exec("INSERT INTO t VALUES (3, 1)");
      console.log(
        seen[0],
        seen[1],
        seen.every((v) => typeof v === "bigint") ? "ok" : "FAIL not bigint",
      );
      db.close();
    },
  },

  "preupdate-listener-writes": {
    code: 1,
    match: "from inside a hook listener",
    why:
      "preupdate runs inside an FFI hook like the others: the connection is off limits there too.",
    run() {
      const db = fresh();
      withEvents(db, (e) => {
        if (e.type === "preupdate") db.exec("INSERT INTO t VALUES (99, 'x')");
      }, LIB);
      db.exec("INSERT INTO t VALUES (1, 'a')");
    },
  },

  "preupdate-off-fallback": {
    code: 0,
    match: "fallback ok",
    why:
      "preupdate is a compile-time option. With it unavailable the module must degrade to update_hook only, say so in `capabilities`, and never pretend the events will arrive.",
    run() {
      const db = fresh();
      let pre = 0, changes = 0;
      const sub = withEvents(
        db,
        (e) => {
          if (e.type === "preupdate") pre++;
          if (e.type === "change") changes++;
        },
        LIB,
        { preupdate: "off" },
      );
      db.exec("INSERT INTO t VALUES (1, 'a')");
      const c = sub.capabilities;
      console.log(
        pre === 0 && changes === 1 && c.preupdate === false &&
          c.hooks === true &&
          typeof c.preupdateUnavailable === "string"
          ? "fallback ok"
          : `FAIL pre=${pre} changes=${changes} ${JSON.stringify(c)}`,
      );
      db.close();
    },
  },

  "preupdate-required-but-unavailable": {
    code: 1,
    match: 'preupdate: "required" was asked for',
    why:
      "A caller who needs row values must be told at attach time, not left waiting for events that cannot come.",
    run() {
      const db = fresh();
      withEvents(db, () => {}, LIB, { preupdate: "off" });
      // Joins the existing registration, which has no preupdate API.
      withValidation(db, () => "no", LIB);
    },
  },

  "validation-veto-implicit-statement": {
    code: 1,
    match: "balance must not go negative",
    why:
      "The rejection reason must reach the caller, alongside SQLite's own generic 'constraint failed'.",
    run() {
      const db = new Database(":memory:");
      db.exec("CREATE TABLE acct(id INTEGER PRIMARY KEY, bal INTEGER)");
      withValidation(db, (row) => {
        const bal = row.new?.bal;
        if (typeof bal === "bigint" && bal < 0n) {
          return "balance must not go negative";
        }
        return undefined;
      }, LIB);
      db.exec("INSERT INTO acct VALUES (1, -5)");
    },
  },

  "validation-veto-keeps-the-connection-usable": {
    code: 0,
    match: "rows 1 constraint failed",
    why:
      "A vetoed implicit transaction rejects exactly that statement; the next one must still work.",
    run() {
      const db = new Database(":memory:");
      db.exec("CREATE TABLE acct(id INTEGER PRIMARY KEY, bal INTEGER)");
      withValidation(
        db,
        (row) => {
          const bal = row.new?.bal;
          if (typeof bal === "bigint" && bal < 0n) return "negative";
          return undefined;
        },
        LIB,
        { onListenerError: () => {} },
      );
      let sqlMessage = "";
      try {
        db.exec("INSERT INTO acct VALUES (1, -5)");
      } catch (e) {
        sqlMessage = message(e);
      }
      db.exec("INSERT INTO acct VALUES (2, 10)");
      console.log(
        "rows",
        db.prepare("SELECT count(*) c FROM acct").get<{ c: number }>()!.c,
        sqlMessage,
      );
      db.close();
    },
  },

  "validation-veto-rolls-back-whole-transaction": {
    code: 0,
    match: "rows 0 rollback 1",
    why:
      "The surprising half of the semantics: inside an explicit transaction one bad row discards the good ones too.",
    run() {
      const db = new Database(":memory:");
      db.exec("CREATE TABLE acct(id INTEGER PRIMARY KEY, bal INTEGER)");
      let rollbacks = 0;
      withValidation(
        db,
        (row) => {
          const bal = row.new?.bal;
          if (typeof bal === "bigint" && bal < 0n) return "negative";
          return undefined;
        },
        LIB,
        {
          onListenerError: () => {},
        },
      );
      withEvents(db, (e) => {
        if (e.type === "rollback") rollbacks++;
      }, LIB);
      db.exec("BEGIN");
      db.exec("INSERT INTO acct VALUES (1, 10)");
      db.exec("INSERT INTO acct VALUES (2, -1)");
      db.exec("INSERT INTO acct VALUES (3, 20)");
      try {
        db.exec("COMMIT");
      } catch { /* constraint failed */ }
      console.log(
        "rows",
        db.prepare("SELECT count(*) c FROM acct").get<{ c: number }>()!.c,
        "rollback",
        rollbacks,
      );
      db.close();
    },
  },

  "validation-validator-throws": {
    code: 0,
    match: "rejected: schema says no",
    why:
      "A validator that throws is refusing the row, not crashing the connection.",
    run() {
      const db = fresh();
      let reason = "not rejected";
      withValidation(
        db,
        () => {
          throw new Error("schema says no");
        },
        LIB,
        {
          onListenerError: (e) => {
            reason = `rejected: ${
              message(e).replace(/^.*validation: /, "").replace(
                / \(.*$/,
                "",
              )
            }`;
          },
        },
      );
      try {
        db.exec("INSERT INTO t VALUES (1, 'a')");
      } catch { /* constraint failed */ }
      console.log(reason);
      console.log(
        "rows",
        db.prepare("SELECT count(*) c FROM t").get<{ c: number }>()!.c,
      );
      db.close();
    },
  },

  "async-precommit-veto": {
    code: 1,
    match: "returned a Promise from precommit",
    why:
      "A never-settling Promise returned from inside SQLite's commit hook: the commit must be refused, and the process must neither segfault nor hang waiting on it.",
    run() {
      const db = fresh();
      on(db, "precommit", () => new Promise<boolean>(() => {}));
      db.exec("INSERT INTO t VALUES (1, 'a')");
      console.log("unreachable");
    },
  },

  "reentrant-hook-via-uninstrumented-statement": {
    code: 1,
    match: "a SQLite hook fired while another was running",
    why:
      "A statement prepared BEFORE withEvents is not instrumented, so calling it from a listener re-enters SQLite's hooks. This pins that the re-entry is refused and does not segfault; that nothing READS the row first is pinned by the semantic suite, which is the only place that difference is observable.",
    run() {
      const db = fresh();
      const uninstrumented = db.prepare("INSERT INTO t VALUES (99, 'x')");
      on(db, "change", () => {
        uninstrumented.run();
      });
      db.exec("INSERT INTO t VALUES (1, 'a')");
      console.log("survived");
    },
  },

  "wal-hook-lifetime": {
    code: 0,
    match: "survived",
    why:
      "The WAL hook is a fourth callback with its own library handle, and it checkpoints from inside itself. Drive a real checkpoint, then dispose while the connection is live, then close: a lifetime bug here frees a callback SQLite still holds.",
    run() {
      const dir = Deno.makeTempDirSync({ prefix: "reactive-sqlite-wal-" });
      const path = `${dir}/lifetime.db`;
      const db = new Database(path);
      db.exec("PRAGMA journal_mode=WAL");
      db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
      let wals = 0;
      const sub = withEvents(
        db,
        (e) => {
          if (e.type === "wal") wals++;
        },
        LIB,
        { walCheckpointThreshold: 8 },
      );
      const ins = db.prepare("INSERT INTO t VALUES (?, ?)");
      const filler = "x".repeat(2000);
      for (let i = 0; i < 400; i++) ins.run(i, filler);
      ins.finalize();
      sub.dispose();
      db.exec("INSERT INTO t VALUES (9999, 'after dispose')");
      db.close();
      console.log(wals > 0 ? "survived" : "FAIL no wal events");
    },
  },

  "trace-close-ordering": {
    code: 0,
    match: "survived",
    why:
      "SQLITE_TRACE_CLOSE only fires if the callback is still registered when sqlite3_close runs, and we deliberately unregister while the connection is alive. This pins that ordering: a future change that left the callback registered would be freeing something SQLite still holds.",
    run() {
      const db = fresh();
      let statements = 0;
      const sub = withEvents(
        db,
        (e) => {
          if (e.type === "statement") statements++;
        },
        LIB,
        { trace: ["statement", "profile", "row"] },
      );
      db.exec("INSERT INTO t VALUES (1, 'a')");
      db.prepare("SELECT * FROM t").all();
      sub.dispose();
      db.exec("INSERT INTO t VALUES (2, 'b')");
      db.close();
      console.log(statements > 0 ? "survived" : "FAIL no statement events");
    },
  },

  "progress-abort-then-teardown": {
    code: 0,
    match: "survived",
    why:
      "An interrupt unwinds SQLite mid-statement while our callback is on the stack, and the teardown then frees that callback. Abort, then dispose, then close, out of process.",
    run() {
      const db = fresh();
      db.exec("INSERT INTO t VALUES (1, 'a')");
      let ticks = 0;
      const sub = withEvents(
        db,
        (e) => {
          if (e.type === "progress") {
            ticks++;
            if (ticks > 2) e.abort();
          }
        },
        LIB,
        { progress: 100, onListenerError: () => {} },
      );
      try {
        db.prepare(
          "WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<300000) SELECT count(*) c FROM c",
        ).get();
      } catch { /* interrupted, which is the point */ }
      db.exec("INSERT INTO t VALUES (2, 'b')");
      sub.dispose();
      db.exec("INSERT INTO t VALUES (3, 'c')");
      db.close();
      console.log(ticks > 2 ? "survived" : "FAIL never ticked");
    },
  },

  "busy-retry-then-teardown": {
    code: 1,
    match: "database is locked",
    why:
      "A busy handler that retries blocks the thread inside a C callback. Contend for real, retry with delays, give up, then dispose and close. The characteristic failure here is a HANG, which the runner bounds and reports as a failure rather than waiting for.",
    run() {
      const dir = Deno.makeTempDirSync({ prefix: "reactive-sqlite-busy-" });
      const path = `${dir}/contended.db`;
      const held = new Database(path);
      held.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
      const other = new Database(path);
      held.exec("BEGIN IMMEDIATE");
      held.exec("INSERT INTO t VALUES (1, 'held')");
      let tries = 0;
      const sub = withEvents(
        other,
        (e) => {
          if (e.type === "busy") {
            tries = e.tries;
            if (e.tries < 4) e.retry(5);
            else e.giveUp();
          }
        },
        LIB,
        { busy: true, onListenerError: () => {} },
      );
      try {
        other.exec("INSERT INTO t VALUES (2, 'blocked')");
      } finally {
        console.log(`tried ${tries} times`);
        sub.dispose();
        held.exec("ROLLBACK");
        other.close();
        held.close();
      }
    },
  },

  "authorize-deny-then-teardown": {
    code: 0,
    match: "survived",
    why:
      "The authorizer fires during compilation, not from the bytecode engine, and a deny unwinds a prepare that is half built. Deny, then compile more, then dispose while live, then close.",
    run() {
      const db = fresh();
      db.exec("INSERT INTO t VALUES (1, 'a')");
      let denials = 0;
      const sub = withEvents(
        db,
        (e) => {
          if (e.type === "authorize" && e.action === "read" && e.arg2 === "v") {
            denials++;
            e.deny();
          }
        },
        LIB,
        { authorize: true, onListenerError: () => {} },
      );
      for (let i = 0; i < 50; i++) {
        try {
          db.prepare("SELECT v FROM t").finalize();
        } catch { /* denied, which is the point */ }
      }
      db.prepare("SELECT id FROM t").finalize();
      sub.dispose();
      db.prepare("SELECT v FROM t").finalize();
      db.close();
      console.log(denials > 0 ? "survived" : "FAIL never denied");
    },
  },

  "property-no-permutation-crashes": {
    code: 0,
    match: "survived",
    why:
      "The hard invariant: fast-check generates permutations of attach/dispose/close/transaction/veto/blob-write and no sequence may segfault. Judged on exit code, out of process, so a crash can never read as a pass.",
    run() {
      runHardProperty(HARD_RUNS);
    },
  },

  "no-dispose-still-exits": {
    code: 0,
    match: "done",
    why:
      "A live UnsafeCallback keeps the event loop alive; a forgotten dispose must not hang the process.",
    run() {
      const db = fresh();
      withEvents(db, () => {}, LIB);
      db.exec("INSERT INTO t VALUES (1, 'a')");
      console.log("done");
    },
  },
};

if (import.meta.main) {
  const name = Deno.args[0] ?? "";
  const c = CASES[name];
  if (!c) {
    console.error(
      `unknown case ${JSON.stringify(name)}. Known:\n  ${
        Object.keys(CASES).join("\n  ")
      }`,
    );
    Deno.exit(2);
  }
  c.run();
}
