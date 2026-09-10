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
 * Reads only Markdown. Opens no library, needs no FFI and no git.
 *
 * Run: deno task test:docs-literals
 *
 * @module
 */

/** The documents this scans. Relative to the repository root. */
const DOCUMENTS: readonly string[] = [
  "README.md",
  "DOMAIN_KNOWLEDGE.md",
  "DRIVER_DEFECTS.md",
  "CONTRIBUTING.md",
];

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

console.log("\nthe documents\n");

// The enumeration receipt. A scan that read no spans would report every
// document clean, and "0 wrapped" and "0 examined" print identically unless
// the second number is on the page. It is a FAILURE rather than a note: a run
// that examined nothing has not checked anything.
let examined = 0;
let read = 0;

for (const doc of DOCUMENTS) {
  let text: string;
  try {
    text = Deno.readTextFileSync(new URL(`../${doc}`, import.meta.url));
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
    "every listed document was read",
    `${read} of ${DOCUMENTS.length} — the findings above are about a subset`,
  );
} else {
  pass(`every listed document was read (${read})`);
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
