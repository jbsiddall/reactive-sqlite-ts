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
import { elisionMarker, excerpt, EXCERPT_BUDGET } from "./excerpt.ts";
import { PROPERTIES, PROPERTY_RUNS, PROPERTY_SEED } from "./properties.ts";

const LIB = resolveLibPath();
const { Database, Statement } = await import("../driver/mod.ts");
const {
  actionFor,
  opFor,
  probeCapabilities,
  SqliteHooksError,
  withEvents,
  withValidation,
} = await import("../src/hooks.ts");
const { formatEvent, jsonReplacer } = await import("../src/format.ts");
const { captureSchemaMap, SchemaMap, SchemaMapError } = await import(
  "../src/schema_map.ts"
);
const { isSchemaChangingAction, SchemaWatch, SchemaWatchError, watchSchema } =
  await import("../src/schema_watch.ts");
/**
 * The `"unattributable-shadow"` kind carries no `canonical` on purpose, so the
 * union forces a branch. Tests take that branch as a distinguishable STRING
 * rather than a throw, so a scenario that starts producing it fails loudly on
 * the value instead of on the shape.
 */
const canonicalOf = (r: import("../src/schema_map.ts").Resolution): string =>
  r.kind === "unattributable-shadow"
    ? `UNATTRIBUTABLE ${r.name}`
    : r.kind === "view"
    ? `VIEW ${r.name}`
    : r.canonical;
const { DependencyError, extractDependencies } = await import(
  "../src/dependencies.ts"
);
type Dependencies = import("../src/dependencies.ts").Dependencies;
/**
 * The sets, rendered so a check() diff is readable - and rendered ONLY for the
 * kinds that have sets. `"none"` and `"failed"` come back as their own words,
 * which is the point of the type: this helper cannot accidentally print an
 * empty set for a failure.
 */
const depsOf = (d: Dependencies): unknown =>
  d.kind === "none" || d.kind === "failed" ? d.kind : {
    kind: d.kind,
    reads: d.reads.map((r) => `${r.schema}.${r.name}`),
    writes: d.writes.map((r) => `${r.schema}.${r.name}`),
  };
const { openFfiBackend } = await import("../src/backend_ffi.ts");
type DbEvent = import("../src/hooks.ts").DbEvent;
type PreUpdate = import("../src/hooks.ts").PreUpdate;
type RowValue = import("../src/hooks.ts").RowValue;
type Change = import("../src/hooks.ts").Change;
type CollationEvent = import("../src/hooks.ts").CollationEvent;
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

// The child's permissions come from this list alone — it is a fresh `deno run`,
// not a fork, so nothing is inherited from the parent. `--allow-net` was here
// and is not any more: the driver is vendored and nothing in a case reaches the
// network. Do not add a permission back for a case that fails without it
// without first asking what that case is doing.
const FLAGS = [
  "--unstable-ffi",
  "--allow-ffi",
  "--allow-env",
  "--allow-read",
  "--allow-write",
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
      `exit ${code}, wanted ${expected.code}. Output: ${excerpt(text)}`,
    );
    return;
  }
  if (!text.includes(expected.match)) {
    fail(
      name,
      `output did not contain ${JSON.stringify(expected.match)}. Got: ${
        excerpt(text)
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
        e.type === "authorize" ||
        e.type === "collation"
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
    // Not just "a reason is given" — WHICH reason. The option and a library
    // genuinely built without SQLITE_ENABLE_PREUPDATE_HOOK share one code
    // path, so the only thing keeping "you turned this off" apart from "your
    // SQLite cannot do this" is this string. They have different remedies and
    // must never be told to the wrong caller.
    const why = sub.capabilities.preupdateUnavailable ?? "";
    check("  reason given", why.length > 0, true);
    check("  names the option", why.includes('preupdate: "off"'), true);
    check(
      "  does not blame the library",
      why.includes("does not export") || why.includes("compile-time option"),
      false,
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
      collation: () => {},
      fail: () => {},
    }, {
      walCheckpointThreshold: null,
      trace: [],
      traceSql: "statement",
      progressOps: null,
      busy: false,
      authorize: false,
      collation: false,
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
      collation: () => {},
      fail: () => {},
    }, {
      walCheckpointThreshold: null,
      trace: [],
      traceSql: "statement",
      progressOps: null,
      busy: false,
      authorize: false,
      collation: false,
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
      collation: () => {},
      fail: () => {},
    }, {
      walCheckpointThreshold: null,
      trace: [],
      traceSql: "statement",
      progressOps: null,
      busy: false,
      authorize: false,
      collation: false,
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

  "collation: providing a sequence from inside the event sorts the statement"() {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t(v TEXT)");
    db.exec("INSERT INTO t(v) VALUES ('a'),('b'),('c')");
    const asked: Array<{ name: string; encoding: string }> = [];
    let comparisons = 0;
    withEvents(
      db,
      (e) => {
        if (e.type !== "collation") return undefined;
        asked.push({ name: e.name, encoding: e.encoding });
        e.provide((a, b) => {
          comparisons++;
          return a < b ? 1 : a > b ? -1 : 0;
        });
        return undefined;
      },
      LIB,
      { collation: true },
    );
    const rows = db.prepare("SELECT v FROM t ORDER BY v COLLATE REV").all<
      { v: string }
    >()
      .map((r) => r.v);
    check("  the statement proceeded, correctly sorted", rows, ["c", "b", "a"]);
    check("  asked once, by name", asked, [{ name: "REV", encoding: "utf8" }]);
    check("  and the comparator was actually called", comparisons > 0, true);
    db.close();
  },

  "collation: the name is asked for once per statement, not once per lookup"() {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t(v TEXT)");
    db.exec("INSERT INTO t(v) VALUES ('a'),('b'),('c')");
    let asked = 0;
    withEvents(
      db,
      (e) => {
        if (e.type === "collation") asked++;
        return undefined;
      },
      LIB,
      { collation: true, onListenerError: () => {} },
    );
    // Never provided: SQLite asks, gives up, and does not loop.
    try {
      db.prepare("SELECT v FROM t ORDER BY v COLLATE REV").all();
    } catch { /* expected below */ }
    check("  one ask for one statement", asked, 1);
    db.close();
  },

  "collation: doing nothing fails the statement cleanly and commits anyway"() {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t(v TEXT)");
    db.exec("CREATE TABLE plain(x INTEGER)");
    withEvents(db, () => undefined, LIB, { collation: true });
    db.exec("BEGIN");
    db.exec("INSERT INTO plain VALUES (42)");
    let threw = "";
    try {
      db.prepare("SELECT v FROM t ORDER BY v COLLATE REV").all();
    } catch (e) {
      threw = msg(e);
    }
    check(
      "  the statement failed with SQLite's own message",
      threw.includes("no such collation sequence"),
      true,
    );
    db.exec("COMMIT");
    check(
      "  the connection is still usable and the commit landed",
      db.prepare("SELECT x FROM plain").get<{ x: number }>()?.x,
      42,
    );
    db.close();
  },

  "collation: off by default, so nothing is asked and nothing changes"() {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t(v TEXT)");
    let asked = 0;
    withEvents(db, (e) => {
      if (e.type === "collation") asked++;
      return undefined;
    }, LIB);
    let threw = "";
    try {
      db.prepare("SELECT v FROM t ORDER BY v COLLATE REV").all();
    } catch (e) {
      threw = msg(e);
    }
    check("  no event", asked, 0);
    check(
      "  and the statement fails exactly as it would with no hooks",
      threw.includes("no such collation sequence"),
      true,
    );
    db.close();
  },

  "collation: a stashed provide() installs nothing and is reported"() {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t(v TEXT)");
    db.exec("INSERT INTO t(v) VALUES ('a'),('b')");
    const errs: string[] = [];
    const stashed: Array<(a: string, b: string) => number> = [];
    let stash: CollationEvent["provide"] | null = null;
    withEvents(
      db,
      (e) => {
        if (e.type === "collation" && stash === null) stash = e.provide;
        return undefined;
      },
      LIB,
      { collation: true, onListenerError: (e) => errs.push(msg(e)) },
    );
    try {
      db.prepare("SELECT v FROM t ORDER BY v COLLATE REV").all();
    } catch { /* the statement was always going to fail */ }
    stashed.push((a, b) => a < b ? 1 : a > b ? -1 : 0);
    stash!(stashed[0]!);
    db.exec("SELECT 1");
    check(
      "  the late call was reported",
      errs.some((e) => e.includes("had already given up")),
      true,
    );
    let threw = "";
    try {
      db.prepare("SELECT v FROM t ORDER BY v COLLATE REV").all();
    } catch (e) {
      threw = msg(e);
    }
    check(
      "  and installed nothing: the next statement still fails",
      threw.includes("no such collation sequence"),
      true,
    );
    db.close();
  },

  "collation: the first provide() stands and a second is reported"() {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t(v TEXT)");
    db.exec("INSERT INTO t(v) VALUES ('a'),('b'),('c')");
    const errs: string[] = [];
    withEvents(
      db,
      (e) => {
        if (e.type !== "collation") return undefined;
        e.provide((a, b) => a < b ? 1 : a > b ? -1 : 0); // reverse: wins
        e.provide((a, b) => a < b ? -1 : a > b ? 1 : 0); // forward: ignored
        return undefined;
      },
      LIB,
      { collation: true, onListenerError: (e) => errs.push(msg(e)) },
    );
    const rows = db.prepare("SELECT v FROM t ORDER BY v COLLATE REV").all<
      { v: string }
    >()
      .map((r) => r.v);
    check("  the first comparator ordered the rows", rows, ["c", "b", "a"]);
    check(
      "  and the second call was reported",
      errs.some((e) => e.includes("the first collating sequence stands")),
      true,
    );
    db.close();
  },

  "collation: provide() with something that is not a function is refused"() {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t(v TEXT)");
    db.exec("INSERT INTO t(v) VALUES ('a'),('b')");
    const errs: string[] = [];
    withEvents(
      db,
      (e) => {
        if (e.type !== "collation") return undefined;
        // The shape a caller reaches for when they meant Intl.Collator.compare.
        // Routed through `unknown` so the wrong type reaches provide() at
        // runtime without an assertion pretending it is the right one.
        const provide: unknown = e.provide;
        if (typeof provide === "function") provide(new Intl.Collator("en"));
        return undefined;
      },
      LIB,
      { collation: true, onListenerError: (e) => errs.push(msg(e)) },
    );
    let threw = "";
    try {
      db.prepare("SELECT v FROM t ORDER BY v COLLATE REV").all();
    } catch (e) {
      threw = msg(e);
    }
    // The failing prepare threw from the driver, so nothing of ours unwound to
    // flush; a later statement is what delivers the pending listener error.
    db.exec("SELECT 1");
    check(
      "  reported rather than installed",
      errs.some((e) => e.includes("rather than a comparison function")),
      true,
    );
    check(
      "  and the statement failed rather than sorting by nothing",
      threw.includes("no such collation sequence"),
      true,
    );
    db.close();
  },

  "collation: a comparator that throws is reported, not unwound through C"() {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t(v TEXT)");
    db.exec("INSERT INTO t(v) VALUES ('a'),('b'),('c')");
    const errs: string[] = [];
    withEvents(
      db,
      (e) => {
        if (e.type !== "collation") return undefined;
        e.provide(() => {
          throw new Error("from the comparator");
        });
        return undefined;
      },
      LIB,
      { collation: true, onListenerError: (e) => errs.push(msg(e)) },
    );
    const rows = db.prepare("SELECT v FROM t ORDER BY v COLLATE REV").all<
      { v: string }
    >()
      .map((r) => r.v);
    check("  the statement still returned every row", rows.length, 3);
    check(
      "  and the throw was reported",
      errs.some((e) => e.includes("from the comparator")),
      true,
    );
    check(
      "  the connection survives",
      db.prepare("SELECT count(*) AS n FROM t").get<{ n: number }>()?.n,
      3,
    );
    db.close();
  },

  "collation: a comparator returning a non-number is reported, not passed to C"() {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t(v TEXT)");
    db.exec("INSERT INTO t(v) VALUES ('a'),('b'),('c')");
    const errs: string[] = [];
    withEvents(
      db,
      (e) => {
        if (e.type !== "collation") return undefined;
        e.provide(() => NaN);
        return undefined;
      },
      LIB,
      { collation: true, onListenerError: (e) => errs.push(msg(e)) },
    );
    const rows = db.prepare("SELECT v FROM t ORDER BY v COLLATE REV").all<
      { v: string }
    >();
    check("  every row still came back", rows.length, 3);
    check(
      "  and 'not an ordering' was said out loud",
      errs.some((e) => e.includes("which is not an ordering")),
      true,
    );
    db.close();
  },

  "collation: registering produces no events of its own"() {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t(v TEXT)");
    db.exec("INSERT INTO t(v) VALUES ('a'),('b')");
    const seen: string[] = [];
    withEvents(
      db,
      (e) => {
        seen.push(e.type);
        if (e.type === "collation") {
          e.provide((a, b) => a < b ? 1 : a > b ? -1 : 0);
        }
        return undefined;
      },
      LIB,
      { collation: true },
    );
    db.prepare("SELECT v FROM t ORDER BY v COLLATE REV").all();
    check(
      "  one collation event and nothing else",
      seen,
      ["collation"],
    );
    db.close();
  },

  "collation: dispose() removes the sequence rather than leaving it dangling"() {
    // Freeing the comparator while SQLite still pointed at it would be a
    // segfault, so detach removes the sequence first. The proof that removal
    // is what happened is the message, not the absence of a crash.
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t(v TEXT)");
    db.exec("INSERT INTO t(v) VALUES ('a'),('b'),('c')");
    const sub = withEvents(
      db,
      (e) => {
        if (e.type === "collation") {
          e.provide((a, b) => a < b ? 1 : a > b ? -1 : 0);
        }
        return undefined;
      },
      LIB,
      { collation: true },
    );
    const before = db.prepare("SELECT v FROM t ORDER BY v COLLATE REV").all<
      { v: string }
    >()
      .map((r) => r.v);
    check("  sorted while attached", before, ["c", "b", "a"]);
    sub.dispose();
    let threw = "";
    try {
      db.prepare("SELECT v FROM t ORDER BY v COLLATE REV").all();
    } catch (e) {
      threw = msg(e);
    }
    check(
      "  gone after dispose, and said so",
      threw.includes("no such collation sequence"),
      true,
    );
    check(
      "  the connection is otherwise untouched",
      db.prepare("SELECT count(*) AS n FROM t").get<{ n: number }>()?.n,
      3,
    );
    db.close();
  },

  "collation: capabilities report it, and asking without it is refused"() {
    check("  this library has it", probeCapabilities(LIB).collation, true);
  },

  "collation: a name SQLite could not resolve is reported as written"() {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t(v TEXT)");
    db.exec("INSERT INTO t(v) VALUES ('a')");
    const names: string[] = [];
    withEvents(
      db,
      (e) => {
        if (e.type === "collation") names.push(e.name);
        return undefined;
      },
      LIB,
      { collation: true, onListenerError: () => {} },
    );
    try {
      db.prepare('SELECT v FROM t ORDER BY v COLLATE "MiXeD Case"').all();
    } catch { /* no sequence was supplied */ }
    check("  the spelling in the SQL, not a normalised form", names, [
      "MiXeD Case",
    ]);
    db.close();
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
    // SQLite keeps ONE update hook per connection, and the connection here is
    // opened by the vendored driver in `driver/`. That driver declares
    // sqlite3_update_hook in `driver/ffi.ts` and calls it nowhere. The day an
    // edit there starts calling it, ours is displaced and every change event
    // stops with no error anywhere. No upstream version is named on purpose:
    // the thing that can break this is a future edit in THIS repository, and a
    // release number would send a reader to check somebody else's tree. Only a
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

  "reentrancy: for..of on a statement prepared BEFORE attach is refused"() {
    // The headline attach-order case. `iter` is on the prototype and is never
    // shadowed by an own property, so the refusal reaches a statement this
    // library never saw being made.
    const db = memory();
    db.exec("INSERT INTO t VALUES (1,'a'),(2,'b')");
    const before = db.prepare("SELECT v FROM t");
    let refusal = "";
    let rowsSeen = 0;
    withEvents(
      db,
      (e) => {
        if (e.type !== "change") return undefined;
        try {
          for (const _ of before) rowsSeen++;
        } catch (err) {
          refusal = msg(err);
        }
        return undefined;
      },
      LIB,
      { onListenerError: () => {} },
    );
    db.exec("INSERT INTO t VALUES (3,'c')");
    check(
      "  it refused",
      refusal.startsWith("statement.iter() was called"),
      true,
    );
    check("  and no row was stepped", rowsSeen, 0);
    // The gate: the same iteration outside a listener must be untouched, or a
    // refusal that fires everywhere would look exactly like this one.
    check("  outside a hook it still iterates", [...before].length, 3);
    db.close();
  },

  "reentrancy: stmt.iter() is refused from inside a listener"() {
    const db = memory();
    db.exec("INSERT INTO t VALUES (1,'a')");
    const before = db.prepare("SELECT v FROM t");
    let refusal = "";
    withEvents(
      db,
      (e) => {
        if (e.type !== "change") return undefined;
        try {
          before.iter().next();
        } catch (err) {
          refusal = msg(err);
        }
        return undefined;
      },
      LIB,
      { onListenerError: () => {} },
    );
    db.exec("INSERT INTO t VALUES (2,'b')");
    check(
      "  named itself",
      refusal.startsWith("statement.iter() was called from inside a hook"),
      true,
    );
    db.close();
  },

  "reentrancy: preparing through new Statement() inside a hook is reported"() {
    // It cannot be refused — the constructor touches only unsafeHandle before
    // sqlite3_prepare_v2, and unsafeHandle is the documented escape hatch. So
    // the contract is detection, and this test is what holds that down: if the
    // driver stops reading unsafeConcurrency, detection stops silently, and
    // this test is the thing that says so.
    const db = memory();
    db.exec("INSERT INTO t VALUES (1,'a')");
    const errs: string[] = [];
    let got: unknown = "not run";
    withEvents(
      db,
      (e) => {
        if (e.type !== "change") return undefined;
        const stmt = new Statement(db, "SELECT count(*) AS c FROM t");
        got = stmt.get();
        stmt.finalize();
        return undefined;
      },
      LIB,
      { onListenerError: (err) => errs.push(msg(err)) },
    );
    db.exec("INSERT INTO t VALUES (2,'b')");
    check("  the read was NOT refused", got !== "not run", true);
    check(
      "  but it was reported",
      errs.some((e) =>
        e.startsWith("a statement was prepared on this connection")
      ),
      true,
    );
    db.close();
  },

  "reentrancy: preparing outside a hook reports nothing"() {
    // The negative control for the case above. Without it, a detector that
    // fired on every prepare would pass that test and mean nothing.
    const db = memory();
    const errs: string[] = [];
    withEvents(db, () => {}, LIB, {
      onListenerError: (err) => errs.push(msg(err)),
    });
    const stmt = new Statement(db, "SELECT count(*) AS c FROM t");
    stmt.get();
    stmt.finalize();
    db.exec("INSERT INTO t VALUES (1,'a')");
    check("  nothing was reported", errs, []);
    check("  and unsafeConcurrency still reads", db.unsafeConcurrency, false);
    db.close();
  },

  "reentrancy: dispose() restores unsafeConcurrency as a plain property"() {
    const db = memory();
    const sub = withEvents(db, () => {}, LIB);
    sub.dispose();
    check(
      "  own data property again",
      Object.getOwnPropertyDescriptor(db, "unsafeConcurrency")?.value,
      false,
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

  "driver internals: row readers read column names containing quotes and newlines"() {
    // NOTICE says this build reads such columns correctly. This is where that
    // sentence is measured; delete this scenario and the claim is unbacked.
    // The row readers are plain loops over the column list, so a name is data
    // here rather than text that has to survive being written into source.
    const db = memory('CREATE TABLE weird("a""b" INTEGER, "c\nd" TEXT)');
    db.exec("INSERT INTO weird VALUES (1, 'x')");
    const stmt = db.prepare("SELECT * FROM weird");
    check("  column names", stmt.columnNames(), ['a"b', "c\nd"]);
    check("  read as an object", stmt.get(), { 'a"b': 1, "c\nd": "x" });
    check("  read as an array", stmt.values(), [[1, "x"]]);
    // A name that would close the string and start a statement, had one ever
    // been generated.
    const hostile = 'x");globalThis.PWNED=1;("';
    const db2 = memory(
      `CREATE TABLE hostile(${`"${hostile.replaceAll('"', '""')}"`} INTEGER)`,
    );
    db2.exec("INSERT INTO hostile VALUES (7)");
    check(
      "  hostile name read as data",
      db2.prepare("SELECT * FROM hostile").get(),
      { [hostile]: 7 },
    );
    check(
      "  nothing was evaluated",
      Reflect.get(globalThis, "PWNED"),
      undefined,
    );
    db2.close();
    db.close();
  },

  // ------------------------------------------------------- the schema map
  //
  // The negative control is the first scenario and it asserts ZERO shadow
  // entries, not "no wrong answers": a map that never classifies anything
  // would pass a "no wrong answers" check while being useless.

  "schema map: a schema with no virtual tables has ZERO shadow entries"() {
    const db = memory();
    db.exec("CREATE TABLE other(a)");
    db.exec("CREATE VIEW vw AS SELECT 1 AS one");
    // Underscore in the name, and `t` really is a table - but not a virtual
    // one, so nothing here may be attributed to it.
    db.exec("CREATE TABLE t_x(a)");
    const map = captureSchemaMap(db);
    const listed = db.prepare("PRAGMA table_list").all<
      { schema: string; name: string }
    >();
    check(
      "  every listed table resolves to itself",
      listed.filter((r) => {
        const kind = map.resolveTable(r.name, r.schema).kind;
        return kind !== "table" && kind !== "virtual" && kind !== "view";
      }).map((r) => `${r.schema}.${r.name}`),
      [],
    );
    // A view is not a table resolving to itself and must not be counted as
    // one: it has no rows, SQLite never reports a change on it, and a
    // dependency recorded against it never fires.
    check("  and the view is classified as a view", map.resolveTable("vw"), {
      kind: "view",
      schema: "main",
      name: "vw",
    });
    check(
      "  zero shadow entries",
      listed.filter((r) => map.shadowsOf(r.name, r.schema).length > 0)
        .map((r) => `${r.schema}.${r.name}`),
      [],
    );
    check("  nothing unattributable", map.unattributable, []);
    check("  nothing looks like a shadow", map.shadowLookalikes, []);
    check(
      "  t_x is a plain table resolving to itself",
      map.resolveTable("t_x"),
      {
        kind: "table",
        schema: "main",
        name: "t_x",
        canonical: "t_x",
      },
    );
    db.close();
  },

  "schema map: FTS5, the known answer in both directions"() {
    const db = memory();
    db.exec("CREATE VIRTUAL TABLE ft USING fts5(body)");
    const map = captureSchemaMap(db);
    check("  shadowsOf(ft)", map.shadowsOf("ft"), [
      "ft_config",
      "ft_content",
      "ft_data",
      "ft_docsize",
      "ft_idx",
    ]);
    check(
      "  every shadow canonicalises to ft",
      map.shadowsOf("ft").map((n) => {
        const r = map.resolveTable(n);
        return r.kind === "shadow" ? r.canonical : `${r.kind}!`;
      }),
      ["ft", "ft", "ft", "ft", "ft"],
    );
    check("  ft resolves to itself as virtual", map.resolveTable("ft"), {
      kind: "virtual",
      schema: "main",
      name: "ft",
      canonical: "ft",
    });
    check("  an ordinary table is untouched", map.resolveTable("t"), {
      kind: "table",
      schema: "main",
      name: "t",
      canonical: "t",
    });
    check("  shadowsOf an ordinary table is empty", map.shadowsOf("t"), []);
    db.close();
  },

  "schema map: rtree, a second module with a different shadow set"() {
    const db = memory();
    db.exec("CREATE VIRTUAL TABLE rt USING rtree(id, minx, maxx)");
    const map = captureSchemaMap(db);
    check("  shadowsOf(rt)", map.shadowsOf("rt"), [
      "rt_node",
      "rt_parent",
      "rt_rowid",
    ]);
    check(
      "  and each canonicalises to rt",
      map.shadowsOf("rt").map((n) => {
        const r = map.resolveTable(n);
        return r.kind === "shadow" ? r.canonical : `${r.kind}!`;
      }),
      ["rt", "rt", "rt"],
    );
    db.close();
  },

  "schema map: a nested prefix goes to the longer virtual table"() {
    const db = memory();
    db.exec("CREATE VIRTUAL TABLE ft USING fts5(body)");
    db.exec("CREATE VIRTUAL TABLE ft_sub USING fts5(body)");
    const map = captureSchemaMap(db);
    check("  ft keeps only its own five", map.shadowsOf("ft"), [
      "ft_config",
      "ft_content",
      "ft_data",
      "ft_docsize",
      "ft_idx",
    ]);
    check("  ft_sub gets its own", map.shadowsOf("ft_sub"), [
      "ft_sub_config",
      "ft_sub_content",
      "ft_sub_data",
      "ft_sub_docsize",
      "ft_sub_idx",
    ]);
    const r = map.resolveTable("ft_sub_data");
    check(
      "  ft_sub_data belongs to ft_sub",
      r.kind === "shadow" ? r.canonical : r.kind,
      "ft_sub",
    );
    db.close();
  },

  "schema map: detection beats attribution for a shadow lookalike"() {
    const db = memory();
    db.exec("CREATE VIRTUAL TABLE ft USING fts5(body)");
    // Named exactly like a shadow of ft. SQLite allows it because FTS5's
    // module rejects the suffix, and table_list calls it a plain table.
    db.exec("CREATE TABLE ft_notes(x)");
    const map = captureSchemaMap(db);
    check("  it resolves to itself", map.resolveTable("ft_notes"), {
      kind: "table",
      schema: "main",
      name: "ft_notes",
      canonical: "ft_notes",
    });
    check(
      "  it is NOT a shadow of ft",
      map.shadowsOf("ft").includes("ft_notes"),
      false,
    );
    check("  and the disagreement is reported", map.shadowLookalikes, [
      { schema: "main", name: "ft_notes" },
    ]);
    db.close();
  },

  "schema map: temp has its own virtual tables and they do not leak into main"() {
    const db = memory();
    db.exec("CREATE VIRTUAL TABLE temp.tv USING fts5(body)");
    const map = captureSchemaMap(db);
    check("  shadowsOf under temp", map.shadowsOf("tv", "temp").length, 5);
    check("  nothing under main", map.shadowsOf("tv"), []);
    check(
      "  and main does not know the name",
      map.resolveTable("tv").kind,
      "unknown",
    );
    const r = map.resolveTable("tv_data", "temp");
    check(
      "  temp shadow attributes to temp vtab",
      r.kind === "shadow" ? r.canonical : r.kind,
      "tv",
    );
    db.close();
  },

  "schema map: a name the snapshot never saw is 'unknown', not a silent hit"() {
    const db = memory();
    const map = captureSchemaMap(db);
    check("  kind", map.resolveTable("nope"), {
      kind: "unknown",
      schema: "main",
      name: "nope",
      canonical: "nope",
    });
    db.close();
  },

  "schema map: it is a snapshot, and refresh() is how a new one is taken"() {
    const db = memory();
    const before = captureSchemaMap(db);
    db.exec("CREATE VIRTUAL TABLE ft USING fts5(body)");
    check("  the old snapshot has not moved", before.shadowsOf("ft"), []);
    check("  and says so", before.resolveTable("ft_data").kind, "unknown");
    const after = before.refresh(db);
    check("  the new one sees it", after.shadowsOf("ft").length, 5);
    check("  the old one still does not", before.shadowsOf("ft"), []);
    db.close();
  },

  "schema map: an unattributable shadow is reported, never resolved to itself"() {
    // Not reachable against a real libsqlite3 - deleting the owning virtual
    // table's sqlite_schema row makes SQLite reclassify every shadow as a
    // plain table (measured, 3.45.1 and 3.53.4). The branch is built from
    // rows directly so that the defensive path is exercised rather than
    // assumed.
    const map = SchemaMap.from([
      { schema: "main", name: "sqlite_schema", type: "table" },
      { schema: "main", name: "orphan_data", type: "shadow" },
      { schema: "main", name: "nounderscore", type: "shadow" },
    ], "0.0.0");
    const r = map.resolveTable("orphan_data");
    check("  kind", r.kind, "unattributable-shadow");
    check(
      "  it carries no canonical name at all",
      Object.hasOwn(r, "canonical"),
      false,
    );
    check(
      "  a shadow with no underscore too",
      map.resolveTable("nounderscore").kind,
      "unattributable-shadow",
    );
    check("  both are listed", map.unattributable, [
      { schema: "main", name: "orphan_data" },
      { schema: "main", name: "nounderscore" },
    ]);
  },

  "schema map: below the PRAGMA table_list floor it throws, not answers empty"() {
    // An unrecognised pragma returns zero rows in SQLite rather than failing,
    // so an ancient library would otherwise produce a map of an empty schema
    // in which every answer looks safe and is wrong.
    const ancient = {
      prepare(sql: string) {
        return {
          all: () => sql.includes("table_list") ? [] : [{ v: "3.36.0" }],
          get: () => ({ v: "3.36.0" }),
        };
      },
    };
    let caught: unknown;
    try {
      captureSchemaMap(ancient);
    } catch (e) {
      caught = e;
    }
    check("  SchemaMapError", caught instanceof SchemaMapError, true);
    check("  naming the version", msg(caught).includes("3.36.0"), true);
    check("  and the pragma", msg(caught).includes("table_list"), true);
  },

  "schema map: a table_list without the columns we read throws"() {
    const wrong = {
      prepare: () => ({ all: () => [{ nom: "t" }], get: () => ({ v: "9" }) }),
    };
    let caught: unknown;
    try {
      captureSchemaMap(wrong);
    } catch (e) {
      caught = e;
    }
    check("  SchemaMapError", caught instanceof SchemaMapError, true);
  },

  "schema map: schema+table keys survive identifiers with separators in them"() {
    // Quoted identifiers are arbitrary text, so ("a b", "c") and ("a", "b c")
    // must not collide. Built from rows because ATTACH of two such schemas is
    // not needed to exercise the key.
    const map = SchemaMap.from([
      { schema: "a b", name: "c", type: "table" },
      { schema: "a", name: "b c", type: "virtual" },
      { schema: "a", name: "b c_data", type: "shadow" },
    ], "0.0.0");
    check("  the plain one", map.resolveTable("c", "a b").kind, "table");
    check("  the virtual one", map.resolveTable("b c", "a").kind, "virtual");
    const r = map.resolveTable("b c_data", "a");
    check(
      "  and the shadow attributes across the space",
      r.kind === "shadow" ? r.canonical : r.kind,
      "b c",
    );
    check("  shadowsOf", map.shadowsOf("b c", "a"), ["b c_data"]);
    check("  and not under the other schema", map.shadowsOf("c", "a b"), []);
  },

  "schema map: an FTS5 write canonicalises to the table that was written"() {
    // The change half of the pair, end to end: the hook names only shadows.
    const db = memory();
    db.exec("CREATE VIRTUAL TABLE ft USING fts5(body)");
    const map = captureSchemaMap(db);
    const named: string[] = [];
    const sub = withEvents(db, (e) => {
      if (e.type === "change") named.push(`${e.change.db}.${e.change.table}`);
    }, LIB);
    db.exec("INSERT INTO ft(body) VALUES ('hello world')");
    sub.dispose();
    check("  the hook never names ft", named.includes("main.ft"), false);
    check(
      "  it names these shadows",
      [...new Set(named)].sort(),
      ["main.ft_content", "main.ft_data", "main.ft_docsize"],
    );
    const canonical = new Set(
      named.map((n) => {
        const [schema, table] = n.split(".");
        return canonicalOf(map.resolveTable(table!, schema!));
      }),
    );
    check("  and they all canonicalise to ft", [...canonical], ["ft"]);
    db.close();
  },

  "schema map: an FTS5 MATCH resolves to ft as a dependency"() {
    // The read half of the pair. The authorizer names `ft` when the statement
    // is prepared and the shadow tables when it is stepped; both sides have to
    // come out as ft or a live query over MATCH cannot be invalidated.
    const db = memory();
    db.exec("CREATE VIRTUAL TABLE ft USING fts5(body)");
    db.exec("INSERT INTO ft(body) VALUES ('hello world')");
    const map = captureSchemaMap(db);
    const reads: string[] = [];
    const sub = withEvents(
      db,
      (e) => {
        if (e.type === "authorize" && e.action === "read" && e.arg1 !== null) {
          reads.push(`${e.arg3 ?? "main"}.${e.arg1}`);
        }
      },
      LIB,
      { authorize: true },
    );
    const stmt = db.prepare("SELECT * FROM ft WHERE ft MATCH 'hello'");
    const atPrepare = [...reads];
    reads.length = 0;
    check("  the query returns the row", stmt.all().length, 1);
    const atStep = [...reads];
    stmt.finalize();
    sub.dispose();

    const canonicalise = (names: string[]) =>
      [
        ...new Set(names.map((n) => {
          const [schema, table] = n.split(".");
          return canonicalOf(map.resolveTable(table!, schema!));
        })),
      ].sort();

    check(
      "  prepare named the virtual table",
      atPrepare.includes("main.ft"),
      true,
    );
    check("  prepare resolves to ft", canonicalise(atPrepare), ["ft"]);
    check(
      "  step named shadows instead",
      atStep.some((n) => n.startsWith("main.ft_")),
      true,
    );
    check("  step resolves to ft too", canonicalise(atStep), ["ft"]);
    db.close();
  },

  // ---------------------------------------------------- the schema watch
  //
  // The negative control is first and it asserts ZERO refreshes on a workload
  // with no DDL in it. A watch that refreshed on every commit would pass every
  // correctness scenario below and be a performance disaster, so this is the
  // one that has to fail when the trigger is wrong.

  "schema watch: a workload with NO DDL triggers zero refreshes"() {
    const db = memory();
    db.exec("CREATE VIRTUAL TABLE ft USING fts5(body)");
    const watch = watchSchema(db);
    const sub = withEvents(db, (e) => watch.observe(e), LIB, {
      authorize: true,
    });
    // Reads, writes, a vtab write, an explicit transaction, a rollback.
    db.exec("INSERT INTO t(v) VALUES ('a')");
    db.exec("INSERT INTO ft(body) VALUES ('hello world')");
    db.prepare("SELECT * FROM t").all();
    db.prepare("SELECT body FROM ft WHERE ft MATCH 'hello'").all();
    db.exec("BEGIN");
    db.exec("INSERT INTO t(v) VALUES ('b')");
    db.exec("COMMIT");
    db.exec("BEGIN");
    db.exec("INSERT INTO t(v) VALUES ('c')");
    db.exec("ROLLBACK");
    check("  is a SchemaWatch", watch instanceof SchemaWatch, true);
    check("  refreshes", watch.refreshCount, 0);
    check("  generation", watch.generation, 0);
    check("  never armed", watch.armed, false);
    // ...and the map still works, so zero refreshes is not zero function.
    check(
      "  map still resolves",
      canonicalOf(watch.map.resolveTable("ft_content")),
      "ft",
    );
    sub.dispose();
    db.close();
  },

  "schema watch: a virtual table created AFTER the snapshot"() {
    const db = memory();
    const watch = watchSchema(db);
    const sub = withEvents(db, (e) => watch.observe(e), LIB, {
      authorize: true,
    });
    const before = watch.map;
    check(
      "  before: ft_content is unknown",
      before.resolveTable("ft_content").kind,
      "unknown",
    );
    check("  before: ft owns nothing", [...before.shadowsOf("ft")], []);

    db.exec("CREATE VIRTUAL TABLE ft USING fts5(body)");

    check("  the DDL triggered exactly one refresh", watch.refreshCount, 1);
    check("  and a new snapshot", watch.map !== before, true);
    // Both directions of the mismatch.
    const after = watch.map;
    check(
      "  after: ft_content resolves to ft",
      canonicalOf(after.resolveTable("ft_content")),
      "ft",
    );
    check(
      "  after: ft_data resolves to ft",
      canonicalOf(after.resolveTable("ft_data")),
      "ft",
    );
    check("  after: ft expands to its shadows", [...after.shadowsOf("ft")], [
      "ft_config",
      "ft_content",
      "ft_data",
      "ft_docsize",
      "ft_idx",
    ]);
    // The old snapshot is untouched: refresh replaces, it does not mutate.
    check(
      "  the old snapshot is unchanged",
      before.resolveTable("ft_content").kind,
      "unknown",
    );
    sub.dispose();
    db.close();
  },

  "schema watch: a virtual table DROPPED after the snapshot"() {
    const db = memory();
    db.exec("CREATE VIRTUAL TABLE ft USING fts5(body)");
    const watch = watchSchema(db);
    const sub = withEvents(db, (e) => watch.observe(e), LIB, {
      authorize: true,
    });
    check(
      "  before: ft_content resolves to ft",
      canonicalOf(watch.map.resolveTable("ft_content")),
      "ft",
    );
    check(
      "  before: ft owns five shadows",
      watch.map.shadowsOf("ft").length,
      5,
    );

    db.exec("DROP TABLE ft");

    check("  the DROP triggered exactly one refresh", watch.refreshCount, 1);
    check(
      "  after: ft_content is unknown",
      watch.map.resolveTable("ft_content").kind,
      "unknown",
    );
    check(
      "  after: ft is unknown",
      watch.map.resolveTable("ft").kind,
      "unknown",
    );
    check("  after: ft owns nothing", [...watch.map.shadowsOf("ft")], []);
    sub.dispose();
    db.close();
  },

  "schema watch: an unknown name is refreshed for at most once"() {
    const db = memory();
    const watch = watchSchema(db);
    const sub = withEvents(db, (e) => watch.observe(e), LIB, {
      authorize: true,
    });

    // A name that will never exist. Ten lookups, one refresh: the bound is on
    // the number of refreshes, not on the answer, which never changes.
    const kinds: string[] = [];
    for (let i = 0; i < 10; i++) {
      kinds.push(watch.resolveOrRefresh("never_exists").kind);
    }
    check("  every answer is unknown", [...new Set(kinds)], ["unknown"]);
    check("  refreshes for ten lookups", watch.refreshCount, 1);

    // A DIFFERENT absent name is a different budget: one more, not zero.
    watch.resolveOrRefresh("also_never");
    watch.resolveOrRefresh("also_never");
    check("  a second absent name costs one more", watch.refreshCount, 2);

    // Alternating between two absent names must not restart either budget.
    // A record cleared by ANY refresh rather than only by a DDL-triggered one
    // makes this exact interleaving an unbounded loop, and it is the shape a
    // real caller produces: two live queries, both over a table that is gone.
    for (let i = 0; i < 8; i++) {
      watch.resolveOrRefresh(i % 2 === 0 ? "never_exists" : "also_never");
    }
    check("  alternating between them adds nothing", watch.refreshCount, 2);

    // Real DDL clears the record, so the same name is eligible exactly once
    // again — and this time it is there.
    db.exec("CREATE TABLE never_exists(x)");
    check("  the DDL refreshed", watch.refreshCount, 3);
    check(
      "  the name now resolves without another refresh",
      watch.resolveOrRefresh("never_exists").kind,
      "table",
    );
    check("  a hit costs no refresh", watch.refreshCount, 3);

    // And the cleared record gives an absent name one more try, not unlimited.
    watch.resolveOrRefresh("also_never");
    watch.resolveOrRefresh("also_never");
    watch.resolveOrRefresh("also_never");
    check(
      "  one more try after DDL, then bounded again",
      watch.refreshCount,
      4,
    );
    sub.dispose();
    db.close();
  },

  "schema watch: refreshing from inside a hook is refused, not documented"() {
    const db = memory();
    const watch = watchSchema(db);
    const caught: string[] = [];
    let fromPostcommit = 0;
    const sub = withEvents(
      db,
      (e) => {
        if (e.type === "change" || e.type === "precommit") {
          for (const attempt of ["refreshNow", "resolveOrRefresh"]) {
            try {
              if (attempt === "refreshNow") watch.refreshNow();
              else watch.resolveOrRefresh("never_exists");
              caught.push(`${e.type}:${attempt}:NO THROW`);
            } catch (err) {
              caught.push(
                `${e.type}:${attempt}:${
                  err instanceof SchemaWatchError
                    ? "SchemaWatchError"
                    : String(err)
                }`,
              );
            }
          }
        }
        if (e.type === "postcommit") {
          // The legal route, in the same test, so "it always throws" cannot pass.
          watch.refreshNow();
          fromPostcommit++;
        }
        if (e.type === "authorize" || e.type === "postcommit") {
          watch.observe(e);
        }
      },
      LIB,
      { authorize: true },
    );
    db.exec("INSERT INTO t(v) VALUES ('a')");
    check("  refused from change and precommit", caught, [
      "change:refreshNow:SchemaWatchError",
      "change:resolveOrRefresh:SchemaWatchError",
      "precommit:refreshNow:SchemaWatchError",
      "precommit:resolveOrRefresh:SchemaWatchError",
    ]);
    check("  and allowed from postcommit", fromPostcommit, 1);
    check("  the postcommit refresh really ran", watch.refreshCount >= 1, true);
    sub.dispose();
    db.close();
  },

  "schema watch: ATTACH arms but does not commit, so it needs a drain"() {
    const db = memory();
    const watch = watchSchema(db);
    const sub = withEvents(db, (e) => watch.observe(e), LIB, {
      authorize: true,
    });
    db.exec("ATTACH ':memory:' AS aux");
    // Measured on 3.45.1 and 3.53.4: ATTACH produces an authorize event and no
    // commit at all, so postcommit never drains it.
    check("  armed", watch.armed, true);
    check("  but not refreshed", watch.refreshCount, 0);
    check("  the drain refreshes", watch.refreshIfArmed(), true);
    check("  exactly once", watch.refreshCount, 1);
    check("  and disarms", watch.armed, false);
    check("  a second drain does nothing", watch.refreshIfArmed(), false);
    check("  still once", watch.refreshCount, 1);
    sub.dispose();
    db.close();
  },

  "schema watch: a rolled-back DDL disarms without refreshing"() {
    const db = memory();
    const watch = watchSchema(db);
    const sub = withEvents(db, (e) => watch.observe(e), LIB, {
      authorize: true,
    });
    db.exec("BEGIN");
    db.exec("CREATE TABLE rolled(x)");
    db.exec("ROLLBACK");
    check("  disarmed", watch.armed, false);
    check("  no refresh", watch.refreshCount, 0);
    check(
      "  and the table really is gone",
      watch.map.resolveTable("rolled").kind,
      "unknown",
    );
    sub.dispose();
    db.close();
  },

  "schema watch: isSchemaChangingAction separates DDL from ordinary work"() {
    check(
      "  DDL actions all count",
      ([
        "create_vtable",
        "drop_vtable",
        "create_table",
        "drop_table",
        "alter_table",
        "create_view",
        "create_trigger",
        "create_index",
        "attach",
        "detach",
      ] as const)
        .filter((a) => !isSchemaChangingAction(a)),
      [],
    );
    check(
      "  and ordinary work counts for none",
      ([
        "read",
        "select",
        "insert",
        "update",
        "delete",
        "pragma",
        "transaction",
        "savepoint",
        "function",
        "reindex",
        "analyze",
        "recursive",
        "unknown",
      ] as const)
        .filter((a) => isSchemaChangingAction(a)),
      [],
    );
  },

  // ------------------------------------------------ dependency extraction
  //
  // C1 and C2 are the controls, and C2 is the one that looks like it tests
  // nothing. It tests the distinction the whole design rests on: a statement
  // that depends on no table and a statement whose extraction failed must not
  // arrive as the same value, because the first should never be refreshed and
  // the second must never be trusted.

  "dependencies C1: a plain single-table select yields exactly {t}"() {
    const db = memory();
    const map = captureSchemaMap(db);
    const d = extractDependencies(db, "SELECT v FROM t", {
      schemaMap: map,
      libPath: LIB,
    });
    check("  exactly {t}", depsOf(d), {
      kind: "complete",
      reads: ["main.t"],
      writes: [],
    });
    db.close();
  },

  "dependencies C2: SELECT 1 is deliberately empty, a bad table is failed"() {
    const db = memory();
    const map = captureSchemaMap(db);
    const empty = extractDependencies(db, "SELECT 1", {
      schemaMap: map,
      libPath: LIB,
    });
    check("  SELECT 1 is 'none'", empty.kind, "none");
    const bad = extractDependencies(db, "SELECT * FROM nope", {
      schemaMap: map,
      libPath: LIB,
    });
    check("  a missing table is 'failed'", bad.kind, "failed");
    check(
      "  and it carries why",
      bad.kind === "failed" && /no such table/.test(bad.error.message),
      true,
    );
    // The two must not be the same value. If a future refactor made a failure
    // report an empty set, this is the line that catches it.
    check("  and they are different kinds", empty.kind === bad.kind, false);
    db.close();
  },

  "dependencies T1: a read through a VIEW names the table, not the view"() {
    const db = memory();
    db.exec("CREATE VIEW vt AS SELECT v FROM t");
    const map = captureSchemaMap(db);
    // The map must classify it as a view; if it called it a table, the
    // extractor below would keep it and this scenario would pass for the
    // wrong reason.
    check("  the map calls vt a view", map.resolveTable("vt").kind, "view");
    const d = extractDependencies(db, "SELECT * FROM vt", {
      schemaMap: map,
      libPath: LIB,
    });
    check("  only the underlying table", depsOf(d), {
      kind: "complete",
      reads: ["main.t"],
      writes: [],
    });
    db.close();
  },

  "dependencies T2: a TRIGGER's writes are reported, table unnamed in the SQL"() {
    const db = memory();
    db.exec("CREATE TABLE audit(msg)");
    db.exec(
      "CREATE TRIGGER trg AFTER INSERT ON t BEGIN INSERT INTO audit VALUES ('x'); END",
    );
    const map = captureSchemaMap(db);
    const d = extractDependencies(db, "INSERT INTO t(v) VALUES ('a')", {
      schemaMap: map,
      libPath: LIB,
    });
    check("  audit is there though nothing named it", depsOf(d), {
      kind: "complete",
      reads: [],
      writes: ["main.audit", "main.t"],
    });
    db.close();
  },

  "dependencies: a query over a shadow table canonicalises to the vtab"() {
    const db = memory();
    db.exec("CREATE VIRTUAL TABLE ft USING fts5(body)");
    const map = captureSchemaMap(db);
    check(
      "  the map calls ft_content a shadow",
      map.resolveTable("ft_content").kind,
      "shadow",
    );
    check(
      "  a query written against the shadow resolves to ft",
      depsOf(
        extractDependencies(db, "SELECT * FROM ft_content", {
          schemaMap: map,
          libPath: LIB,
        }),
      ),
      { kind: "complete", reads: ["main.ft"], writes: [] },
    );
    // Measured: at COMPILE time an FTS5 query names the virtual table itself
    // and the shadows only appear when it is stepped. Both directions land on
    // ft, which is the assertion that matters.
    check(
      "  and a MATCH query names ft directly",
      depsOf(
        extractDependencies(db, "SELECT body FROM ft WHERE ft MATCH 'x'", {
          schemaMap: map,
          libPath: LIB,
        }),
      ),
      { kind: "complete", reads: ["main.ft"], writes: [] },
    );
    db.close();
  },

  "dependencies: a NULL schema on an ambiguous name downgrades, not guesses"() {
    const db = memory();
    db.exec("CREATE TEMP TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    const map = captureSchemaMap(db);
    check("  both schemas hold t", map.schemasContaining("t"), [
      "main",
      "temp",
    ]);
    // `count(*)` is the measured case that reports a table with NO schema.
    const d = extractDependencies(db, "SELECT count(*) FROM t", {
      schemaMap: map,
      libPath: LIB,
    });
    check("  downgraded and over-approximated", depsOf(d), {
      kind: "unknown",
      reads: ["main.t", "temp.t"],
      writes: [],
    });
    check(
      "  and the limit names the ambiguity",
      d.kind === "unknown" && d.limits.some((l) => l.includes("no schema")),
      true,
    );
    db.close();
  },

  "dependencies: an unrecognised access downgrades rather than being ignored"() {
    const db = memory();
    const map = captureSchemaMap(db);
    // `pragma` names no table but is not harmless: it can read the schema.
    // The allowlist is what makes this a downgrade instead of a silent pass.
    const d = extractDependencies(db, "PRAGMA table_list", {
      schemaMap: map,
      libPath: LIB,
    });
    check("  kind", d.kind, "unknown");
    check(
      "  and it says which action",
      d.kind === "unknown" && d.limits.some((l) => l.includes('"pragma"')),
      true,
    );
    db.close();
  },

  "dependencies: a table absent from the snapshot downgrades"() {
    const db = memory();
    const map = captureSchemaMap(db);
    db.exec("CREATE TABLE later(x)");
    const d = extractDependencies(db, "SELECT x FROM later", {
      schemaMap: map,
      libPath: LIB,
    });
    check("  still recorded, but not complete", depsOf(d), {
      kind: "unknown",
      reads: ["main.later"],
      writes: [],
    });
    check(
      "  and it says the snapshot is stale",
      d.kind === "unknown" &&
        d.limits.some((l) => l.includes("not in the schema snapshot")),
      true,
    );
    // The control: with a fresh reading it comes out complete. Without this,
    // "downgrades" could be true of everything.
    check(
      "  a fresh snapshot resolves it",
      depsOf(
        extractDependencies(db, "SELECT x FROM later", {
          schemaMap: map.refresh(db),
          libPath: LIB,
        }),
      ),
      { kind: "complete", reads: ["main.later"], writes: [] },
    );
    db.close();
  },

  "dependencies: a caller's deny/ignore does not change the extracted set"() {
    const db = memory();
    db.exec("CREATE TABLE u(c)");
    const map = captureSchemaMap(db);
    const SQL = "SELECT t.v, u.c FROM t JOIN u ON t.id = u.c";
    const both = { kind: "complete", reads: ["main.t", "main.u"], writes: [] };

    let verdict: "allow" | "deny" | "ignore" = "allow";
    let target = "u";
    let sawTarget = false;
    const sub = withEvents(
      db,
      (e) => {
        if (e.type !== "authorize") return;
        if (e.action !== "read" || e.arg1 !== target) return;
        sawTarget = true;
        if (verdict === "deny") e.deny();
        if (verdict === "ignore") e.ignore();
      },
      LIB,
      { authorize: true },
    );

    const extract = () =>
      depsOf(extractDependencies(db, SQL, { schemaMap: map, libPath: LIB }));

    check("  baseline", extract(), both);
    // The control that the verdict really took effect: without it, "the set
    // did not change" would be explained by the listener never firing.
    check("  the listener actually ran", sawTarget, true);

    // `ignore` is the case the upstream position is for: the compile
    // succeeds with the column blanked, and the set is unchanged.
    verdict = "ignore";
    check("  under ignore, unchanged", extract(), both);

    // `deny` fails the compile, and the accesses SQLite had not reached are
    // never reported. A truncated set is the silent-staleness bug, so it must
    // arrive as `failed` rather than as a short but confident answer - and
    // that must hold wherever the denied table sits in the statement.
    verdict = "deny";
    target = "u";
    check("  deny of the LAST table is 'failed'", extract(), "failed");
    target = "t";
    check("  deny of the FIRST table is 'failed'", extract(), "failed");

    sub.dispose();
    db.close();
  },

  "dependencies: a connection with no authorizer refuses rather than answers"() {
    const db = memory();
    const map = captureSchemaMap(db);
    // Hooks already attached WITHOUT authorize. Options are per connection, so
    // the extractor cannot turn it on, and an empty answer here would be a
    // live query that never refreshes.
    const sub = withEvents(db, () => {}, LIB);
    let caught: unknown;
    try {
      extractDependencies(db, "SELECT v FROM t", {
        schemaMap: map,
        libPath: LIB,
      });
    } catch (e) {
      caught = e;
    }
    check("  it throws", caught instanceof DependencyError, true);
    check(
      "  and says why",
      caught instanceof Error && caught.message.includes("authorize"),
      true,
    );
    sub.dispose();
    db.close();
  },

  // ---------------------------------------------- multi-statement strings
  //
  // The defect these were written for: `SELECT x FROM t; SELECT y FROM u`
  // returned `complete` with `u` missing. A confident set that is short by one
  // table is exactly the silent-staleness bug, and it arrives from an input a
  // caller produces by pasting two statements.
  //
  // The controls are the trailing forms that are NOT a second statement -
  // a bare `;`, a comment, whitespace. If the check fired on those it would
  // downgrade almost every statement anyone writes, and `unknown` everywhere
  // is `complete` nowhere.

  "dependencies M1: a trailing statement is never reported as complete"() {
    const db = memory();
    db.exec("CREATE TABLE u(w)");
    const map = captureSchemaMap(db);
    const opts = { schemaMap: map, libPath: LIB };

    // CONTROLS: each half on its own is complete and names its own table.
    check(
      "  first half alone",
      depsOf(extractDependencies(db, "SELECT v FROM t", opts)),
      {
        kind: "complete",
        reads: ["main.t"],
        writes: [],
      },
    );
    check(
      "  second half alone",
      depsOf(extractDependencies(db, "SELECT w FROM u", opts)),
      {
        kind: "complete",
        reads: ["main.u"],
        writes: [],
      },
    );

    const both = extractDependencies(
      db,
      "SELECT v FROM t; SELECT w FROM u",
      opts,
    );
    check("  the pair is not complete", both.kind, "unknown");
    // The set that IS returned is still the first statement's, and it must not
    // silently gain the second statement's tables either: the caller asked
    // about one statement and gets told the answer is short, not a guess.
    check("  and it carries the first statement's table only", depsOf(both), {
      kind: "unknown",
      reads: ["main.t"],
      writes: [],
    });
    check(
      "  and names the tail",
      both.kind === "unknown" &&
        both.limits.some((l) => l.includes("SELECT w FROM u")),
      true,
    );

    // Writes take the same route, and a write missed is the worse direction.
    const writes = extractDependencies(
      db,
      "INSERT INTO t(v) VALUES ('a'); INSERT INTO u(w) VALUES ('b')",
      opts,
    );
    check("  two writes is not complete", writes.kind, "unknown");
    check("  and u is absent from the set", depsOf(writes), {
      kind: "unknown",
      reads: [],
      writes: ["main.t"],
    });

    db.close();
  },

  "dependencies M2: a tail that is nothing stays complete"() {
    const db = memory();
    const map = captureSchemaMap(db);
    const opts = { schemaMap: map, libPath: LIB };
    // Each of these is ONE statement. Measured on 3.45.1 and 3.53.4: SQLite
    // compiles a tail of whitespace, comments or a bare `;` to no statement at
    // all, which is how the line is drawn without lexing anything here.
    for (
      const sql of [
        "SELECT v FROM t",
        "SELECT v FROM t;",
        "SELECT v FROM t;  ",
        "SELECT v FROM t; -- a note",
        "SELECT v FROM t;\n/* a note */\n",
        "SELECT v FROM t; ; ;",
        // The reason a scan for `;` is the wrong implementation: this one is a
        // single statement whose text contains a semicolon.
        "SELECT v FROM t WHERE v = ';'",
      ]
    ) {
      check(
        `  ${JSON.stringify(sql)} is complete`,
        depsOf(extractDependencies(db, sql, opts)),
        { kind: "complete", reads: ["main.t"], writes: [] },
      );
    }
    db.close();
  },

  "dependencies M3: a tail that is not SQL is not a single statement either"() {
    const db = memory();
    const map = captureSchemaMap(db);
    const opts = { schemaMap: map, libPath: LIB };
    // The driver accepts this string and compiles the first statement, so
    // without a tail check it came out `complete`. It is garbage, not nothing.
    const d = extractDependencies(db, "SELECT v FROM t; NOT SQL AT ALL", opts);
    check("  not complete", d.kind, "unknown");
    check(
      "  and says the tail did not compile",
      d.kind === "unknown" &&
        d.limits.some((l) => l.includes("NOT SQL AT ALL")),
      true,
    );
    // A trailing statement that is a no-table statement is still a statement:
    // the downgrade is about what was not compiled, not about what it touched.
    const one = extractDependencies(db, "SELECT v FROM t; SELECT 1", opts);
    check("  a trailing SELECT 1 also downgrades", one.kind, "unknown");
    // And a first statement touching nothing with a real tail must not come
    // back "none" - "none" means "never needs refreshing".
    const none = extractDependencies(db, "SELECT 1; SELECT v FROM t", opts);
    check("  a tail after SELECT 1 is not 'none'", none.kind, "unknown");
    db.close();
  },

  // WHAT THESE DO NOT ESTABLISH. They exercise the function; they do not prove
  // either branch of `runCase` calls it; the only evidence the branches call it
  // is a hand demonstration that no longer runs. A passing assertion that looks
  // like coverage of the thing it does not cover is worse than no assertion,
  // because it answers the question a future reader would otherwise go and ask.
  "excerpt keeps both ends and marks what it dropped"() {
    const head = "HEAD-MARKER";
    const tail = "TAIL-MARKER";
    const budget = 32;
    const long = head + "x".repeat(500) + tail;
    const cut = excerpt(long, budget);
    check("  head survives", cut.startsWith(head), true);
    check("  tail survives", cut.endsWith(tail), true);
    const dropped = long.length - budget * 2;
    check(
      "  elision is marked with the count",
      cut.includes(elisionMarker(dropped)),
      true,
    );
    // Above the tail, not appended after it: a marker below the last line reads
    // as part of the output rather than as a note about what is missing.
    check(
      "  the marker sits above the tail",
      cut.indexOf(elisionMarker(dropped)) < cut.lastIndexOf(tail),
      true,
    );
    check(
      "  nothing but the marker is added",
      cut.length,
      budget * 2 + elisionMarker(dropped).length + 2,
    );
  },

  "excerpt prints a short input once, whole"() {
    const short = "SHORT-MARKER all of it";
    const cut = excerpt(short, 32);
    check("  returned whole", cut, short);
    check("  printed once", cut.split("SHORT-MARKER").length - 1, 1);
    check("  no elision marker", cut.includes("elided"), false);
    check("  input is trimmed", excerpt(`  ${short}  `, 32), short);
  },

  "excerpt elides at exactly one character over the budget"() {
    const budget = 16;
    const atLimit = "y".repeat(budget * 2);
    check("  at the boundary it is whole", excerpt(atLimit, budget), atLimit);
    const overBy1 = "y".repeat(budget * 2 + 1);
    check(
      "  one character more is elided",
      excerpt(overBy1, budget).includes(elisionMarker(1)),
      true,
    );
    // The default budget is a real value the call sites rely on, not a shape.
    check("  the default budget", EXCERPT_BUDGET, 400);
    check(
      "  the default applies when none is given",
      excerpt("z".repeat(EXCERPT_BUDGET * 2)).length,
      EXCERPT_BUDGET * 2,
    );
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
