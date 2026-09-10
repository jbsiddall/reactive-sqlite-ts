/**
 * Incremental BLOB I/O: `sqlite3_blob_open` and the streams over it.
 *
 * Vendored from the Deno SQLite3 driver
 * (https://github.com/denodrivers/sqlite3), Copyright 2022 DjDeveloperr,
 * licensed under the Apache License, Version 2.0. MODIFIED by the
 * reactive-sqlite-ts authors: restyled to this project's conventions and
 * reduced to the surface this library uses.
 *
 * @module
 */
import type { Database } from "./database.ts";
import ffi from "./ffi.ts";
import { toCString, unwrap } from "./util.ts";

const {
  sqlite3_blob_open,
  sqlite3_blob_bytes,
  sqlite3_blob_close,
  sqlite3_blob_read,
  sqlite3_blob_write,
} = ffi;

/** How to open a BLOB for streamed I/O. See {@linkcode Database.openBlob}. */
export interface BlobOpenOptions {
  /** Open read-only. True by default. */
  readonly?: boolean;
  /** The schema the table is in. `"main"` by default. */
  db?: string;
  /** The table the BLOB column belongs to. */
  table: string;
  /** The BLOB column. */
  column: string;
  /** The rowid of the row to open. */
  row: number;
}

/** How much to move at a time when the consumer expresses no preference. */
const CHUNK = 1024 * 16;

/**
 * A SQLite BLOB opened for streamed reads and writes.
 *
 * BLOB columns still come back from a query as a `Uint8Array`; this exists so
 * a large value can be moved without materialising all of it. Open one with
 * {@linkcode Database.openBlob}.
 *
 * @see https://www.sqlite.org/c3ref/blob_open.html
 */
export class SQLBlob {
  #handle: Deno.PointerValue;

  constructor(db: Database, options: BlobOpenOptions) {
    const pHandle = new BigUint64Array(1);
    unwrap(sqlite3_blob_open(
      db.unsafeHandle,
      toCString(options.db ?? "main"),
      toCString(options.table),
      toCString(options.column),
      BigInt(options.row),
      options.readonly === false ? 1 : 0,
      pHandle,
    ));
    this.#handle = Deno.UnsafePointer.create(pHandle[0] ?? 0n);
  }

  /** Size of the BLOB in bytes. */
  get byteLength(): number {
    return sqlite3_blob_bytes(this.#handle);
  }

  /** Reads `p.byteLength` bytes from `offset` into `p`. */
  readSync(offset: number, p: Uint8Array): void {
    unwrap(sqlite3_blob_read(this.#handle, p, p.byteLength, offset));
  }

  /** Writes `p` into the BLOB at `offset`. The BLOB cannot grow. */
  writeSync(offset: number, p: Uint8Array): void {
    unwrap(sqlite3_blob_write(this.#handle, p, p.byteLength, offset));
  }

  /** Closes the BLOB. It **must** be called, or the handle leaks. */
  close(): void {
    unwrap(sqlite3_blob_close(this.#handle));
  }

  /** A byte stream reading the BLOB from the start. */
  get readable(): ReadableStream<Uint8Array> {
    const length = this.byteLength;
    let offset = 0;
    return new ReadableStream({
      type: "bytes",
      pull: (ctx) => {
        try {
          const byob = ctx.byobRequest;
          const view = byob?.view;
          if (byob !== null && byob !== undefined && view != null) {
            const into = new Uint8Array(
              view.buffer,
              view.byteOffset,
              view.byteLength,
            );
            const toRead = Math.min(length - offset, into.byteLength);
            this.readSync(offset, into.subarray(0, toRead));
            offset += toRead;
            byob.respond(toRead);
            return;
          }
          const toRead = Math.min(length - offset, ctx.desiredSize || CHUNK);
          if (toRead === 0) {
            ctx.close();
            return;
          }
          const buffer = new Uint8Array(toRead);
          this.readSync(offset, buffer);
          offset += toRead;
          ctx.enqueue(buffer);
        } catch (e) {
          ctx.error(e);
          ctx.byobRequest?.respond(0);
        }
      },
    });
  }

  /** A byte sink writing into the BLOB from the start. */
  get writable(): WritableStream<Uint8Array> {
    const length = this.byteLength;
    let offset = 0;
    return new WritableStream({
      write: (chunk, ctx) => {
        if (offset + chunk.byteLength > length) {
          ctx.error(new Error("Write exceeds blob length"));
          return;
        }
        this.writeSync(offset, chunk);
        offset += chunk.byteLength;
      },
    });
  }

  *[Symbol.iterator](): IterableIterator<Uint8Array> {
    const length = this.byteLength;
    let offset = 0;
    while (offset < length) {
      const toRead = Math.min(length - offset, CHUNK);
      const buffer = new Uint8Array(toRead);
      this.readSync(offset, buffer);
      offset += toRead;
      yield buffer;
    }
  }

  [Symbol.for("Deno.customInspect")](): string {
    return `SQLite3.Blob(0x${this.byteLength.toString(16)})`;
  }
}
