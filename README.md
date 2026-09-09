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

## Capability table

What SQLite itself allows, and what is built. "Veto" means the C callback's
return value can change what the database does.

📅 = roadmap, not yet implemented.

| Event                       | C hook                     | Pre | Post | Veto                       | Notes                                                    |
| --------------------------- | -------------------------- | --- | ---- | -------------------------- | -------------------------------------------------------- |
| Row insert/update/delete    | `sqlite3_update_hook`      | no  | yes  | no (returns `void`)        | Blob writes invisible; see limits                        |
| Row change with old/new     | `sqlite3_preupdate_hook`   | yes | no   | no (returns `void`)        | Needs `SQLITE_ENABLE_PREUPDATE_HOOK`                     |
| Commit                      | `sqlite3_commit_hook`      | yes | no   | **yes** → rollback         | Scope is the whole transaction, not one row              |
| Rollback                    | `sqlite3_rollback_hook`    | no  | yes  | no                         |                                                          |
| Commit landed               | — (synthesised)            | no  | yes  | n/a, already happened      | No C hook: commit hook runs _before_ commit              |
| 📅 WAL frame written        | `sqlite3_wal_hook`         | no  | yes  | no; controls checkpoint    |                                                          |
| 📅 Statement lifecycle      | `sqlite3_trace_v2`         | yes | yes  | no                         |                                                          |
| 📅 Statement progress       | `sqlite3_progress_handler` | —   | —    | **yes** → aborts stmt      | Fires during execution                                   |
| 📅 Lock contention          | `sqlite3_busy_handler`     | —   | —    | **yes** → retry or busy    | Fires during execution                                   |
| 📅 Unknown collation needed | `sqlite3_collation_needed` | yes | no   | no; supplies the collation | Fires when a statement names an unregistered collation   |
| 📅 Statement authorisation  | `sqlite3_set_authorizer`   | yes | no   | **yes** → `DENY`/`IGNORE`  | Prepare-time; table/column names only, no rows or values |

## Coverage

Each batch carries a `coverage`: `"complete"` (every row present), `"truncated"`
(more rows changed than the retention limit), or `"unknown"` (nothing observed —
**not the same as nothing having changed**). Branch on it, and fall back to a
full refresh rather than reading an empty change list as an idle transaction.

## Hard limits

Properties of SQLite, not of this implementation.

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

## Portability

Deno FFI over `@db/sqlite` today. Neither the event model nor the public API is
meant to be tied to one runtime or driver — the boundary is an opaque connection
pointer plus a handful of symbols — so Bun and Node-API backends can be added
without changing the API you write against. Neither exists yet.

## Licence

MIT — see [LICENSE](./LICENSE).
