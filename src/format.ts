/**
 * Rendering events for a human to read in a log. Not a decoder: it does not
 * interpret a value, it only makes the raw one printable.
 *
 * `JSON.stringify(event)` throws, because an INTEGER always decodes to a
 * bigint and JSON.stringify refuses bigints. That is the first thing anyone
 * tries, so the fix ships with the library.
 */
import type { DbEvent } from "./hooks.ts";

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * A `JSON.stringify` replacer for values these events carry. Pass it when you
 * have your own stringify call; reach for {@linkcode formatEvent} otherwise.
 *
 * A bigint becomes its decimal digits as a string, always — never a number
 * when it happens to fit, because that would make the JavaScript type depend
 * on the value, which is the thing decoding to bigint everywhere avoids. The
 * cost is that an INTEGER and a TEXT column holding the same digits print
 * alike. A blob becomes SQLite's own `x'..'` literal, which is readable and
 * pastes back into SQL.
 */
export function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return `x'${hex(value)}'`;
  return value;
}

/**
 * One event as JSON a person can read, with `space` passed through to
 * `JSON.stringify` for indentation.
 *
 * ```ts
 * withEvents(db, (e) => console.log(formatEvent(e)), LIB);
 * ```
 */
export function formatEvent(event: DbEvent, space?: number): string {
  return JSON.stringify(event, jsonReplacer, space);
}
