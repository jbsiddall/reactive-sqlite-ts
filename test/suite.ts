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
import { PROPERTIES, PROPERTY_RUNS, PROPERTY_SEED } from "./properties.ts";

const LIB = resolveLibPath();
const { Database } = await import("@db/sqlite");
const {
  actionFor,
  opFor,
  probeCapabilities,
  SqliteHooksError,
  withEvents,
  withValidation,
} = await import("../src/hooks.ts");
const { formatEvent, jsonReplacer } = await import("../src/format.ts");
const { openFfiBackend } = await import("../src/backend_ffi.ts");
type DbEvent = import("../src/hooks.ts").DbEvent;
type PreUpdate = import("../src/hooks.ts").PreUpdate;
type RowValue = import("../src/hooks.ts").RowValue;
type Change = import("../src/hooks.ts").Change;
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
/** Generous enough for the slowest legitimate case, short enough to catch a hang. */
const CASE_TIMEOUT_MS = 60_000;

/** Run one crash case in a child process and assert on how it died. */
async function runCase(name: string): Promise<void> {
  const expected = CASES[name]!;
  // Bounded, because a HANG is a real failure mode here — a busy handler that
  // retries without end never returns, and an unbounded await would make the
  // suite hang with it rather than report it.
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", ...FLAGS, CASE_SCRIPT, name],
    env: { DENO_SQLITE_PATH: LIB },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch { /* already gone */ }
  }, CASE_TIMEOUT_MS);
  const out = await child.output();
  clearTimeout(killer);
  // Keyed on the timer, not on the signal: a SIGKILL from anywhere else — an
  // OOM kill, say — is a crash and must be diagnosed as one.
  if (timedOut) {
    fail(name, `HUNG: still running after ${CASE_TIMEOUT_MS}ms`);
    return;
  }
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
      if (
        e.type === "preupdate" || e.type === "wal" ||
        e.type === "statement" || e.type === "profile" || e.type === "row" ||
        e.type === "progress" || e.type === "busy" ||
        e.type === "authorize"
      ) return;
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
      Object.entries(v).map((
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

const msg = (e: unknown): string => e instanceof Error ? e.message : String(e);

const name_ = (e: unknown): string => e instanceof Error ? e.name : typeof e;

const WAL_DIR = Deno.makeTempDirSync({ prefix: "reactive-sqlite-wal-" });

const removeDb = (path: string) => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      Deno.removeSync(path + suffix);
    } catch { /* already gone */ }
  }
};

/** A real file, because WAL mode needs one. */
const walDb = (name: string): { db: Db; path: string } => {
  const path = `${WAL_DIR}/${name}.db`;
  removeDb(path);
  const db = new Database(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
  return { db, path };
};

const walBytes = (path: string): number => {
  try {
    return Deno.statSync(`${path}-wal`).size;
  } catch {
    return 0;
  }
};

/** Enough commits of enough bytes to cross the default 1000-frame threshold. */
const fill = (db: Db, n: number) => {
  const ins = db.prepare("INSERT INTO t VALUES (?, ?)");
  const filler = "x".repeat(2000);
  try {
    for (let i = 0; i < n; i++) ins.run(i, filler);
  } finally {
    ins.finalize();
  }
};

/** Two connections to one file, with the first holding a write lock. */
function contended(): { held: Db; other: Db; path: string } {
  const path = `${WAL_DIR}/busy-${contendedSeq++}.db`;
  removeDb(path);
  const held = new Database(path);
  held.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
  const other = new Database(path);
  held.exec("BEGIN IMMEDIATE");
  held.exec("INSERT INTO t VALUES (1, 'held')");
  return { held, other, path };
}
let contendedSeq = 0;

/** A statement long enough that a progress handler can actually reach it. */
const HEAVY_ROWS = 300_000;
const HEAVY =
  `WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<${HEAVY_ROWS}) SELECT count(*) c FROM c`;

const liveHandle = (db: Db): Deno.PointerObject => {
  const h = db.unsafeHandle;
  if (h === null) throw new Error("the Database has no sqlite3 handle");
  return h;
};

/** A checked read: in a test a wrong storage class is a failure, not a cast. */
const text = (v: unknown): string => {
  if (typeof v === "string") return v;
  throw new Error(`expected text, got ${Deno.inspect(v)}`);
};

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
      threw = msg(e);
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
        err = name_(x);
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
      name = name_(e);
      message = msg(e);
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
    check("  embedded NUL survives", [...text(first.s)].length, 3);
    check("  as code points", text(first.s).charCodeAt(1), 0);
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
      name = name_(e);
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
      message = msg(e);
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
        onListenerError: (e) => errors.push(msg(e)),
      },
    );
    db.exec("INSERT INTO v VALUES (1, 'good', 0, NULL, NULL)");
    let sqlError = "";
    try {
      db.exec("INSERT INTO v VALUES (2, 'bad', 0, NULL, NULL)");
    } catch (e) {
      sqlError = msg(e);
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
    const errs: Error[] = caught instanceof AggregateError
      ? caught.errors.map((e) => e instanceof Error ? e : new Error(String(e)))
      : [];
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
      threw = msg(e);
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
      { onListenerError: (e) => errors.push(msg(e)) },
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
      message = msg(e);
    }
    check("  refused", message.includes("cannot work with preupdate"), true);
  },

  "column names survive schema and table names that would collide under a separator"() {
    // "x: y"+"z" and "x"+" y:z" are the same string under any single ":" join.
    const db = new Database(":memory:");
    db.exec(`ATTACH ':memory:' AS "x: y"`);
    db.exec(`CREATE TABLE "x: y"."z" (alpha INTEGER)`);
    db.exec(`ATTACH ':memory:' AS "x"`);
    db.exec(`CREATE TABLE "x"." y:z" (beta INTEGER)`);
    const rows = preupdates(db);
    db.exec(`INSERT INTO "x: y"."z" VALUES (1)`);
    db.exec(`INSERT INTO "x"." y:z" VALUES (2)`);
    check(
      "  each pair kept its own columns",
      rows.map((r) => [r.db, r.table, [...r.columns]]),
      [["x: y", "z", ["alpha"]], ["x", " y:z", ["beta"]]],
    );
    db.close();
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

  "formatEvent round-trips a rowid past 2^53 and a blob"() {
    const db = types();
    const pre = preupdates(db);
    // 2^53 + 1: the first integer a number-if-safe serialiser would round.
    db.exec(
      "INSERT INTO v VALUES (9007199254740993, 'a', 1.5, x'00ff80', 42)",
    );
    const row = pre[0];
    if (row === undefined) {
      fail("formatEvent round-trip", "no preupdate event");
      db.close();
      return;
    }
    const event: DbEvent = { type: "preupdate", ...row };

    let plainThrew = "";
    try {
      JSON.stringify(event);
    } catch (e) {
      plainThrew = name_(e);
    }
    check("  JSON.stringify alone throws", plainThrew, "TypeError");

    const text = formatEvent(event);
    const seen = JSON.parse(text);
    check("  parses back", typeof seen === "object" && seen !== null, true);
    check("  rowid exact, as digits", `${seen.newRowid}`, "9007199254740993");
    check(
      "  and not rounded",
      `${seen.newRowid}` === `${Number(9007199254740993)}`,
      false,
    );
    check("  blob is readable", `${seen.new.b}`, "x'00ff80'");
    check("  text is untouched", `${seen.new.s}`, "a");
    check("  real is untouched", seen.new.r, 1.5);
    db.close();
  },

  "jsonReplacer works with a caller's own JSON.stringify"() {
    const db = memory();
    const events: DbEvent[] = [];
    withEvents(db, (e) => void events.push(e), LIB, { preupdate: "off" });
    db.exec("INSERT INTO t VALUES (9007199254740993, 'a')");
    const change = events.find((e) => e.type === "change");
    check("  a change arrived", change !== undefined, true);
    const text = JSON.stringify(change, jsonReplacer, 2);
    const seen = JSON.parse(text);
    check("  valid JSON", typeof seen, "object");
    check("  rowid exact", `${seen.change.rowid}`, "9007199254740993");
    db.close();
  },

  "the backend hands over an UNREAD row, so a caller's guards run first"() {
    // The re-entrancy guard must be able to reject a callback without SQLite
    // having been touched at all. A row handed over already-decoded would mean
    // the accessors had run before the guard could say no.
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v)");
    const backend = openFfiBackend(LIB, liveHandle(db), "required");
    let handed = 0;
    let readRows = 0;
    let table = "";
    const at = backend.attach({
      update: () => {},
      preupdate: (read) => {
        handed++;
        if (handed > 1) return; // the second row is deliberately never read
        readRows++;
        table = read().table;
      },
      commit: () => false,
      rollback: () => {},
      wal: () => {},
      trace: () => {},
      progress: () => false,
      busy: () => false,
      authorize: () => 0,
      fail: () => {},
    }, {
      walCheckpointThreshold: null,
      trace: [],
      traceSql: "statement",
      progressOps: null,
      busy: false,
      authorize: false,
    });
    db.exec("INSERT INTO t VALUES (1, 'a')");
    db.exec("INSERT INTO t VALUES (2, 'b')");
    check("  both rows handed over", handed, 2);
    check("  only one was read", readRows, 1);
    check("  and reading gave the row", table, "t");
    at.detach(true);
    db.close();
  },

  "a backend is released once, whichever path gets there"() {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY)");
    const closedTwice = openFfiBackend(LIB, liveHandle(db), "auto");
    closedTwice.close();
    closedTwice.close();
    check("  close() twice", true, true);

    const detachedThenClosed = openFfiBackend(LIB, liveHandle(db), "auto");
    const at = detachedThenClosed.attach({
      update: () => {},
      preupdate: () => {},
      commit: () => false,
      rollback: () => {},
      wal: () => {},
      trace: () => {},
      progress: () => false,
      busy: () => false,
      authorize: () => 0,
      fail: () => {},
    }, {
      walCheckpointThreshold: null,
      trace: [],
      traceSql: "statement",
      progressOps: null,
      busy: false,
      authorize: false,
    });
    at.detach(true);
    detachedThenClosed.close();
    check("  close() after detach()", true, true);
    db.close();
  },

  "detaching twice is safe"() {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY)");
    const backend = openFfiBackend(LIB, liveHandle(db), "auto");
    const at = backend.attach({
      update: () => {},
      preupdate: () => {},
      commit: () => false,
      rollback: () => {},
      wal: () => {},
      trace: () => {},
      progress: () => false,
      busy: () => false,
      authorize: () => 0,
      fail: () => {},
    }, {
      walCheckpointThreshold: null,
      trace: [],
      traceSql: "statement",
      progressOps: null,
      busy: false,
      authorize: false,
    });
    at.detach(true);
    at.detach(true);
    check("  survived a second detach", true, true);
    db.close();
  },

  "a WAL commit emits a wal event with the database and frame count"() {
    const { db, path } = walDb("wal-event");
    const seen: Array<{ db: string; frames: number }> = [];
    withEvents(db, (e) => {
      if (e.type === "wal") seen.push({ db: e.db, frames: e.frames });
    }, LIB);
    db.exec("INSERT INTO t VALUES (1, 'a')");
    db.exec("INSERT INTO t VALUES (2, 'b')");
    check("  one per commit", seen.length, 2);
    check("  the schema name", seen.map((w) => w.db), ["main", "main"]);
    check(
      "  frames climb",
      (seen[1]?.frames ?? 0) > (seen[0]?.frames ?? 0),
      true,
    );
    db.close();
    removeDb(path);
  },

  "no wal event in rollback-journal mode"() {
    const db = memory();
    let wals = 0;
    withEvents(db, (e) => {
      if (e.type === "wal") wals++;
    }, LIB);
    db.exec("INSERT INTO t VALUES (1, 'a')");
    check("  none", wals, 0);
    db.close();
  },

  "attaching preserves auto-checkpointing"() {
    // The bar: after installing our hook the WAL must behave as it did before,
    // except that events now arrive. Our hook displaces SQLite's, which IS
    // auto-checkpointing, so without replicating it the file grows unbounded.
    const control = walDb("wal-control");
    fill(control.db, 1500);
    const controlSize = walBytes(control.path);
    control.db.close();
    removeDb(control.path);

    const ours = walDb("wal-preserve");
    withEvents(ours.db, () => {}, LIB);
    fill(ours.db, 1500);
    const oursSize = walBytes(ours.path);
    ours.db.close();
    removeDb(ours.path);

    check("  the control checkpointed", controlSize > 0, true);
    check(
      "  and so did we, within a checkpoint's worth",
      oursSize <= controlSize * 2,
      true,
    );
  },

  "checkpoint: 'caller' hands the job over, and the WAL grows"() {
    const ours = walDb("wal-caller");
    withEvents(ours.db, () => {}, LIB, { checkpoint: "caller" });
    fill(ours.db, 1500);
    const size = walBytes(ours.path);
    ours.db.close();
    removeDb(ours.path);

    const control = walDb("wal-caller-control");
    fill(control.db, 1500);
    const controlSize = walBytes(control.path);
    control.db.close();
    removeDb(control.path);
    check("  nobody checkpointed", size > controlSize * 2, true);
  },

  "PRAGMA wal_autocheckpoint while attached is detected and reported"() {
    const { db, path } = walDb("wal-displaced");
    const errs: string[] = [];
    let wals = 0;
    withEvents(
      db,
      (e) => {
        if (e.type === "wal") wals++;
      },
      LIB,
      { onListenerError: (e) => errs.push(msg(e)) },
    );
    db.exec("INSERT INTO t VALUES (1, 'a')");
    const before = wals;
    db.exec("PRAGMA wal_autocheckpoint=1000");
    db.exec("INSERT INTO t VALUES (2, 'b')");
    check("  events stopped", wals, before);
    check(
      "  and we said so",
      errs.some((e) => e.includes("removes ours")),
      true,
    );
    db.close();
    removeDb(path);
  },

  "a thenable from a wal listener fails closed, and a return warns once"() {
    // The shared dispatch already does this. Asserted here anyway, because
    // "the shared path handles it" is the assumption that stops being true
    // when another callback path is added.
    const veto = walDb("wal-thenable");
    const warnedAbout = captureWarnings();
    try {
      withEvents(
        veto.db,
        (e) => e.type === "wal" ? Promise.resolve(false) : undefined,
        LIB,
      );
      veto.db.exec("INSERT INTO t VALUES (1, 'a')");
    } finally {
      warnedAbout.stop();
    }
    // wal is a void contract, so "fails closed" means the thenable can never
    // be mistaken for a verdict: it is warned about and the commit stands.
    check(
      "  the thenable was warned about, not obeyed",
      warnedAbout.lines.some((l) => l.includes('from a "wal" event')),
      true,
    );
    check("  the commit still landed", rows(veto.db), 1);
    veto.db.close();
    removeDb(veto.path);

    const warned = captureWarnings();
    const chatty = walDb("wal-warn");
    try {
      const walListener = (e: DbEvent) => e.type === "wal" ? 1 : undefined;
      withEvents(chatty.db, walListener, LIB);
      for (let i = 0; i < 3; i++) {
        chatty.db.exec(`INSERT INTO t VALUES (${i}, 'a')`);
      }
    } finally {
      warned.stop();
    }
    check("  warned once for three commits", warned.lines.length, 1);
    check(
      "  named the listener",
      warned.lines[0]?.includes("walListener"),
      true,
    );
    chatty.db.close();
    removeDb(chatty.path);
  },

  "trace: statement and profile events, with the unexpanded SQL"() {
    const db = memory();
    const seen: string[] = [];
    withEvents(
      db,
      (e) => {
        if (e.type === "statement") seen.push(`stmt ${e.sql}`);
        if (e.type === "profile") seen.push(`profile ${e.nanos >= 0n}`);
      },
      LIB,
      { trace: true },
    );
    const ins = db.prepare("INSERT INTO t VALUES (?, ?)");
    ins.run(1, "secret-value");
    ins.finalize();
    check(
      "  the parameter stayed a placeholder",
      seen.some((l) => l === "stmt INSERT INTO t VALUES (?, ?)"),
      true,
    );
    check(
      "  nothing leaked the value",
      seen.some((l) => l.includes("secret-value")),
      false,
    );
    check(
      "  and it was profiled",
      seen.some((l) => l === "profile true"),
      true,
    );
    db.close();
  },

  "trace: row is off unless asked for"() {
    const db = memory();
    db.exec("INSERT INTO t VALUES (1, 'a')");
    db.exec("INSERT INTO t VALUES (2, 'b')");
    let rowsDefault = 0;
    const a = withEvents(
      db,
      (e) => {
        if (e.type === "row") rowsDefault++;
      },
      LIB,
      { trace: true },
    );
    db.prepare("SELECT * FROM t").all();
    a.dispose();
    check("  not in the default mask", rowsDefault, 0);

    let rowsAsked = 0;
    withEvents(
      db,
      (e) => {
        if (e.type === "row") rowsAsked++;
      },
      LIB,
      { trace: ["row"] },
    );
    db.prepare("SELECT * FROM t").all();
    check("  one per result row when asked", rowsAsked, 2);
    db.close();
  },

  "trace: with-parameter-values inlines what statement mode hides"() {
    const db = memory();
    const seen: string[] = [];
    withEvents(
      db,
      (e) => {
        if (e.type === "statement") seen.push(e.sql);
      },
      LIB,
      { trace: ["statement"], sql: "with-parameter-values" },
    );
    const ins = db.prepare("INSERT INTO t VALUES (?, ?)");
    ins.run(1, "hunter2");
    ins.finalize();
    check(
      "  the bound value is in the log, by explicit request",
      seen.some((l) => l.includes("'hunter2'")),
      true,
    );
    db.close();
  },

  "trace: normalized is refused rather than downgraded when absent"() {
    const caps = probeCapabilities(LIB);
    if (caps.normalizedSql) {
      const db = memory();
      const seen: string[] = [];
      withEvents(
        db,
        (e) => {
          if (e.type === "statement") seen.push(e.sql);
        },
        LIB,
        { trace: ["statement"], sql: "normalized" },
      );
      // An inline literal, which "statement" would log verbatim.
      db.exec("INSERT INTO t VALUES (1, 'inline-secret')");
      check(
        "  the inline literal was scrubbed",
        seen.some((l) => l.includes("inline-secret")),
        false,
      );
      check(
        "  and a placeholder is there",
        seen.some((l) => l.includes("?")),
        true,
      );
      db.close();
    } else {
      let message = "";
      try {
        withEvents(memory(), () => {}, LIB, {
          trace: ["statement"],
          sql: "normalized",
        });
      } catch (e) {
        message = msg(e);
      }
      check(
        "  refused, naming the compile flag",
        message.includes("SQLITE_ENABLE_NORMALIZE"),
        true,
      );
      console.log(
        `  SKIP  normalized-sql behaviour — ${LIB} lacks SQLITE_ENABLE_NORMALIZE`,
      );
    }
  },

  "trace: statement mode does NOT hide a literal written inline"() {
    // The finding that makes "normalized" the only private mode: the default
    // protects bound parameters, and nothing else.
    const db = memory();
    const seen: string[] = [];
    withEvents(
      db,
      (e) => {
        if (e.type === "statement") seen.push(e.sql);
      },
      LIB,
      { trace: ["statement"] },
    );
    db.exec("INSERT INTO t VALUES (1, 'inline-secret')");
    check(
      "  an inline literal is logged verbatim",
      seen.some((l) => l.includes("inline-secret")),
      true,
    );
    db.close();
  },

  "trace: displacement is detected, and these shapes are not false positives"() {
    const db = memory();
    const errs: string[] = [];
    withEvents(db, () => {}, LIB, {
      trace: true,
      onListenerError: (e) => errs.push(msg(e)),
    });
    // Every shape that legitimately produces no STMT trace. None of them may
    // be mistaken for displacement, which is why detection keys on a COMMIT.
    db.exec("");
    db.exec("-- just a comment");
    db.exec("   ");
    try {
      db.exec("SELEC 1");
    } catch { /* fails to prepare, so never traces */ }
    db.exec("INSERT INTO t VALUES (1, 'a')");
    db.exec("INSERT INTO t VALUES (2, 'b')");
    check("  no false positive", errs.length, 0);
    db.close();
  },

  "a thenable from a trace listener can never be a verdict"() {
    const db = memory();
    const warned = captureWarnings();
    try {
      const tracer = (e: DbEvent) =>
        e.type === "statement" ? Promise.resolve(false) : undefined;
      withEvents(db, tracer, LIB, { trace: ["statement"] });
      for (let i = 0; i < 3; i++) {
        db.exec(`INSERT INTO t VALUES (${i}, 'v${i}')`);
      }
    } finally {
      warned.stop();
    }
    check(
      "  warned once, by name",
      warned.lines.length === 1 &&
        (warned.lines[0]?.includes("tracer") ?? false),
      true,
    );
    check("  and nothing was vetoed", rows(db), 3);
    db.close();
  },

  "progress: abort() interrupts a long statement"() {
    const db = memory();
    const reported: string[] = [];
    let ticks = 0;
    const aborter = (e: DbEvent) => {
      if (e.type === "progress") {
        ticks++;
        if (ticks > 2) e.abort();
      }
      return undefined;
    };
    withEvents(db, aborter, LIB, {
      progress: 100,
      onListenerError: (e) => reported.push(msg(e)),
    });
    let threw = "";
    try {
      db.prepare(HEAVY).get();
    } catch (e) {
      threw = msg(e);
    }
    check("  the statement was interrupted", threw, "interrupted");
    check("  and it ticked first", ticks > 2, true);
    check(
      "  and the abort was reported, naming the listener",
      reported.some((e) => e.includes("aborter") && e.includes("abort()")),
      true,
    );
    db.close();
  },

  "progress: abort() inside a transaction discards the whole transaction"() {
    const db = memory();
    let armed = false;
    withEvents(
      db,
      (e) => {
        if (e.type === "progress" && armed) e.abort();
      },
      LIB,
      { progress: 100, onListenerError: () => {} },
    );
    db.exec("BEGIN");
    db.exec("INSERT INTO t VALUES (1, 'before the abort')");
    armed = true;
    try {
      // A WRITE: aborting a read inside a transaction leaves it intact, but
      // aborting a write takes the whole transaction with it.
      db.exec(
        `INSERT INTO t(v) SELECT 'x' || i FROM (WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<${HEAVY_ROWS}) SELECT i FROM c)`,
      );
    } catch { /* interrupted */ }
    armed = false;
    let commit = "";
    try {
      db.exec("COMMIT");
    } catch (e) {
      commit = msg(e);
    }
    check(
      "  the transaction is already gone",
      commit.includes("no transaction is active"),
      true,
    );
    check("  and the pre-abort row went with it", rows(db), 0);
    check("  the connection still works", rows(db) === 0, true);
    db.close();
  },

  "progress: a statement that finishes first cannot be aborted"() {
    // nOps is a granularity, not a deadline.
    const db = memory();
    db.exec("INSERT INTO t VALUES (1, 'a')");
    withEvents(
      db,
      (e) => {
        if (e.type === "progress") e.abort();
      },
      LIB,
      { progress: 1_000_000, onListenerError: () => {} },
    );
    let value = -1;
    let threw = "";
    try {
      value = db.prepare("SELECT count(*) c FROM t").get<{ c: number }>()?.c ??
        -1;
    } catch (e) {
      threw = msg(e);
    }
    check("  it completed", threw, "");
    check("  with the right answer", value, 1);
    db.close();
  },

  "progress: a stashed abort() interrupts nothing and is reported"() {
    const db = memory();
    const errs: string[] = [];
    const stashed: Array<() => void> = [];
    const stasher = (e: DbEvent) => {
      if (e.type === "progress" && stashed.length === 0) stashed.push(e.abort);
      return undefined;
    };
    withEvents(db, stasher, LIB, {
      progress: 1000,
      onListenerError: (e) => errs.push(msg(e)),
    });
    let value = 0;
    let threw = "";
    try {
      value = db.prepare(HEAVY).get<{ c: number }>()?.c ?? 0;
    } catch (e) {
      threw = msg(e);
    }
    check("  the statement completed", threw, "");
    check("  with the right answer", value, HEAVY_ROWS);
    const late = stashed[0];
    check("  we captured one", late !== undefined, true);
    late?.();
    db.exec("SELECT 1"); // a boundary, so queued listener errors are flushed
    check(
      "  and calling it late is reported, not swallowed",
      errs.some((e) => e.includes("interrupted nothing")),
      true,
    );
    db.close();
  },

  "progress: nothing but a live abort() can interrupt"() {
    // A thenable, a truthy return and a throw must all leave the query alone.
    // Only precommit has a verdict; here even an exception must not interrupt,
    // because the failure mode is a discarded transaction.
    for (
      const [label, listener] of [
        ["a thenable", () => Promise.resolve(true)],
        ["a truthy value", () => 1],
        ["a throw", () => {
          throw new Error("from the progress listener");
        }],
      ] as const
    ) {
      const db = memory();
      const errs: string[] = [];
      const warned = captureWarnings();
      let value = 0;
      let threw = "";
      try {
        withEvents(
          db,
          (e) => e.type === "progress" ? listener() : undefined,
          LIB,
          {
            progress: 100,
            onListenerError: (e) => errs.push(msg(e)),
          },
        );
        value = db.prepare(HEAVY).get<{ c: number }>()?.c ?? 0;
      } catch (e) {
        threw = msg(e);
      } finally {
        warned.stop();
      }
      check(`  ${label}: the query completed`, threw, "");
      check(`  ${label}: with the right answer`, value, HEAVY_ROWS);
      db.close();
    }
  },

  "progress: a returning listener warns once, by name"() {
    const db = memory();
    const warned = captureWarnings();
    try {
      const ticker = (e: DbEvent) => e.type === "progress" ? 1 : undefined;
      withEvents(db, ticker, LIB, { progress: 100 });
      db.prepare(HEAVY).get();
    } finally {
      warned.stop();
    }
    check("  warned once", warned.lines.length, 1);
    check("  named the listener", warned.lines[0]?.includes("ticker"), true);
    db.close();
  },

  "progress: ticks arrive from inside prepare(), not only from step()"() {
    // Since SQLite 3.41.0 the handler can fire while prepare() analyses a
    // complex query. We instrument prepare(), so that dispatch happens from
    // inside our own wrapper — a path no other hook has.
    const db = memory();
    let duringPrepare = 0;
    let preparing = false;
    withEvents(
      db,
      (e) => {
        if (e.type === "progress" && preparing) duringPrepare++;
      },
      LIB,
      { progress: 1 },
    );
    preparing = true;
    const stmt = db.prepare(HEAVY);
    preparing = false;
    stmt.finalize();
    const version = db.prepare("SELECT sqlite_version() v").get<{ v: string }>()
      ?.v ?? "?";
    if (duringPrepare > 0) {
      check("  prepare() ticked", duringPrepare > 0, true);
    } else {
      console.log(
        `  SKIP  progress during prepare() — SQLite ${version} did not tick while preparing`,
      );
    }
    check("  and nothing crashed", true, true);
    db.close();
  },

  "busy: nothing but retry() waits, and doing nothing gives up"() {
    // A thenable, a truthy value, a throw and an empty listener must all end
    // in SQLITE_BUSY. Passing a return value through would spin forever.
    for (
      const [label, listener] of [
        ["a thenable", () => Promise.resolve(true)],
        ["a truthy value", () => 1],
        ["a throw", () => {
          throw new Error("from the busy listener");
        }],
        ["no decision", () => undefined],
      ] as const
    ) {
      const { held, other, path } = contended();
      let outcome = "";
      const started = performance.now();
      withEvents(
        other,
        (e) => e.type === "busy" ? listener() : undefined,
        LIB,
        {
          busy: true,
          onListenerError: () => {},
        },
      );
      try {
        other.exec("INSERT INTO t VALUES (2, 'from the other connection')");
      } catch (e) {
        outcome = msg(e);
      }
      const elapsed = performance.now() - started;
      check(
        `  ${label}: the caller got SQLITE_BUSY`,
        outcome,
        "database is locked",
      );
      check(`  ${label}: and it did not spin`, elapsed < 1000, true);
      held.exec("ROLLBACK");
      other.close();
      held.close();
      removeDb(path);
    }
  },

  "busy: retry() actually waits, and giving up is distinguishable"() {
    const { held, other, path } = contended();
    const errs: string[] = [];
    let tries = 0;
    withEvents(
      other,
      (e) => {
        if (e.type === "busy") {
          tries = e.tries;
          if (e.tries < 3) e.retry(20);
          else e.giveUp();
        }
      },
      LIB,
      { busy: true, onListenerError: (e) => errs.push(msg(e)) },
    );
    const started = performance.now();
    let outcome = "";
    try {
      other.exec("INSERT INTO t VALUES (2, 'from the other connection')");
    } catch (e) {
      outcome = msg(e);
    }
    const elapsed = performance.now() - started;
    check("  it retried three times", tries, 3);
    check("  and actually slept between them", elapsed >= 55, true);
    check("  before giving up", outcome, "database is locked");
    check(
      "  giveUp() is not reported as an unhandled event",
      errs.some((e) => e.includes("no listener called retry()")),
      false,
    );
    held.exec("ROLLBACK");
    other.close();
    held.close();
    removeDb(path);
  },

  "busy: doing nothing is reported, so it does not look like a decision"() {
    const { held, other, path } = contended();
    const errs: string[] = [];
    withEvents(other, () => {}, LIB, {
      busy: true,
      onListenerError: (e) => errs.push(msg(e)),
    });
    try {
      other.exec("INSERT INTO t VALUES (2, 'x')");
    } catch { /* SQLITE_BUSY, as expected */ }
    check(
      "  the silence was reported",
      errs.some((e) => e.includes("no listener called retry() or giveUp()")),
      true,
    );
    held.exec("ROLLBACK");
    other.close();
    held.close();
    removeDb(path);
  },

  "busy: a stashed retry() decides nothing and is reported"() {
    const { held, other, path } = contended();
    const errs: string[] = [];
    const stashed: Array<(ms: number) => void> = [];
    withEvents(
      other,
      (e) => {
        if (e.type === "busy" && stashed.length === 0) stashed.push(e.retry);
      },
      LIB,
      { busy: true, onListenerError: (e) => errs.push(msg(e)) },
    );
    try {
      other.exec("INSERT INTO t VALUES (2, 'x')");
    } catch { /* SQLITE_BUSY */ }
    const late = stashed[0];
    check("  we captured one", late !== undefined, true);
    late?.(5);
    other.exec("SELECT 1"); // a boundary, so queued listener errors flush
    check(
      "  calling it late decided nothing and was reported",
      errs.some((e) => e.includes("decided nothing")),
      true,
    );
    held.exec("ROLLBACK");
    other.close();
    held.close();
    removeDb(path);
  },

  "busy: touching the connection from a busy listener is refused"() {
    // SQLite permits it here, uniquely among the hooks. This library refuses
    // it anyway, because one exception to "no hook may touch the connection"
    // would make the guarantee hold for four callbacks and stop at the fifth.
    const { held, other, path } = contended();
    const errs: string[] = [];
    withEvents(
      other,
      (e) => {
        if (e.type === "busy") other.prepare("SELECT 1").get();
      },
      LIB,
      { busy: true, onListenerError: (e) => errs.push(msg(e)) },
    );
    try {
      other.exec("INSERT INTO t VALUES (2, 'x')");
    } catch { /* SQLITE_BUSY */ }
    check(
      "  refused, and the message explains why",
      errs.some((e) =>
        e.includes("stop at the sixth") && e.includes("deadlock")
      ),
      true,
    );
    held.exec("ROLLBACK");
    other.close();
    held.close();
    removeDb(path);
  },

  "busy: a busy timeout set afterwards displaces us, and is reported"() {
    const { held, other, path } = contended();
    const errs: string[] = [];
    withEvents(
      other,
      (e) => {
        if (e.type === "busy") e.giveUp();
      },
      LIB,
      { busy: true, onListenerError: (e) => errs.push(msg(e)) },
    );
    held.exec("ROLLBACK");
    other.exec("INSERT INTO t VALUES (3, 'a commit, so the drain runs')");
    other.exec("PRAGMA busy_timeout = 2500");
    other.exec("INSERT INTO t VALUES (4, 'another commit')");
    check(
      "  detected and reported",
      errs.some((e) => e.includes("removes ours")),
      true,
    );
    const before = errs.length;
    other.exec("INSERT INTO t VALUES (5, 'and again')");
    check("  reported once, not per commit", errs.length, before);
    other.close();
    held.close();
    removeDb(path);
  },

  "authorize: the authorizer names the virtual table the write hooks never do"() {
    // The evidence the live-query path rests on. update_hook reports FTS5's
    // shadow tables and never `ft`; the authorizer reports `ft` and never a
    // shadow table. Neither source is sufficient alone.
    const db = new Database(":memory:");
    db.exec("CREATE TABLE plain(id INTEGER PRIMARY KEY, body TEXT)");
    db.exec("CREATE VIRTUAL TABLE ft USING fts5(body)");
    let collecting = false;
    const duringPrepare: string[] = [];
    const duringExecution: string[] = [];
    const written: string[] = [];
    withEvents(
      db,
      (e) => {
        if (e.type === "authorize" && e.arg1 !== null) {
          (collecting ? duringPrepare : duringExecution).push(e.arg1);
        }
        if (e.type === "change") written.push(e.change.table);
      },
      LIB,
      { authorize: true },
    );
    db.exec("INSERT INTO ft(body) VALUES ('hello world')");
    collecting = true;
    db.prepare("SELECT body FROM ft WHERE ft MATCH 'hello'").finalize();
    collecting = false;
    check(
      "  preparing the query names the virtual table",
      duringPrepare.includes("ft"),
      true,
    );
    check(
      "  and no shadow table",
      duringPrepare.some((t) => t.startsWith("ft_")),
      false,
    );
    check(
      "  while the write hooks saw only shadow tables",
      written.length > 0 && written.every((t) => t.startsWith("ft_")),
      true,
    );
    check("  and never the virtual table", written.includes("ft"), false);
    // EXECUTING a write to a virtual table also authorizes its shadow tables,
    // because FTS5 prepares its own statements against them. A collector must
    // therefore bracket the prepare, not the whole call.
    check(
      "  executing a vtab write also authorizes its shadow tables",
      duringExecution.some((t) => t.startsWith("ft_")),
      true,
    );
    db.close();
  },

  "authorize: doing nothing allows, and no return value can decide"() {
    // A thenable coerced to a verdict would be 1, which is DENY: an async
    // listener would reject every statement the process prepares.
    for (
      const [label, listener] of [
        ["a thenable", () => Promise.resolve(true)],
        ["a truthy value", () => 1],
        ["a throw", () => {
          throw new Error("from the authorize listener");
        }],
        ["no decision", () => undefined],
      ] as const
    ) {
      const db = memory();
      db.exec("INSERT INTO t VALUES (1, 'a')");
      const warned = captureWarnings();
      let rows = -1;
      let threw = "";
      try {
        withEvents(
          db,
          (e) => e.type === "authorize" ? listener() : undefined,
          LIB,
          {
            authorize: true,
            onListenerError: () => {},
          },
        );
        rows = db.prepare("SELECT count(*) c FROM t").get<{ c: number }>()?.c ??
          -1;
      } catch (e) {
        threw = msg(e);
      } finally {
        warned.stop();
      }
      check(`  ${label}: the statement compiled`, threw, "");
      check(`  ${label}: and returned its rows`, rows, 1);
      db.close();
    }
  },

  "authorize: deny() rejects the statement, ignore() NULLs the column silently"() {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, secret TEXT, ok TEXT)");
    db.exec("INSERT INTO t VALUES (1, 's3cret', 'fine')");
    for (const mode of ["deny", "ignore"] as const) {
      const sub = withEvents(
        db,
        (e) => {
          if (
            e.type === "authorize" && e.action === "read" && e.arg2 === "secret"
          ) {
            if (mode === "deny") e.deny();
            else e.ignore();
          }
        },
        LIB,
        { authorize: true, onListenerError: () => {} },
      );
      let threw = "";
      let secret: unknown = "unset";
      try {
        secret = db.prepare("SELECT secret, ok FROM t").get<
          { secret: unknown }
        >()
          ?.secret;
      } catch (e) {
        threw = msg(e);
      }
      if (mode === "deny") {
        check("  deny: the prepare failed", threw.includes("prohibited"), true);
      } else {
        check("  ignore: the query succeeded", threw, "");
        check("  ignore: and the column came back NULL", secret, null);
      }
      sub.dispose();
    }
    db.close();
  },

  "authorize: the first decision wins, and a stale one is reported"() {
    const db = memory();
    const errs: string[] = [];
    const stashed: Array<() => void> = [];
    const decider = (e: DbEvent) => {
      if (e.type === "authorize" && e.action === "read") {
        e.ignore();
        e.deny(); // second call: must not override
        if (stashed.length === 0) stashed.push(e.deny);
      }
      return undefined;
    };
    db.exec("INSERT INTO t VALUES (1, 'a')");
    withEvents(db, decider, LIB, {
      authorize: true,
      onListenerError: (e) => errs.push(msg(e)),
    });
    let threw = "";
    try {
      db.prepare("SELECT v FROM t").get();
    } catch (e) {
      threw = msg(e);
    }
    check("  ignore() won, so the statement compiled", threw, "");
    check(
      "  and the second call was reported",
      errs.some((e) => e.includes("the first call stands")),
      true,
    );
    stashed[0]?.();
    db.exec("SELECT 1");
    check(
      "  a stale call decided nothing and was reported",
      errs.some((e) => e.includes("decided nothing")),
      true,
    );
    db.close();
  },

  "authorize: our own internal statements are suppressed, the caller's are not"() {
    // Bracketed at our call sites, never matched on SQL — so a caller issuing
    // the very same pragma still sees it.
    const db = memory();
    const pragmas: string[] = [];
    withEvents(
      db,
      (e) => {
        if (
          e.type === "authorize" && e.action === "pragma" && e.arg1 !== null
        ) {
          pragmas.push(e.arg1);
        }
      },
      LIB,
      { authorize: true, busy: true, preupdate: "auto" },
    );
    db.exec("INSERT INTO t VALUES (1, 'a')"); // drives our own detector reads
    check(
      "  our wal_autocheckpoint read was not delivered",
      pragmas.includes("wal_autocheckpoint"),
      false,
    );
    check(
      "  nor our busy_timeout read",
      pragmas.includes("busy_timeout"),
      false,
    );
    db.exec("PRAGMA busy_timeout");
    check(
      "  but the caller's identical pragma IS delivered",
      pragmas.includes("busy_timeout"),
      true,
    );
    db.close();
  },

  "authorize: a re-prepare after a schema change is still guarded"() {
    // SQLite re-prepares on SQLITE_SCHEMA inside step(), so the callback can
    // arrive during what the caller experiences as a read. The guard is on the
    // callback, not on an assumption about which C call we are inside.
    const db = memory();
    const errs: string[] = [];
    let duringStep = 0;
    let stepping = false;
    withEvents(
      db,
      (e) => {
        if (e.type === "authorize") {
          if (stepping) duringStep++;
          if (stepping) db.prepare("SELECT 1").finalize(); // must be refused
        }
      },
      LIB,
      { authorize: true, onListenerError: (e) => errs.push(msg(e)) },
    );
    db.exec("INSERT INTO t VALUES (1, 'a')");
    const reused = db.prepare("SELECT * FROM t");
    reused.all();
    db.exec("ALTER TABLE t ADD COLUMN extra TEXT");
    stepping = true;
    reused.all();
    stepping = false;
    reused.finalize();
    check("  callbacks did arrive during the step", duringStep > 0, true);
    check(
      "  and touching the connection there was refused",
      errs.some((e) => e.includes("stop at the sixth")),
      true,
    );
    db.close();
  },

  "authorize: an unrecognised action code is delivered, not dropped"() {
    check(
      "  the codes SQLite names",
      [20, 21, 18, 31].map(actionFor),
      ["read", "select", "insert", "function"],
    );
    check(
      "  anything else",
      [0, 34, 99, -1].map(actionFor),
      ["unknown", "unknown", "unknown", "unknown"],
    );
  },

  "an opcode outside the documented three is delivered as 'unknown'"() {
    // KNOWN COVERAGE GAP. The "unknown" branch is proven by opFor's totality
    // and by raw opcodes verified through the real FFI in the next scenario —
    // NOT by an actual unknown-opcode delivery. SQLite only ever sends the
    // three, and forging one would mean displacing our own update hook, which
    // is the failure the displacement assertion below exists to catch. If a
    // backend seam ever makes callback injection possible, revisit this test.
    check(
      "  the documented three",
      [18, 23, 9].map(opFor),
      ["insert", "update", "delete"],
    );
    check(
      "  anything else",
      [-1, 0, 1, 7, 42, 1_000_000].map(opFor),
      ["unknown", "unknown", "unknown", "unknown", "unknown", "unknown"],
    );
  },

  "every event carries the raw opcode SQLite sent"() {
    const db = memory();
    const seen: string[] = [];
    withEvents(db, (e) => {
      if (e.type === "change") {
        seen.push(`change ${e.change.op}/${e.change.opcode}`);
      }
      if (e.type === "preupdate") seen.push(`pre ${e.op}/${e.opcode}`);
    }, LIB);
    db.exec("INSERT INTO t VALUES (1, 'a')");
    db.exec("UPDATE t SET v = 'b' WHERE id = 1");
    db.exec("DELETE FROM t WHERE id = 1");
    check("  raw, undecoded", seen, [
      "pre insert/18",
      "change insert/18",
      "pre update/23",
      "change update/23",
      "pre delete/9",
      "change delete/9",
    ]);
    db.close();
  },

  "a blob write's op and opcode legitimately disagree"() {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, b BLOB)");
    db.exec("INSERT INTO t VALUES (1, zeroblob(8))");
    const seen: string[] = [];
    withEvents(db, (e) => {
      if (e.type === "change") {
        seen.push(`${e.change.op}/${e.change.opcode}`);
      }
    }, LIB);
    const blob = db.openBlob({
      table: "t",
      column: "b",
      row: 1,
      readonly: false,
    });
    blob.writeSync(0, new Uint8Array([1, 2, 3, 4]));
    blob.close();
    check("  our interpretation, SQLite's opcode", seen, ["update/9"]);
    db.close();
  },

  "our update hook is still the one SQLite has installed, not the driver's"() {
    // SQLite keeps ONE update hook per connection. @db/sqlite 0.13.0 declares
    // sqlite3_update_hook without calling it; if a release ever calls it, ours
    // is displaced and every change event stops with no error anywhere. Only a
    // real write proves otherwise — a symbol still looks fine when displaced.
    const db = memory();
    const seen: Change[] = [];
    withEvents(db, (e) => {
      if (e.type === "change") seen.push(e.change);
    }, LIB);
    db.exec("INSERT INTO t VALUES (1, 'a')");
    db.prepare("INSERT INTO t VALUES (?, ?)").run(2, "b");
    db.transaction(() => {
      db.exec("UPDATE t SET v = 'c' WHERE id = 1");
    })();
    check(
      "  every write reached our hook",
      seen.map((c) => `${c.op} ${c.db}.${c.table} ${c.rowid}`),
      ["insert main.t 1", "insert main.t 2", "update main.t 1"],
    );
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
      fail(name, `threw ${e instanceof Error ? e.stack : e}`);
    }
  }

  // Soft properties: a failure here is a semantics bug, never a crash. The
  // hard "no permutation may segfault" invariant lives in the crash matrix.
  console.log(
    `\nsoft property suite (${
      Object.keys(PROPERTIES).length
    } properties x ${PROPERTY_RUNS} runs, seed ${PROPERTY_SEED})`,
  );
  for (const [name, fn] of Object.entries(PROPERTIES)) {
    try {
      fn();
      pass(name);
    } catch (e) {
      fail(name, `falsified — replay with FC_SEED=${PROPERTY_SEED}: ${msg(e)}`);
    }
  }
}

console.log(
  `\n${passed} passed, ${failed} failed — ${failed === 0 ? "OK" : "FAILURES"}`,
);
if (failed > 0) Deno.exitCode = 1;
