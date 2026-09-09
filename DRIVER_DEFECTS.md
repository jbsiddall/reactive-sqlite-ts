# Driver defects

Bugs in `@db/sqlite` that this library works around, cannot work around, or
merely runs into. Each one has a minimal reproduction that has been run, so it
is ready to send upstream. Nothing here has been reported yet.

Each entry says three things: what it does, what it SHOULD do, and **whether we
intend to fix it when the code is ours.** That last part is there because this
file is about to change what it is. While the driver is someone else's, this is
a bug report; once the driver is vendored, it becomes the changelog of what we
fixed and what we deliberately left alone. Writing the decision down now means
the vendoring inherits it rather than rediscovering it.

## `openBlob()` on a closed Database segfaults

**Version:** `@db/sqlite` 0.13.0. **Impact:** process death, exit 139, no
JavaScript error.

`Database#close()` frees the `sqlite3*` but leaves the object usable, and
`openBlob()` dereferences the freed handle. No hooks are involved; this is the
driver alone.

```ts
const db = new Database(":memory:");
db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, b BLOB)");
db.exec("INSERT INTO t VALUES (1, zeroblob(8))");
db.close();
db.openBlob({ table: "t", column: "b", row: 1 }); // SIGSEGV
```

**Should:** `close()` should either null the handle and make every subsequent
method throw, or `openBlob()` should check the handle before dereferencing it.
Either one turns a segfault into an exception.

**When the code is ours: fix it.** A null check on the handle in every method
that dereferences it, not just `openBlob()` — the same shape is reachable from
anything that takes the raw pointer after `close()`. Process death with no
JavaScript error is the worst failure mode in the list and the cheapest to
close.

While a subscription from this library is attached, the call is intercepted and
throws instead — see the dispose boundary in the README's hard limits. After
`dispose()` the driver's own methods are back and so is the crash.

## Binding `-0` throws

**Version:** `@db/sqlite` 0.13.0. **Impact:** the write never happens, so no
events fire either.

`-0` satisfies the driver's integer test and reaches `sqlite3_bind_int`, which
rejects it.

```ts
db.prepare("INSERT INTO t VALUES (?, ?)").run(1, -0);
// TypeError: Invalid FFI i32 type, expected integer
```

**Should:** `-0` is `0`. The bind should route it to `sqlite3_bind_int` as `0`,
which is what SQLite stores for it anyway.

**When the code is ours: fix it.** `Object.is(v, -0)` in the integer branch,
normalising to `0`. One line, no behaviour anyone could be relying on.

Found by the property suite, which now excludes `-0` from its generators for
this reason.

## `finalize()` throws the statement's LAST error, not a finalize error

**Version:** `@db/sqlite` 0.13.0. **Impact:** a `try/finally` cleanup throws,
masking whatever the caller was actually handling.

`sqlite3_finalize` returns the most recent error the statement produced while
running, not an error from finalizing. The driver passes that return code
through `unwrap()`, so finalizing a statement whose last use failed throws —
even though the statement was released correctly.

```ts
// A statement whose collating sequence went away: it expires, the re-prepare
// fails, and releasing it then reports the re-prepare's error a second time.
const stmt = db.prepare("SELECT v FROM t ORDER BY v COLLATE REV");
stmt.all(); // fine, while the sequence is registered
sub.dispose(); // the sequence is removed
stmt.all(); // SqliteError: no such collation sequence: REV
stmt.finalize(); // SqliteError: 1: SQL logic error   <- the sticky rc
```

Run against system SQLite 3.45.1 on 2026-09-09. The negative control in the same
run: a statement that ran cleanly finalizes without complaint, so the throw is
the sticky code and not finalize refusing every statement.

**Should:** `finalize()` should release the statement and return. SQLite's own
documentation says the return code of `sqlite3_finalize` reflects the last
execution and that applications should not use it to decide whether finalizing
succeeded.

**When the code is ours: fix it.** Ignore the return code of `sqlite3_finalize`
entirely. It is the documented reading, and a cleanup path that can throw is
worse than no diagnostic at all — it turns one failure into two and hides the
first.
