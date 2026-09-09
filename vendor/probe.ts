/**
 * Capability probe: which SQLite features does a given libsqlite3 actually give
 * you?
 *
 * Most SQLite capabilities are compile-time options, and a library never says
 * which ones it was built with. The distro's `libsqlite3.so.0`, the prebuilt
 * `@db/sqlite` downloads, and a library you built yourself all present the same
 * filename and the same `sqlite3_libversion()`, while differing in whether
 * `sqlite3_preupdate_hook` exists at all. Finding that out by calling the symbol
 * and getting a segfault is the expensive way.
 *
 * So: dlopen each symbol on its own and see whether it resolves. A missing
 * symbol makes `Deno.dlopen` throw for that one symbol only, which is exactly
 * the yes/no we want. Nothing is ever called, so the declared signatures below
 * are placeholders -- except `sqlite3_libversion`, which is called, and is
 * declared truthfully.
 *
 *   deno task vendor:probe                    # system vs vendored, side by side
 *   deno task vendor:probe /path/a.so /path/b.so
 *
 * Needs `--unstable-ffi --allow-ffi --allow-env --allow-read`.
 */

import { readManifest } from "./select.ts";
import {
  availableTargets,
  currentTarget,
  libraryFileName,
} from "../src/vendored.ts";
import { dirname, fromFileUrl, join } from "@std/path";

const VENDOR_DIR = dirname(fromFileUrl(import.meta.url));

/** One row of the table: a symbol, what it is for, and what enables it. */
interface Probe {
  symbol: string;
  what: string;
  /** The compile-time option that turns it on, or null when it is always present. */
  flag: string | null;
}

/** Groups exist so the output reads as capabilities rather than as a symbol dump. */
interface Group {
  title: string;
  probes: Probe[];
}

const GROUPS: Group[] = [
  {
    title: "Preupdate hook — old/new row values, and blob writes",
    probes: [
      {
        symbol: "sqlite3_preupdate_hook",
        what: "register the hook",
        flag: "SQLITE_ENABLE_PREUPDATE_HOOK",
      },
      {
        symbol: "sqlite3_preupdate_old",
        what: "value before the change",
        flag: "SQLITE_ENABLE_PREUPDATE_HOOK",
      },
      {
        symbol: "sqlite3_preupdate_new",
        what: "value after the change",
        flag: "SQLITE_ENABLE_PREUPDATE_HOOK",
      },
      {
        symbol: "sqlite3_preupdate_count",
        what: "column count of the row",
        flag: "SQLITE_ENABLE_PREUPDATE_HOOK",
      },
      {
        symbol: "sqlite3_preupdate_depth",
        what: "trigger/FK recursion depth",
        flag: "SQLITE_ENABLE_PREUPDATE_HOOK",
      },
      {
        symbol: "sqlite3_preupdate_blobwrite",
        what: "the blob write update_hook cannot see",
        flag: "SQLITE_ENABLE_PREUPDATE_HOOK",
      },
    ],
  },
  {
    title: "Session extension — changesets, patchsets, rebasing",
    probes: [
      {
        symbol: "sqlite3session_create",
        what: "start recording a session",
        flag: "SQLITE_ENABLE_SESSION",
      },
      {
        symbol: "sqlite3session_attach",
        what: "record one table (or all)",
        flag: "SQLITE_ENABLE_SESSION",
      },
      {
        symbol: "sqlite3session_changeset",
        what: "full changeset (old + new values)",
        flag: "SQLITE_ENABLE_SESSION",
      },
      {
        symbol: "sqlite3session_patchset",
        what: "patchset (new values only, smaller)",
        flag: "SQLITE_ENABLE_SESSION",
      },
      {
        symbol: "sqlite3session_diff",
        what: "changeset between two tables",
        flag: "SQLITE_ENABLE_SESSION",
      },
      {
        symbol: "sqlite3changeset_apply",
        what: "apply a changeset to another db",
        flag: "SQLITE_ENABLE_SESSION",
      },
      {
        symbol: "sqlite3changeset_apply_v2",
        what: "apply, returning a rebase blob",
        flag: "SQLITE_ENABLE_SESSION",
      },
      {
        symbol: "sqlite3changeset_invert",
        what: "invert a changeset (undo)",
        flag: "SQLITE_ENABLE_SESSION",
      },
      {
        symbol: "sqlite3changeset_concat",
        what: "concatenate two changesets",
        flag: "SQLITE_ENABLE_SESSION",
      },
      {
        symbol: "sqlite3rebaser_create",
        what: "rebaser: replay after a conflict",
        flag: "SQLITE_ENABLE_SESSION",
      },
      {
        symbol: "sqlite3rebaser_configure",
        what: "rebaser: feed it the rebase blob",
        flag: "SQLITE_ENABLE_SESSION",
      },
      {
        symbol: "sqlite3rebaser_rebase",
        what: "rebaser: rewrite a changeset",
        flag: "SQLITE_ENABLE_SESSION",
      },
    ],
  },
  {
    title: "Hooks and instrumentation always compiled in",
    probes: [
      {
        symbol: "sqlite3_update_hook",
        what: "row changed (what hooks.ts uses)",
        flag: null,
      },
      {
        symbol: "sqlite3_commit_hook",
        what: "about to commit; can veto",
        flag: null,
      },
      {
        symbol: "sqlite3_rollback_hook",
        what: "transaction discarded",
        flag: null,
      },
      { symbol: "sqlite3_wal_hook", what: "WAL frames written", flag: null },
      {
        symbol: "sqlite3_trace_v2",
        what: "statement/profile/row tracing",
        flag: null,
      },
      {
        symbol: "sqlite3_progress_handler",
        what: "interrupt a long query",
        flag: null,
      },
      {
        symbol: "sqlite3_busy_handler",
        what: "wait on a locked database",
        flag: null,
      },
      {
        symbol: "sqlite3_collation_needed",
        what: "supply a collation on demand",
        flag: null,
      },
    ],
  },
  {
    title: "Opt-in capabilities",
    probes: [
      {
        symbol: "sqlite3_unlock_notify",
        what: "wake when another txn releases",
        flag: "SQLITE_ENABLE_UNLOCK_NOTIFY",
      },
      {
        symbol: "sqlite3_column_database_name",
        what: "which db a result column came from",
        flag: "SQLITE_ENABLE_COLUMN_METADATA",
      },
      {
        symbol: "sqlite3_column_table_name",
        what: "which table a result column came from",
        flag: "SQLITE_ENABLE_COLUMN_METADATA",
      },
      {
        symbol: "sqlite3_stmt_scanstatus",
        what: "per-loop query profiling",
        flag: "SQLITE_ENABLE_STMT_SCANSTATUS",
      },
      {
        symbol: "sqlite3_stmt_scanstatus_v2",
        what: "profiling, with cycle counts",
        flag: "SQLITE_ENABLE_STMT_SCANSTATUS",
      },
      {
        symbol: "sqlite3_normalized_sql",
        what: "SQL with literals parameterised",
        flag: "SQLITE_ENABLE_NORMALIZE",
      },
      {
        symbol: "sqlite3_serialize",
        what: "database to a byte array",
        flag: "SQLITE_ENABLE_DESERIALIZE",
      },
      {
        symbol: "sqlite3_deserialize",
        what: "byte array to a database",
        flag: "SQLITE_ENABLE_DESERIALIZE",
      },
    ],
  },
];

/**
 * Compile-time options worth asking about that no symbol reveals.
 *
 * `sqlite3_compileoption_used()` answers for any SQLITE_* option, including the
 * ones that add no exported function. SQLLOG is the reason this section exists:
 * it adds only a `sqlite3_config()` verb (SQLITE_CONFIG_SQLLOG, 21), so symbol
 * probing cannot see it, and a caller that registers the callback against a
 * library built without it silently gets nothing.
 */
const COMPILE_OPTIONS = [
  "ENABLE_SQLLOG",
  "ENABLE_SESSION",
  "ENABLE_PREUPDATE_HOOK",
  "ENABLE_API_ARMOR",
  "ENABLE_DBSTAT_VTAB",
  "ENABLE_EXPLAIN_COMMENTS",
  "ENABLE_FTS5",
  "ENABLE_RTREE",
  "ENABLE_GEOPOLY",
  "ENABLE_MATH_FUNCTIONS",
  "ENABLE_NORMALIZE",
  "ENABLE_STMT_SCANSTATUS",
  "ENABLE_COLUMN_METADATA",
  "ENABLE_UNLOCK_NOTIFY",
  // ENABLE_DESERIALIZE is deliberately absent: since 3.36 serialize/deserialize
  // are on by default and the option is not recorded in the compile-option
  // list, so asking here returns "no" for a library that plainly has the
  // symbols. The symbol probe above is the authoritative answer for it.
  "ENABLE_BYTECODE_VTAB",
  "ENABLE_STMTVTAB",
  "ENABLE_OFFSET_SQL_FUNC",
  "ENABLE_UPDATE_DELETE_LIMIT",
  "SOUNDEX",
  "THREADSAFE=1",
];

/** A `Deno.dlopen` signature we never call: enough to make the linker resolve. */
const PLACEHOLDER = { parameters: [], result: "void" } as const;

/** Result of probing one library. */
interface LibraryReport {
  label: string;
  path: string;
  /** null when the library could not be opened at all. */
  version: string | null;
  error?: string;
  present: Set<string>;
  /** Compile options answered by sqlite3_compileoption_used, when it exists. */
  options: Map<string, boolean>;
}

function probeLibrary(label: string, path: string): LibraryReport {
  const report: LibraryReport = {
    label,
    path,
    version: null,
    present: new Set(),
    options: new Map(),
  };

  // sqlite3_libversion() is the one symbol we call: it proves the library is a
  // real SQLite and not, say, a stub with the right name.
  try {
    const lib = Deno.dlopen(path, {
      sqlite3_libversion: { parameters: [], result: "pointer" },
    });
    const ptr = lib.symbols.sqlite3_libversion();
    report.version = ptr
      ? new Deno.UnsafePointerView(ptr).getCString()
      : "(null)";
    lib.close();
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    return report;
  }

  for (const group of GROUPS) {
    for (const probe of group.probes) {
      // One dlopen per symbol. A dlopen that asked for all of them at once
      // would throw on the first missing one and tell us nothing about the
      // rest, which is the opposite of what a probe is for.
      try {
        const lib = Deno.dlopen(path, { [probe.symbol]: PLACEHOLDER });
        lib.close();
        report.present.add(probe.symbol);
      } catch {
        // Absent. That is a result, not an error.
      }
    }
  }

  // Ask the library itself. Older or heavily trimmed builds may omit
  // sqlite3_compileoption_used (SQLITE_OMIT_COMPILEOPTION_DIAGS); in that case
  // the section is simply reported as unavailable rather than as all-negative,
  // which would be a lie.
  try {
    const lib = Deno.dlopen(path, {
      sqlite3_compileoption_used: { parameters: ["buffer"], result: "i32" },
    });
    for (const option of COMPILE_OPTIONS) {
      const name = new TextEncoder().encode(option + "\0");
      report.options.set(
        option,
        lib.symbols.sqlite3_compileoption_used(name) === 1,
      );
    }
    lib.close();
  } catch {
    // Left empty: render() treats an empty map as "could not ask".
  }
  return report;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function render(reports: LibraryReport[]): void {
  const COL = 18;
  const NAME_W = Math.max(
    32,
    ...GROUPS.flatMap((g) => g.probes.map((p) => p.symbol.length + 2)),
    ...COMPILE_OPTIONS.map((o) => o.length + 9), // "  SQLITE_" + name + a gap
  );

  console.log();
  for (const r of reports) {
    if (r.error) {
      console.log(`  ${r.label}: FAILED TO OPEN ${r.path}\n      ${r.error}`);
    } else {
      console.log(`  ${r.label}: SQLite ${r.version}`);
      console.log(`      ${r.path}`);
    }
  }
  console.log();

  const header = pad("symbol", NAME_W) +
    reports.map((r) => pad(r.label, COL)).join("") +
    "enabled by";
  console.log(header);
  console.log("-".repeat(header.length));

  for (const group of GROUPS) {
    console.log(`\n${group.title}`);
    for (const probe of group.probes) {
      const cells = reports.map((r) =>
        pad(r.present.has(probe.symbol) ? "yes" : "--", COL)
      );
      console.log(
        "  " + pad(probe.symbol, NAME_W - 2) + cells.join("") +
          (probe.flag ?? "(always)"),
      );
    }
  }

  // Compile options the symbol table cannot show (SQLLOG above all).
  if (reports.some((r) => r.options.size > 0)) {
    console.log("\nCompile options (sqlite3_compileoption_used)");
    for (const option of COMPILE_OPTIONS) {
      const cells = reports.map((r) =>
        pad(
          r.options.size === 0 ? "?" : r.options.get(option) ? "yes" : "--",
          COL,
        )
      );
      console.log("  " + pad("SQLITE_" + option, NAME_W - 2) + cells.join(""));
    }
  }

  // The delta is the reason this script exists, so state it rather than leaving
  // the reader to diff columns by eye. The last library is the one under test;
  // every other column is a baseline it is compared against.
  if (reports.length >= 2) {
    const target = reports[reports.length - 1]!;
    const all = GROUPS.flatMap((g) => g.probes);
    for (const base of reports.slice(0, -1)) {
      const gained = all.filter((p) =>
        !base.present.has(p.symbol) && target.present.has(p.symbol)
      );
      const lost = all.filter((p) =>
        base.present.has(p.symbol) && !target.present.has(p.symbol)
      );
      console.log(`\nDelta (${base.label} -> ${target.label})`);
      console.log(
        `  ${base.present.size}/${all.length} symbols  ->  ${target.present.size}/${all.length}`,
      );
      if (gained.length) {
        console.log(
          `  gained (${gained.length}): ${
            gained.map((p) => p.symbol).join(", ")
          }`,
        );
      }
      if (lost.length) {
        console.log(
          `  LOST (${lost.length}): ${lost.map((p) => p.symbol).join(", ")}`,
        );
      }
      if (!gained.length && !lost.length) console.log("  identical");
    }
  }
  console.log();
}

/** The system library, if this machine has one where the usual distros put it. */
export function systemLibrary(): string | undefined {
  const candidates = [
    "/usr/lib/x86_64-linux-gnu/libsqlite3.so.0",
    "/usr/lib/aarch64-linux-gnu/libsqlite3.so.0",
    "/usr/lib64/libsqlite3.so.0",
    "/usr/lib/libsqlite3.so.0",
    "/usr/lib/libsqlite3.dylib",
  ];
  return candidates.find((p) => {
    try {
      return Deno.statSync(p).isFile || Deno.statSync(p).isSymlink;
    } catch {
      return false;
    }
  });
}

/**
 * The prebuilt `@db/sqlite` downloads for itself, if it has been downloaded.
 *
 * This is the library that actually gets loaded when nobody sets
 * DENO_SQLITE_PATH -- i.e. the default -- so it belongs in the comparison even
 * though it is a cache artefact. `@denosaurs/plug` stores it under
 * $DENO_DIR/plug/<host>/<sha256>.so beside a metadata.json naming the URL, so
 * the metadata is what identifies it; the hashed filename says nothing.
 */
export function driverPrebuilt(): string | undefined {
  const denoDir = Deno.env.get("DENO_DIR") ??
    (() => {
      const home = Deno.env.get("HOME");
      return home ? join(home, ".cache", "deno") : undefined;
    })();
  if (!denoDir) return undefined;
  const plug = join(denoDir, "plug");
  const stack = [plug];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory) {
        stack.push(full);
      } else if (entry.name.endsWith(".metadata.json")) {
        let url = "";
        try {
          url = Deno.readTextFileSync(full);
        } catch {
          continue;
        }
        if (!/sqlite3/i.test(url)) continue;
        for (const ext of [".so", ".dylib", ".dll"]) {
          const candidate = full.replace(/\.metadata\.json$/, ext);
          try {
            if (Deno.statSync(candidate).isFile) return candidate;
          } catch { /* try the next extension */ }
        }
      }
    }
  }
  return undefined;
}

if (import.meta.main) {
  const args = Deno.args;
  const reports: LibraryReport[] = [];

  if (args.length > 0) {
    for (const [i, path] of args.entries()) {
      reports.push(
        probeLibrary(args.length === 1 ? "library" : `lib ${i + 1}`, path),
      );
    }
  } else {
    const prebuilt = driverPrebuilt();
    if (prebuilt) reports.push(probeLibrary("@db/sqlite", prebuilt));

    const system = systemLibrary();
    if (system) reports.push(probeLibrary("system", system));
    if (!system && !prebuilt) {
      console.log(
        "(no system or @db/sqlite library found; showing the vendored build only)",
      );
    }

    const vendored = join(
      VENDOR_DIR,
      "lib",
      currentTarget(),
      libraryFileName(),
    );
    try {
      Deno.statSync(vendored);
      reports.push(probeLibrary("vendored", vendored));
    } catch {
      console.error(
        `No vendored library at ${vendored}\n` +
          `  available targets: ${
            availableTargets().join(", ") || "(none)"
          }\n` +
          `  build one with: vendor/build.sh`,
      );
      if (reports.length === 0) Deno.exit(1);
    }
  }

  render(reports);

  const manifest = readManifest();
  if (manifest && args.length === 0) {
    console.log(
      `Vendored build: SQLite ${manifest.sqliteVersion}, ${manifest.flags.length} flags, ` +
        `${
          (manifest.librarySizeBytes / 1024).toFixed(0)
        } KiB, built ${manifest.builtAtUtc}`,
    );
    console.log(`  source sha3-256 ${manifest.sourceSha3_256}`);
    console.log();
  }
}
