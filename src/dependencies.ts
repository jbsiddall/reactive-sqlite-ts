/**
 * Which tables a statement actually touches, and how much of that answer is
 * trustworthy.
 *
 * A live query needs to know what to watch. The obvious answer - parse the
 * SQL - is wrong in the quiet direction, and so is the obvious shortcut of
 * recording the names the caller wrote. SQLite's authorizer is asked about
 * every table access a statement makes while it is being compiled, including
 * the ones the SQL never mentions, so that is what this module reads.
 *
 * There is no registry here, no `stale` flag, no re-run and no diff. This
 * module answers one question about one statement, once. See "What the next
 * chunk receives" at the bottom.
 *
 * ## Partial looks like it works
 *
 * This is the hazard the whole shape of {@linkcode Dependencies} exists for.
 * An extractor that returns `{a}` for a query that really depends on `{a, b}`
 * produces a live query that refreshes on most writes and is silently stale on
 * the rest. Every test that writes to `a` passes. Nothing is ever thrown, and
 * the bug surfaces as "it sometimes doesn't update", months later, in
 * production.
 *
 * So an incomplete answer is never returned as though it were complete.
 * Anything this module knows it cannot see through downgrades the result to
 * {@linkcode Dependencies} kind `"unknown"` and says why in `limits`, rather
 * than being quietly left out of the set. The vocabulary is deliberately the
 * one already used for commit batches - `"complete"` and `"unknown"` mean here
 * what they mean on `Batch.coverage`.
 *
 * And a statement that touches no table at all is its own kind, `"none"`,
 * which carries no `reads`/`writes` fields, so it cannot be confused with a
 * failure by a caller that reaches for the sets without branching. `SELECT 1`
 * really does depend on nothing and really should never be refreshed; a
 * statement whose extraction failed must not be given that treatment. Making
 * the two different shapes in the type is the same move
 * `Resolution["unattributable-shadow"]` makes: the case with no honest set is
 * a compile error to ignore.
 *
 * ## What the authorizer reports, measured
 *
 * All of this on SQLite 3.45.1 and 3.53.4, 2026-09-09, with identical results.
 *
 * - **A view reports both halves.** `SELECT * FROM v` where
 *   `v AS SELECT a FROM t` produces `read(t, a, main, "v")` *and*
 *   `read(v, a, main, null)`. Recording the name the caller wrote - `v` - is
 *   the plausible wrong implementation: it is exactly what the SQL says, and
 *   the live query never fires, because SQLite never reports a change on a
 *   view. The view is dropped here and the underlying table kept.
 * - **A trigger body is reported, attributed to the trigger.**
 *   `INSERT INTO u VALUES (9)` with an `AFTER INSERT ON u` trigger writing
 *   `log` produces `insert(u, -, main, null)` and
 *   `insert(log, -, main, "trg")`. `log` appears in no SQL anyone wrote.
 * - **`arg4` is not a view/trigger marker.** A CTE uses it too:
 *   `WITH x AS (SELECT c FROM u) SELECT a FROM t, x` produces
 *   `read(u, c, main, "x")`. Anything keying on "arg4 non-null means the
 *   access came from inside a view or trigger" misclassifies every CTE.
 * - **A virtual table names itself at compile time, its shadows at step
 *   time.** Preparing `SELECT body FROM ft WHERE ft MATCH 'hello'` reports
 *   only `read(ft, ...)`; the reads of `ft_idx` and `ft_content` arrive when
 *   the statement is stepped. Since this module compiles and never steps, an
 *   FTS5 query comes out as `ft` directly. Canonicalisation still matters and
 *   is still applied, for the case that does report a shadow at compile time:
 *   a query written against one, `SELECT * FROM ft_content`, which resolves
 *   to `ft`. This is why chunks 1 and 2 came first - and note the mirror
 *   direction, where change events name only the shadows, remains
 *   {@linkcode SchemaMap.shadowsOf}'s job and chunk 4's problem.
 * - **The schema can be NULL.** `SELECT count(*) FROM t` reports
 *   `read(t, "", null, null)` - no schema - whether `t` is in `main` or in
 *   `temp`. "Null means main" is therefore wrong, and wrong silently. See
 *   {@linkcode SchemaMap.schemasContaining}.
 * - **Foreign key cascades ARE reported.** `DELETE FROM t` with
 *   `ON DELETE CASCADE` reports `delete(child, ...)` at compile time.
 * - **A recursive CTE naming no table reports no read**, only `recursive`,
 *   so it comes out `"none"` and not a false dependency on itself.
 *
 * ## The authorizer is shared, and extraction sits upstream of the verdict
 *
 * SQLite allows one authorizer per connection and this library already holds
 * it, so extraction joins the existing dispatch rather than displacing it. A
 * caller's own `authorize` listener therefore runs on the same events. It was
 * measured (3.45.1 and 3.53.4, 2026-09-09) that this does *not* make a
 * statement's dependency set depend on that listener: every listener runs
 * before the verdict is latched, so with a listener returning `deny()` or
 * `ignore()` on a read of `u`, `SELECT t.a, u.c FROM t JOIN u ...` still
 * extracts `{t, u}` - in both listener orderings.
 *
 * `deny` is different, and it is different in the safe direction. A denied
 * access fails the compile outright, so the accesses SQLite had not yet
 * reached are never reported: denying the *first* table of that join yields
 * `{t}` and no `u`. A truncated set is precisely the silent-staleness bug, so
 * it is never published - the compile threw, and a compile that threw is kind
 * `"failed"`, which carries no `reads` and no `writes` at all. This holds
 * wherever the denied table sits in the statement: a `deny` anywhere makes
 * extraction fail loudly rather than return a short, confident answer.
 *
 * `ignore` is the case where the upstream position earns its keep: the
 * compile succeeds, the column reads NULL, and the set is still `{t, u}`.
 *
 * ## Stated limits, measured rather than assumed
 *
 * - **Only the first statement of a multi-statement string is compiled**, so
 *   `SELECT x FROM m; SELECT z FROM tmp` reports `m` and never `tmp`
 *   (measured). This module cannot detect a trailing statement - nothing in
 *   the driver exposes the unused tail - so it is a documented precondition,
 *   not a downgrade. Pass one statement.
 * - **The set describes the statement as compiled now.** If the schema
 *   changes, SQLite re-compiles a prepared statement transparently at the next
 *   step, and it was measured that the authorizer fires *again* at that point
 *   with the *new* dependencies: with `v AS SELECT x FROM p` prepared and then
 *   redefined to `SELECT y FROM q`, stepping the old statement reports `q`.
 *   An answer from this module is correct for the schema it was taken under
 *   and stops being correct when the schema changes. Reacting to that is the
 *   next chunk's job, not this one's.
 *
 * ## What the next chunk receives
 *
 * Chunk 4 is the registry and statement-level staleness. It receives
 * {@linkcode Dependencies} values and must decide, none of which is decided
 * here:
 *
 * - what to do with kind `"unknown"` - refresh on every commit, refuse to
 *   register, or ask the caller;
 * - when a stored set stops being valid, given the re-compile limit above;
 * - how a set of {@linkcode TableRef}s is matched against a commit batch,
 *   including expanding a virtual table through
 *   {@linkcode SchemaMap.shadowsOf} for the change-event direction, which is
 *   the mirror of the canonicalisation done here.
 *
 * The timing rule - that a dependency set must be in place before the first
 * commit that could invalidate it - is a constraint chunk 4 has to satisfy.
 * Nothing here implements it.
 *
 * @module
 */

import type { Database } from "@db/sqlite";
import { withEvents } from "./hooks.ts";
import type { AuthorizeAction, DbEvent } from "./hooks.ts";
import type { SchemaMap, TableRef } from "./schema_map.ts";

/** Raised when dependencies cannot be extracted at all. */
export class DependencyError extends Error {
  override readonly name = "DependencyError";
}

/**
 * What a statement turned out to touch.
 *
 * `reads` are the tables whose contents the statement depends on; `writes` are
 * the tables it changes, trigger bodies included. They are kept apart because
 * a live query watches the first and an invalidation router matches the
 * second, and a single merged set would silently serve one of them wrong.
 *
 * Both are canonical: shadow tables have become the virtual table that owns
 * them, and views are gone in favour of what their bodies read.
 */
export type Dependencies =
  | {
    /** Every table access was seen and resolved. */
    readonly kind: "complete";
    readonly reads: readonly TableRef[];
    readonly writes: readonly TableRef[];
  }
  | {
    /**
     * Something could not be seen through. The sets are a best effort and
     * must be treated as possibly missing a table; `limits` says what.
     */
    readonly kind: "unknown";
    readonly reads: readonly TableRef[];
    readonly writes: readonly TableRef[];
    /** One line per reason the answer is not `"complete"`. Never empty. */
    readonly limits: readonly string[];
  }
  | {
    /**
     * The statement compiled and touched no table. `SELECT 1`. No `reads`
     * and no `writes` fields at all, so this cannot be reached for as though
     * it were an empty answer of some other kind - and so that a caller
     * saying "this never needs refreshing" has had to say it deliberately.
     */
    readonly kind: "none";
  }
  | {
    /**
     * The statement did not compile, so nothing is known about what it would
     * have touched. No `reads` and no `writes`: a caller that treated a
     * failure as "depends on nothing" would build a live query that never
     * refreshes.
     */
    readonly kind: "failed";
    readonly error: Error;
  };

/** Everything {@linkcode extractDependencies} needs besides the statement. */
export interface ExtractOptions {
  /**
   * A reading of the same connection's schema. Shadow tables and views are
   * resolved through it, so a name it has never seen downgrades the result.
   */
  readonly schemaMap: SchemaMap;
  /**
   * Path of the libsqlite3 the driver loaded - the same value
   * {@linkcode withEvents} takes, and it must match any hooks already on the
   * connection.
   */
  readonly libPath: string;
}

/**
 * Authorize actions that carry no table dependency and are safe to ignore.
 *
 * Deliberately an allowlist rather than a denylist: an action this module has
 * never heard of, or one a future SQLite adds, falls through to a downgrade.
 * The alternative default - ignore what we do not recognise - is the one that
 * invents completeness.
 */
const HARMLESS: ReadonlySet<AuthorizeAction> = new Set<AuthorizeAction>([
  "select",
  "function",
  "transaction",
  "savepoint",
  "recursive",
]);

/** Actions that name a table the statement reads. */
const READS: ReadonlySet<AuthorizeAction> = new Set<AuthorizeAction>(["read"]);

/** Actions that name a table the statement changes. */
const WRITES: ReadonlySet<AuthorizeAction> = new Set<AuthorizeAction>([
  "insert",
  "update",
  "delete",
]);

const refKey = (r: TableRef): string =>
  `${r.schema.length}:${r.schema}${r.name}`;

/** Accumulates one side of the answer, deduplicated and sorted at the end. */
class RefSet {
  readonly #byKey = new Map<string, TableRef>();
  add(ref: TableRef): void {
    this.#byKey.set(refKey(ref), ref);
  }
  drain(): TableRef[] {
    return [...this.#byKey.values()].sort((a, b) =>
      a.schema === b.schema
        ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
        : (a.schema < b.schema ? -1 : 1)
    );
  }
}

/**
 * Turn one reported access into the tables it means, appending to `limits`
 * whenever the answer is less than certain. Returns the refs to record, which
 * may be none.
 */
function resolveAccess(
  map: SchemaMap,
  name: string,
  reportedSchema: string | null,
  limits: string[],
): TableRef[] {
  // A NULL schema is not "main": measured, `SELECT count(*) FROM t` reports no
  // schema for a TEMP table just as it does for a main one. Ask which schemas
  // hold the name instead of assuming.
  let schemas: string[];
  if (reportedSchema !== null) {
    schemas = [reportedSchema];
  } else {
    const found = map.schemasContaining(name);
    if (found.length === 0) {
      limits.push(
        `the access to "${name}" named no schema and the schema snapshot has never seen that name, so which table it is cannot be determined; it was recorded under "main"`,
      );
      schemas = ["main"];
    } else if (found.length > 1) {
      // Over-approximate rather than pick. Watching a table that did not
      // change costs a refresh; missing the one that did is the silent bug.
      limits.push(
        `the access to "${name}" named no schema and ${found.length} schemas (${
          found.join(", ")
        }) hold that name, so all of them were recorded`,
      );
      schemas = [...found];
    } else {
      schemas = [...found];
    }
  }

  const out: TableRef[] = [];
  for (const schema of schemas) {
    const r = map.resolveTable(name, schema);
    if (r.kind === "view") {
      // Not a dependency, and not an omission either: SQLite reports the
      // reads the view's body makes as separate accesses to the underlying
      // tables, which are picked up on their own. Recording the view instead
      // is the failure this module exists to avoid.
      continue;
    }
    if (r.kind === "unattributable-shadow") {
      limits.push(
        `"${schema}"."${name}" is a shadow table whose owning virtual table could not be derived, so the table a caller would recognise is unknown and nothing was recorded for it`,
      );
      continue;
    }
    if (r.kind === "unknown") {
      limits.push(
        `"${schema}"."${name}" is not in the schema snapshot, so it could be a shadow table of a virtual table created since the capture; it was recorded under its own name`,
      );
    }
    out.push({ schema, name: r.canonical });
  }
  return out;
}

/**
 * Compile `sql` on `db` and report the tables it touches.
 *
 * The statement is prepared and immediately finalized; it is never stepped, so
 * nothing is read and nothing is written. Pass exactly one statement - see the
 * module doc on multi-statement strings.
 *
 * @throws {DependencyError} if the connection cannot report authorize events.
 */
export function extractDependencies(
  db: Database,
  sql: string,
  options: ExtractOptions,
): Dependencies {
  const { schemaMap, libPath } = options;
  const reads = new RefSet();
  const writes = new RefSet();
  const limits: string[] = [];
  let capture = false;

  let anyAuthorize = 0;

  const listener = (event: DbEvent): void => {
    if (event.type !== "authorize") return;
    anyAuthorize++;
    if (!capture) return;
    const { action, arg1, arg3 } = event;
    if (HARMLESS.has(action)) return;
    const wantsRead = READS.has(action);
    const wantsWrite = WRITES.has(action);
    if (!wantsRead && !wantsWrite) {
      limits.push(
        `the statement performed a "${action}" access, which names schema objects this extractor does not follow`,
      );
      return;
    }
    if (arg1 === null) {
      limits.push(
        `a "${action}" access named no table, so what it touched is unknown`,
      );
      return;
    }
    for (const ref of resolveAccess(schemaMap, arg1, arg3, limits)) {
      (wantsRead ? reads : writes).add(ref);
    }
  };

  let sub;
  try {
    sub = withEvents(db, listener, libPath, { authorize: true });
  } catch (cause) {
    throw new DependencyError(
      `could not attach the authorizer needed to extract dependencies: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  }

  try {
    // A known answer, not a capability flag. `capabilities.authorize` says
    // the library can do it; it does not say this connection's registration
    // installed it, and options are per connection - a first `withEvents`
    // without `authorize: true` leaves the hook off and joining cannot turn
    // it on. Without this check that case returns `"none"` for every
    // statement: a live query that never refreshes, produced by a mechanism
    // that silently did nothing.
    //
    // The probe is a fixed `SELECT 1`, never the caller's SQL, because the
    // caller's SQL is exactly what has no known answer yet. Measured on
    // 3.45.1 and 3.53.4 (2026-09-09): every statement that compiles reports
    // at least one authorize event except `VACUUM` and `REINDEX`, so a fixed
    // `SELECT 1` is the one that can be relied on.
    anyAuthorize = 0;
    db.prepare("SELECT 1").finalize();
    if (anyAuthorize === 0) {
      throw new DependencyError(
        "no authorize event arrived for a statement that must produce one, so the authorizer is not installed on this connection; hooks attached without `authorize: true` cannot be upgraded, because options are per connection",
      );
    }
    let failure: Error | null = null;
    capture = true;
    try {
      db.prepare(sql).finalize();
    } catch (cause) {
      failure = cause instanceof Error ? cause : new Error(String(cause));
    } finally {
      capture = false;
    }
    // A compile that threw reports nothing about the accesses SQLite had not
    // reached yet - a denied first table truncates the rest, measured - so the
    // partial set is withheld rather than published as an answer.
    if (failure !== null) return { kind: "failed", error: failure };

    const r = reads.drain();
    const w = writes.drain();
    if (limits.length > 0) {
      return { kind: "unknown", reads: r, writes: w, limits };
    }
    // Emptiness, not a flag: a statement whose only access was to a view that
    // itself reads nothing genuinely depends on nothing, and should get the
    // same answer as `SELECT 1` rather than an empty "complete".
    if (r.length === 0 && w.length === 0) return { kind: "none" };
    return { kind: "complete", reads: r, writes: w };
  } finally {
    sub.dispose();
  }
}
