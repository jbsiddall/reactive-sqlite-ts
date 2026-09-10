/**
 * The part of a captured child's output that a one-line failure report carries.
 *
 * Every failure line in this suite has the same job: a human reads it, alone,
 * without the file the output came from. The whole output is usually too long
 * for that and the obvious economy — keep the last N characters — is the wrong
 * one. A Deno uncaught error puts its message at the TOP and its stack frames
 * at the bottom, so a tail-only excerpt deletes the diagnosis and keeps the
 * scenery. This keeps both ends and says, in the middle, how much it dropped.
 *
 * It lives in its own module because four call sites in two files wanted it and
 * a second copy would be a second provenance: two truncations that look alike,
 * drift apart, and leave a reader unsure which one produced the line in front
 * of them.
 */

/**
 * Characters kept from each end when no budget is given.
 *
 * 400 because a Deno uncaught error's message line plus its first few stack
 * frames fit in that.
 */
export const EXCERPT_BUDGET = 400;

/** Marks the cut, and says how much was cut. Asserted on, so it is one string. */
export function elisionMarker(dropped: number): string {
  return `... [${dropped} characters elided] ...`;
}

/**
 * `raw`, trimmed, reduced to `budget` characters from each end.
 *
 * Below `2 * budget` the input is returned WHOLE and printed once — a
 * truncation that prints its input twice on the short path is worse than no
 * truncation. Above it, the join carries {@linkcode elisionMarker} with the
 * count of what was dropped, so a reader can see that something was cut
 * instead of wondering whether the output simply ended there.
 *
 * `budget` is per side, not a total. A call site that previously kept N
 * characters of tail should pass N, which keeps everything it printed before
 * and adds a head of the same size.
 */
export function excerpt(raw: string, budget: number = EXCERPT_BUDGET): string {
  const text = raw.trim();
  if (text.length <= budget * 2) return text;
  const dropped = text.length - budget * 2;
  return `${text.slice(0, budget)}\n${elisionMarker(dropped)}\n${
    text.slice(-budget)
  }`;
}
