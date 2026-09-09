# Contributing

Issues and pull requests are welcome. The project is pre-1.0 and the API is
still moving, so open an issue before a large change.

## Running the tests

You need Deno 2.x and a `libsqlite3` on disk.

```sh
# Point BOTH the driver and our FFI at one library. This is not optional.
export DENO_SQLITE_PATH=/usr/lib/x86_64-linux-gnu/libsqlite3.so.0   # Linux
# export DENO_SQLITE_PATH=/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib  # macOS

deno task check       # fmt --check, lint, type check
deno task test        # the in-process suite
deno task test:crash  # the out-of-process crash matrix
```

If `DENO_SQLITE_PATH` is unset, the driver downloads and loads a prebuilt
library of its own while our FFI opens a system one. The two `sqlite3*` layouts
do not match and the process dies of `SIGSEGV` — exit 139, with no exception and
no output. A test run that dies this way is not a test failure you can debug; it
is a misconfigured environment. Set the variable.

The preupdate tests additionally need a library built with
`SQLITE_ENABLE_PREUPDATE_HOOK`. Debian and Ubuntu's `libsqlite3` has it; Apple's
system SQLite and Homebrew's do not. To build one:

```sh
curl -O https://sqlite.org/2026/sqlite-amalgamation-3530400.zip
unzip sqlite-amalgamation-3530400.zip && cd sqlite-amalgamation-3530400
cc -O2 -fPIC -shared -DSQLITE_ENABLE_PREUPDATE_HOOK -o libsqlite3.so sqlite3.c
export DENO_SQLITE_PATH="$PWD/libsqlite3.so"
```

Compiled libraries are not committed. `.gitignore` excludes them deliberately:
they are per-platform, unreviewable in a diff, and reproducible from the recipe
above.

## Capability ledger: which tests depend on which library

Some behaviour exists only if the loaded `libsqlite3` was compiled with the
right flag, so those tests take a different branch on a different library. A
test that has only ever run against a library _lacking_ the capability has
proved the fallback works and nothing else, so this table records which library
each one actually went green against.

Two libraries are reachable here. The **system** library is whatever
`DENO_SQLITE_PATH` points at — on Debian and Ubuntu, SQLite 3.45.1, which
carries every hook symbol this project uses except `sqlite3_normalized_sql`. The
**vendored** library is built by `deno task vendor:build` (SQLite 3.53.4 at the
time of writing, 23 flags, roughly a minute, nothing but `cc` needed) and has
all of them. The build output is gitignored and never committed.

| Capability      | Gated on                       | Tests                                                               | Green against                                                                        |
| --------------- | ------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `preupdate`     | `SQLITE_ENABLE_PREUPDATE_HOOK` | every `preupdate:` scenario, the validation suite, `withValidation` | **system 3.45.1** and **vendored 3.53.4** — both have it                             |
| `wal`           | not `SQLITE_OMIT_WAL`          | every `wal` scenario, `wal-hook-lifetime`                           | **system 3.45.1** and **vendored 3.53.4**                                            |
| `trace`         | not `SQLITE_OMIT_TRACE`        | every `trace:` scenario, `trace-close-ordering`                     | **system 3.45.1** and **vendored 3.53.4**                                            |
| `normalizedSql` | `SQLITE_ENABLE_NORMALIZE`      | `trace: normalized is refused rather than downgraded when absent`   | **vendored 3.53.4** for the present branch; **system 3.45.1** for the refusal branch |

The gated test prints a visible `SKIP` line naming the library when it takes the
absent branch, so a run that quietly proved nothing is not mistakable for a run
that proved something.

### The one gap that remains

The **absent-capability branches** — "preupdate unavailable",
`preupdate:
"required"` refusing, and `trace` being absent entirely — have never
run against a library that genuinely lacks those symbols, because both libraries
reachable here have them. The honest fixture for those is the prebuilt library
`@db/sqlite` downloads when `DENO_SQLITE_PATH` is unset, which carries a much
smaller symbol set. Not wired up.

## Changes to the FFI or native layer need out-of-process crash tests

Anything that touches `Deno.dlopen`, an `UnsafeCallback`, a borrowed `sqlite3*`,
or the lifetime of any of those must come with a case in the crash matrix
(`test/suite.ts` and its case table).

The rule exists because the failure mode here is not a thrown exception. Calling
into a freed callback, handing a handle to the wrong library, or closing a
connection from inside a hook takes the whole process down with `SIGSEGV`. An
in-process test cannot observe that: the runner dies with it, and depending on
how the harness reports, a segfault can be indistinguishable from a pass.

So each crash case runs as its own child process, and the suite asserts on the
child's **exit code** and output:

- exit `1` and a specific message — the guard fired and explained itself;
- exit `0` — the operation is genuinely safe;
- exit `139` — a real segfault, and always a failure, whatever else was printed.

When you add a guard, add the case that proves it fires, and the case that
proves the unguarded path used to crash. When you relax one, delete its case
explicitly rather than letting it quietly stop being exercised.

## Style

`deno fmt` and `deno lint` are enforced in CI; run `deno task check` before
pushing. Comments should say _why_, especially around the FFI boundary — most of
the code there exists because of a specific documented SQLite constraint, and
that constraint is the thing worth writing down.
