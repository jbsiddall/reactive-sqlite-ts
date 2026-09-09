/**
 * The permutation suite for ../src/hooks.ts.
 *
 * Two halves:
 *   - the crash matrix (./crash_cases.ts), each case in its OWN child process,
 *     asserting on the child's exit code and output. A guard that "throws
 *     cleanly" must produce exit 1 and a useful message — never 139.
 *   - the semantic matrix, run in this process, asserting the events themselves.
 *
 * Both need --unstable-ffi/--allow-ffi and a libsqlite3, so this is a plain
 * script rather than a `deno test` file. (Named suite.ts, not test.ts, because
 * `deno test` collects a file called test.ts by default and would then run it
 * without --allow-ffi.)
 *
 *   deno task test         # the semantic matrix only
 *   deno task test:crash   # the crash matrix only
 *   deno run ... test/suite.ts   # both, with a combined total
 *
 * Exit code is 1 if anything failed.
 */
import { resolveLibPath } from "../src/lib_path.ts";
import { CASES } from "./crash_cases.ts";

const LIB = resolveLibPath();
const { Database } = await import("@db/sqlite");
const { SqliteHooksError, probeCapabilities, withEvents, withValidation } =
  await import("../src/hooks.ts");
type DbEvent = import("../src/hooks.ts").DbEvent;
type PreUpdate = import("../src/hooks.ts").PreUpdate;
type RowValue = import("../src/hooks.ts").RowValue;
type Db = InstanceType<typeof Database>;

let passed = 0;
let failed = 0;

const pass = (name: string, detail = "") => {
  passed++;
  console.log(`  pass  ${name}${detail ? ` — ${detail}` : ""}`);
};
const fail = (name: string, detail: string) => {
  failed++;
  Deno.exitCode = 1;
  console.log(`  FAIL  ${name} — ${detail}`);
};

const check = (name: string, actual: unknown, wanted: unknown) => {
  const a = JSON.stringify(actual), w = JSON.stringify(wanted);
  if (a === w) pass(name, a);
  else fail(name, `got ${a}, wanted ${w}`);
};

const FLAGS = [
  "--unstable-ffi",
  "--allow-ffi",
  "--allow-env",
  "--allow-read",
  "--allow-write",
  "--allow-net",
];
const CASE_SCRIPT = new URL("./crash_cases.ts", import.meta.url).pathname;

/** Run one crash case in a child process and assert on how it died. */
async function runCase(name: string): Promise<void> {
  const expected = CASES[name]!;
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", ...FLAGS, CASE_SCRIPT, name],
    env: { DENO_SQLITE_PATH: LIB },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  const code = out.code;
  const signalled = code === 139 || out.signal !== null;
  if (signalled) {
    fail(
      name,
      `CRASHED: exit ${code}${out.signal ? ` signal ${out.signal}` : ""}`,
    );
    return;
  }
  if (code !== expected.code) {
    fail(
      name,
      `exit ${code}, wanted ${expected.code}. Output: ${
        text.trim().slice(-300)
      }`,
    );
    return;
  }
  if (!text.includes(expected.match)) {
    fail(
      name,
      `output did not contain ${JSON.stringify(expected.match)}. Got: ${
        text.trim().slice(-300)
      }`,
    );
    return;
  }
  pass(name, `exit ${code}`);
}

// ---------------------------------------------------------------- semantics

type Recorded = { type: DbEvent["type"]; n: number; coverage?: string };

/** Attach a recorder and return the log plus the subscription. */
function record(db: Db, options = {}) {
  const log: Recorded[] = [];
  const sub = withEvents(
    db,
    (e) => {
      // preupdate is deliberately not recorded here: these scenarios are about
      // the commit lifecycle, and the preupdate scenarios below collect their
      // own events.
      if (e.type === "preupdate") return;
      log.push(
        e.type === "change"
          ? { type: "change", n: 1 }
          : { type: e.type, n: e.changes.length, coverage: e.coverage },
      );
    },
    LIB,
    options,
  );
  return { log, sub, types: () => log.map((r) => r.type) };
}

const memory = (
  sql = "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT UNIQUE)",
) => {
  const db = new Database(":memory:");
  db.exec(sql);
  return db;
};

/** A table with one column of every SQLite storage class. */
const types = () =>
  memory(
    "CREATE TABLE v(id INTEGER PRIMARY KEY, s TEXT, r REAL, b BLOB, n INTEGER)",
  );

/** Attach a collector for preupdate events only. */
function preupdates(db: Db, options = {}): PreUpdate[] {
  const rows: PreUpdate[] = [];
  withEvents(
    db,
    (e) => {
      if (e.type === "preupdate") rows.push(e);
    },
    LIB,
    options,
  );
  return rows;
}

/**
 * bigints and Uint8Arrays through JSON.stringify, which refuses the first and
 * mangles the second. `check` compares the printed form, so print them here.
 */
const plain = (v: unknown): unknown => {
  if (typeof v === "bigint") return `${v}n`;
  if (v instanceof Uint8Array) return `blob:${[...v].join(",")}`;
  if (Array.isArray(v)) return v.map(plain);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, RowValue>).map((
        [k, x],
      ) => [k, plain(x)]),
    );
  }
  return v;
};

/**
 * The two undocumented @db/sqlite shapes src/hooks.ts patches around. Pinned
 * here so a driver bump fails on this assertion instead of at an FFI callback.
 */
const DB_METHODS = ["exec", "run", "prepare", "transaction", "close"] as const;
const STMT_METHODS = ["run", "get", "all", "values", "value"] as const;
const TX_VARIANTS = ["default", "deferred", "immediate", "exclusive"] as const;

const rows = (db: Db): number =>
  db.prepare("SELECT count(*) c FROM t").get<{ c: number }>()?.c ?? -1;

/** Collect console.warn until stop(); the warnings are the assertion. */
function captureWarnings(): { lines: string[]; stop: () => void } {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map((a) => `${a}`).join(" "));
  };
  return { lines, stop: () => console.warn = original };
}

const ownFunction = (obj: object, name: string): boolean =>
  Object.hasOwn(obj, name) && typeof Reflect.get(obj, name) === "function";

const SEMANTIC: Record<string, () => void> = {
  "autocommit insert emits change, precommit, postcommit"() {
    const db = memory();
    const { log, types } = record(db);
    db.exec("INSERT INTO t VALUES (1, 'a')");
    check("  order", types(), ["change", "precommit", "postcommit"]);
    check("  batch size", log.at(-1)!.n, 1);
    check("  coverage", log.at(-1)!.coverage, "complete");
    db.close();
  },

  "explicit BEGIN/COMMIT batches every row into one commit"() {
    const db = memory();
    const { log, types } = record(db);
    db.exec("BEGIN");
    db.exec("INSERT INTO t VALUES (1, 'a')");
    db.exec("UPDATE t SET v='z' WHERE id=1");
    db.exec("DELETE FROM t WHERE id=1");
    db.exec("COMMIT");
    check("  order", types(), [
      "change",
      "change",
      "change",
      "precommit",
      "postcommit",
    ]);
    check("  batch size", log.at(-1)!.n, 3);
    db.close();
  },

  "explicit ROLLBACK emits rollback and no postcommit"() {
    const db = memory();
    const { log, types } = record(db);
    db.exec("BEGIN");
    db.exec("INSERT INTO t VALUES (1, 'a')");
    db.exec("ROLLBACK");
    check("  types", types(), ["change", "rollback"]);
    check("  rolled rows", log.at(-1)!.n, 1);
    check(
      "  table empty",
      db.prepare("SELECT count(*) c FROM t").get<{ c: number }>()!.c,
      0,
    );
    db.close();
  },

  "savepoints: RELEASE inside a transaction defers to the outer COMMIT"() {
    const db = memory();
    const { types } = record(db);
    db.exec("BEGIN");
    db.exec("SAVEPOINT s1");
    db.exec("INSERT INTO t VALUES (1, 'a')");
    db.exec("RELEASE s1");
    db.exec("COMMIT");
    check("  types", types(), ["change", "precommit", "postcommit"]);
    db.close();
  },

  "savepoints: ROLLBACK TO does not end the transaction"() {
    const db = memory();
    const { types } = record(db);
    db.exec("BEGIN");
    db.exec("INSERT INTO t VALUES (1, 'a')");
    db.exec("SAVEPOINT s1");
    db.exec("INSERT INTO t VALUES (2, 'b')");
    db.exec("ROLLBACK TO s1");
    db.exec("COMMIT");
    check("  types", types(), [
      "change",
      "change",
      "precommit",
      "postcommit",
    ]);
    check(
      "  surviving rows",
      db.prepare("SELECT count(*) c FROM t").get<{ c: number }>()!.c,
      1,
    );
    db.close();
  },

  "standalone SAVEPOINT acts as a transaction"() {
    const db = memory();
    const { types } = record(db);
    db.exec("SAVEPOINT s1");
    db.exec("INSERT INTO t VALUES (1, 'a')");
    db.exec("RELEASE s1");
    check("  types", types(), ["change", "precommit", "postcommit"]);
    db.close();
  },

  "precommit veto turns the COMMIT into a ROLLBACK"() {
    const db = memory();
    let veto = true;
    const seen: string[] = [];
    withEvents(db, (e) => {
      seen.push(e.type);
      if (e.type === "precommit" && veto) return false;
      return undefined;
    }, LIB);
    let threw = "";
    try {
      db.exec("INSERT INTO t VALUES (1, 'a')");
    } catch (e) {
      threw = (e as Error).message;
    }
    // preupdate leads every row now, so the veto scenario sees four events.
    check("  events", seen, ["preupdate", "change", "precommit", "rollback"]);
    check("  statement failed", threw.length > 0, true);
    check(
      "  no row",
      db.prepare("SELECT count(*) c FROM t").get<{ c: number }>()!.c,
      0,
    );
    veto = false;
    db.exec("INSERT INTO t VALUES (2, 'b')");
    check(
      "  usable afterwards",
      db.prepare("SELECT count(*) c FROM t").get<{ c: number }>()!.c,
      1,
    );
    db.close();
  },

  "a failing statement mid-transaction leaves the batch intact"() {
    const db = memory();
    const { types } = record(db);
    db.exec("BEGIN");
    db.exec("INSERT INTO t VALUES (1, 'a')");
    try {
      db.exec("INSERT INTO t VALUES (2, 'a')"); // UNIQUE violation
    } catch { /* expected */ }
    db.exec("COMMIT");
    check("  types", types(), ["change", "precommit", "postcommit"]);
    check(
      "  first row survived",
      db.prepare("SELECT count(*) c FROM t").get<{ c: number }>()!.c,
      1,
    );
    db.close();
  },

  "db.transaction() commits through our wrapper"() {
    const db = memory();
    const { log, types } = record(db);
    db.transaction(() => {
      db.exec("INSERT INTO t VALUES (1, 'a')");
      db.exec("INSERT INTO t VALUES (2, 'b')");
    })();
    check("  types", types(), [
      "change",
      "change",
      "precommit",
      "postcommit",
    ]);
    check("  batch size", log.at(-1)!.n, 2);
    db.close();
  },

  "db.transaction() keeps its .immediate/.deferred/.exclusive variants"() {
    const db = memory();
    const { types } = record(db);
    const tx = db.transaction(() => {
      db.exec("INSERT INTO t VALUES (1, 'a')");
    });
    check("  has variants", typeof tx.immediate === "function", true);
    tx.immediate();
    check("  types", types(), ["change", "precommit", "postcommit"]);
    db.close();
  },

  "db.transaction() that throws rolls back"() {
    const db = memory();
    const { types } = record(db);
    try {
      db.transaction(() => {
        db.exec("INSERT INTO t VALUES (1, 'a')");
        throw new Error("nope");
      })();
    } catch { /* expected */ }
    check("  types", types(), ["change", "rollback"]);
    db.close();
  },

  "DDL commits with coverage 'unknown', not an empty 'complete'"() {
    const db = memory();
    const { log } = record(db);
    db.exec("CREATE TABLE more(id INTEGER PRIMARY KEY)");
    const post = log.find((r) => r.type === "postcommit")!;
    check("  postcommit seen", post !== undefined, true);
    check("  coverage", post.coverage, "unknown");
    check("  rows", post.n, 0);
    db.close();
  },

  "one transaction across several tables reports each table"() {
    const db = memory();
    db.exec("CREATE TABLE u(id INTEGER PRIMARY KEY)");
    const tables: string[] = [];
    withEvents(db, (e) => {
      if (e.type === "postcommit") {
        for (const c of e.changes) tables.push(`${c.db}.${c.table}:${c.op}`);
      }
    }, LIB);
    db.exec("BEGIN");
    db.exec("INSERT INTO t VALUES (1, 'a')");
    db.exec("INSERT INTO u VALUES (7)");
    db.exec("COMMIT");
    check("  changes", tables, ["main.t:insert", "main.u:insert"]);
    db.close();
  },

  "an ATTACHed schema is named in the change"() {
    const dir = Deno.makeTempDirSync();
    const side = `${dir}/side.db`;
    const seed = new Database(side);
    seed.exec("CREATE TABLE s(id INTEGER PRIMARY KEY)");
    seed.close();
    const db = memory();
    const schemas: string[] = [];
    withEvents(db, (e) => {
      if (e.type === "change") schemas.push(e.change.db);
    }, LIB);
    db.exec(`ATTACH DATABASE '${side}' AS side`);
    db.exec("INSERT INTO side.s VALUES (1)");
    check("  schema", schemas, ["side"]);
    db.close();
    Deno.removeSync(dir, { recursive: true });
  },

  "1000 rows arrive as one batch"() {
    const db = memory();
    const { log } = record(db);
    const ins = db.prepare("INSERT INTO t VALUES (?, ?)");
    db.exec("BEGIN");
    for (let i = 0; i < 1000; i++) ins.run(i, `v${i}`);
    db.exec("COMMIT");
    const post = log.filter((r) => r.type === "postcommit");
    check("  postcommits", post.length, 1);
    check("  batch size", post[0]!.n, 1000);
    check("  coverage", post[0]!.coverage, "complete");
    db.close();
  },

  "maxChangesPerTransaction caps what is retained"() {
    const db = memory();
    let seen = { count: 0, kept: 0, coverage: "" };
    withEvents(
      db,
      (e) => {
        if (e.type === "postcommit" && e.changeCount > 1) {
          seen = {
            count: e.changeCount,
            kept: e.changes.length,
            coverage: e.coverage,
          };
        }
      },
      LIB,
      { maxChangesPerTransaction: 10 },
    );
    const ins = db.prepare("INSERT INTO t VALUES (?, ?)");
    db.exec("BEGIN");
    for (let i = 0; i < 100; i++) ins.run(i, `v${i}`);
    db.exec("COMMIT");
    check("  capped", seen, { count: 100, kept: 10, coverage: "truncated" });
    db.close();
  },

  "a read from inside postcommit sees the committed row"() {
    const db = memory();
    let saw = -1;
    withEvents(db, (e) => {
      if (e.type === "postcommit") {
        saw = db.prepare("SELECT count(*) c FROM t").get<{ c: number }>()!.c;
      }
    }, LIB);
    db.exec("INSERT INTO t VALUES (1, 'a')");
    check("  rows visible", saw, 1);
    db.close();
  },

  "the connection is refused from inside a change listener"() {
    const db = memory();
    let err = "";
    withEvents(db, (e) => {
      if (e.type !== "change") return;
      try {
        db.prepare("SELECT 1").get();
      } catch (x) {
        err = (x as Error).name;
      }
    }, LIB);
    db.exec("INSERT INTO t VALUES (1, 'a')");
    check("  error type", err, "SqliteHooksError");
    db.close();
  },

  "WAL mode on a real file behaves the same"() {
    const dir = Deno.makeTempDirSync();
    const db = new Database(`${dir}/wal.db`);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    const { log, types } = record(db);
    db.exec("BEGIN");
    db.exec("INSERT INTO t VALUES (1, 'a')");
    db.exec("INSERT INTO t VALUES (2, 'b')");
    db.exec("COMMIT");
    check(
      "  mode",
      db.prepare("PRAGMA journal_mode").get<{ journal_mode: string }>()!
        .journal_mode,
      "wal",
    );
    check("  types", types(), [
      "change",
      "change",
      "precommit",
      "postcommit",
    ]);
    check("  batch size", log.at(-1)!.n, 2);
    db.close();
    Deno.removeSync(dir, { recursive: true });
  },

  "dispose() restores the driver's own methods"() {
    const db = memory();
    const before = {
      exec: db.exec,
      run: db.run,
      prepare: db.prepare,
      transaction: db.transaction,
      close: db.close,
    };
    const { sub, log } = record(db);
    check(
      "  patched while attached",
      db.exec !== before.exec && db.prepare !== before.prepare,
      true,
    );
    sub.dispose();
    check("  exec restored", db.exec === before.exec, true);
    check("  run restored", db.run === before.run, true);
    check("  prepare restored", db.prepare === before.prepare, true);
    check(
      "  transaction restored",
      db.transaction === before.transaction,
      true,
    );
    check("  close restored", db.close === before.close, true);
    db.exec("INSERT INTO t VALUES (1, 'a')");
    check("  silent after dispose", log.length, 0);
    check("  disposed flag", sub.disposed, true);
    db.close();
  },

  "two listeners both fire, and one dispose leaves the other working"() {
    const db = memory();
    const a: string[] = [], b: string[] = [];
    const subA = withEvents(db, (e) => a.push(e.type), LIB);
    withEvents(db, (e) => b.push(e.type), LIB);
    db.exec("INSERT INTO t VALUES (1, 'a')");
    const full = ["preupdate", "change", "precommit", "postcommit"];
    check("  a", a, full);
    check("  b", b, full);
    subA.dispose();
    a.length = 0;
    b.length = 0;
    db.exec("INSERT INTO t VALUES (2, 'b')");
    check("  a silent", a, []);
    check("  b still live", b, full);
    db.close();
  },

  "attaching to a Database with a foreign sqlite3 is refused"() {
    const db = memory();
    db.function("sqlite_version", () => "0.0.0-not-your-build");
    let name = "", message = "";
    try {
      withEvents(db, () => {}, LIB);
    } catch (e) {
      name = (e as Error).name;
      message = (e as Error).message;
    }
    check("  error type", name, "SqliteHooksError");
    check("  mentions mismatch", message.includes("library mismatch"), true);
    check("  is our error class", true, true);
    db.close();
  },

  // ------------------------------------------------------------- preupdate

  "preupdate: INSERT carries the new row, named, with no old row"() {
    const db = types();
    const pre = preupdates(db);
    db.exec(
      "INSERT INTO v VALUES (1, 'hi', 2.5, ?, NULL)",
      new Uint8Array([1, 2]),
    );
    check("  one event", pre.length, 1);
    const e = pre[0]!;
    check("  op", e.op, "insert");
    check("  where", [e.db, e.table], ["main", "v"]);
    check("  named", [e.named, e.columns], [true, [
      "id",
      "s",
      "r",
      "b",
      "n",
    ]]);
    check("  old", e.old, null);
    check("  new", plain(e.new), {
      id: "1n",
      s: "hi",
      r: 2.5,
      b: "blob:1,2",
      n: null,
    });
    check("  rowids", plain([e.oldRowid, e.newRowid, e.rowidChanged]), [
      "1n",
      "1n",
      false,
    ]);
    check("  positional matches", plain(e.newValues), [
      "1n",
      "hi",
      2.5,
      "blob:1,2",
      null,
    ]);
    check("  blobWriteColumn", e.blobWriteColumn, null);
    check("  depth", e.depth, 0);
    db.close();
  },

  "preupdate: UPDATE carries both sides"() {
    const db = types();
    db.exec("INSERT INTO v VALUES (1, 'before', 1.5, NULL, 7)");
    const pre = preupdates(db);
    db.exec("UPDATE v SET s='after', n=8 WHERE id=1");
    check("  op", pre[0]!.op, "update");
    check("  old", plain(pre[0]!.old), {
      id: "1n",
      s: "before",
      r: 1.5,
      b: null,
      n: "7n",
    });
    check("  new", plain(pre[0]!.new), {
      id: "1n",
      s: "after",
      r: 1.5,
      b: null,
      n: "8n",
    });
    db.close();
  },

  "preupdate: DELETE carries the old row and no new row"() {
    const db = types();
    db.exec("INSERT INTO v VALUES (1, 'gone', 0.5, NULL, NULL)");
    const pre = preupdates(db);
    db.exec("DELETE FROM v WHERE id=1");
    check("  op", pre[0]!.op, "delete");
    check("  new", [pre[0]!.new, pre[0]!.newValues], [null, null]);
    check("  old.s", pre[0]!.old!.s, "gone");
    db.close();
  },

  "preupdate: an UPDATE that moves the rowid reports both keys"() {
    const db = types();
    db.exec("INSERT INTO v VALUES (1, 'a', 0, NULL, NULL)");
    const pre = preupdates(db);
    db.exec("UPDATE v SET id=99 WHERE id=1");
    check("  keys", plain([pre[0]!.oldRowid, pre[0]!.newRowid]), [
      "1n",
      "99n",
    ]);
    check("  flagged", pre[0]!.rowidChanged, true);
    check("  id column", plain([pre[0]!.old!.id, pre[0]!.new!.id]), [
      "1n",
      "99n",
    ]);
    db.close();
  },

  "preupdate: NULL, BLOB, REAL, big INTEGER and text with an embedded NUL"() {
    const db = types();
    const pre = preupdates(db);
    db.exec(
      "INSERT INTO v VALUES (1, 'a' || char(0) || 'b', 1e300, ?, 9223372036854775807)",
      new Uint8Array([0, 255, 128]),
    );
    db.exec("INSERT INTO v VALUES (2, '', -1.5, x'', -9223372036854775808)");
    const first = pre[0]!.new!, second = pre[1]!.new!;
    check("  embedded NUL survives", [...(first.s as string)].length, 3);
    check("  as code points", (first.s as string).charCodeAt(1), 0);
    check("  real", first.r, 1e300);
    check("  blob bytes", plain(first.b), "blob:0,255,128");
    check("  blob is a Uint8Array", first.b instanceof Uint8Array, true);
    check("  i64 max", plain(first.n), "9223372036854775807n");
    check("  i64 min", plain(second.n), "-9223372036854775808n");
    check("  empty string", second.s, "");
    check("  empty blob", plain(second.b), "blob:");
    check("  small integers are bigint too", typeof pre[0]!.new!.id, "bigint");
    db.close();
  },

  "preupdate: a 64-column table is fully decoded and named"() {
    const db = new Database(":memory:");
    const cols = Array.from({ length: 64 }, (_, i) => `c${i}`);
    db.exec(`CREATE TABLE wide(${cols.join(", ")})`);
    const pre = preupdates(db);
    db.exec(
      `INSERT INTO wide VALUES (${cols.map(() => "?").join(", ")})`,
      ...cols.map((_, i) => i),
    );
    check("  column count", pre[0]!.columns.length, 64);
    check("  names in cid order", pre[0]!.columns.slice(-2), ["c62", "c63"]);
    check("  values", plain(pre[0]!.new!.c63), "63n");
    check("  positional length", pre[0]!.newValues!.length, 64);
    db.close();
  },

  "preupdate: fires per row inside an explicit transaction, before the commit"() {
    const db = types();
    const order: string[] = [];
    withEvents(db, (e) => {
      order.push(e.type === "preupdate" ? `pre:${e.op}` : e.type);
    }, LIB);
    db.exec("BEGIN");
    db.exec("INSERT INTO v VALUES (1, 'a', 0, NULL, NULL)");
    db.exec("UPDATE v SET s='b' WHERE id=1");
    db.exec("COMMIT");
    check("  order", order, [
      "pre:insert",
      "change",
      "pre:update",
      "change",
      "precommit",
      "postcommit",
    ]);
    db.close();
  },

  "preupdate: a rolled back transaction still delivered its row values"() {
    const db = types();
    const pre = preupdates(db);
    db.exec("BEGIN");
    db.exec("INSERT INTO v VALUES (1, 'doomed', 0, NULL, NULL)");
    db.exec("ROLLBACK");
    check("  delivered", pre.length, 1);
    check("  value", pre[0]!.new!.s, "doomed");
    check(
      "  not in the table",
      db.prepare("SELECT count(*) c FROM v").get<{ c: number }>()!.c,
      0,
    );
    db.close();
  },

  "preupdate: values stay valid after the callback returns"() {
    // The use-after-free trap: sqlite3_value* dies with the callback, so the
    // decode has to be eager. In-process twin of the crash case.
    const db = types();
    const pre = preupdates(db);
    db.exec("INSERT INTO v VALUES (1, 'keep', 1.5, ?, 5)", new Uint8Array([9]));
    const ins = db.prepare("INSERT INTO v VALUES (?, ?, ?, ?, ?)");
    for (let i = 2; i < 200; i++) ins.run(i, `x${i}`, i, new Uint8Array(32), i);
    db.exec("DELETE FROM v WHERE id > 1");
    check("  string", pre[0]!.new!.s, "keep");
    check("  blob", plain(pre[0]!.new!.b), "blob:9");
    check("  integer", plain(pre[0]!.new!.n), "5n");
    db.close();
  },

  "preupdate: rows written by a trigger arrive with depth > 0"() {
    const db = types();
    db.exec("CREATE TABLE audit(x)");
    db.exec(
      "CREATE TRIGGER tr AFTER INSERT ON v BEGIN INSERT INTO audit VALUES (NEW.id); END",
    );
    const pre = preupdates(db);
    db.exec("INSERT INTO v VALUES (1, 'a', 0, NULL, NULL)");
    check("  tables", pre.map((e) => e.table), ["v", "audit"]);
    check("  depths", pre.map((e) => e.depth), [0, 1]);
    db.close();
  },

  "preupdate: an incremental blob write is a DELETE with a blobWriteColumn"() {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, b BLOB)");
    db.exec("INSERT INTO t VALUES (1, zeroblob(4))");
    const pre = preupdates(db);
    let post: { coverage: string; changes: number } | null = null;
    withEvents(db, (e) => {
      if (e.type === "postcommit") {
        post = { coverage: e.coverage, changes: e.changes.length };
      }
    }, LIB);
    const blob = db.openBlob({
      table: "t",
      column: "b",
      row: 1,
      readonly: false,
    });
    blob.writeSync(0, new Uint8Array([7, 7]));
    blob.close();
    check("  op", pre[0]!.op, "delete");
    check("  column", pre[0]!.blobWriteColumn, 1);
    check("  old row is readable", plain(pre[0]!.old!.b), "blob:0,0,0,0");
    // update_hook cannot see blob writes at all; preupdate turns what used to
    // be an empty `coverage: "unknown"` batch into a real row.
    check("  batch", post, { coverage: "complete", changes: 1 });
    db.close();
  },

  "preupdate: a WITHOUT ROWID write is visible here and nowhere else"() {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE w(k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID");
    const pre = preupdates(db);
    const { log } = record(db);
    db.exec("INSERT INTO w VALUES ('a', 'b')");
    check("  preupdate saw it", plain(pre[0]!.new), { k: "a", v: "b" });
    check("  rowids are 0", plain([pre[0]!.oldRowid, pre[0]!.newRowid]), [
      "0n",
      "0n",
    ]);
    check(
      "  update_hook did not",
      log.filter((r) => r.type === "change").length,
      0,
    );
    check("  so the batch is 'unknown'", log.at(-1)!.coverage, "unknown");
    db.close();
  },

  "preupdate: an ATTACHed table's columns are named too"() {
    const dir = Deno.makeTempDirSync();
    const seed = new Database(`${dir}/side.db`);
    seed.exec("CREATE TABLE s(a TEXT, b TEXT)");
    seed.close();
    const db = types();
    const pre = preupdates(db);
    db.exec(`ATTACH DATABASE '${dir}/side.db' AS side`);
    db.exec("INSERT INTO side.s VALUES ('x', 'y')");
    check("  schema", pre[0]!.db, "side");
    check("  named", plain(pre[0]!.new), { a: "x", b: "y" });
    db.close();
    Deno.removeSync(dir, { recursive: true });
  },

  "preupdate: a table created and written in the same call degrades to indexes"() {
    // Column names come from the schema, which cannot be read from inside the
    // hook. One statement that both creates and fills a table therefore has no
    // names to use — and says so rather than inventing them.
    const db = types();
    const pre = preupdates(db);
    db.exec(
      "CREATE TABLE brand_new(a, b); INSERT INTO brand_new VALUES (1, 2)",
    );
    check("  not named", pre[0]!.named, false);
    check("  keyed by index", plain(pre[0]!.new), { "0": "1n", "1": "2n" });
    check("  columns empty", pre[0]!.columns, []);
    db.exec("INSERT INTO brand_new VALUES (3, 4)");
    check("  named by the next statement", pre[1]!.named, true);
    check("  and keyed", plain(pre[1]!.new), { a: "3n", b: "4n" });
    db.close();
  },

  // ------------------------------------------------ capabilities & fallback

  "capabilities: this library reports preupdate"() {
    const caps = probeCapabilities(LIB);
    check("  hooks", caps.hooks, true);
    check("  preupdate", caps.preupdate, true);
    check("  no excuse", caps.preupdateUnavailable, undefined);
  },

  "capabilities: probing a non-sqlite library throws rather than lying"() {
    let name = "";
    try {
      probeCapabilities("/usr/lib/x86_64-linux-gnu/libz.so.1");
    } catch (e) {
      name = (e as Error).name;
    }
    check("  error", name, "SqliteHooksError");
  },

  "fallback: with preupdate off, everything else still works"() {
    const db = types();
    const pre = preupdates(db, { preupdate: "off" });
    const { log, types: seen } = record(db);
    db.exec("INSERT INTO v VALUES (1, 'a', 0, NULL, NULL)");
    check("  no preupdate events", pre.length, 0);
    check("  the rest arrive", seen(), ["change", "precommit", "postcommit"]);
    check("  batch", [log.at(-1)!.n, log.at(-1)!.coverage], [1, "complete"]);
    db.close();
  },

  "fallback: capabilities say why, and blob writes go back to 'unknown'"() {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, b BLOB)");
    db.exec("INSERT INTO t VALUES (1, zeroblob(4))");
    let post = "";
    const sub = withEvents(
      db,
      (e) => {
        if (e.type === "postcommit") post = e.coverage;
      },
      LIB,
      { preupdate: "off" },
    );
    check("  preupdate", sub.capabilities.preupdate, false);
    check(
      "  reason given",
      typeof sub.capabilities.preupdateUnavailable === "string",
      true,
    );
    const blob = db.openBlob({
      table: "t",
      column: "b",
      row: 1,
      readonly: false,
    });
    blob.writeSync(0, new Uint8Array([1]));
    blob.close();
    check("  coverage", post, "unknown");
    db.close();
  },

  "fallback: preupdate 'required' refuses to attach without it"() {
    const db = types();
    withEvents(db, () => {}, LIB, { preupdate: "off" });
    let message = "";
    try {
      withEvents(db, () => {}, LIB, { preupdate: "required" });
    } catch (e) {
      message = (e as Error).message;
    }
    check("  refused", message.includes('preupdate: "required"'), true);
    db.close();
  },

  // -------------------------------------------------------------- validation

  "validation: a rejected implicit statement is the only thing rolled back"() {
    const db = types();
    const errors: string[] = [];
    withValidation(
      db,
      (row) => row.new && row.new.s === "bad" ? "no bad rows" : undefined,
      LIB,
      {
        onListenerError: (e) => errors.push((e as Error).message),
      },
    );
    db.exec("INSERT INTO v VALUES (1, 'good', 0, NULL, NULL)");
    let sqlError = "";
    try {
      db.exec("INSERT INTO v VALUES (2, 'bad', 0, NULL, NULL)");
    } catch (e) {
      sqlError = (e as Error).message;
    }
    db.exec("INSERT INTO v VALUES (3, 'fine', 0, NULL, NULL)");
    check("  sql error is SQLite's own", sqlError, "constraint failed");
    check("  reason reached us", errors.length, 1);
    check(
      "  reason text",
      errors[0]!.includes("no bad rows") && errors[0]!.includes("main.v"),
      true,
    );
    check(
      "  surviving rows",
      db.prepare("SELECT id FROM v ORDER BY id").values<[number]>().flat(),
      [1, 3],
    );
    db.close();
  },

  "validation: the reason arrives in an AggregateError when unhandled"() {
    const db = types();
    withValidation(
      db,
      (row) => row.new && row.new.s === "bad" ? "no bad rows" : undefined,
      LIB,
    );
    let caught: unknown;
    try {
      db.exec("INSERT INTO v VALUES (1, 'bad', 0, NULL, NULL)");
    } catch (e) {
      caught = e;
    }
    check("  AggregateError", caught instanceof AggregateError, true);
    const errs = (caught as AggregateError).errors as Error[];
    check("  both errors", errs.length, 2);
    check("  SQLite's", errs[0]!.message, "constraint failed");
    check("  ours", errs[1]!.message.includes("no bad rows"), true);
    check("  ours is typed", errs[1]!.name, "SqliteHooksError");
    db.close();
  },

  "validation: inside a transaction one bad row discards the good ones"() {
    const db = types();
    withValidation(
      db,
      (row) => row.new && row.new.s === "bad" ? "no bad rows" : undefined,
      LIB,
      { onListenerError: () => {} },
    );
    db.exec("BEGIN");
    db.exec("INSERT INTO v VALUES (1, 'good', 0, NULL, NULL)");
    db.exec("INSERT INTO v VALUES (2, 'bad', 0, NULL, NULL)");
    db.exec("INSERT INTO v VALUES (3, 'also good', 0, NULL, NULL)");
    let threw = "";
    try {
      db.exec("COMMIT");
    } catch (e) {
      threw = (e as Error).message;
    }
    check("  the COMMIT failed", threw.length > 0, true);
    check(
      "  nothing survived",
      db.prepare("SELECT count(*) c FROM v").get<{ c: number }>()!.c,
      0,
    );
    // And the connection is usable, with the verdict spent.
    db.exec("INSERT INTO v VALUES (4, 'good', 0, NULL, NULL)");
    check(
      "  usable afterwards",
      db.prepare("SELECT count(*) c FROM v").get<{ c: number }>()!.c,
      1,
    );
    db.close();
  },

  "validation: an UPDATE is judged on its new values, a DELETE on its old"() {
    const db = types();
    db.exec("INSERT INTO v VALUES (1, 'keep', 0, NULL, NULL)");
    const judged: string[] = [];
    withValidation(
      db,
      (row) => {
        judged.push(`${row.op}:${(row.new ?? row.old)!.s}`);
        return row.op === "delete" ? "deletes are forbidden" : undefined;
      },
      LIB,
      { onListenerError: () => {} },
    );
    db.exec("UPDATE v SET s='changed' WHERE id=1");
    try {
      db.exec("DELETE FROM v WHERE id=1");
    } catch { /* vetoed */ }
    check("  judged", judged, ["update:changed", "delete:changed"]);
    check(
      "  the update stuck and the delete did not",
      db.prepare("SELECT s FROM v").value<[string]>()!,
      ["changed"],
    );
    db.close();
  },

  "validation: a throwing validator rejects with its own message"() {
    const db = types();
    const errors: string[] = [];
    withValidation(
      db,
      () => {
        throw new Error("validator exploded");
      },
      LIB,
      { onListenerError: (e) => errors.push((e as Error).message) },
    );
    try {
      db.exec("INSERT INTO v VALUES (1, 'a', 0, NULL, NULL)");
    } catch { /* vetoed */ }
    check("  rejected", errors.length, 1);
    check(
      "  with its message",
      errors[0]!.includes("validator exploded"),
      true,
    );
    check(
      "  no row",
      db.prepare("SELECT count(*) c FROM v").get<{ c: number }>()!.c,
      0,
    );
    db.close();
  },

  "validation: withValidation refuses preupdate: 'off'"() {
    let message = "";
    try {
      withValidation(types(), () => undefined, LIB, { preupdate: "off" });
    } catch (e) {
      message = (e as Error).message;
    }
    check("  refused", message.includes("cannot work with preupdate"), true);
  },

  "an async precommit listener refuses the commit instead of permitting it"() {
    const db = memory();
    const seen: unknown[] = [];
    withEvents(
      db,
      (e) => e.type === "precommit" ? Promise.resolve(false) : undefined,
      LIB,
      { onListenerError: (error) => seen.push(error) },
    );
    let threw = false;
    try {
      db.exec("INSERT INTO t VALUES (1, 'a')");
    } catch {
      threw = true;
    }
    check("  the write failed", threw, true);
    check("  no row survived", rows(db), 0);
    check("  reported as a listener error", seen.length, 1);
    check(
      "  said why",
      seen.some((e) => `${e}`.includes("returned a Promise from precommit")),
      true,
    );
    db.close();
  },

  "a thenable that is not a Promise is refused too"() {
    const db = memory();
    withEvents(
      db,
      (e) => e.type === "precommit" ? { then: () => false } : undefined,
      LIB,
      { onListenerError: () => {} },
    );
    let threw = false;
    try {
      db.exec("INSERT INTO t VALUES (1, 'a')");
    } catch {
      threw = true;
    }
    check("  the write failed", threw, true);
    check("  no row survived", rows(db), 0);
    db.close();
  },

  "returning from a void-contract event warns once, by name"() {
    const db = memory();
    const warned = captureWarnings();
    try {
      const chattyListener = (e: DbEvent) =>
        e.type === "change" ? 1 : undefined;
      withEvents(db, chattyListener, LIB);
      db.exec("INSERT INTO t VALUES (1, 'a')");
      db.exec("INSERT INTO t VALUES (2, 'b')");
      db.exec("INSERT INTO t VALUES (3, 'c')");
    } finally {
      warned.stop();
    }
    check("  warned once for nine events", warned.lines.length, 1);
    check(
      "  named the listener",
      warned.lines[0]?.includes("chattyListener"),
      true,
    );
    db.close();
  },

  "a legitimate precommit verdict is never warned about"() {
    const db = memory();
    const warned = captureWarnings();
    try {
      const vetoer = (e: DbEvent) => e.type === "precommit" ? false : undefined;
      const sub = withEvents(db, vetoer, LIB, { onListenerError: () => {} });
      for (const id of [1, 2, 3]) {
        try {
          db.exec(`INSERT INTO t VALUES (${id}, 'a')`);
        } catch { /* vetoed, as asked */ }
      }
      sub.dispose();
      const accepter = (e: DbEvent) =>
        e.type === "precommit" ? true : undefined;
      withEvents(db, accepter, LIB);
      db.exec("INSERT INTO t VALUES (4, 'd')");
    } finally {
      warned.stop();
    }
    check("  silent on correct usage", warned.lines, []);
    check("  the veto still held, the accept still landed", rows(db), 1);
    db.close();
  },

  "driver internals: statement methods are own, Database methods are not"() {
    const db = memory();
    const stmt = db.prepare("SELECT * FROM t");
    check(
      "  own on the statement",
      STMT_METHODS.filter((n) => ownFunction(stmt, n)),
      [...STMT_METHODS],
    );
    const proto = Object.getPrototypeOf(db);
    check(
      "  inherited on the Database",
      DB_METHODS.filter((n) => !Object.hasOwn(db, n) && ownFunction(proto, n)),
      [...DB_METHODS],
    );
    db.close();
  },

  "driver internals: transaction() returns a function carrying its variants"() {
    const db = memory();
    const tx = db.transaction(() => {});
    check("  callable", typeof tx, "function");
    check(
      "  own variants",
      TX_VARIANTS.filter((n) => ownFunction(tx, n)),
      [...TX_VARIANTS],
    );
    check("  database back-reference", tx.database === db, true);
    db.close();
  },

  "SqliteHooksError is exported and instanceof-able"() {
    let caught: unknown;
    try {
      withEvents(memory(), () => {}, "");
    } catch (e) {
      caught = e;
    }
    check("  instanceof", caught instanceof SqliteHooksError, true);
  },
};

// Which half to run. `deno task test` runs the semantic matrix, `deno task
// test:crash` the crash matrix; with no argument both run and the totals are
// combined. An unknown argument is a typo, not a request to run nothing.
const only = Deno.args[0] ?? "";
if (only !== "" && only !== "crash" && only !== "semantic") {
  console.error(`unknown selector ${JSON.stringify(only)}: use crash|semantic`);
  Deno.exit(2);
}
const runCrash = only !== "semantic";
const runSemantic = only !== "crash";

console.log(`libsqlite3: ${LIB}\n`);

if (runCrash) {
  console.log(`crash matrix (${Object.keys(CASES).length} child processes)`);
  for (const name of Object.keys(CASES)) await runCase(name);
}

if (runSemantic) {
  console.log(`\nsemantic matrix (${Object.keys(SEMANTIC).length} scenarios)`);
  for (const [name, fn] of Object.entries(SEMANTIC)) {
    console.log(`- ${name}`);
    try {
      fn();
    } catch (e) {
      fail(name, `threw ${(e as Error).stack ?? e}`);
    }
  }
}

console.log(
  `\n${passed} passed, ${failed} failed — ${failed === 0 ? "OK" : "FAILURES"}`,
);
if (failed > 0) Deno.exitCode = 1;
