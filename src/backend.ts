/**
 * The seam between the event layer and whatever actually talks to SQLite.
 *
 * INTERNAL. Not exported from the package and not a supported extension point:
 * it exists so that adding a second implementation later is mechanical, not so
 * that anyone can add one now.
 *
 * Everything above this line — the event types, batching, coverage
 * classification and the veto — is expressed in plain JavaScript values.
 * Everything below it may hold pointers, and nothing pointer-shaped crosses
 * upward: a backend hands over rows that have already been read out of
 * SQLite's memory.
 */
import type { Capabilities, RowValue } from "./hooks.ts";

/** SQLite's own opcodes, as both sides of the seam must agree on them. */
export const SQLITE_DELETE = 9, SQLITE_INSERT = 18, SQLITE_UPDATE = 23;

/** One row from the update hook, already read out of SQLite's memory. */
export type RawChange = {
  opcode: number;
  db: string;
  table: string;
  rowid: bigint;
};

/**
 * One row from the preupdate hook, values already copied. `columnCount` is
 * SQLite's own count, which the caller uses to decide whether its cached
 * column names still line up; the names themselves are not a backend concern.
 */
export type RawPreUpdate = {
  opcode: number;
  db: string;
  table: string;
  oldRowid: bigint;
  newRowid: bigint;
  columnCount: number;
  blobWriteColumn: number | null;
  depth: number;
  oldValues: RowValue[] | null;
  newValues: RowValue[] | null;
};

/**
 * What a backend calls when SQLite fires.
 *
 * GUARANTEE, and it crosses the seam in this direction: NONE of these may
 * throw. They are invoked from inside a SQLite callback, where an exception
 * would unwind through C. The caller enforces it by wrapping every handler;
 * a backend may assume it and must not rely on a try/catch of its own.
 */
export type BackendHandlers = {
  /**
   * `read` performs the C-level reads for this row. It is handed over
   * UNCALLED so the caller's own guards run FIRST — a caller that declines to
   * read has cost SQLite nothing. Call it synchronously and at most once; the
   * values it returns are dead as soon as the callback returns.
   */
  update(read: () => RawChange): void;
  preupdate(read: () => RawPreUpdate): void;
  /** `true` turns the COMMIT into a ROLLBACK. */
  commit(): boolean;
  rollback(): void;
  /**
   * The backend itself failed — reading a row, say — before any handler above
   * could run. The same no-throw rule applies, and it is the only way an error
   * raised BELOW the seam can be reported without unwinding through C.
   */
  fail(error: unknown): void;
};

export type Attachment = {
  /**
   * Release everything, idempotently. `live` is false when the connection has
   * already been closed, in which case the hooks must NOT be unregistered —
   * that would touch a freed handle.
   */
  detach(live: boolean): void;
};

export interface Backend {
  readonly capabilities: Capabilities;
  /** The SQLite version this backend is bound to, for the same-library check. */
  readonly version: string;
  attach(handlers: BackendHandlers): Attachment;
  /** Release the backend without ever having attached. */
  close(): void;
}
