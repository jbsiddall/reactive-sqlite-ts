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
      "--allow-net",
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
  if (!compiles) {
    return {
      branch,
      state: "unclassifiable",
      because:
        "the mutated source does not type-check, so the suite result says nothing",
    };
  }
  if (passed) {
    return {
      branch,
      state: "none",
      because: "removing the refusal broke no test",
    };
  }
  const has = caps[branch.capability] === true;
  if (!has) {
    return {
      branch,
      state: "absent",
      because: "the test library genuinely lacks the symbol",
    };
  }
  return {
    branch,
    state: "simulated",
    because: branch.simulator === null
      ? "the test library HAS the symbol, so absence was faked — by what is unclear"
      : `the test library HAS the symbol; reached via ${branch.simulator}`,
  };
}

const LABEL: Record<State, string> = {
  absent: "yes, against real absence",
  simulated: "ONLY SIMULATED",
  none: "NO",
  unclassifiable: "UNCLASSIFIABLE",
};

async function main(): Promise<void> {
  const libPath = Deno.env.get("DENO_SQLITE_PATH");
  if (libPath === undefined || libPath === "") {
    console.error(
      "DENO_SQLITE_PATH must be set to the libsqlite3 the suite runs against.",
    );
    Deno.exit(2);
  }
  const caps = probeCapabilities(libPath);

  // The controls below are pinned to a library that LACKS
  // SQLITE_ENABLE_NORMALIZE, because that absence is the only one reachable
  // here and so the only positive control available. Pointed at a library
  // that has it, the classifier would report `normalizedSql` uncovered and
  // that would be a true measurement of the wrong thing — indistinguishable,
  // at a glance, from the classifier being broken. Refuse up front and say
  // which it is, rather than let the control failure below misdirect the
  // reader into fixing a tool that is working.
  if (caps.normalizedSql) {
    console.error(
      `${libPath} was built with SQLITE_ENABLE_NORMALIZE. This audit needs a library WITHOUT it — that absence is its positive control, and no other absence is reachable here. Point DENO_SQLITE_PATH at the system library and re-run.`,
    );
    Deno.exit(2);
  }

  // Before mutating anything: the suite must PASS unmutated. Otherwise every
  // row below would read "reached" for a reason that has nothing to do with
  // the branch.
  if (!await suitePasses(libPath)) {
    console.error(
      "the suite fails before any mutation; nothing measured here would mean anything",
    );
    Deno.exit(2);
  }

  const rows: Row[] = [];
  for (const branch of BRANCHES) {
    rows.push(await classify(branch, caps, libPath));
  }

  if (rows.length === 0) {
    console.error(
      "classified ZERO branches. A table of no rows reads as 'nothing uncovered', so this is a failure, not a clean report.",
    );
    Deno.exit(2);
  }

  // The controls, before anything else is trusted.
  const failures: string[] = [];
  for (const [capability, expected] of CONTROLS) {
    const row = rows.find((r) => r.branch.capability === capability);
    if (row === undefined) {
      failures.push(`control ${capability}: no row produced for it at all`);
      continue;
    }
    if (row.state !== expected) {
      failures.push(
        `control ${capability}: expected ${expected}, got ${row.state} (${row.because})`,
      );
    }
  }
  if (failures.length > 0) {
    console.error("the classifier's controls did not hold:\n");
    for (const f of failures) console.error(`  ${f}`);
    console.error(
      "\nThe report is withheld: a wrong control means every other row came out of the same broken machinery. Fix the classifier, do not adjust the expectation.",
    );
    Deno.exit(1);
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
  if (!Deno.args.includes("--check")) return;
  const drift: string[] = [];
  for (const row of rows) {
    const want = EXPECTED.get(row.branch.capability);
    if (want === undefined) {
      drift.push(`${row.branch.capability}: not in EXPECTED at all`);
    } else if (want !== row.state) {
      drift.push(
        `${row.branch.capability}: EXPECTED says ${want}, measured ${row.state}`,
      );
    }
  }
  for (const capability of EXPECTED.keys()) {
    if (!rows.some((r) => r.branch.capability === capability)) {
      drift.push(
        `${capability}: in EXPECTED but no branch was measured for it`,
      );
    }
  }
  if (drift.length > 0) {
    console.error("\ncoverage drifted from what is recorded:\n");
    for (const d of drift) console.error(`  ${d}`);
    console.error(
      "\nIf a branch is newly exercised that is good news -- update EXPECTED to record it. If one stopped being exercised, find out why.",
    );
    Deno.exit(1);
  }
  console.log("every branch is in the state EXPECTED records — OK");
}

if (import.meta.main) await main();
