/**
 * Whether the commits on this branch satisfy the four constraints they are
 * written under: attribution, authorship, the strings that must never be
 * published, and references that decay.
 *
 * THE DEFECT THIS EXISTS BECAUSE OF. A commit went to `main` missing its
 * `Co-Authored-By` trailer. Nothing anywhere in this repository read a commit
 * message -- `git log`, `git rev-parse` and the author address appear in no
 * check, no tool and no workflow -- so all four constraints were held by
 * attention and by nothing else.
 *
 * WHY FOUR CHECKS AND NOT ONE, which is what this file is really for. The
 * compliance history here is REAL: every commit in the scoped range satisfies
 * all four, and that evidence argues AGAINST building this. It is the wrong
 * reading. Reliability sustained by one person reading every commit before
 * dispatch is a symptom, not a reassurance, and the question to ask about an
 * invariant that has never been seen to fail is not what would have caught a
 * violation but WHAT WOULD REPORT ONE IF EVERYONE STOPPED LOOKING. Where the
 * answer is "a person", it is not enforced.
 *
 * The corollary decides the scope. Attention-held invariants CLUSTER: whoever
 * was diligent enough to hold one was holding the others, so a check built for
 * only the constraint that happened to be noticed rebuilds the same gap minus
 * one item. The trailer is the one that slipped, and it slipped because all
 * four rested on the same reading -- not because the trailer was special.
 *
 * WHAT IT CHECKS:
 *   1. exactly one `Co-Authored-By: Claude <noreply@anthropic.com>` trailer,
 *      not zero and not two;
 *   2. author and committer are both the human this work is attributed to;
 *   3. no session trailer, no tooling advertisement, and none of the strings
 *      this repository must never publish, in subject or body;
 *   4. no `file.ts:123` reference, which names a line that moves.
 *
 * WHERE IT DOES NOT RUN, said out loud rather than left to be discovered.
 * This is a LOCAL task and is in no CI workflow. `actions/checkout@v4` clones
 * at depth 1 by default, so a runner has no history to read. Raising the depth
 * is a change to the CI step list, and that list is pinned as a set in both
 * directions by `test/ci_workflow.ts`, which would go red on the very change
 * that enabled this. THE DEPTH QUESTION IS LEFT OPEN DELIBERATELY: it has to
 * be decided on its own merits rather than as a side effect of adding a check.
 * Until it is, this gap is UNRESOLVED and not waived -- a check that runs only
 * where someone remembers to run it is weaker than one that runs on a push,
 * and this is currently the former.
 *
 * WHY THERE IS A BASELINE. The commit that prompted this is already on `main`
 * and history here is not rewritten, so the check begins at the commit AFTER
 * `BASELINE`. The SHA is named below rather than described.
 *
 * Run: deno task test:commits
 *
 * @module
 */

/**
 * The last commit not required to satisfy this file, by SHA.
 *
 * `1347a77` IS THE ONE KNOWN NON-CONFORMING COMMIT: it landed on `main`
 * without the trailer, and it is what this file exists because of. It is
 * excluded by being the range's exclusive lower bound, so the gate does not go
 * red on it, and it is NOT backfilled -- rewriting published history to make a
 * check pass would have the check measuring its own edit rather than the work.
 *
 * WHY THIS IS NOT A HOLE A FUTURE VIOLATION COULD SIT IN. The exclusion is one
 * named SHA, not a date, a pattern or a count, so it cannot widen by itself:
 * every commit made after it is checked, and moving the baseline forward to
 * excuse a new violation is a visible edit to this constant in the same commit
 * that violated it. A hand-maintained list of excused commits would have that
 * hole; a single immovable floor does not.
 */
const BASELINE = "1347a77";

/** The one attribution trailer a commit here carries, exactly once. */
const TRAILER = "Co-Authored-By: Claude <noreply@anthropic.com>";

/** The human this work is attributed to, as author and as committer. */
const WHO = { name: "Joseph Siddall", email: "j.b.siddall@gmail.com" };

/**
 * Trailers and advertisements that must NOT appear.
 *
 * These are the default footers of the tooling. They are correct elsewhere and
 * wrong here, which is why they are named: a default is what comes back the
 * moment nobody types the override.
 */
const BANNED_LINES: readonly string[] = [
  "Claude-Session:",
  "Generated with",
  "claude.ai/code",
  "claude.com/claude-code",
];

/**
 * The strings this repository must never publish, base64 so that listing them
 * does not itself publish them.
 *
 * THIS ENCODING IS NOT OBFUSCATION FOR ITS OWN SAKE. A check whose subject is
 * "these words must not appear in this public repository" cannot spell them
 * out in a file in that public repository -- it would be the first violation
 * of its own rule, and someone grepping for one of them would find the guard
 * and conclude the leak had already happened. Uniform across all nine on
 * purpose: deciding case by case which are identifying enough to hide is a
 * judgement the next hand would re-make differently.
 *
 * `decodedNeedles()` is exercised by a control below, so a list that decoded
 * to nothing could not pass as a clean scan.
 */
const NEEDLES_B64: readonly string[] = [
  "dG9wLWhhdA==",
  "dG9waGF0",
  "c3FsaXRlX2hvb2tz",
  "VE9QSEFUXw==",
  "ZXhwZXJpbWVudHM6",
  "ZXh0cmFjdGVkIGZyb20=",
  "cG9ydGVkIGZyb20=",
  "cGFyZW50IHJlcG8=",
  "c3Bpa2U=",
];

export function decodedNeedles(): string[] {
  return NEEDLES_B64.map((b) => atob(b));
}

/**
 * A reference to a line of a file, which is the form that decays.
 *
 * A path alone is fine and is often the right thing to write. A path with a
 * line number is a claim about where something sits today, and the next edit
 * above it makes the claim false with nothing reporting the change.
 */
const FILE_LINE =
  /\b[\w./-]+\.(?:ts|tsx|js|md|json|jsonc|sh|ya?ml|c|h|toml)\s*:\s*\d+/i;

export interface Commit {
  sha: string;
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  /** Subject and body together, exactly as `git log %B` gives them. */
  message: string;
}

export interface Problem {
  rule: string;
  detail: string;
}

/** The four rule names, so a control can name the one it expects. */
export const RULES = {
  trailer: "exactly one attribution trailer",
  author: "authored and committed by the human it is attributed to",
  strings: "carries no string this repository must not publish",
  fileLine: "no file-and-line reference",
} as const;

/**
 * Everything wrong with one commit, or an empty list.
 *
 * Pure, so the fixtures below can present commits that were never made --
 * including a CONFORMING one, because a fixture set in which every case must
 * be rejected cannot tell a working check from one that rejects everything.
 */
export function problemsWith(c: Commit): Problem[] {
  const out: Problem[] = [];

  const trailers = c.message.split("\n").filter((l) => l.trim() === TRAILER);
  if (trailers.length !== 1) {
    out.push({
      rule: RULES.trailer,
      detail: trailers.length === 0
        ? "no `Co-Authored-By` line for the assistant"
        : `${trailers.length} copies of the trailer`,
    });
  }

  for (const banned of BANNED_LINES) {
    if (c.message.includes(banned)) {
      out.push({
        rule: RULES.strings,
        detail: `the message contains ${JSON.stringify(banned)}`,
      });
    }
  }

  if (c.authorName !== WHO.name || c.authorEmail !== WHO.email) {
    out.push({
      rule: RULES.author,
      detail: `author is ${c.authorName} <${c.authorEmail}>`,
    });
  }
  if (c.committerName !== WHO.name || c.committerEmail !== WHO.email) {
    out.push({
      rule: RULES.author,
      detail: `committer is ${c.committerName} <${c.committerEmail}>`,
    });
  }

  const lower = c.message.toLowerCase();
  for (const needle of decodedNeedles()) {
    if (lower.includes(needle.toLowerCase())) {
      out.push({
        rule: RULES.strings,
        detail:
          `the message carries one of the encoded strings (${needle.length} characters, beginning ${
            JSON.stringify(needle.slice(0, 2))
          }) — it is not reproduced here, for the reason the list is encoded`,
      });
    }
  }

  const decayed = FILE_LINE.exec(c.message);
  if (decayed !== null) {
    out.push({
      rule: RULES.fileLine,
      detail: `the message says ${
        JSON.stringify(decayed[0])
      } — the line number is false as soon as anything above it is edited`,
    });
  }

  return out;
}

/** Records from the NUL-and-SOH delimited `git log` format used below. */
export function parseLog(raw: string): Commit[] {
  const out: Commit[] = [];
  for (const record of raw.split("\x01")) {
    if (record.trim() === "") continue;
    const f = record.split("\x00");
    if (f.length < 6) continue;
    out.push({
      sha: (f[0] ?? "").trim(),
      authorName: f[1] ?? "",
      authorEmail: f[2] ?? "",
      committerName: f[3] ?? "",
      committerEmail: f[4] ?? "",
      message: f[5] ?? "",
    });
  }
  return out;
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

const CONFORMING: Commit = {
  sha: "0000000",
  authorName: WHO.name,
  authorEmail: WHO.email,
  committerName: WHO.name,
  committerEmail: WHO.email,
  message:
    `Do the thing\n\nA body about the change, naming test/suite.ts.\n\n${TRAILER}\n`,
};

console.log("commit-constraint controls\n");

{
  // The load-bearing acceptance. Without it every rejection below would pass
  // identically against a function that returned a problem for anything.
  const got = problemsWith(CONFORMING);
  if (got.length === 0) pass("control: a conforming commit is accepted");
  else {
    fail(
      "control: a conforming commit is accepted",
      got.map((p) => `${p.rule}: ${p.detail}`).join("; "),
    );
  }
}

// Each of the four rules gets at least one fixture that must make it FAIL. A
// four-constraint gate nobody has watched fail on each of the four separately
// is one gate wearing four names.
for (
  const c of [
    {
      name: "the trailer is missing",
      rule: RULES.trailer,
      commit: { ...CONFORMING, message: "Do the thing\n\nA body.\n" },
    },
    {
      name: "the trailer appears twice",
      rule: RULES.trailer,
      commit: {
        ...CONFORMING,
        message: `Do the thing\n\n${TRAILER}\n${TRAILER}\n`,
      },
    },
    {
      name: "somebody else is the author",
      rule: RULES.author,
      commit: { ...CONFORMING, authorName: "A Bot", authorEmail: "b@o.t" },
    },
    {
      name: "the committer differs from the author",
      rule: RULES.author,
      commit: { ...CONFORMING, committerEmail: "someone@else" },
    },
    {
      name: "a session trailer rode along",
      rule: RULES.strings,
      commit: {
        ...CONFORMING,
        message:
          `${CONFORMING.message}Claude-Session: https://example.invalid/x\n`,
      },
    },
    {
      name: "a forbidden string is in the body",
      rule: RULES.strings,
      commit: {
        ...CONFORMING,
        message: `Do the thing\n\nThe ${
          decodedNeedles()[2]
        } module was renamed.\n\n${TRAILER}\n`,
      },
    },
    {
      name: "a forbidden string is in the subject",
      rule: RULES.strings,
      commit: {
        ...CONFORMING,
        message: `Rename ${decodedNeedles()[2]}\n\nA body.\n\n${TRAILER}\n`,
      },
    },
    {
      name: "the body cites a line number",
      rule: RULES.fileLine,
      commit: {
        ...CONFORMING,
        message:
          `Do the thing\n\nSee test/suite.ts:412 for it.\n\n${TRAILER}\n`,
      },
    },
  ]
) {
  const got = problemsWith(c.commit);
  const what = `control: ${c.name}`;
  const hit = got.find((p) => p.rule === c.rule);
  if (hit === undefined) {
    fail(
      what,
      got.length === 0
        ? `accepted it; it should have failed "${c.rule}"`
        : `rejected it for ${
          got.map((p) => p.rule).join(", ")
        } rather than "${c.rule}"`,
    );
  } else pass(`${what} → ${hit.detail}`);
}

{
  // Pays for the encoding. A list that decoded to empty strings would make
  // the scan match nothing and report every commit clean.
  const n = decodedNeedles();
  const what = "control: the encoded list decodes to real strings";
  if (n.length === NEEDLES_B64.length && n.every((s) => s.length >= 5)) {
    pass(
      `${what} (${n.length} of them, ${
        n.map((s) => s.length).join("/")
      } characters)`,
    );
  } else fail(what, `decoded to ${n.length} entries`);
}

console.log(`\ncommits after ${BASELINE}\n`);

function git(...args: string[]): { ok: boolean; out: string } {
  try {
    const r = new Deno.Command("git", {
      args,
      stdout: "piped",
      stderr: "piped",
    })
      .outputSync();
    return {
      ok: r.success,
      out: new TextDecoder().decode(r.success ? r.stdout : r.stderr),
    };
  } catch (e) {
    return { ok: false, out: `${e}` };
  }
}

const known = git("cat-file", "-e", `${BASELINE}^{commit}`);
if (!known.ok) {
  // Not a pass. A shallow clone cannot see the baseline, and a run that could
  // not look has established nothing about the commits it did not read.
  fail(
    `the baseline commit ${BASELINE} is in this history`,
    `${known.out.trim()} — a shallow or unrelated checkout cannot answer this, and an unanswered range is UNKNOWN rather than clean`,
  );
} else {
  pass(`the baseline commit ${BASELINE} is in this history`);
  const log = git(
    "log",
    "--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x01",
    `${BASELINE}..HEAD`,
  );
  if (!log.ok) {
    fail("the commit range was read", log.out.trim());
  } else {
    const commits = parseLog(log.out);
    const counted = git("rev-list", "--count", `${BASELINE}..HEAD`);
    const expected = Number.parseInt(counted.out.trim(), 10);
    if (!Number.isNaN(expected) && expected !== commits.length) {
      // The hazard of a textual read is parsing FEWER records than exist and
      // reporting green on the ones it never saw.
      fail(
        "the parse found every commit in the range",
        `git counts ${expected}, the parse found ${commits.length}`,
      );
    } else if (commits.length === 0) {
      fail(
        "the range contains commits to check",
        `nothing after ${BASELINE} — every rule above passed vacuously, which prints identically to a clean history`,
      );
    } else {
      pass(`the parse found every commit in the range (${commits.length})`);
      for (const c of commits) {
        const problems = problemsWith(c);
        const short = c.sha.slice(0, 7);
        const subject = c.message.split("\n")[0] ?? "";
        if (problems.length === 0) pass(`${short} ${subject}`);
        else {
          for (const p of problems) {
            fail(`${short} ${p.rule}`, `${p.detail} — subject: ${subject}`);
          }
        }
      }
    }
  }
}

console.log(
  `\n${passed} passed, ${failed} failed — ${failed === 0 ? "OK" : "FAILURES"}`,
);
