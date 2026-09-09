/**
 * A refusal branch that exists only to be disabled.
 *
 * `tools/capability_coverage.ts` decides whether a real refusal is exercised
 * by rewriting its `if` to `if (false)`, type-checking the result and re-running
 * the suite. That machinery has one positive control on this machine — the
 * system library's missing SQLITE_ENABLE_NORMALIZE — and pointing the audit at
 * a library that HAS normalize used to take the control away and, with it, the
 * audit: it refused to run at all.
 *
 * This file is the control that does not depend on any library. It has the
 * shape the rewriter looks for — a single-line `if (...) {` immediately above a
 * uniquely worded message — and a self-test that PASSES while the branch is
 * intact and FAILS once it is disabled. Running the audit's own rewrite over
 * it, and seeing the self-test flip, says the rewrite located a branch,
 * produced source that still compiles, and changed behaviour. Those are the
 * three things the audit infers from a suite result, and they are now watched
 * happening on every run rather than assumed from one library's absence.
 *
 * What it does NOT cover: the semantic suite itself. This canary is re-run in
 * milliseconds where the suite takes seconds, which is why the control is
 * affordable on every invocation, but it means the control proves the rewrite
 * works — not that the suite would have noticed.
 *
 * Nothing imports this at run time and `tools/` is not published. It is a
 * fixture, and it is in `tools/` rather than `test/` because it belongs to the
 * audit and would otherwise read as a test of the library.
 *
 *   deno run tools/canary_branch.ts   # exits 0 intact, non-zero when disabled
 */

/** Refuses when `loud`. The refusal is the whole point. */
export function canary(loud: boolean): string {
  if (loud) {
    throw new Error("CANARY: the guarded branch was taken");
  }
  return "quiet";
}

if (import.meta.main) {
  if (canary(false) !== "quiet") {
    console.error("canary: the unguarded path is wrong");
    Deno.exit(1);
  }
  let refused = false;
  try {
    canary(true);
  } catch {
    refused = true;
  }
  if (!refused) {
    console.error("canary: the guarded branch did not refuse");
    Deno.exit(1);
  }
  console.log("canary: intact");
}
