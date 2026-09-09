# Domain knowledge

How the things this library sits on ACTUALLY behave: the `@db/sqlite` driver,
SQLite itself, and the tools around them. `CONTRIBUTING.md` answers "how do I
work here"; this file answers "what is the external world doing", which is a
different question with a different reader. A fact about a driver's internals
kept in a contributing guide is a fact the next person will re-derive, because
they will not look there for it.

**Everything here carries the version it was observed against and the date it
was observed.** An unstamped fact is worse than an absent one: it reads as
current. Where something below is unstamped it says so, and says what stamping
it would take.

## The `@db/sqlite` driver

**Version:** `@db/sqlite` 0.13.0 — the version pinned in `deno.json`. Read from
the JSR source (`https://jsr.io/@db/sqlite/0.13.0/src/statement.ts`) and
confirmed by running against it. **Observed 2026-09-09**, against system SQLite
3.45.1 and the vendored 3.53.4; nothing here depends on which of the two is
loaded.

### Statement methods are own properties when there are no bind parameters

The driver installs `run`, `get`, `all`, `values` and `value` as OWN properties
on each `Statement` when the statement takes no bind parameters
(`sqlite3_bind_parameter_count === 0`), shadowing the prototype. A prototype
patch therefore cannot reach them on such a statement, and a per-instance patch
is the only place they can be reached — which means a statement that already
exists when you go looking cannot be reached at all.

The conditional is the sharp edge: the same five members are inherited from the
prototype when the statement DOES take bind parameters. Any mechanism aimed at
them is conditional on bind-parameter count unless it patches per instance.

### `Statement.prototype.iter` is the one stepping member never shadowed

`iter` is a prototype generator and is never shadowed by an own property, so a
rule expressed there once reaches **every** statement, whenever it was created.
`[Symbol.iterator]` is `return this.iter()` — a dynamic lookup — so patching
`iter` also covers `for..of`.

### What the `Statement` constructor touches on the `Database`, and in what order

`new Statement(db, sql)` prepares in its constructor, and `db` is a public field
on every `Statement` (`constructor(public db: Database, sql: string)`).

1. It reads `db.unsafeHandle` (twice) BEFORE `sqlite3_prepare_v2`. That is the
   only thing it touches on the `Database` before the prepare happens, and it is
   the documented public escape hatch.
2. It reads `db.unsafeConcurrency` AFTER the prepare and before
   `statementFinalizer.register`. So at the moment that read happens, the
   statement is already prepared and not yet registered with the finalizer.
3. `unsafeConcurrency` is a plain own data property on `Database`
   (`this.unsafeConcurrency = options.unsafeConcurrency ?? false;`), and the
   `Statement` constructor is the only thing in the driver that reads it.

### What SQLite refuses that the driver does not

`db.backup()` from inside a hook callback is refused — **by SQLite itself, not
by the driver and not by us.** Anything counting coverage must not count this.

### With `DENO_SQLITE_PATH` unset the driver loads a library of its own

`@db/sqlite` reads `DENO_SQLITE_PATH` once at import time; with it unset it
downloads and loads a prebuilt library into `$DENO_DIR/plug/`. That library is a
different build and a different version from the system one — 3.46.0 where the
system library was 3.45.1 — and it carries a much smaller symbol set. Nothing
announces the substitution except a download line on stderr. See **What a
verification failure actually looks like here** below, where this cost a
measurement.

## The three libsqlite3 builds reachable here

**Observed 2026-09-09**, by `probeCapabilities()` against each library in its
own process, and corroborated for the negatives by `nm -D --defined-only`, which
does not go through `dlopen` at all. The cell-by-cell result is the generated
table in `README.md` ("What three real libraries actually support"), regenerated
by `deno task table` and checked by `deno task test:table`.

**The measured negatives, which are the point of having three columns:**

- The prebuilt `@db/sqlite` 0.13.0 downloads (SQLite **3.46.0**,
  `$DENO_DIR/plug/`) exports neither `sqlite3_preupdate_hook` nor
  **`sqlite3_progress_handler`** nor `sqlite3_normalized_sql`. The progress one
  we did not previously believe: it means that library is an honest fixture for
  the `progress`-absent branch as well as the `preupdate`-absent branch. `wal`,
  `trace`, `busy`, `authorize` and `collation` are all present in it.
- The system library on Debian/Ubuntu (SQLite **3.45.1**) has everything except
  `sqlite3_normalized_sql`.
- The vendored build (SQLite **3.53.4**) has all nine.

Each of those is "looked for it in that file, on that date, and it was not
there", not "did not check".

**This fixture has an expiry date.** The prebuilt is the only library reachable
here that genuinely lacks capabilities, and vendoring the driver removes it.
Anything that needs a real absent-capability library should be built while it
still exists.

### Loading several libsqlite3 builds in one process

**Measured 2026-09-09, and the result is a negative:** dlopening the system,
vendored and prebuilt libraries in a single Deno process reported 3.45.1, 3.53.4
and 3.46.0 correctly, in either order. No collapse, no segfault. The three
SONAMEs happen to differ — `libsqlite3.so.0`, `libsqlite3.so` and
`libsqlite3-3.46.0.so.0` (read with `objdump -p`).

That "no" is recorded because it is worth exactly as much as a "yes" and is
about to look like nobody asked. It is also not a guarantee: `dlopen` may hand
back an ALREADY-LOADED object when the SONAME matches, so the safety here is an
accident of how `vendor/build.sh` links today — one `-Wl,-soname` away from
three identical, plausible columns and no error. `tools/capability_table.ts`
probes each library in its own child process anyway, for that reason.

## SQLite: attribution hazards for a query-to-tables map

**UNSTAMPED.** These were measured while the authorizer hook was built, but the
notes were taken without recording the library or the date, and the counts below
(13, 3) are the kind of number that can move between SQLite versions. To stamp
them, re-run each measurement under `resolveLibPath()` against both libraries in
the capability ledger and record the version and date with the result; until
then treat the counts as illustrative and the shapes as the claim.

Recorded because the live-query path will need them, and all three are knowable
now rather than after it is built:

1. **Re-prepare arrives during a step.** SQLite re-prepares on `SQLITE_SCHEMA`
   inside `sqlite3_step`, so authorize callbacks can arrive with no prepare
   bracket open. Measured: after `ALTER TABLE`, re-running a prepared statement
   produced 13 authorizer callbacks.
2. **The library's own statements are in the stream** unless suppressed, and
   they arrive from inside the drain. That is handled today; anything added
   later that issues SQL must be bracketed the same way.
3. **The schema argument is sometimes null.** `SELECT count(*) FROM t` reports
   the table with an empty column name and a null schema. A key built from
   authorize events cannot always be a full `(schema, table)` pair.

4. **An observation made at prepare time is not a claim about execute time.**
   The finding above was wrong in its first form for exactly this reason: a
   probe that stopped at `prepare` reported a cleaner world than the one that
   exists, confidently. A probe that exercises less than the real path will do
   that every time.

Also: collect around the `prepare`, not the whole call. Executing a write to a
virtual table authorizes its shadow tables too, because FTS5 prepares its own
statements against them, whereas preparing a read of it names only the virtual
table. Corroborated and stamped in "Shadow tables and the virtual tables that
own them" below: a `MATCH` names only `ft` at prepare and only shadows at step.

## Shadow tables and the virtual tables that own them

Measured 2026-09-09 against both libraries in the capability ledger — the system
build 3.45.1 and the vendored build 3.53.4 — through `@db/sqlite` 0.13.0 under
`resolveLibPath()`. Every answer below was byte-identical on the two unless the
text says otherwise.

### Detection is authoritative; attribution is derived

`PRAGMA table_list` (SQLite 3.37+) reports a `type` column of `table`,
`virtual`, `shadow` or `view`. For `CREATE VIRTUAL TABLE ft USING fts5(body)` it
reports `ft` as `virtual` and `ft_config`, `ft_content`, `ft_data`,
`ft_docsize`, `ft_idx` as `shadow`; for `rtree` it reports `rt_node`,
`rt_parent`, `rt_rowid`. `sqlite_schema` cannot substitute: queried directly it
gives every one of those shadows `type = 'table'`.

Nothing reports _which_ virtual table owns a given shadow. The owner has to be
derived from the name, and the rule used here is the one SQLite itself applies
when deciding whether a name is a shadow at all: the text before the **last**
underscore, which must name a virtual table in the same schema.

The two agree, in the strongest sense that could be arranged. With
`PRAGMA writable_schema=ON`, the `sqlite_schema` row for `ft` deleted, and the
database closed and reopened, all five of its shadow tables come back reported
as `type = 'table'`. `type = 'shadow'` therefore _entails_ a live owning virtual
table, so the derivation is total over the shadow set and a shadow with no
derivable owner was not reachable by any route tried here.

**Measured negative, recorded so it is not mistaken for an untested claim:**
last-underscore and longest-virtual-table-prefix could not be told apart on
either library. Distinguishing them needs a shadow whose suffix itself contains
an underscore, and no module reachable here produces one — FTS5's shadow
suffixes are `config`, `content`, `data`, `docsize`, `idx`, rtree's are `node`,
`parent`, `rowid`. Nested prefixes (`ft` and `ft_sub` both virtual) are handled
identically by both rules: `ft_sub_data` goes to `ft_sub`.

### A table can be named like a shadow and not be one

`CREATE TABLE ft_notes(x)` succeeds beside the virtual table `ft`, and
`table_list` calls it a plain `table` — the module's `xShadowName` rejects the
suffix. So the name is not sufficient evidence in either direction, and code
that attributes by prefix alone will claim an ordinary table.

Dropping a shadow table directly (`DROP TABLE ft_data`) also succeeds on both
libraries: `SQLITE_DBCONFIG_DEFENSIVE` is not set by the driver.

### The change events an FTS5 write actually produces

`INSERT INTO ft(body) VALUES ('hello world')` on an fts5 table fires
`sqlite3_update_hook` for `ft_content`, `ft_docsize` and `ft_data`, and never
for `ft`.

Reading it back is the mirror image. Preparing
`SELECT * FROM ft WHERE ft MATCH 'hello'` authorizes `read(ft, body, main)` and
`read(ft, ft, main)` — the virtual table, no shadows. Stepping the same
statement authorizes `read(ft_idx, ...)` and `read(ft_content, ...)` — the
shadows, no virtual table. A dependency set collected at prepare time and a
change set collected at commit time therefore have no name in common for any
virtual table unless one side is canonicalised.

### `tables_used` is not an option for virtual tables

The `tables_used` eponymous virtual table (`SQLITE_ENABLE_BYTECODE`) exists on
the vendored 3.53.4 build and **not** on the system 3.45.1 build, where it is
`no such table: tables_used`.

Where it does exist it reports nothing at all for a virtual table — not only for
`MATCH`. Measured on 3.53.4:

| statement                                 | `tables_used` rows |
| ----------------------------------------- | ------------------ |
| `SELECT * FROM plain`                     | `main.plain`       |
| `SELECT * FROM ft`                        | none               |
| `SELECT * FROM ft WHERE ft MATCH 'hello'` | none               |
| `INSERT INTO ft(body) VALUES('z')`        | none               |
| `SELECT * FROM ft_content`                | `main.ft_content`  |

### Which virtual table modules are available

`PRAGMA module_list`, both libraries: `fts5` and `rtree` are present on both.
`vec0` is present on neither (`no such module: vec0`) — there is no sqlite-vec
extension on this machine, so the vector case is untested here rather than
known-good — `CREATE VIRTUAL TABLE v USING vec0(...)` fails with
`no such module: vec0` on both. The vendored build additionally carries
`geopoly`, `bytecode` and `tables_used`; the system build additionally carries
`json_each` and `json_tree` as modules, which 3.53.4 no longer lists. `fts3`,
`fts4`, `fts4aux`, `fts3tokenize`, `fts5vocab`, `rtree_i32`, `sqlite_stmt` and
`dbstat` are on both.

### `sqlite_sequence` and `sqlite_stat*` do not arrive as change events

Recorded either way because "we never saw one" and "we never looked" are
indistinguishable a month later. Both libraries, 2026-09-09:

- Inserting into a table with `INTEGER PRIMARY KEY AUTOINCREMENT` produces one
  change event, for that table. `sqlite_sequence` is written by that insert and
  **no** event names it. A second autoincrement table behaved the same.
- `ANALYZE` produces **no** change events at all — nothing names `sqlite_stat1`
  or any other `sqlite_stat*` table.

`PRAGMA table_list` reports `sqlite_sequence`, `sqlite_stat1`, `sqlite_schema`
and `sqlite_temp_schema` as plain `table`, so nothing distinguishes them from
application tables there either. If they ever do start arriving, they will look
like ordinary tables and will need filtering by name.

### Below the 3.37 floor, the pragma fails silently

SQLite answers an unrecognised pragma with an **empty result set**, not an
error: `PRAGMA nonexistent_pragma_xyz` returns zero rows on both libraries. A
pre-3.37 library would therefore make `PRAGMA table_list` look like a database
with no tables in it, and every attribution question would get a confidently
wrong answer. The distinguisher is that `table_list` on any open connection
reports at least the `sqlite_schema` row, so zero rows is unambiguous evidence
that the pragma is not recognised. Both libraries here are above the floor;
`src/schema_map.ts` checks anyway, because the check costs one comparison and
the failure mode is silent.

### Schemas are part of the identity

A virtual table created as `temp.tv` puts its shadows in the `temp` schema, and
`table_list` reports them with `schema = 'temp'` and names of exactly the same
shape as `main`'s. Change events carry the schema too (`Change.db`). A map keyed
by table name alone will merge a `main` table with a `temp` one of the same
name.

## The record of the divergence (2026-09-09)

Against the driver `@db/sqlite` as vendored here, and both libraries in the
capability ledger in `CONTRIBUTING.md`: the prose was broader than the mechanism
for the entire life of the guard, and nobody noticed, because on every case
anyone actually tried the two agreed. The disagreement needed a route that no
test and no example took.

**A rule documented wider than it is enforced is a latent version of this
project's signature defect.** It costs nothing while the two agree. The day
someone tightens the code to match the prose, or writes code that relies on the
prose being true, is the day it bites — and at that point the prose is the
evidence they were entitled to rely on.

## What a verification failure actually looks like here (2026-09-09)

Four instances in one chunk, and **in all four the failure was SILENT SUCCESS
AGAINST THE WRONG TARGET, never an error**: a probe run against a different
library than the suite uses; a generator producing degenerate keys; an INSERT
prepared but never stepped; an authorizer asked at prepare time and not at
execute. Each one reported a cleaner world, confidently.

**That is this project's signature defect with the observer inside it — our
tools stop holding at a boundary they do not announce.** The fifth instance will
not look like the first four, so the question to ask of any measurement is "what
target did this actually run against?", not "did it throw?".

**The gate applies to anything that produces a number or a fact we reason from**
— a version query, a capability check, a count, a one-line lookup — not only to
the things called probes. Every such thing carries either a negative control
that must read zero, or a case with a known answer that must come out right, and
its numbers are not reportable until that gate passes.

The rule as first phrased was narrower and did not save the person who wrote it.
A version check was run without `DENO_SQLITE_PATH` an hour later; the driver
silently downloaded its own prebuilt library and reported 3.46.0 against a suite
running 3.45.1. Nothing errored. It was caught only because a download line
appeared on stderr. A whole verification table could have gone out against the
wrong library. Use `resolveLibPath()`, and treat "which library was this?" as
part of the result rather than context.

**The fifth instance came from the reviewing side, not the measuring side.**
Verifying the `iter` refusal, a control was written asserting "expect 3" where
the correct answer was 2. It came out in the safe direction, but that is luck:
**a control whose expected value the author got wrong is a control that can
AGREE with a broken implementation, and it will not announce itself when it
does.** It is the first of the five where the faulty check was ours by
construction rather than inherited from a tool. A known-answer gate is only as
good as the known answer.
