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
 * WHEN THE DRIVER IS VENDORED, PRESENCE STOPS BEING ENOUGH. A trimmed NOTICE
 * still exists, and Apache-2.0's modified-files sentence is exactly the kind of
 * paragraph that gets shortened for tidiness. At that point this file grows a
 * CONTENT assertion on the attribution block, not just a presence one.
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
  "mod.ts",
  "src/backend.ts",
  "src/backend_ffi.ts",
  "src/dependencies.ts",
  "src/format.ts",
  "src/hooks.ts",
  "src/lib_path.ts",
  "src/schema_map.ts",
  "src/schema_watch.ts",
  "vendor/README.md",
  "vendor/build.sh",
  "vendor/probe.ts",
  "vendor/select.ts",
  "vendor/session_demo.ts",
  "vendor/smoke_test.c",
  "vendor/smoke_test.sh",
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
