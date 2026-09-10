/**
 * Whether any CI step can suppress any other.
 *
 * THE DEFECT THIS EXISTS BECAUSE OF. A subordinate check — a smoke test that
 * imported a specifier the import map no longer carried — sat ahead of the
 * three steps that are the point of the job. It failed, and because a
 * GitHub Actions step failure skips every later step by default, `Tests`,
 * `Crash matrix` and `Publish manifest` did not run. Nine consecutive pushes
 * were merged with no suite having executed in CI, and every one of those runs
 * reported a single red step, which reads as a small problem while being a
 * total one. The import was the trigger; the amplifier was the ordering.
 *
 * THE INVARIANT, stated once: only a genuine PRECONDITION may gate a later
 * step. Everything else runs regardless, and fails on its own terms.
 *
 * The mechanism is a guard rather than a reordering. Both express the
 * invariant, but once every non-precondition step carries the guard the order
 * stops mattering at all, which a reordering never achieves — it only makes
 * today's order the right one.
 *
 * WHY A TEST AND NOT A CONVENTION. Before this file, nothing in the repository
 * read `.github/workflows/ci.yml` at all. An invariant whose whole expression
 * is "four steps happen to lack a line of YAML" is one pull request away from
 * being violated by someone adding a step, and the violation is invisible
 * until the day a step fails and takes the suites with it — which is to say,
 * on the day it costs the most.
 *
 * WHAT IS PINNED AND WHY IT IS PINNED WHOLE. The precondition set is compared
 * as a SET, in both directions: a step losing its guard and a step gaining an
 * exemption are both failures, and the report says which happened. Naming only
 * the steps that must be guarded would go on passing the day someone adds an
 * unguarded one.
 *
 * The comparison is a pure function, driven by fixtures before it is pointed
 * at the real workflow — including a fixture that must be ACCEPTED, because
 * fixtures that must all be rejected cannot tell a working comparison from one
 * that rejects everything.
 *
 * Opens no library and needs no libsqlite3, which is why CI can run it early.
 *
 * Run: deno task test:ci-guards
 *
 * @module
 */

/**
 * The steps that may gate the rest of the job, by name, in full.
 *
 * These four are preconditions in the strict sense: if any of them fails,
 * nothing downstream can be trusted to mean anything. There is no checkout, or
 * no `deno`, or no library to open. Everything else in the job is a CHECK, and
 * one check failing says nothing about whether another would pass.
 *
 * The consequence is deliberate and is not a gap: when a precondition does
 * fail, the guarded steps still skip. That is a real precondition failure and
 * the run is correctly red.
 */
const PRECONDITIONS: readonly string[] = [
  "Check out the repository",
  "Install Deno",
  "Install libsqlite3",
  "Pin DENO_SQLITE_PATH",
];

/**
 * The guard every other step must carry, verbatim.
 *
 * `!cancelled()` and not `always()`: a run someone cancelled should stop,
 * rather than grind through every remaining step.
 */
const GUARD = "!cancelled()";

const root = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const WORKFLOW = `${root}/.github/workflows/ci.yml`;

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

/** One step of the job, as the workflow declares it. */
interface Step {
  /** `name:` if it has one, otherwise `uses:`. */
  readonly identity: string;
  /** The `if:` expression, with quotes and whitespace stripped. */
  readonly guard: string | undefined;
}

/**
 * The job's steps, read out of the workflow text.
 *
 * Textual rather than through a YAML parser, and the trade is stated rather
 * than assumed: a parser would need a dependency this project does not have,
 * and the shape being read — a list of mappings at one fixed indent — is the
 * part of YAML with no ambiguity in it. The risk a textual read carries is
 * reading FEWER steps than exist and reporting green on the ones it missed, so
 * the caller asserts the count it found against the count of `- ` entries in
 * the block and refuses to conclude anything if they disagree.
 */
function parseSteps(text: string): Step[] | string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^ {4}steps:\s*$/.test(l));
  if (start === -1) return "no `    steps:` line in the workflow";

  const steps: Step[] = [];
  let current:
    | { identity: string | undefined; guard: string | undefined }
    | undefined;
  const flush = () => {
    if (current === undefined) return;
    if (current.identity === undefined) return;
    steps.push({ identity: current.identity, guard: current.guard });
    current = undefined;
  };

  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || /^\s*#/.test(line)) continue;
    // Anything at or above the `steps:` key's own indent ends the block.
    if (/^ {0,4}\S/.test(line)) break;
    if (/^ {6}- /.test(line)) {
      flush();
      current = { identity: undefined, guard: undefined };
    }
    if (current === undefined) continue;
    // A step's own keys are at indent 8, except the first, which shares the
    // `- ` line at indent 6. Anything deeper belongs to a nested mapping (the
    // `with:` of a `uses:` step) or to a block scalar (`run: |`).
    const key = /^(?: {6}- | {8})([A-Za-z-]+):\s*(.*?)\s*$/.exec(line);
    const field = key?.[1];
    const value = key?.[2];
    if (field === undefined || value === undefined) continue;
    if (field === "name") current.identity = unquote(value);
    if (field === "uses" && current.identity === undefined) {
      current.identity = unquote(value);
    }
    if (field === "if") current.guard = unquote(value);
  }
  flush();
  return steps;
}

/** Strip one layer of matching quotes, if there is one. */
function unquote(value: string): string {
  const m = /^(['"])(.*)\1$/.exec(value);
  return m?.[2] ?? value;
}

/**
 * Whether the parsed steps satisfy the invariant.
 *
 * Pure, so the fixtures below drive the same code the real workflow does. A
 * copy would keep passing after this diverged.
 */
function guardFindings(
  steps: readonly Step[],
  preconditions: readonly string[],
): Finding[] {
  const findings: Finding[] = [];

  const unnamed = steps.filter((s) => s.identity === "");
  findings.push(
    unnamed.length === 0 ? ok("every step in the job can be identified") : bad(
      "every step in the job can be identified",
      `${unnamed.length} step(s) have neither a name nor a uses`,
    ),
  );

  const want = new Set(preconditions);
  const exempt = steps.filter((s) => s.guard === undefined).map((s) =>
    s.identity
  );
  const have = new Set(exempt);
  const widened = exempt.filter((n) => !want.has(n)).sort();
  const narrowed = preconditions.filter((n) => !have.has(n)).sort();

  findings.push(
    widened.length === 0
      ? ok("no step outside the pinned preconditions is unguarded")
      : bad(
        "no step outside the pinned preconditions is unguarded",
        `the exempt set WIDENED by ${widened.length}: ${
          widened.join(", ")
        } — an unguarded step suppresses every step after it`,
      ),
  );
  findings.push(
    narrowed.length === 0
      ? ok("every pinned precondition is present and unguarded")
      : bad(
        "every pinned precondition is present and unguarded",
        `the exempt set NARROWED by ${narrowed.length}: ${
          narrowed.join(", ")
        } — either the step is gone or it was guarded`,
      ),
  );

  const wrong = steps.filter((s) => s.guard !== undefined && s.guard !== GUARD);
  findings.push(
    wrong.length === 0 ? ok(`every guard is exactly \`${GUARD}\``) : bad(
      `every guard is exactly \`${GUARD}\``,
      wrong.map((s) => `${s.identity} carries \`${s.guard}\``).join("; "),
    ),
  );

  return findings;
}

const FIXTURE_PRECONDITIONS: readonly string[] = ["setup", "install"];

const FIXTURE_STEPS: readonly Step[] = [
  { identity: "setup", guard: undefined },
  { identity: "install", guard: undefined },
  { identity: "lint", guard: GUARD },
  { identity: "tests", guard: GUARD },
];

const FIXTURES: readonly {
  readonly name: string;
  readonly steps: readonly Step[];
  /** Empty means the fixture must be ACCEPTED. */
  readonly expect: string;
}[] = [
  {
    name: "a workflow that satisfies the invariant is accepted",
    steps: FIXTURE_STEPS,
    expect: "",
  },
  {
    name: "a guarded step losing its guard is rejected as a WIDENING",
    steps: FIXTURE_STEPS.map((s) =>
      s.identity === "tests" ? { identity: s.identity, guard: undefined } : s
    ),
    expect: "WIDENED",
  },
  {
    name: "a new unguarded step is rejected as a WIDENING",
    steps: [...FIXTURE_STEPS, { identity: "smoke", guard: undefined }],
    expect: "WIDENED",
  },
  {
    name: "a precondition that gained a guard is rejected as a NARROWING",
    steps: FIXTURE_STEPS.map((s) =>
      s.identity === "install" ? { identity: s.identity, guard: GUARD } : s
    ),
    expect: "NARROWED",
  },
  {
    name: "a precondition that disappeared is rejected as a NARROWING",
    steps: FIXTURE_STEPS.filter((s) => s.identity !== "setup"),
    expect: "NARROWED",
  },
  {
    name: "always() is rejected: a cancelled run should stop",
    steps: FIXTURE_STEPS.map((s) =>
      s.identity === "lint" ? { identity: s.identity, guard: "always()" } : s
    ),
    expect: "always()",
  },
  {
    name: "a step with neither name nor uses is rejected rather than skipped",
    steps: [...FIXTURE_STEPS, { identity: "", guard: GUARD }],
    expect: "neither a name nor a uses",
  },
];

/**
 * Fixtures for the READER, which the fixtures above do not touch.
 *
 * They were added because they were needed: the first version of
 * {@linkcode parseSteps} looked for `if:` at the wrong indent and found none,
 * and every fixture for {@linkcode guardFindings} passed anyway — a comparison
 * cannot be tested with input the reader never produced. The two hazards a
 * textual reader has are both here: reading a key that belongs to a nested
 * mapping or to a `run:` block as though it belonged to the step, and reading
 * no step at all.
 */
const PARSE_FIXTURES: readonly {
  readonly name: string;
  readonly text: string;
  /** The identity/guard pairs the reader must produce, or a refusal. */
  readonly want: string;
}[] = [
  {
    name: "a step's name, uses and if are read from their own indents",
    text: [
      "jobs:",
      "  ci:",
      "    steps:",
      "      - name: Check out the repository",
      "        uses: actions/checkout@v4",
      "      - name: lint",
      "        if: '!cancelled()'",
      "        run: deno lint",
      "",
    ].join("\n"),
    want: "Check out the repository=-; lint=!cancelled()",
  },
  {
    name: "a step with only a uses is identified by it",
    text: ["    steps:", "      - uses: denoland/setup-deno@v2", ""].join("\n"),
    want: "denoland/setup-deno@v2=-",
  },
  {
    name: "an if inside a nested with: is not read as the step's guard",
    text: [
      "    steps:",
      "      - name: nested",
      "        uses: some/action@v1",
      "        with:",
      "          if: 'always()'",
      "",
    ].join("\n"),
    want: "nested=-",
  },
  {
    name: "an if inside a run: block is not read as the step's guard",
    text: [
      "    steps:",
      "      - name: scripted",
      "        run: |",
      "          if: not yaml",
      "          echo hi",
      "",
    ].join("\n"),
    want: "scripted=-",
  },
  {
    name: "a comment line between steps does not start a step",
    text: [
      "    steps:",
      "      # a comment",
      "      - name: only",
      "        if: '!cancelled()'",
      "",
    ].join("\n"),
    want: "only=!cancelled()",
  },
  {
    name: "a file with no steps: block is refused rather than read as empty",
    text: "name: CI\non:\n  push:\n",
    want: "REFUSED",
  },
];

/** The reader's output in one line, for comparison against a fixture. */
function rendered(steps: readonly Step[]): string {
  return steps.map((s) => `${s.identity}=${s.guard ?? "-"}`).join("; ");
}

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

console.log("\nfixtures — the reader\n");
for (const fixture of PARSE_FIXTURES) {
  const steps = parseSteps(fixture.text);
  const got = typeof steps === "string" ? "REFUSED" : rendered(steps);
  record(
    got === fixture.want ? ok(fixture.name) : bad(
      fixture.name,
      `read ${JSON.stringify(got)}, wanted ${JSON.stringify(fixture.want)}`,
    ),
  );
}

console.log("\nfixtures — the comparison itself\n");
for (const fixture of FIXTURES) {
  const findings = guardFindings(fixture.steps, FIXTURE_PRECONDITIONS);
  const rejections = findings.filter((f) => !f.ok);
  if (fixture.expect === "") {
    record(
      rejections.length === 0 ? ok(fixture.name) : bad(
        fixture.name,
        `accepted nothing: ${rejections.map((f) => f.detail).join("; ")}`,
      ),
    );
    continue;
  }
  const matched = rejections.some((f) => f.detail.includes(fixture.expect));
  record(
    matched ? ok(fixture.name) : bad(
      fixture.name,
      rejections.length === 0
        ? `accepted it, and it should have been rejected for ${fixture.expect}`
        : `rejected it for the wrong reason: ${
          rejections.map((f) => f.detail).join("; ")
        }`,
    ),
  );
}

console.log("\n.github/workflows/ci.yml\n");

const text = ((): string | null => {
  try {
    return Deno.readTextFileSync(WORKFLOW);
  } catch (e) {
    record(bad("the workflow was read", `${WORKFLOW}: ${e}`));
    return null;
  }
})();

if (text !== null) {
  record(ok(`the workflow was read (${WORKFLOW})`));
  const steps = parseSteps(text);
  if (typeof steps === "string") {
    record(bad("the workflow's steps were parsed", steps));
  } else {
    // The hazard of a textual read is finding FEWER steps than exist and
    // reporting green on the ones it never saw. Count the list entries
    // independently of the parse and refuse to conclude anything if the two
    // disagree.
    const entries = text.split("\n").filter((l) => /^ {6}- /.test(l)).length;
    if (entries !== steps.length) {
      record(bad(
        "the parse found every step in the job",
        `${entries} list entries at step indent, ${steps.length} parsed — the reader has stopped matching, and every finding below it would be about a subset`,
      ));
    } else {
      record(ok(`the parse found every step in the job (${entries})`));
      for (const f of guardFindings(steps, PRECONDITIONS)) record(f);
    }
  }
}

console.log(
  `\n${passed} passed, ${failed} failed — ${failed === 0 ? "OK" : "FAILURES"}`,
);
