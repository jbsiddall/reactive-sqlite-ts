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
 * WHEN THE DRIVER IS VENDORED, PRESENCE STOPS BEING ENOUGH. A trimmed NOTICE
 * still exists, and Apache-2.0's modified-files sentence is exactly the kind of
 * paragraph that gets shortened for tidiness. At that point this file grows a
 * CONTENT assertion on the attribution block, not just a presence one.
 *
 * Run: deno task test:publish
 */
const MUST_SHIP = [
  "LICENSE",
  "NOTICE",
  "README.md",
  "deno.json",
  "mod.ts",
  "src/hooks.ts",
  "src/schema_map.ts",
  "src/schema_watch.ts",
];

/** Excluded today. Listed so the test fails if what ships WIDENS, not only if it narrows. */
const MUST_NOT_SHIP = [
  "test/",
  "tools/",
  "examples/",
  ".github/",
  "CONTRIBUTING.md",
  "DOMAIN_KNOWLEDGE.md",
  "DRIVER_DEFECTS.md",
];

const root = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

/** --dry-run performs every check and validation WITHOUT uploading. */
const out = await new Deno.Command(Deno.execPath(), {
  args: ["publish", "--dry-run", "--allow-dirty", "--no-check"],
  cwd: root,
  stdout: "piped",
  stderr: "piped",
}).output();

const text = new TextDecoder().decode(out.stdout) +
  new TextDecoder().decode(out.stderr);

let passed = 0;
let failed = 0;
const pass = (what: string) => {
  passed++;
  console.log(`  pass  ${what}`);
};
const fail = (what: string, detail: string) => {
  failed++;
  Deno.exitCode = 1;
  console.log(`  FAIL  ${what} — ${detail}`);
};

if (out.code !== 0) {
  fail(
    "deno publish --dry-run",
    `exited ${out.code}. Output:\n${text.trim().slice(-1500)}`,
  );
} else {
  // Each shipped file is reported as an absolute file:// URL, one per line.
  const shipped = text.split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("file://"))
    .map((l) => l.replace(/\s*\(.*\)$/, ""))
    .map((l) => new URL(l).pathname)
    .filter((p) => p.startsWith(`${root}/`))
    .map((p) => p.slice(root.length + 1));

  console.log(`publish manifest (${shipped.length} files)`);
  if (shipped.length === 0) {
    fail(
      "the manifest was parsed",
      `no file:// lines in:\n${text.slice(-1500)}`,
    );
  }
  for (const name of MUST_SHIP) {
    if (shipped.includes(name)) pass(`${name} ships`);
    else fail(`${name} ships`, `absent from ${shipped.join(", ")}`);
  }
  for (const prefix of MUST_NOT_SHIP) {
    const leaked = shipped.filter((p) => p === prefix || p.startsWith(prefix));
    if (leaked.length === 0) pass(`${prefix} does not ship`);
    else fail(`${prefix} does not ship`, `shipped ${leaked.join(", ")}`);
  }
}

console.log(
  `\n${passed} passed, ${failed} failed — ${failed === 0 ? "OK" : "FAILURES"}`,
);
