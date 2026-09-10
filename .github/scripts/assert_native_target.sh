#!/usr/bin/env bash
#
# Assert that the runner this is executing on IS, natively, the architecture
# the matrix entry claims it is.
#
# Why this and not a comment: the matrix pairs a `runs-on` label with a target
# triple, and nothing in GitHub Actions checks that the pair agrees. Swap
# `ubuntu-24.04-arm` for `ubuntu-24.04` and every later step still succeeds --
# build.sh derives its target from `uname -m`, so it would quietly write an
# x86_64 library into the job that the release calls aarch64. This turns that
# into a failure at the first step, before anything is built.
#
# What it CANNOT catch: a target the matrix never enumerates at all. An
# assertion inside a build does not run for a build that was never scheduled.
# collect_release_assets.sh holds that half.
#
#   .github/scripts/assert_native_target.sh linux-aarch64-gnu
set -euo pipefail

expected="${1:-}"
[ -n "$expected" ] || { echo "usage: $0 <target-triple>" >&2; exit 2; }

case "$(uname -s)" in
  Linux) os=linux ;;
  *) echo "unsupported OS for a vendor build runner: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  arch=x86_64 ;;
  aarch64|arm64) arch=aarch64 ;;
  *) echo "unsupported runner architecture: $(uname -m)" >&2; exit 1 ;;
esac
# Same discrimination vendor/build.sh makes, for the same reason: glibc and
# musl artefacts are not interchangeable and must not share a triple.
if ldd --version 2>&1 | head -1 | grep -qi musl; then libc=musl; else libc=gnu; fi

actual="${os}-${arch}-${libc}"

if [ "$actual" != "$expected" ]; then
  cat >&2 <<MSG
The runner is not natively the target this matrix entry claims.

  matrix target : ${expected}
  this runner   : ${actual}   (uname -m: $(uname -m))

Either the \`runs-on\` label is wrong for this target, or the target is wrong
for this label. Native aarch64 is \`ubuntu-24.04-arm\`; native x86_64 is
\`ubuntu-24.04\`. Nothing here cross-compiles any more.
MSG
  exit 1
fi

echo "native runner confirmed: ${actual} (uname -m: $(uname -m))"
