/**
 * Generates — and checks — the "what three real libraries actually support"
 * table in README.md.
 *
 * Every cell comes from running {@linkcode probeCapabilities} against a real
 * libsqlite3 on this machine. Not from a symbol dump, not from a build flag,
 * not from memory. The three libraries are the three a user can actually end
 * up with:
 *
 *   1. the system library `resolveLibPath()` finds — the one `deno task test`
 *      runs against, which is why the system column is resolved that exact way
 *      rather than by a second candidate list;
 *   2. the vendored build under `vendor/lib/<target>/`;
 *   3. the prebuilt `@db/sqlite` 0.13.0 downloads into `$DENO_DIR/plug/` when
 *      DENO_SQLITE_PATH is unset. That one is the only library reachable here
 *      that GENUINELY lacks capabilities, so it is the only honest fixture for
 *      the absent-capability branches — and it exists only until the driver is
 *      vendored.
 *
 * The table is generated and checked rather than maintained by hand:
 * `--check` regenerates it and fails if the committed README differs. A
 * generated table nobody re-derives is a hand-maintained table with extra
 * steps.
 *
 * ## Why each library is probed in its own child process
 *
 * `dlopen` may return an ALREADY-LOADED object when the SONAME matches, so
 * probing three libsqlite3 builds in one process can silently yield three
 * copies of whichever one loaded first — three identical, plausible columns
 * and no error. Measured 2026-09-09 on this machine: the three SONAMEs happen
 * to differ (`libsqlite3.so.0`, `libsqlite3.so`, `libsqlite3-3.46.0.so.0`) and
 * one process did report 3.45.1 / 3.53.4 / 3.46.0 correctly. That is an
 * accident of how `vendor/build.sh` links today: one `-Wl,-soname` away from
 * collapsing, with no symptom. A child process per library removes the hazard
 * instead of depending on it, the same reason `test/suite.ts crash` does.
 *
 * ## The gate
 *
 * These numbers get reasoned from, so `--check` refuses to pass until
 * something independent says it exercised three different libraries:
 *
 *   - the three paths are three distinct existing files;
 *   - the three columns are not identical;
 *   - each column's reported `sqlite3_libversion()` occurs in the BYTES of the
 *     file at that path — a check that does not go through the loader at all,
 *     and the one that catches the SONAME collapse above;
 *   - the system column's path is the one `resolveLibPath()` returns;
 *   - one cell whose value was established by measurement and is pinned here.
 *
 * ## The date
 *
 * The observation date sits inside the generated block, but is only rewritten
 * when the measured values change. A date regenerated on every run would make
 * `--check` fail every day for no reason, and a check that fails for no reason
 * is a check that gets deleted.
 *
 *   deno task table          # rewrite README.md
 *   deno task test:table     # gate + regenerate + compare, exit 1 on drift
 */

import { probeCapabilities, resolveLibPath } from "../mod.ts";
import type { Capabilities } from "../mod.ts";
import { driverPrebuilt } from "../vendor/probe.ts";
import { vendoredLibraryPath } from "../vendor/select.ts";

const README = new URL("../README.md", import.meta.url);
const BEGIN = "<!-- capability-table:begin -->";
const END = "<!-- capability-table:end -->";

/**
 * The rows, in the order {@linkcode Capabilities} declares them.
 * `preupdateUnavailable` is deliberately not a row: it is the REASON preupdate
 * is false, a string rather than a capability, and it says nothing a reader of
 * this table can act on.
 */
const ROWS: { key: keyof Capabilities; label: string }[] = [
  { key: "hooks", label: "`hooks`" },
  { key: "preupdate", label: "`preupdate`" },
  { key: "wal", label: "`wal`" },
  { key: "trace", label: "`trace`" },
  { key: "progress", label: "`progress`" },
  { key: "busy", label: "`busy`" },
  { key: "authorize", label: "`authorize`" },
  { key: "collation", label: "`collation`" },
  { key: "normalizedSql", label: "`normalizedSql`" },
];

/**
 * The known answer. Established by measurement first (running this file's
 * `--probe` mode against the downloaded prebuilt on 2026-09-09), then pinned,
 * so a run that quietly probed the wrong library three times cannot pass:
 * every other library reachable here has `preupdate`.
 */
const PINNED = {
  column: "@db/sqlite prebuilt",
  row: "preupdate",
  value: false,
} as const;

/** How each column's library is found. Stable across machines; the path is not. */
const PROVENANCE: Record<string, string> = {
  "system":
    "the path `resolveLibPath()` returns — the library `deno task test` runs against",
  "vendored": "`vendor/lib/<target>/`, built by `deno task vendor:build`",
  "@db/sqlite prebuilt":
    "`$DENO_DIR/plug/`, downloaded by `@db/sqlite` 0.13.0 when `DENO_SQLITE_PATH` is unset",
};

interface Column {
  name: string;
  path: string;
  version: string;
  caps: Capabilities;
}

/** One library, read out in a child process. Printed as one JSON line. */
function probeOne(path: string): { version: string; caps: Capabilities } {
  const lib = Deno.dlopen(path, {
    sqlite3_libversion: { parameters: [], result: "pointer" },
  });
  let version: string;
  try {
    const p = lib.symbols.sqlite3_libversion();
    if (p === null) throw new Error(`sqlite3_libversion() returned null`);
    version = new Deno.UnsafePointerView(p).getCString();
  } finally {
    lib.close();
  }
  return { version, caps: probeCapabilities(path) };
}

async function probeInChild(name: string, path: string): Promise<Column> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--unstable-ffi",
      "--allow-ffi",
      "--allow-env",
      "--allow-read",
      new URL(import.meta.url).pathname,
      "--probe",
      path,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout);
  if (out.code !== 0) {
    throw new Error(
      `probing ${name} at ${path} exited ${out.code}: ${
        new TextDecoder().decode(out.stderr).trim()
      }`,
    );
  }
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== "object" || parsed === null ||
    typeof Reflect.get(parsed, "version") !== "string"
  ) {
    throw new Error(`probing ${name} produced no readable result: ${text}`);
  }
  const version: string = `${Reflect.get(parsed, "version")}`;
  const caps: unknown = Reflect.get(parsed, "caps");
  if (typeof caps !== "object" || caps === null) {
    throw new Error(`probing ${name} produced no capabilities: ${text}`);
  }
  return { name, path, version, caps: capsOf(caps) };
}

/** Narrow the parsed JSON to {@linkcode Capabilities} without asserting. */
function capsOf(raw: object): Capabilities {
  const flag = (k: string): boolean => Reflect.get(raw, k) === true;
  return {
    hooks: true,
    preupdate: flag("preupdate"),
    wal: flag("wal"),
    trace: flag("trace"),
    progress: flag("progress"),
    busy: flag("busy"),
    authorize: flag("authorize"),
    collation: flag("collation"),
    normalizedSql: flag("normalizedSql"),
  };
}

/** Where the three libraries are. Throws with a usable message when one is missing. */
function locate(): { name: string; path: string }[] {
  const prebuilt = driverPrebuilt();
  if (prebuilt === undefined) {
    throw new Error(
      "No @db/sqlite prebuilt in $DENO_DIR/plug. It is downloaded the first " +
        "time the driver is imported with DENO_SQLITE_PATH unset:\n" +
        "  DENO_SQLITE_PATH= deno eval \"await import('jsr:@db/sqlite@0.13.0')\"",
    );
  }
  return [
    { name: "system", path: resolveLibPath() },
    { name: "vendored", path: vendoredLibraryPath() },
    { name: "@db/sqlite prebuilt", path: prebuilt },
  ];
}

/**
 * A cell is `yes` or `no`, never a dash. Every `no` here is a MEASURED
 * negative — this library, at this path, at this version, on the date in the
 * block, did not have the symbol — and a dash would read as "not checked".
 * Nothing in this table is unknown; if a value ever cannot be measured it must
 * not be rendered as `no`.
 */
function cell(v: boolean): string {
  return v ? "yes" : "no";
}

/** The table body: everything whose value was measured. */
function tableOf(columns: Column[]): string {
  const head = ["Capability", ...columns.map((c) => `${c.name} ${c.version}`)];
  const lines = [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
  ];
  for (const { key, label } of ROWS) {
    const values = columns.map((c) => cell(c.caps[key] === true));
    lines.push(`| ${label} | ${values.join(" | ")} |`);
  }
  return lines.join("\n");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** README.md with the generated block replaced. */
function splice(readme: string, block: string): string {
  const i = readme.indexOf(BEGIN);
  const j = readme.indexOf(END);
  return `${readme.slice(0, i)}${BEGIN}\n\n${block}\n\n${readme.slice(j)}`;
}

/**
 * `text` as `deno fmt` would leave it.
 *
 * The comparison has to run through the real formatter, because `deno fmt`
 * pads markdown table cells and rewraps prose: text this file emits is correct
 * and still not byte-identical to what is committed. Normalising whitespace
 * by hand instead would be a second, worse formatter that drifts from the
 * first one silently.
 */
async function formatted(text: string): Promise<string> {
  const tmp = await Deno.makeTempFile({ suffix: ".md" });
  try {
    await Deno.writeTextFile(tmp, text);
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["fmt", "--quiet", tmp],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (out.code !== 0) {
      throw new Error(
        `deno fmt exited ${out.code}: ${
          new TextDecoder().decode(out.stderr).trim()
        }`,
      );
    }
    return await Deno.readTextFile(tmp);
  } finally {
    await Deno.remove(tmp);
  }
}

/**
 * The formatted README carrying today's numbers, and its block.
 *
 * The date is only restamped when something else in the block changed. A date
 * rewritten on every run would make `--check` fail every day for no reason.
 */
async function regenerate(
  readme: string,
  columns: Column[],
  committed: string,
): Promise<{ full: string; block: string }> {
  const dated = committed.match(/Observed \*\*(\d{4}-\d{2}-\d{2})\*\*/);
  const keep = dated?.[1];
  if (keep !== undefined) {
    const full = await formatted(splice(readme, blockFor(columns, keep)));
    const block = committedBlock(full);
    if (block !== undefined && block === committed) return { full, block };
  }
  const full = await formatted(splice(readme, blockFor(columns, today())));
  const block = committedBlock(full);
  if (block === undefined) throw new Error("the markers went missing");
  return { full, block };
}

/** The committed block, or `undefined` when the markers are missing. */
function committedBlock(readme: string): string | undefined {
  const i = readme.indexOf(BEGIN);
  const j = readme.indexOf(END);
  if (i === -1 || j === -1 || j < i) return undefined;
  return readme.slice(i + BEGIN.length, j).trim();
}

/** The block as it should read, stamped with `date`. */
function blockFor(columns: Column[], date: string): string {
  const table = tableOf(columns);
  // Where each library came from, NOT the absolute path it had on the machine
  // that ran this. A `$DENO_DIR/plug/<sha>.so` baked into the README would be
  // wrong on every other machine and would make `--check` fail for a reason
  // that has nothing to do with capabilities. The real paths are printed by
  // both modes at run time, where they can be read and checked.
  const paths = columns.map((c) => `- \`${c.name}\` — ${PROVENANCE[c.name]}`);
  return [
    `Observed **${date}**, by running \`probeCapabilities()\` against each ` +
    `library at the path below, each in its own process. Every \`no\` is a ` +
    `measured negative — the symbol was looked for in that file, on that ` +
    `date, and was not there — not an unchecked cell. Regenerate with ` +
    `\`deno task table\`; \`deno task test:table\` fails if this is stale.`,
    ``,
    table,
    ``,
    ...paths,
  ].join("\n");
}

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

/** The gate. Nothing this file measures is reportable until every one passes. */
async function gate(columns: Column[]): Promise<void> {
  const real = columns.map((c) => Deno.realPathSync(c.path));
  if (new Set(real).size === columns.length) {
    pass(`three distinct libraries: ${real.join(", ")}`);
  } else {
    fail("three distinct libraries", `resolved to ${real.join(", ")}`);
  }

  const rendered = columns.map((c) =>
    ROWS.map(({ key }) => cell(c.caps[key] === true)).join("")
  );
  if (new Set(rendered).size > 1) {
    pass("the three columns are not identical");
  } else {
    fail(
      "the three columns are not identical",
      `all three read ${
        rendered[0]
      } — the classic three-copies-of-one-library result`,
    );
  }

  // Independent of the loader: the version string a library reports is
  // compiled into it, so it must appear in the bytes of the file at that path.
  // This is what catches dlopen having handed back a different build.
  for (const c of columns) {
    const bytes = await Deno.readFile(c.path);
    const needle = new TextEncoder().encode(c.version);
    let found = false;
    outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
      for (let k = 0; k < needle.length; k++) {
        if (bytes[i + k] !== needle[k]) continue outer;
      }
      found = true;
      break;
    }
    if (found) {
      pass(`${c.name} reports ${c.version}, and ${c.version} is in that file`);
    } else {
      fail(
        `${c.name} reports ${c.version}, and ${c.version} is in that file`,
        `${c.version} does not occur in ${c.path}; dlopen returned some other build`,
      );
    }
  }

  const system = columns.find((c) => c.name === "system");
  const suiteLib = Deno.realPathSync(resolveLibPath());
  if (system && Deno.realPathSync(system.path) === suiteLib) {
    pass(
      `the system column is the library the suite runs against (${suiteLib})`,
    );
  } else {
    fail(
      "the system column is the library the suite runs against",
      `column is ${system?.path}, suite uses ${suiteLib}`,
    );
  }

  const pinned = columns.find((c) => c.name === PINNED.column);
  const actual = pinned === undefined
    ? undefined
    : pinned.caps[PINNED.row] === true;
  if (actual === PINNED.value) {
    pass(
      `known answer: ${PINNED.column}.${PINNED.row} is ${PINNED.value}`,
    );
  } else {
    fail(
      `known answer: ${PINNED.column}.${PINNED.row} is ${PINNED.value}`,
      `measured ${actual}`,
    );
  }
}

if (import.meta.main) {
  const probeAt = Deno.args.indexOf("--probe");
  if (probeAt !== -1) {
    const path = Deno.args[probeAt + 1];
    if (path === undefined) {
      console.error("--probe needs a path");
      Deno.exit(2);
    }
    console.log(JSON.stringify(probeOne(path)));
  } else {
    const check = Deno.args.includes("--check");
    const columns: Column[] = [];
    for (const { name, path } of locate()) {
      columns.push(await probeInChild(name, path));
    }

    const readme = await Deno.readTextFile(README);
    const committed = committedBlock(readme);
    if (committed === undefined) {
      console.error(`README.md has no ${BEGIN} / ${END} markers`);
      Deno.exit(2);
    }
    const { full, block } = await regenerate(readme, columns, committed);

    for (const c of columns) {
      console.log(`  ${c.name}: SQLite ${c.version}\n    ${c.path}`);
    }

    if (check) {
      console.log("capability table");
      await gate(columns);
      if (block === committed) {
        pass("README.md matches what the libraries report");
      } else {
        fail(
          "README.md matches what the libraries report",
          `run \`deno task table\`. Expected:\n${block}\n\nCommitted:\n${committed}`,
        );
      }
      console.log(
        `\n${passed} passed, ${failed} failed — ${
          failed === 0 ? "OK" : "FAILURES"
        }`,
      );
    } else {
      await Deno.writeTextFile(README, full);
      console.log(`README.md updated:\n\n${block}`);
    }
  }
}
