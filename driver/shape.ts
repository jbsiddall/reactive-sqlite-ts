/**
 * The driver's one unchecked conversion, given a name.
 *
 * `stmt.get<{ c: number }>()` asks for a shape that exists only at runtime:
 * SQLite returns whatever the query's columns turn out to be, and the caller
 * names what they expect. The driver cannot verify that — there is no value to
 * narrow and no predicate to write, because the object is assembled column by
 * column from the C API a moment before it is returned.
 *
 * `project/no-type-assertion` bans `as` because it "silences the type checker
 * without proving anything". This proves nothing either. The difference is
 * that it proves nothing ONCE, under a name, in a file whose whole subject is
 * that boundary — rather than nineteen times, scattered through the row
 * readers, where each one looks like a local tidiness fix. If a caller's type
 * parameter is wrong, this is where the lie enters.
 *
 * Nothing outside this directory should use it.
 *
 * @module
 */

/**
 * Returns `value` under whatever type the caller asked for, unchecked.
 *
 * @see the module comment — this is an assertion, not a conversion.
 */
export function shaped<T>(value: unknown): T;
export function shaped(value: unknown): unknown {
  return value;
}
