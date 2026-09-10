/**
 * Ask whether the SQLite version README.md tells a consumer to download is the
 * version vendor/build.sh actually builds.
 *
 * The install steps in README.md construct a release URL from a tag,
 * `sqlite-vendor-v<version>`, and that version is a copy. `vendor/build.sh` is
 * the authority: it is what the release workflow runs, so the asset behind the
 * URL carries whatever version that file pins. Bump one and not the other and
 * the documented URL is a 404 on a good day and the wrong library on a bad one.
 *
 * WHAT THIS CHECK CANNOT DO. Both operands live in this repository and move
 * through the same commits, so ONE careless edit that changes both — a
 * find-and-replace across the tree onto a version sqlite.org never published —
 * leaves this green. It compares two copies for agreement; it does not know
 * which versions exist. `build.sh` refusing a source tarball whose SHA3-256
 * does not match is the check that catches the invented version, and it is a
 * different check in a different place.
 *
 * WHY THE EXTRACTION IS STRICT, AND WHY THAT IS THE POINT
 * ------------------------------------------------------
 * The failure this exists to avoid is not a wrong number. It is an extraction
 * that quietly yields nothing on both sides and compares empty to empty, which
 * reads as agreement. So:
 *
 *   - the assignment is located by `^SQLITE_VERSION=`, never by line number;
 *   - the value is required to be non-empty AND semver-shaped BEFORE the two
 *     are compared, so a parse that came back with nothing fails loudly;
 *   - a `SQLITE_VERSION=` line that exists but does not parse is its own
 *     reported failure, distinct from the line being absent.
 *
 * That strictness has a price and it is deliberate: reformat the assignment to
 * `SQLITE_VERSION='3.53.4'` and this check goes RED rather than green. A
 * formatting change that defeats the extraction is exactly the event that must
 * not pass silently.
 *
 * A NOTE ON A TEMPTING SHORTCUT. `grep -o '[0-9.]*'` over that region of
 * build.sh does not work: `SQLITE_AMALGAMATION="sqlite-amalgamation-3530400"`
 * sits on the next line and yields `3530400`, a plausible-looking number that
 * is not a version at all.
 *
 * Run standalone with `deno task test:version-pin`; also called from
 * ./suite.ts, which is what makes it run in CI.
 */

const ROOT = new URL("../", import.meta.url);

/** Three parts, optionally four — SQLite uses both (3.53.4, 3.45.1, 3.8.10.2). */
const SEMVER = /^\d+\.\d+\.\d+(?:\.\d+)?$/;

/**
 * The tag glob, as prose writes it. It is not a version and must not be read as
 * one; every OTHER `sqlite-vendor-v...` occurrence in README.md is.
 */
const TAG_GLOB = "*";

export interface Result {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const read = (rel: string): string =>
  Deno.readTextFileSync(new URL(rel, ROOT).pathname);

/**
 * The version `vendor/build.sh` pins, or a reason it could not be read.
 *
 * Matched on the assignment, not on a position: a comment inserted above it
 * must not change the answer, and a line number would make it do so.
 */
export function buildShVersion(
  source: string,
): { version: string } | { error: string } {
  const lines = source.split("\n").filter((l) =>
    l.startsWith("SQLITE_VERSION=")
  );
  if (lines.length === 0) {
    return { error: "no line in vendor/build.sh starts with SQLITE_VERSION=" };
  }
  if (lines.length > 1) {
    return {
      error:
        `vendor/build.sh has ${lines.length} SQLITE_VERSION= lines; which one is authoritative is undefined`,
    };
  }
  const line = lines[0]!;
  const m = /^SQLITE_VERSION="([^"]*)"$/.exec(line);
  if (!m) {
    return {
      error:
        `SQLITE_VERSION= is present but did not parse as a double-quoted value: ${
          JSON.stringify(line)
        }`,
    };
  }
  return { version: m[1]! };
}

/**
 * Every release tag README.md names, minus the glob. Returns them all rather
 * than the first, because two occurrences disagreeing is its own defect and the
 * first-match form would hide it.
 */
export function readmeVersions(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/sqlite-vendor-v([^\s`"'/)\]]+)/g)) {
    const v = m[1]!;
    if (v !== TAG_GLOB) out.push(v);
  }
  return out;
}

/** The whole check, as a list of named verdicts. */
export function versionPinResults(): Result[] {
  const results: Result[] = [];
  const add = (name: string, ok: boolean, detail: string) =>
    results.push({ name, ok, detail });

  const built = buildShVersion(read("vendor/build.sh"));
  if ("error" in built) {
    add("vendor/build.sh pins a readable SQLITE_VERSION", false, built.error);
    return results;
  }
  if (!SEMVER.test(built.version)) {
    add(
      "vendor/build.sh pins a readable SQLITE_VERSION",
      false,
      `extracted ${
        JSON.stringify(built.version)
      }, which is not a version — refusing to compare`,
    );
    return results;
  }
  add(
    "vendor/build.sh pins a readable SQLITE_VERSION",
    true,
    built.version,
  );

  const quoted = readmeVersions(read("README.md"));
  if (quoted.length === 0) {
    add(
      "README.md quotes a release tag",
      false,
      "no sqlite-vendor-v<version> occurrence in README.md — the install steps cite no version at all",
    );
    return results;
  }
  const bad = quoted.filter((v) => !SEMVER.test(v));
  if (bad.length > 0) {
    add(
      "README.md quotes a release tag",
      false,
      `not version-shaped: ${JSON.stringify(bad)} — refusing to compare`,
    );
    return results;
  }
  const distinct = [...new Set(quoted)];
  if (distinct.length > 1) {
    add(
      "README.md quotes a release tag",
      false,
      `README.md names ${distinct.length} different tags: ${
        JSON.stringify(distinct)
      }`,
    );
    return results;
  }
  add(
    "README.md quotes a release tag",
    true,
    `sqlite-vendor-v${distinct[0]!} x${quoted.length}`,
  );

  const readme = distinct[0]!;
  add(
    "the documented download URL names the version build.sh builds",
    readme === built.version,
    readme === built.version
      ? built.version
      : `README.md says ${readme}, vendor/build.sh builds ${built.version}`,
  );
  return results;
}

if (import.meta.main) {
  let failed = 0;
  for (const r of versionPinResults()) {
    console.log(`  ${r.ok ? "pass" : "FAIL"}  ${r.name} — ${r.detail}`);
    if (!r.ok) failed++;
  }
  console.log(
    failed === 0 ? "version pin OK" : `version pin: ${failed} failed`,
  );
  if (failed > 0) Deno.exit(1);
}
