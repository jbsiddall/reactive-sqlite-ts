/**
 * Generates — and checks — the "what three real libraries actually support"
 * table in README.md.
 *
 * Every cell comes from running {@linkcode probeCapabilities} against a real
 * libsqlite3 on this machine. Not from a symbol dump, not from a build flag,
 * not from memory. The three libraries are the three a user can actually end
 * up with:
 *
 *   1. the library `resolveLibPath()` finds with DENO_SQLITE_PATH unset. The
 *      column is resolved by calling that function rather than by a second
 *      candidate list, so the table cannot drift from the resolution logic the
 *      rest of the project uses. That is a claim about the MECHANISM and not
 *      about the outcome, and the difference matters: `deno task test` calls
 *      the same function, but DENO_SQLITE_PATH short-circuits it, and the task
 *      does not set the variable itself — the caller does. Our own gate
 *      procedure exports it at the vendored build, so in the configuration we
 *      actually run, the suite is on 3.53.4 while this column is the machine's
 *      3.45.1. `locate()` refuses outright when the variable is set, so this
 *      column is ALWAYS the unpinned scan and never the pinned library;
 *   2. the vendored build under `vendor/lib/<target>/`;
 *   3. the prebuilt `@db/sqlite` downloads into `$DENO_DIR/plug/` when
 *      DENO_SQLITE_PATH is unset. No release is named here on purpose: the
 *      driver is not a dependency of this project, so the cached artefact's
 *      own metadata.json is the only record of which release it is, and
 *      `releaseFromMetadata()` reads it into the rendered provenance line. A
 *      number typed into this comment would have nothing on disk to be wrong
 *      against. That library is also the only one reachable here that
 *      GENUINELY lacks capabilities, so it is the only honest fixture for the
 *      absent-capability branches — and it exists only until the driver is
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
import { driverPrebuilt, releaseFromMetadata } from "../vendor/probe.ts";
import { vendoredLibraryPath } from "../src/vendored.ts";

const README = new URL("../README.md", import.meta.url);
const BEGIN = "<!-- capability-table:begin -->";
const END = "<!-- capability-table:end -->";

/**
 * The rows, in the order {@linkcode Capabilities} declares them.
 * `preupdateUnavailable` is deliberately not a row: it is the REASON preupdate
 * is false, a string rather than a capability, and it says nothing a reader of
 * this table can act on.
 */
const ROWS: { key: keyof Capabilities }[] = [
  { key: "hooks" },
  { key: "preupdate" },
  { key: "wal" },
  { key: "trace" },
  { key: "progress" },
  { key: "busy" },
  { key: "authorize" },
  { key: "collation" },
  { key: "normalizedSql" },
];

/**
 * The cell a row is printed under, derived rather than typed.
 *
 * There used to be a `label` string beside each key here, and the parity
 * controls below check the KEY. So a label reading `hooks` beside the key
 * `wal` would have rendered a row asserting the wrong capability with every
 * control green, and nothing on disk would have had to change for it to be
 * wrong -- it WAS the typed string. Deriving it removes the axis rather than
 * guarding it.
 */
function rowLabel(key: string): string {
  return `\`${key}\``;
}

/**
 * The day the cached prebuilt was last known to be current.
 *
 * STATED, NOT MEASURED, and this is the one place in this file that says so
 * rather than reading it off the artefact. The cells in that column ARE
 * re-read from the real bytes on every run -- nothing about them is carried
 * forward -- but nothing refreshes `$DENO_DIR/plug` either, so the FILE is
 * whatever `@db/sqlite` last downloaded here, and the column therefore reports
 * a past release rather than the current one. Stamping it with the run date
 * would convert a historical comparison into a claimed-current one.
 *
 * WHY NOT THE FILE'S OWN MTIME: because it is not trustworthy as a vintage.
 * MEASURED 2026-09-10: the `.so` in this machine's cache carries mtime
 * 2026-09-09 16:39:44 while the sibling `.metadata.json` carries 2026-09-10
 * 01:28:25 -- a copy-out-and-back of the cache moved one and not the other.
 * Two mtimes on one artefact disagreeing by a day is exactly the reading that
 * cannot be used, so the date is written down and `frozenStale()` below turns
 * it into something the machine can contradict: if the library is ever
 * re-downloaded, its mtime passes this date and the gate goes red.
 */
const PREBUILT_FROZEN = "2026-09-09";

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

/**
 * How each column's library is found. Stable across machines; the path is not.
 *
 * ONE TABLE MUST NOT CARRY TWO PROVENANCES. Every SQLite version in the header
 * row is measured -- `sqlite3_libversion()` on the dlopened file, with
 * `gate()` requiring that string to occur in the file's own bytes -- and for a
 * while the `@db/sqlite` RELEASE beside it was a literal typed into this
 * object. Rewriting the cached artefact's metadata.json to name release 0.9.99
 * left `--check` green while the rendered line went on saying 0.13.0. The
 * measured axis was lending its credibility to the asserted one, in the same
 * row, with nothing on the page telling them apart.
 *
 * So the test applied to every identifying string here is: WHAT WOULD HAVE TO
 * CHANGE ON DISK FOR THIS TO BECOME WRONG? If the answer is nothing, it is not
 * measured, and it either gets read from the artefact or it says out loud that
 * it is not measured. The two that stay unmeasured are marked below.
 */
function provenanceOf(prebuiltRelease: string | undefined): Record<
  string,
  string
> {
  return {
    // Corrected, and this was a false claim rather than a vague one. The
    // suite calls `resolveLibPath()` too, which honours DENO_SQLITE_PATH, and
    // the suite is normally run with it pinned at the vendored library --
    // while this table refuses to build at all when it is set. MEASURED: the
    // suite runs against vendor/lib/<target>/ at 3.53.4 while this column is
    // the machine's 3.45.1. They are the same library only when nobody pins
    // one, which is not how the suite is run.
    "system":
      "the path `resolveLibPath()` returns with `DENO_SQLITE_PATH` unset — not necessarily the library the suite runs against, which is normally pinned",
    // `built by deno task vendor:build` is not asserted here on trust: gate()
    // reads build_manifest.json beside the library and requires it to agree
    // with the file, by version and by SHA-256.
    "vendored":
      "`vendor/lib/<target>/`, built by `deno task vendor:build` and matching the `build_manifest.json` beside it",
    // Past tense on purpose. The cells are re-read from these bytes every
    // run; the bytes are whatever was downloaded once and never refreshed.
    // The release stays MEASURED -- read out of the artefact's metadata.json
    // -- while the date beside it is the stated `PREBUILT_FROZEN` above.
    "@db/sqlite prebuilt": `\`$DENO_DIR/plug/\`, the copy \`@db/sqlite\` ${
      prebuiltRelease ?? "(release unknown — its metadata.json names none)"
    } downloaded into this machine's cache when \`DENO_SQLITE_PATH\` was unset — a HISTORICAL column, frozen at ${PREBUILT_FROZEN} because nothing refreshes that cache; it says what that release shipped, not what \`@db/sqlite\` ships today`,
  };
}

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

/**
 * The refusal that stops the table being built against a pinned library.
 *
 * MEASURED: with `DENO_SQLITE_PATH` exported at the vendored library,
 * `--check` printed 6 passed / 2 failed and the distinctness control reported
 * the `system` and `vendored` columns resolving to the same file. The gate
 * caught it, which is the gate working -- and a caption is still not enough.
 * A table that renders two headings over one library when an environment
 * variable happens to be exported is an instrument with a wrong reading, and
 * documenting which reading you took does not stop the next person taking the
 * other one. So the table is not built at all under that condition.
 *
 * It lives here, in the function that resolves the columns, rather than in the
 * `import.meta.main` block. Every path that produces a table -- generation and
 * `--check` alike, and any future importer -- goes through `locate()`, and a
 * guard in the entry block would be a guard on the task rather than on the
 * measurement.
 *
 * Pure, and takes both paths as arguments, so the message can be asserted by
 * the structural check with no libsqlite3 on disk and nothing exported.
 */
function pinnedLibraryRefusal(
  pinned: string | undefined,
  vendored: string,
): string | null {
  if (pinned === undefined || pinned.trim() === "") return null;
  const real = (p: string): string => {
    try {
      return Deno.realPathSync(p);
    } catch {
      return p;
    }
  };
  const same = real(pinned) === real(vendored);
  const consequence = same
    ? `That is the same file as the \`vendored\` column (${
      real(vendored)
    }), so ` +
      `the table would render one library under two headings and say nothing ` +
      `about it.`
    : `The \`system\` column would report that library rather than the ` +
      `machine's, under a heading that says otherwise.`;
  return [
    `Refusing to build the capability table: DENO_SQLITE_PATH is set to ${pinned}.`,
    ``,
    `The \`system\` column is whatever resolveLibPath() returns, and that`,
    `honours DENO_SQLITE_PATH. ${consequence}`,
    ``,
    `Unset it for this command:`,
    `  DENO_SQLITE_PATH= deno task table        # or test:table`,
  ].join("\n");
}

/**
 * The release the cached prebuilt's own metadata names, once `locate()` has
 * read it. Rendered into the provenance line instead of a literal.
 */
let prebuiltRelease: string | undefined;

/**
 * What to print when there is no cached prebuilt to probe.
 *
 * Pulled out and fixtured so that the absent version pin STAYS absent. It is
 * the one identifying string in this file's output that cannot be read off an
 * artefact -- the message exists precisely because the artefact is missing --
 * so the guard is that no release number may appear in it at all.
 */
function missingPrebuiltMessage(): string {
  return "No @db/sqlite prebuilt in $DENO_DIR/plug. It is downloaded the first " +
    "time the driver is imported with DENO_SQLITE_PATH unset:\n" +
    "  DENO_SQLITE_PATH= deno eval \"await import('jsr:@db/sqlite')\"";
}

/** Where the three libraries are. Throws with a usable message when one is missing. */
function locate(): { name: string; path: string }[] {
  const refusal = pinnedLibraryRefusal(
    Deno.env.get("DENO_SQLITE_PATH"),
    vendoredLibraryPath(),
  );
  if (refusal !== null) throw new Error(refusal);
  const prebuilt = driverPrebuilt();
  prebuiltRelease = prebuilt?.release;
  if (prebuilt === undefined) {
    // The version pin is GONE from this command rather than being read from
    // somewhere, and that is the honest answer rather than a contrived one.
    // This message is printed on the one path where the cache is ABSENT, so
    // there is no artefact to read a release out of; the driver is not a
    // dependency of this project either, so nothing else on disk records one.
    // A typed pin here would be the defect this file exists to refuse. What
    // the command fetches is whatever jsr resolves today, and the table then
    // reports THAT release, because the provenance line follows the metadata
    // of the artefact this command creates. If the release it lands on ever
    // behaves differently, `PINNED` fails loudly rather than the table lying:
    // the known answer says this column's `preupdate` is false.
    throw new Error(missingPrebuiltMessage());
  }
  return [
    { name: "system", path: resolveLibPath() },
    { name: "vendored", path: vendoredLibraryPath() },
    { name: "@db/sqlite prebuilt", path: prebuilt.path },
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
  // The third column is marked IN THE HEADER, not only in the bullet below
  // it, because a reader scanning the grid may never reach the bullets. Keyed
  // off `c.name` rather than by rewriting it: `PINNED.column` and the
  // `provenanceOf()` record are both keyed by that same string.
  const head = [
    "Capability",
    ...columns.map((c) =>
      c.name === PINNED.column
        ? `${c.name} ${c.version} (frozen ${PREBUILT_FROZEN})`
        : `${c.name} ${c.version}`
    ),
  ];
  const lines = [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
  ];
  for (const { key } of ROWS) {
    const values = columns.map((c) => cell(c.caps[key] === true));
    lines.push(`| ${rowLabel(key)} | ${values.join(" | ")} |`);
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
  const provenance = provenanceOf(prebuiltRelease);
  const paths = columns.map((c) => `- \`${c.name}\` — ${provenance[c.name]}`);
  return [
    `Observed **${date}** for the \`system\` and \`vendored\` columns, by ` +
    `running \`probeCapabilities()\` against each library at the path below, ` +
    `each in its own process. The third column is a dated historical ` +
    `comparison and is NOT current: its cells are re-read from the cached ` +
    `prebuilt on every run, but nothing refreshes that cache, so the file ` +
    `stays as downloaded on **${PREBUILT_FROZEN}** and the column reports ` +
    `what that release shipped rather than what \`@db/sqlite\` ships now. ` +
    `Every \`no\` is a measured negative — the symbol was looked for in that ` +
    `file, on the date given for its column, and was not there — not an ` +
    `unchecked cell. In the repository the \`table\` task rewrites this ` +
    `block and the \`test:table\` gate fails if it is stale; neither script ` +
    `is in the published package.`,
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

/**
 * Whether the resolved column paths are all different files.
 *
 * Pulled out of `gate()` and given fixtures because of what the refusal above
 * costs. Exporting DENO_SQLITE_PATH used to be the one way anybody had SEEN
 * the distinctness control fire, and the refusal now stops that run before the
 * gate is reached -- so without this the control would still be there, still
 * be right, and never again be observed rejecting anything. The refusal covers
 * one cause of a collapse; the control covers the rest, and the fixtures are
 * what keep it from becoming a control nobody has seen fail.
 */
function allDistinct(paths: readonly string[]): boolean {
  return new Set(paths).size === paths.length;
}

/**
 * Why the library at the vendored path is not the one `build.sh` produced, or
 * `null` when it is. Pure, so the control can be fixtured without swapping a
 * real 1.6MB library in and out of the tree.
 */
function manifestDisagreement(
  manifestVersion: string,
  manifestSha: string,
  probedVersion: string,
  fileSha: string,
): string | null {
  if (manifestVersion !== probedVersion) {
    return `build_manifest.json records SQLite ${manifestVersion}, the library at that path reports ${probedVersion}`;
  }
  if (manifestSha !== fileSha) {
    return `build_manifest.json records librarySha256 ${manifestSha}, the file is ${fileSha}`;
  }
  return null;
}

/**
 * Why the frozen date on the prebuilt column is no longer true, or `null`.
 *
 * Pure, and fixtured below, because the only way to see it fire against the
 * real cache would be to re-download or touch `$DENO_DIR/plug` -- mutating the
 * developer's cache to test an assertion about it. `mtime` is null on file
 * systems that do not report one; that is a refusal, not a pass, because a
 * control that cannot read its input has not checked anything.
 */
function frozenStale(mtime: Date | null, frozen: string): string | null {
  if (mtime === null) {
    return `no mtime for the cached library, so the frozen date ${frozen} cannot be contradicted`;
  }
  const day = mtime.toISOString().slice(0, 10);
  if (day > frozen) {
    return `the cached library was written ${day}, after the frozen date ${frozen} — the prebuilt column is being presented as older than it is`;
  }
  return null;
}

/** The gate. Nothing this file measures is reportable until every one passes. */
async function gate(columns: Column[]): Promise<void> {
  const real = columns.map((c) => Deno.realPathSync(c.path));
  if (allDistinct(real)) {
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

  // Named for what it checks, which is narrower than it used to claim. This
  // control cannot run at all with DENO_SQLITE_PATH set -- locate() refuses --
  // so the path it compares against is always the unpinned candidate scan.
  // "The library the suite runs against" was the old name and was FALSE in the
  // configuration we actually use: the suite is run with DENO_SQLITE_PATH
  // pinned at the vendored 3.53.4 while this column is the machine's 3.45.1.
  const system = columns.find((c) => c.name === "system");
  const unpinned = Deno.realPathSync(resolveLibPath());
  if (system && Deno.realPathSync(system.path) === unpinned) {
    pass(
      `the system column is what resolveLibPath() resolves with DENO_SQLITE_PATH unset (${unpinned})`,
    );
  } else {
    fail(
      "the system column is what resolveLibPath() resolves with DENO_SQLITE_PATH unset",
      `column is ${system?.path}, resolveLibPath() gives ${unpinned}`,
    );
  }

  // The vendored column's provenance clause says the library was built by
  // `deno task vendor:build`. MEASURED before this existed: replacing that
  // file with the machine's system library left every gate control green --
  // distinctness included, because it is a different file -- and the only red
  // was staleness. Regenerating would then have written "vendored 3.45.1,
  // built by deno task vendor:build" over a library the build never produced,
  // with build_manifest.json sitting beside it saying otherwise and nothing
  // reading it. MEASURED too: mutating that manifest to sqliteVersion 0.0.0
  // and librarySha256 deadbeef changed nothing -- 8 passed, 0 failed.
  const vend = columns.find((c) => c.name === "vendored");
  if (vend !== undefined) {
    const dir = vend.path.slice(0, vend.path.lastIndexOf("/"));
    const claim = `the vendored column matches build_manifest.json beside it`;
    let manifest: { sqliteVersion?: unknown; librarySha256?: unknown };
    try {
      manifest = JSON.parse(
        await Deno.readTextFile(`${dir}/build_manifest.json`),
      );
    } catch (e) {
      fail(claim, `no readable build_manifest.json in ${dir}: ${e}`);
      manifest = {};
    }
    if (typeof manifest.sqliteVersion === "string") {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        await Deno.readFile(vend.path),
      );
      const sha = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      const wrong = manifestDisagreement(
        manifest.sqliteVersion,
        typeof manifest.librarySha256 === "string"
          ? manifest.librarySha256
          : "",
        vend.version,
        sha,
      );
      if (wrong === null) pass(`${claim} (${manifest.sqliteVersion}, ${sha})`);
      else fail(claim, wrong);
    }
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

  // The frozen date is the one identifying string in the block that is not
  // read off the artefact, so this is what would have to change on disk for it
  // to become wrong: the cached library being written again.
  if (pinned !== undefined) {
    const what =
      `the cached prebuilt has not been rewritten since ${PREBUILT_FROZEN}`;
    const stale = frozenStale(
      Deno.statSync(pinned.path).mtime,
      PREBUILT_FROZEN,
    );
    if (stale === null) pass(what);
    else fail(what, stale);
  }
}

/* ---------------------------------------------------------------------------
 * The structural check
 *
 * Everything above needs three real libsqlite3 builds on disk. The questions
 * below need none: they ask whether `Capabilities`, `ROWS` and the committed
 * README block still agree with one another. That is worth asking on its own
 * because it is the check that catches the failure this file cannot otherwise
 * see — a capability added to the type with no row in the table, which the
 * generator will happily regenerate around, and `--check` will happily pass,
 * because the generator and the check read the SAME hand-written `ROWS` list.
 * A list that is its own reference cannot detect its own omissions.
 *
 * So the field names are read TEXTUALLY out of `src/hooks.ts` rather than from
 * anything the type system hands us: `keyof Capabilities` is exactly the thing
 * under suspicion, and a check that derived the expected set from it would
 * agree with any mistake made in the declaration. The text is a second copy in
 * the only sense that matters — it is produced by a different mechanism.
 *
 * Because it needs no library, it runs in CI BEFORE libsqlite3 is installed
 * and before DENO_SQLITE_PATH is pinned. That placement is deliberate: a check
 * that only runs after a working SQLite is in place cannot report on a machine
 * where installing one failed, and this check has nothing to say about SQLite.
 *
 * Measured 2026-09-09 (Deno 2.9.6): none of this file's imports — `../mod.ts`,
 * `../vendor/probe.ts`, `../src/vendored.ts` — dlopens anything at import
 * time; all three import cleanly with `--allow-ffi` withheld. That is why the
 * structural mode can live here and reuse the very `ROWS` object the generator
 * uses, rather than that list being moved to a third module to keep FFI out of
 * the check. Reusing it is the point: a check against a copy of `ROWS` would
 * pass while the real one was wrong.
 *
 *   deno run --allow-read tools/capability_table.ts --structure
 */

/**
 * Fields of {@linkcode Capabilities} that deliberately have no row.
 *
 * A name here must still be a live field. An exemption for a field that no
 * longer exists is not harmless: it is a standing licence to omit a row for
 * whatever name is later reused, so a stale entry FAILS rather than being
 * ignored.
 */
const EXEMPT: readonly string[] = ["preupdateUnavailable"];

/**
 * Controls on the parser itself, checked on every invocation.
 *
 * A regex that silently matches nothing produces an empty field set, and an
 * empty field set makes every parity assertion below vacuously true — the
 * check would report all-pass on a declaration it never read. These two pins
 * are what a broken parse trips over: a floor on how many fields there are,
 * and two names that have been in the type since it existed and whose removal
 * would be the substance of a change, not an accident of one.
 */
const MIN_FIELDS = 9;
const KNOWN_FIELDS: readonly string[] = ["hooks", "normalizedSql"];

/** What a textual read of the `Capabilities` declaration produced. */
type Declaration =
  | { readonly kind: "fields"; readonly names: readonly string[] }
  | { readonly kind: "unparseable"; readonly why: string };

/**
 * The field names of `Capabilities`, in declaration order, read out of the
 * source text.
 *
 * Deliberately strict: anything it does not understand becomes `unparseable`
 * rather than a shorter list. A parser that copes with a declaration it cannot
 * read by returning fewer fields is a parser that turns a rewrite of the type
 * into a silent pass.
 */
function parseCapabilityFields(source: string): Declaration {
  const opener = "export type Capabilities = {";
  const start = source.indexOf(opener);
  if (start === -1) {
    return { kind: "unparseable", why: `no \`${opener}\` in the source` };
  }
  const body = source.slice(start + opener.length);
  const end = body.indexOf("\n};");
  if (end === -1) {
    return {
      kind: "unparseable",
      why: "the declaration is never closed by a `};` at the start of a line",
    };
  }
  const names: string[] = [];
  for (const line of body.slice(0, end).split("\n")) {
    const m = line.match(/^\s*readonly\s+([A-Za-z_$][\w$]*)\??\s*:/);
    if (m !== null && m[1] !== undefined) names.push(m[1]);
  }
  if (names.length === 0) {
    return {
      kind: "unparseable",
      why:
        "the declaration was located but no `readonly <name>:` member matched",
    };
  }
  return { kind: "fields", names };
}

/** One structural question and how it came out. */
type Finding = {
  readonly ok: boolean;
  readonly what: string;
  readonly detail: string;
};

const ok = (what: string): Finding => ({ ok: true, what, detail: "" });
const bad = (what: string, detail: string): Finding => ({
  ok: false,
  what,
  detail,
});

/** The data rows of a markdown table: the cells after the leading label. */
function dataCells(block: string): string[][] {
  const rows: string[][] = [];
  for (const line of block.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|") || !t.endsWith("|")) continue;
    const cells = t.slice(1, -1).split("|").map((c) => c.trim());
    if (cells.every((c) => /^-+$/.test(c))) continue;
    rows.push(cells);
  }
  // The first row is the header.
  return rows.slice(1);
}

/**
 * The seven structural questions, as a pure function of the three inputs.
 *
 * Pure on purpose: the fixtures below feed it declarations, row lists and
 * README text that no file on disk contains, which is the only way to see each
 * assertion FAIL. An assertion nobody has watched reject something is an
 * assertion whose expected value is unverified.
 */
function structuralFindings(
  decl: Declaration,
  rows: readonly { readonly key: string }[],
  block: string | undefined,
): Finding[] {
  const out: Finding[] = [];

  if (decl.kind === "unparseable") {
    // Nothing downstream can be asked honestly: every parity question below
    // would be comparing rows against an empty set and passing.
    out.push(bad("the `Capabilities` declaration parses", decl.why));
    return out;
  }
  out.push(
    ok(
      `the \`Capabilities\` declaration parses (${decl.names.length} fields: ${
        decl.names.join(", ")
      })`,
    ),
  );

  const fields = new Set(decl.names);
  const keyed = rows.map((r) => r.key);
  const rowed = new Set(keyed);

  // 1. Every field has a row, unless it is exempt.
  const missing = decl.names.filter((n) =>
    !rowed.has(n) && !EXEMPT.includes(n)
  );
  out.push(
    missing.length === 0
      ? ok("every `Capabilities` field has a table row or a named exemption")
      : bad(
        "every `Capabilities` field has a table row or a named exemption",
        `no row and no exemption for ${missing.join(", ")}`,
      ),
  );

  // 2. Every row names a field that still exists.
  const dead = keyed.filter((k) => !fields.has(k));
  out.push(
    dead.length === 0
      ? ok("every table row names a field `Capabilities` still declares")
      : bad(
        "every table row names a field `Capabilities` still declares",
        `${dead.join(", ")} is not a field of \`Capabilities\``,
      ),
  );

  // 3. Every exemption names a field that still exists.
  const staleExempt = EXEMPT.filter((n) => !fields.has(n));
  out.push(
    staleExempt.length === 0
      ? ok("every exemption names a field `Capabilities` still declares")
      : bad(
        "every exemption names a field `Capabilities` still declares",
        `${
          staleExempt.join(", ")
        } is exempt from having a row but is not a field — a stale exemption ` +
          `licenses an omitted row for whatever name is next given to it`,
      ),
  );

  // 4. Row order follows declaration order.
  const expected = decl.names.filter((n) => rowed.has(n));
  const orderOk = expected.length === keyed.length &&
    expected.every((n, i) => keyed[i] === n);
  out.push(
    orderOk
      ? ok("the rows are in the order `Capabilities` declares the fields")
      : bad(
        "the rows are in the order `Capabilities` declares the fields",
        `rows read ${keyed.join(", ")}; declaration order is ${
          expected.join(", ")
        }`,
      ),
  );

  // 5. The generated block exists and is not empty.
  if (block === undefined || block.trim() === "") {
    out.push(
      bad(
        "README.md has both markers and a non-empty block between them",
        block === undefined
          ? "the markers are missing or out of order"
          : "the block between the markers is empty",
      ),
    );
    return out;
  }
  out.push(ok("README.md has both markers and a non-empty block between them"));

  // 6. The block says when it was observed, and the date is a real one.
  const dated = block.match(/Observed \*\*(\d{4}-\d{2}-\d{2})\*\*/);
  const stamp = dated?.[1];
  const parsed = stamp === undefined ? NaN : Date.parse(`${stamp}T00:00:00Z`);
  out.push(
    stamp !== undefined && !Number.isNaN(parsed)
      ? ok(`the block carries an observation date (${stamp})`)
      : bad(
        "the block carries an observation date",
        stamp === undefined
          ? "no `Observed **YYYY-MM-DD**` line in the block"
          : `\`${stamp}\` is not a real date`,
      ),
  );

  // 7. Every measured cell is `yes` or `no` and nothing else.
  const odd: string[] = [];
  for (const cells of dataCells(block)) {
    const [label, ...values] = cells;
    for (const v of values) {
      if (v !== "yes" && v !== "no") {
        odd.push(`${label ?? "?"}: ${JSON.stringify(v)}`);
      }
    }
  }
  out.push(
    odd.length === 0 ? ok("every measured cell reads `yes` or `no`") : bad(
      "every measured cell reads `yes` or `no`",
      `${
        odd.join("; ")
      } — a cell that is neither is a value nobody measured, such as a ` +
        `blank or a dash left where a probe did not run`,
    ),
  );

  return out;
}

/**
 * A synthetic README block that is correct, for the fixtures to damage.
 *
 * Built here rather than read from disk: a fixture that started from the real
 * README would stop being a fixture the day the real README changed.
 */
function fixtureBlock(fields: readonly string[], date = "2026-01-02"): string {
  const head = `| Capability | lib A | lib B |`;
  const rule = `| --- | --- | --- |`;
  const body = fields.map((f) => `| \`${f}\` | yes | no |`);
  return [
    `Observed **${date}**, by running \`probeCapabilities()\`.`,
    ``,
    head,
    rule,
    ...body,
  ].join("\n");
}

/**
 * The fixtures the structural check must reject before it is allowed to report
 * on the real files.
 *
 * One of these — the baseline — must PASS; the other five must fail, and must
 * fail on the NAMED assertion rather than on any assertion at all. A fixture
 * that fails for the wrong reason is a fixture that would keep passing after
 * the assertion it was written for was deleted.
 */
function fixtures(): {
  name: string;
  expect: string | null;
  decl: Declaration;
  rows: { key: string }[];
  block: string | undefined;
}[] {
  const names = EXEMPT.length > 0
    ? ["alpha", "beta", "gamma", ...EXEMPT]
    : ["alpha", "beta", "gamma"];
  const rows = [{ key: "alpha" }, { key: "beta" }, { key: "gamma" }];
  const live: Declaration = { kind: "fields", names };
  const good = fixtureBlock(["alpha", "beta", "gamma"]);
  return [
    {
      name: "baseline: a consistent set",
      expect: null,
      decl: live,
      rows,
      block: good,
    },
    {
      name: "(a) a row was deleted",
      expect: "has a table row or a named exemption",
      decl: live,
      rows: rows.slice(0, 2),
      block: good,
    },
    {
      name: "(b) a row names a field that no longer exists",
      expect: "names a field `Capabilities` still declares",
      decl: live,
      rows: [...rows, { key: "ghost" }],
      block: good,
    },
    {
      name: "(c) a field was added with no row",
      expect: "has a table row or a named exemption",
      decl: { kind: "fields", names: [...names, "delta"] },
      rows,
      block: good,
    },
    {
      name: "(d) the block carries no observation date",
      expect: "observation date",
      decl: live,
      rows,
      block: good.replace(/Observed \*\*[\d-]+\*\*/, "Observed recently"),
    },
    {
      name: "(e) the declaration cannot be parsed",
      expect: "declaration parses",
      decl: parseCapabilityFields("export type Something = { readonly a: 1 };"),
      rows,
      block: good,
    },
  ];
}

/**
 * The structural mode. Controls first, fixtures second, the real files last —
 * in that order, because a report on the real files is worth nothing until the
 * thing producing it has been seen to reject something.
 */
async function structure(): Promise<void> {
  console.log("capability table: structure");

  const source = await Deno.readTextFile(
    new URL("../src/hooks.ts", import.meta.url),
  );
  const decl = parseCapabilityFields(source);

  // Controls on the parser, every invocation. These are what an empty or
  // half-matching parse trips over, and without them every parity assertion
  // below would pass vacuously against a field set that was never read.
  if (decl.kind === "fields" && decl.names.length >= MIN_FIELDS) {
    pass(
      `control: the parse found ${decl.names.length} fields (>= ${MIN_FIELDS})`,
    );
  } else {
    fail(
      `control: the parse found at least ${MIN_FIELDS} fields`,
      decl.kind === "fields"
        ? `found ${decl.names.length}: ${decl.names.join(", ")}`
        : decl.why,
    );
  }
  const absent = decl.kind === "fields"
    ? KNOWN_FIELDS.filter((k) => !decl.names.includes(k))
    : KNOWN_FIELDS.slice();
  if (absent.length === 0) {
    pass(`control: the parse found ${KNOWN_FIELDS.join(" and ")}`);
  } else {
    fail(
      `control: the parse found ${KNOWN_FIELDS.join(" and ")}`,
      `missing ${absent.join(", ")} — the parse did not read the declaration`,
    );
  }

  // The fixtures. Five damaged inputs that must be rejected, and one intact
  // input that must not be, so a check that rejects everything is caught too.
  for (const f of fixtures()) {
    const got = structuralFindings(f.decl, f.rows, f.block);
    const failures = got.filter((g) => !g.ok);
    if (f.expect === null) {
      if (failures.length === 0) {
        pass(`fixture ${f.name}: accepted`);
      } else {
        fail(
          `fixture ${f.name}: accepted`,
          `rejected by ${failures.map((g) => g.what).join("; ")}`,
        );
      }
      continue;
    }
    const hit = failures.filter((g) => g.what.includes(f.expect ?? ""));
    if (hit.length > 0) {
      pass(`fixture ${f.name}: rejected by "${hit[0]?.what}"`);
    } else {
      fail(
        `fixture ${f.name}: rejected for the named reason`,
        failures.length === 0
          ? "accepted — the assertion it was written for did not fire"
          : `rejected, but only by ${failures.map((g) => g.what).join("; ")}`,
      );
    }
  }

  // The refusal that keeps the `system` column honest. Asserted on its TEXT,
  // not on the fact that something threw: the exit status tells an operator
  // that the table did not build, and only the message tells them why or what
  // to do about it, so a control that checks the status alone leaves the half
  // a human actually reads unverified.
  const V = "/x/vendor/lib/linux-x86_64-gnu/libsqlite3.so";
  for (
    const c of [
      {
        name: "unset — the table builds",
        pinned: undefined,
        want: [],
        refuse: false,
      },
      { name: "empty — treated as unset", pinned: "", want: [], refuse: false },
      {
        name: "pinned at the vendored library",
        pinned: V,
        refuse: true,
        // Names the variable, names its value, and names the collapse in the
        // table's own vocabulary -- `system` and `vendored` are the column
        // headings a reader is looking at -- plus the command that recovers.
        want: [
          "DENO_SQLITE_PATH is set to " + V,
          "`system`",
          "`vendored`",
          "one library under two headings",
          "DENO_SQLITE_PATH= deno task table",
        ],
      },
      {
        name: "pinned at some other library",
        pinned: "/x/other/libsqlite3.so",
        refuse: true,
        // A different consequence, so the message must not be the same one
        // with a different path in it: nothing collapses here, the `system`
        // column is simply not the system.
        want: [
          "DENO_SQLITE_PATH is set to /x/other/libsqlite3.so",
          "rather than the",
          "DENO_SQLITE_PATH= deno task table",
        ],
      },
    ]
  ) {
    const got = pinnedLibraryRefusal(c.pinned, V);
    const what = `refusal: ${c.name}`;
    if (!c.refuse) {
      if (got === null) pass(what);
      else fail(what, `refused anyway with: ${got}`);
      continue;
    }
    if (got === null) {
      fail(what, "did not refuse");
      continue;
    }
    const missing = c.want.filter((w) => !got.includes(w));
    if (missing.length === 0) pass(`${what}, saying all of: ${c.want.length}`);
    else fail(what, `message omits ${missing.join(" | ")}. Said:\n${got}`);
  }
  // The two refusals must differ, or the second fixture is proving only that
  // the first one's text also contains a path.
  if (
    pinnedLibraryRefusal(V, V) !== pinnedLibraryRefusal("/x/other.so", V)
  ) {
    pass("refusal: the two refusals say different things");
  } else {
    fail("refusal: the two refusals say different things", "identical text");
  }

  // The distinctness control, which the refusal above would otherwise have
  // left permanently unobserved.
  for (
    const c of [
      { name: "three different files", paths: ["/a", "/b", "/c"], want: true },
      {
        name: "system and vendored are one file",
        paths: ["/a", "/a", "/c"],
        want: false,
      },
      {
        name: "all three are one file",
        paths: ["/a", "/a", "/a"],
        want: false,
      },
    ]
  ) {
    const what = `distinctness control: ${c.name}`;
    if (allDistinct(c.paths) === c.want) pass(what);
    else fail(what, `said ${!c.want}`);
  }

  // The mislabelled-cache control. This is the demonstration that found the
  // defect, turned into something that runs: a metadata.json claiming a
  // release the table would then have to report. It is fixtured as a STRING
  // rather than by mutating $DENO_DIR/plug, because the parse is pure and a
  // test that edits the developer's real cache is a test that can leave it
  // broken. What that trade costs is the link between the parser and the
  // actual cache file, so the last case below pays for it: the real
  // metadata.json on this machine, if there is one, must be something this
  // parser reads a release out of.
  for (
    const c of [
      {
        name: "a real plug metadata file",
        text:
          '{"url":"https://github.com/denodrivers/sqlite3/releases/download/0.13.0/libsqlite3.so"}',
        want: "0.13.0",
      },
      {
        name: "the same artefact relabelled",
        text:
          '{"url":"https://github.com/denodrivers/sqlite3/releases/download/0.9.99/libsqlite3.so"}',
        want: "0.9.99",
      },
      { name: "not JSON", text: "not json at all", want: undefined },
      { name: "JSON with no url", text: '{"etag":"x"}', want: undefined },
      {
        name: "a url naming no release",
        text: '{"url":"https://example.invalid/libsqlite3.so"}',
        want: undefined,
      },
    ]
  ) {
    const got = releaseFromMetadata(c.text);
    const what = `release read from metadata: ${c.name}`;
    if (got === c.want) pass(`${what} → ${got}`);
    else fail(what, `read ${got}, expected ${c.want}`);
  }
  {
    // The literal is gone only if the rendered line moves when the artefact
    // does. Two different releases must render two different lines.
    const a = provenanceOf("0.13.0")["@db/sqlite prebuilt"];
    const b = provenanceOf("0.9.99")["@db/sqlite prebuilt"];
    const what = "the prebuilt provenance line follows the release";
    if (a !== b && a?.includes("0.13.0") && b?.includes("0.9.99")) pass(what);
    else fail(what, `rendered ${a} and ${b}`);
  }
  {
    const what = "no release: the provenance line says so rather than a number";
    const line = provenanceOf(undefined)["@db/sqlite prebuilt"] ?? "";
    if (line.includes("release unknown") && !/\d+\.\d+\.\d+/.test(line)) {
      pass(what);
    } else fail(what, `rendered ${line}`);
  }
  {
    // The frozen-date control, seen rejecting. A date after the frozen one is
    // the re-download case; the same day and an earlier day are both fine, and
    // an unreadable mtime refuses rather than passes.
    for (
      const c of [
        {
          name: "written the frozen day",
          mtime: "2026-09-09T16:39:44Z",
          bad: false,
        },
        {
          name: "written before it",
          mtime: "2026-09-01T00:00:00Z",
          bad: false,
        },
        {
          name: "re-downloaded the day after",
          mtime: "2026-09-10T01:28:25Z",
          bad: true,
        },
        { name: "no mtime at all", mtime: null, bad: true },
      ]
    ) {
      const got = frozenStale(
        c.mtime === null ? null : new Date(c.mtime),
        "2026-09-09",
      );
      const what = `frozen-date control: ${c.name}`;
      if ((got !== null) === c.bad) pass(`${what} → ${got ?? "ok"}`);
      else fail(what, `said ${got ?? "ok"}`);
    }
  }
  {
    // Pays for fixturing the parser on strings: the file the real cache holds
    // must be one this parser understands. Skipped, loudly, when there is no
    // cache to look at, so it never passes vacuously.
    const found = ((): string | undefined => {
      try {
        return driverPrebuilt()?.release;
      } catch {
        return undefined;
      }
    })();
    const what = "the cached prebuilt on this machine names a release";
    if (found === undefined) {
      console.log(`  skip  ${what} — no @db/sqlite prebuilt in $DENO_DIR/plug`);
    } else pass(`${what} (${found})`);
  }

  // The absent-prebuilt message. Two halves: it must still tell the reader how
  // to get the artefact, and it must not name a release while doing so.
  {
    const msg = missingPrebuiltMessage();
    const what = "the absent-prebuilt message still gives the recovery command";
    if (msg.includes("deno eval") && msg.includes("jsr:@db/sqlite")) pass(what);
    else fail(what, `message was ${JSON.stringify(msg)}`);

    const pinned = /\d+\.\d+\.\d+/.exec(msg)?.[0];
    const what2 = "the absent-prebuilt message pins no release";
    if (pinned === undefined) pass(what2);
    else {
      fail(
        what2,
        `it names ${pinned}, and no artefact exists at that point to read a ` +
          `release from -- the cache is what is missing`,
      );
    }
  }

  // The vendored-manifest control, fixtured rather than run against the tree.
  for (
    const c of [
      { name: "agrees", m: ["3.53.4", "ab"], p: ["3.53.4", "ab"], bad: null },
      {
        name: "a different library at the vendored path",
        m: ["3.53.4", "ab"],
        p: ["3.45.1", "cd"],
        bad: "reports 3.45.1",
      },
      {
        name: "same version, different bytes",
        m: ["3.53.4", "ab"],
        p: ["3.53.4", "cd"],
        bad: "librarySha256 ab",
      },
    ]
  ) {
    const got = manifestDisagreement(
      c.m[0] ?? "",
      c.m[1] ?? "",
      c.p[0] ?? "",
      c.p[1] ?? "",
    );
    const what = `vendored manifest control: ${c.name}`;
    if (c.bad === null) {
      if (got === null) pass(what);
      else fail(what, `objected: ${got}`);
    } else if (got !== null && got.includes(c.bad)) pass(what);
    else fail(what, `said ${got}`);
  }

  // Only now the real files.
  const readme = await Deno.readTextFile(README);
  for (const f of structuralFindings(decl, ROWS, committedBlock(readme))) {
    if (f.ok) pass(f.what);
    else fail(f.what, f.detail);
  }

  console.log(
    `\n${passed} passed, ${failed} failed — ${
      failed === 0 ? "OK" : "FAILURES"
    }`,
  );
}

if (import.meta.main) {
  if (Deno.args.includes("--structure")) {
    // Needs no libsqlite3 and opens none, which is why CI runs it before one
    // is installed. Returning here keeps it that way.
    await structure();
  } else {
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
}
