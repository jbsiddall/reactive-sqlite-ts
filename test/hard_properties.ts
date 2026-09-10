/**
 * The HARD invariant: no permutation of API calls may take the process down.
 *
 * Every other property in this repo is about semantics and runs in process
 * (see ./properties.ts). This one is about survival, so it is registered as a
 * crash-matrix case and judged on the child's EXIT CODE — a JS exception from
 * a misuse is a pass, a SIGSEGV is not, and the two cannot be confused.
 *
 * fast-check cannot shrink a counterexample that killed the process, so each
 * generated sequence is printed BEFORE it runs. Whatever the child died on is
 * the last sequence in its output, which is the reproduction.
 */
import { fc, SEED } from "./deps.ts";
import { resolveLibPath } from "./../src/lib_path.ts";

const LIB = resolveLibPath();
const { Database } = await import("../driver/mod.ts");
const { withEvents } = await import("../src/hooks.ts");
type Sub = import("../src/hooks.ts").Subscription;
type Db = InstanceType<typeof Database>;

const OPS = [
  "attach",
  "attach-throwing",
  "attach-thenable",
  "dispose",
  "dispose-again",
  "insert",
  "update",
  "delete",
  "transaction",
  "nested-transaction",
  "veto-batch",
  "blob-write",
  "close",
  "use-after-close",
] as const;

type Op = typeof OPS[number];

function play(ops: readonly Op[]): void {
  const db: Db = new Database(":memory:");
  db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT, b BLOB)");
  db.exec("INSERT INTO t VALUES (1, 'seed', zeroblob(8))");
  // The invariant is about a connection THIS library is watching: it guards
  // use-after-close by patching the driver's methods, so a sequence that
  // disposed every subscription would be testing the bare driver instead.
  const watch = withEvents(db, () => {}, LIB, { onListenerError: () => {} });
  const subs: Sub[] = [];
  let n = 1;
  const quietly = (f: () => void) => {
    try {
      f();
    } catch { /* a misuse must throw; only a crash is a failure */ }
  };
  for (const op of ops) {
    quietly(() => {
      switch (op) {
        case "attach":
          subs.push(
            withEvents(db, () => {}, LIB, { onListenerError: () => {} }),
          );
          return;
        case "attach-throwing":
          subs.push(withEvents(
            db,
            () => {
              throw new Error("listener");
            },
            LIB,
            { onListenerError: () => {} },
          ));
          return;
        case "attach-thenable":
          subs.push(
            withEvents(db, () => Promise.resolve(false), LIB, {
              onListenerError: () => {},
            }),
          );
          return;
        case "dispose":
        case "dispose-again":
          subs[subs.length - 1]?.dispose();
          return;
        case "insert":
          db.exec(`INSERT INTO t VALUES (${++n + 1}, 'x', zeroblob(4))`);
          return;
        case "update":
          db.exec("UPDATE t SET v = 'y' WHERE id = 1");
          return;
        case "delete":
          db.exec("DELETE FROM t WHERE id > 1");
          return;
        case "transaction":
          db.transaction(() => {
            db.exec("UPDATE t SET v = 'tx' WHERE id = 1");
          })();
          return;
        case "nested-transaction":
          db.exec("BEGIN");
          db.exec("SAVEPOINT s");
          db.exec("UPDATE t SET v = 'nested' WHERE id = 1");
          db.exec("RELEASE s");
          db.exec("COMMIT");
          return;
        case "veto-batch": {
          const sub = withEvents(
            db,
            (e) => e.type === "precommit" ? false : undefined,
            LIB,
            {
              onListenerError: () => {},
            },
          );
          quietly(() => {
            db.exec("BEGIN");
            db.exec("INSERT INTO t VALUES (900, 'vetoed', NULL)");
            db.exec("COMMIT");
          });
          sub.dispose();
          return;
        }
        case "blob-write": {
          const blob = db.openBlob({ table: "t", column: "b", row: 1 });
          try {
            blob.writeSync(0, new Uint8Array([1, 2, 3, 4]));
          } finally {
            blob.close();
          }
          return;
        }
        case "close":
          db.close();
          return;
        case "use-after-close":
          db.exec("SELECT 1");
          return;
      }
    });
  }
  quietly(() => {
    for (const s of subs) s.dispose();
  });
  quietly(() => watch.dispose());
  quietly(() => db.close());
}

/** Runs the hard invariant. Prints each sequence first, so a death names itself. */
export function runHardProperty(runs: number): void {
  console.log(`hard property: seed ${SEED}, ${runs} runs`);
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom(...OPS), { minLength: 1, maxLength: 10 }),
      (ops) => {
        console.error(`seq ${ops.join(" ")}`);
        play(ops);
        return true;
      },
    ),
    { numRuns: runs, seed: SEED },
  );
  console.log("survived");
}
