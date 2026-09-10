# Driver defects

**The driver is now ours.** It lives in `driver/`, vendored from
[the Deno SQLite3 driver](https://github.com/denodrivers/sqlite3) at release
0.13.0. `NOTICE` carries the attribution for that vendoring — project,
copyright, licence and what was modified — and not the release number, which is
recorded here. This file is therefore no longer a bug report about somebody
else's code: it is the record of which defects the vendoring fixed, which one it
deliberately carried, and where the vendored code diverges without any defect
being claimed on either side.

Every entry keeps the version it was first measured against, because that is
where the reproduction was run. Two are marked FIXED and have a regression case
in the repository; one is marked CARRIED, and the code that carries it says so
at the site. One is marked CHANGED: the behaviour differs and is pinned, but no
claim is made that what it replaced was wrong.

| Defect                                 | Status  | Pinned by                                          |
| -------------------------------------- | ------- | -------------------------------------------------- |
| `openBlob()` on a closed Database      | FIXED   | `driver-use-after-close` in `test/crash_cases.ts`  |
| Binding `-0` throws                    | FIXED   | the property suite's value generator               |
| `finalize()` throws the last run error | CARRIED | nothing — see the entry                            |
| Row readers generated JS source        | CHANGED | `driver internals: row readers` in `test/suite.ts` |

## FIXED — `openBlob()` on a closed Database segfaults

**First measured against:** `@db/sqlite` 0.13.0, and reproduced unchanged
against the vendored copy before the fix. **Impact:** process death, exit 139,
no JavaScript error.

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

**Fixed in `driver/database.ts`.** `close()` nulls the handle, and every method
that reaches it calls `#assertOpen()` first — not just `openBlob()`, because the
same shape is reachable from anything that takes the raw pointer after
`close()`. The call now throws `Database connection is closed`.

Measured against the vendored copy, in a child process so a crash cannot read as
a pass, with a control that must succeed in the same run:

```
                              before      after
blob-after-close              exit 139    exit 1, "Database connection is closed"
control-blob-while-open       exit 0      exit 0
```

Pinned by `driver-use-after-close` in `test/crash_cases.ts`, which opens the
same BLOB successfully before closing the connection, so a refusal that refused
everything could not pass it. Reverting the guard turns that case back into
`exit 139 signal SIGSEGV`; that was checked, not assumed.

This used to be reachable only outside a subscription: while one was attached
the call was intercepted and threw, and after `dispose()` the driver's own
methods came back and so did the crash. There is no longer a difference.

## FIXED — binding `-0` throws

**First measured against:** `@db/sqlite` 0.13.0, and reproduced unchanged
against the vendored copy before the fix. **Impact:** the write never happens,
so no events fire either.

`-0` satisfies the driver's integer test and reaches `sqlite3_bind_int`, which
rejects it.

```ts
db.prepare("INSERT INTO t VALUES (?, ?)").run(1, -0);
// TypeError: Invalid FFI i32 type, expected integer
```

**Should:** `-0` is `0`. The bind should route it to `sqlite3_bind_int` as `0`,
which is what SQLite stores for it anyway.

**Fixed in `driver/statement.ts`.** `Object.is(param, -0) ? 0 : param` in the
integer branch of `#bind`. One line, and no behaviour anyone could have been
relying on: the call used to throw.

```
                              before      after
bind-negative-zero            exit 1      exit 0, stored [0]
control-bind-positive-zero    exit 0      exit 0, stored [0]
```

Found by the property suite, which used to exclude `-0` from its generators for
this reason and now generates it deliberately — `fc.double` produces it far too
rarely to rely on. Removing the fix fails that suite.

## CARRIED — `finalize()` throws the statement's LAST error, not a finalize error

**This one is ours now, and it is still here.** It was inherited from
`@db/sqlite` 0.13.0, where it was first measured, but `driver/statement.ts` is
this repository's code and this is this repository's defect. Nobody else is
going to fix it.

**Impact:** a `try/finally` cleanup throws, masking whatever the caller was
actually handling.

`sqlite3_finalize` returns the most recent error the statement produced while
running, not an error from finalizing. `finalize()` passes that return code
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

**Deliberately not fixed in this change.** The vendoring corrects exactly the
two defects `NOTICE` names, so that the sentence in `NOTICE` and the diff can be
checked against each other in both directions. This one is left for its own
change, where the behaviour difference can be measured on its own.

**The fix, when it comes:** ignore the return code of `sqlite3_finalize`
entirely. It is the documented reading, and a cleanup path that can throw is
worse than no diagnostic at all — it turns one failure into two and hides the
first.

`finalize()` in `driver/statement.ts` carries a comment saying the same thing,
so the defect is visible where the code is, not only here.

## CHANGED — the row readers no longer generate JavaScript at run time

**Not a defect entry.** Nothing here claims the upstream readers were wrong. It
is recorded because the behaviour differs, and an undisclosed difference is the
thing that costs somebody a day.

Upstream built each row reader by assembling JavaScript source and compiling it
with `new Function`, interpolating the column names into that source. In
`driver/statement.ts` the readers are plain loops over the column list, so a
column name is data throughout and never becomes text that has to survive being
written into a program.

**Measured here, 2026-09-10, system SQLite 3.45.1**, by the row-reader scenario
in `test/suite.ts` (search it for "quotes and newlines"): columns named `a"b`
and `c` + newline + `d` read back correctly by name, as objects and as arrays;
and a column named `x");globalThis.PWNED=1;("` reads back as an ordinary key
with nothing evaluated.

**Why no claim about upstream.** Whether upstream would have thrown a
`SyntaxError` or executed the interpolated text on those names was never
measured, and the sources are no longer in this tree to measure. So `NOTICE`
discloses the divergence as three facts about this build and asserts nothing
about theirs. Establishing the stronger statement would mean fetching
`@db/sqlite` 0.13.0 into a scratch tree and running the same two names against
it; until somebody does, the weaker sentence is the honest one.
