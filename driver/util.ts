/**
 * The small shared helpers: C string conversion, the error type, and the
 * result-code check every FFI call goes through.
 *
 * Vendored from the Deno SQLite3 driver
 * (https://github.com/denodrivers/sqlite3), Copyright 2022 DjDeveloperr,
 * licensed under the Apache License, Version 2.0. MODIFIED by the
 * reactive-sqlite-ts authors: restyled to this project's conventions and
 * reduced to the surface this library uses.
 *
 * @module
 */
import { SQLITE3_DONE, SQLITE3_MISUSE, SQLITE3_OK } from "./constants.ts";
import ffi from "./ffi.ts";

const { sqlite3_errmsg, sqlite3_errstr } = ffi;

const encoder = new TextEncoder();

/** UTF-8 bytes with the NUL terminator SQLite's C API expects. */
export function toCString(str: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(str + "\0");
}

/** Reads a NUL-terminated C string out of the library's memory. */
export const readCstr: (
  pointer: NonNullable<Deno.PointerValue>,
  offset?: number,
) => string = Deno.UnsafePointerView.getCString;

/** Views `length` bytes of the library's memory as an ArrayBuffer. */
export const buf: (
  pointer: NonNullable<Deno.PointerValue>,
  byteLength: number,
  offset?: number,
) => ArrayBuffer = Deno.UnsafePointerView.getArrayBuffer;

/** True for anything `typeof` calls an object and that is not `null`. */
export function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

/** A non-OK SQLite result code, carrying the code itself. */
export class SqliteError extends Error {
  override name = "SqliteError";

  constructor(public code: number = 1, message: string = "Unknown Error") {
    super(`${code}: ${message}`);
  }
}

/**
 * Throws unless `code` says the call succeeded.
 *
 * `db` is the connection to ask for a message. Without it the code alone is
 * translated through `sqlite3_errstr`, which knows the code's generic meaning
 * but nothing about what this connection was doing.
 */
export function unwrap(code: number, db?: Deno.PointerValue): void {
  if (code === SQLITE3_OK || code === SQLITE3_DONE) return;
  if (code === SQLITE3_MISUSE) {
    throw new SqliteError(code, "SQLite3 API misuse");
  }
  if (db !== undefined) {
    const errmsg = sqlite3_errmsg(db);
    if (errmsg === null) throw new SqliteError(code);
    throw new Error(readCstr(errmsg));
  }
  const errstr = sqlite3_errstr(code);
  if (errstr === null) throw new SqliteError(code);
  throw new SqliteError(code, readCstr(errstr));
}
