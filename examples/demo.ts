/**
 * Exercises every commit-lifecycle event in ../src/hooks.ts against a real
 * database.
 *
 * A demo, not the test suite: see ../test/suite.ts (`deno task test`) for the
 * assertions. Run this one with `deno task demo`.
 *
 * @db/sqlite picks its library from DENO_SQLITE_PATH at import time, and our
 * hooks must dlopen that same file, so resolve it before importing either.
 */
import { resolveLibPath } from "../src/lib_path.ts";

const LIB = resolveLibPath();
console.log(`using ${LIB}`);

const { Database } = await import("@db/sqlite");
const { probeCapabilities, withEvents, withValidation } = await import(
  "../src/hooks.ts"
);
type DbEvent = import("../src/hooks.ts").DbEvent;

const CAPS = probeCapabilities(LIB);
console.log(
  `preupdate (row values, validation): ${
    CAPS.preupdate
      ? "available"
      : `NOT available — ${CAPS.preupdateUnavailable}`
  }`,
);

const db = new Database(":memory:");
let vetoNext = false;
const seen: string[] = [];
let lastBatch = 0;

withEvents(db, (e: DbEvent) => {
  // per-row noise; the batched events are the interesting ones
  if (e.type === "change" || e.type === "preupdate") return undefined;
  const rows = e.changes.length > 5
    ? `${e.changes.length} rows`
    : e.changes.map((c) => `${c.op} ${c.table}#${c.rowid}`).join(", ") ||
      `(no rows observed, coverage: ${e.coverage})`;
  seen.push(e.type);
  if (e.type === "postcommit") lastBatch = e.changes.length;
  console.log(`   [${e.type}] ${rows}`);
  if (e.type === "precommit" && vetoNext) {
    console.log("   [veto]");
    return false;
  }
  return undefined;
}, LIB);

/** JSON.stringify refuses bigints, and every INTEGER column is one. */
const bigints = (_k: string, v: unknown) => typeof v === "bigint" ? `${v}` : v;

const rows = () =>
  db.prepare("SELECT count(*) c FROM t").get<{ c: number }>()!.c;
const expect = (label: string, actual: unknown, wanted: unknown) => {
  const ok = String(actual) === String(wanted);
  console.log(
    `   ${ok ? "ok" : "FAIL"}: ${label} = ${actual}${
      ok ? "" : ` (wanted ${wanted})`
    }`,
  );
  if (!ok) Deno.exitCode = 1;
};

db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT UNIQUE)");

console.log("\n1. autocommit inserts through the driver's prepare/bind API");
const ins = db.prepare("INSERT INTO t VALUES (?, ?)");
ins.run(1, "a");
ins.run(2, "b");

console.log(
  "\n2. explicit transaction — update + delete batched into one commit",
);
db.exec("BEGIN");
db.exec("UPDATE t SET v='z' WHERE id=1");
db.exec("DELETE FROM t WHERE id=2");
db.exec("COMMIT");

console.log("\n3. explicit ROLLBACK");
db.exec("BEGIN");
ins.run(3, "c");
db.exec("ROLLBACK");
expect("rows after rollback", rows(), 1);

console.log("\n4. precommit veto converts the COMMIT into a ROLLBACK");
vetoNext = true;
try {
  ins.run(4, "d");
} catch (err) {
  console.log(`   run() threw: ${(err as Error).message}`);
}
vetoNext = false;
expect("rows after veto", rows(), 1);

console.log("\n5. a failing statement inside a transaction");
db.exec("BEGIN");
ins.run(5, "e");
try {
  ins.run(6, "e"); // duplicate of the UNIQUE value above
} catch (err) {
  console.log(`   run() threw: ${(err as Error).message}`);
}
db.exec("ROLLBACK");
expect("rows after failed statement", rows(), 1);

console.log("\n6. db.transaction() helper");
db.transaction(() => {
  ins.run(7, "g");
  ins.run(8, "h");
})();
expect("rows after transaction()", rows(), 3);

console.log(
  "\n7. re-entrancy — querying from inside a listener does not recurse",
);
const nested = new Database(":memory:");
withEvents(nested, (e) => {
  if (e.type === "postcommit") {
    console.log(
      `   nested read inside postcommit saw ${
        nested.prepare("SELECT count(*) c FROM n").get<{ c: number }>()!.c
      } row(s)`,
    );
  }
}, LIB);
nested.exec("CREATE TABLE n(id INTEGER PRIMARY KEY)");
nested.exec("INSERT INTO n VALUES (1)");
nested.close();

console.log("\n8. a 1000-row transaction arrives as a single batch");
// Reuses the listener registered at the top. A second withEvents on the same
// connection would now join it rather than clobber it — see the README.
const big = db.prepare("INSERT INTO t VALUES (?, ?)");
db.exec("BEGIN");
for (let i = 100; i < 1100; i++) big.run(i, `v${i}`);
db.exec("COMMIT");
expect("batch size", lastBatch, 1000);
expect("rows at end", rows(), 1003);

console.log("\n9. preupdate: the row itself, before it changes");
const rowDb = new Database(":memory:");
rowDb.exec(
  "CREATE TABLE person(id INTEGER PRIMARY KEY, name TEXT, age INTEGER)",
);
let lastRow = "";
if (CAPS.preupdate) {
  withEvents(rowDb, (e) => {
    if (e.type !== "preupdate") return;
    lastRow = `${e.op} ${e.table} old=${JSON.stringify(e.old, bigints)} new=${
      JSON.stringify(e.new, bigints)
    }`;
    console.log(`   [preupdate] ${lastRow}`);
  }, LIB);
  rowDb.exec("INSERT INTO person VALUES (1, 'ada', 36)");
  rowDb.exec("UPDATE person SET age = 37 WHERE id = 1");
  rowDb.exec("DELETE FROM person WHERE id = 1");
  expect("last event was the delete", lastRow.startsWith("delete"), true);
} else {
  console.log("   skipped: this libsqlite3 has no preupdate hook");
}
rowDb.close();

console.log("\n10. withValidation: a JS veto on the values themselves");
if (CAPS.preupdate) {
  const guarded = new Database(":memory:");
  guarded.exec("CREATE TABLE acct(id INTEGER PRIMARY KEY, balance INTEGER)");
  withValidation(guarded, (row) => {
    if (row.new && (row.new.balance as bigint) < 0n) {
      return "balance must not go negative";
    }
    return undefined;
  }, LIB);
  guarded.exec("INSERT INTO acct VALUES (1, 100)");
  try {
    guarded.exec("INSERT INTO acct VALUES (2, -5)");
  } catch (err) {
    const parts = err instanceof AggregateError
      ? err.errors.map((e) => (e as Error).message)
      : [(err as Error).message];
    console.log(`   rejected: ${parts.join(" | ")}`);
  }
  expect(
    "only the valid row landed",
    guarded.prepare("SELECT count(*) c FROM acct").get<{ c: number }>()!.c,
    1,
  );
  // The surprise, spelled out: inside an explicit transaction the veto is
  // spent at COMMIT, so the good rows go with the bad one.
  guarded.exec("BEGIN");
  guarded.exec("INSERT INTO acct VALUES (3, 50)");
  guarded.exec("INSERT INTO acct VALUES (4, -1)");
  try {
    guarded.exec("COMMIT");
  } catch {
    console.log("   the whole transaction rolled back, not just the bad row");
  }
  expect(
    "rows after the vetoed transaction",
    guarded.prepare("SELECT count(*) c FROM acct").get<{ c: number }>()!.c,
    1,
  );
  guarded.close();
} else {
  console.log("   skipped: this libsqlite3 has no preupdate hook");
}

expect("every event type observed", new Set(seen).size >= 3, true);
db.close();
console.log(`\n${Deno.exitCode === 1 ? "FAILURES" : "all checks passed"}`);
