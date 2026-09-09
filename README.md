# reactive-sqlite

SQLite's hook surface — `update`, `preupdate`, `commit`, `rollback`, WAL,
`trace`, `progress`, `busy` — as ergonomic, typed JavaScript events, with
changes batched per transaction and a commit that your code can veto.

> **Status: early, pre-1.0, API unstable.** `0.x` releases may break anything.
> Not yet recommended for production. Feedback and issues are very welcome.

## Why this exists

SQLite has had a genuinely good change-notification API since forever.
`sqlite3_update_hook` tells you which row of which table changed;
`sqlite3_preupdate_hook` hands you the old and new values; `sqlite3_commit_hook`
lets you refuse a commit outright. Almost none of that reaches JavaScript. Most
bindings expose `exec`, `prepare` and little else, so the ecosystem is left
polling, diffing, wrapping every writer in application-level bookkeeping, or
tailing the WAL.

This library does one thing: it puts those callbacks in front of you as typed
events, with the sharp edges guarded. It is deliberately small and deliberately
unopinionated — the intent is to be a stable base that reactive query layers,
sync engines, audit logs, cache invalidators and change-data-capture tools can
build on, rather than to be any of those things itself.

## Capability table

What SQLite itself offers, and therefore what this library can offer. "Veto"
means the C callback's return value can change what the database does.

| Event                           | C hook                     | Fires before | Fires after | Can veto / abort                                            |
| ------------------------------- | -------------------------- | ------------ | ----------- | ----------------------------------------------------------- |
| Row insert / update / delete    | `sqlite3_update_hook`      | no           | yes         | **no** — callback returns `void`                            |
| Row change with old/new values  | `sqlite3_preupdate_hook`   | yes          | no          | **no** — callback returns `void`                            |
| Commit                          | `sqlite3_commit_hook`      | yes          | no          | **yes** — non-zero turns it into a rollback                 |
| Rollback                        | `sqlite3_rollback_hook`    | no           | yes         | no                                                          |
| Commit landed (synthesised)     | —                          | no           | yes         | n/a — it has already happened                               |
| WAL frame written               | `sqlite3_wal_hook`         | no           | yes         | no veto; may return an error code and control checkpointing |
| Statement lifecycle / timing    | `sqlite3_trace_v2`         | both         | both        | no — the return value is reserved                           |
| Long-running statement progress | `sqlite3_progress_handler` | during       | during      | **yes** — non-zero aborts the statement                     |
| Lock contention                 | `sqlite3_busy_handler`     | during       | during      | **yes** — decides retry vs `SQLITE_BUSY`                    |

The "commit landed" event has no C hook behind it: SQLite's commit hook runs
_before_ the commit, so a "it is now durable" notification has to be synthesised
by the library after the writing call returns.

## Install

```sh
deno add jsr:@jbsiddall/reactive-sqlite
```

Registering hooks means calling into `libsqlite3` directly, so the process needs
FFI permission:

```sh
deno run --unstable-ffi --allow-ffi --allow-env --allow-read --allow-write your_app.ts
```

### The one setup rule: a single libsqlite3

Your SQLite driver and this library must load **the same** shared library. The
driver reads `DENO_SQLITE_PATH` once, at import time, and otherwise downloads a
prebuilt library of its own. If the two end up loading different builds, the
`sqlite3*` connection handle passed across belongs to a foreign build and the
process dies of `SIGSEGV` — exit 139, no exception, no message.

So: decide the library first, set `DENO_SQLITE_PATH`, and import the driver
after that.

```sh
# Linux
export DENO_SQLITE_PATH=/usr/lib/x86_64-linux-gnu/libsqlite3.so.0
# macOS (Homebrew)
export DENO_SQLITE_PATH=/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib
```

The library compares `sqlite3_libversion()` against the driver's reported
`sqlite_version()` and refuses to attach on a mismatch. Matching versions are
not proof of the same file, but they catch the realistic mistake.

## Usage

```ts
import { Database } from "@db/sqlite";
import { withEvents } from "@jbsiddall/reactive-sqlite";

const db = new Database("app.db");

const sub = withEvents(db, (event) => {
  switch (event.type) {
    case "change":
      // One row, mid-transaction. Do not touch the connection from here.
      console.log(event.table, event.action, event.rowid);
      return;

    case "precommit":
      // Return false to veto: the COMMIT becomes a ROLLBACK.
      return event.changes.every(isValid);

    case "postcommit":
      // It has landed; the connection is safe to use again.
      if (event.coverage !== "complete") refreshEverything();
      else applyRows(event.changes);
      return;

    case "rollback":
      // Discarded — explicitly, by failure, or by a veto.
      return;
  }
});

// ...later
sub.dispose();
```

A batch's `coverage` says how much of the transaction you were actually shown:
`"complete"` (every row is present), `"truncated"` (more rows changed than the
retention limit), or `"unknown"` (nothing was observed — **which is not the same
as nothing having changed**; see below). Branch on it, and fall back to a full
refresh rather than assuming an empty change list means an idle transaction.

## Hard limits

These are properties of SQLite, not of this implementation. No amount of library
design removes them.

1. **No row-level veto exists — from any hook.** Both `sqlite3_update_hook` and
   `sqlite3_preupdate_hook` return `void`. There is no way to reject or rewrite
   an individual row as it is written. The only veto point SQLite offers is the
   commit hook, which is all-or-nothing for the whole transaction. If you need
   per-row rejection, that is a `CHECK` constraint, a trigger, or validation in
   your own write path.
2. **Incremental blob writes are invisible to `update_hook`.** Writing through a
   blob handle changes the row and fires the commit hook, but never the update
   hook. Only `preupdate_hook` sees it, reported as a delete flagged by
   `sqlite3_preupdate_blobwrite`.
3. **`preupdate` requires a library built with `SQLITE_ENABLE_PREUPDATE_HOOK`.**
   It is off in a stock SQLite build. Debian and Ubuntu's `libsqlite3` enables
   it; Apple's system SQLite and Homebrew's do not. Where the symbol is absent,
   the preupdate events simply cannot be offered, and the library says so
   instead of failing obscurely.
4. **DDL is not reported as changes.** `CREATE TABLE` and friends write to
   `sqlite_schema`, which the update hook does not report, so such a transaction
   commits with an empty change batch.
5. **Some deletes are not reported either.** SQLite's truncate optimisation
   (`DELETE FROM t` with no `WHERE`) removes rows without invoking the update
   hook per row.
6. **A hook must not use the connection that invoked it.** Reading the database
   from inside a `change`, `precommit` or `rollback` callback is undefined
   behaviour in SQLite, and the library rejects it rather than letting it
   corrupt state. Do that work after the commit, or defer it.
7. **A veto surfaces to the caller as SQLite's generic "constraint failed".**
   That is the only thing SQLite reports; your own reason is attached alongside
   it by this library.
8. **One hook of each kind per connection.** SQLite keeps a single callback per
   kind, so multiple listeners have to be multiplexed by the library — and any
   other code registering its own hooks on the same connection will silently
   replace ours.
9. **FFI is a whole-process trust boundary.** `--allow-ffi` switches off the
   runtime sandbox for this library.

## Portability

The current implementation is Deno FFI over
[`@db/sqlite`](https://jsr.io/@db/sqlite). That is a starting point, not the
destination: neither the event model nor the public API is meant to be tied to
one runtime or one driver, and the boundary is kept narrow (an opaque connection
pointer plus a handful of symbols) so other backends can be added without
changing the API you write against. Bun and Node-API backends are on the
roadmap.

## Licence

MIT — see [LICENSE](./LICENSE).
