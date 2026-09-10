# What is done, and what is not

A release of this package has two halves: the TypeScript, which is published as
source, and the vendored `libsqlite3` built with the hooks compiled in, which is
published as a binary asset. This file tracks the second half, because that is
where the work currently stops.

Open items live as issues. This file exists so the shape is readable without
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

## The one thing blocking a release

**No tag has been pushed.** A `sqlite-vendor-v*` tag is what runs the publish
job, and it is a human's call — nothing in this repository creates one. Until
then every download URL in `README.md` is a 404, which `README.md` says in its
opening line rather than implying otherwise.

The publish job is therefore also the only part of the pipeline that has never
executed. See #1.

## Open

|    |                                                                 |
| -- | --------------------------------------------------------------- |
| #1 | The release publish job has never executed                      |
| #2 | A direct push to `main` gets no automatic validation            |
| #3 | The documented install has never been followed end to end       |
| #4 | Unresolved: which library-provenance instrument tells the truth |
| #5 | Delete the two merged and throwaway branches                    |

## Deliberately not done

- **No musl build.** Both release runners are glibc, so every asset is `-gnu`. A
  musl host builds its own with `vendor/build.sh`, which ships inside the
  package. This is a stated limit, not an oversight.
- **No automatic download at run time.** The driver never fetches anything,
  which is why no task needs `--allow-net`. The three manual steps are the price
  of that.
- **`SHA256SUMS` is not a tamper control.** It is served from the same origin as
  the assets and is unsigned. It detects a corrupted transfer and nothing else.
