/**
 * The SOFT property suite: semantics, in this process, under `deno task test`.
 *
 * A failure here means the library did something it documents it will not do.
 * That is a different bug, with a different urgency, from the HARD invariant
 * in ./crash_cases.ts ("no permutation of API calls may segfault"), which runs
 * out of process and is judged on an exit code. Keep them apart: a suite that
 * reports a semantic mismatch the way it reports a crash teaches people to
 * ignore both.
 *
 * Every property asserts against RAW values, exactly as the hooks deliver
 * them — bigint rowids, Uint8Array blobs, text with embedded NULs — and never
 * against a decoded form. Row snapshots go through SQLite's own quote(), not
 * through the driver's value decoding, so a future decoding layer cannot
 * change what these properties mean.
 */
import { fc, SEED } from "./deps.ts";
import { resolveLibPath } from "../src/lib_path.ts";

const LIB = resolveLibPath();
const { Database } = await import("@db/sqlite");
const { withEvents } = await import("../src/hooks.ts");
type DbEvent = import("../src/hooks.ts").DbEvent;
type Db = InstanceType<typeof Database>;

const RUNS = 200;
const params = { numRuns: RUNS, seed: SEED };

const fresh = (): Db => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v)");
  return db;
};

/**
 * The table as SQLite itself renders it: quote() produces X'..' for a blob and
 * escapes text, so this is byte-exact and owes nothing to the driver.
 */
const snapshot = (db: Db): string =>
  db.prepare(
    "SELECT coalesce(group_concat(quote(id) || '=' || quote(v), char(10)), '') s " +
      "FROM (SELECT id, v FROM t ORDER BY id)",
  ).get<{ s: string }>()?.s ?? "";

/** One value of each storage class, generated raw and never decoded. */
const value = () =>
  fc.oneof(
    fc.integer({ min: -1000, max: 1000 }),
    // -0 is excluded because @db/sqlite 0.13.0 cannot bind it: it reaches
    // sqlite3_bind_int and throws "Invalid FFI i32 type, expected integer".
    fc.double({ noNaN: true, noDefaultInfinity: true }).filter((d) =>
      !Object.is(d, -0)
    ),
    fc.string(),
    fc.constant(null),
    fc.uint8Array({ maxLength: 8 }),
  );

const write = () =>
  fc.record({ id: fc.integer({ min: 1, max: 12 }), v: value() });

type Write = { id: number; v: number | string | null | Uint8Array };

const apply = (db: Db, writes: readonly Write[]) => {
  const ins = db.prepare("INSERT OR REPLACE INTO t VALUES (?, ?)");
  try {
    for (const w of writes) ins.run(w.id, w.v);
  } finally {
    ins.finalize();
  }
};

/** Thenables a listener might plausibly return, including non-Promise ones. */
const thenable = () =>
  fc.oneof(
    fc.constant(() => Promise.resolve(false)),
    fc.constant(() => Promise.resolve(true)),
    fc.constant(() => Promise.reject(new Error("nope")).catch(() => false)),
    fc.constant(() => ({ then: () => false })),
    fc.constant(() => ({ then: (r: (v: boolean) => void) => r(false) })),
    fc.constant(async () => {
      await Promise.resolve();
      return false;
    }),
  );

export const PROPERTIES: Record<string, () => void> = {
  "a thenable precommit verdict never permits the write, whatever its shape"() {
    fc.assert(
      fc.property(thenable(), fc.array(write(), { maxLength: 5 }), (mk, ws) => {
        const db = fresh();
        try {
          withEvents(
            db,
            (e) => e.type === "precommit" ? mk() : undefined,
            LIB,
            {
              onListenerError: () => {},
            },
          );
          try {
            apply(db, ws);
          } catch { /* the refusal surfaces as a SQL error */ }
          return snapshot(db) === "";
        } finally {
          db.close();
        }
      }),
      params,
    );
  },

  "a vetoed transaction leaves the database byte-identical"() {
    fc.assert(
      fc.property(
        fc.array(write(), { maxLength: 6 }),
        fc.array(write(), { minLength: 1, maxLength: 6 }),
        (before, doomed) => {
          const db = fresh();
          try {
            apply(db, before);
            const was = snapshot(db);
            let veto = false;
            withEvents(
              db,
              (e) => e.type === "precommit" ? !veto : undefined,
              LIB,
              {
                onListenerError: () => {},
              },
            );
            veto = true;
            try {
              db.exec("BEGIN");
              apply(db, doomed);
              db.exec("COMMIT");
            } catch { /* the veto turns the COMMIT into a ROLLBACK */ }
            return snapshot(db) === was;
          } finally {
            db.close();
          }
        },
      ),
      params,
    );
  },

  "coverage is never 'complete' when rows went unretained"() {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.array(write(), { minLength: 1, maxLength: 12 }),
        (cap, ws) => {
          const db = fresh();
          try {
            const seen: DbEvent[] = [];
            withEvents(db, (e) => void seen.push(e), LIB, {
              maxChangesPerTransaction: cap,
            });
            db.exec("BEGIN");
            apply(db, ws);
            db.exec("COMMIT");
            return seen.every((e) =>
              e.type !== "postcommit" ||
              (e.changeCount > e.changes.length
                ? e.coverage === "truncated"
                : e.coverage !== "truncated")
            );
          } finally {
            db.close();
          }
        },
      ),
      params,
    );
  },

  "an autocommit write emits exactly change*, precommit, postcommit"() {
    fc.assert(
      fc.property(fc.array(write(), { minLength: 1, maxLength: 6 }), (ws) => {
        const db = fresh();
        try {
          const types: string[] = [];
          withEvents(db, (e) => void types.push(e.type), LIB, {
            preupdate: "off",
          });
          apply(db, ws);
          const perStatement = types.join(",").split("postcommit").length - 1;
          return perStatement === ws.length &&
            types.filter((t) => t === "precommit").length === ws.length &&
            !types.includes("rollback");
        } finally {
          db.close();
        }
      }),
      params,
    );
  },
};

export const PROPERTY_SEED = SEED;
export const PROPERTY_RUNS = RUNS;
