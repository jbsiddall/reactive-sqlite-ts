#!/usr/bin/env bash
#
# Package one built target into the two assets a release publishes for it.
#
#   libsqlite3-<target>.tar.gz   libsqlite3.so + build_manifest.json
#   libsqlite3-<target>.so       the bare library
#
# The bare .so is not a convenience. `Deno.dlopen` takes a path to a shared
# object; it cannot be handed a .tar.gz. A release that publishes only the
# tarball obliges every consumer to shell out to tar before it can load
# anything, which is exactly the step @denosaurs/plug does not do.
#
# Both names are a pure function of (target), and the tag is a pure function of
# the SQLite version, so a download URL is constructible from (version, target)
# with no API call and no lookup.
#
#   .github/scripts/package_target.sh <target> <lib-dir> <out-dir>
set -euo pipefail

target="${1:-}"; lib_dir="${2:-}"; out_dir="${3:-}"
[ -n "$target" ] && [ -n "$lib_dir" ] && [ -n "$out_dir" ] || {
  echo "usage: $0 <target> <lib-dir> <out-dir>" >&2; exit 2; }

for f in libsqlite3.so build_manifest.json; do
  [ -f "${lib_dir}/${f}" ] || { echo "missing ${lib_dir}/${f}" >&2; exit 1; }
done

mkdir -p "$out_dir"
tar -czf "${out_dir}/libsqlite3-${target}.tar.gz" -C "$lib_dir" libsqlite3.so build_manifest.json
cp "${lib_dir}/libsqlite3.so" "${out_dir}/libsqlite3-${target}.so"

ls -l "${out_dir}/libsqlite3-${target}.tar.gz" "${out_dir}/libsqlite3-${target}.so"
