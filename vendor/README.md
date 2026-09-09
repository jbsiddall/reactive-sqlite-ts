# vendor — our own SQLite, built with the flags we need

This library borrows the `sqlite3*` that `@db/sqlite` opened and calls SQLite
directly over FFI. That only works if the FFI dlopens **the same library the
driver loaded**. When it does not, the handle belongs to a different build and
the process dies of SIGSEGV with no message — verified here as exit 139.

Left alone, `@db/sqlite` downloads its own prebuilt into `$DENO_DIR/plug/`, and
`src/lib_path.ts` finds whatever `libsqlite3.so.0` the machine happens to have.
Those are two different files by construction. Vendoring one library and
pointing both at it removes the whole class.

It also buys capabilities neither of those has. Measured on this container:

```
                                @db/sqlite   system (Ubuntu)   vendored
                                (3.46.0)     (3.45.1)          (3.53.4)
sqlite3_preupdate_hook          --           yes               yes
sqlite3session_* (12 symbols)   --           yes               yes
sqlite3_unlock_notify           --           yes               yes
sqlite3_progress_handler        --           yes               yes
sqlite3_stmt_scanstatus[_v2]    --           --                yes
sqlite3_normalized_sql          --           --                yes
                                11/34        31/34             34/34
```

**The prebuilt `@db/sqlite` downloads has no preupdate hook and no session
extension at all.** That is the default path — what you get when nobody sets
`DENO_SQLITE_PATH`. Every changeset feature is simply absent there.

## Using it

```ts
import { useVendoredSqlite } from "./vendor/select.ts";
const LIB = useVendoredSqlite(); // sets DENO_SQLITE_PATH; throws if none matches

// AFTER, so the driver reads the variable we just set. Static imports hoist.
const { Database } = await import("jsr:@db/sqlite@0.12");
const { withEvents } = await import("../src/hooks.ts");
```

`useVendoredSqlite()` respects an existing `DENO_SQLITE_PATH` — an operator
overriding the library is making a deliberate choice, and ignoring it would
reintroduce the same crash from the other direction.

## The tasks

```sh
deno task vendor:build                  # build for this machine
deno task vendor:build -- --arch aarch64  # cross-compile
deno task vendor:smoke                  # compile a C test against it and RUN it
deno task vendor:smoke -- --arch aarch64  # ... under qemu-user
deno task vendor:probe                  # capability table, side by side
deno task vendor:session-demo           # SESSION round trip, end to end
```

`vendor:probe` and `vendor:session-demo` take an optional library path, so they
work as general-purpose tools against any `libsqlite3` on the machine — which is
the point: they answer "what does this library actually give me" without a
segfault being the way you find out.

Neither is in `deno task test`: both need `--unstable-ffi --allow-ffi`, and CI
has no committed library to point them at.

## What is built

SQLite **3.53.4**, from the official amalgamation, pinned by version and by the
SHA3-256 sqlite.org publishes. `build.sh` refuses to build on a hash mismatch.
The exact flag list, both source checksums, the compiler and the output's own
SHA-256 land in `build_manifest.json` beside the library.

The 23 flags are listed with a one-line reason each in `build.sh`. Everything in
the list is a _capability_; nothing changes the meaning of existing SQL. A
vendored library that behaved differently from the stock one would trade a
segfault class for a correctness class, which is not a trade worth making.

### `SQLITE_ENABLE_SESSION` requires `SQLITE_ENABLE_PREUPDATE_HOOK`

Asserted, not assumed. `build.sh` fails the build if any of the six
`sqlite3_preupdate_*` symbols or the session/rebaser symbols are missing, and
`smoke_test.c` re-checks both options at runtime through
`sqlite3_compileoption_used()` before it does anything else.

### `SQLITE_ENABLE_SQLLOG` is deliberately NOT enabled

It looks free — it exports no symbol, only the `SQLITE_CONFIG_SQLLOG` verb for
`sqlite3_config()`, which logs every statement on every connection process-wide
in a way per-connection `sqlite3_trace_v2` cannot.

It is not free. Defining it makes the amalgamation _call_
`sqlite3_init_sqllog()` from `sqlite3_open()`, and that function is not in the
amalgamation — it lives in SQLite's `test_sqllog.c`. What that looks like,
measured here: the library compiles and links cleanly, `dlopen` succeeds,
`probe.ts` reports `SQLITE_ENABLE_SQLLOG` as present, and then the first
`sqlite3_open_v2()` kills the process with

```
symbol lookup error: libsqlite3.so: undefined symbol: sqlite3_init_sqllog
```

Lazy binding means nothing short of actually opening a database catches it. A
debugging aid is not worth a second, non-upstream translation unit and a build
that only breaks at runtime. To enable it anyway: add the flag _and_ compile
`test_sqllog.c` alongside `sqlite3.c`, or supply your own no-op
`void sqlite3_init_sqllog(void){}`.

## Does SESSION actually work?

Symbol presence is not proof: `sqlite3session_create` links fine in a library
whose preupdate hook was compiled out, and then records nothing.

Two independent proofs, both driving the real library:

- `session_demo.ts` — raw Deno FFI. Records a session over a table, does an
  INSERT/UPDATE/DELETE, produces a changeset and a patchset, applies the
  changeset to a second database, asserts row-for-row equality, inverts the
  changeset, applies the inverse, and asserts the second database is back to its
  starting state. The conflict handler returns `SQLITE_CHANGESET_ABORT`, so a
  dropped row is a loud failure rather than a passing demo.
- `smoke_test.c` — the same round trip in C, so it can be cross-compiled and run
  under emulation on an architecture that has no Deno to hand.

Both pass. Point either at the `@db/sqlite` prebuilt and you get a clear
diagnostic naming the missing symbol instead of a crash.

## Multi-architecture distribution

### (a) aarch64: cross-compile here, natively in CI later

Cross-compiling from this x86_64 container turned out to be genuinely
straightforward, so it is wired up rather than merely planned:

```sh
apt-get install -y gcc-aarch64-linux-gnu libc6-dev-arm64-cross qemu-user-static
vendor/build.sh --arch aarch64
vendor/smoke_test.sh --arch aarch64   # runs under qemu
```

SQLite is one self-contained translation unit with no configure step and no
dependencies beyond libc, which is why this is easy here and would not be for a
typical C project. `libc6-dev-arm64-cross` is not optional — without it the
build dies on `bits/libc-header-start.h`.

**The result is validated, not merely produced.** `smoke_test.sh --arch aarch64`
runs the full SESSION round trip under `qemu-user`, and it passes. That is the
line between shipping an aarch64 artifact and shipping a guess; an untested
binary would be worse than none.

Ranked recommendation:

1. **GitHub's native arm64 runners** (`runs-on: ubuntu-24.04-arm`) once the repo
   is eligible — free for public repos, and they remove emulation from the
   picture entirely: the build, the smoke test and even a Deno-based probe all
   run natively. This is where to end up.
2. **Cross-compile + qemu on `ubuntu-latest`** — what the committed workflows do
   today. Works on any runner, needs no extra billing, and qemu-user is a
   faithful enough userspace emulator for a library that does nothing but
   compute and call libc. Its weakness is that it is emulation: it would not
   catch a genuine arm64 codegen or atomics bug.
3. **Cross-compiling with no execution at all** — rejected. It is exactly the
   "untested binary" case.

### (b) macOS and Windows: out of scope for now, with a recipe

Out of scope, because nothing here can validate them and an unvalidated artifact
is the thing to avoid. `build.sh` already handles darwin (`-dynamiclib`,
`-install_name`, `libsqlite3.dylib`) and `select.ts` already computes
`darwin-arm64` / `darwin-x86_64`, so the work left is a CI job and a Mac to
confirm on:

- **darwin-arm64** — `macos-14`, native. Straightforward.
- **darwin-x86_64** — `macos-13`, native; or one `macos-14` job passing
  `-arch x86_64` / `-arch arm64` and `lipo`-ing a universal binary. The
  universal route is tidier: one file, no runtime selection on macOS at all.
- **Windows** — the largest gap. `build.sh` is bash, MSVC wants a different
  command line entirely (`/DSQLITE_ENABLE_SESSION`, `sqlite3.def` to export the
  symbols, `sqlite3.dll` + `.lib`), and Deno FFI on Windows loads DLLs with
  different rules. It needs its own script, not a flag on this one. Given the
  Linux and macOS legs cover the platforms this library is used on today,
  Windows is reasonably last.

Signing and notarisation is the real macOS cost: an unsigned, unnotarised
`.dylib` downloaded from a GitHub Release will be quarantined on a Mac that got
it through a browser. Fetching it programmatically (as `@denosaurs/plug` does)
avoids the quarantine bit, which is another point in favour of the release-asset
model below.

### (c) glibc vs musl

They are not interchangeable and the failure is opaque, so the libc is part of
the target triple: `linux-x86_64-gnu`, not `linux-x86_64`. Deno exposes no libc
field, so `select.ts` defaults to `gnu` and a musl host opts in with
`REACTIVE_SQLITE_LIBC=musl`. That is the right way round — glibc is the
overwhelmingly common case and gets no configuration; musl is a deliberate
declaration rather than a silent mismatch.

A glibc build is _not_ usable on Alpine. If musl is ever needed, build it in an
`alpine:3` container (`apk add build-base`) rather than trying to cross-compile
it — the same script works unchanged, and `ldd --version` already picks the
right target directory.

### (d) Committing the binaries: no. Release assets.

Measured, both libraries stripped:

|                                   | size                   | in git       |
| --------------------------------- | ---------------------- | ------------ |
| `linux-x86_64-gnu/libsqlite3.so`  | 1,606,768 B (1.53 MiB) |              |
| `linux-aarch64-gnu/libsqlite3.so` | 1,595,280 B (1.52 MiB) |              |
| both, as git objects              |                        | **1.60 MiB** |

1.60 MiB is not much. The problem is that it is 1.60 MiB _per rebuild, forever_:
binaries do not delta-compress, so a SQLite version bump, a flag change or an
added architecture each append another ~1.6 MiB that no future commit can
reclaim without rewriting history. Add macOS and the per-bump cost roughly
doubles. A repo that ships a thin `deno bundle` and a `dist/` of browser assets
should not grow a binary archive as a side effect.

Against that, the one real argument for committing: a fresh clone works with no
compiler and no network. That is worth something — but `build.sh` needs only
`cc`, `curl` and `openssl` and finishes in well under a minute, and CI publishes
prebuilt tarballs for anyone without a compiler.

**The decisive evidence is `@db/sqlite` itself.** It has exactly this problem —
a per-platform native library that a pure-JS package must deliver — and it does
not commit binaries. It publishes them as GitHub Release assets and fetches them
at runtime through `@denosaurs/plug`, which caches into `$DENO_DIR/plug/`. That
is the mechanism whose cache file this directory's probe reads. It works, at
scale, in the exact ecosystem, for the exact library we are replacing.

So: `vendor/lib/` is **gitignored**, and
`.github/workflows/sqlite-vendor-release.yml` builds, validates and attaches
per-target tarballs (plus `SHA256SUMS`) to a Release on a `sqlite-vendor-v*`
tag. Each tarball carries its `build_manifest.json`, so an asset says for itself
which SQLite version and which flags it is.

> A trap worth knowing about: a bare `vendor/` ignore pattern matches **any**
> directory of that name at any depth, and silently swallows this entire
> directory of source. `.gitignore` therefore ignores `vendor/lib/` and
> `vendor/.src/` specifically, not `vendor/`. Check with `git check-ignore -v`
> before assuming a file is staged.

If the decision is later reversed and the binaries are committed, do it with Git
LFS rather than as plain blobs, and commit only tagged releases.

### (e) Selecting the right artifact at runtime

`select.ts` builds the triple from `Deno.build.os` and `Deno.build.arch` — the
same string `build.sh` names its output directory with, so a library built on a
machine is found on that machine with no configuration.

When nothing matches, the failure is a `NoVendoredLibraryError` naming the
triple it wanted, the exact path it looked for, which targets _are_ present, and
the two ways forward:

```
No vendored SQLite for this platform.

  wanted:    linux-aarch64-gnu  (linux/aarch64)
  expected:  .../vendor/lib/linux-aarch64-gnu/libsqlite3.so
  available: linux-x86_64-gnu

Fix it one of two ways:
  1. Build it here:  vendor/build.sh
     (needs a C compiler and network access; ~1 minute)
  2. Point at a libsqlite3 you trust:  DENO_SQLITE_PATH=/path/to/libsqlite3.so
     It must have SQLITE_ENABLE_PREUPDATE_HOOK and SQLITE_ENABLE_SESSION
     compiled in -- check with: deno task vendor:probe /path/to/libsqlite3.so

On musl (Alpine) set REACTIVE_SQLITE_LIBC=musl so the right artifact is chosen.
```

That message is the point of the whole exercise. The failure this replaces is a
bare `exit 139`.

## Files

| file                             | what it is                                               |
| -------------------------------- | -------------------------------------------------------- |
| `build.sh`                       | fetch, verify, compile, verify again, write the manifest |
| `smoke_test.c` / `smoke_test.sh` | the SESSION round trip in C, runnable under qemu         |
| `probe.ts`                       | which capabilities does a given `libsqlite3` have        |
| `session_demo.ts`                | the SESSION round trip over Deno FFI                     |
| `select.ts`                      | pick the artifact for this platform, or fail readably    |
| `lib/<target>/`                  | build output — gitignored                                |
| `.src/`                          | downloaded amalgamation — gitignored                     |
