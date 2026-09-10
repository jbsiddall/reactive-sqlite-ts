# Contributing

Issues and pull requests are welcome. The project is pre-1.0 and the API is
still moving, so open an issue before a large change.

This file is "how do I work here". How the external things this library sits on
actually behave — the `@db/sqlite` driver's internals, SQLite's own behaviour,
and the version and date each was observed against — is in
[`DOMAIN_KNOWLEDGE.md`](./DOMAIN_KNOWLEDGE.md).

## Running the tests

You need Deno 2.x and a `libsqlite3` on disk.

```sh
# Point BOTH the driver and our FFI at one library. This is not optional.
export DENO_SQLITE_PATH=/usr/lib/x86_64-linux-gnu/libsqlite3.so.0   # Linux
# export DENO_SQLITE_PATH=/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib  # macOS

deno task check       # fmt --check, lint, type check
deno task test        # the in-process suite
deno task test:crash  # the out-of-process crash matrix
deno task test:table  # README's capability table still matches the libraries
deno task test:table-structure  # ...and its rows still match `Capabilities`
```

`test:table` needs all THREE libraries on disk — the system one, a vendored
build (`deno task vendor:build`), and the prebuilt `@db/sqlite` downloads when
`DENO_SQLITE_PATH` is unset. It is therefore not in CI, which builds neither of
the last two; it is a developer-machine check, and it says which library it
loaded from which path before it asserts anything. Run it after anything that
changes `Capabilities` or the vendored build's flags, and `deno task table` to
regenerate.

`test:table-structure` is the half of that question needing no library at all:
whether every field of `Capabilities` has a row, every row and every exemption
names a field that still exists, the rows follow declaration order, and the
committed block still has its markers, its observation date and nothing but
`yes`/`no` in its cells. It reads the field names out of the SOURCE TEXT of
`src/hooks.ts` rather than from `keyof Capabilities`, because the declaration is
the thing under suspicion: a check that derived the expected set from the type
would agree with any mistake made in it. That is why it can — and in CI does —
run before libsqlite3 is installed, and why adding a capability with no row
fails there rather than at the next developer's `test:table`.

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

### Open: CI tests the system library, and the gate procedure tests the vendored one

CI pins `DENO_SQLITE_PATH` at `/usr/lib/x86_64-linux-gnu/libsqlite3.so.0` — the
system 3.45.1 — so every suite that has ever run there ran against that library.
The procedure we run before pushing pins the vendored 3.53.4. Both are in the
ledger above, so neither is untested, but the two differ in exactly the places
the ledger's right-hand column is about: `normalizedSql` is present in one and
absent in the other, and it is the absent branch that CI exercises.

This is the same mechanism-versus-outcome split the capability table carries:
the mechanism is "whatever `DENO_SQLITE_PATH` names", and which library that
turns out to be is a separate fact that has to be stated rather than inferred.

Not decided here, because it is a decision about what CI should cover and not a
repair: whether CI should pin the vendored build instead, or run the suite
twice, once against each.

**Trigger:** decide it before the vendored library becomes the one this package
ships to users — that is the point at which a green CI run against 3.45.1 stops
describing what anybody actually runs.

### The refusal branches are a separate question, and mostly the answer is no

The table above is about the branch taken when a capability is PRESENT. Each
capability also has a branch that refuses the option when it is absent, and
whether those run is not the same question. `deno task test:capability-coverage`
measures it rather than asserting it: every refusal's condition is rewritten to
`false` in the source and the semantic suite is re-run. A suite that still
passes was not relying on that refusal.

Measured against system 3.45.1, 2026-09-09:

| Refusal for     | Exercised?                | By what                                          |
| --------------- | ------------------------- | ------------------------------------------------ |
| `normalizedSql` | yes, against real absence | 3.45.1 genuinely lacks `SQLITE_ENABLE_NORMALIZE` |
| `trace`         | no                        | —                                                |
| `authorize`     | no                        | —                                                |
| `busy`          | no                        | —                                                |
| `collation`     | no                        | —                                                |
| `progress`      | no                        | —                                                |
| `preupdate`     | no                        | —                                                |

One of seven. That is a measured negative, recorded here rather than left as an
absence someone later mistakes for a gap nobody checked.

**Why it is not simply fixable.** A refusal can only be exercised by a library
that genuinely lacks the symbol, or by an option that fakes the absence. Both
reachable libraries have every symbol except `SQLITE_ENABLE_NORMALIZE`, and only
`preupdate` has a faking option. So five of these branches have no way in at all
from this repository.

**`preupdate` is the one that looks covered and is not.** Five tests use
`preupdate: "off"`, and they are real tests of the fallback's behaviour — the
option and a genuinely absent API converge on one code path immediately, with
the reason carried as data. What `"off"` cannot reach is the DETECTION: the
`dlopen` that fails and the message composed from it, and the `"required"`
refusal, which on a library that HAS the symbol never fires. The two reasons in
`preupdateUnavailable` stay distinguishable on purpose, and there is now a test
asserting the option's reason names the option and does not blame the library:
"you turned this off" and "your SQLite was built without the flag" have
different remedies, and telling a caller the wrong one sends them to rebuild
SQLite over a config line.

`--check` compares the measurement against the states recorded in the tool and
fails on drift in either direction, so a branch that starts being exercised has
to be recorded as such and one that stops has to be explained. The tool has two
library-dependent controls — `normalizedSql` must classify as covered,
`progress` as uncovered — and withholds the whole report if either is wrong,
because a wrong control means every other row came out of the same broken
machinery. Finding zero branches is also a failure: a table of no rows reads as
"nothing uncovered".

A control only counts when the library can actually elicit it. On a library
built WITH `SQLITE_ENABLE_NORMALIZE` the `normalizedSql` control cannot apply —
`covered` requires a genuine absence — so that row is reported as not
exercisable there and only the `progress` control remains. Every control that
still applies then expects `uncovered`, which a pipeline that had stopped
reaching anything would satisfy just as well, so the run prints a line saying
its live controls are weak and the report is resting on the library-independent
ones: the synthetic decision fixtures and the canary branch. Neither is
redundant with the live controls; on such a library they are all there is. The
COUNT of not-exercisable rows is pinned per SQLite version and `--check` fails
on drift, so rows cannot quietly become unmeasured while the tool still exits 0.

### Superseded: the prebuilt column did not survive vendoring, but its numbers did

The reasoning this section used to carry: the `@db/sqlite prebuilt` column in
README's capability table was, before vendoring, the only library reachable here
that genuinely lacked `preupdate` and `progress`, so it was the only thing that
could ever cover those two refusals. It is also not a library this project
chooses, pins or ships: it is whatever `@db/sqlite` 0.13.0 downloads into
`$DENO_DIR/plug/` when `DENO_SQLITE_PATH` is unset, it changes without notice,
and once the vendored library ships it is not a configuration any user of this
package is in.

On that reasoning an earlier revision of this section recommended **dropping the
column** at vendoring. That recommendation is **superseded**, and the reasoning
was rejected for two things it did not account for.

First, dropping the column does not leave the tables silent about the prebuilt;
it leaves them asserting a state the tree does not have. The comparison tables
and the README capability table are read as a description of what a library here
does, and a table from which the only `preupdate`-lacking library has been
deleted reads as "every library reachable here has `preupdate`". That is a
stronger claim than the one being retired, and it is false.

Second, the column is a **measured negative**, and Rule 1b applies to it: no
other library reachable from this tree can reproduce it. Deleting it destroys
the only observation that distinguishes "these two refusal branches have never
been exercised" from "these two refusal branches cannot be exercised". Coverage
of a configuration nobody should use is indeed worth little; the measurement
that the configuration behaves differently is not the same thing, and it is not
replaceable.

So the column survives — **not as a column**. It is carried forward as a dated
historical comparison, with its observation date unchanged and stated beside the
figures, and the table says on its face that this is what the entry is. A dated
observation of a library the project no longer runs is honest; the same figures
in a live column, implying they would be reproduced by a run today, are not.

#### What vendoring changed: not-covered became not-coverable

Before vendoring, the two refusal branches were **not covered**: no run in the
gate exercised them, but a run that set `DENO_SQLITE_PATH` aside could. After
vendoring they are **not coverable from this tree**. Three measurements
establish that, and the third is the one that matters:

- A prebuilt IS present in this machine's `$DENO_DIR/plug/` — one artefact,
  whose sidecar metadata names the 0.13.0 release URL, with an `.so` mtime
  earlier than the vendoring commit. It is a leftover of the pre-vendoring tree,
  inspected read-only. Its presence is why the column can still be produced HERE
  and is not evidence that it can be produced anywhere else.
- Nothing in the tree downloads one. Every reference to the plug cache in code
  READS an existing directory; none fetches.
- No task in `deno.json` grants `--allow-net`. So on a machine without that
  leftover, a fetch is not merely absent from the code: it is refused by the
  permission set. The failure mode is a denied permission, not a missing call
  someone could add back in passing.

The cheap reading — "the column is still produced, so the coverage is still
there" — predicts that a fresh clone on a clean machine reproduces it. It does
not: with an empty plug cache the tool prints that no prebuilt is present in
`$DENO_DIR/plug` and skips. That prediction is absent, which settles it. What
remains on this machine is an unreproducible leftover, and a number that only
one machine in the world can regenerate is a historical record whatever the
tooling calls it.

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

**STILL OPEN, with a narrower reason.** That used to conclude "which is exactly
what the refusal above prevents", and it did not follow: a re-entrant call that
does not go through a replaced driver method was not refused at all. It is not
closed now either, but the route that is left is specific rather than
open-ended. To fire one of our callbacks while a busy handler is on the stack, a
listener must STEP a statement. Every stepping route is now refused — the five
`Database` and `Statement` methods, and `iter`/`for..of` on any statement
whatever, through the prototype — except two: the own-property
`run`/`get`/`all`/`values`/`value` on a statement prepared before `withEvents`
was called, and the raw `sqlite3*` from `unsafeHandle`. The first is reported
when the statement is constructed inside a listener; the second cannot be and
never will be, because it is the escape hatch.

So the reverse direction is reachable only by a caller who prepared a statement
before attaching, or who went to the raw handle. It is not proven unreachable
and this does not claim it is. What has changed is that the remaining routes can
be named. See **How far the guard actually reaches** below.

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

**Moved to [`DOMAIN_KNOWLEDGE.md`](./DOMAIN_KNOWLEDGE.md)** — "SQLite:
attribution hazards for a query-to-tables map". Three things the live-query path
will run into (re-prepare arriving during a step, our own statements in the
stream, and the null schema argument), plus where to collect them.

### The one gap that remains

The **absent-capability branches** — "preupdate unavailable",
`preupdate:
"required"` refusing, and `trace` being absent entirely — have never
run against a library that genuinely lacks those symbols, because both libraries
reachable here have them. The honest fixture for those is the prebuilt library
`@db/sqlite` downloads when `DENO_SQLITE_PATH` is unset, which carries a much
smaller symbol set. Still not wired up as a test fixture — but that library is
now PROBED, and what it does and does not have is measured rather than supposed:
see the capability table in `README.md` and the three-builds section of
`DOMAIN_KNOWLEDGE.md`. It lacks `sqlite3_progress_handler` too, so it is a
fixture for the `progress`-absent branch as well. It disappears when the driver
is vendored.

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
  driver shadows those five with own properties when the statement takes no bind
  parameters (`DOMAIN_KNOWLEDGE.md`, "Statement methods are own properties when
  there are no bind parameters"), so a per-instance patch is the only place they
  can be reached and a statement that already exists cannot be reached at all.
- `Statement.prototype.iter` — and therefore `[Symbol.iterator]` and `for..of`,
  because of how the driver defines `[Symbol.iterator]` and `iter`
  (`DOMAIN_KNOWLEDGE.md`, "`Statement.prototype.iter` is the one stepping member
  never shadowed"). This one is on the PROTOTYPE, so unlike the five above it
  reaches **every** statement, including statements prepared before `withEvents`
  was called, which is why the rule can be expressed there once instead of per
  instance. The patch is process-wide, so it is reference-counted and restored
  when the last subscription goes.

**What it does not cover.** Verified from inside a live `change` listener, each
of these reached SQLite with no refusal: `new Statement(db, sql)` and the
`.get()` on the statement it returns, `stmt.finalize()`, `stmt.columnNames()`,
and `db.function()`. `db.backup()` was refused — by SQLite itself, not by us,
which is not the same thing and must not be counted as coverage. `db.sql`
(tagged template) IS refused, because it delegates to the patched
`this.prepare`.

**The line is "steps a statement", not a list of members.** `columnNames`,
`bind`, `getRowObject`, `finalize` and the read-only accessors all touch the
connection, and none of them are refused: SQLite's undefined behaviour here is
about statement EXECUTION, and a rule stated as a rule can be applied to a
member nobody has thought of yet. A list of blessed members cannot, and the
standing warning about lists applies in the widening direction exactly as it
does in the narrowing one.

`db.backup()` stays uncovered and stays honestly accounted for: SQLite refuses
it, we do not, and that is not our coverage to claim.

So: **`guard()` is a guardrail against the mistake a listener makes by accident,
not a barrier against what a determined caller can do.** A barrier was never
available. `unsafeHandle` is public, is JSDoc'd as public, and this library
depends on it itself; anything that can reach the raw `sqlite3*` can re-enter
SQLite without passing a single one of our replacements. `inFfi` is the second
line: a re-entry that gets past the guard has its nested event dropped and
reported, which contains the damage rather than preventing the call.

#### The attach-order hole, and what is left of it

A `Statement` prepared BEFORE `withEvents` keeps unpatched own-property methods
for as long as it exists, and calling `stmt.get()` on it from inside a hook
returns a row (`{"c":2}` in the case that was run) instead of being refused. The
same statement prepared one line later is refused.

**The stepping half of that is now closed.** `iter`, and therefore `for..of`, is
patched on the prototype, so it refuses on every statement regardless of when it
was made — the case that returned uncommitted mid-statement rows to a `change`
listener now throws. What remains is the five own-property methods on a
statement the library never saw being prepared.

This is not a "known limitation", and writing it down as one would understate
it. What it costs is this: **the failure depends on when an object was
constructed, not on what the code does, so two identical-looking call sites
behave differently and nothing at the point of use distinguishes them.** A
reader looking at the call cannot tell which one they have. This is the
project's signature defect — a guarantee that holds at one level and stops
holding at another — in its purest form yet, and it is in our own guard.

The mechanism, so it is not re-derived: statement patches are installed inside
the patched `db.prepare`, because of the own-property shadowing recorded in
`DOMAIN_KNOWLEDGE.md`. Those patches are recorded with `undoable = false`, so
they also outlive `detach()` — the asymmetry runs in both directions.

**That `undoable = false` is inherited, not fixed.** Undoing a per-instance
patch would mean holding every statement the caller ever prepared, which is
either a leak or a `WeakRef` set whose contents nobody can reason about. The two
patches added here are not like that and are fully undone: the prototype `iter`
patch is reference-counted and restored when the last subscription goes, and
`unsafeConcurrency` is put back as a plain data property. Both have a test.

#### Detection where refusal is not available

`new Statement(db, sql)` prepares in its constructor, and the only thing that
constructor touches on the `Database` before the prepare is `unsafeHandle` — the
documented public escape hatch, which this library uses itself
(`DOMAIN_KNOWLEDGE.md`, "What the `Statement` constructor touches on the
`Database`, and in what order"). Guarding that would turn the hatch into a
barrier and take away the thing that makes everything else here honest, so
**construction cannot be refused.**

It can be DETECTED, through `unsafeConcurrency`: the constructor reads it and
nothing else in the driver does, so replacing that own data property with an
accessor for the life of the subscription reports "a statement was prepared on
this connection from inside a listener" through `onListenerError`. It is a
report and not a throw for a reason that is not timidity: the read happens after
the prepare and before finalizer registration, so throwing there would abandon a
prepared statement, and an unfinalized statement makes `sqlite3_close` fail. A
signal after the fact beats silence; a signal that breaks `close()` does not.

Detection through an accessor the driver happens to read is exactly the kind of
thing that stops working silently, which is this project's signature defect
wearing our own clothes. So it has a test whose whole job is to fail if the
driver stops reading `unsafeConcurrency` — the test asserts the report arrives,
and a negative control in the same suite asserts that preparing OUTSIDE a
listener reports nothing.

**Still open, and narrower than it was:** the five own-property methods on a
statement prepared before attach. It was considered and rejected to patch those
on the prototype too. They are shadowed by own properties only when the
statement takes no bind parameters, so a prototype patch would refuse
`new Statement(db, "SELECT ?").get(1)` and permit
`new Statement(db, "SELECT 1").get()` — coverage conditional on bind-parameter
count, which is a guarantee that holds at one level and stops at another. That
is the defect this project exists to avoid, and having it inside the guard would
be worse than the gap. Uniform detection was chosen over conditional refusal.

#### The record of the divergence (2026-09-09)

**Moved to [`DOMAIN_KNOWLEDGE.md`](./DOMAIN_KNOWLEDGE.md)** — what it cost that
the prose was broader than the mechanism for the whole life of the guard, and
why a rule documented wider than it is enforced is a latent version of this
project's signature defect.

### What a verification failure actually looks like here

**Moved to [`DOMAIN_KNOWLEDGE.md`](./DOMAIN_KNOWLEDGE.md)** — the five
instances, all of them silent success against the wrong target, and the gate
every measurement has to pass before its numbers are reportable. Read it before
you report a number.

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
