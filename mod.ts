/**
 * Row and commit-lifecycle events for a SQLite `Database`, over Deno FFI,
 * plus a JavaScript veto on the values a statement is about to write.
 *
 * ```ts
 * const LIB = "/usr/lib/x86_64-linux-gnu/libsqlite3.so.0";
 * // The driver picks its library at import time, so set this FIRST.
 * Deno.env.set("DENO_SQLITE_PATH", LIB);
 * const { Database } = await import("@jbsiddall/reactive-sqlite/driver");
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
  insideHookOf,
  probeCapabilities,
  SqliteHooksError,
  withEvents,
  withValidation,
} from "./src/hooks.ts";

export type {
  AuthorizeAction,
  AuthorizeEvent,
  Batch,
  BatchCoverage,
  Capabilities,
  Change,
  CollationEncoding,
  CollationEvent,
  DbEvent,
  EventOptions,
  Listener,
  PreUpdate,
  Row,
  RowValue,
  Subscription,
  Validator,
} from "./src/hooks.ts";

export { formatEvent, jsonReplacer } from "./src/format.ts";

export { resolveLibPath } from "./src/lib_path.ts";

export {
  availableTargets,
  currentTarget,
  libraryFileName,
  NoVendoredLibraryError,
  useVendoredSqlite,
  vendoredLibraryPath,
} from "./src/vendored.ts";

export type { Target } from "./src/vendored.ts";

export {
  captureSchemaMap,
  SchemaMap,
  SchemaMapError,
} from "./src/schema_map.ts";

export { DependencyError, extractDependencies } from "./src/dependencies.ts";

export type { Dependencies, ExtractOptions } from "./src/dependencies.ts";

export type {
  ListedTable,
  Resolution,
  SchemaSource,
  TableRef,
} from "./src/schema_map.ts";

export {
  connectionInsideHook,
  isSchemaChangingAction,
  SchemaWatch,
  SchemaWatchError,
  watchSchema,
} from "./src/schema_watch.ts";

export type { RefreshReason, SchemaWatchOptions } from "./src/schema_watch.ts";
