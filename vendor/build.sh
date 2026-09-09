#!/usr/bin/env bash
#
# Build a vendored libsqlite3 from the official SQLite amalgamation.
#
# Why: `@db/sqlite` downloads its own prebuilt SQLite, and our FFI dlopens
# whatever libsqlite3 the machine happens to have. When those are two different
# builds, the `sqlite3*` we borrow from the driver belongs to the other one and
# the process dies of SIGSEGV with no message (verified: exit 139). Shipping one
# library we control, and pointing both at it, removes that whole bug class --
# and lets us compile in the optional features (SESSION, PREUPDATE_HOOK) that
# neither the distro build nor the driver's prebuilt enables.
#
# Re-runnable and hermetic apart from the network fetch: the source tarball is
# pinned by version AND by the SHA3-256 sqlite.org publishes, and the build
# refuses to continue on a mismatch. Output is written with a manifest recording
# exactly what was built from what.
#
# Usage:  vendor/build.sh [--arch x86_64|aarch64] [--keep-src] [--out DIR]
#
# Cross-compiling: `--arch aarch64` on an x86_64 Linux host uses
# aarch64-linux-gnu-gcc (Debian/Ubuntu: `apt-get install gcc-aarch64-linux-gnu`).
# The result cannot be run natively, so smoke_test.sh executes it under
# qemu-user before anyone is asked to trust it.
set -euo pipefail

# ---------------------------------------------------------------------------
# Pinned source. Bump all three together; they come from
# https://sqlite.org/download.html (the hash column there is SHA3-256, not
# SHA-256 -- do not swap in a `sha256sum` value).
# ---------------------------------------------------------------------------
SQLITE_VERSION="3.53.4"
SQLITE_AMALGAMATION="sqlite-amalgamation-3530400"
SQLITE_URL="https://sqlite.org/2026/${SQLITE_AMALGAMATION}.zip"
SQLITE_SHA3_256="628a44cfe82c66aed1ccbbe85a562d2e33ebe64b3288981ed76285612227934e"

# ---------------------------------------------------------------------------
# Compile-time flags. Every entry here is a capability the caller can detect at
# runtime with probe.ts; nothing in this list changes the meaning of existing
# SQL, which is deliberate -- a vendored library that behaves differently from
# the stock one would trade a segfault class for a correctness class.
#
# SQLITE_ENABLE_SESSION *requires* SQLITE_ENABLE_PREUPDATE_HOOK: the session
# extension is built on the preupdate hook, and sqlite3session_create() cannot
# see row values without it. sqlite3.c enforces this at compile time; the build
# below asserts the pair resolved by probing both symbol families afterwards.
# ---------------------------------------------------------------------------
FLAGS=(
  # --- requested set -------------------------------------------------------
  SQLITE_ENABLE_PREUPDATE_HOOK      # sqlite3_preupdate_hook + old/new/count/depth/blobwrite
  SQLITE_ENABLE_SESSION             # sqlite3session_* / changesets / patchsets / rebaser
  SQLITE_ENABLE_API_ARMOR           # validate arguments at the C API boundary instead of UB
  SQLITE_ENABLE_UNLOCK_NOTIFY       # sqlite3_unlock_notify
  SQLITE_ENABLE_COLUMN_METADATA     # sqlite3_column_{database,table,origin}_name
  SQLITE_ENABLE_STMT_SCANSTATUS     # per-loop query profiling
  SQLITE_ENABLE_DBSTAT_VTAB         # dbstat virtual table
  SQLITE_ENABLE_NORMALIZE           # sqlite3_normalized_sql
  SQLITE_ENABLE_FTS5                # full-text search
  SQLITE_ENABLE_RTREE               # R*Tree index
  SQLITE_ENABLE_MATH_FUNCTIONS      # ceil/floor/pow/log/trig/...
  SQLITE_ENABLE_DESERIALIZE         # sqlite3_serialize / sqlite3_deserialize
  SQLITE_ENABLE_EXPLAIN_COMMENTS    # human-readable EXPLAIN output
  # --- judged worth adding -------------------------------------------------
  SQLITE_ENABLE_GEOPOLY             # comes with RTREE; costs a few KB
  SQLITE_ENABLE_BYTECODE_VTAB       # bytecode()/tables_used() vtabs, pairs with EXPLAIN_COMMENTS
  SQLITE_ENABLE_STMTVTAB            # sqlite_stmt vtab: list live statements on a connection
  SQLITE_ENABLE_OFFSET_SQL_FUNC     # sqlite_offset(): byte offset of a row, useful for diffing
  SQLITE_ENABLE_UPDATE_DELETE_LIMIT # UPDATE/DELETE ... ORDER BY ... LIMIT
  SQLITE_ENABLE_FTS4                # legacy FTS, so an existing db that uses it still opens
  SQLITE_SOUNDEX                    # soundex()
  SQLITE_THREADSAFE=1               # serialized: what distro builds ship, what @db/sqlite expects
  SQLITE_MAX_VARIABLE_NUMBER=250000 # 3.32+ default is 32766; large bulk inserts hit that
  SQLITE_USE_ALLOCA                 # small win, no behaviour change
)
#
# NOTE on SQLITE_ENABLE_SQLLOG -- deliberately NOT enabled. It looks free: it
# adds no exported symbol, only the sqlite3_config(SQLITE_CONFIG_SQLLOG, cb)
# verb, which logs every statement on every connection process-wide in a way
# per-connection sqlite3_trace_v2 cannot. But defining it makes the amalgamation
# *call* sqlite3_init_sqllog() from sqlite3_open(), and that function is not in
# the amalgamation -- it lives in SQLite's test_sqllog.c. Measured here: the
# library builds and links cleanly, dlopen succeeds, probe.ts reports
# SQLITE_ENABLE_SQLLOG as present, and then the first sqlite3_open_v2() call
# kills the process with
#
#     symbol lookup error: libsqlite3.so: undefined symbol: sqlite3_init_sqllog
#
# A shared object with lazy binding does not fail until the symbol is used, so
# every check short of actually opening a database passes. Not worth it: the
# feature is a debugging aid, and paying for it with a second, non-upstream
# translation unit and a build that only breaks at runtime is a bad trade. To
# turn it on anyway, add the flag AND compile SQLite's test_sqllog.c alongside
# sqlite3.c, or supply your own `void sqlite3_init_sqllog(void){}`.

OUT_DIR=""
KEEP_SRC=0
WANT_ARCH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --keep-src) KEEP_SRC=1; shift ;;
    --arch) WANT_ARCH="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"

# ---------------------------------------------------------------------------
# Target triple. Matches what src/vendored.ts computes from Deno.build.{os,arch}, so
# a library built here is found by a consumer without any configuration.
# ---------------------------------------------------------------------------
case "$(uname -s)" in
  Linux)  OS=linux ;;
  Darwin) OS=darwin ;;
  *) echo "unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  HOST_ARCH=x86_64 ;;
  aarch64|arm64) HOST_ARCH=aarch64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
ARCH="${WANT_ARCH:-$HOST_ARCH}"
case "$ARCH" in
  x86_64|aarch64) : ;;
  *) echo "unsupported --arch: $ARCH (want x86_64 or aarch64)" >&2; exit 1 ;;
esac

# Pick the compiler before anything else uses $CC, so a cross build fails here
# with a name to install rather than halfway through with a linker error.
CROSS=0
if [ "$ARCH" != "$HOST_ARCH" ]; then
  CROSS=1
  [ "$OS" = linux ] || { echo "cross-compiling is only wired up for linux hosts" >&2; exit 1; }
  CC="${CC:-${ARCH}-linux-gnu-gcc}"
  command -v "$CC" >/dev/null 2>&1 || {
    echo "cross compiler '$CC' not found." >&2
    echo "  Debian/Ubuntu: apt-get install gcc-${ARCH//_/-}-linux-gnu" >&2
    exit 1
  }
else
  CC="${CC:-cc}"
fi
if [ "$OS" = linux ]; then
  # glibc and musl produce incompatible .so files; they must not share a
  # directory. `ldd --version` names the implementation on both.
  if ldd --version 2>&1 | head -1 | grep -qi musl; then LIBC=musl; else LIBC=gnu; fi
  TARGET="${OS}-${ARCH}-${LIBC}"
  SO_NAME="libsqlite3.so"
else
  TARGET="${OS}-${ARCH}"
  SO_NAME="libsqlite3.dylib"
fi

[ -n "$OUT_DIR" ] || OUT_DIR="${HERE}/lib/${TARGET}"
SRC_DIR="${HERE}/.src"
mkdir -p "$OUT_DIR" "$SRC_DIR"

# ---------------------------------------------------------------------------
# Fetch + verify.
# ---------------------------------------------------------------------------
ZIP="${SRC_DIR}/${SQLITE_AMALGAMATION}.zip"
if [ ! -f "$ZIP" ]; then
  echo "==> fetching ${SQLITE_URL}"
  curl -fsSL "$SQLITE_URL" -o "${ZIP}.part"
  mv "${ZIP}.part" "$ZIP"
fi

echo "==> verifying SHA3-256"
if command -v openssl >/dev/null 2>&1; then
  ACTUAL_SHA3="$(openssl dgst -sha3-256 "$ZIP" | awk '{print $NF}')"
else
  echo "openssl is required to verify the SHA3-256 sqlite.org publishes" >&2
  exit 1
fi
if [ "$ACTUAL_SHA3" != "$SQLITE_SHA3_256" ]; then
  echo "SHA3-256 mismatch for ${ZIP}" >&2
  echo "  expected ${SQLITE_SHA3_256}" >&2
  echo "  actual   ${ACTUAL_SHA3}" >&2
  echo "Refusing to build. Delete the file to re-download, or update the pin." >&2
  exit 1
fi
# SHA-256 as well: it is what every other tool in the world can check, and what
# a CI cache or a mirror will be keyed on.
ACTUAL_SHA256="$(sha256sum "$ZIP" | awk '{print $1}')"
echo "    sha3-256 ok: ${ACTUAL_SHA3}"
echo "    sha256:      ${ACTUAL_SHA256}"

rm -rf "${SRC_DIR}/${SQLITE_AMALGAMATION}"
( cd "$SRC_DIR" && unzip -q -o "$(basename "$ZIP")" )
AMALG="${SRC_DIR}/${SQLITE_AMALGAMATION}"
[ -f "${AMALG}/sqlite3.c" ] || { echo "sqlite3.c not found in the archive" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Compile.
# ---------------------------------------------------------------------------
DEFINES=()
for f in "${FLAGS[@]}"; do DEFINES+=("-D${f}"); done

# -fPIC: shared library. -O2: sqlite.org's own recommendation; -O3 is not
# measurably better and lengthens an already slow single-translation-unit build.
# -Wl,-soname keeps the SONAME stable so a consumer's dlopen path is the only
# name that matters.
COMMON=(-fPIC -O2 -DNDEBUG -I"${AMALG}")
if [ "$OS" = darwin ]; then
  LINK=(-dynamiclib -install_name "@rpath/${SO_NAME}")
  LIBS=(-lpthread)
else
  LINK=(-shared -Wl,-soname,"${SO_NAME}")
  LIBS=(-lpthread -lm -ldl)
fi

if [ "$CROSS" -eq 1 ]; then
  echo "==> cross-compiling SQLite ${SQLITE_VERSION} for ${TARGET} with ${CC}"
  echo "    NOT runnable on this host. Validate it with:"
  echo "      vendor/smoke_test.sh --arch ${ARCH}"
else
  echo "==> compiling SQLite ${SQLITE_VERSION} for ${TARGET} (this takes a minute)"
fi
"$CC" "${COMMON[@]}" "${DEFINES[@]}" "${LINK[@]}" \
  -o "${OUT_DIR}/${SO_NAME}" "${AMALG}/sqlite3.c" "${LIBS[@]}"

# `--strip-unneeded` drops the static symbol table and debug info but keeps the
# dynamic symbol table, which is the only thing dlopen/FFI resolves against.
# Measured here: 1725520 -> 1606800 bytes. Verification below runs on the
# stripped file, so what is checked is what ships.
STRIP="strip"
NM="nm"
if [ "$CROSS" -eq 1 ]; then
  # Host binutils can usually read a foreign ELF, but the matching cross tools
  # are installed alongside the cross compiler and are guaranteed to.
  command -v "${ARCH}-linux-gnu-strip" >/dev/null 2>&1 && STRIP="${ARCH}-linux-gnu-strip"
  command -v "${ARCH}-linux-gnu-nm" >/dev/null 2>&1 && NM="${ARCH}-linux-gnu-nm"
fi
if [ "$OS" = linux ] && command -v "$STRIP" >/dev/null 2>&1; then
  "$STRIP" --strip-unneeded "${OUT_DIR}/${SO_NAME}"
fi

# ---------------------------------------------------------------------------
# Verify the build is what we asked for, before anyone trusts it.
# ---------------------------------------------------------------------------
echo "==> verifying the produced library"
missing=0
if command -v "$NM" >/dev/null 2>&1 && [ "$OS" = linux ]; then
  # Read the symbol table ONCE into a variable. Piping `nm` into `grep -q` per
  # symbol looks equivalent and is not: grep exits at the first match, nm dies
  # of SIGPIPE, and under `set -o pipefail` the pipeline reports failure for a
  # symbol that is present. That cost an hour here.
  EXPORTED="$("$NM" -D --defined-only "${OUT_DIR}/${SO_NAME}" | awk '{print $NF}')"
  require_symbol() {
    case $'\n'"${EXPORTED}"$'\n' in
      *$'\n'"$1"$'\n'*) : ;;
      *) echo "    MISSING: $1" >&2; missing=1 ;;
    esac
  }
  # The SESSION <- PREUPDATE_HOOK dependency, asserted rather than assumed.
  for s in sqlite3_preupdate_hook sqlite3_preupdate_old sqlite3_preupdate_new \
           sqlite3_preupdate_count sqlite3_preupdate_depth sqlite3_preupdate_blobwrite \
           sqlite3session_create sqlite3session_attach sqlite3session_changeset \
           sqlite3changeset_apply sqlite3changeset_invert sqlite3rebaser_create \
           sqlite3_normalized_sql sqlite3_column_database_name sqlite3_serialize \
           sqlite3_deserialize sqlite3_stmt_scanstatus sqlite3_unlock_notify; do
    require_symbol "$s"
  done
  [ "$missing" -eq 0 ] || { echo "build produced a library missing required symbols" >&2; exit 1; }
  echo "    all required symbols present"
fi

SIZE_BYTES="$(stat -c%s "${OUT_DIR}/${SO_NAME}" 2>/dev/null || stat -f%z "${OUT_DIR}/${SO_NAME}")"
SO_SHA256="$(sha256sum "${OUT_DIR}/${SO_NAME}" | awk '{print $1}')"

# ---------------------------------------------------------------------------
# Manifest: version, exact flag list, source checksum, and how it was built.
# ---------------------------------------------------------------------------
{
  printf '{\n'
  printf '  "sqliteVersion": "%s",\n' "$SQLITE_VERSION"
  printf '  "sourceUrl": "%s",\n' "$SQLITE_URL"
  printf '  "sourceSha3_256": "%s",\n' "$ACTUAL_SHA3"
  printf '  "sourceSha256": "%s",\n' "$ACTUAL_SHA256"
  printf '  "target": "%s",\n' "$TARGET"
  printf '  "libraryFile": "%s",\n' "$SO_NAME"
  printf '  "librarySha256": "%s",\n' "$SO_SHA256"
  printf '  "librarySizeBytes": %s,\n' "$SIZE_BYTES"
  printf '  "compiler": "%s",\n' "$("$CC" --version 2>/dev/null | head -1 | sed 's/"/\\"/g')"
  printf '  "crossCompiled": %s,\n' "$([ "$CROSS" -eq 1 ] && echo true || echo false)"
  printf '  "builtAtUtc": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "flags": [\n'
  for i in "${!FLAGS[@]}"; do
    if [ "$i" -eq $(( ${#FLAGS[@]} - 1 )) ]; then printf '    "%s"\n' "${FLAGS[$i]}"
    else printf '    "%s",\n' "${FLAGS[$i]}"; fi
  done
  printf '  ]\n'
  printf '}\n'
} > "${OUT_DIR}/build_manifest.json"

[ "$KEEP_SRC" -eq 1 ] || rm -rf "${AMALG}"

echo
echo "==> built ${OUT_DIR}/${SO_NAME}"
echo "    SQLite ${SQLITE_VERSION}, ${#FLAGS[@]} flags, $(( SIZE_BYTES / 1024 )) KiB"
echo "    manifest: ${OUT_DIR}/build_manifest.json"
