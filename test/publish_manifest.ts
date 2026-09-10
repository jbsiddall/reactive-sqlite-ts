/**
 * What actually ships.
 *
 * `deno.json` has a `publish.exclude` list, and nothing else asserts what
 * comes out the other end. The failure this guards is precise and silent:
 * attribution and licence compliance hold in the repository and quietly stop
 * holding in the published artifact, and nobody notices a missing LICENSE in a
 * package until somebody else does.
 *
 * It asserts on the FILE LIST `deno publish --dry-run` reports, never on the
 * exclude list itself. The exclude list is the mechanism; the file list is the
 * outcome. A test that read the patterns would still pass the day someone adds
 * a rule that catches LICENSE by accident.
 *
 * WHY THE WHOLE LIST AND NOT A FEW NAMES. This used to name eight files that
 * must ship and seven prefixes that must not. Twenty-one files ship, so
 * thirteen of them were asserted in neither direction — every `src/` module
 * but three, and every `vendor/` file. A package can lose a module the public
 * entry point imports, or gain one nobody meant to publish, without a single
 * assertion here changing colour. So the shipped set is now pinned WHOLE and
 * compared as a set: a file appearing and a file disappearing are both
 * failures, and the report names which of the two happened rather than saying
 * the list differs.
 *
 * A pinned list is only as honest as the last person to edit it, so it is not
 * the only assertion. {@linkcode REQUIRED} is DERIVED, at run time, from the
 * module graph of the published entry point: every local file `mod.ts` can
 * reach must ship, whatever the pin says. Adding an import and forgetting to
 * ship the file it points at fails here without anyone updating anything.
 * MUST_NOT_SHIP survives for the same reason in reverse: a directory nobody
 * should ever publish stays named, so widening the pin to include one is
 * caught by a second assertion rather than blessed by the edit.
 *
 * The comparison is a pure function driven by fixtures before it is pointed at
 * the real manifest, including a fixture that must be ACCEPTED — several
 * fixtures that must all be rejected cannot tell a working comparison from one
 * that rejects everything.
 *
 * PRESENCE IS NOT ENOUGH, NOW THE DRIVER IS VENDORED. A trimmed NOTICE still
 * exists, and Apache-2.0's modified-files sentence is exactly the kind of
 * paragraph that gets shortened for tidiness — deleting it whole was measured
 * to leave this file green before {@linkcode attributionFindings} existed. So
 * the attribution block is asserted on its CONTENT: every clause it must carry
 * is named, and each one has a fixture that deletes it and must be rejected.
 * {@linkcode REPRODUCTION_CLAUSES} does the same for the two `vendor/` files
 * that ship, which are in the package because of a claim about what they let a
 * consumer do rather than because they exist.
 *
 * Run: deno task test:publish
 */

/**
 * Every file the package publishes today, in full.
 *
 * Pinned deliberately rather than described by a pattern: a pattern would go
 * on matching whatever the tree happened to contain, which is the property
 * being tested, not a property to assume.
 */
const MANIFEST: readonly string[] = [
  "LICENSE",
  "NOTICE",
  "README.md",
  "deno.json",
  "deno.lock",
  "driver/blob.ts",
  "driver/constants.ts",
  "driver/database.ts",
  "driver/ffi.ts",
  "driver/mod.ts",
  "driver/shape.ts",
  "driver/statement.ts",
  "driver/util.ts",
  "mod.ts",
  "src/backend.ts",
  "src/backend_ffi.ts",
  "src/dependencies.ts",
  "src/format.ts",
  "src/hooks.ts",
  "src/lib_path.ts",
  "src/schema_map.ts",
  "src/schema_watch.ts",
  "src/vendored.ts",
  // vendor/ ships exactly what a consumer needs to REPRODUCE the native
  // library we distribute as a Release asset, and nothing else. Pinning the
  // set whole is what makes that hold in both directions: dropping build.sh
  // NARROWS the set and fails, re-adding the demos WIDENS it and fails.
  "vendor/README.md",
  "vendor/build.sh",
];

/**
 * Never publishable, whatever the pin above says.
 *
 * The pin catches a change to the shipped set; this catches a change to the
 * pin. Editing MANIFEST to admit `test/` is a plausible mistake — the manifest
 * is what a failing run tells you to update — and this is what stops the edit
 * from being self-approving.
 */
const MUST_NOT_SHIP: readonly string[] = [
  "test/",
  "tools/",
  "examples/",
  ".github/",
  "CONTRIBUTING.md",
  "DOMAIN_KNOWLEDGE.md",
  "DRIVER_DEFECTS.md",
];

const root = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

interface Finding {
  readonly ok: boolean;
  readonly what: string;
  readonly detail: string;
}

const ok = (what: string): Finding => ({ ok: true, what, detail: "" });
const bad = (what: string, detail: string): Finding => ({
  ok: false,
  what,
  detail,
});

/**
 * Compare a shipped set against the pin, in both directions.
 *
 * Pure, so the fixtures below drive the same code the real manifest does. A
 * copy would keep passing after this diverged.
 */
function manifestFindings(
  shipped: readonly string[],
  expected: readonly string[],
): Finding[] {
  const have = new Set(shipped);
  const want = new Set(expected);
  const added = shipped.filter((p) => !want.has(p)).sort();
  const missing = expected.filter((p) => !have.has(p)).sort();

  const findings: Finding[] = [];
  findings.push(
    added.length === 0
      ? ok("nothing ships that the manifest does not name")
      : bad(
        "nothing ships that the manifest does not name",
        `the published set WIDENED by ${added.length}: ${added.join(", ")}`,
      ),
  );
  findings.push(
    missing.length === 0 ? ok("everything the manifest names ships") : bad(
      "everything the manifest names ships",
      `the published set NARROWED by ${missing.length}: ${missing.join(", ")}`,
    ),
  );
  return findings;
}

/**
 * Every clause the attribution block must carry, as a whitespace-insensitive
 * needle.
 *
 * Named one clause at a time rather than pinned as a whole paragraph. A pinned
 * paragraph fails on every reflow and teaches people to re-pin it without
 * reading, which is how a deleted sentence gets waved through. Naming the
 * clauses means a rewording passes and a REMOVAL fails, which is the
 * distinction the licence cares about.
 *
 * Anything the modification sentence claims belongs here too: a clause that is
 * asserted nowhere is a clause that can be quietly dropped, and the whole point
 * of disclosing a divergence is that the disclosure outlives the person who
 * wrote it.
 */
const ATTRIBUTION_CLAUSES: readonly { what: string; needle: string }[] = [
  { what: "names the upstream project", needle: "denodrivers/sqlite3" },
  {
    what: "carries the upstream copyright line",
    needle: "Copyright 2022 DjDeveloperr",
  },
  {
    what: "states the upstream licence",
    needle: "Licensed under the Apache License, Version 2.0.",
  },
  {
    what: "states that the vendored sources were modified",
    needle: "have been MODIFIED by the reactive-sqlite-ts authors",
  },
  {
    what: "names the use-after-close correction",
    needle: "use-after-close segmentation fault",
  },
  {
    what: "names the negative-zero correction",
    needle: "bind failure on negative zero",
  },
  {
    what: "discloses that the row readers diverge further",
    needle: "result row readers diverge further than restyling",
  },
  {
    what: "states that the row readers generate no source at run time",
    needle: "generate no JavaScript source at run time",
  },
  {
    what: "states that hostile column names read correctly",
    needle: "names contain quotation marks or newlines",
  },
  {
    what: "keeps those three claims about THIS build, not about upstream",
    needle: "None of them is a claim about the upstream sources",
  },
];

/** Hard wrapping is not content: compare with runs of whitespace collapsed. */
const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Whether the attribution block still says everything it must.
 *
 * Pure, so the fixtures below run the same code the real NOTICE does.
 */
function attributionFindings(notice: string): Finding[] {
  const text = flat(notice);
  return ATTRIBUTION_CLAUSES.map(({ what, needle }) =>
    text.includes(flat(needle))
      ? ok(`NOTICE ${what}`)
      : bad(`NOTICE ${what}`, `missing: ${JSON.stringify(needle)}`)
  );
}

/**
 * A file that ships, and every clause that has to be in it for it to be worth
 * shipping.
 *
 * PRESENCE IS NOT ENOUGH HERE EITHER, AND FOR A SHARPER REASON THAN THE NOTICE.
 * The two survivors in `vendor/` are in the package because of a claim we make
 * about them: that a consumer who does not trust the native library we
 * distribute as a Release asset can rebuild it from what they installed. A
 * `build.sh` that exists but fetches whatever SQLite is current, or skips the
 * checksum, or builds without the two options this library cannot work
 * without, satisfies presence completely and falsifies the claim completely.
 * That is the trimmed-NOTICE shape one file over, so it gets the same
 * treatment: name the clauses, and delete each one in a fixture that must be
 * rejected by that clause's own name.
 *
 * The values are deliberately not pinned -- `SQLITE_VERSION="` is a clause,
 * `3.53.4` is not. A version bump is ordinary maintenance and must not need
 * this file edited; dropping the pin is not, and does.
 */
const REPRODUCTION_CLAUSES: readonly {
  file: string;
  what: string;
  needle: string;
}[] = [
  {
    file: "vendor/build.sh",
    what: "pins the SQLite version it builds",
    needle: 'SQLITE_VERSION="',
  },
  {
    file: "vendor/build.sh",
    what: "pins the checksum sqlite.org publishes",
    needle: 'SQLITE_SHA3_256="',
  },
  {
    file: "vendor/build.sh",
    what: "refuses to build on a checksum mismatch",
    needle: "SHA3-256 mismatch",
  },
  {
    file: "vendor/build.sh",
    what: "compiles the preupdate hook in",
    needle: "SQLITE_ENABLE_PREUPDATE_HOOK",
  },
  {
    file: "vendor/build.sh",
    what: "compiles the session extension in",
    needle: "SQLITE_ENABLE_SESSION",
  },
  {
    file: "vendor/build.sh",
    what: "records what it built beside the library",
    needle: "build_manifest.json",
  },
  {
    file: "vendor/README.md",
    what: "names the script that rebuilds the library",
    needle: "build.sh",
  },
  {
    file: "vendor/README.md",
    what: "names the preupdate hook as required",
    needle: "SQLITE_ENABLE_PREUPDATE_HOOK",
  },
  {
    file: "vendor/README.md",
    what: "names the session extension as required",
    needle: "SQLITE_ENABLE_SESSION",
  },
  {
    file: "vendor/README.md",
    what: "says the binaries are distributed as Release assets",
    needle: "Release assets",
  },
];

/** The two shipped `vendor/` files, by their published path. */
type FileTexts = Readonly<Record<string, string>>;

const VERSIONS_AGREE =
  "vendor/README.md documents the SQLite version vendor/build.sh builds";

/**
 * The cross-file half, and the reason no version literal appears above.
 *
 * Bumping SQLite means editing two files, and the one that gets forgotten is
 * the prose. This reads the version out of `build.sh` and requires `README.md`
 * to say it, so a bump that updates only the script fails -- while a bump that
 * updates both passes without anyone touching this test.
 */
function versionAgreement(texts: FileTexts): Finding {
  const build = texts["vendor/build.sh"];
  const readme = texts["vendor/README.md"];
  if (build === undefined || readme === undefined) {
    return bad(VERSIONS_AGREE, "one of the two files could not be read");
  }
  const version = /SQLITE_VERSION="([^"]+)"/.exec(build)?.[1];
  if (version === undefined) {
    return bad(VERSIONS_AGREE, "build.sh pins no SQLITE_VERSION to compare");
  }
  return readme.includes(version) ? ok(VERSIONS_AGREE) : bad(
    VERSIONS_AGREE,
    `build.sh builds ${version}; README.md never says that version`,
  );
}

/**
 * Whether the shipped `vendor/` files still say what makes them worth
 * shipping.
 *
 * Pure over the file texts, so the fixtures below run the same code the real
 * files do.
 */
function reproductionFindings(texts: FileTexts): Finding[] {
  const findings = REPRODUCTION_CLAUSES.map(({ file, what, needle }) => {
    const name = `${file} ${what}`;
    const text = texts[file];
    if (text === undefined) return bad(name, `${file} could not be read`);
    return flat(text).includes(flat(needle))
      ? ok(name)
      : bad(name, `missing: ${JSON.stringify(needle)}`);
  });
  findings.push(versionAgreement(texts));
  return findings;
}

/** Whether any pinned-never prefix leaked into the shipped set. */
function forbiddenFindings(shipped: readonly string[]): Finding[] {
  return MUST_NOT_SHIP.map((prefix) => {
    const leaked = shipped.filter((p) => p === prefix || p.startsWith(prefix));
    return leaked.length === 0
      ? ok(`${prefix} does not ship`)
      : bad(`${prefix} does not ship`, `shipped ${leaked.join(", ")}`);
  });
}

/**
 * Whether every local module the entry point reaches is in the shipped set.
 *
 * Pure and fixture-driven for a reason worth stating rather than assuming:
 * `deno publish --dry-run` REFUSES outright when a module the graph reaches is
 * excluded — measured 2026-09-09 by excluding `src/format.ts`, which made
 * publish exit 1 and this assertion never run. So it cannot be made to fail
 * against the real tree by removing an imported file, and a check nobody has
 * seen fail is a check of unknown value. The fixtures below are where it is
 * seen to fail. Against the real manifest it is a second opinion covering the
 * cases publish's own refusal does not: a module reached at run time rather
 * than through a static import, or an exclusion publish tolerates.
 */
function graphFindings(
  shipped: readonly string[],
  reachable: readonly string[],
): Finding {
  const have = new Set(shipped);
  const unshipped = reachable.filter((p) => !have.has(p)).sort();
  return unshipped.length === 0
    ? ok("every local module mod.ts reaches ships")
    : bad(
      "every local module mod.ts reaches ships",
      `imported but not published: ${unshipped.join(", ")}`,
    );
}

/** Every file the manifest must contain because `mod.ts` imports it. */
function reachableFromEntryPoint(): { paths: string[] } | { why: string } {
  const out = new Deno.Command(Deno.execPath(), {
    args: ["info", "--json", "mod.ts"],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).outputSync();
  if (out.code !== 0) {
    return {
      why: `deno info exited ${out.code}: ${
        new TextDecoder().decode(out.stderr).trim().slice(-500)
      }`,
    };
  }
  let graph: unknown;
  try {
    graph = JSON.parse(new TextDecoder().decode(out.stdout));
  } catch (e) {
    return { why: `deno info did not emit JSON: ${String(e)}` };
  }
  if (typeof graph !== "object" || graph === null) {
    return { why: "deno info emitted JSON that is not an object" };
  }
  const modules = Reflect.get(graph, "modules");
  if (!Array.isArray(modules)) {
    return { why: "deno info emitted no `modules` array" };
  }
  const prefix = `file://${root}/`;
  const paths: string[] = [];
  for (const m of modules) {
    if (typeof m !== "object" || m === null) continue;
    const specifier = Reflect.get(m, "specifier");
    if (typeof specifier !== "string") continue;
    if (!specifier.startsWith(prefix)) continue;
    paths.push(specifier.slice(prefix.length));
  }
  return { paths };
}

const CONTROL_FIXTURES: readonly {
  readonly name: string;
  readonly shipped: readonly string[];
  /** Empty means the fixture must be ACCEPTED. */
  readonly expect: string;
}[] = [
  {
    name: "an unchanged set is accepted",
    shipped: MANIFEST,
    expect: "",
  },
  {
    name: "a reordered set is accepted: this compares sets, not sequences",
    shipped: [...MANIFEST].reverse(),
    expect: "",
  },
  {
    name: "one extra file is rejected as a WIDENING",
    shipped: [...MANIFEST, "src/secret_scratch.ts"],
    expect: "WIDENED",
  },
  {
    name: "one missing file is rejected as a NARROWING",
    shipped: MANIFEST.filter((p) => p !== "src/hooks.ts"),
    expect: "NARROWED",
  },
  {
    name: "a swap is rejected in both directions at once",
    shipped: [...MANIFEST.filter((p) => p !== "NOTICE"), "ATTRIBUTION.md"],
    expect: "WIDENED",
  },
  {
    name: "an empty manifest is rejected rather than read as nothing to check",
    shipped: [],
    expect: "NARROWED",
  },
];

let passed = 0;
let failed = 0;
const record = (f: Finding) => {
  if (f.ok) {
    passed++;
    console.log(`  pass  ${f.what}`);
  } else {
    failed++;
    Deno.exitCode = 1;
    console.log(`  FAIL  ${f.what} — ${f.detail}`);
  }
};

console.log("comparison controls");
for (const fixture of CONTROL_FIXTURES) {
  const findings = manifestFindings(fixture.shipped, MANIFEST);
  const bads = findings.filter((f) => !f.ok);
  if (fixture.expect === "") {
    record(
      bads.length === 0 ? ok(`control: ${fixture.name}`) : bad(
        `control: ${fixture.name}`,
        `rejected it: ${bads.map((f) => f.detail).join("; ")}`,
      ),
    );
    continue;
  }
  const said = bads.map((f) => f.detail).join("; ");
  record(
    said.includes(fixture.expect) ? ok(`control: ${fixture.name}`) : bad(
      `control: ${fixture.name}`,
      bads.length === 0
        ? "accepted it"
        : `rejected it without saying ${fixture.expect}: ${said}`,
    ),
  );
}

/**
 * Why this check cannot run here, or `null` if it can.
 *
 * In a git WORKTREE `.git` is a file, not a directory, and
 * `deno publish --dry-run` therefore includes it in the published set. The
 * result is a red that reads exactly like a real drift — "WIDENED by 1: .git"
 * — in the one environment we use for independent verification. That is worse
 * than no check: the person who hits it learns that this gate produces
 * spurious reds, and that lesson outlives the explanation and is what waves a
 * real drift through one day.
 *
 * So it refuses and says so, rather than reporting something that is not
 * happening. A refusal that names what it does not know costs a few lines; a
 * misleading red costs the credibility of every future run.
 */
function cannotRunHere(
  gitEntry: { exists: boolean; isFile: boolean },
): string | null {
  if (!gitEntry.exists) return null;
  if (!gitEntry.isFile) return null;
  return "this check cannot run from a git worktree: `.git` is a FILE there rather than a directory, so `deno publish --dry-run` includes it and the published set reads as WIDENED by 1 when nothing has changed. Run it from a real checkout.";
}

const ENVIRONMENT_FIXTURES: readonly {
  readonly name: string;
  readonly entry: { exists: boolean; isFile: boolean };
  /** Empty means the fixture must be ACCEPTED — the check may run. */
  readonly expect: string;
}[] = [
  {
    name: "a real checkout, where .git is a directory, RUNS the check",
    entry: { exists: true, isFile: false },
    expect: "",
  },
  {
    name: "no .git at all is not a worktree and RUNS the check",
    entry: { exists: false, isFile: false },
    expect: "",
  },
  {
    name: "a worktree, where .git is a file, is refused and told why",
    entry: { exists: true, isFile: true },
    expect: "git worktree",
  },
];

const GRAPH_FIXTURES: readonly {
  readonly name: string;
  readonly shipped: readonly string[];
  readonly reachable: readonly string[];
  /** Empty means the fixture must be ACCEPTED. */
  readonly expect: string;
}[] = [
  {
    name: "a graph wholly inside the shipped set is accepted",
    shipped: MANIFEST,
    reachable: ["mod.ts", "src/hooks.ts", "src/format.ts"],
    expect: "",
  },
  {
    name: "an empty graph is accepted here and caught by its own assertion",
    shipped: MANIFEST,
    reachable: [],
    expect: "",
  },
  {
    name: "a reached module that does not ship is rejected and named",
    shipped: MANIFEST,
    reachable: ["mod.ts", "src/runtime_only.ts"],
    expect: "src/runtime_only.ts",
  },
];

for (const fixture of GRAPH_FIXTURES) {
  const f = graphFindings(fixture.shipped, fixture.reachable);
  if (fixture.expect === "") {
    record(
      f.ok
        ? ok(`control: ${fixture.name}`)
        : bad(`control: ${fixture.name}`, `rejected it: ${f.detail}`),
    );
  } else {
    record(
      !f.ok && f.detail.includes(fixture.expect)
        ? ok(`control: ${fixture.name}`)
        : bad(
          `control: ${fixture.name}`,
          f.ok ? "accepted it" : `rejected it without naming it: ${f.detail}`,
        ),
    );
  }
}

console.log("\nthe attribution block");

/**
 * Delete a clause from a real file, tolerating however it is wrapped.
 *
 * Every occurrence, not the first. A clause that appears twice and is deleted
 * once is still present, so the fixture would go green having proved nothing
 * -- the failure mode this whole file exists to refuse.
 */
function withoutClause(text: string, needle: string): string {
  const pattern = flat(needle)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll(" ", "\\s+");
  return text.replace(new RegExp(pattern, "g"), "");
}

const noticeText = ((): string | null => {
  try {
    return Deno.readTextFileSync(`${root}/NOTICE`);
  } catch {
    return null;
  }
})();

if (noticeText === null) {
  record(bad("NOTICE was read", `no readable NOTICE at ${root}/NOTICE`));
} else {
  // The accepted side, clause by clause. This is the real assertion; the
  // fixtures below are what say it can go red.
  for (const f of attributionFindings(noticeText)) record(f);

  // Each clause deleted in turn. The deletion must be rejected, and rejected
  // BY THE NAME of the clause that went missing — a check that only reported
  // "NOTICE is wrong" would leave the operator to find out which sentence.
  for (const clause of ATTRIBUTION_CLAUSES) {
    const damaged = withoutClause(noticeText, clause.needle);
    const name = `control: deleting "${clause.what}" is rejected`;
    if (damaged === noticeText) {
      record(bad(name, "the fixture deleted nothing, so it proves nothing"));
      continue;
    }
    const named = attributionFindings(damaged)
      .filter((f) => !f.ok)
      .map((f) => f.what);
    record(
      named.includes(`NOTICE ${clause.what}`) ? ok(name) : bad(
        name,
        named.length === 0
          ? "accepted it"
          : `rejected it, but named ${named.join(", ")} instead`,
      ),
    );
  }

  // The tidying that started this: the whole modified-files paragraph gone.
  // Measured 2026-09-10 to leave every other assertion in this file green.
  const untidied = noticeText.replace(
    /The vendored sources have been MODIFIED[\s\S]*?on negative zero\)\.\n/,
    "",
  );
  const lost = attributionFindings(untidied).filter((f) => !f.ok).length;
  record(
    untidied !== noticeText && lost >= 3
      ? ok("control: deleting the whole modified-files paragraph is rejected")
      : bad(
        "control: deleting the whole modified-files paragraph is rejected",
        untidied === noticeText
          ? "the fixture deleted nothing, so it proves nothing"
          : `only ${lost} clauses went red`,
      ),
  );
}

console.log("\nwhat the shipped vendor/ files must still say");

const vendorTexts: Record<string, string> = {};
for (const file of new Set(REPRODUCTION_CLAUSES.map((c) => c.file))) {
  try {
    vendorTexts[file] = Deno.readTextFileSync(`${root}/${file}`);
  } catch {
    record(bad(`${file} was read`, `no readable file at ${root}/${file}`));
  }
}

// The accepted side: the real files, clause by clause.
for (const f of reproductionFindings(vendorTexts)) record(f);

// Each clause deleted in turn, and rejected BY ITS OWN NAME.
for (const clause of REPRODUCTION_CLAUSES) {
  const name =
    `control: deleting "${clause.what}" from ${clause.file} is rejected`;
  const text = vendorTexts[clause.file];
  if (text === undefined) {
    record(bad(name, `${clause.file} was not read, so nothing was proved`));
    continue;
  }
  const damaged = withoutClause(text, clause.needle);
  if (damaged === text) {
    record(bad(name, "the fixture deleted nothing, so it proves nothing"));
    continue;
  }
  const named = reproductionFindings({ ...vendorTexts, [clause.file]: damaged })
    .filter((f) => !f.ok)
    .map((f) => f.what);
  record(
    named.includes(`${clause.file} ${clause.what}`) ? ok(name) : bad(
      name,
      named.length === 0
        ? "accepted it"
        : `rejected it, but named ${named.join(", ")} instead`,
    ),
  );
}

// A version bump that updates the script and forgets the prose.
{
  const name = "control: a bumped build.sh with a stale README.md is rejected";
  const build = vendorTexts["vendor/build.sh"];
  if (build === undefined) {
    record(bad(name, "vendor/build.sh was not read, so nothing was proved"));
  } else {
    const bumped = build.replace(
      /SQLITE_VERSION="[^"]+"/,
      'SQLITE_VERSION="99.99.99"',
    );
    const named = reproductionFindings({
      ...vendorTexts,
      "vendor/build.sh": bumped,
    }).filter((f) => !f.ok).map((f) => f.what);
    record(
      bumped !== build && named.includes(VERSIONS_AGREE) ? ok(name) : bad(
        name,
        bumped === build
          ? "the fixture changed nothing, so it proves nothing"
          : `did not name the disagreement; named ${
            named.join(", ") || "nothing"
          }`,
      ),
    );
  }
}

// A file that vanished entirely, rather than one that was trimmed.
{
  const name = "control: an unreadable shipped file is rejected, not skipped";
  const named = reproductionFindings({}).filter((f) => !f.ok).map((f) =>
    f.what
  );
  record(
    named.length === REPRODUCTION_CLAUSES.length + 1 ? ok(name) : bad(
      name,
      `expected every clause to go red, got ${named.length}`,
    ),
  );
}

console.log("\nenvironment controls");
for (const fixture of ENVIRONMENT_FIXTURES) {
  const why = cannotRunHere(fixture.entry);
  if (fixture.expect === "") {
    record(
      why === null ? ok(`control: ${fixture.name}`) : bad(
        `control: ${fixture.name}`,
        `refused a place it can run: ${why}`,
      ),
    );
  } else {
    record(
      why !== null && why.includes(fixture.expect)
        ? ok(`control: ${fixture.name}`)
        : bad(
          `control: ${fixture.name}`,
          why === null
            ? "ran anyway"
            : `refused without saying ${fixture.expect}: ${why}`,
        ),
    );
  }
}

// The refusal itself. Before the publish run, not after: the point is not to
// explain a wrong answer, it is not to produce one.
const gitEntry = ((): { exists: boolean; isFile: boolean } => {
  try {
    return { exists: true, isFile: Deno.statSync(`${root}/.git`).isFile };
  } catch {
    return { exists: false, isFile: false };
  }
})();
const refusal = cannotRunHere(gitEntry);
if (refusal !== null) {
  console.error(`\nREFUSED: ${refusal}`);
  console.log(
    `\n${passed} passed, ${failed} failed — CHECK DID NOT RUN`,
  );
  Deno.exit(2);
}

console.log("\nthe published set");

/** --dry-run performs every check and validation WITHOUT uploading. */
const out = await new Deno.Command(Deno.execPath(), {
  args: ["publish", "--dry-run", "--allow-dirty", "--no-check"],
  cwd: root,
  stdout: "piped",
  stderr: "piped",
}).output();

const text = new TextDecoder().decode(out.stdout) +
  new TextDecoder().decode(out.stderr);

if (out.code !== 0) {
  record(bad(
    "deno publish --dry-run",
    `exited ${out.code}. Output:\n${text.trim().slice(-1500)}`,
  ));
} else {
  // Each shipped file is reported as an absolute file:// URL, one per line.
  const shipped = text.split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("file://"))
    .map((l) => l.replace(/\s*\(.*\)$/, ""))
    .map((l) => new URL(l).pathname)
    .filter((p) => p.startsWith(`${root}/`))
    .map((p) => p.slice(root.length + 1));

  console.log(`  publish manifest: ${shipped.length} files`);
  if (shipped.length === 0) {
    record(bad(
      "the manifest was parsed",
      `no file:// lines in:\n${text.slice(-1500)}`,
    ));
  } else {
    record(ok("the manifest was parsed"));
    for (const f of manifestFindings(shipped, MANIFEST)) record(f);
    for (const f of forbiddenFindings(shipped)) record(f);

    const reachable = reachableFromEntryPoint();
    if ("why" in reachable) {
      record(bad("the entry point's module graph was read", reachable.why));
    } else if (reachable.paths.length === 0) {
      record(bad(
        "the entry point's module graph was read",
        "no local module reached from mod.ts, not even mod.ts itself",
      ));
    } else {
      record(ok(
        `the entry point's module graph was read (${reachable.paths.length} local modules)`,
      ));
      record(graphFindings(shipped, reachable.paths));
    }
  }
}

console.log(
  `\n${passed} passed, ${failed} failed — ${failed === 0 ? "OK" : "FAILURES"}`,
);
