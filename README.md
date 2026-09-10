# reactive-sqlite

SQLite's C-level hooks — `update`, `preupdate`, `commit`, `rollback` and friends
— as typed JavaScript events, batched per transaction, with a commit your code
can veto.

## Why

SQLite has exposed change notification in C for decades, but almost none of it
reaches JavaScript.
[`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) is an excellent
Node library and its API docs list no change-notification methods; an open PR
([#1337](https://github.com/WiseLibs/better-sqlite3/pull/1337), reviewed
favourably but unmerged) would add `updateHook`/`commitHook`/`rollbackHook`. In
Deno, [`@db/sqlite`](https://jsr.io/@db/sqlite) is the main FFI driver and
declares `sqlite3_update_hook` in its symbol table but exposes no public hook
API, and `node:sqlite` (Node's builtin, also Deno's) offers `setAuthorizer` and
the session extension but no update, commit or rollback hook. This library fills
that one gap and nothing else.

> **Status: pre-1.0, incomplete, API unstable.** Not on a registry yet. Some
> events below are not implemented — see the table.

## Install

Nothing is published yet. Both lines below describe the first release.

```sh
deno add jsr:@jbsiddall/reactive-sqlite   # planned
npm  install reactive-sqlite              # planned; no npm package or build exists today
```

Registering hooks means calling `libsqlite3` directly, so a Deno process needs
FFI permission:

```sh
deno run --unstable-ffi --allow-ffi --allow-env --allow-read --allow-write app.ts
```

### The native library

You supply `libsqlite3` yourself and point `DENO_SQLITE_PATH` at it **before**
importing the driver. Automatic download of a matching library from a GitHub
Release is planned; it does not exist yet.

```sh
export DENO_SQLITE_PATH=/usr/lib/x86_64-linux-gnu/libsqlite3.so.0            # Linux
export DENO_SQLITE_PATH=/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib        # macOS
```

It must be the _same file_ the driver loads. The driver reads `DENO_SQLITE_PATH`
once at import time and otherwise falls back to the vendored build in
`vendor/lib/`; if the two differ, the `sqlite3*` handle passed across belongs to
a foreign build and the process dies of `SIGSEGV` — exit 139, no exception, no
message. The library compares `sqlite3_libversion()` against the driver's
`sqlite_version()` and refuses to attach on a mismatch, which catches the
realistic mistake but is not proof of one file.

## Usage

Reject rows that fail validation, by vetoing the commit:

```ts
import { Database } from "@jbsiddall/reactive-sqlite/driver";
import { withEvents } from "@jbsiddall/reactive-sqlite";

const db = new Database("shop.db");

withEvents(db, (event) => {
  if (event.type !== "precommit") return;
  // Returning false turns the COMMIT into a ROLLBACK.
  return event.changes.every((c) =>
    c.table !== "products" || (c.new?.price ?? 0) >= 0
  );
});

db.run("INSERT INTO products (name, price) VALUES ('widget', -5)"); // rejected
```

**The one surprise:** a bare `INSERT`/`UPDATE`/`DELETE` with no explicit `BEGIN`
is its own implicit transaction, so vetoing its commit rejects exactly that
statement. Inside an explicit multi-statement transaction the same veto rolls
back **the whole transaction**, not just the offending row. SQLite offers no
row-level veto from any hook (see [Hard limits](#hard-limits)). For true per-row
rejection, use a `BEFORE` trigger whose `WHEN` clause calls a registered JS
function and whose body is `RAISE(IGNORE)`: that skips just the offending row
and lets the rest of the transaction commit.

### Logging an event

`JSON.stringify(event)` throws: an INTEGER always decodes to a `bigint`, and
`JSON.stringify` refuses those. Use `formatEvent`, or pass `jsonReplacer` to
your own stringify call:

```ts
import { formatEvent, jsonReplacer } from "@jbsiddall/reactive-sqlite";

withEvents(db, (e) => console.log(formatEvent(e, 2)), LIB);
JSON.stringify(batch, jsonReplacer); // when you need your own call
```

A `bigint` prints as its decimal digits in a string — always, never a number
when it happens to fit, because that would make the JavaScript type depend on
the value. A blob prints as SQLite's own `x'00ff80'` literal, which reads
sensibly and pastes back into SQL. This is a debugging aid, not a decoder: it
renders the raw values, it does not interpret them.

### `op` is open at the edge, and `opcode` is what arrived

Every change carries both our reading of what happened and the raw value SQLite
sent:

```ts
type Change = {
  op: "insert" | "update" | "delete" | "unknown";
  opcode: number; // as SQLite gave it: 18, 23, 9 for the three above
  db: string;
  table: string;
  rowid: bigint;
};
```

SQLite documents `sqlite3_update_hook` as sending only `SQLITE_INSERT`,
`SQLITE_UPDATE` and `SQLITE_DELETE`, and in practice that is all it sends. The
union is still open, because an opcode we did not recognise would otherwise have
to be dropped, and silently losing a change is the one thing this library exists
to prevent. So anything unrecognised arrives as `op: "unknown"` with the number
intact in `opcode`, and **your `switch` needs that case** — the compiler will
tell you so.

`op` and `opcode` may legitimately disagree, and that disagreement is
information rather than an inconsistency: it is the only signal that an event
was synthesised by this library rather than reported directly by SQLite. An
incremental blob write is the case. `sqlite3_update_hook` never sees one at all,
so the event is built from the preupdate hook, which reports the write as a
DELETE. You get `op: "update"` — our honest reading of what the write really was
— alongside `opcode: 9`, the DELETE opcode SQLite actually delivered.

## Capability table

What SQLite itself allows, and what is built. "Veto" means the C callback's
return value can change what the database does.

| Event                    | C hook                     | Pre | Post | Veto                          | Notes                                                  |
| ------------------------ | -------------------------- | --- | ---- | ----------------------------- | ------------------------------------------------------ |
| Row insert/update/delete | `sqlite3_update_hook`      | —   | —    | no (returns `void`)           | SQLite documents the timing as undefined; see limits   |
| Row change with old/new  | `sqlite3_preupdate_hook`   | yes | no   | no (returns `void`)           | Needs `SQLITE_ENABLE_PREUPDATE_HOOK`                   |
| Commit                   | `sqlite3_commit_hook`      | yes | no   | **yes** → rollback            | Scope is the whole transaction, not one row            |
| Rollback                 | `sqlite3_rollback_hook`    | no  | yes  | no                            |                                                        |
| Commit landed            | — (synthesised)            | no  | yes  | n/a, already happened         | No C hook: commit hook runs _before_ commit            |
| WAL commit written       | `sqlite3_wal_hook`         | no  | yes  | **no** — see note below       | Displaces auto-checkpointing; we replicate it          |
| Statement lifecycle      | `sqlite3_trace_v2`         | yes | yes  | no — return value ignored     | `row` fires per result row and measured ~3x; opt in    |
| Statement progress       | `sqlite3_progress_handler` | —   | —    | **yes** → `abort()` only      | Return value ignored; `abort()` interrupts, see below  |
| Lock contention          | `sqlite3_busy_handler`     | —   | —    | **yes** → `retry()` only      | Return value ignored; `retry()` BLOCKS the thread      |
| Unknown collation needed | `sqlite3_collation_needed` | yes | no   | no; supplies the collation    | Every comparison then crosses into JS; see cost below  |
| Statement authorisation  | `sqlite3_set_authorizer`   | yes | no   | **yes** → `deny()`/`ignore()` | Compile-time; +49%; `ignore()` NULLs a column silently |

### What three real libraries actually support

The table above is what SQLite allows. This one is what the library on YOUR disk
allows, and the three columns are the three you can realistically end up with:
the system `libsqlite3`, the vendored build, and the prebuilt `@db/sqlite`
downloads for itself when `DENO_SQLITE_PATH` is unset. Each cell is the value
{@linkcode probeCapabilities} returned for that library. Read your own with
`probeCapabilities(libPath)`, or `subscription.capabilities`.

<!-- capability-table:begin -->

Observed **2026-09-09**, by running `probeCapabilities()` against each library
at the path below, each in its own process. Every `no` is a measured negative —
the symbol was looked for in that file, on that date, and was not there — not an
unchecked cell. In the repository the `table` task rewrites this block and the
`test:table` gate fails if it is stale; neither script is in the published
package.

| Capability      | system 3.45.1 | vendored 3.53.4 | @db/sqlite prebuilt 3.46.0 |
| --------------- | ------------- | --------------- | -------------------------- |
| `hooks`         | yes           | yes             | yes                        |
| `preupdate`     | yes           | yes             | no                         |
| `wal`           | yes           | yes             | yes                        |
| `trace`         | yes           | yes             | yes                        |
| `progress`      | yes           | yes             | no                         |
| `busy`          | yes           | yes             | yes                        |
| `authorize`     | yes           | yes             | yes                        |
| `collation`     | yes           | yes             | yes                        |
| `normalizedSql` | no            | yes             | no                         |

- `system` — the path `resolveLibPath()` returns with `DENO_SQLITE_PATH` unset —
  not necessarily the library the suite runs against, which is normally pinned
- `vendored` — `vendor/lib/<target>/`, built by `deno task vendor:build` and
  matching the `build_manifest.json` beside it
- `@db/sqlite prebuilt` — `$DENO_DIR/plug/`, downloaded by `@db/sqlite` 0.13.0
  when `DENO_SQLITE_PATH` is unset

<!-- capability-table:end -->

## This library versus the other SQLite bindings

A different question from the table above: not "what does SQLite allow" but
"which binding should you reach for". This library is not a SQLite driver. It is
a hook layer on top of the driver vendored in `driver/`, so wherever a row below
says _via the driver_ the feature is the driver's, available to you because you
are still holding the driver's `Database`, and unaffected by anything here.

Versions checked on 2026-09-09, against each project's own documentation, type
definitions or source: better-sqlite3 13.0.3 (npm, 2026-08-05) · `node:sqlite`
as documented in `doc/api/sqlite.md` on `nodejs/node@main`, Stability "1.2 -
Release candidate" · `bun:sqlite` per `bun-types` 1.4.2 and bun.com/docs ·
`sqlite3` (node-sqlite3) 6.0.1 (npm, 2026-03-12) · `@db/sqlite` 0.13.0 (JSR,
2025-11-18) · `@sqlite.org/sqlite-wasm` 3.53.4-build1 (npm, 2026-09-08) · sql.js
1.14.2 (npm, 2026-08-14) · wa-sqlite 1.0.0 (npm, 2024-01-05).

How a "no" was reached, because absence of mention is not evidence: for
better-sqlite3, `node:sqlite`, `sqlite3` and `@db/sqlite` a "no" means the C
symbol is absent from the library's own source or FFI symbol table, which is
checkable; for `bun:sqlite` it means the capability is in neither bun.com/docs
nor the `bun-types` type definitions, which enumerate the whole `Database` class
— Bun's own source was not read. Whether the two Node native addons load under
Deno's or Bun's Node compatibility layer was not tested either way.

Two caveats before the cells. node-sqlite3's README opens with "This repository
is currently unmaintained. We will not update any of its issues or pull
requests", so treat it as legacy even though npm releases still appear.
wa-sqlite has had no npm release since January 2024.

### Change notification and control

| C hook / feature                 | reactive-sqlite             | better-sqlite3                        | `node:sqlite`                           | `bun:sqlite` | `sqlite3`                               | `@db/sqlite`            | sqlite-wasm |
| -------------------------------- | --------------------------- | ------------------------------------- | --------------------------------------- | ------------ | --------------------------------------- | ----------------------- | ----------- |
| `update_hook` (row ins/upd/del)  | yes                         | not in a release; PR #1337 open       | no                                      | no           | yes — `db.on("change")`, async delivery | symbol declared, no API | yes         |
| `preupdate_hook` (old/new)       | yes, where the build has it | no; bundled build omits the flag      | no                                      | no           | no                                      | no                      | yes         |
| `commit_hook`                    | yes, and can veto           | not in a release; PR #1337 open       | no                                      | no           | no                                      | no                      | yes         |
| `rollback_hook`                  | yes                         | not in a release; PR #1337 open       | no                                      | no           | no                                      | no                      | yes         |
| post-commit (synthesised)        | yes                         | no                                    | no                                      | no           | no                                      | no                      | no          |
| `wal_hook`                       | yes                         | no                                    | no                                      | no           | no                                      | no                      | no          |
| `trace_v2` / profile             | yes                         | `verbose` option logs each SQL string | `diagnostics_channel` `sqlite.db.query` | no           | yes — `trace` and `profile` events      | no                      | yes         |
| `progress_handler`               | yes                         | no                                    | no                                      | no           | no                                      | no                      | yes         |
| busy handler / timeout           | yes — handler               | `timeout` option                      | `timeout` option                        | no           | `configure("busyTimeout")`              | no                      | yes, both   |
| `collation_needed`               | yes, and can supply one     | no                                    | no                                      | no           | no                                      | no                      | yes         |
| authorizer                       | yes                         | no                                    | yes — `setAuthorizer`                   | no           | no                                      | no                      | yes         |
| session / changesets / patchsets | no                          | no                                    | yes — `createSession`, `applyChangeset` | no           | no                                      | no                      | yes         |

Any of these can set `PRAGMA busy_timeout`; that row is about the C-level
handler or a constructor option. "sqlite-wasm" here means the C API the official
build exposes to JavaScript, which you drive yourself — there is no
`db.onUpdate(...)` convenience wrapper, and a callback must be installed as a
WASM function pointer.

### Extending SQLite, and moving data in and out

| Feature                   | reactive-sqlite | better-sqlite3              | `node:sqlite`             | `bun:sqlite` | `sqlite3`         | `@db/sqlite`     | sqlite-wasm                  |
| ------------------------- | --------------- | --------------------------- | ------------------------- | ------------ | ----------------- | ---------------- | ---------------------------- |
| Scalar functions          | via the driver  | yes                         | yes                       | no           | no                | yes              | yes                          |
| Aggregates                | via the driver  | yes                         | yes                       | no           | no                | yes              | yes                          |
| Window functions          | no              | yes — `aggregate.inverse`   | yes — `aggregate.inverse` | no           | no                | no               | yes                          |
| Virtual tables            | no              | yes — `db.table`, read-only | no                        | no           | no                | no               | yes — `create_module`        |
| Custom collations         | no              | no                          | no                        | no           | no                | no               | yes                          |
| Incremental BLOB I/O      | via the driver  | no                          | no                        | no           | no                | yes — `openBlob` | no — `blob_open` not exposed |
| Backup API                | via the driver  | yes — async, with progress  | yes — `sqlite.backup`     | no           | yes — `db.backup` | yes              | no                           |
| `serialize`/`deserialize` | no              | yes                         | yes                       | yes          | no                | no               | yes                          |
| Loadable extensions       | via the driver  | yes                         | yes                       | yes          | yes               | yes              | no — WASM                    |

node-sqlite3's `db.serialize()` is unrelated: it serialises _query execution
order_, not the database. It has no `sqlite3_serialize`.

### Runtime and API shape

|                         | reactive-sqlite                           | better-sqlite3         | `node:sqlite`                    | `bun:sqlite`   | `sqlite3`              | `@db/sqlite`                               | sqlite-wasm                 |
| ----------------------- | ----------------------------------------- | ---------------------- | -------------------------------- | -------------- | ---------------------- | ------------------------------------------ | --------------------------- |
| API                     | sync                                      | sync                   | sync                             | sync           | async, callbacks       | sync                                       | sync; worker API is async   |
| Runtimes                | Deno                                      | Node                   | Node ≥ 22.5; Deno ≥ 2.2 (subset) | Bun            | Node                   | Deno                                       | browser; Node build shipped |
| Where SQLite comes from | your `libsqlite3`, via `DENO_SQLITE_PATH` | native addon, prebuilt | built into Node                  | built into Bun | native addon, prebuilt | prebuilt downloaded, or `DENO_SQLITE_PATH` | compiled into the WASM      |
| Sandbox cost            | `--allow-ffi` (whole-process)             | n/a                    | n/a                              | n/a            | n/a                    | `--allow-ffi` (whole-process)              | none                        |
| Status                  | pre-1.0, unpublished                      | stable                 | Release candidate                | stable         | unmaintained repo      | 0.13.0                                     | tracks SQLite releases      |

### Values, in and out

Where people get surprised first. Reading: every one of these returns `null` for
SQL `NULL`, `string` for TEXT and a JS number for REAL, so only the awkward
cases are listed.

|                    | reactive-sqlite                                        | better-sqlite3                            | `node:sqlite`                                        | `bun:sqlite`                              | `sqlite3`                | `@db/sqlite`                                                     | sqlite-wasm                                              |
| ------------------ | ------------------------------------------------------ | ----------------------------------------- | ---------------------------------------------------- | ----------------------------------------- | ------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------- |
| bind `boolean`     | via driver → INTEGER 1/0                               | throws                                    | INTEGER 1/0                                          | INTEGER 1/0                               | INTEGER 1/0              | INTEGER 1/0                                                      | INTEGER 1/0                                              |
| bind `Date`        | via driver → ISO 8601 TEXT                             | throws                                    | throws                                               | not in the types                          | REAL, epoch milliseconds | ISO 8601 TEXT                                                    | not accepted                                             |
| bind `bigint`      | via driver → INTEGER                                   | INTEGER; range error past 64 bits         | INTEGER; range error past 64 bits                    | INTEGER                                   | not accepted             | INTEGER                                                          | INTEGER                                                  |
| bind bytes         | via driver → `Uint8Array`                              | `Buffer`                                  | TypedArray, DataView, ArrayBuffer, SharedArrayBuffer | TypedArray                                | `Buffer`                 | `Uint8Array`                                                     | `Uint8Array`, `Int8Array`, `ArrayBuffer`                 |
| bind `undefined`   | via driver → NULL                                      | NULL                                      | NULL                                                 | not in the types                          | not accepted             | NULL                                                             | NULL                                                     |
| bind other objects | via driver → JSON TEXT                                 | throws                                    | throws                                               | not in the types                          | `String(value)` TEXT     | JSON TEXT                                                        | not accepted                                             |
| read INTEGER       | `bigint` in `preupdate` events; driver rules elsewhere | `number`, or `bigint` with `safeIntegers` | `number`, or `bigint` with `readBigInts`             | `number`, or `bigint` with `safeIntegers` | `number` always          | 32-bit `number` by default; `number`/`bigint` with `int64: true` | `number`; over 53 bits needs BigInt support or it throws |
| read BLOB          | `Uint8Array` copy                                      | `Buffer`                                  | `Uint8Array`                                         | `Uint8Array`                              | `Buffer`                 | `Uint8Array`                                                     | `Uint8Array`                                             |

Two traps worth spelling out. better-sqlite3 binds every JS number with
`sqlite3_bind_double`, so an integral number is stored as REAL unless the
column's affinity converts it. `@db/sqlite` reads INTEGER columns with
`sqlite3_column_int` unless you pass `int64: true` — its own doc says "integers
larger than 32 bit will be inaccurate" — and it parses TEXT carrying SQLite's
JSON subtype into objects unless you pass `parseJson: false`. Both apply to code
using this library, since the driver is doing the reading.

### The three WASM builds

They are not interchangeable.

|                   | `@sqlite.org/sqlite-wasm`             | sql.js                                | wa-sqlite                                                                  |
| ----------------- | ------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------- |
| Who builds it     | the SQLite project                    | community                             | community                                                                  |
| Hooks             | the whole C API, `preupdate` included | `updateHook` only                     | `update_hook` only                                                         |
| Authorizer        | yes                                   | no                                    | yes — `set_authorizer`                                                     |
| Progress handler  | yes                                   | no                                    | yes — `progress_handler`                                                   |
| Functions         | scalar, aggregate, window             | `create_function`, `create_aggregate` | scalar and aggregate via `create_function`                                 |
| Virtual tables    | yes                                   | no                                    | yes — `create_module`                                                      |
| Session extension | yes                                   | no                                    | no                                                                         |
| API               | sync, plus async worker/OPFS          | sync                                  | async — `step`, `prepare_v2` return promises, and VFS methods may be async |
| Persistence       | OPFS, needs COOP/COEP headers         | in memory; `export()` a file          | pluggable VFS, IndexedDB and OPFS examples                                 |
| `bigint` binding  | INTEGER                               | bound as TEXT                         | `bind_int64`                                                               |
| Last npm release  | 2026-09-08                            | 2026-08-14                            | 2024-01-05                                                                 |

### When not to use this library

If you are on Node today and do not need change notification, use
better-sqlite3: it is mature, published, needs no environment variable, and
gives you window functions, virtual tables, backup and `serialize` that this
library does not. If you want a builtin with no native dependency at all, and
changesets rather than live events, `node:sqlite` already ships in Node and in
Deno. If you need the browser, the WASM builds are the only option, and the
official `@sqlite.org/sqlite-wasm` exposes more of SQLite than anything else
here — including `preupdate_hook` and the session extension — at the cost of
driving the C API yourself. If you are on Bun, `bun:sqlite` is the only builtin,
and none of the hooks exist there at all.

Reach for this library when you are on Deno, want row and commit events with the
actual column values, want a commit you can veto from JavaScript, and can live
with pre-1.0 churn, an unpublished package, `--allow-ffi` and supplying your own
`libsqlite3`.

## Coverage

Each batch carries a `coverage`: `"complete"` (every row present), `"truncated"`
(more rows changed than the retention limit), or `"unknown"` (nothing observed —
**not the same as nothing having changed**). Branch on it, and fall back to a
full refresh rather than reading an empty change list as an idle transaction.

## Hard limits

Properties of SQLite, not of this implementation, except where a subsection
below says otherwise. This list is not exhaustive — it is what has been hit and
verified so far.

1. **No row-level veto from any hook.** Both `sqlite3_update_hook` and
   `sqlite3_preupdate_hook` return `void`. The commit hook is the only veto
   point and is all-or-nothing per transaction.
2. **Incremental blob writes are invisible to `update_hook`.** Only
   `preupdate_hook` sees them, reported as a delete flagged by
   `sqlite3_preupdate_blobwrite`.
3. **`preupdate` needs `SQLITE_ENABLE_PREUPDATE_HOOK` at compile time.** Off in
   a stock build. Ubuntu's and Debian's `libsqlite3` have it; Apple's system
   SQLite and Homebrew's do not. Where the symbol is absent the events cannot be
   offered, and the library says so rather than failing obscurely.
4. **DDL is not reported.** `CREATE TABLE` and friends write `sqlite_schema`,
   which the update hook ignores, so such a transaction commits with an empty
   batch.
5. **Some deletes are not reported.** The truncate optimisation (`DELETE FROM t`
   with no `WHERE`) removes rows without invoking the hook per row.
6. **A hook must not use the connection that invoked it.** Undefined behaviour
   in SQLite. Defer that work until after the commit. The library refuses
   everything that STEPS a statement from inside a listener — the methods on the
   driver's `Database`, `Statement` and `SQLBlob`, and `iter()`/`for..of` on any
   statement at all, including ones you prepared before subscribing. It is still
   a guardrail rather than a barrier, and two routes are left: the
   `run`/`get`/`all`/`values`/`value` installed directly on a statement you
   prepared before subscribing, and the driver's public `unsafeHandle`. The
   first is reported through `onListenerError` when the statement is built
   inside a listener, since it cannot be refused there without taking
   `unsafeHandle` away from everyone. The second is the escape hatch and is
   meant to be one. **The rule holds whether or not you get an error.**
7. **A veto surfaces as SQLite's generic "constraint failed".** That is all
   SQLite reports; your own reason is attached alongside it.
8. **One hook of each kind per connection.** Multiple listeners are multiplexed
   by the library, and any other code registering hooks on the same connection
   silently replaces ours.
9. **FFI is a whole-process trust boundary.** `--allow-ffi` switches off the
   runtime sandbox.
10. **Hooks never fire on a virtual table — only on its shadow tables.** This is
    the one that quietly breaks change-driven cache invalidation, and it only
    happens for virtual tables, so ordinary testing does not surface it. An
    `INSERT INTO ft(body) VALUES ('hello world')` on an FTS5 table `ft` reports
    changes to `ft_content`, `ft_docsize`, `ft_data` and `ft_idx`, and never to
    `ft` (verified on SQLite 3.45.1; `rtree` behaves the same way, reporting
    `rt_rowid` and `rt_node`). So the change signal arrives under a table name
    no query of yours mentions, and matching events against the tables a query
    reads will never match — silently, and in the direction that fails open.
    `captureSchemaMap` (see "Virtual tables change under other names") derives
    the owning virtual table from the shadow name, using SQLite's own rule, and
    it is verified against `fts5` and `rtree` specifically -- the two modules
    present on both libraries here. No vector module is reachable in this
    project, so `vec0` and anything else unnamed is untested rather than
    known-good.
11. **`update_hook` does not fire for WITHOUT ROWID tables.** It is documented
    as reporting rows in a _rowid_ table. `preupdate_hook` does still fire for
    them, so with `preupdate` available the write is visible — just not through
    the row-change events (verified on SQLite 3.45.1).
12. **`update_hook` does not report the row an `ON CONFLICT REPLACE`
    displaces.** `INSERT OR REPLACE` that evicts a conflicting row reports only
    the insert. `preupdate_hook` reports both the delete and the insert
    (verified on SQLite 3.45.1).
13. **`preupdate_hook` does not fire for virtual tables or system tables.** Its
    shadow tables are ordinary tables and are reported normally, which is why
    FTS5 writes appear under shadow names rather than not at all.
14. **The timing of `update_hook` relative to the row change is undefined.**
    SQLite does not specify whether the callback runs before or after the row is
    written. Do not build ordering assumptions on it; use `preupdate_hook`,
    which is defined to run before.

### The WAL hook returns a value, and it is not a veto

`sqlite3_wal_hook`'s callback returns an int, which reads like a veto and is not
one. SQLite invokes it _after_ the commit has taken place and the write lock is
released. A non-`SQLITE_OK` return does not undo anything: it propagates so that
the statement which provoked the commit reports an error, "though the commit
will have still occurred", and returning `SQLITE_ROW`, `SQLITE_DONE` or any
value that is not a valid error code is undefined behaviour. This library
therefore always returns `SQLITE_OK`, whatever a listener does, and the `wal`
event is a **void contract**: your return value is ignored, exactly as for
`change`, `preupdate`, `postcommit` and `rollback`.

### Authorizing statements as SQLite compiles them

`authorize: true` delivers an event for each action inside a statement while
SQLite compiles it — the tables and columns it reads, the functions it calls,
the transactions it opens.

```ts
withEvents(
  db,
  (e) => {
    if (e.type !== "authorize") return;
    if (e.action === "read" && e.arg2 === "password_hash") e.deny();
  },
  LIB,
  { authorize: true },
);
```

**It is the most expensive hook here: a no-op authorizer measured +49%** on a
prepare-heavy workload (10,000 prepares of an eight-column SELECT, 94.4 ms
against 140.7 ms). The charge is per PREPARE, not per step or per row, so code
that prepares once and steps many times pays it once and code that prepares in a
loop pays half again.

**Doing nothing allows.** The return value is ignored, as everywhere but
`precommit`, and `deny()` and `ignore()` are explicit acts. That default is
forced: denying on silence would fail every statement on the connection. A
listener returning a thenable would otherwise be catastrophic here — a Promise
is truthy, truthy coerces to `SQLITE_DENY`, and an async authorizer would reject
every statement the process prepares. Returning a thenable, returning a truthy
value and throwing all allow; a throw is reported and still allows. The first
decision wins: a second `deny()` after an `ignore()` is reported and ignored,
and so is a call kept and made after the event returned.

#### `deny()` is loud; `ignore()` is silent, and that is the hazard

| act        | what the caller sees                                     |
| ---------- | -------------------------------------------------------- |
| `deny()`   | the prepare fails: `access to t.secret is prohibited`    |
| `ignore()` | **the query succeeds** and that column comes back `NULL` |

Nothing in the result distinguishes an ignored column from a genuinely null one.
`ignore()` is the right tool for hiding a column from an untrusted reader and
the wrong one for anything the caller needs to know about. Prefer `deny()`
unless you specifically want the silence.

#### Virtual tables: this hook sees what the row events cannot

The row events report writes to FTS5's _shadow_ tables — `ft_content`,
`ft_docsize`, `ft_data`, `ft_idx` — and never the virtual table `ft`. The
authorizer is the mirror image: preparing
`SELECT body FROM ft WHERE ft MATCH
'hello'` reports `ft` and no shadow table at
all. Neither source alone can tell you that a query depends on a virtual table.
Measured on `fts5` and `rtree`; other modules were not tested.

One asymmetry to know if you collect these: _executing_ a write to a virtual
table also authorizes its shadow tables, because FTS5 prepares its own
statements against them. Collect around the `prepare`, not around the whole
call.

#### Action codes are open at the edge

`action` is a string union with an `"unknown"` member, and `actionCode` carries
SQLite's raw number. SQLite can add action codes, so a code this library does
not yet name arrives as `"unknown"` with the number intact rather than being
dropped — the same treatment, and the same reason, as an unrecognised row
opcode. `action` and `actionCode` therefore disagree for any such code.

The four detail strings are reported exactly as SQLite gives them. A `null` is
not the same observation as an empty string — `SELECT count(*) FROM t` reports
the table with an empty column name — so neither is normalised away, and what
each argument means depends on the action.

#### Statements this library issues are not delivered

Three statements are suppressed, because they are ours rather than yours:

- `PRAGMA wal_autocheckpoint` — the WAL displacement check
- `PRAGMA busy_timeout` — the busy displacement check
- `PRAGMA database_list` and the `sqlite_schema` join behind `preupdate` column
  names

That list is complete as of this version, and it grows only if this library
starts issuing more. The suppression is bracketed around our own call sites,
never matched against SQL text, so **a statement you issue yourself is always
delivered** — including a `PRAGMA busy_timeout` identical to ours.

#### Displacement is detected at attach, and not after

A connection has one authorizer, and installing ours replaces any other. At
attach we prepare one statement of our own choosing and confirm a callback
arrives; if none does, something else already holds the authorizer and that is
reported. **Displacement that happens after attach we cannot detect.** There is
no pragma — `PRAGMA authorizer` returns no rows, but so does
`PRAGMA definitely_not_a_pragma`, because SQLite ignores unknown pragmas
silently — and `sqlite3_set_authorizer` returns a result code rather than the
previous callback. Nothing is inferred from a statement not producing a
callback, because empty, comment-only and unparseable statements legitimately
produce none.

Note also that SQLite re-prepares a statement after a schema change, from inside
`sqlite3_step`, so authorize events can arrive during what your code experiences
as a read rather than a compile.

### Supplying a collating sequence from JavaScript

`collation: true` delivers an event when a statement names a collating sequence
this connection does not have. With no handler at all — the default, and what
SQLite does — the statement fails with `no such collation sequence: NAME`, the
connection stays usable, and an open transaction still commits.

```ts
withEvents(
  db,
  (e) => {
    if (e.type !== "collation") return;
    if (e.name !== "NOCASE_INTL") return; // anything else still fails cleanly
    const c = new Intl.Collator("tr", { sensitivity: "accent" });
    e.provide((a, b) => c.compare(a, b));
  },
  LIB,
  { collation: true },
);
```

`provide()` registers the comparator under exactly the name SQLite asked for,
and the statement that triggered the event **then proceeds and sorts
correctly**: SQLite retries the lookup as soon as the callback returns. There is
no default and nothing is registered for you — the same rule as `progress`,
because the cost below is yours to accept rather than ours to assume.

`@db/sqlite` has no collation API, so this library owns the registration itself
rather than delegating it. That is a real decision, and what it rejected:

- **A general `createCollation()` on the subscription**, callable at any time.
  Rejected because it is a collation API rather than a hook, and because its
  lifetime would then be the subscription's while its usefulness is the
  connection's — a caller could register a sequence, dispose, and be left with a
  connection whose statements suddenly fail. Bound to the event, registration
  only happens inside a window where SQLite has asked and the attachment is
  provably live.
- **Returning the comparator from the listener.** Rejected for the same reason
  `deny()` and `retry()` are calls rather than return values: several listeners
  share one event, and a return value cannot say which one decided, nor report a
  second decision.
- **Registering something by default** — an `Intl.Collator`, say. Rejected: it
  would put every caller who only wanted events onto the cost below.

SQLite asks **once per statement** and then gives up, so there is no retry loop
to defend against, and a `provide()` kept and called after the event has
returned installs a sequence that decides nothing about the statement that
wanted it. That is reported through `onListenerError` rather than looking like
success. A second `provide()` in one event is reported too, and the first
stands. Only the SIGN of the comparator's return value is read; returning
anything that is not a finite number treats the two values as equal, which is
not an ordering, and is reported rather than passed to C.

The sequence lives as long as the subscription. The last `dispose()` removes it,
and statements that referenced it then fail with `no such collation sequence`.
That is not tidiness: a comparator is a JavaScript callback SQLite holds a raw
pointer to, and freeing it while the sequence is still registered is a
use-after-free the next comparison walks into — reproduced as `SIGSEGV`, and
kept reproduced by two cases in the crash matrix.

Declaring a column `COLLATE NAME` resolves the name at `CREATE TABLE` time, so a
sequence supplied through this hook cannot be used in DDL: attach first, or
write `ORDER BY v COLLATE NAME` at the query.

#### The cost of a JavaScript collation

**Every comparison SQLite makes crosses into JavaScript.** Measured on this
library, one comparison costs **1.1–1.35 µs**. For scale, a `busy` retry — the
most expensive thing else in this README — costs about 3.4 µs, and it happens
once per lock contention rather than once per comparison.

The number of comparisons in a sort tracks **n log n**, and that was _measured,
not derived_: across three orders of magnitude the ratio of actual comparisons
to n·log₂n stayed within a band of **0.849 to 0.959**. So the cost of an
`ORDER BY` over a collated column is roughly `1.2 µs × n log₂ n`, and you can
work out your own case from that.

No multiplier against the built-in collations is quoted here on purpose. The
ratio moves by an order of magnitude with n, and it moves because SQLite's own
comparison gets _relatively_ cheaper, not because ours gets dearer — publishing
it would tell you something false about this library while looking precise. The
per-comparison cost and the measured count are the honest pair.

**Sorting is not the only thing that compares, and this is where it catches
people.** Declaring a collation costs nothing on its own: a column declared
`COLLATE NAME` and never sorted, grouped or constrained produced **zero**
comparator calls. But the moment the column is indexed or constrained, every
write pays:

| What                                     | Measured                                                   |
| ---------------------------------------- | ---------------------------------------------------------- |
| `INSERT` into a `UNIQUE` collated column | **7.5x** slower; about **13 comparisons per row inserted** |
| `SELECT DISTINCT` over a collated column | **15x** the crossings of the plain column                  |
| `GROUP BY` a collated column             | **29x**                                                    |
| `IN` with 5 elements over 20 000 rows    | **58 709** comparator calls                                |

Those are paid forever, by callers who never write an `ORDER BY` at all, and
nothing at the call site distinguishes the column that costs from the one that
does not.

So: a JavaScript collation is for **correctness on small result sets** — a
locale-aware ordering over a few hundred rows you are about to render. It is not
something to reach for on a large `ORDER BY`, and it is not something to attach
to an indexed or constrained column without deciding to.

### Lock contention, and why `retry` blocks

`busy: true` delivers an event when another connection holds a lock this
statement needs. With no handler at all — the default, and what SQLite does —
`SQLITE_BUSY` reaches the caller immediately.

```ts
withEvents(
  db,
  (e) => {
    if (e.type !== "busy") return;
    if (e.tries < 5) e.retry(10 * e.tries); // back off using SQLite's own count
    else e.giveUp();
  },
  LIB,
  { busy: true },
);
```

**Nothing happens unless you call `retry()` or `giveUp()`.** The event's return
value is ignored, as everywhere but `precommit`, and **doing nothing gives up**.
That default is the point: a listener written `async () => { ... }` returns a
Promise, a Promise is truthy, and a library that passed the return value through
to SQLite would retry forever — a process pinned at 100% CPU that never returns.
Measured with such an implementation and an async listener: 1786 retries in 2
seconds, and it only stopped because the test forced it to. Returning a
thenable, returning a truthy value and throwing all end in `SQLITE_BUSY` and the
process making progress. Doing nothing is also reported through
`onListenerError`, so "I declined" and "I did not handle this event" do not look
the same in a log.

**`retry(afterMs)` blocks the entire process.** It is a synchronous sleep, not a
scheduled delay: no timers run, no I/O completes, no other connection makes
progress, and in a server every other request stops for the duration. It reads
like an async delay at the call site and is not one. Prefer several short waits
with your own backoff on `tries` over one long one; a single wait above a second
draws a one-time warning. The delay is required and floored at 1 ms, because a
zero wait returns straight to SQLite and busy-spins — SQLite's own timeout
handler sleeps for exactly this reason, and a JavaScript handler that returns
immediately was measured at 294,000 retries per second.

The wait uses `Atomics.wait`, which is available on Deno's main thread but
**throws on a browser main thread**. A browser or WASM port cannot offer `retry`
outside a worker, and must make it unavailable rather than approximate it: a
`retry` that cannot block is the busy-spin. It is the first thing here whose
availability, rather than only its cost, depends on the host.

`busy` is not a guarantee that contention is handled. SQLite may decline to
invoke the handler at all when it decides that waiting could deadlock, and
return `SQLITE_BUSY` directly, so a caller must still expect it.

A listener must not touch the connection from a `busy` event. SQLite alone among
the hooks permits this, and this library refuses it anyway: one exception would
make "no hook may touch the connection" hold for four callbacks and stop at the
fifth, and from a busy listener it can deadlock with no way to bound it. The
refusal says so. As everywhere, the refusal covers the driver methods this
library replaces rather than every route into SQLite — see hard limit 6.

#### If something else takes the busy handler

`sqlite3_busy_timeout` and `PRAGMA busy_timeout` are implemented by installing a
busy handler, so setting either **replaces ours** and busy events stop. Unlike
the progress handler this is detectable: `PRAGMA busy_timeout` reads `0` while
ours is installed, so any non-zero reading means we were displaced. It is
reported once through `onListenerError` and never repaired. Reading `0` is
ambiguous — it is also what "no handler at all" reads — so only the non-zero
direction says anything, which is all detection needs.

### Progress ticks, and what an abort actually costs

`progress` asks for a callback roughly every N virtual-machine instructions
during a long statement, which is how you build a cancel button:

```ts
withEvents(
  db,
  (e) => {
    if (e.type === "progress" && userClickedCancel) e.abort();
  },
  LIB,
  { progress: 1000 },
);
```

There is deliberately **no default** for `progress`. An unregistered handler
costs nothing, a badly chosen one costs every query in the process, and the
number that matters is what your listener does per tick, not what the callback
costs to reach. Measured on a 50 ms statement, with a callback that does
nothing:

| `progress` | overhead  | ticks per run |
| ---------- | --------- | ------------- |
| `1000`     | free      | 5,100         |
| `100`      | **+12%**  | 51,000        |
| `10`       | **+123%** | 510,000       |

**`abort()` is the only thing that interrupts.** The event's return value is
ignored, like every event's except `precommit`. That is deliberate: a progress
listener written `async () => { ... }` returns a Promise, a Promise is truthy,
and a library that passed the return value through to SQLite would abort every
query in the process. Returning a thenable, returning a truthy value and
throwing all leave the statement running — a thrown error is reported, but an
exception is not consent to abort.

#### Aborting inside a transaction discards the transaction

This is the part to know before you offer anyone a cancel button. `abort()` does
not cancel a statement — inside an explicit transaction it **discards every
uncommitted change back to `BEGIN`**. The next `COMMIT` fails with "cannot
commit - no transaction is active", the rows you wrote before the abort are
gone, and the connection keeps working, so nothing looks broken. Aborting a
plain read leaves the transaction intact; aborting a **write** takes the
transaction with it.

`abort()` is also **best effort**, because `progress` is a granularity and not a
deadline. A statement that finishes before the next tick cannot be interrupted
at all: aborting a `SELECT count(*)` over 50,000 rows returned the correct
answer with no error.

It is honoured only during the tick it was handed to, and only when called
synchronously from the listener. Keeping it and calling it later interrupts
nothing and is reported through `onListenerError` rather than silently doing
nothing.

#### If something else takes the progress handler

A connection has one progress handler and installing ours replaces any other.
Unlike the WAL and trace hooks there is **no way to detect being replaced**:
`sqlite3_progress_handler` returns `void`, there is no pragma, and "was that
statement long enough to tick" is exactly what only the handler can answer — so
any detector would be a wall-clock guess about instruction counts, which would
report displacement that had not happened. Documented rather than guessed at.

### Tracing, and what ends up in your logs

`trace` opts in to statement, profile and row events. It is off unless you ask,
because it changes what your listener receives and because one of the three is
expensive:

```ts
withEvents(db, listener, LIB, { trace: true }); // statement + profile
withEvents(db, listener, LIB, { trace: ["statement"] }); // just the SQL
```

`trace: true` is `["statement", "profile"]`, which measured **+1.1%** on a
read-heavy workload — free, in practice. `"row"` fires once per **result row**
and measured **2.95x** on a `SELECT` of 100,000 rows. It is never in the default
mask; include it deliberately and for a short time.

SQLite ignores a trace callback's return value today and asks implementations to
return zero so it can start using it later, so the trace events are a **void
contract**: your return value is discarded whatever it is.

`SQLITE_TRACE_CLOSE` is deliberately **not** offered. It only fires if the
callback is still registered when `sqlite3_close()` runs, and this library
unregisters every callback while the connection is still alive — which is why
using a closed connection throws here instead of crashing. Keeping a callback
registered across the close to deliver one event would trade that guarantee for
information you already have earlier: `db.close()` is intercepted, and your
subscription is disposed there, while the connection still works.

#### What the SQL text contains, which is not what "unexpanded" suggests

```ts
withEvents(db, listener, LIB, { trace: true, sql: "statement" });
```

| `sql`                     | `SELECT * FROM users WHERE tok = ? AND id > 0`, bound to `'s3cret'` | Private?              |
| ------------------------- | ------------------------------------------------------------------- | --------------------- |
| `"statement"` _(default)_ | `SELECT * FROM users WHERE tok = ? AND id > 0`                      | bound parameters only |
| `"normalized"`            | `SELECT*FROM users WHERE tok=?AND id>?;`                            | yes                   |
| `"with-parameter-values"` | `SELECT * FROM users WHERE tok = 's3cret' AND id > 0`               | no, and says so       |

**`"statement"` protects bound parameters only.** A literal written directly
into the SQL string is logged verbatim — look at the `0` surviving in the table
above, and imagine it were a token. It is the safe _default_, not the safe
_choice_: choosing it for privacy reasons would be wrong in a way you could not
see from the option's name.

**`"normalized"` is the only genuinely private mode.** It replaces every
literal, bound or inline, which also makes it the right one for telemetry —
expanded SQL is actively bad for grouping, since every distinct parameter value
produces a distinct string. It needs a `libsqlite3` built with
`SQLITE_ENABLE_NORMALIZE`, which stock distribution builds do not set; check
`capabilities.normalizedSql` first. Asking for it without that **throws** rather
than quietly giving you `"statement"`, because a privacy mode that silently
downgrades is worse than one that is absent. SQLite calls the normalisation
"unspecified and subject to change", so read it, do not parse it.

**`"with-parameter-values"` inlines every bound value.** Local debugging only.
The default is `"statement"` on every library, capable or not, so that what you
log never changes with the build.

#### If something else takes the trace callback

A connection has one trace callback, and calling `sqlite3_trace_v2` yourself
replaces ours — after which no statement, profile or row events arrive. There is
no way to read back what is installed, so this is detected indirectly: a
transaction that commits must have run a statement, and a statement that runs
always traces, so a commit with no statement trace means we were replaced. It is
reported through `onListenerError` once and never repaired, because you asked
for your own callback. The inference needs `"statement"` in the mask; it is not
attempted otherwise.

### WAL mode, checkpointing, and what attaching would otherwise cost you

Row and commit events are **identical** in WAL mode and in rollback-journal mode
— same event types, same order, same batching (verified on SQLite 3.45.1). The
only difference is that `wal` events exist in WAL mode and never fire outside
it.

Registering a WAL hook is not free, and the cost is not obvious. SQLite
implements **automatic checkpointing by installing its own WAL hook**:
`sqlite3_wal_autocheckpoint()` is a wrapper around `sqlite3_wal_hook()`. A
connection may have only one, so registering ours displaces SQLite's and
auto-checkpointing stops — with no error, no exception, and a write-ahead log
that then grows without bound. Measured on SQLite 3.45.1 over 4000 commits of a
2 KB row: the WAL settles at 4.1 MB untouched, and reaches 33.3 MB and climbing
with a naive hook installed.

So this library does not leave it displaced. At attach it reads the threshold
actually in force and replicates what it took over: a PASSIVE checkpoint from
inside the hook once the frame count reaches that threshold, which is precisely
what SQLite's own hook does. The default is that **attaching changes nothing
except that events now arrive**. If you want the job yourself, say so
explicitly:

```ts
withEvents(db, listener, LIB, { checkpoint: "caller" });
```

and **you are then responsible for periodic checkpoints or your WAL grows
without bound**. To change the threshold rather than the ownership, pass
`walCheckpointThreshold` — do not use the pragma, for the reason below.

**`PRAGMA wal_autocheckpoint` is not usable while attached.** Setting it
re-registers SQLite's hook, which removes ours, and `wal` events stop. This
library detects that at the next commit and reports it through
`onListenerError`; it does **not** silently reinstall itself, because you asked
for your checkpointing back and taking it away again would leave you fighting a
library you cannot see. Re-attach when you want events again. Reading the pragma
is no better: while our hook is installed it returns `0`, because from SQLite's
point of view auto-checkpointing is off — we are doing it.

### A second connection is invisible

The hooks are per-connection. A write made on any other connection to the same
file — another `Database` in this process, or another process entirely — fires
**nothing at all** here, and this is verified rather than assumed: a second
connection inserting a row produced no events on ours, while a subsequent read
on ours returned the new row. Data changed, the change stream said nothing, and
the next query saw it.

If more than one writer touches the database, these events are not a complete
description of what changed, and invalidation built only on them will serve
stale results. There is no fix inside this library: SQLite has no cross-process
change notification. Either funnel writes through the connection you attached
to, or treat the events as a fast path over a slower source of truth.

### Not verified here

Stated as open questions rather than as claims, because they have not been
tested in this repository:

- Whether writes to SQLite's internal system tables (`sqlite_sequence` and
  friends) are reported. `sqlite3_update_hook` is documented as not firing for
  them; untested here.
- Whether hooks fire for writes to an `ATTACH`-ed schema. The events carry a
  schema name, which suggests they do, but "suggests" is why this is in this
  list.
- Whether row changes made by triggers, including recursive triggers, are
  reported, and at what `depth`.

### The dispose boundary

While a subscription is attached, this library intercepts the connection's
methods, so using a `Database` after `close()` throws a clear error. After
`dispose()` it does not: the driver's own methods are restored, and
use-after-close is undefined behaviour again. It has two shapes and **the quiet
one is not the safer one** — `openBlob()` dereferences the freed handle and
takes the process down with SIGSEGV, while `exec()` returns as though it worked.
A silent wrong answer is worse than a crash, not better.

`dispose()` restores the driver's methods deliberately. A dispose that leaves
behaviour behind is not a dispose, and this library will not permanently alter
an object it was lent in order to compensate for a defect that is not its own.
Both shapes are recorded in `DRIVER_DEFECTS.md` with reproductions.

The crash suite's guarantee is scoped to match: **no permutation of API calls on
a connection this library is watching may segfault.** Nothing is promised about
a connection it has detached from and no longer controls, because nothing can
be.

### Keying a cache by table

If you build invalidation on these events, key it on the **(schema, table)
pair** where you have both — but note that `authorize` events do not always
carry a schema. `SELECT count(*) FROM t` reports the table with an _empty_
column name and a _null_ schema, and a join produced the same for one side. So a
map built from authorizer events needs a key that tolerates a missing schema,
while the row events always carry one. Whatever you choose, do not join them
into a string. Quoted SQLite identifiers are arbitrary text —
`ATTACH ':memory:' AS "a b"` is legal, and so is `CREATE TABLE "b c"` — so
schema `a b` with table `c` and schema `a` with table `b c` collide under any
single-character separator. Whatever character you pick can appear in a name.

### Virtual tables change under other names

A row written into an FTS5 table `ft` arrives on the update hook as
`ft_content`, `ft_docsize` and `ft_data`, never as `ft`; a `MATCH` over it names
`ft` when the statement is prepared and those shadow tables when it is stepped.
Compare the two sets directly and nothing over such a table ever matches.

`captureSchemaMap(db)` reads the schema once and answers both directions:

```ts
import { captureSchemaMap } from "jsr:@jbsiddall/reactive-sqlite";

const map = captureSchemaMap(db);
map.resolveTable("ft_content"); // { kind: "shadow", canonical: "ft", ... }
map.resolveTable("orders"); // { kind: "table",  canonical: "orders", ... }
map.shadowsOf("ft"); // ["ft_config","ft_content","ft_data","ft_docsize","ft_idx"]
```

Detection comes from `PRAGMA table_list`, which is SQLite's own classification
and covers whatever modules the library was built with; the owning virtual table
is derived from the name, because nothing reports it. The derivation is verified
against `fts5` and `rtree` specifically — the two modules present on both
libraries this project builds against. No vector module is reachable here, so
`vec0` is untested rather than known-good, and so is any other module: the
detection half should still hold, the attribution half rests on a naming
convention that has only been checked on those two. Where the two disagree the
map says so rather than guessing: a table merely _named_ like a shadow
(`ft_notes` beside `ft`) resolves to itself and is listed on `shadowLookalikes`,
and a shadow whose owner cannot be derived comes back as
`kind: "unattributable-shadow"` carrying no `canonical` field at all, so it
cannot be mistaken for the ordinary path.

It is a **snapshot**, not a live view: nothing after the capture is visible to
it, deliberately, because it is meant to be consulted from inside hook callbacks
where issuing SQL is undefined behaviour. `map.refresh(db)` returns a new one.

### Keeping the snapshot current

`CREATE VIRTUAL TABLE` or `DROP` after the capture makes the snapshot wrong in
the quiet direction — a shadow table whose owner did not exist at capture time
resolves to `"unknown"`, so a change over it matches nothing. `watchSchema`
decides when a new reading is taken and takes it. It is a trigger, not a policy
engine: there is no subscription registry and nothing is re-run.

```ts
import { watchSchema, withEvents } from "jsr:@jbsiddall/reactive-sqlite";

let watch;
const sub = withEvents(db, (e) => watch.observe(e), LIB, { authorize: true });
watch = watchSchema(db);

db.exec("CREATE VIRTUAL TABLE ft USING fts5(body)");
watch.map.resolveTable("ft_content"); // { kind: "shadow", canonical: "ft", ... }
watch.refreshCount; // 1
```

**The signal is the authorizer's DDL action codes**, not the commit batch. The
obvious alternative — treat `coverage: "unknown"` as "DDL happened", since
`update_hook` does not report writes to `sqlite_schema` — is wrong for the one
case this map exists for: `CREATE VIRTUAL TABLE ft USING fts5(body)` commits
with `coverage: "complete"` and two changes, because creating an FTS5 table
writes two rows into `ft_data`, which is an ordinary table. (The other shadow
tables — `ft_config`, `ft_content`, `ft_docsize`, `ft_idx` — are created, but no
row is written into them by the `CREATE`.) A watcher keyed on `"unknown"` misses
every FTS5 creation while appearing to work on plain tables. SQLite's schema
cookie is not usable either: reading it is a query, and it is per-schema, so one
`PRAGMA main.schema_version` would silently suppress refreshes for every
ATTACHed schema.

What that signal misses, stated rather than assumed: **a schema change made on
another connection to the same file produces no event here.** `refreshNow()` is
the escape hatch. `ATTACH` and `DETACH` are reported to the authorizer but
produce no commit at all, so they arm the watch without draining it — call
`refreshIfArmed()` after attaching.

**Refresh runs at `postcommit` or in your own code, never inside a hook.**
Re-reading the schema issues SQL, and `change`, `precommit`, `rollback` and
`authorize` listeners run with the connection off limits. `refreshNow()` and
`resolveOrRefresh()` throw `SchemaWatchError` if called from there rather than
leaving you to find out; inside those listeners, read `watch.map` and handle
`kind: "unknown"` yourself.

**`resolveOrRefresh(name)` is what to do with `kind: "unknown"`, and it is
bounded.** A name that came back unknown might mean a stale snapshot, so it is
worth one re-read — but a name that will never appear must not cause a re-read
every time it is asked about, or staleness recovery becomes a hot loop that
presents as a performance problem rather than the correctness problem it is. The
bound is **at most one refresh per `(schema, name)` per generation**, and the
record of what has been tried is cleared only by a DDL-triggered refresh. Asking
about an absent name a thousand times costs one refresh; alternating between two
absent names costs two, not a thousand.

### Which tables a statement depends on

`extractDependencies` compiles a statement and reports the tables it touches,
read by SQLite's authorizer rather than by parsing the SQL. It never steps the
statement, so nothing is read and nothing is written.

```ts
import {
  captureSchemaMap,
  extractDependencies,
} from "jsr:@jbsiddall/reactive-sqlite";

const map = captureSchemaMap(db);
extractDependencies(db, "SELECT v FROM t", { schemaMap: map, libPath: LIB });
// { kind: "complete", reads: [{ schema: "main", name: "t" }], writes: [] }
extractDependencies(db, "SELECT 1", { schemaMap: map, libPath: LIB });
// { kind: "none" }  — no reads/writes fields at all
```

There is no registry here, no `stale` flag and nothing is re-run.

**The point of the four kinds is that partial looks like it works.** An
extractor returning `{a}` for a query that really depends on `{a, b}` produces a
live query that refreshes on most writes and is silently stale on the rest —
every test that writes to `a` passes, nothing ever throws, and it surfaces
months later as "it sometimes doesn't update". So anything the extractor cannot
see through downgrades the whole result to `kind: "unknown"` and says why in
`limits`, instead of being quietly left out of the set. `"complete"` and
`"unknown"` mean here what they mean on `Batch.coverage`.

The other two kinds carry **no `reads` and no `writes` fields at all**, so a
caller cannot reach for the sets without branching. `"none"` is a statement that
genuinely depends on nothing and should never be refreshed; `"failed"` is a
statement that did not compile, and treating it as an empty set would build a
live query that never refreshes. Making them different shapes in the type is the
same move `Resolution`'s `"unattributable-shadow"` makes.

**A view is dropped in favour of what its body reads.** `SELECT * FROM v` is
reported by SQLite as a read of `v` _and_ a read of the underlying `t`;
recording `v` is what the SQL says and is exactly wrong, because SQLite never
reports a row change on a view. `Resolution` gained a `"view"` kind with no
`canonical` for the same reason. **A trigger's writes are included** even though
the table appears in no SQL anyone wrote. **A query written against a shadow
table canonicalises** to the virtual table that owns it.

**What it misses, measured rather than assumed:**

- Only the first statement of a multi-statement string is compiled, so anything
  after it downgrades the result to `"unknown"` — never `"complete"` with the
  rest of the tables quietly missing. What counts as "after it" is decided by
  SQLite, not by scanning for `;`: the tail is whatever `Statement.sql` did not
  consume, and it is handed back to SQLite to compile. Whitespace, comments and
  a bare `;` compile to no statement, so `SELECT x FROM t; -- note` is still
  `"complete"`, and so is `SELECT x FROM t WHERE x = ';'`.
- The answer describes the statement **as compiled under the current schema**.
  If the schema changes, SQLite re-compiles a prepared statement at the next
  step and the authorizer fires again with the _new_ dependencies — a view
  redefined between prepare and step reports the new table.
- A caller's own `authorize` listener cannot change the set by returning
  `ignore()`; extraction runs upstream of the verdict. A `deny` fails the
  compile and truncates what SQLite reports, so it arrives as `"failed"` rather
  than as a short, confident set.
- Hooks attached without `authorize: true` leave the hook off, and options are
  per connection. Rather than answer `"none"` for everything,
  `extractDependencies` compiles a fixed `SELECT 1` first and throws
  `DependencyError` if no authorize event arrives.

**What a call costs.** Measured 2026-09-09 on SQLite 3.45.1 and 3.53.4: 3.5 ms
per call with no `withEvents` registration held on the connection, and 0.027 ms
with one already held. The difference is `withEvents` attaching and detaching —
a dlopen and a full set of FFI callbacks — not the extraction, which is about
0.005 ms of prepare. Extracting in a loop with nothing else holding a
registration therefore pays that cost per statement, roughly 130x. Hold one
subscription open for as long as the connection is in use.

## Portability

Deno FFI over `@db/sqlite` today. Neither the event model nor the public API is
meant to be tied to one runtime or driver — the boundary is an opaque connection
pointer plus a handful of symbols — so Bun and Node-API backends can be added
without changing the API you write against. Neither exists yet.

## Licence

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
