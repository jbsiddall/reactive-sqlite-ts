/**
 * Which table name a change event or a query dependency really means.
 *
 * SQLite reports both halves of a virtual table's identity under names that
 * are not the name anyone wrote. Writing a row into an FTS5 table `ft` makes
 * `sqlite3_update_hook` fire on `ft_content`, `ft_docsize` and `ft_data` and
 * never on `ft`; reading it back with `MATCH` touches `ft_idx` and
 * `ft_content` at step time, again never `ft`. A live query that compares the
 * tables a statement read against the tables a commit changed will therefore
 * find no overlap for any virtual table, and will silently never invalidate.
 * The mismatch is bidirectional and both halves are this module's problem: it
 * canonicalises a reported name to the table a caller would recognise
 * ({@linkcode SchemaMap.resolveTable}), and it expands a virtual table to the
 * names SQLite will actually report changes on
 * ({@linkcode SchemaMap.shadowsOf}).
 *
 * There is no subscription machinery here, no registry, no invalidation and no
 * re-run - only the map.
 *
 * ## A snapshot, not a live view
 *
 * {@linkcode captureSchemaMap} reads the schema once and answers from that
 * reading forever. `CREATE VIRTUAL TABLE` after the capture is invisible to
 * it, and so is `DROP`. That is deliberate: the map is consulted from inside
 * hook callbacks, where issuing SQL against the connection is undefined
 * behaviour, so it cannot re-read on demand. {@linkcode SchemaMap.refresh} is
 * the entry point for taking a new reading; deciding *when* to call it is not
 * this module's job and nothing here calls it.
 *
 * ## How a shadow is recognised, and how it is attributed
 *
 * These are two different questions and they have two different answers.
 *
 * **Detection is authoritative.** `PRAGMA table_list` (SQLite 3.37+) reports a
 * `type` column of `table`, `virtual`, `shadow` or `view`, and `shadow` is
 * SQLite's own classification, not a guess from the name. Measured against
 * 3.45.1 and 3.53.4 on 2026-09-09: `sqlite_schema` reports every shadow with
 * `type` `'table'`, so it cannot substitute.
 *
 * **Attribution is conventional, and the convention is SQLite's.** Nothing
 * reports which virtual table owns a given shadow, so the owner is derived
 * from the name: the text before the *last* underscore, which must itself
 * name a virtual table in the same schema. That is the rule SQLite applies
 * when it decides whether a name is a shadow at all, which is why the derived
 * owner and the authoritative classification agree.
 *
 * The two were measured to agree in the strongest available sense: with the
 * owning virtual table's `sqlite_schema` row deleted under
 * `PRAGMA writable_schema` and the database reopened, every one of `ft`'s five
 * shadow tables reports `type` `'table'` (3.45.1 and 3.53.4, 2026-09-09).
 * `type = 'shadow'` therefore *entails* a live owning virtual table, and
 * attribution is total over the shadow set. See `DOMAIN_KNOWLEDGE.md`,
 * "Shadow tables and the virtual tables that own them".
 *
 * ## What happens when they disagree
 *
 * Both directions are real and neither falls through to identity.
 *
 * - **Detected as a shadow, no owner derivable.** Reported as
 *   {@linkcode Resolution} kind `"unattributable-shadow"`, which carries no
 *   `canonical` field at all, so a caller cannot use it as a table name
 *   without branching. The offenders are also listed on
 *   {@linkcode SchemaMap.unattributable}. Not reachable in any measurement
 *   made here - but if the entailment above ever stops holding, the map must
 *   say so rather than quietly answer `ft_data`.
 * - **Named like a shadow, not detected as one.** `CREATE TABLE ft_notes(x)`
 *   succeeds alongside the virtual table `ft` and `table_list` calls it a
 *   plain `table` (measured, both libraries, 2026-09-09), because FTS5's
 *   module rejects the suffix. Detection wins: it resolves to itself, it is
 *   *not* in {@linkcode SchemaMap.shadowsOf}`("ft")`, and it is listed on
 *   {@linkcode SchemaMap.shadowLookalikes} so that "why did my live query fire
 *   on ft" has an answer.
 *
 * ## Below the version floor
 *
 * `PRAGMA table_list` arrived in SQLite 3.37. An unrecognised pragma is not an
 * error in SQLite - it returns zero rows - so on an older library this module
 * would report a schema with no tables in it and every answer would be wrong
 * in the safe-looking direction. `table_list` on an open connection always
 * returns at least the `sqlite_schema` row, so zero rows is unambiguous:
 * {@linkcode captureSchemaMap} throws {@linkcode SchemaMapError} naming the
 * version rather than returning an empty map.
 *
 * @module
 */
/**
 * The little of a database connection this module uses. A `@db/sqlite`
 * `Database` satisfies it; so does a stub, which is how the paths below the
 * `PRAGMA table_list` version floor are tested without an ancient libsqlite3.
 */
export interface SchemaSource {
  prepare(sql: string): { all(): unknown[]; get(): unknown };
}

/** Raised when the schema cannot be read as this module needs it. */
export class SchemaMapError extends Error {
  override readonly name = "SchemaMapError";
}

/** A table named the way SQLite names it in a change event: schema and name. */
export interface TableRef {
  /** Schema name - "main", "temp", or an ATTACHed alias. */
  readonly schema: string;
  readonly name: string;
}

/**
 * What a reported table name turned out to be.
 *
 * The kinds that can be reduced to a table a caller would recognise carry
 * `canonical`; `"view"` and `"unattributable-shadow"` deliberately do not, so
 * that the two cases with no honest table name are a compile error to ignore
 * rather than a silent identity.
 */
export type Resolution =
  | {
    /** An ordinary table in the snapshot. Resolves to itself. */
    readonly kind: "table";
    readonly schema: string;
    readonly name: string;
    readonly canonical: string;
  }
  | {
    /** A virtual table in the snapshot. Resolves to itself. */
    readonly kind: "virtual";
    readonly schema: string;
    readonly name: string;
    readonly canonical: string;
  }
  | {
    /** A shadow table. `canonical` is the virtual table that owns it. */
    readonly kind: "shadow";
    readonly schema: string;
    readonly name: string;
    readonly canonical: string;
  }
  | {
    /**
     * A view. No `canonical`, for the same reason
     * `"unattributable-shadow"` has none: there is no honest table name to
     * give. A view holds no rows, SQLite never reports a change on one, and
     * a dependency recorded against a view is a dependency that never fires
     * - the failure mode that looks exactly like a correct live query until
     * the underlying table changes. What a view really depends on is its
     * body, which the authorizer reports as separate reads of the underlying
     * tables (measured, 3.45.1 and 3.53.4, 2026-09-09); see
     * `src/dependencies.ts`.
     */
    readonly kind: "view";
    readonly schema: string;
    readonly name: string;
  }
  | {
    /**
     * Absent from the snapshot: created, dropped or ATTACHed since the
     * capture, or a name SQLite reported that no schema lists. Treated as
     * itself, because an unrecognised name is exactly the "everything else"
     * case - but reported under its own kind so a stale snapshot is visible
     * instead of being indistinguishable from a hit.
     */
    readonly kind: "unknown";
    readonly schema: string;
    readonly name: string;
    readonly canonical: string;
  }
  | {
    /**
     * SQLite classified it as a shadow and no virtual table in the same
     * schema can be derived as its owner. No `canonical`: there is no honest
     * answer, so the caller is made to handle it.
     */
    readonly kind: "unattributable-shadow";
    readonly schema: string;
    readonly name: string;
  };

/** One row of `PRAGMA table_list`, after the columns we need are checked. */
export interface ListedTable {
  readonly schema: string;
  readonly name: string;
  readonly type: string;
}

const DEFAULT_SCHEMA = "main";

function stringField(row: unknown, field: string): string | undefined {
  if (typeof row !== "object" || row === null) return undefined;
  const value = Reflect.get(row, field);
  return typeof value === "string" ? value : undefined;
}

function listTables(db: SchemaSource): ListedTable[] {
  const raw: unknown[] = db.prepare("PRAGMA table_list").all();
  const rows: ListedTable[] = [];
  for (const row of raw) {
    const schema = stringField(row, "schema");
    const name = stringField(row, "name");
    const type = stringField(row, "type");
    if (schema === undefined || name === undefined || type === undefined) {
      throw new SchemaMapError(
        `PRAGMA table_list returned a row without string schema/name/type columns: ${
          JSON.stringify(row)
        }. This module cannot read the schema of this library.`,
      );
    }
    rows.push({ schema, name, type });
  }
  return rows;
}

function sqliteVersionOf(db: SchemaSource): string {
  const row: unknown = db.prepare("SELECT sqlite_version() AS v").get();
  return stringField(row, "v") ?? "unknown";
}

/** SQLite's own rule: the text before the LAST underscore, if there is one. */
function ownerCandidate(name: string): string | undefined {
  const cut = name.lastIndexOf("_");
  return cut <= 0 ? undefined : name.slice(0, cut);
}

/**
 * Schema and table both matter, so entries are keyed by the pair - and no
 * separator character is safe. Quoted SQLite identifiers are arbitrary text
 * (`ATTACH ':memory:' AS "a b"` is legal, and so is `CREATE TABLE "b c"`), so
 * schema `a b` + table `c` and schema `a` + table `b c` collide under any
 * single character you pick. The length of the schema is prefixed instead,
 * which cannot be ambiguous.
 */
function key(schema: string, name: string): string {
  return `${schema.length}:${schema}${name}`;
}

/**
 * A reading of one connection's schema, taken at {@linkcode capturedAt} and
 * never updated. See the module doc for why it is a snapshot.
 */
export class SchemaMap {
  /** When the reading was taken. Answers describe the schema as of this. */
  readonly capturedAt: Date;
  /** `sqlite_version()` of the connection the reading came from. */
  readonly sqliteVersion: string;
  /**
   * Shadow tables whose owner could not be derived. Empty in every
   * measurement made here; see the module doc for why it is reported anyway.
   */
  readonly unattributable: readonly TableRef[];
  /**
   * Tables that are *named* like a shadow of a virtual table in the same
   * schema but that SQLite does not classify as one - `ft_notes` beside a
   * virtual table `ft`. They resolve to themselves and are excluded from
   * {@linkcode SchemaMap.shadowsOf}; listed here as a diagnostic.
   */
  readonly shadowLookalikes: readonly TableRef[];

  readonly #entries: ReadonlyMap<string, Resolution>;
  readonly #shadows: ReadonlyMap<string, readonly string[]>;
  readonly #byName: ReadonlyMap<string, readonly string[]>;

  private constructor(rows: readonly ListedTable[], version: string) {
    const virtuals = new Set<string>();
    for (const row of rows) {
      if (row.type === "virtual") virtuals.add(key(row.schema, row.name));
    }

    const entries = new Map<string, Resolution>();
    const shadows = new Map<string, string[]>();
    const unattributable: TableRef[] = [];
    const lookalikes: TableRef[] = [];
    // Which schemas hold a table of a given name. The authorizer reports a
    // NULL schema for some accesses (`SELECT count(*) FROM t`, measured on
    // 3.45.1 and 3.53.4, 2026-09-09) including for TEMP tables, so "null
    // means main" is wrong; this is what lets a caller find out whether the
    // name is unambiguous instead of guessing.
    const byName = new Map<string, string[]>();

    for (const { schema, name, type } of rows) {
      if (type === "shadow") {
        byName.set(name, [...(byName.get(name) ?? []), schema]);
      }
      const candidate = ownerCandidate(name);
      const ownedBy =
        candidate !== undefined && virtuals.has(key(schema, candidate))
          ? candidate
          : undefined;

      if (type === "shadow") {
        if (ownedBy === undefined) {
          unattributable.push({ schema, name });
          entries.set(key(schema, name), {
            kind: "unattributable-shadow",
            schema,
            name,
          });
          continue;
        }
        entries.set(key(schema, name), {
          kind: "shadow",
          schema,
          name,
          canonical: ownedBy,
        });
        const list = shadows.get(key(schema, ownedBy));
        if (list === undefined) shadows.set(key(schema, ownedBy), [name]);
        else list.push(name);
        continue;
      }

      // Not a shadow. If the name would have claimed an owner, the
      // disagreement is recorded and detection wins.
      if (ownedBy !== undefined) lookalikes.push({ schema, name });

      byName.set(name, [...(byName.get(name) ?? []), schema]);

      if (type === "view") {
        entries.set(key(schema, name), { kind: "view", schema, name });
        continue;
      }
      entries.set(key(schema, name), {
        kind: type === "virtual" ? "virtual" : "table",
        schema,
        name,
        canonical: name,
      });
    }

    for (const list of shadows.values()) list.sort();

    this.capturedAt = new Date();
    this.sqliteVersion = version;
    this.unattributable = unattributable;
    this.shadowLookalikes = lookalikes;
    for (const list of byName.values()) list.sort();
    this.#entries = entries;
    this.#shadows = shadows;
    this.#byName = byName;
  }

  /**
   * Build a map from rows already read. Exists so
   * {@linkcode captureSchemaMap} can construct one; prefer that.
   */
  static from(rows: readonly ListedTable[], version: string): SchemaMap {
    return new SchemaMap(rows, version);
  }

  /**
   * The table a reported name really means: a shadow table becomes the virtual
   * table that owns it, everything else becomes itself.
   *
   * `schema` is the schema SQLite named in the event - `Change.db` - and it
   * matters: a virtual table in `temp` has its own shadows, whose names have
   * exactly the shape of ones in `main`.
   */
  resolveTable(name: string, schema: string = DEFAULT_SCHEMA): Resolution {
    return this.#entries.get(key(schema, name)) ??
      { kind: "unknown", schema, name, canonical: name };
  }

  /**
   * The tables SQLite will actually report row changes on for `name`, sorted.
   *
   * For a virtual table that is its shadow tables - and *only* those: hooks do
   * not fire on the virtual table itself, so the returned list never contains
   * `name`. For anything else this is empty, because SQLite reports changes to
   * an ordinary table under its own name; an empty result is therefore not the
   * same claim as "nothing changes here". Branch on
   * {@linkcode SchemaMap.resolveTable} first when the distinction matters,
   * which also distinguishes a name the snapshot has never seen.
   */
  shadowsOf(name: string, schema: string = DEFAULT_SCHEMA): readonly string[] {
    return this.#shadows.get(key(schema, name)) ?? [];
  }

  /**
   * Every schema in the snapshot holding a table, view or virtual table of
   * this name, sorted. Empty if the snapshot has never seen the name.
   *
   * This exists for one measured reason: the authorizer reports some accesses
   * with a NULL schema - `SELECT count(*) FROM t` names `t` and no schema at
   * all, whether `t` lives in `main` or in `temp` (3.45.1 and 3.53.4,
   * 2026-09-09). Defaulting such a name to `main` would silently resolve the
   * wrong table whenever both schemas hold the name. A caller can ask here
   * instead, and treat "more than one" as the ambiguity it is.
   */
  schemasContaining(name: string): readonly string[] {
    return this.#byName.get(name) ?? [];
  }

  /**
   * Take a fresh reading from `db` and return it as a new snapshot. This one
   * is left unchanged.
   *
   * Deciding when this is called is not this module's job, and nothing in this
   * module calls it. It must not be called from inside a hook callback: it
   * issues SQL on the connection.
   */
  refresh(db: SchemaSource): SchemaMap {
    return captureSchemaMap(db);
  }
}

/**
 * Read `db`'s schema once and return the map of it.
 *
 * Throws {@linkcode SchemaMapError} if the library predates
 * `PRAGMA table_list` (SQLite 3.37), which reports as zero rows rather than as
 * an error, or if the pragma's columns are not the ones this module reads.
 */
export function captureSchemaMap(db: SchemaSource): SchemaMap {
  const rows = listTables(db);
  if (rows.length === 0) {
    throw new SchemaMapError(
      `PRAGMA table_list returned no rows. It always reports at least the ` +
        `sqlite_schema row, so this libsqlite3 (${
          sqliteVersionOf(db)
        }) predates 3.37 and does not recognise the pragma; SQLite answers an ` +
        `unrecognised pragma with an empty result rather than an error.`,
    );
  }
  return SchemaMap.from(rows, sqliteVersionOf(db));
}
