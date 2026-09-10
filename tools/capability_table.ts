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
    "the path `resolveLibPath()` returns — the library the test suite runs against",
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
    `date, and was not there — not an unchecked cell. In the repository the ` +
    `\`table\` task rewrites this block and the \`test:table\` gate fails if ` +
    `it is stale; neither script is in the published package.`,
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
  rows: readonly { readonly key: string; readonly label: string }[],
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
  rows: { key: string; label: string }[];
  block: string | undefined;
}[] {
  const names = EXEMPT.length > 0
    ? ["alpha", "beta", "gamma", ...EXEMPT]
    : ["alpha", "beta", "gamma"];
  const rows = [
    { key: "alpha", label: "`alpha`" },
    { key: "beta", label: "`beta`" },
    { key: "gamma", label: "`gamma`" },
  ];
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
      rows: [...rows, { key: "ghost", label: "`ghost`" }],
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
