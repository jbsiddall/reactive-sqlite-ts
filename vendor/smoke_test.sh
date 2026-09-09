#!/usr/bin/env bash
#
# Compile smoke_test.c against a built library and run it, so a binary is only
# trusted after it has executed. For a cross-compiled target the test runs under
# qemu-user (`apt-get install qemu-user-static`), which is the whole reason an
# aarch64 artifact can be shipped from an x86_64 machine at all.
#
#   vendor/smoke_test.sh                 # host architecture
#   vendor/smoke_test.sh --arch aarch64  # under qemu
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ARCH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --arch) ARCH="$2"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

case "$(uname -m)" in
  x86_64|amd64)  HOST_ARCH=x86_64 ;;
  aarch64|arm64) HOST_ARCH=aarch64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
ARCH="${ARCH:-$HOST_ARCH}"
TARGET="linux-${ARCH}-gnu"
LIB_DIR="${HERE}/lib/${TARGET}"
[ -f "${LIB_DIR}/libsqlite3.so" ] || {
  echo "no library at ${LIB_DIR}/libsqlite3.so" >&2
  echo "  build it first: ${HERE}/build.sh --arch ${ARCH}" >&2
  exit 1
}

AMALG="$(ls -d "${HERE}/.src/sqlite-amalgamation-"* 2>/dev/null | head -1 || true)"
[ -n "$AMALG" ] && [ -f "${AMALG}/sqlite3.h" ] || {
  echo "sqlite3.h not found. Re-run the build with --keep-src:" >&2
  echo "  ${HERE}/build.sh --arch ${ARCH} --keep-src" >&2
  exit 1
}

RUNNER=()
if [ "$ARCH" = "$HOST_ARCH" ]; then
  CC="${CC:-cc}"
else
  CC="${CC:-${ARCH}-linux-gnu-gcc}"
  command -v "$CC" >/dev/null 2>&1 || { echo "cross compiler '$CC' not found" >&2; exit 1; }
  QEMU="qemu-${ARCH}-static"
  command -v "$QEMU" >/dev/null 2>&1 || {
    echo "'$QEMU' not found; a cross-built library cannot be validated without it." >&2
    echo "  Debian/Ubuntu: apt-get install qemu-user-static" >&2
    exit 1
  }
  # -L points qemu at the target's dynamic loader and libc.
  RUNNER=("$QEMU" -L "/usr/${ARCH}-linux-gnu")
fi

# sqlite3.h hides the session and preupdate declarations behind the same
# #ifdefs the library was built with, so the *caller* must define them too.
# Without this the compiler falls back to implicit declarations, the
# sqlite3_changeset_iter type is unknown, and the conflict handler fails to
# parse -- which reads as a mysterious "on_conflict undeclared". Take the list
# from the manifest so the test can never drift from the library it tests.
DEFINES=()
MANIFEST="${LIB_DIR}/build_manifest.json"
if [ -f "$MANIFEST" ]; then
  while read -r flag; do
    [ -n "$flag" ] && DEFINES+=("-D${flag}")
  done < <(sed -n '/"flags"/,/]/p' "$MANIFEST" | grep -o '"SQLITE_[^"]*"' | tr -d '"')
else
  DEFINES=(-DSQLITE_ENABLE_SESSION -DSQLITE_ENABLE_PREUPDATE_HOOK)
fi

BIN="$(mktemp -d)/smoke_${ARCH}"
echo "==> building the smoke test for ${TARGET} (${#DEFINES[@]} defines from the manifest)"
# -Wl,-rpath so the binary finds the library under test, not a system one.
"$CC" -O1 -I"$AMALG" "${DEFINES[@]}" -o "$BIN" "${HERE}/smoke_test.c" \
  -L"$LIB_DIR" -lsqlite3 -Wl,-rpath,"$LIB_DIR" -lpthread -lm -ldl

echo "==> running${RUNNER:+ under ${RUNNER[0]}}"
"${RUNNER[@]}" "$BIN"
