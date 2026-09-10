#!/usr/bin/env bash
#
# Assert the SET of artefacts a release would publish, then generate and VERIFY
# the SHA256SUMS that covers them.
#
# WHY A SET ASSERTION AND NOT JUST A PER-TARGET ONE
# -------------------------------------------------
# assert_native_target.sh catches a target built on the WRONG runner. It cannot
# catch a target that was never built, because an assertion inside a build does
# not run for a build that was never scheduled. Drop `linux-aarch64-gnu` from
# the matrix and every job is green, every assertion passes, and the release
# ships one architecture short. So the contract set is written down HERE, once,
# and the count is checked after the fact.
#
# WHY THE CHECKSUM FILE IS GENERATED HERE AND NOT AT UPLOAD TIME
# --------------------------------------------------------------
# Generating it needs no permission and no tag, so it runs in the read-only
# sibling too. That means the checksum contract is exercised before any tag
# exists and only the upload itself stays unexercised.
#
# The previous generator was `sha256sum ./*.tar.gz`. Two defects, both fixed
# below: it covered no `.so` at all -- a checksum file that omits the artefact
# a consumer actually fetches is a control that reads as present and is absent
# -- and every entry was prefixed `./`, so `sha256sum -c` had to be run from
# the one directory layout that happened to match.
#
#   .github/scripts/collect_release_assets.sh <out-dir>
set -euo pipefail

out_dir="${1:-}"
[ -n "$out_dir" ] || { echo "usage: $0 <out-dir>" >&2; exit 2; }
[ -d "$out_dir" ] || { echo "no such directory: $out_dir" >&2; exit 1; }

# The frozen contract. Adding an architecture means adding it here AND to the
# matrix in sqlite-vendor-build.yml; leaving this list alone is what makes the
# omission fail instead of ship.
CONTRACT_TARGETS=(linux-x86_64-gnu linux-aarch64-gnu)

cd "$out_dir"

missing=()
expected_names=()
for target in "${CONTRACT_TARGETS[@]}"; do
  for name in "libsqlite3-${target}.tar.gz" "libsqlite3-${target}.so"; do
    expected_names+=("$name")
    [ -f "$name" ] || missing+=("$name")
  done
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo "the release would ship short: ${#missing[@]} contract artefact(s) absent" >&2
  printf '  missing: %s\n' "${missing[@]}" >&2
  echo "  present: $(ls -1 | tr '\n' ' ')" >&2
  echo >&2
  echo "A target absent from the build matrix produces exactly this and no" >&2
  echo "other symptom: every scheduled job green, an architecture unpublished." >&2
  exit 1
fi

# The mirror-image failure: something built under a name no documented URL
# would ever be constructed for. Deterministic URLs are only deterministic if
# nothing else is in the directory pretending to be an asset.
unexpected=()
for f in libsqlite3-*; do
  found=0
  for name in "${expected_names[@]}"; do [ "$f" = "$name" ] && found=1 && break; done
  [ "$found" -eq 1 ] || unexpected+=("$f")
done
if [ "${#unexpected[@]}" -gt 0 ]; then
  echo "artefact(s) present under a name no consumer would construct:" >&2
  printf '  %s\n' "${unexpected[@]}" >&2
  exit 1
fi

# Plain names, sorted, no `./` prefix -- so `sha256sum -c SHA256SUMS` works
# from whatever directory the consumer downloaded them into.
rm -f SHA256SUMS
printf '%s\n' "${expected_names[@]}" | sort | xargs sha256sum > SHA256SUMS

# Verify what was just written rather than trusting that it was written.
sha256sum -c SHA256SUMS

listed="$(awk '{print $2}' SHA256SUMS | sed 's|^[*]||' | sort)"
want="$(printf '%s\n' "${expected_names[@]}" | sort)"
if [ "$listed" != "$want" ]; then
  echo "SHA256SUMS does not list exactly the contract artefacts" >&2
  diff <(echo "$want") <(echo "$listed") >&2 || true
  exit 1
fi
if grep -q '  \./' SHA256SUMS; then
  echo "SHA256SUMS entries carry a './' prefix; they must be plain names" >&2
  exit 1
fi

echo
echo "SHA256SUMS covers ${#expected_names[@]} artefacts across ${#CONTRACT_TARGETS[@]} targets:"
cat SHA256SUMS
