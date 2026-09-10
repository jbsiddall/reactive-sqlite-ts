/**
 * Whether any inline code span in the documents is broken across a line.
 *
 * THE DEFECT THIS EXISTS BECAUSE OF. A record of a measured error message was
 * written as an inline code span that `deno fmt` then wrapped, leaving the
 * literal split over two lines inside its backticks. It renders correctly, so
 * nothing looked wrong; but the string a reader would grep for is no longer in
 * the file, and the whole reason to record an exact message is that somebody
 * later searches for it. A record that cannot be found by its own contents is
 * not a record.
 *
 * THE CLASS IS WIDER THAN THE INSTANCE, and that is why this is a check rather
 * than a cleanup. When the first one was found, a scan turned up six across
 * two files, only one of them recent. Six instances is not six mistakes; it is
 * a region with no control over it. `deno fmt` accepts every one of them --
 * indeed it PRODUCES them, wrapping a long line through a span it does not
 * treat as atomic -- and nothing else in the gate reads the documents at all.
 * Fixing the six without this file would leave the next one to be written by
 * the formatter on the next long line.
 *
 * WHY THE SCAN IS SHAPED THE WAY IT IS. The obvious regex for "a backtick, a
 * newline, a backtick" is wrong, and measurably so: written that way it
 * matched from the close of one span to the open of the NEXT one and reported
 * 386 hits in a file containing five. The pattern was not detecting wrapped
 * spans, it was detecting adjacent spans, and it happened to be pointed at a
 * file with enough of both to look plausible. So the delimiters are not
 * matched in pairs at all: the text is split on the backtick character and
 * every ODD segment is the inside of a span by construction. That cannot
 * straddle a boundary because there are no boundaries left to straddle.
 *
 * Fenced blocks are blanked first, line for line so the numbering survives.
 * Inside a fence a newline between backticks is the normal case and flagging
 * it would make the check useless.
 *
 * KNOWN LIMIT, stated rather than discovered later: every backtick is a
 * delimiter to this scan, so a document that used a double-backtick span to
 * quote a literal backtick would be counted wrongly from that point on. No
 * document here does; if one ever does, this comment is the warning that the
 * scan needs a real tokeniser rather than a patch.
 *
 * WHERE THE DOCUMENT SET COMES FROM, and why it is not written down. This
 * began as a hand-written list of four, and the list was already wrong: it
 * omitted vendor/README.md, 317 lines carrying 278 backticks and 121 code
 * spans, which no check had ever read. A hand-maintained list is an invariant
 * held by attention, and attention failing is the entire subject of this file
 * -- so the list is gone and the set is asked for instead.
 *
 * WHY `git ls-files` RATHER THAN A DIRECTORY WALK, which is the interesting
 * choice because the walk is cheaper. These are not two ways to compute one
 * answer at different prices. They compute DIFFERENT SETS. `git ls-files` is
 * the Markdown this repository tracks and ships. A `readDir` walk is whatever
 * Markdown happens to be on the disk of whoever ran it: untracked scratch,
 * build output, a draft somebody left lying around. The domain this check is
 * about is the documents the project publishes, and that is the tracked set.
 *
 * The walk was measured before being rejected, so that nobody has to price it
 * again. MEASURED at the time of writing: the two agree exactly, five files
 * each, and the walk would have kept this task at `--allow-read` alone -- it
 * was deliberately the one task in the gate needing neither FFI nor a
 * subprocess. That placement is real and it loses. The walk's extra hits are
 * not harmless noise: a check that fires on files nobody ships teaches people
 * to ignore it, and the first fix anyone reaches for is an exclusion list --
 * a hand-maintained set, which is the exact class this derivation exists to
 * delete, returning one layer down. Buying the permission back by matching
 * exactly over the wrong domain is the defect being fixed here, committed
 * knowingly inside its own fix.
 *
 * So the task grants `--allow-run=git`, scoped to git and to nothing else.
 * The tradeoff is priced above rather than merely asserted; the price is one
 * subprocess permission on the only task that had none.
 *
 * Deriving opens a hole that naming did not, and it is guarded below. A
 * listing that returns nothing -- not a repository, a wrong cwd, a pathspec
 * that stops matching -- scans zero documents and prints exactly like a clean
 * tree. `test/commit_trailers.ts` already refuses that shape for an empty
 * commit range; a check that knows how to refuse a vacuous pass should not
 * have a sibling that accepts one. So the set must be non-empty AND must
 * contain `REQUIRED`, and both refusals are watched firing below.
 *
 * `git ls-files` reads the index, so it answers at depth 1 and none of this
 * touches how deep a checkout is.
 *
 * Reads only Markdown, and asks git which. Opens no library and needs no FFI.
 *
 * Run: deno task test:docs-literals
 *
 * @module
 */

/**
 * A document that must turn up in any correct listing of this repository.
 *
 * README.md, because it cannot plausibly leave: `deno.json` publishes it, it
 * is the first thing a consumer of the package reads, and the capability table
 * is spliced into it by `tools/capability_table.ts` on every run. If a listing
 * comes back without it, it is not a listing of this repository, and every
 * clean result below is about something else.
 */
export const REQUIRED = "README.md";

/** The repository root: this file lives in test/. */
const ROOT = new URL("../", import.meta.url);

/**
 * The Markdown files git tracks, as repository-relative paths, sorted.
 *
 * `pathspec` is a parameter only so the empty case can be produced from the
 * real command rather than simulated: a pathspec matching nothing exercises
 * the same subprocess, the same parse and the same refusal that a broken
 * checkout would. Callers other than that control pass nothing.
 *
 * A failed git invocation returns an empty list rather than throwing, which
 * `setProblem` then refuses -- an unanswerable question is UNKNOWN, and
 * UNKNOWN is a failure here, not a pass.
 */
export function trackedMarkdown(pathspec = "*.md"): string[] {
  let out: string;
  try {
    const r = new Deno.Command("git", {
      // cwd and --full-name together, because `git ls-files` reports paths
      // relative to where it was run: without both, running the task from a
      // subdirectory would list a different set under different names.
      cwd: ROOT,
      args: ["ls-files", "-z", "--full-name", "--", pathspec],
      stdout: "piped",
      stderr: "piped",
    }).outputSync();
    if (!r.success) return [];
    out = new TextDecoder().decode(r.stdout);
  } catch {
    return [];
  }
  return out.split("\0").filter((p) => p.length > 0).sort();
}

/**
 * What is wrong with a derived document set, or null if nothing is.
 *
 * Pure, so both refusals can be seen firing on inputs no listing would return.
 */
export function setProblem(docs: readonly string[]): string | null {
  if (docs.length === 0) {
    return "git tracks no Markdown here — a scan over zero documents reports every literal intact, which prints identically to a clean tree";
  }
  if (!docs.includes(REQUIRED)) {
    return `the listing has ${docs.length} document${
      docs.length === 1 ? "" : "s"
    } but not ${REQUIRED}, which cannot be absent from this repository — so this is not a listing of it, and the results below are about another tree`;
  }
  return null;
}

interface Span {
  /** 1-based line on which the span opens. */
  line: number;
  /** The text between the backticks, newlines and all. */
  text: string;
}

/**
 * Every fenced block replaced by blank lines, preserving the line count.
 *
 * Line-for-line rather than by deletion because every finding below is
 * reported as a line number, and a scan that renumbers the file it is
 * describing sends the reader to the wrong place.
 */
export function blankFences(text: string): string {
  const out: string[] = [];
  let inside = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) {
      inside = !inside;
      out.push("");
      continue;
    }
    out.push(inside ? "" : line);
  }
  return out.join("\n");
}

/**
 * Every inline code span in the text, with the line it opens on.
 *
 * Pure, and exported so the fixtures below can feed it text that no file on
 * disk contains -- which is the only way to watch it both find something and
 * find nothing.
 */
export function spansOf(markdown: string): Span[] {
  const parts = blankFences(markdown).split("`");
  const spans: Span[] = [];
  let line = 1;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? "";
    if (i % 2 === 1) spans.push({ line, text: part });
    line += part.split("\n").length - 1;
  }
  // A trailing odd count means an unclosed backtick: the last "span" is really
  // the rest of the document. Dropping it is right -- it is not a span -- and
  // saying so is what keeps a malformed file from reading as one clean hit.
  if (parts.length % 2 === 0 && spans.length > 0) spans.pop();
  return spans;
}

/** The spans that are broken across a line. */
export function wrappedSpans(markdown: string): Span[] {
  return spansOf(markdown).filter((s) => s.text.includes("\n"));
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
 * The fixtures.
 *
 * HETEROGENEOUS ON PURPOSE. A set in which every case must come back with a
 * hit cannot tell a working scan from one that reports a hit for everything,
 * so the cases that must come back EMPTY are the load-bearing half -- and the
 * adjacent-spans case is the exact input the first attempt got wrong, kept
 * here as the thing that would catch it coming back.
 */
const FIXTURES: readonly {
  name: string;
  text: string;
  wraps: number;
  firstLine?: number;
}[] = [
  {
    name: "one span broken across a line",
    text: "a `no such table:\nsqlite_stat4` b\n",
    wraps: 1,
    firstLine: 1,
  },
  {
    name: "the same literal on one line",
    text: "a `no such table: sqlite_stat4` b\n",
    wraps: 0,
  },
  {
    name: "two separate spans on adjacent lines",
    text: "the `--allow-ffi` flag\nand the `--allow-read` flag\n",
    wraps: 0,
  },
  {
    name: "a newline between backticks inside a fence",
    text: "```\n`no such table:\nsqlite_stat4`\n```\n",
    wraps: 0,
  },
  {
    name: "a wrap after a fence, reported at its own line",
    text: "```\nx\n```\nthen `a long\nliteral` here\n",
    wraps: 1,
    firstLine: 4,
  },
  {
    name: "no code spans at all",
    text: "plain prose with no backticks whatsoever\n",
    wraps: 0,
  },
  {
    name: "an unclosed backtick is not a span",
    text: "a stray ` backtick\nand more prose\n",
    wraps: 0,
  },
];

console.log("scan controls\n");
for (const f of FIXTURES) {
  const got = wrappedSpans(f.text);
  const what = `control: ${f.name}`;
  if (got.length !== f.wraps) {
    fail(what, `found ${got.length} wrapped spans, expected ${f.wraps}`);
    continue;
  }
  if (f.firstLine !== undefined && got[0]?.line !== f.firstLine) {
    fail(
      what,
      `found it at line ${got[0]?.line}, expected line ${f.firstLine}`,
    );
    continue;
  }
  pass(`${what} → ${got.length}`);
}

/**
 * The refusals the derived set needs, each watched failing.
 *
 * A refusal that has never fired is an argument, not a control, and these two
 * are exactly the cases a live tree will not produce on demand.
 */
const SET_FIXTURES: readonly {
  name: string;
  docs: string[];
  rejected: boolean;
}[] = [
  { name: "the listing came back empty", docs: [], rejected: true },
  {
    name: `the listing came back without ${REQUIRED}`,
    docs: ["CONTRIBUTING.md", "vendor/README.md"],
    rejected: true,
  },
  {
    name: "a set with documents in it, one of them the required one",
    docs: [REQUIRED, "vendor/README.md"],
    rejected: false,
  },
  {
    name: `a set of one, the required one`,
    docs: [REQUIRED],
    rejected: false,
  },
];

for (const f of SET_FIXTURES) {
  const problem = setProblem(f.docs);
  const what = `control: ${f.name}`;
  if (f.rejected && problem === null) {
    fail(what, "accepted — the refusal did not fire");
  } else if (!f.rejected && problem !== null) {
    fail(what, `rejected — ${problem}`);
  } else {
    pass(`${what} → ${problem === null ? "accepted" : problem}`);
  }
}

// And git itself, invoked for real with a pathspec nothing matches. The
// fixtures above exercise the predicate on sets no repository would return;
// this exercises the code that BUILDS the set -- the subprocess, its exit
// status, the NUL parse -- so an empty result is observed rather than
// supposed. If git were missing or this were not a repository, the same line
// would go red, which is the behaviour wanted.
{
  const none = trackedMarkdown("*.no-such-extension");
  const what = "control: the tracked listing for a pathspec nothing matches";
  const problem = setProblem(none);
  if (none.length !== 0) {
    fail(what, `found ${none.length}: ${none.join(", ")}`);
  } else if (problem === null) {
    fail(what, "the listing returned nothing and the set was accepted anyway");
  } else {
    pass(`${what} → 0 files, refused: ${problem}`);
  }
}

console.log("\nthe documents\n");

const DOCUMENTS = trackedMarkdown();

const problem = setProblem(DOCUMENTS);
if (problem !== null) fail("git produced a usable document set", problem);
else {pass(
    `git tracks ${DOCUMENTS.length} Markdown files, ${REQUIRED} among them`,
  );}

// The enumeration receipt. A scan that read no spans would report every
// document clean, and "0 wrapped" and "0 examined" print identically unless
// the second number is on the page. It is a FAILURE rather than a note: a run
// that examined nothing has not checked anything.
let examined = 0;
let read = 0;

for (const doc of DOCUMENTS) {
  let text: string;
  try {
    text = Deno.readTextFileSync(new URL(doc, ROOT));
  } catch (e) {
    fail(`${doc} was read`, `${e}`);
    continue;
  }
  read++;
  const all = spansOf(text);
  examined += all.length;
  const wrapped = wrappedSpans(text);
  if (wrapped.length === 0) {
    pass(`${doc}: ${all.length} code spans, none broken across a line`);
    continue;
  }
  for (const s of wrapped) {
    fail(
      `${doc}:${s.line} keeps its literal greppable`,
      `the span reads ${
        JSON.stringify(s.text)
      } — it is split across a line, so the string it records cannot be found by searching for it. Rewrite the sentence so \`deno fmt\` has somewhere else to break.`,
    );
  }
}

if (read !== DOCUMENTS.length) {
  fail(
    "every document git listed was read",
    `${read} of ${DOCUMENTS.length} — the findings above are about a subset`,
  );
} else {
  pass(`every document git listed was read (${read})`);
}

if (examined === 0) {
  fail(
    "the scan examined some code spans",
    "0 spans across every document — a scan that reads nothing reports everything clean",
  );
} else {
  pass(`the scan examined ${examined} code spans across ${read} documents`);
}

console.log(
  `\n${passed} passed, ${failed} failed — ${failed === 0 ? "OK" : "FAILURES"}`,
);
