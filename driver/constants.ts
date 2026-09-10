/**
 * SQLite's own numeric constants: result codes, open flags, prepare flags and
 * the five fundamental datatypes.
 *
 * Vendored from the Deno SQLite3 driver
 * (https://github.com/denodrivers/sqlite3), Copyright 2022 DjDeveloperr,
 * licensed under the Apache License, Version 2.0. MODIFIED by the
 * reactive-sqlite-ts authors: restyled to this project's conventions and
 * reduced to the constants this library uses.
 *
 * @module
 */

// Result codes.
export const SQLITE3_OK = 0;
export const SQLITE3_MISUSE = 21;
export const SQLITE3_ROW = 100;
export const SQLITE3_DONE = 101;

// Open flags.
export const SQLITE3_OPEN_READONLY = 0x00000001;
export const SQLITE3_OPEN_READWRITE = 0x00000002;
export const SQLITE3_OPEN_CREATE = 0x00000004;
export const SQLITE3_OPEN_MEMORY = 0x00000080;

// Fundamental datatypes.
export const SQLITE_INTEGER = 1;
export const SQLITE_FLOAT = 2;
export const SQLITE_TEXT = 3;
export const SQLITE_BLOB = 4;
export const SQLITE_NULL = 5;
