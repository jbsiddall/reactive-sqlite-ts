/**
 * A SQLite3 binding for Deno, vendored into this repository.
 *
 * Vendored from the Deno SQLite3 driver
 * (https://github.com/denodrivers/sqlite3), Copyright 2022 DjDeveloperr,
 * licensed under the Apache License, Version 2.0. MODIFIED by the
 * reactive-sqlite-ts authors: restyled to this project's conventions, reduced
 * to the surface this library uses, and corrected for two defects present
 * upstream. See NOTICE.
 *
 * @module
 */
export {
  type AggregateFunctionOptions,
  Database,
  type DatabaseOpenOptions,
  type FunctionOptions,
  SQLITE_VERSION,
  type Transaction,
} from "./database.ts";
export {
  type BindParameters,
  type BindValue,
  type RestBindParameters,
  Statement,
} from "./statement.ts";
export { type BlobOpenOptions, SQLBlob } from "./blob.ts";
export { SqliteError } from "./util.ts";
export { libraryPath } from "./ffi.ts";
