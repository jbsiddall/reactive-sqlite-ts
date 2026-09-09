/**
 * Keeping a {@linkcode SchemaMap} current when the schema changes underneath
 * it.
 *
 * {@linkcode captureSchemaMap} reads the schema once. `CREATE VIRTUAL TABLE`
 * or `DROP` later in the process makes that reading wrong, and wrong in the
 * quiet direction: a shadow table whose owner was created after the capture
 * resolves to `"unknown"` rather than to the virtual table, so a change over
 * it matches nothing. This module decides *when* a new reading is taken and
 * takes it. It is a trigger, not a policy engine: no subscription registry, no
 * query-to-tables extraction, no re-run of anything.
 *
 * ## The signal: the authorizer, not the commit batch
 *
 * Three sources were available. What was chosen, and what the other two would
 * have missed - all of it measured on 3.45.1 and 3.53.4, 2026-09-09, with
 * identical results:
 *
 * **Chosen: the authorizer's DDL action codes.** SQLite asks the authorizer
 * about every object a statement creates, drops or alters, at *prepare* time,
 * naming the object and its schema. `CREATE VIRTUAL TABLE ft USING fts5(body)`
 * reports `create_vtable` for `ft` and `create_table` for each of the five
 * shadow tables; `DROP TABLE ft` reports `drop_vtable` and five `drop_table`.
 * This library already owns that hook. It is precise - an ordinary
 * `INSERT`/`SELECT` reports none of these codes at all, which is what makes
 * "no DDL means no refresh" true by construction rather than by luck.
 *
 * **Rejected: `coverage: "unknown"` on a commit batch.** The reasoning was
 * that DDL writes to `sqlite_schema`, `update_hook` does not report that, so
 * the batch arrives empty. That is true of `CREATE TABLE` and of
 * `DROP TABLE` - and false of the one case this map exists for.
 * `CREATE VIRTUAL TABLE ft USING fts5(body)` commits with
 * `coverage: "complete"` and `changeCount: 2`, because creating an FTS5 table
 * writes rows into `ft_data` and `ft_config` and those are ordinary tables
 * that `update_hook` reports normally. A watcher keyed on `"unknown"` would
 * therefore miss every FTS5 creation while appearing to work on plain tables.
 * It also fires on incremental blob writes and on genuinely empty
 * transactions, so it over-refreshes in exactly the workloads where refreshing
 * is expensive.
 *
 * **Rejected: SQLite's schema cookie.** `PRAGMA schema_version` is reachable
 * and does move on every schema change, but it cannot be the trigger: reading
 * it is a query, so something must already have decided it is safe to run SQL
 * and worth doing - which is the decision this module exists to make. As a
 * confirmation step it is worse than nothing, because the cookie is *per
 * schema*: with `aux2` attached, `CREATE TABLE aux2.t3(z)` moved `aux2`'s
 * cookie from 0 to 1 and left `main`'s at 9. A single `PRAGMA
 * main.schema_version` guard would suppress refreshes for every ATTACHed
 * schema, silently.
 *
 * ### What the chosen signal misses
 *
 * The authorizer sees this connection's statements. A schema change made on
 * **another connection** to the same file produces no event here, and no
 * refresh. That is a real gap and it is not closed: closing it means polling,
 * and there is no safe point at which to poll that this module can choose on
 * the caller's behalf. {@linkcode SchemaWatch.refreshNow} is the escape hatch.
 *
 * `ATTACH` and `DETACH` also report to the authorizer - and produce **no
 * commit at all** (measured, both libraries). A watcher that only drains at
 * `postcommit` would stay armed until the next unrelated commit. So arming and
 * draining are separate, and {@linkcode SchemaWatch.refreshIfArmed} is public
 * for the caller who attaches and wants the map current immediately.
 *
 * ## Where refresh runs
 *
 * Refreshing issues SQL on the connection. Doing that from inside a SQLite
 * callback is forbidden - `change`, `preupdate`, `precommit`, `rollback`,
 * `authorize`, `busy` and `collation` listeners all run with the connection
 * off limits. `postcommit` does not: it is dispatched after the hook has
 * returned, and is the one event where using the connection is allowed.
 *
 * So {@linkcode SchemaWatch.observe} never refreshes except on `postcommit`,
 * and every refresh entry point refuses the illegal route rather than
 * documenting it: if the connection reports that a callback is on the stack,
 * {@linkcode SchemaWatchError} is thrown before any SQL is prepared. Arming is
 * a boolean write and is safe from anywhere.
 *
 * ## The bound on refreshing for an unknown name
 *
 * {@linkcode SchemaWatch.resolveOrRefresh} answers the question a caller
 * actually has when a resolution comes back `kind: "unknown"`: is my snapshot
 * stale, or does this name genuinely not exist? The only way to find out is to
 * re-read - and a name that will never appear must not cause a re-read every
 * time it is asked about. Unbounded staleness recovery against an absent name
 * is a hot loop that presents as a performance problem rather than the
 * correctness problem it is.
 *
 * The bound: **at most one refresh per `(schema, name)` per generation.** The
 * name is recorded as already tried by the refresh it caused, and the record
 * is cleared only by a refresh that a DDL signal asked for. So asking about a
 * permanently absent name N times costs exactly one refresh, not N; and after
 * real DDL the same name is eligible again, exactly once.
 *
 * Its residual, stated rather than hidden: K *distinct* absent names cost K
 * refreshes per generation. That is bounded by how many different names the
 * caller asks about, not by how often it asks, and the loop shape - the same
 * name forever - is gone. No cap is imposed on top of it, because a cap would
 * trade a bounded cost for silent permanent staleness.
 *
 * @module
 */
import {
  captureSchemaMap,
  type Resolution,
  type SchemaMap,
  type SchemaSource,
} from "./schema_map.ts";
import { insideHookOf } from "./hooks.ts";
import type { AuthorizeAction, DbEvent } from "./hooks.ts";

/** Raised when a refresh is asked for somewhere it cannot legally happen. */
export class SchemaWatchError extends Error {
  override readonly name = "SchemaWatchError";
}

/** Why a new snapshot was taken. */
export type RefreshReason =
  /** An authorizer DDL action armed the watch and a safe point was reached. */
  | "ddl"
  /** A caller asked about a name the snapshot did not have. */
  | "unknown-name"
  /** {@linkcode SchemaWatch.refreshNow} was called directly. */
  | "manual";

/**
 * The authorizer actions that can change what `PRAGMA table_list` reports.
 *
 * Deliberately wider than "virtual tables": a plain `CREATE TABLE` can make a
 * shadow *lookalike* appear next to a virtual table, and `ALTER TABLE` can
 * rename one. Index, trigger and view actions are here for the same reason -
 * they change the row set of `table_list` - and their cost is one extra
 * re-read of a schema that was already being written to.
 *
 * `attach` and `detach` are included and are the reason arming and draining
 * are separate: neither produces a commit.
 */
const DDL_ACTIONS: ReadonlySet<AuthorizeAction> = new Set<AuthorizeAction>([
  "create_index",
  "create_table",
  "create_temp_index",
  "create_temp_table",
  "create_temp_trigger",
  "create_temp_view",
  "create_trigger",
  "create_view",
  "create_vtable",
  "drop_index",
  "drop_table",
  "drop_temp_index",
  "drop_temp_table",
  "drop_temp_trigger",
  "drop_temp_view",
  "drop_trigger",
  "drop_view",
  "drop_vtable",
  "alter_table",
  "attach",
  "detach",
]);

/** True if this authorizer action can change what `PRAGMA table_list` lists. */
export function isSchemaChangingAction(action: AuthorizeAction): boolean {
  return DDL_ACTIONS.has(action);
}

export interface SchemaWatchOptions {
  /**
   * Whether a SQLite callback is currently on this connection's stack, in
   * which case no refresh may issue SQL. Defaults to
   * {@linkcode connectionInsideHook} for the given source, which answers
   * correctly for a `Database` that {@linkcode withEvents} is attached to and
   * `false` for anything else.
   */
  readonly insideHook?: () => boolean;
  /** Called after every completed refresh, with the new snapshot. */
  readonly onRefresh?: (map: SchemaMap, reason: RefreshReason) => void;
}

function key(schema: string, name: string): string {
  // Length-prefixed, not separated: quoted identifiers are arbitrary text, so
  // any separator character can appear inside a name. Same reasoning as the
  // key in schema_map.ts.
  return `${schema.length}:${schema}${name}`;
}

/**
 * A {@linkcode SchemaMap} that is re-read when the schema changes.
 *
 * Feed it every event from {@linkcode withEvents} through
 * {@linkcode SchemaWatch.observe}; read the current snapshot from
 * {@linkcode SchemaWatch.map}. See the module documentation for the signal
 * chosen, where refresh runs, and the bound on unknown-name refreshing.
 */
export class SchemaWatch {
  readonly #db: SchemaSource;
  readonly #insideHook: () => boolean;
  readonly #onRefresh:
    | ((map: SchemaMap, reason: RefreshReason) => void)
    | undefined;
  #map: SchemaMap;
  #armed = false;
  #generation = 0;
  #refreshes = 0;
  /** Names already refreshed for at this generation. See the bound. */
  #tried = new Set<string>();

  constructor(
    db: SchemaSource,
    map: SchemaMap,
    options: SchemaWatchOptions = {},
  ) {
    this.#db = db;
    this.#map = map;
    this.#insideHook = options.insideHook ?? (() => connectionInsideHook(db));
    this.#onRefresh = options.onRefresh;
  }

  /** The current snapshot. Replaced wholesale by a refresh; never mutated. */
  get map(): SchemaMap {
    return this.#map;
  }

  /** How many snapshots ago the first one was. Starts at 0. */
  get generation(): number {
    return this.#generation;
  }

  /**
   * How many refreshes have completed. The number a test asserts on: a
   * workload with no DDL in it must leave this at zero.
   */
  get refreshCount(): number {
    return this.#refreshes;
  }

  /** A DDL action has been seen and no safe point has been reached yet. */
  get armed(): boolean {
    return this.#armed;
  }

  /**
   * Feed every {@linkcode DbEvent} here. Never issues SQL except on
   * `postcommit`, which is the one event where the connection is usable.
   *
   * An `authorize` event carrying a DDL action arms the watch. A `postcommit`
   * drains it. A `rollback` disarms without refreshing: the transaction
   * changed nothing, so the snapshot is still right.
   */
  observe(event: DbEvent): void {
    if (event.type === "authorize") {
      if (isSchemaChangingAction(event.action)) this.#armed = true;
      return;
    }
    if (event.type === "rollback") {
      this.#armed = false;
      return;
    }
    if (event.type === "postcommit") {
      this.refreshIfArmed();
    }
  }

  /**
   * Take a new snapshot if a DDL action has been seen since the last one.
   * Returns whether it did.
   *
   * Public because `ATTACH` and `DETACH` produce no commit (measured, both
   * libraries), so a caller that attaches has no `postcommit` to drain on.
   * Safe to call at any point where the connection is usable; throws
   * {@linkcode SchemaWatchError} anywhere it is not.
   */
  refreshIfArmed(): boolean {
    if (!this.#armed) return false;
    this.#armed = false;
    this.#refresh("ddl");
    return true;
  }

  /**
   * Take a new snapshot unconditionally.
   *
   * The escape hatch for the gap the authorizer cannot see: a schema change
   * made on another connection to the same file.
   */
  refreshNow(): SchemaMap {
    this.#armed = false;
    return this.#refresh("manual");
  }

  /**
   * {@linkcode SchemaMap.resolveTable}, with one bounded re-read when the
   * snapshot does not know the name.
   *
   * This is the answer to "what does a caller do with `kind: "unknown"`". It
   * refreshes at most once per `(schema, name)` per generation - the name is
   * recorded as spent by the refresh, and the record is cleared only by a
   * DDL-triggered refresh - so a name that will never appear costs exactly one
   * refresh no matter how often it is asked about.
   *
   * Issues SQL, so it must not be called from inside a hook listener; it
   * throws {@linkcode SchemaWatchError} if it is. From a `change` or
   * `precommit` listener use {@linkcode SchemaWatch.map} and handle
   * `"unknown"` there.
   */
  resolveOrRefresh(name: string, schema = "main"): Resolution {
    const first = this.#map.resolveTable(name, schema);
    if (first.kind !== "unknown") return first;
    const k = key(schema, name);
    if (this.#tried.has(k)) return first;
    // Recorded only after the refresh has actually happened, so a refusal
    // (inside a hook) does not silently spend the name's one attempt.
    const map = this.#refresh("unknown-name");
    this.#tried.add(k);
    return map.resolveTable(name, schema);
  }

  #refresh(reason: RefreshReason): SchemaMap {
    if (this.#insideHook()) {
      throw new SchemaWatchError(
        `refreshing the schema map (${reason}) was attempted from inside a SQLite callback. ` +
          "Re-reading the schema issues SQL on the connection, which is undefined behaviour there. " +
          "Refresh from a postcommit listener, or from your own code outside any listener; " +
          'inside a change/preupdate/precommit/authorize listener, read SchemaWatch.map and handle kind "unknown".',
      );
    }
    this.#map = this.#map.refresh(this.#db);
    this.#generation += 1;
    this.#refreshes += 1;
    // Only a DDL signal means the world actually moved, so only that makes an
    // already-missed name worth asking about again. Clearing here on every
    // refresh would let an absent name refresh forever.
    if (reason === "ddl" || reason === "manual") this.#tried.clear();
    this.#onRefresh?.(this.#map, reason);
    return this.#map;
  }
}

/**
 * Capture a snapshot and wrap it in a watch.
 *
 * The returned watch is inert until events are fed to
 * {@linkcode SchemaWatch.observe}.
 */
export function watchSchema(
  db: SchemaSource,
  options: SchemaWatchOptions = {},
): SchemaWatch {
  return new SchemaWatch(db, captureSchemaMap(db), options);
}

/**
 * Whether a SQLite callback is on the stack for this connection.
 *
 * `false` for a connection {@linkcode withEvents} was never attached to -
 * there are no hooks on it, so there is no callback to be inside.
 */
export function connectionInsideHook(db: unknown): boolean {
  return insideHookOf(db);
}
