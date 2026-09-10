# What is done, and what is not

A release of this package has two halves: the TypeScript, which is published as
source, and the vendored `libsqlite3` built with the hooks compiled in, which is
published as a binary asset. This file tracks the second half, because that is
where the work currently stops.

The issues live on GitHub. This file exists so their shape is readable without
reading five of them.

## Done and verified

- **Both architectures build natively.** `linux-x86_64-gnu` on `ubuntu-24.04`
  and `linux-aarch64-gnu` on `ubuntu-24.04-arm`, from one shared reusable
  workflow (`.github/workflows/sqlite-vendor-build.yml`) that both the pull
  request workflow and the release workflow call. Nothing is cross-compiled or
  emulated any more. The local cross path in `vendor/README.md` still works and
  is still documented as local.
- **Every asset is executed before it can be uploaded.** The full suite runs
  against the real driver and the real library, on the hardware the artifact
  targets. An artifact that has never run does not ship.
- **Four assets per release**, checksummed together: a `.tar.gz` and a bare
  `libsqlite3-<target>.so` for each of the two targets. The earlier checksum
  step globbed `*.tar.gz` and silently covered neither `.so`; a release short of
  an entire architecture also passed. Both are now asserted as a set.
- **The install is documented** in `README.md`, with the runtime permission
  flags in their narrowest working form and a check that the version the
  documented URL names is the version `vendor/build.sh` builds.
- **The first release shipped.** Tag `sqlite-vendor-v3.53.4` pushed on
  2026-09-10; the publish job (issue #1) executed end to end in about eighty
  seconds (run 34537800936: 22:30:42Z → 22:32:01Z) and attached all five files —
  the four assets plus `SHA256SUMS` — non-draft, with byte sizes matching the
  records in `vendor/README.md`. The download URLs in `README.md` resolve and
  the x86_64 asset verifies against `SHA256SUMS` (`sha256sum -c` exit 0).
- **The install has been followed end to end, x86_64.** A scratch project
  outside this tree downloaded the release asset, verified it, imported the
  driver and hooks from a pinned commit, and observed a fired update hook and
  postcommit batch carrying the correct payload, with `sqlite_version()`
  reporting 3.53.4 from the asset itself (issue #3, x86_64 leg). Not exercised
  outside CI: the aarch64 asset ran on native arm hardware before it was
  uploaded, but no consumer has followed the install with it — no arm host is
  available here; that leg is pending on a runner or the user's side.
- **Consumption from GitHub is documented and exercised.** The README no longer
  describes a first release that does not exist. It documents the path of record
  — an import map pinning the package specifier to a commit on
  `raw.githubusercontent.com` — and the same scratch run measured it working:
  the import chain resolves, with one required consumer-side entry for
  `@std/path` (without it the run dies with
  `TypeError: Import "@std/path" not a dependency`), and no `--allow-net` is
  needed for module loading on Deno 2.9.6. A JSR publish remains planned, and
  will need its own credentials.

## Issues

|    |                                                                                        |
| -- | -------------------------------------------------------------------------------------- |
| #1 | Closed by observation: the publish job ran and the release shipped (2026-09-10)        |
| #2 | Closed: `sqlite-vendor.yml` now also runs on direct pushes to main (PR #6, 2026-09-10) |
| #3 | x86_64 leg done; aarch64 leg not yet exercised outside CI                              |
| #4 | Unresolved: which library-provenance instrument tells the truth                        |
| #5 | Branches deleted 2026-09-10. The four probe runs could not be: run deletion is denied  |
|    | to this credential (HTTP 403); the denial came back, not its reason. Delete via the    |
|    | web UI. A fifth run (34481105897) is kept deliberately.                                |

## Deliberately not done

- **No musl build.** Both release runners are glibc, so every asset is `-gnu`. A
  musl host builds its own with `vendor/build.sh`, which ships inside the
  package. This is a stated limit, not an oversight.
- **No automatic download at run time.** The driver never fetches anything,
  which is why no task needs `--allow-net`. The three manual steps are the price
  of that.
- **`SHA256SUMS` is not a tamper control.** It is served from the same origin as
  the assets and is unsigned. It detects a corrupted transfer and nothing else.
