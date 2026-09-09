/**
 * Row and commit-lifecycle events for a `@db/sqlite` `Database`, over Deno FFI,
 * plus a JavaScript veto on the values a statement is about to write.
 *
 * ```ts
 * const LIB = "/usr/lib/x86_64-linux-gnu/libsqlite3.so.0";
 * // The driver picks its library at import time, so set this FIRST.
 * Deno.env.set("DENO_SQLITE_PATH", LIB);
 * const { Database } = await import("jsr:@db/sqlite@0.13");
 * const { withEvents } = await import("./mod.ts");
 *
 * const db = new Database("app.db");
 * const sub = withEvents(db, (e) => {
 *   if (e.type === "postcommit") console.log(e.changes);
 * }, LIB);
 * ```
 *
 * Run with `--unstable-ffi --allow-ffi` (plus whatever the driver needs).
 *
 * @module
 */

export {
  probeCapabilities,
  SqliteHooksError,
  withEvents,
  withValidation,
} from "./src/hooks.ts";

export type {
  Batch,
  BatchCoverage,
  Capabilities,
  Change,
  DbEvent,
  EventOptions,
  Listener,
  PreUpdate,
  Row,
  RowValue,
  Subscription,
  Validator,
} from "./src/hooks.ts";

export { resolveLibPath } from "./src/lib_path.ts";
