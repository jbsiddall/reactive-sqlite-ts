/**
 * Is each "this libsqlite3 cannot do that" refusal actually exercised, and by
 * what?
 *
 * Every optional capability has a branch that refuses the option rather than
 * degrade silently. Whether those branches are tested is not a question a
 * coverage percentage answers, because there are THREE outcomes and only one
 * of them is good:
 *
 *   1. `absent`    — reached against a library that genuinely lacks the symbol.
 *   2. `simulated` — reached only because an option fakes the absence. The
 *                    branch runs; what it would do on a real library that
 *                    lacks the symbol is inferred, not observed.
 *   3. `none`      — never reached by anything.
 *
 * State 2 must not read as state 1 at a glance, so it is never spelled "yes".
 *
 * HOW IT DECIDES, and why this is a measurement rather than a grep: each
 * branch's condition is rewritten to `false` in a scratch copy of the source
 * and the semantic suite is re-run. If the suite still passes, nothing was
 * relying on that refusal -- state 3. If the suite fails, something reached
 * it, and the capability probe of the library the suite runs against says
 * which of states 1 and 2 it was: a library that genuinely lacks the symbol
 * can reach the branch by itself, one that has it can only have been faked in.
 *
 * THE CONTROLS. A classifier is a checker, so it gets no exemption from the
 * rule it exists to enforce. Two branches have known answers, pinned below,
 * and are asserted before any other row is reportable:
 *
 *   - `normalizedSql` is genuinely absent from the system 3.45.1 library, and
 *     the suite refuses `sql: "normalized"` on it. It MUST classify `absent`.
 *   - `progress` is present on both testable libraries and has no simulating
 *     option, so nothing can reach its refusal. It MUST classify `none`.
 *
 * If either control comes out wrong the classifier is broken and the whole
 * report is withheld: a wrong control means the other rows were produced by
 * the same broken machinery. Finding ZERO branches is likewise a failure and
 * never a clean report -- an empty table reads as "nothing uncovered".
 *
 * Those two controls need a real library, and between them they can only ever
 * elicit states 1 and 3. State 2 they cannot reach at all: no library
 * reachable from this repository has a capability whose absence one of our
 * options can fake, so `simulated` is a defined state that nothing measured
 * here occupies. The judgement is therefore split out — {@linkcode decide},
 * four evidence values in, one state out — and driven by synthetic inputs
 * covering all four, so the `simulated` verdict is watched happening rather
 * than reasoned about. `decide` is the function the real path calls, not a
 * copy of it; a copy would keep passing after the real one diverged. The split
 * buys the DECISION and nothing more: the mutate, type-check and re-run
 * machinery that produces the evidence is still exercised only by running this
 * against a real library.
 *
 * The machinery gets a control of its own for the same reason:
 * {@linkcode pipelineControlHolds} runs the rewrite-type-check-rerun over
 * `tools/canary_branch.ts`, a refusal that belongs to no library, and requires
 * its self-test to pass intact and fail disabled. So the three things a suite
 * failure is read as evidence of — an `if` was found, the result still
 * compiled, behaviour actually changed — are watched on every invocation
 * rather than inferred from one library's missing SQLITE_ENABLE_NORMALIZE.
 *
 * That is what lets this run against a library that HAS normalize. It used to
 * refuse outright, because that absence was the only positive control and
 * losing it left every row resting on unvouched-for machinery. With the
 * machinery vouched for independently, a normalize-enabled library no longer
 * costs the audit its trustworthiness — it costs ONE ROW its reachability,
 * which is a per-row fact and is now reported as one: `absent` requires the
 * library to genuinely lack the symbol, so on a library that has it the row is
 * "not exercisable here" rather than drift, and the other six rows are
 * measured and reported instead of suppressed.
 *
 * WHAT THAT COSTS, recorded here rather than only in the project record,
 * because whoever tidies these controls will be reading this file and not
 * that one: of the two library-dependent controls, `normalizedSql` is the
 * only one expecting state 1, and it is exactly the row a normalize-enabled
 * library makes not exercisable. On such a library every control that still
 * APPLIES expects `none` — so the surviving controls would be satisfied just
 * as well by a pipeline that had stopped reaching anything and classified
 * every branch `none`. They are weak in that specific, nameable way, and a
 * run that finds itself in that position says so in one line of its own
 * output rather than leaving the reader to work it out. What holds the report
 * up there is not those controls: it is the synthetic decision fixtures and
 * the canary branch, which need no library at all. Do not trim either as
 * redundant with the live controls. On the system 3.45.1 library they overlap;
 * on a normalize-enabled one they are the entire foundation.
 *
 * AND IT IS LOAD-BEARING SOMEWHERE ELSE. The same `normalizedSql` absence is
 * the only row on which the two live columns of the capability table still
 * disagree -- see `liveVariance` in tools/capability_table.ts. So the distro
 * rebuild that costs this audit its only positive control is the SAME event
 * that leaves that table rendering columns which no longer distinguish two
 * libraries. One fact, two loads, and neither failure announces itself: this
 * file would still report cleanly off its synthetic fixtures, and that table
 * would still regenerate and pass `--check`. The structural parity check is
 * no help -- it asserts the rows match the fields of `Capabilities` and says
 * nothing about the values in the cells. The one thing that does speak is the
 * table gate's live-variance control, which fails at zero carriers and names
 * this file in its failure text. Do not weaken it to a warning.
 *
 *   deno task test:capability-coverage
 *
 * Needs a libsqlite3 (see //libsqlite3) plus --allow-run to re-run the suite.
 */

import { probeCapabilities } from "../src/hooks.ts";
import type { Capabilities } from "../src/hooks.ts";
import { dirname, fromFileUrl, join } from "@std/path";

const ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

/** One refusal branch: where it is, and which capability flag guards it. */
interface Branch {
  /** The capability as named in {@linkcode Capabilities}. */
  capability: keyof Capabilities;
  /** Path relative to the repository root. */
  file: string;
  /** A substring unique to this branch's error message. */
  message: string;
  /** The option that reaches it, for the report. */
  reachedBy: string;
  /** An option that fakes the absence, or null when none exists. */
  simulator: string | null;
}

const BRANCHES: readonly Branch[] = [
  {
    capability: "trace",
    file: "src/hooks.ts",
    message: "does not export sqlite3_trace_v2",
    reachedBy: "trace: true",
    simulator: null,
  },
  {
    capability: "normalizedSql",
    file: "src/hooks.ts",
    message: "needs a libsqlite3 built with SQLITE_ENABLE_NORMALIZE",
    reachedBy: 'sql: "normalized"',
    simulator: null,
  },
  {
    capability: "authorize",
    file: "src/hooks.ts",
    message: "does not export sqlite3_set_authorizer",
    reachedBy: "authorize: true",
    simulator: null,
  },
  {
    capability: "busy",
    file: "src/hooks.ts",
    message: "does not export sqlite3_busy_handler",
    reachedBy: "busy: true",
    simulator: null,
  },
  {
    capability: "collation",
    file: "src/hooks.ts",
    message: "does not export sqlite3_collation_needed",
    reachedBy: "collation: true",
    simulator: null,
  },
  {
    capability: "progress",
    file: "src/hooks.ts",
    message: "does not export sqlite3_progress_handler",
    reachedBy: "progress: n",
    simulator: null,
  },
  {
    capability: "preupdate",
    file: "src/backend_ffi.ts",
    message: 'preupdate: "required" was asked for, but ',
    reachedBy: 'preupdate: "required"',
    simulator: 'preupdate: "off"',
  },
];

/**
 * The recorded state of every branch, so `--check` fails on DRIFT in either
 * direction: a branch that stops being exercised, and one that starts being
 * exercised without this table being updated to say so. Six of seven are
 * `none` today and that is the finding, not a temporary embarrassment to be
 * hidden behind a passing gate.
 */
const EXPECTED: ReadonlyMap<string, State> = new Map([
  ["trace", "none"],
  ["normalizedSql", "absent"],
  ["authorize", "none"],
  ["busy", "none"],
  ["collation", "none"],
  ["progress", "none"],
  ["preupdate", "none"],
]);

/** What the controls must produce, or the report is not reportable. */
const CONTROLS: ReadonlyMap<string, State> = new Map([
  ["normalizedSql", "absent"],
  ["progress", "none"],
]);

/**
 * How many rows this library cannot check, per SQLite version.
 *
 * A row is "not exercisable" when the state {@linkcode EXPECTED} records for it
 * cannot be produced on the library in hand — today only `absent`, which needs
 * a library that genuinely lacks the symbol. Such a row is reported and not
 * counted as drift, which is right, and which is exactly why the COUNT has to
 * be pinned: "not exercisable here" reads like a footnote on one row and reads
 * like a footnote on six, and six is the state where this audit has stopped
 * checking anything it recorded and still exits 0. A quiet per-row degradation
 * needs a loud aggregate, or the loud failure it replaced was simply deleted.
 *
 * Pinned per SQLite VERSION rather than globally, because the number is a fact
 * about the library and genuinely differs between the two here (MEASURED
 * 2026-09-09: system 3.45.1 has none, vendored 3.53.4 has one — normalizedSql).
 * A single global number would have to be the larger, and would then accept the
 * degraded case everywhere.
 *
 * Version, not path: paths differ per machine and per CI runner, and a pin
 * keyed on one would either fail everywhere or be loosened until it could not
 * fail at all. Deriving the number from the capabilities instead would be
 * circular — it would move silently with the very thing it is meant to catch.
 *
 * A library not listed here must have ZERO. That is the conservative
 * direction: an unrecorded library may not quietly stop checking things. Add
 * its measured number here when you introduce it, deliberately.
 */
const NOT_EXERCISABLE: ReadonlyMap<string, number> = new Map([
  ["3.45.1", 0],
  ["3.53.4", 1],
]);

/** The version string the library reports. Read through FFI, not through SQL. */
function libVersion(path: string): string {
  const lib = Deno.dlopen(path, {
    sqlite3_libversion: { parameters: [], result: "pointer" },
  });
  try {
    const ptr = lib.symbols.sqlite3_libversion();
    if (ptr === null) {
      throw new Error(`${path}: sqlite3_libversion returned NULL`);
    }
    return new Deno.UnsafePointerView(ptr).getCString();
  } finally {
    lib.close();
  }
}

type State = "absent" | "simulated" | "none" | "unclassifiable";

interface Row {
  branch: Branch;
  state: State;
  /** Why the state is what it is, in one clause. */
  because: string;
}

/**
 * Rewrite the `if (...)` guarding `message` so the branch can never be taken.
 *
 * Anchors on the message rather than a line number, then walks BACKWARDS to
 * the nearest line opening an `if`. Returns null when either cannot be found,
 * which is reported as `unclassifiable` rather than quietly skipped.
 */
function disableBranch(source: string, message: string): string | null {
  const lines = source.split("\n");
  const at = lines.findIndex((l) => l.includes(message));
  if (at === -1) return null;
  for (let i = at; i >= 0 && i > at - 12; i--) {
    const line = lines[i];
    if (line === undefined) continue;
    // Only a single-line `if (...) {` is rewritten. A condition spanning
    // several lines would need the whole span replaced, and half-replacing it
    // yields source that does not compile — which would read as "the suite
    // failed, so the branch is covered". Refuse instead, and let the branch
    // come out `unclassifiable`.
    const m = /^(\s*)if \(.*\) \{$/.exec(line);
    if (m === null) continue;
    lines[i] = `${m[1] ?? ""}if (false) {`;
    return lines.join("\n");
  }
  return null;
}

/** Does `path` still type-check? A mutation that breaks the build proves nothing. */
async function typeChecks(path: string): Promise<boolean> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["check", path],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  });
  const { code } = await cmd.output();
  return code === 0;
}

/** Run the semantic suite. True when it passes. */
async function suitePasses(libPath: string): Promise<boolean> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--unstable-ffi",
      "--allow-ffi",
      "--allow-env",
      "--allow-read",
      "--allow-write",
      join(ROOT, "test", "suite.ts"),
      "semantic",
    ],
    cwd: ROOT,
    env: { DENO_SQLITE_PATH: libPath },
    stdout: "piped",
    stderr: "piped",
  });
  const { code } = await cmd.output();
  return code === 0;
}

/**
 * Everything the classifier is allowed to reason from, once a mutation has
 * been applied and the suite has been re-run.
 *
 * Deliberately four plain values rather than the branch, the capabilities and
 * a library path: the DECISION does not depend on which branch this is or what
 * is on disk, and stating that as a type is what makes it drivable by inputs
 * no machine here can produce — a `simulated` verdict among them, which no
 * library reachable from this repository can currently elicit.
 */
interface Evidence {
  /** Did the mutated source still type-check? */
  readonly compiles: boolean;
  /** Did the semantic suite still pass with the refusal removed? */
  readonly passed: boolean;
  /** Does the library the suite ran against actually have the capability? */
  readonly hasCapability: boolean;
  /** An option that fakes the absence, or null when none exists. */
  readonly simulator: string | null;
}

/**
 * The classifier's decision, and nothing else.
 *
 * ## What this covers, and what it does not
 *
 * This is the judgement — four states out of four evidence values. It is NOT
 * the mutate-and-re-run machinery that produces the evidence: rewriting the
 * `if`, type-checking the result and re-running the suite are still exercised
 * only by running the real thing against a real library. Splitting the two
 * buys one thing, and it is worth saying plainly what: the `simulated` verdict
 * can now be seen to happen. It is a defined state that NOTHING in this
 * repository currently occupies — no library reachable here has a capability
 * whose absence an option can fake — so before this it was a branch reasoned
 * about and never observed.
 */
function decide(e: Evidence): { state: State; because: string } {
  // Checked before the suite result is believed, and in this order: a mutation
  // that does not COMPILE makes the suite fail for a reason that has nothing
  // to do with the branch, and that failure would read as "something reached
  // it". That is the dangerous direction — it invents coverage.
  if (!e.compiles) {
    return {
      state: "unclassifiable",
      because:
        "the mutated source does not type-check, so the suite result says nothing",
    };
  }
  if (e.passed) {
    return { state: "none", because: "removing the refusal broke no test" };
  }
  if (!e.hasCapability) {
    return {
      state: "absent",
      because: "the test library genuinely lacks the symbol",
    };
  }
  return {
    state: "simulated",
    because: e.simulator === null
      ? "the test library HAS the symbol, so absence was faked — by what is unclear"
      : `the test library HAS the symbol; reached via ${e.simulator}`,
  };
}

/**
 * Synthetic evidence covering all four states, plus the one distinction inside
 * `simulated` that a reader acts on.
 *
 * These run on every invocation, before the library is even looked at, because
 * they need nothing: no SQLite, no mutation, no suite. A decision function
 * nobody has watched produce each of its four answers is a decision function
 * whose answers are asserted rather than known.
 */
const DECISION_FIXTURES: readonly {
  readonly name: string;
  readonly evidence: Evidence;
  readonly state: State;
  readonly because?: string;
}[] = [
  {
    name: "a mutation that does not compile decides nothing",
    evidence: {
      compiles: false,
      passed: false,
      hasCapability: false,
      simulator: null,
    },
    state: "unclassifiable",
  },
  {
    name: "compiling but the suite still passes: nothing reached the refusal",
    evidence: {
      compiles: true,
      passed: true,
      hasCapability: false,
      simulator: null,
    },
    state: "none",
  },
  {
    name: "a passing suite outranks the capability: still `none`, not `absent`",
    evidence: {
      compiles: true,
      passed: true,
      hasCapability: true,
      simulator: 'preupdate: "off"',
    },
    state: "none",
  },
  {
    name: "the suite fails and the library lacks the symbol: real absence",
    evidence: {
      compiles: true,
      passed: false,
      hasCapability: false,
      simulator: null,
    },
    state: "absent",
  },
  {
    name: "the suite fails but the library HAS the symbol: only simulated",
    evidence: {
      compiles: true,
      passed: false,
      hasCapability: true,
      simulator: 'preupdate: "off"',
    },
    state: "simulated",
    because: 'reached via preupdate: "off"',
  },
  {
    name: "simulated with no known simulator says so rather than naming one",
    evidence: {
      compiles: true,
      passed: false,
      hasCapability: true,
      simulator: null,
    },
    state: "simulated",
    because: "by what is unclear",
  },
];

/**
 * Run the fixtures. True when every one held.
 *
 * Failure withholds the whole report for the same reason a failed control
 * does: a decision function that gets a synthetic case wrong got the real
 * rows wrong by the same means.
 */
function decisionControlsHold(): boolean {
  let bad = 0;
  for (const f of DECISION_FIXTURES) {
    const got = decide(f.evidence);
    const wrongState = got.state !== f.state;
    const wrongWhy = f.because !== undefined &&
      !got.because.includes(f.because);
    if (wrongState || wrongWhy) {
      bad++;
      console.error(
        `  decision fixture "${f.name}": expected ${f.state}${
          f.because === undefined ? "" : ` (${f.because})`
        }, got ${got.state} (${got.because})`,
      );
    } else {
      console.log(`  pass  decision: ${f.name}`);
    }
  }
  return bad === 0;
}

const CANARY = join(ROOT, "tools", "canary_branch.ts");
const CANARY_MESSAGE = "CANARY: the guarded branch was taken";

/** Run a script with no permissions. True when it exits 0. */
async function scriptPasses(path: string): Promise<boolean> {
  const { code } = await new Deno.Command(Deno.execPath(), {
    args: ["run", path],
    cwd: ROOT,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return code === 0;
}

/**
 * The pipeline control: rewrite-type-check-rerun, over a fixture branch that
 * belongs to no library.
 *
 * The audit reads a suite failure as "something reached the refusal". That
 * inference has three moving parts — the rewriter found an `if`, the rewritten
 * source still compiles, and disabling the branch actually changed behaviour —
 * and until now the only evidence all three worked was one library's missing
 * SQLITE_ENABLE_NORMALIZE. That made a genuine measurement of one capability
 * load-bearing for every other row, and made a normalize-enabled library a
 * reason to refuse to run rather than a row to qualify.
 *
 * Here the same three parts are watched over {@linkcode canary_branch}, whose
 * self-test passes intact and must fail disabled. It is milliseconds, so it
 * runs every invocation. It does NOT stand in for the semantic suite: it says
 * the rewrite works, not that the suite would have noticed.
 */
async function pipelineControlHolds(): Promise<boolean> {
  const original = await Deno.readTextFile(CANARY);

  // Control on the control: intact, the fixture must PASS. A fixture that
  // fails either way proves nothing about the rewrite.
  if (!await scriptPasses(CANARY)) {
    console.error(
      "  pipeline: the canary fails even INTACT; it is not a fixture",
    );
    return false;
  }
  console.log("  pass  pipeline: the canary passes intact");

  const mutated = disableBranch(original, CANARY_MESSAGE);
  if (mutated === null || mutated === original) {
    console.error(
      `  pipeline: the rewriter ${
        mutated === null
          ? "found no `if` guarding the canary"
          : "changed nothing"
      } — every \`none\` below would be this failure, not a finding`,
    );
    return false;
  }
  console.log("  pass  pipeline: the rewriter located and disabled the canary");

  let compiles: boolean;
  let stillPasses: boolean;
  try {
    await Deno.writeTextFile(CANARY, mutated);
    compiles = await typeChecks(CANARY);
    stillPasses = compiles ? await scriptPasses(CANARY) : true;
  } finally {
    await Deno.writeTextFile(CANARY, original);
  }

  const restored = await Deno.readTextFile(CANARY);
  if (restored !== original) {
    console.error("  pipeline: the fixture was not restored byte-for-byte");
    return false;
  }
  console.log("  pass  pipeline: the fixture was restored byte-for-byte");

  if (!compiles) {
    console.error(
      "  pipeline: the rewritten canary does not type-check, so a real branch's rewrite would be read as coverage it did not earn",
    );
    return false;
  }
  console.log("  pass  pipeline: the rewritten source still type-checks");

  if (stillPasses) {
    console.error(
      "  pipeline: disabling the canary changed nothing observable — the rewrite is cosmetic and every `none` below is unearned",
    );
    return false;
  }
  console.log("  pass  pipeline: disabling the canary made its self-test fail");

  const verdict = decide({
    compiles: true,
    passed: false,
    hasCapability: false,
    simulator: null,
  });
  if (verdict.state !== "absent") {
    console.error(
      `  pipeline: the same evidence a reached branch produces decided ${verdict.state}, not absent`,
    );
    return false;
  }
  console.log("  pass  pipeline: that evidence decides `absent` end to end");
  return true;
}

async function classify(
  branch: Branch,
  caps: Capabilities,
  libPath: string,
): Promise<Row> {
  const path = join(ROOT, branch.file);
  const original = await Deno.readTextFile(path);
  const mutated = disableBranch(original, branch.message);
  if (mutated === null) {
    return {
      branch,
      state: "unclassifiable",
      because: `no \`if\` found guarding the message ${
        branch.message.slice(0, 32)
      }...`,
    };
  }
  if (mutated === original) {
    return {
      branch,
      state: "unclassifiable",
      because: "the mutation changed nothing, so it proves nothing",
    };
  }
  let passed: boolean;
  let compiles: boolean;
  try {
    await Deno.writeTextFile(path, mutated);
    // A mutation that does not COMPILE makes the suite fail for a reason that
    // has nothing to do with the branch, and that failure would be read as
    // "something reached it". That is the dangerous direction -- it invents
    // coverage -- so it is checked before the suite result is believed.
    compiles = await typeChecks(path);
    passed = compiles ? await suitePasses(libPath) : true;
  } finally {
    await Deno.writeTextFile(path, original);
  }
  // The same function the fixtures above drive. Not a copy of it: a copy
  // would let the fixtures go on passing after the real path diverged.
  const { state, because } = decide({
    compiles,
    passed,
    hasCapability: caps[branch.capability] === true,
    simulator: branch.simulator,
  });
  return { branch, state, because };
}

/**
 * What the pinned not-exercisable count says about a run.
 *
 * Split out and returned as data rather than printed where it is computed,
 * because the four cases mean four different things and the sentence a human
 * reads at 2am is the deliverable, not the exit status. The fixtures below
 * assert the TEXT. A control that watches the alarm sound without listening to
 * what it says leaves the whole operator-facing half unverified — which is how
 * a message naming the wrong direction, and prescribing the remedy for a
 * different table, sat behind four passing controls.
 */
type CountVerdict =
  | { readonly kind: "agrees" }
  | { readonly kind: "unpinned"; readonly text: string }
  | { readonly kind: "above"; readonly text: string }
  | { readonly kind: "below"; readonly text: string };

function countVerdict(
  version: string,
  pinned: number | undefined,
  measured: number,
): CountVerdict {
  if (pinned === undefined) {
    if (measured === 0) return { kind: "agrees" };
    return {
      kind: "unpinned",
      text:
        `SQLite ${version} is not in NOT_EXERCISABLE, and an unrecorded library must check everything it records — ${measured} ${
          measured === 1 ? "row is" : "rows are"
        } not exercisable on it. Measure the number and add ["${version}", ${measured}] to NOT_EXERCISABLE deliberately, once you know which rows and why.`,
    };
  }
  if (measured === pinned) return { kind: "agrees" };
  if (measured > pinned) {
    return {
      kind: "above",
      text:
        `SQLite ${version}: NOT_EXERCISABLE pins ${pinned} not-exercisable rows, this run measured ${measured} — MORE than recorded. Rows this library used to exercise are no longer exercised by anything, and without the count that would have been a per-row note under an exit 0. Find out which rows and why BEFORE raising the pin.`,
    };
  }
  return {
    kind: "below",
    text:
      `SQLite ${version}: NOT_EXERCISABLE pins ${pinned} not-exercisable rows, this run measured ${measured} — FEWER than recorded. This is the good direction or a pin that was never true here: something that could not be exercised on this library now can. Confirm which, then lower the NOT_EXERCISABLE entry to ${measured}.`,
  };
}

/**
 * The remedy for one branch whose measured state is not the recorded one.
 *
 * Carried per line rather than printed once beneath the list, because the
 * entries fire for opposite reasons and one blanket instruction is wrong for
 * half of its readers.
 */
function expectedRemedy(want: State, measured: State): string {
  if (want === "none") {
    return `newly exercised, which is good news — record it by setting this branch in EXPECTED to ${measured}`;
  }
  if (measured === "none") {
    return "it STOPPED being exercised — find out what stopped reaching it before recording the new state";
  }
  return "the state changed without the branch becoming unexercised — establish which evidence moved before recording it";
}

const COUNT_MESSAGE_FIXTURES: readonly {
  readonly name: string;
  readonly pinned: number | undefined;
  readonly measured: number;
  readonly kind: CountVerdict["kind"];
  readonly must: readonly string[];
}[] = [
  {
    name: "a pin the run agrees with is not drift",
    pinned: 1,
    measured: 1,
    kind: "agrees",
    must: [],
  },
  {
    name: "an unlisted library that still checks everything is not drift",
    pinned: undefined,
    measured: 0,
    kind: "agrees",
    must: [],
  },
  {
    name: "more rows than pinned is named as MORE and sent to the right table",
    pinned: 0,
    measured: 1,
    kind: "above",
    must: ["MORE than recorded", "NOT_EXERCISABLE"],
  },
  {
    name: "fewer rows than pinned is named as FEWER and not as decay",
    pinned: 1,
    measured: 0,
    kind: "below",
    must: [
      "FEWER than recorded",
      "good direction",
      "lower the NOT_EXERCISABLE",
    ],
  },
  {
    name: "an unlisted library that stopped checking asks for a measurement",
    pinned: undefined,
    measured: 2,
    kind: "unpinned",
    must: ["not in NOT_EXERCISABLE", "Measure the number"],
  },
];

const REMEDY_FIXTURES: readonly {
  readonly name: string;
  readonly want: State;
  readonly measured: State;
  readonly must: string;
}[] = [
  {
    name: "a branch that became exercised is told to update EXPECTED",
    want: "none",
    measured: "absent",
    must: "EXPECTED",
  },
  {
    name: "a branch that stopped being exercised is told to find out why first",
    want: "absent",
    measured: "none",
    must: "STOPPED",
  },
  {
    name: "a state that moved sideways is not called either of those",
    want: "absent",
    measured: "simulated",
    must: "without the branch becoming unexercised",
  },
];

/**
 * Assert what the drift messages SAY, not merely that drift was detected.
 *
 * The count messages must never mention EXPECTED and the per-branch remedies
 * must never mention NOT_EXERCISABLE: those are two separate pins, and a
 * reader sent to the wrong one edits a table that cannot affect the line they
 * are reading, watches nothing improve, and concludes the tooling is noisy.
 */
function driftMessagesHold(): boolean {
  let ok = true;
  const say = (good: boolean, what: string, detail = "") => {
    if (good) {
      console.log(`  pass  ${what}`);
    } else {
      ok = false;
      console.error(`  FAIL  ${what}${detail === "" ? "" : ` — ${detail}`}`);
    }
  };
  for (const f of COUNT_MESSAGE_FIXTURES) {
    const v = countVerdict("9.9.9", f.pinned, f.measured);
    if (v.kind !== f.kind) {
      say(false, `message: ${f.name}`, `kind was ${v.kind}, wanted ${f.kind}`);
      continue;
    }
    if (v.kind === "agrees") {
      say(true, `message: ${f.name}`);
      continue;
    }
    const missing = f.must.filter((m) => !v.text.includes(m));
    if (missing.length > 0) {
      say(false, `message: ${f.name}`, `never said ${missing.join(", ")}`);
    } else if (v.text.includes("EXPECTED")) {
      say(
        false,
        `message: ${f.name}`,
        "sent the reader to EXPECTED, which no count drift is fixed by",
      );
    } else {
      say(true, `message: ${f.name}`);
    }
  }
  for (const f of REMEDY_FIXTURES) {
    const text = expectedRemedy(f.want, f.measured);
    if (!text.includes(f.must)) {
      say(false, `message: ${f.name}`, `said instead: ${text}`);
    } else if (text.includes("NOT_EXERCISABLE")) {
      say(
        false,
        `message: ${f.name}`,
        "sent the reader to NOT_EXERCISABLE, which no state drift is fixed by",
      );
    } else {
      say(true, `message: ${f.name}`);
    }
  }
  return ok;
}

const LABEL: Record<State, string> = {
  absent: "yes, against real absence",
  simulated: "ONLY SIMULATED",
  none: "NO",
  unclassifiable: "UNCLASSIFIABLE",
};

async function main(): Promise<void> {
  // First, and needing nothing: the decision function must give each of its
  // four answers on inputs whose right answer is known. If it cannot, no row
  // it produces below is worth reading.
  console.log("drift message controls");
  if (!driftMessagesHold()) {
    console.error(
      "\nThe report is withheld: a drift message names the wrong direction or the wrong pin. The exit code is not the deliverable — the sentence a human acts on is, and this one would send them to a table that cannot affect what they are reading.",
    );
    leave(1);
  }
  console.log("");

  console.log("classifier decision controls");
  if (!decisionControlsHold()) {
    console.error(
      "\nThe report is withheld: the classifier decided a synthetic case wrongly, and every real row would come out of the same decision.",
    );
    leave(1);
  }
  console.log("");

  // Second, and needing no library either: the rewrite-type-check-rerun
  // pipeline, watched over a fixture branch. Before this, the only evidence
  // the pipeline worked was one library's missing SQLITE_ENABLE_NORMALIZE.
  console.log("classifier pipeline control");
  if (!await pipelineControlHolds()) {
    console.error(
      "\nThe report is withheld: the mutate-and-re-run pipeline did not do what every row below assumes it did.",
    );
    leave(1);
  }
  console.log("");

  const libPath = Deno.env.get("DENO_SQLITE_PATH");
  if (libPath === undefined || libPath === "") {
    console.error(
      "DENO_SQLITE_PATH must be set to the libsqlite3 the suite runs against.",
    );
    leave(2);
  }
  const caps = probeCapabilities(libPath);

  // This used to refuse outright: `normalizedSql` was the only positive
  // control, so a library built WITH SQLITE_ENABLE_NORMALIZE took the control
  // away and the audit exited 2 rather than report rows produced by machinery
  // nothing had vouched for. That refusal was right while it was the only
  // control. It is not right any more: the decision fixtures and the pipeline
  // control above vouch for the machinery without any library at all, so what
  // a normalize-enabled library takes away is not the audit's trustworthiness
  // but one ROW's reachability — and that is a per-row fact, reportable as
  // itself. Refusing to run would now suppress six honest rows to avoid
  // qualifying one.
  //
  // `absent` means the library genuinely lacks the symbol, so a library that
  // HAS it cannot produce that state for that branch, whatever the code does.
  // Recognised here, before anything is mutated, rather than discovered as
  // drift afterwards.
  const canBeAbsent = (branch: Branch): boolean =>
    caps[branch.capability] !== true;

  // Before mutating anything: the suite must PASS unmutated. Otherwise every
  // row below would read "reached" for a reason that has nothing to do with
  // the branch.
  if (!await suitePasses(libPath)) {
    console.error(
      "the suite fails before any mutation; nothing measured here would mean anything",
    );
    leave(2);
  }

  const rows: Row[] = [];
  for (const branch of BRANCHES) {
    rows.push(await classify(branch, caps, libPath));
  }

  if (rows.length === 0) {
    console.error(
      "classified ZERO branches. A table of no rows reads as 'nothing uncovered', so this is a failure, not a clean report.",
    );
    leave(2);
  }

  // The controls, before anything else is trusted.
  const failures: string[] = [];
  let applicable = 0;
  /** Applicable controls that can fail on something other than a `none`. */
  let positive = 0;
  for (const [capability, expected] of CONTROLS) {
    const row = rows.find((r) => r.branch.capability === capability);
    if (row === undefined) {
      failures.push(`control ${capability}: no row produced for it at all`);
      continue;
    }
    if (expected === "absent" && !canBeAbsent(row.branch)) {
      console.log(
        `  control ${capability}: not exercisable on ${libPath}, which HAS the capability — skipped, not passed`,
      );
      continue;
    }
    applicable++;
    if (expected !== "none") positive++;
    if (row.state !== expected) {
      failures.push(
        `control ${capability}: expected ${expected}, got ${row.state} (${row.because})`,
      );
    }
  }
  if (failures.length === 0 && positive === 0) {
    // THE WEAK-CONTROL CASE, and it must be readable from the output and not
    // only from the project record. Every applicable library-dependent control
    // here expects `none` — it passes when removing a refusal breaks nothing —
    // so a pipeline that classified EVERY branch `none` would satisfy the lot.
    // What makes that tolerable is entirely the synthetic decision fixtures and
    // the canary above: they are the half that can fail when the pipeline is
    // broken. Anyone trimming a "redundant" fixture is removing the
    // load-bearing half, and this line is where they are told so.
    console.log(
      `  WEAK CONTROLS: ${
        applicable === 0
          ? "no library-dependent control was exercisable here"
          : "every applicable library-dependent control expects `none`"
      } — a pipeline that classified every branch \`none\` would pass them. The rows below rest on the synthetic decision fixtures and the canary; do not trim those as redundant.`,
    );
  }
  if (failures.length > 0) {
    console.error("the classifier's controls did not hold:\n");
    for (const f of failures) console.error(`  ${f}`);
    console.error(
      "\nThe report is withheld: a wrong control means every other row came out of the same broken machinery. Fix the classifier, do not adjust the expectation.",
    );
    leave(1);
  }

  const width = Math.max(...rows.map((r) => r.branch.capability.length));
  console.log(`library : ${libPath}`);
  console.log("");
  console.log(
    `${"capability".padEnd(width)} | refusal exercised?       | why`,
  );
  console.log(
    `${"-".repeat(width)} | ------------------------ | ---`,
  );
  for (const row of rows) {
    console.log(
      `${row.branch.capability.padEnd(width)} | ${
        LABEL[row.state].padEnd(24)
      } | ${row.because}`,
    );
  }
  console.log("");
  const covered = rows.filter((r) => r.state === "absent");
  console.log(
    `${rows.length} refusal branches; ${covered.length} exercised against a library that genuinely lacks the capability.`,
  );
  // The aggregate behind the per-row "not exercisable" notes below. Printed
  // whether or not --check is passed, because a reader of a plain run needs it
  // as much as CI does.
  const version = libVersion(libPath);
  const unmeasured = rows.filter((r) =>
    EXPECTED.get(r.branch.capability) === "absent" && !canBeAbsent(r.branch)
  );
  console.log(
    `${unmeasured.length} of ${rows.length} rows are NOT EXERCISABLE on SQLite ${version}${
      unmeasured.length === 0
        ? ""
        : ` (${
          unmeasured.map((r) => r.branch.capability).join(", ")
        }): this library can produce neither the state recorded for them nor any evidence against it`
    }.`,
  );
  if (!rows.some((r) => r.state === "simulated")) {
    // Worth saying out loud rather than leaving as an absent row: `simulated`
    // is a defined state that nothing here occupies. It is not that simulation
    // was ruled out — it is that no library reachable from this repository has
    // a capability whose absence one of our options can fake, so the state has
    // never been produced by a measurement. The fixtures above are the only
    // place it is seen at all.
    console.log(
      "No branch classified ONLY SIMULATED. That state is defined and currently occupied by nothing measured here; the decision controls above are where it is exercised.",
    );
  }
  if (!Deno.args.includes("--check")) return;

  // Two pins, two drifts, two reports. They are kept apart on purpose: the
  // advice for one is the wrong advice for the other, and the only way that
  // cannot drift back together is for neither block to be able to reach the
  // other's closing sentence.
  const count = countVerdict(
    version,
    NOT_EXERCISABLE.get(version),
    unmeasured.length,
  );
  const stateDrift: string[] = [];

  for (const row of rows) {
    const want = EXPECTED.get(row.branch.capability);
    if (want === undefined) {
      stateDrift.push(
        `${row.branch.capability}: not in EXPECTED at all — add it with the state this run measured, ${row.state}`,
      );
    } else if (want === "absent" && !canBeAbsent(row.branch)) {
      console.log(
        `${row.branch.capability}: EXPECTED says absent, but ${libPath} HAS the capability, so absence is not exercisable here — measured ${row.state}, not counted as drift`,
      );
    } else if (want !== row.state) {
      stateDrift.push(
        `${row.branch.capability}: EXPECTED says ${want}, measured ${row.state} — ${
          expectedRemedy(want, row.state)
        }`,
      );
    }
  }
  for (const capability of EXPECTED.keys()) {
    if (!rows.some((r) => r.branch.capability === capability)) {
      stateDrift.push(
        `${capability}: in EXPECTED but no branch was measured for it — either the branch was deleted, in which case drop the EXPECTED entry, or it was not found, which is a bug in BRANCHES`,
      );
    }
  }

  let failing = false;
  if (count.kind !== "agrees") {
    failing = true;
    console.error(
      "\nthe not-exercisable COUNT drifted from NOT_EXERCISABLE:\n",
    );
    console.error(`  ${count.text}`);
    console.error(
      "\nNOT_EXERCISABLE is the pin to attend to for the line above. EXPECTED records which STATE each branch is in and is not involved here: editing it will not change this line.",
    );
  }
  if (stateDrift.length > 0) {
    failing = true;
    console.error("\ncoverage drifted from the states EXPECTED records:\n");
    for (const d of stateDrift) console.error(`  ${d}`);
    console.error(
      "\nEXPECTED is the pin to attend to for the lines above, and each carries its own remedy: they fire for opposite reasons, and one instruction for all of them is wrong for half of its readers.",
    );
  }
  if (failing) leave(1);
  console.log("every branch is in the state EXPECTED records — OK");
}

/**
 * Did this run leave a file in `src/` mutated?
 *
 * The audit rewrites a refusal to `false` in the real `src/` file, re-runs the
 * suite and restores it. When that restore does not happen, the library is
 * left on disk with a live `if (false)` where a refusal should be — and
 * MEASURED here on both libraries, six of the seven refusal branches are in
 * state `none`, which is precisely the statement that removing them breaks no
 * test. So `deno task check` passes and the whole suite passes with the
 * mutation still in place. Nothing downstream catches it. The only thing that
 * did catch it once was a human staging explicit paths instead of everything,
 * and that is discipline rather than a mechanism.
 *
 * It compares the CONTENT of `git diff -- src/`, taken before the run and
 * again at every exit, not `git status`. Two reasons. A developer who was
 * already mid-edit in `src/` must not be shouted at for their own work — only
 * a CHANGE between the two snapshots is this run's doing. And `git status`
 * reports a file as modified purely because its mtime moved, even when the
 * bytes are identical (observed after a `git checkout --` on a neighbouring
 * file), so a status-based guard would cry wolf on a file this tool never
 * wrote to.
 *
 * A guard that quietly does nothing when it cannot run is worse than none, so
 * a `git` that fails to execute is itself reported and fails the run.
 */
function srcDiff(): string {
  try {
    const out = new Deno.Command("git", {
      args: ["diff", "--", "src/"],
      cwd: ROOT,
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    if (out.code !== 0) {
      return `GUARD-UNAVAILABLE: git diff exited ${out.code}: ${
        new TextDecoder().decode(out.stderr).trim().slice(-300)
      }`;
    }
    return new TextDecoder().decode(out.stdout);
  } catch (e) {
    return `GUARD-UNAVAILABLE: git could not be run: ${String(e)}`;
  }
}

/** `src/` as it stood before this run touched anything. */
let srcBefore: string | null = null;

/** Set once the guard has actually been consulted, for the backstop below. */
let guardRan = false;

/**
 * Compare `src/` against the snapshot and complain if this run moved it.
 *
 * Returns the exit code to leave with: 3 when the guard fires, so it is
 * distinguishable from the audit's own 1 (drift) and 2 (cannot run).
 */
function guardSources(intended: number): number {
  guardRan = true;
  const after = srcDiff();
  if (srcBefore === null) {
    console.error(
      "\nGUARD: no `src/` snapshot was taken before this run, so whether it left the library mutated is unknown. Treating that as a failure rather than a pass.",
    );
    return 3;
  }
  if (
    after.startsWith("GUARD-UNAVAILABLE:") ||
    srcBefore.startsWith("GUARD-UNAVAILABLE:")
  ) {
    console.error(
      `\nGUARD: could not check whether this run left \`src/\` mutated. ${
        after.startsWith("GUARD-UNAVAILABLE:") ? after : srcBefore
      }`,
    );
    return 3;
  }
  if (after === srcBefore) return intended;
  console.error(
    "\nGUARD: this run CHANGED `src/` and did not put it back. The audit mutates a refusal to `false` in the real source and restores it afterwards; a leftover mutation type-checks and passes the whole suite, because six of the seven refusals are exercised by nothing. Restore it before committing:\n\n  git diff -- src/\n  git checkout -- src/\n",
  );
  return 3;
}

/** Every deliberate exit goes through here so none of them skips the guard. */
function leave(code: number): never {
  Deno.exit(guardSources(code));
}

if (import.meta.main) {
  srcBefore = srcDiff();
  // Backstop for an exit path added later that forgets `leave`: `unload` fires
  // on a normal exit, on `Deno.exit` and on an uncaught throw. It cannot change
  // the exit code, which is why it is a backstop and not the mechanism.
  addEventListener("unload", () => {
    if (!guardRan) {
      console.error(
        "\nGUARD DID NOT RUN: this run exited by a path that skips the `src/` check, so whether it left the library mutated was never established. Route that exit through `leave`.",
      );
    }
  });
  try {
    await main();
  } catch (e) {
    const code = guardSources(0);
    if (code === 0) throw e;
    // An uncaught throw forces exit code 1 and `Deno.exitCode` cannot override
    // it, so rethrowing here would print the guard and then report the ordinary
    // failure code. Print the error ourselves and leave with the guard's 3: a
    // run that crashed AND left the library mutated must not be told apart from
    // one that merely crashed.
    console.error(e instanceof Error ? e.stack ?? e.message : String(e));
    Deno.exit(code);
  }
  const code = guardSources(0);
  if (code !== 0) Deno.exitCode = code;
}
