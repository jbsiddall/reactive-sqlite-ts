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

It must be the _same file_ the driver loads. `@db/sqlite` reads
`DENO_SQLITE_PATH` once at import time and otherwise downloads a prebuilt
library of its own; if the two differ, the `sqlite3*` handle passed across
belongs to a foreign build and the process dies of `SIGSEGV` — exit 139, no
exception, no message. The library compares `sqlite3_libversion()` against the
driver's `sqlite_version()` and refuses to attach on a mismatch, which catches
the realistic mistake but is not proof of one file.

## Usage

Reject rows that fail validation, by vetoing the commit:

```ts
import { Database } from "@db/sqlite";
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

📅 = roadmap, not yet implemented.

| Event                       | C hook                     | Pre | Post | Veto                       | Notes                                                    |
| --------------------------- | -------------------------- | --- | ---- | -------------------------- | -------------------------------------------------------- |
| Row insert/update/delete    | `sqlite3_update_hook`      | —   | —    | no (returns `void`)        | SQLite documents the timing as undefined; see limits     |
| Row change with old/new     | `sqlite3_preupdate_hook`   | yes | no   | no (returns `void`)        | Needs `SQLITE_ENABLE_PREUPDATE_HOOK`                     |
| Commit                      | `sqlite3_commit_hook`      | yes | no   | **yes** → rollback         | Scope is the whole transaction, not one row              |
| Rollback                    | `sqlite3_rollback_hook`    | no  | yes  | no                         |                                                          |
| Commit landed               | — (synthesised)            | no  | yes  | n/a, already happened      | No C hook: commit hook runs _before_ commit              |
| WAL commit written          | `sqlite3_wal_hook`         | no  | yes  | **no** — see note below    | Displaces auto-checkpointing; we replicate it            |
| Statement lifecycle         | `sqlite3_trace_v2`         | yes | yes  | no — return value ignored  | `row` fires per result row and measured ~3x; opt in      |
| Statement progress          | `sqlite3_progress_handler` | —   | —    | **yes** → `abort()` only   | Return value ignored; `abort()` interrupts, see below    |
| Lock contention             | `sqlite3_busy_handler`     | —   | —    | **yes** → `retry()` only   | Return value ignored; `retry()` BLOCKS the thread        |
| 📅 Unknown collation needed | `sqlite3_collation_needed` | yes | no   | no; supplies the collation | Fires when a statement names an unregistered collation   |
| 📅 Statement authorisation  | `sqlite3_set_authorizer`   | yes | no   | **yes** → `DENY`/`IGNORE`  | Prepare-time; table/column names only, no rows or values |

## This library versus the other SQLite bindings

A different question from the table above: not "what does SQLite allow" but
"which binding should you reach for". This library is not a SQLite driver. It is
a hook layer on top of [`@db/sqlite`](https://jsr.io/@db/sqlite), so wherever a
row below says _via `@db/sqlite`_ the feature is the driver's, available to you
because you are still holding the driver's `Database`, and unaffected by
anything here.

Legend: 📅 roadmap in this library, not implemented — same convention as the
capability table above.

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
| `collation_needed`               | 📅                          | no                                    | no                                      | no           | no                                      | no                      | yes         |
| authorizer                       | 📅                          | no                                    | yes — `setAuthorizer`                   | no           | no                                      | no                      | yes         |
| session / changesets / patchsets | no                          | no                                    | yes — `createSession`, `applyChangeset` | no           | no                                      | no                      | yes         |

Any of these can set `PRAGMA busy_timeout`; that row is about the C-level
handler or a constructor option. "sqlite-wasm" here means the C API the official
build exposes to JavaScript, which you drive yourself — there is no
`db.onUpdate(...)` convenience wrapper, and a callback must be installed as a
WASM function pointer.

### Extending SQLite, and moving data in and out

| Feature                   | reactive-sqlite  | better-sqlite3              | `node:sqlite`             | `bun:sqlite` | `sqlite3`         | `@db/sqlite`     | sqlite-wasm                  |
| ------------------------- | ---------------- | --------------------------- | ------------------------- | ------------ | ----------------- | ---------------- | ---------------------------- |
| Scalar functions          | via `@db/sqlite` | yes                         | yes                       | no           | no                | yes              | yes                          |
| Aggregates                | via `@db/sqlite` | yes                         | yes                       | no           | no                | yes              | yes                          |
| Window functions          | no               | yes — `aggregate.inverse`   | yes — `aggregate.inverse` | no           | no                | no               | yes                          |
| Virtual tables            | no               | yes — `db.table`, read-only | no                        | no           | no                | no               | yes — `create_module`        |
| Custom collations         | no               | no                          | no                        | no           | no                | no               | yes                          |
| Incremental BLOB I/O      | via `@db/sqlite` | no                          | no                        | no           | no                | yes — `openBlob` | no — `blob_open` not exposed |
| Backup API                | via `@db/sqlite` | yes — async, with progress  | yes — `sqlite.backup`     | no           | yes — `db.backup` | yes              | no                           |
| `serialize`/`deserialize` | no               | yes                         | yes                       | yes          | no                | no               | yes                          |
| Loadable extensions       | via `@db/sqlite` | yes                         | yes                       | yes          | yes               | yes              | no — WASM                    |

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
   in SQLite; the library rejects it rather than corrupting state. Defer that
   work until after the commit.
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
    Deriving the owning virtual table from the shadow name is possible in
    principle (a virtual table `X` owns shadow tables named `X_*`), but this
    library does not do it and does not pretend to.
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
refusal says so.

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
pair**, not on a string you joined them into. Quoted SQLite identifiers are
arbitrary text — `ATTACH ':memory:' AS "a b"` is legal, and so is
`CREATE TABLE "b c"` — so schema `a b` with table `c` and schema `a` with table
`b c` collide under any single-character separator. Whatever character you pick
can appear in a name.

## Portability

Deno FFI over `@db/sqlite` today. Neither the event model nor the public API is
meant to be tied to one runtime or driver — the boundary is an opaque connection
pointer plus a handful of symbols — so Bun and Node-API backends can be added
without changing the API you write against. Neither exists yet.

## Licence

MIT — see [LICENSE](./LICENSE).
