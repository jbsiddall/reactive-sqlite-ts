/**
 * Whether the package can be imported by the specifier its users will type.
 *
 * THE DEFECT THIS EXISTS BECAUSE OF. `src/vendored.ts` computed its `vendor/`
 * directory at MODULE SCOPE, from `fromFileUrl(import.meta.url)`. That call
 * throws a `TypeError` on any URL that is not `file:`, and an installed copy
 * of this package has one: a `jsr:` specifier resolves to a module URL under
 * `https://jsr.io/`. `driver/ffi.ts` imports `src/vendored.ts` unconditionally,
 * so the throw happened while evaluating a dependency, BEFORE `ffi.ts` could
 * read `DENO_SQLITE_PATH` -- which meant setting that variable did not help,
 * and the failure surfaced as a `TypeError` from a path library rather than as
 * this package's `NoVendoredLibraryError`. Both entry points were affected,
 * `mod.ts` as well as `driver/mod.ts`.
 *
 * WHY NO EXISTING TEST COULD HAVE CAUGHT IT. This is the part worth reading
 * twice, because it is not "somebody forgot a case". Every other test in this
 * repository loads the code from a `file:` URL -- from the working tree, which
 * is the one configuration in which the defect cannot occur. No test written
 * in that harness could have failed, however carefully it was written. The
 * suite's execution context differed from the shipped one in a way that made
 * an entire failure mode invisible, and the general form is: THE PACKAGE IS
 * NEVER IMPORTED BY THE SPECIFIER ITS USERS WILL TYPE. That is greppable --
 * ask whether anything here imports the package the way a consumer does -- and
 * before this file the answer was no.
 *
 * WHY LOOPBACK HTTP AND NOT jsr.io. Nothing is published yet, and a check that
 * needed the network to say anything would be a check that says nothing on the
 * day the network is down. What the defect turns on is only the SCHEME: the
 * assertion that throws is `@std/path`'s, and it rejects everything that is not
 * `file:`. `http:` and `https:` fail it identically, measured on 2026-09-10 as
 * the same `TypeError: URL must be a file URL:` from the same
 * `_common/from_file_url.ts`. So a tree served over loopback reproduces the
 * condition exactly, with no network and no publish.
 *
 * WHAT THE SERVER REWRITES, AND WHY THAT IS NOT CHEATING. Deno does not apply
 * a local import map to remote modules, so the bare specifier `@std/path` would
 * not resolve over `http:`. In the real thing, the package's own JSR manifest
 * carries that resolution. Here the server does it, from this repository's
 * `deno.json` `imports` -- the same mapping, applied at the same point in the
 * pipeline. It rewrites specifiers and nothing else; no source under test is
 * modified.
 *
 * THE TWO FIXTURES ARE THE POINT. A check whose only assertion is that the
 * real import succeeds goes green the moment the harness breaks, and it is
 * then a green test sitting inside the identical blind spot -- which is worse
 * than no check, because it retires the finding. So the harness is made to
 * prove, on every run, that it can still tell the two outcomes apart:
 *
 *   - a fixture that DOES what the defect did -- `fromFileUrl(import.meta.url)`
 *     at module scope -- must THROW. If this stops throwing, the harness has
 *     lost the ability to see the defect and the run fails, whatever the real
 *     import did.
 *   - a fixture that does nothing must NOT throw, because a harness that
 *     rejects everything cannot distinguish anything either.
 *
 * THE RELOAD IS LOAD-BEARING. Deno caches remote modules, so without
 * `--reload` scoped to this origin the check would import whatever it fetched
 * on some earlier run and report on source that is no longer in the tree. That
 * was observed while building this file: the first run after the fix landed
 * still failed, on the cached pre-fix copy. A check reporting on stale source
 * is the same green-inside-the-blind-spot failure the fixtures above guard
 * against, arriving by a different route -- so the flag lives in the task and
 * must not be dropped from it.
 *
 * `--no-lock` GOES WITH IT. The served specifiers carry an ephemeral port and
 * their content changes with every edit to the tree, so recording integrity
 * hashes for them in `deno.lock` locks a hash of a file that is about to
 * change. The first run to do so failed the NEXT run with an integrity error
 * against the pre-fix source. Nothing about these URLs is worth locking.
 *
 * Run: deno task test:installed-import
 *
 * @module
 */

import { dirname, fromFileUrl, join } from "@std/path";

/** This repository's root, from this file's own location. */
const ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

/**
 * The loopback port the tree is served on.
 *
 * Fixed rather than ephemeral because `--allow-import` is a startup flag and
 * has to name the port before the server exists. A port already in use is
 * reported as a REFUSAL to conclude, never as a pass: see the bind below.
 */
const PORT = 8977;

const ORIGIN = `http://127.0.0.1:${PORT}`;

/** Narrowing helper: `as` proves nothing, so every shape is checked. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whatever the error was, as an Error, without asserting it already is one. */
function errorOf(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}

/** One string-to-string section of `deno.json`, or an empty one. */
function configSection(key: string): Record<string, string> {
  const parsed: unknown = JSON.parse(stripLineComments(
    Deno.readTextFileSync(join(ROOT, "deno.json")),
  ));
  if (!isRecord(parsed)) return {};
  const section = parsed[key];
  if (!isRecord(section)) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(section)) {
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

/**
 * The entry points a consumer can name, which is exactly `exports` in
 * `deno.json`. Read from the file rather than listed here: a hand-kept copy
 * would go stale the day an export is added, and the export that is not
 * checked is the one that breaks.
 */
function entryPoints(): string[] {
  return Object.values(configSection("exports"));
}

/** The import map, for the specifier rewrite described in the module comment. */
function importMap(): Record<string, string> {
  return configSection("imports");
}

/**
 * `deno.json` carries `//`-prefixed comment keys and comment arrays that
 * `JSON.parse` will not take. Only whole-line comments are stripped, so a `//`
 * inside a string value -- every URL in the file has one -- is left alone.
 */
function stripLineComments(text: string): string {
  return text.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
}

interface Finding {
  ok: boolean;
  what: string;
  detail: string;
}
const ok = (what: string): Finding => ({ ok: true, what, detail: "" });
const bad = (what: string, detail: string): Finding => ({
  ok: false,
  what,
  detail,
});

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

/**
 * A module that reproduces the defect, and one that cannot.
 *
 * Served from memory rather than written into the repository: they are the
 * harness's own instruments, not source anybody should import.
 */
const FIXTURES: Record<string, { source: string; mustThrow: boolean }> = {
  "/__fixture__/reproduces.ts": {
    source:
      `import { fromFileUrl } from ${
        JSON.stringify(importMap()["@std/path"])
      };\n` +
      `export const dir = fromFileUrl(import.meta.url);\n`,
    mustThrow: true,
  },
  "/__fixture__/inert.ts": {
    source: `export const fine = true;\n`,
    mustThrow: false,
  },
};

/**
 * The other half of the post-condition: importing must not throw, AND the
 * no-library case must still fail as this package's own error at the point of
 * use. Over a non-file: URL there is no `vendor/` directory to find -- a
 * registry carries source, not built libraries -- so `vendoredLibraryPath()`
 * has nothing to return and must say so in the one way a caller can act on.
 *
 * Asserting the CLASS and not merely that something threw is the point. The
 * defect was a throw of the wrong class from the wrong place; a check that
 * accepted any throw would have passed against it.
 */
const POINT_OF_USE = "/__fixture__/point_of_use.ts";
FIXTURES[POINT_OF_USE] = {
  source: `import { vendoredLibraryPath } from "/src/vendored.ts";
export function call(): string {
  try {
    return "returned " + vendoredLibraryPath();
  } catch (e) {
    return (e as Error).name;
  }
}
`,
  mustThrow: false,
};

/** Serve the tree, with bare specifiers resolved the way JSR's manifest does. */
function serve(signal: AbortSignal): Promise<void> {
  const map = Object.entries(importMap());
  const server = Deno.serve({
    port: PORT,
    hostname: "127.0.0.1",
    signal,
    onListen: () => {},
  }, (request) => {
    const path = new URL(request.url).pathname;
    const fixture = FIXTURES[path];
    if (fixture) return typescript(fixture.source);
    // Confine reads to the repository: a served path is a URL, and `..` in one
    // must not reach outside the tree being published.
    const resolved = join(ROOT, path);
    if (!resolved.startsWith(ROOT + "/")) {
      return new Response("outside the tree", { status: 403 });
    }
    let body: string;
    try {
      body = Deno.readTextFileSync(resolved);
    } catch {
      return new Response("not found", { status: 404 });
    }
    for (const [bare, target] of map) {
      body = body.replaceAll(`"${bare}"`, `"${target}"`);
    }
    return typescript(body);
  });
  return server.finished;
}

const typescript = (body: string) =>
  new Response(body, { headers: { "content-type": "application/typescript" } });

/** Import one specifier and say only whether evaluating it threw. */
async function evaluate(
  specifier: string,
): Promise<{ threw: false } | { threw: true; name: string; message: string }> {
  try {
    await import(specifier);
    return { threw: false };
  } catch (thrown) {
    const error = errorOf(thrown);
    return {
      threw: true,
      name: error.name,
      message: error.message.split("\n")[0] ?? "",
    };
  }
}

// A port already in use means the check cannot run. That is UNKNOWN, and
// UNKNOWN is reported as a failure: a check that quietly does nothing when its
// port is busy is a check that passes on the day it is needed.
const controller = new AbortController();
let finished: Promise<void>;
try {
  finished = serve(controller.signal);
} catch (thrown) {
  console.log(
    `  FAIL  the tree was served on ${ORIGIN} — ${errorOf(thrown).message}`,
  );
  console.log(`\n0 passed, 1 failed — FAILURES`);
  Deno.exit(1);
}
record(ok(`the tree was served on ${ORIGIN}`));

console.log("\nthe harness can still tell the two outcomes apart\n");
for (const [path, fixture] of Object.entries(FIXTURES)) {
  if (path === POINT_OF_USE) continue;
  const result = await evaluate(ORIGIN + path);
  const what = fixture.mustThrow
    ? `${path} still throws, so a module-scope fromFileUrl is still detectable`
    : `${path} does not throw, so the harness is not rejecting everything`;
  if (result.threw === fixture.mustThrow) {
    record(ok(what));
  } else {
    record(bad(
      what,
      result.threw
        ? `threw ${result.name}: ${result.message}`
        : "evaluated without throwing",
    ));
  }
}

console.log(`\nevery entry point, imported over ${ORIGIN}\n`);
for (const entry of entryPoints()) {
  const specifier = ORIGIN + entry.replace(/^\./, "");
  const result = await evaluate(specifier);
  const what = `${entry} evaluates under a non-file: URL`;
  if (!result.threw) {
    record(ok(what));
  } else {
    record(bad(
      what,
      `${result.name}: ${result.message}` +
        (result.name === "TypeError" && /file URL/.test(result.message)
          ? " — this is the defect this file exists for: something reachable from this entry point calls fromFileUrl(import.meta.url) at module scope"
          : ""),
    ));
  }
}

console.log("\nwhat a caller gets when no library can be found\n");
{
  const what =
    "vendoredLibraryPath() fails as NoVendoredLibraryError at the point of use";
  try {
    const mod: unknown = await import(ORIGIN + POINT_OF_USE);
    const call = isRecord(mod) ? mod.call : undefined;
    if (typeof call !== "function") {
      record(bad(what, "the fixture exported no call()"));
    } else {
      const got: unknown = call();
      record(
        got === "NoVendoredLibraryError" ? ok(what) : bad(
          what,
          `got ${
            JSON.stringify(got)
          } — the failure a user meets is not this package's own error`,
        ),
      );
    }
  } catch (thrown) {
    const error = errorOf(thrown);
    record(bad(
      what,
      `the fixture did not even evaluate: ${error.name}: ${
        error.message.split("\n")[0]
      }`,
    ));
  }
}

controller.abort();
await finished;

console.log(
  `\n${passed} passed, ${failed} failed — ${failed === 0 ? "OK" : "FAILURES"}`,
);
