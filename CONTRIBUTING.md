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

| Capability      | Gated on                                                           | Tests                                                                                               | Green against                                                                        |
| --------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `preupdate`     | `SQLITE_ENABLE_PREUPDATE_HOOK`                                     | every `preupdate:` scenario, the validation suite, `withValidation`                                 | **system 3.45.1** and **vendored 3.53.4** — both have it                             |
| `wal`           | not `SQLITE_OMIT_WAL`                                              | every `wal` scenario, `wal-hook-lifetime`                                                           | **system 3.45.1** and **vendored 3.53.4**                                            |
| `trace`         | not `SQLITE_OMIT_TRACE`                                            | every `trace:` scenario, `trace-close-ordering`                                                     | **system 3.45.1** and **vendored 3.53.4**                                            |
| `normalizedSql` | `SQLITE_ENABLE_NORMALIZE`                                          | `trace: normalized is refused rather than downgraded when absent`                                   | **vendored 3.53.4** for the present branch; **system 3.45.1** for the refusal branch |
| `collation`     | `sqlite3_collation_needed` and `sqlite3_create_collation` exported | every `collation:` scenario, `collation-use-after-dispose`, `collation-reregistered-under-one-name` | **system 3.45.1** and **vendored 3.53.4**                                            |

The gated test prints a visible `SKIP` line naming the library when it takes the
absent branch, so a run that quietly proved nothing is not mistakable for a run
that proved something.

### Which callbacks can be on the stack at once

Three of our callbacks fire MID-STATEMENT: `preupdate`, trace `row`, and
`progress`. Asked once for the set, so it does not have to be re-derived at
`busy_handler` and `set_authorizer`, which also fire mid-operation.

**None of the three can nest inside another.** The argument is structural, not
statistical: all three are invoked BY SQLite's bytecode engine, on the caller's
thread, and while one of our callbacks is executing the engine is suspended
inside it — it evaluates no further instructions, produces no further rows and
writes no further preupdate rows until we return. There is no path by which a
second one can be entered. A measurement is consistent with this (251 callback
entries, zero progress ticks observed inside any of them) but it is weak
evidence on its own, because the busy-work in that test was a JavaScript loop
and a JavaScript loop cannot advance the VM.

What CAN nest is a callback and a listener that re-enters SQLite: that is what
`reg.inHook` and `guard()` exist to DISCOURAGE, and it is unaffected by the
above. Discourage, not reject — `guard()` reaches only the driver methods this
library replaces, and `inFfi` catches a re-entry that gets past it by dropping
the nested event and reporting it, rather than preventing the re-entry. See
**How far the guard actually reaches** below. If a future hook fires from
somewhere other than the bytecode engine — a background thread, or an
unlock-notify callback — this reasoning does not transfer and the set must be
re-examined.

**That condition has already been met once, by `sqlite3_busy_handler`.** It
fires during lock acquisition rather than from a suspended engine mid-row, and
SQLite genuinely permits a busy callback to use the connection: a
`prepare("SELECT 1").get()` from inside one returns with no error. So it is not
covered by the argument above, and it was decided rather than derived. **We
refuse it anyway.** Allowing the one exception would make "no hook may touch the
connection" — the assumption behind `inFfi`, `reg.inHook`, `guard()` and the
re-entrancy fix — hold for four callbacks and stop at the fifth, which is the
defect shape this project has closed seven times. (The assumption is a rule
about listeners; `guard()` is only the part of it that is mechanically enforced,
and it does not cover every route. That is a separate matter from which callback
the rule applies to, and it does not weaken this decision.) The practical
argument stands alone too: the failure it prevents is a deadlock, and there is
no way to bound one. The refusal message explains this, so it reads as a
limitation rather than a bug.

Measured, with a real 2 ms dwell inside our callbacks so a lock attempt could
occur if one could: 3 of our callbacks, 4 busy invocations, zero overlap. (An
earlier probe reported zero from a flag that was set and cleared on the same
line, which meant nothing; this is the corrected run.) The reverse direction —
one of ours firing while a busy handler is on the stack — is reachable only
through the listener's own re-entrant call.

**OPEN.** That used to conclude "which is exactly what the refusal above
prevents". It does not. The refusal covers the driver methods this library
replaces, and a re-entrant call that does not go through one of them is not
refused — so the reverse direction is UNPROVEN rather than closed. Nothing is
known to have gone wrong; what is gone is the proof. See **How far the guard
actually reaches** below, and the open question there.

`set_authorizer` fires at prepare time and should be checked against this same
question rather than assumed to match either group.

### When a hook needs a verification phase before it is built

Two triggers, either one sufficient:

1. **It has a live verdict** — the callback's return value changes what SQLite
   does. `precommit`, `progress`, `busy` and `authorize` all qualify; `wal` and
   `trace` do not.
2. **Its purpose requires an operation the guard refuses.** A hook whose
   documented use is to call back into the connection collides with the rule
   behind `inFfi`, `reg.inHook` and `guard()`, and that is a design question
   rather than a build detail. `collation_needed` is the case: SQLite's
   documented design has the callback register the collation by calling
   `sqlite3_create_collation` on the connection, from inside the callback.

### A hook can observe the library itself

`set_authorizer` surfaced a defect class nothing before it could have: **our own
instrumentation became visible through the hook we were adding.** The
displacement checks from the WAL and busy chunks issue
`PRAGMA
wal_autocheckpoint` and `PRAGMA busy_timeout`, and `preupdate` reads the
schema — all through `rawPrepare`, all of which fire the authorizer. Measured
before any suppression existed: one `INSERT` produced three authorizer
callbacks, two of them ours, dispatched from inside `drain()`.

So the question to ask of every future hook is: **does this hook observe US?**
Every hook before this one reported on data changes or on statement execution,
and the library's own probes were invisible to them. Anything that reports on
compilation, on connection state, or on I/O can see the library working.

The suppression is bracketed around our own call sites — a flag set by a small
`ours()` wrapper — and never matched against SQL text. A text filter would also
swallow a caller's identical statement, and the caller would have no way to
learn why their `PRAGMA busy_timeout` never arrived. A filter keyed on what we
did is verifiable; one keyed on what a statement looks like is not. A test
asserts that the caller's own `PRAGMA busy_timeout` IS still delivered, so the
suppression cannot quietly widen later.

### Attribution hazards for a query-to-tables map

Recorded here because the live-query path will need them, and all three are
knowable now rather than after it is built:

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
table.

### The one gap that remains

The **absent-capability branches** — "preupdate unavailable",
`preupdate:
"required"` refusing, and `trace` being absent entirely — have never
run against a library that genuinely lacks those symbols, because both libraries
reachable here have them. The honest fixture for those is the prebuilt library
`@db/sqlite` downloads when `DENO_SQLITE_PATH` is unset, which carries a much
smaller symbol set. Not wired up.

### How far the guard actually reaches

`guard()` is the mechanically-enforced part of the rule "no listener may touch
the connection". The rule is wider than the mechanism, and this section says
exactly where the two part company, because for the whole life of the guard the
prose asserted the wider claim and nothing recorded the narrower truth.

**What it covers.** `guard()` runs on replaced methods only, and the
replacements are installed on the objects this library can reach:

- `Database`: `exec`, `run` (via `DB_METHODS`), plus `prepare`, `transaction`
  and `openBlob`, each patched individually. `close` is intercepted too, for
  callback lifetime rather than for the guard.
- `SQLBlob`: `writeSync`, `readSync`, `close`, wrapped on the object returned by
  the patched `db.openBlob`.
- `Statement`: `run`, `get`, `all`, `values`, `value` — **but only on statements
  created through the patched `db.prepare` after `withEvents` was called.** The
  driver installs these as OWN properties on each `Statement`, shadowing the
  prototype, so there is no prototype to patch and no way to reach a statement
  that already exists.

**What it does not cover.** Verified from inside a live `change` listener, each
of these reached SQLite with no refusal: `new Statement(db, sql).get()`,
`stmt.iter()`, `for..of stmt`, `stmt.finalize()`, `stmt.columnNames()`, and
`db.function()`. `db.backup()` was refused — by SQLite itself, not by us, which
is not the same thing and must not be counted as coverage. `db.sql` (tagged
template) IS refused, because it delegates to the patched `this.prepare`.

So: **`guard()` is a guardrail against the mistake a listener makes by accident,
not a barrier against what a determined caller can do.** A barrier was never
available. `unsafeHandle` is public, is JSDoc'd as public, and this library
depends on it itself; anything that can reach the raw `sqlite3*` can re-enter
SQLite without passing a single one of our replacements. `inFfi` is the second
line: a re-entry that gets past the guard has its nested event dropped and
reported, which contains the damage rather than preventing the call.

#### The attach-order hole

A `Statement` prepared BEFORE `withEvents` keeps unpatched own-property methods
for as long as it exists, and calling `stmt.get()` on it from inside a hook
returns a row (`{"c":2}` in the case that was run) instead of being refused. The
same statement prepared one line later is refused.

This is not a "known limitation", and writing it down as one would understate
it. What it costs is this: **the failure depends on when an object was
constructed, not on what the code does, so two identical-looking call sites
behave differently and nothing at the point of use distinguishes them.** A
reader looking at the call cannot tell which one they have. This is the
project's signature defect — a guarantee that holds at one level and stops
holding at another — in its purest form yet, and it is in our own guard.

The mechanism, so it is not re-derived: statement patches are installed inside
the patched `db.prepare`, because the driver writes `run`/`get`/`all`/`values`/
`value` as own properties on each `Statement` when there are no bind parameters,
shadowing the prototype. Those patches are recorded with `undoable = false`, so
they also outlive `detach()` — the asymmetry runs in both directions.

**OPEN, carried forward:** whether the unwrapped case can be made DETECTABLE
even where it cannot be REFUSED. Nothing here proposes widening the patch; that
is a separate change and is not made by the commit that wrote this section.

#### The record of the divergence (2026-09-09)

Against the driver `@db/sqlite` as vendored here, and both libraries in the
capability ledger above: the prose was broader than the mechanism for the entire
life of the guard, and nobody noticed, because on every case anyone actually
tried the two agreed. The disagreement needed a route that no test and no
example took.

**A rule documented wider than it is enforced is a latent version of this
project's signature defect.** It costs nothing while the two agree. The day
someone tightens the code to match the prose, or writes code that relies on the
prose being true, is the day it bites — and at that point the prose is the
evidence they were entitled to rely on.

## Changes to the FFI or native layer need out-of-process crash tests

Anything that touches `Deno.dlopen`, an `UnsafeCallback`, a borrowed `sqlite3*`,
or the lifetime of any of those must come with a case in the crash matrix
(`test/suite.ts` and its case table).

The rule exists because the failure mode here is not a thrown exception. Calling
into a freed callback, handing a handle to the wrong library, or closing a
connection from inside a LISTENER takes the whole process down with `SIGSEGV`.
(That last one is checked by `reg.inListener`, which is a different mechanism
from the in-hook `guard()`: it tracks whether any listener is running, so it
fires from a `postcommit` listener too, where using the connection is otherwise
allowed.) An in-process test cannot observe that: the runner dies with it, and
depending on how the harness reports, a segfault can be indistinguishable from a
pass.

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
